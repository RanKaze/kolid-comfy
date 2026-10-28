import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { getActiveBlendUid, subscribeBlendActive } from './store';

// ── 换 .cud 的宿主侧契约 ─────────────────────────────────────────────────────────────────
// 一次"换文档"（点另一颗 tab / 新开 / 载入 / 关掉最后一份）从来不只是一扇窗的事：每一扇 dock 窗
// 手里都攥着一点**只属于某一份工程**的东西 —— 时间线的选中、图池的多选、Inspector 指着的那张
// 资产、预览桶里那张图、播放器"这一份已经画出第一帧了没"…… 从前这些各写各的
// `useEffect(..., [activeUid])`，谁漏一手，那扇窗就把上一份的读数带到下一份上：选中了不存在的段、
// 按"删除选中"删掉的是新工程里同一个哈希的资产、Inspector 对着别人的图说话。症状千奇百怪，
// 根子只有一个 —— **没有人对"换文档"这件事负责**。
//
// 这个文件就是那个人。两条用法，按窗里那点状态的形状挑一条：
//
//   1. 状态该按文档留影（切回去还在、切走不串）⇒ `useCudState`：
//         const [sel, setSel] = useCudState(() => new Set<string>());
//      它自己按 uid 分桶，换文档 = 换一桶。窗口里**不需要写任何切换代码**，也就没得写漏。
//
//   2. 换文档时要做的动作（清缓存、作废在飞的请求、把上一份收尾）⇒ `useCudScope`：
//         useCudScope('video:selection', { leave: () => setVidSelection(new Set()) });
//
// 两种都由宿主（EditPhase 里那唯一一处 blendDocs.activeUid 的变化）驱动：`runCudSwitch` 先跑
// 所有 leave（旧文档还在，还能拍照、还能把它的状态写回桶），再跑所有 enter（新文档已就位）。
// 一扇窗抛错不会拦下别人的切换 —— 那正是"统一管理"要的：一扇写坏了，别的窗照样换干净，控制台
// 点名是谁。
//
// 边界：像素级的交接不在这里。台上那一帧归谁、新文档没画完之前显示什么，是工作台页面
// （blend_node.html 的 `stageOwnUid` / `swapPendingUid`）的事；宿主这侧管的是**窗里的状态**。

export type CudDoc = { uid: number; name: string; path?: string | null };

/** 一次换文档，两个阶段共用的同一份事实。`from`/`to` 为 null = 那一头没有文档。 */
export type CudSwitch = {
  from: number | null;
  to: number | null;
  /** `to` 那一条的播报（名字 / 路径）。没有文档时是 null。 */
  doc: CudDoc | null;
};

export type CudHandlers = {
  /** 旧文档还在的时候跑：它的桶还没被覆盖，页面那头也还没换人。 */
  leave?: (s: CudSwitch) => void;
  /** 新文档已经就位（宿主侧的 activeUid 已翻过、Video 工程已装回）。 */
  enter?: (s: CudSwitch) => void;
};

export type CudScope = CudHandlers & { id: string };

const scopes: CudScope[] = [];
let lastSwitch: CudSwitch | null = null;
let switchCount = 0;
let running = false;

/** 登记一扇窗的切换动作。返回注销函数（窗卸载时调）。id 只为诊断，重复登记会点名。 */
export function registerCudScope(scope: CudScope): () => void {
  if (scopes.some(x => x.id === scope.id)) {
    console.warn(`[cud] scope id "${scope.id}" registered twice — both run, diagnostics can no longer tell them apart`);
  }
  scopes.push(scope);
  return () => {
    const i = scopes.lastIndexOf(scope);
    if (i >= 0) scopes.splice(i, 1);
  };
}

/** 窗的用法：给个名字和两支动作，登记/注销自己跟着组件生命周期走。闭包每帧都取最新的。 */
export function useCudScope(id: string, handlers: CudHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => registerCudScope({
    id,
    leave: s => ref.current.leave?.(s),
    enter: s => ref.current.enter?.(s),
  }), [id]);
}

function fire(scope: CudScope, phase: 'leave' | 'enter', s: CudSwitch): void {
  const fn = scope[phase];
  if (!fn) return;
  try {
    fn(s);
  } catch (e) {
    // 一扇窗的错不该变成"别的窗停在上一份上"。点名，然后继续。
    console.warn(`[cud] ${scope.id}.${phase} threw — the rest of the switch still runs`, e);
  }
}

/**
 * 跑完一次换文档。**只由宿主调**（EditPhase 里 activeUid 的那一个 effect），一口气跑完：
 *   先 leave（逆登记序，像卸载那样从最里面往外套）→ 再 enter（正登记序）。
 * 两个阶段之间没有任何 await：leave 跑完时旧文档的桶还没被动过。
 */
export function runCudSwitch(s: CudSwitch): void {
  if (running) {
    console.warn('[cud] a switch is already running — this one is ignored', s);
    return;
  }
  running = true;
  lastSwitch = s;
  switchCount++;
  try {
    for (let i = scopes.length - 1; i >= 0; i--) fire(scopes[i], 'leave', s);
    for (let i = 0; i < scopes.length; i++) fire(scopes[i], 'enter', s);
  } finally {
    running = false;
  }
}

// ── 按文档分桶的窗口状态 ─────────────────────────────────────────────────────────────────
// 桶挂在模块上（不在组件里）：窗可能被折叠/重挂，而"这份文档里选中的是哪几段"不该跟着 DOM 走。
// 键 = useId()（同一颗窗的稳定身份）+ 文档 uid；`pruneCudState` 由宿主在文档关掉时收走死桶
// （uid 每次开机从 1 重发，旧桶留着会在下一次撞号时冒出来）。
const bucketsByWindow = new Map<string, Map<string, unknown>>();
const NONE = '\u0000no-doc';

/**
 * 一点"该属于某份工程"的本地状态。换文档 = 换一桶：切走时它留下的那桶原地不动，切回来原样
 * 还在；新文档从 `init()` 起手，永远看不到上一份的 id。
 */
export function useCudState<T>(init: () => T): [T, (next: T | ((prev: T) => T)) => void] {
  const inst = useId();
  const uid = useSyncExternalStore(subscribeBlendActive, getActiveBlendUid, getActiveBlendUid);
  const key = uid === null ? NONE : String(uid);
  let buckets = bucketsByWindow.get(inst);
  if (!buckets) { buckets = new Map(); bucketsByWindow.set(inst, buckets); }
  const [cur, setCur] = useState<{ k: string; v: T }>(() => {
    if (!buckets!.has(key)) buckets!.set(key, init());
    return { k: key, v: buckets!.get(key) as T };
  });
  // 换了一桶就当场纠偏（React 的派生 state 写法）：这一帧渲染的就是新桶，不闪一帧旧值 ——
  // 闪那一帧正是"切过去看见上一份选中/上一份读数"的来源。
  let view = cur;
  if (cur.k !== key) {
    if (!buckets.has(key)) buckets.set(key, init());
    view = { k: key, v: buckets.get(key) as T };
    setCur(view);
  }
  const set = useCallback((next: T | ((prev: T) => T)) => {
    setCur(prev => {
      const v = typeof next === 'function' ? (next as (p: T) => T)(prev.v) : next;
      buckets!.set(key, v);
      return { k: key, v };
    });
  }, [key, buckets]);
  // 窗卸载 = 它的桶全作废（不卸载的窗由 pruneCudState 按开着的文档集收）。
  useEffect(() => () => { bucketsByWindow.delete(inst); }, [inst]);
  return [view.v, set];
}

/** 文档关掉了：把已经不在开着的那些桶收走。宿主在文档集变化时调一次。 */
export function pruneCudState(open: readonly number[]): void {
  const live = new Set(open.map(String));
  for (const buckets of bucketsByWindow.values()) {
    for (const k of [...buckets.keys()]) if (!live.has(k)) buckets.delete(k);
  }
}

/** 诊断：现在挂着哪些窗、各自有没有两头，以及最近一次换文档。探针与自检读它。 */
export const cudScopeReport = (): { scopes: { id: string; leave: boolean; enter: boolean }[];
  last: CudSwitch | null; count: number } => ({
  scopes: scopes.map(s => ({ id: s.id, leave: !!s.leave, enter: !!s.enter })),
  last: lastSwitch,
  count: switchCount,
});
