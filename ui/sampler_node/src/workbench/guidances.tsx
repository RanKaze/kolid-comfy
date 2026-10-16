import React from 'react';
import { useBlendUi } from './store';
import { LayerListView, StackHead, type AddEntry } from './layerRow';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';

// Guidances 这一格 = 页面 #guidanceDock 那颗头部按钮组 + #guidanceList 那一摞行。行本身与 Layers
// 用的是同一份代码（页面的 renderStackList 也是同一句），差别只有头部那三条目 —— 没有 Stash，也
// 没有那颗 raster 勾（两者都是图层那一摞的事），更没有总开关（8.a：fxBypass 归 Layers）。
// 位置照页面那一列的序：Guidances 压在 Layers 上面，两格都在工具列的最末。
const GUIDANCE_ENTRIES: AddEntry[] = [
  {
    kind: 'default', label: 'Default Guidance',
    title: 'A blank guidance covering the canvas, one image pixel per canvas pixel.',
    sub: 'Canvas sized and 1:1 with it — a transparent surface to paint on.',
  },
  {
    kind: 'dynamic', label: 'Dynamic Guidance',
    title: 'Drag a rectangle on the canvas, then choose its resolution in the dialog that follows.',
    sub: 'Drag a rectangle on the canvas, then pick its resolution.',
  },
  {
    kind: 'cud', label: 'Cud Project',
    title: 'Choose a .cud file: its flattened Layers stack becomes this one guidance, and it repaints every time that file is saved. '
      + 'Stored in this file too, so it survives a lost link.',
    sub: 'Another .cud as one linked guidance that follows its file.',
  },
];

const GuidancesBody: React.FC<WorkbenchUnitProps> = ({ send }) => {
  const ui = useBlendUi();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 4 }}>
      <StackHead stack="guidance" entries={GUIDANCE_ENTRIES} send={send} />
      <LayerListView stack="guidance" rows={ui.stacks.guidances} send={send} />
    </div>
  );
};

export const guidancesUnit: WorkbenchUnit = {
  id: 'guidances',
  title: 'Guidances',
  hint: 'Guidance rows: composited over the layers image, and what the workspace Guidance card publishes. '
    + 'The same strip, chains and menus as Layers — drag a row between the two stacks to move it.',
  Body: GuidancesBody,
};
