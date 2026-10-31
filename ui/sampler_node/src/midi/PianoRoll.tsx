// ── 钢琴卷帘窗（含底部力度泳道）─────────────────────────────────────────────────────────────
//
// 这一格是 MIDI 模式的主场：上面按音高排音符，下面按力度排同一批音符 —— 两栏共用一条时间轴，
// 所以"哪个音在哪儿、它有多重"永远是同一眼能看全的一件事。
//
// 几个必须守住的规则（每一条都是踩过的坑）：
//   * **时间单位是拍**，不是秒。改 BPM 时音符不许动 —— 秒只在播放时才出现，且由 clock 给。
//   * **只画可视区**。整卷帘按 128 个半音 × 200 拍铺成一张画布是几十 MB 位图，拖动会卡死；
//     这里画布永远是"窗口那么大"，滚动只是换一个偏移量重画。
//   * **力度是每个音自己的**，轨上那根推子是另一个乘数（见 TrackList）。两者在画面上互不干扰：
//     这里改的永远是 note.vel。
//   * 拖动的每一帧都走 update（同一个 label），撤销栈会把它们并成**一步**。
//
// 键盘区在左边始终固定（不随横向滚动走），因为"哪一行是哪个音"必须一直看得见。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { clock } from './clock';
import { useClockFrame } from './hooks';
import { DEFAULT_LAYOUT, readLayout, writeLayout } from './layoutPrefs';
import { midiOut } from './output';
import { Splitter } from './Splitter';
import {
  MIN_DUR, type MidiNote, addNote, effectiveVelocity, isBlackKey, newMidiId, pitchName,
  quantize, removeNotes, secondsToBeat, updateNote,
} from './model';
import type { MidiCtl } from './types';

const KEY_W = 46;
const ROW_H = 13;
const PITCH_TOP = 108;      // 画到 C8
const PITCH_BOTTOM = 24;    // 画到 C1
const ROWS = PITCH_TOP - PITCH_BOTTOM + 1;
const VEL_MIN = 46;
const VEL_MAX = 340;
/** 卷帘主体至少留这么高 —— 拖到只剩力度泳道就没意义了。 */
const ROLL_MIN_H = 120;
const RULER_H = 20;
/** 横向缩放（每拍多少像素）的取值范围与默认值。双击 zoom 滑杆回到这里。 */
const ZOOM_MIN = 18;
const ZOOM_MAX = 220;
const DEFAULT_PPS = 64;

const GRID_CHOICES: { label: string; beats: number }[] = [
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
  loop: 'rgba(10,132,255,0.10)',
};

type DragMode = 'move' | 'resize' | 'vel' | 'draw' | ''

export const MidiPianoRoll: React.FC<{ ctl: MidiCtl }> = ({ ctl }) => {
  const { project, update, track } = ctl;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rollRef = useRef<HTMLCanvasElement | null>(null);
  const velRef = useRef<HTMLCanvasElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);

  const [gridBeats, setGridBeats] = useState(0.25);
  const [pps, setPps] = useState(DEFAULT_PPS);
  const [sel, setSel] = useState<string[]>([]);
  // 按下的琴键（-1 = 没按）。只用来给键盘画一下高亮 —— 点琴键只试听，不落音。
  const [pressedKey, setPressedKey] = useState(-1);
  const ppsRef = useRef(pps);
  ppsRef.current = pps;
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
    // 增量式（往上拖变高）+ 留出卷帘主体的最小高度。工具条那一条也算在 r 里，一并扣掉。
    const cap = Math.max(VEL_MIN, Math.min(VEL_MAX, r.height - ROLL_MIN_H - 30));
    setVelH(Math.round(Math.max(VEL_MIN, Math.min(cap, baseVelH.current + (y0 - y)))));
  }, []);
  const commitVel = useCallback(() => setVelH(h => { writeLayout({ velH: h }); return h; }), []);
  const resetVel = useCallback(() => {
    const el = rootRef.current;
    const cap = el ? Math.max(VEL_MIN, Math.min(VEL_MAX, el.getBoundingClientRect().height - ROLL_MIN_H - 30)) : VEL_MAX;
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
  }>({
    mode: '', noteId: '', grabBeat: 0, grabPitch: 0,
    origStart: 0, origDur: 0, origVel: 0, origPitch: 0, base: [], moved: false,
  });
  /** 记录这一枚音按下时的样子（move / resize / draw 都要）。 */
  const snapOf = (n: MidiNote) => ({ id: n.id, start: n.start, dur: n.dur, pitch: n.pitch });

  const trackNotes = track?.notes ?? [];
  const endBeat = Math.max(16, ...trackNotes.map(n => n.start + n.dur), project.loop.b + 4);
  const contentW = KEY_W + endBeat * pps + 240;
  const contentH = RULER_H + ROWS * ROW_H;

  const zoomRef = useRef<HTMLInputElement | null>(null);
  /** 缩放：**把视口中心那一拍钉在原地**。直接 setPps 只会让内容变宽而 scrollLeft 不动，
   *  用户一拖滑块视野就跑到别处、还得再找回来 —— 这是缩放"不好用"的最大来源。 */
  const setZoom = useCallback((next: number) => {
    const prev = ppsRef.current;
    const v = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(next)));
    if (v === prev) return;
    const host = scrollRef.current;
    const span = host ? Math.max(1, host.clientWidth - KEY_W) : 0;
    const centerBeat = host ? (host.scrollLeft + span / 2) / prev : 0;
    setPps(v);
    // 内容宽度要等这一帧的布局，所以挪 scrollLeft 放到下一帧。
    if (host) requestAnimationFrame(() => { host.scrollLeft = Math.max(0, centerBeat * v - span / 2); });
  }, []);
  const zoomFill = Math.round(((pps - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)) * 100) + '%';

  // 原生 range 对滚轮完全没反应，而缩放是这排控件里最常反复微调的一件事。
  // 必须走原生监听才能 preventDefault（React 的 onWheel 挂的是 passive 监听）。
  useEffect(() => {
    const el = zoomRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const step = Math.max(1, Math.round(ppsRef.current * 0.08));
      setZoom(ppsRef.current - Math.sign(ev.deltaY) * step);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setZoom]);

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

    // 行底色（黑键行沉一点）+ C 行分隔
    for (let p = PITCH_BOTTOM; p <= PITCH_TOP; p++) {
      const y = RULER_H + (PITCH_TOP - p) * ROW_H - oy;
      if (y + ROW_H < RULER_H || y > h) continue;
      if (isBlackKey(p)) { g.fillStyle = COL.rowBlack; g.fillRect(KEY_W, y, w - KEY_W, ROW_H); }
      if (p % 12 === 0) { g.fillStyle = COL.rowC; g.fillRect(KEY_W, y + ROW_H - 1, w - KEY_W, 1); }
    }

    // 循环区间
    if (project.loop.on) {
      const xa = KEY_W + project.loop.a * pps - ox;
      const xb = KEY_W + project.loop.b * pps - ox;
      g.fillStyle = COL.loop;
      g.fillRect(Math.max(KEY_W, xa), RULER_H, Math.min(w, xb) - Math.max(KEY_W, xa), h - RULER_H);
    }

    // 竖线：网格 / 拍 / 小节
    const bar = project.timeSig[0];
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

    // 标尺（顶部）
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
      g.fillText(String(Math.floor(b / bar) + 1), x + 3, RULER_H / 2);
    }
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.fillRect(0, RULER_H - 1, w, 1);
    g.fillStyle = '#0d0e10';
    g.fillRect(0, 0, KEY_W, RULER_H);
  }, [pps, gridBeats, project.loop, project.timeSig, track, sel, pressedKey]);

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
  }, [pps, track, sel, velH]);

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
    const beat = secondsToBeat(clock.seconds(), project.tempo);
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

  const snap = (beat: number): number => Math.round(beat / gridBeats) * gridBeats;

  const onDown = (e: React.PointerEvent) => {
    if (!track) return;
    if (e.button !== 0) return;
    const rect = rollRef.current?.getBoundingClientRect();
    if (!rect) return;
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;

    // 标尺：点一下就是 seek。键盘正上方那一小块角落不算标尺，点它什么也不做。
    if (localY < RULER_H) {
      if (localX >= KEY_W) ctl.seekBeat(snap(beatAtX(e.clientX)));
      return;
    }

    // 左边琴键：**只试听**。不落音、不选中、也不进入拖动 —— 从前这里会当成"在空白处
    // 画音"，所以点一下琴键反而在 0 拍生出一枚音，看起来像"位置映射错了"。
    if (localX < KEY_W) {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      const p = pitchAtY(e.clientY);
      setPressedKey(p);
      midiOut.audition(track.channel, p, 100);
      if (rollRef.current) rollRef.current.style.cursor = 'pointer';
      return;
    }

    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const grabB = beatAtX(e.clientX);
    const grabP = pitchAtY(e.clientY);
    const hit = hitNote(e.clientX, e.clientY);
    if (hit) {
      // 选中：Shift 加减一枚；不按 Shift 时**已经选中的就保持整组** —— 拖一组是常态，
      // 每点一下都缩成一枚就等于每组都要重新框一遍。
      let group: string[];
      if (e.shiftKey) {
        group = sel.includes(hit.note.id) ? sel.filter(x => x !== hit.note.id) : [...sel, hit.note.id];
        setSel(group);
      } else if (sel.includes(hit.note.id)) {
        group = sel;
      } else {
        group = [hit.note.id];
        setSel(group);
      }
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
      midiOut.audition(track.channel, hit.note.pitch, effectiveVelocity(hit.note, track));
      if (rollRef.current) rollRef.current.style.cursor = hit.edge ? 'ew-resize' : 'grabbing';
      return;
    }

    // 空白：按下就落一枚音，**不松手横着拖 = 拉长成一条长音，上下拖 = 换音高**。
    // 只点一下不拖，得到的仍然是一格 —— 与从前的单击行为一致，手感不突变。
    // 整个过程都用同一个 label，一次「按下→拖→松手」在撤销栈里只算一步。
    const b0 = Math.max(0, snap(grabB));
    const dur0 = Math.max(MIN_DUR, gridBeats);
    const id = newMidiId('mn');
    update(pp => addNote(pp, track.id, { pitch: grabP, start: b0, dur: dur0, vel: 100 }, id), 'Draw note');
    midiOut.audition(track.channel, grabP, 100);
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
      // 悬停：右边缘给拉伸光标、音符身给抓取光标、空白给十字（画）——
      // 不提示的话，"能拉长"和"能画长音"这两件事都得靠猜。
      const rect = rollRef.current?.getBoundingClientRect();
      const el = rollRef.current;
      if (rect && e.clientX - rect.left < KEY_W) {
        // 琴键：点它是试听，光标给"可点"，不要给成画音符的十字。
        if (el) el.style.cursor = 'pointer';
        return;
      }
      const h = hitNote(e.clientX, e.clientY);
      if (el) el.style.cursor = h ? (h.edge ? 'ew-resize' : 'grab') : 'crosshair';
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
      // 整组一起走：不许任何一枚被推成负起点，全体退到刚好贴着 0
      for (const x of d.base) dB = Math.max(dB, -x.start);
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
      update(pp => {
        let next = pp;
        for (const x of d.base) {
          next = updateNote(next, track.id, x.id, { start: x.start + dB, pitch: x.pitch + dP });
        }
        return next;
      }, 'Move notes');
      return;
    }

    if (d.mode === 'resize') {
      // 抓的是右边缘：新右边缘 = 原右边缘 + 位移（吸到网格），再反推长度 ⇒ 边缘与指针 1:1
      const right = snap(anchor.start + anchor.dur + (b - d.grabBeat));
      const dur = Math.max(MIN_DUR, right - anchor.start);
      if (!d.moved && Math.abs(dur - anchor.dur) < 1e-9) return;
      d.moved = true;
      update(pp => updateNote(pp, track.id, d.noteId, { dur }), 'Resize note');
      return;
    }

    if (d.mode === 'draw') {
      // 往后拖变长；往左拖过起点就把起点也带过去（`a` 是左端、`z` 是右端）——
      // 这样画到一半发现起头偏了，不用先松手再挪。
      const bNow = snap(b);
      const a = Math.max(0, Math.min(d.origStart, bNow));
      const z = Math.max(d.origStart, bNow);
      const span = z - a;
      const dur = span > 1e-6 ? Math.max(MIN_DUR, span) : Math.max(MIN_DUR, gridBeats);
      const pitch = Math.max(0, Math.min(127, p));
      d.moved = true;
      update(pp => updateNote(pp, track.id, d.noteId, { start: a, dur, pitch }), 'Draw note');
    }
  };

  const onUp = () => {
    drag.current.mode = ''; drag.current.base = [];
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
    update(pp => updateNote(pp, track.id, d.noteId, { vel }), 'Velocity');
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
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) {
      e.preventDefault();
      update(pp => removeNotes(pp, track.id, sel), 'Delete notes');
      setSel([]);
    }
  };

  return (
    <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, outline: 'none' }}
      tabIndex={0} onKeyDown={onKeyDown}>
      {/* 工具条 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', flexShrink: 0,
        borderBottom: '0.5px solid rgba(255,255,255,0.08)',
      }}>
        <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.45)' }}>grid</span>
        {GRID_CHOICES.map(gc => (
          <button key={gc.label}
            style={{
              fontSize: 9.5, fontWeight: 600, padding: '1px 6px', borderRadius: 4, cursor: 'pointer',
              background: Math.abs(gridBeats - gc.beats) < 1e-6 ? 'rgba(10,132,255,0.85)' : 'rgba(255,255,255,0.06)',
              border: '0.5px solid rgba(255,255,255,0.14)',
              color: Math.abs(gridBeats - gc.beats) < 1e-6 ? '#fff' : 'rgba(255,255,255,0.65)',
            }}
            onClick={() => setGridBeats(gc.beats)}>{gc.label}</button>
        ))}
        <button style={{
          fontSize: 9.5, fontWeight: 600, padding: '1px 7px', borderRadius: 4, cursor: 'pointer',
          background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.14)',
          color: 'rgba(255,255,255,0.75)',
        }}
          title="把选中（没选中就整轨）的音符起点吸附到这个网格"
          onClick={() => { if (track) update(pp => quantize(pp, track.id, gridBeats), 'Quantize'); }}>Quantize</button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.45)' }}>zoom</span>
        <input ref={zoomRef} className="midi-slider" type="range"
          min={ZOOM_MIN} max={ZOOM_MAX} step={1} value={pps}
          style={{ width: 96, flex: '0 0 auto', '--fill': zoomFill } as React.CSSProperties}
          onChange={e => setZoom(Number(e.target.value))}
          onDoubleClick={() => setZoom(DEFAULT_PPS)}
          title="横向缩放（滚轮微调，双击回默认）" />
        <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.35)', width: 34 }}>
          {Math.round(pps)}px
        </span>
      </div>

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
              if (hit && track) { update(pp => removeNotes(pp, track.id, [hit.note.id]), 'Delete note'); setSel([]); }
            }}
          />
          <div ref={headRef} style={{
            position: 'absolute', top: 0, bottom: 0, width: 1.5, background: COL.playhead,
            boxShadow: '0 0 6px rgba(255,69,58,0.7)', pointerEvents: 'none', willChange: 'transform',
            zIndex: 3, display: 'none',
          }} />
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
