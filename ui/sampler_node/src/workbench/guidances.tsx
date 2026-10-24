import React from 'react';
import { useBlendUi } from './store';
import { LayerListView, StackHead, type AddEntry } from './layerRow';
import { MaskRow } from './mask';
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

const GuidancesBody: React.FC<WorkbenchUnitProps> = ({ send, host }) => {
  const ui = useBlendUi();
  // Mask 不再是自己的窗口（用户拍板）：一整扇窗只装一行，剩下的全是空白，空间利用率太差。
  // 它现在是这一格里的**第一行**，钉在列表顶上（`MaskRow` 自己 sticky）—— 它不是 guidance 那一摞
  // 的一员（不参与拖拽/排序，也不进那个 stack），只是借这一格的位置站着。
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minHeight: 0 }}>
      <MaskRow send={send} host={host} />
      <LayerListView stack="guidance" rows={ui.stacks.guidances} send={send} video={host.video} />
    </div>
  );
};

// 与 Layers 同一排：Clear All / Add 住进 dock 的动作条（正文下面、滚动条之外）。
const GuidancesFoot: React.FC<WorkbenchUnitProps> = ({ send }) => (
  <StackHead stack="guidance" entries={GUIDANCE_ENTRIES} send={send} />
);

export const guidancesUnit: WorkbenchUnit = {
  id: 'guidances',
  title: 'Guidances',
  hint: 'Guidance rows: composited over the layers image, and what the workspace Guidance card publishes. '
    + 'The same strip, chains and menus as Layers — drag a row between the two stacks to move it. '
    + 'Clear All and Add stay pinned under the list.',
  Body: GuidancesBody,
  Foot: GuidancesFoot,
};
