// ── 整页的时间线声音 ──────────────────────────────────────────────────────────────────────
//
// **只有一条混音路径：本机引擎（KolidAudio.dll）。** 音频轨（PCM 段）与 MIDI 轨（采样器 /
// VST3 插件）在同一个音频线程里、按同一只钟（KolidClock）混进同一路输出：
//   · 段子的 PCM 由 pcmClips 解码后按**绝对帧**交给引擎（见 pcmClips.ts）；
//   · MIDI 音符表也交给引擎，插件在 worker 进程里渲，声音从 ring 回来混进同一块。
// 页面**不再自己播任何时间线声音** —— 以前音频轨走 WebAudio、MIDI 走引擎，两条腿各有各的
// 暂停语义，"暂停了音频还在响"就是这么来的。
//
// 这里只剩三件事：
//  1. 工程/静音/独奏变了 → 把段子的 PCM 与摆放交给引擎（syncEngineClips）。
//  2. 跟着共享时钟：只有归属窗在片尾把传输按停（循环回绕归后端时钟）。
//  3. 播放期间持独占音频槽，把**引擎自己的峰值**交给 Monitor —— 一条时间线一只表。
//
// 暂停时这里什么都不用做：时钟说停，引擎的音频线程下一块就按静音出（见 ka_render_block
// 的暂停分支），PCM / 音符 / 插件同一刻停。

import { useEffect, useRef } from 'react';
import { clock } from '../../midi/clock';
import { nativeEngine } from '../../midi/engine';
import { transportOwner } from '../../midi/transportOwner';
import { nativeLevels } from '../../midi/nativeMonitor';
import { refreshPlacements, syncEngineClips } from './pcmClips';
import { acquireAudioSlot, releaseAudioSlot } from './audioFocus';
import { loopRangeOf, vidDuration, type VidProject } from './model';

const SLOT_ID = 'timeline';

export const useTimelineAudio = (
  project: VidProject,
  solo: ReadonlySet<string>,
  mute: ReadonlySet<string>,
): void => {
  const ref = useRef({ project, solo, mute });
  ref.current = { project, solo, mute };

  // 段子的 PCM 交给原生引擎（解码/上传在 pcmClips 里去抖、去重）。
  useEffect(() => { syncEngineClips(project, solo, mute); }, [project, solo, mute]);

  // 引擎是唯一出声的地方：在就开着（幂等；open 内部先探活，别拿 available 的初值判断 ——
  // 它要等一次 /api/audio 才翻成 true）。开不出来就没有时间线声音 —— 不再退回 WebAudio，
  // 两条路各播一份的后果是暂停语义对不上（那正是要拆掉的东西）。
  useEffect(() => {
    void nativeEngine.open().then(ok => {
      if (!ok) console.warn('[audio] the native engine did not open — timeline audio will be silent');
    });
  }, []);

  useEffect(() => {
    let held = false;
    let stopping = false;
    let claimed = clock.localPlayCount();

    const step = (): void => {
      const { project: p } = ref.current;
      // 只有归属者做自动动作（片尾停）。别的窗只是同一只钟的镜子 —— 让它们也跑一份，
      // 重则按**自己**那份工程的片尾把共用时钟按停。
      if (!transportOwner.isOwner()) {
        stopLocal();
        return;
      }
      const t = clock.seconds();
      const playing = clock.isPlaying();

      if (!playing) {
        stopping = false;
        if (held) { held = false; releaseAudioSlot(SLOT_ID); }
        return;
      }

      // 本窗按了播放（author 已由 /api/clock 定成这扇窗）→ 重落摆放。只认"本窗自己按的那一下"，
      // 别的窗看到"在播"只是镜像 —— 让它们也去抢，就是声音劈叉/掉层/忽然叠一下。
      const seq = clock.localPlayCount();
      if (seq !== claimed) {
        claimed = seq;
        refreshPlacements();
      }
      if (!held) {
        held = true;
        // 声音全在引擎里：Monitor 读引擎峰值（PCM 段与 MIDI 轨已经混在一起），没有 WebAudio 探头。
        acquireAudioSlot(
          { id: SLOT_ID, label: 'Timeline', levels: nativeLevels },
          () => { if (transportOwner.isOwner()) void clock.pause(); },
        );
      }
      // 循环区间就是时间线的入/出点（与卷帘的 A/B 同一对数）。**回绕归后端时钟**
      // （区间随 setLoop 下发，时钟自己翻位置并记回绕数）—— 页面只在"没设区间"
      // 时负责停在片尾。
      const total = vidDuration(p);
      if (total > 0 && t >= total && !loopRangeOf(p).on) {
        if (!stopping) {
          stopping = true;
          void clock.stopAt(total);
        }
      }
    };

    const stopLocal = (): void => {
      stopping = false;
      if (held) { held = false; releaseAudioSlot(SLOT_ID); }
    };

    const off = clock.subscribe(step);
    step();
    return () => {
      off();
      if (held) releaseAudioSlot(SLOT_ID);
    };
  }, []);
};
