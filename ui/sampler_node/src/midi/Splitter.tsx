// ── 可拖的分隔条 ────────────────────────────────────────────────────────────────────────────
//
// MIDI 界面的每一处"比例"都走这一枚：左栏（乐器）↔ 卷帘（左右拖）、卷帘 ↔ 力度泳道（上下拖）。
// 三个细节是它能被摸到的原因，别省：
//
//   1. **条本身有 7px**：1px 的线在 1600px 宽的窗里根本点不中（用户第一次就没摸到）。
//   2. **pointer capture**：按下后手指/鼠标移出这条窄带，事件仍然回到这里，否则拖到一半就断。
//   3. **hover 才上色**：静息时只有一根 10% 白线（不抢视觉），指上去整条变蓝并给出 cursor。
//
// 双击回默认 —— 拖歪了不用手调回去。

import React, { useCallback, useRef, useState } from 'react';

export const Splitter: React.FC<{
  /** 'x' = 左右拖（条是竖的）；'y' = 上下拖（条是横的）。 */
  axis: 'x' | 'y';
  /** 按下时先给一次起点 —— 调用方在这里存"当前宽度"，后面的 onDrag 只给增量。 */
  onStart?: (clientPos: number) => void;
  /** 拖动中持续回报：光标在视口里的 x 或 y，以及按下时的那个位置。 */
  onDrag: (clientPos: number, startPos: number) => void;
  /** 松手一次 —— 落盘用（拖动中别写 localStorage，一帧一次是真的会卡）。 */
  onEnd?: () => void;
  /** 双击恢复默认比例。 */
  onReset?: () => void;
  title?: string;
}> = ({ axis, onStart, onDrag, onEnd, onReset, title }) => {
  const [hot, setHot] = useState(false);
  const active = useRef(false);
  const start = useRef(0);
  const vertical = axis === 'x';

  const down = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    active.current = true;
    start.current = vertical ? e.clientX : e.clientY;
    setHot(true);
    onStart?.(start.current);
    // 合成事件（探针 / 自动化）里 pointerId 可能没有活跃指针，捕获会抛 NotFoundError；
    // 拖还是能拖（事件本就在这个元素上），所以别让它中断后面的拖动。
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* 无活跃指针 */ }
  }, [onStart, vertical]);

  const move = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!active.current) return;
    e.preventDefault();
    // 给的是**增量**（当前位置 - 按下位置），不是绝对坐标：7px 的条按下去可能抓在左边缘
    // 也可能抓在右边缘，用绝对坐标算的话一松手就跳那 3px（实测过，用户能看出来）。
    onDrag(vertical ? e.clientX : e.clientY, start.current);
  }, [onDrag, vertical]);

  const up = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!active.current) return;
    active.current = false;
    setHot(false);
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* 已经松了 */ }
    onEnd?.();
  }, [onEnd]);

  return (
    <div
      title={title} role="separator" aria-orientation={vertical ? 'vertical' : 'horizontal'}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onPointerEnter={() => setHot(true)}
      onPointerLeave={() => { if (!active.current) setHot(false); }}
      onDoubleClick={onReset}
      style={{
        flexShrink: 0, position: 'relative', zIndex: 5, touchAction: 'none',
        width: vertical ? 7 : '100%', height: vertical ? '100%' : 7,
        cursor: vertical ? 'col-resize' : 'row-resize',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: hot ? 'rgba(10,132,255,0.16)' : 'transparent',
      }}
    >
      <div style={{
        pointerEvents: 'none',
        width: vertical ? 1 : '100%', height: vertical ? '100%' : 1,
        background: hot ? 'rgba(10,132,255,0.9)' : 'rgba(255,255,255,0.08)',
        boxShadow: hot ? '0 0 6px rgba(10,132,255,0.55)' : 'none',
      }} />
      {/* 把手：静息时那根 8% 的线几乎看不见，用户不知道这儿能拖 —— 中点给一枚小胶囊，
          鼠标还没到就已经在说"抓我"。它是整个可拖性里最便宜也最有效的一笔。 */}
      <div style={{
        position: 'absolute', pointerEvents: 'none', borderRadius: 2,
        width: vertical ? 4 : 36, height: vertical ? 36 : 4,
        background: hot ? '#0a84ff' : 'rgba(255,255,255,0.32)',
      }} />
    </div>
  );
};
