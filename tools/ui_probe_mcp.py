#!/usr/bin/env python
"""界面探针的 MCP 封装 —— 让"读活页面"变成一个工具调用，而不是一串命令行。

在此之前，读一眼现场要这样：先确认 sink 开着 → 再拼一条 `ui_probe_cli.py eval "..."` → 再读输出。
每一步都在提醒"这是个外部进程"。封成 MCP 之后，这些都收进工具后面：

    ui_status    通道和页面在不在，产物是否旧
    ui_layout    一屏全景：块、把手、可达性、不变量
    ui_element   某个选择器的事实：盒子、样式、命中、祖先链
    ui_drag      在活页面里**真的拖一次**，给前后对照与轨迹
    ui_trace     最近发生过什么（拖拽/投放/模式切换/报错/resize）
    ui_tree      组件层级（走 React fiber）
    ui_eval      逃生口：直接在你的页面里跑一行表达式
    ui_snapshot  抓一份存档落盘

## 为什么它自己承载通道

通道（`libs/ui_probe_live.py`）就是页面长轮询的那条 HTTP 服务。它如果必须由**另一个**进程提供，
那 MCP 就只是套了个壳，还得先 `python temporary/ui_probe_sink.py`。所以这里启动时直接
在 8791 上把通道起来（后台线程，daemon）。端口已被占（比如你已经手动起过 sink）就不抢，
直接连上去 —— 于是"装一个 MCP"和"起一个 sink"是同一件事，不会互相打架。

## 三条不能破的约束

1. **stdout 只准出现 JSON-RPC**。启动第一件事就是把 fd 1 复制走、再让 fd 1 指向 stderr，
   于是任何 `print()`、任何库的调试输出都不会把协议打断（这是手写 MCP 最常翻的车）。
2. **读不到就说读不到**。没有页面接上来时立刻失败并说明原因，不猜、不伪造一份数据。
3. **不在页面上留下痕迹**。默认只读；会动布局的只有 `ui_drag`，且它要显式调用。

用法（通常不用手动跑，配置里由客户端拉起）：

    python tools/ui_probe_mcp.py            # stdio MCP + 自带通道
    UI_PROBE_BASE=http://127.0.0.1:8700 python tools/ui_probe_mcp.py   # 指定连谁
"""
from __future__ import annotations

import json
import os
import sys
import threading
import traceback
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from libs import ui_probe_live as live  # noqa: E402
from libs import ui_probe_store as ups  # noqa: E402

SERVER_NAME = 'kolid-ui-probe'
SERVER_VERSION = '1.0.0'
PROTOCOLS = ('2025-06-18', '2025-03-26', '2024-11-05')


class ToolError(Exception):
    """工具自己报的错：内容会被原样交给调用方看，所以话要说得能直接行动。"""


# ── 文本排版 ────────────────────────────────────────────────────────────────
def _w(s: str) -> int:
    """显示宽度。CJK 占两格 —— 不然表头一有中文，整列就歪。"""
    return sum(2 if unicodedata.east_asian_width(c) in 'WF' else 1 for c in s)


def pad(s, n: int, right: bool = False) -> str:
    s = '' if s is None else str(s)
    gap = ' ' * max(0, n - _w(s))
    return gap + s if right else s + gap


def num(v, unit: str = '') -> str:
    if v is None:
        return '—'
    if isinstance(v, float) and not v.is_integer():
        return ('%.1f' % v) + unit
    return str(int(v)) + unit


# ── 连接 ────────────────────────────────────────────────────────────────────
def connect(need_page: bool = True):
    client, ss = live.resolve()
    if need_page and not ss:
        raise ToolError(
            '没有页面接上来。\n'
            '这条通道只认识装过探针的页面，所以需要：\n'
            '  1) 页面加载的是**新构建**的产物（`cd ui/sampler_node && npm run build`）；\n'
            '  2) 那个标签页在构建之后**刷新过一次**（巡检回路在启动时挂上）；\n'
            '  3) 通道开着（本 MCP 会自己起；也可 `python temporary/ui_probe_sink.py`）。\n'
            '先跑 ui_status 看现在到底哪一环缺。')
    return client, ss


# ── 页内表达式 ──────────────────────────────────────────────────────────────
# 约定：只用页面已经暴露的 `__uiProbe` 助手，不发明第二套查询语言 —— DOM 本身就是那套语言。
E_LAYOUT = r"""(() => {
  const p = __uiProbe;
  const s = p.snapshot('mcp');
  const rows = (s.dock && s.dock.rows) || [];
  // 声明尺寸**沿父轴**计：竖向排列里的 60 是高，横向排列里的 340 是宽。所以轴向必须一起带出来，
  // 否则表里"声明 60 / 显示宽 1426"这种行会自己骗人（toolbar 就是这么一行）。
  const meta = {};
  for (const r of rows) if (r.kind === 'b' && r.block) meta[r.block] = r;
  const seen = new Set();
  const bs = p.blocks().filter(x => !seen.has(x.block) && seen.add(x.block));
  return {
    build: s.build, id: s.id,
    vp: [window.innerWidth, window.innerHeight],
    dockW: (s.page && s.page.body) ? s.page.body.dockW : null,
    outline: s.outline,
    blocks: bs.map(x => {
      const m = meta[x.block] || {};
      return {
        block: x.block, axis: m.axis || null,
        declared: m.declared === undefined ? null : m.declared,
        rendered: m.rendered === undefined ? null : m.rendered,
        w: x.w, h: x.h, flex: x.flex, minW: m.style ? m.style.minWidth : null,
        scroll: x.scroll, hit: x.hitAtCenter, drawn: m.drawn !== false,
      };
    }),
    handles: p.handles(),
    problems: (s.problems || []).map(x => ({
      level: x.level, code: x.code, where: x.where, message: x.message, n: x.numbers,
    })),
  };
})()"""

E_ELEMENT = r"""(() => {
  const p = __uiProbe;
  const sel = __SEL__;
  const e = document.querySelector(sel);
  if (!e) {
    let near = [];
    try {
      const key = sel.replace(/^[.#]/, '').split(/[ .#:[>]/)[0];
      if (key) near = [...document.querySelectorAll('*')]
        .filter(x => (x.id && x.id.includes(key)) || (typeof x.className === 'string' && x.className.includes(key)))
        .slice(0, 8).map(x => p.desc(x));
    } catch (err) {}
    return { found: false, selector: sel, near };
  }
  const r = e.getBoundingClientRect();
  const cs = getComputedStyle(e);
  const styles = {};
  for (const k of __STYLES__) styles[k] = cs.getPropertyValue(k);
  const attrs = {};
  for (const a of e.attributes) if (a.name.startsWith('data-') || a.name === 'class' || a.name === 'style') attrs[a.name] = a.value;
  const chain = [];
  for (let x = e.parentElement; x && chain.length < 7; x = x.parentElement) chain.push(p.desc(x));
  const kids = [...e.children].slice(0, 12).map(x => ({ el: p.desc(x), ...p.rect(x) }));
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const at = document.elementFromPoint(cx, cy);
  return {
    found: true, selector: sel, el: p.desc(e), tag: e.tagName.toLowerCase(),
    box: p.rect(e), inline: { x: Math.round(r.left), y: Math.round(r.top) },
    styles, attrs, chain, kids: kids, kidCount: e.children.length,
    scroll: { w: e.scrollWidth, h: e.scrollHeight, cw: e.clientWidth, ch: e.clientHeight },
    text: (e.textContent || '').trim().slice(0, 160),
    hit: { at: [Math.round(cx), Math.round(cy)], on: p.desc(at), self: at === e },
  };
})()"""

E_DRAG = r"""(async () => {
  const p = __uiProbe;
  const name = __NAME__, dx = __DX__, dy = __DY__, side = __SIDE__;
  const hs = p.handles();
  const pick = side === 'auto'
    ? (hs.find(x => x.prev === name) || hs.find(x => x.next === name))
    : (side === 'right' ? hs.find(x => x.prev === name) : hs.find(x => x.next === name));
  if (!pick) return { ok: false, error: '找不到 ' + name + ' 旁边的把手（side=' + side + '）', handles: hs };
  const before = p.blocks().find(b => b.block === name);
  const pBefore = p.snapshot('pre').problems.length;
  const t0 = p.trace.list().filter(t => t.kind === 'drag').length;
  const hit = await p.drag(pick.at.x, pick.at.y, dx, dy);
  await new Promise(r => setTimeout(r, 150));
  const after = p.blocks().find(b => b.block === name);
  const notes = p.trace.list().filter(t => t.kind === 'drag').slice(t0);
  const pAfter = p.snapshot('post').problems.length;
  return {
    ok: true, handle: pick, hit,
    before: before ? before.w : null, after: after ? after.w : null,
    beforeH: before ? before.h : null, afterH: after ? after.h : null,
    problems: [pBefore, pAfter],
    notes: notes.map(t => ({ a: t.a, b: t.b, floor: t.floor, lo: t.lo, hi: t.hi,
                            pointer: t.pointer, pointerMax: t.pointerMax,
                            moved: t.moved, commits: t.commits, noops: t.noops })),
    all: p.blocks().map(b => ({ block: b.block, w: b.w, h: b.h })),
  };
})()"""

E_TRACE = r"""(() => {
  const p = __uiProbe;
  const all = p.trace.list();
  const kind = __KIND__;
  const rows = (kind ? all.filter(t => t.kind === kind) : all).slice(-__LIMIT__);
  const now = Date.now();
  return {
    total: all.length,
    rows: rows.map(t => {
      const o = {};
      for (const k in t) {
        if (k === 't' || k === 'n') continue;
        const v = t[k];
        if (v === null || typeof v !== 'object') o[k] = v;
        else if (Array.isArray(v) && v.length <= 8 && v.every(z => z === null || typeof z !== 'object')) o[k] = v;
      }
      // 负值 = 多少秒之前。与端上的打印同号，读起来是条时间轴，不必在脑子里翻一次。
      return { ago: Math.round((t.t - now) / 100) / 10, ...o };
    }),
  };
})()"""

E_TREE = r"""(() => {
  const p = __uiProbe;
  const s = p.snapshot('tree');
  const rows = (s.components || []).filter(c => __HOSTOK__ || !c.host);
  return { total: (s.components || []).length, rows: rows.filter(c => c.depth <= __DEPTH__) };
})()"""

E_SNAP = r"""(async () => {
  const p = __uiProbe;
  const s = p.snapshot(__LABEL__);
  const r = await p.send(__LABEL__);
  return { ok: r.ok, file: r.file || null, bytes: r.bytes || 0, error: r.error || null,
           build: s.build, id: s.id, at: s.at,
           problems: (s.problems || []).length,
           codes: (s.problems || []).map(x => x.code) };
})()"""

E_STATUS = r"""(() => {
  const p = __uiProbe;
  const s = p.snapshot('status');
  return {
    build: s.build, id: s.id, at: s.at,
    url: s.page.url, title: s.page.title,
    vp: [s.page.viewport.w, s.page.viewport.h],
    dockW: s.page.body.dockW,
    edit: !!(s.host && s.host.edit),
    units: s.host ? s.host.units : null,
    blocks: (s.dock ? s.dock.rows.filter(r => r.kind === 'b').length : null),
    problems: (s.problems || []).length,
    trace: (s.trace || []).length,
  };
})()"""


# ── 工具实现 ────────────────────────────────────────────────────────────────
def tool_status(_args: dict):
    client, ss = live.resolve()
    build = client.build().get('build') or {}
    page = None
    err = None
    if ss:
        try:
            r = client.eval(E_STATUS, 12)
            if r.get('ok'):
                page = r.get('value')
            else:
                err = r.get('error')
        except Exception as e:  # 页面在，但这条表达式没回来
            err = str(e)

    lines = []
    if ss:
        s0 = ss[0]
        lines.append('通道   %s  ·  %d 个页面接着' % (client.base, len(ss)))
        lines.append('页面   %s  ·  build %s · 视口 %s'
                     % (s0.get('url') or '?', s0.get('build') or '?', s0.get('vp') or '?'))
        lines.append('心跳   %ss 前' % s0.get('age'))
    else:
        lines.append('通道   %s（听得懂巡检话，但**没有页面接上来**）' % client.base)
        lines.append('页面   —')
    if build:
        lines.append('产物   bundle %s · newestSrc %s · %s'
                     % (build.get('bundleAt') or '?', build.get('newestSrc') or '?',
                        '旧了，需重新构建' if build.get('stale') else '是新的'))
    if page:
        lines.append('')
        lines.append('dock   %s' % (page.get('dockW'),))
        lines.append('编辑态 %s · 单元 %s · 块 %s · 问题 %s · 轨迹 %s'
                     % ('开' if page.get('edit') else '关', page.get('units'),
                        page.get('blocks'), page.get('problems'), page.get('trace')))
    if err:
        lines.append('')
        lines.append('注意：页面在，但读状态失败 —— %s' % err)
    if not ss:
        lines.append('')
        lines.append('要让页面接上来：确认它加载的是新构建的产物，然后在那个标签页刷新一次。')
    return '\n'.join(lines), {'base': client.base, 'sessions': ss, 'build': build, 'page': page}


def tool_layout(_args: dict):
    client, _ss = connect()
    r = client.eval(E_LAYOUT, 20)
    if not r.get('ok'):
        raise ToolError('读布局失败：%s' % r.get('error'))
    v = r.get('value') or {}

    out = []
    out.append('build %s · 视口 %s×%s · dock %s'
               % (v.get('build'), (v.get('vp') or ['?', '?'])[0], (v.get('vp') or ['?', '?'])[1],
                  v.get('dockW')))
    out.append('布局   %s' % v.get('outline'))

    blocks = v.get('blocks') or []
    if blocks:
        out.append('')
        out.append(pad('块', 16) + pad('轴向', 6) + pad('声明', 7, True) + pad('显示', 7, True)
                   + pad('差', 7, True) + '  ' + pad('flex', 12) + '中心指针落在')
        for b in blocks:
            d = b.get('declared')
            r = b.get('rendered')
            axis = {'v': '高', 'h': '宽'}.get(b.get('axis'), '—')
            delta = None if (d is None or r is None) else r - d
            # 虚线框：模型里有、DOM 里没画出来（折叠的空巢），这种"没有尺寸"不是 bug，是没显示
            name = b.get('block') if b.get('drawn', True) else (b.get('block') or '?') + '（未显示）'
            out.append(pad(name, 16) + pad(axis, 6)
                       + pad('自由' if d is None else num(d), 7, True)
                       + pad(num(r), 7, True)
                       + pad('—' if delta is None else ('%+d' % delta), 7, True) + '  '
                       + pad(b.get('flex'), 12) + (b.get('hit') or ''))

    hs = v.get('handles') or []
    out.append('')
    if hs:
        out.append('把手')
        for i, h in enumerate(hs):
            flag = '可达' if h.get('reachable') else '✗ 被盖 → ' + str(h.get('hit'))
            out.append('  #%d %-14s ┃ %-14s @%s,%s %s×%s  %s  %s'
                       % (i, h.get('prev') or '-', h.get('next') or '-',
                          (h.get('at') or {}).get('x'), (h.get('at') or {}).get('y'),
                          (h.get('size') or {}).get('w'), (h.get('size') or {}).get('h'),
                          flag, h.get('cursor')))
    else:
        out.append('把手  —— 一条都没有（这个布局里没有可拖的边界）')

    ps = v.get('problems') or []
    out.append('')
    out.append('问题 %d 条' % len(ps))
    for p in ps:
        out.append('  [%s] %-26s %s' % (p.get('level'), p.get('code'), p.get('where')))
        for chunk in str(p.get('message') or '').split('\n'):
            out.append('        ' + chunk)
        out.append('        证据 ' + json.dumps(p.get('n') or {}, ensure_ascii=False))

    # 只用数据说话：这几条都能直接对上"拖不动"的两种成因
    dead = [h for h in hs if not h.get('reachable')]
    zeros = [b for b in blocks if not b.get('w') or not b.get('h')]
    if dead:
        out.append('')
        out.append('→ %d 条把手上指针落不到把手本身，拖它们不会有反应。' % len(dead))
    if zeros:
        out.append('→ %d 个块面积为 0。' % len(zeros))
    return '\n'.join(out), v


def tool_element(args: dict):
    sel = str(args.get('selector') or '').strip()
    if not sel:
        raise ToolError('要给一个 CSS 选择器（例如 ".dock-split"、"[data-dock-block=\\"staging\\"]" 或 "#app"）。')
    styles = args.get('styles')
    if not styles:
        styles = ['display', 'position', 'flex', 'flex-basis', 'flex-grow', 'flex-shrink',
                  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
                  'box-sizing', 'padding', 'margin', 'overflow', 'overflow-x', 'overflow-y',
                  'z-index', 'pointer-events', 'order', 'align-self', 'gap', 'transform']
    expr = (E_ELEMENT
            .replace('__SEL__', json.dumps(sel))
            .replace('__STYLES__', json.dumps(list(styles))))
    client, _ss = connect()
    r = client.eval(expr, 15)
    if not r.get('ok'):
        raise ToolError('查询失败：%s' % r.get('error'))
    v = r.get('value') or {}
    if not v.get('found'):
        near = v.get('near') or []
        raise ToolError('没有元素匹配 `%s`。%s'
                        % (sel, ('\n附近相近的有：\n  ' + '\n  '.join(near)) if near else ''))

    box = v.get('box') or {}
    hit = v.get('hit') or {}
    out = ['元素   %s' % v.get('el'),
           '选择器 %s' % sel,
           '盒子   x=%s y=%s w=%s h=%s' % (box.get('x'), box.get('y'), box.get('w'), box.get('h')),
           '指针   中心 (%s,%s) 落在 %s%s'
           % (hit.get('at', ['?', '?'])[0], hit.get('at', ['?', '?'])[1], hit.get('on'),
              '' if hit.get('self') else '   ← 不是它自己'),
           '内容   scroll %s×%s / client %s×%s'
           % ((v.get('scroll') or {}).get('w'), (v.get('scroll') or {}).get('h'),
              (v.get('scroll') or {}).get('cw'), (v.get('scroll') or {}).get('ch'))]
    st = v.get('styles') or {}
    interesting = {k: val for k, val in st.items() if val not in ('', 'auto', 'normal', 'none', '0px')}
    if interesting:
        out.append('样式   ' + '  '.join('%s:%s' % (k, val) for k, val in interesting.items()))
    attrs = v.get('attrs') or {}
    if attrs:
        out.append('属性   ' + '  '.join('%s=%s' % (k, val) for k, val in attrs.items()))
    kids = v.get('kids') or []
    if kids:
        out.append('子元素 %d 个' % v.get('kidCount'))
        for k in kids:
            out.append('         %-44s %s×%s' % (k.get('el'), k.get('w'), k.get('h')))
    chain = v.get('chain') or []
    if chain:
        out.append('祖先   ' + ' < '.join(chain))
    if v.get('text'):
        out.append('文本   %s' % v.get('text').replace('\n', ' ')[:160])
    return '\n'.join(out), v


def tool_drag(args: dict):
    name = str(args.get('block') or '').strip()
    if not name:
        raise ToolError('要指定拖哪一个块旁边的把手（block 名字，见 ui_layout 里那一列）。')
    dx = float(args.get('dx', -120))
    dy = float(args.get('dy', 0))
    side = str(args.get('side') or 'auto')
    if side not in ('auto', 'left', 'right'):
        raise ToolError('side 只能是 auto / left / right。')
    expr = (E_DRAG
            .replace('__NAME__', json.dumps(name))
            .replace('__DX__', repr(dx)).replace('__DY__', repr(dy))
            .replace('__SIDE__', json.dumps(side)))
    client, _ss = connect()
    r = client.eval(expr, 30)
    if not r.get('ok'):
        raise ToolError('拖拽失败：%s' % r.get('error'))
    v = r.get('value') or {}
    if not v.get('ok'):
        hs = v.get('handles') or []
        raise ToolError('%s\n现有把手：\n  %s' % (
            v.get('error'),
            '\n  '.join('%s ┃ %s @%s,%s' % (h.get('prev'), h.get('next'),
                                            (h.get('at') or {}).get('x'), (h.get('at') or {}).get('y'))
                        for h in hs)))

    h = v.get('handle') or {}
    out = ['把手   %s ┃ %s @%s,%s  指针落在 %s%s'
           % (h.get('prev'), h.get('next'),
              (h.get('at') or {}).get('x'), (h.get('at') or {}).get('y'),
              h.get('hit') or '?',
              '' if h.get('reachable') else '   ← 不是把手本身，事件不会交给它'),
           '拖动   dx=%s dy=%s → 实际落在 %s' % (num(dx), num(dy), (v.get('hit') or {}).get('on')),
           '宽度   %s → %s  (%s)'
           % (num(v.get('before')), num(v.get('after')),
              ('%+d' % ((v.get('after') or 0) - (v.get('before') or 0)))
              if v.get('before') is not None and v.get('after') is not None else '—')]
    notes = v.get('notes') or []
    for n in notes:
        out.append('轨迹   a=%s b=%s floor=%s lo=%s hi=%s pointer=%s pointerMax=%s '
                   'moved=%s commits=%s noops=%s'
                   % (n.get('a'), n.get('b'), n.get('floor'), n.get('lo'), n.get('hi'),
                      n.get('pointer'), n.get('pointerMax'), n.get('moved'),
                      n.get('commits'), n.get('noops')))
    if not notes:
        out.append('轨迹   （没有 drag 记录 —— 指针根本没进到把手，看上一条"指针落在"）')
    elif all((n.get('moved') in (0, None)) for n in notes):
        out.append('轨迹   （指针进去了，但边界一步没动：被夹在 lo–hi 里，hi==a 或 lo==a）')
    allb = v.get('all') or []
    if allb:
        out.append('全宽   ' + '  '.join('%s:%s' % (b.get('block'), b.get('w')) for b in allb))
    out.append('问题   %s → %s' % ((v.get('problems') or ['?', '?'])[0],
                                   (v.get('problems') or ['?', '?'])[1]))
    return '\n'.join(out), v


def tool_trace(args: dict):
    kind = args.get('kind')
    try:
        limit = max(1, min(int(args.get('limit') or 30), 240))
    except (TypeError, ValueError):
        limit = 30
    expr = (E_TRACE
            .replace('__KIND__', json.dumps(kind) if kind else 'null')
            .replace('__LIMIT__', str(limit)))
    client, _ss = connect()
    r = client.eval(expr, 15)
    if not r.get('ok'):
        raise ToolError('读轨迹失败：%s' % r.get('error'))
    v = r.get('value') or {}
    rows = v.get('rows') or []
    if not rows:
        return ('轨迹里没有%s记录（共 %s 条）。'
                % ('「%s」' % kind if kind else '', v.get('total')), v)
    out = ['最近 %d 条（共 %s 条）' % (len(rows), v.get('total'))]
    for t in rows:
        # 只读不改：structuredContent 要原样交回去，文本是它的另一种看法。
        # （早先这里用 pop 取字段，结果调用方拿到的事件里 kind/ago 全没了 —— 数据被"打印"吃掉了。）
        ago = t.get('ago')
        body = ' '.join('%s=%s' % (kk, vv) for kk, vv in t.items()
                        if kk not in ('ago', 'kind', 'mark'))
        out.append('  %7ss  %-14s%s  %s'
                   % (num(ago if ago is not None else 0), t.get('kind', '?'),
                      ' ★' if t.get('mark') else '', body[:400]))
    return '\n'.join(out), v


def tool_tree(args: dict):
    try:
        depth = max(0, min(int(args.get('maxDepth') or 40), 80))
    except (TypeError, ValueError):
        depth = 40
    host = bool(args.get('host'))
    expr = (E_TREE
            .replace('__HOSTOK__', 'true' if host else 'false')
            .replace('__DEPTH__', str(depth)))
    client, _ss = connect()
    r = client.eval(expr, 20)
    if not r.get('ok'):
        raise ToolError('读组件树失败：%s' % r.get('error'))
    v = r.get('value') or {}
    rows = v.get('rows') or []
    if not rows:
        raise ToolError('组件树是空的 —— 页面可能不是 React 渲染的，或 fiber 挂载点没找到。')
    out = ['组件树 %d 行（共 %s 行）%s' % (len(rows), v.get('total'), '' if host else ' · 已滤掉原生标签')]
    for c in rows:
        d = c.get('depth') or 0
        out.append('  ' + '  ' * d + str(c.get('name'))
                   + ('  key=' + str(c.get('key')) if c.get('key') else '')
                   + ('  ' + str(c.get('props')) if c.get('props') else ''))
    return '\n'.join(out), v


def tool_eval(args: dict):
    expr = args.get('expr')
    if not expr or not str(expr).strip():
        raise ToolError('要给一行表达式。它在**你的页面**里跑，能拿到 __uiProbe、document、window 等一切。')
    try:
        timeout = float(args.get('timeout') or 20)
    except (TypeError, ValueError):
        timeout = 20.0
    client, _ss = connect()
    r = client.eval(str(expr), timeout)
    text = json.dumps(r.get('value'), ensure_ascii=False, indent=1)
    if not r.get('ok'):
        raise ToolError('页面里报错：\n%s' % r.get('error'))
    if len(text) > 20000:
        text = text[:20000] + '\n…（截断，原长 %d 字符）' % len(text)
    return '返回\n' + text, {'value': r.get('value')}


def tool_snapshot(args: dict):
    label = str(args.get('label') or 'mcp')
    expr = E_SNAP.replace('__LABEL__', json.dumps(label))
    client, _ss = connect()
    r = client.eval(expr, 40)
    if not r.get('ok'):
        raise ToolError('抓快照失败：%s' % r.get('error'))
    v = r.get('value') or {}
    if not v.get('ok'):
        raise ToolError('页面抓到了，但送不出去：%s\n（可以退回 ui_eval 直接读，或用页面的"下载 JSON"。）'
                        % v.get('error'))
    out = ['存档   %s（%sKB）' % (v.get('file'), round((v.get('bytes') or 0) / 1024)),
           '目录   %s' % ups.DIR,
           'build  %s' % v.get('build'),
           '问题   %s 条%s' % (v.get('problems'),
                              ('：' + ', '.join(sorted(set(v.get('codes') or [])))) if v.get('codes') else '')]
    return '\n'.join(out), v


# ── 工具表 ──────────────────────────────────────────────────────────────────
_EMPTY = {'type': 'object', 'properties': {}, 'additionalProperties': False}

TOOLS = [
    {
        'name': 'ui_status',
        'description': '看界面探针通道和页面的连接状态：有哪些页面接着、页面 build、产物是不是旧的、'
                       '编辑态与单元数。判定"读不到现场"卡在哪一环时先跑这个。',
        'inputSchema': _EMPTY,
        'fn': tool_status,
    },
    {
        'name': 'ui_layout',
        'description': '读当前布局的全景（一次取全）：每个块的声明尺寸/实际渲染尺寸/flex/内容溢出、'
                       '每条拖拽把手的坐标与**指针实际落在谁身上**（能否拖动）、以及探针自己跑出的不变量问题清单。'
                       '排查"某块缩不小/拖不动/显示和预期不一样"时先跑这个。',
        'inputSchema': _EMPTY,
        'fn': tool_layout,
    },
    {
        'name': 'ui_element',
        'description': '查一个 CSS 选择器对应的元素事实：盒子、计算样式、data-* 属性、内容溢出、'
                       '中心点指针命中谁、子元素、祖先链。用来确认"我以为在拖的那个东西"到底是哪个元素。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'selector': {'type': 'string', 'description': 'CSS 选择器，例如 ".dock-split" 或 "[data-dock-block=\\"staging\\"]"'},
                'styles': {'type': 'array', 'items': {'type': 'string'},
                           'description': '要读的计算样式属性名（可选，默认一组与布局相关的）'},
            },
            'required': ['selector'],
            'additionalProperties': False,
        },
        'fn': tool_element,
    },
    {
        'name': 'ui_drag',
        'description': '在活页面里**真的拖一次**把手（合成 PointerEvent，走同一条 React 处理路径），'
                       '返回前后宽度、指针实际落点、以及探针记下的 a/b/floor/lo/hi/pointer/moved/commits/noops。'
                       '这是区分"指针没进把手"和"边界被夹死"的唯一证据来源。会改变布局，属显式动作。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'block': {'type': 'string', 'description': '拖哪个块旁边的把手（块名，见 ui_layout 的"块"列）'},
                'dx': {'type': 'number', 'description': '水平位移像素，负=左（缩小该块），默认 -120'},
                'dy': {'type': 'number', 'description': '垂直位移像素，默认 0'},
                'side': {'type': 'string', 'enum': ['auto', 'left', 'right'],
                         'description': '拖该块的哪一侧把手；auto 先找右侧再找左侧'},
            },
            'required': ['block'],
            'additionalProperties': False,
        },
        'fn': tool_drag,
    },
    {
        'name': 'ui_trace',
        'description': '读最近的操作轨迹：拖拽的 down/move/up、投放、模式切换、报错、resize。'
                       '用户说"刚才那样操作"之后，轨迹里通常就有那几下。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'kind': {'type': 'string', 'description': '只取某一类，如 drag / drop / block.mode / error / resize'},
                'limit': {'type': 'integer', 'description': '最多取几条（默认 30，上限 240）'},
            },
            'additionalProperties': False,
        },
        'fn': tool_trace,
    },
    {
        'name': 'ui_tree',
        'description': '读 React 组件层级（走 fiber）：深度、组件名、key、props 形状。'
                       '用来定位"问题出在哪一层组件"，而不是只知道是哪块 DOM。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'maxDepth': {'type': 'integer', 'description': '最大深度（默认 40）'},
                'host': {'type': 'boolean', 'description': '是否包含原生 DOM 标签（默认 false）'},
            },
            'additionalProperties': False,
        },
        'fn': tool_tree,
    },
    {
        'name': 'ui_eval',
        'description': '逃生口：在**用户当前这个页面**里直接跑一行表达式并拿回值，等价于在 F12 控制台敲一行。'
                       '可以访问 __uiProbe（含 q/rect/desc/handles/blocks/drag/snapshot/trace）与 document/window。'
                       '其它工具都是它的预设；遇到没被预设覆盖的问题就用它。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'expr': {'type': 'string', 'description': '要执行的表达式，支持顶层 await，返回值会被 JSON 序列化'},
                'timeout': {'type': 'number', 'description': '等页面回传的秒数，默认 20'},
            },
            'required': ['expr'],
            'additionalProperties': False,
        },
        'fn': tool_eval,
    },
    {
        'name': 'ui_snapshot',
        'description': '抓一份完整快照并落盘（temporary/ui_probe/<id>.json + 一份人能读的 .md）。'
                       '用于留证、对比、或把现场交给不在线的人看。',
        'inputSchema': {
            'type': 'object',
            'properties': {'label': {'type': 'string', 'description': '给这份快照一个标签，默认 mcp'}},
            'additionalProperties': False,
        },
        'fn': tool_snapshot,
    },
]

_BY_NAME = {t['name']: t for t in TOOLS}
_SCHEMAS = [{k: v for k, v in t.items() if k != 'fn'} for t in TOOLS]


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


def call_tool(name, arguments):
    t = _BY_NAME.get(name)
    if t is None:
        raise ToolError('没有这个工具：%s（有：%s）' % (name, ', '.join(_BY_NAME)))
    try:
        text, structured = t['fn'](arguments or {})
    except ToolError as e:
        return {'content': [{'type': 'text', 'text': '✗ ' + str(e)}], 'isError': True}
    except Exception as e:
        log('[ui-probe-mcp] tool %s crashed:\n%s' % (name, traceback.format_exc()))
        return {'content': [{'type': 'text', 'text': '✗ 工具内部出错：%s' % e}], 'isError': True}
    res = {'content': [{'type': 'text', 'text': text}], 'isError': False}
    if isinstance(structured, (dict, list)):
        res['structuredContent'] = structured
    return res


def handle(msg):
    mid = msg.get('id')
    method = msg.get('method')
    params = msg.get('params') or {}

    if method is None:
        return  # 客户端对我们发过去的东西的回应（我们不主动发请求），忽略
    if mid is None:  # 通知：不回应
        if method == 'notifications/initialized':
            log('[ui-probe-mcp] client ready')
        return

    if method == 'initialize':
        want = str(params.get('protocolVersion') or '')
        pv = want if want in PROTOCOLS else PROTOCOLS[0]
        ok(mid, {
            'protocolVersion': pv,
            'capabilities': {'tools': {'listChanged': False}},
            'serverInfo': {'name': SERVER_NAME, 'version': SERVER_VERSION},
            'instructions': (
                '这是 Kolid blend 编辑器的界面探针：工具直接读**用户当前打开的那个页面**的实时状态'
                '（布局几何、把手可达性、操作轨迹、组件层级），不依赖任何快照或用户粘贴。'
                '排查 UI 问题时的顺序：ui_status 看连接 → ui_layout 看全景与不变量 → '
                '需要时用 ui_element 定位元素、ui_drag 实测拖拽、ui_trace 看刚才发生了什么、'
                'ui_tree 定位组件层。读不到就照实说读不到，不要凭猜测补数据。'),
        })
        return
    if method == 'ping':
        ok(mid, {})
        return
    if method == 'tools/list':
        ok(mid, {'tools': _SCHEMAS})
        return
    if method == 'tools/call':
        ok(mid, call_tool(str(params.get('name') or ''), params.get('arguments') or {}))
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
    # 关键一步：把真正的 stdout 私藏起来，再让 fd 1 指向 stderr。
    # 于是任何 print（包括第三方库的）都不会插进 JSON-RPC 的流里。
    real = os.dup(1)
    os.dup2(2, 1)
    _out = os.fdopen(real, 'wb', 0)

    srv = live.start_background(live.DEFAULT_PORT)
    log('[ui-probe-mcp] channel %s · storage %s'
        % ('hosted at %s' % live.SINK if srv else 'already running', ups.DIR))

    for line in sys.stdin.buffer:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line.decode('utf-8', 'replace'))
        except Exception as e:
            log('[ui-probe-mcp] bad json: %s' % e)
            continue
        if isinstance(msg, list):
            for m in msg:
                threading.Thread(target=handle, args=(m,), daemon=True).start()
            continue
        # 一条请求一个线程：ui_drag 要等页面跑完（可能几秒），不该把 ping 堵在后面。
        threading.Thread(target=handle, args=(msg,), daemon=True).start()

    log('[ui-probe-mcp] stdin closed, bye')
    if srv:
        srv.shutdown()


if __name__ == '__main__':
    main()
