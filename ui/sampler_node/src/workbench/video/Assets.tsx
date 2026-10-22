import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  type VidAsset, type VidController, fmtTime, isAudioName, isVideoName, addAsset, newVidId, removeAsset,
} from './model';
import { probeMedia } from './audio';
import { ingestFile } from './ingest';
import { ensureFrame, ensureWaveform, frameBackend } from './previews';

// ── Assets 窗（资产库）───────────────────────────────────────────────────────────────────────
// 时间线的素材都住这里：拖图池条目 / 本地文件进来 = 收一件资产（同 src 只留一份）；把资产卡
// 拖到 Tracks 的某条轨上 = 落一段引用它的片段 —— 同一源泉多次复用也只是多几段引用，不复制数据。
// 资产跟着 VidProject 持久化（blob: 的本地图活不过刷新，读档时自会剪掉）。

const STAGING_ITEM_TYPE = 'application/x-blend-staging';
/** 全局资产拖到轨道上带的载荷：不是工程里的资产 id（它还没入库），是那件货的 URL + 名字。
 *  落定时走 Timeline 的 importSource —— 先入本工程的资产库，再落一段引用它的片段。 */
export const GLOBAL_ITEM_TYPE = 'application/x-vid-global';

const rowBtn: React.CSSProperties = {
  flexShrink: 0, width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'none', border: 'none', borderRadius: 4, color: 'rgba(255,255,255,0.35)', cursor: 'pointer', padding: 0,
};

// ── 全局资产（Global Assets）─────────────────────────────────────────────────────────────────
// 节点那一份共享素材库（data/assets/，**不是**任何工程的私有媒体库）：跨文档共用，不随 .cud 走。
// 这一窗默认只列本工程的资产；底栏那颗地球开关打开才把这一份接在后面（只读 —— 加货是节点的事，
// 拖上轨道 / 点 + 时才按"同 src 认领"收进本工程）。清单与字节都走后端的 /api/global_*。
export type GlobalAsset = {
  /** 盘上的文件名（内容哈希名，与节点写下的那份同名）。 */
  name: string;
  /** 可播 URL：/api/global_media/<name>。 */
  url: string;
  kind: 'image' | 'video' | 'audio';
  size: number;
  mtime: number;
  /** 有没有音轨（ffprobe 探的）。`null` = 探不到 —— 不画 AUD 角标，不猜。 */
  hasAudio: boolean | null;
  /** 时长（s）。悬停扫片按"指针位置 → 时刻"取格要它；图片恒 0。 */
  duration: number;
};

/** 地球：Global 开关的记号 —— 一圈经线 + 一条赤道，开着的时候点亮。 */
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

/** 卡片缩略图：视频 = 首帧（后端有 ffmpeg 就取落盘帧，没有就客户端抓一张）；
 *  图片 = 它自己；音频 = 整段波形（有就画，没有留音符图标）。 */
function useThumb(a: VidAsset): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (a.kind === 'audio') {
      if (a.waveform) { setUrl(a.waveform); return () => { alive = false; }; }
      void ensureWaveform(a.src).then(u => { if (alive && u) setUrl(u); });
      return () => { alive = false; };
    }
    if (isImageAsset(a)) { setUrl(a.src); return () => { alive = false; }; }
    const media = a.src.startsWith('/api/vid_media/') ? (a.src.split('/').pop() || '') : '';
    void (async () => {
      const u = media && await frameBackend()
        ? `/api/vid_frame?f=${encodeURIComponent(media)}&t=0.00`
        : await ensureFrame(a.src, 0);
      if (alive && u) setUrl(u);
    })();
    return () => { alive = false; };
  }, [a.id, a.src, a.kind, a.waveform, a.name]);
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

const AssetCard: React.FC<{ a: VidAsset; onRemove: () => void }> = ({ a, onRemove }) => {
  const thumb = useThumb(a);
  const img = isImageAsset(a);
  return (
    <div
      draggable
      onDragStart={e => { e.dataTransfer.setData('application/x-vid-asset', a.id); e.dataTransfer.effectAllowed = 'copy'; }}
      title={`${a.name} — ${fmtTime(a.duration)} · drag onto a track to place a clip that references this asset`}
      style={{
        display: 'flex', flexDirection: 'column', minWidth: 0, borderRadius: 6,
        border: '0.5px solid rgba(255,255,255,0.1)', background: '#0f0f11', cursor: 'grab', userSelect: 'none',
      }}
    >
      <Thumb
        m={{ src: a.src, kind: img ? 'image' : a.kind, duration: a.duration, hasAudio: img ? null : a.hasAudio }}
        poster={thumb}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px 5px', minWidth: 0 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.82)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
        {!img && (
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.42)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{fmtTime(a.duration)}</span>
        )}
        <button
          title={'Remove asset 「' + a.name + '」 from the library (clips already on the timeline keep playing)'}
          onClick={onRemove}
          style={rowBtn}
        >
          <svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M3 3l6 6M9 3l-6 6" /></svg>
        </button>
      </div>
    </div>
  );
};

/** 全局资产卡片的缩略图：图片 = 它自己；视频 = 首帧（客户端抓一张）；音频 = 波形（有就画）。 */
function useGlobalThumb(g: GlobalAsset): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (g.kind === 'image') { setUrl(g.url); return () => { alive = false; }; }
    if (g.kind === 'audio') {
      void ensureWaveform(g.url).then(u => { if (alive && u) setUrl(u); });
      return () => { alive = false; };
    }
    // 视频的首帧：后端有 ffmpeg 就取落盘那张（/api/vid_frame，按文件+秒缓存；`d=global` 告诉
    // 后端去全局资产库那个落点取），没有就客户端自己抓一张 —— 与工程资产那条路完全一致。
    const media = g.url.startsWith('/api/global_media/') ? (g.url.split('/').pop() || '') : '';
    void (async () => {
      const u = media && await frameBackend()
        ? `/api/vid_frame?f=${encodeURIComponent(media)}&t=0.00&d=global`
        : await ensureFrame(g.url, 0);
      if (alive && u) setUrl(u);
    })();
    return () => { alive = false; };
  }, [g.url, g.kind]);
  return url;
}

/** 全局资产卡片：与工程资产同一张脸（缩略图 + 名 + 角标），只多两点 ——
 *  ① 角标带一圈"共享"的边框色；② 右下是 +（收进本工程）而不是 ✕（全局那份删不掉，
 *  它是节点的货，这一窗只有读的份）。拖到轨道上 = 直接落片段（落定时才入库）。 */
const GlobalCard: React.FC<{ g: GlobalAsset; onClaim: () => void }> = ({ g, onClaim }) => {
  const thumb = useGlobalThumb(g);
  const draggable = g.kind !== 'image';   // 图片不是可播素材，拖上轨道也没有片段可落
  return (
    <div
      draggable={draggable}
      onDragStart={e => {
        if (!draggable) return;
        e.dataTransfer.setData(GLOBAL_ITEM_TYPE, JSON.stringify({ url: g.url, name: g.name, kind: g.kind }));
        e.dataTransfer.effectAllowed = 'copy';
      }}
      title={draggable
        ? `${g.name} — global asset · drag onto a track to place a clip (it joins this project's assets)`
        : `${g.name} — global image asset (read-only here)`}
      style={{
        display: 'flex', flexDirection: 'column', minWidth: 0, borderRadius: 6,
        border: '0.5px solid rgba(10,132,255,0.22)', background: '#0f0f11',
        cursor: draggable ? 'grab' : 'default', userSelect: 'none',
      }}
    >
      <Thumb
        m={{ src: g.url, kind: g.kind, duration: g.duration, hasAudio: g.kind === 'audio' ? true : g.hasAudio }}
        poster={thumb}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px 5px', minWidth: 0 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.82)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</span>
        {draggable && g.duration > 0 && (
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.42)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{fmtTime(g.duration)}</span>
        )}
        {draggable && (
          <button
            title={'Claim 「' + g.name + '」 into this project\'s assets — then it can be placed from here even with Global off'}
            onClick={onClaim}
            style={rowBtn}
          >
            <svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M6 2.5v7M2.5 6h7" /></svg>
          </button>
        )}
      </div>
    </div>
  );
};

export const VidAssets: React.FC<{ vid: VidController }> = ({ vid }) => {
  const { project: p } = vid;
  const [over, setOver] = useState(false);
  // 全局资产：开关一开才去问后端要清单（这一窗默认不碰那份共享库，白跑一趟没必要）。
  const [showGlobal, setShowGlobal] = useState(false);
  const [globals, setGlobals] = useState<GlobalAsset[] | null>(null);
  const [gLoading, setGLoading] = useState(false);
  // 每次打开都重问一遍（就是一次 listdir + stat，很便宜）—— 节点刚落进库里的货，下一次打开
  // 就能看见；关掉就把清单丢掉，不留过期的副本。
  useEffect(() => {
    if (!showGlobal) { setGlobals(null); setGLoading(false); return; }
    let alive = true;
    setGLoading(true);
    fetch('/api/global_assets')
      .then(r => r.json())
      .then(d => { if (alive) setGlobals(Array.isArray(d?.assets) ? d.assets : []); })
      .catch(() => { if (alive) setGlobals([]); })
      .finally(() => { if (alive) setGLoading(false); });
    return () => { alive = false; };
  }, [showGlobal]);

  // 收一件全局资产进本工程：时长与音轨**后端清单里已经有了**（ffprobe 探过），不用在浏览器里
  // 再探一遍 —— 点 + 就是立刻入库，同 src 只留一份（`addAsset` 自己认领）。
  const claimGlobal = (g: GlobalAsset) => {
    if (g.kind === 'image') return;
    vid.update(proj => addAsset(proj, {
      id: newVidId('as'), name: g.name, src: g.url, origin: 'file',
      kind: g.kind === 'audio' ? 'audio' : 'video',
      duration: g.duration, hasAudio: g.hasAudio === true,
    }), 'Add global asset');
  };

  // 收一件资产。本地文件：字节 POST 给后端 ffmpeg 入库（持久 URL，见 ingest.ts）——
  // 后端没有 ffmpeg 时回退前端探测 + blob:（活不过刷新，读档自会剪掉）。
  // 图池条目：src 是 base64 图片，走前端探测（图片咬不动 = no-op）。
  const collectFile = async (f: File) => {
    const ing = await ingestFile(f);
    if (ing) {
      vid.update(proj => addAsset(proj, {
        id: newVidId('as'), name: ing.name, src: ing.src, origin: 'file',
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

  const collectSource = async (src: string, name: string) => {
    const info = await probeMedia(src, isAudioName(name) ? 'audio' : 'video');
    if (!info) return;
    vid.update(proj => addAsset(proj, {
      id: newVidId('as'), name, src, origin: 'staging',
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
    for (const f of Array.from(e.dataTransfer.files || [])) {
      const ok = f.type.startsWith('video/') || f.type.startsWith('audio/') || isVideoName(f.name) || isAudioName(f.name);
      if (!ok) continue;
      void collectFile(f);
    }
  };

  return (
    <div
      onDragOver={e => { const ts = e.dataTransfer.types; if (ts.includes(STAGING_ITEM_TYPE) || Array.from(ts).includes('Files')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(o => (o ? false : o))}
      onDrop={onDrop}
      style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#141416', minWidth: 0, overflow: 'hidden' }}
    >
      {/* 头一条：入库提示。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '0.5px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
        <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.45)', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          Drag videos/audio here — then drag cards onto Tracks
        </span>
      </div>

      {/* 资产卡片：卡片可拖（application/x-vid-asset），✕ 扔掉（时间线里已落地的片段不受影响）。 */}
      <div style={{
        flex: 1, minHeight: 0, overflow: 'auto', scrollbarWidth: 'thin',
        padding: 8, display: 'grid', gap: 6, alignContent: 'start',
        gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))',
        background: over ? 'rgba(10,132,255,0.06)' : 'transparent',
      }}>
        {p.assets.length === 0 && (
          <div style={{ gridColumn: '1 / -1', padding: 16, fontSize: 11, color: 'rgba(255,255,255,0.35)', textAlign: 'center', lineHeight: 1.8 }}>
            No assets yet.<br />Drop video/audio files here, or drag items in from Staging.
          </div>
        )}
        {p.assets.map(a => (
          <AssetCard key={a.id} a={a} onRemove={() => vid.update(proj => removeAsset(proj, a.id))} />
        ))}

        {/* 全局资产：**接在本工程资产之后**，一整行分隔 + 自己那一段卡片。 */}
        {showGlobal && (
          <>
            <div style={{
              gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 6,
              marginTop: 2, paddingTop: 6, borderTop: '0.5px solid rgba(255,255,255,0.1)',
              fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5, color: 'rgba(10,132,255,0.75)',
            }}>
              GLOBAL · {globals ? globals.length : '…'}
              <span style={{ flex: 1, fontSize: 9, fontWeight: 400, letterSpacing: 0, color: 'rgba(255,255,255,0.3)' }}>
                {gLoading ? 'loading…' : 'shared library — drag onto a track to claim it here'}
              </span>
            </div>
            {globals && globals.length === 0 && !gLoading && (
              <div style={{ gridColumn: '1 / -1', padding: '6px 0 12px', fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
                The shared asset library is empty.
              </div>
            )}
            {globals?.map(g => (
              <GlobalCard key={g.url} g={g} onClaim={() => claimGlobal(g)} />
            ))}
          </>
        )}
      </div>

      {/* 底栏：Global Assets Include —— 一颗地球，开着就点亮。说明全在 tooltip 里（这里不写字）。 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', flexShrink: 0,
        borderTop: '0.5px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.015)',
      }}>
        <button
          title={showGlobal
            ? 'Global Assets Include — on. The shared asset library (data/assets) is listed below this project\'s assets. Click to hide it.'
            : 'Global Assets Include — off. Click to also list the shared asset library (data/assets) below this project\'s assets.'}
          onClick={() => setShowGlobal(v => !v)}
          style={{
            width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '0.5px solid ' + (showGlobal ? 'rgba(10,132,255,0.55)' : 'rgba(255,255,255,0.12)'),
            borderRadius: 5, padding: 0, cursor: 'pointer', flexShrink: 0,
            background: showGlobal ? 'rgba(10,132,255,0.16)' : 'transparent',
            color: showGlobal ? '#3b9dff' : 'rgba(255,255,255,0.42)',
          }}
        >
          <GlobeIcon size={14} />
        </button>
        <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.32)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {showGlobal ? (globals ? `${globals.length} global` : 'loading…') : 'project only'}
        </span>
      </div>
    </div>
  );
};
