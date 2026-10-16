import React from 'react';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import { loadScriptOnce } from './scripts';
import type { BlendGeometryDesc, BlendGeometryUi, BlendUiSend } from '../types';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';

// Geometry 那一格：选中层那枚 geometry 家族记录（direction / point / ray / plane）的舞台。
//
// 完整编辑（three.js 世界图、把手、轨道相机、六格数字、色块、Reset、W/E/X）原来住在页面侧栏的
// #directionSection 里，现在整格搬到这里。舞台引擎是仓库里 vendored 的那份共享脚本：
//   /js/3d-bundle.js   window.K3D（three r160 + loaders）
//   /js/geo_math.js    家族的世界数学（四元数 / 世界坐标 / 把手 / 旋转环 / 命中判定），页面与宿主共用
//   /js/direction_view.js  window.DirView（同一颗 three.js 视图引擎）
// 三者同源（工作台服务器按 /js/*.js 送），只在第一次用到这一格时按序注入一次。
//
// 分工与其它几格一致：页面仍是那枚记录的唯一作者（它在快照 `geometry` 里播出 desc 与参考图），
// 这一格只画舞台、把每一笔落成 `geometry-desc` / `geometry-commit` / `geometry-reset` 动作键回去。
// 相机轨道（中键拖 / 滚轮）与 W/E/X 把手模式是**纯视图状态**，住在这一格，不进快照。

type Pt = { x: number; y: number };
type Quat = { x: number; y: number; z: number; w: number };
type GeoState = { kind: string; desc: BlendGeometryDesc };
type RingPts = { key: string; pts: Pt[] };
type Drag = { axis: string; pt: Pt; moved: boolean; shiftKey: boolean; grab?: { axis?: string } | null };

/** 注入进来的全局（geo_math.js + direction_view.js）—— 只有在这两个经典脚本落地之后才存在。 */
type Geo = {
  DirView?: {
    available(): boolean;
    live(): boolean;
    frame(c: HTMLCanvasElement, state: unknown, opts: unknown): boolean;
    handlePoints(state: unknown): Record<string, Pt> | null;
    project(p: { x: number; y: number; z: number }): Pt | null;
    orbit(dx: number, dy: number): void;
    zoom(f: number): void;
    grabAxis(axis: string, state: unknown, pt: Pt): { axis?: string } | null;
    grabRotate(axis: string, state: unknown, pt: Pt): { axis?: string } | null;
    axisDelta(axis: string, state: unknown, pt: Pt, prev: unknown): Partial<BlendGeometryDesc> | null;
    state(): { live: boolean; broken: boolean };
  };
  dirHitHandle?(W: number, H: number, state: unknown, pt: Pt, pts: unknown): string | null;
  famHandlePoints?(W: number, H: number, state: unknown): Record<string, Pt>;
  rotRingAxes?(state: unknown): { key: string; samples: { x: number; y: number; z: number }[] }[];
  setGizmoMode?(m: string): void;
  setGizmoSpace?(s: string): void;
  setGeoCanvasAspect?(fn: () => number): void;
  geoEuler?(q: Quat): { yaw: number; pitch: number; roll: number };
  qFromEuler?(yaw: number, pitch: number, roll: number): Quat;
  qNormalize?(q: Quat): Quat;
};
const G = () => window as unknown as Geo;

const KIND_NAME: Record<string, string> = { direction: 'Direction', point: 'Point', ray: 'Ray', plane: 'Plane' };
const IDENTITY: BlendGeometryDesc = {
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, color: '#ff2e88',
};

// ---- 三份经典脚本：按序、只注一次 ----
let scripts: Promise<void> | null = null;
const ensureScripts = (): Promise<void> => {
  if (!scripts) {
    scripts = loadScriptOnce('/js/3d-bundle.js')
      .then(() => loadScriptOnce('/js/geo_math.js'))
      .then(() => loadScriptOnce('/js/direction_view.js'));
  }
  return scripts;
};

// ---- 舞台与视图活状态（模块级，不跟 React 的挂载走）----
// DirView.begin 只认第一次交进去的那块 canvas，之后永久画它；而这一格折叠 / 切 tab 时正文会卸载。
// 所以 canvas 留在模块里：挂载时挪进容器，卸载时从容器里摘出来 —— 同一个对象始终是 DirView 的布。
let canvas: HTMLCanvasElement | null = null;
let refCanvas: HTMLCanvasElement | null = null;
let lastRef = '';
let aspectW = 0, aspectH = 0;
let desc: BlendGeometryDesc | null = null;
let kind = 'direction';
let on = false;
let drag: Drag | null = null;
let orbit: Pt | null = null;
let hover: string | null = null;
let hostMode: 'move' | 'rotate' = 'move';
let hostSpace: 'global' | 'local' = 'global';
let sendAction: BlendUiSend = () => {};
let lastState: GeoState = { kind: 'direction', desc: IDENTITY };
// DirView.draw 在没有 frame 过的 state 时回落到 `dirGizmoState()`（页面那份住在 direction.js）。
// 宿主这里没有方向面板，就补一个只读数、不改数的回落，免得它断在一个未定义的名字上。
if (typeof window !== 'undefined') {
  (window as unknown as { dirGizmoState?: () => GeoState }).dirGizmoState = () => lastState;
}

const ptOf = (clientX: number, clientY: number): Pt => {
  const c = canvas;
  if (!c) return { x: 0, y: 0 };
  const r = c.getBoundingClientRect();
  return { x: clientX - r.left - c.clientWidth / 2, y: clientY - r.top - c.clientHeight / 2 };
};

const eulerOf = (q: Quat) => {
  const g = G();
  return g.geoEuler ? g.geoEuler(q) : { yaw: 0, pitch: 0, roll: 0 };
};
// 与页面 direction.js 的 qEulerPatch 一字不差：欧拉补丁重新合成四元数（其余分量保留）。
const eulerPatch = (q: Quat, patch: { yaw?: number; pitch?: number; roll?: number }): Quat => {
  const g = G();
  if (!g.geoEuler || !g.qFromEuler || !g.qNormalize) return q;
  const e = g.geoEuler(q);
  return g.qNormalize(g.qFromEuler(
    patch.yaw !== undefined ? patch.yaw : e.yaw,
    patch.pitch !== undefined ? patch.pitch : e.pitch,
    patch.roll !== undefined ? patch.roll : e.roll));
};

// 命中判定吃的屏幕落点：移动模式是几根把手的点（3D 视图投影），旋转模式是几根环的采样点串。
// 与页面 direction.js 的 dirScreenHandles 同一分流；命中代码只有一份（geo_math 的 dirHitHandle）。
const ringPts = (state: GeoState): RingPts[] => {
  const g = G();
  const rings = g.rotRingAxes ? g.rotRingAxes(state) : [];
  return rings.map(a => ({
    key: a.key,
    pts: a.samples.map(p => (g.DirView ? g.DirView.project(p) : null)).filter((p): p is Pt => !!p),
  }));
};
const screenHandles = (state: GeoState): unknown => {
  const g = G();
  if (hostMode === 'rotate') return ringPts(state);
  const c = canvas;
  const W = c ? c.clientWidth : 1, H = c ? c.clientHeight : 1;
  return (g.DirView && g.DirView.live() && g.DirView.handlePoints(state))
    || (g.famHandlePoints ? g.famHandlePoints(W, H, state) : {});
};

const paint = (): boolean => {
  const g = G();
  const c = canvas;
  if (!c || !g.DirView || !desc) return false;
  lastState = { kind, desc };
  return g.DirView.frame(c, lastState, {
    chrome: true, dim: !on, hover, state: drag ? drag.axis : null,
  });
};

const applyPatch = (patch: Partial<BlendGeometryDesc>) => {
  if (desc) desc = { ...desc, ...patch };
};

const endDrag = () => {
  const d = drag;
  if (!d) return;
  drag = null;
  if (d.moved) sendAction('geometry-commit', { label: d.axis });
  if (canvas) canvas.style.cursor = hover ? 'grab' : 'default';
  paint();
};

const fmtVal = (v: number, fmt: number) => (fmt ? Number(v).toFixed(fmt) : String(Math.round(v)));

/** 六格数字：位置三格（direction 没有位置，不给）、Yaw/Pitch（point 没朝向，不给）、Roll（只 direction）。
 *  get/patch 与页面 DIR_FIELDS 一字不差 —— 位置直读 position，角度是四元数分解出的欧拉。 */
type FieldSpec = {
  key: string; label: string; step: string; fmt: number;
  on: (k: string) => boolean;
  get: (d: BlendGeometryDesc) => number;
  patch: (d: BlendGeometryDesc, v: number) => Partial<BlendGeometryDesc>;
};
const FIELDS: FieldSpec[] = [
  { key: 'x', label: 'X', step: '0.01', fmt: 2, on: k => k !== 'direction',
    get: d => d.position.x, patch: (d, v) => ({ position: { ...d.position, x: v } }) },
  { key: 'y', label: 'Y', step: '0.01', fmt: 2, on: k => k !== 'direction',
    get: d => d.position.y, patch: (d, v) => ({ position: { ...d.position, y: v } }) },
  { key: 'z', label: 'Z', step: '0.01', fmt: 2, on: k => k !== 'direction',
    get: d => d.position.z, patch: (d, v) => ({ position: { ...d.position, z: v } }) },
  { key: 'yaw', label: 'Yaw', step: '1', fmt: 0, on: k => k !== 'point',
    get: d => eulerOf(d.rotation).yaw, patch: (d, v) => ({ rotation: eulerPatch(d.rotation, { yaw: v }) }) },
  { key: 'pitch', label: 'Pitch', step: '1', fmt: 0, on: k => k !== 'point',
    get: d => eulerOf(d.rotation).pitch, patch: (d, v) => ({ rotation: eulerPatch(d.rotation, { pitch: v }) }) },
  { key: 'roll', label: 'Roll', step: '1', fmt: 0, on: k => k === 'direction',
    get: d => eulerOf(d.rotation).roll, patch: (d, v) => ({ rotation: eulerPatch(d.rotation, { roll: v }) }) },
];

// ---- 一行快照 → 舞台活状态 ----
const applySnapshot = (ui: BlendGeometryUi) => {
  on = !!ui.on;
  kind = ui.kind || 'direction';
  // 拖动期间不采纳快照里的 desc：那几帧的真值在这一格的本地镜像里（页面回传的只慢一帧）。
  if (!drag) desc = ui.desc ? { position: { ...ui.desc.position }, rotation: { ...ui.desc.rotation }, color: ui.desc.color } : null;
  aspectW = ui.canvasW;
  aspectH = ui.canvasH;
  // 参考图：字符串没变就不重新解码（页面每帧都播，但内容只在真变过之后才不同）。
  if (ui.ref && ui.ref !== lastRef) {
    lastRef = ui.ref;
    const img = new Image();
    img.onload = () => {
      const rc = refCanvas || (refCanvas = document.createElement('canvas'));
      rc.width = img.naturalWidth || 1;
      rc.height = img.naturalHeight || 1;
      const ctx = rc.getContext('2d');
      if (ctx) ctx.drawImage(img, 0, 0);
      (window as unknown as { dirRefCanvas?: HTMLCanvasElement | null }).dirRefCanvas = rc;
      (window as unknown as { dirRefVersion?: number }).dirRefVersion = ui.refVersion;
      paint();
    };
    img.src = ui.ref;
  } else if (!ui.ref) {
    lastRef = '';
    (window as unknown as { dirRefCanvas?: HTMLCanvasElement | null }).dirRefCanvas = null;
  }
  paint();
};

const stageBox: React.CSSProperties = {
  position: 'relative', height: 240, border: '1px solid #2a2f3d', borderRadius: 8,
  background: '#0d1117', overflow: 'hidden', touchAction: 'none', outline: 'none',
};
const hintStyle: React.CSSProperties = {
  position: 'absolute', top: 6, left: 8, zIndex: 3, fontSize: 10.5, letterSpacing: '0.02em',
  color: 'rgba(255,255,255,0.4)', pointerEvents: 'none', whiteSpace: 'pre',
};
const hintKey: React.CSSProperties = { color: '#fff', fontWeight: 600 };
const stageNote: React.CSSProperties = {
  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 10.5, color: 'rgba(255,255,255,0.4)', textAlign: 'center', padding: 12, pointerEvents: 'none',
};
const cellStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 3, minWidth: 0, flex: '1 1 0' };
const cellLabel: React.CSSProperties = { fontSize: 10, color: 'rgba(255,255,255,0.5)', flexShrink: 0 };
const numInput: React.CSSProperties = {
  width: '100%', minWidth: 0, background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.1)',
  borderRadius: 6, padding: '2px 4px', color: 'rgba(255,255,255,0.9)', fontSize: 10.5, outline: 'none',
  colorScheme: 'dark',
};

const STAGE_TITLE = 'The world the image lies in: the canvas plane (textured with the current context image, '
  + 'minus the record you are editing) on a ground grid. Middle-drag to orbit, scroll to zoom — both move your '
  + 'eye only. Drag a handle to change the record: the red/green/blue triad moves it along world X/Y/Z; the '
  + 'coloured rings steer it. Shift snaps (15° angles, 0.05 positions). Hold the stage focused and press W / E '
  + 'to switch move / rotate, X to toggle global / local.';

const GeometryBody: React.FC<WorkbenchUnitProps> = ({ send }) => {
  const ui = useBlendUi();
  const g = ui.geometry;
  const [ready, setReady] = React.useState(false);
  const [live, setLive] = React.useState(false);
  const [mode, setMode] = React.useState(hostMode);
  const [space, setSpace] = React.useState(hostSpace);
  const boxRef = React.useRef<HTMLDivElement | null>(null);
  const inputs = React.useRef<Record<string, HTMLInputElement | null>>({});
  // 每一格在获得焦点那一刻的值：失焦时只有真变过才立一步历史（原生 change 的语义，
  // 否则"点一下又点走"会凭空多出一条撤销记录）。
  const focusVal = React.useRef<Record<string, string>>({});

  sendAction = send;

  // 脚本只注一次；落地后把画布比例那条口、把手模式/空间补进共享数学。
  React.useEffect(() => {
    let alive = true;
    ensureScripts().then(() => {
      if (!alive) return;
      const gg = G();
      gg.setGeoCanvasAspect?.(() => (aspectW && aspectH ? aspectW / aspectH : 1));
      gg.setGizmoMode?.(hostMode);
      gg.setGizmoSpace?.(hostSpace);
      setReady(true);
    }).catch(() => { /* 404 / 离线：舞台给一句空态，控件仍在 */ });
    return () => { alive = false; };
  }, []);

  // 一块画布 + 一个滚轮监听。canvas 是模块级单例，折叠重挂也是同一块布。
  React.useEffect(() => {
    const box = boxRef.current;
    if (!box || !ready || !g.on) return;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
    }
    box.appendChild(canvas);
    const okFrame = paint();
    const gg = G();
    setLive(okFrame && !!gg.DirView && gg.DirView.live());
    const wheel = (e: WheelEvent) => {
      const w = G();
      if (!w.DirView || !w.DirView.live()) return;
      e.preventDefault();
      e.stopPropagation();
      w.DirView.zoom(e.deltaY > 0 ? 1.1 : 1 / 1.1);
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => {
      canvas?.removeEventListener('wheel', wheel);
      if (canvas && canvas.parentElement === box) box.removeChild(canvas);
    };
  }, [ready, g.on]);

  // 每一条快照：更新舞台活状态 + 把六格数字同步到当前读数（正在打字的那一格除外）。
  React.useEffect(() => {
    applySnapshot(g);
    if (!on || !desc) return;
    for (const f of FIELDS) {
      const el = inputs.current[f.key];
      if (!el || document.activeElement === el || !f.on(kind)) continue;
      const v = fmtVal(f.get(desc), f.fmt);
      if (el.value !== v) el.value = v;
    }
  }, [g]);

  // 指针：拖动中与轨道转动的那几条在 window 上（指针拖出舞台边界也不断），挂载一次。
  React.useEffect(() => {
    const move = (e: MouseEvent) => {
      const gg = G();
      if (orbit) {
        gg.DirView?.orbit(e.clientX - orbit.x, e.clientY - orbit.y);
        orbit = { x: e.clientX, y: e.clientY };
        return;
      }
      if (drag && e.buttons === 0) { endDrag(); return; }
      const d = drag;
      if (!d || !desc || !gg.DirView) return;
      const pt = ptOf(e.clientX, e.clientY);
      d.shiftKey = e.shiftKey;
      const patch = gg.DirView.axisDelta(d.axis, { kind, desc }, pt, d);
      d.pt = pt;
      if (!patch) { paint(); return; }
      d.moved = true;
      applyPatch(patch);
      sendAction('geometry-desc', { patch, live: true });
      paint();
    };
    const up = (e: MouseEvent) => {
      if (e.button === 1 && orbit) {
        orbit = null;
        if (canvas) canvas.style.cursor = hover ? 'grab' : 'default';
        return;
      }
      if (drag) endDrag();
    };
    const blur = () => {
      orbit = null;
      if (canvas && !drag) canvas.style.cursor = hover ? 'grab' : 'default';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  const setGizmo = (m: 'move' | 'rotate') => {
    hostMode = m;
    G().setGizmoMode?.(m);
    setMode(m);
    paint();
  };
  const setSpaceMode = (s: 'global' | 'local') => {
    hostSpace = s;
    G().setGizmoSpace?.(s);
    setSpace(s);
    paint();
  };

  const onDown = (e: React.MouseEvent) => {
    const gg = G();
    if (!gg.DirView || !on || !desc) return;
    // 舞台自己吃指针（别让 dock 把它当拖动），但只有真接下这一下时才 preventDefault —— 否则焦点
    // 落不到这块 div 上，W/E/X 就没处响。
    e.stopPropagation();
    if (e.button === 1) {
      if (!gg.DirView.live()) return;
      e.preventDefault();
      orbit = { x: e.clientX, y: e.clientY };
      if (canvas) canvas.style.cursor = 'move';
      return;
    }
    if (e.button !== 0 || !canvas) return;
    const state: GeoState = { kind, desc };
    const pt = ptOf(e.clientX, e.clientY);
    const axis = gg.dirHitHandle
      ? gg.dirHitHandle(canvas.clientWidth, canvas.clientHeight, state, pt, screenHandles(state))
      : null;
    if (!axis) return;
    e.preventDefault();
    const d: Drag = { axis, pt, moved: false, shiftKey: e.shiftKey };
    d.grab = (axis === 'mvX' || axis === 'mvY' || axis === 'mvZ')
      ? gg.DirView.grabAxis(axis, state, pt)
      : gg.DirView.grabRotate(axis, state, pt);
    if (d.grab) d.grab.axis = axis;
    drag = d;
    hover = axis;
    canvas.style.cursor = 'grabbing';
    paint();
  };
  const onHover = (e: React.MouseEvent) => {
    const gg = G();
    if (drag || orbit || !on || !desc || !canvas || !gg.DirView || !gg.dirHitHandle) return;
    const state: GeoState = { kind, desc };
    const hit = gg.dirHitHandle(canvas.clientWidth, canvas.clientHeight, state,
      ptOf(e.clientX, e.clientY), screenHandles(state));
    if (hit === hover) return;
    hover = hit;
    canvas.style.cursor = hit ? 'grab' : 'default';
    paint();
  };
  const onLeave = () => {
    if (hover === null) return;
    hover = null;
    if (canvas) canvas.style.cursor = 'default';
    paint();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k !== 'w' && k !== 'e' && k !== 'x') return;
    e.preventDefault();
    e.stopPropagation();
    if (k === 'w') setGizmo('move');
    else if (k === 'e') setGizmo('rotate');
    else setSpaceMode(hostSpace === 'global' ? 'local' : 'global');
  };

  if (!g.on) {
    return (
      <div style={wbStyles.note}>
        Select a layer that carries a geometry step — a Direction, a Point, a Ray or a Plane — to fly its world
        here. Add one from the layer&apos;s <span style={{ ...wbStyles.key }}>+</span> chip, or press{' '}
        <span style={{ ...wbStyles.key }}>D</span> to pin a layer&apos;s first geometry step.
      </div>
    );
  }

  const color = desc && /^#[0-9a-fA-F]{6}$/.test(desc.color) ? desc.color : '#ff2e88';
  const cell = (f: FieldSpec) => {
    const en = !!desc && f.on(kind);
    return (
      <label key={f.key} style={{ ...cellStyle, opacity: en ? 1 : 0.4 }}>
        <span style={cellLabel}>{f.label}</span>
        <input
          ref={el => { inputs.current[f.key] = el; }}
          type="number" step={f.step} disabled={!en}
          defaultValue={desc ? fmtVal(f.get(desc), f.fmt) : ''}
          onChange={e => {
            const el = e.currentTarget;
            const n = Number(el.value);
            if (el.value === '' || !Number.isFinite(n) || !desc) return;
            const patch = f.patch(desc, n);
            applyPatch(patch);
            sendAction('geometry-desc', { patch, live: true });
            paint();
          }}
          onFocus={e => { focusVal.current[f.key] = e.currentTarget.value; }}
          onBlur={e => {
            if (focusVal.current[f.key] === e.currentTarget.value) return;
            sendAction('geometry-commit', { label: f.key });
          }}
          style={numInput}
        />
      </label>
    );
  };

  return (
    <div style={{ ...wbStyles.stack, padding: 4, ...wbStyles.armed }}>
      <div ref={boxRef} tabIndex={0} style={stageBox} title={STAGE_TITLE}
        onMouseDown={onDown} onMouseMove={onHover} onMouseLeave={onLeave} onKeyDown={onKey}
        onAuxClick={e => { if (e.button === 1) e.preventDefault(); }}>
        <div style={hintStyle}>
          <b style={hintKey}>W</b> Move{mode === 'move' ? ' \u2714' : ''}{'   '}
          <b style={hintKey}>E</b> Rotate{mode === 'rotate' ? ' \u2714' : ''}{'   '}
          <b style={hintKey}>X</b> {space === 'global' ? 'Global' : 'Local'}
        </div>
        {ready && !live && <div style={stageNote}>3D view unavailable in this browser — the readouts below still
          work.</div>}
      </div>

      <div style={wbStyles.row}>
        <span style={{ ...wbStyles.key, ...wbStyles.keyOn }}>{KIND_NAME[kind] || 'Geometry'}</span>
        <div style={{ ...wbStyles.miniGroup, marginLeft: 'auto' }}>
          <button type="button" style={{ ...wbStyles.btn, ...(mode === 'move' ? wbStyles.btnOn : null) }}
            title="Move handles (W): the red/green/blue triad drags the record along world X/Y/Z"
            onClick={() => setGizmo('move')}>Move</button>
          <button type="button" style={{ ...wbStyles.btn, ...(mode === 'rotate' ? wbStyles.btnOn : null) }}
            title="Rotate handles (E): the coloured rings steer the record's orientation"
            onClick={() => setGizmo('rotate')}>Rotate</button>
          <button type="button" style={wbStyles.btn}
            title="Global (world XYZ) or Local (the record's own axes) — X toggles"
            onClick={() => setSpaceMode(space === 'global' ? 'local' : 'global')}>
            {space === 'global' ? 'Global' : 'Local'}
          </button>
        </div>
      </div>

      <div style={{ ...wbStyles.row, gap: 6, flexWrap: 'nowrap' }}>{FIELDS.slice(0, 3).map(cell)}</div>
      <div style={{ ...wbStyles.row, gap: 6, flexWrap: 'nowrap' }}>{FIELDS.slice(3).map(cell)}</div>

      <div style={wbStyles.ctrl}>
        <label style={wbStyles.ctrlLabel}>Color</label>
        <input style={wbStyles.color} type="color" value={color}
          title="The record's own colour — the ring, arc and handles keep theirs"
          onChange={e => {
            const patch = { color: e.target.value };
            applyPatch(patch);
            sendAction('geometry-desc', { patch, live: true });
            paint();
          }}
          onFocus={e => { focusVal.current.color = e.currentTarget.value; }}
          onBlur={e => {
            if (focusVal.current.color === e.currentTarget.value) return;
            sendAction('geometry-commit', { label: 'color' });
          }} />
        <span style={{ ...wbStyles.value, width: 64 }}>{color.toUpperCase()}</span>
      </div>

      <div style={wbStyles.ctrl}>
        <label style={wbStyles.ctrlLabel}>Reset</label>
        <button type="button" style={wbStyles.btn}
          title="Back to this object's default placement"
          onClick={() => sendAction('geometry-reset')}>Default</button>
      </div>
    </div>
  );
};

export const geometryUnit: WorkbenchUnit = {
  id: 'geometry',
  title: 'Geometry',
  hint: 'Geometry — the world behind the selected layer’s Direction / Point / Ray / Plane step. Fly it in 3D, '
    + 'drag the move / rotate handles, or type the exact values. Middle-drag orbits, scroll zooms — your eye '
    + 'only. The layer’s own pixels are the canvas view of the same object.',
  Body: GeometryBody,
};
