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

export type VidTrackKind = 'video' | 'audio';
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
};

export type VidClip = {
  id: string;
  trackId: string;
  kind: VidTrackKind;
  name: string;
  /** 播放源：图池/资产条目的 URL（可持久）或本地文件的 objectURL（刷新即失效）。 */
  src: string;
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
};

// ── 播放头外置 ── 播放头每帧都在走；走 React state 会把宿主整页拖着每秒重渲几十次 ——
// scrub 卡顿的根子就在这。它改住这颗外置小仓库：set 只改数字并敲订阅者（订阅者自己直改
// DOM：播放头线、读数），React 的重渲染只留给低频的事（工程改动、播放开关、缩放）。
export type VidTransport = {
  get: () => number;
  set: (t: number) => void;
  subscribe: (fn: () => void) => () => void;
};
export const createVidTransport = (): VidTransport => {
  let t = 0;
  const subs = new Set<() => void>();
  return {
    get: () => t,
    set: v => {
      const nv = Math.max(0, v);
      if (nv === t) return;
      t = nv;
      subs.forEach(fn => fn());
    },
    subscribe: fn => { subs.add(fn); return () => { subs.delete(fn); }; },
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
  update: (fn: (p: VidProject) => VidProject) => void;
  seek: (t: number) => void;
  setPlaying: (v: boolean) => void;
  setPps: (v: number) => void;
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
      if (edge === 'l') {
        // 左边：start 最多退到 start-offset（源的开头），最多进到 start+duration-MIN。
        const lo = Math.max(0, c.start - c.offset);
        const hi = c.start + c.duration - MIN_CLIP;
        const ns = Math.min(hi, Math.max(lo, t));
        const d = ns - c.start;
        return { ...c, start: ns, duration: c.duration - d, offset: Math.max(0, c.offset + d) };
      }
      // 右边：end 最多到源的结尾（offset + srcDuration），最短 MIN_CLIP。
      const maxEnd = c.start + (c.srcDuration - c.offset);
      const ne = Math.min(Math.max(c.start + MIN_CLIP, t), maxEnd);
      return { ...c, duration: Math.max(MIN_CLIP, ne - c.start) };
    }),
  };
};

export const removeClip = (p: VidProject, id: string): VidProject =>
  ({ ...p, clips: p.clips.filter(c => c.id !== id && c.groupId !== id) });

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
  const track: VidTrack = { id: newVidId('trk'), kind, name: kind === 'video' ? `Video ${n}` : `Audio ${n}` };
  // 视频轨插到最上面（序 = 数组序），音频轨排到所有音频轨的最后。
  const tracks = kind === 'video' ? [track, ...p.tracks] : [...p.tracks, track];
  return { ...p, tracks };
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
  if (!track) return p;
  if (info.audioOnly) {
    track = p.tracks.find(t => t.kind === 'audio') ?? null;
    if (!track) {
      track = { id: newVidId('trk'), kind: 'audio', name: `Audio ${p.tracks.filter(t => t.kind === 'audio').length + 1}` };
      p = { ...p, tracks: [...p.tracks, track] };
    }
  }
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
});

export const loadVidProject = (): VidProject => {
  try {
    const raw = localStorage.getItem(VID_PROJECT_STORE);
    if (!raw) return defaultVidProject();
    const p = JSON.parse(raw) as VidProject;
    if (!Array.isArray(p.tracks) || !Array.isArray(p.clips)) return defaultVidProject();
    const trackIds = new Set(p.tracks.map(t => t.id));
    // blob: 的 objectURL 活不过刷新 —— 那些片段/资产当场蒸发；挂在不存在的轨道上的也一样。
    const clips = p.clips.filter(c => c && c.src && !c.src.startsWith('blob:') && trackIds.has(c.trackId)
      && Number.isFinite(c.start) && Number.isFinite(c.duration) && c.duration > 0);
    const assets = (Array.isArray(p.assets) ? p.assets : []).filter(a => a && a.src && !a.src.startsWith('blob:')
      && Number.isFinite(a.duration) && a.duration > 0);
    return { tracks: p.tracks, clips, assets, inPoint: Math.max(0, +p.inPoint || 0), outPoint: Math.max(0, +p.outPoint || 0) };
  } catch { return defaultVidProject(); }
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
