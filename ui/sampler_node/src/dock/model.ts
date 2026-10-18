// ── THE DOCK ────────────────────────────────────────────────────────────────────────────────
import type { ReactNode } from 'react';
// Where a unit sits is the user's call. Since the Block rework the page is a TILING: the area is cut
// into BLOCKS, a block is sized by the FRAME around it and never by its content, and the user drags
// the boundary between two blocks to resize them. There is no per-window handle any more: a window
// does not decide how big it is, the block it lives in does.
//
// What a block CONTAINS depends on its MODE:
//   * `default` — one dock window. Its units share it behind a tab strip (that is the tab mechanism,
//     and it stays: a window with several units is one title bar, and a switch moves nothing);
//   * `v` / `h` — a CONTAINER. One dock window per unit, stacked in that direction, each sizing to its
//     own content; the block scrolls when they do not fit, and a member folds to give its space back
//     to the others. That is the ONLY place a fold exists.
// Alt+P (toggled — press to enter, press again or Esc to leave) is the mode editor, the one place a
// block changes mode. A drop lands on a BLOCK and the
// block decides: the centre adds what arrived to it (more tabs in `default`, more stacked windows in
// `v`/`h`), an edge splits a fresh block off.
//
// A drop carries a SET of units, and the size of that set is the whole difference between the two drags
// the user makes on a window:
//   * an ITEM'S TITLE (a tab) carries ONE unit — the precise gesture: that unit leaves the tab group it
//     was sharing a window with and lands on its own;
//   * the window's HANDLE (the grip in its bar) carries EVERY unit of the window — the whole thing moves
//     at once, tab group and all, and is still that window where it lands.
// Both go through the same two verbs (dropUnits / dragOutUnits); neither knows which gesture it is
// serving, which is what keeps them from drifting apart.
//
// A unit is named by an id, and there are two kinds of name:
//   * a PANEL is one of a fixed set the page always has, so a saved layout that
//     loses, duplicates or invents one is not a layout and resets;
//   * a DOCUMENT (`doc:<uid>`) exists only while that document is open, so a saved layout naming a
//     closed one loses THAT NODE and keeps everything else — the alternative, a whole-page reset every
//     time a document is closed, would punish the layout for something the user did on purpose.
// The rules object is what tells the two apart; the page builds it, the dock obeys it, and nothing in
// this file names a unit — which is what lets a document ride the same arithmetic as a panel.
export type UnitId = string;

export const DOC_UNIT_PREFIX = 'doc:';
export const docUnit = (uid: string | number): UnitId => DOC_UNIT_PREFIX + uid;
// The uid a document unit was made from, or null when the id is a panel.
export const docUidOf = (id: UnitId): string | null =>
  id.startsWith(DOC_UNIT_PREFIX) ? id.slice(DOC_UNIT_PREFIX.length) : null;

// A block's mode. `default` = one window, `v`/`h` = a container stacking one window per unit.
export type DockMode = 'default' | 'v' | 'h';

export type DockRules = {
  // localStorage key this layout lives under.
  store: string;
  // The fixed set, in the order a reset stacks them. Every one must appear exactly once somewhere.
  panels: readonly UnitId[];
  // A unit the page has no body for is a hole in the panel: the drop payload and a saved tree are both
  // checked against this before they are believed.
  known: (id: UnitId) => boolean;
  title: (id: UnitId) => string;
  // toolbar 模式把 tab 换成一排图标，所以每一格都得有一个记号。记号归页面（它才知道这一格是什么），
  // 框架只负责在条子上把它画出来 —— 一颗没有记号的按钮，在一条只有按钮的 bar 上等于不存在。
  icon: (id: UnitId) => ReactNode;
  // May this unit be folded to its title bar? Only a unit with a permanent name — a fold is stored under
  // the unit's id, and an id that comes back pointing at something else (a document uid the workbench
  // hands out again from 1) must not carry an old choice onto the new owner. A fold only has anywhere
  // to go inside a container block, so this is asked of members of one.
  foldable: (id: UnitId) => boolean;
  // The unit's body IS live state rather than a view of state: a tab switch hides it with display:none
  // instead of unmounting it, because unmounting throws the state away.
  keepMounted: (id: UnitId) => boolean;
  // The unit's content owns its box — no card inset and no scroller of the dock's. A workbench and a
  // toolbar are both like this; what sets them apart is `grows`.
  fullBleed: (id: UnitId) => boolean;
  // The unit has no content height to size itself by, so INSIDE A CONTAINER it takes a share of the
  // block instead of sizing to its content — which for a workbench is the difference between a canvas
  // and a collapsed strip. Everything else in a container is exactly as tall as its content, and the
  // block scrolls when that adds up to more than the block has.
  grows: (id: UnitId) => boolean;
  // The shape the page opens with, and the shape "Reset layout" puts back: this row across the top
  // (if the page has one), then this column at this width with the work area beside it. The top row is
  // the one block whose height the page states instead of dragging — it is a strip of buttons, and a
  // share of the page would make it half the page.
  top: UnitId | null;
  topH: number;
  column: readonly UnitId[];
  columnW: number;
  // A page with panels on both sides of the work area names the far side here: a second column, stacked
  // the same way, at its own width. null = one column.
  right: readonly UnitId[] | null;
  rightW: number;
  // How much room a NEW block should take when this unit is dropped into the layout as one — a block
  // that does not exist yet has no size of its own, and "take the rest" is not an answer: the rest of a
  // column is the whole column, which is how appending a small window used to swallow the page.
  //
  // The size is asked for ALONG THE AXIS THE NEW BLOCK WILL BE MEASURED ON (`axis`), because it is the
  // side it was dropped beside that decides that: dropped under a block it is a height, dropped beside
  // one it is a width. It is a PREFERENCE, not a promise — the frame caps it so the block it is taken
  // from keeps its own floor, and nothing here ever makes the layout bigger than the box.
  //
  // Only the page can answer: a window of cards that scrolls has no height of its own, and the frame
  // measures nothing. This is the same question `popSize` answers for a popped-out window.
  blockSize: (id: UnitId, axis: 'v' | 'h') => number;
  // 这页自己的默认树。缺省走 `defaultDock`（top + column + work + right 那套）—— 那套假设页面
  // 至少有一根 column；像 Video 模式这种"几扇窗平铺"的页面得自己答。
  fallback?: () => Dock;
};

// `sz` is the size the user dragged this node to along its PARENT split's axis; absent means
// "take what is left". Only the boundary between two nodes is draggable, so only a node that sits in a
// split — a block, or a nest — carries one.
//
// A BLOCK is one rectangle of the page: one dock window in `default` mode, or a container of several in
// `v`/`h`. A node with no size is `1 1 0` — it shares what its siblings leave, which is what makes the
// tree tile the page with no dead space anywhere. Nothing in the tree sizes to its content.
// 容器的一格只有一个单元，这是此前全部的形状。`groups` 把"某一格是 tab 组"这件事记进同一块里：
// 它是一串**每格几个单元**的计数（和 `ids` 顺序一一对应，加起来等于 ids.length），所以容器还是
// 那个容器、mode 还是 'v'/'h'，只是其中一格的窗口上多了一条 tab 条。没有 groups 就是默认形状
// （一格一个），旧布局不用迁移。
//
// `shown` 记"这一格里用户点过要显示的是哪一个"：一条 tab 组里切换 tab 的选中项。它只是一个标记
// 列表（找得到就用，找不到就用组首），所以单元被拿走时只要过滤掉它，不会留下指向空处的东西。
// ── toolbar 模式 ────────────────────────────────────────────────────────────────────────────
// 一扇窗可以收成一条**图标条**：没有正文、没有下挂的容器，就是一条 bar，点其中一颗图标才在旁边
// 展开那格正文。它是一扇窗的**形状**，不是块的形状 —— 所以它跟着"窗"存，而不是跟着块存：
//   * `default` 块 / 浮窗：一扇窗就是整个盒子，开关记在 `tb`（`tbDir` 是用户用条上那颗小按钮
//     选的横 / 竖 —— 这两处没有容器的轴可借，方向得自己说）；
//   * 容器（`v`/`h`）：一扇窗是**一格**，开关记在 `tbs`，和 `groups` 一样是一串**每格一个**的
//     计数（0/1）。容器的轴就是条子的方向（竖排块 → 竖条 = 限宽；横排块 → 横条 = 限高），
//     不需要第二份方向。
// `tbs` 与 `groups` 必须一起搬、一起收缩：格从哪里来、到哪里去，开关就跟到哪儿 —— 拖走的
// 那一格本来是个 toolbar，落到哪儿都还是 toolbar。
export type DockBlock = {
  t: 'b'; ids: UnitId[]; sel: number; mode: DockMode; sz?: number; groups?: number[]; shown?: UnitId[];
  tb?: boolean; tbDir?: 'h' | 'v';
  /** 容器用：每格一个 0/1，与 `groupsOf` 一一对应。长度/取值不合规就整串不认（见 cellTbs）。 */
  tbs?: number[];
};
export type DockNode = DockBlock | { t: 's'; d: 'v' | 'h'; ks: DockNode[]; sz?: number; work?: true };
// A popped-out unit lives in viewport coordinates: it has to be able to sit on top of the workbench,
// which is not inside any column.
export type DockFloat = { id: UnitId; x: number; y: number; w: number; h: number; tb?: boolean; tbDir?: 'h' | 'v' };
// 拖拽载荷的**形状**：这组单元原来是不是一条 toolbar、朝哪边。搬家的每条路（并进容器、切新块、
// 插到缝上、泊回布局）都要把它带过去 —— 否则"把一条 toolbar 拖进另一个块"就等于当场把它拆回
// 一扇普通窗，用户看到的是 toolbar 解体了。
export type DragShape = { tb: boolean; dir: 'h' | 'v' };
export type Dock = { tree: DockNode; floats: DockFloat[] };
export type Zone = 'top' | 'bottom' | 'left' | 'right' | 'center';

export const DOCK_MIN_SZ = 96, DOCK_MAX_SZ = 1200;
export const FLOAT_W = 300, FLOAT_MIN_W = 220, FLOAT_MIN_H = 60;
// The floor under a dragged size. A size the PAGE stated below that floor — the toolbar strip's height —
// keeps its own floor instead: dragging the strip must hold it where the page put it rather than popping
// it up to DOCK_MIN_SZ on the first nudge. `was` is the size being replaced; absent means no size yet,
// which is the plain floor.
//
// `max` is the CEILING, and it has to be the caller's to state. `DOCK_MAX_SZ` is a sanity bound for sizes
// that arrive from somewhere other than a pointer — a saved tree, a drop layout, a default — where an
// absurd number would mean a corrupt file. A DRAG is bounded by something better: the box it is happening
// in (`hi`, see SplitHandle). Passing the constant there instead made the two disagree — the handle
// promised `hi` 1954, the write stopped at 1200, the tree came back byte-identical, and the drag reported
// `moved=120, commits=8` while the boundary never travelled. On a 2480px window that is exactly "the
// block next to this one cannot be made narrower": the only way to shrink it is to GROW a neighbour that
// is already sitting on the constant.
export const clampSz = (n: number, was?: number, max: number = DOCK_MAX_SZ) =>
  Math.min(max, Math.max(Math.min(DOCK_MIN_SZ, was ?? DOCK_MIN_SZ), Math.round(n)));

// The floor under a SHARE — which is a different question from the floor under a dragged size.
//
// A share is the frame's own division, so its floor has to come out of the box the frame HAS.
// `DOCK_MIN_SZ` is what a share wants; `box / (count + 1)` is what the box can afford, and the answer is
// the smaller of the two. The `+ 1` is what makes the floors of a split's children add up to LESS than
// the split: with n children at box/(n+1) each they come to n/(n+1) of it, so there is always room left
// to distribute — always one boundary that can still move.
//
// Without it the two numbers are unrelated and the split cannot fit: four free blocks in a short column
// want 4×96 + 3×8 px before anything else is accounted for, every one of them sits on its floor, and the
// boundary beside any of them refuses to move while the page spills instead. That state is exactly what
// "this block will not shrink, even at a third of the window" is: an absolute floor in a box that never
// agreed to it.
export const dockFloor = (box: number, count: number): number =>
  !(box > 0) || count < 1 ? DOCK_MIN_SZ : Math.max(1, Math.min(DOCK_MIN_SZ, Math.floor(box / (count + 1))));
// The same floor as a percentage, for the style that has to express it without measuring: `min-size` of
// a share is `min(DOCK_MIN_SZ, this%)`, which the browser resolves against the split's own box.
export const floorPct = (count: number): number => 100 / (Math.max(1, count) + 1);

// The width of the gap between two blocks — and the gap IS the handle: the strip the user grabs to move
// the boundary is the same strip they see between the cards, so aiming at it needs no extra chrome.
export const DOCK_SPLIT = 8;

// One block around a set of units, for the places that need a leaf and the page does not care how it
// looks. A set of ONE is the ordinary case; a set of SEVERAL is the shape a whole window takes when it
// moves — a window's units are a tab group, and moving the window means moving the group, so they land
// as one block with the strip they had, not as so many single windows.
const blockOf = (ids: readonly UnitId[], mode: DockMode = 'default', sz?: number): DockBlock =>
  ({ t: 'b', ids: [...ids], sel: 0, mode, sz });
const block = (id: UnitId, mode: DockMode = 'default', sz?: number): DockBlock =>
  blockOf([id], mode, sz);

// 一格的划分。`groups` 不合规（长度对不上、有 0、加起来不等于 ids）就退回"一格一个"，绝不拿一个
// 半信半疑的数组去切 ids —— 那个后果是某几个单元凭空消失。
export const groupsOf = (b: DockBlock): number[] => {
  const g = b.groups;
  if (Array.isArray(g) && g.length && g.length <= b.ids.length
    && g.every(n => Number.isInteger(n) && n > 0)
    && g.reduce((a, n) => a + n, 0) === b.ids.length) return [...g];
  return b.ids.map(() => 1);
};
// 容器真正的成员：一格一组（一组一个 id 就是老形状，一组多个就是那格的 tab 条）。
export const cellsOf = (b: DockBlock): UnitId[][] => {
  const out: UnitId[][] = [];
  let at = 0;
  for (const n of groupsOf(b)) { out.push(b.ids.slice(at, at + n)); at += n; }
  return out;
};
// 第 i 格的首个单元在 `ids` 里的下标 —— 重排、插入都在 ids 这个坐标系里说话，而格子是另一套下标。
export const cellStart = (b: DockBlock, i: number): number =>
  groupsOf(b).slice(0, i).reduce((a, n) => a + n, 0);

// 每格的 toolbar 开关，口径与 groupsOf 一致：长度对不上、值不是 0/1，就整串不认，渲染退回普通
// 窗口。宁可一列里少一条 toolbar，也不能拿一串半信半疑的下标去对格 —— 那会把开关戴到别人头上。
export const cellTbs = (b: DockBlock): number[] => {
  const n = groupsOf(b).length;
  const t = b.tbs;
  return Array.isArray(t) && t.length === n && t.every(v => v === 0 || v === 1) ? [...t] : new Array(n).fill(0);
};
// 收尾：一个开关都没开就把字段丢掉 —— 老形状少一个会出错的字段，存档也更小。
const packTbs = (t: readonly number[]): number[] | undefined => (t.some(v => !!v) ? [...t] : undefined);
// 同一套收尾，给 `groups`：一格一个的时候这串数组没有任何信息量（`groupsOf` 的默认值就是它），
// 存着只是多一处要跟着搬、跟着收缩、跟着出错的账。全 1 就丢掉，形状退回"一格一个"。
const packGroups = (g: readonly number[]): number[] | undefined => (g.some(n => n > 1) ? [...g] : undefined);

// The page opens as a tiling: the toolbar strip across the top (if the page has one), then the settings
// column at its own width, the work area taking everything else, and the panel column on the far side.
// Each column is ONE container block — the same look the page always had (the panels stacked in their
// column, the column scrolling), except that the column's width is now the user's to drag. Documents
// arrive into the work area through syncDocUnits — a reset can't name them, because which documents are
// open is not the layout's decision.
export const defaultDock = (r: DockRules): Dock => {
  const ks: DockNode[] = [{ t: 'b', ids: [...r.column], sel: 0, mode: 'v', sz: r.columnW }];
  if (r.right?.length) {
    // Panels on both sides need a middle, and the middle has to survive a document closing: `work` is
    // how the page says "a document with no window goes HERE", so pruneDocs and detach leave this nest
    // empty instead of folding it away and letting the next document land at the far end of the row.
    ks.push({ t: 's', d: 'h', ks: [], work: true });
    ks.push({ t: 'b', ids: [...r.right], sel: 0, mode: 'v', sz: r.rightW });
  }
  const row: DockNode = { t: 's', d: 'h', ks };
  return { tree: r.top ? { t: 's', d: 'v', ks: [block(r.top, 'default', r.topH), row] } : row, floats: [] };
};

export const dockUnits = (n: DockNode): UnitId[] => (n.t === 'b' ? n.ids : n.ks.flatMap(dockUnits));

// 只留通过 `ok` 的单元：树上少一个单元的所有后果（格空的消失、分支塌掉、分叉退成一条）都由
// `detach` 一个人说，这里只负责反复叫它。关掉一份文档、和把一份旧布局里早已不存在的面板剪掉，
// 是同一台手术 —— 所以两个调用方共用这一个实现，别各写一遍"重拼 ids"。
function keepOnly(n: DockNode, ok: (id: UnitId) => boolean): DockNode | null {
  if (n.t === 'b') {
    // 一个单元退出 = 这一格少一个单元。走 detach 而不是自己重拼 ids：格子的两串账（groups 与
    // tbs）都跟着同一套手术收缩，否则关掉一个 tab 会让整条 tab 组退回"一格一个"、整列 toolbar
    // 一起失效。块也照旧保着自己的 MODE：一个 v 块关掉手里的文档仍是容器。
    const dead = n.ids.filter(id => !ok(id));
    if (!dead.length) return n;
    return dead.reduce<DockBlock | null>((acc, id) => (acc ? detach(acc, id) as DockBlock | null : null), n);
  }
  const kept = n.ks.map(k => keepOnly(k, ok)).filter((k): k is DockNode => !!k);
  // An emptied nest is a hole unless the page marked it as the work area — that one stays, empty, so the
  // next document still lands between the columns rather than at the end of the row.
  if (!kept.length) return n.work ? { ...n, ks: kept } : null;
  // A split this pass did not empty keeps its shape. A page with nothing open has a work row holding
  // only the settings column, and that is the row the first document is placed into — folding it away
  // here would leave no row at all, and the document would land beside the toolbar instead of under it.
  if (kept.length === n.ks.length) return { ...n, ks: kept };
  if (kept.length === 1) return kept[0];
  return { ...n, ks: kept };
}

// Take the nodes that name a document the page does not have. A panel name is left alone here — an
// unknown panel is a broken layout, not a closed document, and the caller resets for that.
const pruneDocs = (n: DockNode, isAlive: (id: UnitId) => boolean): DockNode | null =>
  keepOnly(n, id => !docUidOf(id) || isAlive(id));

// A saved layout is a plausible file, not a trusted one: a store written by an older page has `u`/`g`
// nodes this model no longer knows, and a hand-edited one can hold anything at all. Both are read as
// untyped data, so the shape is checked before the arithmetic gets to walk it.
function isNode(n: unknown): n is DockNode {
  const x = n as DockNode & { ids?: unknown; ks?: unknown };
  if (!x || typeof x !== 'object') return false;
  if (x.t === 'b') {
    return Array.isArray(x.ids) && x.ids.length > 0 && x.ids.every(i => typeof i === 'string')
      && (x.mode === 'default' || x.mode === 'v' || x.mode === 'h');
  }
  // `ks` 允许为空：工作台那条标记为 work 的 nest，**在没有文档时就该是空的** —— defaultDock 自己也带
  // 一条空的（`ks: []`，下一个文档就落在那儿）。画布一旦被拖走存档里就会留这么一条，此前要求
  // `ks.length > 0` 会把整份存档判成不认识、回退默认布局 —— 用户给画布挑的位置每次刷新都丢，
  // 而且丢的是**整棵树**（其余面板看着"还行"，只是默认布局恰好长得一样）。
  if (x.t === 's') return (x.d === 'v' || x.d === 'h') && Array.isArray(x.ks) && x.ks.every(isNode);
  return false;
}

// 已经**不再是独立窗口**的单元：`mask` 并进了 Guidances 那一格，成为它的第一行（见
// workbench/mask.tsx 的 MaskRow）。老存档里它还是单独的一格，直接判"不认识的单元"会把用户整份
// 布局退回默认 —— 那就不是"取消一扇窗"，而是"顺手把整个页面重排一遍"。所以存档读进来先把它拆掉，
// 剩下的树照旧认：少那一格，别的原地不动。
const RETIRED_UNITS: UnitId[] = ['mask'];

// 一份存档"还能装"与"装得上"是两件事。树都没有（老页面写的 `u`/`g` 节点、手改坏的文件）才退回
// 默认 —— 那时整棵树都在说这套模型不认的语言。除此之外交给 `fitLayout` 去救：剪掉不认识的单元、
// 补上缺的面板、重复的只留一处。
//
// 这不只是用户点 Load 时的口径，也必须是**页面自己读档那一次**的口径。面板集合是会变的（多一格
// Layout、少一格 Mask），而旧存档必然缺一个或多一个单元；按"一个不对就整份退回默认"处理，等于每次
// 动面板都顺手把所有人的布局重排一遍 —— 用户摆了很久的页面，刷新一次就没了。
//
// 文档单元照旧**原样读入**（`fitLayout` 对它只要求形状）：刷新时工作台自己也刚加载，它还一份
// 文档都没播报过；此刻把 doc:* 剪掉，等播报到来就只能按"新来的文档"安放 —— 画布窗口每次刷新都
// 跳回默认位置。剪掉的活儿交给 syncDocUnits，那一侧才知道"哪份文档真的没开"。
export function loadDock(rules: DockRules): Dock {
  const fallback = rules.fallback ? rules.fallback() : defaultDock(rules);
  try {
    const raw = localStorage.getItem(rules.store);
    if (!raw) return fallback;
    const fit = fitLayout(rules, JSON.parse(raw));
    return fit ? fit.dock : fallback;
  } catch { return fallback; }
}

// ── 一份**用户存下来**的布局，装回来时过的那道关 ──────────────────────────────────────
// 读档（loadDock）的口径是"不对就整份退回默认"—— 那是页面自己那一次，宁可保守。但用户点 Layout
// 那一格里的 Load 时，想的是"把这一份摆回来"：那份存档可能存自面板集合不同的版本、可能带着早已
// 并进别处的单元（mask 那一类）、也可能被人手改过。所以这里的口径是**能救就救** ——
// 不认识的剪掉、缺的面板补进最长的块、重复的只留一处，剩下的原样装回。
//
// 返回 null 只代表一件事：这根本不是一份布局（连树都没有）。
export type LayoutFit = {
  dock: Dock;
  /** 这份布局里有、这一页认不出的单元（老版本 / 别的面板集合）—— 已经剪掉了。 */
  dropped: UnitId[];
  /** 这一页有、这份布局里没有的单元 —— 已经补进去了（多半是后来新加的面板）。 */
  added: UnitId[];
};

export function fitLayout(rules: DockRules, value: unknown): LayoutFit | null {
  const fallbackTree = () => (rules.fallback ? rules.fallback().tree : defaultDock(rules).tree);
  const saved = value as { tree?: unknown; floats?: unknown } | null;
  if (!saved || typeof saved !== 'object' || !isNode(saved.tree)) return null;
  const ok = (id: UnitId) => !RETIRED_UNITS.includes(id) && (rules.known(id) || !!docUidOf(id));
  const dropped: UnitId[] = [];
  const added: UnitId[] = [];
  const cut = (id: UnitId) => { if (!dropped.includes(id)) dropped.push(id); };

  const walk = (n: DockNode) => {
    if (n.t === 'b') n.ids.forEach(id => { if (!ok(id)) cut(id); });
    else n.ks.forEach(walk);
  };
  walk(saved.tree);
  // 整棵树都被剪空（一份全是老面板的存档）时退回默认的那棵树，而不是硬留一棵认不出的树。
  let tree = keepOnly(saved.tree, ok) ?? fallbackTree();

  // 浮窗：同一个筛子，另加"一扇窗不能有两条记录"—— 两条记录就是两个视口压在同一份可变状态上。
  // 坐标也顺手夹一道：存档里一个 NaN 能把这扇窗丢到画布外，用户看到的是"布局丢了"。
  const floats: DockFloat[] = [];
  const num = (v: unknown, d: number, lo: number, hi: number) =>
    (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  for (const f of (Array.isArray(saved.floats) ? saved.floats : []) as DockFloat[]) {
    if (!f || typeof f.id !== 'string') continue;
    if (!ok(f.id)) { cut(f.id); continue; }
    // 同一扇窗在树里已经有一份（或前面已经收过一条浮窗）时，这条浮窗记录就是多余的 —— 静默丢掉，
    // 它不算"这一页认不出的面板"。
    if (floats.some(g => g.id === f.id) || dockUnits(tree).includes(f.id)) continue;
    floats.push({
      id: f.id,
      x: num(f.x, 80, 0, 4000), y: num(f.y, 80, 0, 4000),
      w: num(f.w, FLOAT_W, FLOAT_MIN_W, DOCK_MAX_SZ), h: num(f.h, 320, FLOAT_MIN_H, DOCK_MAX_SZ),
      tb: f.tb ? true : undefined, tbDir: f.tbDir === 'v' ? 'v' : f.tbDir === 'h' ? 'h' : undefined,
    });
  }

  // 同一个单元出现两次：两处都拆掉，交给下面"缺的补进来"放回一处。留一处听着更省事，可"留哪
  // 一处、同格里的 tab 与 toolbar 开关跟谁走"没有正确答案 —— 而"这一处不算数、请回它该在的那
  // 一块"有。
  const all = dockUnits(tree).concat(floats.map(f => f.id));
  const dupes = all.filter((id, i) => all.indexOf(id) !== i);
  if (dupes.length) tree = detachAll(tree, dupes) ?? fallbackTree();

  // 缺的面板进"最长的那个块"：一块里单元最多的地方就是用户心里的那一列，而"它当初放哪儿"这份
  // 布局并没有说（那正是它缺着的原因）。
  const present = () => dockUnits(tree).concat(floats.map(f => f.id));
  for (const id of rules.panels) {
    if (present().includes(id)) continue;
    const b = biggestBlock(tree);
    if (!b) break;
    tree = dropInDock({ tree, floats }, id, b.ids[0], 'center').tree;
    added.push(id);
  }
  return { dock: { tree, floats }, dropped, added };
}

// The document units a tree and its windows hold.
const heldDocs = (dock: Dock): UnitId[] =>
  dockUnits(dock.tree).concat(dock.floats.map(f => f.id)).filter(id => !!docUidOf(id));

// A document with no window yet gets one where documents already live: tabbed into the box that shows
// one, so a second one does not halve the work area — they share a window behind a strip until the user
// drags one out. With none in the tree the work area is the nest the page marked for it; a page that
// marked none has one row, so the document joins that row.
function appendToWork(n: DockNode, leaf: DockNode): DockNode | null {
  if (n.t !== 's') return null;
  if (n.work) return { ...n, ks: [...n.ks, leaf] };
  for (let i = 0; i < n.ks.length; i++) {
    const r = appendToWork(n.ks[i], leaf);
    if (r) return { ...n, ks: n.ks.map((k, j) => j === i ? r : k) };
  }
  return null;
}
// Add units to the block that already owns `id`, as further members — which the block renders as
// further tabs (`default`) or further stacked windows (`v`/`h`). That is the whole of a centre drop.
// 往一个块里接单元。`default` 是加 tab；容器是**多一格**：带着 tab 组（groups）的容器必须显式
// 记下这一格多出来的那一个，否则 sum 对不上，`groupsOf` 会整体退回"一格一个"，用户刚叠好的
// tab 组就散开了。
//
// `!h.groups` **不是**"这个容器没有格"：没有 `groups` 只是"每格一个单元"的简写（见 groupsOf），
// 而拖来的东西可能是一条 toolbar —— 一格一个的老容器照样要记下这一格的开关。早先这里连同
// `!h.groups` 一起提前返回，于是"拖一条 toolbar 进一个还没并过 tab 的容器"就整格丢了形状，
// 用户看到的是 toolbar 一落地就解体。
const appendToBlock = (h: DockBlock, add: readonly UnitId[], shape?: DragShape): DockBlock => {
  const ids = [...h.ids, ...add];
  if (h.mode === 'default') return { ...h, ids };
  const g = groupsOf(h);
  // 新来的一格：**形状跟着拖来的那扇窗走** —— 拖的是一条 toolbar，落进容器还是一格 toolbar；
  // 拖的是一扇普通窗，就是普通窗。`tbs` 与 `groups` 必须同长，否则整串失效、整列的开关都丢了。
  const ts = cellTbs(h);
  const bit = shape?.tb ? 1 : 0;
  return { ...h, ids, groups: packGroups([...g, ...add.map(() => 1)]), tbs: packTbs([...ts, ...add.map(() => bit)]) };
};
const addAllToBlock = (n: DockNode, id: UnitId, add: readonly UnitId[], shape?: DragShape): DockNode =>
  rewriteHolder(n, id, h => (h.t === 'b' ? appendToBlock(h, add, shape) : h));
const addToBlock = (n: DockNode, id: UnitId, add: UnitId, shape?: DragShape): DockNode => addAllToBlock(n, id, [add], shape);
// The mirror of appendToRow: a container, so the unit lands stacked with its kind rather than beside the
// whole column. Children are searched before the node itself, so an inner container wins over an outer.
function appendToContainer(n: DockNode, id: UnitId, shape?: DragShape): DockNode | null {
  if (n.t === 'b') return n.mode !== 'default' ? appendToBlock(n, [id], shape) : null;
  for (let i = 0; i < n.ks.length; i++) {
    const r = appendToContainer(n.ks[i], id);
    if (r) return { ...n, ks: n.ks.map((k, j) => j === i ? r : k) };
  }
  return null;
}
// The longest block in the tree — the fallback home for a unit with nowhere better to go: a page whose
// every block is `default` has no container to stack into, and the busiest block is the one the user
// thinks of as "the column".
function biggestBlock(n: DockNode): DockBlock | null {
  if (n.t === 'b') return n;
  return n.ks.reduce<DockBlock | null>((best, k) => {
    const b = biggestBlock(k);
    return b && (!best || b.ids.length > best.ids.length) ? b : best;
  }, null);
}
// 新到的文档窗要**当场露脸**（用户报的"Load 了一份 .cud，屏幕上还是上一份"）：它落进哪一格，
// 就把那一格的选中项拨到它 —— 写法和手动点 tab（DockView 的 `pick`）完全同一种：容器格记在
// `shown` 上（只动这一格显示谁），`default` 块记在 `sel` 上。浮窗不用挑，它永远显示自己。
export const revealDoc = (dock: Dock, id: UnitId): Dock => {
  if (dock.floats.some(f => f.id === id)) return dock;
  const tree = rewriteHolder(dock.tree, id, n => {
    if (n.t !== 'b' || !n.ids.includes(id)) return n;
    const cell = n.groups ? cellsOf(n).find(c => c.includes(id)) : null;
    if (cell) return { ...n, shown: [...(n.shown ?? []).filter(u => !cell.includes(u)), id] };
    return { ...n, sel: Math.max(0, n.ids.indexOf(id)) };
  });
  return { ...dock, tree };
};

function placeDoc(dock: Dock, id: UnitId): Dock {
  const shown = dockUnits(dock.tree).find(u => !!docUidOf(u));
  // 住进现成的文档窗：接完 tab 把选中项拨到新来的这一份 —— 否则 Load 之后屏幕上还是上一份工程。
  if (shown) return revealDoc(dropInDock(dock, id, shown, 'center'), id);
  const leaf: DockNode = block(id);
  return { ...dock, tree: appendToWork(dock.tree, leaf) || appendToRow(dock.tree, leaf) || { t: 's', d: 'h', ks: [dock.tree, leaf] } };
}

// 一个单元换个名字 —— 树上每一处都换（一格的 `ids`、它的 tab 选中项 `shown`），浮窗上也换。
//
// 为什么需要这个动词：文档窗的**位置**属于布局，不属于某一刻那份文档。uid 是工作台每趟会话自己发的
// （从 1 数起），"布局里记着 doc:1、这一趟开出来的是 doc:2"是完全正常的事 —— 而"剪掉再把新的放到
// 工作区末尾"就是在说"那个位置只属于上一趟那份工程"。用户摆的是"画布在这一列中间"，不是"doc:1 在
// 这一列中间"。所以先换名字，位置、尺寸、tab 组、toolbar 开关一概原地不动。
const renameUnit = (n: DockNode, from: UnitId, to: UnitId): DockNode => {
  if (n.t === 'b') {
    if (!n.ids.includes(from)) return n;
    return {
      ...n,
      ids: n.ids.map(id => (id === from ? to : id)),
      shown: n.shown?.map(id => (id === from ? to : id)),
    };
  }
  return { ...n, ks: n.ks.map(k => renameUnit(k, from, to)) };
};

// Keep the layout in step with the documents the page actually has: a closed one loses its node and
// nothing else, a newly opened one joins the work area, and one the user already placed keeps that
// place. Panels are never touched here — they are the fixed set, and a layout missing one is broken.
//
// `keepSlots`：此刻的文档集**还不知道**（开机时工作台还没打开任何工程，播报来的是空表）。这时空表
// 不等于"都关了" —— 剪掉存档里的画布格，等用户真开一个工程，它只能按"新来的"安放到工作区末尾，
// 画布于是每次都从"这一列中间"跳到"整片工作区最右边"，而且再也回不去（那一次剪枝已经把位置删了）。
// 开机摆布局、以及载入一份存档时传 true：没有文档认领的文档格先留着（它渲染成空洞、不占屏幕，
// 见 `dead`），下一份文档进来就能原地接上。
export function syncDocUnits(dock: Dock, open: readonly UnitId[], keepSlots = false): Dock {
  const held = heldDocs(dock);
  const missing = open.filter(id => !held.includes(id));
  const stale = held.filter(id => !open.includes(id));
  if (!missing.length && !stale.length) return dock;
  // 先配对：一格新文档接一格没人认领的旧格，换名字，位置留着。多出来的旧格才真按"关掉了"处理。
  const pairs = missing.slice(0, stale.length).map((id, i) => [stale[i], id] as const);
  let moved: Dock = dock;
  for (const [from, to] of pairs) {
    moved = {
      tree: renameUnit(moved.tree, from, to),
      floats: moved.floats.map(f => (f.id === from ? { ...f, id: to } : f)),
    };
  }
  const leftStale = stale.slice(pairs.length);
  const alive = new Set<UnitId>([...open, ...(keepSlots ? leftStale : [])]);
  const isAlive = (id: UnitId) => !docUidOf(id) || alive.has(id);
  const pruned: Dock = { tree: pruneDocs(moved.tree, isAlive) || moved.tree, floats: moved.floats.filter(f => isAlive(f.id)) };
  const leftMissing = missing.slice(pairs.length);
  // Nothing arrived and nothing left: hand back the SAME dock, which is how the caller tells a
  // re-announcement apart from a real change without diffing a tree.
  if (!leftMissing.length) return pruned;
  return leftMissing.reduce((acc, id) => placeDoc(acc, id), pruned);
}

export const holds = (n: DockNode, id: UnitId): boolean => n.t === 'b' && n.ids.includes(id);
// Take a unit out of the tree. Removing a child is what collapses what it leaves behind (an empty
// branch, or a split down to one child) — but NOT a block down to one unit: a block keeps its mode, and
// a `v` block that was just emptied of everything but one unit is still the container the user made.
// A pass that removes nothing restructures nothing, so the same rule pruneDocs follows applies here too
// — the row a page opens with must survive being touched by an operation about a unit that is not in it.
export function detach(n: DockNode, id: UnitId): DockNode | null {
  if (n.t === 'b') {
    const i = n.ids.indexOf(id);
    const ids = n.ids.filter(x => x !== id);
    if (!ids.length) return null;
    // 分组跟着一起收拾：那格少一个；空了就整格消失；退化成"一格一个"时把 groups 丢掉，
    // 让老形状重新成为老形状（少存一个字段，也少一处会出错的地方）。
    // toolbar 开关是同一件事的第二串：格子消失了，它那一格的开关键也跟着消失。
    let groups = n.groups;
    let tbs = n.tbs;
    if (i >= 0 && (groups || tbs)) {
      const g = groupsOf(n);
      let at = 0, gi = 0;
      for (; gi < g.length; gi++) { if (i < at + g[gi]) break; at += g[gi]; }
      const emptied = g[gi] - 1 <= 0;
      if (tbs) { const t = cellTbs(n); if (emptied) t.splice(gi, 1); tbs = packTbs(t); }
      if (groups) {
        g[gi] -= 1;
        if (emptied) g.splice(gi, 1);
        groups = g.length === ids.length && g.every(k => k === 1) ? undefined : g;
      }
    }
    return {
      ...n, ids, sel: Math.min(n.sel, ids.length - 1), groups, tbs,
      shown: n.shown?.filter(u => u !== id),
    };
  }
  const kept = n.ks.map(k => detach(k, id)).filter((k): k is DockNode => !!k);
  if (!kept.length) return n.work ? { ...n, ks: kept } : null;
  if (kept.length === n.ks.length) return { ...n, ks: kept };
  if (kept.length === 1) return kept[0];
  return { ...n, ks: kept };
}
// Take a SET of units out of the tree in one pass: every removal collapses what it leaves behind
// exactly as a single detach does, and the result is measured once, at the end. `null` means the tree
// would be gone altogether — the callers keep the old tree then, the same defensive answer a single
// detach gets, because a page with no tree has nothing to draw.
const detachAll = (n: DockNode, ids: readonly UnitId[]): DockNode | null =>
  ids.reduce<DockNode | null>((acc, id) => (acc ? detach(acc, id) : null), n);
// Rewrite the node that directly owns `id` (the block the unit is a member of).
export function rewriteHolder(n: DockNode, id: UnitId, fn: (holder: DockNode) => DockNode): DockNode {
  if (holds(n, id)) return fn(n);
  if (n.t === 's') return { ...n, ks: n.ks.map(k => rewriteHolder(k, id, fn)) };
  return n;
}
// Alt+P's only write: the block that owns `id` changes mode.
//   * `v`/`h` gather the block's units into one container — one window each;
//   * `default` SPREADS a container the other way: every window becomes a block of its own.
// A block that is already `default` keeps its window and its tab strip: one window holding several units
// is a tab group, which is a shape to keep, not something to spread.
//
// Spreading is a FRAME operation and nothing else. The split the blocks land in INHERITS the size the
// container had, so the box does not move under the user; the blocks inside it all start free, which
// divides that box evenly and leaves every boundary to the first drag. What a window was showing has no
// say in any of it: a container scrolls when its content does not fit, so a measured content size is not
// a size the frame ever handed out — sizing blocks by it is exactly how a drag ends up fighting the
// content (lopsided content starves one block, the split overflows, and the boundary stops following
// the pointer). The user reshapes from the even split; the content never votes.
export const setBlockMode = (dock: Dock, id: UnitId, mode: DockMode): Dock => ({
  ...dock, tree: rewriteHolder(dock.tree, id, h => (h.t === 'b' ? switchMode(h, mode) : h)),
});
const switchMode = (h: DockBlock, mode: DockMode): DockNode => {
  // 变成容器：一格一个。分组与选中留在身后 —— 容器的每一格本来就是一个窗口。toolbar 也一样：
  // 一条 toolbar 摊成容器，就是若干条各自独立的窗口，没有哪一格继承那个形状。
  if (mode !== 'default') return { ...h, mode, groups: undefined, shown: undefined, tb: undefined, tbs: undefined };
  const cells = cellsOf(h);
  if (cells.length < 2) {
    // 一格：也就是一扇窗。它原来是不是 toolbar，换过 mode 还是不是（方向取容器的轴）。
    return {
      ...h, mode: 'default', groups: undefined, shown: undefined, tbs: undefined,
      tb: cellTbs(h)[0] ? true : undefined, tbDir: h.mode === 'h' ? 'h' : 'v',
    };
  }
  const d: 'v' | 'h' = h.mode === 'h' ? 'h' : 'v';
  // 摊开时**按格摊**：一格一个块。带着 tab 组的那一格摊出来仍是一个 tab 组（两个 tab 占一个块），
  // 而不是把组拆散成两个窗口 —— 用户点的是"摊开容器"，不是"拆散我的 tab"。哪一格是 toolbar，
  // 摊出来的那个块还是 toolbar，方向就是容器原来的轴。
  const tbs = cellTbs(h);
  return {
    t: 's', d, sz: h.sz,
    ks: cells.map((c, i) => ({
      t: 'b', ids: c, sel: 0, mode: 'default',
      ...(tbs[i] ? { tb: true, tbDir: d } : null),
    })),
  };
};

// ── toolbar 模式的唯一写口 ────────────────────────────────────────────────────────────────
// `id` 可以是容器里的一员、`default` 块里的某一个、或一个浮窗 —— 三种窗住在三种容器里，开关存在
// 三个地方（容器：`tbs` 的一格；`default`：`tb`；浮窗：float.tb），但用户的手势只有一颗按钮。
//
// `dir` 只在"没有容器的轴可借"的两个地方有意义（`default` 块、浮窗）：条子横着还是竖着是用户用
// 条上那颗小按钮选的，所以得跟着窗一起存。容器里不问方向 —— 竖排块的格就是竖条（限宽），横排块
// 的格就是横条（限高），这是块类型说的话。
export const setToolbarDock = (dock: Dock, id: UnitId, on: boolean, dir?: 'h' | 'v'): Dock => {
  const fi = dock.floats.findIndex(f => f.id === id);
  if (fi >= 0) {
    return {
      ...dock,
      floats: dock.floats.map((f, i) => (i === fi
        ? { ...f, tb: on ? true : undefined, tbDir: dir ?? f.tbDir ?? 'h' }
        : f)),
    };
  }
  return {
    ...dock,
    tree: rewriteHolder(dock.tree, id, h => {
      if (h.t !== 'b') return h;
      if (h.mode === 'default') {
        // `tbDir` 关了也不清：下次打开还是用户上次挑的那一边。
        return { ...h, tb: on ? true : undefined, tbDir: dir ?? h.tbDir ?? 'h' };
      }
      const i = cellsOf(h).findIndex(c => c.includes(id));
      if (i < 0) return h;
      const t = cellTbs(h);
      t[i] = on ? 1 : 0;
      return { ...h, tbs: packTbs(t) };
    }),
  };
};
// `default` 块 / 浮窗上那颗很小的横竖按钮。容器里没有这一手（方向由容器的轴说了算），所以这里
// 对容器什么也不做 —— 一颗按下去没反应的方向键比没有这颗键更让人糊涂。
export const setToolbarDirDock = (dock: Dock, id: UnitId, dir: 'h' | 'v'): Dock => {
  const fi = dock.floats.findIndex(f => f.id === id);
  if (fi >= 0) return { ...dock, floats: dock.floats.map((f, i) => (i === fi ? { ...f, tbDir: dir } : f)) };
  return {
    ...dock,
    tree: rewriteHolder(dock.tree, id, h => (h.t === 'b' && h.mode === 'default' ? { ...h, tbDir: dir } : h)),
  };
};

// 块内重排：把 `id` 挪到它所在块的 `to` 位。`to` 是**移除它之后**的目标下标 —— 拖到最末尾就是
// `ids.length - 1`，这样"第几位"与指针停下时数出来的位置是同一个数，中间不用再换算一次。
//
// 一件容易被忘掉的事：`sel` 是这块**正在显示**的那个单元的下标，而它是个下标。顺序一变它就指向了
// 别人 —— 用户只是把一个窗口往上挪了一格，正在看的正文却被换掉了。所以 `sel` 跟着它原来指的那个
// 单元走，而不是原地不动。
//
// 这也是"顺序"唯一诚实的存处：块里成员的顺序就是 `ids` 的顺序，DOM 只是照着画。改 DOM 不改 `ids`
// 就是一次重排，下次渲染还会按 `ids` 站回去。
export const moveUnit = (dock: Dock, id: UnitId, to: number): Dock => ({
  ...dock,
  tree: rewriteHolder(dock.tree, id, h => {
    if (h.t !== 'b') return h;
    const from = h.ids.indexOf(id);
    if (from < 0) return h;
    const at = Math.max(0, Math.min(h.ids.length - 1, Math.round(to)));
    if (at === from) return h;
    const ids = h.ids.filter(u => u !== id);
    ids.splice(at, 0, id);
    const shown = h.ids[h.sel] ?? h.ids[0];
    return { ...h, ids, sel: Math.max(0, ids.indexOf(shown)) };
  }),
});
// 块内重排的**格**版本：把 `id` 所在的**整格**（一格可能就是一条 tab 组）搬到第 `to` 格。
// `to` 是**移除这一格之后**的目标下标，和 moveUnit 的口径一致 —— 拖到最末尾就是 cells.length - 1。
//
// 为什么重排要说格而不是单元：Alt 合并之后，容器里一格可能挂着几个单元，"第几位"于是有了两套
// 下标（格的下标、ids 的下标）。让用户在 ids 上数位置，就得先在心里把 tab 组的人数扣掉 —— 而
// 把组里的某一个单独挪走等于拆组，那不是抓着箭头的人想做的事。整格搬动，组还是组，只是换了个
// 位置；groups/shown 跟着一起搬，块还是那个块。
export const moveCell = (dock: Dock, id: UnitId, to: number): Dock => ({
  ...dock,
  tree: rewriteHolder(dock.tree, id, h => {
    if (h.t !== 'b') return h;
    const cells = cellsOf(h);
    const from = cells.findIndex(c => c.includes(id));
    if (from < 0) return h;
    const at = Math.max(0, Math.min(cells.length - 1, Math.round(to)));
    if (at === from) return h;
    // 组（groups）与单元（ids）一起搬：格还是那一格，只是换了位置。
    const gs = groupsOf(h);
    const cell = gs.splice(from, 1)[0];
    gs.splice(at, 0, cell);
    // toolbar 开关是那一格的属性，和组一样跟着格走（不是留在原来的格号上）。
    const ts = cellTbs(h);
    const tb = ts.splice(from, 1)[0];
    ts.splice(at, 0, tb);
    const rest = cells.filter((_, i) => i !== from);
    const offset = rest.slice(0, at).reduce((a, c) => a + c.length, 0);
    const ids = rest.flatMap(c => c);
    ids.splice(offset, 0, ...cells[from]);
    const shown = h.ids[h.sel] ?? h.ids[0];
    return { ...h, ids, groups: packGroups(gs), tbs: packTbs(ts), sel: Math.max(0, ids.indexOf(shown)) };
  }),
});
// 把拖来的单元从它们所在的**格子里拉出来**，作为新的一格插到第 `k` 格前面（`k` 是**原序列**的格
// 下标，含源格自身）。这是"tab 组里拖出一个 tab"的唯一正确形态：整格搬移（moveCell）假设"这一格
// 整个就是我"，而这里源格**还在** —— 它只是少了几个 tab。
//
// 两种拖法在这里合成一条：
//   * 拖的是整格（组里每一个单元都在手里）→ 等于 moveCell：这一格连组一起搬走；
//   * 拖的是组里的某几个 tab      → 源格收缩，这几个 tab 自立门户，插到第 `k` 位。
// `k === from`（插在自己那一格前面）对第二种拖法是**有意义的**：从组里拆出来排到最前面。
// 其余格的计数、块的 mode/sz 一概不动 —— 容器还是那个容器。
export const pullOutAt = (dock: Dock, ids: readonly UnitId[], k: number): Dock => ({
  ...dock,
  tree: rewriteHolder(dock.tree, ids[0], h => {
    if (h.t !== 'b') return h;
    const cells = cellsOf(h);
    const gi = cells.findIndex(c => ids.some(u => c.includes(u)));
    if (gi < 0) return h;
    // `k` 是**移除之后**的下标（slotFor 的口径，和 moveCell 一致），所以这里直接用它 —— 再按
    // "源格在前面就减一"调整一次会把整格搬移差出一位。
    // 整格搬走时源格从序列里消失，后面的人各前移一位，`rest` 因此比原序列短一格；从组里拆出几个
    // tab 时源格还在（只是少了几个 tab），`rest` 的长度和下标都与原序列一致 —— 两种拖法在 `rest`
    // 上自动对齐，不需要在这里分辨。
    // `rest` 里每一格带着自己的 toolbar 开关一起走；搬过去的那一格见下面 `next` 里的那一条。
    const tbs = cellTbs(h);
    // 整格都在手里 = 这一格**搬**走；只有几个 tab 在手里 = 源格还在，只是少了几个 tab。
    const whole = cells[gi].every(u => ids.includes(u));
    const rest = cells
      .map((c, i) => ({ c: i === gi ? c.filter(u => !ids.includes(u)) : c, tb: tbs[i] }))
      .filter(x => x.c.length);
    const at = Math.max(0, Math.min(rest.length, Math.round(k)));
    // 整格搬走时开关跟着格走；从组里拆出来的那几个 tab 自立门户，是一扇新窗（不带开关）。
    const next = [...rest.slice(0, at), { c: [...ids], tb: whole ? tbs[gi] : 0 }, ...rest.slice(at)];
    const idsNext = next.flatMap(x => x.c);
    const shown = h.ids[h.sel] ?? h.ids[0];
    return {
      ...h, ids: idsNext, groups: packGroups(next.map(x => x.c.length)), tbs: packTbs(next.map(x => x.tb)),
      sel: Math.max(0, idsNext.indexOf(shown)),
    };
  }),
});
export const zoneAxis = (z: Zone): 'v' | 'h' => (z === 'left' || z === 'right' ? 'h' : 'v');
// 持有 `id` 的那个块（树里每个单元只在一个块里，所以只会有一次命中）。
const blockHolding = (n: DockNode, id: UnitId): DockBlock | null =>
  n.t === 'b' ? (n.ids.includes(id) ? n : null)
    : n.ks.reduce<DockBlock | null>((a, k) => a ?? blockHolding(k, id), null);
// 拖拽载荷的形状（见 DragShape）。浮窗读 float，default 块读 `tb`/`tbDir`，容器读那一格的 `tbs`
// 位 —— 三种窗存三个地方，读出来是同一个答案。
export const shapeOf = (dock: Dock, ids: readonly UnitId[]): DragShape => {
  const f = dock.floats.find(x => x.id === ids[0]);
  if (f) return { tb: !!f.tb, dir: f.tbDir ?? 'h' };
  const b = blockHolding(dock.tree, ids[0]);
  if (!b) return { tb: false, dir: 'h' };
  if (b.mode === 'default') return { tb: !!b.tb, dir: b.tbDir ?? 'h' };
  const i = cellsOf(b).findIndex(c => ids.every(u => c.includes(u)));
  return i >= 0 && cellTbs(b)[i] === 1 ? { tb: true, dir: b.mode } : { tb: false, dir: 'h' };
};
// 别处的窗口拖到容器**两格之间的缝**上：作为**新的一格**插到第 `k` 格前面。和 mergeIntoMember 同一个
// 原则 —— 只动 `ids`/`groups` 的插入点，块的 mode、sz、其余格的计数全不动，容器仍是同一个容器。
// `k` 是**原序列**的格下标（gapIndexAt 的口径：落在第 i、i+1 格之间就是 i+1），不存在"原位放回"
// 的问题 —— 手里的是别处的窗口，插哪儿都是新位置。
export const insertCellAt = (dock: Dock, ids: readonly UnitId[], memberId: UnitId, k: number): Dock => {
  if (!ids.length || ids.includes(memberId)) return dock;
  // 搬来的这一格如果本来就是一条 toolbar，搬过去还是 —— 形状跟着**格**走，不跟着容器走。
  const shape = shapeOf(dock, ids);
  const srcTb = shape.tb ? 1 : 0;
  const rest: Dock = {
    tree: detachAll(dock.tree, ids) || dock.tree,
    floats: dock.floats.filter(f => !ids.includes(f.id)),
  };
  return {
    ...rest,
    tree: rewriteHolder(rest.tree, memberId, h => {
      if (h.t !== 'b') return h;
      const cells = cellsOf(h);
      if (!cells.length) return h;
      // `default` 块没有"第几格"可言：接着往里加 tab 就是全部语义。
      if (h.mode === 'default') return { ...h, ids: [...h.ids, ...ids], sel: h.sel };
      const gi = Math.max(0, Math.min(cells.length, Math.round(k)));
      const at = cellStart(h, gi);
      const groups = groupsOf(h);
      groups.splice(gi, 0, ids.length);
      const tbs = cellTbs(h);
      tbs.splice(gi, 0, srcTb);
      return {
        ...h,
        ids: [...h.ids.slice(0, at), ...ids, ...h.ids.slice(at)],
        groups: packGroups(groups),
        tbs: packTbs(tbs),
        sel: h.sel >= at ? h.sel + ids.length : h.sel,
      };
    }),
  };
};
// What a drop has to say about SIZE, which is everything a block does not already know about itself.
// `pref` is the room the page wants for the arriving window (rules.blockSize, along the axis the new
// block will be measured on); `room` is what the block it lands beside is showing along that axis,
// measured by the caller — a size nothing ever wrote down exists nowhere else, and the arriving block
// has to pay for its room out of it. Both are absent for a drop that creates no block at all.
export type DockFit = { pref: number; room: number };

// What the arriving block may take. Two things hold it back, and both are what the block it lands
// beside has to be left with: its own floor (DOCK_MIN_SZ), and the new boundary the drop just made —
// the gap between two blocks IS the handle, so every block that arrives brings an 8px strip with it and
// pays for it out of the same room. Take without that second term and the strip is charged to whatever
// else is on "take the rest", which is the work area, and a drop in the settings column nudges the
// canvas sideways by eight pixels.
//
// `own` is a number the model already holds for the block being landed beside; `room` is what that block
// is showing along the axis being sized, measured by the caller. `own` wins when it exists, and it is
// not a matter of taste: the split divides up its CHILDREN'S DECLARED sizes, so the pair has to add up to
// the number the split was already counting. Take the budget from what the block is showing instead and
// the pair comes to less than the block declared — in a row too small for its own sizes (where every
// pinned block is showing less than it declared) that quietly un-oversubscribes the row, the shrink
// everyone was carrying is handed back, and the work area slides sideways on a drop that never touched
// it. Only a block with no declared size — one on "take the rest" — falls back to the measured room.
const capTake = (pref: number, room: number, own?: number): number => {
  const base = typeof own === 'number' && own > 0 ? own : room > 0 ? room : pref;
  return Math.min(DOCK_MAX_SZ, Math.max(1, Math.min(Math.round(pref), Math.round(base) - DOCK_MIN_SZ - DOCK_SPLIT)));
};
// What the block that gave up the room is left with: the pair occupies exactly what it occupied, with
// the new boundary and the new block taking their share out of it, so nothing else in the split moves.
const keptWith = (take: number, room: number, own?: number): number => {
  const base = typeof own === 'number' && own > 0 ? own : room > 0 ? room : take;
  return Math.max(DOCK_MIN_SZ, Math.round(base) - DOCK_SPLIT - take);
};
export function placeInTree(n: DockNode, id: UnitId, axis: 'v' | 'h', before: boolean, leaf: DockBlock, fit?: DockFit): DockNode {
  if (holds(n, id)) {
    // This block's parent runs the OTHER way, so it gets a split of its own — and the split takes over
    // the block's PLACE, which means it takes over the block's size, while the block loses the number.
    // Leaving the number on the block is what used to happen, and inside the new split that number meant
    // a size along the other axis: the settings column kept `340` as a HEIGHT while the wrapper, arriving
    // with no size at all, went on "take the rest" and swallowed the whole row.
    //
    // Inside the wrapper the block has no size of its own, which is exactly right: with the new block
    // pinned, the one that was there is the split's share-taker and shows what the pair leaves it.
    const { sz, ...bare } = n;
    const placed: DockBlock = fit ? { ...leaf, sz: capTake(fit.pref, fit.room) } : leaf;
    return { t: 's', d: axis, sz, ks: before ? [placed, bare] : [bare, placed] };
  }
  if (n.t === 's') {
    if (n.d === axis) {
      const i = n.ks.findIndex(k => holds(k, id));
      if (i >= 0) {
        // The block being landed beside stays where it is and keeps whatever it was. A block on "take
        // the rest" absorbs the new size by itself — that is what a share IS — and a block the user had
        // pinned pays out of its own number, which the model has and can simply write down. Nothing else
        // in the split moves, so a drop changes exactly one thing.
        const victim = n.ks[i];
        const owns = typeof victim.sz === 'number' && victim.sz > 0 ? victim.sz : undefined;
        const placed: DockBlock = fit ? { ...leaf, sz: capTake(fit.pref, fit.room, owns) } : leaf;
        const kept = fit && owns !== undefined
          ? { ...victim, sz: keptWith(placed.sz as number, fit.room, owns) }
          : victim;
        return { ...n, ks: before
          ? [...n.ks.slice(0, i), placed, kept, ...n.ks.slice(i + 1)]
          : [...n.ks.slice(0, i), kept, placed, ...n.ks.slice(i + 1)] };
      }
    }
    return { ...n, ks: n.ks.map(k => placeInTree(k, id, axis, before, leaf, fit)) };
  }
  return n;
}
// Drop a SET of units on the block that owns `targetId`, at `zone` — the whole of a drop, and the one
// place the two drags the user makes meet. What separates them is only HOW MANY ids arrive here:
//   * a tab's TITLE carries ONE unit, so that unit leaves its tab group and lands on its own;
//   * a window's HANDLE (the grip) carries EVERY unit behind that tab group, so the window moves whole
//     and the strip it had is still a strip where it lands.
// Edges split (reusing the nearest ancestor split that already runs that way, so repeated drops make a
// flat row rather than a spiral of nesting); the centre adds them to the block — more tabs, or more
// windows in a container.
export const dropUnits = (dock: Dock, ids: readonly UnitId[], targetId: UnitId, zone: Zone, fit?: DockFit): Dock => {
  if (!ids.length || ids.includes(targetId)) return dock;
  // 搬过去的是什么**形状**（一条 toolbar / 一扇普通窗），落点说了不算，拖来的那扇窗说了算。
  const shape = shapeOf(dock, ids);
  const rest: Dock = {
    tree: detachAll(dock.tree, ids) || dock.tree,
    floats: dock.floats.filter(f => !ids.includes(f.id)),
  };
  if (zone === 'center') return { ...rest, tree: addAllToBlock(rest.tree, targetId, ids, shape) };
  const axis = zoneAxis(zone);
  const leaf: DockBlock = { ...blockOf(ids), ...(shape.tb ? { tb: true, tbDir: shape.dir } : null) };
  return { ...rest, tree: placeInTree(rest.tree, targetId, axis, zone === 'top' || zone === 'left', leaf, fit) };
};
export const dropInDock = (dock: Dock, dragged: UnitId, targetId: UnitId, zone: Zone, fit?: DockFit): Dock =>
  dropUnits(dock, [dragged], targetId, zone, fit);

// 把拖来的单元并进**容器里的某一格**，和那一格合成一条 tab 条（Alt 拖拽）。
//
// 关键在"不改变这个块是什么"。早期版本是把容器炸成 split（像 setBlockMode 的 default 分支那样），
// 再往那一格的块里加 id —— 结果是用户按住 Alt 丢一个窗口，整列的 Vertical 模式就没了，其余每一格
// 也被拆成各自的块。那不是"合并两个窗口"，那是"重排整列"。
//
// 所以这里只改**这一格**：`groups` 里那一格多算几个，`ids` 里把新单元接在它后面。块的 mode 不变、
// sz 不变、其余格的计数不变 —— 容器仍是容器，只是其中一格的标题条上多了几个 tab。
export const mergeIntoMember = (
  dock: Dock,
  ids: readonly UnitId[],
  memberId: UnitId,
): Dock => {
  // 合到自己身上没有意义（它已经在那个 tab 组里了），宁可不做事也不给一个错的结果。
  if (!ids.length || ids.includes(memberId)) return dock;
  const rest: Dock = {
    tree: detachAll(dock.tree, ids) || dock.tree,
    floats: dock.floats.filter(f => !ids.includes(f.id)),
  };
  return {
    ...rest,
    tree: rewriteHolder(rest.tree, memberId, h => {
      if (h.t !== 'b') return h;
      // `default` 块本来就是一条 tab 条：接着往里加就是。
      if (h.mode === 'default') return { ...h, ids: [...h.ids, ...ids], sel: h.sel };
      // 容器：插到**那一格的末尾**，并让那一格多算几个。块本身、mode、其余格全不动。
      const cells = cellsOf(h);
      const gi = cells.findIndex(c => c.includes(memberId));
      if (gi < 0) return h;
      const at = cellStart(h, gi) + cells[gi].length;
      const groups = groupsOf(h);
      groups[gi] += ids.length;
      return {
        ...h,
        ids: [...h.ids.slice(0, at), ...ids, ...h.ids.slice(at)],
        groups,
        // `sel` 是 ids 的下标：插在它前面时，正在显示的那个单元整体后移。
        sel: h.sel >= at ? h.sel + ids.length : h.sel,
      };
    }),
  };
};
// Take units OUT of their own block and give them a block of their own beside it — the "pull this out
// into a window of its own" gesture, aimed at the EDGE of the very block they live in (the centre is
// "put it back", and is a no-op). `anchor` is a member that stays: the block survives the detach
// because it held something else, and the new block lands beside it. A block whose every unit is
// leaving has no anchor and no edge to be dragged out of — it IS what is moving — and the caller drops
// the gesture rather than tearing a hole in the layout.
export const dragOutUnits = (dock: Dock, ids: readonly UnitId[], anchor: UnitId, zone: Zone, fit?: DockFit): Dock => {
  const rest: Dock = {
    tree: detachAll(dock.tree, ids) || dock.tree,
    floats: dock.floats.filter(f => !ids.includes(f.id)),
  };
  return { ...rest, tree: placeInTree(rest.tree, anchor, zoneAxis(zone), zone === 'top' || zone === 'left', blockOf(ids), fit) };
};
export const dragOutOfDock = (dock: Dock, dragged: UnitId, anchor: UnitId, zone: Zone, fit?: DockFit): Dock =>
  dragOutUnits(dock, [dragged], anchor, zone, fit);
export const floatOf = (dock: Dock, id: UnitId) => dock.floats.find(f => f.id === id);
// The first pop-out lands to the right of the column; each further one cascades so several windows
// stay readable instead of stacking on top of each other. A workbench asks for a bigger box than a
// settings unit does — the page decides, because only the page knows what its content is.
export const floatSpot = (n: number, x: number, y: number): { x: number; y: number } => ({
  x: Math.round(Math.min(Math.max(8, x), Math.max(8, window.innerWidth - FLOAT_W - 8))),
  y: Math.round(Math.min(Math.max(8, y + n * 22), Math.max(8, window.innerHeight - 120))),
});
export const popOutDock = (dock: Dock, id: UnitId, x?: number, y?: number, w?: number, h?: number): Dock => {
  if (floatOf(dock, id)) return dock;
  const n = dock.floats.length;
  const spot = floatSpot(n, x ?? (window.innerWidth - (w ?? FLOAT_W) - 40), y ?? 90);
  const f: DockFloat = { id, ...spot, w: w ?? FLOAT_W, h: h ?? 320 };
  return { tree: detach(dock.tree, id) || dock.tree, floats: [...dock.floats, f] };
};
export const setFloatDock = (dock: Dock, id: UnitId, patch: Partial<DockFloat>): Dock => ({
  ...dock,
  floats: dock.floats.map(f => f.id === id ? { ...f, ...patch } : f),
});
// The mirror of appendToRow, and the reason a document does not land in the settings column when it
// is put back from a window: the work area is the row, not the stack.
export function appendToRow(n: DockNode, leaf: DockNode): DockNode | null {
  if (n.t !== 's') return null;
  for (let i = 0; i < n.ks.length; i++) {
    const r = appendToRow(n.ks[i], leaf);
    if (r) return { ...n, ks: n.ks.map((k, j) => j === i ? r : k) };
  }
  return n.d === 'h' ? { ...n, ks: [...n.ks, leaf] } : null;
}
// Putting a unit back means the place the user can see it from: a container is where stacked units live,
// so a panel joins the first one it can find — another stacked window there, or another tab. A document
// goes back to the work area, and never into the settings column.
export const dockBackDock = (dock: Dock, id: UnitId): Dock => {
  // 泊回来的是不是一条 toolbar：浮窗自己身上写着（用户在浮窗上也切过），泊回布局还是这个形状。
  const f = dock.floats.find(x => x.id === id);
  const shape: DragShape = { tb: !!f?.tb, dir: f?.tbDir ?? 'h' };
  const floats = dock.floats.filter(x => x.id !== id);
  const leaf: DockBlock = { ...block(id), ...(shape.tb ? { tb: true, tbDir: shape.dir } : null) };
  // Detach BEFORE appending, not after: the point of the detach is that a unit already in the tree
  // cannot end up in it twice, but appending first means the detach removes the node just added —
  // which is how "dock this window back" used to make the unit vanish instead of dock it.
  const rest = detach(dock.tree, id) || dock.tree;
  const busiest = biggestBlock(rest);
  const home = busiest ? () => addToBlock(rest, busiest.ids[0], id, shape) : () => (leaf as DockNode);
  const tree = docUidOf(id)
    ? appendToWork(rest, leaf) || appendToRow(rest, leaf) || home()
    : appendToContainer(rest, id, shape) || home();
  return { tree, floats };
};
// The node at `path`, counted in child indices from the root — the read to sizeAt's write, and how a
// handle finds the split it belongs to without walking the tree.
export const nodeAt = (n: DockNode, path: readonly number[]): DockNode | null => {
  let cur: DockNode | null = n;
  for (const i of path) {
    if (!cur || cur.t !== 's') return null;
    cur = cur.ks[i] ?? null;
  }
  return cur;
};
// Set (or clear) the size of the node at `path`, counted in child indices from the root. The split
// handles address boxes this way — by position, not by unit — because the empty work area has no unit
// in it to be named by, and because a boundary between two nests is a boundary like any other.
//
// `max` is forwarded to `clampSz` so the caller can say what the ceiling really is (see its comment).
export const sizeAt = (n: DockNode, path: readonly number[], sz: number | undefined, max: number = DOCK_MAX_SZ): DockNode =>
  path.length === 0
    ? { ...n, sz: sz === undefined ? undefined : clampSz(sz, n.sz, max) }
    : n.t === 's'
      ? { ...n, ks: n.ks.map((k, i) => (i === path[0] ? sizeAt(k, path.slice(1), sz, max) : k)) }
      : n;
// The same write, for a size that is a MEASUREMENT of what a node is already showing rather than a
// size the user dragged. It goes in exactly as measured — no floor and no ceiling — because either
// would move the box the drag is meant to leave alone. (A handle uses it to pin the split's other
// children while the pointer is down; see SplitHandle.)
export const freezeAt = (n: DockNode, path: readonly number[], sz: number): DockNode =>
  path.length === 0
    ? { ...n, sz }
    : n.t === 's'
      ? { ...n, ks: n.ks.map((k, i) => (i === path[0] ? freezeAt(k, path.slice(1), sz) : k)) }
      : n;
// Dragging the boundary between two siblings PINS the one before it and hands the one after its size
// back to "take the rest". Keeping exactly one side free is what makes a split honest: the row adds up
// to the page no matter what the pointer does (the dirty alternative — sizing both — drifts, and leaves
// nothing to absorb a window resize), and the pointer lands where it is because the free side is
// measured from the page, not from its own old size.
//
// ONE free side is the whole condition, and it is why the caller freezes the rest first: "take the
// rest" is a SHARE, so every unsized sibling of this pair divides the pointer's change between them
// and a drag on one boundary walks the boundaries of blocks it never touched. Pinning them (freezeAt)
// leaves the freed neighbour as the only thing absorbing the pointer — which is also what the range
// below assumes when it promises that neighbour keeps DOCK_MIN_SZ.
// `max` is the drag's own ceiling — the caller passes the far end of the range it promised the pointer
// (SplitHandle's `hi`). Without it the write falls back to the global constant and a boundary whose
// neighbour sits on that constant cannot move at all, while the drag still reports success.
export const dragSplit = (dock: Dock, prev: readonly number[], next: readonly number[], sz: number,
  max: number = DOCK_MAX_SZ): Dock => ({
  ...dock,
  tree: sizeAt(sizeAt(dock.tree, next, undefined), prev, sz, max),
});

// ── 落点 ────────────────────────────────────────────────────────────────────────────────────
// 一个块按四条边切成四带 + 中间一块：边带各占这块自己的 1/4，中间剩下的 1/2 见方是"放进这一块"。
// 判定（zoneOf）和预览（zoneRect）用的是同一组比例，因为它们回答的是同一个问题：
// **亮起来的那一块，就是松手后会出现的那一块。**
//
// 这两件事一旦分家，就会出现"框亮着、松手却落在中间"。上一版正是如此：判定按 34px/46px 的像素带，
// 预览却按 38%/34% 的比例画 —— 两个数字永远对不上，于是用户看到的框比真正算数的区域大得多，
// 读作"只有贴着边才认"。比例还顺手解决了窗口尺寸的问题：同一块在宽屏和窄屏上，四条带都是
// 它自己的四分之一，永远够得着，也永远不需要重新标定。
//
// 角落由"哪个方向的比例更小"决定 —— 一个点只属于一个 zone。这条规则有个几何后果：角落那 1/4 见方
// 被对角线切成两半，各归相邻的两条带。所以**每条边带的形状是梯形，不是矩形**：左边带占满左边缘，
// 但只有中间那一半高度能伸到 1/4 深，上下两头是被上/下带斜着切掉的。
//
// 预览必须画这个梯形。画成矩形就等于承诺了一块松手后拿不到的三角：指针停在那个角上，框还说
// "左侧分割"，判定其实已经是"上方分割"了。一个角上两句话，用户只会学到"这提示不准"。
export const ZONE_EDGE = 0.25;

// 一个 zone 在块里的**形状**，0..1 的比例，顶点顺时针。判定（zoneOf）与预览（zonePoly）同源，
// 所以"亮起来的那块面积"和"会响应落点的那块面积"是同一块，不是近似。
export type ZonePoint = readonly [number, number];

export const zonePoly = (z: Zone, edge: number = ZONE_EDGE): ZonePoint[] => {
  const e = Math.min(0.45, Math.max(0.05, edge));
  const f = 1 - e;
  if (z === 'left') return [[0, 0], [e, e], [e, f], [0, 1]];
  if (z === 'right') return [[1, 0], [f, e], [f, f], [1, 1]];
  if (z === 'top') return [[0, 0], [1, 0], [f, e], [e, e]];
  if (z === 'bottom') return [[0, 1], [1, 1], [f, f], [e, f]];
  return [[e, e], [f, e], [f, f], [e, f]];
};

// 形状的外接矩形。CSS 的 left/top/width/height 只认矩形，所以定位用它、形状用 zonePoly。
// 中心块的外接矩形就是它自己；四条边带的外接矩形比形状大出一对三角 —— 这一点是用它的前提：
// 容器的角上可能没有填充，那里的指针属于相邻的带。
export type ZoneRect = { left: number; top: number; width: number; height: number };

export const zoneRect = (z: Zone, edge: number = ZONE_EDGE): ZoneRect => {
  const pts = zonePoly(z, edge);
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
};

// 指针落在哪个 zone。距离按块自身的长宽归一化后再比：宽块的左右带在像素上很宽、上下带很窄，
// 但那正是"把这块四分"的含义 —— 用像素比就会在宽块上把上下两条带挤成一条够不着的细边。
export const zoneOf = (r: DOMRect, x: number, y: number, edge: number = ZONE_EDGE): Zone => {
  if (!(r.width > 0) || !(r.height > 0)) return 'center';
  const arms: [Zone, number][] = [
    ['left', (x - r.left) / r.width],
    ['right', (r.right - x) / r.width],
    ['top', (y - r.top) / r.height],
    ['bottom', (r.bottom - y) / r.height],
  ];
  let best: Zone = 'center';
  let bestD = edge;
  for (const [z, d] of arms) if (d < bestD) { bestD = d; best = z; }
  return best;
};
// A node with nothing left to show: a nest whose every descendant is empty. It stays in the MODEL —
// that is where the next document lands, between the columns rather than at the end of the row — but
// the frame draws only what has something in it, so a nest that empties out folds away and stops
// reserving its share of the page. Exported because the probe has to make the same judgement from the
// model side when it lines a saved tree up against what is drawn.
//
// `known` 是页面当下"拿得出这份单元"的判断（DockRules.known）。带上它时，一整块全都尚未验证的
// 文档单元的块也算空：刷新后工作台播报前的半秒里，存档里画布窗口的位置在模型里留着，屏幕上却不画
// 一扇标题为 "doc:1" 的空窗占地方 —— 播报一到，块自然回来。探针不带这个参数，口径不变。
export const dead = (n: DockNode, known?: (id: UnitId) => boolean): boolean => {
  if (n.t === 's') return !n.ks.some(k => !dead(k, known));
  return !!known && !n.ids.some(known);
};

// A block's size along its parent's axis: the one the user dragged, or a share of what is left. NOTHING
// sizes to its content — the frame divides the page and the content scrolls inside its block. (A window
// inside a container is the exception, and it is measured in DockView: it is `0 0 auto`, and the block
// scrolls.)
//
// The size the user dragged SHRINKS but never grows (`0 1 Npx`). While the split adds up it changes
// nothing — a drag pins the box it steers and leaves exactly one sibling on "take the rest", so the row
// is full to the pixel either way. It only speaks when the split is OVER-SUBSCRIBED, which happens
// whenever the box is smaller than the sizes in it: a layout saved on a wide window reopened in a narrow
// tile, or the page's own widths (the settings column, the canvas column) in a tile that cannot hold
// both. With `flex-shrink: 0` the boxes keep their numbers, the page spills sideways, the only free
// block is squeezed onto its floor and the boundary beside it is frozen — which reads as "this block
// will not shrink". With shrink allowed the frame divides the box it HAS, the pins come back exactly
// when the tile grows (the number is still in the model), and every boundary stays draggable.
export const flexOf = (sz?: number): string => (typeof sz === 'number' && sz > 0 ? `0 1 ${sz}px` : '1 1 0');
// The floor under a share inside a container: `1 1 0` shares only what is LEFT, and a container whose
// other members alone already overflow has nothing left — without this the workbench resolves to 0 and
// the frame has nowhere to be.
export const DOCK_GROW_MIN_H = 160;
