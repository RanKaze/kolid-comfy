import type { Dock } from './model';

// 布局档案的唯一入口：**盘上那份是真相**，浏览器这份只是缓存。
//
// 为什么不能只住在 localStorage：宿主是 `http://localhost:<8700..8799>/sampler_node.html`，
// 端口是后端一个一个试出来的（8700 被占就 8701）。换端口 = 换 origin，浏览器里那份存档当场
// 看不见 —— 用户看到的就是"我存的布局下次打开就没了"。同一件事也解释了为什么它必须由后端存。
//
// 形状：`{ default: 名字 | null, items: [{ name, at, dock }] }`。`default` 是"每次打开都从这里
// 起手"的那一份；`items` 是取名的槽位，同名 save 是覆盖，最近存的排最前。

export type SavedLayout = { name: string; at: number; dock: Dock };
export type LayoutStore = { default: string | null; items: SavedLayout[] };

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

// 读浏览器里那份。老格式是**纯数组**（还没默认这个概念的时候），照着读，别让它当场丢失。
export const readLocalLayouts = (): LayoutStore => {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return { default: null, items: [] };
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return { default: null, items: cleanItems(parsed) };
    if (!parsed || typeof parsed !== 'object') return { default: null, items: [] };
    const o = parsed as { default?: unknown; items?: unknown };
    const items = cleanItems(o.items);
    const def = typeof o.default === 'string' && items.some(i => i.name === o.default) ? o.default : null;
    return { default: def, items };
  } catch { return { default: null, items: [] }; }
};

export const writeLocalLayouts = (store: LayoutStore) => {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(store)); } catch { /* 缓存写不进去就只靠盘上那份 */ }
};

const asStore = (j: unknown): LayoutStore | null => {
  if (!j || typeof j !== 'object') return null;
  const o = j as { ok?: unknown; kind?: unknown; default?: unknown; items?: unknown };
  // `kind` 是这道关的**印章**：别的接口也可能回 `{ok:true, items:[]}`（假后端就干过），照着它
  // 把列表清空比"这次问不到"糟得多 —— 问不到只该退回浏览器缓存。
  if (o.ok !== true || o.kind !== 'layouts') return null;
  const items = cleanItems(o.items);
  const def = typeof o.default === 'string' && items.some(i => i.name === o.default) ? o.default : null;
  return { default: def, items };
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
