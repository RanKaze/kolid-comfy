# -*- coding: utf-8 -*-
import re
p = 'nodes/web/attr/geometry.js'
s = open(p, encoding='utf-8').read()

# ---- GEO_DEFAULTS: position + rotation (四元数) ----
old = """    const GEO_DEFAULTS = {
        plane: { u: 0.5, v: 0.5, h: 0.35, yaw: 0, pitch: 90, color: '#f5c542' },
        point: { u: 0.5, v: 0.5, h: 0.4, color: '#19e0bc' },
        ray: { u: 0.35, v: 0.5, h: 0, yaw: 135, pitch: 25, color: '#ff2e88' },
    };"""
new = """    // 世界单位 (环半径 = 1): X 跨画布、Z 沿画布下、Y 离面; rotation 是四元数,
    // 规范朝向 = +X (ray 的箭头 / plane 的法线), 默认姿态由欧拉转过去 (plane 默认法线朝 +Y)。
    const GEO_DEFAULTS = {
        plane: { position: { x: 0, y: 0.35, z: 0 }, rotation: qFromEuler(0, 90, 0), color: '#f5c542' },
        point: { position: { x: 0, y: 0.4, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, color: '#19e0bc' },
        ray: { position: { x: -0.3, y: 0, z: 0 }, rotation: qFromEuler(135, 25, 0), color: '#ff2e88' },
    };"""
assert old in s, 'defaults'
s = s.replace(old, new, 1)

# ---- sanitize: 新形状 + 旧形状转换 ----
m = re.search(r'    // 唯一的形状裁定.*?\n    function sanitizeGeometryDescriptor\(raw, kind\) \{.*?\n    \}\n', s, re.S)
assert m, 'sanitize'
new = """    // 唯一的形状裁定: position 夹在 ±4 (世界单位), rotation 归一 (坏值退默认); 旧形状
    // ({u,v,h,yaw,pitch}) 在这一道换算成 position + 四元数 —— 今早之前存过的 .cud 也读得懂。
    function sanitizeGeometryDescriptor(raw, kind) {
        if (!raw || typeof raw !== 'object') return null;
        const def = GEO_DEFAULTS[kind];
        const num = (v, d, lo, hi) => {
            const n = Number(v);
            return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
        };
        const legacy = raw.u !== undefined && raw.position === undefined;
        const pos = legacy ? {
            x: (num(raw.u, 0.5, -1, 2) - 0.5) * 2 * dirPlaneHalf().hw,
            y: num(raw.h, 0, -2, 2) * 2 * dirPlaneHalf().hd,
            z: (num(raw.v, 0.5, -1, 2) - 0.5) * 2 * dirPlaneHalf().hd,
        } : (raw.position || def.position);
        const out = {
            position: {
                x: num(pos.x, def.position.x, -4, 4),
                y: num(pos.y, def.position.y, -4, 4),
                z: num(pos.z, def.position.z, -4, 4),
            },
            color: /^#[0-9a-fA-F]{3,8}$/.test(String(raw.color || '')) ? raw.color : def.color,
        };
        let q = sanitizeQuat(raw.rotation, null);
        if (!q && legacy && kind !== 'point') {
            q = qFromEuler(num(raw.yaw, 0, -3600, 3600), num(raw.pitch, 0, -90, 90), 0);
        }
        out.rotation = q || sanitizeQuat(def.rotation, { x: 0, y: 0, z: 0, w: 1 });
        return out;
    }
"""
s = s.replace(m.group(0), new, 1)

open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('geometry defaults+sanitize done')
