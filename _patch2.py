# -*- coding: utf-8 -*-
import re
p = 'nodes/web/attr/geometry.js'
s = open(p, encoding='utf-8').read()

# ---- drawGeometryPlan: 四元数版 ----
m = re.search(r'    function drawGeometryPlan\(ctx, W, H, kind, d\) \{.*?\n    \}\n', s, re.S)
assert m, 'drawGeometryPlan'
new = """    function drawGeometryPlan(ctx, W, H, kind, d) {
        const r = geoPlanRect(W, H);
        const lw = Math.max(1.2, Math.min(r.w, r.h) * 0.02);
        const fs = Math.max(10, Math.min(r.w, r.h) * 0.07);
        const Ra = Math.min(r.w, r.h) * 0.1;
        const Rp = Math.min(r.w, r.h) * 0.36;
        const { hw, hd } = dirPlaneHalf();
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // 画布矩形本身:淡填充 + 描边。几何都标在它周围,"相对画布"靠这张矩形读出来。
        ctx.globalAlpha = 0.08;
        ctx.fillStyle = GEO_PLANE;
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.globalAlpha = 0.6;
        ctx.strokeStyle = GEO_PLANE;
        ctx.lineWidth = lw * 0.7;
        ctx.strokeRect(r.x, r.y, r.w, r.h);

        // 世界 position -> 正面图: 画布矩形里 (x/hw + 1)/2 等比铺开。
        const px = r.x + (d.position.x / (2 * hw) + 0.5) * r.w;
        const py = r.y + (d.position.z / (2 * hd) + 0.5) * r.h;
        const col = d.color;
        // 四元数唯一真相: f = 规范朝向 +X 转到世界 (ray 的箭头 / plane 的法线)。
        const f = qApply(d.rotation, { x: 1, y: 0, z: 0 });

        if (kind === 'point') {
            // 十字锚 + 实心点:高度不出现在正面投影里,所以读数必须烘在点旁边。
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = col;
            ctx.lineWidth = lw;
            ctx.beginPath();
            ctx.moveTo(px - Ra, py); ctx.lineTo(px - Ra * 0.45, py);
            ctx.moveTo(px + Ra * 0.45, py); ctx.lineTo(px + Ra, py);
            ctx.moveTo(px, py - Ra); ctx.lineTo(px, py - Ra * 0.45);
            ctx.moveTo(px, py + Ra * 0.45); ctx.lineTo(px, py + Ra);
            ctx.stroke();
            ctx.fillStyle = col;
            ctx.beginPath();
            ctx.arc(px, py, lw * 1.6, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            geoLabel(ctx, 'x ' + d.position.x.toFixed(2) + ' \\u00b7 y ' + d.position.y.toFixed(2)
                + ' \\u00b7 z ' + d.position.z.toFixed(2), px, py - Ra - fs * 0.75, fs);
        } else if (kind === 'plane') {
            // 无限平面的取景记号是一张圆盘:正面投影 = 椭圆,短轴/长轴 = 法线的 |y|
            // (法线越躺平盘越"侧"成一条线,立起来与画布平行就是整圆),短轴沿法线的投影方向。
            const minor = Math.abs(f.y) * Rp;
            const t = Math.atan2(f.z, f.x);
            ctx.globalAlpha = 0.14;
            ctx.fillStyle = col;
            ctx.beginPath();
            ctx.ellipse(px, py, Rp, Math.max(minor, lw * 0.6), t + Math.PI / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 0.95;
            ctx.strokeStyle = col;
            ctx.lineWidth = lw * 1.2;
            ctx.stroke();
            ctx.fillStyle = col;
            ctx.beginPath();
            ctx.arc(px, py, lw * 1.6, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            const yawDeg = Math.round(dirWrap360(dirDeg(t)));
            const pitDeg = Math.round(dirDeg(Math.asin(Math.max(-1, Math.min(1, f.y)))));
            geoLabel(ctx, yawDeg + '\\u00b0 / ' + pitDeg + '\\u00b0', px, py + Rp + fs * 0.9, fs);
        } else {
            // ray:起点 + 带箭头的射线。正面投影里方向顺着画布缩 |(f.x, f.z)|(抬到 90° 只剩
            // 起点那颗点),后面那条等长淡虚线是真长参照 (与 direction 的箭头同一套话)。
            const t = Math.atan2(f.z, f.x);
            const co = Math.hypot(f.x, f.z);
            const ux = co > 1e-9 ? f.x / co : 1, uy = co > 1e-9 ? f.z / co : 0;
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = col;
            ctx.lineWidth = lw;
            ctx.beginPath();
            ctx.arc(px, py, Ra, 0, t, false);
            ctx.stroke();
            const tip = { x: px + ux * Rp * co, y: py + uy * Rp * co };
            ctx.setLineDash([lw * 1.6, lw * 1.8]);
            ctx.globalAlpha = 0.3;
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(px + ux * Rp, py + uy * Rp);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = col;
            ctx.fillStyle = col;
            ctx.lineWidth = lw * 1.6;
            const head = Math.max(5, Rp * 0.2);
            const shaftEnd = { x: tip.x - ux * head * 0.62, y: tip.y - uy * head * 0.62 };
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(shaftEnd.x, shaftEnd.y);
            ctx.stroke();
            const hx = -uy, hy = ux;
            ctx.beginPath();
            ctx.moveTo(tip.x, tip.y);
            ctx.lineTo(shaftEnd.x + hx * head * 0.44, shaftEnd.y + hy * head * 0.44);
            ctx.lineTo(shaftEnd.x - hx * head * 0.44, shaftEnd.y - hy * head * 0.44);
            ctx.closePath();
            ctx.fill();
            ctx.beginPath();
            ctx.arc(px, py, lw * 1.6, 0, Math.PI * 2);
            ctx.fill();
            const mid = t / 2;
            const yawDeg = Math.round(dirWrap360(dirDeg(t)));
            const pitDeg = Math.round(dirDeg(Math.asin(Math.max(-1, Math.min(1, f.y)))));
            geoLabel(ctx, yawDeg + '\\u00b0', px + Math.cos(mid) * Ra * 1.8, py + Math.sin(mid) * Ra * 1.8, fs);
            geoLabel(ctx, 'y ' + d.position.y.toFixed(2) + ' \\u00b7 p ' + pitDeg + '\\u00b0',
                px, py - Ra - fs * 0.75, fs);
        }
        ctx.restore();
    }
"""
s = s.replace(m.group(0), new, 1)

# ---- sync key ----
old = """        const key = JSON.stringify(['geometry', kind, d.u, d.v, d.h,
            d.yaw === undefined ? 0 : d.yaw, d.pitch === undefined ? 0 : d.pitch,
            d.color, canvasW / canvasH, r.box || 0, w, h]);"""
new = """        const key = JSON.stringify(['geometry', kind, d.position.x, d.position.y, d.position.z,
            d.rotation.x, d.rotation.y, d.rotation.z, d.rotation.w,
            d.color, canvasW / canvasH, r.box || 0, w, h]);"""
assert old in s, 'sync key'
s = s.replace(old, new, 1)

# ---- 标题 ----
old_start = s.index('    // 读数按世界 XYZ 说')
old_end = s.index('    };', old_start) + len('    };\n')
new = """    // 读数按世界 XYZ 说 (position 直出); 朝向读数是四元数分解的欧拉。
    const geoXYZ = d => 'x ' + d.position.x.toFixed(2) + ' \\u00b7 y ' + d.position.y.toFixed(2)
        + ' \\u00b7 z ' + d.position.z.toFixed(2);
    const geoTilt = d => { const e = geoEuler(d.rotation);
        return Math.round(dirWrap360(e.yaw)) + '\\u00b0/' + Math.round(e.pitch) + '\\u00b0'; };
    const geoTitle = {
        plane: (r, l) => attrStepNote('Plane', r, l) + (r.desc
            ? ' \\u2014 ' + geoXYZ(r.desc) + ' \\u00b7 normal ' + geoTilt(r.desc) : ''),
        point: (r, l) => attrStepNote('Point', r, l) + (r.desc
            ? ' \\u2014 ' + geoXYZ(r.desc) : ''),
        ray: (r, l) => attrStepNote('Ray', r, l) + (r.desc
            ? ' \\u2014 ' + geoXYZ(r.desc) + ' \\u2192 ' + geoTilt(r.desc) : ''),
    };
"""
s = s[:old_start] + new + s[old_end:]

open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('geometry plan+key+titles done')
