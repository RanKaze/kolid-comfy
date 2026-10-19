import React from 'react';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';

const pill = (on: boolean): React.CSSProperties => ({ ...wbStyles.btn, ...(on ? wbStyles.btnOn : null) });

// 字符箭头（⟲ ⟳）不进门：这两颗是描边 SVG，和 dock 那套把手同一个画法，只是小了半号。
const ArcIcon: React.FC<{ ccw?: boolean }> = ({ ccw }) => (
  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"
    strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', transform: ccw ? 'scaleX(-1)' : undefined }}>
    <path d="M11.6 5.2A4.6 4.6 0 1 0 7 11.8" />
    <path d="M12.4 2.2v3h-3" />
  </svg>
);

const ViewBody: React.FC<WorkbenchUnitProps> = ({ send }) => {
  const ui = useBlendUi();
  return (
    <>
      <div style={wbStyles.row}>
        <button style={pill(ui.mode === 'pan')}
          title="Hand (H) — drag with the left button to pan the view. Space or middle-drag pans too."
          onClick={() => send('view-pan')}><span style={wbStyles.key}>H</span></button>
        <button style={pill(ui.mode === 'zoom')}
          title={'Zoom (Z) — left click zooms in, right click zooms out; drag right/left to zoom '
            + 'continuously around the point you press.'}
          onClick={() => send('view-zoom')}><span style={wbStyles.key}>Z</span></button>
        <button style={pill(ui.mode === 'rotate')}
          title={'Rotate (R) — turn the view like a knob: it follows how you swing the pointer around '
            + 'the view centre. Shift snaps to 15°, a plain click steps 15°.'}
          onClick={() => send('view-rotate')}><span style={wbStyles.key}>R</span></button>
        <button style={wbStyles.btn} title="Fit the canvas into the view" onClick={() => send('view-fit')}>Fit</button>
        <button style={wbStyles.btn} title="Reset zoom, rotation, flip and pan" onClick={() => send('view-reset')}>Reset</button>
      </div>
      <div style={{ ...wbStyles.row, gap: 4 }}>
        <button style={{ ...wbStyles.btn, flex: 1, justifyContent: 'center' }} title="Zoom out"
          onClick={() => send('view-zoom-out')}>−</button>
        <button style={{ ...wbStyles.btn, flex: 1, justifyContent: 'center' }} title="Zoom in"
          onClick={() => send('view-zoom-in')}>+</button>
        <button style={{ ...wbStyles.btn, flex: 1, justifyContent: 'center' }} title="Rotate view counter-clockwise"
          onClick={() => send('view-rot-ccw')}><ArcIcon ccw /></button>
        <button style={{ ...wbStyles.btn, flex: 1, justifyContent: 'center' }} title="Rotate view clockwise"
          onClick={() => send('view-rot-cw')}><ArcIcon /></button>
        <button style={{ ...wbStyles.btn, flex: 1.4, justifyContent: 'center' }} title="Flip view horizontally"
          onClick={() => send('view-flip')}>Flip H</button>
      </div>
      {ui.view.readout ? <div style={wbStyles.readout}>{ui.view.readout}</div> : null}
    </>
  );
};

export const viewUnit: WorkbenchUnit = {
  id: 'view',
  title: 'View',
  hint: 'H hand (left-drag to pan the view), Z zoom (left click in, right click out, drag right/left for '
    + 'continuous zoom around the point you press), R rotate (turn the view like a knob around the view '
    + 'centre; Shift snaps to 15°, a click steps 15°). Ctrl+F flips horizontally, the wheel zooms, Space '
    + 'or middle-drag pans, Fit fits the canvas into the workbench (rotation kept), Enter or Esc exits '
    + 'the active tool. Esc also returns to the default view — straight, unflipped and filled to the '
    + 'workbench — and the Reset button does the same.',
  Body: ViewBody,
};
