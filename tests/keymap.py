#!/usr/bin/env python
"""键位表的机械体检 —— 用户能不能真的改到每一条键，靠这几条尺算，不靠人记。

表只有一份：`nodes/web/js/keymap.js`（画布页面直接加载）。宿主从构建产物
（`ui/sampler_node/src/keymap.generated.ts`）读同一条表。于是"漏"只可能有两种：

  · 表里挂了一条命令，但没人判定它（用户改了键，什么也不会发生）；
  · 代码里按名字查了一条命令，但表里没有（`hit` 恒 false，键位静默失效）。

两条都在这查。再加一条"产物有没有落后于表"（构建会自动重写，但有人只改 js 不构建就会）。

  G1 产物同步        `tools/gen_keymap.cjs --check`
  G2 表 → 代码       每个 id 至少被引用一次
  G3 代码 → 表       每个 `hit(…, 'id')` 的 id 都在表里
  G4 默认键不打架    同一 scope 内两条命令的默认键不重复（`shiftAsParam` 忽略 Shift 不算遮盖）

用法：python tests/keymap.py [--strict]
退出码：有 FAIL 即 1（--strict 目前与默认一致，留给将来加报告项）。
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'nodes/web/js/keymap.js')
GEN = os.path.join(ROOT, 'tools/gen_keymap.cjs')
GEN_TS = os.path.join(ROOT, 'ui/sampler_node/src/keymap.generated.ts')

# 谁在使用命令：画布页面（单文件 HTML，走 KB.hit）+ 宿主 TS（走 hit）。
CONSUMERS = [
    os.path.join(ROOT, 'nodes/web/blend_node.html'),
    os.path.join(ROOT, 'ui/sampler_node/src/keybindings.ts'),
    os.path.join(ROOT, 'ui/sampler_node/src/components/EditPhase.tsx'),
    os.path.join(ROOT, 'ui/sampler_node/src/workbench/video/Timeline.tsx'),
    os.path.join(ROOT, 'ui/sampler_node/src/workbench/video/Keyframes.tsx'),
    os.path.join(ROOT, 'ui/sampler_node/src/workbench/video/Assets.tsx'),
]

# `KB.hit(e, 'x')` / `hit(e, 'x')` / `hit(e.nativeEvent, 'x')`
HIT_RE = re.compile(r"""hit\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*'([a-z0-9][a-z0-9.\-]*)'\s*\)""")

fail = []


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def load_table():
    """借生成器自己的求值路径取表（--list 吐 JSON），别在这再写一份解析。"""
    r = subprocess.run(['node', GEN, '--list'], cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        print('  FAIL G0 读表失败：' + (r.stderr or r.stdout).strip()[:400])
        fail.append('G0')
        return []
    return json.loads(r.stdout)


def gate_generated():
    r = subprocess.run(['node', GEN, '--check'], cwd=ROOT, capture_output=True, text=True)
    ok = r.returncode == 0
    print(('  ok   ' if ok else '  FAIL ') + 'G1 产物与键位表同步'
          + ('' if ok else '：' + (r.stderr or r.stdout).strip().splitlines()[0]))
    if not ok:
        fail.append('G1')


def gate_every_id_used(table):
    used = set()
    for path in CONSUMERS:
        if os.path.exists(path):
            used |= set(HIT_RE.findall(read(path)))
    ids = [d['id'] for d in table]
    orphan = [i for i in ids if i not in used]
    ok = not orphan
    print(('  ok   ' if ok else '  FAIL ') + f'G2 表 → 代码：{len(ids) - len(orphan)}/{len(ids)} 条有判定处')
    if orphan:
        print('       表里有、但没人判定的命令（用户改了它不会有任何反应）：' + ', '.join(orphan))
        fail.append('G2')


def gate_no_phantom(table):
    ids = {d['id'] for d in table}
    phantom = {}
    for path in CONSUMERS:
        if not os.path.exists(path):
            continue
        for m in HIT_RE.finditer(read(path)):
            if m.group(1) not in ids:
                phantom.setdefault(m.group(1), set()).add(os.path.relpath(path, ROOT))
    ok = not phantom
    print(('  ok   ' if ok else '  FAIL ') + f'G3 代码 → 表：{len(ids)} 条命令全部登记')
    if phantom:
        for pid, files in sorted(phantom.items()):
            print(f'       代码里查了不存在的命令 {pid!r}（hit 恒 false）：' + ', '.join(sorted(files)))
        fail.append('G3')


def norm(chord, shift_as_param):
    """把 chord 归一成可比较的形状；`shiftAsParam` 的条目把 Shift 抹掉（它不参与判定）。"""
    parts = chord.split('+')
    key = parts.pop()
    ctrl = any(p.lower() in ('ctrl', 'cmd', 'meta', 'command') for p in parts)
    alt = any(p.lower() in ('alt', 'option', 'opt') for p in parts)
    shift = any(p.lower() == 'shift' for p in parts) and not shift_as_param
    return (ctrl, shift, alt, key.lower())


def gate_collisions(table):
    by_scope = {}
    clash = []
    for d in table:
        for chord in d['keys']:
            sig = norm(chord, d.get('shiftAsParam'))
            slot = by_scope.setdefault((d['scope'], sig), [])
            slot.append(f"{d['id']} ({chord})")
    for (scope, _sig), owners in by_scope.items():
        if len(owners) > 1:
            clash.append(f'{scope}: ' + ' = '.join(owners))
    ok = not clash
    print(('  ok   ' if ok else '  FAIL ') + 'G4 同一 scope 内默认键不重复')
    if clash:
        for line in clash:
            print('       ' + line)
        fail.append('G4')


def report_groups(table):
    order = []
    for d in table:
        if d['group'] not in order:
            order.append(d['group'])
    print('\n分组（Key Bindings 屏就是照这个顺序长的）：')
    for g in order:
        rows = [d for d in table if d['group'] == g]
        scopes = sorted({d['scope'] for d in rows})
        print(f'  {g:<11} {len(rows):>2} 条  [{", ".join(scopes)}]')


def main():
    print('键位表体检 —— ')
    table = load_table()
    if not table:
        return 1
    print(f'  共 {len(table)} 条命令，源 {os.path.relpath(SRC, ROOT)}\n')
    gate_generated()
    gate_every_id_used(table)
    gate_no_phantom(table)
    gate_collisions(table)
    report_groups(table)
    print()
    if fail:
        print(f'FAIL（{len(fail)}）：{", ".join(fail)}')
        return 1
    print('全部通过。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
