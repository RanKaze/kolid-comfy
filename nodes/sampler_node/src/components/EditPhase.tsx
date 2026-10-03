import React, { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { PipelineBlock, DetailerBlockParams, PromptBlockParams, QueryBlockParams, PromptPreset, Tab, StagingItem, InterfaceInfo, InterfacePort, InterfaceMeta, PipelinePackageInfo, BlockSet, PendingQuery, ActionLogEntry, PipelineSettings, PipelineOverrideKey, ProcessorDst, ProcessorSrc } from '../types';
import { PIPELINE_DEFAULT, PIPELINE_CURRENT_SELECT, PIPELINE_OVERRIDE_KEYS, firstDetailerFlag } from '../types';
import DebugModal, { DbgIcon } from './DebugModal';
import LogModal from './LogModal';

// The rename field of a preset row.
const tabInputStyle: React.CSSProperties = {
  background: 'rgba(10,132,255,0.15)', border: '0.5px solid rgba(10,132,255,0.6)', borderRadius: 999,
  color: '#fff', fontSize: 11.5, fontWeight: 600, padding: '4px 10px', outline: 'none', width: 120,
};

// The panels of the Draw tab collapse independently. Default is "all open" — a collapsed panel
// is a choice the user made, so it is remembered; a browser that refuses localStorage just gets the
// default every time, which is not worth an error banner over.
type SectionKey = 'pipeline' | 'global' | 'presets' | 'preprocess' | 'blocks';
const SECTION_KEYS: SectionKey[] = ['pipeline', 'global', 'presets', 'preprocess', 'blocks'];
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

// The Draw tab's left column: a width the user sets by dragging its right edge. The default is
// deliberately roomier than the old fixed 260 — a Pipeline Settings row carries a long label AND a
// number field AND a toggle on one line, and 260 clipped them. Same storage policy as the
// collapsed sections: a browser that refuses localStorage just gets the default every time.
const PANEL_W_STORE = 'sampler.drawPanelWidth';
const PANEL_W_DEFAULT = 300, PANEL_W_MIN = 240, PANEL_W_MAX = 560, PANEL_W_STEP = 20;
const clampPanelWidth = (w: number) => Math.min(PANEL_W_MAX, Math.max(PANEL_W_MIN, w));
function loadPanelWidth(): number {
  try {
    const saved = parseFloat(localStorage.getItem(PANEL_W_STORE) || '');
    if (isFinite(saved)) return clampPanelWidth(saved);
  } catch { /* unreadable store => default */ }
  return PANEL_W_DEFAULT;
}

// A section header that IS its own toggle. The chevron is the only thing that moves, so collapsing
// never reflows the label. A per-section action (Add +) is NOT its child — the header only takes the
// left half of the row, so the action sits beside it in a flex row both sections build the same way.
const SectionHeader: React.FC<{
  label: string; open: boolean; onToggle: () => void;
}> = ({ label, open, onToggle }) => (
  <div onClick={onToggle} title={open ? 'Collapse this section' : 'Expand this section'}
    style={{
      ...styles.sectionTitle, display: 'flex', alignItems: 'center', gap: 5,
      cursor: 'pointer', userSelect: 'none',
    }}>
    <span style={{
      display: 'flex', flexShrink: 0, transform: open ? 'rotate(90deg)' : 'none',
      transition: 'transform 0.12s ease',
    }}>
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
        strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7" /></svg>
    </span>
    {label}
  </div>
);

// Right-click actions for one preset row. The full-screen backdrop is what dismisses it (click or a
// second right-click anywhere), which beats wiring window listeners inside an iframe.
const ContextMenu: React.FC<{
  x: number; y: number; items: { label: string; color?: string; onClick: () => void }[];
  onClose: () => void;
}> = ({ x, y, items, onClose }) => (
  <div style={{ position: 'fixed', inset: 0, zIndex: 80 }}
    onClick={onClose}
    onContextMenu={e => { e.preventDefault(); onClose(); }}>
    <div style={{
      position: 'absolute', top: y, left: Math.min(x, window.innerWidth - 150),
      minWidth: 132, display: 'flex', flexDirection: 'column', gap: 2, padding: 4,
      background: 'rgba(40,40,44,0.96)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: 9,
      boxShadow: '0 8px 28px rgba(0,0,0,0.55)',
    }} onClick={e => e.stopPropagation()}>
      {items.map(it => (
        <button key={it.label} onClick={() => { it.onClick(); onClose(); }}
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
const ADD_BLOCK_KINDS: { kind: 'detailer' | 'interface' | 'prompt' | 'query'; label: string; color: string; hint: string }[] = [
  { kind: 'detailer', label: 'Detailer', color: '#30d158', hint: 'Refine the masked region' },
  { kind: 'interface', label: 'Interface', color: '#bf5af2', hint: 'Run an interface sub-graph inside the chain' },
  { kind: 'prompt', label: 'Prompt', color: '#64d2ff', hint: 'Inject a shared prompt preset for the blocks after it' },
  { kind: 'query', label: 'Query', color: '#ffd60a', hint: 'Stop the run here and ask you for a prompt' },
];

// What a Query block does — hover the card's type label for it. It used to be a paragraph inside the
// card, which pushed the real parameters down for information you read once.
const QUERY_BLOCK_HINT = '执行到这一块会暂停并弹出 prompt 选择；Confirm 后按 prompt 块的规则合并（全局在前、本次选择在后），只影响其后的 detailer。关掉弹窗 = 中止整条链。';

// The Pipeline Settings overrides mirror the GLOBAL SETTINGS rows one-for-one, so their
// ranges are copied from those inputs rather than invented. The toggle decides whether the value
// replaces the global one at run time; a row that was never enabled shows (and keeps) the current
// global value, which is what it will run with the moment the toggle flips on.
// ref_* / tgen_* are input-side ceilings (0 = off), hence min: 0 on the pixel rows.
const PIPELINE_OVERRIDE_META: Record<PipelineOverrideKey, { label: string; min: number; max: number; step: number }> = {
  mask_grow: { label: 'Override Mask Grow', min: 0, max: 256, step: 1 },
  mask_blur: { label: 'Override Mask Blur', min: 0, max: 256, step: 1 },
  crop_reserve: { label: 'Override Crop Reserve', min: 0, max: 256, step: 1 },
  pixels: { label: 'Override Pixels', min: 65536, max: 16777216, step: 65536 },
  align: { label: 'Override Align', min: 1, max: 64, step: 1 },
  ref_pixels: { label: 'Override Ref Pixels', min: 0, max: 16777216, step: 65536 },
  ref_align: { label: 'Override Ref Align', min: 1, max: 64, step: 1 },
  tgen_pixels: { label: 'Override TGen Pixels', min: 0, max: 16777216, step: 65536 },
  tgen_align: { label: 'Override TGen Align', min: 1, max: 64, step: 1 },
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
// A menu, not a modal: clicking anywhere else dismisses it.
const addMenuBackdropStyle: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 40 };
const addMenuPanelStyle: React.CSSProperties = {
  position: 'absolute', top: '100%', right: 0, zIndex: 41, marginTop: 4,
  background: '#1c1c1e', border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: 10,
  padding: 4, minWidth: 152, boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
};
const addMenuItemStyle: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px',
  background: 'none', border: 'none', borderRadius: 7, cursor: 'pointer',
  fontSize: 12, fontWeight: 600,
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
    case 'draw': return (
      <svg {...props}>
        <path d="M12 20h9" strokeWidth={1.5} />
        <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
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
  onGlobalParamChange: (key: 'mask_grow' | 'mask_blur' | 'crop_reserve' | 'pixels' | 'align'
    | 'ref_pixels' | 'ref_align' | 'tgen_pixels' | 'tgen_align', value: number) => void;
  onAddBlock: (type: 'detailer' | 'interface' | 'prompt' | 'query') => void;
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
  /** Draw 页 Pipeline Settings 的全部状态：选中项 + 按 pipeline 名字绑定的九个 override */
  pipelineSettings: PipelineSettings;
  /** 此刻真正加载在节点上的 pipeline 名字（'' = 节点输入口那条，从未切换过） */
  loadedPipelineName: string;
  /** 选中一条 pipeline 就立刻切换（加载上游是昂贵操作，但切换必须是即时的） */
  onSwitchPipeline: (packageIdx: number, pipelineIdx: number) => void;
  onPipelineSettingsChange: (next: PipelineSettings) => void;
  /** preset 行 ⚙：这套链跑起来时用哪条 pipeline（'' = 不切换，即 [Current Select] 语义） */
  onSetPresetPipeline: (setId: string, pipelineName: string) => void;
  /** 最近 32 条行为记录（工作台每次 setStatus + 宿主自身动作）。画布上那颗常显状态药丸撤掉后，
   *  反馈就攒在这里，由 Context 标题行的 Log 按钮按需展开。 */
  actionLog: ActionLogEntry[];
}

const EditPhase: React.FC<EditPhaseProps> = ({
  tab, onTabChange, promptUrl,
  promptReady, detailStatus,
  staging, promptIframeRef,
  blocks, architecture, maskGrow, maskBlur, cropReserve, pixelsVal, alignVal,
  refPixelsVal, refAlignVal, tgenPixelsVal, tgenAlignVal,
  onBlocksChange, onGlobalParamChange, onAddBlock, onRemoveBlock, onReorderBlocks,
  blockSets, activeBlockSetId, onAddBlockSet, onRenameBlockSet, onDuplicateBlockSet, onRemoveBlockSet, onReorderBlockSets, onSwitchBlockSet,
  pendingQuery, onRunPreset, onQueryAnswer, onQueryCancel,
  onFinishClick, showFinishDialog, onFinish, onCloseFinishDialog,
  blendIframeRef,
  interfaces, interfaceMeta, onChangeInterfaceMeta,
  pipelinePackages, pipelineSettings, loadedPipelineName, onSwitchPipeline, onPipelineSettingsChange, onSetPresetPipeline,
  actionLog,
}) => {
  const [hoveredFinish, setHoveredFinish] = useState<StagingItem | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // Debug 弹窗：上一次 Run / Generate 的全过程快照（Context 标题右侧的 🐞 按钮打开）。
  const [showDebug, setShowDebug] = useState(false);
  // Log 弹窗：最近 32 条行为记录 —— 画布那颗常显状态药丸撤掉后的去处。
  const [showLog, setShowLog] = useState(false);
  // Live thumbnail of the workbench composite — that composite *is* the Context Image.
  const [blendPreview, setBlendPreview] = useState<{ image: string; size: string } | null>(null);
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
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // The Pipeline Presets "Add +" dropdown — same control, same behaviour as the Blocks one.
  const [presetAddOpen, setPresetAddOpen] = useState(false);
  // 四块面板的折叠状态（默认全展开，改动落 localStorage）。
  const [openSections, setOpenSections] = useState<Record<SectionKey, boolean>>(loadSections);
  const toggleSection = (k: SectionKey) => setOpenSections(prev => {
    const next = { ...prev, [k]: !prev[k] };
    try { localStorage.setItem(SECTIONS_STORE, JSON.stringify(next)); } catch { /* in-memory only */ }
    return next;
  });
  // 左栏宽度：拖右边缘的把手来调，把手只有 8px，所以指针一旦移出宿主文档就会被右边的
  // 工作台 iframe 吞掉 —— setPointerCapture 把整段拖动钉在把手上，才能越过 iframe 继续。
  const [panelWidth, setPanelWidth] = useState<number>(loadPanelWidth);
  const [panelResizing, setPanelResizing] = useState(false);
  const panelDragRef = useRef<{ x: number; w: number } | null>(null);
  const panelWidthRef = useRef(panelWidth);
  const applyPanelWidth = (w: number, persist: boolean) => {
    const next = clampPanelWidth(w);
    panelWidthRef.current = next;
    setPanelWidth(next);
    if (persist) { try { localStorage.setItem(PANEL_W_STORE, String(next)); } catch { /* in-memory only */ } }
  };
  const onPanelResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    panelDragRef.current = { x: e.clientX, w: panelWidthRef.current };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* fall back to bubbling events */ }
    setPanelResizing(true);
  };
  const onPanelResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = panelDragRef.current;
    if (d) applyPanelWidth(d.w + (e.clientX - d.x), false);
  };
  const onPanelResizeUp = () => {
    if (!panelDragRef.current) return;
    panelDragRef.current = null;
    setPanelResizing(false);
    applyPanelWidth(panelWidthRef.current, true);
  };
  const onPanelResizeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') applyPanelWidth(panelWidthRef.current - PANEL_W_STEP, true);
    else if (e.key === 'ArrowRight') applyPanelWidth(panelWidthRef.current + PANEL_W_STEP, true);
    else if (e.key === 'Home' || e.key === 'Enter') applyPanelWidth(PANEL_W_DEFAULT, true);
    else return;
    e.preventDefault();
  };
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
  // 这颗选项只在还没选过任何东西时出现，而它一旦不在，九排 override 也就没有名字可绑，整排禁用。
  const isDefaultPipeline = !selectedPipeline || selectedPipeline === PIPELINE_DEFAULT;
  const pipelineIsMissing = (name: string): boolean =>
    !!name && name !== PIPELINE_CURRENT_SELECT
    && pipelinePackages.length > 0 && !pipelineNames.includes(name);
  // 选中的名字解不出来（包断了/改名）。packages 还没到齐时不下结论，避免闪一下橙标。
  const selectedUnresolved = !isDefaultPipeline && selectedPipeline !== PIPELINE_CURRENT_SELECT
    && !pipelineNames.includes(selectedPipeline);

  const globalOf = (key: PipelineOverrideKey): number =>
    ({ mask_grow: maskGrow, mask_blur: maskBlur, crop_reserve: cropReserve, pixels: pixelsVal, align: alignVal,
       ref_pixels: refPixelsVal, ref_align: refAlignVal, tgen_pixels: tgenPixelsVal, tgen_align: tgenAlignVal }[key]);

  /** 写一份 override（值或开关）。整份 Pipeline Settings 由前端独家作者，后端只做归一化。 */
  const setOverride = (key: PipelineOverrideKey, patch: { value?: number; enabled?: boolean }) => {
    if (isDefaultPipeline) return;
    const name = selectedPipeline;
    const cur = pipelineSettings.overrides[name]?.[key];
    onPipelineSettingsChange({
      ...pipelineSettings,
      overrides: {
        ...pipelineSettings.overrides,
        [name]: {
          ...(pipelineSettings.overrides[name] || {}),
          [key]: {
            value: patch.value ?? cur?.value ?? globalOf(key),
            enabled: patch.enabled ?? cur?.enabled ?? false,
          },
        },
      },
    });
  };

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
  ];

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
      {/* Two things an inline style prop cannot express: the panel's dark scrollbar (a
          ::-webkit-scrollbar rule) and the resize handle's hover/focus tint. Both are scoped by
          class here, matching the workbench's own overlay scrollbar — faint pill, transparent
          track, no arrow buttons. */}
      <style>{`
        .dark-scroll { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.22) transparent; }
        .dark-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
        .dark-scroll::-webkit-scrollbar-track { background: transparent; }
        .dark-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.22); border: 3px solid transparent; border-radius: 8px; background-clip: padding-box; }
        .dark-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.36); background-clip: padding-box; }
        .dark-scroll::-webkit-scrollbar-corner { background: transparent; }
        .dark-scroll::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
        .draw-resizer > i { width: 3px; height: 38px; border-radius: 2px; background: rgba(255,255,255,0.14); transition: background 0.12s ease; }
        .draw-resizer:hover > i, .draw-resizer:focus-visible > i, .draw-resizer.dragging > i { background: rgba(10,132,255,0.8); }
        .draw-resizer:focus-visible { outline: none; }
      `}</style>
      {/* Sidebar — vertical icon tabs */}
      <div style={styles.sidebar}>
        <div style={styles.sidebarTabs}>
          {tabs.map(t => (
            <button
              key={t.id}
              title={t.id}
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
        <div style={{ ...styles.drawLayout, display: tab === 'draw' ? 'flex' : 'none' }}>
          {/* Left: settings */}
            <div className="dark-scroll" style={{ ...styles.drawSettingsPanel, width: panelWidth }}>
              {/* Live preview of the workbench composite. The composite IS the Context Image,
                  so this is what Run Detailer feeds on (tinted where the Mask layer is painted). */}
                <div style={styles.contextPreviewBox}>
                  <div style={styles.contextTitleRow}>
                    <div style={styles.sectionTitle}>Context</div>
                    <div style={styles.contextTitleActions}>
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
                    </div>
                  </div>
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
              {/* PIPELINE SETTINGS — 原先左侧的 Pipeline tab 收进这里。
                  一颗 enum 选 pipeline（选中即切换 —— 昂贵的是加载，不是选择），加九
                  跟随 pipeline 名字持久化的 override。 */}
              <SectionHeader label="Pipeline Settings" open={openSections.pipeline} onToggle={() => toggleSection('pipeline')} />
              {openSections.pipeline && (<div style={styles.nestedSection}>
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
                {/* 先 field 再 toggle：toggle 关 = 这项不 override，前面的数值格随之锁死。
                    [Default] 没有名字可绑 → 整排禁用（后端也就永远不会去读这份 override）。 */}
                <div style={isDefaultPipeline ? { ...styles.nestedSection, opacity: 0.4, pointerEvents: 'none' } : styles.nestedSection}>
                  {PIPELINE_OVERRIDE_KEYS.map(key => {
                    const meta = PIPELINE_OVERRIDE_META[key];
                    const entry = pipelineSettings.overrides[selectedPipeline]?.[key];
                    const on = !!entry?.enabled;
                    return (
                      <div key={key} style={{ ...styles.paramRow, gap: 6 }}
                        title={`${meta.label} — off = this pipeline runs with the global ${meta.label.replace('Override ', '')} (${globalOf(key)}). `
                          + 'On = the value on the left replaces it, and it is saved under this pipeline\'s name.'}>
                        <label style={styles.overrideLabel}>{meta.label}</label>
                        <input
                          style={{ ...styles.paramInput, opacity: on ? 1 : 0.4 }}
                          type="number" min={meta.min} max={meta.max} step={meta.step}
                          disabled={!on}
                          value={entry?.value ?? globalOf(key)}
                          onChange={e => setOverride(key, { value: parseInt(e.target.value) || 0 })}
                        />
                        <IOSToggle checked={on} disabled={isDefaultPipeline}
                          onChange={v => setOverride(key, { enabled: v })} />
                      </div>
                    );
                  })}
                </div>
              </div>)}
              {/* GLOBAL SETTINGS — 所有 Pipeline Preset 共享的数值参数（server config 持久化）。
                  与 preset 相关的开关在下方 Preprocess Settings。 */}
              <SectionHeader label="Global Settings" open={openSections.global} onToggle={() => toggleSection('global')} />
              {openSections.global && (<div style={styles.nestedSection}>
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>Mask Grow</label>
                <input style={styles.paramInput} type="number" min={0} max={256} step={1} value={maskGrow} onChange={e => onGlobalParamChange('mask_grow', parseInt(e.target.value))} />
              </div>
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>Mask Blur</label>
                <input style={styles.paramInput} type="number" min={0} max={256} step={1} value={maskBlur} onChange={e => onGlobalParamChange('mask_blur', parseInt(e.target.value))} />
              </div>
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>Crop Reserve</label>
                <input style={styles.paramInput} type="number" min={0} max={256} step={1} value={cropReserve} onChange={e => onGlobalParamChange('crop_reserve', parseInt(e.target.value))} />
              </div>
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>Pixels</label>
                <input style={styles.paramInput} type="number" min={65536} max={16777216} step={65536} value={pixelsVal} onChange={e => onGlobalParamChange('pixels', parseInt(e.target.value))} />
              </div>
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>Align</label>
                <input style={styles.paramInput} type="number" min={1} max={64} step={1} value={alignVal} onChange={e => onGlobalParamChange('align', parseInt(e.target.value))} />
              </div>
              {/* 下面四排是**输入侧显存封顶**，与上面 Pixels 的"目标分辨率"语义相反：
                  只压不涨（limit_pixels 的 cap_only 模式），0 = 不设上限。 */}
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>Ref Pixels</label>
                <input style={styles.paramInput} type="number" min={0} max={16777216} step={65536} value={refPixelsVal}
                  title="Ceiling for a Ref Image before it is VAE-encoded — images already inside the budget are left alone, nothing is ever enlarged. 0 = no ceiling."
                  onChange={e => onGlobalParamChange('ref_pixels', parseInt(e.target.value) || 0)} />
              </div>
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>Ref Align</label>
                <input style={styles.paramInput} type="number" min={1} max={64} step={1} value={refAlignVal}
                  title="Grid a capped Ref Image is snapped DOWN to (never up)."
                  onChange={e => onGlobalParamChange('ref_align', parseInt(e.target.value) || 1)} />
              </div>
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>TGen Pixels</label>
                <input style={styles.paramInput} type="number" min={0} max={16777216} step={65536} value={tgenPixelsVal}
                  title="Ceiling for every image handed to Generate Text (working image + Ref Images) before it enters the vision tower. Shrink-only. 0 = no ceiling."
                  onChange={e => onGlobalParamChange('tgen_pixels', parseInt(e.target.value) || 0)} />
              </div>
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>TGen Align</label>
                <input style={styles.paramInput} type="number" min={1} max={64} step={1} value={tgenAlignVal}
                  title="Grid a capped Generate Text image is snapped DOWN to (never up)."
                  onChange={e => onGlobalParamChange('tgen_align', parseInt(e.target.value) || 1)} />
              </div>
              </div>)}
              {/* Pipeline Blocks tab bar — 多套 blocks 以 tabs 切换（可重命名/复制/删除，持久化在后端
                  config）；只有激活 tab 的 chain 会运行、会被发给 Blend 工作台。块列表本体在
                  Preprocess Settings 下方，随激活 tab 联动。每个 tab 就是一个 Pipeline Preset，
                  也是 Blend 工作台 Generate 弹窗里那个 enum 的选项。 */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative' }}>
                <SectionHeader label="Pipeline Presets" open={openSections.presets} onToggle={() => toggleSection('presets')} />
                {openSections.presets && (<button
                  title="Add a pipeline preset"
                  onClick={() => setPresetAddOpen(v => !v)}
                  style={addPillStyle(presetAddOpen)}>Add +</button>)}
                {presetAddOpen && (
                  <>
                    <div style={addMenuBackdropStyle} onClick={() => setPresetAddOpen(false)} />
                    <div style={addMenuPanelStyle}>
                      <button title="An empty preset — add blocks to it below"
                        onClick={() => { onAddBlockSet(); setPresetAddOpen(false); }}
                        style={{ ...addMenuItemStyle, color: '#0a84ff' }}>New Preset</button>
                    </div>
                  </>
                )}
              </div>
              {openSections.presets && (<div style={styles.nestedSection}>
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
              </div>)}

              {/* Preprocess Settings — 每个 Pipeline Preset 独立的开关（存在第一个 detailer
                  block 的 params 上）。数值参数（Grow/Blur/Crop Reserve/Pixels/Align）已上移
                  到上方 GLOBAL SETTINGS，不按 preset 区分。 */}
              <SectionHeader label="Preprocess Settings" open={openSections.preprocess} onToggle={() => toggleSection('preprocess')} />
              {openSections.preprocess && (<div style={styles.nestedSection}>
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
              <div style={styles.paramRow}
                title="开 = 按 Pixels / Align 限制工作分辨率。关 = 既不缩放也不对齐，工作分辨率就是裁剪（或整幅）分辨率；Qwen 架构仍会强制 32 对齐，否则 latent / vision token 网格不接受。">
                <label style={styles.paramLabel}>Enable Limit</label>
                <IOSToggle
                  checked={enableLimit}
                  disabled={!firstDp}
                  onChange={v => firstDetailer && updateBlockParam(firstDetailer.id, 'enable_limit', v)}
                />
              </div>
              <div style={styles.paramRow}
                title="开 = 这一趟的最终产出另外存一张 PNG 到 ComfyUI 的 outputs 文件夹（detailer_00001_.png 递增命名）——整幅 Run 和图层 Generate 都算「这一趟的最终产出」，落不落盘只看这颗开关，不分流。图里带和 SnapshotPromptNode 的 Cache 完全同形的 prompt 编码（prompt / prompts / lora / prefab / program / custom_prompts / prompt_parsing / filter_* / region），所以这张图能被 Prompt 节点的 Load From Image 原样读回；其中 prompt 一项是最后一个 detailer 真正送进 CLIP 的那一串（标记词打头、Generate Text 之后），其余各项编的是这次真正生效的合并选择（链里没有 Prompt/Query 块时就是 Prompt 节点的全局选择）。关 = 结果只留在画布里，不落盘。">
                <label style={styles.paramLabel}>Enable Output</label>
                <IOSToggle
                  checked={firstDp ? (firstDp.enable_output ?? false) : false}
                  disabled={!firstDp}
                  onChange={v => firstDetailer && updateBlockParam(firstDetailer.id, 'enable_output', v)}
                />
              </div>
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
                title="开 = 建层分辨率自动按 GLOBAL SETTINGS 的 Pixels 预算算（rate = √(Pixels ÷ 框面积)，与分辨率弹窗里的 Limit 勾选同一公式）。关 = rate 1，层按框的原生像素建。仅 Dynamic Layer 开时生效。">
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
              </div>)}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative' }}>
                <SectionHeader label="Pipeline Blocks" open={openSections.blocks} onToggle={() => toggleSection('blocks')} />
                {openSections.blocks && (<button
                  title="Append a block to this preset"
                  onClick={() => setAddMenuOpen(v => !v)}
                  style={addPillStyle(addMenuOpen)}>Add +</button>)}
                {addMenuOpen && (
                  <>
                    <div style={addMenuBackdropStyle} onClick={() => setAddMenuOpen(false)} />
                    <div style={addMenuPanelStyle}>
                      {ADD_BLOCK_KINDS.map(opt => (
                        <button key={opt.kind}
                          title={opt.hint}
                          onClick={() => { onAddBlock(opt.kind); setAddMenuOpen(false); }}
                          style={{ ...addMenuItemStyle, color: opt.color }}>{opt.label}</button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {openSections.blocks && (<div style={styles.nestedSection}>
              {blocks.map((block, blockIdx) => (
                <div key={block.id} style={{
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
                      onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(blockIdx)); e.dataTransfer.effectAllowed = 'move'; }}
                      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                      onDrop={(e) => { e.preventDefault(); const from = parseInt(e.dataTransfer.getData('text/plain')); if (!isNaN(from)) onReorderBlocks(from, blockIdx); }}
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
                      flex: 1, textAlign: 'center', fontSize: 12, fontWeight: 600,
                      color: block.type === 'detailer' ? '#30d158' : block.type === 'prompt' ? '#64d2ff' : block.type === 'query' ? '#ffd60a' : '#bf5af2',
                    }}>{block.name}</span>
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
              </div>)}
            </div>

          {/* The column's right edge is the handle. Colours live in the .draw-resizer rules below
              (an inline style cannot express :hover), the geometry stays in `styles`. */}
          <div
            className={`draw-resizer${panelResizing ? ' dragging' : ''}`}
            style={styles.panelResizer}
            role="separator" aria-orientation="vertical" tabIndex={0}
            aria-label="Settings panel width" aria-valuenow={panelWidth}
            aria-valuemin={PANEL_W_MIN} aria-valuemax={PANEL_W_MAX}
            title="Drag to resize this panel — double-click (or Home) restores the default width"
            onPointerDown={onPanelResizeDown}
            onPointerMove={onPanelResizeMove}
            onPointerUp={onPanelResizeUp}
            onPointerCancel={onPanelResizeUp}
            onDoubleClick={() => applyPanelWidth(PANEL_W_DEFAULT, true)}
            onKeyDown={onPanelResizeKey}
          >
            <i />
          </div>

          {/* Right: the workbench. Its canvas composite IS the Context Image, and the
              pure Mask layer is the mask sent to the backend. */}
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

        {/* Interface — package-driven sub-graph execution */}
        {tab === 'interface' && (
          <InterfaceTab interfaces={interfaces} interfaceMeta={interfaceMeta} onChangeInterfaceMeta={onChangeInterfaceMeta} />
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
              {boundNamed && !boundMissing && (
                <div style={{ marginTop: 10, fontSize: 11.5, color: 'rgba(255,255,255,0.4)' }}>
                  This pipeline's overrides (Pipeline Settings) apply whenever it runs.
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
  content: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },

  // iframe wrapper — no border, clean
  iframeWrap: { flex: 1, minHeight: 0, background: '#0d0d0d' },
  iframe: { width: '100%', height: '100%', border: 'none', background: '#0d0d0d' },

  // Scrollable content

  // Tag cards — flex:1 equal width


  // Draw tab layout: left settings + right main area
  drawLayout: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row' },
  blendFrame: { flex: 1, minWidth: 0, alignSelf: 'stretch', height: '100%', border: 'none', background: '#0d0d0d', display: 'block' },
  // The handle itself is 8px of nothing with a 3px pill in the middle; the negative margins pull it
  // over the panel border and the iframe edge so dragging it never costs the layout a pixel of width.
  panelResizer: {
    width: 8, flexShrink: 0, alignSelf: 'stretch', margin: '0 -4px', zIndex: 5,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'col-resize', background: 'transparent', touchAction: 'none' as const,
  },
  drawSettingsPanel: {
    width: PANEL_W_DEFAULT, flexShrink: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
    background: 'rgba(28,28,30,0.4)', borderRight: '0.5px solid rgba(255,255,255,0.06)', overflowY: 'auto',
  },
  sectionTitle: { fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 },
  // 折叠块的正文容器：继承设置面板原来的行距（面板本身 gap 10，行与行也隔 10），
  // 否则把一段包进 div 会让行贴在一起。
  nestedSection: { display: 'flex', flexDirection: 'column', gap: 10 },
  // Context 标题 + 右侧的 Log / Debug 两颗按钮同行；按钮抱成一组贴右，标题留在左边。
  contextTitleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 },
  contextTitleActions: { display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' },
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
  contextPreviewBox: { marginBottom: 12 },
  previewTintRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 },
  previewTintLabel: { fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.6)', minWidth: 58 },
  previewTintRange: { flex: 1, minWidth: 0, accentColor: '#ff3b30' },
  previewTintValue: { fontSize: 11, color: 'rgba(255,255,255,0.5)', minWidth: 26, textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' },
  contextPreviewWrap: { position: 'relative', width: '100%', aspectRatio: '1', borderRadius: 8, overflow: 'hidden', background: '#1a1a1a' },
  blendPreviewImg: { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
  blendPreviewEmpty: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, textAlign: 'center', color: 'rgba(255,255,255,0.3)', fontSize: 11 } as React.CSSProperties,
  blendPreviewBadge: { position: 'absolute', right: 6, bottom: 6, padding: '2px 6px', borderRadius: 6, background: 'rgba(0,0,0,0.55)', color: 'rgba(255,255,255,0.78)', fontSize: 10, fontVariantNumeric: 'tabular-nums' },
  paramRow: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  paramLabel: { fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.6)', minWidth: 80 },
  // A Pipeline Settings override row carries a longer label ("Override Crop Reserve") and has to fit
  // a number field AND a toggle in 228px, so it drops the fixed 80px floor and the 13px size.
  overrideLabel: { fontSize: 11.5, fontWeight: 500, color: 'rgba(255,255,255,0.6)', flexShrink: 0, minWidth: 0 },
  paramSelect: { flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.06)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: '0.5px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '6px 12px', color: '#fff', fontSize: 13, outline: 'none', colorScheme: 'dark', WebkitAppearance: 'none', appearance: 'none', backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\' viewBox=\'0 0 10 6\' fill=\'none\'%3E%3Cpath d=\'M1 1L5 5L9 1\' stroke=\'rgba(255,255,255,0.4)\' stroke-width=\'1.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 28, transition: 'background 0.15s ease, border-color 0.15s ease' } as React.CSSProperties,
  paramInput: { flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.08)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '5px 10px', color: '#fff', fontSize: 13, outline: 'none', fontVariantNumeric: 'tabular-nums' },

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
