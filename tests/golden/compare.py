#!/usr/bin/env python3
"""golden 比对器（P0/P1）。

两个目录里同名的 case 逐像素比，按 meta.tolerance 判通过：
  - sameDevice = 0  → maxdiff 必须 0（同一台机器、同一个 GL 后端）
  - crossDevice = 1 → maxdiff ≤ 1

**--edge 模式**（P2 换 GL 混合之后用它）：
换掉采样路径（canvas 2D → WebGL）时，几何边缘那 1px 的抗锯齿覆盖**必然**不同
（实测：边缘外 ≤2 LSB 的预乘舍入差，边缘带 max 255 的覆盖差）。这时"全图 maxdiff 0"
不可达，判据改成：
  - **边缘带外**必须 maxdiff ≤ --maxdiff（默认 2），且不允许有 pct 超标；
  - 边缘带内允许差异，只报比例。
边缘带 = alpha 或亮度梯度突变处，向外膨胀 --grow 像素（默认 1）。

用法：
  python tests/golden/compare.py <基准目录> <新目录>
  python tests/golden/compare.py <基准目录> <新目录> --maxdiff=1
  python tests/golden/compare.py <基准目录> <新目录> --edge --grow=1 --maxdiff=2

退出码：0 = 全过；1 = 有差异（打印每个 case 的 maxdiff / 差异像素比 / 差异外接框）。
"""
import json
import os
import sys

try:
    from PIL import Image
    import numpy as np
except ImportError:
    print('需要 pillow 与 numpy（项目 venv 里已有）', file=sys.stderr)
    sys.exit(2)


def load(p):
    return np.asarray(Image.open(p).convert('RGBA')).astype(np.int16)


def edge_band(a, grow=1, thr=12):
    """边缘带：alpha / 亮度的梯度突变处，向外膨胀 grow 像素（罩住抗锯齿那一圈）。"""
    mask = np.zeros(a.shape[:2], bool)
    for ch in (a[..., 3].astype(np.float32), a[..., :3].mean(axis=2).astype(np.float32)):
        gx = np.abs(np.diff(ch, axis=1, prepend=ch[:, :1]))
        gy = np.abs(np.diff(ch, axis=0, prepend=ch[:1, :]))
        mask |= (gx > thr) | (gy > thr)
    for _ in range(max(0, grow)):
        mask = (mask | np.roll(mask, 1, 0) | np.roll(mask, -1, 0)
                | np.roll(mask, 1, 1) | np.roll(mask, -1, 1))
    return mask


def cases(d):
    if not os.path.isdir(d):
        return []
    return sorted(x for x in os.listdir(d) if os.path.isfile(os.path.join(d, x, 'meta.json')))


def main():
    argv = [a for a in sys.argv[1:] if not a.startswith('--')]
    opt = {a.split('=')[0]: a.split('=')[1] for a in sys.argv[1:] if a.startswith('--') and '=' in a}
    base = argv[0] if len(argv) > 0 else os.path.join(os.path.dirname(__file__), 'vid')
    new = argv[1] if len(argv) > 1 else None
    if new is None:
        print('用法: compare.py <基准目录> <新目录> [--maxdiff=1]', file=sys.stderr)
        return 2
    limit = int(opt.get('--maxdiff', 0))
    edge = '--edge' in sys.argv
    grow = int(opt.get('--grow', 1))

    names = cases(base)
    if not names:
        print('基准目录里没有 case：' + base, file=sys.stderr)
        return 2

    bad = 0
    for name in names:
        a_p = os.path.join(base, name, 'frame.png')
        b_p = os.path.join(new, name, 'frame.png')
        if not os.path.exists(b_p):
            print(f'MISSING  {name}  （新实现没产出这一帧）')
            bad += 1
            continue
        a, b = load(a_p), load(b_p)
        if a.shape != b.shape:
            print(f'SHAPE    {name}  {a.shape} vs {b.shape}')
            bad += 1
            continue
        d = np.abs(a - b).max(axis=2)
        if edge:
            band = edge_band(a, grow)
            out_d = d[~band]
            out_max = int(out_d.max()) if out_d.size else 0
            edge_px = int(band.sum())
            in_diff = int((d[band] > limit).sum())
            pct_in = in_diff * 100.0 / max(1, edge_px)
            if out_max <= limit:
                print(f'OK-EDGE  {name}  边缘外 maxdiff {out_max}  边缘带内差异 {in_diff}'
                      f'（{pct_in:.1f}% of {edge_px} 带宽像素，允许）')
                continue
            bad += 1
            print(f'DIFF     {name}  边缘外 maxdiff {out_max} > {limit}  （这一处不在边缘，是真差）')
            continue
        maxdiff = int(d.max())
        pct = float((d > limit).mean() * 100)
        if maxdiff <= limit:
            print(f'OK       {name}  maxdiff {maxdiff}')
            continue
        ys, xs = np.nonzero(d > limit)
        bbox = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())) if len(xs) else None
        print(f'DIFF     {name}  maxdiff {maxdiff}  pct>{limit} {pct:.2f}%  bbox {bbox}  mean {float(d.mean()):.3f}')
        bad += 1

    extra = [n for n in cases(new) if n not in names]
    if extra:
        print('新增 case（基准里没有）：' + ', '.join(extra))
    print(('全部通过（%d 个 case）' % len(names)) if not bad else ('%d / %d 个 case 不一致' % (bad, len(names))))
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(main())
