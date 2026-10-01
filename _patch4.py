# -*- coding: utf-8 -*-
import re

# ---- blend_node.html: 状态文案改经 geoEuler ----
p = 'nodes/web/blend_node.html'
s = open(p, encoding='utf-8').read()
old = """    setStatus(box ? `Direction Layer added — ${box.w} × ${box.h}, pointing ${Math.round(l.dir.yaw)}° / ${Math.round(l.dir.pitch)}°`
                  : `Direction Layer added — full canvas, pointing ${Math.round(l.dir.yaw)}° / ${Math.round(l.dir.pitch)}°`);"""
new = """    const dirE = geoEuler(l.dir.rotation);
    setStatus(box ? `Direction Layer added — ${box.w} × ${box.h}, pointing ${Math.round(dirWrap360(dirE.yaw))}° / ${Math.round(dirE.pitch)}°`
                  : `Direction Layer added — full canvas, pointing ${Math.round(dirWrap360(dirE.yaw))}° / ${Math.round(dirE.pitch)}°`);"""
assert old in s, 'blend status'
s = s.replace(old, new, 1)
open(p, 'w', encoding='utf-8', newline='\n').write(s)

# ---- attr/direction.js: title 读四元数分解的欧拉 ----
p = 'nodes/web/attr/direction.js'
s = open(p, encoding='utf-8').read()
old = """    title: (r, l) => attrStepNote('Direction', r, l)
        + (r.desc ? ` — ${Math.round(r.desc.yaw)}° / ${Math.round(r.desc.pitch)}° / ${Math.round(r.desc.roll)}°` : ''),"""
new = """    title: (r, l) => attrStepNote('Direction', r, l) + (r.desc ? (() => {
        const e = geoEuler(r.desc.rotation);
        return ` — ${Math.round(dirWrap360(e.yaw))}° / ${Math.round(e.pitch)}° / ${Math.round(dirWrap180(e.roll))}°`;
    })() : ''),"""
assert old in s, 'direction title'
s = s.replace(old, new, 1)
open(p, 'w', encoding='utf-8', newline='\n').write(s)

# ---- direction.js: 2D 世界图里的 plane 圆盘基改四元数 ----
p = 'nodes/web/js/direction.js'
s = open(p, encoding='utf-8').read()
old = """    if (kind === 'plane') {
        const { b1, b2 } = geoPlaneBasis(d);
        ctx.globalAlpha = dim * 0.16;"""
new = """    if (kind === 'plane') {
        const b1 = qApply(d.rotation, { x: 0, y: 1, z: 0 });
        const b2 = qApply(d.rotation, { x: 0, y: 0, z: 1 });
        ctx.globalAlpha = dim * 0.16;"""
assert old in s, '2D disc basis'
s = s.replace(old, new, 1)
open(p, 'w', encoding='utf-8', newline='\n').write(s)

# ---- direction_view.js: 过时注释顺手改掉 ----
p = 'nodes/web/js/direction_view.js'
s = open(p, encoding='utf-8').read()
s = s.replace('(dirWorldPose / geoWorldPos /', '(四元数与 position:')
s = s.replace('    // 位置读数再过 geoDescPos 折回画归一化。', '')
s = s.replace('    // 位置读数再过 geoDescPos 折回画布归一化。', '')
open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('patch4 done')
