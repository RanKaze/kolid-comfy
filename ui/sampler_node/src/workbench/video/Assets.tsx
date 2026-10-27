import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InspectSel } from './Inspector';
import {
  type VidAsset, type VidController, fmtTime, isAudioName, isVideoName, addAsset, newVidId, removeAsset,
} from './model';
import { probeMedia } from './audio';
import { assetsTick, subscribeAssets } from './assetsTick';
import { ingestFile } from './ingest';
import { ensureFrame, ensureWaveform } from './previews';

// ── Assets 窗（资产库 = 唯一的家）────────────────────────────────────────────────────────────
// 这一窗是资产仓库（data/assets/）唯一的脸：**所有字节都在这里** —— 图层用的图、图池里的图、
// run/processor 的产出、特效贴图、视频与音频，全都是一条记录。staging 只是它上面的一个有序
// 视图（A2），不再是另一个仓库。
//
// 四档作用域（顶部那条 segmented）：
//   All     = 仓库里的一切
//   Library = 库成员（跨文档共享：Assets 节点的产出 + 用户主动入库的货）
//   Project = 本工程自己的资产（时间线在用的那些，跟着 VidProject 走）
//   Session = 仓库里有、却没有库成员身份的临时产物（run / processor 的中间图）
//
// 拖出去：卡片带 `application/x-asset` = `{id, url, name, kind}`；本工程资产另带老的
// `application/x-vid-asset`（时间线按 asset id 认）；旧的 `application/x-vid-global` 也一起发一份，
// 免得还有哪个落点只认它（A2 之后可以只留 x-asset）。

const STAGING_ITEM_TYPE = 'application/x-blend-staging';
/** 统一载荷：仓库资产拖到任何落点都带这一份。 */
export const ASSET_ITEM_TYPE = 'application/x-asset';
/** 老载荷：全局资产落到轨道上时带 URL + 名字（时间线拿它 importSource）。仍然发，兼容老落点。 */
export const GLOBAL_ITEM_TYPE = 'application/x-vid-global';

export type Scope = 'all' | 'library' | 'project' | 'session';

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

// 图片资产：src 是 data:image/...（图池条目）或扩展名是图片。视频之外的一种"长相"。
const IMG_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)(?:[?#]|$)/i;
const isImageAsset = (a: VidAsset): boolean =>
  a.src.startsWith('data:image/') || IMG_EXT.test(a.name) || IMG_EXT.test(a.src);

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
  /** 字节在哪：`store` 只在仓库；`doc` 某份文档里也内嵌了一份（A4 之后才可能出现）。 */
  byteFrom?: 'store' | 'doc' | 'missing';
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
export const Card: React.FC<{ it: CardItem; selected?: boolean; onClick?: (e: React.MouseEvent) => void; onDoubleClick?: () => void }> = ({ it, selected, onClick, onDoubleClick }) => {
  const poster = useCardThumb(it.kind, it.src, it.poster);
  const [over, setOver] = useState(false);
  const badge = it.byteFrom ? BYTE_BADGE[it.byteFrom] : null;
  return (
    <div
      draggable={!!it.drag}
      onClick={e => onClick?.(e)}
      onDoubleClick={onDoubleClick}
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
  { id: 'all', label: 'All', title: 'Everything in the asset store' },
  { id: 'library', label: 'Library', title: 'Library members — shared across documents' },
  { id: 'project', label: 'Project', title: "This project's own assets — what the timeline plays" },
  { id: 'session', label: 'Session', title: 'In the store but not in the library — run / processor leftovers' },
];

const selStyle: React.CSSProperties = {
  height: 18, fontSize: 9.5, color: 'rgba(255,255,255,0.6)', background: '#1b1b1e',
  border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 4, padding: '0 2px',
  outline: 'none', cursor: 'pointer', minWidth: 0,
};

export const VidAssets: React.FC<{ vid: VidController; sel?: string | null; onSel?: (s: InspectSel | null) => void; onActivate?: () => void }> = ({ vid, sel, onSel, onActivate }) => {
  const { project: p } = vid;
  const [over, setOver] = useState(false);
  const [scope, setScope] = useState<Scope>('all');
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
  const [multiSel, setMultiSel] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);       // Shift 连选的起点(最后一次普通点的那张)
  const [renaming, setRenaming] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null); // Del/Ctrl+A 只在网格握焦点时接手,不抢全局

  // ── 选中态 → Inspector ── 点卡片选中(再点同一张不切换),Inspector 窗照这份载荷放大看。
  // 选中的卡被删掉/仓库条目消失 → 撤选。判**全量**两份列表(工程资产 + 仓库),与 scope/类型
  // 过滤无关:过滤只是"这档里看不见",不是"不在了"。
  useEffect(() => {
    if (!sel) return;
    const keys = new Set<string>([
      ...p.assets.map(a => 'p:' + a.id),
      ...(store ?? []).map(s => 's:' + (s.hash || s.name)),
    ]);
    if (!keys.has(sel)) onSel?.(null);
  }, [sel, p.assets, store, onSel]);

  // 多选集里指向已消失条目(删除 / 仓库清单刷新)的键,静默清掉 —— 与上面主选的守卫同一口径。
  useEffect(() => {
    setMultiSel(prev => {
      if (!prev.size) return prev;
      const alive = new Set<string>([
        ...p.assets.map(a => 'p:' + a.id),
        ...(store ?? []).map(s => 's:' + (s.hash || s.name)),
      ]);
      const next = new Set([...prev].filter(k => alive.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [p.assets, store]);

  // ── 缺失 / relink（A5）─────────────────────────────────────────────────────────────────────
  // `vid.missing` 是宿主问过仓库的结论（工程引用的哈希里没字节的那些）。卡片挂 MISSING，
  // 点回形针挑本地文件 → `vid.relink` 重新入库；哈希对不上会被拒（那说明挑错了文件）。
  const gone = useCallback((a: VidAsset) =>
    !!((a.asset && vid.missing.has(a.asset)) || (a.play && vid.missing.has(a.play))), [vid.missing]);
  const relinkRef = useRef<HTMLInputElement | null>(null);
  const relinkForRef = useRef<string | null>(null);
  const startRelink = (hash: string | undefined) => {
    if (!hash) return;
    relinkForRef.current = hash;
    setErr(null);
    relinkRef.current?.click();
  };
  const onRelinkPick = async (f: File | undefined) => {
    const hash = relinkForRef.current;
    relinkForRef.current = null;
    if (!f || !hash) return;
    const r = await vid.relink(hash, f);
    if (!r.ok) setErr(r.error || 'relink failed');
    bump();          // 入库可能新增了一件货（影不影响 relink 都重拉一次清单）
  };

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

  // 谁在用它：片段按 src 认资产（模型里片段只记 src，不记资产 id）。
  const clipsBySrc = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of p.clips) if (c.src) m.set(c.src, (m.get(c.src) || 0) + 1);
    return m;
  }, [p.clips]);
  const usedBy = (src: string) => {
    const n = clipsBySrc.get(src) || 0;
    return n ? `${n} clip${n > 1 ? 's' : ''}` : '';
  };

  const needle = q.trim().toLowerCase();
  const hits = (name: string, extra?: string) =>
    !needle || name.toLowerCase().includes(needle) || (extra || '').toLowerCase().includes(needle);

  const storeItems = (store || []).filter(s => {
    if (scope === 'project') return false;
    // 老服务没有 inLibrary 字段 ⇒ 当作库成员（宁可多显示，也别把整库藏起来）。
    if (scope === 'library' && s.inLibrary === false) return false;
    if (scope === 'session' && s.inLibrary !== false) return false;
    if (kind !== 'all' && s.kind !== kind) return false;
    return hits(s.displayName || s.name, s.hash);
  });
  // Project 是**本工程资产表**（可能指向 vid_media / 图池 URL）；All/Library/Session 只列仓库。
  // 一件货被收进工程后又出现在 All 里是正常的（同一个字节的两条身份），但**同一个视图里**
  // 不能因为"它既在工程又在库"就画两遍。
  const projectItems = scope !== 'project' ? [] : p.assets.filter(a => {
    const k = isImageAsset(a) ? 'image' : a.kind;
    if (kind !== 'all' && k !== kind) return false;
    return hits(a.name);
  });
  // 时间线上引用了、但资产表里没有对应行（老工程/库件被删后片段还留着）的缺失哈希 ——
  // 也得给一张卡，否则"3 missing"却找不到可以 relink 的那一件。
  const coveredHashes = new Set<string>();
  for (const a of p.assets) { if (a.asset) coveredHashes.add(a.asset); if (a.play) coveredHashes.add(a.play); }
  const orphanMissing = scope !== 'project' || kind === 'image' ? []
    : [...vid.missing].filter(h => !coveredHashes.has(h));
  const total = storeItems.length + projectItems.length + orphanMissing.length;

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

  // 渲染序的全量键表(Shift 连选按它取范围)。工程档只有工程资产 + 孤儿缺失;其余档只有仓库条目。
  const visibleKeys = [
    ...projectItems.map(a => 'p:' + a.id),
    ...orphanMissing.map(h => 'm:' + h),
    ...storeItems.map(s => 's:' + (s.hash || s.name)),
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

  // Del:两类键各走各的删除路。工程资产 = 出工程(一次可撤销的工程改动,不弹确认);
  // 仓库条目 = 出仓库(字节真删,整批一次确认)。孤儿缺失键不可选,天然走不到。
  const deleteSelected = async () => {
    const keys = [...multiSel];
    const pIds = keys.filter(k => k.startsWith('p:')).map(k => k.slice(2));
    const sKeys = keys.filter(k => k.startsWith('s:')).map(k => k.slice(2));
    if (pIds.length) {
      vid.update(proj => {
        let n = proj;
        for (const id of pIds) n = removeAsset(n, id);
        return n;
      }, pIds.length > 1 ? `Remove ${pIds.length} assets` : 'Remove asset');
    }
    if (sKeys.length) {
      const items = sKeys
        .map(id => (store || []).find(s => (s.hash || s.name) === id))
        .filter((s): s is StoreAsset => !!s && !!s.hash);
      if (items.length) {
        const ok = window.confirm(items.length === 1
          ? `Delete「${items[0].displayName || items[0].name}」from the asset store?\n\nThe file and its record are removed. ` +
            `Timeline clips that reference it are marked MISSING until you relink the original file.`
          : `Delete ${items.length} assets from the asset store?\n\nThe files and their records are removed. ` +
            `Timeline clips that reference them are marked MISSING until you relink the originals.`);
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
    if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (!multiSel.size) return;
      e.preventDefault();
      void deleteSelected();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      setMultiSel(new Set(visibleKeys.filter(k => !k.startsWith('m:'))));   // 孤儿缺失卡不可选
      anchorRef.current = null;
    } else if (e.key === 'Escape') {
      setMultiSel(new Set());
    }
  };

  // 双击名字 → 原地改名。仓库条目走 /api/asset_update(名字在库表里,跨文档共享);
  // 工程资产改工程表(VidAsset.name)—— 时间线上已有片段的名字是落位时抄走的,不受影响。
  const commitStoreRename = async (id: string, next: string) => {
    setRenaming(null);
    const r = await fetch('/api/asset_update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: next }),
    }).then(x => x.json()).catch(() => null);
    if (!r?.ok) setErr(r?.error || 'rename failed');
    bump();
  };
  const commitProjectRename = (id: string, next: string) => {
    setRenaming(null);
    vid.update(proj => ({ ...proj, assets: proj.assets.map(a => a.id === id ? { ...a, name: next } : a) }), 'Rename asset');
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
      {/* 第一行：作用域。四档 = 同一张表的三条过滤线 + 本工程那一份。 */}
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

      {/* 第二行：种类 + 搜索 + 导入。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px 5px', borderBottom: '0.5px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
        <select value={kind} onChange={e => setKind(e.target.value as 'all' | 'image' | 'video' | 'audio')} style={selStyle}>
          <option value="all">All kinds</option>
          <option value="image">Images</option>
          <option value="video">Video</option>
          <option value="audio">Audio</option>
        </select>
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
        {/* relink 的文件入口：Project 档卡片上的回形针点它（同一时刻只为一个哈希挑文件）。 */}
        <input
          ref={relinkRef}
          type="file"
          accept="video/*,audio/*"
          style={{ display: 'none' }}
          onChange={e => {
            const f = e.target.files?.[0];
            e.target.value = '';
            void onRelinkPick(f);
          }}
        />
      </div>

      {/* 缺失横幅：工程引用的字节不在仓库里了。All/Library/Session 不列工程资产，所以这里给个入口。 */}
      {vid.missing.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', flexShrink: 0,
          background: 'rgba(255,69,58,0.12)', borderBottom: '0.5px solid rgba(255,69,58,0.35)',
        }}>
          <span style={{ fontSize: 9.5, fontWeight: 800, color: '#ff6b60', flexShrink: 0, whiteSpace: 'nowrap' }}>
            {vid.missing.size} missing
          </span>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {scope === 'project' ? 'Pick the original file with the paperclip on a card.' : 'The timeline references bytes that are gone from the store.'}
          </span>
          {scope !== 'project' && (
            <button
              onClick={() => setScope('project')}
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
          <div style={{ gridColumn: '1 / -1', padding: 16, fontSize: 11, color: 'rgba(255,255,255,0.35)', textAlign: 'center', lineHeight: 1.8 }}>
            {busy ? 'Loading…'
              : scope === 'project' ? 'This project has no assets yet.\nDrop video/audio here, or claim one from Library.'
                : scope === 'session' ? 'No leftover assets — everything in the store belongs to the library.'
                  : 'Nothing here yet.\nDrop files here or use ＋ to import images.'}
          </div>
        )}

        {projectItems.map(a => {
          const img = isImageAsset(a);
          const k = img ? 'image' : a.kind;
          const miss = gone(a);
          const key = 'p:' + a.id;
          const payload: InspectSel = {
            key, name: a.name, kind: k,
            // 播放优先仓库地址(同一份字节,比 src 里的 objectURL 靠得住);缺字节退回 src。
            src: a.asset && !miss ? '/api/asset_media/' + encodeURIComponent(a.asset) : a.src,
            duration: a.duration, hasAudio: img ? null : a.hasAudio,
            origin: a.origin, hash: a.asset,
          };
          return (
            <Card
              key={key}
              selected={multiSel.has(key) || (multiSel.size === 0 && sel === key)}
              onDoubleClick={onActivate}
              onClick={e => cardClick(e, key, payload)}
              it={{
                name: a.name, kind: k, src: a.src, duration: a.duration, hasAudio: img ? null : a.hasAudio,
                byteFrom: miss ? 'missing' : 'store', origin: a.origin, usedBy: usedBy(a.src),
                drag: (() => {
                  // 图卡也要能拖走（Staging / Layers 两处都收 `application/x-asset`）；时间线那枚老载荷
                  // 只给音视频（图片没有片段可落）。有哈希就指仓库地址 —— 同一份字节，跨 iframe 也读得到；
                  // 仓库里缺了就退回资产自己的 src（A4 内嵌的那份 bytes 还在，别把一张活图判死）。
                  const url = a.asset && !miss
                    ? '/api/asset_media/' + encodeURIComponent(a.asset)
                    : a.src;
                  const out: Record<string, string> = {
                    [ASSET_ITEM_TYPE]: JSON.stringify({ id: a.id, url, name: a.name, kind: k, asset: a.asset, play: a.play }),
                  };
                  if (!img) out['application/x-vid-asset'] = a.id;
                  return out;
                })(),
                renaming: renaming === key,
                onNameDoubleClick: () => setRenaming(key),
                onRenameCommit: next => commitProjectRename(a.id, next),
                onRenameCancel: () => setRenaming(null),
                actions: miss ? (
                  <button
                    title={'Relink「' + a.name + '」— pick the original file; its bytes must hash to ' + (a.asset || a.play || '').slice(0, 8) + '…'}
                    onClick={() => startRelink(a.asset || a.play)}
                    style={{ ...rowBtn, color: '#ff6b60' }}
                  >
                    <ClipIcon />
                  </button>
                ) : undefined,
              }}
            />
          );
        })}

        {orphanMissing.map(h => (
          <Card
            key={'m:' + h}
            it={{
              name: 'missing · ' + h.slice(0, 8), kind: 'video', src: '', duration: 0, hasAudio: null,
              byteFrom: 'missing', origin: 'referenced by the timeline',
              actions: (
                <button
                  title={'Relink the bytes for ' + h.slice(0, 8) + '… — pick the original file; the hash must match'}
                  onClick={() => startRelink(h)}
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
            origin: s.origin || (s.inLibrary === false ? 'session' : 'library'),
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
                origin: s.origin || (s.inLibrary === false ? 'session' : 'library'),
                usedBy: usedBy(play),
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

      {/* 底栏：一句实话 —— 现在这一档有多少件、库成员多少。 */}
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
          {busy ? 'loading…' : err ? err : listErr ? listErr : `${total} ${total === 1 ? 'asset' : 'assets'} · ${scope}`}
        </span>
        {multiSel.size > 0 && (
          <span style={{ fontSize: 9, color: '#3b9dff', flexShrink: 0, whiteSpace: 'nowrap' }}>
            {multiSel.size} selected · Del to {scope === 'project' ? 'remove' : 'delete'}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {store && (
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.26)', flexShrink: 0 }}>
            {store.filter(s => s.inLibrary !== false).length} in library
          </span>
        )}
      </div>
    </div>
  );
};
