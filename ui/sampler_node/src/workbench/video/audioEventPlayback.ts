import { useEffect, useRef } from 'react';
import { clock } from '../../midi/clock';
import { transportOwner } from '../../midi/transportOwner';
import { audioEventGain } from './audioRouting';
import { clearOneShots, playOneShot } from './pcmClips';
import type { AudioEventPoint } from './audioDefs';
import { type VidProject } from './model';

// ── 关键帧音频事件点的触发 ────────────────────────────────────────────────────────────────
// 规则（与用户确认）：
//  · 只有归属窗（正在出声的那扇）触发，别的窗只是同一只钟的镜子；
//  · 播放头**向前越过**点才响一次；刚开播不补发、暂停/回退/手动 seek 不补发；
//  · 循环回绕（时钟位置倒退）→ 清掉上一圈的尾巴并重新武装，下一圈再过点会再响；
//  · 停止/暂停/seek 时清掉所有一次性音效，避免尾巴叠到下一次播放。
//
// 声音走 pcmClips 的一次性通道（与时间线共用作者会话与 PCM 槽），增益由 audioRouting 算：
// 事件/参数的 bus 串联相乘 + float 曲线 / boolean 开关。事件声音没有轨道，不过轨道推子。

const fire = (pt: AudioEventPoint, at: number, project: VidProject, now: number): void => {
  const { gain, event } = audioEventGain(
    pt, project.audioBuses ?? [], project.audioInterfaces ?? [],
  );
  if (!event || !(gain > 0.0001)) return;
  const obj = (project.audioObjects ?? []).find(o => o.id === pt.objectId);
  const audios = obj?.slots[pt.eventId] ?? [];
  for (const a of audios) {
    const g = Math.min(2, gain * (a.gain ?? 1));
    if (!(g > 0.0001) || !a.url) continue;
    // 检测总会晚几毫秒：晚超过 30ms 就按"现在"落位并前跳 offset，别把开头补放一遍。
    const late = now - at;
    const start = late > 0.03 ? now : at;
    const offset = late > 0.03 ? late : 0;
    void playOneShot(a.url, start, offset, g, pt.id + ':' + a.id);
  }
};

export const useAudioEventPlayback = (project: VidProject): void => {
  const ref = useRef(project);
  ref.current = project;

  useEffect(() => {
    let prevT = clock.seconds();
    let wasPlaying = false;

    const step = (): void => {
      const t = clock.seconds();
      const playing = clock.isPlaying();
      if (!playing || !transportOwner.isOwner()) {
        if (wasPlaying) { clearOneShots(); wasPlaying = false; }
        prevT = t;
        return;
      }
      if (!wasPlaying) { wasPlaying = true; prevT = t - 1e-4; return; }

      const p = ref.current;
      const fps = p.fps > 0 ? p.fps : 24;
      const jump = t - prevT;
      // 回退 / 回绕 / 手动 seek：清尾巴、重新武装，但绝不补发区间里的点。
      // prevT 往前挪 0.1ms：落在落点**正上**的那颗点仍然会在下一次 tick 触发（t=0 / 循环起点）。
      if (t < prevT - 1e-4 || jump > Math.max(0.3, 3 / fps)) {
        clearOneShots();
        prevT = t - 1e-4;
        return;
      }
      // 事件点挂在段上：绝对时刻 = 段起点 + 段内秒；段没了 / 点被裁到段外就不响。
      const points = p.audioEventPoints ?? [];
      if (points.length && jump > 0) {
        const byClip = new Map(p.clips.map(c => [c.id, c] as const));
        for (const pt of points) {
          const c = byClip.get(pt.clipId);
          if (!c || pt.t > c.duration + 1e-6) continue;
          const at = c.start + pt.t;
          if (at > prevT && at <= t + 1e-6) fire(pt, at, p, t);
        }
      }
      prevT = t;
    };

    const off = clock.subscribe(step);
    step();
    return () => { off(); clearOneShots(); };
  }, []);
};
