// ── 关键帧录制臂,跨组件共享 ──────────────────────────────────────────────────────────────────
// Tracks 左上角那颗红钮的开关。曾经挂在 EditPhase 的 state 上、经控制器 props 下发 —— 但
// Timeline 子树对它的重渲传播有蹊跷(setter 调了、props 半天不更新)。改成这口极小的外部
// store:按钮与录制回路各自 useSyncExternalStore/直接读,谁也不依赖谁的重渲。

let armed = false;
const subs = new Set<() => void>();

export const getKfArmed = (): boolean => armed;
export const subscribeKfArmed = (fn: () => void): (() => void) => {
  subs.add(fn);
  return () => { subs.delete(fn); };
};
export const setKfArmed = (v: boolean): void => {
  if (armed === v) return;
  armed = v;
  subs.forEach(f => f());
};
