"""RenderPlan 编译器：`.cud` → RenderPlan（P1）。

只做**编译**，不碰像素、不需要 torch/comfy —— 导出、离线、测试都能用同一份。
契约见 `docs/render_plan.md`；这里是它的唯一实现，改契约先改文档。

用法：
    python nodes/workbench/render_plan.py "F:\\x.cud" --out=plan.json
    python nodes/workbench/render_plan.py "F:\\x.cud" --set=<layerSetKey> --stats

三条硬规矩（别在下游再补）：
  1. `layers` 输出**自底向上**（.cud 里 `layers[0]` 是最上面那层 ⇒ 这里反转）。
  2. `params` / `desc` **不展开语义**，原样带走 —— 解释权在 `fx/*.js` 与 `attr/*.js` 的注册表。
  3. 图层像素只剩 `res:<md5>`；plan 里不出现任何字节。
"""
from __future__ import annotations

import hashlib
import json
import os
import struct
import sys

CUD_MAGIC = b'CUD1'
PLAN_VERSION = 1

# .cud 的 stack 名 → plan 的 stack 名
_STACK = {'layer': 'work', 'guidance': 'guidance'}


# ── 读 .cud ────────────────────────────────────────────────────────────────────────────────
def read_cud(path):
    """读一份 .cud：返回 {path, head, assets, blob}。

    assets: id → {id, role, length, offset, md5}；md5 是这一枚**像素字节**的哈希，
    就是 plan 里的资源 id（内容哈希，天然去重）。
    """
    with open(path, 'rb') as f:
        blob = f.read()
    if len(blob) < 12 or blob[:4] != CUD_MAGIC:
        raise ValueError(f'不是 .cud（magic 不对）：{path}')
    hlen = struct.unpack('<I', blob[4:8])[0]
    head = json.loads(blob[8:8 + hlen].decode('utf-8'))
    off = 8 + hlen
    assets = {}
    for a in head.get('assets') or []:
        n = int(a.get('length') or 0)
        chunk = blob[off:off + n]
        assets[a.get('id')] = {
            'id': a.get('id'), 'role': a.get('role'), 'length': n, 'offset': off,
            'md5': hashlib.md5(chunk).hexdigest(),
        }
        off += n
    return {'path': path, 'head': head, 'assets': assets, 'blob': blob}


# ── 小工具 ────────────────────────────────────────────────────────────────────────────────
def _res_id(md5):
    return 'res:' + md5


def _layer_sets(head):
    """`layerSets` 可能是 list（v6）也可能被人手改成 dict —— 两种都认。"""
    ls = head.get('layerSets') or []
    if isinstance(ls, dict):
        return {str(k): (v or {}) for k, v in ls.items()}
    return {str(s.get('key')): s for s in ls if isinstance(s, dict)}


def _attrs_table(head):
    at = head.get('attributes') or []
    if isinstance(at, dict):
        return {str(k): v for k, v in at.items() if isinstance(v, dict)}
    return {str(a.get('id')): a for a in at if isinstance(a, dict) and a.get('id')}


def _attr_recs(layer, table):
    """一层引用的属性记录（有序）。老档可能是"值对象"，新档是 id 字符串。"""
    out = []
    for a in layer.get('attrs') or []:
        if isinstance(a, str):
            rec = table.get(a)
            if rec:
                out.append(rec)
        elif isinstance(a, dict):
            out.append(a)
    return out


def _video_asset_res(video, asset_hash):
    """视频资源不在 .cud 里内嵌（库是权威），id 直接用内容哈希。"""
    if not asset_hash:
        return None
    for a in video.get('assets') or []:
        if a.get('asset') == asset_hash or a.get('id') == asset_hash:
            return {'id': _res_id(asset_hash), 'kind': 'video',
                    'uri': f'media://{asset_hash}.mp4', 'w': None, 'h': None}
    return {'id': _res_id(asset_hash), 'kind': 'video', 'uri': f'media://{asset_hash}.mp4',
            'w': None, 'h': None}


# ── 编译 ──────────────────────────────────────────────────────────────────────────────────
def compile_plan(doc, key=None, t=None):
    head = doc['head']
    assets = doc['assets']
    video = head.get('video') or {}
    canvas = head.get('canvas') or {}
    gw = int(canvas.get('w') or 0)
    gh = int(canvas.get('h') or 0)

    sets = _layer_sets(head)

    # ── 这一刻是什么形态（契约 §2.3.1）────────────────────────────────────────
    # t 落在 Layer 段里 ⇒ 只画图层；否则 ⇒ 只画那条视频轨的帧（底片路径）。两者互斥。
    def _hit(clip, tt):
        st = clip.get('start') or 0
        return st <= tt < st + (clip.get('duration') or 0)
    all_clips = video.get('clips') or []
    mode = 'layers'
    if t is not None:
        seg = next((c for c in all_clips
                    if c.get('kind') == 'layer' and c.get('layerKey') and _hit(c, t)), None)
        if seg is not None:
            key = seg.get('layerKey')
        else:
            mode = 'source'
            key = ''

    k = str(key if key is not None else (head.get('activeLayerSet') or ''))
    if mode == 'source':
        raw_layers = []                            # 底片形态：没有图层
    elif k and k in sets:
        raw_layers = sets[k].get('layers') or []
    else:
        raw_layers = head.get('layers') or []      # 文档主图层

    table = _attrs_table(head)
    resources = {}

    def res_ref(asset_id, role=None):
        """surface/烘焙面：.cud 内嵌 asset → res:<md5>。

        `kind` 一律是 `image`（契约里只有 image/video/lut/depth/normal —— 蒙版也是一袋像素，
        它的用途由 `role` 说，不另立一种 kind）。
        """
        if asset_id is None or asset_id == '':
            return None
        a = assets.get(asset_id)
        if not a:
            return None
        rid = _res_id(a['md5'])
        resources[rid] = {'id': rid, 'kind': 'image', 'uri': 'inline:' + a['md5'],
                          'w': None, 'h': None, 'role': role or a.get('role'), 'assetId': asset_id}
        return {'resource': rid}

    def base_image_ref(layer):
        """老档的底像素（`l.image` / `buffer` / 盒里那一格）。

        今天的新档这一枚就是条带上 `role:'base'` 的那一步 —— 那时这里返回 None，`steps_of` 也不会
        替它再立一枚。只有**根本没有条带记录**、像素还住在图层字段里的老文件才走这一路，补一枚出来
        是为了让这条老成分在同一套" strip 顺序即为生效顺序"的规矩里还是有图的那一步。
        """
        for rec in _attr_recs(layer, table):
            if rec.get('type') in ('image', 'decal'):
                return None
        box = layer.get('box') if isinstance(layer.get('box'), dict) else None
        box_base = None
        if box:
            base_rec = box.get('base')
            if isinstance(base_rec, dict) and 'image' in base_rec:
                box_base = base_rec.get('image')
            else:
                box_imgs = box.get('images') if isinstance(box.get('images'), list) else []
                if box_imgs and isinstance(box_imgs[0], dict):
                    box_base = box_imgs[0].get('image')
        if box_base is not None:
            return box_base
        if layer.get('buffer') is not None:
            return layer.get('buffer')
        return layer.get('image')

    def steps_of(layer):
        out = []
        # 老文件的像素住在图层字段里：把它当成条带上**最左那一枚 image**（那时的形状也的确如此），
        # 于是" strip 顺序即生效顺序"这一句对整个老成分都成立 —— 否则那一层会整层不出现。
        legacy = base_image_ref(layer)
        if legacy is not None:
            out.append({'kind': 'surface', 'type': 'image', 'enabled': True,
                        'surface': res_ref(legacy, role='base'), 'frameTrack': ''})
        for rec in _attr_recs(layer, table):
            # 底位（`role:'base'`）**也是条带上普通的一步**：位置就是生效位置，拖到一条链右边那条链
            # 就不作用于它。以前它被 `layers[].base` 单独交出去（留在这儿会被叠两遍），现在没有了。
            t = rec.get('type')
            if not t:
                continue
            # P0 改名：老档里这一枚写的是 decal，plan 一侧统一成 image。**必须在这里归一**，
            # 否则它掉进下面的 else 分支被当成 generator（走 baked 面），症状是"贴片不叠"。
            if t == 'decal':
                t = 'image'
            # 停用的一步照样进 plan（参数还在，撤销/重新启用不必回档），但 `enabled` 必须是 false：
            # 合成器 `foldLayer` 就是按 `enabled === false` 跳过它。写死 True 会让 plan 一侧照旧出墨，
            # 与页面折叠（fxDropStrip 里 `attrEnabled` 跳过）不一致。
            en = rec.get('enabled') is not False
            if t == 'effects':
                chain = rec.get('chain') or []
                out.append({'kind': 'chain', 'type': 'effects', 'enabled': en,
                            'chain': _effects(chain)})
            # stash 与 image/mask 同一档：它是条带上一枚**面**（那一层以下所有图层的合成），只是面不在
            # 档里（每次 render 现抄，存下来只会是一张 stale 的副本），所以 `surface` 常是 None。
            elif t in ('image', 'mask', 'stash'):
                out.append({'kind': 'surface', 'type': t, 'enabled': en,
                            'surface': res_ref(rec.get('surface'), role=t),
                            'frameTrack': rec.get('frameTrack') or ''})
            else:
                # text / direction / 3d / pose / crop / meet / fit / scale / limit / recover ...
                desc = rec.get('desc')
                if desc is None:
                    desc = rec.get(t) or rec.get('text') or rec.get('dir') or rec.get('scene')
                baked = res_ref(rec.get('baked') or rec.get('image'), role=t)
                out.append({'kind': 'generator', 'type': t, 'enabled': en,
                            'desc': desc, 'box': rec.get('box') or None,
                            'ownsGrid': bool(rec.get('ownsGrid')),
                            'baked': baked, 'sceneUid': rec.get('sceneUid') or None})
        return out

    def _effects(chain):
        out = []
        for e in chain:
            if not isinstance(e, dict):
                continue
            out.append({'type': e.get('type'), 'enabled': e.get('enabled') is not False,
                        'params': e.get('params') or {},
                        'maps': e.get('maps') or {}})
        return out

    # 图层段：段自己就是时间线上的锚（clip.layerKey == 段 key）
    seg_clip = None
    for c in video.get('clips') or []:
        if c.get('kind') == 'layer' and c.get('layerKey') == k:
            seg_clip = c
            break

    layers = []
    for l in raw_layers:
        if not isinstance(l, dict):
            continue
        tr = l.get('transform') or {}
        # 底下不再有"单独铺的那一张"：条带上每一枚 image（含底位）都是一次 source-over，第一张就是
        # 最下面那张。`base` 这个键保留着是为了 plan schema 不变（对面 layer-fold.js 也恒为 null），
        # Python 一侧没有任何消费方读它；回退链只是给还要比对旧 plan 的工具留个说法。
        layers.append({
            'id': l.get('id'),
            'name': l.get('name') or '',
            'base': None,
            'stack': _STACK.get(l.get('stack') or 'layer', 'work'),
            'visible': l.get('visible') is not False,
            'opacity': 1,
            'blend': 'source-over',
            # `capture` 只为旧 Stash **图层**存在（"底像素换成以下所有层的合成"）。Stash 现在是条带上
            # 一枚普通的面（见 attr/stash.js），那一岔连同图层种类一起删了，所以这里恒为 None ——
            # 键留着是为了 plan schema 不变（对面 layer-fold.js 同样恒为 null）。
            'capture': None,
            'transform': {
                'cx': float(tr.get('cx', 0.5)), 'cy': float(tr.get('cy', 0.5)),
                'w': float(tr.get('w', 1)), 'h': float(tr.get('h', 1)),
                'rotation': float(tr.get('rotation', 0)),
            },
            'strip': steps_of(l),
            'timeMap': ({'clipId': seg_clip.get('id'), 'start': seg_clip.get('start'),
                         'duration': seg_clip.get('duration'), 'offset': seg_clip.get('offset') or 0,
                         'srcDuration': seg_clip.get('srcDuration')} if seg_clip else None),
        })
    # **自底向上**：.cud 的 layers[0] 是最上面那层（render() 倒序画）
    layers.reverse()

    # 视频轨的时刻表：frameTrack 只给 trackId，合成器要靠这张表算 sourceTime
    tracks = []
    for tr in video.get('tracks') or []:
        if tr.get('kind') != 'video':
            continue
        tid = tr.get('id')
        clips = []
        res = None
        for c in video.get('clips') or []:
            if c.get('kind') != 'video' or c.get('trackId') != tid:
                continue
            clips.append({'start': c.get('start'), 'duration': c.get('duration'),
                          'offset': c.get('offset') or 0, 'srcDuration': c.get('srcDuration')})
            if res is None:
                # 一条轨上不同段可以用不同素材（P1 只报第一段那一件；多素材留给 P2）
                res = _video_asset_res(video, c.get('asset') or c.get('play'))
        if res:
            resources[res['id']] = res
        tracks.append({'id': tid, 'kind': 'video', 'name': tr.get('name') or '',
                       'resource': (res or {}).get('id'), 'clips': clips})

    # source 形态：这一刻最下面那条有片的视频轨（与宿主 clipAt 同序：按 tracks 顺序取第一个命中）
    src_track = None
    src_at = None
    if mode == 'source' and t is not None:
        for tr in video.get('tracks') or []:
            if tr.get('kind') != 'video':
                continue
            for c in all_clips:
                if c.get('kind') == 'video' and c.get('trackId') == tr.get('id') and _hit(c, t):
                    src_track = tr.get('id')
                    off = c.get('offset') or 0
                    sd = c.get('srcDuration') or 0
                    src_at = max(0, min(off + (t - (c.get('start') or 0)),
                                        max(0, sd - 0.001)))
                    break
            if src_track:
                break

    plan = {
        'v': PLAN_VERSION,
        'doc': os.path.basename(doc['path']),
        't': t,
        'frame': {'mode': mode,
                  'source': ({'trackId': src_track, 'fit': 'stretch',
                              'at': src_at} if src_track else None)},
        'grid': {'w': gw, 'h': gh},
        'fps': float(video.get('fps') or 30),
        'color': {'in': 'srgb', 'out': 'srgb', 'premultiplied': False},
        'mask': None,
        'tracks': tracks,
        'layers': layers,
        'resources': [resources[r] for r in sorted(resources)],
        'source': {'kind': 'cud', 'path': doc['path'], 'layerSet': k},
    }
    return plan


def load_plan(path, key=None, t=None):
    return compile_plan(read_cud(path), key=key, t=t)


# ── CLI ───────────────────────────────────────────────────────────────────────────────────
def _stats(plan):
    steps = sum(len(l['strip']) for l in plan['layers'])
    kinds = {}
    for l in plan['layers']:
        for s in l['strip']:
            kinds[s['type']] = kinds.get(s['type'], 0) + 1
    return {'mode': plan['frame']['mode'], 't': plan.get('t'),
            'layers': len(plan['layers']), 'steps': steps, 'kinds': kinds,
            'resources': len(plan['resources']), 'tracks': len(plan['tracks']),
            'grid': plan['grid'], 'layerSet': plan['source']['layerSet']}


def main(argv):
    if not argv or argv[0].startswith('-'):
        print(__doc__)
        return 2
    path = argv[0]
    key = None
    out = None
    t = None
    want_stats = '--stats' in argv
    for a in argv[1:]:
        if a.startswith('--set='):
            key = a.split('=', 1)[1]
        elif a.startswith('--out='):
            out = a.split('=', 1)[1]
        elif a.startswith('--t='):
            t = float(a.split('=', 1)[1])
    plan = load_plan(path, key=key, t=t)
    text = json.dumps(plan, ensure_ascii=False, indent=2)
    if out:
        os.makedirs(os.path.dirname(os.path.abspath(out)) or '.', exist_ok=True)
        with open(out, 'w', encoding='utf-8') as f:
            f.write(text + '\n')
    if want_stats or not out:
        print(json.dumps(_stats(plan), ensure_ascii=False, indent=2))
    if out:
        print('plan -> ' + out)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
