#!/usr/bin/env python
"""工作台的编辑 MCP —— 把"改工程"也变成一次工具调用。

探针 MCP(tools/ui_probe_mcp.py)偏**读现场**:布局、命中、轨迹、组件层;这份偏**改工程**:
切播放头、摆段、改图层、起生成、改画布。两者互补,各挂一个 server。

工具目录不在这里手抄:schema 的唯一真源是前端 `ui/sampler_node/src/agent/toolSchemas.ts`
(与执行体同目录、由 tsc 咬合),构建时转成 `nodes/workbench/agent_tools.json`,后端按 mtime
热读后经 `GET /api/agent/tools` 交出来。执行也不在这里:`POST /api/agent/direct_tool`
把调用送进**用户当前打开的那个页面**(页面上的 window.__wbAgentTool → runAgentTool),
所以页面必须开着;关着时会拿到一句明确的话而不是假成功。

端口:WB_BASE / UI_PROBE_BASE(agent_dsh.py 启动时按工作台真实端口写进 profile)→ WB_PORT
→ 扫 8700..8799(与 wb_agent.py 同一顺位)。

约束与探针 MCP 相同:
1. **stdout 只准出现 JSON-RPC** —— 先把 fd 1 私藏,再让 fd 1 指向 stderr。
2. **读不到就说读不到** —— 找不到工作台/页面没开/工具报错,原样传回,不伪造结果。

用法(通常由 dsh 的 MCP 配置拉起):

    python tools/wb_mcp.py
    WB_BASE=http://127.0.0.1:8700 python tools/wb_mcp.py
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request

SERVER_NAME = 'kolid-workbench'
SERVER_VERSION = '1.0.0'
PROTOCOLS = ('2025-06-18', '2025-03-26', '2024-11-05')
PORTS = range(8700, 8800)


class ToolError(Exception):
    """工具自己报的错:内容会被原样交给调用方看,所以话要说得能直接行动。"""


# ── 连接 ────────────────────────────────────────────────────────────────────
def _get(base: str, path: str, timeout: float = 5.0):
    with urllib.request.urlopen(base + path, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def _post(base: str, path: str, payload: dict, timeout: float = 100.0):
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(base + path, data=data,
                                 headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode('utf-8'))
        except ValueError:
            raise ToolError('workbench answered HTTP %d' % e.code) from None


_BASE = None
_BASE_LOCK = threading.Lock()


def _candidates():
    out = []
    for key in ('WB_BASE', 'UI_PROBE_BASE'):
        v = os.environ.get(key)
        if v:
            out.append(v.rstrip('/'))
    port = os.environ.get('WB_PORT')
    if port:
        out.append('http://127.0.0.1:%s' % port)
    return out


def _alive(base: str) -> bool:
    try:
        return bool(_get(base, '/api/agent_dsh/status', timeout=1.5).get('ok'))
    except (OSError, ValueError):
        return False


def resolve_base() -> str:
    """工作台自己的 HTTP 端口。优先环境变量(启动方钉的),否则扫一遍。"""
    global _BASE
    with _BASE_LOCK:
        if _BASE and _alive(_BASE):
            return _BASE
        for base in _candidates():
            if _alive(base):
                _BASE = base
                log('[wb-mcp] workbench at %s' % base)
                return base
        for port in PORTS:
            base = 'http://127.0.0.1:%d' % port
            if _alive(base):
                _BASE = base
                log('[wb-mcp] workbench at %s' % base)
                return base
    raise ToolError(
        'workbench not found on 8700..8799 — is the workbench UI open?\n'
        'MCP 只是把调用送进那个页面;先让用户在 ComfyUI 里跑一次 sampler 节点/打开工作台。')


# ── 工具目录(后端热读的 agent_tools.json)─────────────────────────────────────
# 这里**不再"启动时读一次"**:后端把 agent_tools.json 的 sha 一起发出来,这边按 sha 判断
# 工具表变没变 —— 前端重新构建之后,dsh 不用重启 MCP 就能看见新工具。
_CATALOG = None
_CATALOG_SHA = None
_CATALOG_LOCK = threading.Lock()
_CATALOG_READY = threading.Event()


def _schema(t: dict) -> dict:
    fn = t.get('function') or {}
    params = fn.get('parameters')
    if not isinstance(params, dict):
        params = {'type': 'object', 'properties': {}}
    return {'name': str(fn.get('name') or ''), 'description': str(fn.get('description') or ''),
            'inputSchema': params}


def catalog() -> dict:
    """name -> MCP tool schema。后端起不来时重试几秒再报错(它和页面同源,通常在)。"""
    global _CATALOG, _CATALOG_SHA
    with _CATALOG_LOCK:
        if _CATALOG:
            return _CATALOG
        last = ''
        for _ in range(12):
            try:
                d = _get(resolve_base(), '/api/agent/tools', timeout=8)
                if d.get('ok') and isinstance(d.get('tools'), list):
                    _CATALOG = {s['name']: s for s in (_schema(t) for t in d['tools']) if s['name']}
                    _CATALOG_SHA = str(d.get('sha') or '') or None
                    log('[wb-mcp] %d tools loaded (sha %s)' % (len(_CATALOG), _CATALOG_SHA))
                    return _CATALOG
                last = str(d.get('error') or 'unexpected answer')
            except ToolError as e:
                last = str(e)
            except (OSError, ValueError) as e:
                last = str(e)
            time.sleep(0.4)
    raise ToolError(
        'cannot read the workbench tool catalog: %s\n'
        '这条路由在 /api/agent/tools —— 后端没起来,或 agent_tools.json 还没生成'
        '(cd ui && npm run build -w sampler_node)。' % last)


def refresh_catalog(force: bool = False) -> bool:
    """工具表变了没有?变了就作废缓存重取,返回 True;没变(或问不到)返回 False。

    后端把 `agent_tools.json` 的 sha 一起交出来,前端重新构建会改写它 —— 于是"加了个工具"
    这件事在这里自动可见,不需要谁记得重启 MCP。
    """
    global _CATALOG, _CATALOG_SHA
    try:
        meta = _get(resolve_base(), '/api/agent/tools/meta', timeout=4)
    except (ToolError, OSError, ValueError):
        return False
    sha = str(meta.get('sha') or '')
    if not sha:
        return False
    with _CATALOG_LOCK:
        if not force and _CATALOG and sha == _CATALOG_SHA:
            return False
        _CATALOG = None
    catalog()
    with _CATALOG_LOCK:
        _CATALOG_SHA = sha
    return True


def watch_catalog():
    """后台盯工具表:变了就告诉客户端(`notifications/tools/list_changed`)。

    只在客户端连上之后才开始(initialize 之前发通知会把它弄困惑)。客户端若不认这条通知,
    至少 `tools/list` / `tools/call` 下次会拿到新表 —— 比"必须重启 dsh"好。
    """
    _CATALOG_READY.wait()
    while True:
        time.sleep(2.0)
        try:
            if refresh_catalog():
                send({'jsonrpc': '2.0', 'method': 'notifications/tools/list_changed'})
                log('[wb-mcp] catalog changed -> tools/list_changed')
        except Exception:  # noqa: BLE001 — 后台线程不该把进程带下去
            pass


def call_tool(name: str, arguments: dict) -> dict:
    tools = catalog()
    if name not in tools:
        # 工具表可能刚变(前端重新构建了):强刷一次,仍没有就如实说。
        try:
            refresh_catalog(force=True)
        except ToolError:
            pass
        tools = catalog()
    if name not in tools:
        raise ToolError('没有这个工具:%s(有:%s)' % (name, ', '.join(sorted(tools))))

    d = _post(resolve_base(), '/api/agent/direct_tool', {'name': name, 'args': arguments or {}})
    if not d.get('ok'):
        raise ToolError(str(d.get('error') or 'workbench call failed'))
    value = d.get('value')
    if isinstance(value, dict):
        text = value.get('content')
        ok = bool(value.get('ok', True))
        if not isinstance(text, str):
            text = json.dumps(value, ensure_ascii=False, indent=1)
    else:
        ok = True
        text = json.dumps(value, ensure_ascii=False, indent=1)

    # get_app_state 这类返回的是一整段 JSON —— 展开给人读,别让 agent 对着转义字符串啃。
    if text.lstrip().startswith('{') or text.lstrip().startswith('['):
        try:
            text = json.dumps(json.loads(text), ensure_ascii=False, indent=1)
        except ValueError:
            pass
    return {'content': [{'type': 'text', 'text': text}], 'isError': not ok}


# ── JSON-RPC over stdio ─────────────────────────────────────────────────────
_out = None
_out_lock = threading.Lock()


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def send(obj):
    data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
    with _out_lock:
        _out.write(data + b'\n')
        _out.flush()


def ok(mid, result):
    send({'jsonrpc': '2.0', 'id': mid, 'result': result})


def fail(mid, code, message):
    send({'jsonrpc': '2.0', 'id': mid, 'error': {'code': code, 'message': message}})


def run_tool(name: str, arguments: dict) -> dict:
    try:
        return call_tool(name, arguments or {})
    except ToolError as e:
        return {'content': [{'type': 'text', 'text': '✗ ' + str(e)}], 'isError': True}
    except Exception as e:  # noqa: BLE001 — 工具边界:原样交给调用方
        log('[wb-mcp] tool %s crashed:\n%s' % (name, traceback.format_exc()))
        return {'content': [{'type': 'text', 'text': '✗ 工具内部出错:%s' % e}], 'isError': True}


def handle(msg):
    mid = msg.get('id')
    method = msg.get('method')
    params = msg.get('params') or {}

    if method is None:
        return  # 客户端对我们发过去的东西的回应(我们不主动发请求),忽略
    if mid is None:  # 通知:不回应
        if method == 'notifications/initialized':
            log('[wb-mcp] client ready')
            _CATALOG_READY.set()
            threading.Thread(target=watch_catalog, daemon=True).start()
        return

    if method == 'initialize':
        want = str(params.get('protocolVersion') or '')
        pv = want if want in PROTOCOLS else PROTOCOLS[0]
        ok(mid, {
            'protocolVersion': pv,
            'capabilities': {'tools': {'listChanged': True}},
            'serverInfo': {'name': SERVER_NAME, 'version': SERVER_VERSION},
            'instructions': (
                '编辑 Kolid Comfy 工作台的工具(与 kolid-ui-probe 的"读现场"互补)。'
                '每次动手前先 get_app_state 拿轨/段/图层/选中/预设的现况,按它给的 id 操作;'
                '改完再看一次状态自证。时间单位是秒,clip/track id 是字符串,layer id 是数字。'
                '这些是用户工程里真实、可撤销的修改;页面必须开着(调用落到页面的 '
                'window.__wbAgentTool),页面关着会明确报 workbench page not loaded。'
                'run_pipeline 可能跑几分钟 —— 启动后告诉用户去哪儿看进度,不要死循环轮询。'),
        })
        return
    if method == 'ping':
        ok(mid, {})
        return
    if method == 'tools/list':
        # 后端可能没起来(没有 /api/agent/tools):如实回一条 JSON-RPC 错误,而不是让线程
        # 在异常里死掉 —— 客户端等不到应答只会显示超时,分不清"没这个服务"和"服务挂了"。
        try:
            refresh_catalog()
            ok(mid, {'tools': list(catalog().values())})
        except ToolError as e:
            fail(mid, -32603, str(e))
        return
    if method == 'tools/call':
        ok(mid, run_tool(str(params.get('name') or ''), params.get('arguments') or {}))
        return
    if method == 'resources/list':
        ok(mid, {'resources': []})
        return
    if method == 'prompts/list':
        ok(mid, {'prompts': []})
        return
    if method == 'logging/setLevel':
        ok(mid, {})
        return
    fail(mid, -32601, 'method not found: %s' % method)


def main():
    global _out
    # 关键一步:把真正的 stdout 私藏起来,再让 fd 1 指向 stderr。
    # 于是任何 print(包括第三方库的)都不会插进 JSON-RPC 的流里。
    real = os.dup(1)
    os.dup2(2, 1)
    _out = os.fdopen(real, 'wb', 0)

    for line in sys.stdin.buffer:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line.decode('utf-8', 'replace'))
        except Exception as e:
            log('[wb-mcp] bad json: %s' % e)
            continue
        if isinstance(msg, list):
            for m in msg:
                threading.Thread(target=handle, args=(m,), daemon=True).start()
            continue
        # 一条请求一个线程:工具调用要经页面执行(可能几秒),不该把 ping 堵在后面。
        threading.Thread(target=handle, args=(msg,), daemon=True).start()

    log('[wb-mcp] stdin closed, bye')


if __name__ == '__main__':
    main()
