import { useEffect, useState } from 'react';

// 图层编辑的门闸：**视频模式下没选中 Layer 段时，Layers / Guidances 不许动手**。
//
// 为什么是一颗全局小闸而不是 props：这两个面板的动作条（Clear All / Add / 总开关）住在
// `StackHead` 里，而它同时被 Layers 与 Guidances 两格使用 —— 一个状态、两处生效。
// 门闸的判据只有宿主知道（当前是哪个模式、有没有选中段），所以由 EditPhase 推过来。
let blocked = false;
const subs = new Set<() => void>();

export const isLayerEditBlocked = (): boolean => blocked;

export function setLayerEditBlocked(next: boolean): void {
  if (next === blocked) return;
  blocked = next;
  subs.forEach(f => f());
}

export const useLayerEditBlocked = (): boolean => {
  const [v, setV] = useState(blocked);
  useEffect(() => {
    const fn = () => setV(blocked);
    subs.add(fn);
    fn();
    return () => { subs.delete(fn); };
  }, []);
  return v;
};
