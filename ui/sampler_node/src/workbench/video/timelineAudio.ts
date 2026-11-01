// ── 整页的时间线声音 ──────────────────────────────────────────────────────────────────────
//
// 视频、音频、MIDI 现在是**同一条时间线**（同一个工程、同一台传输）：所以声音也只能有一处
// 调度。以前它长在 Player 的 rAF 里 —— 切到 MIDI 模式，Player 一卸载，音频轨就哑了。
// 现在它挂在这里：宿主（EditPhase）常驻挂一次，读公共时钟 midi/clock 的广播。
//
// 三件事：
//  1. 音频段：交给 `scheduleAudioClips`（一份实现，Player 不再自己调度 —— 见 audio.ts）。
//  2. 走带范围：出点圈了就回到入点，没圈就到片尾停。这段以前也在 Player 里，一个道理。
//  3. 独占音频槽：时间线播放期间持槽，并把**两路声源**交给同一只表 —— WebAudio（音频段的
//     汇流总线探头）与本机引擎（MIDI 轨，峰值从 nativeMonitor 取）。一条时间线只有一只表。

import { useEffect, useRef } from 'react';
import { clock } from '../../midi/clock';
import { nativeEngine } from '../../midi/engine';
import { transportOwner } from '../../midi/transportOwner';
import { nativeLevels } from '../../midi/nativeMonitor';
import { engineTimelineActive, syncEngineClips } from './pcmClips';
import { acquireAudioSlot, buildStereoProbe, releaseAudioSlot, type AudioProbe } from './audioFocus';
import { scheduleAudioClips, vidAudio } from './audio';
import { loopRangeOf, vidDuration, type VidProject } from './model';

const SLOT_ID = 'timeline';

/** 音频段的汇流总线只有一条，探头也就只搭一次 —— 每帧重搭会把 analyser 叠成一条链。
 *  接上探头之前先撤掉总线的直连 destination：两条腿同时到喇叭 = 同一路声 +6dB。 */
let probe: AudioProbe | null = null;
const timelineProbe = (): AudioProbe => {
  if (!probe) {
    vidAudio.detachOutput();
    probe = buildStereoProbe(vidAudio.node());
  }
  return probe;
};

export const useTimelineAudio = (
  project: VidProject,
  solo: ReadonlySet<string>,
  mute: ReadonlySet<string>,
): void => {
  const ref = useRef({ project, solo, mute });
  ref.current = { project, solo, mute };

  // 段子的 PCM 交给原生引擎（解码/上传在 pcmClips 里去抖、去重）。
  useEffect(() => { syncEngineClips(project, solo, mute); }, [project, solo, mute]);

  // 引擎能不能用：在就开着（幂等）；开不出来就退回 WebAudio。
  const engineState = useRef<'unknown' | 'ok' | 'fail'>('unknown');
  useEffect(() => {
    let alive = true;
    if (!nativeEngine.available) { engineState.current = 'fail'; return; }
    void nativeEngine.open().then(ok => { if (alive) engineState.current = ok ? 'ok' : 'fail'; });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let last = clock.seconds();
    let wasPlaying = clock.isPlaying();
    let held = false;
    let stopping = false;

    const step = (): void => {
      const { project: p, solo: s, mute: m } = ref.current;
      // 只有归属者出声、回绕、停止。别的窗只是同一只钟的镜子 —— 让它们也跑一份，
      // 轻则同一段音频叠几层，重则按**自己**那份工程的片尾把共用时钟按停。
      if (!transportOwner.isOwner()) {
        stopLocal();
        return;
      }
      const t = clock.seconds();
      const playing = clock.isPlaying();
      // 先后退再看：回绕 / 用户 seek / 刚从暂停按下播放 —— 在播的声源都要按新位置重新对表。
      const jumped = playing && (!wasPlaying || Math.abs(t - last) > 0.35);
      last = t;
      wasPlaying = playing;

      if (!playing) {
        stopping = false;
        if (held) { held = false; releaseAudioSlot(SLOT_ID); }
        vidAudio.stopAll();
        return;
      }

      if (!held) {
        held = true;
        acquireAudioSlot(
          { id: SLOT_ID, label: 'Timeline', probe: timelineProbe(), levels: nativeLevels },
          () => { if (transportOwner.isOwner()) void clock.pause(); },
        );
      }
      // 循环区间就是时间线的入/出点（与卷帘的 A/B 同一对数）。**回绕归后端时钟**
      // （P2：区间随 setLoop 下发，时钟自己翻位置并记回绕数）—— 页面只在"没设区间"
      // 时负责停在片尾。页面不再每帧判出点再 seek：后台页被节流时那一跳会迟到整帧。
      const total = vidDuration(p);
      if (total > 0 && t >= total && !loopRangeOf(p).on) {
        if (!stopping) {
          stopping = true;
          stopLocal();
          void clock.stopAt(total);
        }
        return;
      }

      // 引擎已经在替时间线出声（PCM 片段摆放好了）→ 页面不再自己播音频；
      // PCM 还没就绪/引擎开不出来 → 仍旧走 WebAudio，切过去时把旧声源收干净。
      if (engineState.current === 'unknown' && nativeEngine.available) {
        engineState.current = 'fail';
        void nativeEngine.open().then(ok => { engineState.current = ok ? 'ok' : 'fail'; });
      }
      if (engineState.current === 'ok' && engineTimelineActive()) {
        vidAudio.stopAll();
        return;
      }
      scheduleAudioClips({
        clips: p.clips, t, playing, solo: s, mute: m, jumped,
        isPlaying: () => clock.isPlaying(),
        now: () => clock.seconds(),
      });
    };

    const stopLocal = (): void => {
      stopping = false;
      if (held) { held = false; releaseAudioSlot(SLOT_ID); }
      vidAudio.stopAll();
    };

    const off = clock.subscribe(step);
    step();
    return () => {
      off();
      vidAudio.stopAll();
      if (held) releaseAudioSlot(SLOT_ID);
    };
  }, []);
};
