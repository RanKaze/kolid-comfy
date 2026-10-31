// Assets 窗 Instruments 档的数据源：照 MIDI 设置里那条路径，问后端"这底下有什么"。
//
// 一次拉、全档共用：切档来回不该重扫一个几万文件的音源库。三条会重来的路 —— 首次打开、用户按
// 刷新、MIDI 设置里的路径/深度变了（见文件尾对 settings 的订阅）。
//
// 后端两条路自己选，这里只看 `source` 报的实话：
//   catalog = 那颗库里有 catalog.json（原项目那种入库清单），条目已经是验证过的；
//   scan    = 没有清单，按目录树扫出来的。
// `playable` 是"**这个程序**播得出来"，不是"这个音色好不好" —— VST3 现在只列不能放。
import { useSyncExternalStore } from 'react';
import { getMidiSettings, subscribeMidiSettings, type LibraryState } from './settings';

export type InstrumentItem = {
  id: string;
  name: string;
  /** 型号（一个型号下会有好几个预设；目录扫出来时是父目录名）。 */
  model: string;
  family: string;
  /** sfz / vst3-preset / surge-fxp —— 谁去加载它。 */
  backend: string;
  /** 产品来源（Keyscape、SalamanderGrandPiano…）。 */
  source: string;
  /** 现在就能出声吗。 */
  playable: boolean;
  /** 入库时真发过声（catalog 里那条 audio_verified）。 */
  verified: boolean;
  /** 库内相对路径，只给悬停看。 */
  where: string;
};

export type InstrumentLibrary = {
  ok: boolean;
  root: string;
  source: 'catalog' | 'scan' | 'none';
  items: InstrumentItem[];
  total: number;
  /** 撞到上限了（4000 条）—— 不装作列全了。 */
  truncated: boolean;
  error: string;
  elapsedMs: number;
  state: LibraryState;
};

type Snap = { lib: InstrumentLibrary | null; loading: boolean; error: string };

const EMPTY: Snap = { lib: null, loading: false, error: '' };
let snap: Snap = EMPTY;
let loadedFor = '';      // 上一次成功拉到的是哪条路径 —— 路径变了才允许自动重扫
let inflight: Promise<void> | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach(fn => fn());

const num = (v: unknown, d: number) => (typeof v === 'number' && isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** 后端条目 → 前端条目。**类型不认识的一律丢掉**，别让一行 `undefined` 混进列表把整档画崩。 */
const item = (raw: unknown): InstrumentItem | null => {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  const name = str(r.name);
  if (!name) return null;
  return {
    id: str(r.id) || name,
    name,
    model: str(r.model),
    family: str(r.family),
    backend: str(r.backend),
    source: str(r.source),
    playable: r.playable === true,
    verified: r.verified === true,
    where: str(r.where),
  };
};

const adopt = (data: unknown): InstrumentLibrary | null => {
  const d = data as Record<string, unknown> | null;
  // 形状闸：这一档的核心是 items 数组；没有它说明这不是本路由的答案（老后端 404 / `{}`）。
  if (!d || typeof d !== 'object' || !Array.isArray(d.items)) return null;
  const st = d.state as Partial<LibraryState> | undefined;
  return {
    ok: d.ok === true,
    root: str(d.root),
    source: d.source === 'catalog' || d.source === 'scan' ? d.source : 'none',
    items: d.items.map(item).filter((x): x is InstrumentItem => x !== null),
    total: num(d.total, d.items.length),
    truncated: d.truncated === true,
    error: str(d.error),
    elapsedMs: num(d.elapsed_ms, 0),
    state: st && typeof st.ok === 'boolean'
      ? { set: !!st.set, ok: !!st.ok, reason: str(st.reason) }
      : { set: !!str(d.root), ok: d.ok === true, reason: '' },
  };
};

/** 拉一次。`force` = 用户按了刷新（路径没变也重扫）。 */
export const reloadInstruments = (force = false): Promise<void> => {
  if (inflight) return inflight;
  const root = getMidiSettings().instrumentsLibrary;
  if (!force && loadedFor === root && snap.lib) return Promise.resolve();
  snap = { ...snap, loading: true, error: '' };
  emit();
  inflight = fetch('/api/instruments')
    .then(r => (r.ok ? r.json() : null))
    .then(data => {
      const lib = adopt(data);
      if (!lib) { snap = { ...snap, loading: false, error: 'Instrument list unavailable — the backend may not have been restarted since this was added.' }; return; }
      snap = { lib, loading: false, error: '' };
      loadedFor = lib.root;
    })
    .catch(() => { snap = { ...snap, loading: false, error: 'Instrument list unavailable — the backend may not have been restarted since this was added.' }; })
    .finally(() => { inflight = null; emit(); });
  return inflight;
};

export const getInstrumentLibrary = () => snap;

export const subscribeInstruments = (fn: () => void): (() => void) => {
  subs.add(fn);
  return () => { subs.delete(fn); };
};

/** 设置里改了路径/深度 ⇒ 手上这份作废，并且**立刻照新的扫一遍**。
 *  这一档的用处就是"改了马上就看见"：设置页里把 Scan depth 从 3 调到 5、或者换了文件夹，
 *  状态行与清单应当当场变，而不是等用户再去点一次 Rescan。
 *  `reloadInstruments` 自己有 inflight 合并与"同一条路径且已有清单就不重复"的判断，
 *  所以 mount 时的那一次和这里的这一次撞上也不会扫两趟。 */
let lastKey = (() => { const s = getMidiSettings(); return s.instrumentsLibrary + '|' + s.scanDepth; })();
subscribeMidiSettings(() => {
  const s = getMidiSettings();
  const key = s.instrumentsLibrary + '|' + s.scanDepth;
  if (key === lastKey) return;
  lastKey = key;
  loadedFor = '';
  snap = { lib: snap.lib, loading: false, error: '' };
  emit();
  void reloadInstruments(true);
});

export const useInstrumentLibrary = (): Snap => useSyncExternalStore(subscribeInstruments, getInstrumentLibrary, getInstrumentLibrary);
