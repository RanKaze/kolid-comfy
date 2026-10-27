import { clipsByTrack, type VidClip, type VidFrameNeed, type VidProject } from './model';

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

/** 这一段的 Frame source 是不是**引用了静音的视频轨**。
 *  静音 = 这条轨不显示（"mute 优先"），而这一段只能靠它出画面 ⇒ 引用失效：这一段合成不出画面，
 *  按"不合成"处理（露出底下），与静音的 Layer 轨同一读法。
 *  **只认静音**：轨上那一刻没有片（空档）是正常编辑状态，decal 就该是空的，段照常合成。 */
const layerRefMuted = (key: string, muted: ReadonlySet<string>, need?: VidFrameNeed): boolean => {
  const list = key && need ? need[key] : null;
  if (!list || !list.length) return false;
  for (const tr of list) if (muted.has(tr)) return true;
  return false;
};

/** 哪一帧归谁。`muted` 里的 **Layer 轨被跳过**（mute = 这一段不合成，露出底下）—— 于是顶命中
 * 顺延到下一条轨：底下是视频段就照旧直接播，是另一条 Layer 段就换它合成。
 * **Frame source 引用了静音视频轨的 Layer 段同样跳过**（见 layerRefMuted）：它拿不到画面。
 *  其余情况下视频轨的 mute **不影响 sources**：合成是主动创作（面 attribute 指名要哪条轨的帧），
 * 静音一条没被引用的轨不该把用户的合成设置弄坏。 */
export const compositePlanAt = (
  p: VidProject, t: number, muted: ReadonlySet<string>, need?: VidFrameNeed,
): VidCompositePlan | null => {
  const buckets = clipsByTrack(p);     // 一次分桶,下面每轨只扫自家桶(播放循环每帧都来,O(轨×段) 受不住)
  let top: VidClip | null = null;
  for (const tr of p.tracks) {
    if (tr.kind !== 'video' && tr.kind !== 'layer') continue;
    if (tr.kind === 'layer' && muted.has(tr.id)) continue;   // 静音的 Layer 段不参与合成
    const hit = clipOn(tr.id, t, buckets);
    if (!hit) continue;
    // 这一段的面只能从一条静音轨取帧 ⇒ 出不了画面，跳过（底下照常出）
    if (hit.kind === 'layer' && layerRefMuted(hit.layerKey || hit.id, muted, need)) continue;
    top = hit;
    break;
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

// ── 预热（扫过即热）──────────────────────────────────────────────────────────────────────────
// 播放头扫过时间线，**每一段都要提前备好** —— 不管它此刻在不在播：
//   · 普通视频段：它的 (轨,源) 镜像先挂上、解出来（blend-vid-warm-src，裸预热）——这段源多半
//     会在别处被引用（别段 Layer 的 Frame source 绑的就是轨），等真要用时只剩一次便宜的 seek；
//   · Layer 段：镜像对到段起点，再"先折一张丢掉"（blend-vid-warm，特效链第一次跑的编译/分配
//     挪到进段之前付）。
// 镜像按 (轨,源) 复合建键（见 blend_node 的 vidSrcVideos），所以"扫过就忘"不存在：同一条轨上的
// 多段素材各留各的热镜像，回跳/跨段引用都不再冷启动。池子 LRU 有界（下限 6 + 正用数 + 余量）。
export type VidWarm = {
  /** 下一段 Layer 段的 key 与它开始的时刻。 */
  layerKey: string;
  at: number;
  /** 那一刻每条视频轨命中的段（页面自己按 attribute 的 frameTrack 挑要哪几条）。 */
  tracks: { trackId: string; src: string; want: number }[];
};

export type VidSweep = {
  /** 此刻覆盖播放头的视频段（每条视频轨至多一条）——裸预热，不折图。 */
  srcs: { trackId: string; src: string; want: number }[];
  /** look 秒内开始的所有 Layer 段（同 layerKey 取最早起点），按 start 升序。 */
  segs: VidWarm[];
};

/** 播放头此刻的预热清单。**按引用关系精确定靶**：
 *  一条视频段需要热镜像，当且仅当**有 Layer 段会吃它的帧** —— 某套图层集的 Frame source 指着
 *  它所在的轨，且那套的某个 Layer 段与它在时间线上重叠（段内每一刻吃的都是盖着它的那条素材）。
 *  没有任何 Layer 段引用的轨，它的画面只经 #vidBaseVideo 出画，永远不需要镜像 —— 一个解码器都不占。
 *  静音的 Layer 轨、Frame source 引用了静音视频轨的段不会合成（与 compositePlanAt 同口径），
 *  它们的引用是死引用，不算数。引用表（frameNeed）由工作台页面随编辑实时上报，改了贴片下一拍
 *  预热集自动跟着变。 */
export const warmSweepAt = (
  p: VidProject, t: number, muted: ReadonlySet<string>, look = 4, need?: VidFrameNeed,
): VidSweep => {
  const buckets = clipsByTrack(p);     // 一次分桶,下面每轨只扫自家桶
  // 这段素材的帧会不会被某个 Layer 段吃掉（见函数头注释）。
  const consumed = (clip: VidClip, trackId: string): boolean => {
    for (const c of p.clips) {
      if (c.kind !== 'layer' || c.pending) continue;
      if (!(c.start < clip.start + clip.duration && clip.start < c.start + c.duration)) continue;
      const list = (need && c.layerKey ? need[c.layerKey] : null) || null;
      if (!list || !list.length || !list.includes(trackId)) continue;
      const tr = p.tracks.find(x => x.id === c.trackId);
      if (!tr || muted.has(tr.id)) continue;                          // 静音的 Layer 轨：不合成，引用是死的
      if (layerRefMuted(c.layerKey || c.id, muted, need)) continue;   // 引用了静音视频轨：同样出不了画面
      return true;
    }
    return false;
  };
  const srcs: VidSweep['srcs'] = [];
  for (const tr of p.tracks) {
    if (tr.kind !== 'video') continue;
    const hit = (buckets.get(tr.id) || []).find(c => !c.pending && t >= c.start && t < c.start + c.duration);
    if (hit && hit.src && consumed(hit, tr.id)) srcs.push({ trackId: tr.id, src: hit.src, want: sourceTime(hit, t) });
  }
  // 窗口内开始的所有 Layer 段；同 layerKey（同一套图层集铺了好几段）取最早的那条 —— 镜像与
  // 特效链都是按 layerKey 备的，一份就够。轨清单按 frameNeed 过滤：只送真会被吃的那几条
  // （引用表还没到时不过滤，页面那边照旧按自己的 need 兜底）。
  const best = new Map<string, VidClip>();
  for (const c of p.clips) {
    if (c.kind !== 'layer' || c.pending) continue;
    if (c.start <= t || c.start > t + look) continue;
    const tr = p.tracks.find(x => x.id === c.trackId);
    if (!tr || muted.has(tr.id)) continue;                 // 静音的 Layer 轨不合成，也不用预热
    if (layerRefMuted(c.layerKey || c.id, muted, need)) continue;   // 引用失效的段不会合成，别白等
    const key = c.layerKey || c.id;
    const prev = best.get(key);
    if (!prev || c.start < prev.start) best.set(key, c);
  }
  const segs: VidWarm[] = [];
  for (const c of [...best.values()].sort((a, b) => a.start - b.start)) {
    const key = c.layerKey || c.id;
    const wantTracks = new Set((need && need[key]) || []);
    const at = c.start;
    const tracks: VidWarm['tracks'] = [];
    for (const tr of p.tracks) {
      if (tr.kind !== 'video') continue;
      if (wantTracks.size && !wantTracks.has(tr.id)) continue;      // 没人吃这条轨：不必随段预热
      const hit = (buckets.get(tr.id) || []).find(cc => !cc.pending && at >= cc.start && at < cc.start + cc.duration);
      if (hit) tracks.push({ trackId: tr.id, src: hit.src, want: sourceTime(hit, at) });
    }
    segs.push({ layerKey: key, at, tracks });
  }
  return { srcs, segs };
};
