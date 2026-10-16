/* geometry 家族 (direction / point / ray / plane) 的**世界数学**唯一一份 —— 页面与宿主共用。
 *
 *  这份原来是 direction.js 的头半截 (四元数 / 世界坐标 / 把手 / 旋转环 / 命中判定 + 那几个常量)。
 *  工作台工具小窗搬进宿主 dock 之后, 两边的 three.js 视图 (页面里的 direction_view.js、宿主里的
 *  同一份) 吃的是同一套世界读法, 所以把数学抽到这里, 谁都不许再抄第二遍:
 *    - direction.js (页面) 只留图层像素绘制 + 面板交互 + 2D 退路, 数学全部从这里拿;
 *    - 宿主 (ui/sampler_node) 运行时 <script> 引这份 + direction_view.js, 复用同一颗 DirView。
 *
 *  它是一份**普通全局脚本** (不是 IIFE): 常量与函数声明在全局词法里, 与历史行为逐位一致 ——
 *  direction.js 与 direction_view.js 里那些裸名字引用 (dirProject、qApply、gizmoMode …) 一个都不用改。
 *  两处宿主侧要写进去的活状态各留了一个口:
 *    - 把手模式/空间 = gizmoMode / gizmoSpace (原来是 direction.js 的 let), 用 setGizmoMode/Space 改;
 *    - 画布比例 = dirCanvasAspect(), 原来读页面的 canvasW/canvasH, 现在由 setGeoCanvasAspect 注入
 *      (页面注入读 canvasW/canvasH 的那个闭包; 宿主注入自己那份快照的画布尺寸)。
 *
 *  角度基与 direction.js 头注释同一套: 画布 = y=0 那张平面, x 右、y 上、z 朝画布下侧; Yaw 0° =
 *  画布右、90° = 画布下; Pitch 是抬离画布平面的角度。 */

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
const DIR_STAGE_W = 696;          // 小窗舞台的 CSS 尺寸回退值 (实际从舞台量)
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

// 把手模式与空间 (Unity 同款): W = 移动, E = 旋转, X = 切 global/local。
let gizmoMode = 'move';           // 'move' | 'rotate'
let gizmoSpace = 'global';        // 'global' | 'local'
// 页面与宿主各自改写这两个活状态的唯一口 (原来是 direction.js 内的 let, 宿主够不着)。
function setGizmoMode(m) { gizmoMode = m === 'rotate' ? 'rotate' : 'move'; }
function setGizmoSpace(s) { gizmoSpace = s === 'local' ? 'local' : 'global'; }

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
// geometry 描述符里 {u,v,h} (铺在画布矩形上, 0=左/上, h 单位 = 画布高) ↔ 世界 position 的一对
// 唯一换算: attr/geometry.js 的旧形状转换与特效链的镜面锚点 (fx/ssr.js) 都走这一份。
function geoUVHToWorld(u, v, h) {
    const { hw, hd } = dirPlaneHalf();
    return { x: (u - 0.5) * 2 * hw, y: h * 2 * hd, z: (v - 0.5) * 2 * hd };
}
function geoWorldToUVH(p) {
    const { hw, hd } = dirPlaneHalf();
    return { u: p.x / (2 * hw) + 0.5, v: p.z / (2 * hd) + 0.5, h: p.y / (2 * hd) };
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
// 原来读页面的 canvasW/canvasH (let, 宿主够不着); 现在由消费方注入一个取比例的闭包。
let geoCanvasAspectFn = null;
function setGeoCanvasAspect(fn) { geoCanvasAspectFn = typeof fn === 'function' ? fn : null; }
function dirCanvasAspect() { return geoCanvasAspectFn ? geoCanvasAspectFn() : 1; }

// ---- geometry 家族: 位置 ↔ 世界 ----
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
// 把手在画布上的落点 (CSS 像素, 以小窗中心为原点) —— 家族版: 哪几根轴亮由类型说了算 (2D 退路)。
function famHandlePoints(W, H, state) {
    const R = gizmoRadius(W, H);
    const hw = famHandleWorld(state);
    const pts = {};
    for (const key of famHandleKeys(state)) pts[key] = dirProject(hw[key], R);
    return pts;
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

// ---- 命中判定 (两种画法共用) ----
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
    const DV = window.DirView;
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
    const basePt = pos && ((DV && DV.live() && DV.project(pos)) || dirProject(pos, gizmoRadius(W, H)));
    for (const key of famHandleKeys(state)) {
        const d = (key === 'mvX' || key === 'mvY' || key === 'mvZ') && basePt
            ? distToSegment(pt, basePt, pts[key])
            : Math.hypot(pt.x - pts[key].x, pt.y - pts[key].y);
        if (d <= bestD) { best = key; bestD = d; }
    }
    return best;
}
