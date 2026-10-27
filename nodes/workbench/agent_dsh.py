# -*- coding: utf-8 -*-
"""DeepSeek Harness(dsh)sidecar:把官方开源的 coding agent 当独立进程拉起来,Agent 窗 iframe 它的 Web UI。

分工:**dsh 管 agent loop、终端、文件编辑与它自己的 UI;工作台只做三件事** ——
  1. 拉起/停掉 `dsh web`(Node 子进程,workspace 指到 data/sampler/dsh_workspace);
  2. 每次启动刷新 workspace 的 AGENTS.md(告诉 dsh 这是什么应用、怎么用 tools/wb_agent.py 桥
     操作工作台 —— 工具真身住在浏览器,经 /api/agent/direct_tool 送进去执行);
  3. 汇报状态给 Agent 窗(跑没跑、端口多少、要不要去 Settings 改命令)。

dsh 是 developer preview(MIT,npm @deepseek-ai/dsh),破坏性变更会来 —— 所以命令/端口全部可配
(Settings ▸ Agent),这里不硬编码任何超过 README 承诺的东西。
"""
import http.client
import json
import os
import re
import subprocess
import threading
import time

try:
    from ...libs.data_paths import data_dir
except ImportError:
    def data_dir(*parts):
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', *parts)

CREATE_NEW_PROCESS_GROUP = 0x00000200  # win32-only;别处给 0

# ── 进程状态(模块级;同进程内只有一份 sampler 服务)─────────────────────────────────────────
_LOCK = threading.Lock()
_PROC: subprocess.Popen = None
_INFO = {'pid': 0, 'port': 0, 'started_at': 0.0, 'mode': 'stopped', 'error': '', 'url': '', 'log': []}
# mode: stopped | starting | running | stopped_external(端口被占但不是我们拉的那份)
# url: dsh 启动时打印的带 token 完整地址(iframe 直接用;无 token 是 401)。

_AGENTS_MD = """# AGENTS.md — Kolid Comfy Workbench

You are operating **inside** a visual AI workbench (Kolid Comfy): a layer-compositing canvas plus a
multi-track video timeline, running in the user's browser. You can drive it with the `wb` bridge CLI
(uses only the Python interpreter + stdlib).

## The workbench

- The UI lives on localhost — the workbench server listens on **8700..8799** (one port per run);
  the `wb` CLI auto-discovers it. `wb ping` reports what is running.
- Its state (timeline, clips, layers, selection, playhead) lives **in the browser**, not in files.
- The user may not have the page open. If a `wb` call fails with "workbench page not loaded",
  ask the user to open the workbench once, then retry.

## Bridge CLI (all output is JSON)

```bash
"{python}" "{cli}" ping                      # reachability + who is running
"{python}" "{cli}" state                     # full app snapshot (tracks/clips/layers/selection/...)
"{python}" "{cli}" call <tool> [json_args]   # run one workbench tool, e.g.:
"{python}" "{cli}" call seek '{{"time": 4.0}}'
"{python}" "{cli}" call move_clip '{{"clip_id": "<id>", "start": 6.5}}'
"{python}" "{cli}" call select_clips '{{"ids": ["<clip id>"], "focus": true}}'
```

Workflow that works well: `state` first, act on the ids you see, `state` again to verify.
Tool names follow the workbench's agent toolset (seek, play, pause, select_clips, add_track,
place_asset, move_clip, trim_clip, split_clip, remove_clips, add_layer_clip, select_layer,
add_layer, set_layer_opacity, layer_generate, run_pipeline, run_blend, set_canvas_size, set_fps,
undo, redo, ...). Times are seconds; clip/track ids are strings; layer ids are numbers.

## Ground rules

- This workspace is for your notes/scratch files. Do not edit the Kolid Comfy source tree
  (`{repo}`) unless the user explicitly asks for code changes.
- Mutations you make through `wb` are real edits in the user's project (undoable in-app).
- Report what you changed, briefly, in the user's language.
"""


_SETTINGS_LOADER = None  # 测试注入口;None = 默认读 agent_backend 的 agent_settings.json


def _settings() -> dict:
    if _SETTINGS_LOADER is not None:
        return _SETTINGS_LOADER()
    from . import agent_backend
    return agent_backend._load_settings()


def _workspace() -> str:
    return os.path.join(data_dir('sampler'), 'dsh_workspace')


def _repo_root(*parts) -> str:
    # 本文件在 <repo>/nodes/workbench/ 下;向上两级就是仓库根。不用 data_dir():那里给的是
    # data/<kind> 且有 legacy 合并副作用,这里要的是 repo 根本身。
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(os.path.dirname(here))
    return os.path.join(root, *parts) if parts else root


def _cli_path() -> str:
    return _repo_root('tools', 'wb_agent.py')


def _port_alive(port: int, timeout: float = 2.0) -> bool:
    try:
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
        conn.request('GET', '/')
        conn.getresponse().read()
        return True
    except OSError:
        return False


_BRIDGE_MARK = 'kolid-workbench'
_BRIDGE_BEGIN = '<!-- %s:begin -->' % _BRIDGE_MARK
_BRIDGE_END = '<!-- %s:end -->' % _BRIDGE_MARK

# dsh 的指令链是"用户全局($DSH_HOME/AGENTS.md)→ 工作区从根到当前目录"。用户在自己的工作区里
# 跑会话时,只写 dsh_workspace/AGENTS.md 等于没写 —— 那段桥接说明必须落在全局那份里,才跟着
# 每一个会话走。用成对注释包住,每次启动原地替换,不碰用户自己写的段落。
_BRIDGE_BLOCK = """{begin}
## Kolid Comfy workbench (the app the user is working in)

The user is working in a visual AI workbench (Kolid Comfy: a layer-compositing canvas plus a
multi-track video timeline) served from this machine at `http://127.0.0.1:8700..8799`. You can
operate the live app with the `wb` bridge — a stdlib-only CLI that round-trips through the open page:

```bash
"{python}" "{cli}" ping                      # is the workbench reachable
"{python}" "{cli}" state                     # full snapshot: tracks, clips, layers, selection
"{python}" "{cli}" call <tool> '<json>'      # one tool, e.g. call seek '{{"time": 4.0}}'
```

Run `state` first, act on the ids it shows, run `state` again to verify. Tools: transport
(seek/play/pause) · timeline (select_clips/add_track/remove_track/rename_track/place_asset/
move_clip/trim_clip/split_clip/remove_clips/add_layer_clip) · layers (select_layer/add_layer/
remove_layer/duplicate_layer/rename_layer/set_layer_opacity/toggle_layer_visibility/layer_generate/
layer_from_asset) · generation (run_pipeline/run_blend/run_tag/cancel_run/set_extra_prompt) · canvas
(set_canvas_size/view_fit/set_paint_color/set_brush/undo/redo) · video project
(set_fps/add_vgen_segment/add_continue_segment/document). Mutations are real, undoable edits in the
user's project. If a call reports the workbench page is not loaded, ask the user to open it, then
retry. Do not edit the Kolid Comfy source tree ({repo}) unless the user explicitly asks for code changes.
{end}"""


def _dsh_home() -> str:
    return os.environ.get('DSH_HOME') or os.path.join(os.path.expanduser('~'), '.dsh')


def _write_global_bridge() -> None:
    home = _dsh_home()
    try:
        os.makedirs(home, exist_ok=True)
        path = os.path.join(home, 'AGENTS.md')
        try:
            with open(path, 'r', encoding='utf-8') as f:
                old = f.read()
        except OSError:
            old = ''
        block = _BRIDGE_BLOCK.format(begin=_BRIDGE_BEGIN, end=_BRIDGE_END,
                                     python=sys_executable(), cli=_cli_path(), repo=_repo_root())
        if _BRIDGE_BEGIN in old:
            new = re.sub(re.escape(_BRIDGE_BEGIN) + r'.*?' + re.escape(_BRIDGE_END), block, old, flags=re.S)
        else:
            new = (old.rstrip() + '\n\n' if old.strip() else '') + block + '\n'
        with open(path, 'w', encoding='utf-8') as f:
            f.write(new)
    except OSError:
        pass  # 写不进全局指令不该拖死 sidecar:工作区里那份 AGENTS.md 还在


def _ensure_workspace() -> str:
    ws = _workspace()
    os.makedirs(ws, exist_ok=True)
    md = _AGENTS_MD.format(python=sys_executable(), cli=_cli_path(), repo=_repo_root())
    with open(os.path.join(ws, 'AGENTS.md'), 'w', encoding='utf-8') as f:
        f.write(md)
    _write_global_bridge()
    return ws


def sys_executable() -> str:
    import sys
    return sys.executable or 'python'


def _snapshot(mode: str = None, error: str = None) -> dict:
    with _LOCK:
        if mode:
            _INFO['mode'] = mode
        if error is not None:
            _INFO['error'] = error
        info = dict(_INFO)
    return info


# dsh web 就绪时往 stdout 打一行 `dsh web: http://127.0.0.1:3080/?token=<T>` —— token 换 cookie
# 的门票,iframe 的 src 必须带上它(不带 = 401)。注意 cookie 是 SameSite=Strict 且 JWT 里绑死
# `authority=127.0.0.1:<port>`:工作台页面必须也是 127.0.0.1(见 browser_url 处的注释),换成
# localhost 或改写 Host 都只会拿回 401。读取线程同时留几行尾巴做诊断。
_TOKEN_RE = re.compile(r'token=(\S+)')


def _pump(proc: subprocess.Popen) -> None:
    try:
        for raw in proc.stdout or []:
            line = (raw if isinstance(raw, str) else raw.decode('utf-8', 'replace')).rstrip()
            if not line:
                continue
            with _LOCK:
                _INFO['log'] = (_INFO['log'] + [line])[-6:]
                m = _TOKEN_RE.search(line)
                if m:
                    # URL 自己拼:--public-url 会把打印出来的前缀改成代理地址,而 iframe 直连的
                    # 永远是裸端口 —— 只认 token,不认那行里印的 host。
                    _INFO['url'] = 'http://127.0.0.1:%d/?token=%s' % (_INFO['port'], m.group(1))
    except (OSError, ValueError):
        pass


def status() -> dict:
    s = _settings()
    port = int(s.get('dsh_port') or 3080)
    with _LOCK:
        proc = _PROC
        alive = proc is not None and proc.poll() is None
        url = _INFO['url']
        log = list(_INFO['log'])
    if alive:
        if _port_alive(port) and url:
            return {**_snapshot('running'), 'log': log}
        return {**_snapshot('starting'), 'log': log}  # 进程在,但还没监听/还没打出带 token 的地址
    if _port_alive(port):
        # 不是我们拉的那份(可能是用户自己开的 dsh)—— 照样能用,但拿不到 token,iframe 会 401。
        return {**_snapshot('stopped_external'), 'port': port, 'log': log}
    # 进程已经退出了:npx 下载失败、端口被占、dsh 崩了都会走到这里。把输出尾巴交给面板,
    # 否则用户只能看到一个无声的 stopped。
    if log and not _INFO['error']:
        return {**_snapshot('stopped', error=log[-1]), 'log': log}
    return {**_snapshot('stopped'), 'log': log}


def start() -> dict:
    global _PROC
    with _LOCK:
        proc = _PROC
        if proc is not None and proc.poll() is None:
            return status()
        _PROC = None
    st = status()
    if st['mode'] == 'stopped_external':
        return st  # 已经有一份在跑,别再拉
    s = _settings()
    port = int(s.get('dsh_port') or 3080)
    cmd = str(s.get('dsh_command') or 'npx -y @deepseek-ai/dsh web --no-open')
    # 端口必须显式钉住:状态机(_port_alive + cookie 的 authority)全都按 dsh_port 走,而 dsh 自己的
    # 默认端口是它配置里的值。命令里用户已经写了 --port 就尊重他,不重复追加。
    if '--port' not in cmd.split():
        cmd += ' --port %d' % port
    ws = _ensure_workspace()
    env = os.environ.copy()
    if s.get('dsh_api_key'):
        env['DEEPSEEK_API_KEY'] = str(s['dsh_api_key'])
    try:
        proc = subprocess.Popen(cmd, shell=True, cwd=ws, env=env,
                                creationflags=CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding='utf-8', errors='replace')
    except OSError as e:
        return _snapshot('stopped', error='spawn failed: %s' % e)
    with _LOCK:
        _PROC = proc
        _INFO.update(pid=proc.pid, port=port, started_at=time.time(), mode='starting', error='', url='', log=[])
    threading.Thread(target=_pump, args=(proc,), daemon=True).start()
    return status()


def stop() -> dict:
    global _PROC
    with _LOCK:
        proc, _PROC = _PROC, None
    if proc is not None and proc.poll() is None:
        try:
            if os.name == 'nt':
                # shell=True 拉的是 cmd.exe,直接 terminate 杀不掉孙辈的 node —— 按树连根拔。
                subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                               capture_output=True, timeout=10)
            else:
                proc.terminate()
                try:
                    proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    proc.kill()
        except OSError:
            pass
    # 用户主动停的不算故障:清掉 url 与日志尾巴,否则 status() 会把上一轮的最后一行日志当成
    # 失败原因显示成红字(那条"进程自己死了"的诊断只对没被叫停的进程成立)。
    with _LOCK:
        _INFO.update(url='', log=[], error='')
    return _snapshot('stopped')


# ── HTTP 接口(agent_backend.handle 把 /api/agent_dsh/* 委派到这里)───────────────────────────
def handle(h) -> None:
    path = h.path.split('?', 1)[0]

    def body() -> dict:
        n = int(h.headers.get('Content-Length', 0) or 0)
        try:
            return json.loads(h.rfile.read(n)) if n else {}
        except ValueError:
            return {}

    if h.command == 'GET' and path == '/api/agent_dsh/status':
        h._send_json({'ok': True, **status()})
        return

    if h.command == 'POST' and path == '/api/agent_dsh/start':
        h._send_json({'ok': True, **start()})
        return

    if h.command == 'POST' and path == '/api/agent_dsh/stop':
        h._send_json({'ok': True, **stop()})
        return

    h._send_json({'ok': False, 'error': 'unknown agent_dsh route: %s %s' % (h.command, path)}, 404)
