import React from 'react';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import { loadScriptOnce } from './scripts';
import type { BlendPoseDesc, BlendPoseUi, BlendUiSend } from '../types';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';

// Pose 那一格：选中层那枚 Pose 记录的舞台 —— 一只 MakeHuman 人形 (一个 three.js 场景 + 骨架 + 皮肤
// 材质) 在自己的窗口里摆姿态与取景。
//
// 完整编辑（舞台、关节拾取、转把手、七颗形态滑块、皮肤三档、颜色/背景、取景五格、Reset、From image）
// 原来住在页面侧栏的 #poseSection 里，现在整格搬到这里。舞台引擎是仓库里 vendored 的那几份共享脚本：
//   /js/3d-bundle.js   window.K3D（three r160 + TransformControls + loaders）
//   /js/pose_core.js   window.PoseCore（PoseRig：装模型 / 摆姿态 / 捕获，headless 起步）
//   /js/pose_morph.js  window.PoseMorph（morph worker 的把手：形态七参 → 顶点 + 骨位，资产在
//                      /pose-asset/）—— 宿主自己起一只 rig 来看、来摆；页面那一只仍是权威烘面 rig。
// 三者同源（工作台服务器按 /js/*.js 送），只在第一次用到这一格时按序注入一次。
//
// 分工与其它几格一致：页面仍是那枚记录的唯一作者（它在快照 `pose` 里播出 desc + 目标层原生尺寸），
// 这一格只画舞台、把每一笔落成 `pose-desc` / `pose-commit` / `pose-reset-*` / `pose-from-image`
// 动作键回去。相机轨道（右键转 / 中键平移 / 滚轮推拉）、关节选中、把手拖动是**纯视图状态**，住在
// 这一格，不进快照。

// three.js / PoseCore 都是注入进来的经典脚本，这里故意 all-any：舞台侧的活状态、rig、几何体
// 一概交给运行时，不在这层立 TS 契约。
type AnyObj = any;
type MeshParams = BlendPoseDesc['mesh'];

/** 注入进来的全局（pose_core.js + pose_morph.js + 3d-bundle.js）—— 只有在这三个经典脚本落地之后才存在。 */
type PoseGlobals = {
  PoseCore?: {
    available(): boolean;
    PoseRig: new () => AnyObj;
    markerMaterial(kind: string): AnyObj;
  };
  PoseMorph?: {
    failed: boolean;
    solve(mesh: Record<string, unknown>, includeStatic: boolean): Promise<AnyObj>;
  };
  K3D?: { THREE: AnyObj };
  poseModelDataFromMorphMessage?: (m: AnyObj) => AnyObj;
};
const G = () => window as unknown as PoseGlobals;

// ---- 三份经典脚本：按序、只注一次 ----
let scripts: Promise<void> | null = null;
const ensureScripts = (): Promise<void> => {
  if (!scripts) {
    scripts = loadScriptOnce('/js/3d-bundle.js')
      .then(() => loadScriptOnce('/js/pose_core.js'))
      .then(() => loadScriptOnce('/js/pose_morph.js'));
  }
  return scripts;
};

// ---- 舞台与视图活状态（模块级，不跟 React 的挂载走）----
// rig 一旦装好就一直活着：dock 折叠 / 切 tab 会卸载这一格的正文，但 rig 的 canvas 与 GL 上下文
// 留在模块里，挂载时挪进舞台、卸载时从容器里摘出来 —— rig 继续 headless 出图，重挂是同一块布。
let rig: AnyObj = null;
let modelLoaded = false;
let meshKey: string | null = null;
let failKey: string | null = null;
let building = false;
let warned = false;
let lastSkin = '';
let stageEl: HTMLDivElement | null = null;
let canvasEl: HTMLCanvasElement | null = null;
let controls: AnyObj = null;
let raycaster: AnyObj = null;
let desc: BlendPoseDesc | null = null;
let layerW = 0;
let layerH = 0;
let dragging = false;
let dragPoseBaseline: string | null = null;
let orbitSession: { mode: 'orbit' | 'pan'; x: number; y: number } | null = null;
let selectedBone: AnyObj = null;
let hoverBone: AnyObj = null;
let frameQueued = false;
let sendAction: BlendUiSend = () => {};
let alive = false;
let pushBusy: (v: boolean) => void = () => {};
let pushNote: (s: string) => void = () => {};
let pushHint: (s: string) => void = () => {};

let orbitTarget: AnyObj = null;
const orbit = { yaw: 0, pitch: 8, dist: 40 };
const POSE_VIEW_FOV = 45;
const POSE_ORBIT_K = 0.45;                 // 右键拖动: 每像素转多少度 (与 3D tab 一个分寸)
const POSE_ORBIT_EL_MAX = 85;
const POSE_DIST_MIN = 6;
const POSE_DIST_MAX = 300;
const HINT_DEFAULT = 'Left-click a joint · Right-drag orbits · Middle-drag pans · Wheel zooms';

const markDirty = () => {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(frameTick);
};

const applyOrbit = () => {
  const cam = rig.viewCamera;
  const t = orbitTarget || rig.meshCenter;
  const yawRad = orbit.yaw * Math.PI / 180;
  const pitchRad = orbit.pitch * Math.PI / 180;
  const cosP = Math.cos(pitchRad);
  cam.position.set(
    t.x + Math.sin(yawRad) * cosP * orbit.dist,
    t.y + Math.sin(pitchRad) * orbit.dist,
    t.z + Math.cos(yawRad) * cosP * orbit.dist);
  cam.lookAt(t);
  cam.updateMatrixWorld(true);
};

// ---- 每一帧 ----
// 按需一帧 (方向窗的 mark() 同一套): 只在意"画面可能变了", 没有常态 rAF 在烧 GPU。
const frameTick = () => {
  frameQueued = false;
  if (!rig || !stageEl || !canvasEl) return;
  const W = stageEl.clientWidth, H = stageEl.clientHeight;
  if (!W || !H) return;                    // 窗关着/折叠着: 不画
  rig.setViewportSize(W, H);
  applyOrbit();
  // 取景框按**输出的比例**画 (目标层本帧的原生尺寸), 不是舞台的比例 —— 框就是输出的边界。
  if (desc) {
    const nw = layerW > 1 ? layerW : W, nh = layerH > 1 ? layerH : H;
    rig.updateCaptureCamera(nw, nh, desc.cam);
  } else if (rig.captureFrame) {
    rig.captureFrame.visible = false;
  }
  rig.renderView();
};

// ---- desc 的应用: 姿态 + 颜色 (+ 皮肤异步) ----
const applyRigFromDesc = () => {
  if (!rig || !rig.ready || !desc) return;
  if (!dragging) rig.applyPose(desc.pose);
  rig.setColor(desc.color);
  if (desc.skin !== lastSkin) {
    lastSkin = desc.skin;
    rig.setSkin(desc.skin).then(() => markDirty());
  }
  markDirty();
};

// ---- 装配 (morph worker) ----
// 形态变了才重解; 解完自己再检查一趟 (连拖滑块只会有一趟在飞)。失败过就不在同一份形态上重敲。
const kickBuild = () => {
  const g = G();
  if (!desc || building || !g.PoseCore || !g.PoseMorph || !g.poseModelDataFromMorphMessage) return;
  const mk = JSON.stringify(desc.mesh);
  if (rig && rig.ready && meshKey === mk) { applyRigFromDesc(); return; }
  if (warned && (g.PoseMorph.failed || failKey === mk)) return;
  building = true;
  if (alive) pushBusy(true);
  const includeStatic = !modelLoaded;
  const mesh = desc.mesh;
  g.PoseMorph.solve(mesh as unknown as Record<string, unknown>, includeStatic).then((message) => {
    const gg = G();
    if (!gg.PoseCore || !gg.poseModelDataFromMorphMessage) return;
    if (!rig) rig = new gg.PoseCore.PoseRig();
    if (!modelLoaded) {
      // 首装那一趟 worker 才带 staticData (拓扑+uv+skin); 之后的每趟只有顶点与骨位。
      rig.loadModel(gg.poseModelDataFromMorphMessage(message));
      modelLoaded = true;
      orbitTarget = rig.meshCenter.clone();
      orbit.yaw = 0; orbit.pitch = 8; orbit.dist = 40;
    } else {
      rig.updateBody(message.vertices, message.bonePositions, message.indices);
    }
    meshKey = mk;
    applyRigFromDesc();
  }).then(() => {
    building = false;
    warned = false;
    failKey = null;
    if (alive) { pushBusy(false); pushNote(''); }
    attachToStage();
    markDirty();
    kickBuild();          // 收尾照最新 desc 收敛 (拖滑块期间来不及的那一趟)
  }).catch((error) => {
    building = false;
    failKey = mk;
    warned = true;
    if (alive) {
      pushBusy(false);
      pushNote('The mannequin could not be assembled — its assets are missing.');
    }
    console.warn('[kolid pose]', error);
  });
};

// ---- 指针 ----
const wireCanvas = (canvas: HTMLCanvasElement) => {
  canvas.addEventListener('contextmenu', ev => ev.preventDefault());
  canvas.addEventListener('pointerdown', onCanvasDown);
  canvas.addEventListener('pointermove', onCanvasHover);
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    orbit.dist = Math.max(POSE_DIST_MIN, Math.min(POSE_DIST_MAX,
      orbit.dist * (ev.deltaY > 0 ? 1.1 : 1 / 1.1)));
    markDirty();
  }, { passive: false });
  canvas.addEventListener('auxclick', ev => { if (ev.button === 1) ev.preventDefault(); });
};

const onCanvasDown = (ev: PointerEvent) => {
  if (!rig) return;
  // 右键 = 转眼睛, 中键 = 平移: 都只动舞台那台相机, desc 一个字节不动。
  if (ev.button === 2) { ev.preventDefault(); orbitSession = { mode: 'orbit', x: ev.clientX, y: ev.clientY }; return; }
  if (ev.button === 1) { ev.preventDefault(); orbitSession = { mode: 'pan', x: ev.clientX, y: ev.clientY }; return; }
  if (ev.button !== 0) return;
  if (controls && (controls.dragging || controls.axis)) return;   // 把手自己那一趟
  ev.preventDefault();
  selectBone(pickAt(ev.clientX, ev.clientY));
};

const onCanvasHover = (ev: PointerEvent) => {
  if (!rig || orbitSession) return;
  if (controls && (controls.dragging || controls.axis)) return;
  const bone = pickAt(ev.clientX, ev.clientY);
  if (bone === hoverBone) return;
  hoverBone = bone;
  updateMarkers();
  updateHint();
  markDirty();
};

const onWinMove = (ev: PointerEvent) => {
  if (!orbitSession) return;
  const dx = ev.clientX - orbitSession.x, dy = ev.clientY - orbitSession.y;
  orbitSession.x = ev.clientX;
  orbitSession.y = ev.clientY;
  if (orbitSession.mode === 'orbit') {
    orbit.yaw -= dx * POSE_ORBIT_K;
    orbit.pitch = Math.max(-POSE_ORBIT_EL_MAX, Math.min(POSE_ORBIT_EL_MAX, orbit.pitch + dy * POSE_ORBIT_K));
  } else if (rig && stageEl) {
    // 平移: 每像素走的世界距离 = 注视平面上 1px 的尺度, 拖多少走多少。
    const THREE = G().K3D?.THREE;
    const cam = rig.viewCamera;
    const k = 2 * orbit.dist * Math.tan(POSE_VIEW_FOV / 2 * Math.PI / 180) / Math.max(1, stageEl.clientHeight);
    const t = orbitTarget;
    if (t && THREE) {
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      t.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    }
  }
  markDirty();
};
const onWinUp = () => { orbitSession = null; };

// 拾取: ① 关节球 (可靠的小目标) ② 身体网格 + 最近骨头 (参考的 1.5 世界单位阈值)。
const pickAt = (clientX: number, clientY: number): AnyObj => {
  if (!rig) return null;
  const canvas: HTMLCanvasElement | undefined = rig.renderer?.domElement;
  const THREE = G().K3D?.THREE;
  if (!canvas || !THREE) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  if (!raycaster) raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1), rig.viewCamera);
  const markerHits = raycaster.intersectObjects(rig.jointMarkers || [], false);
  if (markerHits.length > 0) {
    const idx = markerHits[0].object.userData?.boneIndex;
    if (rig.boneList[idx]) return rig.boneList[idx];
  }
  const meshHits = rig.skinnedMesh ? raycaster.intersectObject(rig.skinnedMesh, true) : [];
  if (meshHits.length > 0) {
    const point = meshHits[0].point;
    let nearest: AnyObj = null, minD = Infinity;
    const wPos = new THREE.Vector3();
    for (const b of rig.boneList) {
      b.getWorldPosition(wPos);
      const d = point.distanceTo(wPos);
      if (d < minD) { minD = d; nearest = b; }
    }
    if (nearest && minD < 1.5) return nearest;
  }
  return null;
};

const selectBone = (bone: AnyObj) => {
  if (selectedBone === bone) return;
  selectedBone = bone || null;
  if (controls) {
    if (selectedBone) controls.attach(selectedBone);
    else controls.detach();
  }
  updateMarkers();
  updateHint();
  markDirty();
};

const updateMarkers = () => {
  const g = G();
  if (!rig?.jointMarkers || !g.PoseCore) return;
  const matNormal = g.PoseCore.markerMaterial('normal');
  const matSelected = g.PoseCore.markerMaterial('selected');
  for (const m of rig.jointMarkers) {
    const bone = rig.boneList[m.userData.boneIndex];
    const isSelected = bone && bone === selectedBone;
    const isHover = bone && bone === hoverBone;
    m.material = isSelected || isHover ? matSelected : matNormal;
    m.scale.setScalar(isSelected ? 1.5 : isHover ? 1.25 : 1);
  }
};

const updateHint = () => {
  if (!desc) { pushHint(''); return; }
  if (!rig) { pushHint('Building the mannequin…'); return; }
  pushHint(selectedBone ? String(selectedBone.name) : HINT_DEFAULT);
};

// 拖动关节点那一趟的提交: rig 是现成的, 直接从它读回姿态 (与页面同一套: 松手才写 desc, 一次 undo)。
const commitRigPose = (baseline: string) => {
  if (!rig || !desc) { markDirty(); return; }
  const pose = rig.getPose();
  if (JSON.stringify(pose) === baseline) { markDirty(); return; }
  desc = { ...desc, pose };
  sendAction('pose-desc', { patch: { pose } });
  sendAction('pose-commit', { label: 'bones' });
  markDirty();
};

// ---- rig 的舞台挂载 ----
// 一只 rig 的 canvas 一生只有一块: 挂进舞台 = 看得见它; 摘下来 = 它继续 headless 出图。
const attachToStage = () => {
  if (!rig || !stageEl) return;
  const canvas: HTMLCanvasElement = rig.attachCanvas(stageEl);
  if (canvas !== canvasEl) {
    canvasEl = canvas;
    canvasEl.style.position = 'absolute';
    canvasEl.style.inset = '0';
    canvasEl.style.width = '100%';
    canvasEl.style.height = '100%';
    canvasEl.style.display = 'block';
    canvasEl.style.touchAction = 'none';
    wireCanvas(canvasEl);
  }
  rig.setViewportSize(stageEl.clientWidth || 1, stageEl.clientHeight || 1);
  rig.onViewportRestore = () => markDirty();
  if (!orbitTarget && rig.meshCenter) orbitTarget = rig.meshCenter.clone();
  if (!controls && canvasEl) {
    const THREE = G().K3D?.THREE;
    if (THREE) {
      // 把手: 转姿态 (参考同款 rotate/local/0.8)。挂进 overlays —— 捕获时与关节球一视同仁地藏。
      controls = new THREE.TransformControls(rig.viewCamera, canvasEl);
      controls.setMode('rotate');
      controls.setSpace('local');
      controls.setSize(0.8);
      rig.scene.add(controls);
      rig.overlays.push(controls);
      controls.addEventListener('dragging-changed', (e: AnyObj) => {
        if (e.value) {
          dragging = true;
          dragPoseBaseline = rig ? JSON.stringify(rig.getPose()) : null;
        } else {
          dragging = false;
          const baseline = dragPoseBaseline;
          dragPoseBaseline = null;
          if (baseline) commitRigPose(baseline);
          else markDirty();
        }
      });
      controls.addEventListener('objectChange', () => markDirty());
    }
  }
  selectBone(null);
  markDirty();
};

const detachFromStage = () => {
  if (rig) rig.onViewportRestore = null;
  if (canvasEl && canvasEl.parentElement) canvasEl.parentElement.removeChild(canvasEl);
  orbitSession = null;
};

// ---- 一行快照 → 舞台活状态 ----
const applySnapshot = (ui: BlendPoseUi) => {
  layerW = ui.layerW;
  layerH = ui.layerH;
  // 拖动关节期间不采纳快照里的姿态: 那几帧的真值在这一格本地那只 rig 上 (页面回传的只慢一帧)。
  if (!dragging) desc = ui.desc;
  else if (ui.desc && desc) {
    desc = { ...desc, mesh: ui.desc.mesh, cam: ui.desc.cam, skin: ui.desc.skin, color: ui.desc.color, bg: ui.desc.bg };
  }
};

// ---- 面板的每一格 ----
const MESH_FIELDS: { key: keyof MeshParams; label: string; min: number; max: number; step: number; fmt: number }[] = [
  { key: 'age', label: 'Age', min: 1, max: 90, step: 1, fmt: 0 },
  { key: 'gender', label: 'Gender', min: 0, max: 1, step: 0.01, fmt: 2 },
  { key: 'weight', label: 'Weight', min: 0, max: 1, step: 0.01, fmt: 2 },
  { key: 'muscle', label: 'Muscle', min: 0, max: 1, step: 0.01, fmt: 2 },
  { key: 'height', label: 'Height', min: 0, max: 1, step: 0.01, fmt: 2 },
  { key: 'breast_size', label: 'Breast', min: 0, max: 1, step: 0.01, fmt: 2 },
  { key: 'firmness', label: 'Firmness', min: 0, max: 1, step: 0.01, fmt: 2 },
];
const SKINS: { key: string; label: string; tip: string }[] = [
  { key: 'naked', label: 'Naked', tip: 'The base skin texture — the photographed one, no markings' },
  { key: 'naked_marks', label: 'Marks', tip: 'The base skin with its markings' },
  { key: 'dummy_white', label: 'White', tip: 'A plain white matte dummy — reads form, not skin. Falls back to this look whenever a texture is missing' },
];
const CAM_FIELDS: { key: keyof BlendPoseDesc['cam']; label: string; min: number; max: number; step: string; fmt: number; unit: string }[] = [
  { key: 'yaw', label: 'Yaw', min: -180, max: 180, step: '1', fmt: 0, unit: '\u00b0' },
  { key: 'pitch', label: 'Pitch', min: -89, max: 89, step: '1', fmt: 0, unit: '\u00b0' },
  { key: 'zoom', label: 'Zoom', min: 0.1, max: 10, step: '0.05', fmt: 2, unit: '' },
  { key: 'offsetX', label: 'X', min: -20, max: 20, step: '0.1', fmt: 2, unit: '' },
  { key: 'offsetY', label: 'Y', min: -20, max: 20, step: '0.1', fmt: 2, unit: '' },
];
const fmtVal = (v: number, fmt: number) => (fmt ? Number(v).toFixed(fmt) : String(Math.round(v)));

const hexToRgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [32, 32, 36];
};
const rgbToHex = (rgb: [number, number, number]) =>
  '#' + rgb.map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');

const stageBox: React.CSSProperties = {
  position: 'relative', height: 320, border: '1px solid #2a2f3d', borderRadius: 8,
  background: '#101018', overflow: 'hidden', touchAction: 'none', outline: 'none',
};
const hintStyle: React.CSSProperties = {
  position: 'absolute', top: 6, left: 8, zIndex: 3, fontSize: 10.5, letterSpacing: '0.02em',
  color: 'rgba(255,255,255,0.5)', pointerEvents: 'none', whiteSpace: 'pre',
};
const stageNote: React.CSSProperties = {
  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 10.5, color: 'rgba(255,255,255,0.4)', textAlign: 'center', padding: 12, pointerEvents: 'none',
};
const numInput: React.CSSProperties = {
  width: '100%', minWidth: 0, background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.1)',
  borderRadius: 6, padding: '2px 4px', color: 'rgba(255,255,255,0.9)', fontSize: 10.5, outline: 'none',
  colorScheme: 'dark',
};
const cellStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 3, minWidth: 0, flex: '1 1 0' };
const cellLabel: React.CSSProperties = { fontSize: 10, color: 'rgba(255,255,255,0.5)', flexShrink: 0 };
const unitStyle: React.CSSProperties = { fontSize: 10, color: 'rgba(255,255,255,0.4)', flexShrink: 0 };

const STAGE_TITLE = 'A 3D mannequin (a MakeHuman mesh) in its own window. Left-click a joint (or the body '
  + 'near one) to grab it, then turn the rotate handle — right-drag orbits your eye, middle-drag pans it, '
  + 'the wheel zooms it, none of the three touches the render. The yellow frame is the capture camera\'s '
  + 'framing: exactly what lands on the layer. The mesh sliders rebuild the body; Yaw/Pitch/Zoom/X/Y frame '
  + 'the capture (FOV 30, distance 45).';

const PoseBody: React.FC<WorkbenchUnitProps> = ({ send }) => {
  const ui = useBlendUi();
  const p = ui.pose;
  const [ready, setReady] = React.useState(false);
  const [available, setAvailable] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState('');
  const [hint, setHintLocal] = React.useState('');
  const [meshState, setMeshState] = React.useState<MeshParams | null>(null);
  const boxRef = React.useRef<HTMLDivElement | null>(null);
  const camInputs = React.useRef<Record<string, HTMLInputElement | null>>({});
  const focusVal = React.useRef<Record<string, string>>({});
  const meshDragging = React.useRef(false);

  sendAction = send;
  pushBusy = setBusy;
  pushNote = setNote;
  pushHint = setHintLocal;

  // 脚本只注一次；落地后确认引擎可用。
  React.useEffect(() => {
    alive = true;
    ensureScripts().then(() => {
      if (!alive) return;
      const g = G();
      setAvailable(!!(g.PoseCore && g.PoseCore.available()) && !!g.PoseMorph);
      setReady(true);
    }).catch(() => { if (alive) { setAvailable(false); setReady(true); } });
    return () => { alive = false; };
  }, []);

  // 拖动关节点 / 轨道转动的那几条在 window 上（指针拖出舞台边界也不断），挂载一次。
  React.useEffect(() => {
    window.addEventListener('pointermove', onWinMove);
    window.addEventListener('pointerup', onWinUp);
    window.addEventListener('blur', onWinUp);
    return () => {
      window.removeEventListener('pointermove', onWinMove);
      window.removeEventListener('pointerup', onWinUp);
      window.removeEventListener('blur', onWinUp);
    };
  }, []);

  // 舞台容器挂载 / 卸载：canvas 是模块级单例，折叠重挂也是同一块布。
  React.useEffect(() => {
    if (!ready || !p.on) return;
    stageEl = boxRef.current;
    attachToStage();
    markDirty();
    return () => { detachFromStage(); stageEl = null; };
  }, [ready, p.on]);

  // 每一条快照：更新舞台活状态 + 催一趟装配 + 把取景五格同步到当前读数（正在打字的那一格除外）。
  React.useEffect(() => {
    applySnapshot(p);
    if (!meshDragging.current) setMeshState(p.desc ? p.desc.mesh : null);
    applyRigFromDesc();
    kickBuild();
    updateHint();
    markDirty();
    if (!p.on || !p.desc) return;
    for (const f of CAM_FIELDS) {
      const el = camInputs.current[f.key];
      if (!el || document.activeElement === el) continue;
      const v = fmtVal(p.desc.cam[f.key], f.fmt);
      if (el.value !== v) el.value = v;
    }
  }, [p]);

  const setMesh = (key: keyof MeshParams, v: number) => {
    if (!desc) return;
    const mesh = { ...desc.mesh, [key]: v };
    desc = { ...desc, mesh };
    setMeshState(mesh);
    sendAction('pose-desc', { patch: { mesh }, live: true });
  };
  const commitMesh = (key: keyof MeshParams) => {
    if (!desc) return;
    sendAction('pose-commit', { label: 'mesh-' + String(key) });
  };
  const chooseSkin = (key: string) => {
    if (!desc || desc.skin === key) return;
    desc = { ...desc, skin: key };
    sendAction('pose-desc', { patch: { skin: key } });
    sendAction('pose-commit', { label: 'skin' });
  };
  const setColorValue = (color: string) => {
    if (!desc) return;
    desc = { ...desc, color };
    sendAction('pose-desc', { patch: { color }, live: true });
  };
  const setBgTransparent = (transparent: boolean) => {
    if (!desc) return;
    const bg = transparent ? null : (desc.bg || hexToRgb('#202026'));
    desc = { ...desc, bg };
    sendAction('pose-desc', { patch: { bg } });
    sendAction('pose-commit', { label: 'bg' });
  };
  const setBgColorValue = (hex: string) => {
    if (!desc || desc.bg === null) return;
    const bg = hexToRgb(hex);
    desc = { ...desc, bg };
    sendAction('pose-desc', { patch: { bg }, live: true });
  };

  if (!p.on) {
    return (
      <div style={wbStyles.note}>
        Select a layer that carries a Pose step to pose a 3D mannequin here. Add one from the layer&apos;s{' '}
        <span style={{ ...wbStyles.key }}>+</span> chip, or press{' '}
        <span style={{ ...wbStyles.key }}>P</span> to pin a layer&apos;s Pose step.
      </div>
    );
  }

  const d = p.desc;
  const color = d && /^#[0-9a-fA-F]{3,8}$/.test(d.color) ? d.color : '#ffffff';
  const bgHex = d && d.bg ? rgbToHex(d.bg) : '#202026';

  return (
    <div style={{ ...wbStyles.stack, padding: 4, ...wbStyles.armed }}>
      <div ref={boxRef} style={stageBox} title={STAGE_TITLE}
        onPointerDown={e => e.stopPropagation()}>
        <div style={hintStyle}>{hint}</div>
        {busy && !rig && <div style={stageNote}>Building the mannequin…</div>}
        {ready && !available && <div style={stageNote}>Pose needs the 3D bundle and WebGL — the sliders below
          still work.</div>}
        {note && <div style={stageNote}>{note}</div>}
      </div>

      <div style={{ ...wbStyles.row, gap: 6, flexWrap: 'nowrap' }}>
        {MESH_FIELDS.slice(0, 4).map(m => (
          <MeshRow key={m.key as string} m={m} mesh={meshState} meshDragging={meshDragging}
            onLive={setMesh} onCommit={commitMesh} />
        ))}
      </div>
      <div style={{ ...wbStyles.row, gap: 6, flexWrap: 'nowrap' }}>
        {MESH_FIELDS.slice(4).map(m => (
          <MeshRow key={m.key as string} m={m} mesh={meshState} meshDragging={meshDragging}
            onLive={setMesh} onCommit={commitMesh} />
        ))}
        <span style={{ flex: '1 1 0' }} />
      </div>

      <div style={wbStyles.ctrl}>
        <label style={wbStyles.ctrlLabel}>Skin</label>
        <div style={wbStyles.miniGroup}>
          {SKINS.map(s => (
            <button key={s.key} type="button" title={s.tip}
              style={{ ...wbStyles.btn, ...(d && d.skin === s.key ? wbStyles.btnOn : null) }}
              onClick={() => chooseSkin(s.key)}>{s.label}</button>
          ))}
        </div>
      </div>

      <div style={wbStyles.ctrl}>
        <label style={wbStyles.ctrlLabel}>Color</label>
        <input type="color" style={wbStyles.color} value={color}
          title="Tint over the skin texture (white = the texture's own colour)"
          onChange={e => { setColorValue(e.target.value); focusVal.current.color = e.target.value; }}
          onFocus={e => { focusVal.current.color = e.currentTarget.value; }}
          onBlur={e => {
            if (focusVal.current.color === e.currentTarget.value) return;
            sendAction('pose-commit', { label: 'color' });
          }} />
        <span style={{ ...wbStyles.value, width: 64 }}>{color.toUpperCase()}</span>
      </div>

      <div style={wbStyles.ctrl}>
        <label style={wbStyles.ctrlLabel}>Background</label>
        <input type="checkbox" style={wbStyles.check} checked={!!d && d.bg === null}
          title="Tick = a transparent background (the render keeps its alpha). Untick = fill with the colour on the right"
          onChange={e => setBgTransparent(e.currentTarget.checked)} />
        <input type="color" style={wbStyles.color} value={bgHex} disabled={!d || d.bg === null}
          title="Background colour — used when Transparent is unticked"
          onChange={e => { setBgColorValue(e.target.value); focusVal.current.bg = e.target.value; }}
          onFocus={e => { focusVal.current.bg = e.currentTarget.value; }}
          onBlur={e => {
            if (focusVal.current.bg === e.currentTarget.value) return;
            if (!desc || desc.bg === null) return;
            sendAction('pose-commit', { label: 'bg' });
          }} />
      </div>

      <div style={{ ...wbStyles.row, gap: 6, flexWrap: 'nowrap' }}>
        {CAM_FIELDS.slice(0, 3).map(f => (
          <label key={f.key as string} style={cellStyle}>
            <span style={cellLabel}>{f.label}</span>
            <input ref={el => { camInputs.current[f.key] = el; }} type="number" min={f.min} max={f.max} step={f.step}
              disabled={!d} defaultValue={d ? fmtVal(d.cam[f.key], f.fmt) : ''}
              onChange={e => {
                if (!desc) return;
                const n = Number(e.currentTarget.value);
                if (e.currentTarget.value === '' || !Number.isFinite(n)) return;
                const cam = { ...desc.cam, [f.key]: n };
                desc = { ...desc, cam };
                sendAction('pose-desc', { patch: { cam }, live: true });
              }}
              onFocus={e => { focusVal.current['cam-' + String(f.key)] = e.currentTarget.value; }}
              onBlur={e => {
                if (focusVal.current['cam-' + String(f.key)] === e.currentTarget.value) return;
                sendAction('pose-commit', { label: 'cam-' + String(f.key) });
              }} style={numInput} />
            {f.unit && <span style={unitStyle}>{f.unit}</span>}
          </label>
        ))}
      </div>
      <div style={{ ...wbStyles.row, gap: 6, flexWrap: 'nowrap' }}>
        {CAM_FIELDS.slice(3).map(f => (
          <label key={f.key as string} style={cellStyle}>
            <span style={cellLabel}>{f.label}</span>
            <input ref={el => { camInputs.current[f.key] = el; }} type="number" min={f.min} max={f.max} step={f.step}
              disabled={!d} defaultValue={d ? fmtVal(d.cam[f.key], f.fmt) : ''}
              onChange={e => {
                if (!desc) return;
                const n = Number(e.currentTarget.value);
                if (e.currentTarget.value === '' || !Number.isFinite(n)) return;
                const cam = { ...desc.cam, [f.key]: n };
                desc = { ...desc, cam };
                sendAction('pose-desc', { patch: { cam }, live: true });
              }}
              onFocus={e => { focusVal.current['cam-' + String(f.key)] = e.currentTarget.value; }}
              onBlur={e => {
                if (focusVal.current['cam-' + String(f.key)] === e.currentTarget.value) return;
                sendAction('pose-commit', { label: 'cam-' + String(f.key) });
              }} style={numInput} />
            {f.unit && <span style={unitStyle}>{f.unit}</span>}
          </label>
        ))}
        <span style={{ flex: '1 1 0' }} />
      </div>

      <div style={wbStyles.ctrl}>
        <label style={wbStyles.ctrlLabel}>Estimate</label>
        <button type="button" style={wbStyles.btn}
          title="Read a pose off an image you already have — pick one from this document's layers or from the workspace, and the mannequin takes that pose (the render re-bakes onto this layer, one undo). Torso, limbs and head only: fingers stay straight. Runs DWPose on the server, so it takes a moment and needs its models."
          onClick={() => sendAction('pose-from-image')}>From image…</button>
      </div>

      <div style={wbStyles.ctrl}>
        <label style={wbStyles.ctrlLabel}>Reset</label>
        <div style={wbStyles.miniGroup}>
          <button type="button" style={wbStyles.btn}
            title="Back to the rest pose — every joint straight again. The mesh and the framing stay"
            onClick={() => sendAction('pose-reset-pose')}>Pose</button>
          <button type="button" style={wbStyles.btn}
            title="The whole step back to its defaults: rest pose, default mesh, white dummy skin, transparent background, camera back to the front"
            onClick={() => sendAction('pose-reset-all')}>All</button>
        </div>
      </div>
    </div>
  );
};

type MeshRowProps = {
  m: { key: keyof MeshParams; label: string; min: number; max: number; step: number; fmt: number };
  mesh: MeshParams | null;
  meshDragging: React.MutableRefObject<boolean>;
  onLive: (key: keyof MeshParams, v: number) => void;
  onCommit: (key: keyof MeshParams) => void;
};
const MeshRow: React.FC<MeshRowProps> = ({ m, mesh, meshDragging, onLive, onCommit }) => {
  const val = mesh ? Number(mesh[m.key]) : m.min;
  return (
    <label style={cellStyle} title={m.label}>
      <span style={cellLabel}>{m.label}</span>
      <input type="range" style={wbStyles.slider} min={m.min} max={m.max} step={m.step} value={val}
        disabled={!mesh}
        onPointerDown={() => { meshDragging.current = true; }}
        onChange={e => onLive(m.key, Number(e.currentTarget.value))}
        onPointerUp={() => { meshDragging.current = false; onCommit(m.key); }}
        onBlur={() => { meshDragging.current = false; }} />
      <span style={wbStyles.value}>{mesh ? fmtVal(Number(mesh[m.key]), m.fmt) : '—'}</span>
    </label>
  );
};

export const poseUnit: WorkbenchUnit = {
  id: 'pose',
  title: 'Pose',
  hint: 'Pose — a 3D mannequin on the selected layer’s Pose step. Pose it in its own window; the render '
    + 'bakes onto the layer automatically (transparent by default).',
  Body: PoseBody,
};
