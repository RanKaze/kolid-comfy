// ── THE DOCK ────────────────────────────────────────────────────────────────────────────────
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
// Alt+P (held) is the mode editor — the one place a block changes mode. A drop lands on a BLOCK and the
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
};

// `sz` is the size the user dragged this node to along its PARENT split's axis; absent means
// "take what is left". Only the boundary between two nodes is draggable, so only a node that sits in a
// split — a block, or a nest — carries one.
//
// A BLOCK is one rectangle of the page: one dock window in `default` mode, or a container of several in
// `v`/`h`. A node with no size is `1 1 0` — it shares what its siblings leave, which is what makes the
// tree tile the page with no dead space anywhere. Nothing in the tree sizes to its content.
export type DockBlock = { t: 'b'; ids: UnitId[]; sel: number; mode: DockMode; sz?: number };
export type DockNode = DockBlock | { t: 's'; d: 'v' | 'h'; ks: DockNode[]; sz?: number; work?: true };
// A popped-out unit lives in viewport coordinates: it has to be able to sit on top of the workbench,
// which is not inside any column.
export type DockFloat = { id: UnitId; x: number; y: number; w: number; h: number };
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

// Take the nodes that name a document the page does not have. A panel name is left alone here — an
// unknown panel is a broken layout, not a closed document, and the caller resets for that.
function pruneDocs(n: DockNode, isAlive: (id: UnitId) => boolean): DockNode | null {
  const alive = (id: UnitId) => !docUidOf(id) || isAlive(id);
  if (n.t === 'b') {
    const ids = n.ids.filter(alive);
    if (!ids.length) return null;
    // A block keeps its MODE through a document closing: a `v` block that happened to hold one is still
    // a container, and collapsing it to a plain window would silently undo the user's choice.
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
  if (x.t === 's') return (x.d === 'v' || x.d === 'h') && Array.isArray(x.ks) && x.ks.length > 0 && x.ks.every(isNode);
  return false;
}

// A layout is only a layout if every panel appears exactly once somewhere — tree or floating — and
// nothing else is in there. Documents are allowed to be missing (they were closed) but never twice:
// two boxes on one document is two viewports on one mutable layer stack.
export function loadDock(rules: DockRules): Dock {
  const fallback = defaultDock(rules);
  try {
    const raw = localStorage.getItem(rules.store);
    if (!raw) return fallback;
    const saved: { tree?: unknown; floats?: DockFloat[] } = JSON.parse(raw);
    // The shape first, and BEFORE pruneDocs: pruning an old node would read `ks` off something that has
    // none. An old layout therefore resets rather than half-loading — which is the honest answer, since
    // every block in it would be missing the mode this model is built on.
    if (!isNode(saved.tree)) return fallback;
    const tree = pruneDocs(saved.tree, id => rules.known(id));
    if (!tree) return fallback;
    const floats = (Array.isArray(saved.floats) ? saved.floats : [])
      .filter(f => f && typeof f.id === 'string' && (!docUidOf(f.id) || rules.known(f.id)));
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
const addAllToBlock = (n: DockNode, id: UnitId, add: readonly UnitId[]): DockNode =>
  rewriteHolder(n, id, h => (h.t === 'b' ? { ...h, ids: [...h.ids, ...add] } : h));
const addToBlock = (n: DockNode, id: UnitId, add: UnitId): DockNode => addAllToBlock(n, id, [add]);
// The mirror of appendToRow: a container, so the unit lands stacked with its kind rather than beside the
// whole column. Children are searched before the node itself, so an inner container wins over an outer.
function appendToContainer(n: DockNode, id: UnitId): DockNode | null {
  if (n.t === 'b') return n.mode !== 'default' ? { ...n, ids: [...n.ids, id] } : null;
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
function placeDoc(dock: Dock, id: UnitId): Dock {
  const shown = dockUnits(dock.tree).find(u => !!docUidOf(u));
  if (shown) return dropInDock(dock, id, shown, 'center');
  const leaf: DockNode = block(id);
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

export const holds = (n: DockNode, id: UnitId): boolean => n.t === 'b' && n.ids.includes(id);
// Take a unit out of the tree. Removing a child is what collapses what it leaves behind (an empty
// branch, or a split down to one child) — but NOT a block down to one unit: a block keeps its mode, and
// a `v` block that was just emptied of everything but one unit is still the container the user made.
// A pass that removes nothing restructures nothing, so the same rule pruneDocs follows applies here too
// — the row a page opens with must survive being touched by an operation about a unit that is not in it.
export function detach(n: DockNode, id: UnitId): DockNode | null {
  if (n.t === 'b') {
    const ids = n.ids.filter(i => i !== id);
    return ids.length ? { ...n, ids, sel: Math.min(n.sel, ids.length - 1) } : null;
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
  if (mode !== 'default' || h.ids.length < 2) return { ...h, mode };
  const d: 'v' | 'h' = h.mode === 'h' ? 'h' : 'v';
  return { t: 's', d, sz: h.sz, ks: h.ids.map(u => block(u, 'default')) };
};
export const zoneAxis = (z: Zone): 'v' | 'h' => (z === 'left' || z === 'right' ? 'h' : 'v');
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
  const rest: Dock = {
    tree: detachAll(dock.tree, ids) || dock.tree,
    floats: dock.floats.filter(f => !ids.includes(f.id)),
  };
  if (zone === 'center') return { ...rest, tree: addAllToBlock(rest.tree, targetId, ids) };
  const axis = zoneAxis(zone);
  return { ...rest, tree: placeInTree(rest.tree, targetId, axis, zone === 'top' || zone === 'left', blockOf(ids), fit) };
};
export const dropInDock = (dock: Dock, dragged: UnitId, targetId: UnitId, zone: Zone, fit?: DockFit): Dock =>
  dropUnits(dock, [dragged], targetId, zone, fit);
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
  const floats = dock.floats.filter(f => f.id !== id);
  const leaf: DockBlock = block(id);
  // Detach BEFORE appending, not after: the point of the detach is that a unit already in the tree
  // cannot end up in it twice, but appending first means the detach removes the node just added —
  // which is how "dock this window back" used to make the unit vanish instead of dock it.
  const rest = detach(dock.tree, id) || dock.tree;
  const busiest = biggestBlock(rest);
  const home = busiest ? () => addToBlock(rest, busiest.ids[0], id) : () => (leaf as DockNode);
  const tree = docUidOf(id)
    ? appendToWork(rest, leaf) || appendToRow(rest, leaf) || home()
    : appendToContainer(rest, id) || home();
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

// How far into a block's box the pointer has to be for that edge to count as a split. Kept well under
// half so the middle of a block stays the "put it in this block" zone, which is where a pointer aimed
// at a block usually lands.
export const zoneOf = (r: DOMRect, x: number, y: number): Zone => {
  const vt = Math.min(34, r.height * 0.32), hl = Math.min(46, r.width * 0.34);
  if (y - r.top < vt) return 'top';
  if (r.bottom - y < vt) return 'bottom';
  if (x - r.left < hl) return 'left';
  if (r.right - x < hl) return 'right';
  return 'center';
};
// A node with nothing left to show: a nest whose every descendant is empty. It stays in the MODEL —
// that is where the next document lands, between the columns rather than at the end of the row — but
// the frame draws only what has something in it, so a nest that empties out folds away and stops
// reserving its share of the page. Exported because the probe has to make the same judgement from the
// model side when it lines a saved tree up against what is drawn.
export const dead = (n: DockNode): boolean => n.t === 's' && !n.ks.some(k => !dead(k));

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
