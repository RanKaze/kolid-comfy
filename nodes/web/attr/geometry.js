// Plane / Point / Ray attribute —— 相对画布的三个**3D 对象**,与 Direction 同一个家族、同一扇
// 3D 小窗 (js/direction.js 的把手拖动 + js/direction_view.js 的 three.js 场景):
//   point = 世界里的一个位置:画布上 (u, v) + 离面高度 h (单位 = 画布高);
//   ray   = point + 一条方向 (yaw/pitch,direction 的同一套角);
//   plane = 一个位置 + 一条法线 (yaw/pitch),过该点、法线朝那儿的无限平面 —— 圆盘只是它的取景记号。
// 坐标是**画布归一化**的 (u,v:0 = 左/上边,1 = 右/下边;h:1 = 离面一个画布高),与图层盒子放在
// 画布哪儿无关。与 direction 同一条规矩:desc 在档、面是派生 (sync 键比对惰性重算),面画的是
// **画布空间的正面图** —— 顺着画布法线看下去,圆盘/箭头/点按世界坐标投影落位,读数烘进像素。
(function () {
    const GEO_PLANE = '#8b93a7';      // 画布矩形本身:与 direction 那张正面图同一支中性灰蓝
    // 世界单位 (环半径 = 1): X 跨画布、Z 沿画布下、Y 离面; rotation 是四元数,
    // 规范朝向 = +X (ray 的箭头 / plane 的法线), 默认姿态由欧拉转过去 (plane 默认法线朝 +Y)。
    // rotation 用 getter:本文件比 js/direction.js 先加载,qFromEuler 要到运行时才存在。
    const GEO_DEFAULTS = {
        plane: { position: { x: 0, y: 0.35, z: 0 }, get rotation() { return qFromEuler(0, 90, 0); }, color: '#f5c542' },
        point: { position: { x: 0, y: 0.4, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, color: '#19e0bc' },
        ray: { position: { x: -0.3, y: 0, z: 0 }, get rotation() { return qFromEuler(135, 25, 0); }, color: '#ff2e88' },
    };
    const GEO_ORDER = { plane: 6, point: 7, ray: 8 };
    // 角标走各自的主色,9px 里只放读得出的形状:斜线 / 一枚点 / 带起点的箭头 (direction 那枚
    // "单支箭头"没有起点,ray 得有自己的)。
    const GEO_BADGES = {
        plane: { class: 'plane', svg: '<svg viewBox="0 0 10 10"><path d="M1.2 8.8 8.8 1.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="square"/><circle cx="5" cy="5" r="1.1" fill="currentColor"/></svg>' },
        point: { class: 'point', svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="2" fill="currentColor"/></svg>' },
        ray: { class: 'ray', svg: '<svg viewBox="0 0 10 10"><circle cx="2.4" cy="7.6" r="1.4" fill="currentColor"/><path d="M4 6 8.2 1.8 M5.6 1.8H8.4V4.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="square"/></svg>' },
    };

    // 唯一的形状裁定: position 夹在 ±4 (世界单位), rotation 归一 (坏值退默认); 旧形状
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

    // ---- 画布空间的正面图 ----
    // 画布矩形按画布比例 contain 进盒子 (拉扁盒子拉不扁画布,与 direction 那张图同一条)。
    function geoPlanRect(W, H) {
        const a = canvasW && canvasH ? canvasW / canvasH : 1;
        let pw = W * 0.94, ph = pw / a;
        if (ph > H * 0.94) { ph = H * 0.94; pw = ph * a; }
        return { x: (W - pw) / 2, y: (H - ph) / 2, w: pw, h: ph };
    }

    function geoLabel(ctx, text, x, y, fs) {
        ctx.font = `600 ${fs}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#f2f2f6';
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.lineWidth = fs * 0.18;
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
    }

    function drawGeometryPlan(ctx, W, H, kind, d) {
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
            geoLabel(ctx, 'x ' + d.position.x.toFixed(2) + ' \u00b7 y ' + d.position.y.toFixed(2)
                + ' \u00b7 z ' + d.position.z.toFixed(2), px, py - Ra - fs * 0.75, fs);
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
            geoLabel(ctx, yawDeg + '\u00b0 / ' + pitDeg + '\u00b0', px, py + Rp + fs * 0.9, fs);
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
            geoLabel(ctx, yawDeg + '\u00b0', px + Math.cos(mid) * Ra * 1.8, py + Math.sin(mid) * Ra * 1.8, fs);
            geoLabel(ctx, 'y ' + d.position.y.toFixed(2) + ' \u00b7 p ' + pitDeg + '\u00b0',
                px, py - Ra - fs * 0.75, fs);
        }
        ctx.restore();
    }

    function renderGeometryBuffer(kind, d, w, h) {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w));
        c.height = Math.max(1, Math.round(h));
        const ctx = c.getContext('2d');
        if (ctx) drawGeometryPlan(ctx, c.width, c.height, kind, d);
        return c;
    }

    // ---- 惰性同步 (与 attr/direction.js 同一套规矩,一字不差的职责划分) ----
    // ownsGrid:格子 = transform 盒子在画布上的像素,底换透明画布;不 ownsGrid:格子就是图层自己的。
    // 画布比例在键里:正面图按它 contain,改画布尺寸必须重烘。
    function geoSync(kind, l, r) {
        if (!r.desc) return;
        if (r.ownsGrid && l.transform && canvasW && canvasH) {
            const w = Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.round(l.transform.w * canvasW)));
            const h = Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.round(l.transform.h * canvasH)));
            const cur = nativeSize(l.img);
            if (!l.img || cur.w !== w || cur.h !== h) {
                l.img = makeBlankCanvas(w, h);
                l.src = '';
                remapAttrFaces(l, s => stretchSurfaceTo(s, w, h));
            }
        }
        if (!l.img) return;
        const { w, h } = nativeSize(l.img);
        if (!w || !h) return;
        const d = r.desc;
        const key = JSON.stringify(['geometry', kind, d.position.x, d.position.y, d.position.z,
            d.rotation.x, d.rotation.y, d.rotation.z, d.rotation.w,
            d.color, canvasW / canvasH, r.box || 0, w, h]);
        if (r.genCache && r.genCache.key === key && r.genCache.img === l.img && r.surface) return;
        const bx = r.box ? Math.round(r.box.x * w) : 0;
        const by = r.box ? Math.round(r.box.y * h) : 0;
        const bw = r.box ? Math.max(1, Math.round(r.box.w * w)) : w;
        const bh = r.box ? Math.max(1, Math.round(r.box.h * h)) : h;
        const buf = renderGeometryBuffer(kind, d, bw, bh);
        const face = document.createElement('canvas');
        face.width = w; face.height = h;
        face.getContext('2d').drawImage(buf, bx, by);
        r.surface = face;
        r.genCache = { key, img: l.img };
    }

    // 读数按世界 XYZ 说 (position 直出); 朝向读数是四元数分解的欧拉。
    const geoXYZ = d => 'x ' + d.position.x.toFixed(2) + ' \u00b7 y ' + d.position.y.toFixed(2)
        + ' \u00b7 z ' + d.position.z.toFixed(2);
    const geoTilt = d => { const e = geoEuler(d.rotation);
        return Math.round(dirWrap360(e.yaw)) + '\u00b0/' + Math.round(e.pitch) + '\u00b0'; };
    const geoTitle = {
        plane: (r, l) => attrStepNote('Plane', r, l) + (r.desc
            ? ' \u2014 ' + geoXYZ(r.desc) + ' \u00b7 normal ' + geoTilt(r.desc) : ''),
        point: (r, l) => attrStepNote('Point', r, l) + (r.desc
            ? ' \u2014 ' + geoXYZ(r.desc) : ''),
        ray: (r, l) => attrStepNote('Ray', r, l) + (r.desc
            ? ' \u2014 ' + geoXYZ(r.desc) + ' \u2192 ' + geoTilt(r.desc) : ''),
    };
    const geoAddTitle = {
        plane: `Add a Plane step — an infinite plane through a world point (XZ in-plane, Y off it), steered by its normal. It is a 3D object: point it in the Direction window (the same 3D view the Direction step uses).`,
        point: `Add a Point step — a position in the world relative to the canvas: X across the canvas, Z down it, Y lifts off the plane. It is a 3D object: move it in the Direction window (the same 3D view the Direction step uses).`,
        ray: `Add a Ray step — a point in the world plus a direction. It is a 3D object: point it in the Direction window (the same 3D view the Direction step uses).`,
    };

    for (const kind of Object.keys(GEO_DEFAULTS)) {
        defineAttrType({
            type: kind,
            label: kind[0].toUpperCase() + kind.slice(1),
            kind: 'generator',
            legacy: kind,
            order: GEO_ORDER[kind],
            at: { rel: 'tail' },
            chipClass: kind + '-attr-thumb',
            badge: GEO_BADGES[kind],
            fromLegacy: raw => (raw ? { desc: sanitizeGeometryDescriptor(raw, kind), ownsGrid: true } : null),
            init: () => ({ desc: sanitizeGeometryDescriptor(Object.assign({}, GEO_DEFAULTS[kind]), kind), ownsGrid: false, box: null }),
            // 面板/小窗的 Reset 与 sanitize 都从注册表拿 —— 家族的 patch 路径不认得具体类型。
            sanitize: raw => sanitizeGeometryDescriptor(raw, kind),
            get defaults() { return sanitizeGeometryDescriptor(Object.assign({}, GEO_DEFAULTS[kind]), kind); },
            // 几何总有图可出 (画布矩形本身就是一张图),不需要"空内容"那一档。
            ink: r => !!r.desc,
            title: geoTitle[kind],
            addTitle: geoAddTitle[kind],
            // 点 chip = 把 Direction 3D 小窗对准**这一枚** (家族四个类型共用一扇窗,窗点名编辑)。
            open(l, r) { dirPinTarget(l, r); },
            sync(l, r) { geoSync(kind, l, r); },
        });
    }

    // 特效绑定选择器的卡片 (fx/ui.js openFxDirModal) 要烘 plane 的正面图 —— IIFE 内的工具走 window 出口。
    window.renderGeometryBuffer = renderGeometryBuffer;
})();
