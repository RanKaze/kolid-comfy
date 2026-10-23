import React from 'react';
import { getActiveBlendUid, subscribeBlendActive } from '../store';

// 视频 list 跑（Processor 的 Allow List 那条路）的**文字**播报 + 占位段进度 + 队列 + 快照覆盖。
// 写方只有 EditPhase（宿主发起的那一趟），读方是 Processor 窗 / Timeline —— 走模块级 store 而不是
// BlendUi 快照：Blend 页不知道视频这条路，这些读数也不该让整页跟着重渲。
// 进度条与 Cancel 不在这里：它们就是**原本的那一套**（BlendUi 快照 staging 段 + staging-cancel，
// 见 RunStatusSeg / App 的 blend-ui 合流）。视频这趟跑起来时，EditPhase 把 busy/cancelLive/
// progress 写进同一个快照段，标题条那条原样亮起来；overlay 是给 App 的 push 合流用的 —— 页面在
// 跑动期间推来的快照不许把 run 的状态冲掉。
//
// 一切按**文档**分桶（拍板②）：读侧一律取活跃文档的桶；写侧在跑动期间落 `beginVidProcRun`
// 钉住的发起文档（runUid）—— 跑在飞时用户切走再看别家，进度不许写进别家的桶。四个入口
// （begin）与四个收尾（end）跟 vidProcBusy 一一配对，见 EditPhase。
export type VidProcRun = { state: 'idle' | 'running' | 'done' | 'error' | 'cancelled'; msg: string };

const EMPTY_RUN: VidProcRun = { state: 'idle', msg: '' };

let runUid: number | null = null;
export const beginVidProcRun = (uid: number | null): void => { runUid = uid; };
export const endVidProcRun = (): void => { runUid = null; };
/** 写侧作用域：跑动期间归发起文档，其余归活跃文档。 */
const wuid = (): number | null => runUid ?? getActiveBlendUid();

// ── run 文字 ─────────────────────────────────────────────────────────────────────────────
const runs = new Map<number, VidProcRun>();
const subs = new Set<() => void>();
const emit = () => subs.forEach(fn => fn());

export const getVidProcRun = (): VidProcRun => {
  const u = getActiveBlendUid();
  return (u !== null ? runs.get(u) : undefined) ?? EMPTY_RUN;
};

export const setVidProcRun = (next: VidProcRun): void => {
  const u = wuid();
  if (u === null) return;
  const cur = runs.get(u);
  if (cur && cur.state === next.state && cur.msg === next.msg) return;
  runs.set(u, next);
  if (u === getActiveBlendUid()) emit();
};

export const useVidProcRun = (): VidProcRun => {
  const [v, setV] = React.useState(getVidProcRun());
  React.useEffect(() => {
    const fn = () => setV(getVidProcRun());
    subs.add(fn);
    const off = subscribeBlendActive(fn);   // 切文档那一刻把新桶的读数推给面板
    fn();                                   // 挂载与订阅之间可能正好换过一次，补读
    return () => { subs.delete(fn); off(); };
  }, []);
  return v;
};

// ── 占位段的"填充"进度 ────────────────────────────────────────────────────────────────────
// 段在跑的时候，时间线上那个占位段自己也要有进度 —— 从左往右被充满（紫色）。按 (uid, clipId) 记，
// 订阅者自己重渲就够，不值得惊动工程 state。0..1 = 段内步进；-1 = 还没报出步数（画一窄条意思一下）。
// 跑完（被替换）或失败/取消即清 —— 占位回到"待跑"的样子。
const fillMaps = new Map<number, Map<string, number>>();
const fillSubs = new Set<() => void>();
const bumpFill = () => fillSubs.forEach(fn => fn());

export const setProcFill = (clipId: string, v: number): void => {
  const u = wuid();
  if (u === null) return;
  let m = fillMaps.get(u);
  if (v < 0) {
    if (!m?.has(clipId)) return;
    m!.delete(clipId);
  } else {
    const nv = Math.max(0, Math.min(1, v));
    if (m?.get(clipId) === nv) return;
    if (!m) { m = new Map(); fillMaps.set(u, m); }
    m.set(clipId, nv);
  }
  bumpFill();
};

export const clearProcFill = (clipId: string): void => {
  const u = wuid();
  if (u !== null && fillMaps.get(u)?.delete(clipId)) bumpFill();
};

export const getProcFill = (clipId: string): number => {
  const u = getActiveBlendUid();
  return (u !== null ? fillMaps.get(u)?.get(clipId) : undefined) ?? -1;
};

export const subscribeProcFill = (fn: () => void): (() => void) => {
  fillSubs.add(fn);
  const off = subscribeBlendActive(bumpFill);
  return () => { fillSubs.delete(fn); off(); };
};

// ── 占位段队列 ────────────────────────────────────────────────────────────────────────────────
// 多选 ▶ 排出来的那一队：queued = 还没轮到跑的段（**不含**正在跑的那颗 —— 它有 fills 进度）。
// 时间线按它画 ⏸（点一下退出队列）；批次循环每轮都问一句「这段还在队里吗」，被移出的直接跳过。
export type ProcQueue = { queued: readonly string[] };

const EMPTY_QUEUE: ProcQueue = { queued: [] };
const queues = new Map<number, ProcQueue>();
const queueSubs = new Set<() => void>();

export const getProcQueue = (): ProcQueue => {
  const u = getActiveBlendUid();
  return (u !== null ? queues.get(u) : undefined) ?? EMPTY_QUEUE;
};

export const subscribeProcQueue = (fn: () => void): (() => void) => {
  queueSubs.add(fn);
  const off = subscribeBlendActive(() => queueSubs.forEach(f => f()));
  return () => { queueSubs.delete(fn); off(); };
};

const setQueue = (ids: readonly string[]): void => {
  const u = wuid();
  if (u === null) return;
  const next = [...new Set(ids)];
  const cur = queues.get(u)?.queued ?? EMPTY_QUEUE.queued;
  if (next.length === cur.length && next.every((id, i) => cur[i] === id)) return;
  queues.set(u, { queued: next });
  if (u === getActiveBlendUid()) queueSubs.forEach(fn => fn());
};

/** 批次开跑前把整条队摆出来（顺序 = 实际要跑的顺序）。 */
export const setProcQueue = (ids: readonly string[]): void => setQueue(ids);

/** 一段被移出队列（⏸ 或已经开始跑）—— 批次循环见到它不在队里就跳过。 */
export const dequeueProcClip = (clipId: string): void =>
  setQueue((getProcQueue().queued).filter(id => id !== clipId));

export const isProcQueued = (clipId: string): boolean => getProcQueue().queued.includes(clipId);

export const clearProcQueue = (): void => setQueue([]);

// ── 快照覆盖（App 合流 staging 段用）───────────────────────────────────────────────────────
/** 视频 list 跑在飞时的快照覆盖：App 收到页面 push 合流 staging 段时按它盖 busy/cancelLive/progress。
 *  按发起文档的桶取（App 按**来的快照的 uid**问，不是活跃 uid —— 跑在 A 时 B 的快照不该被盖）。 */
export type VidStagingOverlay = { busy: boolean; progress: number };

const overlays = new Map<number, VidStagingOverlay>();

export const getVidStagingOverlay = (uid: number): VidStagingOverlay =>
  overlays.get(uid) ?? { busy: false, progress: -1 };

export const setVidStagingOverlay = (patch: Partial<VidStagingOverlay>): void => {
  const u = wuid();
  if (u === null) return;
  overlays.set(u, { ...getVidStagingOverlay(u), ...patch });
};

/** 文档关掉：连桶带读数一起收走（App 的 blend-docs 清理口）。 */
export const dropVidProcState = (uid: number): void => {
  const had = runs.delete(uid) || fillMaps.delete(uid) || queues.delete(uid) || overlays.delete(uid);
  if (uid === getActiveBlendUid() && had) { emit(); bumpFill(); queueSubs.forEach(fn => fn()); }
};
