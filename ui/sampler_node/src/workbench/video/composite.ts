import { clipsByTrack, type VidClip, type VidProject } from './model';

// ── 逐帧合成：哪一帧归谁 ────────────────────────────────────────────────────────────────────
// 口径（见 model.ts 的轨道序）：轨道的数组序就是上下序，**最上层命中的那一段**决定这一帧怎么出。
//  * 命中 video 段（或者根本没有段）→ null，Player 走原来那条路（主 <video> 自己播）；
//  * 命中 layer 段 → 这一帧交给工作台的图层系统，画面**只有这一段自己的图层**：Layer 段是遮住
//    脚下一层的，不把底下视频帧当底图，所以空段就是一张空图。所有 video 轨的当前帧当"源帧"
//    交过去 —— 面 attribute 的 Frame source 从里面挑（`baseTrackId` 那条只用来定输出栅格）。
// 音频轨不参与：它们不产生画面，声音本来就走 VidAudio。
export type VidCompositeSource = { trackId: string; clip: VidClip };

export type VidCompositePlan = {
  layer: VidClip;
  /** 这一段的图层集 key（= layerKey，缺省时就是段自己的 id）。 */
  layerKey: string;
  /** 脚下第一条视频轨（Layer 段盖住的那条）；null = 脚下没有视频。画面不再画它 —— 它只用来
   *  定输出栅格（`blend-vid-grid`）。面 attribute 另按自己的 frameTrack 从 sources 里挑源帧。 */
  baseTrackId: string | null;
  /** 这一帧所有 video 轨命中的段，按轨道上下序（第一条就是 baseTrackId 那条）。 */
  sources: VidCompositeSource[];
};

const clipOn = (trackId: string, t: number, buckets: Map<string, VidClip[]>): VidClip | null =>
  // 占位段（Processor 还没跑完的坑）没有画面：播放头掠过它 = 它不存在，命中顺延到下一层。
  (buckets.get(trackId) || []).find(c => !c.pending && t >= c.start && t < c.start + c.duration) ?? null;

/** 哪一帧归谁。`muted` 里的 **Layer 轨被跳过**（mute = 这一段不合成，露出底下）—— 于是顶命中
 * 顺延到下一条轨：底下是视频段就照旧直接播，是另一条 Layer 段就换它合成。
 *  视频轨的 mute **不影响 sources**：合成是主动创作（面 attribute 指名要哪条轨的帧），
 *  mute 是监视便利，不该把用户的合成设置弄坏。 */
export const compositePlanAt = (p: VidProject, t: number, muted: ReadonlySet<string>): VidCompositePlan | null => {
  const buckets = clipsByTrack(p);     // 一次分桶,下面每轨只扫自家桶(播放循环每帧都来,O(轨×段) 受不住)
  let top: VidClip | null = null;
  for (const tr of p.tracks) {
    if (tr.kind !== 'video' && tr.kind !== 'layer') continue;
    if (tr.kind === 'layer' && muted.has(tr.id)) continue;   // 静音的 Layer 段不参与合成
    const hit = clipOn(tr.id, t, buckets);
    if (hit) { top = hit; break; }
  }
  if (!top || top.kind !== 'layer') return null;
  const sources: VidCompositeSource[] = [];
  for (const tr of p.tracks) {
    if (tr.kind !== 'video') continue;
    const hit = clipOn(tr.id, t, buckets);
    if (hit) sources.push({ trackId: tr.id, clip: hit });
  }
  return {
    layer: top,
    layerKey: top.layerKey || top.id,
    baseTrackId: sources.length ? sources[0].trackId : null,
    sources,
  };
};

/** 时间线时刻 t 落到的帧栅格；源内时刻再按片段自己的 offset 折。 */
export const vidFrameAt = (fps: number, t: number): number => {
  const f = fps > 0 ? fps : 30;
  return Math.floor(Math.max(0, t) * f + 1e-6) / f;
};

/** 时间线上的 frameT 落到这个片段的源内第几秒（夹在源时长里）。
 *  合成包就是拿它告诉工作台页"这条轨的镜像视频该对到哪" —— 时刻的算法只在这里写一次。 */
export const sourceTime = (clip: VidClip, frameT: number): number => {
  const raw = clip.offset + (frameT - clip.start);
  const end = Math.max(0, clip.srcDuration - 0.001);
  return Math.max(0, Math.min(raw, end));
};

// ── 取帧 ────────────────────────────────────────────────────────────────────────────────────
// **取帧已经不在这一侧。** 逐帧合成的源帧由工作台页面自己的镜像 <video> 播放（见 blend_node 的
// vidSrcSync）：这里只把"这一条轨的源内第几秒"报过去。原先那套"主 <video> 抄一帧 / 其余轨用
// 隐藏 <video> 精确 seek"的路子成本全在跨窗搬像素与 seek 上，播放时每帧都要付一次。

// ── 预热（换段不顿的关键）────────────────────────────────────────────────────────────────────
// 进 Layer 段那一刻如果要现做这些事：建源帧镜像 <video> + 等它 loadeddata + seek + 切图层集 +
// 整画布重渲染 + 首帧合成 —— 主线程上是一整坨，播放里就是一次可感的顿/闪。能提前做的都提前：
// **提前 look 秒算出"下一段要什么"，先把镜像视频挂上加载好、对到那一刻**，进段只剩"折一张图"。
export type VidWarm = {
  /** 下一段 Layer 段的 key 与它开始的时刻。 */
  layerKey: string;
  at: number;
  /** 那一刻每条视频轨命中的段（页面自己按 attribute 的 frameTrack 挑要哪几条）。 */
  tracks: { trackId: string; src: string; want: number }[];
};

/** `look` 秒之内会不会走到一个 Layer 段？会就返回它那一刻的源帧清单（没有就 null）。
 *  只认"起点落在 (t, t+look]"的那一段 —— 已经在段里不算（那是现在的活，不是预热）。 */
export const warmAheadOf = (
  p: VidProject, t: number, muted: ReadonlySet<string>, look = 1.5,
): VidWarm | null => {
  let best: VidClip | null = null;
  for (const c of p.clips) {
    if (c.kind !== 'layer' || c.pending) continue;
    if (c.start <= t || c.start > t + look) continue;
    const tr = p.tracks.find(x => x.id === c.trackId);
    if (!tr || muted.has(tr.id)) continue;                 // 静音的 Layer 轨不合成，也不用预热
    if (!best || c.start < best.start) best = c;
  }
  if (!best) return null;
  const at = best.start;
  const buckets = clipsByTrack(p);
  const tracks: VidWarm['tracks'] = [];
  for (const tr of p.tracks) {
    if (tr.kind !== 'video') continue;
    const hit = (buckets.get(tr.id) || []).find(c => !c.pending && at >= c.start && at < c.start + c.duration);
    if (hit) tracks.push({ trackId: tr.id, src: hit.src, want: sourceTime(hit, at) });
  }
  return { layerKey: best.layerKey || best.id, at, tracks };
};
