import type { VidClip, VidProject } from './model';

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

const clipOn = (p: VidProject, trackId: string, t: number): VidClip | null =>
  p.clips.find(c => c.trackId === trackId && t >= c.start && t < c.start + c.duration) ?? null;

/** 哪一帧归谁。`muted` 里的 **Layer 轨被跳过**（mute = 这一段不合成，露出底下）—— 于是顶命中
 *  顺延到下一条轨：底下是视频段就照旧直接播，是另一条 Layer 段就换它合成。
 *  视频轨的 mute **不影响 sources**：合成是主动创作（面 attribute 指名要哪条轨的帧），
 *  mute 是监视便利，不该把用户的合成设置弄坏。 */
export const compositePlanAt = (p: VidProject, t: number, muted: ReadonlySet<string>): VidCompositePlan | null => {
  let top: VidClip | null = null;
  for (const tr of p.tracks) {
    if (tr.kind !== 'video' && tr.kind !== 'layer') continue;
    if (tr.kind === 'layer' && muted.has(tr.id)) continue;   // 静音的 Layer 段不参与合成
    const hit = clipOn(p, tr.id, t);
    if (hit) { top = hit; break; }
  }
  if (!top || top.kind !== 'layer') return null;
  const sources: VidCompositeSource[] = [];
  for (const tr of p.tracks) {
    if (tr.kind !== 'video') continue;
    const hit = clipOn(p, tr.id, t);
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

const sourceTime = (clip: VidClip, frameT: number): number => {
  const raw = clip.offset + (frameT - clip.start);
  const end = Math.max(0, clip.srcDuration - 0.001);
  return Math.max(0, Math.min(raw, end));
};

// ── 取帧 ────────────────────────────────────────────────────────────────────────────────────
// 底图那一轨由 Player 的主 <video> 自己播（播放时它就是跟手的那一帧，零额外 seek）；
// 其余视频轨（面 attribute 可能指名任何一条）用隐藏的 <video> 逐次 seek 取帧。
// 同一条抓取器串行跑：一条轨上一次 seek 没落地就又来一发，只会把解码器按在地上摩擦。
type Grab = { v: HTMLVideoElement; src: string; ready: Promise<boolean>; chain: Promise<unknown> };

const waitEvent = (v: HTMLVideoElement, name: string, ms: number): Promise<void> =>
  new Promise(resolve => {
    let done = false;
    const fin = () => { if (done) return; done = true; v.removeEventListener(name, fin); resolve(); };
    v.addEventListener(name, fin);
    setTimeout(fin, ms);
  });

export class VidFrameGrabber {
  private grabs = new Map<string, Grab>();
  private scratch = document.createElement('canvas');
  private disposed = false;

  /** 主 <video> 可能就是这一段的源：播放中直接抄当前帧；暂停时等它 seek 到目标（Player 的
   *  transport 订阅者已经把 currentTime 拨过去了，这里只负责等落地）。 */
  async capture(clip: VidClip, frameT: number, main: HTMLVideoElement | null,
    playing: boolean): Promise<ImageBitmap | null> {
    if (this.disposed) return null;
    const want = sourceTime(clip, frameT);
    if (main && main.dataset.clipId === clip.id && main.readyState >= 2) {
      if (!playing) {
        if (Math.abs(main.currentTime - want) > 1 / 60) {
          try { main.currentTime = want; } catch { /* not seekable yet */ }
          await waitEvent(main, 'seeked', 500);
        }
      }
      return this.snap(main);
    }
    const g = this.grab(clip);
    return this.serial(g, async () => {
      if (!(await g.ready) || this.disposed) return null;
      if (Math.abs(g.v.currentTime - want) > 1 / 120) {
        try { g.v.currentTime = want; } catch { /* not seekable yet */ }
        await waitEvent(g.v, 'seeked', 1200);
      }
      return this.snap(g.v);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const g of this.grabs.values()) {
      try { g.v.pause(); g.v.removeAttribute('src'); g.v.load(); } catch { /* already gone */ }
    }
    this.grabs.clear();
  }

  private grab(clip: VidClip): Grab {
    const old = this.grabs.get(clip.id);
    if (old && old.src === clip.src) return old;
    if (old) {
      try { old.v.pause(); old.v.removeAttribute('src'); old.v.load(); } catch { /* already gone */ }
      this.grabs.delete(clip.id);
    }
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = clip.src;
    const ready = new Promise<boolean>(resolve => {
      const ok = () => resolve(true);
      const bad = () => resolve(false);
      v.addEventListener('loadeddata', ok, { once: true });
      v.addEventListener('error', bad, { once: true });
      setTimeout(bad, 8000);
    });
    const g: Grab = { v, src: clip.src, ready, chain: Promise.resolve() };
    this.grabs.set(clip.id, g);
    return g;
  }

  private serial<T>(g: Grab, job: () => Promise<T>): Promise<T> {
    const p = g.chain.then(job, job);
    g.chain = p.catch(() => { /* keep the chain alive */ });
    return p;
  }

  private async snap(v: HTMLVideoElement): Promise<ImageBitmap | null> {
    const w = v.videoWidth, h = v.videoHeight;
    if (!w || !h || this.disposed) return null;
    if (this.scratch.width !== w || this.scratch.height !== h) {
      this.scratch.width = w;
      this.scratch.height = h;
    }
    const g = this.scratch.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, w, h);
    try { g.drawImage(v, 0, 0, w, h); } catch { return null; }
    try { return await createImageBitmap(this.scratch); } catch { return null; }
  }
}
