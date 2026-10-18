import React from 'react';
import type { Dock, DockRules, UnitId } from '../dock/model';
import type { BlendUiSend, StagingItem } from '../types';
import { brushUnit } from './brush';
import { bucketUnit } from './bucket';
import { canvasUnit } from './canvas';
import { colorUnit } from './color';
import { eraserUnit } from './eraser';
import { fxParamsUnit } from './fxParams';
import { guidancesUnit } from './guidances';
import { historyUnit } from './history';
import { layersUnit } from './layers';
import { layoutUnit } from './layout';
import { selectionUnit } from './selection';
import { transformUnit } from './transform';
import { viewUnit } from './view';
import { textUnit } from './text';
import { geometryUnit } from './geometry';
import { scene3dUnit } from './scene3d';
import { poseUnit } from './pose';
import { detectorUnit } from './detector';
import { processorUnit } from './processor';
import { stagingUnit } from './staging';

/** 一格工作台正文能碰到的宿主事实：图池镜像（App 的 staging）、画布合成预览、以及图池的两个后端写口。
 *  绝大多数格子用不到 —— 只有 Staging 那一格要，因为它摆的就是宿主自己的那条图池条，条目 / 上传 /
 *  删除都不经过页面。 */
export type WorkbenchHostCtx = {
  staging: StagingItem[];
  blendPreview: { image: string; size: string } | null;
  /** Guidances 那张总卡的**本客户端**版本：iframe 每次合成完就发一张过来，与图池无关。
   *  null = 这一页还没收到过（回落到图池里那条）；'' = 收到过且现在是空的（栈被清空 / 全隐藏）。 */
  guidanceCard: string | null;
  stageUpload: (images: string[], names: string[]) => void;
  stageRemove: (id: string) => void;
  /** Layout 那一格要的两样：**现在**的布局（存下去的就是它）和一个写口（载入就是把它交给 `apply`）。
   *  `rules` 是校验的同一套口径 —— 一份旧布局里谁还认得、谁不认得，跟页面自己读档时一模一样；
   *  `openDocs` 是此刻开着的那几份文档窗口，载入时按它收一遍（关掉的剪走、新开的补进来）。 */
  layout: { dock: Dock; rules: DockRules; openDocs: UnitId[]; apply: (next: Dock) => void };
};

/** 每一格正文拿到的出口：`send` 泛型把动作键和它的载荷绑死（见 types 的 BlendUiPayloads），
 *  `host` 是那一小把宿主事实（只有 Staging 用）。 */
export type WorkbenchUnitProps = { send: BlendUiSend; host: WorkbenchHostCtx };

/** 一格工作台面板 = 一行注册数据：它叫什么、标题条上那句说明、以及它的正文怎么画。`Foot` 是可选的一条
 *  动作条（Clear All / Add / Undo / Redo 那一类）：dock 把它画在**正文下面**、滚动条之外，所以列表再长
 *  也顶不走它。没有这一条就照旧。 */
export type WorkbenchUnit = {
  id: UnitId;
  title: string;
  hint: string;
  Body: React.ComponentType<WorkbenchUnitProps>;
  Foot?: React.ComponentType<WorkbenchUnitProps>;
};

// 图层 / 工具 / 属性面板一块一个文件，这张表只负责点名和排序（序 = 工作台原来那一列的序：
// Canvas、Transform，然后 Color、Brush / Bucket / Eraser，Selection 与 View 原本就压在这列的最末）。
// Mask 曾经排在 Transform 与 Color 中间，现在**不在这张表里**：它不再是独立的 dock window，
// 而是 Guidances 那一格的第一行（见 mask.tsx 的 MaskRow 与 guidances.tsx）。少一扇窗，也就少一格
// 标题条和一圈空白 —— 这一列的高度是尺子量出来的，省一格是一格。
// Guidances 与 Layers 是这一列的倒数第二对 —— 页面上就是这两格压在工具列尾巴上，且 Guidances 在上。
// History 排在 Layers 之后（拍板 24.a：右栏、紧贴 Layers 下面）。
// Effect Parameters 压在最末：它说的是链里被点开的那一步，读的是快照 `fx.open`，没点开就是一句空态。
// 搬完一块就往后加一行，页面那一侧同时删掉它自己那一格。
// Layout 是唯一一格**没有正文对象**的：它摆的是别的窗口，读的是 dock 树，所以它要的是宿主那把
// 写口（`host.layout`），而不是页面播报过来的快照。
export const WORKBENCH_UNITS: WorkbenchUnit[] = [
  // Staging 那一格：画布底部原来那条工作区（Extra Prompt + Blend/Tag + 图池条 + Cancel / 进度）整条
  // 搬进宿主后合成的一格，排在最前 —— 它是画布的底栏，最常伸手。
  stagingUnit,
  canvasUnit, transformUnit, colorUnit, brushUnit, bucketUnit, eraserUnit, selectionUnit, viewUnit,
  // 侧栏那六格工具小窗：Text、Geometry、3D、Pose、Detector、Processor（序 = 页面那一列的序）。
  textUnit, geometryUnit, scene3dUnit, poseUnit, detectorUnit, processorUnit,
  guidancesUnit, layersUnit, historyUnit, fxParamsUnit,
  // Layout 压在最末：它不画页面上的任何东西，只记别人怎么摆 —— 摆法用不上时它就该在最不碍事的地方。
  layoutUnit,
];

export const WORKBENCH_PANEL_IDS: UnitId[] = WORKBENCH_UNITS.map(u => u.id);
export const WORKBENCH_TITLES: Record<string, string> =
  WORKBENCH_UNITS.reduce((a, u) => ({ ...a, [u.id]: u.title }), {} as Record<string, string>);
export const WORKBENCH_HINTS: Record<string, string> =
  WORKBENCH_UNITS.reduce((a, u) => ({ ...a, [u.id]: u.hint }), {} as Record<string, string>);

// 宿主只管发指令，正文每格自己读快照自己画 —— 所以这里遍历注册表，不写第二份 switch。
export const workbenchBodies = (send: BlendUiSend, host: WorkbenchHostCtx): Record<UnitId, React.ReactNode> =>
  WORKBENCH_UNITS.reduce((a, u) => {
    const Body = u.Body;
    return { ...a, [u.id]: <Body send={send} host={host} /> };
  }, {} as Record<UnitId, React.ReactNode>);

// 同上，只是那张表里声明了动作条的那几格 —— dock 把它摆在自己的正文下面。
export const workbenchFoots = (send: BlendUiSend, host: WorkbenchHostCtx): Partial<Record<UnitId, React.ReactNode>> =>
  WORKBENCH_UNITS.reduce((a, u) => {
    const Foot = u.Foot;
    return Foot ? { ...a, [u.id]: <Foot send={send} host={host} /> } : a;
  }, {} as Partial<Record<UnitId, React.ReactNode>>);
