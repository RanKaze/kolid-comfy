/**
 * Agent 操作的**提示性高亮** —— 一次脉冲，不是状态。
 *
 * 为什么单独一个 store：MCP 调用落在 `runAgentTool`（agent/tools.ts），而"哪扇窗该亮"由
 * dock 的 DOM 决定（`dock/DockView.tsx` 渲染）。两者隔着一整棵组件树，中间放一个 20 行的
 * pub/sub 比把 ctx 一路传下去便宜得多，也不会让 dock 为了 agent 多一个必填 prop。
 *
 * 三条纪律：
 *  1. **只提示，不改状态**。没有持久化、不进历史、不影响 .cud；不看也什么都不缺。
 *  2. **不叠框**。同一个窗连点两次只是把动画重跑一遍（换时间戳），不是两个框套在一起。
 *  3. **找不到窗就什么都不画**。面板被关掉时静默 —— 高亮缺席不是错误，不该冒泡成失败。
 */
import { useSyncExternalStore } from 'react';

/** 一次脉冲：哪扇窗、什么时候、因为什么（label 只进 title，不画在脸上）。 */
export type AgentHit = { unit: string; at: number; label: string };

/** 淡入 + 停留 + 淡出的总时长。太短看不见，太长会盖住下一次操作。 */
export const AGENT_PULSE_MS = 1600;

let hits: readonly AgentHit[] = [];
const listeners = new Set<() => void>();

const emit = () => { for (const l of listeners) l(); };

/** 点一下某扇窗。`unit` 是 dock 的 UnitId（`vassets` / `layers` / `doc:3` …）。 */
export function pulseUnit(unit: string | null | undefined, label = ''): void {
  if (!unit) return;
  hits = [...hits.filter(h => h.unit !== unit), { unit, at: performance.now(), label }];
  emit();
  window.setTimeout(prune, AGENT_PULSE_MS + 50);
}

/** 全部清掉 —— 换文档/关窗时用，免得旧的框留在新画面上。 */
export function clearAgentPulses(): void {
  if (!hits.length) return;
  hits = [];
  emit();
}

function prune(): void {
  const now = performance.now();
  const next = hits.filter(h => now - h.at < AGENT_PULSE_MS);
  if (next.length !== hits.length) {
    hits = next;
    emit();
  }
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

const snapshot = () => hits;

/** 订阅当前还活着的脉冲。引用只在内容变化时换，`useSyncExternalStore` 才不会每帧重渲染。 */
export function useAgentHits(): readonly AgentHit[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
