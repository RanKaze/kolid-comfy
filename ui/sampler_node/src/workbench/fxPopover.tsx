import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { BlendAttrOpen, BlendFxOpenStep, BlendUiSend } from '../types';
import type { WorkbenchHostCtx } from './registry';
import { useBlendUi } from './store';
import { FxParamsPanel } from './fxParams';
import { useDockDocument, useDockWindow } from '../dock/docScope';

// 特效参数不再占一格 dock window：点开链里某一步，参数面就在那枚 chip **旁边**张开成一张小卡片，
// 再点一次（或点卡片外面 / Esc）收起。面（decal / mask）chip 用的是同一张卡片，里面只有 Frame source
// —— 那一行原来也是跟着 `attrOpen` 住在 Effect Parameters 那格里的，搬出来以后不能没有着落。
//
// 小窗只是**摆法**：控件、判据、回发的动作键仍旧是 fxParams.tsx / 页面注册表那同一套，这里不新增
// 第二条真相。位置量的是 chip 的实时矩形（fixed 摆到 portal 上），所以滚动、改窗口大小都跟着走。
// 只有一枚 chip 摊着（页面 `fxOpenId` 说的就是它），所以这里也只会开一张卡。

const GAP = 8;        // chip 与卡片之间的缝
const EDGE = 8;       // 卡片离窗口边缘至少留这么多
const MIN_VISIBLE = 2; // 量不到 chip 的矩形时（那一格还没排出来）先不亮

// ---- 面 chip 的小窗状态：住在这里，因为 chip（layerRow）与卡片两头都要读它 ----
type AttrPop = { layerId: number; attrId: string } | null;
let attrPop: AttrPop = null;
const attrSubs = new Set<() => void>();
const emitAttrPop = () => attrSubs.forEach(fn => fn());
const subscribeAttrPop = (fn: () => void) => { attrSubs.add(fn); return () => { attrSubs.delete(fn); }; };
const readAttrPop = () => attrPop;

/** 点一枚面 chip = 把这枚的小窗翻过来；再点同一枚 = 收起来。 */
export const toggleAttrPop = (layerId: number, attrId: string) => {
  attrPop = attrPop && attrPop.layerId === layerId && attrPop.attrId === attrId ? null : { layerId, attrId };
  emitAttrPop();
};
export const closeAttrPop = () => {
  if (!attrPop) return;
  attrPop = null;
  emitAttrPop();
};

const useAttrPop = (): AttrPop => useSyncExternalStore(subscribeAttrPop, readAttrPop, readAttrPop);

// 属性选择器里的字符串要能原样落进去（guid 目前都是安全字符，但不赌这件事）。
const attrSelector = (attrId: string) => `[data-attr="${attrId.replace(/["\\]/g, '\\$&')}"]`;

type CardProps = {
  list: React.RefObject<HTMLDivElement | null>;
  step: BlendFxOpenStep | null;
  attr: BlendAttrOpen | null;
  send: BlendUiSend;
  video: WorkbenchHostCtx['video'];
};

const FxPopCard = ({ list, step, attr, send, video }: CardProps) => {
  const doc = useDockDocument();
  const win = useDockWindow();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const sel = step ? `[data-fx="${step.stepId}"]` : attrSelector(attr?.attrId ?? '');
  const key = step ? `fx:${step.stepId}` : `attr:${attr?.layerId}:${attr?.attrId}`;

  const close = () => {
    if (step) send('fx-step-open', { layerId: step.layerId, attrId: step.attrId, stepId: step.stepId });
    else closeAttrPop();
  };

  // 量 chip 的矩形，把卡片摆在它右侧；右边放不下就翻到左侧，再不够就夹进窗口。纵向贴 chip 上沿，
  // 底部越界时往上收。量不到（那一格还没排出来 / 被折叠）就保持隐藏 —— 摆在窗口角上比摆错更难看。
  const place = () => {
    const box = boxRef.current;
    const anchor = list.current?.querySelector<HTMLElement>(sel);
    if (!box || !anchor) { setPos(null); return; }
    const r = anchor.getBoundingClientRect();
    if (r.width < MIN_VISIBLE && r.height < MIN_VISIBLE) { setPos(null); return; }
    const w = box.offsetWidth || 320;
    const h = box.offsetHeight || 240;
    let x = r.right + GAP;
    if (x + w > win.innerWidth - EDGE) x = r.left - w - GAP;
    x = Math.max(EDGE, Math.min(x, win.innerWidth - w - EDGE));
    let y = r.top;
    if (y + h > win.innerHeight - EDGE) y = win.innerHeight - h - EDGE;
    y = Math.max(EDGE, y);
    setPos(p => (p && Math.abs(p.x - x) < 0.5 && Math.abs(p.y - y) < 0.5 ? p : { x, y }));
  };

  // 每次提交后重量一次：卡片内容会改高（曲线 / 折叠组），chip 也会被拖着重排。
  useLayoutEffect(() => { place(); });

  // 滚动（含 dock 那块 scroller，事件不冒泡，所以用 capture）与窗口尺寸都让卡片跟着 chip 走。
  useEffect(() => {
    const fn = () => place();
    win.addEventListener('resize', fn);
    doc.addEventListener('scroll', fn, true);
    return () => {
      win.removeEventListener('resize', fn);
      doc.removeEventListener('scroll', fn, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // 点卡片外面 / 点另一枚 chip 都收起；点到 chip 自己留给它那一下 click 去 toggle（与页面同一个开关）。
  // 画布是 iframe（另一份 document），事件不会冒泡到这里 —— 同一源，所以顺手也挂到那份文档上：
  // 卡片压在画布边上，用户去画一笔就是"离开这张卡"，它该收起来，别挡着手。
  useEffect(() => {
    const down = (ev: Event) => {
      const t = ev.target as Node | null;
      if (!t) return;
      if (boxRef.current?.contains(t)) return;
      // chip 自己的点击就是开合开关（fx 步骤由页面 `fxOpenId` toggle，面 chip 由 toggleAttrPop）；
      // 勾选框 / 行尾 × 也住在这枚 chip 里，别让"点一下启用"顺手把参数窗关掉。
      const anchor = list.current?.querySelector<HTMLElement>(sel);
      if (anchor?.contains(t)) return;
      const chip = (t as HTMLElement).closest?.('.fx-chip, [data-attr]');
      if (chip && list.current?.contains(chip)) return;
      close();
    };
    const docs: Document[] = [doc];
    doc.querySelectorAll('iframe').forEach(f => {
      try { if (f.contentDocument) docs.push(f.contentDocument); } catch { /* cross-origin */ }
    });
    docs.forEach(d => d.addEventListener('pointerdown', down, true));
    return () => docs.forEach(d => d.removeEventListener('pointerdown', down, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Esc 与那一口菜单同一条口径：先收这一层，别的事情才轮到后面。
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();
      close();
    };
    win.addEventListener('keydown', onKey, true);
    return () => win.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const title = step ? step.label : (attr?.label || attr?.type || '');
  const readout = step?.readout || '';
  return createPortal(
    <div ref={boxRef} className="fx-pop" role="dialog" aria-label={title}
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, visibility: pos ? 'visible' : 'hidden' }}>
      <div className="fx-pop-head">
        <span className="fx-pop-title" title={step ? `This step draws: ${readout || 'no readout'}` : 'The surface the brush is painting right now'}>
          {title}
        </span>
        {readout && <span className="fx-pop-read" title={readout}>{readout}</span>}
        <button type="button" className="icon-btn" title="Close" onClick={close}>×</button>
      </div>
      <div className="fx-pop-body">
        <FxParamsPanel send={send} video={video} />
      </div>
    </div>,
    doc.body,
  );
};

/** 挂在 LayerListView 末尾：只有这一摞里真有的那一层才开卡片（Layers 与 Guidances 各挂一份）。 */
export const FxPopover = ({ list, rows, send, video }: {
  list: React.RefObject<HTMLDivElement | null>; rows: number[];
  send: BlendUiSend; video: WorkbenchHostCtx['video'];
}) => {
  const ui = useBlendUi();
  const pop = useAttrPop();
  const step = ui.fx.open && rows.includes(ui.fx.open.layerId) ? ui.fx.open : null;
  // Layers 与 Guidances 各挂一份 FxPopover；一枚层只归其中一摞。不归自己管的实例连"收"都不能收 ——
  // 否则另一摞会把刚翻开的面小窗当成"对不上"关掉。
  const owns = !!pop && rows.includes(pop.layerId);
  const attr = !step && owns && ui.attrOpen && pop!.layerId === ui.attrOpen.layerId
    && pop!.attrId === ui.attrOpen.attrId ? ui.attrOpen : null;

  // 选中层换掉 / 那枚面被摘掉以后，小窗不能还挂着一枚不存在的记录。但**刚点下去**这一帧要放过：
  // `attrOpen` 是页面下一趟快照才回来的，这里若当场判"对不上"就会把用户刚点开的小窗立刻关掉
  // （链步骤没有这一岔 —— `fx.open` 就是点开那一下的页面状态，面小窗得自己等一拍）。
  useEffect(() => {
    if (!pop || step || !owns) return;
    if (attr) return;
    if (ui.attrOpen) { closeAttrPop(); return; }   // 另一枚面带上了笔 → 这枚的窗让位
    const t = setTimeout(() => closeAttrPop(), 1500); // 等快照；一直没来就当它没点成
    return () => clearTimeout(t);
  }, [pop, step, owns, attr, ui.attrOpen]);

  if (!step && !attr) return null;
  return <FxPopCard key={step ? `fx:${step.stepId}` : `attr:${attr!.attrId}`}
    list={list} step={step} attr={attr} send={send} video={video} />;
};
