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

import type { StagingItem, VideoGenPorts } from '../../types';
import type { MidiNote, MidiProject, MidiTrack } from '../../midi/model';
import type { MidiEditor } from '../../midi/types';
import {
  MAX_VEL, MIN_DUR, MIN_TEMPO, MIN_VEL, MAX_TEMPO, TRACK_COLORS, beatToSeconds, clampInt, clampNum, secondsToBeat,
} from '../../midi/model';
import type { MediaInfo } from './audio';
import type { Ingested } from './ingest';

// 五种轨：
//  * video / audio —— 素材轨，帧与声直接来自源文件；
//  * layer —— **合成轨**。它自己不装素材，只装"Layer 段"：每一段绑定一套独立图层
//    （在 Layers 窗里编辑），这一帧的画面**就是这一段图层自己的合成** —— 不叠加脚下视频轨的帧，
//    空段因此是一张空图。要让画面里出现某条视频轨的帧，就把它绑到 decal / mask 的 Frame source。
//    **只有它排在所有视频轨之上时才会生效**（渲染按轨道序找第一条命中的轨，先命中先赢）。
//  * process —— **process 轨**（琥珀色）：只装 Processor / Preset 的**占位段**（VidProcPending），
//    不播、不参与合成、不收素材。Run 时自动创建（在输出轨正下方），产物落到上方输出轨；
//    占位段原地保留，所以可以反复 ▶ 重跑。
//  * midi —— **乐器轨**（紫色）：轨上装的是 MIDI 段（`VidClip.notes`），不参与视频合成、
//    不收素材文件。它与音频轨同住下半区 —— 声域共用 mute / audio solo，时间线共用秒，
//    音符自己住在拍上（见 `VidMusic` / `midiClipWindow`）。
export type VidTrackKind = 'video' | 'audio' | 'layer' | 'process' | 'midi';
export type VidTrack = {
  id: string;
  kind: VidTrackKind;
  name: string;
  /** MIDI 轨的通道 0..15（9 = 鼓，协议固定）。其余轨型不用这个字段。 */
  channel?: number;
  /** MIDI 轨挂的乐器（.vstpreset / .sfz 的绝对路径）。空 = 这一轨不出声。 */
  instrument?: string;
  /** MIDI 轨的力度基线 0.1..2：音符自己的 vel × 它才是发出去的力度。 */
  velScale?: number;
  /** MIDI 轨行上的色点；缺省由 midi/model 的调色板按轨序补。 */
  color?: string;
  /** `'output'` = **产物输出轨**：Processor / Preset 的 process 段跑完，成品固定落在这一条
   *  上层轨的对应时间位置（占位段自己留在原地，可以反复重跑）。每条输出口一条，懒建。
   *  `'vgen'` = **生成器段所在的 process 轨**（紧贴对应输出轨下方、每个输出口一条、懒建复用）：
   *  与 processor 那条 process 轨是两回事 —— 生成器段不是"那段视频抽几帧"的占位，它自有
   *  一套参数，所以另起一条、按 role 认，免得两条路的段混在一条轨上互相绊。 */
  role?: 'output' | 'vgen';
  /** 输出轨对应的输出口（缺省 0；preset 恒 0）。process 段按 pending.port 找自己的输出轨。 */
  port?: number;
  /** 生成器轨（role 'vgen'）的分辨率设置：轨上所有段共享，段上不再有宽高。 */
  vgenCfg?: VidGenTrackCfg;
  /** 生成器轨的**轨级提示词**（prompt preset 的 id）：轨上所有段共享，跑的时候渲染成串
   *  追加在每段自己的提示词后面（段在前、轨在后）。空/找不到 = 没配。 */
  vgenPromptPresetId?: string;
};

/** 资产库的一件货：视频/音频源，URL 收藏在这里，时间线上的片段按 src/资产来引用 ——
 *  同一源泉多次拖进时间线也只是多几段引用，不复制数据。 */
export type VidAsset = {
  id: string;
  name: string;
  src: string;
  origin: 'staging' | 'file';
  kind: 'video' | 'audio';
  /** 原件的内容哈希（A5，仓库 id）：认货的正身。缺 = 老存档 / blob: 回退。 */
  asset?: string;
  /** 可播字节的哈希（转码过的源指向代理片；否则与 asset 相同或留空）。 */
  play?: string;
  /** 源长（s），导入时探测一次就记下。 */
  duration: number;
  hasAudio: boolean;
  /** 整段源的波形 PNG（/api/vid_media/...，入库时 ffmpeg 生成）。片段按 offset/duration 裁窗。 */
  waveform?: string;
};

/** 一件货的身份：三个地址面（原件哈希 / 代理哈希 / 持久 URL）**任一命中**即算同一件 ——
 *  判据就是 `sameAsset`。认货、去重、"这一条引用该改指谁"全都按它，别处不另立一套。 */
export type AssetIdentity = { asset?: string; play?: string; src?: string };

export type VidClip = {
  id: string;
  trackId: string;
  kind: VidTrackKind;
  name: string;
  /** 播放源：图池/资产条目的 URL（可持久）或本地文件的 objectURL（刷新即失效）。
   *  Layer 段没有播放源（它是合成的容器，不是素材），这里留空串。 */
  src: string;
  /** 原件的内容哈希（A5）。`src` 是"怎么播"，`asset` 是"是哪一件货" —— 缺了能按它 relink，
   *  仓库里没有就能画"缺失"。 */
  asset?: string;
  /** 可播字节的哈希（转码代理）。src 丢了/换了端口时按它重建。 */
  play?: string;
  /** Layer 段绑定的图层集 key（= 这一段的 id）。切到某一段时，Layers 窗换成这一套。 */
  layerKey?: string;
  origin: 'staging' | 'file' | 'asset';
  /** 时间线位置（s）。 */
  start: number;
  /** 时间线上的长度（s）—— 裁剪之后的那段。 */
  duration: number;
  /** 这段从源文件的哪里开始播（s）。**MIDI 段例外：单位是拍**，窗口在内容里的起点
   *  （左裁会改它，可以为负 = 内容前面留白）—— 见 `midiClipWindow`。 */
  offset: number;
  /** 源文件总长（s）；MIDI 段是内容总长（拍）。 */
  srcDuration: number;
  /** 源里有可解码的音频（导入时探测）。 */
  hasAudio: boolean;
  /** 同一次导入拆出来的视频段 + 音频段共用一颗 —— 拖动/裁剪一起走。 */
  groupId?: string;
  /** Processor 占位段（见 VidProcPending）：产物落在输出轨上，占位段自己**原地保留**
   *  （可以反复 ▶ 重跑）；重跑会把它自己上一次的产物换掉。撤掉它 = 放弃这个 process 段。 */
  pending?: VidProcPending;
  /** Video Generator 段（见 VidGenPending）：与占位段同一条 process 轨、同一套"产物落到
   *  输出轨"的规矩，但参数不是"那段视频抽几帧"，而是生成器自己的一套（提示词 / 宽高 /
   *  时长 / 帧率 / 首末帧）。两者互斥：一段要么是处理器占位，要么是生成器。 */
  vgen?: VidGenPending;
  /** 输出轨上的产物由哪个占位段生成（= 占位段的 clip id）。重跑同一个占位段时按它认亲，
   *  自己的旧产物不算"占位"，会被原地换掉；别的东西占着才是真占。 */
  procOwner?: string;
  /** 关键帧系统（见 VidKeyframes）：持久化在段上，随 .cud 走。眼下只有 Layer 段用 ——
   *  通道里记的是它图层集的 fx 参数与 transform。结构对参数源开放，之后扩啥都只是新键。 */
  keyframes?: VidKeyframes;
  /** MIDI 段的音符。时间单位是**拍**，原点在这段内容的开头（0 = 内容第一拍）——
   *  段怎么挪、怎么裁，音符本身不动；能听见/看见的窗口由 `offset + duration` 决定
   *  （见 `midiClipWindow`）。只有 `kind === 'midi'` 的段有这一栏。 */
  notes?: MidiNote[];
};

// ── 关键帧系统 ───────────────────────────────────────────────────────────────────────────────
// 段上的关键帧:通道键 → 一串 (时刻, 值)。通道键是**开放的地址串** —— 设计上不封顶,眼下只有
// 两层前缀:
//   `layer:<layerId>:transform:<cx|cy|w|h|rotation>`
//   `layer:<layerId>:fx:<fxId>:<paramKey>`
// 之后的参数源(新的属性系统、音频、 Whatever)只是新的键前缀,模型、录制与回放都不用改。
// 值眼下只有数值(fx 的 range 参数、transform 各维都是数);string/boolean 留给之后的参数源。

export type VidKfValue = number;
/** 一枚关键帧：`t` = **归一化时刻**（0…1，相对段长），`v` = 该通道此刻的值。
 *  用归一化而不是段内秒，是为了"这一段被拉伸 / 裁短之后动画仍然逻辑稳定"：所有帧按比例重排，
 *  半个段上的那枚帧永远在半个段上。段内秒只在**界面按秒摊开**的地方出现（Keyframes 泳道、
 *  Tracks 上的菱形），换算见 kfU / kfSec。 */
export type VidKeyframe = { t: number; v: VidKfValue };
/** 通道键里各所有者的**名字快照**,录制时一并落档:层名会改、特效会被删,Keyframes 窗要能
 *  照旧说出"这一条是谁的什么"——不追着页面实时问,档里带的就是答案。effects 的 key 是特效 id。 */
export type VidKfMeta = { layers: Record<string, { name: string; effects: Record<string, string> }> };
export type VidKeyframes = {
  /** 时刻口径。`'norm'` = 0…1（现在写出去的都是这个）；**缺席** = 老档的"段内秒"，
   *  读档时由 kfMigrate 一次性换过来。 */
  unit?: 'norm';
  channels: Record<string, VidKeyframe[]>;
  meta?: VidKfMeta;
};

/** 工作台回的参数快照(blend-vid-kf):当前图层集里每层的 transform 与特效链参数。
 *  值保持 JSON 原样 —— 宿主只挑数值的进关键帧,复杂值(颜色/曲线)之后再说。 */
export type VidKfSnapshot = {
  layers: {
    id: string;
    name: string;
    visible: boolean;
    opacity?: number;
    transform: Record<string, unknown> | null;
    /** defs = 这一枚特效各数值参数的出厂默认值（录制第一趟靠它认出"用户动过的参数"）。 */
    effects: { id: number; type: string; enabled: boolean; params: Record<string, unknown>;
      defs?: Record<string, number> }[];
  }[];
};

/** 同刻判定:两枚关键帧的时刻差小于它算同一枚(覆盖,不并存)。
 *  **注意这是"秒"的容差**：模型里的时刻是归一化的，按段长换算见 kfEpsFor；这里留着给界面上
 *  按段内秒比较的地方用（播放头压没压着一枚帧）。 */
export const KF_EPS = 0.005;

/** 段长 = 关键帧的时间基。0 长的段当成一个极小值：除法不炸，0…1 仍然只有一个点。 */
export const kfSpan = (clip: { duration?: number } | null | undefined): number =>
  Math.max(Number(clip?.duration) || 0, 1e-6);

/** 段内秒 → 归一化时刻（夹在 0…1）。写入（录制/加帧/拖帧/删帧）与采样都吃归一化。 */
export const kfU = (clip: { duration?: number } | null | undefined, local: number): number => {
  const u = (Number(local) || 0) / kfSpan(clip);
  return u < 0 ? 0 : u > 1 ? 1 : u;
};

/** 归一化时刻 → 段内秒。界面按秒摊开的地方（Keyframes 泳道、Tracks 菱形、提示文字）用它。 */
export const kfSec = (clip: { duration?: number } | null | undefined, u: number): number => {
  const s = kfSpan(clip);
  const v = (Number(u) || 0) * s;
  return v < 0 ? 0 : v > s ? s : v;
};

/** 同刻判定（归一化口径）= **半帧**。段越长，同样的半帧占的比例越小，所以不能是个常数。 */
export const kfEpsFor = (clip: { duration?: number } | null | undefined, fps = 30): number =>
  Math.max(1e-7, 0.5 / Math.max(fps || 30, 1) / kfSpan(clip));

/** 老档迁移：`t` 还是段内秒的通道，按段长换成归一化。已经带 unit:'norm' 的原样返回。
 *  段长为 0（还没定长 / 占位）的段整串塌到 0：没有时间基，只有第一颗帧有意义。 */
export const kfMigrate = (kf: VidKeyframes | undefined, duration: number): VidKeyframes | undefined => {
  if (!kf || kf.unit === 'norm') return kf;
  const span = Math.max(Number(duration) || 0, 1e-6);
  const channels: Record<string, VidKeyframe[]> = {};
  for (const [key, list] of Object.entries(kf.channels ?? {})) {
    const frames = (list ?? [])
      .filter(k => k && Number.isFinite(k.t) && Number.isFinite(k.v))
      .map(k => ({ t: Math.max(0, Math.min(1, k.t / span)), v: k.v }))
      .sort((a, b) => a.t - b.t);
    // 归一化之后有可能会撞在一起（段很短、帧挤在末尾）：同刻只留后写的最后一枚。
    const keep: VidKeyframe[] = [];
    for (const f of frames) {
      const prev = keep[keep.length - 1];
      if (prev && Math.abs(prev.t - f.t) < 1e-9) keep[keep.length - 1] = f;
      else keep.push(f);
    }
    if (keep.length) channels[key] = keep;
  }
  return { unit: 'norm', channels, meta: kf.meta };
};

/** 落帧:往一枚段的关键帧系统里 upsert 一批通道值。`u` = **归一化时刻**(0…1，见 kfU)。
 *  ● 录制 = 整套参数一起落;Keyframes 窗的手动加帧/改值 = 其中一条或几条 —— 两条路共用这一颗,
 *  同刻判定与 meta 合并只此一份规矩。
 *  每个通道各自:摘掉同刻旧帧 → 按时间序插回。通道**惰性建**:段上还没有这条通道就新开一条
 *  (一枚参数的第一帧因此出得来,不必先靠录制把整套装进来);channels 里不留空数组。
 *  meta(所有者名字快照)浅合并进段 —— 带上来就存,新通道才报得出层名与特效名。 */
export const kfRecord = (p: VidProject, clipId: string, u: number, values: Record<string, VidKfValue>,
  meta?: VidKfMeta): VidProject => ({
  ...p,
  clips: p.clips.map(c => {
    if (c.id !== clipId) return c;
    const eps = kfEpsFor(c, p.fps);
    const t = u < 0 ? 0 : u > 1 ? 1 : u;
    const channels = { ...(c.keyframes?.channels ?? {}) };
    for (const [key, v] of Object.entries(values)) {
      const list = (channels[key] ?? []).filter(k => Math.abs(k.t - t) >= eps);
      const next = [...list, { t, v }].sort((a, b) => a.t - b.t);
      channels[key] = next;
    }
    const prevMeta = c.keyframes?.meta;
    const nextMeta: VidKfMeta | undefined = meta
      ? { layers: { ...(prevMeta?.layers ?? {}), ...meta.layers } }
      : prevMeta;
    return { ...c, keyframes: { unit: 'norm' as const, channels, meta: nextMeta } };
  }),
});

/** 挪一枚关键帧的时刻(拖菱形)。值不变;`to` 撞上同刻的旧帧按同一把尺覆盖 ——
 *  拖动落点永远只留一枚帧,不会出现两枚挤在同一时刻。`from`/`to` 都是**归一化时刻**。 */
export const kfMoveKey = (p: VidProject, clipId: string, key: string, from: number, to: number): VidProject => ({
  ...p,
  clips: p.clips.map(c => {
    if (c.id !== clipId || !c.keyframes?.channels[key]) return c;
    const eps = kfEpsFor(c, p.fps);
    const t = c.keyframes.channels[key].find(k => Math.abs(k.t - from) < eps);
    if (!t) return c;
    const to2 = to < 0 ? 0 : to > 1 ? 1 : to;
    const list = c.keyframes.channels[key].filter(k => Math.abs(k.t - from) >= eps && Math.abs(k.t - to2) >= eps);
    const channels = { ...c.keyframes.channels, [key]: [...list, { t: to2, v: t.v }].sort((a, b) => a.t - b.t) };
    return { ...c, keyframes: { ...c.keyframes, unit: 'norm' as const, channels } };
  }),
});

/** 删一枚关键帧(按归一化时刻)。通道空了就整条摘掉 —— channels 里不留空数组。 */
export const kfRemoveKey = (p: VidProject, clipId: string, key: string, u: number): VidProject => ({
  ...p,
  clips: p.clips.map(c => {
    if (c.id !== clipId || !c.keyframes?.channels[key]) return c;
    const eps = kfEpsFor(c, p.fps);
    const kept = c.keyframes.channels[key].filter(k => Math.abs(k.t - u) >= eps);
    const channels = { ...c.keyframes.channels };
    if (kept.length) channels[key] = kept;
    else delete channels[key];
    return { ...c, keyframes: { ...c.keyframes, unit: 'norm' as const, channels } };
  }),
});

/** 删一整条通道(某一参数的全部关键帧)。 */
export const kfRemoveChannel = (p: VidProject, clipId: string, key: string): VidProject => ({
  ...p,
  clips: p.clips.map(c => {
    if (c.id !== clipId || !c.keyframes?.channels[key]) return c;
    const channels = { ...c.keyframes.channels };
    delete channels[key];
    return { ...c, keyframes: { ...c.keyframes, channels } };
  }),
});

/** 通道键 → 所有者与参数名(Keyframes 窗的显示口径)。键形如
 *  `layer:<id>:opacity` / `layer:<id>:transform:<prop>` / `layer:<id>:fx:<fxId>:<param>`。 */
export type VidKfChannelInfo = { layerId: string; layerName: string; param: string; fxId?: string; fxName?: string };
const KF_TRANSFORM_LABELS: Record<string, string> = { cx: 'X', cy: 'Y', w: 'Width', h: 'Height', rotation: 'Rotation', opacity: 'Opacity' };
export const kfChannelInfo = (key: string, meta?: VidKfMeta): VidKfChannelInfo | null => {
  const m = /^layer:([^:]+):(.+)$/.exec(key);
  if (!m) return null;
  const layerId = m[1];
  const rest = m[2];
  const layerName = meta?.layers?.[layerId]?.name || `Layer ${layerId}`;
  if (rest === 'opacity') return { layerId, layerName, param: 'Opacity' };
  if (rest.startsWith('transform:')) {
    const prop = rest.slice('transform:'.length);
    return { layerId, layerName, param: KF_TRANSFORM_LABELS[prop] || prop };
  }
  const fx = /^fx:([^:]+):(.+)$/.exec(rest);
  if (fx) {
    const fxName = meta?.layers?.[layerId]?.effects?.[fx[1]];
    // fxId 给窗内排序用(特效链的先后),名字仍是快照里那一个。
    return { layerId, layerName, param: fx[2], fxId: fx[1], fxName: fxName || `fx ${fx[1]}` };
  }
  return null;
};

/** 工作台快照 → 通道键值表。**录制与手动加帧共用这一份口径** —— 两处各自解析快照的话,
 *  同一枚参数在两条路上会写成两个不同的键。旁路的特效不算(它不影响画面,与录制同规矩)。 */
export const kfSnapshotValues = (snap: VidKfSnapshot): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const l of snap.layers) {
    const pfx = `layer:${l.id}`;
    if (typeof l.opacity === 'number' && Number.isFinite(l.opacity)) out[`${pfx}:opacity`] = l.opacity;
    if (l.transform) {
      for (const [k, v] of Object.entries(l.transform)) {
        if (typeof v === 'number' && Number.isFinite(v)) out[`${pfx}:transform:${k}`] = v;
      }
    }
    for (const e of l.effects) {
      if (!e.enabled) continue;
      for (const [pk, pv] of Object.entries(e.params || {})) {
        if (typeof pv === 'number' && Number.isFinite(pv)) out[`${pfx}:fx:${e.id}:${pk}`] = pv;
      }
    }
  }
  return out;
};

/** 录制去重:两趟参数快照逐通道比较,只留下**真的动过**的通道(值没变的变量不再反复写帧)。
 *  `prev` 为空 = 这套图层集还没录过 —— 没有比较基准,整份都算"动过"(起始姿态)。
 *  上一趟没有的新通道(新图层、新特效参数)同样算动过。 */
export const kfChangedValues = (prev: Record<string, number> | undefined,
  next: Record<string, number>): Record<string, number> => {
  if (!prev) return next;
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(next)) {
    const before = prev[key];
    if (typeof before !== 'number' || Math.abs(before - v) > 1e-6) out[key] = v;
  }
  return out;
};

/** 图层参数的"出厂姿态"（变换 + 整体不透明度）。录制第一趟拿它认出没被动过的参数。 */
const KF_NEUTRAL_POSE: Record<string, number> = { cx: 0.5, cy: 0.5, w: 1, h: 1, rotation: 0, opacity: 1 };

/** 这条通道此刻的值是不是"出厂默认"（没被用户动过）。认不出默认值的（没有 defs 的特效参数）
 *  一律当"动过" —— 宁可多落一枚，也不要漏掉用户真改过的值。 */
export const kfIsDefaultValue = (key: string, v: number, snap?: VidKfSnapshot | null): boolean => {
  const m = /^layer:([^:]+):(.+)$/.exec(key);
  if (!m) return false;
  const rest = m[2];
  if (rest === 'opacity') return Math.abs(v - KF_NEUTRAL_POSE.opacity) < 1e-6;
  const tr = /^transform:([^:]+)$/.exec(rest);
  if (tr) {
    const d = KF_NEUTRAL_POSE[tr[1]];
    return typeof d === 'number' && Math.abs(v - d) < 1e-6;
  }
  const fx = /^fx:([^:]+):(.+)$/.exec(rest);
  if (!fx) return false;
  const layer = snap ? snap.layers.find(l => l.id === m[1]) : null;
  const eff = layer ? layer.effects.find(e => String(e.id) === fx[1]) : null;
  const d = eff && eff.defs ? eff.defs[fx[2]] : undefined;
  return typeof d === 'number' && Math.abs(v - d) < 1e-6;
};

/** 第一趟（这一段还没有比较基准）该落哪些通道 —— **按通道**判，不再按段一刀切：
 *  · 段上**已经在动**的参数：只进基准、不落帧（否则会把已有的动画在当前位置整套压平）；
 *  · 段上**还没有曲线**的参数：落那些**偏离出厂默认值**的 —— 用户动过的参数就是这条新曲线的
 *    起点（alpha 从 1 拖到 0.4、图层挪了位置、特效旋钮拧过…），没动过的摆在那儿只会让 ● 一开
 *    就凭空长出一整排帧；
 *  · 段上**一枚帧都没有**（全新的一段）：整套落一遍，那本来就是它的起始姿态。
 *  少了这一条，一枚已经有 fx 曲线的段永远开不出 alpha / 变换的曲线：第一趟只建基准，后面每一趟
 *  又都是"没变化"，滑杆拖出来的结果被静默吞掉 —— 用户看到的就是"● 录制亮着，alpha 却记不进去"。
 *  `u` = 归一化时刻（见 kfU）。 */
export const kfFirstPassValues = (kf: VidKeyframes | undefined, u: number,
  next: Record<string, number>, snap?: VidKfSnapshot | null): Record<string, number> => {
  const started = !!kf && Object.keys(kf.channels).length > 0;
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(next)) {
    if (kfSample(kf, key, u) !== null) continue;                 // 已经在动 = 只建基准
    if (!started || !kfIsDefaultValue(key, v, snap)) out[key] = v;
  }
  return out;
};

/** 粘贴 Layer 段时页面给整套图层重新发号(见 blend_node 的 copyLayerSetTo)：把段上关键帧的
 *  通道键与 meta 里的旧层 id 一并换到新 id。不换 = 同一枚参数在 Keyframes 窗里出现两份
 *  （旧 id 记下的帧一组、新 id 的活参数一组），这正是"一个变量两行"的来源。 */
export const kfRemapLayerIds = (kf: VidKeyframes | undefined, map: Record<string, string>): VidKeyframes | undefined => {
  if (!kf) return kf;
  const rename = (key: string): string => {
    const m = /^(layer:)([^:]+)(:.*)$/.exec(key);
    const to = m ? map[m[2]] : undefined;
    return m && to ? `${m[1]}${to}${m[3]}` : key;
  };
  const channels: Record<string, VidKeyframe[]> = {};
  for (const [key, frames] of Object.entries(kf.channels)) {
    const nk = rename(key);
    const prev = channels[nk];
    if (!prev) { channels[nk] = frames; continue; }
    // 两枚旧 id 真撞到同一枚新 id（理论上不会）：同刻只留一枚，其余按时间序并进来。
    const all = [...prev, ...frames].sort((a, b) => a.t - b.t);
    channels[nk] = all.filter((f, i) => !i || Math.abs(f.t - all[i - 1].t) >= KF_EPS);
  }
  const meta: VidKfMeta | undefined = kf.meta
    ? { layers: Object.fromEntries(Object.entries(kf.meta.layers).map(([id, v]) => [map[id] || id, v])) }
    : undefined;
  return { channels, meta };
};

/** 工作台快照 → 所有者名字表(层名 + 特效名),录制时随档落进去。 */
export const kfSnapshotMeta = (snap: VidKfSnapshot): VidKfMeta => {
  const layers: VidKfMeta['layers'] = {};
  for (const l of snap.layers) {
    const effects: Record<string, string> = {};
    for (const e of l.effects) effects[String(e.id)] = e.type;
    layers[l.id] = { name: l.name || `Layer ${l.id}`, effects };
  }
  return { layers };
};

/** 剪开一枚段时按切点把关键帧也切开：`[u0,u1]`（归一化）这一截重新归一化到 0…1。
 *  两半各自只留自己那一截的帧，切点上补一枚（取该刻的插值）—— 不补的话，剪开之后两半会
 *  各自从头播一遍整段动画。剪完单位仍是归一化，之后各自拉伸都互不影响。 */
export const kfSlice = (kf: VidKeyframes | undefined, u0: number, u1: number): VidKeyframes | undefined => {
  if (!kf) return kf;
  const a = Math.max(0, Math.min(1, u0));
  const b = Math.max(0, Math.min(1, u1));
  const span = b - a;
  if (!(span > 1e-6)) return undefined;
  const channels: Record<string, VidKeyframe[]> = {};
  for (const [key, list] of Object.entries(kf.channels ?? {})) {
    if (!list || !list.length) continue;
    const at = (u: number, fallback: number): VidKfValue => kfSample(kf, key, u) ?? fallback;
    const frames: VidKeyframe[] = [
      { t: 0, v: at(a, list[0].v) },
      ...list.filter(k => k.t > a + 1e-9 && k.t < b - 1e-9)
        .map(k => ({ t: (k.t - a) / span, v: k.v })),
      { t: 1, v: at(b, list[list.length - 1].v) },
    ].sort((x, y) => x.t - y.t);
    const keep: VidKeyframe[] = [];
    for (const f of frames) {
      const prev = keep[keep.length - 1];
      const tt = f.t < 0 ? 0 : f.t > 1 ? 1 : f.t;
      if (prev && Math.abs(prev.t - tt) < 1e-9) keep[keep.length - 1] = { t: prev.t, v: tt >= 1 ? f.v : prev.v };
      else keep.push({ t: tt, v: f.v });
    }
    if (keep.length) channels[key] = keep;
  }
  return { unit: 'norm', channels, meta: kf.meta };
};

/** 采样:一个通道在某**归一化**时刻的值(线性插值;头尾夹取;空通道 = null)。
 *  这是回放引擎要用的那一半 —— 录制先落数据,回放接上来就用同一口。
 *  段内秒进来先过 kfU(clip, local)：归一化之后"段被拉伸/裁短"不需要动任何一枚帧。 */
export const kfSample = (kf: VidKeyframes | undefined, key: string, u: number): VidKfValue | null => {
  const list = kf?.channels[key];
  if (!list || !list.length) return null;
  if (u <= list[0].t) return list[0].v;
  const last = list[list.length - 1];
  if (u >= last.t) return last.v;
  for (let i = 1; i < list.length; i++) {
    if (u <= list[i].t) {
      const a = list[i - 1];
      const b = list[i];
      const k = (u - a.t) / Math.max(b.t - a.t, 1e-6);
      return typeof a.v === 'number' && typeof b.v === 'number' ? a.v + (b.v - a.v) * k : b.v;
    }
  }
  return last.v;
};

/** 一枚段的**归一化**时刻表(升序,同刻合一)。Tracks 段条上的菱形、Keyframes 窗的吸附目标
 *  读的是它的"段内秒"版本 kfLocalTimes —— 界面按秒摊开，模型存归一化。 */
export const kfTimes = (kf: VidKeyframes | undefined, eps = KF_EPS): number[] => {
  const all: number[] = [];
  for (const list of Object.values(kf?.channels ?? {})) for (const k of list ?? []) all.push(k.t);
  all.sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of all) if (!out.length || Math.abs(t - out[out.length - 1]) >= eps) out.push(t);
  return out;
};

/** 这一枚段的关键帧时刻表，**段内秒**（界面口径）。半帧容差按段长换算，与写入那边同一把尺。 */
export const kfLocalTimes = (clip: VidClip | null | undefined, fps = 30): number[] =>
  clip?.keyframes ? kfTimes(clip.keyframes, kfEpsFor(clip, fps)).map(u => kfSec(clip, u)) : [];

/** Processor 占位段里的**执行快照**：Run 确认的当下就在轨上摆好的坑（每段一个、预分配
 *  空间），等对应段跑完把成品放到**上层输出轨**的对应位置 —— 占位段自己留在原地不替换，
 *  所以同一段可以反复重跑（每次覆盖它自己上一次的产物）。里面存着这一段怎么跑的全部信息
 *  —— 接口、参数、每行输入的抽帧窗口（源内秒）—— 中途退出再进来，点占位上的 ▶ 就按快照
 *  原样重放这一段（只跑被点的那个）。 */
export type VidProcPending = {
  /** 同一趟 Run 的所有占位共用一颗（播报/统计用）。 */
  runId: string;
  /** 这一趟是谁发的：processor（接口子图）/ preset（Pipeline Preset 的 block 链）。
   *  缺省 = processor（旧存档）。续跑按它分流：一个 POST /api/execute_interface，
   *  一个 POST /api/preset_video。 */
  kind?: 'processor' | 'preset';
  /** preset 路：preset（block set）的 id + 名字（播报/续跑名字兜底）。 */
  presetId?: string;
  presetName?: string;
  /** preset 路：追加 prompt（与图像模式 preset Run 的 extra prompt 同义）。 */
  extraPrompt?: string;
  /** preset 路：这一趟绑的 Mask 轨（id + 名字快照；空 = 没绑 = 不送 mask）。
   *  绑定轨的画面亮度逐帧当 mask（白 = 覆盖）。 */
  maskTrackId?: string;
  maskTrackName?: string;
  /** 产物替换到哪个输出口（接口的第几号出口）。 */
  port: number;
  /** 接口名（续跑按名解析）+ 下标兜底。 */
  iface: string;
  ifaceNum: number;
  /** 参数快照（manual_values：port → 值）。 */
  params: Record<string, unknown>;
  /** 这一段每行输入的**帧段**（port → {file, f0, n, fps}）：f0 = 源文件内按工程 fps
   *  的起始帧号（整数），n = 帧数。不再存秒 —— 段与段按整数帧号首尾相接，重跑/续跑
   *  不受时间取整影响。 */
  inputs: Record<string, ProcFrameWindow>;
  /** preset 路：这一段的 Mask 轨**帧段**（同形，port 恒 '0'）。没绑 Mask 轨就是空。 */
  maskInputs?: Record<string, ProcFrameWindow>;
  /** 第几段（0 起）/ 共几段。 */
  segIndex: number;
  segCount: number;
};

/** 首帧 / 末帧绑的东西：一枚图片资产（按内容哈希认货），或磁盘上一份 .cud 工程
 *  （后端读它的画面当这一帧）。两者都只在**跑的那一刻**才解析成张量。 */
export type VidGenFrameRef =
  | { kind: 'asset'; hash: string; name?: string }
  | { kind: 'cud'; path: string; name?: string };

/** Video Generator 段的执行快照：这一段要怎么把那台生成器跑一遍。
 *  `ports` 是 Interface tab 里那八个槽绑出来的端口表（**快照**在段上 —— 接口后来改了绑定，
 *  老段仍然按自己当时那份跑），`params` 是端口号 → 值（提示词、宽、高、时长、帧率都在里面）。
 *  时长与段长是**一回事**：改参数段跟着变长变短，拖段尾反过来写回参数。 */
export type VidGenPending = {
  kind: 'video_gen';
  /** 同一趟添加共用一颗（播报/统计用）。 */
  runId: string;
  /** 生成器的身份：名字（续跑按名解析）+ 下标兜底。 */
  iface: string;
  ifaceNum: number;
  /** 产物从哪个出口回来（= 输出轨的口）。 */
  port: number;
  ports: VideoGenPorts;
  /** Fixed FPS：开着 = 这台生成器有一个写死的输出帧率（不往图里喂 fps 端口）。
   *  生成出来的片与工程帧率对不上是正常的 —— 段长只按段自己的长度走。 */
  fixed_fps: boolean;
  /** Fixed FPS 的那个数（1..120）。只在 `fixed_fps` 开着时有意义。 */
  fixed_fps_value?: number;
  /** 参数快照（manual_values：端口号字符串 → 值）。 */
  params: Record<string, unknown>;
  first_frame?: VidGenFrameRef | null;
  last_frame?: VidGenFrameRef | null;
  /** 链着的前一段（= 前一段的 clip id）：后一段的首帧用前一段的末帧。
   *  只在同轨且首尾紧贴时成立，挪开就自动断开（见 pruneVgenChains）。 */
  chainPrev?: string;
  /** 段自己的 prompt preset（轨级提示词之外、这一段独有的那份）。跑的时候渲染成串，
   *  拼在段 prompt 口的纯文本后面、轨级 preset 之前（端口在前、段在后、轨最后）。
   *  空/找不到 = 没配，段 prompt 就是端口里的纯文本。 */
  promptPresetId?: string;
};

/** 一段生成器的**时长参数**（秒）。读的就是 duration 槽绑的那一口。 */
export const vgenDurationOf = (v: VidGenPending): number => {
  const port = v.ports.duration;
  if (!port) return 0;
  const n = Number(v.params[String(port)]);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** 段长写回 duration 参数（双向绑定的另一头）。没绑 duration 口就原样返回。 */
export const vgenWithDuration = (v: VidGenPending, dur: number): VidGenPending => {
  const port = v.ports.duration;
  if (!port) return v;
  const next = Math.max(0.1, Math.round(dur * 100) / 100);
  return { ...v, params: { ...v.params, [String(port)]: next } };
};

/** 生成器**轨**的设置：轨上所有生成器段共享（段上不再有宽高/帧率）。
 *  `fromCanvas` 开着时宽高 = 工作台画布 × scale（跑的这一刻现算），width/height 灰掉。
 *  `fps` 缺省/空 = 不动段的帧率参数；设了 = 跑时覆盖 —— 只对**没开 Fixed FPS**的段生效。 */
export type VidGenTrackCfg = { width: number; height: number; fromCanvas: boolean; scale: number; fps?: number };

/** 把轨上的分辨率设置写回去（轨设置弹窗的 Apply）。 */
export const setVideoGenTrackCfg = (p: VidProject, trackId: string, cfg: VidGenTrackCfg): VidProject => ({
  ...p,
  tracks: p.tracks.map(t => (t.id === trackId ? { ...t, vgenCfg: cfg } : t)),
});

/** 跑这一段时真正的分辨率：轨上有设置就按它 —— fromCanvas 用**当下**的画布尺寸 × scale
 *  （画布没量到就退回存的宽高），否则用存的宽高；轨上还没设置过（老存档）返回 null，
 *  调用方沿用段上的旧参数。 */
export const vgenResolutionOf = (
  p: VidProject, clip: VidClip, canvas?: { w: number; h: number },
): { w: number; h: number } | null => {
  const cfg = p.tracks.find(t => t.id === clip.trackId)?.vgenCfg;
  if (!cfg) return null;
  if (cfg.fromCanvas && canvas && canvas.w > 0 && canvas.h > 0) {
    const s = Number(cfg.scale) > 0 ? Number(cfg.scale) : 1;
    return { w: Math.max(1, Math.round(canvas.w * s)), h: Math.max(1, Math.round(canvas.h * s)) };
  }
  return { w: Math.max(1, Math.round(Number(cfg.width)) || 1), h: Math.max(1, Math.round(Number(cfg.height)) || 1) };
};

/** 跑这一段时真正的帧率：轨上设了就用它 —— 但**只对没开 Fixed FPS 的段**生效（Fixed FPS
 *  的段输出帧率写死在生成器上，轨上的数喂进去也是误会）。轨上没设返回 null，调用方沿用
 *  段上的旧参数。 */
export const vgenFpsOf = (p: VidProject, clip: VidClip): number | null => {
  const cfg = p.tracks.find(t => t.id === clip.trackId)?.vgenCfg;
  const n = Number(cfg?.fps);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** 把轨上的**轨级提示词**（prompt preset id）写回去；传 null/空 = 清掉。 */
export const setVideoGenTrackPreset = (p: VidProject, trackId: string, presetId: string | null): VidProject => ({
  ...p,
  tracks: p.tracks.map(t => (t.id === trackId
    ? { ...t, vgenPromptPresetId: presetId || undefined } : t)),
});

/** 一号槽的**参数值**读写（值都住在 params 里，键是端口号字符串）。 */
export const vgenGet = (v: VidGenPending, slot: keyof VideoGenPorts): unknown => {
  const port = v.ports[slot];
  return port ? v.params[String(port)] : undefined;
};
export const vgenWith = (v: VidGenPending, slot: keyof VideoGenPorts, value: unknown): VidGenPending => {
  const port = v.ports[slot];
  if (!port) return v;
  return { ...v, params: { ...v.params, [String(port)]: value } };
};

/** 工程的音乐时间基：MIDI 段与音频/视频共用同一条时间线（秒），音符自己住在拍上。
 *  BPM / 拍号 / PPQ 是**整份工程**的（与主流 DAW 一致：改 BPM 音符原地不动、听感变快），
 *  循环区间也记在拍上。旧档没有 `music` → 用 `musicOf` 的缺省值（120 / 4/4 / 480）。 */
export type VidMusic = {
  /** 每分钟四分音符数。 */
  tempo: number;
  /** [分子, 分母]。分母只认 2/4/8/16。 */
  timeSig: [number, number];
  /** 导出 .mid 的 tick 密度（每四分音符多少 tick）；内部一律浮点拍。 */
  ppq: number;
  /** 循环区间（拍）。 */
  loop: { on: boolean; a: number; b: number };
};

export const MUSIC_DEFAULT: VidMusic = {
  tempo: 120, timeSig: [4, 4], ppq: 480, loop: { on: false, a: 0, b: 16 },
};

export const musicOf = (p: VidProject): VidMusic => p.music ?? MUSIC_DEFAULT;

/** MIDI 段在**内容拍轴**上的可见窗口 [from, to)。窗口之外（= 左右裁掉的那部分）的音符
 *  仍然留在段上（裁错了可以拉回来），但不画、不响。 */
export const midiClipWindow = (c: VidClip, tempo: number): { from: number; to: number } => {
  const from = Number.isFinite(c.offset) ? c.offset : 0;
  return { from, to: from + secondsToBeat(Math.max(0, c.duration), tempo) };
};

/** 段窗口里真正有效的音符：与窗口相交的那些，按交集裁齐（窗口边缘切进来的音只响切进来的那截）。 */
export const midiNotesInClip = (c: VidClip, tempo: number): MidiNote[] => {
  const notes = c.notes;
  if (!notes || !notes.length) return [];
  const { from, to } = midiClipWindow(c, tempo);
  const out: MidiNote[] = [];
  for (const n of notes) {
    const s = Math.max(n.start, from);
    const e = Math.min(n.start + n.dur, to);
    if (e <= s) continue;
    out.push(s === n.start && e === n.start + n.dur ? n : { ...n, start: s, dur: e - s });
  }
  return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
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
  /** **Video 模式的 Mask**：绑到一条轨道上（该轨的画面亮度逐帧当 mask，白 = 覆盖）。
   *  与图像模式的 Canvas Mask 层是同一个位置的两套形态 —— 视频没有"一张画布上的静态墨迹"
   *  这回事，工作区得跟着帧走。空/找不到轨 = 没绑 = 视作没有 mask（整幅都是工作区）。
   *  Processor 的 mask 口有自己的端口来源，不受这里影响；preset 链（没有输入口）用它。 */
  maskTrackId?: string;
  /** 静音的轨道 id（所有轨类型共用一套）。随工程走：刷新 / 重开 .cud 后还亮着。 */
  muteIds?: string[];
  /** solo 的轨道 id，音频与视频分开记。随工程走，与 `muteIds` 同理。 */
  soloAudioIds?: string[];
  soloVideoIds?: string[];
  /** 音乐时间基（BPM / 拍号 / PPQ / 循环）。MIDI 音符与音频/视频共用一条时间线，
   *  MIDI 段内部按拍记；旧档没有这个字段 → `MUSIC_DEFAULT`。 */
  music?: VidMusic;
  /** 这份工程的**查看模式**（Image / Video / Midi）。它是文档的属性、随 .cud 走：
   *  打开哪份工程就落回它自己存的模式，不再是页面级的一颗开关。旧档没有这个字段 → 'image'。
   *  同一份 .cud 里视频与 MIDI 并存（都在 tracks/clips 里），模式只决定**先看哪一副面孔**。 */
  mode?: 'image' | 'video' | 'midi';
};

/** solo 状态：**音频与视频分开记** —— 一边亮着不影响另一边。空集 = 没有 solo（全部照常）。
 *  住宿主（VidController）的视图，但**持久化**：每次切换都写回工程
 *  （`soloAudioIds` / `soloVideoIds`），随 .cud / 页面存档一起回来 —— 刷新后还亮着。
 *  删轨时由 `removeTrack` 一并摘掉对应 id（否则"solo 亮着但轨没了"会让画面整个空掉）。 */
export type VidSolo = {
  audio: ReadonlySet<string>;
  video: ReadonlySet<string>;
};

/** mute 状态：**所有轨道类型共用一套**（轨道 id 全局唯一，不需要像 solo 那样按域分开）。
 *  同样住宿主的视图，**持久化**在工程的 `muteIds` 里（随 .cud / 页面存档回来），清理口径与 solo 相同。
 *  语义按轨类型：音频轨 = 不响；视频轨 = 监视器不直接显示它的画面；Layer 轨 = 它的段不参与
 *  合成（露出底下）。**mute 优先于 solo**：被静音的轨即使被 solo 也不出声/不显示。
 *  注意 mute 只挡**直接输出**：Layer 合成把视频轨当源帧用时不受影响（合成是主动创作，
 *  mute 是监视便利，不该把用户的合成设置弄坏）。 */
export type VidMute = ReadonlySet<string>;

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
/** 每套图层集吃哪几条视频轨的帧（= 可见图层上启用的 surface attribute 的 `frameTrack`），
 *  由工作台页面报上来（`blend-vid-frame-need`，见 blend_node 的 `pushVidFrameNeed`）。key = layerKey。
 *  图层数据住在页面里，宿主只有这一份摘要 —— 判"Frame source 引用了静音轨"要它。 */
export type VidFrameNeed = Readonly<Record<string, readonly string[]>>;

export type VidController = {
  project: VidProject;
  /** 这份工程属于哪个文档（uid）。逐帧合成的取帧包与底片包都盖着它：工作台显示面只有一块，
   *  换 tab 那一瞬还在飞的旧包必须能被认出来（别人的源帧不许折进自己的面、别人的片段不许当
   *  自己的底）。null = 没有文档（不盖章，工作台照旧按 layerKey 判）。 */
  docUid?: number | null;
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
  /** solo 状态（音频/视频分开）。空集 = 没有 solo。 */
  solo: VidSolo;
  /** 切某条轨的 solo（再点一次取消）。音频轨切音频 solo、视频轨切视频 solo；Layer 轨不接。 */
  toggleSolo: (trackId: string, kind: VidTrackKind) => void;
  /** mute 状态（所有轨类型一套）。空集 = 没有静音。 */
  mute: VidMute;
  /** 切某条轨的 mute（再点一次取消）。**所有轨类型都接** —— 视频/音频/Layer 各有各的语义。 */
  toggleMute: (trackId: string) => void;
  /** 占位段上的 ▶（Processor 段续跑）：按段里的执行快照把这一段单独重放，产物落到输出轨的
   *  对应位置（占位段原地保留，可反复重跑；占用时按钮置灰）。宿主（EditPhase）接线；
   *  Timeline 的片段直接透传。 */
  continueProc?: (clipId: string) => void;
  /** 多选后点 ▶：整批占位段依次重放，顺序 = 从左到右（start 升序）、同起点从下到上。
   *  单段的忙碌闸门/进度/落位仍走 continueProc；这里只负责排序与串行编排。 */
  continueProcMany?: (clipIds: string[]) => void;
  /** 队列中那一段的 ⏸：把它移出队列（后面轮到时不再跑）。正在跑的那段不走这条。 */
  pauseProc?: (clipId: string) => void;
  /** 正在跑的那一段的 ■：只打断这一段的生成，队列里后面的段照常继续。 */
  stopProc?: (clipId: string) => void;
  /** Layer 段合并用：向工作台页要这些图层集的内容签名（key → 签名，两套一致才许合并）。页面不在/超时 = 空表。 */
  layerSigs?: (keys: string[]) => Promise<Record<string, string>>;
  /** 粘贴 Layer 段：请页面把源那套图层整套克隆到新 key。回包 = 旧层 id → 新层 id 的映射
   *  （调用方据此把已复制过来的关键帧通道换到新 id）；null = 页面不在/超时/克隆失败。 */
  layerCopy?: (from: string, to: string) => Promise<Record<string, string> | null>;
  /** 关键帧「手动加帧/出行」取当下值的那一口：向工作台页要**那一套图层集**的 transform + fx 参数
   *  快照（与录制同一条 `blend-vid-kf-get`，按 layerKey 取集 —— 传选中段自己的 key，别拿"活跃那套"
   *  的值录进这一段，回放按层 id 对不上就成了哑帧）。页面不在/超时 = null —— 调用方不动工程。 */
  kfSnapshot?: (layerKey: string) => Promise<VidKfSnapshot | null>;
  /** 每套图层集吃哪几条视频轨的帧（页面报上来的摘要，key = layerKey）。判"Frame source 引用了
   *  静音轨 ⇒ 这一段跳过"要它 —— 图层住在页面里，宿主没有别的来源。引用恒稳，内容变化就地替换。 */
  frameNeed: { current: VidFrameNeed };
  /** 仓库里已经找不到的哈希（工程引用了，但字节不在了）。打开工程与每次改动后刷新：
   *  时间线画红线、Assets 卡挂 MISSING、relink 按它挑目标。 */
  missing: ReadonlySet<string>;
  /** 链接 / 换绑：把"是 `from` 这件货"的引用改指到 `ing`（已入库的那一件）上。`from` 是它
   *  **现在的身份** —— 卡上那件货的 asset / play / src，按身份认（`sameAsset`）。
   *  哈希一致 = 接回同一份字节；不一致 = 换绑（"我当初链错了"）—— 问不问那一句归界面，
   *  这里只管改，因为一次入库才知道新字节是什么。 */
  relink: (from: AssetIdentity, ing: Ingested) => Promise<{ ok: boolean; error?: string }>;
  /** 重新问一遍缺失（删除/relink/入库之后调用；工程变化会自动问）。 */
  recheckMissing: () => void;
};

const MIN_CLIP = 0.05;   // 片段/裁剪的最短寿命（s）
let seq = 0;
export const newVidId = (prefix: string): string =>
  `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

export const vidDuration = (p: VidProject): number =>
  p.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);

/** 工程引用的全部仓库哈希（资产表 + 片段的 `asset`/`play`）。缺失检查与 relink 都按这一份。 */
export const vidAssetRefs = (p: VidProject): string[] => {
  const out = new Set<string>();
  for (const a of p.assets) { if (a.asset) out.add(a.asset); if (a.play) out.add(a.play); }
  for (const c of p.clips) { if (c.asset) out.add(c.asset); if (c.play) out.add(c.play); }
  return [...out];
};

/** 链接 / 换绑：把工程里"是 `from` 这件货"的行**整件**改指 `to`（资产表与片段一起动）。
 *
 *  **两个哈希一起换**（原件 + 代理）：只换一个就会造出"新原件 + 旧代理"的混合体 —— 卡上写着
 *  新文件、播的还是旧片子，比不换更难查。`src` 也一起换，换了哈希却还在播旧 URL 等于没换。
 *
 *  `from` 按**身份**认（`sameAsset`：asset / play / src 任一命中），不是按某一个哈希 ——
 *  老存档里"只有 src、没有哈希"的段因此也换得动；转过码的片子两个哈希对得上任一个就算它。
 *  只动引用了它的行：别的货不受影响。Layer 段不装素材，跳过。 */
export const rebindAsset = (
  p: VidProject,
  from: AssetIdentity,
  to: AssetIdentity & { asset: string; duration?: number; hasAudio?: boolean },
): VidProject => {
  const play = to.play || to.asset;
  const url = '/api/asset_media/' + encodeURIComponent(play);
  // 片段只换身份：它的 `duration` 是"在时间线上占多久"（用户裁出来的），不是源长 ——
  // 换了源就把它改掉，等于顺手毁掉一遍剪辑。
  const fixClip = <T extends AssetIdentity & { src: string }>(row: T): T =>
    sameAsset(row, from) ? { ...row, asset: to.asset, play, src: url } : row;
  // 资产行多带两样：`duration` / `hasAudio` 说的是**源文件本身**（导入时探测一次记下的）。
  // 换了源还留着旧的那两个数，卡上就写着旧片子的时长 —— 那是一句谎话。
  const fixAsset = (a: VidAsset): VidAsset => {
    if (!sameAsset(a, from)) return a;
    return {
      ...a, asset: to.asset, play, src: url,
      duration: Number.isFinite(to.duration) ? Math.max(0, Number(to.duration)) : a.duration,
      hasAudio: typeof to.hasAudio === 'boolean' ? to.hasAudio : a.hasAudio,
    };
  };
  return {
    ...p,
    assets: p.assets.map(fixAsset),
    clips: p.clips.map(c => (c.kind === 'layer' || c.kind === 'midi' ? c : fixClip(c))),
  };
};

export const trackOf = (p: VidProject, id: string): VidTrack | null => p.tracks.find(t => t.id === id) ?? null;

/** 播放头 t 落在哪一段上（按轨道上下序，先命中先赢）。`kind` 缺省 = 不挑类型。 */
export const clipAt = (p: VidProject, t: number, kind?: VidTrackKind): VidClip | null => {
  for (const tr of p.tracks) {
    // process 轨只有占位段；MIDI 轨的声音走音序器，也不参与"这一刻哪段画面/音频在播"。
    if (tr.kind === 'process' || tr.kind === 'midi') continue;
    if (kind && tr.kind !== kind) continue;
    const hit = p.clips.find(c => c.trackId === tr.id && !c.pending && t >= c.start && t < c.start + c.duration);
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

/** 监视器上的视频段查找：**mute 的轨一律跳过**（mute 优先于 solo —— 被静音的轨即使 solo
 *  也不出画面）；**视频 solo 亮着时，剩下的里面只认 solo 轨上的段** —— 其余视频轨的画面不参与
 *  监视器（段照常在时间线上，只是不播）。没有 solo/mute 时与 clipAt(…, 'video') 等价。
 *  solo/mute 集合里的轨可能已被删掉（删轨后到清理 effect 跑之前）：那些 id 不在 tracks 里，
 *  自然被跳过 —— 不会因此把画面整个挡掉。 */
/** 段按轨分桶(一次 O(n)):播放循环里 clipAtSolo / compositePlanAt / 音频对表每帧都要
 *  "每条轨找 t 处的段",各扫一遍全表是 O(轨×段) —— 桶化后每轨只在自家桶里找。
 *  **每帧调 4~6 次、而工程对象是只读的**（写口全是"旧 project 进、新 project 出"）：按
 *  `p.clips` 的数组身份缓存一份，同一帧里后面几次直接拿现成的。工程一改就是新数组 ⇒ 自动失效。 */
let bucketOf: VidClip[] | null = null;
let bucketVal: Map<string, VidClip[]> | null = null;
export const clipsByTrack = (p: VidProject): Map<string, VidClip[]> => {
  if (bucketVal && bucketOf === p.clips) return bucketVal;
  const m = new Map<string, VidClip[]>();
  for (const c of p.clips) {
    const b = m.get(c.trackId);
    if (b) b.push(c); else m.set(c.trackId, [c]);
  }
  bucketOf = p.clips;
  bucketVal = m;
  return m;
};

export const clipAtSolo = (p: VidProject, t: number, soloVideo: ReadonlySet<string>,
  muted: ReadonlySet<string>): VidClip | null => {
  const buckets = clipsByTrack(p);
  for (const tr of p.tracks) {
    if (tr.kind !== 'video') continue;
    if (muted.has(tr.id)) continue;                        // mute 优先
    if (soloVideo.size > 0 && !soloVideo.has(tr.id)) continue;
    const hit = (buckets.get(tr.id) || []).find(c => !c.pending && t >= c.start && t < c.start + c.duration);
    if (hit) return hit;
  }
  return null;
};

/** 这段音频要不要响：**mute 的轨一律不响**（优先于 solo）；有音频 solo 时，非 solo 轨上的段
 *  也不响（与视频 solo 无关，两边分开）。 */
export const audioAudible = (trackId: string, soloAudio: ReadonlySet<string>,
  muted: ReadonlySet<string>): boolean =>
  !muted.has(trackId) && (soloAudio.size === 0 || soloAudio.has(trackId));

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
      // Layer / process（生成器、处理器占位）/ MIDI 段没有"源文件时长"这条边界：两条边都不受
      // 限制（它们的 srcDuration 只是造段那一刻的长度）—— 否则永远拉不过造出来时的长度。
      const timeless = c.kind === 'layer' || c.kind === 'process' || c.kind === 'midi';
      if (edge === 'l') {
        // 左边：start 最多退到 start-offset（源的开头），最多进到 start+duration-MIN。
        const lo = timeless ? 0 : Math.max(0, c.start - c.offset);
        const hi = c.start + c.duration - MIN_CLIP;
        const ns = Math.min(hi, Math.max(lo, t));
        const d = ns - c.start;
        // MIDI 段的 offset 是**拍**：左裁把窗口在内容里平移，允许为负（内容前面留白）。
        if (c.kind === 'midi') {
          return {
            ...c, start: ns, duration: c.duration - d,
            offset: c.offset + secondsToBeat(d, musicOf(p).tempo),
          };
        }
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
    // 关键帧按切点切开、各自重新归一化（见 kfSlice）：不切的话两半会各从头播一遍整段动画。
    const uCut = kfU(c, cut);
    const kfL = c.keyframes ? kfSlice(c.keyframes, 0, uCut) : undefined;
    const kfR = c.keyframes ? kfSlice(c.keyframes, uCut, 1) : undefined;
    clips.push({ ...c, groupId: gLeft, duration: cut, ...(c.keyframes ? { keyframes: kfL } : {}) });
    // 占位段切开后右半丢掉 pending：两半都揣着同一段的快照，各点各的 ▶ 会把这一段跑两遍。
    const { pending: _dropR, ...right } = c;
    // MIDI 段窗口在内容拍轴上切：右半的 offset 推进的是**拍**；音符本身两边都留着，
    // 各自按窗口显示（左半看不到切点之后、右半看不到切点之前）。
    const rightOffset = c.kind === 'midi'
      ? c.offset + secondsToBeat(cut, musicOf(p).tempo) : c.offset + cut;
    clips.push({ ...right, id: newVidId('clip'), groupId: gRight, start: c.start + cut, duration: c.duration - cut, offset: rightOffset,
      ...(c.keyframes ? { keyframes: kfR } : {}) });
  }
  return changed ? { ...p, clips } : p;
};

/** 解绑：联动组全体摘掉 groupId —— 此后各自拖各自裁（音画错开的正式手续）。 */
export const unlinkGroup = (p: VidProject, groupId: string): VidProject =>
  ({ ...p, clips: p.clips.map(c => (c.groupId === groupId ? { ...c, groupId: undefined } : c)) });

// ── 复制 / 粘贴 ────────────────────────────────────────────────────────────────────────────
// 剪贴板里放的是**一份脱钩的快照**（不是原件引用）：原件之后被裁剪 / 改参数 / 删掉，都跟这次复制
// 没关系。粘贴才发新 id —— 同一份快照可以反复粘，每粘一次都是独立的一段。
//
// 身份字段的规矩（照 mergeVidClips 的先例）：
//  · groupId 重新发号，但**同一组内部的对应关系保留**（音画一对粘出来还是一对）；
//  · procOwner 摘掉 —— 副本不是任何占位段的产物（重跑旧占位时它会报"槽位被占"，而不是被静默换掉）；
//  · pending / vgen 的 runId 换新 —— 不能让副本被算进原件那一趟 Run 的"还剩几段"里；
//  · vgen.chainPrev 只在链的上一段**也被复制**时改指副本，否则断开；
//  · layerKey 见 pasteVidClips 的注释（图层集是页面那边的活数据，得请它克隆一份）。
export type VidClipClipboard = {
  /** 这批段最早的起点（s）：粘贴时把锚点放在播放头，其余段保持相对位置。 */
  anchor: number;
  /** 按 start 升序的快照（start 仍是复制时的时间线坐标，粘贴时统一平移）。 */
  clips: VidClip[];
};

/** 执行快照的浅克隆（`params` / 帧窗口各存一份）：剪贴板里的那份不许跟原件共指，
 *  否则之后原地改参数会连剪贴板一起改掉。 */
const cloneProcPending = (pd: VidProcPending): VidProcPending => ({
  ...pd,
  params: { ...pd.params },
  inputs: Object.fromEntries(Object.entries(pd.inputs).map(([k, w]) => [k, { ...w }])),
  ...(pd.maskInputs
    ? { maskInputs: Object.fromEntries(Object.entries(pd.maskInputs).map(([k, w]) => [k, { ...w }])) }
    : {}),
});

const cloneVgenPending = (v: VidGenPending): VidGenPending => ({
  ...v,
  params: { ...v.params },
  ports: { ...v.ports },
  first_frame: v.first_frame ? { ...v.first_frame } : v.first_frame,
  last_frame: v.last_frame ? { ...v.last_frame } : v.last_frame,
});

/** 复制：选中的段 + 它们的联动组同伴（组是一个逻辑单位，只抄一半粘出来就是残的）。 */
export const copyVidClips = (p: VidProject, ids: readonly string[]): VidClipClipboard | null => {
  const want = new Set<string>();
  const groups = new Set<string>();
  for (const c of p.clips) {
    if (!ids.includes(c.id)) continue;
    want.add(c.id);
    if (c.groupId) groups.add(c.groupId);
  }
  if (!want.size) return null;
  const clips = p.clips
    .filter(c => want.has(c.id) || (c.groupId && groups.has(c.groupId)))
    .map(c => ({
      ...c,
      ...(c.notes ? { notes: c.notes.map(n => ({ ...n })) } : {}),
      ...(c.pending ? { pending: cloneProcPending(c.pending) } : {}),
      ...(c.vgen ? { vgen: cloneVgenPending(c.vgen) } : {}),
    }))
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const anchor = clips[0].start;
  return { anchor, clips };
};

export type VidPasteResult = {
  project: VidProject;
  /** 新段的 id（选择用）。 */
  ids: string[];
  /** Layer 段要请页面克隆的图层集：from = 源 key，to = 新 key（= 新段 id）。
   *  调用方拿到回执前，那一段先共用源 key（内容一定对）；回执成功再把 layerKey 改成 `to`。 */
  layerCopies: { from: string; to: string; clipId: string }[];
  /** 原轨不在了、又没有同类的轨 ⇒ 这一段粘不了。 */
  skipped: number;
};

/** 粘贴：`at` = 播放头。**这批段里最早的那一段从 `at` 开始**，其余按原来的相对位置排开。 */
export const pasteVidClips = (p: VidProject, cb: VidClipClipboard, at: number): VidPasteResult => {
  const t = Math.max(0, Number(at) || 0);
  // 轨道：原轨还在就回原轨；不在了退到同类的第一条。一条同类的都没有 ⇒ 跳过（不顺手造轨 ——
  // 粘一段视频却凭空长出一条轨，不是用户按 Ctrl+V 想要的事）。
  const trackFor = (c: VidClip): string | null => {
    const own = p.tracks.find(x => x.id === c.trackId);
    if (own && own.kind === c.kind) return own.id;
    const same = p.tracks.find(x => x.kind === c.kind);
    return same ? same.id : null;
  };
  const idMap = new Map<string, string>();        // 旧 id → 新 id（组 / 链 / 图层认亲都用它）
  for (const c of cb.clips) idMap.set(c.id, newVidId(c.kind === 'layer' ? 'lcl' : c.kind === 'midi' ? 'mcl' : 'clip'));
  const groupMap = new Map<string, string>();
  const stamp = `copy-${Date.now()}`;
  const clips: VidClip[] = [];
  const layerCopies: VidPasteResult['layerCopies'] = [];
  let skipped = 0;
  for (const c of cb.clips) {
    const trackId = trackFor(c);
    if (!trackId) { skipped++; continue; }
    const id = idMap.get(c.id)!;
    let groupId: string | undefined;
    if (c.groupId) {
      groupId = groupMap.get(c.groupId);
      if (!groupId) { groupId = newVidId('grp'); groupMap.set(c.groupId, groupId); }
    }
    // 图层集：先共用源那套（画面一定对得上），克隆回执到了再由调用方改成新 key。
    const fromKey = c.layerKey || c.id;
    if (c.kind === 'layer') layerCopies.push({ from: fromKey, to: id, clipId: id });
    const next: VidClip = {
      ...c,
      id,
      trackId,
      groupId,
      start: Math.max(0, t + (c.start - cb.anchor)),
      procOwner: undefined,
      ...(c.kind === 'layer' ? { layerKey: fromKey } : {}),
      // 音符是段自己的内容：副本必须换一批 id（同一枚音的 id 在工程里不该出现两次）。
      ...(c.notes ? { notes: c.notes.map(n => ({ ...n, id: newVidId('mn') })) } : {}),
      ...(c.pending
        ? { pending: { ...cloneProcPending(c.pending), runId: `${stamp}-p-${id}` } }
        : {}),
      ...(c.vgen
        ? {
          vgen: {
            ...cloneVgenPending(c.vgen),
            runId: `${stamp}-g-${id}`,
            chainPrev: c.vgen.chainPrev ? idMap.get(c.vgen.chainPrev) : undefined,
          },
        }
        : {}),
    };
    clips.push(next);
  }
  return {
    project: clips.length ? { ...p, clips: [...p.clips, ...clips] } : p,
    ids: clips.map(c => c.id),
    layerCopies,
    skipped,
  };
};

// ── 资产库 ────────────────────────────────────────────────────────────────────────────────
/** 两行资产是不是**同一件货**：认三样身份里的任意一样 —— 原件哈希（asset）、可播哈希（play）、
 *  地址（src）。只比 src 是不够的：同一份字节在仓库里有两个地址面
 *  （`/api/vid_media/<file>` 与 `/api/asset_media/<hash>`），同一段片子因此会记成两行 ——
 *  窗里就是「同一段视频两张卡、各算各的 N clips」，而且从哪张卡拖下去的还会再长一行。 */
export const sameAsset = (
  a: { src?: string; asset?: string; play?: string },
  b: { src?: string; asset?: string; play?: string },
): boolean =>
  (!!a.asset && a.asset === b.asset)
  || (!!a.play && a.play === b.play)
  || (!!a.src && a.src === b.src);

/** 收一件资产：同一件货只留一份（重复拖进来 = 认领已有的那件）。 */
export const addAsset = (p: VidProject, a: VidAsset): VidProject =>
  p.assets.some(x => sameAsset(x, a))
    ? p
    : { ...p, assets: [...p.assets, a] };

/** 扔掉一件资产：已经落进时间线的片段不受影响（它们自己揣着 src），只是不能再用它拖新的。 */
export const removeAsset = (p: VidProject, id: string): VidProject =>
  ({ ...p, assets: p.assets.filter(a => a.id !== id) });

/** 「谁在用它」的索引：一件货的每一样身份（asset / play / src）→ 用它的片段 id 集合。
 *
 *  为什么不是只按 src 计数：一件货在盘上有两个地址面（见 `sameAsset`），片段自己揣着三样身份，
 *  只比 src 的后果是"明明在用，卡上写 0 clips"，而且拖法一变结论就变。这里把三样都记进索引，
 *  查询时取并集（一段同时命中两样也只算一段）。放模型里而不是窗里，是因为这条判据是**数据**
 *  的事（谁引用谁），窗只是把它画成一行字。 */
export const clipUseIndex = (clips: VidClip[]): Map<string, Set<string>> => {
  const m = new Map<string, Set<string>>();
  const put = (k: string | undefined, id: string) => {
    if (!k) return;
    const set = m.get(k);
    if (set) set.add(id); else m.set(k, new Set([id]));
  };
  for (const c of clips) { put(c.asset, c.id); put(c.play, c.id); put(c.src, c.id); }
  return m;
};

/** 索引查询：`keys` = 一件货的全部身份，返回去重后的引用段数。 */
export const usedByCount = (idx: Map<string, Set<string>>, ...keys: (string | null | undefined)[]): number => {
  const ids = new Set<string>();
  for (const k of keys) {
    if (!k) continue;
    const set = idx.get(k);
    if (set) for (const id of set) ids.add(id);
  }
  return ids.size;
};

/** 新 MIDI 轨的下一个通道：绕开 9（鼓是协议固定）与已被占用的号；16 个都占满就回到 0。 */
const nextMidiChannel = (p: VidProject): number => {
  const used = new Set(p.tracks.filter(t => t.kind === 'midi').map(t => t.channel ?? 0));
  for (let ch = 0; ch < 16; ch++) if (ch !== 9 && !used.has(ch)) return ch;
  for (let ch = 0; ch < 16; ch++) if (!used.has(ch)) return ch;
  return 0;
};

export const addTrack = (p: VidProject, kind: VidTrackKind, name?: string): VidProject => {
  const n = p.tracks.filter(t => t.kind === kind).length + 1;
  const title = name?.trim() || (kind === 'video' ? `Video ${n}` : kind === 'layer' ? `Layer ${n}`
    : kind === 'process' ? `Process ${n}` : kind === 'midi' ? `MIDI ${n}` : `Audio ${n}`);
  const track: VidTrack = kind === 'midi'
    ? {
      id: newVidId('trk'), kind, name: title,
      channel: nextMidiChannel(p), instrument: '', velScale: 1,
      color: TRACK_COLORS[p.tracks.filter(t => t.kind === 'midi').length % TRACK_COLORS.length],
    }
    : { id: newVidId('trk'), kind, name: title };
  // 视频轨 / Layer 轨 / process 轨插到最上面（序 = 数组序，也是渲染的上下序），
  // 音频轨与 MIDI 轨排到底部（声域在下半区）。
  const tracks = kind === 'audio' || kind === 'midi' ? [...p.tracks, track] : [track, ...p.tracks];
  return { ...p, tracks };
};

/** 改 MIDI 轨的轨级设置（名字 / 通道 / 乐器 / 力度基线 / 色点）。非 MIDI 轨原样不动。 */
export const updateMidiTrack = (
  p: VidProject,
  trackId: string,
  patch: Partial<Pick<VidTrack, 'name' | 'channel' | 'instrument' | 'velScale' | 'color'>>,
): VidProject => ({
  ...p,
  tracks: p.tracks.map(t => {
    if (t.id !== trackId || t.kind !== 'midi') return t;
    const next: VidTrack = { ...t, ...patch };
    if (patch.name !== undefined) next.name = patch.name.trim() || t.name;
    next.channel = clampInt(next.channel ?? 0, 0, 15);
    next.instrument = String(next.instrument ?? '');
    next.velScale = clampNum(next.velScale ?? 1, 0.1, 2);
    return next;
  }),
});

/** 在 MIDI 轨上造一段**空段**（双击轨道）：4 小节长，窗口从内容第 0 拍开始。
 *  起点就是**点下去的那一刻**（不像素材段那样吸到轨尾 —— 空轨吸到轨尾 = 永远落在 0，
 *  "在第 9 小节双击、段跑到第 1 小节"）。点进了一段里就顺到那一段的尾巴，连点两次不叠。
 *  `id` 可由调用方给（Tracks 双击后要当场选中这一段，不能等 React 更新完再回头找）。 */
export const addMidiClip = (p: VidProject, trackId: string, at: number, beats = 16, id = newVidId('mcl')): VidProject => {
  const track = trackOf(p, trackId);
  if (!track || track.kind !== 'midi') return p;
  const tempo = musicOf(p).tempo;
  const lenBeats = Math.max(1, Number(beats) || 16);
  const dur = beatToSeconds(lenBeats, tempo);
  let start = Math.max(0, Number(at) || 0);
  // 同一轨上已有的段：点进去就和它叠了 → 顺到这个（串联的）冲突段之后。
  for (const c of p.clips) {
    if (c.trackId !== trackId || c.kind !== 'midi') continue;
    if (start < c.start + c.duration && start + dur > c.start) start = c.start + c.duration;
  }
  const clip: VidClip = {
    id, trackId, kind: 'midi', name: 'MIDI ' + (p.clips.filter(c => c.kind === 'midi' && c.trackId === trackId).length + 1),
    src: '', origin: 'asset', start, duration: dur,
    offset: 0, srcDuration: lenBeats, hasAudio: false, notes: [],
  };
  return { ...p, clips: [...p.clips, clip] };
};

/** 把段上的音符整批换掉（编辑器写回用；调用方负责拍 ↔ 段的换算）。 */
export const setMidiClipNotes = (p: VidProject, clipId: string, notes: MidiNote[]): VidProject => {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { ...p, clips: p.clips.map(c => (c.id === clipId && c.kind === 'midi' ? { ...c, notes: sorted } : c)) };
};

/** 段在**全局拍轴**上的原点（= 段起点对应的拍）。音符的全局拍 = 这个数 + (n.start - 窗口起点)。 */
export const midiClipOriginBeat = (p: VidProject, c: VidClip): number =>
  secondsToBeat(c.start, musicOf(p).tempo);

/** 一条 MIDI 轨上所有**能听见**的音符（裁到段窗口内），坐标换算到**全局拍**。
 *  投影、编辑视图、写回三条路都用它 —— 换算只写这一处。 */
const midiTrackNotesGlobal = (p: VidProject, trackId: string): MidiNote[] => {
  const tempo = musicOf(p).tempo;
  const out: MidiNote[] = [];
  for (const c of p.clips) {
    if (c.trackId !== trackId || c.kind !== 'midi') continue;
    const origin = midiClipOriginBeat(p, c);
    const { from } = midiClipWindow(c, tempo);
    for (const n of midiNotesInClip(c, tempo)) out.push({ ...n, start: origin + (n.start - from) });
  }
  return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
};

/** 喂给引擎/外部端口的只读投影：所有 MIDI 轨 + 音符换算到**全局拍**。
 *  - 只用段窗口里的音符（裁掉的部分不响，与界面一致）；
 *  - 每条 MIDI 轨都在，**空轨也留**（引擎按 id 认乐器，漏一条就等于把它卸了）；
 *  - 段上的音符是内容拍，`start` 是时间线秒 —— 换算是 `秒→拍 + (音符 - 窗口起点)`。 */
export const midiProjectOf = (p: VidProject): MidiProject => {
  const music = musicOf(p);
  const muted = new Set(p.muteIds ?? []);
  const soloed = new Set(p.soloAudioIds ?? []);
  const tracks = p.tracks.filter(t => t.kind === 'midi').map((t, idx) => ({
    id: t.id,
    name: t.name,
    channel: clampInt(t.channel ?? 0, 0, 15),
    instrument: t.instrument ?? '',
    velScale: clampNum(t.velScale ?? 1, 0.1, 2),
    mute: muted.has(t.id),
    solo: soloed.has(t.id),
    color: t.color || TRACK_COLORS[idx % TRACK_COLORS.length],
    notes: midiTrackNotesGlobal(p, t.id),
  }));
  return {
    version: 1,
    tempo: music.tempo,
    timeSig: music.timeSig,
    ppq: music.ppq,
    tracks,
    loop: music.loop,
    selTrack: tracks[0]?.id ?? '',
    selNote: '',
  };
};

/** 钢琴卷帘的编辑视图：时间线上选中那一段。没有选中 / 不是 MIDI 段 = null。
 *  音符换成**段内拍**（0 = 窗口第一拍），窗口外（左/右裁掉）的音符不在这里 —— 写回时由
 *  `applyEditorNotes` 按 id 做差量，隐藏的那部分原样留着。 */
export const midiEditorOf = (p: VidProject, clipId: string | null | undefined): MidiEditor | null => {
  if (!clipId) return null;
  const c = p.clips.find(x => x.id === clipId);
  if (!c || c.kind !== 'midi') return null;
  const tr = p.tracks.find(t => t.id === c.trackId && t.kind === 'midi');
  if (!tr) return null;
  const music = musicOf(p);
  const { from } = midiClipWindow(c, music.tempo);
  const origin = midiClipOriginBeat(p, c);
  const muted = new Set(p.muteIds ?? []);
  const soloed = new Set(p.soloAudioIds ?? []);
  const idx = p.tracks.filter(t => t.kind === 'midi').findIndex(t => t.id === tr.id);
  const track: MidiTrack = {
    id: tr.id,
    name: tr.name,
    channel: clampInt(tr.channel ?? 0, 0, 15),
    instrument: tr.instrument ?? '',
    velScale: clampNum(tr.velScale ?? 1, 0.1, 2),
    mute: muted.has(tr.id),
    solo: soloed.has(tr.id),
    color: tr.color || TRACK_COLORS[Math.max(0, idx) % TRACK_COLORS.length],
    notes: midiNotesInClip(c, music.tempo).map(n => ({ ...n, start: n.start - from })),
  };
  return {
    clipId: c.id,
    trackId: tr.id,
    track,
    length: Math.max(MIN_DUR, secondsToBeat(Math.max(0, c.duration), music.tempo)),
    baseBeat: origin + from,
    contentOffset: from,
    tempo: music.tempo,
    timeSig: music.timeSig,
    ppq: music.ppq,
    loop: { on: music.loop.on, a: music.loop.a - (origin + from), b: music.loop.b - (origin + from) },
  };
};

/** 卷帘写回：`next` 是编辑视图那条轨（段内拍）。按 id 做**差量**：
 *  - 窗口外的音符不在 base/next 里，原样保留（左裁掉的头、右裁掉的尾都还在段内容里）；
 *  - 窗口边上被裁过的长音，用"位移量"套回它在内容里的真身，隐藏的那截不会被截断。 */
export const applyEditorNotes = (p: VidProject, editor: MidiEditor, next: MidiTrack): VidProject => {
  const c = p.clips.find(x => x.id === editor.clipId);
  if (!c || c.kind !== 'midi') return p;
  const base = new Map(editor.track.notes.map(n => [n.id, n]));
  const nextMap = new Map(next.notes.map(n => [n.id, n]));
  const out: MidiNote[] = [];
  for (const orig of c.notes ?? []) {
    const b = base.get(orig.id);
    if (!b) { out.push(orig); continue; }          // 窗口外：看不见的音符不归卷帘管
    const n = nextMap.get(orig.id);
    if (!n) continue;                              // 删了
    out.push({
      ...orig,
      pitch: clampInt(n.pitch, 0, 127),
      vel: clampInt(n.vel, MIN_VEL, MAX_VEL),
      start: Math.max(0, orig.start + (n.start - b.start)),
      dur: Math.max(MIN_DUR, orig.dur + (n.dur - b.dur)),
    });
  }
  for (const n of next.notes) {
    if (base.has(n.id)) continue;                  // 改过的已经在上面写过
    out.push({
      id: n.id || newVidId('mn'),
      pitch: clampInt(n.pitch, 0, 127),
      vel: clampInt(n.vel, MIN_VEL, MAX_VEL),
      start: Math.max(0, editor.contentOffset + Math.max(0, n.start)),
      dur: Math.max(MIN_DUR, n.dur),
    });
  }
  out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { ...p, clips: p.clips.map(x => (x.id === c.id ? { ...x, notes: out } : x)) };
};

/** 轨级投影写回：agent/工具改的是"整份投影"（轨属性 + M/S + 音符），这里把它并回工程。
 *  音符写回按 id 认段：同一枚音留在原段、用位移量套回内容拍；新音符落到窗口包住它的那一段。 */
const writeTrackNotes = (
  p: VidProject, trackId: string, prevNotes: MidiNote[], nextNotes: MidiNote[],
): VidProject => {
  const clips = p.clips.filter(c => c.trackId === trackId && c.kind === 'midi');
  if (!clips.length) return p;
  const tempo = musicOf(p).tempo;
  const windows = new Map(clips.map(c => [c.id, midiClipWindow(c, tempo)]));
  const origins = new Map(clips.map(c => [c.id, midiClipOriginBeat(p, c)]));
  const sets = new Map(clips.map(c => [c.id, [...(c.notes ?? [])]]));
  const homeOf = new Map<string, string>();
  for (const c of clips) for (const n of c.notes ?? []) homeOf.set(n.id, c.id);
  const prevMap = new Map(prevNotes.map(n => [n.id, n]));
  const nextMap = new Map(nextNotes.map(n => [n.id, n]));
  for (const b of prevNotes) {
    if (nextMap.has(b.id)) continue;
    const home = homeOf.get(b.id);
    if (!home) continue;
    const arr = sets.get(home)!;
    const k = arr.findIndex(n => n.id === b.id);
    if (k >= 0) arr.splice(k, 1);
  }
  for (const n of nextNotes) {
    const b = prevMap.get(n.id);
    const home = b ? homeOf.get(n.id) : undefined;
    if (b && home) {
      const arr = sets.get(home)!;
      const k = arr.findIndex(x => x.id === n.id);
      if (k >= 0) {
        const orig = arr[k];
        arr[k] = {
          ...orig,
          pitch: clampInt(n.pitch, 0, 127),
          vel: clampInt(n.vel, MIN_VEL, MAX_VEL),
          start: Math.max(0, orig.start + (n.start - b.start)),
          dur: Math.max(MIN_DUR, orig.dur + (n.dur - b.dur)),
        };
        continue;
      }
    }
    // 新音符（或换了段）：落到窗口包住它的那一段，否则第一段。
    const target = clips.find(c => {
      const w = windows.get(c.id)!;
      return n.start >= w.from && n.start < w.to;
    }) ?? clips[0];
    const w = windows.get(target.id)!;
    const origin = origins.get(target.id)!;
    sets.get(target.id)!.push({
      id: n.id || newVidId('mn'),
      pitch: clampInt(n.pitch, 0, 127),
      vel: clampInt(n.vel, MIN_VEL, MAX_VEL),
      start: Math.max(0, w.from + (n.start - origin)),
      dur: Math.max(MIN_DUR, n.dur),
    });
  }
  return {
    ...p,
    clips: p.clips.map(c => {
      const arr = sets.get(c.id);
      return arr ? { ...c, notes: arr.sort((a, b) => a.start - b.start || a.pitch - b.pitch) } : c;
    }),
  };
};

export const applyMidiProject = (p: VidProject, prev: MidiProject, next: MidiProject): VidProject => {
  if (prev === next) return p;
  let out = p;
  const pm = musicOf(p);
  if (pm.tempo !== next.tempo || pm.timeSig !== next.timeSig || pm.ppq !== next.ppq
    || pm.loop !== next.loop) {
    out = {
      ...out,
      music: { tempo: next.tempo, timeSig: next.timeSig, ppq: next.ppq, loop: next.loop },
    };
  }
  const prevTracks = new Map(prev.tracks.map(t => [t.id, t]));
  const nextTracks = new Map(next.tracks.map(t => [t.id, t]));
  for (const t of next.tracks) {
    const b = prevTracks.get(t.id);
    if (b && b.notes !== t.notes) out = writeTrackNotes(out, t.id, b.notes, t.notes);
  }
  const removed = new Set(prev.tracks.filter(t => !nextTracks.has(t.id)).map(t => t.id));
  if (removed.size) {
    out = { ...out, clips: out.clips.filter(c => !removed.has(c.trackId)) };
  }
  const nonMidi = out.tracks.filter(t => t.kind !== 'midi' && !removed.has(t.id));
  const midiTracks: VidTrack[] = next.tracks.map((t, idx) => {
    const old = out.tracks.find(x => x.id === t.id);
    return {
      ...(old ?? { id: t.id, kind: 'midi' as const }),
      id: t.id,
      kind: 'midi' as const,
      name: (t.name || '').trim() || old?.name || `MIDI ${idx + 1}`,
      channel: clampInt(t.channel, 0, 15),
      instrument: t.instrument,
      velScale: clampNum(t.velScale, 0.1, 2),
      color: t.color || old?.color,
    };
  });
  out = { ...out, tracks: [...nonMidi, ...midiTracks] };
  const mute = new Set(out.muteIds ?? []);
  const solo = new Set(out.soloAudioIds ?? []);
  for (const t of next.tracks) {
    if (t.mute) mute.add(t.id); else mute.delete(t.id);
    if (t.solo) solo.add(t.id); else solo.delete(t.id);
  }
  for (const id of removed) { mute.delete(id); solo.delete(id); }
  return { ...out, muteIds: [...mute], soloAudioIds: [...solo] };
};

/** 音乐时间基的宽容读法：缺项用 `fallback`，坏值夹回合法区间。 */
export const normalizeMusic = (raw: unknown, fallback: VidMusic = MUSIC_DEFAULT): VidMusic => {
  if (!raw || typeof raw !== 'object') return fallback;
  const o = raw as Record<string, unknown>;
  const tempoRaw = Number(o.tempo);
  const tempo = Number.isFinite(tempoRaw) ? clampNum(tempoRaw, MIN_TEMPO, MAX_TEMPO) : fallback.tempo;
  const tsRaw = Array.isArray(o.timeSig) ? o.timeSig : fallback.timeSig;
  const num = clampInt(tsRaw[0], 1, 16);
  const denRaw = Math.round(Number(tsRaw[1]));
  const den = [2, 4, 8, 16].includes(denRaw) ? denRaw : fallback.timeSig[1];
  const ppqRaw = Number(o.ppq);
  const ppq = Number.isFinite(ppqRaw) ? clampInt(ppqRaw, 24, 3840) : fallback.ppq;
  const loopRaw = (o.loop && typeof o.loop === 'object' ? o.loop : {}) as Record<string, unknown>;
  const aRaw = Number(loopRaw.a);
  const bRaw = Number(loopRaw.b);
  const a = Number.isFinite(aRaw) ? Math.max(0, aRaw) : fallback.loop.a;
  const b = Math.max(a + 1, Number.isFinite(bRaw) ? bRaw : fallback.loop.b);
  return {
    tempo,
    timeSig: [num, den],
    ppq,
    loop: { on: typeof loopRaw.on === 'boolean' ? loopRaw.on : fallback.loop.on, a, b },
  };
};

/** 音符的宽容读法：坏值夹回合法区间，id 缺了就补一个。读档与迁移共用这一份口径。 */
const sanitizeMidiNotes = (raw: unknown): MidiNote[] => {
  if (!Array.isArray(raw)) return [];
  const notes: MidiNote[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const n = item as Record<string, unknown>;
    notes.push({
      id: typeof n.id === 'string' && n.id ? n.id : newVidId('mn'),
      pitch: clampInt(n.pitch, 0, 127),
      start: Math.max(0, Number(n.start) || 0),
      dur: Math.max(MIN_DUR, Number(n.dur) || MIN_DUR),
      vel: clampInt(n.vel, MIN_VEL, MAX_VEL),
    });
  }
  return notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
};

// ── 老档迁移：`VidProject.midi`（一份并列的 MidiProject）→ 统一轨/段 ────────────────────────
// 只做一次：读档时搬进 tracks/clips，写出去的工程里不再有这个键（见 normalizeVidProject）。
// 只有"确实装过东西"的轨才搬（有音符或挂了乐器）—— 旧档默认那四条空轨不该凭空长出来。
const migrateLegacyMidi = (
  raw: unknown,
  music: VidMusic,
): { tracks: VidTrack[]; clips: VidClip[]; music: VidMusic; muteIds: string[]; soloAudioIds: string[] } | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.tracks)) return null;
  const migratedMusic = normalizeMusic({
    tempo: o.tempo, timeSig: o.timeSig, ppq: o.ppq, loop: o.loop,
  }, music);
  const tracks: VidTrack[] = [];
  const clips: VidClip[] = [];
  const muteIds: string[] = [];
  const soloAudioIds: string[] = [];
  let idx = 0;
  for (const rawTrack of o.tracks) {
    if (!rawTrack || typeof rawTrack !== 'object') continue;
    const t = rawTrack as Record<string, unknown>;
    const notes = sanitizeMidiNotes(t.notes);
    const instrument = typeof t.instrument === 'string' ? t.instrument : '';
    if (!notes.length && !instrument) continue;
    const id = typeof t.id === 'string' && t.id ? t.id : newVidId('trk');
    const trackId = tracks.some(x => x.id === id) ? newVidId('trk') : id;
    tracks.push({
      id: trackId,
      kind: 'midi',
      name: typeof t.name === 'string' && t.name ? t.name : `MIDI ${tracks.length + 1}`,
      channel: clampInt(t.channel, 0, 15),
      instrument,
      velScale: clampNum(t.velScale, 0.1, 2),
      color: typeof t.color === 'string' && t.color ? t.color : TRACK_COLORS[idx % TRACK_COLORS.length],
    });
    idx++;
    if (t.mute) muteIds.push(trackId);
    if (t.solo) soloAudioIds.push(trackId);
    if (notes.length) {
      // 一段盖住整份内容：旧模型里音符就在全局拍轴上，搬成段内内容拍（原点 0）。
      const endBeat = Math.max(4, ...notes.map(n => n.start + n.dur));
      clips.push({
        id: newVidId('mcl'), trackId, kind: 'midi', name: t.name ? String(t.name) : 'MIDI',
        src: '', origin: 'asset', start: 0, duration: beatToSeconds(endBeat, migratedMusic.tempo),
        offset: 0, srcDuration: endBeat, hasAudio: false, notes,
      });
    }
  }
  if (!tracks.length) return null;
  return { tracks, clips, music: migratedMusic, muteIds, soloAudioIds };
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
  // 删掉的就是 Mask 轨 → 绑定跟着断（留一条指向不存在轨的 id 等于"绑着但取不到"，
  // 比"没绑"更难解释）。
  ...(p.maskTrackId === trackId ? { maskTrackId: undefined } : {}),
  // mute / solo 记的也是轨道 id：轨没了就把那条摘掉（solo 悬空会让画面整个空掉）。
  muteIds: p.muteIds?.filter(id => id !== trackId),
  soloAudioIds: p.soloAudioIds?.filter(id => id !== trackId),
  soloVideoIds: p.soloVideoIds?.filter(id => id !== trackId),
});

/** 视频模式的 Mask：绑一条轨（或传空 = 解绑）。只认视频轨 —— 音频轨没有画面，
 *  Layer 轨的"画面"是图层合成，两者当 mask 源都是误会。 */
export const setMaskTrack = (p: VidProject, trackId: string | null): VidProject => {
  if (!trackId) return { ...p, maskTrackId: undefined };
  const tr = p.tracks.find(t => t.id === trackId && t.kind === 'video');
  return { ...p, maskTrackId: tr ? tr.id : undefined };
};

/** 重命名轨道。名字只是显示用（mute/solo/拾取全跟 id 走），爱叫什么叫什么；空串 = 不动。 */
export const renameTrack = (p: VidProject, trackId: string, name: string): VidProject => {
  const trimmed = name.trim();
  if (!trimmed) return p;
  return { ...p, tracks: p.tracks.map(t => (t.id === trackId ? { ...t, name: trimmed } : t)) };
};

/** 拖动排序：把一条轨挪到 `to`（splice 语义的落点下标，越界夹回）。数组序 = 上下序，类型不设限
 *  —— 合成语义本来就看序：视频轨的上下就是叠放次序（clipAt 从上往下找）、Layer 轨只有压过
 *  所有视频轨才参与合成，音频轨彼此的序就是混音次序。 */
export const moveTrack = (p: VidProject, trackId: string, to: number): VidProject => {
  const from = p.tracks.findIndex(t => t.id === trackId);
  if (from < 0) return p;
  const to2 = Math.max(0, Math.min(p.tracks.length - 1, to));
  if (to2 === from) return p;
  const tracks = [...p.tracks];
  const [tr] = tracks.splice(from, 1);
  tracks.splice(to2, 0, tr);
  return { ...p, tracks };
};

// ── 导入：一段源文件进时间线（拖放落定后调）───────────────────────────────────────────────
/** 把一次拖放落成片段（含音画拆分）。`trackId` 为空 = 自动挑第一段视频轨。
 *  纯音频源（<video> 咬不动，audioOnly）或落在音频轨上 = 音频段；视频源落在视频轨且带音频
 *  = 视频段 + 拆一条联动音频段。纯函数，返回新 project。 */
export const placeImport = (
  p: VidProject,
  src: { src: string; name: string; origin: 'staging' | 'file' | 'asset'; asset?: string; play?: string },
  info: MediaInfo,
  trackId: string | null,
  at: number,
): VidProject => {
  const chosen = trackId ? trackOf(p, trackId) : null;
  // 素材只能落在 video / audio 轨上。显式指到 Layer / process / MIDI 轨 = 这一趟不落
  // （那些轨不吃文件；静默改道到别的轨会让"我明明拖到这条轨上"变成一句谎话）。
  if (chosen && chosen.kind !== 'video' && chosen.kind !== 'audio') return p;
  let track = chosen ?? p.tracks.find(t => t.kind === 'video') ?? null;
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
    asset: src.asset, play: src.play,
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
      asset: src.asset, play: src.play,
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
    { src: asset.src, name: asset.name, origin: 'asset', asset: asset.asset, play: asset.play },
    { duration: asset.duration, hasAudio: asset.hasAudio, audioOnly: asset.kind === 'audio' },
    trackId,
    at,
  );

/** 拖放到轨道的统一入口 —— **Assets 是项目所有数据的来源**：任何源（图池条目、本地文件）
 *  先入资产库（同 src 认领已有的那件），时间线再落一段引用它的片段。不存在"直接进轨道"的路。 */
export const importToTrack = (
  p: VidProject,
  src: { src: string; name: string; origin: 'staging' | 'file'; asset?: string; play?: string },
  info: MediaInfo,
  trackId: string | null,
  at: number,
): VidProject => {
  let asset = p.assets.find(a => sameAsset(a, src));
  let next = p;
  if (asset) {
    // 认到的这一行：把这次带来、它还缺的身份补上（`asset` / `play` —— relink 与"能播的那份"
    // 都靠它们）；地址只在老那条活不过刷新（blob:/data:）时换掉 —— 一条货只留一个地址面。
    const dead = /^(blob|data):/.test(asset.src || '');
    const live = /^(\/|https?:)/.test(src.src || '');
    const better: VidAsset = {
      ...asset,
      asset: asset.asset || src.asset,
      play: asset.play || src.play,
      src: dead && live ? src.src : asset.src,
    };
    if (better.asset !== asset.asset || better.play !== asset.play || better.src !== asset.src) {
      next = { ...next, assets: next.assets.map(a => (a.id === asset!.id ? better : a)) };
      asset = better;
    }
  } else {
    asset = {
      id: newVidId('as'), name: src.name, src: src.src, origin: src.origin,
      asset: src.asset, play: src.play,
      kind: info.audioOnly ? 'audio' : 'video', duration: info.duration, hasAudio: info.hasAudio,
    };
    next = addAsset(next, asset);
  }
  return placeAsset(next, asset, trackId, at);
};

/** Processor 的 Allow List 视频产物落位：一个出口的一列编码视频（/api/vid_media/...）
 *  **新开一条视频轨**按序放进去（首尾相接、第一段对齐源片段起点）。大视频因此不必
 *  一次抽完整列 —— 宿主按段跑、每段独立编码，峰值内存只由单段帧数决定；segs 长度 1
 *  时就是单段直落。不走 importToTrack —— 那条路的 snapPlace 对空轨会吸到 0（"放到该轨
 *  片段末尾"对一条新轨就是开头），而这里要的是"和源片段对齐"。
 *  资产库照记每件（Assets 是项目所有数据的来源），同 src 重复跑只更新不重复加。 */
export const placeProcVideoSegs = (
  p: VidProject,
  item: { name: string; segs: { src: string; start: number; duration: number }[] },
): VidProject => {
  let next = p;
  for (const s of item.segs) {
    const dur = Math.max(0.1, s.duration);
    next = addAsset(next, {
      id: newVidId('as'), name: item.name, src: s.src, origin: 'file',
      kind: 'video', duration: dur, hasAudio: false,
    });
  }
  const track: VidTrack = {
    id: newVidId('trk'), kind: 'video',
    name: `Video ${next.tracks.filter(t => t.kind === 'video').length + 1}`,
  };
  next = { ...next, tracks: [track, ...next.tracks] };
  const clips: VidClip[] = item.segs.map(s => {
    const dur = Math.max(0.1, s.duration);
    return {
      id: newVidId('clip'), trackId: track.id, kind: 'video', name: item.name,
      src: s.src, origin: 'file', start: Math.max(0, s.start), duration: dur,
      offset: 0, srcDuration: dur, hasAudio: false,
    };
  });
  return { ...next, clips: [...next.clips, ...clips] };
};

/** Processor 的 Allow List 视频路（输出口 = New Track）：**Run 确认的当下**就摆好两条轨 ——
 *  一条**产物输出轨**（role='output'，按输出口各一条、懒建、固定复用）在上，process 轨
 *  紧贴它下方；process 轨上每段一个占位坑（带着执行快照 VidProcPending）。段跑完产物落到
 *  输出轨的对应时间位置，占位段**原地保留** —— 所以同一段可以反复重跑，中途退出也能点
 *  占位续跑。item.segs 的 start/duration 是时间线口径（第一段对齐范围入点），inputs 是
 *  这一段的**帧段**（全口：file/f0/n/fps，f0 = 源内按工程 fps 的整数起始帧号）。每个被
 *  跟踪的输出口各开一条 process 轨。 */
export const placeProcPlaceholders = (
  p: VidProject,
  item: {
    name: string; runId: string; port: number; iface: string; ifaceNum: number;
    params: Record<string, unknown>;
    /** 'preset' 的视频路用它记账（缺省 = processor）。 */
    kind?: 'processor' | 'preset';
    presetId?: string;
    presetName?: string;
    extraPrompt?: string;
    maskTrackId?: string;
    maskTrackName?: string;
    segs: { start: number; duration: number; segIndex: number; segCount: number;
      inputs: Record<string, ProcFrameWindow>;
      maskInputs?: Record<string, ProcFrameWindow> }[];
  },
): VidProject => {
  if (!item.segs.length) return p;
  // 产物的固定去处先就位：输出轨在上、process 轨紧贴其下。之后无论跑多少次，成品都落在
  // 这一条输出轨的对应位置 —— 不会再多开一条"结果轨"。
  const out = ensureOutputTrack(p, item.port);
  const track: VidTrack = {
    id: newVidId('trk'), kind: 'process',
    name: `Process ${out.p.tracks.filter(t => t.kind === 'process').length + 1}`,
  };
  const tracks = [...out.p.tracks];
  tracks.splice(tracks.findIndex(t => t.id === out.track.id) + 1, 0, track);
  const clips: VidClip[] = item.segs.map(s => ({
    id: newVidId('clip'), trackId: track.id, kind: 'process', name: item.name,
    src: '', origin: 'file', start: Math.max(0, s.start), duration: Math.max(0.1, s.duration),
    offset: 0, srcDuration: Math.max(0.1, s.duration), hasAudio: false,
    pending: {
      runId: item.runId, port: item.port, iface: item.iface, ifaceNum: item.ifaceNum,
      params: item.params, inputs: s.inputs, segIndex: s.segIndex, segCount: s.segCount,
      ...(item.kind ? { kind: item.kind } : {}),
      ...(item.presetId ? { presetId: item.presetId } : {}),
      ...(item.presetName ? { presetName: item.presetName } : {}),
      ...(item.extraPrompt ? { extraPrompt: item.extraPrompt } : {}),
      ...(item.maskTrackId ? { maskTrackId: item.maskTrackId } : {}),
      ...(item.maskTrackName ? { maskTrackName: item.maskTrackName } : {}),
      ...(s.maskInputs ? { maskInputs: s.maskInputs } : {}),
    },
  }));
  return { ...out.p, tracks, clips: [...out.p.clips, ...clips] };
};

/** 生成器轨就位：每个输出口一条（紧贴它那条输出轨下面，懒建、之后复用 —— 用户往同一条
 *  上接着加段，不该每次多开一条空轨）。 */
export const ensureVideoGenTrack = (p: VidProject, port: number): { p: VidProject; track: VidTrack } => {
  const found = p.tracks.find(t => t.role === 'vgen' && (t.port ?? 0) === port);
  if (found) return { p, track: found };
  const out = ensureOutputTrack(p, port);
  const track: VidTrack = {
    id: newVidId('trk'), kind: 'process', role: 'vgen', port,
    name: port ? `Video Gen ${port}` : 'Video Gen',
  };
  const tracks = [...out.p.tracks];
  tracks.splice(tracks.findIndex(t => t.id === out.track.id) + 1, 0, track);
  return { p: { ...out.p, tracks }, track };
};

/** 摆一枚 **video generator 段**：输出轨 + 生成器轨先就位，段落在生成器轨上播放头处。
 *  与 processor 占位段同一套规矩 —— 段自己原地保留（改参数、换提示词、反复重跑），
 *  产物落到上方输出轨的对应时间位置。 */
export const placeVideoGenSegment = (
  p: VidProject,
  item: {
    name: string; runId: string; port: number; iface: string; ifaceNum: number;
    ports: VideoGenPorts; fixed_fps: boolean; fixed_fps_value?: number;
    params: Record<string, unknown>;
    start: number; duration: number;
    /** 开跑前就绑好的首帧(Add continue segment:所选视频段的尾帧)。缺省 = 不绑。 */
    first_frame?: VidGenFrameRef | null;
  },
): VidProject => {
  const { p: withTrack, track } = ensureVideoGenTrack(p, item.port);
  const duration = Math.max(0.1, item.duration);
  const clip: VidClip = {
    id: newVidId('clip'), trackId: track.id, kind: 'process', name: item.name,
    src: '', origin: 'file', start: Math.max(0, item.start), duration,
    offset: 0, srcDuration: duration, hasAudio: false,
    vgen: {
      kind: 'video_gen', runId: item.runId, port: item.port,
      iface: item.iface, ifaceNum: item.ifaceNum,
      ports: item.ports, fixed_fps: item.fixed_fps, fixed_fps_value: item.fixed_fps_value,
      params: item.params,
      first_frame: item.first_frame ?? null,
    },
  };
  return { ...withTrack, clips: [...withTrack.clips, clip] };
};

/** 一段跑完：把生成器的产物换进去（自己的旧产物按 procOwner 认亲原地换掉）。
 *  生成器段与占位段共用这一条 —— 输出轨、槽位占用、资产入库全是同一套。 */
export const placeVideoGenOutput = (
  p: VidProject, clipId: string, src: string, name: string, duration: number,
): VidProject => placeProcOutput(p, clipId, src, name, duration);

// ── 生成器段的链条 ──────────────────────────────────────────────────────────────────────────
// 同一条轨上首尾紧贴的两枚生成器段可以**串成一条链**：后一段的首帧就是前一段的末帧
// （前一段若绑了末帧卡就用那张图，否则用它产物的最后一帧）。链只记在**后一段**身上
// （`vgen.chainPrev` = 前一段的 clip id），前段不必知道谁接在后面。
// 挪开/裁开/删掉任一段，这条链就不再成立 —— 每次工程变更都过 pruneVgenChains 收掉。
const VGEN_TOUCH_EPS = 0.002;

/** `clip` 链着的前一段（不合法 = null）。同轨、都是生成器、首尾紧贴，缺一不可；
 *  后一段还必须绑了首帧口 —— 没有那一口，共享来的帧没处喂。 */
export const vgenChainPrevOf = (p: VidProject, clip: VidClip): VidClip | null => {
  const prevId = clip.vgen?.chainPrev;
  if (!prevId || prevId === clip.id || !clip.vgen?.ports.first_frame) return null;
  const prev = p.clips.find(c => c.id === prevId);
  if (!prev || !prev.vgen || prev.id === clip.id) return null;
  if (prev.trackId !== clip.trackId) return null;
  if (Math.abs(prev.start + prev.duration - clip.start) > VGEN_TOUCH_EPS) return null;
  return prev;
};

/** 两段能不能连：同轨、都是生成器、首尾紧贴、后一段绑了首帧口。 */
export const canVgenChain = (p: VidProject, prevId: string, nextId: string): boolean => {
  const prev = p.clips.find(c => c.id === prevId);
  const next = p.clips.find(c => c.id === nextId);
  return !!prev && !!next && prev.id !== next.id && !!prev.vgen && !!next.vgen
    && !!next.vgen?.ports.first_frame
    && prev.trackId === next.trackId
    && Math.abs(prev.start + prev.duration - next.start) <= VGEN_TOUCH_EPS;
};

/** Ctrl+左键点接缝：已连着就断开，没连就连上。不成立的接缝原样返回。 */
export const toggleVgenChain = (p: VidProject, prevId: string, nextId: string): VidProject => {
  const next = p.clips.find(c => c.id === nextId);
  if (!next?.vgen) return p;
  if (next.vgen.chainPrev === prevId) {
    return {
      ...p,
      clips: p.clips.map(c => (c.id === nextId && c.vgen)
        ? { ...c, vgen: { ...c.vgen, chainPrev: undefined } } : c),
    };
  }
  if (!canVgenChain(p, prevId, nextId)) return p;
  return {
    ...p,
    clips: p.clips.map(c => (c.id === nextId && c.vgen)
      ? { ...c, vgen: { ...c.vgen, chainPrev: prevId } } : c),
  };
};

/** 收掉不再成立的链（挪开 / 裁开 / 删段 / 读档时的悬空 id）。没有要收的原样返回。 */
export const pruneVgenChains = (p: VidProject): VidProject => {
  const broken = new Set<string>();
  for (const c of p.clips) {
    if (c.vgen?.chainPrev && !vgenChainPrevOf(p, c)) broken.add(c.id);
  }
  if (!broken.size) return p;
  return {
    ...p,
    clips: p.clips.map(c => (broken.has(c.id) && c.vgen)
      ? { ...c, vgen: { ...c.vgen, chainPrev: undefined } } : c),
  };
};

/** 这一段已经跑出来的产物（输出轨上 procOwner 认亲的那一段）；还没跑过 = null。 */
export const outputClipOf = (p: VidProject, clip: VidClip): VidClip | null =>
  p.clips.find(c => c.procOwner === clip.id && !!c.src) ?? null;

/** 链从头到 `clip` 的顺序（早 → 晚，含自己）。断在哪就停在哪。 */
export const vgenChainTo = (p: VidProject, clip: VidClip): VidClip[] => {
  const out: VidClip[] = [clip];
  const seen = new Set<string>([clip.id]);
  let cur = clip;
  for (;;) {
    const prev = vgenChainPrevOf(p, cur);
    if (!prev || seen.has(prev.id)) break;
    out.unshift(prev);
    seen.add(prev.id);
    cur = prev;
  }
  return out;
};

/** 时间线上所有**可连的接缝**（同轨、首尾紧贴的生成器段对），`linked` = 后段已链到前段。
 *  接缝的视觉与 Ctrl 点击都照这份表来。 */
export const vgenSeamsOf = (p: VidProject): { prev: VidClip; next: VidClip; linked: boolean }[] => {
  const vgens = p.clips.filter(c => c.vgen && c.vgen.ports.first_frame);
  const out: { prev: VidClip; next: VidClip; linked: boolean }[] = [];
  for (const prev of p.clips) {
    if (!prev.vgen) continue;
    for (const next of vgens) {
      if (next.id === prev.id || next.trackId !== prev.trackId) continue;
      if (Math.abs(prev.start + prev.duration - next.start) > VGEN_TOUCH_EPS) continue;
      out.push({ prev, next, linked: next.vgen?.chainPrev === prev.id });
    }
  }
  return out;
};

/** 产物输出轨查找：每个输出口一条（缺省 0）。没有 = 还没跑过这一口。 */
export const outputTrackOf = (p: VidProject, port: number): VidTrack | null =>
  p.tracks.find(t => t.role === 'output' && (t.port ?? 0) === port) ?? null;

const outputTrackName = (port: number): string => (port ? `Output ${port}` : 'Output');

/** 输出轨就位：没有就建一条，插在所有 Layer 轨之下（Layer 轨要压在视频轨上方才合成）；
 *  已有就原样复用（用户挪过的位置不强行搬回去）。 */
const ensureOutputTrack = (p: VidProject, port: number): { p: VidProject; track: VidTrack } => {
  const found = outputTrackOf(p, port);
  if (found) return { p, track: found };
  let at = 0;
  while (at < p.tracks.length && p.tracks[at].kind === 'layer') at++;
  const track: VidTrack = {
    id: newVidId('trk'), kind: 'video', role: 'output', port, name: outputTrackName(port),
  };
  const tracks = [...p.tracks];
  tracks.splice(at, 0, track);
  return { p: { ...p, tracks }, track };
};

/** 输出口 port 的槽位 [start, start+duration) 是否被**别的东西**占着。`ownerId` = 占位段
 *  id：它自己上一次跑出来的产物不算占（重跑会原地换掉自己的旧结果）—— 这样一段可以反复
 *  执行；别的片段 / 别的 process 的产物占着就是真占，执行键应置灰。 */
export const procSlotBusy = (
  p: VidProject, port: number, start: number, duration: number, ownerId?: string,
): boolean => {
  const tr = outputTrackOf(p, port);
  if (!tr) return false;
  const a = Math.max(0, start);
  const b = a + Math.max(0.05, duration);
  return p.clips.some(c => c.trackId === tr.id && !c.pending && c.duration > 0
    && !(ownerId && c.procOwner === ownerId)
    && c.start < b - 1e-6 && c.start + c.duration > a + 1e-6);
};

/** 一个输入口的**帧段**：f0 = 源文件内按工程 fps 的起始帧号（整数），n = 帧数。
 *  `ss`/`t` 这类秒数不再进存档 —— 段与段用整数帧号相接，重跑不受取整影响。 */
export type ProcFrameWindow = { file: string; f0: number; n: number; fps: number };

/** 占位段批量设置的写回补丁（只带用户真正改过的字段 —— 混合值不写）：
 *  * 顶层 `name/start/duration` 写片段本身；
 *  * `pending` 按字段覆盖快照；
 *  * `params` 按 key 覆盖（没有该 key 的段也会补上）；
 *  * `inputs/maskInputs` 按 key **只改已有的那行** —— 某段没有这个输入口就原样不动。 */
export type ProcSettingsPatch = {
  name?: string;
  start?: number;
  duration?: number;
  pending?: Partial<VidProcPending>;
  params?: Record<string, unknown>;
  inputs?: Record<string, Partial<ProcFrameWindow>>;
  maskInputs?: Record<string, Partial<ProcFrameWindow>>;
};

/** 把一份设置补丁应用到一批占位段上（纯函数）。非占位段一律不碰。 */
export const applyProcSettings = (p: VidProject, ids: readonly string[], patch: ProcSettingsPatch): VidProject => {
  if (!Object.keys(patch).length) return p;
  const set = new Set(ids);
  let changed = false;
  const clips = p.clips.map(c => {
    if (!set.has(c.id) || !c.pending) return c;
    const pd: VidProcPending = { ...c.pending };
    if (patch.pending) Object.assign(pd, patch.pending);
    if (patch.params) pd.params = { ...pd.params, ...patch.params };
    if (patch.inputs) {
      const next = { ...pd.inputs };
      for (const [k, part] of Object.entries(patch.inputs)) {
        if (next[k]) next[k] = { ...next[k], ...part };
      }
      pd.inputs = next;
    }
    if (patch.maskInputs) {
      const next = { ...(pd.maskInputs ?? {}) };
      for (const [k, part] of Object.entries(patch.maskInputs)) {
        if (next[k]) next[k] = { ...next[k], ...part };
      }
      pd.maskInputs = Object.keys(next).length ? next : undefined;
    }
    const duration = patch.duration != null ? Math.max(0.1, patch.duration) : c.duration;
    changed = true;
    return {
      ...c,
      name: patch.name != null ? patch.name : c.name,
      start: patch.start != null ? Math.max(0, patch.start) : c.start,
      duration,
      srcDuration: patch.duration != null ? duration : c.srcDuration,
      pending: pd,
    };
  });
  return changed ? { ...p, clips } : p;
};

/** 一段跑完：产物落到**输出轨的对应时间位置**。占位段**原地不动**（pending 还在，可以
 *  反复 ▶ 重跑）；同一个占位段上一次的产物按 procOwner 认亲原地换掉（重跑 = 覆盖自己的
 *  旧结果）。别的东西占着这个位置时不覆盖 —— 调用方先过 procSlotBusy 拦下。
 *  产物照记资产库（Assets 是项目所有数据的来源）。 */
export const placeProcOutput = (
  p: VidProject, clipId: string, src: string, name: string, duration: number,
): VidProject => {
  const clip = p.clips.find(c => c.id === clipId);
  if (!clip || !(clip.pending || clip.vgen)) return p;
  // 生成器段与处理器占位段共用这一条：口 = 各自的产物出口（占位段记在 pending，生成器记在 vgen）。
  const port = clip.pending?.port ?? clip.vgen?.port ?? 0;
  const dur = Math.max(0.1, duration);
  const { p: withTrack, track } = ensureOutputTrack(p, port);
  const withAsset = addAsset(withTrack, {
    id: newVidId('as'), name, src, origin: 'file', kind: 'video', duration: dur, hasAudio: false,
  });
  const clips = withAsset.clips.filter(c => !(c.trackId === track.id && c.procOwner === clipId));
  clips.push({
    id: newVidId('clip'), trackId: track.id, kind: 'video', name, src, origin: 'file',
    start: Math.max(0, clip.start), duration: dur, offset: 0, srcDuration: dur, hasAudio: false,
    procOwner: clipId,
  });
  return { ...withAsset, clips };
};

/** Processor 的 Allow List 视频产物**只入库**（输出口选了 Asset）：时间线不动、不开轨，
 *  每段编码产物在资产库里记一件（多段时名字带序号）。与 placeProcVideoSegs 同一批
 *  产物、两种去处 —— 挑选值在 Processor 窗的输出口行上。 */
export const placeProcAssets = (
  p: VidProject,
  item: { name: string; segs: { src: string; duration: number }[] },
): VidProject => {
  let next = p;
  const many = item.segs.length > 1;
  item.segs.forEach((s, i) => {
    next = addAsset(next, {
      id: newVidId('as'), name: many ? `${item.name} · ${i + 1}/${item.segs.length}` : item.name,
      src: s.src, origin: 'file', kind: 'video',
      duration: Math.max(0.1, s.duration), hasAudio: false,
    });
  });
  return next;
};

// ── 多选合并 ────────────────────────────────────────────────────────────────────────────────
// 时间线上多选几段、右键合并。口径：
//  * 必须在同一条轨、同一类型（video / process / layer），且首尾**严格相接**（无空隙无重叠）；
//  * process 段：除帧窗口外的执行快照必须一致，逐口帧窗口还要连续（next.f0 = prev.f0 + prev.n，
//    同 file / fps）—— 合并后就是同一个坑的更长一段，帧窗口 n 相加；
//  * video 段：同源且源内连续 → 本地并成一段；否则交后端 ffmpeg 拼成一条新文件再替换；
//  * layer 段：内容是否相同由页面回签（见 layerSigs），调用方确认后才允许合并。
// 联合音画（groupId）一律不合并：视频段被并、音频段没被并，组就断了 —— 先 ⧉ 解绑再来。
const MERGE_EPS = 0.002;

export type VidMergeKind = 'video' | 'process' | 'layer';
export type VidMergePlan = {
  kind: VidMergeKind;
  /** 按 start 升序。 */
  clips: VidClip[];
  /** video：local = 同一 src 且源内连续（前端直接并）；concat = 交后端拼新文件。 */
  videoMode?: 'local' | 'concat';
};
export type VidMergeProbe =
  | { ok: true; plan: VidMergePlan }
  | { ok: false; reason: string };

/** 结构可合并性（不看参数）：同轨、同类、首尾相接。菜单要不要露头由它决定。 */
export const vidMergeStructure = (
  p: VidProject, ids: readonly string[],
): { ok: true; clips: VidClip[]; kind: VidMergeKind } | { ok: false; reason: string } => {
  const uniq = [...new Set(ids)];
  if (uniq.length < 2) return { ok: false, reason: 'Select at least two segments.' };
  const clips = uniq.map(id => p.clips.find(c => c.id === id)).filter((c): c is VidClip => !!c);
  if (clips.length !== uniq.length) return { ok: false, reason: 'Some selected segments no longer exist.' };
  const kind = (clips[0].pending ? 'process' : clips[0].kind) as VidTrackKind;
  if (kind !== 'video' && kind !== 'process' && kind !== 'layer') {
    return { ok: false, reason: 'Only video, process and layer segments can be merged.' };
  }
  if (clips.some(c => c.trackId !== clips[0].trackId)) {
    return { ok: false, reason: 'Segments must all be on the same track.' };
  }
  if (clips.some(c => (c.pending ? 'process' : c.kind) !== kind)) {
    return { ok: false, reason: 'Segments must all be of the same type.' };
  }
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], next = sorted[i];
    if (Math.abs(next.start - (prev.start + prev.duration)) > MERGE_EPS) {
      return { ok: false, reason: 'Segments must be adjacent — no gaps or overlaps.' };
    }
  }
  return { ok: true, clips: sorted, kind: kind as VidMergeKind };
};

/** 深度相等（对象 key 顺序无关）—— params 里既有数字/字符串，也有嵌套对象。 */
const sameJson = (a: unknown, b: unknown, depth = 0): boolean => {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (!a || !b || typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameJson(v, b[i], depth + 1));
  }
  if (depth > 8) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth + 1));
};

/** process 段的"其它参数"：执行去向、接口、参数值、Mask 绑定；runId / 段号 / 帧窗口不算。 */
const pendingParamsEqual = (a: VidProcPending, b: VidProcPending): boolean =>
  (a.kind ?? 'processor') === (b.kind ?? 'processor')
  && (a.presetId ?? '') === (b.presetId ?? '')
  && (a.presetName ?? '') === (b.presetName ?? '')
  && (a.extraPrompt ?? '') === (b.extraPrompt ?? '')
  && (a.maskTrackId ?? '') === (b.maskTrackId ?? '')
  && (a.port ?? 0) === (b.port ?? 0)
  && a.iface === b.iface
  && (a.ifaceNum ?? 0) === (b.ifaceNum ?? 0)
  && sameJson(a.params ?? {}, b.params ?? {});

/** 两组帧窗口能不能首尾接上：端口集合相同、同 file/fps、帧号严格连续。 */
const windowsContinuous = (
  a: Record<string, ProcFrameWindow>, b: Record<string, ProcFrameWindow>,
): boolean => {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  for (const k of ka) {
    const wa = a[k], wb = b[k];
    if (!wa || !wb) return false;
    if (wa.file !== wb.file) return false;
    if (!Number.isFinite(wa.fps) || !Number.isFinite(wb.fps)) return false;
    if (Math.abs(wa.fps - wb.fps) > MERGE_EPS) return false;
    if (!Number.isFinite(wa.f0) || !Number.isFinite(wa.n) || !Number.isFinite(wb.f0)) return false;
    if (wb.f0 !== wa.f0 + wa.n) return false;
  }
  return true;
};

/** 合并探针：结构 + 参数/帧窗口/视频源。layer 的内容比较要另问页面（这里只放行结构）。 */
export const probeVidMerge = (p: VidProject, ids: readonly string[]): VidMergeProbe => {
  const st = vidMergeStructure(p, ids);
  if (!st.ok) return st;
  const { clips, kind } = st;
  if (clips.some(c => c.groupId)) {
    return { ok: false, reason: 'Linked A/V pairs cannot be merged — click ⧉ to unlink them first.' };
  }
  if (kind === 'process') {
    for (let i = 1; i < clips.length; i++) {
      const prev = clips[i - 1].pending, next = clips[i].pending;
      if (!prev || !next) return { ok: false, reason: 'Not every selected segment is a process placeholder.' };
      if (!pendingParamsEqual(prev, next)) {
        return { ok: false, reason: 'Processor settings differ between these segments (only the frame window may differ).' };
      }
      if (!windowsContinuous(prev.inputs, next.inputs)) {
        return { ok: false, reason: 'Input frame windows are not continuous — segmented frames must run on without gaps.' };
      }
      if (!windowsContinuous(prev.maskInputs ?? {}, next.maskInputs ?? {})) {
        return { ok: false, reason: 'Mask frame windows are not continuous — segmented frames must run on without gaps.' };
      }
    }
    return { ok: true, plan: { kind, clips } };
  }
  if (kind === 'video') {
    let local = true;
    for (let i = 1; i < clips.length; i++) {
      if (clips[i].src !== clips[i - 1].src
        || Math.abs(clips[i].offset - (clips[i - 1].offset + clips[i - 1].duration)) > MERGE_EPS) {
        local = false;
        break;
      }
    }
    // 后端只能读媒体库里的文件：本地拖进来的 blob:/其它 URL 拼不了。
    if (!local && clips.some(c => !c.src.startsWith('/api/vid_media/'))) {
      return { ok: false, reason: 'Only library video files can be stitched together.' };
    }
    return { ok: true, plan: { kind, clips, videoMode: local ? 'local' : 'concat' } };
  }
  return { ok: true, plan: { kind, clips } };
};

/** 若干段同口帧窗口首尾相接后的那一口：f0 取第一段、n 累加。 */
const mergeWindowRuns = (runs: Record<string, ProcFrameWindow>[]): Record<string, ProcFrameWindow> => {
  const out: Record<string, ProcFrameWindow> = {};
  for (const k of Object.keys(runs[0])) {
    const w = { ...runs[0][k] };
    for (let i = 1; i < runs.length; i++) w.n += runs[i][k].n;
    out[k] = w;
  }
  return out;
};

/** 合并（纯函数）。layer 段必须由调用方先确认 `layerEqual`（页面回签一致）才放行。 */
export const mergeVidClips = (
  p: VidProject, ids: readonly string[], opts?: { layerEqual?: boolean },
): VidProject => {
  const pr = probeVidMerge(p, ids);
  if (!pr.ok) return p;
  const { plan } = pr;
  if (plan.kind === 'layer' && opts?.layerEqual !== true) return p;
  if (plan.kind === 'video' && plan.videoMode !== 'local') return p;   // 异源走后端拼接
  const first = plan.clips[0], last = plan.clips[plan.clips.length - 1];
  const start = first.start;
  const duration = last.start + last.duration - start;
  const own = new Set(plan.clips.map(c => c.id));
  // 占位段上一次的产物也跟着占位走：留着会挡住合并后那一段的重跑槽位。
  const rest = p.clips.filter(c => !own.has(c.id) && !(c.procOwner && own.has(c.procOwner)));
  let merged: VidClip;
  if (plan.kind === 'process') {
    const pds = plan.clips.map(c => c.pending as VidProcPending);
    const maskRuns = pds.every(pd => pd.maskInputs) ? pds.map(pd => pd.maskInputs as Record<string, ProcFrameWindow>) : null;
    merged = {
      ...first,
      start, duration, srcDuration: duration, offset: 0, hasAudio: false,
      groupId: undefined, procOwner: undefined,
      pending: {
        ...(pds[0] as VidProcPending),
        inputs: mergeWindowRuns(pds.map(pd => pd.inputs)),
        ...(maskRuns ? { maskInputs: mergeWindowRuns(maskRuns) } : { maskInputs: undefined }),
      },
    };
  } else if (plan.kind === 'video') {
    merged = {
      ...first,
      start, duration,
      groupId: undefined,
      // 合并后的这一段是用户的编辑产物，不再归任何一个占位段：重跑旧占位时它会报"槽位被占"，
      // 而不是被静默换掉。
      procOwner: undefined,
    };
  } else {
    merged = {
      ...first,
      start, duration, src: '', offset: 0, srcDuration: duration, hasAudio: false,
      layerKey: first.layerKey || first.id,
      groupId: undefined, procOwner: undefined,
    };
  }
  return { ...p, clips: [...rest, merged] };
};

/** 后端拼接成功后的替换：删掉被合并的几段，资产库里记一条新文件，原位置换成一段引用它的片段。 */
export const replaceVidClipsWithMerged = (
  p: VidProject, ids: readonly string[], src: string, name: string, duration: number, hasAudio = false,
): VidProject => {
  const st = vidMergeStructure(p, ids);
  if (!st.ok || st.kind !== 'video') return p;
  const first = st.clips[0];
  const total = Math.max(0.1, Math.abs(Number(duration)) || st.clips.reduce((s, c) => s + c.duration, 0));
  const withAsset = addAsset(p, {
    id: newVidId('as'), name: `${name} · merged`, src, origin: 'file', kind: 'video',
    duration: total, hasAudio,
  });
  const own = new Set(st.clips.map(c => c.id));
  const clips = withAsset.clips.filter(c => !own.has(c.id));
  clips.push({
    id: first.id, trackId: first.trackId, kind: 'video', name, src, origin: 'asset',
    start: first.start, duration: total, offset: 0, srcDuration: total, hasAudio,
  });
  return { ...withAsset, clips };
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
  music: { tempo: 120, timeSig: [4, 4], ppq: 480, loop: { on: false, a: 0, b: 16 } },
  mode: 'image',
});

export const loadVidProject = (): VidProject => {
  try {
    const raw = localStorage.getItem(VID_PROJECT_STORE);
    if (!raw) return defaultVidProject();
    return normalizeVidProject(JSON.parse(raw));
  } catch { return defaultVidProject(); }
};

/** 旧存档的抽帧窗口是秒（ss/t）—— 读档时换成帧段（f0/n），存档里从此只留帧。
 *  已经新格式的原样保留。f0 用 floor（容差 1e-6 帧）落到"包含起点的那一帧"，
 *  保证整段不会越过源尾。 */
const migrateFrameWindow = (w: unknown, projectFps: number): ProcFrameWindow | null => {
  if (!w || typeof w !== 'object') return null;
  const o = w as Record<string, unknown>;
  const file = typeof o.file === 'string' ? o.file : '';
  if (!file) return null;
  const rate = Number(o.fps) > 0 ? Number(o.fps) : projectFps;
  const nRaw = Number(o.n);
  const n = Number.isFinite(nRaw) && nRaw > 0
    ? Math.max(1, Math.round(nRaw))
    : Math.max(1, Math.round((Number(o.t) > 0 ? Number(o.t) : 1 / rate) * rate));
  if (Number.isFinite(Number(o.f0))) {
    return { file, f0: Math.max(0, Math.floor(Number(o.f0) + 1e-6)), n, fps: rate };
  }
  const ss = Number(o.ss);
  if (!Number.isFinite(ss)) return null;
  return { file, f0: Math.max(0, Math.floor(ss * rate + 1e-6)), n, fps: rate };
};

const migrateWindows = (
  raw: unknown, projectFps: number,
): Record<string, ProcFrameWindow> | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, ProcFrameWindow> = {};
  for (const [k, w] of Object.entries(raw as Record<string, unknown>)) {
    const m = migrateFrameWindow(w, projectFps);
    if (m) out[k] = m;
  }
  return Object.keys(out).length ? out : undefined;
};

/** 任何来源（localStorage / .cud 的 header.video / 宿主消息）的工程数据都过这里：
 *  形状不对的部分当场剪掉 —— 一份坏数据不该把时间线整个掀了。 */
/** 读档时把**同一件货的多行**并成一行。

 *  老工程里同一段片子会被记两次：一次是入库那条（src = `/api/vid_media/<file>`），一次是从
 *  库卡拖进时间线时那条（src = `/api/asset_media/<hash>`）—— 它们哈希相同、字节相同，只因为
 *  "地址面"不同就成了两行。窗里表现就是同一段视频两张卡，一张写着 N clips，另一张写 0。
 *
 *  并的时候：认第一行的名字，缺的身份互相补（`asset` / `play` 谁有给谁），地址不拿 blob: 去
 *  盖掉可持久的那条。片段**不引用资产行 id**（它们自己揣着 src/asset/play），所以并掉行不会
 *  让任何一段失去引用。 */
const mergeAssetRows = (rows: VidAsset[]): VidAsset[] => {
  const out: VidAsset[] = [];
  for (const a of rows) {
    const at = out.findIndex(x => sameAsset(x, a));
    if (at < 0) { out.push(a); continue; }
    const cur = out[at];
    const dead = (s: string | undefined) => /^(blob|data):/.test(s || '');
    out[at] = {
      ...cur,
      asset: cur.asset || a.asset,
      play: cur.play || a.play,
      src: dead(cur.src) && !dead(a.src) ? a.src : cur.src,
      hasAudio: cur.hasAudio || a.hasAudio,
      duration: cur.duration || a.duration,
      waveform: cur.waveform || a.waveform,
    };
  }
  return out;
};

export const normalizeVidProject = (raw: unknown): VidProject => {
  const base = defaultVidProject();
  // 仓库里的可播 URL（A5）：`play` = 转码代理优先，其次原件。两样都没有 = 没有哈希可依。
  const storeUrl = (play?: string, asset?: string): string =>
    (play || asset) ? '/api/asset_media/' + encodeURIComponent(String(play || asset)) : '';
  /** 这一行"怎么播"：能用的 src 原样留着；src 是 blob:/空的，就按哈希重建。两样都靠不住就是空串
   *  —— 调用方据此把这一行当"没了"（老存档里那些 blob: 且没哈希的段）。 */
  const recover = (row: { src?: string; play?: string; asset?: string }): string => {
    const src = String(row.src || '');
    if (src && !src.startsWith('blob:')) return src;
    return storeUrl(row.play, row.asset);
  };
  try {
    const p = raw as VidProject;
    if (!p || !Array.isArray(p.tracks) || !Array.isArray(p.clips)) return base;
    // ── 轨道 ── 只认这五种类型；id 必须非空且唯一。MIDI 轨的轨级字段夹回合法区间。
    const validKinds = new Set<VidTrackKind>(['video', 'audio', 'layer', 'process', 'midi']);
    let tracks: VidTrack[] = [];
    let midiCount = 0;
    for (const t of p.tracks) {
      if (!t || typeof t.id !== 'string' || !t.id) continue;
      if (!validKinds.has(t.kind) || tracks.some(x => x.id === t.id)) continue;
      const name = typeof t.name === 'string' && t.name ? t.name : 'Track';
      if (t.kind === 'midi') {
        tracks.push({
          ...t,
          name,
          channel: clampInt(t.channel ?? 0, 0, 15),
          instrument: typeof t.instrument === 'string' ? t.instrument : '',
          velScale: clampNum(t.velScale ?? 1, 0.1, 2),
          color: typeof t.color === 'string' && t.color ? t.color : TRACK_COLORS[midiCount % TRACK_COLORS.length],
        });
        midiCount++;
      } else {
        tracks.push({ ...t, name });
      }
    }
    // ── 老档 MIDI → 统一轨/段（7.a，只搬一次）──
    // 统一轨里已经有 MIDI 轨 = 这盘是搬过之后存的，不再碰旧键；否则把 `midi` 里的
    // "确实装过东西"的轨搬进 tracks/clips，音乐时间基一并接过来。搬完旧键就不存在了。
    let music = normalizeMusic((p as { music?: unknown }).music);
    let legacyClips: VidClip[] = [];
    let legacyMute: string[] = [];
    let legacySolo: string[] = [];
    if (!tracks.some(t => t.kind === 'midi')) {
      const legacy = migrateLegacyMidi((p as { midi?: unknown }).midi, music);
      if (legacy) {
        music = legacy.music;
        // 轨道 id 与现有轨撞号（手改档）就换一个；段的归属、mute/solo 跟着换。
        const remap = new Map<string, string>();
        for (const t of legacy.tracks) {
          if (tracks.some(x => x.id === t.id)) {
            const nid = newVidId('trk');
            remap.set(t.id, nid);
            t.id = nid;
          }
        }
        for (const c of legacy.clips) {
          const to = remap.get(c.trackId);
          if (to) c.trackId = to;
        }
        tracks = [...tracks, ...legacy.tracks];
        legacyClips = legacy.clips;
        legacyMute = legacy.muteIds.map(id => remap.get(id) ?? id);
        legacySolo = legacy.soloAudioIds.map(id => remap.get(id) ?? id);
      }
    }
    const trackIds = new Set(tracks.map(t => t.id));
    const trackKind = new Map(tracks.map(t => [t.id, t.kind] as const));
    const fps = clampFps(Number(p.fps));
    // blob: 的 objectURL 活不过刷新 —— 那些片段/资产当场蒸发；挂在不存在的轨道上的也一样。
    // Layer / MIDI 段没有素材源（一个装图层、一个装音符），所以"必须有 src"那条只对素材段成立。
    const clips = [...p.clips, ...legacyClips].filter(c => {
      if (!c || typeof c.id !== 'string' || !trackIds.has(c.trackId)) return false;
      if (!Number.isFinite(c.start) || !Number.isFinite(c.duration) || !(c.duration > 0)) return false;
      if (c.kind === 'midi') return trackKind.get(c.trackId) === 'midi';
      // 占位段没有 src（等跑完才有）—— 快照要活过重开，照常回来；生成器段同理。
      if (c.pending || c.vgen) return true;
      if (c.kind === 'layer') return c.src === '' || !c.src;
      // A5：有哈希的段永远收回来（src 可由 play/asset 重建）；只有"既没 src 又没哈希"的老 blob: 行丢掉。
      return !!recover(c);
    }).map(c => {
      if (c.kind === 'midi') {
        // 音符逐条夹回合法值；offset 是**拍**，可以为负（左裁留白）。
        const offsetRaw = Number(c.offset);
        const srcDurRaw = Number(c.srcDuration);
        return {
          ...c, src: '', hasAudio: false,
          offset: Number.isFinite(offsetRaw) ? offsetRaw : 0,
          srcDuration: Number.isFinite(srcDurRaw) ? Math.max(0, srcDurRaw) : 0,
          notes: sanitizeMidiNotes(c.notes),
        };
      }
      if (c.pending) {
        // 占位段的输入窗口统一成帧段（旧存档的 ss/t 在这里换掉 —— 存档不再写秒）。
        const inputs = migrateWindows(c.pending.inputs, fps) ?? {};
        const maskInputs = migrateWindows(c.pending.maskInputs, fps);
        return { ...c, pending: { ...c.pending, inputs, ...(maskInputs ? { maskInputs } : { maskInputs: undefined }) } };
      }
      if (c.kind === 'layer') {
        // 关键帧口径迁移：老档里 t 是**段内秒**，这里按段长换成归一化（见 kfMigrate）。
        // 换过之后 unit='norm'，再读原样放过 —— 只做一次。
        const keyframes = kfMigrate(c.keyframes, c.duration);
        return { ...c, src: '', layerKey: c.layerKey || c.id, ...(keyframes ? { keyframes } : {}) };
      }
      const src = recover(c);
      return src === c.src ? c : { ...c, src };
    });
    const assets = mergeAssetRows((Array.isArray(p.assets) ? p.assets : [])
      .filter(a => a && recover(a) && Number.isFinite(a.duration) && a.duration > 0)
      .map(a => { const src = recover(a); return src === a.src ? a : { ...a, src }; }));
    // mute / solo 的轨道 id：只留还活着的轨（删轨后重开不该把悬空 id 带回来）。
    const pickIds = (v: unknown, extra: string[] = []): string[] => [...new Set(
      [...(Array.isArray(v) ? v : []), ...extra]
        .filter((x): x is string => typeof x === 'string' && trackIds.has(x)),
    )];
    return pruneVgenChains({
      tracks, clips, assets,
      inPoint: Math.max(0, +p.inPoint || 0), outPoint: Math.max(0, +p.outPoint || 0),
      fps: clampFps(Number(p.fps)),
      music,
      // Mask 轨：绑的轨没了就当没绑（读档后轨道可能被删/改名）—— 不留一条悬空 id。
      ...(typeof p.maskTrackId === 'string' && trackIds.has(p.maskTrackId)
        ? { maskTrackId: p.maskTrackId } : {}),
      muteIds: pickIds(p.muteIds, legacyMute),
      soloAudioIds: pickIds(p.soloAudioIds, legacySolo),
      soloVideoIds: pickIds(p.soloVideoIds),
      mode: p.mode === 'video' ? 'video' : p.mode === 'midi' ? 'midi' : 'image',
    });
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

/** 标尺的步长阶梯（秒）：取第一个"一格至少 64px"的档。**Tracks 与 Keyframes 共用这一把尺** ——
 *  两扇窗的刻度对不上，同一时刻就会被读成两个位置。
 *  末尾两档（10/20 分钟）给超长工程的全景缩放：刻度文字再挤也会保住 64px 的下限。 */
export const RULER_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
export const rulerStep = (pps: number): number =>
  RULER_STEPS.find(s => s * pps >= 64) ?? RULER_STEPS[RULER_STEPS.length - 1];

export const isVideoName = (name: string): boolean =>
  /\.(mp4|webm|mov|m4v|mkv|avi|ogv|mpg|mpeg)$/i.test(name || '');
export const isAudioName = (name: string): boolean =>
  /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(name || '');
