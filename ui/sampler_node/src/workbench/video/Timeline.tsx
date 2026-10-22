import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  type VidClip, type VidController, type VidTrack, type VidMergeProbe,
  addLayerClip, addTrack, clipAtSolo, fmtTime, importToTrack, isAudioName, isVideoName, mergeVidClips, moveClip, moveTrack, outputClipOf, placeAsset, probeVidMerge, procSlotBusy, removeClip, removeTrack, renameTrack,
  replaceVidClipsWithMerged, setMaskTrack, splitClip, toggleVgenChain, trackOf, trimClip, unlinkGroup, vidDuration, vidMergeStructure,
  vgenChainPrevOf, vgenSeamsOf, vgenWithDuration,
} from './model';
import { keyIs, onGlobalKey, onGlobalKeyUp } from '../../hotkeys';
import { probeMedia } from './audio';
import { ingestFile } from './ingest';
import { GLOBAL_ITEM_TYPE } from './Assets';
import {
  ensureFrame, ensureStrip, ensureWaveform, frameBackend, peekStrip, stripComplete, stripFrame, subscribeStrip,
} from './previews';
import { getProcFill, getProcQueue, subscribeProcFill, subscribeProcQueue } from './procRun';

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
const HEADER_W = 140;
// 底部横向滚动条：条子（thumb）最窄 28px —— 两端各要放一颗圆把手，再窄就挤成一团。
// 圆把手直径 11px，骑在 thumb 的左右边缘上（半颗在外），拖它 = 改 thumb 宽。
const SB_THUMB_MIN = 28;
const SB_KNOB = 11;
const sbKnobStyle = (side: 'l' | 'r'): React.CSSProperties => ({
  position: 'absolute', top: '50%', marginTop: -SB_KNOB / 2,
  left: side === 'l' ? -SB_KNOB / 2 : undefined,
  right: side === 'r' ? -SB_KNOB / 2 : undefined,
  width: SB_KNOB, height: SB_KNOB, borderRadius: '50%',
  background: '#b4b4bc', boxShadow: '0 0 0 0.5px rgba(0,0,0,0.65), 0 0 3px rgba(0,0,0,0.45)',
  cursor: 'ew-resize',
});
// 四类轨同一高度：视频轨不再比音频 / Layer / process 高出一截，横向扫过去是一条齐线。
const TRACK_H: Record<'video' | 'audio' | 'layer' | 'process', number> = { video: 46, audio: 46, layer: 46, process: 46 };
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
const IconLayers: React.FC = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 2.4 14 5.6 8 8.8 2 5.6z" />
    <path d="M2.6 8.4 8 11.3l5.4-2.9" />
    <path d="M2.6 11.2 8 14.1l5.4-2.9" />
  </svg>
);
// process 轨：虚线框里一颗"待跑"的三角 —— 它装的不是画面，是还没跑出来的坑。
const IconProcess: React.FC = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2.2" y="3.4" width="11.6" height="9.2" rx="1.6" strokeDasharray="2.4 1.8" />
    <path d="M6.6 6.4v3.2l3-1.6z" fill="currentColor" stroke="none" />
  </svg>
);
// 占位段的设置齿轮：所有保存信息（名字/位置/时长/接口/params/抽帧窗口）的入口。
const IconGear: React.FC = () => (
  <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 2.2v1.4M8 12.4v1.4M2.2 8h1.4M12.4 8h1.4M4 4l1 1M11 11l1 1M12 4l-1 1M5 11l-1 1" />
  </svg>
);
// 生成器轨的轨级提示词：点开 prompt 弹窗（与 prompt block 的编辑器同一套界面）。
const IconPrompt: React.FC = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13.4 8.6a5.4 5.4 0 10-2.4 2.6l2.9 0.7z" />
    <path d="M5.4 6.6h5.2M5.4 9h3.2" />
  </svg>
);
const IconLink: React.FC = () => (
  <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round">
    <path d="M6.5 9.5l3-3M6.8 4.6l1-1a2.6 2.6 0 013.7 3.7l-1 1M9.2 11.4l-1 1a2.6 2.6 0 01-3.7-3.7l1-1" />
  </svg>
);
/** 跳转：方框 + 出去的箭头（external-link 读法）——.cud 预览角上那颗"去编辑这份工程"。 */
const IconJump: React.FC = () => (
  <svg width="7" height="7" viewBox="0 0 12 12" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 8.5l5-5M5 3.5h3.5V7" />
  </svg>
);
// 生成器段的运行 / 停止：段上不写 "Run" / "Stop" 两个字，三角形与方块自己说话。
const IconPlay: React.FC = () => (
  <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" stroke="none">
    <path d="M5.3 3.3 12.3 8l-7 4.7z" />
  </svg>
);
const IconStop: React.FC = () => (
  <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" stroke="none">
    <rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.1" />
  </svg>
);
// 合并：两段并成一段。
const IconMerge: React.FC = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4.2" width="5.2" height="7.6" rx="1.2" />
    <rect x="8.8" y="4.2" width="5.2" height="7.6" rx="1.2" />
    <path d="M7.2 8h1.6" />
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

// 轨道类型的配色：视频蓝、音频绿、Layer 琥珀、process 浅灰白。文字/图标/带子全从这里取，
// 别处不再写颜色。
const KIND_UI = {
  video: { fg: '#64d2ff', chipBg: 'rgba(10,132,255,0.16)', bandA: 'rgba(10,132,255,0.030)',
    bandB: 'rgba(10,132,255,0.012)', clipA: 'rgba(10,132,255,0.26)', clipB: 'rgba(10,132,255,0.12)',
    edge: 'rgba(10,132,255,0.75)', accent: '#64d2ff' },
  audio: { fg: '#30d158', chipBg: 'rgba(48,209,88,0.16)', bandA: 'rgba(48,209,88,0.030)',
    bandB: 'rgba(48,209,88,0.012)', clipA: 'rgba(48,209,88,0.40)', clipB: 'rgba(48,209,88,0.22)',
    edge: 'rgba(48,209,88,0.72)', accent: '#30d158' },
  // Layer 轨用暖琥珀：它装的不是素材，是"一段合成"——和画面蓝/声音绿都拉开距离。
  layer: { fg: '#ffc46b', chipBg: 'rgba(255,176,74,0.16)', bandA: 'rgba(255,176,74,0.030)',
    bandB: 'rgba(255,176,74,0.012)', clipA: 'rgba(255,176,74,0.40)', clipB: 'rgba(255,176,74,0.22)',
    edge: 'rgba(255,176,74,0.72)', accent: '#ffb04a' },
  // process 轨（占位段）用中性白：**待跑**的坑，和跑出来的成品（输出轨、蓝）区分开。
  // 白压到 0.5 上下 —— 是"浅灰白"而不是刺眼的纯白。
  process: { fg: '#d7d7dc', chipBg: 'rgba(255,255,255,0.12)', bandA: 'rgba(255,255,255,0.022)',
    bandB: 'rgba(255,255,255,0.010)', clipA: 'rgba(255,255,255,0.17)', clipB: 'rgba(255,255,255,0.08)',
    edge: 'rgba(255,255,255,0.50)', accent: '#c9c9cf' },
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

export const VidTimeline: React.FC<{
  vid: VidController;
  /** 占位段的齿轮（设置入口）：参数 = 这一批要一起改的占位段 id。
   *  点中的段在现有多选里 → 整个多选集合；否则只它自己。 */
  onSettingsPlaceholders?: (clipIds: string[]) => void;
  /** video generator 段的 ▶：按段上那份配置把这台生成器跑一遍。 */
  onRunVGen?: (clipId: string) => void;
  /** video generator 段的首/末帧卡片：挑一张图片资产或磁盘上的 .cud 工程。 */
  onPickVGenFrame?: (clipId: string, which: 'first_frame' | 'last_frame') => void;
  /** video generator 轨头上的齿轮（轨设置：宽高 / from canvas / scale / fps —— 轨上所有段共享）。 */
  onVGenTrackSettings?: (trackId: string) => void;
  /** video generator 轨头上的 prompt 图标（轨级提示词：prompt 弹窗，段提示词在 Segment 之外）。 */
  onVGenTrackPrompt?: (trackId: string) => void;
  /** video generator 段的 prompt 图标（段自己的提示词：prompt 弹窗）。 */
  onVGenPrompt?: (clipId: string) => void;
  /** .cud 帧卡预览上的跳转按钮：把那份工程送进 blend 编辑器（已开着就切换过去）。 */
  onVGenCudOpen?: (path: string, name?: string) => void;
}> = ({ vid, onSettingsPlaceholders, onRunVGen, onPickVGenFrame, onVGenTrackSettings, onVGenTrackPrompt, onVGenPrompt, onVGenCudOpen }) => {
  const { project: p, transport, pps } = vid;
  // 占位段队列（多选 ▶ 排出的那一队）：还没轮到的段画 ⏸，正在跑的（有填充进度）画 ■。
  // 订阅放在时间线这一层：一条队只敲一次重渲，不按片段各订一遍。
  const procQueue = useSyncExternalStore(subscribeProcQueue, getProcQueue);
  const dur = vidDuration(p);
  // 生成器段的接缝（可连的两两一对）：接缝徽章与 Ctrl 点击都照这份表来，按轨过滤后各画各的。
  const seams = vgenSeamsOf(p);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  // 多选：Ctrl/⌘ 点选切换单颗、Shift 在同轨上连选。锚点是上一次单击的那颗。
  const [selIds, setSelIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const selAnchorRef = useRef<string | null>(null);
  const selectOnly = useCallback((id: string) => {
    selAnchorRef.current = id;
    setSelIds(new Set([id]));
  }, []);
  const clearSel = useCallback(() => {
    selAnchorRef.current = null;
    setSelIds(new Set<string>());
  }, []);
  // ── Shift + 拖空白 = 框选（可以跨轨）：矩形碰到的片段全选。片段自己会 stopPropagation，
  //    所以"在片段上按住 Shift 拖"仍是原来的同轨连选，不和这里抢手势。 ──
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marqueeMoved = useRef(false);
  const laneClickBlocked = useRef(false);
  const startMarquee = (e: React.PointerEvent) => {
    if (!e.shiftKey || e.button !== 0) return;
    e.preventDefault();                              // 别顺手把轨道名/页面文字选中
    laneClickBlocked.current = true;                 // 松手后的 click 不要清掉框选结果
    marqueeMoved.current = false;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 合成事件不挡手势 */ }
    marqueeRef.current = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
    setMarquee(marqueeRef.current);
  };
  const onMarqueeMove = (e: React.PointerEvent) => {
    const m = marqueeRef.current;
    if (!m) return;
    if (Math.abs(e.clientX - m.x0) > 3 || Math.abs(e.clientY - m.y0) > 3) marqueeMoved.current = true;
    marqueeRef.current = { ...m, x1: e.clientX, y1: e.clientY };
    setMarquee(marqueeRef.current);
  };
  const endMarquee = (apply: boolean) => {
    const m = marqueeRef.current;
    marqueeRef.current = null;
    setMarquee(null);
    if (!m || !apply || !marqueeMoved.current) return;   // Shift+点空白 = 保持原选择
    const left = Math.min(m.x0, m.x1), right = Math.max(m.x0, m.x1);
    const top = Math.min(m.y0, m.y1), bottom = Math.max(m.y0, m.y1);
    const picked = new Set<string>();
    contentRef.current?.querySelectorAll<HTMLElement>('[data-vid-clip]').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.left < right && r.right > left && r.top < bottom && r.bottom > top) {
        const id = el.getAttribute('data-vid-clip');
        if (id) picked.add(id);
      }
    });
    selAnchorRef.current = picked.size ? [...picked][0] : null;
    setSelIds(picked);
  };
  const [dropLane, setDropLane] = useState<string | null>(null);
  // 裁剪中的时长浮签：段面上平时不写时长，只有按住边缘拖的那一小段时间才报一下。
  // 浮签挂到 body（fixed）：片段自己的 overflow:hidden 与 lane 的裁剪都剪不到它。
  const [trimHint, setTrimHint] = useState<{ id: string; x: number; y: number } | null>(null);

  // ── 播放头直改 DOM ── 线、三角、时间读数、底注、跟随滚动都不走 React。
  const lineRef = useRef<HTMLDivElement | null>(null);
  const triRef = useRef<HTMLDivElement | null>(null);
  const readRef = useRef<HTMLSpanElement | null>(null);
  const noteRef = useRef<HTMLDivElement | null>(null);
  const ppsRef = useRef(pps); ppsRef.current = pps;
  const durRef = useRef(dur); durRef.current = dur;
  const projRef = useRef(p); projRef.current = p;
  // solo/mute 快照：paint 闭包活在 transport 订阅里（effect 只依赖 transport），
  // 直接读 vid 会拿到首帧那份 ——  mute/solo 改了底注不刷新。走 ref。
  const soloVideoRef = useRef(vid.solo.video); soloVideoRef.current = vid.solo.video;
  const muteRef = useRef(vid.mute); muteRef.current = vid.mute;
  useEffect(() => {
    const paint = () => {
      const t = transport.get();
      const px = t * ppsRef.current;
      if (lineRef.current) lineRef.current.style.transform = `translateX(${px}px)`;
      if (triRef.current) triRef.current.style.transform = `translateX(${px}px)`;
      if (readRef.current) readRef.current.textContent = `${fmtTime(t)} / ${fmtTime(durRef.current)}`;
      if (noteRef.current) {
        // 底注跟监视器同一口径：静音/solo 挡住的段不算"预览中"。
        const c = clipAtSolo(projRef.current, t, soloVideoRef.current, muteRef.current);
        noteRef.current.textContent = c
          ? `Preview: 「${c.name}」 (${fmtTime(c.offset + (t - c.start))} in source)`
          : 'Preview: no video showing under the playhead — muted, not soloed, or nothing there';
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

  // ── 对齐吸附 ── 拖动/裁剪时吸到：时间线 0、入/出点、播放头、其它片段的头与尾。
  // 阈值按**屏幕像素**给（缩放时手感一致）；按住 Ctrl/⌘ 临时关掉（见各拖动处的 ctrlNoSnap）。
  // 靶子带标签：吸住时在靶子上拉一条琥珀竖线并写明"吸的是谁"（见 showSnap）。
  type SnapHit = { t: number; label: string };
  const SNAP_PX = 6;
  const snapTargets = useCallback((exclude: ReadonlySet<string>, skipIo: boolean): SnapHit[] => {
    const ts: SnapHit[] = [
      { t: 0, label: 'Timeline start' },
      { t: transport.get(), label: 'Playhead' },
    ];
    if (!skipIo && p.outPoint > p.inPoint) {
      ts.push({ t: p.inPoint, label: 'In point' }, { t: p.outPoint, label: 'Out point' });
    }
    for (const c of p.clips) {
      if (exclude.has(c.id)) continue;
      ts.push({ t: c.start, label: `${c.name} · head` }, { t: c.start + c.duration, label: `${c.name} · tail` });
    }
    return ts;
  }, [p, transport]);
  // 拖动中的片段（含联动组成员）自己不能当靶子 —— 否则一按下去就被吸在原地不动。
  const movingIds = useCallback((clip: VidClip, linked: boolean): Set<string> => {
    const gid = linked ? clip.groupId : undefined;
    const ids = new Set<string>();
    for (const c of p.clips) if (c.id === clip.id || (gid && c.groupId === gid)) ids.add(c.id);
    return ids;
  }, [p]);
  /** 吸附指示：竖线 + 标签。直改 DOM —— 拖动每帧都算一次，走 React state 会把整条时间线重渲。 */
  const snapGuideRef = useRef<HTMLDivElement | null>(null);
  const snapChipRef = useRef<HTMLSpanElement | null>(null);
  const showSnap = useCallback((hit: SnapHit | null) => {
    const el = snapGuideRef.current;
    if (!el) return;
    if (!hit) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.left = `${HEADER_W + hit.t * vid.pps - 0.5}px`;
    if (snapChipRef.current) snapChipRef.current.textContent = hit.label;
  }, [vid.pps]);
  const clearSnap = useCallback(() => {
    const el = snapGuideRef.current;
    if (el) el.style.display = 'none';
  }, []);
  /** 单边吸附（裁剪 / 入出点）：把时刻 t 吸到最近的靶子上。 */
  const snapEdge = useCallback((t: number, exclude: ReadonlySet<string>, skipIo = false): SnapHit | null => {
    const tol = SNAP_PX / vid.pps;
    let best: SnapHit | null = null, bestD = tol;
    for (const s of snapTargets(exclude, skipIo)) {
      const d = Math.abs(s.t - t);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }, [snapTargets, vid.pps]);
  /** 整段吸附（拖动）：片段的头**和尾**都算候选，取位移最小的那一次。
   *  返回吸好的起点 + 吸中的靶子（靶子给指示线用：尾巴吸住时线要画在靶子上，不是片段头上）。 */
  const snapStart = useCallback((start: number, length: number, exclude: ReadonlySet<string>): { start: number; hit: SnapHit | null } => {
    const tol = SNAP_PX / vid.pps;
    let best: SnapHit | null = null, bestD = tol, delta = 0;
    for (const s of snapTargets(exclude, false)) {
      for (const own of [start, start + length]) {
        const d = Math.abs(s.t - own);
        if (d < bestD) { bestD = d; delta = s.t - own; best = s; }
      }
    }
    return { start: start + delta, hit: best };
  }, [snapTargets, vid.pps]);

  // ── 拖放落定 ── Assets 是项目所有数据的来源：先入库（同 src 认领已有的），再落一段引用
  // 它的片段 —— 不存在"直接进轨道"的路。
  //  * 图池条目：src 是 base64 图片 —— 走前端 <video>/WebAudio 探测（图片咬不动 = no-op）；
  //  * 本地文件：字节 POST 给后端 ffmpeg 入库（持久 URL + 精确探测 + 必要时转代理），后端
  //    没有 ffmpeg 时回退 blob + 前端探测（blob 活不过刷新，读档自会剪掉）。
  const importSource = useCallback(async (
    src: string, name: string, origin: 'staging' | 'file', trackId: string | null, at: number,
    asset?: string, play?: string,
  ) => {
    const info = await probeMedia(src, isAudioName(name) ? 'audio' : 'video');
    if (!info) return;
    vid.update(proj => importToTrack(proj, { src, name, origin, asset, play }, info, trackId, at), 'Add clip');
  }, [vid]);

  const importFile = useCallback(async (f: File, trackId: string | null, at: number) => {
    const ing = await ingestFile(f);
    if (ing) {
      vid.update(proj => importToTrack(proj, { src: ing.src, name: ing.name, origin: 'file', asset: ing.asset, play: ing.play },
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

  // ── Ctrl 按住：接缝上的连接/断开徽章才显形、才吃指针 ──
  // 平时接缝那一小块留给两侧的裁剪把手；按住 Ctrl 才换成链接开关（用户点名的手势）。
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const ctrlHeldRef = useRef(false);
  useEffect(() => {
    const set = (v: boolean) => {
      if (ctrlHeldRef.current === v) return;
      ctrlHeldRef.current = v;
      setCtrlHeld(v);
    };
    const down = (e: KeyboardEvent) => { if (e.key === 'Control' || e.key === 'Meta') set(true); };
    const up = (e: KeyboardEvent) => { if (e.key === 'Control' || e.key === 'Meta') set(false); };
    const blur = () => set(false);
    const un1 = onGlobalKey(down);
    const un2 = onGlobalKeyUp(up);
    window.addEventListener('blur', blur);
    return () => { un1(); un2(); window.removeEventListener('blur', blur); };
  }, []);

  // 这一段的哪一边是可连的生成器接缝：'r' = 接在它后面的那颗，'l' = 在它前面的那颗。
  // 已经连着也算（Ctrl+点 = 断开）。
  const vgenSeamAt = (clip: VidClip, edge: 'l' | 'r') => edge === 'r'
    ? seams.find(s => s.prev.id === clip.id) ?? null
    : seams.find(s => s.next.id === clip.id) ?? null;

  // ── 片段拖动 / 裁剪 ── pointer capture 挂在被按的那个元素上，move/up 都回到它身上。
  const startClipDrag = (e: React.PointerEvent, mode: 'move' | 'l' | 'r', clip: VidClip) => {
    e.stopPropagation();
    // 右键留给片段的合并菜单（见 openMergeMenu）：不在这里选中、不抓指针、不拖不裁。
    if (e.button !== 0) return;
    // Ctrl/⌘ + 左键点**接缝**（两侧的裁剪把手）= 连接/断开这两枚生成器段。
    // 接缝只由相邻的两段构成；不在接缝上的边照旧是普通裁剪（Ctrl 只临时关吸附）。
    if ((e.ctrlKey || e.metaKey) && mode !== 'move') {
      const seam = vgenSeamAt(clip, mode);
      if (seam) {
        e.preventDefault();
        vid.update(proj => toggleVgenChain(proj, seam.prev.id, seam.next.id),
          seam.linked ? 'Unlink generators' : 'Link generators');
        return;
      }
    }
    if (bladeRef.current) {
      // 剃刀优先于拖拽：切口落在指针处，片段不动。
      e.preventDefault();
      vid.update(proj => splitClip(proj, clip.id, timeAt(e.clientX), !e.altKey), 'Split clip');
      return;
    }
    // 选中口径（多选）：Ctrl/⌘ = 切换这一颗；Shift = 从锚点起同轨连选；普通点击 = 只选它。
    // 已选中的段再按时保留整组高亮（多选后拖其中一段，其余不该被清掉）。
    if (e.shiftKey) {
      const anchor = selAnchorRef.current
        ? p.clips.find(c => c.id === selAnchorRef.current)
        : null;
      const row = p.clips.filter(c => c.trackId === clip.trackId).sort((a, b) => a.start - b.start);
      const i0 = anchor ? row.findIndex(c => c.id === anchor.id) : -1;
      const i1 = row.findIndex(c => c.id === clip.id);
      if (anchor && anchor.trackId === clip.trackId && i0 >= 0 && i1 >= 0) {
        const a = Math.min(i0, i1), b = Math.max(i0, i1);
        setSelIds(new Set(row.slice(a, b + 1).map(c => c.id)));
      } else selectOnly(clip.id);
    } else if (e.ctrlKey || e.metaKey) {
      setSelIds(prev => {
        const next = new Set(prev);
        if (next.has(clip.id)) next.delete(clip.id); else next.add(clip.id);
        return next;
      });
      selAnchorRef.current = clip.id;
    } else if (!selIds.has(clip.id)) {
      selectOnly(clip.id);
    }
    vid.focusClip(clip);
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 指针已失活/合成事件：不挡手势 */ }
    dragRef.current = { mode, id: clip.id, x0: e.clientX, start0: clip.start };
    // 按在边缘上 = 即将裁剪：时长浮签从按下的这一刻就跟着指针（还没动也报当前值）。
    if (mode !== 'move') setTrimHint({ id: clip.id, x: e.clientX, y: e.clientY });
  };
  const onClipPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.mode === 'scrub' || d.mode === 'in' || d.mode === 'out') return;
    const dragId = d.id;
    // 按住 Alt = 暂时无视联动组，只动/只裁被拖的这一段（音视频错开的临时口子）。
    const linked = !e.altKey;
    // 按住 Ctrl/⌘ = 临时关掉对齐吸附。
    const noSnap = e.ctrlKey || e.metaKey;
    const clip = p.clips.find(c => c.id === dragId);
    if (d.mode === 'move') {
      // 指针脚下是哪条同类轨，就搬去哪条：elementFromPoint 穿过被拖的片段找 lane。
      let trackId: string | undefined;
      const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const lane = hit?.closest?.('[data-vid-track]');
      if (lane) {
        const tid = lane.getAttribute('data-vid-track') || '';
        const tr = trackOf(p, tid);
        if (tr && clip && tr.kind === clip.kind) trackId = tid;
      }
      const raw = Math.max(0, d.start0 + (e.clientX - d.x0) / vid.pps);
      const snap = noSnap || !clip ? null : snapStart(raw, clip.duration, movingIds(clip, linked));
      showSnap(snap ? snap.hit : null);
      vid.update(proj => moveClip(proj, dragId, snap ? snap.start : raw, trackId, linked), 'Move clip');
    } else {
      const edge: 'l' | 'r' = d.mode;
      lastTrimAt = performance.now();
      const t = timeAt(e.clientX);
      const hit = noSnap || !clip ? null : snapEdge(t, movingIds(clip, linked));
      showSnap(hit);
      // 浮签跟着指针走；字数从本帧的 project 读（trim 之后下一帧就是新长度）。
      setTrimHint(h => (h && h.id === dragId ? { ...h, x: e.clientX, y: e.clientY } : h));
      vid.update(proj => trimClip(proj, dragId, edge, hit ? hit.t : t, linked), 'Trim clip');
    }
  };
  const endClipDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    clearSnap();
    setTrimHint(null);
    // 生成器段：段长就是 duration 参数（双向绑定）—— 拖/裁完把新的长度写回那一口。
    // 与上面那一步裁剪同一个 label，撤销时两笔合成一步。
    if (d && (d.mode === 'l' || d.mode === 'r')) {
      const clip = p.clips.find(c => c.id === d.id);
      if (clip?.vgen) {
        vid.update(proj => ({
          ...proj,
          clips: proj.clips.map(c => (c.id === d.id && c.vgen)
            ? { ...c, vgen: vgenWithDuration(c.vgen, c.duration) } : c),
        }), 'Trim clip');
      }
    }
  };

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
    const raw = timeAt(e.clientX);
    // 入/出点也吃吸附（吸到片段头尾、播放头、0）；两个 I/O 点自己不当靶子 —— 吸到自己身上就拖不动了。
    const hit = (e.ctrlKey || e.metaKey) ? null : snapEdge(raw, new Set<string>(), true);
    showSnap(hit);
    const t = hit ? hit.t : raw;
    vid.update(proj => d.mode === 'in'
      ? { ...proj, inPoint: Math.max(0, Math.min(t, proj.outPoint > proj.inPoint ? proj.outPoint - 0.1 : dur - 0.1)) }
      : { ...proj, outPoint: Math.max(proj.inPoint + 0.1, t) }, 'Set range');
  };

  // ── 键删 ── Delete/Backspace 删选中的片段（多选时整批删；输入框里不抢）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selIds.size) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable) return;
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const ids = [...selIds];
      vid.update(proj => ids.reduce((acc, id) => removeClip(acc, id), proj), 'Delete clip');
      clearSel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selIds, vid, clearSel]);

  // ── 右键合并（多选 + 头尾相接）────────────────────────────────────────────────────────────
  // 菜单只在"多选、同轨同类、首尾严格相接"时露头（结构由 vidMergeStructure 判，见 model）。
  // 参数/帧窗口不满足、占位段正在跑、Layer 两套内容不一致时按钮置灰，原因写在下面。
  type MergeMenuState = {
    x: number;
    y: number;
    ids: string[];
    probe: VidMergeProbe;
    layerCheck: 'idle' | 'checking' | 'equal' | 'differ';
    busy: boolean;
    note: string;
  };
  const [mergeMenu, setMergeMenu] = useState<MergeMenuState | null>(null);
  // 异步回包认领号：关菜单 / 再开一次都会 ++，晚到的旧回包不会改到新菜单。
  const mergeSeq = useRef(0);
  const closeMergeMenu = useCallback(() => {
    mergeSeq.current++;
    setMergeMenu(null);
  }, []);
  const openMergeMenu = useCallback((e: React.MouseEvent, clip: VidClip) => {
    e.preventDefault();
    e.stopPropagation();
    // 右击未选中的段 = 只选它（多选之外的右键不合并）。
    if (!selIds.has(clip.id)) { selectOnly(clip.id); return; }
    const ids = [...selIds];
    if (!vidMergeStructure(p, ids).ok) return;      // 头尾不相连：不弹菜单
    const probe = probeVidMerge(p, ids);
    const token = ++mergeSeq.current;
    const base: MergeMenuState = {
      x: e.clientX, y: e.clientY, ids, probe,
      layerCheck: 'idle', busy: false, note: '',
    };
    if (probe.ok && probe.plan.kind === 'layer') {
      const keys = [...new Set(probe.plan.clips.map(c => c.layerKey || c.id))];
      if (vid.layerSigs && keys.length) {
        base.layerCheck = 'checking';
        void vid.layerSigs(keys).then(sigs => {
          if (mergeSeq.current !== token) return;
          const vals = keys.map(k => sigs[k] || '');
          const equal = vals.every(v => !!v && v === vals[0]);
          setMergeMenu(prev => (prev && mergeSeq.current === token
            ? {
              ...prev,
              layerCheck: equal ? 'equal' : 'differ',
              note: equal ? '' : (vals.some(v => !v)
                ? 'Could not read the layer contents from the workbench.'
                : 'The layer sets are not identical.'),
            }
            : prev));
        });
      } else {
        base.layerCheck = 'differ';
        base.note = 'Layer comparison is unavailable.';
      }
    }
    setMergeMenu(base);
  }, [p, selIds, selectOnly, vid]);
  useEffect(() => {
    if (!mergeMenu) return;
    const inMenu = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      return !!el && typeof el.closest === 'function' && !!el.closest('[data-vid-merge-menu]');
    };
    const onDown = (e: PointerEvent) => { if (!inMenu(e.target)) closeMergeMenu(); };
    const onCtx = (e: MouseEvent) => { if (!inMenu(e.target)) closeMergeMenu(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeMergeMenu();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('contextmenu', onCtx, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeMergeMenu);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('contextmenu', onCtx, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', closeMergeMenu);
    };
  }, [mergeMenu !== null, closeMergeMenu]);
  const runMerge = async () => {
    const m = mergeMenu;
    if (!m || m.busy || !m.probe.ok) return;
    const plan = m.probe.plan;
    if (plan.kind === 'layer' && m.layerCheck !== 'equal') return;
    if (plan.clips.some(c => c.pending && getProcFill(c.id) >= 0)) {
      setMergeMenu(prev => (prev ? { ...prev, note: 'A selected segment is running — wait for it to finish.' } : prev));
      return;
    }
    const firstId = plan.clips[0].id;
    if (plan.kind === 'video' && plan.videoMode === 'concat') {
      // 异源（或同源但源内不连续）：后端 ffmpeg 按 in/out 切好后拼成一条新文件。
      setMergeMenu(prev => (prev ? { ...prev, busy: true, note: '' } : prev));
      try {
        const parts = plan.clips.map(c => ({ f: c.src, in: c.offset, out: c.offset + c.duration }));
        const r = await fetch('/api/vid_merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parts, name: plan.clips[0].name }),
        });
        const res = await r.json().catch(() => null) as {
          ok?: boolean; src?: string; name?: string; duration?: number; hasAudio?: boolean; error?: string;
        } | null;
        const src = res && res.ok ? res.src : '';
        if (!res || !src) {
          setMergeMenu(prev => (prev
            ? { ...prev, busy: false, note: String((res && res.error) || 'The server could not stitch these segments.') }
            : prev));
          return;
        }
        const total = Number(res.duration) || plan.clips.reduce((s, c) => s + c.duration, 0);
        vid.update(proj => replaceVidClipsWithMerged(
          proj, m.ids, src, res.name || plan.clips[0].name, total, !!res.hasAudio), 'Merge clips');
        closeMergeMenu();
        selectOnly(firstId);
      } catch (err) {
        setMergeMenu(prev => (prev
          ? { ...prev, busy: false, note: String((err as Error)?.message || err || 'Merge failed') }
          : prev));
      }
      return;
    }
    vid.update(proj => mergeVidClips(proj, m.ids, { layerEqual: plan.kind === 'layer' }), 'Merge clips');
    closeMergeMenu();
    selectOnly(firstId);
  };

  // ── 轨道头的拖动排序 / 双击重命名 ─────────────────────────────────────────────────────────
  // 排序走 **pointer 拖**（不走 HTML5 DnD）：轨道头按住（按钮/输入框除外）移动 5px 即进入，
  // 指针落在哪条轨的上半 / 下半，蓝色插入线就落在那条轨的上沿 / 下沿；松手按 splice 语义落位。
  // 不用 DnD 是有意的：lane 上已经住着资产拖放（dragover/drop 全套），再塞一种 MIME 进去，
  // 两种落点要在同一片区域里互相让路 —— pointer 拖根本不进那套事件，互不相干。
  // 重命名：双击名字变输入框，Enter/失焦提交、Escape 取消；提交走 renameTrack（空串不动）。
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const renamingRef = useRef<string | null>(null); renamingRef.current = renaming;
  const renameValRef = useRef(''); renameValRef.current = renameVal;
  const commitRename = (trackId: string) => {
    if (renamingRef.current !== trackId) return;   // Enter 提交后 input 卸载会再触发 blur：已收尾就别写
    renamingRef.current = null;
    setRenaming(null);
    const v = renameValRef.current.trim();
    const tr = p.tracks.find(t => t.id === trackId);
    if (tr && v && v !== tr.name) vid.update(proj => renameTrack(proj, trackId, v), 'Rename track');
  };
  const [trkDrag, setTrkDrag] = useState<{ id: string; idx: number } | null>(null);   // idx = 插入线（第 idx 条轨的上沿）
  const trkDragRef = useRef<{ id: string; idx: number } | null>(null); trkDragRef.current = trkDrag;
  const hdrDrag = useRef<{ id: string; x0: number; y0: number; active: boolean } | null>(null);
  const startHeaderDrag = (e: React.PointerEvent, tr: VidTrack) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button,input')) return;   // mute/solo/删除/改名输入框不抓手势
    // 按下**不**立刻抓指针：抓了会把后续 click/dblclick 全改派到头上，双击重命名就死了。
    // 指针捕获推迟到拖动激活的那一刻（见 onHeaderMove）。
    hdrDrag.current = { id: tr.id, x0: e.clientX, y0: e.clientY, active: false };
  };
  const onHeaderMove = (e: React.PointerEvent) => {
    const d = hdrDrag.current;
    if (!d) return;
    if (!d.active) {
      if (!(e.buttons & 1)) { hdrDrag.current = null; return; }   // 半路松了手（指针没回到头上）：别幻拖
      if (Math.abs(e.clientY - d.y0) < 5 && Math.abs(e.clientX - d.x0) < 5) return;
      d.active = true;
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 指针已失活：不挡手势 */ }
    }
    // 插入线落点：扫一遍行，指针在行中点之上就算"插在它前面"。
    const rows = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[data-vid-trackrow]') ?? []);
    let idx = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { idx = i; break; }
    }
    setTrkDrag(cur => (cur && cur.id === d.id && cur.idx === idx ? cur : { id: d.id, idx }));
  };
  const onHeaderUp = () => {
    const d = hdrDrag.current;
    const cur = trkDragRef.current;
    hdrDrag.current = null;
    setTrkDrag(null);
    if (!d || !d.active || !cur || cur.id !== d.id) return;
    const from = p.tracks.findIndex(t => t.id === d.id);
    let to = cur.idx;
    if (to > from) to -= 1;                       // 插入线语义 → splice 下标：跨过自己要减一格
    if (from >= 0 && to !== from) vid.update(proj => moveTrack(proj, d.id, to), 'Reorder track');
  };

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
  // `hasView` 也算一次触发：窗口若在隐藏的 tab 里挂载（DockView 的保留挂载格是 display:none），
  // clientWidth 是 0，那趟 Fit 只能用 120px 兜底 —— 量出真实宽度后必须重铺一次，
  // 否则 pps 会一直停在兜底值上，等下一次工程改动（随便点一下）才被顺带纠正。
  const hasView = viewW > 0;
  useEffect(() => {
    if (!hasView) return;      // 还没量到真实宽度：兜底值不铺，等量出来这一趟再铺
    if (userZoomedRef.current || dragRef.current || scrubRef.current) return;
    fitZoom();
  }, [dur, fitZoom, hasView]);

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
  const sbThumbW = maxScroll > 0
    ? Math.min(trackW, Math.max(SB_THUMB_MIN, laneViewW / laneContentW * trackW))
    : trackW;
  const sbSpan = Math.max(trackW - sbThumbW, 1);
  // thumb 位置夹在行程内：scrollLeft 可能来自浏览器的滚动恢复，越过 maxScroll 时不能把
  // thumb 画到轨道外面去（那正是"刷新后范围指示不正确、点一下才回来"的那一瞬）。
  const sbThumbX = maxScroll > 0
    ? Math.min(Math.max(scrollX, 0), maxScroll) / maxScroll * Math.max(trackW - sbThumbW, 0)
    : 0;

  // 拖拽三态：move = 整体平移（老行为）；l / r = 抓两端的圆把手**改宽**。
  // 改宽就是改"视口占多少时长"—— thumb 变宽 = 一秒变窄 = 看得更多 = 缩小，反之放大。
  // 所以它落到的其实是 pps（缩放），只不过入口换成了肉眼可见的条子宽度。
  const sbDrag = useRef<{
    mode: 'move' | 'l' | 'r';
    x0: number;
    /** 按下时的 scrollLeft。 */
    s0: number;
    /** 按下时的 thumb 宽（px）：把手的目标宽度一律从它算，不做增量累加 —— 不会漂。 */
    w0: number;
    /** 按下时视口左/右边缘对应的时刻。改宽时钉住对侧那个边缘，画面不游。 */
    tL: number;
    tR: number;
    /** 按下时 lane 的可视宽。改宽时**用它**换算（别在 effect 里重新量）：改宽会让轨道变高，
     *  纵向滚动条一出现 clientWidth 就少十几像素，重量的那一份会把钉住的边缘推歪。 */
    laneV: number;
  } | null>(null);
  // 改宽后要落回去的 scrollLeft：按**对侧边缘的时刻**重算（等 pps 生效那一趟再写）。
  const pendingSbRef = useRef<{ t: number; edge: 'l' | 'r'; laneV: number } | null>(null);

  // 落 scrollLeft **必须在 paint 之前**（useLayoutEffect，不是 useEffect）：
  // thumb 的宽来自 pps（这一帧就变了），位置来自 scrollX（要等滚动事件）。若滚动改在 paint 之后落，
  // 就会多出一帧"新宽度 + 旧滚动位" —— 钉住的那一端每走一步先跳出去十几像素再弹回来，
  // 也就是用户说的"拖一头、另一头抖"。layout effect 里落完顺手把 scrollX 同步给 React，
  // 一次同步重渲，宽度和位置就是同一帧的同一个世界（浏览器还没画）。
  useLayoutEffect(() => {
    const a = pendingSbRef.current;
    if (!a) return;
    const sc = scrollRef.current;
    if (!sc) return;
    pendingSbRef.current = null;
    const target = a.edge === 'l' ? a.t * vid.pps : a.t * vid.pps - a.laneV;
    const maxS = Math.max(sc.scrollWidth - sc.clientWidth, 0);
    sc.scrollLeft = Math.max(0, Math.min(maxS, target));
    setScrollX(sc.scrollLeft);        // 别等 scroll 事件：它比 paint 晚
  }, [pps, viewW]);

  const onSbDown = (e: React.PointerEvent) => {
    const sc = scrollRef.current, tr = trackRef.current;
    if (!sc || !tr) return;
    const el = e.target as HTMLElement;
    const handle = ((el?.dataset?.sbHandle || '') as '' | 'l' | 'r');
    if (handle) {
      // 把手：即便眼下没有可滚区间也接手势 —— 往里拖就是放大，先把区间造出来。
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 指针已失活/合成事件：不挡手势 */ }
      userZoomedRef.current = true;            // 手动改过视口占比 → 不再自动 Fit
      const laneV = Math.max(sc.clientWidth - HEADER_W, 1);
      const p = Math.max(vid.pps, 0.001);
      sbDrag.current = {
        mode: handle, x0: e.clientX, s0: sc.scrollLeft, w0: sbThumbW,
        tL: sc.scrollLeft / p, tR: (sc.scrollLeft + laneV) / p, laneV,
      };
      return;
    }
    if (maxScroll <= 0) return;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 指针已失活/合成事件：不挡手势 */ }
    const onThumb = !!el?.dataset?.sbThumb;
    if (!onThumb) { // 点空白处：视窗跳过去（点中即居中），接着顺势进入拖动。
      const rect = tr.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left - sbThumbW / 2) / sbSpan));
      sc.scrollLeft = frac * maxScroll;
    }
    const laneV = Math.max(sc.clientWidth - HEADER_W, 1);
    const p = Math.max(vid.pps, 0.001);
    sbDrag.current = {
      mode: 'move', x0: e.clientX, s0: sc.scrollLeft, w0: sbThumbW,
      tL: sc.scrollLeft / p, tR: (sc.scrollLeft + laneV) / p, laneV,
    };
  };
  const onSbMove = (e: React.PointerEvent) => {
    const d = sbDrag.current;
    const sc = scrollRef.current;
    if (!d || !sc) return;
    const dx = e.clientX - d.x0;
    if (d.mode === 'move') {
      sc.scrollLeft = Math.max(0, Math.min(maxScroll, d.s0 + dx * (maxScroll / sbSpan)));
      return;
    }
    if (trackW <= 0) return;
    // 把手走过的像素 = thumb 宽的变化量。反解 pps：
    //   thumbW = trackW · laneViewW / laneContentW  ⇒  laneContentW = trackW · laneViewW / thumbW
    //   laneContentW = contentW − HEADER_W = (dur + 10)·pps − HEADER_W
    const laneV = Math.max(sc.clientWidth - HEADER_W, 1);
    const want = Math.max(SB_THUMB_MIN, Math.min(trackW, d.mode === 'r' ? d.w0 + dx : d.w0 - dx));
    const laneWant = trackW * laneV / want;
    const ppsWant = Math.max(6, Math.min(480, (laneWant + HEADER_W) / Math.max(dur + 10, 0.1)));
    // 右把手动 ⇒ 左边缘的时刻钉住（往后看更多）；左把手动 ⇒ 右边缘钉住。
    pendingSbRef.current = d.mode === 'r' ? { t: d.tL, edge: 'l', laneV: d.laneV } : { t: d.tR, edge: 'r', laneV: d.laneV };
    if (Math.abs(ppsWant - vid.pps) > 1e-4) { vid.setPps(ppsWant); return; }
    // pps 已经顶到 6 / 480：不会再触发上面那个 effect，这一趟就地落。
    const a = pendingSbRef.current;
    pendingSbRef.current = null;
    const target = a.edge === 'l' ? a.t * vid.pps : a.t * vid.pps - a.laneV;
    const maxS = Math.max(sc.scrollWidth - sc.clientWidth, 0);
    sc.scrollLeft = Math.max(0, Math.min(maxS, target));
    setScrollX(sc.scrollLeft);
  };
  const onSbUp = () => { sbDrag.current = null; };

  // ── 标尺刻度 ── 选一个 ≥64px 的步长。
  const step = STEPS.find(s => s * pps >= 64) ?? STEPS[STEPS.length - 1];
  const ticks: React.ReactNode[] = [];
  // 刻度画到**内容宽**为止（contentW 已含可视区）：短工程也不会在右边留一段没有刻度的空带。
  // 刻度文字从刻度线往右写，末尾必须给它留出宽度 —— 一旦刻度撑出 contentW，内容层的
  // scrollWidth 就会大于 contentW：底部自定义滚动条的 thumb 按 contentW 算行程，浏览器却按
  // scrollWidth 滚 —— 滚到尽头、或者刷新时浏览器恢复了更靠右的 scrollLeft，thumb 就会被
  // 顶出轨道（"指示范围"失真），点一下滚动条才被夹回轨道内。
  const tickEnd = Math.max(0, (contentW - HEADER_W) / pps);
  const TICK_LABEL_W = 40;   // 刻度文字（m:ss.s，9px 字号）的最大宽
  for (let t = 0; HEADER_W + t * pps + TICK_LABEL_W <= contentW; t += step) {
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
    // 落点也吃吸附（对齐到片段头尾、I/O、播放头、0）；按住 Ctrl/⌘ 临时关掉。
    const raw = timeAt(e.clientX);
    const hit = (e.ctrlKey || e.metaKey) ? null : snapEdge(raw, new Set<string>());
    const at = hit ? hit.t : raw;
    clearSnap();
    const sid = e.dataTransfer.getData(ASSET_ITEM_TYPE);
    if (sid) {
      const asset = p.assets.find(a => a.id === sid);
      if (asset) { vid.update(proj => placeAsset(proj, asset, trackId, at), 'Add clip'); return; }
    }
    // 仓库资产（统一的 `application/x-asset` = {id,url,name,kind}）：它可能还不是本工程的资产，
    // 所以**不认 id、只认 url** —— 落定走 importSource，先入本工程资产库再落片段。
    // （旧的 `x-vid-global` 也在下面接一份，老落点还没退休。）
    const aRaw = e.dataTransfer.getData('application/x-asset');
    if (aRaw) {
      try {
        const a = JSON.parse(aRaw) as { url?: string; name?: string; kind?: string; asset?: string; play?: string | null };
        if (a?.url && a.kind !== 'image') {
          void importSource(a.url, a.name || a.url, 'file', trackId, at, a.asset, a.play || undefined);
          return;
        }
      } catch { /* 不是我们写的那份：继续往下看 */ }
    }
    // 全局资产（Assets 窗接在后面的那一段共享库）：载荷是 URL 而不是资产 id —— 它此刻还不属于
    // 这份工程。落定走 importSource：**先入本工程的资产库，再落一段引用它的片段**，与图池条目
    // 同一条路（Assets 是项目所有数据的来源，不存在"直接进轨道"的路）。
    const gRaw = e.dataTransfer.getData(GLOBAL_ITEM_TYPE);
    if (gRaw) {
      try {
        const g = JSON.parse(gRaw) as { url?: string; name?: string; asset?: string; play?: string | null };
        if (g?.url) { void importSource(g.url, g.name || g.url, 'file', trackId, at, g.asset, g.play || undefined); return; }
      } catch { /* 载荷不是我们写的那份：当没发生过，继续看后面几种 */ }
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
        <button style={{ ...btn, color: '#d7a6ff' }}
          title="Add a Layer track on top — it holds Layer segments, each with its own set of layers, composited over the video below. Only a Layer track that sits above every video track takes effect."
          onClick={() => vid.update(p2 => addTrack(p2, 'layer'), 'Add track')}>+ Layer Track</button>
        <button style={btn} title="Add an audio track at the bottom" onClick={() => vid.update(p2 => addTrack(p2, 'audio'), 'Add track')}>+ Audio Track</button>
        {/* Video 模式的 Mask = **一条轨的绑定**（不是画布上的一张墨迹）：绑了就把那条轨的画面
            亮度逐帧当 mask（白 = 覆盖）；None = 没绑 = 整幅都是工作区。preset 链没有输入口，
            它的 mask 就来自这里；Processor 的 mask 口有自己的端口来源，不看这里。 */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 4, fontSize: 10.5, color: 'rgba(255,255,255,0.5)' }}
          title="Video-mode Mask is a TRACK binding — the picked track's frames (luminance, white = covered) become the mask for every frame of a run. None = no mask, the whole frame is the workspace. Only Pipeline Preset runs read this; a Processor's mask input has its own source picker.">
          Mask
          <select
            data-vid-mask-track=""
            value={p.maskTrackId || ''}
            onChange={e => vid.update(proj => setMaskTrack(proj, e.target.value || null), 'Mask track')}
            style={{ fontSize: 10.5, padding: '2px 4px', borderRadius: 4, background: '#2a2a2e', color: 'rgba(255,255,255,0.8)', border: '0.5px solid rgba(255,255,255,0.14)', maxWidth: 130 }}
          >
            <option value="">None</option>
            {p.tracks.filter(t => t.kind === 'video').map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
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
          {p.tracks.map((tr, ti) => {
            // solo：音频/视频分开。Layer / process 轨不接。solo 亮着时这条轨的底色带一点琥珀。
            const isLayer = tr.kind === 'layer';
            const isProcess = tr.kind === 'process';
            const soloSet = isLayer || isProcess ? null : (tr.kind === 'audio' ? vid.solo.audio : vid.solo.video);
            const isSoloed = soloSet?.has(tr.id) ?? false;
            // mute：**所有轨类型都有**。语义按类型：音频 = 不响；视频 = 监视器不显示；
            // Layer = 段不合成（露出底下）。mute 优先于 solo。静音时轨道变灰、片段压暗。
            const isMuted = vid.mute.has(tr.id);
            return (
            <div key={tr.id} data-vid-trackrow="" style={{
              display: 'flex', height: TRACK_H[tr.kind],
              borderBottom: '0.5px solid rgba(255,255,255,0.05)',
              // 条纹底：两条轨挨着时边界一眼能分（同色系，亮暗交替，不抢片段）。
              // solo 亮着时盖一层琥珀 —— 一眼看出"这条在被单独听/看"；mute 时整条变灰。
              background: isMuted ? 'rgba(255,255,255,0.018)'
                : isSoloed ? 'rgba(255,159,10,0.07)'
                  : (ti % 2 ? KIND_UI[tr.kind].bandA : KIND_UI[tr.kind].bandB),
            }}>
              {/* 轨道头：拖住空白处上下拖 = 排序（插入线落点），双击名字 = 重命名。
                  类型徽章 + 名字 + mute + solo + 删除。徽章是一枚 18px 的圆角色块，图标居中 ——
                  颜色说类型，形状说用途，名字让位给省略号。 */}
              <div
                onPointerDown={e => startHeaderDrag(e, tr)}
                onPointerMove={onHeaderMove}
                onPointerUp={onHeaderUp} onPointerCancel={onHeaderUp}
                onDoubleClick={e => {
                  // 双击 = 重命名（捕获从不在按下时抢，dblclick 会正常落到头上）；按钮/输入框上不接。
                  if ((e.target as HTMLElement).closest('button,input')) return;
                  e.stopPropagation();
                  setRenameVal(tr.name);
                  setRenaming(tr.id);
                }}
                title={`Drag to reorder — order is stacking: video tracks composite top to bottom, a Layer track only composites while it sits above every video track. Double-click to rename.`}
                style={{ position: 'sticky', left: 0, width: HEADER_W, flexShrink: 0, zIndex: 4, background: '#1b1b1e', borderRight: '0.5px solid rgba(255,255,255,0.10)', display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px', cursor: trkDrag ? 'grabbing' : 'grab', userSelect: 'none' }}
              >
                <span style={{ width: 18, height: 18, borderRadius: 5, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: KIND_UI[tr.kind].chipBg, color: KIND_UI[tr.kind].fg }}>
                  {tr.kind === 'video' ? <IconFilm /> : tr.kind === 'layer' ? <IconLayers /> : tr.kind === 'process' ? <IconProcess /> : <IconWave />}
                </span>
                {renaming === tr.id ? (
                  <input
                    autoFocus
                    value={renameVal}
                    onChange={e => setRenameVal(e.target.value)}
                    onPointerDown={e => e.stopPropagation()}
                    onKeyDown={e => {
                      e.stopPropagation();     // 别让 C（剃刀）/ Delete（删片段）那套热键听见
                      if (e.key === 'Enter') commitRename(tr.id);
                      else if (e.key === 'Escape') { renamingRef.current = null; setRenaming(null); }
                    }}
                    onBlur={() => commitRename(tr.id)}
                    title="Track name — Enter to apply, Escape to cancel"
                    style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 600, background: 'rgba(0,0,0,0.45)', color: '#fff', border: '1px solid rgba(10,132,255,0.75)', borderRadius: 4, padding: '1px 4px', outline: 'none' }}
                  />
                ) : (
                  <span
                    style={{ fontSize: 11, fontWeight: 600, color: isMuted ? 'rgba(255,255,255,0.38)' : 'rgba(255,255,255,0.8)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >{tr.name}</span>
                )}
                {/* 这颗小标 = 这条轨就是 Video 模式的 Mask 源（顶部那颗下拉绑的）。 */}
                {p.maskTrackId === tr.id && (
                  <span data-vid-mask-badge="" title="This track is the video-mode Mask source — its frames' luminance is the mask for every frame of a preset run."
                    style={{ flexShrink: 0, fontSize: 8, fontWeight: 800, letterSpacing: 0.3, color: '#0a84ff', background: 'rgba(10,132,255,0.18)', border: '0.5px solid rgba(10,132,255,0.5)', borderRadius: 3, padding: '1px 3px', lineHeight: 1.1 }}>MASK</span>
                )}
                {/* 输出轨：Processor / Preset 的 process 段跑完，成品固定落在这一条的对应位置。 */}
                {tr.role === 'output' && (
                  <span data-vid-out-badge="" title="Output track — every finished Processor / Preset segment lands here at its placeholder's timeline position. Placeholders stay where they are and can be run again."
                    style={{ flexShrink: 0, fontSize: 8, fontWeight: 800, letterSpacing: 0.3, color: '#30d158', background: 'rgba(48,209,88,0.16)', border: '0.5px solid rgba(48,209,88,0.5)', borderRadius: 3, padding: '1px 3px', lineHeight: 1.1 }}>OUT</span>
                )}
                {/* 生成器轨的设置：宽高 / from canvas / scale / fps —— 轨上所有段共享，
                    段上不再有这些旋钮。fps 只对没开 Fixed FPS 的段生效。 */}
                {tr.role === 'vgen' && onVGenTrackSettings && (
                  <button
                    data-vid-vgen-track-settings={tr.id}
                    title={`Generator track settings — the width / height every generator segment on 「${tr.name}」 runs at: fixed values, or the workbench canvas scaled by a factor. Plus a track FPS that overrides the fps parameter of every segment here — segments with Fixed FPS turned on are not affected.`}
                    onPointerDown={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); onVGenTrackSettings(tr.id); }}
                    style={{ flexShrink: 0, width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: 'none', border: 'none', borderRadius: 4, color: 'rgba(255,255,255,0.45)', cursor: 'pointer', padding: 0 }}
                  ><IconGear /></button>
                )}
                {/* 生成器轨的轨级提示词：点开 prompt 编辑弹窗（prompt block 同一套界面）。
                    跑的时候渲染成串追加在每段自己的提示词后面 —— 段在前、轨在后。 */}
                {tr.role === 'vgen' && onVGenTrackPrompt && (
                  <button
                    data-vid-vgen-track-prompt={tr.id}
                    title={`Track prompt — extra prompt applied to every generator segment on 「${tr.name}」, appended after each segment's own prompt. Edit it in the full prompt UI (same editor as a Pipeline prompt block).`}
                    onPointerDown={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); onVGenTrackPrompt(tr.id); }}
                    style={{ flexShrink: 0, width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: 'none', border: 'none', borderRadius: 4, color: tr.vgenPromptPresetId ? '#64d2ff' : 'rgba(255,255,255,0.45)', cursor: 'pointer', padding: 0 }}
                  ><IconPrompt /></button>
                )}
                {/* mute：**所有轨类型都有**（Layer 轨也有 —— 它的段不合成）。亮着 = 这条轨不参与
                    输出（音频不响 / 视频不显示 / Layer 段不合成），且**优先于 solo**。再点一次取消。
                    process 轨不给（占位段本来就不出声不出画，静音没有意义）。 */}
                {!isProcess && (
                  <button
                    data-vid-mute={tr.id}
                    data-vid-mute-on={isMuted ? '1' : '0'}
                    title={`Mute ${tr.kind} track 「${tr.name}」 — ${tr.kind === 'audio' ? 'its clips stop sounding' : tr.kind === 'video' ? 'its clips stop showing on the monitor' : 'its segments stop compositing (what is below shows through)'}. Mute wins over solo. Click again to unmute.`}
                    onClick={() => vid.toggleMute(tr.id)}
                    style={{
                      flexShrink: 0, width: 15, height: 15, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: isMuted ? '#ff453a' : 'transparent',
                      border: isMuted ? 'none' : '0.5px solid rgba(255,255,255,0.2)',
                      borderRadius: 3, color: isMuted ? '#1a1a1a' : 'rgba(255,255,255,0.35)',
                      cursor: 'pointer', padding: 0, fontSize: 8.5, fontWeight: 800, lineHeight: 1,
                    }}
                  >M</button>
                )}
                {/* solo：视频/音频各一套（分开记）。亮着 = 只播 solo 的轨；视频 solo 还是**直接播**
                    （不走画布合成/底片）。再点一次取消。Layer / process 轨不给这个按钮。 */}
                {!isLayer && !isProcess && (
                  <button
                    data-vid-solo={tr.id}
                    data-vid-solo-on={isSoloed ? '1' : '0'}
                    title={`Solo ${tr.kind} track 「${tr.name}」 — only soloed ${tr.kind} tracks ${tr.kind === 'video' ? 'show (direct playback, bypasses the canvas)' : 'play'}. Click again to unsolo.`}
                    onClick={() => vid.toggleSolo(tr.id, tr.kind as 'video' | 'audio')}
                    style={{
                      flexShrink: 0, width: 15, height: 15, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: isSoloed ? '#ff9f0a' : 'transparent',
                      border: isSoloed ? 'none' : '0.5px solid rgba(255,255,255,0.2)',
                      borderRadius: 3, color: isSoloed ? '#1a1a1a' : 'rgba(255,255,255,0.35)',
                      cursor: 'pointer', padding: 0, fontSize: 8.5, fontWeight: 800, lineHeight: 1,
                    }}
                  >S</button>
                )}
                <button
                  title={'Delete track 「' + tr.name + '」 (its clips go with it)'}
                  onClick={() => {
                    const gone = new Set(p.clips.filter(c => c.trackId === tr.id).map(c => c.id));
                    vid.update(proj => removeTrack(proj, tr.id), 'Delete track');
                    setSelIds(prev => {
                      const next = new Set([...prev].filter(id => !gone.has(id)));
                      return next;
                    });
                  }}
                  style={{ flexShrink: 0, width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', borderRadius: 5, color: 'rgba(255,255,255,0.32)', cursor: 'pointer', padding: 0 }}
                >
                  <IconTrash />
                </button>
              </div>
              {/* lane：片段落在这里。Layer 轨不接素材（它装的是图层，不是文件），
                  process 轨也不接（它只装 Run 摆下的占位段），所以拖放一律回绝。 */}
              <div
                data-vid-track={tr.id}
                onDragOver={e => {
                  if (tr.kind === 'layer' || tr.kind === 'process') return;   // 合成轨 / process 轨不收素材
                  const ts = e.dataTransfer.types;
                  if (ts.includes(ASSET_ITEM_TYPE) || ts.includes('application/x-asset') || ts.includes(GLOBAL_ITEM_TYPE) || ts.includes(STAGING_ITEM_TYPE) || Array.from(ts).includes('Files')) {
                    e.preventDefault();
                    setDropLane(tr.id);
                    // 拖着素材悬停时就亮指示：落点会吸到谁，先看见再松手。
                    const hit = (e.ctrlKey || e.metaKey) ? null : snapEdge(timeAt(e.clientX), new Set<string>());
                    showSnap(hit);
                  }
                }}
                onDragLeave={() => { setDropLane(l => (l === tr.id ? null : l)); clearSnap(); }}
                onDrop={e => { if (tr.kind !== 'layer' && tr.kind !== 'process') laneDrop(e, tr.id); }}
                onClick={() => {
                  // Shift 框选松手后紧跟着的 click 不要清掉刚框出来的那批。
                  if (laneClickBlocked.current) { laneClickBlocked.current = false; return; }
                  clearSel(); vid.focusClip(null);
                }}
                onPointerDown={e => { if (e.shiftKey) startMarquee(e); else laneClickBlocked.current = false; }}
                onPointerMove={onMarqueeMove}
                onPointerUp={() => endMarquee(true)}
                onPointerCancel={() => endMarquee(false)}
                onDoubleClick={e => {
                  // 双击 Layer 轨 = 在指针处造一段（默认 5s）。段之间由 snapPlace 吸附，不会叠。
                  if (tr.kind !== 'layer') return;
                  e.stopPropagation();
                  vid.update(proj => addLayerClip(proj, tr.id, timeAt(e.clientX)), 'Add layer segment');
                }}
                title={tr.kind === 'layer' ? 'Layer track — double-click to add a Layer segment. Each segment owns its own layers; it composites over the video below and only takes effect while this track sits above every video track.'
                  : tr.kind === 'process' ? 'Process track — holds the Processor / Preset segment placeholders. Placeholders never play; each finished segment lands on the output track above at the same timeline position, and a placeholder can be run again any time (its previous result is replaced).' : undefined}
                style={{ position: 'relative', flex: 1, minWidth: 0, background: dropLane === tr.id ? 'rgba(10,132,255,0.08)' : 'transparent' }}
              >
                {p.clips.filter(c => c.trackId === tr.id).map(c => {
                  const gid = c.groupId;
                  // 生成器段链着的前一段 + 它已经跑出来的产物（首帧卡片的共享预览要用）。
                  const chainPrev = c.vgen ? vgenChainPrevOf(p, c) : null;
                  const chainOut = chainPrev ? outputClipOf(p, chainPrev) : null;
                  // 首尾相接的左邻：两段各画各的左边框/右边框，接缝就会叠成 2px
                  // （0.5px 在 1x 屏上各自进成 1px）。只留左邻那条右边框，缝统一 1px。
                  const touchesLeft = p.clips.some(x =>
                    x.trackId === tr.id && x.id !== c.id
                    && Math.abs((x.start + x.duration) - c.start) <= 0.002);
                  // 这个段（占位段或生成器段）的产物槽位是不是已经被别的东西占了
                  // （占了 ▶ 置灰 —— 自己的旧产物不算占）。
                  const outPort = c.pending?.port ?? c.vgen?.port;
                  const continueBlocked = (c.pending || c.vgen)
                    ? procSlotBusy(p, outPort ?? 0, c.start, c.duration, c.id) : false;
                  return (
                    <Clip key={c.id} clip={c} pps={pps} selected={selIds.has(c.id)} blade={blade} muted={isMuted}
                      touchesLeft={touchesLeft}
                      missing={!!((c.asset && vid.missing.has(c.asset)) || (c.play && vid.missing.has(c.play)))}
                      wave={assetBySrc.get(c.src)?.waveform}
                      mediaFile={/^\/api\/(?:vid|asset|global)_media\//.test(c.src) ? c.src.split('/').pop() : undefined}
                      onStartDrag={startClipDrag} onPointerMove={onClipPointerMove} onPointerUp={endClipDrag}
                      onContextMenu={openMergeMenu}
                      onUnlink={() => { if (gid) vid.update(proj => unlinkGroup(proj, gid), 'Unlink'); }}
                      continueBlocked={continueBlocked}
                      queued={procQueue.queued.includes(c.id)}
                      onDequeue={id => vid.pauseProc?.(id)}
                      onStop={id => vid.stopProc?.(id)}
                      onContinue={id => {
                        // ▶ 点中的段在当前多选里 → 整批按 左→右、同起点 下→上 依次跑；
                        // 不在多选里（或只选中这一颗）→ 只跑它自己。
                        if (selIds.has(id) && vid.continueProcMany) {
                          const ids = p.clips.filter(x => selIds.has(x.id) && x.pending).map(x => x.id);
                          if (ids.length > 1) { void vid.continueProcMany(ids); return; }
                        }
                        vid.continueProc?.(id);
                      }}
                      onSettings={onSettingsPlaceholders ? (id: string) => {
                        // 点中的段在多选里 → 整批一起设置；否则只它自己（并把它切成唯一选中）。
                        const inSel = selIds.has(id);
                        if (!inSel) selectOnly(id);
                        const ids = inSel
                          ? p.clips.filter(x => selIds.has(x.id) && x.pending).map(x => x.id)
                          : [id];
                        onSettingsPlaceholders(ids.length ? ids : [id]);
                      } : undefined}
                      onVGenRun={onRunVGen}
                      onVGenFrame={onPickVGenFrame}
                      onVGenPrompt={onVGenPrompt}
                      onVGenCudOpen={onVGenCudOpen}
                      chainPrev={chainPrev}
                      chainOut={chainOut} />
                  );
                })}
                {/* 生成器段的接缝：Ctrl+左键连接/断开。已连着的常驻一颗链标；没连的只在
                    Ctrl 按住时显形（平时这块地方属于两侧的裁剪把手）。z 在片段之上。 */}
                {seams.filter(s => s.prev.trackId === tr.id).map(s => (
                  <div
                    key={`seam-${s.prev.id}-${s.next.id}`}
                    data-vid-vgen-seam={`${s.prev.id}|${s.next.id}`}
                    data-vid-vgen-seam-linked={s.linked ? '1' : '0'}
                    title={s.linked
                      ? `Linked — 「${s.prev.name}」's last frame becomes 「${s.next.name}」's first frame when it runs. Ctrl-click the seam to disconnect.`
                      : `Ctrl-click to share frames: 「${s.prev.name}」's last frame becomes 「${s.next.name}」's first frame when it runs.`}
                    onPointerDown={e => {
                      if (!(e.ctrlKey || e.metaKey)) return;
                      e.stopPropagation();
                      e.preventDefault();
                      vid.update(proj => toggleVgenChain(proj, s.prev.id, s.next.id),
                        s.linked ? 'Unlink generators' : 'Link generators');
                    }}
                    style={{
                      position: 'absolute', left: s.next.start * pps - 9, top: '50%',
                      transform: 'translateY(-50%)', width: 18, height: 18, zIndex: 3,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      borderRadius: 999,
                      background: s.linked ? 'rgba(12,12,14,0.88)' : 'rgba(10,132,255,0.22)',
                      border: s.linked ? '1px solid rgba(255,255,255,0.7)' : '1px dashed rgba(140,205,255,0.95)',
                      color: s.linked ? '#fff' : 'rgba(215,238,255,0.95)',
                      boxShadow: s.linked ? '0 1px 4px rgba(0,0,0,0.55)' : 'none',
                      cursor: 'pointer',
                      pointerEvents: ctrlHeld ? 'auto' : 'none',
                    }}
                  ><IconLink /></div>
                ))}
              </div>
            </div>
            );
          })}

          {/* 轨道排序的插入线：拖轨道头时落在指针上方的行边界上（内容坐标 = 标尺高 + 前面各行高，
              行高随类型走）。画在 sticky 头之上（z 8）横贯整行，落点一眼可见。 */}
          {trkDrag && (() => {
            let y = RULER_H;
            for (let i = 0; i < trkDrag.idx && i < p.tracks.length; i++) y += TRACK_H[p.tracks[i].kind];
            return (
              <div style={{
                position: 'absolute', left: 0, width: contentW, top: y - 1.5, height: 3, borderRadius: 2,
                background: '#0a84ff', zIndex: 8, pointerEvents: 'none', boxShadow: '0 0 7px rgba(10,132,255,0.75)',
              }} />
            );
          })()}

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

          {/* Shift 框选的矩形：纯视觉（拖拽判定在 lane 的 pointer 事件里，命中靠片段 DOM 的
              rect 与矩形求交 —— 这样跨轨、跨行高都天然正确）。 */}
          {marquee && (() => {
            const root = contentRef.current;
            if (!root) return null;
            const r = root.getBoundingClientRect();
            const left = Math.min(marquee.x0, marquee.x1) - r.left;
            const top = Math.min(marquee.y0, marquee.y1) - r.top;
            const w = Math.abs(marquee.x1 - marquee.x0);
            const h = Math.abs(marquee.y1 - marquee.y0);
            if (w < 1 && h < 1) return null;
            return (
              <div style={{
                position: 'absolute', left, top, width: w, height: h, pointerEvents: 'none', zIndex: 7,
                border: '1px solid rgba(120,200,255,0.9)', background: 'rgba(10,132,255,0.12)', borderRadius: 2,
              }} />
            );
          })()}

          {/* 播放头竖线：横穿标尺与所有轨道（时间 0 = 轨道头右缘；逐帧位移走 transport）。 */}
          <div ref={lineRef} style={{ position: 'absolute', left: HEADER_W - 0.5, top: 0, bottom: 0, width: 1, background: '#ff453a', zIndex: 6, pointerEvents: 'none', opacity: 0.85 }} />

          {/* 对齐吸附指示：吸住时在**靶子**上拉一条琥珀竖线，顶端标签写明吸的是谁
              （Playhead / In point / 片段名 · head/tail / Timeline start）。位置和文字都由
              showSnap 直改 DOM（拖动每帧都变，不走 React）；没吸住时 display:none。 */}
          <div ref={snapGuideRef} data-vid-snap="1" style={{ position: 'absolute', left: 0, top: RULER_H, bottom: 0, width: 1, zIndex: 7, pointerEvents: 'none', display: 'none', background: '#ffd60a', boxShadow: '0 0 6px rgba(255,214,10,0.6)' }}>
            <span ref={snapChipRef} style={{ position: 'absolute', top: 4, left: 3, maxWidth: 240, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 9.5, lineHeight: '14px', padding: '0 5px', borderRadius: 2, background: 'rgba(255,214,10,0.92)', color: '#241c00', fontWeight: 600 }} />
          </div>
        </div>
      </div>

      {/* 自定义横向滚动条：常驻、对齐 lane 区域（左侧空出轨道头宽度）。
          点空白 = 视窗跳过去并顺势拖动；拖 thumb 中段 = 精细滚动；
          拖两端的圆把手 = 改 thumb 宽（= 改视口占多少时长，即缩放），对侧边缘不动。 */}
      <div style={{ display: 'flex', height: 14, flexShrink: 0, background: '#141416', borderTop: '0.5px solid rgba(255,255,255,0.06)' }}>
        <div style={{ width: HEADER_W, flexShrink: 0, background: '#1b1b1e', borderRight: '0.5px solid rgba(255,255,255,0.10)' }} />
        <div
          ref={trackRef}
          onPointerDown={onSbDown} onPointerMove={onSbMove} onPointerUp={onSbUp} onPointerCancel={onSbUp}
          style={{ flex: 1, position: 'relative', touchAction: 'none', userSelect: 'none' }}
        >
          {/* 底槽：一条 2px 的暗线横贯整条 —— 两端圆把手之间的那段才是"当前视口"，有槽才看得出范围。 */}
          <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 2, marginTop: -1, borderRadius: 1, background: 'rgba(255,255,255,0.055)', pointerEvents: 'none' }} />
          <div
            data-sb-thumb="1"
            style={{ position: 'absolute', top: 3, bottom: 3, left: sbThumbX, width: sbThumbW, borderRadius: 4, background: 'rgba(255,255,255,0.26)', cursor: maxScroll > 0 ? 'grab' : 'default' }}
          >
            <span data-sb-handle="l" style={sbKnobStyle('l')} />
            <span data-sb-handle="r" style={sbKnobStyle('r')} />
          </div>
        </div>
      </div>

      {/* 底注：当前播放头下的画面来自哪段（transport 订阅者直改文本）。 */}
      <div ref={noteRef} style={{ padding: '4px 10px', fontSize: 10.5, color: 'rgba(255,255,255,0.4)', borderTop: '0.5px solid rgba(255,255,255,0.06)', flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} />

      {/* 右键合并菜单：挂到 body（不受轨道区的滚动/裁剪影响），fixed 定位。 */}
      {mergeMenu && createPortal((() => {
        const m = mergeMenu;
        const plan = m.probe.ok ? m.probe.plan : null;
        const running = !!plan && plan.clips.some(c => c.pending && getProcFill(c.id) >= 0);
        const blocked = !m.probe.ok ? m.probe.reason
          : !plan ? ''
            : running ? 'A selected segment is running — wait for it to finish.'
              : plan.kind === 'layer' && m.layerCheck === 'checking' ? 'Comparing the layer contents…'
                : plan.kind === 'layer' && m.layerCheck !== 'equal' ? (m.note || 'The layer sets are not identical.')
                  : m.note;
        const disabled = !plan || running || m.busy || (plan.kind === 'layer' && m.layerCheck !== 'equal');
        const label = !plan ? 'Merge segments'
          : plan.kind === 'process' ? `Merge ${plan.clips.length} process segments`
            : plan.kind === 'layer' ? `Merge ${plan.clips.length} layer segments`
              : plan.videoMode === 'concat'
                ? `Merge ${plan.clips.length} video segments (stitch into a new file)`
                : `Merge ${plan.clips.length} video segments`;
        return (
          <div
            data-vid-merge-menu="1"
            onContextMenu={e => e.preventDefault()}
            style={{
              position: 'fixed', zIndex: 9999,
              left: Math.max(8, Math.min(m.x, window.innerWidth - 342)),
              top: Math.max(8, Math.min(m.y, window.innerHeight - 104)),
              minWidth: 230, maxWidth: 330, padding: 4, borderRadius: 8,
              background: 'rgba(34,34,38,0.985)', border: '0.5px solid rgba(255,255,255,0.16)',
              boxShadow: '0 12px 36px rgba(0,0,0,0.6)',
            }}
          >
            <button
              disabled={disabled}
              onClick={() => { void runMerge(); }}
              title={blocked || 'Merge the selected adjacent segments into one.'}
              style={{
                display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left',
                padding: '6px 9px', borderRadius: 5, border: 'none',
                background: disabled ? 'transparent' : 'rgba(10,132,255,0.18)',
                color: disabled ? 'rgba(255,255,255,0.38)' : 'rgba(255,255,255,0.92)',
                fontSize: 11.5, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
              }}
            >
              <IconMerge />{m.busy ? 'Merging…' : label}
            </button>
            {blocked && (
              <div style={{ padding: '4px 9px 5px', fontSize: 10, lineHeight: 1.45, color: 'rgba(255,255,255,0.5)' }}>
                {blocked}
              </div>
            )}
          </div>
        );
      })(), document.body)}

      {/* 裁剪时长浮签：段上平时不写时长，只有按着左右边缘拖的时候才把当前长度报出来。
          挂 body 上 fixed 定位（不受轨道滚动/裁剪），跟着指针走，不吃任何指针事件。 */}
      {trimHint && (() => {
        const c = p.clips.find(x => x.id === trimHint.id);
        if (!c) return null;
        return createPortal(
          <div data-vid-trim-hint="1" style={{
            position: 'fixed', zIndex: 9999, pointerEvents: 'none', whiteSpace: 'nowrap',
            left: Math.max(8, Math.min(trimHint.x + 14, window.innerWidth - 88)),
            top: Math.max(8, trimHint.y - 28),
            padding: '2px 7px', borderRadius: 5, fontSize: 10.5, fontWeight: 700,
            fontVariantNumeric: 'tabular-nums', color: '#241c00',
            background: 'rgba(255,214,10,0.94)', border: '0.5px solid rgba(0,0,0,0.25)',
            boxShadow: '0 3px 10px rgba(0,0,0,0.45)',
          }}>{fmtTime(c.duration)}</div>,
          document.body,
        );
      })()}
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
  /** 所在轨被静音：片段整体压暗去色 —— "这条轨不参与输出"要一眼看得出。 */
  muted?: boolean;
  /** 资产的整段波形 PNG（音频段按 offset/duration 裁窗；undefined = 没入库预览，纯色块）。 */
  wave?: string;
  /** /api/vid_media/ 的文件名（视频段按 offset / offset+duration 向后端按需取头尾帧）。 */
  mediaFile?: string;
  onStartDrag: (e: React.PointerEvent, mode: 'move' | 'l' | 'r', clip: VidClip) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  /** 右键：多选且首尾相接时弹合并菜单（见 VidTimeline 的 openMergeMenu）。 */
  onContextMenu: (e: React.MouseEvent, clip: VidClip) => void;
  onUnlink: () => void;
  /** 占位段上的 ▶（续跑这一段）；undefined = 宿主没接（按钮不画）。 */
  onContinue?: (clipId: string) => void;
  /** 占位段的齿轮（设置）：undefined = 不画。 */
  onSettings?: (clipId: string) => void;
  /** 与左邻首尾相接：不画自己的左边框（接缝由左邻的右边框出面，总宽 1px 而不是 2px）。 */
  touchesLeft?: boolean;
  /** 这个占位的产物槽位已被别的东西占着：▶ 置灰不跑（自己的旧产物不算占）。 */
  continueBlocked?: boolean;
  /** 这一段还在多选 ▶ 的队列里（没轮到）：按钮换成 ⏸，点击退出队列。 */
  queued?: boolean;
  onDequeue?: (clipId: string) => void;
  /** 这一段正在跑：按钮换成 ■，点击只打断这一段（后面的队列继续）。 */
  onStop?: (clipId: string) => void;
  /** 它引用的仓库哈希已经不在仓库里（A5）：段面盖红斜纹 + 「!」—— 去 Assets 窗的 Project 档 relink。 */
  missing?: boolean;
  /** video generator 段的 ▶（按段上那份配置跑这台生成器）；undefined = 宿主没接（按钮不画）。 */
  onVGenRun?: (clipId: string) => void;
  /** video generator 段的首/末帧卡片：点一下挑图（图片资产或磁盘上的 .cud 工程）。 */
  onVGenFrame?: (clipId: string, which: 'first_frame' | 'last_frame') => void;
  /** video generator 段的 prompt 图标（段自己的提示词：prompt 弹窗）。 */
  onVGenPrompt?: (clipId: string) => void;
  /** .cud 帧卡预览上的跳转按钮：把那份工程送进 blend 编辑器（已开着就切换过去）。 */
  onVGenCudOpen?: (path: string, name?: string) => void;
  /** 生成器段链着的前一段（null = 没链）：首帧卡片的共享预览与"链优先"语义都要它。 */
  chainPrev?: VidClip | null;
  /** 前一段已经跑出来的产物（末帧预览取它的最后一帧；没跑过 = null）。 */
  chainOut?: VidClip | null;
}> = ({ clip: c, pps, selected, blade, muted, wave, mediaFile, onStartDrag, onPointerMove, onPointerUp, onContextMenu, onUnlink, touchesLeft, continueBlocked, queued, onDequeue, onStop, onContinue, onSettings, missing, onVGenRun, onVGenFrame, onVGenPrompt, onVGenCudOpen, chainPrev, chainOut }) => {
  const isAudio = c.kind === 'audio';
  // 缺失：只有"真有来源"的段才可能缺（Layer 段、占位段、生成器段都没有仓库来源）。
  const gone = !!missing && c.kind !== 'layer' && !c.pending && !c.vgen;
  // Layer 段没有源文件：不抽条、不取首尾帧，只画一块"合成区间"。
  const isLayer = c.kind === 'layer';
  // Processor 占位段同样没有源（等跑完才有）：不抽条不取帧，画一块带快照的"待跑坑"。
  const isPending = !!c.pending;
  // Video Generator 段：与占位段同一条 process 轨、同一套"产物落到输出轨"的规矩，但装的是
  // 生成器自己的一套（提示词 / 宽高 / 时长 / 帧率 / 首末帧），段面因此多几个控件。
  const isVGen = !!c.vgen;
  // 两者都没有播放源 —— 抽条 / 取帧那几条路对它们一律不接。
  const noMedia = isLayer || isPending || isVGen;
  // 普通视频段不画名字/时长：画面本身就是标识，文字只留给 tooltip。
  const isVideoClip = c.kind === 'video' && !isPending;
  // 占位段的宽度命运：一段常常只有几十像素（1 秒 @ 60px/s），名字 + 段号 + ▶ Run 挤不下。
  // 窄的时候只留一颗 ▶（名字/段号/时长让位给 tooltip）—— 按钮绝不能被 overflow 裁掉。
  const clipW = Math.max(8, c.duration * pps);
  // 生成器段：左右各一张帧卡片，中间「齿轮 + ▶ + 名字」。窄段先收卡片（帧卡片缩到图标大小），
  // 再窄就只留两颗按钮 —— 名字与时长让位给 tooltip / 裁剪浮签。
  const tight = (isPending || isVGen) && clipW < (isVGen ? 150 : 108);
  // 生成器段的帧卡片宽度跟着段宽走：宽段铺满 64px，窄段逐步收窄（下限 24）——
  // 中间的齿轮 / ▶ / 段名永远留得下，预览也不会在某个宽度上突然缩水。
  const cardW = isVGen ? Math.max(24, Math.min(64, Math.round((clipW - 108) / 2))) : 0;
  // 窄到看不清的段：内部那套控件与文字**一概不画**，只剩一块类型色（预览帧 / 波形照旧）。
  // 阈值按那套 UI 的最小成行宽度算：生成器段 = 两张 24px 帧卡 + 齿轮/▶ 各 18 + 间距 ≈ 104；
  // 占位段 = 齿轮 + 紧凑 ▶ + 内边距 ≈ 64；其余段的段名/徽章再窄只剩半截字，56 以下也收掉。
  // 段本身仍是可拖/可裁/可选的实体 —— 这里只决定画不画里面的界面。
  const micro = clipW < (isVGen ? 104 : isPending ? 64 : 56);
  const K = KIND_UI[c.kind];
  // 占位段一律用 process 轨的浅灰白 —— 旧存档里的占位段可能还躺在视频轨上（kind='video'），
  // 颜色也必须一眼认出"这是个待跑的坑"，不能跟着脚下轨道变蓝。
  const PK = KIND_UI.process;
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
  useStrip(isAudio || noMedia ? '' : c.src, c.srcDuration);
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
    if (isAudio || noMedia) return;
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        const u = mediaFile && await frameBackend() ? backendFrame(headT) : await ensureFrame(c.src, headT);
        if (alive && u) setHeadFrame({ t: headT, url: u });
      })();
    }, 120);
    return () => { alive = false; clearTimeout(timer); };
  }, [isAudio, noMedia, mediaFile, c.src, headT]);

  const [tailFrame, setTailFrame] = useState<{ t: number; url: string } | null>(null);
  useEffect(() => {
    if (isAudio || noMedia || !wide) return;
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        const u = mediaFile && await frameBackend() ? backendFrame(tailT) : await ensureFrame(c.src, tailT);
        if (alive && u) setTailFrame({ t: tailT, url: u });
      })();
    }, 120);
    return () => { alive = false; clearTimeout(timer); };
  }, [isAudio, noMedia, mediaFile, c.src, tailT, wide]);

  // 精确帧只在"属于当前时刻"时才作数；否则用同步的缩略条格。
  const preciseHead = headFrame && Math.abs(headFrame.t - headT) < 0.02 ? headFrame.url : undefined;
  const preciseTail = tailFrame && Math.abs(tailFrame.t - tailT) < 0.02 ? tailFrame.url : undefined;
  const headSrc = preciseHead ?? quickHead;
  const tailSrc = wide ? (preciseTail ?? quickTail) : undefined;
  // 占位段的"被充满"进度：这一段在跑时从左往右涨（procRun 的小仓库，段内 0..1）。
  // -1 = 还没报出步数/没在跑 —— 画一窄条意思一下，跑完随替换一起消失。
  const fillP = useSyncExternalStore(subscribeProcFill, () => getProcFill(c.id));
  const running = fillP >= 0;   // 有填充进度 = 这一段正在跑（按钮换成 ■）
  // 左邻相接时要把左边框让出来。宽度必须显式写回：`borderLeftWidth: undefined` 会让 React
  // 拆开 border 简写，左边宽度掉回浏览器默认的 medium（3px）—— 预览/内容会凭空缩进 2px。
  const edgeW = gone || selected || isPending || isVGen ? 1 : 0.5;
  return (
    <div
      data-vid-clip={c.id}
      onPointerDown={e => onStartDrag(e, 'move', c)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={e => onContextMenu(e, c)}
      // 片段上按下已经选中它了；click / dblclick 别冒泡到 lane —— 那里"点空白"会清选中、双击会再造一段。
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      title={isVGen && c.vgen
        ? `${c.name} — video generator segment for 「${c.vgen.iface}」 (${fmtTime(c.duration)}${c.vgen.fixed_fps ? ', fixed fps' : ''}). ${chainPrev ? `Linked to 「${chainPrev.name}」 — its last frame is this segment's first frame (Ctrl-click the seam to disconnect). ` : ''}${c.vgen.ports.first_frame ? 'The left frame card binds the first frame; ' : ''}${c.vgen.ports.last_frame ? 'the right frame card binds the last frame; ' : ''}Width / height / fps are the track settings (the gear on the track header) and the track prompt is the speech bubble next to it; ▶ sends the segment's values into the interface and the finished video lands on the output track above at this position. The segment stays, so it can be run again.`
        : isPending && c.pending
        ? `${c.name} — ${c.pending.kind === 'preset' ? 'Pipeline Preset' : 'Processor'} placeholder, segment ${c.pending.segIndex + 1}/${c.pending.segCount} of 「${c.pending.iface}」 (nothing to show until it runs). Click ▶ Run to execute just this segment from its stored snapshot; the result lands on the output track above and this placeholder stays, so it can be run again. Drag/trim/delete like any clip.`
        : `${c.name} — ${fmtTime(c.duration)}${c.hasAudio ? ' · audio' : ''}${c.groupId ? ' · linked A/V (Alt-drag moves this one alone; click ⧉ to unlink for good)' : ''}${gone ? ' · MEDIA MISSING from the asset store — pick the original file in the Assets window (Project scope) to relink' : ''}`}
      style={{
        position: 'absolute', left: c.start * pps, width: Math.max(8, c.duration * pps), top: 3, bottom: 3,
        borderRadius: 0, overflow: 'hidden', cursor: blade ? BLADE_CURSOR : 'grab', userSelect: 'none',
        // 上亮下暗的立面色：片段是"一片实体"，不是一块半透明色纸；选中时白边 + 外发光。
        // 占位段：虚线浅灰白边 —— "这里有个坑等着被填"一眼认出；跑出来的成品在输出轨上是实心蓝。
        background: (isPending || isVGen) ? `linear-gradient(180deg, ${PK.clipA}, ${PK.clipB})` : `linear-gradient(180deg, ${K.clipA}, ${K.clipB})`,
        border: gone ? '1px solid rgba(255,69,58,0.9)'
          : selected ? '1px solid rgba(255,255,255,0.92)'
          : (isPending || isVGen) ? `1px dashed ${PK.edge}` : `0.5px solid ${K.edge}`,
        // 首尾相接时让出左边框：接缝只画左邻那条右边框，不会两条叠成 2px。
        borderLeftWidth: touchesLeft ? 0 : edgeW,
        boxShadow: selected ? `0 0 0 1px ${K.edge}, 0 2px 8px rgba(0,0,0,0.45)` : '0 1px 3px rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', padding: isVGen ? 0 : '0 8px', gap: 6,
        // 静音：压暗 + 去色 —— 段还在（还能拖/裁/删），只是不参与输出。
        opacity: muted ? 0.34 : 1, filter: muted ? 'saturate(0.3)' : undefined,
      }}
    >
      {/* 上边不再叠一条 2px 高亮条：它压在 0.5px 的边框上，会让顶边看起来比三边厚一截。
          类型色已经由四边等宽的彩色边框表达。 */}
      {/* 占位段的填充层：**只在跑的时候**出现（fillP >= 0）—— 待跑/跑完的占位不画任何填充色。 */}
      {isPending && fillP >= 0 && (
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, pointerEvents: 'none',
          width: `${Math.max(2, fillP * 100)}%`,
          background: 'rgba(255,255,255,0.24)', borderRight: `1px solid ${PK.edge}`,
          transition: 'width 0.45s linear',
        }} />
      )}
      {/* 预览层：视频段 = 头帧 + 尾帧；音频段 = 全段波形裁出本片段的窗。 */}
      {!isAudio && !isLayer && headSrc && (
        <img src={headSrc} onError={hideImg} decoding="async"
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, height: '100%', width: 'auto', maxWidth: 64, objectFit: 'cover', pointerEvents: 'none' }} />
      )}
      {!isAudio && !isLayer && tailSrc && (
        <img src={tailSrc} onError={hideImg} decoding="async"
          style={{ position: 'absolute', top: 0, bottom: 0, right: 0, height: '100%', width: 'auto', maxWidth: 64, objectFit: 'cover', pointerEvents: 'none' }} />
      )}
      {isAudio && waveUrl && (
        <img src={waveUrl} onError={hideImg}
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, height: '100%',
          width: `${(c.srcDuration / Math.max(c.duration, 0.001)) * 100}%`,
          marginLeft: `${-(c.offset / Math.max(c.duration, 0.001)) * 100}%`,
          objectFit: 'fill', opacity: 0.5, pointerEvents: 'none' }} />
      )}
      {isLayer && !micro && (
        <span style={{ display: 'flex', alignItems: 'center', color: '#ffd9a8', flexShrink: 0, position: 'relative', pointerEvents: 'none' }}><IconLayers /></span>
      )}
      {/* 缺失：整段盖一层红斜纹（画面/波形还在也压得住），右边挂一颗「!」。 */}
      {gone && (
        <span style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
          background: 'repeating-linear-gradient(45deg, rgba(255,69,58,0.26) 0 5px, rgba(255,69,58,0.05) 5px 10px)' }} />
      )}
      {gone && !micro && (
        <span title="MEDIA MISSING — the bytes are gone from the asset store. Relink the original file in the Assets window (Project scope)."
          style={{ position: 'relative', flexShrink: 0, fontSize: 9, fontWeight: 800, fontStyle: 'normal',
            color: '#fff', background: 'rgba(255,69,58,0.95)', borderRadius: 4, padding: '1px 5px',
            lineHeight: 1.25, pointerEvents: 'none' }}>!</span>
      )}
      {!micro && !(tight && (isPending || isVGen)) && !isVideoClip && !isVGen && (
        <span style={{ fontSize: 10.5, fontWeight: 600, color: 'rgba(255,255,255,0.94)', textShadow: '0 1px 2px rgba(0,0,0,0.55)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none', position: 'relative' }}>{c.name}</span>
      )}
      {/* 占位段：段号徽章 + ▶ Run。点 ▶ 只续跑这一段（快照重放），其余照常拖/裁/删。 */}
      {isPending && c.pending && !micro && (
        <>
          {(!tight || clipW >= 88) && (
            <span style={{ fontSize: 9, color: PK.fg, flexShrink: 0, fontVariantNumeric: 'tabular-nums', pointerEvents: 'none', position: 'relative' }}>{c.pending.segIndex + 1}/{c.pending.segCount}</span>
          )}
          {onContinue && (
            <span
              title={running
                ? 'Stop this segment — the rest of the queue keeps running.'
                : queued
                  ? 'Remove this segment from the queue — it stays on the track and can be run again later.'
                  : continueBlocked
                    ? `The output track already has a clip over ${fmtTime(c.start)}–${fmtTime(c.start + c.duration)} — move or delete it before running this segment again.`
                    : `Run this segment from its stored snapshot (${c.pending.kind === 'preset' ? 'preset' : 'interface'} 「${c.pending.iface}」, segment ${c.pending.segIndex + 1}/${c.pending.segCount}; params and frame windows are kept in the clip). The result lands on the output track, leaving this placeholder in place. With several placeholders selected, ▶ runs them all in order (left → right, bottom → top).`}
              onPointerDown={e => e.stopPropagation()}
              style={{ flexShrink: 0, display: 'flex', position: 'relative', margin: tight ? '0 auto' : undefined }}
            >
              {running && onStop ? (
                // 正在跑：■ = 只打断这一段（队列里后面的段照跑）。
                <button
                  title="Stop this segment — the rest of the queue keeps running."
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); onStop(c.id); }}
                  style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, color: '#fff', background: 'rgba(255,69,58,0.92)', border: 'none', borderRadius: 4, cursor: 'pointer', padding: tight ? '3px 6px' : '2px 7px', lineHeight: 1.2, display: 'flex', alignItems: 'center', gap: 3 }}
                >{tight ? '■' : '■ Stop'}</button>
              ) : queued && onDequeue ? (
                // 排队中：⏸ = 退出队列（占位段留在轨上，之后可再 ▶）。
                <button
                  title="Remove this segment from the queue — it stays on the track and can be run again later."
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); onDequeue(c.id); }}
                  style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, color: PK.fg, background: 'rgba(255,255,255,0.16)', border: `0.5px solid ${PK.edge}`, borderRadius: 4, cursor: 'pointer', padding: tight ? '3px 6px' : '2px 7px', lineHeight: 1.2, display: 'flex', alignItems: 'center', gap: 3 }}
                >{tight ? '❚❚' : '❚❚ Pause'}</button>
              ) : (
                <button
                  disabled={continueBlocked}
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); if (!continueBlocked) onContinue(c.id); }}
                  style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, color: continueBlocked ? 'rgba(255,255,255,0.4)' : '#17131c', background: continueBlocked ? 'rgba(255,255,255,0.14)' : PK.accent, border: 'none', borderRadius: 4, cursor: continueBlocked ? 'not-allowed' : 'pointer', padding: tight ? '3px 6px' : '2px 7px', lineHeight: 1.2, display: 'flex', alignItems: 'center', gap: 3 }}
                >{tight ? '▶' : '▶ Run'}</button>
              )}
            </span>
          )}
          {/* 设置：所有保存信息都在这里（名字/位置/时长/接口/params/抽帧窗口）。多选时
              点其中一段的齿轮 = 整批一起改，字段值不一样的地方显示 —。 */}
          {onSettings && (
            <button
              title={`Placeholder settings — edit every saved field (name, position, duration, interface / preset, parameter values, frame windows). With several placeholders selected this applies to all of them; fields that differ show — and stay untouched unless you edit them.`}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); onSettings(c.id); }}
              style={{
                flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                position: 'relative', width: tight ? 18 : 20, height: 18, padding: 0,
                background: 'rgba(0,0,0,0.3)', border: `0.5px solid ${PK.edge}`, borderRadius: 4,
                color: PK.fg, cursor: 'pointer',
              }}
            ><IconGear /></button>
          )}
        </>
      )}
      {/* Video generator 段：左右两张帧卡片（虚线外框，绑了图就铺预览），中间是
          齿轮（设置，提示词也在那扇窗里）+ ▶（一颗图标，不写 Run）+ 段名。
          帧卡片只在这台生成器**绑了那个口**时才出现（没绑首帧口就没有"给它一张首帧"这回事）。 */}
      {isVGen && c.vgen && !micro && (() => {
        const v = c.vgen;
        const frameCard = (which: 'first_frame' | 'last_frame') => {
          if (!v.ports[which]) return null;
          // 首帧卡在链着前一段时**链优先**：显示的是前一段的末帧（它绑了末帧卡用那张卡，
          // 否则用它产物的最后一帧），段自己绑的首帧让位 —— 断开链接才回来。
          const linked = which === 'first_frame' && !!chainPrev;
          const ref = linked ? (chainPrev!.vgen?.last_frame ?? null)
            : which === 'first_frame' ? v.first_frame : v.last_frame;
          // 前段没绑末帧卡 → 共享帧来自它的产物：走 /api/vid_frame 按需取末帧（盘上有缓存）。
          const outFile = linked && !ref && chainOut
            && /^\/api\/(?:vid|asset|global)_media\//.test(chainOut.src)
            ? chainOut.src.split('/').pop() : undefined;
          // 图片资产走**缩略图**接口（后端按 w 生成并落盘缓存）—— 卡片不该解码整张原图。
          // .cud 走合成图缩略（同一落盘缓存的另一族）：预览就是"那份工程现在的画面"，
          // 与图片资产同款满铺，不再只是 CUD 字样。
          const thumb = ref?.kind === 'asset' && ref.hash
            ? `/api/asset_thumb/${encodeURIComponent(ref.hash)}?w=96`
            : ref?.kind === 'cud' && ref.path
              ? `/api/cud_frame_thumb?path=${encodeURIComponent(ref.path)}&w=96`
              : outFile
                ? `/api/vid_frame?f=${encodeURIComponent(outFile)}&t=${Math.max(0, chainOut!.duration - 0.05).toFixed(2)}`
                : '';
          // 绑了东西（图片资产 / .cud 工程 / 链上前段的末帧）就是视频段首/尾帧那种**整高、
          // 无边框**的预览条；虚线框只留给什么都没有的占位卡 —— 链上的占位卡也算"有内容"，
          // 它说"末帧会来"。预览图加载失败时底下的 FF/LF/CUD 垫字露出来。
          const preview = !!thumb;
          // 卡片贴着段边，四边再各描一条就和段自己的边框叠成双线：只留**朝内**那一条虚线
          // 当分隔（左卡留右、右卡留左），上下和贴边那侧都不画。四边逐条写死宽度 ——
          // 简写碰到 undefined 会被 React 拆成 longhand，掉回浏览器默认的 medium。
          const divider = `1px dashed ${ref || linked ? 'rgba(255,255,255,0.55)' : PK.edge}`;
          const chainTip = linked
            ? (chainPrev!.vgen?.last_frame
              ? `First frame is shared with the previous generator segment 「${chainPrev!.name}」 — it uses that segment's bound last-frame card. Ctrl-click the seam to disconnect.`
              : chainOut
                ? `First frame is shared with the previous generator segment 「${chainPrev!.name}」 — it uses the last frame of that segment's result. Ctrl-click the seam to disconnect.`
                : `First frame will be shared with the previous generator segment 「${chainPrev!.name}」 — running this segment runs that one first and takes its last frame. Ctrl-click the seam to disconnect.`)
            : null;
          return (
            <button
              data-vid-vgen-frame={which}
              data-vid-vgen-chain={linked ? '1' : '0'}
              title={chainTip ?? (which === 'first_frame'
                ? 'First frame — bind an image asset or a .cud project (its canvas is read as the first frame). Click to pick; the value feeds the port this generator declared.' + (ref?.kind === 'cud' ? ' The ⤴ badge on the preview opens that project in the blend editor.' : '')
                : 'Last frame — bind an image asset or a .cud project (its canvas is read as the last frame). Click to pick; the value feeds the port this generator declared.' + (ref?.kind === 'cud' ? ' The ⤴ badge on the preview opens that project in the blend editor.' : ''))}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => {
                e.stopPropagation();
                if (linked) return;   // 链优先：这张卡显示的是前一段的末帧，要换绑定先断链
                onVGenFrame?.(c.id, which);
              }}
              style={{
                flexShrink: 0, width: cardW, height: '100%',
                padding: 0, borderRadius: 0, position: 'relative', overflow: 'hidden',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: preview ? 'none' : 'rgba(0,0,0,0.28)',
                borderTop: 'none', borderBottom: 'none',
                borderLeft: !preview && which === 'last_frame' ? divider : 'none',
                borderRight: !preview && which === 'first_frame' ? divider : 'none',
                color: PK.fg, cursor: linked ? 'default' : 'pointer', fontSize: 7.5, fontWeight: 800, lineHeight: 1,
              }}
            >
              {/* 占位文字垫在底下：预览图加载失败时它露出来，卡片不会变成一块空白。 */}
              <span style={{ position: 'relative', opacity: ref || linked ? 0.9 : 0.5 }}>
                {ref ? (ref.kind === 'cud' ? 'CUD' : 'IMG') : (which === 'first_frame' ? 'FF' : 'LF')}
              </span>
              {preview && (
                <img src={thumb} alt="" onError={hideImg}
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              )}
              {linked && (
                <span style={{ position: 'absolute', right: 1.5, top: 1.5, width: 12, height: 12,
                  borderRadius: 999, background: 'rgba(12,12,14,0.82)', border: '0.5px solid rgba(255,255,255,0.55)',
                  color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><IconLink /></span>
              )}
              {/* .cud 绑定的跳转徽章：预览右上（链徽章占了右上的链卡挪到左上，两枚都在）。
                  点它 = 把这份工程送进 blend 编辑器（已开着就切换），不当成"重挑绑定"。
                  两侧各有一条 7px 宽的裁剪把手盖在段缘上 —— 徽章退到把手内侧，整枚都可点。 */}
              {ref?.kind === 'cud' && onVGenCudOpen && (
                <span
                  data-vid-vgen-cud-jump=""
                  title={`Open 「${ref.name || ref.path}」 in the blend editor to edit it — if it is already open, this just switches to that window. The frame binding stays as it is.`}
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); onVGenCudOpen(ref.path, ref.name); }}
                  style={{ position: 'absolute', right: linked ? undefined : 9, left: linked ? 9 : undefined, top: 1.5,
                    width: 12, height: 12, borderRadius: 999,
                    background: 'rgba(12,12,14,0.82)', border: '0.5px solid rgba(255,255,255,0.55)',
                    color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                ><IconJump /></span>
              )}
            </button>
          );
        };
        const iconBtn: React.CSSProperties = {
          flexShrink: 0, width: 18, height: 18, padding: 0, borderRadius: 4,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          position: 'relative', border: 'none',
        };
        return (
          <>
            {frameCard('first_frame')}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, position: 'relative' }}>
              {/* 段自己的提示词：prompt block 同一套编辑弹窗。跑的时候渲染成串，拼在段
                  prompt 口的纯文本后面、轨级 preset 之前（端口在前、段在后、轨最后）。 */}
              {onVGenPrompt && v.ports.prompt && (
                <button
                  data-vid-vgen-prompt=""
                  title={`Segment prompt — edit this segment's own prompt in the full prompt UI (same editor as a Pipeline prompt block). When it runs: the prompt port text first, then this selection, then the track prompt.`}
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); onVGenPrompt(c.id); }}
                  style={{ ...iconBtn, background: 'rgba(0,0,0,0.3)', border: `0.5px solid ${PK.edge}`,
                    color: v.promptPresetId ? '#64d2ff' : PK.fg, cursor: 'pointer' }}
                ><IconPrompt /></button>
              )}
              {/* 运行 / 停止：一颗图标，不写文字。 */}
              <button
                data-vid-vgen-run=""
                disabled={!running && continueBlocked}
                title={running
                  ? 'Stop this segment.'
                  : continueBlocked
                    ? `The output track already has a clip over ${fmtTime(c.start)}–${fmtTime(c.start + c.duration)} — move or delete it before running this segment again.`
                    : `Run this generator with the values configured on the segment (prompt, width / height / duration / fps${v.ports.first_frame ? ', first frame' : ''}${v.ports.last_frame ? ', last frame' : ''}) — the video lands on the output track at ${fmtTime(c.start)}.${chainPrev ? ` Linked to 「${chainPrev.name}」: if that segment has no result yet, it is generated first.` : ''}`}
                onPointerDown={e => e.stopPropagation()}
                onClick={e => {
                  e.stopPropagation();
                  if (running) { onStop?.(c.id); return; }
                  if (continueBlocked) return;
                  if (onVGenRun) onVGenRun(c.id); else onContinue?.(c.id);
                }}
                style={{
                  ...iconBtn,
                  background: running ? 'rgba(255,69,58,0.92)'
                    : continueBlocked ? 'rgba(255,255,255,0.14)' : PK.accent,
                  color: running ? '#fff' : continueBlocked ? 'rgba(255,255,255,0.4)' : '#17131c',
                  cursor: !running && continueBlocked ? 'not-allowed' : 'pointer',
                }}
              >{running ? <IconStop /> : <IconPlay />}</button>
              {!tight && (
                <span title={c.name} style={{
                  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontSize: 10.5, fontWeight: 600, color: 'rgba(255,255,255,0.94)',
                  textShadow: '0 1px 2px rgba(0,0,0,0.55)', pointerEvents: 'none',
                }}>{c.name}</span>
              )}
            </div>
            {frameCard('last_frame')}
          </>
        );
      })()}
      {c.groupId && !micro && (
        <button
          title="Linked A/V pair — click to unlink; each side then moves/trims on its own (hold Alt while dragging for a one-off)"
          onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onUnlink(); }}
          style={{ flexShrink: 0, fontSize: 9, color: 'rgba(255,255,255,0.7)', background: 'rgba(0,0,0,0.3)', border: 'none', borderRadius: 4, cursor: 'pointer', padding: '2px 3px', lineHeight: 1, position: 'relative', display: 'flex', alignItems: 'center' }}
        ><IconLink /></button>
      )}
      {/* 裁剪把手：左右各一条**透明**窄带 —— 只留命中区（光标变 ew-resize、可拖边），
          不画任何底色/边线，段面上看不到额外色块。 */}
      <div onPointerDown={e => onStartDrag(e, 'l', c)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 7, cursor: blade ? BLADE_CURSOR : 'ew-resize', background: 'transparent' }} />
      <div onPointerDown={e => onStartDrag(e, 'r', c)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 7, cursor: blade ? BLADE_CURSOR : 'ew-resize', background: 'transparent' }} />
      {/* 删除按钮已移除：删除入口是选中段后按 Delete / Backspace。 */}
    </div>
  );
};
