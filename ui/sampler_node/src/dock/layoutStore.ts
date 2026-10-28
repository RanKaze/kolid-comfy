import type { Dock } from './model';

// 布局档案的唯一入口：**盘上那份是真相**，浏览器这份只是缓存。
//
// 为什么不能只住在 localStorage：宿主是 `http://localhost:<8700..8799>/sampler_node.html`，
// 端口是后端一个一个试出来的（8700 被占就 8701）。换端口 = 换 origin，浏览器里那份存档当场
// 看不见 —— 用户看到的就是"我存的布局下次打开就没了"。同一件事也解释了为什么它必须由后端存。
//
// 形状：`{ default: 名字 | null, items: [{ name, at, dock }], current: { at, dock } | null }`。
//   · `items`   取名的槽位，同名 save 是覆盖，最近存的排最前；
//   · `default` ★：**一片空白的页面**从哪一份起手（没有"上一次"时的备份答案）；
//   · `current` 用户**此刻**的摆法 —— 页面每次动完布局就实时写回（去抖），下一次打开原样还给他。
//     它不是槽位，不进清单、不占限额，也不会因为多了几份存档被挤掉。

export type SavedLayout = { name: string; at: number; dock: Dock };
/** 用户**此刻**的摆法（页面实时写回盘上的那一份）。 */
export type CurrentLayout = { at: number; dock: Dock };
export type LayoutStore = { default: string | null; items: SavedLayout[]; current: CurrentLayout | null };

const LOCAL_KEY = 'sampler.drawLayouts';
// 四十份够用了：再多也只是把最老的挤掉，反而认不出列表里哪个是哪个（后端那一侧同一个上限）。
export const LAYOUT_MAX = 40;

const cleanItems = (raw: unknown): SavedLayout[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is SavedLayout => !!x && typeof x === 'object'
      && typeof (x as SavedLayout).name === 'string'
      && !!(x as SavedLayout).dock && typeof (x as SavedLayout).dock === 'object'
      && !!((x as SavedLayout).dock as Dock).tree)
    .map(x => ({ name: String(x.name), at: typeof x.at === 'number' ? x.at : 0, dock: x.dock }))
    .slice(0, LAYOUT_MAX);
};

const cleanCurrent = (raw: unknown): CurrentLayout | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { at?: unknown; dock?: unknown };
  const dock = o.dock as Dock | undefined;
  if (!dock || typeof dock !== 'object' || !dock.tree) return null;
  return { at: typeof o.at === 'number' ? o.at : 0, dock };
};

// 读浏览器里那份。老格式是**纯数组**（还没默认这个概念的时候），照着读，别让它当场丢失。
export const readLocalLayouts = (): LayoutStore => {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return { default: null, items: [], current: null };
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return { default: null, items: cleanItems(parsed), current: null };
    if (!parsed || typeof parsed !== 'object') return { default: null, items: [], current: null };
    const o = parsed as { default?: unknown; items?: unknown; current?: unknown };
    const items = cleanItems(o.items);
    const def = typeof o.default === 'string' && items.some(i => i.name === o.default) ? o.default : null;
    return { default: def, items, current: cleanCurrent(o.current) };
  } catch { return { default: null, items: [], current: null }; }
};

export const writeLocalLayouts = (store: LayoutStore) => {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(store)); } catch { /* 缓存写不进去就只靠盘上那份 */ }
};

const asStore = (j: unknown): LayoutStore | null => {
  if (!j || typeof j !== 'object') return null;
  const o = j as { ok?: unknown; kind?: unknown; default?: unknown; items?: unknown; current?: unknown };
  // `kind` 是这道关的**印章**：别的接口也可能回 `{ok:true, items:[]}`（假后端就干过），照着它
  // 把列表清空比"这次问不到"糟得多 —— 问不到只该退回浏览器缓存。
  if (o.ok !== true || o.kind !== 'layouts') return null;
  const items = cleanItems(o.items);
  const def = typeof o.default === 'string' && items.some(i => i.name === o.default) ? o.default : null;
  return { default: def, items, current: cleanCurrent(o.current) };
};

// 后端那份。null = 这次问不到（页面开在没有后端的静态壳里、或者服务刚重启）—— 调用方
// 据此保留浏览器里的缓存，而不是把列表清空给用户看。
export const fetchLayouts = async (): Promise<LayoutStore | null> => {
  try {
    const r = await fetch('/api/layouts', { cache: 'no-store' });
    if (!r.ok) return null;
    return asStore(await r.json());
  } catch { return null; }
};

export const layoutsAction = async (
  action: 'save' | 'delete' | 'default',
  payload: { name: string; dock?: Dock },
): Promise<LayoutStore | null> => {
  try {
    const r = await fetch('/api/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    });
    if (!r.ok) return null;
    return asStore(await r.json());
  } catch { return null; }
};

// ── 开机那一份「上一次的摆法」────────────────────────────────────────────────────────────
//
// 后端把 `current`（没有就退到 ★）**塞进 HTML 的 <head>** 带下来，见
// nodes/workbench/snapshot_sampler_node.py:_inject_boot_layout。页面脚本一解析就已经有答案，
// 所以第一帧画的就是用户上次的样子 —— 不再有"先摆默认、等接口回来再跳一次"那一下。
//
// 注意：页面也可能开在**没有注入**的地方（`npm run dev` 的 vite、探针自带的静态服务器）。
// 那条路上这里回 null，调用方退回浏览器里的镜像（它也是上一次的样子），一样不跳。
export type BootLayout = {
  current: Dock | null;
  currentAt: number;
  default: Dock | null;
  defaultName: string | null;
};

const asDock = (v: unknown): Dock | null => {
  const d = v as Dock | undefined;
  return d && typeof d === 'object' && d.tree ? d : null;
};

export const readBootLayout = (): BootLayout | null => {
  try {
    const raw = (window as unknown as { __DOCK_BOOT__?: unknown }).__DOCK_BOOT__;
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as { current?: unknown; currentAt?: unknown; default?: unknown; defaultName?: unknown };
    const current = asDock(o.current);
    const def = asDock(o.default);
    if (!current && !def) return null;
    return {
      current, currentAt: typeof o.currentAt === 'number' ? o.currentAt : 0,
      default: def, defaultName: typeof o.defaultName === 'string' ? o.defaultName : null,
    };
  } catch { return null; }
};

// ── 「此刻的摆法」实时写回盘上 ────────────────────────────────────────────────────────────
//
// 去抖：一次拖动（松手才算一次）、一次落格、一次切 tab 都各算一次改动，600ms 之内连续的几笔
// 合并成最后那一笔 —— 盘上写的是**手停下来之后**的样子，不是拖动途中的中间态。
// 串行：同一时刻只有一发在路上，中途来的新摆法排在它后面（最后一笔一定落地，不会被吞）。
const CURRENT_DELAY = 600;

let queued: Dock | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let sending = false;

const postCurrent = async (dock: Dock, keepalive = false): Promise<void> => {
  try {
    await fetch('/api/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'current', dock }),
      cache: 'no-store',
      keepalive,
    });
  } catch { /* 后端不在 / 写入失败：下一笔会再试，页面本身不受影响 */ }
};

const pump = async (): Promise<void> => {
  if (sending) return;
  sending = true;
  try {
    while (queued) {
      const next = queued;
      queued = null;
      await postCurrent(next);
    }
  } finally { sending = false; }
};

/** 排一笔「此刻的摆法」。同一批改动里调多少次都只有最后一笔落盘。 */
export const queueCurrentLayout = (dock: Dock, delay = CURRENT_DELAY): void => {
  queued = dock;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void pump(); }, delay);
};

/** 立刻把欠着的那一笔发出去（关页面 / 切到后台时用）。 */
export const flushCurrentLayout = (keepalive = false): void => {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  const dock = queued;
  queued = null;
  if (!dock) return;
  if (keepalive) { void postCurrent(dock, true); return; }
  queued = dock;
  void pump();
};

if (typeof window !== 'undefined') {
  // 关页 / 刷新 / 切到后台：欠着的那一笔当场发（keepalive = 请求活过这一页）。
  // 不管这一步能不能成，下一次打开时盘上那份就算旧一点点，也总比没有强。
  const bye = () => flushCurrentLayout(true);
  window.addEventListener('pagehide', bye);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') bye();
  });
}
