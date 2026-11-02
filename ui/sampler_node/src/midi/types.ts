// ── MIDI 模式的宿主契约 ──────────────────────────────────────────────────────────────────────
//
// 面板不认识"文档"、不认识 .cud、也不自己改状态 —— 它们只拿这一把接口，把用户的动作说出来。
// 宿主（EditPhase）负责：工程按文档分桶、撤销栈、随 .cud 存盘、以及**唯一那个**时钟循环。
//
// 这么切的好处是"关掉一扇窗"永远不会弄丢东西：状态在宿主，面板只是画。
//
// 乐器轨与乐器段住在**视频工程**里（`VidTrack.kind === 'midi'` / `VidClip.notes`），
// 所以这里有两份读数：
//   * `project` —— 整份工程里所有 MIDI 轨的**投影**（音符在全局拍上）。引擎、资产库、
//     agent 工具读它；写回的只有轨级动作（装/卸乐器、改名、通道、力度、静音/独奏）。
//   * `editor`  —— 时间线上**选中那一段**的编辑视图：音符换成段内拍（0 = 段窗口第一拍）。
//     钢琴卷帘只认它，写回也只写那一段（窗口外的音符原样留着，见 applyEditorNotes）。

import type { MidiLoop, MidiNote, MidiProject, MidiTrack } from './model';

/** 钢琴卷帘的编辑视图：一条轨 + 选中那一段的窗口。 */
export type MidiEditor = {
  /** 正在编辑的段（时间线上的 VidClip.id）。 */
  clipId: string;
  trackId: string;
  /** 这一轨，`notes` 已经换成**段内拍**（0 = 窗口第一拍），只含窗口里看得见的那部分。 */
  track: MidiTrack;
  /** 段内拍上落在**范围右边界之外**的音符（段内容里右裁掉的那截）。只画不编辑 ——
   *  压暗画在段尾右边，拖右边界把它们收回范围就重新变成可编辑的音符。 */
  outsideNotes: MidiNote[];
  /** 窗口长度（拍）= 段在时间线上的时长，也是范围游标的右边界。音符不许画到它外面。 */
  length: number;
  /** 窗口第一拍在全局拍轴上的位置（seek / 播放头换算用）。 */
  baseBeat: number;
  /** 窗口前面被裁掉的拍数（段内容的 offset）；写回时用它折算回内容拍。 */
  contentOffset: number;
  tempo: number;
  timeSig: [number, number];
  ppq: number;
  /** 循环区间（已换算成段内拍，可能落在 [0, length] 外面）。 */
  loop: MidiLoop;
};

export type MidiCtl = {
  /** 当前文档里所有 MIDI 轨的投影（音符在全局拍上）。 */
  project: MidiProject;
  /** 时间线上选中那一段的编辑视图；没有选中 MIDI 段 = null。 */
  editor: MidiEditor | null;
  /** 选中段的 id（= editor?.clipId，方便只关心"有没有、是哪一段"的调用方）。 */
  clipId: string | null;
  /** 改整份工程（轨级动作与音乐时间基）。`label` 是撤销栈里那一步的名字，也是**合并键** ——
   *  拖动时每帧都会调一次，同一个 label 连着来的会并成一步（一次拖动 = 一步撤销）。 */
  update: (fn: (p: MidiProject) => MidiProject, label?: string) => void;
  /** 改选中那一段的音符（段内拍进、段内拍出）。 */
  updateEditor: (fn: (t: MidiTrack) => MidiTrack, label?: string) => void;
  /** 拖范围游标的右边界：把段尾落在某一拍（段内拍）。左边界恒为 0.0，不参与。 */
  setEditorLength: (beats: number) => void;
  /** 选中音符（给 agent 报 selection 用）；不改选中段。 */
  select: (trackId: string, noteId?: string) => void;
  /** 公共时钟的播放态与动词。位置一律由 clock 给，这里不缓存秒数。 */
  playing: boolean;
  play: () => void;
  pause: () => void;
  /** 循环开关（两种模式同一个动作）：开 = 圈住整条时间线，关 = 清掉入/出点。 */
  toggleLoop: () => void;
  /** 时间线总长（秒）。片尾停止、读数里的 "of …"、走到片尾再按播放的回跳都用它 ——
   *  与 Video 监视器同一个口径（不是 MIDI 内容自己的长度）。 */
  endSec: number;
  /** 停止 = 先停再落位（顺序由 clock.stopAt 保证）。 */
  stopAt: (sec: number) => void;
  /** 跳到某一拍（全局拍，会换算成秒交给时钟）。 */
  seekBeat: (beat: number) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** 编辑视图里那条轨（= editor.track），省得每个面板各找一遍。 */
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
