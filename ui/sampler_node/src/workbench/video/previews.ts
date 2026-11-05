// ── 片段预览的生成与兜底 ────────────────────────────────────────────────────────────────────
// 时间线上每段片段都要有点"长相"：视频段画头/尾两帧，音频段画自己那一窗波形。两条路拿图：
//  1. 后端有 ffmpeg —— 入库时就把整段波形 PNG 生成好（挂在 VidAsset.waveform），首尾帧走
//     /api/vid_frame 按需取（按文件+秒缓存）。快，且服务重启后依然在盘上。
//  2. 后端没有（旧服务还没重启 / 环境里没 ffmpeg）—— 不能就这么空着：浏览器自己也能干。
//     * 波形：WebAudio 解出 AudioBuffer → 算包络 → canvas 出 PNG；
//     * 帧：<video> 静音 seek 到 t → drawImage → canvas 出 JPEG。
// 两条路都在内存里按 (src, t) 缓存，同一段不会被算第二遍。图池里的条目是 base64 图片，
// 解码器咬不动 → 返回 null，片段就退回纯色块，不折腾。

import { decodeAudio } from './audio';

// ── 一次只干一件 ── 同时开十几个 <video> 去解码会把页面拖垮，串成一条队慢慢来。
let chain: Promise<unknown> = Promise.resolve();
const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
  const p = chain.then(job, job);
  chain = p.catch(() => { /* keep the chain alive */ });
  return p;
};

// ── 抽条让路 ── 解码器是稀缺资源：用户正在拖游标时，主 <video> 的 seek 优先；
// **播放中**整个让位 —— 正播的 1080p60 每一帧都是解码任务，后台再怎么 fastSeek 都是抢。
// 后台抽条在每一帧之前看一眼闸：拖动期间挂起（停手 400ms 后继续），播放期间全程挂起。
let scrubBusyUntil = 0;
let decoderHeld = false;
export const markScrubActivity = (): void => {
  scrubBusyUntil = performance.now() + 400;
};
export const holdDecoder = (): void => { decoderHeld = true; };
export const releaseDecoder = (): void => { decoderHeld = false; };
const yieldToScrub = async (): Promise<void> => {
  while (decoderHeld || performance.now() < scrubBusyUntil) await new Promise(r => setTimeout(r, 80));
};

// ── 波形 ── 整段源的包络，一次算完；片段按自己的 offset/duration 在 CSS 上裁窗。
//  **不进 enqueue**：那条队是给隐藏 <video> 的 seek 排的（解码器独占）。波形走 WebAudio
//  的 decodeAudioData —— 另一条腿，跟抽条并行跑才快。排在抽条后面 = 波形成要等整条
//  缩略条抽完（几十格 fastSeek），这正是"音频轨的波形出来太慢"的根子。
const waveCache = new Map<string, Promise<string | null>>();

export const ensureWaveform = (src: string): Promise<string | null> => {
  let p = waveCache.get(src);
  if (!p) { p = renderWave(src); waveCache.set(src, p); }
  return p;
};

async function renderWave(src: string): Promise<string | null> {
  const buf = await decodeAudio(src);
  if (!buf || !buf.length) return null;
  const W = 1200, H = 96, COL = 2;                 // 每 2px 一根柱
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  if (!g) return null;
  const ch = buf.getChannelData(0);
  const cols = Math.max(1, Math.floor(W / COL));
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#30d158';
  for (let i = 0; i < cols; i++) {
    const a = Math.floor(i * ch.length / cols);
    const b = Math.min(ch.length, Math.floor((i + 1) * ch.length / cols));
    let mn = 0, mx = 0;
    for (let j = a; j < b; j++) { const v = ch[j]; if (v < mn) mn = v; if (v > mx) mx = v; }
    const y0 = (1 - mx) * H / 2;
    const y1 = (1 - mn) * H / 2;
    g.fillRect(i * COL, y0, COL - 0.6, Math.max(1, y1 - y0));
  }
  return cv.toBlob ? await new Promise<string | null>(res => {
    cv.toBlob(b => res(b ? URL.createObjectURL(b) : null), 'image/png');
  }) : cv.toDataURL('image/png');
}

// ── 缩略条（strip）── scrub / 裁剪要跟手，就不能每次都去 seek <video>：seek 是重活
//  （找关键帧 + 解码一整段 GOP），拖动中每帧来一次等于把解码器按在地上摩擦 —— "卡一下才跳、
//   跳完还顿两下"就是它。于是按源时长**均匀抽一条**：之后游标跳到哪、片段裁成什么样，
//   都只是换一个**索引**，零 seek、零解码。
//  两条硬规矩：
//   * **渐进发布** —— 客户端逐帧抽，每抽几格就把"半成品条"发出去（stripFrame 对任意长度
//     都能取最近一格）。长视频（1080p60 一分多钟）整条要抽几十秒，全有或全无的话那几十秒
//     里拖动就是冻结的；半成品几百毫秒就能跟手，后面边抽边变密。
//   * **格数自适应** —— 约每 0.5s 一格，封顶 96：太稀拖动看着跳，太密抽条太久。
const strips = new Map<string, string[]>();
/** 抽**完整**的源（渐进构建中的半成品不在里面）。静态预览（片段首/尾帧）只认它 ——
 *  半成品的数组长度每次发布都在变，stripFrame 的索引跟着重映射，画面会一直跳，
 *  直到整条抽完才稳。拖动中的替身图不受这条限制（要的就是"有就先用"）。 */
const stripsFull = new Set<string>();
const stripJobs = new Map<string, Promise<string[] | null>>();
const stripSubs = new Set<() => void>();

const notifyStrip = () => stripSubs.forEach(f => f());

/** 这条源要抽多少格：约每 0.33s 一格，[32, 160] —— 监视器替身图就靠它，太稀拖动看着跳。 */
const stripNFor = (d: number) => Math.max(32, Math.min(160, Math.round((d || 0) * 3)));

// ── 预热 ── 替身图的换图延迟不在取 URL，在**首次解码**。条一发布就把每格喂给 Image()
// （async 解码进缓存），之后拖动/跳转换格都是零延迟。但**一次一张、串行、给拖动让路**：
// 一口气塞 160 个请求会占满每域名 6 个连接，视频 seek 的 Range 请求被挤到队尾，
// 跳转反而变慢 —— 预热是锦上添花，不能抢主人的路。
const warmed = new Set<string>();
const warmQueue: string[] = [];
let warming = false;
const warmUrls = (urls: readonly string[]): void => {
  for (const u of urls) {
    if (warmed.has(u)) continue;
    warmed.add(u);
    warmQueue.push(u);
  }
  void pumpWarm();
};
const pumpWarm = async (): Promise<void> => {
  if (warming) return;
  warming = true;
  try {
    while (warmQueue.length) {
      const u = warmQueue.shift()!;
      await yieldToScrub();                  // 用户在拖游标？预热全程让路。
      const im = new Image();
      im.decoding = 'async';
      im.src = u;
      await new Promise<void>(r => {
        if (im.complete) { r(); return; }
        im.onload = () => r();
        im.onerror = () => r();
      });
    }
  } finally {
    warming = false;
  }
};

/** 同步读：这条源已经抽好的缩略条（还没抽好 = undefined；**渐进构建中 = 已到手的那些格**）。 */
export const peekStrip = (src: string): string[] | undefined => strips.get(src);

/** 这条源的条**抽完了**吗 —— 静态预览只认完整的条（见 stripsFull 的注释）。 */
export const stripComplete = (src: string): boolean => stripsFull.has(src);

/** 这一时刻在缩略条上最靠近的那一格。**同步** —— 组件渲染时就能拿到图，
 *  不等任何 Promise；条还没抽好就返回 undefined，调用方退回原来的法子。 */
export const stripFrame = (src: string, srcDuration: number, t: number): string | undefined => {
  const s = strips.get(src);
  if (!s || !s.length) return undefined;
  const d = Math.max(srcDuration, 0.001);
  const i = Math.round(Math.max(0, Math.min(t, d)) / d * (s.length - 1));
  return s[i];
};

/** 缩略条抽好（或新到一批）时敲一下订阅者（组件据此重渲）。 */
export const subscribeStrip = (fn: () => void): (() => void) => {
  stripSubs.add(fn);
  return () => { stripSubs.delete(fn); };
};

/** 要这条源的缩略条。已经抽过就直接命中（同步缓存），不然后台排队抽一次。 */
export const ensureStrip = (src: string, srcDuration: number): Promise<string[] | null> => {
  let p = stripJobs.get(src);
  if (!p) {
    const n = stripNFor(srcDuration);
    p = enqueue(() => buildStrip(src, srcDuration, n, partial => {
      // 渐进发布：半成品也进缓存 —— stripFrame 按数组长度取格，短条只是粗一点。
      if (partial.length) { strips.set(src, partial); warmUrls(partial); notifyStrip(); }
    })).then(urls => {
      if (urls && urls.length) { strips.set(src, urls); stripsFull.add(src); warmUrls(urls); notifyStrip(); }
      return urls;
    });
    stripJobs.set(src, p);
  }
  return p;
};

async function buildStrip(src: string, d: number, n: number,
  onPartial: (urls: string[]) => void): Promise<string[] | null> {
  const dur = Math.max(0, d || 0);
  // 三条伺服路都认：工程媒体库 `/api/vid_media/`、全局资产库 `/api/global_media/`
  // 与 Eagle 库 `/api/eagle_media/`（字节就地读，不复制）。后者的后端解析在 `_vid_media_path`。
  const isGlobal = src.startsWith('/api/global_media/');
  const local = src.startsWith('/api/vid_media/') || isGlobal || src.startsWith('/api/eagle_media/');
  const media = local ? (src.split('/').pop() || '') : '';
  // 后端在（有 ffmpeg）→ 请求整条落盘的缩略图。**但绝不空等**：后端一遍 ffmpeg 抽 96 帧
  // 1080p 要十几秒，这十几秒里用户已经在拖游标了 —— 所以客户端的 fastSeek 抽条**同时
  // 照跑**（谁先到先用，后端整条到了再整体替换）。渐进发布的意义就在这：任何时刻
  // 用户手上都有得用。
  if (media && await frameBackend()) {
    const times = Array.from({ length: n }, (_, i) => dur * i / (n - 1));
    const client = grabFrames(src, times, onPartial).then(u => { if (u) onPartial(u); return u; });
    try {
      const r = await fetch('/api/vid_strip?f=' + encodeURIComponent(media) + '&n=' + n
        + (isGlobal ? '&d=global' : ''));
      if (r.ok) {
        const j = await r.json() as { urls?: string[] };
        if (Array.isArray(j.urls) && j.urls.length >= 2) { onPartial(j.urls); return j.urls; }
      }
    } catch { /* 后端抽条没成：客户端那份已经在跑，等它 */ }
    return await client;
  }
  const times = Array.from({ length: n }, (_, i) => dur * i / (n - 1));
  return await grabFrames(src, times, onPartial);
}

/** 客户端抽条：一个隐藏 <video> 顺序 seek，落一帧就 drawImage 到小 canvas。
 *  每抽 3 格就把到手的部分发出去（onPartial）—— 长视频第一幅图几百毫秒就能用。
 *  seek 用 **fastSeek**（只落最近关键帧）：缩略条根本不要精确时刻，0.7s 一格的画面
 *  落在关键帧上毫无区别，但省掉了"从关键帧前向解码整个 GOP"的重活 —— 1080p60 的
 *  一个 GOP 就是上百帧，精确 seek 一次几百毫秒，几十格抽下来几十秒还跟真机上的
 *  拖动 seek 抢解码器；fastSeek 一次几毫秒，整条几秒抽完。 */
async function seekStripFrame(v: HTMLVideoElement, want: number): Promise<void> {
  await new Promise<void>(resolve => {
    const done = () => resolve();
    v.addEventListener('seeked', done, { once: true });
    setTimeout(done, 1500);
    try {
      const ff = (v as HTMLVideoElement & { fastSeek?: (t: number) => void }).fastSeek;
      if (typeof ff === 'function') ff.call(v, want);
      else v.currentTime = want;
    } catch { done(); }
  });
}

async function grabFrames(src: string, times: number[],
  onPartial?: (urls: string[]) => void): Promise<string[] | null> {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.src = src;
  try {
    const ready = new Promise<boolean>(resolve => {
      const ok = () => resolve(true);
      const bad = () => resolve(false);
      v.addEventListener('loadeddata', ok, { once: true });
      v.addEventListener('error', bad, { once: true });
      setTimeout(bad, 10000);
    });
    if (!await ready) return null;
    const limit = Number.isFinite(v.duration) && v.duration > 0 ? Math.max(0, v.duration - 0.06) : 0;
    const out: string[] = [];
    for (const t of times) {
      await yieldToScrub();                    // 用户在拖游标？解码器先让给主 <video>。
      const want = Math.max(0, Math.min(t, limit || t));
      await seekStripFrame(v, want);
      if (!v.videoWidth || !v.videoHeight) return out.length ? out : null;
      const w = 256, h = Math.max(1, Math.round(w * v.videoHeight / v.videoWidth));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const g = cv.getContext('2d');
      if (!g) return out.length ? out : null;
      g.drawImage(v, 0, 0, w, h);
      // **toBlob 不是 toDataURL**：JPEG 编码在 Chrome 里走线程池，主线程零占用；
      // toDataURL 是主线程同步编码，256px 一格十几毫秒，160 格就是拖动停歇后
      // "卡顿几下"的那几下 —— 逐帧顿挫全来自它。
      const blob = await new Promise<Blob | null>(r => cv.toBlob(r, 'image/jpeg', 0.7));
      if (!blob) return out.length ? out : null;
      out.push(URL.createObjectURL(blob));
      // 每抽 2 格发一次半成品：拖动几百毫秒内就有画面跟手，之后越来越密。
      if (onPartial && out.length % 2 === 0) onPartial(out.slice());
    }
    return out.length ? out : null;
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}

// ── 帧 ── 抓源内 t 秒处的一帧小图（**精确**时刻，供停手后替换缩略条那一格）。
//  **独立队列**：精确帧是用户看得见的东西（片段首/尾帧），不能排在整条抽条后面 ——
//  共用一个队列时，一段 160 格的长视频要抽完它才轮得到，预览等于消失。
//  两条链各跑各的（抽条一条、精确帧一条），每条内部仍然串行。
const frameChain: { p: Promise<unknown> } = { p: Promise.resolve() };
const enqueueFrame = <T>(job: () => Promise<T>): Promise<T> => {
  const p = frameChain.p.then(job, job);
  frameChain.p = p.catch(() => { /* keep the chain alive */ });
  return p;
};
const frameCache = new Map<string, Promise<string | null>>();

export const ensureFrame = (src: string, t: number): Promise<string | null> => {
  const key = `${src}@${t.toFixed(2)}`;
  let p = frameCache.get(key);
  if (!p) { p = enqueueFrame(() => grabFrame(src, t)); frameCache.set(key, p); }
  return p;
};

async function grabFrame(src: string, t: number): Promise<string | null> {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.src = src;
  try {
    const ready = new Promise<boolean>(resolve => {
      const ok = () => resolve(true);
      const bad = () => resolve(false);
      v.addEventListener('loadeddata', ok, { once: true });
      v.addEventListener('error', bad, { once: true });
      setTimeout(bad, 10000);
    });
    if (!await ready) return null;

    await yieldToScrub();                      // 同上：拖动中不跟主 <video> 抢解码器。
    await new Promise<void>(resolve => {
      const done = () => resolve();
      v.addEventListener('seeked', done, { once: true });
      setTimeout(done, 5000);
      try {
        const lim = Number.isFinite(v.duration) && v.duration > 0 ? Math.max(0, v.duration - 0.05) : t;
        v.currentTime = Math.max(0, Math.min(t, lim));
      } catch { done(); }
    });
    if (!v.videoWidth || !v.videoHeight) return null;

    const w = 160;
    const h = Math.max(1, Math.round(w * v.videoHeight / v.videoWidth));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d');
    if (!g) return null;
    g.drawImage(v, 0, 0, w, h);
    const blob = await new Promise<Blob | null>(r => cv.toBlob(r, 'image/jpeg', 0.72));
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}

/** 全分辨率精确抓帧(续接段的首帧用):grabFrame 是缩略管线(160px JPEG),这里的画面要
 *  喂给生成器当第一帧,尺寸与精度都得是正身 —— 原生宽高、精确 currentTime(不走 fastSeek)、
 *  JPEG 0.92。同样排进串行队,不跟 scrub 抢解码器。返回 dataURL(/api/asset_import 直接收)。 */
export const grabFrameFull = (src: string, t: number): Promise<string | null> =>
  enqueueFrame(async () => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    v.src = src;
    try {
      const ready = await new Promise<boolean>(resolve => {
        const ok = () => resolve(true);
        const bad = () => resolve(false);
        v.addEventListener('loadeddata', ok, { once: true });
        v.addEventListener('error', bad, { once: true });
        setTimeout(bad, 15000);
      });
      if (!await ready) return null;
      await yieldToScrub();                      // 拖动中不跟主 <video> 抢解码器。
      await new Promise<void>(resolve => {
        const done = () => resolve();
        v.addEventListener('seeked', done, { once: true });
        setTimeout(done, 8000);
        try {
          const lim = Number.isFinite(v.duration) && v.duration > 0 ? Math.max(0, v.duration - 0.04) : t;
          v.currentTime = Math.max(0, Math.min(t, lim));
        } catch { done(); }
      });
      if (!v.videoWidth || !v.videoHeight) return null;
      const cv = document.createElement('canvas');
      cv.width = v.videoWidth;
      cv.height = v.videoHeight;
      const g = cv.getContext('2d');
      if (!g) return null;
      g.drawImage(v, 0, 0);
      return cv.toDataURL('image/jpeg', 0.92);
    } catch {
      return null;
    } finally {
      v.removeAttribute('src');
      v.load();
    }
  });

// ── 后端 /api/vid_frame 在不在 ── 只探一次。在 → 优先走后端（有磁盘缓存，开机就有图）；
// 不在（旧服务没重启）→ 全走客户端抓帧。
let backendProbe: Promise<boolean> | null = null;
export const frameBackend = (): Promise<boolean> => {
  if (!backendProbe) {
    backendProbe = fetch('/api/vid_frame?f=__probe__&t=0', { method: 'GET' })
      .then(r => r.status !== 404)
      .catch(() => false);
  }
  return backendProbe;
};

// 探针口（只读、不进任何 UI）：某条源的缩略条现在到手几格 —— 基准测试与排障用。
if (typeof window !== 'undefined') {
  (window as unknown as { __peekStrip?: (src: string) => number }).__peekStrip =
    (src: string) => strips.get(src)?.length ?? 0;
}
