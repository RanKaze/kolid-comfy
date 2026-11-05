import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDockDocument, useDockWindow } from '../../dock/docScope';
import type { InspectSel } from './Inspector';
import {
  type AssetIdentity, type VidController, clipUseIndex, fmtTime, isAudioName, isVideoName, addAsset, newVidId,
  usedByCount,
} from './model';
import { probeMedia } from './audio';
import { assetsTick, subscribeAssets } from './assetsTick';
import { CardScaleControl, aspectOf, cardHeightOf, justifiedRows, useAssetScale } from '../assetScale';
import { ingestFile } from './ingest';
import { useCudState } from '../cudScope';
import { hit, isRecording } from '../../keybindings';
import { useDocAssets } from '../docAssets';
import { clipCards, groupDocAssets, whereText } from './assetScope';
import { ensureFrame, ensureWaveform } from './previews';
import { instrumentAbsPath, reloadInstruments, useInstrumentLibrary, type InstrumentItem } from '../../midi/library';
import { useMidiSettings } from '../../midi/settings';
import { nativeEngine } from '../../midi/engine';
import { midiOut } from '../../midi/output';
import { editorState, subscribeEditor } from '../../midi/soundWindow';
import { addTrack as addMidiTrack } from '../../midi/model';
import { loadInstrumentOnTrack } from '../../midi/instrumentOps';
import type { MidiCtl } from '../../midi/types';
// Prompt 窗与本页不同 origin：落点由本页接（拖拽期间让开 iframe，见 assetDragBus）。
import { beginAssetDrag, endAssetDrag } from './assetDragBus';

// ── Assets 窗 ───────────────────────────────────────────────────────────────────────────────
// 三档作用域（顶部那条 segmented），三档说的是**三处不同的字节**：
//
//   Library = 公用库（`data/assets/` 里的库成员）—— 跨文档共享：Assets 节点的产出、用户主动入库
//             的图、任何一份工程"另存进库"的货。这一档是全库的脸，视频/音频/图片都在。
//   Video   = **这份文档内嵌的图**里，Video 模式那些 Layer 段用到的（每段一套 layers/guidances）。
//   Image   = **这份文档内嵌的图**里，image 模式那一套工作面用到的（layers + guidances + staging）。
//
// 后两档不是"仓库里的另一堆" —— 它们是同一份文件里的字节（A4：图像内嵌，.cud 是权威），所以只能
// 由工作台页面报过来（`blend-cud-assets` → `docAssets.ts`）。仓库里那份是载入时落下的缓存，卡片
// 走 `/api/asset_media/<hash>` 画；缓存缺了就是 MISSING，字节还在文件里。
//
// 拖出去：卡片带 `application/x-asset` = `{id, url, name, kind, asset}`；本工程资产另带老的
// `application/x-vid-asset`（时间线按 asset id 认）；旧的 `application/x-vid-global` 也一起发一份，
// 免得还有哪个落点只认它（A2 之后可以只留 x-asset）。

const STAGING_ITEM_TYPE = 'application/x-blend-staging';
/** 统一载荷：仓库资产拖到任何落点都带这一份。 */
export const ASSET_ITEM_TYPE = 'application/x-asset';
/** 老载荷：全局资产落到轨道上时带 URL + 名字（时间线拿它 importSource）。仍然发，兼容老落点。 */
export const GLOBAL_ITEM_TYPE = 'application/x-vid-global';
/** 工程资产的老载荷：只带资产 id（时间线据此直接落片段，不再走一次 importSource）。 */
export const VID_ASSET_TYPE = 'application/x-vid-asset';

/** 四档：公用库 / 这份文档的 Layer 段 / 这份文档的 image 工作面 / 乐器库。
 *  前三是"字节在哪"，第四档不是字节 —— 它跟这份文档无关，内容只由 MIDI 设置里那条库路径决定。 */
export type Scope = 'library' | 'video' | 'image' | 'instruments';

/** 仓库里的一件货（/api/global_assets 的响应项；A0 加了 hash / inLibrary / thumb 三个字段）。
 *  老服务没有这三个字段 —— 读的时候按"是库成员、没有 hash"兜底，窗不会白屏。 */
export type StoreAsset = {
  /** 盘上的文件名（新货是 md5 名，老货沿用 assets_node 写下的名字）。 */
  name: string;
  /** 可播 URL：/api/global_media/<文件名>。 */
  url: string;
  kind: 'image' | 'video' | 'audio';
  size: number;
  mtime: number;
  /** 有没有音轨（ffprobe 探的）。`null` = 探不到 —— 不画 AUD 角标，不猜。 */
  hasAudio: boolean | null;
  /** 时长（s）。悬停扫片按"指针位置 → 时刻"取格要它；图片恒 0。 */
  duration: number;
  /** A0：内容 id = 文件名 stem。改名/删除/引用都按它。 */
  hash?: string;
  /** A0：是不是库成员（不在库里的 = session 临时产物）。 */
  inLibrary?: boolean;
  /** A5：可播字节的哈希（转码代理）。有它就用它播 —— 原件的容器浏览器可能咬不动。 */
  playHash?: string | null;
  /** A0：表里的显示名（可改）。老服务没有这一项 ⇒ 退回文件名。 */
  displayName?: string;
  /** A0：来源（legacy / upload / run / staging …）。 */
  origin?: string;
  /** A0：标签。 */
  tags?: string[];
  /** A0：缩略图 URL（图片才有，后端按需生成并落盘缓存）。 */
  thumb?: string | null;
  /** 原生像素（图片 PIL / 视频 ffprobe）。流式卡片按它算宽度。 */
  w?: number;
  h?: number;
};

/** A5：仓库条目怎么播 —— 转码过的原件浏览器咬不动，`playHash` 才是能播的那份字节。 */
const playUrlOf = (s: StoreAsset): string =>
  s.playHash ? '/api/asset_media/' + encodeURIComponent(s.playHash) : s.url;

const rowBtn: React.CSSProperties = {
  flexShrink: 0, width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'none', border: 'none', borderRadius: 4, color: 'rgba(255,255,255,0.35)', cursor: 'pointer', padding: 0,
};

// ── 全局资产（旧类型名，保留导出免得老代码引用断掉）─────────────────────────────────────────
export type GlobalAsset = StoreAsset;

/** 地球：Library 那一档的记号 —— 一圈经线 + 一条赤道，选中时点亮。 */
const GlobeIcon: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12" />
    <path d="M8 2c1.8 1.9 2.7 3.8 2.7 6S9.8 12.1 8 14C6.2 12.1 5.3 10.2 5.3 8S6.2 3.9 8 2z" />
  </svg>
);

// 图片的扩展名判据（导入那条路要认"这文件是不是一张图"）。
const IMG_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)(?:[?#]|$)/i;

/** 卡片缩略图：视频 = 首帧（客户端抓一张）；图片 = 它自己（仓库图用后端生成的 thumb）；
 *  音频 = 整段波形（有就画，没有留音符图标）。`given` 有值就不再算 —— 省一趟解码。 */
function useCardThumb(kind: 'video' | 'audio' | 'image', src: string, given?: string | null): string | null {
  const [url, setUrl] = useState<string | null>(given ?? null);
  useEffect(() => {
    let alive = true;
    if (given) { setUrl(given); return () => { alive = false; }; }
    setUrl(null);
    if (!src) return () => { alive = false; };
    if (kind === 'image') { setUrl(src); return () => { alive = false; }; }
    if (kind === 'audio') {
      void ensureWaveform(src).then(u => { if (alive && u) setUrl(u); });
      return () => { alive = false; };
    }
    void ensureFrame(src, 0).then(u => { if (alive && u) setUrl(u); });
    return () => { alive = false; };
  }, [kind, src, given]);
  return url;
}

// ── 卡片的那一块"长相" ──────────────────────────────────────────────────────────────────────
// 工程资产与全局资产来源不同、长相是同一套，所以缩略图这一块（含悬停扫片与角标）只写一次。
type CardMedia = {
  src: string;
  kind: 'video' | 'audio' | 'image';
  duration: number;
  /** 有没有音轨。`null` = 不知道（探不到 / 图片）→ 不画 AUD 角标。 */
  hasAudio: boolean | null;
};

/** 悬停扫片：视频卡片上**不点、只左右滑** —— 指针在这块上的横向位置 = 片中时刻，卡片当场
 *  换成那一帧。做法是**给这张卡挂一个自己的 <video>，指针指哪它 seek 到哪**：
 *  * 不走抽条（previews 那条 strip）。抽条是给时间线拖动攒的（一次几十上百格，复用才划算），
 *    而它在 `frameBackend()` 为 false（后端没 ffmpeg / 探不到）时全是客户端现抓 —— 一格一次
 *    fastSeek + canvas 编码，还要排进全局那条串行队，第一格都要几秒。悬停等不起，看起来就是
 *    "一直停在首帧"。
 *  * 一次只会有一张卡挂着 <video>（一次只悬停一张），移出去立刻卸载 —— 解码器当场还回去。
 *  * seek 按 rAF 节流：指针一帧最多排一次，绝不给解码器堆一队。
 *  还留一道闸：进来先停 `SCRUB_DWELL` 才挂 —— 鼠标横扫一排卡片时不该每张都去开一次解码。 */
const SCRUB_DWELL = 120;
function useHoverScrub(m: CardMedia) {
  const enabled = m.kind === 'video';
  const [armed, setArmed] = useState(false);      // 过了 dwell：<video> 挂上了
  const [live, setLive] = useState(false);        // 画面真出来了（loadeddata）才盖住海报帧
  const [pos, setPos] = useState<number | null>(null);   // 底沿那道进度线（null = 没在扫）
  const vref = useRef<HTMLVideoElement | null>(null);
  const ratio = useRef(0);
  const want = useRef(-1);
  const raf = useRef(0);
  const dwell = useRef<number | undefined>(undefined);

  const tick = useCallback(() => {
    raf.current = 0;
    const v = vref.current;
    if (!v || want.current < 0) return;
    // 片长以**这个元素自己读到的**为准（存的 duration 可能是 0 / 不准）。
    const total = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : m.duration;
    if (total <= 0) return;
    const t = Math.max(0, Math.min(want.current * total, total - 0.05));
    try {
      // fastSeek = 只落最近的关键帧：缩略级精度够用，且省掉"从关键帧前向解码整个 GOP"。
      const ff = (v as HTMLVideoElement & { fastSeek?: (t: number) => void }).fastSeek;
      if (typeof ff === 'function') ff.call(v, t);
      else v.currentTime = t;
    } catch { /* 这次没 seek 成（还没缓到那一段）：下一次 move 自然再来 */ }
  }, [m.duration]);

  const schedule = useCallback((r: number) => {
    want.current = r;
    if (!raf.current) raf.current = requestAnimationFrame(tick);
  }, [tick]);

  useEffect(() => () => {
    if (dwell.current) window.clearTimeout(dwell.current);
    if (raf.current) cancelAnimationFrame(raf.current);
  }, []);

  const onEnter = () => {
    if (!enabled) return;
    if (dwell.current) window.clearTimeout(dwell.current);
    dwell.current = window.setTimeout(() => setArmed(true), SCRUB_DWELL);
  };
  const onMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!enabled) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0) return;
    ratio.current = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    if (armed) { setPos(ratio.current); schedule(ratio.current); }
  };
  const onLeave = () => {
    if (dwell.current) { window.clearTimeout(dwell.current); dwell.current = undefined; }
    if (raf.current) { cancelAnimationFrame(raf.current); raf.current = 0; }
    want.current = -1;
    ratio.current = 0;
    setArmed(false);
    setLive(false);
    setPos(null);
  };
  const onReady = useCallback(() => { setLive(true); schedule(ratio.current); }, [schedule]);
  return { armed, live, pos: armed ? pos : null, vref, onEnter, onMove, onLeave, onReady };
}

const badge: React.CSSProperties = {
  fontSize: 7.5, fontWeight: 800, letterSpacing: 0.4, lineHeight: 1.15,
  background: 'rgba(0,0,0,0.6)', borderRadius: 3, padding: '1px 3px',
};

/** 缩略图那一块：海报帧（或悬停扫到的那一格）+ 角标 + 扫片进度线。
 *  `height` 有值 = 统一高度的流式卡片（宽度由调用方按宽高比算好）；不给就沿用 16:9 的格子。 */
const Thumb: React.FC<{ m: CardMedia; poster: string | null; height?: number }> = ({ m, poster, height }) => {
  const scrub = useHoverScrub(m);
  const color = m.kind === 'audio' ? '#30d158' : m.kind === 'image' ? '#ffd60a' : '#64d2ff';
  const glyph = m.kind === 'audio' ? '♪' : m.kind === 'image' ? '▧' : '▣';
  const tag = m.kind === 'audio' ? 'AUD' : m.kind === 'image' ? 'IMG' : 'VID';
  return (
    <div
      data-vid-thumb=""
      onPointerEnter={scrub.onEnter}
      onPointerMove={scrub.onMove}
      onPointerLeave={scrub.onLeave}
      style={{
        position: 'relative', width: '100%', flexShrink: 0,
        height: height ?? undefined, aspectRatio: height ? undefined : '16 / 9', background: '#08080a',
        display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
        borderRadius: '5.5px 5.5px 0 0',
        cursor: m.kind === 'video' ? 'ew-resize' : undefined,
      }}
    >
      <span style={{ fontSize: 16, color: 'rgba(255,255,255,0.22)', pointerEvents: 'none' }}>{glyph}</span>
      {poster && (
        // key：换一次 src 就换一个元素 —— 否则某一张图 404 触发的 `display:none` 会**永久**
        // 留在同一个 <img> 上，后面换任何 src 都是空白。
        <img key={poster} src={poster} draggable={false} decoding="async" loading="lazy"
          onError={e => { e.currentTarget.style.display = 'none'; }}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }} />
      )}
      {/* 扫片的那一路画面：挂上就加载，能出画面了（onLoadedData）才淡入盖住海报帧。 */}
      {scrub.armed && (
        <video
          ref={scrub.vref}
          src={m.src}
          muted
          playsInline
          preload="auto"
          onLoadedData={scrub.onReady}
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
            display: 'block', pointerEvents: 'none', opacity: scrub.live ? 1 : 0,
          }}
        />
      )}
      {/* 角标：VID 旁边那颗 AUD = 这件视频**带音轨**（拖上轨道会当场拆一条联动音频段）。
          `hasAudio` 是 null（不知道）就不画 —— 不画比画错强。 */}
      <span style={{ position: 'absolute', top: 3, left: 3, display: 'flex', gap: 2, pointerEvents: 'none' }}>
        <span style={{ ...badge, color }}>{tag}</span>
        {m.kind === 'video' && m.hasAudio && <span style={{ ...badge, color: '#30d158' }}>AUD</span>}
      </span>
      {scrub.pos !== null && (
        <span style={{
          position: 'absolute', left: 0, bottom: 0, height: 2, pointerEvents: 'none',
          width: `${scrub.pos * 100}%`, background: '#3b9dff',
        }} />
      )}
    </div>
  );
};

// ── 卡片 ────────────────────────────────────────────────────────────────────────────────────
// 工程资产与仓库资产在窗里长同一个样：缩略图（可悬停扫片）+ 名字 + 一行元信息 + 动作。
// 差别全由数据说：字节来源（LOCAL / IN DOC / MISSING）画在缩略图右上，来源与"谁在用"
// 写在名字下面那行。老的 AssetCard / GlobalCard 就是因为这一个差别写了两遍，现在没有第二套。

export type CardItem = {
  name: string;
  kind: 'video' | 'audio' | 'image';
  src: string;
  duration: number;
  hasAudio: boolean | null;
  /** 缩略图直给（仓库图有后端生成的那张）；不给就按 kind 现算。 */
  poster?: string | null;
  /** 原生像素。流式卡片用它算宽度（高度一致、宽度 = 高度 × 宽高比）；缺了就退回 16:9。 */
  w?: number;
  h?: number;
  /** 字节在哪：`store` 只在仓库；`doc` 某份文档里也内嵌了一份（A4 之后才可能出现）；
   *  `ref` 文档只是**引用**它（.cud 里记哈希与 URL，字节留在仓库 —— 视频/音频走这一档）；
   *  `missing` 引用还在、字节没了。 */
  byteFrom?: 'store' | 'doc' | 'ref' | 'missing' | 'eagle';
  /** 来源徽章：upload / legacy / run / staging … */
  origin?: string;
  /** 谁在用它（"3 clips"）。 */
  usedBy?: string;
  /** 拖拽载荷（mime → 字符串）。不给 = 不可拖。 */
  drag?: Record<string, string>;
  /** 名字右边那颗动作按钮。 */
  actions?: React.ReactNode;
  /** 双击名字 = 原地改名（不给 = 名字不可改）。改名输入框的提交/放弃走下面三个字段。 */
  onNameDoubleClick?: () => void;
  renaming?: boolean;
  onRenameCommit?: (next: string) => void;
  onRenameCancel?: () => void;
};

const BYTE_BADGE = {
  store: { text: 'LOCAL', color: '#8e8e93', title: 'Bytes live in the asset store (data/assets)' },
  doc: { text: 'IN DOC', color: '#30d158', title: 'Bytes are also embedded in an open document' },
  ref: { text: 'REF', color: '#5ac8fa', title: 'Referenced, not embedded — the .cud stores the hash and URL; bytes stay in the asset store' },
  missing: { text: 'MISSING', color: '#ff453a', title: 'Referenced, but the bytes are gone' },
  eagle: { text: 'EAGLE', color: '#ff9f0a', title: 'Bytes stay in your Eagle library and are served in place — nothing is copied into data/assets' },
} as const;

const Chip: React.FC<{ color: string; title: string; children?: React.ReactNode }> = ({ color, title, children }) => (
  <span title={title} style={{
    fontSize: 7.5, fontWeight: 800, letterSpacing: 0.4, lineHeight: 1.15, color,
    background: 'rgba(0,0,0,0.62)', borderRadius: 3, padding: '1px 3px', whiteSpace: 'nowrap',
  }}>{children}</span>
);

const PlusIcon = () => (
  <svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
    <path d="M6 2.5v7M2.5 6h7" />
  </svg>
);
/** 回形针：把本地文件重新接到这个哈希上（relink）。 */
const ClipIcon = () => (
  <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <path d="M9.5 5.2L5.6 9.1a2.1 2.1 0 01-3-3l4.3-4.3a1.5 1.5 0 012.1 2.1L4.7 8.2a0.8 0.8 0 01-1.1-1.1l3.9-3.9" />
  </svg>
);
// 试听 / 停止：和 Timeline 里生成器段的运行键同一套（三角形 / 方块自己说话）。
// 不用字符 ♪ / ■ —— 字符随系统字体变形，10px 上下还会糊成一小团，看着像"按不动"。
const AuditionIcon = () => (
  <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" stroke="none">
    <path d="M5.3 3.3 12.3 8l-7 4.7z" />
  </svg>
);
const AuditionStopIcon = () => (
  <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" stroke="none">
    <rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.1" />
  </svg>
);

/** 原地改名输入框:Enter/失焦落(空值或没改 = 放弃),Esc 弃。`done` 守卫挡住
 *  "Enter 提交后组件卸载引发的那次 blur"造成的双发。 */
const RenameInput: React.FC<{ initial: string; commit: (next: string) => void; cancel: () => void }> = ({ initial, commit, cancel }) => {
  const done = useRef(false);
  const finish = (v: string) => {
    if (done.current) return;
    done.current = true;
    const next = v.trim();
    if (next && next !== initial) commit(next); else cancel();
  };
  return (
    <input
      autoFocus
      defaultValue={initial}
      spellCheck={false}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation();          // 别让 Del/Esc 冒泡到网格的快捷键那层
        if (e.key === 'Enter') finish(e.currentTarget.value);
        else if (e.key === 'Escape') { done.current = true; cancel(); }
      }}
      onBlur={e => finish(e.currentTarget.value)}
      onFocus={e => e.currentTarget.select()}
      style={{
        flex: 1, minWidth: 0, height: 14, fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.92)',
        background: '#1b1b1e', border: '0.5px solid rgba(10,132,255,0.55)', borderRadius: 3,
        padding: '0 3px', outline: 'none',
      }}
    />
  );
};

/** 资产卡片的唯一长相（Assets 窗在用；绑帧弹窗等挑选场景也复用它 —— 选中态用 selected，
 *  整卡可点用 onClick（收一个鼠标事件,多选要读 Ctrl/Shift）,双击用 onDoubleClick,
 *  都不给就是窗里那张默认卡）。 */
export const Card: React.FC<{
  it: CardItem;
  selected?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  /** 右键：引用件用它开"链接资产"菜单（别的卡不给 —— 它们没有可换的引用）。 */
  onContextMenu?: (e: React.MouseEvent) => void;
  /** 流式卡片：缩略图高度一致，整卡宽 = 高度 × 宽高比。不给 = 填满格子（绑帧弹窗那套）。 */
  cardH?: number;
  /** 行内精确宽度（justified 布局按行算好的）。不给则按 cardH × 宽高比推。 */
  cardW?: number;
}> = ({ it, selected, onClick, onDoubleClick, onContextMenu, cardH, cardW }) => {
  const poster = useCardThumb(it.kind, it.src, it.poster);
  const [over, setOver] = useState(false);
  const badge = it.byteFrom ? BYTE_BADGE[it.byteFrom] : null;
  const flow = typeof cardH === 'number' && cardH > 0;
  const ratio = it.w && it.h && it.w > 0 && it.h > 0
    ? it.w / it.h
    : it.kind === 'audio' ? 1.6 : 16 / 9;
  const thumbH = flow ? Math.max(24, Math.round(cardH as number)) : undefined;
  const width = flow
    ? (cardW && cardW > 0
      ? Math.round(cardW)
      : Math.max(40, Math.min(520, Math.round((thumbH as number) * ratio))))
    : undefined;
  const dims = it.w && it.h ? `${it.w} × ${it.h}` : '';
  const meta: { text: string; color?: string }[] = [];
  if (dims) meta.push({ text: dims });
  if (it.kind !== 'image' && it.duration > 0) meta.push({ text: fmtTime(it.duration) });
  if (it.usedBy) meta.push({ text: it.usedBy, color: 'rgba(120,200,255,0.72)' });
  const tip = [it.name, dims, it.origin, it.usedBy].filter(Boolean).join(' · ');
  return (
    <div
      draggable={!!it.drag}
      onClick={e => onClick?.(e)}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onDragStart={e => {
        if (!it.drag) return;
        for (const k of Object.keys(it.drag)) {
          try { e.dataTransfer.setData(k, it.drag[k]); } catch { /* 类型受限：别的类型还发得出去 */ }
        }
        e.dataTransfer.effectAllowed = 'copy';
        const assetRaw = it.drag[ASSET_ITEM_TYPE];
        if (assetRaw) {
          try {
            const a = JSON.parse(assetRaw) as { url?: string; name?: string; kind?: string };
            if (a && typeof a.url === 'string') beginAssetDrag({ url: a.url, name: a.name, kind: a.kind });
          } catch { /* 不是资产载荷 */ }
        }
      }}
      onDragEnd={endAssetDrag}
      onPointerEnter={() => setOver(true)}
      onPointerLeave={() => setOver(false)}
      title={tip}
      style={{
        display: 'flex', flexDirection: 'column', minWidth: 0, borderRadius: 6, overflow: 'hidden',
        width, maxWidth: '100%', flexShrink: flow ? 0 : undefined,
        // 默认不画边框：图片要贴满卡片（Eagle 的网格就是靠行间距分隔，不靠线框）。
        border: selected ? '1px solid #0a84ff'
          : '0.5px solid ' + (it.byteFrom === 'missing'
            ? 'rgba(255,69,58,0.45)'
            : over ? 'rgba(255,255,255,0.22)' : 'transparent'),
        background: '#0f0f11', cursor: onClick ? 'pointer' : it.drag ? 'grab' : 'default', userSelect: 'none',
      }}
    >
      <div style={{ position: 'relative' }}>
        <Thumb
          m={{ src: it.src, kind: it.kind, duration: it.duration, hasAudio: it.hasAudio }}
          poster={poster}
          height={thumbH}
        />
        {badge && (
          <span style={{ position: 'absolute', top: 3, right: 3, display: 'flex', pointerEvents: 'none' }}>
            <Chip color={badge.color} title={badge.title}>{badge.text}</Chip>
          </span>
        )}
      </div>
      {flow ? (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 3, padding: '4px 6px 0', height: 26, minWidth: 0 }}>
            {it.renaming && it.onRenameCommit ? (
              <RenameInput initial={it.name} commit={it.onRenameCommit} cancel={() => it.onRenameCancel?.()} />
            ) : (
              <span
                onDoubleClick={e => {
                  // 只有"双击改名"的卡才截住这一下；别的卡让双击冒到整张卡上（Inspector）。
                  if (it.onNameDoubleClick) { e.stopPropagation(); it.onNameDoubleClick(); }
                }}
                style={{
                  fontSize: 10, fontWeight: 600, lineHeight: '13px', color: 'rgba(255,255,255,0.82)',
                  flex: 1, minWidth: 0, overflow: 'hidden', wordBreak: 'break-word',
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  cursor: it.onNameDoubleClick ? 'text' : undefined,
                }}
              >{it.name}</span>
            )}
            {it.actions && <span style={{ flexShrink: 0, display: 'flex' }}>{it.actions}</span>}
          </div>
          <div style={{
            height: 15, padding: '1px 6px 5px', display: 'flex', alignItems: 'center', gap: 4,
            minWidth: 0, fontSize: 8.5, color: 'rgba(255,255,255,0.3)',
            whiteSpace: 'nowrap', overflow: 'hidden',
          }}>
            {meta.map((m, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span style={{ opacity: 0.5, flexShrink: 0 }}>·</span>}
                <span style={{
                  overflow: 'hidden', textOverflow: 'ellipsis',
                  flexShrink: i === meta.length - 1 ? 1 : 0, color: m.color,
                }}>{m.text}</span>
              </React.Fragment>
            ))}
          </div>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px 0', minWidth: 0 }}>
            {it.renaming && it.onRenameCommit ? (
              <RenameInput initial={it.name} commit={it.onRenameCommit} cancel={() => it.onRenameCancel?.()} />
            ) : (
              <span
                onDoubleClick={e => {
                  if (it.onNameDoubleClick) { e.stopPropagation(); it.onNameDoubleClick(); }
                }}
                style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.82)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: it.onNameDoubleClick ? 'text' : undefined }}
              >{it.name}</span>
            )}
            {it.kind !== 'image' && it.duration > 0 && (
              <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.42)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{fmtTime(it.duration)}</span>
            )}
            {it.actions}
          </div>
          <div style={{ padding: '0 6px 5px', display: 'flex', gap: 4, minWidth: 0, fontSize: 8.5, color: 'rgba(255,255,255,0.3)', whiteSpace: 'nowrap', overflow: 'hidden' }}>
            {it.origin && <span style={{ flexShrink: 0 }}>{it.origin}</span>}
            {it.origin && it.usedBy && <span style={{ opacity: 0.5 }}>·</span>}
            {it.usedBy && <span style={{ color: 'rgba(120,200,255,0.72)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.usedBy}</span>}
          </div>
        </>
      )}
    </div>
  );
};

const fileToDataURL = (f: File) => new Promise<string | null>(res => {
  const r = new FileReader();
  r.onload = () => res(typeof r.result === 'string' ? r.result : null);
  r.onerror = () => res(null);
  r.readAsDataURL(f);
});

const SCOPES: { id: Scope; label: string; title: string }[] = [
  { id: 'library', label: 'Library', title: 'Shared library — bytes in data/assets, visible to every document' },
  { id: 'video', label: 'Video', title: "This document's own assets, as used by video mode: media referenced by the timeline (hash only) + images on Layer segments (embedded)" },
  { id: 'image', label: 'Image', title: "This document's own images, as used by layers / guidances / staging (embedded in the .cud)" },
  // 第四档不属于文档：它照 Settings → MIDI 里那条 Instruments Library 路径现扫，与打开的是哪份
  // 文档、哪个模式都无关。放在最后，别把前三条"字节在哪"的顺序搅了。
  { id: 'instruments', label: 'Instruments', title: 'Instruments found under the Instruments Library folder (Settings → MIDI)' },
];

/** 内嵌图的可播地址：载入时这些字节已经落回仓库（storeCudImages），所以一张 <img> 就能画。
 *  仓库副本没了（用户手删）就会 404 —— 卡片上标 MISSING，字节其实还在文件里。 */
const docUrlOf = (hash: string): string => '/api/asset_media/' + encodeURIComponent(hash);

const selStyle: React.CSSProperties = {
  height: 18, fontSize: 9.5, color: 'rgba(255,255,255,0.6)', background: '#1b1b1e',
  border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 4, padding: '0 2px',
  outline: 'none', cursor: 'pointer', minWidth: 0,
};

// ── Instruments 档的列表 ────────────────────────────────────────────────────────────────────
// 跟其它三档不是一回事：那边列的是**字节**（能拖、能预览、能删），这边列的是"哪儿有一件乐器"——
// 拖不出图，也删不掉。所以它不铺卡片网格，是一张列表：名字（能不能出声看颜色）+ 型号/来源 + 徽标。
//
// 只画前 300 行：catalog 那种库动辄两三千条，全铺进 DOM 会把这个窄窗拖慢；剩下的靠搜索收窄，
// 计数里如实说还有多少没画，不装作列全了。
const INSTRUMENT_ROW_LIMIT = 300;

/** 路径的最后一段（底栏只放得下这个，完整路径进 title）。 */
const folderName = (p: string): string => {
  if (!p) return '';
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
};

const instrNote: React.CSSProperties = {
  padding: '14px 12px', fontSize: 11, lineHeight: 1.75, color: 'rgba(255,255,255,0.38)',
  textAlign: 'center', whiteSpace: 'pre-line',
};

/** 谁去加载这件乐器。sfz = 引擎自己读，vst3-preset / surge-fxp = 只登记了位置。 */
const backendBadge = (it: InstrumentItem): string =>
  it.backend === 'vst3-preset' || it.backend === 'vst3-plugin' ? 'VST3'
    : it.backend === 'surge-fxp' ? 'FXP'
      : it.backend === 'sfz' ? 'SFZ'
        : it.backend === 'kontakt' ? 'NKI'
          : it.backend === 'vstsound' ? 'VST'
            : (it.backend || '?');

// 播不动的时候要说清"卡在哪一步"，否则一律 "not wired up" 等于什么也没说。
// Kontakt / HALion 的库是封闭容器 —— 那些行本身播不动，但**那件乐器的插件播得动**：
// 双击上面对应的插件行（Installed plug-in），装上后用它自己的音色窗挑一次，关窗就自动入库。
const whyNotPlayable = (it: InstrumentItem): string =>
  it.backend === 'kontakt'
    ? "Kontakt instrument — its samples live in NI's closed .ncw format, so this row cannot be loaded as-is. To get this sound: double-click the Kontakt 7 row under Installed plug-in, pick it in the window that opens (or press Edit on the track later), then close that window — the sound is saved into the library."
    : it.backend === 'vstsound'
      ? "HALion library — the sounds live inside Steinberg's .vstsound container. Load the HALion 7 plug-in row instead; its window opens so you can pick this library's sound (the track's Edit button reopens it later)."
      : 'Listed, but this engine cannot play it yet — the player for this format is not wired up';

const InstrumentList: React.FC<{ q: string; midi: MidiCtl }> = ({ q, midi }) => {
  const { lib, loading, error } = useInstrumentLibrary();
  const settings = useMidiSettings();
  // 双击一行 = 给它加一条轨（轨名就是乐器名），**这条轨**装这件乐器 —— 2b 之后每条轨各有
  // 一支实例，同一件装在两条轨上也是两份，互不顶掉。
  // `busy` 是正在装的那个 —— 装一次可能要读十几兆 wav，没有"正在载入"的话界面会像卡住了。
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [noteTone, setNoteTone] = useState<'info' | 'error' | 'quiet'>('info');
  const say = (text: string, tone: 'info' | 'error' | 'quiet' = 'info') => { setNote(text); setNoteTone(tone); };
  // 音色窗的回话（开不出来 / 存好了）也落到这条底栏 —— 用户在 Assets 里双击起的窗，
  // 结果不该只有 MIDI 模式才看得见。按提示对象认"新的一条"。
  const edNote = useRef<object | null>(null);
  useEffect(() => subscribeEditor(() => {
    const n = editorState().note;
    if (!n || n === edNote.current) return;
    edNote.current = n;
    say(n.text, n.tone);
  }), []);
  // 正在响的那件（三个音走完之前别让人连点 —— 连点会叠成一片）。
  const [playing, setPlaying] = useState('');
  // "哪几件已经装着"来自引擎的实况（工程里每条轨的那件 + 试听槽那件），不是本地记忆。
  const [, setEngineVer] = useState(0);
  useEffect(() => nativeEngine.subscribe(() => setEngineVer(v => v + 1)), []);
  // 第一次打开这一档：拉一次。settings 还没回来时拿到的 root 是空，等它到了
  // （路径/深度一变）midi/library.ts 自己会再扫一遍 —— 这里不用等它。
  useEffect(() => { void reloadInstruments(); }, []);
  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => {
    const all = (lib?.items || []).filter(it =>
      !needle
      || it.name.toLowerCase().includes(needle)
      || it.model.toLowerCase().includes(needle)
      || it.source.toLowerCase().includes(needle)
      || it.where.toLowerCase().includes(needle));
    // 能出声的排前面 —— 这一档的用处就是"挑一件现在能用的"。
    return all.slice().sort((a, b) =>
      a.playable === b.playable ? a.name.localeCompare(b.name) : (a.playable ? -1 : 1));
  }, [lib, needle]);

  if (loading && !lib) return <div style={instrNote}>{'Scanning ' + (settings.instrumentsLibrary || 'the library') + '…'}</div>;
  if (error) return <div style={{ ...instrNote, color: '#ff8a80' }}>{error}</div>;
  if (!lib || (!lib.state.set && !lib.presetsState.set && !(lib.items || []).length)) {
    return <div style={instrNote}>{'No instrument library yet.\nPick the folder in Settings → MIDI (Instruments Library, and Presets Folder for Kontakt/HALion exports).'}</div>;
  }
  if (!lib.ok) return <div style={{ ...instrNote, color: '#ff8a80' }}>{lib.state.reason || lib.error || 'library unreadable'}</div>;
  if (!rows.length) {
    return <div style={instrNote}>{needle
      ? 'Nothing matches "' + q.trim() + '".'
      : 'No instruments found in this folder.\nIf they are nested deeper, raise Scan depth in Settings → MIDI.'}</div>;
  }

  // 每条自带 root：乐器和预设住在两棵根里（预设根见 Settings → MIDI）。绝对路径的 where
  // （catalog 那种）直接用它自己。老后端没有 root 字段时回落到乐器库那条。
  // 拼法住在 library.ts —— agent 的 instrument_library 报的必须是同一个绝对路径，否则
  // "列表里的这一条"与"装到轨上的那一条"对不上。
  const absPath = (it: InstrumentItem) => instrumentAbsPath(it, settings.instrumentsLibrary);
  // 已经出声的那几件：工程里各轨的实例（open）+ 试听槽那件。路径比较不分大小写。
  const loadedPaths = new Set<string>([
    ...(nativeEngine.getStatus().instruments || []).filter(r => r.open).map(r => r.path),
    ...(nativeEngine.currentInstrument()?.path ? [nativeEngine.currentInstrument()!.path] : []),
  ].map(p => p.replace(/\\/g, '/').toLowerCase()));
  const isLoaded = (it: InstrumentItem) => loadedPaths.has(absPath(it).replace(/\\/g, '/').toLowerCase());

  /** 双击一行：在这份文档的 MIDI 工程里加一条轨，轨名＝乐器名，**这件乐器装给这条新轨**。
   *  播不动的也照样加轨：轨道是编排，不是播放能力；底栏照 ▶ 那套说清卡在哪一步。 */
  const addTrackFor = async (it: InstrumentItem) => {
    if (busy) return;
    if (!it.playable) {
      midi.update(p => addMidiTrack(p, it.name), `Add ${it.name}`);
      say(`Added track ${it.name} — ${whyNotPlayable(it)}`, 'quiet');
      return;
    }
    const target = absPath(it);
    setBusy(target);
    // 加轨、写路径、推整表、装乐器、插件本体替用户弹窗 —— 全在 instrumentOps 那一条里
    // （agent 的 set_track_instrument 走的是同一个函数）。
    const inst = await loadInstrumentOnTrack(midi, { path: target, name: it.name });
    setBusy('');
    if (!inst.ok) {
      // 不弹窗：这一档的底栏就是报错的地方，和"读不到库"同一个位置。轨已经加上了，别吞掉这句。
      say(`Added track ${it.name} — could not load the instrument: ${inst.error}`, 'error');
      return;
    }
    // 大小按 KB 报（后端 `kb`）—— 小乐器用 MB 会被截成 0，读起来像没装上。
    const size = inst.kb >= 1024 ? (inst.kb / 1024).toFixed(1) + ' MB' : inst.kb + ' KB';
    const what = inst.kind === 'vst3'
      ? (/\.vst3$/i.test(target)
        ? 'loaded the plug-in — pick a sound in its window'
        : 'loaded the plug-in preset')
      : `loaded ${inst.zones} zone${inst.zones === 1 ? '' : 's'}`;
    say(`Added track ${it.name} · ${what}`
      + (inst.kb ? ` · ${size}` : '')
      + (inst.failed ? ` · ${inst.failed} sample${inst.failed === 1 ? '' : 's'} skipped` : ''));
  };

  /** 试听一件乐器：没装就先装（用当前音色听一件没装的乐器 = 骗人），然后弹三个音。
   *  弹三个而不是一个 —— 一个音听不出音域分层，也听不出高低力度是不是两套采样。
   *  **不要求正在播放**：试听不属于传输，引擎那头暂停时照样渲染。
   *
   *  **播不动的行也要给一句回话**。以前这里把按钮 `disabled` 掉：鼠标事件根本到不了它，
   *  点下去什么都没有 —— 看着就是"按钮坏了"。现在照点，点完在列表顶上把**卡在哪一步**说清楚。 */
  const audition = async (it: InstrumentItem) => {
    if (busy || playing) return;
    if (!it.playable) { say(`${it.name} — ${whyNotPlayable(it)}`, 'quiet'); return; }
    const target = absPath(it);
    setPlaying(target);
    setNote('');
    // 试听走**试听槽**（不进任何轨）：装在可能已经装着的那件上就不重装，只弹三个音。
    // 本机引擎不在时回落到外部 MIDI 端口 —— 别让用户对着一颗没反应的键猜。
    if (!nativeEngine.available) {
      if (!midiOut.canAudition()) {
        say('Nothing can play it — no native engine and no MIDI out port.', 'quiet');
        setPlaying('');
        return;
      }
      const tones = [48, 60, 72];
      tones.forEach((p, i) => {
        window.setTimeout(() => midiOut.audition(0, p, i === 1 ? 108 : 84), i * 240);
      });
      window.setTimeout(() => setPlaying(''), tones.length * 240 + 400);
      return;
    }
    setBusy(target);
    const inst = await nativeEngine.preview(target, -1, 100);
    setBusy('');
    if (inst.error) {
      say(`Could not load ${it.name} — ${inst.error}`, 'error');
      setPlaying('');
      return;
    }
    const tones = [48, 60, 72];
    tones.forEach((p, i) => {
      window.setTimeout(() => { void nativeEngine.preview(target, p, i === 1 ? 108 : 84); }, i * 240);
    });
    window.setTimeout(() => setPlaying(''), tones.length * 240 + 400);
  };

  const shown = rows.slice(0, INSTRUMENT_ROW_LIMIT);
  // 一件都播不动时，先解释一句再列 —— 否则满屏灰字读作"绑定坏了"。来源取实际的，不写死
  // Kontakt/HALion：换一颗库（比如全是 VST3）这句话自己就跟着变。
  const playableCount = rows.filter(r => r.playable).length;
  const sources = Array.from(new Set(rows.map(r => r.source).filter(Boolean)));
  return (
    <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 1 }}>
      {note && (
        <div style={{
          ...instrNote, padding: '4px 6px 6px', textAlign: 'left', whiteSpace: 'normal',
          // 钉在列表顶上：点的是第 120 行时，回话也得看得见（滚下去的那条就白说了）。
          position: 'sticky', top: 0, zIndex: 1, background: '#141416',
          color: noteTone === 'error' ? '#ff8a80'
            : noteTone === 'quiet' ? 'rgba(255,255,255,0.62)' : 'rgba(59,157,255,0.92)',
        }}>{note}</div>
      )}
      {playableCount === 0 && (
        <div style={{ ...instrNote, padding: '4px 4px 8px', textAlign: 'left', lineHeight: 1.5 }}
          title={'This engine reads SFZ, VST3 plug-ins and VST3 presets. Everything else is listed so the folder is not a blank box.'}>
          {`Nothing here can be played yet — this engine reads SFZ, VST3 plug-ins and .vstpreset. ${sources.join(' / ') || 'These'} ${rows.length === 1 ? 'is' : 'are'} listed so you can see what is in the folder. Double-click a row to add a track for it; click ▶ for the reason it cannot play.`}
        </div>
      )}
      {shown.map(it => (
        <div
          key={it.backend + ':' + it.id}
          onDoubleClick={() => void addTrackFor(it)}
          title={(it.where ? it.where + (it.source ? '\n' + it.source : '') : it.name)
            + '\nDouble-click: add a track for this instrument'
            + (it.playable ? '' : '\nClick ▶ to see why this one cannot be played')}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, height: 20, padding: '0 4px', borderRadius: 4,
            cursor: 'pointer',
            background: isLoaded(it) ? 'rgba(10,132,255,0.16)' : 'transparent',
            opacity: busy && busy === absPath(it) ? 0.5 : 1,
          }}
        >
          {/* 试听。放在名字左边而不是行尾：行尾已经挤着 model 与格式徽章，
              再挂一颗按钮窄栏里就剩不下名字了。 */}
          <button
            disabled={!!busy}
            onClick={e => { e.stopPropagation(); void audition(it); }}
            onDoubleClick={e => e.stopPropagation()}
            aria-label={it.playable ? 'Audition' : 'Why this cannot be played'}
            title={it.playable
              ? (playing === absPath(it) ? 'Playing…' : '试听这件乐器（C3 / C4 / C5）— 没装会先装上')
              : whyNotPlayable(it)}
            style={{
              flexShrink: 0, width: 16, height: 16, padding: 0, borderRadius: 3,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              cursor: busy ? 'default' : it.playable ? 'pointer' : 'help',
              color: playing === absPath(it)
                ? '#0a84ff'
                : it.playable ? 'rgba(255,255,255,0.62)' : 'rgba(255,255,255,0.34)',
              background: playing === absPath(it) ? 'rgba(10,132,255,0.2)' : 'rgba(255,255,255,0.06)',
              border: '0.5px solid ' + (it.playable ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.1)'),
            }}
          >{playing === absPath(it) ? <AuditionStopIcon /> : <AuditionIcon />}</button>
          <span style={{
            flex: 1, minWidth: 0, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            color: it.playable ? 'rgba(255,255,255,0.86)' : 'rgba(255,255,255,0.4)',
          }}>{it.name}</span>
          <span style={{
            flexShrink: 0, maxWidth: '40%', fontSize: 9, overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap', color: 'rgba(255,255,255,0.3)',
          }}>{it.model || it.source}</span>
          <span
            title={it.playable ? 'This engine can play it' : whyNotPlayable(it)}
            style={{
              flexShrink: 0, fontSize: 8.5, fontWeight: 600, letterSpacing: 0.3, padding: '1px 3px', borderRadius: 3,
              color: it.playable ? '#3b9dff' : 'rgba(255,255,255,0.3)',
              background: it.playable ? 'rgba(10,132,255,0.16)' : 'rgba(255,255,255,0.05)',
              border: '0.5px solid ' + (it.playable ? 'rgba(10,132,255,0.4)' : 'rgba(255,255,255,0.1)'),
            }}
          >{backendBadge(it)}</span>
          {isLoaded(it) && (
            <span style={{ flexShrink: 0, fontSize: 9, color: '#3b9dff' }}>loaded</span>
          )}
        </div>
      ))}
      {rows.length > shown.length && (
        <div style={{ ...instrNote, padding: '8px 4px', textAlign: 'left' }}>
          {`${rows.length - shown.length} more — narrow it down with the search box.`}
        </div>
      )}
    </div>
  );
};

export const VidAssets: React.FC<{ vid: VidController; midi: MidiCtl; sel?: string | null; onSel?: (s: InspectSel | null) => void; onActivate?: () => void }> = ({ vid, midi, sel, onSel, onActivate }) => {
  const { project: p } = vid;
  // 这份文档内嵌的图（Video / Image 两档的唯一数据源）。页面按整份清单播报，这里按活跃文档取桶 ——
  // 切 tab 那一瞬读到的就是目标文档自己那份，不必等页面重播。
  const doc = useDocAssets();
  const hostDoc = useDockDocument();
  const hostWin = useDockWindow();
  // 卡片尺度：高度一致，宽度跟着每件素材的宽高比走（Eagle 窗有自己那一颗值，两窗互不影响）。
  const assetScale = useAssetScale('assets');
  const cardH = cardHeightOf(assetScale);
  const [gridW, setGridW] = useState(0);
  const [over, setOver] = useState(false);
  // 起手看文档自己的模式：image 落地自己那套工作面，video 落 Layer 段，midi 落乐器库。
  // 之后跟着用户的手 —— 切文档不把人从自己选的档上拽走。
  const [scope, setScope] = useState<Scope>(() => (p.mode === 'video' ? 'video' : p.mode === 'midi' ? 'instruments' : 'image'));
  /** 这一档说的是"文档内嵌的图"（字节在 .cud 里，不是仓库里的一堆）。 */
  const docScope = scope === 'video' || scope === 'image';
  /** 乐器库那一档：不属文档，内容由 Settings → MIDI 里那条路径决定。 */
  const isInstruments = scope === 'instruments';
  const instrLib = useInstrumentLibrary();
  const midiSettings = useMidiSettings();
  const [kind, setKind] = useState<'all' | 'image' | 'video' | 'audio'>('all');
  const [q, setQ] = useState('');
  const [store, setStore] = useState<StoreAsset[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 清单自己拉失败，和"刚才那个动作失败"（relink 挑错文件…）分开存 —— 后者不能被一次重新拉取抹掉。
  const [listErr, setListErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick(t => t + 1), []);
  // 外面（Processor 的 Assets 落位、宿主导入、读档）写了仓库：跟着重拉。清单不是这一窗的
  // 私有事实 —— 它只是仓库的一面镜子。
  const [extTick, setExtTick] = useState(assetsTick());
  useEffect(() => subscribeAssets(() => setExtTick(assetsTick())), []);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // ── 多选(本窗本地的选择集;Inspector 仍只吃主选那一份载荷)──
  // 点 = 只选这张(照旧报 Inspector);Ctrl/Cmd+点 = 增减;Shift+点 = 从锚点连选到这张;
  // Del = 删掉选中的(工程资产出工程 / 仓库条目出仓库,各走各的路);Ctrl+A 全选;Esc 清空。
  // 选择集是**窗内**的事实:换作用域即清(两档 population 不同),搜索/类型过滤不动它。
  // 多选**按文档分桶**（useCudState）：卡片身份是资产哈希，而同一个哈希完全可能两份工程都有
  // —— 从前这颗 state 是页面级的，切到另一份工程后那几张"选中"仍然亮着，底下的 Del / Relink /
  // Remove from project 就冲着**那一份工程**里同哈希的卡去做了。现在换文档 = 换一桶。
  const [multiSel, setMultiSel] = useCudState<Set<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);       // Shift 连选的起点(最后一次普通点的那张)
  const [renaming, setRenaming] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null); // Del/Ctrl+A 只在网格握焦点时接手,不抢全局

  // 行布局要知道内容宽度：窗宽 / 换档 / 侧栏显隐都会改它。
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const read = () => setGridW(Math.max(0, Math.round(el.clientWidth - 16)));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 引用件的键（时间线在播的视频/音频）。不随 scope 收窄 —— 与"doc 两份清单都算在册"同一口径。
  const clipAliveKeys = useMemo(
    () => p.assets.map(a => 'c:' + (a.id || a.asset || a.play || a.src || a.name)),
    [p.assets],
  );

  // ── 选中态 → Inspector ── 点卡片选中(再点同一张不切换),Inspector 窗照这份载荷放大看。
  // 选中的卡被删掉/仓库条目消失 → 撤选。判**全量**四处列表(库 + 工程引用件 + 文档内嵌两份),与 scope/类型
  // 过滤无关:过滤只是"这档里看不见",不是"不在了"。
  useEffect(() => {
    if (!sel) return;
    // Inspector 是共用的：Eagle（`e:`）等别的窗喂进来的选中不归 Assets 管，
    // 不能因为"这一窗里找不到这张卡"就把它撤掉。
    if (!/^(?:s:|c:|d:)/.test(sel)) return;
    const keys = new Set<string>([
      ...(store ?? []).map(s => 's:' + (s.hash || s.name)),
      ...clipAliveKeys,
      ...doc.image.map(a => 'd:' + a.hash),
      ...doc.video.map(a => 'd:' + a.hash),
    ]);
    if (!keys.has(sel)) onSel?.(null);
  }, [sel, store, doc, clipAliveKeys, onSel]);

  // 多选集里指向已消失条目(删除 / 仓库清单刷新 / 换文档)的键,静默清掉 —— 与上面主选的守卫同一口径。
  useEffect(() => {
    setMultiSel(prev => {
      if (!prev.size) return prev;
      const alive = new Set<string>([
        ...(store ?? []).map(s => 's:' + (s.hash || s.name)),
        ...clipAliveKeys,
        ...doc.image.map(a => 'd:' + a.hash),
        ...doc.video.map(a => 'd:' + a.hash),
      ]);
      const next = new Set([...prev].filter(k => alive.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [store, doc, clipAliveKeys]);

  // ── 链接资产（右键菜单）────────────────────────────────────────────────────────────────────
  // 引用件只是"指着"仓库里的字节，指着的那份可能没了（MISSING），也可能当初就链错了（换成另一份）。
  // 两种都是同一件事：**把这条引用重新绑一份字节**。所以卡片右键给一个"链接资产…"——
  // 哈希一致 = 接回同一份（顺手把 src 换成仓库地址）；不一致先问一句再换（换的是整件货：
  // 原件 + 代理两个哈希一起换，只换一个会变成"新原件 + 旧代理"）。
  const [menu, setMenu] = useState<{ x: number; y: number; from: AssetIdentity; name: string } | null>(null);
  const linkRef = useRef<HTMLInputElement | null>(null);
  const linkForRef = useRef<{ from: AssetIdentity; name: string } | null>(null);
  const startLink = (from: AssetIdentity, name: string) => {
    if (!from.asset && !from.play && !from.src) return;
    linkForRef.current = { from, name };
    setErr(null);
    linkRef.current?.click();
  };
  /** 右键一张引用件：先把它选中（菜单说的事就是这张卡），再开菜单。 */
  const openCardMenu = (e: React.MouseEvent, key: string, from: AssetIdentity, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!from.asset && !from.play && !from.src) return;
    if (!multiSel.has(key)) setMultiSel(new Set([key]));
    setMenu({ x: e.clientX, y: e.clientY, from, name });
  };
  const onLinkPick = async (f: File | undefined) => {
    const t = linkForRef.current;
    linkForRef.current = null;
    if (!f || !t) return;
    const ing = await ingestFile(f);
    if (!ing || !ing.asset) { setErr('This file could not be read (ingest failed)'); return; }
    // 不是同一份字节 ⇒ 这是一次换绑，不是接回。把两句实话摆出来再让他决定。
    if (ing.asset !== t.from.asset && ing.play !== t.from.play) {
      const n = usedByCount(useIdx, t.from.asset, t.from.play, t.from.src);
      const ok = window.confirm(
        `「${t.name}」现在指向 ${(t.from.asset || t.from.play || t.from.src || '?').slice(0, 8)}…\n`
        + `你挑的这个文件是 ${ing.asset.slice(0, 8)}… —— 不是同一份字节。\n\n`
        + `要把这条引用改指到它吗？`
        + (n ? `时间线上引用它的 ${n} 个片段一起换。` : '时间线上还没有片段用它。'));
      if (!ok) return;
    }
    const r = await vid.relink(t.from, ing);
    if (!r.ok) setErr(r.error || 'link failed');
    bump();
  };
  // 菜单关掉的三条路：点别处、滚网格（菜单位置不跟着走）、Esc。
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    hostWin.addEventListener('pointerdown', close);
    hostWin.addEventListener('wheel', close, { passive: true });
    hostWin.addEventListener('keydown', key);
    return () => {
      hostWin.removeEventListener('pointerdown', close);
      hostWin.removeEventListener('wheel', close);
      hostWin.removeEventListener('keydown', key);
    };
  }, [menu]);

  // 仓库清单：一次拉全（`/api/global_assets` = 仓库里的一切 + 媒体探测），四档作用域与搜索都在
  // 本地过滤 —— 一百多件的过滤比往返一趟便宜，搜索也不必去抖。`tick` 变了就重拉（导入/删除之后）。
  useEffect(() => {
    let alive = true;
    setBusy(true);
    setListErr(null);
    fetch('/api/global_assets')
      .then(r => r.json())
      .then(d => {
        if (!alive) return;
        setStore(Array.isArray(d?.assets) ? d.assets : []);
        if (d?.ok === false) setListErr(d?.error || 'list failed');
      })
      .catch(e => { if (alive) { setStore([]); setListErr(String(e)); } })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [tick, extTick]);

  // 谁在用它 —— 判据在模型里（`clipUseIndex` / `usedByCount`）：一件货有三个身份
  // （asset / play / src），仓库里同一份字节又有两个地址面，只比 src 字符串会得出
  // "明明在用却写 0 clips"，而且换个拖法结论就变。这里只负责把它画成一行字。
  const useIdx = useMemo(() => clipUseIndex(p.clips), [p.clips]);
  const usedBy = (...keys: (string | null | undefined)[]) => {
    const n = usedByCount(useIdx, ...keys);
    return n ? `${n} clip${n > 1 ? 's' : ''}` : '';
  };

  const needle = q.trim().toLowerCase();
  const hits = (name: string, extra?: string) =>
    !needle || name.toLowerCase().includes(needle) || (extra || '').toLowerCase().includes(needle);

  // Library 档只列**库成员**：仓库里剩下的那些（run / processor 的中间图、别人文档带进来的图）
  // 不再占一档 —— 它们不是"我的东西"，跨文档也认不出来。
  const storeItems = scope !== 'library' ? [] : (store || []).filter(s => {
    // 老服务没有 inLibrary 字段 ⇒ 当作库成员（宁可多显示，也别把整库藏起来）。
    if (s.inLibrary === false) return false;
    if (kind !== 'all' && s.kind !== kind) return false;
    return hits(s.displayName || s.name, s.hash);
  });

  // 文档那两档：页面报来的引用按内容哈希收成一叠卡（同一张图被几层共用只有一张脸）。
  // `setNames` 把 Layer 段的 key 翻成段名 —— 段名住在视频工程里，页面只认 key。
  const setNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of p.clips) {
      if (c.kind === 'layer' && c.layerKey) m.set(c.layerKey, c.name || 'Layer');
    }
    return m;
  }, [p.clips]);
  const docGroups = useMemo(
    () => (docScope ? groupDocAssets(scope === 'video' ? doc.video : doc.image) : []),
    [docScope, scope, doc],
  );
  const docItems = docGroups.filter(g => hits(g.name, g.hash));
  // Video 档的另一半：时间线在播的视频 / 音频。**只引用、不内嵌** —— .cud 里是哈希与 URL，
  // 字节还在仓库里（素材动辄几百兆，内嵌一份就把文件撑爆）。Image 档没有片段，所以不列。
  const clipCardsAll = useMemo(
    () => (scope === 'video' ? clipCards(p.assets, useIdx, vid.missing) : []),
    [scope, p.assets, useIdx, vid.missing],
  );
  const clipItems = clipCardsAll.filter(c => hits(c.name, c.asset || c.play));
  // 页面还没播报这份文档（刚切过去的那一瞬）—— 空网格要说是"在等"，不是"没有"。
  // 引用件不靠播报（工程就在宿主手里），所以只有"一份内嵌图都没有"时它才算数。
  const docPending = docScope && doc.uid === null && docItems.length === 0;

  // 时间线引用了、但仓库里没有字节的哈希。它们没有自己的档了（工程资产表不单独成档），
  // 就挂在 Library 档末尾当"MISSING"那几张 —— 点回形针能把原件接回来。
  const coveredHashes = new Set<string>();
  for (const a of p.assets) { if (a.asset) coveredHashes.add(a.asset); if (a.play) coveredHashes.add(a.play); }
  const orphanMissing = scope !== 'library' || kind === 'image' ? []
    : [...vid.missing].filter(h => !coveredHashes.has(h));
  const total = storeItems.length + docItems.length + clipItems.length + orphanMissing.length;

  // 收进本工程（视频/音频才有片段可落；图片不是可播素材）。
  const claimStore = (s: StoreAsset) => {
    if (s.kind === 'image') return;
    vid.update(proj => addAsset(proj, {
      id: newVidId('as'), name: s.displayName || s.name, src: playUrlOf(s), origin: 'file',
      // 仓库里那一件的正身：`url` 是门面（可能带端口），`hash` 才是身份。
      asset: s.hash || undefined,
      play: s.playHash || undefined,
      kind: s.kind === 'audio' ? 'audio' : 'video',
      duration: s.duration, hasAudio: s.hasAudio === true,
    }), 'Add library asset');
  };

  // 渲染序的全量键表(Shift 连选按它取范围)。库档只有库条目 + 孤儿缺失;文档两档 = 引用件 + 内嵌图。
  const visibleKeys = [
    ...storeItems.map(s => 's:' + (s.hash || s.name)),
    ...orphanMissing.map(h => 'm:' + h),
    ...clipItems.map(c => c.key),
    ...docItems.map(g => 'd:' + g.hash),
  ];

  const cardClick = (e: React.MouseEvent, key: string, payload: InspectSel) => {
    gridRef.current?.focus();        // Del/Ctrl+A 的落点跟着"最后点过的窗"走
    if (e.shiftKey && anchorRef.current && anchorRef.current !== key) {
      const a = visibleKeys.indexOf(anchorRef.current), b = visibleKeys.indexOf(key);
      if (a >= 0 && b >= 0) {
        setMultiSel(new Set(visibleKeys.slice(Math.min(a, b), Math.max(a, b) + 1)));
        onSel?.(payload);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setMultiSel(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
    } else {
      setMultiSel(new Set([key]));
    }
    anchorRef.current = key;
    onSel?.(payload);
  };

  // Del:只对**库条目**生效（字节真删，整批一次确认）。文档那两档里的图删不得 —— 它们是文件的
  // 一部分，删一行库表只是把文档的缓存抹掉，画面该缺还是缺。孤儿缺失键不可选,天然走不到。
  const deleteSelected = async () => {
    if (docScope || isInstruments) return;
    const sKeys = [...multiSel].filter(k => k.startsWith('s:')).map(k => k.slice(2));
    if (sKeys.length) {
      const items = sKeys
        .map(id => (store || []).find(s => (s.hash || s.name) === id))
        .filter((s): s is StoreAsset => !!s && !!s.hash);
      if (items.length) {
        const ok = window.confirm(items.length === 1
          ? `Delete「${items[0].displayName || items[0].name}」from the library?\n\nThe file and its record are removed. ` +
            `Timeline clips and layers that reference it are marked MISSING until you relink the original file.`
          : `Delete ${items.length} assets from the library?\n\nThe files and their records are removed. ` +
            `Timeline clips and layers that reference them are marked MISSING until you relink the originals.`);
        if (ok) {
          for (const s of items) {
            const r = await fetch('/api/asset_delete', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: s.hash }),
            }).then(x => x.json()).catch(() => null);
            if (!r?.ok) setErr(r?.error || 'delete failed');
          }
          // 删完整批重问一次缺失:时间线该当场标红,不该等下一次工程改动。
          vid.recheckMissing();
        }
      }
    }
    setMultiSel(new Set());
    anchorRef.current = null;
    bump();
  };

  // 网格自己的快捷键:焦点在网格上才接手(改名输入框会拦住自己的键,冒不上来)。
  const gridKeyDown = (e: React.KeyboardEvent) => {
    // 两键都按名字查表（assets.delete / assets.select-all）—— React 的事件包一层，判定用原生那个。
    const native = e.nativeEvent;
    if (isRecording()) return;
    if (hit(native, 'assets.delete')) {
      if (!multiSel.size || docScope) return;
      e.preventDefault();
      void deleteSelected();
    } else if (hit(native, 'assets.select-all')) {
      e.preventDefault();
      setMultiSel(new Set(visibleKeys.filter(k => !k.startsWith('m:'))));   // 孤儿缺失卡不可选
      anchorRef.current = null;
    } else if (native.key === 'Escape') {
      setMultiSel(new Set());
    }
  };

  // 双击名字 → 原地改名。只有库条目能改（名字在库表里，跨文档共享）；文档里那张的名字是**图层名**，
  // 该在 Layers 窗改，不在这儿改。
  const commitStoreRename = async (id: string, next: string) => {
    setRenaming(null);
    const r = await fetch('/api/asset_update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: next }),
    }).then(x => x.json()).catch(() => null);
    if (!r?.ok) setErr(r?.error || 'rename failed');
    bump();
  };

  // 导入图片进库（POST /api/asset_import）。视频/音频不走这条路：它们要 ffmpeg 入库 + 探测，
  // 仍然落到本工程的资产里（拖文件那条老路），A5 再把它们并进仓库。
  const importFiles = async (files: File[]) => {
    for (const f of files) {
      if (!/^image\//.test(f.type) && !IMG_EXT.test(f.name)) continue;
      const dataurl = await fileToDataURL(f);
      if (!dataurl) continue;
      await fetch('/api/asset_import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: [dataurl], names: [f.name], library: true, origin: 'upload' }),
      }).catch(() => null);
    }
    bump();
  };

  const collectFile = async (f: File) => {
    const ing = await ingestFile(f);
    if (ing) {
      vid.update(proj => addAsset(proj, {
        id: newVidId('as'), name: ing.name, src: ing.src, origin: 'file',
        asset: ing.asset, play: ing.play,
        kind: ing.audioOnly ? 'audio' : 'video',
        duration: ing.duration, hasAudio: ing.hasAudio,
        waveform: ing.waveform,
      }));
      return;
    }
    const url = URL.createObjectURL(f);
    const info = await probeMedia(url, isAudioName(f.name) ? 'audio' : 'video');
    if (!info) return;
    vid.update(proj => addAsset(proj, {
      id: newVidId('as'), name: f.name, src: url, origin: 'file',
      kind: info.audioOnly ? 'audio' : 'video',
      duration: info.duration, hasAudio: info.hasAudio,
    }));
  };

  const collectSource = async (src: string, name: string, asset?: string, play?: string) => {
    const info = await probeMedia(src, isAudioName(name) ? 'audio' : 'video');
    if (!info) return;
    vid.update(proj => addAsset(proj, {
      id: newVidId('as'), name, src, origin: 'staging', asset, play,
      kind: info.audioOnly ? 'audio' : 'video',
      duration: info.duration, hasAudio: info.hasAudio,
    }));
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    // 乐器库那一档收不了东西：它列的是"盘上哪儿有一件乐器"，不是可入库的字节。文件拖进来
    // 在这里落不进任何地方 —— 但 preventDefault 还是要做，否则浏览器会拿它当"打开这个文件"。
    if (isInstruments) return;
    const sid = e.dataTransfer.getData(STAGING_ITEM_TYPE);
    if (sid) {
      const item = vid.staging.find(s => s.id === sid);
      if (item) { void collectSource(item.src, item.name || sid); return; }
    }
    // 仓库卡片拖回这一窗 = 收进本工程（同一张表拖来拖去，不该什么都没发生）。
    const aRaw = e.dataTransfer.getData(ASSET_ITEM_TYPE);
    if (aRaw) {
      try {
        const a = JSON.parse(aRaw) as { id?: string; url?: string; name?: string; kind?: string; play?: string | null };
        if (a?.url && a.kind !== 'image') { void collectSource(a.url, a.name || a.url, a.id, a.play || undefined); return; }
      } catch { /* 不是我们写的那份：继续看文件 */ }
    }
    const files = Array.from(e.dataTransfer.files || []);
    const media = files.filter(f => f.type.startsWith('video/') || f.type.startsWith('audio/') || isVideoName(f.name) || isAudioName(f.name));
    const images = files.filter(f => !media.includes(f));
    if (images.length) void importFiles(images);
    for (const f of media) void collectFile(f);
  };

  // 底栏那一行：乐器档报的是"扫到多少件、从哪儿来的"，跟其它三档的"多少件字节"不是一回事，
  // 所以它自己一句话，不挤进那个三元的表达式里。
  const instrLine = !isInstruments ? ''
    : instrLib.loading ? 'scanning the library…'
      : instrLib.error ? instrLib.error
        : instrLib.lib && !instrLib.lib.ok ? (instrLib.lib.state.reason || 'library unreadable')
          : instrLib.lib && (instrLib.lib.state.set || instrLib.lib.presetsState.set)
            ? `${instrLib.lib.total} ${instrLib.lib.total === 1 ? 'instrument' : 'instruments'} · `
              + `${(instrLib.lib.items || []).filter(i => i.playable).length} playable · `
              + (instrLib.lib.source === 'catalog' ? 'catalog' : 'folder scan')
              + (instrLib.lib.truncated ? ' · truncated' : '')
            : 'no library folder yet';
  const instrBroken = isInstruments && (!!instrLib.error || (!!instrLib.lib && !instrLib.lib.ok));

  // 一张卡 = 一个 spec：key + 宽高比 + "给行高/行宽就画出来"。justifiedRows 先按目标高分行，
  // 再把这一行算好的 (h, w) 交给 Card —— 整行铺满，行内每张图的缩略图高度仍然一致。
  type CardSpec = { key: string; ratio: number; render: (h: number, w: number) => React.ReactNode };
  const cardSpecs: CardSpec[] = [];
  if (!isInstruments) {
    for (const c of clipItems) {
      const payload: InspectSel = {
        key: c.key, name: c.name, kind: c.kind, src: c.missing ? '' : c.url,
        duration: c.duration, hasAudio: c.hasAudio,
        origin: 'timeline', hash: c.asset || c.play,
      };
      cardSpecs.push({
        key: c.key,
        ratio: c.kind === 'audio' ? 1.6 : 16 / 9,
        render: (ch, cw) => (
          <Card
            key={c.key}
            cardH={ch}
            cardW={cw}
            selected={multiSel.has(c.key) || (multiSel.size === 0 && sel === c.key)}
            onDoubleClick={onActivate}
            onClick={e => cardClick(e, c.key, payload)}
            onContextMenu={e => openCardMenu(e, c.key, { asset: c.asset, play: c.play, src: c.src }, c.name)}
            it={{
              name: c.name, kind: c.kind, src: c.missing ? '' : c.url,
              duration: c.duration, hasAudio: c.hasAudio,
              byteFrom: c.missing ? 'missing' : 'ref',
              origin: 'timeline',
              usedBy: c.uses ? `${c.uses} clip${c.uses > 1 ? 's' : ''}` : 'unused',
              drag: c.missing ? undefined : {
                [ASSET_ITEM_TYPE]: JSON.stringify({
                  id: c.id || c.asset || c.play, url: c.url, name: c.name, kind: c.kind,
                  asset: c.asset, play: c.play,
                }),
                [GLOBAL_ITEM_TYPE]: JSON.stringify({
                  url: c.url, name: c.name, kind: c.kind, asset: c.asset, play: c.play,
                }),
                ...(c.id ? { [VID_ASSET_TYPE]: c.id } : null),
              },
              actions: (
                <button
                  title={c.missing
                    ? 'Link「' + c.name + '」— pick the original file'
                    : 'Link「' + c.name + '」to a different file — every clip that uses it follows'}
                  onClick={() => startLink({ asset: c.asset, play: c.play, src: c.src }, c.name)}
                  style={{ ...rowBtn, color: c.missing ? '#ff6b60' : 'rgba(255,255,255,0.5)' }}
                >
                  <ClipIcon />
                </button>
              ),
            }}
          />
        ),
      });
    }

    for (const g of docItems) {
      const key = 'd:' + g.hash;
      const url = docUrlOf(g.hash);
      const payload: InspectSel = {
        key, name: g.name, kind: 'image', src: url, duration: 0, hasAudio: null,
        origin: scope === 'video' ? 'layer segment' : 'document', hash: g.hash,
      };
      cardSpecs.push({
        key,
        ratio: aspectOf(g.w, g.h),
        render: (ch, cw) => (
          <Card
            key={key}
            cardH={ch}
            cardW={cw}
            selected={multiSel.has(key) || (multiSel.size === 0 && sel === key)}
            onDoubleClick={onActivate}
            onClick={e => cardClick(e, key, payload)}
            it={{
              name: g.name, kind: 'image', src: url, duration: 0, hasAudio: null,
              w: g.w, h: g.h,
              poster: url,
              byteFrom: 'doc',
              origin: whereText(g, k => setNames.get(k) || (k === '' ? 'document' : 'Layer')),
              drag: {
                [ASSET_ITEM_TYPE]: JSON.stringify({ id: g.hash, url, name: g.name, kind: 'image', asset: g.hash }),
              },
            }}
          />
        ),
      });
    }

    for (const h of orphanMissing) {
      const key = 'm:' + h;
      cardSpecs.push({
        key,
        ratio: 16 / 9,
        render: (ch, cw) => (
          <Card
            key={key}
            cardH={ch}
            cardW={cw}
            onContextMenu={e => openCardMenu(e, key, { asset: h }, 'missing · ' + h.slice(0, 8))}
            it={{
              name: 'missing · ' + h.slice(0, 8), kind: 'video', src: '', duration: 0, hasAudio: null,
              byteFrom: 'missing', origin: 'referenced by the timeline',
              actions: (
                <button
                  title={'Link the bytes for ' + h.slice(0, 8) + '… — pick the original file, or another one to rebind'}
                  onClick={() => startLink({ asset: h }, 'missing · ' + h.slice(0, 8))}
                  style={{ ...rowBtn, color: '#ff6b60' }}
                >
                  <ClipIcon />
                </button>
              ),
            }}
          />
        ),
      });
    }

    for (const s of storeItems) {
      const id = s.hash || s.name;
      const key = 's:' + id;
      const label = s.displayName || s.name;
      const play = playUrlOf(s);
      const payload: InspectSel = {
        key, name: label, kind: s.kind,
        src: s.kind === 'image' ? s.url : play,
        duration: s.duration, hasAudio: s.hasAudio,
        origin: s.origin || 'library',
        hash: s.hash, size: s.size,
      };
      cardSpecs.push({
        key,
        ratio: aspectOf(s.w, s.h, s.kind === 'audio' ? 1.6 : 16 / 9),
        render: (ch, cw) => (
          <Card
            key={key}
            cardH={ch}
            cardW={cw}
            selected={multiSel.has(key) || (multiSel.size === 0 && sel === key)}
            onDoubleClick={onActivate}
            onClick={e => cardClick(e, key, payload)}
            it={{
              name: label, kind: s.kind, src: s.kind === 'image' ? s.url : play, duration: s.duration, hasAudio: s.hasAudio,
              w: s.w, h: s.h,
              poster: s.kind === 'image' ? (s.thumb || s.url) : null,
              byteFrom: 'store',
              origin: s.origin || 'library',
              usedBy: usedBy(s.hash, s.playHash, play, s.url),
              drag: (() => {
                const out: Record<string, string> = {
                  [ASSET_ITEM_TYPE]: JSON.stringify({ id, url: play, name: label, kind: s.kind, asset: s.hash, play: s.playHash }),
                };
                if (s.kind !== 'image') {
                  out[GLOBAL_ITEM_TYPE] = JSON.stringify({ url: play, name: label, kind: s.kind, asset: s.hash, play: s.playHash });
                }
                return out;
              })(),
              renaming: renaming === key,
              onNameDoubleClick: s.hash ? () => setRenaming(key) : undefined,
              onRenameCommit: next => { if (s.hash) void commitStoreRename(s.hash, next); },
              onRenameCancel: () => setRenaming(null),
              actions: s.kind !== 'image' ? (
                <span style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                  <button title={'Claim「' + label + '」into this project'} onClick={() => claimStore(s)} style={rowBtn}>
                    <PlusIcon />
                  </button>
                </span>
              ) : undefined,
            }}
          />
        ),
      });
    }
  }
  const gridRows = justifiedRows(cardSpecs, gridW || 320, cardH, 6);

  return (
    <div
      onDragOver={e => {
        // 乐器档收不了东西 —— 不 preventDefault，浏览器自己给"不可放下"的光标，
        // 比先亮一个蓝框再什么都不做诚实。
        if (isInstruments) return;
        const ts = e.dataTransfer.types; if (ts.includes(STAGING_ITEM_TYPE) || ts.includes(ASSET_ITEM_TYPE) || Array.from(ts).includes('Files')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(o => (o ? false : o))}
      onDrop={onDrop}
      style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#141416', minWidth: 0, overflow: 'hidden' }}
    >
      {/* 第一行：作用域。四档 = 公用库 + 这份文档的两种用途（层段 / image 工作面）+ 乐器库。
          窄窗里四个按钮会挤到换行 —— wrap 比横向滚动好找。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, rowGap: 3, flexWrap: 'wrap', padding: '5px 6px 3px', flexShrink: 0 }}>
        {SCOPES.map(s => (
          <button
            key={s.id}
            title={s.title}
            onClick={() => { setScope(s.id); setMultiSel(new Set()); setRenaming(null); anchorRef.current = null; }}
            style={{
              display: 'flex', alignItems: 'center', gap: 3, height: 18, padding: '0 5px',
              fontSize: 9.5, fontWeight: 600, letterSpacing: 0.2, whiteSpace: 'nowrap',
              border: '0.5px solid ' + (scope === s.id ? 'rgba(10,132,255,0.55)' : 'rgba(255,255,255,0.12)'),
              borderRadius: 4, background: scope === s.id ? 'rgba(10,132,255,0.16)' : 'transparent',
              color: scope === s.id ? '#3b9dff' : 'rgba(255,255,255,0.42)', cursor: 'pointer',
            }}
          >
            {s.id === 'library' && <GlobeIcon size={9} />}
            {s.label}
          </button>
        ))}
      </div>

      {/* 第二行：种类 + 搜索 + 导入。种类与导入只对库有意义 —— 文档那两档里全是图，也 import 不了。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px 5px', borderBottom: '0.5px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
        {scope === 'library' && (
          <select value={kind} onChange={e => setKind(e.target.value as 'all' | 'image' | 'video' | 'audio')} style={selStyle}>
            <option value="all">All kinds</option>
            <option value="image">Images</option>
            <option value="video">Video</option>
            <option value="audio">Audio</option>
          </select>
        )}
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search…"
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0, height: 18, fontSize: 9.5, color: 'rgba(255,255,255,0.75)',
            background: '#1b1b1e', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 4,
            padding: '0 4px', outline: 'none',
          }}
        />
        {scope === 'library' && (
          <>
            <button
              title="Import images into the library (they are copied into data/assets)"
              onClick={() => fileRef.current?.click()}
              style={{ ...rowBtn, width: 18, height: 18, border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 4, color: 'rgba(255,255,255,0.55)' }}
            >
              <PlusIcon />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={e => {
                const fs = Array.from(e.target.files || []);
                e.target.value = '';
                void importFiles(fs);
              }}
            />
          </>
        )}
        {/* 卡片尺度：只改"多大一张"，不改每张卡自己的宽高比。乐器档是列表，不用它。 */}
        {!isInstruments && <CardScaleControl kind="assets" />}
        {/* 链接资产的文件入口：引用件右键菜单那一项、以及卡上那颗回形针，都点它
            （同一时刻只为一条引用挑文件）。 */}
        <input
          ref={linkRef}
          type="file"
          accept="video/*,audio/*"
          style={{ display: 'none' }}
          onChange={e => {
            const f = e.target.files?.[0];
            e.target.value = '';
            void onLinkPick(f);
          }}
        />
      </div>

      {/* 缺失横幅：时间线引用的字节不在仓库里了。缺失卡在 Library 档末尾，这里是入口 + 一句实话。 */}
      {vid.missing.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', flexShrink: 0,
          background: 'rgba(255,69,58,0.12)', borderBottom: '0.5px solid rgba(255,69,58,0.35)',
        }}>
          <span style={{ fontSize: 9.5, fontWeight: 800, color: '#ff6b60', flexShrink: 0, whiteSpace: 'nowrap' }}>
            {vid.missing.size} missing
          </span>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {/* 引用件卡（Video 档）与 Library 档末尾那几张都带回形针，只有 Image 档无处下手。 */}
            {scope === 'image' ? 'The timeline references bytes that are gone from the store.' : 'Pick the original file with the paperclip on a card.'}
          </span>
          {scope === 'image' && (
            <button
              onClick={() => setScope('library')}
              style={{ ...rowBtn, width: 'auto', height: 16, padding: '0 5px', fontSize: 9, flexShrink: 0, color: '#ff9a92', background: 'rgba(255,69,58,0.18)', borderRadius: 4 }}
            >Show</button>
          )}
        </div>
      )}

      {/* 卡片网格：可拖（application/x-asset）。网格握焦点接 Del / Ctrl+A / Esc ——
          点卡片那一下就把焦点带进来（onPointerDownCapture），不抢全局快捷键。 */}
      <div
        ref={gridRef}
        tabIndex={0}
        onKeyDown={gridKeyDown}
        onPointerDownCapture={() => gridRef.current?.focus()}
        style={{
          flex: 1, minHeight: 0, overflow: 'auto', scrollbarWidth: 'thin', outline: 'none',
          padding: 8, gap: 6,
          // 乐器档是一张列表（一行一件）；其它档是**按行 justified** 的卡片：整行铺满、
          // 行内缩略图等高，所以外层是纵向排列的一组行，而不是等宽网格。
          display: isInstruments ? 'grid' : 'flex',
          flexDirection: isInstruments ? undefined : 'column',
          alignContent: isInstruments ? 'flex-start' : undefined,
          gridTemplateColumns: isInstruments ? '1fr' : undefined,
          background: over && !isInstruments ? 'rgba(10,132,255,0.06)' : 'transparent',
        }}
      >
        {isInstruments && <InstrumentList q={q} midi={midi} />}

        {!isInstruments && total === 0 && (
          <div style={{ width: '100%', padding: 16, fontSize: 11, color: 'rgba(255,255,255,0.35)', textAlign: 'center', lineHeight: 1.8, whiteSpace: 'pre-line' }}>
            {docPending ? 'Reading this document…'
              : docScope && scope === 'video' ? 'Nothing in this document yet.\nMedia you drop on the timeline shows up here as a reference;\nimages on Layer segments are embedded.'
                : docScope ? 'This document has no images yet.\nLayers, guidances and the staging pool show up here.'
                  : busy ? 'Loading…'
                    : 'The library is empty.\nDrop files here or use ＋ to import images.'}
          </div>
        )}

        {/* 卡片：按行 justified 排列（整行铺满、行内缩略图等高）。 */}
        {!isInstruments && gridRows.map((row, ri) => (
          <div key={'row' + ri} style={{ display: 'flex', gap: 6, width: '100%', flexShrink: 0, alignItems: 'flex-start' }}>
            {row.items.map((spec, i) => spec.render(row.height, row.widths[i]))}
          </div>
        ))}
      </div>

      {/* 底栏：一句实话 —— 现在这一档有多少件、是什么在喂它。 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', flexShrink: 0,
        borderTop: '0.5px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.015)',
      }}>
        <span
          title={isInstruments ? (instrLib.lib?.root || undefined) : ((err || listErr) || undefined)}
          style={{
            fontSize: 9.5, color: (instrBroken || (!isInstruments && (err || listErr))) ? '#ff8a80' : 'rgba(255,255,255,0.32)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
          {isInstruments ? instrLine
            : busy && !docScope ? 'loading…' : err ? err : listErr ? listErr
              : `${total} ${total === 1 ? 'item' : 'items'} · ${scope === 'library' ? 'library' : 'in this document'}`}
        </span>
        {multiSel.size > 0 && (
          <span style={{ fontSize: 9, color: '#3b9dff', flexShrink: 0, whiteSpace: 'nowrap' }}>
            {docScope ? `${multiSel.size} selected` : `${multiSel.size} selected · Del to delete from the library`}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {isInstruments ? (
          <>
            <span
              title={midiSettings.instrumentsLibrary || undefined}
              style={{
                fontSize: 9, color: 'rgba(255,255,255,0.26)', flexShrink: 1, minWidth: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >{folderName(midiSettings.instrumentsLibrary)}</span>
            <button
              title="Read that folder again from disk (the list is cached until you ask)"
              onClick={() => void reloadInstruments(true)}
              style={{
                ...rowBtn, width: 'auto', height: 15, padding: '0 4px', flexShrink: 0,
                fontSize: 8.5, fontWeight: 600, border: '0.5px solid rgba(255,255,255,0.12)',
                borderRadius: 3, color: 'rgba(255,255,255,0.45)',
              }}
            >Rescan</button>
          </>
        ) : docScope ? (
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.26)', flexShrink: 0, whiteSpace: 'nowrap' }}
            title={scope === 'video'
              ? 'REF = the .cud stores only the hash and URL (bytes stay in the store). IN DOC = the pixels are embedded in the .cud.'
              : 'These bytes are embedded in the .cud — data/assets keeps a load-time cache of them'}>
            {scope === 'video'
              ? `${clipItems.length} referenced · ${docItems.length} embedded`
              : `${docItems.length} embedded in the .cud`}
          </span>
        ) : store && (
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.26)', flexShrink: 0 }}>
            {store.filter(s => s.inLibrary !== false).length} in library
          </span>
        )}
      </div>

      {/* 引用件的右键菜单：只有一条 —— 链接资产（引用不是字节，链错了就得能换）。
          菜单挂 body 上（网格会滚、会裁，fixed 的浮层只有挂到 body 才压得住）。 */}
      {menu && createPortal(
        <div
          data-asset-menu="1"
          onContextMenu={e => e.preventDefault()}
          style={{
            position: 'fixed', zIndex: 9999,
            left: Math.max(8, Math.min(menu.x, hostWin.innerWidth - 240)),
            top: Math.max(8, Math.min(menu.y, hostWin.innerHeight - 96)),
            width: 232, padding: 4, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 1,
            background: 'rgba(34,34,38,0.985)', border: '0.5px solid rgba(255,255,255,0.16)',
            boxShadow: '0 12px 36px rgba(0,0,0,0.6)',
          }}
        >
          <div style={{
            padding: '4px 9px 6px', fontSize: 9, lineHeight: 1.5, color: 'rgba(255,255,255,0.36)',
            borderBottom: '0.5px solid rgba(255,255,255,0.08)', marginBottom: 3,
          }}>
            {menu.name}
            <br />
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              → {(menu.from.asset || menu.from.play || menu.from.src || '?').slice(0, 16)}…
            </span>
          </div>
          <button
            type="button"
            title={'Bind this reference to a file — clips that use it follow. Same bytes = relink; different bytes = rebind (you get asked first).'}
            onClick={() => { startLink(menu.from, menu.name); setMenu(null); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left',
              padding: '6px 9px', borderRadius: 5, border: 'none', background: 'transparent',
              color: 'rgba(255,255,255,0.92)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <ClipIcon />
            链接资产…
          </button>
        </div>,
        hostDoc.body,
      )}
    </div>
  );
};
