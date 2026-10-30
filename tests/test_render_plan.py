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

    # ── C. 图层盒：老文件的那一格像素现在补成 strip 最左那一枚 image ──────────────
    # 今天这一层自己的图就是条带上 `role:'base'` 那一步，plan 里不再有"单独铺的底"（`base` 恒 null）。
    # 只有**完全没有条带记录**的老文件要补：像素还住在 `box.base.image` / `box.images[0]` / `image`
    # 里，不补那一层会整层不出现。四条规矩：新形状优先、上一版照旧、老形状照旧、空盒不补。
    def _mkdoc(layer):
        return {'path': '<synthetic>', 'blob': b'',
                'head': {'canvas': {'w': 64, 'h': 32}, 'layers': [layer]},
                # 键的类型跟 read_cud 一致：JSON 里的 id 是数字，字典也就按数字索引。
                'assets': {0: {'id': 0, 'role': 'image', 'md5': 'a' * 32},
                           1: {'id': 1, 'role': 'image', 'md5': 'b' * 32}}}

    def _layer0(doc):
        return rp.compile_plan(doc)['layers'][0]

    def _first_image(layer):
        return next((s for s in layer['strip'] if s.get('type') == 'image'), None)

    boxed = _mkdoc({'id': 7, 'name': 'boxed', 'image': 1,
                    'box': {'id': 'box_1', 'grid': {'w': 48, 'h': 24},
                            'base': {'id': 'base', 'type': 'image', 'role': 'base', 'image': 0}}})
    lb = _layer0(boxed)
    check(lb['base'] is None, f"plan 不再有单独铺的底，实得 {lb['base']}", fails)
    check(_first_image(lb) is not None
          and _first_image(lb)['surface']['resource'] == 'res:' + 'a' * 32,
          f"新形状：那一格必须变成 strip 最左那枚 image，实得 {lb['strip']}", fails)

    # 上一版的写法：盒里是一个长度恒为 1 的"列表"。旧文件读回来必须还是同一张底图。
    prev = _mkdoc({'id': 10, 'name': 'prev', 'image': 1,
                   'box': {'id': 'box_3', 'grid': {'w': 48, 'h': 24},
                           'images': [{'id': 0, 'type': 'image', 'role': 'base', 'image': 0}]}})
    lp = _layer0(prev)
    check(_first_image(lp) is not None
          and _first_image(lp)['surface']['resource'] == 'res:' + 'a' * 32,
          f"上一版（box.images[0]）：底图必须照旧读出来，实得 {lp['strip']}", fails)

    legacy = _mkdoc({'id': 8, 'name': 'legacy', 'image': 1})
    ll = _layer0(legacy)
    check(_first_image(ll) is not None
          and _first_image(ll)['surface']['resource'] == 'res:' + 'b' * 32,
          f"老档（没有 box）：底图仍从 image 读，实得 {ll['strip']}", fails)

    empty = _mkdoc({'id': 9, 'name': 'empty', 'image': None,
                    'box': {'id': 'box_2', 'grid': {'w': 12, 'h': 6},
                            'base': {'id': 'base', 'type': 'image', 'role': 'base', 'image': None}}})
    le = _layer0(empty)
    check(le['strip'] == [], f"空盒：不该补出任何 image 步，实得 {le['strip']}", fails)

    # ── D. 底位就是条带上普通的一步（位置真的算数）──────────────────────────────
    # 图层不自带图片：这一层自己的图是条带上的一枚 attribute。以前它被单独交给 `base`，于是必须恒在最左，
    # 拖到哪都一样（UI 上看着动了，画面没动）；现在它在 strip 自己的位置上，strip 按元组顺序交出去 ——
    # 这一节的三条就是"拖 image attribute 有用"在编译期的证据。
    def _resources(doc):
        return [s.get('surface', {}).get('resource') if s['kind'] == 'surface' else s['type']
                for s in _layer0(doc)['strip']]

    attrbox = _mkdoc({'id': 11, 'name': 'attrbox', 'box': {'id': 'box_4', 'grid': {'w': 48, 'h': 24}},
                      'attrs': [{'id': 'img_a', 'type': 'image', 'role': 'base', 'surface': 0}]})
    la = _layer0(attrbox)
    check(la['base'] is None, f"底位属性：base 必须恒为 null，实得 {la['base']}", fails)
    check(_resources(attrbox) == ['res:' + 'a' * 32],
          f"底位属性：它自己就在 strip 里，实得 {la['strip']}", fails)

    stacked = _mkdoc({'id': 12, 'name': 'stacked',
                      'attrs': [{'id': 'img_b', 'type': 'image', 'role': 'base', 'surface': 0},
                                {'id': 'img_c', 'type': 'image', 'surface': 1}]})
    check(_resources(stacked) == ['res:' + 'a' * 32, 'res:' + 'b' * 32],
          f"底位 + 一枚叠上去的图：顺序照条带来，实得 {_resources(stacked)}", fails)

    # 底位被拖到另一枚 image 右边时，plan 必须原样交出这个顺序（合成器按这个顺序跑）。
    flipped = _mkdoc({'id': 13, 'name': 'flipped',
                      'attrs': [{'id': 'img_d', 'type': 'image', 'surface': 1},
                                {'id': 'img_e', 'type': 'image', 'role': 'base', 'surface': 0}]})
    check(_resources(flipped) == ['res:' + 'b' * 32, 'res:' + 'a' * 32],
          f"底位拖到右边：strip 必须是 [另一枚, 底位]，实得 {_resources(flipped)}", fails)

    # 蒙版在底位之前 = 蒙版跑在还没画出来的图上；这一枚照它自己那个位置说话，不再有"永远先铺底"。
    masked = _mkdoc({'id': 14, 'name': 'masked',
                     'attrs': [{'id': 'm', 'type': 'mask', 'surface': 1},
                               {'id': 'img_f', 'type': 'image', 'role': 'base', 'surface': 0}]})
    check([s['type'] for s in _layer0(masked)['strip']] == ['mask', 'image'],
          f"底位拖到蒙版右边：strip 必须是 [mask, image]，实得 {[s['type'] for s in _layer0(masked)['strip']]}", fails)


    if fails:
        print('FAIL %d 项：' % len(fails))
        for f in fails:
            print('  - ' + f)
        return 1
    print(f'OK  编译断言 6 组 + 图层盒 4 条 + 底位步骤 4 条，交叉核对 {cross} 份 raw 捕获')
    return 0


if __name__ == '__main__':
    sys.exit(main())
