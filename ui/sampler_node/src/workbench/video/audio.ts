// ── Video 模式的音频侧 ────────────────────────────────────────────────────────────────────────
// 三件事：
//  1. `decodeAudio` —— 把一个媒体 URL 里的音轨解成 AudioBuffer（带缓存）。这也是"这个源有没有
//     音频"的权威判据：decodeAudioData 咬不动（没有音轨 / 不是媒体）就返回 null。视频元素的
//     mozHasAudio 那几条探测在 Chrome 之外不可靠，不指望它们。
//  2. `probeMedia` —— 导入前的体检：时长（<video> 元数据，纯音频回退到 buffer 长度）+ 有无音频。
//  3. `VidAudio` —— 播放引擎的音频半边。视频画面走 <video>（静音），声音只从这条路出来：
//     播放头扫到哪段音频（音频轨上的片段，含视频拆出来的联动段），就把它的 buffer 从正确的
//     offset 起播；扫出去就停。AudioContext 惰性创建（第一次按播放 = 一次用户手势，不踩
//     autoplay 政策）。

let ctx: AudioContext | null = null;
export const audioCtx = (): AudioContext => {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
};

const bufCache = new Map<string, Promise<AudioBuffer | null>>();

export function decodeAudio(src: string): Promise<AudioBuffer | null> {
  let p = bufCache.get(src);
  if (!p) {
    p = fetch(src)
      .then(r => r.arrayBuffer())
      .then(ab => audioCtx().decodeAudioData(ab))
      .then(buf => (buf.duration > 0 ? buf : null))
      .catch(() => null);
    bufCache.set(src, p);
  }
  return p;
}

export type MediaInfo = {
  duration: number;
  hasAudio: boolean;
  /** <video> 咬不动（mp3/wav 这类纯音频容器），只能落在音频轨上。 */
  audioOnly: boolean;
};

/** 导入体检。`hint` 只是起点：探测自己会改口（mp3 递进来当视频探，最后仍按音频归来）。 */
export async function probeMedia(src: string, hint: 'video' | 'audio'): Promise<MediaInfo | null> {
  const buf = await decodeAudio(src);
  if (hint === 'audio') {
    if (!buf) return null;
    return { duration: buf.duration, hasAudio: true, audioOnly: true };
  }
  const metaDur = await new Promise<number>(resolve => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const done = (d: number) => { v.removeAttribute('src'); v.load(); resolve(d); };
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : 0);
    v.onerror = () => done(0);
    v.src = src;
    setTimeout(() => done(Number.isFinite(v.duration) ? v.duration : 0), 8000);
  });
  if (!metaDur && !buf) return null;      // 两个口子都咬不动：不是可播的媒体
  return {
    duration: metaDur || (buf ? buf.duration : 0),
    hasAudio: !!buf,
    audioOnly: !metaDur,
  };
}

/** 一路声源。`into` = 起播时 buffer 内的秒；`at` = 起播那一刻的 ctx 时钟 —— 两者一减就知道
 *  「现在播到 buffer 的哪一秒」，播放循环拿它跟游标该在的位置对表。 */
type Voice = { node: AudioBufferSourceNode; gain: GainNode; into: number; at: number };

export class VidAudio {
  private master: GainNode | null = null;
  private voices = new Map<string, Voice>();

  private ensure(): GainNode {
    const c = audioCtx();
    if (!this.master) {
      this.master = c.createGain();
      this.master.gain.value = 1;
      this.master.connect(c.destination);
    }
    return this.master;
  }

  /** 把 `buffer` 从 `into`（buffer 内的秒）起播，挂在 `id` 名下。同一 id 旧声源先停。 */
  start(id: string, buffer: AudioBuffer, into: number): void {
    this.stop(id);
    const c = audioCtx();
    const node = c.createBufferSource();
    node.buffer = buffer;
    const gain = c.createGain();
    node.connect(gain);
    gain.connect(this.ensure());
    const at = Math.max(0, Math.min(into, Math.max(buffer.duration - 0.01, 0)));
    node.start(0, at);
    this.voices.set(id, { node, gain, into: at, at: c.currentTime });
  }

  has(id: string): boolean { return this.voices.has(id); }

  /** 汇流节点(惰性建):audioFocus 的电平探头挂在它上面 —— 所有声源都在这条总线汇合,
   *  一只探头就能代表整个播放器的电平。 */
  node(): GainNode { return this.ensure(); }

  /** 这路声源现在播到 buffer 内的第几秒（未播 = null）。播放循环拿它跟游标该在的位置对表，
   *  差得多了就重新起播 —— 回绕、拖动、片段被搬动，全都是「想听的位置变了」这一种病。 */
  pos(id: string): number | null {
    const v = this.voices.get(id);
    if (!v) return null;
    return v.into + (audioCtx().currentTime - v.at);
  }
  stop(id: string): void {
    const v = this.voices.get(id);
    if (v) {
      try { v.node.stop(); } catch { /* already ended */ }
      try { v.node.disconnect(); v.gain.disconnect(); } catch { /* noop */ }
      this.voices.delete(id);
    }
  }
  stopAll(): void { for (const id of [...this.voices.keys()]) this.stop(id); }
}

/** 播放引擎的音频半边是全局单例 —— 两扇窗（Player 的 tick、将来的 scrub 预听）共享同一套声源。 */
export const vidAudio = new VidAudio();
