import React, { useState, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import type { PipelineBlock, DetailerBlockParams, PromptBlockParams, QueryBlockParams, TaggerBlockParams, ScaleBlockParams, PromptPreset, Tab, StagingItem, InterfaceInfo, InterfacePort, InterfaceMeta, PipelinePackageInfo, BlockSet, PendingQuery, ActionLogEntry, PipelineSettings, ArchSettings, ArchRule, OverrideKey, ParamOverride, ProcessorDst, ProcessorSrc, BlendDoc, BlendDocs, BlendDocCommand, BlendUiSend } from '../types';
import { PIPELINE_DEFAULT, PIPELINE_CURRENT_SELECT, OVERRIDE_KEYS, firstDetailerFlag } from '../types';
import DebugModal, { DbgIcon } from './DebugModal';
import LogModal from './LogModal';
import { type DockMode, type DockRules, type UnitId, type Dock, docUnit, docUidOf, dockUnits, fitLayout, loadDock, revealDoc, setBlockMode, setToolbarDock, setToolbarDirDock, syncDocUnits } from '../dock/model';
import { fetchLayouts } from '../dock/layoutStore';
import { type DockDrag, type DockOver, DockPanel } from '../dock/DockView';
import { registerProbe, note } from '../debug/probe';
import { onGlobalKey, keyIs } from '../hotkeys';
import { WORKBENCH_PANEL_IDS, WORKBENCH_TITLES, WORKBENCH_HINTS, workbenchBodies, workbenchFoots } from '../workbench/registry';
import { unitIcon } from '../workbench/icons';
import { type VidController, type VidProject, clampFps, createSeekCoalescer, createVidTransport, defaultVidProject, importToTrack, isAudioName, isVideoName, loadVidProject, normalizeVidProject, saveVidProject } from '../workbench/video/model';
import { setVidHistoryJump, setVidHistoryView } from '../workbench/vidHistoryStore';
import { setLayerEditBlocked } from '../workbench/editGate';
import { getBlendUi } from '../workbench/store';
import { ingestFile } from '../workbench/video/ingest';
import { VidTimeline } from '../workbench/video/Timeline';
import { VidAssets } from '../workbench/video/Assets';
import { VidPlayer } from '../workbench/video/Player';

// The rename field of a preset row.
const tabInputStyle: React.CSSProperties = {
  background: 'rgba(10,132,255,0.15)', border: '0.5px solid rgba(10,132,255,0.6)', borderRadius: 999,
  color: '#fff', fontSize: 11.5, fontWeight: 600, padding: '4px 10px', outline: 'none', width: 120,
};

// The Draw tab's dock units each collapse independently. Default is "all open" — a collapsed
// unit is a choice the user made, so it is remembered; a browser that refuses localStorage just gets
// the default every time, which is not worth an error banner over. Both tabs are mounted at once (the
// Draw tab only hides with display:none), so this ONE store is read by the host and shared down.
// The Settings page is NOT in here: it has no foldable sections (a segmented control picks
// which screen shows), and what it does remember rides its own key — see SETTINGS_UI_STORE.
// `pipeline` is one unit that carries BOTH the pipeline enum and the preset list — the dock moves
// whole units around, and those two are one decision ("which chain am I editing"), not two.
// The workbench itself is one UNIT PER OPEN DOCUMENT, named by that document and living or dying with
// it — so `canvas` below is the canvas-resolution block that came out of the page's tool column, not
// the painting surface. `toolbar` is the strip the document actions used to live in — a dock unit
// like any other (it docks, tabs, pops out), only its skin is a row of buttons and it is as tall as
// that row rather than as tall as the space left to it.
type SectionKey = UnitId;
// 宿主自己的五格 + 工作台搬过来的那些格（一块一个文件，由注册表点名）合成这一页的固定集。
const HOST_PANEL_IDS: UnitId[] = ['toolbar', 'context', 'pipeline', 'preprocess', 'blocks'];
// vtracks 是**默认提供**的常驻窗（Image 模式=空态卡，Video 模式=时间线）。播放器不单独占窗：
// Video 模式下 Workbench 窗（id 'canvas'）的正文整个换成播放器 —— 全页只有 Workbench 窗的
// 标题条上有一颗 Image/Video 切换（见 heads）。
const PANEL_IDS: UnitId[] = [...HOST_PANEL_IDS, ...WORKBENCH_PANEL_IDS, 'vtracks', 'vassets'];
const COLUMN_IDS: UnitId[] = ['context', 'pipeline', 'preprocess', 'blocks'];
const UNIT_TITLES: Record<string, string> = {
  toolbar: 'File', context: 'Context', pipeline: 'Pipeline & Presets', preprocess: 'Preprocess',
  blocks: 'Pipeline Blocks', vtracks: 'Tracks', vassets: 'Assets',
  ...WORKBENCH_TITLES,
};
const COLUMN_W = 340;
// 工作台那一列原来就是 280 宽（页面的 `SIDE_W_DEFAULT`），搬过来照抄这颗数。
const RIGHT_W = 280;
const TOP_H = 60;
const DOCK_STORE = 'sampler.drawDock';
// ── Video 模式 ── **同一棵 dock 树**的第二种活法：切过去时只动两处 —— Workbench 那格
// （id 'canvas'）的正文换成播放器，'vtracks'（时间线）缺了就补进树里（插在 canvas 窗下面）。
// **其它每一扇窗原地不动。** vtracks 一旦进树就不再被剪：切回 Image 时它的正文换成空态卡，
// 位置保留，来回切换不重排任何东西。
const VID_MODE_STORE = 'sampler.vidMode';
export type VidMode = 'image' | 'video';
// A canvas window pops out at a working size. A settings card gets the dock's default 300px strip;
// a project the user dragged out of the tab strip wants to be painted on.
const DOC_POP_W = 760, DOC_POP_H = 560;
// How much room a NEW block takes when a unit is dropped into the layout as one. A block that does not
// exist yet has no size, and "take the rest" is not an answer to it: the rest of a column is the WHOLE
// column, which is how appending one small window used to produce a block several times the size of the
// one it was dropped on. Only the page can answer — the frame measures nothing, and a column of cards
// that scrolls has no height of its own — so it answers per unit and per axis, the way popSize already
// answers for a popped-out window: a project is painted on and wants a canvas, a settings panel is a
// column of cards and wants a column's width.
const PANEL_BLOCK_W = 340, PANEL_BLOCK_H = 320, DOC_BLOCK_W = 620, DOC_BLOCK_H = 460;
// What the dock knows about the page, rebuilt whenever the workbench announces a different set of
// documents: the panels — the host's five and every workbench unit lifted out of the page — are fixed,
// and a document unit (`doc:<uid>`) is known BY SHAPE — open right now, or a reserved slot from the
// archive waiting for its project (刷新后播报没到、或这一趟压根没有工程重开：窗口照画，正文先空着).
// A document window is the same
// KIND of thing as a settings unit — it splits sideways, tabs beside another window, pops out over
// them — so it wears the canvas skin (its content owns the box), takes a share of its split instead of
// collapsing to a content height it does not have, and is hidden with display:none rather than
// unmounted, because its body IS the document the user is working on.
const dockRulesFor = (docs: readonly BlendDoc[], vidDirty?: ReadonlySet<number>): DockRules => {
  const owners = new Set(docs.map(d => docUnit(d.uid)));
  const byUnit = new Map(docs.map(d => [docUnit(d.uid), d] as const));
  const isDoc = (id: UnitId) => owners.has(id);
  // 这几条问的是"这个单元是不是一扇文档窗"，不是"这份文档开没开"：刷新后播报前的半秒里 isDoc 还是
  // false，而树里存档的画布窗口已经要按文档窗对待（不折叠、按份额长、满幅）—— 否则播报一到，尺寸
  // 和折叠行为会当场跳一遍。docUidOf 只看形状，正好是这个口径。
  const isDocUnit = (id: UnitId) => docUidOf(id) !== null;
  const rules: DockRules = {
    store: DOCK_STORE,
    panels: PANEL_IDS,
    known: (id: UnitId) => PANEL_IDS.includes(id) || isDocUnit(id),
    // 名字条只列**此刻真有工程认领它**的文档格。关掉最后一份后那格成了保留位 —— 窗留着
    // （用户摆的位置不动），但一条 tab 都不挂，上面什么也不写。
    listed: (id: UnitId) => PANEL_IDS.includes(id) || byUnit.has(id),
    // The trailing dot is the unsaved mark: a window has to say whether what is on screen is what is
    // on disk, and the tab strip shows the same string as the single-unit title bar.
    title: (id: UnitId) => {
      const d = byUnit.get(id);
      if (d) {
        // 未存盘 = 工作台说脏 **或** 这一份文档的 Video 工程被改过。工作台只认得图层，
        // 有人动过 Assets/Tracks 它不会知道 —— 那一半的脏由宿主自己记（见 vidDirty）。
        const vd = !!vidDirty && vidDirty.has(d.uid);
        return d.name + ((d.dirty || vd) ? ' ●' : '');
      }
      // 没人认领的文档格 = 保留位：窗口留着，标题上**什么都不写**。等真的文档进来，这一格
      // 原地改姓。挂 "Untitled" 会让人以为这儿开着一份叫 Untitled 的工程，而写内部 id
      // （doc:1）更像界面坏了 —— 两种都不要。
      if (isDocUnit(id)) return '';
      return UNIT_TITLES[id] ?? id;
    },
    // toolbar 条上一格一颗的记号。页面才知道"这一格是什么"，所以图和标题一样由这里给：
    // 工作台的二十格、宿主的五格、以及一枚文档（doc:*）都在 workbench/icons 那一张表里。
    icon: (id: UnitId) => {
      const Icon = unitIcon(id);
      return <Icon size={15} />;
    },
    keepMounted: isDocUnit,
    // A document window never folds: its fold would be stored under a uid the workbench re-issues from
    // 1 on its next boot, and a collapsed canvas box leaves the live frame with nowhere to be. Its title
    // bar already has a job — it says which project the workbench is running.
    // (Folding only exists inside a container block, so a document there — like anywhere — has no fold.)
    foldable: (id: UnitId) => !isDocUnit(id),
    fullBleed: (id: UnitId) => isDocUnit(id) || id === 'toolbar' || id === 'vtracks' || id === 'vassets',
    // Layers 与 Guidances 是这一列里唯二两格「行会一直长」的面板：它们没有可用来定高的内容，所以放进
    // 容器（Vertical/Horizontal 的 Block）里时按份额分块的余量，而不是把整份列表高度顶出去让块滚到天边。
    // 时间线与资产库同理：两份会一直长的列表。
    grows: (id: UnitId) => isDocUnit(id) || id === 'layers' || id === 'guidances' || id === 'vtracks' || id === 'vassets',
    top: 'toolbar',
    // 顶栏那一块的高度是页面写死的：它是**唯一**一块由内容高度（一排按钮 32px + 自己的标题条）定尺寸的
    // 地方，而布局本身不再看内容。其余每一块都由份额或用户拖出来的像素说话。
    topH: TOP_H,
    column: COLUMN_IDS,
    columnW: COLUMN_W,
    // 画布右边那一列：工作台搬出来的面板按注册表的序叠在这里，Assets / Tracks 是普通成员
    // （默认窗，不靠任何切换逻辑出现）。
    right: [...WORKBENCH_PANEL_IDS, 'vassets', 'vtracks'],
    rightW: RIGHT_W,
    // The size a NEW block opens at — asked per unit and per axis, because which axis the block will be
    // measured on is decided by the side it was dropped on (under a block it is a height, beside one it
    // is a width). It is a preference: the frame caps it so the block it is taken from keeps its floor.
    blockSize: (id: UnitId, axis: 'v' | 'h') => {
      if (id === 'toolbar') return axis === 'v' ? TOP_H : 240;
      if (isDoc(id)) return axis === 'v' ? DOC_BLOCK_H : DOC_BLOCK_W;
      if (id === 'vtracks') return axis === 'v' ? 320 : 900;
      if (id === 'vassets') return axis === 'v' ? 260 : PANEL_BLOCK_W;
      return axis === 'v' ? PANEL_BLOCK_H : PANEL_BLOCK_W;
    },
  };
  return rules;
};
// The document actions, in the order the retired `#fileMenu` listed them. Their tooltips are that
// menu's, carried over word for word — only Load's had to change, because a .cud no longer opens as a
// tab of the workbench but as a window of its own.
const FILE_ACTIONS: { action: BlendDocCommand; label: string; title: string }[] = [
  { action: 'new', label: 'New', title: 'New project — a blank document in its own window' },
  { action: 'load', label: 'Load', title: 'Load a .cud document. It opens as a new project window beside the one you are editing.' },
  { action: 'save', label: 'Save', title: 'Save (Ctrl+S) writes the whole context back to the file it was loaded from. Never loaded? It asks where to put it.' },
  { action: 'save-as', label: 'Save As', title: 'Save As: write the whole context to a file you pick, and the project becomes bound to it' },
  { action: 'export-png', label: 'Export PNG', title: 'Export the composite as a PNG: visible LAYERS flattened at canvas resolution, transparency kept — guidances are references, they stay out of the exported image' },
  { action: 'import', label: 'Import', title: 'Import images and PSD files as new layers. A .cud document belongs to Load.' },
];
const SECTION_KEYS: SectionKey[] = PANEL_IDS;
const SECTIONS_STORE = 'sampler.editSections';
const sectionsAllOpen = (): Record<SectionKey, boolean> =>
  SECTION_KEYS.reduce((a, k) => ({ ...a, [k]: true }), {} as Record<SectionKey, boolean>);
function loadSections(): Record<SectionKey, boolean> {
  const open = sectionsAllOpen();
  try {
    const raw = localStorage.getItem(SECTIONS_STORE);
    const saved = raw ? JSON.parse(raw) : null;
    for (const k of SECTION_KEYS) if (typeof saved?.[k] === 'boolean') open[k] = saved[k];
  } catch { /* unreadable store => all open */ }
  return open;
}

// Right-click actions for one preset row. The full-screen backdrop is what dismisses it (click or a
// second right-click anywhere), which beats wiring window listeners inside an iframe.
const ContextMenu: React.FC<{
  x: number; y: number; up?: boolean; items: { label: string; color?: string; hint?: string; onClick: () => void }[];
  onClose: () => void;
}> = ({ x, y, up, items, onClose }) => (
  <div style={{ position: 'fixed', inset: 0, zIndex: 80 }}
    onClick={onClose}
    onContextMenu={e => { e.preventDefault(); onClose(); }}>
    <div style={{
      position: 'absolute',
      // `up` = 从一颗按钮**往上**翻（正文下面那条动作条上的 Add，Layers 那一格的口径：
      // 菜单贴着按钮上沿展开，不会盖住刚点它的那根手指，也不会被块的 scroller 剪掉）。
      // 传进来的 `y` 是锚点的上沿；往下翻时它就是卡片的上沿。
      ...(up ? { bottom: window.innerHeight - y + 4 } : { top: y }),
      left: Math.min(x, window.innerWidth - 150),
      minWidth: 132, display: 'flex', flexDirection: 'column', gap: 2, padding: 4,
      background: 'rgba(40,40,44,0.96)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: 9,
      boxShadow: '0 8px 28px rgba(0,0,0,0.55)',
    }} onClick={e => e.stopPropagation()}>
      {items.map(it => (
        <button key={it.label} title={it.hint} onClick={() => { it.onClick(); onClose(); }}
          style={{
            display: 'block', width: '100%', textAlign: 'left', padding: '5px 9px',
            background: 'none', border: 'none', borderRadius: 6, cursor: 'pointer',
            color: it.color || 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: 600,
          }}>{it.label}</button>
      ))}
    </div>
  </div>
);

// What the "Add +" dropdown offers. Query is the only kind that interacts with the user
// mid-run: the chain stops there and waits for a prompt choice.
const ADD_BLOCK_KINDS: { kind: 'detailer' | 'interface' | 'prompt' | 'query' | 'tagger' | 'scale'; label: string; color: string; hint: string }[] = [
  { kind: 'detailer', label: 'Detailer', color: '#30d158', hint: 'Refine the masked region' },
  { kind: 'interface', label: 'Interface', color: '#bf5af2', hint: 'Run an interface sub-graph inside the chain' },
  { kind: 'prompt', label: 'Prompt', color: '#64d2ff', hint: 'Inject a shared prompt preset for the blocks after it' },
  { kind: 'query', label: 'Query', color: '#ffd60a', hint: 'Stop the run here and ask you for a prompt' },
  { kind: 'tagger', label: 'Tagger', color: '#ff9f0a', hint: 'Tag the current image and append the tag to the prompt for the blocks after it' },
  { kind: 'scale', label: 'Scale', color: '#5e5ce6', hint: 'Resize the working image by a ratio and snap it to the align grid (limit_pixels semantics)' },
];


// One palette per block kind: the Add menu's row and the card's dot read the same entry, so a kind
// can never be one colour in the menu and another on its card.
const BLOCK_TINT: Record<string, string> = ADD_BLOCK_KINDS.reduce(
  (a, o) => ({ ...a, [o.kind]: o.color }), {} as Record<string, string>);
// What a Query block does — hover the card's type label for it. It used to be a paragraph inside the
// card, which pushed the real parameters down for information you read once.
const QUERY_BLOCK_HINT = '执行到这一块会暂停并弹出 prompt 选择；Confirm 后按 prompt 块的规则合并（全局在前、本次选择在后），只影响其后的 detailer。关掉弹窗 = 中止整条链。';

// Pipeline Blocks 重排的 dragover/dragenter 授权：整张块卡都是落点（见使用处的注释）。
// 载荷走**专属 MIME**（BLOCK_DND_MIME）：真实拖拽里 Chrome 会自动附加内部类型
// （chromium/x-drag-id），"types 只有 text/plain 一种"的判别在真机上永远不成立 —— 合成
// 事件里没有那个内部类型，单测会骗人。专属类型只有块重排写，dock 搬窗口、块套、文件、
// 视频资产都绝不会带它，不需要排除法。
const BLOCK_DND_MIME = 'application/x-block-idx';
const acceptBlockDrop = (e: React.DragEvent) => {
  if (!e.dataTransfer.types.includes(BLOCK_DND_MIME)) return;
  e.preventDefault(); e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
};

// The nine numeric knobs of the Settings tab, in UI order — the same order as OVERRIDE_KEYS
// (frontend) and ARCH_OVERRIDE_KEYS (backend). ONE table serves both surfaces: the Default Setting
// rows and the per-rule rows, so a range can never drift between the two places it is edited.
// ref_* / tgen_* are input-side CEILINGS (shrink only, 0 = off) — the opposite of Pixels, which is
// a target (a small image is enlarged to fill the budget).
type ParamMeta = { label: string; min: number; max: number; step: number; title: string };
const DEFAULT_PARAM_META: Record<OverrideKey, ParamMeta> = {
  mask_grow: { label: 'Mask Grow', min: 0, max: 256, step: 1,
    title: 'Grow the working mask outwards by this many pixels before it is cropped.' },
  mask_blur: { label: 'Mask Blur', min: 0, max: 256, step: 1,
    title: 'Feather the grown mask by this many pixels, so the patch blends into its surroundings.' },
  crop_reserve: { label: 'Crop Reserve', min: 0, max: 256, step: 1,
    title: 'Extra pixels of context kept around the mask crop when the working area is cut out.' },
  pixels: { label: 'Pixels', min: 65536, max: 16777216, step: 65536,
    title: 'Target working resolution — the cropped area is resized to fit this budget, so a small crop is ENLARGED to reach it.' },
  align: { label: 'Align', min: 1, max: 64, step: 1,
    title: 'Pixel grid the working resolution is snapped to (QwenImage2.1 raises it to 32 on its own).' },
  ref_pixels: { label: 'Ref Pixels', min: 0, max: 16777216, step: 65536,
    title: 'Ceiling for a Ref Image before it is VAE-encoded — images already inside the budget are left alone, nothing is ever enlarged. 0 = no ceiling.' },
  ref_align: { label: 'Ref Align', min: 1, max: 64, step: 1,
    title: 'Grid a capped Ref Image is snapped DOWN to (never up).' },
  tgen_pixels: { label: 'TGen Pixels', min: 0, max: 16777216, step: 65536,
    title: 'Ceiling for every image handed to Generate Text (working image + Ref Images) before it enters the vision tower. Shrink-only. 0 = no ceiling.' },
  tgen_align: { label: 'TGen Align', min: 1, max: 64, step: 1,
    title: 'Grid a capped Generate Text image is snapped DOWN to (never up).' },
};

// The "Add +" both section headers share: a pill whose colour tracks the menu it drops, the click-out
// layer that dismisses it, and the panel/rows. Writing it once is what keeps Pipeline Presets and
// Pipeline Blocks identical in look and behaviour instead of two near-copies drifting apart.
const addPillStyle = (open: boolean): React.CSSProperties => ({
  background: open ? 'rgba(10,132,255,0.18)' : 'rgba(255,255,255,0.06)',
  border: '0.5px solid ' + (open ? 'rgba(10,132,255,0.6)' : 'rgba(255,255,255,0.12)'),
  borderRadius: 999, color: open ? '#fff' : 'rgba(255,255,255,0.7)',
  fontSize: 11.5, fontWeight: 600, padding: '3px 10px', cursor: 'pointer', lineHeight: 1,
});
// A menu, not a modal: both Add menus are the shared ContextMenu (see Pipeline Presets).


const TabIcon: React.FC<{ icon: string }> = ({ icon }) => {
  // SF Symbol style SVG icons (iOS style, 24x24, stroke-based)
  const s = 22;
  const sw = 1.7;
  const props = { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: sw, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (icon) {
    case 'mask': return (
      <svg {...props}>
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" opacity="0.15" fill="currentColor" stroke="none" />
        <path d="M8 12h8M12 8v8" />
        <circle cx="12" cy="12" r="3.5" />
      </svg>
    );
    case 'tag': return (
      <svg {...props}>
        <path d="M12.72 2.23l7.05 7.05a2.5 2.5 0 010 3.54l-6.36 6.36a2.5 2.5 0 01-3.54 0l-6.36-6.36a2.5 2.5 0 010-3.54l7.05-7.05a1.5 1.5 0 012.16 0z" />
        <circle cx="9.5" cy="9.5" r="1.2" fill="currentColor" stroke="none" />
      </svg>
    );
    case 'prompt': return (
      <svg {...props}>
        <path d="M4 6h16M4 10h12M4 14h14M4 18h10" strokeWidth={1.5} />
        <path d="M20 16l3 3-3 3" />
      </svg>
    );
    // Workbench tab: the SF "wrench" glyph — a spanner with its open jaw. The tab is called
    // Workbench now; the old photo glyph said "your pictures", this one says "your tools".
    case 'draw': return (
      <svg {...props}>
        <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94L14.7 6.3z" />
      </svg>
    );
    case 'blend': return (
      <svg {...props}>
        <circle cx="9" cy="12" r="5" opacity="0.3" fill="currentColor" stroke="none" />
        <circle cx="15" cy="12" r="5" />
        <path d="M12 7.5v9" opacity="0.4" />
      </svg>
    );
    case 'interface': return (
      <svg {...props}>
        <rect x="4" y="5" width="16" height="3" rx="1.5" />
        <rect x="4" y="11" width="12" height="3" rx="1.5" />
        <rect x="4" y="17" width="8" height="3" rx="1.5" />
      </svg>
    );
    // Settings tab: the same gear glyph the preset rows use for their pipeline binding, drawn at
    // the tab's 22px. One shape, one meaning ("settings of something").
    case 'settings': return (
      <svg {...props}>
        <circle cx="12" cy="12" r="3.2" />
        <path d="M12 2.6v2.5M12 18.9v2.5M21.4 12h-2.5M5.1 12H2.6M18.6 5.4l-1.8 1.8M7.2 16.8l-1.8 1.8M18.6 18.6l-1.8-1.8M7.2 7.2L5.4 5.4" />
      </svg>
    );
    default: return <svg {...props}><circle cx="12" cy="12" r="9" /></svg>;
  }
};

const IOSToggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }> = ({ checked, onChange, disabled }) => (
  <div
    onClick={() => { if (!disabled) onChange(!checked); }}
    style={{
      width: 36, height: 22, borderRadius: 22,
      background: checked ? '#0a84ff' : '#39393d',
      position: 'relative', transition: 'background 0.2s ease', flexShrink: 0,
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
    }}
  >
    <div style={{
      position: 'absolute', top: 2, left: checked ? 16 : 2,
      width: 18, height: 18, borderRadius: '50%', background: '#fff',
      transition: 'left 0.2s ease', boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
    }} />
  </div>
);

const GearIcon: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2.6v2.5M12 18.9v2.5M21.4 12h-2.5M5.1 12H2.6M18.6 5.4l-1.8 1.8M7.2 16.8l-1.8 1.8M18.6 18.6l-1.8-1.8M7.2 7.2L5.4 5.4" />
  </svg>
);

/** 预置套件的 Run 图标：本体三角与工作台图层的 runSvg 同几何（viewBox 0 0 16 16）。
 *  framed = 这条链 Enable Mask 开 —— 跑的是 Mask 层裁出的那块区域，外面这一圈矩形就是
 *  "有裁剪框"；关 = 整幅图就是工作区，裸三角。图例只在 title 里说，不占行宽。 */
const RunIcon: React.FC<{ framed: boolean; size?: number }> = ({ framed, size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" style={{ display: 'block' }}>
    {framed && (
      <rect x="1.2" y="2" width="13.6" height="12" rx="1.8" fill="none"
        stroke="currentColor" strokeWidth="1.4" />
    )}
    <path d={framed ? 'M6.3 5.6 10.6 8 6.3 10.4z' : 'M5.4 3.2 12.8 8 5.4 12.8z'} fill="currentColor" />
  </svg>
);

interface EditPhaseProps {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  promptUrl: string;
  promptReady: boolean;
  detailStatus: 'idle' | 'running' | 'done' | 'error';
  staging: StagingItem[];
  promptIframeRef: React.RefObject<HTMLIFrameElement>;
  blocks: PipelineBlock[];
  /** 当前 pipeline 架构（edit 设置按架构渲染，目前仅 Krea2 提供Enable Edit） */
  architecture: string | null;
  /** Settings tab 的九个数值旋钮 —— 即 DEFAULT SETTING（server config 持久化）。
   *  它们是没被任何架构规则命中时用的那一组值。 */
  maskGrow: number;
  maskBlur: number;
  cropReserve: number;
  pixelsVal: number;
  alignVal: number;
  /** 输入侧显存封顶四件套：ref image / generate text 图的 pixels 上限与落格 */
  refPixelsVal: number;
  refAlignVal: number;
  tgenPixelsVal: number;
  tgenAlignVal: number;
  onBlocksChange: (blocks: PipelineBlock[]) => void;
  onDefaultParamChange: (key: OverrideKey, value: number) => void;
  onAddBlock: (type: 'detailer' | 'interface' | 'prompt' | 'query' | 'tagger' | 'scale') => void;
  /** 一个正等用户回答的 Query 块（run 停在它上面），由 /api/status 下发 */
  pendingQuery: PendingQuery | null;
  /** 立刻以某个 pipeline preset 跑一趟（画布在 Blend 工作台里，由工作台发起） */
  onRunPreset: (presetId: string) => void;
  /** 把用户在弹窗里挑好的 prompt 交给后端，唤醒停在 Query 块上的 run。
   *  返回 Promise 是为了让 Persistent 的写回落地后再刷新 preset 摘要。 */
  onQueryAnswer: (selection: Record<string, any>) => void | Promise<void>;
  /** 关掉 Query 弹窗 = 中止整条链 */
  onQueryCancel: () => void;
  onRemoveBlock: (blockId: string) => void;
  onReorderBlocks: (fromIdx: number, toIdx: number) => void;
  /** 多套 Pipeline Blocks（tabs）；blocks = 激活那一套的镜像 */
  blockSets: BlockSet[];
  activeBlockSetId: string;
  onAddBlockSet: () => void;
  onRenameBlockSet: (id: string, name: string) => void;
  onDuplicateBlockSet: (id: string) => void;
  onRemoveBlockSet: (id: string) => void;
  onReorderBlockSets: (from: number, to: number) => void;
  onSwitchBlockSet: (id: string) => void;
  onFinishClick: () => void;
  showFinishDialog: boolean;
  onFinish: (selectedKeys?: string[]) => void;
  onCloseFinishDialog: () => void;
  blendIframeRef: React.RefObject<HTMLIFrameElement>;
  interfaces: InterfaceInfo[];
  /** Interface tab 的持久化配置（端口改名 / 模式开关 / block 端口绑定），按 interface 名字索引 */
  interfaceMeta: InterfaceMeta;
  onChangeInterfaceMeta: (next: InterfaceMeta) => void;
  /** 所有可选 pipeline —— Draw 页 enum 与 preset ⚙ 的选项来源。绑定按名字（重名取第一条）。 */
  pipelinePackages: PipelinePackageInfo[];
  /** Draw 页 Pipeline Settings 的选中项。`pipelineSettings.overrides` 是旧版按 pipeline 名字存的
   *  那批覆盖 —— 覆盖能力已搬进架构规则，那份数据只随整份文档原样回写，界面不再编辑它。 */
  pipelineSettings: PipelineSettings;
  /** 此刻真正加载在节点上的 pipeline 名字（'' = 节点输入口那条，从未切换过） */
  loadedPipelineName: string;
  /** 选中一条 pipeline 就立刻切换（加载上游是昂贵操作，但切换必须是即时的） */
  onSwitchPipeline: (packageIdx: number, pipelineIdx: number) => void;
  onPipelineSettingsChange: (next: PipelineSettings) => void;
  /** preset 行 ⚙：这套链跑起来时用哪条 pipeline（'' = 不切换，即 [Current Select] 语义） */
  onSetPresetPipeline: (setId: string, pipelineName: string) => void;
  /** Settings tab 的架构规则整份（顺序 = 优先级：自上而下第一条命中本次 pipeline 架构的规则赢） */
  archSettings: ArchSettings;
  onArchSettingsChange: (next: ArchSettings) => void;
  /** 追加一条空规则：id 由宿主现造（与 blocks_sets / blocks 的 id 计数器同一套做法） */
  onAddArchRule: () => void;
  onDuplicateArchRule: (id: string) => void;
  onRemoveArchRule: (id: string) => void;
  onReorderArchRules: (from: number, to: number) => void;
  /** Settings tab 的 user preference：执行到节点时的打开方式。开 = KolidUI 不在就拉起
   *  Kolid Desktop.exe 再注入；关 = 原逻辑（在就注入，不在退浏览器）。 */
  openWithApp: boolean;
  onOpenWithAppChange: (v: boolean) => void;
  /** 最近 32 条行为记录（工作台每次 setStatus + 宿主自身动作）。画布上那颗常显状态药丸撤掉后，
   *  反馈就攒在这里，由 Context 标题行的 Log 按钮按需展开。 */
  actionLog: ActionLogEntry[];
  /** 工作台报上来的打开中的文档：一颗 dock 窗口一个，`activeUid` 那才是工作流真正执行的那块画布。 */
  blendDocs: BlendDocs;
  /** 每个非激活文档最后一次画出来的那一帧（uid → PNG data URL）。切换前由工作台自己拍下来。 */
  docStills: Record<number, string>;
  /** 文档动作的唯一出口：File 栏的六个按钮、点标题条激活、tab 上的 ✕ 关闭，全走这条消息。 */
  onDocCommand: (action: BlendDocCommand, uid?: number) => void;
  /** 工作台面板搬进宿主之后，控件按下的那一下走这条消息回到页面 —— 页面里那张 UI_COMMANDS 表是它唯一的落点。 */
  onBlendUiCommand: BlendUiSend;
  /** 图池的两个后端写口 —— 工作台那条 Staging 底栏拖文件进来 / ✕ 移除时直接调用，不再绕 iframe 消息。 */
  stageUpload: (images: string[], names: string[]) => void;
  stageRemove: (id: string) => void;
}

const EditPhase: React.FC<EditPhaseProps> = ({
  tab, onTabChange, promptUrl,
  promptReady, detailStatus,
  staging, promptIframeRef,
  blocks, architecture, maskGrow, maskBlur, cropReserve, pixelsVal, alignVal,
  refPixelsVal, refAlignVal, tgenPixelsVal, tgenAlignVal,
  onBlocksChange, onDefaultParamChange, onAddBlock, onRemoveBlock, onReorderBlocks,
  blockSets, activeBlockSetId, onAddBlockSet, onRenameBlockSet, onDuplicateBlockSet, onRemoveBlockSet, onReorderBlockSets, onSwitchBlockSet,
  pendingQuery, onRunPreset, onQueryAnswer, onQueryCancel,
  onFinishClick, showFinishDialog, onFinish, onCloseFinishDialog,
  blendIframeRef,
  interfaces, interfaceMeta, onChangeInterfaceMeta,
  pipelinePackages, pipelineSettings, loadedPipelineName, onSwitchPipeline, onPipelineSettingsChange, onSetPresetPipeline,
  archSettings, onArchSettingsChange, onAddArchRule, onDuplicateArchRule, onRemoveArchRule, onReorderArchRules,
  openWithApp, onOpenWithAppChange,
  actionLog, blendDocs, docStills, onDocCommand, onBlendUiCommand,
  stageUpload, stageRemove,
}) => {
  const [hoveredFinish, setHoveredFinish] = useState<StagingItem | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // Debug 弹窗：上一次 Run / Generate 的全过程快照（Context 标题右侧的 🐞 按钮打开）。
  const [showDebug, setShowDebug] = useState(false);
  // Log 弹窗：最近 32 条行为记录 —— 画布那颗常显状态药丸撤掉后的去处。
  const [showLog, setShowLog] = useState(false);
  // Live thumbnail of the workbench composite — that composite *is* the Context Image.
  const [blendPreview, setBlendPreview] = useState<{ image: string; size: string } | null>(null);
  // Guidances 那张总卡的本客户端副本（与 blendPreview 同一条消息通道来）。图池里的
  // staging_guidance 是**全局一格**：别的实例（另开的浏览器标签页、第二只壳）一写就会顶掉它，
  // 而 iframe 端只在「自己算出来的图变了」时才重发 —— 所以池里那条只当 run 的取图用，
  // STAGING 的显示只认这一份本地副本。
  const [guidanceCard, setGuidanceCard] = useState<string | null>(null);
  // Mask tint of that thumbnail, 0..1. Its own slider: the workbench's Mask layer has a separate
  // one that only tints the canvas. The tinting itself happens in the iframe, so we forward it.
  const [previewTint, setPreviewTint] = useState(0.3);
  // Inline rename of a Pipeline Blocks tab (set): which set is being renamed and the draft text.
  const [renamingSetId, setRenamingSetId] = useState<string | null>(null);
  const [renamingValue, setRenamingValue] = useState('');
  // Prompt preset editor: which prompt block's PRESET is being edited in the prompt_node
  // iframe (full prompt UI, saved to the shared preset — persisted, referenced by id).
  const [editingPromptBlockId, setEditingPromptBlockId] = useState<string | null>(null);
  // Shared prompt presets (backend prompt_presets.json). Blocks reference them by id;
  // editing a preset affects every block that references it.
  const [promptPresets, setPromptPresets] = useState<PromptPreset[]>([]);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  // Inline rename of a preset (replaces the card's select while active).
  const [renamingPresetId, setRenamingPresetId] = useState<string | null>(null);
  // The Pipeline Blocks "Add +" dropdown (the four block kinds it can append).
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  // The Pipeline Presets "Add +" dropdown — same control, same behaviour as the Blocks one.
  const [presetAddMenu, setPresetAddMenu] = useState<{ x: number; y: number } | null>(null);
  // 面板的折叠状态（默认全展开，改动落 localStorage）。折叠只在**容器 Block**（Vertical/Horizontal）里
  // 的窗口上存在：那里一个单元一个窗口，折起一个就是把它占的高度还给同块的其他窗口。Default 模式的块里
  // 没有折叠 —— 一个窗口撑满整块，没有可折的余地。所以这里收的是一颗 id。
  const [openSections, setOpenSections] = useState<Record<SectionKey, boolean>>(loadSections);
  const setFold = (id: UnitId, open: boolean) => setOpenSections(prev => {
    const next = { ...prev, [id]: open };
    try { localStorage.setItem(SECTIONS_STORE, JSON.stringify(next)); } catch { /* in-memory only */ }
    return next;
  });
  // Where each unit sits — stacked, side by side, tabbed together, or popped out over the workbench —
  // is the user's layout call and lives in its own key; which are collapsed is a separate one.
  // ── Video 模式 ── 页面级的第二形态，刷新后留在上次的模式里（localStorage 一位）。
  // 只改两处：canvas 格正文换播放器（见 bodies）、'vtracks' 缺了补进树 —— 树与存档都是同一份。
  const vidMode0: VidMode = (() => {
    try { return localStorage.getItem(VID_MODE_STORE) === 'video' ? 'video' : 'image'; } catch { return 'image'; }
  })();
  const [vidMode, setVidModeState] = useState<VidMode>(vidMode0);
  const vidModeRef = useRef(vidMode);
  vidModeRef.current = vidMode;
  // Video 工程的"脏"记在宿主：工程随 .cud 走，而工作台的 dirty 只看图层，
  // 光动 Assets/Tracks 它不会亮 —— 所以这一份要宿主自己记，存盘后清掉。
  const vidDirty = useRef(new Set<number>());
  const [vidDirtyTick, bumpVidDirty] = useReducer((x: number) => x + 1, 0);
  const dockRules = useMemo(
    () => dockRulesFor(blendDocs.docs, vidDirty.current), [blendDocs, vidDirtyTick],
  );
  const [dock, setDockState] = useState<Dock>(() => loadDock(dockRulesFor([])));
  // 「此刻的布局」的 ref：开机那一次写档要用它（见下面 `?nolayout` 那一支），而它不该成为那个
  // effect 的依赖 —— 那会让它每次动一下布局就跑一遍。
  const dockRef = useRef(dock);
  dockRef.current = dock;
  const applyDock = useCallback((next: Dock, persist = true) => {
    setDockState(next);
    if (persist) { try { localStorage.setItem(DOCK_STORE, JSON.stringify(next)); } catch { /* in-memory only */ } }
  }, []);
  // 模式切换不动树：vtracks 本来就是默认提供的窗（起手树 / fitLayout 补缺都保证它在）。
  // 切换只换两格的正文 —— canvas ↔ 播放器、vtracks ↔ 时间线/空态卡 —— 其它每一扇窗原地不动。
  const setVidMode = useCallback((m: VidMode) => {
    if (m === vidModeRef.current) return;
    try { localStorage.setItem(VID_MODE_STORE, m); } catch { /* in-memory only */ }
    vidModeRef.current = m;
    setVidModeState(m);
  }, []);
  // ── Video 工程状态 ── 权威在宿主：Player / Tracks 两扇窗都从这里拿快照（VidController），
  // 改动防抖落盘 localStorage（blob: 的本地图活不过刷新，读档时自会剪掉）。
  // 播放头不住这里：它每帧都在走，走 React state 会把整页拖着每秒重渲几十次（scrub 卡顿的根子）。
  // 它住外置 transport —— Player/Timeline 订阅它直改 DOM，React 只管低频的事。
  // **按文档分桶**：Video 工程随 .cud 走（保存时 iframe 来要快照、读档时送回来），桶键 = 文档
  // uid；写入落进活跃文档的桶，切文档 = 换一份工程。
  const [vidProject, setVidProject] = useState<VidProject>(loadVidProject);
  const vidProjectRef = useRef(vidProject); vidProjectRef.current = vidProject;
  const [vidTransport] = useState(createVidTransport);
  // seek 走合流器：标尺拖动每发指针事件都进这里，合到 rAF 一帧一落（见 createSeekCoalescer）。
  // interactive 也在这一并带上 —— 上一版在这里丢了标记，拖标尺完全不走缩略条路径。
  const [vidSeek] = useState(() => createSeekCoalescer(vidTransport));
  const [vidPlaying, setVidPlaying] = useState(false);
  const [vidPps, setVidPps] = useState(60);
  /** 视频模式下选中的 Layer 段 key（'' = 没选中，图层集是文档主图层）。 */
  const [vidLayerKey, setVidLayerKey] = useState('');
  const vidByDoc = useRef(new Map<number, VidProject>());
  const activeUid = blendDocs.activeUid;
  const activeUidRef = useRef(activeUid); activeUidRef.current = activeUid;

  // ── Video 的撤销摞 ── 工程住在宿主，工作台那两支摞（undoStack/redoStack）只认识图层，
  //  所以视频这一半得宿主自己记：Ctrl+Z 才撤得动片段、轨道、范围。
  //   * 每个文档一支（与 vidByDoc 同键、同生同死）。
  //   * 存的是**修改前**的快照：撤销 = 弹一份回去，把当前这份压进 redo（与页面同一读法）。
  //   * 拖动（trim / move / 范围）每帧都会 update 一次 —— 靠 label + 650ms 窗并成一步，
  //     一次拖动 = 一步撤销（否则撤一次只退一帧，等于没撤）。
  type VidHistRec = { p: VidProject; label: string; at: number };
  const vidHist = useRef(new Map<number, { undo: VidHistRec[]; redo: VidHistRec[] }>());
  const [vidHistTick, bumpVidHist] = useReducer((x: number) => x + 1, 0);
  // 谁更近：视频这一步 vs 图层那一笔。Ctrl+Z 只撤"最近动过的那个" —— 两边各撤各的，
  // 不会出现"刚刷了一笔图层，一按 Ctrl+Z 却先把视频片段撤了"。
  // 图层那边由页面在每次 pushHistory / undo / redo 时发一条 blend-edited 报时（见下面的监听）。
  const vidEditAt = useRef(0);
  const layerEditAt = useRef(0);
  const VID_HIST_MAX = 80;
  const VID_COALESCE_MS = 650;
  const histOf = useCallback((uid: number) => {
    const m = vidHist.current;
    let h = m.get(uid);
    if (!h) { h = { undo: [], redo: [] }; m.set(uid, h); }
    return h;
  }, []);
  const pushVidHist = useCallback((uid: number, prev: VidProject, label: string) => {
    const h = histOf(uid);
    const now = Date.now();
    const top = h.undo[h.undo.length - 1];
    if (top && top.label === label && now - top.at < VID_COALESCE_MS) {
      top.at = now;              // 同一次拖动的后续帧：并进栈顶那一步（prev 保留最早那份）
    } else {
      h.undo.push({ p: prev, label, at: now });
      while (h.undo.length > VID_HIST_MAX) h.undo.shift();
    }
    h.redo.length = 0;           // 新动作作废"重做"那一支
    vidEditAt.current = now;
    bumpVidHist();
  }, [histOf]);
  // 把一份工程装回活跃文档。撤销/重做**也是一种修改**：脏标记要亮 —— 否则撤完直接关 tab，
  // 会以为"和盘上一致"而丢掉这次撤销。
  const applyVidState = useCallback((uid: number, proj: VidProject) => {
    vidByDoc.current.set(uid, proj);
    vidProjectRef.current = proj;
    if (uid === activeUidRef.current) setVidProject(proj);
    if (!vidDirty.current.has(uid)) { vidDirty.current.add(uid); bumpVidDirty(); }
    vidEditAt.current = Date.now();
    bumpVidHist();
  }, []);
  const vidUndo = useCallback((): boolean => {
    const uid = activeUidRef.current;
    if (uid == null) return false;
    const h = histOf(uid);
    if (!h.undo.length) return false;
    const rec = h.undo.pop()!;
    h.redo.push({ p: vidProjectRef.current, label: rec.label, at: Date.now() });
    applyVidState(uid, rec.p);
    return true;
  }, [histOf, applyVidState]);
  const vidRedo = useCallback((): boolean => {
    const uid = activeUidRef.current;
    if (uid == null) return false;
    const h = histOf(uid);
    if (!h.redo.length) return false;
    const rec = h.redo.pop()!;
    h.undo.push({ p: vidProjectRef.current, label: rec.label, at: Date.now() });
    applyVidState(uid, rec.p);
    return true;
  }, [histOf, applyVidState]);
  // 跳到视频段第 k 行 = 回到"第 k 步之前"那一份；中间那些压进 redo（与页面 jumpHistory 同一读法）。
  const vidJump = useCallback((k: number) => {
    const uid = activeUidRef.current;
    if (uid == null) return;
    const h = histOf(uid);
    if (!Number.isFinite(k) || k < 0 || k >= h.undo.length) return;
    let cur = vidProjectRef.current;
    while (h.undo.length > k) {
      const rec = h.undo.pop()!;
      h.redo.push({ p: cur, label: rec.label, at: Date.now() });
      cur = rec.p;
    }
    applyVidState(uid, cur);
  }, [histOf, applyVidState]);
  // 按键/按钮该由视频这边接手吗：栈里有步，且最近一次动的是视频。
  const vidOwnsUndo = useCallback((isRedo: boolean): boolean => {
    const uid = activeUidRef.current;
    if (uid == null) return false;
    const h = vidHist.current.get(uid);
    if (!h) return false;
    if (!(isRedo ? h.redo.length : h.undo.length)) return false;
    return vidEditAt.current > layerEditAt.current;
  }, []);
  // 改工程。**不用 setState 的 updater 来算**：历史入栈是副作用，塞进 updater 里会被
  // 严格模式/并发渲染重放（多出一步空历史）。这里用 ref 当"当前值"，同一事件里连续调两次
  // 也能链得上（每次立刻把 ref 换掉），渲染仍然只由 setVidProject 驱动。
  const vidUpdate = useCallback((fn: (p: VidProject) => VidProject, label?: string) => {
    const uid = activeUidRef.current;
    const prev = vidProjectRef.current;
    const next = fn(prev);
    if (next === prev) return;                 // 没变：不进历史、不置脏
    vidProjectRef.current = next;
    setVidProject(next);
    if (uid != null) {
      vidByDoc.current.set(uid, next);
      pushVidHist(uid, prev, label || 'Video edit');
      if (!vidDirty.current.has(uid)) {
        vidDirty.current.add(uid);
        bumpVidDirty();                        // tab / 标题条上的 ● 要跟着亮
      }
    }
  }, [pushVidHist]);
  // 文档切换 = 换一份 Video 工程：第一次见到的文档，头一份继承页面存档，之后的从空白起手。
  useEffect(() => {
    const uid = blendDocs.activeUid;
    if (uid == null) return;
    const map = vidByDoc.current;
    if (!map.has(uid)) map.set(uid, map.size === 0 ? vidProjectRef.current : defaultVidProject());
    setVidProject(map.get(uid)!);
  }, [blendDocs.activeUid]);
  // 文档关掉了 → 它那一桶（工程 + 脏标记）跟着走。uid 是工作台**每次开机从 1 重新发**的，
  // 留着旧的会在下一次复用同一个 uid 时串台（新文档凭空多出上一位的片段）。
  useEffect(() => {
    const live = new Set(blendDocs.docs.map(d => d.uid));
    for (const uid of [...vidByDoc.current.keys()]) {
      if (!live.has(uid)) {
        vidByDoc.current.delete(uid);
        vidDirty.current.delete(uid);
        vidHist.current.delete(uid);       // uid 会被复用：旧步留着就会串到下一份文档上
      }
    }
    bumpVidHist();
  }, [blendDocs.docs]);
  // iframe 的两条 Video 消息：保存时按 uid 来要快照；读档/重开时把文件里那份送回桶里。
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; uid?: number; project?: unknown; files?: unknown; at?: number } | null;
      if (!d || typeof d.type !== 'string') return;
      if (d.type === 'blend-edited') {
        // 页面刚提交了一步图层动作（或刚撤销/重做了一步）：Ctrl+Z 从此归它，直到视频又被改动。
        layerEditAt.current = Number(d.at) || Date.now();
        return;
      }
      if (d.type === 'blend-request-vid') {
        const uid = Math.round(Number(d.uid) || 0);
        const project = vidByDoc.current.get(uid)
          ?? (uid === (activeUidRef.current ?? -1) ? vidProjectRef.current : null);
        (e.source as Window | null)?.postMessage({ type: 'blend-vid', uid, project }, '*');
      } else if (d.type === 'blend-vid-restore') {
        const uid = Math.round(Number(d.uid) || 0);
        const proj = normalizeVidProject(d.project);
        vidByDoc.current.set(uid, proj);
        vidDirty.current.delete(uid);      // 刚从文件里读出来的 = 与盘上一致
        // 从文件里读出来的这份是**新基线**：之前那支撤销摞属于另一份内容，留着就能
        // "撤销到上一个工程"，那是没有人想要的结果。
        vidHist.current.delete(uid);
        vidEditAt.current = 0;
        bumpVidHist();
        if (uid === activeUidRef.current) setVidProject(proj);
      } else if (d.type === 'blend-saved') {
        // 工作台把 .cud 落盘了 —— Video 工程就在这份文件里，这一桶可以清脏了。
        const uid = Math.round(Number(d.uid) || 0);
        if (vidDirty.current.delete(uid)) bumpVidDirty();
      } else if (d.type === 'blend-vid-file') {
        // 拖视频/音频进工作台、或 Load 里选了媒体文件：入库 + 落片段 + **自动切 Video 模式**
        //（已在 Video 就不动）。图片同理切回 Image 模式 —— setVidMode 对同值早退，无谓的重渲
        // 不发生。File 走 structured clone 直达宿主，入库复用 ingestFile（后端 ffmpeg 落持久
        // URL，与时间线拖放完全同一条路）。
        const files: File[] = Array.isArray(d.files)
          ? (d.files as unknown[]).filter((f): f is File => f instanceof File)
          : [];
        if (!files.length) return;
        const isMedia = (f: File) => /^video\//.test(f.type) || /^audio\//.test(f.type)
          || isVideoName(f.name) || isAudioName(f.name);
        const media = files.filter(isMedia);
        if (files.some(f => !isMedia(f))) setVidMode('image');
        if (!media.length) return;
        setVidMode('video');
        void (async () => {
          for (const f of media) {
            const ing = await ingestFile(f);
            if (!ing) continue;       // 后端没 ffmpeg 且本地也解不动：放弃这一件
            // 落在播放头处、轨自动挑（placeImport：null trackId = 第一条视频轨，纯音频自动进音频轨）
            vidUpdate(proj => importToTrack(proj,
              { src: ing.src, name: ing.name, origin: 'file' },
              { duration: ing.duration, hasAudio: ing.hasAudio, audioOnly: ing.audioOnly },
              null, vidTransport.get()), 'Add clip');
          }
        })();
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);
  // History 那一格读的是**只读投影**：图层步（页面播报的）在前、视频步接在后面。
  // 视频的工程快照留在上面的摞里，这里只交名字 —— 面板不该为了显示一行字拿一份几十兆的工程。
  useEffect(() => {
    const h = activeUid != null ? vidHist.current.get(activeUid) : undefined;
    setVidHistoryView({
      steps: (h ? h.undo : []).map(r => ({ label: r.label })),
      canUndo: !!h && h.undo.length > 0,
      canRedo: !!h && h.redo.length > 0,
    });
  }, [activeUid, vidHistTick]);
  useEffect(() => {
    setVidHistoryJump(k => vidJump(k));
    return () => setVidHistoryJump(null);
  }, [vidJump]);
  // ── Ctrl+Z / Ctrl+Y：视频与图层**各撤各的** ──
  // 页面在 iframe 的 window 上（bubble）处理同一组键；这里是 document 的 capture（见 hotkeys.ts），
  // 先跑一步。只有"最近动的是视频、且视频栈里确实有步"时才拦下来，其余原样放行给工作台 ——
  // 所以刚刷了一笔图层时按 Ctrl+Z，撤的是那一笔，而不是前面改过的片段。
  useEffect(() => onGlobalKey(e => {
    const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
    if (!ctrl) return;
    const k = e.key.toLowerCase();
    if (k !== 'z' && k !== 'y') return;
    const t = e.target as HTMLElement | null;
    const tag = (t && t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)) return;
    const isRedo = k === 'y' || e.shiftKey;
    if (!vidOwnsUndo(isRedo)) return;
    e.preventDefault(); e.stopPropagation();
    if (isRedo) vidRedo(); else vidUndo();
  }), [vidOwnsUndo, vidUndo, vidRedo]);
  // 工作台那几格的 send 先过宿主这一道 —— History 格的 Undo / Redo / 点某一行，
  // 要能落到视频那一半（页面的下标空间里没有它）。
  const uiSend: BlendUiSend = useCallback((action, value) => {
    if (action === 'history-undo') {
      if (vidOwnsUndo(false)) { vidUndo(); return; }
    } else if (action === 'history-redo') {
      if (vidOwnsUndo(true)) { vidRedo(); return; }
    } else if (action === 'history-jump') {
      const base = getBlendUi().history.steps.length;
      const n = Number(value);
      if (Number.isFinite(n) && n >= base) { vidJump(n - base); return; }
    }
    onBlendUiCommand(action, value);
  }, [onBlendUiCommand, vidOwnsUndo, vidUndo, vidRedo, vidJump]);
  // 视频模式下没选中 Layer 段 → Layers / Guidances 不知道该往哪写，动作条整排变灰。
  // 切回 Image 模式时把图层集还给文档主图层（否则画布还停在某个段的那一套上）。
  useEffect(() => {
    setLayerEditBlocked(vidMode === 'video' && !vidLayerKey);
    if (vidMode !== 'video' && vidLayerKey) {
      setVidLayerKey('');
      onBlendUiCommand('layer-set', { key: '' });
    }
  }, [vidMode, vidLayerKey, onBlendUiCommand]);
  const vidCtl: VidController = useMemo(() => ({
    project: vidProject, transport: vidTransport, playing: vidPlaying, pps: vidPps,
    staging, update: vidUpdate, seek: vidSeek, setPlaying: setVidPlaying, setPps: setVidPps,
    // 选中 Layer 段 = 把 Layers 窗切成这一段自己那一套（主文档是 ''）。页面侧整组换入换出，
    // 所以这里只要把 key 递过去 —— 图层的增删改仍然全走页面那套命令。
    focusClip: clip => {
      const key = clip && clip.kind === 'layer' ? (clip.layerKey || clip.id) : '';
      setVidLayerKey(key);
      onBlendUiCommand('layer-set', { key });
    },
  }), [vidProject, vidTransport, vidPlaying, vidPps, staging, vidUpdate, vidSeek, onBlendUiCommand]);
  // 页面存档照旧跟活跃文档的那份走（刷新后的起手工程；.cud 才是随文档走的正身）。
  useEffect(() => {
    const t = setTimeout(() => saveVidProject(vidProject), 400);
    return () => clearTimeout(t);
  }, [vidProject]);
  // 切回 Image 模式就停播（Player 对 visible 也停了一遍，这里兜底 —— 两扇窗那时已不在树里）。
  useEffect(() => {
    if (vidMode !== 'video') setVidPlaying(false);
  }, [vidMode]);
  // 模式切换的分段控件：**只钉在工程画布大窗（文档窗）标题条右上**、toolbar 化按钮的左边 ——
  // 那扇窗就是 Video 模式的播放器宿主。其它任何窗上都不出现。
  const vidModeSeg = (
    <div style={styles.modeSeg} role="tablist" title="Workbench mode">
      {(['image', 'video'] as VidMode[]).map(m => (
        <button key={m} style={{ ...styles.modeSegBtn, ...(vidMode === m ? styles.modeSegOn : null) }}
          title={m === 'image' ? 'Image — the canvas workbench' : 'Video — player & timeline'}
          onClick={e => { e.stopPropagation(); setVidMode(m); }}>{m === 'image' ? 'Image' : 'Video'}</button>
      ))}
    </div>
  );
  // The dock holds a window for every document the workbench has open and nothing more: a closed one
  // loses its node, a newly loaded one gets a window, one the user already placed keeps its place.
  // The workbench is the only thing that knows which projects exist, so this is where that knowledge
  // enters the layout — the dock model itself never learns what a .cud is.
  const openDocUnits = useMemo(() => blendDocs.docs.map(d => docUnit(d.uid)), [blendDocs]);
  // 工作台那几格能碰到的宿主事实：图池镜像、画布合成预览、图池的两个后端写口。正文与动作条共用同一份。
  // `layout` 是 Layout 那一格要的两样 —— 现在的布局（存下去的就是它）和写口（载入就是把它交回来）、
  // 外加校验口径 `rules` 与此刻开着的文档（载入的布局要按它收一遍）。
  // 输出帧率的写口：住在 Video 工程里，所以走 vidUpdate —— 一次改动 = 一步撤销、置脏、随 .cud 走。
  const setVidFps = useCallback((v: number) => {
    vidUpdate(proj => (proj.fps === clampFps(v) ? proj : { ...proj, fps: clampFps(v) }), 'Set frame rate');
  }, [vidUpdate]);
  const wbHost = useMemo(() => ({
    staging, blendPreview, guidanceCard, stageUpload, stageRemove,
    layout: { dock, rules: dockRules, openDocs: openDocUnits, apply: applyDock },
    video: { mode: vidMode, fps: vidProject.fps, setFps: setVidFps },
  }), [staging, blendPreview, guidanceCard, stageUpload, stageRemove, dock, dockRules, openDocUnits, applyDock,
    vidMode, vidProject.fps, setVidFps]);
  // 工作台 iframe 启动时先播一份空的 `docs: []`（它还没恢复上一次的工程），紧接着才播真正恢复出来
  // 的那份。头一份空播报不是"文档都被关了"，把它当真就等于每次刷新都把存档里的画布位置剪掉。
  // 所以：**空列表在启动期是歧义的**，要等它至少说过一次"我有文档"，此后再说空才算关闭。
  const settledDocs = useRef(false);
  // 上一轮播报的文档集：这一轮多出来的就是"新开的工程"（Load / New / 重开）—— 它们要当场露脸。
  const prevDocs = useRef<readonly UnitId[]>([]);
  useEffect(() => {
    // 播报前（它自己也刚加载），开文档集是"未知"而不是"空"。此刻按空集会先把存档里画布窗口的位置
    // 剪掉，等播报到来只能按新文档安放 —— 画布每次刷新都跳回默认位置，而其它面板本来就留得住（加载
    // 时就认得它们）。所以头一份带文档的播报到达前不动树；之后对得上号的文档窗口原地留用，
    // 对不上的才剪、新来的才放。
    if (!blendDocs.announced) return;
    const sawDoc = openDocUnits.length > 0;
    if (!sawDoc && !settledDocs.current) return;
    settledDocs.current = true;
    const prev = prevDocs.current;
    prevDocs.current = openDocUnits;
    // 新到的文档：选中项拨过去（revealDoc），并让工作台把它当活跃工程画 —— 不然 Load 完一份
    // .cud，屏幕上还停在上一份（tab 条不动、画布也不换人）。
    const fresh = openDocUnits.filter(u => !prev.includes(u));
    // **关掉最后一份工程时留保留位**（keepSlots）：树里的 doc 格还活着（标题回落 Untitled），
    // 那扇 Workbench 窗连同用户摆的位置一起保住 —— 不然删掉唯一的 cud tab，整扇窗当场蒸发。
    // 之后 New / Load 的新工程由 syncDocUnits 的配对（renameUnit）原地认领这个空位，布局不动。
    // 还有别的文档开着时照旧剪：关掉其中一份，它自己的窗该走就走。
    let next = syncDocUnits(dock, openDocUnits, openDocUnits.length === 0);
    if (fresh.length) {
      next = fresh.reduce(revealDoc, next);
      for (const u of fresh) {
        const uid = docUidOf(u);
        if (uid !== null) onDocCommand('activate', Number(uid));
      }
    }
    if (next !== dock) applyDock(next);
  }, [dock, openDocUnits, applyDock, blendDocs.announced]);
  // 默认布局：Layout 那一格标了 ★ 的那一份，是页面**每次打开**的起手式。它住在盘上（`/api/layouts`），
  // 不在浏览器里 —— 宿主端口是 8700..8799 里试出来的，换个端口就是换个 origin，localStorage 里那份
  // 当场看不见（这正是"我存的布局下次打开就没了"的由来）。
  //
  // 时机：等文档播报到位再摆。布局里的画布格要按"现在开着的文档"收一遍，摆早了就会把画布剪掉，
  // 等播报来了只能按新文档安放 —— 那还不如不摆。工作台一直不播报（iframe 起不来）就 4 秒后照样摆。
  const bootLayoutDone = useRef(false);
  const bootRef = useRef({ rules: dockRules, docs: openDocUnits });
  bootRef.current = { rules: dockRules, docs: openDocUnits };
  useEffect(() => {
    if (bootLayoutDone.current) return;
    const run = () => {
      if (bootLayoutDone.current) return;
      bootLayoutDone.current = true;
      // `?nolayout=1`：这一次打开**不**按默认布局摆。默认布局是用户私人的起手式（他标了 ★ 的那一份），
      // 而探针要的是一个已知的、可复现的起点（`defaultDock`）—— 否则用户随手存一份默认，整套界面
      // 探针都会跟着变形状，测的就不再是代码而是他的页面。
      //
      // 顺手把这一份写进 `sampler.drawDock`：平时这一笔是 boot 那次 `applyDock` 顺手留下的，跳过
      // 它之后探针（和其它读档的一侧）读到的就是 null —— "页面此刻的布局"应当一直有答案。
      if (new URLSearchParams(location.search).has('nolayout')) {
        try { localStorage.setItem(DOCK_STORE, JSON.stringify(dockRef.current)); } catch { /* in-memory only */ }
        return;
      }
      fetchLayouts().then(store => {
        if (!store || !store.default) return;
        const item = store.items.find(i => i.name === store.default);
        if (!item) return;
        const fit = fitLayout(bootRef.current.rules, item.dock);
        if (!fit) return;
        // 第三个参数是 `keepSlots`：**现在还没有工程打开**（页面不自带 Untitled，工作台也没有自动
        // 恢复什么），这份布局里的画布格此刻无人认领 —— 而"无人认领"不等于"关掉了"。按空表剪一遍，
        // 画布格连同它所在的那条横排一起塌掉，用户真开工程时它只能落到工作区末尾：表现就是
        // "关掉 ComfyUI 再打开，画布那扇窗莫名其妙跑到别处去了"。先留着，等播报说有文档了再对账。
        applyDock(syncDocUnits(fit.dock, bootRef.current.docs, true));
        note('boot-layout', { name: item.name, dropped: fit.dropped.length, added: fit.added.length });
      }).catch(() => { /* 没有后端：就用存档里记着的那份摆法 */ });
    };
    if (blendDocs.announced) { run(); return; }
    const t = setTimeout(run, 4000);
    return () => clearTimeout(t);
  }, [blendDocs.announced, applyDock]);
  // dataTransfer payloads are not readable during dragover, so the unit being dragged and the box
  // being hovered are mirrored in state — that is what the landing bands and the iframe shield key off.
  const [dockDrag, setDockDrag] = useState<DockDrag | null>(null);
  const [dockOver, setDockOver] = useState<DockOver | null>(null);
  // 现在开着的那一格 toolbar 小窗（整页同时只有一个，由条子自己上报）。它只影响两件事：
  // 别的条子据此收起自己那一扇，以及活的工作台那一层要不要提到浮层之上。
  const [tbPopover, setTbPopover] = useState<UnitId | null>(null);
  // ── BLOCK 编辑模式 ── Alt+P 是**切换**，不是按住：按一下开、再按一下（或 Esc）关。
  // 模式控件平时完全不在页面上（一块怎么排是装修，不是日常操作，Alt+P 就是那道暗门），
  // 而暗门一旦打开就得站得住：装修一趟要连着点几个模式按钮、拖几条分界线，按住一个键是做不完的。
  // 它唯一的写口是 setMode。
  //
  // 按键必须走 onGlobalKey 而不是 window.addEventListener：鼠标一进画布，焦点就被工作台 iframe 拿走
  // （frame layer 主动 focus 它），键盘事件全在 iframe 的 document 里发生，宿主这边连 keydown 都收不到
  // —— 这正是"鼠标在画布上时 Alt+P 没反应"。见 hotkeys.ts。
  const [blockEdit, setBlockEdit] = useState(false);
  useEffect(() => onGlobalKey(e => {
    // 按住不放会连发 keydown，切换制下那就是一路翻转。只认每次按下后的第一发。
    if (e.repeat) return;
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && keyIs(e, 'p')) {
      e.preventDefault(); e.stopPropagation();
      setBlockEdit(v => !v);
      return;
    }
    // Esc 只负责关闭，不拦事件：弹窗、改名输入框、画布自己的 Esc 都还要用它。
    if (e.key === 'Escape') setBlockEdit(false);
    // ── Ctrl+S：存 .cud（视频工程随 header 一起进去）──
    // Video 模式下焦点通常在宿主这一侧（时间线/播放器在宿主渲染），iframe 收不到这个键 ——
    // 所以由宿主统一转交，工作台那条 `blend-save` 直接走它自己的 saveCud，两条路径汇成一处。
    if ((e.ctrlKey || e.metaKey) && !e.altKey && keyIs(e, 's')) {
      const t = e.target as HTMLElement | null;
      const tag = (t && t.tagName || '').toLowerCase();
      // 文本框里让浏览器自己来（页面侧同样在文本框里放行，但 Ctrl+S 在那边是显式保存，
      // 所以这里只挡 textarea / contenteditable 这类"文字优先"的地方）。
      if (tag !== 'textarea' && !(t && t.isContentEditable)) {
        e.preventDefault(); e.stopPropagation();
        blendIframeRef.current?.contentWindow?.postMessage({ type: 'blend-save' }, '*');
        return;
      }
    }
  }), [blendIframeRef]);
  // Alt+P 唯一的写口：把拥有 `id` 的那一块换成这个模式（Default 收成一行 tab，Vertical/Horizontal
  // 摊成一个单元一个窗口）。块本身没变，变的是它怎么摆它的成员。摊开是纯框架动作：新 split 继承
  // 容器的尺寸、里面的块全部 free 平分，内容占多大不参与（见 model.ts 的 switchMode）。
  const setMode = (id: UnitId, mode: DockMode) => {
    // 改模式是纯布局动作，而且它会就地重排整块（见 switchMode），所以它是轨迹里必须有的一笔。
    note('block.mode', { id, mode });
    applyDock(setBlockMode(dock, id, mode));
  };
  // 界面探针的登记口：把"活的 dock"交出去，探针只读它。放在这里是因为这一层同时握着三样它需要
  // 的东西 —— 树、规则（尺寸偏好与 store key）、编辑模式 —— 而探针不该顺着组件树去猜它们。
  useEffect(() => {
    registerProbe({ dock, rules: dockRules, edit: blockEdit });
    return () => registerProbe(null);
  }, [dock, dockRules, blockEdit]);
  useEffect(() => {
    const end = () => { setDockDrag(null); setDockOver(null); };
    // CAPTURE, on purpose, on all three. A drop is handled by React at the root container, which calls
    // stopPropagation — a bubbling listener here never hears about it. And `dragend` fires at the
    // SOURCE element: a drop that moves a unit out of its own block deletes that grip from the DOM, and
    // an event dispatched at a node no longer in the document does not reach `window` at all. A drag
    // nobody ended leaves the page believing one is still running — the landing bands stay up and the
    // live workbench stays faded out behind an iframe that no longer takes the pointer, which reads as
    // "this canvas window stopped rendering". The browser suppresses the mouse for the whole of a drag,
    // so the next release is proof that none is left: that is the backstop for the cases where both the
    // drop and the dragend went somewhere this page cannot see.
    const on = { capture: true } as const;
    window.addEventListener('dragend', end, on);
    window.addEventListener('drop', end, on);
    window.addEventListener('mouseup', end, on);
    return () => {
      window.removeEventListener('dragend', end, on);
      window.removeEventListener('drop', end, on);
      window.removeEventListener('mouseup', end, on);
    };
  }, []);
  // ── THE LIVE WORKBENCH ──
  // One frame for the whole page, because it owns every open project: an <iframe> moved in the DOM
  // reloads, and a reload throws all of them away. So the frame is never re-parented — it is pinned
  // over the ACTIVE document's body box instead, and every other window shows the last frame that
  // document painted before the swap. That is what lets several canvas windows exist on one engine
  // without ever mounting a second one (the engine itself goes per-document in the next stage).
  const activeUnit = blendDocs.activeUid === null ? null : docUnit(blendDocs.activeUid);
  const drawRef = useRef<HTMLDivElement | null>(null);
  const frameBodyEls = useRef(new Map<UnitId, HTMLDivElement>());
  const [frameRect, setFrameRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const measureFrame = useCallback(() => {
    const host = drawRef.current;
    const body = activeUnit ? frameBodyEls.current.get(activeUnit) : undefined;
    // No box, or a box that is folded away (display:none measures zero): the frame stays mounted, it
    // just has nowhere to be. Unmounting it here would reload the workbench.
    let next: { x: number; y: number; w: number; h: number } | null = null;
    // Video 模式：活跃文档窗的正文是播放器，活画布 iframe 让位 —— 停在屏外（不卸载，不重载），
    // 切回 Image 模式这一帧量回原位，工作台接着用。
    if (host && body && vidModeRef.current !== 'video' && body.clientWidth > 0 && body.clientHeight > 0) {
      const a = body.getBoundingClientRect(), b = host.getBoundingClientRect();
      next = { x: Math.round(a.left - b.left), y: Math.round(a.top - b.top), w: Math.round(a.width), h: Math.round(a.height) };
    }
    // Only a real change may re-render, or measuring would feed itself.
    setFrameRect(prev => prev?.x === next?.x && prev?.y === next?.y && prev?.w === next?.w && prev?.h === next?.h ? prev : next);
  }, [activeUnit]);
  // Every render re-measures: a dock gesture that moves the active box is a re-render, and reading one
  // rect is cheaper than enumerating every way the layout can move.
  useLayoutEffect(measureFrame);
  useEffect(() => {
    // …but the page living inside a ComfyUI widget also moves and resizes with no render at all, so the
    // box and its host are watched directly.
    const els = [drawRef.current, activeUnit ? frameBodyEls.current.get(activeUnit) : null]
      .filter((el): el is HTMLDivElement => !!el);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measureFrame());
    els.forEach(el => ro?.observe(el));
    window.addEventListener('resize', measureFrame);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measureFrame); };
  }, [measureFrame, activeUnit]);
  // What each open document's window shows: the live frame floats OVER the active one (see below), so
  // its own box is only the dark ground beneath it; every other window holds the last frame that
  // project painted before the workbench switched away from it. A document the workbench never showed
  // — a 3D scene, whose canvas is not a composite this page can flatten — is simply dark.
  // Video 模式下例外：**活跃文档窗的正文整个换成播放器**（那扇大窗就是 Video 的监视器），
  // 其余文档窗照旧显示各自的静帧。
  const docBodies: Record<UnitId, React.ReactNode> = {};
  for (const d of blendDocs.docs) {
    const active = d.uid === blendDocs.activeUid;
    const still = active ? null : docStills[d.uid];
    docBodies[docUnit(d.uid)] = active && vidMode === 'video'
      ? <VidPlayer vid={vidCtl} visible={tab === 'draw'} />
      : still
        ? <img src={still} alt={d.name} style={styles.docStill} />
        : <div style={styles.docVoid} />;
  }
  // 保留位（关掉最后一份工程后留下的空窗）也给正文：一句引导，别让用户对着一扇黑窗发愣。
  // 新工程打开时会原地认领这一格，正文自动换成真的画布。
  for (const u of dockUnits(dock.tree)) {
    if (docUidOf(u) !== null && !docBodies[u]) {
      docBodies[u] = (
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, color: 'rgba(255,255,255,0.35)', fontSize: 12, textAlign: 'center' }}>
          No project open — use File ▸ New / Load in the top bar.
        </div>
      );
    }
  }
  // 关掉一份工程的那颗 ✕ **跟着它自己的名字走**（DockCtx.tabOps）：一扇窗的标题条是"窗"的，那条
  // 栏上的键对整扇窗说话（折叠 / 浮出 / 收成条）；而"关掉这一份"是一个 tab 的事 —— 所以它站在那
  // 颗 tab 的右边；窗口里只有一份时，它就贴在名字右边，不飘到整条栏的最右端去。
  // 工作台仍是唯一知道"这一份值不值得先存一下"的地方，所以它只给入口，动作照旧交回去。
  const docTabOps: Record<UnitId, React.ReactNode> = {};
  for (const d of blendDocs.docs) {
    docTabOps[docUnit(d.uid)] = (
      <button style={styles.docCloseTab} data-dock-doc-close={d.uid} title={'Close 「' + d.name + '」'}
        onClick={e => {
          e.stopPropagation();
          // 只有 Video 被动过的时候，工作台那份账还是干净的 —— 而"关之前要不要问一句"
          // 是它在管。先把这笔脏递过去，再把 close 这条命令递过去（postMessage 保序）。
          if (vidDirty.current.has(d.uid)) {
            blendIframeRef.current?.contentWindow?.postMessage({ type: 'blend-vid-dirty', uid: d.uid }, '*');
          }
          onDocCommand('close', d.uid);
        }}>
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor"
          strokeWidth="1.7" strokeLinecap="round"><path d="M3 3l6 6M9 3l-6 6" /></svg>
      </button>
    );
  }
  // The frame is painted into this page's stacking order; a popped-out window is at the float layer, so
  // following one means going above it — otherwise the window's own background hides its canvas.
  const activeIsWindow = !!activeUnit && dock.floats.some(f => f.id === activeUnit);
  // 左栏不再有自己的把手：它就是 dock 树里的一个嵌套，宽度跟着画布那枚单元的边角一起改。
  // 右键某个 preset 行才出现的菜单；null = 没有菜单。
  const [presetMenu, setPresetMenu] = useState<{ x: number; y: number; setId: string } | null>(null);
  const [renamingPresetValue, setRenamingPresetValue] = useState('');
  // 某个 preset 行的 ⚙ 打开的 pipeline 绑定弹窗；存的是这套链的 id，null = 没开。
  const [presetPipelineFor, setPresetPipelineFor] = useState<string | null>(null);

  // ── Pipeline Settings ──
  // 扁平化的候选：后端按名字找、同名取第一条（find_pipeline_by_name），所以这里也去重，
  // 保证 enum 上点的和 run 时加载的是同一条。
  const pipelineNames = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const pkg of pipelinePackages) for (const p of (pkg.pipelines || [])) {
      if (!p.name || seen.has(p.name)) continue;
      seen.add(p.name);
      out.push(p.name);
    }
    return out;
  }, [pipelinePackages]);

  const selectedPipeline = pipelineSettings.selected || '';
  // '' = [Default]（节点输入口那条）。它的身份后端从来没收集过，所以既选不回去也切不回去 ——
  // 这颗选项只在还没选过任何东西时出现。
  const isDefaultPipeline = !selectedPipeline || selectedPipeline === PIPELINE_DEFAULT;
  const pipelineIsMissing = (name: string): boolean =>
    !!name && name !== PIPELINE_CURRENT_SELECT
    && pipelinePackages.length > 0 && !pipelineNames.includes(name);
  // 选中的名字解不出来（包断了/改名）。packages 还没到齐时不下结论，避免闪一下橙标。
  const selectedUnresolved = !isDefaultPipeline && selectedPipeline !== PIPELINE_CURRENT_SELECT
    && !pipelineNames.includes(selectedPipeline);

  // 选 pipeline = 立刻加载那条（切换必须是即时的，昂贵的是加载而不是选择本身）。
  // [Default] / [Current Select] 都不触发加载：前者切不回去，后者明确"用当前这条"。
  const choosePipeline = (name: string) => {
    if (name && name !== PIPELINE_CURRENT_SELECT && !pipelineIsMissing(name)) {
      for (let pi = 0; pi < pipelinePackages.length; pi++) {
        const qi = (pipelinePackages[pi].pipelines || []).findIndex(p => p.name === name);
        if (qi >= 0) { onSwitchPipeline(pi, qi); break; }
      }
    }
    onPipelineSettingsChange({ ...pipelineSettings, selected: name });
  };

  // Shared prompt presets: loaded once, re-fetched after the preset editor saves so card
  // summaries reflect the new content without a full config refetch.
  const refreshPromptPresets = useCallback(async () => {
    try {
      const res = await fetch('/api/prompt_presets');
      const data = await res.json();
      setPromptPresets(Array.isArray(data?.presets) ? data.presets : []);
    } catch { /* keep whatever we had */ }
    setPresetsLoaded(true);
  }, []);
  useEffect(() => { void refreshPromptPresets(); }, [refreshPromptPresets]);

  const createPromptPreset = useCallback(async (): Promise<PromptPreset | null> => {
    try {
      const res = await fetch('/api/prompt_presets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create' }),
      });
      const data = await res.json();
      if (data?.ok && data.preset) {
        setPromptPresets(list => [...list, data.preset]);
        return data.preset;
      }
    } catch { /* fall through */ }
    return null;
  }, []);

  const renamePromptPreset = useCallback(async (id: string, name: string) => {
    try {
      const res = await fetch('/api/prompt_presets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename', id, name }),
      });
      const data = await res.json();
      if (data?.ok) setPromptPresets(list => list.map(p => p.id === id ? { ...p, name } : p));
    } catch { /* ignore */ }
  }, []);

  const deletePromptPreset = useCallback(async (id: string) => {
    try {
      const res = await fetch('/api/prompt_presets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      });
      const data = await res.json();
      if (data?.ok) {
        // References stay dangling on purpose: the block keeps the id, its dropdown shows
        // `(missing)`, and a run treats the missing preset as an empty selection.
        setPromptPresets(list => list.filter(p => p.id !== id));
      }
    } catch { /* ignore */ }
  }, []);

  // A Query-scope prompt iframe hands the picked selection straight back to the host; the
  // backend (not this UI) merges it, so all we do is forward it and close the dialog. When the
  // block was Persistent the answer also overwrote its preset server-side, so re-fetch the
  // presets once that POST has returned — the card summaries must show the new content.
  useEffect(() => {
    const onAnswered = (event: MessageEvent) => {
      if (event.data?.type !== 'prompt-query-answered') return;
      const bound = pendingQuery?.preset_id && pendingQuery.persistent;
      void Promise.resolve(onQueryAnswer(event.data.selection || {})).finally(() => {
        if (bound) void refreshPromptPresets();
      });
    };
    window.addEventListener('message', onAnswered);
    return () => window.removeEventListener('message', onAnswered);
  }, [onQueryAnswer, pendingQuery, refreshPromptPresets]);

  // The preset-scope prompt iframe saves to the shared preset through the backend AND
  // notifies us — refresh the list (new content) and close the editor.
  useEffect(() => {
    const onSaved = (event: MessageEvent) => {
      if (event.data?.type !== 'prompt-preset-saved') return;
      void refreshPromptPresets();
      setEditingPromptBlockId(null);
    };
    window.addEventListener('message', onSaved);
    return () => window.removeEventListener('message', onSaved);
  }, [refreshPromptPresets]);

  useEffect(() => {
    const onPreview = (event: MessageEvent) => {
      if (event.data?.type !== 'blend-preview') return;
      const image = event.data.image as string | null;
      if (!image) { setBlendPreview(null); return; }
      const w = Number(event.data.width) || 0, h = Number(event.data.height) || 0;
      setBlendPreview({ image, size: w && h ? `${w}×${h}` : '' });
    };
    window.addEventListener('message', onPreview);
    return () => window.removeEventListener('message', onPreview);
  }, []);

  // Guidances 那张总卡：iframe 合成好就发一张（空栈 / 全隐藏时 image 为空 = 撤回那张卡）。
  // 显示只认这一份，不再从图池读 —— 池子那格会被别的实例覆盖，也不会自己修回来。
  useEffect(() => {
    const onGuidance = (event: MessageEvent) => {
      if (event.data?.type !== 'blend-guidance-card') return;
      setGuidanceCard(typeof event.data.image === 'string' ? event.data.image : '');
    };
    window.addEventListener('message', onGuidance);
    return () => window.removeEventListener('message', onGuidance);
  }, []);

  const applyPreviewTint = useCallback((v: number) => {
    setPreviewTint(v);
    blendIframeRef.current?.contentWindow?.postMessage({ type: 'blend-preview-tint', value: v }, '*');
  }, [blendIframeRef]);

  // `draw` is the Blend workbench: the canvas composite is the Context Image and the pure Mask
  // layer is the mask, so the old mask / blend / tag tabs are gone (the Tag buttons live in the
  // workbench toolbar). `context` and `pipeline` followed them — the pipeline switch now lives in
  // the Draw panel's Pipeline Settings section, and nothing reads a separately-picked context.
  const tabs: { id: Tab; icon: string; color: string }[] = [
    { id: 'prompt', icon: 'prompt', color: '#0a84ff' },
    { id: 'draw', icon: 'draw', color: '#30d158' },
    ...(interfaces.length > 0 ? [{ id: 'interface' as Tab, icon: 'interface', color: '#bf5af2' }] : []),
    { id: 'settings', icon: 'settings', color: '#5e5ce6' },
  ];
  // Sidebar tabs are icon-only; this is the name their tooltip shows. `draw` stays the internal
  // id (the Tab type, stores and message channels all key on it) — only the display name changed.
  const TAB_LABELS: Record<Tab, string> = { prompt: 'Prompt', draw: 'Workbench', interface: 'Interface', settings: 'Settings' };

  const updateBlockParam = (blockId: string, key: string, value: string | number | boolean | Record<string, any> | null) => {
    onBlocksChange(blocks.map(b => b.id === blockId ? { ...b, params: { ...b.params, [key]: value } as any } : b));
  };

  // An interface block is MISSING when its bound interface no longer exists (package removed or
  // renamed). Blocks saved before name-binding only carry interface_idx — fall back to that.
  // Judged only when the interfaces list is actually loaded, so a slow /api/package never
  // flashes false Missing badges. Missing blocks are bypassed at run time by the backend.
  const ifaceIsMissing = (block: PipelineBlock): boolean => {
    if (block.type !== 'interface' || interfaces.length === 0) return false;
    const ip = block.params as any;
    if (ip.interface_name) return !interfaces.some(i => i.name === ip.interface_name);
    return !(interfaces as InterfaceInfo[])[ip.interface_idx ?? -1];
  };

  // Prompt blocks INJECT the bound preset's selection at run time; Query blocks SEED their
  // dialog with it. Same shared preset, same row — only the tooltip says which.
  const renderPresetBinding = (block: PipelineBlock, bindingTitle: string) => {
    const pp = block.params as PromptBlockParams;
    const preset = pp.preset_id ? promptPresets.find(p => p.id === pp.preset_id) : null;
    const sel = preset?.selection;
    const nTags = (sel?.tags || []).length;
    const nLoras = (sel?.loras || []).length;
    const nPrefabs = (sel?.prefabs || []).length;
    const nPrograms = (sel?.programs || []).length;
    const presetMissing = !!pp.preset_id && presetsLoaded && !preset;
    const summary = presetMissing
      ? '⚠ preset 已被删除 (missing) — 请重新选择或新建'
      : !preset
        ? '未选择 preset — 从下拉选择或新建一个'
        : `${nTags} tags · ${nLoras} loras · ${nPrefabs} prefabs · ${nPrograms} programs`;
    const startRename = () => {
      setRenamingPresetId(preset?.id || null);
      setRenamingPresetValue(preset?.name || '');
    };
    const commitRename = () => {
      if (renamingPresetId && renamingPresetValue.trim()) {
        void renamePromptPreset(renamingPresetId, renamingPresetValue.trim());
      }
      setRenamingPresetId(null);
    };
    const iconBtnStyle = (enabled: boolean): React.CSSProperties => ({
      background: 'none', border: 'none', color: enabled ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.2)',
      cursor: enabled ? 'pointer' : 'default', fontSize: 12, padding: '2px 4px', lineHeight: 1, flexShrink: 0,
    });
    return (<>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, width: '100%' }}>
        {renamingPresetId && preset ? (
          <input
            autoFocus
            value={renamingPresetValue}
            onChange={e => setRenamingPresetValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenamingPresetId(null); }}
            onBlur={commitRename}
            style={{ flex: 1, minWidth: 0, padding: '4px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(100,210,255,0.4)', color: '#fff', fontSize: 11.5, outline: 'none' }}
          />
        ) : (
          <select
            value={pp.preset_id || ''}
            onChange={e => updateBlockParam(block.id, 'preset_id', e.target.value || null)}
            title={bindingTitle}
            style={{ flex: 1, minWidth: 0, padding: '4px 6px', borderRadius: 6, background: '#1c1c1e', border: '0.5px solid rgba(255,255,255,0.15)', color: '#fff', fontSize: 11.5 }}
          >
            <option value="" style={{ background: '#1c1c1e' }}>— 选择 preset —</option>
            {pp.preset_id && presetsLoaded && !promptPresets.some(p => p.id === pp.preset_id) && (
              <option value={pp.preset_id} style={{ background: '#1c1c1e' }}>(missing)</option>
            )}
            {promptPresets.map(p => <option key={p.id} value={p.id} style={{ background: '#1c1c1e' }}>{p.name}</option>)}
          </select>
        )}
        <button title="New preset and use it on this block" style={iconBtnStyle(true)}
          onClick={async () => { const p = await createPromptPreset(); if (p) updateBlockParam(block.id, 'preset_id', p.id); }}>＋</button>
        <button title="Rename this preset" disabled={!preset} style={iconBtnStyle(!!preset)} onClick={startRename}>✎</button>
        <button title={preset ? 'Open the prompt editor for this preset' : presetMissing ? 'This preset was deleted — pick another one' : 'Select or create a preset first'}
          disabled={!preset} style={iconBtnStyle(!!preset)}
          onClick={() => { if (preset) setEditingPromptBlockId(block.id); }}>⚙</button>
        <button title="Delete this preset (referencing blocks will show (missing))" disabled={!preset} style={iconBtnStyle(!!preset)}
          onClick={() => {
            if (!preset) return;
            if (window.confirm(`删除 preset「${preset.name}」？引用它的块会保留引用并显示 (missing)，run 时按空处理。`)) void deletePromptPreset(preset.id);
          }}>🗑</button>
      </div>
      <div style={{
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontSize: 11, color: presetMissing ? '#ff9f0a' : 'rgba(255,255,255,0.45)',
      }}>{summary}</div>
    </>);
  };

  // limit_pixels 的 pixels/align 为全局参数，取自第一个 detailer block（与后端 first_bp 一致）。
  const firstDetailer = blocks.find(b => b.type === 'detailer');
  const firstDp = firstDetailer ? (firstDetailer.params as DetailerBlockParams) : undefined;
  // Preprocess Settings 的两个总闸也放在第一个 detailer block 上（与 crop_reserve / pixels
  // / align 同源），所以每个 Pipeline Preset 各自一份，默认开。关掉不只是灰掉 UI —— 后端
  // 会真的跳过对应步骤。
  const enableMask = firstDp ? (firstDp.enable_mask ?? true) : true;
  const enableLimit = firstDp ? (firstDp.enable_limit ?? true) : true;
  const dynLayer = firstDp ? (firstDp.enable_dynamic_layer ?? false) : false;

  // Krea2 提供 fit/crop 两种 Edit 模式（source patch）；其余架构仅显示 Enable Edit
  const isKrea2 = !!architecture && /krea2/i.test(architecture);

  const toggleFinishSelection = (key: string) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleConfirmFinish = () => {
    const keys = Array.from(selectedKeys);
    onFinish(keys.length > 0 ? keys : undefined);
  };

  const handleCloseFinishDialog = () => {
    setSelectedKeys(new Set());
    setHoveredFinish(null);
    onCloseFinishDialog();
  };

  return (
    <div style={styles.container}>
      {/* Three things an inline style prop cannot express: the panel's dark scrollbar (a
          ::-webkit-scrollbar rule), the resize handle's hover/focus tint, and the Settings page's
          iOS value field (a :focus underline plus the number spinners it must not show). All scoped
          by class here — the scrollbar matches the workbench's own (faint pill, transparent track,
          no arrow buttons). */}
      <style>{`
        .dark-scroll { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.22) transparent; }
        .dark-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
        .dark-scroll::-webkit-scrollbar-track { background: transparent; }
        .dark-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.22); border: 3px solid transparent; border-radius: 8px; background-clip: padding-box; }
        .dark-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.36); background-clip: padding-box; }
        .dark-scroll::-webkit-scrollbar-corner { background: transparent; }
        .dark-scroll::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
        .ios-val::-webkit-outer-spin-button, .ios-val::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        .ios-val { -moz-appearance: textfield; appearance: textfield; }
        .ios-val:focus { border-bottom-color: #0a84ff; }
        /* ---- Layers / Guidances 两格 ----
           这一族规则是从 blend_node.html 那一页搬过来的，选择器名与声明块都照原文（门禁比这两段）。
           必要的不一样只有三处，每一处都写在这里，门禁也照这三处放行：
           ① 面如今是一张 PNG，不再是页面就地重画的那块 canvas 元素，所以原来挂在 canvas 上的四条尺寸
              规则改挂在 img 上。84×56 与 36×24 是同一个 3:2，所以摆法不需要 object-fit —— 裁与留边那张
              决定已经由 paintOrigFace / paintCanvasThumb 烘进像素里了。
           ② 头部那颗 Add 弹卡：页面那条 .io-menu 是绝对定位挂在 .mini-group 下面的，dock 的正文有自己的
              scroller，绝对定位会被剪掉 —— 改成固定坐标摆（见下面那一条）。
           ③ 停用那一步的暗淡：页面把魔棒直接 innerHTML 进 chip，所以那条规矩写的是「直接子 svg」；React
              里同一颗元素不能既塞 innerHTML 又放兄弟节点（角标必须活着），所以画法包了一层 .attr-visual，
              那一条因此多认 .attr-visual 下面的 svg。 */
        /* 那一组动作的容器（页面 .mini-group 那一条原样搬来：Layers / Guidances / History 那一排
           Clear All / Add / Undo / Redo 如今住 dock 画的动作条里，见 DockView 的 dockFoot）。 */
        .mini-group { position: relative; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; }
        .layer-list { display: flex; flex-direction: column; gap: 4px; }
        .layer-list.drop-target { outline: 1px dashed rgba(0,122,255,0.75); outline-offset: 2px; border-radius: 8px; }
        .layer-empty { flex: 1 0 auto; display: flex; align-items: center; justify-content: center; font-size: 11px; color: rgba(255,255,255,0.25); padding: 10px 4px; text-align: center; border: 1px dashed rgba(255,255,255,0.1); border-radius: 8px; }
        .layer-row { display: flex; flex-direction: column; align-items: stretch; gap: 4px; padding: 5px; border-radius: 8px; background: rgba(255,255,255,0.04); border: 1px solid transparent; cursor: pointer; user-select: none; }
        .layer-row-main { display: flex; align-items: center; gap: 5px; min-width: 0; }
        .layer-row-thumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
        .layer-row:hover { background: rgba(255,255,255,0.08); }
        .layer-row.selected { border-color: rgba(0,122,255,0.85); background: rgba(0,122,255,0.14); }
        .layer-row.dragging { opacity: 0.4; }
        .layer-row.drop-above { box-shadow: inset 0 2px 0 rgba(0,122,255,0.9); }
        .layer-row.drop-below { box-shadow: inset 0 -2px 0 rgba(0,122,255,0.9); }
        .layer-row.hidden-layer .layer-thumb, .layer-row.hidden-layer .layer-name { opacity: 0.35; }
        .layer-row-thumbs.drop-tail { box-shadow: inset 0 0 0 1px rgba(0,122,255,0.6); border-radius: 6px; }
        .layer-thumb { width: 36px; height: 24px; flex-shrink: 0; border-radius: 5px; background: #111; overflow: hidden; display: flex; align-items: center; justify-content: center; position: relative; }
        .layer-thumb img { width: 100%; height: 100%; display: block; }
        .layer-thumb.no-image { background: #1c1113; box-shadow: inset 0 0 0 1px rgba(255,59,48,0.35); }
        .layer-thumb.no-image svg { width: 14px; height: 14px; display: block; }
        .layer-thumb.mask-thumb { background: #000; cursor: pointer; }
        .layer-thumb.canvas-thumb { background: #0a0a0a; }
        .layer-thumb.decal-thumb { cursor: pointer; background-color: #2a2a2a;
            background-image: linear-gradient(45deg, #1c1c1c 25%, transparent 25%, transparent 75%, #1c1c1c 75%),
                              linear-gradient(45deg, #1c1c1c 25%, transparent 25%, transparent 75%, #1c1c1c 75%);
            background-size: 8px 8px; background-position: 0 0, 4px 4px; }
        .layer-thumb.active { box-shadow: inset 0 0 0 2px #fff; }
        .layer-thumb.attr-chip { cursor: pointer; }
        .layer-thumb.effects-thumb { background: #171717; color: rgba(255,255,255,0.72); }
        .layer-thumb.effects-thumb svg { width: 15px; height: 15px; display: block; }
        .layer-thumb.attr-chip.dragging { opacity: 0.4; }
        .layer-thumb.attr-chip.drop-before::before, .layer-thumb.attr-chip.drop-after::after { content: ''; position: absolute; top: 0; bottom: 0; width: 2px; background: rgba(0,122,255,0.95); }
        .layer-thumb.attr-chip.drop-before::before { left: 0; }
        .layer-thumb.attr-chip.drop-after::after { right: 0; }
        .layer-thumb.attr-chip.drop-into { box-shadow: inset 0 0 0 2px rgba(0,122,255,0.9); }
        .layer-thumb.attr-chip .attr-badge { display: none; pointer-events: none; }
        .layer-thumb.attr-chip.attr-off .attr-badge { display: block; position: absolute; inset: 0; }
        .layer-thumb.attr-chip.attr-off .attr-badge::before,
        .layer-thumb.attr-chip.attr-off .attr-badge::after { content: ''; position: absolute; left: 50%; top: 50%; width: 16px; height: 2px; border-radius: 1px; background: #ff453a; transform: translate(-50%, -50%) rotate(45deg); }
        .layer-thumb.attr-chip.attr-off .attr-badge::after { transform: translate(-50%, -50%) rotate(-45deg); }
        .layer-thumb.attr-chip.attr-off img, .layer-thumb.attr-chip.attr-off > svg, .layer-thumb.attr-chip.attr-off .attr-visual > svg { opacity: 0.32; }
        .attr-type-badge { position: absolute; right: 1px; bottom: 1px; width: 12px; height: 12px; border-radius: 3px; background: rgba(0,0,0,0.66); display: flex; align-items: center; justify-content: center; pointer-events: none; }
        .attr-type-badge svg { width: 9px; height: 9px; display: block; }
        .attr-type-badge.decal { color: #ffb86e; }
        .attr-type-badge.mask { color: #9ecbff; }
        .attr-type-badge.effects { color: #ffd76e; }
        .attr-type-badge.text { color: #d9b8ff; }
        .attr-type-badge.direction { color: #ff9ec4; }
        .attr-type-badge.plane { color: #f5c542; }
        .attr-type-badge.point { color: #19e0bc; }
        .attr-type-badge.ray { color: #ff7ab0; }
        .attr-type-badge.model { color: #7ee0d0; }
        .attr-type-badge.pose { color: #a8e06e; }
        .layer-thumb.text-attr-thumb, .layer-thumb.direction-attr-thumb, .layer-thumb.scene3d-attr-thumb,
        .layer-thumb.plane-attr-thumb, .layer-thumb.point-attr-thumb, .layer-thumb.ray-attr-thumb,
        .layer-thumb.pose-attr-thumb { cursor: pointer; background-color: #1b1d24; }
        .attr-add { width: 36px; height: 24px; flex-shrink: 0; border-radius: 5px; border: 1px dashed rgba(255,255,255,0.22); background: transparent; color: rgba(255,255,255,0.55); display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; }
        .attr-add:hover { border-color: rgba(0,122,255,0.9); color: #fff; background: rgba(0,122,255,0.16); }
        .layer-type-badge { position: absolute; right: 1px; bottom: 1px; width: 12px; height: 12px; border-radius: 3px; background: rgba(0,0,0,0.66); display: flex; align-items: center; justify-content: center; pointer-events: none; }
        .layer-type-badge svg { width: 9px; height: 9px; display: block; }
        .layer-type-badge.smart { color: #9ecbff; }
        .layer-type-badge.raster { color: #ffcf6e; }
        .layer-type-badge.cud { color: #8be3b6; }
        .layer-type-badge.cud.unlinked { color: #ff9d5c; }
        .layer-type-badge.text { color: #d9b8ff; }
        .layer-type-badge.direction { color: #ff9ec4; }
        .layer-type-badge.model { color: #7ee0d0; }
        .layer-type-badge.stash { color: #e3d17a; }
        .layer-name { flex: 1; min-width: 0; font-size: 12px; color: rgba(255,255,255,0.85); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: text; }
        /* 双击行名就地改名（拍板 7.a：编辑归宿主，提交发 layer-rename）。这一条与页面同文。 */
        .layer-rename { width: 100%; min-width: 0; box-sizing: border-box; font-size: 12px; color: #fff; background: #1b1b1f; border: 1px solid rgba(255,255,255,0.35); border-radius: 4px; padding: 1px 4px; outline: none; }
        .icon-btn { background: transparent; border: none; color: rgba(255,255,255,0.45); cursor: pointer; padding: 2px; border-radius: 6px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .icon-btn:hover { background: rgba(255,255,255,0.12); color: #fff; }
        .icon-btn:disabled { opacity: 0.35; cursor: default; }
        .icon-btn:disabled:hover { background: transparent; color: rgba(255,255,255,0.45); }
        .icon-btn svg { display: block; width: 14px; height: 14px; }
        .fx-chain { display: flex; flex-direction: column; gap: 3px; min-width: 0; margin: 0 2px 1px 5px;
            padding-left: 8px; border-left: 1px solid rgba(255,255,255,0.18); }
        .fx-chain.bypassed { border-left-color: rgba(255,159,10,0.55); }
        .fx-steps { display: flex; flex-direction: column-reverse; gap: 3px; min-width: 0; }
        .fx-chip { display: flex; align-items: center; gap: 4px; min-width: 0; padding: 2px 3px; border-radius: 6px;
            background: rgba(255,255,255,0.05); cursor: pointer; user-select: none; position: relative; }
        .fx-chip:hover { background: rgba(255,255,255,0.09); }
        .fx-chip.disabled { opacity: 0.42; }
        .fx-chip.dragging { opacity: 0.4; }
        .fx-chain.bypassed > .fx-steps > .fx-chip { opacity: 0.5; }
        .fx-chip.drop-before::after, .fx-chip.drop-after::before { content: ''; position: absolute; left: 0; right: 0; height: 2px; background: rgba(0,122,255,0.95); }
        .fx-chip.drop-before::after { bottom: 0; }
        .fx-chip.drop-after::before { top: 0; }
        .fx-chip input[type="checkbox"] { width: 13px; height: 13px; margin: 0; flex-shrink: 0; accent-color: #0a84ff; cursor: pointer; }
        .fx-icon { width: 14px; height: 14px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; color: #9ecbff; }
        .fx-icon svg { width: 14px; height: 14px; display: block; }
        .fx-name { font-size: 11px; font-weight: 700; color: rgba(255,255,255,0.85); white-space: nowrap; }
        .fx-read { flex: 1; min-width: 0; font-size: 10.5px; color: rgba(255,255,255,0.55);
            font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .fx-chain.bypassed .fx-read { color: rgba(255,159,10,0.75); }
        .fx-warn { font-size: 10px; font-weight: 700; color: #ff9f0a; padding: 1px 3px; }
        /* 参数面那一格（Effect Parameters）。取值照页面 .fx-params / .fx-fold-head / .fx-map-btn /
           .fx-curve-* 那几条，换的是宿主：这些类现在住在 dock 的正文里，页面那套 .control-row 骨架
           已经不跟着过来了，所以名字宽度、读数右对齐这些由 wbStyles 说，这里只留形状与颜色。
           .fx-chip.open 是新的一层：参数面从链里搬出来住进宿主以后，"哪一颗 chip 摊着"这件事必须仍然
           看得见，点亮的是那一枚 chip 自己（与页面当年那条 .fx-chip.open 同一个读法）。 */
        .fx-chip.open { background: rgba(10,132,255,0.16); box-shadow: inset 0 0 0 1px rgba(10,132,255,0.6); }
        .fx-params { max-height: 340px; overflow-y: auto; overflow-x: hidden; }
        .fx-fold-head { display: flex; align-items: center; gap: 5px; width: 100%; background: none; border: none;
            color: rgba(255,255,255,0.55); font-size: 10.5px; font-weight: 700; cursor: pointer; padding: 2px 0; }
        .fx-fold-head:hover { color: rgba(255,255,255,0.72); }
        .fx-fold-head::after { content: ''; flex: 1; height: 0.5px; background: rgba(255,255,255,0.14); }
        .fx-bind.unset { color: #ff9f0a; }
        .fx-bind.gone { color: #ff453a; }
        .fx-curve-svg { width: 150px; height: 150px; flex-shrink: 0; border-radius: 4px; display: block;
            cursor: crosshair; touch-action: none; }
        .fx-curve-svg polygon:hover { filter: brightness(1.5); }
        .layer-menu { position: fixed; z-index: 300; display: flex; flex-direction: column; gap: 2px; min-width: 168px;
            padding: 5px; border-radius: 10px; background: rgba(28,28,30,0.94);
            backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%);
            border: 0.5px solid rgba(255,255,255,0.14); box-shadow: 0 8px 28px rgba(0,0,0,0.5); }
        .layer-menu-item { display: block; width: 100%; text-align: left; background: transparent; border: none;
            border-radius: 7px; padding: 7px 10px; color: rgba(255,255,255,0.9); font-size: 12.5px; font-weight: 600;
            cursor: pointer; transition: background 0.12s ease; }
        .layer-menu-item:hover { background: rgba(255,255,255,0.12); }
        .layer-menu-item:disabled { opacity: 0.4; cursor: default; }
        .layer-menu-item:disabled:hover { background: transparent; }
        /* 头部那颗 Add 弹卡：页面那一条 .io-menu 是绝对定位挂在 .mini-group 下面的，dock 的正文
           有自己的 scroller，绝对定位会被剪掉 —— 所以这一张改按固定坐标摆（由那颗按钮的矩形算出来，
           往上翻、贴按钮右缘、216 宽），卡片本身一条规矩没改。 */
        .io-menu { position: fixed; z-index: 95; width: 216px; display: flex; flex-direction: column;
            gap: 3px; padding: 5px; border-radius: 11px; background: #1c1c1e; border: 0.5px solid rgba(255,255,255,0.12);
            box-shadow: 0 14px 40px rgba(0,0,0,0.55); }
        .io-menu-item { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; width: 100%; text-align: left;
            background: transparent; border: none; border-radius: 8px; padding: 7px 9px; cursor: pointer; transition: background 0.12s ease; }
        .io-menu-item:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
        .io-menu-item:disabled { opacity: 0.45; cursor: default; }
        .io-menu-title { font-size: 12px; font-weight: 700; color: #fff; }
        .io-menu-sub { font-size: 10.5px; line-height: 1.35; color: rgba(255,255,255,0.45); white-space: normal; }
        .add-caret { font-size: 8px; line-height: 1; opacity: 0.7; margin-left: 3px; }
        .mini-btn { background: rgba(255,255,255,0.08); border: none; border-radius: 7px; padding: 4px 9px; color: rgba(255,255,255,0.85); font-size: 11px; font-weight: 600; cursor: pointer; transition: background 0.15s ease; }
        .mini-btn:hover { background: rgba(255,255,255,0.16); }
        .mini-btn:disabled { opacity: 0.35; cursor: default; background: rgba(255,255,255,0.05); }
        .mini-btn.ico-btn { min-width: 26px; padding: 4px 7px; font-size: 13px; font-weight: 700; line-height: 1; }
        .mini-btn.ico-btn svg { display: block; width: 14px; height: 14px; }
        .mini-btn.ico-btn.fx-bypassed { background: rgba(255,159,10,0.22); color: #ff9f0a; }
        /* ---- History 这一格（拍板 24.a：右栏、紧贴 Layers 下面）----
           动作条那三颗复用兄弟格的 .mini-group / .mini-btn（禁用那颗的暗淡是同一条 .mini-btn:disabled），
           行自己这一族三条的写法照 .layer-row 那一族：高亮 = 蓝描边 + 蓝底、hover 提亮、名字一行截断。
           颗子摆法有两处与图层行不同，都是这一格的画法等出来的：
           ① 42×28 而不是 36×24 —— 步子的预览是整幅画面按长边 ≤108 编的一张，不像 orig/canvas 那两张
              已经被 paintOrigFace 烘成固定 3:2，所以这里既不裁也不拉伸：img 用 max-width/max-height
              在这颗盒子里居中，画布是竖的它就竖着。
           ② 那一格有自己的 scroller（max-height 264），且不是第三格 grows 单元 —— 1.a 定的是
              Layers / Guidances 平分工具列余高，History 再长也不能去动那一刀。 */
        .hist-list { display: flex; flex-direction: column; gap: 3px; max-height: 264px; overflow-y: auto; overflow-x: hidden; }
        .hist-row { display: flex; align-items: center; gap: 5px; min-width: 0; padding: 3px 4px; border-radius: 7px; background: rgba(255,255,255,0.04); border: 1px solid transparent; cursor: pointer; user-select: none; }
        .hist-row:hover { background: rgba(255,255,255,0.08); }
        .hist-row.current { border-color: rgba(0,122,255,0.85); background: rgba(0,122,255,0.14); }
        .hist-thumb { width: 42px; height: 28px; flex-shrink: 0; border-radius: 5px; background: #111; overflow: hidden; display: flex; align-items: center; justify-content: center; }
        .hist-thumb img { max-width: 100%; max-height: 100%; display: block; }
        .hist-name { flex: 1; min-width: 0; font-size: 11.5px; color: rgba(255,255,255,0.85); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        /* Alt+悬浮那张放大预览（页面的 #hoverPreview 那两条）。浮层永远不吃指针，所以它挡不住行上的
           拖动与点击；原来里面是一块 <canvas>，如今是一张按需编好的 PNG —— 圆角跟着换到 img 上。 */
        .hover-preview { position: fixed; left: 0; top: 0; z-index: 300; padding: 6px; border-radius: 10px; background: rgba(28,28,30,0.92); backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); border: 0.5px solid rgba(255,255,255,0.18); box-shadow: 0 10px 32px rgba(0,0,0,0.5); pointer-events: none; }
        .hover-preview img { display: block; border-radius: 6px; }
        /* The handle is always there; only its volume is hover's. The grip and the two actions sit
           at a quarter strength until the pointer is over the bar, so a column of units reads as
           content first and as chrome second. */
        .dock-bar .dock-h { opacity: 0.28; }
        .dock-bar:hover .dock-h { opacity: 1; }
        /* 块与块之间那条 8px 的缝**就是**把手：它平时是空的（看起来只是间隙），hover 才亮。
           Alt+P 的编辑模式里它常亮，因为那时候用户就是在找它。 */
        .dock-split:hover { background: rgba(10,132,255,0.25); }
        .dock-split-edit { background: rgba(10,132,255,0.22); }
        .dock-corner:hover { filter: brightness(1.6); }
      `}</style>
      {/* Sidebar — vertical icon tabs */}
      <div style={styles.sidebar}>
        <div style={styles.sidebarTabs}>
          {tabs.map(t => (
            <button
              key={t.id}
              title={TAB_LABELS[t.id]}
              style={{
                ...styles.sidebarBtn,
                color: tab === t.id ? t.color : 'rgba(255,255,255,0.35)',
                background: tab === t.id ? t.color + '15' : 'transparent',
                borderLeft: tab === t.id ? `2px solid ${t.color}` : '2px solid transparent',
              }}
              onClick={() => onTabChange(t.id)}
            >
              <TabIcon icon={t.icon} />
              {t.id === 'prompt' && promptReady && <span style={styles.sidebarDot} />}
              {t.id === 'draw' && detailStatus === 'done' && <span style={styles.sidebarDot} />}
            </button>
          ))}
        </div>
        <button style={styles.finishBtn} onClick={onFinishClick} title="Finish">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </button>
      </div>

      {/* Tab content — iframes always mounted, hidden via display:none */}
      <div style={styles.content}>
        {/* Prompt — always mounted */}
        <div style={{ ...styles.iframeWrap, display: tab === 'prompt' ? 'flex' : 'none' }}>
          <iframe ref={promptIframeRef} src={promptUrl} style={styles.iframe} title="Prompt" allow="clipboard-write" />
        </div>

        {/* Blend workbench — this tab stays mounted for the whole session: the iframe owns
            the layer stack and the Mask layer, so unmounting it would lose them. */}
        <div ref={drawRef} style={{ ...styles.drawLayout, display: tab === 'draw' ? 'flex' : 'none' }}>
          {/* One dock, the whole page: the settings column and the canvas are two sides of a split the
              user restacks, not a panel bolted beside a frame. */}
          <DockPanel ctx={{
                rules: dockRules,
                isOpen: (id: UnitId) => openSections[id] !== false, fold: setFold,
                edit: blockEdit, setMode,
                // toolbar 模式的三个写口：收成条 / 放回窗 / 条子上的横竖。开关存在 dock 树里（容器
                // 是每格一位、default 块与浮窗在节点上），所以刷新之后还是那个形状。
                setToolbar: (id: UnitId, on: boolean, dir?: 'h' | 'v') => applyDock(setToolbarDock(dock, id, on, dir)),
                setToolbarDir: (id: UnitId, dir: 'h' | 'v') => applyDock(setToolbarDirDock(dock, id, dir)),
                tbPopover, onToolbarPopover: setTbPopover,
                dock, setDock: applyDock,
                drag: dockDrag, setDrag: setDockDrag,
                over: dockOver, setOver: setDockOver,
                // 文档窗口的标题条是"切到这个项目"，不是折叠它：整页只有一颗画布是激活的，
                // 折叠另有右边那颗箭头。面板照旧点了就折。
                activate: (id: UnitId) => {
                  const uid = docUidOf(id);
                  if (uid !== null) onDocCommand('activate', Number(uid));
                },
                badge: (id: UnitId) => id === activeUnit
                  ? <span style={styles.activeDot} title="Active — the workflows run on this canvas" />
                  : null,
                hint: (id: UnitId) => WORKBENCH_HINTS[id],
                popSize: (id: UnitId) => docUidOf(id) ? { w: DOC_POP_W, h: DOC_POP_H } : null,
                bodyRef: (id: UnitId, el: HTMLDivElement | null) => {
                  if (el) frameBodyEls.current.set(id, el); else frameBodyEls.current.delete(id);
                },
                // 文档的 ✕ 不在这条栏上 —— 它跟着 tab 走（见 docTabOps / tabOps）。
                tabOps: (u: UnitId) => docTabOps[u] ?? null,
                heads: {
                  // 模式切换**只住这一处**：工程画布大窗（文档窗，doc:*）标题条右上、toolbar 化
                  // 按钮左边 —— 那扇窗就是 Video 模式的播放器宿主，别的窗一概不给。
                  ...Object.fromEntries(blendDocs.docs.map(d => [docUnit(d.uid), vidModeSeg])),
                  context: (<>
                    {/* Log：画布上那颗常显状态药丸撤掉后，工作台的每一句反馈都攒在这里
                        （工作台 setStatus + 宿主自身动作，最近 32 条）。 */}
                    <button
                      style={styles.logBtn}
                      title="Log — 最近 32 条行为记录（工作台与本页每一步的反馈）"
                      onClick={() => setShowLog(true)}
                    ><DbgIcon name="log" size={15} /> Log{actionLog.length ? ` · ${actionLog.length}` : ''}</button>
                    {/* Debug：打开上一次 Run / Generate 的全过程快照（prompt 链路 +
                        各 Block 调用后数据 + 中间过程图/遮罩）。数据来自 /api/debug_trace。 */}
                    <button
                      style={styles.debugBtn}
                      title="Debug — 查看上一次 Run / Generate 的全过程快照（prompt 链路、各 Block 数据、中间过程图与遮罩）"
                      onClick={() => setShowDebug(true)}
                    ><DbgIcon name="bug" size={15} /> Debug</button>
                  </>),
                },
                bodies: {
              // 顶栏那一排就是原来 File 菜单的六项，一项一个入口，说明全在 tooltip 里。
              // 工作台读写档的时候整排变灰（`cudBusy`），跟原来那六个按钮的禁用是同一颗开关。
              toolbar: (
                <div style={styles.fileBar}>
                  {FILE_ACTIONS.map(a => (
                    <button key={a.action} title={a.title} disabled={blendDocs.busy}
                      style={{ ...styles.fileBtn, opacity: blendDocs.busy ? 0.38 : 1, cursor: blendDocs.busy ? 'default' : 'pointer' }}
                      onClick={() => onDocCommand(a.action)}>{a.label}</button>
                  ))}
                </div>
              ),
              ...docBodies,
              // 工作台搬出来的那几格：宿主只发指令，正文每格自己读那份快照。Staging 那一格还要
              // 一小把宿主事实 —— 图池镜像、画布合成预览、以及图池的两个后端写口（`wbHost`）。
              ...workbenchBodies(uiSend, wbHost),
              // Tracks / Assets 是常驻的普通窗：Video 模式显示各自正文，Image 模式正文留空。树一概不动。
              vtracks: vidMode === 'video' ? <VidTimeline vid={vidCtl} /> : null,
              vassets: vidMode === 'video' ? <VidAssets vid={vidCtl} /> : null,
              context: (<>
                <div style={styles.dockCard}>
                  <div style={styles.contextPreviewWrap}>
                  {blendPreview ? (
                    <>
                      <img src={blendPreview.image} alt="Context preview" style={styles.blendPreviewImg} />
                      {blendPreview.size && <div style={styles.blendPreviewBadge}>{blendPreview.size}</div>}
                    </>
                  ) : (
                    <div style={styles.blendPreviewEmpty}>Add a layer to preview the composite</div>
                  )}
                </div>
                <div style={styles.previewTintRow}>
                  <label style={styles.previewTintLabel}>Mask Tint</label>
                  <input
                    style={styles.previewTintRange}
                    type="range" min={0} max={1} step={0.01} value={previewTint}
                    onChange={e => applyPreviewTint(parseFloat(e.target.value))}
                    title="How strongly the Mask layer reads in this preview. Independent from the workbench's own Mask layer tint."
                  />
                  <span style={styles.previewTintValue}>{previewTint.toFixed(2)}</span>
                </div>
                </div>
              </>),

              // PIPELINE SETTINGS — 原先左侧的 Pipeline tab 收进这里。
              // 只剩一颗 enum 选 pipeline（选中即切换 —— 昂贵的是加载，不是选择）；
              // 数值覆盖搬去了 Settings 页的架构规则，按 architecture 命中。
              pipeline: (<>
                <div style={styles.dockCard}>
                <div style={styles.paramRow}
                  title={'Which pipeline is loaded on the node. Picking one switches it immediately.\n'
                    + PIPELINE_DEFAULT + ' = the pipeline wired into the node input — the workbench never learns its identity, '
                    + 'so this option only exists until you pick something else.\n'
                    + PIPELINE_CURRENT_SELECT + ' = keep whatever is loaded now, no reload.'}>
                  <label style={styles.paramLabel}>Pipeline</label>
                  <select
                    style={styles.paramSelect}
                    value={isDefaultPipeline ? '' : selectedPipeline}
                    onChange={e => choosePipeline(e.target.value)}
                  >
                    {isDefaultPipeline && <option value="" style={{ background: '#1c1c1e' }}>{PIPELINE_DEFAULT}</option>}
                    <option value={PIPELINE_CURRENT_SELECT} style={{ background: '#1c1c1e' }}>
                      {PIPELINE_CURRENT_SELECT}{loadedPipelineName ? ` (${loadedPipelineName})` : ''}
                    </option>
                    {pipelineNames.map(n => (
                      <option key={n} value={n} style={{ background: '#1c1c1e' }}>{n}</option>
                    ))}
                    {selectedUnresolved && (
                      <option value={selectedPipeline} style={{ background: '#1c1c1e' }}>
                        {selectedPipeline} — {pipelinePackages.length > 0 ? 'Missing' : '(not loaded)'}
                      </option>
                    )}
                  </select>
                </div>
                </div>
              {/* Pipeline Blocks tab bar — 多套 blocks 以 tabs 切换（可重命名/复制/删除，持久化在后端
                  config）；只有激活 tab 的 chain 会运行、会被发给 Blend 工作台。块列表本体在
                  Preprocess Settings 下方，随激活 tab 联动。每个 tab 就是一个 Pipeline Preset，
                  也是 Blend 工作台 Generate 弹窗里那个 enum 的选项。 */}
              <div style={{ ...styles.dockSubrow, position: 'relative' }}>
                <span>Pipeline Presets</span>
                <button
                  title="Add a pipeline preset"
                  onClick={e => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setPresetAddMenu(presetAddMenu ? null : { x: r.left, y: r.bottom + 4 });
                  }}
                  style={addPillStyle(!!presetAddMenu)}>Add +</button>
                {presetAddMenu && (
                  <ContextMenu x={presetAddMenu.x} y={presetAddMenu.y} onClose={() => setPresetAddMenu(null)}
                    items={[{ label: 'New Preset', color: '#0a84ff', hint: 'An empty preset — add blocks to it below', onClick: onAddBlockSet }]} />
                )}
              </div>
                <div style={styles.dockCard}>
              {/* 一个 preset 一行：名字吃满整行，右边一个 ▶ 立刻能跑这一套。 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {blockSets.map((set, setIdx) => {
                  const missing = set.blocks.filter(b => ifaceIsMissing(b)).length;
                  const isActive = set.id === activeBlockSetId;
                  if (renamingSetId === set.id) {
                    return (
                      <input key={set.id} autoFocus value={renamingValue}
                        style={{ ...tabInputStyle, width: '100%', boxSizing: 'border-box', borderRadius: 8 }}
                        onChange={e => setRenamingValue(e.target.value)}
                        onBlur={() => { onRenameBlockSet(set.id, renamingValue); setRenamingSetId(null); }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { onRenameBlockSet(set.id, renamingValue); setRenamingSetId(null); }
                          else if (e.key === 'Escape') setRenamingSetId(null);
                        }}
                      />
                    );
                  }
                  // One row per preset. The row itself carries the interactions: click switches,
                  // double-click renames, drag reorders, right-click offers Duplicate / Delete; the
                  // gear half picks which pipeline it runs with and the ▶ half runs it right now.
                  const bound = set.pipeline_name || '';
                  const boundNamed = !!bound && bound !== PIPELINE_CURRENT_SELECT;
                  const boundMissing = pipelineIsMissing(bound);
                  // ▶ 的形状读这一套自己的第一个 detailer 块（与后端 / 工作台 Run 预检同一函数）
                  const runMasked = firstDetailerFlag(blockSets, set.id, 'enable_mask', true);
                  return (
                    <div key={set.id} style={{
                      display: 'flex', alignItems: 'stretch', borderRadius: 8, overflow: 'hidden',
                      border: '0.5px solid ' + (isActive ? 'rgba(10,132,255,0.6)' : 'rgba(255,255,255,0.1)'),
                      background: isActive ? 'rgba(10,132,255,0.18)' : 'rgba(255,255,255,0.04)',
                    }}
                      draggable
                      onDragStart={e => { e.dataTransfer.setData('application/x-blockset', String(setIdx)); e.dataTransfer.effectAllowed = 'move'; }}
                      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                      onDrop={e => { e.preventDefault(); const from = parseInt(e.dataTransfer.getData('application/x-blockset')); if (!isNaN(from)) onReorderBlockSets(from, setIdx); }}
                      onContextMenu={e => { e.preventDefault(); setPresetMenu({ x: e.clientX, y: e.clientY, setId: set.id }); }}
                    >
                      <button
                        title={(missing > 0 ? `${missing} interface block(s) missing — they will be bypassed at run time\n` : '')
                          + `Pipeline: ${boundNamed ? (boundMissing ? `${bound} (Missing)` : bound) : PIPELINE_CURRENT_SELECT}\n`
                          + `${set.name} · double-click to rename · right-click for Duplicate / Delete`}
                        onClick={() => onSwitchBlockSet(set.id)}
                        onDoubleClick={() => { setRenamingSetId(set.id); setRenamingValue(set.name); }}
                        style={{
                          flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 5,
                          padding: '5px 10px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                          border: 'none', background: 'none', textAlign: 'left',
                          color: isActive ? '#fff' : 'rgba(255,255,255,0.55)',
                        }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{set.name}</span>
                        <span style={{ marginLeft: 'auto', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                          {/* 只在真的绑定了某条 pipeline 时说话；[Current Select] 是默认，不值得占位。 */}
                          {boundNamed && (
                            <span style={{
                              maxWidth: 88, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              background: boundMissing ? 'rgba(255,159,10,0.22)' : 'rgba(255,255,255,0.07)',
                              color: boundMissing ? '#ff9f0a' : 'rgba(255,255,255,0.62)',
                              borderRadius: 999, fontSize: 9.5, padding: '1px 6px', fontWeight: 700,
                            }}>{boundMissing ? 'Missing' : bound}</span>
                          )}
                          {missing > 0 && (
                            <span style={{ background: 'rgba(255,159,10,0.22)', color: '#ff9f0a', borderRadius: 999, fontSize: 9.5, padding: '1px 5px', fontWeight: 700 }}>Missing ×{missing}</span>
                          )}
                        </span>
                      </button>
                      <button
                        title={`Pipeline for 「${set.name}」 — ${boundNamed ? (boundMissing ? `${bound} (Missing)` : bound) : PIPELINE_CURRENT_SELECT}`}
                        onClick={() => setPresetPipelineFor(set.id)}
                        style={{
                          display: 'flex', alignItems: 'center', padding: '0 9px',
                          border: 'none', borderLeft: '0.5px solid rgba(255,255,255,0.12)',
                          background: 'rgba(255,255,255,0.06)', cursor: 'pointer', lineHeight: 1,
                          color: boundNamed ? (boundMissing ? '#ff9f0a' : 'rgba(255,255,255,0.7)') : 'rgba(255,255,255,0.4)',
                        }}>
                        <GearIcon size={13} />
                      </button>
                      <button
                        title={runMasked
                          ? `Run 「${set.name}」 now — ▶ 带框：按 Mask 层裁出的区域跑，产出贴回原图`
                          : `Run 「${set.name}」 now — 裸 ▶：整幅图就是工作区（Enable Mask 关，不做 mask 裁剪）`}
                        onClick={() => onRunPreset(set.id)}
                        style={{
                          display: 'flex', alignItems: 'center', padding: '4px 10px',
                          border: 'none', borderLeft: '0.5px solid rgba(255,255,255,0.12)',
                          background: 'rgba(255,255,255,0.06)', cursor: 'pointer', lineHeight: 1,
                          color: isActive ? '#64d2ff' : 'rgba(100,210,255,0.6)',
                        }}><RunIcon framed={runMasked} /></button>
                    </div>
                  );
                })}
              </div>
              {presetMenu && (() => {
                const target = blockSets.find(s => s.id === presetMenu.setId);
                if (!target) return null;
                return <ContextMenu x={presetMenu.x} y={presetMenu.y} onClose={() => setPresetMenu(null)} items={[
                  { label: 'Duplicate', onClick: () => onDuplicateBlockSet(target.id) },
                  { label: 'Delete', color: '#ff6961', onClick: () => onRemoveBlockSet(target.id) },
                ]} />;
              })()}
                </div>
              </>),

              // Preprocess Settings — 每个 Pipeline Preset 独立的开关（存在第一个 detailer
              // block 的 params 上）。数值参数（Grow/Blur/Crop Reserve/Pixels/Align）都在
              // Settings 页的 DEFAULT SETTING，不按 preset 区分。
              preprocess: (<>
                <div style={styles.dockCard}>
              {/* Mask — mask 预处理三件套，Enable Mask 是总闸 */}
              <div style={styles.dockGroup}>
              <div style={styles.dockGtitle}>Mask</div>
              <div style={styles.dockGbody}>
              <div style={styles.paramRow}
                title="开 = mask 预处理全开：扩张/羽化 + 按 mask 裁剪 + recover crop。关 = 这四步全部跳过（grow/blur 归零、不裁剪、不复原），产出直接落在整幅图坐标系；mask 本身仍然限制重绘区域。">
                <label style={styles.paramLabel}>Enable Mask</label>
                <IOSToggle
                  checked={enableMask}
                  disabled={!firstDp}
                  onChange={v => firstDetailer && updateBlockParam(firstDetailer.id, 'enable_mask', v)}
                />
              </div>
              <div style={{ opacity: enableMask ? 1 : 0.4, pointerEvents: enableMask ? 'auto' : 'none' }}>
              <div style={styles.paramRow}
                title="开 = 按 crop 几何把产出合成回整幅图（原行为）。关 = 不 recover crop（也不 recover resize）：产出保持 crop 工作区分辨率，作为新图层由画布用 transform 贴回原来的位置，可继续微调。">
                <label style={styles.paramLabel}>Recover Crop</label>
                <IOSToggle
                  checked={firstDp ? (firstDp.recover_crop ?? true) : true}
                  disabled={!enableMask}
                  onChange={v => firstDetailer && updateBlockParam(firstDetailer.id, 'recover_crop', v)}
                />
              </div>
              <div style={styles.paramRow}
                title="开 = 图层 Generate 结束时自动 Fit Mask：新图层先继承源图层 mask 落在贴回框内的那一块，再把图层框缩到 mask 真正的外接框，grow/feather 涨出来的死区被一并裁掉，覆盖率不变。关 = 产出铺满整个 crop 框，尺寸不动。只对「图层 Generate」生效（Enable Mask 开 + Recover Crop 关）；整幅 Run 不受影响。">
                <label style={styles.paramLabel}>Enable Fit</label>
                <IOSToggle
                  checked={firstDp ? (firstDp.enable_fit ?? false) : false}
                  disabled={!enableMask}
                  onChange={v => firstDetailer && updateBlockParam(firstDetailer.id, 'enable_fit', v)}
                />
              </div>
              </div>
              </div>
              </div>
              {/* Limit — 工作分辨率上限 */}
              <div style={styles.dockGroup}>
              <div style={styles.dockGtitle}>Limit</div>
              <div style={styles.dockGbody}>
              <div style={styles.paramRow}
                title="开 = 按 Pixels / Align 限制工作分辨率。关 = 既不缩放也不对齐，工作分辨率就是裁剪（或整幅）分辨率；Qwen 架构仍会强制 32 对齐，否则 latent / vision token 网格不接受。">
                <label style={styles.paramLabel}>Enable Limit</label>
                <IOSToggle
                  checked={enableLimit}
                  disabled={!firstDp}
                  onChange={v => firstDetailer && updateBlockParam(firstDetailer.id, 'enable_limit', v)}
                />
              </div>
              </div>
              </div>
              {/* Output — 产出落盘 */}
              <div style={styles.dockGroup}>
              <div style={styles.dockGtitle}>Output</div>
              <div style={styles.dockGbody}>
              <div style={styles.paramRow}
                title="开 = 这一趟的最终产出另外存一张 PNG 到 ComfyUI 的 outputs 文件夹（detailer_00001_.png 递增命名）——整幅 Run 和图层 Generate 都算「这一趟的最终产出」，落不落盘只看这颗开关，不分流。图里带和 SnapshotPromptNode 的 Cache 完全同形的 prompt 编码（prompt / prompts / lora / prefab / program / custom_prompts / prompt_parsing / filter_* / region），所以这张图能被 Prompt 节点的 Load From Image 原样读回；其中 prompt 一项编的是这次真正生效的用户选择（标签 / 自定义 / prefab 文本——不含 pipeline 自带的 prompt，也不含 lora 触发词：触发词由 lora 条目自己提供，读回后不会重复；Generate Text 的改写只属于那一趟采样，同样不编入），其余各项编的是这次真正生效的合并选择（链里没有 Prompt/Query 块时就是 Prompt 节点的全局选择）。关 = 结果只留在画布里，不落盘。">
                <label style={styles.paramLabel}>Enable Output</label>
                <IOSToggle
                  checked={firstDp ? (firstDp.enable_output ?? false) : false}
                  disabled={!firstDp}
                  onChange={v => firstDetailer && updateBlockParam(firstDetailer.id, 'enable_output', v)}
                />
              </div>
              </div>
              </div>
              {/* Dynamic Layer — ▶ Run 分流到框选建层自动 Generate，Dynamic Layer 是总闸 */}
              <div style={styles.dockGroup}>
              <div style={styles.dockGtitle}>Dynamic Layer</div>
              <div style={styles.dockGbody}>
              <div style={styles.paramRow}
                title="开 = 这个 preset 的 ▶ Run 不再直接跑整幅链：工作台进入框选模式，拖完框跳过分辨率弹窗直接建出 Dynamic Layer，并立刻在该层上自动 Generate（跑的就是刚点的这条链）。Esc 取消框选 = 什么也不跑。关 = ▶ Run 保持原来的整幅 Run。">
                <label style={styles.paramLabel}>Dynamic Layer</label>
                <IOSToggle
                  checked={dynLayer}
                  disabled={!firstDp}
                  onChange={v => firstDetailer && updateBlockParam(firstDetailer.id, 'enable_dynamic_layer', v)}
                />
              </div>
              <div style={{ opacity: dynLayer ? 1 : 0.4, pointerEvents: dynLayer ? 'auto' : 'none' }}>
              <div style={styles.paramRow}
                title="开 = 建层分辨率自动按 DEFAULT SETTING 的 Pixels 预算算（rate = √(Pixels ÷ 框面积)，与分辨率弹窗里的 Limit 勾选同一公式）。关 = rate 1，层按框的原生像素建。仅 Dynamic Layer 开时生效。">
                <label style={styles.paramLabel}>Layer Limit</label>
                <IOSToggle
                  checked={firstDp ? (firstDp.dynamic_layer_limit ?? true) : true}
                  disabled={!dynLayer}
                  onChange={v => firstDetailer && updateBlockParam(firstDetailer.id, 'dynamic_layer_limit', v)}
                />
              </div>
              <div style={styles.paramRow}
                title="开 = 自动 Generate 用框下方所有图层的合成当 context（img2img）。关 = 新层是空的，context 落到该层分辨率上的噪声（框内纯 txt2img）。仅 Dynamic Layer 开时生效。">
                <label style={styles.paramLabel}>Layer Context</label>
                <IOSToggle
                  checked={firstDp ? (firstDp.dynamic_layer_ctx ?? true) : true}
                  disabled={!dynLayer}
                  onChange={v => firstDetailer && updateBlockParam(firstDetailer.id, 'dynamic_layer_ctx', v)}
                />
              </div>
              </div>
              </div>
              </div>
                </div>
              </>),
              blocks: (<>
                <div style={styles.dockCard}>
              {blocks.map((block, blockIdx) => (
                <div key={block.id}
                  // 整张卡都是落点，不是只有那颗 28px 的六点把手：把手是**拖起处**，人把块拖到
                  // 目标卡片上松手时压的是卡身 —— 只有把手接 drop 的那一版，松手落在卡身上就是
                  // "未授权的拖拽"（最后一次 dragenter/dragover 没被取消），浏览器直接取消整个
                  // 手势，drop 不派发，看上去就是"重排序失效"。dragenter 与 dragover 同判，
                  // 进入即授权（与 dock 的 BlockBox 同一条经验，见 DockView 的 onDragIn）。
                  // 载荷认**纯 text/plain**：块重排的 dragstart 只写这一种 MIME。dock 搬窗口
                  // （application/x-dock-units + text/plain）、块套拖动（x-blockset）、文件、
                  // 视频资产都带着别的类型 —— types 不止一种就原样放行，不抢它们的地盘。
                  onDragEnter={acceptBlockDrop}
                  onDragOver={acceptBlockDrop}
                  onDrop={(e) => {
                    if (!e.dataTransfer.types.includes(BLOCK_DND_MIME)) return;
                    e.preventDefault(); e.stopPropagation();
                    const from = parseInt(e.dataTransfer.getData(BLOCK_DND_MIME));
                    if (!isNaN(from)) onReorderBlocks(from, blockIdx);
                  }}
                  style={{
                  background: 'rgba(255,255,255,0.03)',
                  borderRadius: 10,
                  marginBottom: 8,
                  border: '0.5px solid rgba(255,255,255,0.08)',
                  overflow: 'hidden',
                }}>
                  {/* Block header: drag handle + centered title + actions */}
                  <div style={{
                    display: 'flex', alignItems: 'center', height: 32,
                    borderBottom: '0.5px solid rgba(255,255,255,0.06)',
                  }}>
                    {/* Drag handle */}
                    <div
                      draggable
                      onDragStart={(e) => { e.dataTransfer.setData(BLOCK_DND_MIME, String(blockIdx)); e.dataTransfer.effectAllowed = 'move'; }}
                      onDragOver={acceptBlockDrop}
                      onDrop={(e) => {
                        if (!e.dataTransfer.types.includes(BLOCK_DND_MIME)) return;
                        e.preventDefault(); e.stopPropagation();
                        const from = parseInt(e.dataTransfer.getData(BLOCK_DND_MIME));
                        if (!isNaN(from)) onReorderBlocks(from, blockIdx);
                      }}
                      title="Drag to reorder"
                      style={{
                        width: 28, height: '100%', flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'grab', color: 'rgba(255,255,255,0.2)',
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><circle cx="3" cy="3" r="1.3"/><circle cx="9" cy="3" r="1.3"/><circle cx="3" cy="6" r="1.3"/><circle cx="9" cy="6" r="1.3"/><circle cx="3" cy="9" r="1.3"/><circle cx="9" cy="9" r="1.3"/></svg>
                    </div>
                    {/* Centered title. For a Query card the name doubles as the hint's host. */}
                    <span title={block.type === 'query' ? QUERY_BLOCK_HINT : undefined} style={{
                      flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    }}>
                      <span style={{ width: 7, height: 7, borderRadius: 999, flexShrink: 0, background: BLOCK_TINT[block.type] || '#bf5af2' }} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.82)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{block.name}</span>
                    </span>
                    {ifaceIsMissing(block) && (
                      <span title="The bound interface no longer exists — this block will be bypassed at run time"
                        style={{
                          background: 'rgba(255,159,10,0.2)', color: '#ff9f0a', borderRadius: 999,
                          fontSize: 9.5, fontWeight: 700, padding: '1px 7px', flexShrink: 0,
                        }}>Missing</span>
                    )}
                    {/* Action buttons */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 2, width: 28, flexShrink: 0, justifyContent: 'center' }}>
                      {blocks.length > 1 && (
                        <button title="Remove" style={{ background: 'none', border: 'none', color: 'rgba(255,90,90,0.5)', cursor: 'pointer', fontSize: 13, padding: '2px 4px', lineHeight: 1 }}
                          onClick={() => onRemoveBlock(block.id)}>✕</button>
                      )}
                    </div>
                  </div>
                  {/* Block params */}
                  <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {block.type === 'prompt' && renderPresetBinding(block, 'Which shared prompt preset this block injects')}
                    {block.type === 'tagger' && (() => {
                      const tp = block.params as TaggerBlockParams;
                      return (
                        <div style={styles.paramRow}
                          title="Mask Tag：裁出 mask 区域打标。Covered Tag：mask 区域合成到白底打标。Full Tag：整图打标。
                                 Mask/Covered 在链中该位置没有 mask 会报错中止整条链。tag 追加到 prompt，只影响其后的 detailer。">
                          <label style={styles.paramLabel}>Mode</label>
                          <select style={styles.paramSelect} value={tp.mode ?? 'full'} onChange={e => updateBlockParam(block.id, 'mode', e.target.value)}>
                            <option value="mask" style={{ background: '#1c1c1e', color: '#fff' }}>Mask Tag</option>
                            <option value="covered" style={{ background: '#1c1c1e', color: '#fff' }}>Covered Tag</option>
                            <option value="full" style={{ background: '#1c1c1e', color: '#fff' }}>Full Tag</option>
                          </select>
                        </div>
                      );
                    })()}
                    {block.type === 'scale' && (() => {
                      const sp = block.params as ScaleBlockParams;
                      const followPipeline = sp.use_pipeline_align ?? true;
                      return (<>
                        <div style={styles.paramRow}
                          title="比例缩放：链上此刻的工作图宽高各自乘这个倍率，再就近吸附到 Align 像素格。>1 放大，<1 缩小；1 = 只落格不缩放。只影响它后面的 block（后续 detailer 按缩放后的分辨率采样）；收尾仍按 Recover 契约落回画布。">
                          <label style={styles.paramLabel}>Scale</label>
                          <input style={styles.paramInput} type="number" min={0.01} max={16} step={0.01}
                            value={sp.scale ?? 1.0}
                            onChange={e => updateBlockParam(block.id, 'scale', parseFloat(e.target.value))} />
                        </div>
                        <div style={styles.paramRow}
                          title="开：沿用 pipeline 的 Align（DEFAULT SETTING 的那一颗，与链首同一来源；QwenImage2.1 自动抬到 32）。关：用块自己的 Align。">
                          <label style={styles.paramLabel}>Use Pipeline Align</label>
                          <IOSToggle checked={followPipeline}
                            onChange={v => updateBlockParam(block.id, 'use_pipeline_align', v)} />
                        </div>
                        {!followPipeline && (
                          <div style={styles.paramRow}
                            title="缩放后的宽高就近吸附到这个像素格（语义同 DEFAULT SETTING 的 Align / limit_pixels）。QwenImage2.1 会自动抬到 32（vision/latent 网格）。">
                            <label style={styles.paramLabel}>Align</label>
                            <input style={styles.paramInput} type="number" min={1} max={64} step={1}
                              value={sp.align ?? 8}
                              onChange={e => updateBlockParam(block.id, 'align', parseInt(e.target.value) || 1)} />
                          </div>
                        )}
                      </>);
                    })()}
                    {block.type === 'query' && (() => {
                      const qp = block.params as QueryBlockParams;
                      const bound = !!qp.preset_id;
                      return (<>
                        {renderPresetBinding(block, 'Query 弹窗的初始勾选来自这个 preset（与 prompt 块共用同一份）')}
                        <div style={styles.paramRow}
                          title={bound
                            ? '开：Confirm 时把弹窗里的最终选择整体写回绑定的 preset，下次 run / 下次打开弹窗就是它。关：本次修改只活在当前 run 里。'
                            : '先绑定 preset 才能持久化 —— 没有 preset 就没有可写回的地方。'}>
                          <label style={styles.paramLabel}>Persistent</label>
                          <IOSToggle checked={bound && !!qp.persistent} disabled={!bound}
                            onChange={v => updateBlockParam(block.id, 'persistent', v)} />
                        </div>
                      </>);
                    })()}
                    {block.type === 'detailer' && (() => {
                      const dp = block.params as DetailerBlockParams;
                      return (<>
                        <div style={styles.paramRow}
                          title="Random：按采样步数加随机噪声。None：不加噪，从干净 latent 直接进梯子。Invert：不加随机噪声，而是先把本块那截梯子倒着爬回 σ_peak（DDIM 反演），再顺原路解回来——爬出来的就是“这张图配的那份噪声”，往返整段走 euler。">
                          <label style={styles.paramLabel}>Add Noise</label>
                          <select style={styles.paramSelect} value={dp.add_noise} onChange={e => updateBlockParam(block.id, 'add_noise', e.target.value)}>
                            <option value="enable" style={{ background: '#1c1c1e', color: '#fff' }}>Random</option>
                            <option value="disable" style={{ background: '#1c1c1e', color: '#fff' }}>None</option>
                            <option value="invert" style={{ background: '#1c1c1e', color: '#fff' }}>Invert</option>
                          </select>
                        </div>
                        <div style={styles.paramRow}>
                          <label style={styles.paramLabel}>Ctx Regex</label>
                          <input
                            style={styles.paramInput}
                            type="text"
                            value={dp.context_regex ?? '.+'}
                            placeholder=".+"
                            onChange={e => updateBlockParam(block.id, 'context_regex', e.target.value || '.+')}
                          />
                        </div>
                        <div style={styles.paramRow}>
                          <label style={styles.paramLabel}>Start Step</label>
                          <input style={styles.paramInput} type="number" min={0} max={1} step={0.01} value={dp.start_step_rate} onChange={e => updateBlockParam(block.id, 'start_step_rate', parseFloat(e.target.value))} />
                        </div>
                        <div style={styles.paramRow}>
                          <label style={styles.paramLabel}>End Step</label>
                          <input style={styles.paramInput} type="number" min={0} max={1} step={0.01} value={dp.end_step_rate} onChange={e => updateBlockParam(block.id, 'end_step_rate', parseFloat(e.target.value))} />
                        </div>
                        {/* Enable Edit 放在 Enable Text Generate 前面（用户指定顺序） */}
                        <div style={styles.paramRow} title="Ref images come from the Extra Prompt text (<image_id:...> tokens inserted from the Blend workbench staging strip). Context image is always <image 1>.">
                          <label style={styles.paramLabel}>Enable Edit</label>
                          <IOSToggle checked={dp.enable_edit} onChange={v => updateBlockParam(block.id, 'enable_edit', v)} />
                        </div>
                        <div style={styles.paramRow} title="块级 Generate Text 开关（默认关）：仅当上游 pipeline 也启用了 Generate Text（PipelineEnableGenerateTextNode）时才生效；生成结果只作用于当前块，不向后续块传递。">
                          <label style={styles.paramLabel}>Enable Text Generate</label>
                          <IOSToggle checked={dp.enable_text_generate ?? false} onChange={v => updateBlockParam(block.id, 'enable_text_generate', v)} />
                        </div>
                        {(dp.enable_text_generate ?? false) && (
                          <>
                            <div style={styles.paramRow} title="开启后本块 Generate Text 的指令用下方输入框的内容临时替代 PipelineEnableGenerateTextNode 的 prompt 参与运算（留空 = 空指令，positive 原样进 CLIP）；仅在本块 Enable Text Generate 生效时有意义。">
                              <label style={styles.paramLabel}>Override Prompt</label>
                              <IOSToggle checked={dp.enable_override_prompt ?? false} onChange={v => updateBlockParam(block.id, 'enable_override_prompt', v)} />
                            </div>
                            {(dp.enable_override_prompt ?? false) && (
                              <div style={styles.paramRow} title="重载的 Generate Text 指令：临时替代 PipelineEnableGenerateTextNode 中的 prompt 参数。留空 = 空指令。">
                                <textarea
                                  style={{ ...styles.paramInput, resize: 'vertical', minHeight: 56, fontFamily: 'inherit' }}
                                  rows={3}
                                  placeholder="Override instruction (empty = no instruction)"
                                  value={dp.override_prompt ?? ''}
                                  onChange={e => updateBlockParam(block.id, 'override_prompt', e.target.value)}
                                />
                              </div>
                            )}
                          </>
                        )}
                        {dp.enable_edit && (
                          <div style={styles.editSubSection}>
                            {isKrea2 && (
                              <div style={styles.paramRow}>
                                <label style={styles.paramLabel}>Edit Mode</label>
                                <select
                                  style={styles.paramSelect}
                                  value={dp.edit_mode ?? 'fit'}
                                  title="fit: 整图适配目标网格 + stride-1 位置 ID（训练匹配几何，防模糊）。crop: center-crop 到目标宽高比（适合源/目标 AR 差距大的场景）。"
                                  onChange={e => updateBlockParam(block.id, 'edit_mode', e.target.value)}
                                >
                                  <option value="fit" style={{ background: '#1c1c1e', color: '#fff' }}>fit</option>
                                  <option value="crop" style={{ background: '#1c1c1e', color: '#fff' }}>crop</option>
                                </select>
                              </div>
                            )}
                            {isKrea2 && (
                              <>
                                <div style={styles.paramRow}>
                                  <label style={styles.paramLabel}>Grounding Px</label>
                                  <input style={styles.paramInput} type="number" min={0} max={2048} step={64}
                                    title="Grounded encode 的 VLM 看图分辨率上限（正/负提示词共用同一源图缩放）。更高 = 更清晰的语义理解但更多 vision tokens / 显存; 0 = 不限制。"
                                    value={dp.grounding_px ?? 768}
                                    onChange={e => updateBlockParam(block.id, 'grounding_px', parseInt(e.target.value) || 0)} />
                                </div>
                                <div style={styles.paramRow}>
                                  <label style={styles.paramLabel}>Ref Boost</label>
                                  <input style={styles.paramInput} type="number" min={0} max={1000} step={0.1}
                                    title="参考保真度: 最后一个参考（源图）的 target->ref 注意力乘数。>1 拉向参考外观, <1 放松。最优值因模型而异。"
                                    value={dp.ref_boost ?? 4.0}
                                    onChange={e => updateBlockParam(block.id, 'ref_boost', parseFloat(e.target.value) || 0)} />
                                </div>
                                <div style={styles.paramRow}>
                                  <label style={styles.paramLabel}>Ref Boost A</label>
                                  <input style={styles.paramInput} type="number" min={0} max={1000} step={0.1}
                                    title="第一个参考（场景, 仅多参考如 Context Ref 时生效）的注意力乘数。单参考工作流无效果。"
                                    value={dp.ref_boost_a ?? 1.0}
                                    onChange={e => updateBlockParam(block.id, 'ref_boost_a', parseFloat(e.target.value) || 0)} />
                                </div>
                                <div style={styles.paramRow} title="启用后以 context mask（当前块裁剪区 mask）限定 ref_boost 增强区域 — 仅 mask 内的参考 token 被增强, 保护 mask 外区域。">
                                  <label style={styles.paramLabel}>Ref Boost Mask</label>
                                  <IOSToggle checked={dp.enable_ref_boost_mask ?? false}
                                    onChange={v => updateBlockParam(block.id, 'enable_ref_boost_mask', v)} />
                                </div>
                              </>
                            )}
                            {/* Ref Image 不再逐块手选：Blend 工作台 Extra Prompt 文本里的
                                <image_id:...> 标记在 Run 时统一解析（context 图恒为
                                <image 1>，引用图按出现顺序 = <image 2>+），所有 detailer
                                block 共用这一组参考图。说明在 Enable Edit 的 tooltip 里。 */}
                          </div>
                        )}
                      </>);
                    })()}
                    {block.type === 'interface' && (() => {
                      const ip = block.params as any;
                      // 只列开了 Block 模式的 interface（Interface tab 里的开关决定谁上得了链）。
                      // meta 里还没有标注的旧 interface 保持原判定（1 pipeline 进 + 1 pipeline 出），
                      // 免得存量 chain 在刷新后突然全部 Missing。
                      const isBlockCapable = (itf: any) => {
                        const meta = interfaceMeta[itf?.name];
                        if (meta?.modes) return !!meta.modes.block;
                        const inP = itf?.start_ports?.filter((p: any) => p.type === 'PIPELINE_DATA')?.length ?? 0;
                        const outP = itf?.end_ports?.filter((p: any) => p.type === 'PIPELINE_DATA')?.length ?? 0;
                        return inP === 1 && outP === 1;
                      };
                      const selectableInterfaces = interfaces.filter(isBlockCapable);
                      const safeInterfaces = selectableInterfaces.length > 0 ? selectableInterfaces : interfaces;
                      const updateIfaceParam = (key: string, value: any) => updateBlockParam(block.id, key, value);
                      // 绑定以名字为准（接口包重排/增删不会错绑到别的接口）；旧配置只有
                      // interface_idx，尽量解析成名字；解析不出 = Missing（运行时自动 bypass）。
                      const boundName: string | null = ip.interface_name ?? null;
                      const boundMissing = !!boundName && interfaces.length > 0 && !interfaces.some(i => i.name === boundName);
                      const resolvedIdx = boundName
                        ? interfaces.findIndex(i => i.name === boundName)
                        : (interfaces.length > 0 ? (ip.interface_idx ?? -1) : -1);
                      const resolvedItf = resolvedIdx >= 0 ? interfaces[resolvedIdx] : undefined;
                      const iface = resolvedItf ?? safeInterfaces[0];
                      const opt = { background: '#1c1c1e', color: '#fff' } as React.CSSProperties;
                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' }}>
                          {selectableInterfaces.length === 0 && (
                            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
                              No interface with Block mode on — enable it in the Interface tab.
                            </div>
                          )}
                          {/* Interface sub-graph selection */}
                          <div style={styles.paramRow}>
                            <span style={styles.paramLabel}>Interface</span>
                            <select
                              style={{ ...styles.paramSelect, ...(boundMissing ? { borderColor: 'rgba(255,159,10,0.6)' } : {}) }}
                              value={boundMissing ? '__missing__' : (resolvedItf ? String(interfaces.indexOf(resolvedItf)) : '')}
                              onChange={e => {
                                const idx = parseInt(e.target.value, 10);
                                const itf = interfaces[idx];
                                if (!itf) return;
                                updateIfaceParam('interface_name', itf.name);
                                updateIfaceParam('interface_idx', idx);
                              }}
                            >
                              {boundMissing && <option value="__missing__" style={opt}>Missing: {boundName}</option>}
                              {safeInterfaces.map((itf, idx) => (
                                <option key={idx} value={String(interfaces.indexOf(itf))} style={opt}>{itf.name || `Interface ${idx + 1}`}</option>
                              ))}
                            </select>
                          </div>
                          {/* Operation + crop_reserve */}
                          <div style={styles.paramRow}>
                            <span style={styles.paramLabel}>Operation</span>
                            <select
                              style={styles.paramSelect}
                              value={ip.operation ?? 'default'}
                              onChange={e => updateIfaceParam('operation', e.target.value)}
                            >
                              <option value="default" style={opt}>default</option>
                              <option value="crop" style={opt}>crop</option>
                            </select>
                            {ip.operation === 'crop' && (
                              <input
                                style={{ ...styles.paramInput, width: 64, flex: 'none' }}
                                type="number"
                                min={0}
                                value={ip.crop_reserve ?? 32}
                                onChange={e => updateIfaceParam('crop_reserve', parseInt(e.target.value, 10) || 0)}
                              />
                            )}
                          </div>
                          {/* Per-port image selection from staging (exclude auto-injected PIPELINE_DATA input) */}
                          {iface?.start_ports?.filter((p: any) => p.category === 'inject' && p.type !== 'PIPELINE_DATA').map((port: any) => (
                            <div style={styles.paramRow} key={port.num}>
                              <span style={styles.paramLabel}>{port.name || `Port ${port.num}`}</span>
                              <select
                                style={styles.paramSelect}
                                value={(ip.image_keys && ip.image_keys[port.num]) || ''}
                                onChange={e => {
                                  const cur = { ...(ip.image_keys || {}) };
                                  if (e.target.value) cur[port.num] = e.target.value;
                                  else delete cur[port.num];
                                  updateIfaceParam('image_keys', cur);
                                }}
                              >
                                <option value="" style={opt}>(none)</option>
                                {staging.map((s, hi) => (
                                  <option key={hi} value={s.id} style={opt}>{s.name} ({s.id})</option>
                                ))}
                              </select>
                            </div>
                          ))}
                          {/* Optional context image / mask (defaults to pipeline flow) */}
                          <div style={styles.paramRow}>
                            <span style={styles.paramLabel}>Ctx Image</span>
                            <select
                              style={styles.paramSelect}
                              value={ip.context_image_key || ''}
                              onChange={e => updateIfaceParam('context_image_key', e.target.value || null)}
                            >
                              <option value="" style={opt}>(use pipeline)</option>
                              {staging.map((s, hi) => (
                                <option key={hi} value={s.id} style={opt}>{s.name} ({s.id})</option>
                              ))}
                            </select>
                          </div>
                          {ip.context_image_key && (() => {
                            const img = staging.find((s) => s.id === ip.context_image_key);
                            return img ? (
                              <div style={{ padding: '0 0 4px 88px' }}>
                                <img src={img.src} alt={img.name}
                                  style={{ maxWidth: '100%', maxHeight: 120, borderRadius: 8, border: '0.5px solid rgba(255,255,255,0.12)', display: 'block' }} />
                              </div>
                            ) : null;
                          })()}
                          <div style={styles.paramRow}>
                            <span style={styles.paramLabel}>Ctx Mask</span>
                            <select
                              style={styles.paramSelect}
                              value={ip.context_mask_key || ''}
                              onChange={e => updateIfaceParam('context_mask_key', e.target.value || null)}
                            >
                              <option value="" style={opt}>(use pipeline)</option>
                              {staging.map((s, hi) => (
                                <option key={hi} value={s.id} style={opt}>{s.name} ({s.id})</option>
                              ))}
                            </select>
                          </div>
                          {ip.context_mask_key && (() => {
                            const img = staging.find((s) => s.id === ip.context_mask_key);
                            return img ? (
                              <div style={{ padding: '0 0 4px 88px' }}>
                                <img src={img.src} alt={img.name}
                                  style={{ maxWidth: '100%', maxHeight: 120, borderRadius: 8, border: '0.5px solid rgba(255,255,255,0.12)', display: 'block' }} />
                              </div>
                            ) : null;
                          })()}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              ))}
                </div>
              </>),
            },
            // 几格自带的动作条（Clear All / Add / Undo / Redo）：dock 把它们画在各自正文下面、滚动条之外。
            foots: {
              ...workbenchFoots(uiSend, wbHost),
              // Pipeline Blocks 的 Add：住进正文下面的动作条，和 Layers 那一格同一个范式（见 MEMORY
              // 的"动作条范式"）—— 标题条是窗口级动作的地方（关窗/浮出/折叠），往链里加块是**内容**
              // 动作，挤在 26px 的标题条里既和 ✕/⤢ 抢点击区，菜单还只能往下翻、被块的圆角剪掉。
              // 摆法照抄 Layers 的 StackHead：右对齐一颗 mini-btn，菜单从它**往上**翻。
              blocks: (
                <div className="mini-group">
                  <button type="button" className="mini-btn" aria-haspopup="menu" aria-expanded={!!addMenu}
                    title="Append a block to this chain — Detailer / Interface / Prompt / Query / Tagger / Scale"
                    onClick={e => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      // 与 Layers 头部那颗 Add 同两句：右缘对齐 216px 的菜单、从锚点上沿往上翻。
                      setAddMenu(addMenu ? null : { x: r.right - 216, y: r.top });
                    }}>
                    Add<span className="add-caret">▾</span>
                  </button>
                  {addMenu && (
                    <ContextMenu x={addMenu.x} y={addMenu.y} up onClose={() => setAddMenu(null)}
                      items={ADD_BLOCK_KINDS.map(opt => ({
                        label: opt.label, color: opt.color, hint: opt.hint, onClick: () => onAddBlock(opt.kind),
                      }))} />
                  )}
                </div>
              ),
            },
          }} />

          {/* ── the live workbench ──
              One frame, always mounted, pinned over whichever window holds the active document. It is
              NOT rendered into that window: an <iframe> that changes parent reloads, and a reload throws
              every open project out with it. So the dock gives up the box's rect and this layer wears
              it — which is also why a folded or tabbed-away active window parks the frame off-screen
              instead of hiding it (hidden would leave the workbench running blind; unmounted would kill
              it). While a unit is being dragged the frame stops eating the pointer and fades back: an
              iframe is a separate document, so dragover never bubbles out of it and the landing bands
              the dock draws underneath would be invisible behind a full-opacity canvas. */}
          <div style={{
            ...styles.frameLayer,
            left: frameRect?.x ?? -12000, top: frameRect?.y ?? -12000,
            width: frameRect?.w ?? 900, height: frameRect?.h ?? 640,
            // toolbar 小窗里那一格要是活的那份文档，画布这一层就得压在小窗之上：小窗是 75，
            // 画布这一层因此提到 76 —— 否则小窗里只能看见一块深色底（活的工作台被盖在下面）。
            zIndex: tbPopover && tbPopover === activeUnit ? 76 : activeIsWindow ? 61 : 5,
            opacity: frameRect && !dockDrag ? 1 : 0,
            pointerEvents: dockDrag ? 'none' : undefined,
          }}>
            <iframe
              ref={blendIframeRef}
              src="/blend_node.html"
              style={styles.blendFrame}
              title="Blend"
              allow="clipboard-write"
              onLoad={() => applyPreviewTint(previewTint)}
              onMouseEnter={() => {
                // Keyboard shortcuts inside the workbench (notably the Ctrl mask reveal, and
                // Ctrl+Z / Esc) only fire when the iframe document holds focus — the iframe owns
                // its own window, so a host-level key listener never sees its keys. Focus drifts
                // out to the surrounding controls constantly, and then the modifier keys silently
                // stop working. Handing focus back the moment the pointer enters the frame keeps
                // focus in sync with where the user is actually working.
                // Guarded so it never steals focus from an open dialog.
                if (document.activeElement?.tagName === 'INPUT') return;
                blendIframeRef.current?.contentWindow?.focus();
              }}
            />
          </div>
        </div>

        {/* Interface — package-driven sub-graph execution */}
        {tab === 'interface' && (
          <InterfaceTab interfaces={interfaces} interfaceMeta={interfaceMeta} onChangeInterfaceMeta={onChangeInterfaceMeta} />
        )}

        {/* Settings — DEFAULT SETTING 九格 + 按 architecture 正则命中的覆盖规则 */}
        {tab === 'settings' && (
          <SettingsTab
            values={{
              mask_grow: maskGrow, mask_blur: maskBlur, crop_reserve: cropReserve,
              pixels: pixelsVal, align: alignVal,
              ref_pixels: refPixelsVal, ref_align: refAlignVal,
              tgen_pixels: tgenPixelsVal, tgen_align: tgenAlignVal,
            }}
            onDefaultParamChange={onDefaultParamChange}
            archSettings={archSettings}
            onArchSettingsChange={onArchSettingsChange}
            onAddArchRule={onAddArchRule}
            onDuplicateArchRule={onDuplicateArchRule}
            onRemoveArchRule={onRemoveArchRule}
            onReorderArchRules={onReorderArchRules}
            openWithApp={openWithApp}
            onOpenWithAppChange={onOpenWithAppChange}
          />
        )}
      </div>

      {/* Prompt preset editor — the FULL prompt_node UI in preset scope. Its selection is
          saved to the SHARED preset (persisted server-side); every block referencing that
          preset picks it up, injected only for the detailers after that block in a run. */}
      {editingPromptBlockId && (() => {
        const blk = blocks.find(b => b.id === editingPromptBlockId);
        const pid = blk ? (blk.params as PromptBlockParams).preset_id : null;
        const preset = pid ? promptPresets.find(p => p.id === pid) : null;
        if (!pid) return null;
        const params = 'sampler_base=' + encodeURIComponent(window.location.origin)
          + '&scope=prompt_preset&preset_id=' + encodeURIComponent(pid);
        const src = (promptUrl || '/prompt_node.html') + (promptUrl.includes('?') ? '&' : '?') + params;
        return (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }} onClick={() => setEditingPromptBlockId(null)}>
            <div style={{
              width: '94vw', height: '92vh', background: '#0d0d0d', borderRadius: 14,
              border: '0.5px solid rgba(255,255,255,0.12)', display: 'flex', flexDirection: 'column',
              overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
            }} onClick={(e) => e.stopPropagation()}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 16px', flexShrink: 0, borderBottom: '0.5px solid rgba(255,255,255,0.08)',
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#64d2ff' }}>
                  Prompt Preset — {preset?.name || pid}
                  <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.45)', marginLeft: 8 }}>
                    共享持久化 · 引用它的块随改随生效
                  </span>
                </div>
                <button
                  style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}
                  title="Close"
                  onClick={() => setEditingPromptBlockId(null)}
                >✕</button>
              </div>
              <iframe
                src={src}
                title="Prompt preset editor"
                style={{ flex: 1, minHeight: 0, width: '100%', border: 'none', background: '#0d0d0d' }}
              />
            </div>
          </div>
        );
      })()}

      {/* Preset → pipeline binding (the gear on a preset row). Names, not indexes: the backend
          resolves a preset's pipeline at run time by name, so a package that grew or shrank cannot
          silently rebind it — and a name that no longer resolves reads as Missing here and fails the
          run loudly instead of quietly reusing the previous pipeline. */}
      {presetPipelineFor && (() => {
        const target = blockSets.find(s => s.id === presetPipelineFor);
        if (!target) return null;
        const bound = target.pipeline_name || '';
        const boundNamed = !!bound && bound !== PIPELINE_CURRENT_SELECT;
        const boundMissing = pipelineIsMissing(bound);
        return (
          <div style={styles.overlay} onClick={() => setPresetPipelineFor(null)}>
            <div style={{ ...styles.dialog, width: 380 }} onClick={e => e.stopPropagation()}>
              <div style={styles.dialogTitle}>Pipeline — {target.name}</div>
              <div style={styles.dialogSubtitle}>
                {PIPELINE_CURRENT_SELECT} runs this preset on whatever is loaded now, so no pipeline is
                reloaded. Picking a named one loads it first — only when it is not the one already in
                memory, because that load re-runs the whole upstream graph.
              </div>
              <select
                style={{ ...styles.paramSelect, width: '100%' }}
                value={bound || PIPELINE_CURRENT_SELECT}
                onChange={e => onSetPresetPipeline(target.id, e.target.value)}
              >
                <option value={PIPELINE_CURRENT_SELECT} style={{ background: '#1c1c1e' }}>
                  {PIPELINE_CURRENT_SELECT}{loadedPipelineName ? ` (${loadedPipelineName})` : ''}
                </option>
                {pipelineNames.map(n => (
                  <option key={n} value={n} style={{ background: '#1c1c1e' }}>{n}</option>
                ))}
                {boundNamed && !pipelineNames.includes(bound) && (
                  <option value={bound} style={{ background: '#1c1c1e' }}>
                    {bound} — {pipelinePackages.length > 0 ? 'Missing' : '(not loaded)'}
                  </option>
                )}
              </select>
              {boundMissing && (
                <div style={{ marginTop: 10, fontSize: 12, fontWeight: 600, color: '#ff9f0a' }}>
                  Missing — this pipeline is gone from the connected package. Running 「{target.name}」
                  stops with an error until it is rebound.
                </div>
              )}
              <div style={styles.dialogActions}>
                <button style={styles.confirmBtn} onClick={() => setPresetPipelineFor(null)}>Done</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Query dialog — a run is parked on a Query block and waits for this answer. The
          prompt UI opens in query scope: bound to a preset it starts from that preset's
          selection (the iframe fetches it like the preset editor does), unbound it starts
          EMPTY. Either way it hands the RAW selection to the host, which forwards it to the
          backend (the merge and the programs happen there). Closing it cancels, and
          cancelling aborts the whole chain. */}
      {pendingQuery && (() => {
        const qPresetId = pendingQuery.preset_id || '';
        const qPreset = qPresetId ? promptPresets.find(p => p.id === qPresetId) : null;
        const qParams = 'sampler_base=' + encodeURIComponent(window.location.origin) + '&scope=query'
          + (qPresetId ? '&preset_id=' + encodeURIComponent(qPresetId) : '');
        const qSrc = (promptUrl || '/prompt_node.html') + (promptUrl.includes('?') ? '&' : '?') + qParams;
        return (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 1001,
            background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{
              width: '94vw', height: '92vh', background: '#0d0d0d', borderRadius: 14,
              border: '0.5px solid rgba(255,255,255,0.12)', display: 'flex', flexDirection: 'column',
              overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 16px', flexShrink: 0, borderBottom: '0.5px solid rgba(255,255,255,0.08)',
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#ffd60a' }}>
                  Query — {pendingQuery.name}
                  <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.45)', marginLeft: 8 }}>
                    {qPreset ? `preset「${qPreset.name}」${pendingQuery.persistent ? ' · Persistent：Confirm 后写回' : ' · 仅本次'} · ` : ''}
                    挑好 prompt 后 Confirm 继续；关闭 = 中止整条链
                  </span>
                </div>
                <button
                  style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}
                  title="Cancel — aborts the whole chain"
                  onClick={() => onQueryCancel()}
                >✕</button>
              </div>
              <iframe
                src={qSrc}
                title="Query prompt"
                style={{ flex: 1, minHeight: 0, width: '100%', border: 'none', background: '#0d0d0d' }}
              />
            </div>
          </div>
        );
      })()}

      {/* Finish dialog — left preview + right card grid with hover */}
      {showFinishDialog && (
        <div style={styles.overlay}>
          <div style={{ ...styles.dialog, width: '80vw', maxWidth: 1000, padding: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '20px 24px 12px', flexShrink: 0 }}>
              <div style={styles.dialogTitle}>Select Final Images</div>
              <div style={styles.dialogSubtitle}>Hover to preview, click to select ({selectedKeys.size} selected)</div>
            </div>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row', gap: 0 }}>
              {/* Left: large preview */}
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 16, gap: 8, background: '#0d0d0d', borderRadius: '12px 0 0 0' }}>
                {(hoveredFinish || staging.find(s => selectedKeys.has(s.id))) ? (
                  <>
                    <img src={(hoveredFinish || staging.find(s => selectedKeys.has(s.id)))!.src} alt={(hoveredFinish || staging.find(s => selectedKeys.has(s.id)))!.name} style={{ maxWidth: '100%', maxHeight: 'calc(100% - 40px)', objectFit: 'contain', borderRadius: 12 }} />
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>{(hoveredFinish || staging.find(s => selectedKeys.has(s.id)))!.name}</div>
                  </>
                ) : (
                  <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 14 }}>Hover over a card to preview</div>
                )}
              </div>
              {/* Right: card grid */}
              <div style={{ width: 420, flexShrink: 0, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignContent: 'flex-start' }}>
                  {staging.map(s => (
                    <button
                      key={s.id}
                      style={{
                        ...styles.historyCard,
                        borderColor: selectedKeys.has(s.id) ? '#0a84ff'
                          : (hoveredFinish?.id === s.id ? 'rgba(10,132,255,0.4)' : 'rgba(255,255,255,0.08)'),
                        boxShadow: selectedKeys.has(s.id) ? '0 0 0 2px rgba(10,132,255,0.3)' : 'none',
                      }}
                      onMouseEnter={() => setHoveredFinish(s)}
                      onClick={() => toggleFinishSelection(s.id)}
                    >
                      <div style={styles.historyImgWrap}>
                        <img src={s.src} alt={s.name} style={styles.historyImg} />
                        {selectedKeys.has(s.id) && (
                          <div style={styles.historyCheck}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M5 13l4 4L19 7" />
                            </svg>
                          </div>
                        )}
                      </div>
                      <div style={styles.historyName}>{s.name}</div>
                    </button>
                  ))}
                </div>
                {staging.length === 0 && (
                  <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 14, padding: 20 }}>No staging items yet.</div>
                )}
              </div>
            </div>
            <div style={{ ...styles.dialogActions, padding: '12px 24px 20px', flexShrink: 0 }}>
              <button style={styles.cancelBtn} onClick={handleCloseFinishDialog}>Cancel</button>
              <button style={styles.confirmBtn} onClick={handleConfirmFinish}>Confirm</button>
            </div>
          </div>
        </div>
      )}

      {/* Debug — 上一次 Run / Generate 的全过程快照 */}
      {showDebug && <DebugModal onClose={() => setShowDebug(false)} />}
      {showLog && <LogModal entries={actionLog} onClose={() => setShowLog(false)} />}
    </div>
  );
};

// ── SettingsTab ──
// Two screens behind one iOS segmented control. DEFAULT SETTING is the nine numeric knobs every run
// starts from (they used to sit at the bottom of the Draw column); ARCHITECTURE is a list of rules —
// each one a regex matched against the architecture of the pipeline that actually runs — replacing
// some of those nine for the runs it catches. The numbers stay the host's either way: this page only
// edits what the Draw panel edited, so a value can never exist twice.
// The look is the iOS inset-grouped list — system greys, cards that fill the column, hairline
// separators inset from the label. Only this page wears it for now.
type SettingsScreen = 'default' | 'arch';
// Which screen is showing and which rule cards are open belong to the user, not to the program, so
// they are remembered per browser — same policy as the section folds and the panel width, and ONE
// key for both because they are one page's view state. An unreadable store just opens on Default.
const SETTINGS_UI_STORE = 'sampler.settingsUI';
type SettingsUI = { screen: SettingsScreen; openRules: string[] };
const loadSettingsUI = (): SettingsUI => {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_UI_STORE) || 'null');
    return {
      screen: saved?.screen === 'arch' ? 'arch' : 'default',
      openRules: Array.isArray(saved?.openRules) ? saved.openRules.filter((s: unknown) => typeof s === 'string') : [],
    };
  } catch { return { screen: 'default', openRules: [] }; }
};
const saveSettingsUI = (next: SettingsUI) => {
  try { localStorage.setItem(SETTINGS_UI_STORE, JSON.stringify(next)); } catch { /* nothing to remember */ }
};

// The nine knobs split into three cards, so the target semantics (a working resolution to reach) and
// the input ceilings (a memory cap, 0 = off) never read as one undifferentiated list.
const SETTINGS_GROUPS: { title: string; hint?: string; keys: OverrideKey[] }[] = [
  { title: 'Output Preprocessing', keys: ['mask_grow', 'mask_blur', 'crop_reserve'] },
  { title: 'Working Resolution', keys: ['pixels', 'align'] },
  { title: 'Input Ceilings', hint: '0 = no limit', keys: ['ref_pixels', 'ref_align', 'tgen_pixels', 'tgen_align'] },
];
{
  const lost = OVERRIDE_KEYS.filter(k => !SETTINGS_GROUPS.some(g => g.keys.includes(k)));
  if (lost.length) console.warn(`[Settings] OVERRIDE_KEYS in no card: ${lost.join(', ')} — they would not render`);
}

const segBtnStyle = (on: boolean): React.CSSProperties => ({
  flex: 1, padding: '5px 0', borderRadius: 6.5, border: 'none', outline: 'none', cursor: 'pointer',
  fontSize: 12.5, fontWeight: 500, background: on ? '#39393d' : 'transparent',
  color: on ? '#fff' : 'rgba(255,255,255,0.62)', boxShadow: on ? '0 1px 3px rgba(0,0,0,0.4)' : 'none',
});

const DragHandleIcon: React.FC = () => (
  <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" style={{ display: 'block' }}>
    <circle cx="2.5" cy="3" r="1.3" /><circle cx="7.5" cy="3" r="1.3" />
    <circle cx="2.5" cy="8" r="1.3" /><circle cx="7.5" cy="8" r="1.3" />
    <circle cx="2.5" cy="13" r="1.3" /><circle cx="7.5" cy="13" r="1.3" />
  </svg>
);

const SettingsTab: React.FC<{
  values: Record<OverrideKey, number>;
  onDefaultParamChange: (key: OverrideKey, value: number) => void;
  archSettings: ArchSettings;
  onArchSettingsChange: (next: ArchSettings) => void;
  onAddArchRule: () => void;
  onDuplicateArchRule: (id: string) => void;
  onRemoveArchRule: (id: string) => void;
  onReorderArchRules: (from: number, to: number) => void;
  /** Application 条目的 user preference：开 = 执行到节点时 KolidUI 不在就拉起 Kolid Desktop.exe。 */
  openWithApp: boolean;
  onOpenWithAppChange: (v: boolean) => void;
}> = ({
  values, onDefaultParamChange,
  archSettings, onArchSettingsChange, onAddArchRule, onDuplicateArchRule, onRemoveArchRule, onReorderArchRules,
  openWithApp, onOpenWithAppChange,
}) => {
  const [ruleMenu, setRuleMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [ui, setUi] = useState<SettingsUI>(loadSettingsUI);
  const pickScreen = (screen: SettingsScreen) => { const next = { ...ui, screen }; setUi(next); saveSettingsUI(next); };
  const toggleRule = (id: string) => {
    const openRules = ui.openRules.includes(id) ? ui.openRules.filter(x => x !== id) : [...ui.openRules, id];
    const next = { ...ui, openRules }; setUi(next); saveSettingsUI(next);
  };

  // A rule edits itself back into the whole list — the list, order included, IS the state.
  const patchRule = (id: string, patch: Partial<ArchRule>) => {
    onArchSettingsChange({ rules: archSettings.rules.map(r => r.id === id ? { ...r, ...patch } : r) });
  };
  const setRuleParam = (id: string, key: OverrideKey, patch: Partial<ParamOverride>) => {
    const rule = archSettings.rules.find(r => r.id === id);
    if (!rule) return;
    const cur: ParamOverride = rule.overrides[key] ?? { value: values[key], enabled: false };
    patchRule(id, { overrides: { ...rule.overrides, [key]: { ...cur, ...patch } } });
  };

  // The pattern is checked here only to flag it early; the backend skips the same two cases (empty
  // pattern, uncompilable regex) so a flagged rule simply never matches. JS and Python regex
  // dialects differ at the edges, so this is a heads-up, not a guarantee. The short string is what
  // the badge shows; the sentence is what the tooltip explains.
  const patternProblem = (raw: string): '' | 'never matches' | 'invalid regex' => {
    if (!raw.trim()) return 'never matches';
    try { new RegExp(raw, 'i'); return ''; } catch { return 'invalid regex'; }
  };
  const problemNote = (p: string) => p === 'never matches'
    ? 'Empty pattern matches nothing — this rule never applies.'
    : p === 'invalid regex' ? 'Not a valid regular expression — this rule is skipped.' : '';

  return (
    <div className="dark-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={styles.iosScreen}>
        {/* 子 tab：iOS 分段控件。选哪屏是视图状态，落 sampler.settingsUI（用户的选择，不自动跳）。 */}
        <div style={styles.iosSeg}>
          <button style={segBtnStyle(ui.screen === 'default')} onClick={() => pickScreen('default')}
            title="The nine values every run falls back to">Default Setting</button>
          <button style={segBtnStyle(ui.screen === 'arch')} onClick={() => pickScreen('arch')}
            title="Regex rules that replace some of those values for the runs they catch">Architecture</button>
        </div>

        {/* DEFAULT SETTING — 三张卡：输出前处理 / 工作分辨率 / 输入封顶。范围与说明仍出自
            DEFAULT_PARAM_META 那一张表（规则卡读同一张），这里只换外观。 */}
        {ui.screen === 'default' && SETTINGS_GROUPS.map(group => (
          <React.Fragment key={group.title}>
            <div style={styles.iosGroupTitle}>{group.title}{group.hint && <em style={styles.iosGroupHint}>{group.hint}</em>}</div>
            <div style={styles.iosCard}>
              {group.keys.map((key, i) => {
                const m = DEFAULT_PARAM_META[key];
                return (
                  <div key={key} style={i === group.keys.length - 1 ? styles.iosRow : { ...styles.iosRow, ...styles.iosRowLine }}
                    title={m.title}>
                    <span style={styles.iosLabel}>{m.label}</span>
                    <input className="ios-val" style={styles.iosNum} type="number" min={m.min} max={m.max} step={m.step}
                      value={values[key]}
                      onChange={e => onDefaultParamChange(key, parseInt(e.target.value) || 0)} />
                  </div>
                );
              })}
            </div>
          </React.Fragment>
        ))}

        {/* APPLICATION — user preference，不是数值旋钮：执行到节点时页面从哪儿弹出来。
            开 = KolidUI 不在就把 Kolid Desktop.exe 拉起来再注入；关 = 原逻辑
            （客户端在就注入标签页，不在退系统浏览器）。 */}
        {ui.screen === 'default' && (
          <>
            <div style={styles.iosGroupTitle}>Application</div>
            <div style={styles.iosCard}>
              <div style={styles.iosRow}
                title={'When a node opens its UI during a run: ON — launch Kolid Desktop and inject the page '
                  + 'as its tab when the client is not running. OFF — original behavior (inject if the client '
                  + 'is running, otherwise the system browser).'}>
                <span style={styles.iosLabel}>Open With Application</span>
                <IOSToggle checked={openWithApp} onChange={onOpenWithAppChange} />
              </div>
            </div>
          </>
        )}

        {/* ARCHITECTURE — 一张卡一条规则：卡头是把手 + 正则 + 徽章 + 折叠箭头，九排在收起时不画。 */}
        {ui.screen === 'arch' && (<>
          <div style={styles.iosGroupTitle}>Rules<em style={styles.iosGroupHint}>first match wins</em></div>
          {archSettings.rules.map((rule, idx) => {
            const problem = patternProblem(rule.architecture);
            const open = ui.openRules.includes(rule.id);
            const onCount = OVERRIDE_KEYS.filter(k => !!rule.overrides[k]?.enabled).length;
            return (
              <div key={rule.id} style={{ ...styles.iosCard, ...(problem ? styles.iosCardBad : {}) }}
                draggable
                onDragStart={e => {
                  // The card is the drag source, but its fields are where the pointer lands when
                  // editing — a drag that starts inside an input is a text selection, not a move.
                  if ((e.target as HTMLElement).closest('input')) { e.preventDefault(); return; }
                  e.dataTransfer.setData('application/x-archrule', String(idx));
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                onDrop={e => { e.preventDefault(); const from = parseInt(e.dataTransfer.getData('application/x-archrule')); if (!isNaN(from)) onReorderArchRules(from, idx); }}
                onContextMenu={e => { e.preventDefault(); setRuleMenu({ x: e.clientX, y: e.clientY, id: rule.id }); }}
              >
                <div style={{ ...styles.iosRow, ...styles.iosRowLine, minHeight: 44 }}
                  onClick={e => { if ((e.target as HTMLElement).closest('input')) return; toggleRule(rule.id); }}
                  title={'Regex matched against the loaded pipeline\'s architecture (case-insensitive search). '
                    + 'Rules go top to bottom and the first one that matches wins, whole.'
                    + (problem ? '\n' + problemNote(problem) : '')}>
                  <span style={styles.iosHandle}><DragHandleIcon /></span>
                  <input className="ios-val" style={styles.iosPattern} value={rule.architecture}
                    onChange={e => patchRule(rule.id, { architecture: e.target.value })} />
                  <span style={problem ? { ...styles.iosBadge, ...styles.iosBadgeWarn } : styles.iosBadge}>
                    {problem || `${onCount} / ${OVERRIDE_KEYS.length}`}
                  </span>
                  <span style={{ ...styles.iosChev, transform: open ? 'rotate(90deg)' : 'none' }}>
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
                      strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7" /></svg>
                  </span>
                </div>
                {/* iOS 三段式：名字在左、值在右、开关在最右。开关关 = 这项不覆盖，
                    右半边摆的就是 Default Setting 那一屏的现值（整行压暗）。 */}
                {open && OVERRIDE_KEYS.map((key, i) => {
                  const m = DEFAULT_PARAM_META[key];
                  const entry = rule.overrides[key];
                  const on = !!entry?.enabled;
                  const last = i === OVERRIDE_KEYS.length - 1;
                  return (
                    <div key={key} style={last ? { ...styles.iosRow, paddingLeft: 26 } : { ...styles.iosRow, ...styles.iosRowLine, paddingLeft: 26 }}
                      title={`${m.label} — off = runs matched by this rule use the Default Setting (${values[key]}). `
                        + 'On = the number on the right replaces it.'}>
                      <span style={{ ...styles.iosLabel, opacity: on ? 1 : 0.4 }}>{m.label}</span>
                      <input className="ios-val" style={{ ...styles.iosNum, opacity: on ? 1 : 0.4 }}
                        type="number" min={m.min} max={m.max} step={m.step} disabled={!on}
                        value={entry?.value ?? values[key]}
                        onChange={e => setRuleParam(rule.id, key, { value: parseInt(e.target.value) || 0 })} />
                      <div onClick={e => e.stopPropagation()}>
                        <IOSToggle checked={on}
                          onChange={v => setRuleParam(rule.id, key, { enabled: v, value: entry?.value ?? values[key] })} />
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
          <div style={styles.iosCard}>
            <button style={styles.iosAddRow} onClick={onAddArchRule}
              title="A new rule matches nothing until you type its pattern">Add Rule</button>
          </div>
          {ruleMenu && (() => {
            const target = archSettings.rules.find(r => r.id === ruleMenu.id);
            if (!target) return null;
            return <ContextMenu x={ruleMenu.x} y={ruleMenu.y} onClose={() => setRuleMenu(null)} items={[
              { label: 'Duplicate', onClick: () => onDuplicateArchRule(target.id) },
              { label: 'Delete', color: '#ff6961', onClick: () => onRemoveArchRule(target.id) },
            ]} />;
          })()}
        </>)}
      </div>
    </div>
  );
};

// ── InterfaceTab ──
// 这一页只负责**描述**接口：端口改名、模式开关、block 端口绑定，外加把 widget 口的默认值摆成
// 一行读数。值不在这里改，也不在这里跑 —— 执行与参数都归工作台的 Tools → Processor 那一扇窗。
// 卡片宽度与行距/列距写在这里：装箱读的“可见高度”和真正画出来的间距必须是同一份数字。
const IFACE_CARD_W = 340;
const IFACE_GAP = 16;

const InterfaceTab: React.FC<{
  interfaces: InterfaceInfo[];
  interfaceMeta: InterfaceMeta;
  onChangeInterfaceMeta: (next: InterfaceMeta) => void;
}> = ({ interfaces, interfaceMeta, onChangeInterfaceMeta }) => {
  // 端口改名：哪个卡片的哪个端口的行内输入框正开着
  const [renamingPort, setRenamingPort] = useState<{ iface: string; side: 'start' | 'end'; num: number } | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  // 形状不满足时点模式开关给的一句话说明（按卡片索引记）
  const [modeHint, setModeHint] = useState<Record<number, string>>({});

  // 装箱只能看真实 DOM：卡片高度是端口数量堆出来的，量不出来就没法排。
  // 卡片每次渲染后现量（这一页里高度的每一次变化都出自某一次渲染），容器的可见高度另外
  // 交给 ResizeObserver —— 设置面板可以被拖宽拖窄，一列能塞多高是它说了算。
  const boxRef = useRef<HTMLDivElement>(null);
  const cardEls = useRef<Map<number, HTMLDivElement>>(new Map());
  const [heights, setHeights] = useState<Record<number, number>>({});
  const [availH, setAvailH] = useState(0);

  useLayoutEffect(() => {
    const next: Record<number, number> = {};
    cardEls.current.forEach((el, idx) => { next[idx] = el.offsetHeight; });
    setHeights(prev => {
      const ks = Object.keys(next);
      if (ks.length !== Object.keys(prev).length) return next;
      return ks.every(k => prev[+k] === next[+k]) ? prev : next;
    });
  });

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const read = () => setAvailH(Math.max(0, box.clientHeight - IFACE_GAP * 2));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  const metaFor = (name: string): InterfaceMeta[string] => interfaceMeta[name] || {};
  const patchMeta = (name: string, patch: Partial<NonNullable<InterfaceMeta[string]>>) => {
    onChangeInterfaceMeta({ ...interfaceMeta, [name]: { ...metaFor(name), ...patch } });
  };
  // 改名只是展示层 —— 执行全程按端口号走。改回 valueN 等于没改，删掉这份标注。
  const renamePort = (iface: string, side: 'start' | 'end', num: number, label: string) => {
    const cur = metaFor(iface);
    const names = { ...(cur.names || {}) } as NonNullable<InterfaceMeta[string]['names']>;
    const sideMap = { ...(names[side] || {}) };
    const trimmed = label.trim();
    if (trimmed && trimmed !== 'value' + num) sideMap[String(num)] = trimmed;
    else delete sideMap[String(num)];
    if (Object.keys(sideMap).length) names[side] = sideMap; else delete names[side];
    const nextNames: InterfaceMeta[string]['names'] = Object.keys(names).length ? names : undefined;
    patchMeta(iface, { names: nextNames });
  };
  const setIfaceMode = (iface: string, key: 'block' | 'processor', on: boolean) => {
    const cur = metaFor(iface);
    patchMeta(iface, { modes: { block: false, processor: false, ...(cur.modes || {}), [key]: on } });
  };
  const setBlockPort = (iface: string, side: 'in' | 'out', num: number) => {
    const cur = metaFor(iface);
    patchMeta(iface, { block_ports: { ...(cur.block_ports || {}), [side]: num } });
  };
  // image/mask 出口的默认落位与入口的默认来源（键 = 端口号字符串）：Processor 小窗里对应行的
  // 初值，随 interface_meta 持久化到 blocks_sets.json。
  const setOutputTarget = (iface: string, num: number, dst: ProcessorDst) => {
    const cur = metaFor(iface);
    patchMeta(iface, { output_targets: { ...(cur.output_targets || {}), [String(num)]: dst } });
  };
  const setInputSource = (iface: string, num: number, src: ProcessorSrc) => {
    const cur = metaFor(iface);
    patchMeta(iface, { input_sources: { ...(cur.input_sources || {}), [String(num)]: src } });
  };
  const portDisplay = (iface: string, side: 'start' | 'end', port: InterfacePort) =>
    metaFor(iface).names?.[side]?.[String(port.num)] || port.name;

  if (interfaces.length === 0) {
    return <div style={{ padding: 20, color: 'rgba(255,255,255,0.3)', fontSize: 14 }}>No interfaces connected.</div>;
  }

  const renderPort = (port: InterfacePort, isStart: boolean, ifaceName: string) => {
    const cat = port.category;
    const badgeColor = cat === 'inject' ? 'rgba(48,209,88,0.15)' : cat === 'manual' ? 'rgba(10,132,255,0.15)' : 'rgba(255,255,255,0.08)';
    const badgeText = cat === 'inject' ? '#30d158' : cat === 'manual' ? '#0a84ff' : 'rgba(255,255,255,0.3)';
    const label = cat === 'inject' ? '(inject)' : cat === 'manual' ? '(widget)' : '(port)';
    const side = isStart ? 'start' as const : 'end' as const;
    const shownName = portDisplay(ifaceName, side, port);
    const renaming = renamingPort?.iface === ifaceName && renamingPort.side === side && renamingPort.num === port.num;

    return (
      <div key={port.num} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', rowGap: 2, gap: 8, padding: '4px 0', minWidth: 0 }}>
        {/* Port name — double-click to rename (display only; execution keys on the port number) */}
        <div
          style={{ minWidth: 80, maxWidth: 130, fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.7)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: renaming ? 'text' : 'pointer', flexShrink: 0 }}
          title={`value${port.num} — double-click to rename`}
          onDoubleClick={() => { setRenamingPort({ iface: ifaceName, side, num: port.num }); setRenameDraft(shownName); }}
        >
          {renaming ? (
            <input
              autoFocus
              style={{ width: '100%', background: 'rgba(255,255,255,0.08)', border: '0.5px solid rgba(10,132,255,0.5)', borderRadius: 4, padding: '1px 4px', color: '#fff', fontSize: 12, outline: 'none' }}
              value={renameDraft}
              onChange={e => setRenameDraft(e.target.value)}
              onBlur={() => { renamePort(ifaceName, side, port.num, renameDraft); setRenamingPort(null); }}
              onKeyDown={e => {
                e.stopPropagation();
                if (e.key === 'Enter') { renamePort(ifaceName, side, port.num, renameDraft); setRenamingPort(null); }
                if (e.key === 'Escape') setRenamingPort(null);
              }}
            />
          ) : shownName}
        </div>
        {/* Type badge */}
        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: badgeColor, color: badgeText, minWidth: 70, textAlign: 'center', flexShrink: 0 }}>
          {port.type}
        </span>
        {/* Category label */}
        <span style={{ fontSize: 10, color: badgeText, fontWeight: 500, minWidth: 50, flexShrink: 0 }}>{label}</span>

        {/* widget 口的值在这一页只读：这里是"描述"接口，值摆的是图里派生出来的那一份；
            要拧它去工作台的 Processor 窗 —— 那扇窗里的值才是报给执行的。没有默认值就不摆读数。 */}
        {isStart && cat === 'manual' && port.value !== null && port.value !== undefined && (
          <span
            style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'rgba(255,255,255,0.7)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={`${port.name} (${port.type}) — the value the graph carries. Change it in the Blend workbench: Tools → Processor.`}
          >
            {String(port.value)}
          </span>
        )}

        {/* Inject 口不再往里塞图 —— 注入哪张图是工作台 Processor 那趟执行的事。 */}
        {isStart && cat === 'inject' && (
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
            {port.type === 'MASK' ? '← Mask' : '← Pipeline'}
          </span>
        )}

        {/* Not connected */}
        {port.type === 'NONE' && <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>Not connected</span>}
      </div>
    );
  };

  // 贪心装箱：照接口顺序往当前列里放，放不下下一张就起新列。一列至少装一张 —— 面板再矮也
  // 不把卡片切开；首帧还没读到可见高度时全留在一列里，量到以后重排。
  const cols: number[][] = [];
  let openCol: number[] = [];
  let openH = 0;
  for (let idx = 0; idx < interfaces.length; idx++) {
    const h = heights[idx] ?? 0;
    if (openCol.length && availH > 0 && openH + IFACE_GAP + h > availH) { cols.push(openCol); openCol = []; openH = 0; }
    if (openCol.length) openH += IFACE_GAP;
    openH += h;
    openCol.push(idx);
  }
  if (openCol.length) cols.push(openCol);

  return (
    // 列是竖着排的 flex，整页横向滚动 —— 卡片宽度恒定、高度随端口数量不等，按行排的话
    // 矮卡片会把高卡片挤成一行里的两条断行，剩下的全是空白。
    <div ref={boxRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: IFACE_GAP, display: 'flex', alignItems: 'flex-start', gap: IFACE_GAP }}>
      {cols.map((col, ci) => (
        <div key={ci} style={{ display: 'flex', flexDirection: 'column', gap: IFACE_GAP, flexShrink: 0 }}>
          {col.map(idx => {
            const iface = interfaces[idx];
            return (
              <div key={idx}
                   ref={el => { if (el) cardEls.current.set(idx, el); else cardEls.current.delete(idx); }}
                   style={{ width: IFACE_CARD_W, background: 'rgba(28,28,30,0.6)', borderRadius: 12, padding: 16, border: '0.5px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column' }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', marginBottom: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{iface.name || `Interface ${idx + 1}`}</div>

                {/* 模式开关（两个独立 toggle，一个 interface 可以同时是 block 和 processor）。
                    开关受形状校验：不满足就拒开并在下方说一句话。 */}
                {(() => {
                  const meta = metaFor(iface.name);
                  const modes = { block: false, processor: false, ...(meta.modes || {}) };
                  const pipelineIn = iface.start_ports?.filter(p => p.type === 'PIPELINE_DATA') ?? [];
                  const pipelineOut = iface.end_ports?.filter(p => p.type === 'PIPELINE_DATA') ?? [];
                  const mediaIn = iface.start_ports?.filter(p => ['IMAGE', 'MASK', 'PIPELINE_DATA'].includes(p.type)) ?? [];
                  const mediaOut = iface.end_ports?.filter(p => ['IMAGE', 'MASK', 'PIPELINE_DATA'].includes(p.type)) ?? [];
                  const canBlock = pipelineIn.length > 0 && pipelineOut.length > 0;
                  const canProcessor = mediaIn.length > 0 && mediaOut.length > 0;
                  const toggleRow = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } as React.CSSProperties;
                  const toggleLabel = { fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.65)' } as React.CSSProperties;
                  return (
                    <div style={{ marginBottom: 12, padding: 10, background: 'rgba(191,90,242,0.06)', borderRadius: 8, border: '0.5px solid rgba(191,90,242,0.18)' }}>
                      <div style={toggleRow}>
                        <span style={toggleLabel} title="Block 模式：作为 pipeline 链中的一环，吃进 pipeline 吐出 pipeline。开启后才会出现在 Draw 面板的 Interface 块下拉里。">Block</span>
                        <IOSToggle checked={modes.block} onChange={v => {
                          if (v && !canBlock) { setModeHint(prev => ({ ...prev, [idx]: 'Block mode needs at least one PIPELINE input port and one PIPELINE output port.' })); return; }
                          setModeHint(prev => ({ ...prev, [idx]: '' }));
                          setIfaceMode(iface.name, 'block', v);
                        }} />
                        <span style={{ ...toggleLabel, marginLeft: 12 }} title="Processor 模式：在 Blend 工作台 Tools → Processor 里以图层/蒙版为输入离线执行，不接力 pipeline。">Processor</span>
                        <IOSToggle checked={modes.processor} onChange={v => {
                          if (v && !canProcessor) { setModeHint(prev => ({ ...prev, [idx]: 'Processor mode needs at least one image/mask input port and one on the output side.' })); return; }
                          setModeHint(prev => ({ ...prev, [idx]: '' }));
                          setIfaceMode(iface.name, 'processor', v);
                        }} />
                      </div>
                      {modeHint[idx] && <div style={{ fontSize: 11, color: '#ff9f0a', marginBottom: 4 }}>{modeHint[idx]}</div>}
                      {modes.block && pipelineIn.length > 0 && pipelineOut.length > 0 && (() => {
                        const blockPorts = meta.block_ports || {};
                        const inNum = blockPorts.in && pipelineIn.some(p => p.num === blockPorts.in) ? blockPorts.in : pipelineIn[0].num;
                        const outNum = blockPorts.out && pipelineOut.some(p => p.num === blockPorts.out) ? blockPorts.out : pipelineOut[0].num;
                        const opt = { background: '#1c1c1e', color: '#fff' } as React.CSSProperties;
                        const portLabel = (p: InterfacePort, side: 'start' | 'end') =>
                          `${portDisplay(iface.name, side, p)}（value${p.num}）`;
                        return (
                          <>
                            <div style={{ ...toggleRow, marginBottom: 0 }}>
                              <span style={{ ...toggleLabel, minWidth: 74 }}>Pipeline In</span>
                              <select style={{ ...styles.paramSelect, flex: 1 }} value={inNum}
                                onChange={e => setBlockPort(iface.name, 'in', parseInt(e.target.value, 10))}
                                title="chain 跑到这块时，pipeline 数据从这个 start 端口进。">
                                {pipelineIn.map(p => <option key={p.num} value={p.num} style={opt}>{portLabel(p, 'start')}</option>)}
                              </select>
                            </div>
                            <div style={{ ...toggleRow, marginBottom: 0 }}>
                              <span style={{ ...toggleLabel, minWidth: 74 }}>Pipeline Out</span>
                              <select style={{ ...styles.paramSelect, flex: 1 }} value={outNum}
                                onChange={e => setBlockPort(iface.name, 'out', parseInt(e.target.value, 10))}
                                title="这块执行完，pipeline 数据从这个 end 端口出去，交给链上的下一块。">
                                {pipelineOut.map(p => <option key={p.num} value={p.num} style={opt}>{portLabel(p, 'end')}</option>)}
                              </select>
                            </div>
                          </>
                        );
                      })()}
                      {modes.processor && (() => {
                        // 每枚 image/mask 出入口的默认源/落位：IMAGE 与 MASK 各自的候选与工作台
                        // Processor 小窗的表同一套词汇（PROCESSOR_SRC_* / PROCESSOR_DST_*）。
                        const mediaOut = (iface.end_ports ?? []).filter(p => p.type === 'IMAGE' || p.type === 'MASK');
                        const mediaIn = (iface.start_ports ?? []).filter(p => p.type === 'IMAGE' || p.type === 'MASK');
                        if (!mediaOut.length && !mediaIn.length) return null;
                        const targets = meta.output_targets || {};
                        const sources = meta.input_sources || {};
                        const dstTables: Record<string, [ProcessorDst, string][]> = {
                          IMAGE: [['new_layer', 'New Layer'], ['staging', 'Staging']],
                          MASK: [['selected_mask', 'Sel. Mask'], ['selected_layer', 'Sel. Layer'], ['staging', 'Staging']],
                        };
                        const srcTables: Record<string, [ProcessorSrc, string][]> = {
                          IMAGE: [['layers', 'Layers'], ['selected', 'Sel. Layer'], ['staging', 'Staging']],
                          MASK: [['main_mask', 'Main Mask'], ['selected_mask', 'Sel. Mask'], ['selected_alpha', 'Sel. Alpha'], ['mask_alpha', 'Mask&Alpha']],
                        };
                        const opt = { background: '#1c1c1e', color: '#fff' } as React.CSSProperties;
                        const portRow = (p: InterfacePort, side: 'end' | 'start', table: [string, string][], cur: string | undefined, onPick: (num: number, v: string) => void, title: string) => (
                          <div key={`${side}-${p.num}`} style={{ ...toggleRow, marginBottom: 0 }}>
                            <span style={{ ...toggleLabel, minWidth: 74 }}>{portDisplay(iface.name, side, p)}</span>
                            <select style={{ ...styles.paramSelect, flex: 1 }} value={cur || table[0][0]}
                              onChange={e => onPick(p.num, e.target.value)} title={title}>
                              {table.map(([v, text]) => <option key={v} value={v} style={opt}>{text}</option>)}
                            </select>
                          </div>
                        );
                        return (
                          <>
                            {mediaIn.length > 0 && (
                              <>
                                <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.65)', margin: '6px 0 2px' }}>
                                  Default inputs
                                </div>
                                {mediaIn.map(p => portRow(p, 'start', srcTables[p.type],
                                  sources[String(p.num)],
                                  (num, v) => setInputSource(iface.name, num, v as ProcessorSrc),
                                  `Where the ${portDisplay(iface.name, 'start', p)} input reads from at the start of a Processor run in the Blend workbench (value${p.num}).`))}
                              </>
                            )}
                            {mediaOut.length > 0 && (
                              <>
                                <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.65)', margin: '6px 0 2px' }}>
                                  Default outputs
                                </div>
                                {mediaOut.map(p => portRow(p, 'end', dstTables[p.type],
                                  targets[String(p.num)],
                                  (num, v) => setOutputTarget(iface.name, num, v as ProcessorDst),
                                  `Where the ${portDisplay(iface.name, 'end', p)} output lands after a Processor run in the Blend workbench (value${p.num}).`))}
                              </>
                            )}
                            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
                              Runs from the Blend workbench — Tools → Processor.
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  );
                })()}

                {/* Start ports (inputs) */}
                {iface.start_ports && iface.start_ports.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Start (Inputs)</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {iface.start_ports.map(port => renderPort(port, true, iface.name))}
                    </div>
                  </div>
                )}

                {/* End ports (outputs) */}
                {iface.end_ports && iface.end_ports.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>End (Outputs)</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {iface.end_ports.map(port => renderPort(port, false, iface.name))}
                    </div>
                  </div>
                )}

              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'row', height: '100vh', background: '#0d0d0d', fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif" },

  // Sidebar — vertical icon tabs
  sidebar: {
    width: 52, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'space-between', padding: '8px 0',
    background: 'rgba(28,28,30,0.72)', backdropFilter: 'blur(20px) saturate(180%)', WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    borderRight: '0.5px solid rgba(255,255,255,0.08)',
  },
  sidebarTabs: { display: 'flex', flexDirection: 'column', gap: 2, width: '100%', alignItems: 'center', justifyContent: 'center', flex: 1 },
  sidebarBtn: {
    width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', borderLeft: '2px solid transparent',
    cursor: 'pointer', transition: 'all 0.2s ease', position: 'relative', borderRadius: 0,
  },
  sidebarDot: { position: 'absolute', top: 6, right: 6, width: 6, height: 6, borderRadius: '50%', background: '#30d158' },
  finishBtn: {
    width: 40, height: 40, fontSize: 16, fontWeight: 700, color: '#30d158',
    background: 'rgba(48,209,88,0.12)', border: 'none', borderRadius: 10, cursor: 'pointer',
    transition: 'all 0.2s ease', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },

  // Content area
  content: { flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' },

  // iframe wrapper — no border, clean
  iframeWrap: { flex: 1, minHeight: 0, background: '#0d0d0d' },
  iframe: { width: '100%', height: '100%', border: 'none', background: '#0d0d0d' },

  // Scrollable content

  // Tag cards — flex:1 equal width


  // Draw tab layout: ONE dock, edge to edge. The column, the canvas and every popped-out window are
  // placed by the dock's own tree, so there is no panel width, no separator and no side of the page
  // the layout model does not know about.
  // `minWidth: 0` is not decoration: a flex item defaults to a minimum of its CONTENT's minimum, so
  // without it the dock's blocks can push the whole page wider than the window instead of being cut to
  // the box the frame gave them — which is exactly what the dock promises never happens.
  drawLayout: { flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'row', padding: 10, position: 'relative' },
  blendFrame: { width: '100%', height: '100%', border: 'none', background: '#0d0d0d', display: 'block' },
  // The single live workbench, pinned over the window that holds the active document. The layer is the
  // size of that box (the frame can never be moved INTO the box — reparenting an iframe reloads it),
  // so it is clipped and rounded like the box it stands in for.
  frameLayer: { position: 'absolute', overflow: 'hidden', borderRadius: 10, background: '#0d0d0d', transition: 'opacity 0.12s ease' },
  // A window that is not showing the live frame: the last frame that project painted, kept at its own
  // aspect on the same ground so switching projects does not flash a different background.
  docStill: { width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: '#0d0d0d' },
  docVoid: { flex: 1, minHeight: 0, background: '#0d0d0d' },
  activeDot: { width: 7, height: 7, borderRadius: 999, background: '#30d158', flexShrink: 0, display: 'inline-block', marginRight: 5, verticalAlign: 'middle', boxShadow: '0 0 6px rgba(48,209,88,0.6)' },
  docClose: { flexShrink: 0, width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', borderRadius: 5, color: 'rgba(255,255,255,0.55)', cursor: 'pointer', padding: 0 },
  // tab 里那一颗：小一号、更淡一点，紧贴着名字 —— 它说的是"这一份"，不是"这一窗"。
  docCloseTab: { flexShrink: 0, width: 14, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', borderRadius: 4, color: 'rgba(255,255,255,0.42)', cursor: 'pointer', padding: 0, marginLeft: 1 },
  // The toolbar unit is a row of the File actions — the same pill vocabulary as the sibling units'
  // head buttons, laid out left to right instead of hanging off a title.
  fileBar: { display: 'flex', alignItems: 'center', gap: 5, padding: '5px 6px', flexWrap: 'wrap' },
  // 模式切换（Image / Video）：一枚 iOS 式小分段控件，贴在 File 那一排的最左。
  modeSeg: { display: 'flex', padding: 2, borderRadius: 999, background: 'rgba(255,255,255,0.08)', flexShrink: 0, gap: 2 },
  modeSegBtn: { fontSize: 10.5, fontWeight: 600, padding: '2px 10px', borderRadius: 999, cursor: 'pointer', background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.55)', lineHeight: 1.5 },
  modeSegOn: { background: 'rgba(10,132,255,0.85)', color: '#fff' },
  fileBtn: {
    fontSize: 10.5, fontWeight: 600, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
    background: 'rgba(255,255,255,0.07)', border: '0.5px solid rgba(255,255,255,0.16)',
    color: 'rgba(255,255,255,0.82)', lineHeight: 1.5,
  },
  logBtn: {
    display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
    fontSize: 10.5, fontWeight: 600, padding: '2px 9px', borderRadius: 999, cursor: 'pointer',
    background: 'rgba(100,210,255,0.14)', border: '0.5px solid rgba(100,210,255,0.42)',
    color: '#64d2ff', lineHeight: 1.5,
  },
  debugBtn: {
    display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
    fontSize: 10.5, fontWeight: 600, padding: '2px 9px', borderRadius: 999, cursor: 'pointer',
    background: 'rgba(255,159,10,0.14)', border: '0.5px solid rgba(255,159,10,0.42)',
    color: '#ff9f0a', lineHeight: 1.5,
  },
  previewTintRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 },
  previewTintLabel: { fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.6)', minWidth: 58 },
  previewTintRange: { flex: 1, minWidth: 0, accentColor: '#ff3b30' },
  previewTintValue: { fontSize: 11, color: 'rgba(255,255,255,0.5)', minWidth: 26, textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' },
  contextPreviewWrap: { position: 'relative', width: '100%', aspectRatio: '1', borderRadius: 8, overflow: 'hidden', background: '#1a1a1a' },
  blendPreviewImg: { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
  blendPreviewEmpty: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, textAlign: 'center', color: 'rgba(255,255,255,0.3)', fontSize: 11 } as React.CSSProperties,
  blendPreviewBadge: { position: 'absolute', right: 6, bottom: 6, padding: '2px 6px', borderRadius: 6, background: 'rgba(0,0,0,0.55)', color: 'rgba(255,255,255,0.78)', fontSize: 10, fontVariantNumeric: 'tabular-nums' },
  paramRow: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  paramLabel: { fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.6)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  paramSelect: { flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.06)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: '0.5px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '6px 12px', color: '#fff', fontSize: 13, outline: 'none', colorScheme: 'dark', WebkitAppearance: 'none', appearance: 'none', backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\' viewBox=\'0 0 10 6\' fill=\'none\'%3E%3Cpath d=\'M1 1L5 5L9 1\' stroke=\'rgba(255,255,255,0.4)\' stroke-width=\'1.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 28, transition: 'background 0.15s ease, border-color 0.15s ease' } as React.CSSProperties,
  paramInput: { flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.08)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '5px 10px', color: '#fff', fontSize: 13, outline: 'none', fontVariantNumeric: 'tabular-nums', textAlign: 'right' },

  // ── Settings 页的 iOS inset-grouped 词汇（系统色，不再手调白叠加）：卡片 #1c1c1e、分节标题
  // #8e8e93 大写、内缩分隔线 rgba(84,84,88,.55)、强调 #0a84ff、告警 #ff9f0a。Draw 页那套
  // paramRow/paramInput 原样留着 —— 这页先换装，质感定了再谈推广。
  iosScreen: { display: 'flex', flexDirection: 'column', paddingBottom: 8 },
  iosSeg: { margin: '12px 12px 0', display: 'flex', padding: 2.5, borderRadius: 9, background: 'rgba(255,255,255,0.08)', flexShrink: 0 },
  iosGroupTitle: { margin: '14px 14px 6px', display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11, fontWeight: 600, letterSpacing: '0.5px', textTransform: 'uppercase', color: '#8e8e93' },
  iosGroupHint: { fontStyle: 'normal', textTransform: 'none', letterSpacing: 0, fontWeight: 400, fontSize: 11, color: 'rgba(142,142,147,0.75)' },
  iosCard: { margin: '0 12px 10px', background: '#1c1c1e', borderRadius: 10, overflow: 'hidden' },
  iosCardBad: { boxShadow: 'inset 0 0 0 1px rgba(255,159,10,0.7)' },
  iosRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px', minHeight: 40, minWidth: 0 },
  iosRowLine: { borderBottom: '0.5px solid rgba(84,84,88,0.55)' },
  iosLabel: { flex: 1, minWidth: 0, fontSize: 13.5, color: 'rgba(255,255,255,0.92)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  // 值贴右、无边框，聚焦才现出下划线（:focus 在 <style> 里的 .ios-val）
  iosNum: { flexShrink: 0, width: 92, textAlign: 'right', background: 'transparent', border: 'none', borderBottom: '0.5px solid transparent', outline: 'none', color: 'rgba(255,255,255,0.92)', fontSize: 13.5, fontVariantNumeric: 'tabular-nums' },
  iosPattern: { flex: 1, minWidth: 0, background: 'transparent', border: 'none', borderBottom: '0.5px solid transparent', outline: 'none', color: 'rgba(255,255,255,0.92)', fontSize: 12.5, fontFamily: 'ui-monospace, Consolas, monospace' },
  iosBadge: { flexShrink: 0, padding: '1.5px 6px', borderRadius: 8, background: 'rgba(255,255,255,0.07)', color: '#8e8e93', fontSize: 10.5, fontVariantNumeric: 'tabular-nums' },
  iosBadgeWarn: { background: 'rgba(255,159,10,0.13)', color: '#ff9f0a' },
  iosHandle: { flexShrink: 0, display: 'flex', color: 'rgba(142,142,147,0.55)', cursor: 'grab' },
  iosChev: { flexShrink: 0, display: 'flex', color: 'rgba(142,142,147,0.45)', transition: 'transform 0.12s ease' },
  iosAddRow: { display: 'block', width: '100%', textAlign: 'left', padding: '11px 14px', background: 'transparent', border: 'none', outline: 'none', color: '#0a84ff', fontSize: 13.5, cursor: 'pointer' },

  // The dock's own frame (its boxes, bars, handles and windows) is styled in src/dock/DockView.tsx —
  // this is what a unit's BODY uses: interior cards and rows, same skin as the Settings page.
  dockCard: { background: 'rgba(28,28,30,0.72)', border: '0.5px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: '2px 10px', display: 'flex', flexDirection: 'column', gap: 8 },
  dockSubrow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#8e8e93', padding: '2px 2px 0' },
  dockGtitle: { fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.42)', borderBottom: '0.5px solid rgba(84,84,88,0.55)', paddingBottom: 3 },
  dockGbody: { display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 10, borderLeft: '0.5px solid rgba(255,255,255,0.10)' },
  dockGroup: { display: 'flex', flexDirection: 'column', gap: 6 },

  editSubSection: { marginLeft: 8, paddingLeft: 10, borderLeft: '0.5px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: 10 },


  // History (used in finish dialog)
  historyCard: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: 6, background: 'rgba(28,28,30,0.6)', border: '0.5px solid rgba(255,255,255,0.08)', borderRadius: 12, cursor: 'pointer', transition: 'all 0.2s ease' },
  historyImgWrap: { position: 'relative', width: 200, height: 200 },
  historyImg: { width: 200, height: 200, objectFit: 'cover', borderRadius: 8 },
  historyCheck: { position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: '50%', background: '#0a84ff', color: '#fff', fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' },
  historyName: { fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.7)' },

  // Dialog
  overlay: { position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', zIndex: 100 },
  dialog: { background: '#1c1c1e', borderRadius: 16, padding: 24, maxWidth: '80vw', maxHeight: '80vh', overflowY: 'auto', border: '0.5px solid rgba(255,255,255,0.1)' },
  dialogTitle: { fontSize: 18, fontWeight: 700, color: '#fff', marginBottom: 4 },
  dialogSubtitle: { fontSize: 13, color: 'rgba(255,255,255,0.45)', marginBottom: 16 },
  dialogActions: { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 },
  confirmBtn: { padding: '8px 24px', fontSize: 14, fontWeight: 600, color: '#fff', background: 'rgba(48,209,88,0.85)', border: 'none', borderRadius: 8, cursor: 'pointer' },
  cancelBtn: { padding: '8px 20px', fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.5)', background: 'transparent', border: '0.5px solid rgba(255,255,255,0.1)', borderRadius: 8, cursor: 'pointer' },
};

export default EditPhase;
