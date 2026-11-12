// ── 音频定义层：Bus / Interface / Object / 事件点（纯数据 + 收敛）────────────────────────
//
// 这三套定义与「关键帧上的音频事件点」都是**项目级**数据（随 .cud / 页面存档走）。这里只放
// 类型与校验，不 import model.ts（model 反向 import 本文件），避免环依赖；id 生成也在本地做。
//
// 语义摘要（与用户确认过的口径）：
//  · Bus：串联相乘，父级作用于子级；bus 之间是 DAG，编辑与读档都拒绝回环。
//  · Interface：接口 → 事件（名字 + 挂载 Bus + 参数）→ 参数（float/boolean + 曲线/invert + 挂载 Bus）。
//  · Object：名字 + 挂载的 Interface；每个已挂接口按「事件」提供槽位，槽位里放音频（当前 1 条，模型是数组）。
//  · EventPoint：项目全局绝对秒；绑定 object / interface event / 参数值。

export type AudioCurvePoint = { u: number; g: number };   // 均 0..1，按 u 升序

export type AudioParamDef = {
  id: string;
  name: string;
  kind: 'float' | 'boolean';
  value: number;                 // float: 0..1；boolean: 0|1
  invert?: boolean;              // 仅 boolean
  curve?: AudioCurvePoint[];     // 仅 float；缺省 = 线性（g = u）
  busIds: string[];
};

export type AudioEventDef = {
  id: string;
  name: string;
  busIds: string[];
  params: AudioParamDef[];
};

export type AudioInterfaceDef = {
  id: string;
  name: string;
  /** **接口级参数**：这个 interface 下每个事件都带上的那一组（界面各事件自己的 params 之外）。
   *  触发任何一个事件时，接口级参数与事件参数的增益一起乘进去。 */
  params: AudioParamDef[];
  /** **嵌套的子接口**：父接口自动继承它们的参数与事件（组合，不是分组）；DAG，禁止回环。 */
  ifaceIds: string[];
  events: AudioEventDef[];
};

export type AudioBusDef = {
  id: string;
  name: string;
  gain: number;                  // 0..2（1 = 单位增益）
  busIds: string[];              // 子总线（本 bus 之下串联）
};

export type SlotAudio = {
  id: string;
  name: string;
  asset?: string;                // 仓库哈希（有它就能从 /api/asset_media 重建 url）
  url: string;
  duration?: number;             // 秒；缺省时播放前由解码补
  gain?: number;                 // 槽内微调（0..2，缺省 1）
};

export type AudioObjectDef = {
  id: string;
  name: string;
  ifaceIds: string[];
  /** key = 事件 id（全局唯一）；值始终是数组 —— 当前 UI 只放 1 条，以后可扩多条。 */
  slots: Record<string, SlotAudio[]>;
};

export type AudioEventPoint = {
  id: string;
  /** 挂在哪一段上（任何轨型）。点随这一段移动 / 裁剪 / 删除；触发时用 `段起点 + t`。 */
  clipId: string;
  /** **段内秒**（相对这一段自己的起点）。老档没有 clipId 的点在 model 读档时按它的绝对秒安置。 */
  t: number;
  objectId: string;
  ifaceId: string;
  eventId: string;
  values: Record<string, number>; // paramId → 0..1 / 0|1
};

export type AudioDefs = {
  audioBuses?: AudioBusDef[];
  audioInterfaces?: AudioInterfaceDef[];
  audioObjects?: AudioObjectDef[];
  audioEventPoints?: AudioEventPoint[];
};

let seq = 0;
export const newAudioId = (prefix: string): string =>
  `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

export const clamp01 = (v: number): number =>
  Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
export const clampGain = (v: number): number =>
  Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 1;
const numOr = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const rows = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** 一组曲线点：夹到 0..1、按 u 排序、同 u 后者胜出。空/单点时保留（求值会当常量）。 */
const normCurve = (v: unknown): AudioCurvePoint[] | undefined => {
  const pts = rows<AudioCurvePoint>(v)
    .filter(p => p && Number.isFinite(p.u) && Number.isFinite(p.g))
    .map(p => ({ u: clamp01(p.u), g: clamp01(p.g) }))
    .sort((a, b) => a.u - b.u);
  const out: AudioCurvePoint[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.u - p.u) < 1e-6) out[out.length - 1] = p;
    else out.push(p);
  }
  return out.length ? out : undefined;
};

/** 删一条 bus 时把所有引用一起摘掉（bus 子表 / 事件的 bus / 参数的 bus）。 */
export const stripBusEverywhere = (defs: AudioDefs, busId: string): {
  buses: AudioBusDef[]; ifaces: AudioInterfaceDef[];
} => {
  const cut = (ids: string[] | undefined): string[] => (ids ?? []).filter(id => id !== busId);
  const buses = (defs.audioBuses ?? []).map(b => ({ ...b, busIds: cut(b.busIds) }));
  const ifaces = (defs.audioInterfaces ?? []).map(it => ({
    ...it,
    params: (it.params ?? []).map(pr => ({ ...pr, busIds: cut(pr.busIds) })),
    events: it.events.map(ev => ({
      ...ev,
      busIds: cut(ev.busIds),
      params: ev.params.map(pr => ({ ...pr, busIds: cut(pr.busIds) })),
    })),
  }));
  return { buses, ifaces };
};

/** 在 parent 下再挂 child 会不会成环：child 已经能走回 parent 就不行。 */
export const wouldCycleBus = (buses: AudioBusDef[], parentId: string, childId: string): boolean => {
  if (parentId === childId) return true;
  const by = new Map(buses.map(b => [b.id, b] as const));
  const seen = new Set<string>();
  const stack = [childId];
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === parentId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const b = by.get(id);
    if (b) stack.push(...b.busIds);
  }
  return false;
};

/** 接口嵌套的环判定：同 Bus 的口径。 */
export const wouldCycleIface = (
  ifaces: AudioInterfaceDef[], parentId: string, childId: string,
): boolean => {
  if (parentId === childId) return true;
  const by = new Map(ifaces.map(i => [i.id, i] as const));
  const seen = new Set<string>();
  const stack = [childId];
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === parentId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const it = by.get(id);
    if (it) stack.push(...(it.ifaceIds ?? []));
  }
  return false;
};

/** 组合后的接口闭包：自己 + 所有后代（按 id 去重，自己在前、后代按数组序）。 */
export const ifaceClosure = (ifaces: AudioInterfaceDef[], rootId: string): AudioInterfaceDef[] => {
  const by = new Map(ifaces.map(i => [i.id, i] as const));
  const out: AudioInterfaceDef[] = [];
  const seen = new Set<string>();
  const queue = [rootId];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (seen.has(id)) continue;
    seen.add(id);
    const it = by.get(id);
    if (!it) continue;
    out.push(it);
    for (const cid of it.ifaceIds ?? []) queue.push(cid);
  }
  return out;
};

/** 闭包里的事件（按 id 去重）连同「声明它的接口」——对象槽位与事件点都按这一份认事件。 */
export const closureEvents = (
  ifaces: AudioInterfaceDef[], rootId: string,
): { event: AudioEventDef; owner: AudioInterfaceDef }[] => {
  const out: { event: AudioEventDef; owner: AudioInterfaceDef }[] = [];
  const seen = new Set<string>();
  for (const it of ifaceClosure(ifaces, rootId)) {
    for (const ev of it.events) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      out.push({ event: ev, owner: it });
    }
  }
  return out;
};

/** 从 root 的闭包里找一枚事件；找不到 = 悬空引用。 */
export const eventInClosure = (
  ifaces: AudioInterfaceDef[], rootId: string, eventId: string,
): { event: AudioEventDef; owner: AudioInterfaceDef } | null =>
  closureEvents(ifaces, rootId).find(x => x.event.id === eventId) ?? null;

/** 校验并收敛工程里的三套定义 + 事件点。坏引用一律丢掉，而不是留一颗悬空 id。 */
export const normalizeAudioDefs = (raw: unknown): AudioDefs => {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<AudioDefs>;

  // ── Bus ──────────────────────────────────────────────────────────────────────────────────
  const buses: AudioBusDef[] = [];
  const busById = new Map<string, AudioBusDef>();
  for (const b of rows<AudioBusDef>(p.audioBuses)) {
    if (!b || typeof b.id !== 'string' || !b.id || busById.has(b.id)) continue;
    const one: AudioBusDef = {
      id: b.id,
      name: str(b.name) || 'Bus',
      gain: clampGain(numOr(b.gain, 1)),
      busIds: [],
    };
    buses.push(one);
    busById.set(one.id, one);
  }
  // 边按存档顺序收：会让「父」从「子」可达的边直接丢弃 → 确定性 DAG。
  for (const b of rows<AudioBusDef>(p.audioBuses)) {
    const from = typeof b?.id === 'string' ? busById.get(b.id) : undefined;
    if (!from) continue;
    for (const cid of Array.isArray(b.busIds) ? b.busIds : []) {
      if (typeof cid !== 'string' || !busById.has(cid)) continue;
      if (from.busIds.includes(cid) || wouldCycleBus(buses, from.id, cid)) continue;
      from.busIds.push(cid);
    }
  }
  const busIds = new Set(buses.map(b => b.id));
  const pickBuses = (v: unknown): string[] => [...new Set(
    rows<unknown>(v).filter((x): x is string => typeof x === 'string' && busIds.has(x)),
  )];

  // ── Interface / Event / Param ───────────────────────────────────────────────────────────
  const ifaces: AudioInterfaceDef[] = [];
  const ifaceById = new Map<string, AudioInterfaceDef>();
  const eventById = new Map<string, AudioEventDef>();
  const paramIds = new Set<string>();
  /** 一组参数（接口级与事件级同一个口径，id 全局唯一因此共用一张表）。 */
  const normParams = (list: unknown): AudioParamDef[] => {
    const params: AudioParamDef[] = [];
    for (const pr of rows<AudioParamDef>(list)) {
      if (!pr || typeof pr.id !== 'string' || !pr.id || paramIds.has(pr.id)) continue;
      paramIds.add(pr.id);
      const kind: AudioParamDef['kind'] = pr.kind === 'boolean' ? 'boolean' : 'float';
      params.push({
        id: pr.id,
        name: str(pr.name) || (kind === 'boolean' ? 'Switch' : 'Value'),
        kind,
        value: kind === 'boolean'
          ? (numOr(pr.value, 0) > 0 ? 1 : 0)
          : clamp01(numOr(pr.value, 0)),
        ...(kind === 'boolean' ? { invert: pr.invert === true } : {}),
        ...(kind === 'float' ? { curve: normCurve(pr.curve) } : {}),
        busIds: pickBuses(pr.busIds),
      });
    }
    return params;
  };
  for (const it of rows<AudioInterfaceDef>(p.audioInterfaces)) {
    if (!it || typeof it.id !== 'string' || !it.id || ifaceById.has(it.id)) continue;
    const params = normParams(it.params);
    const events: AudioEventDef[] = [];
    for (const ev of rows<AudioEventDef>(it.events)) {
      if (!ev || typeof ev.id !== 'string' || !ev.id || eventById.has(ev.id)) continue;
      const one: AudioEventDef = {
        id: ev.id,
        name: str(ev.name) || 'Event',
        busIds: pickBuses(ev.busIds),
        params: normParams(ev.params),
      };
      eventById.set(one.id, one);
      events.push(one);
    }
    const one: AudioInterfaceDef = { id: it.id, name: str(it.name) || 'Interface', params, ifaceIds: [], events };
    ifaceById.set(one.id, one);
    ifaces.push(one);
  }
  // 嵌套边：与 Bus 同一套收法（不合法的目标直接丢、会成环的边直接丢）→ 确定性 DAG。
  for (const it of rows<AudioInterfaceDef>(p.audioInterfaces)) {
    const from = typeof it?.id === 'string' ? ifaceById.get(it.id) : undefined;
    if (!from) continue;
    for (const cid of Array.isArray(it.ifaceIds) ? it.ifaceIds : []) {
      if (typeof cid !== 'string' || !ifaceById.has(cid)) continue;
      if (from.ifaceIds.includes(cid) || wouldCycleIface(ifaces, from.id, cid)) continue;
      from.ifaceIds.push(cid);
    }
  }

  // ── Object ─────────────────────────────────────────────────────────────────────────────
  const objects: AudioObjectDef[] = [];
  const objectById = new Set<string>();
  for (const ob of rows<AudioObjectDef>(p.audioObjects)) {
    if (!ob || typeof ob.id !== 'string' || !ob.id || objectById.has(ob.id)) continue;
    objectById.add(ob.id);
    const ifaceIds = [...new Set(rows<unknown>(ob.ifaceIds)
      .filter((x): x is string => typeof x === 'string' && ifaceById.has(x)))];
    // 槽位只认「这些已挂接口（含它们嵌套的子接口）里确实存在的事件」。
    const allowed = new Set<string>();
    for (const iid of ifaceIds) for (const { event } of closureEvents(ifaces, iid)) allowed.add(event.id);
    const slots: Record<string, SlotAudio[]> = {};
    const srcSlots = (ob.slots && typeof ob.slots === 'object' ? ob.slots : {}) as Record<string, unknown>;
    for (const [eventId, list] of Object.entries(srcSlots)) {
      if (!allowed.has(eventId)) continue;
      const audios: SlotAudio[] = [];
      for (const a of rows<SlotAudio>(list)) {
        if (!a) continue;
        const asset = str(a.asset) || undefined;
        const rawUrl = str(a.url);
        const url = rawUrl && !rawUrl.startsWith('blob:')
          ? rawUrl
          : asset ? '/api/asset_media/' + encodeURIComponent(asset) : '';
        if (!url) continue;
        audios.push({
          id: typeof a.id === 'string' && a.id ? a.id : newAudioId('slo'),
          name: str(a.name) || url.split('/').pop() || 'Audio',
          ...(asset ? { asset } : {}),
          url,
          ...(numOr(a.duration, 0) > 0 ? { duration: numOr(a.duration, 0) } : {}),
          ...(a.gain !== undefined ? { gain: clampGain(numOr(a.gain, 1)) } : {}),
        });
      }
      if (audios.length) slots[eventId] = audios;
    }
    objects.push({ id: ob.id, name: str(ob.name) || 'Object', ifaceIds, slots });
  }
  const objectIds = new Set(objects.map(o => o.id));

  // ── EventPoint ─────────────────────────────────────────────────────────────────────────
  const eventPoints: AudioEventPoint[] = [];
  const pointIds = new Set<string>();
  for (const pt of rows<AudioEventPoint>(p.audioEventPoints)) {
    if (!pt || typeof pt.id !== 'string' || !pt.id || pointIds.has(pt.id)) continue;
    if (!objectIds.has(pt.objectId)) continue;
    const ev = eventById.get(pt.eventId);
    if (!ev) continue;
    const ob = objects.find(o => o.id === pt.objectId);
    // 没写 / 写错的 ifaceId：事件只有一个家（id 全局唯一），按它反查已挂接口补上。
    // ifaceId 记的是「对象挂的那个接口」（组合的根）。写错/缺失就按对象已挂的接口，
    // 找哪个闭包里能到达这枚事件。
    const ifaceId = ob?.ifaceIds.includes(pt.ifaceId)
      ? pt.ifaceId
      : ob?.ifaceIds.find(id => eventInClosure(ifaces, id, ev.id));
    if (!ifaceId || !ob?.ifaceIds.includes(ifaceId)) continue;
    if (!eventInClosure(ifaces, ifaceId, ev.id)) continue;
    const values: Record<string, number> = {};
    // 接口级参数（含嵌套继承的）与事件参数都要有值：事件点存的是一张 paramId → 值 的表。
    const chainParams = ifaceClosure(ifaces, ifaceId).flatMap(it => it.params);
    for (const pr of [...chainParams, ...ev.params]) {
      const v = pt.values?.[pr.id];
      values[pr.id] = pr.kind === 'boolean'
        ? (numOr(v, pr.value) > 0 ? 1 : 0)
        : clamp01(numOr(v, pr.value));
    }
    pointIds.add(pt.id);
    eventPoints.push({
      id: pt.id,
      clipId: str(pt.clipId),
      t: Math.max(0, numOr(pt.t, 0)),
      objectId: pt.objectId,
      ifaceId,
      eventId: ev.id,
      values,
    });
  }
  eventPoints.sort((a, b) => (a.clipId === b.clipId ? a.t - b.t : a.clipId < b.clipId ? -1 : 1));

  return {
    audioBuses: buses.length ? buses : undefined,
    audioInterfaces: ifaces.length ? ifaces : undefined,
    audioObjects: objects.length ? objects : undefined,
    audioEventPoints: eventPoints.length ? eventPoints : undefined,
  };
};
