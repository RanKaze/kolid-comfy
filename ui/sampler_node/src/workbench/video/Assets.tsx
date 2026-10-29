import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { InspectSel } from './Inspector';
import {
  type AssetIdentity, type VidController, clipUseIndex, fmtTime, isAudioName, isVideoName, addAsset, newVidId,
  usedByCount,
} from './model';
import { probeMedia } from './audio';
import { assetsTick, subscribeAssets } from './assetsTick';
import { ingestFile } from './ingest';
import { useCudState } from '../cudScope';
import { hit, isRecording } from '../../keybindings';
import { useDocAssets } from '../docAssets';
import { clipCards, groupDocAssets, whereText } from './assetScope';
import { ensureFrame, ensureWaveform } from './previews';

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

/** 三档：公用库 / 这份文档的 Layer 段 / 这份文档的 image 工作面。后两档的字节在 .cud 里。 */
export type Scope = 'library' | 'video' | 'image';

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

/** 缩略图那一块：海报帧（或悬停扫到的那一格）+ 角标 + 扫片进度线。 */
const Thumb: React.FC<{ m: CardMedia; poster: string | null }> = ({ m, poster }) => {
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
        position: 'relative', width: '100%', flexShrink: 0, aspectRatio: '16 / 9', background: '#08080a',
        display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
        borderRadius: '5.5px 5.5px 0 0',
        cursor: m.kind === 'video' ? 'ew-resize' : undefined,
      }}
    >
      <span style={{ fontSize: 16, color: 'rgba(255,255,255,0.22)', pointerEvents: 'none' }}>{glyph}</span>
      {poster && (
        // key：换一次 src 就换一个元素 —— 否则某一张图 404 触发的 `display:none` 会**永久**
        // 留在同一个 <img> 上，后面换任何 src 都是空白。
        <img key={poster} src={poster} draggable={false} decoding="async"
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
  /** 字节在哪：`store` 只在仓库；`doc` 某份文档里也内嵌了一份（A4 之后才可能出现）；
   *  `ref` 文档只是**引用**它（.cud 里记哈希与 URL，字节留在仓库 —— 视频/音频走这一档）；
   *  `missing` 引用还在、字节没了。 */
  byteFrom?: 'store' | 'doc' | 'ref' | 'missing';
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
}> = ({ it, selected, onClick, onDoubleClick, onContextMenu }) => {
  const poster = useCardThumb(it.kind, it.src, it.poster);
  const [over, setOver] = useState(false);
  const badge = it.byteFrom ? BYTE_BADGE[it.byteFrom] : null;
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
      }}
      onPointerEnter={() => setOver(true)}
      onPointerLeave={() => setOver(false)}
      title={it.usedBy ? `${it.name} — ${it.usedBy}` : it.name}
      style={{
        display: 'flex', flexDirection: 'column', minWidth: 0, borderRadius: 6,
        border: selected ? '1px solid #0a84ff'
          : '0.5px solid ' + (it.byteFrom === 'missing'
            ? 'rgba(255,69,58,0.45)'
            : over ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.1)'),
        background: '#0f0f11', cursor: onClick ? 'pointer' : it.drag ? 'grab' : 'default', userSelect: 'none',
      }}
    >
      <div style={{ position: 'relative' }}>
        <Thumb
          m={{ src: it.src, kind: it.kind, duration: it.duration, hasAudio: it.hasAudio }}
          poster={poster}
        />
        {badge && (
          <span style={{ position: 'absolute', top: 3, right: 3, display: 'flex', pointerEvents: 'none' }}>
            <Chip color={badge.color} title={badge.title}>{badge.text}</Chip>
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px 0', minWidth: 0 }}>
        {it.renaming && it.onRenameCommit ? (
          <RenameInput initial={it.name} commit={it.onRenameCommit} cancel={() => it.onRenameCancel?.()} />
        ) : (
          <span
            onDoubleClick={e => { e.stopPropagation(); it.onNameDoubleClick?.(); }}
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
];

/** 内嵌图的可播地址：载入时这些字节已经落回仓库（storeCudImages），所以一张 <img> 就能画。
 *  仓库副本没了（用户手删）就会 404 —— 卡片上标 MISSING，字节其实还在文件里。 */
const docUrlOf = (hash: string): string => '/api/asset_media/' + encodeURIComponent(hash);

const selStyle: React.CSSProperties = {
  height: 18, fontSize: 9.5, color: 'rgba(255,255,255,0.6)', background: '#1b1b1e',
  border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 4, padding: '0 2px',
  outline: 'none', cursor: 'pointer', minWidth: 0,
};

export const VidAssets: React.FC<{ vid: VidController; sel?: string | null; onSel?: (s: InspectSel | null) => void; onActivate?: () => void }> = ({ vid, sel, onSel, onActivate }) => {
  const { project: p } = vid;
  // 这份文档内嵌的图（Video / Image 两档的唯一数据源）。页面按整份清单播报，这里按活跃文档取桶 ——
  // 切 tab 那一瞬读到的就是目标文档自己那份，不必等页面重播。
  const doc = useDocAssets();
  const [over, setOver] = useState(false);
  // 起手看文档自己的模式：image 模式落到它那套工作面，video 模式落到 Layer 段。之后跟着用户的手 ——
  // 切文档不把人从自己选的档上拽走。
  const [scope, setScope] = useState<Scope>(() => (p.mode === 'video' ? 'video' : 'image'));
  /** 这一档说的是"文档内嵌的图"（字节在 .cud 里，不是仓库里的一堆）。 */
  const docScope = scope === 'video' || scope === 'image';
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
    window.addEventListener('pointerdown', close);
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('wheel', close);
      window.removeEventListener('keydown', key);
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
    if (docScope) return;
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

  return (
    <div
      onDragOver={e => { const ts = e.dataTransfer.types; if (ts.includes(STAGING_ITEM_TYPE) || ts.includes(ASSET_ITEM_TYPE) || Array.from(ts).includes('Files')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(o => (o ? false : o))}
      onDrop={onDrop}
      style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#141416', minWidth: 0, overflow: 'hidden' }}
    >
      {/* 第一行：作用域。三档 = 公用库 + 这份文档的两种用途（层段 / image 工作面）。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '5px 6px 3px', flexShrink: 0 }}>
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
        {!docScope && (
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
        {!docScope && (
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
          padding: 8, display: 'grid', gap: 6, alignContent: 'start',
          gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))',
          background: over ? 'rgba(10,132,255,0.06)' : 'transparent',
        }}
      >
        {total === 0 && (
          <div style={{ gridColumn: '1 / -1', padding: 16, fontSize: 11, color: 'rgba(255,255,255,0.35)', textAlign: 'center', lineHeight: 1.8, whiteSpace: 'pre-line' }}>
            {docPending ? 'Reading this document…'
              : docScope && scope === 'video' ? 'Nothing in this document yet.\nMedia you drop on the timeline shows up here as a reference;\nimages on Layer segments are embedded.'
                : docScope ? 'This document has no images yet.\nLayers, guidances and the staging pool show up here.'
                  : busy ? 'Loading…'
                    : 'The library is empty.\nDrop files here or use ＋ to import images.'}
          </div>
        )}

        {/* 引用件：时间线在播的视频 / 音频。字节不在 .cud 里（只存哈希与 URL），所以卡上写 REF
            而不是 IN DOC —— 仓库里那份字节没了，这份文档就跟着废。 */}
        {clipItems.map(c => {
          const payload: InspectSel = {
            key: c.key, name: c.name, kind: c.kind, src: c.missing ? '' : c.url,
            duration: c.duration, hasAudio: c.hasAudio,
            origin: 'timeline', hash: c.asset || c.play,
          };
          return (
            <Card
              key={c.key}
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
                // 拖回时间线：它**已经是**这份工程的资产了，所以带上资产 id —— 落点直接
                // placeAsset（复用这一件，不会再去 importSource 一趟）。图片落点另认 x-asset。
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
                // 缺字节的回形针 = 同一件事的快路（不用右键也能接）。丢了的接回来，
                // 链错了也能换 —— 挑到不一样的字节时会先问一句（见 onLinkPick）。
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
          );
        })}

        {docItems.map(g => {
          const key = 'd:' + g.hash;
          const url = docUrlOf(g.hash);
          // 库副本没了（用户手删过 data/assets）→ 标 MISSING。字节其实还在 .cud 里，下一次保存
          // 会把它写回仓库 —— 所以这里不给 relink（那会把一张同样的图再接一遍），只说实话。
          const payload: InspectSel = {
            key, name: g.name, kind: 'image', src: url, duration: 0, hasAudio: null,
            origin: scope === 'video' ? 'layer segment' : 'document', hash: g.hash,
          };
          return (
            <Card
              key={key}
              selected={multiSel.has(key) || (multiSel.size === 0 && sel === key)}
              onDoubleClick={onActivate}
              onClick={e => cardClick(e, key, payload)}
              it={{
                name: g.name, kind: 'image', src: url, duration: 0, hasAudio: null,
                poster: url,
                byteFrom: 'doc',
                // 它在这份文档里干什么：图层像 / 指导卡 / 图池，以及（Video 档）属于哪一段。
                // 空 setKey 是"文档主栈"那一套（image 模式的图层，也常是 Layer 段接手前的壳）。
                origin: whereText(g, k => setNames.get(k) || (k === '' ? 'document' : 'Layer')),
                drag: {
                  [ASSET_ITEM_TYPE]: JSON.stringify({ id: g.hash, url, name: g.name, kind: 'image', asset: g.hash }),
                },
              }}
            />
          );
        })}

        {/* 时间线引用了、却没有资产行的哈希（老工程 / 库件被删后片段还留着）。它也是一条引用 ——
            同样能链接资产（接回原件或换绑），所以右键菜单照给。 */}
        {orphanMissing.map(h => (
          <Card
            key={'m:' + h}
            onContextMenu={e => openCardMenu(e, 'm:' + h, { asset: h }, 'missing · ' + h.slice(0, 8))}
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
        ))}

        {storeItems.map(s => {
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
          return (
            <Card
              key={key}
              selected={multiSel.has(key) || (multiSel.size === 0 && sel === key)}
              onDoubleClick={onActivate}
              onClick={e => cardClick(e, key, payload)}
              it={{
                name: label, kind: s.kind, src: s.kind === 'image' ? s.url : play, duration: s.duration, hasAudio: s.hasAudio,
                poster: s.kind === 'image' ? (s.thumb || s.url) : null,
                byteFrom: 'store',
                origin: s.origin || 'library',
                usedBy: usedBy(s.hash, s.playHash, play, s.url),
                drag: (() => {
                  const out: Record<string, string> = {
                    [ASSET_ITEM_TYPE]: JSON.stringify({ id, url: play, name: label, kind: s.kind, asset: s.hash, play: s.playHash }),
                  };
                  // 老载荷只给音视频：图片落到时间线上没有片段可落，发出去只会让落点白忙一趟。
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
          );
        })}
      </div>

      {/* 底栏：一句实话 —— 现在这一档有多少件、是什么在喂它。 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', flexShrink: 0,
        borderTop: '0.5px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.015)',
      }}>
        <span
          title={(err || listErr) || undefined}
          style={{
            fontSize: 9.5, color: (err || listErr) ? '#ff8a80' : 'rgba(255,255,255,0.32)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
          {busy && !docScope ? 'loading…' : err ? err : listErr ? listErr
            : `${total} ${total === 1 ? 'item' : 'items'} · ${scope === 'library' ? 'library' : 'in this document'}`}
        </span>
        {multiSel.size > 0 && (
          <span style={{ fontSize: 9, color: '#3b9dff', flexShrink: 0, whiteSpace: 'nowrap' }}>
            {docScope ? `${multiSel.size} selected` : `${multiSel.size} selected · Del to delete from the library`}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {docScope ? (
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
            left: Math.max(8, Math.min(menu.x, window.innerWidth - 240)),
            top: Math.max(8, Math.min(menu.y, window.innerHeight - 96)),
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
        document.body,
      )}
    </div>
  );
};
