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
import type { MediaInfo } from './audio';

// 四种轨：
//  * video / audio —— 素材轨，帧与声直接来自源文件；
//  * layer —— **合成轨**。它自己不装素材，只装"Layer 段"：每一段绑定一套独立图层
//    （在 Layers 窗里编辑），这一帧的画面**就是这一段图层自己的合成** —— 不叠加脚下视频轨的帧，
//    空段因此是一张空图。要让画面里出现某条视频轨的帧，就把它绑到 decal / mask 的 Frame source。
//    **只有它排在所有视频轨之上时才会生效**（渲染按轨道序找第一条命中的轨，先命中先赢）。
//  * process —— **process 轨**（琥珀色）：只装 Processor / Preset 的**占位段**（VidProcPending），
//    不播、不参与合成、不收素材。Run 时自动创建（在输出轨正下方），产物落到上方输出轨；
//    占位段原地保留，所以可以反复 ▶ 重跑。
export type VidTrackKind = 'video' | 'audio' | 'layer' | 'process';
export type VidTrack = {
  id: string;
  kind: VidTrackKind;
  name: string;
  /** `'output'` = **产物输出轨**：Processor / Preset 的 process 段跑完，成品固定落在这一条
   *  上层轨的对应时间位置（占位段自己留在原地，可以反复重跑）。每条输出口一条，懒建。
   *  `'vgen'` = **生成器段所在的 process 轨**（紧贴对应输出轨下方、每个输出口一条、懒建复用）：
   *  与 processor 那条 process 轨是两回事 —— 生成器段不是"那段视频抽几帧"的占位，它自有
   *  一套参数，所以另起一条、按 role 认，免得两条路的段混在一条轨上互相绊。 */
  role?: 'output' | 'vgen';
  /** 输出轨对应的输出口（缺省 0；preset 恒 0）。process 段按 pending.port 找自己的输出轨。 */
  port?: number;
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
  /** 这段从源文件的哪里开始播（s）。 */
  offset: number;
  /** 源文件总长（s）。 */
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
};

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
  /** Layer 段合并用：向工作台页要这些图层集的内容签名（key → 签名）。页面不在/超时 = 空表。 */
  layerSigs?: (keys: string[]) => Promise<Record<string, string>>;
  /** 仓库里已经找不到的哈希（工程引用了，但字节不在了）。打开工程与每次改动后刷新：
   *  时间线画红线、Assets 卡挂 MISSING、relink 按它挑目标。 */
  missing: ReadonlySet<string>;
  /** 把 `hash` 这件货换成本地文件（重新入库）。哈希对不上默认拒绝 —— `force` 才改绑到新字节。 */
  relink: (hash: string, file: File, force?: boolean) => Promise<{ ok: boolean; error?: string; hash?: string }>;
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

/** 换绑：把工程里对 `from` 的引用改指 `to`；`playHash` = 可播字节（转码代理），缺省用 `to`。
 *  只动引用了 `from` 的行 —— src 也一起换成仓库地址，否则换了哈希还在播旧 URL。 */
export const relinkAsset = (p: VidProject, from: string, to: string, playHash?: string): VidProject => {
  const play = playHash || to;
  const url = '/api/asset_media/' + encodeURIComponent(play);
  const fix = <T extends { asset?: string; play?: string; src: string }>(row: T): T => {
    if (row.asset !== from && row.play !== from) return row;
    return { ...row, asset: row.asset === from ? to : row.asset, play: row.play === from ? play : row.play, src: url };
  };
  return {
    ...p,
    assets: p.assets.map(fix),
    clips: p.clips.map(c => (c.kind === 'layer' ? c : fix(c))),
  };
};

export const trackOf = (p: VidProject, id: string): VidTrack | null => p.tracks.find(t => t.id === id) ?? null;

/** 播放头 t 落在哪一段上（按轨道上下序，先命中先赢）。`kind` 缺省 = 不挑类型。 */
export const clipAt = (p: VidProject, t: number, kind?: VidTrackKind): VidClip | null => {
  for (const tr of p.tracks) {
    if (tr.kind === 'process') continue;             // process 轨只有占位段，从来不播
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
export const clipAtSolo = (p: VidProject, t: number, soloVideo: ReadonlySet<string>,
  muted: ReadonlySet<string>): VidClip | null => {
  for (const tr of p.tracks) {
    if (tr.kind !== 'video') continue;
    if (muted.has(tr.id)) continue;                        // mute 优先
    if (soloVideo.size > 0 && !soloVideo.has(tr.id)) continue;
    const hit = p.clips.find(c => c.trackId === tr.id && !c.pending && t >= c.start && t < c.start + c.duration);
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
    // 占位段切开后右半丢掉 pending：两半都揣着同一段的快照，各点各的 ▶ 会把这一段跑两遍。
    const { pending: _dropR, ...right } = c;
    clips.push({ ...right, id: newVidId('clip'), groupId: gRight, start: c.start + cut, duration: c.duration - cut, offset: c.offset + cut });
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
  const name = kind === 'video' ? `Video ${n}` : kind === 'layer' ? `Layer ${n}`
    : kind === 'process' ? `Process ${n}` : `Audio ${n}`;
  const track: VidTrack = { id: newVidId('trk'), kind, name };
  // 视频轨 / Layer 轨 / process 轨插到最上面（序 = 数组序，也是渲染的上下序），
  // 音频轨排到所有音频轨的最后。
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
  let asset = p.assets.find(a => a.src === src.src);
  let next = p;
  if (!asset) {
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
    },
  };
  return { ...withTrack, clips: [...withTrack.clips, clip] };
};

/** 一段跑完：把生成器的产物换进去（自己的旧产物按 procOwner 认亲原地换掉）。
 *  生成器段与占位段共用这一条 —— 输出轨、槽位占用、资产入库全是同一套。 */
export const placeVideoGenOutput = (
  p: VidProject, clipId: string, src: string, name: string, duration: number,
): VidProject => placeProcOutput(p, clipId, src, name, duration);

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
    const trackIds = new Set(p.tracks.map(t => t.id));
    const fps = clampFps(Number(p.fps));
    // blob: 的 objectURL 活不过刷新 —— 那些片段/资产当场蒸发；挂在不存在的轨道上的也一样。
    // Layer 段没有 src（它装的是图层，不是素材），所以"必须有 src"那条只对素材段成立。
    const clips = p.clips.filter(c => {
      if (!c || !trackIds.has(c.trackId)) return false;
      if (!Number.isFinite(c.start) || !Number.isFinite(c.duration) || !(c.duration > 0)) return false;
      // 占位段没有 src（等跑完才有）—— 快照要活过重开，照常回来；生成器段同理。
      if (c.pending || c.vgen) return true;
      if (c.kind === 'layer') return c.src === '' || !c.src;
      // A5：有哈希的段永远收回来（src 可由 play/asset 重建）；只有"既没 src 又没哈希"的老 blob: 行丢掉。
      return !!recover(c);
    }).map(c => {
      if (c.pending) {
        // 占位段的输入窗口统一成帧段（旧存档的 ss/t 在这里换掉 —— 存档不再写秒）。
        const inputs = migrateWindows(c.pending.inputs, fps) ?? {};
        const maskInputs = migrateWindows(c.pending.maskInputs, fps);
        return { ...c, pending: { ...c.pending, inputs, ...(maskInputs ? { maskInputs } : { maskInputs: undefined }) } };
      }
      if (c.kind === 'layer') return { ...c, src: '', layerKey: c.layerKey || c.id };
      const src = recover(c);
      return src === c.src ? c : { ...c, src };
    });
    const assets = (Array.isArray(p.assets) ? p.assets : [])
      .filter(a => a && recover(a) && Number.isFinite(a.duration) && a.duration > 0)
      .map(a => { const src = recover(a); return src === a.src ? a : { ...a, src }; });
    // mute / solo 的轨道 id：只留还活着的轨（删轨后重开不该把悬空 id 带回来）。
    const pickIds = (v: unknown): string[] => Array.isArray(v)
      ? [...new Set(v.filter((x): x is string => typeof x === 'string' && trackIds.has(x)))]
      : [];
    return {
      tracks: p.tracks, clips, assets,
      inPoint: Math.max(0, +p.inPoint || 0), outPoint: Math.max(0, +p.outPoint || 0),
      fps: clampFps(Number(p.fps)),
      // Mask 轨：绑的轨没了就当没绑（读档后轨道可能被删/改名）—— 不留一条悬空 id。
      ...(typeof p.maskTrackId === 'string' && trackIds.has(p.maskTrackId)
        ? { maskTrackId: p.maskTrackId } : {}),
      muteIds: pickIds(p.muteIds),
      soloAudioIds: pickIds(p.soloAudioIds),
      soloVideoIds: pickIds(p.soloVideoIds),
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
