// ── 原生引擎 → Audio Monitor 的电平桥 ────────────────────────────────────────────────────────
//
// 页面上的 WebAudio 声源自己搭 analyser(见 workbench/video/audioFocus.ts);MIDI 的声音是
// KolidAudio.dll 与插件 worker 直接送去声卡的,浏览器里没有图可读。所以这里把引擎自报的峰值
// 当电平,交给**同一个**独占音频槽:
//
//   * 传输在播 → 持槽,停了 → 还槽。被别的声源抢占时 onRevoked 把传输停下(全页同一时刻只许
//     一处出声,那是 audioFocus 的规矩)。
//   * 试听/预听(engine 的 audition / preview)没有"播完了"的回调,就托管一小段:点下去先无条件
//     保 1.2 秒,之后以"峰值落回 0 满 0.5 秒"为结束,最长 12 秒兜底 —— 试听音本身只有 0.7 秒。
//
// 轮询只在持槽期间跑(33ms 一次,回的只有一个 int);峰值是**单声道**的(引擎与插件都按各声道
// 取最大报数),左右两条表照同一个值画,因此 Monitor 在原生源上不画那两枚 M 键。

import { acquireAudioSlot, releaseAudioSlot } from '../workbench/video/audioFocus';
import { clock } from './clock';

const SLOT_ID = 'midi-native';
/** 与显示器的一帧同量级:30Hz 够表跟着音符起落,再快只是白问。 */
const POLL_MS = 33;
const AUDITION_FLOOR_MS = 1200;
const TAIL_MS = 500;
const MAX_AUDITION_MS = 12000;

let peak = 0;                    // 千分比(引擎与插件都是这个口径)
let poll = 0;
let inflight = false;
let held = false;
let label = '';
let auditionAt = 0;              // 试听托管的起点(0 = 没有)
let silentSince = 0;             // 这次试听里峰值从哪一刻起一直是 0
let stopClock: (() => void) | null = null;
/** 输出端口是不是自己的引擎。选了外部端口时声音在别的设备里,这里量不到,不持槽。 */
let isNativeOutput: () => boolean = () => false;

const levels = () => {
  const a = Math.max(0, Math.min(1, peak / 1000));
  return { l: a, r: a };
};

/** 时间线那只表用：本机引擎此刻的线性峰值。输出不在本机 / 没轮询 = 0（别把上一轮的旧峰值
 *  当成"现在还在响"）。传输在播时槽归时间线（见 workbench/video/timelineAudio.ts），峰值由
 *  这里供出去，与 WebAudio 探头合在同一只表上。 */
export const nativeLevels = (): { l: number; r: number } =>
  isNativeOutput() && poll ? levels() : { l: 0, r: 0 };

const pollOnce = (): void => {
  if (inflight) return;
  inflight = true;
  fetch('/api/audio?levels=1', { cache: 'no-store' })
    .then(r => r.json())
    .then((j: { peak?: number }) => { peak = Math.max(0, Math.min(1000, Number(j?.peak) || 0)); })
    .catch(() => { peak = 0; })
    .finally(() => { inflight = false; });
};

/** 试听托管还该不该继续。没有结束回调,只能看它现在还响不响。 */
const auditionAlive = (t: number): boolean => {
  if (!auditionAt) return false;
  if (t - auditionAt >= MAX_AUDITION_MS) return false;
  if (peak > 0) { silentSince = 0; return true; }
  if (!silentSince) silentSince = t;
  return t - auditionAt < AUDITION_FLOOR_MS || t - silentSince < TAIL_MS;
};

const release = (): void => {
  held = false;
  label = '';
  auditionAt = 0;
  silentSince = 0;
  peak = 0;
  if (poll) { window.clearInterval(poll); poll = 0; }
  releaseAudioSlot(SLOT_ID);
};

const sync = (): void => {
  const t = performance.now();
  const playing = clock.isPlaying() && isNativeOutput();
  if (!playing && !auditionAlive(t)) { if (held) release(); else peak = 0; if (poll) { window.clearInterval(poll); poll = 0; } return; }
  // 传输在播：槽归时间线 —— 它同时带 WebAudio 探头与本机引擎峰值（见 timelineAudio.ts），
  // 这里只负责把轮询跑起来、把峰值递过去。再抢一次槽只会把时间线顶掉、连带把时钟按停。
  if (playing) {
    if (held) { held = false; label = ''; releaseAudioSlot(SLOT_ID); }
    if (!poll) poll = window.setInterval(pollOnce, POLL_MS);
    return;
  }
  const next = 'MIDI — note preview';
  if (!held || label !== next) {
    held = true;
    label = next;
    acquireAudioSlot({ id: SLOT_ID, label: next, levels }, () => { void clock.pause(); });
  }
  if (!poll) poll = window.setInterval(pollOnce, POLL_MS);
};

/** 引擎刚刚出过声(试听/预听):把表托管住。传输在播时不必 —— 槽已经在手里,峰值也照样读。 */
export const noteNativeSound = (): void => {
  if (clock.isPlaying()) return;
  auditionAt = performance.now();
  silentSince = 0;
  sync();
};

/** 页面上挂一次。`nativeOutput` 说"现在的声音是不是本机引擎出的"。返回卸载:退订 + 还槽
 *  (热更新时别留一只没人管着的表)。 */
export const startNativeMonitor = (nativeOutput: () => boolean): (() => void) => {
  if (stopClock) return () => { /* 已经起过了:一个页面只有一只表 */ };
  isNativeOutput = nativeOutput;
  stopClock = clock.subscribe(sync);
  sync();
  return () => {
    stopClock?.();
    stopClock = null;
    release();
  };
};
