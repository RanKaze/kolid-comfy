import React, { useRef } from 'react';
import {
  type Dock, type DockFloat, type DockNode, type DockRules, type DockSlot, type UnitId, type Zone,
  FLOAT_MIN_W, FLOAT_MIN_H, DOCK_GROW_MIN_H, DOCK_GROUP_H,
  dockBackDock, defaultDock, docUidOf, dropInDock, flexOf, hasGrowth, popOutDock,
  resizeDock, rewriteHolder, setFloatDock, zoneOf,
} from './model';

// ── Dock 的骨架 ──：一颗单元 = 卡片 + 标题把手。iOS 词汇（#1c1c1e 卡片、发丝内缩分隔、
// #8e8e93 大写小标题、#0a84ff 强调）从这里开始就是全页通用，不再只属于 Settings 页。
// Only the frame is here; a unit's own interior (its cards and rows) keeps the page's skin.
const dockStyles: Record<string, React.CSSProperties> = {
  dockBox: { background: '#1c1c1e', borderRadius: 10, border: '0.5px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' },
  dockFloatBox: { background: '#1c1c1e', borderRadius: 10, border: '0.5px solid rgba(255,255,255,0.14)', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', boxShadow: '0 12px 34px rgba(0,0,0,0.62)' },
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
  // 一条下沿 = 列里的高度，一个角 = 并排时的宽 / 浮窗的宽高。hover 才现出蓝，靠 .dock-edge 规则。
  dockEdge: { height: 6, flexShrink: 0, cursor: 'row-resize', borderTop: '0.5px solid rgba(84,84,88,0.55)' },
  dockCorner: { position: 'absolute', right: 1, bottom: 1, width: 12, height: 12, cursor: 'nwse-resize', background: 'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.26) 50%)' },
  dockNoteBox: { position: 'absolute', inset: 0, zIndex: 3, boxShadow: 'inset 0 0 0 2px #0a84ff', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' },
  dockNote: { fontSize: 10, fontWeight: 700, color: '#0a84ff', background: 'rgba(10,132,255,0.14)', padding: '2px 8px', borderRadius: 999 },
  // The scroller is the dock root, not the panel: a row the user pinned a height to has to scroll
  // inside its own box, and that only works if its parent gives it a definite height.
  // The dock fills the page, so it does not scroll as a whole — a vertical nest scrolls its own stack
  // (see DockBranch), and the reset row is the only thing under the tree.
  dockRoot: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden', paddingRight: 2 },
  dockReset: { display: 'flex', justifyContent: 'center', padding: '2px 0 6px', flexShrink: 0 },
  dockResetBtn: { background: 'none', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 999, color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: 600, padding: '3px 12px', cursor: 'pointer' },
  // A unit's own actions live in a positioned slot so an absolute child (a menu) has something tight
  // to hang from rather than the whole box.
  dockHeadSlot: { position: 'relative', marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
};

// Everything the dock chrome needs, passed down as one object so a box and a branch take the same
// three props (the node they render, the axis their parent measures them on, this context).
export type DockCtx = {
  rules: DockRules;
  bodies: Record<UnitId, React.ReactNode>;
  // Anything a unit wants pinned UNDER its body — the row of actions that must not scroll away with a
  // long list. Keyed by unit, drawn by the frame, so a unit still owns what it puts there.
  foots?: Partial<Record<UnitId, React.ReactNode>>;
  heads: Partial<Record<UnitId, React.ReactNode>>;
  // Collapsed or not is the user's call, so a unit the page has no stored choice for is open.
  isOpen: (id: UnitId) => boolean;
  // A fold is the SLOT's, not one tab's: a box is one title bar, so every unit sharing it folds together
  // and switching tabs must not change whether it is open.
  setFold: (ids: UnitId[], open: boolean) => void;
  dock: Dock;
  // persist=false while a pointer drag is still running — the layout lands in localStorage when the
  // pointer comes up, not once per mousemove.
  setDock: (next: Dock, persist?: boolean) => void;
  drag: UnitId | null;
  setDrag: (id: UnitId | null) => void;
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
  // a folded unit keeps its element (`keepMounted`), and an unmounted one has nothing to measure.
  bodyRef?: (id: UnitId, el: HTMLDivElement | null) => void;
};

// Both pop-out paths — the ⤢ button and dropping a unit on the dock's dead space — land the same window.
const popOut = (ctx: DockCtx, id: UnitId): void => {
  const s = ctx.popSize?.(id);
  ctx.setDock(popOutDock(ctx.dock, id, undefined, undefined, s?.w, s?.h));
};

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

// A unit's landing band: an edge lights up the half it would split off, the centre says tab group.
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

// One box = one slot: a single unit, or several units sharing it behind a tab strip. The box is what
// a drop lands on and what the user resizes, so it is also the thing that carries the size.
const DockBox: React.FC<{ node: DockSlot; ctx: DockCtx; axis: 'v' | 'h'; float?: DockFloat }> = ({ node, ctx, axis, float }) => {
  const ids: UnitId[] = node.t === 'u' ? [node.id] : node.ids;
  const id = ids[node.t === 'u' ? 0 : Math.min(node.sel, ids.length - 1)];
  // A unit the page says is not foldable has no choice to read: it is always open, so its body is never
  // hidden and its frame button never appears. A box is ONE title bar, so "open" is the slot's question
  // and not whichever tab is showing: the group is open while any of its foldable units is, and the
  // fold button folds all of them at once.
  const folds = ids.filter(u => ctx.rules.foldable(u));
  const open = folds.length ? folds.some(u => ctx.isOpen(u)) : true;
  const fold = (v: boolean) => ctx.setFold(folds, v);
  const grow = ids.some(u => ctx.rules.grows(u));
  // A slot holding more than one unit has no single content height to size itself by — the tab on
  // screen would set it and the box would jump on every switch. So a group is always a sized box: the
  // height the user dragged, or the group default. Only the vertical axis, where `flex` is the height,
  // needs this; a group beside another already shares the row.
  const sz = node.sz ?? (open && ids.length > 1 && !grow && axis === 'v' && !float ? DOCK_GROUP_H : undefined);
  const minH = !float && open && axis === 'v' && grow && !node.sz ? DOCK_GROW_MIN_H : undefined;
  const isOver = !!ctx.drag && ctx.drag !== id && !float && ctx.over?.id === id;
  // A window is not a place a unit can land in — it is already somewhere. Re-docking happens by
  // dragging ITS grip onto a column box, which is the same gesture as any other move.
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (float || !ctx.drag || ctx.drag === id) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    const zone = zoneOf(r, e.clientX, e.clientY);
    if (ctx.over?.id !== id || ctx.over?.zone !== zone) ctx.setOver({ id, zone });
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (float) return;
    const dragged = (ctx.drag || e.dataTransfer.getData('text/plain')) as UnitId;
    if (!ctx.rules.known(dragged) || dragged === id) return;
    e.preventDefault(); e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    ctx.setDock(dropInDock(ctx.dock, dragged, id, zoneOf(r, e.clientX, e.clientY)));
    ctx.setOver(null);
  };
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
    if (node.t !== 'g') return;
    ctx.setDock({ ...ctx.dock, tree: rewriteHolder(ctx.dock.tree, ids[i], n => n.t === 'g' ? { ...n, sel: i } : n) });
    // Showing a document tab is showing that project on the workbench, so it is also an activation.
    if (docUidOf(ids[i])) ctx.activate?.(ids[i]);
  };
  // Mounted and visible are two questions. Everything folds away as it always has, except a unit the
  // rules list as keep-mounted: that one stays in the DOM with `display:none`, because its body is
  // live state and unmounting it would throw away what the user is working on.
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
        // One bar, two jobs, split by what the unit is: a foldable unit folds, a document window runs
        // the project it names.
        if (folds.length) fold(!open); else ctx.activate?.(id);
      }}>
      <span className="dock-h" draggable
        title={'Drag onto another unit to move this one.\nAn edge splits the other one, the centre tabs them together.'}
        onDragStart={e => { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; ctx.setDrag(id); }}
        onDragEnd={() => { ctx.setDrag(null); ctx.setOver(null); }}
        onClick={e => e.stopPropagation()}
        style={dockStyles.dockGrip}><GripDots /></span>
      {ids.length > 1 ? (
        <div style={dockStyles.dockTabs}>
          {ids.map((u, i) => (
            <button key={u} style={dockTabStyle(u === id)} title={'Show ' + ctx.rules.title(u) + ' in this slot'}
              onClick={() => pick(i)}>
              {/* Each tab carries its own mark: in a strip of documents, the dot is the only thing that
                  can say which one the workbench is actually running on. */}
              {ctx.badge?.(u)}{ctx.rules.title(u)}
            </button>
          ))}
        </div>
      ) : (
        <span style={dockStyles.dockName} title={ctx.hint?.(id)}>{ctx.badge?.(id)}{ctx.rules.title(id)}</span>
      )}
      {/* A unit's own actions are part of its body, not of its frame: a collapsed unit must not keep
          an action that works on what the user just hid (Log, Debug, Add +). */}
      {open && ctx.heads[id] && <span style={dockStyles.dockHeadSlot}>{ctx.heads[id]}</span>}
      <button className="dock-h" style={dockStyles.dockAct}
        title={float ? 'Dock this window back into the column' : 'Pop this unit out as a floating window'}
        onClick={() => { if (float) ctx.setDock(dockBackDock(ctx.dock, id)); else popOut(ctx, id); }}>
        {float ? <DockBackIcon /> : <PopIcon />}
      </button>
      {/* Only a unit that can be given back to the layout has a fold to show. */}
      {folds.length > 0 && (
        <button className="dock-h" style={{ ...dockStyles.dockAct, transform: open ? 'none' : 'rotate(-90deg)' }}
          title={open ? 'Collapse this unit' : 'Expand this unit'} onClick={() => fold(!open)}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"
            strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
        </button>
      )}
    </div>
  );
  return (
    <div style={{
      ...(float ? dockStyles.dockFloatBox : dockStyles.dockBox),
      flex: float ? undefined : flexOf(axis, sz, grow, open),
      minHeight: minH,
      position: float ? 'fixed' : 'relative',
      left: float ? float.x : undefined, top: float ? float.y : undefined,
      width: float ? float.w : undefined, height: float && open ? float.h : undefined,
      zIndex: float ? 60 : undefined,
    }} onDragOver={onDragOver} onDrop={onDrop}>
      {head}
      {showBody(id, open || ctx.rules.keepMounted(id), open)}
      {/* A keep-mounted unit that shares its slot behind a tab strip stays mounted while another tab
          is showing, for the same reason a fold does not unmount it. */}
      {ids.map(u => (u === id || !ctx.rules.keepMounted(u)) ? null : showBody(u, true, false, u))}
      {/* The unit's action row, if it has one: under the body and outside its scroller, so it stays
          put no matter how long the list gets. */}
      {open && ctx.foots?.[id] && <div style={dockStyles.dockFoot}>{ctx.foots[id]}</div>}
      {open && <DockEdge id={id} ctx={ctx} axis={float ? 'f' : axis} grouped={ids.length > 1} />}
      {isOver && ctx.over!.zone === 'center' && (
        <div style={dockStyles.dockNoteBox}><span style={dockStyles.dockNote}>tab group</span></div>
      )}
      {isOver && ctx.over!.zone !== 'center' && (
        <div style={{ ...zoneBand(ctx.over!.zone), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <ZoneArrow zone={ctx.over!.zone} />
        </div>
      )}
    </div>
  );
};

// One handle per unit, and it always moves the axis the unit is measured on: the bottom strip sets a
// row's height in a column, the corner sets a column's width side by side, a window's corner both.
const DockEdge: React.FC<{ id: UnitId; ctx: DockCtx; axis: 'v' | 'h' | 'f'; grouped?: boolean }> = ({ id, ctx, axis, grouped }) => {
  const start = useRef<{ p: number; w: number; h: number } | null>(null);
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    start.current = { p: axis === 'v' ? e.clientY : e.clientX, w: box.width, h: box.height };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* fall back to bubbling events */ }
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    // persist=false while the pointer is down: a drag re-renders, it does not hammer localStorage.
    if (axis === 'f') {
      ctx.setDock(setFloatDock(ctx.dock, id, {
        w: Math.max(FLOAT_MIN_W, Math.round(s.w + (e.clientX - s.p))),
        h: Math.max(FLOAT_MIN_H, Math.round(s.h + (e.clientY - s.p))),
      }), false);
    } else {
      ctx.setDock(resizeDock(ctx.dock, id, axis === 'v' ? s.h + (e.clientY - s.p) : s.w + (e.clientX - s.p)), false);
    }
  };
  const up = () => { if (!start.current) return; start.current = null; ctx.setDock(ctx.dock); };
  if (axis === 'v') {
    return <div className="dock-edge"
      title={grouped
        ? 'Drag to fix this height - double-click to go back to the group default'
        : 'Drag to fix this height - double-click to let it size to its content again'}
      style={dockStyles.dockEdge} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onDoubleClick={() => ctx.setDock(resizeDock(ctx.dock, id, undefined))} />;
  }
  return <div className="dock-corner" title="Drag to resize"
    style={dockStyles.dockCorner} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />;
};

const DockBranch: React.FC<{ node: DockNode; ctx: DockCtx; axis: 'v' | 'h'; root?: boolean }> = ({ node, ctx, axis, root }) => {
  if (node.t !== 's') return <DockBox node={node} ctx={ctx} axis={axis} />;
  const row: React.CSSProperties = {
    display: 'flex', flexDirection: node.d === 'v' ? 'column' : 'row', gap: 8,
    minHeight: 0, minWidth: 0,
    // The root split IS the page now, so it takes the whole area rather than sizing to its content.
    // A nest inside a split carries a size exactly like a box does — that is how the settings column
    // keeps a width, since a nest has no edge of its own to grab and gets sized by the box beside it.
    flex: root ? '1 1 auto' : flexOf(axis, node.sz, hasGrowth(node, ctx.rules)),
    overflowY: node.d === 'v' ? 'auto' : undefined,
  };
  return (
    <div className={node.d === 'v' ? 'dark-scroll' : undefined} style={row}>
      {node.ks.map((k, i) => <DockBranch key={i} node={k} ctx={ctx} axis={node.d} />)}
    </div>
  );
};

// The whole dock: the tree, plus every popped-out window (which are positioned against the viewport,
// so they can sit over the workbench). Dropping a unit on the dock's background — the gap between
// boxes, the dead space under a short tree — pops it out, which is a second way to reach a window
// beside the ⤢ button and needs no aiming.
export const DockPanel: React.FC<{ ctx: DockCtx }> = ({ ctx }) => {
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!ctx.drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (ctx.over) ctx.setOver(null);
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const dragged = (ctx.drag || e.dataTransfer.getData('text/plain')) as UnitId;
    if (!ctx.rules.known(dragged)) return;
    e.preventDefault();
    popOut(ctx, dragged);
    ctx.setDrag(null); ctx.setOver(null);
  };
  return (
    <div className="dark-scroll" style={dockStyles.dockRoot} onDragOver={onDragOver} onDrop={onDrop}>
      <DockBranch node={ctx.dock.tree} ctx={ctx} axis="v" root />
      {ctx.dock.floats.map(f => <DockBox key={f.id} node={{ t: 'u', id: f.id }} ctx={ctx} axis="v" float={f} />)}
      <div style={dockStyles.dockReset}>
        <button style={dockStyles.dockResetBtn} title="Put every unit back in the column, in order, at its own height"
          onClick={() => ctx.setDock(defaultDock(ctx.rules))}>Reset layout</button>
      </div>
    </div>
  );
};
