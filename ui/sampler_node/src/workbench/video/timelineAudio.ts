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
import { nativeLevels } from '../../midi/nativeMonitor';
import { acquireAudioSlot, buildStereoProbe, releaseAudioSlot, type AudioProbe } from './audioFocus';
import { scheduleAudioClips, vidAudio } from './audio';
import { vidDuration, type VidProject } from './model';

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

  useEffect(() => {
    let last = clock.seconds();
    let wasPlaying = clock.isPlaying();
    let held = false;
    let stopping = false;

    const step = (): void => {
      const { project: p, solo: s, mute: m } = ref.current;
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
          () => { void clock.pause(); },
        );
      }
      // 走带范围：出点圈了就绕回入点；没圈就停在片尾（停在**内容最远的那一秒**，与本工程
      // 的时长口径一致，见 vidDuration）。
      const total = vidDuration(p);
      const outP = p.outPoint > p.inPoint ? p.outPoint : total;
      if (total > 0 && t >= outP) {
        if (p.outPoint > p.inPoint) {
          void clock.seek(p.inPoint);
        } else if (!stopping) {
          stopping = true;
          vidAudio.stopAll();
          held = false;
          releaseAudioSlot(SLOT_ID);
          void clock.stopAt(total);
        }
        return;
      }

      scheduleAudioClips({
        clips: p.clips, t, playing, solo: s, mute: m, jumped,
        isPlaying: () => clock.isPlaying(),
        now: () => clock.seconds(),
      });
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
