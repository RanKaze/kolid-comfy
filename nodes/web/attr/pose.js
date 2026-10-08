// Pose attribute —— 一只 3D 人形 (MakeHuman 网格, VNMHJS02 包) 在**它自己的窗口**里摆好姿态与取景,
// 烤成这一层上的像素。desc 是权威 (参数), 面是派生 —— 与文字/方向同一档 (kind:'generator',
// spec.sync 惰性重算), 但与它们两处不同:
//   · 面的算法在 WebGL 里 (js/pose_core.js 的 PoseRig), 首次装配要等 worker 解形 (js/pose_morph.js)
//     —— 所以 sync 有一条**异步**装配支路: 面没就绪时先保持原样 (fail-soft, 绝不清已烘好的像素),
//     装配完自己回来补这一趟 (render() 会再进 sync 的同步快路)。
//   · 面**算得回来** (desc + 资产 ⇒ 面), 但资产在 git 外 (data/pose/): 资产缺失时面烤不出来,
//     已有的面就留在档里继续显示 —— 所以 snap/load/clone 都像 3D 那样把面带上 (4.a 的约定)。
// 相机 (desc.cam) 是**捕获取景** (FOV 30 / dist 45, 参考的约定), 不是编辑器里那台自由看的人眼。

const POSE_MESH_DEFAULTS = Object.freeze({
    age: 25, gender: 0.5, weight: 0.5, muscle: 0.5, height: 0.5,
    breast_size: 0.5, firmness: 0.5,
});
const POSE_CAM_DEFAULTS = Object.freeze({ yaw: 0, pitch: 0, zoom: 1, offsetX: 0, offsetY: 0 });
const POSE_SKINS = ['naked', 'naked_marks', 'dummy_white'];
const POSE_COLOR_DEFAULT = '#ffffff';

function poseDefaultDescriptor() {
    return {
        v: 1,
        mesh: Object.assign({}, POSE_MESH_DEFAULTS),
        pose: { bones: {}, bonePositions: {}, modelRotation: [0, 0, 0] },
        cam: Object.assign({}, POSE_CAM_DEFAULTS),
        skin: 'dummy_white',
        color: POSE_COLOR_DEFAULT,
        bg: null,                       // null = 透明底 (5.a 的默认)
    };
}

function poseFinite(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}
function poseClamp(v, lo, hi, fallback) {
    return Math.max(lo, Math.min(hi, poseFinite(v, fallback)));
}

// 唯一的一处形状裁定 (与 sanitizeDirectionDescriptor 同一套规矩): .cud 读回来或面板 patch 进来的
// 东西先过这里, 坏字段退化到默认值。整只换新对象 —— desc 是不可变的, patch 一律整只替换。
function sanitizePoseDescriptor(raw) {
    const defaults = poseDefaultDescriptor();
    if (!raw || typeof raw !== 'object') return defaults;
    const meshIn = raw.mesh && typeof raw.mesh === 'object' ? raw.mesh : {};
    const mesh = Object.assign({}, POSE_MESH_DEFAULTS);
    mesh.age = poseClamp(meshIn.age, 1, 90, POSE_MESH_DEFAULTS.age);
    for (const k of ['gender', 'weight', 'muscle', 'height', 'breast_size', 'firmness']) {
        mesh[k] = poseClamp(meshIn[k], 0, 1, POSE_MESH_DEFAULTS[k]);
    }
    if (meshIn.show_genitals === true) mesh.show_genitals = true;

    const poseIn = raw.pose && typeof raw.pose === 'object' ? raw.pose : {};
    const bones = {};
    if (poseIn.bones && typeof poseIn.bones === 'object') {
        for (const [name, rot] of Object.entries(poseIn.bones)) {
            if (!Array.isArray(rot) || rot.length < 3) continue;
            const v = rot.slice(0, 3).map(Number);
            if (v.every(Number.isFinite)) bones[name] = v;
        }
    }
    const bonePositions = {};
    if (poseIn.bonePositions && typeof poseIn.bonePositions === 'object') {
        for (const [name, pos] of Object.entries(poseIn.bonePositions)) {
            if (!Array.isArray(pos) || pos.length < 3) continue;
            const v = pos.slice(0, 3).map(Number);
            if (v.every(Number.isFinite)) bonePositions[name] = v;
        }
    }
    const mr = Array.isArray(poseIn.modelRotation) ? poseIn.modelRotation.slice(0, 3).map(Number) : [];
    const modelRotation = mr.length === 3 && mr.every(Number.isFinite) ? mr : [0, 0, 0];

    const camIn = raw.cam && typeof raw.cam === 'object' ? raw.cam : {};
    const cam = {
        yaw: poseFinite(camIn.yaw, POSE_CAM_DEFAULTS.yaw),
        pitch: poseClamp(camIn.pitch, -89, 89, POSE_CAM_DEFAULTS.pitch),
        zoom: poseClamp(camIn.zoom, 0.1, 10, POSE_CAM_DEFAULTS.zoom),
        offsetX: poseClamp(camIn.offsetX, -20, 20, POSE_CAM_DEFAULTS.offsetX),
        offsetY: poseClamp(camIn.offsetY, -20, 20, POSE_CAM_DEFAULTS.offsetY),
    };

    const skin = POSE_SKINS.indexOf(raw.skin) >= 0 ? raw.skin : defaults.skin;
    const color = /^#[0-9a-fA-F]{3,8}$/.test(String(raw.color || '')) ? raw.color : POSE_COLOR_DEFAULT;
    let bg = null;
    if (Array.isArray(raw.bg) && raw.bg.length === 3) {
        bg = raw.bg.map(c => Math.max(0, Math.min(255, Math.round(poseFinite(c, 0)))));
    }
    return { v: 1, mesh, pose: { bones, bonePositions, modelRotation }, cam, skin, color, bg };
}

// ---- rig 生命周期 ----
// 一枚记录一只 rig (场景 + 骨架 + 渲染器), 记录没了就丢 (poseSweepRigs)。工具窗编辑的是**同一只**
// rig —— 开窗只是把它的 canvas 搬进舞台, 关窗搬出去继续 headless 出图。
const poseRigs = new Map();    // ref -> entry

function poseRigEntry(r) {
    let entry = poseRigs.get(r.id);
    if (!entry) {
        if (poseRigs.size >= 4) poseSweepRigs();
        entry = {
            rig: null, ready: false, building: false, modelLoaded: false,
            meshKey: null, bakeKey: null, skin: null, warned: false, pendingSkin: false,
        };
        poseRigs.set(r.id, entry);
    }
    return entry;
}

function poseSweepRigs() {
    for (const [id, entry] of Array.from(poseRigs)) {
        if (attrRecords.has(id)) continue;
        if (typeof poseViewRigIs === 'function' && poseViewRigIs(entry.rig)) poseViewReleaseRig();
        entry.rig?.dispose();
        poseRigs.delete(id);
    }
}

function poseBakeKeyOf(desc, w, h) {
    return JSON.stringify([desc.pose, desc.cam, desc.bg, desc.color, desc.skin, w, h]);
}

// 同步快路: rig 已就绪, 摆姿态 + 烤一张新 canvas。新身份 = 折叠缓存自然重算 (stashLayerKey 认面身份)。
function poseFastBake(entry, r, w, h) {
    const rig = entry.rig;
    rig.applyPose(r.desc.pose);
    rig.setColor(r.desc.color);
    const out = rig.capture({
        width: w, height: h,
        cam: r.desc.cam,
        transparent: r.desc.bg === null,
        bg: r.desc.bg,
    });
    if (out) {
        r.surface = out;
        entry.bakeKey = poseBakeKeyOf(r.desc, w, h);
    }
}

function poseRefresh() {
    if (typeof render === 'function') render();
    if (typeof renderLayerList === 'function') renderLayerList();
}

// 异步装配/重解。includeStatic 只在第一次要 (拓扑+uv+skin 一次带齐)。完成即 null 掉 bakeKey,
// 回程的 sync 快路照最新 desc 烤面 —— 装配期间用户接着改参数也不怕, 收敛到最新一份。
function poseKickBuild(entry, r) {
    if (entry.building) return;
    const meshKey = JSON.stringify(r.desc.mesh);
    // 失败过就不在同一份形态上重敲 —— 每次 render/renderLayerList 都来一趟的话, 每次都是一枚
    // 立刻 reject 的 promise。资产 404 这类失败 PoseMorph.failed 是 false (worker 本身活着),
    // 所以另按"失败时的形态"记一份 failKey; 形态真变了 (拖了滑块) 才值得再试一趟。
    // 警告只发一次 (warned), 烘好一趟就整体复位 —— 下一场失败重新算新事。
    if (entry.warned && (PoseMorph.failed || entry.failKey === meshKey)) return;
    entry.building = true;
    const includeStatic = !entry.modelLoaded;
    PoseMorph.solve(r.desc.mesh, includeStatic).then((message) => {
        if (!entry.rig) entry.rig = new PoseCore.PoseRig();
        if (!entry.modelLoaded) {
            // 首装那一趟 worker 才带 staticData (拓扑+uv+skin); 之后的每趟只有顶点与骨位,
            // 所以转换口只喂 loadModel 这一支 (updateBody 直接吃 worker 的三个 typed array)。
            entry.rig.loadModel(poseModelDataFromMorphMessage(message));
            entry.modelLoaded = true;
        } else {
            entry.rig.updateBody(message.vertices, message.bonePositions, message.indices);
        }
        entry.meshKey = meshKey;
        entry.skin = r.desc.skin;
        return entry.rig.setSkin(r.desc.skin);
    }).then(() => {
        entry.building = false;
        entry.ready = true;
        entry.bakeKey = null;
        entry.warned = false;
        entry.failKey = null;
        poseRefresh();
    }).catch((error) => {
        entry.building = false;
        entry.failKey = meshKey;
        console.warn('[kolid pose]', error);
        if (!entry.warned) {
            entry.warned = true;
            if (typeof setStatus === 'function') setStatus('Pose: ' + (error?.message || error), 'error');
        }
    });
}

// 折叠前每个生成器记录都要过的这一趟 (core.js syncGeneratorFaces 喊的)。三种去向:
//   ① rig 就绪 + 一切没变 → 两下比对过去;
//   ② rig 就绪 + 只有被烤的东西变了 → 同步快烤 (几毫秒的 WebGL 一帧 + 回读);
//   ③ rig 没就绪 / mesh 变了 / 换皮肤 → 异步支路, 本趟面保持原样。
function poseSync(l, r) {
    if (!r.desc || !PoseCore.available() || typeof PoseMorph === 'undefined') return;
    if (!l.img) return;
    const { w, h } = nativeSize(l.img);
    if (!w || !h) return;
    const entry = poseRigEntry(r);
    if (!entry.ready) { poseKickBuild(entry, r); return; }

    const meshKey = JSON.stringify(r.desc.mesh);
    if (entry.meshKey !== meshKey) { poseKickBuild(entry, r); return; }

    if (entry.skin !== r.desc.skin) {
        // 换贴图是微任务级的事 (贴图全局缓存), 换完自己回来补烤。
        if (!entry.pendingSkin) {
            entry.pendingSkin = true;
            entry.skin = r.desc.skin;
            entry.bakeKey = null;
            entry.rig.setSkin(r.desc.skin).then(() => {
                entry.pendingSkin = false;
                poseRefresh();
            });
        }
        return;
    }

    const key = poseBakeKeyOf(r.desc, w, h);
    if (entry.bakeKey === key && r.surface) return;
    poseFastBake(entry, r, w, h);
}

defineAttrType({
    type: 'pose',
    label: 'Pose',
    kind: 'generator',
    order: 9,
    at: { rel: 'tail' },
    chipClass: 'pose-attr-thumb',
    // 角标是一支立正的小人 (头 + 躯干四肢) —— 与其他角标同一档笔画密度。
    badge: { class: 'pose', svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="2" r="1.3" fill="currentColor"/><path d="M5 3.5v3M3.1 4.6h3.8M5 6.5 3.6 8.9M5 6.5l1.4 2.4" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>' },
    // 新功能, 没有老字段可迁。
    fromLegacy: () => null,
    init: () => ({ desc: poseDefaultDescriptor(), surface: null }),
    sanitize: raw => sanitizePoseDescriptor(raw),
    get defaults() { return poseDefaultDescriptor(); },
    // 有墨 = 烤过一次。没烤出来的 (资产缺失/装配失败) 是"参数还在、像素没有" —— Generate 通道
    // 把它当不存在, 但面留在档里, 换个环境打开还在。
    ink: r => !!(r.surface && r.surface.width && r.surface.height),
    // 面是派生但**算不回来就没了** (资产在 git 外), 所以像 3D 那样面随档走 (4.a)。
    snap: r => ({ desc: r.desc, box: null, ownsGrid: false, surface: r.surface || null }),
    load: raw => ({ desc: sanitizePoseDescriptor(raw.desc), box: null, ownsGrid: false, surface: raw.surface || null }),
    clone: (r, dup) => ({ desc: r.desc, box: null, ownsGrid: false, surface: r.surface ? dup(r.surface) : null }),
    title: (r, l) => attrStepNote('Pose', r, l) + (r.desc ? (() => {
        const bones = Object.keys(r.desc.pose.bones).length;
        const m = r.desc.mesh;
        return ` — ${bones} bone${bones === 1 ? '' : 's'} posed, age ${Math.round(m.age)}, `
            + `skin ${r.desc.skin.replace('_', ' ')}${r.desc.bg === null ? ', transparent' : ''}`;
    })() : ''),
    addTitle: 'Add a Pose step — a 3D mannequin in its own window: pose it, frame it, and the render bakes onto this layer automatically (transparent background by default).',
    // 点 chip = 把 Pose 小窗对准**这一枚** (与 Direction 的 dirPinTarget 同一套)。
    open(l, r) { posePinTarget(l, r); },
    sync(l, r) { poseSync(l, r); },
});
