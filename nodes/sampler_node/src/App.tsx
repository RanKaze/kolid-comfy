import React, { useEffect, useState, useCallback, useRef } from 'react';
import EditPhase from './components/EditPhase';
import type { Tab, ServerConfig, StatusResponse, DetailerParams, TagPreviews, DebugRecoverData, HistoryItem, InterfaceInfo, PipelinePackageInfo } from './types';

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
  const [interfaceStatus, setInterfaceStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [interfaceProgress, setInterfaceProgress] = useState({ progress: 0, current: 0, total: 0 });
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showFinishDialog, setShowFinishDialog] = useState(false);
  const [finished, setFinished] = useState(false);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [syncingTab, setSyncingTab] = useState(false);
  const syncingTabRef = useRef(false);
  useEffect(() => { syncingTabRef.current = syncingTab; }, [syncingTab]);
  // Track whether the latest mask-confirmed/prompt-confirmed was consumed by handleTabChange sync
  const consumedMaskConfirmedRef = useRef(false);
  const consumedPromptConfirmedRef = useRef(false);
  const [currentContextKey, setCurrentContextKey] = useState<string | null>(null);
  const [blendSelect, setBlendSelect] = useState<{ role: 'background' | 'foreground' } | null>(null);
  const [interfaces, setInterfaces] = useState<InterfaceInfo[]>([]);
  const [pipelinePackages, setPipelinePackages] = useState<PipelinePackageInfo[]>([]);
  const [currentPipelineKey, setCurrentPipelineKey] = useState<string | null>(null);
  const [executedInterfaceIdx, setExecutedInterfaceIdx] = useState<number | null>(null);
  const [interfaceResults, setInterfaceResults] = useState<Record<number, HistoryItem[]>>({});
  const promptIframeRef = useRef<HTMLIFrameElement>(null);
  const maskIframeRef = useRef<HTMLIFrameElement>(null);
  const blendIframeRef = useRef<HTMLIFrameElement>(null);

  const [params, setParams] = useState<DetailerParams>({
    add_noise: 'enable',
    start_step_rate: 0.8,
    end_step_rate: 1.0,
    pixels: 1048576,
    align: 8,
    crop_reserve: 32,
    mask_grow: 32,
    mask_blur: 32,
    enable_edit: false,
    context_reference: false,
    context_reference_key: null,
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
          align: data.align,
          crop_reserve: data.crop_reserve,
          mask_grow: data.mask_grow,
          mask_blur: data.mask_blur,
          enable_edit: data.enable_edit,
          context_reference: data.context_reference,
          context_reference_key: data.context_reference_key,
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
        if (data.has_pipeline_package) {
          fetch('/api/pipeline_package')
            .then(r => r.json())
            .then(pkgData => {
              if (pkgData.pipeline_packages) setPipelinePackages(pkgData.pipeline_packages);
            })
            .catch(() => {});
        }
      })
      .catch(e => setError('Failed to load config: ' + e.message));
  }, []);

  // Fetch history on mount and when entering context tab
  const refreshHistory = useCallback((): Promise<void> => {
    return fetch('/api/history')
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
    // Mask is already synced via handleTabChange → sync-mask → handleMask
    // Just load tag previews using the synced mask
    fetch('/api/tag_previews')
      .then(r => r.json())
      .then((data: TagPreviews) => {
        if (data.full || data.mask || data.covered) setTagPreviews(data);
      })
      .catch(e => setError('Failed to load tag previews: ' + e.message));
  }, [tab]);

  const handleTabChange = useCallback((newTab: Tab) => {
    const needMaskSync = tab === 'mask' && newTab !== 'mask';
    const needPromptSync = tab === 'prompt' && newTab !== 'prompt';
    if (!needMaskSync && !needPromptSync) {
      setTab(newTab);
      return;
    }
    setSyncingTab(true);
    const targetTab = newTab;
    let syncDone = false;
    const checkSyncDone = (event: MessageEvent) => {
      const done = (needMaskSync && event.data?.type === 'mask-confirmed') ||
                   (needPromptSync && event.data?.type === 'prompt-synced');
      if (!done) return;
      syncDone = true;
      window.removeEventListener('message', checkSyncDone);
      setSyncingTab(false);
      // Mark that this mask-confirmed/prompt-confirmed was consumed by sync
      if (needMaskSync) consumedMaskConfirmedRef.current = true;
      if (needPromptSync) consumedPromptConfirmedRef.current = true;
      setTab(targetTab);
    };
    window.addEventListener('message', checkSyncDone);
    if (needMaskSync) {
      const iframe = maskIframeRef.current;
      if (iframe?.contentWindow) iframe.contentWindow.postMessage({ type: 'sync-mask' }, '*');
    }
    if (needPromptSync) {
      const iframe = promptIframeRef.current;
      if (iframe?.contentWindow) iframe.contentWindow.postMessage({ type: 'sync-prompt' }, '*');
    }
    // Timeout fallback
    setTimeout(() => {
      if (syncDone) return;
      window.removeEventListener('message', checkSyncDone);
      setSyncingTab(false);
      setTab(targetTab);
    }, 3000);
  }, [tab]);

  // Listen for postMessage from mask/prompt iframes
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'mask-confirmed') {
        setMaskConfirmed(true);
        // Skip auto-advance if this was consumed by handleTabChange sync
        if (consumedMaskConfirmedRef.current) {
          consumedMaskConfirmedRef.current = false;
          return;
        }
        // Auto-advance only on user-initiated confirm (not during tab switch sync)
        if (tabRef.current === 'mask' && !syncingTabRef.current) {
          setTab(config?.has_tagger ? 'tag' : 'prompt');
        }
      } else if (event.data?.type === 'prompt-confirmed') {
        setPromptReady(true);
        // Skip auto-advance if this was consumed by handleTabChange sync
        if (consumedPromptConfirmedRef.current) {
          consumedPromptConfirmedRef.current = false;
          return;
        }
        // Auto-advance: prompt → draw
        if (tabRef.current === 'prompt' && !syncingTabRef.current) {
          setTab('draw');
        }
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

  // Poll status when draw is running
  useEffect(() => {
    if (tab !== 'draw' || detailStatus !== 'running') return;
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

  // Poll status when interface is running
  useEffect(() => {
    if (tab !== 'interface' || interfaceStatus !== 'running') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/status');
        const data: StatusResponse = await res.json();
        if (cancelled) return;
        setInterfaceStatus(data.interface_status || 'idle');
        setInterfaceProgress({
          progress: data.interface_progress || 0,
          current: data.interface_current_step || 0,
          total: data.interface_total_steps || 0,
        });
        if (data.interface_status === 'done') {
          const resultKeys = data.interface_result_keys || [];
          const execIdx = executedInterfaceIdx;
          refreshHistory().then(() => {
            if (resultKeys.length > 0 && execIdx !== null) {
              setHistory(prev => {
                const results = resultKeys
                  .map(k => prev.find(h => h.key === k))
                  .filter((h): h is HistoryItem => !!h);
                setInterfaceResults(prevMap => ({ ...prevMap, [execIdx]: results }));
                return prev;
              });
            } else if (execIdx !== null) {
              setInterfaceResults(prevMap => ({ ...prevMap, [execIdx]: [] }));
            }
          });
          fetch('/api/config').then(r => r.json()).then((cfg: ServerConfig) => {
            if (!cancelled) setCurrentContextKey(cfg.current_context_key ?? null);
          }).catch(() => {});
        } else if (data.interface_status === 'error') {
          setError(data.interface_error || 'Interface execution failed');
        }
      } catch { /* ignore */ }
    };
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(interval); };
  }, [tab, interfaceStatus, refreshHistory, executedInterfaceIdx]);

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

  const syncPrompt = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      const iframe = promptIframeRef.current;
      if (!iframe?.contentWindow) { resolve(); return; }
      let done = false;
      const handler = (event: MessageEvent) => {
        if (event.data?.type === 'prompt-synced') {
          done = true;
          window.removeEventListener('message', handler);
          resolve();
        }
      };
      window.addEventListener('message', handler);
      iframe.contentWindow.postMessage({ type: 'sync-prompt' }, '*');
      setTimeout(() => {
        if (!done) {
          window.removeEventListener('message', handler);
          resolve();
        }
      }, 3000);
    });
  }, []);

  const handleRunDetailer = useCallback(async () => {
    setError(null);
    setDetailStatus('running');
    setDetailProgress({ progress: 0, current: 0, total: 0 });
    setDebugData(null);
    setResultImages(null);

    // Ensure prompt is synced before running detailer
    await syncPrompt();

    try {
      await fetch('/api/run_detailer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context_reference_key: params.enable_edit && params.context_reference ? params.context_reference_key : null,
        }),
      });
    } catch (e: any) {
      setError('Failed to start detailer: ' + e.message);
      setDetailStatus('idle');
    }
  }, [params.enable_edit, params.context_reference, params.context_reference_key, syncPrompt]);

  const handleExecuteInterface = useCallback(async (interfaceIndex: number, manualValues: Record<string, any>, execOptions?: Record<string, any>) => {
    setError(null);
    setInterfaceStatus('running');
    setInterfaceProgress({ progress: 0, current: 0, total: 0 });
    setExecutedInterfaceIdx(interfaceIndex);
    try {
      await fetch('/api/execute_interface', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interface_index: interfaceIndex, manual_values: manualValues, exec_options: execOptions || {} }),
      });
    } catch (e: any) {
      setError('Failed to start interface execution: ' + e.message);
      setInterfaceStatus('idle');
    }
  }, []);

  const handleSwitchPipeline = useCallback(async (packageIdx: number, pipelineIdx: number) => {
    setError(null);
    try {
      const res = await fetch('/api/switch_pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package_idx: packageIdx, pipeline_idx: pipelineIdx }),
      });
      const data = await res.json();
      if (data.success) {
        setCurrentPipelineKey(`${packageIdx}_${pipelineIdx}`);
        // Refresh context preview + mask iframe
        fetch('/api/context_preview').then(r => r.json()).then(() => {}).catch(() => {});
        setTimeout(() => {
          const iframe = maskIframeRef.current;
          if (iframe?.contentWindow) {
            iframe.contentWindow.postMessage({ type: 'reload-image' }, '*');
          }
          // Notify prompt iframe to reload lora data (lora_regex may have changed)
          const promptIframe = promptIframeRef.current;
          if (promptIframe?.contentWindow) {
            promptIframe.contentWindow.postMessage({ type: 'reload-lora-data' }, '*');
          }
        }, 100);
      } else {
        setError(data.error || 'Failed to switch pipeline');
      }
    } catch (e: any) {
      setError('Failed to switch pipeline: ' + e.message);
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
    } catch { /* ignore */ }
    setFinished(true);
    window.close();
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

  if (finished) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 16, background: '#0d0d0d', color: '#fff' }}>
        <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(48,209,88,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 28, color: '#30d158' }}>✓</span>
        </div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Finished</div>
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)' }}>You can close this tab.</div>
      </div>
    );
  }

  return (
    <div>
      {syncingTab && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 32, height: 32, borderRadius: '50%', border: '3px solid rgba(255,255,255,0.1)', borderTopColor: '#0a84ff', animation: 'spin 0.8s linear infinite' }} />
            <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: 600 }}>Syncing...</span>
          </div>
        </div>
      )}
      <EditPhase
        tab={tab}
        onTabChange={handleTabChange}
        maskUrl={config.mask_url}
        promptUrl={config.prompt_url}
        maskConfirmed={maskConfirmed}
        promptReady={promptReady}
        autoTagging={autoTagging}
        hasTagger={!!config?.has_tagger}
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
        interfaceResults={interfaceResults}
        interfaceStatus={interfaceStatus}
        interfaceProgress={interfaceProgress}
        pipelinePackages={pipelinePackages}
        onSwitchPipeline={handleSwitchPipeline}
        currentPipelineKey={currentPipelineKey}
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
