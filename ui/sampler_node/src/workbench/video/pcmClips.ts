// ── 时间线音频段 → 原生引擎（时间线声音的唯一出口，见 timelineAudio.ts）──────────────────
//
// 段子的 PCM **一次解码**好交到 DLL（48 kHz 交错 int16），按**绝对帧**摆放，和 MIDI 音符
// 在同一条音频线程里混音 —— 暂停 / seek / 循环回绕都由"时钟位置"自然成立，页面不再播音频。
//
// ── 三条规矩（以后加"往引擎送声音"的功能照这个来，见 audio_bridge.py 的 _PcmBook）──
//  1. **会话**：这扇窗有一次加载 = 一个 session。只有"作者会话"（正在出声的那扇窗）的摆放
//     会被引擎接受；别的窗可以把 PCM 传上去备着，但放不响 —— 两扇窗同时放同一段时间线
//     就是同一声听两遍（切 Mute / 切 Loop 时"突然多一层"就是这么来的）。
//  2. **片段**：按 clip id 认主，槽位由后端分配；关窗（pagehide）时整批 release，
//     心跳超期也会被后端回收 —— 关掉的窗不会留在引擎里继续响。
//  3. **代际**：每次整份状态同步 +1。摆放带 gen，比已应用的旧就丢弃：切 Mute/Loop 会重推
//     整份状态，乱序与重试的旧推送不能把旧摆放复活。
//
// 只上传一次：片段换源才重传；拖动/裁剪/静音只改摆放（pcm_set），不发 PCM。

import { PAGE_SESSION } from '../../midi/session';
import { decodeAudio } from './audio';
import { audioAudible, audioTrackGain, type VidProject } from './model';

const RATE = 48000;
const PCM_CLIENT_ABI = 3;        // 与 audio_bridge.py 的 PCM_CLIENT_ABI 一致
const SESSION = PAGE_SESSION;    // 这扇窗这一次加载的身份（播放命令那边也用它定作者）

/** 0.5 s 一块：96 KB int16 / 128 KB base64，本地环回一趟几十毫秒。 */
const CHUNK_FRAMES = 24000;

type Desired = { start: number; offset: number; length: number; gain: number };
type Entry = {
  id: string;
  src: string;
  frames: number;
  ready: boolean;
  placed: boolean;      // 引擎确认收下这次摆放（作者会话才会）
  want: Desired;
  applied: string;      // 已经发出去的那一份摆放（去重用）
  posting: boolean;
  busy: boolean;
  tries: number;        // 上传轮次：失败要能自己再试（服务端重启/瞬时 500 时不能永久哑）
};

const entries = new Map<string, Entry>();
const pcmCache = new Map<string, Promise<{ pcm: Int16Array; frames: number } | null>>();

let active = false;              // 有任何一个段子真的交给了引擎
/** 整份状态同步的代际：每次 flush +1，摆放带它。 */
let pushGen = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();

// ── 一次性音效（Keyframe 音频事件点触发）────────────────────────────────────────────────────
// 与时间线共用同一条 PCM 通道与同一把「作者会话」的锁：只有正在出声的那扇窗摆得响。
// start / offset 都是**绝对帧 / 片段内帧**，和 pcm_set 的口径一致；每次触发用一个新 clip id，
// 播完（length + 400ms 尾巴）自动 pcm_clear，别把槽位留给下一声。
// 上限 16 条并发：后端 PCM 槽只有 64 个且时间线优先，事件音效不能把时间线挤掉。

const MAX_ONE_SHOTS = 16;
const oneShots = new Map<string, ReturnType<typeof setTimeout>>();
let oneShotSeq = 0;

/** 清掉本窗所有还挂着的事件音效（停止 / seek / 回绕时调）。 */
export const clearOneShots = (): void => {
  for (const [clip, timer] of oneShots) {
    clearTimeout(timer);
    void post('pcm_clear', { clip, gen: 0 });
  }
  oneShots.clear();
};

/**
 * 播一条一次性音效。返回 false = 本次不发声（同一份 PCM 解码失败 / 槽满 / 非作者）。
 * `tag` 只用来拼 clip id，方便在诊断日志里认出是哪颗事件点。
 */
export const playOneShot = async (
  src: string, startSec: number, offsetSec: number, gain: number, tag: string,
): Promise<boolean> => {
  if (!(gain > 0.0001) || !src) return false;
  if (oneShots.size >= MAX_ONE_SHOTS) return false;
  const data = await pcmOf(src);
  if (!data) return false;
  const offset = Math.max(0, Math.round(offsetSec * RATE));
  if (offset >= data.frames) return false;
  const length = data.frames - offset;
  const start = Math.max(0, Math.round(startSec * RATE));
  const clip = `evt:${tag}:${++oneShotSeq}`;
  if (!await uploadRaw(clip, data.frames, data.pcm)) {
    void post('pcm_clear', { clip, gen: 0 });
    return false;
  }
  const res = await post('pcm_set', { clip, gen: 0, start, offset, length, gain });
  if (!res || res.ok !== true) {
    void post('pcm_clear', { clip, gen: 0 });
    return false;
  }
  const timer = setTimeout(() => {
    oneShots.delete(clip);
    void post('pcm_clear', { clip, gen: 0 });
  }, (length / RATE) * 1000 + 400);
  oneShots.set(clip, timer);
  return true;
};

/** 引擎此刻有没有在替时间线出声（Audio Monitor 据此去轮询引擎峰值）。 */
export const engineTimelineActive = (): boolean => active;

const post = async (op: string, extra: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
  try {
    const r = await fetch('/api/audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // v = 时间线 PCM 的客户端协议号；session = 这扇窗这一次加载。
      // 旧页面两样都没有 —— 后端一律拒收（它那边还有一条 WebAudio 在放同一段时间线）。
      body: JSON.stringify({ op, v: PCM_CLIENT_ABI, session: SESSION, ...extra }),
    });
    const j = await r.json();
    if (!r.ok) {
      console.warn('[pcm] %s failed: HTTP %d %o', op, r.status, j);
      return null;
    }
    return (j && typeof j === 'object' ? j : null) as Record<string, unknown> | null;
  } catch (err) {
    console.warn('[pcm] %s failed:', op, err);
    return null;
  }
};

const clamp16 = (v: number): number => (v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v));

const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(bytes.length, i + step))));
  }
  return btoa(s);
};

/** 解码 + 线性重采样到 48 kHz + 归一成交错 int16。同一 src 只做一次。 */
const pcmOf = (src: string): Promise<{ pcm: Int16Array; frames: number } | null> => {
  let p = pcmCache.get(src);
  if (!p) {
    p = decodeAudio(src).then(buf => {
      if (!buf) return null;
      const frames = Math.max(1, Math.ceil(buf.duration * RATE));
      const l = buf.getChannelData(0);
      const r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
      const ratio = buf.sampleRate / RATE;
      const out = new Int16Array(frames * 2);
      for (let i = 0; i < frames; i++) {
        const s = i * ratio;
        const i0 = s | 0;
        const f = s - i0;
        const l0 = l[i0] ?? 0, l1 = l[i0 + 1] ?? l0;
        const r0 = r[i0] ?? 0, r1 = r[i0 + 1] ?? r0;
        out[i * 2] = clamp16((l0 + (l1 - l0) * f) * 32767);
        out[i * 2 + 1] = clamp16((r0 + (r1 - r0) * f) * 32767);
      }
      return { pcm: out, frames };
    }).catch(() => null);
    pcmCache.set(src, p);
  }
  return p;
};

const recomputeActive = (): void => {
  active = [...entries.values()].some(e => e.ready && e.placed && e.want.gain > 0 && e.want.length > 0);
};

const applyPlacement = (e: Entry): void => {
  const key = e.want.start + ':' + e.want.offset + ':' + e.want.length + ':' + e.want.gain.toFixed(3);
  if (key === e.applied || e.posting) return;
  e.posting = true;
  const want = { ...e.want };
  void post('pcm_set', {
    clip: e.id, gen: pushGen,
    start: want.start, offset: want.offset, length: want.length, gain: want.gain,
  }).then(r => {
    e.posting = false;
    if (!r) return;                              // 网络失败：留着，下一次 flush 重发
    if (r.ok === true) {
      e.applied = key;
      if (want.gain > 0 && want.length > 0) e.placed = true;
      recomputeActive();
      return;
    }
    // 不是作者 = 这一发已经"落地"（后端明确拒绝），别每帧重发；claim 时会清 applied 重来。
    if (r.not_owner === true) { e.applied = key; return; }
    // 引擎不认识这段（数据被回收/引擎重开）：重新上传，别装作摆好了。
    if (r.error === 'unknown pcm clip') {
      e.ready = false;
      e.placed = false;
      e.applied = '';
      queue(() => upload(e));
      return;
    }
  });
};

/** 传一次 PCM：begin → 分块 → finish。任何一步失败都返回 false（下次整段重来）。 */
const uploadRaw = async (clip: string, frames: number, pcm: Int16Array): Promise<boolean> => {
  const begun = await post('pcm_begin', { clip, frames, channels: 2 });
  if (!begun || begun.ok !== true) {
    if (begun && begun.error) console.warn('[pcm] %s: %s', clip, begun.error);
    return false;
  }
  const bytes = new Uint8Array(pcm.buffer);
  for (let off = 0; off < frames; off += CHUNK_FRAMES) {
    const n = Math.min(CHUNK_FRAMES, frames - off);
    const res = await post('pcm_chunk', {
      clip, offset: off,
      data: toBase64(bytes.subarray(off * 4, (off + n) * 4)),
    });
    if (!res || res.ok !== true) return false;
  }
  const fin = await post('pcm_finish', { clip });
  return !!fin && fin.ok === true;
};

const uploadOnce = (e: Entry, frames: number, pcm: Int16Array): Promise<boolean> =>
  uploadRaw(e.id, frames, pcm);

/** 上传是**唯一**出声的前提：失败就退避重试，别让一段音频悄悄变成静音。 */
const upload = async (e: Entry): Promise<void> => {
  if (e.busy) return;
  e.busy = true;
  try {
    const data = await pcmOf(e.src);
    if (!data) {
      console.warn('[pcm] cannot decode audio for clip %s', e.id);
      return;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise<void>(r => setTimeout(r, 400 * attempt));
      if (!await uploadOnce(e, data.frames, data.pcm)) continue;
      e.frames = data.frames;
      e.ready = true;
      e.tries = 0;
      e.applied = '';              // 重新落一次摆放（begin 把 active 关了）
      applyPlacement(e);
      return;
    }
    // 三次都失败也**不许就此认定静音**：服务端可能正在重启 / 刚才还是旧协议。
    // 退避后再来（1.5s → 3s → 6s → 封顶 15s），直到成功或片段被删。
    const delay = Math.min(15000, 1500 * (1 << Math.min(e.tries, 3)));
    e.tries++;
    console.warn('[pcm] clip %s upload failed, retry in %dms', e.id, delay);
    setTimeout(() => {
      if (!e.ready && entries.get(e.id) === e) queue(() => upload(e));
    }, delay);
  } finally {
    e.busy = false;
  }
};

const queue = (fn: () => Promise<void>): void => {
  chain = chain.then(fn).catch(() => { /* 单个失败不拖死队列 */ });
};

/** 本窗按了播放（后端已把 PCM 作者定成这扇窗）之后调：之前被 not_owner 拒掉的摆放
 *  整份重落一遍，没传完的补传。见 timelineAudio.ts。 */
export const refreshPlacements = (): void => {
  pushGen++;
  for (const e of entries.values()) e.applied = '';
  for (const e of entries.values()) {
    if (e.ready) applyPlacement(e);
    else queue(() => upload(e));
  }
};

/** 关窗 / 刷新：把本会话名下的 PCM 整批还掉（beacon 在卸载时也发得出去）。 */
const releaseSession = (): void => {
  try {
    const body = JSON.stringify({ op: 'pcm_release', v: PCM_CLIENT_ABI, session: SESSION });
    navigator.sendBeacon('/api/audio', new Blob([body], { type: 'application/json' }));
  } catch { /* 卸载路上发不出去也没关系：后端有心跳超期兜底 */ }
};

if (typeof window !== 'undefined') {
  // bfcache 恢复（persisted）不算关窗：那时不该清，清了回来就哑了。
  window.addEventListener('pagehide', ev => { if (!ev.persisted) releaseSession(); });
}

const flush = (project: VidProject, solo: ReadonlySet<string>, mute: ReadonlySet<string>): void => {
  pushGen++;
  const live = new Set<string>();
  for (const c of project.clips) {
    if (c.kind !== 'audio' || !c.src) continue;
    live.add(c.id);
    let e = entries.get(c.id);
    if (!e) {
      e = { id: c.id, src: c.src, frames: 0, ready: false, placed: false,
        want: { start: 0, offset: 0, length: 0, gain: 0 }, applied: '', posting: false, busy: false, tries: 0 };
      entries.set(c.id, e);
    }
    const audible = audioAudible(c.trackId, solo, mute);
    e.want = {
      start: Math.max(0, Math.round(c.start * RATE)),
      offset: Math.max(0, Math.round((c.offset || 0) * RATE)),
      length: Math.max(0, Math.round(c.duration * RATE)),
      // 混音增益：Fader 窗写的推子在 audible 之上再做一次衰减（mute / solo 仍然优先）。
      gain: audible ? audioTrackGain(project, c.trackId) : 0,
    };
    if (e.src !== c.src) {
      e.src = c.src;
      e.ready = false;
      e.placed = false;
      e.applied = '';
    }
    if (!e.ready) queue(() => upload(e));
    else applyPlacement(e);
  }

  // 删掉的段子：把槽还回去
  for (const [id, e] of [...entries]) {
    if (live.has(id)) continue;
    entries.delete(id);
    void post('pcm_clear', { clip: id, gen: pushGen });
    if (e.placed) recomputeActive();
  }

  recomputeActive();
};

let lastSig = '';

/** 工程/静音/独奏变了就调一次；内部去抖 150ms、去重同样的摆放。 */
export const syncEngineClips = (
  project: VidProject,
  solo: ReadonlySet<string>,
  mute: ReadonlySet<string>,
): void => {
  const sig = project.clips
    .filter(c => c.kind === 'audio')
    .map(c => [c.id, c.src, c.start.toFixed(3), c.duration.toFixed(3), (c.offset || 0).toFixed(3),
      audioAudible(c.trackId, solo, mute) ? audioTrackGain(project, c.trackId).toFixed(3) : '0'].join(','))
    .join('|');
  if (sig === lastSig) return;
  lastSig = sig;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush(project, solo, mute);
  }, 150);
};

// 诊断口：探针拿它对着真引擎跑一遍"上传 → 摆放 → 静音"的整条路（见 probe_pcm_clips_ui）。
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__kolidPcm = {
    sync: syncEngineClips,
    active: engineTimelineActive,
    refresh: refreshPlacements,
    session: SESSION,
  };
}
