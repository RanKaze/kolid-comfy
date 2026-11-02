// ── Video 模式的音频侧：只做解码与体检 ──────────────────────────────────────────────────────
//
// **时间线声音不从这里出去。** 音频轨/视频带的声音由 pcmClips 解码后交给本机引擎
// （KolidAudio.dll），与 MIDI 轨在同一个音频线程里混音 —— 播放/暂停/seek 只认那一条路。
// 这里剩下的两件事都是"准备数据"，不是播放：
//  1. `decodeAudio` —— 把媒体 URL 解成 AudioBuffer（带缓存）。时间线 PCM 上传、波形抽条都用它；
//     它也是"这个源有没有音频"的权威判据（decodeAudioData 咬不动 = 没有音轨/不是媒体）。
//  2. `probeMedia` —— 导入前的体检：时长（<video> 元数据，纯音频回退到 buffer 长度）+ 有无音频。
//
// AudioContext 只在解码/探针/Inspector 预听时惰性创建；它不再承担任何走带播放。

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
