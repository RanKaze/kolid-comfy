// ── 时间线音频段 → 原生引擎 ─────────────────────────────────────────────────────────────────
//
// 以前音频段由页面用 WebAudio 自己播：引擎里 MIDI 走一条混音、页面里音频走另一条，
// 暂停语义/电平表/峰值全对不上。现在把段子的 PCM **一次解码**好交到 DLL（48 kHz 交错 int16），
// 按绝对帧摆放，和音符同一条音频线程混音 —— 暂停 / seek / 循环都由位置自然成立。
//
// 只上传一次：片段换源才重传；拖动/裁剪/静音只改摆放（pcm_set），不发 PCM。
// 16 个槽（与 DLL 的 KA_MAX_CLIPS 一致），超出的段子这一版先不发声（会在控制台点名）。

import { decodeAudio } from './audio';
import { audioAudible, type VidProject } from './model';

const RATE = 48000;
const MAX_SLOTS = 16;
/** 0.5 s 一块：96 KB int16 / 128 KB base64，本地环回一趟几十毫秒。 */
const CHUNK_FRAMES = 24000;

type Desired = { start: number; offset: number; length: number; gain: number };
type Entry = {
  id: string;
  slot: number;
  src: string;
  frames: number;
  ready: boolean;
  placed: boolean;      // 引擎确认收下这次摆放
  want: Desired;
  applied: string;
  posting: boolean;
  busy: boolean;
};

const entries = new Map<string, Entry>();
const slots: (string | null)[] = new Array(MAX_SLOTS).fill(null);
const pcmCache = new Map<string, Promise<{ pcm: Int16Array; frames: number } | null>>();

let active = false;              // 有任何一个段子真的交给了引擎
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();

/** 引擎此刻有没有在替时间线出声（Audio Monitor 据此去轮询引擎峰值）。 */
export const engineTimelineActive = (): boolean => active;

const post = async (op: string, extra: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
  try {
    const r = await fetch('/api/audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, ...extra }),
    });
    const j = await r.json();
    return (j && typeof j === 'object' ? j : null) as Record<string, unknown> | null;
  } catch {
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
    slot: e.slot, start: want.start, offset: want.offset,
    length: want.length, gain: want.gain,
  }).then(r => {
    e.posting = false;
    if (r && r.ok === true) {
      e.applied = key;
      if (want.gain > 0 && want.length > 0) e.placed = true;
      recomputeActive();
    }
  });
};

const upload = async (e: Entry): Promise<void> => {
  if (e.busy) return;
  e.busy = true;
  try {
    const data = await pcmOf(e.src);
    if (!data) return;
    const begun = await post('pcm_begin', { slot: e.slot, frames: data.frames, channels: 2 });
    if (!begun || begun.ok !== true) return;
    const bytes = new Uint8Array(data.pcm.buffer);
    for (let off = 0; off < data.frames; off += CHUNK_FRAMES) {
      const n = Math.min(CHUNK_FRAMES, data.frames - off);
      const res = await post('pcm_chunk', {
        slot: e.slot, offset: off,
        data: toBase64(bytes.subarray(off * 4, (off + n) * 4)),
      });
      if (!res || res.ok !== true) return;
    }
    const fin = await post('pcm_finish', { slot: e.slot });
    if (!fin || fin.ok !== true) return;
    e.frames = data.frames;
    e.ready = true;
    e.applied = '';              // 重新落一次摆放（begin 把 active 关了）
    applyPlacement(e);
  } finally {
    e.busy = false;
  }
};

const slotFor = (id: string): number => {
  const free = slots.indexOf(null);
  if (free < 0) return -1;
  slots[free] = id;
  return free;
};

const queue = (fn: () => Promise<void>): void => {
  chain = chain.then(fn).catch(() => { /* 单个失败不拖死队列 */ });
};

const flush = (project: VidProject, solo: ReadonlySet<string>, mute: ReadonlySet<string>): void => {
  const live = new Set<string>();
  for (const c of project.clips) {
    if (c.kind !== 'audio' || !c.src) continue;
    live.add(c.id);
    let e = entries.get(c.id);
    if (!e) {
      const slot = slotFor(c.id);
      if (slot < 0) { console.warn('[pcm] 超过 %d 个音频段，这一段先不发声：%s', MAX_SLOTS, c.id); continue; }
      e = { id: c.id, slot, src: c.src, frames: 0, ready: false, placed: false,
        want: { start: 0, offset: 0, length: 0, gain: 0 }, applied: '', posting: false, busy: false };
      entries.set(c.id, e);
    }
    const audible = audioAudible(c.trackId, solo, mute);
    e.want = {
      start: Math.max(0, Math.round(c.start * RATE)),
      offset: Math.max(0, Math.round((c.offset || 0) * RATE)),
      length: Math.max(0, Math.round(c.duration * RATE)),
      gain: audible ? 1 : 0,
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
    slots[e.slot] = null;
    void post('pcm_clear', { slot: e.slot });
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
      audioAudible(c.trackId, solo, mute) ? 1 : 0].join(','))
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
  };
}
