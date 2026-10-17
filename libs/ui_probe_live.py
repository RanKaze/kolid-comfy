"""界面探针的**实时通道** —— 页面常驻长轮询，外部发一行表达式，页面就地求值再回传。

为什么需要它：快照 + 重放只能回答"这份**拷贝**里是不是也有这个问题"。真正要回答的是
"读我**现在眼前**这个状态"。差别不在数据多少，在**现场是不是活的**：快照是死的，重放是复制的，
这里是问题页面本身接着。

    ┌──────────┐  GET /cmd?wait=25（长轮询）   ┌──────────┐
    │  页面    │ ─────────────────────────────▶│  通道    │
    │ (探针)   │ ◀───────────────────────────── │ (这里)   │
    └──────────┘   {id, expr}                  └──────────┘
         │ 就地求值                                        ▲
         └────── POST /res {id, ok, value, error} ─────────┘

于是任何一端 `POST /eval {expr}` 就能**同步**拿到活页面里的值，像在控制台里敲一行。

这条协议只写一次（本模块），三处共用：独立 sink（`temporary/ui_probe_sink.py`）、
ComfyUI 后端路由、MCP 工具（`tools/ui_probe_mcp.py`）。共用同一份实现，"语义相同"才不是口号 ——
上次绝对导入那个 bug 就是靠这个思路在无头环境里暴露不出来的。

安全：只绑 127.0.0.1。谁能 eval 由页面决定（它必须先连上来），这里只负责搬运。
它不是公网服务，也不该被绑到 0.0.0.0 上。
"""
from __future__ import annotations

import json
import os
import queue
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import ui_probe_store as ups

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, 'nodes', 'web')

DEFAULT_PORT = 8791
SINK = 'http://127.0.0.1:%d' % DEFAULT_PORT

# ── 通道状态 ────────────────────────────────────────────────────────────────
# 指令是**一次请求**，不是状态：被取走就没了，没人取走也不会留下残渣。
_INBOX: queue.Queue = queue.Queue()
_CV = threading.Condition()
_RESULTS: dict = {}      # id -> {'ok','value','error','at'}
_SESSIONS: dict = {}     # sid -> {'sid','url','build','vp','at','age'}
_PULL = {'want': 0.0, 'done': 0.0}
_LOCK = threading.Lock()


def sessions(max_age: float | None = 120.0) -> list:
    """现在有哪些页面还接着。`max_age` 秒内有过心跳才算活着（关掉的标签页会留下尸体）。"""
    now = time.time()
    with _LOCK:
        rows = [{**v, 'age': round(now - v['at'], 1)} for v in _SESSIONS.values()]
    if max_age is not None:
        rows = [r for r in rows if r['age'] <= max_age]
    return sorted(rows, key=lambda r: r['age'])


def pending() -> dict:
    return {'queued': _INBOX.qsize(), 'awaiting': sorted(_RESULTS)}


def notes_session(sid: str, info: dict) -> None:
    if not sid:
        return
    with _LOCK:
        cur = _SESSIONS.setdefault(sid, {'sid': sid})
        cur.update(info or {})
        cur['at'] = time.time()


def submit(expr: str, timeout: float = 20.0) -> dict:
    """往队列里放一条指令，等页面回传。返回 {'ok','value','error'}。

    没有页面接着时立刻失败并说清原因 —— 这比"等 20 秒再超时"有用得多：前者指向"页面没连上来"，
    后者会被误读成"页面卡住了"。
    """
    if not expr:
        return {'ok': False, 'error': 'empty expr'}
    if not sessions():
        return {'ok': False, 'error': '没有页面接上来：页面要先加载带巡检回路的产物（刷新一次），'
                                      '且通道要开着。', 'no_session': True}
    cid = uuid.uuid4().hex[:12]
    _INBOX.put({'id': cid, 'expr': expr, 'at': time.time()})
    deadline = time.time() + max(1.0, min(float(timeout), 120.0))
    with _CV:
        while cid not in _RESULTS and time.time() < deadline:
            _CV.wait(timeout=max(0.05, deadline - time.time()))
        res = _RESULTS.pop(cid, None)
    if res is None:
        return {'ok': False, 'error': '超时：指令发出去了，但 %ss 内没有页面回来'
                                      '（页面可能已关闭，或巡检回路被停掉了）' % int(timeout)}
    return res


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Max-Age', '600')

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _html(self, file_path):
        if not os.path.exists(file_path):
            self._json({'ok': False, 'error': os.path.basename(file_path) + ' not found (rebuild the ui)'}, 404)
            return
        with open(file_path, 'rb') as f:
            body = f.read()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    # ── GET ────────────────────────────────────────────────────────────────
    def do_GET(self):
        u = urlparse(self.path)
        if not u.path.startswith('/api/ui_probe'):
            self._json({'ok': False, 'error': 'not found: ' + u.path}, 404)
            return
        tail = u.path[len('/api/ui_probe'):]
        qs = parse_qs(u.query)

        if tail == '/cmd':
            wait = float(qs.get('wait', ['0'])[0] or 0)
            notes_session(qs.get('sid', [''])[0], {
                'url': qs.get('url', [''])[0],
                'build': qs.get('build', [''])[0],
                'vp': qs.get('vp', [''])[0],
                'note': qs.get('note', [''])[0],
            })
            try:
                cmd = _INBOX.get(timeout=max(0.0, min(wait, 30)))
            except queue.Empty:
                cmd = None
            self._json({'ok': True, 'cmd': cmd})
            return

        if tail == '/sessions':
            self._json({'ok': True, 'sessions': sessions()})
            return
        if tail == '/pending':
            self._json({'ok': True, **pending()})
            return
        if tail in ('', '/'):
            self._json({'ok': True, 'count': len(ups.listing()), 'dir': ups.DIR,
                        'files': ups.listing()[:20]})
            return
        if tail == '/list':
            self._json({'ok': True, 'dir': ups.DIR, 'files': ups.listing()})
            return
        if tail == '/latest':
            snap = ups.latest()
            self._json(snap if snap is not None else {'ok': False, 'error': 'no snapshot yet'},
                       200 if snap is not None else 404)
            return
        if tail == '/get':
            name = qs.get('name', [''])[0]
            snap = ups.load(name)
            self._json(snap if snap is not None else {'ok': False, 'error': 'not found: %r' % name},
                       200 if snap is not None else 404)
            return
        if tail == '/build':
            self._json({'ok': True, 'build': ups.build_info()})
            return
        if tail == '/view':
            self._html(os.path.join(WEB, 'probe_viewer.html'))
            return
        if tail == '/pull':
            with _LOCK:
                want = _PULL['want'] if _PULL['want'] > _PULL['done'] else 0
            self._json({'ok': True, 'want': want})
            return
        self._json({'ok': False, 'error': 'unknown ui_probe path: %s' % tail}, 404)

    # ── POST ───────────────────────────────────────────────────────────────
    def do_POST(self):
        u = urlparse(self.path)
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length) if length else b''
        if not u.path.startswith('/api/ui_probe'):
            self._json({'ok': False, 'error': 'not found: ' + u.path}, 404)
            return
        tail = u.path[len('/api/ui_probe'):]
        try:
            data = json.loads(raw) if raw else {}
        except Exception:
            data = {}

        if tail == '/res':
            cid = str(data.get('id') or '')
            with _CV:
                _RESULTS[cid] = {'ok': bool(data.get('ok')), 'value': data.get('value'),
                                 'error': data.get('error'), 'at': time.time()}
                _CV.notify_all()
            self._json({'ok': True})
            return

        if tail == '/eval':
            res = submit(str(data.get('expr') or ''), float(data.get('timeout') or 20))
            # 只有"没有页面"用 409 报出来（那是环境问题，不是表达式问题）；表达式自己报错仍是 200，
            # 因为请求确实被送到了、也被执行了 —— 把两者混成一个状态码会让调用端误判。
            self._json(res, 409 if res.get('no_session') else 200)
            return

        if tail in ('', '/'):
            try:
                info = ups.save(data)
                problems = data.get('problems') or []
                build = ups.build_info()
                print('[UIProbe] saved %s (%dKB, %d problems: %s) build=%s stale=%s'
                      % (info['file'], info['bytes'] // 1024, len(problems),
                         ','.join(sorted({str(p.get('code')) for p in problems}))[:200],
                         data.get('build') or '?', build.get('stale')))
                self._json({'ok': True, 'file': info['file'], 'dir': info['dir'],
                            'bytes': info['bytes'], 'build': build})
            except Exception as e:
                print('[UIProbe] rejected snapshot: %s' % e)
                self._json({'ok': False, 'error': str(e)}, 400)
            return
        if tail == '/pull':
            with _LOCK:
                _PULL['want'] = time.time()
            self._json({'ok': True, 'want': _PULL['want']})
            return
        if tail == '/ack':
            with _LOCK:
                _PULL['done'] = time.time()
            self._json({'ok': True})
            return
        self._json({'ok': False, 'error': 'unknown ui_probe path: %s' % tail}, 404)


def make_server(port: int = DEFAULT_PORT, host: str = '127.0.0.1') -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    return srv


def start_background(port: int = DEFAULT_PORT):
    """在后台线程里起一条通道。端口被占则返回 None（说明已经有一条在跑，直接用它）。"""
    try:
        srv = make_server(port)
    except OSError:
        return None
    t = threading.Thread(target=srv.serve_forever, name='ui-probe-live', daemon=True)
    t.start()
    return srv


def serve_forever(port: int = DEFAULT_PORT) -> None:
    srv = make_server(port)
    print('[UIProbe] live channel on http://127.0.0.1:%d  →  %s' % (port, ups.DIR), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


# ── 客户端：跟"某一条通道"说话 ───────────────────────────────────────────────
class Client:
    """对某一条通道的 HTTP 客户端。`base` 可以是独立 sink，也可以是 ComfyUI 后端。

    两处都实现了同一组路由，所以这里不需要区分是谁在听 —— 这正是把协议收进一个模块的收益。
    """

    def __init__(self, base: str = SINK, timeout: float = 40.0):
        self.base = base.rstrip('/')
        self.timeout = timeout

    def _call(self, path: str, payload=None, timeout: float | None = None) -> dict:
        import urllib.error
        import urllib.request
        url = self.base + path
        data = None if payload is None else json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            url, data=data, method='GET' if payload is None else 'POST',
            headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as r:
                return json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            try:
                return json.loads(e.read().decode('utf-8'))
            except Exception:
                return {'ok': False, 'error': 'HTTP %s' % e.code}
        except Exception as e:
            return {'ok': False, 'error': '%s（%s 上没有通道在听？）' % (e, self.base)}

    def sessions(self) -> dict:
        return self._call('/api/ui_probe/sessions', timeout=3)

    def pending(self) -> dict:
        return self._call('/api/ui_probe/pending', timeout=3)

    def eval(self, expr: str, timeout: float = 20.0) -> dict:
        return self._call('/api/ui_probe/eval', {'expr': expr, 'timeout': timeout},
                          timeout=timeout + 15)

    def save(self, snap: dict) -> dict:
        return self._call('/api/ui_probe', snap, timeout=60)

    def build(self) -> dict:
        return self._call('/api/ui_probe/build', timeout=5)


def candidates() -> list:
    """哪些地址可能有人听得懂巡检话。

    页面自己按"同源优先，其次本地 sink"挑一个接上去；这一端得把同样的候选都问到 ——
    否则页面接在 ComfyUI 上、工具却只问 sink，就会出现"明明接着却说没有页面"。

    `UI_PROBE_BASE` 是**排他**的：说连谁就只连谁。测试与多实例（无头 + 真页面同时在跑）都需要
    这条确定性，否则会挑到心跳最新的那一个，而不是你指的那个。
    """
    env = os.environ.get('UI_PROBE_BASE', '').strip()
    if env:
        return [env.rstrip('/')]
    out = [SINK]
    for extra in ('http://127.0.0.1:8700', 'http://127.0.0.1:8000', 'http://127.0.0.1:8188'):
        out.append(extra)
    seen, uniq = set(), []
    for b in out:
        b = b.rstrip('/')
        if b not in seen:
            seen.add(b)
            uniq.append(b)
    return uniq


def resolve(force: bool = False) -> tuple:
    """挑一条**有活页面**的通道。返回 (Client, sessions)。

    优先"心跳最新的那一条"：同一个页面可能同时挂在多条通道上（同源 + sink），
    挑错的那条只会得到空会话，然后被误读成"没有页面"。
    """
    best = None
    for base in candidates():
        c = Client(base)
        r = c.sessions()
        if not r.get('ok'):
            continue
        ss = [s for s in (r.get('sessions') or []) if s.get('age', 1e9) <= 120]
        if not ss:
            continue
        if best is None or ss[0].get('age', 1e9) < best[2][0].get('age', 1e9):
            best = (c, base, ss)
    if best:
        return best[0], best[2]
    # 一条活的都没有：返回第一条能应答的通道，好让报错指向"页面没连上来"而不是"连不上通道"。
    for base in candidates():
        c = Client(base)
        if c.sessions().get('ok'):
            return c, []
    return Client(candidates()[0]), []
