import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import EditPhase from './components/EditPhase';
import type { Tab, ServerConfig, StatusResponse, PipelineBlock, DetailerBlockParams, InterfaceBlockParams, StagingItem, InterfaceInfo, PipelinePackageInfo, BlockSet, PendingQuery } from './types';

const POLL_INTERVAL = 500;
const PROMPT_POLL_INTERVAL = 1500;

/** 第一个 detailer block 的 Enable Mask 总闸（默认开）。Blend 工作台的 Run 预检与后端
 *  闸门共用同一语义：关 = 不做围绕 mask 的预处理、整幅就是工作区，Mask 层没画也能跑。 */
function firstDetailerEnableMask(blockSets: BlockSet[], setId: string | null): boolean {
  const set = blockSets.find(s => s.id === setId) || blockSets[0];
  const fd = set?.blocks.find(b => b.type === 'detailer');
  const dp = fd ? (fd.params as DetailerBlockParams) : undefined;
  return dp ? (dp.enable_mask ?? true) : true;
}

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
  const [staging, setStaging] = useState<StagingItem[]>([]);
  const [showFinishDialog, setShowFinishDialog] = useState(false);
  const [finished, setFinished] = useState(false);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [syncingTab, setSyncingTab] = useState(false);
  const syncingTabRef = useRef(false);
  useEffect(() => { syncingTabRef.current = syncingTab; }, [syncingTab]);
  // Track whether the latest prompt-confirmed was consumed by handleTabChange sync
  const consumedPromptConfirmedRef = useRef(false);
  const [interfaces, setInterfaces] = useState<InterfaceInfo[]>([]);
  const [pipelinePackages, setPipelinePackages] = useState<PipelinePackageInfo[]>([]);
  const [currentPipelineKey, setCurrentPipelineKey] = useState<string | null>(null);
  const [executedInterfaceIdx, setExecutedInterfaceIdx] = useState<number | null>(null);
  // A Query block parked mid-run: the chain is blocked until the user answers (or cancels).
  const [pendingQuery, setPendingQuery] = useState<PendingQuery | null>(null);
  const [interfaceResults, setInterfaceResults] = useState<Record<number, StagingItem[]>>({});
  const promptIframeRef = useRef<HTMLIFrameElement>(null);
  // The Blend workbench stays mounted for the whole session: it owns the layer stack and the
  // Mask layer, which would be lost if React unmounted it on every tab switch.
  const blendIframeRef = useRef<HTMLIFrameElement>(null);
  const stagingRef = useRef<StagingItem[]>([]);
  useEffect(() => { stagingRef.current = staging; }, [staging]);
  // Which detailer result has already been handed to the workbench. The done branch below is
  // reached from a 500 ms poll and runs three requests (the history payload is big), so a second
  // tick can arrive before React has torn the interval down — and injecting one key twice put two
  // identical layers on the canvas, which the user then cannot get rid of by deleting one.
  const injectedDetailKeyRef = useRef<string | null>(null);
  // A layer-initiated Generate writes its result back into that layer instead of adding a new one.
  // The poller cannot tell the two apart from the status alone, so the target is parked here while
  // the run is in flight and consumed once, in the `done` branch.
  const layerGenerateRef = useRef<{ layerId: number } | null>(null);

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
    // Ref 图不再逐块配置：Blend 工作台 Extra Prompt 文本里的 <image_id:...> 标记
    // 在 Run 时统一解析，所有 detailer block 共用。
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
  // Multi-set Pipeline Blocks ("tabs" in the workbench). The ACTIVE set's blocks ARE the working
  // chain — everything downstream (EditPhase's list, /api/update_config, the Blend workbench's
  // block list) sees only that flat array; the sets are the storage layer wrapped around it.
  const [blockSets, setBlockSets] = useState<BlockSet[]>([
    { id: 'set-1', name: 'Default', blocks: [
      { id: 'block-1', type: 'detailer', name: 'Detailer', params: { ...defaultBlockParams } },
    ] },
  ]);
  const [activeBlockSetId, setActiveBlockSetId] = useState<string>('set-1');
  const blockSetIdCounter = useRef(2);
  const blocks = useMemo(
    () => blockSets.find(s => s.id === activeBlockSetId)?.blocks ?? blockSets[0]?.blocks ?? [],
    [blockSets, activeBlockSetId]);
  const [architecture, setArchitecture] = useState<string | null>(null);
  const [maskGrow, setMaskGrow] = useState(32);
  const [maskBlur, setMaskBlur] = useState(32);
  // GLOBAL SETTINGS：所有 preset 共享（server config 持久化）
  const [cropReserve, setCropReserve] = useState(32);
  const [pixelsVal, setPixelsVal] = useState(1048576);
  const [alignVal, setAlignVal] = useState(8);
  const blockIdCounter = useRef(2);

  // Fetch config on mount
  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then((data: ServerConfig) => {
        setConfig(data);
        setMaskGrow(data.mask_grow);
        setMaskBlur(data.mask_blur);
        setCropReserve(data.crop_reserve);
        setPixelsVal(data.pixels);
        setAlignVal(data.align);
        if (Array.isArray(data.blocks_sets)) {
          setBlockSets(data.blocks_sets);
          setActiveBlockSetId(
            data.active_block_set && data.blocks_sets.some((s: BlockSet) => s.id === data.active_block_set)
              ? data.active_block_set
              : (data.blocks_sets[0]?.id ?? ''));
        } else if (data.blocks && data.blocks.length > 0) {
          // Legacy config without sets: wrap the flat chain into a single Default tab.
          setBlockSets([{ id: 'set-1', name: 'Default', blocks: data.blocks }]);
          setActiveBlockSetId('set-1');
        }
        // Counters restart at 2 each load; skip past ids already persisted on the server,
        // otherwise "New tab" after a refresh mints an id that collides with an existing set.
        const maxIdSuffix = (ids: string[], prefix: string) =>
          ids.reduce((m, id) => { const n = parseInt(id.slice(prefix.length), 10); return Number.isFinite(n) ? Math.max(m, n) : m; }, 1);
        const allSets: BlockSet[] = Array.isArray(data.blocks_sets)
          ? data.blocks_sets
          : [{ id: 'set-1', name: 'Default', blocks: data.blocks ?? [] }];
        blockSetIdCounter.current = Math.max(2, maxIdSuffix(allSets.map(s => s.id), 'set-') + 1);
        blockIdCounter.current = Math.max(2, maxIdSuffix(allSets.flatMap(s => (s.blocks ?? []).map(b => b.id)), 'block-') + 1);
        setDetailStatus(data.detail_status);
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

  // Fetch the staging pool on mount (the workbench strip + every picker read it)
  const refreshStaging = useCallback((): Promise<void> => {
    return fetch('/api/staging')
      .then(r => r.json())
      .then(data => {
        if (data.staging) setStaging(data.staging);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { refreshStaging(); }, [refreshStaging]);

  // Push staging list changes into the Blend workbench (its strip renders from this mirror).
  useEffect(() => {
    blendIframeRef.current?.contentWindow?.postMessage({
      type: 'blend-staging',
      items: staging,
    }, '*');
  }, [staging]);

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
        // A Query block parks the run: open its dialog as soon as the backend says so, and
        // let the same field going back to null close it (answered / cancelled / aborted).
        setPendingQuery(data.pending_query || null);
        const st = data.detail_status;
        if (st === 'cancelled') {
          // Run 按钮的 Cancel 打断了本次运行：通知工作台复位按钮，本页状态回 idle。
          post({ status: 'cancelled' });
          setDetailStatus('idle');
          return;
        }
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
          // The result never becomes the pipeline image by itself: it lands in the staging pool
          // and then either is written back over the layer it came from (a layer-initiated
          // Generate) or dropped on as a new layer (the toolbar's Run Detailer).
          const generateTarget = layerGenerateRef.current;
          layerGenerateRef.current = null;
          await refreshStaging();
          try {
            const result = await fetch('/api/result').then(r => r.json());
            const sid = result?.detailed_key;
            if (!sid || injectedDetailKeyRef.current === sid) return;
            injectedDetailKeyRef.current = sid;      // claimed before the awaits below, not after
            const list = await fetch('/api/staging').then(r => r.json());
            const item = (list?.staging || []).find((s: StagingItem) => s.id === sid);
            if (!item) return;
            if (generateTarget) {
              // Replace in place. The workbench keeps the layer's mask / decal / transform and
              // only swaps the image, so there is no new layer and nothing to de-duplicate.
              blendIframeRef.current?.contentWindow?.postMessage(
                { type: 'blend-replace-layer', layer_id: generateTarget.layerId, items: [item] }, '*');
            } else {
              blendIframeRef.current?.contentWindow?.postMessage({ type: 'blend-add-layer', items: [item] }, '*');
            }
          } catch { /* the layer is a convenience, not a hard requirement */ }
        }
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(interval); };
  }, [detailStatus, refreshStaging]);

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
          const resultIds = data.interface_result_keys || [];
          refreshStaging().then(() => {
            if (resultIds.length > 0) {
              setStaging(prev => {
                const results = (resultIds as string[])
                  .map((id: string) => prev.find((s: StagingItem) => s.id === id))
                  .filter((s): s is StagingItem => !!s);
                setInterfaceResults(prevMap => ({ ...prevMap, [execIdx]: results }));
                return prev;
              });
            } else {
              setInterfaceResults(prevMap => ({ ...prevMap, [execIdx]: [] }));
            }
          });
        } else if (st === 'error') {
          setError(data.interface_error || 'Interface execution failed');
        }
      } catch { /* ignore */ }
    };
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(interval); };
  }, [tab, executedInterfaceIdx, interfaceStatusByIdx, refreshStaging]);

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

  // The Blend workbench asks for its seed image so the canvas is never empty. The run's
  // initial image lands in the staging pool as 'Original' — prefer it, else the newest item.
  const seedBlendCanvas = useCallback(async () => {
    const iframe = blendIframeRef.current;
    if (!iframe?.contentWindow) return;
    let list = stagingRef.current;
    if (!list.length) {
      try {
        const r = await fetch('/api/staging').then(r => r.json());
        list = (r?.staging || []) as StagingItem[];
        setStaging(list);
      } catch { /* nothing to seed with */ }
    }
    const item = list.find(s => s.name === 'Original') ?? list[list.length - 1];
    if (!item) return;
    iframe.contentWindow.postMessage({
      type: 'blend-init-layer',
      items: [{ name: item.name, src: item.src, place: item.place }],
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
          // Run 设置（以及 ▶ 预设胶囊）选的 preset：决定后端跑哪条 block 链，
          // Enable Mask 总闸也随这条链解析。之前漏转发 —— 对话框的选择被静默丢弃。
          preset_id: body.preset_id ?? null,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Blend action failed');
        reply(false, { error: data.error || 'Blend action failed' });
        return;
      }
      if (body.action === 'blend') {
        refreshStaging();
        reply(true, { id: data.id });
        // Blend 不只是归档进工作区：合成结果同时作为一个新的智能对象图层放回画布
        // 顶层（图层自带像素 dataURL，非破坏、可继续改 transform / 画 mask）。
        // 画布原有图层与 Mask 层一律不动；图层注入失败不影响归档本身。
        blendIframeRef.current?.contentWindow?.postMessage(
          { type: 'blend-add-layer', smart: true,
            items: [{ id: data.id, name: data.name || 'Blend', src: data.image }],
            note: 'Blend result added as a new smart layer (also archived to staging)' }, '*');
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
  }, [refreshStaging, syncPrompt]);

  /**
   * Generate on a single layer, driven from the layer row's context menu.
   *
   * The difference from the toolbar's Run Detailer is what is sent: the toolbar composites the
   * whole canvas and uses the singleton Mask layer, whereas this sends *that layer's* own image as
   * the context image and *that layer's* own mask as the context mask. The result is written back
   * over that layer's image rather than added as a new layer.
   *
   * `preset_id` names the pipeline preset (block set) that runs this Generate — the enum in the
   * workbench's Generate dialog. The backend resolves it per run; the preset's own start steps apply.
   */
  const handleLayerGenerate = useCallback(async (body: Record<string, any>) => {
    setError(null);
    const layerId = Number(body.layer_id);
    const reply = (success: boolean, extra: Record<string, any> = {}) => {
      blendIframeRef.current?.contentWindow?.postMessage(
        { type: 'blend-action-result', action: 'layer-generate', success, ...extra }, '*');
    };
    if (!body.image) { reply(false, { error: 'That layer has no image' }); return; }
    if (!body.mask) { reply(false, { error: 'That layer has no mask painted' }); return; }
    await syncPrompt();
    try {
      const res = await fetch('/api/blend_action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'layer_generate',
          layer_image: body.image,
          layer_mask: body.mask,
          width: body.width,
          height: body.height,
          preset_id: body.preset_id ?? null,
          extra_prompt: body.extra_prompt,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Generate failed');
        reply(false, { error: data.error || 'Generate failed' });
        return;
      }
      // Park the target so the `done` branch knows to replace instead of inject. Set *before* the
      // first poll can see `done`, for the same reason injectedDetailKeyRef is.
      layerGenerateRef.current = { layerId };
      setDetailStatus('running');
      reply(true);
    } catch (e: any) {
      setError('Generate error: ' + e.message);
      reply(false, { error: e.message });
    }
  }, [syncPrompt]);

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
      } else if (event.data?.type === 'blend-staging-changed') {
        // 工作区条目变了（工作台上传/删除）：重拉列表，effect 会自动镜像回工作台。
        refreshStaging();
      } else if (event.data?.type === 'blend-action') {
        // Blend workbench action: blend (archive) / tag / detailer
        handleBlendAction(event.data);
      } else if (event.data?.type === 'blend-layer-generate') {
        // Generate from the layer row's context menu: that layer in, that layer out.
        handleLayerGenerate(event.data);
      } else if (event.data?.type === 'blend-cancel-run') {
        // Blend 工具栏的 Run 按钮在运行中变成了 Cancel —— 打断当前 run
        // （后端用 ComfyUI 原生 interrupt：采样步 / block 边界 / Generate Text 后抛
        // InterruptProcessingException，run 循环转成 detail_status='cancelled'）。
        fetch('/api/cancel_run', { method: 'POST' }).catch(() => {});
      } else if (event.data?.type === 'blend-request-init') {
        // Seed the canvas with the current pipeline image, report the tagger availability,
        // and hand over the staging pool (its strip renders from this mirror).
        const iframe = blendIframeRef.current;
        if (!iframe?.contentWindow) return;
        iframe.contentWindow.postMessage({
          type: 'blend-config',
          hasTagger: !!config?.has_tagger,
          // 激活 tab 的 Enable Mask 总闸：关 = 整幅是工作区，Run 不要求先画 Mask 层。
          mask_required: firstDetailerEnableMask(blockSets, activeBlockSetId),
          staging: stagingRef.current,
        }, '*');
        // The Generate dialog's Pipeline Preset enum picks which block set runs the generate, so
        // the workbench needs every set's id/name plus the tab that is active right now.
        iframe.contentWindow.postMessage({
          type: 'blend-pipeline-presets',
          presets: blockSets.map((s: BlockSet) => ({ id: s.id, name: s.name, enable_mask: firstDetailerEnableMask(blockSets, s.id) })),
          active_id: activeBlockSetId,
        }, '*');
        seedBlendCanvas();
      } else if (event.data?.type === 'blend-staging-upload') {
        // 工作台拖文件/CUD 导入恢复：批量进图池（后端建 tensor 引用），随后镜像回工作台。
        const images: string[] = Array.isArray(event.data.images) ? event.data.images : [];
        const names: string[] = Array.isArray(event.data.names) ? event.data.names : [];
        if (!images.length) return;
        fetch('/api/staging', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ images, names, name: 'Loaded' }),
        }).then(() => refreshStaging()).catch(() => {});
      } else if (event.data?.type === 'blend-staging-remove') {
        const sid = typeof event.data.id === 'string' ? event.data.id : '';
        if (!sid) return;
        fetch('/api/staging_remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sid }),
        }).then(() => refreshStaging()).catch(() => {});
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [config, blockSets, activeBlockSetId, handleBlendAction, handleLayerGenerate, seedBlendCanvas, refreshStaging]);

  // Push preset (tab) changes to the Blend workbench as they happen. The iframe only asks for
  // init once, on load — without this effect a tab created / renamed / deleted / switched after
  // that would never reach the Generate dialog's Pipeline Preset enum.
  useEffect(() => {
    const iframe = blendIframeRef.current;
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage({
      type: 'blend-pipeline-presets',
      presets: blockSets.map((s: BlockSet) => ({ id: s.id, name: s.name, enable_mask: firstDetailerEnableMask(blockSets, s.id) })),
      active_id: activeBlockSetId,
    }, '*');
  }, [blockSets, activeBlockSetId]);

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

  // 把工作区某张图设为 pipeline 当前图（下一次 run 从它继续）。
  const handleSelectImage = useCallback(async (id: string) => {
    try {
      await fetch('/api/select_image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: id }),
      });
      // Reset state for next iteration
      setPromptReady(false);
      setDetailStatus('idle');
    } catch (e: any) {
      setError('Failed to select image: ' + e.message);
    }
  }, []);

  // Single write path for every blocks mutation: the sets plus the active chain go out together
  // (the server mirrors `blocks` as its runner chain AND derives it from the active set).
  const handleBlocksChange = useCallback((next: PipelineBlock[]) => {
    const nextSets = blockSets.map(s => s.id === activeBlockSetId ? { ...s, blocks: next } : s);
    setBlockSets(nextSets);
    fetch('/api/update_config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks_sets: nextSets, active_block_set: activeBlockSetId, blocks: next }),
    }).catch(() => {});
  }, [blockSets, activeBlockSetId]);

  const handleGlobalParamChange = useCallback((key: 'mask_grow' | 'mask_blur' | 'crop_reserve' | 'pixels' | 'align', value: number) => {
    if (key === 'mask_grow') setMaskGrow(value);
    if (key === 'mask_blur') setMaskBlur(value);
    if (key === 'crop_reserve') setCropReserve(value);
    if (key === 'pixels') setPixelsVal(value);
    if (key === 'align') setAlignVal(value);
    fetch('/api/update_config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    }).catch(() => {});
  }, []);

  const handleAddBlock = useCallback((type: 'detailer' | 'interface' | 'prompt' | 'query') => {
    const id = 'block-' + blockIdCounter.current++;
    const newBlock: PipelineBlock = type === 'detailer'
      ? { id, type: 'detailer', name: 'Detailer', params: { ...defaultBlockParams } }
      : type === 'interface'
        ? { id, type: 'interface', name: 'Interface', params: { ...defaultInterfaceParams } }
        : type === 'query'
          ? { id, type: 'query', name: 'Query', params: {} }
          : { id, type: 'prompt', name: 'Prompt', params: { preset_id: null } };
    handleBlocksChange([...blocks, newBlock]);
  }, [blocks, handleBlocksChange]);

  const handleRemoveBlock = useCallback((blockId: string) => {
    if (blocks.length <= 1) return;
    handleBlocksChange(blocks.filter(b => b.id !== blockId));
  }, [blocks, handleBlocksChange]);

  const handleReorderBlocks = useCallback((fromIdx: number, toIdx: number) => {
    const next = [...blocks];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    handleBlocksChange(next);
  }, [blocks, handleBlocksChange]);

  /**
   * Run one pipeline preset right now — the ▶ half of the sampler's Pipeline Presets
   * capsule. The canvas and the Mask layer live in the Blend workbench, so the workbench
   * issues the run; we only name which preset it should use. Its reply is the ordinary
   * blend-action, which starts the status poller like the toolbar's Run.
   */
  const handleRunPreset = useCallback((presetId: string) => {
    setError(null);
    blendIframeRef.current?.contentWindow?.postMessage({ type: 'blend-run-preset', preset_id: presetId }, '*');
  }, []);

  /** Answer a parked Query block. The selection is the prompt UI's RAW choice — the run
   *  merges it and runs its programs, exactly like a prompt block's preset. */
  const handleQueryAnswer = useCallback(async (selection: Record<string, any>) => {
    setPendingQuery(null);
    try {
      await fetch('/api/query_answer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selection }),
      });
    } catch { /* the run aborts on its own if the answer never lands */ }
  }, []);

  /** Closing the Query dialog aborts the whole chain — the user chose to stop, not to skip. */
  const handleQueryCancel = useCallback(async () => {
    setPendingQuery(null);
    try {
      await fetch('/api/query_answer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancelled: true }),
      });
    } catch { /* as above */ }
  }, []);

  // ── Pipeline Blocks tabs（多套 blocks，每套独立持久化在后端 config）──
  const persistSets = useCallback((nextSets: BlockSet[], nextActiveId: string) => {
    setBlockSets(nextSets);
    setActiveBlockSetId(nextActiveId);
    const active = nextSets.find(s => s.id === nextActiveId) ?? nextSets[0];
    fetch('/api/update_config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks_sets: nextSets, active_block_set: nextActiveId, blocks: active?.blocks ?? [] }),
    }).catch(() => {});
  }, []);

  const handleAddBlockSet = useCallback(() => {
    const id = 'set-' + blockSetIdCounter.current++;
    const nextSets: BlockSet[] = [...blockSets, {
      id,
      name: `Set ${blockSets.length + 1}`,
      blocks: [{ id: 'block-' + blockIdCounter.current++, type: 'detailer', name: 'Detailer', params: { ...defaultBlockParams } }],
    }];
    persistSets(nextSets, id);
  }, [blockSets, persistSets]);

  const handleRenameBlockSet = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    persistSets(blockSets.map(s => s.id === id ? { ...s, name: trimmed } : s), activeBlockSetId);
  }, [blockSets, activeBlockSetId, persistSets]);

  const handleDuplicateBlockSet = useCallback((id: string) => {
    const src = blockSets.find(s => s.id === id);
    if (!src) return;
    const newId = 'set-' + blockSetIdCounter.current++;
    // Deep-copy so editing the copy never aliases the source set's blocks.
    const copy = JSON.parse(JSON.stringify(src.blocks)) as PipelineBlock[];
    persistSets([...blockSets, { id: newId, name: `${src.name} copy`, blocks: copy }], newId);
  }, [blockSets, persistSets]);

  const handleRemoveBlockSet = useCallback((id: string) => {
    const nextSets = blockSets.filter(s => s.id !== id);
    const nextActive = nextSets.some(s => s.id === activeBlockSetId) ? activeBlockSetId : (nextSets[0]?.id ?? '');
    persistSets(nextSets, nextActive);
  }, [blockSets, activeBlockSetId, persistSets]);

  const handleReorderBlockSets = useCallback((from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= blockSets.length || to >= blockSets.length) return;
    const nextSets = [...blockSets];
    const [moved] = nextSets.splice(from, 1);
    nextSets.splice(to, 0, moved);
    persistSets(nextSets, activeBlockSetId);
  }, [blockSets, activeBlockSetId, persistSets]);

  const handleSwitchBlockSet = useCallback((id: string) => {
    if (id === activeBlockSetId) return;
    persistSets(blockSets, id);
  }, [blockSets, activeBlockSetId, persistSets]);

  // One-time migration: interface blocks saved before name-binding only carry interface_idx.
  // Once the interfaces list is known, resolve and write the name into every set's blocks so
  // later reordering/removal of interface packages cannot silently rebind them.
  const ifaceNameMigratedRef = useRef(false);
  useEffect(() => {
    if (ifaceNameMigratedRef.current || interfaces.length === 0 || blockSets.length === 0) return;
    ifaceNameMigratedRef.current = true;
    let changed = false;
    const nextSets = blockSets.map(set => ({
      ...set,
      blocks: set.blocks.map(b => {
        if (b.type !== 'interface') return b;
        const ip = b.params as InterfaceBlockParams;
        if (ip.interface_name) return b;
        const itf = interfaces[ip.interface_idx];
        if (!itf) return b;   // out of range: stays unnamed = Missing until the user re-picks
        changed = true;
        return { ...b, params: { ...ip, interface_name: itf.name } };
      }),
    }));
    if (!changed) return;
    const active = nextSets.find(s => s.id === activeBlockSetId) ?? nextSets[0];
    setBlockSets(nextSets);
    fetch('/api/update_config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks_sets: nextSets, active_block_set: activeBlockSetId, blocks: active?.blocks ?? [] }),
    }).catch(() => {});
  }, [interfaces, blockSets, activeBlockSetId]);

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

  // 上传到工作区，返回新条目的 id —— Context tab / 端口图选择都用它。
  const handleAddStagingImage = useCallback(async (base64: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/staging', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: [base64], name: 'Loaded' }),
      });
      const data = await res.json().catch(() => ({}));
      refreshStaging();
      return (data && data.success && Array.isArray(data.added) && data.added[0]?.id) || null;
    } catch (e: any) {
      setError('Failed to add image: ' + e.message);
      return null;
    }
  }, [refreshStaging]);

  const handleLoadFromAssets = useCallback(async () => {
    setLoadingAssets(true);
    setError(null);
    try {
      const res = await fetch('/api/load_from_assets', { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Failed to load from assets');
      }
      refreshStaging();
    } catch (e: any) {
      setError('Failed to load from assets: ' + e.message);
    } finally {
      setLoadingAssets(false);
    }
  }, [refreshStaging]);

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
        staging={staging}
        onRefreshStaging={refreshStaging}
        promptIframeRef={promptIframeRef}
        blocks={blocks}
        architecture={architecture}
        maskGrow={maskGrow}
        maskBlur={maskBlur}
        cropReserve={cropReserve}
        pixelsVal={pixelsVal}
        alignVal={alignVal}
        onBlocksChange={handleBlocksChange}
        onGlobalParamChange={handleGlobalParamChange}
        onAddBlock={handleAddBlock}
        pendingQuery={pendingQuery}
        onRunPreset={handleRunPreset}
        onQueryAnswer={handleQueryAnswer}
        onQueryCancel={handleQueryCancel}
        onRemoveBlock={handleRemoveBlock}
        onReorderBlocks={handleReorderBlocks}
        blockSets={blockSets}
        activeBlockSetId={activeBlockSetId}
        onAddBlockSet={handleAddBlockSet}
        onRenameBlockSet={handleRenameBlockSet}
        onDuplicateBlockSet={handleDuplicateBlockSet}
        onRemoveBlockSet={handleRemoveBlockSet}
        onReorderBlockSets={handleReorderBlockSets}
        onSwitchBlockSet={handleSwitchBlockSet}
        onSelectImage={handleSelectImage}
        onFinishClick={handleFinishClick}
        showFinishDialog={showFinishDialog}
        onFinish={handleFinish}
        onCloseFinishDialog={() => setShowFinishDialog(false)}
        onAddStagingImage={handleAddStagingImage}
        onLoadFromAssets={handleLoadFromAssets}
        loadingAssets={loadingAssets}
        blendIframeRef={blendIframeRef}
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
