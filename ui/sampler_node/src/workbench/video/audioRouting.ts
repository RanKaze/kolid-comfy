// ── 总线求值：事件点 → 一个线性增益（0..2）──────────────────────────────────────────────
//
// 原生引擎没有 bus/DSP 路由，只有每段 PCM 的 `gain`。所以「Bus 混合」在这里折成一个数：
//  · 事件挂载的 bus + 每个参数挂载的 bus，以及它们的所有子 bus，构成**串联链**；
//  · 同一条 bus 在一次求值里只乘一次（分叉不重复计入）—— 这就是"父级作用于子级"的相乘语义；
//  · float 参数：值经曲线映射成 0..1 的乘数；boolean 参数：0/1（invert 反过来）；
//  · 任何环节为 0 → 整条事件静音（不发声，不是发一个 0 增益的声）。

import {
  clamp01, clampGain, eventInClosure, ifaceClosure, type AudioBusDef, type AudioCurvePoint,
  type AudioEventDef, type AudioEventPoint, type AudioInterfaceDef,
} from './audioDefs';

/** 分段线性曲线求值：首尾外取端值，点间线性；没有点 = 恒 1（线性直通）。 */
export const evalCurve = (curve: AudioCurvePoint[] | undefined, u: number): number => {
  const x = clamp01(u);
  if (!curve || curve.length === 0) return 1;
  if (curve.length === 1) return clamp01(curve[0].g);
  if (x <= curve[0].u) return clamp01(curve[0].g);
  const last = curve[curve.length - 1];
  if (x >= last.u) return clamp01(last.g);
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1], b = curve[i];
    if (x <= b.u) {
      const span = b.u - a.u;
      const k = span > 1e-9 ? (x - a.u) / span : 0;
      return clamp01(a.g + (b.g - a.g) * k);
    }
  }
  return clamp01(last.g);
};

/** 从 roots 出发收集可达的**新** bus（迭代 DFS；seen 跨本次求值共享 → 同一 bus 只算一次）。 */
const reachBuses = (roots: string[], by: Map<string, AudioBusDef>, seen: Set<string>): string[] => {
  const added: string[] = [];
  const stack = [...roots];
  let guard = 0;
  while (stack.length && guard++ < 4096) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const b = by.get(id);
    if (!b) continue;               // 悬空引用：不是总线，也就不进乘积
    added.push(id);
    stack.push(...b.busIds);
  }
  return added;
};

/** 一条 bus 的增益；坏值收敛到 1（单位增益），与读档口径一致。 */
const gainOf = (b: AudioBusDef): number => clampGain(Number.isFinite(b.gain) ? b.gain : 1);

/** `ifaceId` 是组合的根（对象挂的那个接口）：事件可以在它嵌套的子接口里。 */
export const findEvent = (
  ifaces: AudioInterfaceDef[], ifaceId: string, eventId: string,
): AudioEventDef | null => eventInClosure(ifaces, ifaceId, eventId)?.event ?? null;

export type EventGain = { gain: number; event: AudioEventDef | null };

/**
 * 一个事件点的总增益。参数值缺省取参数自身的默认值。
 * 求不出定义（对象/接口/事件被删了）返回 0 & null —— 调用方据此不发声。
 */
export const audioEventGain = (
  point: AudioEventPoint,
  buses: AudioBusDef[],
  ifaces: AudioInterfaceDef[],
): EventGain => {
  // 点上的 ifaceId 是对象挂的那个接口（组合的根）：事件本身可能在嵌套的子接口里。
  const hit = eventInClosure(ifaces, point.ifaceId, point.eventId);
  if (!hit) return { gain: 0, event: null };
  const event = hit.event;
  const chain = ifaceClosure(ifaces, point.ifaceId);
  const by = new Map(buses.map(b => [b.id, b] as const));
  const seen = new Set<string>();
  let g = 1;
  const take = (ids: string[]) => {
    // 只乘**这一次新纳入**的 bus：seen 是跨链共享的，重复乘已算过的级会把父级增益算成平方。
    for (const id of reachBuses(ids, by, seen)) g *= gainOf(by.get(id) as AudioBusDef);
  };
  const takeParam = (param: AudioEventDef['params'][number]) => {
    const raw = point.values[param.id] ?? param.value;
    if (param.kind === 'boolean') {
      let on = Number(raw) > 0;
      if (param.invert) on = !on;
      g *= on ? 1 : 0;
    } else {
      g *= evalCurve(param.curve, clamp01(Number(raw)));
    }
    take(param.busIds);
  };

  take(event.busIds);
  // 组合闭包里每个接口的全局参数都生效（父 → 子，一次求值里每个接口只算一次），再乘事件自己的。
  for (const it of chain) for (const param of it.params ?? []) takeParam(param);
  for (const param of event.params) takeParam(param);
  return { gain: Math.max(0, Math.min(2, g)), event };
};
