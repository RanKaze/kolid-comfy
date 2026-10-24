import React, { useState, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useSyncExternalStore } from 'react';
import type { PipelineBlock, PromptPreset, Tab, StagingItem, InterfaceInfo, InterfacePort, InterfaceMeta, PipelinePackageInfo, BlockSet, PendingQuery, ActionLogEntry, PipelineSettings, ArchSettings, ArchRule, OverrideKey, ParamOverride, ProcessorDst, ProcessorSrc, BlendDoc, BlendDocs, BlendDocCommand, BlendUiSend, BlendProcessorUi, VideoGenConfig, VideoGenSlot } from '../types';
import { PIPELINE_DEFAULT, PIPELINE_CURRENT_SELECT, OVERRIDE_KEYS, preprocessFlag, VIDEO_GEN_SLOTS, videoGenMissing } from '../types';
import { DebugPanel } from './DebugModal';
import { LogPanel } from './LogModal';
import RunStatusSeg from './RunStatusSeg';
import VidSegModal from './VidSegModal';
import { type DockMode, type DockRules, type UnitId, type Dock, docUnit, docUidOf, dockUnits, fitLayout, loadDock, revealDoc, setBlockMode, setToolbarDock, setToolbarDirDock, syncDocUnits } from '../dock/model';
import { fetchLayouts } from '../dock/layoutStore';
import { type DockDrag, type DockOver, DockPanel } from '../dock/DockView';
import { registerProbe, note } from '../debug/probe';
import { ProbePanelBody } from '../debug/ProbePanel';
import { probePanelOpen, setProbePanelOpen, subscribePanel } from '../debug/install';
import { onGlobalKey, keyIs } from '../hotkeys';
import PipelineGraphEditor from '../workbench/pipeline-graph-editor';
import type { PipelineGraph } from '../workbench/pipeline-graph';
import { WORKBENCH_PANEL_IDS, WORKBENCH_TITLES, WORKBENCH_HINTS, workbenchBodies, workbenchFoots } from '../workbench/registry';
import { unitIcon } from '../workbench/icons';
import { type ProcFrameWindow, type VidAsset, type VidController, type VidClip, type VidGenFrameRef, type VidGenTrackCfg, type VidKfSnapshot, type VidProject, type VidTrackKind, applyProcSettings, clampFps, createSeekCoalescer, createVidTransport, defaultVidProject, importToTrack, isAudioName, isVideoName, kfRecord, loadVidProject, normalizeVidProject, outputClipOf, placeProcAssets, placeProcOutput, placeProcPlaceholders, placeVideoGenOutput, placeVideoGenSegment, procSlotBusy, pruneVgenChains, relinkAsset, saveVidProject, setMaskTrack, setVideoGenTrackCfg, setVideoGenTrackPreset, vgenChainPrevOf, vgenChainTo, vidAssetRefs, vgenDurationOf, vgenFpsOf, vgenResolutionOf } from '../workbench/video/model';
import PlaceholderSettingsModal from '../workbench/video/PlaceholderSettingsModal';
import { getVidProcPicks } from '../workbench/video/procPicks';
import { setVidHistoryJump, setVidHistoryView } from '../workbench/vidHistoryStore';
import { setLayerEditBlocked } from '../workbench/editGate';
import { getBlendUi, setBlendUi, getActiveBlendUid } from '../workbench/store';
import { resetRowInteraction } from '../workbench/layerRow';
import { ingestFile } from '../workbench/video/ingest';
import { grabFrameFull } from '../workbench/video/previews';
import { getVidSelection, subscribeVidSelection } from '../workbench/video/selection';
import { getKfArmed, subscribeKfArmed } from '../workbench/video/kfArmed';
import { bumpAssets } from '../workbench/video/assetsTick';
import { markRender } from '../workbench/video/perf';
import { beginVidProcRun, clearProcFill, clearProcQueue, dequeueProcClip, endVidProcRun, getProcFill, isProcQueued, setProcFill, setProcQueue, setVidProcRun, setVidStagingOverlay } from '../workbench/video/procRun';
import { VidTimeline } from '../workbench/video/Timeline';
import { VidAssets, Card, type StoreAsset } from '../workbench/video/Assets';
import { VidInspector, type InspectSel } from '../workbench/video/Inspector';
import { VidAudioMonitor } from '../workbench/video/AudioMonitor';
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
// Preprocess 不再是一扇窗 —— 它搬进 Pipeline Graph，成了画布上那块黑板（board 节点）。
// Pipeline 与 Pipeline Presets 各占一扇窗：前者只选 pipeline，后者只列 preset（Add 在动作条里）。
const HOST_PANEL_IDS: UnitId[] = ['toolbar', 'context', 'pipeline', 'presets', 'blocks'];
// vtracks / vassets 是**默认提供**的常驻窗，两种模式都显示正文（时间线 / 资产库）——
// 轨道与资产属于文档，不该只在 Video 模式下才看得见。播放器不单独占窗：
// Video 模式下 Workbench 窗（id 'canvas'）的正文整个换成播放器 —— 全页只有 Workbench 窗的
// 标题条上有一颗 Image/Video 切换（见 heads）。
const PANEL_IDS: UnitId[] = [...HOST_PANEL_IDS, ...WORKBENCH_PANEL_IDS, 'vtracks', 'vassets', 'vinspector', 'vaudio', 'log', 'debug', 'probe'];
// 工具窗的标识色:Log / Debug / Probe 三扇"看现场"的窗,图标与 tab 名同穿一件颜色的衣服,
// 与内容窗(素色)一眼分开。icon 的着色与 titleColor 都从这里来 —— 一处定色,两处生效。
const UNIT_COLORS: Partial<Record<string, string>> = {
  log: '#64d2ff',    // 信息青:一条流水账
  debug: '#ff9f0a',  // 警示橙:快照与过程数据
  probe: '#bf5af2',  // 探针紫:布局巡检
};
const COLUMN_IDS: UnitId[] = ['context', 'pipeline', 'presets', 'blocks'];
const UNIT_TITLES: Record<string, string> = {
  toolbar: 'File', context: 'Context', pipeline: 'Pipeline', presets: 'Pipeline Presets',
  blocks: 'Pipeline Graph', vtracks: 'Tracks', vassets: 'Assets', vinspector: 'Inspector', vaudio: 'Audio Monitor',
  log: 'Log', debug: 'Debug', probe: 'Probe',
  ...WORKBENCH_TITLES,
};
const COLUMN_W = 340;
// 工作台那一列原来就是 280 宽（页面的 `SIDE_W_DEFAULT`），搬过来照抄这颗数。
const RIGHT_W = 280;
const TOP_H = 60;
const DOCK_STORE = 'sampler.drawDock';
// ── Video 模式 ── **同一棵 dock 树**的第二种活法：切过去时只动一处 —— Workbench 那格
// （id 'canvas'）的正文换成播放器。Tracks / Assets 两扇窗的正文与模式无关，始终是时间线与
// 资产库。**其它每一扇窗原地不动**，来回切换不重排任何东西。
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
    // 名字条上要列哪些单元由 listed 说了算;工具窗(Log/Debug/Probe)的图标与名字着同一色,
    // 与内容窗划清界限 —— 颜色一处定义(UNIT_COLORS),两处生效。
    titleColor: (id: UnitId) => UNIT_COLORS[id],
    icon: (id: UnitId) => {
      const Icon = unitIcon(id);
      const c = UNIT_COLORS[id];
      return c ? <span style={{ color: c, display: 'flex' }}><Icon size={15} /></span> : <Icon size={15} />;
    },
    keepMounted: isDocUnit,
    // A document window never folds: its fold would be stored under a uid the workbench re-issues from
    // 1 on its next boot, and a collapsed canvas box leaves the live frame with nowhere to be. Its title
    // bar already has a job — it says which project the workbench is running.
    // (Folding only exists inside a container block, so a document there — like anywhere — has no fold.)
    foldable: (id: UnitId) => !isDocUnit(id),
    fullBleed: (id: UnitId) => isDocUnit(id) || id === 'toolbar' || id === 'context' || id === 'vtracks' || id === 'vassets' || id === 'vinspector' || id === 'vaudio' || id === 'log' || id === 'debug' || id === 'probe' || id === 'blocks',
    // Layers 与 Guidances 是这一列里唯二两格「行会一直长」的面板：它们没有可用来定高的内容，所以放进
    // 容器（Vertical/Horizontal 的 Block）里时按份额分块的余量，而不是把整份列表高度顶出去让块滚到天边。
    // 时间线与资产库同理：两份会一直长的列表。
    // Context 也进 grows:预览图要吃满窗的余量(图片 fit dock window),左列里它是那个"看图"的窗,
    // 与 Inspector 同一待遇;Pipeline/Presets 照旧按内容定高。
    grows: (id: UnitId) => isDocUnit(id) || id === 'layers' || id === 'guidances' || id === 'vtracks' || id === 'vassets' || id === 'vinspector' || id === 'context' || id === 'log' || id === 'debug' || id === 'probe',
    top: 'toolbar',
    // 顶栏那一块的高度是页面写死的：它是**唯一**一块由内容高度（一排按钮 32px + 自己的标题条）定尺寸的
    // 地方，而布局本身不再看内容。其余每一块都由份额或用户拖出来的像素说话。
    topH: TOP_H,
    column: COLUMN_IDS,
    columnW: COLUMN_W,
    // 画布右边那一列：工作台搬出来的面板按注册表的序叠在这里，Assets / Tracks 是普通成员
    // （默认窗，不靠任何切换逻辑出现）。
    right: [...WORKBENCH_PANEL_IDS, 'vassets', 'vtracks', 'vinspector', 'vaudio', 'log', 'debug', 'probe'],
    rightW: RIGHT_W,
    // The size a NEW block opens at — asked per unit and per axis, because which axis the block will be
    // measured on is decided by the side it was dropped on (under a block it is a height, beside one it
    // is a width). It is a preference: the frame caps it so the block it is taken from keeps its floor.
    blockSize: (id: UnitId, axis: 'v' | 'h') => {
      if (id === 'toolbar') return axis === 'v' ? TOP_H : 240;
      if (isDoc(id)) return axis === 'v' ? DOC_BLOCK_H : DOC_BLOCK_W;
      if (id === 'vtracks') return axis === 'v' ? 320 : 900;
      if (id === 'vassets') return axis === 'v' ? 260 : PANEL_BLOCK_W;
      if (id === 'vinspector') return axis === 'v' ? 300 : 460;
      if (id === 'vaudio') return axis === 'v' ? 240 : 200;
      if (id === 'log') return axis === 'v' ? 240 : 320;
      if (id === 'debug') return axis === 'v' ? 380 : 460;
      if (id === 'probe') return axis === 'v' ? 420 : 540;
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
  x: number; y: number; up?: boolean;
  items: { label: string; color?: string; hint?: string; onClick: () => void; sep?: boolean }[];
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
      {items.map(it => it.sep
        // 分组线：Add 菜单里"处理链"那六种与"几何/检测"那八种隔开 —— 十四项一条平列，
        // 用户会在中间找不着 Scale 与 Crop 的边界。
        ? <div key={`sep:${it.label}`} style={{ height: 1, margin: '3px 6px', background: 'rgba(255,255,255,0.10)' }} />
        : (
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

/** 首帧/末帧绑定 → 后端认的输入键（资产按内容哈希、.cud 按路径）。 */
const vgenFrameKey = (ref: VidGenFrameRef | null | undefined): string =>
  ref?.kind === 'asset' ? `asset:${ref.hash}` : ref?.kind === 'cud' ? `cud:${ref.path}` : '';

/** 这一段自己那把首帧喂什么、从哪儿来。链着前一段时**链优先**（前段绑了末帧卡用那张，
 *  否则把它产物的末帧交给后端现抽 —— 后端不认识那个文件就当场报错，不静默丢图）。 */
const vgenFrameInputsOf = (
  p: VidProject, clip: VidClip,
): { image_keys: Record<string, string>; chain_frames: Record<string, { src: string; fps?: number }> } => {
  const v = clip.vgen;
  const image_keys: Record<string, string> = {};
  const chain_frames: Record<string, { src: string; fps?: number }> = {};
  if (!v) return { image_keys, chain_frames };
  const prev = vgenChainPrevOf(p, clip);
  if (v.ports.first_frame) {
    if (prev) {
      const ref = prev.vgen?.last_frame;
      const k = vgenFrameKey(ref);
      if (k) image_keys[String(v.ports.first_frame)] = k;
      else {
        const out = outputClipOf(p, prev);
        if (!out) throw new Error(`「${prev.name}」 has no result yet — its last frame is the first frame of this segment.`);
        // fps = 工程 fps：后端按工程网格算"最后一个正在显示"的源帧号。
        chain_frames[String(v.ports.first_frame)] = { src: out.src, fps: p.fps };
      }
    } else if (v.first_frame) {
      const k = vgenFrameKey(v.first_frame);
      if (k) image_keys[String(v.ports.first_frame)] = k;
    }
  }
  if (v.ports.last_frame && v.last_frame) {
    const k = vgenFrameKey(v.last_frame);
    if (k) image_keys[String(v.ports.last_frame)] = k;
  }
  return { image_keys, chain_frames };
};

/** 跑 target 之前必须先跑的链上前段（早 → 晚，不含自己）。前段绑了末帧卡就没有依赖；
 *  没绑才要它产物的末帧 —— 产物不在就先跑它，逐级往前推。 */
const vgenRunPlanBefore = (p: VidProject, target: VidClip): VidClip[] => {
  const chain = vgenChainTo(p, target);
  const need = new Set<string>([target.id]);
  for (let i = chain.length - 1; i >= 1; i--) {
    const cur = chain[i];
    if (!need.has(cur.id)) continue;
    const prev = chain[i - 1];
    if (prev.vgen?.last_frame || outputClipOf(p, prev)) continue;
    need.add(prev.id);
  }
  return chain.filter(c => c.id !== target.id && need.has(c.id));
};

interface EditPhaseProps {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  promptUrl: string;
  promptReady: boolean;
  detailStatus: 'idle' | 'running' | 'done' | 'error';
  staging: StagingItem[];
  promptIframeRef: React.RefObject<HTMLIFrameElement>;
  /** 此刻加载的 pipeline 架构名（'' / null = 未知）。Detailer 的 Edit Mode(fit/crop) 只对 Krea2 有意义，
   *  图编辑器据此决定这颗字段露不露。 */
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
  onDefaultParamChange: (key: OverrideKey, value: number) => void;
  /** 一个正等用户回答的 Query 块（run 停在它上面），由 /api/status 下发 */
  pendingQuery: PendingQuery | null;
  /** 立刻以某个 pipeline preset 跑一趟（画布在 Blend 工作台里，由工作台发起） */
  onRunPreset: (presetId: string) => void;
  /** 把用户在弹窗里挑好的 prompt 交给后端，唤醒停在 Query 块上的 run。
   *  返回 Promise 是为了让 Persistent 的写回落地后再刷新 preset 摘要。 */
  onQueryAnswer: (selection: Record<string, any>) => void | Promise<void>;
  /** 关掉 Query 弹窗 = 中止整条链 */
  onQueryCancel: () => void;
  /** 多套 Pipeline Blocks（tabs）；blocks = 激活那一套的镜像 */
  blockSets: BlockSet[];
  activeBlockSetId: string;
  /** 激活那套链的**图**（新格式）。Graph 视图直接编辑它；改动经 onGraphChange 落回。 */
  activeGraph: PipelineGraph;
  onGraphChange: (g: PipelineGraph) => void;
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
  /** 宿主的 Log 追加口（App.pushLog 同一支笔）：跳转被后端拒绝这类"页面这头失败了"的
   *  事，工作台的状态行看不见，只能落在这里。 */
  pushLog?: (text: string, kind?: ActionLogEntry['kind']) => void;
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

// 视频分段跑完一段，通知 Kolid Desktop 的壳页摇一次铃。响不响由桌面端的铃铛总开关
// （Tinkle enabled）决定，前端只管发；浏览器直开时 parent 是自己，这条消息无人听。
// segment: true 是给壳页的标记 —— 分段完成不参与那 1.5s 的整链节流，每段各响一次。
function ringSegmentDone() {
  try {
    window.parent.postMessage({ __kolid: 'tinkle', event: 'pipeline-done', segment: true }, '*');
  } catch { /* ignore */ }
}

const EditPhase: React.FC<EditPhaseProps> = ({
  tab, onTabChange, promptUrl,
  promptReady, detailStatus,
  staging, promptIframeRef,
  architecture, maskGrow, maskBlur, cropReserve, pixelsVal, alignVal,
  refPixelsVal, refAlignVal, tgenPixelsVal, tgenAlignVal,
  onDefaultParamChange,
  blockSets, activeBlockSetId, onAddBlockSet, onRenameBlockSet, onDuplicateBlockSet, onRemoveBlockSet, onReorderBlockSets, onSwitchBlockSet,
  activeGraph, onGraphChange,
  pendingQuery, onRunPreset, onQueryAnswer, onQueryCancel,
  onFinishClick, showFinishDialog, onFinish, onCloseFinishDialog,
  blendIframeRef,
  interfaces, interfaceMeta, onChangeInterfaceMeta,
  pipelinePackages, pipelineSettings, loadedPipelineName, onSwitchPipeline, onPipelineSettingsChange, onSetPresetPipeline,
  archSettings, onArchSettingsChange, onAddArchRule, onDuplicateArchRule, onRemoveArchRule, onReorderArchRules,
  openWithApp, onOpenWithAppChange,
  actionLog, pushLog, blendDocs, docStills, onDocCommand, onBlendUiCommand,
  stageUpload, stageRemove,
}) => {
  markRender('EditPhase');
  const [hoveredFinish, setHoveredFinish] = useState<StagingItem | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // Log / Debug 曾是这里两颗 useState 开关的 Modal;现在各自是一扇 dock 窗(见 bodies)。
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
  // Mask Tint 滑块改悬浮式:指针停在 Context 预览图上才浮出来(下面 context 正文用)。
  const [ctxTintHover, setCtxTintHover] = useState(false);
  // Inline rename of a Pipeline Blocks tab (set): which set is being renamed and the draft text.
  const [renamingSetId, setRenamingSetId] = useState<string | null>(null);
  const [renamingValue, setRenamingValue] = useState('');
  // Prompt preset editor: which prompt block's PRESET is being edited in the prompt_node
  // iframe (full prompt UI, saved to the shared preset — persisted, referenced by id).
  const [editingPromptPresetId, setEditingPromptPresetId] = useState<string | null>(null);
  // Shared prompt presets (backend prompt_presets.json). Blocks reference them by id;
  // editing a preset affects every block that references it.
  const [promptPresets, setPromptPresets] = useState<PromptPreset[]>([]);
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
  // 只改一处：canvas 格正文换播放器（见 bodies）—— Tracks / Assets 与模式无关。
  const vidMode0: VidMode = (() => {
    try { return localStorage.getItem(VID_MODE_STORE) === 'video' ? 'video' : 'image'; } catch { return 'image'; }
  })();
  const [vidMode, setVidModeState] = useState<VidMode>(vidMode0);
  const vidModeRef = useRef(vidMode);
  vidModeRef.current = vidMode;
  // ── Video 工程状态 ── 权威在宿主：Player / Tracks 两扇窗都从这里拿快照（VidController），
  // **按文档分桶**：Video 工程随 .cud 走（保存时 iframe 来要快照、读档时送回来），桶键 = 文档
  // uid；写入落进活跃文档的桶，切文档 = 换一份工程。
  const vidByDoc = useRef(new Map<number, VidProject>());
  const activeUid = blendDocs.activeUid;
  const activeUidRef = useRef(activeUid); activeUidRef.current = activeUid;
  // Video 工程的"脏"记在宿主：工程随 .cud 走，而工作台的 dirty 只看图层，
  // 光动 Assets/Tracks 它不会亮 —— 所以这一份要宿主自己记，存盘后清掉。
  const vidDirty = useRef(new Set<number>());
  const [vidDirtyTick, bumpVidDirty] = useReducer((x: number) => x + 1, 0);
  // 视频工程置脏的唯一写口：宿主记一份（tab 上的 ●、dockRules），同时**当场**告诉工作台 ——
  // "关之前要不要先存一下"是它在管（closeDocument 读 entry.dirty），而它的账只有这条消息
  // 一个来源。变脏就发、不等点 ✕：桌面双击流那条 dropPristineBootDocument 也读 entry.dirty，
  // 只在 ✕ 上补发会漏掉那一支。同一条消息幂等（工作台那端 !entry.dirty 才落）。
  const markVidDirty = useCallback((uid: number) => {
    if (vidDirty.current.has(uid)) return;
    vidDirty.current.add(uid);
    bumpVidDirty();
    blendIframeRef.current?.contentWindow?.postMessage({ type: 'blend-vid-dirty', uid }, '*');
  }, [blendIframeRef]);
  // 每跑完一段就让工作台把 .cud 落盘一次。**只对已经绑过文件的文档生效**（有没有绑定
  // 只有工作台知道）：没落过盘的项目不该被自动保存，更不该自己弹出"另存为"目录框 ——
  // 这两种情况它那边直接返回。连续几段挨得很近时它会把多发的一发排队、合并成一次写。
  const autoSaveCud = useCallback(() => {
    blendIframeRef.current?.contentWindow?.postMessage({ type: 'blend-autosave' }, '*');
  }, [blendIframeRef]);
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
  // 把一扇面板**切到前台**:折叠的开回来(sections),tab 组/块选中项拨到它(revealDoc 对任意
  // 单元通用,浮窗原样 —— 已经看得见)。Assets 卡片双击"自动切出 Inspector"走这条。
  const revealPanel = useCallback((id: UnitId) => {
    setFold(id, true);
    applyDock(revealDoc(dockRef.current, id));
  }, [applyDock, setFold]);
  // Alt+D(探针热键)住在 debug/install 里,它只会掀 `probePanelOpen` 这口铃 —— 探针如今是
  // 一扇 dock 窗,宿主在这里听铃:有人按了 Alt+D 就把 Probe 窗切到前台,并把开关消费掉。
  useEffect(() => subscribePanel(() => {
    if (!probePanelOpen()) return;
    setProbePanelOpen(false);
    revealPanel('probe');
  }), [revealPanel]);
  // 模式切换不动树：vtracks / vassets 本来就是默认提供的窗（起手树 / fitLayout 补缺都保证它们在）。
  // 切换只换 canvas 格的正文 —— 画布 ↔ 播放器 —— Tracks / Assets 与其它每一扇窗原地不动。
  // 模式同时是**工程自己的属性**（随 .cud 走）：写进活跃文档的桶并置脏，下一次落盘就带进
  // 文件 —— 重开这份工程时落回它自己的模式，不再是页面级的一颗开关。不算一步时间线编辑，
  // 不进撤销摞。
  const setVidMode = useCallback((m: VidMode) => {
    if (m === vidModeRef.current) return;
    try { localStorage.setItem(VID_MODE_STORE, m); } catch { /* in-memory only */ }
    vidModeRef.current = m;
    setVidModeState(m);
    const uid = activeUidRef.current;
    if (uid == null) return;
    const cur = vidByDoc.current.get(uid);
    if (cur && cur.mode !== m) {
      const next = { ...cur, mode: m };
      vidByDoc.current.set(uid, next);
      // ref 当场跟上：同一事件里紧接着的 vidUpdate 要以这份为准，别拿旧工程把 mode 冲掉。
      vidProjectRef.current = next;
      setVidProject(next);
      markVidDirty(uid);
    }
  }, [markVidDirty]);
  // 页面这份模式态只是**活跃工程 mode 的投影**：切文档 / 读档回来时跟着工程走（打开哪份
  // .cud 就显示它自己的设置）。
  const syncVidMode = useCallback((m: VidMode) => {
    if (m === vidModeRef.current) return;
    try { localStorage.setItem(VID_MODE_STORE, m); } catch { /* in-memory only */ }
    vidModeRef.current = m;
    setVidModeState(m);
  }, []);
  // ── Video 工程状态 ── 权威在宿主：Player / Tracks 两扇窗都从这里拿快照（VidController），
  // **按文档分桶**：Video 工程随 .cud 走（保存时 iframe 来要快照、读档时送回来），桶键 = 文档
  // uid；写入落进活跃文档的桶，切文档 = 换一份工程。
  // 页面存档（localStorage）只是"刷新之后手上还没有任何 .cud"时的起手工程：它喂给开机那份空白
  // 文档，绝不渗进任何一份从文件打开的文档（见下面的文档切换 effect）。
  // 播放头不住这里：它每帧都在走，走 React state 会把整页拖着每秒重渲几十次（scrub 卡顿的根子）。
  // 它住外置 transport —— Player/Timeline 订阅它直改 DOM，React 只管低频的事。
  // 页面存档（localStorage）只是"刷新之后手上还没有任何 .cud"时的起手工程：它喂给**这次开机见到
  // 的第一份文档**，之后就作废。绝不渗进之后打开/新建的任何文档 —— 那些的正身要么在 .cud 里
  // （blend-vid-restore 送来），要么就是空白。
  const vidSeedRef = useRef<{ p: VidProject } | null>((() => {
    const p = loadVidProject();
    // 页面起手工程的老档没有 mode 字段：沿用页面存档那一位（刷新后留在上次的模式里），
    // 别把 boot 文档拽回 image。之后每次切模式都随工程存档，这位只在开机喂第一份文档。
    return { p: { ...p, mode: vidMode0 } };
  })());
  const [vidProject, setVidProject] = useState<VidProject>(() => vidSeedRef.current!.p);
  const vidProjectRef = useRef(vidProject); vidProjectRef.current = vidProject;
  // 屏幕上这份工程**属于哪份文档**。`vidProjectRef` 是 state 的镜像，切 tab 的那一帧会短暂
  // 停在上一份上（setVidProject 之后 React 才重渲）—— 存盘时向宿主要工程（blend-request-vid）、
  // 以及每一笔改动写进哪个桶，都要按归属判，不能拿"屏幕上正摆着的那份"当答案。
  const vidProjectOwner = useRef<number | null>(null);
  const [vidTransport] = useState(createVidTransport);
  // seek 走合流器：标尺拖动每发指针事件都进这里，合到 rAF 一帧一落（见 createSeekCoalescer）。
  // interactive 也在这一并带上 —— 上一版在这里丢了标记，拖标尺完全不走缩略条路径。
  const [vidSeek] = useState(() => createSeekCoalescer(vidTransport));
  const [vidPlaying, setVidPlaying] = useState(false);
  // 播放态的 ref:关键帧录制的触发回路(transport 订阅闭包)要在回调里读到"此刻在不在播",
  // 读 state 会拿 stale —— 走 ref。
  const vidPlayingRef = useRef(false);
  vidPlayingRef.current = vidPlaying;
  const [vidPps, setVidPps] = useState(60);
  // ── Inspector 的选中 ── Assets 窗点卡片产生,Inspector 窗照它放大看(图/音/视频都收,
  // 视频与音频用自己那条独立播放头,与主 transport 互不相识)。切换/关闭文档时清空:
  // 选中指向的是**那一份工程/那一次清单**里的卡,文档换了它就什么也不是了。
  const [vidInspect, setVidInspect] = useState<InspectSel | null>(null);
  useEffect(() => { setVidInspect(null); }, [blendDocs.activeUid]);
  // ── solo / mute ── 正身在**工程**里（VidProject.soloAudioIds / soloVideoIds / muteIds），
  // 这里只是包成 Set 给两扇窗用：切换时写回工程、随 .cud 落盘，刷新 / 重开文档后还亮着。
  // solo 音频/视频分开（一边亮不影响另一边）；mute 所有轨类型共用一套。删轨时 removeTrack
  // 会把对应 id 一并摘掉，所以这里不用再按 tracks 变化清 stale。
  const soloAudio = useMemo(() => new Set(vidProject.soloAudioIds ?? []), [vidProject.soloAudioIds]);
  const soloVideo = useMemo(() => new Set(vidProject.soloVideoIds ?? []), [vidProject.soloVideoIds]);
  const mute = useMemo(() => new Set(vidProject.muteIds ?? []), [vidProject.muteIds]);
  /** 视频模式下正在编辑的 Layer 段 key（'' = 游标不在任何 Layer 段上，图层集是文档主图层）。 */
  const [vidLayerKey, setVidLayerKey] = useState('');
  // Video 模式下活跃文档窗永远交出**工作台画布**（View 与整套 Image 模式工具都作用在它上面）：
  //  · 游标压在 Layer 段上 ⇒ 画布上就是那一段的图层（逐帧源帧折在同一张图上），Transform 可用；
  //  · 游标不在段上 ⇒ 画布内容换成当前视频帧（页面那张底片，1:1 铺满、不带图层 transform），
  //    编辑与 Transform 由页面挡掉 —— 这时没有对象可动。
  // 测量挂在 render 之外，拿不到 state 闭包，所以走 ref。
  const vidCanvasRef = useRef(false);
  vidCanvasRef.current = vidMode === 'video';
  // 工程里的"顺带状态"（范围、mute/solo）改完找机会落盘：拖一次把手会连发几十次改动 ——
  // 停手后再写，一次手势 = 一次盘。与"跑完一段自动保存"同一口径：工作台只对已绑过文件的
  // 文档写，没绑的它自己返回（不弹目录框）。
  const metaSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveVidSoon = useCallback((uid: number) => {
    if (metaSaveTimer.current) clearTimeout(metaSaveTimer.current);
    metaSaveTimer.current = setTimeout(() => {
      metaSaveTimer.current = null;
      if (activeUidRef.current !== uid) return;   // 已经切走别的文档：这一发不是它的了
      autoSaveCud();
    }, 700);
  }, [autoSaveCud]);
  // mute / solo 写回工程。**不进撤销摞**：它们是监视开关，不是编辑动作；但工程确实变了 ——
  // 置脏（tab 上的 ● / 关前询问）并落盘，否则刷新 / 重开 .cud 就回到旧的开关状态。
  const updateVidMeta = useCallback((fn: (p: VidProject) => VidProject) => {
    const uid = activeUidRef.current;
    const prev = vidProjectRef.current;
    const next = fn(prev);
    if (next === prev) return;
    vidProjectRef.current = next;
    setVidProject(next);
    if (uid != null) {
      vidByDoc.current.set(uid, next);
      markVidDirty(uid);
      saveVidSoon(uid);
    }
  }, [markVidDirty, saveVidSoon]);
  const toggleSolo = useCallback((trackId: string, kind: VidTrackKind) => {
    if (kind === 'layer' || kind === 'process') return;   // Layer / process 轨不接 solo
    const key = kind === 'audio' ? 'soloAudioIds' : 'soloVideoIds';
    updateVidMeta(p => {
      const cur = p[key] ?? [];
      return { ...p, [key]: cur.includes(trackId) ? cur.filter(id => id !== trackId) : [...cur, trackId] };
    });
  }, [updateVidMeta]);
  const toggleMute = useCallback((trackId: string) => {
    updateVidMeta(p => {
      const cur = p.muteIds ?? [];
      return { ...p, muteIds: cur.includes(trackId) ? cur.filter(id => id !== trackId) : [...cur, trackId] };
    });
  }, [updateVidMeta]);

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
    const prev = vidProjectRef.current;
    vidByDoc.current.set(uid, proj);
    vidProjectRef.current = proj;
    vidProjectOwner.current = uid;
    if (uid === activeUidRef.current) setVidProject(proj);
    markVidDirty(uid);
    vidEditAt.current = Date.now();
    bumpVidHist();
    if (proj.inPoint !== prev.inPoint || proj.outPoint !== prev.outPoint) saveVidSoon(uid);
  }, [markVidDirty, saveVidSoon]);
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
    // 底稿：**这个 uid 桶里的那份**。屏幕上那份可能还是上一份（切 tab 的那一帧、restore 还没到），
    // 拿它当底改出来的结果写进这一桶，就是把别人的轨道搬过来。
    const prev = (uid != null ? vidByDoc.current.get(uid) : undefined) ?? vidProjectRef.current;
    // 每一次工程变更都顺手收掉不再成立的生成器链接（拖开/裁开/删段/改轨）——
    // 自动断开只在这一处发生，读链的函数因此可以信任存档里的 chainPrev。
    const next = pruneVgenChains(fn(prev));
    if (next === prev) return;                 // 没变：不进历史、不置脏
    vidProjectRef.current = next;
    vidProjectOwner.current = uid;
    setVidProject(next);
    if (uid != null) {
      vidByDoc.current.set(uid, next);
      pushVidHist(uid, prev, label || 'Video edit');
      markVidDirty(uid);                       // tab 上的 ● 与工作台的关前询问，都靠这一笔
      // 范围改了就找机会落盘：.cud 是刷新后唯一的正身，不入盘的话重开就回到旧范围。
      if (next.inPoint !== prev.inPoint || next.outPoint !== prev.outPoint) saveVidSoon(uid);
    }
  }, [pushVidHist, markVidDirty, saveVidSoon]);
  // 文档切换 = 换一份 Video 工程。**工程的正身就在 .cud 里**（读档那趟由 blend-vid-restore 送回来），
  // 所以这里只做三件事：
  //   · 桶里已有 ⇒ 装回它那一份；
  //   · 没见过，且这是这次开机的**第一份**文档 ⇒ 用页面存档当起手（刷新后的落脚点）；
  //   · 其余 ⇒ 空白（等文件自己那份送来）。
  // 页面存档只喂一次：之后再打开/新建的文档都不继承它，否则时间线会从上一份凭空长过来。
  useEffect(() => {
    const uid = blendDocs.activeUid;
    if (uid == null) return;
    const map = vidByDoc.current;
    // 页面存档只属于**开机见到的第一份文档**，喂完就摘 —— 不管那一份此刻桶里有没有工程。
    // 老写法是"第一份**桶里还没有**的文档"才摘：开机那份要是先收到了文件里的工程
    // （blend-vid-restore 比文档播报先到，刷新恢复文档时就是这样），seed 就一直挂在手上，
    // 之后**跳到任何一份自己没有工程的 tab**（.cud 里没带 video 段的那种）都会被它灌上一份
    // 别人的时间线 —— 用户报的"切 cud tab 时 Tracks 的内容跟着搬过去"就是这个。
    const seed = vidSeedRef.current;
    if (seed) {
      vidSeedRef.current = null;
      if (!map.has(uid)) map.set(uid, seed.p);
    }
    if (!map.has(uid)) map.set(uid, defaultVidProject());
    const proj = map.get(uid)!;
    // 屏幕换了人：归属与 ref 当场钉住，别等 React 重渲那一帧（见 vidProjectOwner 的注释）。
    vidProjectOwner.current = uid;
    vidProjectRef.current = proj;
    setVidProject(proj);
    // 模式跟着工程走：打开哪份文档就落回它自己的 Image / Video 设置。
    syncVidMode(proj.mode === 'video' ? 'video' : 'image');
  }, [blendDocs.activeUid, syncVidMode]);
  // 文档关掉了 → 它那一桶（工程 + 脏标记）跟着走。uid 是工作台**每次开机从 1 重新发**的，
  // 留着旧的会在下一次复用同一个 uid 时串台（新文档凭空多出上一位的片段）。
  // 关掉的是**最后一份**时，屏幕上那份工程也必须一起走：Tracks / Assets 读的就是 vidProject，
  // 留着它就会出现"文档已经关了、时间线和资产还摆在那儿"—— 那两扇窗属于文档，不属于页面。
  // `announced` 之前开文档集是**未知**（还没播报），这时一个字都不能动，否则刷新时会把
  // 页面存档/刚送回来的工程当成"没有文档"清掉。
  useEffect(() => {
    if (!blendDocs.announced) return;
    const live = new Set(blendDocs.docs.map(d => d.uid));
    for (const uid of [...vidByDoc.current.keys()]) {
      if (!live.has(uid)) {
        vidByDoc.current.delete(uid);
        vidDirty.current.delete(uid);
        vidHist.current.delete(uid);       // uid 会被复用：旧步留着就会串到下一份文档上
      }
    }
    if (blendDocs.activeUid == null) {
      // 一份都不剩：播放停掉，工程换成空白（轨道回到默认那两条），别把上一份的片段留在屏幕上。
      setVidPlaying(false);
      setVidLayerKey('');
      vidByDoc.current.clear();
      vidDirty.current.clear();
      vidHist.current.clear();
      const empty = defaultVidProject();
      vidProjectRef.current = empty;
      vidProjectOwner.current = null;
      setVidProject(empty);
      vidEditAt.current = 0;
      layerEditAt.current = 0;
    }
    bumpVidHist();
  }, [blendDocs.docs, blendDocs.activeUid, blendDocs.announced]);
  // Layer 段合并的内容比较：宿主问页面「这几套图层是不是同一套内容」（见 blend-vid-layer-sig）。
  // 回包按 reqId 认领；页面不在 / 1.5s 没回 = 空表（调用方按"比较失败"处理，不合并）。
  const layerSigSeq = useRef(1);
  const layerSigWaiters = useRef(new Map<number, (sigs: Record<string, string>) => void>());
  // 关键帧录制的回包认领(与上面同一套 reqId/waiter 模式,见 blend-vid-kf-get)。
  const kfSeq = useRef(1);
  const kfWaiters = useRef(new Map<number, (snap: VidKfSnapshot | null) => void>());
  const kfTimers = useRef(new Map<number, number>());
  // Layer 段粘贴：请页面把源段那套图层**整套克隆**到新 key（见页面 copyLayerSetTo）。
  // 回包按 reqId 认领；页面不在 / 1.5s 没回 = false（调用方退回"共用同一套"，内容不丢）。
  const layerCopySeq = useRef(1);
  const layerCopyWaiters = useRef(new Map<number, (ok: boolean) => void>());
  // iframe 的两条 Video 消息：保存时按 uid 来要快照；读档/重开时把文件里那份送回桶里。
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; uid?: number; project?: unknown; files?: unknown; at?: number;
        reqId?: number; sigs?: Record<string, string>; ok?: boolean } | null;
      if (!d || typeof d.type !== 'string') return;
      if (d.type === 'blend-vid-layer-sig') {
        if (e.source !== blendIframeRef.current?.contentWindow) return;
        const rid = Math.round(Number(d.reqId) || 0);
        const finish = layerSigWaiters.current.get(rid);
        if (finish) {
          layerSigWaiters.current.delete(rid);
          finish(d.sigs && typeof d.sigs === 'object' ? d.sigs : {});
        }
        return;
      }
      if (d.type === 'blend-vid-kf') {
        if (e.source !== blendIframeRef.current?.contentWindow) return;
        const rid = Math.round(Number(d.reqId) || 0);
        const finish = kfWaiters.current.get(rid);
        if (finish) {
          kfWaiters.current.delete(rid);
          const layers = (d as { layers?: VidKfSnapshot['layers'] }).layers;
          finish(Array.isArray(layers) ? { layers } : null);
        }
        return;
      }
      if (d.type === 'blend-vid-layer-copied') {
        if (e.source !== blendIframeRef.current?.contentWindow) return;
        const rid = Math.round(Number(d.reqId) || 0);
        const finish = layerCopyWaiters.current.get(rid);
        if (finish) {
          layerCopyWaiters.current.delete(rid);
          finish(d.ok === true);
        }
        return;
      }
      if (d.type === 'blend-edited') {
        // 页面刚提交了一步图层动作（或刚撤销/重做了一步）：Ctrl+Z 从此归它，直到视频又被改动。
        layerEditAt.current = Number(d.at) || Date.now();
        return;
      }
      if (d.type === 'blend-request-vid') {
        const uid = Math.round(Number(d.uid) || 0);
        // 桶里那份是权威。桶里没有（刚切过来、播报还没到）才看屏幕 —— 而且只在这个 uid
        // **确实是屏幕上这份的归属**时给：否则会把上一份的轨道写进新文件的 header.video。
        const own = vidByDoc.current.get(uid);
        const screen = vidProjectOwner.current === uid ? vidProjectRef.current : null;
        (e.source as Window | null)?.postMessage({ type: 'blend-vid', uid, project: own ?? screen }, '*');
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
        if (uid === activeUidRef.current) {
          vidProjectOwner.current = uid;
          vidProjectRef.current = proj;
          setVidProject(proj);
          // 文件里带的模式跟着落地：打开这份 .cud 就显示它自己的设置。
          syncVidMode(proj.mode === 'video' ? 'video' : 'image');
        }
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
              { src: ing.src, name: ing.name, origin: 'file', asset: ing.asset, play: ing.play },
              { duration: ing.duration, hasAudio: ing.hasAudio, audioOnly: ing.audioOnly },
              null, vidTransport.get()), 'Add clip');
          }
        })();
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
    // syncVidMode 恒稳（[] 依赖）：写进来只是给 lint 看，订阅不会因此重建。
  }, [syncVidMode]);
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
  // ── Processor 的 Allow List 视频路（宿主自己发的那一趟）─────────────────────────────
  // Blend 页那条跑法吃的是画布 / 图层 / 工作区，视频不在它那边 —— 所以视频模式下
  // （Allow List 开着）Run 由宿主接手：每个 image/mask 入口按 Processor 窗里挑的源
  // （Tracks / Sel. Track / Asset，挑选值见 video/procPicks）解析出一段源窗口，按帧抽成
  // 一列（后端 ffmpeg 直读资产库，不绕浏览器；MASK 口后端自动亮度转 mask），接口按
  // list_mode 跑（INPUT_IS_LIST 的节点直通整列、其余逐帧跑再合并），每个出口的那一列
  // 按挑的去处落位（New Track / Asset）。
  // 大视频**分段跑**：一列几百帧的 float32 动辄几百 MB（抽帧前虽已缩到长边 720，条数
  // 才是内存大头），所以按段切 —— 每段独立抽帧/执行/编码，峰值只由单段帧数决定；
  // 产物在新轨上首尾相接。段边界按帧数切，帧间状态（temporal 类节点）不跨段。
  // **输入范围与每段帧数都由用户每次运行时定**（VidSegModal）—— 喂哪一段、内存/耗时
  // 的权衡该由调用的人拍板。
  const SEG_MAX_FRAMES = 150;   // 单段帧数上限（内存预算；modal 的输入范围也是它）
  const SEG_TOTAL_CAP = 36000;  // 范围总帧数上限（≈20 分钟 @30fps；按选中的范围查）
  const vidProcBusy = useRef(false);
  // Cancel 插旗：原本那颗 Cancel 按钮（RunStatusSeg → cancelActiveRun）落这面旗 + /api/cancel_run。
  // 旗子让分段循环不再开下一段、轮询不再收当前段；后端那半边由 ComfyUI 的 interrupt 打断在飞的
  // 执行（InterruptProcessingException → interface_status 回 idle）。
  const vidCancelRef = useRef(false);
  // 单段 ■ 的插旗：只打断**这一段**（后端照样 interrupt 当前执行），队列里后面的段继续跑。
  // 值 = 目标段 clipId；与 vidCancelRef 同时亮，收尾时按它把 cancelled 认成 stopped。
  const vidStopRef = useRef<string | null>(null);
  // 视频 list 跑的进度条与 Cancel 走**原本那一条**：写进 BlendUi 快照的 staging 段（与 detailer /
  // 图像模式 Processor 同一个真值源），RunStatusSeg 原样读、原样画 —— 不另起一套。跑动期间页面
  // 推来的快照由 App 侧按 vidStagingOverlay（getVidStagingOverlay(uid)）合流，不会被冲掉。
  const pushVidStaging = (patch: { busy?: boolean; cancelLive?: boolean; progress?: number }) => {
    const uid = getActiveBlendUid();
    if (uid === null) return;
    const ui = getBlendUi();
    setBlendUi(uid, { ...ui, staging: { ...ui.staging, ...patch } });
  };
  // 原本那颗 Cancel 的去向：视频 list 跑在飞就打断它；否则照旧走页面的 staging-cancel。
  const cancelActiveRun = useCallback(() => {
    if (vidProcBusy.current) {
      vidCancelRef.current = true;
      fetch('/api/cancel_run', { method: 'POST' }).catch(() => {});
      return;
    }
    onBlendUiCommand('staging-cancel');
  }, [onBlendUiCommand]);
  // 分段配置 modal 的上下文：**锚源**（第一行的源窗口）+ 帧数总量。modal 里的输入范围
  // 就是锚的时间线跨度；其余行跟着同一段时间线窗口走（Asset 行从自己头上起喂同样时长）。
  // `ports` = 这一趟会写到输出轨的口，modal 据此把目标槽位的占用情况算出来（占着就置灰 Run）。
  const [vidSegCfg, setVidSegCfg] = useState<{ name: string; start: number; duration: number; total: number; fps: number; kind: 'clip' | 'asset'; ports: number[] } | null>(null);
  // 占位段设置 modal：打开时记下这一批 id（时间线多选的选择集在打开那一刻定住 —— 之后
  // 时间线里点选变化不该把 modal 的作用对象偷换掉）。
  const [procSettingsIds, setProcSettingsIds] = useState<string[] | null>(null);
  // 视频 list 跑的公共前置：接口选中、每个 image/mask 入口解析出源窗口。返回字符串 =
  // 拒绝原因（播报用），对象 = 可以跑。总帧数上限不在这里卡 —— 范围由用户在 modal 里
  // 圈，大片段圈一小段完全合理；cap 按**选中的范围**查（modal 里禁用 Run，宿主开跑前
  // 再兜一次）。
  type VidRowSrc =
    | { kind: 'clip'; port: number; type: string; clip: VidClip }
    | { kind: 'asset'; port: number; type: string; asset: VidAsset };
  const prepVidProcRun = (): string | {
    proc: BlendProcessorUi; iface: InterfaceInfo; idx: number; fps: number;
    rows: VidRowSrc[];
    anchor: { name: string; start: number; span: number; total: number; kind: 'clip' | 'asset' };
  } => {
    const proc = getBlendUi().processor;
    const idx = proc.choice >= 0 && proc.choice < proc.indices.length ? proc.indices[proc.choice] : -1;
    const iface = idx >= 0 ? interfaces[idx] : undefined;
    if (!iface) return 'No processor interface is chosen.';
    const inRows = proc.inputs.filter(r => r.type === 'IMAGE' || r.type === 'MASK');
    if (!inRows.length) return `「${iface.name}」 has no image or mask inputs — nothing for the video run to feed.`;
    const picks = getVidProcPicks();
    const proj = vidProjectRef.current;
    const fps = proj.fps;
    const t = vidTransport.get();
    // 游标底下的视频片段：给定轨（或从最上面的轨往下找）取第一段盖住游标的。
    const clipAt = (trackId?: string): VidClip | undefined => {
      const tracks = trackId ? proj.tracks.filter(tr => tr.id === trackId) : proj.tracks;
      for (const tr of tracks) {
        if (tr.kind !== 'video') continue;
        const c = proj.clips.find(c => c.trackId === tr.id && c.kind === 'video'
          && t >= c.start && t < c.start + c.duration);
        if (c) return c;
      }
      return undefined;
    };
    const rows: VidRowSrc[] = [];
    for (const row of inRows) {
      const src = picks.src[String(row.num)] || 'tracks';
      if (src === 'asset') {
        const id = picks.asset[String(row.num)];
        const asset = proj.assets.find(a => a.kind === 'video' && a.id === id)
          || proj.assets.find(a => a.kind === 'video');
        if (!asset) return `No video asset in the library for input 「${row.name}」 — import one first.`;
        rows.push({ kind: 'asset', port: row.num, type: row.type, asset });
      } else {
        const trackId = src === 'sel_track' ? picks.track[String(row.num)] : undefined;
        const clip = clipAt(trackId);
        if (!clip) {
          return src === 'sel_track'
            ? `No video clip under the playhead on the picked track for input 「${row.name}」.`
            : 'No video clip under the playhead — move the playhead onto one first.';
        }
        rows.push({ kind: 'clip', port: row.num, type: row.type, clip });
      }
    }
    // 锚 = 第一行的源窗口：modal 里的输入范围就是它的时间线跨度。total 用 floor（+容差）：
    // 容器元数据的时长常常不落在帧网格上（33.685s @30fps），round 会向上取整出一段
    // 源根本覆盖不了的范围，"Full clip" 默认值自己就能触发 doesn't-cover 报错。
    const first = rows[0];
    const anchor = first.kind === 'clip'
      ? { name: first.clip.name, start: first.clip.start, span: first.clip.duration, total: Math.floor(first.clip.duration * fps + 1e-6), kind: 'clip' as const }
      : { name: first.asset.name, start: 0, span: first.asset.duration, total: Math.floor(first.asset.duration * fps + 1e-6), kind: 'asset' as const };
    return { proc, iface, idx, fps, rows, anchor };
  };
  // `fps` 只有生成器那条路会报（VIDEO 产物自带帧率；Processor 那条路的帧率就是抽帧帧率）。
  /** 一段产物的回执。`stitched` = 这一口是**图片口**：帧回来之后由后端按 fps 现编成一段。 */
  type SegMeta = { port: number; type: string; name: string; video: string; frames?: number; fps?: number; stitched?: boolean };
  // 跑一段 Processor：POST → 轮询 → 收这一段的视频产物。整趟分段跑与占位续跑共用这一条 ——
  // 轮询口径与宿主那条 processor 相同（started 后第一次 status 可能还是 idle，所以 idle
  // 不算收尾；10 分钟没动静就当失败，别让这一趟永远挂在 running）。取消旗子在轮询的
  // 每个间隙都查 —— 插上旗就不等了；进度写进原本那条快照的 staging 段。
  const executeSeg = useCallback(async (
    ifaceIdx: number,
    manualValues: Record<string, unknown>,
    videoInputs: Record<string, ProcFrameWindow>,
    segMsg: string, segAt: number, segCount: number,
    onSegProgress?: (segP: number) => void,
    /** 换掉整包 exec_options（video generator 那条路用它：不吃视频帧，只喂首末帧）。 */
    execOverride?: Record<string, unknown>,
  ): Promise<SegMeta[]> => {
    const setSegProgress = (segP: number) => {
      const p = segCount > 1 ? (segAt + segP) / segCount : segP;
      setVidStagingOverlay({ progress: p });
      pushVidStaging({ progress: p });
      onSegProgress?.(segP);
    };
    const segOverlayProgress = segCount > 1 ? segAt / segCount : -1;
    setVidStagingOverlay({ busy: true, progress: segOverlayProgress });
    pushVidStaging({ busy: true, cancelLive: true, progress: segOverlayProgress });
    setVidProcRun({ state: 'running', msg: segMsg });
    await fetch('/api/execute_interface', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interface_index: ifaceIdx,
        manual_values: manualValues,
        exec_options: execOverride ?? { offline: true, list_mode: true, video_inputs: videoInputs },
      }),
    });
    const deadline = Date.now() + 10 * 60 * 1000;
    let seenRunning = false;
    for (;;) {
      await new Promise(r => setTimeout(r, 500));
      if (vidCancelRef.current) throw new Error('cancelled');
      const st = await fetch('/api/status').then(r => r.json()).catch(() => null);
      if (!st) { if (Date.now() > deadline) throw new Error('timed out — check the ComfyUI console.'); continue; }
      const s = st.interface_status || 'idle';
      if (s === 'running') {
        seenRunning = true;
        // 段内步进：后端把 interface 执行的 on_progress 写在 /api/status 上（0..1）。
        setSegProgress(Math.max(0, Math.min(1, Number(st.interface_progress) || 0)));
        continue;
      }
      if (s === 'idle' && !seenRunning) { if (Date.now() > deadline) throw new Error('timed out — check the ComfyUI console.'); continue; }
      if (s === 'done' || s === 'error' || s === 'idle') {
        // Cancel 打断的收尾（后端把 InterruptProcessingException 转成 idle、错误清空）：
        // 旗子说了算 —— 一律按"取消"报。
        if (vidCancelRef.current) throw new Error('cancelled');
        if (s !== 'done') {
          throw new Error(`Processor failed: ${st.interface_error || 'unknown error'}`);
        }
        const meta = (st.interface_result_meta || []) as SegMeta[];
        const vids = meta.filter(m => m && m.video);
        if (!vids.length) throw new Error('Processor finished with no video results.');
        return vids;
      }
    }
  }, []);

  const runVideoListProcessor = useCallback(async (segFrames: number, inFrame: number, outFrame: number) => {
    if (vidProcBusy.current) return;
    const prep = prepVidProcRun();
    if (typeof prep === 'string') { setVidProcRun({ state: 'error', msg: prep }); return; }
    const { proc, iface, idx, fps, rows, anchor } = prep;
    // 输入范围（modal 里已按帧网格取整，这里再夹一次防越界）：[f0, f1) 帧，相对锚起点。
    // 范围是用户圈的 —— 大片段只喂一小段时总量远低于整段，cap 按范围查。
    const f0 = Math.max(0, Math.min(anchor.total, Math.round(inFrame)));
    let f1 = Math.min(anchor.total, Math.round(outFrame));
    // 出点按每行**实际覆盖**再夹一刀（floor + 半帧容差），超出不报错、按能覆盖的最大帧数
    // 算 —— modal 的出点经过秒数文本（fmt 两位小数）与 round 的两次取整，任一步向上都会
    // 超出源尾零点几秒；用户手填超了也一样，有多少喂多少。夹完为空走下面统一的空范围报错。
    for (const row of rows) {
      const covEnd = row.kind === 'clip'
        ? Math.floor((row.clip.start + row.clip.duration - anchor.start) * fps + 1e-6)
        : Math.floor(row.asset.duration * fps + 1e-6);
      if (f1 > covEnd) f1 = Math.max(f0, covEnd);
    }
    if (f1 <= f0) {
      setVidProcRun({ state: 'error', msg: 'The input range is empty — pick an out point after the in point.' });
      return;
    }
    const rangeFrames = f1 - f0;
    const rangeSec = rangeFrames / fps;
    if (rangeFrames > SEG_TOTAL_CAP) {
      setVidProcRun({ state: 'error', msg: `That range is ${rangeFrames} frames — the cap is ${SEG_TOTAL_CAP} (about 20 min at 30fps). Pick a shorter range.` });
      return;
    }
    // 参数只报"填过的"那些口：空着 = 不报，后端拿图里派生出来的默认值跑（与 Blend 页
    // runProcessor 同一口径）。bool 恒报（false 也是填过的）；枚举恒报当前候选。
    const manual_values: Record<string, unknown> = {};
    for (const row of proc.params) {
      if (row.kind === 'bool') manual_values[String(row.num)] = row.on;
      else if (row.kind === 'number') { if (row.value !== '') manual_values[String(row.num)] = Number(row.value); }
      else if (row.kind === 'choices' || row.kind === 'select') { if (row.cur) manual_values[String(row.num)] = row.cur; }
      else if (row.value !== '') manual_values[String(row.num)] = row.value;
    }
    // 分段：帧数由用户在 modal 里定（每次运行自己拍板内存/耗时），夹到 [1, SEG_MAX_FRAMES]。
    // 段参数按 seg/fps 切，从范围入点起算，最后一段夹到范围尾（可能不足）。
    const seg = Math.max(1, Math.min(SEG_MAX_FRAMES, Math.round(segFrames)));
    const nSegs = Math.ceil(rangeFrames / seg);
    // 每行把时间线范围映射到自己的源窗口：轨道行 = offset + (T - clip.start)，范围必须
    // 整段落在这行的片段跨度里；资产行 = 锚自己时 T 就是源内秒、别行从头上起喂
    // （T - 锚起点），资产得比范围长。base = 范围入点在这行源里的秒数，end = 源尾。
    const anchorT0 = anchor.start + f0 / fps;   // 范围入点（时间线，也是产物落位起点）
    const anchorT1 = anchor.start + f1 / fps;   // 范围出点
    const specs: { port: number; file: string; base: number; end: number }[] = [];
    for (const row of rows) {
      if (row.kind === 'clip') {
        const c = row.clip;
        if (anchorT0 < c.start - 1e-6 || anchorT1 > c.start + c.duration + 1e-6) {
          setVidProcRun({ state: 'error', msg: `「${c.name}」 doesn't cover the range (${anchorT0.toFixed(1)}s–${anchorT1.toFixed(1)}s) — move the playhead or shorten the range.` });
          return;
        }
        specs.push({ port: row.port, file: c.src.split('/').pop() || '', base: c.offset + (anchorT0 - c.start), end: c.offset + c.duration });
      } else {
        const a = row.asset;
        const base = anchor.kind === 'asset' ? anchorT0 : 0;
        if (base + rangeSec > a.duration + 1e-6) {
          setVidProcRun({ state: 'error', msg: `Asset 「${a.name}」 is ${a.duration.toFixed(1)}s — shorter than the ${rangeSec.toFixed(1)}s range. Pick a shorter range or a longer asset.` });
          return;
        }
        specs.push({ port: row.port, file: a.src.split('/').pop() || '', base, end: a.duration });
      }
    }

    // 去处在开跑前定死（挑选值快照一次，跑的过程中用户再拨输出口开关也不改这趟落位）：
    // New Track 的口先摆「输出轨 + process 占位轨」，产物逐段落到输出轨；Asset 的口照旧
    // 整趟跑完一次入库。输出轨的槽位在开跑前先查一遍 —— 被别的东西占着就不开跑
    // （modal 里 Run 已置灰，这里是兜底：modal 打开期间用户可能往那条轨上拖了片段）。
    const picks = getVidProcPicks();
    const outNames = new Map(proc.outputs.map(o => [o.num, o.name]));
    const trackedPorts = new Set(proc.outputs
      .filter(o => (picks.dst[String(o.num)] || 'new_track') !== 'asset').map(o => o.num));
    const busyPort = [...trackedPorts].find(port => procSlotBusy(vidProjectRef.current, port, anchorT0, rangeSec));
    if (busyPort !== undefined) {
      setVidProcRun({ state: 'error', msg: `The output track already has a clip over ${anchorT0.toFixed(1)}s–${anchorT1.toFixed(1)}s — move or delete it first.` });
      return;
    }

    vidProcBusy.current = true;
    beginVidProcRun(getActiveBlendUid());
    // 同一趟 Run 的所有占位共用一颗 runId —— 播报统计/续跑按它认亲。
    const runId = `proc-${Date.now()}`;
    // 输出口 → 各段占位的 clip id（下标 = 段号）：跑完一段按它找到坑来替换。
    const placeholderIds = new Map<number, string[]>();
    try {
      // New Track 的口：Run 确认的**当下**就开「输出轨 + process 轨」并摆占位（每段一个坑、
      // 预分配空间）。一步历史（'Run processor'）—— 撤销它连输出轨带占位整个收走。
      if (trackedPorts.size) {
        const plans = [...trackedPorts].map(port => ({
          port,
          name: outNames.get(port) || `value${port}`,
          segs: Array.from({ length: nSegs }, (_, i) => {
            const n = Math.max(1, Math.min(seg, rangeFrames - i * seg));
            // 帧段：f0 = 源文件内按工程 fps 的整数起始帧号。相邻段按整数 +seg 步进，
            // 首尾天然相接 —— 不再有"秒数取整跨段重复/跳帧"这回事。
            const video_inputs: Record<string, ProcFrameWindow> = {};
            for (const s of specs) {
              const f0 = Math.max(0, Math.floor(s.base * fps + 1e-6) + i * seg);
              const avail = Math.floor(s.end * fps + 1e-6) - f0;
              video_inputs[String(s.port)] = { file: s.file, f0, n: Math.max(1, Math.min(n, avail)), fps };
            }
            return { start: anchorT0 + (i * seg) / fps, duration: n / fps, segIndex: i, segCount: nSegs, inputs: video_inputs };
          }),
        }));
        vidUpdate(proj => plans.reduce((acc, pl) => placeProcPlaceholders(acc, {
          name: pl.name, runId, port: pl.port, iface: iface.name, ifaceNum: idx,
          params: manual_values, segs: pl.segs,
        }), proj), 'Run processor');
        // 占位 id 就地收集（vidUpdate 同步换 ref，此刻已是新工程）；按下标放。
        vidProjectRef.current.clips.forEach(c => {
          if (!c.pending || c.pending.runId !== runId) return;
          const arr = placeholderIds.get(c.pending.port) || [];
          arr[c.pending.segIndex] = c.id;
          placeholderIds.set(c.pending.port, arr);
        });
      }

      // 逐段跑：每段完成把产物落到**输出轨的对应位置**（占位段原地保留，可以反复重跑；
      // 每段一步撤销）；Asset 口的产物攒着，整趟结束一次入库。段失败/取消不再"整趟全丢"
      // —— 已完成的段留在输出轨上，没跑的占位保持待跑，点占位上的 ▶ 按快照单独续跑那一段。
      const perAsset = new Map<number, SegMeta[]>();
      for (let i = 0; i < nSegs; i++) {
        const n = Math.max(1, Math.min(seg, rangeFrames - i * seg));
        const video_inputs: Record<string, ProcFrameWindow> = {};
        for (const s of specs) {
          const f0 = Math.max(0, Math.floor(s.base * fps + 1e-6) + i * seg);
          const avail = Math.floor(s.end * fps + 1e-6) - f0;
          video_inputs[String(s.port)] = { file: s.file, f0, n: Math.max(1, Math.min(n, avail)), fps };
        }
        const segMsg = nSegs === 1
          ? `Running 「${iface.name}」 on ${rangeFrames} frames…`
          : `「${iface.name}」 segment ${i + 1}/${nSegs} (${n} frames)…`;
        // 占位段自己的填充进度：这一段所有口的坑一起充满（segP 是段内 0..1）。
        const segFillIds = [...placeholderIds.entries()].flatMap(([, ids]) => ids[i] ? [ids[i]] : []);
        segFillIds.forEach(id => setProcFill(id, 0));
        let vids: SegMeta[];
        try {
          vids = await executeSeg(idx, manual_values, video_inputs, segMsg, i, nSegs, segP => {
            segFillIds.forEach(id => setProcFill(id, segP));
          });
        } catch (e: unknown) {
          segFillIds.forEach(id => clearProcFill(id));
          throw new Error(nSegs > 1
            ? `segment ${i + 1}/${nSegs}: ${e instanceof Error ? e.message : String(e)}`
            : (e instanceof Error ? e.message : String(e)));
        }
        segFillIds.forEach(id => clearProcFill(id));
        // 这段的产物按口分流：有占位的落到输出轨上（一次 updater 把这一段所有口都落上），
        // 其余（Asset 口 / 占位被用户删掉的口）攒进入库清单。
        const fills = vids.filter(m => placeholderIds.get(m.port)?.[i]);
        const rest = vids.filter(m => !placeholderIds.get(m.port)?.[i]);
        if (fills.length) {
          vidUpdate(proj => fills.reduce((acc, m) => placeProcOutput(
            acc, placeholderIds.get(m.port)![i], m.video as string,
            outNames.get(m.port) || m.name || `value${m.port}`, (m.frames || n) / fps,
          ), proj), nSegs > 1 ? `Processor segment ${i + 1}/${nSegs}` : 'Processor → output');
          autoSaveCud();              // 一段落位 = 工程变了：已落盘的 .cud 立刻跟上一版
        }
        for (const m of rest) {
          const arr = perAsset.get(m.port);
          if (arr) arr.push(m); else perAsset.set(m.port, [m]);
        }
        ringSegmentDone();          // 这一段跑完了：桌面端开着 Tinkle 就响一声
      }
      if (perAsset.size) {
        const assetPlans = [...perAsset.entries()].map(([port, segs]) => ({
          name: outNames.get(port) || segs[0].name || `value${port}`,
          segs: segs.map(m => ({ src: m.video as string, duration: (m.frames || seg) / fps })),
        }));
        vidUpdate(proj => assetPlans.reduce((acc, pl) =>
          placeProcAssets(acc, { name: pl.name, segs: pl.segs }), proj), 'Processor → assets');
        autoSaveCud();                // 整趟收尾的入库也写进去
      }
      const parts: string[] = [];
      if (trackedPorts.size) parts.push(`${trackedPorts.size} output track${trackedPorts.size === 1 ? '' : 's'} filled segment by segment`);
      if (perAsset.size) parts.push(`${perAsset.size} port${perAsset.size === 1 ? '' : 's'} added to the asset library`);
      setVidProcRun({ state: 'done', msg: `Done — ${parts.join(', ') || 'nothing to place'}${nSegs > 1 ? `, ${nSegs} segments each` : ''}.` });
    } catch (e: unknown) {
      // 失败/取消都不是"什么都没放"：已完成的段已经落在输出轨上，没跑的占位还揣着快照
      // 待跑 —— 播报把"还剩几个坑"说清，用户点占位继续。
      const left = vidProjectRef.current.clips.filter(c => c.pending && c.pending.runId === runId).length;
      const tail = left ? ` — ${left} placeholder segment${left === 1 ? '' : 's'} left on the timeline; click one to continue.` : '';
      setVidProcRun(vidCancelRef.current
        ? { state: 'cancelled', msg: `Processor run cancelled${tail}` }
        : { state: 'error', msg: `Processor failed — ${e instanceof Error ? e.message : String(e)}${tail}` });
    } finally {
      // 撤掉原本那条 seg：快照 staging 段回 idle（页面之后的 push 也不再被覆盖）。
      setVidStagingOverlay({ busy: false, progress: -1 });
      pushVidStaging({ busy: false, cancelLive: false, progress: -1 });
      vidCancelRef.current = false;
      vidProcBusy.current = false;
      endVidProcRun();
    }
  }, [interfaces, vidTransport, vidUpdate, autoSaveCud]);

  // ── Video Generator ────────────────────────────────────────────────────────────────────
  // 一台"视频生成器"就是一个开了 Video Generator 的 interface：Interface tab 里那八个固定槽
  // 各绑了一个端口，于是**段**这一侧不必认识任何具体接口 —— 它只知道"提示词往哪口喂、宽高
  // 时长帧率往哪口喂、首末帧往哪口喂、产物从哪口回来"。段自己揣着这份绑定与参数（快照），
  // 所以接口后来改了绑定、老段仍然按自己当时那份跑。
  /** Video Generator 那份配置以 **interfaceMeta（本地真值）** 为准：interfaces 是后端快照，
   *  拨开关 / 绑槽只 POST 配置、不重拉 /api/interfaces —— 照它判会把刚打开的 Fixed FPS 当成
   *  没开、于是又把 fps 算进必绑槽，Add segment 就永远灰着（正是这么坏过一次）。 */
  const vgenCfgOf = useCallback((itf: InterfaceInfo): VideoGenConfig =>
    interfaceMeta[itf.name]?.video_gen || itf.video_gen || { ports: {} }, [interfaceMeta]);

  const videoGenList = useMemo(() => interfaces.map((itf, index) => ({ itf, index }))
    .filter(({ itf }) => (interfaceMeta[itf.name]?.modes?.video_generator
      ?? itf.modes?.video_generator) === true)
    .map(({ itf, index }) => {
      const cfg = vgenCfgOf(itf);
      const missing = videoGenMissing(cfg);
      return {
        name: itf.name, index,
        ports: cfg.ports || {}, fixed_fps: !!cfg.fixed_fps,
        fixed_fps_value: cfg.fixed_fps ? (Number(cfg.fixed_fps_value) || 16) : undefined,
        missing: missing as string[],
        /** 必绑的槽都绑齐了才能跑（Fixed FPS 开着时 fps 不算必绑 —— 那一口本来就不该绑）。 */
        ready: missing.length === 0,
      };
    }), [interfaces, vgenCfgOf]);

  /** 段上那些参数的**默认值**：端口自己在图里带着的那一份（widget 默认值）优先，
   *  没有就退一个说得过去的兜底（宽高 512、时长 2s、帧率 = 工程帧率）。 */
  const vgenDefaults = useCallback((itf: InterfaceInfo, ports: VideoGenConfig['ports'],
    projFps: number): { params: Record<string, unknown>; duration: number } => {
    const valueOf = (num?: number): unknown => {
      if (!num) return undefined;
      const p = itf.start_ports?.find(x => x.num === num);
      return p ? p.value : undefined;
    };
    const numOf = (slot: VideoGenSlot, dflt: number): number => {
      const v = Number(valueOf(ports[slot]));
      return Number.isFinite(v) && v > 0 ? v : dflt;
    };
    const params: Record<string, unknown> = {};
    if (ports.width) params[String(ports.width)] = Math.round(numOf('width', 512));
    if (ports.height) params[String(ports.height)] = Math.round(numOf('height', 512));
    if (ports.duration) params[String(ports.duration)] = numOf('duration', 2);
    // Fixed FPS 开着时 fps 槽不绑（帧率是整台生成器写死的），这里也就没有值要喂。
    if (ports.fps) params[String(ports.fps)] = numOf('fps', projFps);
    if (ports.prompt) {
      const v = valueOf(ports.prompt);
      params[String(ports.prompt)] = typeof v === 'string' ? v : '';
    }
    const duration = Number(params[String(ports.duration ?? '')]) || 2;
    return { params, duration: Math.max(0.1, duration) };
  }, []);

  /** 往生成器轨上摆一段（播放头处）。参数用端口默认值打底，之后在段上改。 */
  const addVideoGenSegment = useCallback((ifaceIndex: number) => {    const itf = interfaces[ifaceIndex];
    if (!itf) return;
    const cfg = vgenCfgOf(itf);
    const ports = cfg.ports || {};
    const missing = videoGenMissing(cfg);
    if (missing.length) {
      setVidProcRun({ state: 'error', msg: `「${itf.name}」 still needs ${missing.join(', ')} bound in the Interface tab.` });
      return;
    }
    const { params, duration } = vgenDefaults(itf, ports, vidProjectRef.current.fps);
    const start = Math.max(0, vidTransport.get());
    if (procSlotBusy(vidProjectRef.current, ports.video ?? 0, start, duration)) {
      setVidProcRun({ state: 'error', msg: `The output track already has a clip at ${start.toFixed(1)}s — move it or add the segment elsewhere.` });
      return;
    }
    vidUpdate(proj => placeVideoGenSegment(proj, {
      name: itf.name, runId: `vgen-${Date.now()}`, port: ports.video ?? 0,
      iface: itf.name, ifaceNum: ifaceIndex, ports, fixed_fps: !!cfg.fixed_fps,
      fixed_fps_value: cfg.fixed_fps ? (Number(cfg.fixed_fps_value) || 16) : undefined,
      params, start, duration,
    }), 'Add video generator');
    setVidProcRun({ state: 'idle', msg: '' });
  }, [interfaces, vgenCfgOf, vgenDefaults, vidUpdate, vidTransport]);

  // ── Add continue segment ── 时间线上恰好选中一枚**视频段**时可用:把那段视频的尾帧
  // 抓下来(全分辨率、精确 seek)、入资产仓库拿哈希,作为一台生成器新段的首帧,新段就摆
  // 在这段正后方 —— 生成器接着这段的画面往下画。选中态来自跨窗 store(Timeline 抄进来)。
  const addContinueVgenSegment = useCallback(async (ifaceIndex: number) => {
    const itf = interfaces[ifaceIndex];
    if (!itf) return;
    const cfg = vgenCfgOf(itf);
    const ports = cfg.ports || {};
    if (!ports.first_frame) {
      setVidProcRun({ state: 'error', msg: `「${itf.name}」 has no First frame port bound — bind it in the Interface tab first.` });
      return;
    }
    const missing = videoGenMissing(cfg);
    if (missing.length) {
      setVidProcRun({ state: 'error', msg: `「${itf.name}」 still needs ${missing.join(', ')} bound in the Interface tab.` });
      return;
    }
    const sel = getVidSelection();
    const clip = sel.size === 1 ? vidProjectRef.current.clips.find(c => sel.has(c.id)) : undefined;
    if (!clip || clip.kind !== 'video') {
      setVidProcRun({ state: 'error', msg: 'Select one video segment on the timeline first (exactly one, a real video clip).' });
      return;
    }
    setVidProcRun({ state: 'running', msg: `Grabbing the last frame of 「${clip.name}」…` });
    // 尾帧 = 源内 offset+duration 的前一刻(0.04s ≈ 一帧内,精确 seek 不是关键帧级)。
    const dataurl = await grabFrameFull(clip.src, Math.max(0, clip.offset + clip.duration - 0.04));
    if (!dataurl) {
      setVidProcRun({ state: 'error', msg: `Could not grab the last frame of 「${clip.name}」 — the source may be missing (relink it in Assets).` });
      return;
    }
    setVidProcRun({ state: 'running', msg: 'Importing the frame into the asset store…' });
    const frameName = `${clip.name} · last frame`;
    let hash = '';
    try {
      const res = await fetch('/api/asset_import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: [dataurl], names: [frameName], library: true, origin: 'run' }),
      });
      const j = await res.json();
      hash = j?.ok && j?.added?.[0]?.id ? String(j.added[0].id) : '';
    } catch { hash = ''; }
    if (!hash) {
      setVidProcRun({ state: 'error', msg: 'The asset store refused the frame — check the backend log.' });
      return;
    }
    bumpAssets();
    const { params, duration } = vgenDefaults(itf, ports, vidProjectRef.current.fps);
    const start = clip.start + clip.duration;
    if (procSlotBusy(vidProjectRef.current, ports.video ?? 0, start, duration)) {
      setVidProcRun({ state: 'error', msg: `The output track already has a clip at ${start.toFixed(1)}s — move it before adding the continue segment.` });
      return;
    }
    vidUpdate(proj => placeVideoGenSegment(proj, {
      name: itf.name, runId: `vgen-${Date.now()}`, port: ports.video ?? 0,
      iface: itf.name, ifaceNum: ifaceIndex, ports, fixed_fps: !!cfg.fixed_fps,
      fixed_fps_value: cfg.fixed_fps ? (Number(cfg.fixed_fps_value) || 16) : undefined,
      params, start, duration,
      first_frame: { kind: 'asset', hash, name: frameName },
    }), 'Add continue segment');
    setVidProcRun({ state: 'done', msg: `Continue segment placed at ${start.toFixed(1)}s — it starts from 「${clip.name}」's last frame.` });
  }, [interfaces, vgenCfgOf, vgenDefaults, vidUpdate]);

  /** 跑一段生成器（只这一段）：段上那套参数原样进 interface，首末帧（含从链上前段共享来的）
   *  喂进它们那一口，产物落到输出轨的对应位置。调用方负责忙碌闸门与进度条收尾。 */
  const execVgenClip = useCallback(async (clipId: string): Promise<{
    dur: number; frames: number; stitched: boolean;
  }> => {
    const proj = vidProjectRef.current;
    const clip = proj.clips.find(c => c.id === clipId);
    const v = clip?.vgen;
    if (!clip || !v) throw new Error('The generator segment is gone.');
    const byName = interfaces.findIndex(i => i.name === v.iface);
    const idx = byName >= 0 ? byName : v.ifaceNum;
    if (idx < 0 || idx >= interfaces.length) {
      throw new Error(`「${v.iface}」 is not connected (package disconnected?).`);
    }
    // 共享帧在**跑的这一刻**才解析：前段可能刚在这一趟里跑完，产物才落位。
    const { image_keys, chain_frames } = vgenFrameInputsOf(proj, clip);
    // 分辨率也是跑的这一刻才定：轨上开了 from canvas 就按当下的画布 × scale 覆写宽高口；
    // 轨上没设置过（老存档）就沿用段上那份旧参数。
    const res = vgenResolutionOf(proj, clip, getBlendUi().canvas);
    let params = v.params;
    if (res) {
      if (v.ports.width) params = { ...params, [String(v.ports.width)]: res.w };
      if (v.ports.height) params = { ...params, [String(v.ports.height)]: res.h };
    }
    // 帧率同样按轨走：轨上设了 fps 就覆写 fps 口 —— 但 **Fixed FPS 的段不吃这个**
    // （它的输出帧率写死在生成器上，轨上的数喂进去是误会）。
    const trackFps = vgenFpsOf(proj, clip);
    if (trackFps && v.ports.fps && !v.fixed_fps) {
      params = { ...params, [String(v.ports.fps)]: trackFps };
    }
    setProcFill(clipId, 0);
    try {
      const metas = await executeSeg(idx, params, {}, `Generating with 「${v.iface}」…`, 0, 1,
        segP => setProcFill(clipId, segP),
        // 段自己揣着那份绑定（接口后来改了绑定，老段仍按自己当时那份跑）—— 所以这里把
        // 槽位表一并交给后端：它据此决定那一口是"回片"还是"回一批帧、得现编"。
        // 提示词的两颗 preset id 也一并带上：后端按"端口纯文本 → 段 preset → 轨 preset"
        // 的顺序拼成这一段的 prompt。
        { offline: true, image_keys, chain_frames,
          vgen: { ports: v.ports, fixed_fps: !!v.fixed_fps, fixed_fps_value: v.fixed_fps_value,
            ...(v.promptPresetId ? { prompt_preset_id: v.promptPresetId } : {}),
            ...(proj.tracks.find(t => t.id === clip.trackId)?.vgenPromptPresetId
              ? { track_prompt_preset_id: proj.tracks.find(t => t.id === clip.trackId)!.vgenPromptPresetId } : {}) } });
      const mine = metas.find(m => m.port === v.port && m.video) || metas.find(m => m.video);
      if (!mine) throw new Error('The generator finished with no video result.');
      // 落位长度 = **段自己的长度**（不按帧数 ÷ 帧率折算）：生成器按 16fps 出、工程是
      // 30fps 这种对不上是常态，段长就是用户在时间线上看到的那一截。
      const frames = Number(mine.frames || 0);
      const dur = clip.duration > 0 ? clip.duration : (vgenDurationOf(v) || 0.1);
      vidUpdate(proj2 => placeVideoGenOutput(proj2, clipId, mine.video as string,
        clip.name || v.iface, dur), 'Generator → output');
      autoSaveCud();
      return { dur, frames, stitched: !!mine.stitched };
    } finally {
      clearProcFill(clipId);
    }
  }, [interfaces, executeSeg, vidUpdate, autoSaveCud]);

  /** 点一段生成器的 ▶：链上前段还没产物的，先按早 → 晚把它们跑出来（后一段的首帧就是
   *  前一段的末帧），最后才跑被点的那一段。整条计划开跑前先验一遍接口与输出槽位。 */
  const runVideoGenSegment = useCallback(async (clipId: string) => {
    if (vidProcBusy.current) {
      setVidProcRun({ state: 'error', msg: 'A run is already in flight — wait for it or cancel it first.' });
      return;
    }
    const proj = vidProjectRef.current;
    const clip = proj.clips.find(c => c.id === clipId);
    if (!clip?.vgen) return;
    const before = vgenRunPlanBefore(proj, clip);
    for (const seg of [...before, clip]) {
      const v = seg.vgen!;
      const byName = interfaces.findIndex(i => i.name === v.iface);
      const idx = byName >= 0 ? byName : v.ifaceNum;
      if (idx < 0 || idx >= interfaces.length) {
        setVidProcRun({ state: 'error', msg: `「${v.iface}」 is not connected (package disconnected?).` });
        return;
      }
      if (procSlotBusy(proj, v.port ?? 0, seg.start, seg.duration, seg.id)) {
        setVidProcRun({ state: 'error', msg: `「${seg.name}」 cannot run — the output track already has a clip over ${seg.start.toFixed(1)}s–${(seg.start + seg.duration).toFixed(1)}s.` });
        return;
      }
    }
    vidProcBusy.current = true;
    beginVidProcRun(getActiveBlendUid());
    vidCancelRef.current = false;
    let runningId = clipId;
    try {
      for (const seg of before) {
        if (vidCancelRef.current) throw new Error('cancelled');
        runningId = seg.id;
        setVidProcRun({ state: 'running', msg: `Generating 「${seg.name}」 first — its last frame is the next segment's first frame…` });
        await execVgenClip(seg.id);
      }
      runningId = clip.id;
      const r = await execVgenClip(clip.id);
      const how = r.stitched
        ? `stitched ${r.frames > 0 ? `${r.frames} frames` : 'the returned frames'} into a clip`
        : 'clip';
      const chained = before.length
        ? ` · ${before.length} linked segment${before.length > 1 ? 's' : ''} run first` : '';
      setVidProcRun({ state: 'done', msg: `Done — 「${clip.vgen.iface}」 ${how} landed on the output track (${r.dur.toFixed(1)}s)${chained}.` });
    } catch (e: unknown) {
      const cancelled = vidCancelRef.current;
      const stopped = cancelled && vidStopRef.current === runningId;
      setVidProcRun(stopped
        ? { state: 'cancelled', msg: 'Generator stopped.' }
        : cancelled
          ? { state: 'cancelled', msg: 'Generator run cancelled.' }
          : { state: 'error', msg: `Generator failed — ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      clearProcFill(clipId);
      setVidStagingOverlay({ busy: false, progress: -1 });
      pushVidStaging({ busy: false, cancelLive: false, progress: -1 });
      vidCancelRef.current = false;
      if (before.some(s => s.id === vidStopRef.current) || vidStopRef.current === clipId) vidStopRef.current = null;
      vidProcBusy.current = false;
      endVidProcRun();
    }
  }, [interfaces, execVgenClip]);

  // 段的首/末帧绑定：挑一张图片资产，或磁盘上一份 .cud 工程（后端读它的合成图）。
  const [vgenFramePick, setVgenFramePick] = useState<{ clipId: string; which: 'first_frame' | 'last_frame' } | null>(null);
  // 生成器轨的设置（轨头齿轮）：宽高 / from canvas / scale / fps —— 轨上所有段共享。
  const [vgenTrackSettingsId, setVgenTrackSettingsId] = useState<string | null>(null);
  // 生成器轨的轨级提示词（轨头 prompt 图标）：prompt block 同一套编辑弹窗。
  const [vgenTrackPromptId, setVgenTrackPromptId] = useState<string | null>(null);
  // 生成器段的段级提示词（段上 prompt 图标）：同一扇弹窗，preset 记在段自己的 vgen 上。
  const [vgenSegPromptId, setVgenSegPromptId] = useState<string | null>(null);

  /** 首/末帧绑定写回（解绑传 null）。 */
  const setVgenFrame = useCallback((clipId: string, which: 'first_frame' | 'last_frame',
    ref: VidGenFrameRef | null) => {
    vidUpdate(proj => ({
      ...proj,
      clips: proj.clips.map(c => (c.id === clipId && c.vgen)
        ? { ...c, vgen: { ...c.vgen, [which]: ref } } : c),
    }), 'Bind frame');
  }, [vidUpdate]);

  /** 关键帧录制的参数快照:向工作台页要"当前图层集"的 transform + fx 参数(见 blend_node 的
   *  blend-vid-kf-get)。与 layerSigs 同一条 reqId/waiter 模式,1.5s 超时兜底。 */
  const layerKfParams = useCallback((): Promise<VidKfSnapshot | null> => {
    const win = blendIframeRef.current?.contentWindow;
    if (!win) return Promise.resolve(null);
    return new Promise(resolve => {
      const reqId = ++kfSeq.current;
      let done = false;
      const finish = (snap: VidKfSnapshot | null) => {
        if (done) return;
        done = true;
        window.clearTimeout(kfTimers.current.get(reqId));
        kfWaiters.current.delete(reqId);
        resolve(snap);
      };
      kfTimers.current.set(reqId, window.setTimeout(() => finish(null), 1500));
      kfWaiters.current.set(reqId, finish);
      win.postMessage({ type: 'blend-vid-kf-get', reqId }, '*');
    });
  }, [blendIframeRef]);

  // ── 关键帧录制 ── Record 钮(kfArmed store,Tracks 左上角)亮着时:播放头每停一个位置
  // (暂停态的 scrub、播放头拖动),就把该刻所在 **Layer 段**的图层参数快照写成关键帧
  // (段内秒,持久化在段上)。播放中不记(逐帧太密);拉快照异步,去抖 150ms —— 停稳了才落。
  // 开录那一刻也先记一笔。臂的开关经 kfArmed 外部 store,这里订阅它,不碰控制器。
  const vidKfArmRef = useRef(false);
  useEffect(() => subscribeKfArmed(() => { vidKfArmRef.current = getKfArmed(); }), []);
  vidKfArmRef.current = getKfArmed();
  const recordKfAtPlayhead = useCallback(async () => {
    if (!getKfArmed() || vidPlayingRef.current) return;
    const proj = vidProjectRef.current;
    const t = vidTransport.get();
    const clip = proj.clips.find(c => c.kind === 'layer' && !c.pending && t >= c.start && t < c.start + c.duration);
    if (!clip) return;
    const local = Math.round((t - clip.start) * 1000) / 1000;
    const snap = await layerKfParams();
    if (!snap || !getKfArmed()) return;
    const values: Record<string, number> = {};
    for (const l of snap.layers) {
      const pfx = `layer:${l.id}`;
      if (l.transform) {
        for (const [k, v] of Object.entries(l.transform)) {
          if (typeof v === 'number' && Number.isFinite(v)) values[`${pfx}:transform:${k}`] = v;
        }
      }
      for (const e of l.effects) {
        if (!e.enabled) continue;                 // 旁路的特效不记(它不影响画面)
        for (const [pk, pv] of Object.entries(e.params || {})) {
          if (typeof pv === 'number' && Number.isFinite(pv)) values[`${pfx}:fx:${e.id}:${pk}`] = pv;
        }
      }
    }
    if (!Object.keys(values).length) return;
    vidUpdate(proj2 => kfRecord(proj2, clip.id, local, values), 'Record keyframes');
  }, [layerKfParams, vidUpdate, vidTransport]);
  const kfTimer = useRef(0);
  useEffect(() => {
    const schedule = () => {
      if (vidPlayingRef.current || !getKfArmed()) return;
      if (kfTimer.current) window.clearTimeout(kfTimer.current);
      kfTimer.current = window.setTimeout(() => { kfTimer.current = 0; void recordKfAtPlayhead(); }, 150);
    };
    const unArm = subscribeKfArmed(() => { if (getKfArmed()) schedule(); });
    const unT = vidTransport.subscribe(schedule);
    if (getKfArmed()) schedule();                 // 挂载/依赖变化时:已在录制中就先记一笔
    return () => { unArm(); unT(); if (kfTimer.current) window.clearTimeout(kfTimer.current); };
  }, [recordKfAtPlayhead, vidTransport]);

  // ── Pipeline Preset 的视频路（骨架与 Processor 视频路同一套）────────────────────────────
  // 差别只在"预设没有输入口"：喂哪段视频由**每次运行**的 modal 定（Tracks / Sel. Track /
  // Asset，与 Processor 窗那三颗同一语义），范围和每段帧数也还是那两栏。宿主逐段
  // POST /api/preset_video —— 后端把这一段的帧逐帧过 preset 的 block 链再编码回 mp4；
  // 产物落到固定输出轨的对应位置，process 占位段原地保留、可反复重跑。
  // Mask 走**视频模式的那套形态**：工程里绑定一条轨（Tracks 窗顶部的 Mask 下拉），
  // 那一轨的画面亮度逐帧当 mask；没绑 = 没 mask。
  type PresetSrc = { kind: 'tracks' | 'sel_track' | 'asset'; trackId: string; assetId: string };
  type PresetAnchor = {
    name: string; start: number; duration: number; total: number; kind: 'clip' | 'asset';
    file: string; base: number; end: number; err?: string;
  };
  // 源解析：与 prepVidProcRun 的 clipAt 同一套查找（游标所在/指定视频轨的片段），
  // 资产则直接用整条源（时间线坐标 = 源内秒，起点 0）。解决不了就回一条带 err 的空锚，
  // modal 照样开得出来（用户可以在里面换源），Run 因 0 帧而禁用。
  const resolvePresetSrc = useCallback((src: PresetSrc): PresetAnchor => {
    const proj = vidProjectRef.current;
    const fps = proj.fps;
    const t = vidTransport.get();
    const empty = (name: string, kind: 'clip' | 'asset', err: string): PresetAnchor =>
      ({ name, start: 0, duration: 0, total: 0, kind, file: '', base: 0, end: 0, err });
    if (src.kind === 'asset') {
      const asset = proj.assets.find(a => a.kind === 'video' && a.id === src.assetId)
        || [...proj.assets].reverse().find(a => a.kind === 'video');
      if (!asset) return empty('(no video asset)', 'asset', 'No video asset in the library — import one first.');
      return {
        name: asset.name, start: 0, duration: asset.duration,
        total: Math.floor(asset.duration * fps + 1e-6), kind: 'asset',
        file: asset.src.split('/').pop() || '', base: 0, end: asset.duration,
      };
    }
    const tracks = src.kind === 'sel_track' && src.trackId
      ? proj.tracks.filter(tr => tr.id === src.trackId) : proj.tracks;
    for (const tr of tracks) {
      if (tr.kind !== 'video') continue;
      const c = proj.clips.find(c => c.trackId === tr.id && c.kind === 'video' && !c.pending
        && t >= c.start && t < c.start + c.duration);
      if (!c) continue;
      return {
        name: c.name, start: c.start, duration: c.duration,
        total: Math.floor(c.duration * fps + 1e-6), kind: 'clip',
        file: c.src.split('/').pop() || '', base: c.offset, end: c.offset + c.duration,
      };
    }
    return empty(src.kind === 'sel_track' ? '(no clip on the picked track)' : '(nothing under the playhead)', 'clip',
      src.kind === 'sel_track'
        ? 'No video clip under the playhead on the picked track.'
        : 'No video clip under the playhead — move it onto one, or pick another source.');
  }, [vidTransport]);

  // preset 的视频 modal：preset + 这一次选的源。源一变锚跟着变（modal 用 key 重挂，
  // 范围回到整段 —— 换源后保留上一条的范围只会点出"源覆盖不了"）。
  const [vidPresetCfg, setVidPresetCfg] = useState<{ presetId: string; presetName: string; src: PresetSrc } | null>(null);

  // preset 行上的 ▶：视频模式改成宿主自己跑（Blend 页没有视频工程），其余照旧发页面。
  const runPresetFromRow = useCallback((set: BlockSet) => {
    if (vidModeRef.current !== 'video') { onRunPreset(set.id); return; }
    if (vidProcBusy.current) {
      setVidProcRun({ state: 'error', msg: 'A run is already in flight — wait for it or cancel it first.' });
      return;
    }
    setVidPresetCfg({ presetId: set.id, presetName: set.name, src: { kind: 'tracks', trackId: '', assetId: '' } });
  }, [onRunPreset]);

  // 跑一段 preset：POST → 轮询 preset_video_* → 收这一段编码好的视频。
  const executePresetSeg = useCallback(async (
    presetId: string,
    videoSpec: ProcFrameWindow,
    maskSpec: ProcFrameWindow | null,
    segMsg: string, segAt: number, segCount: number,
    onSegProgress?: (segP: number) => void,
  ): Promise<SegMeta[]> => {
    const setSegProgress = (segP: number) => {
      const p = segCount > 1 ? (segAt + segP) / segCount : segP;
      setVidStagingOverlay({ progress: p });
      pushVidStaging({ progress: p });
      onSegProgress?.(segP);
    };
    const segOverlayProgress = segCount > 1 ? segAt / segCount : -1;
    setVidStagingOverlay({ busy: true, progress: segOverlayProgress });
    pushVidStaging({ busy: true, cancelLive: true, progress: segOverlayProgress });
    setVidProcRun({ state: 'running', msg: segMsg });
    await fetch('/api/preset_video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        preset_id: presetId,
        extra_prompt: '',
        video_inputs: { '0': videoSpec },
        mask_input: maskSpec,
      }),
    });
    const deadline = Date.now() + 10 * 60 * 1000;
    let seenRunning = false;
    for (;;) {
      await new Promise(r => setTimeout(r, 500));
      if (vidCancelRef.current) throw new Error('cancelled');
      const st = await fetch('/api/status').then(r => r.json()).catch(() => null);
      if (!st) { if (Date.now() > deadline) throw new Error('timed out — check the ComfyUI console.'); continue; }
      const s = st.preset_video_status || 'idle';
      if (s === 'running') {
        seenRunning = true;
        setSegProgress(Math.max(0, Math.min(1, Number(st.preset_video_progress) || 0)));
        continue;
      }
      if (s === 'idle' && !seenRunning) { if (Date.now() > deadline) throw new Error('timed out — check the ComfyUI console.'); continue; }
      if (s === 'done' || s === 'error' || s === 'idle') {
        if (vidCancelRef.current) throw new Error('cancelled');
        if (s !== 'done') throw new Error(`Preset failed: ${st.preset_video_error || 'unknown error'}`);
        const meta = (st.preset_video_meta || []) as SegMeta[];
        const vids = meta.filter(m => m && m.video);
        if (!vids.length) throw new Error('The preset finished with no video.');
        return vids;
      }
    }
  }, []);

  const runVideoPreset = useCallback(async (
    presetId: string, presetName: string, src: PresetSrc,
    segFrames: number, inFrame: number, outFrame: number,
  ) => {
    if (vidProcBusy.current) return;
    const a = resolvePresetSrc(src);
    if (a.err) { setVidProcRun({ state: 'error', msg: a.err }); return; }
    const proj = vidProjectRef.current;
    const fps = proj.fps;
    const f0 = Math.max(0, Math.min(a.total, Math.round(inFrame)));
    const f1 = Math.min(a.total, Math.round(outFrame));
    if (f1 <= f0) {
      setVidProcRun({ state: 'error', msg: 'The input range is empty — pick an out point after the in point.' });
      return;
    }
    const rangeFrames = f1 - f0;
    if (rangeFrames > SEG_TOTAL_CAP) {
      setVidProcRun({ state: 'error', msg: `That range is ${rangeFrames} frames — the cap is ${SEG_TOTAL_CAP}. Pick a shorter range.` });
      return;
    }
    const seg = Math.max(1, Math.min(SEG_MAX_FRAMES, Math.round(segFrames)));
    const nSegs = Math.ceil(rangeFrames / seg);
    const anchorT0 = a.start + f0 / fps;
    const base = a.base + (anchorT0 - a.start);
    const end = a.end;

    // Mask 轨：只认能盖住范围入点的那一段（绑定轨上没片段 = 这一段没 mask）。
    const maskTrack = proj.tracks.find(t => t.id === proj.maskTrackId && t.kind === 'video');
    let maskFile = '', maskBase = 0, maskEnd = 0;
    if (maskTrack) {
      const mc = proj.clips.find(c => c.trackId === maskTrack.id && c.kind === 'video' && !c.pending
        && anchorT0 >= c.start - 1e-6 && anchorT0 < c.start + c.duration);
      if (mc) { maskFile = mc.src.split('/').pop() || ''; maskBase = mc.offset + (anchorT0 - mc.start); maskEnd = mc.offset + mc.duration; }
    }
    // 输出轨的槽位守卫：这个范围被别的东西占着就不开跑（modal 里 Run 已置灰，这是兜底）。
    if (procSlotBusy(proj, 0, anchorT0, rangeFrames / fps)) {
      setVidProcRun({ state: 'error', msg: `The output track already has a clip over ${anchorT0.toFixed(1)}s–${(anchorT0 + rangeFrames / fps).toFixed(1)}s — move or delete it first.` });
      return;
    }

    vidProcBusy.current = true;
    beginVidProcRun(getActiveBlendUid());
    const runId = `preset-${Date.now()}`;
    const placeholderIds: string[] = [];
    try {
      // Run 确认的当下就开「输出轨 + process 轨」摆坑（每段一个、预分配空间），
      // 一步历史 'Run preset'。
      // 帧段：f0 = 源文件内按工程 fps 的整数起始帧号，相邻段按整数 +seg 步进（首尾相接）。
      const baseF = Math.floor(base * fps + 1e-6);
      const baseAvail = Math.floor(end * fps + 1e-6) - baseF;
      const maskF0 = maskFile ? Math.floor(maskBase * fps + 1e-6) : 0;
      const maskAvail = maskFile ? Math.floor(maskEnd * fps + 1e-6) - maskF0 : 0;
      const segs = Array.from({ length: nSegs }, (_, i) => {
        const n = Math.max(1, Math.min(seg, rangeFrames - i * seg));
        const spec: ProcFrameWindow = {
          file: a.file, f0: baseF + i * seg,
          n: Math.max(1, Math.min(n, baseAvail - i * seg)), fps,
        };
        const maskInputs = maskFile ? {
          '0': {
            file: maskFile, f0: maskF0 + i * seg,
            n: Math.max(1, Math.min(n, maskAvail - i * seg)), fps,
          } as ProcFrameWindow,
        } : undefined;
        return { start: anchorT0 + (i * seg) / fps, duration: n / fps, segIndex: i, segCount: nSegs, inputs: { '0': spec }, maskInputs };
      });
      vidUpdate(p => placeProcPlaceholders(p, {
        name: presetName, runId, port: 0, iface: presetName, ifaceNum: -1,
        params: {}, kind: 'preset', presetId, presetName,
        maskTrackId: maskTrack?.id, maskTrackName: maskTrack?.name, segs,
      }), 'Run preset');
      vidProjectRef.current.clips.forEach(c => {
        if (!c.pending || c.pending.runId !== runId) return;
        placeholderIds[c.pending.segIndex] = c.id;
      });

      for (let i = 0; i < nSegs; i++) {
        const s = segs[i];
        const n = s.inputs['0'].n;
        const segMsg = nSegs === 1
          ? `Running 「${presetName}」 on ${rangeFrames} frames…`
          : `「${presetName}」 segment ${i + 1}/${nSegs} (${n} frames)…`;
        const fillId = placeholderIds[i];
        if (fillId) setProcFill(fillId, 0);
        let vids: SegMeta[];
        try {
          vids = await executePresetSeg(presetId, s.inputs['0'], s.maskInputs?.['0'] ?? null, segMsg, i, nSegs, segP => {
            if (fillId) setProcFill(fillId, segP);
          });
        } catch (e: unknown) {
          if (fillId) clearProcFill(fillId);
          throw new Error(nSegs > 1
            ? `segment ${i + 1}/${nSegs}: ${e instanceof Error ? e.message : String(e)}`
            : (e instanceof Error ? e.message : String(e)));
        }
        if (fillId) clearProcFill(fillId);
        const m = vids[0];
        if (fillId && m) {
          vidUpdate(p => placeProcOutput(p, fillId, m.video as string,
            m.name || presetName, (m.frames || n) / fps),
          nSegs > 1 ? `Preset segment ${i + 1}/${nSegs}` : 'Preset → output');
          autoSaveCud();              // 一段落位 = 工程变了：已落盘的 .cud 立刻跟上一版
        }
        ringSegmentDone();            // 这一段跑完了：桌面端开着 Tinkle 就响一声
      }
      setVidProcRun({ state: 'done', msg: `Done — 「${presetName}」 on ${rangeFrames} frames${nSegs > 1 ? `, ${nSegs} segments` : ''}.` });
    } catch (e: unknown) {
      const left = vidProjectRef.current.clips.filter(c => c.pending && c.pending.runId === runId).length;
      const tail = left ? ` — ${left} placeholder segment${left === 1 ? '' : 's'} left on the timeline; click one to continue.` : '';
      setVidProcRun(vidCancelRef.current
        ? { state: 'cancelled', msg: `Preset run cancelled${tail}` }
        : { state: 'error', msg: `Preset failed — ${e instanceof Error ? e.message : String(e)}${tail}` });
    } finally {
      setVidStagingOverlay({ busy: false, progress: -1 });
      pushVidStaging({ busy: false, cancelLive: false, progress: -1 });
      vidCancelRef.current = false;
      vidProcBusy.current = false;
      endVidProcRun();
    }
  }, [resolvePresetSrc, vidUpdate, autoSaveCud]);


  // 占位段上的 ▶（续跑）：按段里的执行快照把**这一段**单独重放，产物落到输出轨的对应
  // 位置 —— 占位段原地保留，所以同一段可以反复重跑（每次覆盖它自己上一次的产物）。
  // 输出轨的那个位置被别的东西占着时不跑（按钮已置灰，这里是兜底）。
  // 接口按名字解析（快照存了名 + 下标兜底 —— 退出期间接口列表可能变过），参数/抽帧窗口
  // 原样重放，不再弹 modal。
  const continuePendingClip = useCallback(async (
    clipId: string,
  ): Promise<'skip' | 'failed' | 'cancelled' | 'stopped' | 'done'> => {
    if (vidProcBusy.current) {
      setVidProcRun({ state: 'error', msg: 'A run is already in flight — wait for it or cancel it first.' });
      return 'skip';
    }
    const clip = vidProjectRef.current.clips.find(c => c.id === clipId);
    if (!clip || !clip.pending) return 'skip';
    const pd = clip.pending;
    // 开跑（或确认不跑）就从队列里摘掉：排队标记不能让已轮到的段还挂着 ⏸。
    dequeueProcClip(clipId);
    if (procSlotBusy(vidProjectRef.current, pd.port ?? 0, clip.start, clip.duration, clip.id)) {
      setVidProcRun({ state: 'error', msg: `The output track already has a clip over ${clip.start.toFixed(1)}s–${(clip.start + clip.duration).toFixed(1)}s — move or delete it first.` });
      return 'skip';
    }
    const isPreset = pd.kind === 'preset';
    let idx = -1;
    let presetId = '';
    if (isPreset) {
      // preset 按 id 认亲（名字兜底 —— 改名后 id 不变；复制出来的那一套是新 id，不该被续跑）。
      const set = blockSets.find(s => s.id === pd.presetId)
        ?? blockSets.find(s => s.name === (pd.presetName || pd.iface));
      if (!set) {
        setVidProcRun({ state: 'error', msg: `Preset 「${pd.presetName || pd.iface}」 no longer exists — re-run it from the Pipeline Presets list.` });
        return 'skip';
      }
      presetId = set.id;
    } else {
      idx = interfaces.findIndex(x => x && x.name === pd.iface);
      if (idx < 0 && pd.ifaceNum >= 0 && pd.ifaceNum < interfaces.length) idx = pd.ifaceNum;
      if (idx < 0) {
        setVidProcRun({ state: 'error', msg: `Interface 「${pd.iface}」 is no longer in the package — reload the pipeline and try again.` });
        return 'skip';
      }
    }
    vidProcBusy.current = true;
    beginVidProcRun(getActiveBlendUid());
    vidCancelRef.current = false;
    try {
      const segMsg = `Running 「${pd.iface}」 — segment ${pd.segIndex + 1}/${pd.segCount} (resumed)…`;
      setProcFill(clipId, 0);
      const vids = isPreset
        ? await executePresetSeg(presetId, pd.inputs['0'], pd.maskInputs?.['0'] ?? null,
          segMsg, pd.segIndex, pd.segCount, segP => setProcFill(clipId, segP))
        : await executeSeg(idx, pd.params, pd.inputs, segMsg, pd.segIndex, pd.segCount,
          segP => setProcFill(clipId, segP));
      clearProcFill(clipId);
      const m = vids.find(x => x.port === pd.port) ?? vids[0];
      if (!m || !m.video) throw new Error('The run finished with no video results.');
      const win = pd.inputs[String(isPreset ? 0 : pd.port)];
      const dur = (m.frames || win?.n || 30) / (win?.fps || 30);
      vidUpdate(proj => placeProcOutput(proj, clipId, m.video as string,
        m.name || clip.name, dur), `${isPreset ? 'Preset' : 'Processor'} segment ${pd.segIndex + 1}/${pd.segCount}`);
      autoSaveCud();                // 续跑完成一段也立刻落盘
      ringSegmentDone();            // 续跑的也是"一段完成"：同样响一声
      setVidProcRun({ state: 'done', msg: `Segment ${pd.segIndex + 1}/${pd.segCount} landed on the output track.` });
      return 'done';
    } catch (e: unknown) {
      const cancelled = vidCancelRef.current;
      // ■ 单段停止 vs 标题条 Cancel 整批取消：两者都靠 vidCancelRef 打断当前执行，
      // 差别只在那面旗上有没有记着"只停这一段"。
      const stopped = cancelled && vidStopRef.current === clipId;
      setVidProcRun(stopped
        ? { state: 'cancelled', msg: 'Segment stopped — the rest of the queue keeps running.' }
        : cancelled
          ? { state: 'cancelled', msg: 'Segment run cancelled — the placeholder stays; click it to try again.' }
          : { state: 'error', msg: `${isPreset ? 'Preset' : 'Processor'} failed — ${e instanceof Error ? e.message : String(e)}` });
      return stopped ? 'stopped' : cancelled ? 'cancelled' : 'failed';
    } finally {
      clearProcFill(clipId);
      setVidStagingOverlay({ busy: false, progress: -1 });
      pushVidStaging({ busy: false, cancelLive: false, progress: -1 });
      vidCancelRef.current = false;
      if (vidStopRef.current === clipId) vidStopRef.current = null;
      vidProcBusy.current = false;
      endVidProcRun();
    }
  }, [interfaces, vidUpdate, blockSets, executePresetSeg, autoSaveCud]);

  // 多选 ▶：把选中的占位段按 **从左到右（start 升序）、同起点从下到上（轨道序号降序）**
  // 的顺序串行跑完。单段的忙碌闸门/进度/落位/自动保存仍走 continuePendingClip，这里只排队：
  //  * 槽位已被别的片段占着的段跳过（它自己的 ▶ 本来就置灰），整批结束后统一报一句；
  //  * 中途取消 = 不再开跑后面的段（已经落位的保留）；
  //  * 单段失败不打断整批 —— 每段互相独立，失败的那段占位还在，可以单独再点 ▶。
  const continueManyPendingClips = useCallback(async (clipIds: string[]) => {
    if (vidProcBusy.current) {
      setVidProcRun({ state: 'error', msg: 'A run is already in flight — wait for it or cancel it first.' });
      return;
    }
    const proj = vidProjectRef.current;
    const rowOf = new Map(proj.tracks.map((tr, i) => [tr.id, i]));
    const picked = clipIds
      .map(id => proj.clips.find(c => c.id === id))
      .filter((c): c is VidClip => !!c && !!c.pending)
      .sort((a, b) => (a.start - b.start)
        || ((rowOf.get(b.trackId) ?? 0) - (rowOf.get(a.trackId) ?? 0)));
    const runnable = picked.filter(c => !procSlotBusy(proj, c.pending!.port ?? 0, c.start, c.duration, c.id));
    const blocked = picked.length - runnable.length;
    if (!runnable.length) {
      setVidProcRun({ state: 'error', msg: 'Every selected placeholder is blocked — its slot on the output track is taken.' });
      return;
    }
    let done = 0, failed = 0, stopped = 0, paused = 0, cancelled = false;
    // ■ 停止后后端 interrupt 是异步收尾的：等状态离开 running 再开下一段，否则下一段的轮询
    // 会把上一段收尾时的 idle 当成自己跑完，收错产物。最多等 10s（等不到就照常继续）。
    const settleBackend = async () => {
      for (let i = 0; i < 40; i++) {
        const st = await fetch('/api/status').then(r => r.json()).catch(() => null);
        if (!st) return;
        const busy = (st.interface_status ?? 'idle') === 'running'
          || (st.preset_video_status ?? 'idle') === 'running';
        if (!busy) return;
        await new Promise(r => setTimeout(r, 250));
      }
    };
    // 整条队摆出来：时间线把还没轮到的段画成 ⏸（点一下 = 退出队列，见 pausePendingClip）。
    setProcQueue(runnable.map(c => c.id));
    try {
      for (const c of runnable) {
        // 排队期间被 ⏸ 移出队列的段：轮到时直接跳过（占位段留在原处，随时可再 ▶）。
        if (!isProcQueued(c.id)) { paused++; continue; }
        const r = await continuePendingClip(c.id);
        if (r === 'cancelled') { cancelled = true; break; }   // 标题条 Cancel = 整批不再开跑
        if (r === 'done') done++;
        else if (r === 'failed') failed++;
        else if (r === 'stopped') { stopped++; await settleBackend(); }   // ■ 只停这一段，后面的照跑
      }
    } finally {
      clearProcQueue();
    }
    const bits = [`Ran ${done} of ${runnable.length} segment${runnable.length === 1 ? '' : 's'} in order`];
    if (failed) bits.push(`${failed} failed`);
    if (stopped) bits.push(`${stopped} stopped`);
    if (paused) bits.push(`${paused} removed from the queue`);
    if (blocked) bits.push(`${blocked} blocked (output slot taken)`);
    setVidProcRun(cancelled
      ? { state: 'cancelled', msg: `Batch cancelled — ${bits.join(', ')}.` }
      : failed
        ? { state: 'error', msg: `${bits.join(', ')}.` }
        : { state: 'done', msg: `${bits.join(', ')}.` });
  }, [continuePendingClip]);

  // 队列中的 ⏸：把这一段移出队列。批次循环每轮查一次队列，被移出的段轮到时直接跳过
  // （占位段本身留在轨上，之后随时可以再 ▶）。
  const pausePendingClip = useCallback((clipId: string) => {
    dequeueProcClip(clipId);
  }, []);

  // 正在跑的那段的 ■：只打断**这一段**（后端 interrupt 当前执行）；队列里后面的段照常继续。
  // 与标题条 Cancel 的区别就在 vidStopRef：有它 = 单段停止，没收尾的批次不会 break。
  const stopPendingClip = useCallback((clipId: string) => {
    if (!vidProcBusy.current || getProcFill(clipId) < 0) return;
    vidStopRef.current = clipId;
    vidCancelRef.current = true;
    fetch('/api/cancel_run', { method: 'POST' }).catch(() => {});
  }, []);

  // 工作台那几格的 send 先过宿主这一道 —— History 格的 Undo / Redo / 点某一行，
  // 要能落到视频那一半（页面的下标空间里没有它）。
  // Processor 的 Run 也在这里分流：视频模式 + Allow List + 有 image 入口选了 Video 源时，
  // 这一趟由宿主自己发（Blend 页那条跑法吃的是画布/图层/工作区，视频不在它那边）。
  const uiSend: BlendUiSend = useCallback((action, value) => {
    if (action === 'history-undo') {
      if (vidOwnsUndo(false)) { vidUndo(); return; }
    } else if (action === 'history-redo') {
      if (vidOwnsUndo(true)) { vidRedo(); return; }
    } else if (action === 'history-jump') {
      const base = getBlendUi().history.steps.length;
      const n = Number(value);
      if (Number.isFinite(n) && n >= base) { vidJump(n - base); return; }
    } else if (action === 'processor-run' && vidModeRef.current === 'video') {
      const proc = getBlendUi().processor;
      if (proc.allowList) {
        // 这一趟由宿主接手：先过前置校验，过了弹配置 modal（输入范围 + 每段帧数
        // 由用户定），确认后才开跑。校验失败直接播报（modal 里没有可改的东西）。
        if (vidProcBusy.current) return;
        const prep = prepVidProcRun();
        if (typeof prep === 'string') { setVidProcRun({ state: 'error', msg: prep }); return; }
        const picks = getVidProcPicks();
        const ports = prep.proc.outputs
          .filter(o => (picks.dst[String(o.num)] || 'new_track') !== 'asset').map(o => o.num);
        setVidSegCfg({ name: prep.anchor.name, start: prep.anchor.start, duration: prep.anchor.span, total: prep.anchor.total, fps: prep.fps, kind: prep.anchor.kind, ports });
        return;
      }
    }
    onBlendUiCommand(action, value);
  }, [onBlendUiCommand, vidOwnsUndo, vidUndo, vidRedo, vidJump, runVideoListProcessor]);
  // 视频模式下没选中 Layer 段 → Layers / Guidances 不知道该往哪写，动作条整排变灰。
  // 切回 Image 模式时把图层集还给文档主图层（否则画布还停在某个段的那一套上）。
  useEffect(() => {
    setLayerEditBlocked(vidMode === 'video' && !vidLayerKey);
    if (vidMode !== 'video' && vidLayerKey) {
      setVidLayerKey('');
      onBlendUiCommand('layer-set', { key: '' });
    }
  }, [vidMode, vidLayerKey, onBlendUiCommand]);
  // 逐帧合成那条边界：取帧结果（ImageBitmap）转交给工作台页面，回图同样只认这一个 window。
  const blendWindow = useCallback(() => blendIframeRef.current?.contentWindow ?? null, [blendIframeRef]);
  const blendPost = useCallback((msg: unknown, transfer?: Transferable[]) => {
    const win = blendIframeRef.current?.contentWindow;
    if (!win) return false;
    win.postMessage(msg, '*', transfer);
    return true;
  }, [blendIframeRef]);
  // Layer 段粘贴：把源段那套图层整套克隆到新 key（见页面 copyLayerSetTo）。**成套克隆**是必须的：
  // 共用一套的话，改副本的图层会把原件一起改掉（"复制"在用户眼里不是"链接"）。
  const layerCopy = useCallback((from: string, to: string): Promise<boolean> => {
    const win = blendIframeRef.current?.contentWindow;
    if (!win || !from || !to || from === to) return Promise.resolve(false);
    return new Promise(resolve => {
      const reqId = layerCopySeq.current++;
      let done = false;
      let timer = 0;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        layerCopyWaiters.current.delete(reqId);
        resolve(ok);
      };
      timer = window.setTimeout(() => finish(false), 1500);
      layerCopyWaiters.current.set(reqId, finish);
      win.postMessage({ type: 'blend-vid-layer-copy', reqId, from, to }, '*');
    });
  }, [blendIframeRef]);
  // Layer 段合并的"内容是否同一套"：向页面要素材签名（见页面 replyVidLayerSigs）。
  const layerSigs = useCallback((keys: string[]): Promise<Record<string, string>> => {
    const win = blendIframeRef.current?.contentWindow;
    const uniq = [...new Set((Array.isArray(keys) ? keys : []).map(String).filter(Boolean))];
    if (!win || !uniq.length) return Promise.resolve({});
    return new Promise(resolve => {
      const reqId = layerSigSeq.current++;
      let done = false;
      let timer = 0;
      const finish = (sigs: Record<string, string>) => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        layerSigWaiters.current.delete(reqId);
        resolve(sigs);
      };
      timer = window.setTimeout(() => finish({}), 1500);
      layerSigWaiters.current.set(reqId, finish);
      win.postMessage({ type: 'blend-vid-layer-sig', reqId, keys: uniq }, '*');
    });
  }, [blendIframeRef]);
  // 播放器报"游标底下是哪一段 Layer 段"：画布内容、Layers 面板的作用对象、Transform 的开工条件
  // 全跟着游标走 —— 离开段就回到主图层集（画布转成视频底片，见页面 vidBaseOn）。
  // 播放中**也照常切套**：切套本身只是换一份数据（layers / selectedId / decal / 历史），真正的
  // 开销是切完那次整画布重渲染 —— 那一笔由页面在播放中跳过（见 blend_node.html 的 switchLayerSet），
  // 画面由临时合成那条链负责。反过来，如果不切套，Layers 面板与页面里的工作栈就不是同一套：
  // 播放中在面板上做的任何事（显隐、参数、添加、拖动）都会落在"上一段"上 —— 画面上毫无反应，
  // 看上去就是"图层渲染失效了"。
  const showPlayLayer = useCallback((key: string | null) => {
    const next = key || '';
    setVidLayerKey(prev => (prev === next ? prev : next));
    // 只报"哪一段"：切套之后页面照常重画活画布（P3.4 —— 编辑与播放同一条路径，
    // 不再有"播放中只换数据不重画"的分支，所以也不需要播放位）。
    onBlendUiCommand('layer-set', { key: next });
  }, [onBlendUiCommand]);
  // ── 缺失 / relink（A5）：工程引用的每个哈希，仓库里还有没有 ────────────────────────────────
  // 什么时候问：工程变了（去抖 250ms），以及删除/入库之后（`recheckMissing` 手动，绕过去重）。
  // 请求失败（宿主没起）⇒ 保持上一次的结论：宁可不画，也别把一条能播的时间线整片标红。
  const [vidMissing, setVidMissing] = useState<ReadonlySet<string>>(() => new Set());
  const missingSigRef = useRef('');
  const recheckMissing = useCallback(async () => {
    const refs = vidAssetRefs(vidProjectRef.current);
    if (!refs.length) {
      missingSigRef.current = '';
      setVidMissing(prev => (prev.size ? new Set<string>() : prev));
      return;
    }
    try {
      const r = await fetch('/api/assets_exist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: refs }),
      }).then(x => x.json());
      if (!r || r.ok !== true) return;
      const miss = new Set<string>(Array.isArray(r.missing) ? r.missing.map(String) : []);
      missingSigRef.current = [...refs].sort().join(',');
      setVidMissing(prev => (prev.size === miss.size && [...miss].every(h => prev.has(h)) ? prev : miss));
    } catch { /* 宿主没起：保持上一次的结论 */ }
  }, []);
  useEffect(() => {
    if (vidMode !== 'video') return;
    const refs = vidAssetRefs(vidProject);
    if (!refs.length) {
      if (missingSigRef.current) {
        missingSigRef.current = '';
        setVidMissing(prev => (prev.size ? new Set<string>() : prev));
      }
      return;
    }
    if ([...refs].sort().join(',') === missingSigRef.current) return;
    const t = setTimeout(() => { void recheckMissing(); }, 250);
    return () => clearTimeout(t);
  }, [vidProject, vidMode, recheckMissing]);
  // 别的窗口/宿主删了文件，本页不会收到通知 —— 回到前台时重问一遍（便宜：清单有缓存）。
  useEffect(() => {
    const onFocus = () => { void recheckMissing(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [recheckMissing]);
  // relink：把用户挑的文件重新入库。**哈希必须对得上**（这是"同一件货"的判据），对不上默认拒绝。
  const vidRelink = useCallback(async (hash: string, file: File, force?: boolean) => {
    const ing = await ingestFile(file);
    if (!ing || !ing.asset) return { ok: false, error: 'This file could not be read (ingest failed)' };
    // 认两种命中：挑的是原件（哈希 = 缺失的原件），或者缺的其实是它的转码代理（哈希 = 新算出的 play）。
    if (ing.asset !== hash && ing.play !== hash && !force) {
      return { ok: false, error: `Different bytes — expected ${hash.slice(0, 8)}…, got ${ing.asset.slice(0, 8)}…`, hash: ing.asset };
    }
    // 精确命中也要改 src：老工程指的多半是 `/api/vid_media/<旧文件名>`（缓存被清掉了），而重新
    // 入库后的地址是 `<md5>`。relinkAsset 顺手把它换成仓库地址（P1 的 play 也一起换）。
    vidUpdate(p => relinkAsset(p, hash, ing.asset!, ing.play), 'Relink media');
    await recheckMissing();
    return { ok: true, hash: ing.asset };
  }, [vidUpdate, recheckMissing]);
  const vidCtl: VidController = useMemo(() => ({
    project: vidProject, transport: vidTransport, playing: vidPlaying, pps: vidPps,
    staging, update: vidUpdate, seek: vidSeek, setPlaying: setVidPlaying, setPps: setVidPps,
    missing: vidMissing, relink: vidRelink, recheckMissing: () => { void recheckMissing(); },
    // 点 Layer 段 = 把游标带进这一段：画布只在游标压着它时折这一套图层（见 vidCanvasRef）。
    // 这里不写 vidLayerKey / 不发 layer-set —— 那一份由播放器按游标底下**实际命中**的段来报
    // （见 showPlayLayer），否则点一下段、游标却留在段外，两边说的就不是同一段了。
    focusClip: clip => {
      if (!clip || clip.kind !== 'layer') return;
      const t = vidTransport.get();
      if (t < clip.start || t >= clip.start + clip.duration) vidSeek(clip.start);
    },
    blendPost, blendWindow,
    solo: { audio: soloAudio, video: soloVideo }, toggleSolo,
    mute, toggleMute,
    // 占位段上的 ▶：按快照续跑这一段（见 continuePendingClip）。
    continueProc: continuePendingClip,
    // 多选时点 ▶：整批按 左→右 / 同起点 下→上 依次跑（见 continueManyPendingClips）。
    continueProcMany: continueManyPendingClips,
    // 队列中的 ⏸ / 正在跑的那段的 ■（见 pausePendingClip / stopPendingClip）。
    pauseProc: pausePendingClip,
    stopProc: stopPendingClip,
    // Layer 段合并：向页面要图层集签名，两段一致才允许并。
    layerSigs,
    layerCopy,
  }), [vidProject, vidTransport, vidPlaying, vidPps, staging, vidUpdate, vidSeek, blendPost, blendWindow, soloAudio, soloVideo, toggleSolo, mute, toggleMute, continuePendingClip, continueManyPendingClips, pausePendingClip, stopPendingClip, layerSigs, layerCopy, vidMissing, vidRelink, recheckMissing]);
  // 页面存档只在**有文档**时写：它是"刷新之后还没有 .cud 时"的起手工程，不是一份独立的工程。
  // 一份文档都没有的时候写它，等于把刚关掉那份的时间线存成"下次开机的默认工程" —— 下次
  // 新建文档就会凭空长出上一份的轨道与片段。
  useEffect(() => {
    if (blendDocs.activeUid == null) return;
    const t = setTimeout(() => saveVidProject(vidProject), 400);
    return () => clearTimeout(t);
  }, [vidProject, blendDocs.activeUid]);
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
          title={m === 'image' ? 'Image — the canvas workbench' : 'Video — the player (Tracks and Assets stay available in both modes)'}
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
  // 面 attribute 的 Frame source 下拉要挑轨道：只列视频轨（音频轨没有帧可取）。轨道数组的顺序就是
  // 时间线的上下序，所以照原样递过去 —— 下拉里的次序与时间线看见的是同一个。
  const vidTrackList = useMemo(
    () => vidProject.tracks.filter(t => t.kind === 'video').map(t => ({ id: t.id, name: t.name })),
    [vidProject.tracks],
  );
  // Processor 窗的 Asset 源挑选用：只列视频资产（音频没有帧可抽）。
  const vidAssetList = useMemo(
    () => vidProject.assets.filter(a => a.kind === 'video').map(a => ({ id: a.id, name: a.name })),
    [vidProject.assets],
  );
  // 时间线选中态(跨窗 store 的宿主侧读数):恰好选中一枚**视频段**时,Video Generator 窗的
  // Add continue segment 才有原料 —— 那段的尾帧就是新段的首帧。
  const vidSel = useSyncExternalStore(subscribeVidSelection, getVidSelection);
  const continueSel = useMemo(() => {
    if (vidSel.size !== 1) return null;
    const c = vidProject.clips.find(c => vidSel.has(c.id));
    return c && c.kind === 'video' ? { name: c.name } : null;
  }, [vidSel, vidProject.clips]);
  const wbHost = useMemo(() => ({
    staging, blendPreview, guidanceCard, stageUpload, stageRemove,
    layout: { dock, rules: dockRules, openDocs: openDocUnits, apply: applyDock },
    video: {
      mode: vidMode, fps: vidProject.fps, setFps: setVidFps, tracks: vidTrackList, assets: vidAssetList,
      // Video Generator：Processor 那一格要能列出"哪些接口是生成器"并发起添加（段的位置/时长
      // 只有宿主知道，所以添加这个动作也住在宿主 —— 窗口只挑哪一台）。`cont` 是时间线上
      // 恰好选中的那枚视频段（Add continue segment 的原料）；没有 = null。
      videoGen: { list: videoGenList, add: addVideoGenSegment, cont: continueSel, addContinue: addContinueVgenSegment },
      // Video 模式的 Mask 轨绑定(Tracks 窗顶栏撤掉后的去处):Guidances 的 MaskRow 画 Bind。
      maskTrack: {
        id: vidProject.maskTrackId || '',
        tracks: vidTrackList,
        set: (id: string | null) => vidUpdate(proj => setMaskTrack(proj, id || null), 'Mask track'),
      },
    },
  }), [staging, blendPreview, guidanceCard, stageUpload, stageRemove, dock, dockRules, openDocUnits, applyDock,
    vidMode, vidProject.fps, vidProject.maskTrackId, setVidFps, vidTrackList, vidAssetList, videoGenList, addVideoGenSegment, continueSel, addContinueVgenSegment, vidUpdate]);
  // 工作台 iframe 启动时先播一份空的 `docs: []`（它还没恢复上一次的工程），紧接着才播真正恢复出来
  // 的那份。头一份空播报不是"文档都被关了"，把它当真就等于每次刷新都把存档里的画布位置剪掉。
  // 所以：**空列表在启动期是歧义的**，要等它至少说过一次"我有文档"，此后再说空才算关闭。
  const settledDocs = useRef(false);
  // 上一轮播报的文档集：这一轮多出来的就是"新开的工程"（Load / New / 重开）—— 它们要当场露脸。
  const prevDocs = useRef<readonly UnitId[]>([]);
  // 上一轮播报的活跃文档：**已开着的文档被工作台自己切成活跃**（vgen 帧卡的跳转 →
  // requestImportCud 的 already-open 分支 → switchDocument）只重新播报一次，文档集不变 ——
  // fresh 那一支抓不到它，选中项得自己跟上，不然工作台已经在画 B，tab 条还停在 A。
  const prevActiveUid = useRef<number | null>(null);
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
    // 活跃文档换了人而文档集没变 → 拨选中项。只在 activeUid **真的跨了**这趟才拨：脏标记、
    // 存盘这些例行播报 activeUid 不变，不能把用户手动点开的那一格抢回来。
    const au = blendDocs.activeUid;
    if (au !== prevActiveUid.current) resetRowInteraction();
    if (au != null && au !== prevActiveUid.current) {
      const u = docUnit(au);
      if (openDocUnits.includes(u) && !fresh.includes(u)) next = revealDoc(next, u);
    }
    prevActiveUid.current = au;
    if (next !== dock) applyDock(next);
  }, [dock, openDocUnits, applyDock, blendDocs.announced, blendDocs.activeUid]);
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
    // Video 模式：活跃文档窗的正文整个让给工作台画布（见 vidCanvasRef）—— 画布常驻，量到走带
    // 那条的上沿为止，播放按钮留在原位不被盖住。游标在 Layer 段上时画布折这一段图层；不在段上时
    // 页面自己换成视频底片（见 blend_node.html 的 vidBaseOn），所以这里不用再按段让位。
    if (host && body && (vidModeRef.current !== 'video' || vidCanvasRef.current) && body.clientWidth > 0 && body.clientHeight > 0) {
      const a = body.getBoundingClientRect(), b = host.getBoundingClientRect();
      let h = Math.round(a.height);
      // 视频模式把画布让进活跃窗时，播放器底下那条走带（⏮ ▶ ⏹）**不归画布**：量到它的上沿为止，
      // 按钮就留在原位、照常可按。Image 模式没有这一条，整块归画布。
      if (vidModeRef.current === 'video') {
        const tr = body.querySelector('[data-vid-transport]');
        if (tr) h = Math.max(1, Math.round(tr.getBoundingClientRect().top - a.top));
      }
      next = { x: Math.round(a.left - b.left), y: Math.round(a.top - b.top), w: Math.round(a.width), h };
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
  // 其余文档窗照旧显示各自的静帧。工作台画布常驻在播放器之上、只盖画面那一块（见 measureFrame /
  // vidCanvasRef）—— 底下那条走带仍归播放器，按钮留在原位；段外时画布内容就是当前视频帧。
  const docBodies: Record<UnitId, React.ReactNode> = {};
  for (const d of blendDocs.docs) {
    const active = d.uid === blendDocs.activeUid;
    const still = active ? null : docStills[d.uid];
    docBodies[docUnit(d.uid)] = active && vidMode === 'video'
      ? <VidPlayer vid={vidCtl} visible={tab === 'draw'} onCompLayer={showPlayLayer} />
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
          // 编辑当时 markVidDirty 已经把脏递过去了（工作台的 entry.dirty 就是它的账）。
          // 这里再补一发是兜底：万一工作台那本账丢过（iframe 重载后 entry.dirty 归零，
          // 而宿主还记着这份脏），关之前照样问一句。两条消息同目标同源，保序。
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

  /** 打开生成器轨的轨级提示词弹窗。轨上还没有 preset（或引用的那颗被删了）就先建一颗
   *  并把 id 记到轨上 —— preset 是共享持久化的，轨上所有段跑的时候都读它。 */
  const openVgenTrackPrompt = useCallback(async (trackId: string) => {
    const track = vidProjectRef.current.tracks.find(t => t.id === trackId);
    if (!track || track.role !== 'vgen') return;
    let pid = track.vgenPromptPresetId;
    if (!pid || !promptPresets.some(p => p.id === pid)) {
      const created = await createPromptPreset();
      if (!created) return;
      pid = created.id;
      vidUpdate(proj => setVideoGenTrackPreset(proj, trackId, pid!), 'Track prompt');
    }
    setVgenTrackPromptId(trackId);
  }, [vidProjectRef, promptPresets, createPromptPreset, vidUpdate]);

  /** 打开生成器段的段级提示词弹窗。段上还没有 preset（或引用的那颗被删了）就先建一颗
   *  并把 id 记到段的 vgen 上 —— 跑的时候渲染成串，拼在段 prompt 纯文本后、轨级 preset 前。 */
  const openVgenSegPrompt = useCallback(async (clipId: string) => {
    const clip = vidProjectRef.current.clips.find(c => c.id === clipId);
    if (!clip?.vgen) return;
    let pid = clip.vgen.promptPresetId;
    if (!pid || !promptPresets.some(p => p.id === pid)) {
      const created = await createPromptPreset();
      if (!created) return;
      pid = created.id;
      const newPid = pid;
      vidUpdate(proj => ({
        ...proj,
        clips: proj.clips.map(c => (c.id === clipId && c.vgen
          ? { ...c, vgen: { ...c.vgen, promptPresetId: newPid } } : c)),
      }), 'Segment prompt');
    }
    setVgenSegPromptId(clipId);
  }, [vidProjectRef, promptPresets, createPromptPreset, vidUpdate]);

  // .cud 帧卡的跳转：把用户挑进工程的路径 mint 成对话框同形的描述符（/api/cud_open），
  // 交给工作台的 blend-reopen-cud —— 已开着就切换过去，没开着就 Load 开新窗。
  // 后端拒了（非 .cud / 文件不在了）什么都不发生，帧绑定不动 —— 但要在 Log 里说一声，
  // "点了没反应"和"点了两下开了两个 tab"都得有得查。
  const openVgenCud = useCallback(async (path: string) => {
    try {
      const r = await fetch('/api/cud_open', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      }).then(x => x.json());
      if (r?.ok && r.doc) {
        blendIframeRef.current?.contentWindow?.postMessage(
          { type: 'blend-reopen-cud', doc: r.doc, reason: '' }, '*');
      } else {
        pushLog?.(`Jump refused: ${(r && r.error) || 'not a readable .cud'} — ${path}`, 'error');
      }
    } catch (e) {
      pushLog?.(`Jump failed: ${(e && (e as Error).message) || e}`, 'error');
    }
  }, [blendIframeRef, pushLog]);

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
  // notifies us — refresh the list (new content) and close whichever editor is open
  // (a prompt block's editor, or the generator track prompt modal).
  useEffect(() => {
    const onSaved = (event: MessageEvent) => {
      if (event.data?.type !== 'prompt-preset-saved') return;
      void refreshPromptPresets();
      setEditingPromptPresetId(null);
      setVgenTrackPromptId(null);
      setVgenSegPromptId(null);
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

  // 图里 interface 节点能选的包：只列开了 Block 模式的（Interface tab 的开关决定谁上得了链）；
  // 一枚都标不上时回落到全表（旧 interface 默认 1 进 1 出，免得存量链刷新后突然全 Missing）。
  // 每一枚都带**全表下标** —— 节点里存的 interface_idx 就是全表下标，选项值必须与它同一套。
  const graphInterfaces = (() => {
    const capable = interfaces.map((itf, idx) => ({ itf, idx })).filter(({ itf }) => {
      const meta = interfaceMeta[itf?.name];
      if (meta?.modes) return !!meta.modes.block;
      const inP = itf?.start_ports?.filter(p => p.type === 'PIPELINE_DATA').length ?? 0;
      const outP = itf?.end_ports?.filter(p => p.type === 'PIPELINE_DATA').length ?? 0;
      return inP === 1 && outP === 1;
    });
    const picked = capable.length > 0 ? capable : interfaces.map((itf, idx) => ({ itf, idx }));
    return picked.map(({ itf, idx }) => ({ name: itf.name, index: idx, start_ports: itf.start_ports }));
  })();
  const graphStaging = staging.map(s => ({ id: s.id, name: s.name }));


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
          iOS value field (grey while resting, white + a blue underline while editing). All scoped
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
        .ios-val { color: rgba(235,235,245,0.6); }
        .ios-val:focus { border-bottom-color: #0a84ff; color: #fff; }
        /* 正则框空着的时候，占位符就是它唯一的可辨识形状 —— 没有它，一张新规则卡上
           只有一个 15px 高的透明输入区，看上去就是"这一条没有正则参数"。 */
        .ios-val::placeholder { color: rgba(142,142,147,0.72); }
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
        /* 参数小窗（原 Effect Parameters 那一格）。取值照页面 .fx-params / .fx-fold-head / .fx-map-btn /
           .fx-curve-* 那几条，换的是宿主：这些类住在贴 chip 张开的小卡片里（fxPopover.tsx），页面那套
           .control-row 骨架已经不跟着过来了，所以名字宽度、读数右对齐这些由 wbStyles 说，这里只留形状与颜色。
           .fx-chip.open 是新的一层：参数面从链里搬出来以后，"哪一颗 chip 摊着"这件事必须仍然看得见，
           点亮的是那一枚 chip 自己（与页面当年那条 .fx-chip.open 同一个读法）。 */
        .fx-chip.open { background: rgba(10,132,255,0.16); box-shadow: inset 0 0 0 1px rgba(10,132,255,0.6); }
        .fx-pop { position: fixed; z-index: 320; display: flex; flex-direction: column;
            width: min(320px, calc(100vw - 16px)); max-height: min(440px, calc(100vh - 16px));
            border-radius: 10px; background: rgba(24,24,27,0.97); color-scheme: dark;
            backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%);
            border: 0.5px solid rgba(255,255,255,0.16); box-shadow: 0 14px 40px rgba(0,0,0,0.55); overflow: hidden; }
        .fx-pop-head { display: flex; align-items: center; gap: 6px; padding: 5px 6px 5px 9px; flex-shrink: 0;
            border-bottom: 0.5px solid rgba(255,255,255,0.09); }
        .fx-pop-title { font-size: 11.5px; font-weight: 700; color: rgba(255,255,255,0.88); white-space: nowrap; }
        .fx-pop-read { flex: 1; min-width: 0; text-align: right; font-size: 10.5px; color: rgba(255,255,255,0.5);
            font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .fx-pop-body { min-height: 0; overflow-y: auto; }
        .fx-pop-body .fx-params { max-height: none; overflow: visible; }
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
                  // 按钮左边 —— 那扇窗就是 Video 模式的播放器宿主，别的窗一概不给。运行状态
                  // （进度条 + Cancel）排在它的**左边**：同一扇窗，同一句话 —— "这一趟 run 属于
                  // 这份工程"。（Log / Debug 曾住这里,现在各自是一扇正式的 dock 窗。）
                  ...Object.fromEntries(blendDocs.docs.map(d => [docUnit(d.uid), (
                    <>
                      {/* 原本那颗 Cancel：视频 list 跑在飞时打断宿主这趟，否则照旧转页面的 staging-cancel */}
                      <RunStatusSeg onCancel={cancelActiveRun} />
                      {vidModeSeg}
                    </>
                  )])),
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
              // Tracks / Assets 是常驻的普通窗：**两种模式都显示正文** —— 轨道与资产属于文档，
              // 不该被 Video 模式这道门挡住（Image 模式下没有播放器，但时间线与资产库照常可用）。
              // **没有打开的文档 = 没有工程**：这两扇窗读的就是 vidProject，文档关光之后必须换成
              // 一句空态，不能把刚关掉那份的轨道/资产继续摆着（它们属于文档，不属于页面）。
              vtracks: blendDocs.activeUid === null
                ? <div style={styles.vidVoid}>No project open — Tracks belong to a document.</div>
                : <VidTimeline vid={vidCtl} onSettingsPlaceholders={setProcSettingsIds}
                    onRunVGen={id => { void runVideoGenSegment(id); }}
                    onPickVGenFrame={(id, which) => setVgenFramePick({ clipId: id, which })}
                    onVGenTrackSettings={setVgenTrackSettingsId}
                    onVGenTrackPrompt={openVgenTrackPrompt}
                    onVGenPrompt={id => { void openVgenSegPrompt(id); }}
                    onVGenCudOpen={path => { void openVgenCud(path); }} />,
              vassets: blendDocs.activeUid === null
                ? <div style={styles.vidVoid}>No project open — Assets belong to a document.</div>
                : <VidAssets vid={vidCtl} sel={vidInspect?.key ?? null} onSel={setVidInspect}
                    onActivate={() => revealPanel('vinspector')} />,
              // Inspector:放大看 Assets 里选中的那一件(图/音/视频)。与 vassets 同一道文档闸 ——
              // 没有工程就没有资产可挑,选中态也随文档切换被清掉(见上方 effect)。
              vinspector: blendDocs.activeUid === null
                ? <div style={styles.vidVoid}>No project open — inspect assets from the Assets window.</div>
                : <VidInspector sel={vidInspect} />,
              // Audio Monitor:谁持着全局独占音频槽就画谁(audioFocus 仲裁,页面级、不属于文档)。
              vaudio: <VidAudioMonitor />,
              // 工具窗三扇:Log(行为流水)/ Debug(上次 Run 快照)/ Probe(界面巡检)。
              // 彩色图标与彩色 tab 名来自 UNIT_COLORS。
              log: <LogPanel entries={actionLog} />,
              debug: <DebugPanel />,
              probe: <ProbePanelBody />,
              context: (
                // 无边框卡片(fullBleed + grows:预览吃满窗)。Mask Tint 不再常驻一行 ——
                // 指针停在预览图上才浮出滑块(浮层是悬停区的子节点,挪上去不会中途消失)。
                <div style={styles.contextCard}>
                  <div
                    style={styles.contextPreviewWrap}
                    onPointerEnter={() => setCtxTintHover(true)}
                    onPointerLeave={() => setCtxTintHover(false)}
                  >
                    {blendPreview ? (
                      <>
                        <img src={blendPreview.image} alt="Context preview" style={styles.blendPreviewImg} />
                        {blendPreview.size && <div style={styles.blendPreviewBadge}>{blendPreview.size}</div>}
                      </>
                    ) : (
                      <div style={styles.blendPreviewEmpty}>Add a layer to preview the composite</div>
                    )}
                    {ctxTintHover && blendPreview && (
                      <div style={{
                        position: 'absolute', left: '50%', bottom: 10, transform: 'translateX(-50%)', zIndex: 6,
                        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                        background: 'rgba(40,40,44,0.97)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
                        border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: 8,
                        boxShadow: '0 6px 22px rgba(0,0,0,0.5)', maxWidth: 'calc(100% - 16px)',
                      }}>
                        <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 500, color: 'rgba(255,255,255,0.62)' }}>Mask Tint</span>
                        <input
                          type="range" min={0} max={1} step={0.01} value={previewTint}
                          onChange={e => applyPreviewTint(parseFloat(e.target.value))}
                          title="How strongly the Mask layer reads in this preview. Independent from the workbench's own Mask layer tint."
                          style={{ flex: 1, minWidth: 90, accentColor: '#ff3b30', height: 14, cursor: 'pointer' }}
                        />
                        <span style={{ flexShrink: 0, fontSize: 10, color: 'rgba(255,255,255,0.5)', fontVariantNumeric: 'tabular-nums', minWidth: 24, textAlign: 'right' }}>{previewTint.toFixed(2)}</span>
                      </div>
                    )}
                  </div>
                </div>
              ),

              // PIPELINE — 这一格只有那一个下拉框：窗名已经说了它在选什么，再挂一枚
              // "Pipeline" 标签是同一句话说两遍；也不套内框（窗本身就是它的框）。
              pipeline: (<>
                <select
                  title={'Which pipeline is loaded on the node. Picking one switches it immediately.\n'
                    + PIPELINE_DEFAULT + ' = the pipeline wired into the node input — the workbench never learns its identity, '
                    + 'so this option only exists until you pick something else.\n'
                    + PIPELINE_CURRENT_SELECT + ' = keep whatever is loaded now, no reload.'}
                  style={{ ...styles.paramSelect, width: '100%', flex: 'none' }}
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
              </>),

              // PIPELINE PRESETS — 一扇窗只列 preset（多套 blocks 以行切换，可重命名/复制/删除，
              // 持久化在后端 config）；只有激活那一套会运行、会被发给 Blend 工作台。
              // Add 搬进了这一格**正文下面那条动作条**（与 Layers 同一范式：标题条是窗级动作的地方，
              // 往列表里加东西是内容动作，菜单从按钮往上翻、不会被 scroller 剪掉）。
              // 同样不套内框：每一行自己就是一张卡（有高亮/绑定徽标），外面再加一圈就是三重边框。
              presets: (<>
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
                  const runMasked = preprocessFlag(blockSets, set.id, 'enable_mask', true);
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
                        title={vidMode === 'video'
                          ? `Run 「${set.name}」 on video — video mode runs the chain on a picked clip/asset, frame by frame, in segments (a new track of placeholders fills in as it goes)`
                          : runMasked
                            ? `Run 「${set.name}」 now — ▶ 带框：按 Mask 层裁出的区域跑，产出贴回原图`
                            : `Run 「${set.name}」 now — 裸 ▶：整幅图就是工作区（Enable Mask 关，不做 mask 裁剪）`}
                        onClick={() => runPresetFromRow(set)}
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
              </>),

              // Preprocess 那批开关（Enable Mask / Recover Crop / Enable Fit / Enable Limit /
              // Enable Output / Dynamic Layer）已经搬进 Pipeline Graph 的黑板；数值参数
              // （Grow/Blur/Crop Reserve/Pixels/Align）仍在 Settings 页的 DEFAULT SETTING。
              blocks: (<>
                {/* 撑满这一格：编辑器高度 'fill'，父容器给确定高度（flex 链），画布才不会底下留白 */}
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, height: '100%' }}>
                  <PipelineGraphEditor graph={activeGraph} onChange={onGraphChange}
                    interfaces={graphInterfaces} staging={graphStaging} height="fill" architecture={architecture}
                    presets={promptPresets.map(p => ({ id: p.id, name: p.name }))}
                    onCreatePreset={async () => (await createPromptPreset())?.id ?? null}
                    onRenamePreset={(id, name) => void renamePromptPreset(id, name)}
                    onEditPreset={id => setEditingPromptPresetId(id)}
                    onDeletePreset={id => void deletePromptPreset(id)} />
                </div>
              </>),
            },
            // 几格自带的动作条（Clear All / Add / Undo / Redo）：dock 把它们画在各自正文下面、滚动条之外。
            foots: {
              ...workbenchFoots(uiSend, wbHost),
              // Pipeline Presets 的 Add：住进正文下面的动作条，与 Layers 那一格同一范式 ——
              // 标题条是窗级动作的地方（关窗/浮出/折叠），往列表里加 preset 是**内容**动作。
              // 菜单从这颗按钮**往上**翻（up），不然会被这一格的下边界剪掉。
              presets: (
                <div className="mini-group">
                  <button type="button" className="mini-btn" aria-haspopup="menu" aria-expanded={!!presetAddMenu}
                    title="Add a pipeline preset — a new, empty chain"
                    onClick={e => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setPresetAddMenu(presetAddMenu ? null : { x: r.left - 60, y: r.top });
                    }}>
                    Add<span className="add-caret">▾</span>
                  </button>
                  {presetAddMenu && (
                    <ContextMenu x={presetAddMenu.x} y={presetAddMenu.y} up onClose={() => setPresetAddMenu(null)}
                      items={[{ label: 'New Preset', color: '#0a84ff', hint: 'An empty preset — add blocks to it in the graph below', onClick: onAddBlockSet }]} />
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
      {editingPromptPresetId && (() => {
        const pid = editingPromptPresetId;
        const preset = promptPresets.find(p => p.id === pid);
        const params = 'sampler_base=' + encodeURIComponent(window.location.origin)
          + '&scope=prompt_preset&preset_id=' + encodeURIComponent(pid);
        const src = (promptUrl || '/prompt_node.html') + (promptUrl.includes('?') ? '&' : '?') + params;
        return (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }} onClick={() => setEditingPromptPresetId(null)}>
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
                    共享持久化 · 引用它的节点随改随生效
                  </span>
                </div>
                <button
                  style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}
                  title="Close"
                  onClick={() => setEditingPromptPresetId(null)}
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

      {/* Allow List 视频路的输入范围 + 分段帧数配置 —— 每次运行前由用户定（宿主才知道视频工程）。
          锚 = 第一行输入的源窗口（片段或资产），modal 里的输入范围就是它的跨度。 */}
      {vidSegCfg && (
        <VidSegModal
          anchorName={vidSegCfg.name}
          anchorKind={vidSegCfg.kind}
          spanStart={vidSegCfg.start}
          spanDuration={vidSegCfg.duration}
          total={vidSegCfg.total}
          fps={vidSegCfg.fps}
          checkRange={(inFrame, outFrame) => {
            const t0 = vidSegCfg.start + inFrame / vidSegCfg.fps;
            const t1 = vidSegCfg.start + outFrame / vidSegCfg.fps;
            const busyPort = vidSegCfg.ports.find(port => procSlotBusy(vidProjectRef.current, port, t0, t1 - t0));
            return busyPort == null
              ? null
              : `The output track already has a clip over ${t0.toFixed(1)}s–${t1.toFixed(1)}s — move or delete it first.`;
          }}
          onRun={(segFrames, inFrame, outFrame) => {
            setVidSegCfg(null);
            void runVideoListProcessor(segFrames, inFrame, outFrame);
          }}
          onClose={() => setVidSegCfg(null)}
        />
      )}
      {/* Pipeline Preset 的视频路：preset 没有输入口，源在 modal 里选（Tracks / Sel. Track /
          Asset），范围与每段帧数照旧。锚随源变 —— 换源就重挂，范围回到整段。 */}
      {vidPresetCfg && (() => {
        const a = resolvePresetSrc(vidPresetCfg.src);
        const proj = vidProjectRef.current;
        return (
          <VidSegModal
            key={`${vidPresetCfg.presetId}:${vidPresetCfg.src.kind}:${vidPresetCfg.src.trackId}:${vidPresetCfg.src.assetId}`}
            title={`Run 「${vidPresetCfg.presetName}」 on video`}
            subtitle={a.err ? `⚠ ${a.err}` : 'Pipeline Preset · frames are run through the chain one by one, in segments'}
            note={`Each segment extracts its frames, runs the whole preset chain on every frame, and encodes the results back to video. The placeholders stay on their own track; every finished segment lands on the output track above, at the same timeline position, and the placeholder can be run again any time (its previous result is replaced). Run / ▶ turn grey while something else already occupies that spot. Mask comes from the track bound in the Tracks window (none bound = no mask).`}
            anchorName={a.name}
            anchorKind={a.kind}
            spanStart={a.start}
            spanDuration={a.duration}
            total={a.total}
            fps={proj.fps}
            defaultIn={a.kind === 'clip' ? vidTransport.get() : undefined}
            checkRange={(inFrame, outFrame) => {
              const t0 = a.start + inFrame / proj.fps;
              const t1 = a.start + outFrame / proj.fps;
              return procSlotBusy(vidProjectRef.current, 0, t0, t1 - t0)
                ? `The output track already has a clip over ${t0.toFixed(1)}s–${t1.toFixed(1)}s — move or delete it first.`
                : null;
            }}
            sources={{
              ...vidPresetCfg.src,
              tracks: proj.tracks.filter(t => t.kind === 'video').map(t => ({ id: t.id, name: t.name })),
              assets: proj.assets.filter(x => x.kind === 'video').map(x => ({ id: x.id, name: x.name })),
              onChange: next => setVidPresetCfg(c => (c ? { ...c, src: next } : c)),
            }}
            onRun={(segFrames, inFrame, outFrame) => {
              const cfg = vidPresetCfg;
              setVidPresetCfg(null);
              void runVideoPreset(cfg.presetId, cfg.presetName, cfg.src, segFrames, inFrame, outFrame);
            }}
            onClose={() => setVidPresetCfg(null)}
          />
        );
      })()}
      {/* 占位段批量设置：多选后点齿轮，一批一起改；值不一样的字段显示 — 且不写回。 */}
      {procSettingsIds && (() => {
        const ids = procSettingsIds;
        const clips = vidProject.clips.filter(c => ids.includes(c.id) && c.pending);
        if (!clips.length) return null;
        return (
          <PlaceholderSettingsModal
            clips={clips}
            interfaces={interfaces}
            presets={blockSets.map(s => ({ id: s.id, name: s.name }))}
            videoTracks={vidProject.tracks.filter(t => t.kind === 'video').map(t => ({ id: t.id, name: t.name }))}
            onApply={patch => {
              setProcSettingsIds(null);
              vidUpdate(proj => applyProcSettings(proj, ids, patch), 'Placeholder settings');
            }}
            onClose={() => setProcSettingsIds(null)}
          />
        );
      })()}
      {/* 生成器轨/段的提示词：prompt block 同一套编辑弹窗 —— 完整的 prompt_node UI 以
          preset scope 挂进来，选择保存进共享 preset（服务端持久化）。 */}
      {vgenTrackPromptId && (() => {
        const track = vidProject.tracks.find(t => t.id === vgenTrackPromptId);
        const pid = track?.vgenPromptPresetId;
        if (!track || track.role !== 'vgen' || !pid) return null;
        return (
          <PromptPresetModal
            title={`Track prompt — ${track.name}`}
            subtitle="追加在这条轨每段自己的提示词后面 · 共享持久化"
            promptUrl={promptUrl}
            presetId={pid}
            onClose={() => setVgenTrackPromptId(null)}
          />
        );
      })()}
      {vgenSegPromptId && (() => {
        const clip = vidProject.clips.find(c => c.id === vgenSegPromptId);
        const pid = clip?.vgen?.promptPresetId;
        if (!clip?.vgen || !pid) return null;
        return (
          <PromptPresetModal
            title={`Segment prompt — ${clip.name}`}
            subtitle="这一段自己的选择 · 跑时拼在段 prompt 纯文本后、轨级提示词前"
            promptUrl={promptUrl}
            presetId={pid}
            onClose={() => setVgenSegPromptId(null)}
          />
        );
      })()}
      {/* 生成器轨的设置：宽高 / from canvas / scale，轨上所有段共享。 */}
      {vgenTrackSettingsId && (() => {
        const track = vidProject.tracks.find(t => t.id === vgenTrackSettingsId);
        if (!track || track.role !== 'vgen') return null;
        const first = vidProject.clips.find(c => c.trackId === track.id && c.vgen)?.vgen;
        const paramNum = (slot: 'width' | 'height'): number => {
          const port = first?.ports[slot];
          const n = port ? Number(first!.params[String(port)]) : NaN;
          return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
        };
        return (
          <VideoGenTrackModal
            track={track}
            seed={{ width: paramNum('width') || 832, height: paramNum('height') || 480 }}
            canvas={getBlendUi().canvas}
            onApply={cfg => {
              const tid = track.id;
              setVgenTrackSettingsId(null);
              vidUpdate(proj => setVideoGenTrackCfg(proj, tid, cfg), 'Generator track settings');
            }}
            onClose={() => setVgenTrackSettingsId(null)}
          />
        );
      })()}
      {/* video generator 段的首/末帧绑定：图片资产（按哈希直读仓库字节）或磁盘上一份 .cud
          工程（后端读它的合成图当这一帧）。 */}
      {vgenFramePick && (() => {
        const clip = vidProject.clips.find(c => c.id === vgenFramePick.clipId);
        if (!clip?.vgen) return null;
        return (
          <VideoGenFrameModal
            which={vgenFramePick.which}
            ifaceName={clip.vgen.iface}
            current={vgenFramePick.which === 'first_frame' ? clip.vgen.first_frame : clip.vgen.last_frame}
            onPick={ref => {
              setVgenFrame(clip.id, vgenFramePick.which, ref);
              setVgenFramePick(null);
            }}
            onClose={() => setVgenFramePick(null)}
          />
        );
      })()}
    </div>
  );
};

// ── Video Generator 的小窗 ────────────────────────────────────────────────────────────────
// 首/末帧绑定：值住在段上（vgen 引用），这扇窗只是"把引用交给段"，不认识接口、也不认识执行。

/** prompt block 同款编辑弹窗：完整的 prompt_node UI 以 preset scope 挂进来，选择保存进
 *  共享 preset（服务端持久化）。生成器轨的轨级提示词与段的提示词共用这一扇。 */
const PromptPresetModal: React.FC<{
  title: string;
  subtitle: string;
  promptUrl: string;
  presetId: string;
  onClose: () => void;
}> = ({ title, subtitle, promptUrl, presetId, onClose }) => {
  const params = 'sampler_base=' + encodeURIComponent(window.location.origin)
    + '&scope=prompt_preset&preset_id=' + encodeURIComponent(presetId);
  const src = (promptUrl || '/prompt_node.html') + (promptUrl.includes('?') ? '&' : '?') + params;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
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
            {title}
            <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.45)', marginLeft: 8 }}>
              {subtitle}
            </span>
          </div>
          <button
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}
            title="Close"
            onClick={onClose}
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
};

/** 生成器**轨**的设置：这条轨上所有段跑的时候用的宽高与帧率。From canvas 开着 = 工作台画布 ×
 *  scale（跑的这一刻现算），宽高灰掉、只留 scale；关着就是两个固定数。fps 只覆写没开
 *  Fixed FPS 的段。 */
const VideoGenTrackModal: React.FC<{
  track: { name: string; port?: number; vgenCfg?: VidGenTrackCfg };
  seed: { width: number; height: number };
  canvas: { w: number; h: number };
  onApply: (cfg: VidGenTrackCfg) => void;
  onClose: () => void;
}> = ({ track, seed, canvas, onApply, onClose }) => {
  const cfg = track.vgenCfg;
  const [fromCanvas, setFromCanvas] = useState(!!cfg?.fromCanvas);
  const [w, setW] = useState(String(cfg?.width ?? seed.width));
  const [h, setH] = useState(String(cfg?.height ?? seed.height));
  const [scale, setScale] = useState(String(cfg?.scale ?? 1));
  const [fps, setFps] = useState(cfg?.fps != null ? String(cfg.fps) : '');
  const s = Number(scale);
  const scaleOk = Number.isFinite(s) && s > 0;
  const factor = scaleOk ? s : 1;
  const fpsOk = fps === '' || (Number.isFinite(Number(fps)) && Number(fps) >= 1);
  // 画布量到了才显示得出换算结果；没量到（工作台没开/还没播报）就灰着显示旧值。
  const resolved = canvas.w > 0 && canvas.h > 0
    ? { w: Math.max(1, Math.round(canvas.w * factor)), h: Math.max(1, Math.round(canvas.h * factor)) }
    : null;
  const dirty = !cfg || cfg.fromCanvas !== fromCanvas
    || (!fromCanvas && (Math.round(Number(w)) !== cfg.width || Math.round(Number(h)) !== cfg.height))
    || (fromCanvas && Math.abs((scaleOk ? s : 1) - cfg.scale) > 1e-6)
    || ((cfg?.fps != null ? String(cfg.fps) : '') !== fps);
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 };
  const lab: React.CSSProperties = { fontSize: 11.5, fontWeight: 600, color: 'rgba(255,255,255,0.62)', width: 92, flexShrink: 0 };
  const inp: React.CSSProperties = {
    flex: 1, minWidth: 0, background: 'rgba(0,0,0,0.35)', border: '0.5px solid rgba(255,255,255,0.16)',
    borderRadius: 6, padding: '4px 8px', color: '#fff', fontSize: 12, outline: 'none',
  };
  const dim = (on: boolean): React.CSSProperties => on ? {} : { opacity: 0.35, cursor: 'default' };
  const mini: React.CSSProperties = {
    flexShrink: 0, fontSize: 10.5, fontWeight: 700, padding: '3px 10px', borderRadius: 5, cursor: 'pointer',
    background: 'rgba(0,0,0,0.35)', color: 'rgba(255,255,255,0.55)', border: '0.5px solid rgba(255,255,255,0.16)',
  };
  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={{ ...styles.dialog, width: 460, display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}>
        <div style={styles.dialogTitle}>Generator track settings</div>
        <div style={styles.dialogSubtitle}>
          「{track.name}」{track.port ? ` · port ${track.port}` : ''} — every generator segment on this track runs
          at this resolution. From canvas follows the workbench canvas × scale at the moment a segment runs.
        </div>
        <div style={row}>
          <span style={lab}>Size</span>
          <button style={{ ...mini, ...(fromCanvas ? { color: '#fff', background: 'rgba(10,132,255,0.35)', borderColor: 'rgba(10,132,255,0.75)' } : {}) }}
            onClick={() => setFromCanvas(false)}>Fixed</button>
          <button style={{ ...mini, ...(!fromCanvas ? { color: '#fff', background: 'rgba(10,132,255,0.35)', borderColor: 'rgba(10,132,255,0.75)' } : {}) }}
            onClick={() => setFromCanvas(true)}>From canvas</button>
        </div>
        <div style={row} title={fromCanvas
          ? 'Width / height follow the workbench canvas × scale — fixed values are off.'
          : undefined}>
          <span style={lab}>Width</span>
          <input style={{ ...inp, ...dim(fromCanvas) }} type="number" min={1} step={1}
            value={fromCanvas ? String(resolved?.w ?? w) : w} disabled={fromCanvas}
            onChange={e => setW(e.target.value)} onKeyDown={e => e.stopPropagation()} />
        </div>
        <div style={row}>
          <span style={lab}>Height</span>
          <input style={{ ...inp, ...dim(fromCanvas) }} type="number" min={1} step={1}
            value={fromCanvas ? String(resolved?.h ?? h) : h} disabled={fromCanvas}
            onChange={e => setH(e.target.value)} onKeyDown={e => e.stopPropagation()} />
        </div>
        {fromCanvas && (
          <div style={row} title={resolved
            ? `The canvas is ${canvas.w}×${canvas.h} — × ${factor.toFixed(2)} = ${resolved.w}×${resolved.h}.`
            : 'The workbench canvas has not reported a size yet — the stored width / height are used as the fallback.'}>
            <span style={lab}>Scale</span>
            <input style={inp} type="number" min={0.01} step={0.05} value={scale}
              onChange={e => setScale(e.target.value)} onKeyDown={e => e.stopPropagation()} />
          </div>
        )}
        {/* 轨级 FPS：跑的时候覆写每一段 fps 口喂进去的值 —— Fixed FPS 开着的段不吃这个
            （它的输出帧率写死在生成器上）。留空 = 不动段上的旧参数。 */}
        <div style={row} title="Overrides the FPS parameter of every generator segment on this track when it runs. Segments with Fixed FPS turned on are not affected. Leave empty to keep each segment's own value.">
          <span style={lab}>FPS</span>
          <input style={{ ...inp, ...(!fpsOk ? { borderColor: 'rgba(255,69,58,0.75)' } : {}) }}
            type="number" min={1} step={0.1} placeholder="segment's own" value={fps}
            onChange={e => setFps(e.target.value)} onKeyDown={e => e.stopPropagation()} />
        </div>
        <div style={styles.dialogActions}>
          <button style={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button style={{ ...styles.confirmBtn, opacity: dirty && fpsOk ? 1 : 0.45 }} disabled={!dirty || !fpsOk}
            onClick={() => onApply({
              width: Math.max(1, Math.round(Number(w)) || seed.width),
              height: Math.max(1, Math.round(Number(h)) || seed.height),
              fromCanvas, scale: scaleOk ? s : 1,
              ...(fps !== '' && fpsOk ? { fps: Number(fps) } : {}),
            })}>Apply</button>
        </div>
      </div>
    </div>
  );
};

/** 段的首/末帧：从仓库挑一张图（**Assets 窗同款卡片**，同一套缩略/角标/名字长相），
 *  或磁盘上一份 .cud 工程（当前绑定也画成一张卡，缩略走同一接口）。 */
const VideoGenFrameModal: React.FC<{
  which: 'first_frame' | 'last_frame';
  ifaceName: string;
  current?: VidGenFrameRef | null;
  onPick: (ref: VidGenFrameRef | null) => void;
  onClose: () => void;
}> = ({ which, ifaceName, current, onPick, onClose }) => {
  const [rows, setRows] = useState<StoreAsset[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    void fetch('/api/global_assets').then(r => r.json()).then((d: { assets?: StoreAsset[] } | StoreAsset[]) => {
      if (!alive) return;
      const list = Array.isArray(d) ? d : (d?.assets || []);
      // 挑帧只用图：带 kind 的按 kind 过滤；老服务没有 kind 的行保留（宁可多显示）。
      setRows(list.filter(a => a && (a.hash || a.name) && (!a.kind || a.kind === 'image')));
    }).catch(() => { if (alive) setErr('The asset store did not answer.'); });
    return () => { alive = false; };
  }, []);
  const label = which === 'first_frame' ? 'First frame' : 'Last frame';
  // 磁盘上的 .cud：走后端那扇原生对话框（浏览器拿不到真实路径），挑中后**只记路径** ——
  // 字节在跑的那一刻才由后端读（它认得 .cud 里那一幅合成图）。
  const pickCud = async () => {
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/io_pick', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'open', kind: 'cud' }),
      }).then(r => r.json());
      const picks: { token?: string; name?: string; path?: string }[] = r?.picks || [];
      const first = picks.find(p => p && (p.path || p.token));
      if (!first) { setBusy(false); return; }       // 取消
      onPick({ kind: 'cud', path: String(first.path || first.token || ''),
        name: first.name || String(first.path || '').split(/[\\/]/).pop() });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const needle = q.trim().toLowerCase();
  const shown = rows.filter(a => !needle
    || (a.displayName || a.name || '').toLowerCase().includes(needle)
    || (a.hash || '').toLowerCase().includes(needle));
  // 当前绑的 .cud 也占一张卡：缩略与时间线帧卡同一条 /api/cud_frame_thumb。点它 = 再开一次
  // 对话框换一份 .cud（换绑定仍然只有一个入口）。
  const cudPath = current?.kind === 'cud' ? current.path : '';
  return (
    <div style={styles.overlay} onClick={onClose}>
      <div data-vid-frame-modal=""
        style={{ ...styles.dialog, width: 640, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}>
        <div style={styles.dialogTitle}>{label}</div>
        <div style={styles.dialogSubtitle}>
          「{ifaceName}」 — bind an image asset, or a .cud project (its composite is read as this frame).
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexShrink: 0, alignItems: 'center' }}>
          <button style={{ ...styles.cancelBtn, opacity: busy ? 0.5 : 1 }}
            disabled={busy} onClick={() => { void pickCud(); }}>Open a .cud…</button>
          {current && (
            <button style={styles.cancelBtn} onClick={() => onPick(null)}>Unbind</button>
          )}
          <span style={{ flex: 1 }} />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search…"
            spellCheck={false}
            style={{
              width: 150, height: 20, fontSize: 10, color: 'rgba(255,255,255,0.75)',
              background: '#1b1b1e', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 4,
              padding: '0 5px', outline: 'none',
            }}
          />
        </div>
        {err && <div style={{ fontSize: 11, color: '#ff9f0a', marginBottom: 8 }}>{err}</div>}
        <div style={{
          flex: 1, minHeight: 140, overflowY: 'auto', scrollbarWidth: 'thin',
          padding: 2, display: 'grid', gap: 6, alignContent: 'start',
          gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))',
        }}>
          {cudPath && (
            <Card
              it={{
                name: current?.name || cudPath.split(/[\\/]/).pop() || cudPath,
                kind: 'image', src: '', duration: 0, hasAudio: null,
                poster: `/api/cud_frame_thumb?path=${encodeURIComponent(cudPath)}&w=160`,
                origin: '.cud project',
              }}
              selected
              onClick={() => { void pickCud(); }}
            />
          )}
          {shown.map(s => {
            const id = s.hash || s.name;
            const on = !!current && current.kind === 'asset' && current.hash === id;
            return (
              <Card
                key={'s:' + id}
                it={{
                  name: s.displayName || s.name,
                  kind: 'image', src: s.url || '', duration: 0, hasAudio: null,
                  poster: s.thumb || s.url || null,
                  byteFrom: 'store', origin: s.origin || (s.inLibrary === false ? 'session' : 'library'),
                }}
                selected={on}
                onClick={() => onPick({ kind: 'asset', hash: id, name: s.displayName || s.name })}
              />
            );
          })}
          {!cudPath && shown.length === 0 && (
            <div style={{ gridColumn: '1 / -1', padding: 16, fontSize: 11, color: 'rgba(255,255,255,0.35)', textAlign: 'center', lineHeight: 1.8 }}>
              {err ? '' : 'The asset store has no images yet — import one in Assets, or open a .cud.'}
            </div>
          )}
        </div>
        <div style={styles.dialogActions}>
          <button style={styles.cancelBtn} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};

// ── SettingsTab ──
// Two screens behind one iOS segmented control, dressed as iOS Settings' inset-grouped lists: a
// centered column with a large title, uppercase section headers, #1c1c1e cards with 44px rows and
// hairline separators inset to the text, and a grey footer under each card stating what the group
// does (the tooltips keep the longer form — footer is the glanceable sentence). DEFAULT SETTING is
// the nine numeric knobs every run starts from (they used to sit at the bottom of the Draw column);
// ARCHITECTURE is a list of rules — each one a regex matched against the architecture of the
// pipeline that actually runs — replacing some of those nine for the runs it catches. The numbers
// stay the host's either way: this page only edits what the Draw panel edited, so a value can
// never exist twice.
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
// the input ceilings (a memory cap, 0 = off) never read as one undifferentiated list. The footer
// under each card is the one-sentence version of what the row tooltips say — visible without hover.
const SETTINGS_GROUPS: { title: string; hint?: string; keys: OverrideKey[]; footer: string }[] = [
  { title: 'Output Preprocessing', keys: ['mask_grow', 'mask_blur', 'crop_reserve'],
    footer: 'The mask is grown outwards and feathered before the working area is cropped.' },
  { title: 'Working Resolution', keys: ['pixels', 'align'],
    footer: 'The cropped area is resized to fit the pixel budget — a small crop is enlarged to reach it.' },
  { title: 'Input Ceilings', hint: '0 = no limit', keys: ['ref_pixels', 'ref_align', 'tgen_pixels', 'tgen_align'],
    footer: 'Shrink-only caps on images going in — images already inside the budget are left alone.' },
];
{
  const lost = OVERRIDE_KEYS.filter(k => !SETTINGS_GROUPS.some(g => g.keys.includes(k)));
  if (lost.length) console.warn(`[Settings] OVERRIDE_KEYS in no card: ${lost.join(', ')} — they would not render`);
}

const segBtnStyle = (on: boolean): React.CSSProperties => ({
  flex: 1, padding: '6px 0', borderRadius: 7, border: 'none', outline: 'none', cursor: 'pointer',
  fontSize: 13, fontWeight: 600, background: on ? '#636366' : 'transparent',
  color: on ? '#fff' : 'rgba(255,255,255,0.62)', boxShadow: on ? '0 3px 8px rgba(0,0,0,0.35)' : 'none',
});

const DragHandleIcon: React.FC = () => (
  <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" style={{ display: 'block' }}>
    <circle cx="2.5" cy="3" r="1.3" /><circle cx="7.5" cy="3" r="1.3" />
    <circle cx="2.5" cy="8" r="1.3" /><circle cx="7.5" cy="8" r="1.3" />
    <circle cx="2.5" cy="13" r="1.3" /><circle cx="7.5" cy="13" r="1.3" />
  </svg>
);

// 数值框，iOS 的 value 形态：平时按千分位右对齐（次级灰），点进去选全、按纯数字编辑，松手
// 回到格式化的读数；↑/↓ 按 step 增减并夹在 [min, max]（原生 number input 的键盘行为，格式化
// 显示是它给不了的）。中间输入不回显 clamp —— 显示走 draft（编辑器里的原始文本），比如把
// 65536 逐位打成 1048576 的途中不会被 min 当场弹回 65536，落焦点才见格式化的终值。
const NumField: React.FC<{
  value: number; min: number; max: number; step: number;
  disabled?: boolean; onChange: (n: number) => void; style?: React.CSSProperties;
}> = ({ value, min, max, step, disabled, onChange, style }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  const emit = (text: string) => {
    const n = parseInt(text.replace(/[^\d]/g, ''), 10);
    onChange(Number.isFinite(n) ? clamp(n) : 0);
  };
  return (
    <input className="ios-val" type="text" inputMode="numeric" disabled={disabled}
      style={{ ...styles.iosNum, ...(style || {}) }}
      value={draft ?? value.toLocaleString('en-US')}
      onFocus={e => {
        const el = e.currentTarget;
        setDraft(String(value));
        // 选全要等 React 把 draft 落进 DOM 之后 —— 同步选会被紧跟的重渲清掉。
        // setTimeout 而不是 rAF：后者在节流的后台标签里一次都不跑。
        setTimeout(() => el.select(), 0);
      }}
      onChange={e => {
        // 草稿只留数字：粘贴 "1,048,576" 这类带分隔符的文本时显示保持纯数字,
        // 也防着"焦点事件丢了、编辑落在格式化文本上"的残局(异常环境下不会越滚越脏)。
        const text = e.target.value.replace(/[^\d]/g, '');
        setDraft(text); emit(text);
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={e => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const next = clamp(value + (e.key === 'ArrowUp' ? step : -step));
        setDraft(String(next)); onChange(next);
      }}
    />
  );
};

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
  // 新出现的一条规则（Add / Duplicate）自己展开、并把光标放进它的正则框 —— 一条还没有正则的
  // 规则在屏幕上是张空卡，不给这两下的话用户得先猜到那个框在哪儿。首次渲染（从后端读回来的
  // 那批）不算"新出现"，否则一进这一屏焦点就被抢走。
  const seenRuleIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = archSettings.rules.map(r => r.id);
    if (seenRuleIds.current === null) { seenRuleIds.current = new Set(ids); return; }
    const fresh = ids.find(id => !seenRuleIds.current!.has(id));
    ids.forEach(id => seenRuleIds.current!.add(id));
    if (!fresh) return;
    if (!ui.openRules.includes(fresh)) {
      const next = { ...ui, openRules: [...ui.openRules, fresh] };
      setUi(next); saveSettingsUI(next);
    }
    requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>(`input[data-arch-pattern="${fresh}"]`)?.focus();
    });
  }, [archSettings.rules, ui]);

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
        <div style={styles.iosPageTitle}>Settings</div>

        {/* 子 tab：iOS 分段控件。选哪屏是视图状态，落 sampler.settingsUI（用户的选择，不自动跳）。 */}
        <div style={styles.iosSeg}>
          <button style={segBtnStyle(ui.screen === 'default')} onClick={() => pickScreen('default')}
            title="The nine values every run falls back to">Default Setting</button>
          <button style={segBtnStyle(ui.screen === 'arch')} onClick={() => pickScreen('arch')}
            title="Regex rules that replace some of those values for the runs they catch">Architecture</button>
        </div>

        {/* DEFAULT SETTING — 三张卡：输出前处理 / 工作分辨率 / 输入封顶，每张卡下面跟一句 footer
            （组语义的一目了然版）。范围与说明仍出自 DEFAULT_PARAM_META 那一张表（规则卡读同一张）。 */}
        {ui.screen === 'default' && SETTINGS_GROUPS.map(group => (
          <React.Fragment key={group.title}>
            <div style={styles.iosGroupTitle}>{group.title}{group.hint && <em style={styles.iosGroupHint}>{group.hint}</em>}</div>
            <div style={styles.iosCard}>
              {group.keys.map((key, i) => {
                const m = DEFAULT_PARAM_META[key];
                return (
                  <React.Fragment key={key}>
                    {i > 0 && <div style={styles.iosSep} />}
                    <div style={styles.iosRow} title={m.title}>
                      <span style={styles.iosLabel}>{m.label}</span>
                      <NumField value={values[key]} min={m.min} max={m.max} step={m.step}
                        onChange={n => onDefaultParamChange(key, n)} />
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
            <div style={styles.iosFooter}>{group.footer}</div>
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
            <div style={styles.iosFooter}>What happens when a node opens its UI while a run is going.</div>
          </>
        )}

        {/* ARCHITECTURE — 一张卡一条规则：卡头是把手 + 正则框 + 徽章 + 折叠箭头（"architecture"
            那个前缀标签撤了 —— 框里的正则本身和占位符已经把"这是什么"说全，宽度还给输入框），
            九排在收起时不画。 */}
        {ui.screen === 'arch' && (<>
          <div style={styles.iosGroupTitle}>Rules<em style={styles.iosGroupHint}>first match wins</em></div>
          {archSettings.rules.map((rule, idx) => {
            const problem = patternProblem(rule.architecture);
            const open = ui.openRules.includes(rule.id);
            const onCount = OVERRIDE_KEYS.filter(k => !!rule.overrides[k]?.enabled).length;
            return (
              <div key={rule.id} style={{ ...styles.iosCard, marginBottom: 10, ...(problem ? styles.iosCardBad : {}) }}
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
                <div style={{ ...styles.iosRow, minHeight: 46 }}
                  onClick={e => { if ((e.target as HTMLElement).closest('input')) return; toggleRule(rule.id); }}
                  title={'Regex matched against the loaded pipeline\'s architecture (case-insensitive search). '
                    + 'Rules go top to bottom and the first one that matches wins, whole.'
                    + (problem ? '\n' + problemNote(problem) : '')}>
                  <span style={styles.iosHandle}><DragHandleIcon /></span>
                  <input className="ios-val" style={styles.iosPattern} data-arch-pattern={rule.id}
                    placeholder="pattern — e.g. qwen|flux"
                    value={rule.architecture}
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
                    右半边摆的就是 Default Setting 那一屏的现值（整行压暗）。分隔线跟着
                    文本起点内缩（把手那一格的宽度不算在内）。 */}
                {open && OVERRIDE_KEYS.map(key => {
                  const m = DEFAULT_PARAM_META[key];
                  const entry = rule.overrides[key];
                  const on = !!entry?.enabled;
                  return (
                    <React.Fragment key={key}>
                      <div style={{ ...styles.iosSep, marginLeft: 42 }} />
                      <div style={{ ...styles.iosRow, paddingLeft: 42 }}
                        title={`${m.label} — off = runs matched by this rule use the Default Setting (${values[key]}). `
                          + 'On = the number on the right replaces it.'}>
                        <span style={{ ...styles.iosLabel, opacity: on ? 1 : 0.4 }}>{m.label}</span>
                        <NumField value={entry?.value ?? values[key]} min={m.min} max={m.max} step={m.step}
                          disabled={!on} style={{ opacity: on ? 1 : 0.4 }}
                          onChange={n => setRuleParam(rule.id, key, { value: n })} />
                        <div onClick={e => e.stopPropagation()}>
                          <IOSToggle checked={on}
                            onChange={v => setRuleParam(rule.id, key, { enabled: v, value: entry?.value ?? values[key] })} />
                        </div>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            );
          })}
          {archSettings.rules.length > 0 ? (
            <div style={styles.iosCard}>
              <button style={styles.iosAddRow} onClick={onAddArchRule}
                title="A new rule matches nothing until you type its pattern">Add Rule</button>
            </div>
          ) : (
            // 空态也是一张卡：一句话 + Add Rule 行，页面不留光板。
            <div style={styles.iosCard}>
              <div style={styles.iosEmpty}>No rules — every run uses the Default Setting as-is.</div>
              <div style={{ ...styles.iosSep, marginLeft: 0 }} />
              <button style={styles.iosAddRow} onClick={onAddArchRule}
                title="A new rule matches nothing until you type its pattern">Add Rule</button>
            </div>
          )}
          <div style={styles.iosFooter}>
            Top to bottom — the first rule whose pattern matches the pipeline&apos;s architecture replaces
            those values whole; everything it leaves off falls back to Default Setting.
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
  const setIfaceMode = (iface: string, key: 'block' | 'processor' | 'video_generator', on: boolean) => {
    const cur = metaFor(iface);
    patchMeta(iface, {
      modes: { block: false, processor: false, video_generator: false, ...(cur.modes || {}), [key]: on },
    });
  };
  // Video Generator：八个固定槽各绑一个端口。绑的是**端口号**（执行全程按号走），
  // 槽位名是这个端口在这一台生成器里扮演的角色。
  const setVideoGenPort = (iface: string, slot: VideoGenSlot, num: number) => {
    const cur = metaFor(iface);
    const ports = { ...((cur.video_gen?.ports) || {}) };
    if (num > 0) ports[slot] = num; else delete ports[slot];
    const next: VideoGenConfig = { ...(cur.video_gen || {}), ports };
    patchMeta(iface, { video_gen: next });
  };
  const setVideoGenFixedFps = (iface: string, on: boolean) => {
    const cur = metaFor(iface);
    // 打开时顺手把 fps 槽解绑（帧率改由这颗开关上的数字定，端口不再参与），
    // 关掉时把数字留着（来回切的时候不用重填）。
    const ports = { ...((cur.video_gen?.ports) || {}) };
    if (on) delete ports.fps;
    patchMeta(iface, {
      video_gen: {
        ...(cur.video_gen || {}), ports, fixed_fps: on,
        fixed_fps_value: Number(cur.video_gen?.fixed_fps_value) > 0 ? cur.video_gen?.fixed_fps_value : 16,
      },
    });
  };
  /** Fixed FPS 的那个数（1..120）。空/非法按下一次能解析出来的值兜底。 */
  const setVideoGenFixedFpsValue = (iface: string, text: string) => {
    const cur = metaFor(iface);
    const n = Number(text);
    const val = Number.isFinite(n) ? Math.max(1, Math.min(120, n)) : (Number(cur.video_gen?.fixed_fps_value) || 16);
    patchMeta(iface, { video_gen: { ...(cur.video_gen || { ports: {} }), fixed_fps_value: val } });
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
                  // Video Generator：至少要有一个出口（VIDEO 直接回片；IMAGE 回一批帧，
                  // 跑完由后端按 fps 现编成一段 —— 两种都能往输出轨上落）。
                  const videoOut = iface.end_ports?.filter(p => p.type === 'VIDEO' || p.type === 'IMAGE') ?? [];
                  const canVideoGen = videoOut.length > 0;
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
                      {/* Video Generator：把这个包**声明**成一台视频生成器 —— 八个固定槽各绑
                          一个端口，时间线上的 video generator 段照这份绑定填参数、接产物。
                          绑哪些是用户的事，槽位本身是死的：段那一侧因此不必认识任何具体接口。 */}
                      <div style={{ ...toggleRow, marginBottom: 0 }}>
                        <span style={toggleLabel} title="Video Generator 模式：把这个包当成一台视频生成器 —— 下面这八个固定槽各绑一个端口，Processor 窗就能往 process 轨上摆 video generator 段。">Video Generator</span>
                        <IOSToggle checked={!!modes.video_generator} onChange={v => {
                          if (v && !canVideoGen) { setModeHint(prev => ({ ...prev, [idx]: 'Video Generator mode needs at least one VIDEO or IMAGE output port.' })); return; }
                          setModeHint(prev => ({ ...prev, [idx]: '' }));
                          setIfaceMode(iface.name, 'video_generator', v);
                        }} />
                      </div>
                      {/* Allow List：只在 Processor 开着时给。开着 = 这一口吃一整列图/mask（视频逐帧、
                          多张 staging），吐出来也是 list；执行时按每个内部节点是不是 INPUT_IS_LIST
                          分流（直通 list / 逐帧跑再合并）。视频模式下 Processor 窗的 image 输入行
                          会多出一枚 Video 候选，产物落成新轨上的视频。 */}
                      {modes.processor && (
                        <div style={toggleRow}>
                          <span style={toggleLabel} title="Allow List：Processor 的 image/mask 输入按**一整列**收（视频模式下 = 游标底下那段视频逐帧），输出也是 list。内部节点是 INPUT_IS_LIST 的直接吃 list，否则逐帧跑完再合并。">Allow List</span>
                          <IOSToggle checked={!!meta.allow_list} onChange={v => {
                            setModeHint(prev => ({ ...prev, [idx]: '' }));
                            patchMeta(iface.name, { allow_list: v });
                          }} />
                        </div>
                      )}
                      {/* Video Generator 的槽位绑定：每个槽一枚 enum 下拉（只列类型对得上的
                          端口）。带 * 的是必绑 —— 少了它们段既不知道画多大、也不知道该占多长。 */}
                      {modes.video_generator && (() => {
                        const vg: VideoGenConfig = meta.video_gen || { ports: {} };
                        const ports = vg.ports || {};
                        const missing = videoGenMissing(vg);
                        const opt = { background: '#1c1c1e', color: '#fff' } as React.CSSProperties;
                        return (
                          <div style={{ marginTop: 6, paddingTop: 6, borderTop: '0.5px solid rgba(191,90,242,0.18)' }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.65)', margin: '2px 0 4px' }}>
                              Video Generator ports
                            </div>
                            {/* Fixed FPS 开着 = 帧率是整台生成器写死的（`fixed_fps_value`），
                                fps 槽那一口因此**整行不出现**（也不必绑）。 */}
                            {VIDEO_GEN_SLOTS.filter(s => !(s.key === 'fps' && vg.fixed_fps)).map(slot => {
                              const list = ((slot.side === 'start' ? iface.start_ports : iface.end_ports) ?? [])
                                .filter(p => slot.types.includes(p.type));
                              const cur = ports[slot.key] ?? 0;
                              const bad = slot.required && cur <= 0;
                              return (
                                <div key={slot.key} style={{ ...toggleRow, marginBottom: 0 }}>
                                  <span style={{
                                    ...toggleLabel, minWidth: 74,
                                    color: bad ? '#ff9f0a' : (cur > 0 ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.38)'),
                                  }} title={slot.tip}>{slot.label}{slot.required ? ' *' : ''}</span>
                                  <select style={{ ...styles.paramSelect, flex: 1 }} value={cur}
                                    onChange={e => setVideoGenPort(iface.name, slot.key, parseInt(e.target.value, 10) || 0)}
                                    title={slot.tip}>
                                    <option value={0} style={opt}>{list.length ? '— none —' : `no ${slot.types.join('/')} port`}</option>
                                    {list.map(p => (
                                      <option key={p.num} value={p.num} style={opt}>
                                        {portDisplay(iface.name, slot.side, p)}（value{p.num}）
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              );
                            })}
                            {/* video 槽绑在图片口上的时候把话说清楚：产物是一批帧，跑完
                                由后端按 fps 那一口现编成一段（落到输出轨的位置是一样的）。 */}
                            {(() => {
                              const p = (iface.end_ports ?? []).find(x => x.num === (ports.video ?? 0));
                              if (!p || p.type !== 'IMAGE') return null;
                              return (
                                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
                                  Image output — the frames come back as images and the run stitches them into a clip
                                  at {vg.fixed_fps ? `the fixed ${Number(vg.fixed_fps_value) > 0 ? vg.fixed_fps_value : 16}fps`
                                    : 'the FPS port'}. The clip still lands with the segment&apos;s own length.
                                </div>
                              );
                            })()}
                            <div style={{ ...toggleRow, marginBottom: 0, marginTop: 4 }}>
                              <span style={toggleLabel} title="Fixed FPS：开着 = 这台生成器有一个写死的输出帧率（右边那个数，比如 16），fps 槽那一口不再绑、值也不往图里喂；关着 = fps 绑一个端口，段把用户填的值原样喂进去。两种情况下段长都只按段自己的长度走 —— 生成的片与工程帧率对不上是正常的。">Fixed FPS</span>
                              <IOSToggle checked={!!vg.fixed_fps}
                                onChange={v => setVideoGenFixedFps(iface.name, v)} />
                              {/* 开了就给一个填帧率的框：这是**整台生成器**的输出帧率
                                  （不是工程帧率），段长照旧按段自己那一截取。 */}
                              {!!vg.fixed_fps && (
                                <>
                                  <span style={{ ...toggleLabel, marginLeft: 10, color: 'rgba(255,255,255,0.5)' }}
                                    title="这台生成器出片的帧率（1..120）。工程帧率与之不同很正常 —— 段长不受它影响。">fps</span>
                                  <input type="number" min={1} max={120} step={1}
                                    value={String(Number(vg.fixed_fps_value) > 0 ? vg.fixed_fps_value : 16)}
                                    onChange={e => setVideoGenFixedFpsValue(iface.name, e.target.value)}
                                    style={{ ...styles.paramInput, flex: '0 0 68px', textAlign: 'right' }}
                                    title="这台生成器出片的帧率（1..120）。工程帧率与之不同很正常 —— 段长不受它影响。" />
                                </>
                              )}
                            </div>
                            {missing.length > 0 && (
                              <div style={{ fontSize: 11, color: '#ff9f0a', marginTop: 4 }}>
                                Bind {missing.join(', ')} — a video generator segment cannot run without them.
                              </div>
                            )}
                            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
                              Segments are added from the Video Generator window (its own dock window,
                              next to Processor) — it drops one at the playhead.
                            </div>
                          </div>
                        );
                      })()}
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
                        // 老的 `staging` 落位按 `asset` 读：图池里的东西已经统一由仓库承载。
                        const mediaOut = (iface.end_ports ?? []).filter(p => p.type === 'IMAGE' || p.type === 'MASK');
                        const mediaIn = (iface.start_ports ?? []).filter(p => p.type === 'IMAGE' || p.type === 'MASK');
                        if (!mediaOut.length && !mediaIn.length) return null;
                        const targets = meta.output_targets || {};
                        const sources = meta.input_sources || {};
                        const dstTables: Record<string, [ProcessorDst, string][]> = {
                          IMAGE: [['new_layer', 'New Layer'], ['asset', 'Assets']],
                          MASK: [['selected_mask', 'Sel. Mask'], ['selected_layer', 'Sel. Layer'], ['asset', 'Assets']],
                        };
                        const srcTables: Record<string, [ProcessorSrc, string][]> = {
                          IMAGE: [['layers', 'Layers'], ['selected', 'Sel. Layer'], ['asset', 'Assets']],
                          MASK: [['main_mask', 'Main Mask'], ['selected_mask', 'Sel. Mask'], ['selected_alpha', 'Sel. Alpha'], ['mask_alpha', 'Mask&Alpha']],
                        };
                        const legacyPick = (v: string | undefined): string | undefined => (v === 'staging' ? 'asset' : v);
                        const opt = { background: '#1c1c1e', color: '#fff' } as React.CSSProperties;
                        const portRow = (p: InterfacePort, side: 'end' | 'start', table: [string, string][], cur: string | undefined, onPick: (num: number, v: string) => void, title: string) => (
                          <div key={`${side}-${p.num}`} style={{ ...toggleRow, marginBottom: 0 }}>
                            <span style={{ ...toggleLabel, minWidth: 74 }}>{portDisplay(iface.name, side, p)}</span>
                            <select style={{ ...styles.paramSelect, flex: 1 }} value={legacyPick(cur) || table[0][0]}
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
  // Tracks / Assets 在没有文档可依附时的空态（那份工程随 .cud 走了，这两扇窗就该空着）。
  vidVoid: { flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, color: 'rgba(255,255,255,0.35)', fontSize: 12, textAlign: 'center' },
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
  contextPreviewWrap: { position: 'relative', flex: 1, minHeight: 160, width: '100%', borderRadius: 8, overflow: 'hidden', background: '#1a1a1a' },
  blendPreviewImg: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
  blendPreviewEmpty: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, textAlign: 'center', color: 'rgba(255,255,255,0.3)', fontSize: 11 } as React.CSSProperties,
  blendPreviewBadge: { position: 'absolute', right: 6, bottom: 6, padding: '2px 6px', borderRadius: 6, background: 'rgba(0,0,0,0.55)', color: 'rgba(255,255,255,0.78)', fontSize: 10, fontVariantNumeric: 'tabular-nums' },
  paramRow: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  paramLabel: { fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.6)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  paramSelect: { flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.06)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: '0.5px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '6px 12px', color: '#fff', fontSize: 13, outline: 'none', colorScheme: 'dark', WebkitAppearance: 'none', appearance: 'none', backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\' viewBox=\'0 0 10 6\' fill=\'none\'%3E%3Cpath d=\'M1 1L5 5L9 1\' stroke=\'rgba(255,255,255,0.4)\' stroke-width=\'1.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 28, transition: 'background 0.15s ease, border-color 0.15s ease' } as React.CSSProperties,
  paramInput: { flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.08)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '5px 10px', color: '#fff', fontSize: 13, outline: 'none', fontVariantNumeric: 'tabular-nums', textAlign: 'right' },
  // 块卡里那句"这块做什么"的说明：Recover 类没有旋钮，只能靠它说清自己吃哪一步；
  // 几何块也用它补一句语义（cover vs contain、要不要 mask）。
  blockNote: { fontSize: 11, lineHeight: 1.45, color: 'rgba(255,255,255,0.42)', paddingTop: 2 },

  // ── Settings 页的 iOS inset-grouped 词汇（系统色，不再手调白叠加）：黑底、卡片 #1c1c1e、
  // 分节标题 #8e8e93 大写、分隔线 rgba(84,84,88,.65) 内缩到文本起点、强调 #0a84ff、告警 #ff9f0a。
  // 内容是一根居中的定宽列（iPad Settings 的摆法），面板再宽行也不跟着拉长。
  iosScreen: { display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 620, margin: '0 auto', padding: '0 16px 28px' },
  iosPageTitle: { fontSize: 26, fontWeight: 700, letterSpacing: '-0.4px', color: '#fff', margin: '16px 0 14px' },
  iosSeg: { display: 'flex', padding: 2, borderRadius: 9, background: 'rgba(118,118,128,0.24)', flexShrink: 0 },
  iosGroupTitle: { margin: '18px 0 7px', display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13, fontWeight: 400, letterSpacing: '0.6px', textTransform: 'uppercase', color: '#8e8e93' },
  iosGroupHint: { fontStyle: 'normal', textTransform: 'none', letterSpacing: 0, fontWeight: 400, fontSize: 12, color: 'rgba(142,142,147,0.75)' },
  // 卡片下方的一句说明（组语义的一目了然版）：iOS 的 section footer，自带组间距。
  iosFooter: { margin: '7px 0 16px', fontSize: 12.5, lineHeight: '17px', color: '#8e8e93' },
  iosCard: { background: '#1c1c1e', borderRadius: 11, overflow: 'hidden' },
  iosCardBad: { boxShadow: 'inset 0 0 0 1px rgba(255,159,10,0.7)' },
  iosRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', minHeight: 44, minWidth: 0 },
  // 内缩分隔线：独立的一根，画在行与行之间，起点对齐文本 —— 不再压在整行边框上。
  iosSep: { height: 0.5, background: 'rgba(84,84,88,0.65)', marginLeft: 16 },
  iosLabel: { flex: 1, minWidth: 0, fontSize: 14, color: 'rgba(255,255,255,0.92)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  // 值贴右、无边框；颜色归 .ios-val（静默次级灰、聚焦变白现蓝下划线，见 <style> 块）
  iosNum: { flexShrink: 0, width: 96, textAlign: 'right', background: 'transparent', border: 'none', borderBottom: '0.5px solid transparent', outline: 'none', fontSize: 14, fontVariantNumeric: 'tabular-nums' },
  // 正则框是"这一条是谁"，所以它不能像纯数字那样只留一行空白：空着也要有框的形状
  // （淡底 + hairline + 占位符），否则新加的规则卡看上去就是一整行空的。
  iosPattern: { flex: 1, minWidth: 60, padding: '5px 9px', borderRadius: 7, background: 'rgba(255,255,255,0.055)', border: '0.5px solid rgba(84,84,88,0.55)', outline: 'none', color: 'rgba(255,255,255,0.92)', fontSize: 13, fontFamily: 'ui-monospace, Consolas, monospace' },
  iosBadge: { flexShrink: 0, padding: '2px 7px', borderRadius: 9, background: 'rgba(255,255,255,0.08)', color: '#8e8e93', fontSize: 11, fontVariantNumeric: 'tabular-nums' },
  iosBadgeWarn: { background: 'rgba(255,159,10,0.15)', color: '#ff9f0a' },
  iosHandle: { flexShrink: 0, display: 'flex', color: 'rgba(142,142,147,0.55)', cursor: 'grab' },
  iosChev: { flexShrink: 0, display: 'flex', color: 'rgba(142,142,147,0.45)', transition: 'transform 0.12s ease' },
  iosAddRow: { display: 'block', width: '100%', textAlign: 'left', padding: '12px 16px', background: 'transparent', border: 'none', outline: 'none', color: '#0a84ff', fontSize: 14, cursor: 'pointer' },
  iosEmpty: { padding: '18px 16px', fontSize: 13.5, lineHeight: '18px', color: '#8e8e93' },

  // The dock's own frame (its boxes, bars, handles and windows) is styled in src/dock/DockView.tsx —
  // this is what a unit's BODY uses: interior cards and rows, same skin as the Settings page.
  dockCard: { background: 'rgba(28,28,30,0.72)', border: '0.5px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: '2px 10px', display: 'flex', flexDirection: 'column', gap: 8 },
  // Context 的卡片:同款但**没有边框** —— 预览图自己就是这一格的画面,一条线围着它是多余的。
  contextCard: { background: 'rgba(28,28,30,0.72)', borderRadius: 10, padding: '2px 10px', display: 'flex', flexDirection: 'column', gap: 8, height: '100%' },
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
