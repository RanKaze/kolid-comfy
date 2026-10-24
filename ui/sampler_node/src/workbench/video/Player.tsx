import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type VidController, type VidClip, audioAudible, clipAt, clipAtSolo, fmtTime, vidDuration,
} from './model';
import { compositePlanAt, sourceTime, warmAheadOf, type VidCompositePlan } from './composite';
import { decodeAudio, vidAudio } from './audio';
import { ensureStrip, holdDecoder, markScrubActivity, releaseDecoder, stripFrame } from './previews';
import { acquireAudioSlot, buildStereoProbe, releaseAudioSlot, type AudioProbe } from './audioFocus';
import { markRender } from './perf';

// 播放器的电平探头:全部声源在 vidAudio.master 汇流,一只探头管整条时间线,缓存会话级一份。
let playerProbe: AudioProbe | null = null;
const probeOfPlayer = (): AudioProbe => (playerProbe ??= buildStereoProbe(vidAudio.node()));

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
  markRender('VidPlayer');
  const { project: p, transport, playing } = vid;
  const setPlaying = vid.setPlaying;      // useState setter,引用恒稳 —— 放进 effect 依赖不会抖
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readRef = useRef<HTMLSpanElement | null>(null);
  const projectRef = useRef(p);
  projectRef.current = p;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  // solo 快照：transport 订阅者与播放循环都要读它（每帧），走 ref 不进渲染图。
  const soloRef = useRef(vid.solo);
  soloRef.current = vid.solo;
  // mute 快照：同上（每帧都要问"这条轨静音了吗"）。
  const muteRef = useRef(vid.mute);
  muteRef.current = vid.mute;
  const dur = vidDuration(p);
  const durRef = useRef(dur);
  durRef.current = dur;

  // ── 逐帧合成（Layer 轨压在最上层的那几帧）──────────────────────────────────────────────
  // 计划由 compositePlanAt 在 transport 每一次 tick 上现算：命中 layer 段就向工作台页面发一包
  // 「这一帧该看什么」，页面用那一段自己的图层集合成后回一张图 —— 画面只有那些图层，不叠脚下的
  // 视频帧（空段就是空图）。画面与音频各走各的 —— 主 <video> 没有被停掉：它仍然播着脚下那条
  // 视频轨，给输出定栅格，声音仍然只从 VidAudio 出来。`compMode` 只在换段/进出合成那一刻走
  // React；每一帧的回图直改 canvas，不惊动整页。
  // **帧不再从这里抓。** 源帧由工作台页面自己的镜像 <video> 播放（见 blend_node 的 vidSrcSync）：
  // 这一侧只发"哪条轨、源在哪、这一帧源内第几秒"，一个像素都不过界。早先那条路每帧要给每条
  // 被引用的轨做一次精确 seek（100ms 级）再把整幅位图 transfer 过去 —— 播放时的顿感与换段时
  // 那一秒空白都出在那儿。
  const compCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const compModeRef = useRef<{ id: string; name: string } | null>(null);
  const [compMode, setCompMode] = useState<{ id: string; name: string } | null>(null);
  const [hasComp, setHasComp] = useState(false);
  // 宿主只在乎"游标底下是不是 Layer 段、是哪一段"——换段才报一次，播放时不惊动它。
  const compLayerRef = useRef<string | null>(null);
  const onCompLayerRef = useRef(onCompLayer);
  onCompLayerRef.current = onCompLayer;
  const liveRef = useRef(true);
  const vidRef = useRef(vid);
  vidRef.current = vid;
  const compReq = useRef({
    seq: 0, inflight: 0, key: '',
    /** 在途那一包说的 layerKey —— 回包按它维护 frameless 集(compLayerRef 在回包到达时
     *  可能已跟着游标挪到别的段,不能拿它对账)。 */
    layerKey: '',
    lastReply: 0,
    /** 最新想发的那一包（上一包还在路上时压在这儿，回包一到就放行）。 */
    want: null as { plan: VidCompositePlan; q: number; key: string } | null,
    /** 上一包的发出时刻与往返时延（ms，滑动平均）—— 发帧节奏按它走，见 requestComposite。 */
    sentAt: 0, rtt: 0,
  });
  const pumpRef = useRef<() => void>(() => {});
  const requestRef = useRef<(plan: VidCompositePlan | null, t: number, force?: boolean) => void>(() => {});

  // 活片段：transport 的订阅者比对 id，只有换段才 setState（React 重渲染是稀罕事）。
  // 起手就按 solo/mute 找 —— 静音的轨不显示，视频 solo 亮着时只认 solo 轨上的段。
  const [activeId, setActiveId] = useState<string | null>(() =>
    clipAtSolo(p, transport.get(), vid.solo.video, vid.mute)?.id ?? null);
  const activeIdRef = useRef(activeId);
  const active = useMemo(() => (activeId ? p.clips.find(c => c.id === activeId) ?? null : null), [p, activeId]);

  // 监视器空着的时候，告诉用户是"本来就没段"还是"有段但被静音/solo 挡了" ——
  // 否则 mute 掉唯一一条视频轨，屏幕上只剩一句 "No clip under the playhead"，看着像坏了。
  const [blocked, setBlocked] = useState<'none' | 'muted' | 'solo'>('none');
  const blockedRef = useRef(blocked);

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

  // 一包「这一帧该看什么」：同一个 reqId 绑一次回图。发包是**同步**的（帧从这里过不了界了）。
  // 发得比页面画得快不要紧 —— 页面把合成与回图都并到同一口 rAF，一帧最多画一次、只认最新的
  // 那一包；这里只拦"同一帧连发两包"。
  // frameless 集:页面报过"这一段的图层集不绑视频帧"(frameless:true)的 layerKey —— 这些段的
  // 合成与 t 无关，**后续帧一个包都不该发**（图层集后来绑了帧，页面会报 frameless:false 自愈）。
  const compFrameless = useRef(new Set<string>());
  // 页面报过"这段实际吃了哪几条轨的帧"—— 只作诊断（帧不再由这一侧抓，见下面的说明）。
  const compUsedTracks = useRef(new Map<string, Set<string>>());
  /** 已经报过的预热（layerKey@at）：同一段只报一次，别每个 tick 都发。 */
  const warmSent = useRef('');
  // 性能探针(只读,诊断用):合成发包端的次数/回包分类,与页面 __vidPerf 配对。
  const compPerf = useRef({ sends: 0, grabs: 0, grabMs: 0, cachedReplies: 0, bitmapReplies: 0, baseSends: 0, rtt: 0 });
  (window as unknown as { __compPerf?: unknown }).__compPerf = compPerf.current;
  const sendComposite = useCallback((plan: VidCompositePlan, q: number) => {
    const r = compReq.current;
    const reqId = ++r.seq;
    r.inflight = reqId;
    r.layerKey = plan.layerKey;
    r.sentAt = performance.now();
    compPerf.current.sends++;
    // 时刻的算法留在这一侧（片段偏移 + 播放头 - 起点）；页面只负责把它对到那条镜像视频上。
    const tracks = plan.sources.map(s => ({
      trackId: s.trackId, src: s.clip.src, want: sourceTime(s.clip, q),
    }));
    vid.blendPost({
      type: 'blend-vid-frame', reqId, t: q, layerKey: plan.layerKey,
      baseTrackId: plan.baseTrackId, tracks, playing: playingRef.current,
    });
  }, [vid]);

  const requestComposite = useCallback((plan: VidCompositePlan | null, t: number, force = false) => {
    if (!visible) return;
    const r = compReq.current;
    if (!plan) {
      if (r.key) {
        r.key = '';
        r.want = null;
        vid.blendPost({ type: 'blend-vid-frame-off' });
      }
      return;
    }
    // 内容不随帧变的段（页面报过 frameless）：这一段的画面只由图层集决定 ⇒ 只在**换段**时发一包，
    // 播放中一包都不发。原先一律 12fps 地发，"反正走缓存"——可每包都要现算一次图层集签名
    // （逐层 16×16 采样读回），30 包/秒就是白烧。
    // 随帧变的那条链：量化到 COMP_FPS（= 30，与工程帧率同格）—— 页面按 rAF 合成，落地的节拍
    // 由它决定，发多发少都不会积压。
    const COMP_FPS = 30;
    const q = Math.max(0, Math.floor(t * COMP_FPS + 1e-6) / COMP_FPS);
    const staticSeg = compFrameless.current.has(plan.layerKey);
    const key = staticSeg ? plan.layer.id + '@static' : plan.layer.id + '@' + q;
    if (!force && key === r.key && !r.want) return;
    r.want = { plan, q: staticSeg ? t : q, key };
    pumpRef.current();
  }, [vid, visible]);
  pumpRef.current = () => {
    const r = compReq.current;
    const w = r.want;
    if (!w || !liveRef.current) return;
    const now = performance.now();
    // 页面那边按 rAF 合成（一帧最多画一次、同一帧来几包只算最后一包），所以"发得比画得快"
    // 不反噬 —— 这里只压一道最小间隔：别在同一帧里连发两包。
    if (r.inflight && now - r.sentAt < 16) return;
    r.want = null;
    r.key = w.key;
    sendComposite(w.plan, w.q);
  };
  requestRef.current = requestComposite;

  // ── 底片预览（游标不在 Layer 段上）────────────────────────────────────────────────────
  // 视频模式下工作台画布常驻：游标一离开 Layer 段，画布内容就换成当前视频帧。
  // **帧不再从这里抓。** 早先是"抓一帧 → createImageBitmap 整幅 → 跨窗 transfer → 画布再画
  // 一遍"，6Hz 地跑：每一趟都要把正在播的画面从合成器读回来、在主线程排队，正在播的 <video>
  // 还会被拽去走拷贝路径 —— 播放时的规律性顿感就是它（而且抓得越勤越顿）。
  // 现在工作台页面自己挂一只同源的 <video> 播同一个文件（blend_node 的 #vidBaseVideo）：这一侧
  // 只报"哪一段、源内第几秒、在不在播"，5~6Hz 的小消息，一个像素都不过界。
  const baseReq = useRef({ key: '\u0000', on: false, hidden: false });
  const sendBaseSrc = useCallback((clip: VidClip | null, q: number, playing: boolean, hidden: boolean) => {
    const r = baseReq.current;
    compPerf.current.baseSends = (compPerf.current.baseSends || 0) + 1;
    if (!clip) {
      if (!r.on) return;
      r.on = false;
      r.hidden = false;
      vid.blendPost({ type: 'blend-vid-base-off' });
      return;
    }
    const sent = vid.blendPost({
      type: 'blend-vid-base-src', src: clip.src,
      start: clip.start, offset: clip.offset, t: q, playing, hidden,
    });
    r.on = sent;
    r.hidden = hidden;
    if (!sent) r.key = '\u0000';       // 页面还没挂上（iframe 尚未加载）：下一个 tick 重来
  }, [vid]);
  const requestBase = useCallback((t: number, hidden = false) => {
    if (!visible) return;
    const p = projectRef.current;
    // 底片跟着监视器走：静音的轨不送帧（画布在视频模式就是监视器，mute 要两边一致）。
    // 这里被调用时 solo 必为空（onTick 里 soloActive 走的是 requestBaseOff），
    // 但用 clipAtSolo 一处口径更稳 —— 空 solo 集时它与 clipAt(…, 'video') 等价。
    const c = clipAtSolo(p, t, soloRef.current.video, muteRef.current) ?? null;
    // 时刻量化：播放中只要 6Hz（页面那边是**纠偏**，粒度不影响画面本身的帧率 —— 画面由镜像
    // <video> 原生出帧）；暂停时按工程帧率量化 —— 那时候这一格就是"此刻那一帧"，差 100ms
    // 是看得出来的，而工程帧栅格上的量化既准又能把拖动时的消息压到每帧一条。
    const playing = playingRef.current;
    const BASE_FPS = playing ? 6 : (p.fps > 0 ? p.fps : 30);
    const q = Math.max(0, Math.floor(t * BASE_FPS + 1e-6) / BASE_FPS);
    // 键里带上片段的起点/源内偏移、播放态与"是否被合成压着"：剪一下片段、从暂停转播放、
    // 或者进出 Layer 段，都得让页面重新对时/换台。
    const key = c ? `${c.id}@${c.start}@${c.offset}@${q}@${playing ? 1 : 0}@${hidden ? 1 : 0}` : '';
    const r = baseReq.current;
    if (key === r.key) return;
    r.key = key;
    sendBaseSrc(c, q, playing, hidden);
  }, [visible, sendBaseSrc]);
  const requestBaseOff = useCallback(() => {
    if (!visible) return;
    const r = baseReq.current;
    r.key = '\u0000';                  // 再回到"段外"时第一帧要重新送
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
      // 视频 solo 亮着 = **直接播**：不走画布系统 —— 合成计划作废、底片不送，
      // 主 <video> 自己播 solo 轨那段（见下面的 clipAtSolo）。
      const soloV = soloRef.current.video;
      const soloActive = soloV.size > 0;
      const muted = muteRef.current;
      // 这一帧归谁：layer 段在最上 → 交给工作台合成；否则照旧。solo 时一律不合成；
      // **静音的 Layer 轨被 compositePlanAt 跳过**（它的段不合成，露出底下）。
      const plan = soloActive ? null : compositePlanAt(proj, t, muted);
      const modeId = plan ? plan.layer.id : null;
      if ((compModeRef.current?.id ?? null) !== modeId
        || (plan && compModeRef.current?.name !== plan.layer.name)) {
        const next = plan ? { id: plan.layer.id, name: plan.layer.name } : null;
        compModeRef.current = next;
        setCompMode(next);
      }
      // 游标底下那一段的图层集 key（null = 不在任何 Layer 段上）变了就报一次：宿主据此切
      // Layers 面板的作用对象，并决定画布是折图层还是放视频底片。solo 时画布系统退场，
      // 一律报 null（回到文档主图层集）。
      const layerKeyNow = plan ? plan.layerKey : null;
      if (layerKeyNow !== compLayerRef.current) {
        compLayerRef.current = layerKeyNow;
        onCompLayerRef.current?.(layerKeyNow);
      }
      // solo/mute 感知的视频段：静音的轨不显示（mute 优先于 solo），solo 亮着时只认 solo 轨。
      // 没有 solo/mute 时 clipAtSolo 与 clipAt(…, 'video') 等价 —— 一处口径，别再写三元。
      const c = clipAtSolo(proj, t, soloV, muted);
      const cid = c?.id ?? null;
      if (cid !== activeIdRef.current) {
        activeIdRef.current = cid;
        setActiveId(cid);
      }
      // 空屏的原因：有段却被静音/solo 挡了 → 说清楚，别让用户以为工程坏了。
      if (!c) {
        const raw = clipAt(proj, t, 'video');
        const nb = !raw ? 'none' : (muted.has(raw.trackId) ? 'muted' : (soloActive ? 'solo' : 'none'));
        if (nb !== blockedRef.current) { blockedRef.current = nb; setBlocked(nb); }
      } else if (blockedRef.current !== 'none') {
        blockedRef.current = 'none'; setBlocked('none');
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
      // 底片态：solo 时整个退场（requestBaseOff）；Layer 段压着时**不退**，只报 hidden ——
      // 页面那颗镜像继续跟着播，一出段就能立刻露出正在那一帧（退掉再重开 = 先露旧帧再 seek
      // 跳一下，那就是"出 Layer 段闪一下"）。
      // **预热**：还没进 Layer 段时，提前 1.5 秒把下一段的源帧镜像挂好、对到那一刻。
      // 不预热的话，"建镜像 + 等 loadeddata + seek + 切图层集 + 整画布重渲染 + 首帧合成"
      // 全挤在边界那一帧里 —— 播放中就是一次可感的顿（画面上像闪一下）。
      const warm = soloActive ? null : warmAheadOf(proj, t, muted, 4);   // 4 秒的提前量：够它把文件加载完
      const warmKey = warm ? `${warm.layerKey}@${warm.at.toFixed(2)}` : '';
      if (warmKey !== warmSent.current) {
        warmSent.current = warmKey;
        if (warm) vid.blendPost({ type: 'blend-vid-warm', layerKey: warm.layerKey, t: warm.at, tracks: warm.tracks });
      }
      if (soloActive) requestBaseOff();
      else requestBase(t, !!plan);
      requestComposite(plan, t);   // solo 时 plan 为 null → 停掉合成（发 frame-off）
    };
    // seek 落定 = 真帧已上屏：撤掉缩略条替身。两个守卫防止拖动中闪替身——
    //  * 在途 seek 的目标仍是"游标此刻该在的位置"（中途完成的旧 seek 不算数）；
    //  * 且最近 100ms 内没有新的交互 tick（连续拖动时真帧中途落定也不闪）。
    //  快 seek 落得太快被守卫拦下时，150ms 后补查一次 —— 别让替身图挂着不走。
    const tryHideStrip = () => {
      if (!stripRef.current) return;
      const t = transport.get();
      const c2 = clipAtSolo(projectRef.current, t, soloRef.current.video, muteRef.current);
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
    const plan0 = compositePlanAt(projectRef.current, transport.get(), muteRef.current);
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
      const d = event.data as { type?: string; reqId?: number; bitmap?: ImageBitmap | null;
        cached?: boolean; frameless?: boolean; usedTracks?: string[] } | null;
      if (!d || d.type !== 'blend-vid-composite') return;
      const r = compReq.current;
      const bmp = d.bitmap ?? null;
      if (typeof d.reqId !== 'number' || d.reqId !== r.inflight) { bmp?.close(); return; }
      const now = performance.now();
      r.lastReply = now;
      // 往返时延（滑动平均）：一包从发出到回图的真实耗时 —— 播放时这个数除以 1 就是页面合成
      // 这一帧的天花板帧率（探针里直接读它）。
      const rtt = now - r.sentAt;
      r.rtt = r.rtt ? r.rtt * 0.75 + rtt * 0.25 : rtt;
      compPerf.current.rtt = +r.rtt.toFixed(1);
      if (d.cached === true) compPerf.current.cachedReplies++;
      else compPerf.current.bitmapReplies++;
      // frameless 标记的维护:页面说这段不绑视频帧 → 这一段的合成与时刻无关,以后只在换段时
      // 发一包;说绑了(或缓存命中沿用上次的结论)→ 照它说的更新集合。按在途包的 layerKey 对账。
      if (d.frameless === true) compFrameless.current.add(r.layerKey);
      else if (d.frameless === false) compFrameless.current.delete(r.layerKey);
      // 引用轨集合同批更新(空数组 = 没有面吃帧,与 frameless 同义)。**只作诊断**：帧不再由
      // 这一侧抓，页面自己按 attribute 的 frameTrack 决定开哪几条镜像。
      if (Array.isArray(d.usedTracks)) {
        compUsedTracks.current.set(r.layerKey, new Set(d.usedTracks.map(String)));
      }
      try {
        // 缓存命中:内容与画面上这张完全一致 —— 一个像素都不动,保留现画面即可(离段再回来时
        // compCanvas 的像素还在,直接亮出来)。
        if (d.cached === true) { setHasComp(true); return; }
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
      } finally {
        pumpRef.current();            // 上一包回来了：压在 want 里的那一帧立刻放行
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [vid]);

  // 进出合成模式：**只在这一格彻底退场时**把合成图藏起来（主 <video> 重新露脸）。
  // 从一个 Layer 段走到下一个 Layer 段时**别清**：那一下新合成还没回来，清了就等于先把旧合成
  // 换成一帧裸视频、再被新合成盖住 —— 又是一次"闪"。（进段时 hasComp 本来就是 false。）
  useEffect(() => {
    if (!compMode) setHasComp(false);
    else hideStrip();                 // 条条上只有视频帧，盖在合成画面上是错的
  }, [compMode, hideStrip]);

  // 收摊 / 藏起来：告诉页面这一包作废（它停掉源帧镜像、清掉缓存的源帧），底片态也一并退掉。
  useEffect(() => {
    if (visible) return;
    compReq.current.key = '';
    compReq.current.want = null;
    vid.blendPost({ type: 'blend-vid-frame-off' });
    baseReq.current.on = false;
    baseReq.current.key = '\u0000';
    vid.blendPost({ type: 'blend-vid-base-off' });
  }, [visible, vid]);
  useEffect(() => () => {
    liveRef.current = false;
    compReq.current.key = '';
    compReq.current.want = null;
    vidRef.current.blendPost({ type: 'blend-vid-frame-off' });
    vidRef.current.blendPost({ type: 'blend-vid-base-off' });
  }, []);

  // 看门狗：合成模式下页面还没回过任何一张图（iframe 刚挂载、镜像视频还在解码、消息比监听器
  // 早到），就按当前帧再要一次。回图正常时它一个请求都不发。
  useEffect(() => {
    if (!visible || !compMode) return;
    const timer = setInterval(() => {
      const r = compReq.current;
      if (!r.key || performance.now() - r.lastReply < 1800) return;
      const plan = compositePlanAt(projectRef.current, transport.get(), muteRef.current);
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
      // ── 独占音频槽 ── 时间线在放,槽就得在手;被抢占(Inspector 抢走)时 onRevoked 把
      // playing 拨回 false —— 下面的 else 分支照常收摊(暂停/stopAll/还解码器)。
      acquireAudioSlot(
        { id: 'player', label: 'Player — timeline', probe: probeOfPlayer() },
        () => setPlaying(false),
      );
      void v.play().catch(() => { /* autoplay guards */ });
    } else {
      v.pause(); vidAudio.stopAll(); releaseDecoder();
      releaseAudioSlot('player');
    }
  }, [playing, activeId, hideStrip, setPlaying]);

  // ── 播放态变化要**立刻**报到工作台页 ──
  // 画布上的画面现在是页面自己播的镜像视频（底片一只、源帧若干只）。播放头一停就不会再有
  // tick，那几只镜像会自己接着播 —— 看起来就是"暂停了画面还在动"。所以这一下不等 tick，
  // 直接补一包过去（包里带着 playing 位）。
  useEffect(() => {
    const t = transport.get();
    const plan = soloRef.current.video.size > 0
      ? null
      : compositePlanAt(projectRef.current, t, muteRef.current);
    requestBase(t, !!plan);
    requestComposite(plan, t, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);
  // 卸载(Image 模式换走正文)时槽不该悬着。
  useEffect(() => () => releaseAudioSlot('player'), []);

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
      // **mute / 音频 solo**：静音的轨一律不响（mute 优先）；有 solo 时非 solo 轨也不响
      // （与视频 solo 无关，两边分开）。
      const soloA = soloRef.current.audio;
      const muted = muteRef.current;
      for (const c of proj.clips) {
        if (c.kind !== 'audio') continue;
        if (!audioAudible(c.trackId, soloA, muted)) {
          if (vidAudio.has(c.id)) vidAudio.stop(c.id);
          continue;
        }
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
      // **视频 solo / mute**：漂移校正也只认"上得了监视器"的段（与 clipAtSolo 同一口径：
      // 静音的不显示，solo 亮着时只认 solo 轨）。
      const v = videoRef.current;
      const av = clipAtSolo(proj, np, soloRef.current.video, muted);
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
  // solo 徽章：视频 solo 亮着 = 直接播（不走画布），音频 solo 亮着 = 只响 solo 轨。
  const soloVActive = vid.solo.video.size > 0;
  const soloAActive = vid.solo.audio.size > 0;
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
            {blocked === 'muted'
              ? 'The clip under the playhead is on a muted track.'
              : blocked === 'solo'
                ? 'No soloed clip under the playhead.'
                : 'No clip under the playhead.'}<br />Drop videos onto the Tracks window below.
          </div>
        )}
        {/* solo 徽章：顶中，不抢左上角的段名与右上角的 I/O。视频 solo 用琥珀（直接播），
            音频 solo 用绿（只响 solo 轨），两个都亮时合并成一个。 */}
        {(soloVActive || soloAActive) && (
          <div style={{
            position: 'absolute', left: '50%', top: 8, transform: 'translateX(-50%)',
            padding: '2px 10px', borderRadius: 6, fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
            whiteSpace: 'nowrap', pointerEvents: 'none',
            background: soloVActive ? 'rgba(255,159,10,0.25)' : 'rgba(48,209,88,0.25)',
            color: soloVActive ? '#ffb340' : '#5ce07a',
          }}>
            {soloVActive && soloAActive ? 'SOLO' : soloVActive ? 'V-SOLO · direct' : 'A-SOLO'}
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
