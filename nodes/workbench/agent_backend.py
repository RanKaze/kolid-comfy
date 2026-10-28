# -*- coding: utf-8 -*-
"""Agent dock 窗的后端:LLM 会话编排(OpenAI 兼容 /chat/completions)+ 工具转发。

架构一句话:**LLM 循环住在后端,工具住在浏览器**。前端 POST 一句用户话开一条 run;后端起
守护线程跑 LLM 循环;LLM 每次要动应用,就把 tool_call 挂进事件队列停在那里(wait_tool),
前端长轮询 /api/agent/poll 取到 tool_call → 在页面里执行(时间线/图层/生成全在浏览器侧)
→ POST /api/agent/tool 交回结果 → 后端喂回 LLM 继续下一步。这里不设 websocket,与工作台
同一条"HTTP 轮询"口径(/api/status 也是轮询)。

事件序列号 = events 数组下标;poll 带 cursor 增量取,wait=1 时最多挂 25s 长轮询。

注:内建 Chat 的界面已撤掉(Agent 窗只用 dsh),这段 LLM run 循环与 LLM 设置保留为后端能力,
目前没有前端入口;/api/agent/direct_tool 与工具表仍被两个 MCP 和 tools/wb_agent.py 使用。
工具表的 schema 真源在前端(见下方 load_agent_tools),这里只热读构建产物。
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
    # ---- DeepSeek Harness sidecar(见 agent_dsh.py;Agent 窗的唯一形态)----
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
    "- The Prompt tab has TWO SEPARATE concepts that MUST NOT be confused:\n"
    "  (1) the LIBRARY = stored assets that persist on disk: prompt cards, prefabs, programs, and LoRAs (files). "
    "Editing the library changes what EXISTS, NOT what is currently used.\n"
    "  (2) the SELECTION = the specific items currently chosen for the positive prompt the detailer reads "
    "(custom_prompt text + selected cards/LoRAs/prefabs/programs). Choosing items never saves them to the library.\n"
    "- LIBRARY tools (mutate stored assets, NEVER the selection): prompt_card_add / prompt_card_update / "
    "prompt_card_delete, prefab_add / prefab_update / prefab_delete, program_add / program_update / program_delete, "
    "lora_refresh (rescan disk to pick up new .safetensors), lora_update (edit a lora's model_only slider). "
    "Use these ONLY to create/modify/remove a stored asset.\n"
    "- SELECTION tools (mutate the current composition, NEVER the library): set_prompt (compose the active "
    "selection from EXISTING library items via their ids/guids/file_paths; prompt_mode=replace|add|remove) and "
    "get_prompt_state (read the current selection).\n"
    "- DISCOVERY tools (read-only, change nothing): prompt_library / lora_library / prefab_library / "
    "program_library list the ids/guids/file_paths you reference in set_prompt or in the *_add/*_update tools.\n"
    "- HARD RULE: to make a NEW asset actually USED, first persist it with a library tool (e.g. prefab_add to "
    "create it), THEN select it with set_prompt. Never use set_prompt to create a card/prefab/program, and never "
    "use a *_add/*_update/*_delete tool to make a selection. Discovery tools neither create nor select.\n"
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


# ── 工具表 ─────────────────────────────────────────────────────────────────────────────────────
# schema 的唯一真源在前端 `ui/sampler_node/src/agent/toolSchemas.ts`(与执行体同目录,靠类型咬合);
# 构建时 `tools/gen_agent_tools.cjs` 把它转成同目录的 `agent_tools.json`,这里**热读**。
#
# 为什么不 import 成模块级常量:那样只在 ComfyUI 启动时求值一次,改一句 description 都要重启
# 整个后端(dsh 的 MCP 还要跟着重启才看得见)。按 mtime 读文件之后,改工具 = 重新构建前端。
_TOOLS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'agent_tools.json')
_TOOLS_LOCK = threading.Lock()
_TOOLS_CACHE = {'key': None, 'tools': [], 'names': frozenset(), 'sha': ''}


def load_agent_tools():
    """返回 (OpenAI tools 数组, 工具名集合)。文件没变就吃缓存;读坏了保留上一份。"""
    try:
        st = os.stat(_TOOLS_FILE)
    except OSError:
        return [], frozenset()
    key = (st.st_mtime_ns, st.st_size)
    with _TOOLS_LOCK:
        if _TOOLS_CACHE['key'] == key:
            return _TOOLS_CACHE['tools'], _TOOLS_CACHE['names']
        try:
            with open(_TOOLS_FILE, 'r', encoding='utf-8') as f:
                doc = json.load(f)
            tools = [t for t in (doc.get('tools') or [])
                     if isinstance(t, dict) and (t.get('function') or {}).get('name')]
            _TOOLS_CACHE.update(
                key=key, tools=tools,
                names=frozenset(t['function']['name'] for t in tools),
                sha=str(doc.get('sha') or ''))
        except (OSError, ValueError):
            # 构建用 rename 落盘(原子),所以读坏更可能是有人手改了 JSON:留上一份,
            # 总比让正在跑的 agent 忽然一个工具都没有好。
            pass
        return _TOOLS_CACHE['tools'], _TOOLS_CACHE['names']


def tool_catalog_meta():
    """给 MCP 判断"工具表变没变"的轻量元信息(不含 schema 全文)。"""
    tools, names = load_agent_tools()
    return {'count': len(tools), 'names': sorted(names), 'sha': _TOOLS_CACHE['sha']}

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
                'tools': load_agent_tools()[0],
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

    if h.command == 'GET' and path == '/api/agent/tools':
        # 工具目录给终端侧的编辑 MCP(tools/wb_mcp.py)用:它不 import 这个模块(带 ComfyUI 依赖),
        # 需要时来取,再把调用送回 /api/agent/direct_tool。**每次现取**(按 mtime 缓存),
        # 所以前端重新构建后新工具立刻可见,不用重启后端。
        tools, names = load_agent_tools()
        if not tools:
            h._send_json({'ok': False, 'error': 'agent_tools.json missing or unreadable — '
                                                'run `cd ui && npm run build -w sampler_node`'})
            return
        h._send_json({'ok': True, 'tools': tools, 'sha': _TOOLS_CACHE['sha'],
                      'count': len(tools)})
        return

    if h.command == 'GET' and path == '/api/agent/tools/meta':
        # MCP 用它判断"工具表变没变"(只回指纹,不回 schema 全文),变了就推 tools/list_changed。
        h._send_json({'ok': True, **tool_catalog_meta()})
        return

    if h.command == 'GET' and path == '/api/agent/config':
        s = _load_settings()
        h._send_json({'ok': True, 'config': s, 'tools': sorted(load_agent_tools()[1])})
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
