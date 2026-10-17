import React, { useEffect, useRef, useState } from 'react';
import {
  type Dock, type DockBlock, type DockFit, type DockFloat, type DockMode, type DockNode, type DockRules, type UnitId, type Zone,
  type ZonePoint, type ZoneRect,
  DOCK_GROW_MIN_H, DOCK_MIN_SZ, DOCK_SPLIT, FLOAT_MIN_H, FLOAT_MIN_W,
  defaultDock, dead, clampSz, dockBackDock, dockFloor, docUidOf, dragOutUnits, dragSplit, dropUnits, flexOf, floorPct, freezeAt, nodeAt, popOutDock,
  rewriteHolder, setFloatDock, sizeAt, mergeIntoMember, insertCellAt, pullOutAt, cellsOf, zoneAxis, zoneOf, zonePoly, zoneRect,
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
  // 拖动中的插入线：它回答的是"松手之后插在哪"，所以画在成员之间的**空隙**上，不画在成员身上。
  dockOrderLine: { position: 'fixed', zIndex: 69, pointerEvents: 'none', background: '#0a84ff', borderRadius: 1, boxShadow: '0 0 6px rgba(10,132,255,0.75)' },
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
  // 落点预览的那一层：线框 + 一层薄填充，不遮内容，但边界清清楚楚。
  zoneNote: { fontSize: 10, fontWeight: 700, color: '#d7eaff', background: 'rgba(10,132,255,0.28)', border: '0.5px solid rgba(10,132,255,0.6)', borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' },
  // The dock fills the page and tiles it: the root is one column, the tree takes every pixel of it and
  // nothing here scrolls as a whole. Every scroller belongs to a container block (see BlockBox) or to a
  // window's own body.
  dockRoot: { flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingRight: 2, position: 'relative' },
  // Alt+P 那颗浮标：Alt+P 是切换键（再按一次或 Esc 退出），打开期间它一直在，关掉就整页干净。
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

// The landing preview: which block, which band of it, the block's box in VIEWPORT coordinates, and the
// sentence that says what the drop will do.
//
// The box is carried here instead of being measured at draw time for one reason: the preview is drawn
// at the dock's root, not inside the block. A container block is a SCROLLER, and an absolutely
// positioned child of a scroller is offset by its scrollTop — dragging onto the settings column after
// scrolling it down would light up a band that had slid out of the block. Anchoring to the viewport is
// also what lets the label escape a 96px block instead of being clipped by its overflow.
// 拖拽时按住 Alt 就是对容器里的**某一格**说"和它叠成一个 tab 组"（见 mergeIntoMember）。那不是
// 块的四分里的一片，而是一个成员本身，所以它另开一条判据、另画一个形状：整格的一个框，不是梯形带。
// `merge` 记的就是那一格的单元 id。
export type DockOver = { id: UnitId; zone: Zone; box: { x: number; y: number; w: number; h: number }; label: string; merge?: UnitId };

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
  // 切换开的 **Block 编辑模式**：平时页面上没有模式控件，因为一块怎么排是装修，不是日常。
  edit: boolean;
  // The mode of the block owning this unit — the only write Alt+P makes.
  setMode: (id: UnitId, mode: DockMode) => void;
  dock: Dock;
  // persist=false while a pointer drag is still running — the layout lands in localStorage when the
  // pointer comes up, not once per mousemove.
  setDock: (next: Dock, persist?: boolean) => void;
  drag: DockDrag | null;
  setDrag: (d: DockDrag | null) => void;
  over: DockOver | null;
  setOver: (v: DockOver | null) => void;
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

// 整条标题栏也是搬窗口的抓处。六点那颗只有 12px 宽，而人的直觉是"抓住这条栏拖" —— 专业停靠界面
// （Premiere 的标签页、Photoshop 的标题条）全是这么做的。但只在**空处**成立：栏里的 tab、两颗把手、
// 动作按钮各有各的主人，压住它们时再叠一次"搬整个窗口"就会两个手势一起写载荷。
//
// 判据是"这个事件是谁的"：dragstart 从里面那颗 draggable 冒上来时 `closest('[draggable]')` 是它自己，
// 不是这条栏 —— 那就原样放过去，别动载荷。注意这里**不能** `preventDefault`：那会把里面那颗合法的
// 拖拽一起取消掉。
const grabBar = (ctx: DockCtx, ids: readonly UnitId[]) => ({
  draggable: true,
  onDragStart: (e: React.DragEvent) => {
    const t = e.target as HTMLElement;
    const owner = t.closest('[draggable]');
    if (owner && owner !== e.currentTarget) return;
    if (t.closest('button')) return;
    grab(ctx, ids).onDragStart(e);
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
// 容器块里每个窗口的 **reorder 把手**已撤掉（拍板：重排并进最原本的拖拽）。
// 抓手只剩六点那一颗，它同时做三件事，按落点分流：
//   * 停到别的块的边/中 = 分割或并入（HTML5 拖拽 + 落点预览）；
//   * 停到**本块**成员与成员之间的缝上 = 在这一格里换名次（同一条插入线，见 gapIndexAt）；
//   * 拖出这一块放手 = 浮成独立小窗。
// 曾经另有一颗 ⇕ 把手专管"只在本块内重排"，把手那一套（指针拖拽 + ro 状态）整条删除 ——
// 两条手势做同一件事，留两颗抓处只会让人先猜该抓哪颗。

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

// 落点预览 —— 位置来自 `zoneRect`，**形状**来自 `zonePoly`，判定用的 `zoneOf` 是同一套规则，
// 所以"亮在哪就落在哪"，连面积的边角都对得上。
//
// 为什么边带是梯形：角落只能归一个方向，规则是"最近的那条边"胜，于是两条对角斜线把四个角各切给
// 相邻的带（判定在 model.ts 的 zoneOf，形状在 zonePoly）。画成矩形就等于承诺了一块松手后拿不到
// 的三角 —— 指针停在那个角上，框还说"左侧分割"，判定其实已经是"上方分割"。
//
// 用 SVG 而不是 CSS 盒子：梯形有两条斜边，`border-radius` 表达不了；`clip-path` 能裁形状，但裁掉
// 的恰好是描边要画的地方。polygon 的描边自己就是形状。
//
// 画在 dock 根上、用视口坐标（`position: fixed`），不画进块里：块可能是滚动容器（设置列就是），
// 绝对定位的子节点会被 scrollTop 顶跑；块也可能只有 96px 宽，标签会被它的 overflow 裁掉。
const zoneBoxStyle = (box: DockOver['box'], r: ZoneRect): React.CSSProperties => ({
  position: 'fixed', zIndex: 68, pointerEvents: 'none',
  left: box.x + r.left * box.w, top: box.y + r.top * box.h,
  width: r.width * box.w, height: r.height * box.h,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  // 90ms 只够把"跳一下"变成"移过去"：换带的时候能看清它跟到了哪一条，又不至于拖泥带水。
  transition: 'left 90ms ease, top 90ms ease, width 90ms ease, height 90ms ease',
});

const ZonePreview: React.FC<{ zone: Zone; box: DockOver['box']; label: string; merge?: UnitId }> = ({ zone, box, label, merge }) => {
  // 合并预览画的是**一整格**，不是块的四分之一：它承诺的是"这一格会变成一条 tab 条"，形状就该是
  // 那一格自己的样子。所以这里不用 `zoneRect`/`zonePoly`，直接用成员量到的盒子。
  if (merge) return (
    <div data-dock-zone="merge" data-dock-zone-merge={merge} data-dock-zone-poly=""
      style={{
        position: 'fixed', zIndex: 68, pointerEvents: 'none',
        left: box.x, top: box.y, width: box.w, height: box.h,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(10,132,255,0.14)', border: '1.5px solid rgba(10,132,255,0.95)',
        borderRadius: 8, boxShadow: '0 0 0 1px rgba(10,132,255,0.35) inset',
      }}>
      <span style={dockStyles.zoneNote}>{label}</span>
    </div>
  );
  const r = zoneRect(zone);
  const W = r.width * box.w, H = r.height * box.h;
  // 块内比例 → 外接矩形内的像素。外接矩形只用来定位，形状仍然是整块的四分。
  const px = ([u, v]: ZonePoint): string =>
    `${(((u - r.left) / r.width) * W).toFixed(1)},${(((v - r.top) / r.height) * H).toFixed(1)}`;
  const pts = zonePoly(zone).map(px).join(' ');
  return (
    // `data-dock-zone-poly` 是形状本身（bbox 内的像素顶点）。探针和拖放测试拿它做"这个点在不在
    // 这个 zone 里"的判断 —— 只看 `data-dock-zone` 的话，"框是矩形还是梯形"就验不了。
    <div data-dock-zone={zone} data-dock-zone-poly={pts} style={zoneBoxStyle(box, r)}>
      {/* viewBox 与元素同尺寸，所以没有缩放、描边不会被拉成粗细不匀的一条。 */}
      <svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
        style={{ position: 'absolute', inset: 0, display: 'block', overflow: 'visible' }}>
        <polygon points={pts} fill="rgba(10,132,255,0.14)" stroke="rgba(10,132,255,0.95)"
          strokeWidth={1.5} strokeLinejoin="round" />
      </svg>
      {/* 箭头 + 文字竖着排：窄带（96px 宽的块，一条竖带只有 24px）横向是排不下的。
          外接矩形的中心一定落在梯形里（斜边从四角切，中心在两条斜边之间），所以居中就够。 */}
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
        <ZoneArrow zone={zone} />
        <span style={dockStyles.zoneNote}>{label}</span>
      </div>
    </div>
  );
};

// 每个落点是什么意思，一句话说清。用户不必先记住规则再拖 —— 拖的时候它自己讲。
const ZONE_WORD: Record<Zone, string> = {
  top: '上方分割', bottom: '下方分割', left: '左侧分割', right: '右侧分割', center: '放入此块',
};

// 两个落点是不是同一件事：块、带、框、话。框也算，因为块的盒子会随布局/滚动变。
const sameOver = (a: DockOver | null, b: DockOver): boolean =>
  !!a && a.id === b.id && a.zone === b.zone && a.label === b.label && a.merge === b.merge
  && Math.round(a.box.x) === Math.round(b.box.x) && Math.round(a.box.y) === Math.round(b.box.y)
  && Math.round(a.box.w) === Math.round(b.box.w) && Math.round(a.box.h) === Math.round(b.box.h);

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
  // 工作台播报前，树里存档的 doc:* 尚未验证（rules.known 为 false）：sel 指着它时就先显示这一格
  // 第一个已验证的单元 —— 既不闪一扇标题为 "doc:1" 的空窗，也不让整格无端消失；播报一到，sel 指的
  // 文档验证通过，显示自然回到它身上。
  const picked = ids[Math.min(node.sel, Math.max(0, ids.length - 1))];
  const id = ctx.rules.known(picked) ? picked : (ids.find(u => ctx.rules.known(u)) ?? picked);
  // A fold only has somewhere to go inside a container: a window that fills its block (a `default`
  // block, a float) hides its body and there would be nothing left to show for it, so it is always open
  // and has no fold button at all.
  const folds = stacked ? ids.filter(u => ctx.rules.known(u) && ctx.rules.foldable(u)) : [];
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
  // 整格一个验证过的单元都没有（播报前只剩存档 doc:* 的一扇窗）：什么都不画。位置在模型里留着
  // （死块不占屏幕，见 dead），等工作台播报（EditPhase 的 announced 闸门）这扇窗原地出现。守卫放在
  // 所有 hook 之后，免得条件渲染撞上 hook 顺序。
  if (!ctx.rules.known(id)) return null;
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
    ctx.setDock({ ...ctx.dock, tree: rewriteHolder(ctx.dock.tree, ids[i], n => {
      if (n.t !== 'b') return n;
      // 容器里的一格在树里不是一个块（它只是容器 `ids` 的一段），没有自己的 sel —— 选中项按单元
      // 记在 `shown` 上：换 tab 只动这一格显示谁，不动容器的形状。
      if (n.groups) return { ...n, shown: [...(n.shown ?? []).filter(u => !ids.includes(u)), ids[i]] };
      return { ...n, sel: i };
    }) });
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
    <div className="dock-bar" data-dock-bar
      style={{ ...dockStyles.dockBar, borderBottom: open ? dockStyles.dockBar.borderBottom : undefined }}
      // 浮窗的栏走指针拖拽（它不在任何 split 里，没有"落点"可言）；其余每一扇窗的栏都是 HTML5
      // 拖拽源 —— 抓这条栏就是搬这扇窗，和抓左边的六点是同一件事，只是抓处大得多。
      {...(float ? {} : grabBar(ctx, ids))}
      onPointerDown={barDown} onPointerMove={barMove} onPointerUp={barUp} onPointerCancel={barUp}
      onClick={e => {
        if (suppressFold.current) { suppressFold.current = false; return; }
        // `[draggable]` 只看**里面**那颗（tab、六点把手），不是这条栏自己 —— 栏本身就是抓处，
        // 不排除自己的话，这一行的每一次点击都会在这里被当成"不是折叠区"而丢掉。
        const t = e.target as HTMLElement;
        const owner = t.closest('[draggable]');
        if (owner && owner !== e.currentTarget) return;
        if (t.closest('button')) return;
        // One bar, two jobs, split by what the unit is: a foldable member of a container folds,
        // a document window runs the project it names.
        if (folds.length) fold(!open); else ctx.activate?.(id);
      }}>
      {/* The window's HANDLE. Dragging IT moves the WHOLE window: every unit behind the tab strip
          travels with it, because a window is one thing and this is the thing the user grabbed. The
          tabs opposite are the items' own titles, and a drag on one of those takes that item ALONE out
          of the group — which is the whole difference between the two gestures (see DockDrag). */}
      <span className="dock-h" data-dock-grip {...grab(ctx, ids)}
        title={'Drag to move this whole window.\nAn edge splits a new block off, the centre puts it in that block.\nDropped on the seam between two members of its own block = take that slot instead.'}
        onClick={e => e.stopPropagation()}
        style={dockStyles.dockGrip}><GripDots /></span>
      {ids.length > 1 ? (
        <div style={dockStyles.dockTabs}>
          {/* 播报前存档的 doc:* 还没验证：不出现在 tab 条上（它此刻的标题只是内部 id）。下标仍按
              `ids` 算，pick 用的还是原下标。 */}
          {ids.map((u, i) => ({ u, i })).filter(({ u }) => ctx.rules.known(u)).map(({ u, i }) => (
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
// 拖到容器上 = "和这一格叠成 tab 组"。判定按**成员**，不按块的四分：容器里每一格都是它自己的 DOM
// （`data-dock-member`），用户指着哪一格，答案就该是哪一格 —— 而块的四分会把"这一格的下半截"读成
// "在整块的下面切一刀"，正是这个手势最容易踩空的地方。
//
// 什么时候用这套判定：**手拿别处的窗口 + 按住 Alt**（并进这一格），或者 **手拿的就是这个容器自己的
// 成员**（无论按不按 Alt）。后者是用户最常做、也最容易被误读的一手：把一个窗口拖到同一竖列的另一
// 个窗口上。以前这一手落到块的四分里，前半列正好压在"上方分割"带 —— 于是"合并两个窗口"被执行成
// "把这一列切开、把这个窗口挪出去"，用户看到的是**整个 Vertical 块被拆成好几个块**。容器里的两个
// 窗口之间不存在"在哪儿切一刀"这种位置，所以只要指针按在某一格上，答案就只能是并进去。
//
// 位置靠两种命中合起来定：先按事件 target 往上找成员；找不到就按几何找（块里两格之间有 8px 的缝，
// 窗口内容也可能自己吃掉 dragover —— 这两种情况下用户明明指着那一格，不该失手）。
const MERGE_WORD = '并入 tab 组';
// 容器里两格之间的缝（`stackStyle` 的 gap）只有 6px，`gapIndexAt` 往两侧各多要这么多像素作为手抖余量。
const GAP_PAD = 3;
// 插入线要落在**两个成员之间那条缝的正中**：两侧成员各自对着这一刀的那条边取中点。`- 1` 是给自身 2px
// 的身位让出一半 —— 线的中心落在中点上，线就不会偏到哪一侧去。
// 一刀的两端有可能只有一边有成员（插在最前面 / 插在最后面）：那时另一侧的"墙"就是这个容器的开始/结束。
// 最后一位之后还要夹一层上限 —— 容器常常比它的内容长（末尾留白有时有几百像素），取正中的话线会
// 跑到离最后一个窗口很远的地方，看着不像"插在它后面"。
const SEAM_MAX = 10;
const seamMid = (a?: number, b?: number, start?: number, end?: number): number => {
  if (typeof a === 'number' && typeof b === 'number') return (a + b) / 2;
  if (typeof b === 'number' && typeof start === 'number') return (start + b) / 2;
  if (typeof a === 'number' && typeof end === 'number') return (a + Math.min(end, a + SEAM_MAX)) / 2;
  return ((start ?? 0) + (end ?? 0)) / 2;
};
const memberUnder = (
  node: DockBlock, boxEl: HTMLElement | null, e: React.DragEvent,
): { id: UnitId; box: DockOver['box'] } | null => {
  const rectOf = (r: DOMRect): DockOver['box'] => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  const hit = (e.target as HTMLElement | null)?.closest?.('[data-dock-member]') as HTMLElement | null;
  if (hit && boxEl?.contains(hit)) {
    const id = hit.dataset.dockMember as UnitId | undefined;
    if (id && node.ids.includes(id)) return { id, box: rectOf(hit.getBoundingClientRect()) };
  }
  if (!boxEl) return null;
  for (const m of [...boxEl.children] as HTMLElement[]) {
    const id = m.dataset?.dockMember as UnitId | undefined;
    if (!id || !node.ids.includes(id)) continue;
    const r = m.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)
      return { id, box: rectOf(r) };
  }
  return null;
};

// 一格该显示哪个单元：用户点过的那个（`shown`），没有就是组首。
const shownSel = (b: DockBlock, cell: readonly UnitId[]): number => {
  if (cell.length < 2) return 0;
  const u = b.shown?.find(x => cell.includes(x));
  const i = u ? cell.indexOf(u) : 0;
  return i < 0 ? 0 : i;
};

const BlockBox: React.FC<{ node: DockBlock; ctx: DockCtx; axis: 'v' | 'h'; count: number }> = ({ node, ctx, axis, count }) => {
  const container = node.mode !== 'default';
  const target = node.ids[0];
  // 成员盒子的参照：Alt 合并要按格量尺寸（炸开容器时原样写下去），块内重排要按格算位置。
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dir: 'v' | 'h' = node.mode === 'h' ? 'h' : 'v';
  // 预览只在"这一落点真的会做事"时出现。三种话，一句一个意思：
  //   * 边带 + 手里是别处的单元 → 在这里**分割**出一个新块（区间框就是新块的地盘）；
  //   * 边带 + 手里是本块自己的成员 → **拖出**去变成自己的块（同一个 zone，两种含义，所以得说清）；
  //   * 中间 → 并进这块：`default` 是加一行 tab，容器是多一个窗口。
  //
  // 这里只**判定并上报**，画由 DockPanel 在根上画：块本身可能是滚动容器，也可能只有 96px 宽，
  // 预览跟着块走就会被顶跑、被裁掉。判定与绘制分家，但两者用的是同一个 `zoneRect`。
  const wordOf = (z: Zone, ids: readonly UnitId[]): string => z === 'center'
    ? (container ? '并入容器 · Alt 并 tab' : '并入 tab 组')
    : ((node.ids.some(i => ids.includes(i)) ? '拖出为新块 · ' : '') + ZONE_WORD[z]);
  // Hovering with a member of this very block counts too: its edge is the "drag it out to a block of
  // its own" target, and the preview should say so. `over` is only ever set for a zone this block
  // accepts, so the centre of one's own block (a no-op) sets none and shows none.
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    const ids = ctx.drag?.ids;
    if (!ids) return;
    const mine = node.ids.filter(i => ids.includes(i));
    const whole = mine.length === node.ids.length;
    if (container && !whole) {
      const hit = memberUnder(node, boxRef.current, e);
      // 合并（成员的地盘）：别处的窗口按住 Alt，或手里就是本块自己的成员 —— 按在某一格上 =
      // 并成 tab 组。判定按成员，不按块的四分（见 memberUnder 上面的注释）。
      if (hit && !ids.includes(hit.id) && (e.altKey || mine.length)) {
        e.preventDefault(); e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        // 换了落点就要换话：这条蓝线说的是"插在第几位"，现在说的是"并进这一格" —— 留着它，
        // 用户会以为松手同时做两件事。预览永远只有一句。
        clearGap();
        const next: DockOver = { id: target, zone: 'center', merge: hit.id, label: MERGE_WORD, box: hit.box };
        if (!sameOver(ctx.over, next)) ctx.setOver(next);
        return;
      }
      // 缝（`stackStyle` 的 gap，flex 里没有 DOM 的那 6px）是谁的落点：
      //   * 手里是本块自己的成员 → 整格搬到那一位（`pullOutAt`，整格在手时等价 moveCell，组跟着格走）；
      //   * 手里是别处的窗口   → 作为新的一格插到那一位（`insertCellAt`，容器不拆）。
      // 按在格子上仍然各有各的地盘（上面合并 / 下面 zone 四分），缝不抢 —— 一次拖拽两种目标，
      // 各占一块地，互不抢（见 gapIndexAt）。
      const from = cellOf(ids);
      // 拖的是组里的某几个 tab（不是整格）？这一手势的源格还在，"第几位"照原序列读。
      const partial = from >= 0 && cells[from].length > ids.length;
      const el = boxRef.current;
      const k = el && !hit ? gapIndexAt(el, e.clientX, e.clientY) : null;
      // 别处的窗口没有"自己原来在第几位"：把 `from` 假成格数，`slotFor` 就退成"画在第 k 格前沿"。
      const at = el && k !== null ? slotFor(el, k, from >= 0 ? from : cells.length, partial) : null;
      // `partial` 时 `to === from` 不是"原位放回"（那是从组里拆出来排前面），不滤。
      if (at && (partial || at.to !== from) && (from >= 0 || ids.every(i => ctx.rules.known(i)))) {
        e.preventDefault(); e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        if (!gap || gap.to !== at.to || gap.from !== from || gap.partial !== partial)
          setGap({ from, to: at.to, partial, line: at.line });
        if (ctx.over) ctx.setOver(null);
        return;
      }
      clearGap();
      if (mine.length) {
        // 不在缝上（块自己的留白、滚动条），或者这一插就要原位放回去：都不给承诺 —— 不画线、
        // 不 preventDefault，松手也就真的无事发生。
        e.stopPropagation();
        if (ctx.over) ctx.setOver(null);
        return;
      }
      // 别处的窗口没按在缝上：落回块的 zone 四分（中心 = 加进容器，边 = 切新块）。
    }
    const box = e.currentTarget.getBoundingClientRect();
    const zone = zoneOf(box, e.clientX, e.clientY);
    // Units of THIS block under the pointer have two destinations, and they are the two halves of the
    // block: the centre puts them back where they already are (a no-op the user makes constantly — a
    // drag that misses its target lands home), an edge pulls them OUT beside the block. That is refused
    // for the centre always, and for the whole-block case too: when every unit of this block is in the
    // drag, what is moving IS this block, and there is nothing left behind to anchor to. Refusing here
    // is what stops either of them bubbling out to the dock's own drop, where the answer is "pop a
    // window out" — emphatically not "put it back".
    if (mine.length && (zone === 'center' || whole)) {
      e.stopPropagation();
      if (ctx.over) ctx.setOver(null);
      return;
    }
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const next: DockOver = {
      id: target, zone, label: wordOf(zone, ids),
      box: { x: box.left, y: box.top, w: box.width, h: box.height },
    };
    if (!sameOver(ctx.over, next)) ctx.setOver(next);
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
    const mine = node.ids.filter(i => ids.includes(i));
    const whole = mine.length === node.ids.length;
    // 缝的落点对谁都在：本块成员（`gap.from >= 0`）或别处的窗口 —— 后者没有 Alt 也认缝。
    if (container && !whole && (e.altKey || mine.length || gap)) {
      const hit = memberUnder(node, boxRef.current, e);
      e.stopPropagation();
      if (hit && !ids.includes(hit.id) && (e.altKey || mine.length) && ids.every(i => ctx.rules.known(i))) {
        e.preventDefault();
        note('merge', { ids: ids.join(','), into: hit.id, block: target, cells: cellsOf(node).length });
        ctx.setDock(mergeIntoMember(ctx.dock, ids, hit.id));
      } else if (mine.length && gap && (gap.partial || gap.to !== gap.from) && ids.every(i => ctx.rules.known(i))) {
        // 松手在缝上 = 排到那一位去（和拖动把手那条蓝线同一个落点、同一个动作）。
        // 格子才论"并 tab 组"，缝只论"排第几" —— 一次拖拽里两种目标各占一块地，互不抢。
        // 手里是组里的某几个 tab 时用 `pullOutAt`：源格收缩，它们自立门户插到那一位。
        e.preventDefault();
        note('reorder', { block: target, unit: ids[0], from: gap.from, to: gap.to, via: 'gap', partial: gap.partial ? 1 : 0 });
        ctx.setDock(pullOutAt(ctx.dock, ids, gap.to));
      } else if (!mine.length && gap && ids.every(i => ctx.rules.known(i))) {
        // 别处的窗口松手在缝上：作为新的一格插到那一位。容器不拆，只是多出一格。
        e.preventDefault();
        note('reorder', { block: target, unit: ids[0], to: gap.to, via: 'gap-new' });
        ctx.setDock(insertCellAt(ctx.dock, ids, target, gap.to));
      }
      setGap(null);
      ctx.setOver(null);
      return;
    }
    const zone = zoneOf(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
    // Landing home, or moving a whole block onto itself: refused HERE means refused, not "let the page
    // have it" (see onDragOver).
    if (mine.length && (zone === 'center' || whole)) {
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
  // ── 容器成员的**重排** ────────────────────────────────────────────────────────────────────────
  // 一颗抓处做全部的事：抓住六点/标题栏拖，落点决定它是什么动作 —— 别的块的边/中是分割或并入，
  // **本块成员之间的缝**是换名次，dock 的空背景是浮成小窗。所以判断必须做在块身上：成员之间没有
  // DOM 节点（它们是 flex 的 gap），折叠之后只剩一条标题栏、块的 scroller 也在这里。
  //
  // 拖动期间**不动树**：每帧改一次就要每帧写一次 localStorage，成员还会在指针底下跳着换位。松手时
  // 才搬一次 —— 过程里用户看到的是那条插入线，落定才看到结果，和停靠预览是同一套节奏。
  //
  // 这里说的"第几位"是**格**的下标：一格可能就是一条 tab 组（Alt 合并），整格一起搬，组不拆。
  const cells = cellsOf(node);
  // 拖拽指着**格与格之间的缝**时的落点预览。`partial` = 手里是 tab 组里的某几个 tab：松手时源格
  // 收缩、这几个 tab 自立门户（pullOutAt），不是"整格搬到那一位"（整格在手时 pullOutAt 即等价
  // moveCell，见 model.ts）。
  const [gap, setGap] = useState<{ from: number; to: number; partial: boolean; line: { x: number; y: number; w: number; h: number } } | null>(null);
  useEffect(() => { if (!ctx.drag && gap) setGap(null); }, [ctx.drag, gap]);
  // 只要"这一落点不再承诺插队"，线就得收回去 —— 换到某格去合并、拖出这一块、松手、拖拽被取消，
  // 四种情况说一句话：预览只能有一句。少清一处，用户看到的就不是预告，而是上一句话的回声。
  const clearGap = () => { if (gap) setGap(null); };
  // 指针**离开**这块 box 同样要收线：`dragover` 只会在这个元素里继续移动时才发，出去了就没人再说了，
  // 而别的块（或 dock 自己的投放区）会说出它自己的话。`dragleave` 在进入子元素时也会发一次，
  // 所以按坐标判断是否真出界。
  const onDragLeaveCapture = (e: React.DragEvent<HTMLDivElement>) => {
    if (!gap) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) clearGap();
  };
  // 拿起来的是哪一格：拖的东西可能是一个单元，也可能是整扇窗（tab 组）——它们都在同一格里。
  const cellOf = (ids: readonly UnitId[]) => cells.findIndex(c => c.some(u => ids.includes(u)));
  // 插在第 `k` 个成员前面（**原序列**下标）到底是哪一位、线画在哪儿。
  // 把自己从序列里拿掉之后，排在它后面的人各前移一位 —— 所以"落在身后"要减一，否则拖到下一个
  // 成员身上会读到差一位的结果，松手后看起来像没动。
  // `partial` = 拖的是**组里的某几个 tab**：源格还在（只是少了几个 tab），后面的人不前移 ——
  // 照原序列读第几位。这时 `k === from`（插在自己那一格前面）也是真有意义的动作：从组里拆出来
  // 排到最前面，所以调用方不能用 `to !== from` 把它当"原位放回"滤掉。
  const slotFor = (el: HTMLElement, k: number, from: number, partial = false) => {
    const kids = [...el.querySelectorAll<HTMLElement>(':scope > [data-dock-member]')];
    if (!kids.length) return null;
    const to = Math.max(0, Math.min(kids.length - 1, partial ? k : (k > from ? k - 1 : k)));
    // 线画在哪一刀，要看 `to` 是哪个口径的下标 —— 两种拖法不能共用一个公式：
    //   * 整格搬移：`to` 是**移除后**的下标。落在身后（to >= from）时，移除让后面的成员各前移了
    //     一位，这一刀后面那个成员在原序列里是 to+1，线画在 kids[to] 与 kids[to+1] 之间；落在身前
    //     （to < from）时没人前移，线画在 kids[to-1] 与 kids[to] 之间。
    //   * 从组里拆 tab：源格还在（只是少了几个 tab），没人前移，`to` 就是**原序列**下标 —— 线永远
    //     画在 kids[to-1] 与 kids[to] 之间，即 `to` 这一刀。
    // 混用一个公式（`to < from ? to : to + 1`）时，partial 的线会比落点低一条缝：用户瞄的是这一刀，
    // 松手却落在上一刀 —— 报上来的"拖到 i 却落到 i+1"正是这个（落点一直跟着光标走，是线在骗人）。
    const edge = partial ? to : (to < from ? to : to + 1);
    const el0 = el.getBoundingClientRect();
    const rs = kids.map(x => x.getBoundingClientRect());
    // 落在**缝的正中间**：取这一刀两侧那两个成员各自对着它的那条边的中点。以前是贴着后一个成员的
    // 前沿画（`- 1` 再留 2px 的身位），整条线压在下面/右边那个窗口身上 —— 用户瞄的是那条缝，
    // 线偏着一边看着就是"没对准"，也容易被读成"线属于下面那个窗口"。
    const prev = rs[edge - 1], next = rs[edge];
    const line = dir === 'v'
      ? { x: el0.left, y: seamMid(prev?.bottom, next?.top, el0.top, el0.bottom) - 1, w: el0.width, h: 2 }
      : { x: seamMid(prev?.right, next?.left, el0.left, el0.right) - 1, y: el0.top, w: 2, h: el0.height };
    return { to, line };
  };
  // 指针是不是落在两个成员**之间**那道缝上 —— 容器是 flex-gap 排版，缝里没有 DOM，`memberUnder`
  // 两种命中都够不到它。返回"插在第几个前面"（原序列下标），不在缝上返回 null。
  //
  // 6px 太窄了瞄不准，往两侧各多要 3px：多出来的那点正好是格子最外一圈，而想**合并**的人是照着格子
  // 中段按的，抢不走他的目标。横向判定同理：要落在两个成员之间那条连线的延长段上，而不是它们侧面
  // 空出来的地方（那里本就了无归属，不是"两个元素之间"）。
  const gapIndexAt = (el: HTMLElement, x: number, y: number): number | null => {
    const kids = [...el.querySelectorAll<HTMLElement>(':scope > [data-dock-member]')];
    const rs = kids.map(k => k.getBoundingClientRect());
    for (let i = 0; i + 1 < rs.length; i++) {
      const a = rs[i], b = rs[i + 1];
      const along = dir === 'v'
        ? y >= a.bottom - GAP_PAD && y <= b.top + GAP_PAD
        : x >= a.right - GAP_PAD && x <= b.left + GAP_PAD;
      // 顺带量一下横向：要落在两个成员之间那条连线的延长段上，而不是它们侧面空出来的地方
      // （那片空地不属于"两个元素之间"）。
      const across = dir === 'v'
        ? x >= Math.min(a.left, b.left) && x <= Math.max(a.right, b.right)
        : y >= Math.min(a.top, b.top) && y <= Math.max(a.bottom, b.bottom);
      if (along && across) return i + 1;
    }
    return null;
  };
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
  const dropLine = gap?.line ?? null;
  // `dragenter` 与 `dragover` 共用一套判定，这不是冗余：按拖拽规范，指针**进入**一个新元素时只派发
  // `dragenter`，在同一元素内继续移动才派发 `dragover`，而松手时是否派发 `drop` 取决于最后一次
  // `dragover`/`dragenter` 有没有被取消。只接 `dragover` 的那一版，"最后一移刚好跨过一个元素
  // 边界"（从按钮进到成员 body、从一条 tab 进到另一块）就成了没授权的拖拽 —— 松手什么也不发生，
  // 而这是最常见的收尾方式。接上 `dragenter`，进入即授权，与规范一致。
  const onDragIn = onDragOver;
  if (!container) {
    // The block wears `data-dock-block` in BOTH branches: a container is found by it in the DOM, and a
    // `default` block is found by nothing else — the picker, the inspector and the drag tests all want
    // to name a block without walking the tree.
    return (
      <div data-dock-block={target} style={{ ...dockStyles.dockBox, ...chrome, ...edit }}
        onDragEnterCapture={onDragIn} onDragOverCapture={onDragOver} onDropCapture={onDrop}>
        <DockWindow node={node} ctx={ctx} axis={axis} />
        {picker}
      </div>
    );
  }
  // 容器真正的成员是**格**，不是单元：一格可能挂着一条 tab 条（Alt 合并，见 mergeIntoMember）。
  // 一格一个时它和 ids 一一对应，和老行为完全一致。
  return (
    <div className="dark-scroll" data-dock-block={target} ref={boxRef}
      style={{ ...stackStyle(dir), ...chrome, ...edit }}
      onDragEnterCapture={onDragIn} onDragOverCapture={onDragOver} onDragLeaveCapture={onDragLeaveCapture} onDropCapture={onDrop}>
      {cells.map(cell => (
        <DockWindow key={cell[0]} ctx={ctx} axis={dir} stacked solo={cells.length === 1}
          node={{ t: 'b', ids: cell, sel: shownSel(node, cell), mode: 'default' }} />
      ))}
      {/* 插入线画在 dock 的**根**坐标系里（fixed + 视口坐标），不画在块里：块自己是滚动容器，
          绝对定位的子节点会被 scrollTop 顶着走，线就会落在错误的两个人之间。
          四个方向要显式写成 left/top/width/height —— `x`/`y`/`w`/`h` 不是 CSS 属性，
          React 会把它们当未知属性丢掉，元素就退回静态位置、尺寸为 0。
          它只有一个来源：抓住窗口拖到本块成员之间的缝上（`gap`）——"松手就插在这儿"。 */}
      {dropLine && (
        <div data-dock-order-line="" style={{
          ...dockStyles.dockOrderLine,
          left: dropLine.x, top: dropLine.y, width: dropLine.w, height: dropLine.h,
        }} />
      )}
      {picker}
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
      n.t === 's' ? n.ks.map((k, i) => ({ k, i })).filter(({ k }) => !dead(k, ctx.rules.known)) : [];
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
    // `known` 一起传下去：播报前只剩未验证文档的那条分支也算空洞，不占屏幕。
    if (!root && dead(node, ctx.rules.known)) return null;
    const d = node.d;
    const pinned = typeof node.sz === 'number' && node.sz > 0;
    // Only the children with something to show are drawn, and a handle is the boundary between two
    // DRAWN boxes: a folded-away nest between two live blocks leaves no pair of handles around an
    // invisible box — the two live blocks simply become neighbours, and the boundary the user grabs
    // is the one they can see. Paths still address the model, so a drag lands on the right nodes.
    const live = node.ks.map((k, i) => ({ k, i })).filter(({ k }) => !dead(k, ctx.rules.known));
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
  // 拖拽期间让页面上每一个 iframe 都"让开"。
  //
  // 这是"拖到画布旁边什么也没发生"的根因：HTML5 拖拽的 dragover/drop 是**按文档**派发的，指针一旦
  // 进入 `<iframe>` 的矩形，事件就交给那个文档了 —— 宿主这边听不到 dragover，块算不出落点，预览不
  // 出现，松手时自然什么都不发生。而画布本身就是一个 iframe，于是"把窗口拖到画布下面/左右"这个最
  // 常用的动作，指针必须先压着画布走一段，正好废在最需要它的地方。
  //
  // 遮罩层解决不了：遮罩会把 dragover 从块手里接走，块就永远判不出落点，等于换一个地方坏。真正的
  // 办法是让 iframe 在这几秒里 `pointer-events:none`——指针"穿过"它，落到它下面的块上，和拖拽开始
  // 那一帧完全一样。松手（或 Esc 取消）立刻恢复，否则画布再也点不动。
  //
  // 依赖用布尔而不是 `ctx.drag` 本身：那个对象每设一次都是新引用，会让这段效果在每次 setDrag 时重
  // 跑一遍，白白闪一下 iframe。
  const dragging = !!ctx.drag;
  useEffect(() => {
    if (!dragging) return;
    const frames = [...document.querySelectorAll<HTMLIFrameElement>('iframe')];
    if (!frames.length) return;
    const prev = frames.map(f => f.style.pointerEvents);
    const restore = () => { frames.forEach((f, i) => { f.style.pointerEvents = prev[i]; }); };
    for (const f of frames) f.style.pointerEvents = 'none';
    // 兜底，而且是必须的那一种：`onDragEnd` 只在拖拽源还活着时派发。Esc 取消、拖拽源被重渲染换掉、
    // 窗口失焦，这几种都收不到它 —— 一旦漏掉，iframe 就永久 `pointer-events:none`，画布再也点不动，
    // 只能刷新。所以除 React 状态外，事件本身也直接负责把指针还回去（restore 幂等，多执行无妨）。
    document.addEventListener('dragend', restore, true);
    document.addEventListener('drop', restore, true);
    window.addEventListener('blur', restore);
    return () => {
      document.removeEventListener('dragend', restore, true);
      document.removeEventListener('drop', restore, true);
      window.removeEventListener('blur', restore);
      restore();
    };
  }, [dragging]);
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    // 走到这里就说明指针**不在任何一个会接它的块上**（块接住或主动拒绝时都会 stopPropagation），
    // 所以先收掉残留的落点预览。以前这一句写在多单元判断之后，拖着一个窗口掠过块与块之间的缝时，
    // 上一块的线框会一直亮着 —— 一个永远等不到松手的承诺，比不画更糟。
    if (ctx.over) ctx.setOver(null);
    // The dock's own background takes ONE unit, and pops it out as a window. A whole window dropped
    // here has nowhere to go — a float holds one unit, and quietly keeping some of them would lose the
    // rest — so the gesture is refused (leaving `preventDefault` uncalled is what shows the pointer a
    // "not allowed" cursor instead of a drop preview that would lie).
    if (!ctx.drag || ctx.drag.ids.length > 1) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
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
    // `onDragEnter` 与 `onDragOver` 同理（见 BlockBox 的 onDragIn）：进入死区时也要接住，
    // 否则"最后一移刚好从块外跨进来"的那一下松手不会弹窗。
    <div className="dark-scroll" data-dock-frame style={dockStyles.dockRoot}
      onDragEnter={onDragOver} onDragOver={onDragOver} onDrop={onDrop}>
      <DockBranch node={ctx.dock.tree} ctx={ctx} axis="v" path={[]} root />
      {ctx.dock.floats.map(f => (
        <DockWindow key={f.id} ctx={ctx} axis="v" float={f} node={{ t: 'b', ids: [f.id], sel: 0, mode: 'default' }} />
      ))}
      {/* 落点预览：整页只有这一块。它按**视口坐标**画（见 DockOver），所以块的滚动、裁剪、圆角
          都影响不到它 —— 用户看到的形状，就是松手后会出现的那块地方。 */}
      {ctx.drag && ctx.over && (
        <ZonePreview zone={ctx.over.zone} box={ctx.over.box} label={ctx.over.label} merge={ctx.over.merge} />
      )}
      {ctx.edit && (
        <div data-dock-edit="" style={dockStyles.dockEditBar}>
          <span style={dockStyles.dockEditHint}>Block 编辑 · 顶上三选一改模式 · 拖分界线改大小 · 拖标题栏或六点搬窗口 · 箭头只在本块内换位 · 竖排/横排块里拖到另一格＝并成 tab 组（别处的窗口按住 Alt 也一样） · 再按 Alt+P 或 Esc 退出</span>
          <button style={dockStyles.dockResetBtn} title="Put every unit back in its column, in order"
            onClick={() => ctx.setDock(defaultDock(ctx.rules))}>Reset layout</button>
        </div>
      )}
    </div>
  );
};
