#!/usr/bin/env python3
"""不变量守卫（P0）：把 docs/render_plan.md §4 的几条按「现状记账」跑出来。

现在**不判失败** —— 现状本来就不满足（要的就是这份清单）。P2/P4 之后逐条归零，
到那时用 --strict 接进 CI，谁把它们加回来就红。

用法：
  python tests/guards.py            # 只报告
  python tests/guards.py --strict   # 有任何命中就退出码 1
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 源码，不含构建产物（nodes/web/sampler_node.html 是 vite 的输出）
SOURCES = [
    'nodes/web/blend_node.html',
    'nodes/web/fx',
    'nodes/web/attr',
    'ui/sampler_node/src',
]

CHECKS = [
    {
        'id': 'I1',
        'name': '只有一个显示面',
        'why': '台上那块不能靠 style.display / visibility 在两张画布之间切',
        'patterns': [r'vidBaseCanvas\.style\.(display|visibility)', r'blendCanvas\.style\.visibility'],
    },
    {
        'id': 'I3',
        'name': '时间只有一个来源',
        'why': '除 Clock 外不许拿 video.currentTime 决定帧时刻（只允许写/seek）',
        'patterns': [r'\.currentTime\b'],
    },
    {
        'id': 'I4',
        'name': '跨线程不传像素',
        'why': '只传 plan 与资源引用；像素传输只允许出现在导出模块',
        'patterns': [r'createImageBitmap\(', r'transferFromImageBitmap\(', r'postMessage\([^)]*\[\s*bmp'],
    },
    {
        'id': 'I5',
        'name': '编辑与播放同一条 draw 序列',
        'why': '两个绘制入口 = 两套语义，迟早对不齐',
        'patterns': [r'^function render\(', r'^function composeVidFrameCanvas\(', r'^function drawLayer\('],
    },
]


def files():
    for s in SOURCES:
        p = os.path.join(ROOT, s)
        if os.path.isfile(p):
            yield p
        elif os.path.isdir(p):
            for dp, _, fns in os.walk(p):
                if 'node_modules' in dp:
                    continue
                for fn in fns:
                    if fn.endswith(('.html', '.js', '.ts', '.tsx')) and not fn.endswith('.min.js'):
                        yield os.path.join(dp, fn)


def scan(pattern):
    rx = re.compile(pattern)
    hits = []
    for p in files():
        try:
            with open(p, encoding='utf-8', errors='ignore') as f:
                for i, line in enumerate(f, 1):
                    if rx.search(line):
                        hits.append((os.path.relpath(p, ROOT), i))
        except OSError:
            continue
    return hits


def main():
    strict = '--strict' in sys.argv
    total = 0
    print('渲染不变量 · 现状记账（基线）\n' + '=' * 62)
    for c in CHECKS:
        hits = []
        for pat in c['patterns']:
            hits.extend(scan(pat))
        hits = sorted(set(hits))
        total += len(hits)
        head = f"{c['id']} {c['name']} — {len(hits)} 处"
        print('\n' + head)
        print('   ' + c['why'])
        by_file = {}
        for f, ln in hits:
            by_file.setdefault(f, []).append(ln)
        for f, lns in sorted(by_file.items(), key=lambda kv: -len(kv[1]))[:6]:
            shown = ','.join(str(x) for x in lns[:8]) + ('…' if len(lns) > 8 else '')
            print(f'   {len(lns):4d}  {f}  [{shown}]')
        if len(by_file) > 6:
            print(f'        … 另 {len(by_file) - 6} 个文件')
    print('\n' + '=' * 62)
    print(f'合计 {total} 处。目标：P2 之后 I1/I3/I4 归零，P4 之后 I5 只剩一个入口。')
    if strict and total:
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
