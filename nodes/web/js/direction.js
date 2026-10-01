// Direction / Point / Ray / Plane 小窗 —— 同一个世界, 四种观察, 一扇窗。
//   小窗 = **世界里的观察**: 一张 three.js 场景 (js/direction_view.js, 引擎仍是仓库里 vendored 的
//          window.K3D)。画布是躺在地面上的那张平面 mesh, 上面贴着**此刻的 context image** (唯独不含
//          正在编辑的这一枚 —— 否则它的标记会烘进自己的参考面里)。四个类型的对象与把手挂在这张平面
//          上: direction 是环/弧/滚转环/箭头 (没有位置, 钉在原点), point 是一颗球 + 落地线,
//          ray 是球 + 箭头, plane 是圆盘 + 法线短箭。按住中键拖动转的是**眼睛** (相机绕原点轨道),
//          不是对象; 左键拖把手才改描述符。K3D 没进来或建不起 WebGL 上下文时, 退到本文件里那张
//          drawGeometryWorld 的 2D 世界图 (固定 25° 俯角的正交视线) —— 同一套世界坐标, 两种画法。
//   图层像素 = **画布空间的观察**: 顺着画布法线正面看过去 —— 画布平面铺满画面, 对象按世界坐标投影
//          落位, 读数直接烘进像素 (direction 的箭头/角弧在 drawDirectionPlan; 家族三枚在
//          attr/geometry.js 的 drawGeometryPlan)。
// 两边共用下面这一套世界坐标: 画布 = y=0 那张平面 (地平环半径 = 1 个世界单位), x 右、y 上、z 朝
// 画布下侧; 位置用画布归一化 {u,v} + 离面高度 h (单位 = 画布高), 方向用 direction 的同一套
// yaw/pitch/roll。角度基跟着特效链已有的那条规矩: Yaw 0° = 画布右、90° = 画布下 (与 Lighting 的
// Angle、fxglDirUV 同一个基); Pitch 是抬离画布平面的角度 (0 = 贴着平面, 90 = 顺着法线朝观察者)。

// ---- 四元数: 家族对象朝向的唯一真相 ----
// 每个对象存 {position: {x,y,z}, rotation: {x,y,z,w}} —— 旋转一律四元数合成 (world 轴左乘,
// local 轴右乘); 欧拉 (yaw/pitch/roll) 只是面板读写与旧档转换的边缘表示。
function quatToMat(q) {
    const { x, y, z, w } = q, x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    return [
        1 - (yy + zz), xy - wz, xz + wy,
        xy + wz, 1 - (xx + zz), yz - wx,
        xz - wy, yz + wx, 1 - (xx + yy),
    ];
}
function matToQuat(m) {
    const tr = m[0] + m[4] + m[8];
    let x, y, z, w;
    if (tr > 0) {
        const s = Math.sqrt(tr + 1) * 2;
        w = s / 4; x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s;
    } else if (m[0] > m[4] && m[0] > m[8]) {
        const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
        w = (m[7] - m[5]) / s; x = s / 4; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s;
    } else if (m[4] > m[8]) {
        const s = Math.sqrt(1 - m[0] + m[4] - m[8]) * 2;
        w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = s / 4; z = (m[5] + m[7]) / s;
    } else {
        const s = Math.sqrt(1 - m[0] - m[4] + m[8]) * 2;
        w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = s / 4;
    }
    return { x, y, z, w };
}
function qNormalize(q) {
    const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
    return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}
function qMul(a, b) {
    return {
        w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
        x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
        y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
        z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    };
}
function qFromAxisAngle(A, th) {
    const l = Math.hypot(A.x, A.y, A.z) || 1;
    const s = Math.sin(th / 2);
    return { x: A.x / l * s, y: A.y / l * s, z: A.z / l * s, w: Math.cos(th / 2) };
}
function qApply(q, v) { return matMulVec(quatToMat(q), v); }
// 欧拉只在这两处与四元数见面: 面板读写与旧档转换。走 orientMatrix/decomposeOrient 同一套
// 矩阵约定, 两个方向的读数逐位一致。
function qFromEuler(yaw, pitch, roll) {
    return qNormalize(matToQuat(orientMatrix({ yaw, pitch, roll })));
}
function geoEuler(q) { return decomposeOrient(quatToMat(qNormalize(q))); }
function sanitizeQuat(raw, fb) {
    if (raw && [raw.x, raw.y, raw.z, raw.w].every(Number.isFinite)) {
        const l = Math.hypot(raw.x, raw.y, raw.z, raw.w);
        if (l > 1e-9) return { x: raw.x / l, y: raw.y / l, z: raw.z / l, w: raw.w / l };
    }
    return fb;
}

const DIR_DEFAULTS = { rotation: qFromEuler(135, 25, 0), color: '#ff2e88' };
const DIR_TILT = 25 * Math.PI / 180;
const DIR_RING = '#e0247a';
const DIR_ARC = '#19e0bc';
const DIR_FIN = '#f5c542';
const DIR_PLANE = '#8b93a7';      // 画布平面本身: 中性灰蓝, 不跟任何一根轨道抢颜色
const DIR_FRONT = '#30d158';      // Y 轴线: 画布中心沿 +Y 的细线 (绿 = 世界 Y 轴, 与三向轴的绿同一支)
const DIR_HANDLE_R = 6.5;         // 把手在屏幕上恒定大小, 不随图层盒子/缩放变 (与 warp 把手同一条)
const DIR_HIT_R = 11;
const DIR_STAGE_W = 696;          // 小窗舞台的 CSS 尺寸回退值 (实际从 #dirStage 量)
const DIR_STAGE_H = 420;
// 箭头尖端与仰角弧走的是比地平环更大的那颗球 (环 1.0 : 弧 1.3)。参照图里弧之所以卷到环外、
// 两者不挤成一团, 就是这个半径差; 箭头因此也比纯按环长投影出来的那一截更认得出来。
const DIR_POSE_R = 1.3;
// 滚转环: 环心沿箭头走到姿态球的 0.6 处, 环自己的半径是地平环的 0.17 —— 都是"环半径 = 1"这套
// 世界单位里的比例, 所以 2D 世界图与 three.js 场景挂的是同一个位置、同一个大小。
const DIR_FIN_C = 0.6;
const DIR_FIN_R = 0.17;

// ---- geometry 家族 (direction 之外的三枚) 的世界常量 ----
const GEO_KINDS = ['direction', 'point', 'ray', 'plane'];
const GEO_BALL_R = 0.055;         // point/ray/plane 起点那颗球 (世界单位)
const GEO_DISC_R = 0.45;          // plane 取景圆盘的半径
const GEO_AXIS_L = 0.45;          // 三向轴把手的臂长 (世界单位)
const ROT_R = 0.62;               // 旋转环半径 (Unity 风格: 环绕对象一圈)
const ROT_SAMPLES = 40;           // 每根环的采样点数 (命中判定与 2D 画法共用)
// 把手轴各有一色: 移动/旋转共用同一套 gizmo 配色 (红=X, 绿=Y, 蓝=Z), 与转向的粉/青/黄互不重色。
const FAM_HANDLE_COLORS = { yaw: DIR_RING, pitch: DIR_ARC, roll: DIR_FIN, mvX: '#ff453a', mvY: '#30d158', mvZ: '#0a84ff', rotX: '#ff453a', rotY: '#30d158', rotZ: '#0a84ff' };
const DIR_AXIS_LABEL = { yaw: 'Yaw', pitch: 'Pitch', roll: 'Roll', mvX: 'Move X', mvY: 'Move Y', mvZ: 'Move Z', rotX: 'Rotate X', rotY: 'Rotate Y', rotZ: 'Rotate Z' };

// 把手模式与空间 (Unity 同款): W = 移动, E = 旋转, X = 切 global/local (小窗开着时捕获, 见底部)。
let gizmoMode = 'move';           // 'move' | 'rotate'
let gizmoSpace = 'global';        // 'global' | 'local'

function dirRad(d) { return d * Math.PI / 180; }
function dirDeg(r) { return r * 180 / Math.PI; }
function dirWrap360(d) { return ((d % 360) + 360) % 360; }
// Roll 是绕箭头的一圈, 但它的读数写在 [-180,180) (与格子里那句一致), 所以折法与 yaw 不同。
function dirWrap180(d) { return ((d + 180) % 360 + 360) % 360 - 180; }

// 唯一的一处形状裁定: .cud 读回来或面板 patch 进来的东西先过这里, 坏字段退化到默认值,
// 而不是退化成一张画不出来的图层。
function sanitizeDirectionDescriptor(raw) {
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const color = /^#[0-9a-fA-F]{3,8}$/.test(String(raw && raw.color || '')) ? raw.color : DIR_DEFAULTS.color;
    if (!raw || typeof raw !== 'object') return { rotation: identity, color };
    // 新形状 = 四元数; 旧形状 ({yaw,pitch,roll}) 在这一道转换 —— 老档、老字段都读得懂。
    let q = sanitizeQuat(raw.rotation, null);
    if (!q && (Number.isFinite(Number(raw.yaw)) || Number.isFinite(Number(raw.pitch)))) {
        q = qFromEuler(Number(raw.yaw) || 0, Number(raw.pitch) || 0, Number(raw.roll) || 0);
    }
    return { rotation: q || sanitizeQuat(DIR_DEFAULTS.rotation, identity), color };
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
// ---- 世界坐标 (地平环半径 = 1 个单位) ----
// 这一组是小窗两种画法与图层像素共同的唯一一份真相: 2D 世界图把下面的点过 dirProject 乘上屏幕半径 R,
// three.js 场景直接把同样的点当成 mesh 的位置 (那里的环半径就是 1 个世界单位)。谁都不许再抄一遍公式。
function dirWorldAz(azDeg) {
    const t = dirRad(azDeg);
    return { x: Math.cos(t), y: 0, z: Math.sin(t) };
}
function dirScale(p, k) { return { x: p.x * k, y: p.y * k, z: p.z * k }; }
// 滚转环上角度 a 处的世界点: 环心沿箭头走到 DIR_FIN_C 处, 环半径 DIR_FIN_R (都是相对地平环的比例)。
function dirWorldFin(pose, a) {
    const v = dirVecOf(pose), { b1, b2 } = dirRollBasis(pose);
    const co = Math.cos(a), si = Math.sin(a);
    const c = dirScale(v, DIR_FIN_C * DIR_POSE_R), f = DIR_FIN_R;
    return {
        x: c.x + (b1.x * co + b2.x * si) * f,
        y: c.y + (b1.y * co + b2.y * si) * f,
        z: c.z + (b1.z * co + b2.z * si) * f,
    };
}
// 画布平面在世界里的半宽/半高 (y=0 那张平面上)。比例永远取自画布自己; 图层盒子与小窗都只是取景框,
// 不许把平面拉扁。
function dirPlaneHalf() {
    const a = dirCanvasAspect(), n = Math.hypot(a, 1);
    return { hw: 0.92 * a / n, hd: 0.92 / n };
}
// 一个姿态在世界里的全部落点。画布平面也在里面: 半对角线取 0.92 ⇒ 四角正好落在方位环内侧,
// "画布就是躺在这个世界里的那张矩形"靠它与环的比例关系读出来, 不靠文字说明。
function dirWorldPose(pose) {
    const v = dirVecOf(pose);
    return {
        dir: v,
        tip: dirScale(v, DIR_POSE_R),
        yaw: dirWorldAz(pose.yaw),
        roll: dirWorldFin(pose, dirRad(pose.roll)),
        finCentre: dirScale(v, DIR_FIN_C * DIR_POSE_R),
        finR: DIR_FIN_R,
        poseR: DIR_POSE_R,
        plane: dirPlaneHalf(),
    };
}
function dirOnRing(azDeg, R) {
    return dirProject(dirWorldAz(azDeg), R);
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

// ---- geometry 家族: 位置 ↔ 世界 ----
// 描述符里的 {u,v,h} 与世界 {x,y,z} 的唯一一份换算: (u,v) 铺在画布矩形上 (0 = 左/上边),
// h 沿世界 up 抬离平面, 单位 = 画布高。2D 退路、3D 场景、把手反解都从这里拿, 谁也不许自己再折一遍。
// plane 盘面的两条轴: b1 = up × n 摊平在画布上 (n 竖直时退化, 换 x 轴顶上), b2 = n × b1 补全。
// 一种对象在当前模式下亮哪几根把手: 移动模式给可挪的要素三向轴 (direction 没有位置, 不给);
// 旋转模式给有朝向的要素三根旋转环 (point 没朝向, 不给)。旧 yaw/pitch 把手被旋转环取代。
function famHandleKeys(state) {
    if (gizmoMode === 'rotate') {
        return state.kind === 'point' ? [] : ['rotX', 'rotY', 'rotZ'];
    }
    return state.kind === 'direction' ? [] : ['mvX', 'mvY', 'mvZ'];
}
// 对象自己的 local 轴 (有朝向的要素): Z' = 箭头/法线, Y' = up 在垂直面内的投影 (dirRollBasis
// 的 b1), X' = −b2 —— (X', Y', Z') 恰好构成右手系。point 没朝向, local 退到 global。
function objLocalAxes(d) {
    const q = d.rotation;
    return {
        mvX: qApply(q, { x: 1, y: 0, z: 0 }),
        mvY: qApply(q, { x: 0, y: 1, z: 0 }),
        mvZ: qApply(q, { x: 0, y: 0, z: 1 }),
    };
}
// 当前空间下三向轴/旋转环的世界轴向 (global = 世界 XYZ, local = 对象自己的轴)。
function moveAxes(state) {
    if (gizmoSpace === 'local' && state.kind !== 'point') return objLocalAxes(state.desc);
    return { mvX: { x: 1, y: 0, z: 0 }, mvY: { x: 0, y: 1, z: 0 }, mvZ: { x: 0, y: 0, z: 1 } };
}
// 把手轴 → 世界落点 (唯一的一份; 2D 退路过 dirProject, 3D 场景直接当 mesh 位置)。只归移动模式。
function famHandleWorld(state) {
    if (gizmoMode !== 'move' || state.kind === 'direction') return {};
    const p = state.desc.position;
    const axes = moveAxes(state);
    const out = {};
    for (const key of ['mvX', 'mvY', 'mvZ']) {
        const A = axes[key];
        out[key] = { x: p.x + A.x * GEO_AXIS_L, y: p.y + A.y * GEO_AXIS_L, z: p.z + A.z * GEO_AXIS_L };
    }
    return out;
}

// ---- 旋转环 (Unity 风格) ----
// 每根环 = 绕一根轴的旋转: global 模式绕世界 XYZ, local 模式绕对象自己的轴。环的世界采样点
// 一份两用: 投影到屏幕做命中判定, 2D 退路直接连线画环。
function rotPlaneBasis(A) {
    let e1 = { x: -A.z, y: 0, z: A.x };           // A × up 摊平 (A 竖直时退化, 换 X 轴顶上)
    let l = Math.hypot(e1.x, e1.z);
    if (l < 1e-4) { e1 = { x: 1, y: 0, z: 0 }; l = 1; }
    e1 = { x: e1.x / l, y: 0, z: e1.z / l };
    const e2 = {
        x: A.y * e1.z - A.z * e1.y,
        y: A.z * e1.x - A.x * e1.z,
        z: A.x * e1.y - A.y * e1.x,
    };
    const l2 = Math.hypot(e2.x, e2.y, e2.z) || 1;
    return { e1, e2: { x: e2.x / l2, y: e2.y / l2, z: e2.z / l2 } };
}
function rotRingAxes(state) {
    // 环每帧现读姿态: 抓住的那根轴 A = q0·e, 绕 A 的转动不动 A (Rot(A,θ)·A = A), 所以它不会从指针
    // 底下跑掉, 另外两根跟着对象摆 —— Unity 同款。整套冻结反而把这两根钉死了, 别加回来。
    const kind = state.kind;
    if (gizmoMode !== 'rotate' || kind === 'point') return [];
    let ax;
    if (gizmoSpace === 'local') {
        const la = objLocalAxes(state.desc);
        ax = [{ key: 'rotX', A: la.mvX }, { key: 'rotY', A: la.mvY }, { key: 'rotZ', A: la.mvZ }];
    } else {
        ax = [{ key: 'rotX', A: { x: 1, y: 0, z: 0 } }, { key: 'rotY', A: { x: 0, y: 1, z: 0 } },
            { key: 'rotZ', A: { x: 0, y: 0, z: 1 } }];
    }
    const c = kind === 'direction' ? { x: 0, y: 0, z: 0 } : state.desc.position;
    for (const a of ax) {
        const basis = rotPlaneBasis(a.A);
        a.center = c;
        a.samples = [];
        for (let i = 0; i < ROT_SAMPLES; i++) {
            const t = i / ROT_SAMPLES * Math.PI * 2;
            a.samples.push({
                x: c.x + (basis.e1.x * Math.cos(t) + basis.e2.x * Math.sin(t)) * ROT_R,
                y: c.y + (basis.e1.y * Math.cos(t) + basis.e2.y * Math.sin(t)) * ROT_R,
                z: c.z + (basis.e1.z * Math.cos(t) + basis.e2.z * Math.sin(t)) * ROT_R,
            });
        }
    }
    return ax;
}
function rotRingScreenPoints(state) {
    const { W, H } = dirStageSize();
    const R = gizmoRadius(W, H);
    return rotRingAxes(state).map(a => ({
        key: a.key,
        pts: a.samples.map(p => (DirView.live() ? DirView.project(p) : dirProject(p, R))).filter(Boolean),
    }));
}

// ---- (yaw, pitch, roll) ↔ 旋转矩阵 ----
// R = [arrow | b1 | b2] 三个列基组成的旋转矩阵 (roll = 0 的姿态), roll 是绕 arrow 的 M_x ——
// 与 dirRollBasis/dirWorldFin 的鳍读法逐位一致。旋转环拖拽 = W(轴, 角)·R0 再分解回欧拉读数。
function orientMatrix(d) {
    const a = dirVecOf(d), rb = dirRollBasis(d);
    const R0 = [a.x, rb.b1.x, rb.b2.x, a.y, rb.b1.y, rb.b2.y, a.z, rb.b1.z, rb.b2.z];
    // roll = 绕箭头自己那根轴的最后一段旋转: R = R0 · M_x(roll)。漏了它, 旋转环一拖 roll 就丢。
    return d.roll ? matMul(R0, axisAngleMat({ x: 1, y: 0, z: 0 }, dirRad(d.roll))) : R0;
}
function matMulVec(M, v) {
    return {
        x: M[0] * v.x + M[1] * v.y + M[2] * v.z,
        y: M[3] * v.x + M[4] * v.y + M[5] * v.z,
        z: M[6] * v.x + M[7] * v.y + M[8] * v.z,
    };
}
function matMul(A, B) {
    const o = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        o[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    }
    return o;
}
function axisAngleMat(A, th) {
    const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
    const x = A.x, y = A.y, z = A.z;
    return [c + x * x * C, x * y * C - z * s, x * z * C + y * s,
        y * x * C + z * s, c + y * y * C, y * z * C - x * s,
        z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}
function decomposeOrient(R) {
    const a = matMulVec(R, { x: 1, y: 0, z: 0 });
    const yaw = dirWrap360(dirDeg(Math.atan2(a.z, a.x)));
    const pitch = dirDeg(Math.asin(Math.max(-1, Math.min(1, a.y))));
    const f = matMulVec(R, { x: 0, y: 1, z: 0 });
    const rb = dirRollBasis({ yaw, pitch });
    const roll = dirDeg(Math.atan2(
        f.x * rb.b2.x + f.y * rb.b2.y + f.z * rb.b2.z,
        f.x * rb.b1.x + f.y * rb.b1.y + f.z * rb.b1.z));
    return { yaw, pitch, roll: dirWrap180(roll) };
}

// 世界观察里画布平面的四角 (屏幕像素, 中心为原点) —— 就是 dirPlaneHalf 那张平面过一遍 dirProject。
function dirPlaneCorners(R) {
    const { hw, hd } = dirPlaneHalf();
    return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]
        .map(([x, z]) => dirProject({ x, y: 0, z }, R));
}

// 滚转环上角度 a 处的点 (像素, 以小窗中心为原点)。
// 画这颗环、放这颗把手、以及探针回读像素都从这里取点 —— 不在别处重算一遍同一颗环。
function dirFinPoint(pose, R, a) {
    return dirProject(dirWorldFin(pose, a), R);
}

// 把手在画布上的落点 (CSS 像素, 以小窗中心为原点) —— 家族版: 哪几根轴亮由类型说了算。
function famHandlePoints(W, H, state) {
    const R = gizmoRadius(W, H);
    const hw = famHandleWorld(state);
    const pts = {};
    for (const key of famHandleKeys(state)) pts[key] = dirProject(hw[key], R);
    return pts;
}

// ---- 观察一: 世界里的把手图 (只有小窗画它) ----
// 正常情况下这块归 three.js 视图 (js/direction_view.js); 这张 2D 世界图是 K3D 缺席或 WebGL 上下文
// 起不来时的退路, 吃的是同一份世界坐标过 dirProject, 所以读数与 3D 那一版一致。
// opts.chrome = 画那几颗可拖把手; opts.state = 哪一颗正被按下; opts.dim = 没人在编辑。
function drawGeometryWorld(ctx, W, H, state, opts) {
    const o = opts || {};
    const kind = state.kind, d = state.desc;
    const R = gizmoRadius(W, H);
    const dim = o.dim ? 0.32 : 1;
    const lw = Math.max(1.4, R * 0.035);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Y 轴 grid: 铺在地面 (XZ 平面) 上的参考网格, 与 3D 场景同一份 (±1.5, 0.25 一格) ——
    // 世界是标准 XYZ (Y 朝上), 图片躺在 XZ 里、正面朝着 +Y。画在画布矩形**之下**。
    ctx.globalAlpha = dim * 0.18;
    ctx.strokeStyle = DIR_PLANE;
    ctx.lineWidth = lw * 0.5;
    ctx.beginPath();
    for (let i = -6; i <= 6; i++) {
        const g = i * 0.25;
        const a = dirProject({ x: g, y: 0, z: -1.5 }, R);
        const b = dirProject({ x: g, y: 0, z: 1.5 }, R);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        const c = dirProject({ x: -1.5, y: 0, z: g }, R);
        const d0 = dirProject({ x: 1.5, y: 0, z: g }, R);
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(d0.x, d0.y);
    }
    ctx.stroke();
    // grid 上的世界轴线: X 红、Z 蓝 (与三向轴把手同色) —— "图片铺在 XZ"靠它们读;
    // +Y 那根就是画布中心的正面箭头, 不另画。
    for (const [col2, a, b] of [
        ['#ff453a', { x: -1.5, y: 0, z: 0 }, { x: 1.5, y: 0, z: 0 }],
        ['#0a84ff', { x: 0, y: 0, z: -1.5 }, { x: 0, y: 0, z: 1.5 }],
    ]) {
        const pa = dirProject(a, R), pb = dirProject(b, R);
        ctx.globalAlpha = dim * 0.5;
        ctx.strokeStyle = col2;
        ctx.lineWidth = lw * 0.8;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
    }

    // 画布平面: 躺在地上的一张真比例矩形, 加一条 0° 参考边 (画布 +X, 即中心到右边缘中点)。
    // 没有它, 环上的角度就只是"绕一圈", 读不出是相对谁绕的。家族四个类型共用这个世界。
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

    // Y 轴线: 画布中心沿 +Y 的细线, 与红 X、蓝 Z 同为 ±1.5 —— 三根世界轴线合一处读;
    // 原正面箭头按用户要求细线化。画在画布矩形之前, 对象压在它上面。
    ctx.globalAlpha = dim * 0.5;
    ctx.strokeStyle = DIR_FRONT;
    ctx.lineWidth = lw * 0.8;
    const yLo = dirProject({ x: 0, y: -1.5, z: 0 }, R);
    const yHi = dirProject({ x: 0, y: 1.5, z: 0 }, R);
    ctx.beginPath();
    ctx.moveTo(yLo.x, yLo.y);
    ctx.lineTo(yHi.x, yHi.y);
    ctx.stroke();

    const col = d.color || DIR_DEFAULTS.color;
    const pos = kind === 'direction' ? { x: 0, y: 0, z: 0 } : d.position;
    const ps = dirProject(pos, R);

    // 落地虚线: 家族对象离面时, 从球心垂到画布平面 —— 没有它, 高度读不出落点在哪儿。
    if (kind !== 'direction' && Math.abs(pos.y) > 1e-4) {
        const foot = dirProject({ x: pos.x, y: 0, z: pos.z }, R);
        ctx.setLineDash([lw * 1.6, lw * 1.8]);
        ctx.globalAlpha = dim * 0.55;
        ctx.strokeStyle = col;
        ctx.lineWidth = lw * 0.8;
        ctx.beginPath();
        ctx.moveTo(ps.x, ps.y);
        ctx.lineTo(foot.x, foot.y);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // 仰角弧 (direction/ray/plane): 先淡淡描出整条 -90..90 的轨道, 再沿当前方位把亮色那段画到
    // 现在的仰角 —— pitch 的读数辅助 (对象本体的一部分, 两种模式都画)。
    if (kind !== 'point') {
        const Rt = R * DIR_POSE_R;
        // 四元数唯一真相: 箭头 = q·X, 方位/仰角从它身上现取 (与 three.js 那边 direction_view.js:327
        // 同一个式子)。描述符上已经没有 d.yaw/d.pitch, 再读它们是 NaN ⇒ 整段弧与箭都画不出来。
        const f = qApply(d.rotation, { x: 1, y: 0, z: 0 });
        const yawDeg = dirWrap360(dirDeg(Math.atan2(f.z, f.x)));
        const pitDeg = dirDeg(Math.asin(Math.max(-1, Math.min(1, f.y))));
        const arcAt = t => dirProject({
            x: pos.x + Math.cos(t) * Math.cos(dirRad(yawDeg)),
            y: pos.y + Math.sin(t),
            z: pos.z + Math.cos(t) * Math.sin(dirRad(yawDeg)),
        }, Rt);
        ctx.strokeStyle = DIR_ARC;
        ctx.lineWidth = lw;
        ctx.globalAlpha = dim * 0.26;
        ctx.beginPath();
        for (let i = 0; i <= 36; i++) {
            const p = arcAt(dirRad(-90 + i * 5));
            if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
        }
        ctx.stroke();
        ctx.globalAlpha = dim;
        ctx.beginPath();
        const steps = 28;
        for (let i = 0; i <= steps; i++) {
            const p = arcAt(dirRad(pitDeg) * i / steps);
            if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
        }
        ctx.stroke();

        // 箭头本体 (对象颜色) + 头部两片倒钩, 都在屏幕上量, 所以粗细与盒子同步缩放。
        // direction/ray 是全长姿态箭; plane 的是法线刻箭 (短, 从盘心立起来, 盘的朝向靠它读)。
        const v = f;
        const L = kind === 'plane' ? DIR_POSE_R * 0.42 : DIR_POSE_R;
        const tip = dirProject({ x: pos.x + v.x * L, y: pos.y + v.y * L, z: pos.z + v.z * L }, R);
        const len = Math.hypot(tip.x - ps.x, tip.y - ps.y) || 1;
        const ux = (tip.x - ps.x) / len, uy = (tip.y - ps.y) / len;
        const head = Math.max(6, R * 0.2);
        const shaftEnd = { x: tip.x - ux * head * 0.62, y: tip.y - uy * head * 0.62 };
        ctx.strokeStyle = col;
        ctx.lineWidth = lw * 1.5;
        ctx.beginPath();
        ctx.moveTo(ps.x, ps.y);
        ctx.lineTo(shaftEnd.x, shaftEnd.y);
        ctx.stroke();
        const px2 = -uy, py2 = ux;
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(shaftEnd.x + px2 * head * 0.42, shaftEnd.y + py2 * head * 0.42);
        ctx.lineTo(shaftEnd.x - px2 * head * 0.42, shaftEnd.y - py2 * head * 0.42);
        ctx.closePath();
        ctx.fillStyle = col;
        ctx.fill();
    }

    // 圆盘 (plane): 盘面圆周过盘面基采样, 投影后连成椭圆 —— "无限平面"的取景记号。
    if (kind === 'plane') {
        const b1 = qApply(d.rotation, { x: 0, y: 1, z: 0 });
        const b2 = qApply(d.rotation, { x: 0, y: 0, z: 1 });
        ctx.globalAlpha = dim * 0.16;
        ctx.fillStyle = col;
        ctx.beginPath();
        for (let i = 0; i <= 40; i++) {
            const a = i / 40 * Math.PI * 2;
            const p = dirProject({
                x: pos.x + (b1.x * Math.cos(a) + b2.x * Math.sin(a)) * GEO_DISC_R,
                y: pos.y + (b1.y * Math.cos(a) + b2.y * Math.sin(a)) * GEO_DISC_R,
                z: pos.z + (b1.z * Math.cos(a) + b2.z * Math.sin(a)) * GEO_DISC_R,
            }, R);
            if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = dim * 0.85;
        ctx.strokeStyle = col;
        ctx.lineWidth = lw * 0.9;
        ctx.stroke();
    }

    // 起点球 (point/ray/plane): 位置对象都钉在一颗球上。
    if (kind !== 'direction') {
        ctx.globalAlpha = dim;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(ps.x, ps.y, lw * 1.7, 0, Math.PI * 2);
        ctx.fill();
    }

    // 三向轴把手 (move 模式, family): 根在球心的 X/Y/Z 三支箭头, Unity 风格 (末端无球),
    // 悬停/按下整支提亮; local 模式下轴向随对象朝向 (famHandleWorld/moveAxes 一份真相)。
    if (kind !== 'direction' && gizmoMode === 'move') {
        const tips = famHandlePoints(W, H, state);
        for (const key of famHandleKeys(state)) {
            const tip = tips[key];
            const len = Math.hypot(tip.x - ps.x, tip.y - ps.y) || 1;
            const ux = (tip.x - ps.x) / len, uy = (tip.y - ps.y) / len;
            const head = Math.max(3, R * 0.065);
            const hot = o.state === key || o.hover === key;
            ctx.globalAlpha = dim * (hot ? 1 : 0.75);
            ctx.strokeStyle = FAM_HANDLE_COLORS[key];
            ctx.fillStyle = FAM_HANDLE_COLORS[key];
            ctx.lineWidth = lw * (hot ? 0.8 : 0.55);
            ctx.beginPath();
            ctx.moveTo(ps.x, ps.y);
            ctx.lineTo(tip.x - ux * head * 0.62, tip.y - uy * head * 0.62);
            ctx.stroke();
            const hx = -uy, hy = ux;
            ctx.beginPath();
            ctx.moveTo(tip.x, tip.y);
            ctx.lineTo(tip.x - ux * head * 0.62 + hx * head * 0.42, tip.y - uy * head * 0.62 + hy * head * 0.42);
            ctx.lineTo(tip.x - ux * head * 0.62 - hx * head * 0.42, tip.y - uy * head * 0.62 - hy * head * 0.42);
            ctx.closePath();
            ctx.fill();
        }
    }

    // 旋转环 (rotate 模式, 有朝向的要素): 三根彩色圆环, 每根 = 绕一根轴的旋转 (Unity 风格);
    // global 绕世界 XYZ, local 绕对象自己的轴 —— 采样点来自 rotRingAxes 那一份。
    if (kind !== 'point' && gizmoMode === 'rotate') {
        for (const a of rotRingAxes(state)) {
            const hot = o.state === a.key || o.hover === a.key;
            ctx.globalAlpha = dim * (hot ? 0.95 : 0.45);
            ctx.strokeStyle = FAM_HANDLE_COLORS[a.key];
            ctx.lineWidth = lw * (hot ? 0.8 : 0.5);
            ctx.beginPath();
            for (let i = 0; i <= a.samples.length; i++) {
                const s = dirProject(a.samples[i % a.samples.length], R);
                if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y);
            }
            ctx.stroke();
        }
    }

    if (o.chrome) {
        // 拖动读数跟在把手边上: 移动 = 轴尖, 旋转 = 环心。
        if (o.readout && o.state) {
            let p = null;
            if (gizmoMode === 'rotate') {
                const ring = rotRingAxes(state).find(x => x.key === o.state);
                if (ring) p = dirProject(ring.center, R);
            } else {
                p = famHandlePoints(W, H, state)[o.state];
            }
            if (p) {
                ctx.font = '11px system-ui, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillStyle = '#e8e8ee';
                ctx.strokeStyle = 'rgba(0,0,0,0.8)';
                ctx.lineWidth = 3;
                ctx.strokeText(o.readout, p.x, p.y - DIR_HANDLE_R - 6);
                ctx.fillText(o.readout, p.x, p.y - DIR_HANDLE_R - 6);
            }
        }
    }
    ctx.restore();
}

// ---- 图层像素 ----
// 与文字层同一条规矩: 描述符 + 盒子决定像素, 存档只存描述符, 渲染从不入档。
// 盒子只是取景框: 平面按画布比例 contain 进去, 所以拉扁盒子拉不扁画布。
function dirNaturalBox() { return { w: 256, h: 256 }; }

// ---- 观察二: 画布空间的正面图 (direction 记录自己的像素) ----
// 顺着画布法线看过去: 画布平面 = 铺满画面的那张真比例矩形, 角度全在矩形里量。
// 箭头是世界方向落进画布的投影 ⇒ 长度天然乘 cos(pitch) (抬头到 90° 就只剩箭头尖在中心, 那正是
// "方向冲着画布外来"); 后面那条等长的淡虚线是它的真长参照, 没有它短掉的一截只会被读成"箭头短了"。
// (家族另外三枚的正面图在 attr/geometry.js 的 drawGeometryPlan —— 同一张取景框, 各画各的对象。)
function drawDirectionPlan(ctx, W, H, pose) {
    const a = dirCanvasAspect();
    let pw = W * 0.94, ph = pw / a;
    if (ph > H * 0.94) { ph = H * 0.94; pw = ph * a; }
    const Rp = Math.min(pw, ph) / 2 * 0.86;
    const lw = Math.max(1.4, Rp * 0.045);
    // 四元数唯一真相: f = 箭头方向 (3D), 它的 (x, z) 分量就是正面投影。
    const f = qApply(pose.rotation, { x: 1, y: 0, z: 0 });
    const t = Math.atan2(f.z, f.x);
    const co = Math.hypot(f.x, f.z);
    const ux = co > 1e-9 ? f.x / co : 1, uy = co > 1e-9 ? f.z / co : 0;
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
    // 真长参照: 同一方位一直画到 Rp (箭头抬离平面时实投影会短, 这条是它的未缩短读法)。
    ctx.globalAlpha = 0.28;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(ux * Rp, uy * Rp);
    ctx.stroke();
    ctx.setLineDash([]);

    // 角弧 + 度数: 这张图要说的话就是"相对画布转了多少度", 度数烘进像素。
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
    const label = `${Math.round(dirWrap360(dirDeg(t)))}°`;
    ctx.strokeText(label, Math.cos(mid) * Ra * 1.34, Math.sin(mid) * Ra * 1.34);
    ctx.fillText(label, Math.cos(mid) * Ra * 1.34, Math.sin(mid) * Ra * 1.34);

    // 箭头本体 (对象颜色): 尖端 = 方位的水平投影 (抬得越高越短, 90° 只剩中心一点)。
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
    ctx.restore();
}

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
// 数据搬家之后这里只剩**点名**: 方向面住在条带上那枚 Direction 记录里 (attr/direction.js 的 sync
// 拥有全部算法), 这一 shim 是老调用点的读法。折叠的三个入口自己会先喊 syncGeneratorFaces。
function syncDirectionBuffer(l) {
    const r = typeof findAttr === 'function' ? findAttr(l, 'direction') : null;
    if (r && ATTR_TYPES.direction.sync) ATTR_TYPES.direction.sync(l, r);
}

// ---- Direction 工具小窗: 2D 退路那条指针算法 ----
// 只有 three.js 视图建不起来时走这里。把手的拖动是**受约束**的: yaw 直接按指针在地平环上取角,
// pitch / roll 沿各自轨道的切线走 (固定 25° 俯角的正交相机在 yaw 90°/270° 处把仰角那条弧投成一条竖线,
// 那里"从指针反解 pitch"根本不可逆; 切线增量没有奇点, 指针沿轨道走多少把手就走多少)。
// 3D 视图不用这一套: 它有真的相机, 射线打回轨道所在的那个面就能取绝对角 (见 direction_view.js)。

// 把一次指针位移折成该轴的增量 —— 家族版。Shift 吸附: 角吸到 15° (与视图旋转同一个刻度),
// 位置/高度吸到 0.05。direction 那三根轴是老算法原样; 家族的挪动/抬放走 dirProject 的反解
// (固定当前高度的水平面), 绕球心的 yaw 与 direction 的 yaw 同一条 (圆心挪到球上),
// pitch 沿轨道切线走增量 (切线方向与圆心无关, 老公式原样)。
function dirAxisDelta(axis, W, H, state, pt, prev) {
    const kind = state.kind;
    const snap05 = v => (prev && prev.shiftKey ? Math.round(v / 0.05) * 0.05 : v);
    const snap15 = v => (prev && prev.shiftKey ? Math.round(v / 15) * 15 : v);
    // 旋转环 (Unity 风格) 的 2D 退路: 没有真的射线, 用"指针绕环心的屏幕角"累计转角 ——
    // global 空间左乘世界轴旋转, local 空间右乘对象自己的轴 (四元数合成, 无欧拉畸变)。
    if (axis === 'rotX' || axis === 'rotY' || axis === 'rotZ') {
        const g = prev && prev.grab;
        if (!g || g.accum === undefined) return null;
        const phi = Math.atan2(pt.y - g.center2d.y, pt.x - g.center2d.x);
        let dd = phi - g.prevPhi;
        dd = Math.atan2(Math.sin(dd), Math.cos(dd));
        g.prevPhi = phi;
        g.accum += dd;
        const th = dirRad(snap15(dirDeg(g.accum)));
        prev.rotTheta = dirDeg(th);
        // local 右乘的那根轴必须是对象自己的规范轴 g.local; g.A 只是它在世界里的落点,
        // 拿世界轴右乘会把物体绕到一根没画出来的轴上。
        const R = qFromAxisAngle(g.local || g.A, th);
        return { rotation: qNormalize(g.local ? qMul(g.q0, R) : qMul(R, g.q0)) };
    }
    // 三向轴 (move 模式): 指针位移在该轴屏幕投影方向上折回世界位移, 直接加到 position 上
    // (local 模式的轴钉在按下那刻的 grab 里, 不随拖动转)。
    if (axis === 'mvX' || axis === 'mvY' || axis === 'mvZ') {
        const g = prev && prev.grab && prev.grab.axis === axis ? prev.grab : null;
        const A = g ? g.A : moveAxes(state)[axis];
        const p0 = g ? g.pv : state.desc.position;
        const sp = dirProject(A, 1);
        const spl = Math.hypot(sp.x, sp.y) || 1e-6;
        const t = ((pt.x - prev.pt.x) * sp.x + (pt.y - prev.pt.y) * sp.y) / (gizmoRadius(W, H) * spl * spl);
        const cl = v => Math.max(-4, Math.min(4, v));
        return { position: {
            x: cl(p0.x + A.x * t), y: cl(p0.y + A.y * t), z: cl(p0.z + A.z * t),
        } };
    }
    return null;
}

// 指针到线段 [a,b] 的距离 (把抓取区域从"尖端一个点"扩成"整根杆")。
function distToSegment(pt, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    if (len2 < 1e-9) return Math.hypot(pt.x - a.x, pt.y - a.y);
    let t = ((pt.x - a.x) * abx + (pt.y - a.y) * aby) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(pt.x - (a.x + abx * t), pt.y - (a.y + aby * t));
}

function dirHitHandle(W, H, state, pt, pts) {
    // pts 给的就是"几根把手在屏幕上的落点" (move) 或"几根环的采样点串" (rotate) —— 2D 退路自己算,
    // three.js 视图给相机投影出来的那份 (dirScreenHandles 分流)。命中代码只有一份, 两种画法一致。
    // 旋转环: 命中 = 指针到环采样点的最近距离 (环可能被投成扁椭圆, 采样贴着真实投影)。
    if (gizmoMode === 'rotate') {
        let best = null, bestD = DIR_HIT_R;
        for (const ring of pts) {
            for (const s of ring.pts) {
                const d = Math.hypot(pt.x - s.x, pt.y - s.y);
                if (d <= bestD) { best = ring.key; bestD = d; }
            }
        }
        return best;
    }
    // 移动模式: 三向轴是 Unity 风格的箭头 (末端无球), 抓的是整支 —— 指针到"根→尖"线段的距离。
    pts = pts || famHandlePoints(W, H, state);
    let best = null, bestD = DIR_HIT_R;
    // 根点要和尖端同一份投影: 3D 视图活着时 pts 来自相机 (DirView.handlePoints), 再拿固定 25° 俯角的
    // dirProject 折根点, 眼睛一轨道开, 整支箭杆就点不着了 (只剩尖上那 11px)。
    const pos = state.kind !== 'direction' ? state.desc.position : null;
    const basePt = pos && ((DirView.live() && DirView.project(pos)) || dirProject(pos, gizmoRadius(W, H)));
    for (const key of famHandleKeys(state)) {
        const d = (key === 'mvX' || key === 'mvY' || key === 'mvZ') && basePt
            ? distToSegment(pt, basePt, pts[key])
            : Math.hypot(pt.x - pts[key].x, pt.y - pts[key].y);
        if (d <= bestD) { best = key; bestD = d; }
    }
    return best;
}

// ---- 平面上的那张参考图 (只有小窗开着、且有人在编辑时才合成) ----
// 它不是图层像素, 只是小窗里那张画布平面的贴图: 此刻的 context image, 唯独**不含正在编辑的这一枚
// 自己的面** —— 否则标记会被抄进参考面里, 拖一下就看到两份。剔除的单位是**那枚记录**, 不是整层:
// 家族三枚通常挂在照片层上, 连照片一起剔掉的话 3D 场景里的画布就空了 (怎么折的见 blend_node 的
// render 参考分支 —— 画层时把这枚记录临时停用)。
let dirRefCanvas = null, dirRefCtx = null, dirRefVersion = 0;

// render() 的每一趟复合来这里问一句要不要顺手再抄一张; 给目标就必须在同一趟里画完 (它吃的是循环顺序)。
function dirRefTarget() {
    if (!toolWindows.has('directionSection')) return null;
    const t = dirGizmoTarget();
    if (!t || !canvasW || !canvasH) return null;
    // 拖把手期间不重抄: 那时唯一在变的就是这一枚自己的像素, 而参考图本来就把它排除在外。
    if (dirDrag) return null;
    if (!dirRefCanvas) { dirRefCanvas = document.createElement('canvas'); dirRefCtx = dirRefCanvas.getContext('2d'); }
    if (dirRefCanvas.width !== canvasW || dirRefCanvas.height !== canvasH) {
        dirRefCanvas.width = canvasW; dirRefCanvas.height = canvasH;
    }
    resetCtx(dirRefCtx);
    dirRefCtx.clearRect(0, 0, canvasW, canvasH);
    return { ctx: dirRefCtx, skipLayer: t.l.id, skipRef: t.r.id };
}
function dirRefDone() {
    dirRefVersion++;
    // 参考图换了就得催一次重绘: 别的图层改了像素时并不会走到小窗, 而纹理只认这个版本号。
    if (DirView.live()) DirView.invalidate();
}

// three.js 视图 (js/direction_view.js) 先于本文件加载, 所以这里要么确定地拿到它, 要么确定地拿不到:
// 节点进程还跑着没有 /js/ 路由的旧代码时它就整个缺席, 那时每个入口都回 false/null, 面板自然退回
// 本文件那张 2D 世界图 —— 而不是在第一次拖把手时炸在一个未定义的变量上。
const DirView = window.DirView || {
    available: () => false, live: () => false, begin: () => false, frame: () => false,
    handlePoints: () => null, axisDelta: () => null, project: () => null, orbit: () => {},
    setAzEl: () => {}, invalidate: () => {}, zoom: () => {}, grabAxis: () => null,
    state: () => ({ live: false, broken: true }),
};

const dirStage = document.getElementById('dirStage');
const dirGizmoCanvas = document.getElementById('dirGizmo');
const dirViewCanvas = document.getElementById('dirView');
const dirGizmoColor = document.getElementById('dirColorInput');
const dirGizmoColorValue = document.getElementById('dirColorValue');
const dirGizmoReset = document.getElementById('dirResetBtn');
// 六格数字 field: 角度三格 (direction 的老三样, ray/plane 复用 yaw/pitch 两格) 加家族的位置
// 三格。世界是标准 XYZ —— 图片铺在 XZ 上、正面朝着 +Y: 面板 X = 画布左右 (u), Y = 离面高度 (h),
// Z = 画布上下 (v); 哪几格亮由目标类型说了算 (updateDirectionPanel), 读写都过各自 spec 的
// sanitize 那道唯一的形状裁定: 打 999 是绕到 279°, 不是把读数卡死在边界上。
// 六格数字 field: X/Y/Z 直读 position, Yaw/Pitch/Roll 是四元数分解出的欧拉 (编辑 = 重组四元数,
// ray/plane 的 roll 分量原样保留)。哪些格亮由目标类型说了算 (f.on)。
function qEulerPatch(q0, patch) {
    const e = geoEuler(q0);
    return qNormalize(qFromEuler(
        patch.yaw !== undefined ? patch.yaw : e.yaw,
        patch.pitch !== undefined ? patch.pitch : e.pitch,
        patch.roll !== undefined ? patch.roll : e.roll));
}
const DIR_FIELDS = [
    { input: document.getElementById('dirXNum'), cell: document.getElementById('dirXCell'), on: k => k !== 'direction',
        get: d => d.position.x, put: (d, v) => ({ position: Object.assign({}, d.position, { x: v }) }), fmt: 2 },
    { input: document.getElementById('dirYNum'), cell: document.getElementById('dirYCell'), on: k => k !== 'direction',
        get: d => d.position.y, put: (d, v) => ({ position: Object.assign({}, d.position, { y: v }) }), fmt: 2 },
    { input: document.getElementById('dirZNum'), cell: document.getElementById('dirZCell'), on: k => k !== 'direction',
        get: d => d.position.z, put: (d, v) => ({ position: Object.assign({}, d.position, { z: v }) }), fmt: 2 },
    { input: document.getElementById('dirYawNum'), cell: document.getElementById('dirYawCell'), on: k => k !== 'point',
        get: d => geoEuler(d.rotation).yaw, put: (d, v) => ({ rotation: qEulerPatch(d.rotation, { yaw: v }) }), fmt: 0 },
    { input: document.getElementById('dirPitchNum'), cell: document.getElementById('dirPitchCell'), on: k => k !== 'point',
        get: d => geoEuler(d.rotation).pitch, put: (d, v) => ({ rotation: qEulerPatch(d.rotation, { pitch: v }) }), fmt: 0 },
    { input: document.getElementById('dirRollNum'), cell: document.getElementById('dirRollCell'), on: k => k === 'direction',
        get: d => geoEuler(d.rotation).roll, put: (d, v) => ({ rotation: qEulerPatch(d.rotation, { roll: v }) }), fmt: 0 },
];
let dirDrag = null;
let dirHover = null;
let dirOrbit = null;

// ---- 家族目标 ----
// 小窗编辑的是**一枚记录**, 不是"选中的层的那个老字段": 同一种可以装好几枚, 编辑谁必须是 chip
// 点击就定下来的事。geoTarget 由 dirPinTarget 钉下 (layerId + ref), 但它**只在它的层正是当前
// 选中层时才算数** —— 选别层去, 窗口跟着选中的层走 (该层有家族记录就显示它的, 没有就转暗),
// 绝不显示/编辑一个没被选中的层身上的 attribute。没钉过 (D 键/开窗那条路) 就退到选中层的第一个
// 家族记录 —— 这一步只 adoption 不回写, 选回原来的层时它钉住的那枚还在。记录被删时校验失败,
// 同样退到选中层 —— 永远不会编辑到一份悬空数据。
let geoTarget = null;
function dirPinTarget(l, r) {
    if (!l || !r) return;
    geoTarget = { layerId: l.id, ref: r.id };
    selectLayer(l.id, 'transform');
    // 窗已开着就只换目标, 不翻转 —— 点第二枚 chip 把窗关掉是反的。
    if (typeof toolWindows === 'undefined' || !toolWindows.has('directionSection')) {
        toggleToolWindow('directionSection');
    }
    updateDirectionPanel();
}
function dirGizmoTarget() {
    const l = typeof getLayer === 'function' ? getLayer(selectedId) : null;
    if (geoTarget && l && String(geoTarget.layerId) === String(l.id)) {
        const r = attrRecord(geoTarget.ref);
        if (r && GEO_KINDS.indexOf(r.type) >= 0 && attrRefList(l).indexOf(r.id) >= 0) return { l, r };
    }
    if (l) {
        for (const kind of GEO_KINDS) {
            const r = findAttr(l, kind);
            if (r) return { l, r };
        }
    }
    return null;
}
// 两种画法共同的读法: {kind, desc}。没人在编辑时退回默认姿态 (画面照常是满的, 只是转暗)。
function dirGizmoState() {
    const t = dirGizmoTarget();
    return t ? { kind: t.r.type, desc: t.r.desc } : { kind: 'direction', desc: DIR_DEFAULTS };
}

// 家族的 patch 口: 整只换 desc (不可变, undo 安全), sanitize 是每类 spec 自己那道裁定;
// 代次 +1 让折叠缓存认出变化。live 拖动只走 render (主画布当场折), 松手才重修行列表。
function patchGizmoTarget(hit, patch, opts) {
    const spec = ATTR_TYPES[hit.r.type];
    hit.r.desc = spec.sanitize(Object.assign({}, hit.r.desc, patch));
    markAttrPainted(hit.r);
    if (!(opts && opts.silent)) {
        render();
        if (!(opts && opts.live)) renderLayerList();
    }
}

// 舞台的尺寸从 #dirStage 量, 不从两块 canvas 量: 此刻藏着的那块 clientWidth 是 0, 而两种画法吃的
// 必须是同一块取景框, 否则指针落点与画面就对不上。
function dirStageSize() {
    const box = dirStage || dirGizmoCanvas;
    return { W: (box && box.clientWidth) || DIR_STAGE_W, H: (box && box.clientHeight) || DIR_STAGE_H };
}
function dirGizmoPoint(ev) {
    const box = dirStage || dirGizmoCanvas;
    const r = box.getBoundingClientRect();
    const { W, H } = dirStageSize();
    // clientLeft/Top = 舞台那圈 1px 边框: getBoundingClientRect 从边框外沿算起, 而两块 canvas 是
    // inset:0 贴在边框**以内**的, 所以不减掉这 1px, 指针空间就整体比画面偏右下 (把手差 1px 打不中,
    // 拖到的角也差一点 —— 滚转那颗只有 15px 半径, 1px 就是 4°)。
    return { x: ev.clientX - r.left - box.clientLeft - W / 2,
        y: ev.clientY - r.top - box.clientTop - H / 2 };
}
function dirScreenHandles(state) {
    if (gizmoMode === 'rotate') return rotRingScreenPoints(state);
    const { W, H } = dirStageSize();
    return (DirView.live() && DirView.handlePoints(state)) || famHandlePoints(W, H, state);
}
function dirPatchFromDrag(axis, state, pt, prev) {
    if (DirView.live()) return DirView.axisDelta(axis, state, pt, prev);
    const { W, H } = dirStageSize();
    return dirAxisDelta(axis, W, H, state, pt, prev);
}

function drawDirGizmo() {
    if (!dirStage) return;
    const state = dirGizmoState();
    const target = dirGizmoTarget();
    const opts = {
        chrome: true,
        dim: !target,
        hover: dirDrag ? dirDrag.axis : dirHover,
        state: dirDrag && dirDrag.axis,
    };
    // three.js 视图建不起来 (K3D 缺席 / WebGL 上下文起不来) 就退回下面那张 2D 世界图, 两块 canvas 谁在
    // 显示由这一刻的成败决定 —— 退路只改画法, 不改读数。
    const live = DirView.frame(dirViewCanvas, state, opts);
    dirViewCanvas.style.display = live ? 'block' : 'none';
    dirGizmoCanvas.style.display = live ? 'none' : 'block';
    if (live) { syncDirectionFields(); return; }
    const dpr = window.devicePixelRatio || 1;
    const { W, H } = dirStageSize();
    if (dirGizmoCanvas.width !== Math.round(W * dpr) || dirGizmoCanvas.height !== Math.round(H * dpr)) {
        dirGizmoCanvas.width = Math.round(W * dpr);
        dirGizmoCanvas.height = Math.round(H * dpr);
    }
    const ctx = dirGizmoCanvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawGeometryWorld(ctx, W, H, state, Object.assign({
        readout: dirDrag ? dirDragReadout(state) : null,
    }, opts));
    syncDirectionFields();
}
// 拖动时跟在把手边上的那句读数: 角度整数量, 位置按世界 XYZ (x=画布左右, y=离面, z=画布上下)。
function dirDragReadout(state) {
    const d = state.desc, a = dirDrag.axis;
    const label = DIR_AXIS_LABEL[a] || a;
    if (a === 'mvX' || a === 'mvY' || a === 'mvZ') {
        return `${label} — x ${d.position.x.toFixed(2)} · y ${d.position.y.toFixed(2)} · z ${d.position.z.toFixed(2)}`;
    }
    if (a === 'rotX' || a === 'rotY' || a === 'rotZ') {
        return `${label} ${Math.round(dirDrag.rotTheta || 0)}\u00b0`;
    }
    return `${label} ${Math.round(d[a])}\u00b0`;
}

if (dirStage) {
    dirStage.addEventListener('mousedown', ev => {
        // 中键 = 只转眼睛。描述符一个字节都不动, 所以它跟左键拖把手是两个动作, 不是一件事。
        if (ev.button === 1 && DirView.live()) {
            ev.preventDefault();            // 中键在浏览器里还会开 autoscroll, 这里按掉
            dirOrbit = { x: ev.clientX, y: ev.clientY };
            dirStage.style.cursor = 'move';
            return;
        }
        const t = dirGizmoTarget();
        if (!t || ev.button !== 0) return;
        const pt = dirGizmoPoint(ev);
        const state = dirGizmoState();
        const { W, H } = dirStageSize();
        const axis = dirHitHandle(W, H, state, pt, dirScreenHandles(state));
        if (!axis) return;
        ev.preventDefault();
        dirDrag = { axis, pt, layerId: t.l.id, ref: t.r.id, moved: false, shiftKey: ev.shiftKey };
        // 三向轴: 按下那一刻先量出抓取偏移 (手指抓在箭头哪里) —— 拖动全程按它补偿,
        // 不然第一帧就把对象根吸附到指针上。
        if (axis === 'mvX' || axis === 'mvY' || axis === 'mvZ') {
            dirDrag.grab = DirView.grabAxis(axis, state, pt);
            if (dirDrag.grab) dirDrag.grab.axis = axis;
        }
        // 旋转环: 3D 记下按下那刻指针在环平面上的方位角; 2D 退路记屏幕角并增量累计。
        if (axis === 'rotX' || axis === 'rotY' || axis === 'rotZ') {
            if (DirView.live()) {
                dirDrag.grab = DirView.grabRotate(axis, state, pt);
            } else {
                const ring = rotRingAxes(state).find(x => x.key === axis);
                if (ring) {
                    const c2 = dirProject(ring.center, gizmoRadius(W, H));
                    dirDrag.grab = { q0: Object.assign({}, state.desc.rotation), A: ring.A,
                        local: gizmoSpace === 'local' ? { x: axis === 'rotX' ? 1 : 0, y: axis === 'rotY' ? 1 : 0, z: axis === 'rotZ' ? 1 : 0 } : null,
                        center2d: c2, prevPhi: Math.atan2(pt.y - c2.y, pt.x - c2.x), accum: 0 };
                }
            }
            if (dirDrag.grab) dirDrag.grab.axis = axis;
        }
        drawDirGizmo();
    });
    dirStage.addEventListener('auxclick', ev => { if (ev.button === 1) ev.preventDefault(); });
    // 滚轮 = 拉远/拉近 (只动眼睛)。只在 3D 视图活着时接手 —— 2D 退路是固定取景框, 滚轮放行给
    // 面板滚动。preventDefault 必须要: 不然滚一下整个侧栏跟着滚。
    dirStage.addEventListener('wheel', ev => {
        if (!DirView.live()) return;
        ev.preventDefault();
        ev.stopPropagation();
        DirView.zoom(ev.deltaY > 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });
    dirStage.addEventListener('mousemove', ev => {
        if (dirDrag || dirOrbit) return;
        const t = dirGizmoTarget();
        let hit = null;
        if (t) {
            const state = dirGizmoState();
            const { W, H } = dirStageSize();
            hit = dirHitHandle(W, H, state, dirGizmoPoint(ev), dirScreenHandles(state));
        }
        if (hit === dirHover) return;
        dirHover = hit;
        dirStage.style.cursor = hit ? 'grab' : 'default';
        drawDirGizmo();
    });
    dirStage.addEventListener('mouseleave', () => {
        if (dirHover === null) return;
        dirHover = null;
        drawDirGizmo();
    });
    window.addEventListener('mousemove', ev => {
        if (dirOrbit) {
            DirView.orbit(ev.clientX - dirOrbit.x, ev.clientY - dirOrbit.y);
            dirOrbit = { x: ev.clientX, y: ev.clientY };
            return;
        }
        if (dirDrag && ev.buttons === 0) endDirGizmoDrag(ev);
        if (!dirDrag) return;
        const l = getLayer(dirDrag.layerId);
        const r = l ? attrRecord(dirDrag.ref) : null;
        if (!l || !r) { dirDrag = null; return; }
        const pt = dirGizmoPoint(ev);
        // 吸附加在**这一帧**的 Shift 上, 不是上一帧: 先记下按键再算增量, 而从按下起就按着 Shift
        // 拖第一下就该吸住 (两条算法要的都是 prev.pt, 所以只有它留在赋值之前)。
        dirDrag.shiftKey = ev.shiftKey;
        const patch = dirPatchFromDrag(dirDrag.axis, { kind: r.type, desc: r.desc }, pt, dirDrag);
        dirDrag.pt = pt;
        // 交不出增量 (视线与那个约束面平行) 就这一帧不动, 而不是把读数甩到一个假值上。
        if (!patch) { drawDirGizmo(); return; }
        dirDrag.moved = true;
        patchGizmoTarget({ l, r }, patch, { live: true });
        drawDirGizmo();
    });
    window.addEventListener('mouseup', ev => {
        if (ev.button === 1 && dirOrbit) {
            dirOrbit = null;
            dirStage.style.cursor = dirHover ? 'grab' : 'default';
            return;
        }
        if (dirDrag) endDirGizmoDrag(ev);
    });
    // 眼睛跑掉 (切窗、按 Alt+Tab) 时中键的 mouseup 永远收不到, 轨道状态就留在那儿了。
    window.addEventListener('blur', () => {
        if (!dirOrbit) return;
        dirOrbit = null;
        dirStage.style.cursor = 'default';
    });
    // 工具键 (小窗开着时捕获, capture 阶段截下, 免得画布的全局快捷键 —— E 磨皮、X 换色 —— 也响):
    // W/E 切移动/旋转把手 (Unity 同款), X 切 global/local。焦点在输入格时不抢字; 松开修饰键
    // 才算数 (Ctrl+W 关标签页是浏览器的, 不碰)。
    window.addEventListener('keydown', ev => {
        if (typeof toolWindows === 'undefined' || !toolWindows.has('directionSection')) return;
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        const tgt = ev.target;
        if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
        const k = ev.key.toLowerCase();
        if (k !== 'w' && k !== 'e' && k !== 'x') return;
        ev.preventDefault();
        ev.stopPropagation();
        if (k === 'w') gizmoMode = 'move';
        else if (k === 'e') gizmoMode = 'rotate';
        else gizmoSpace = gizmoSpace === 'global' ? 'local' : 'global';
        setStatus(`Gizmo: ${gizmoMode} · ${gizmoSpace}`);
        updateDirectionPanel();       // 提示跟上; 3D 的下一帧由 frame() 合帧
    }, true);
}

function endDirGizmoDrag() {
    if (!dirDrag) return;
    const l = getLayer(dirDrag.layerId);
    const r = l ? attrRecord(dirDrag.ref) : null;
    const moved = dirDrag.moved;
    dirDrag = null;
    if (l && r && moved) {
        renderLayerList();
        pushHistory('geometry-' + dirDragAxisKey(r.desc));
    }
    drawDirGizmo();
}
// 历史键 = 描述符全部字段的粗读数拼一句: 松手那刻的形状变了才立一步。
function dirDragAxisKey(desc) {
    return Object.keys(desc).sort().map(k => `${k}${Math.round(desc[k] * 100)}`).join('_');
}

function updateDirectionPanel() {
    const t = dirGizmoTarget();
    const kind = t ? t.r.type : null;
    const section = document.getElementById('directionSection');
    if (section) section.classList.toggle('active-tool', !!t);
    // 标题里的类型名跟着目标走 (Direction/Point/Ray/Plane); class 不 id —— 开窗时 flyout 会克隆
    // 标题节点, 按 id 找只会改到原版, 每次现查一遍两处一起换字。
    const name = kind ? kind[0].toUpperCase() + kind.slice(1) : 'Direction';
    for (const el of document.querySelectorAll('.dir-kind')) el.textContent = name;
    // 左上角的快捷键提示: 当前模式亮着, X 后面跟的是现在的空间。
    const hint = document.getElementById('dirHint');
    if (hint) {
        hint.innerHTML = `<b>W</b> Move${gizmoMode === 'move' ? ' ●' : ''}`
            + ` &nbsp;<b>E</b> Rotate${gizmoMode === 'rotate' ? ' ●' : ''}`
            + ` &nbsp;<b>X</b> ${gizmoSpace === 'global' ? 'Global' : 'Local'}`;
    }
    const d = t ? t.r.desc : null;
    for (const f of DIR_FIELDS) {
        if (!f.input) continue;
        const on = kind ? f.on(kind) : false;
        if (f.cell) f.cell.style.display = on ? '' : 'none';
        f.input.disabled = !on;
        if (on && d && document.activeElement !== f.input) {
            const v = dirFieldText(f.get(d), f.fmt);
            if (f.input.value !== v) f.input.value = v;
        }
    }
    if (dirGizmoColor) {
        dirGizmoColor.disabled = !d;
        if (d) dirGizmoColor.value = d.color;
    }
    if (dirGizmoColorValue) dirGizmoColorValue.textContent = d ? d.color.toUpperCase() : '';
    if (dirGizmoReset) dirGizmoReset.disabled = !d;
    drawDirGizmo();
}

// 位置/高度两位小数, 角度整数 —— 两类读数各用各的格式, 同一套 field。
function dirFieldText(v, fmt) {
    return fmt ? Number(v).toFixed(fmt) : String(Math.round(v));
}
// 拖把手与填数字读写的是同一份 desc, 所以两边都得能改写对方: 每帧画完小窗就把格子读数跟上。
// 正在打字那一格除外 —— 拖一圈把手不该把用户刚敲进去的"13"变成"135"。
function syncDirectionFields() {
    const t = dirGizmoTarget();
    const d = t ? t.r.desc : null;
    for (const f of DIR_FIELDS) {
        if (!f.input) continue;
        const on = t ? f.on(t.r.type) : false;
        if (!on || !d || document.activeElement === f.input) continue;
        const v = dirFieldText(f.get(d), f.fmt);
        if (f.input.value !== v) f.input.value = v;
    }
}

for (const f of DIR_FIELDS) {
    if (!f.input) continue;
    f.input.addEventListener('input', () => {
        const t = dirGizmoTarget();
        if (!t || !f.on(t.r.type)) return;
        const n = Number(f.input.value);
        if (f.input.value === '' || !Number.isFinite(n)) return;
        patchGizmoTarget(t, f.put(t.r.desc, n), { live: true });
        drawDirGizmo();
    });
    f.input.addEventListener('change', () => {
        const t = dirGizmoTarget();
        if (!t || !f.on(t.r.type)) return;
        f.input.value = dirFieldText(f.get(t.r.desc), f.fmt);   // 回读sanitize折回之后的实际读数
        renderLayerList();
        pushHistory();
    });
}

if (dirGizmoColor) {
    dirGizmoColor.addEventListener('input', () => {
        const t = dirGizmoTarget();
        if (!t) return;
        patchGizmoTarget(t, { color: dirGizmoColor.value }, { live: true });
        if (dirGizmoColorValue) dirGizmoColorValue.textContent = dirGizmoColor.value.toUpperCase();
    });
    dirGizmoColor.addEventListener('change', () => {
        const t = dirGizmoTarget();
        if (t) pushHistory();
    });
}
if (dirGizmoReset) {
    dirGizmoReset.addEventListener('click', () => {
        const t = dirGizmoTarget();
        if (!t) return;
        patchGizmoTarget(t, Object.assign({}, ATTR_TYPES[t.r.type].defaults));
        setStatus(`「${t.r.type[0].toUpperCase() + t.r.type.slice(1)}」reset to its default`, 'success');
    });
}
