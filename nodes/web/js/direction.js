// Direction 图层 —— 图层自己的像素就是这颗姿态把手图: 地平环 + 仰角弧 + 箭头 + 滚转环。
// 面板小窗里画的是同一个 drawDirectionGizmo, 只多画几颗可拖的把手 —— 小窗看到的与烘进图层的
// 是同一次绘制, 不存在两套几何。
//
// 角度读法跟着特效链已有的那条规矩: Yaw 0° = 画布右、90° = 画布下 (与 Lighting 的 Angle、
// fxglDirUV 同一个基); Pitch 是抬离画布平面的角度 (0 = 贴着平面, 90 = 正对相机);
// Roll 是箭头绕自身轴转 (从"鳍朝上"起算)。
// 相机是一条固定的 25° 俯角正交视线: 地平环因此压成 ry = R·sin(tilt) 的椭圆 —— 截图里那颗环
// 就是这么来的, 也是"为什么环是个椭圆"的一句话答案。

const DIR_DEFAULTS = { yaw: 135, pitch: 25, roll: 0, color: '#ff2e88' };
const DIR_TILT = 25 * Math.PI / 180;
const DIR_RING = '#e0247a';
const DIR_ARC = '#19e0bc';
const DIR_FIN = '#f5c542';
const DIR_HANDLE_R = 6.5;         // 把手在屏幕上恒定大小, 不随图层盒子/缩放变 (与 warp 把手同一条)
const DIR_HIT_R = 11;
const DIR_GIZMO_H = 176;

function dirRad(d) { return d * Math.PI / 180; }
function dirDeg(r) { return r * 180 / Math.PI; }
function dirWrap360(d) { return ((d % 360) + 360) % 360; }

// 唯一的一处形状裁定: .cud 读回来或面板 patch 进来的东西先过这里, 坏字段退化到默认值,
// 而不是退化成一张画不出来的图层。
function sanitizeDirectionDescriptor(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const num = (v, d, lo, hi) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
    };
    return {
        // yaw 是绕一圈的角, 所以折回 [0,360) 而不是夹断: 把手拖过 359° 该接到 0°, 不该卡住。
        yaw: dirWrap360(num(raw.yaw, DIR_DEFAULTS.yaw, -3600, 3600)),
        pitch: num(raw.pitch, DIR_DEFAULTS.pitch, -90, 90),
        roll: num(raw.roll, DIR_DEFAULTS.roll, -180, 180),
        color: /^#[0-9a-fA-F]{3,8}$/.test(String(raw.color || '')) ? raw.color : DIR_DEFAULTS.color,
    };
}

// ---- 姿态 → 屏幕 ----
// 世界基: x 右、y 上、z 朝相机那侧; 屏幕 y 朝下。
function dirVecOf(pose) {
    const t = dirRad(pose.yaw), p = dirRad(pose.pitch);
    const c = Math.cos(p);
    return { x: c * Math.cos(t), y: Math.sin(p), z: c * Math.sin(t) };
}
function dirProject(p, R) {
    return { x: p.x * R, y: (p.z * Math.sin(DIR_TILT) - p.y * Math.cos(DIR_TILT)) * R };
}
function dirTip(pose, R) { return dirProject(dirVecOf(pose), R); }
function dirOnRing(azDeg, R) {
    const t = dirRad(azDeg);
    return dirProject({ x: Math.cos(t), y: 0, z: Math.sin(t) }, R);
}
// 箭头自己那组"侧向"基: b1 取世界 up 去掉沿箭头的分量, b2 与它一起垂直于箭头。
// pitch → ±90° 时 up 与箭头平行, 那一条退化就换 x 轴顶上 (滚转读数在那一极点本来也无所谓方向)。
function dirRollBasis(pose) {
    const v = dirVecOf(pose);
    let bx = -v.y * v.x, by = 1 - v.y * v.y, bz = -v.y * v.z;
    let n = Math.hypot(bx, by, bz);
    if (n < 1e-4) { bx = 1; by = 0; bz = 0; n = 1; }
    const b1 = { x: bx / n, y: by / n, z: bz / n };
    const c = { x: v.y * b1.z - v.z * b1.y, y: v.z * b1.x - v.x * b1.z, z: v.x * b1.y - v.y * b1.x };
    const cn = Math.hypot(c.x, c.y, c.z) || 1;
    return { b1, b2: { x: c.x / cn, y: c.y / cn, z: c.z / cn } };
}
function dirRollDir(pose) {
    const { b1, b2 } = dirRollBasis(pose);
    const r = dirRad(pose.roll);
    const co = Math.cos(r), si = Math.sin(r);
    return dirProject({ x: b1.x * co + b2.x * si, y: b1.y * co + b2.y * si, z: b1.z * co + b2.z * si }, 1);
}
function gizmoRadius(W, H) { return Math.min(W, H) * 0.42; }

// 三颗把手在画布上的落点 (CSS 像素, 以小窗画布中心为原点)。
function dirHandlePoints(W, H, pose) {
    const R = gizmoRadius(W, H);
    const tip = dirTip(pose, R);
    const fin = 0.6 * R;
    const roll = dirRollDir(pose);
    return {
        R,
        yaw: dirOnRing(pose.yaw, R),
        pitch: tip,
        roll: { x: tip.x * 0.6 + roll.x * R * 0.17, y: tip.y * 0.6 + roll.y * R * 0.17 },
        finCentre: { x: tip.x * 0.6, y: tip.y * 0.6 },
        finR: R * 0.17,
    };
}

// ---- 绘制 ----
// opts.chrome = 画那几颗可拖把手 (只有小窗要); opts.state = 哪一颗正被按下/悬停。
function drawDirectionGizmo(ctx, W, H, pose, opts) {
    const o = opts || {};
    const R = gizmoRadius(W, H);
    const dim = o.dim ? 0.32 : 1;
    const lw = Math.max(1.4, R * 0.035);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.globalAlpha = dim;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 地平环: 画布平面自己。
    ctx.strokeStyle = DIR_RING;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.ellipse(0, 0, R, R * Math.sin(DIR_TILT), 0, 0, Math.PI * 2);
    ctx.stroke();

    // 箭头落在地面上的投影: 没有它, pitch 就只是"短了一点", 读不出抬起来了。
    const foot = dirOnRing(pose.yaw, R * Math.cos(dirRad(pose.pitch)));
    ctx.setLineDash([lw * 1.6, lw * 1.8]);
    ctx.globalAlpha = dim * 0.55;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(foot.x, foot.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = dim;

    // 仰角弧: 从地平环沿当前方位往上卷的那条轨道。
    const steps = 28;
    ctx.strokeStyle = DIR_ARC;
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
        const t = dirRad(pose.pitch) * i / steps;
        const c = Math.cos(t);
        const p = dirProject({ x: c * Math.cos(dirRad(pose.yaw)), y: Math.sin(t), z: c * Math.sin(dirRad(pose.yaw)) }, R);
        if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
    }
    ctx.stroke();

    // 箭头本体 (图层颜色) + 头部两片倒钩, 都在屏幕上量, 所以粗细与盒子同步缩放。
    const tip = dirTip(pose, R);
    const len = Math.hypot(tip.x, tip.y) || 1;
    const ux = tip.x / len, uy = tip.y / len;
    const head = Math.max(6, R * 0.2);
    const shaftEnd = { x: tip.x - ux * head * 0.62, y: tip.y - uy * head * 0.62 };
    ctx.strokeStyle = pose.color || DIR_DEFAULTS.color;
    ctx.lineWidth = lw * 1.5;
    ctx.beginPath();
    ctx.moveTo(-ux * R * 0.16, -uy * R * 0.16);
    ctx.lineTo(shaftEnd.x, shaftEnd.y);
    ctx.stroke();
    const px = -uy, py = ux;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(shaftEnd.x + px * head * 0.42, shaftEnd.y + py * head * 0.42);
    ctx.lineTo(shaftEnd.x - px * head * 0.42, shaftEnd.y - py * head * 0.42);
    ctx.closePath();
    ctx.fillStyle = pose.color || DIR_DEFAULTS.color;
    ctx.fill();

    // 滚转环: 垂直于箭头的一个圆, 加一根指向 up 的短刻度 —— 没有它, 第三个自由度在画面上不存在。
    const pts = dirHandlePoints(W, H, pose);
    const fin = pts.finR;
    const v = dirVecOf(pose);
    const { b1, b2 } = dirRollBasis(pose);
    ctx.strokeStyle = DIR_FIN;
    ctx.lineWidth = lw;
    ctx.globalAlpha = dim * 0.9;
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
        const a = i / 24 * Math.PI * 2;
        const co = Math.cos(a), si = Math.sin(a);
        const p = dirProject({
            x: v.x * 0.6 + (b1.x * co + b2.x * si) * fin / R,
            y: v.y * 0.6 + (b1.y * co + b2.y * si) * fin / R,
            z: v.z * 0.6 + (b1.z * co + b2.z * si) * fin / R,
        }, R);
        if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pts.finCentre.x, pts.finCentre.y);
    ctx.lineTo(pts.roll.x, pts.roll.y);
    ctx.stroke();
    ctx.globalAlpha = dim;

    if (o.chrome) {
        for (const key of ['yaw', 'pitch', 'roll']) {
            const p = pts[key];
            const on = o.state === key;
            const hot = o.hover === key;
            ctx.beginPath();
            ctx.arc(p.x, p.y, DIR_HANDLE_R + (on ? 2 : 0), 0, Math.PI * 2);
            ctx.fillStyle = key === 'yaw' ? DIR_RING : key === 'pitch' ? DIR_ARC : DIR_FIN;
            ctx.globalAlpha = dim * (on ? 1 : hot ? 0.9 : 0.75);
            ctx.fill();
            if (on || hot) {
                ctx.globalAlpha = dim * 0.35;
                ctx.lineWidth = 5;
                ctx.strokeStyle = ctx.fillStyle;
                ctx.stroke();
            }
            ctx.globalAlpha = dim;
        }
        if (o.readout) {
            ctx.font = '11px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillStyle = '#e8e8ee';
            ctx.strokeStyle = 'rgba(0,0,0,0.8)';
            ctx.lineWidth = 3;
            const p = pts[o.state || o.hover] || pts.pitch;
            ctx.strokeText(o.readout, p.x, p.y - DIR_HANDLE_R - 6);
            ctx.fillText(o.readout, p.x, p.y - DIR_HANDLE_R - 6);
        }
    }
    ctx.restore();
}

// ---- 图层像素 ----
// 与文字层同一条规矩: 描述符 + 盒子决定像素, 存档只存描述符, 渲染从不入档。
// 盒子是 1:1 的正方参考盒 (箭头是个记号, 不该被各向异性的盒子拉扁), 所以 nat 与 w/h 无关。
function dirNaturalBox() { return { w: 256, h: 256 }; }

function renderDirectionBuffer(desc, w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    const ctx = c.getContext('2d');
    if (ctx) drawDirectionGizmo(ctx, c.width, c.height, desc, {});
    return c;
}

// 盒子→缓冲: 每次判两下, 没动就原样返回。换的是新画布, 从不就地重画,
// 于是一步 undo 指着的那块缓冲永远还是它当时看到的样子。
function syncDirectionBuffer(l) {
    const desc = l.dir;
    const tr = l.transform;
    if (!canvasW || !canvasH || !desc || !tr) return;
    const w = Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.round(tr.w * canvasW)));
    const h = Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.round(tr.h * canvasH)));
    const key = JSON.stringify([desc.yaw, desc.pitch, desc.roll, desc.color]);
    if (l.dirCache && l.dirCache.key === key && l.dirCache.img === l.img
        && l.dirCache.w === w && l.dirCache.h === h) return;
    const prev = l.img;
    const img = renderDirectionBuffer(desc, w, h);
    l.img = img;
    if (prev && (prev.width !== img.width || prev.height !== img.height)) {
        if (l.mask) { l.mask = stretchSurfaceTo(l.mask, img.width, img.height); l.maskCtx = l.mask.getContext('2d'); }
        if (l.decal) { l.decal = stretchSurfaceTo(l.decal, img.width, img.height); l.decalCtx = l.decal.getContext('2d'); }
    }
    l.dirCache = { key, w, h, img };
}

function patchDirectionLayer(l, patch, opts) {
    l.dir = Object.assign({}, l.dir, patch);
    syncDirectionBuffer(l);
    if (!(opts && opts.silent)) {
        render();
        if (!(opts && opts.live)) renderLayerList();
    }
}

// ---- Direction 工具小窗 ----
// 把手的拖动是**受约束**的: yaw 直接按指针在地平环上取角, pitch / roll 沿各自轨道的切线走
// (正交俯视相机在 yaw 90°/270° 处把仰角那条弧投成一条竖线, 那里"从指针反解 pitch"根本不可逆;
// 切线增量没有奇点, 指针沿轨道走多少把手就走多少)。
function dirRingAngleAt(W, H, pt) {
    const R = gizmoRadius(W, H);
    return dirWrap360(dirDeg(Math.atan2(pt.y / Math.sin(DIR_TILT), pt.x)));
}
function dirArcTangent(pose) {
    const t = dirRad(pose.yaw), p = dirRad(pose.pitch);
    const d = {
        x: -Math.sin(p) * Math.cos(t),
        y: Math.cos(p),
        z: -Math.sin(p) * Math.sin(t),
    };
    const s = dirProject(d, 1);
    const n = Math.hypot(s.x, s.y) || 1;
    return { x: s.x / n, y: s.y / n };
}
function dirRollTangent(pose) {
    const { b1, b2 } = dirRollBasis(pose);
    const r = dirRad(pose.roll);
    const co = Math.cos(r), si = Math.sin(r);
    const d = {
        x: -b1.x * si + b2.x * co, y: -b1.y * si + b2.y * co, z: -b1.z * si + b2.z * co,
    };
    const s = dirProject(d, 1);
    const n = Math.hypot(s.x, s.y) || 1;
    return { x: s.x / n, y: s.y / n };
}
// 把一次指针位移折成该轴的增量。Shift 吸到 15° (与视图旋转同一个刻度)。
function dirAxisDelta(axis, W, H, pose, pt, prev) {
    const R = gizmoRadius(W, H);
    if (axis === 'yaw') {
        let next = dirRingAngleAt(W, H, pt);
        if (prev && prev.shiftKey) next = Math.round(next / 15) * 15 % 360;
        return { yaw: next };
    }
    const tan = axis === 'pitch' ? dirArcTangent(pose) : dirRollTangent(pose);
    const arc = ((pt.x - prev.pt.x) * tan.x + (pt.y - prev.pt.y) * tan.y) / R;
    const key = axis === 'pitch' ? 'pitch' : 'roll';
    let next = pose[key] + dirDeg(arc);
    if (prev && prev.shiftKey) next = Math.round(next / 15) * 15;
    if (key === 'pitch') next = Math.max(-90, Math.min(90, next));
    else next = ((next + 180) % 360 + 360) % 360 - 180;
    return { [key]: next };
}

function dirHitHandle(W, H, pose, pt) {
    const pts = dirHandlePoints(W, H, pose);
    let best = null, bestD = DIR_HIT_R;
    for (const key of ['pitch', 'roll', 'yaw']) {
        const d = Math.hypot(pt.x - pts[key].x, pt.y - pts[key].y);
        if (d <= bestD) { best = key; bestD = d; }
    }
    return best;
}

const dirGizmoCanvas = document.getElementById('dirGizmo');
const dirGizmoColor = document.getElementById('dirColorInput');
const dirGizmoColorValue = document.getElementById('dirColorValue');
const dirGizmoReset = document.getElementById('dirResetBtn');
let dirDrag = null;
let dirHover = null;

function dirGizmoPose() {
    const l = dirGizmoTarget();
    return l ? l.dir : DIR_DEFAULTS;
}
function dirGizmoTarget() {
    const l = typeof getLayer === 'function' ? getLayer(selectedId) : null;
    return isDirectionLayer(l) ? l : null;
}

function drawDirGizmo() {
    if (!dirGizmoCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = dirGizmoCanvas.clientWidth || 288;
    const H = DIR_GIZMO_H;
    if (dirGizmoCanvas.width !== Math.round(W * dpr) || dirGizmoCanvas.height !== Math.round(H * dpr)) {
        dirGizmoCanvas.width = Math.round(W * dpr);
        dirGizmoCanvas.height = Math.round(H * dpr);
    }
    const ctx = dirGizmoCanvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const pose = dirGizmoPose();
    const target = dirGizmoTarget();
    const readout = dirDrag
        ? `${dirDrag.axis === 'yaw' ? 'Yaw' : dirDrag.axis === 'roll' ? 'Roll' : 'Pitch'} ${Math.round(pose[dirDrag.axis])}°`
        : null;
    drawDirectionGizmo(ctx, W, H, pose, {
        chrome: true,
        dim: !target,
        hover: dirDrag ? dirDrag.axis : dirHover,
        state: dirDrag && dirDrag.axis,
        readout,
    });
}

function dirGizmoPoint(ev) {
    const r = dirGizmoCanvas.getBoundingClientRect();
    const W = dirGizmoCanvas.clientWidth || 288;
    return { x: ev.clientX - r.left - W / 2, y: ev.clientY - r.top - DIR_GIZMO_H / 2 };
}

if (dirGizmoCanvas) {
    dirGizmoCanvas.addEventListener('mousedown', ev => {
        const l = dirGizmoTarget();
        if (!l || ev.button !== 0) return;
        const pt = dirGizmoPoint(ev);
        const axis = dirHitHandle(dirGizmoCanvas.clientWidth || 288, DIR_GIZMO_H, l.dir, pt);
        if (!axis) return;
        ev.preventDefault();
        dirDrag = { axis, pt, layerId: l.id, moved: false, shiftKey: ev.shiftKey };
        drawDirGizmo();
    });
    window.addEventListener('mousemove', ev => {
        if (dirDrag && ev.buttons === 0) endDirGizmoDrag(ev);
        if (!dirDrag) return;
        const l = getLayer(dirDrag.layerId);
        if (!l) { dirDrag = null; return; }
        const W = dirGizmoCanvas.clientWidth || 288;
        const pt = dirGizmoPoint(ev);
        // 吸附加在**这一帧**的 Shift 上, 不是上一帧: 先记下按键再算增量, 而从按下起就按着 Shift
        // 拖第一下就该吸住 (dirAxisDelta 要的是 prev.pt, 所以只有它留在赋值之前)。
        dirDrag.shiftKey = ev.shiftKey;
        const patch = dirAxisDelta(dirDrag.axis, W, DIR_GIZMO_H, l.dir, pt, dirDrag);
        dirDrag.pt = pt;
        dirDrag.moved = true;
        patchDirectionLayer(l, patch, { live: true });
        drawDirGizmo();
    });
    window.addEventListener('mouseup', ev => { if (dirDrag) endDirGizmoDrag(ev); });
    dirGizmoCanvas.addEventListener('mousemove', ev => {
        if (dirDrag) return;
        const l = dirGizmoTarget();
        const hit = l ? dirHitHandle(dirGizmoCanvas.clientWidth || 288, DIR_GIZMO_H, l.dir, dirGizmoPoint(ev)) : null;
        if (hit === dirHover) return;
        dirHover = hit;
        dirGizmoCanvas.style.cursor = hit ? 'grab' : 'default';
        drawDirGizmo();
    });
    dirGizmoCanvas.addEventListener('mouseleave', () => {
        if (dirHover === null) return;
        dirHover = null;
        drawDirGizmo();
    });
}

function endDirGizmoDrag() {
    if (!dirDrag) return;
    const l = getLayer(dirDrag.layerId);
    const moved = dirDrag.moved;
    dirDrag = null;
    if (l && moved) {
        renderLayerList();
        pushHistory('direction-' + dirDragAxisKey(l.dir));
    }
    drawDirGizmo();
}
function dirDragAxisKey(pose) {
    return `${Math.round(pose.yaw)}_${Math.round(pose.pitch)}_${Math.round(pose.roll)}`;
}

function updateDirectionPanel() {
    const l = dirGizmoTarget();
    const section = document.getElementById('directionSection');
    if (section) section.classList.toggle('active-tool', !!l);
    if (dirGizmoColor) {
        dirGizmoColor.disabled = !l;
        if (l) dirGizmoColor.value = l.dir.color;
    }
    if (dirGizmoColorValue) dirGizmoColorValue.textContent = l ? l.dir.color.toUpperCase() : '';
    if (dirGizmoReset) dirGizmoReset.disabled = !l;
    drawDirGizmo();
}

if (dirGizmoColor) {
    dirGizmoColor.addEventListener('input', () => {
        const l = dirGizmoTarget();
        if (!l) return;
        patchDirectionLayer(l, { color: dirGizmoColor.value }, { live: true });
        if (dirGizmoColorValue) dirGizmoColorValue.textContent = dirGizmoColor.value.toUpperCase();
    });
    dirGizmoColor.addEventListener('change', () => {
        const l = dirGizmoTarget();
        if (l) pushHistory();
    });
}
if (dirGizmoReset) {
    dirGizmoReset.addEventListener('click', () => {
        const l = dirGizmoTarget();
        if (!l) return;
        patchDirectionLayer(l, { yaw: DIR_DEFAULTS.yaw, pitch: DIR_DEFAULTS.pitch, roll: DIR_DEFAULTS.roll });
        setStatus(`「${l.name}」pointed back to the default`, 'success');
    });
}
