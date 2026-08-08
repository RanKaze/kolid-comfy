import React, { useState } from 'react';
import { DebugImage, DebugMask, DebugString } from '@kolid/ui-utils';
import type { DetailerParams, Tab, TagPreviews, DebugRecoverData, HistoryItem, InterfaceInfo, InterfacePort } from '../types';

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
  params: DetailerParams;
  onParamChange: (params: DetailerParams) => void;
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
  interfaceResults: HistoryItem[];
}

const EditPhase: React.FC<EditPhaseProps> = ({
  tab, onTabChange, maskUrl, promptUrl,
  maskConfirmed, promptReady, autoTagging, hasTagger, tagPreviews, tagResult,
  debugData, detailStatus, detailProgress, resultImages,
  history, onRefreshHistory, promptIframeRef, maskIframeRef,
  params, onParamChange, onRunTag, onRunDetailer, onSelectImage,
  onFinishClick, showFinishDialog, onFinish, onCloseFinishDialog,
  onAddContextImage, onLoadFromAssets, loadingAssets,
  currentContextKey, onSetContext,
  blendIframeRef, showBlendSelect, onBlendSelectImage, onCloseBlendSelect,
  interfaces, onExecuteInterface, interfaceResults,
}) => {
  const [hoveredHistory, setHoveredHistory] = useState<HistoryItem | null>(null);
  const [hoveredFinish, setHoveredFinish] = useState<HistoryItem | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [showRefSelect, setShowRefSelect] = useState(false);
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
  const tabs: { id: Tab; label: string; color: string }[] = [
    { id: 'mask', label: 'Mask', color: '#ff9f0a' },
    { id: 'tag', label: 'Tag', color: '#af52de' },
    { id: 'prompt', label: 'Prompt', color: '#0a84ff' },
    { id: 'draw', label: 'Draw', color: '#30d158' },
    { id: 'blend', label: 'Blend', color: '#ff9f0a' },
    { id: 'context', label: 'Context', color: '#64d2ff' },
    ...(interfaces.length > 0 ? [{ id: 'interface' as Tab, label: 'Interface', color: '#bf5af2' }] : []),
  ];

  const updateParam = (key: keyof DetailerParams, value: string | number | boolean) => {
    onParamChange({ ...params, [key]: value });
  };

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
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.tabBar}>
          {tabs.filter(t => t.id !== 'tag' || hasTagger).map(t => (
            <button
              key={t.id}
              style={{
                ...styles.tabBtn,
                color: tab === t.id ? t.color : 'rgba(255,255,255,0.35)',
              }}
              onClick={() => {
                if (t.id === 'context') onRefreshHistory();
                onTabChange(t.id);
              }}
            >
              {t.label}
              {t.id === 'mask' && maskConfirmed && <span style={styles.dot}>●</span>}
              {t.id === 'prompt' && promptReady && <span style={styles.dot}>●</span>}
              {t.id === 'draw' && detailStatus === 'done' && <span style={styles.dot}>●</span>}
            </button>
          ))}
        </div>
        <button style={styles.finishBtn} onClick={onFinishClick}>Finish</button>
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
                      <img src={contextPreview.image} alt="Context" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </div>
                    <div style={{ position: 'relative', aspectRatio: '1', borderRadius: 8, overflow: 'hidden', background: '#1a1a1a' }}>
                      {contextPreview.mask ? (
                        <img src={contextPreview.mask} alt="Mask" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.2)', fontSize: 11 }}>No mask</div>
                      )}
                    </div>
                  </div>
                </div>
              )}
              <div style={styles.sectionTitle}>Sampling Parameters</div>
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>Add Noise</label>
                <select style={styles.paramSelect} value={params.add_noise} onChange={e => updateParam('add_noise', e.target.value)}>
                  <option value="enable">enable</option>
                  <option value="disable">disable</option>
                </select>
              </div>
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>Start Step</label>
                <input style={styles.paramInput} type="number" min={0} max={1} step={0.01} value={params.start_step_rate} onChange={e => updateParam('start_step_rate', parseFloat(e.target.value))} />
              </div>
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>End Step</label>
                <input style={styles.paramInput} type="number" min={0} max={1} step={0.01} value={params.end_step_rate} onChange={e => updateParam('end_step_rate', parseFloat(e.target.value))} />
              </div>
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>Pixels</label>
                <input style={styles.paramInput} type="number" min={65536} max={16777216} step={65536} value={params.pixels} onChange={e => updateParam('pixels', parseInt(e.target.value))} />
              </div>
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>Align</label>
                <input style={styles.paramInput} type="number" min={1} max={64} step={1} value={params.align} onChange={e => updateParam('align', parseInt(e.target.value))} />
              </div>
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>Crop Reserve</label>
                <input style={styles.paramInput} type="number" min={0} max={256} step={1} value={params.crop_reserve} onChange={e => updateParam('crop_reserve', parseInt(e.target.value))} />
              </div>
              <div style={styles.paramRow}>
                <label style={styles.paramLabel}>Enable Edit</label>
                <IOSToggle checked={params.enable_edit} onChange={v => updateParam('enable_edit', v)} />
              </div>
              {params.enable_edit && (
                <div style={styles.editSubSection}>
                  <div style={styles.paramRow}>
                    <label style={styles.paramLabel}>Context Reference</label>
                    <IOSToggle checked={params.context_reference} onChange={v => updateParam('context_reference', v)} />
                  </div>
                  {params.context_reference && (
                    <div style={styles.paramRow}>
                      <label style={styles.paramLabel}>Reference Image</label>
                      <button style={styles.contextLoadBtn} onClick={() => setShowRefSelect(true)}>
                        {params.context_reference_key
                          ? (history.find(h => h.key === params.context_reference_key)?.name ?? 'Selected')
                          : 'Select'}
                      </button>
                    </div>
                  )}
                </div>
              )}
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
          <InterfaceTab interfaces={interfaces} detailStatus={detailStatus} detailProgress={detailProgress} onExecuteInterface={onExecuteInterface} interfaceResults={interfaceResults} currentContextKey={currentContextKey} onSetContext={onSetContext} history={history} />
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
              <div style={styles.dialogTitle}>Select Reference Image{cw && ch ? ` (${cw}×${ch})` : ''}</div>
              {eligible.length === 0 ? (
                <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 13, padding: 12 }}>No eligible images available.</div>
              ) : (
                <div style={styles.dialogHistoryGrid}>
                  {eligible.map(h => (
                    <button key={h.key} style={styles.historyCard} onClick={() => {
                      updateParam('context_reference_key', h.key);
                      setShowRefSelect(false);
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
                <button style={styles.cancelBtn} onClick={() => setShowRefSelect(false)}>Cancel</button>
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
                        {selectedKeys.has(h.key) && <div style={styles.historyCheck}>✓</div>}
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
  detailStatus: 'idle' | 'running' | 'done' | 'error';
  detailProgress: { progress: number; current: number; total: number };
  onExecuteInterface: (interfaceIndex: number, manualValues: Record<string, any>, execOptions?: Record<string, any>) => void;
  interfaceResults: HistoryItem[];
  currentContextKey: string | null;
  onSetContext: (key: string) => void;
  history: HistoryItem[];
}> = ({ interfaces, detailStatus, detailProgress, onExecuteInterface, interfaceResults, currentContextKey, onSetContext, history }) => {
  const [manualValues, setManualValues] = useState<Record<number, Record<string, any>>>({});
  // 每个 interface 的执行选项
  const [execOptions, setExecOptions] = useState<Record<number, { image_source: 'default' | 'select'; image_source_key: string | null; operation: 'default' | 'crop'; crop_reserve: number }>>({});
  const [showImageSelect, setShowImageSelect] = useState<number | null>(null);

  if (interfaces.length === 0) {
    return <div style={{ padding: 20, color: 'rgba(255,255,255,0.3)', fontSize: 14 }}>No interfaces connected.</div>;
  }

  const updateOpts = (idx: number, patch: Partial<typeof execOptions[number]>) => {
    setExecOptions(prev => ({ ...prev, [idx]: { ...prev[idx], ...patch } }));
  };

  const handleExecute = (idx: number) => {
    const opts = execOptions[idx] || { image_source: 'default', image_source_key: null, operation: 'default', crop_reserve: 32 };
    const payload = {
      operation: opts.operation,
      crop_reserve: opts.crop_reserve,
      image_source_key: opts.image_source === 'select' ? opts.image_source_key : null,
    };
    onExecuteInterface(idx, manualValues[idx] || {}, payload);
  };

  const showProgress = detailStatus === 'running' && detailProgress.total > 0;

  const renderPort = (port: InterfacePort, idx: number, isStart: boolean) => {
    const mv = manualValues[idx]?.[String(port.num)] ?? port.value ?? '';
    const cat = port.category;
    const badgeColor = cat === 'inject' ? 'rgba(48,209,88,0.15)' : cat === 'manual' ? 'rgba(10,132,255,0.15)' : 'rgba(255,255,255,0.08)';
    const badgeText = cat === 'inject' ? '#30d158' : cat === 'manual' ? '#0a84ff' : 'rgba(255,255,255,0.3)';
    const label = cat === 'inject' ? '(inject)' : cat === 'manual' ? '(widget)' : '(port)';

    return (
      <div key={port.num} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
        {/* Port name */}
        <div style={{ minWidth: 80, fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>{port.name}</div>
        {/* Type badge */}
        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: badgeColor, color: badgeText, minWidth: 70, textAlign: 'center' }}>
          {port.type}
        </span>
        {/* Category label */}
        <span style={{ fontSize: 10, color: badgeText, fontWeight: 500, minWidth: 50 }}>{label}</span>

        {/* Input controls for manual types */}
        {isStart && port.type === 'STRING' && (
          <input style={{ flex: 1, background: 'rgba(255,255,255,0.08)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '4px 8px', color: '#fff', fontSize: 12, outline: 'none' }}
            value={mv} onChange={e => setManualValues(prev => ({ ...prev, [idx]: { ...prev[idx], [String(port.num)]: e.target.value } }))} />
        )}
        {isStart && port.type === 'INT' && (
          <input type="number" style={{ flex: 1, background: 'rgba(255,255,255,0.08)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '4px 8px', color: '#fff', fontSize: 12, outline: 'none' }}
            value={mv} onChange={e => setManualValues(prev => ({ ...prev, [idx]: { ...prev[idx], [String(port.num)]: parseInt(e.target.value) || 0 } }))} />
        )}
        {isStart && port.type === 'FLOAT' && (
          <input type="number" step="0.01" style={{ flex: 1, background: 'rgba(255,255,255,0.08)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '4px 8px', color: '#fff', fontSize: 12, outline: 'none' }}
            value={mv} onChange={e => setManualValues(prev => ({ ...prev, [idx]: { ...prev[idx], [String(port.num)]: parseFloat(e.target.value) || 0 } }))} />
        )}
        {isStart && port.type === 'BOOLEAN' && (
          <input type="checkbox" checked={!!mv} onChange={e => setManualValues(prev => ({ ...prev, [idx]: { ...prev[idx], [String(port.num)]: e.target.checked } }))} />
        )}

        {/* Inject label for auto types */}
        {isStart && cat === 'inject' && (
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
            {port.type === 'MASK' ? '← Mask' : port.type === 'IMAGE' ? '← Context Image' : '← Pipeline'}
          </span>
        )}

        {/* Value preview for IMAGE/MASK */}
        {port.value && (port.type === 'IMAGE' || port.type === 'MASK') && typeof port.value === 'string' && (
          <img src={port.value} alt={port.name} style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 4 }} />
        )}

        {/* Pipeline indicator */}
        {port.type === 'PIPELINE_DATA' && port.value && typeof port.value === 'object' && port.value.has_pipeline && (
          <span style={{ fontSize: 10, color: '#30d158' }}>✓ has data</span>
        )}

        {/* Not connected */}
        {port.type === 'NONE' && <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>Not connected</span>}
      </div>
    );
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {interfaces.map((iface, idx) => (
        <div key={idx} style={{ background: 'rgba(28,28,30,0.6)', borderRadius: 12, padding: 16, border: '0.5px solid rgba(255,255,255,0.08)' }}>
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

          {/* 注入选项：图片来源 + 执行方式 + crop_reserve */}
          {iface.start_ports && iface.start_ports.some(p => p.type === 'IMAGE' || p.type === 'MASK') && (
            <div style={{ marginBottom: 12, padding: 10, background: 'rgba(10,132,255,0.06)', borderRadius: 8, border: '0.5px solid rgba(10,132,255,0.15)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(100,210,255,0.6)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Injection Options</div>

              {/* 图片来源 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.6)', minWidth: 70 }}>Image</label>
                <select
                  style={styles.paramSelect}
                  value={execOptions[idx]?.image_source ?? 'default'}
                  onChange={e => updateOpts(idx, { image_source: e.target.value as 'default' | 'select', ...(e.target.value === 'default' ? { image_source_key: null } : {}) })}
                >
                  <option value="default">默认 (Context)</option>
                  <option value="select">从 Context 选择</option>
                </select>
                {execOptions[idx]?.image_source === 'select' && (
                  <button style={styles.contextLoadBtn} onClick={() => setShowImageSelect(idx)}>
                    {execOptions[idx]?.image_source_key ? '更换图片' : '选择图片'}
                  </button>
                )}
              </div>

              {/* 操作 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.6)', minWidth: 70 }}>Operation</label>
                <select style={styles.paramSelect} value={execOptions[idx]?.operation ?? 'default'} onChange={e => updateOpts(idx, { operation: e.target.value as 'default' | 'crop' })}>
                  <option value="default">默认 (整图)</option>
                  <option value="crop">Crop Mask 区域</option>
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

          {detailStatus === 'running' && (
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={styles.spinner} />
              <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, fontWeight: 600 }}>Running…</span>
              {showProgress && <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>{detailProgress.current} / {detailProgress.total}</span>}
            </div>
          )}
          {detailStatus === 'done' && interfaceResults.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Results</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {interfaceResults.map(r => {
                  const active = r.key === currentContextKey;
                  return (
                    <div
                      key={r.key}
                      style={{
                        ...styles.resultCard,
                        width: 160, flex: 'none',
                        borderColor: active ? '#0a84ff' : 'rgba(255,255,255,0.08)',
                        boxShadow: active ? '0 0 0 2px rgba(10,132,255,0.3)' : 'none',
                        cursor: active ? 'default' : 'pointer',
                      }}
                      onClick={() => !active && onSetContext(r.key)}
                    >
                      <div style={styles.resultLabel}>{r.name}</div>
                      <img src={r.src} alt={r.name} style={{ width: '100%', height: 120, objectFit: 'cover', borderRadius: 8 }} />
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>Click a card to set as context</div>
            </div>
          )}
          {detailStatus === 'done' && interfaceResults.length === 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>✓ Done — no images generated</div>
          )}
          {detailStatus === 'error' && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#ff453a', fontWeight: 600 }}>✗ Error</div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button
              style={{ ...styles.runBtn, opacity: detailStatus === 'running' ? 0.4 : 1, cursor: detailStatus === 'running' ? 'not-allowed' : 'pointer' }}
              onClick={() => handleExecute(idx)}
              disabled={detailStatus === 'running'}
            >
              {detailStatus === 'running' ? 'Running…' : 'Execute'}
            </button>
          </div>
        </div>
      ))}

      {/* 从 Context 选择图片 modal — 只显示与当前 context 图同尺寸的图 */}
      {showImageSelect !== null && (() => {
        const cur = history.find(h => h.key === currentContextKey);
        const cw = cur?.width, ch = cur?.height;
        const eligible = history.filter(h => h.key !== currentContextKey && h.key !== (execOptions[showImageSelect]?.image_source_key ?? null) &&
          cw && ch && h.width === cw && h.height === ch);
        return (
          <div style={styles.overlay}>
            <div style={styles.dialog}>
              <div style={styles.dialogTitle}>Select Image (same size as context: {cw}×{ch})</div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginBottom: 12 }}>
                Only images matching current context dimensions ({cw}×{ch}) can be validly masked.
              </div>
              {eligible.length === 0 ? (
                <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 13, padding: 12 }}>No same-size images available. Load images of matching dimensions in Context tab first.</div>
              ) : (
                <div style={styles.dialogHistoryGrid}>
                  {eligible.map(h => (
                    <button key={h.key} style={styles.historyCard} onClick={() => {
                      updateOpts(showImageSelect, { image_source_key: h.key });
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

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100vh', background: '#0d0d0d', fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif" },

  // Header — iOS style segmented control feel
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0 16px', height: 48, flexShrink: 0,
    background: 'rgba(28,28,30,0.72)', backdropFilter: 'blur(20px) saturate(180%)', WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    borderBottom: '0.5px solid rgba(255,255,255,0.08)',
  },
  tabBar: { display: 'flex', alignItems: 'center', gap: 0, height: '100%' },
  tabBtn: {
    padding: '0 16px', fontSize: 14, fontWeight: 600, background: 'transparent', border: 'none',
    cursor: 'pointer', transition: 'color 0.2s ease', display: 'flex', alignItems: 'center', gap: 5,
    height: '100%', letterSpacing: '0.2px',
  },
  dot: { color: '#30d158', fontSize: 7 },
  finishBtn: {
    padding: '6px 18px', fontSize: 13, fontWeight: 600, color: '#fff',
    background: 'rgba(48,209,88,0.85)', border: 'none', borderRadius: 8, cursor: 'pointer',
    transition: 'all 0.2s ease', letterSpacing: '0.3px',
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
  tagCardImage: { width: '100%', height: '100%', objectFit: 'cover' },
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
  paramSelect: { flex: 1, background: 'rgba(255,255,255,0.08)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '5px 10px', color: '#fff', fontSize: 13, outline: 'none' },
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
