// ── MIDI 模式的宿主 ──────────────────────────────────────────────────────────────────────────
//
// 一段 hook，把"按文档分桶 / 撤销栈 / 随 .cud 走 / 循环回绕 / 把事件喂给外部音源"这几件事
// 从 EditPhase 那四万行里隔出来。EditPhase 只需要：
//   const midi = useMidiHost({...});          ← 一次
//   ...midi.bodies                            ← 塞进 dock 的 bodies
//   存盘时 project: midi.withMidi(proj, uid)  ← 一行
//   读档时 midi.restore(uid, d.project?.midi) ← 一行
//
// 这样做的理由和视频那一半一样：状态必须住在**页面**（关掉一扇窗不该丢东西、切文档要换一份），
// 但页面不该再多出第五条撤销栈的手写实现。
//
// 时间一律来自 clock（见 midi/clock.ts）。这里**不存秒数**，只存拍与 BPM。

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { clock } from './clock';
import { useClockFrame } from './hooks';
import { midiOut } from './output';
import {
  type MidiNote, type MidiProject, activeTrackOf, beatToSeconds, defaultMidiProject,
  normalizeMidiProject, secondsToBeat,
} from './model';
import type { MidiCtl } from './types';

const MIDI_STORE = 'sampler.midiProject';
const HIST_MAX = 80;
const COALESCE_MS = 650;

type HistRec = { p: MidiProject; label: string; at: number };

const loadSeed = (): MidiProject => {
  try {
    const raw = localStorage.getItem(MIDI_STORE);
    if (!raw) return defaultMidiProject();
    return normalizeMidiProject(JSON.parse(raw));
  } catch { return defaultMidiProject(); }
};

export type MidiHost = {
  ctl: MidiCtl;
  /** 存盘用：把这一份文档的 MIDI 挂到视频工程上（`.cud` 的 header.video 是个黑盒，多一个键不碍事）。 */
  withMidi: <T extends object>(proj: T, uid: number) => T & { midi?: MidiProject };
  /** 读档用：文件里带 midi 就落进桶里；不带就给它一份空的（别把上一份的轨带过来）。 */
  restore: (uid: number, raw: unknown) => void;
  /** 文档关了：桶清掉，免得 uid 被复用后认领了别人的工程。 */
  drop: (uid: number) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
};

export const useMidiHost = (opts: {
  activeUid: number | null;
  /** 置脏（tab 上的 ●、关前询问）。 */
  onDirty: (uid: number) => void;
  /** 找机会落盘（去抖在宿主那边）。 */
  saveSoon: (uid: number) => void;
}): MidiHost => {
  const { activeUid, onDirty, saveSoon } = opts;

  const seed = useRef<MidiProject | null>(null);
  if (seed.current === null) seed.current = loadSeed();

  const [project, setProject] = useState<MidiProject>(seed.current);
  const projectRef = useRef(project);
  projectRef.current = project;

  // 屏幕上这份**属于哪份文档**：切 tab 那一帧 state 还停在上一份上，写桶必须按归属判。
  const owner = useRef<number | null>(null);
  const byDoc = useRef(new Map<number, MidiProject>());
  const hist = useRef(new Map<number, { undo: HistRec[]; redo: HistRec[] }>());
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const activeUidRef = useRef(activeUid);
  activeUidRef.current = activeUid;

  const histOf = useCallback((uid: number) => {
    let h = hist.current.get(uid);
    if (!h) { h = { undo: [], redo: [] }; hist.current.set(uid, h); }
    return h;
  }, []);

  /** 唯一写口。`label` 同时是撤销栈里那一步的名字和合并键（拖动每帧都来 ⇒ 并成一步）。 */
  const update = useCallback((fn: (p: MidiProject) => MidiProject, label = 'Edit') => {
    const uid = owner.current;
    const prev = projectRef.current;
    const next = fn(prev);
    if (next === prev) return;
    projectRef.current = next;
    setProject(next);
    if (uid == null) return;
    byDoc.current.set(uid, next);
    const h = histOf(uid);
    const now = Date.now();
    const top = h.undo[h.undo.length - 1];
    if (top && top.label === label && now - top.at < COALESCE_MS) top.at = now;
    else {
      h.undo.push({ p: prev, label, at: now });
      while (h.undo.length > HIST_MAX) h.undo.shift();
    }
    h.redo.length = 0;
    onDirty(uid);
    saveSoon(uid);
    bump();
  }, [histOf, onDirty, saveSoon]);

  const applyState = useCallback((uid: number, p: MidiProject) => {
    byDoc.current.set(uid, p);
    projectRef.current = p;
    owner.current = uid;
    setProject(p);
    onDirty(uid);
    bump();
  }, [onDirty]);

  const undo = useCallback(() => {
    const uid = activeUidRef.current;
    if (uid == null) return;
    const h = histOf(uid);
    const rec = h.undo.pop();
    if (!rec) return;
    h.redo.push({ p: projectRef.current, label: rec.label, at: Date.now() });
    applyState(uid, rec.p);
    bump();
  }, [applyState, histOf]);

  const redo = useCallback(() => {
    const uid = activeUidRef.current;
    if (uid == null) return;
    const h = histOf(uid);
    const rec = h.redo.pop();
    if (!rec) return;
    h.undo.push({ p: projectRef.current, label: rec.label, at: Date.now() });
    applyState(uid, rec.p);
    bump();
  }, [applyState, histOf]);

  // 本机引擎：进页面探一次（既不弹权限也不开设备）。探到就把它摆进端口表并默认选中 ——
  // 这是"装了就能听"的那条路，不用先去找 loopMIDI 或宿主。
  useEffect(() => {
    void midiOut.probeNative();
  }, []);

  // 工程变了：直接推一次整表（不等 rAF 发现）。拖音符时 120ms 合一次，见 engine.ts。
  useEffect(() => {
    midiOut.rebuild(project);
  }, [project]);

  // ── 换文档 = 换一份工程 ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (activeUid == null) { owner.current = null; return; }
    const mine = byDoc.current.get(activeUid);
    if (mine) {
      owner.current = activeUid;
      projectRef.current = mine;
      setProject(mine);
    } else {
      // 这份文档还没有 MIDI：给它一份空的，而不是把上一份的轨搬过来。
      const fresh = defaultMidiProject();
      byDoc.current.set(activeUid, fresh);
      owner.current = activeUid;
      projectRef.current = fresh;
      setProject(fresh);
    }
  }, [activeUid]);

  // 页面存档：只在"还没有任何文档"时作起手工程用（和视频那半边同一口径）。
  useEffect(() => {
    if (activeUid == null) return;
    const t = setTimeout(() => {
      try { localStorage.setItem(MIDI_STORE, JSON.stringify(project)); } catch { /* in-memory only */ }
    }, 400);
    return () => clearTimeout(t);
  }, [project, activeUid]);

  // 工程变了：输出队列由 tick 自己发现（`lastProj !== proj` 就重建），不必在这里推第二次。

  // ── 每帧：循环回绕 + 把事件喂出去 ─────────────────────────────────────────────────────────
  // 这两个动作必须在**页面**里跑，而不是某扇窗里 —— 用户把卷帘关了，音乐还得继续走。
  useClockFrame(() => {
    const p = projectRef.current;
    if (clock.isPlaying() && p.loop.on) {
      const endSec = beatToSeconds(p.loop.b, p.tempo);
      const startSec = beatToSeconds(p.loop.a, p.tempo);
      if (endSec > startSec && clock.seconds() >= endSec) {
        void clock.seek(startSec);
      }
    }
    midiOut.tick(p);
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

  const ctl = useMemo<MidiCtl>(() => {
    const track = activeTrackOf(project);
    const note: MidiNote | null = track ? (track.notes.find(n => n.id === project.selNote) ?? null) : null;
    return {
      project,
      update,
      select: (trackId, noteId) => update(p => ({ ...p, selTrack: trackId, selNote: noteId ?? p.selNote }), 'Select'),
      playing: playingNow,
      play: () => { void clock.play(); midiOut.pushPrograms(project); },
      pause: () => { void clock.pause(); },
      seekBeat: (beat: number) => { void clock.seek(beatToSeconds(Math.max(0, beat), project.tempo)); },
      undo,
      redo,
      canUndo: activeUid != null && (hist.current.get(activeUid)?.undo.length ?? 0) > 0,
      canRedo: activeUid != null && (hist.current.get(activeUid)?.redo.length ?? 0) > 0,
      track: track ?? null,
      note,
    };
  }, [project, update, undo, redo, activeUid, playingNow]);

  const withMidi = useCallback(<T extends object>(proj: T, uid: number): T & { midi?: MidiProject } => {
    const mine = byDoc.current.get(uid) ?? (owner.current === uid ? projectRef.current : null);
    return mine ? { ...proj, midi: mine } : proj;
  }, []);

  const restore = useCallback((uid: number, raw: unknown) => {
    const p = normalizeMidiProject(raw);
    byDoc.current.set(uid, p);
    hist.current.delete(uid);
    if (uid === activeUidRef.current) {
      owner.current = uid;
      projectRef.current = p;
      setProject(p);
    }
    bump();
  }, []);

  const drop = useCallback((uid: number) => {
    byDoc.current.delete(uid);
    hist.current.delete(uid);
    bump();
  }, []);

  return {
    ctl, withMidi, restore, drop, undo, redo,
    canUndo: ctl.canUndo, canRedo: ctl.canRedo,
  };
};

/** 播放头现在第几拍 —— 标尺与卷帘共用（别各写一遍换算）。 */
export const beatNow = (tempo: number): number => secondsToBeat(clock.seconds(), tempo);
