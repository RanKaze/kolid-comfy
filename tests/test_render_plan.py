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

    # ── A. 结构断言 ──────────────────────────────────────────────────────────
    doc = rp.read_cud(CUD)
    key = doc['head']['layerSets'][0]['key'] if isinstance(doc['head'].get('layerSets'), list) else None
    plan = rp.compile_plan(doc, key=key)

    check(plan['v'] == 1, 'plan.v 应为 1', fails)
    check(plan['grid'] == {'w': 832, 'h': 1216}, f"grid 不对：{plan['grid']}", fails)
    check(plan['color']['out'] == 'srgb', 'color.out 应为 srgb', fails)
    check(len(plan['layers']) == 2, f"层数应为 2，实为 {len(plan['layers'])}", fails)

    names = [l['name'] for l in plan['layers']]
    # .cud 里 layers[0] 是最上面那层；plan 必须自底向上
    check(names == ['Layer 1', 'Stash 1'], f'layers 必须自底向上，实为 {names}', fails)

    by = {l['name']: l for l in plan['layers']}
    check(by['Stash 1']['capture'] == 'below', 'Stash 层的 capture 必须是 below', fails)
    check(by['Layer 1']['capture'] is None, '普通层不该有 capture', fails)

    l1 = by['Layer 1']
    check([s['type'] for s in l1['strip']] == ['decal'], f"Layer 1 的 strip 不对：{l1['strip']}", fails)
    check(l1['strip'][0]['frameTrack'] == 'trkmvmi206h100', 'decal 的 frameTrack 丢了', fails)
    check(l1['strip'][0]['surface'] is None, 'decal 靠 frameTrack 取帧，surface 应为 null', fails)

    st = by['Stash 1']
    check([s['type'] for s in st['strip']] == ['effects', 'mask'], f"Stash 1 的 strip 不对：{[s['type'] for s in st['strip']]}", fails)
    eff = st['strip'][0]['chain'][0]
    check(eff['type'] == 'vector_blur', 'vector_blur 丢了', fails)
    check(eff['params'] == {'angle': 77, 'distance': 32, 'anchor': 'center'}, f"params 被动了：{eff['params']}", fails)
    check(eff['enabled'] is True, 'enabled 该是 true', fails)
    mask = st['strip'][1]
    check(mask['kind'] == 'surface' and (mask['surface'] or {}).get('resource', '').startswith('res:'),
          'mask 的 surface 必须编译成 res:<md5>', fails)

    # 资源清单：mask 必须真的在里面，且 uri 是 inline（.cud 内嵌）
    ids = {r['id']: r for r in plan['resources']}
    check(mask['surface']['resource'] in ids, 'mask 的资源没进 resources 表', fails)
    check(ids[mask['surface']['resource']]['uri'].startswith('inline:'), 'mask 资源应是 inline:', fails)

    tm = l1['timeMap']
    check(tm and abs(tm['start'] - 3.815829206924238) < 1e-6, f"timeMap.start 不对：{tm}", fails)
    check(tm and tm['clipId'] == key, 'timeMap.clipId 应指向图层段自己', fails)

    tracks = {t['id']: t for t in plan['tracks']}
    check('trkmvmi206h100' in tracks, '视频轨没进 tracks', fails)
    t2 = tracks['trkmvmi206h100']
    check(t2['resource'] and t2['resource'].startswith('res:'), '视频轨缺资源 id', fails)
    check(len(t2['clips']) == 1 and abs(t2['clips'][0]['start'] - 3.815829206924238) < 1e-6,
          f"视频轨的 clip 时刻表不对：{t2['clips']}", fails)
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
