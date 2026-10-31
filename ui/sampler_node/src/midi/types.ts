// ── MIDI 模式的宿主契约 ──────────────────────────────────────────────────────────────────────
//
// 面板不认识"文档"、不认识 .cud、也不自己改状态 —— 它们只拿这一把接口，把用户的动作说出来。
// 宿主（EditPhase）负责：工程按文档分桶、撤销栈、随 .cud 存盘、以及**唯一那个**时钟循环。
//
// 这么切的好处是"关掉一扇窗"永远不会弄丢东西：状态在宿主，面板只是画。

import type { MidiNote, MidiProject, MidiTrack } from './model';

export type MidiCtl = {
  /** 当前文档的那一份工程（已归一化）。 */
  project: MidiProject;
  /** 改工程。`label` 是撤销栈里那一步的名字，也是**合并键** —— 拖动时每帧都会调一次，
   *  同一个 label 连着来的会并成一步（一次拖动 = 一步撤销）。 */
  update: (fn: (p: MidiProject) => MidiProject, label?: string) => void;
  /** 选中（轨道 / 音符）。写进工程里，跟着文档走。 */
  select: (trackId: string, noteId?: string) => void;
  /** 公共时钟的播放态与三个动词。位置一律由 clock 给，这里不缓存秒数。 */
  playing: boolean;
  play: () => void;
  pause: () => void;
  /** 跳到某一拍（会换算成秒交给时钟）。 */
  seekBeat: (beat: number) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** 当前轨（= project.selTrack 指的那一轨），省得每个面板各找一遍。 */
  track: MidiTrack | null;
  /** 当前选中的音符（可能没有）。 */
  note: MidiNote | null;
};

/** 面板里反复要用的一小撮：拍 ↔ 像素、网格步长。 */
export type RollView = {
  /** 一拍多少像素。 */
  pps: number;
  /** 每一行的音高数（= 半音行高，像素）。 */
  rowH: number;
  /** 吸附网格，单位拍（1/4 = 十六分）。 */
  grid: number;
};
