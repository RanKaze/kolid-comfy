import React from 'react';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';
import type { BlendUiAction, BlendUiSend } from '../types';

// Brush 那一格：三颗档位 + 它此刻有可见差别的那几根旋钮。正文从快照读，按下发的是动作键 ——
// 这一格不认识图层，也不认识画布，它只知道页面那一侧 `brushMode` 那一族变量现在是什么。
// Eraser 用的是同一条算术（同一套档位、同一套行），所以正文在这里，那一格只交自己那句话说的是
// "erases" —— 两格各有各的注册数据，没有第二份近似实现。

const MODES: { mode: string; label: string; title: string }[] = [
  { mode: 'binary', label: 'Binary', title: 'Hard edge: full strength inside the outline, nothing outside' },
  { mode: 'linear', label: 'Linear', title: 'Linear falloff from Center to Edge' },
  { mode: 'exponential', label: 'Exponential', title: 'Exponential falloff shaped by Center, Edge and Gamma' },
];

type PenKey = 'mode' | 'size' | 'strength' | 'center' | 'edge' | 'gamma';
// 动作键是 `${格}-${旋钮}` 拼出来的，拼完仍要落回 BlendUiAction 那串字面量里 —— 页面那张
// UI_COMMANDS 表有没有这一条，由门禁逐键对表，不靠这里宽容。
const penAction = (which: 'brush' | 'eraser', key: PenKey): BlendUiAction =>
  `${which}-${key}` as BlendUiAction;

/** 一档该露哪几根旋钮：Binary 只有 Strength，Linear 有 Center/Edge，Exponential 有 Gamma。
 *  页面曾经用一整表 style.display 来藏行，那张表跟着它的面板一起没了 —— 差别只在于现在没人
 *  渲染那一行，而不是有一行被藏起来。 */
const penRows = (mode: string): ('strength' | 'center' | 'edge' | 'gamma')[] =>
  mode === 'linear' ? ['strength', 'center', 'edge']
    : mode === 'exponential' ? ['strength', 'gamma']
      : ['strength'];

const ROW_TITLES: Record<string, string> = {
  strength: 'Opacity of a single pass (0 = nothing, 1 = full)',
  center: 'Inner share of the radius that stays at full strength (Linear / Exponential)',
  edge: 'How soft the outer fade is (Linear / Exponential)',
  gamma: 'Falloff curve (Exponential): above 1 pushes the fade outward, below 1 pulls it in',
};

export const PenBody: React.FC<{
  send: BlendUiSend;
  which: 'brush' | 'eraser';
  sentence: (target: string, selection: boolean) => string;
}> = ({ send, which, sentence }) => {
  const ui = useBlendUi();
  const pen = ui.tools[which];
  const target = ui.paint.decal ? 'the decal' : 'the mask';
  // 色环那一枚原来挂在这行小节标题旁边，如今是本格的第一行：环上写的是这一笔落在哪一面。
  // 橡皮那枚在页面里从来没被染过色（它是虚线红环），所以只有 Brush 读 paint.ring。
  const ring = which === 'brush'
    ? { ...wbStyles.ring, borderColor: ui.paint.ring || 'rgba(255,255,255,0.92)' }
    : wbStyles.ringErase;
  const armed = ui.mode === 'mask' && ui.paint.tool === which;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 4,
      ...(armed ? wbStyles.armed : null) }}>
      <div style={{ ...wbStyles.row, marginBottom: 4 }}>
        <span style={{ ...wbStyles.key, ...(armed ? wbStyles.keyOn : null) }}
          title={`Press ${which === 'brush' ? 'B' : 'E'} to take this tool`}>
          {which === 'brush' ? 'B' : 'E'}
        </span>
        {MODES.map(m => (
          <button key={m.mode} style={{ ...wbStyles.btn, ...(pen.mode === m.mode ? wbStyles.btnOn : null) }}
            title={m.title} onClick={() => send(penAction(which, 'mode'), m.mode)}>{m.label}</button>
        ))}
        <span style={{ ...ring, marginLeft: 'auto' }} title={sentence(target, ui.paint.selection)} />
      </div>
      {penRows(pen.mode).map(key => (
        <div key={key} style={wbStyles.ctrl}>
          <label style={wbStyles.ctrlLabel}>{key[0].toUpperCase() + key.slice(1)}</label>
          <input style={wbStyles.slider} type="range" min={key === 'gamma' ? 0.1 : 0}
            max={key === 'gamma' ? 10 : 1} step={key === 'gamma' ? 0.1 : 0.01} value={pen[key]}
            title={ROW_TITLES[key]}
            onChange={e => send(penAction(which, key), parseFloat(e.target.value))} />
          <span style={wbStyles.value}>{pen[key].toFixed(2)}</span>
        </div>
      ))}
      <div style={wbStyles.ctrl}>
        <label style={wbStyles.ctrlLabel}>Size</label>
        <input style={wbStyles.slider} type="range" min={2} max={9999} value={pen.size}
          title={`${which === 'brush' ? 'Brush' : 'Eraser'} size in layer pixels — the wheel or Alt + right-drag also changes it`}
          onChange={e => send(penAction(which, 'size'), parseInt(e.target.value, 10))} />
        <span style={wbStyles.value}>{pen.size}</span>
      </div>
    </div>
  );
};

const BrushBody: React.FC<WorkbenchUnitProps> = ({ send }) => (
  <PenBody which="brush" send={send} sentence={(target, selection) =>
    `Brush (B) — left-drag paints ${target}; the right button does nothing. Wheel resizes it, `
    + 'Alt + right-drag scrubs the size, Alt + left-drag picks a colour off the canvas (applied on release), '
    + 'Shift snaps a drag to a straight horizontal/vertical line as seen in the view, and Shift+click draws '
    + 'a straight segment from the last point to where you click.'
    + (selection ? ' A selection is live: it clips this tool, so nothing lands outside the ants.' : '')} />
);

export const brushUnit: WorkbenchUnit = {
  id: 'brush',
  title: 'Brush',
  hint: 'Brush (B) — how the stroke falls off, how opaque one pass is, and how wide it is. '
    + 'The ring says which face the stroke lands on.',
  Body: BrushBody,
};
