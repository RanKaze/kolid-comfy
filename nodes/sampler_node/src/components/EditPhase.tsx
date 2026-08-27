import React, { useState } from 'react';
import { DebugImage, DebugMask, DebugString } from '@kolid/ui-utils';
import type { PipelineBlock, DetailerBlockParams, Tab, TagPreviews, DebugRecoverData, HistoryItem, InterfaceInfo, InterfacePort, PipelinePackageInfo } from '../types';

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

const IOSToggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void }> = ({ checked, onChange }) => (
  <div
    onClick={() => onChange(!checked)}
    style={{
      width: 36, height: 22, borderRadius: 22,
      background: checked ? '#30d158' : '#39393d',
      position: 'relative', transition: 'background 0.2s ease', flexShrink: 0, cursor: 'pointer',
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
  maskUrl: string;
  promptUrl: string;
  maskConfirmed: boolean;
  promptReady: boolean;
  autoTagging: boolean;
  hasTagger: boolean;
  tagPreviews: TagPreviews | null;
  tagResult: string | null;
  debugData: DebugRecoverData | null;
  detailStatus: 'idle' | 'running' | 'done' | 'error';
  detailProgress: { progress: number; current: number; total: number };
  resultImages: { original: string; detailed: string; originalKey: string | null; detailedKey: string | null } | null;
  history: HistoryItem[];
  onRefreshHistory: () => void;
  promptIframeRef: React.RefObject<HTMLIFrameElement>;
  maskIframeRef: React.RefObject<HTMLIFrameElement>;
  blocks: PipelineBlock[];
  /** 当前 pipeline 架构（edit 设置按架构渲染，目前仅 Krea2 提供Enable Edit） */
  architecture: string | null;
  maskGrow: number;
  maskBlur: number;
  onBlocksChange: (blocks: PipelineBlock[]) => void;
  onGlobalParamChange: (key: 'mask_grow' | 'mask_blur', value: number) => void;
  onAddBlock: (type: 'detailer' | 'interface') => void;
  onRemoveBlock: (blockId: string) => void;
  onReorderBlocks: (fromIdx: number, toIdx: number) => void;
  onRunTag: (mode: 'mask' | 'covered' | 'full') => void;
  onRunDetailer: () => void;
  onSelectImage: (key: string) => void;
  onFinishClick: () => void;
  showFinishDialog: boolean;
  onFinish: (selectedKeys?: string[]) => void;
  onCloseFinishDialog: () => void;
  onAddContextImage: (base64: string) => void;
  onLoadFromAssets: () => void;
  loadingAssets: boolean;
  currentContextKey: string | null;
  onSetContext: (key: string) => void;
  blendIframeRef: React.RefObject<HTMLIFrameElement>;
  showBlendSelect: { role: 'background' | 'foreground' } | null;
  onBlendSelectImage: (key: string, name: string, src: string) => void;
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
  tab, onTabChange, maskUrl, promptUrl,
  maskConfirmed, promptReady, autoTagging, hasTagger, tagPreviews, tagResult,
  debugData, detailStatus, detailProgress, resultImages,
  history, onRefreshHistory, promptIframeRef, maskIframeRef,
  blocks, architecture, maskGrow, maskBlur, onBlocksChange, onGlobalParamChange, onAddBlock, onRemoveBlock, onReorderBlocks,
  onRunTag, onRunDetailer, onSelectImage,
  onFinishClick, showFinishDialog, onFinish, onCloseFinishDialog,
  onAddContextImage, onLoadFromAssets, loadingAssets,
  currentContextKey, onSetContext,
  blendIframeRef, showBlendSelect, onBlendSelectImage, onCloseBlendSelect,
  interfaces, onExecuteInterface, interfaceResults, interfaceStatusByIdx, interfaceProgressByIdx,
  pipelinePackages, onSwitchPipeline, currentPipelineKey,
}) => {
  const [hoveredHistory, setHoveredHistory] = useState<HistoryItem | null>(null);
  const [hoveredFinish, setHoveredFinish] = useState<HistoryItem | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [showRefSelect, setShowRefSelect] = useState<string | null>(null);
  const [contextPreview, setContextPreview] = useState<{ image: string; mask: string | null } | null>(null);

  // Fetch context preview when entering draw tab
  React.useEffect(() => {
    if (tab === 'draw') {
      fetch('/api/context_preview')
        .then(r => r.json())
        .then(data => {
          if (data.image) setContextPreview({ image: data.image, mask: data.mask ?? null });
        })
        .catch(() => {});
    }
  }, [tab, currentContextKey, detailStatus]);
  const tabs: { id: Tab; icon: string; color: string }[] = [
    { id: 'mask', icon: 'mask', color: '#ff9f0a' },
    { id: 'tag', icon: 'tag', color: '#af52de' },
    { id: 'prompt', icon: 'prompt', color: '#0a84ff' },
    { id: 'draw', icon: 'draw', color: '#30d158' },
    { id: 'blend', icon: 'blend', color: '#ff9f0a' },
    { id: 'context', icon: 'context', color: '#64d2ff' },
    ...(interfaces.length > 0 ? [{ id: 'interface' as Tab, icon: 'interface', color: '#bf5af2' }] : []),
    ...(pipelinePackages.length > 0 ? [{ id: 'pipeline' as Tab, icon: 'pipeline', color: '#30d158' }] : []),
  ];

  const updateBlockParam = (blockId: string, key: keyof DetailerBlockParams, value: string | number | boolean) => {
    onBlocksChange(blocks.map(b => b.id === blockId ? { ...b, params: { ...b.params, [key]: value } } : b));
  };

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
          {tabs.filter(t => t.id !== 'tag' || hasTagger).map(t => (
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
              {t.id === 'mask' && maskConfirmed && <span style={styles.sidebarDot} />}
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
        {/* Mask — always mounted */}
        <div style={{ ...styles.iframeWrap, display: tab === 'mask' ? 'flex' : 'none' }}>
          <iframe ref={maskIframeRef} src={maskUrl} style={styles.iframe} title="Mask" allow="clipboard-write" />
        </div>

        {/* Tag */}
        {tab === 'tag' && (
          <div style={styles.scrollContent}>
            <div style={styles.tagGrid}>
              <TagCard label="Mask Tag" description="Cropped to mask" image={tagPreviews?.mask} onClick={() => onRunTag('mask')} disabled={autoTagging} />
              <TagCard label="Covered Tag" description="Mask kept, outside white" image={tagPreviews?.covered} onClick={() => onRunTag('covered')} disabled={autoTagging} />
              <TagCard label="Full Tag" description="Full image" image={tagPreviews?.full} onClick={() => onRunTag('full')} disabled={autoTagging} />
            </div>
            {autoTagging && (
              <div style={styles.centerRow}><div style={styles.spinner} /><span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, fontWeight: 600 }}>Running tagger…</span></div>
            )}
            {tagResult && (
              <div style={styles.tagResultBar}>
                <span style={{ color: '#64d2ff', fontSize: 12, fontWeight: 600 }}>Tag:</span>
                <span style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12, marginLeft: 6 }}>{tagResult}</span>
              </div>
            )}
          </div>
        )}

        {/* Prompt — always mounted */}
        <div style={{ ...styles.iframeWrap, display: tab === 'prompt' ? 'flex' : 'none' }}>
          <iframe ref={promptIframeRef} src={promptUrl} style={styles.iframe} title="Prompt" allow="clipboard-write" />
        </div>

        {/* Draw */}
        {tab === 'draw' && (
          <div style={styles.drawLayout}>
            {/* Left: settings */}
            <div style={styles.drawSettingsPanel}>
              {contextPreview && contextPreview.image && (
                <div style={styles.contextPreviewBox}>
                  <div style={styles.sectionTitle}>Context</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ position: 'relative', aspectRatio: '1', borderRadius: 8, overflow: 'hidden', background: '#1a1a1a' }}>
                      <img src={contextPreview.image} alt="Context" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                    </div>
                    <div style={{ position: 'relative', aspectRatio: '1', borderRadius: 8, overflow: 'hidden', background: '#1a1a1a' }}>
                      {contextPreview.mask ? (
                        <img src={contextPreview.mask} alt="Mask" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                      ) : (
                        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.2)', fontSize: 11 }}>No mask</div>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {/* Global params */}
              <div style={styles.sectionTitle}>Mask Settings</div>
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>Mask Grow</label>
                <input style={styles.paramInput} type="number" min={0} max={256} step={1} value={maskGrow} onChange={e => onGlobalParamChange('mask_grow', parseInt(e.target.value))} />
              </div>
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>Mask Blur</label>
                <input style={styles.paramInput} type="number" min={0} max={256} step={1} value={maskBlur} onChange={e => onGlobalParamChange('mask_blur', parseInt(e.target.value))} />
              </div>

              {/* Pipeline Blocks */}
              <div style={styles.sectionTitle}>Pipeline Blocks</div>
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
                      color: block.type === 'detailer' ? '#30d158' : '#bf5af2',
                    }}>{block.name}</span>
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
                    {block.type === 'detailer' && (
                      <>
                        <div style={styles.paramRow}>
                          <label style={styles.paramLabel}>Add Noise</label>
                          <select style={styles.paramSelect} value={block.params.add_noise} onChange={e => updateBlockParam(block.id, 'add_noise', e.target.value)}>
                            <option value="enable" style={{ background: '#1c1c1e', color: '#fff' }}>enable</option>
                            <option value="disable" style={{ background: '#1c1c1e', color: '#fff' }}>disable</option>
                          </select>
                        </div>
                        <div style={styles.paramRow}>
                          <label style={styles.paramLabel}>Start Step</label>
                          <input style={styles.paramInput} type="number" min={0} max={1} step={0.01} value={block.params.start_step_rate} onChange={e => updateBlockParam(block.id, 'start_step_rate', parseFloat(e.target.value))} />
                        </div>
                        <div style={styles.paramRow}>
                          <label style={styles.paramLabel}>End Step</label>
                          <input style={styles.paramInput} type="number" min={0} max={1} step={0.01} value={block.params.end_step_rate} onChange={e => updateBlockParam(block.id, 'end_step_rate', parseFloat(e.target.value))} />
                        </div>
                        <div style={styles.paramRow}>
                          <label style={styles.paramLabel}>Pixels</label>
                          <input style={styles.paramInput} type="number" min={65536} max={16777216} step={65536} value={block.params.pixels} onChange={e => updateBlockParam(block.id, 'pixels', parseInt(e.target.value))} />
                        </div>
                        <div style={styles.paramRow}>
                          <label style={styles.paramLabel}>Align</label>
                          <input style={styles.paramInput} type="number" min={1} max={64} step={1} value={block.params.align} onChange={e => updateBlockParam(block.id, 'align', parseInt(e.target.value))} />
                        </div>
                        <div style={styles.paramRow}>
                          <label style={styles.paramLabel}>Crop Reserve</label>
                          <input style={styles.paramInput} type="number" min={0} max={256} step={1} value={block.params.crop_reserve} onChange={e => updateBlockParam(block.id, 'crop_reserve', parseInt(e.target.value))} />
                        </div>
                        <div style={styles.paramRow}>
                          <label style={styles.paramLabel}>Enable Edit</label>
                          <IOSToggle checked={block.params.enable_edit} onChange={v => updateBlockParam(block.id, 'enable_edit', v)} />
                        </div>
                        {block.params.enable_edit && (
                          <div style={styles.editSubSection}>
                            {isKrea2 && (
                              <div style={styles.paramRow}>
                                <label style={styles.paramLabel}>Edit Mode</label>
                                <select
                                  style={styles.paramSelect}
                                  value={block.params.edit_mode ?? 'fit'}
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
                                    value={block.params.grounding_px ?? 768}
                                    onChange={e => updateBlockParam(block.id, 'grounding_px', parseInt(e.target.value) || 0)} />
                                </div>
                                <div style={styles.paramRow}>
                                  <label style={styles.paramLabel}>Ref Boost</label>
                                  <input style={styles.paramInput} type="number" min={0} max={1000} step={0.1}
                                    title="参考保真度: 最后一个参考（源图）的 target->ref 注意力乘数。>1 拉向参考外观, <1 放松。最优值因模型而异。"
                                    value={block.params.ref_boost ?? 4.0}
                                    onChange={e => updateBlockParam(block.id, 'ref_boost', parseFloat(e.target.value) || 0)} />
                                </div>
                                <div style={styles.paramRow}>
                                  <label style={styles.paramLabel}>Ref Boost A</label>
                                  <input style={styles.paramInput} type="number" min={0} max={1000} step={0.1}
                                    title="第一个参考（场景, 仅多参考如 Context Ref 时生效）的注意力乘数。单参考工作流无效果。"
                                    value={block.params.ref_boost_a ?? 1.0}
                                    onChange={e => updateBlockParam(block.id, 'ref_boost_a', parseFloat(e.target.value) || 0)} />
                                </div>
                                <div style={styles.paramRow} title="启用后以 context mask（当前块裁剪区 mask）限定 ref_boost 增强区域 — 仅 mask 内的参考 token 被增强, 保护 mask 外区域。">
                                  <label style={styles.paramLabel}>Ref Boost Mask</label>
                                  <IOSToggle checked={block.params.enable_ref_boost_mask ?? false}
                                    onChange={v => updateBlockParam(block.id, 'enable_ref_boost_mask', v)} />
                                </div>
                              </>
                            )}
                            <div style={styles.paramRow}>
                              <label style={styles.paramLabel}>Context Ref</label>
                              <IOSToggle checked={block.params.context_reference} onChange={v => updateBlockParam(block.id, 'context_reference', v)} />
                            </div>
                            {block.params.context_reference && (
                              <div style={styles.paramRow}>
                                <label style={styles.paramLabel}>Ref Image</label>
                                <button style={styles.contextLoadBtn} onClick={() => setShowRefSelect(block.id)}>
                                  {block.params.context_reference_key
                                    ? (history.find(h => h.key === block.params.context_reference_key)?.name ?? 'Selected')
                                    : 'Select'}
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}
                    {block.type === 'interface' && (
                      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', padding: '4px 0' }}>
                        Interface block — executes sub-graph (coming soon)
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {/* Add block buttons — bottom */}
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button style={{
                  flex: 1, padding: '8px 0', borderRadius: 8,
                  background: 'rgba(48,209,88,0.1)', border: '0.5px solid rgba(48,209,88,0.2)',
                  color: '#30d158', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }} onClick={() => onAddBlock('detailer')}>+ Detailer</button>
                <button style={{
                  flex: 1, padding: '8px 0', borderRadius: 8,
                  background: 'rgba(191,90,242,0.1)', border: '0.5px solid rgba(191,90,242,0.2)',
                  color: '#bf5af2', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }} onClick={() => onAddBlock('interface')}>+ Interface</button>
              </div>
            </div>

            {/* Right: status / results / run button */}
            <div style={styles.drawMainArea}>
              {detailStatus === 'running' && (
                <div style={styles.drawStatusCenter}>
                  <div style={styles.spinner} />
                  <div style={{ fontSize: 17, fontWeight: 700, color: '#fff' }}>Running Detailer</div>
                  {detailProgress.total > 0 && (
                    <>
                      <div style={styles.progressBarTrack}>
                        <div style={{ ...styles.progressBarFill, width: `${detailProgress.progress * 100}%` }} />
                      </div>
                      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
                        Step {detailProgress.current} / {detailProgress.total}
                      </div>
                    </>
                  )}
                </div>
              )}

              {detailStatus === 'error' && (
                <div style={styles.drawStatusCenter}>
                  <div style={{ fontSize: 17, fontWeight: 700, color: '#ff453a' }}>Error</div>
                </div>
              )}

              {detailStatus === 'done' && resultImages && (
                <div style={styles.resultGrid}>
                  {(() => {
                    const origKey = resultImages.originalKey;
                    const origActive = origKey === currentContextKey;
                    return (
                      <div
                        style={{
                          ...styles.resultCard,
                          borderColor: origActive ? '#0a84ff' : 'rgba(255,255,255,0.08)',
                          boxShadow: origActive ? '0 0 0 2px rgba(10,132,255,0.3)' : 'none',
                          cursor: origKey && !origActive ? 'pointer' : 'default',
                        }}
                        onClick={() => origKey && !origActive && onSetContext(origKey)}
                      >
                        <div style={styles.resultLabel}>Original</div>
                        <img src={resultImages.original} alt="Original" style={styles.resultImg} />
                      </div>
                    );
                  })()}
                  {(() => {
                    const detKey = resultImages.detailedKey;
                    const detActive = detKey === currentContextKey;
                    return (
                      <div
                        style={{
                          ...styles.resultCard,
                          borderColor: detActive ? '#0a84ff' : 'rgba(255,255,255,0.08)',
                          boxShadow: detActive ? '0 0 0 2px rgba(10,132,255,0.3)' : 'none',
                          cursor: detKey && !detActive ? 'pointer' : 'default',
                        }}
                        onClick={() => detKey && !detActive && onSetContext(detKey)}
                      >
                        <div style={styles.resultLabel}>Detailed</div>
                        <img src={resultImages.detailed} alt="Detailed" style={styles.resultImg} />
                      </div>
                    );
                  })()}
                </div>
              )}

              {detailStatus === 'done' && debugData && (
                <div style={styles.debugPanel}>
                  <div style={{ ...styles.resultLabel, marginBottom: 8 }}>Debug</div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    <DebugImage src={debugData.background} label="Background" />
                    <DebugImage src={debugData.image} label="Image" />
                    <DebugMask src={debugData.mask} label="Mask" />
                    {debugData.reference_images && debugData.reference_images.map((ref, i) => (
                      <DebugImage key={i} src={ref.src} label={ref.name} />
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                    <DebugString label="crop_x" value={debugData.crop_x} />
                    <DebugString label="crop_y" value={debugData.crop_y} />
                    <DebugString label="crop_w" value={debugData.crop_width} />
                    <DebugString label="crop_h" value={debugData.crop_height} />
                  </div>
                </div>
              )}

              {/* Run button bottom-right */}
              <div style={styles.runBtnWrap}>
                <button
                  style={{ ...styles.runBtn, opacity: detailStatus === 'running' ? 0.4 : 1, cursor: detailStatus === 'running' ? 'not-allowed' : 'pointer' }}
                  onClick={onRunDetailer}
                  disabled={detailStatus === 'running'}
                >
                  {detailStatus === 'running' ? 'Running…' : 'Run Detailer'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Blend — iframe-based blend page with live preview */}
        {tab === 'blend' && (
          <BlendTab history={history} blendIframeRef={blendIframeRef} showBlendSelect={showBlendSelect} onBlendSelectImage={onBlendSelectImage} onCloseBlendSelect={onCloseBlendSelect} />
        )}

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
          <div style={styles.contextLayout}>
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
          </div>
        )}
      </div>

      {/* Reference image select modal */}
      {showRefSelect && (() => {
        const cur = history.find(h => h.key === currentContextKey);
        const cw = cur?.width, ch = cur?.height;
        const eligible = history.filter(h => h.key !== currentContextKey &&
          (!cw || !ch || (h.width === cw && h.height === ch)));
        return (
          <div style={styles.overlay}>
            <div style={styles.dialog}>
              <div style={styles.dialogTitle}>Select Reference Image{cw && ch ? ' (' + cw + 'x' + ch + ')' : ''}</div>
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
    </div>
  );
};

// ── BlendTab ──
const BlendTab: React.FC<{
  history: HistoryItem[];
  blendIframeRef: React.RefObject<HTMLIFrameElement>;
  showBlendSelect: { role: 'background' | 'foreground' } | null;
  onBlendSelectImage: (key: string, name: string, src: string) => void;
  onCloseBlendSelect: () => void;
}> = ({ history, blendIframeRef, showBlendSelect, onBlendSelectImage, onCloseBlendSelect }) => {
  return (
    <>
      <iframe ref={blendIframeRef} src="/blend_node.html" style={{ width: '100%', height: '100%', border: 'none', background: '#0d0d0d' }} title="Blend" allow="clipboard-write" />
      {/* Image selection modal */}
      {showBlendSelect && (
        <div style={styles.overlay}>
          <div style={styles.dialog}>
            <div style={styles.dialogTitle}>Select {showBlendSelect.role === 'background' ? 'Background' : 'Foreground'}</div>
            <div style={styles.dialogHistoryGrid}>
              {history.map(h => (
                <button key={h.key} style={styles.historyCard} onClick={() => {
                  onBlendSelectImage(h.key, h.name, h.src);
                }}>
                  <div style={styles.historyImgWrap}>
                    <img src={h.src} alt={h.name} style={styles.historyImg} />
                  </div>
                  <div style={styles.historyName}>{h.name}</div>
                </button>
              ))}
            </div>
            <div style={styles.dialogActions}>
              <button style={styles.cancelBtn} onClick={onCloseBlendSelect}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

const TagCard: React.FC<{ label: string; description: string; image?: string; onClick: () => void; disabled: boolean }> = ({ label, description, image, onClick, disabled }) => (
  <button style={{ ...styles.tagCard, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }} onClick={onClick} disabled={disabled}>
    <div style={styles.tagCardImageWrap}>
      {image ? <img src={image} alt={label} style={styles.tagCardImage} /> : <div style={styles.tagCardPlaceholder}>No preview</div>}
    </div>
    <div style={styles.tagCardLabel}>{label}</div>
    <div style={styles.tagCardDesc}>{description}</div>
  </button>
);

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
  scrollContent: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 },

  // Tag cards — flex:1 equal width
  tagGrid: { display: 'flex', gap: 12 },
  tagCard: {
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: 8,
    background: 'rgba(28,28,30,0.6)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12,
    cursor: 'pointer', transition: 'all 0.2s ease', textAlign: 'center',
  },
  tagCardImageWrap: { width: '100%', aspectRatio: '1', borderRadius: 8, overflow: 'hidden', background: '#1a1a1a', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  tagCardImage: { width: '100%', height: '100%', objectFit: 'contain' },
  tagCardPlaceholder: { fontSize: 10, color: 'rgba(255,255,255,0.3)', fontWeight: 500 },
  tagCardLabel: { fontSize: 12, fontWeight: 700, color: '#fff' },
  tagCardDesc: { fontSize: 10, fontWeight: 500, color: 'rgba(255,255,255,0.4)' },

  centerRow: { display: 'flex', alignItems: 'center', gap: 8 },
  tagResultBar: { display: 'flex', alignItems: 'center', background: 'rgba(100,210,255,0.08)', padding: '8px 14px', borderRadius: 8, border: '1px solid rgba(100,210,255,0.15)' },

  // Draw tab layout: left settings + right main area
  drawLayout: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row' },
  drawSettingsPanel: {
    width: 260, flexShrink: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
    background: 'rgba(28,28,30,0.4)', borderRight: '0.5px solid rgba(255,255,255,0.06)', overflowY: 'auto',
  },
  sectionTitle: { fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 },
  contextPreviewBox: { marginBottom: 12 },
  contextPreviewWrap: { position: 'relative', width: '100%', aspectRatio: '1', borderRadius: 8, overflow: 'hidden', background: '#1a1a1a' },
  ctxPreviewImg: { width: '100%', height: '100%', objectFit: 'cover' },
  ctxPreviewMask: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' },
  paramRow: { display: 'flex', alignItems: 'center', gap: 8 },
  paramLabel: { fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.6)', minWidth: 80 },
  paramSelect: { flex: 1, background: 'rgba(255,255,255,0.06)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: '0.5px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '6px 12px', color: '#fff', fontSize: 13, outline: 'none', colorScheme: 'dark', WebkitAppearance: 'none', appearance: 'none', backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\' viewBox=\'0 0 10 6\' fill=\'none\'%3E%3Cpath d=\'M1 1L5 5L9 1\' stroke=\'rgba(255,255,255,0.4)\' stroke-width=\'1.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 28, transition: 'background 0.15s ease, border-color 0.15s ease' } as React.CSSProperties,
  paramInput: { flex: 1, background: 'rgba(255,255,255,0.08)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '5px 10px', color: '#fff', fontSize: 13, outline: 'none', fontVariantNumeric: 'tabular-nums' },

  editSubSection: { marginLeft: 8, paddingLeft: 10, borderLeft: '0.5px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: 10 },
  drawMainArea: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 16, position: 'relative', overflowY: 'auto' },

  drawStatusCenter: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 },

  // Progress bar — iOS style
  progressBarTrack: { width: 280, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' },
  progressBarFill: { height: '100%', borderRadius: 3, background: '#0a84ff', transition: 'width 0.3s ease' },

  resultGrid: { display: 'flex', gap: 12, flex: 1, minHeight: 0, flexWrap: 'nowrap' },
  resultCard: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0, background: 'rgba(28,28,30,0.6)', borderRadius: 12, padding: 8, border: '0.5px solid rgba(255,255,255,0.08)' },
  resultLabel: { fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.6)' },
  resultImg: { width: '100%', flex: 1, minHeight: 0, objectFit: 'contain', borderRadius: 8 },

  debugPanel: { background: 'rgba(28,28,30,0.6)', borderRadius: 12, padding: 12, border: '0.5px solid rgba(255,69,58,0.15)', marginTop: 12 },

  // Run button — bottom right
  runBtnWrap: { position: 'absolute', bottom: 16, right: 16, },
  runBtn: {
    padding: '10px 28px', fontSize: 14, fontWeight: 700, color: '#fff',
    background: 'rgba(48,209,88,0.85)', border: 'none', borderRadius: 10, cursor: 'pointer',
    transition: 'all 0.2s ease', letterSpacing: '0.3px',
    boxShadow: '0 2px 12px rgba(48,209,88,0.2)',
  },

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
