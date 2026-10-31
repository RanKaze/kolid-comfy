# ── /api/clock 的契约测试 ─────────────────────────────────────────────────────────────────────
#
# 为什么单开一个：验证"后端那半边"不需要重启 ComfyUI。这个脚本把 clock_bridge 挂在一条
# 最小 HTTP 服务上，跑的就是 snapshot_sampler_node.py 里那两段路由**同样的调用**，然后从
# 客户端视角检查一遍契约（字段齐不齐、位置跟不跟墙钟、写口认不认动作）。
#
# 用法： python test_http.py

import http.server
import json
import os
import socketserver
import sys
import threading
import time
import urllib.request
from urllib.parse import urlparse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                '..', 'nodes', 'workbench'))
try:
    import clock_bridge
except ImportError:
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))), 'nodes', 'workbench'))
    import clock_bridge

FAILS = []


def check(name, ok, detail=''):
    print(('  PASS  ' if ok else '  FAIL  ') + name + (('  ' + detail) if detail else ''))
    if not ok:
        FAILS.append(name)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, data, status=200):
        body = json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == '/api/clock':
            self._json(clock_bridge.get_clock().snapshot())
            return
        self._json({'error': 'nope'}, 404)

    def do_POST(self):
        if urlparse(self.path).path != '/api/clock':
            self._json({'error': 'nope'}, 404)
            return
        n = int(self.headers.get('Content-Length', 0))
        data = json.loads(self.rfile.read(n)) if n else {}
        try:
            self._json(clock_bridge.get_clock().apply(str(data.get('action') or ''), data.get('value')))
        except Exception as exc:                     # noqa: BLE001
            self._json({'error': str(exc)}, 400)


def get(port, path):
    with urllib.request.urlopen('http://127.0.0.1:%d%s' % (port, path), timeout=5) as r:
        return json.loads(r.read().decode('utf-8'))


def post(port, path, payload):
    req = urllib.request.Request('http://127.0.0.1:%d%s' % (port, path),
                                 data=json.dumps(payload).encode('utf-8'),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read().decode('utf-8')), r.status
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode('utf-8')), e.code


def main():
    with socketserver.TCPServer(('127.0.0.1', 0), Handler) as srv:
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()

        snap = get(port, '/api/clock')
        keys = {'frames', 'rate', 'playing', 'now', 'freq', 'speed', 'source', 'sent_ms'}
        check('GET returns every field the client reads', keys.issubset(snap), str(sorted(snap)))

        # 播放 → 0.4s 后帧数应该走到 ~0.4*rate
        post(port, '/api/clock', {'action': 'seek', 'value': 0})
        post(port, '/api/clock', {'action': 'play'})
        time.sleep(0.4)
        after = get(port, '/api/clock')
        post(port, '/api/clock', {'action': 'pause'})
        expect = 0.4 * after['rate']
        err = abs(after['frames'] - expect) / max(1.0, expect)
        check('play advances the transport', err < 0.10, 'frames=%d expect~%d' % (after['frames'], expect))

        # 暂停之后两次数值一致
        a = get(port, '/api/clock')
        time.sleep(0.15)
        b = get(port, '/api/clock')
        check('paused transport is frozen', a['frames'] == b['frames'], '%d -> %d' % (a['frames'], b['frames']))
        check('playing flag follows', b['playing'] is False)

        # seek 到 2 秒
        r, code = post(port, '/api/clock', {'action': 'seek', 'value': 2.0})
        check('seek by seconds', code == 200 and abs(r['frames'] - 2.0 * r['rate']) < 2,
              'frames=%d' % r['frames'])

        # 坏动作 → 400，不是 500
        r, code = post(port, '/api/clock', {'action': 'dance'})
        check('unknown action is a 400', code == 400 and 'error' in r, str(code))

        srv.shutdown()

    print('')
    if FAILS:
        print('FAILED: ' + ', '.join(FAILS))
        return 1
    print('ALL PASS')
    return 0


if __name__ == '__main__':
    sys.exit(main())
