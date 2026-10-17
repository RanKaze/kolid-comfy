/**
 * 界面探针（UI Probe）—— 把"我现在屏幕上是什么样、为什么是这样"变成一次点击就能拿走的数据。
 *
 * 要解决的不是"抓不到数据"，而是**抓到的数据没法用**：DOM 快照有一万行、截图看不出 `flex-shrink`、
 * 控制台里没有那个 block 声明的尺寸、用户也没法把当时那一串拖拽复述一遍。所以这一层做三件事，
 * 缺一件这个回路就还是人工的：
 *
 *   1. **对齐两套真相。** 布局有两份数据：模型里的**声明尺寸**（用户拖出来的 `sz`）与浏览器里的
 *      **实际渲染尺寸**。绝大多数"这个块缩不下去""拖了没反应"都出在两者不一致，而单独看任何一份
 *      都看不出来 —— 必须逐节点摆在一起，带上算得出的 floor 和可拖区间。
 *   2. **先判后报。** 不把原始数据丢给人看，而是先跑一遍与回归测试同一套不变量（过订阅、边界冻结、
 *      被压到 floor 以下、声明与渲染不符、空巢仍占位、内容溢出、整页溢出、浮窗出界），把违反项
 *      连同数字一起报出来。一眼看到的是"哪条规则在哪里被破坏了"，不是"自己去读"。
 *   3. **留住上下文。** 抓快照那一刻，最近若干次交互（拖拽的 a/b/floor/lo/hi/want、投放的 fit、
 *      模式切换、视口变化、报错）都在环形缓冲里，和布局一起发走 —— "刚做了什么"与"现在是什么样"
 *      必须同时在场，才谈得上复现。
 *
 * 这一层是只读的：从不写 dock、不碰 localStorage、不改任何状态。
 */
import {
  DOCK_MIN_SZ, DOCK_SPLIT, dead, dockFloor, floorPct,
  type Dock, type DockNode, type DockRules, type UnitId,
} from '../dock/model';

// ── 构建戳 ───────────────────────────────────────────────────────────────────
// 由 vite 的 define 注入（见 vite.config.ts）。页面上的 build 与仓库里的源码是不是同一版，
// 是每次排查的第一个问题 —— 前几轮都栽在"改了但页面还是旧的"上，所以它进快照。
declare const __UI_PROBE_BUILD__: string | undefined;
export const PROBE_BUILD = typeof __UI_PROBE_BUILD__ === 'string' ? __UI_PROBE_BUILD__ : 'dev';

// ── 类型 ─────────────────────────────────────────────────────────────────────
export type ProbeLevel = 'error' | 'warn' | 'info';
export type ProbeNumber = number | string | boolean | null;

/** 一条被破坏的不变量。`numbers` 是证据：布局问题里没有数字的结论等于没结论。 */
export interface ProbeProblem {
  code: string;
  level: ProbeLevel;
  where: string;
  message: string;
  numbers?: Record<string, ProbeNumber>;
}

/** 一行布局事实：模型的声明与 DOM 的实际摆在一起。 */
export interface ProbeNodeRow {
  path: number[];
  depth: number;
  kind: 'b' | 's';
  /** 这个节点沿**父**轴算尺寸的方向；根节点没有父，为 null。 */
  axis: 'v' | 'h' | null;
  /** split 自己的排布方向（决定它内部怎么分）。block 为 null。 */
  dir: 'v' | 'h' | null;
  block?: string;
  ids?: UnitId[];
  mode?: string;
  work?: boolean;
  dead: boolean;
  drawn: boolean;
  /** 模型里的声明尺寸（沿父轴），没写过就是 null。 */
  declared: number | null;
  /** 沿父轴的实际渲染尺寸。 */
  rendered: number | null;
  rect: { x: number; y: number; w: number; h: number } | null;
  flex?: string;
  /** 作为"把手左侧那一个"时的可拖区间，与 SplitHandle 同源。 */
  travel: { lo: number; hi: number; floor: number; a: number; b: number; hit?: string; reachable?: boolean } | null;
  scroll: { w: number; h: number; cw: number; ch: number } | null;
  style: Record<string, string> | null;
}

export interface ProbeEvent { kind: string; t: number; [k: string]: unknown; }

export interface ProbeComponentRow {
  depth: number;
  name: string;
  host: boolean;
  key: string | null;
  props?: string;
}

export interface ProbeSnapshot {
  kind: 'kolid-ui-probe';
  version: number;
  build: string;
  id: string;
  at: string;
  label: string;
  page: {
    url: string;
    title: string;
    viewport: { w: number; h: number; dpr: number };
    screen: { w: number; h: number };
    ua: string;
    visibility: string;
    body: { innerW: number; bodyW: number; dockW: number };
  };
  host: { edit: boolean; units: number; store: string } | null;
  store: { key: string; bytes: number; raw: string | null } | null;
  outline: string;
  dock: { tree: DockNode; floats: Dock['floats']; rows: ProbeNodeRow[] } | null;
  problems: ProbeProblem[];
  components: ProbeComponentRow[];
  trace: ProbeEvent[];
}

// ── 注册：页面把"活的 dock"交给探针 ─────────────────────────────────────────
interface ProbeHost { dock: Dock; rules: DockRules; edit: boolean; }
let host: ProbeHost | null = null;
let hostAt = 0;
const listeners = new Set<() => void>();

/** 页面在渲染时登记当前 dock。探针只读它，不持有、不修改。 */
export function registerProbe(next: ProbeHost | null): void {
  host = next;
  hostAt = next ? Date.now() : 0;
  listeners.forEach(f => f());
}
export function subscribeProbe(f: () => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}
export const probeRegistered = (): boolean => !!host;
export const probeRegisteredAt = (): number => hostAt;

// ── 交互轨迹：环形缓冲 ──────────────────────────────────────────────────────
const TRACE_MAX = 240;
let seq = 0;
const trace: ProbeEvent[] = [];

export function note(kind: string, data: Record<string, unknown> = {}): void {
  trace.push({ kind, t: Date.now(), n: ++seq, ...data });
  if (trace.length > TRACE_MAX) trace.splice(0, trace.length - TRACE_MAX);
}
export const traceList = (): ProbeEvent[] => trace.slice();
export const traceClear = (): void => { trace.length = 0; seq = 0; };
export const traceMark = (kind: string, data: Record<string, unknown> = {}): void => {
  trace.push({ kind, t: Date.now(), n: ++seq, mark: true, ...data });
};

// ── DOM 读取 ────────────────────────────────────────────────────────────────
const STYLE_KEYS = [
  'display', 'position', 'flex', 'flexDirection', 'flexGrow', 'flexShrink', 'flexBasis',
  'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'width', 'height', 'boxSizing',
  'overflow', 'overflowX', 'overflowY', 'gap', 'padding', 'margin', 'zIndex',
];

export const dockRootEl = (): HTMLElement | null => document.querySelector('[data-dock-root]');
const drawnOf = (el: Element | null): HTMLElement[] =>
  el ? ([...el.children].filter(c => !(c as HTMLElement).classList.contains('dock-split')) as HTMLElement[]) : [];
const splitsOf = (el: Element | null): HTMLElement[] =>
  el ? ([...el.children].filter(c => (c as HTMLElement).classList.contains('dock-split')) as HTMLElement[]) : [];

// 指针**碰到**了没有，是一条独立的事实。把手算得再对，只要它被浮窗、编辑条或溢出的内容盖住，
// 指针就落不到它身上 —— 那表现是"拖完全没反应"，而且轨迹里连 drag.down 都不会有。
// 只看数字永远分不出这两种情况（"算法夹死"和"压根没收到指针"看起来都是不动），
// 所以每条边界的中心做一次命中测试，记下实际会收到指针的是谁。
const describeHit = (e: Element | null): string => {
  if (!e) return 'none';
  const raw = typeof e.className === 'string' ? e.className : '';
  const cls = raw.trim() ? '.' + raw.trim().split(/\s+/).join('.') : '';
  const blk = e.getAttribute('data-dock-block');
  return e.tagName.toLowerCase() + cls + (blk ? `[${blk}]` : '');
};
const hitAt = (e: HTMLElement | null): { hit: string; reachable: boolean } => {
  if (!e) return { hit: 'none', reachable: false };
  const r = e.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const inside = x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
  const got = inside ? document.elementFromPoint(x, y) : null;
  return { hit: inside ? describeHit(got) : 'off-screen', reachable: !!got && (got === e || e.contains(got)) };
};
const rectOf = (el: HTMLElement | null) => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
};
const along = (el: HTMLElement | null, axis: 'v' | 'h' | null): number => {
  if (!el || !axis) return 0;
  return axis === 'v' ? el.getBoundingClientRect().height : el.getBoundingClientRect().width;
};
const styleOf = (el: HTMLElement | null): Record<string, string> | null => {
  if (!el) return null;
  const c = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const k of STYLE_KEYS) out[k] = c.getPropertyValue(k.replace(/[A-Z]/g, m => '-' + m.toLowerCase()));
  return out;
};

/**
 * 把声明树与 DOM 逐层对齐成一张平表。对齐规则与渲染一致：**空巢不画、把手不算孩子**，
 * 于是两边都是"有东西的分支"按序配对。配不上就说明渲染与模型已经不同步 —— 那本身就是一条结论。
 *
 * 每个节点还捎上它作为"把手左侧那一个"时的可拖区间：`lo`/`hi` 的算法与 SplitHandle 逐字相同
 * （floor 取父 split 承担得起的那一份），所以探针报的"能拖多远"就是用户手上那把把手算出来的那个数。
 */
export function walkDock(tree: DockNode): { rows: ProbeNodeRow[]; mismatches: { where: string; detail: string }[] } {
  const rows: ProbeNodeRow[] = [];
  const mismatches: { where: string; detail: string }[] = [];
  const step = (node: DockNode, el: HTMLElement | null, path: number[], axis: 'v' | 'h' | null, depth: number): ProbeNodeRow => {
    const row: ProbeNodeRow = {
      path, depth, kind: node.t, axis,
      dir: node.t === 's' ? node.d : null,
      dead: dead(node), drawn: !!el,
      rect: rectOf(el),
      flex: el ? getComputedStyle(el).flex : undefined,
      style: styleOf(el),
      scroll: el ? { w: el.scrollWidth, h: el.scrollHeight, cw: el.clientWidth, ch: el.clientHeight } : null,
      declared: typeof node.sz === 'number' && node.sz > 0 ? node.sz : null,
      rendered: null, travel: null,
    };
    if (node.t === 'b') { row.block = node.ids[0]; row.ids = [...node.ids]; row.mode = node.mode; }
    else { row.work = node.work === true; }
    row.rendered = el && axis ? along(el, axis)
      : (row.rect ? (row.dir === 'v' ? row.rect.h : row.rect.w) : null);
    rows.push(row);

    if (node.t !== 's') return row;
    const live = node.ks.map((k, i) => ({ k, i })).filter(({ k }) => !dead(k));
    const kids = drawnOf(el);
    if (el && kids.length !== live.length) {
      mismatches.push({ where: '/' + path.join('.'),
        detail: `模型里 ${live.length} 个可见孩子，DOM 里画了 ${kids.length} 个` });
    }
    const box = kids.reduce((t, k) => t + along(k, node.d), 0) + DOCK_SPLIT * Math.max(0, kids.length - 1);
    const floor = dockFloor(box, kids.length || 1);
    const splits = splitsOf(el);
    live.forEach(({ k, i }, j) => {
      const kidEl = kids[j] ?? null;
      const childRow = step(k, kidEl, [...path, i], node.d, depth + 1);
      // 只有后面还有兄弟的孩子才谈得上"它右边那条把手"。
      if (j + 1 < live.length) {
        const a = along(kidEl, node.d);
        const b = along(kids[j + 1] ?? null, node.d);
        childRow.travel = {
          lo: Math.min(floor, a), hi: Math.max(a, a + b - floor), floor, a, b,
          ...hitAt(splits[j] ?? null),
        };
      }
    });
    return row;
  };
  step(tree, dockRootEl(), [], null, 0);
  return { rows, mismatches };
}

export const outlineOf = (n: DockNode): string => {
  if (n.t === 'b') {
    const sz = typeof n.sz === 'number' && n.sz > 0 ? ':' + n.sz : ':free';
    return `${n.ids[0]}${sz}${n.mode === 'v' || n.mode === 'h' ? '(' + n.mode + '×' + n.ids.length + ')' : ''}`;
  }
  const kids = n.ks.filter(k => !dead(k));
  return `${n.d}[${typeof n.sz === 'number' && n.sz > 0 ? n.sz + ' ' : ''}${kids.map(outlineOf).join(' | ')}]`;
};

// ── 不变量：与回归测试同一套判据 ─────────────────────────────────────────────
/** 供面板与文档共用的一段话：同一个数字在"哪里"和"哪个方向"上。 */
const sizeAlong = (r: ProbeNodeRow, axis: 'v' | 'h' | null): number =>
  r.rect && axis ? (axis === 'v' ? r.rect.h : r.rect.w) : 0;

export function checkProblems(
  rows: ProbeNodeRow[],
  mismatches: { where: string; detail: string }[],
  dock: Dock,
): ProbeProblem[] {
  const out: ProbeProblem[] = [];
  const label = (r: ProbeNodeRow): string =>
    r.kind === 'b' ? `block "${r.block}"（/.${r.path.join('.')}）` : `split ${r.dir}[${r.path.join('.') || '/'}]`;

  for (const m of mismatches) {
    out.push({ code: 'dom.model-mismatch', level: 'error', where: m.where || '/',
      message: `模型与 DOM 的孩子数不一致（${m.detail}）：渲染已经和模型不同步，`
        + '这时候看到的尺寸不能当作模型的证据，先搞清是哪一边落后了。',
      numbers: { detail: m.detail } });
  }

  for (const r of rows) {
    if (!r.drawn) continue;
    const where = r.path.join('.') || '/';

    // (1) 声明与渲染不符 —— 唯一能同时解释"缩不下去"和"拖了没动"的一对数字。
    if (r.kind === 'b' && r.declared !== null && r.rect && r.axis) {
      const shown = sizeAlong(r, r.axis);
      if (shown > 0 && Math.abs(r.declared - shown) > 2) {
        out.push({ code: 'block.declared-not-shown', level: 'warn', where,
          message: `${label(r)} 声明 ${r.declared}px，实际显示 ${shown}px（差 ${r.declared - shown > 0 ? '+' : ''}`
            + `${r.declared - shown}px）。声明总长超过了盒子，多出来的部分由可收缩的块按比例分摊，`
            + '所以拖动时边界跟不住指针 —— 看起来就是"缩不动"。',
          numbers: { axis: r.axis, declared: r.declared, shown, deficit: r.declared - shown, flex: r.flex ?? null } });
      }
    }

    // (2) 面积为零：还在树里、也确实画了，却什么都没占。
    if (r.kind === 'b' && r.rect && (r.rect.w <= 0 || r.rect.h <= 0)) {
      out.push({ code: 'block.zero-area', level: 'error', where,
        message: `${label(r)} 的实际面积是 ${r.rect.w}×${r.rect.h}：它看得见地占着位置，但没有任何可供指针落下的面积。`,
        numbers: { w: r.rect.w, h: r.rect.h } });
    }

    // (3) 把手区间塌成一点 —— "宽度无法变小"最典型的形态。
    if (r.travel && r.travel.hi - r.travel.lo < 1) {
      out.push({ code: 'split.frozen-boundary', level: 'warn', where,
        message: `${label(r)} 右边那条把手的可拖区间塌成了一点（lo=${r.travel.lo}, hi=${r.travel.hi}）：`
          + `它自己 ${r.travel.a}px、邻居 ${r.travel.b}px 都已经贴着 floor ${r.travel.floor}px，`
          + '这个方向再拖也不会动。指针还在走而界面不动，就是这一条。',
        numbers: { lo: r.travel.lo, hi: r.travel.hi, floor: r.travel.floor, self: r.travel.a, neighbour: r.travel.b } });
    }

    // (3b) 指针根本落不到把手上。这一条必须和 (3) 分开报：两者的**症状一样**（拖了不动），
    // 但原因正交 —— 一个是"算法把边界夹死了"，一个是"指针压根没交给它"。只报数字永远分不开，
    // 而轨迹里"没有 drag.down"正是后者唯一的指纹。
    if (r.travel && r.travel.reachable === false) {
      out.push({ code: 'split.unreachable', level: 'error', where,
        message: `${label(r)} 右边那条把手在 DOM 里被别的东西盖住了：指针落在它的中心时，`
          + `实际收到事件的是 ${r.travel.hit}。于是拖动**完全没反应**，连 drag.down 都不会产生 —— `
          + '和"边界被夹死"长得一样，但改这里要改的是遮挡，不是边界算法。',
        numbers: { hit: r.travel.hit ?? 'none', lo: r.travel.lo, hi: r.travel.hi } });
    }

    // (4) 内容比盒子大 —— 溢出被裁掉，用户看到的是"被截断"而不是"太小"。
    if (r.scroll && (r.scroll.w > r.scroll.cw + 2 || r.scroll.h > r.scroll.ch + 2)) {
      out.push({ code: 'content.overflow', level: 'info', where,
        message: `${label(r)} 的内容 ${r.scroll.w}×${r.scroll.h} 大于可见区 ${r.scroll.cw}×${r.scroll.ch}，多出的部分不可见。`,
        numbers: { contentW: r.scroll.w, contentH: r.scroll.h, clientW: r.scroll.cw, clientH: r.scroll.ch } });
    }
  }

  // (5) 每个 split：声明总长 vs 盒子。过订阅是上面那些现象的**上游**，单独报一次。
  for (const r of rows) {
    if (r.kind !== 's' || !r.drawn || !r.rect || !r.dir) continue;
    const kids = rows.filter(x => x.path.length === r.path.length + 1
      && x.path.slice(0, -1).join('.') === r.path.join('.'));
    if (kids.length < 2) continue;
    const box = sizeAlong(r, r.dir);
    const gaps = DOCK_SPLIT * (kids.length - 1);
    const declaredSum = kids.reduce((t, k) => t + (k.declared ?? 0), 0) + gaps;
    const free = kids.filter(k => k.declared === null).length;
    if (declaredSum > box + 1) {
      out.push({ code: 'split.oversubscribed', level: 'warn', where: r.path.join('.') || '/',
        message: `split ${r.dir}[${r.path.join('.') || '/'}] 里"有尺寸"的孩子声明合计 ${declaredSum}px，`
          + `盒子只有 ${box}px（超出 ${declaredSum - box}px），另有 ${free} 个孩子在分剩下的。`
          + '这是当前布局最上游的一处矛盾：下面那些"声明≠显示""把手冻结"多半由它派生。',
        numbers: { axis: r.dir, box, declaredSum, deficit: declaredSum - box, freeChildren: free } });
    }
  }

  // (6) 整页横向溢出：溢出时横向布局在一个比视口更宽的坐标系里分配，所有横向把手都会失真。
  const bodyW = document.body.scrollWidth;
  const innerW = window.innerWidth;
  if (bodyW > innerW + 1) {
    out.push({ code: 'page.spill', level: 'error', where: '/',
      message: `整页横向溢出 ${bodyW - innerW}px（内容 ${bodyW} > 视口 ${innerW}）：`
        + '横向把手拖到哪都会被这段多出来的宽度吃掉一部分，位移与指针不成比例。',
      numbers: { bodyW, innerW, over: bodyW - innerW } });
  }

  // (7) 浮窗出界：弹出去的窗口越界后既点不到也拖不回来。
  for (const f of dock.floats) {
    if (f.x + f.w < 8 || f.y + f.h < 8 || f.x > innerW - 8 || f.y > window.innerHeight - 8) {
      out.push({ code: 'float.out-of-view', level: 'warn', where: `float "${f.id}"`,
        message: `浮窗 "${f.id}" 在视口外（${Math.round(f.x)},${Math.round(f.y)} ${Math.round(f.w)}×${Math.round(f.h)}），指针够不到它。`,
        numbers: { x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.w), h: Math.round(f.h) } });
    }
  }

  const order: Record<ProbeLevel, number> = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

// ── 组件树：React fiber 走一遍 ───────────────────────────────────────────────
interface Fiber {
  tag?: number; type?: unknown; elementType?: unknown; key?: string | null;
  memoizedProps?: Record<string, unknown> | null;
  child?: Fiber | null; sibling?: Fiber | null;
}
const HOST_TAGS = new Set([3, 5, 6]);
// 一个 fiber 的"名字"藏在三个不同的地方，缺一个就会把整棵树报成只剩标签名：
//   1. 宿主元素 —— `type` 是字符串（'div'）；
//   2. 函数/类组件 —— `type` 是**函数**。这里必须单独认，`typeof fn === 'function'` 既不是
//      'string' 也不是 'object'，漏掉它整棵树的功能组件都会掉进兜底分支；
//   3. `memo()` / `forwardRef()` —— `type` 是个对象，真名在 `type`/`render` 里面再包一层。
const nameOfFiber = (f: Fiber): string => {
  const t = (f.type ?? f.elementType) as
    { displayName?: string; name?: string; type?: unknown; render?: unknown } | string | undefined;
  if (typeof t === 'string') return t;
  if (typeof t === 'function') {
    const fn = t as { displayName?: string; name?: string };
    return fn.displayName || fn.name || 'Anonymous';
  }
  if (t && typeof t === 'object') {
    if (t.displayName) return t.displayName;
    const inner = (t.type ?? t.render) as { displayName?: string; name?: string } | undefined;
    if (t.name) return t.name;
    if (inner && typeof inner === 'object' && (inner.displayName || inner.name)) {
      return (inner.displayName || inner.name) as string;
    }
    return 'Anonymous';
  }
  // `Fragment` / `StrictMode` 这些包的 `type` 是 Symbol，认不出名字，但**不是**未命名组件。
  return typeof t === 'symbol' ? 'Fragment' : 'Unknown';
};
/** props 只留"形状"：排查要的是数量和标识，不是把一整棵子树塞进快照。 */
function propsDigest(p: Record<string, unknown> | null | undefined): string {
  if (!p) return '';
  const bits: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (k === 'children') { bits.push(`children=${Array.isArray(v) ? '[' + v.length + ']' : typeof v}`); continue; }
    if (v === null || v === undefined) { bits.push(`${k}=null`); continue; }
    const ty = typeof v;
    if (ty === 'function') bits.push(`${k}=fn`);
    else if (typeof v === 'string') bits.push(`${k}=${v.length > 40 ? JSON.stringify(v.slice(0, 40)) + '…' : JSON.stringify(v)}`);
    else if (ty === 'number' || ty === 'boolean') bits.push(`${k}=${String(v)}`);
    else if (Array.isArray(v)) bits.push(`${k}=[${v.length}]`);
    else bits.push(`${k}=${ty === 'object' ? '{}' : ty}`);
  }
  return bits.join(' ');
}
export function componentTree(max = 600, maxDepth = 26): ProbeComponentRow[] {
  const root = document.getElementById('root');
  if (!root) return [];
  const key = Object.keys(root).find(k => k.startsWith('__reactContainer$'))
    || Object.keys(root).find(k => k.startsWith('__reactFiber$'));
  if (!key) return [];
  const start = (root as unknown as Record<string, Fiber | null>)[key];
  if (!start) return [];
  const out: ProbeComponentRow[] = [];
  const walk = (f: Fiber | null | undefined, depth: number): void => {
    let cur = f;
    while (cur && out.length < max && depth <= maxDepth) {
      const host = typeof cur.type === 'string' || HOST_TAGS.has(cur.tag ?? 0);
      out.push({ depth, name: nameOfFiber(cur), host, key: typeof cur.key === 'string' ? cur.key : null,
        props: host ? undefined : propsDigest(cur.memoizedProps) });
      walk(cur.child, depth + 1);
      cur = cur.sibling;
    }
  };
  walk(start.child, 0);
  return out;
}

// ── 快照 ────────────────────────────────────────────────────────────────────
const countUnits = (n: DockNode): number =>
  n.t === 'b' ? n.ids.length : n.ks.reduce((t, k) => t + countUnits(k), 0);

export function probeSnapshot(label = ''): ProbeSnapshot {
  const dock = host?.dock ?? null;
  const storeKey = host?.rules.store ?? 'sampler.drawDock';
  const raw = (() => { try { return localStorage.getItem(storeKey); } catch { return null; } })();
  const walked = dock ? walkDock(dock.tree) : { rows: [], mismatches: [] };
  const problems = dock ? checkProblems(walked.rows, walked.mismatches, dock) : [];
  const r = dockRootEl();
  const at = new Date();
  const id = `${at.toISOString().replace(/[:.]/g, '-')}${label ? '-' + label.replace(/[^\w-]+/g, '_') : ''}`;
  return {
    kind: 'kolid-ui-probe', version: 1, build: PROBE_BUILD, id, at: at.toISOString(), label,
    page: {
      url: location.href, title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      screen: { w: window.screen.width, h: window.screen.height },
      ua: navigator.userAgent, visibility: document.visibilityState,
      body: { innerW: window.innerWidth, bodyW: document.body.scrollWidth,
        dockW: r ? Math.round(r.getBoundingClientRect().width) : 0 },
    },
    host: dock ? { edit: host!.edit, units: countUnits(dock.tree), store: storeKey } : null,
    store: { key: storeKey, bytes: raw ? raw.length : 0, raw },
    outline: dock ? outlineOf(dock.tree) : '',
    dock: dock ? { tree: dock.tree, floats: dock.floats, rows: walked.rows } : null,
    problems, components: componentTree(), trace: traceList(),
  };
}

/** 面板上那一行摘要：问题按级别计数，最重的先说。 */
export function probeSummary(s: ProbeSnapshot): string {
  const by: Record<ProbeLevel, number> = { error: 0, warn: 0, info: 0 };
  for (const p of s.problems) by[p.level]++;
  if (!s.problems.length) return '未发现布局问题';
  const bits: string[] = [];
  if (by.error) bits.push(`${by.error} 个错误`);
  if (by.warn) bits.push(`${by.warn} 个警告`);
  if (by.info) bits.push(`${by.info} 条提示`);
  return bits.join(' · ');
}

// ── 运输：先送后端，送不到就退回剪贴板 ───────────────────────────────────────
/** `build` 是后端在收下快照时顺手算的"这个页面是不是旧产物" —— 它必须回传给页面： */
// "你先刷新一下"这类误判，只有在页面自己能说出"我这版比源码旧"时才会消失。
export interface ProbeSendResult {
  ok: boolean; file?: string; bytes?: number; error?: string;
  build?: { stale?: boolean; bundleAt?: string | null; newestSrc?: string };
}

let last: ProbeSnapshot | null = null;
export const probeLast = (): ProbeSnapshot | null => last;

// ── 投递地址 ───────────────────────────────────────────────────────────────
// 同源优先：真实 ComfyUI 里路由就长在页面自己身上。但**路由是后加的，而节点模块只在进程启动
// 时加载一次** —— "页面已更新、后端还是旧的"在开发期是常态，POST 过去只会 404。等一次重启
// 能解决，可选它当唯一出口就意味着：每次改完后端，UI 调试都得先重启一遍。
//
// 所以退一步：`sink`（temporary/ui_probe_sink.py）用**同一个存储模块**接收，落到同一个目录。
// 它只绑 127.0.0.1。上次成功过的那一个记下来，之后直接走它，不再每次试错。
export const PROBE_SINK = 'http://127.0.0.1:8791';
let goodBase: string | null = null;
const bases = (): string[] => {
  const all = ['', PROBE_SINK];
  return goodBase === null ? all : [goodBase, ...all.filter(b => b !== goodBase)];
};
/** 供其它模块（面板、拉取心跳）复用同一个"哪个地址通"的结论。 */
export const probeBases = (): string[] => bases();

export async function probeSend(label = ''): Promise<ProbeSendResult> {
  const snap = probeSnapshot(label);
  last = snap;
  const body = JSON.stringify(snap);
  let err = 'no endpoint';
  for (const base of bases()) {
    try {
      const res = await fetch(base + '/api/ui_probe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      });
      // 404/405 = 这条路上没有收件人（旧后端），不是数据的问题，换下一条。
      if (res.status === 404 || res.status === 405) { err = `HTTP ${res.status} @ ${base || 'same-origin'}`; continue; }
      if (!res.ok) { err = `HTTP ${res.status} @ ${base || 'same-origin'}`; continue; }
      const j = await res.json() as { ok?: boolean; file?: string; error?: string; build?: ProbeSendResult['build'] };
      if (j && j.ok === false) { err = j.error || 'rejected'; continue; }
      goodBase = base;
      return { ok: true, file: j && j.file, bytes: body.length, build: j && j.build };
    } catch (e) {
      // 连不上 = 这个地址不存在，试下一个。全都失败时，剪贴板那条路仍然可用。
      err = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: err, bytes: body.length };
}

// ── 拉取：把"去看一眼"的主动权也交出去 ─────────────────────────────────────
// 探针的意义是"他不必提供任何东西"。可如果每次都得他按一下键，那只是把粘贴换成了按键。
// 于是页面自己隔几秒问一次后端"现在要不要抓"，要就抓一份送上去 —— 之后由我这边发起即可。
const PULL_MS = 3000;
let pulling = false;
export function probePullWatch(): void {
  if (pulling) return;
  pulling = true;
  let handled = 0;
  window.setInterval(() => {
    void (async () => {
      for (const base of bases()) {
        let j: { want?: number };
        try {
          const r = await fetch(base + '/api/ui_probe/pull', { cache: 'no-store' });
          if (!r.ok) continue;
          j = await r.json() as { want?: number };
        } catch { continue; }
        if (typeof j.want === 'number' && j.want > handled) {
          handled = j.want;
          const out = await probeSend('pulled');
          note('probe.pulled', { want: j.want, ok: out.ok, file: out.file ?? null, error: out.error ?? null });
          try { await fetch(base + '/api/ui_probe/ack', { method: 'POST' }); } catch { /* 消不掉也只是多抓一次 */ }
        }
        return;
      }
    })();
  }, PULL_MS);
}

export async function probeCopy(label = ''): Promise<boolean> {
  const snap = probeSnapshot(label);
  last = snap;
  try { await navigator.clipboard.writeText(JSON.stringify(snap, null, 2)); return true; }
  catch { return false; }
}

export function probeDownload(label = ''): string {
  const snap = probeSnapshot(label);
  last = snap;
  const url = URL.createObjectURL(new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = `ui-probe-${snap.id}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return snap.id;
}

export const probeConfig = { DOCK_MIN_SZ, DOCK_SPLIT, floorPct };

/**
 * 只要结论，不要整份快照 —— 留给那个常驻的小角标。
 *
 * 角标每几秒就要知道"现在有几个问题"，而完整快照还包含组件树与轨迹（重得多）。把判别单独拎出来，
 * 常驻的代价就只剩一次 DOM 走查：几个 `getBoundingClientRect` 和一个 `getComputedStyle`。
 */
export function probeProblems(): ProbeProblem[] {
  if (!host) return [];
  const w = walkDock(host.dock.tree);
  return checkProblems(w.rows, w.mismatches, host.dock);
}

/**
 * 一段人能读、也能整段贴出去的短报告 —— 没有后端时的退路，也是"摘要"那颗按钮的内容。
 *
 * 刻意只留三样：**结论（问题）**、**证据（只列与问题相关的节点，加全部 block）**、**上下文（最近的
 * 交互）**。原始 JSON 有几百 KB，贴一段短报告和贴一个文件对拿到问题的人来说差别不大，但对读的人
 * 差别很大 —— 后者会被迫把无关的东西也读一遍，这正是要消掉的那部分工作。
 */
export function probeReport(s: ProbeSnapshot): string {
  const L: string[] = [];
  L.push(`# 界面探针快照 ${s.id}`);
  L.push(`build ${s.build} · ${s.at} · 视口 ${s.page.viewport.w}×${s.page.viewport.h}@${s.page.viewport.dpr}x · dock ${s.page.body.dockW}px`);
  const over = s.page.body.bodyW - s.page.body.innerW;
  L.push(`整页溢出：${over > 1 ? `横向 ${over}px` : '无'} · edit=${s.host?.edit ?? '?'} · 单位 ${s.host?.units ?? '?'} 个`);
  L.push(`布局：\`${s.outline}\``);
  L.push('');

  L.push(`## 问题（${s.problems.length}）—— ${probeSummary(s)}`);
  if (!s.problems.length) L.push('未发现违反不变量的地方。');
  s.problems.forEach((p, i) => {
    L.push(`${i + 1}. **[${p.level}] ${p.code}** @${p.where}`);
    L.push(`   ${p.message}`);
    if (p.numbers) L.push(`   \`${Object.entries(p.numbers).map(([k, v]) => `${k}=${String(v)}`).join(' ')}\``);
  });
  L.push('');

  const rows = s.dock?.rows ?? [];
  const interesting = new Set<string>();
  for (const p of s.problems) interesting.add(p.where);
  const pick = rows.filter(r => r.kind === 'b' || interesting.has(r.path.join('.') || '/'));
  if (pick.length) {
    L.push('## 布局事实（block 全列，split 只列被点名的）');
    L.push('| 节点 | 声明 | 显示 | flex | 可拖 lo–hi | 备注 |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    for (const r of pick) {
      const name = r.kind === 'b'
        ? `${r.block}${r.mode && r.mode !== 'default' ? '/' + r.mode : ''}${r.work ? ' (work)' : ''}`
        : `${r.dir}[${r.path.join('.') || '/'}]`;
      const notes: string[] = [];
      if (r.dead) notes.push('dead');
      if (r.kind === 'b' && r.declared !== null && r.rendered !== null && Math.abs(r.declared - r.rendered) > 2) notes.push(`差${r.declared - r.rendered}`);
      if (r.travel && r.travel.hi - r.travel.lo < 1) notes.push('把手冻结');
      // 把手被盖住和把手被夹死是两件事，表里必须分开写 —— 否则两种情况都只表现为"拖不动"。
      if (r.travel && r.travel.reachable === false) notes.push(`把手被盖(${r.travel.hit ?? '?'})`);
      if (r.scroll && (r.scroll.w > r.scroll.cw + 2 || r.scroll.h > r.scroll.ch + 2)) notes.push('内容溢出');
      L.push(`| ${'·'.repeat(r.depth)}${name} | ${r.declared ?? 'free'} | ${r.rendered ?? '—'} | ${r.flex ?? '—'} | ${r.travel ? `${Math.round(r.travel.lo)}–${Math.round(r.travel.hi)}` : '—'} | ${notes.join(' ') || ''} |`);
    }
    L.push('');
  }

  const interestingKinds = new Set(['drag.down', 'drag.move', 'drag.up', 'drag.release', 'drop', 'block.mode', 'error', 'resize', 'probe.panel', 'probe.sent']);
  const ev = s.trace.filter(e => interestingKinds.has(e.kind));
  if (ev.length) {
    L.push(`## 轨迹（最近 ${Math.min(ev.length, 30)} / 共 ${s.trace.length} 条）`);
    for (const e of ev.slice(-30)) {
      const rest = Object.entries(e).filter(([k]) => k !== 'kind' && k !== 't' && k !== 'n' && k !== 'mark')
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' ');
      L.push(`- \`${e.kind}\` ${rest}`);
    }
    L.push('');
  }
  if (s.store?.raw) {
    L.push(`## 保存的布局（${s.store.key}, ${s.store.bytes}B）`);
    L.push('```json');
    L.push(s.store.raw);
    L.push('```');
  }
  return L.join('\n');
}
