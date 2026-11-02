// ── 钢琴卷帘窗（含底部力度泳道）─────────────────────────────────────────────────────────────
//
// 这一格是 MIDI 模式的主场：上面按音高排音符，下面按力度排同一批音符 —— 两栏共用一条时间轴，
// 所以"哪个音在哪儿、它有多重"永远是同一眼能看全的一件事。
//
// 几个必须守住的规则（每一条都是踩过的坑）：
//   * **时间单位是拍**，不是秒。改 BPM 时音符不许动 —— 秒只在播放时才出现，且由 clock 给。
//   * **只画可视区**。整卷帘按 128 个半音 × 200 拍铺成一张画布是几十 MB 位图，拖动会卡死；
//     这里画布永远是"窗口那么大"，滚动只是换一个偏移量重画。
//   * **力度是每个音自己的**，轨上那根推子是另一个乘数（见 Tracks 轨头的乐器弹窗）。两者在画面上互不干扰：
//     这里改的永远是 note.vel。
//   * 拖动的每一帧都走 update（同一个 label），撤销栈会把它们并成**一步**。
//
// 键盘区在左边始终固定（不随横向滚动走），因为"哪一行是哪个音"必须一直看得见。
//
// 网格与缩放**没有自己的工具条**：控件都在底部 Transport，这里只消费 gridBeats / pps。
// 缩放要钉住视口中心，所以滚动容器 ref 由 Workspace 持有、与 Transport 共用（见 zoomTo）。
//
// 标尺上的播放头与范围游标**照 Tracks 那一套画**（workbench/video/Timeline.tsx）：上带是
// 范围游标的右端楔形把手，下带是播放头三角，中间才是小节号 —— 两种手势分住在尺子的上下两端，
// 抓范围和点游标永远不会互相抢。
//
// 范围游标代表的是**这一段自己**：左边界钉死在 0.0（卷帘原点，不给把手），右边界 = 段尾，
// 拖它就是把段裁长/裁短。段内容里落在右边界之外的音符不删、也不从画面消失 —— 它们压暗画在
// 段尾右边（"未启用"的样子），把右边界拖回去就重新回到范围内。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { clock } from './clock';
import { useClockFrame } from './hooks';
import { DEFAULT_LAYOUT, readLayout, writeLayout } from './layoutPrefs';
import { midiOut } from './output';
import { Splitter } from './Splitter';
import {
  MIN_DUR, type MidiNote, addNoteToTrack, effectiveVelocity, isBlackKey, newMidiId, pitchName,
  removeNotesFromTrack, secondsToBeat, splitNoteInTrack, updateNoteInTrack,
} from './model';
import { BRUSH_CURSOR, ERASER_CURSOR, setMidiTool, useMidiTool } from './tool';
import { CUT_CURSOR, disarmCut, useCut } from '../workbench/cutStore';
import type { MidiCtl } from './types';

/** 琴键栏宽度。缩放要把可见区的中心钉住 —— 那是 clientWidth 减掉这 46px。 */
export const KEY_W = 46;
const ROW_H = 13;
const PITCH_TOP = 108;      // 画到 C8
const PITCH_BOTTOM = 24;    // 画到 C1
const ROWS = PITCH_TOP - PITCH_BOTTOM + 1;
const VEL_MIN = 46;
const VEL_MAX = 340;
/** 卷帘主体至少留这么高 —— 拖到只剩力度泳道就没意义了。 */
const ROLL_MIN_H = 120;
/** 标尺：上带范围楔形（MARK_H）、下带播放头三角（PLAY_H），中间那条窄带才是小节号。
 *  三段的高度与 Tracks 的标尺同一套读数（见 Timeline.tsx 的 RULER_H / MARK_TOP / PLAY_TOP）。 */
const RULER_H = 28;
const MARK_H = 10;
const PLAY_H = 10;
const LABEL_Y = MARK_H + (RULER_H - MARK_H - PLAY_H) / 2;   // 14
/** 范围线与楔形的颜色 —— 与 Tracks 一字不差。 */
const RANGE_LINE = 'rgba(120,200,255,0.75)';
/** 范围外音符的"未启用"色：同一块深底上的灰蓝，亮度压到范围內音符之下。 */
const GHOST_NOTE = 'rgba(150,163,186,0.28)';
const GHOST_VEL = 'rgba(150,163,186,0.34)';
/** 横向缩放（每拍多少像素）的取值范围与默认值。双击 zoom 滑杆回到这里。 */
export const ZOOM_MIN = 18;
export const ZOOM_MAX = 220;
export const DEFAULT_PPS = 64;

/** 网格档位。画在底部 Transport，卷帘只用选中的那一档做吸附与画线。 */
export const GRID_CHOICES: { label: string; beats: number }[] = [
  { label: '1/4', beats: 1 },
  { label: '1/8', beats: 0.5 },
  { label: '1/16', beats: 0.25 },
  { label: '1/32', beats: 0.125 },
  { label: '1/8T', beats: 1 / 3 },
];

const COL = {
  bg: '#141518',
  rowBlack: 'rgba(255,255,255,0.028)',
  rowWhite: 'transparent',
  rowC: 'rgba(255,255,255,0.05)',
  lineGrid: 'rgba(255,255,255,0.045)',
  lineBeat: 'rgba(255,255,255,0.10)',
  lineBar: 'rgba(255,255,255,0.20)',
  note: '#3a8ee6',
  noteSel: '#ffffff',
  playhead: '#ff453a',
};

type DragMode = 'move' | 'resize' | 'vel' | 'draw' | 'erase' | 'marquee' | 'segEnd' | 'seek' | ''

export const MidiPianoRoll: React.FC<{
  ctl: MidiCtl;
  /** 吸附刻度（拍）。控件在底部 Transport。 */
  gridBeats: number;
  /** 每拍多少像素。控件在底部 Transport；缩放的中心保持由 Workspace 的 zoomTo 负责。 */
  pps: number;
  /** 滚动容器（Workspace 与 Transport 共用，缩放中心要靠它换算）。 */
  scrollRef: React.MutableRefObject<HTMLDivElement | null>;
}> = ({ ctl, gridBeats, pps, scrollRef }) => {
  // 这一窗只编**选中的那一段**：音符是段内拍（0 = 窗口第一拍），窗口长度就是段的时长。
  // 写回走 updateEditor —— 段内容里被裁到窗口外的音符不会被碰（见 applyEditorNotes）。
  const { track, updateEditor } = ctl;
  // Cut（C）剪音符、Brush（B）/ Eraser（E）/ Cursor（A）换笔：互斥 —— 拿到笔就把剪刀收起来
  // （见 Workspace 的键处理）。Cursor = 手上不拿工具：不落音、不擦音，只保留选中与拖动。
  const cutArmed = useCut().armed['cut.midi'];
  const tool = useMidiTool();
  const length = ctl.editor?.length ?? 16;
  // 范围右边界之外、但还留在段内容里的音符：压暗画、不参与命中/框选（"未启用"）。
  const outsideNotes = ctl.editor?.outsideNotes ?? [];
  const timeSig = ctl.editor?.timeSig ?? ([4, 4] as [number, number]);
  const tempo = ctl.editor?.tempo ?? ctl.project.tempo;
  const baseBeat = ctl.editor?.baseBeat ?? 0;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rollRef = useRef<HTMLCanvasElement | null>(null);
  const velRef = useRef<HTMLCanvasElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);

  const [sel, setSel] = useState<string[]>([]);
  // 框选的橡皮筋（画布局部像素）。null = 没在框。
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // 按下的琴键（-1 = 没按）。只用来给键盘画一下高亮 —— 点琴键只试听，不落音。
  const [pressedKey, setPressedKey] = useState(-1);
  // 力度泳道多高 —— 可拖（视图态，存 localStorage，见 layoutPrefs）。
  const [velH, setVelH] = useState(() => readLayout().velH);
  const velHRef = useRef(velH);
  velHRef.current = velH;
  const baseVelH = useRef(velH);
  const startVelSplit = useCallback(() => { baseVelH.current = velHRef.current; }, []);

  const dragVelSplit = useCallback((y: number, y0: number) => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // 增量式（往上拖变高）+ 留出卷帘主体的最小高度。中间还有一条 7px 的分隔条，一并扣掉。
    const cap = Math.max(VEL_MIN, Math.min(VEL_MAX, r.height - ROLL_MIN_H - 7));
    setVelH(Math.round(Math.max(VEL_MIN, Math.min(cap, baseVelH.current + (y0 - y)))));
  }, []);
  const commitVel = useCallback(() => setVelH(h => { writeLayout({ velH: h }); return h; }), []);
  const resetVel = useCallback(() => {
    const el = rootRef.current;
    const cap = el ? Math.max(VEL_MIN, Math.min(VEL_MAX, el.getBoundingClientRect().height - ROLL_MIN_H - 7)) : VEL_MAX;
    setVelH(Math.round(Math.min(DEFAULT_LAYOUT.velH, cap)));
    writeLayout({ velH: DEFAULT_LAYOUT.velH });
  }, []);

  // 拖动状态放 ref：pointermove 每帧都来，走 setState 会把 React 拖垮。
  //
  // **base 是按下那一刻的位置快照，是整个拖动手势唯一的坐标原点**。早先这里拿
  // `track.notes` 里的当前 start 再加 `(target - origStart)`，而 track 每帧都被上一次
  // 位移改过 ⇒ 偏移被反复叠加，鼠标走 2 拍、音符走 3 拍，拖得越久漂得越远（用户报的
  // "拖拽没有正确跟鼠标"）。现在一律"快照 + 本帧总位移"，绝不再读当前值。
  const drag = useRef<{
    mode: DragMode; noteId: string; grabBeat: number; grabPitch: number;
    origStart: number; origDur: number; origVel: number; origPitch: number;
    base: { id: string; start: number; dur: number; pitch: number }[];
    moved: boolean;
    /** 框选专用（只有 mode === 'marquee' 时有值）：起点按画布局部像素记，selBase 是
     *  按下那一刻的选择 —— 它不跟着每帧改写，否则框往回缩时先选中的退不回去。 */
    marquee?: { x0: number; y0: number; selBase: string[]; selCur: string[] };
  }>({
    mode: '', noteId: '', grabBeat: 0, grabPitch: 0,
    origStart: 0, origDur: 0, origVel: 0, origPitch: 0, base: [], moved: false,
  });
  /** 记录这一枚音按下时的样子（move / resize / draw 都要）。 */
  const snapOf = (n: MidiNote) => ({ id: n.id, start: n.start, dur: n.dur, pitch: n.pitch });

  const trackNotes = track?.notes ?? [];
  // 画布也要装得下范围外的音符 —— 它们画在段尾右边，够不着就永远看不见。
  const endBeat = Math.max(length, 16, ...trackNotes.map(n => n.start + n.dur), ...outsideNotes.map(n => n.start + n.dur));
  const contentW = KEY_W + endBeat * pps + 240;
  const contentH = RULER_H + ROWS * ROW_H;

  // 坐标换算必须用**原生滚动位置**（scrollRef.current.scrollLeft/Top），不能用渲染时的
  // 快照：滚动事件与 pointerdown 之间可能已经差了一帧，而卷帘的画布是 sticky 的
  // （永远贴在视口左上角），不把滚动量加回来，滚动之后点的位置就整体偏了。
  const viewOffset = useCallback((): { ox: number; oy: number } => {
    const host = scrollRef.current;
    return host ? { ox: host.scrollLeft, oy: host.scrollTop } : { ox: 0, oy: 0 };
  }, []);

  const beatAtX = useCallback((clientX: number): number => {
    const el = rollRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const { ox } = viewOffset();
    const x = clientX - r.left - KEY_W + ox;
    return Math.max(0, x / pps);
  }, [pps, viewOffset]);

  const pitchAtY = useCallback((clientY: number): number => {
    const el = rollRef.current;
    if (!el) return 60;
    const r = el.getBoundingClientRect();
    const { oy } = viewOffset();
    const y = clientY - r.top - RULER_H + oy;
    const row = Math.floor(y / ROW_H);
    return Math.max(PITCH_BOTTOM, Math.min(PITCH_TOP, PITCH_TOP - row));
  }, [viewOffset]);

  // ── 画卷帘 ────────────────────────────────────────────────────────────────────────────────
  const drawRoll = useCallback(() => {
    const canvas = rollRef.current;
    const host = scrollRef.current;
    if (!canvas || !host) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = host.clientWidth, h = host.clientHeight;
    if (w <= 0 || h <= 0) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    }
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = COL.bg;
    g.fillRect(0, 0, w, h);

    const ox = host.scrollLeft, oy = host.scrollTop;
    const beat0 = Math.max(0, (ox) / pps);
    const beat1 = beat0 + (w - KEY_W) / pps;
    // 范围游标 = **这一段自己**的 [0, length]。左边界钉死在 0.0，右边界就是段尾；
    // 窗口外的部分不画 —— 与 Tracks 一样，范围只在它真正覆盖到的地方出现。
    const xEnd = KEY_W + length * pps - ox;

    // 行底色（黑键行沉一点）+ C 行分隔
    for (let p = PITCH_BOTTOM; p <= PITCH_TOP; p++) {
      const y = RULER_H + (PITCH_TOP - p) * ROW_H - oy;
      if (y + ROW_H < RULER_H || y > h) continue;
      if (isBlackKey(p)) { g.fillStyle = COL.rowBlack; g.fillRect(KEY_W, y, w - KEY_W, ROW_H); }
      if (p % 12 === 0) { g.fillStyle = COL.rowC; g.fillRect(KEY_W, y + ROW_H - 1, w - KEY_W, 1); }
    }

    // 段尾 = 范围游标的右边界（可拖）。落到范围外的音符不会消失，只是压暗画在它右边。
    // 线与标尺里那条**同一个像素锚点**（xEnd - 0.5，与 Tracks 的 left: x - 0.5 / width: 1 同款）：
    // 这里曾经是 Math.round(xEnd)，于是尺子上的楔形与卷帘里的线差 1px。
    if (xEnd > KEY_W && xEnd < w) {
      g.fillStyle = RANGE_LINE;
      g.fillRect(xEnd - 0.5, RULER_H, 1, h - RULER_H);
    }

    // 竖线：网格 / 拍 / 小节
    const bar = timeSig[0];
    const first = Math.floor(beat0 / gridBeats) * gridBeats;
    for (let b = first; b <= beat1; b += gridBeats) {
      const x = KEY_W + b * pps - ox;
      if (x < KEY_W) continue;
      const isBar = Math.abs(b % bar) < 1e-6;
      const isBeat = Math.abs(b % 1) < 1e-6;
      g.fillStyle = isBar ? COL.lineBar : isBeat ? COL.lineBeat : COL.lineGrid;
      g.fillRect(Math.round(x), isBar ? RULER_H : RULER_H, isBar ? 1.5 : 1, h - RULER_H);
    }

    // 音符
    if (track) {
      for (const n of track.notes) {
        if (n.start + n.dur < beat0 - 1 || n.start > beat1 + 1) continue;
        const x = KEY_W + n.start * pps - ox;
        const y = RULER_H + (PITCH_TOP - n.pitch) * ROW_H - oy + 1;
        const wNote = Math.max(3, n.dur * pps - 1);
        const hNote = ROW_H - 2;
        const k = n.vel / 127;
        g.fillStyle = `rgba(${58 + 120 * k | 0},${142 + 60 * k | 0},${230},${0.42 + 0.5 * k})`;
        g.fillRect(x, y, wNote, hNote);
        if (sel.includes(n.id)) {
          g.strokeStyle = COL.noteSel;
          g.lineWidth = 1.2;
          g.strokeRect(x + 0.5, y + 0.5, wNote - 1, hNote - 1);
        }
      }
    }

    // 范围外（段尾右边）的音符：段内容里还留着，只是不启用 —— 压暗画，不让它凭空消失。
    // 它们不参与命中/框选（见 hitNote / notesInBox）：把右边界拖回来，它们才重新可编辑。
    if (track && outsideNotes.length) {
      for (const n of outsideNotes) {
        if (n.start + n.dur < beat0 - 1 || n.start > beat1 + 1) continue;
        const x = KEY_W + n.start * pps - ox;
        const y = RULER_H + (PITCH_TOP - n.pitch) * ROW_H - oy + 1;
        g.fillStyle = GHOST_NOTE;
        g.fillRect(x, y, Math.max(3, n.dur * pps - 1), ROW_H - 2);
      }
    }

    // 框选的橡皮筋。画在键盘与标尺**之前**：那两块随后会盖住它伸出去的部分，
    // 不用单独裁剪，框只在卷帘主体里可见。
    if (box) {
      const bx = Math.min(box.x0, box.x1), by = Math.min(box.y0, box.y1);
      const bw = Math.abs(box.x1 - box.x0), bh = Math.abs(box.y1 - box.y0);
      g.fillStyle = 'rgba(10,132,255,0.14)';
      g.fillRect(bx, by, bw, bh);
      g.strokeStyle = 'rgba(10,132,255,0.9)';
      g.lineWidth = 1;
      g.strokeRect(Math.round(bx) + 0.5, Math.round(by) + 0.5, Math.round(bw), Math.round(bh));
    }

    // 键盘（固定在最左，不随横向滚动）
    g.fillStyle = '#0d0e10';
    g.fillRect(0, RULER_H, KEY_W, h - RULER_H);
    for (let p = PITCH_BOTTOM; p <= PITCH_TOP; p++) {
      const y = RULER_H + (PITCH_TOP - p) * ROW_H - oy;
      if (y + ROW_H < RULER_H || y > h) continue;
      const on = p === pressedKey;
      g.fillStyle = on
        ? (isBlackKey(p) ? '#3a8ee6' : '#8fc4f7')
        : (isBlackKey(p) ? '#1b1c20' : '#d8d9dd');
      g.fillRect(0, y, KEY_W - 1, ROW_H - 1);
      if (p % 12 === 0) {
        g.fillStyle = isBlackKey(p) ? '#8b8d94' : '#4a4c52';
        g.font = '9px ui-monospace, monospace';
        g.textBaseline = 'middle';
        g.fillText(pitchName(p), 3, y + ROW_H / 2);
      }
    }

    // 标尺（顶部）。三条带：0..MARK_H 范围楔形、中间窄带小节号、底部 PLAY_H 播放头三角。
    g.fillStyle = 'rgba(20,21,24,0.96)';
    g.fillRect(0, 0, w, RULER_H);
    g.font = '9.5px ui-monospace, monospace';
    g.textBaseline = 'middle';
    const firstBar = Math.floor(beat0 / bar) * bar;
    for (let b = firstBar; b <= beat1; b += bar) {
      const x = KEY_W + b * pps - ox;
      if (x < KEY_W - 40) continue;
      g.fillStyle = COL.lineBar;
      g.fillRect(Math.round(x), RULER_H - 5, 1, 5);
      g.fillStyle = 'rgba(255,255,255,0.42)';
      g.fillText(String(Math.floor(b / bar) + 1), x + 3, LABEL_Y);
    }
    // 范围覆盖（贯穿整条尺子）：从 0.0 铺到段尾。左端钉死（琴键右缘就是 0.0，不画把手），
    // 右端一条边界线 + 一枚平顶楔形 —— 那是**唯一**可拖的那一头。
    const bandR = Math.min(w, xEnd);
    if (bandR > KEY_W) {
      const grad = g.createLinearGradient(0, 0, 0, RULER_H);
      grad.addColorStop(0, 'rgba(10,132,255,0.18)');
      grad.addColorStop(1, 'rgba(10,132,255,0.34)');
      g.fillStyle = grad;
      g.fillRect(KEY_W, 0, bandR - KEY_W, RULER_H);
    }
    g.fillStyle = RANGE_LINE;
    if (xEnd >= KEY_W - 10 && xEnd <= w + 10) {
      g.fillRect(xEnd - 0.5, 0, 1, RULER_H);
      // 出点楔形：竖边压在边界线上、斜边收回线上（与 Tracks 的出点同一画法）。
      g.beginPath(); g.moveTo(xEnd - 10, 0); g.lineTo(xEnd, 0); g.lineTo(xEnd, MARK_H); g.closePath(); g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.fillRect(0, RULER_H - 1, w, 1);
    // 角格最后画：盖住楔形/范围线伸进键盘列的那一截。
    g.fillStyle = '#0d0e10';
    g.fillRect(0, 0, KEY_W, RULER_H);
  }, [pps, gridBeats, length, timeSig, track, outsideNotes, sel, pressedKey, box]);

  // ── 画力度 ────────────────────────────────────────────────────────────────────────────────
  const drawVel = useCallback(() => {
    const canvas = velRef.current;
    if (!canvas) return;
    const host = canvas.parentElement;
    if (!host) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = host.clientWidth, h = host.clientHeight;
    if (w <= 0 || h <= 0) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    }
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#111214';
    g.fillRect(0, 0, w, h);

    // 一半、满格两条参考线
    g.fillStyle = 'rgba(255,255,255,0.07)';
    g.fillRect(KEY_W, h * 0.5, w - KEY_W, 1);
    g.fillRect(KEY_W, 6, w - KEY_W, 1);

    const ox = scrollRef.current ? scrollRef.current.scrollLeft : 0;
    if (track) {
      for (const n of track.notes) {
        const x = KEY_W + n.start * pps - ox;
        if (x < KEY_W - 4 || x > w) continue;
        const frac = 1 - n.vel / 127;
        const top = 6 + frac * (h - 14);
        const on = sel.includes(n.id);
        g.fillStyle = on ? '#ffffff' : `rgba(${58 + 120 * (n.vel / 127) | 0},${142 + 60 * (n.vel / 127) | 0},230,0.9)`;
        g.fillRect(x, top, 2.5, h - 12 - frac * (h - 14) + 8);
        g.beginPath();
        g.arc(x + 1.25, top, 2.6, 0, Math.PI * 2);
        g.fill();
      }
      // 范围外的音符在这里也压暗画一根 —— 上面卷帘没收了它们，力度的读数不该跟着消失。
      for (const n of outsideNotes) {
        const x = KEY_W + n.start * pps - ox;
        if (x < KEY_W - 4 || x > w) continue;
        const frac = 1 - n.vel / 127;
        const top = 6 + frac * (h - 14);
        g.fillStyle = GHOST_VEL;
        g.fillRect(x, top, 2.5, h - 12 - frac * (h - 14) + 8);
        g.beginPath();
        g.arc(x + 1.25, top, 2.6, 0, Math.PI * 2);
        g.fill();
      }
    }
    // 左边标签区
    g.fillStyle = '#0d0e10';
    g.fillRect(0, 0, KEY_W, h);
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.font = '9px ui-monospace, monospace';
    g.textBaseline = 'middle';
    g.fillText('velocity', 4, 12);
    g.fillStyle = 'rgba(255,255,255,0.28)';
    g.fillText('127', 4, 20);
    g.fillText('1', 4, h - 10);
    // 当前轨的力度基线（虚线）—— 它是乘数，画成一条参考线，免得用户以为是绝对值
    if (track) {
      g.strokeStyle = 'rgba(255,255,255,0.16)';
      g.setLineDash([3, 3]);
      const yv = 6 + (1 - Math.min(1, track.velScale)) * (h - 14);
      g.beginPath();
      g.moveTo(KEY_W, yv);
      g.lineTo(w, yv);
      g.stroke();
      g.setLineDash([]);
    }
    // velH 只作重绘键：泳道高度变了（拖分隔条）就得按新高度重算柱子的纵向比例。
  }, [pps, track, outsideNotes, sel, velH]);

  // 滚动 / 数据变了就重画
  useEffect(() => { drawRoll(); }, [drawRoll, contentW]);
  useEffect(() => { drawVel(); }, [drawVel]);

  // 容器尺寸变了也要重画：拖左栏分隔条、缩放窗口、dock 换布局都只改盒子大小，
  // 不动任何 state —— 少了这一条，画布会一直停在旧像素尺寸（右边留白、力度柱子错位），
  // 非得滚一下才恢复。延到下一帧再画，避免"画布尺寸变化 → 观察器再触发"的自激。
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { drawRoll(); drawVel(); });
    });
    if (scrollRef.current) ro.observe(scrollRef.current);
    const velHost = velRef.current?.parentElement;
    if (velHost) ro.observe(velHost);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [drawRoll, drawVel]);

  // 播放头：一个绝对定位的细条，每帧只改 transform（绝不重画整张卷帘）。
  useClockFrame(() => {
    const el = headRef.current;
    if (!el) return;
    if (!track) { el.style.display = 'none'; return; }
    el.style.display = '';
    const beat = secondsToBeat(clock.seconds(), tempo) - baseBeat;
    // 游标不在这一段里就不画 —— 画在段外的位置会被当成本段的播放头。
    if (beat < 0 || beat > length) { el.style.display = 'none'; return; }
    const x = KEY_W + beat * pps;
    el.style.transform = `translateX(${x}px)`;
  });

  const onScroll = () => {
    // 画布是 sticky 的（原生滚动就把它钉在视口左上角，不经过 React），
    // 这里只按原生滚动位置重画可视区。**不走 setState**：滚动事件每帧都来，
    // 绕一圈 React 会慢半拍，内容和指针就会差一帧。
    drawRoll();
    drawVel();
  };

  // ── 命中 ──────────────────────────────────────────────────────────────────────────────────
  const hitNote = (clientX: number, clientY: number): { note: MidiNote; edge: boolean } | null => {
    if (!track) return null;
    const b = beatAtX(clientX), p = pitchAtY(clientY);
    // 倒序：后画的（后加的）优先
    for (let i = track.notes.length - 1; i >= 0; i--) {
      const n = track.notes[i];
      if (n.pitch !== p) continue;
      if (b < n.start || b > n.start + n.dur) continue;
      // 右边缘多宽算"拉长"：固定 5px 对宽音合适，可对一枚只有一格的窄音就是整个音符 ——
      // 那种音会永远只能拉长、拖不动。所以按音宽取三分之一，夹在 3..6px。
      const wPx = Math.max(3, n.dur * pps);
      const edgeW = Math.min(6, Math.max(3, wPx * 0.34));
      const edge = (b - n.start) * pps > wPx - edgeW;
      return { note: n, edge };
    }
    return null;
  };

  /**
   * 框里的音符。命中按**屏幕上画出来的那个方块**算（公式与 drawRoll 一字不差），
   * 所以"框到谁就是谁" —— 不会因为网格吸附或滚动量差半格而漏选、多选。
   * 相交即选中（框住大半枚也算），与常见 DAW 一致：长音的尾巴扫到框里就该被带走。
   */
  const notesInBox = (x0: number, y0: number, x1: number, y1: number): string[] => {
    if (!track) return [];
    const { ox, oy } = viewOffset();
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
    const ay = Math.min(y0, y1), by = Math.max(y0, y1);
    const out: string[] = [];
    for (const n of track.notes) {
      const nx = KEY_W + n.start * pps - ox;
      const ny = RULER_H + (PITCH_TOP - n.pitch) * ROW_H - oy + 1;
      const nw = Math.max(3, n.dur * pps - 1);
      if (nx < bx && nx + nw > ax && ny < by && ny + ROW_H - 2 > ay) out.push(n.id);
    }
    return out;
  };

  /** 框选的一次更新（pointermove 与 pointerup 共用）。以按下时的选择为底做并集：Shift 的
   *  语义是"再选上这些"，不是"只留这些" —— 也免得手一抖框空了就把原有选择清光。 */
  const marqueeAt = (x1: number, y1: number) => {
    const d = drag.current, m = d.marquee;
    if (d.mode !== 'marquee' || !m || !track) return;
    if (Math.abs(x1 - m.x0) > 2 || Math.abs(y1 - m.y0) > 2) d.moved = true;
    if (!d.moved) return;
    setBox({ x0: m.x0, y0: m.y0, x1, y1 });
    const next = m.selBase.slice();
    for (const id of notesInBox(m.x0, m.y0, x1, y1)) if (!next.includes(id)) next.push(id);
    m.selCur = next;
    setSel(next);
  };

  const snap = (beat: number): number => Math.round(beat / gridBeats) * gridBeats;

  /** 标尺上带的范围游标右端把手（热区与 Tracks 同宽：沿边界线左右各留 2px，中间 10px）。
   *  左端钉死在 0.0，没有把手 —— 所以整条带上只有这一个能抓的东西。 */
  const wedgeAt = (clientX: number, localY: number): 'segEnd' | null => {
    if (localY > MARK_H) return null;
    const rect = rollRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const { ox } = viewOffset();
    const x = clientX - rect.left;
    const xEnd = KEY_W + length * pps - ox;
    return x >= xEnd - 10 && x <= xEnd + 2 ? 'segEnd' : null;
  };

  /** 指针 → 播放头（段内拍吸附后加回段原点）。按下与拖动共用这一句。 */
  const seekAt = (clientX: number) => {
    ctl.seekBeat(Math.max(0, snap(beatAtX(clientX))) + baseBeat);
  };

  /** 拖右端 = 改这一段的时长（段内拍，吸附到当前网格）。左边界恒为 0.0；
   *  同一个 label 让一次拖动只算撤销栈里的一步。 */
  const dragSegEnd = (clientX: number) => {
    ctl.setEditorLength(Math.max(0, snap(beatAtX(clientX))));
  };

  const onDown = (e: React.PointerEvent) => {
    if (!track) return;
    if (e.button !== 0) return;
    const rect = rollRef.current?.getBoundingClientRect();
    if (!rect) return;
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;

    // 标尺：上带的右端楔形是段范围的手把（与 Tracks 一样，抓把手不会顺手挪播放头），
    // 其余地方点一下就是 seek。键盘正上方那一小块角落不算标尺，点它什么也不做。
    // 卷帘里的坐标是**段内拍**，交给时钟前要加回段的原点。
    if (localY < RULER_H) {
      if (localX < KEY_W) return;
      const wedge = wedgeAt(e.clientX, localY);
      if (wedge) {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        drag.current = {
          mode: wedge, noteId: '', grabBeat: 0, grabPitch: 0,
          origStart: 0, origDur: 0, origVel: 0, origPitch: 0, base: [], moved: false,
        };
        if (rollRef.current) rollRef.current.style.cursor = 'ew-resize';
        return;
      }
      // 标尺按下 = 抓播放头：按下这一下就落位，之后**按住拖**继续跟着走（与 Tracks 的
      // scrubRef 同一套）。吸附仍按当前网格 —— 与单击落点的规则不变。
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      drag.current = {
        mode: 'seek', noteId: '', grabBeat: 0, grabPitch: 0,
        origStart: 0, origDur: 0, origVel: 0, origPitch: 0, base: [], moved: false,
      };
      seekAt(e.clientX);
      return;
    }

    // 左边琴键：**只试听**。不落音、不选中、也不进入拖动 —— 从前这里会当成"在空白处
    // 画音"，所以点一下琴键反而在 0 拍生出一枚音，看起来像"位置映射错了"。
    if (localX < KEY_W) {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      const p = pitchAtY(e.clientY);
      setPressedKey(p);
      midiOut.audition(track.channel, p, 100, track.id);
      if (rollRef.current) rollRef.current.style.cursor = 'pointer';
      return;
    }

    // Cut（C）：指针下那枚音在**吸附到网格**的拍上被剪开。左半保留原 id（选择与工程里的
    // selNote 都还指着它），右半是新 id；音高/力度照抄。剪点落在音外、或剪完任一半短于
    // MIN_DUR（1/32 拍）就什么也不做 —— 与 Tracks 那把剃刀的"剪不动就不剪"同一条口径。
    // 一次点击只写一次，撤销栈里是一步。
    if (cutArmed) {
      const h = hitNote(e.clientX, e.clientY);
      if (!h) return;
      const at = snap(beatAtX(e.clientX));
      if (at - h.note.start < MIN_DUR - 1e-9 || h.note.start + h.note.dur - at < MIN_DUR - 1e-9) return;
      updateEditor(t => splitNoteInTrack(t, h.note.id, at, newMidiId('mn')), 'Cut note');
      if (rollRef.current) rollRef.current.style.cursor = CUT_CURSOR;
      return;
    }

    // Eraser（E）：按到哪枚音擦哪枚，按住拖着扫一片（同一个 label ⇒ 一次扫除是一步撤销）。
    // Delete / Backspace 照旧删**选中的那一批**，两条路互不影响。
    if (tool === 'eraser') {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      const h = hitNote(e.clientX, e.clientY);
      drag.current = {
        mode: 'erase', noteId: h ? h.note.id : '', grabBeat: 0, grabPitch: 0,
        origStart: 0, origDur: 0, origVel: 0, origPitch: 0, base: [], moved: false,
      };
      if (h) {
        updateEditor(t => removeNotesFromTrack(t, [h.note.id]), 'Erase notes');
        setSel(s => s.filter(x => x !== h.note.id));
      }
      if (rollRef.current) rollRef.current.style.cursor = ERASER_CURSOR;
      return;
    }

    // Shift + 拖：框选。**起手落在音符上也照框** —— 最常见的就是从已有音符之间拉出框来。
    // 不拖（点一下）还是老的 Shift 点选：加减那一枚，在 onUp 里补。
    if (e.shiftKey) {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      const hit = hitNote(e.clientX, e.clientY);
      drag.current = {
        mode: 'marquee', noteId: hit ? hit.note.id : '', grabBeat: 0, grabPitch: 0,
        origStart: 0, origDur: 0, origVel: 0, origPitch: 0,
        base: [], moved: false,
        marquee: { x0: localX, y0: localY, selBase: sel, selCur: sel },
      };
      if (rollRef.current) rollRef.current.style.cursor = 'crosshair';
      return;
    }

    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const grabB = beatAtX(e.clientX);
    const grabP = pitchAtY(e.clientY);
    const hit = hitNote(e.clientX, e.clientY);
    if (hit) {
      // 选中：**已经选中的就保持整组** —— 拖一组是常态，每点一下都缩成一枚
      // 就等于每组都要重新框一遍。点别的收成那一枚。
      const group = sel.includes(hit.note.id) ? sel : [hit.note.id];
      if (!sel.includes(hit.note.id)) setSel(group);
      ctl.select(track.id, hit.note.id);
      drag.current = {
        mode: hit.edge ? 'resize' : 'move', noteId: hit.note.id,
        grabBeat: grabB, grabPitch: grabP,
        origStart: hit.note.start, origDur: hit.note.dur, origVel: hit.note.vel, origPitch: hit.note.pitch,
        // resize 只动手里这一枚；move 动整组（整组按各自原始位置走，见 drag 的注释）
        base: (hit.edge ? [hit.note] : track.notes.filter(n => group.includes(n.id))).map(snapOf),
        moved: false,
      };
      // 点一下就能听见 —— 不给听感的编辑器等于闭眼画画。
      midiOut.audition(track.channel, hit.note.pitch, effectiveVelocity(hit.note, track), track.id);
      if (rollRef.current) rollRef.current.style.cursor = hit.edge ? 'ew-resize' : 'grabbing';
      return;
    }

    // Cursor（A）：普通鼠标。空白处按下什么都不发生 —— 这是它和画笔唯一的分界；选中、拖动、
    // 拉边都还在上面的分支里，所以"只想整理、不想画出东西"时不必先放下笔再点。
    if (tool === 'cursor') return;

    // 空白：按下就落一枚音，**不松手横着拖 = 拉长成一条长音，上下拖 = 换音高**。
    // 只点一下不拖，得到的仍然是一格 —— 与从前的单击行为一致，手感不突变。
    // 整个过程都用同一个 label，一次「按下→拖→松手」在撤销栈里只算一步。
    const b0 = Math.max(0, Math.min(snap(grabB), Math.max(0, length - Math.max(MIN_DUR, gridBeats))));
    const dur0 = Math.max(MIN_DUR, gridBeats);
    const id = newMidiId('mn');
    updateEditor(t => addNoteToTrack(t, { pitch: grabP, start: b0, dur: dur0, vel: 100 }, id), 'Draw note');
    midiOut.audition(track.channel, grabP, 100, track.id);
    setSel([id]);
    drag.current = {
      mode: 'draw', noteId: id, grabBeat: grabB, grabPitch: grabP,
      origStart: b0, origDur: dur0, origVel: 100, origPitch: grabP,
      base: [{ id, start: b0, dur: dur0, pitch: grabP }], moved: false,
    };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!track) return;
    if (!d.mode) {
      // 悬停：范围把手给左右拖动光标、右边缘给拉伸光标、音符身给抓取光标、空白给十字（画）——
      // 不提示的话，"能拉长"和"能画长音"这两件事都得靠猜。
      const rect = rollRef.current?.getBoundingClientRect();
      const el = rollRef.current;
      if (rect && e.clientX - rect.left < KEY_W) {
        // 琴键：点它是试听，光标给"可点"，不要给成画音符的十字。
        if (el) el.style.cursor = 'pointer';
        return;
      }
      if (rect && e.clientY - rect.top < RULER_H) {
        // 标尺：与 Tracks 同一颗光标 —— 点一下挪游标、上带还能拖范围把手。
        if (el) el.style.cursor = 'ew-resize';
        return;
      }
      // 武装着剪刀 / 拿着橡皮：整面（除琴键与标尺）都换光标 —— 这两支工具对"哪一行、哪一拍"
      // 都不敏感，逐枚音再换一次光标只会闪。三支精确工具的光标都是"准星 + 工具徽章"（见
      // workbench/cursors.ts）。
      if (el && cutArmed) { el.style.cursor = CUT_CURSOR; return; }
      if (el && tool === 'eraser') { el.style.cursor = ERASER_CURSOR; return; }
      // Cursor：指针就是普通箭头，压在哪枚音上都不换 —— 这正是"手上不拿工具"的样子。
      if (el && tool === 'cursor') { el.style.cursor = 'default'; return; }
      const h = hitNote(e.clientX, e.clientY);
      // 空白处 = 画笔的落点（准星 + 笔徽章）；按住 Shift 一律给十字 —— 这时拖出来的是框，
      // 压在哪枚音上都不再是"抓它"。
      if (el) el.style.cursor = e.shiftKey ? 'crosshair' : !h ? BRUSH_CURSOR : (h.edge ? 'ew-resize' : 'grab');
      return;
    }
    if (d.mode === 'erase') {
      const h = hitNote(e.clientX, e.clientY);
      if (!h) return;
      d.moved = true;
      updateEditor(t => removeNotesFromTrack(t, [h.note.id]), 'Erase notes');
      setSel(s => s.filter(x => x !== h.note.id));
      return;
    }
    if (d.mode === 'segEnd') {
      dragSegEnd(e.clientX);
      return;
    }
    if (d.mode === 'seek') {
      seekAt(e.clientX);
      return;
    }
    if (d.mode === 'marquee') {
      const rect = rollRef.current?.getBoundingClientRect();
      if (rect) marqueeAt(e.clientX - rect.left, e.clientY - rect.top);
      return;
    }
    const b = beatAtX(e.clientX);
    const p = pitchAtY(e.clientY);
    // 手里这枚的原始样子（base 为空时（Shift 那一下把选择减掉了）退回按下时记的值）
    const anchor = d.base.find(x => x.id === d.noteId)
      ?? { id: d.noteId, start: d.origStart, dur: d.origDur, pitch: d.origPitch };

    if (d.mode === 'move') {
      // 目标起点 = 抓点位移**落在网格上**；不是把位移本身量化 —— 后者对"抓在音符中间"
      // 的音符会一动手就跳半格。全程以快照为原点，绝不累加，所以拖多久都不会漂。
      let dB = Math.max(0, snap(anchor.start + (b - d.grabBeat))) - anchor.start;
      // 整组一起走：不许任何一枚被推成负起点，也不许越过段尾（窗口外看不见，等于凭空消失）
      for (const x of d.base) dB = Math.max(dB, -x.start);
      for (const x of d.base) dB = Math.min(dB, length - (x.start + x.dur));
      // 音高偏移 = 现在这一行减去抓取时那一行。**别写成 grabPitch - p**：屏幕上往下
      // 走一行 pitch 是变小的，符号一反，往上拖就变成降调（用户报的"没跟鼠标"里有一半是这个）。
      // 越界时整组一起停，而不是单独 clamp 某一枚把音程拉歪。
      let dP = p - d.grabPitch;
      for (const x of d.base) {
        dP = Math.min(dP, 127 - x.pitch);
        dP = Math.max(dP, -x.pitch);
      }
      if (!d.moved && dP === 0 && Math.abs(dB) < 1e-9) return;
      d.moved = true;
      updateEditor(t => {
        let next = t;
        for (const x of d.base) {
          next = updateNoteInTrack(next, x.id, { start: x.start + dB, pitch: x.pitch + dP });
        }
        return next;
      }, 'Move notes');
      return;
    }

    if (d.mode === 'resize') {
      // 抓的是右边缘：新右边缘 = 原右边缘 + 位移（吸到网格），再反推长度 ⇒ 边缘与指针 1:1
      const right = Math.min(length, snap(anchor.start + anchor.dur + (b - d.grabBeat)));
      const dur = Math.max(MIN_DUR, right - anchor.start);
      if (!d.moved && Math.abs(dur - anchor.dur) < 1e-9) return;
      d.moved = true;
      updateEditor(t => updateNoteInTrack(t, d.noteId, { dur }), 'Resize note');
      return;
    }

    if (d.mode === 'draw') {
      // 往后拖变长；往左拖过起点就把起点也带过去（`a` 是左端、`z` 是右端）——
      // 这样画到一半发现起头偏了，不用先松手再挪。
      const bNow = Math.max(0, Math.min(snap(b), length));
      const a = Math.max(0, Math.min(d.origStart, bNow));
      const z = Math.max(a, Math.min(length, Math.max(d.origStart, bNow)));
      const span = z - a;
      const dur = span > 1e-6 ? Math.max(MIN_DUR, span) : Math.max(MIN_DUR, gridBeats);
      const pitch = Math.max(0, Math.min(127, p));
      d.moved = true;
      updateEditor(t => updateNoteInTrack(t, d.noteId, { start: a, dur, pitch }), 'Draw note');
    }
  };

  const onUp = (e?: React.PointerEvent) => {
    const d = drag.current, m = d.marquee;
    if (d.mode === 'marquee' && m) {
      const rect = rollRef.current?.getBoundingClientRect();
      if (rect && e) marqueeAt(e.clientX - rect.left, e.clientY - rect.top);
      if (!d.moved && d.noteId) {
        // 没拖出去 = 一次 Shift 点选：加减那一枚（与框选之前的行为一致）。
        const next = sel.includes(d.noteId) ? sel.filter(x => x !== d.noteId) : [...sel, d.noteId];
        m.selCur = next;
        setSel(next);
      }
      // 主音符（工程里 selNote 只有一枚，agent 报的 selection 用它）指着选择里的第一枚。
      const primary = m.selCur[0];
      if (track && primary && ctl.project.selNote !== primary) ctl.select(track.id, primary);
      setBox(null);
    }
    d.mode = ''; d.base = []; d.marquee = undefined;
    setPressedKey(-1);
  };

  const onVelDown = (e: React.PointerEvent) => {
    if (!track) return;
    const host = velRef.current?.parentElement;
    if (!host) return;
    const r = host.getBoundingClientRect();
    const ox = scrollRef.current ? scrollRef.current.scrollLeft : 0;
    const b = (e.clientX - r.left - KEY_W + ox) / pps;
    // 找最近的音（左右 4px 内）
    let best: MidiNote | null = null;
    let bestD = 4 / pps;
    for (const n of track.notes) {
      const d = Math.abs(n.start - b);
      if (d < bestD) { bestD = d; best = n; }
    }
    if (!best) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setSel([best.id]);
    drag.current = {
      mode: 'vel', noteId: best.id, grabBeat: 0, grabPitch: 0,
      origStart: best.start, origDur: best.dur, origVel: best.vel, origPitch: best.pitch,
      base: [snapOf(best)], moved: false,
    };
    applyVel(e.clientY, r.top, host.clientHeight);
  };

  const applyVel = (clientY: number, top: number, h: number) => {
    if (!track) return;
    const d = drag.current;
    const frac = 1 - (clientY - top - 6) / (h - 14);
    const vel = Math.max(1, Math.min(127, Math.round(frac * 127)));
    updateEditor(t => updateNoteInTrack(t, d.noteId, { vel }), 'Velocity');
  };

  const onVelMove = (e: React.PointerEvent) => {
    if (drag.current.mode !== 'vel') return;
    const host = velRef.current?.parentElement;
    if (!host) return;
    const r = host.getBoundingClientRect();
    applyVel(e.clientY, r.top, host.clientHeight);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!track) return;
    // Esc 先把剪刀和橡皮收起来、回到画笔，再散开选择 —— 一次 Esc 只撤一层：
    // 正拿着工具时它管工具，工具已经收着时才管选择。
    if (e.key === 'Escape') {
      if (cutArmed || tool !== 'brush') {
        disarmCut('cut.midi');
        setMidiTool('brush');
        return;
      }
      if (sel.length) setSel([]);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) {
      e.preventDefault();
      updateEditor(t => removeNotesFromTrack(t, sel), 'Delete notes');
      setSel([]);
    }
  };

  return (
    <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, outline: 'none' }}
      tabIndex={0} onKeyDown={onKeyDown}>
      {/* 卷帘 */}
      <div ref={scrollRef} onScroll={onScroll}
        style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'auto' }}>
        <div style={{ width: contentW, height: contentH, position: 'relative' }}>
          {/* sticky：原生滚动就把这张画布钉在视口左上角。以前是 absolute + left/top 跟
              scroll 状态 —— 滚动先发生、React 再补位置，中间那一帧画布会跟着内容一起走，
              看起来就是"左边的钢琴键被拖走了"（滚动得越快越明显）。 */}
          <canvas ref={rollRef}
            style={{ position: 'sticky', top: 0, left: 0, display: 'block', zIndex: 2 }}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
            onDoubleClick={e => {
              const rect = rollRef.current?.getBoundingClientRect();
              // 琴键上的双击也只是试听，不能顺手删掉 0 拍附近的音。
              if (rect && e.clientX - rect.left < KEY_W) return;
              const hit = hitNote(e.clientX, e.clientY);
              if (hit && track) { updateEditor(t => removeNotesFromTrack(t, [hit.note.id]), 'Delete note'); setSel([]); }
            }}
          />
          {/* 播放头：三角落在标尺底部带、细线从三角顶往下穿（与 Tracks 同一套画法）。
              外层只钉基准点，逐帧位移交给 useClockFrame 直改 transform。 */}
          <div ref={headRef} style={{
            position: 'absolute', top: 0, bottom: 0, left: 0, width: 0,
            pointerEvents: 'none', willChange: 'transform', zIndex: 3, display: 'none',
          }}>
            <div style={{
              position: 'absolute', left: -5, top: RULER_H - PLAY_H, width: 10, height: PLAY_H,
              background: COL.playhead, clipPath: 'polygon(0 0, 100% 0, 50% 100%)',
              filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))',
            }} />
            <div style={{
              position: 'absolute', left: -0.5, top: RULER_H - PLAY_H, bottom: 0, width: 1,
              background: COL.playhead, opacity: 0.85,
            }} />
          </div>
        </div>
      </div>

      {/* 卷帘 ↔ 力度泳道之间那条横线：上下拖改泳道高度（双击回默认）。
          它就是"上面看音高、下面看力度"的分配比例，写着写着总有一边要更多地方。 */}
      <Splitter axis="y" onStart={startVelSplit} onDrag={dragVelSplit} onEnd={commitVel} onReset={resetVel}
        title="拖动改变力度泳道高度（双击复位）" />

      {/* 力度泳道 */}
      <div style={{ height: velH, flexShrink: 0, position: 'relative', overflow: 'hidden' }}>
        <canvas ref={velRef} style={{ display: 'block' }}
          onPointerDown={onVelDown} onPointerMove={onVelMove} onPointerUp={onUp} onPointerCancel={onUp} />
      </div>
    </div>
  );
};

/** 给 Inspector 用：这一轨的音符统计（力度分布能一眼看出是不是"全都 100"）。 */
export const velocityStats = (ctl: MidiCtl) => {
  const notes = ctl.track?.notes ?? [];
  if (!notes.length) return { min: 0, max: 0, avg: 0, count: 0 };
  let min = 127, max = 0, sum = 0;
  for (const n of notes) { min = Math.min(min, n.vel); max = Math.max(max, n.vel); sum += n.vel; }
  return { min, max, avg: Math.round(sum / notes.length), count: notes.length };
};
