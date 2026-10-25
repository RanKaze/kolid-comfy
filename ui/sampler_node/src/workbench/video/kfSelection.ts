// ── 关键帧选中态,跨窗共享 ────────────────────────────────────────────────────────────────────
// Dopesheet 里点选的既有**参数行**(K 键给它们打帧),也有**单个关键帧**(整组拖动、Delete 删除)。
// 两样都归这一口极小的外部 store:帧住在段上,所以快照带着 clipId —— 换一枚段就换了一套地址,
// 读的人自己比对(不去追着别的窗清别人的选中)。与 selection.ts 同一形状,谁也不持有谁的实例。

/** 一枚帧的地址:通道键 + 时刻。录制把时刻 round 到 ms,取 3 位小数就能区分。 */
export const kfKeyAt = (key: string, t: number): string => `${key}\u0000${t.toFixed(3)}`;

export type KfSel = {
  /** 这些选中属于哪一枚段;不是当前段就当空集读。 */
  clipId: string | null;
  /** 选中的参数行(通道键)—— K 键按它决定给哪些通道打帧。 */
  channels: ReadonlySet<string>;
  /** 选中的帧(地址见 kfKeyAt)。 */
  keys: ReadonlySet<string>;
};

const EMPTY: KfSel = { clipId: null, channels: new Set<string>(), keys: new Set<string>() };

let sel: KfSel = EMPTY;
const subs = new Set<() => void>();

export const getKfSelection = (): KfSel => sel;
export const subscribeKfSelection = (fn: () => void): (() => void) => {
  subs.add(fn);
  return () => { subs.delete(fn); };
};

const same = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every(x => b.has(x));

export const setKfSelection = (next: KfSel): void => {
  if (next.clipId === sel.clipId && same(next.channels, sel.channels) && same(next.keys, sel.keys)) return;
  sel = next;
  subs.forEach(f => f());
};

/** 换一枚段的选中:不在当前段上的一律先塌成空集(别的段留着地址也没法对齐)。 */
export const switchKfClip = (clipId: string | null, keep?: KfSel): void => {
  if (keep && keep.clipId === clipId) return;
  setKfSelection(clipId ? { clipId, channels: new Set<string>(), keys: new Set<string>() } : EMPTY);
};

/** 点参数行:普通点击只留这一行(同时清掉选中的帧),Shift/⌘ 加选/减选。 */
export const kfPickChannel = (clipId: string, key: string, additive: boolean): void => {
  const channels = new Set(sel.clipId === clipId && additive ? sel.channels : []);
  if (channels.has(key)) channels.delete(key); else channels.add(key);
  setKfSelection({ clipId, channels, keys: new Set<string>() });
};

/** 点菱形:普通点击只留这一枚,Shift/⌘ 加选/减选;清选中传空。 */
export const kfPickKey = (clipId: string, addr: string, additive: boolean): void => {
  const keys = new Set(sel.clipId === clipId && additive ? sel.keys : []);
  if (keys.has(addr)) keys.delete(addr); else keys.add(addr);
  setKfSelection({ clipId, channels: new Set<string>(), keys });
};

/** 整行/整段的帧一起选中(右键菜单 Select All Keys of This Parameter)。 */
export const kfPickKeys = (clipId: string, addrs: string[]): void =>
  setKfSelection({ clipId, channels: new Set<string>(), keys: new Set(addrs) });

/** 框选(橡皮筋)落账:框到的**帧**和框住的**参数行**一起算选中 —— 一次覆盖两组,
 *  所以拖完框既能直接 Delete/拖动那几枚帧,也能直接按 K 给框住的几条参数打帧。
 *  `additive`(Shift/⌘ 拖)= 在既有选中上并进去,不是替换。 */
export const kfPickBox = (clipId: string, keys: ReadonlyArray<string>, channels: ReadonlyArray<string>, additive = false): void => {
  const prev = sel.clipId === clipId ? sel : { channels: EMPTY.channels, keys: EMPTY.keys };
  const nextKeys = new Set<string>(additive ? prev.keys : []);
  for (const k of keys) nextKeys.add(k);
  const nextChannels = new Set<string>(additive ? prev.channels : []);
  for (const c of channels) nextChannels.add(c);
  setKfSelection({ clipId, channels: nextChannels, keys: nextKeys });
};

export const kfClearSelection = (): void => setKfSelection(EMPTY);
