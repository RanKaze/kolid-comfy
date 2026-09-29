// Direction 图层 —— 同一个姿态, 两种观察。
//   小窗 = **世界里的观察**: 画布是躺在世界里的一张平面 (按 canvasW:canvasH 的真实比例画出来,
//          铺在 360° 方位环里), 环 = 绕平面一圈的 yaw 轨道, 青绿弧 = pitch 轨道, 琥珀环 = roll 轨道,
//          三颗把手就长在这上面。相机是一条固定 25° 俯角的正交视线, 地平环因此压成 ry = R·sin ε 的椭圆。
//   图层像素 = **画布空间的观察**: 顺着画布法线正面看过去 —— 画布平面铺满画面, 箭头是世界方向落在
//          画布里的投影 (pitch 越大它越短, 90° 时只剩箭头尖在中心 = "正对画布外"), 角弧从画布 +X
//          量到箭头, 度数直接烘进像素。
// 两边共用同一套姿态数学 (dirVecOf / dirRollBasis / dirProject) 与同一批颜色, 但**不是同一次绘制**:
// 观察的相机本来就不同, 把它们画成一张图反而读不出"相对画布的角度"这句话。
//
// 角度基跟着特效链已有的那条规矩: Yaw 0° = 画布右、90° = 画布下 (与 Lighting 的 Angle、
// fxglDirUV 同一个基); Pitch 是抬离画布平面的角度 (0 = 贴着平面, 90 = 顺着法线朝观察者);
// Roll 是箭头绕自身轴转 (从"鳍朝上"起算)。

const DIR_DEFAULTS = { yaw: 135, pitch: 25, roll: 0, color: '#ff2e88' };
const DIR_TILT = 25 * Math.PI / 180;
const DIR_RING = '#e0247a';
const DIR_ARC = '#19e0bc';
const DIR_FIN = '#f5c542';
const DIR_PLANE = '#8b93a7';      // 画布平面本身: 中性灰蓝, 不跟任何一根轨道抢颜色
const DIR_HANDLE_R = 6.5;         // 把手在屏幕上恒定大小, 不随图层盒子/缩放变 (与 warp 把手同一条)
const DIR_HIT_R = 11;
const DIR_GIZMO_H = 176;
// 箭头尖端与仰角弧走的是比地平环更大的那颗球 (环 1.0 : 弧 1.3)。参照图里弧之所以卷到环外、
// 两者不挤成一团, 就是这个半径差; 箭头因此也比纯按环长投影出来的那一截更认得出来。
const DIR_POSE_R = 1.3;

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
// 环的半径: 外面那圈姿态球是它的 1.3 倍 (DIR_POSE_R), 所以 0.34 而不是更大 —— 箭头尖不能出画。
function gizmoRadius(W, H) { return Math.min(W, H) * 0.34; }

// 画布平面的比例永远取自画布自己; 图层盒子与小窗都只是取景框, 不许把平面拉扁。
function dirCanvasAspect() { return canvasW && canvasH ? canvasW / canvasH : 1; }

// 世界观察里画布平面的四角 (屏幕像素, 中心为原点)。半对角线取 0.92R, 于是四角正好落在方位环内侧
// —— "画布就是躺在这个世界里的那张矩形"是靠它与环的比例关系读出来的, 不靠文字说明。
function dirPlaneCorners(R) {
    const a = dirCanvasAspect(), d = 0.92 * R, n = Math.hypot(a, 1);
    const hw = d * a / n, hd = d / n;
    return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]
        .map(([x, z]) => dirProject({ x, y: 0, z }, 1));
}

// 滚转环上角度 a 处的点 (像素, 以小窗中心为原点)。环心沿箭头走到 60% 处, 环本身垂直于箭头。
// 画这颗环、放这颗把手、以及探针回读像素都从这里取点 —— 不在别处重算一遍同一颗环。
function dirFinPoint(pose, R, a) {
    const { b1, b2 } = dirRollBasis(pose);
    const v = dirVecOf(pose);
    const co = Math.cos(a), si = Math.sin(a);
    const c = 0.6 * DIR_POSE_R * R;
    const f = 0.17 * R;
    return dirProject({
        x: v.x * c + (b1.x * co + b2.x * si) * f,
        y: v.y * c + (b1.y * co + b2.y * si) * f,
        z: v.z * c + (b1.z * co + b2.z * si) * f,
    }, 1);
}

// 三颗把手在画布上的落点 (CSS 像素, 以小窗画布中心为原点)。
function dirHandlePoints(W, H, pose) {
    const R = gizmoRadius(W, H);
    const tip = dirTip(pose, R * DIR_POSE_R);
    return {
        R,
        yaw: dirOnRing(pose.yaw, R),
        pitch: tip,
        roll: dirFinPoint(pose, R, dirRad(pose.roll)),
        finCentre: { x: tip.x * 0.6, y: tip.y * 0.6 },
        finR: R * 0.17,
    };
}

// ---- 观察一: 世界里的姿态把手图 (只有小窗画它) ----
// opts.chrome = 画那几颗可拖把手; opts.state = 哪一颗正被按下/悬停; opts.dim = 没人在编辑。
function drawDirectionWorld(ctx, W, H, pose, opts) {
    const o = opts || {};
    const R = gizmoRadius(W, H);
    const dim = o.dim ? 0.32 : 1;
    const lw = Math.max(1.4, R * 0.035);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 画布平面: 躺在地上的一张真比例矩形, 加一条 0° 参考边 (画布 +X, 即中心到右边缘中点)。
    // 没有它, 环上的角度就只是"绕一圈", 读不出是相对谁绕的。
    const corners = dirPlaneCorners(R);
    const hw = corners[1].x;                     // 画布右半宽 (屏幕上就是它, 正交投影不改变 x)
    ctx.globalAlpha = dim * 0.1;
    ctx.fillStyle = DIR_PLANE;
    ctx.beginPath();
    corners.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = dim * 0.5;
    ctx.strokeStyle = DIR_PLANE;
    ctx.lineWidth = lw * 0.7;
    ctx.stroke();
    ctx.setLineDash([lw * 1.2, lw * 1.4]);
    ctx.globalAlpha = dim * 0.62;
    ctx.strokeStyle = DIR_RING;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(hw, 0);
    ctx.stroke();
    ctx.setLineDash([]);

    // 地平环: 绕这张平面一圈的 360° 方位轨道。
    ctx.globalAlpha = dim;
    ctx.strokeStyle = DIR_RING;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.ellipse(0, 0, R, R * Math.sin(DIR_TILT), 0, 0, Math.PI * 2);
    ctx.stroke();

    // 箭头落在地面上的投影: 没有它, pitch 就只是"短了一点", 读不出抬起来了。
    // 长度跟着姿态球那圈走 (Rt·cosφ), 所以虚线的端点正落在箭头尖底下, 而不是环上。
    const Rt = R * DIR_POSE_R;
    const foot = dirOnRing(pose.yaw, Rt * Math.cos(dirRad(pose.pitch)));
    ctx.setLineDash([lw * 1.6, lw * 1.8]);
    ctx.globalAlpha = dim * 0.55;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(foot.x, foot.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = dim;

    // 仰角弧: 先淡淡描出整条 -90..90 的轨道 (参照图里那道扫出环外的长弧), 再沿当前方位把亮色
    // 那段画到现在的仰角 —— 只看亮段读得出"抬了多少", 只看整条才读得出"还能往哪儿拖"。
    const steps = 28;
    ctx.strokeStyle = DIR_ARC;
    ctx.lineWidth = lw;
    const arcAt = t => dirProject({
        x: Math.cos(t) * Math.cos(dirRad(pose.yaw)),
        y: Math.sin(t),
        z: Math.cos(t) * Math.sin(dirRad(pose.yaw)),
    }, Rt);
    ctx.globalAlpha = dim * 0.26;
    ctx.beginPath();
    for (let i = 0; i <= 36; i++) {
        const p = arcAt(dirRad(-90 + i * 5));
        if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.globalAlpha = dim;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
        const p = arcAt(dirRad(pose.pitch) * i / steps);
        if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
    }
    ctx.stroke();

    // 箭头本体 (图层颜色) + 头部两片倒钩, 都在屏幕上量, 所以粗细与盒子同步缩放。
    const tip = dirTip(pose, Rt);
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
    ctx.strokeStyle = DIR_FIN;
    ctx.lineWidth = lw;
    ctx.globalAlpha = dim * 0.9;
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
        const p = dirFinPoint(pose, R, i / 24 * Math.PI * 2);
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

// ---- 观察二: 画布空间的正面图 (图层自己的像素) ----
// 顺着画布法线看过去: 画布平面 = 铺满画面的那张真比例矩形, 角度全在矩形里量。
// 箭头是世界方向落进画布的投影 ⇒ 长度天然乘 cos(pitch) (抬头到 90° 就只剩箭头尖在中心, 那正是
// "方向冲着画布外来"); 后面那条等长的淡虚线是它的真长参照, 没有它短掉的一截只会被读成"箭头短了"。
function drawDirectionPlan(ctx, W, H, pose) {
    const a = dirCanvasAspect();
    let pw = W * 0.94, ph = pw / a;
    if (ph > H * 0.94) { ph = H * 0.94; pw = ph * a; }
    const Rp = Math.min(pw, ph) / 2 * 0.86;
    const lw = Math.max(1.4, Rp * 0.045);
    const t = dirRad(pose.yaw), co = Math.cos(dirRad(pose.pitch));
    const ux = Math.cos(t), uy = Math.sin(t);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.globalAlpha = 0.08;
    ctx.fillStyle = DIR_PLANE;
    ctx.fillRect(-pw / 2, -ph / 2, pw, ph);
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = DIR_PLANE;
    ctx.lineWidth = lw * 0.7;
    ctx.strokeRect(-pw / 2, -ph / 2, pw, ph);

    // 0° 参考边 = 画布 +X (中心到右边缘中点)。角弧从这条边起量, 所以两者必须同色。
    ctx.setLineDash([lw * 1.2, lw * 1.4]);
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = DIR_RING;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(pw / 2, 0);
    ctx.stroke();
    // 真长参照: 同一方向上一直画到 Rp。
    ctx.globalAlpha = 0.28;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(ux * Rp, uy * Rp);
    ctx.stroke();
    ctx.setLineDash([]);

    // 角弧 + 度数: 这张图要说的话就是"相对画布转了多少度", 所以度数烘进像素, 不留在面板里。
    const Ra = Rp * 0.44;
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.arc(0, 0, Ra, 0, t, false);
    ctx.stroke();
    const fs = Math.max(11, Rp * 0.15);
    const mid = t / 2;
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f2f2f6';
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = fs * 0.18;
    const label = `${Math.round(pose.yaw)}\u00b0`;
    ctx.strokeText(label, Math.cos(mid) * Ra * 1.34, Math.sin(mid) * Ra * 1.34);
    ctx.fillText(label, Math.cos(mid) * Ra * 1.34, Math.sin(mid) * Ra * 1.34);

    // 箭头本体 (图层颜色)。
    const col = pose.color || DIR_DEFAULTS.color;
    const tip = { x: ux * Rp * co, y: uy * Rp * co };
    const head = Math.max(6, Rp * 0.22);
    const shaftEnd = { x: tip.x - ux * head * 0.62, y: tip.y - uy * head * 0.62 };
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.globalAlpha = 1;
    ctx.lineWidth = lw * 1.6;
    ctx.beginPath();
    ctx.moveTo(shaftEnd.x, shaftEnd.y);
    ctx.lineTo(0, 0);
    ctx.stroke();
    const px = -uy, py = ux;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(shaftEnd.x + px * head * 0.44, shaftEnd.y + py * head * 0.44);
    ctx.lineTo(shaftEnd.x - px * head * 0.44, shaftEnd.y - py * head * 0.44);
    ctx.closePath();
    ctx.fill();

    // 滚转: 箭头自己那根"鳍"在画布里的朝向 (把垂直于箭头的侧向基投影到画布平面上)。
    // 画在箭头之后是必须的: b1 是 up 去掉沿箭头分量得到的, 而 up 在画布平面里没有投影,
    // 所以 roll=0 时这根鳍正好**叠在箭杆上** —— 先画就会被箭杆盖成"没有滚转这回事"。
    const { b1, b2 } = dirRollBasis(pose);
    const r = dirRad(pose.roll);
    const rx = (b1.x * Math.cos(r) + b2.x * Math.sin(r)) * Rp * 0.26;
    const ry = (b1.z * Math.cos(r) + b2.z * Math.sin(r)) * Rp * 0.26;
    const shoulder = { x: ux * Rp * co * 0.55, y: uy * Rp * co * 0.55 };
    ctx.strokeStyle = DIR_FIN;
    ctx.lineWidth = lw;
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.moveTo(shoulder.x, shoulder.y);
    ctx.lineTo(shoulder.x + rx, shoulder.y + ry);
    ctx.stroke();
    ctx.restore();
}

// ---- 图层像素 ----
// 与文字层同一条规矩: 描述符 + 盒子决定像素, 存档只存描述符, 渲染从不入档。
// 盒子只是取景框: 平面按画布比例 contain 进去, 所以拉扁盒子拉不扁画布。
function dirNaturalBox() { return { w: 256, h: 256 }; }

function renderDirectionBuffer(desc, w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    const ctx = c.getContext('2d');
    if (ctx) drawDirectionPlan(ctx, c.width, c.height, desc);
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
    // 画布比例现在也是画面的一部分 (那张平面按它画), 所以改画布尺寸必须重烘 —— key 里带上它。
    const key = JSON.stringify([desc.yaw, desc.pitch, desc.roll, desc.color, canvasW / canvasH]);
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
    // 增量按各自轨道自己的半径折算, 把手才真正走在指针底下: 仰角弧在 Rt 那圈上, 滚转把手在
    // 0.17R 的滚转环上 (环小, 所以滚转天然比另外两轴快 —— 与它画出来的那颗小环一致)。
    const track = axis === 'pitch' ? R * DIR_POSE_R : R * 0.17;
    const arc = ((pt.x - prev.pt.x) * tan.x + (pt.y - prev.pt.y) * tan.y) / track;
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
// 三格直接填数字的角度 field, 与 RGBA 那四格同一套词汇。填进来的值仍旧过
// sanitizeDirectionDescriptor 那道唯一的形状裁定: 打 999 是绕到 279°, 不是把读数卡死在边界上。
const dirAngleFields = [
    { key: 'yaw', input: document.getElementById('dirYawNum') },
    { key: 'pitch', input: document.getElementById('dirPitchNum') },
    { key: 'roll', input: document.getElementById('dirRollNum') },
];
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
    drawDirectionWorld(ctx, W, H, pose, {
        chrome: true,
        dim: !target,
        hover: dirDrag ? dirDrag.axis : dirHover,
        state: dirDrag && dirDrag.axis,
        readout,
    });
    syncDirectionFields();
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

// 拖把手与填数字读写的是同一份 l.dir, 所以两边都得能改写对方: 每帧画完小窗就把三格读数跟上。
// 正在打字那一格除外 —— 拖一圈把手不该把用户刚敲进去的"13"变成"135"。
function syncDirectionFields() {
    const l = dirGizmoTarget();
    const pose = l ? l.dir : null;
    for (const f of dirAngleFields) {
        if (!f.input) continue;
        f.input.disabled = !l;
        if (!pose || document.activeElement === f.input) continue;
        const v = String(Math.round(pose[f.key]));
        if (f.input.value !== v) f.input.value = v;
    }
}

for (const f of dirAngleFields) {
    if (!f.input) continue;
    f.input.addEventListener('input', () => {
        const l = dirGizmoTarget();
        if (!l) return;
        const n = Number(f.input.value);
        if (f.input.value === '' || !Number.isFinite(n)) return;
        const next = sanitizeDirectionDescriptor(Object.assign({}, l.dir, { [f.key]: n }));
        if (next[f.key] === l.dir[f.key]) return;
        patchDirectionLayer(l, { [f.key]: next[f.key] }, { live: true });
        drawDirGizmo();
    });
    f.input.addEventListener('change', () => {
        const l = dirGizmoTarget();
        if (!l) return;
        f.input.value = String(Math.round(l.dir[f.key]));   // 回读被折回/夹断之后的实际读数
        renderLayerList();
        pushHistory();
    });
}
