// ── 卷帘上此刻拿的是哪一支 ──────────────────────────────────────────────────────────────────
//
// 卷帘把 Brush / Eraser 这两格工具**复用**过来（拍板 8）：B = 画笔（按下落音、拖出来是一条长音），
// E = 橡皮（按到哪枚音擦哪枚，拖着扫一片）。两支笔都是**黏住**的（用户点名）：选了一次就一直
// 拿着，直到换另一支或按 Esc 回到画笔 —— 与画布那边"点一下工具带就换过去"是同一份手感。
//
// 第三支是 Cursor（A）：手上什么都不拿，指针就是普通箭头 —— 它不落音、不擦音，只保留选中与
// 拖动音符（"我只想整理一下，不想画出东西"）。同样是黏住的，直到换另一支或 Esc。
// 键的判定在 midi/Workspace.tsx（卷帘根元素报 hover，宿主按"指针在哪一面"路由，见 cutStore）。
//
// 状态住在页面级而不是某一份工程里：它是一支笔，不是文档内容 —— 切 tab / 换段都不该把笔换掉。
// 与 Cut 的武装（workbench/cutStore.ts）分开：Cut 是手势、笔是工具；拿笔时 Cut 收起来。

import { useSyncExternalStore } from 'react';
import { precisionCursor } from '../workbench/cursors';

export type MidiTool = 'brush' | 'eraser' | 'cursor';

let tool: MidiTool = 'brush';
const listeners = new Set<() => void>();

export const getMidiTool = (): MidiTool => tool;

export const setMidiTool = (next: MidiTool): void => {
  if (tool === next) return;
  tool = next;
  for (const fn of [...listeners]) fn();
};

export const subscribeMidiTool = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export const useMidiTool = (): MidiTool => useSyncExternalStore(subscribeMidiTool, getMidiTool);

// 两支笔的光标：准星 + 右下角的工具徽章（同一套画法见 workbench/cursors.ts）。记号与 dock 按钮
// 上那两枚图标同源 —— 光标承诺的就是那一格按钮说的事。
export const BRUSH_CURSOR = precisionCursor(
  "<path d='M2.6 13.4c.3-1.9.9-2.6 2.1-3.1'/>"
  + "<path d='M6.4 9.6 12.6 3.4a1.5 1.5 0 0 0-2.1-2.1L4.3 7.5'/>"
  + "<path d='M6.4 9.6 4.3 7.5'/>",
);
export const ERASER_CURSOR = precisionCursor(
  "<path d='M6.2 13.2h7'/>"
  + "<path d='M9.1 2.4 3.3 8.2a1.4 1.4 0 0 0 0 2l1.3 1.3a1.4 1.4 0 0 0 2 0L12.4 6z'/>"
  + "<path d='M6.3 5.2l4.5 4.5'/>",
);
