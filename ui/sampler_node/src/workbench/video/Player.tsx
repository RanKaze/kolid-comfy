import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type VidController, type VidClip, clipAt, fmtTime, vidDuration,
} from './model';
import { compositePlanAt, vidFrameAt, VidFrameGrabber, type VidCompositePlan } from './composite';
import { decodeAudio, vidAudio } from './audio';
import { ensureStrip, holdDecoder, markScrubActivity, releaseDecoder, stripFrame } from './previews';

// ── Player 窗（监视器）───────────────────────────────────────────────────────────────────────
// 播放头落在哪，画面就是最上层视频轨命中的那一段（合成口径"最上层优先"）。声音不走 <video>：
// 它永远静音 —— 音频只从 VidAudio 的 WebAudio 图里出来（音频轨上的片段，含视频拆出来的联动段），
// 这样画面与声音各走各的、互不抢设备。
//
// 播放头走外置 transport（vid.transport）：读数/scrub 条每帧直改 DOM，活片段只在**换段**那一刻
// 走 React（换 src）。播放循环是这里的一支 rAF：播放头按墙上时钟前进，出界（入/出点圈了范围
// 就在出点绕回入点，没圈就在片尾停）→ 每帧顺手对一遍音频（扫进来的片段起播、扫出去的停）与
// 画面漂移（>0.25s 才纠，<video> 自己的时钟在短片段上会抖）。scrub / 换段都把 <video> 拉回
// 正确的源内时刻。

export const VidPlayer: React.FC<{
  vid: VidController;
  visible: boolean;
  /** 游标底下的 Layer 段 key（null = 不在任何 Layer 段上）。宿主拿它决定这一格给画布还是给视频。 */
  onCompLayer?: (key: string | null) => void;
}> = ({ vid, visible, onCompLayer }) => {
  const { project: p, transport, playing } = vid;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readRef = useRef<HTMLSpanElement | null>(null);
  const projectRef = useRef(p);
  projectRef.current = p;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const dur = vidDuration(p);
  const durRef = useRef(dur);
  durRef.current = dur;

  // ── 逐帧合成（Layer 轨压在最上层的那几帧）──────────────────────────────────────────────
  // 计划由 compositePlanAt 在 transport 每一次 tick 上现算：命中 layer 段就向工作台页面发一包
  // 「这一帧的源帧」，页面用那一段自己的图层集合成后回一张图 —— 画面只有那些图层，不叠脚下的
  // 视频帧（空段就是空图）。画面与音频各走各的 —— 主 <video> 没有被停掉：它仍然播着脚下那条
  // 视频轨，给输出定栅格、也当那一轨源帧的取帧器（播放时零额外 seek），声音仍然只从 VidAudio
  // 出来。`compMode` 只在换段/进出合成那一刻走 React；每一帧的回图直改 canvas，不惊动整页。
  const compCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const compModeRef = useRef<{ id: string; name: string } | null>(null);
  const [compMode, setCompMode] = useState<{ id: string; name: string } | null>(null);
  const [hasComp, setHasComp] = useState(false);
  // 宿主只在乎"游标底下是不是 Layer 段、是哪一段"——换段才报一次，播放时不惊动它。
  const compLayerRef = useRef<string | null>(null);
  const onCompLayerRef = useRef(onCompLayer);
  onCompLayerRef.current = onCompLayer;
  const grabberRef = useRef<VidFrameGrabber | null>(null);
  const liveRef = useRef(true);
  const vidRef = useRef(vid);
  vidRef.current = vid;
  const compReq = useRef({
    seq: 0, inflight: 0, inFlight: false, key: '',
    lastReply: 0, pending: null as { plan: VidCompositePlan; t: number } | null,
  });
  const requestRef = useRef<(plan: VidCompositePlan | null, t: number, force?: boolean) => void>(() => {});

  // 活片段：transport 的订阅者比对 id，只有换段才 setState（React 重渲染是稀罕事）。
  const [activeId, setActiveId] = useState<string | null>(() => clipAt(p, transport.get(), 'video')?.id ?? null);
  const activeIdRef = useRef(activeId);
  const active = useMemo(() => (activeId ? p.clips.find(c => c.id === activeId) ?? null : null), [p, activeId]);

  // 拖动中盖在 <video> 上的那一格缩略条 —— **补位图**，真帧 seek 落定前的瞬间替身。
  // 常驻 <img>，ref 直改 src 与显隐：拖动路径上一个 setState 都不发（React 渲染本身
  // 也是每帧的开销，高刷鼠标下每 move 重渲一次 Player 一样能把帧率拖垮）。
  const stripImgRef = useRef<HTMLImageElement | null>(null);
  const stripRef = useRef<string | undefined>(undefined);
  const lastScrubAt = useRef(0);              // 最近一次交互 tick（拖动刚停就不急着撤图）
  const pendingTarget = useRef<number | null>(null);  // 在途 seek 的目标（源内时刻）
  const showStrip = useCallback((u: string) => {
    const img = stripImgRef.current;
    if (!img) return;
    if (stripRef.current !== u) { stripRef.current = u; img.src = u; }
    img.style.display = 'block';
    const v = videoRef.current;
    if (v) v.style.opacity = '0';
  }, []);
  const hideStrip = useCallback(() => {
    stripRef.current = undefined;
    pendingTarget.current = null;
    const img = stripImgRef.current;
    if (img) { img.style.display = 'none'; img.removeAttribute('src'); }
    const v = videoRef.current;
    if (v) v.style.opacity = '1';
  }, []);
  const seek = useCallback((t: number) => {
    // 播放中不去动声源：播放循环每帧都会按游标校正（跳跃 = 大偏差 = 自动重起），
    // 让它自己接手，比这儿每帧 stop 再 start 顺得多。暂停态才立刻消声。
    if (!playingRef.current) vidAudio.stopAll();
    // vid.seek 是合流版（rAF 一帧一落 + interactive 标记），scrub 条与按钮都从这走。
    vid.seek(Math.max(0, t));
  }, [vid]);

  // 起播一段音频：buffer 解码是异步的，等它回来游标早走了 —— 用**回来那一刻**的游标算源内
  // 位置；那一段要是不再覆盖游标就作罢（下一帧自会接手）。
  const startVoice = useCallback(async (id: string, src: string) => {
    const buf = await decodeAudio(src);
    if (!buf || !playingRef.current) return;
    const c = projectRef.current.clips.find(x => x.id === id);
    if (!c) return;
    const cur = transport.get();
    if (!(cur >= c.start && cur < c.start + c.duration)) return;
    vidAudio.start(id, buf, c.offset + (cur - c.start));
  }, [transport]);

  // 一包源帧：逐条抓（主 <video> 优先；其余走隐藏取帧器），同一个 reqId 绑一次回图。
  // 抓取期间来的新请求只留**最后一包**（pending）—— 中间那些帧已经过时，补发出去也只会让
  // 监视器落后更多。回图由下面那个 message 监听按 reqId 收。
  const sendComposite = useCallback(async (plan: VidCompositePlan, q: number) => {
    const r = compReq.current;
    r.inFlight = true;
    const grabber = grabberRef.current ?? (grabberRef.current = new VidFrameGrabber());
    const main = videoRef.current;
    const playing = playingRef.current;
    const sources: { trackId: string; bitmap: ImageBitmap }[] = [];
    try {
      for (const src of plan.sources) {
        const bmp = await grabber.capture(src.clip, q, main, playing);
        if (!liveRef.current) { bmp?.close(); return; }
        if (bmp) sources.push({ trackId: src.trackId, bitmap: bmp });
      }
      const reqId = ++r.seq;
      r.inflight = reqId;
      const sent = vid.blendPost({
        type: 'blend-vid-frame', reqId, t: q, layerKey: plan.layerKey,
        baseTrackId: plan.baseTrackId, sources,
      }, sources.map(s => s.bitmap));
      if (!sent) sources.forEach(s => s.bitmap.close());
    } finally {
      r.inFlight = false;
      const pend = r.pending;
      r.pending = null;
      if (pend && liveRef.current) requestRef.current(pend.plan, pend.t, true);
    }
  }, [vid]);

  const requestComposite = useCallback((plan: VidCompositePlan | null, t: number, force = false) => {
    if (!visible) return;
    const r = compReq.current;
    if (!plan) {
      if (r.key) {
        r.key = '';
        r.pending = null;
        vid.blendPost({ type: 'blend-vid-frame-off' });
      }
      return;
    }
    const q = vidFrameAt(projectRef.current.fps || 30, t);
    const key = plan.layer.id + '@' + q;
    if (!force && key === r.key) return;
    r.key = key;
    if (r.inFlight) { r.pending = { plan, t: q }; return; }
    void sendComposite(plan, q);
  }, [vid, visible, sendComposite]);
  requestRef.current = requestComposite;

  // ── 底片预览（游标不在 Layer 段上）────────────────────────────────────────────────────
  // 视频模式下工作台画布常驻：游标一离开 Layer 段，画布内容就换成当前视频帧。帧只有宿主拿得到
  // （<video> 在这儿），所以逐帧抓了送过去。同一帧号只送一次；抓取期间只留最后一帧，播放不掉队。
  const baseReq = useRef({
    key: '\u0000', on: false, busy: false,
    retryAt: 0,                       // 抓帧失败后的下一次重试时刻（见 sendBase 里那段）
    pending: null as { clip: VidClip | null; q: number; key: string } | null,
  });
  const postBase = useCallback((q: number, bmp: ImageBitmap | null) => {
    const r = baseReq.current;
    const sent = vid.blendPost({ type: 'blend-vid-base', t: q, bitmap: bmp }, bmp ? [bmp] : []);
    if (!sent) {
      // 页面还没挂上（iframe 尚未加载）：这一帧作废，键清回去让下一个 tick 重试。
      r.key = '\u0000';
      r.on = false;
      if (bmp) { try { bmp.close(); } catch { /* gone */ } }
      return;
    }
    r.on = true;
  }, [vid]);
  const sendBase = useCallback(async (clip: VidClip | null, q: number, key: string) => {
    const r = baseReq.current;
    r.busy = true;
    try {
      let bmp: ImageBitmap | null = null;
      if (clip) {
        const grabber = grabberRef.current ?? (grabberRef.current = new VidFrameGrabber());
        bmp = await grabber.capture(clip, q, videoRef.current, playingRef.current);
      }
      // 抓取期间游标又走了：这一帧已经过时，丢掉（别让底片倒着播）。
      if (!liveRef.current || r.key !== key) { bmp?.close(); return; }
      // 有片段却没抓到帧（源还在解码/找不到/被删）：**不能**把底片翻成空白 —— 那会让整个画布
      // 变成空的（"按了播放什么都没有了"就是这个症状）。保留上一帧，键清回去让后面的 tick 重试。
      if (clip && !bmp) {
        r.key = '\u0000';
        r.retryAt = performance.now() + 500;
        return;
      }
      r.retryAt = 0;                      // 拿到帧了：重试窗口清掉
      postBase(q, bmp);
    } finally {
      r.busy = false;
      const pend = r.pending;
      r.pending = null;
      if (pend && liveRef.current) sendBaseRef.current(pend.clip, pend.q, pend.key);
    }
  }, [postBase]);
  const sendBaseRef = useRef<(clip: VidClip | null, q: number, key: string) => void>(() => {});
  sendBaseRef.current = (clip, q, key) => { void sendBase(clip, q, key); };
  const requestBase = useCallback((t: number) => {
    if (!visible) return;
    const p = projectRef.current;
    const c = clipAt(p, t, 'video') ?? null;
    const q = vidFrameAt(p.fps || 30, t);
    // 键里带上片段的起点/源内偏移：剪一下片段，就算帧号没变，取到的源帧也不是同一张。
    const key = c ? `${c.id}@${c.start}@${c.offset}@${q}` : '';
    const r = baseReq.current;
    if (key === r.key) return;
    // 上一次抓帧失败过：等重试窗口过去再试，别每个 tick 都去捅一次解码器。
    if (r.retryAt && performance.now() < r.retryAt) return;
    r.key = key;
    if (r.busy) { r.pending = { clip: c, q, key }; return; }
    sendBaseRef.current(c, q, key);
  }, [visible]);
  const requestBaseOff = useCallback(() => {
    if (!visible) return;
    const r = baseReq.current;
    r.key = '\u0000';                  // 再回到"段外"时第一帧要重新送
    r.retryAt = 0;
    r.pending = null;
    if (!r.on) return;
    r.on = false;
    vid.blendPost({ type: 'blend-vid-base-off' });
  }, [visible, vid]);

  // ── transport 订阅 ── 读数/scrub 条直改；活片段只在换段时走 React；暂停态的画面跟手。
  useEffect(() => {
    const onTick = (interactive?: boolean) => {
      const t = transport.get();
      if (readRef.current) readRef.current.textContent = fmtTime(t);
      const proj = projectRef.current;
      // 这一帧归谁：layer 段在最上 → 交给工作台合成；否则照旧。
      const plan = compositePlanAt(proj, t);
      const modeId = plan ? plan.layer.id : null;
      if ((compModeRef.current?.id ?? null) !== modeId
        || (plan && compModeRef.current?.name !== plan.layer.name)) {
        const next = plan ? { id: plan.layer.id, name: plan.layer.name } : null;
        compModeRef.current = next;
        setCompMode(next);
      }
      // 游标底下那一段的图层集 key（null = 不在任何 Layer 段上）变了就报一次：宿主据此切
      // Layers 面板的作用对象，并决定画布是折图层还是放视频底片。
      const layerKeyNow = plan ? plan.layerKey : null;
      if (layerKeyNow !== compLayerRef.current) {
        compLayerRef.current = layerKeyNow;
        onCompLayerRef.current?.(layerKeyNow);
      }
      const c = clipAt(proj, t, 'video');
      const cid = c?.id ?? null;
      if (cid !== activeIdRef.current) {
        activeIdRef.current = cid;
        setActiveId(cid);
      }
      if (!playingRef.current && c && interactive) {
        // 交互跳转（拖标尺 / 拖 scrub 条）＝ PR 式跟手，两层配合：
        //  * 缩略条那一格**先**盖上去 —— 零延迟的正确画面，seek 落定前的替身；
        //  * 同时把真 <video> 的 currentTime 直接落过去。合流器保证一帧最多一发，
        //    且 Chrome 对"seek 在途又设新值"的处理就是中止旧的改追新的 —— 在途延迟
        //    不累积，画面是**真帧**（全分辨率），不是缩略图的粗步进。
        // 合成帧（plan 非空）没有缩略条可用：那条条上只有视频帧，盖上去反而把图层合成
        // 藏掉。此刻画面等页面回图，主 <video> 照样 seek —— 它现在只是底图的取帧器。
        markScrubActivity();               // 后台抽条让路：解码器此刻归主 <video>
        lastScrubAt.current = performance.now();
        const want = Math.max(0, c.offset + (t - c.start));
        if (!plan) {
          const u = stripFrame(c.src, c.srcDuration, want);
          if (u) showStrip(u);
        }
        const v = videoRef.current;
        if (v && v.dataset.clipId === c.id && v.readyState >= 1) {
          const end = c.offset + Math.max(c.duration - 0.02, 0.02);
          const target = Math.min(Math.max(c.offset, want), end);
          if (Math.abs(v.currentTime - target) > 0.033) {
            pendingTarget.current = target;
            try { v.currentTime = target; } catch { /* not seekable yet */ }
          }
        }
      }
      if (plan) requestBaseOff(); else requestBase(t);
      requestComposite(plan, t);
    };
    // seek 落定 = 真帧已上屏：撤掉缩略条替身。两个守卫防止拖动中闪替身——
    //  * 在途 seek 的目标仍是"游标此刻该在的位置"（中途完成的旧 seek 不算数）；
    //  * 且最近 100ms 内没有新的交互 tick（连续拖动时真帧中途落定也不闪）。
    //  快 seek 落得太快被守卫拦下时，150ms 后补查一次 —— 别让替身图挂着不走。
    const tryHideStrip = () => {
      if (!stripRef.current) return;
      const t = transport.get();
      const c2 = clipAt(projectRef.current, t, 'video');
      const want2 = c2
        ? Math.min(Math.max(c2.offset, c2.offset + (t - c2.start)), c2.offset + Math.max(c2.duration - 0.02, 0.02))
        : null;
      if (pendingTarget.current != null && want2 != null
        && Math.abs(pendingTarget.current - want2) < 0.06) hideStrip();
    };
    const onSeeked = () => {
      if (!stripRef.current) return;
      if (performance.now() - lastScrubAt.current < 100) setTimeout(tryHideStrip, 150);
      else tryHideStrip();
    };
    const v0 = videoRef.current;
    v0?.addEventListener('seeked', onSeeked);
    // 挂载时无条件报一次（含 null = 游标不在任何 Layer 段上）：宿主那边可能还留着上一份文档 /
    // 上一轮的值，而 onTick 只在"换段"时开口，起手正好不在段上就永远不会刷新。
    const plan0 = compositePlanAt(projectRef.current, transport.get());
    compLayerRef.current = plan0 ? plan0.layerKey : null;
    onCompLayerRef.current?.(compLayerRef.current);
    onTick();
    const un = transport.subscribe(onTick);
    return () => { un(); v0?.removeEventListener('seeked', onSeeked); };
  }, [transport, showStrip, hideStrip, requestComposite, requestBase, requestBaseOff]);

  // ── 合成回图 ── 只认 Blend 页那个 window + 当前 reqId。旧包的回图（页面自己也可能在补发）
  // 到得晚就直接扔掉：监视器永远只摆最新一帧。回图是 ImageBitmap，直接搬进 canvas 的
  // bitmaprenderer —— 不经过 2D 上下文，也不留一张中间画布。
  useEffect(() => {
    const onMsg = (event: MessageEvent) => {
      if (event.source !== vid.blendWindow()) return;
      const d = event.data as { type?: string; reqId?: number; bitmap?: ImageBitmap | null } | null;
      if (!d || d.type !== 'blend-vid-composite') return;
      const r = compReq.current;
      const bmp = d.bitmap ?? null;
      if (typeof d.reqId !== 'number' || d.reqId !== r.inflight) { bmp?.close(); return; }
      r.lastReply = performance.now();
      const cv = compCanvasRef.current;
      if (!cv) { bmp?.close(); return; }
      if (!bmp) { setHasComp(false); return; }
      try {
        cv.width = bmp.width;
        cv.height = bmp.height;
        const bctx = cv.getContext('bitmaprenderer');
        if (bctx) {
          bctx.transferFromImageBitmap(bmp);
        } else {
          const ctx = cv.getContext('2d');
          if (!ctx) { bmp.close(); return; }
          ctx.clearRect(0, 0, cv.width, cv.height);
          ctx.drawImage(bmp, 0, 0);
          bmp.close();
        }
        setHasComp(true);
      } catch { try { bmp.close(); } catch { /* gone */ } }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [vid]);

  // 进出合成模式：切走时把那一格藏起来（主 <video> 重新露脸）；切进来时先撤掉拖动替身 ——
  // 那条条上只有视频帧，盖在合成画面上是错的。
  useEffect(() => {
    setHasComp(false);
    if (compMode) hideStrip();
  }, [compMode, hideStrip]);

  // 收摊 / 藏起来：告诉页面这一包作废（它清掉缓存的源帧），底片态也一并退掉，取帧器稍后拆。
  useEffect(() => {
    if (visible) return;
    compReq.current.key = '';
    vid.blendPost({ type: 'blend-vid-frame-off' });
    baseReq.current.on = false;
    baseReq.current.key = '\u0000';
    baseReq.current.pending = null;
    vid.blendPost({ type: 'blend-vid-base-off' });
  }, [visible, vid]);
  useEffect(() => () => {
    liveRef.current = false;
    compReq.current.key = '';
    vidRef.current.blendPost({ type: 'blend-vid-frame-off' });
    vidRef.current.blendPost({ type: 'blend-vid-base-off' });
    grabberRef.current?.dispose();
    grabberRef.current = null;
  }, []);

  // 看门狗：合成模式下页面还没回过任何一张图（iframe 刚挂载、消息比监听器早到），
  // 就按当前帧再要一次。回图正常时它一个请求都不发。
  useEffect(() => {
    if (!visible || !compMode) return;
    const timer = setInterval(() => {
      const r = compReq.current;
      if (r.inFlight || !r.key || performance.now() - r.lastReply < 1800) return;
      const plan = compositePlanAt(projectRef.current, transport.get());
      if (plan) requestRef.current(plan, transport.get(), true);
    }, 800);
    return () => clearInterval(timer);
  }, [visible, compMode, transport]);

  // ── 缩略条预热 ── 当前片段一就位就后台抽条，等用户真拖起来时图已经在手上了。
  useEffect(() => {
    if (active && active.srcDuration > 0) void ensureStrip(active.src, active.srcDuration);
  }, [active]);

  // ── 换段：换源 + 对准源内时刻。 ──
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!active || !activeId) {
      if (v.dataset.clipId) { delete v.dataset.clipId; v.removeAttribute('src'); v.load(); }
      return;
    }
    if (v.dataset.clipId === activeId) return;
    v.dataset.clipId = activeId;
    v.src = active.src;
    const target = Math.max(0, active.offset + (transport.get() - active.start));
    const onMeta = () => { try { v.currentTime = target; } catch { /* not seekable yet */ } };
    if (v.readyState >= 1) onMeta();
    else v.addEventListener('loadedmetadata', onMeta, { once: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // ── 输出栅格：报一次主 <video> 的原生尺寸。 ──
  // 视频模式里没有 Canvas 窗，而图层必须落在某个栅格上（默认图层 = 画布大小）。工作台页面只在
  // 画布还是空的时候认这个尺寸 —— Image 模式里已经排好的画布优先。主 <video> 在 Layer 段压顶时
  // 仍然加载脚下那条视频轨的源，所以它的元数据就是"底图"的尺寸。
  const blendPost = vid.blendPost;
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const announce = () => {
      if (v.videoWidth && v.videoHeight) {
        blendPost({ type: 'blend-vid-grid', width: v.videoWidth, height: v.videoHeight });
      }
    };
    announce();
    v.addEventListener('loadedmetadata', announce);
    v.addEventListener('loadeddata', announce);
    return () => {
      v.removeEventListener('loadedmetadata', announce);
      v.removeEventListener('loadeddata', announce);
    };
  }, [blendPost, activeId]);

  // ── 栅格的兜底来源：游标底下没有视频时，主 <video> 没源、报不出尺寸。 ──
  // Layer 段可以摆在视频之间的空档里，甚至工程里暂时还没有视频 —— 画布就一直是 0，
  // Layers 格里的 Add 会一直等栅格。这里按"游标下命中的第一条视频轨，否则离游标最近的那段"
  // 挑一个视频，单独读一次元数据（preload=metadata，不取帧）报给工作台；主 <video> 已经
  // 有尺寸时一个字不发，避免两个尺寸抢着立画布。
  const fallbackGridSrc = useMemo(() => {
    const t = transport.get();
    let nearest = '';
    let nearestScore = Infinity;
    for (const track of p.tracks) {
      if (track.kind !== 'video') continue;
      for (const c of p.clips) {
        if (c.trackId !== track.id || c.kind !== 'video' || !c.src) continue;
        if (t >= c.start && t < c.start + c.duration) return c.src;
        const score = Math.min(Math.abs(t - c.start), Math.abs(t - (c.start + c.duration)));
        if (score < nearestScore) { nearestScore = score; nearest = c.src; }
      }
    }
    return nearest;
  }, [p, transport]);
  useEffect(() => {
    if (!fallbackGridSrc) return;
    let cancelled = false;
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.muted = true;
    const onMeta = () => {
      if (cancelled) return;
      if (probe.videoWidth && probe.videoHeight) {
        blendPost({ type: 'blend-vid-grid', width: probe.videoWidth, height: probe.videoHeight });
      }
      done();
    };
    const done = () => {
      probe.removeEventListener('loadedmetadata', onMeta);
      probe.removeAttribute('src');
      try { probe.load(); } catch { /* already gone */ }
    };
    // 主 <video> 通常几十毫秒内就报尺寸了；给它一个先手，别让兜底抢在它前面选错尺寸。
    const timer = setTimeout(() => {
      const main = videoRef.current;
      if (cancelled || (main && main.videoWidth > 0)) return;
      probe.addEventListener('loadedmetadata', onMeta, { once: true });
      probe.addEventListener('error', () => { if (!cancelled) done(); }, { once: true });
      probe.src = fallbackGridSrc;
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      probe.removeEventListener('loadedmetadata', onMeta);
      done();
    };
  }, [blendPost, fallbackGridSrc]);

  // ── 播 / 停 ──
  const graceRef = useRef(0);   // 纠偏宽限期（performance.now 截止）：起播/换段/纠偏后给解码器追赶的时间
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) {
      // 起播：撤掉拖动时盖着的那一格缩略条 —— 播放循环自己会用 <video> 的画面对上游标。
      hideStrip();
      graceRef.current = performance.now() + 900;   // 起跑宽限：解码器热身期不纠偏
      holdDecoder();                                 // 播放期间后台抽条全程挂起 —— 解码器是正播的
      void v.play().catch(() => { /* autoplay guards */ });
    } else { v.pause(); vidAudio.stopAll(); releaseDecoder(); }
  }, [playing, activeId, hideStrip]);

  // ── 播放循环 ── 墙上时钟推进播放头（transport.set，不碰 React）；每帧对音频与画面。
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const proj = projectRef.current;
      const total = vidDuration(proj);
      const inP = proj.inPoint;
      const outP = proj.outPoint > proj.inPoint ? proj.outPoint : total;
      let np = transport.get() + dt;
      let jumped = false;
      if (outP > inP && np >= outP) { np = inP; jumped = true; }   // 范围内回绕
      else if (np >= total) {                                     // 片尾停
        vidAudio.stopAll();
        transport.set(total);
        vid.setPlaying(false);
        return;
      }
      transport.set(np);
      // 音频：覆盖游标的段要播在**游标对应的源内位置**上。已经在播的也要每帧对表 ——
      // 回绕、拖动、片段被搬动/裁剪，全都是"该听的位置变了"，偏差超 80ms 就重新起播。
      for (const c of proj.clips) {
        if (c.kind !== 'audio') continue;
        const covers = np >= c.start && np < c.start + c.duration;
        if (!covers) { if (vidAudio.has(c.id)) vidAudio.stop(c.id); continue; }
        if (!vidAudio.has(c.id)) { void startVoice(c.id, c.src); continue; }
        const got = vidAudio.pos(c.id);
        if (jumped || got == null || Math.abs(got - (c.offset + (np - c.start))) > 0.08) {
          void startVoice(c.id, c.src);
        }
      }
      // 画面：只在片段自己的范围内跟。越过片段尾就停在末帧 —— 否则 <video> 会顺着源继续往下
      // 放，画面播的是这段之外的内容，声音却按片段停了，看着就是"声画对不上"。
      // 纠偏只认**精确 currentTime**（fastSeek 在播放中会拽回一个 GOP，越拽越落后），
      // 且必须过宽限期 + 偏差够大才动手 —— 起播/跳转头几百毫秒解码器本来就在追赶，
      // 这时纠偏 = 打断追赶 = 从关键帧重来 = "跳过去之后卡着播几秒"的元凶。
      const v = videoRef.current;
      const av = clipAt(proj, np, 'video');
      if (v && av && v.dataset.clipId === av.id && v.readyState >= 2) {
        const endT = av.offset + Math.max(av.duration - 0.02, 0.02);
        const expected = Math.min(av.offset + (np - av.start), endT);
        if (v.currentTime >= endT - 0.03) { if (!v.paused) v.pause(); }
        else if (v.paused) { void v.play().catch(() => { /* autoplay guards */ }); }
        if (jumped || (performance.now() >= graceRef.current && Math.abs(v.currentTime - expected) > 0.3)) {
          graceRef.current = performance.now() + 600;   // 纠一次给一次宽限，别连环纠
          try { v.currentTime = expected; } catch { /* not seekable */ }
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, startVoice]);

  // ── 收摊：这扇窗被藏起来（切模式 / 切 tab）就停干净。 ──
  useEffect(() => {
    if (visible) return;
    vid.setPlaying(false);
    vidAudio.stopAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const inSet = p.outPoint > p.inPoint;
  const tCtrl: React.CSSProperties = {
    width: 28, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(255,255,255,0.07)', border: '0.5px solid rgba(255,255,255,0.16)',
    borderRadius: 6, color: 'rgba(255,255,255,0.85)', cursor: 'pointer', fontSize: 11, flexShrink: 0,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#0d0d0d', minWidth: 0, overflow: 'hidden' }}>
      {/* 画面。 */}
      <div data-vid-screen="" style={{ flex: 1, minHeight: 0, position: 'relative', background: '#0d0d0d', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <video ref={videoRef} muted playsInline
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: active ? 'block' : 'none' }} />
        {/* 逐帧合成的画面：Layer 段压在最上层时，这一格盖住主 <video>（它继续播脚下那条轨，
            定栅格与取源帧用，声音不在这儿）。像素由工作台页面合成后回传，尺寸是文档画布；
            object-fit 让它按画布比例落在监视器里。段里没有图层时回的是空图 —— 这一格就是空的。 */}
        <canvas ref={compCanvasRef} data-vid-composite="" aria-hidden="true"
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain',
            display: compMode && hasComp ? 'block' : 'none', background: '#000', pointerEvents: 'none',
          }} />
        {/* 拖动途中的画面：缩略条上的一格，盖住 <video> —— 换索引而已，解码器不动。
            常驻节点，src/显隐由 transport 订阅者按 ref 直改（见 showStrip/hideStrip），
            停手对齐完成后撤掉，露出全分辨率的那一帧。 */}
        <img ref={stripImgRef} data-vid-strip="" alt="" decoding="async"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none', display: 'none' }} />
        {!active && !compMode && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.28)', fontSize: 12, textAlign: 'center', padding: 20 }}>
            No clip under the playhead.<br />Drop videos onto the Tracks window below.
          </div>
        )}
        {(active || compMode) && (
          <div style={{ position: 'absolute', left: 8, top: 8, padding: '2px 8px', borderRadius: 6, background: 'rgba(0,0,0,0.55)', color: 'rgba(255,255,255,0.8)', fontSize: 10, maxWidth: '70%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {compMode ? compMode.name : active?.name}
          </div>
        )}
        {inSet && (
          <div style={{ position: 'absolute', right: 8, top: 8, padding: '2px 8px', borderRadius: 6, background: 'rgba(10,132,255,0.25)', color: '#9ecbff', fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
            I {fmtTime(p.inPoint)} · O {fmtTime(p.outPoint)}
          </div>
        )}
      </div>
      {/* 走带控制。这一条**不**让工作台画布盖住（EditPhase 量画布高度时按它上沿截断）——
          选中 Layer 段时画布只占上面那块画面，按钮留在原位。 */}
      <div data-vid-transport="" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderTop: '0.5px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
        <button style={tCtrl} title="Go to In point (or start)" onClick={() => seek(inSet ? p.inPoint : 0)}>⏮</button>
        <button style={{ ...tCtrl, width: 34 }} title={playing ? 'Pause' : 'Play (loops within In/Out when set)'}
          onClick={() => vid.setPlaying(!playing)}>
          {playing ? '⏸' : '▶'}
        </button>
        <button style={tCtrl} title="Stop — pause and return to the In point" onClick={() => { seek(inSet ? p.inPoint : 0); vid.setPlaying(false); }}>⏹</button>
        {/* 读数靠右：右边原来那条进度条撤掉了 —— 拖游标在时间线的标尺上做（那里才是它的家），
            监视器下面再放一条重复的进度条只会让人以为它是另一个控件。 */}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'rgba(255,255,255,0.65)', fontVariantNumeric: 'tabular-nums' }}>
          <span ref={readRef}>{fmtTime(transport.get())}</span>
          <span style={{ color: 'rgba(255,255,255,0.3)' }}> / {fmtTime(dur)}</span>
        </span>
      </div>
    </div>
  );
};
