import React from 'react';
import { MidiPenBody, PenBody } from './brush';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';

// Eraser 那一格。档位与旋钮的算术和 Brush 同一份（见 brush.tsx 的注释），这一只文件只带它自己的
// 注册数据和它那句"erases"。MIDI 模式下它和 Brush 一样只剩"这一支笔"那枚键。
const EraserBody: React.FC<WorkbenchUnitProps> = ({ send, host }) => (
  host.video.mode === 'midi' ? <MidiPenBody which="eraser" /> : <PenBody which="eraser" send={send} sentence={(target, selection) =>
    `Eraser (E) — left-drag erases ${target}; the right button does nothing. Wheel resizes it, `
    + 'Alt + right-drag scrubs the size, Shift snaps a drag to a straight horizontal/vertical line '
    + 'as seen in the view, and Shift+click erases a straight segment from the last point to where you click.'
    + (selection ? ' A selection is live: it clips this tool, so nothing lands outside the ants.' : '')} />
);

export const eraserUnit: WorkbenchUnit = {
  id: 'eraser',
  title: 'Eraser',
  hint: 'Eraser (E) — how the erase falls off, how much one pass uncovers, and how wide it is. '
    + 'The dashed ring is this tool; the red cursor is the same thing on the canvas. In MIDI it '
    + 'rubs notes out instead.',
  Body: EraserBody,
};
