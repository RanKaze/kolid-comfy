import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { PipelineBlock, DetailerBlockParams, PromptBlockParams, PromptPreset, Tab, HistoryItem, InterfaceInfo, InterfacePort, PipelinePackageInfo, BlockSet, PendingQuery } from '../types';

// Pipeline Blocks tab-bar atoms (module-level: pure style, no state).
const tabActionBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: 13,
  padding: '3px 6px', lineHeight: 1, color: 'rgba(255,255,255,0.45)', borderRadius: 6,
};
const tabInputStyle: React.CSSProperties = {
  background: 'rgba(10,132,255,0.15)', border: '0.5px solid rgba(10,132,255,0.6)', borderRadius: 999,
  color: '#fff', fontSize: 11.5, fontWeight: 600, padding: '4px 10px', outline: 'none', width: 120,
};

// What the "Add +" dropdown offers. Query is the only kind that interacts with the user
// mid-run: the chain stops there and waits for a prompt choice.
const ADD_BLOCK_KINDS: { kind: 'detailer' | 'interface' | 'prompt' | 'query'; label: string; color: string; hint: string }[] = [
  { kind: 'detailer', label: 'Detailer', color: '#30d158', hint: 'Refine the masked region' },
  { kind: 'interface', label: 'Interface', color: '#bf5af2', hint: 'Run an interface sub-graph inside the chain' },
  { kind: 'prompt', label: 'Prompt', color: '#64d2ff', hint: 'Inject a shared prompt preset for the blocks after it' },
  { kind: 'query', label: 'Query', color: '#ffd60a', hint: 'Stop the run here and ask you for a prompt' },
];

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
    case 'context': return (
      <svg {...props}>
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <circle cx="8.5" cy="9.5" r="1.5" fill="currentColor" stroke="none" />
        <path d="M3 15l5-5 4 4 5-5 4 4" strokeWidth={1.5} />
      </svg>
    );
    case 'interface': return (
      <svg {...props}>
        <rect x="4" y="5" width="16" height="3" rx="1.5" />
        <rect x="4" y="11" width="12" height="3" rx="1.5" />
        <rect x="4" y="17" width="8" height="3" rx="1.5" />
      </svg>
    );
    case 'pipeline': return (
      <svg {...props}>
        <circle cx="6" cy="7" r="2.5" />
        <circle cx="18" cy="7" r="2.5" />
        <circle cx="6" cy="17" r="2.5" />
        <circle cx="18" cy="17" r="2.5" />
        <path d="M8.5 7h7M8.5 17h7M6 9.5v5M18 9.5v5" strokeWidth={1.5} />
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
      background: checked ? '#30d158' : '#39393d',
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

interface EditPhaseProps {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  promptUrl: string;
  promptReady: boolean;
  detailStatus: 'idle' | 'running' | 'done' | 'error';
  history: HistoryItem[];
  onRefreshHistory: () => void;
  promptIframeRef: React.RefObject<HTMLIFrameElement>;
  blocks: PipelineBlock[];
  /** 当前 pipeline 架构（edit 设置按架构渲染，目前仅 Krea2 提供Enable Edit） */
  architecture: string | null;
  maskGrow: number;
  maskBlur: number;
  onBlocksChange: (blocks: PipelineBlock[]) => void;
  onGlobalParamChange: (key: 'mask_grow' | 'mask_blur', value: number) => void;
  onAddBlock: (type: 'detailer' | 'interface' | 'prompt' | 'query') => void;
  /** 一个正等用户回答的 Query 块（run 停在它上面），由 /api/status 下发 */
  pendingQuery: PendingQuery | null;
  /** 立刻以某个 pipeline preset 跑一趟（画布在 Blend 工作台里，由工作台发起） */
  onRunPreset: (presetId: string) => void;
  /** 把用户在弹窗里挑好的 prompt 交给后端，唤醒停在 Query 块上的 run */
  onQueryAnswer: (selection: Record<string, any>) => void;
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
  onSwitchBlockSet: (id: string) => void;
  onSelectImage: (key: string) => void;
  onFinishClick: () => void;
  showFinishDialog: boolean;
  onFinish: (selectedKeys?: string[]) => void;
  onCloseFinishDialog: () => void;
  /** 返回新加入历史的那张图的 key（拖到 Ref Image 上时要立刻选中它） */
  onAddContextImage: (base64: string) => Promise<string | null>;
  onLoadFromAssets: () => void;
  loadingAssets: boolean;
  currentContextKey: string | null;
  onSetContext: (key: string) => void;
  blendIframeRef: React.RefObject<HTMLIFrameElement>;
  showBlendSelect: { role: 'layer' } | null;
  onBlendSelectImages: (items: { key: string; name: string; src: string }[]) => void;
  onCloseBlendSelect: () => void;
  interfaces: InterfaceInfo[];
  onExecuteInterface: (interfaceIndex: number, manualValues: Record<string, any>, execOptions?: Record<string, any>) => void;
  interfaceResults: Record<number, HistoryItem[]>;
  interfaceStatusByIdx: Record<number, 'idle' | 'running' | 'done' | 'error'>;
  interfaceProgressByIdx: Record<number, { progress: number; current: number; total: number }>;
  pipelinePackages: PipelinePackageInfo[];
  onSwitchPipeline: (packageIdx: number, pipelineIdx: number) => void;
  currentPipelineKey: string | null;
}

const EditPhase: React.FC<EditPhaseProps> = ({
  tab, onTabChange, promptUrl,
  promptReady, detailStatus,
  history, onRefreshHistory, promptIframeRef,
  blocks, architecture, maskGrow, maskBlur, onBlocksChange, onGlobalParamChange, onAddBlock, onRemoveBlock, onReorderBlocks,
  blockSets, activeBlockSetId, onAddBlockSet, onRenameBlockSet, onDuplicateBlockSet, onRemoveBlockSet, onSwitchBlockSet,
  pendingQuery, onRunPreset, onQueryAnswer, onQueryCancel,
  onSelectImage,
  onFinishClick, showFinishDialog, onFinish, onCloseFinishDialog,
  onAddContextImage, onLoadFromAssets, loadingAssets,
  currentContextKey, onSetContext,
  blendIframeRef, showBlendSelect, onBlendSelectImages, onCloseBlendSelect,
  interfaces, onExecuteInterface, interfaceResults, interfaceStatusByIdx, interfaceProgressByIdx,
  pipelinePackages, onSwitchPipeline, currentPipelineKey,
}) => {
  const [hoveredHistory, setHoveredHistory] = useState<HistoryItem | null>(null);
  const [hoveredFinish, setHoveredFinish] = useState<HistoryItem | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [showRefSelect, setShowRefSelect] = useState<string | null>(null);
  const [contextDragOver, setContextDragOver] = useState(false);
  // 右键菜单
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: HistoryItem } | null>(null);
  // Resize Modal
  const [resizeModal, setResizeModal] = useState<{ item: HistoryItem } | null>(null);
  // Blend layer picker (the workbench iframe asks the host for images to add as layers)
  const [blendPicked, setBlendPicked] = useState<string[]>([]);
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
  const [renamingPresetValue, setRenamingPresetValue] = useState('');

  useEffect(() => { if (showBlendSelect) setBlendPicked([]); }, [showBlendSelect]);

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
  // backend (not this UI) merges it, so all we do is forward it and close the dialog.
  useEffect(() => {
    const onAnswered = (event: MessageEvent) => {
      if (event.data?.type !== 'prompt-query-answered') return;
      onQueryAnswer(event.data.selection || {});
    };
    window.addEventListener('message', onAnswered);
    return () => window.removeEventListener('message', onAnswered);
  }, [onQueryAnswer]);

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

  // 关闭右键菜单（点击任意处）
  React.useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  // 右键菜单处理
  const handleContextAction = useCallback((action: string, item: HistoryItem) => {
    setContextMenu(null);
    if (action === 'resize') {
      setResizeModal({ item });
    } else if (action === 'select') {
      onSelectImage(item.key);
    }
  }, [onSelectImage]);

  // Resize 提交
  const handleResizeSubmit = useCallback(async (key: string, width: number, height: number) => {
    try {
      const res = await fetch('/api/resize_image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, width, height }),
      });
      const data = await res.json();
      if (data.success) {
        onRefreshHistory();
      }
    } catch (e) {
      // ignore
    }
    setResizeModal(null);
  }, [onRefreshHistory]);

  // `draw` is the Blend workbench: the canvas composite is the Context Image and the pure Mask
  // layer is the mask, so the old mask / blend / tag tabs are gone (the Tag buttons live in the
  // workbench toolbar).
  const tabs: { id: Tab; icon: string; color: string }[] = [
    { id: 'prompt', icon: 'prompt', color: '#0a84ff' },
    { id: 'draw', icon: 'draw', color: '#30d158' },
    { id: 'context', icon: 'context', color: '#64d2ff' },
    ...(interfaces.length > 0 ? [{ id: 'interface' as Tab, icon: 'interface', color: '#bf5af2' }] : []),
    ...(pipelinePackages.length > 0 ? [{ id: 'pipeline' as Tab, icon: 'pipeline', color: '#30d158' }] : []),
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

  // limit_pixels 的 pixels/align 为全局参数，取自第一个 detailer block（与后端 first_bp 一致）。
  const firstDetailer = blocks.find(b => b.type === 'detailer');
  const firstDp = firstDetailer ? (firstDetailer.params as DetailerBlockParams) : undefined;
  // Preprocess Settings 的两个总闸也放在第一个 detailer block 上（与 crop_reserve / pixels
  // / align 同源），所以每个 Pipeline Preset 各自一份，默认开。关掉不只是灰掉 UI —— 后端
  // 会真的跳过对应步骤。
  const enableMask = firstDp ? (firstDp.enable_mask ?? true) : true;
  const enableLimit = firstDp ? (firstDp.enable_limit ?? true) : true;

  // Krea2 提供 fit/crop 两种 Edit 模式（source patch）；其余架构仅显示 Enable Edit
  const isKrea2 = !!architecture && /krea2/i.test(architecture);

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      onAddContextImage(reader.result as string);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const readFileAsContextImage = (file: File) => {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      onAddContextImage(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleContextDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!contextDragOver) setContextDragOver(true);
  };

  const handleContextDragLeave = (e: React.DragEvent) => {
    // Only clear when leaving the container itself, not entering a child
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setContextDragOver(false);
  };

  const handleContextDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setContextDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) readFileAsContextImage(file);
  };

  // Ref Image 可以直接把文件拖上来：上传即选中，不必先拖进 context 再回来选。
  const [refDragOver, setRefDragOver] = React.useState<string | null>(null);

  const addRefImageFromFile = (blockId: string, file: File) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      void onAddContextImage(reader.result as string).then(key => {
        if (key) updateBlockParam(blockId, 'context_reference_key', key);
      });
    };
    reader.readAsDataURL(file);
  };

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
              onClick={() => {
                if (t.id === 'context') onRefreshHistory();
                onTabChange(t.id);
              }}
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
            <div style={styles.drawSettingsPanel}>
              {/* Live preview of the workbench composite. The composite IS the Context Image,
                  so this is what Run Detailer feeds on (tinted where the Mask layer is painted). */}
              <div style={styles.contextPreviewBox}>
                <div style={styles.sectionTitle}>Context</div>
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
              {/* Pipeline Blocks tab bar — 多套 blocks 以 tabs 切换（可重命名/复制/删除，持久化在后端
                  config）；只有激活 tab 的 chain 会运行、会被发给 Blend 工作台。块列表本体在
                  Preprocess Settings 下方，随激活 tab 联动。每个 tab 就是一个 Pipeline Preset，
                  也是 Blend 工作台 Generate 弹窗里那个 enum 的选项。 */}
              <div style={styles.sectionTitle}>Pipeline Presets</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
                {blockSets.map(set => {
                  const missing = set.blocks.filter(b => ifaceIsMissing(b)).length;
                  const isActive = set.id === activeBlockSetId;
                  if (renamingSetId === set.id) {
                    return (
                      <input key={set.id} autoFocus value={renamingValue} style={tabInputStyle}
                        onChange={e => setRenamingValue(e.target.value)}
                        onBlur={() => { onRenameBlockSet(set.id, renamingValue); setRenamingSetId(null); }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { onRenameBlockSet(set.id, renamingValue); setRenamingSetId(null); }
                          else if (e.key === 'Escape') setRenamingSetId(null);
                        }}
                      />
                    );
                  }
                  // A capsule: the left half IS the tab (click to switch, double-click to
                  // rename) and the right half runs this preset right now — one click
                  // instead of "switch the tab, then go and press Run".
                  return (
                    <div key={set.id} style={{
                      display: 'flex', alignItems: 'stretch', borderRadius: 999, overflow: 'hidden',
                      border: '0.5px solid ' + (isActive ? 'rgba(10,132,255,0.6)' : 'rgba(255,255,255,0.1)'),
                      background: isActive ? 'rgba(10,132,255,0.18)' : 'rgba(255,255,255,0.04)',
                    }}>
                      <button
                        title={missing > 0 ? `${missing} interface block(s) missing — they will be bypassed at run time` : set.name}
                        onClick={() => onSwitchBlockSet(set.id)}
                        onDoubleClick={() => { setRenamingSetId(set.id); setRenamingValue(set.name); }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5,
                          padding: '4px 10px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                          border: 'none', background: 'none',
                          color: isActive ? '#fff' : 'rgba(255,255,255,0.55)',
                        }}>
                        <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{set.name}</span>
                        {missing > 0 && (
                          <span style={{ background: 'rgba(255,159,10,0.22)', color: '#ff9f0a', borderRadius: 999, fontSize: 9.5, padding: '1px 5px', fontWeight: 700 }}>Missing ×{missing}</span>
                        )}
                      </button>
                      <button
                        title={`Run 「${set.name}」 now — the canvas composite, masked by the Mask layer`}
                        onClick={() => onRunPreset(set.id)}
                        style={{
                          display: 'flex', alignItems: 'center', padding: '4px 9px',
                          border: 'none', borderLeft: '0.5px solid rgba(255,255,255,0.12)',
                          background: 'rgba(255,255,255,0.06)', cursor: 'pointer', lineHeight: 1,
                          color: isActive ? '#30d158' : 'rgba(48,209,88,0.65)', fontSize: 11,
                        }}>▶</button>
                    </div>
                  );
                })}
                <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 'auto' }}>
                  <button title="Rename this tab (or double-click the tab)"
                    onClick={() => { const s = blockSets.find(x => x.id === activeBlockSetId); if (s) { setRenamingSetId(s.id); setRenamingValue(s.name); } }}
                    style={tabActionBtn}>✎</button>
                  <button title="Duplicate this tab" onClick={() => onDuplicateBlockSet(activeBlockSetId)} style={tabActionBtn}>⧉</button>
                  <button title={blockSets.length > 1 ? 'Delete this tab' : 'The last tab cannot be deleted'}
                    disabled={blockSets.length <= 1}
                    onClick={() => onRemoveBlockSet(activeBlockSetId)}
                    style={{ ...tabActionBtn, color: blockSets.length > 1 ? 'rgba(255,90,90,0.8)' : 'rgba(255,255,255,0.15)', cursor: blockSets.length > 1 ? 'pointer' : 'default' }}>✕</button>
                  <button title="New tab" onClick={onAddBlockSet} style={{ ...tabActionBtn, color: '#0a84ff', fontWeight: 700 }}>＋</button>
                </div>
              </div>

              {/* Global params — sits between the tab bar and the block list: pick the active
                  set above, tune its first detailer's crop/pixels here, then see the blocks. */}
              <div style={styles.sectionTitle}>Preprocess Settings</div>
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
                <input
                  style={styles.paramInput}
                  type="number"
                  min={0}
                  max={256}
                  step={1}
                  disabled={!firstDp}
                  value={firstDp ? (firstDp.crop_reserve ?? 32) : 32}
                  onChange={e => firstDetailer && updateBlockParam(firstDetailer.id, 'crop_reserve', parseInt(e.target.value))}
                />
              </div>
              <div style={styles.paramRow}
                title="开 = 按 crop 几何把产出合成回整幅图（原行为）。关 = 不 recover crop（也不 recover resize）：产出保持 crop 工作区分辨率，作为新图层由画布用 transform 贴回原来的位置，可继续微调。">
                <label style={styles.paramLabel}>Recover Crop</label>
                <IOSToggle
                  checked={firstDp ? (firstDp.recover_crop ?? true) : true}
                  disabled={!enableMask}
                  onChange={v => firstDetailer && updateBlockParam(firstDetailer.id, 'recover_crop', v)}
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
              <div style={{ opacity: enableLimit ? 1 : 0.4, pointerEvents: enableLimit ? 'auto' : 'none' }}>
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>Pixels</label>
                <input
                  style={styles.paramInput}
                  type="number"
                  min={65536}
                  max={16777216}
                  step={65536}
                  disabled={!firstDp}
                  value={firstDp ? (firstDp.pixels ?? 1048576) : 1048576}
                  onChange={e => firstDetailer && updateBlockParam(firstDetailer.id, 'pixels', parseInt(e.target.value))}
                />
              </div>
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>Align</label>
                <input
                  style={styles.paramInput}
                  type="number"
                  min={1}
                  max={64}
                  step={1}
                  disabled={!firstDp}
                  value={firstDp ? (firstDp.align ?? 8) : 8}
                  onChange={e => firstDetailer && updateBlockParam(firstDetailer.id, 'align', parseInt(e.target.value))}
                />
              </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative' }}>
                <div style={styles.sectionTitle}>Pipeline Blocks</div>
                <button
                  title="Append a block to this preset"
                  onClick={() => setAddMenuOpen(v => !v)}
                  style={{
                    background: addMenuOpen ? 'rgba(10,132,255,0.18)' : 'rgba(255,255,255,0.06)',
                    border: '0.5px solid ' + (addMenuOpen ? 'rgba(10,132,255,0.6)' : 'rgba(255,255,255,0.12)'),
                    borderRadius: 999, color: addMenuOpen ? '#fff' : 'rgba(255,255,255,0.7)',
                    fontSize: 11.5, fontWeight: 600, padding: '3px 10px', cursor: 'pointer', lineHeight: 1,
                  }}>Add +</button>
                {addMenuOpen && (
                  <>
                    {/* A menu, not a modal: clicking anywhere else dismisses it. */}
                    <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setAddMenuOpen(false)} />
                    <div style={{
                      position: 'absolute', top: '100%', right: 0, zIndex: 41, marginTop: 4,
                      background: '#1c1c1e', border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: 10,
                      padding: 4, minWidth: 152, boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
                    }}>
                      {ADD_BLOCK_KINDS.map(opt => (
                        <button key={opt.kind}
                          title={opt.hint}
                          onClick={() => { onAddBlock(opt.kind); setAddMenuOpen(false); }}
                          style={{
                            display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px',
                            background: 'none', border: 'none', borderRadius: 7, cursor: 'pointer',
                            color: opt.color, fontSize: 12, fontWeight: 600,
                          }}>{opt.label}</button>
                      ))}
                    </div>
                  </>
                )}
              </div>
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
                    {/* Centered title */}
                    <span style={{
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
                    {block.type === 'prompt' && (() => {
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
                              title="Which shared prompt preset this block injects"
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
                    })()}
                    {block.type === 'query' && (
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 }}>
                        执行到这一块会暂停并弹出 prompt 选择；Confirm 后按 prompt 块的规则合并（全局在前、本次选择在后），只影响其后的 detailer。关掉弹窗 = 中止整条链。
                      </div>
                    )}
                    {block.type === 'detailer' && (() => {
                      const dp = block.params as DetailerBlockParams;
                      return (<>
                        <div style={styles.paramRow}>
                          <label style={styles.paramLabel}>Add Noise</label>
                          <select style={styles.paramSelect} value={dp.add_noise} onChange={e => updateBlockParam(block.id, 'add_noise', e.target.value)}>
                            <option value="enable" style={{ background: '#1c1c1e', color: '#fff' }}>enable</option>
                            <option value="disable" style={{ background: '#1c1c1e', color: '#fff' }}>disable</option>
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
                        <div style={styles.paramRow}>
                          <label style={styles.paramLabel}>Enable Edit</label>
                          <IOSToggle checked={dp.enable_edit} onChange={v => updateBlockParam(block.id, 'enable_edit', v)} />
                        </div>
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
                            {/* Context Ref 没有开关：选中一张 Ref Image 本身就是启用。 */}
                            <div style={styles.paramRow}>
                              <label style={styles.paramLabel}>Ref Image</label>
                              <button
                                style={refDragOver === block.id
                                  ? { ...styles.contextLoadBtn, borderColor: '#0a84ff', background: 'rgba(10,132,255,0.20)' }
                                  : styles.contextLoadBtn}
                                title="Click to pick one from history, or drop an image file here to upload and use it as the reference (any resolution)"
                                onClick={() => setShowRefSelect(block.id)}
                                onDragOver={e => {
                                  if (!Array.from(e.dataTransfer.types).includes('Files')) return;
                                  e.preventDefault();
                                  e.dataTransfer.dropEffect = 'copy';
                                  if (refDragOver !== block.id) setRefDragOver(block.id);
                                }}
                                onDragLeave={e => {
                                  if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                                  setRefDragOver(null);
                                }}
                                onDrop={e => {
                                  e.preventDefault();
                                  setRefDragOver(null);
                                  const file = e.dataTransfer.files?.[0];
                                  if (file) addRefImageFromFile(block.id, file);
                                }}
                              >
                                {dp.context_reference_key
                                  ? (history.find(h => h.key === dp.context_reference_key)?.name ?? 'Selected')
                                  : (refDragOver === block.id ? 'Drop to upload' : 'Drop or select')}
                              </button>
                            </div>
                          </div>
                        )}
                      </>);
                    })()}
                    {block.type === 'interface' && (() => {
                      const ip = block.params as any;
                      // 仅允许：输入端口恰好 1 个 PIPELINE_DATA、输出端口恰好 1 个 PIPELINE_DATA 的 interface
                      // （这样才能正确以 pipeline 串联注入）
                      const isChainable = (itf: any) => {
                        const inP = itf?.start_ports?.filter((p: any) => p.type === 'PIPELINE_DATA')?.length ?? 0;
                        const outP = itf?.end_ports?.filter((p: any) => p.type === 'PIPELINE_DATA')?.length ?? 0;
                        return inP === 1 && outP === 1;
                      };
                      const selectableInterfaces = interfaces.filter(isChainable);
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
                              No chainable interface (need exactly 1 PIPELINE in &amp; 1 PIPELINE out)
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
                          {/* Per-port image selection from history (exclude auto-injected PIPELINE_DATA input) */}
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
                                {history.map((h, hi) => (
                                  <option key={hi} value={h.key} style={opt}>{h.name} ({h.key})</option>
                                ))}
                              </select>
                            </div>
                          ))}
                          {/* Optional context image / mask (defaults to pipeline flow) */}
                          <div style={styles.paramRow}>
                            <span style={styles.paramLabel}>Ctx Image</span>
                            <select
                              style={{ ...styles.paramSelect, minWidth: 0 }}
                              value={ip.context_image_key || ''}
                              onChange={e => updateIfaceParam('context_image_key', e.target.value || null)}
                            >
                              <option value="" style={opt}>(use pipeline)</option>
                              {history.map((h, hi) => (
                                <option key={hi} value={h.key} style={opt}>{h.name} ({h.key})</option>
                              ))}
                            </select>
                          </div>
                          {ip.context_image_key && (() => {
                            const img = history.find((h) => h.key === ip.context_image_key);
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
                              style={{ ...styles.paramSelect, minWidth: 0 }}
                              value={ip.context_mask_key || ''}
                              onChange={e => updateIfaceParam('context_mask_key', e.target.value || null)}
                            >
                              <option value="" style={opt}>(use pipeline)</option>
                              {history.map((h, hi) => (
                                <option key={hi} value={h.key} style={opt}>{h.name} ({h.key})</option>
                              ))}
                            </select>
                          </div>
                          {ip.context_mask_key && (() => {
                            const img = history.find((h) => h.key === ip.context_mask_key);
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
          <InterfaceTab interfaces={interfaces} detailStatusByIdx={interfaceStatusByIdx} detailProgressByIdx={interfaceProgressByIdx} onExecuteInterface={onExecuteInterface} interfaceResults={interfaceResults} currentContextKey={currentContextKey} onSetContext={onSetContext} history={history} />
        )}

        {/* Pipeline — dynamic pipeline switching */}
        {tab === 'pipeline' && (
          <PipelineTab pipelinePackages={pipelinePackages} onSwitchPipeline={onSwitchPipeline} currentPipelineKey={currentPipelineKey} />
        )}

        {/* Context — left/right split layout */}
        {tab === 'context' && (
          <div
            style={{ ...styles.contextLayout, position: 'relative' }}
            onDragOver={handleContextDragOver}
            onDragLeave={handleContextDragLeave}
            onDrop={handleContextDrop}
          >
            {/* Left: large preview */}
            <div style={styles.contextPreview}>
              {hoveredHistory ? (
                <>
                  <img src={hoveredHistory.src} alt={hoveredHistory.name} style={styles.contextPreviewImg} />
                  <div style={styles.contextPreviewLabel}>{hoveredHistory.name}</div>
                  <button style={styles.contextSelectBtn} onClick={() => onSelectImage(hoveredHistory.key)}>
                    Select This Image
                  </button>
                </>
              ) : (
                <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 14 }}>Hover over a thumbnail to preview</div>
              )}
            </div>
            {/* Right: thumbnail list + load buttons */}
            <div style={styles.contextThumbList}>
              <div style={styles.contextLoadBtns}>
                <button style={styles.contextLoadBtn} onClick={() => fileInputRef.current?.click()}>
                  Load From Image
                </button>
                <button
                  style={{ ...styles.contextLoadBtn, opacity: loadingAssets ? 0.5 : 1, cursor: loadingAssets ? 'wait' : 'pointer' }}
                  onClick={onLoadFromAssets}
                  disabled={loadingAssets}
                >
                  {loadingAssets ? 'Loading…' : 'Load From Assets'}
                </button>
                <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileSelect} />
              </div>
              {history.map(h => (
                <button
                  key={h.key}
                  style={{
                    ...styles.contextThumb,
                    borderColor: currentContextKey === h.key ? '#0a84ff'
                      : (hoveredHistory?.key === h.key ? '#0a84ff' : 'rgba(255,255,255,0.08)'),
                    boxShadow: currentContextKey === h.key ? '0 0 0 2px rgba(10,132,255,0.3)' : 'none',
                  }}
                  onMouseEnter={() => setHoveredHistory(h)}
                  onClick={() => onSelectImage(h.key)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setContextMenu({ x: e.clientX, y: e.clientY, item: h });
                  }}
                >
                  <img src={h.src} alt={h.name} style={styles.contextThumbImg} />
                  <div style={styles.contextThumbName}>{h.name}</div>
                  {currentContextKey === h.key && <div style={styles.contextActiveDot} />}
                </button>
              ))}
              {history.length === 0 && (
                <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 14, padding: 20 }}>No history yet.</div>
              )}
            </div>
            {/* Drag-to-add overlay */}
            {contextDragOver && (
              <div style={styles.contextDropOverlay}>
                <div style={styles.contextDropInner}>Drop image to add to context</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Reference image select modal */}
      {showRefSelect && (() => {
        // 任何分辨率都可以作参考图 —— 以前要求与当前 context 同尺寸，
        // 结果大部分历史图根本选不到。现在只排除当前这张（自己参考自己没有意义）。
        const eligible = history.filter(h => h.key !== currentContextKey);
        return (
          <div style={styles.overlay}>
            <div
              style={styles.dialog}
              onDragOver={e => {
                if (!Array.from(e.dataTransfer.types).includes('Files')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }}
              onDrop={e => {
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (!file) return;
                addRefImageFromFile(showRefSelect, file);
                setShowRefSelect(null);
              }}
            >
              <div style={styles.dialogTitle}>Select Reference Image</div>
              <div style={styles.dialogSubtitle}>Any resolution — click to use it, or drop an image file here</div>
              {eligible.length === 0 ? (
                <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 13, padding: 12 }}>No eligible images available.</div>
              ) : (
                <div style={styles.dialogHistoryGrid}>
                  {eligible.map(h => (
                    <button key={h.key} style={styles.historyCard} onClick={() => {
                      updateBlockParam(showRefSelect, 'context_reference_key', h.key);
                      setShowRefSelect(null);
                    }}>
                      <div style={styles.historyImgWrap}>
                        <img src={h.src} alt={h.name} style={styles.historyImg} />
                      </div>
                      <div style={styles.historyName}>{h.name}</div>
                    </button>
                  ))}
                </div>
              )}
              <div style={styles.dialogActions}>
                <button style={styles.cancelBtn} onClick={() => setShowRefSelect(null)}>Cancel</button>
              </div>
            </div>
          </div>
        );
      })()}

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

      {/* Query dialog — a run is parked on a Query block and waits for this answer. The
          prompt UI opens in query scope: it starts EMPTY and hands the RAW selection to the
          host, which forwards it to the backend (the merge and the programs happen there).
          Closing it cancels, and cancelling aborts the whole chain. */}
      {pendingQuery && (() => {
        const qParams = 'sampler_base=' + encodeURIComponent(window.location.origin) + '&scope=query';
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
                {(hoveredFinish || history.find(h => selectedKeys.has(h.key))) ? (
                  <>
                    <img src={(hoveredFinish || history.find(h => selectedKeys.has(h.key)))!.src} alt={(hoveredFinish || history.find(h => selectedKeys.has(h.key)))!.name} style={{ maxWidth: '100%', maxHeight: 'calc(100% - 40px)', objectFit: 'contain', borderRadius: 12 }} />
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>{(hoveredFinish || history.find(h => selectedKeys.has(h.key)))!.name}</div>
                  </>
                ) : (
                  <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 14 }}>Hover over a card to preview</div>
                )}
              </div>
              {/* Right: card grid */}
              <div style={{ width: 420, flexShrink: 0, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignContent: 'flex-start' }}>
                  {history.map(h => (
                    <button
                      key={h.key}
                      style={{
                        ...styles.historyCard,
                        borderColor: selectedKeys.has(h.key) ? '#0a84ff'
                          : (hoveredFinish?.key === h.key ? 'rgba(10,132,255,0.4)' : 'rgba(255,255,255,0.08)'),
                        boxShadow: selectedKeys.has(h.key) ? '0 0 0 2px rgba(10,132,255,0.3)' : 'none',
                      }}
                      onMouseEnter={() => setHoveredFinish(h)}
                      onClick={() => toggleFinishSelection(h.key)}
                    >
                      <div style={styles.historyImgWrap}>
                        <img src={h.src} alt={h.name} style={styles.historyImg} />
                        {selectedKeys.has(h.key) && (
                          <div style={styles.historyCheck}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M5 13l4 4L19 7" />
                            </svg>
                          </div>
                        )}
                      </div>
                      <div style={styles.historyName}>{h.name}</div>
                    </button>
                  ))}
                </div>
                {history.length === 0 && (
                  <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 14, padding: 20 }}>No history yet.</div>
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

      {/* 右键菜单 */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          item={contextMenu.item}
          onAction={handleContextAction}
        />
      )}

      {/* Resize Modal */}
      {resizeModal && (
        <ResizeModal
          item={resizeModal.item}
          onSubmit={handleResizeSubmit}
          onCancel={() => setResizeModal(null)}
        />
      )}

      {/* Blend layer picker — the workbench asks for images, each picked one becomes a layer */}
      {showBlendSelect && (
        <div style={styles.overlay}>
          <div style={styles.dialog}>
            <div style={styles.dialogTitle}>Add Layers</div>
            <div style={styles.dialogSubtitle}>Pick one or more images. Each becomes a layer — the top of the list draws on top.</div>
            <div style={styles.dialogHistoryGrid}>
              {history.map(h => {
                const on = blendPicked.includes(h.key);
                return (
                  <button
                    key={h.key}
                    style={{
                      ...styles.historyCard,
                      borderColor: on ? '#0a84ff' : 'rgba(255,255,255,0.08)',
                      boxShadow: on ? '0 0 0 2px rgba(10,132,255,0.3)' : 'none',
                    }}
                    onClick={() => setBlendPicked(p => (on ? p.filter(k => k !== h.key) : [...p, h.key]))}
                  >
                    <div style={styles.historyImgWrap}>
                      <img src={h.src} alt={h.name} style={styles.historyImg} />
                      {on && (
                        <div style={styles.historyCheck}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M5 13l4 4L19 7" />
                          </svg>
                        </div>
                      )}
                    </div>
                    <div style={styles.historyName}>{h.name}</div>
                  </button>
                );
              })}
            </div>
            {history.length === 0 && (
              <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 14, padding: '12px 0' }}>No history yet.</div>
            )}
            <div style={styles.dialogActions}>
              <button style={styles.cancelBtn} onClick={onCloseBlendSelect}>Cancel</button>
              <button
                style={{ ...styles.confirmBtn, opacity: blendPicked.length ? 1 : 0.45, cursor: blendPicked.length ? 'pointer' : 'default' }}
                disabled={!blendPicked.length}
                onClick={() => onBlendSelectImages(history.filter(h => blendPicked.includes(h.key)).map(h => ({ key: h.key, name: h.name, src: h.src })))}
              >
                {blendPicked.length ? `Add ${blendPicked.length} layer${blendPicked.length > 1 ? 's' : ''}` : 'Add'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ── InterfaceTab ──
const InterfaceTab: React.FC<{
  interfaces: InterfaceInfo[];
  detailStatusByIdx: Record<number, 'idle' | 'running' | 'done' | 'error'>;
  detailProgressByIdx: Record<number, { progress: number; current: number; total: number }>;
  onExecuteInterface: (interfaceIndex: number, manualValues: Record<string, any>, execOptions?: Record<string, any>) => void;
  interfaceResults: Record<number, HistoryItem[]>;
  currentContextKey: string | null;
  onSetContext: (key: string) => void;
  history: HistoryItem[];
}> = ({ interfaces, detailStatusByIdx, detailProgressByIdx, onExecuteInterface, interfaceResults, currentContextKey, onSetContext, history }) => {
  const [manualValues, setManualValues] = useState<Record<number, Record<string, any>>>({});
  // 每个 interface 的执行选项: operation 和 crop_reserve 是卡片级, image_keys 是端口级
  const [execOptions, setExecOptions] = useState<Record<number, { operation: 'default' | 'crop'; crop_reserve: number; image_keys: Record<number, string | null> }>>({});
  const [showImageSelect, setShowImageSelect] = useState<{ ifaceIdx: number; portNum: number } | null>(null);

  if (interfaces.length === 0) {
    return <div style={{ padding: 20, color: 'rgba(255,255,255,0.3)', fontSize: 14 }}>No interfaces connected.</div>;
  }

  const updateOpts = (idx: number, patch: Partial<typeof execOptions[number]>) => {
    setExecOptions(prev => ({ ...prev, [idx]: { ...prev[idx], ...patch } }));
  };

  const setImageKey = (idx: number, portNum: number, key: string | null) => {
    setExecOptions(prev => {
      const cur = prev[idx] || { operation: 'default' as const, crop_reserve: 32, image_keys: {} };
      return { ...prev, [idx]: { ...cur, image_keys: { ...cur.image_keys, [portNum]: key } } };
    });
  };

  const handleExecute = (idx: number) => {
    const opts = execOptions[idx] || { operation: 'default', crop_reserve: 32, image_keys: {} };
    const payload = {
      operation: opts.operation,
      crop_reserve: opts.crop_reserve,
      image_keys: opts.image_keys || {},
    };
    onExecuteInterface(idx, manualValues[idx] || {}, payload);
  };

  const showProgress = (idx: number) => detailStatusByIdx[idx] === 'running' && (detailProgressByIdx[idx]?.total ?? 0) > 0;

  // Evaluate a simple arithmetic expression (e.g. "1024*1024", "512*0.5") safely.
  // Only digits, operators (+-*/), parentheses, dots, spaces and 'x'/'.' are allowed.
  // Returns a number, or null if the expression is invalid/unsafe.
  const safeEvalExpr = (raw: string): number | null => {
    const expr = raw.replace(/x/gi, '*').replace(/\s+/g, '');
    if (!/^[\d+\-*/().]+$/.test(expr)) return null;
    if (expr === '' || /[+\-*/.]$/.test(expr) || /[+\-*/.]{2,}/.test(expr)) return null;
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('"use strict"; return (' + expr + ');');
      const r = fn();
      if (typeof r !== 'number' || !isFinite(r)) return null;
      return r;
    } catch {
      return null;
    }
  };

  const renderPort = (port: InterfacePort, idx: number, isStart: boolean) => {
    const mv = manualValues[idx]?.[String(port.num)] ?? port.value ?? '';
    const cat = port.category;
    const badgeColor = cat === 'inject' ? 'rgba(48,209,88,0.15)' : cat === 'manual' ? 'rgba(10,132,255,0.15)' : 'rgba(255,255,255,0.08)';
    const badgeText = cat === 'inject' ? '#30d158' : cat === 'manual' ? '#0a84ff' : 'rgba(255,255,255,0.3)';
    const label = cat === 'inject' ? '(inject)' : cat === 'manual' ? '(widget)' : '(port)';

    return (
      <div key={port.num} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', minWidth: 0 }}>
        {/* Port name */}
        <div style={{ minWidth: 80, fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.7)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{port.name}</div>
        {/* Type badge */}
        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: badgeColor, color: badgeText, minWidth: 70, textAlign: 'center', flexShrink: 0 }}>
          {port.type}
        </span>
        {/* Category label */}
        <span style={{ fontSize: 10, color: badgeText, fontWeight: 500, minWidth: 50, flexShrink: 0 }}>{label}</span>

        {/* Input controls for manual types */}
        {isStart && port.type === 'STRING' && (
          <input style={{ flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.08)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '4px 8px', color: '#fff', fontSize: 12, outline: 'none' }}
            value={mv} onChange={e => setManualValues(prev => ({ ...prev, [idx]: { ...prev[idx], [String(port.num)]: e.target.value } }))} />
        )}
        {isStart && (port.type === 'INT' || port.type === 'FLOAT') && (
          <input style={{ flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.08)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '4px 8px', color: '#fff', fontSize: 12, outline: 'none' }}
            value={mv}
            placeholder={port.type === 'FLOAT' ? 'e.g. 1.5 or 512*0.5' : 'e.g. 1024*1024'}
            onChange={e => setManualValues(prev => ({ ...prev, [idx]: { ...prev[idx], [String(port.num)]: e.target.value } }))}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onBlur={e => {
              const raw = e.target.value.trim();
              const v = raw === '' ? (port.type === 'FLOAT' ? 0 : 0) : safeEvalExpr(raw);
              if (v !== null) {
                setManualValues(prev => ({ ...prev, [idx]: { ...prev[idx], [String(port.num)]: port.type === 'FLOAT' ? v : Math.round(v) } }));
              }
            }}
          />
        )}
        {isStart && port.type === 'BOOLEAN' && (
          <input type="checkbox" checked={!!mv} onChange={e => setManualValues(prev => ({ ...prev, [idx]: { ...prev[idx], [String(port.num)]: e.target.checked } }))} />
        )}
        {isStart && port.type === 'COMBO' && (
          port.options && port.options.length > 0 ? (
            <select style={{ flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.08)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '4px 8px', color: '#fff', fontSize: 12, outline: 'none' }}
              value={mv ?? port.options[0]} onChange={e => setManualValues(prev => ({ ...prev, [idx]: { ...prev[idx], [String(port.num)]: e.target.value } }))}>
              {port.options.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input style={{ flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.08)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '4px 8px', color: '#fff', fontSize: 12, outline: 'none' }}
              value={mv ?? ''} onChange={e => setManualValues(prev => ({ ...prev, [idx]: { ...prev[idx], [String(port.num)]: e.target.value } }))} />
          )
        )}

        {/* IMAGE port: per-port image selector with preview */}
        {isStart && cat === 'inject' && port.type === 'IMAGE' && (() => {
          const selectedKey = execOptions[idx]?.image_keys?.[port.num] ?? null;
          const ctxItem = history.find(h => h.key === currentContextKey);
          const selItem = selectedKey ? history.find(h => h.key === selectedKey) : null;
          const previewSrc = selItem?.src ?? ctxItem?.src ?? null;
          const previewLabel = selItem ? selItem.name : 'Context Image';
          return (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
              <div
                style={{ position: 'relative', width: 40, height: 40, borderRadius: 6, overflow: 'hidden', cursor: 'pointer', background: '#1a1a1a', border: selectedKey ? '1.5px solid #0a84ff' : '0.5px solid rgba(255,255,255,0.1)', flexShrink: 0 }}
                onClick={() => setShowImageSelect({ ifaceIdx: idx, portNum: port.num })}
                title={previewLabel}
              >
                {previewSrc ? (
                  <img src={previewSrc} alt={previewLabel} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.2)', fontSize: 9 }}>No img</div>
                )}
              </div>
              <span style={{ fontSize: 10, color: selectedKey ? '#0a84ff' : 'rgba(255,255,255,0.4)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{previewLabel}</span>
              {selectedKey && (
                <button
                  style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: 14, padding: '2px 4px', flexShrink: 0 }}
                  onClick={() => setImageKey(idx, port.num, null)}
                  title="Reset to context image"
                >
                  ✕
                </button>
              )}
            </div>
          );
        })()}

        {/* Inject label for non-IMAGE auto types */}
        {isStart && cat === 'inject' && port.type !== 'IMAGE' && (
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
            {port.type === 'MASK' ? '← Mask' : '← Pipeline'}
          </span>
        )}

        {/* Not connected */}
        {port.type === 'NONE' && <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>Not connected</span>}
      </div>
    );
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowX: 'auto', overflowY: 'hidden', padding: 16, display: 'flex', flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}>
      {interfaces.map((iface, idx) => (
        <div key={idx} style={{ width: 360, flexShrink: 0, background: 'rgba(28,28,30,0.6)', borderRadius: 12, padding: 16, border: '0.5px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', marginBottom: 12 }}>{iface.name || `Interface ${idx + 1}`}</div>

          {/* Start ports (inputs) */}
          {iface.start_ports && iface.start_ports.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Start (Inputs)</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {iface.start_ports.map(port => renderPort(port, idx, true))}
              </div>
            </div>
          )}

          {/* Operation options (card-level) */}
          {iface.start_ports && iface.start_ports.some(p => p.type === 'IMAGE' || p.type === 'MASK') && (
            <div style={{ marginBottom: 12, padding: 10, background: 'rgba(10,132,255,0.06)', borderRadius: 8, border: '0.5px solid rgba(10,132,255,0.15)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.6)', minWidth: 70 }}>Operation</label>
                <select style={styles.paramSelect} value={execOptions[idx]?.operation ?? 'default'} onChange={e => updateOpts(idx, { operation: e.target.value as 'default' | 'crop' })}>
                  <option value="default" style={{ background: '#1c1c1e', color: '#fff' }}>默认 (整图)</option>
                  <option value="crop" style={{ background: '#1c1c1e', color: '#fff' }}>Crop Mask 区域</option>
                </select>
                {execOptions[idx]?.operation === 'crop' && (
                  <>
                    <label style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.6)', minWidth: 50 }}>Reserve</label>
                    <input type="number" min={0} max={256} style={{ ...styles.paramInput, width: 70, flex: 'none' }} value={execOptions[idx]?.crop_reserve ?? 32} onChange={e => updateOpts(idx, { crop_reserve: parseInt(e.target.value) || 0 })} />
                  </>
                )}
              </div>
            </div>
          )}

          {/* End ports (outputs) */}
          {iface.end_ports && iface.end_ports.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>End (Outputs)</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {iface.end_ports.map(port => renderPort(port, idx, false))}
              </div>
            </div>
          )}

          {detailStatusByIdx[idx] === 'running' && (
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={styles.spinner} />
              <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, fontWeight: 600 }}>Running…</span>
              {showProgress(idx) && <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>{detailProgressByIdx[idx]?.current} / {detailProgressByIdx[idx]?.total}</span>}
            </div>
          )}
          {(() => {
            const ifaceResults = interfaceResults[idx] || [];
            const showIfaceResults = detailStatusByIdx[idx] === 'done' || ifaceResults.length > 0;
            if (!showIfaceResults) return null;
            if (ifaceResults.length === 0) {
              return detailStatusByIdx[idx] === 'done' ? (
                <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>✓ Done — no images generated</div>
              ) : null;
            }
            return (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Results</div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {ifaceResults.map(r => {
                    const active = r.key === currentContextKey;
                    return (
                      <div
                        key={r.key}
                        style={{
                          ...styles.resultCard,
                          width: '100%', flex: '1 1 100%',
                          borderColor: active ? '#0a84ff' : 'rgba(255,255,255,0.08)',
                          boxShadow: active ? '0 0 0 2px rgba(10,132,255,0.3)' : 'none',
                          cursor: active ? 'default' : 'pointer',
                        }}
                        onClick={() => !active && onSetContext(r.key)}
                      >
                        <div style={styles.resultLabel}>{r.name}</div>
                        <img src={r.src} alt={r.name} style={{ width: '100%', height: 'auto', maxHeight: 200, objectFit: 'contain', borderRadius: 8 }} />
                      </div>
                    );
                  })}
                </div>
                <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>Click a card to set as context</div>
              </div>
            );
          })()}
          {detailStatusByIdx[idx] === 'error' && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#ff453a', fontWeight: 600 }}>✗ Error</div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button
              style={{ ...styles.runBtn, opacity: detailStatusByIdx[idx] === 'running' ? 0.4 : 1, cursor: detailStatusByIdx[idx] === 'running' ? 'not-allowed' : 'pointer' }}
              onClick={() => handleExecute(idx)}
              disabled={detailStatusByIdx[idx] === 'running'}
            >
              {detailStatusByIdx[idx] === 'running' ? 'Running…' : 'Execute'}
            </button>
          </div>
        </div>
      ))}

      {/* 从 Context 选择图片 modal — per-port image selection */}
      {showImageSelect !== null && (() => {
        const { ifaceIdx, portNum } = showImageSelect;
        const cur = history.find(h => h.key === currentContextKey);
        const cw = cur?.width, ch = cur?.height;
        const currentSel = execOptions[ifaceIdx]?.image_keys?.[portNum] ?? null;
        const eligible = history.filter(h => h.key !== currentContextKey && h.key !== currentSel &&
          (!cw || !ch || (h.width === cw && h.height === ch)));
        return (
          <div style={styles.overlay}>
            <div style={styles.dialog}>
              <div style={styles.dialogTitle}>Select Image for Port {portNum}{cw && ch ? ' (' + cw + 'x' + ch + ')' : ''}</div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginBottom: 12 }}>
                Select an image to inject into this IMAGE port. Close to use context image.
              </div>
              {eligible.length === 0 ? (
                <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 13, padding: 12 }}>No same-size images available.</div>
              ) : (
                <div style={styles.dialogHistoryGrid}>
                  {eligible.map(h => (
                    <button key={h.key} style={styles.historyCard} onClick={() => {
                      setImageKey(ifaceIdx, portNum, h.key);
                      setShowImageSelect(null);
                    }}>
                      <div style={styles.historyImgWrap}>
                        <img src={h.src} alt={h.name} style={styles.historyImg} />
                      </div>
                      <div style={styles.historyName}>{h.name}</div>
                    </button>
                  ))}
                </div>
              )}
              <div style={styles.dialogActions}>
                <button style={styles.cancelBtn} onClick={() => setShowImageSelect(null)}>Cancel</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

// ── PipelineTab ──
const PipelineTab: React.FC<{
  pipelinePackages: PipelinePackageInfo[];
  onSwitchPipeline: (packageIdx: number, pipelineIdx: number) => void;
  currentPipelineKey: string | null;
}> = ({ pipelinePackages, onSwitchPipeline, currentPipelineKey }) => {
  if (pipelinePackages.length === 0) {
    return <div style={{ padding: 20, color: 'rgba(255,255,255,0.3)', fontSize: 14 }}>No pipeline packages connected.</div>;
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowX: 'auto', overflowY: 'hidden', padding: 16, display: 'flex', flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}>
      {pipelinePackages.map((pkg, pkgIdx) => (
        <div key={pkgIdx} style={{ width: 360, flexShrink: 0, background: 'rgba(28,28,30,0.6)', borderRadius: 12, padding: 16, border: '0.5px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', marginBottom: 12 }}>{pkg.name || 'Pipeline Group ' + (pkgIdx + 1)}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pkg.pipelines.map((pl, plIdx) => {
              const key = pkgIdx + '_' + plIdx;
              const active = key === currentPipelineKey;
              return (
                <div
                  key={plIdx}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                    borderRadius: 8,
                    background: active ? 'rgba(48,209,88,0.1)' : 'rgba(255,255,255,0.04)',
                    border: '0.5px solid ' + (active ? '#30d158' : 'rgba(255,255,255,0.08)'),
                    boxShadow: active ? '0 0 0 2px rgba(48,209,88,0.2)' : 'none',
                  }}
                >
                  <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: active ? '#30d158' : 'rgba(255,255,255,0.8)' }}>{pl.name}</div>
                  {active ? (
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#30d158' }}>● Active</span>
                  ) : (
                    <button
                      style={{ ...styles.runBtn, padding: '4px 14px', fontSize: 12 }}
                      onClick={() => onSwitchPipeline(pkgIdx, plIdx)}
                    >
                      Switch
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {pkg.pipelines.length === 0 && (
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', padding: 8 }}>No pipelines found.</div>
          )}
        </div>
      ))}
    </div>
  );
};

// ── 右键菜单 ──
const ContextMenu: React.FC<{
  x: number;
  y: number;
  item: HistoryItem;
  onAction: (action: string, item: HistoryItem) => void;
}> = ({ x, y, item, onAction }) => {
  // 防止菜单超出视口
  const menuWidth = 160;
  const menuHeight = 100;
  const adjX = Math.min(x, window.innerWidth - menuWidth - 8);
  const adjY = Math.min(y, window.innerHeight - menuHeight - 8);

  const items: { action: string; label: string; icon?: string }[] = [
    { action: 'select', label: 'Select as Context', icon: '◉' },
    { action: 'resize', label: 'Resize…', icon: '⤢' },
  ];

  return (
    <div style={{
      position: 'fixed',
      left: adjX,
      top: adjY,
      zIndex: 200,
      minWidth: menuWidth,
      background: 'rgba(28,28,30,0.95)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      borderRadius: 10,
      border: '0.5px solid rgba(255,255,255,0.12)',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      padding: 5,
      overflow: 'hidden',
    }}>
      {items.map((mi) => (
        <button
          key={mi.action}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            padding: '8px 12px',
            background: 'transparent',
            border: 'none',
            borderRadius: 6,
            color: 'rgba(255,255,255,0.85)',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            textAlign: 'left' as const,
            transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          onClick={(e) => {
            e.stopPropagation();
            onAction(mi.action, item);
          }}
        >
          <span style={{ fontSize: 14, opacity: 0.7, width: 18, textAlign: 'center' as const }}>{mi.icon}</span>
          <span>{mi.label}</span>
        </button>
      ))}
      <div style={{ padding: '2px 12px', fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>
        {item.width && item.height ? `${item.width}×${item.height}` : ''}
      </div>
    </div>
  );
};

// ── Resize Modal ──
const ResizeModal: React.FC<{
  item: HistoryItem;
  onSubmit: (key: string, width: number, height: number) => void;
  onCancel: () => void;
}> = ({ item, onSubmit, onCancel }) => {
  const origW = item.width || 0;
  const origH = item.height || 0;
  const [width, setWidth] = useState(origW);
  const [height, setHeight] = useState(origH);
  const [lockRatio, setLockRatio] = useState(true);
  // 比例 = width / height
  const ratioRef = useRef(origH > 0 ? origW / origH : 1);
  // width 比例 和 height 比例 (相对原图)
  const wPct = origW > 0 ? (width / origW * 100) : 100;
  const hPct = origH > 0 ? (height / origH * 100) : 100;

  const handleWidthChange = (val: number) => {
    const clamped = Math.max(1, Math.round(val));
    setWidth(clamped);
    if (lockRatio && origH > 0) {
      setHeight(Math.max(1, Math.round(clamped / ratioRef.current)));
    }
  };

  const handleHeightChange = (val: number) => {
    const clamped = Math.max(1, Math.round(val));
    setHeight(clamped);
    if (lockRatio && origW > 0) {
      setWidth(Math.max(1, Math.round(clamped * ratioRef.current)));
    }
  };

  const handleSubmit = () => {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    onSubmit(item.key, w, h);
  };

  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div style={{ ...styles.dialog, width: 380, padding: 0, overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={{ padding: '20px 24px 12px' }}>
          <div style={styles.dialogTitle}>Resize Image</div>
          <div style={styles.dialogSubtitle}>
            {item.name}
            {origW && origH ? `  ·  Original: ${origW}×${origH}` : ''}
          </div>
        </div>

        {/* Preview */}
        <div style={{ display: 'flex', justifyContent: 'center', padding: '0 24px 16px' }}>
          <div style={{
            width: 120, height: 120, borderRadius: 10, overflow: 'hidden',
            background: '#0d0d0d', display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '0.5px solid rgba(255,255,255,0.08)',
          }}>
            <img src={item.src} alt={item.name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          </div>
        </div>

        {/* Inputs */}
        <div style={{ padding: '0 24px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Width row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.7)', width: 50 }}>Width</label>
            <input
              type="number"
              min={1}
              value={width}
              onChange={(e) => handleWidthChange(Number(e.target.value))}
              style={resizeStyles.input}
              onFocus={(e) => e.target.select()}
            />
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', width: 48 }}>
              {wPct.toFixed(1)}%
            </span>
          </div>

          {/* Height row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.7)', width: 50 }}>Height</label>
            <input
              type="number"
              min={1}
              value={height}
              onChange={(e) => handleHeightChange(Number(e.target.value))}
              style={resizeStyles.input}
              onFocus={(e) => e.target.select()}
            />
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', width: 48 }}>
              {hPct.toFixed(1)}%
            </span>
          </div>

          {/* Lock ratio toggle */}
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 12px', borderRadius: 8,
              background: 'rgba(255,255,255,0.04)',
              border: '0.5px solid rgba(255,255,255,0.06)',
              cursor: 'pointer',
            }}
            onClick={() => {
              if (!lockRatio) {
                // 重新锁定时以当前 width 为基准计算比例
                if (height > 0) ratioRef.current = width / height;
              }
              setLockRatio(!lockRatio);
            }}
          >
            <div style={{
              width: 18, height: 18, borderRadius: '50%',
              border: lockRatio ? 'none' : '1.5px solid rgba(255,255,255,0.3)',
              background: lockRatio ? '#0a84ff' : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, transition: 'all 0.2s',
            }}>
              {lockRatio && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 6L3 12l6 6" />
                  <path d="M15 6l6 6-6 6" />
                </svg>
              )}
            </div>
            <span style={{ fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.7)' }}>
              Lock Aspect Ratio
            </span>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          ...styles.dialogActions,
          padding: '12px 24px 20px',
          marginTop: 0,
          borderTop: '0.5px solid rgba(255,255,255,0.06)',
        }}>
          <button style={styles.cancelBtn} onClick={onCancel}>Cancel</button>
          <button style={styles.confirmBtn} onClick={handleSubmit}>
            Resize
          </button>
        </div>
      </div>
    </div>
  );
};

const resizeStyles: Record<string, React.CSSProperties> = {
  input: {
    flex: 1,
    padding: '8px 12px',
    fontSize: 14,
    fontWeight: 500,
    color: '#fff',
    background: 'rgba(0,0,0,0.3)',
    border: '0.5px solid rgba(255,255,255,0.1)',
    borderRadius: 8,
    outline: 'none',
    minWidth: 0,
  },
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
  drawSettingsPanel: {
    width: 260, flexShrink: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
    background: 'rgba(28,28,30,0.4)', borderRight: '0.5px solid rgba(255,255,255,0.06)', overflowY: 'auto',
  },
  sectionTitle: { fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 },
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
  paramSelect: { flex: 1, background: 'rgba(255,255,255,0.06)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: '0.5px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '6px 12px', color: '#fff', fontSize: 13, outline: 'none', colorScheme: 'dark', WebkitAppearance: 'none', appearance: 'none', backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\' viewBox=\'0 0 10 6\' fill=\'none\'%3E%3Cpath d=\'M1 1L5 5L9 1\' stroke=\'rgba(255,255,255,0.4)\' stroke-width=\'1.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 28, transition: 'background 0.15s ease, border-color 0.15s ease' } as React.CSSProperties,
  paramInput: { flex: 1, background: 'rgba(255,255,255,0.08)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '5px 10px', color: '#fff', fontSize: 13, outline: 'none', fontVariantNumeric: 'tabular-nums' },

  editSubSection: { marginLeft: 8, paddingLeft: 10, borderLeft: '0.5px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: 10 },


  // Progress bar — iOS style

  resultCard: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0, background: 'rgba(28,28,30,0.6)', borderRadius: 12, padding: 8, border: '0.5px solid rgba(255,255,255,0.08)' },
  resultLabel: { fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.6)' },


  // Run button — bottom right
  runBtn: {
    padding: '10px 28px', fontSize: 14, fontWeight: 700, color: '#fff',
    background: 'rgba(48,209,88,0.85)', border: 'none', borderRadius: 10, cursor: 'pointer',
    transition: 'all 0.2s ease', letterSpacing: '0.3px',
    boxShadow: '0 2px 12px rgba(48,209,88,0.2)',
  },

  // Draw tab — right side two-column: mask iframe (left) + result cards (right)

  // Quick tag buttons row (left of Run Detailer)

  // Context — left/right split layout
  contextLayout: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row' },
  contextPreview: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 16, gap: 8, background: '#0d0d0d' },
  contextPreviewImg: { maxWidth: '100%', maxHeight: 'calc(100% - 80px)', objectFit: 'contain', borderRadius: 12 },
  contextPreviewLabel: { fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.7)' },
  contextSelectBtn: { padding: '8px 24px', fontSize: 13, fontWeight: 600, color: '#fff', background: 'rgba(48,209,88,0.85)', border: 'none', borderRadius: 8, cursor: 'pointer' },
  contextThumbList: { width: 240, flexShrink: 0, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8, background: 'rgba(28,28,30,0.4)', borderLeft: '0.5px solid rgba(255,255,255,0.06)' },
  contextThumb: { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, padding: 6, background: 'rgba(28,28,30,0.6)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, cursor: 'pointer', transition: 'border-color 0.2s ease' },
  contextThumbImg: { width: 56, height: 56, objectFit: 'cover', borderRadius: 6, flexShrink: 0 },
  contextThumbName: { fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.7)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  contextActiveDot: { width: 8, height: 8, borderRadius: '50%', background: '#0a84ff', boxShadow: '0 0 6px rgba(10,132,255,0.5)', flexShrink: 0, marginLeft: 'auto' },
  contextLoadBtns: { display: 'flex', gap: 6, marginBottom: 4 },
  contextLoadBtn: { flex: 1, padding: '6px 8px', fontSize: 11, fontWeight: 600, color: '#fff', background: 'rgba(255,255,255,0.1)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 8, cursor: 'pointer', transition: 'all 0.2s ease' },
  contextDropOverlay: { position: 'absolute', inset: 0, zIndex: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(10,132,255,0.12)', border: '2px dashed rgba(10,132,255,0.7)', borderRadius: 12, backdropFilter: 'blur(2px)', pointerEvents: 'none' },
  contextDropInner: { padding: '14px 28px', fontSize: 15, fontWeight: 700, color: '#fff', background: 'rgba(10,132,255,0.85)', borderRadius: 10, boxShadow: '0 4px 16px rgba(10,132,255,0.3)' },

  // History (used in finish dialog)
  dialogHistoryGrid: { display: 'flex', flexWrap: 'wrap', gap: 12, alignContent: 'flex-start' },
  historyCard: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: 6, background: 'rgba(28,28,30,0.6)', border: '0.5px solid rgba(255,255,255,0.08)', borderRadius: 12, cursor: 'pointer', transition: 'all 0.2s ease' },
  historyImgWrap: { position: 'relative', width: 200, height: 200 },
  historyImg: { width: 200, height: 200, objectFit: 'cover', borderRadius: 8 },
  historyCheck: { position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: '50%', background: '#0a84ff', color: '#fff', fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' },
  historyName: { fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.7)' },

  spinner: { width: 24, height: 24, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.08)', borderTopColor: '#0a84ff', animation: 'spin 1s linear infinite', flexShrink: 0 },

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
