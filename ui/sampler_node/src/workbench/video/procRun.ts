import React from 'react';

// 视频 list 跑（Processor 的 Allow List 那条路）的**文字**播报。
// 写方只有 EditPhase（宿主发起的那一趟），读方只有 Processor 窗 —— 走模块级 store 而不是
// BlendUi 快照：Blend 页不知道视频这条路，这条文字也不该让整页跟着重渲。
// 进度条与 Cancel 不在这里：它们就是**原本的那一套**（BlendUi 快照 staging 段 + staging-cancel，
// 见 RunStatusSeg / App 的 blend-ui 合流）。视频这趟跑起来时，EditPhase 把 busy/cancelLive/
// progress 写进同一个快照段，标题条那条原样亮起来；vidStagingOverlay 是给 App 的 push 合流用的
// —— 页面在跑动期间推来的快照不许把 run 的状态冲掉。
export type VidProcRun = { state: 'idle' | 'running' | 'done' | 'error' | 'cancelled'; msg: string };

/** 视频 list 跑在飞时的快照覆盖：App 收到页面 push 合流 staging 段时按它盖 busy/cancelLive/progress。 */
export const vidStagingOverlay = { busy: false, progress: -1 };

let cur: VidProcRun = { state: 'idle', msg: '' };
const subs = new Set<() => void>();

export const getVidProcRun = (): VidProcRun => cur;

export const setVidProcRun = (next: VidProcRun): void => {
  if (next.state === cur.state && next.msg === cur.msg) return;
  cur = next;
  subs.forEach(fn => fn());
};

export const useVidProcRun = (): VidProcRun => {
  const [v, setV] = React.useState(cur);
  React.useEffect(() => {
    const fn = () => setV(cur);
    subs.add(fn);
    fn();                     // 挂载与订阅之间可能正好换过一次，补读
    return () => { subs.delete(fn); };
  }, []);
  return v;
};

// ── 占位段的"填充"进度 ────────────────────────────────────────────────────────────────────
// 段在跑的时候，时间线上那个占位段自己也要有进度 —— 从左往右被充满（紫色）。按 clipId 记，
// 走模块级小仓库：进度每 500ms 才动一步、命中的占位段通常一两个，订阅者自己重渲就够，
// 不值得惊动工程 state。0..1 = 段内步进；-1 = 还没报出步数（画一窄条意思一下）。
// 跑完（被替换）或失败/取消即清 —— 占位回到"待跑"的样子。
const fills = new Map<string, number>();
const fillSubs = new Set<() => void>();
const bumpFill = () => fillSubs.forEach(fn => fn());

export const setProcFill = (clipId: string, v: number): void => {
  if (v < 0) {
    if (!fills.has(clipId)) return;
    fills.delete(clipId);
  } else {
    const nv = Math.max(0, Math.min(1, v));
    if (fills.get(clipId) === nv) return;
    fills.set(clipId, nv);
  }
  bumpFill();
};

export const clearProcFill = (clipId: string): void => { if (fills.delete(clipId)) bumpFill(); };

export const getProcFill = (clipId: string): number => fills.get(clipId) ?? -1;

export const subscribeProcFill = (fn: () => void): (() => void) => {
  fillSubs.add(fn);
  return () => { fillSubs.delete(fn); };
};

// ── 占位段队列 ────────────────────────────────────────────────────────────────────────────────
// 多选 ▶ 排出来的那一队：queued = 还没轮到跑的段（**不含**正在跑的那颗 —— 它有 fills 进度）。
// 时间线按它画 ⏸（点一下退出队列）；批次循环每轮都问一句「这段还在队里吗」，被移出的直接跳过。
// 与 fills 同一套口径：模块级小仓库，只让订阅者重渲，不惊动工程 state。
export type ProcQueue = { queued: readonly string[] };

let queue: ProcQueue = { queued: [] };
const queueSubs = new Set<() => void>();

export const getProcQueue = (): ProcQueue => queue;

export const subscribeProcQueue = (fn: () => void): (() => void) => {
  queueSubs.add(fn);
  return () => { queueSubs.delete(fn); };
};

const setQueue = (ids: readonly string[]): void => {
  const next = [...new Set(ids)];
  if (next.length === queue.queued.length && next.every((id, i) => queue.queued[i] === id)) return;
  queue = { queued: next };
  queueSubs.forEach(fn => fn());
};

/** 批次开跑前把整条队摆出来（顺序 = 实际要跑的顺序）。 */
export const setProcQueue = (ids: readonly string[]): void => setQueue(ids);

/** 一段被移出队列（⏸ 或已经开始跑）—— 批次循环见到它不在队里就跳过。 */
export const dequeueProcClip = (clipId: string): void =>
  setQueue(queue.queued.filter(id => id !== clipId));

export const isProcQueued = (clipId: string): boolean => queue.queued.includes(clipId);

export const clearProcQueue = (): void => setQueue([]);
