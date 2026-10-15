import React from 'react';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';

// Bucket 那一格：一根 Tolerance 加两颗开关。落点（decal 还是 mask）不是这一格能改的，
// 它跟着 Mask / Decal 那一支走，所以这里只读不写。
const Check: React.FC<{ label: string; title: string; on: boolean; toggle: (v: boolean) => void }> =
  ({ label, title, on, toggle }) => (
    <div style={wbStyles.ctrl} title={title}>
      <label style={wbStyles.ctrlLabel}>{label}</label>
      <span style={{ flex: '1 1 0' }} />
      <input style={wbStyles.check} type="checkbox" checked={on}
        onChange={e => toggle(e.target.checked)} />
    </div>
  );

const BucketBody: React.FC<WorkbenchUnitProps> = ({ send }) => {
  const ui = useBlendUi();
  const armed = ui.mode === 'mask' && ui.paint.tool === 'bucket';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 4,
      ...(armed ? wbStyles.armed : null) }}>
      <div style={{ ...wbStyles.row, marginBottom: 4 }}>
        <span style={{ ...wbStyles.key, ...(armed ? wbStyles.keyOn : null) }} title="Press G to take this tool">G</span>
      </div>
      <div style={wbStyles.ctrl}>
        <label style={wbStyles.ctrlLabel}>Tolerance</label>
        <input style={wbStyles.slider} type="range" min={0} max={1} step={0.01} value={ui.tools.bucket.tolerance}
          title="How far a pixel may sit from the clicked colour and still be filled (0 = exact match, 1 = everything)"
          onChange={e => send('bucket-tolerance', parseFloat(e.target.value))} />
        <span style={wbStyles.value}>{ui.tools.bucket.tolerance.toFixed(2)}</span>
      </div>
      <Check label="Continuous" on={ui.tools.bucket.continuous} toggle={v => send('bucket-continuous', v)}
        title="Only fill pixels connected to the clicked point. Off fills every matching pixel on the layer, however far away." />
      <Check label="All Layers" on={ui.tools.bucket.allLayers} toggle={v => send('bucket-all-layers', v)}
        title={'Match against the layers composite (guidances are references, not pixels to pour into). '
          + "Off matches against this layer's own image + decal. The fill always lands on the surface "
          + 'the Mask / Decal switch picks.'} />
    </div>
  );
};

export const bucketUnit: WorkbenchUnit = {
  id: 'bucket',
  title: 'Bucket',
  hint: 'Bucket (G) — click flood-fills matching pixels with the Color onto the surface the Mask / Decal '
    + 'switch picks: a decal gets the colour (Alpha included), a mask gets the Color’s Alpha poured in as '
    + 'coverage. Alt+click picks the Color from the canvas, like the brush.',
  Body: BucketBody,
};
