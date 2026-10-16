import React from 'react';
import { useBlendUi } from './store';
import { LayerListView, StackHead, type AddEntry } from './layerRow';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';

// Layers 这一格 = 页面 #layersDock 那颗头部按钮组 + #layerList 那一摞行（拍板 1.a：两格各自一格，
// 剩下的竖向高度由 dock 的分裂条带，`blend.stackSplit` 那个 localStorage 值随 8.a 一起作废）。
// 正文只有摆法和措辞；图层、条带记录、链、像素全在页面那一侧（行描述符与面通道见 types）。
//
// 头部那五条目照页面 HTML 的序与原文：Default / Stash / Dynamic / Cud Project，末尾一条是那颗
// 「往后的图是 raster 还是 smart object」的持久偏好勾。文字 / 方向 / 3D 不在这里 —— 它们是
// attribute，不是图层种类，入口在每一行条带末尾那颗 `+` 的菜单里（页面同一个说法）。
const LAYER_ENTRIES: AddEntry[] = [
  {
    kind: 'default', label: 'Default Layer',
    title: 'A blank layer covering the canvas, one image pixel per canvas pixel.',
    sub: 'Canvas sized and 1:1 with it — a transparent surface to paint on.',
  },
  {
    kind: 'stash', label: 'Stash Layer',
    title: 'A live merged copy of every layer under it, re-read on each draw: an effect on this row is an effect on the whole stack below. '
      + 'It has no pixels of its own until it samples, it follows the layers underneath as you edit them, and its grid is the canvas — '
      + 'so it cannot be moved, scaled or rotated.',
    sub: 'The layers under it, merged on every draw — effects here act on that stack.',
  },
  {
    kind: 'dynamic', label: 'Dynamic Layer',
    title: 'Drag a rectangle on the canvas, then choose its resolution in the dialog that follows.',
    sub: 'Drag a rectangle on the canvas, then pick its resolution.',
  },
  {
    kind: 'cud', label: 'Cud Project',
    title: 'Choose a .cud file: its flattened Layers stack becomes this one row\'s picture, and it repaints every time that file is saved. '
      + 'The composite is stored in this file too, so the row still draws — and still blends — if the link is ever lost.',
    sub: 'Another .cud as one linked layer that follows its file.',
  },
];

const LayersBody: React.FC<WorkbenchUnitProps> = ({ send }) => {
  const ui = useBlendUi();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 4 }}>
      <StackHead stack="layer" entries={LAYER_ENTRIES} withBypass send={send} />
      <LayerListView stack="layer" rows={ui.stacks.layers} send={send} />
    </div>
  );
};

export const layersUnit: WorkbenchUnit = {
  id: 'layers',
  title: 'Layers',
  hint: 'One row per layer, topmost first: its two faces, the attributes on its strip, the effect chains laid out above it. '
    + 'The head carries the total effect switch, Clear All and Add; the four ways to make a row are all there.',
  Body: LayersBody,
};
