import React from 'react';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';

const TransformBody: React.FC<WorkbenchUnitProps> = ({ send }) => {
  const ui = useBlendUi();
  return (
    <>
      <div style={wbStyles.row}>
        <button style={{ ...wbStyles.btn, ...(ui.mode === 'transform' ? wbStyles.btnOn : null) }}
          title={'Transform (T) — show the adjustment box: drag inside to move, handles to scale, '
            + 'the circle to rotate. Enter / Esc hides it, Shift snaps.'}
          onClick={() => send('transform-adjust')}><span style={wbStyles.key}>T</span></button>
        <button style={wbStyles.btn} title="Stretch this layer to cover the whole canvas"
          onClick={() => send('transform-fill')}>Fill</button>
      </div>
      {ui.transform.readout
        ? <div style={wbStyles.readout}
            title={"This layer's transform: centre X/Y, size and rotation as a share of the canvas"}>
            {ui.transform.readout}
          </div>
        : null}
    </>
  );
};

export const transformUnit: WorkbenchUnit = {
  id: 'transform',
  title: 'Transform',
  hint: 'T shows the box, Enter hides it. Drag inside to move, handles to scale, the circle to rotate; '
    + 'Shift snaps. With several layers held (Shift+click) the box is their union: scaling it scales '
    + 'the whole arrangement, and any rotated layer inside makes the scale uniform.',
  Body: TransformBody,
};
