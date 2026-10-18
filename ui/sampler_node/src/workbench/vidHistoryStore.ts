import { useEffect, useState } from 'react';

// Video 工程的撤销步 —— **面板这一侧的只读投影**。
//
// 步子本身住在宿主（EditPhase 的 vidHist：每个文档一支 undo/redo 摞），因为工程数据就在那里；
// 而 History 那一格是**页面**渲染的，它只认识页面自己那两支摞。两边于是靠这份小 store 接上：
// 面板里先排页面的图层步、再把视频步接在后面（下标连续，页面那套 `history-jump` 的算法仍然只需要
// 一个数），点视频那一段时由 `jumpVidHistory` 交回宿主处理 —— 页面根本不认识那些下标。
//
// 这里不存工程本身：几十兆的工程快照留在宿主的摞里，面板只要名字。
export type VidHistStep = { label: string };

type View = { steps: VidHistStep[]; canUndo: boolean; canRedo: boolean };

let view: View = { steps: [], canUndo: false, canRedo: false };
const subs = new Set<() => void>();
let jumpFn: ((localIndex: number) => void) | null = null;

export const getVidHistory = (): View => view;

export function setVidHistoryView(next: View): void {
  // 引用与三个字段都没变就不通知：宿主那边每次 update 都会推一份，别把面板拖着一起重渲。
  if (next === view) return;
  if (next.canUndo === view.canUndo && next.canRedo === view.canRedo && next.steps === view.steps) return;
  view = next;
  subs.forEach(f => f());
}

/** 面板点视频段第 i 行时回到宿主去跳。宿主不在（组件卸载）时是空操作。 */
export const setVidHistoryJump = (fn: ((localIndex: number) => void) | null): void => { jumpFn = fn; };
export const jumpVidHistory = (localIndex: number): void => { jumpFn?.(localIndex); };

export const useVidHistory = (): View => {
  const [v, setV] = useState<View>(view);
  useEffect(() => {
    const fn = () => setV(view);
    subs.add(fn);
    fn();
    return () => { subs.delete(fn); };
  }, []);
  return v;
};
