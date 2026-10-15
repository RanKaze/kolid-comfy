import { useEffect, useState } from 'react';
import { type BlendUi, EMPTY_BLEND_UI } from '../types';

// 工作台面板的状态住在这里，不住 React 的树里。
// 理由只有一个：拖动中的读数（Transform 的 X/Y/W/H/R、View 的缩放角）每帧都在变，而画布单元和
// EditPhase 整页都不该跟着每帧重绘一次。页面每帧最多播一条 `blend-ui`，快照换掉时只点动订阅了
// 这份快照的那几个小单元。
let snapshot: BlendUi = EMPTY_BLEND_UI;
const subs = new Set<() => void>();

export const getBlendUi = (): BlendUi => snapshot;

export function setBlendUi(next: BlendUi): void {
  // 引用相同就是页面那条 JSON 等值闸已经拦下了：不换、不通知。
  if (next === snapshot) return;
  snapshot = next;
  subs.forEach(fn => fn());
}

export const useBlendUi = (): BlendUi => {
  const [ui, setUi] = useState<BlendUi>(snapshot);
  useEffect(() => {
    const fn = () => setUi(snapshot);
    subs.add(fn);
    // 挂载与订阅之间可能正好换过一次快照，补读一次，否则这一格会停在旧的读数上。
    fn();
    return () => { subs.delete(fn); };
  }, []);
  return ui;
};
