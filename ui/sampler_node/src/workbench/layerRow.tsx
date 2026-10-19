import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { BlendAttrChip, BlendChainLane, BlendLayerRow, BlendStack, BlendUiSend } from '../types';
import type { WorkbenchHostCtx } from './registry';
import { useBlendUi } from './store';
import { useLayerEditBlocked } from './editGate';

// Layers / Guidances 两格的正文。两格用的是同一套行代码（页面那一句 renderStackList 也是），
// 区别只有头部那几颗按钮和空态那句话，所以这里交出来的是一块 `LayerListView`，两格各摆一份。
//
// 归属照 W1 定下的那条线：这一侧只有**文字、摆法、菜单条目、缝位**；图层、attribute 记录、链、
// 面（像素）全在页面那一侧，这里读的是它播下来的行描述符（types 的 BlendLayerRow）。每一颗控件
// 按下去发的都是一个动作键，落点函数就是页面那颗按钮今天调的同一句 —— 语义没有第二份。
//
// 三件事必须住在模块里而不是 React 状态里，因为它们是**跨两格**的：
//   · 拖拽的源与落点（一行可以从 Layers 拖到 Guidances，一条链的步可以跨层）
//   · 那口右键菜单（整页同时只有一张，两格都想摆它）
//   · 可见区（页面拿 `'visible-faces'` 当**整份**闸用，两格的键得合成一个集合）

/** 跨两格共用的拖拽源。id 就是那一行的 id / 那一枚记录的 guid / 链里那一步的 id。 */
let rowDragId: number | null = null;
let attrDragRef: { layerId: number; attrId: string } | null = null;
let fxDragRef: { layerId: number; attrId: string; stepId: number } | null = null;

/** 行外那两枚 MIME：图层行起拖时带上 `x-blend-layer`（工作区那一格认它把图层收进图池），
 *  工作区条目起拖时带 `x-blend-staging`（落到这一摞 = 以智能图层加入）。字符串与页面那一侧
 *  blend_node.html 的 STAGING_LAYER_TYPE / STAGING_ITEM_TYPE 同一份，退休 DOM 之前两边不会走散。 */
const STAGING_LAYER_TYPE = 'application/x-blend-layer';
const STAGING_ITEM_TYPE = 'application/x-blend-staging';
const hasType = (dt: DataTransfer | null, t: string) => !!dt && Array.from(dt.types).includes(t);
// 外部文件那一岔：操作系统拖进来的东西在 types 里只有一个词 'Files'（页面的 dropHasFiles 同一句）。
const hasFiles = (dt: DataTransfer | null) => hasType(dt, 'Files');

type Over = { key: string; seam?: 'above' | 'below' | 'before' | 'after' | 'into'; slot?: number };
type Menu = { stack: BlendStack; kind: 'row' | 'attr' | 'attr-add' | 'add'; rowId: number; attrId: string;
  x: number; y: number; up?: boolean; sub?: string };
type Hover = { stack: BlendStack; id: number; key: string } | null;
type RowUi = { over: Over | null; dragging: string; menu: Menu | null; hover: Hover };

let rowUi: RowUi = { over: null, dragging: '', menu: null, hover: null };
const rowSubs = new Set<() => void>();
const setRowUi = (patch: Partial<RowUi>) => {
  // dragover 是连续事件：落点没换就不算一次变化，否则每一帧都会把两格整摞重绘一遍。
  const prev = rowUi;
  const next = { ...prev, ...patch };
  if (next.over?.key === prev.over?.key && next.over?.seam === prev.over?.seam
    && next.over?.slot === prev.over?.slot && next.dragging === prev.dragging
    && next.menu === prev.menu && next.hover?.key === prev.hover?.key) return;
  rowUi = next;
  rowSubs.forEach(fn => fn());
};
const subRowUi = (fn: () => void) => { rowSubs.add(fn); return () => { rowSubs.delete(fn); }; };
export const useRowUi = (): RowUi => useSyncExternalStore(subRowUi, () => rowUi, () => rowUi);

export const closeMenu = () => setRowUi({ menu: null });
const endDrag = () => { rowDragId = null; attrDragRef = null; fxDragRef = null; setRowUi({ over: null, dragging: '' }); };

// Esc 关掉那张菜单 —— 页面那一句在它的键盘处理里（Esc 先收菜单，别的事情才轮到后面）。这里只需要
// 前半句，所以挂在 window 上而不是卡片上：卡片没有焦点，键盘事件不会自己落进来。
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeMenu(); });
}

// ---- 可见区：面通道那道闸的宿主这一侧 ----
// 页面只在 `faceVisible` 报过的键上编像素，所以这一侧必须把**两格所有**正在看着的面键报上去，
// 而且是整份（页面拿去换掉整颗集合）。同一枚 attribute 记录可以挂在两层的条带上（共享面），
// 那时两个元素问的是同一个键 —— 所以这里记的是引用数，不是键的集合：最后一个看着它的元素走了才丢。
const faceRefs = new Map<string, number>();
let faceSend: BlendUiSend | null = null;
let faceFlush = 0;
const flushFaces = () => {
  if (faceFlush || !faceSend) return;
  faceFlush = requestAnimationFrame(() => {
    faceFlush = 0;
    faceSend?.('visible-faces', Array.from(faceRefs.keys()));
  });
};

/** 把这一格元素纳入可见区观测。`key` 换成另一张面时旧那张要跟着退账，否则页面会一直替一张
 *  没人看的面留预算。History 那一格的预览走的也是这道闸（同一份引用计数，见 useFaceChannel）。 */
export function useFaceVisible(ref: React.RefObject<HTMLElement>, key: string): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !key) return;
    let on = false;
    const bump = (next: boolean) => {
      if (next === on) return;
      on = next;
      const n = (faceRefs.get(key) || 0) + (next ? 1 : -1);
      if (n > 0) faceRefs.set(key, n); else faceRefs.delete(key);
      flushFaces();
    };
    const io = new IntersectionObserver(es => { for (const e of es) bump(e.isIntersecting); });
    io.observe(el);
    return () => { io.disconnect(); bump(false); };
  }, [key]);
}

/** 报可见区的那句出口。每一格的 `send` 都是同一颗（同一个 iframe 只有一个发送口），所以谁最后挂载
 *  谁握着它没关系 —— History 那一格因此和这两格共用同一份引用计数，两道闸（可见区 + 每帧封顶）也
 *  因此只有一套实现。 */
export function useFaceChannel(send: BlendUiSend): void {
  useEffect(() => { faceSend = send; }, [send]);
}

// ---- Alt+悬浮那张放大预览 ----
// 页面原来直接把 layerSource() 画进一块 canvas；这一侧只能读面通道，所以按 Alt 落到某一行时发
// 一句 'hover-face' 要那一张**原分辨率**（≤480）的 PNG，键 `layer:<id>:hover`。指针跟摆位走的是
// 命令式那一段（与页面同一理由：mousemove 每帧换 state 会把整摞重绘）。
const HP_OFFSET = 18, HP_EDGE = 8;
let hoverEl: HTMLDivElement | null = null;
let hoverAt = { x: 0, y: 0 };
function positionHover() {
  const el = hoverEl;
  if (!el) return;
  const r = el.getBoundingClientRect();
  let x = hoverAt.x + HP_OFFSET, y = hoverAt.y + HP_OFFSET;
  if (x + r.width > window.innerWidth - HP_EDGE) x = Math.max(HP_EDGE, hoverAt.x - r.width - HP_OFFSET);
  if (y + r.height > window.innerHeight - HP_EDGE) y = Math.max(HP_EDGE, hoverAt.y - r.height - HP_OFFSET);
  el.style.left = x + 'px';
  el.style.top = y + 'px';
}

/** 指针**当前停在哪一行**上（页面的 hpHover 那一枚 provider，这里换成行坐标 + 有没有预览可给）。
 *  没有 buffer 的行与页面那颗 provider 同一句早退：它没有画面可放大，问了也是白问。 */
let hoverRow: { stack: BlendStack; id: number; key: string; canPreview: boolean } | null = null;
let hoverSend: BlendUiSend | null = null;
/** 这一行已经问过一张放大图没有 —— 页面自己有签名缓存，内容真换了才回新的，所以同一行反复进出
 *  不必再喊一遍；换行（或离开）才清掉这一格记性。 */
let hoverAskedId: number | null = null;
const showHover = () => {
  const r = hoverRow;
  if (!r || !r.canPreview || !hoverSend) { hideHover(); return; }
  if (hoverAskedId !== r.id) { hoverAskedId = r.id; hoverSend('hover-face', { id: r.id }); }
  setRowUi({ hover: { stack: r.stack, id: r.id, key: r.key } });
};
const hideHover = () => { hoverAskedId = null; setRowUi({ hover: null }); };

/** 页面的那两句全局监听：Alt 在指针不动时按下/松开也要有反应（mousemove 这时根本不会来）。
 *  两格共用一对，所以按引用数装拆。 */
let hoverWired = 0;
function useHoverKeys() {
  useEffect(() => {
    hoverWired++;
    const down = (ev: KeyboardEvent) => {
      if (ev.key !== 'Alt' || !hoverRow) return;
      ev.preventDefault();      // 与页面同一句：Alt 不交给浏览器去动菜单
      showHover();
    };
    const up = (ev: KeyboardEvent) => { if (ev.key === 'Alt') hideHover(); };
    if (hoverWired === 1) {
      window.addEventListener('keydown', down);
      window.addEventListener('keyup', up);
    }
    return () => {
      hoverWired--;
      if (hoverWired === 0) {
        window.removeEventListener('keydown', down);
        window.removeEventListener('keyup', up);
      }
    };
  }, []);
}

const HoverPreview = ({ stack }: { stack: BlendStack }) => {
  const ui = useBlendUi();
  const { hover } = useRowUi();
  const ref = useRef<HTMLDivElement | null>(null);
  const mine = hover && hover.stack === stack ? hover : null;
  const url = mine ? ui.faces[mine.key] : '';
  useEffect(() => { hoverEl = mine ? ref.current : (hoverEl === ref.current ? null : hoverEl); }, [mine]);
  useLayoutEffect(() => { if (mine && url) positionHover(); }, [mine, url]);
  if (!mine) return null;
  return (
    <div ref={ref} className="hover-preview" style={{ display: url ? 'block' : 'none' }}>
      {/* 那张面还没到就整块不出现 —— 摆一张空卡片比什么都不摆更像一个坏掉的预览。 */}
      {url && <img src={url} alt="" draggable={false} onLoad={() => positionHover()} />}
    </div>
  );
};

// ---- 只有行在用的那几枚图形：path 与页面那一侧一字不差（门禁比这两串） ----
const Eye = ({ visible }: { visible: boolean }) => (
  <svg viewBox="0 0 16 16" width="14" height="14">
    <path d="M8 3.6C4.7 3.6 2 5.9 1.1 8c.9 2.1 3.6 4.4 6.9 4.4S14.9 10.1 15 8c-.9-2.1-3.6-4.4-6.9-4.4z"
      fill="none" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="8" cy="8" r="1.9" fill="currentColor" />
    {!visible && <path d="M2.4 2.4 13.6 13.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
  </svg>
);
const Run = () => <svg viewBox="0 0 16 16" width="14" height="14"><path d="M5.4 3.2 12.8 8 5.4 12.8z" fill="currentColor" /></svg>;
const Jump = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.6 3.4h3v3" /><path d="M12.6 3.4 7.7 8.3" />
    <path d="M11.1 9.6v2.1a1.2 1.2 0 0 1-1.2 1.2H4.3a1.2 1.2 0 0 1-1.2-1.2V6.3a1.2 1.2 0 0 1 1.2-1.2h2.1" />
  </svg>
);
const NoImage = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4 4 L12 12 M12 4 L4 12" stroke="#ff3b30" strokeWidth="2" strokeLinecap="round" fill="none" />
  </svg>
);
const Plus = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" aria-hidden="true"><path d="M8 3.4v9.2M3.4 8h9.2" /></svg>
);

// ---- 那三口菜单（行的 / 那一枚 attribute 的 / `+` 的）与头部那颗 Add ----
// 条目文案、出现与灰掉的判据全在这一侧（拍板 5.a），谓词随快照的行描述符来；卡片照页面的
// `.layer-menu` / `.io-menu` 摆，坐标先按指针落、再用真实尺寸夹回窗口内 —— 与页面 positionLayerMenu
// 同两句。摆法用宿主这一列已经认下的那条路子（一整屏透明的垫层 + 里面的卡片）：垫层自己就是关掉它的
// 那一下，比在 iframe 里挂 window 监听更省事，也与 preset 行那口菜单同一个词汇。
const MenuCard = ({ menu, children }: { menu: Menu; children: React.ReactNode }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // up = 从一颗按钮往上翻（头部那颗 Add，页面那一条 `.add-menu` 就是这个方向），否则按指针的右下摆。
    let x = menu.x;
    let y = menu.up ? menu.y - r.height - 6 : menu.y;
    x = Math.max(6, Math.min(x, window.innerWidth - r.width - 6));
    y = Math.max(6, Math.min(y, window.innerHeight - r.height - 6));
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    // 量到真实尺寸之前不亮相：卡片没有固定高度，先画在指针上再跳一下比慢一帧更难看。
    setPlaced(true);
  }, [menu]);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300 }}
      onClick={closeMenu}
      onContextMenu={ev => { ev.preventDefault(); closeMenu(); }}>
      <div ref={ref} className={menu.kind === 'add' ? 'io-menu' : 'layer-menu'} role="menu"
        style={{ visibility: placed ? 'visible' : 'hidden' }}
        onClick={ev => { ev.stopPropagation(); closeMenu(); }}>
        {children}
      </div>
    </div>
  );
};

/** `keepOpen` 是给那一口**就地展开**的菜单用的（`+` 里点 decal/mask 要先问绑哪条 video 轨）：
 *  按下去换的是这口菜单的内容，菜单不该跟着关掉。默认那一下照旧——按了就关。 */
const MenuItem = ({ label, title, onClick, disabled, keepOpen }:
  { label: string; title: string; onClick: () => void; disabled?: boolean; keepOpen?: boolean }) => (
  <button type="button" role="menuitem" className="layer-menu-item" title={title} disabled={disabled}
    onClick={ev => { ev.stopPropagation(); if (!keepOpen) closeMenu(); onClick(); }}>
    {label}
  </button>
);

/** 头部那颗 Add 与条带末尾那颗 `+` 的条目：一条一个 `<span>` 两行（名字 + 那句说明），与页面的
 *  `.io-menu-item` 同一形状。`checkable` 那一颗是 menuitemcheckbox，勾由快照说话。 */
const IOItem = ({ title, label, sub, onClick, checked, checkable }:
  { title: string; label: string; sub: string; onClick: () => void; checked?: boolean; checkable?: boolean }) => (
  <button type="button" role={checkable ? 'menuitemcheckbox' : 'menuitem'}
    aria-checked={checkable ? !!checked : undefined} className="io-menu-item" title={title}
    onClick={ev => { ev.stopPropagation(); closeMenu(); onClick(); }}>
    <span className="io-menu-title">{checkable && checked ? '✓ ' : ''}{label}</span>
    <span className="io-menu-sub">{sub}</span>
  </button>
);

// ---- 条带上的一枚 attribute ----
const AttrChip = ({ row, chip, send }: { row: BlendLayerRow; chip: BlendAttrChip; send: BlendUiSend }) => {
  const ui = useBlendUi();
  const ref = useRef<HTMLDivElement | null>(null);
  const st = useRowUi();
  useFaceVisible(ref, chip.face);
  // 这一枚 chip 在**宿主自己的**拖放状态里叫什么。它和 face 通道那支 attr 键只是长得像：这一串从不
  // 过界，面键的构造权归页面那一位作者（门禁以"这一侧零字面量"钉住这件事，所以这里连引号都不写）。
  const key = 'chip:' + chip.guid;
  const seam = st.over && st.over.key === key ? st.over.seam : undefined;
  const cls = ['layer-thumb', 'attr-chip', chip.chipClass,
    chip.enabled ? '' : 'attr-off', chip.armed ? 'active' : '',
    st.dragging === key ? 'dragging' : '',
    seam === 'before' ? 'drop-before' : seam === 'after' ? 'drop-after' : seam === 'into' ? 'drop-into' : ''];
  const faceUrl = chip.face ? ui.faces[chip.face] : '';
  return (
    <div ref={ref} className={cls.filter(Boolean).join(' ')} data-attr={chip.guid} draggable
      title={chip.title + ` · Ctrl+click turns this step ${chip.enabled ? 'off (its data stays, the fold just skips it)' : 'back on'}`}
      onClick={ev => {
        ev.stopPropagation();
        // ctrl+左键 = 启用/停用这一步（全体 attribute 同一套手势）；普通点击才是 spec.open 那一句。
        if (ev.ctrlKey || ev.metaKey) send('attr-toggle', { layerId: row.id, attrId: chip.guid });
        else send('attr-open', { layerId: row.id, attrId: chip.guid });
      }}
      onContextMenu={ev => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!row.selected) send('layer-select', { id: row.id, from: 'row' });
        setRowUi({ menu: { stack: row.stack, kind: 'attr', rowId: row.id, attrId: chip.guid, x: ev.clientX, y: ev.clientY } });
      }}
      onDragStart={ev => {
        // 这一枚自己就是拖拽源：让它冒到行上，行的那套（图层重排序）会把它当成整层被拖走。
        ev.stopPropagation();
        attrDragRef = { layerId: row.id, attrId: chip.guid };
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', chip.guid);
        setRowUi({ dragging: key, over: null });
      }}
      onDragEnd={() => endDrag()}
      onDragOver={ev => {
        // 链里的一步拖到这枚魔棒 chip 上 = 收进这条链（尾步）。这是空链唯一的落点，
        // 高亮是整颗描边，与左右缝位线区分开 —— 与页面 attrChip 那两句同一个分流。
        if (fxDragRef && chip.kind === 'chain') {
          ev.preventDefault(); ev.stopPropagation(); ev.dataTransfer.dropEffect = 'move';
          setRowUi({ over: { key, seam: 'into' } });
          return;
        }
        if (!attrDragRef || attrDragRef.attrId === chip.guid) return;
        const r = ev.currentTarget.getBoundingClientRect();
        const side = (ev.clientX - r.left) < r.width / 2 ? 'before' : 'after';
        ev.preventDefault(); ev.stopPropagation(); ev.dataTransfer.dropEffect = 'move';
        setRowUi({ over: { key, seam: side } });
      }}
      onDragLeave={() => { if (st.over?.key === key) setRowUi({ over: null }); }}
      onDrop={ev => {
        if (fxDragRef && chip.kind === 'chain') {
          ev.preventDefault(); ev.stopPropagation();
          const d = fxDragRef; fxDragRef = null;
          const lane = laneOf(row, chip.guid);
          send('fx-step-move', { layerId: d.layerId, attrId: d.attrId, stepId: d.stepId,
            toLayerId: row.id, toAttrId: chip.guid, index: lane ? lane.steps.length : 0 });
          setRowUi({ over: null, dragging: '' });
          return;
        }
        if (!attrDragRef || attrDragRef.attrId === chip.guid) return;
        ev.preventDefault(); ev.stopPropagation();
        const r = ev.currentTarget.getBoundingClientRect();
        const after = (ev.clientX - r.left) >= r.width / 2;
        const d = attrDragRef; attrDragRef = null;
        send('attr-move', { attrId: d.attrId, fromLayerId: d.layerId, toLayerId: row.id, beforeAttrId: chip.guid, after });
        setRowUi({ over: null, dragging: '' });
      }}>
      {chip.face && faceUrl && <img src={faceUrl} alt="" draggable={false} />}
      {/* 链没有面，那枚魔棒是"顺序里有这么一步"的记号。画法由页面交过来（chip.glyph = fxWandSvg()），
          React 里它得包一层 span（同一颗元素不能既塞 innerHTML 又放兄弟节点），所以那一条
          `.attr-off > svg` 的暗淡在这里多认一条 `.attr-visual > svg` —— CSS 里记明的第三处适配。 */}
      {!chip.face && chip.glyph && <span className="attr-visual" dangerouslySetInnerHTML={{ __html: chip.glyph }} />}
      {chip.badge && <span className={'attr-type-badge ' + chip.badgeClass} dangerouslySetInnerHTML={{ __html: chip.badge }} />}
      {/* 停用那枚红叉：页面用 syncAttrChipState 翻 `<i>` 的 class，可 CSS 认的是父颗的 `.attr-off`，
          所以这里只由 chip.enabled 决定那颗 class，结果一模一样。 */}
      <i className="attr-badge" />
    </div>
  );
};

const laneOf = (row: BlendLayerRow, guid: string): BlendChainLane | undefined =>
  row.chains.find(c => c.guid === guid);

// ---- 特效链：摊在行上方的那一块容器 ----
// 越贴近图层行那一步越先执行（`.fx-steps` 是 column-reverse），所以这里按**执行序**交数组，
// DOM 序就是这么写的（column-reverse 把执行序末尾往上画）。槽位算法：数"中点在指针下方"的 chip。
const ChainLane = ({ row, lane, send }: { row: BlendLayerRow; lane: BlendChainLane; send: BlendUiSend }) => {
  const ui = useBlendUi();
  const st = useRowUi();
  const openId = ui.fx.open?.stepId ?? 0;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const key = 'chain:' + lane.guid;
  const slotHere = st.over && st.over.key === key ? st.over.slot : undefined;
  const n = lane.steps.length;
  const slotAt = (clientY: number) => {
    const box = boxRef.current;
    if (!box) return 0;
    let k = 0;
    for (const c of Array.from(box.querySelectorAll('.fx-chip'))) {
      const rc = c.getBoundingClientRect();
      if (rc.top + rc.height / 2 > clientY) k++;
    }
    return k;
  };
  return (
    <div ref={boxRef} className={'fx-chain' + (lane.bypass ? ' bypassed' : '')} data-fx-lane={lane.guid}
      onDragOver={ev => {
        if (!fxDragRef) return;
        ev.preventDefault(); ev.stopPropagation(); ev.dataTransfer.dropEffect = 'move';
        setRowUi({ over: { key, slot: slotAt(ev.clientY) } });
      }}
      onDragLeave={ev => {
        // 进出子元素不算离开容器，否则擦过一颗 chip 就闪断插入线。
        if (ev.relatedTarget && boxRef.current?.contains(ev.relatedTarget as Node)) return;
        setRowUi({ over: null });
      }}
      onDrop={ev => {
        if (!fxDragRef) return;
        ev.preventDefault(); ev.stopPropagation();
        const k = slotAt(ev.clientY);
        const d = fxDragRef; fxDragRef = null;
        send('fx-step-move', { layerId: d.layerId, attrId: d.attrId, stepId: d.stepId,
          toLayerId: row.id, toAttrId: lane.guid, index: k });
        setRowUi({ over: null, dragging: '' });
      }}>
      <div className="fx-steps">
        {lane.steps.map((step, i) => {
          const ck = 'fx:' + step.id;
          const before = slotHere === i && (slotHere as number) < n;
          const after = slotHere !== undefined && slotHere >= n && i === n - 1;
          return (
            <div key={ck} draggable data-fx={step.id}
              className={['fx-chip', step.enabled ? '' : 'disabled', st.dragging === ck ? 'dragging' : '',
                step.id === openId ? 'open' : '',
                before ? 'drop-before' : '', after ? 'drop-after' : ''].filter(Boolean).join(' ')}
              onDragStart={ev => {
                ev.stopPropagation();
                fxDragRef = { layerId: row.id, attrId: lane.guid, stepId: step.id };
                ev.dataTransfer.effectAllowed = 'move';
                ev.dataTransfer.setData('text/plain', 'fx:' + step.id);
                setRowUi({ dragging: ck, over: null });
              }}
              onDragEnd={() => endDrag()}
              // 点这一枚 = 展开/收起**这一步**的参数面（Effect Parameters 那一格）。页面那一侧还是只有
              // `fxOpenId` 那一个变量说"哪一步摊着"，所以这里发的是坐标，toggle 语义留在它那里。
              // 勾选框与行尾那枚 × 各自 stopPropagation，不会顺带把面板点开。
              title={`${step.label} — click to ${step.id === openId ? 'close' : 'open'} its parameters`}
              onClick={() => send('fx-step-open', { layerId: row.id, attrId: lane.guid, stepId: step.id })}>
              <input type="checkbox" checked={step.enabled} aria-label="Enable this effect"
                title={step.enabled ? 'Bypass this effect' : 'Enable this effect'}
                onClick={ev => ev.stopPropagation()}
                onChange={ev => { ev.stopPropagation(); send('fx-step-toggle', { layerId: row.id, attrId: lane.guid, stepId: step.id }); }} />
              {step.icon && <span className="fx-icon" dangerouslySetInnerHTML={{ __html: step.icon }} />}
              <span className="fx-name">{step.label}</span>
              <div className="fx-read">{step.readout}</div>
              <button type="button" className="icon-btn" title="Remove this effect"
                style={{ fontSize: 14, lineHeight: 1 }}
                onClick={ev => { ev.stopPropagation(); send('fx-step-remove', { layerId: row.id, attrId: lane.guid, stepId: step.id }); }}>×</button>
            </div>
          );
        })}
      </div>
      {/* 内核跳过整链时把原因写在容器上：可见文本，不塞 tooltip，更不静默。 */}
      {lane.skip && <div className="fx-warn">{`Chain skipped — ${lane.skip}`}</div>}
    </div>
  );
};

// ---- 一行 ----
// 类型角标那句说明与名字后面那个后缀，都照页面 renderStackList 里的两条三元链原文（门禁比这两串）。
const BADGE_TITLE: Record<string, string> = {
  model: '3D layer — its picture was baked from a scene; the jump button opens that scene as a tab',
  text: 'Text layer — the picture is re-rendered from the text at any size; double-click it on the canvas to edit',
  direction: 'Direction layer — the picture is the canvas view of a direction; point it in the Direction tool (D)',
  stash: 'Stash layer — its picture is the layers under it, merged again on every draw; an effect here runs on that whole stack. '
    + 'Welded to the canvas, so it does not move, scale or rotate.',
  raster: 'Raster layer — pixels are baked 1:1 to the canvas; every transform resamples',
  smart: 'Smart layer — transform is non-destructive and keeps the native image',
};
const nameSuffix = (row: BlendLayerRow): string =>
  row.kind === 'model' ? ' · 3D'
    : row.kind === 'cud' ? (row.cudLinked ? ' · cud' : ' · cud (unlinked)')
      : row.kind === 'text' ? ' · text' : row.kind === 'direction' ? ' · direction'
        : row.kind === 'stash' ? ' · stash' : row.kind === 'raster' ? ' · raster' : '';

const LayerRow = ({ row, send, video }: { row: BlendLayerRow; send: BlendUiSend; video: WorkbenchHostCtx['video'] }) => {
  const ui = useBlendUi();
  const st = useRowUi();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const origRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  useFaceVisible(origRef, row.orig);
  useFaceVisible(canvasRef, row.canvas);
  const rowKey = 'row:' + row.id;
  const seam = st.over && st.over.key === rowKey ? st.over.seam : undefined;
  const stripKey = 'strip:' + row.id;
  const stripOver = st.over && st.over.key === stripKey;
  const hoverKey = row.hover;
  const cudTitle = row.cudLinked
    ? `Cud layer — a flattened copy of「${row.cudName}」, repainted whenever that file is saved`
    : "Cud layer — its picture is a flattened copy of「" + row.cudName + "」, but the link did not survive the page reload. "
      + "The pixels are this file's own; right-click the row to Relink.";
  const badgeTitle = row.kind === 'cud' ? cudTitle : BADGE_TITLE[row.kind] || BADGE_TITLE.smart;
  const noImage = !row.orig;
  const isJump = row.kind === 'cud' || row.kind === 'model';
  const runTitle = !row.canGen ? `「${row.name}」is the Mask layer itself — not a Generate target`
    : row.hasImg ? `Refine「${row.name}」from its own image and mask (nothing painted = the whole layer)`
      : `Generate into「${row.name}」from noise — the whole layer (${row.native.w} × ${row.native.h})`;
  const commit = () => {
    setRenaming(false);
    if (draft !== row.name) send('layer-rename', { id: row.id, name: draft });
  };
  useEffect(() => {
    if (!renaming) return;
    const el = inputRef.current;
    if (el) { el.focus(); el.select(); }
  }, [renaming]);
  // 行的三件套与页面 hpWire 同一套：进入时记下"指针在这一行上"并按 Alt 决定画不画，移动时同样问一句
  // （指针不动而按下 Alt 的那一下由全局那两句补上），离开时彻底放掉。
  const park = (ev: React.MouseEvent) => {
    hoverRow = { stack: row.stack, id: row.id, key: hoverKey, canPreview: row.menu.hasBuffer };
    hoverSend = send;
    hoverAt = { x: ev.clientX, y: ev.clientY };
  };

  return (
    <div className={['layer-row', row.selected || row.grouped ? 'selected' : '', row.visible ? '' : 'hidden-layer',
      st.dragging === rowKey ? 'dragging' : '', seam === 'above' ? 'drop-above' : seam === 'below' ? 'drop-below' : '']
      .filter(Boolean).join(' ')}
      data-id={row.id}
      draggable={!renaming}
      title="Drag to reorder · drop it on the other stack to move it there"
      onClick={ev => send('layer-select', { id: row.id, from: 'row', shift: ev.shiftKey })}
      onContextMenu={ev => {
        ev.preventDefault(); ev.stopPropagation();
        // 页面那两句：不是这一行就选它；是这一行但组里没有它，也再点一次。合并成一句谓词就是"两者之一没成"。
        if (!row.selected || !row.grouped) send('layer-select', { id: row.id, from: 'row' });
        setRowUi({ menu: { stack: row.stack, kind: 'row', rowId: row.id, attrId: '', x: ev.clientX, y: ev.clientY } });
      }}
      onDragStart={ev => {
        rowDragId = row.id;
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', String(row.id));
        // 同一趟拖到工作区条上 = 把这一层此刻的合成结果存进图池（工作区那一格认这一枚类型）。
        try { ev.dataTransfer.setData(STAGING_LAYER_TYPE, String(row.id)); } catch { /* 类型受限时只剩排序 */ }
        setRowUi({ dragging: rowKey, over: null });
      }}
      onDragEnd={() => endDrag()}
      onDragOver={ev => {
        // 行拖拽只在真的是「拖动一行」时接管：外部文件与工作区缩略图经过这里时原样放行，
        // 让那一格自己的落点说话（页面当年同一条守卫）。
        if (rowDragId === null) return;
        ev.preventDefault(); ev.stopPropagation(); ev.dataTransfer.dropEffect = 'move';
        const r = ev.currentTarget.getBoundingClientRect();
        setRowUi({ over: { key: rowKey, seam: (ev.clientY - r.top) < r.height / 2 ? 'above' : 'below' } });
      }}
      onDragLeave={() => { if (st.over?.key === rowKey) setRowUi({ over: null }); }}
      onDrop={ev => {
        if (rowDragId === null) return;
        ev.preventDefault(); ev.stopPropagation();
        const r = ev.currentTarget.getBoundingClientRect();
        const above = (ev.clientY - r.top) < r.height / 2;
        const id = rowDragId; rowDragId = null;
        send('layer-move', { id, toId: row.id, above, stack: row.stack });
        setRowUi({ over: null, dragging: '' });
      }}
      onMouseEnter={ev => { park(ev); if (ev.altKey) showHover(); }}
      onMouseMove={ev => { park(ev); if (ev.altKey) { showHover(); positionHover(); } else hideHover(); }}
      onMouseLeave={() => { hoverRow = null; hideHover(); }}>
      {/* 链容器摊在 head 之上；同一种挂了两枚容器时，条带上越靠左（越先执行）的那块排得越贴近 head。 */}
      {[...row.chains].reverse().map(lane => <ChainLane key={lane.guid} row={row} lane={lane} send={send} />)}
      <div className="layer-row-main">
        <div ref={origRef} className={['layer-thumb', noImage ? 'no-image' : '',
          row.selected && ui.mode === 'transform' ? 'active' : ''].filter(Boolean).join(' ')}
          title={noImage
            ? (row.kind === 'text'
              ? '1 · Empty text layer — double-click it on the canvas (or press Enter) to type'
              : '1 · No image yet — run Generate (the ▶ on the row, or right-click it) or drop an image here')
            : 'Original image — click to transform this layer'}
          onClick={ev => { ev.stopPropagation(); send('layer-select', { id: row.id, from: 'thumb', shift: ev.shiftKey }); }}>
          {!noImage && ui.faces[row.orig] && <img src={ui.faces[row.orig]} alt="" draggable={false} />}
          {noImage && <NoImage />}
          <span className={'layer-type-badge ' + (row.kind === 'cud' && !row.cudLinked ? 'cud unlinked' : row.kind)}
            title={badgeTitle} dangerouslySetInnerHTML={{ __html: row.badgeSvg }} />
        </div>
        <div className="layer-name" title="Double-click to rename"
          onDoubleClick={ev => { ev.stopPropagation(); setDraft(row.name); setRenaming(true); }}>
          {renaming
            ? <input ref={inputRef} className="layer-rename" value={draft} onChange={ev => setDraft(ev.target.value)}
                draggable={false}
                onClick={ev => ev.stopPropagation()}
                onKeyDown={ev => {
                  ev.stopPropagation();
                  if (ev.key === 'Enter') commit();
                  else if (ev.key === 'Escape') setRenaming(false);
                }}
                onBlur={commit} />
            : row.name + nameSuffix(row)}
        </div>
        {isJump && (
          <button type="button" className="icon-btn" disabled={row.kind !== 'model' && !row.cudLinked}
            title={row.kind === 'model' ? `Open the 3D scene behind「${row.name}」as a tab`
              : row.cudLinked ? `Open「${row.cudName}」as a project tab`
                : 'Not linked any more — right-click the row to Relink'}
            onClick={ev => { ev.stopPropagation(); send('layer-jump', { id: row.id }); }}><Jump /></button>
        )}
        <button type="button" className="icon-btn" disabled={!row.canGen} title={runTitle}
          onClick={ev => { ev.stopPropagation(); send('layer-generate', { id: row.id }); }}><Run /></button>
        <button type="button" className="icon-btn" title={row.visible ? 'Hide layer' : 'Show layer'}
          onClick={ev => { ev.stopPropagation(); send('layer-eye', { id: row.id }); }}><Eye visible={row.visible} /></button>
        <button type="button" className="icon-btn" title="Remove layer" style={{ fontSize: 15, lineHeight: 1 }}
          onClick={ev => { ev.stopPropagation(); send('layer-remove', { id: row.id }); }}>×</button>
      </div>
      <div className={'layer-row-thumbs' + (stripOver ? ' drop-tail' : '')}
        onDragOver={ev => {
          // 条带的空隙与 `+` 也是落点：跨层拖到这里 = 追加为这一层的最后一步。
          if (!attrDragRef) return;
          ev.preventDefault(); ev.stopPropagation(); ev.dataTransfer.dropEffect = 'move';
          setRowUi({ over: { key: stripKey } });
        }}
        onDragLeave={() => { if (st.over?.key === stripKey) setRowUi({ over: null }); }}
        onDrop={ev => {
          if (!attrDragRef) return;
          ev.preventDefault(); ev.stopPropagation();
          const d = attrDragRef; attrDragRef = null;
          send('attr-move', { attrId: d.attrId, fromLayerId: d.layerId, toLayerId: row.id, beforeAttrId: null, after: false });
          setRowUi({ over: null, dragging: '' });
        }}>
        <div ref={canvasRef} className="layer-thumb canvas-thumb"
          title="Result preview — this layer as it sits on the canvas; click to transform"
          onClick={ev => { ev.stopPropagation(); send('layer-select', { id: row.id, from: 'thumb', shift: ev.shiftKey }); }}>
          {ui.faces[row.canvas] && <img src={ui.faces[row.canvas]} alt="" draggable={false} />}
        </div>
        {row.attrs.map(chip => <AttrChip key={chip.guid} row={row} chip={chip} send={send} />)}
        <button type="button" className="attr-add" draggable={false}
          title={'Add an attribute to「' + row.name + '」— it runs as the last step of this layer'}
          onClick={ev => {
            ev.stopPropagation();
            if (!row.selected) send('layer-select', { id: row.id, from: 'row' });
            setRowUi({ menu: { stack: row.stack, kind: 'attr-add', rowId: row.id, attrId: '', x: ev.clientX, y: ev.clientY } });
          }}><Plus /></button>
      </div>
      {st.menu && st.menu.stack === row.stack && st.menu.rowId === row.id && (
        <RowMenus menu={st.menu} row={row} send={send} video={video} />
      )}
    </div>
  );
};

/** 一口行 / 条带的菜单：条目全在这一处（拍板 5.a），出现与灰掉问的是快照随行交过来的那六个谓词。 */
const RowMenus = ({ menu, row, send, video }:
  { menu: Menu; row: BlendLayerRow; send: BlendUiSend; video: WorkbenchHostCtx['video'] }) => {
  const ui = useBlendUi();
  // 视频模式下没选中 Layer 段时这两摞本来就不许动手（`StackHead` 那颗 Add 已经灰了）；行级的 `+`
  // 也得守同一条闸 —— 否则"给主文档的图层加 decal"会被误当成"给某个 Layer 段的图层加"而问轨道。
  const blocked = useLayerEditBlocked();
  if (menu.kind === 'attr') {
    const chip = row.attrs.find(a => a.guid === menu.attrId);
    if (!chip) return null;
    const step = row.attrs.findIndex(a => a.guid === menu.attrId);
    const specLabel = chip.label.toLowerCase();
    return (
      <MenuCard menu={menu}>
        <MenuItem label={chip.enabled ? 'Disable' : 'Enable'}
          title={(chip.enabled ? 'The fold skips this step' : 'The fold runs this step again')
            + ' — its data stays exactly where it is either way. Same as Ctrl+clicking the chip.'}
          onClick={() => send('attr-toggle', { layerId: row.id, attrId: chip.guid })} />
        <MenuItem label="Remove"
          title={`Take this ${specLabel} off「${row.name}」— its data leaves with it unless another layer shares it (a shared face stays painted wherever it is used).`}
          onClick={() => send('attr-remove', { layerId: row.id, attrId: chip.guid })} />
        <MenuItem label="Shallow Duplicate"
          title={`Add a second ${specLabel} step right after this one, `
            + (chip.kind === 'chain'
              ? 'carrying the same effects as its own copy — editing one chain leaves the other alone.'
              : 'starting on the same pixels but owning a face of its own — the next stroke lands on one of them, not both.')}
          onClick={() => send('attr-duplicate', { layerId: row.id, attrId: chip.guid })} />
        {step === 0 && (
          <MenuItem label="Apply" title={applyTitle(row, chip)}
            onClick={() => send('attr-apply', { layerId: row.id, attrId: chip.guid })} />
        )}
      </MenuCard>
    );
  }
  if (menu.kind === 'attr-add') {
    // decal / mask（surface 那一类）在**视频模式的 Layer 摞**里要先问"绑哪条 video 轨"：轨清单
    // 只住在宿主（Video 工程），所以这一问就在这口菜单里就地展开 —— 与 Effect Parameters 那行
    // Frame source 是同一份清单、同一个绑定（面记录自己的 frameTrack）。Guidances 摞、Image 模式、
    // 以及工程里还没有视频轨时都不问，照旧直接加入（这就是没有轨道可绑时唯一说得通的做法）。
    const canBind = row.stack === 'layer' && video.mode === 'video' && !blocked && video.tracks.length > 0;
    const sub = menu.sub && canBind ? ui.attrKinds.find(k => k.type === menu.sub) : undefined;
    if (sub) {
      return (
        <MenuCard menu={menu}>
          <MenuItem label="‹ Back" title="Back to the attribute list — nothing has been added yet"
            keepOpen onClick={() => setRowUi({ menu: { ...menu, sub: undefined } })} />
          <MenuItem label="Painted surface"
            title={`Use the surface painted on「${row.name}」— this ${sub.label.toLowerCase()} keeps its own pixels instead of sampling a video frame.`}
            onClick={() => send('attr-add', { layerId: row.id, type: sub.type })} />
          {video.tracks.map(t => (
            <MenuItem key={t.id} label={t.name}
              title={`Sample「${t.name}」's current frame as this ${sub.label.toLowerCase()}'s picture while a Layer track is composited — the same binding Frame source shows later.`}
              onClick={() => send('attr-add', { layerId: row.id, type: sub.type, trackId: t.id })} />
          ))}
        </MenuCard>
      );
    }
    if (!ui.attrKinds.length) return null;
    return (
      <MenuCard menu={menu}>
        {ui.attrKinds.map(k => {
          const bind = canBind && k.kind === 'surface';
          return (
            <MenuItem key={k.type} label={'Add ' + k.label} title={k.addTitle}
              keepOpen={bind}
              onClick={() => bind
                ? setRowUi({ menu: { ...menu, sub: k.type } })
                : send('attr-add', { layerId: row.id, type: k.type })} />
          );
        })}
      </MenuCard>
    );
  }
  const m = row.menu;
  const native = `${row.native.w} × ${row.native.h}`;
  const takesBox = row.kind !== 'raster' && row.kind !== 'text' && row.kind !== 'direction';
  const rasterTitle = `Bake「${row.name}」into the canvas — one image pixel per canvas pixel from here on. `
    + 'Transforms will resample the pixels. One-way.'
    + (row.kind === 'cud' ? " This row's link is dropped on the way in: a baked buffer has nothing for a refresh to repaint." : '')
    + (row.kind === 'text' ? ' The text descriptor is destroyed — you cannot type into this layer again.' : '')
    + (row.kind === 'direction' ? ' The three angles are destroyed — this row becomes a plain picture and the Direction window stops editing it.' : '');
  return (
    <MenuCard menu={menu}>
      <MenuItem label="Generate" disabled={!row.canGen}
        title={!row.canGen ? `「${row.name}」is the Mask layer itself — not a Generate target`
          : m.genHasImg ? `Refine「${row.name}」from its own image and mask (nothing painted = the whole layer)`
            : `Generate into「${row.name}」from noise — the whole layer (${native})`}
        onClick={() => send('layer-generate', { id: row.id })} />
      {row.kind === 'text' && (
        <MenuItem label={m.hasText ? 'Edit text' : 'Type text'}
          title={`Edit「${row.name}」's text in place on the canvas — Enter commits, Shift+Enter adds a line, Esc cancels. (Same as double-clicking the layer or pressing Enter with it selected.)`}
          onClick={() => send('layer-text-edit', { id: row.id })} />
      )}
      {takesBox && (
        <>
          <MenuItem label="Expand"
            title={`Change「${row.name}」's own resolution (${native}) — drag its border to a new box; the image stays 1:1 and the new space is transparent. Esc cancels.`}
            onClick={() => send('layer-expand', { id: row.id })} />
          <MenuItem label="Fit Mask" disabled={!m.hasBuffer}
            title={`Shrink「${row.name}」's own picture (${native}) to the smallest box holding what its mask leaves visible — the image stays 1:1 and exactly where it is, and every face on its strip comes along cropped`}
            onClick={() => send('layer-fit-mask', { id: row.id })} />
          <MenuItem label="Split By Mask" disabled={!m.hasBuffer}
            title={`Cut「${row.name}」's final ink — its own picture with every step on its strip folded over — into its connected pieces, one layer per piece (part1 is the biggest). The original stays on the list but hidden.`}
            onClick={() => send('layer-split-mask', { id: row.id })} />
        </>
      )}
      {row.kind !== 'raster' && (
        <MenuItem label="Rasterize" disabled={!m.canvasReady || !m.hasBuffer} title={rasterTitle}
          onClick={() => send('layer-rasterize', { id: row.id })} />
      )}
      <MenuItem label="Duplicate"
        title={`Copy「${row.name}」— picture, mask, decal and effect steps all come along, on a new layer right above it. Its steps are new ones, so editing the copy never writes on the original.`}
        onClick={() => send('layer-duplicate', { id: row.id })} />
      {m.groupSize >= 2 && (
        <MenuItem label="Combine"
          title={`Merge these ${m.groupSize} layers into one picture — each row's CURRENT look (mask, decal, chain and placement folded in) is stacked bottom-to-top into a single raster layer sitting where the topmost one did; the selected rows leave the list, the rest of the stack is untouched. One-way, like Rasterize. Hidden rows are skipped. Text / direction / Stash rows must be Rasterized first.`}
          onClick={() => send('layer-combine')} />
      )}
      {row.kind === 'cud' && (
        <>
          <MenuItem label="Refresh from file" disabled={!m.cudDocOpen}
            title={m.cudDocOpen
              ? `Re-read ${row.cudName} from disk and repaint this row — the transform, mask and decal you set here stay.`
              : 'Not linked any more — Relink the row first, then this reads the file you point at.'}
            onClick={() => send('cud-refresh', { id: row.id })} />
          <MenuItem label="Relink…"
            title={`Point「${row.name}」at a .cud file — the row keeps its placement and paint, and takes that project's flattened picture.`}
            onClick={() => send('cud-relink', { id: row.id })} />
        </>
      )}
    </MenuCard>
  );
};

/** Apply 那一句按种类说清"折进去的是什么"。措辞原来是页面 applyAttrTitle 一个人写的，
 *  它退休以后这里就是唯一一份 —— 判据（chain / mask / decal）读的是快照里那枚 chip 的 `type`。 */
const applyTitle = (row: BlendLayerRow, chip: BlendAttrChip): string => {
  const name = `「${row.name}」`;
  if (chip.kind === 'chain') {
    const lane = laneOf(row, chip.guid);
    const armed = lane ? lane.steps.filter(s => s.enabled).length : 0;
    return `Bake${name}'s ${armed} effect${armed === 1 ? '' : 's'} into its own pixels at its own resolution — `
      + 'the placement and everything to the right of this step stay exactly as they are, and this step is gone after. One-way'
      + (row.kind === 'cud' ? '; a later Refresh from file repaints these pixels from the linked file' : '') + '.';
  }
  if (chip.type === 'mask') {
    return `Bake this mask into${name}'s own pixels: what it hides becomes real transparency, then the step is gone. `
      + 'One-way — the surface cannot tell you afterwards what it hid.';
  }
  return `Fold this decal's colour into${name}'s own pixels: what was painted on top becomes the image, then the step is gone. `
    + 'One-way — the decal cannot be repainted or moved afterwards.';
};

// ---- 一摞行 ----
const EMPTY_TEXT: Record<BlendStack, string> = {
  guidance: 'No guidance yet — Add one, or drag a layer row here',
  layer: 'No layers yet — click Add',
};

export const LayerListView = ({ stack, rows, send, video }:
  { stack: BlendStack; rows: BlendLayerRow[]; send: BlendUiSend; video: WorkbenchHostCtx['video'] }) => {
  const st = useRowUi();
  useHoverKeys();
  const listKey = 'list:' + stack;
  const over = st.over && st.over.key === listKey;
  useFaceChannel(send);
  return (
    <div className={'layer-list' + (over ? ' drop-target' : '')}
      onDragOver={ev => {
        // 工作区条目 = 智能图层落点（画布之外的第二落点，guidance 栈同理）。
        if (hasType(ev.dataTransfer, STAGING_ITEM_TYPE)) {
          ev.preventDefault(); ev.stopPropagation(); ev.dataTransfer.dropEffect = 'copy';
          setRowUi({ over: { key: listKey } });
          return;
        }
        // 外部文件：页面那一侧这条落点原本是有的（routeImportFiles(files, stack)），但它要的是 File 本体，
        // 而这条边界如今只走坐标 —— 拍板 4 改前提之后，dock 与页面之间的往返就只留 stage-layer /
        // layer-from-staging 两句。这里先只把事件吃掉（不亮起、也不让浏览器改页面去开文件），
        // 画布上的那一处落点一个字没动。已作为一条编号缺口报上去。
        if (hasFiles(ev.dataTransfer)) { ev.preventDefault(); ev.stopPropagation(); ev.dataTransfer.dropEffect = 'none'; return; }
        if (rowDragId === null) return;               // 别处的拖拽原样放行
        ev.preventDefault(); ev.stopPropagation(); ev.dataTransfer.dropEffect = 'move';
        setRowUi({ over: { key: listKey } });
      }}
      onDragLeave={() => { if (st.over?.key === listKey) setRowUi({ over: null }); }}
      onDrop={ev => {
        setRowUi({ over: null });
        if (hasType(ev.dataTransfer, STAGING_ITEM_TYPE)) {
          ev.preventDefault(); ev.stopPropagation();
          let sid = '';
          try { sid = ev.dataTransfer.getData(STAGING_ITEM_TYPE); } catch { sid = ''; }
          send('layer-from-staging', { id: sid, stack });
          return;
        }
        if (hasFiles(ev.dataTransfer)) { ev.preventDefault(); ev.stopPropagation(); return; }
        if (rowDragId === null) return;
        ev.preventDefault(); ev.stopPropagation();
        const id = rowDragId; rowDragId = null;
        // 落在列表自己身上（最后一行以下、或那句空态上）= 去这一摞的最底下，与页面 wireStackListDrop 同一句。
        send('layer-move', { id, toId: null, above: false, stack });
      }}>
      {!rows.length && <div className="layer-empty">{EMPTY_TEXT[stack]}</div>}
      {rows.map(row => <LayerRow key={row.id} row={row} send={send} video={video} />)}
      <HoverPreview stack={stack} />
    </div>
  );
};

// ---- 两格头部 ----
export type AddEntry = { kind: 'default' | 'stash' | 'dynamic' | 'cud'; title: string; label: string; sub: string };

export const StackHead = ({ stack, entries, withBypass, send }:
  { stack: BlendStack; entries: AddEntry[]; withBypass?: boolean; send: BlendUiSend }) => {
  const ui = useBlendUi();
  const st = useRowUi();
  const groupRef = useRef<HTMLDivElement | null>(null);
  // 视频模式下没有选中 Layer 段时，这两格不知道该往哪写 —— 动作条整排变灰（Guidances 同一条闸）。
  const blocked = useLayerEditBlocked();
  const off = blocked ? { opacity: 0.35, cursor: 'default' as const } : null;
  const mine = st.menu && st.menu.kind === 'add' && st.menu.stack === stack ? st.menu : null;
  return (
    <div ref={groupRef} className="mini-group" title={blocked ? 'Move the playhead onto a Layer segment in the Tracks window first — layers and guidances are written into that segment' : undefined}>
      {withBypass && (
        // 那颗「看加特效前的原样」总开关。画法不能在这里抄第二根魔棒 —— 快照里那句 fx.wand 就是
        // 页面 fxWandSvg() 的原串，条带上那枚链 chip 认的是同一个作者。
        <button type="button" disabled={blocked} style={off ?? undefined}
          className={'mini-btn ico-btn' + (ui.fx.bypass ? ' fx-bypassed' : '')}
          title={ui.fx.bypass
            ? 'Resume every layer effect chain (currently suspended)'
            : 'Suspend every layer effect chain — the chains stay on their layers, nothing is deleted'}
          onClick={() => send('fx-bypass')}>
          <span className="attr-visual" dangerouslySetInnerHTML={{ __html: ui.fx.wand }} />
        </button>
      )}
      <button type="button" className="mini-btn" disabled={blocked} style={off ?? undefined}
        title={blocked
          ? 'Move the playhead onto a Layer segment in the Tracks window first'
          : (stack === 'guidance' ? 'Remove every guidance layer' : 'Remove every layer (guidances stay)')}
        onClick={() => send('layer-clear', { stack })}>Clear All</button>
      <button type="button" className="mini-btn" disabled={blocked} style={off ?? undefined}
        aria-haspopup="menu" aria-expanded={!!mine}
        title={blocked ? 'Move the playhead onto a Layer segment in the Tracks window first' : stack === 'guidance'
          ? 'Add a guidance: composited over the layers image, and what the workspace Guidance card publishes'
          : 'Add a layer: one the size of the canvas, or one you draw out at any resolution'}
        onClick={() => {
          // 与页面那两句同一个分流：这一格开着就收掉，否则换过来。垫层那一下也算收掉，所以点按钮
          // 那一下不会像页面那样"关掉又立刻开回来"。
          if (mine) { closeMenu(); return; }
          const r = groupRef.current?.getBoundingClientRect();
          if (!r) return;
          // 页面那一条 `.add-menu` 挂在 .mini-group 的右下角往上翻；这里换成固定坐标，同一个方向、
          // 同一个右缘，卡片本身一条规矩没改。
          setRowUi({ menu: { stack, kind: 'add', rowId: 0, attrId: '', x: r.right - 216, y: r.bottom, up: true } });
        }}>Add<span className="add-caret">▾</span></button>
      {mine && (
        <MenuCard menu={mine}>
          {entries.map(e => (
            <IOItem key={e.kind} title={e.title} label={e.label} sub={e.sub}
              onClick={() => send('layer-add', { stack, kind: e.kind })} />
          ))}
          {stack === 'layer' && (
            <IOItem checkable checked={ui.rasterDrop}
              title={'When on, images added from here on — dropped files, Import picks and history injections — '
                + 'become raster layers: their buffer is the canvas, 1:1, and every transform resamples the pixels in place. '
                + 'One-way; rasterize a smart layer from its right-click menu instead.'}
              label="Place images as raster"
              sub={ui.rasterDrop
                ? 'On — new image layers use the canvas grid (raster).'
                : 'Off — new image layers keep their original pixels (smart objects).'}
              onClick={() => send('raster-drop')} />
          )}
        </MenuCard>
      )}
    </div>
  );
};
