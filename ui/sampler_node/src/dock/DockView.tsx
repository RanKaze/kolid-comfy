import React, { useRef } from 'react';
import {
  type Dock, type DockBlock, type DockFit, type DockFloat, type DockMode, type DockNode, type DockRules, type UnitId, type Zone,
  DOCK_GROW_MIN_H, DOCK_MIN_SZ, DOCK_SPLIT, FLOAT_MIN_H, FLOAT_MIN_W,
  defaultDock, dead, clampSz, dockBackDock, dockFloor, docUidOf, dragOutUnits, dragSplit, dropUnits, flexOf, floorPct, freezeAt, nodeAt, popOutDock,
  rewriteHolder, setFloatDock, sizeAt, zoneAxis, zoneOf,
} from './model';
// 探针的轨迹钩子。这里只发"发生了什么"，不做判断、不读布局 —— 判断留在探针那边，
// 免得把排查规则散进渲染层（那才是第二份真相）。
import { note } from '../debug/probe';

// ── Dock 的骨架 ──：一颗单元 = 卡片 + 标题把手。iOS 词汇（#1c1c1e 卡片、发丝内缩分隔、
// #8e8e93 大写小标题、#0a84ff 强调）从这里开始就是全页通用，不再只属于 Settings 页。
// Only the frame is here; a unit's own interior (its cards and rows) keeps the page's skin.
//
// 布局是 **Block 平铺**：页面被切成一块块矩形，每块的大小只由框架（父 split 的份额，或用户拖过的像素）
// 决定，内容永远撑不动它。块与块之间那条 8px 的缝就是把手 —— 拖它改大小，没有第二个 resize 手势。
// 一个块里装什么由它的 mode 决定：`default` = 一个 dock window（多单元＝一行可换行的 tab），
// `v`/`h` = 容器，一个单元一个窗口地叠着排，按内容占高、块不够就滚、成员可以折叠。
const dockStyles: Record<string, React.CSSProperties> = {
  // border-box on purpose: the card's border is part of the size the frame hands it, so a block pinned
  // at N px is EXACTLY N px on screen. Under content-box the 0.5px border sits outside the flex size,
  // the drag measures the bigger rendered box and writes it back, and the boundary drifts away from the
  // pointer by a pixel or two on every drag.
  dockBox: { background: '#1c1c1e', borderRadius: 10, border: '0.5px solid rgba(255,255,255,0.07)', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden' },
  dockFloatBox: { background: '#1c1c1e', borderRadius: 10, border: '0.5px solid rgba(255,255,255,0.14)', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', boxShadow: '0 12px 34px rgba(0,0,0,0.62)' },
  // 标题条是一条会长的行：一格里塞进来一堆单元时，那一排 tab 换行，而不是挤成一行被剪掉。
  dockBar: { display: 'flex', alignItems: 'center', gap: 6, minHeight: 26, padding: '0 4px', flexShrink: 0, background: '#232325', borderBottom: '0.5px solid rgba(84,84,88,0.55)', userSelect: 'none' },
  dockGrip: { flexShrink: 0, display: 'flex', alignItems: 'center', cursor: 'grab', color: '#8e8e93' },
  dockName: { flex: 1, minWidth: 0, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#8e8e93', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  dockTabs: { flex: 1, minWidth: 0, display: 'flex', flexWrap: 'wrap', alignContent: 'center', gap: 2 },
  dockAct: { flexShrink: 0, width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', borderRadius: 5, color: 'rgba(255,255,255,0.55)', cursor: 'pointer', padding: 0, transition: 'transform 0.12s ease' },
  dockBody: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8 },
  // 一格的**动作条**（Clear All / Add / Undo / Redo 那一排）：它属于这个盒子，不属于那个 scroller ——
  // 所以画在正文下面、dockBody 的 overflow 之外，列表再长也顶不走它。
  dockFoot: { flexShrink: 0, padding: '6px 10px', background: '#232325', borderTop: '0.5px solid rgba(84,84,88,0.55)' },
  // A full-bleed unit: the content owns the box, so no card inset and no scroller of the dock's.
  dockBodyFull: { flex: '1 1 auto', minHeight: 0, overflow: 'hidden', padding: 0, display: 'flex', flexDirection: 'column' },
  // 浮窗右下角那颗：浮窗不在任何 split 里，没有块的分界线可拖，所以它自己留一颗改大小的角。
  dockCorner: { position: 'absolute', right: 1, bottom: 1, width: 12, height: 12, cursor: 'nwse-resize', background: 'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.26) 50%)' },
  dockNoteBox: { position: 'absolute', inset: 0, zIndex: 3, boxShadow: 'inset 0 0 0 2px #0a84ff', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' },
  dockNote: { fontSize: 10, fontWeight: 700, color: '#0a84ff', background: 'rgba(10,132,255,0.14)', padding: '2px 8px', borderRadius: 999 },
  // The dock fills the page and tiles it: the root is one column, the tree takes every pixel of it and
  // nothing here scrolls as a whole. Every scroller belongs to a container block (see BlockBox) or to a
  // window's own body.
  dockRoot: { flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingRight: 2, position: 'relative' },
  // Alt+P 那颗浮标：只有按住 Alt+P 时才出现，平时块完全是内容本身。
  dockEditBar: { position: 'absolute', left: '50%', bottom: 10, transform: 'translateX(-50%)', zIndex: 70, display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px 5px 12px', background: 'rgba(40,40,44,0.96)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', border: '0.5px solid rgba(10,132,255,0.55)', borderRadius: 999, boxShadow: '0 10px 30px rgba(0,0,0,0.55)' },
  dockEditHint: { fontSize: 10.5, fontWeight: 600, color: 'rgba(255,255,255,0.7)', whiteSpace: 'nowrap' },
  dockResetBtn: { background: 'none', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 999, color: 'rgba(255,255,255,0.62)', fontSize: 10, fontWeight: 600, padding: '3px 12px', cursor: 'pointer' },
  // 编辑模式里每块角上的模式三选一。
  blockEditBar: { position: 'absolute', top: 3, left: '50%', transform: 'translateX(-50%)', zIndex: 9, display: 'flex', gap: 2, padding: 2, background: 'rgba(28,28,30,0.94)', border: '0.5px solid rgba(10,132,255,0.6)', borderRadius: 999, boxShadow: '0 4px 14px rgba(0,0,0,0.55)' },
  blockEditBtn: { border: 'none', borderRadius: 999, padding: '1px 7px', fontSize: 9.5, fontWeight: 700, cursor: 'pointer', background: 'none', color: 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap' },
  // A unit's own actions live in a positioned slot so an absolute child (a menu) has something tight
  // to hang from rather than the whole box.
  dockHeadSlot: { position: 'relative', marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
};

// What the pointer is carrying. The dock has exactly TWO drag gestures on a window, and the only thing
// that tells them apart is how much is in here:
//   * ONE id — an ITEM's title, a tab, pulled out of the group it was sharing a window with;
//   * EVERY id of a window — the window's HANDLE (the grip in its bar), which moves the window whole,
//     tab group and all, because a window is one thing and the user grabbed the thing, not a tab.
export type DockDrag = { ids: readonly UnitId[] };

// Everything the dock chrome needs, passed down as one object so a box and a branch take the same
// three props (the node they render, the axis their parent measures them on, this context).
export type DockCtx = {
  rules: DockRules;
  bodies: Record<UnitId, React.ReactNode>;
  // Anything a unit wants pinned UNDER its body — the row of actions that must not scroll away with a
  // long list. Keyed by unit, drawn by the frame, so a unit still owns what it puts there.
  foots?: Partial<Record<UnitId, React.ReactNode>>;
  heads: Partial<Record<UnitId, React.ReactNode>>;
  // Collapsed or not is the user's call, so a unit the page has no stored choice for is open. Only a
  // member of a container is ever asked: a window that fills its block has nothing to fold away from.
  isOpen: (id: UnitId) => boolean;
  fold: (id: UnitId, open: boolean) => void;
  // 按住 Alt+P 的 **Block 编辑模式**：平时页面上没有模式控件，因为一块怎么排是装修，不是日常。
  edit: boolean;
  // The mode of the block owning this unit — the only write Alt+P makes.
  setMode: (id: UnitId, mode: DockMode) => void;
  dock: Dock;
  // persist=false while a pointer drag is still running — the layout lands in localStorage when the
  // pointer comes up, not once per mousemove.
  setDock: (next: Dock, persist?: boolean) => void;
  drag: DockDrag | null;
  setDrag: (d: DockDrag | null) => void;
  over: { id: UnitId; zone: Zone } | null;
  setOver: (v: { id: UnitId; zone: Zone } | null) => void;
  // A document unit is not folded by clicking its bar, it is ACTIVATED: one project at a time owns
  // the workbench, and the bar is where the user says which. Panels keep the old gesture.
  activate?: (id: UnitId) => void;
  // Whatever the page wants pinned in front of a title — the green dot that marks the active document.
  badge?: (id: UnitId) => React.ReactNode;
  // The sentence behind a unit's name. The page owns it when the text is one it rewrites as state
  // changes; a unit with nothing to say here gets no tooltip.
  hint?: (id: UnitId) => string | undefined;
  // A workbench wants a bigger window than a settings card, so the page may ask for the size it pops.
  popSize?: (id: UnitId) => { w: number; h: number } | null;
  // The page measures a unit's body box — the live workbench is pinned over the active document's — so
  // the frame hands the mounted element back. Null is that body leaving the DOM, not the unit closing:
  // a unit that is hidden keeps its element (`keepMounted`), and an unmounted one has nothing to measure.
  bodyRef?: (id: UnitId, el: HTMLDivElement | null) => void;
};

// What the pointer is carrying, read from either end of a drag. The set travels in TWO places on
// purpose: the context, which is all `dragover` can read (a dataTransfer is in protected mode until the
// drop), and the payload itself, so a drop still knows what it is holding even when the page has not
// re-rendered since the drag started. `text/plain` carries the single id as well, so a drop from
// outside this page — or one the context has already forgotten — still lands as ONE unit rather than
// as nothing.
const DOCK_MIME = 'application/x-dock-units';
const carried = (ctx: DockCtx, e: React.DragEvent): readonly UnitId[] | null => {
  if (ctx.drag) return ctx.drag.ids;
  const raw = e.dataTransfer.getData(DOCK_MIME);
  if (raw) {
    try {
      const v: unknown = JSON.parse(raw);
      if (Array.isArray(v) && v.length && v.every(i => typeof i === 'string')) return v as UnitId[];
    } catch { /* not ours — fall through to the plain id */ }
  }
  const one = e.dataTransfer.getData('text/plain');
  return one ? [one] : null;
};
// The drag sources a window wears. `grab(ctx, window.ids)` is the window HANDLE; `grab(ctx, [u])` is an
// item's TITLE. Nothing else differs between the two drags — same payload shape, same cleanup — which is
// why they are one factory and not two handlers that could drift apart.
const grab = (ctx: DockCtx, ids: readonly UnitId[]) => ({
  draggable: true,
  onDragStart: (e: React.DragEvent) => {
    e.dataTransfer.setData(DOCK_MIME, JSON.stringify(ids));
    e.dataTransfer.setData('text/plain', ids[0]);
    e.dataTransfer.effectAllowed = 'move';
    ctx.setDrag({ ids });
  },
  onDragEnd: () => { ctx.setDrag(null); ctx.setOver(null); },
});

// Both pop-out paths — the ⤢ button and dropping a unit on the dock's dead space — land the same window.
const popOut = (ctx: DockCtx, id: UnitId): void => {
  const s = ctx.popSize?.(id);
  ctx.setDock(popOutDock(ctx.dock, id, undefined, undefined, s?.w, s?.h));
};

// The three shapes a block can have, in the order the picker offers them.
const MODES: { mode: DockMode; label: string; hint: string }[] = [
  { mode: 'default', label: 'Default', hint: 'Default — 这个块就是一个 dock window：多个单元共用一行 tab' },
  { mode: 'v', label: 'Vertical', hint: 'Vertical — 容器：每个单元一个窗口，竖着叠；块不够高就出现 scroller' },
  { mode: 'h', label: 'Horizontal', hint: 'Horizontal — 容器：每个单元一个窗口，横着排；块不够宽就出现 scroller' },
];

// The 6-dot grip every unit wears. Dragging IT is the only way to change where a unit lives; the rest
// of the title bar folds, pops out, or shows whatever the unit keeps up there.
const GripDots: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="currentColor" style={{ display: 'block' }}>
    <circle cx="4" cy="3" r="1.2" /><circle cx="8" cy="3" r="1.2" />
    <circle cx="4" cy="6" r="1.2" /><circle cx="8" cy="6" r="1.2" />
    <circle cx="4" cy="9" r="1.2" /><circle cx="8" cy="9" r="1.2" />
  </svg>
);
const PopIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"
    strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <path d="M2 5.5V2h3.5M12 8.5V12H8.5" />
  </svg>
);
const DockBackIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"
    strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <path d="M12 2H8.5M12 2v3.5M2 12h3.5M2 12V8.5" />
  </svg>
);
const ZoneArrow: React.FC<{ zone: Zone }> = ({ zone }) => {
  if (zone === 'center') return null;
  const d = zone === 'top' ? 'M7 2v10M3.5 5.5 7 2l3.5 3.5'
    : zone === 'bottom' ? 'M7 12V2M3.5 8.5 7 12l3.5-3.5'
      : zone === 'left' ? 'M2 7h10M5.5 3.5 2 7l3.5 3.5'
        : 'M12 7H2M8.5 3.5 12 7l-3.5 3.5';
  return (
    <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="#0a84ff" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}><path d={d} /></svg>
  );
};

// A tab's landing band: an edge lights up the half it would split off, the centre says the unit joins
// this block.
const dockTabStyle = (on: boolean): React.CSSProperties => ({
  border: 'none', background: on ? 'rgba(255,255,255,0.10)' : 'transparent',
  color: on ? '#fff' : '#8e8e93', fontSize: 10, fontWeight: 700, padding: '2px 7px',
  borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden',
  textOverflow: 'ellipsis', maxWidth: 148, flexShrink: 0,
});

const zoneBand = (z: Zone): React.CSSProperties => {
  const base: React.CSSProperties = { position: 'absolute', pointerEvents: 'none', borderRadius: 10, background: 'rgba(10,132,255,0.18)' };
  if (z === 'top') return { ...base, top: 0, left: 0, right: 0, height: '38%' };
  if (z === 'bottom') return { ...base, bottom: 0, left: 0, right: 0, height: '38%' };
  if (z === 'left') return { ...base, top: 0, bottom: 0, left: 0, width: '34%' };
  return { ...base, top: 0, bottom: 0, right: 0, width: '34%' };
};

// A settings unit's body is a column of cards with its own scroller. A full-bleed unit's body IS the
// region — no card inset, and the content (a canvas) decides its own scrolling and its own background.
const bodyStyle = (id: UnitId, rules: DockRules): React.CSSProperties =>
  rules.fullBleed(id) ? dockStyles.dockBodyFull : dockStyles.dockBody;

// A container block's own skin: it is a frame, not a card — the members inside it are the cards, which
// is what keeps the column looking exactly as it always did. Its one scroller is the whole point of the
// mode: the members are as tall as their content, and the block scrolls when they do not fit.
const stackStyle = (mode: 'v' | 'h'): React.CSSProperties => ({
  display: 'flex', flexDirection: mode === 'v' ? 'column' : 'row', gap: 6,
  minHeight: 0, minWidth: 0,
  overflowY: mode === 'v' ? 'auto' : 'hidden',
  overflowX: mode === 'h' ? 'auto' : 'hidden',
});

// ONE DOCK WINDOW — a title bar, a body, and the unit's action row under it. A block in `default` mode
// IS this window (and hands it its own card); a block in `v`/`h` mode is a stack of them, each drawing
// its own card. A floated unit is one of these too, pinned to the viewport.
const DockWindow: React.FC<{
  node: DockBlock; ctx: DockCtx; axis: 'v' | 'h'; stacked?: boolean; float?: DockFloat; solo?: boolean;
}> = ({ node, ctx, axis, stacked, float, solo }) => {
  const ids = node.ids;
  const id = ids[Math.min(node.sel, Math.max(0, ids.length - 1))];
  // A fold only has somewhere to go inside a container: a window that fills its block (a `default`
  // block, a float) hides its body and there would be nothing left to show for it, so it is always open
  // and has no fold button at all.
  const folds = stacked ? ids.filter(u => ctx.rules.foldable(u)) : [];
  const open = stacked && folds.length ? folds.some(u => ctx.isOpen(u)) : true;
  const fold = (v: boolean) => { for (const u of folds) ctx.fold(u, v); };
  // A unit with nothing to size itself by takes a share of the block instead of collapsing to a strip.
  // So does the LAST member of a container: once every grows unit has left, the members that remain
  // size to their content and a block taller than that content would sit half empty — the space the
  // departed windows used to fill, reading as "they never left". One window left alone owns the block.
  const grow = !!solo || ids.some(u => ctx.rules.grows(u));
  // Dragging a window by its title bar moves it; the grip beside it still means "move this unit".
  // The bar's own click folds, so a move has to suppress the click that follows it.
  const winDrag = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  const suppressFold = useRef(false);
  const barDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!float || e.button !== 0 || (e.target as HTMLElement).closest('button,[draggable]')) return;
    e.stopPropagation();
    winDrag.current = { dx: e.clientX - float.x, dy: e.clientY - float.y, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* fall back to bubbling events */ }
  };
  const barMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const b = winDrag.current;
    if (!b) return;
    b.moved = true;
    ctx.setDock(setFloatDock(ctx.dock, id, {
      x: Math.round(Math.min(Math.max(8, e.clientX - b.dx), window.innerWidth - 60)),
      y: Math.round(Math.min(Math.max(8, e.clientY - b.dy), window.innerHeight - 40)),
    }), false);
  };
  const barUp = () => {
    const b = winDrag.current;
    if (!b) return;
    winDrag.current = null;
    if (b.moved) suppressFold.current = true;
    ctx.setDock(ctx.dock);
  };
  const pick = (i: number) => {
    if (node.t !== 'b') return;
    ctx.setDock({ ...ctx.dock, tree: rewriteHolder(ctx.dock.tree, ids[i], n => n.t === 'b' ? { ...n, sel: i } : n) });
    // Showing a document tab is showing that project on the workbench, so it is also an activation.
    if (docUidOf(ids[i])) ctx.activate?.(ids[i]);
  };
  // Mounted and visible are two questions. Everything hides as it always has, except a unit the rules
  // list as keep-mounted: that one stays in the DOM with `display:none`, because its body is live state
  // and unmounting it would throw away what the user is working on.
  const showBody = (u: UnitId, mounted: boolean, visible: boolean, key?: string) =>
    (!mounted || !ctx.bodies[u]) ? null : (
      <div key={key} ref={el => ctx.bodyRef?.(u, el)} className="dark-scroll"
        style={{ ...bodyStyle(u, ctx.rules), display: visible ? undefined : 'none' }}>
        {ctx.bodies[u]}
      </div>
    );
  const head = (
    <div className="dock-bar" style={{ ...dockStyles.dockBar, borderBottom: open ? dockStyles.dockBar.borderBottom : undefined }}
      onPointerDown={barDown} onPointerMove={barMove} onPointerUp={barUp} onPointerCancel={barUp}
      onClick={e => {
        if (suppressFold.current) { suppressFold.current = false; return; }
        if ((e.target as HTMLElement).closest('button,[draggable]')) return;
        // One bar, two jobs, split by what the unit is: a foldable member of a container folds,
        // a document window runs the project it names.
        if (folds.length) fold(!open); else ctx.activate?.(id);
      }}>
      {/* The window's HANDLE. Dragging IT moves the WHOLE window: every unit behind the tab strip
          travels with it, because a window is one thing and this is the thing the user grabbed. The
          tabs opposite are the items' own titles, and a drag on one of those takes that item ALONE out
          of the group — which is the whole difference between the two gestures (see DockDrag). */}
      <span className="dock-h" data-dock-grip {...grab(ctx, ids)}
        title={'Drag to move this whole window.\nAn edge splits a new block off, the centre puts it in that block.'}
        onClick={e => e.stopPropagation()}
        style={dockStyles.dockGrip}><GripDots /></span>
      {ids.length > 1 ? (
        <div style={dockStyles.dockTabs}>
          {ids.map((u, i) => (
            <button key={u} data-dock-unit={u} style={dockTabStyle(u === id)}
              title={'Show ' + ctx.rules.title(u) + ' in this block — drag the title to pull just this one out into a window of its own'}
              {...grab(ctx, [u])} onClick={() => pick(i)}>
              {/* Each tab carries its own mark: in a strip of documents, the dot is the only thing that
                  can say which one the workbench is actually running on. */}
              {ctx.badge?.(u)}{ctx.rules.title(u)}
            </button>
          ))}
        </div>
      ) : (
        // A lone unit has no group to be pulled out of, so its name is not a second drag source: the
        // handle above already moves it, and moving it moves the whole window, because it IS the whole
        // window. Leaving the name inert also keeps a FLOAT's bar draggable as a bar (a float is one
        // unit, and pressing anywhere on its bar has to move the window, not start an HTML5 drag).
        <span style={dockStyles.dockName} title={ctx.hint?.(id)}>{ctx.badge?.(id)}{ctx.rules.title(id)}</span>
      )}
      {/* A unit's own actions are part of its body, not of its frame: a collapsed unit must not keep
          an action that works on what the user just hid (Log, Debug, Add +). */}
      {open && ctx.heads[id] && <span style={dockStyles.dockHeadSlot}>{ctx.heads[id]}</span>}
      <button className="dock-h" style={dockStyles.dockAct}
        title={float ? 'Dock this window back into the layout' : 'Pop this unit out as a floating window'}
        onClick={() => { if (float) ctx.setDock(dockBackDock(ctx.dock, id)); else popOut(ctx, id); }}>
        {float ? <DockBackIcon /> : <PopIcon />}
      </button>
      {/* Only a member of a container has a fold to show. */}
      {folds.length > 0 && (
        <button className="dock-h" style={{ ...dockStyles.dockAct, transform: open ? 'none' : 'rotate(-90deg)' }}
          title={open ? 'Collapse this unit' : 'Expand this unit'} onClick={() => fold(!open)}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"
            strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
        </button>
      )}
    </div>
  );
  const inner = (
    <>
      {head}
      {showBody(id, open || ctx.rules.keepMounted(id), open)}
      {/* A keep-mounted unit that shares its block behind a tab strip stays mounted while another tab
          is showing, for the same reason a hidden one does not unmount. */}
      {ids.map(u => (u === id || !ctx.rules.keepMounted(u)) ? null : showBody(u, true, false, u))}
      {/* The unit's action row, if it has one: under the body and outside its scroller, so it stays
          put no matter how long the list gets. */}
      {open && ctx.foots?.[id] && <div style={dockStyles.dockFoot}>{ctx.foots[id]}</div>}
      {/* A float is in no split, so it has no block boundary to drag: it keeps its own corner. */}
      {float && <FloatCorner id={id} ctx={ctx} />}
    </>
  );
  // A floated window is a card pinned to the viewport: the one place a window still decides its own size.
  if (float) {
    return (
      <div style={{ ...dockStyles.dockFloatBox, position: 'fixed', left: float.x, top: float.y, width: float.w, height: float.h, zIndex: 60 }}>
        {inner}
      </div>
    );
  }
  // A member of a container: its own card, as tall (or wide) as its content — unless it has no content
  // to size itself by, in which case it takes a share of the block with a floor under it. Along the
  // stack's axis that is the whole story. ACROSS it the member is pinned at 0 rather than left at the
  // automatic minimum, so a wide card can never push the block wider than the frame cut it — writing
  // the 0 out is what keeps it that way (an `undefined` here would erase the dockBox's 0 and computed
  // style would fall back to `auto`).
  //
  // The floor under that share is the frame's, and it comes out of the block the same way a block's own
  // floor comes out of its split: `min(DOCK_GROW_MIN_H / 200, this%)`. A constant here is what makes a
  // member refuse to shrink in a container too short to give 160 to each of them — the list ends up
  // scrolling past a card that is already a third of the block, with the block itself unable to be
  // dragged any smaller.
  // `data-dock-member` names the card in the DOM. The frame never measures it — sizes come from the
  // split, never from content — but the inspector and the drag tests find members by it.
  if (stacked) {
    const share = floorPct(ids.length);
    return (
      <div data-dock-member={node.ids[0]} style={{
        ...dockStyles.dockBox,
        flex: grow ? '1 1 0' : '0 0 auto',
        minHeight: grow && axis === 'v' ? `min(${DOCK_GROW_MIN_H}px, ${share}%)` : 0,
        minWidth: axis === 'h' && grow ? `min(200px, ${share}%)` : 0,
      }}>{inner}</div>
    );
  }
  // A `default` block: the block's card IS this window, so the block hands it the box to fill.
  return inner;
};

// The corner of a float. Not a dock handle — a float lives outside the tiling, so nothing else in the
// frame can size it.
const FloatCorner: React.FC<{ id: UnitId; ctx: DockCtx }> = ({ id, ctx }) => {
  const start = useRef<{ px: number; py: number; w: number; h: number } | null>(null);
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    start.current = { px: e.clientX, py: e.clientY, w: box.width, h: box.height };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* fall back to bubbling events */ }
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    ctx.setDock(setFloatDock(ctx.dock, id, {
      w: Math.max(FLOAT_MIN_W, Math.round(s.w + (e.clientX - s.px))),
      h: Math.max(FLOAT_MIN_H, Math.round(s.h + (e.clientY - s.py))),
    }), false);
  };
  const up = () => { if (!start.current) return; start.current = null; ctx.setDock(ctx.dock); };
  return <div className="dock-corner" title="Drag to resize this window"
    style={dockStyles.dockCorner} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />;
};

// Alt+P 里每块角上的那一颗：三种模式，点一下就换。它就是**整个**编辑模式 —— 布局的其余部分照旧。
// `Default` 是唯一会动结构的那个（容器摊成一块一窗），而摊开是纯框架动作：新 split 继承容器的尺寸，
// 里面的块全部 free 平分它，之后用户自己拖分界线。窗口里内容占多大完全不参与 —— 容器内容装不下时
// 是靠滚的，实测出来的内容尺寸并不是框架发过的尺寸（见 model.ts 的 switchMode）。
const ModePicker: React.FC<{ node: DockBlock; ctx: DockCtx }> = ({ node, ctx }) => (
  <div style={dockStyles.blockEditBar}>
    {MODES.map(m => (
      <button key={m.mode} title={m.hint}
        style={{ ...dockStyles.blockEditBtn, background: node.mode === m.mode ? '#0a84ff' : 'none', color: node.mode === m.mode ? '#fff' : undefined }}
        onClick={e => { e.stopPropagation(); ctx.setMode(node.ids[0], m.mode); }}>{m.label}</button>
    ))}
  </div>
);

// ONE BLOCK. `default` draws a card and puts the window in it; `v`/`h` draws a scroller and puts one
// window per unit in it. Either way the block is the drop target — a drop lands on the BLOCK, so a
// container behaves like one thing and not like a row of targets: the centre adds what arrived to it, an
// edge splits a fresh block off beside it. What arrives is a SET of units, and how many are in it is the
// entire difference between the user's two drags: one id is a tab pulled out of its group, a whole
// window's worth is that window being moved.
const BlockBox: React.FC<{ node: DockBlock; ctx: DockCtx; axis: 'v' | 'h'; count: number }> = ({ node, ctx, axis, count }) => {
  const container = node.mode !== 'default';
  const target = node.ids[0];
  // Hovering with a member of this very block counts too: its edge is the "drag it out to a block of
  // its own" target, and the preview should say so. `over` is only ever set for a zone this block
  // accepts, so the centre of one's own block (a no-op) sets none and shows none.
  const isOver = !!ctx.drag && ctx.over?.id === target;
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    const ids = ctx.drag?.ids;
    if (!ids) return;
    const zone = zoneOf(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
    // Units of THIS block under the pointer have two destinations, and they are the two halves of the
    // block: the centre puts them back where they already are (a no-op the user makes constantly — a
    // drag that misses its target lands home), an edge pulls them OUT beside the block. That is refused
    // for the centre always, and for the whole-block case too: when every unit of this block is in the
    // drag, what is moving IS this block, and there is nothing left behind to anchor to. Refusing here
    // is what stops either of them bubbling out to the dock's own drop, where the answer is "pop a
    // window out" — emphatically not "put it back".
    const mine = node.ids.filter(i => ids.includes(i));
    if (mine.length && (zone === 'center' || mine.length === node.ids.length)) {
      e.stopPropagation();
      if (ctx.over) ctx.setOver(null);
      return;
    }
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (ctx.over?.id !== target || ctx.over?.zone !== zone) ctx.setOver({ id: target, zone });
  };
  // A drop that makes a block is the one place a window arrives with NO size of its own, and "take the
  // rest" is not an answer to it — the rest of a column is the whole column, which is how appending a
  // small window used to produce a block three times the size of the one it was dropped on. So the page
  // is asked what the window needs along the axis the new block will be measured on (rules.blockSize),
  // and the block it lands beside is MEASURED to know how much there is to take it out of: a size
  // nobody ever wrote down exists nowhere else, and this is the same measurement a boundary drag makes.
  const fitOf = (ids: readonly UnitId[], zone: Zone, el: HTMLElement): DockFit => {
    const axis = zoneAxis(zone);
    const r = el.getBoundingClientRect();
    return {
      pref: Math.max(...ids.map(i => ctx.rules.blockSize(i, axis))),
      room: Math.round(axis === 'v' ? r.height : r.width),
    };
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const ids = carried(ctx, e);
    if (!ids) return;
    const zone = zoneOf(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
    const mine = node.ids.filter(i => ids.includes(i));
    // Landing home, or moving a whole block onto itself: refused HERE means refused, not "let the page
    // have it" (see onDragOver).
    if (mine.length && (zone === 'center' || mine.length === node.ids.length)) {
      e.stopPropagation();
      ctx.setOver(null);
      return;
    }
    if (!ids.every(i => ctx.rules.known(i))) { e.stopPropagation(); return; }
    e.preventDefault(); e.stopPropagation();
    const fit = zone === 'center' ? undefined : fitOf(ids, zone, e.currentTarget);
    if (mine.length) {
      // Pulled out of their own block: what stays anchors them, and they land beside it. One id here is
      // a tab leaving its group; several would be a whole window, which cannot leave itself — handled
      // above as "nothing to anchor to".
      const anchor = node.ids.find(i => !ids.includes(i));
      if (anchor) ctx.setDock(dragOutUnits(ctx.dock, ids, anchor, zone, fit));
    } else {
      // Landed on another block: the set arrives together and stays together, so a window that was
      // moved by its handle is still a window with its tab strip when it gets there.
      ctx.setDock(dropUnits(ctx.dock, ids, target, zone, fit));
    }
    ctx.setOver(null);
    // A drop is the other half of the evidence a drag gives: what arrived, where it landed, and the
    // size the page asked for against the room the block beside it was showing. When a drop "creates a
    // block the size of the screen", these four numbers are the whole explanation.
    note('drop', {
      ids: ids.join(','), onto: target, zone, anchored: mine.length > 0,
      pref: fit ? Math.round(fit.pref) : null, room: fit ? Math.round(fit.room) : null,
    });
  };
  const overlay = !isOver ? null : ctx.over!.zone === 'center' ? (
    <div style={dockStyles.dockNoteBox}><span style={dockStyles.dockNote}>{container ? 'add a window' : 'tab group'}</span></div>
  ) : (
    <div style={{ ...zoneBand(ctx.over!.zone), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <ZoneArrow zone={ctx.over!.zone} />
    </div>
  );
  // A block with no dragged size shares what its siblings leave, and that share has a floor — the
  // frame's, never the content's. It is what lets a split drag promise the neighbour keeps DOCK_MIN_SZ
  // (see SplitHandle): without it a free block can be starved under the floor and the boundary stops
  // following the pointer exactly when the neighbour is at its smallest.
  //
  // The floor is taken as `min(DOCK_MIN_SZ, this%)`, where the percentage is one child's slice of the
  // split (`floorPct`). That is the whole difference between "96px" and "96px, or whatever is fair if
  // the box cannot afford 96 for everyone": an absolute floor in a small tile is a floor that no drag
  // can get under, which reads as a block that will not shrink at a size that is a large share of the
  // window. Expressed as a length the browser resolves against the split itself, so the frame never has
  // to measure to know what it can afford.
  const pinned = typeof node.sz === 'number' && node.sz > 0;
  const floor: React.CSSProperties = pinned ? {}
    : axis === 'v' ? { minHeight: `min(${DOCK_MIN_SZ}px, ${floorPct(count)}%)` }
      : { minWidth: `min(${DOCK_MIN_SZ}px, ${floorPct(count)}%)` };
  const chrome: React.CSSProperties = { flex: flexOf(node.sz), position: 'relative', ...floor };
  const edit: React.CSSProperties | undefined = ctx.edit
    ? { outline: '1px dashed rgba(10,132,255,0.75)', outlineOffset: -1 }
    : undefined;
  const picker = ctx.edit ? <ModePicker node={node} ctx={ctx} /> : null;
  if (!container) {
    // The block wears `data-dock-block` in BOTH branches: a container is found by it in the DOM, and a
    // `default` block is found by nothing else — the picker, the inspector and the drag tests all want
    // to name a block without walking the tree.
    return (
      <div data-dock-block={target} style={{ ...dockStyles.dockBox, ...chrome, ...edit }} onDragOver={onDragOver} onDrop={onDrop}>
        <DockWindow node={node} ctx={ctx} axis={axis} />
        {overlay}{picker}
      </div>
    );
  }
  return (
    <div className="dark-scroll" data-dock-block={target}
      style={{ ...stackStyle(node.mode === 'h' ? 'h' : 'v'), ...chrome, ...edit }}
      onDragOver={onDragOver} onDrop={onDrop}>
      {node.ids.map(u => (
        <DockWindow key={u} ctx={ctx} axis={node.mode === 'h' ? 'h' : 'v'} stacked solo={node.ids.length === 1}
          node={{ t: 'b', ids: [u], sel: 0, mode: 'default' }} />
      ))}
      {overlay}{picker}
    </div>
  );
};

// A split with nothing left to show takes no space on the page — that is the `dead` predicate, which
// lives in the model beside the sizes because the probe has to make the same judgement. The work nest
// is the case that matters: when its window leaves — dragged somewhere else, or the document closing —
// the nest STAYS in the model, because that is where the next document lands (between the columns, not
// at the end of the row). But an empty nest still holding its `1 1 0` share reserves the middle of the
// page for a window that is no longer there, which reads exactly as "the block was never removed". So
// the frame draws only the branches with something in them; a nest that empties out folds away.
//
// The boundary between two blocks — and it IS the gap the user sees: the 8px between two cards is this
// element, so there is no second thing to aim at and no handle on a window. Dragging pins the box
// before it, frees the one after (see dragSplit), and pins every OTHER child of the split to what it is
// already showing — so the pointer's change lands on the two boxes it is between and on nothing else.
// Addressed by PATH, not by unit: the empty work area holds no unit to be named by.
const SplitHandle: React.FC<{ ctx: DockCtx; axis: 'v' | 'h'; prev: number[]; next: number[]; count: number }> = ({ ctx, axis, prev, next, count }) => {
  const start = useRef<{ p: number; a: number; b: number; floor: number; froze: { path: number[]; sz?: number }[]; tree0: Dock['tree']; tree: Dock['tree']; touched: boolean; d: number; dMax: number; want: number; commits: number; noops: number } | null>(null);
  const along = (el: Element | null): number => {
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return axis === 'v' ? r.height : r.width;
  };
  const drawnKids = (of: Element | null): Element[] =>
    of ? [...of.children].filter(c => !c.classList.contains('dock-split')) : [];
  // The floor the split can afford, which is the only floor a drag can promise: DOCK_MIN_SZ while the
  // box is big enough for every child to have one, and a fair slice of the box when it is not (see
  // dockFloor). Measured from the split's own children rather than from a constant, so `hi` never
  // claims the neighbour will keep 96 in a box that has no 96 left to give — the boundary would then be
  // frozen while the pointer kept moving, and the block would look like one that cannot be resized.
  const floorOf = (el: HTMLElement): number => {
    const kids = drawnKids(el.parentElement);
    const box = kids.reduce((t, k) => t + along(k), 0) + DOCK_SPLIT * Math.max(0, kids.length - 1);
    return dockFloor(box, kids.length || count);
  };
  // Everything the drag is NOT steering holds the size it is showing while the pointer is down.
  //
  // A child nobody ever dragged carries no size of its own, and "no size" is `1 1 0` — DIVIDE whatever
  // the sized children leave. That share is what makes one drag walk three boundaries: the pointer grows
  // a box, every freed sibling absorbs a piece of it, and their boundaries travel with it. So the drag
  // has to leave exactly ONE thing dividing — the neighbour, and inside the neighbour the one grandchild
  // nearest this boundary, and so on down: the change travels along the boundary and STOPS there.
  // Everything else that would divide is pinned to the pixels it is showing right now.
  //
  // Which grandchild is "nearest" depends on which side of the boundary the box is on: the change enters
  // it from the side facing the boundary — the LAST child of the box before the boundary, the FIRST of
  // the box after it — so that is the side that absorbs it. Only a split running the SAME way as its
  // parent can divide the size being dragged: across the axis a child simply fills its box, and nothing
  // inside it moves. Sizes are read off the DOM because a size nothing ever wrote down exists nowhere
  // else — and only the DRAWN children are read, which is what lines them up with the live children of
  // the tree (a folded-away nest is not drawn, so it is not one of them).
  const freezeList = (el: HTMLElement): { path: number[]; sz?: number }[] => {
    const out: { path: number[]; sz?: number }[] = [];
    const parent = el.parentElement;
    const prefix = prev.slice(0, -1);
    const startNode = nodeAt(ctx.dock.tree, prefix);
    if (!parent || !startNode || startNode.t !== 's') return out;
    const start = startNode;
    const liveKids = (n: DockNode) =>
      n.t === 's' ? n.ks.map((k, i) => ({ k, i })).filter(({ k }) => !dead(k)) : [];
    const sized = (n: DockNode, i: number) => {
      const sz = n.t === 's' ? n.ks[i].sz : undefined;
      return typeof sz === 'number' && sz > 0;
    };
    // Pin every free child of `node` except the one that will absorb the change, then continue INTO
    // that one — it is the child whose size changes, so its own children need the same treatment.
    //
    // The absorber is the child FACING the boundary, and it has to be free: a child the last drag
    // pinned to a size cannot take the change, and the change has to land somewhere or the block is
    // left with nothing to give and spills past the box the frame cut it. So a child that is pinned
    // is handed BACK to "take the rest" — which is not a jump, because its siblings were just pinned
    // to what they are showing, so the rest is exactly what it is showing too.
    const step = (node: DockNode, domAt: Element, path: number[], facing: 'first' | 'last') => {
      if (node.t !== 's') return;
      const live = liveKids(node);
      const drawn = drawnKids(domAt);
      const focus = facing === 'first' ? 0 : live.length - 1;
      live.forEach(({ i }, j) => {
        if (j === focus || sized(node, i)) return;
        const w = along(drawn[j]);
        if (w > 0) out.push({ path: [...path, i], sz: w });
      });
      const f = live[focus];
      if (!f) return;
      if (sized(node, f.i)) out.push({ path: [...path, f.i] });
      if (f.k.t === 's' && f.k.d === node.d) step(f.k, drawn[focus], [...path, f.i], facing);
    };
    const live = liveKids(start);
    const drawn = drawnKids(parent);
    const at = live.findIndex(x => x.i === prev[prev.length - 1]);
    if (at < 0 || at + 1 >= live.length) return out;
    // This split: the two children the handle sits between are the drag's business, the rest are not.
    live.forEach(({ i }, j) => {
      if (j === at || j === at + 1 || sized(start, i)) return;
      const w = along(drawn[j]);
      if (w > 0) out.push({ path: [...prefix, i], sz: w });
    });
    // …and both of those two DO change size, so each one's children get the same treatment, entered
    // from the side that faces this boundary.
    const p = live[at], n = live[at + 1];
    if (p.k.t === 's' && p.k.d === start.d) step(p.k, drawn[at], [...prefix, p.i], 'last');
    if (n.k.t === 's' && n.k.d === start.d) step(n.k, drawn[at + 1], [...prefix, n.i], 'first');
    return out;
  };
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.currentTarget;
    start.current = {
      p: axis === 'v' ? e.clientY : e.clientX,
      a: along(el.previousElementSibling), b: along(el.nextElementSibling),
      // Everything the drag is not steering is measured ONCE, before the first move: the sizes are read
      // off a frame the drag has not disturbed yet, so pinning them changes nothing on the screen.
      floor: floorOf(el),
      froze: freezeList(el),
      // The tree as it stood before this drag touched it, so a drag that ends up going nowhere can put
      // it back exactly (see `move`).
      tree0: ctx.dock.tree,
      // The drag OWNS this tree until the pointer comes up. `ctx.dock` is only where it started: a
      // pointermove's re-render is continuous priority and React may still be holding a frame behind, so
      // reading `ctx.dock.tree` on the next move (or on pointerup) can hand back a tree from BEFORE the
      // last commit — which silently undid the last 15px of every drag, and made `up()` persist that
      // older tree. What the pointer produced has to live somewhere that does not wait for a render.
      tree: ctx.dock.tree, touched: false, d: 0, dMax: 0, want: 0, commits: 0, noops: 0,
    };
    try { el.setPointerCapture(e.pointerId); } catch { /* fall back to bubbling events */ }
    note('drag.down', {
      axis, prev: prev.join('.'), next: next.join('.'),
      a: Math.round(start.current.a), b: Math.round(start.current.b),
      floor: start.current.floor, froze: start.current.froze.length,
    });
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    const d = (axis === 'v' ? e.clientY : e.clientX) - s.p;
    // How far the POINTER travelled is not the same fact as how far the BOUNDARY moved, and the two have
    // to be recorded separately or the trace of the interesting case destroys its own evidence: when a
    // drag is clamped the boundary never moves, so writing `pointer` only inside the commit branch would
    // report `pointer=0` — indistinguishable from "the handle never saw a pointer" and it would throw
    // away exactly the pair of numbers that names the bug (pointer far from moved). So the pointer delta
    // is latched on every move, before any decision to commit, and `dMax` keeps the furthest it ever got
    // (a drag that wanders out to the clamp and back ends at ~0 even though it travelled a long way).
    s.d = d;
    if (Math.abs(d) > Math.abs(s.dMax)) s.dMax = d;
    // The pinned side is dragged inside [lo, hi], and the boundary lands exactly where the pointer goes.
    // `lo` is the floor — or, for a box the page sized below the floor (the toolbar strip), where it
    // already is: dragging it must HOLD it, not pop it up to DOCK_MIN_SZ on the first nudge.
    // `hi` is the neighbour's floor seen from here, and never below where the box already is: a neighbour
    // already under the floor (a page too small for every block's floor) has nothing left to give, and
    // capping under the current size would drag the boundary BACKWARDS while the pointer moves forward.
    // Both numbers come from the floor the SPLIT can afford (see floorOf), so what the drag promises is
    // what the box can keep.
    const lo = Math.min(s.floor, s.a);
    const hi = Math.max(s.a, s.a + s.b - s.floor);
    const want = Math.max(lo, Math.min(s.a + d, hi));
    // A drag that cannot move the boundary leaves the layout ALONE, and it has to: the neighbour is
    // already on its floor, so `hi` IS where the boundary already stands and the clamp pins the pointer
    // there no matter how far it travels. Committing that anyway writes the dragged block's RENDERED
    // size in place of the size it declared, and in a row too small for its own sizes the rendered size
    // is the smaller of the two — so the row stops being over-subscribed, the shrink every block was
    // carrying is handed back, and the settings column widens while the block beside it narrows. The
    // pointer moved, the boundary did not: nothing happened, and nothing is what gets recorded. (A drag
    // that wandered out to the clamp and back is the same case, and the recorded tree goes back with it.)
    if (Math.abs(want - s.a) < 0.5) {
      s.noops++;
      if (s.touched) { s.touched = false; ctx.setDock({ ...ctx.dock, tree: s.tree0 }, false); }
      return;
    }
    // What the write below will ACTUALLY produce, decided before writing it. The two used to disagree:
    // the range promises `hi` (measured off the box), the model clamped at DOCK_MAX_SZ (a constant), so
    // on a wide window a boundary whose neighbour already declared 1200 was clamped straight back to
    // where it stood — the tree came out byte-identical while the trace said `moved=120, commits=8`.
    // A drag that reports success and changes nothing is the evidence LYING, which is worse than no
    // evidence, because it sends whoever reads it looking for the bug somewhere else. So: the ceiling
    // is the box (`hi`), and a frame whose applied size equals the declared one is a noop, not a commit.
    const was = nodeAt(s.tree, prev);
    const held = was && typeof was.sz === 'number' ? was.sz : undefined;
    const applied = clampSz(want, held, hi);
    if (applied === held) {
      // 这一帧没有改变任何东西。两种情形要分开：
      //   a) 边界回到了起点（拖出去又拖回来，或一开始就被夹死）→ 整趟拖拽等于没发生，tree 放回去；
      //   b) 只是顶到了 limit（`applied` 仍是 hi，只是这一帧没再往前）→ **绝不能回滚**。
      // b 曾经被我一起回滚过：拖到极限之后每一帧都是 noop，于是整趟拖拽在最后一帧被自己撤销 ——
      // 表现得像"拖到一半弹回去"，比原来的 bug 更难看出来。
      s.noops++;
      if (s.touched && Math.abs(applied - s.a) < 0.5) {
        s.touched = false;
        s.tree = s.tree0;
        ctx.setDock({ ...ctx.dock, tree: s.tree0 }, false);
      }
      return;
    }
    s.touched = true;
    s.want = applied; s.commits++;
    // The siblings are pinned first, on every move: re-pinning a value that is already there costs
    // nothing, and it keeps the drag honest if something else reshaped the layout mid-drag. With them
    // fixed the neighbour is the ONLY child left on "take the rest", so it absorbs the pointer's change
    // whole — and `hi`, which promises that neighbour DOCK_MIN_SZ, finally means what it says.
    let tree = s.tree;
    for (const f of s.froze) {
      tree = f.sz === undefined ? sizeAt(tree, f.path, undefined) : freezeAt(tree, f.path, f.sz);
    }
    // persist=false while the pointer is down: a drag re-renders, it does not hammer localStorage.
    const next_ = dragSplit({ ...ctx.dock, tree }, prev, next, applied, hi);
    s.tree = next_.tree;
    ctx.setDock(next_, false);
  };
  // One trace line per drag, written when the pointer comes up: what the handle read, how far the
  // pointer travelled, where the boundary was allowed to go, and whether anything changed at all. A
  // frozen boundary shows up here as `pointer` far from `moved` with `noops` counting the frames that
  // changed nothing — which is the whole evidence for "I drag it and the width will not shrink".
  const up = (): void => {
    const s = start.current;
    if (!s) return;
    note('drag', {
      axis, prev: prev.join('.'), next: next.join('.'),
      a: Math.round(s.a), b: Math.round(s.b), floor: s.floor, froze: s.froze.length,
      lo: Math.round(Math.min(s.floor, s.a)), hi: Math.round(Math.max(s.a, s.a + s.b - s.floor)),
      pointer: Math.round(s.d), pointerMax: Math.round(s.dMax),
      moved: s.touched ? Math.round(s.want - s.a) : 0,
      commits: s.commits, noops: s.noops,
    });
    // Persist what the DRAG produced, not `ctx.dock`: on pointerup the last move's render may not have
    // landed yet, and writing `ctx.dock` back would persist the tree from one frame earlier (this is
    // what made a 120px drag land as 105px).
    ctx.setDock({ ...ctx.dock, tree: s.tree });
    start.current = null;
  };
  return (
    <div className={ctx.edit ? 'dock-split dock-split-edit' : 'dock-split'}
      title={ctx.edit ? 'Drag to resize these two blocks (Alt+P)' : 'Drag to resize'}
      style={{ flex: `0 0 ${DOCK_SPLIT}px`, cursor: axis === 'v' ? 'row-resize' : 'col-resize', flexShrink: 0, borderRadius: 3 }}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
  );
};

const DockBranch: React.FC<{ node: DockNode; ctx: DockCtx; axis: 'v' | 'h'; path: number[]; root?: boolean; count?: number }> =
  ({ node, ctx, axis, path, root, count = 1 }) => {
    if (node.t === 'b') return <BlockBox node={node} ctx={ctx} axis={axis} count={count} />;
    // A hole in the model is not a hole on the screen — unless this branch IS the page.
    if (!root && dead(node)) return null;
    const d = node.d;
    const pinned = typeof node.sz === 'number' && node.sz > 0;
    // Only the children with something to show are drawn, and a handle is the boundary between two
    // DRAWN boxes: a folded-away nest between two live blocks leaves no pair of handles around an
    // invisible box — the two live blocks simply become neighbours, and the boundary the user grabs
    // is the one they can see. Paths still address the model, so a drag lands on the right nodes.
    const live = node.ks.map((k, i) => ({ k, i })).filter(({ k }) => !dead(k));
    return (
      // `data-dock-root` 挂在**根 split 自己**这一层，而不是外面那层框：界面探针要把声明树逐层对齐到
      // DOM，而模型里没有"框"这一层 —— 锚点多一层，第一行就会错位（整棵树从根上差一格）。
      <div data-dock-root={root ? '' : undefined} style={{
        display: 'flex', flexDirection: d === 'v' ? 'column' : 'row',
        minHeight: 0, minWidth: 0, overflow: 'hidden',
        // The root split IS the page, so it takes the whole area rather than sizing to its content.
        // Every other split is measured by whatever its own parent says — a nest has no box of its own.
        flex: root ? '1 1 auto' : flexOf(node.sz),
        // A free nest carries the same frame floor a free block does, for the same reason: a boundary
        // between two nests has to be able to promise the neighbour its floor too (see SplitHandle) —
        // and it is the same `min(DOCK_MIN_SZ, this%)` slice, so the floors of a split's children can
        // never add up past the split they are in.
        ...(root || pinned ? {}
          : axis === 'v' ? { minHeight: `min(${DOCK_MIN_SZ}px, ${floorPct(count)}%)` }
            : { minWidth: `min(${DOCK_MIN_SZ}px, ${floorPct(count)}%)` }),
      }}>
        {live.map(({ k, i }, j) => (
          <React.Fragment key={i}>
            {j > 0 && <SplitHandle ctx={ctx} axis={d} prev={[...path, live[j - 1].i]} next={[...path, i]} count={live.length} />}
            <DockBranch node={k} ctx={ctx} axis={d} path={[...path, i]} count={live.length} />
          </React.Fragment>
        ))}
      </div>
    );
  };

// The whole dock: the tree, plus every popped-out window (which are positioned against the viewport,
// so they can sit over the workbench). Dropping a unit on the dock's background — the gap between
// blocks, the work area with no document in it — pops it out, which is a second way to reach a window
// beside the ⤢ button and needs no aiming. Alt+P adds the mode pickers and the reset, and nothing else.
export const DockPanel: React.FC<{ ctx: DockCtx }> = ({ ctx }) => {
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    // The dock's own background takes ONE unit, and pops it out as a window. A whole window dropped
    // here has nowhere to go — a float holds one unit, and quietly keeping some of them would lose the
    // rest — so the gesture is refused (leaving `preventDefault` uncalled is what shows the pointer a
    // "not allowed" cursor instead of a drop preview that would lie).
    if (!ctx.drag || ctx.drag.ids.length > 1) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (ctx.over) ctx.setOver(null);
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const ids = carried(ctx, e);
    if (!ids || ids.length !== 1 || !ctx.rules.known(ids[0])) return;
    e.preventDefault();
    popOut(ctx, ids[0]);
    ctx.setDrag(null); ctx.setOver(null);
  };
  return (
    // `data-dock-frame` 是 dock 外框（包含浮窗与编辑条），探针不用它定位 —— 见根 split 上的
    // `data-dock-root`。留着它是为了"这块是 dock 的区域"在 DOM 里有个名字。
    <div className="dark-scroll" data-dock-frame style={dockStyles.dockRoot} onDragOver={onDragOver} onDrop={onDrop}>
      <DockBranch node={ctx.dock.tree} ctx={ctx} axis="v" path={[]} root />
      {ctx.dock.floats.map(f => (
        <DockWindow key={f.id} ctx={ctx} axis="v" float={f} node={{ t: 'b', ids: [f.id], sel: 0, mode: 'default' }} />
      ))}
      {ctx.edit && (
        <div style={dockStyles.dockEditBar}>
          <span style={dockStyles.dockEditHint}>Block 编辑 · 顶上的三选一改模式 · 拖分界线改大小</span>
          <button style={dockStyles.dockResetBtn} title="Put every unit back in its column, in order"
            onClick={() => ctx.setDock(defaultDock(ctx.rules))}>Reset layout</button>
        </div>
      )}
    </div>
  );
};
