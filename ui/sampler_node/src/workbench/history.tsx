import React, { useRef } from 'react';
import { useBlendUi } from './store';
import { useFaceChannel, useFaceVisible } from './layerRow';
import type { BlendHistoryStep, BlendUiSend } from '../types';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';

// History 这一格 = 页面那两支摞（undoStack / redoStack）摊成的**一列**。步子本身、跳到第几步的
// 算术、丢掉 redo 那一支的判据全在页面那一侧（UI_COMMANDS 的 history-* 四个动词就是它原来的四颗
// 按钮）；这一侧只有措辞与摆法 —— 与 Layers / Guidances 同一归属线（拍板 1.b）。
//
// 列子的序是页面拼好的：undo 那一支从下往上、redo 那一支倒着接在后面，所以一行在列里的**下标**
// 就是 `history-jump` 认的那个数（它自己也在两支之间数步子）。这里不再排第二遍序，否则同一个位置
// 就有了两套读法。
//
// 每一行那一张预览走的是**同一条面通道**：键由页面造（`hist:<id>`，这里一个字符都不拼），可见区
// 引用计数与 Layers / Guidances 共用同一份，所以 60 步不会一次编 60 张 —— 滚出视野的那些根本不发。

/** 弯回去 / 弯出去那两枚描边 SVG（`arrow.uturn.backward` / `.forward` 那道形状）。
 *  退休的 #undoBtn / #redoBtn 用的是字符实体，这里换成与兄弟格同一种画法。 */
const Undo = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.4 6.6 2.2 4.4l2.2-2.2" />
    <path d="M2.6 4.4h6.6a4 4 0 0 1 0 8H5.2" />
  </svg>
);
const Redo = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11.6 6.6l2.2-2.2-2.2-2.2" />
    <path d="M13.4 4.4H6.8a4 4 0 0 0 0 8h3.2" />
  </svg>
);

const HistRow = ({ step, send }: { step: BlendHistoryStep; send: BlendUiSend }) => {
  const ui = useBlendUi();
  const ref = useRef<HTMLDivElement | null>(null);
  useFaceVisible(ref, step.face);
  const url = step.face ? ui.faces[step.face] : '';
  return (
    <div ref={ref} className={'hist-row' + (step.current ? ' current' : '')}
      title={step.label + ' — click to jump the document back to this step'}
      onClick={() => send('history-jump', step.i)}>
      <span className="hist-thumb">
        {url && <img src={url} alt="" draggable={false} />}
      </span>
      <span className="hist-name">{step.label}</span>
    </div>
  );
};

// Undo / Redo / Clear 住进 dock 的动作条（正文下面、滚动条之外）——步子攒到 264px 也顶不走它们。
const HistoryFoot: React.FC<WorkbenchUnitProps> = ({ send }) => {
  const ui = useBlendUi();
  const h = ui.history;
  return (
    <div className="mini-group">
      <button type="button" className="mini-btn ico-btn" disabled={!h.canUndo}
        title="Undo (Ctrl+Z)" onClick={() => send('history-undo')}><Undo /></button>
      <button type="button" className="mini-btn ico-btn" disabled={!h.canRedo}
        title="Redo (Ctrl+Y or Ctrl+Shift+Z)" onClick={() => send('history-redo')}><Redo /></button>
      <button type="button" className="mini-btn" disabled={!h.steps.length}
        title={`Forget every step — the picture does not change, only this list (it holds the last ${h.limit})`}
        onClick={() => send('history-clear')}>Clear</button>
    </div>
  );
};

const HistoryBody: React.FC<WorkbenchUnitProps> = ({ send }) => {
  const ui = useBlendUi();
  useFaceChannel(send);
  const h = ui.history;
  return (
    <div className="hist-list dark-scroll">
      {!h.steps.length && <div className="layer-empty">No steps yet — they appear as you edit</div>}
      {h.steps.map(s => <HistRow key={s.i} step={s} send={send} />)}
    </div>
  );
};

export const historyUnit: WorkbenchUnit = {
  id: 'history',
  title: 'History',
  hint: 'Every step since this document opened, newest at the bottom: click one to jump back to it. '
    + 'Painting after a jump drops the steps you had skipped over — Undo, Redo and Clear stay pinned under the list.',
  Body: HistoryBody,
  Foot: HistoryFoot,
};
