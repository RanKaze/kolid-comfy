/* Pose 小窗的编辑器 —— 3D 人形的工作台: 自由轨道相机看姿态、点关节、用一个旋转把手把关节拧到
   位置, 外加七颗形态滑块与取景读数。渲染与捕获在 js/pose_core.js (PoseRig), 解形在 js/pose_morph.js
   (worker), 本文件只管"窗口这一半": 把 rig 的 canvas 搬进舞台、指针、把手与面板字段。

   desc 是权威 (attr/pose.js 的 sanitize 是唯一裁定口), 这里改什么都是 patchPoseTarget —— 整只换
   desc + markAttrPainted + render(), 与 direction 小窗同一套。关节把手的拖动只在松手那一刻提交
   (getPose 读回 rig 的骨头), 因为视图与捕获共用**同一只 rig**, 拖动全程画面里灵的就是真身。

   相机分两台: 舞台这台 (viewCamera) 是自由的眼睛 —— 右键转、中键平移、滚轮推拉, 一个字节的 desc
   都不动; 捕获那台 (captureCamera, FOV 30 / dist 45) 归 desc.cam 管, 舞台上那条黄线取景框就是
   它此刻看到的矩形 —— 框就是输出的边界, "看着舒服"与"烤成什么样"互不绑架。 */

const poseStageEl = document.getElementById('poseStage');
const poseHintEl = document.getElementById('poseHint');
// 形态七颗滑块。Age 是 1-90 的整数, 其余六颗 0-1 (参考 morph 参数的原样)。
const POSE_SLIDERS = [
    { key: 'age', input: document.getElementById('poseAgeRange'), out: document.getElementById('poseAgeValue'), fmt: v => String(Math.round(v)) },
    { key: 'gender', input: document.getElementById('poseGenderRange'), out: document.getElementById('poseGenderValue'), fmt: v => v.toFixed(2) },
    { key: 'weight', input: document.getElementById('poseWeightRange'), out: document.getElementById('poseWeightValue'), fmt: v => v.toFixed(2) },
    { key: 'muscle', input: document.getElementById('poseMuscleRange'), out: document.getElementById('poseMuscleValue'), fmt: v => v.toFixed(2) },
    { key: 'height', input: document.getElementById('poseHeightRange'), out: document.getElementById('poseHeightValue'), fmt: v => v.toFixed(2) },
    { key: 'breast_size', input: document.getElementById('poseBreastRange'), out: document.getElementById('poseBreastValue'), fmt: v => v.toFixed(2) },
    { key: 'firmness', input: document.getElementById('poseFirmnessRange'), out: document.getElementById('poseFirmnessValue'), fmt: v => v.toFixed(2) },
];
const POSE_SKIN_BUTTONS = [
    { key: 'naked', el: document.getElementById('poseSkinNaked') },
    { key: 'naked_marks', el: document.getElementById('poseSkinMarks') },
    { key: 'dummy_white', el: document.getElementById('poseSkinWhite') },
];
const poseColorInputEl = document.getElementById('poseColorInput');
const poseColorValueEl = document.getElementById('poseColorValue');
const poseBgTransparentEl = document.getElementById('poseBgTransparent');
const poseBgInputEl = document.getElementById('poseBgInput');
// 取景读数: Yaw/Pitch 整数量, Zoom/Offset 两位小数 —— 与 direction 的 field 同一套格式规矩。
const POSE_CAM_FIELDS = [
    { key: 'yaw', input: document.getElementById('poseYawNum'), fmt: 0 },
    { key: 'pitch', input: document.getElementById('posePitchNum'), fmt: 0 },
    { key: 'zoom', input: document.getElementById('poseZoomNum'), fmt: 2 },
    { key: 'offsetX', input: document.getElementById('poseOffXNum'), fmt: 2 },
    { key: 'offsetY', input: document.getElementById('poseOffYNum'), fmt: 2 },
];
const poseResetPoseBtn = document.getElementById('poseResetPoseBtn');
const poseResetAllBtn = document.getElementById('poseResetAllBtn');

// ---- 目标 (dirPinTarget/dirGizmoTarget 的同一套规矩) ----
// 小窗编辑的是一枚记录, 不是"选中的层的那个老字段"。pin 只在它的层正是选中层时才算数; 没钉过就
// 退到选中层的第一枚 Pose 记录 —— adoption 不回写, 记录被删时校验失败同样退到选中层。
let posePinnedTarget = null;
function posePinTarget(l, r) {
    if (!l || !r) return;
    posePinnedTarget = { layerId: l.id, ref: r.id };
    selectLayer(l.id);
    if (typeof toolWindows === 'undefined' || !toolWindows.has('poseSection')) {
        toggleToolWindow('poseSection');
    }
    updatePosePanel();
}
function poseGizmoTarget() {
    const l = typeof getLayer === 'function' ? getLayer(selectedId) : null;
    if (!l) return null;
    if (posePinnedTarget && String(posePinnedTarget.layerId) === String(l.id)) {
        const r = attrRecord(posePinnedTarget.ref);
        if (r && r.type === 'pose' && attrRefList(l).indexOf(r.id) >= 0) return { l, r };
    }
    const r = findAttr(l, 'pose');
    return r ? { l, r } : null;
}
function poseRigFor(t) {
    return t && typeof poseRigs !== 'undefined' ? poseRigs.get(t.r.id) || null : null;
}

// ---- desc 的写口 ----
// 与 patchGizmoTarget 同一套: 整只换 (不可变, undo 安全), sanitize 是 spec 自己那道裁定,
// 代次 +1 让折叠缓存认出变化; live 拖动只走 render, 松手才重修行列表。
function patchPoseTarget(t, patch, opts) {
    const spec = ATTR_TYPES[t.r.type] || ATTR_TYPES.pose;
    t.r.desc = spec.sanitize(Object.assign({}, t.r.desc, patch));
    markAttrPainted(t.r);
    if (!(opts && opts.silent)) {
        render();
        if (!(opts && opts.live)) renderLayerList();
    }
    poseMarkDirty();
}
// 拖动关节点那一趟的提交: rig 是现成的, 直接从它读回姿态。
function poseCommitRigPose(baseline) {
    const t = poseGizmoTarget();
    const rig = poseViewRig;
    if (!t || !rig || poseRigFor(t)?.rig !== rig) return;
    const pose = rig.getPose();
    if (baseline && JSON.stringify(pose) === baseline) return;
    patchPoseTarget(t, { pose });
    pushHistory('pose-' + poseHistoryKey(pose));
    setStatus('Pose — ' + poseSummary(pose));
}
function poseHistoryKey(pose) {
    const names = Object.keys(pose.bones).sort();
    return names.map(n => n + pose.bones[n].map(v => Math.round(v)).join(',')).join('_').slice(0, 180) || 'rest';
}
function poseSummary(pose) {
    const n = Object.keys(pose.bones).length;
    return n ? `${n} joint${n === 1 ? '' : 's'} posed` : 'back to the rest pose';
}

// ---- rig 的舞台挂载 ----
// 一只 rig 的 canvas 一生只有一块: 挂进舞台 = 编辑器看得见它; 摘下来 = 它继续 headless 出图
// (renderer 与 canvas 不随 DOM 走)。捕获那一趟把缓冲借走又还回来, 还完由 onViewportRestore 补帧。
let poseViewRig = null;
let poseControls = null;
let poseSelectedBone = null;
let poseHoverBone = null;
let poseDrag = null;                        // {mode:'orbit'|'pan', x, y}
let poseDragBaseline = null;                // 把手按下那刻的姿态, 松手比对用
let poseFrameQueued = false;
let poseRaycasterObj = null;
const poseOrbit = { yaw: 0, pitch: 8, dist: 40, target: null };
const POSE_VIEW_FOV = 45;
const POSE_ORBIT_K = 0.45;                  // 右键拖动: 每像素转多少度 (与 3D tab 一个分寸)
const POSE_ORBIT_EL_MAX = 85;
const POSE_DIST_MIN = 6;
const POSE_DIST_MAX = 300;

function poseMarkDirty() {
    if (poseFrameQueued) return;
    poseFrameQueued = true;
    requestAnimationFrame(poseFrameTick);
}

function poseAttach(entry, r) {
    const rig = entry?.rig;
    if (!rig || poseViewRig === rig) return;
    poseDetach();
    poseViewRig = rig;
    const canvas = rig.attachCanvas(poseStageEl);
    canvas.classList.add('pose-canvas');
    rig.setViewportSize(poseStageEl.clientWidth || 1, poseStageEl.clientHeight || 1);
    rig.onViewportRestore = () => poseMarkDirty();
    poseOrbit.target = rig.meshCenter.clone();
    poseOrbit.yaw = 0;
    poseOrbit.pitch = 8;
    poseOrbit.dist = 40;
    // 把手: 转姿态 (参考同款 rotate/local/0.8)。挂进 overlays —— 捕获时与关节球一视同仁地藏,
    // 不然松手那一趟的像素里会烙着一只三色环。
    const K3DRef = window.K3D;
    poseControls = new K3DRef.TransformControls(rig.viewCamera, canvas);
    poseControls.setMode('rotate');
    poseControls.setSpace('local');
    poseControls.setSize(0.8);
    rig.scene.add(poseControls);
    rig.overlays.push(poseControls);
    poseControls.addEventListener('dragging-changed', (e) => {
        if (e.value) {
            poseDragBaseline = poseViewRig ? JSON.stringify(poseViewRig.getPose()) : null;
        } else {
            const baseline = poseDragBaseline;
            poseDragBaseline = null;
            if (baseline) poseCommitRigPose(baseline);
            else poseMarkDirty();
        }
    });
    poseControls.addEventListener('objectChange', () => poseMarkDirty());
    poseWireCanvas(canvas);
    poseSelectBone(null);
    poseMarkDirty();
}

function poseDetach() {
    if (!poseViewRig) return;
    const rig = poseViewRig;
    if (poseControls) {
        poseControls.detach();
        rig.scene.remove(poseControls);
        const i = rig.overlays.indexOf(poseControls);
        if (i >= 0) rig.overlays.splice(i, 1);
        if (typeof poseControls.dispose === 'function') poseControls.dispose();
        poseControls = null;
    }
    rig.onViewportRestore = null;
    rig.renderer?.domElement?.remove();
    poseViewRig = null;
    poseSelectedBone = null;
    poseHoverBone = null;
    poseDrag = null;
    poseDragBaseline = null;
}

function poseViewRigIs(rig) { return !!rig && rig === poseViewRig; }
function poseViewReleaseRig() { poseDetach(); }
// 关窗: 摘舞台 (rig 继续 headless), 顺手断开可能停在一半的拖动会话。
function poseViewOnWindowClose() {
    if (poseDrag) poseDrag = null;
    poseDetach();
}

// ---- 每一帧 ----
// 按需一帧 (方向窗的 mark() 同一套): 只在意"画面可能变了", 没有常态 rAF 在烧 GPU。
function poseFrameTick() {
    poseFrameQueued = false;
    const rig = poseViewRig;
    const stage = poseStageEl;
    if (!rig || !stage) return;
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) return;                   // 窗关着/折叠着: 不画; 捕获自己那一趟不受影响
    rig.setViewportSize(W, H);
    poseApplyOrbit(rig);
    // 取景框按**输出的比例**画 (图层本帧的原生尺寸), 不是舞台的比例 —— 框就是输出的边界。
    const t = poseGizmoTarget();
    if (t && t.r.desc) {
        const n = nativeSize(t.l.img);
        const nw = n.w > 1 ? n.w : W, nh = n.h > 1 ? n.h : H;
        rig.updateCaptureCamera(nw, nh, t.r.desc.cam);
    } else if (rig.captureFrame) {
        rig.captureFrame.visible = false;
    }
    rig.renderView();
}
function poseApplyOrbit(rig) {
    const cam = rig.viewCamera;
    const t = poseOrbit.target || rig.meshCenter;
    const yawRad = poseOrbit.yaw * Math.PI / 180;
    const pitchRad = poseOrbit.pitch * Math.PI / 180;
    const cosP = Math.cos(pitchRad);
    cam.position.set(
        t.x + Math.sin(yawRad) * cosP * poseOrbit.dist,
        t.y + Math.sin(pitchRad) * poseOrbit.dist,
        t.z + Math.cos(yawRad) * cosP * poseOrbit.dist);
    cam.lookAt(t);
    cam.updateMatrixWorld(true);
}

// ---- 指针 ----
function poseWireCanvas(canvas) {
    canvas.addEventListener('contextmenu', ev => ev.preventDefault());
    canvas.addEventListener('pointerdown', poseCanvasDown);
    canvas.addEventListener('pointermove', poseCanvasHover);
    canvas.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        poseOrbit.dist = Math.max(POSE_DIST_MIN, Math.min(POSE_DIST_MAX,
            poseOrbit.dist * (ev.deltaY > 0 ? 1.1 : 1 / 1.1)));
        poseMarkDirty();
    }, { passive: false });
    canvas.addEventListener('auxclick', ev => { if (ev.button === 1) ev.preventDefault(); });
}
function poseCanvasDown(ev) {
    if (!poseViewRig) return;
    // 右键 = 转眼睛, 中键 = 平移 (参考 pose studio 的手势): 都只动舞台那台相机, desc 一个字节不动。
    if (ev.button === 2) {
        ev.preventDefault();
        poseDrag = { mode: 'orbit', x: ev.clientX, y: ev.clientY };
        return;
    }
    if (ev.button === 1) {
        ev.preventDefault();
        poseDrag = { mode: 'pan', x: ev.clientX, y: ev.clientY };
        return;
    }
    if (ev.button !== 0) return;
    // 把手自己那一趟 (hover 时 axis 已亮): 交给 TransformControls, 不抢。
    if (poseControls && (poseControls.dragging || poseControls.axis)) return;
    const bone = posePickAt(ev.clientX, ev.clientY);
    poseSelectBone(bone);
}
function poseCanvasHover(ev) {
    if (!poseViewRig || poseDrag) return;
    if (poseControls && (poseControls.dragging || poseControls.axis)) return;
    const bone = posePickAt(ev.clientX, ev.clientY);
    if (bone === poseHoverBone) return;
    poseHoverBone = bone;
    poseUpdateMarkers();
    poseMarkDirty();
}
window.addEventListener('pointermove', (ev) => {
    if (!poseDrag) return;
    const dx = ev.clientX - poseDrag.x, dy = ev.clientY - poseDrag.y;
    poseDrag.x = ev.clientX;
    poseDrag.y = ev.clientY;
    if (poseDrag.mode === 'orbit') {
        poseOrbit.yaw -= dx * POSE_ORBIT_K;
        poseOrbit.pitch = Math.max(-POSE_ORBIT_EL_MAX, Math.min(POSE_ORBIT_EL_MAX, poseOrbit.pitch + dy * POSE_ORBIT_K));
    } else if (poseViewRig) {
        // 平移: 每像素走的世界距离 = 注视平面上 1px 的尺度, 拖多少走多少。
        const cam = poseViewRig.viewCamera;
        const k = 2 * poseOrbit.dist * Math.tan(POSE_VIEW_FOV / 2 * Math.PI / 180)
            / Math.max(1, poseStageEl.clientHeight);
        const t = poseOrbit.target;
        if (t) {
            const right = new K3D.THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
            const up = new K3D.THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
            t.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
        }
    }
    poseMarkDirty();
});
window.addEventListener('pointerup', () => { if (poseDrag) poseDrag = null; });
window.addEventListener('blur', () => { poseDrag = null; });

// 拾取: ① 关节球 (可靠的小目标) ② 身体网格 + 最近骨头 (参考的 1.5 世界单位阈值, 免得点到
// 离骨头很远的地方也被拽到别的关节上)。
function posePickAt(clientX, clientY) {
    const rig = poseViewRig;
    const canvas = rig?.renderer?.domElement;
    if (!rig || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    if (!poseRaycasterObj) poseRaycasterObj = new K3D.THREE.Raycaster();
    poseRaycasterObj.setFromCamera(new K3D.THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1), rig.viewCamera);
    const markerHits = poseRaycasterObj.intersectObjects(rig.jointMarkers || [], false);
    if (markerHits.length > 0) {
        const idx = markerHits[0].object.userData?.boneIndex;
        if (rig.boneList[idx]) return rig.boneList[idx];
    }
    const meshHits = rig.skinnedMesh ? poseRaycasterObj.intersectObject(rig.skinnedMesh, true) : [];
    if (meshHits.length > 0) {
        const point = meshHits[0].point;
        let nearest = null, minD = Infinity;
        const wPos = new K3D.THREE.Vector3();
        for (const b of rig.boneList) {
            b.getWorldPosition(wPos);
            const d = point.distanceTo(wPos);
            if (d < minD) { minD = d; nearest = b; }
        }
        if (nearest && minD < 1.5) return nearest;
    }
    return null;
}

function poseSelectBone(bone) {
    if (poseSelectedBone === bone) return;
    poseSelectedBone = bone || null;
    if (poseControls) {
        if (poseSelectedBone) poseControls.attach(poseSelectedBone);
        else poseControls.detach();
    }
    poseUpdateMarkers();
    poseHintUpdate();
    poseMarkDirty();
}

function poseUpdateMarkers() {
    const rig = poseViewRig;
    if (!rig?.jointMarkers) return;
    const matNormal = PoseCore.markerMaterial('normal');
    const matSelected = PoseCore.markerMaterial('selected');
    for (const m of rig.jointMarkers) {
        const bone = rig.boneList[m.userData.boneIndex];
        const isSelected = bone && bone === poseSelectedBone;
        const isHover = bone && bone === poseHoverBone;
        m.material = isSelected || isHover ? matSelected : matNormal;
        m.scale.setScalar(isSelected ? 1.5 : isHover ? 1.25 : 1);
    }
}

function poseHintUpdate() {
    if (!poseHintEl) return;
    const t = poseGizmoTarget();
    const rig = poseViewRig;
    if (!t) { poseHintEl.textContent = ''; return; }
    if (!rig) {
        poseHintEl.textContent = poseEditorAvailable() ? 'Building the mannequin…' : 'Pose needs the 3D bundle and WebGL';
        return;
    }
    poseHintEl.textContent = poseSelectedBone
        ? poseSelectedBone.name
        : 'Left-click a joint · Right-drag orbits · Middle-drag pans · Wheel zooms';
}
function poseEditorAvailable() {
    return typeof PoseCore !== 'undefined' && PoseCore.available() && typeof PoseMorph !== 'undefined';
}

// ---- 面板的每一格 ----
function poseFieldText(v, fmt) {
    return fmt ? Number(v).toFixed(fmt) : String(Math.round(v));
}
function poseRgbFromHex(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [32, 32, 36];
}
function poseHexFromRgb(rgb) {
    return '#' + rgb.map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');
}

for (const s of POSE_SLIDERS) {
    if (!s.input) continue;
    s.input.addEventListener('input', () => {
        const t = poseGizmoTarget();
        if (!t) return;
        const v = Number(s.input.value);
        if (!Number.isFinite(v)) return;
        // 形态变了 = worker 重解一趟 (异步); desc 立刻改, sync 的快路会等 rig 回来再烤 —— 连拖
        // 只会有一次在飞的解形 (building 闸), 收尾照最新 desc 收敛。
        patchPoseTarget(t, { mesh: Object.assign({}, t.r.desc.mesh, { [s.key]: v }) }, { live: true });
        if (s.out) s.out.textContent = s.fmt(v);
    });
    s.input.addEventListener('change', () => {
        if (!poseGizmoTarget()) return;
        renderLayerList();
        pushHistory('pose-' + s.key);
    });
}

for (const b of POSE_SKIN_BUTTONS) {
    if (!b.el) continue;
    b.el.addEventListener('click', () => {
        const t = poseGizmoTarget();
        if (!t || t.r.desc.skin === b.key) return;
        patchPoseTarget(t, { skin: b.key });
        pushHistory('pose-skin');
    });
}

if (poseColorInputEl) {
    poseColorInputEl.addEventListener('input', () => {
        const t = poseGizmoTarget();
        if (!t) return;
        patchPoseTarget(t, { color: poseColorInputEl.value }, { live: true });
        if (poseColorValueEl) poseColorValueEl.textContent = poseColorInputEl.value.toUpperCase();
    });
    poseColorInputEl.addEventListener('change', () => {
        if (poseGizmoTarget()) pushHistory('pose-color');
    });
}

if (poseBgTransparentEl) {
    poseBgTransparentEl.addEventListener('change', () => {
        const t = poseGizmoTarget();
        if (!t) return;
        const bg = poseBgTransparentEl.checked ? null : poseRgbFromHex(poseBgInputEl?.value);
        patchPoseTarget(t, { bg });
        pushHistory('pose-bg');
    });
}
if (poseBgInputEl) {
    poseBgInputEl.addEventListener('input', () => {
        const t = poseGizmoTarget();
        if (!t || poseBgTransparentEl?.checked) return;
        patchPoseTarget(t, { bg: poseRgbFromHex(poseBgInputEl.value) }, { live: true });
    });
    poseBgInputEl.addEventListener('change', () => {
        if (poseGizmoTarget() && !poseBgTransparentEl?.checked) pushHistory('pose-bg');
    });
}

for (const f of POSE_CAM_FIELDS) {
    if (!f.input) continue;
    f.input.addEventListener('input', () => {
        const t = poseGizmoTarget();
        if (!t) return;
        const n = Number(f.input.value);
        if (f.input.value === '' || !Number.isFinite(n)) return;
        patchPoseTarget(t, { cam: Object.assign({}, t.r.desc.cam, { [f.key]: n }) }, { live: true });
    });
    f.input.addEventListener('change', () => {
        const t = poseGizmoTarget();
        if (!t) return;
        f.input.value = poseFieldText(t.r.desc.cam[f.key], f.fmt);   // 回读 sanitize 之后的实际读数
        renderLayerList();
        pushHistory('pose-cam');
    });
}

if (poseResetPoseBtn) {
    poseResetPoseBtn.addEventListener('click', () => {
        const t = poseGizmoTarget();
        if (!t) return;
        patchPoseTarget(t, { pose: { bones: {}, bonePositions: {}, modelRotation: [0, 0, 0] } });
        pushHistory('pose-reset-pose');
        setStatus('Pose reset to rest — the mesh and framing stay');
    });
}
if (poseResetAllBtn) {
    poseResetAllBtn.addEventListener('click', () => {
        const t = poseGizmoTarget();
        if (!t) return;
        patchPoseTarget(t, Object.assign({}, ATTR_TYPES.pose.defaults));
        pushHistory('pose-reset');
        setStatus('Pose step reset to its defaults');
    });
}

// ---- 面板总更新 (renderLayerList 那一趟喊的) ----
function updatePosePanel() {
    const section = document.getElementById('poseSection');
    if (!section) return;
    const t = poseGizmoTarget();
    section.classList.toggle('active-tool', !!t);
    const open = typeof toolWindows !== 'undefined' && toolWindows.has('poseSection');
    let entry = t ? poseRigFor(t) : null;
    if (t && open && poseEditorAvailable()) {
        if (!entry || (!entry.ready && !entry.building)) {
            if (typeof poseKickBuild === 'function') { entry = poseRigEntry(t.r); poseKickBuild(entry, t.r); }
        }
        if (entry?.ready && entry.rig) poseAttach(entry, t.r);
        else poseDetach();
    } else {
        poseDetach();
    }

    const d = t ? t.r.desc : null;
    const on = !!d;
    for (const s of POSE_SLIDERS) {
        if (!s.input) continue;
        s.input.disabled = !on;
        if (on) {
            const v = d.mesh[s.key];
            if (String(s.input.value) !== String(v)) s.input.value = String(v);
            if (s.out) s.out.textContent = s.fmt(v);
        } else if (s.out) s.out.textContent = '—';
    }
    for (const b of POSE_SKIN_BUTTONS) {
        if (!b.el) continue;
        b.el.disabled = !on;
        b.el.classList.toggle('active', !!d && d.skin === b.key);
    }
    if (poseColorInputEl) {
        poseColorInputEl.disabled = !on;
        if (on) poseColorInputEl.value = d.color;
    }
    if (poseColorValueEl) poseColorValueEl.textContent = on ? d.color.toUpperCase() : '';
    if (poseBgTransparentEl) {
        poseBgTransparentEl.disabled = !on;
        if (on) poseBgTransparentEl.checked = d.bg === null;
    }
    if (poseBgInputEl) {
        poseBgInputEl.disabled = !on || !!(d && d.bg === null);
        if (on && d.bg) poseBgInputEl.value = poseHexFromRgb(d.bg);
    }
    for (const f of POSE_CAM_FIELDS) {
        if (!f.input) continue;
        f.input.disabled = !on;
        if (on && document.activeElement !== f.input) {
            const v = poseFieldText(d.cam[f.key], f.fmt);
            if (f.input.value !== v) f.input.value = v;
        }
    }
    if (poseResetPoseBtn) poseResetPoseBtn.disabled = !on;
    if (poseResetAllBtn) poseResetAllBtn.disabled = !on;

    poseHintUpdate();
    poseMarkDirty();
}

// 舞台的尺寸变了 (开窗/拉窗/折叠) 就补一帧。尺寸为 0 的那一帧 poseFrameTick 自己会跳过。
if (poseStageEl && typeof ResizeObserver === 'function') {
    new ResizeObserver(() => poseMarkDirty()).observe(poseStageEl);
}

// P = Pose 窗开合 (与 D 打 Direction 同一个礼数; D 在本页内联脚本里, P 挨着它自己的小节放这里)。
// 焦点在输入格时不抢字, 弹窗开着时不越权。
window.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key !== 'p' && ev.key !== 'P') return;
    const tgt = ev.target;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
    if (typeof modalOpen === 'function' && modalOpen()) return;
    ev.preventDefault();
    ev.stopPropagation();
    toggleToolWindow('poseSection');
});
