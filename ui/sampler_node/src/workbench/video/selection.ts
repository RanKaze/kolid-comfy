// ── 时间线选中态,跨窗共享 ────────────────────────────────────────────────────────────────────
// Timeline 的多选是自己组件里的 state;Video Generator 窗的 "Add continue segment" 需要
// 知道"此刻选中了哪段"才能起效。选中态提升成这一口极小的外部 store:Timeline 每次变化
// 写一份快照进来,别的窗用 useSyncExternalStore 读 —— 谁也不持有谁的实例。

let sel: ReadonlySet<string> = new Set<string>();
const subs = new Set<() => void>();

export const getVidSelection = (): ReadonlySet<string> => sel;
export const subscribeVidSelection = (fn: () => void): (() => void) => {
  subs.add(fn);
  return () => { subs.delete(fn); };
};
export const setVidSelection = (next: ReadonlySet<string>): void => {
  if (next.size === sel.size && [...next].every(id => sel.has(id))) return;
  sel = next;
  subs.forEach(f => f());
};
