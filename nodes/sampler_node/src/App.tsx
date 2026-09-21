import React, { useEffect, useState, useCallback, useRef } from 'react';
import EditPhase from './components/EditPhase';
import type { Tab, ServerConfig, StatusResponse, PipelineBlock, DetailerBlockParams, InterfaceBlockParams, HistoryItem, InterfaceInfo, PipelinePackageInfo } from './types';

const POLL_INTERVAL = 500;
const PROMPT_POLL_INTERVAL = 1500;

const App: React.FC = () => {
  const [tab, setTab] = useState<Tab>('draw');
  const tabRef = useRef<Tab>('draw');
  useEffect(() => { tabRef.current = tab; }, [tab]);

  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [promptReady, setPromptReady] = useState(false);
  const [detailStatus, setDetailStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [interfaceStatusByIdx, setInterfaceStatusByIdx] = useState<Record<number, 'idle' | 'running' | 'done' | 'error'>>({});
  const [interfaceProgressByIdx, setInterfaceProgressByIdx] = useState<Record<number, { progress: number; current: number; total: number }>>({});
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showFinishDialog, setShowFinishDialog] = useState(false);
  const [finished, setFinished] = useState(false);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [syncingTab, setSyncingTab] = useState(false);
  const syncingTabRef = useRef(false);
  useEffect(() => { syncingTabRef.current = syncingTab; }, [syncingTab]);
  // Track whether the latest prompt-confirmed was consumed by handleTabChange sync
  const consumedPromptConfirmedRef = useRef(false);
  const [currentContextKey, setCurrentContextKey] = useState<string | null>(null);
  const [blendSelect, setBlendSelect] = useState<{ role: 'layer' } | null>(null);
  const [interfaces, setInterfaces] = useState<InterfaceInfo[]>([]);
  const [pipelinePackages, setPipelinePackages] = useState<PipelinePackageInfo[]>([]);
  const [currentPipelineKey, setCurrentPipelineKey] = useState<string | null>(null);
  const [executedInterfaceIdx, setExecutedInterfaceIdx] = useState<number | null>(null);
  const [interfaceResults, setInterfaceResults] = useState<Record<number, HistoryItem[]>>({});
  const promptIframeRef = useRef<HTMLIFrameElement>(null);
  // The Blend workbench stays mounted for the whole session: it owns the layer stack and the
  // Mask layer, which would be lost if React unmounted it on every tab switch.
  const blendIframeRef = useRef<HTMLIFrameElement>(null);
  // Stable mirrors so the window message listener never reads a stale closure.
  const currentContextKeyRef = useRef<string | null>(null);
  useEffect(() => { currentContextKeyRef.current = currentContextKey; }, [currentContextKey]);
  const historyRef = useRef<HistoryItem[]>([]);
  useEffect(() => { historyRef.current = history; }, [history]);
  // Which detailer result has already been handed to the workbench. The done branch below is
  // reached from a 500 ms poll and runs three requests (the history payload is big), so a second
  // tick can arrive before React has torn the interval down — and injecting one key twice put two
  // identical layers on the canvas, which the user then cannot get rid of by deleting one.
  const injectedDetailKeyRef = useRef<string | null>(null);

  const defaultBlockParams: DetailerBlockParams = {
    add_noise: 'enable',
    start_step_rate: 0.8,
    end_step_rate: 1.0,
    pixels: 1048576,
    align: 8,
    crop_reserve: 32,
    recover_crop: true,
    enable_edit: false,
    edit_mode: 'fit' as const,
    ref_boost: 4.0,
    ref_boost_a: 1.0,
    enable_ref_boost_mask: false,
    grounding_px: 768,
    context_reference: false,
    context_reference_key: null,
    context_regex: '.+',
  };
  const defaultInterfaceParams: InterfaceBlockParams = {
    interface_idx: 0,
    operation: 'default',
    crop_reserve: 32,
    image_keys: {},
    context_image_key: null,
    context_mask_key: null,
    manual_values: {},
  };
  const [blocks, setBlocks] = useState<PipelineBlock[]>([
    { id: 'block-1', type: 'detailer', name: 'Detailer', params: { ...defaultBlockParams } },
  ]);
  const [architecture, setArchitecture] = useState<string | null>(null);
  const [maskGrow, setMaskGrow] = useState(32);
  const [maskBlur, setMaskBlur] = useState(32);
  const blockIdCounter = useRef(2);

  // Fetch config on mount
  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then((data: ServerConfig) => {
        setConfig(data);
        setMaskGrow(data.mask_grow);
        setMaskBlur(data.mask_blur);
        if (data.blocks && data.blocks.length > 0) {
          setBlocks(data.blocks);
        }
        setDetailStatus(data.detail_status);
        setCurrentContextKey(data.current_context_key ?? null);
        setArchitecture(data.architecture ?? null);
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

  // Leaving the prompt tab flushes the prompt editor into prompt_server first.
  const handleTabChange = useCallback((newTab: Tab) => {
    const needPromptSync = tab === 'prompt' && newTab !== 'prompt';
    if (!needPromptSync) {
      setTab(newTab);
      return;
    }
    setSyncingTab(true);
    const targetTab = newTab;
    let syncDone = false;
    const checkSyncDone = (event: MessageEvent) => {
      if (event.data?.type !== 'prompt-synced') return;
      syncDone = true;
      window.removeEventListener('message', checkSyncDone);
      setSyncingTab(false);
      consumedPromptConfirmedRef.current = true;
      setTab(targetTab);
    };
    window.addEventListener('message', checkSyncDone);
    const iframe = promptIframeRef.current;
    if (iframe?.contentWindow) iframe.contentWindow.postMessage({ type: 'sync-prompt' }, '*');
    // Timeout fallback
    setTimeout(() => {
      if (syncDone) return;
      window.removeEventListener('message', checkSyncDone);
      setSyncingTab(false);
      setTab(targetTab);
    }, 3000);
  }, [tab]);

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

  // Poll while the detailer runs, and drive the Blend workbench from the result.
  useEffect(() => {
    if (detailStatus !== 'running') return;
    let cancelled = false;
    let idleTicks = 0;               // the action may not have reached the main loop yet
    const post = (payload: Record<string, any>) => {
      blendIframeRef.current?.contentWindow?.postMessage({ type: 'blend-run-status', ...payload }, '*');
    };
    const poll = async () => {
      try {
        const res = await fetch('/api/status');
        const data: StatusResponse = await res.json();
        if (cancelled) return;
        const st = data.detail_status;
        if (st === 'idle') {
          // The backend has not picked the action up yet. Keep waiting, but do not hang forever
          // if the main loop is stuck on something else (e.g. an interface run).
          if (++idleTicks > 40) {
            setDetailStatus('error');
            post({ status: 'error', error: 'The detailer never started' });
            setError('The detailer never started');
          }
          return;
        }
        const progress = {
          progress: data.progress || 0,
          current: data.current_step || 0,
          total: data.total_steps || 0,
        };
        setDetailStatus(st);
        if (st === 'running') {
          post({ status: 'running', ...progress });
        } else if (st === 'error') {
          post({ status: 'error', error: data.error || 'Detailer failed' });
          setError(data.error || 'Detailer failed');
        } else if (st === 'done') {
          post({ status: 'done' });
          // The result never becomes the Context (the composite already is the Context): it is
          // archived into history and dropped onto the canvas as a new layer.
          await refreshHistory();
          try {
            const result = await fetch('/api/result').then(r => r.json());
            const key = result?.detailed_key;
            if (!key || injectedDetailKeyRef.current === key) return;
            injectedDetailKeyRef.current = key;      // claimed before the awaits below, not after
            const list = await fetch('/api/history').then(r => r.json());
            const item = (list?.history || []).find((h: HistoryItem) => h.key === key);
            if (item) {
              blendIframeRef.current?.contentWindow?.postMessage({ type: 'blend-add-layer', items: [item] }, '*');
            }
          } catch { /* the layer is a convenience, not a hard requirement */ }
        }
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(interval); };
  }, [detailStatus, refreshHistory]);

  // Poll status when interface is running (mutual exclusion: only one runs at a time)
  useEffect(() => {
    if (tab !== 'interface' || executedInterfaceIdx === null || interfaceStatusByIdx[executedInterfaceIdx] !== 'running') return;
    const execIdx = executedInterfaceIdx;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/status');
        const data: StatusResponse = await res.json();
        if (cancelled) return;
        const st = data.interface_status || 'idle';
        setInterfaceStatusByIdx(prev => ({ ...prev, [execIdx]: st }));
        setInterfaceProgressByIdx(prev => ({
          ...prev,
          [execIdx]: {
            progress: data.interface_progress || 0,
            current: data.interface_current_step || 0,
            total: data.interface_total_steps || 0,
          },
        }));
        if (st === 'done') {
          const resultKeys = data.interface_result_keys || [];
          refreshHistory().then(() => {
            if (resultKeys.length > 0) {
              setHistory(prev => {
                const results = resultKeys
                  .map(k => prev.find(h => h.key === k))
                  .filter((h): h is HistoryItem => !!h);
                setInterfaceResults(prevMap => ({ ...prevMap, [execIdx]: results }));
                return prev;
              });
            } else {
              setInterfaceResults(prevMap => ({ ...prevMap, [execIdx]: [] }));
            }
          });
          fetch('/api/config').then(r => r.json()).then((cfg: ServerConfig) => {
            if (!cancelled) setCurrentContextKey(cfg.current_context_key ?? null);
          }).catch(() => {});
        } else if (st === 'error') {
          setError(data.interface_error || 'Interface execution failed');
        }
      } catch { /* ignore */ }
    };
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(interval); };
  }, [tab, executedInterfaceIdx, interfaceStatusByIdx, refreshHistory]);

  // Flush the prompt editor into prompt_server. The detailer reads the prompt from there, so a
  // Run Detailer must not start while the editor still holds unsaved edits.
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

  // The Blend workbench asks for the current context image so its canvas is never empty.
  const seedBlendCanvas = useCallback(async () => {
    const iframe = blendIframeRef.current;
    if (!iframe?.contentWindow) return;
    const key = currentContextKeyRef.current;
    let item = key ? historyRef.current.find(h => h.key === key) : undefined;
    if (!item) {
      try {
        const r = await fetch('/api/history').then(r => r.json());
        const list: HistoryItem[] = r?.history || [];
        setHistory(list);
        item = key ? list.find(h => h.key === key) : list[list.length - 1];
      } catch { /* nothing to seed with */ }
    }
    if (!item) return;
    iframe.contentWindow.postMessage({
      type: 'blend-init-layer',
      items: [{ key: item.key, name: item.name, src: item.src }],
    }, '*');
  }, []);

  /**
   * Single entry point for the workbench toolbar. The backend composites the canvas
   * (blend_action) and then either archives it, tags it, or hands it to the detailer —
   * the composite is the Context Image, so nothing here switches context.
   */
  const handleBlendAction = useCallback(async (body: Record<string, any>) => {
    setError(null);
    const reply = (success: boolean, extra: Record<string, any> = {}) => {
      blendIframeRef.current?.contentWindow?.postMessage(
        { type: 'blend-action-result', action: body?.action, success, ...extra }, '*');
    };
    // A run reads the prompt from prompt_server, so flush the editor first.
    if (body.action === 'detailer') await syncPrompt();
    try {
      const res = await fetch('/api/blend_action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: body.action,
          tag_mode: body.tag_mode,
          layers: body.layers,
          width: body.width,
          height: body.height,
          mask: body.mask,
          extra_prompt: body.extra_prompt,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Blend action failed');
        reply(false, { error: data.error || 'Blend action failed' });
        return;
      }
      if (body.action === 'blend') {
        refreshHistory();
        reply(true, { key: data.key });
      } else if (body.action === 'tag') {
        reply(true, { tag: data.tag });
        setPromptReady(true);
        // Tag output belongs to the prompt stage: push it into the prompt editor's tags.
        setTimeout(() => {
          promptIframeRef.current?.contentWindow?.postMessage({
            type: 'auto-tag',
            tag: data.tag,
            tags: data.tags || [],
            custom: data.custom || '',
          }, '*');
        }, 100);
      } else {
        // The run itself is asynchronous — progress arrives through the status poller.
        setDetailStatus('running');
        reply(true);
      }
    } catch (e: any) {
      setError('Blend action error: ' + e.message);
      reply(false, { error: e.message });
    }
  }, [refreshHistory, syncPrompt]);

  // Listen for postMessage from the prompt iframe and the Blend workbench.
  // Declared after the handlers so the listener always closes over the current ones.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'prompt-confirmed') {
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
        // Blend workbench asks for history images (its Add / layer picker)
        setBlendSelect({ role: event.data.role });
      } else if (event.data?.type === 'blend-action') {
        // Blend workbench action: blend (archive) / tag / detailer
        handleBlendAction(event.data);
      } else if (event.data?.type === 'blend-request-init') {
        // Seed the canvas with the current context image and report the tagger availability
        // (the Tag buttons disable themselves without one).
        const iframe = blendIframeRef.current;
        if (!iframe?.contentWindow) return;
        iframe.contentWindow.postMessage({ type: 'blend-config', hasTagger: !!config?.has_tagger }, '*');
        seedBlendCanvas();
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [config, handleBlendAction, seedBlendCanvas]);

  const handleExecuteInterface = useCallback(async (interfaceIndex: number, manualValues: Record<string, any>, execOptions?: Record<string, any>) => {
    setError(null);
    // Mutual exclusion: if another interface is currently running, ignore this request.
    if (executedInterfaceIdx !== null && interfaceStatusByIdx[executedInterfaceIdx] === 'running') {
      return;
    }
    setExecutedInterfaceIdx(interfaceIndex);
    setInterfaceStatusByIdx(prev => ({ ...prev, [interfaceIndex]: 'running' }));
    setInterfaceProgressByIdx(prev => ({ ...prev, [interfaceIndex]: { progress: 0, current: 0, total: 0 } }));
    try {
      await fetch('/api/execute_interface', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interface_index: interfaceIndex, manual_values: manualValues, exec_options: execOptions || {} }),
      });
    } catch (e: any) {
      setError('Failed to start interface execution: ' + e.message);
      setInterfaceStatusByIdx(prev => ({ ...prev, [interfaceIndex]: 'idle' }));
      setExecutedInterfaceIdx(null);
    }
  }, [executedInterfaceIdx, interfaceStatusByIdx]);

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
        // Refresh architecture (edit settings are rendered per-architecture)
        fetch('/api/config').then(r => r.json()).then((cfg: ServerConfig) => {
          setArchitecture(cfg.architecture ?? null);
        }).catch(() => {});
        // Notify prompt iframe to reload lora data (lora_regex may have changed)
        setTimeout(() => {
          promptIframeRef.current?.contentWindow?.postMessage({ type: 'reload-lora-data' }, '*');
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
      setPromptReady(false);
      setDetailStatus('idle');
      setCurrentContextKey(key);
    } catch (e: any) {
      setError('Failed to select image: ' + e.message);
    }
  }, []);

  // Set the context image without leaving the current tab
  const handleSetContext = useCallback(async (key: string) => {
    setCurrentContextKey(key);  // Immediate UI feedback
    try {
      await fetch('/api/select_image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
    } catch (e: any) {
      setError('Failed to set context: ' + e.message);
    }
  }, []);

  const handleBlocksChange = useCallback((next: PipelineBlock[]) => {
    setBlocks(next);
    fetch('/api/update_config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks: next }),
    }).catch(() => {});
  }, []);

  const handleGlobalParamChange = useCallback((key: 'mask_grow' | 'mask_blur', value: number) => {
    if (key === 'mask_grow') setMaskGrow(value);
    if (key === 'mask_blur') setMaskBlur(value);
    fetch('/api/update_config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    }).catch(() => {});
  }, []);

  const handleAddBlock = useCallback((type: 'detailer' | 'interface') => {
    const id = 'block-' + blockIdCounter.current++;
    const newBlock: PipelineBlock = type === 'detailer'
      ? { id, type: 'detailer', name: 'Detailer', params: { ...defaultBlockParams } }
      : { id, type: 'interface', name: 'Interface', params: { ...defaultInterfaceParams } };
    setBlocks(prev => {
      const next = [...prev, newBlock];
      fetch('/api/update_config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks: next }),
      }).catch(() => {});
      return next;
    });
  }, []);

  const handleRemoveBlock = useCallback((blockId: string) => {
    setBlocks(prev => {
      if (prev.length <= 1) return prev;
      const next = prev.filter(b => b.id !== blockId);
      fetch('/api/update_config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks: next }),
      }).catch(() => {});
      return next;
    });
  }, []);

  const handleReorderBlocks = useCallback((fromIdx: number, toIdx: number) => {
    setBlocks(prev => {
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      fetch('/api/update_config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks: next }),
      }).catch(() => {});
      return next;
    });
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
        promptUrl={config.prompt_url}
        promptReady={promptReady}
        detailStatus={detailStatus}
        history={history}
        onRefreshHistory={refreshHistory}
        promptIframeRef={promptIframeRef}
        blocks={blocks}
        architecture={architecture}
        maskGrow={maskGrow}
        maskBlur={maskBlur}
        onBlocksChange={handleBlocksChange}
        onGlobalParamChange={handleGlobalParamChange}
        onAddBlock={handleAddBlock}
        onRemoveBlock={handleRemoveBlock}
        onReorderBlocks={handleReorderBlocks}
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
        onBlendSelectImages={(items) => {
          const iframe = blendIframeRef.current;
          iframe?.contentWindow?.postMessage({ type: 'blend-image-selected', items }, '*');
          setBlendSelect(null);
        }}
        onCloseBlendSelect={() => setBlendSelect(null)}
        interfaces={interfaces}
        onExecuteInterface={handleExecuteInterface}
        interfaceResults={interfaceResults}
        interfaceStatusByIdx={interfaceStatusByIdx}
        interfaceProgressByIdx={interfaceProgressByIdx}
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
