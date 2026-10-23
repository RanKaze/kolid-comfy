import { useSyncExternalStore } from 'react';
import { getActiveBlendUid, subscribeBlendActive } from '../store';

// 视频模式下 Processor 每一行的**源 / 去处**挑选。视频工程住在宿主 —— Blend 页那张
// processorSel 只认图像模式的源表（Layers / Sel. Layer / Staging），把视频的挑选值回拼
// 进去只会被它当垃圾，所以这一份独立住在宿主、由 Processor 窗直接读写（不经 iframe）。
// 键 = 端口号字符串。缺省：输入 tracks、输出 new_track；轨道 / 资产的具体条目在显示与
// 开跑时各兜底一次（store 里不存派生值）。
//
// 按活跃文档分桶（拍板②）：挑选值引用的是轨道 / 资产 id，那是各文档自己的名字 —— A 里挑的
// 轨道在 B 里不存在。挑选只在活跃文档读写（Processor 窗只对着活跃文档，跑也是从活跃文档发起），
// 所以读写都走 getActiveBlendUid()，切 tab 那一刻换桶重发。
export type VidProcSrc = 'tracks' | 'sel_track' | 'asset';
export type VidProcDst = 'new_track' | 'asset';

export type VidProcPicks = {
  /** 输入行：port -> 源种类。 */
  src: Record<string, VidProcSrc>;
  /** 输入行（sel_track）：port -> 视频轨 id。 */
  track: Record<string, string>;
  /** 输入行（asset）：port -> 视频资产 id。 */
  asset: Record<string, string>;
  /** 输出行：port -> 去处。 */
  dst: Record<string, VidProcDst>;
};

const EMPTY: VidProcPicks = { src: {}, track: {}, asset: {}, dst: {} };
const byDoc = new Map<number, VidProcPicks>();
const subs = new Set<() => void>();
const emit = () => subs.forEach(fn => fn());
const subscribe = (fn: () => void) => {
  subs.add(fn);
  const off = subscribeBlendActive(emit);
  return () => { subs.delete(fn); off(); };
};

export const getVidProcPicks = (): VidProcPicks => {
  const u = getActiveBlendUid();
  return (u !== null ? byDoc.get(u) : undefined) ?? EMPTY;
};

const setIn = <K extends keyof VidProcPicks>(key: K, port: number, v: VidProcPicks[K][string]) => {
  const u = getActiveBlendUid();
  if (u === null) return;
  const cur = byDoc.get(u) ?? EMPTY;
  byDoc.set(u, { ...cur, [key]: { ...cur[key], [String(port)]: v } });
  emit();
};

export const setVidProcSrc = (port: number, v: VidProcSrc): void => setIn('src', port, v);
export const setVidProcTrack = (port: number, id: string): void => setIn('track', port, id);
export const setVidProcAsset = (port: number, id: string): void => setIn('asset', port, id);
export const setVidProcDst = (port: number, v: VidProcDst): void => setIn('dst', port, v);

/** 文档关掉：桶一起收走（App 的 blend-docs 清理口）。 */
export const dropVidProcPicks = (uid: number): void => {
  if (byDoc.delete(uid) && uid === getActiveBlendUid()) emit();
};

export const useVidProcPicks = (): VidProcPicks =>
  useSyncExternalStore(subscribe, getVidProcPicks, getVidProcPicks);
