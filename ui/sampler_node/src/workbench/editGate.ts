import { useEffect, useState } from 'react';

// 图层编辑的门闸：**视频模式下游标不在 Layer 段上时，Layers / Guidances / Transform 不许动手**。
// （这时画布内容是视频底片，背后那一套图层并不显示，改了也看不见。）
//
// 为什么是一颗全局小闸而不是 props：这几格的动作条住在宿主 dock 里，判据只有宿主知道
// （当前是哪个模式、游标压在哪个 Layer 段上），所以由 EditPhase 推过来。
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
