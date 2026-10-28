# -*- coding: utf-8 -*-
"""DeepSeek Harness(dsh)sidecar:把官方开源的 coding agent 当独立进程拉起来,Agent 窗 iframe 它的 Web UI。

分工:**dsh 管 agent loop、终端、文件编辑与它自己的 UI;工作台只做四件事** ——
  1. 拉起/停掉 `dsh web`(Node 子进程,cwd 指到**绑定目录**);
  2. 维护绑定目录:当前 cud 的所在目录,没有 cud 就是仓库根;写进 dsh 的全局 AGENTS.md(告诉它
     这是什么应用、怎么用 tools/wb_agent.py 桥操作工作台 —— 工具真身住在浏览器,经
     /api/agent/direct_tool 送进去执行);
  3. 把 dsh_plugin/(kolid-dsh-bind)与工作台编辑 MCP(kolid-workbench,tools/wb_mcp.py)装进 web
     profile —— dsh 的工作区只能由它自己的页面选,跨域 iframe 摸不到 DOM,能说话的只有
     postMessage(插件举手,Agent 窗把当前目录发过去);MCP 让 agent 直接改工程(get_app_state /
     timeline / layers / generation / canvas / video project)。读现场的探针 MCP(kolid-ui-probe)
     不再接入 dsh。
  4. 汇报状态给 Agent 窗(跑没跑、端口多少)。

dsh 是 developer preview(MIT,npm @deepseek-ai/dsh),破坏性变更会来 —— 所以命令/端口住在
data/sampler/agent_settings.json(Agent 窗直读),这里不硬编码任何超过 README 承诺的东西。
"""
import http.client
import json
import os
import re
import shutil
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
_INFO = {'pid': 0, 'port': 0, 'started_at': 0.0, 'mode': 'stopped', 'error': '', 'url': '', 'bind': '',
         'log': []}
# mode: stopped | starting | running | stopped_external(端口被占但不是我们拉的那份)
# url: dsh 启动时打印的带 token 完整地址(iframe 直接用;无 token 是 401)。
# bind: 这一份 dsh 的工作区(子进程 cwd + iframe 地址里的 kolid_ws)。

_SETTINGS_LOADER = None  # 测试注入口;None = 默认读 agent_backend 的 agent_settings.json


def _settings() -> dict:
    if _SETTINGS_LOADER is not None:
        return _SETTINGS_LOADER()
    from . import agent_backend
    return agent_backend._load_settings()


def _repo_root(*parts) -> str:
    # 本文件在 <repo>/nodes/workbench/ 下;向上两级就是仓库根。不用 data_dir():那里给的是
    # data/<kind> 且有 legacy 合并副作用,这里要的是 repo 根本身。
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(os.path.dirname(here))
    return os.path.join(root, *parts) if parts else root


def _cli_path() -> str:
    return _repo_root('tools', 'wb_agent.py')


# ── 绑定目录 ──────────────────────────────────────────────────────────────────────────────────
# dsh 的"工作区"就是它跑 agent 时的那一个目录:相对路径、读写文件、会话分组(sessions/<escaped
# cwd>/)全按它说话。工作台这边的口径只有一个 —— **当前 cud 的所在目录**;一份 cud 都没开就退到
# 仓库根(那种时候用户通常就是在让 agent 改工作台自己)。
#
# 这个选择只记在盘上(bind.json),不跟着页面走:页面刷新、ComfyUI 重启之后,agent 仍落在同一个
# 目录里,而不是悄悄换回某个默认值。
def _bind_file() -> str:
    return os.path.join(data_dir('sampler'), 'dsh_bind.json')


def bound_dir() -> str:
    """绑定目录(绝对路径)。记着的那份不在了(盘符拔走、目录被删)就退回仓库根。"""
    try:
        with open(_bind_file(), 'r', encoding='utf-8') as f:
            path = json.load(f).get('path')
    except (OSError, ValueError, AttributeError):
        path = ''
    if isinstance(path, str) and path and os.path.isdir(path):
        return os.path.normpath(path)
    return _repo_root()


def bind(path) -> dict:
    """把工作区钉到 `path`;传空 = 没有 cud,钉到仓库根。

    调用方(页面)给的是 cud 文件的所在目录,这里只做归一和存在性检查 —— 一个不存在的目录会让
    dsh 那边 create 失败,不如在这里就说清楚。运行中的那份 dsh 不吃新的 cwd(进程已经起来了),
    它由 kolid-dsh-bind 插件在页面里换工作区;这里改的是**下一次**启动落哪儿。
    """
    raw = (path or '').strip() if isinstance(path, str) else ''
    if raw:
        target = os.path.normpath(os.path.expanduser(raw))
        if not os.path.isdir(target):
            return {'ok': False, 'error': 'not a directory: %s' % target, 'path': bound_dir()}
    else:
        target = _repo_root()
    try:
        os.makedirs(os.path.dirname(_bind_file()), exist_ok=True)
        with open(_bind_file(), 'w', encoding='utf-8') as f:
            json.dump({'path': target}, f, ensure_ascii=False)
    except OSError as e:
        return {'ok': False, 'error': 'cannot record binding: %s' % e, 'path': bound_dir()}
    with _LOCK:
        _INFO['bind'] = target
    return {'ok': True, 'path': target}


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
layer_from_asset/create_comic_layout) · generation (run_pipeline/run_blend/run_tag/cancel_run/
set_extra_prompt) · canvas (set_canvas_size/view_fit/set_paint_color/set_brush/undo/redo) · video
project (set_fps/add_vgen_segment/add_continue_segment/document). `create_comic_layout` lays out a
whole comic page (paper + one empty panel layer per cell + frame lines, one undo step) — use it
instead of stacking primitives when the user asks for 漫画格 / 分镜 / panel layout. Mutations are
real, undoable edits in the user's project. If a call reports the workbench page is not loaded, ask
the user to open it, then retry. Do not edit the Kolid Comfy source tree ({repo}) unless the user
explicitly asks for code changes.

The same catalog is also exposed over MCP as `mcp__kolid-workbench__<tool>` (server
`kolid-workbench`) — prefer those calls when your client lists them; the CLI above is the same
endpoint for shells.
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
            # 替换串里全是 Windows 反斜杠(仓库/解释器路径),交给 lambda 才不被当成转义。
            new = re.sub(re.escape(_BRIDGE_BEGIN) + r'.*?' + re.escape(_BRIDGE_END), lambda _m: block,
                         old, flags=re.S)
        else:
            new = (old.rstrip() + '\n\n' if old.strip() else '') + block + '\n'
        with open(path, 'w', encoding='utf-8') as f:
            f.write(new)
    except OSError:
        pass  # 写不进全局指令不该拖死 sidecar:agent 顶多是不知道自己还能操作工作台


# ── profile 插件(kolid-dsh-bind)──────────────────────────────────────────────────────────────
# 工作区只能由 dsh 自己的页面去选:跨域 iframe 摸不到它的 DOM,能说话的只有地址栏参数和
# postMessage。所以"钉住工作区 + 藏掉添加/切换入口"这件事做成一个 dsh client 插件,装进 web
# profile 的 patch 层 —— 它跑在 dsh 进程里、同一个页面,只隔一道 iframe 边界。
#
# 同一个 patch 层里只挂工作台的**编辑** MCP(tools/wb_mcp.py):agent 借此直接改工程(图层 / 时间线 /
# 生成 / 画布 / 视频工程)。读现场的探针 MCP(kolid-ui-probe)不再接入 dsh —— 它只服务于工作台自己的
# 长轮询通道,dsh 这边没有对应需求,留着只会多占一条没人用的 stdio 进程。
_PLUGIN_NAME = 'kolid-dsh-bind'
_EDIT_ID = 'mcp-kolid-workbench'
_EDIT_NAME = 'kolid-workbench'
_PLUGIN_FILES = ('package.json', 'lib/index.js', 'lib/client.js')
_PATCH_BEGIN = '# >>> %s:begin >>>' % _BRIDGE_MARK
_PATCH_END = '# <<< %s:end <<<' % _BRIDGE_MARK
_PATCH_BLOCK = """{begin}
- insert:
    - id: {name}
      name: ./node_modules/{name}/lib/index.js
{end}"""
# 两块各有各的界标,谁重写谁自己那块,互不覆盖:插件一块、编辑 MCP 一块。
# _PROBE_BEGIN/_PROBE_END 只用于在已安装的旧 profile 里剔除残留的探针 MCP 块(新版不再写入)。
_EDIT_BEGIN = '# >>> %s-edit:begin >>>' % _BRIDGE_MARK
_EDIT_END = '# <<< %s-edit:end <<<' % _BRIDGE_MARK
_PROBE_BEGIN = '# >>> %s-mcp:begin >>>' % _BRIDGE_MARK
_PROBE_END = '# <<< %s-mcp:end <<<' % _BRIDGE_MARK
_MCP_BLOCK = """{begin}
- insert:
    - id: {mcp_id}
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: {mcp_name}
        transport: stdio
        command: {python}
        args: [{script}]
        cwd: {repo}{env}
{end}"""
_PLUGIN_OK = False


def _profile_dir() -> str:
    return os.path.join(_dsh_home(), 'profiles', 'web')


def _copy_if_diff(src: str, dst: str) -> None:
    with open(src, 'rb') as f:
        want = f.read()
    try:
        with open(dst, 'rb') as f:
            if f.read() == want:
                return
    except OSError:
        pass
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, 'wb') as f:
        f.write(want)


def _upsert_block(text: str, begin: str, end: str, block: str) -> str:
    if begin in text:
        return re.sub(re.escape(begin) + r'.*?' + re.escape(end), lambda _m: block, text, flags=re.S)
    return (text.rstrip('\n') + '\n\n' if text.strip() else '') + block + '\n'


def _strip_block(text: str, begin: str, end: str) -> str:
    """整段(含界标)删掉:用于在已安装的旧 profile 里剔除残留的探针 MCP 块。"""
    if begin not in text:
        return text
    return re.sub(re.escape(begin) + r'.*?' + re.escape(end) + r'\n?', '', text, flags=re.S)


def _ensure_profile_plugin(host_port: int = 0) -> bool:
    """把插件与编辑 MCP 在 patch 层挂上;profile 还不存在(首跑)就返回 False。

    读现场的探针 MCP(kolid-ui-probe)不再接入 dsh,所以只在旧 profile 里把残留的探针块剔除,
    不再写入;保留的是钉工作区的插件与改工程的编辑 MCP。
    """
    global _PLUGIN_OK
    profile = _profile_dir()
    if not os.path.isdir(profile):
        return False
    src = _repo_root('nodes', 'workbench', 'dsh_plugin')
    try:
        for rel in _PLUGIN_FILES:
            parts = rel.split('/')
            _copy_if_diff(os.path.join(src, *parts),
                          os.path.join(profile, 'node_modules', _PLUGIN_NAME, *parts))
        path = os.path.join(profile, 'cordis.patch.yml')
        try:
            with open(path, 'r', encoding='utf-8') as f:
                old = f.read()
        except OSError:
            old = ''
        # 先剔掉旧版可能写进去的探针 MCP 块(新版不再写入),再落插件与编辑 MCP。
        cleaned = _strip_block(old, _PROBE_BEGIN, _PROBE_END)
        block = _PATCH_BLOCK.format(begin=_PATCH_BEGIN, end=_PATCH_END, name=_PLUGIN_NAME)
        # JSON 的字符串就是合法的 YAML 双引号标量,Windows 反斜杠不会被当成转义。
        edit = _MCP_BLOCK.format(
            begin=_EDIT_BEGIN, end=_EDIT_END, mcp_id=_EDIT_ID, mcp_name=_EDIT_NAME,
            python=json.dumps(sys_executable()), script=json.dumps(_edit_mcp_path()),
            repo=json.dumps(_repo_root()),
            env=('\n        env:\n          WB_BASE: %s' % json.dumps('http://127.0.0.1:%d' % host_port)
                 if host_port else ''))
        new = _upsert_block(_upsert_block(cleaned, _PATCH_BEGIN, _PATCH_END, block),
                            _EDIT_BEGIN, _EDIT_END, edit)
        if new != old:
            with open(path, 'w', encoding='utf-8') as f:
                f.write(new)
        _PLUGIN_OK = True
        return True
    except OSError:
        return False


def _edit_mcp_path() -> str:
    return _repo_root('tools', 'wb_mcp.py')


def _deferred_install(proc: subprocess.Popen, host_port: int = 0) -> None:
    """首跑:profile 是 dsh 自己生成的,等它落盘再装插件,然后重启一次让它生效。

    只在 profile 本来不存在时才会走到这儿;装完的重启由我们自己发起,页面重新连上来看到的
    就已经是钉住工作区的那一份,用户不用知道中间死过一次。
    """
    for _ in range(45):
        if _ensure_profile_plugin(host_port):
            break
        time.sleep(1)
    else:
        return
    with _LOCK:
        if _PROC is not proc:
            return  # 用户已经手动停掉/重启过,别抢
    time.sleep(1.0)
    stop()
    start(host_port)


def _prepare(host_port: int = 0) -> str:
    """启动前的一次性准备:全局桥接说明 + profile 插件/MCP;返回子进程的 cwd(绑定目录)。"""
    _write_global_bridge()
    _ensure_profile_plugin(host_port)
    return bound_dir()


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
                    # 不能再往这个地址上挂参数:token 换 cookie 的那一跳是 303 `location: ./`,
                    # 查询串会被整个丢掉(连 referrer 都是 no-referrer),绑定只能走 postMessage。
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


def start(host_port: int = 0) -> dict:
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
    ws = _prepare(host_port)
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
        _INFO.update(pid=proc.pid, port=port, started_at=time.time(), mode='starting', error='',
                     url='', bind=ws, log=[])
    threading.Thread(target=_pump, args=(proc,), daemon=True).start()
    if not _PLUGIN_OK:
        threading.Thread(target=_deferred_install, args=(proc, host_port), daemon=True).start()
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
def _host_port(h) -> int:
    """工作台自己监听的端口 —— 页面那条探针长轮询就是发给它的,所以 MCP 也得连它。"""
    try:
        return int(h.server.server_address[1])
    except (AttributeError, IndexError, TypeError, ValueError):
        return 0


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
        h._send_json({'ok': True, **start(_host_port(h))})
        return

    if h.command == 'POST' and path == '/api/agent_dsh/stop':
        h._send_json({'ok': True, **stop()})
        return

    if h.command == 'POST' and path == '/api/agent_dsh/bind':
        # 页面报"当前 cud 在哪":落盘给下一次启动,运行中的那份由插件自己换(见 client.js)。
        # 空的 path 是有意义的(没有 cud → 绑仓库根),所以只把"整个字段都没给"当成坏请求。
        req = body()
        if 'path' not in req:
            h._send_json({'ok': False, 'error': 'path required'}, 400)
            return
        r = bind(req.get('path'))
        h._send_json({'ok': True, **r})
        return

    h._send_json({'ok': False, 'error': 'unknown agent_dsh route: %s %s' % (h.command, path)}, 404)
