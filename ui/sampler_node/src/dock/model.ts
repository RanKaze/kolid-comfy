// ── THE DOCK ────────────────────────────────────────────────────────────────────────────────
// Where a unit sits is the user's call: stacked in a column, side by side, several units sharing one
// slot behind a tab strip, or popped out as a window over the workbench. The tree answers only
// "who lives where and how big"; what a unit contains stays with the page — which is also why these
// operations are plain functions over a Dock and can be exercised without a DOM.
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

export type DockRules = {
  // localStorage key this layout lives under.
  store: string;
  // The fixed set, in the order a reset stacks them. Every one must appear exactly once somewhere.
  panels: readonly UnitId[];
  // A unit the page has no body for is a hole in the panel: the drop payload and a saved tree are both
  // checked against this before they are believed.
  known: (id: UnitId) => boolean;
  title: (id: UnitId) => string;
  // May this unit be folded to its title bar? Only a unit with a permanent name — a fold is stored under
  // the unit's id, and an id that comes back pointing at something else (a document uid the workbench
  // hands out again from 1) must not carry an old choice onto the new owner.
  foldable: (id: UnitId) => boolean;
  // The unit's body IS live state rather than a view of state: a fold or a tab switch hides it with
  // display:none instead of unmounting it, because unmounting throws the state away.
  keepMounted: (id: UnitId) => boolean;
  // The unit's content owns its box — no card inset and no scroller of the dock's. A workbench and a
  // toolbar are both like this; what sets them apart is `grows`.
  fullBleed: (id: UnitId) => boolean;
  // The unit has no content height to size itself by, so it takes a share of its split instead of
  // `0 0 auto` — which for a workbench is the difference between a canvas and a collapsed strip.
  // A toolbar is the opposite: full-bleed skin, but it is exactly as tall as its row of buttons.
  grows: (id: UnitId) => boolean;
  // The shape the page opens with, and the shape "Reset layout" puts back: this row across the top
  // (if the page has one), then this column at this width with the work area beside it.
  top: UnitId | null;
  column: readonly UnitId[];
  columnW: number;
  // A page with panels on both sides of the work area names the far side here: a second column, stacked
  // the same way, at its own width. null = one column.
  right: readonly UnitId[] | null;
  rightW: number;
};

// `sz` is the size the user dragged this node to along its PARENT split's axis; absent means
// "take what is left". A nest carries one too — that is how the settings column keeps a width, since
// a nest has no box of its own to grab and is sized by the edge of whatever sits beside it.
export type DockSlot = { t: 'u'; id: UnitId; sz?: number }
  | { t: 'g'; ids: UnitId[]; sel: number; sz?: number };
export type DockNode = DockSlot | { t: 's'; d: 'v' | 'h'; ks: DockNode[]; sz?: number; work?: true };
// A popped-out unit lives in viewport coordinates: it has to be able to sit on top of the workbench,
// which is not inside any column.
export type DockFloat = { id: UnitId; x: number; y: number; w: number; h: number };
export type Dock = { tree: DockNode; floats: DockFloat[] };
export type Zone = 'top' | 'bottom' | 'left' | 'right' | 'center';

export const DOCK_MIN_SZ = 96, DOCK_MAX_SZ = 1200;
export const FLOAT_W = 300, FLOAT_MIN_W = 220, FLOAT_MIN_H = 60;
export const clampSz = (n: number) => Math.min(DOCK_MAX_SZ, Math.max(DOCK_MIN_SZ, Math.round(n)));

// The page opens as a split: the panel column on the left at its own width and the work area taking
// everything else, with the toolbar row above both if the page has one. Documents arrive into the work
// area through syncDocUnits — a reset can't name them, because which documents are open is not the
// layout's decision.
export const defaultDock = (r: DockRules): Dock => {
  const column: DockNode = { t: 's', d: 'v', sz: r.columnW, ks: r.column.map(id => ({ t: 'u', id }) as DockNode) };
  const ks: DockNode[] = [column];
  if (r.right?.length) {
    // Panels on both sides need a middle, and the middle has to survive a document closing: `work` is
    // how the page says "a document with no window goes HERE", so pruneDocs and detach leave this nest
    // empty instead of folding it away and letting the next document land at the far end of the row.
    ks.push({ t: 's', d: 'h', ks: [], work: true });
    ks.push({ t: 's', d: 'v', sz: r.rightW, ks: r.right.map(id => ({ t: 'u', id }) as DockNode) });
  }
  const row: DockNode = { t: 's', d: 'h', ks };
  return { tree: r.top ? { t: 's', d: 'v', ks: [{ t: 'u', id: r.top }, row] } : row, floats: [] };
};

export const dockUnits = (n: DockNode): UnitId[] =>
  n.t === 'u' ? [n.id] : n.t === 'g' ? n.ids : n.ks.flatMap(dockUnits);

// Take the nodes that name a document the page does not have. A panel name is left alone here — an
// unknown panel is a broken layout, not a closed document, and the caller resets for that.
function pruneDocs(n: DockNode, isAlive: (id: UnitId) => boolean): DockNode | null {
  const alive = (id: UnitId) => !docUidOf(id) || isAlive(id);
  if (n.t === 'u') return alive(n.id) ? n : null;
  if (n.t === 'g') {
    const ids = n.ids.filter(alive);
    if (!ids.length) return null;
    if (ids.length === 1) return { t: 'u', id: ids[0] };
    return { ...n, ids, sel: Math.min(n.sel, ids.length - 1) };
  }
  const kept = n.ks.map(k => pruneDocs(k, isAlive)).filter((k): k is DockNode => !!k);
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

// A layout is only a layout if every panel appears exactly once somewhere — tree or floating — and
// nothing else is in there. Documents are allowed to be missing (they were closed) but never twice:
// two boxes on one document is two viewports on one mutable layer stack.
export function loadDock(rules: DockRules): Dock {
  const fallback = defaultDock(rules);
  try {
    const raw = localStorage.getItem(rules.store);
    if (!raw) return fallback;
    // Whatever is in there is untyped until it has been read as a Dock, so the shape is checked, not
    // trusted — a store written by an older page is a plausible file, not a guaranteed one.
    const saved: { tree?: DockNode; floats?: DockFloat[] } = JSON.parse(raw);
    const tree = pruneDocs(saved.tree as DockNode, id => rules.known(id));
    if (!tree) return fallback;
    const floats = (Array.isArray(saved.floats) ? saved.floats : [])
      .filter(f => !docUidOf(f.id) || rules.known(f.id));
    const ids = dockUnits(tree).concat(floats.map(f => f.id));
    if (ids.some(id => !rules.known(id))) return fallback;
    if (rules.panels.some(u => ids.filter(i => i === u).length !== 1)) return fallback;
    if (ids.some((id, i) => ids.indexOf(id) !== i)) return fallback;
    return { tree, floats };
  } catch { return fallback; }
}

// The document units a tree and its windows hold.
const heldDocs = (dock: Dock): UnitId[] =>
  dockUnits(dock.tree).concat(dock.floats.map(f => f.id)).filter(id => !!docUidOf(id));

// A document with no window yet gets one where documents already live: tabbed into the box that shows
// one, so a second one does not halve the work area — they share a slot behind a strip until the user
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
function placeDoc(dock: Dock, id: UnitId): Dock {
  const shown = dockUnits(dock.tree).find(u => !!docUidOf(u));
  if (shown) return dropInDock(dock, id, shown, 'center');
  const leaf: DockNode = { t: 'u', id };
  return { ...dock, tree: appendToWork(dock.tree, leaf) || appendToRow(dock.tree, leaf) || { t: 's', d: 'h', ks: [dock.tree, leaf] } };
}

// Keep the layout in step with the documents the page actually has: a closed one loses its node and
// nothing else, a newly opened one joins the work area, and one the user already placed keeps that
// place. Panels are never touched here — they are the fixed set, and a layout missing one is broken.
export function syncDocUnits(dock: Dock, open: readonly UnitId[]): Dock {
  const isAlive = (id: UnitId) => !docUidOf(id) || open.includes(id);
  const pruned: Dock = { tree: pruneDocs(dock.tree, isAlive) || dock.tree, floats: dock.floats.filter(f => isAlive(f.id)) };
  const held = heldDocs(pruned);
  const missing = open.filter(id => !held.includes(id));
  // Nothing arrived and nothing left: hand back the SAME dock, which is how the caller tells a
  // re-announcement apart from a real change without diffing a tree.
  if (!missing.length && held.length === heldDocs(dock).length) return dock;
  return missing.reduce((acc, id) => placeDoc(acc, id), pruned);
}

export const holds = (n: DockNode, id: UnitId): boolean =>
  (n.t === 'u' && n.id === id) || (n.t === 'g' && n.ids.includes(id));
// Take a unit out of the tree. Removing a child is what collapses what it leaves behind (an empty
// branch, or a split down to one child); a pass that removes nothing restructures nothing, so the same
// rule pruneDocs follows applies here too — the row a page opens with must survive being touched by an
// operation about a unit that is not in it.
export function detach(n: DockNode, id: UnitId): DockNode | null {
  if (n.t === 'u') return n.id === id ? null : n;
  if (n.t === 'g') {
    const ids = n.ids.filter(i => i !== id);
    if (!ids.length) return null;
    if (ids.length === 1) return { t: 'u', id: ids[0] };
    return { ...n, ids, sel: Math.min(n.sel, ids.length - 1) };
  }
  const kept = n.ks.map(k => detach(k, id)).filter((k): k is DockNode => !!k);
  if (!kept.length) return n.work ? { ...n, ks: kept } : null;
  if (kept.length === n.ks.length) return { ...n, ks: kept };
  if (kept.length === 1) return kept[0];
  return { ...n, ks: kept };
}
// Rewrite the node that directly owns `id` (a leaf, or the tab group it belongs to).
export function rewriteHolder(n: DockNode, id: UnitId, fn: (holder: DockNode) => DockNode): DockNode {
  if (holds(n, id)) return fn(n);
  if (n.t === 's') return { ...n, ks: n.ks.map(k => rewriteHolder(k, id, fn)) };
  return n;
}
// Drop `dragged` on the unit `targetId` at `zone`. Edges split (reusing the nearest ancestor split
// that already runs that way, so repeated drops make a flat row rather than a spiral of nesting);
// the centre tabs it in beside the target.
export const zoneAxis = (z: Zone): 'v' | 'h' => (z === 'left' || z === 'right' ? 'h' : 'v');
export function placeInTree(n: DockNode, id: UnitId, axis: 'v' | 'h', before: boolean, leaf: DockNode): DockNode {
  if (holds(n, id)) return { t: 's', d: axis, ks: before ? [leaf, n] : [n, leaf] };
  if (n.t === 's') {
    if (n.d === axis) {
      const i = n.ks.findIndex(k => holds(k, id));
      if (i >= 0) {
        const ks = [...n.ks];
        ks.splice(before ? i : i + 1, 0, leaf);
        return { ...n, ks };
      }
    }
    return { ...n, ks: n.ks.map(k => placeInTree(k, id, axis, before, leaf)) };
  }
  return n;
}
export const dropInDock = (dock: Dock, dragged: UnitId, targetId: UnitId, zone: Zone): Dock => {
  if (dragged === targetId) return dock;
  const rest: Dock = { tree: detach(dock.tree, dragged) || dock.tree, floats: dock.floats.filter(f => f.id !== dragged) };
  if (zone === 'center') {
    const g: DockNode = { t: 'g', ids: [targetId, dragged], sel: 1 };
    return { ...rest, tree: rewriteHolder(rest.tree, targetId, n => n.t === 'g' ? { ...n, ids: [...n.ids, dragged], sel: n.ids.length } : g) };
  }
  const axis = zoneAxis(zone);
  return { ...rest, tree: placeInTree(rest.tree, targetId, axis, zone === 'top' || zone === 'left', { t: 'u', id: dragged }) };
};
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
// Putting a unit back means the panel column: the stacked nest in the tree, which is where stacked
// units live and the place the user can see it from. Children are searched BEFORE the node itself,
// because the outermost split of a page is the page — a unit put "back in the column" belongs in the
// innermost stack, not beside the toolbar row. A tree with no column left grows one.
export function appendToColumn(n: DockNode, leaf: DockNode): DockNode | null {
  if (n.t !== 's') return null;
  for (let i = 0; i < n.ks.length; i++) {
    const r = appendToColumn(n.ks[i], leaf);
    if (r) return { ...n, ks: n.ks.map((k, j) => j === i ? r : k) };
  }
  return n.d === 'v' ? { ...n, ks: [...n.ks, leaf] } : null;
}
// The mirror of appendToColumn, and the reason a document does not land in the settings column when it
// is put back from a window: the work area is the row, not the stack.
export function appendToRow(n: DockNode, leaf: DockNode): DockNode | null {
  if (n.t !== 's') return null;
  for (let i = 0; i < n.ks.length; i++) {
    const r = appendToRow(n.ks[i], leaf);
    if (r) return { ...n, ks: n.ks.map((k, j) => j === i ? r : k) };
  }
  return n.d === 'h' ? { ...n, ks: [...n.ks, leaf] } : null;
}
export const dockBackDock = (dock: Dock, id: UnitId): Dock => {
  const floats = dock.floats.filter(f => f.id !== id);
  const leaf: DockNode = { t: 'u', id };
  // Detach BEFORE appending, not after: the point of the detach is that a unit already in the tree
  // cannot end up in it twice, but appending first means the detach removes the node just added —
  // which is how "dock this window back" used to make the unit vanish instead of dock it.
  const rest = detach(dock.tree, id) || dock.tree;
  // A document goes back to the work area, everything else to the stack.
  const tree = docUidOf(id)
    ? appendToWork(rest, leaf) || appendToRow(rest, leaf) || { t: 's', d: 'h', ks: [rest, leaf] }
    : appendToColumn(rest, leaf) || { t: 's', d: 'v', ks: [rest, leaf] };
  return { tree, floats };
};
// Dragging a box's edge fixes THAT box along the axis its split is measured on. Whatever has no size
// takes the rest — which is why sizing a box clears the size off the nests it sits beside: a sized box
// next to a sized nest adds up to a row either wider or narrower than the page, and there is no
// leftover scroller in a horizontal split to absorb the difference.
export function sizeHolder(n: DockNode, id: UnitId, sz: number | undefined): DockNode {
  if (n.t === 's') {
    if (!n.ks.some(k => holds(k, id))) return { ...n, ks: n.ks.map(k => sizeHolder(k, id, sz)) };
    return { ...n, ks: n.ks.map(k => holds(k, id)
      ? sizeHolder(k, id, sz)
      : (k.t === 's' && k.sz !== undefined ? { ...k, sz: undefined } : k)) };
  }
  return holds(n, id) ? { ...n, sz: sz === undefined ? undefined : clampSz(sz) } : n;
}
export const resizeDock = (dock: Dock, id: UnitId, sz: number | undefined): Dock => ({
  ...dock, tree: sizeHolder(dock.tree, id, sz),
});

// How far into a unit's box the pointer has to be for that edge to count as a split. Kept well under
// half so the middle of a unit stays the "tab me in beside it" zone, which is where a pointer aimed
// at a unit usually lands.
export const zoneOf = (r: DOMRect, x: number, y: number): Zone => {
  const vt = Math.min(34, r.height * 0.32), hl = Math.min(46, r.width * 0.34);
  if (y - r.top < vt) return 'top';
  if (r.bottom - y < vt) return 'bottom';
  if (x - r.left < hl) return 'left';
  if (r.right - x < hl) return 'right';
  return 'center';
};
// Content-sized rows by default so the panel scrolls as one; a size the user dragged in makes that
// row fixed and moves the scrolling inside it. Only slots carry a size — a split is measured by
// whatever its own parent says.
// A unit with nothing to size itself by (a workbench, a popped-out window) always takes a share of its
// split rather than `0 0 auto`, which would collapse it to a strip. `open` = false is the box folded:
// a folded one is a bar and gives its share back, or a folded layers list would keep its half of the
// column as an empty box (the fold itself hides only the body). A size the user dragged is no
// exception — a folded 400px panel that kept a 400px box would just be an empty half-screen under its
// own title bar. Along `h` a box is measured by its WIDTH, and folding hides the body, not the column,
// so a fold leaves that width alone.
export const flexOf = (axis: 'v' | 'h', sz?: number, grow?: boolean, open = true): string =>
  axis === 'h' ? (sz ? `0 0 ${sz}px` : '1 1 0')
    : !open ? '0 0 auto'
      : sz ? `0 0 ${sz}px`
        : grow ? '1 1 0' : '0 0 auto';
// The height a tab GROUP falls back to when the user has never dragged one. A slot holding more than
// one unit has no single content height to size itself by: whichever tab is showing would set it, and
// the box would jump every time the user switched. So a group is sized like a box the user dragged,
// and switching tabs never moves it (the body scrolls instead). Grow units are exempt — they already
// take a share of the column.
export const DOCK_GROUP_H = 220;
// The floor under an open grow box: `1 1 0` shares only what is LEFT, and a column whose other panels
// alone already overflow has nothing left — the fallback layout opens every tool panel, and without
// this the two lists under them resolve to 0 (a 0.5px-bordered hairline). Sized boxes are the user's
// own drag and need no floor.
export const DOCK_GROW_MIN_H = 160;
// Whether a node - a box, or a whole nest - has anything in it that needs a share of the space.
export const hasGrowth = (n: DockNode, rules: DockRules): boolean =>
  dockUnits(n).some(u => rules.grows(u));
