import React, { useEffect, useState, useCallback, useRef } from 'react';
import EditPhase from './components/EditPhase';
import type { Tab, ServerConfig, StatusResponse, DetailerParams, TagPreviews, DebugRecoverData, HistoryItem, InterfaceInfo } from './types';

const POLL_INTERVAL = 500;
const PROMPT_POLL_INTERVAL = 1500;

const App: React.FC = () => {
  const [tab, setTab] = useState<Tab>('mask');
  const tabRef = useRef<Tab>('mask');
  useEffect(() => { tabRef.current = tab; }, [tab]);

  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [maskConfirmed, setMaskConfirmed] = useState(false);
  const [promptReady, setPromptReady] = useState(false);
  const [autoTagging, setAutoTagging] = useState(false);
  const [tagPreviews, setTagPreviews] = useState<TagPreviews | null>(null);
  const [tagResult, setTagResult] = useState<string | null>(null);
  const [debugData, setDebugData] = useState<DebugRecoverData | null>(null);
  const [detailStatus, setDetailStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [detailProgress, setDetailProgress] = useState({ progress: 0, current: 0, total: 0 });
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showFinishDialog, setShowFinishDialog] = useState(false);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [currentContextKey, setCurrentContextKey] = useState<string | null>(null);
  const [blendSelect, setBlendSelect] = useState<{ role: 'background' | 'foreground' } | null>(null);
  const [interfaces, setInterfaces] = useState<InterfaceInfo[]>([]);
  const promptIframeRef = useRef<HTMLIFrameElement>(null);
  const maskIframeRef = useRef<HTMLIFrameElement>(null);
  const blendIframeRef = useRef<HTMLIFrameElement>(null);

  const [params, setParams] = useState<DetailerParams>({
    add_noise: 'enable',
    start_step_rate: 0.8,
    end_step_rate: 1.0,
    pixels: 1048576,
    crop_reserve: 32,
  });

  // Fetch config on mount
  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then((data: ServerConfig) => {
        setConfig(data);
        setParams({
          add_noise: data.add_noise,
          start_step_rate: data.start_step_rate,
          end_step_rate: data.end_step_rate,
          pixels: data.pixels,
          crop_reserve: data.crop_reserve,
        });
        setDetailStatus(data.detail_status);
        setCurrentContextKey(data.current_context_key ?? null);
        if (data.has_package) {
          fetch('/api/package')
            .then(r => r.json())
            .then(pkgData => {
              if (pkgData.interfaces) setInterfaces(pkgData.interfaces);
            })
            .catch(() => {});
        }
      })
      .catch(e => setError('Failed to load config: ' + e.message));
  }, []);

  // Fetch history on mount and when entering context tab
  const refreshHistory = useCallback(() => {
    fetch('/api/history')
      .then(r => r.json())
      .then(data => {
        if (data.history) setHistory(data.history);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { refreshHistory(); }, [refreshHistory]);

  // Load tag previews when entering tag tab
  useEffect(() => {
    if (tab !== 'tag') return;
    // First: get current mask from mask iframe, submit it to main server, then load tag previews
    const iframe = maskIframeRef.current;
    if (iframe?.contentWindow) {
      let resolved = false;
      const maskHandler = (event: MessageEvent) => {
        if (event.data?.type === 'mask-data' && !resolved) {
          resolved = true;
          window.removeEventListener('message', maskHandler);
          const maskData = event.data.mask;
          if (maskData) {
            const brushMode = event.data.brush_mode || 'binary';
            const strength = event.data.strength ?? 1.0;
            const center = event.data.center ?? 1.0;
            const edge = event.data.edge ?? 0.0;
            const gamma = event.data.gamma ?? 2.0;
            fetch('/api/submit_mask', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mask: maskData, brush_mode: brushMode, strength, center, edge, gamma }),
            }).finally(() => {
              fetch('/api/tag_previews')
                .then(r => r.json())
                .then((data: TagPreviews) => {
                  if (data.full || data.mask || data.covered) setTagPreviews(data);
                })
                .catch(e => setError('Failed to load tag previews: ' + e.message));
            });
          } else {
            fetch('/api/tag_previews')
              .then(r => r.json())
              .then((data: TagPreviews) => {
                if (data.full || data.mask || data.covered) setTagPreviews(data);
              })
              .catch(e => setError('Failed to load tag previews: ' + e.message));
          }
        }
      };
      window.addEventListener('message', maskHandler);
      iframe.contentWindow.postMessage({ type: 'get-mask' }, '*');
      // Timeout fallback: if iframe doesn't respond, just load previews with existing mask
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          window.removeEventListener('message', maskHandler);
          fetch('/api/tag_previews')
            .then(r => r.json())
            .then((data: TagPreviews) => {
              if (data.full || data.mask || data.covered) setTagPreviews(data);
            })
            .catch(e => setError('Failed to load tag previews: ' + e.message));
        }
      }, 500);
    } else {
      fetch('/api/tag_previews')
        .then(r => r.json())
        .then((data: TagPreviews) => {
          if (data.full || data.mask || data.covered) setTagPreviews(data);
        })
        .catch(e => setError('Failed to load tag previews: ' + e.message));
    }
  }, [tab]);

  // Listen for postMessage from mask/prompt iframes
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'mask-confirmed') {
        // Mask 不再需要 confirm，直接忽略
      } else if (event.data?.type === 'prompt-confirmed') {
        setPromptReady(true);
        setError(null);
        setTab('draw');
      } else if (event.data?.type === 'blend-select') {
        // Blend iframe requests image selection
        setBlendSelect({ role: event.data.role });
      } else if (event.data?.type === 'blend-data') {
        // Blend iframe returns blend data (bg/fg keys + mask)
        const { bgKey, fgKey, mask } = event.data;
        if (bgKey && fgKey && mask) {
          handleBlend(bgKey, fgKey, mask);
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [config]);

  // Poll mask status — auto-advance to tag/prompt when mask is drawn
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/has_mask');
        const data = await res.json();
        if (!cancelled && data.has_mask && !maskConfirmed) {
          setMaskConfirmed(true);
          // Auto-advance: mask → tag (if tagger) or prompt
          if (tabRef.current === 'mask') {
            setTab(config?.has_tagger ? 'tag' : 'prompt');
          }
        }
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(interval); };
  }, [config, maskConfirmed]);

  // Poll prompt status (fallback)
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/has_prompt');
        const data = await res.json();
        if (!cancelled) setPromptReady(!!data.has_prompt);
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, PROMPT_POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Poll status when in draw tab (running)
  useEffect(() => {
    if ((tab !== 'draw' && tab !== 'interface') || detailStatus !== 'running') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/status');
        const data: StatusResponse = await res.json();
        if (cancelled) return;
        setDetailStatus(data.detail_status);
        setDetailProgress({
          progress: data.progress || 0,
          current: data.current_step || 0,
          total: data.total_steps || 0,
        });
        if (data.detail_status === 'done') {
          refreshHistory();
          // Refresh config to get updated current_context_key
          fetch('/api/config').then(r => r.json()).then((cfg: ServerConfig) => {
            if (!cancelled) setCurrentContextKey(cfg.current_context_key ?? null);
          }).catch(() => {});
        } else if (data.detail_status === 'error') {
          setError(data.error || 'Detailer failed');
        }
      } catch { /* ignore */ }
    };
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(interval); };
  }, [tab, detailStatus, refreshHistory]);

  // Fetch debug data when detail is done
  useEffect(() => {
    if (detailStatus !== 'done') return;
    fetch('/api/debug_recover_data')
      .then(r => r.json())
      .then(data => {
        if (!data.error) setDebugData(data);
      })
      .catch(() => {});
  }, [detailStatus]);

  // Fetch result images when detail is done
  const [resultImages, setResultImages] = useState<{original: string; detailed: string; originalKey: string | null; detailedKey: string | null} | null>(null);
  useEffect(() => {
    if (detailStatus !== 'done') return;
    fetch('/api/result')
      .then(r => r.json())
      .then(data => {
        if (data.original_image && data.detailed_image) {
          setResultImages({
            original: data.original_image,
            detailed: data.detailed_image,
            originalKey: data.original_key ?? null,
            detailedKey: data.detailed_key ?? null,
          });
          // Auto-set context to detailed image after Run Detailer
          setCurrentContextKey(data.current_context_key ?? data.detailed_key ?? null);
        }
      })
      .catch(() => {});
    // Tell mask iframe to reload the new image
    setTimeout(() => {
      const iframe = maskIframeRef.current;
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage({ type: 'reload-image' }, '*');
      }
    }, 200);
  }, [detailStatus]);

  const handleRunTag = useCallback(async (mode: 'mask' | 'covered' | 'full') => {
    setError(null);
    setAutoTagging(true);
    try {
      const res = await fetch('/api/run_tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Tag failed');
        setAutoTagging(false);
        return;
      }
      setTagResult(data.tag);
      // Switch to prompt tab first so iframe is visible, then send tags
      setTab('prompt');
      // Small delay to ensure tab switch + iframe render before postMessage
      setTimeout(() => {
        const iframe = promptIframeRef.current;
        if (iframe?.contentWindow) {
          iframe.contentWindow.postMessage({
            type: 'auto-tag',
            tag: data.tag,
            tags: data.tags || [],
            custom: data.custom || '',
          }, '*');
        }
      }, 100);
    } catch (e: any) {
      setError('Tag error: ' + e.message);
    } finally {
      setAutoTagging(false);
    }
  }, []);

  const handleRunDetailer = useCallback(async () => {
    setError(null);
    setDetailStatus('running');
    setDetailProgress({ progress: 0, current: 0, total: 0 });
    setDebugData(null);
    setResultImages(null);
    try {
      await fetch('/api/run_detailer', { method: 'POST' });
    } catch (e: any) {
      setError('Failed to start detailer: ' + e.message);
      setDetailStatus('idle');
    }
  }, []);

  const handleExecuteInterface = useCallback(async (interfaceIndex: number, manualValues: Record<string, any>) => {
    setError(null);
    setDetailStatus('running');
    setDetailProgress({ progress: 0, current: 0, total: 0 });
    try {
      await fetch('/api/execute_interface', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interface_index: interfaceIndex, manual_values: manualValues }),
      });
    } catch (e: any) {
      setError('Failed to start interface execution: ' + e.message);
      setDetailStatus('idle');
    }
  }, []);

  const handleSelectImage = useCallback(async (key: string) => {
    try {
      await fetch('/api/select_image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      // Reset state for next iteration
      setMaskConfirmed(false);
      setPromptReady(false);
      setTagResult(null);
      setDetailStatus('idle');
      setResultImages(null);
      setDebugData(null);
      setCurrentContextKey(key);
      setTab('mask');
      // Tell mask iframe to reload its image
      setTimeout(() => {
        const iframe = maskIframeRef.current;
        if (iframe?.contentWindow) {
          iframe.contentWindow.postMessage({ type: 'reload-image' }, '*');
        }
      }, 100);
    } catch (e: any) {
      setError('Failed to select image: ' + e.message);
    }
  }, []);

  // Set context without leaving the current tab or resetting Draw results
  const handleSetContext = useCallback(async (key: string) => {
    setCurrentContextKey(key);  // Immediate UI feedback
    try {
      await fetch('/api/select_image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      // Tell mask iframe to reload its image (so mask tab is ready when user switches)
      setTimeout(() => {
        const iframe = maskIframeRef.current;
        if (iframe?.contentWindow) {
          iframe.contentWindow.postMessage({ type: 'reload-image' }, '*');
        }
      }, 100);
    } catch (e: any) {
      setError('Failed to set context: ' + e.message);
    }
  }, []);

  const handleParamChange = useCallback((next: DetailerParams) => {
    setParams(next);
    fetch('/api/update_config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    }).catch(() => {});
  }, []);

  const handleFinishClick = useCallback(() => {
    setShowFinishDialog(true);
  }, []);

  const handleFinish = useCallback(async (selectedKeys?: string[]) => {
    try {
      await fetch('/api/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected_keys: selectedKeys }),
      });
      window.close();
    } catch {
      window.close();
    }
  }, []);

  const handleAddContextImage = useCallback(async (base64: string) => {
    try {
      await fetch('/api/add_context_image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64 }),
      });
      refreshHistory();
    } catch (e: any) {
      setError('Failed to add image: ' + e.message);
    }
  }, [refreshHistory]);

  const handleLoadFromAssets = useCallback(async () => {
    setLoadingAssets(true);
    setError(null);
    try {
      const res = await fetch('/api/load_from_assets', { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Failed to load from assets');
      }
      refreshHistory();
    } catch (e: any) {
      setError('Failed to load from assets: ' + e.message);
    } finally {
      setLoadingAssets(false);
    }
  }, [refreshHistory]);

  const handleBlend = useCallback(async (bgKey: string, fgKey: string, maskBase64: string) => {
    setError(null);
    try {
      const res = await fetch('/api/blend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ background_key: bgKey, foreground_key: fgKey, mask: maskBase64 }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Blend failed');
      }
      refreshHistory();
    } catch (e: any) {
      setError('Blend error: ' + e.message);
    }
  }, [refreshHistory]);

  if (!config) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#888' }}>
        {error || 'Loading...'}
      </div>
    );
  }

  return (
    <div>
      <EditPhase
        tab={tab}
        onTabChange={setTab}
        maskUrl={config.mask_url}
        promptUrl={config.prompt_url}
        maskConfirmed={maskConfirmed}
        promptReady={promptReady}
        autoTagging={autoTagging}
        tagPreviews={tagPreviews}
        tagResult={tagResult}
        debugData={debugData}
        detailStatus={detailStatus}
        detailProgress={detailProgress}
        resultImages={resultImages}
        history={history}
        onRefreshHistory={refreshHistory}
        promptIframeRef={promptIframeRef}
        maskIframeRef={maskIframeRef}
        params={params}
        onParamChange={handleParamChange}
        onRunTag={handleRunTag}
        onRunDetailer={handleRunDetailer}
        onSelectImage={handleSelectImage}
        onFinishClick={handleFinishClick}
        showFinishDialog={showFinishDialog}
        onFinish={handleFinish}
        onCloseFinishDialog={() => setShowFinishDialog(false)}
        onAddContextImage={handleAddContextImage}
        onLoadFromAssets={handleLoadFromAssets}
        loadingAssets={loadingAssets}
        currentContextKey={currentContextKey}
        onSetContext={handleSetContext}
        blendIframeRef={blendIframeRef}
        showBlendSelect={blendSelect}
        onBlendSelectImage={(key, name, src) => {
          if (blendSelect) {
            const iframe = blendIframeRef.current;
            iframe?.contentWindow?.postMessage({
              type: 'blend-image-selected',
              role: blendSelect.role,
              key, name, src,
            }, '*');
          }
          setBlendSelect(null);
        }}
        onCloseBlendSelect={() => setBlendSelect(null)}
        interfaces={interfaces}
        onExecuteInterface={handleExecuteInterface}
      />

      {error && (
        <div style={{
          position: 'fixed',
          top: 12,
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(255, 69, 58, 0.85)',
          color: '#fff',
          padding: '8px 24px',
          borderRadius: 10,
          fontSize: 13,
          fontWeight: 600,
          zIndex: 9999,
          backdropFilter: 'blur(12px)',
          letterSpacing: '0.2px',
          boxShadow: '0 4px 16px rgba(255, 69, 58, 0.25)',
        }}>
          {error}
        </div>
      )}
    </div>
  );
};

export default App;
