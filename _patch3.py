# -*- coding: utf-8 -*-
import re
p = 'nodes/web/js/direction_view.js'
s = open(p, encoding='utf-8').read()

# ---- sync: 位置与朝向都来自 position/四元数 ----
old = """        const col = hex(d.color || DIR_DEFAULTS.color);
        const pos = kind === 'direction' ? { x: 0, y: 0, z: 0 } : geoWorldPos(d);"""
new = """        const col = hex(d.color || DIR_DEFAULTS.color);
        const pos = kind === 'direction' ? { x: 0, y: 0, z: 0 } : d.position;
        // 四元数唯一真相: f = 规范朝向 +X 转到世界 (ray 的箭头 / plane 的法线 / direction 的指向)。
        const fwd = qApply(d.rotation, { x: 1, y: 0, z: 0 });
        const upv = qApply(d.rotation, { x: 0, y: 1, z: 0 });
        const sid = qApply(d.rotation, { x: 0, y: 0, z: 1 });"""
assert old in s, 'sync pos'
s = s.replace(old, new, 1)

# ---- arcGroup: 欧拉读数从四元数来 ----
old = """        const hasArc = kind !== 'point' && gizmoMode === 'move';
        parts.arcGroup.visible = hasArc;
        if (hasArc) {
            const t = dirRad(d.yaw);
            orient(parts.arcGroup, dirWorldAz(d.yaw), parts.up, { x: -Math.sin(t), y: 0, z: Math.cos(t) });
            parts.arcGroup.position.set(pos.x, pos.y, pos.z);
            parts.arcLive.geometry = arcGeometry(T, d.pitch);
            parts.arcLive.rotation.z = d.pitch >= 0 ? 0 : dirRad(d.pitch);
        }"""
new = """        const hasArc = kind !== 'point' && gizmoMode === 'move';
        parts.arcGroup.visible = hasArc;
        if (hasArc) {
            const yawDeg = dirDeg(Math.atan2(fwd.z, fwd.x));
            const t = dirRad(yawDeg);
            orient(parts.arcGroup, dirWorldAz(yawDeg), parts.up, { x: -Math.sin(t), y: 0, z: Math.cos(t) });
            parts.arcGroup.position.set(pos.x, pos.y, pos.z);
            const pitDeg = dirDeg(Math.asin(Math.max(-1, Math.min(1, fwd.y))));
            parts.arcLive.geometry = arcGeometry(T, pitDeg);
            parts.arcLive.rotation.z = pitDeg >= 0 ? 0 : dirRad(pitDeg);
        }"""
assert old in s, 'arc'
s = s.replace(old, new, 1)

# ---- 箭头: f 来自四元数 ----
old = """        const hasArrow = kind !== 'point';
        parts.shaft.visible = parts.head.visible = hasArrow;
        if (hasArrow) {
            const v = dirVecOf(d);
            const L = kind === 'plane' ? DIR_POSE_R * 0.42 : DIR_POSE_R;"""
new = """        const hasArrow = kind !== 'point';
        parts.shaft.visible = parts.head.visible = hasArrow;
        if (hasArrow) {
            const v = fwd;
            const L = kind === 'plane' ? DIR_POSE_R * 0.42 : DIR_POSE_R;"""
assert old in s, 'arrow'
s = s.replace(old, new, 1)

# ---- disc: 四元数基 ----
old = """        parts.disc.visible = kind === 'plane';
        if (kind === 'plane') {
            const pb = geoPlaneBasis(d);
            orient(parts.disc, pb.b1, pb.b2, pb.n);
            parts.disc.position.set(pos.x, pos.y, pos.z);
            parts.disc.scale.set(GEO_DISC_R, GEO_DISC_R, 1);
            parts.disc.material.color.setHex(col);
        }"""
new = """        parts.disc.visible = kind === 'plane';
        if (kind === 'plane') {
            orient(parts.disc, upv, sid, fwd);
            parts.disc.position.set(pos.x, pos.y, pos.z);
            parts.disc.scale.set(GEO_DISC_R, GEO_DISC_R, 1);
            parts.disc.material.color.setHex(col);
        }"""
assert old in s, 'disc'
s = s.replace(old, new, 1)

# ---- grabAxis: position 直读 ----
old = """        const aw = moveAxes(state)[axis];
        const A = new T.Vector3(aw.x, aw.y, aw.z);
        const p = geoWorldPos(state.desc);
        const pv = new T.Vector3(p.x, p.y, p.z);"""
new = """        const aw = moveAxes(state)[axis];
        const A = new T.Vector3(aw.x, aw.y, aw.z);
        const p = state.desc.position;
        const pv = new T.Vector3(p.x, p.y, p.z);"""
assert old in s, 'grabAxis'
s = s.replace(old, new, 1)

# ---- grabRotate: 存 q0 + local 规范轴 ----
old = """            phi0: Math.atan2(
                v.x * basis.e2.x + v.y * basis.e2.y + v.z * basis.e2.z,
                v.x * basis.e1.x + v.y * basis.e1.y + v.z * basis.e1.z),
            desc0: Object.assign({}, state.desc),
        };
    };"""
new = """            phi0: Math.atan2(
                v.x * basis.e2.x + v.y * basis.e2.y + v.z * basis.e2.z,
                v.x * basis.e1.x + v.y * basis.e1.y + v.z * basis.e1.z),
            q0: Object.assign({}, state.desc.rotation),
            local: gizmoSpace === 'local'
                ? { x: axis === 'rotX' ? 1 : 0, y: axis === 'rotY' ? 1 : 0, z: axis === 'rotZ' ? 1 : 0 }
                : null,
        };
    };"""
assert old in s, 'grabRotate'
s = s.replace(old, new, 1)

# ---- axisDelta: mv 位移直加 / rot 四元数合成 ----
old = """            const g = prev && prev.grab && prev.grab.axis === axis ? prev.grab : null;
            const aw = g ? { x: g.A[0], y: g.A[1], z: g.A[2] } : moveAxes(state)[axis];
            const A = new T.Vector3(aw.x, aw.y, aw.z);
            const p0 = g ? { x: g.pv[0], y: g.pv[1], z: g.pv[2] } : geoWorldPos(state.desc);
            const eye = cam.getWorldDirection(new T.Vector3());
            const base = new T.Vector3(p0.x, p0.y, p0.z);
            const hit = r.intersectPlane(new T.Plane(eye, -eye.dot(base)), new T.Vector3());
            if (!hit) return null;
            let t = hit.sub(base).dot(A);
            if (g) t -= g.offset;
            const gp = geoDescPos({ x: base.x + A.x * t, y: base.y + A.y * t, z: base.z + A.z * t });
            return {
                u: Math.max(-1, Math.min(2, snap05(gp.u))),
                v: Math.max(-1, Math.min(2, snap05(gp.v))),
                h: Math.max(-2, Math.min(2, snap05(gp.h))),
            };"""
new = """            const g = prev && prev.grab && prev.grab.axis === axis ? prev.grab : null;
            const aw = g ? { x: g.A[0], y: g.A[1], z: g.A[2] } : moveAxes(state)[axis];
            const A = new T.Vector3(aw.x, aw.y, aw.z);
            const p0 = g ? g.pv : state.desc.position;
            const eye = cam.getWorldDirection(new T.Vector3());
            const base = new T.Vector3(p0.x, p0.y, p0.z);
            const hit = r.intersectPlane(new T.Plane(eye, -eye.dot(base)), new T.Vector3());
            if (!hit) return null;
            let t = hit.sub(base).dot(A);
            if (g) t -= g.offset;
            const cl = v => Math.max(-4, Math.min(4, v));
            return { position: {
                x: cl(p0.x + A.x * t), y: cl(p0.y + A.y * t), z: cl(p0.z + A.z * t),
            } };"""
assert old in s, 'axisDelta mv'
s = s.replace(old, new, 1)

old = """            let th = phi - g.phi0;
            th = Math.atan2(Math.sin(th), Math.cos(th));
            const thDeg = dirDeg(th);
            const thSnap = prev && prev.shiftKey ? Math.round(thDeg / 15) * 15 : thDeg;
            prev.rotTheta = thSnap;
            return decomposeRotate(g.desc0, { x: g.A[0], y: g.A[1], z: g.A[2] },
                dirRad(thSnap), kind);"""
new = """            let th = phi - g.phi0;
            th = Math.atan2(Math.sin(th), Math.cos(th));
            const thDeg = dirDeg(th);
            const thSnap = prev && prev.shiftKey ? Math.round(thDeg / 15) * 15 : thDeg;
            prev.rotTheta = thSnap;
            // global 空间左乘世界轴旋转, local 空间右乘对象自己的规范轴 (四元数合成)。
            const R = qFromAxisAngle({ x: g.A[0], y: g.A[1], z: g.A[2] }, dirRad(thSnap));
            return { rotation: qNormalize(g.local ? qMul(g.q0, R) : qMul(R, g.q0)) };"""
assert old in s, 'axisDelta rot'
s = s.replace(old, new, 1)

# ---- handlePoints: hw[key] 可能缺 (move 模式外) —— 已有 keys 保护, 不动 ----
open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('view done')
