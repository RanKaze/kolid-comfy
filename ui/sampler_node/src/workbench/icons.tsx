import React from 'react';

// ── 每一格的**标记** ────────────────────────────────────────────────────────────────────────────
// toolbar 模式把一扇窗收成一条图标条，所以"这一格长什么记号"从装饰变成了功能：没有记号的那一格
// 在 toolbar 里就是一颗不知道自己是谁的按钮。记号因此集中写在这一个文件里 —— 一格一个文件时，
// 记号画在哪个文件都不会有人去找，而"这一套记号互相对得上"（同一条 16 格栅格、同一道 1.4 的线、
// 同一种圆头）只能在一张表里看得见。
//
// 口径与 dock 其余部分一致：16×16 的 viewBox、currentColor 描边（颜色由按钮的 color 决定，
// 选中/悬停/禁用都不用第二套图）。`fill="currentColor"` 只用在少数几个实心点上（眼睛的瞳孔、
// 播放角的三角、笔尖），因为它们是记号里"读得出方向"的那一点。
//
// 名字就是 UnitId：工作台的二十格 + 宿主那五格 + 文档。`unitIcon(id)` 是唯一入口 —— toolbar 条
// 只认它，不认 id 的第二份表。

type IconProps = { size?: number };
export type UnitIcon = React.FC<IconProps>;

const Svg: React.FC<IconProps & { children: React.ReactNode }> = ({ size = 16, children }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    {children}
  </svg>
);

// ── 工作台那二十格 ──
const Staging: UnitIcon = p => <Svg {...p}>
  {/* 一条托盘：图池是一条可以往里丢东西、也可以从里面拿东西的底栏。 */}
  <path d="M2.4 9.3h3.2l1 1.9h2.8l1-1.9h3.2" />
  <path d="M3.6 2.9h8.8l1.4 6.4v3.8H2.2V9.3z" />
</Svg>;
const Canvas: UnitIcon = p => <Svg {...p}>
  <rect x="2" y="3" width="12" height="10" rx="1.6" />
  <circle cx="5.9" cy="6.6" r="1.1" />
  <path d="M2.6 11.6 6 8.6l2.4 2.2 2-1.8 2.9 2.6" />
</Svg>;
const Transform: UnitIcon = p => <Svg {...p}>
  <path d="M4.6 2.2v9.2h9.2" />
  <path d="M2.2 4.6h9.2v9.2" />
</Svg>;
const Mask: UnitIcon = p => <Svg {...p}>
  <circle cx="8" cy="8" r="5.4" />
  <path d="M8 2.6a5.4 5.4 0 0 1 0 10.8z" fill="currentColor" stroke="none" />
</Svg>;
const Color: UnitIcon = p => <Svg {...p}>
  <path d="M8 2.2c2.5 2.9 3.9 4.8 3.9 6.5a3.9 3.9 0 0 1-7.8 0C4.1 7 5.5 5.1 8 2.2z" />
  <path d="M6.4 9.2a1.7 1.7 0 0 0 1.3 1.7" />
</Svg>;
const Brush: UnitIcon = p => <Svg {...p}>
  <path d="M2.6 13.4c.3-1.9.9-2.6 2.1-3.1" />
  <path d="M6.4 9.6 12.6 3.4a1.5 1.5 0 0 0-2.1-2.1L4.3 7.5" />
  <path d="M6.4 9.6 4.3 7.5" />
</Svg>;
const Bucket: UnitIcon = p => <Svg {...p}>
  <path d="M7.2 2.2 2.7 6.7a1.4 1.4 0 0 0 0 2l3.3 3.3 4.6-4.6z" />
  <path d="M12.7 9.4c.6.9.9 1.5.9 2a.95.95 0 0 1-1.9 0c0-.5.4-1.1 1-2z" />
</Svg>;
const Eraser: UnitIcon = p => <Svg {...p}>
  <path d="M6.2 13.2h7" />
  <path d="M9.1 2.4 3.3 8.2a1.4 1.4 0 0 0 0 2l1.3 1.3a1.4 1.4 0 0 0 2 0L12.4 6z" />
  <path d="M6.3 5.2l4.5 4.5" />
</Svg>;
const Selection: UnitIcon = p => <Svg {...p}>
  <rect x="2.4" y="2.4" width="11.2" height="11.2" rx="1" strokeDasharray="2.2 1.8" />
  <rect x="9" y="9" width="3.2" height="3.2" rx="0.4" fill="currentColor" stroke="none" />
</Svg>;
const View: UnitIcon = p => <Svg {...p}>
  <path d="M8 3.6C4.7 3.6 2 5.9 1.1 8c.9 2.1 3.6 4.4 6.9 4.4S14.9 10.1 15 8c-.9-2.1-3.6-4.4-6.9-4.4z" />
  <circle cx="8" cy="8" r="1.9" fill="currentColor" stroke="none" />
</Svg>;
const Text: UnitIcon = p => <Svg {...p}>
  <path d="M2.8 3.2h10.4M8 3.2v9.6M6 12.8h4" />
</Svg>;
const Geometry: UnitIcon = p => <Svg {...p}>
  <path d="M1.9 12.4 5.8 4l3.9 8.4z" />
  <circle cx="11.4" cy="10.2" r="2.6" />
</Svg>;
const Scene3d: UnitIcon = p => <Svg {...p}>
  <path d="M8 1.9 14 5.1v5.8L8 14.1 2 10.9V5.1z" />
  <path d="M2 5.1 8 8.3l6-3.2M8 8.3v5.8" />
</Svg>;
const Pose: UnitIcon = p => <Svg {...p}>
  <circle cx="8" cy="3.4" r="1.5" />
  <path d="M8 4.9v4.2M8 9.1 5.7 13.3M8 9.1l2.3 4.2M4.8 6.9h6.4" />
</Svg>;
const Detector: UnitIcon = p => <Svg {...p}>
  <path d="M2.4 5.6V3.6a1.2 1.2 0 0 1 1.2-1.2h2M13.6 5.6V3.6a1.2 1.2 0 0 0-1.2-1.2h-2M2.4 10.4v2a1.2 1.2 0 0 0 1.2 1.2h2M13.6 10.4v2a1.2 1.2 0 0 1-1.2 1.2h-2" />
  <circle cx="8" cy="8" r="2.1" />
</Svg>;
const Processor: UnitIcon = p => <Svg {...p}>
  <circle cx="8" cy="8" r="2.3" />
  <path d="M8 2v1.7M8 12.3V14M2 8h1.7M12.3 8H14M3.8 3.8l1.2 1.2M11 11l1.2 1.2M12.2 3.8 11 5M5 11l-1.2 1.2" />
</Svg>;
const Guidances: UnitIcon = p => <Svg {...p}>
  <rect x="1.9" y="2.4" width="8" height="6.4" rx="1.1" />
  <rect x="6.1" y="7.2" width="8" height="6.4" rx="1.1" />
</Svg>;
const Layers: UnitIcon = p => <Svg {...p}>
  <path d="M8 1.9 14 5 8 8.1 2 5z" />
  <path d="M2 8.2 8 11.3 14 8.2" />
  <path d="M2 11.2 8 14.3 14 11.2" />
</Svg>;
const History: UnitIcon = p => <Svg {...p}>
  <path d="M2.7 8a5.3 5.3 0 1 0 1.7-3.9" />
  <path d="M2.1 4.3v2.6h2.6" />
  <path d="M8 5.3V8l2 1.3" />
</Svg>;
const FxParams: UnitIcon = p => <Svg {...p}>
  <path d="M1.9 11.9c2.9 0 3-6.8 6.1-6.8s3.1 4 6.1 4" />
  <circle cx="1.9" cy="11.9" r="1" fill="currentColor" stroke="none" />
  <circle cx="14.1" cy="9.1" r="1" fill="currentColor" stroke="none" />
</Svg>;

// ── Video 模式的两格 ──
// Player：一块幕布 + 播放角。Tracks：三条轨，其中一条上摆着一段片段。
const VPlayer: UnitIcon = p => <Svg {...p}>
  <rect x="1.9" y="2.9" width="12.2" height="9.4" rx="1.6" />
  <path d="M6.7 5.6 10.4 7.6 6.7 9.6z" fill="currentColor" stroke="none" />
  <path d="M5.2 13.6h5.6" />
</Svg>;
const VTracks: UnitIcon = p => <Svg {...p}>
  <path d="M1.9 3.9h12.2M1.9 12.2h12.2M1.9 8.1h12.2" opacity="0.55" />
  <rect x="4.1" y="6.7" width="6.4" height="2.8" rx="0.7" fill="currentColor" stroke="none" />
</Svg>;
const VAssets: UnitIcon = p => <Svg {...p}>
  {/* 资产库：一只素材箱，箱口叠着一帧片子。 */}
  <rect x="2.4" y="6.4" width="11.2" height="7.2" rx="1.4" />
  <path d="M5.4 6.4V3.4h5.2v3" />
  <path d="M7 9.1 9.7 10.5 7 11.9z" fill="currentColor" stroke="none" />
</Svg>;

// 一格分栏：外框里一条竖缝、一条横缝。它是一份**摆法**的记号，不是任何一扇窗的。
const Layout: UnitIcon = p => <Svg {...p}>
  <rect x="1.9" y="2.4" width="12.2" height="11.2" rx="1.6" />
  <path d="M6.5 2.4v11.2" />
  <path d="M6.5 8.1h7.6" />
</Svg>;

// ── 宿主那五格 ──
const File: UnitIcon = p => <Svg {...p}>
  <path d="M4 1.9h5.2L12.2 5v9.1H4z" />
  <path d="M9.2 1.9V5h3" />
</Svg>;
const Context: UnitIcon = p => <Svg {...p}>
  <rect x="1.9" y="2.4" width="12.2" height="11.2" rx="1.5" />
  <circle cx="10.6" cy="5.8" r="1" />
  <path d="M2.4 10.6 5.6 7.6l2.3 2.2 1.8-1.7 3.4 3" />
</Svg>;
const Pipeline: UnitIcon = p => <Svg {...p}>
  <circle cx="2.9" cy="8" r="1.4" />
  <circle cx="8" cy="3.2" r="1.4" />
  <circle cx="8" cy="12.8" r="1.4" />
  <circle cx="13.1" cy="8" r="1.4" />
  <path d="M4.1 7.2 6.8 4.1M4.1 8.8l2.7 3.1M9.2 4.1l2.7 3.1M9.2 11.9l2.7-3.1" />
</Svg>;
const Preprocess: UnitIcon = p => <Svg {...p}>
  <path d="M1.9 5.2h12.2M1.9 10.8h12.2" />
  <circle cx="5.8" cy="5.2" r="1.7" fill="#232325" />
  <circle cx="10.2" cy="10.8" r="1.7" fill="#232325" />
</Svg>;
export const PREPROCESS_ICON = Preprocess;
// Pipeline Presets：一摞命名的链（三条横排 + 每行左端一个序号点），与 Pipeline 那张"拓扑图"
// 区分开 —— 拆成两扇窗之后，toolbar 条上是并排两颗按钮，记号必须能一眼分出"选哪条管线"和"跑哪套链"。
const Presets: UnitIcon = p => <Svg {...p}>
  <path d="M2.4 3.6h11.2M2.4 8h11.2M2.4 12.4h11.2" />
  <circle cx="1.2" cy="3.6" r="0.55" fill="currentColor" />
  <circle cx="1.2" cy="8" r="0.55" fill="currentColor" />
  <circle cx="1.2" cy="12.4" r="0.55" fill="currentColor" />
</Svg>;
const Blocks: UnitIcon = p => <Svg {...p}>
  <rect x="1.9" y="2.4" width="5.3" height="4.5" rx="0.9" />
  <rect x="8.8" y="2.4" width="5.3" height="4.5" rx="0.9" />
  <rect x="1.9" y="9.1" width="5.3" height="4.5" rx="0.9" />
  <rect x="8.8" y="9.1" width="5.3" height="4.5" rx="0.9" />
</Svg>;

// ── 文档 ──
// 一份工程 = 一张纸 + 一个播放角。工程的窗口里跑的是工作台，所以那个三角不是装饰：
// 它是这两类单元在 toolbar 条上唯一的区别（面板是"这一格是什么"，文档是"这一份在跑"）。
const Document: UnitIcon = p => <Svg {...p}>
  <path d="M3.9 1.9h5.4L12.3 5v9.1H3.9z" />
  <path d="M9.3 1.9V5h3" />
  <path d="M6.1 7.6 9.5 9.4 6.1 11.2z" fill="currentColor" stroke="none" />
</Svg>;

export const UNIT_ICONS: Record<string, UnitIcon> = {
  // 工作台
  staging: Staging, canvas: Canvas, transform: Transform, mask: Mask, color: Color,
  brush: Brush, bucket: Bucket, eraser: Eraser, selection: Selection, view: View,
  text: Text, geometry: Geometry, scene3d: Scene3d, pose: Pose, detector: Detector,
  processor: Processor, guidances: Guidances, layers: Layers, history: History, fxParams: FxParams,
  layout: Layout,
  // Video 模式
  vplayer: VPlayer, vtracks: VTracks, vassets: VAssets,
  // 宿主
  toolbar: File, context: Context, pipeline: Pipeline, presets: Presets, blocks: Blocks,
};
export const DOC_ICON: UnitIcon = Document;

// toolbar 条上唯一认的入口。不认识的单元（将来新加、还没画记号）退回一颗中性方块 —— 一颗空按钮
// 比一颗没有按钮更糟：那一条上会凭空少一格，用户以为是窗口不见了。
const Fallback: UnitIcon = p => <Svg {...p}>
  <rect x="3" y="3" width="10" height="10" rx="2" />
</Svg>;
export const unitIcon = (id: string): UnitIcon =>
  UNIT_ICONS[id] ?? (id.startsWith('doc:') ? DOC_ICON : Fallback);

