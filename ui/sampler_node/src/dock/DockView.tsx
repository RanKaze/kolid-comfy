import React, { useRef } from 'react';
import {
  type Dock, type DockBlock, type DockFloat, type DockMode, type DockNode, type DockRules, type UnitId, type Zone,
  type SpreadSizes,
  DOCK_GROW_MIN_H, DOCK_MIN_SZ, DOCK_SPLIT, FLOAT_MIN_H, FLOAT_MIN_W,
  defaultDock, dockBackDock, docUidOf, dragSplit, dropInDock, flexOf, popOutDock,
  rewriteHolder, setFloatDock, zoneOf,
} from './model';

// ── Dock 的骨架 ──：一颗单元 = 卡片 + 标题把手。iOS 词汇（#1c1c1e 卡片、发丝内缩分隔、
// #8e8e93 大写小标题、#0a84ff 强调）从这里开始就是全页通用，不再只属于 Settings 页。
// Only the frame is here; a unit's own interior (its cards and rows) keeps the page's skin.
//
// 布局是 **Block 平铺**：页面被切成一块块矩形，每块的大小只由框架（父 split 的份额，或用户拖过的像素）
// 决定，内容永远撑不动它。块与块之间那条 8px 的缝就是把手 —— 拖它改大小，没有第二个 resize 手势。
// 一个块里装什么由它的 mode 决定：`default` = 一个 dock window（多单元＝一行可换行的 tab），
// `v`/`h` = 容器，一个单元一个窗口地叠着排，按内容占高、块不够就滚、成员可以折叠。
const dockStyles: Record<string, React.CSSProperties> = {
  dockBox: { background: '#1c1c1e', borderRadius: 10, border: '0.5px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden' },
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
  // 浮窗右下角那颗：浮窗不在任何 split 里，没有块的分界线可拖，所以它自己留一颗改大小的角。
  dockCorner: { position: 'absolute', right: 1, bottom: 1, width: 12, height: 12, cursor: 'nwse-resize', background: 'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.26) 50%)' },
  dockNoteBox: { position: 'absolute', inset: 0, zIndex: 3, boxShadow: 'inset 0 0 0 2px #0a84ff', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' },
  dockNote: { fontSize: 10, fontWeight: 700, color: '#0a84ff', background: 'rgba(10,132,255,0.14)', padding: '2px 8px', borderRadius: 999 },
  // The dock fills the page and tiles it: the root is one column, the tree takes every pixel of it and
  // nothing here scrolls as a whole. Every scroller belongs to a container block (see BlockBox) or to a
  // window's own body.
  dockRoot: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingRight: 2, position: 'relative' },
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
  setMode: (id: UnitId, mode: DockMode, spread?: SpreadSizes) => void;
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
  // a unit that is hidden keeps its element (`keepMounted`), and an unmounted one has nothing to measure.
  bodyRef?: (id: UnitId, el: HTMLDivElement | null) => void;
};

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
  node: DockBlock; ctx: DockCtx; axis: 'v' | 'h'; stacked?: boolean; float?: DockFloat;
}> = ({ node, ctx, axis, stacked, float }) => {
  const ids = node.ids;
  const id = ids[Math.min(node.sel, Math.max(0, ids.length - 1))];
  // A fold only has somewhere to go inside a container: a window that fills its block (a `default`
  // block, a float) hides its body and there would be nothing left to show for it, so it is always open
  // and has no fold button at all.
  const folds = stacked ? ids.filter(u => ctx.rules.foldable(u)) : [];
  const open = stacked && folds.length ? folds.some(u => ctx.isOpen(u)) : true;
  const fold = (v: boolean) => { for (const u of folds) ctx.fold(u, v); };
  // A unit with nothing to size itself by takes a share of the block instead of collapsing to a strip.
  const grow = ids.some(u => ctx.rules.grows(u));
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
      <span className="dock-h" draggable
        title={'Drag this unit onto a block to move it.\nAn edge splits a new block off, the centre puts it in that block.'}
        onDragStart={e => { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; ctx.setDrag(id); }}
        onDragEnd={() => { ctx.setDrag(null); ctx.setOver(null); }}
        onClick={e => e.stopPropagation()}
        style={dockStyles.dockGrip}><GripDots /></span>
      {ids.length > 1 ? (
        <div style={dockStyles.dockTabs}>
          {ids.map((u, i) => (
            <button key={u} style={dockTabStyle(u === id)} title={'Show ' + ctx.rules.title(u) + ' in this block'}
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
  // to size itself by, in which case it takes a share of the block with a floor under it. `data-dock-member`
  // is how the picker finds the card to measure when the user asks for the container to spread out.
  if (stacked) {
    return (
      <div data-dock-member={node.ids[0]} style={{
        ...dockStyles.dockBox,
        flex: grow ? '1 1 0' : '0 0 auto',
        minHeight: grow && axis === 'v' ? DOCK_GROW_MIN_H : undefined,
        minWidth: axis === 'h' && grow ? 200 : undefined,
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
// `Default` 是唯一会动结构的那个（容器摊成一块一窗），所以点它的那一下要顺手量下「每个窗口现在占
// 多大」一起交出去：容器里的窗口只按内容占高，模型自己不知道这个数，量完摊开才能保住原来的比例。
const spreadOf = (box: Element | null, ids: readonly UnitId[], axis: 'v' | 'h'): SpreadSizes | undefined => {
  if (!box) return undefined;
  const cards = ids.map(u => box.querySelector<HTMLElement>('[data-dock-member="' + u + '"]'));
  if (cards.some(c => !c)) return undefined;
  const r = box.getBoundingClientRect();
  return {
    box: axis === 'v' ? r.height : r.width,
    members: cards.map(c => { const b = c!.getBoundingClientRect(); return axis === 'v' ? b.height : b.width; }),
  };
};
const ModePicker: React.FC<{ node: DockBlock; ctx: DockCtx }> = ({ node, ctx }) => (
  <div style={dockStyles.blockEditBar}>
    {MODES.map(m => (
      <button key={m.mode} title={m.hint}
        style={{ ...dockStyles.blockEditBtn, background: node.mode === m.mode ? '#0a84ff' : 'none', color: node.mode === m.mode ? '#fff' : undefined }}
        onClick={e => {
          e.stopPropagation();
          // Only a container has windows to spread, and only `default` spreads them.
          const spreading = m.mode === 'default' && node.mode !== 'default' && node.ids.length > 1;
          ctx.setMode(node.ids[0], m.mode, spreading
            ? spreadOf(e.currentTarget.closest('[data-dock-block]'), node.ids, node.mode === 'h' ? 'h' : 'v')
            : undefined);
        }}>{m.label}</button>
    ))}
  </div>
);

// ONE BLOCK. `default` draws a card and puts the window in it; `v`/`h` draws a scroller and puts one
// window per unit in it. Either way the block is the drop target — a drop lands on the BLOCK, so a
// container behaves like one thing and not like a row of targets: the centre adds the unit to it, an
// edge splits a fresh block off beside it.
const BlockBox: React.FC<{ node: DockBlock; ctx: DockCtx; axis: 'v' | 'h' }> = ({ node, ctx, axis }) => {
  const container = node.mode !== 'default';
  const target = node.ids[0];
  const isOver = !!ctx.drag && !node.ids.includes(ctx.drag) && ctx.over?.id === target;
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!ctx.drag || node.ids.includes(ctx.drag)) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const zone = zoneOf(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
    if (ctx.over?.id !== target || ctx.over?.zone !== zone) ctx.setOver({ id: target, zone });
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const dragged = (ctx.drag || e.dataTransfer.getData('text/plain')) as UnitId;
    if (!ctx.rules.known(dragged) || node.ids.includes(dragged)) return;
    e.preventDefault(); e.stopPropagation();
    const zone = zoneOf(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
    ctx.setDock(dropInDock(ctx.dock, dragged, target, zone));
    ctx.setOver(null);
  };
  const overlay = !isOver ? null : ctx.over!.zone === 'center' ? (
    <div style={dockStyles.dockNoteBox}><span style={dockStyles.dockNote}>{container ? 'add a window' : 'tab group'}</span></div>
  ) : (
    <div style={{ ...zoneBand(ctx.over!.zone), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <ZoneArrow zone={ctx.over!.zone} />
    </div>
  );
  const chrome: React.CSSProperties = { flex: flexOf(node.sz), position: 'relative' };
  const edit: React.CSSProperties | undefined = ctx.edit
    ? { outline: '1px dashed rgba(10,132,255,0.75)', outlineOffset: -1 }
    : undefined;
  const picker = ctx.edit ? <ModePicker node={node} ctx={ctx} /> : null;
  if (!container) {
    return (
      <div style={{ ...dockStyles.dockBox, ...chrome, ...edit }} onDragOver={onDragOver} onDrop={onDrop}>
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
        <DockWindow key={u} ctx={ctx} axis={node.mode === 'h' ? 'h' : 'v'} stacked
          node={{ t: 'b', ids: [u], sel: 0, mode: 'default' }} />
      ))}
      {overlay}{picker}
    </div>
  );
};

// The boundary between two blocks — and it IS the gap the user sees: the 8px between two cards is this
// element, so there is no second thing to aim at and no handle on a window. Dragging pins the box
// before it and frees the one after (see dragSplit), which is what keeps the row adding up to the page.
// Addressed by PATH, not by unit: the empty work area holds no unit to be named by.
const SplitHandle: React.FC<{ ctx: DockCtx; axis: 'v' | 'h'; prev: number[]; next: number[] }> = ({ ctx, axis, prev, next }) => {
  const start = useRef<{ p: number; a: number; b: number } | null>(null);
  const along = (el: Element | null): number => {
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return axis === 'v' ? r.height : r.width;
  };
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.currentTarget;
    start.current = {
      p: axis === 'v' ? e.clientY : e.clientX,
      a: along(el.previousElementSibling), b: along(el.nextElementSibling),
    };
    try { el.setPointerCapture(e.pointerId); } catch { /* fall back to bubbling events */ }
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    const d = (axis === 'v' ? e.clientY : e.clientX) - s.p;
    const hi = Math.max(DOCK_MIN_SZ, s.a + s.b - DOCK_MIN_SZ);
    // persist=false while the pointer is down: a drag re-renders, it does not hammer localStorage.
    ctx.setDock(dragSplit(ctx.dock, prev, next, Math.max(DOCK_MIN_SZ, Math.min(s.a + d, hi))), false);
  };
  const up = () => { if (!start.current) return; start.current = null; ctx.setDock(ctx.dock); };
  return (
    <div className={ctx.edit ? 'dock-split dock-split-edit' : 'dock-split'}
      title={ctx.edit ? 'Drag to resize these two blocks (Alt+P)' : 'Drag to resize'}
      style={{ flex: `0 0 ${DOCK_SPLIT}px`, cursor: axis === 'v' ? 'row-resize' : 'col-resize', flexShrink: 0, borderRadius: 3 }}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
  );
};

const DockBranch: React.FC<{ node: DockNode; ctx: DockCtx; axis: 'v' | 'h'; path: number[]; root?: boolean }> =
  ({ node, ctx, axis, path, root }) => {
    if (node.t === 'b') return <BlockBox node={node} ctx={ctx} axis={axis} />;
    const d = node.d;
    return (
      <div style={{
        display: 'flex', flexDirection: d === 'v' ? 'column' : 'row',
        minHeight: 0, minWidth: 0, overflow: 'hidden',
        // The root split IS the page, so it takes the whole area rather than sizing to its content.
        // Every other split is measured by whatever its own parent says — a nest has no box of its own.
        flex: root ? '1 1 auto' : flexOf(node.sz),
      }}>
        {node.ks.map((k, i) => (
          <React.Fragment key={i}>
            {i > 0 && <SplitHandle ctx={ctx} axis={d} prev={[...path, i - 1]} next={[...path, i]} />}
            <DockBranch node={k} ctx={ctx} axis={d} path={[...path, i]} />
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
