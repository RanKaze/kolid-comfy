import { useEffect, useState } from 'react';
import { type BlendDocAsset, type BlendDocAssets, EMPTY_BLEND_DOC_ASSETS } from '../types';
import { getActiveBlendUid, subscribeBlendActive } from './store';

// ── 文档内嵌的图（Assets 窗的 Video / Image 两档）────────────────────────────────────────
// A4 起图像**内嵌**在 .cud 里（文档是权威，仓库那份是载入时落下的缓存）。所以"这份文档有哪些图"
// 只有工作台页面答得出 —— 它按用途把引用分成两份交过来：image（主图层栈 + 图池）与 video（每个
// Layer 段的图层集）。宿主这侧只做三件事：按文档 uid 分桶、防脏数据、切 tab 时换桶。
//
// 为什么分桶：页面只播活跃文档，切走的那一份的清单是它在**离开时**的样子 —— 和 blend-ui 快照
// 同一套规矩。切回来不必等页面重播，Assets 窗第一帧就是对的。
//
// 为什么不是"再去下拉一次 /api/global_assets"：那两份说的是文件里的图，不是仓库里有什么。
// 仓库是缓存，可以缺（缺了卡片标 MISSING，字节还在文件里，重存一次就回来）。

const buckets = new Map<number, BlendDocAssets>();
const subs = new Set<() => void>();

const ROLES = new Set<BlendDocAsset['role']>(['layer', 'guidance', 'staging']);

const num = (v: unknown): number =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);

function normRow(v: unknown): BlendDocAsset | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const hash = typeof o.hash === 'string' ? o.hash : '';
  if (!hash) return null;
  const role = (typeof o.role === 'string' && ROLES.has(o.role as BlendDocAsset['role'])
    ? o.role : 'layer') as BlendDocAsset['role'];
  return {
    hash,
    role,
    setKey: typeof o.setKey === 'string' ? o.setKey : '',
    id: Number.isInteger(o.id) ? (o.id as number) : 0,
    name: typeof o.name === 'string' && o.name ? o.name : hash.slice(0, 8),
    w: num(o.w),
    h: num(o.h),
  };
}

const rows = (v: unknown): BlendDocAsset[] =>
  (Array.isArray(v) ? v.map(normRow).filter((x): x is BlendDocAsset => !!x) : []);

/** 页面的播报 → 一份清单。跨 iframe 的边界，所以逐格取值；读不出来的当没说过。 */
export function parseDocAssets(d: unknown): BlendDocAssets {
  const o = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
  return {
    uid: Number.isInteger(o.uid) ? (o.uid as number) : null,
    image: rows(o.image),
    video: rows(o.video),
  };
}

const sameRows = (a: readonly BlendDocAsset[], b: readonly BlendDocAsset[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.hash !== y.hash || x.role !== y.role || x.setKey !== y.setKey || x.id !== y.id
      || x.name !== y.name || x.w !== y.w || x.h !== y.h) return false;
  }
  return true;
};

/** 收下一条播报。清单没变就一个字节都不惊动（页面那边已经按整份清单去过重，这里是第二道闸：
 *  组件重渲不该由一次等值播报引起）。 */
export function setDocAssets(next: BlendDocAssets): void {
  if (next.uid === null) return;
  const prev = buckets.get(next.uid);
  if (prev && sameRows(prev.image, next.image) && sameRows(prev.video, next.video)) return;
  buckets.set(next.uid, next);
  subs.forEach(fn => fn());
}

/** 活跃文档的那一份（没有文档 / 还没播报 = 空清单，永远不是 null：窗里少一层判断）。 */
export const getDocAssets = (): BlendDocAssets => {
  const uid = getActiveBlendUid();
  return (uid === null ? undefined : buckets.get(uid)) ?? EMPTY_BLEND_DOC_ASSETS;
};

export const getDocAssetsOf = (uid: number | null): BlendDocAssets =>
  (uid === null ? undefined : buckets.get(uid)) ?? EMPTY_BLEND_DOC_ASSETS;

/** 文档关掉了：清单一起收走（uid 每次开机从 1 重发，旧桶留着会撞号）。 */
export const dropDocAssets = (uid: number): void => {
  if (buckets.delete(uid)) subs.forEach(fn => fn());
};

export function useDocAssets(): BlendDocAssets {
  const [v, setV] = useState<BlendDocAssets>(getDocAssets);
  useEffect(() => {
    const fn = () => setV(getDocAssets());
    subs.add(fn);
    const off = subscribeBlendActive(fn);
    fn();                    // 挂载与订阅之间可能正好换过文档：补读一次
    return () => { subs.delete(fn); off(); };
  }, []);
  return v;
}
