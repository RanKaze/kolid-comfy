// ── Video 模式的工程模型 ────────────────────────────────────────────────────────────────────
// 纯数据 + 纯函数：轨道、片段、入出点，以及搬动它们的所有写口。播放状态（播放头 / 是否在播 /
// 缩放）不在这里 —— 那是宿主（EditPhase）的 React state，经 `VidController` 发给两扇窗。
//
// 口径约定：
//  * `tracks` 的数组序 = 时间线上的上下序，视频轨在前（index 0 在最上）、音频轨在后；
//    预览合成"最上层优先"就是按这个序找第一段命中的视频。
//  * 片段的 `kind` 跟着它脚下的轨道走：视频轨上是视频、音频轨上是音频 —— 同一个源文件
//    （导入视频自动拆分）在两类轨上各有一段，用 `groupId` 认亲，拖动/裁剪同步。
//  * 时间一律用秒（浮点）；`start` 是时间线位置，`offset` 是这段从源文件哪里开始播。
//  * 持久化（localStorage 'sampler.videoProject'）只存 tracks/clips/入出点。本地图（objectURL）
//    活不过一次刷新，读档时把 blob: 的片段剪掉 —— 图池条目的 URL 是持久的，照常回来。

import type { StagingItem } from '../../types';
import type { MediaInfo } from './audio';

// 三种轨：
//  * video / audio —— 素材轨，帧与声直接来自源文件；
//  * layer —— **合成轨**。它自己不装素材，只装"Layer 段"：每一段绑定一套独立图层
//    （在 Layers 窗里编辑），并把下方视频轨的当前帧当作底图叠上去。
//    **只有它排在所有视频轨之上时才会生效**（渲染按轨道序找第一条命中的轨，先命中先赢）。
export type VidTrackKind = 'video' | 'audio' | 'layer';
export type VidTrack = { id: string; kind: VidTrackKind; name: string };

/** 资产库的一件货：视频/音频源，URL 收藏在这里，时间线上的片段按 src/资产来引用 ——
 *  同一源泉多次拖进时间线也只是多几段引用，不复制数据。 */
export type VidAsset = {
  id: string;
  name: string;
  src: string;
  origin: 'staging' | 'file';
  kind: 'video' | 'audio';
  /** 源长（s），导入时探测一次就记下。 */
  duration: number;
  hasAudio: boolean;
  /** 整段源的波形 PNG（/api/vid_media/...，入库时 ffmpeg 生成）。片段按 offset/duration 裁窗。 */
  waveform?: string;
};

export type VidClip = {
  id: string;
  trackId: string;
  kind: VidTrackKind;
  name: string;
  /** 播放源：图池/资产条目的 URL（可持久）或本地文件的 objectURL（刷新即失效）。
   *  Layer 段没有播放源（它是合成的容器，不是素材），这里留空串。 */
  src: string;
  /** Layer 段绑定的图层集 key（= 这一段的 id）。切到某一段时，Layers 窗换成这一套。 */
  layerKey?: string;
  origin: 'staging' | 'file' | 'asset';
  /** 时间线位置（s）。 */
  start: number;
  /** 时间线上的长度（s）—— 裁剪之后的那段。 */
  duration: number;
  /** 这段从源文件的哪里开始播（s）。 */
  offset: number;
  /** 源文件总长（s）。 */
  srcDuration: number;
  /** 源里有可解码的音频（导入时探测）。 */
  hasAudio: boolean;
  /** 同一次导入拆出来的视频段 + 音频段共用一颗 —— 拖动/裁剪一起走。 */
  groupId?: string;
};

export type VidProject = {
  tracks: VidTrack[];
  clips: VidClip[];
  /** 资产库：时间线的素材都从这里引用。 */
  assets: VidAsset[];
  /** 播放范围的入点（s）。 */
  inPoint: number;
  /** 播放范围的出点（s）；<= inPoint 视为"没设"，播放范围就是整条时间线。 */
  outPoint: number;
  /** 输出帧率。预览/取帧的时间栅格按它走；Layer Track 逐帧合成也用它对齐
   *  （"执行到该帧"就是 t = n / fps）。旧档里没有这个字段 → 30。 */
  fps: number;
};

/** 帧率的合理区间：低于 1 没有意义，高过 120 只会让逐帧取帧变慢。 */
export const FPS_MIN = 1, FPS_MAX = 120;
export const clampFps = (v: number): number =>
  Math.max(FPS_MIN, Math.min(FPS_MAX, Math.round(Number(v) || 30)));

// ── 播放头外置 ── 播放头每帧都在走；走 React state 会把宿主整页拖着每秒重渲几十次 ——
// scrub 卡顿的根子就在这。它改住这颗外置小仓库：set 只改数字并敲订阅者（订阅者自己直改
// DOM：播放头线、读数），React 的重渲染只留给低频的事（工程改动、播放开关、缩放）。
// 订阅者拿到的 `interactive` 说的是"这次移动是谁干的"：用户拖 scrub / 点标尺 = true，
// 播放循环按时钟推进 = false。监视器据此决定画面怎么跟 —— 拖动时走缩略条（换索引，不动
// 解码器，所以全程跟手），播放时走 <video> 自己的时钟。
export type VidTransport = {
  get: () => number;
  set: (t: number, interactive?: boolean) => void;
  subscribe: (fn: (interactive?: boolean) => void) => () => void;
};
export const createVidTransport = (): VidTransport => {
  let t = 0;
  const subs = new Set<(interactive?: boolean) => void>();
  return {
    get: () => t,
    set: (v, interactive) => {
      const nv = Math.max(0, v);
      if (nv === t) return;
      t = nv;
      subs.forEach(fn => fn(interactive));
    },
    subscribe: fn => { subs.add(fn); return () => { subs.delete(fn); }; },
  };
};

// ── seek 合流 ── 指针事件一秒能来几百上千发（高刷鼠标更凶），而订阅者里有 layout 读写
// （跟随滚动要读 scrollLeft）。每发都跑一遍就是白烧 —— 合并到 rAF：一帧最多落一次，
// 视觉零差别，开销封顶。seek 永远是"用户在拖"，interactive 一并带上。
export const createSeekCoalescer = (transport: VidTransport) => {
  let raf = 0;
  let want = 0;
  return (t: number) => {
    want = Math.max(0, t);
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      transport.set(want, true);
    });
  };
};

// 两扇窗（Player / Timeline）共用的控制器快照：宿主每轮渲染组装一份。
export type VidController = {
  project: VidProject;
  /** 播放头（外置，不进 React 渲染图 —— 见 VidTransport）。 */
  transport: VidTransport;
  playing: boolean;
  /** 时间线缩放：一秒多少像素。 */
  pps: number;
  /** 图池镜像 —— 拖进轨道的图池条目按 id 在这里认领。 */
  staging: StagingItem[];
  /** 改工程。`label` 是这一步在 History 里显示的名字，也是**合并键** —— 拖动时每帧都会调一次，
   *  同一个 label 连着来的那些会并成一步（一次拖动 = 一步撤销），见 EditPhase 的 pushVidHist。 */
  update: (fn: (p: VidProject) => VidProject, label?: string) => void;
  /** 选中/取消一段。Layer 段用它切图层集 —— Layers 窗换成这一段自己那一套。 */
  focusClip: (clip: VidClip | null) => void;
  seek: (t: number) => void;
  setPlaying: (v: boolean) => void;
  setPps: (v: number) => void;
  /** 给 Blend 页发消息（逐帧合成的取帧/回图都走这条边界，转交的是 ImageBitmap）。
   *  返回 false = 那个 window 此刻不在（消息没发出去，调用方得自己收掉 transferable）。 */
  blendPost: (msg: unknown, transfer?: Transferable[]) => boolean;
  /** Blend 页的 window —— 回图只认它，别处的同名消息一概不收。 */
  blendWindow: () => Window | null;
};

const MIN_CLIP = 0.05;   // 片段/裁剪的最短寿命（s）
let seq = 0;
export const newVidId = (prefix: string): string =>
  `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

export const vidDuration = (p: VidProject): number =>
  p.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);

export const trackOf = (p: VidProject, id: string): VidTrack | null => p.tracks.find(t => t.id === id) ?? null;

/** 播放头 t 落在哪一段上（按轨道上下序，先命中先赢）。`kind` 缺省 = 不挑类型。 */
export const clipAt = (p: VidProject, t: number, kind?: VidTrackKind): VidClip | null => {
  for (const tr of p.tracks) {
    if (kind && tr.kind !== kind) continue;
    const hit = p.clips.find(c => c.trackId === tr.id && t >= c.start && t < c.start + c.duration);
    if (hit) return hit;
  }
  return null;
};

/** 落点时间抓一段片段：先找脚下轨道上的空位（放到该轨片段末尾），不行就放到整个时间线末尾。 */
export const snapPlace = (p: VidProject, trackId: string, at: number): number => {
  const ends = p.clips.filter(c => c.trackId === trackId).map(c => c.start + c.duration);
  const trackEnd = ends.length ? Math.max(...ends) : 0;
  return Math.max(0, Math.min(at, trackEnd));
};

// ── 写口（全部纯函数：旧 project 原样进，新 project 整份出）───────────────────────────────

/** 拖动片段。默认 `groupId` 认了亲的整组一起平移；`linked=false`（按住 Alt）只动被拖的
 *  那段 —— 这就是让视频和音频**错开**的口子。换轨只换被拖的那段（同类轨之间）。 */
export const moveClip = (p: VidProject, id: string, newStart: number, newTrackId?: string, linked = true): VidProject => {
  const clip = p.clips.find(c => c.id === id);
  if (!clip) return p;
  const delta = Math.max(0, newStart) - clip.start;
  const gid = linked ? clip.groupId : undefined;
  return {
    ...p,
    clips: p.clips.map(c => {
      if (c.id === id) return { ...c, start: Math.max(0, c.start + delta), trackId: newTrackId ?? c.trackId };
      if (gid && c.groupId === gid) return { ...c, start: Math.max(0, c.start + delta) };
      return c;
    }),
  };
};

/** 裁剪片段的一条边。`t` 是边要去的时刻（时间线坐标）。默认联动组的成员各自按同一份意图裁，
 *  但每一员都先保住自己的底线（不短于 MIN_CLIP、不越出源范围）—— 极端情况下组员会松开对齐；
 *  `linked=false`（按住 Alt）只裁被拖的那段。 */
export const trimClip = (p: VidProject, id: string, edge: 'l' | 'r', t: number, linked = true): VidProject => {
  const clip = p.clips.find(c => c.id === id);
  if (!clip) return p;
  const ids = new Set((linked && clip.groupId ? p.clips.filter(c => c.groupId === clip.groupId) : [clip]).map(c => c.id));
  return {
    ...p,
    clips: p.clips.map(c => {
      if (!ids.has(c.id)) return c;
      // Layer 段没有源文件：两条边都不受"源长"限制（它的 srcDuration 只是造段时的默认 5s），
      // 只受时间线 0 与 MIN_CLIP 约束 —— 否则永远拉不过 5 秒。
      const timeless = c.kind === 'layer';
      if (edge === 'l') {
        // 左边：start 最多退到 start-offset（源的开头），最多进到 start+duration-MIN。
        const lo = timeless ? 0 : Math.max(0, c.start - c.offset);
        const hi = c.start + c.duration - MIN_CLIP;
        const ns = Math.min(hi, Math.max(lo, t));
        const d = ns - c.start;
        return { ...c, start: ns, duration: c.duration - d, offset: timeless ? 0 : Math.max(0, c.offset + d) };
      }
      // 右边：end 最多到源的结尾（offset + srcDuration），最短 MIN_CLIP。
      const maxEnd = timeless ? Infinity : c.start + (c.srcDuration - c.offset);
      const ne = Math.min(Math.max(c.start + MIN_CLIP, t), maxEnd);
      return { ...c, duration: Math.max(MIN_CLIP, ne - c.start) };
    }),
  };
};

export const removeClip = (p: VidProject, id: string): VidProject =>
  ({ ...p, clips: p.clips.filter(c => c.id !== id && c.groupId !== id) });

/** 在时间线 `t` 处**剪开**一段（按住 C 左键片段 —— 剃刀）。默认联动组的另一侧一起剪，
 *  两边切口对齐、各自 offset 推进同样的量，剪完仍是一个组（还能一起拖）；`linked=false`
 *  （按住 Alt）只剪按到的那一段。
 *  切口离任一端不足 MIN_CLIP 就是不动 —— 不产生选不中、拖不动的零长碎片。 */
export const splitClip = (p: VidProject, id: string, t: number, linked = true): VidProject => {
  const target = p.clips.find(c => c.id === id);
  if (!target) return p;
  const ids = new Set((linked && target.groupId ? p.clips.filter(c => c.groupId === target.groupId) : [target]).map(c => c.id));
  // **剪开 = 组也剪开**：剪完左半与右半各自成组（视频段与它的音频段仍是一对），
  // 否则两半共享原 groupId —— 之后不动 Alt 裁右半，左半会跟着一起被裁。
  const gLeft = target.groupId ? newVidId('grp') : undefined;
  const gRight = target.groupId ? newVidId('grp') : undefined;
  let changed = false;
  const clips: VidClip[] = [];
  for (const c of p.clips) {
    if (!ids.has(c.id)) { clips.push(c); continue; }
    const cut = t - c.start;
    if (cut < MIN_CLIP || c.duration - cut < MIN_CLIP) { clips.push(c); continue; }   // 这一员切不了，原样留下
    changed = true;
    clips.push({ ...c, groupId: gLeft, duration: cut });
    clips.push({ ...c, id: newVidId('clip'), groupId: gRight, start: c.start + cut, duration: c.duration - cut, offset: c.offset + cut });
  }
  return changed ? { ...p, clips } : p;
};

/** 解绑：联动组全体摘掉 groupId —— 此后各自拖各自裁（音画错开的正式手续）。 */
export const unlinkGroup = (p: VidProject, groupId: string): VidProject =>
  ({ ...p, clips: p.clips.map(c => (c.groupId === groupId ? { ...c, groupId: undefined } : c)) });

// ── 资产库 ────────────────────────────────────────────────────────────────────────────────
/** 收一件资产：同一个 src 只留一份（重复拖进来 = 认领已有的那件）。 */
export const addAsset = (p: VidProject, a: VidAsset): VidProject =>
  p.assets.some(x => x.src === a.src)
    ? p
    : { ...p, assets: [...p.assets, a] };

/** 扔掉一件资产：已经落进时间线的片段不受影响（它们自己揣着 src），只是不能再用它拖新的。 */
export const removeAsset = (p: VidProject, id: string): VidProject =>
  ({ ...p, assets: p.assets.filter(a => a.id !== id) });

export const addTrack = (p: VidProject, kind: VidTrackKind): VidProject => {
  const n = p.tracks.filter(t => t.kind === kind).length + 1;
  const name = kind === 'video' ? `Video ${n}` : kind === 'layer' ? `Layer ${n}` : `Audio ${n}`;
  const track: VidTrack = { id: newVidId('trk'), kind, name };
  // 视频轨 / Layer 轨插到最上面（序 = 数组序，也是渲染的上下序），音频轨排到所有音频轨的最后。
  const tracks = kind === 'audio' ? [...p.tracks, track] : [track, ...p.tracks];
  return { ...p, tracks };
};

/** 在 Layer 轨上造一段。段 = 一段时间区间 + 一套独立图层（key 就是它自己的 id）。
 *  `at` 会被 snapPlace 吸到该轨的空位上，所以连点两次不会叠在一起。 */
export const addLayerClip = (p: VidProject, trackId: string, at: number, duration = 5): VidProject => {
  const track = trackOf(p, trackId);
  if (!track || track.kind !== 'layer') return p;
  const id = newVidId('lcl');
  const start = snapPlace(p, trackId, at);
  const clip: VidClip = {
    id, trackId, kind: 'layer', name: 'Layer ' + (p.clips.filter(c => c.kind === 'layer' && c.trackId === trackId).length + 1),
    src: '', origin: 'asset', start, duration: Math.max(0.1, duration), offset: 0, srcDuration: duration,
    hasAudio: false, layerKey: id,
  };
  return { ...p, clips: [...p.clips, clip] };
};

export const removeTrack = (p: VidProject, trackId: string): VidProject => ({
  ...p,
  tracks: p.tracks.filter(t => t.id !== trackId),
  clips: p.clips.filter(c => c.trackId !== trackId),
});

// ── 导入：一段源文件进时间线（拖放落定后调）───────────────────────────────────────────────
/** 把一次拖放落成片段（含音画拆分）。`trackId` 为空 = 自动挑第一段视频轨。
 *  纯音频源（<video> 咬不动，audioOnly）或落在音频轨上 = 音频段；视频源落在视频轨且带音频
 *  = 视频段 + 拆一条联动音频段。纯函数，返回新 project。 */
export const placeImport = (
  p: VidProject,
  src: { src: string; name: string; origin: 'staging' | 'file' | 'asset' },
  info: MediaInfo,
  trackId: string | null,
  at: number,
): VidProject => {
  let track = (trackId ? trackOf(p, trackId) : null) ?? p.tracks.find(t => t.kind === 'video') ?? null;
  // 落进一个**还没有视频轨**的工程（新工程 / 用户把视频轨删光了）：当场建一条，插在最上面 ——
  // 与 addTrack 的口径一致（视频插头、音频追尾）。没有这一手，拖进来的视频会静默消失，
  // 只在 Assets 里剩一件没人用的资产。
  if (!track && !info.audioOnly) {
    track = { id: newVidId('trk'), kind: 'video', name: `Video ${p.tracks.filter(t => t.kind === 'video').length + 1}` };
    p = { ...p, tracks: [track, ...p.tracks] };
  }
  if (info.audioOnly) {
    track = p.tracks.find(t => t.kind === 'audio') ?? null;
    if (!track) {
      track = { id: newVidId('trk'), kind: 'audio', name: `Audio ${p.tracks.filter(t => t.kind === 'audio').length + 1}` };
      p = { ...p, tracks: [...p.tracks, track] };
    }
  }
  if (!track) return p;
  const groupId = newVidId('grp');
  const start = snapPlace(p, track.id, at);
  const clip: VidClip = {
    id: newVidId('clip'), trackId: track.id, kind: track.kind, name: src.name, src: src.src,
    origin: src.origin, start, duration: info.duration, offset: 0,
    srcDuration: info.duration, hasAudio: info.hasAudio,
    groupId: track.kind === 'video' && info.hasAudio ? groupId : undefined,
  };
  const clips = [...p.clips, clip];

  // 视频段带了音频 → 拆一条音频出来：找第一段音频轨，没有就当场补一条，音频段落位对齐。
  if (track.kind === 'video' && info.hasAudio) {
    let tracks = p.tracks;
    let audio = tracks.find(t => t.kind === 'audio');
    if (!audio) {
      audio = { id: newVidId('trk'), kind: 'audio', name: 'Audio 1' };
      tracks = [...tracks, audio];
    }
    clips.push({
      id: newVidId('clip'), trackId: audio.id, kind: 'audio', name: src.name, src: src.src,
      origin: src.origin, start, duration: info.duration, offset: 0,
      srcDuration: info.duration, hasAudio: true, groupId,
    });
    return { ...p, tracks, clips };
  }
  return { ...p, clips };
};

/** 资产拖进轨道：片段直接引用资产（不复制数据），音画拆分口径与 placeImport 一致。 */
export const placeAsset = (p: VidProject, asset: VidAsset, trackId: string | null, at: number): VidProject =>
  placeImport(
    p,
    { src: asset.src, name: asset.name, origin: 'asset' },
    { duration: asset.duration, hasAudio: asset.hasAudio, audioOnly: asset.kind === 'audio' },
    trackId,
    at,
  );

/** 拖放到轨道的统一入口 —— **Assets 是项目所有数据的来源**：任何源（图池条目、本地文件）
 *  先入资产库（同 src 认领已有的那件），时间线再落一段引用它的片段。不存在"直接进轨道"的路。 */
export const importToTrack = (
  p: VidProject,
  src: { src: string; name: string; origin: 'staging' | 'file' },
  info: MediaInfo,
  trackId: string | null,
  at: number,
): VidProject => {
  let asset = p.assets.find(a => a.src === src.src);
  let next = p;
  if (!asset) {
    asset = {
      id: newVidId('as'), name: src.name, src: src.src, origin: src.origin,
      kind: info.audioOnly ? 'audio' : 'video', duration: info.duration, hasAudio: info.hasAudio,
    };
    next = addAsset(next, asset);
  }
  return placeAsset(next, asset, trackId, at);
};

// ── 持久化 ────────────────────────────────────────────────────────────────────────────────────
const VID_PROJECT_STORE = 'sampler.videoProject';

export const defaultVidProject = (): VidProject => ({
  tracks: [
    { id: newVidId('trk'), kind: 'video', name: 'Video 1' },
    { id: newVidId('trk'), kind: 'audio', name: 'Audio 1' },
  ],
  clips: [],
  assets: [],
  inPoint: 0,
  outPoint: 0,
  fps: 30,
});

export const loadVidProject = (): VidProject => {
  try {
    const raw = localStorage.getItem(VID_PROJECT_STORE);
    if (!raw) return defaultVidProject();
    return normalizeVidProject(JSON.parse(raw));
  } catch { return defaultVidProject(); }
};

/** 任何来源（localStorage / .cud 的 header.video / 宿主消息）的工程数据都过这里：
 *  形状不对的部分当场剪掉 —— 一份坏数据不该把时间线整个掀了。 */
export const normalizeVidProject = (raw: unknown): VidProject => {
  const base = defaultVidProject();
  try {
    const p = raw as VidProject;
    if (!p || !Array.isArray(p.tracks) || !Array.isArray(p.clips)) return base;
    const trackIds = new Set(p.tracks.map(t => t.id));
    // blob: 的 objectURL 活不过刷新 —— 那些片段/资产当场蒸发；挂在不存在的轨道上的也一样。
    // Layer 段没有 src（它装的是图层，不是素材），所以"必须有 src"那条只对素材段成立。
    const clips = p.clips.filter(c => {
      if (!c || !trackIds.has(c.trackId)) return false;
      if (!Number.isFinite(c.start) || !Number.isFinite(c.duration) || !(c.duration > 0)) return false;
      if (c.kind === 'layer') return c.src === '' || !c.src;
      return !!c.src && !c.src.startsWith('blob:');
    }).map(c => (c.kind === 'layer' ? { ...c, src: '', layerKey: c.layerKey || c.id } : c));
    const assets = (Array.isArray(p.assets) ? p.assets : []).filter(a => a && a.src && !a.src.startsWith('blob:')
      && Number.isFinite(a.duration) && a.duration > 0);
    return {
      tracks: p.tracks, clips, assets,
      inPoint: Math.max(0, +p.inPoint || 0), outPoint: Math.max(0, +p.outPoint || 0),
      fps: clampFps(Number(p.fps)),
    };
  } catch { return base; }
};

export const saveVidProject = (p: VidProject): void => {
  try { localStorage.setItem(VID_PROJECT_STORE, JSON.stringify(p)); } catch { /* in-memory only */ }
};

// ── 小工具 ──────────────────────────────────────────────────────────────────────────────────
export const fmtTime = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`;
};

export const isVideoName = (name: string): boolean =>
  /\.(mp4|webm|mov|m4v|mkv|avi|ogv|mpg|mpeg)$/i.test(name || '');
export const isAudioName = (name: string): boolean =>
  /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(name || '');
