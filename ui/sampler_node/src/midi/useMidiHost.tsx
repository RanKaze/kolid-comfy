// ── MIDI 模式的宿主 ──────────────────────────────────────────────────────────────────────────
//
// 一段 hook，把"工程投影 / 选中段 / 循环回绕 / 把事件喂给外部音源"这几件事从 EditPhase 那
// 四万行里隔出来。**它不再自己存工程**：乐器轨与乐器段住在视频工程里（`VidTrack.kind ===
// 'midi'` / `VidClip.notes`），随时间线一起按文档分桶、一起撤销、一起随 .cud 走。
//
// 宿主（EditPhase）只需要：
//   const midi = useMidiHost({ activeUid, project, update, projectOf, updateIn, ... });
//   ...midi.ctl          ← 塞给工作区 / Assets / agent
//   存盘时 project 原样交给页面 ← 没有第二个键要拼了
//
// 时间一律来自 clock（见 midi/clock.ts）。这里**不存秒数**，只存拍与 BPM。

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { clock } from './clock';
import { transport } from './transportActions';
import { useClockFrame } from './hooks';
import { startNativeMonitor } from './nativeMonitor';
import { midiOut } from './output';
import { setEditorHost } from './soundWindow';
import { type MidiProject, type MidiTrack, beatToSeconds, secondsToBeat } from './model';
import {
  applyEditorNotes, applyMidiProject, midiEditorOf, midiProjectOf, musicOf, toggleLoopRange, vidDuration,
} from '../workbench/video/model';
import type { VidProject } from '../workbench/video/model';
import { getVidSelection, subscribeVidSelection } from '../workbench/video/selection';
import type { MidiCtl } from './types';

export type MidiHost = {
  ctl: MidiCtl;
  /** 某份文档的轨（存盘前认"哪几条开着音色窗"用；不必是屏幕上这份）。 */
  tracksOf: (uid: number) => { id: string; name: string }[];
  /** 写**某份**文档，不必是屏幕上这份（存盘时收别处的音色窗）。 */
  updateIn: (uid: number, fn: (p: MidiProject) => MidiProject, label?: string) => void;
  /** 这条轨住在哪份文档（null = 找不到）。 */
  docOf: (trackId: string) => number | null;
};

export const useMidiHost = (opts: {
  activeUid: number | null;
  /** 屏幕上这份视频工程 —— 乐器轨/段都在里面。 */
  project: VidProject;
  /** 改屏幕上这份（视频工程的唯一写口：撤销、置脏、落盘都在它那边）。 */
  update: (fn: (p: VidProject) => VidProject, label?: string) => void;
  /** 取某份文档的视频工程（桶里那份，不必是屏幕上这份）。 */
  projectOf: (uid: number) => VidProject | null;
  /** 改某份文档的视频工程。 */
  updateIn: (uid: number, fn: (p: VidProject) => VidProject, label?: string) => void;
  /** 视频撤销摞（MIDI 不再自己记一支：一次编辑 = 时间线上的一步）。 */
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** 有哪些文档的桶（音色窗按轨反查归属用）。 */
  docIds: () => number[];
  /** 置脏（tab 上的 ●、关前询问）。 */
  onDirty: (uid: number) => void;
}): MidiHost => {
  const {
    activeUid, project, update: updateVid, projectOf, updateIn: updateInVid,
    undo, redo, canUndo, canRedo, docIds, onDirty,
  } = opts;

  const projectRef = useRef(project);
  projectRef.current = project;
  const projectOfRef = useRef(projectOf);
  projectOfRef.current = projectOf;
  const docIdsRef = useRef(docIds);
  docIdsRef.current = docIds;
  const activeUidRef = useRef(activeUid);
  activeUidRef.current = activeUid;

  /** 喂给引擎/外部端口的投影：所有 MIDI 轨，音符在**全局拍**上。 */
  const midiProj = useMemo(() => midiProjectOf(project), [project]);
  const midiProjRef = useRef(midiProj);
  midiProjRef.current = midiProj;

  // ── 选中哪一段：时间线的选中是跨窗 store；没有选中 MIDI 段时退回第一段 ────────────────
  // 退回而不是空，是因为 MIDI 模式的正文就是卷帘 —— 工程里有段却画一片空白会像"坏了"。
  const sel = useSyncExternalStore(subscribeVidSelection, getVidSelection);
  const clipId = useMemo(() => {
    for (const c of project.clips) if (c.kind === 'midi' && sel.has(c.id)) return c.id;
    return project.clips.find(c => c.kind === 'midi')?.id ?? null;
  }, [project.clips, sel]);
  const clipIdRef = useRef<string | null>(clipId);
  clipIdRef.current = clipId;

  const editor = useMemo(() => midiEditorOf(project, clipId), [project, clipId]);
  const track = editor?.track ?? null;

  // 音符选中（给 agent 报 selection 用）。换段就清掉 —— 上一段的 id 在新段里不存在。
  const [selNote, setSelNote] = useState('');
  useEffect(() => { setSelNote(''); }, [clipId]);
  const note = track?.notes.find(n => n.id === selNote) ?? null;

  // ── 投影级写回：轨级动作（装/卸乐器、改名、通道、力度、M/S、BPM/循环）──────────────
  const update = useCallback((fn: (p: MidiProject) => MidiProject, label = 'MIDI edit') => {
    updateVid(p => {
      const prev = midiProjectOf(p);
      const next = fn(prev);
      return next === prev ? p : applyMidiProject(p, prev, next);
    }, label);
  }, [updateVid]);

  const updateIn = useCallback((uid: number, fn: (p: MidiProject) => MidiProject, label = 'MIDI edit') => {
    updateInVid(uid, p => {
      const prev = midiProjectOf(p);
      const next = fn(prev);
      return next === prev ? p : applyMidiProject(p, prev, next);
    }, label);
  }, [updateInVid]);

  /** 卷帘写回：只认选中的那一段，音符是段内拍；窗口外的音符原样留着。 */
  const updateEditor = useCallback((fn: (t: MidiTrack) => MidiTrack, label = 'Edit notes') => {
    updateVid(p => {
      const ed = midiEditorOf(p, clipIdRef.current);
      if (!ed) return p;
      const next = fn(ed.track);
      return next === ed.track ? p : applyEditorNotes(p, ed, next);
    }, label);
  }, [updateVid]);

  /** 范围游标的右边界 = 段尾：拖它改的是**这一段自己的时长**（时间线上的右裁）。
   *  左边恒为 0.0；段内容不跟着删 —— 被裁到范围外的音符仍然留在段上（卷帘压暗画着）。 */
  const setEditorLength = useCallback((beats: number) => {
    updateVid(p => {
      const c = p.clips.find(x => x.id === clipIdRef.current);
      if (!c || c.kind !== 'midi') return p;
      const duration = Math.max(0.05, beatToSeconds(Math.max(0, beats), musicOf(p).tempo));
      if (Math.abs(duration - c.duration) < 1e-9) return p;
      return { ...p, clips: p.clips.map(x => (x.id === c.id ? { ...x, duration } : x)) };
    }, 'Resize MIDI segment');
  }, [updateVid]);

  /** 时间线总长：两种模式的"片尾"都按它算（片尾停止 / 读数 / 走到片尾再按播放）。 */
  const endSec = useMemo(() => vidDuration(project), [project]);

  /** 循环开关：区间只有一份（时间线入/出点），两种模式的传输条都落到这一个动作上。 */
  const toggleLoop = useCallback(() => {
    updateVid(p => toggleLoopRange(p), 'Loop');
  }, [updateVid]);

  // 本机引擎：进页面探一次（既不弹权限也不开设备）。探到就把它摆进端口表并默认选中。
  useEffect(() => {
    void midiOut.probeNative();
  }, []);

  // 引擎的声音也要进 Audio Monitor（独占音频槽在 workbench/video/audioFocus.ts）。
  useEffect(() => startNativeMonitor(() => midiOut.isNative()), []);

  // 工程变了：直接推一次整表（不等 rAF 发现）。拖音符时 120ms 合一次，见 engine.ts。
  useEffect(() => {
    midiOut.rebuild(midiProj);
  }, [midiProj]);

  // ── 每帧：把事件喂出去 ────────────────────────────────────────────────────────────────────
  // 这一步必须在**页面**里跑，而不是某扇窗里 —— 用户把卷帘关了，音乐还得继续走。
  // 循环回绕不在这里：区间是时间线的入/出点，回绕归整页的走带（见 video/timelineAudio.ts），
  // 一处判断就够；两处各判一次就是两套回绕互相打架。
  useClockFrame(() => {
    midiOut.tick(midiProjRef.current);
  });

  // playing 是时钟的状态，不是工程的 —— 让 ctl 跟着时钟翻新（面板上的 ▶/❙❙ 才切得过来）。
  const [playingNow, setPlayingNow] = useState(clock.isPlaying());
  useEffect(() => {
    let was = clock.isPlaying();
    return clock.subscribe(() => {
      const now = clock.isPlaying();
      if (now !== was) { was = now; setPlayingNow(now); }
    });
  }, []);

  const ctl = useMemo<MidiCtl>(() => ({
    project: { ...midiProj, selTrack: editor?.trackId ?? midiProj.selTrack, selNote },
    editor,
    clipId,
    update,
    updateEditor,
    setEditorLength,
    select: (_trackId, noteId) => setSelNote(noteId ?? ''),
    playing: playingNow,
    toggleLoop,
    endSec,
    play: () => transport.play(),
    pause: () => transport.pause(),
    stopAt: (sec: number) => transport.stopAt(sec),
    seekBeat: (beat: number) => transport.seek(beatToSeconds(Math.max(0, beat), midiProj.tempo)),
    undo,
    redo,
    canUndo,
    canRedo,
    track,
    note,
  }), [midiProj, editor, clipId, selNote, update, updateEditor, setEditorLength, toggleLoop, endSec, playingNow, undo, redo, canUndo, canRedo, track, note]);

  // ── 音色窗的宿主：它只借"当前这份工程"和唯一写口 ─────────────────────────────────────
  const tracksOf = useCallback((uid: number) => {
    const p = projectOfRef.current(uid);
    return p ? midiProjectOf(p).tracks.map(t => ({ id: t.id, name: t.name })) : [];
  }, []);

  const docOf = useCallback((trackId: string): number | null => {
    const here = activeUidRef.current;
    if (here != null && midiProjectOf(projectRef.current).tracks.some(t => t.id === trackId)) return here;
    for (const uid of docIdsRef.current()) {
      if (uid === here) continue;
      const p = projectOfRef.current(uid);
      if (p && midiProjectOf(p).tracks.some(t => t.id === trackId)) return uid;
    }
    return null;
  }, []);

  useEffect(() => {
    setEditorHost({
      getProject: () => midiProjRef.current,
      update,
      updateIn,
      tracksOf,
      docOf,
      dirty: onDirty,
    });
    return () => setEditorHost(null);
  }, [update, updateIn, tracksOf, docOf, onDirty]);

  return { ctl, tracksOf, updateIn, docOf };
};

/** 播放头现在第几拍 —— 标尺与卷帘共用（别各写一遍换算）。 */
export const beatNow = (tempo: number): number => secondsToBeat(clock.seconds(), tempo);
