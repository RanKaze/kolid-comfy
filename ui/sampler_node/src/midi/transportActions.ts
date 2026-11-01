// ── 传输：页面上唯一能改时钟的入口 ──────────────────────────────────────────────────────────
//
// 所有**用户动作**（按钮、快捷键、拖动播放头、停止）都走这里。归属权不在这里认领 ——
// 见 transportOwner：宿主/后端在挂载时也会程序化 seek 或按停，认领必须挂在真正的用户输入上，
// 不然每扇窗一加载就把归属抢走。
//
// 自动动作（循环回绕、片尾停止、被抢音频槽）不许走这里 —— 它们由归属者的调度直接调
// clock，并且先问 `transportOwner.isOwner()`。

import { clock } from './clock';

export const transport = {
  play(): void { void clock.play(); },
  pause(): void { void clock.pause(); },
  /** 一个键在播/停之间切。`toggle` 本身不幂等，所以只在用户动作里用。 */
  toggle(): void { void (clock.isPlaying() ? clock.pause() : clock.play()); },
  /** 拖动播放头：本地先落位、网络那一趟去抖 80ms。 */
  seek(sec: number): void { void clock.seek(sec); },
  /** 停止：先停再落位（顺序在 clock.stopAt 里保证）。 */
  stopAt(sec: number): void { void clock.stopAt(sec); },
};
