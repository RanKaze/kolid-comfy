#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""wb — Kolid Comfy 工作台的终端桥(给 DeepSeek Harness / 任何有 shell 的 coding agent 用)。

用法:
  python wb_agent.py ping                      # 连通性 + sidecar 状态
  python wb_agent.py state                     # 应用全家桶快照(轨/段/图层/选中/预设……)
  python wb_agent.py tools                     # 全部工具(从后端取,不手抄)
  python wb_agent.py ui-actions [group]        # 界面动作键(ui_action 能按的那张表)
  python wb_agent.py call <tool> [json_args]   # 执行一个工作台工具
  python wb_agent.py --port 8703 call seek '{"time": 4.0}'

端口发现:--port > 环境变量 WB_PORT > 扫描 8700..8799(与工作台服务同一顺位)。
工具在浏览器里执行(页面须开着);全部输出 JSON。"""
import json
import os
import sys
import urllib.error
import urllib.request

PORTS = range(8700, 8800)


def _get(port: int, path: str, timeout: float = 5.0):
    with urllib.request.urlopen('http://127.0.0.1:%d%s' % (port, path), timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def _post(port: int, path: str, payload: dict, timeout: float = 75.0):
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request('http://127.0.0.1:%d%s' % (port, path), data=data,
                                 headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode('utf-8'))
        except ValueError:
            return {'ok': False, 'error': 'HTTP %d' % e.code}


def find_port(explicit: int = 0) -> int:
    ports = [explicit] if explicit else ([int(os.environ['WB_PORT'])] if os.environ.get('WB_PORT') else list(PORTS))
    for p in ports:
        try:
            d = _get(p, '/api/agent_dsh/status', timeout=2.0)
            if d.get('ok'):
                return p
        except (OSError, ValueError):
            continue
    raise SystemExit('workbench not found on %s — is the workbench UI open? (server listens on 8700..8799)'
                     % ('port %d' % explicit if explicit else 'ports 8700..8799'))


def main(argv):
    explicit = 0
    if '--port' in argv:
        i = argv.index('--port')
        explicit = int(argv[i + 1])
        del argv[i:i + 2]
    if not argv:
        print(__doc__)
        return 0
    cmd, rest = argv[0], argv[1:]
    port = find_port(explicit)

    if cmd == 'ping':
        dsh = _get(port, '/api/agent_dsh/status')
        print(json.dumps({'ok': True, 'port': port, 'dsh': dsh}, ensure_ascii=False, indent=2))
        return 0

    if cmd == 'state':
        d = _post(port, '/api/agent/direct_tool', {'name': 'get_app_state', 'args': {}})
        if not d.get('ok'):
            print(json.dumps(d, ensure_ascii=False, indent=2))
            return 1
        v = d.get('value') or {}
        try:
            snap = json.loads(v.get('content')) if isinstance(v.get('content'), str) else v
        except ValueError:
            snap = v
        print(json.dumps(snap, ensure_ascii=False, indent=2))
        return 0

    if cmd == 'tools':
        # 工具表从后端现取（真源是前端 toolSchemas.ts，后端热读它的构建产物），不在这里手抄
        # —— 手抄的清单一定会过期。
        d = _get(port, '/api/agent/tools')
        rows = [t.get('function', {}) for t in (d.get('tools') or []) if isinstance(t, dict)]
        for f in rows:
            desc = (f.get('description') or '').strip().split('\n')[0]
            print('%-24s %s' % (f.get('name', '?'), desc[:110]))
        print('\n%d tools (source: GET /api/agent/tools)' % len(rows))
        return 0

    if cmd == 'ui-actions':
        # 界面动作键：`ui_action` 能按的那张表（每一颗按钮 / 滑杆 / 菜单项 = 一个键）。
        group = rest[0] if rest else ''
        args = {'group': group} if group else {}
        d = _post(port, '/api/agent/direct_tool', {'name': 'get_ui_actions', 'args': args})
        if not d.get('ok'):
            print(json.dumps(d, ensure_ascii=False, indent=2))
            return 1
        v = d.get('value') or {}
        print(v.get('content') or json.dumps(v, ensure_ascii=False, indent=2))
        return 0 if v.get('ok') else 1

    if cmd == 'call':
        if not rest:
            print(json.dumps({'ok': False, 'error': 'usage: wb call <tool> [json_args]'}))
            return 2
        name = rest[0]
        try:
            args = json.loads(rest[1]) if len(rest) > 1 else {}
        except ValueError:
            print(json.dumps({'ok': False, 'error': 'args must be a JSON object'}))
            return 2
        d = _post(port, '/api/agent/direct_tool', {'name': name, 'args': args})
        print(json.dumps(d, ensure_ascii=False, indent=2))
        return 0 if d.get('ok') else 1

    print(json.dumps({'ok': False, 'error': 'unknown command %r (ping | state | tools | ui-actions | call)' % cmd}))
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
