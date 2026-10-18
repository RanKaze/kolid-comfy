import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  type VidClip, type VidController,
  addTrack, clipAt, fmtTime, importToTrack, isAudioName, isVideoName, moveClip, placeAsset, removeClip, removeTrack,
  splitClip, trackOf, trimClip, unlinkGroup, vidDuration,
} from './model';
import { keyIs, onGlobalKey, onGlobalKeyUp } from '../../hotkeys';
import { probeMedia } from './audio';
import { ingestFile } from './ingest';
import {
  ensureFrame, ensureStrip, ensureWaveform, frameBackend, peekStrip, stripComplete, stripFrame, subscribeStrip,
} from './previews';

/** 缩略条的订阅：抽好的那一刻敲一下组件重渲；挂载即开始在后台抽条。
 *  `src` 为空 = 这条片段不需要缩略条（音频段：波形另有 Cache，不该给纯音频源抽视频帧）。 */
function useStrip(src: string, srcDuration: number): string[] | undefined {
  const [, bump] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    if (!src) return;
    const un = subscribeStrip(bump);
    void ensureStrip(src, srcDuration);
    return un;
  }, [src, srcDuration]);
  return peekStrip(src);
}

// ── Tracks 窗（时间线）───────────────────────────────────────────────────────────────────────
// 一根标尺 + 若干轨道。视频轨在上、音频轨在下（tracks 数组序）；标尺上是播放头（红色，当前
// 播放位置）与一对入/出点（I/O，播放范围）。交互：
//  * 标尺按下/拖动 = scrub（改播放头）；
//  * I/O 两个小把手各自拖动，圈出播放范围（Player 在范围内循环）；
//  * 片段：拖身体 = 移动（联动组整组走；**按住 Alt 只动自己** —— 音视频错开的口子），
//    左右边 = 裁剪（Alt 同理只裁自己），点 ⧉ 徹底解绑，✕ = 删除，Delete 键删选中的；
//  * 拖入：Assets 窗的资产（application/x-vid-asset，只引用不复制）、图池条目
//    （application/x-blend-staging）或本地视频/音频文件 —— 后两者**先入资产库再落片段**
//    （Assets 是项目所有数据的来源，不存在"直接进轨道"的路），落在哪条轨就进哪条轨
//    （纯音频源会被改派到音频轨）；带音频的视频当场拆一条联动音频段。
// 状态全部来自 `vid` 控制器 —— 这一格自己不存任何权威状态，刷新/换模式都无所谓。
// 播放头走外置 transport（vid.transport）：一响就直改 DOM（线/三角/读数/底注/跟随滚动），
// 不惊动 React —— scrub 与播放都丝滑。

const STAGING_ITEM_TYPE = 'application/x-blend-staging';
const ASSET_ITEM_TYPE = 'application/x-vid-asset';
// 标尺 34px，**纵向分三段**：上 10 = 播放头三角，中 14 = 刻度，下 10 = 范围上下界的半三角。
// 播放头和范围标记只会在同一列上"上下相遇"，永远不会占同一块命中区 —— 这就是不让它们抢手势的办法。
const RULER_H = 34;
const PLAY_H = 10;       // 播放头三角（顶部带）
const MARK_H = 10;       // 范围半三角（底部带）
const MARK_TOP = RULER_H - MARK_H;   // 24：范围标记的顶边
const TICK_TOP = PLAY_H;             // 10：刻度带的上沿
const TICK_BOTTOM = MARK_H;          // 10：刻度带的下沿（给底部三角让位）
const HEADER_W = 118;
const TRACK_H: Record<'video' | 'audio', number> = { video: 52, audio: 42 };
const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

// 最近一次**裁剪**拖动的时间戳。Clip 用它决定"静态预览能不能拿半成品条顶位"：只有正在裁
// 的那一小段时间才认半成品；平时只认抽完的条 —— 抽条是渐进发布的，半成品的数组长度每次
// 发布都在变，stripFrame 的索引跟着重映射，首/尾帧会一直跳（"开始时一直变，最后才稳定"）。
let lastTrimAt = 0;

// ── 图标 ── 轨道类型、动作都是小 SVG：同一粗细、同一视觉重量，比字符字形（▣ / ♪ / ✕）
// 在任何字体下都稳 —— 字符会随系统字体变形，缩放也糊。
const IconFilm: React.FC = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3.2" width="12" height="9.6" rx="1.6" />
    <path d="M5.4 3.2v9.6M10.6 3.2v9.6M2 8h12" />
  </svg>
);
const IconWave: React.FC = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round">
    <path d="M2.6 8h.8M5 5.8v4.4M7.5 3.8v8.4M10 6.2v3.6M12.4 4.6v6.8M14 8h.2" />
  </svg>
);
const IconTrash: React.FC = () => (
  <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 4.5h10M6.2 4.5V3.2h3.6v1.3M4.4 4.5l.7 8.2h5.8l.7-8.2" />
  </svg>
);
const IconLink: React.FC = () => (
  <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round">
    <path d="M6.5 9.5l3-3M6.8 4.6l1-1a2.6 2.6 0 013.7 3.7l-1 1M9.2 11.4l-1 1a2.6 2.6 0 01-3.7-3.7l1-1" />
  </svg>
);


// 剃刀光标：按住 C 时整条时间线换成剪刀。内联 SVG 数据 URI（`#` 等已被 encodeURIComponent 编码），
// 热点在刀口中点；黑描边 + 白描边两层，压在任何缩略图/底色上都看得清。
const BLADE_CURSOR = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 26 26'>"
  + "<g fill='none' stroke='rgba(0,0,0,0.72)' stroke-width='4' stroke-linecap='round'>"
  + "<circle cx='7' cy='20' r='3.1'/><circle cx='7' cy='6' r='3.1'/>"
  + "<path d='M9.7 18L22 6M9.7 8L22 20'/></g>"
  + "<g fill='none' stroke='#fff' stroke-width='1.8' stroke-linecap='round'>"
  + "<circle cx='7' cy='20' r='3.1'/><circle cx='7' cy='6' r='3.1'/>"
  + "<path d='M9.7 18L22 6M9.7 8L22 20'/></g></svg>",
)}") 13 13, crosshair`;

// 轨道类型的配色：视频蓝、音频绿。文字/图标/带子全从这里取，别处不再写颜色。
const KIND_UI = {
  video: { fg: '#64d2ff', chipBg: 'rgba(10,132,255,0.16)', bandA: 'rgba(10,132,255,0.030)',
    bandB: 'rgba(10,132,255,0.012)', clipA: 'rgba(10,132,255,0.42)', clipB: 'rgba(10,132,255,0.24)',
    edge: 'rgba(10,132,255,0.75)', accent: '#64d2ff' },
  audio: { fg: '#30d158', chipBg: 'rgba(48,209,88,0.16)', bandA: 'rgba(48,209,88,0.030)',
    bandB: 'rgba(48,209,88,0.012)', clipA: 'rgba(48,209,88,0.40)', clipB: 'rgba(48,209,88,0.22)',
    edge: 'rgba(48,209,88,0.72)', accent: '#30d158' },
} as const;


type DragState =
  | { mode: 'move'; id: string; x0: number; start0: number }
  | { mode: 'l' | 'r'; id: string; x0: number }
  | { mode: 'scrub' }
  | { mode: 'in' }
  | { mode: 'out' };

const btn: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 600, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
  background: 'rgba(255,255,255,0.07)', border: '0.5px solid rgba(255,255,255,0.16)',
  color: 'rgba(255,255,255,0.82)', lineHeight: 1.5, flexShrink: 0,
};

export const VidTimeline: React.FC<{ vid: VidController }> = ({ vid }) => {
  const { project: p, transport, pps } = vid;
  const dur = vidDuration(p);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [dropLane, setDropLane] = useState<string | null>(null);

  // ── 播放头直改 DOM ── 线、三角、时间读数、底注、跟随滚动都不走 React。
  const lineRef = useRef<HTMLDivElement | null>(null);
  const triRef = useRef<HTMLDivElement | null>(null);
  const readRef = useRef<HTMLSpanElement | null>(null);
  const noteRef = useRef<HTMLDivElement | null>(null);
  const ppsRef = useRef(pps); ppsRef.current = pps;
  const durRef = useRef(dur); durRef.current = dur;
  const projRef = useRef(p); projRef.current = p;
  useEffect(() => {
    const paint = () => {
      const t = transport.get();
      const px = t * ppsRef.current;
      if (lineRef.current) lineRef.current.style.transform = `translateX(${px}px)`;
      if (triRef.current) triRef.current.style.transform = `translateX(${px}px)`;
      if (readRef.current) readRef.current.textContent = `${fmtTime(t)} / ${fmtTime(durRef.current)}`;
      if (noteRef.current) {
        const c = clipAt(projRef.current, t, 'video');
        noteRef.current.textContent = c
          ? `Preview: 「${c.name}」 (${fmtTime(c.offset + (t - c.start))} in source)`
          : 'Preview: no video under the playhead — drag clips from Assets or drop files here';
      }
      // 跟随：播放头走出视野就滚过去（scrub 往回也跟 —— 与原口径一致）。
      const sc = scrollRef.current;
      if (sc && (px < sc.scrollLeft || px > sc.scrollLeft + sc.clientWidth - 48)) {
        sc.scrollLeft = Math.max(0, px - 80);
      }
    };
    paint();
    return transport.subscribe(paint);
  }, [transport]);

  const timeAt = useCallback((clientX: number): number => {
    const el = contentRef.current;
    if (!el) return 0;
    // 时间 0 在轨道头（HEADER_W）右侧 —— lane 的原点，不是内容区原点；标尺/片段/播放头同口径。
    return Math.max(0, (clientX - el.getBoundingClientRect().left - HEADER_W) / vid.pps);
  }, [vid.pps]);

  // ── 拖放落定 ── Assets 是项目所有数据的来源：先入库（同 src 认领已有的），再落一段引用
  // 它的片段 —— 不存在"直接进轨道"的路。
  //  * 图池条目：src 是 base64 图片 —— 走前端 <video>/WebAudio 探测（图片咬不动 = no-op）；
  //  * 本地文件：字节 POST 给后端 ffmpeg 入库（持久 URL + 精确探测 + 必要时转代理），后端
  //    没有 ffmpeg 时回退 blob + 前端探测（blob 活不过刷新，读档自会剪掉）。
  const importSource = useCallback(async (
    src: string, name: string, origin: 'staging' | 'file', trackId: string | null, at: number,
  ) => {
    const info = await probeMedia(src, isAudioName(name) ? 'audio' : 'video');
    if (!info) return;
    vid.update(proj => importToTrack(proj, { src, name, origin }, info, trackId, at), 'Add clip');
  }, [vid]);

  const importFile = useCallback(async (f: File, trackId: string | null, at: number) => {
    const ing = await ingestFile(f);
    if (ing) {
      vid.update(proj => importToTrack(proj, { src: ing.src, name: ing.name, origin: 'file' },
        { duration: ing.duration, hasAudio: ing.hasAudio, audioOnly: ing.audioOnly }, trackId, at), 'Add clip');
      return;
    }
    const url = URL.createObjectURL(f);
    const info = await probeMedia(url, isAudioName(f.name) ? 'audio' : 'video');
    if (!info) return;
    vid.update(proj => importToTrack(proj, { src: url, name: f.name, origin: 'file' }, info, trackId, at), 'Add clip');
  }, [vid]);

  // ── 剃刀：**按住 C** + 左键片段 = 在指针处剪开（Alt = 只剪按到的这一段，不带联动组）。 ──
  // 按键走 onGlobalKey/onGlobalKeyUp：鼠标在画布 iframe 上时焦点在那边的 document，
  // 宿主 window 收不到 keyup（见 hotkeys.ts 的文件头）。窗口失焦不会有 keyup，blur 兜底。
  const [blade, setBlade] = useState(false);
  const bladeRef = useRef(false);
  useEffect(() => {
    const set = (v: boolean) => { bladeRef.current = v; setBlade(v); };
    const inField = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    };
    const un1 = onGlobalKey(e => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (keyIs(e, 'c') && !inField(e)) set(true);
    });
    const un2 = onGlobalKeyUp(e => { if (keyIs(e, 'c')) set(false); });
    const blur = () => set(false);
    window.addEventListener('blur', blur);
    return () => { un1(); un2(); window.removeEventListener('blur', blur); };
  }, []);

  // ── 片段拖动 / 裁剪 ── pointer capture 挂在被按的那个元素上，move/up 都回到它身上。
  const startClipDrag = (e: React.PointerEvent, mode: 'move' | 'l' | 'r', clip: VidClip) => {
    e.stopPropagation();
    if (bladeRef.current && e.button === 0) {
      // 剃刀优先于拖拽：切口落在指针处，片段不动。
      e.preventDefault();
      vid.update(proj => splitClip(proj, clip.id, timeAt(e.clientX), !e.altKey), 'Split clip');
      return;
    }
    if (mode === 'move') setSel(clip.id);
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 指针已失活/合成事件：不挡手势 */ }
    dragRef.current = { mode, id: clip.id, x0: e.clientX, start0: clip.start };
  };
  const onClipPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.mode === 'scrub' || d.mode === 'in' || d.mode === 'out') return;
    const dragId = d.id;
    // 按住 Alt = 暂时无视联动组，只动/只裁被拖的这一段（音视频错开的临时口子）。
    const linked = !e.altKey;
    if (d.mode === 'move') {
      // 指针脚下是哪条同类轨，就搬去哪条：elementFromPoint 穿过被拖的片段找 lane。
      let trackId: string | undefined;
      const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const lane = hit?.closest?.('[data-vid-track]');
      if (lane) {
        const tid = lane.getAttribute('data-vid-track') || '';
        const tr = trackOf(p, tid);
        const clip = p.clips.find(c => c.id === dragId);
        if (tr && clip && tr.kind === clip.kind) trackId = tid;
      }
      const ns = d.start0 + (e.clientX - d.x0) / vid.pps;
      vid.update(proj => moveClip(proj, dragId, ns, trackId, linked), 'Move clip');
    } else {
      const edge: 'l' | 'r' = d.mode;
      lastTrimAt = performance.now();
      vid.update(proj => trimClip(proj, dragId, edge, timeAt(e.clientX), linked), 'Trim clip');
    }
  };
  const endClipDrag = () => { dragRef.current = null; };

  // ── 标尺 scrub ──
  const scrubRef = useRef(false);
  const onRulerDown = (e: React.PointerEvent) => {
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 指针已失活/合成事件：不挡手势 */ }
    scrubRef.current = true;
    vid.seek(timeAt(e.clientX));
  };
  const onRulerMove = (e: React.PointerEvent) => { if (scrubRef.current) vid.seek(timeAt(e.clientX)); };
  const onRulerUp = () => { scrubRef.current = false; };

  // ── 入 / 出点 ──
  const startBound = (e: React.PointerEvent, which: 'in' | 'out') => {
    e.stopPropagation();
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 指针已失活/合成事件：不挡手势 */ }
    dragRef.current = { mode: which };
  };
  const onBoundMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || (d.mode !== 'in' && d.mode !== 'out')) return;
    const t = timeAt(e.clientX);
    vid.update(proj => d.mode === 'in'
      ? { ...proj, inPoint: Math.max(0, Math.min(t, proj.outPoint > proj.inPoint ? proj.outPoint - 0.1 : dur - 0.1)) }
      : { ...proj, outPoint: Math.max(proj.inPoint + 0.1, t) }, 'Set range');
  };

  // ── 键删 ── Delete/Backspace 删选中的片段（输入框里不抢）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!sel) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable) return;
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      vid.update(proj => removeClip(proj, sel), 'Delete clip');
      setSel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, vid]);

  // ── 视口度量 ── 自定义横向滚动条需要滚动区/条子的宽度与 scrollLeft。
  const trackRef = useRef<HTMLDivElement | null>(null);
  // 内容的宽度：工程时长再留 10s 余量，但**永远不少于可视区** —— 轨道是无限延伸的画布，
  // 不能"到 0:04 就断掉、右边一片空"。窗口一变宽（拖分界线/全屏）这条跟着重算。
  const [viewW, setViewW] = useState(0);
  const contentW = Math.max((dur + 10) * pps, viewW, 640);
  const [trackW, setTrackW] = useState(0);
  const [scrollX, setScrollX] = useState(0);
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const measure = () => { setViewW(sc.clientWidth); setTrackW(trackRef.current?.clientWidth ?? 0); };
    const onScroll = () => setScrollX(sc.scrollLeft);
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    if (trackRef.current) ro.observe(trackRef.current);
    sc.addEventListener('scroll', onScroll, { passive: true });
    measure();
    return () => { ro.disconnect(); sc.removeEventListener('scroll', onScroll); };
  }, []);

  // ── Fit ── 整段时间线正好铺满可视 lane（左右留一点余量）。
  const userZoomedRef = useRef(false);                       // 用户手动缩放过 → 停止自动 Fit
  const pendingAnchorRef = useRef<{ t: number; laneV: number } | null>(null);
  const fitZoom = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const d = vidDuration(vid.project);
    if (d <= 0) return;
    const w = Math.max(sc.clientWidth - HEADER_W - 24, 120);
    vid.setPps(Math.max(6, Math.min(480, w / d)));
    userZoomedRef.current = false;
    sc.scrollLeft = 0;
  }, [vid]);

  // ── 自动 Fit ── 没手动缩放过时：挂载/时长变化都重新铺满；拖拽/scrub 进行中不打扰。
  useEffect(() => {
    if (userZoomedRef.current || dragRef.current || scrubRef.current) return;
    fitZoom();
  }, [dur, fitZoom]);

  // ── 缩放 ── 以可视区中心的时间点为锚，缩放前后画面中心不动。
  const zoomBy = (f: number) => {
    const sc = scrollRef.current;
    if (!sc) return;
    const laneV = Math.max(sc.clientWidth - HEADER_W, 1);
    pendingAnchorRef.current = { t: (sc.scrollLeft + laneV / 2) / vid.pps, laneV };
    userZoomedRef.current = true;
    vid.setPps(Math.max(6, Math.min(480, vid.pps * f)));
  };
  useEffect(() => {
    const a = pendingAnchorRef.current;
    if (!a) return;
    pendingAnchorRef.current = null;
    const sc = scrollRef.current;
    if (sc) sc.scrollLeft = Math.max(0, a.t * vid.pps - a.laneV / 2);
  }, [pps, vid.pps]);

  // ── 自定义横向滚动条 ── 几何：thumb 宽 = 视口占比，位置 = scrollLeft 比例。
  const laneContentW = Math.max(contentW - HEADER_W, 1);
  const laneViewW = Math.max(viewW - HEADER_W, 1);
  const maxScroll = Math.max(laneContentW - laneViewW, 0);
  const sbThumbW = maxScroll > 0 ? Math.max(28, Math.min(trackW, laneViewW / laneContentW * trackW)) : trackW;
  const sbSpan = Math.max(trackW - sbThumbW, 1);
  const sbThumbX = maxScroll > 0 ? scrollX / maxScroll * (trackW - sbThumbW) : 0;
  const sbDrag = useRef<{ x0: number; s0: number } | null>(null);
  const onSbDown = (e: React.PointerEvent) => {
    const sc = scrollRef.current, tr = trackRef.current;
    if (!sc || !tr || maxScroll <= 0) return;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 指针已失活/合成事件：不挡手势 */ }
    const onThumb = !!(e.target as HTMLElement)?.dataset?.sbThumb;
    if (!onThumb) { // 点空白处：视窗跳过去（点中即居中），接着顺势进入拖动。
      const rect = tr.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left - sbThumbW / 2) / sbSpan));
      sc.scrollLeft = frac * maxScroll;
    }
    sbDrag.current = { x0: e.clientX, s0: sc.scrollLeft };
  };
  const onSbMove = (e: React.PointerEvent) => {
    const d = sbDrag.current;
    const sc = scrollRef.current;
    if (!d || !sc) return;
    sc.scrollLeft = Math.max(0, Math.min(maxScroll, d.s0 + (e.clientX - d.x0) * (maxScroll / sbSpan)));
  };
  const onSbUp = () => { sbDrag.current = null; };

  // ── 标尺刻度 ── 选一个 ≥64px 的步长。
  const step = STEPS.find(s => s * pps >= 64) ?? STEPS[STEPS.length - 1];
  const ticks: React.ReactNode[] = [];
  // 刻度画到**内容宽**为止（contentW 已含可视区）：短工程也不会在右边留一段没有刻度的空带。
  const tickEnd = Math.max(dur + step * 2, (contentW - HEADER_W) / pps);
  for (let t = 0; t <= tickEnd; t += step) {
    ticks.push(
      <div key={t} style={{ position: 'absolute', left: HEADER_W + t * pps, top: TICK_TOP, bottom: TICK_BOTTOM, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', pointerEvents: 'none' }}>
        <div style={{ width: 1, height: 5, background: 'rgba(255,255,255,0.42)' }} />
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)', padding: '1px 0 0 3px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', letterSpacing: 0.2 }}>{fmtTime(t)}</span>
      </div>,
    );
    // 半步细刻度：只给眼睛一个"这一格有多宽"的参照，不写数字 —— 密到写不下时会糊。
    if (t + step / 2 <= tickEnd) {
      ticks.push(
        <div key={'m' + t} style={{ position: 'absolute', left: HEADER_W + (t + step / 2) * pps, top: TICK_TOP, width: 1, height: 4, background: 'rgba(255,255,255,0.16)', pointerEvents: 'none' }} />,
      );
    }
  }

  const inSet = p.outPoint > p.inPoint;
  // 片段按 src 认资产：波形等预览挂在资产上（src 相同 = 同一件货）。
  const assetBySrc = React.useMemo(() => new Map(p.assets.map(a => [a.src, a])), [p.assets]);

  const laneDrop = (e: React.DragEvent, trackId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropLane(null);
    const at = timeAt(e.clientX);
    const sid = e.dataTransfer.getData(ASSET_ITEM_TYPE);
    if (sid) {
      const asset = p.assets.find(a => a.id === sid);
      if (asset) { vid.update(proj => placeAsset(proj, asset, trackId, at), 'Add clip'); return; }
    }
    const stagingId = e.dataTransfer.getData(STAGING_ITEM_TYPE);
    if (stagingId) {
      const item = vid.staging.find(s => s.id === stagingId);
      if (item) { void importSource(item.src, item.name || stagingId, 'staging', trackId, at); return; }
    }
    for (const f of Array.from(e.dataTransfer.files || [])) {
      const ok = f.type.startsWith('video/') || f.type.startsWith('audio/') || isVideoName(f.name) || isAudioName(f.name);
      if (!ok) continue;
      void importFile(f, trackId, at);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#141416', minWidth: 0, overflow: 'hidden' }}>
      {/* 头一条：增删轨道、缩放、时间读数。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '0.5px solid rgba(255,255,255,0.08)', flexShrink: 0, flexWrap: 'wrap' }}>
        <button style={btn} title="Add a video track on top" onClick={() => vid.update(p2 => addTrack(p2, 'video'), 'Add track')}>+ Video Track</button>
        <button style={btn} title="Add an audio track at the bottom" onClick={() => vid.update(p2 => addTrack(p2, 'audio'), 'Add track')}>+ Audio Track</button>
        <div style={{ flex: 1 }} />
        {blade && (
          <span title="Blade: left-click a clip to cut it in two. Hold Alt to cut only the one you clicked (its linked audio/video stays whole)."
            style={{ fontSize: 10.5, fontWeight: 600, color: '#ff9f0a', whiteSpace: 'nowrap' }}>✂ Blade — click a clip to cut</span>
        )}
        <span ref={readRef} style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', fontVariantNumeric: 'tabular-nums' }}>
          {fmtTime(transport.get())} / {fmtTime(dur)}
        </span>
        <button style={{ ...btn, width: 26, padding: '3px 0', textAlign: 'center' }} title="Zoom out" onClick={() => zoomBy(1 / 1.3)}>−</button>
        <button style={{ ...btn, width: 26, padding: '3px 0', textAlign: 'center' }} title="Zoom in" onClick={() => zoomBy(1.3)}>+</button>
        <button style={btn} title="Zoom to fit the whole timeline in view" onClick={fitZoom}>Fit</button>
      </div>

      {/* 滚动区：标尺 sticky 在顶、轨道头 sticky 在左；原生滚动条整体隐藏（Chromium 155+ 已不认
          ::-webkit-scrollbar，用标准 scrollbar-width:none），横向导航交给下面的自定义条。 */}
      <div ref={scrollRef} data-vid-scroll="" style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative', scrollbarWidth: 'none' }}>
        {/* `minWidth: '100%'`：内容层至少铺满滚动容器的可视宽 —— 轨道是无限延伸的画布，
            不能因为工程短就在右边留一条空带（首帧 viewW 还没测出来时也靠它兜住）。 */}
        <div ref={contentRef} style={{ width: contentW, minWidth: '100%', position: 'relative', minHeight: '100%' }}>

          {/* 标尺：整条只认游标（点哪拖哪）。范围的上下界是**顶上那两个三角块**（PR 那种），
              它们只占标尺顶部 10px，其余高度全是游标的地盘 —— 调范围抓三角、移游标点标尺，
              两者在空间上错开，不会再互相抢手势。范围本身仍画成贯穿的：
              标尺上的整条覆盖 + 轨道区两条长边界线 + 范围外压暗。 */}
          <div style={{ position: 'sticky', top: 0, zIndex: 5, background: '#141416' }}>
            <div
              data-vid-ruler=""
              onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp} onPointerCancel={onRulerUp}
              style={{ position: 'relative', height: RULER_H, borderBottom: '0.5px solid rgba(255,255,255,0.10)', cursor: 'ew-resize', userSelect: 'none' }}
            >
              {/* 角格：与轨道头同宽同色，横向滚动时钉在左上，刻度从它右边才开始。 */}
              <div style={{ position: 'sticky', left: 0, width: HEADER_W, height: '100%', zIndex: 7, background: '#1b1b1e', borderRight: '0.5px solid rgba(255,255,255,0.10)' }} />
              {ticks}
              {/* 范围覆盖：**整条标尺**（原来那种观感）。纯视觉，不吃手势。
                  两端的边界线**单独画**（left: pos - 0.5，与轨道区那两条长线同一公式）——
                  靠 border 画会因为 border-box 往内缩 1px，右边那条就和三角/长线错开。 */}
              {inSet && (
                <>
                  <div style={{
                    position: 'absolute', left: HEADER_W + p.inPoint * pps, width: Math.max(1, (p.outPoint - p.inPoint) * pps),
                    top: 0, bottom: 0, pointerEvents: 'none',
                    background: 'linear-gradient(180deg, rgba(10,132,255,0.18), rgba(10,132,255,0.34))',
                  }} />
                  <div style={{ position: 'absolute', left: HEADER_W + p.inPoint * pps - 0.5, top: 0, bottom: 0, width: 1, background: 'rgba(120,200,255,0.75)', pointerEvents: 'none' }} />
                  <div style={{ position: 'absolute', left: HEADER_W + p.outPoint * pps - 0.5, top: 0, bottom: 0, width: 1, background: 'rgba(120,200,255,0.75)', pointerEvents: 'none' }} />
                </>
              )}
              {/* 入点：**半三角**，竖边压在入点线上、尖端朝右（指向范围内部）—— PR 那种读法。
                  热区从竖边往外留 2px，好抓。 */}
              <div
                onPointerDown={e => startBound(e, 'in')} onPointerMove={onBoundMove} onPointerUp={endClipDrag} onPointerCancel={endClipDrag}
                title="In point — drag to set where the range starts"
                style={{ position: 'absolute', left: HEADER_W + p.inPoint * pps - 2, top: MARK_TOP, width: 10, height: MARK_H, cursor: 'ew-resize', zIndex: 6 }}
              >
                <div style={{ position: 'absolute', left: 2, top: 0, width: 8, height: MARK_H, background: '#0a84ff', clipPath: 'polygon(0 0, 0 100%, 100% 50%)', pointerEvents: 'none', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.55))' }} />
              </div>
              {/* 出点：同款的镜像 —— 竖边压在出点线上、尖端朝左（指向范围内部）。 */}
              <div
                onPointerDown={e => startBound(e, 'out')} onPointerMove={onBoundMove} onPointerUp={endClipDrag} onPointerCancel={endClipDrag}
                title="Out point — drag to set where the range ends"
                style={{ position: 'absolute', left: HEADER_W + (inSet ? p.outPoint : Math.max(dur, p.inPoint + 0.1)) * pps - 8, top: MARK_TOP, width: 10, height: MARK_H, cursor: 'ew-resize', zIndex: 6 }}
              >
                <div style={{ position: 'absolute', left: 0, top: 0, width: 8, height: MARK_H, background: inSet ? '#0a84ff' : 'rgba(255,255,255,0.30)', clipPath: 'polygon(100% 0, 100% 100%, 0 50%)', pointerEvents: 'none', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.55))' }} />
              </div>
              {/* 播放头三角（left 只钉基准，逐帧位移交给 transport 订阅者直改 transform）。 */}
              <div ref={triRef} style={{ position: 'absolute', left: HEADER_W - 5, top: 0, width: 10, height: PLAY_H, background: '#ff453a', clipPath: 'polygon(0 0, 100% 0, 50% 100%)', pointerEvents: 'none', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))', zIndex: 7 }} />
            </div>
          </div>

          {/* 轨道。 */}
          {p.tracks.map((tr, ti) => (
            <div key={tr.id} style={{
              display: 'flex', height: TRACK_H[tr.kind],
              borderBottom: '0.5px solid rgba(255,255,255,0.05)',
              // 条纹底：两条轨挨着时边界一眼能分（同色系，亮暗交替，不抢片段）
              background: ti % 2 ? KIND_UI[tr.kind].bandA : KIND_UI[tr.kind].bandB,
            }}>
              {/* 轨道头：类型徽章 + 名字 + 删除。徽章是一枚 18px 的圆角色块，图标居中 ——
                  颜色说类型，形状说用途，名字让位给省略号。 */}
              <div style={{ position: 'sticky', left: 0, width: HEADER_W, flexShrink: 0, zIndex: 4, background: '#1b1b1e', borderRight: '0.5px solid rgba(255,255,255,0.10)', display: 'flex', alignItems: 'center', gap: 6, padding: '0 7px' }}>
                <span style={{ width: 18, height: 18, borderRadius: 5, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: KIND_UI[tr.kind].chipBg, color: KIND_UI[tr.kind].fg }}>
                  {tr.kind === 'video' ? <IconFilm /> : <IconWave />}
                </span>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.8)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tr.name}</span>
                <button
                  title={'Delete track 「' + tr.name + '」 (its clips go with it)'}
                  onClick={() => { vid.update(proj => removeTrack(proj, tr.id), 'Delete track'); setSel(s => (s && p.clips.some(c => c.id === s && c.trackId === tr.id)) ? null : s); }}
                  style={{ flexShrink: 0, width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', borderRadius: 5, color: 'rgba(255,255,255,0.32)', cursor: 'pointer', padding: 0 }}
                >
                  <IconTrash />
                </button>
              </div>
              {/* lane：片段落在这里。 */}
              <div
                data-vid-track={tr.id}
                onDragOver={e => { const ts = e.dataTransfer.types; if (ts.includes(ASSET_ITEM_TYPE) || ts.includes(STAGING_ITEM_TYPE) || Array.from(ts).includes('Files')) { e.preventDefault(); setDropLane(tr.id); } }}
                onDragLeave={() => setDropLane(l => (l === tr.id ? null : l))}
                onDrop={e => laneDrop(e, tr.id)}
                onClick={() => setSel(null)}
                style={{ position: 'relative', flex: 1, minWidth: 0, background: dropLane === tr.id ? 'rgba(10,132,255,0.08)' : 'transparent' }}
              >
                {p.clips.filter(c => c.trackId === tr.id).map(c => {
                  const gid = c.groupId;
                  return (
                    <Clip key={c.id} clip={c} pps={pps} selected={sel === c.id} blade={blade}
                      wave={assetBySrc.get(c.src)?.waveform}
                      mediaFile={c.src.startsWith('/api/vid_media/') ? c.src.split('/').pop() : undefined}
                      onStartDrag={startClipDrag} onPointerMove={onClipPointerMove} onPointerUp={endClipDrag}
                      onDelete={() => { vid.update(proj => removeClip(proj, c.id), 'Delete clip'); setSel(s => (s === c.id ? null : s)); }}
                      onUnlink={() => { if (gid) vid.update(proj => unlinkGroup(proj, gid), 'Unlink'); }} />
                  );
                })}
              </div>
            </div>
          ))}

          {/* 范围边界：I/O 各一条**贯穿轨道区的长竖线**（和播放头同一种画法），
              这样范围在整个时间线上是一条看得见的长边界，而不是只在标尺上标一下。
              纯视觉（pointerEvents:none），改范围只能去上面的范围带拖把手。 */}
          {inSet && (
            <>
              <div style={{ position: 'absolute', left: HEADER_W + p.inPoint * pps - 0.5, top: RULER_H, bottom: 0, width: 1, background: 'rgba(120,200,255,0.72)', zIndex: 3, pointerEvents: 'none' }} />
              <div style={{ position: 'absolute', left: HEADER_W + p.outPoint * pps - 0.5, top: RULER_H, bottom: 0, width: 1, background: 'rgba(120,200,255,0.72)', zIndex: 3, pointerEvents: 'none' }} />
              {/* 范围外压暗：I/O 之间才是"要用的那一段" */}
              <div style={{ position: 'absolute', left: HEADER_W, width: Math.max(0, p.inPoint * pps), top: RULER_H, bottom: 0, background: 'rgba(0,0,0,0.28)', zIndex: 2, pointerEvents: 'none' }} />
              <div style={{ position: 'absolute', left: HEADER_W + p.outPoint * pps, right: 0, top: RULER_H, bottom: 0, background: 'rgba(0,0,0,0.28)', zIndex: 2, pointerEvents: 'none' }} />
            </>
          )}

          {/* 播放头竖线：横穿标尺与所有轨道（时间 0 = 轨道头右缘；逐帧位移走 transport）。 */}
          <div ref={lineRef} style={{ position: 'absolute', left: HEADER_W - 0.5, top: 0, bottom: 0, width: 1, background: '#ff453a', zIndex: 6, pointerEvents: 'none', opacity: 0.85 }} />
        </div>
      </div>

      {/* 自定义横向滚动条：常驻、对齐 lane 区域（左侧空出轨道头宽度）。
          点空白 = 视窗跳过去并顺势拖动；拖 thumb = 精细滚动。 */}
      <div style={{ display: 'flex', height: 14, flexShrink: 0, background: '#141416', borderTop: '0.5px solid rgba(255,255,255,0.06)' }}>
        <div style={{ width: HEADER_W, flexShrink: 0, background: '#1b1b1e', borderRight: '0.5px solid rgba(255,255,255,0.10)' }} />
        <div
          ref={trackRef}
          onPointerDown={onSbDown} onPointerMove={onSbMove} onPointerUp={onSbUp} onPointerCancel={onSbUp}
          style={{ flex: 1, position: 'relative', touchAction: 'none', userSelect: 'none' }}
        >
          <div
            data-sb-thumb="1"
            style={{ position: 'absolute', top: 3, bottom: 3, left: sbThumbX, width: sbThumbW, borderRadius: 4, background: 'rgba(255,255,255,0.18)', cursor: maxScroll > 0 ? 'grab' : 'default' }}
          />
        </div>
      </div>

      {/* 底注：当前播放头下的画面来自哪段（transport 订阅者直改文本）。 */}
      <div ref={noteRef} style={{ padding: '4px 10px', fontSize: 10.5, color: 'rgba(255,255,255,0.4)', borderTop: '0.5px solid rgba(255,255,255,0.06)', flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} />
    </div>
  );
};

// ── 一段片段 ────────────────────────────────────────────────────────────────────────────────
const Clip: React.FC<{
  clip: VidClip;
  pps: number;
  selected: boolean;
  /** 剃刀在手（按住 C）：整个片段变十字光标，左键 = 剪开。 */
  blade?: boolean;
  /** 资产的整段波形 PNG（音频段按 offset/duration 裁窗；undefined = 没入库预览，纯色块）。 */
  wave?: string;
  /** /api/vid_media/ 的文件名（视频段按 offset / offset+duration 向后端按需取头尾帧）。 */
  mediaFile?: string;
  onStartDrag: (e: React.PointerEvent, mode: 'move' | 'l' | 'r', clip: VidClip) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onDelete: () => void;
  onUnlink: () => void;
}> = ({ clip: c, pps, selected, blade, wave, mediaFile, onStartDrag, onPointerMove, onPointerUp, onDelete, onUnlink }) => {
  const isAudio = c.kind === 'audio';
  const K = KIND_UI[c.kind];
  const hideImg = (e: React.SyntheticEvent<HTMLImageElement>) => { e.currentTarget.style.display = 'none'; };
  // 视频段头/尾帧：t 是**片段自己的**第一帧/最后一帧（源内 offset 与 offset+duration 处）——
  // 裁剪改了 offset/duration，要的帧就变了，于是重新取一张。
  const headT = c.offset;
  const tailT = Math.max(0, c.offset + c.duration - 0.05);
  const backendFrame = (t: number) => `/api/vid_frame?f=${encodeURIComponent(mediaFile || '')}&t=${t.toFixed(2)}`;
  const wide = c.duration * pps > 72;   // 太窄的片段只画头帧，尾帧让位

  // 拖动裁剪时**立刻**要有画面：先从缩略条上取最靠近的那一格（同步、零 seek），
  // 停手后再由下面的 effect 换成精确帧。两层合起来 = 跟手且准。
  // 音频段不给它抽条：条是视频帧，纯音频源（mp3/wav）咬不动，白占队列十几秒。
  useStrip(isAudio ? '' : c.src, c.srcDuration);
  // 静态预览的门槛：**正在裁**（需要逐帧跟手）或**这条源的条已经抽完**（索引稳定）。
  // 半成品只给拖动顶位用 —— 拿它当静态预览，抽条每发布一批画面就跳一次。
  const quickOk = performance.now() - lastTrimAt < 200 || stripComplete(c.src);
  const quickHead = quickOk ? stripFrame(c.src, c.srcDuration, headT) : undefined;
  const quickTail = quickOk && wide ? stripFrame(c.src, c.srcDuration, tailT) : undefined;

  // ── 预览图的两条路 ── 后端有 ffmpeg：波形随资产来、帧走 /api/vid_frame（盘上有缓存）。
  // 后端没有：浏览器自己解 —— AudioBuffer 画波形、<video> seek 后 drawImage 出帧。
  // 两条路都带缓存，取不到就留着纯色块（图片类资产、浏览器解不动的编码）。
  const [waveUrl, setWaveUrl] = useState<string | undefined>(wave);
  useEffect(() => {
    if (!isAudio) return;
    if (wave) { setWaveUrl(wave); return; }
    let alive = true;
    void ensureWaveform(c.src).then(u => { if (alive && u) setWaveUrl(u); });
    return () => { alive = false; };
  }, [isAudio, wave, c.src]);

  // ── 首/尾帧：两级 —— **缩略条那一格（同步）先上，精确帧停手 120ms 再换**。 ──
  // 关键一条：精确帧必须**记住自己属于哪个时刻**。裁剪时 headT 每动一次，旧帧立刻判废，
  // 退回缩略条那一格；否则旧 headUrl 会一直压着新算出来的快帧 —— 画面就是"裁剪时不更新"。
  // 同理，拖动途中不许每次 pointermove 都去排一次精确取帧（队列越拖越堵，回来也早过时了）。
  const [headFrame, setHeadFrame] = useState<{ t: number; url: string } | null>(
    () => (mediaFile ? { t: headT, url: backendFrame(headT) } : null));
  useEffect(() => {
    if (isAudio) return;
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        const u = mediaFile && await frameBackend() ? backendFrame(headT) : await ensureFrame(c.src, headT);
        if (alive && u) setHeadFrame({ t: headT, url: u });
      })();
    }, 120);
    return () => { alive = false; clearTimeout(timer); };
  }, [isAudio, mediaFile, c.src, headT]);

  const [tailFrame, setTailFrame] = useState<{ t: number; url: string } | null>(null);
  useEffect(() => {
    if (isAudio || !wide) return;
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        const u = mediaFile && await frameBackend() ? backendFrame(tailT) : await ensureFrame(c.src, tailT);
        if (alive && u) setTailFrame({ t: tailT, url: u });
      })();
    }, 120);
    return () => { alive = false; clearTimeout(timer); };
  }, [isAudio, mediaFile, c.src, tailT, wide]);

  // 精确帧只在"属于当前时刻"时才作数；否则用同步的缩略条格。
  const preciseHead = headFrame && Math.abs(headFrame.t - headT) < 0.02 ? headFrame.url : undefined;
  const preciseTail = tailFrame && Math.abs(tailFrame.t - tailT) < 0.02 ? tailFrame.url : undefined;
  const headSrc = preciseHead ?? quickHead;
  const tailSrc = wide ? (preciseTail ?? quickTail) : undefined;
  return (
    <div
      onPointerDown={e => onStartDrag(e, 'move', c)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      title={`${c.name} — ${fmtTime(c.duration)}${c.hasAudio ? ' · audio' : ''}${c.groupId ? ' · linked A/V (Alt-drag moves this one alone; click ⧉ to unlink for good)' : ''}`}
      style={{
        position: 'absolute', left: c.start * pps, width: Math.max(8, c.duration * pps), top: 3, bottom: 3,
        borderRadius: 6, overflow: 'hidden', cursor: blade ? BLADE_CURSOR : 'grab', userSelect: 'none',
        // 上亮下暗的立面色：片段是"一片实体"，不是一块半透明色纸；选中时白边 + 外发光。
        background: `linear-gradient(180deg, ${K.clipA}, ${K.clipB})`,
        border: selected ? '1px solid rgba(255,255,255,0.92)' : `0.5px solid ${K.edge}`,
        boxShadow: selected ? `0 0 0 1px ${K.edge}, 0 2px 8px rgba(0,0,0,0.45)` : '0 1px 3px rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', padding: '0 8px', gap: 6,
      }}
    >
      {/* 顶部 2px 高亮条：颜色即类型，一眼分得出这条是画面还是声音。 */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 2, background: K.accent, opacity: 0.85, pointerEvents: 'none' }} />
      {/* 预览层：视频段 = 头帧 + 尾帧；音频段 = 全段波形裁出本片段的窗。 */}
      {!isAudio && headSrc && (
        <img src={headSrc} onError={hideImg} decoding="async"
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, height: '100%', width: 'auto', maxWidth: 64, objectFit: 'cover', opacity: 0.42, pointerEvents: 'none' }} />
      )}
      {!isAudio && tailSrc && (
        <img src={tailSrc} onError={hideImg} decoding="async"
          style={{ position: 'absolute', top: 0, bottom: 0, right: 0, height: '100%', width: 'auto', maxWidth: 64, objectFit: 'cover', opacity: 0.42, pointerEvents: 'none' }} />
      )}
      {isAudio && waveUrl && (
        <img src={waveUrl} onError={hideImg}
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, height: '100%',
          width: `${(c.srcDuration / Math.max(c.duration, 0.001)) * 100}%`,
          marginLeft: `${-(c.offset / Math.max(c.duration, 0.001)) * 100}%`,
          objectFit: 'fill', opacity: 0.5, pointerEvents: 'none' }} />
      )}
      <span style={{ fontSize: 10.5, fontWeight: 600, color: 'rgba(255,255,255,0.94)', textShadow: '0 1px 2px rgba(0,0,0,0.55)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none', position: 'relative' }}>{c.name}</span>
      <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.72)', flexShrink: 0, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', pointerEvents: 'none', position: 'relative', background: 'rgba(0,0,0,0.38)', padding: '1px 5px', borderRadius: 4, textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>{fmtTime(c.duration)}</span>
      {c.groupId && (
        <button
          title="Linked A/V pair — click to unlink; each side then moves/trims on its own (hold Alt while dragging for a one-off)"
          onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onUnlink(); }}
          style={{ flexShrink: 0, fontSize: 9, color: 'rgba(255,255,255,0.7)', background: 'rgba(0,0,0,0.3)', border: 'none', borderRadius: 4, cursor: 'pointer', padding: '2px 3px', lineHeight: 1, position: 'relative', display: 'flex', alignItems: 'center' }}
        ><IconLink /></button>
      )}
      {/* 裁剪把手：左右各一条窄带。 */}
      <div onPointerDown={e => onStartDrag(e, 'l', c)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 7, cursor: blade ? BLADE_CURSOR : 'ew-resize', background: 'rgba(255,255,255,0.10)', borderLeft: '1px solid rgba(255,255,255,0.28)' }} />
      <div onPointerDown={e => onStartDrag(e, 'r', c)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 7, cursor: blade ? BLADE_CURSOR : 'ew-resize', background: 'rgba(255,255,255,0.10)', borderRight: '1px solid rgba(255,255,255,0.28)' }} />
      {/* 删除。 */}
      <button
        title="Delete clip" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onDelete(); }}
        style={{ position: 'absolute', top: 3, left: 10, width: 13, height: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)', border: 'none', borderRadius: 3, color: 'rgba(255,255,255,0.8)', cursor: 'pointer', padding: 0, opacity: selected ? 1 : 0.5 }}
      >
        <svg width="7" height="7" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 3l6 6M9 3l-6 6" /></svg>
      </button>
    </div>
  );
};
