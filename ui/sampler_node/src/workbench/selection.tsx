import React from 'react';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';

const pill = (on: boolean): React.CSSProperties => ({ ...wbStyles.btn, ...(on ? wbStyles.btnOn : null) });

const SelectionBody: React.FC<WorkbenchUnitProps> = ({ send }) => {
  const ui = useBlendUi();
  return (
    <div style={wbStyles.row}>
      <button style={pill(ui.mode === 'rect')}
        title={'Rectangular Marquee (M) — drag a rectangle, or click to clear the selection. Shift adds, '
          + 'Alt subtracts, Shift+Alt intersects. Painting is clipped to what is inside.'}
        onClick={() => send('select-rect')}><span style={wbStyles.key}>M</span></button>
      <button style={pill(ui.mode === 'lasso')}
        title={'Lasso (L) — hold and sweep a freehand outline; it closes where you release. '
          + 'A click clears the selection. Shift adds, Alt subtracts, Shift+Alt intersects. '
          + 'Painting is clipped to what is inside.'}
        onClick={() => send('select-lasso')}><span style={wbStyles.key}>L</span></button>
      <button style={wbStyles.btn} title="Select the whole canvas (Ctrl+A)"
        onClick={() => send('select-all')}>All</button>
      <button style={wbStyles.btn} title="Clear the selection (Ctrl+D)"
        onClick={() => send('select-none')}>None</button>
    </div>
  );
};

export const selectionUnit: WorkbenchUnit = {
  id: 'selection',
  title: 'Selection',
  hint: 'A canvas-level selection: it belongs to the document, not to a layer, so every mask, decal and '
    + 'the Mask layer are painted inside it and nothing lands outside. Drag with Marquee (M) for a '
    + 'rectangle or Lasso (L) to trace one by hand; Shift adds, Alt subtracts, Shift+Alt intersects. '
    + 'Enter or Esc leaves the tool, Ctrl+D clears.',
  Body: SelectionBody,
};
