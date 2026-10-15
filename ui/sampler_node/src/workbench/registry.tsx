import React from 'react';
import type { UnitId } from '../dock/model';
import type { BlendUiAction } from '../types';
import { brushUnit } from './brush';
import { bucketUnit } from './bucket';
import { canvasUnit } from './canvas';
import { colorUnit } from './color';
import { eraserUnit } from './eraser';
import { maskUnit } from './mask';
import { selectionUnit } from './selection';
import { transformUnit } from './transform';
import { viewUnit } from './view';

export type WorkbenchUnitProps = { send: (action: BlendUiAction, value?: number | boolean | string) => void };

/** 一格工作台面板 = 一行注册数据：它叫什么、标题条上那句说明、以及它的正文怎么画。 */
export type WorkbenchUnit = {
  id: UnitId;
  title: string;
  hint: string;
  Body: React.ComponentType<WorkbenchUnitProps>;
};

// 图层 / 工具 / 属性面板一块一个文件，这张表只负责点名和排序（序 = 工作台原来那一列的序：
// Canvas、Transform，然后 Mask，再 Color、Brush / Bucket / Eraser，Selection 与 View 原本就压在这列的最末）。
// 搬完一块就往后加一行，页面那一侧同时删掉它自己那一格。
export const WORKBENCH_UNITS: WorkbenchUnit[] = [
  canvasUnit, transformUnit, maskUnit, colorUnit, brushUnit, bucketUnit, eraserUnit, selectionUnit, viewUnit,
];

export const WORKBENCH_PANEL_IDS: UnitId[] = WORKBENCH_UNITS.map(u => u.id);
export const WORKBENCH_TITLES: Record<string, string> =
  WORKBENCH_UNITS.reduce((a, u) => ({ ...a, [u.id]: u.title }), {} as Record<string, string>);
export const WORKBENCH_HINTS: Record<string, string> =
  WORKBENCH_UNITS.reduce((a, u) => ({ ...a, [u.id]: u.hint }), {} as Record<string, string>);

// 宿主只管发指令，正文每格自己读快照自己画 —— 所以这里遍历注册表，不写第二份 switch。
export const workbenchBodies = (send: (action: BlendUiAction) => void): Record<UnitId, React.ReactNode> =>
  WORKBENCH_UNITS.reduce((a, u) => {
    const Body = u.Body;
    return { ...a, [u.id]: <Body send={send} /> };
  }, {} as Record<UnitId, React.ReactNode>);
