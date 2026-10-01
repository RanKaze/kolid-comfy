import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import EditPhase from './components/EditPhase';
import type { Tab, ServerConfig, StatusResponse, PipelineBlock, DetailerBlockParams, InterfaceBlockParams, StagingItem, InterfaceInfo, PipelinePackageInfo, BlockSet, PendingQuery, ActionLogEntry, PipelineSettings, InterfaceMeta } from './types';
import { EMPTY_PIPELINE_SETTINGS, firstDetailerFlag } from './types';

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
  const [staging, setStaging] = useState<StagingItem[]>([]);
  const [showFinishDialog, setShowFinishDialog] = useState(false);
  const [finished, setFinished] = useState(false);
  const [syncingTab, setSyncingTab] = useState(false);
  const syncingTabRef = useRef(false);
  useEffect(() => { syncingTabRef.current = syncingTab; }, [syncingTab]);
  // Track whether the latest prompt-confirmed was consumed by handleTabChange sync
  const consumedPromptConfirmedRef = useRef(false);
  const [interfaces, setInterfaces] = useState<InterfaceInfo[]>([]);
  const [pipelinePackages, setPipelinePackages] = useState<PipelinePackageInfo[]>([]);
  /** Draw 页 Pipeline Settings：选中项 + 按 pipeline 名字绑定的五个 override（后端落盘） */
  const [pipelineSettings, setPipelineSettings] = useState<PipelineSettings>(EMPTY_PIPELINE_SETTINGS);
  /** Interface tab 给每个 interface 配置的持久化标注：端口改名 / 模式开关 / block 端口绑定 */
  const [interfaceMeta, setInterfaceMeta] = useState<InterfaceMeta>({});
  /** 此刻真正加载在节点上的 pipeline 名字（'' = 节点输入口那条 = [Default]） */
  const [loadedPipelineName, setLoadedPipelineName] = useState('');
  // Processor 运行（工作台 Tools → Processor 发起，现在也是 interface 唯一的执行入口）：
  // 走后端的 interface_status，有自己的轮询与回程通道 —— 结果按端口送回工作台落位。
  const [processorRunning, setProcessorRunning] = useState(false);
  const processorRunRef = useRef<number | null>(null);
  // A Query block parked mid-run: the chain is blocked until the user answers (or cancels).
  const [pendingQuery, setPendingQuery] = useState<PendingQuery | null>(null);
  /**
   * 最近 32 条行为记录。工作台画布顶部那颗常显的状态药丸已经撤掉，它每次说话都改发一条
   * 'blend-log' 到这里；本页自己触发的动作（跑 preset / Execute / 取消 / 载入 / Query）也写进
   * 同一份列表，由 Context 标题行的 Log 按钮展开。
   */
  const [actionLog, setActionLog] = useState<ActionLogEntry[]>([]);
  const pushLog = useCallback((text: string, kind: ActionLogEntry['kind'] = '') => {
    if (!text) return;
    setActionLog(prev => [...prev, { at: Date.now(), text, kind }].slice(-32));
  }, []);
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
  // 输入侧显存封顶四件套 —— pixels 是**上限**（只压不涨），0 = 不设上限
  const [refPixelsVal, setRefPixelsVal] = useState(1048576);
  const [refAlignVal, setRefAlignVal] = useState(8);
  const [tgenPixelsVal, setTgenPixelsVal] = useState(1048576);
  const [tgenAlignVal, setTgenAlignVal] = useState(8);
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
        setRefPixelsVal(data.ref_pixels ?? 1048576);
        setRefAlignVal(data.ref_align ?? 8);
        setTgenPixelsVal(data.tgen_pixels ?? 1048576);
        setTgenAlignVal(data.tgen_align ?? 8);
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
        setPipelineSettings(data.pipeline_settings ?? EMPTY_PIPELINE_SETTINGS);
        setInterfaceMeta(data.interface_meta ?? {});
        setLoadedPipelineName(data.loaded_pipeline_name ?? '');
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

  // Fetch the staging pool on mount (the workbench strip + every picker read it).
  // hidden 条目（run/接口的生成产出、Original 种子）只供内部按 id 取图 —— 工作区
  // 镜像（本条带 + Blend 工作台 + 所有选择器）只展示用户主动拖入/导入的图。
  const refreshStaging = useCallback((): Promise<void> => {
    return fetch('/api/staging')
      .then(r => r.json())
      .then(data => {
        if (data.staging) setStaging(data.staging.filter((s: StagingItem) => !s.hidden));
      })
      .catch(() => {});
  }, []);

  useEffect(() => { refreshStaging(); }, [refreshStaging]);

  // 后端图池的一切变更走同一条 promise 链：打开/切换工程会整池 replace 上传（每条都是
  // 几 MB 的 base64，服务端逐张 decode 要跑好几秒），这条链若和拖文件、guidance 卡、
  // 单条移除并行跨连接竞，后端最后留下的池会取决于完成顺序而不是发起顺序。串行化保证
  // 「最后发起的 = 最后落地的」。
  const stagingChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const queueStaging = useCallback((op: () => Promise<unknown>) => {
    const run = () => op().catch(() => {});
    stagingChainRef.current = stagingChainRef.current.then(run, run);
  }, []);

  // Push staging list changes into the Blend workbench (its strip renders from this mirror).
  useEffect(() => {
    blendIframeRef.current?.contentWindow?.postMessage({
      type: 'blend-staging',
      items: staging,
    }, '*');
  }, [staging]);

  // Processor 工具的可选接口（Interface tab 里开着 Processor 模式的那些）→ 工作台。
  // 两个时机都必须推，缺一个就会「枚举看起来不刷新」：
  //   (a) 列表本身变了 —— 开关 / 改名 / 端口改动（见下面那个 effect）；
  //   (b) 工作台 iframe load 完来要 init 时（见 blend-request-init 分支）—— 首次进前端
  //       时 (a) 常常跑在 iframe 的 document 就绪之前，那条消息会打进 about:blank 里丢掉，
  //       Processor 的 Interface 枚举就一直空着，只有回 Interface tab 重拨一下开关才刷出来。
  // modes 以 interfaceMeta 为准：开关一拨，前端这份 meta 立刻是真值，而 interfaces 是后端
  // 快照（toggle 只 POST 配置、不重拉 /api/package），照它过滤会把刚打开的接口又滤掉。
  const pushProcessors = useCallback(() => {
    const win = blendIframeRef.current?.contentWindow;
    if (!win) return;
    const processors = interfaces
      .filter(itf => {
        const modes = interfaceMeta[itf.name]?.modes;
        return modes ? !!modes.processor : !!itf.modes?.processor;
      })
      .map(itf => ({
        name: itf.name,
        index: interfaces.indexOf(itf),
        start_ports: itf.start_ports,
        end_ports: itf.end_ports,
        // image/mask 出口的默认落位与入口的默认来源:工作台拿它们当 Processor 小窗里对应行的
        // 初值 (meta 里的 output_targets / input_sources,/api/package 已按名字合并进 itf)。
        output_targets: itf.output_targets || interfaceMeta[itf.name]?.output_targets || {},
        input_sources: itf.input_sources || interfaceMeta[itf.name]?.input_sources || {},
      }));
    win.postMessage({ type: 'blend-processors', processors }, '*');
  }, [interfaces, interfaceMeta]);

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
          // 工作台的 Cancel 打断了本次运行：通知工作台复位，本页状态回 idle。
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
        // 一条 preset 绑定的 pipeline 是在 run 循环里现加载的：名字与架构都会跟着变，
        // 轮询顺手同步，前端就不用再拉一次 config。
        if (typeof data.loaded_pipeline_name === 'string') setLoadedPipelineName(data.loaded_pipeline_name);
        if (data.architecture !== undefined) setArchitecture(data.architecture ?? null);
        if (st === 'running') {
          post({ status: 'running', ...progress });
        } else if (st === 'error') {
          post({ status: 'error', error: data.error || 'Detailer failed' });
          setError(data.error || 'Detailer failed');
        } else if (st === 'done') {
          post({ status: 'done' });
          // The result never becomes the pipeline image by itself: it lands in the staging pool
          // and then either is written back over the layer it came from (a layer-initiated
          // Generate) or dropped on as a new layer (a preset run).
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

  // Flush the prompt editor into prompt_server. The detailer reads the prompt from there, so a
  // A run must not start while the prompt editor still holds unsaved edits.
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
  // initial image lands in the pool as a HIDDEN 'Original' entry — hidden entries never
  // reach the workbench strip, so the seed must read the full /api/staging list, falling
  // back to the newest user item.
  const seedBlendCanvas = useCallback(async () => {
    const iframe = blendIframeRef.current;
    if (!iframe?.contentWindow) return;
    let full: StagingItem[] = [];
    try {
      const r = await fetch('/api/staging').then(r => r.json());
      full = (r?.staging || []) as StagingItem[];
    } catch { /* nothing to seed with */ }
    if (!full.length) return;
    const item = full.find(s => s.name === 'Original')
      ?? stagingRef.current[stagingRef.current.length - 1]
      ?? full[full.length - 1];
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
          // attribute 面表：图层那条只剩表键，共享的一面只编码一份，所以这张表必须跟着包走 ——
          // 漏转发 = 后端认不出键 = 条带上归它重放的那一段整段消失（静默，画面少了蒙版/贴片）。
          attributes: body.attributes ?? [],
          width: body.width,
          height: body.height,
          mask: body.mask,
          // detailer：blendCanvas 已合成好的 PNG dataURL（与预览同源、直通 alpha）。
          // 后端直接拿它当管线输入，跳过按 layers 的二次合成。漏转发 = 静默回退。
          composite: body.composite ?? null,
          extra_prompt: body.extra_prompt,
          // Run 设置（以及 ▶ 预设胶囊）选的 preset：决定后端跑哪条 block 链，
          // Enable Mask 总闸也随这条链解析。之前漏转发 —— 对话框的选择被静默丢弃。
          preset_id: body.preset_id ?? null,
          // Detector 工具：source 合成图 + 可选的裁剪用 mask + 表达式参数，整体一个对象。
          detect: body.detect ?? null,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Blend action failed');
        reply(false, { error: data.error || 'Blend action failed' });
        return;
      }
      if (body.action === 'detect') {
        // 检测是同步的：mask 直接随响应回来，转手交给工作台落地（destination 在那边解释）。
        reply(true, { mask: data.mask || null });
      } else if (body.action === 'blend') {
        reply(true, {});
        // 合成结果只作为新的智能对象图层放回画布顶层（图层自带像素 dataURL，
        // 非破坏、可继续改 transform / 画 mask）；不再自动归档进工作区 ——
        // 工作区只收用户主动拖入的图。画布原有图层与 Mask 层一律不动。
        blendIframeRef.current?.contentWindow?.postMessage(
          { type: 'blend-add-layer', smart: true,
            items: [{ name: data.name || 'Blend', src: data.image }],
            note: 'Blend result added as a new smart layer' }, '*');
      } else if (body.action === 'tag' || body.action === 'clear_tag') {
        // clear_tag returns an empty tag/tags/custom/temporary — pushing it through the same
        // auto-tag channel is exactly how a real tag lands, so the editor clears its parsing
        // tags and its Temporary Prompts alike.
        reply(true, { tag: data.tag });
        setPromptReady(true);
        // Tag output belongs to the prompt stage: push it into the prompt editor's tags.
        setTimeout(() => {
          promptIframeRef.current?.contentWindow?.postMessage({
            type: 'auto-tag',
            tag: data.tag,
            tags: data.tags || [],
            custom: data.custom || '',
            // What the tagger produced that matches no known prompt. Landing these as
            // temporary (not custom) keeps a tag one-pass, exactly like prompt_parsing does.
            temporary: Array.isArray(data.temporary) ? data.temporary : undefined,
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
   * The difference from a preset run is what is sent: a preset run composites the
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

  // Processor run initiated by the workbench: upload the input images as hidden staging
  // entries, then kick an offline interface execution. Results come back through the poller.
  // Must stay ABOVE the postMessage listener below — the listener's dep array reads this
  // const, and a declaration below it is a TDZ ReferenceError on the first render.
  const handleProcessorRun = useCallback(async (data: any) => {
    const win = blendIframeRef.current?.contentWindow;
    if (!win) return;
    const idx = typeof data.interface_index === 'number' ? data.interface_index : -1;
    const inputs = Array.isArray(data.inputs) ? data.inputs : [];
    if (processorRunRef.current !== null) {
      win.postMessage({ type: 'blend-processor-result', ok: false, error: 'Another interface execution is already running' }, '*');
      return;
    }
    if (idx < 0 || idx >= interfaces.length) {
      win.postMessage({ type: 'blend-processor-result', ok: false, error: 'Processor interface is missing (package disconnected?)' }, '*');
      return;
    }
    processorRunRef.current = idx;
    pushLog(`Run processor 「${interfaces[idx]?.name || '#' + idx}」`);
    try {
      const image_keys: Record<string, string> = {};
      for (const inp of inputs) {
        if (!inp || typeof inp.dataUrl !== 'string' || !inp.dataUrl) continue;
        const res = await fetch('/api/staging', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            images: [inp.dataUrl],
            names: [`in: value${inp.port}`],
            hidden: true,
          }),
        });
        const j = await res.json();
        if (j?.success && j.added?.[0]?.id) image_keys[String(inp.port)] = j.added[0].id;
      }
      setProcessorRunning(true);
      await fetch('/api/execute_interface', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          interface_index: idx,
          manual_values: data.manual_values || {},
          exec_options: { offline: true, image_keys },
        }),
      });
    } catch (e: any) {
      setProcessorRunning(false);
      processorRunRef.current = null;
      win.postMessage({ type: 'blend-processor-result', ok: false, error: e?.message || String(e) }, '*');
    }
  }, [interfaces, pushLog]);

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
        queueStaging(() => refreshStaging());
      } else if (event.data?.type === 'blend-action') {
        // Blend workbench action: blend (archive) / tag / detailer
        handleBlendAction(event.data);
      } else if (event.data?.type === 'blend-layer-generate') {
        // Generate from the layer row's context menu: that layer in, that layer out.
        handleLayerGenerate(event.data);
      } else if (event.data?.type === 'blend-processor-run') {
        // Processor 工具的 Run：输入图上传为隐藏条目 → 离线 interface 执行，轮询回程。
        void handleProcessorRun(event.data);
      } else if (event.data?.type === 'blend-cancel-run') {
        // 工作台的 Cancel（运行中才浮出）—— 打断当前 run
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
          // Detector 工具总闸：节点没连 detector 时，工作台整块 Detector 工具隐藏。
          hasDetector: !!config?.has_detector,
          // 激活 tab 的 Enable Mask 总闸：关 = 整幅是工作区，Run 不要求先画 Mask 层。
          mask_required: firstDetailerFlag(blockSets, activeBlockSetId, 'enable_mask', true),
          staging: stagingRef.current,
        }, '*');
        // The Generate dialog's Pipeline Preset enum picks which block set runs the generate, so
        // the workbench needs every set's id/name plus the tab that is active right now.
        iframe.contentWindow.postMessage({
          type: 'blend-pipeline-presets',
          presets: blockSets.map((s: BlockSet) => ({
            id: s.id, name: s.name,
            enable_mask: firstDetailerFlag(blockSets, s.id, 'enable_mask', true),
            enable_fit: firstDetailerFlag(blockSets, s.id, 'enable_fit', false),
          })),
          active_id: activeBlockSetId,
        }, '*');
        // Processor 的 Interface 枚举同理：iframe 只在 load 时要一次，列表推送若早于它
        // 就绪就已经丢在 about:blank 里了 —— 这里补一次，等于和 presets 一样对齐 init。
        pushProcessors();
        seedBlendCanvas();
      } else if (event.data?.type === 'blend-staging-upload') {
        // 工作台拖文件/Processor 产出：批量追加进图池。replace=true 是工作台换工程的
        // 整池换水（.cud 导入或 tab 激活）：后端先清可见条目、再按 ids 原样落回，
        // 这时空 images 也要发 —— 那是一次纯清空。
        const images: string[] = Array.isArray(event.data.images) ? event.data.images : [];
        const names: string[] = Array.isArray(event.data.names) ? event.data.names : [];
        const ids: string[] = Array.isArray(event.data.ids) ? event.data.ids : [];
        const replace = event.data.replace === true;
        if (!images.length && !replace) return;
        queueStaging(() => fetch('/api/staging', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            images, names,
            ...(ids.length ? { ids } : {}),
            ...(replace ? { replace: true } : {}),
            name: 'Loaded',
          }),
        }).then(() => refreshStaging()));
      } else if (event.data?.type === 'blend-guidance-card') {
        // Guidances 栈的那一张总卡（Layers 合成 + 整个 guidance 栈）。后端按保留 id
        // staging_guidance 原地换像素 —— 工作区永远只有这一张；image 为空 = 撤回它
        // （栈被清空 / 全隐藏）。条目是真 staging：可删、可 <image_id:…> 引用、可当参考图。
        queueStaging(() => fetch('/api/guidance_card', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: event.data.image || null, name: event.data.name || 'Guidance' }),
        }).then(() => refreshStaging()));
      } else if (event.data?.type === 'blend-staging-remove') {
        const sid = typeof event.data.id === 'string' ? event.data.id : '';
        if (!sid) return;
        queueStaging(() => fetch('/api/staging_remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sid }),
        }).then(() => refreshStaging()));
      } else if (event.data?.type === 'blend-log') {
        // 工作台画布上那颗常显的状态药丸撤掉了：它每次说话改发一条到这里，攒成 Log 面板
        // （Context 标题行 → Log）。kind 只可能是 '' / 'success' / 'error'，别的按普通行显示。
        const t = typeof event.data.text === 'string' ? event.data.text : '';
        const k = event.data.kind === 'success' || event.data.kind === 'error' ? event.data.kind : '';
        pushLog(t, k);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [config, blockSets, activeBlockSetId, handleBlendAction, handleLayerGenerate, handleProcessorRun, seedBlendCanvas, refreshStaging, queueStaging, pushLog, pushProcessors]);

  // Push preset (tab) changes to the Blend workbench as they happen. The iframe only asks for
  // init once, on load — without this effect a tab created / renamed / deleted / switched after
  // that would never reach the Generate dialog's Pipeline Preset enum.
  useEffect(() => {
    const iframe = blendIframeRef.current;
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage({
      type: 'blend-pipeline-presets',
      presets: blockSets.map((s: BlockSet) => ({
        id: s.id, name: s.name,
        enable_mask: firstDetailerFlag(blockSets, s.id, 'enable_mask', true),
        enable_fit: firstDetailerFlag(blockSets, s.id, 'enable_fit', false),
      })),
      active_id: activeBlockSetId,
    }, '*');
  }, [blockSets, activeBlockSetId]);

  // Push processor-mode interfaces to the workbench whenever they change: the Processor tool's
  // enum picks from this list, and its source/destination pickers read the (renamed) ports.
  useEffect(() => {
    pushProcessors();
  }, [pushProcessors, interfaces, interfaceMeta]);

  // Processor 轮询：interface_status 每跳一次就同步给工作台（进度条走 blend-run-status 同款
  // 语义），done 时按 interface_result_meta 把隐藏条目逐端口发回去。started 后第一次 status
  // 可能还是 idle（action 还没被取走），所以 idle 不收尾、running 见过一次才算数。
  useEffect(() => {
    if (!processorRunning) return;
    let cancelled = false;
    let seenRunning = false;
    const poll = async () => {
      try {
        const data: StatusResponse = await fetch('/api/status').then(r => r.json());
        if (cancelled) return;
        const st = data.interface_status || 'idle';
        const win = blendIframeRef.current?.contentWindow;
        if (win) {
          win.postMessage({
            type: 'blend-run-status',
            status: st === 'running' ? 'running' : st,
            current: data.interface_current_step || 0,
            total: data.interface_total_steps || 0,
          }, '*');
        }
        if (st === 'running') seenRunning = true;
        if (st === 'idle' && !seenRunning) return;
        if (st === 'done' || st === 'error' || st === 'idle') {
          cancelled = true;
          setProcessorRunning(false);
          const idx = processorRunRef.current;
          processorRunRef.current = null;
          if (!win) return;
          if (st === 'done') {
            const meta = (data.interface_result_meta || []) as { key: string; port: number; type: string; name: string }[];
            const full = await fetch('/api/staging').then(r => r.json()).catch(() => null);
            const list = (full?.staging || []) as StagingItem[];
            const results = meta
              .map(m => {
                const item = list.find((s: StagingItem) => s.id === m.key);
                return item ? { port: m.port, type: m.type, name: m.name, id: item.id, src: item.src, width: item.width, height: item.height } : null;
              })
              .filter(Boolean);
            win.postMessage({ type: 'blend-processor-result', ok: true, interface_index: idx, results }, '*');
            pushLog(`Processor done — ${results.length} result${results.length === 1 ? '' : 's'}`, 'success');
          } else {
            win.postMessage({ type: 'blend-processor-result', ok: false, cancelled: st === 'idle', error: data.interface_error || 'Processor failed' }, '*');
            if (st === 'error') pushLog(`Processor failed: ${data.interface_error || 'error'}`, 'error');
          }
          clearInterval(interval);
        }
      } catch { /* keep polling */ }
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(interval); };
  }, [processorRunning, pushLog]);

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
        // 切换即加载：edit 设置按架构渲染、override 按名字取，两者都要跟着刷新
        fetch('/api/config').then(r => r.json()).then((cfg: ServerConfig) => {
          setArchitecture(cfg.architecture ?? null);
          setLoadedPipelineName(cfg.loaded_pipeline_name ?? '');
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

  const handleGlobalParamChange = useCallback((key: 'mask_grow' | 'mask_blur' | 'crop_reserve' | 'pixels' | 'align'
    | 'ref_pixels' | 'ref_align' | 'tgen_pixels' | 'tgen_align', value: number) => {
    if (key === 'mask_grow') setMaskGrow(value);
    if (key === 'mask_blur') setMaskBlur(value);
    if (key === 'crop_reserve') setCropReserve(value);
    if (key === 'pixels') setPixelsVal(value);
    if (key === 'align') setAlignVal(value);
    if (key === 'ref_pixels') setRefPixelsVal(value);
    if (key === 'ref_align') setRefAlignVal(value);
    if (key === 'tgen_pixels') setTgenPixelsVal(value);
    if (key === 'tgen_align') setTgenAlignVal(value);
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
   * blend-action, which starts the status poller.
   */
  const handleRunPreset = useCallback((presetId: string) => {
    setError(null);
    blendIframeRef.current?.contentWindow?.postMessage({ type: 'blend-run-preset', preset_id: presetId }, '*');
  }, []);

  /** Answer a parked Query block. The selection is the prompt UI's RAW choice — the run
   *  merges it and runs its programs, exactly like a prompt block's preset. A Persistent
   *  Query overwrites its bound preset with this same selection, server-side, inside the
   *  POST — that's why the caller awaits us before refreshing the preset summaries. */
  const handleQueryAnswer = useCallback(async (selection: Record<string, any>) => {
    setPendingQuery(null);
    pushLog('Query confirmed — the chain continues');
    try {
      await fetch('/api/query_answer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selection }),
      });
    } catch { /* the run aborts on its own if the answer never lands */ }
  }, [pushLog]);

  /** Closing the Query dialog aborts the whole chain — the user chose to stop, not to skip. */
  const handleQueryCancel = useCallback(async () => {
    setPendingQuery(null);
    pushLog('Query closed — the whole chain was aborted', 'error');
    try {
      await fetch('/api/query_answer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancelled: true }),
      });
    } catch { /* as above */ }
  }, [pushLog]);

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
    persistSets([...blockSets, { id: newId, name: `${src.name} copy`, blocks: copy, pipeline_name: src.pipeline_name }], newId);
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

  // Pipeline Settings（选中项 + 按名字的 override）整体落盘在后端 blocks_sets.json 里。
  const handlePipelineSettingsChange = useCallback((next: PipelineSettings) => {
    setPipelineSettings(next);
    fetch('/api/update_config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipeline_settings: next }),
    }).catch(() => {});
  }, []);

  // Interface meta（端口改名 / 模式开关 / block 端口绑定）同一落盘路径，按 interface 名字索引。
  const handleChangeInterfaceMeta = useCallback((next: InterfaceMeta) => {
    setInterfaceMeta(next);
    fetch('/api/update_config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interface_meta: next }),
    }).catch(() => {});
  }, []);

  // preset 行 ⚙：这套链跑起来时用哪条 pipeline（按名字绑，run 时解析）。
  const handleSetPresetPipeline = useCallback((setId: string, pipelineName: string) => {
    persistSets(blockSets.map(s => s.id === setId ? { ...s, pipeline_name: pipelineName } : s), activeBlockSetId);
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
        promptIframeRef={promptIframeRef}
        blocks={blocks}
        architecture={architecture}
        maskGrow={maskGrow}
        maskBlur={maskBlur}
        cropReserve={cropReserve}
        pixelsVal={pixelsVal}
        alignVal={alignVal}
        refPixelsVal={refPixelsVal}
        refAlignVal={refAlignVal}
        tgenPixelsVal={tgenPixelsVal}
        tgenAlignVal={tgenAlignVal}
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
        onFinishClick={handleFinishClick}
        showFinishDialog={showFinishDialog}
        onFinish={handleFinish}
        onCloseFinishDialog={() => setShowFinishDialog(false)}
        blendIframeRef={blendIframeRef}
        interfaces={interfaces}
        interfaceMeta={interfaceMeta}
        onChangeInterfaceMeta={handleChangeInterfaceMeta}
        pipelinePackages={pipelinePackages}
        pipelineSettings={pipelineSettings}
        loadedPipelineName={loadedPipelineName}
        onSwitchPipeline={handleSwitchPipeline}
        onPipelineSettingsChange={handlePipelineSettingsChange}
        onSetPresetPipeline={handleSetPresetPipeline}
        actionLog={actionLog}
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
