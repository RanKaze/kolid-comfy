import React from 'react';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';

const CanvasBody: React.FC<WorkbenchUnitProps> = ({ send }) => {
  const ui = useBlendUi();
  const sized = !!(ui.canvas.w && ui.canvas.h);
  return (
    <div style={wbStyles.row}>
      <button style={wbStyles.btn}
        title={'Set a fixed canvas resolution. Until you set one the canvas follows the bottom layer; '
          + 'image files can also be dropped onto the canvas to become layers.'}
        onClick={() => send('canvas-size')}>
        {sized ? `${ui.canvas.w} × ${ui.canvas.h}` : 'Canvas Size…'}
      </button>
      <button style={{ ...wbStyles.btn, ...(ui.mode === 'canvasModify' ? wbStyles.btnOn : null), ...(sized ? null : wbStyles.btnOff) }}
        disabled={!sized}
        title={'Modify — drag the canvas border to resize it. Smart layers keep their pixels '
          + '(top-left anchored); raster layers resample to the new canvas. Enter applies, Esc cancels.'}
        onClick={() => send('canvas-modify')}>Modify</button>
    </div>
  );
};

export const canvasUnit: WorkbenchUnit = {
  // 这扇窗与 Video 模式**无关**：两种模式下都是画布设置本体（播放器住文档窗里，见 EditPhase）。
  id: 'canvas',
  title: 'Canvas',
  hint: 'The canvas keeps its resolution while layers come and go. Until you set one by hand it grows '
    + 'to fit the largest layer at its native resolution, so placed images are never resampled.',
  Body: CanvasBody,
};
