# -*- coding: utf-8 -*-
"""Agent dock 窗的后端:LLM 会话编排(OpenAI 兼容 /chat/completions)+ 工具转发。

架构一句话:**LLM 循环住在后端,工具住在浏览器**。前端 POST 一句用户话开一条 run;后端起
守护线程跑 LLM 循环;LLM 每次要动应用,就把 tool_call 挂进事件队列停在那里(wait_tool),
前端长轮询 /api/agent/poll 取到 tool_call → 在页面里执行(时间线/图层/生成全在浏览器侧)
→ POST /api/agent/tool 交回结果 → 后端喂回 LLM 继续下一步。这里不设 websocket,与工作台
同一条"HTTP 轮询"口径(/api/status 也是轮询)。

事件序列号 = events 数组下标;poll 带 cursor 增量取,wait=1 时最多挂 25s 长轮询。
"""
import json
import os
import threading
import time
import uuid

import requests

try:
    from ...libs.data_paths import data_dir
except ImportError:  # 直接以脚本方式调试时兜底
    def data_dir(*parts):
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', *parts)

# ── 设置(data/sampler/agent_settings.json)──────────────────────────────────────────────────
SETTINGS_FILE = os.path.join(data_dir('sampler'), 'agent_settings.json')
SETTINGS_LOCK = threading.Lock()

DEFAULT_SETTINGS = {
    # OpenAI 兼容端点(不带 /chat/completions,代码里拼);Z.ai 默认,可换任何兼容服务。
    'base_url': 'https://api.z.ai/api/paas/v4',
    'api_key': '',
    'model': 'glm-4.6',
    'temperature': 0.7,
    # 一次 run 最多 LLM 往返次数(防死循环烧钱)。
    'max_steps': 24,
    # 追加到系统提示尾部的用户自定义段落(工作流习惯、项目背景……)。
    'system_extra': '',
    # ---- DeepSeek Harness sidecar(见 agent_dsh.py;Agent 窗的 DSH 模式)----
    'dsh_port': 3080,
    'dsh_command': 'npx -y @deepseek-ai/dsh web --no-open',
    'dsh_api_key': '',
    'dsh_autostart': False,
}

_SYSTEM_PROMPT = (
    "You are the Agent of Kolid Comfy — an AI operator embedded in a visual AI workbench "
    "(a layer-compositing canvas plus a multi-track video timeline). You operate the app for the "
    "user by calling tools; the app executes them live in front of the user.\n"
    "Rules:\n"
    "- Call get_app_state whenever you need to know what is on screen (tracks, clips, layers, "
    "selection, presets). State changes after every mutation — never act on ids you remember from "
    "an older snapshot if the user edited since.\n"
    "- Timeline times are seconds (floats). Clip/track ids are strings; layer ids are numbers.\n"
    "- In video mode the Layers/Guidances edit target follows the selected Layer segment: use "
    "select_clips with focus=true to switch the layer set you are editing.\n"
    "- run_pipeline starts a generation on the active document; it can take minutes. Do not poll "
    "get_app_state in a tight loop waiting for it — tell the user how to watch progress.\n"
    "- `document` with save-as/load/import pops a native file dialog — the user must be at the "
    "machine. Prefer save (silent when the project already has a file).\n"
    "- Removing clips/layers/tracks or cancelling runs is allowed when the user asks.\n"
    "- Reply concisely in the user's language, and end with a short summary of what you changed."
)


def _load_settings() -> dict:
    s = dict(DEFAULT_SETTINGS)
    try:
        with open(SETTINGS_FILE, 'r', encoding='utf-8') as f:
            stored = json.load(f)
        if isinstance(stored, dict):
            for k in DEFAULT_SETTINGS:
                if k in stored:
                    s[k] = stored[k]
    except (OSError, ValueError):
        pass
    return s


def _save_settings(s: dict) -> None:
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    tmp = SETTINGS_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(s, f, ensure_ascii=False, indent=2)
    os.replace(tmp, SETTINGS_FILE)


# ── 工具表 ── schema 的唯一真源;执行体全在前端(ui/sampler_node/src/agent/tools.ts),这里只转发。
def _fn(name, desc, props=None, req=None):
    return {'type': 'function', 'function': {
        'name': name, 'description': desc,
        'parameters': {'type': 'object', 'properties': props or {}, 'required': req or []},
    }}


AGENT_TOOLS = [
    _fn('get_app_state',
        'Snapshot of everything you can operate: mode (image/video), whether a document is open, '
        'canvas size, fps, transport (playhead seconds, playing), tracks, clips, assets, current '
        'selection, layer/guidance stacks, staging items, pipeline presets, video-generator '
        'interfaces, mask track binding.'),
    _fn('seek', 'Move the timeline playhead to `time` seconds.',
        {'time': {'type': 'number', 'description': 'seconds from 0'}}, ['time']),
    _fn('play', 'Start playback.'), _fn('pause', 'Pause playback.'),
    _fn('select_clips',
        'Set the timeline selection to these clip ids (empty array = clear selection). With a '
        'single Layer-kind clip and focus=true, also makes it the layer editing target '
        '(Layers/Guidances panels switch to its layer set).',
        {'ids': {'type': 'array', 'items': {'type': 'string'}},
         'focus': {'type': 'boolean', 'description': 'switch the layer edit target (default true)'}},
        ['ids']),
    _fn('add_track', 'Add a timeline track: video | audio | layer | process.',
        {'kind': {'type': 'string', 'enum': ['video', 'audio', 'layer', 'process']}}, ['kind']),
    _fn('remove_track', 'Remove a track and everything on it.', {'track_id': {'type': 'string'}}, ['track_id']),
    _fn('rename_track', 'Rename a track.', {'track_id': {'type': 'string'}, 'name': {'type': 'string'}},
        ['track_id', 'name']),
    _fn('place_asset', 'Place an asset from the project asset table onto the timeline.',
        {'asset_id': {'type': 'string'}, 'track_id': {'type': 'string'},
         'time': {'type': 'number', 'description': 'default = current playhead'}},
        ['asset_id']),
    _fn('move_clip', 'Move a clip to a new start time (and optionally another track). Linked '
        'audio/video twins move together unless only_self.',
        {'clip_id': {'type': 'string'}, 'start': {'type': 'number'},
         'track_id': {'type': 'string'}, 'only_self': {'type': 'boolean'}},
        ['clip_id', 'start']),
    _fn('trim_clip', 'Trim a clip edge: edge=in moves the head, edge=out the tail; `time` is the '
        'new edge position on the timeline (seconds).',
        {'clip_id': {'type': 'string'}, 'edge': {'type': 'string', 'enum': ['in', 'out']},
         'time': {'type': 'number'}}, ['clip_id', 'edge', 'time']),
    _fn('split_clip', 'Split a clip at `time` (timeline seconds) into two.',
        {'clip_id': {'type': 'string'}, 'time': {'type': 'number'}}, ['clip_id', 'time']),
    _fn('remove_clips', 'Delete clips from the timeline.', {'ids': {'type': 'array', 'items': {'type': 'string'}}},
        ['ids']),
    _fn('add_layer_clip', 'Create an empty Layer segment (compositing container) on a layer track; '
        'creates the track when missing. Editing its layer set = select_clips focus.',
        {'time': {'type': 'number'}, 'duration': {'type': 'number', 'description': 'default 5s'},
         'track_id': {'type': 'string'}}),
    _fn('select_layer', 'Select a layer row in the workbench (canvas compositing).',
        {'id': {'type': 'number'}}, ['id']),
    _fn('add_layer', 'Add a new layer onto a stack: stack=layers|guidances; kind=default|stash.',
        {'stack': {'type': 'string', 'enum': ['layers', 'guidances']},
         'kind': {'type': 'string', 'enum': ['default', 'stash']}}, ['stack']),
    _fn('remove_layer', 'Remove a layer row.', {'id': {'type': 'number'}, 'stack': {'type': 'string'}}, ['id']),
    _fn('duplicate_layer', 'Duplicate a layer row.', {'id': {'type': 'number'}}, ['id']),
    _fn('rename_layer', 'Rename a layer row.', {'id': {'type': 'number'}, 'name': {'type': 'string'}},
        ['id', 'name']),
    _fn('set_layer_opacity', 'Set a layer overall opacity 0..1.', {'id': {'type': 'number'},
        'opacity': {'type': 'number'}}, ['id', 'opacity']),
    _fn('toggle_layer_visibility', 'Toggle a layer eye.', {'id': {'type': 'number'}}, ['id']),
    _fn('layer_generate', 'Run the layer Generate (image generation) on a layer row.',
        {'id': {'type': 'number'}}, ['id']),
    _fn('layer_from_asset', 'Insert a repo asset (content hash) as a new layer image.',
        {'hash': {'type': 'string'}, 'name': {'type': 'string'},
         'stack': {'type': 'string', 'enum': ['layers', 'guidances']}}, ['hash']),
    _fn('set_extra_prompt', 'Set the Extra Prompt text used by Blend / Tag runs.',
        {'text': {'type': 'string'}}, ['text']),
    _fn('run_blend', 'Start a Blend run (canvas -> processed result into staging).'),
    _fn('run_tag', 'Start a Tag run (annotate the canvas).'),
    _fn('run_pipeline', 'Run a pipeline preset on the active document (the workbench main run). '
        'Omit preset_id to use the active preset.',
        {'preset_id': {'type': 'string'}}),
    _fn('cancel_run', 'Cancel the currently running generation.'),
    _fn('set_canvas_size', 'Resize the canvas (pixels).', {'w': {'type': 'number'}, 'h': {'type': 'number'}},
        ['w', 'h']),
    _fn('undo', 'Undo the last edit (works in both image and video mode).'),
    _fn('redo', 'Redo an undone edit.'),
    _fn('view_fit', 'Fit the canvas view (zoom to content).'),
    _fn('set_fps', 'Set the video project output frame rate.', {'fps': {'type': 'number'}}, ['fps']),
    _fn('set_paint_color', 'Set the painting foreground color (#rrggbb).', {'fg': {'type': 'string'}}, ['fg']),
    _fn('set_brush', 'Configure the brush.', {'size': {'type': 'number'}, 'strength': {'type': 'number'}}),
    _fn('add_vgen_segment', 'Add a Video Generator segment for interface #interface_index onto the '
        'process track (opens its prompt card for the user to fill).',
        {'interface_index': {'type': 'number'}}, ['interface_index']),
    _fn('add_continue_segment', 'Like add_vgen_segment but seeds the new segment with the last '
        'frame of the currently selected video segment (continuation).',
        {'interface_index': {'type': 'number'}}, ['interface_index']),
    _fn('document', 'Document actions: new (blank document), save (silent when the file path is '
        'known, otherwise a native Save dialog pops).',
        {'action': {'type': 'string', 'enum': ['new', 'save']}}, ['action']),
]
TOOL_NAMES = {t['function']['name'] for t in AGENT_TOOLS}

# ── Run 状态 ────────────────────────────────────────────────────────────────────────────────
_RUNS: dict = {}
_RUNS_LOCK = threading.Lock()
_RUN_TTL = 3600.0   # 结束后的 run 留 1 小时供迟到的 poll;新建 run 时顺手清老账


class AgentRun:
    def __init__(self, run_id: str, user_text: str, history: list):
        self.id = run_id
        self.user_text = user_text
        self.history = history
        self.cv = threading.Condition()
        self.status = 'running'          # running | wait_tool | done | error | cancelled
        self.events: list = []           # {type, ...} — 下标即 seq
        self.error = ''
        self.cancelled = False
        self.results: dict = {}          # call_id -> tool 文本结果
        self.thread = threading.Thread(target=self._loop, daemon=True)

    # -- 事件 --
    def push(self, ev: dict) -> None:
        with self.cv:
            self.events.append(ev)
            self.cv.notify_all()

    def wait_events(self, cursor: int, timeout: float) -> None:
        with self.cv:
            if len(self.events) > cursor or self.status in ('done', 'error', 'cancelled'):
                return
            self.cv.wait(timeout=min(max(timeout, 0.5), 25.0))

    def cancel(self) -> None:
        with self.cv:
            self.cancelled = True
            self.cv.notify_all()

    def deliver(self, results: dict) -> None:
        with self.cv:
            self.results.update(results)
            self.cv.notify_all()

    # -- LLM 循环 --
    def _fail(self, msg: str) -> None:
        self.push({'type': 'error', 'message': msg})
        with self.cv:
            self.status = 'error'
            self.error = msg
            self.cv.notify_all()

    def _finish(self) -> None:
        with self.cv:
            if self.status not in ('error',):
                self.status = 'done'
            self.cv.notify_all()

    def _loop(self) -> None:
        s = _load_settings()
        msgs = [{'role': 'system', 'content': _SYSTEM_PROMPT + ('\n\n' + s['system_extra'] if s.get('system_extra') else '')}]
        for m in self.history[-40:]:
            msgs.append({'role': m.get('role'), 'content': str(m.get('content', ''))[:6000]})
        msgs.append({'role': 'user', 'content': self.user_text})
        steps = int(s.get('max_steps') or 24)
        for _ in range(max(1, steps)):
            if self.cancelled:
                return self._finish()
            payload = {
                'model': s['model'],
                'messages': msgs,
                'tools': AGENT_TOOLS,
                'tool_choice': 'auto',
                'temperature': float(s.get('temperature', 0.7)),
            }
            try:
                resp = _chat_completion(s, payload)
            except requests.HTTPError as e:
                body = ''
                try:
                    body = str(e.response.text)[:600]
                except Exception:
                    pass
                return self._fail('LLM API error: %s %s' % (e, body))
            except Exception as e:
                return self._fail('LLM API error: %s' % e)
            choices = resp.get('choices') or []
            if not choices:
                return self._fail('LLM returned no choices')
            msg = choices[0].get('message') or {}
            text = _msg_text(msg)
            tool_calls = msg.get('tool_calls') or []
            # 回填 assistant 消息:content 原样、tool_calls 规整成 API 认的形状。
            back = {'role': 'assistant', 'content': msg.get('content')}
            if tool_calls:
                back['tool_calls'] = [{
                    'id': tc.get('id') or ('call_%d' % i),
                    'type': 'function',
                    'function': {'name': (tc.get('function') or {}).get('name', ''),
                                 'arguments': (tc.get('function') or {}).get('arguments') or '{}'},
                } for i, tc in enumerate(tool_calls)]
            msgs.append(back)
            if text:
                self.push({'type': 'text', 'text': text})
            if not tool_calls:
                return self._finish()
            calls = back['tool_calls']
            for tc in calls:
                args_raw = tc['function'].get('arguments') or '{}'
                try:
                    args = json.loads(args_raw) if isinstance(args_raw, str) else dict(args_raw)
                except ValueError:
                    args = None
                self.push({'type': 'tool_call', 'call_id': tc['id'],
                           'name': tc['function'].get('name', ''), 'args': args if args is not None else args_raw})
            # 停下等前端执行并交回结果。
            with self.cv:
                self.status = 'wait_tool'
                self.cv.notify_all()
            deadline = time.time() + 600.0
            with self.cv:
                while not all(tc['id'] in self.results for tc in calls):
                    if self.cancelled:
                        return self._finish()
                    left = deadline - time.time()
                    if left <= 0:
                        break
                    self.cv.wait(timeout=min(left, 5.0))
            if self.cancelled:
                return self._finish()
            for tc in calls:
                content = self.results.get(tc['id'], '(no result returned — the tool may not have run)')
                if not isinstance(content, str):
                    content = json.dumps(content, ensure_ascii=False)
                msgs.append({'role': 'tool', 'tool_call_id': tc['id'], 'content': content[:8000]})
            with self.cv:
                self.status = 'running'
                self.cv.notify_all()
        self.push({'type': 'text', 'text': '(stopped: reached the max-steps limit — ask me to continue)'})
        self._finish()


def _msg_text(msg: dict) -> str:
    c = msg.get('content')
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return ''.join(p.get('text', '') for p in c if isinstance(p, dict) and p.get('type') == 'text')
    return ''


def _chat_completion(s: dict, payload: dict) -> dict:
    url = s['base_url'].rstrip('/')
    if not url.endswith('/chat/completions'):
        url += '/chat/completions'
    headers = {'Content-Type': 'application/json'}
    if s.get('api_key'):
        headers['Authorization'] = 'Bearer ' + str(s['api_key'])
    r = requests.post(url, headers=headers, data=json.dumps(payload), timeout=240)
    r.raise_for_status()
    return r.json()


def _prune_runs() -> None:
    now = time.time()
    with _RUNS_LOCK:
        for rid in [k for k, v in _RUNS.items()
                    if v.status in ('done', 'error', 'cancelled') and now - v.id_ts > _RUN_TTL]:
            _RUNS.pop(rid, None)


# ── HTTP 接口(MainHandler 的 /api/agent* 都交给这里;handler 是 http.server 请求实例)──────────
def handle(h) -> None:
    path = h.path.split('?', 1)[0]

    # /api/agent_dsh/*(DeepSeek Harness sidecar)同住一个前缀;懒加载避免循环导入
    # (agent_dsh 要读这里的设置)。dsh 模块自身出错时回 JSON 人话,不许把请求摔成连接重置 ——
    # 否则前端只能报"unreachable",分不清是失联还是 dsh 坏了。
    if path.startswith('/api/agent_dsh'):
        try:
            from . import agent_dsh
            agent_dsh.handle(h)
        except Exception as e:  # noqa: BLE001 — 边界上把一切翻成 JSON
            h._send_json({'ok': False, 'error': 'agent_dsh failed: %r' % e}, 500)
        return

    def body() -> dict:
        n = int(h.headers.get('Content-Length', 0) or 0)
        try:
            return json.loads(h.rfile.read(n)) if n else {}
        except ValueError:
            return {}

    if h.command == 'GET' and path == '/api/agent/config':
        s = _load_settings()
        h._send_json({'ok': True, 'config': s, 'tools': [t['function']['name'] for t in AGENT_TOOLS]})
        return

    if h.command == 'POST' and path == '/api/agent/config':
        data = body()
        with SETTINGS_LOCK:
            s = _load_settings()
            for k in DEFAULT_SETTINGS:
                if k in data:
                    s[k] = data[k]
            s['max_steps'] = max(1, min(64, int(s.get('max_steps') or 24)))
            try:
                s['temperature'] = float(s.get('temperature') or 0.7)
            except (TypeError, ValueError):
                s['temperature'] = 0.7
            _save_settings(s)
        h._send_json({'ok': True, 'config': s})
        return

    if h.command == 'POST' and path == '/api/agent/send':
        data = body()
        text = str(data.get('text') or '').strip()
        if not text:
            h._send_json({'ok': False, 'error': 'empty message'}, 400)
            return
        s = _load_settings()
        if not s.get('api_key'):
            h._send_json({'ok': False, 'error': 'No API key configured — click the gear in the Agent '
                                                'panel and fill Base URL / API key / Model.'})
            return
        history = [m for m in (data.get('history') or []) if isinstance(m, dict)
                   and m.get('role') in ('user', 'assistant') and isinstance(m.get('content'), str)]
        _prune_runs()
        rid = uuid.uuid4().hex[:12]
        run = AgentRun(rid, text[:8000], history)
        run.id_ts = time.time()
        with _RUNS_LOCK:
            _RUNS[rid] = run
        run.thread.start()
        h._send_json({'ok': True, 'run_id': rid})
        return

    if h.command == 'GET' and path == '/api/agent/poll':
        from urllib.parse import parse_qs
        qs = parse_qs(h.path.split('?', 1)[1] if '?' in h.path else '')
        run = _RUNS.get(str((qs.get('run_id') or [''])[0]))
        if not run:
            h._send_json({'ok': False, 'error': 'unknown run'}, 404)
            return
        try:
            cursor = max(0, int((qs.get('cursor') or ['0'])[0]))
        except ValueError:
            cursor = 0
        if cursor <= len(run.events):
            run.wait_events(cursor, 25.0)
        evs = run.events[cursor:]
        h._send_json({'ok': True, 'status': run.status, 'events': evs,
                      'cursor': min(cursor + len(evs), len(run.events)), 'error': run.error})
        return

    if h.command == 'POST' and path == '/api/agent/tool':
        data = body()
        run = _RUNS.get(str(data.get('run_id') or ''))
        if not run:
            h._send_json({'ok': False, 'error': 'unknown run'}, 404)
            return
        results = data.get('results') or []
        delivered = {}
        for r in results:
            cid = str(r.get('call_id') or '')
            if not cid:
                continue
            content = r.get('content')
            delivered[cid] = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
            run.push({'type': 'tool_result', 'call_id': cid, 'name': str(r.get('name') or ''),
                      'ok': bool(r.get('ok', True)), 'content': delivered[cid][:2000]})
        run.deliver(delivered)
        h._send_json({'ok': True})
        return

    if h.command == 'POST' and path == '/api/agent/cancel':
        data = body()
        run = _RUNS.get(str(data.get('run_id') or ''))
        if run:
            run.cancel()
        h._send_json({'ok': True})
        return

    # ── 工具桥(给 DeepSeek Harness / 任何终端侧 agent 用)─────────────────────────────────────
    # 终端 agent(dsh)在 sidecar 里跑,够不到浏览器的工具执行体。这条把一次工具调用经
    # /api/ui_probe/eval 的既有回路送进页面:页面上的 window.__wbAgentTool(AgentPanel 挂的)
    # 真正执行并回 JSON。eval 通道是 async IIFE(live.ts runExpr),Promise 会等到值。
    if h.command == 'POST' and path == '/api/agent/direct_tool':
        data = body()
        name = str(data.get('name') or '')
        args = data.get('args') if isinstance(data.get('args'), dict) else {}
        if not name:
            h._send_json({'ok': False, 'error': 'missing tool name'}, 400)
            return
        # 三元是 JS 侧的(eval 表达式跑在浏览器里);页面没挂桥就抛一句人话。
        expr = ('window.__wbAgentTool ? await window.__wbAgentTool(%s, %s)'
                % (json.dumps(name), json.dumps(args))
                + ' : (() => { throw new Error("workbench page not loaded - open the workbench UI once"); })()')
        port = h.server.server_address[1]
        try:
            r = requests.post('http://127.0.0.1:%d/api/ui_probe/eval' % port,
                              json={'expr': expr, 'timeout': 55}, timeout=65)
            d = r.json()
        except Exception as e:
            h._send_json({'ok': False, 'error': 'probe eval self-call failed: %s' % e})
            return
        if d.get('error') or d.get('ok') is not True:
            h._send_json({'ok': False, 'error': d.get('error') or 'eval failed'})
            return
        h._send_json({'ok': True, 'value': d.get('value')})
        return

    h._send_json({'ok': False, 'error': 'unknown agent route: %s %s' % (h.command, path)}, 404)
