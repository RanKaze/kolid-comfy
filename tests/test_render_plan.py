#!/usr/bin/env python3
"""RenderPlan 编译器的回归测试（P1）。

不依赖 comfy/torch：直接按路径加载 `nodes/workbench/render_plan.py`
（`nodes/workbench/__init__.py` 会 import 一堆 comfy 的东西，不能走包导入）。

跑：
    python tests/test_render_plan.py

两段：
  A. 结构断言 —— 编译器自己该守的规矩（顺序、capture、资源、时间表）。
  B. 与 golden 的 raw 捕获交叉核对 —— 同一图层集，编译器产出的 strip 必须与
     页面当时的活对象一字不差（这就是"编译器忠实"的定义）。
"""
import glob
import importlib.util
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CUD = os.environ.get('KOLID_GOLDEN_CUD', r'F:\Pathes\Pictures\RanKaze\AI修改\视频测试.cud')


def load_module():
    p = os.path.join(ROOT, 'nodes', 'workbench', 'render_plan.py')
    spec = importlib.util.spec_from_file_location('kolid_render_plan', p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def check(cond, msg, fails):
    if not cond:
        fails.append(msg)


def main():
    fails = []
    rp = load_module()

    # ── A. 结构断言（**对着文件自身**验，不写死任何快照值）──────────────────────
    # 这一段的规矩：编译器必须"忠实于文件"—— 层序、capture、strip 次序、transform、资源表，
    # 逐条都能从 .cud 的原始行推出来。写死名字/数值的旧版本会随文档改动失效（历史上就这么失效过），
    # 所以这里一律从 doc 里取期望值。
    doc = rp.read_cud(CUD)
    sets = doc['head'].get('layerSets') or []
    key = (sets[0].get('key') if isinstance(sets, list) and sets else None)
    plan = rp.compile_plan(doc, key=key)

    check(plan['v'] == 1, 'plan.v 应为 1', fails)
    gw = (doc['head'].get('canvas') or {}).get('w')
    gh = (doc['head'].get('canvas') or {}).get('h')
    check(plan['grid'] == {'w': gw, 'h': gh}, f"grid 与文件画布不一致：{plan['grid']} vs {gw}x{gh}", fails)
    check(plan['color']['out'] == 'srgb', 'color.out 应为 srgb', fails)

    raw = (next((s.get('layers') for s in sets if s.get('key') == key), None)
           if isinstance(sets, list) else None) or doc['head'].get('layers') or []
    check(len(plan['layers']) == len(raw),
          f"层数应与文件一致：plan {len(plan['layers'])} / raw {len(raw)}", fails)
    # .cud 的 layers[0] 是最上面那层；plan 必须自底向上
    check([l['name'] for l in plan['layers']] == [r.get('name') for r in reversed(raw)],
          'layers 必须自底向上（plan 与反转后的 raw 对不上）', fails)

    table = rp._attrs_table(doc['head'])
    by_id = {l['id']: l for l in plan['layers']}
    for row in raw:
        pl = by_id.get(row.get('id'))
        check(pl is not None, f"图层 {row.get('id')} 没进 plan", fails)
        if pl is None:
            continue
        # Stash 的输入是"以下所有层"，别的层没有 capture
        check(pl['capture'] == ('below' if row.get('stash') else None),
              f"{pl['name']}: capture 该是 {'below' if row.get('stash') else None}", fails)
        check(pl['visible'] == (row.get('visible') is not False), f"{pl['name']}: visible 不对", fails)
        check(pl['stack'] == ('guidance' if row.get('stack') == 'guidance' else 'work'),
              f"{pl['name']}: stack 映射不对：{pl['stack']}", fails)
        tr = row.get('transform') or {}
        for f in ('cx', 'cy', 'w', 'h', 'rotation'):
            check(abs(pl['transform'][f] - float(tr.get(f, {'cx': .5, 'cy': .5, 'w': 1, 'h': 1, 'rotation': 0}[f]))) < 1e-9,
                  f"{pl['name']}: transform.{f} 不对", fails)
        # strip 次序 = 属性的引用次序；停用的那一步 enabled 必须是 false
        want = []
        for a in row.get('attrs') or []:
            rec = table.get(a) if isinstance(a, str) else a
            if not rec or not rec.get('type'):
                continue
            want.append((rec['type'], rec.get('enabled') is not False))
        got = [(s['type'], s.get('enabled') is not False) for s in pl['strip']]
        check(want == got, f"{pl['name']}: strip 与文件属性不一致\n want={want}\n got={got}", fails)
        for s in pl['strip']:
            ref = (s.get('surface') or s.get('baked') or {}).get('resource')
            if ref:
                check(ref.startswith('res:'), f"{pl['name']}: 资源 id 该是 res:<hash>：{ref}", fails)
                ids = {r['id']: r for r in plan['resources']}
                check(ref in ids, f"{pl['name']}: {ref} 没进 resources 表", fails)
                check(ids[ref]['uri'].startswith('inline:'), f"{pl['name']}: 内嵌资源应是 inline:", fails)
        tm = pl['timeMap']
        if tm:
            check(tm['clipId'] == key, f"{pl['name']}: timeMap.clipId 应指向图层段自己", fails)

    check(all(t['kind'] == 'video' for t in plan['tracks']), 'tracks 里只该有视频轨（音频 P1 不管）', fails)

    # ── B. 与 golden 的 raw 捕获交叉核对 ────────────────────────────────────
    raws = glob.glob(os.path.join(ROOT, 'tests', 'golden', 'vid', '*', 'plan.json'))
    cross = 0
    for rp_path in raws:
        raw = json.load(open(rp_path, encoding='utf-8'))
        if raw.get('key') != key:
            continue
        cross += 1
        raw_layers = list(reversed(raw['layers']))      # raw 首=最上 ⇒ 反转对齐
        check([l['name'] for l in raw_layers] == names,
              f"{os.path.basename(os.path.dirname(rp_path))}: 层序与 raw 不一致", fails)
        for a, b in zip(raw_layers, plan['layers']):
            raw_types = [x['type'] for x in (a.get('attrs') or [])]
            plan_types = [s['type'] for s in b['strip']]
            check(raw_types == plan_types, f"{b['name']}: strip 类型 {plan_types} != raw {raw_types}", fails)
            check(abs(a['transform']['cx'] - b['transform']['cx']) < 1e-9
                  and abs(a['transform']['rotation'] - b['transform']['rotation']) < 1e-9,
                  f"{b['name']}: transform 不一致", fails)
            # effects 的 params 逐字比
            raw_eff = next((x for x in (a.get('attrs') or []) if x['type'] == 'effects'), None)
            plan_eff = next((s for s in b['strip'] if s['type'] == 'effects'), None)
            if raw_eff and plan_eff:
                rp_list = [{k: e.get(k) for k in ('type', 'enabled', 'params')} for e in raw_eff.get('chain') or []]
                pp_list = [{k: e.get(k) for k in ('type', 'enabled', 'params')} for e in plan_eff['chain']]
                check(rp_list == pp_list, f"{b['name']}: effects 与 raw 不一致\n raw={rp_list}\n plan={pp_list}", fails)

    if not raws:
        print('（没有 golden，跳过 B 段）')
    elif not cross:
        print('（golden 里没有同一图层集的捕获，跳过 B 段）')

    if fails:
        print('FAIL %d 项：' % len(fails))
        for f in fails:
            print('  - ' + f)
        return 1
    print(f'OK  编译断言 {6} 组，交叉核对 {cross} 份 raw 捕获')
    return 0


if __name__ == '__main__':
    sys.exit(main())
