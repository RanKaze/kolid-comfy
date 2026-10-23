import { useEffect, useState } from 'react';
import { type BlendUi, EMPTY_BLEND_UI } from '../types';

// 工作台面板的状态住在这里，不住 React 的树里。
// 理由只有一个：拖动中的读数（Transform 的 X/Y/W/H/R、View 的缩放角）每帧都在变，而画布单元和
// EditPhase 整页都不该跟着每帧重绘一次。页面每帧最多播一条 `blend-ui`，快照换掉时只点动订阅了
// 这份快照的那几个小单元。
//
// 快照按**文档**分桶（uid 是页面在快照里自己盖的章）。单槽时代后台文档在宿主侧没有任何留影，
// 切 tab 的那一瞬面板只能等页面重推；分桶之后每一格显示的是目标文档**离开时**的那一份快照 ——
// activeUid 是唯一的投影选择器，setBlendActiveUid 由 blend-docs 播报驱动。
const buckets = new Map<number, BlendUi>();
let activeUid: number | null = null;
const subs = new Set<() => void>();

export const getActiveBlendUid = (): number | null => activeUid;

export const setBlendActiveUid = (uid: number | null): void => {
  if (uid === activeUid) return;
  activeUid = uid;
  subs.forEach(fn => fn());
};

// 活跃文档的投影（面板都读这一份）；指定 uid 读某一桶（faces 合并要对 incoming 的桶，不是活跃桶）。
export const getBlendUi = (): BlendUi =>
  (activeUid !== null ? buckets.get(activeUid) : undefined) ?? EMPTY_BLEND_UI;
export const getBlendUiOf = (uid: number): BlendUi => buckets.get(uid) ?? EMPTY_BLEND_UI;

export function setBlendUi(uid: number, next: BlendUi): void {
  // 引用相同就是页面那条 JSON 等值闸已经拦下了：不换、不通知。
  if (buckets.get(uid) === next) return;
  buckets.set(uid, next);
  // 后台文档的快照只进桶不点灯：页面只推活跃文档，等它切回来时那一桶就是现成的留影。
  if (uid === activeUid) subs.forEach(fn => fn());
}

export const dropBlendUi = (uid: number): void => {
  if (buckets.delete(uid) && uid === activeUid) subs.forEach(fn => fn());
};

/** 活跃文档换了人（含切走/切回/关光）的订阅口，不带快照载荷。按活跃文档取数的旁路 store
 *  （procRun / procPicks）靠它在切 tab 那一刻重发一遍自己的读数，不然面板会停在上一份上。 */
export const subscribeBlendActive = (fn: () => void): (() => void) => {
  subs.add(fn);
  return () => { subs.delete(fn); };
};

export const useBlendUi = (): BlendUi => {
  const [ui, setUi] = useState<BlendUi>(getBlendUi());
  useEffect(() => {
    const fn = () => setUi(getBlendUi());
    subs.add(fn);
    // 挂载与订阅之间可能正好换过一次快照/活跃桶，补读一次，否则这一格会停在旧的读数上。
    fn();
    return () => { subs.delete(fn); };
  }, []);
  return ui;
};
