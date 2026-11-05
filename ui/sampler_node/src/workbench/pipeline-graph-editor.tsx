// Pipeline Blocks —— xyflow 画布
//
// 把 `PipelineGraph` 画成一张节点图：Start（出 Image/Mask/Execute）、End（入 Image/Mask/
// Execute）、每个 block 一个节点。**Execute** 边定执行顺序（detect 有两条：命中/未命中，
// 运行时二选一）；**Image / Mask** 是显式数据边；**Info**（crop/scale/limit/meet/fit）
// 把几何操作与它的 Recover 显式配对。
//
// 参数**直接内联在节点上**（没有底部 inspector）：节点体内按 `PARAM_FIELDS[kind]` 渲染
// 紧凑表单。所有交互控件挂在 `.nodrag` / `.nowheel` 容器里 —— 否则在输入框里拖选文本、
// 滚轮滚动会去拖动/缩放画布，参数就编辑不了。
//
// 端口颜色按 kind 分：exec 灰 / image 绿 / mask 青 / *_info 紫。连线同 kind 才连 ——
// 唯一的跨类型例外是 **mask → image**（后端把 mask 铺成黑白图，见 portsCompatible）。

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDockDocument } from '../dock/docScope';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position,
  useNodesState, useEdgesState, addEdge, reconnectEdge, useReactFlow, useNodesInitialized,
  type Node, type Edge, type NodeProps, type Connection, type NodeChange, type EdgeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  NODE_SPECS, portKindOfNode, nodePorts, validateGraph, defaultParamsFor, defaultNameFor, PARAM_FIELDS,
  portsCompatible,
  START_ID, END_ID, BOARD_ID, graphEnableMask, isSchedulable,
  type PipelineGraph, type GraphNode, type NodeKind, type PortKind, type PortSpec, type ParamField,
} from './pipeline-graph';
import type { InterfacePort } from '../types';

const KIND_COLOR: Record<PortKind, string> = {
  exec: '#8e8e93', image: '#30d158', mask: '#64d2ff', any: '#ff9f0a',
  crop_info: '#bf5af2', scale_info: '#bf5af2', limit_info: '#bf5af2', meet_info: '#bf5af2', fit_info: '#bf5af2',
};
const portColor = (k: PortKind) => KIND_COLOR[k] || '#8e8e93';

// ---------------------------------------------------------------------------
// 数据 <-> xyflow 的互转
// ---------------------------------------------------------------------------

interface PipeNodeData extends Record<string, unknown> {
  kind: NodeKind; name: string; params: Record<string, any>;
}

/** 黑板不是 xyflow 节点（它是一张悬浮在画布上的**屏幕坐标**面板，不吃视口 transform，
 *  见 BoardCard），所以出图时要由调用方把它补回来 —— 否则任何一次结构性改动都会把
 *  黑板从图里抹掉。 */
const toRfNodes = (g: PipelineGraph): Node<PipeNodeData>[] =>
  g.nodes.filter(n => isSchedulable(n.kind) || n.kind === 'start' || n.kind === 'end')
    .map(n => ({
      id: n.id, type: 'pipe',
      position: { x: n.x ?? 0, y: n.y ?? 0 },
      data: { kind: n.kind, name: n.name, params: n.params || {} },
    }));

/** 黑板那一个节点（缺就现造一块默认的）。x/y 只是数据模型里的老坐标字段 —— 卡片自身的
 *  位置是编辑器内的屏幕坐标 UI 状态（见 boardPos），跟视口无关，也不随图存盘。 */
const boardOf = (g: PipelineGraph): GraphNode =>
  g.nodes.find(n => n.kind === 'board')
  ?? { id: BOARD_ID, kind: 'board', name: 'Preprocess', x: 0, y: -170, params: defaultParamsFor('board') };

// 边用**内置类型**（bezier/default）：只有这样 xyflow 的官方便携重连手柄（EdgeUpdateAnchors）
// 才会自动挂上 —— 它由 EdgeWrapper 无条件渲染（与边类型无关，但自定义边容易把命中区搅乱）。
const toRfEdges = (g: PipelineGraph): Edge[] =>
  g.edges.map(e => {
    const kind = portKindOfKind(g, e.source, e.sourcePort) || 'exec';
    return {
      id: e.id, source: e.source, target: e.target,
      sourceHandle: e.sourcePort, targetHandle: e.targetPort,
      interactionWidth: 24,
      style: { stroke: portColor(kind), strokeWidth: 1.6 },
    } as Edge;
  });

const portKindOfKind = (g: PipelineGraph, nodeId: string, portId: string): PortKind | undefined => {
  const n = g.nodes.find(x => x.id === nodeId);
  return n ? portKindOfNode(n, 'out', portId, graphEnableMask(g)) : undefined;
};

/** **结构性**指纹：节点 id/kind/name/params + 边。**不含坐标** —— 拖拽时坐标每帧都在变，
 *  若把坐标算进来，父级把图回传时会把内部节点按旧坐标重置，拖拽就被打断。 */
const structSig = (g: PipelineGraph): string =>
  g.nodes.map(n => `${n.id},${n.kind},${n.name},${JSON.stringify(n.params || {})}`).join('|')
  + '#' + g.edges.map(e => `${e.source}:${e.sourcePort}>${e.target}:${e.targetPort}`).join('|');

/** xyflow 的 nodes/edges → 我们的图模型。黑板由 `board` 补回来（它不在画布节点里）。 */
const graphFromRf = (rfNodes: Node<PipeNodeData>[], rfEdges: Edge[], board: GraphNode): PipelineGraph => ({
  nodes: [
    { ...board, params: board.params || {} },
    ...rfNodes.map(n => ({
      id: n.id, kind: n.data.kind, name: n.data.name,
      x: Math.round(n.position.x), y: Math.round(n.position.y),
      params: n.data.params || {},
    })),
  ],
  edges: rfEdges.map(e => ({
    id: e.id, source: e.source, target: e.target,
    sourcePort: String(e.sourceHandle || ''), targetPort: String(e.targetHandle || ''),
  })),
});

// ---------------------------------------------------------------------------
// 节点内联编辑的上下文：把编辑动作发给宿主（节点组件本身不持有状态）
// ---------------------------------------------------------------------------

interface GraphEditApi {
  updateParam: (nodeId: string, key: string, value: any) => void;
  renameNode: (nodeId: string, name: string) => void;
  /** 当前 pipeline 是不是 Krea2 —— Detailer 的 Edit Mode(fit/crop) 只对它有意义。 */
  krea2: boolean;
  /** 黑板上的预处理开关（8 个）。 */
  board: Record<string, any>;
  updateBoard: (key: string, value: any) => void;
  /** 黑板的 Enable Mask —— Start 的 Mask 输出 / End 的 Mask 输入在它关掉时不存在。 */
  enableMask: boolean;
  presets?: { id: string; name: string }[];
  /** 可选 interface 列表：内联选择器按名字绑定；带 `start_ports` 时还画每端口的图来源。 */
  interfaces?: GraphInterfaceInfo[];
  /** 图池条目 —— interface 节点的端口图 / context 图 mask 从这里选。 */
  staging?: { id: string; name: string }[];
  onCreatePreset?: () => Promise<string | null>;
  onRenamePreset?: (id: string, name: string) => void;
  onEditPreset?: (id: string) => void;
  onDeletePreset?: (id: string) => void;
}

/** 编辑器要的 interface 三样：名字（绑定用）、**在 server 包表里的真实下标**（回落 + 选项值，
 *  列表可能被外面按 block-capable 过滤过，下标必须仍是全表的那一个）、入口端口（画端口图来源）。 */
export interface GraphInterfaceInfo { name: string; index: number; start_ports?: InterfacePort[] }

const GraphEditCtx = createContext<GraphEditApi | null>(null);

// ---------------------------------------------------------------------------
// 节点组件（参数内联）
// ---------------------------------------------------------------------------

const PortRow: React.FC<{ port: PortSpec; side: 'in' | 'out' }> = ({ port, side }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 5, position: 'relative', height: 16 }}>
    {side === 'out' && <span style={{ fontSize: 8.5, color: 'rgba(255,255,255,0.45)', marginLeft: 'auto' }}>{port.label}</span>}
    <Handle type={side === 'in' ? 'target' : 'source'} position={side === 'in' ? Position.Left : Position.Right} id={port.id}
      style={{ width: 7, height: 7, background: portColor(port.kind), border: '1px solid rgba(0,0,0,0.45)', [side === 'in' ? 'left' : 'right']: -4 }} />
    {side === 'in' && <span style={{ fontSize: 8.5, color: 'rgba(255,255,255,0.45)' }}>{port.label}</span>}
  </div>
);

const ctrlStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.07)',
  border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: 5, color: '#fff',
  fontSize: 10.5, padding: '2px 5px',
};

/** 一行参数：label 左、控件右。**控件**挂 nodrag（拖它不挪节点）；容器不挂，节点主体仍可拖。 */
const InlineField: React.FC<{ field: ParamField; value: any; onSet: (v: any) => void }> = ({ field, value, onSet }) => {
  const label = <span title={field.title} style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.55)', whiteSpace: 'nowrap' }}>{field.label}</span>;
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 3 };
  if (field.kind === 'bool') {
    return <div style={row}>{label}<input className="nodrag" type="checkbox" checked={!!value} onChange={e => onSet(e.target.checked)} /></div>;
  }
  if (field.kind === 'select') {
    return (
      <div style={row}>{label}
        <select className="nodrag" value={value ?? ''} onChange={e => onSet(e.target.value)} style={{ ...ctrlStyle, width: 96 }}>
          {(field.options || []).map(o => <option key={o.value} value={o.value} style={{ background: '#1c1c1e' }}>{o.label}</option>)}
        </select>
      </div>
    );
  }
  if (field.kind === 'number') {
    return (
      <div style={row}>{label}
        <input className="nodrag" type="number" value={value ?? 0} min={field.min} max={field.max} step={field.step}
          onChange={e => onSet(e.target.value === '' ? 0 : Number(e.target.value))} style={{ ...ctrlStyle, width: 96 }} />
      </div>
    );
  }
  return (
    <div style={row}>{label}
      <input className="nodrag" value={value ?? ''} onChange={e => onSet(e.target.value)} style={{ ...ctrlStyle, width: 130 }} />
    </div>
  );
};

/** prompt 节点的内联预设管理（选 + 新建/改名/编辑/删除）。 */
const InlinePresetManager: React.FC<{ nodeId: string; value: string | null | undefined }> = ({ nodeId, value }) => {
  const api = useContext(GraphEditCtx);
  if (!api) return null;
  const cur = api.presets?.find(p => p.id === value);
  const miniBtn: React.CSSProperties = {
    width: 18, height: 18, lineHeight: '16px', textAlign: 'center', cursor: 'pointer',
    background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.75)',
    border: '0.5px solid rgba(255,255,255,0.15)', borderRadius: 5, fontSize: 10, padding: 0,
  };
  const setPreset = (v: string | null) => api.updateParam(nodeId, 'preset_id', v);
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
      <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.55)' }}>Preset</span>
      <div className="nodrag" style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <select value={value ?? ''} onChange={e => setPreset(e.target.value || null)} style={{ ...ctrlStyle, width: 92 }}>
          <option value="">— none —</option>
          {(api.presets || []).map(p => <option key={p.id} value={p.id} style={{ background: '#1c1c1e' }}>{p.name}</option>)}
        </select>
        {api.onCreatePreset && (
          <button style={miniBtn} title="New preset and use it here"
            onClick={async () => { const id = await api.onCreatePreset!(); if (id) setPreset(id); }}>＋</button>
        )}
        {api.onRenamePreset && (
          <button style={miniBtn} title="Rename this preset" disabled={!cur}
            onClick={() => { if (!cur) return; const n = window.prompt('Preset name', cur.name); if (n !== null) api.onRenamePreset!(cur.id, n.trim()); }}>✎</button>
        )}
        {api.onEditPreset && (
          <button style={miniBtn} title={cur ? 'Open the prompt editor' : 'Select or create first'} disabled={!cur}
            onClick={() => { if (cur) api.onEditPreset!(cur.id); }}>⚙</button>
        )}
        {api.onDeletePreset && (
          <button style={miniBtn} title="Delete this preset" disabled={!cur}
            onClick={() => { if (!cur) return; if (window.confirm(`删除 preset「${cur.name}」？`)) api.onDeletePreset!(cur.id); }}>🗑</button>
        )}
      </div>
    </div>
  );
};

/** interface 节点的内联参数面：目标选择（单一真源 = `params.interface_idx`，同一次改动把
 *  `interface_name` 一并同步 —— 引擎按名字绑定更稳，重排/增删接口不会错绑）、Operation(+crop_reserve)、
 *  每个入口端口的图来源、可选 context 图 / mask。这几样原本在旧 List 的块卡片里，搬进节点后必须原样
 *  保留：少了它们 interface 块就配不出输入，整条链的输出无从谈起。 */
const InterfaceBody: React.FC<{ nodeId: string; params: Record<string, any> }> = ({ nodeId, params }) => {
  const api = useContext(GraphEditCtx);
  if (!api) return null;
  const list = api.interfaces;
  if (!list) return <div style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.4)' }}>idx: {String(params.interface_idx ?? 0)}</div>;
  const byName = params.interface_name ? list.findIndex(it => it.name === params.interface_name) : -1;
  // 当前下标优先按名字解（名字是稳定标识）；解不出才回落到 params 里的下标。
  const cur = byName >= 0 ? list[byName].index : (typeof params.interface_idx === 'number' ? params.interface_idx : -1);
  const curListed = list.some(it => it.index === cur);
  const itf = list.find(it => it.index === cur);
  const staging = api.staging || [];
  const set = (k: string, v: any) => api.updateParam(nodeId, k, v);
  const opt = { background: '#1c1c1e' } as React.CSSProperties;
  const lbl: React.CSSProperties = { fontSize: 9.5, color: 'rgba(255,255,255,0.55)', whiteSpace: 'nowrap' };
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 3 };
  const ports = (itf?.start_ports || []).filter(p => p.category === 'inject' && p.type !== 'PIPELINE_DATA');
  return (<>
    <div style={row}><span style={lbl}>Interface</span>
      <select className="nodrag" value={String(cur)} style={{ ...ctrlStyle, width: 130 }}
        onChange={e => {
          const i = Number(e.target.value);
          set('interface_idx', i);
          set('interface_name', list.find(it => it.index === i)?.name ?? null);
        }}>
        {!curListed && <option value={String(cur)} style={opt}>{cur < 0 ? '— none —' : `idx ${cur}`}</option>}
        {list.map(it => <option key={it.index} value={it.index} style={opt}>{it.name || `Interface ${it.index + 1}`}</option>)}
      </select>
    </div>
    {!!params.interface_name && list.length > 0 && byName < 0 && (
      <div style={{ fontSize: 9.5, color: '#ff9f0a', marginBottom: 3 }}>Missing: {params.interface_name}</div>
    )}
    <div style={row}><span style={lbl}>Operation</span>
      <div className="nodrag" style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <select value={params.operation ?? 'default'} style={{ ...ctrlStyle, width: 78 }}
          onChange={e => set('operation', e.target.value)}>
          <option value="default" style={opt}>default</option>
          <option value="crop" style={opt}>crop</option>
        </select>
        {params.operation === 'crop' && (
          <input type="number" min={0} value={params.crop_reserve ?? 32} style={{ ...ctrlStyle, width: 52 }}
            title="crop 时在边缘多留的余量"
            onChange={e => set('crop_reserve', parseInt(e.target.value, 10) || 0)} />
        )}
      </div>
    </div>
    {ports.map(p => (
      <div style={row} key={p.num}><span style={lbl}>{p.name || `Port ${p.num}`}</span>
        <select className="nodrag" value={(params.image_keys && params.image_keys[p.num]) || ''} style={{ ...ctrlStyle, width: 130 }}
          onChange={e => {
            const next = { ...(params.image_keys || {}) };
            if (e.target.value) next[p.num] = e.target.value; else delete next[p.num];
            set('image_keys', next);
          }}>
          <option value="" style={opt}>(none)</option>
          {staging.map((s, i) => <option key={i} value={s.id} style={opt}>{s.name} ({s.id})</option>)}
        </select>
      </div>
    ))}
    <div style={row}><span style={lbl}>Ctx Image</span>
      <select className="nodrag" value={params.context_image_key || ''} style={{ ...ctrlStyle, width: 130 }}
        onChange={e => set('context_image_key', e.target.value || null)}>
        <option value="" style={opt}>(use pipeline)</option>
        {staging.map((s, i) => <option key={i} value={s.id} style={opt}>{s.name} ({s.id})</option>)}
      </select>
    </div>
    <div style={row}><span style={lbl}>Ctx Mask</span>
      <select className="nodrag" value={params.context_mask_key || ''} style={{ ...ctrlStyle, width: 130 }}
        onChange={e => set('context_mask_key', e.target.value || null)}>
        <option value="" style={opt}>(use pipeline)</option>
        {staging.map((s, i) => <option key={i} value={s.id} style={opt}>{s.name} ({s.id})</option>)}
      </select>
    </div>
  </>);
};

/** query 节点的内联参数面：绑定的 preset（弹窗初始勾选） + Persistent（Confirm 时是否写回 preset）。
 *  这两样旧 List 版在块卡片里，节点化后必须保留 —— 少了绑定，Query 弹窗就只能从空白开始。 */
const QueryBody: React.FC<{ nodeId: string; params: Record<string, any> }> = ({ nodeId, params }) => {
  const api = useContext(GraphEditCtx);
  if (!api) return null;
  const bound = !!params.preset_id;
  return (<>
    <InlinePresetManager nodeId={nodeId} value={params.preset_id} />
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginTop: 3 }}>
      <span title={bound ? '开：Confirm 时把弹窗里的最终选择整体写回绑定的 preset，下次 run / 下次打开弹窗就是它。'
        : '先绑定 preset 才能持久化 —— 没有 preset 就没有可写回的地方。'}
        style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.55)' }}>Persistent</span>
      <input className="nodrag" type="checkbox" disabled={!bound}
        checked={bound && !!params.persistent}
        onChange={e => api.updateParam(nodeId, 'persistent', e.target.checked)} />
    </div>
  </>);
};

/** Switch 节点的内联编辑器：每条分枝 = 一个 exec 头 + 它的 data 数量。 */
const SwitchBody: React.FC<{ params: Record<string, any>; onSet: (v: any) => void }> = ({ params, onSet }) => {
  const branches: { data: number }[] = Array.isArray(params.branches) ? params.branches : [];
  const miniBtn: React.CSSProperties = {
    width: 16, height: 16, lineHeight: '14px', textAlign: 'center', cursor: 'pointer',
    background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.75)',
    border: '0.5px solid rgba(255,255,255,0.15)', borderRadius: 4, fontSize: 10, padding: 0,
  };
  const setBranch = (i: number, data: number) => {
    const next = branches.map((b, j) => (j === i ? { data: Math.max(0, data) } : b));
    onSet({ branches: next });
  };
  return (
    <div>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)', marginBottom: 3 }}>Branches (exec heads)</div>
      {branches.map((b, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
          <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.6)', width: 44 }}>Exec {i + 1}</span>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)' }}>data</span>
          <input className="nodrag" type="number" min={0} max={16} value={b.data ?? 0}
            onChange={e => setBranch(i, Number(e.target.value) || 0)} style={{ ...ctrlStyle, width: 44 }} />
          <button className="nodrag" style={miniBtn} title="remove this branch"
            onClick={() => onSet({ branches: branches.filter((_, j) => j !== i) })}>✕</button>
        </div>
      ))}
      <button className="nodrag" style={{ ...miniBtn, width: 'auto', padding: '0 6px' }} title="add an exec head"
        onClick={() => onSet({ branches: [...branches, { data: 0 }] })}>+ Exec</button>
    </div>
  );
};

/** 黑板卡片 —— Preprocess 那 8 个开关。**不是 xyflow 节点**：它摆在自己的图层里，是一张
 *  **屏幕坐标**的悬浮面板（就像左上角那条校验横幅）—— 位置是画布容器内的像素坐标，不套
 *  视口 transform，所以用户平移/缩放节点图时它原地不动、大小也不变。标题条担起拖动（控件
 *  那一区不碰，免得点开关时挪面板）；拖的是面板自己的坐标，与画布 zoom 无关，也不随图存盘。 */
const BoardCard: React.FC<{
  board: GraphNode;
  enableMask: boolean;
  onSet: (key: string, value: any) => void;
  /** 面板左上角在画布容器内的像素坐标；null = 还没落位（先以右上角待命，用户一拖就固定成坐标）。 */
  pos: { x: number; y: number } | null;
  onPos: (x: number, y: number) => void;
  /** 画布容器 —— 拖拽边界与"拉回视野"都按它的真实尺寸算。 */
  wrapRef: React.RefObject<HTMLDivElement | null>;
}> = ({ board, enableMask, onSet, pos, onPos, wrapRef }) => {
  const drag = useRef<{ px: number; py: number; ox: number; oy: number; cw: number; ch: number } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const p = board.params || {};
  const dim = (on: boolean): React.CSSProperties => (on ? {} : { opacity: 0.4, pointerEvents: 'none' });
  const gTitle: React.CSSProperties = {
    fontSize: 8.5, letterSpacing: 0.7, textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', margin: '6px 0 2px',
  };
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 2 };
  const lbl: React.CSSProperties = { fontSize: 10, color: 'rgba(255,255,255,0.72)', whiteSpace: 'nowrap' };
  const Row: React.FC<{ k: string; label: string; title: string; disabled?: boolean }> = ({ k, label, title, disabled }) => (
    <div style={row} title={title}>
      <span style={lbl}>{label}</span>
      <input type="checkbox" checked={!!p[k]} disabled={disabled} onChange={e => onSet(k, e.target.checked)} />
    </div>
  );
  /** 把面板夹在画布容器里（容器比卡还小时贴左上角）—— 不然窗口一缩小，面板就被裁掉或拖飞出视野。 */
  const clamp = (x: number, y: number, cw: number, ch: number): { x: number; y: number } => {
    const wrap = wrapRef.current;
    const w = wrap?.clientWidth ?? 0, h = wrap?.clientHeight ?? 0;
    return {
      x: w > cw ? Math.min(Math.max(0, x), w - cw) : 0,
      y: h > ch ? Math.min(Math.max(0, y), h - ch) : 0,
    };
  };
  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
  };
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 4 }}>
      <div ref={cardRef} data-board-card style={{
        position: 'absolute',
        // 落过位用 left/top；没落位先用右上角待命（避开左上角的校验横幅）
        left: pos ? pos.x : undefined,
        right: pos ? undefined : 10,
        top: pos ? pos.y : 10,
        width: 190,
        pointerEvents: 'auto', userSelect: 'none',
        background: '#1c1c1e', border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: 10,
        boxShadow: '0 4px 16px rgba(0,0,0,0.45)', padding: '5px 9px 8px',
      }}>
        {/* 标题条 = 拖动把柄。**屏幕坐标直算、不除 zoom** —— 面板不随画布缩放/平移。 */}
        <div
          onPointerDown={e => {
            const card = cardRef.current, wrap = wrapRef.current;
            if (!card || !wrap) return;
            const wr = wrap.getBoundingClientRect();
            const cr = card.getBoundingClientRect();
            // 从当前视觉位置接续（右上角待命时先换算成 left/top，整个拖动过程同一坐标系）
            const x = cr.left - wr.left, y = cr.top - wr.top;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { px: e.clientX, py: e.clientY, ox: x, oy: y, cw: cr.width, ch: cr.height };
            onPos(x, y);
          }}
          onPointerMove={e => {
            const d = drag.current;
            if (!d) return;
            const q = clamp(d.ox + (e.clientX - d.px), d.oy + (e.clientY - d.py), d.cw, d.ch);
            onPos(q.x, q.y);
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, cursor: 'grab',
            marginBottom: 2, paddingBottom: 3, borderBottom: '0.5px solid rgba(255,255,255,0.08)',
          }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: NODE_SPECS.board.color, flexShrink: 0 }} />
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'rgba(255,255,255,0.9)' }}>Preprocess</span>
        </div>

          <div style={gTitle}>Mask</div>
          <Row k="enable_mask" label="Enable Mask" title="开 = mask 预处理全开：扩张/羽化 + 按 mask 裁剪 + recover crop，Start/End 也才有 Mask 端口。关 = 这四步全跳过，Start 的 Mask 输出与 End 的 Mask 输入直接消失。" />
          <div style={dim(enableMask)}>
            <Row k="recover_crop" label="Recover Crop" title="开 = 按 crop 几何把产出合成回整幅图。关 = 产出保持 crop 工作区分辨率，作为新图层贴回原位。" disabled={!enableMask} />
            <Row k="enable_fit" label="Enable Fit" title="开 = 图层 Generate 结束时自动 Fit Mask（缩到 mask 外接框）。" disabled={!enableMask} />
          </div>

          <div style={gTitle}>Limit</div>
          <Row k="enable_limit" label="Enable Limit" title="开 = 按 Pixels / Align 限制工作分辨率。关 = 工作分辨率就是裁剪（或整幅）分辨率。" />

          <div style={gTitle}>Output</div>
          <Row k="enable_output" label="Enable Output" title="开 = 这一趟的最终产出另外存一张 PNG 到 ComfyUI 的 outputs 文件夹。" />

          <div style={gTitle}>Dynamic Layer</div>
          <Row k="enable_dynamic_layer" label="Dynamic Layer" title="开 = 这个 preset 的 ▶ Run 改为先框选建层再自动 Generate。关 = 保持整幅 Run。" />
          <div style={dim(!!p.enable_dynamic_layer)}>
            <Row k="dynamic_layer_limit" label="Layer Limit" title="开 = 建层分辨率按 DEFAULT SETTING 的 Pixels 预算算。" disabled={!p.enable_dynamic_layer} />
            <Row k="dynamic_layer_ctx" label="Layer Context" title="开 = 自动 Generate 用框下方图层的合成当 context。" disabled={!p.enable_dynamic_layer} />
          </div>
        </div>
    </div>
  );
};

const PipeNode: React.FC<NodeProps<Node<PipeNodeData>>> = ({ id, data, selected }) => {
  const api = useContext(GraphEditCtx);
  const spec = NODE_SPECS[data.kind];
  if (!spec) return <div style={{ color: '#ff6961', fontSize: 11 }}>未知: {String(data.kind)}</div>;
  const ports = nodePorts({ kind: data.kind, params: data.params }, api?.enableMask ?? true);
  // Edit Mode 只在 Krea2 架构下有意义（其余架构只显示 Enable Edit）。
  const fields = (PARAM_FIELDS[data.kind] || [])
    .filter(f => !f.when || f.when(data.params))
    .filter(f => !(data.kind === 'detailer' && f.key === 'edit_mode' && !api?.krea2));
  const setParam = (key: string, v: any) => api?.updateParam(id, key, v);
  return (
    <div style={{
      minWidth: 220, background: '#1c1c1e', borderRadius: 10,
      border: `1px solid ${selected ? spec.color : 'rgba(255,255,255,0.12)'}`,
      boxShadow: selected ? `0 0 0 1px ${spec.color}55, 0 6px 18px rgba(0,0,0,0.5)` : '0 3px 10px rgba(0,0,0,0.4)',
      overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: `${spec.color}22` }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: spec.color, flexShrink: 0 }} />
        <input value={data.name} onChange={e => api?.renameNode(id, e.target.value)}
          className="nodrag"
          style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.9)', fontSize: 11.5, fontWeight: 600, outline: 'none' }} />
      </div>
      {/* 端口（左右）+ 参数（中）：参数容器挂 nodrag/nowheel，编辑时不会拖画布、滚轮不缩放 */}
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '6px 8px' }}>
          {ports.inputs.map(p => <PortRow key={p.id} port={p} side="in" />)}
        </div>
        {/* 参数区**不挂 nodrag**（否则整块节点主体都拖不动）—— 只有里面的控件挂 nodrag。
            容器挂 nowheel：在参数区滚轮滚动不会缩放画布。 */}
        <div className="nowheel" style={{ flex: 1, minWidth: 0, padding: '6px 6px', borderLeft: '0.5px solid rgba(255,255,255,0.06)', borderRight: '0.5px solid rgba(255,255,255,0.06)' }}>
          {data.kind === 'switch' && <SwitchBody params={data.params} onSet={v => setParam('branches', v.branches)} />}
          {data.kind === 'prompt' && <InlinePresetManager nodeId={id} value={data.params.preset_id} />}
          {data.kind === 'query' && <QueryBody nodeId={id} params={data.params} />}
          {data.kind === 'interface' && <InterfaceBody nodeId={id} params={data.params} />}
          {fields.map(f => (
            <InlineField key={f.key} field={f} value={data.params[f.key]} onSet={v => setParam(f.key, v)} />
          ))}
          {fields.length === 0 && data.kind !== 'prompt' && data.kind !== 'query' && data.kind !== 'interface' && data.kind !== 'switch' && (
            <div style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.35)' }}>no parameters</div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '6px 8px' }}>
          {ports.outputs.map(p => <PortRow key={p.id} port={p} side="out" />)}
        </div>
      </div>
    </div>
  );
};

const nodeTypes = { pipe: PipeNode };

// ---------------------------------------------------------------------------
// 编辑器
// ---------------------------------------------------------------------------

export interface PipelineGraphEditorProps {
  graph: PipelineGraph;
  onChange: (g: PipelineGraph) => void;
  presets?: { id: string; name: string }[];
  interfaces?: GraphInterfaceInfo[];
  /** 图池条目 —— interface 节点的端口图 / context 图 mask 从这里选。 */
  staging?: { id: string; name: string }[];
  onCreatePreset?: () => Promise<string | null>;
  onRenamePreset?: (id: string, name: string) => void;
  onEditPreset?: (id: string) => void;
  onDeletePreset?: (id: string) => void;
  /** 当前 pipeline 架构名（'' / null = 未知）—— 用于 Krea2 专属字段的门控。 */
  architecture?: string | null;
  /** 'fill' = 铺满父容器（父级要给它确定高度）；number = 固定像素高。 */
  height?: number | 'fill';
}

const PipelineGraphEditorInner: React.FC<PipelineGraphEditorProps> = ({
  graph, onChange, presets, interfaces, staging,
  onCreatePreset, onRenamePreset, onEditPreset, onDeletePreset, architecture, height = 460,
}) => {
  const doc = useDockDocument();
  const rf = useReactFlow();
  // 自定义节点**量到尺寸之后**才算初始化 —— 在那之前 ReactFlow 不知道每个节点多大，
  // `fitView` 算出来的边界是坏的（这是官方 `fitView` prop 在自定义节点上的经典坑：它只在挂载
  // 那一次跑，而那时尺寸还没量出来）。所以取景要等这一位翻成 true 再补一次。
  const nodesInitialized = useNodesInitialized();
  const krea2 = !!architecture && /krea2/i.test(architecture);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<PipeNodeData>>(toRfNodes(graph));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toRfEdges(graph));
  // 黑板（Preprocess 卡片）：不是画布节点，但**是图里的一个节点**（id 固定 board）——
  // 出图时由 boardRef 补回去，所以它得跟着图一起被改写、被持久化。注意：**面板自己的
  // 位置不在这棵树里**（那是屏幕坐标 UI 状态，见 boardPos）。
  const [board, setBoard] = useState<GraphNode>(() => boardOf(graph));
  const boardRef = useRef<GraphNode>(board);
  // 黑板面板的**屏幕坐标**（画布容器内的像素）：不随图存、不吃视口 transform —— 用户
  // 平移/缩放节点图时它原地不动，本身是一张可单独拖拽的悬浮面板。null = 还没落位
  // （先以右上角待命，用户一拖就固定成坐标）。
  const [boardPos, setBoardPos] = useState<{ x: number; y: number } | null>(null);
  const boardPosRef = useRef(boardPos); boardPosRef.current = boardPos;
  const enableMask = board.params?.enable_mask !== false;
  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  const edgesRef = useRef(edges); edgesRef.current = edges;
  const lastSig = useRef<string>(structSig(graph));
  /** 当前这份图的**节点集合**。 */
  const lastIds = useRef<string>(graph.nodes.map(n => n.id).join(','));
  /** 已经**取过景**的节点集合 —— 与 lastIds 分开，是为了让"取景"只发生在换图/换尺寸时，
   *  用户自己拖动/加节点不会被抢视野。 */
  const fittedIds = useRef<string>('');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(0);

  /**
   * 取景。**容器还没有真实尺寸时一律不取** —— 这是"打开画布只剩一个孤零零的 Start"的正主：
   * dock 窗口刚挂上时高度还是 0（折起 / 还没布局），此时 fitView 算出来的是一张坏视口，
   * 而 ReactFlow 的 `fitView` 只在挂载那一次跑，之后再也不会自己补 —— 于是画布永远停在
   * 原点附近，只有当初落在(0,0)的 Start 在视野里，其余节点全在屏幕外。等尺寸到位再取
   * （ResizeObserver 会叫这一下），这条就堵住了。
   */
  const fitIfNeeded = useCallback(() => {
    const el = wrapRef.current;
    if (!el || el.clientWidth < 40 || el.clientHeight < 40) return;   // 没有真实尺寸：等
    const ids = lastIds.current;
    if (!ids || ids === fittedIds.current) return;                     // 这份图已经取过景
    fittedIds.current = ids;
    rf.fitView({ padding: 0.2 });
  }, [rf]);

  // 外部**结构性**换图（切 tab / 载入 / 别处改参数）才重建内部状态。坐标变化不触发重建 ——
  // 否则拖拽中途父级把图回传，会按旧坐标把节点重置，拖拽就断了。
  useEffect(() => {
    const sig = structSig(graph);
    if (sig !== lastSig.current) {
      setNodes(toRfNodes(graph)); setEdges(toRfEdges(graph)); lastSig.current = sig;
      // 黑板跟着图一起换（切 preset / 载入 / 别处改了开关）。
      const b = boardOf(graph);
      boardRef.current = b; setBoard(b);
      // 节点**集合**变了 = 外部整份换图（切 preset / 载入）→ 该重新取景。不重取景的话，
      // 新图的节点按各自的旧坐标落位，视口还停在上一份图上，看上去就是"图没了/只剩一个节点"。
      const ids = graph.nodes.map(n => n.id).join(',');
      if (ids !== lastIds.current) {
        lastIds.current = ids;
        requestAnimationFrame(fitIfNeeded);
      }
    }
  }, [graph, setNodes, setEdges, fitIfNeeded]);

  // 容器尺寸从"没有"变成"有"（dock 展开 / 窗口调整 / 首次拿到布局）：如果这份图还没取过景，
  // 现在补一次。尺寸没变的话 fitIfNeeded 会自己早退，不会跟用户抢视野。顺带把黑板面板
  // 拉回视野：容器变小后它可能已被裁到外面，用户摆好的位置不动，除非已经看不见。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      fitIfNeeded();
      const cur = boardPosRef.current;
      const card = el.querySelector<HTMLElement>('[data-board-card]');
      if (cur && card) {
        const x = Math.min(cur.x, Math.max(0, el.clientWidth - card.offsetWidth));
        const y = Math.min(cur.y, Math.max(0, el.clientHeight - card.offsetHeight));
        if (x !== cur.x || y !== cur.y) setBoardPos({ x, y });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitIfNeeded]);

  // 节点量完尺寸：这时边界才是真的，补一次取景（否则画布会停在原点附近 —— 只有当初落在
  // (0,0) 的 Start 在视野里，其余节点全在屏幕外，看着就像"图没了"）。
  useEffect(() => {
    if (nodesInitialized) requestAnimationFrame(fitIfNeeded);
  }, [nodesInitialized, fitIfNeeded]);

  const emit = useCallback((rfNodes: Node<PipeNodeData>[], rfEdges: Edge[]) => {
    const g = graphFromRf(rfNodes, rfEdges, boardRef.current);
    lastSig.current = structSig(g);
    const ids = g.nodes.map(n => n.id).join(',');
    // 用户自己挪节点/加节点：算"这份图已经取过景"，别在下一次容器尺寸变化时把视野抢回去。
    lastIds.current = ids;
    fittedIds.current = ids;
    onChange(g);
  }, [onChange]);

  // 黑板改开关 / 挪位置：改的是图里那个 board 节点，然后立刻把整张图发出去。
  const updateBoard = useCallback((key: string, value: any) => {
    const next: GraphNode = { ...boardRef.current, params: { ...boardRef.current.params, [key]: value } };
    boardRef.current = next; setBoard(next);
    // Enable Mask 关 = Start 的 Mask 输出 / End 的 Mask 输入**不存在** → 那两条边当场丢掉
    // （与净化同一条规则：端口不在，线就不在）。再打开时线不会自己回来，得重接。
    const nextEdges = (key === 'enable_mask' && value === false)
      ? edgesRef.current.filter(e => !(
        (e.source === START_ID && String(e.sourceHandle) === 'mask') ||
        (e.target === END_ID && String(e.targetHandle) === 'mask')))
      : edgesRef.current;
    if (nextEdges !== edgesRef.current) setEdges(nextEdges);
    emit(nodesRef.current, nextEdges);
  }, [emit, setEdges]);

  // 挪黑板：现在搬的是**屏幕坐标 UI 状态**（不落图、不触发父级回传、松手也不用 commit ——
  // 位置本来就不随 preset 存盘）。拖动全程只动这一个 state，重渲染成本极低。

  const handleNodesChange = useCallback((changes: NodeChange<Node<PipeNodeData>>[]) => {
    // Start / End 是必需的端点，不允许删掉：把针对它们的 remove 变更拦掉。
    const guarded = changes.filter(c => !(c.type === 'remove' && (c.id === START_ID || c.id === END_ID)));
    const removed = new Set(guarded.filter(c => c.type === 'remove').map(c => (c as any).id));
    if (removed.size) setEdges(prevE => prevE.filter(e => !removed.has(e.source) && !removed.has(e.target)));
    onNodesChange(guarded);
  }, [onNodesChange, setEdges]);

  const handleEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
    onEdgesChange(changes);
  }, [onEdgesChange]);

  // 结构性变化（连线 / 参数 / 增删节点）落回图；**位置不在这里发** —— 位置只由
  // onNodeDragStop 收尾时发一次。Switch 改分枝数会让端口消失，先剪掉两端端口已不存在的边。
  useEffect(() => {
    const valid = edges.filter(e => {
      const s = nodes.find(n => n.id === e.source);
      const t = nodes.find(n => n.id === e.target);
      if (!s || !t) return false;
      const okS = nodePorts({ kind: s.data.kind, params: s.data.params }, enableMask).outputs.some(p => p.id === e.sourceHandle);
      const okT = nodePorts({ kind: t.data.kind, params: t.data.params }, enableMask).inputs.some(p => p.id === e.targetHandle);
      return okS && okT;
    });
    // 剪掉悬空边后**照旧往下走 emit** —— 不能 early return：同一帧里用户删的那条边也要通知父级，
    // 否则父级的图还留着它，稍后一次重渲染就会把删掉的边同步回来（"删不掉"）。
    if (valid.length !== edges.length) setEdges(valid);
    const g = graphFromRf(nodes, valid, boardRef.current);
    if (structSig(g) !== lastSig.current) emit(nodes, valid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, enableMask]);

  // 拖拽收尾：把当前坐标（连带全部结构）发一次。
  const handleNodeDragStop = useCallback(() => {
    emit(nodes, edges);
  }, [emit, nodes, edges]);

  const api = useMemo<GraphEditApi>(() => ({
    updateParam: (nodeId, key, value) => {
      setNodes(prev => prev.map(n =>
        n.id === nodeId ? { ...n, data: { ...n.data, params: { ...n.data.params, [key]: value } } } : n));
    },
    renameNode: (nodeId, name) => {
      setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, data: { ...n.data, name } } : n));
    },
    presets, interfaces, staging, onCreatePreset, onRenamePreset, onEditPreset, onDeletePreset, krea2,
    board: board.params || {}, updateBoard, enableMask,
  }), [presets, interfaces, staging, onCreatePreset, onRenamePreset, onEditPreset, onDeletePreset, setNodes,
       krea2, board, updateBoard, enableMask]);

  // 连线合法性查的是**内部实时 nodes**（不是外部的 graph prop —— 那个在 emit 之前是旧快照，
  // 改完端口后立刻连线会被误拒）。
  const kindOfRf = useCallback((nodeId: string, dir: 'in' | 'out', portId: string): PortKind | undefined => {
    const n = nodes.find(x => x.id === nodeId);
    return n ? portKindOfNode({ kind: n.data.kind, params: n.data.params }, dir, portId, enableMask) : undefined;
  }, [nodes, enableMask]);

  const isValidConnection = useCallback((c: Connection | Edge): boolean => {
    const sk = kindOfRf(c.source!, 'out', String(c.sourceHandle));
    const tk = kindOfRf(c.target!, 'in', String(c.targetHandle));
    if (!sk || !tk) return false;
    // 同 kind 可连；任何一端是 any（Switch 的 data）也能连；mask 还能接进 image
    // （执行器把它铺成黑白图）。规则与后端 ports_compatible 逐条一致。
    return portsCompatible(sk, tk);
  }, [kindOfRf]);

  // 新建边：官方 addEdge。id 必须**跨会话也不撞车** —— 迁移的边是 `e-0`、`e-1`（blocksToGraph
  // 的 eid），而本会话的计数器每次刷新都从 0 起，`e-n0`/`e-n1` 会正好撞上**上次会话**存下来的
  // e-n0/e-n1。撞 id 会被 xyflow 当成同一条边：选中/删除/重连全乱（"删不掉 / 删一条剩一条 /
  // 拖一条线丢两条"）。所以 id 里带一枚**本会话随机 token**，计数器只在 token 后递增。
  const edgeToken = useRef(Math.random().toString(36).slice(2, 7));
  const onConnect = useCallback((c: Connection) => {
    const kind = kindOfRf(c.source!, 'out', String(c.sourceHandle)) || 'exec';
    setEdges(els => addEdge({
      ...c, id: `e-n${edgeToken.current}-${seqRef.current++}`,
      interactionWidth: 24,
      style: { stroke: portColor(kind), strokeWidth: 1.6 },
    }, els) as Edge[]);
  }, [kindOfRf, setEdges]);

  // 重连：官方 `reconnectEdge` 工具（保留原 id 与 style）。**失败（松手在空白/非法处）
  // 不删边** —— 官方语义就是"回到原位"；删除靠官方 deleteKeyCode（选中边 + Delete）。
  const onReconnect = useCallback((oldEdge: Edge, conn: Connection) => {
    setEdges(els => reconnectEdge(oldEdge, conn, els));
  }, [setEdges]);

  // 加节点：给了落点就用落点（右键菜单选的那种），否则摆在现有节点右侧。
  const addNodeAt = useCallback((kind: NodeKind, pos?: { x: number; y: number }) => {
    const id = `${kind}-${Date.now().toString(36)}-${seqRef.current++}`;
    let position = pos;
    if (!position) {
      const maxX = nodes.reduce((m, n) => Math.max(m, n.position.x), 0);
      const maxY = nodes.reduce((m, n) => Math.max(m, n.position.y), 0);
      position = { x: maxX + 240, y: maxY + (nodes.length % 2) * 40 };
    }
    setNodes(prev => [...prev, {
      id, type: 'pipe', position,
      data: { kind, name: defaultNameFor(kind), params: defaultParamsFor(kind) },
    }]);
  }, [nodes, setNodes]);

  // 右键：先出一个小菜单（Add Node），点它再弹 modal 选类型；落点 = 右键处。
  const [paneMenu, setPaneMenu] = useState<{ x: number; y: number } | null>(null);
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const onPaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    setPaneMenu({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY });
  }, []);
  useEffect(() => {
    if (!paneMenu) return;
    const close = (e: PointerEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('.pg-menu')) return;
      setPaneMenu(null);
    };
    const win = doc.defaultView ?? window;
    win.addEventListener('pointerdown', close);
    return () => win.removeEventListener('pointerdown', close);
  }, [paneMenu]);

  const issues = useMemo(() => validateGraph(graph), [graph]);
  // 黑板不在这张表里 —— 每张图恒有且只有一块（由净化保证），不需要用户再添一座。
  const addKinds = (Object.keys(NODE_SPECS) as NodeKind[]).filter(k => k !== 'start' && k !== 'end' && k !== 'board');

  const fill = height === 'fill';
  const canvasH: React.CSSProperties = fill
    ? { flex: 1, minHeight: 0 }
    : { height: height as number };

  return (
    <GraphEditCtx.Provider value={api}>
      {/* 深色主题覆盖：官方 Controls / MiniMap 默认是浅色的 —— 不覆盖就是白块（左下角刺眼、缩略图发白）。 */}
      <style>{`
        .pg-flow .react-flow__controls { box-shadow: 0 4px 16px rgba(0,0,0,0.5); border: 0.5px solid rgba(255,255,255,0.12); border-radius: 10px; overflow: hidden; background: rgba(28,28,30,0.92); }
        .pg-flow .react-flow__controls-button { background: rgba(28,28,30,0.92); border: none; border-bottom: 0.5px solid rgba(255,255,255,0.08); width: 30px; height: 30px; }
        .pg-flow .react-flow__controls-button svg { fill: rgba(255,255,255,0.72); max-width: 14px; max-height: 14px; }
        .pg-flow .react-flow__controls-button:hover { background: rgba(58,58,60,0.95); }
        .pg-flow .react-flow__controls-button:last-child { border-bottom: none; }
        .pg-flow .react-flow__minimap { background: rgba(20,20,22,0.88); border: 0.5px solid rgba(255,255,255,0.10); border-radius: 10px; }
        .pg-flow .react-flow__minimap-mask { fill: rgba(0,0,0,0.55); }
        .pg-flow .react-flow__minimap-node { fill: rgba(255,255,255,0.26); stroke: none; }
      `}</style>
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: fill ? 1 : undefined, minHeight: 0, height: fill ? '100%' : undefined }}>
        <div ref={wrapRef} className="pg-flow" style={{
          ...canvasH, overflow: 'hidden',
          // 铺满模式什么都不加；固定高度模式才给一圈边框/圆角
          ...(fill ? {} : { border: '0.5px solid rgba(255,255,255,0.1)', borderRadius: 10 }),
        }}>
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={handleNodesChange} onEdgesChange={handleEdgesChange}
            onNodeDragStop={handleNodeDragStop}
            onPaneContextMenu={onPaneContextMenu}
            onPaneClick={() => setPaneMenu(null)}
            onConnect={onConnect} isValidConnection={isValidConnection}
            onReconnect={onReconnect}
            edgesReconnectable
            reconnectRadius={20}
            defaultEdgeOptions={{ interactionWidth: 24 }}
            deleteKeyCode={['Backspace', 'Delete']}
            fitView fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#333" gap={18} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor="rgba(255,255,255,0.26)" maskColor="rgba(0,0,0,0.55)" />
          </ReactFlow>
          {/* 黑板：悬浮在画布之上的一张**屏幕坐标**面板 —— 不随视口平移/缩放，
              单独拖它自己（不是 xyflow 节点，见 BoardCard） */}
          <BoardCard board={board} enableMask={enableMask} onSet={updateBoard}
            pos={boardPos} onPos={(x, y) => setBoardPos({ x: Math.round(x), y: Math.round(y) })}
            wrapRef={wrapRef} />
        </div>

        {/* 校验提示：**悬浮**在画布左上，不占布局高度、不挡操作（pointerEvents:none） */}
        {issues.length > 0 && (
          <div style={{
            position: 'absolute', left: 10, top: 10, zIndex: 6, maxWidth: 380, pointerEvents: 'none',
            fontSize: 10.5, color: '#ffd60a', background: 'rgba(42,36,0,0.85)',
            border: '0.5px solid rgba(255,214,10,0.35)', borderRadius: 8, padding: '4px 9px',
          }}>
            {/* 显式接线是唯一的数据通路，"哪几根没接"就是唯一的待办清单 —— 截太狠等于把
                待办藏起来，所以放宽到 8 条（再长就折成一行计数）。 */}
            {issues.slice(0, 8).map((it, i) => <div key={i}>• {it.message}</div>)}
            {issues.length > 8 && <div>… 共 {issues.length} 处</div>}
          </div>
        )}
      </div>

      {/* 右键小菜单：只一项 Add Node（点它才弹 modal） */}
      {paneMenu && createPortal(
        <div className="pg-menu" style={{
          position: 'fixed', left: paneMenu.x, top: paneMenu.y, zIndex: 1200,
          background: '#1c1c1e', border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)', overflow: 'hidden', minWidth: 140,
        }}>
          <div
            onClick={() => { setPicker({ x: paneMenu.x, y: paneMenu.y }); }}
            style={{ padding: '7px 14px', fontSize: 11.5, color: 'rgba(255,255,255,0.88)', cursor: 'pointer' }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(10,132,255,0.25)'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
          >Add Node…</div>
        </div>, doc.body)}

      {/* 选类型的 modal */}
      {picker && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 1300, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setPicker(null)}>
          <div style={{ width: 560, maxHeight: '72vh', overflow: 'auto', background: '#1c1c1e', border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: 14, padding: 14, boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.9)', marginBottom: 10 }}>Add Node</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {addKinds.map(k => (
                <button key={k} type="button"
                  onClick={() => { addNodeAt(k, rf.screenToFlowPosition({ x: picker.x, y: picker.y })); setPicker(null); }}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start', textAlign: 'left',
                    padding: '8px 10px', borderRadius: 10, cursor: 'pointer',
                    background: 'rgba(255,255,255,0.04)', border: `0.5px solid ${NODE_SPECS[k].color}55`,
                    color: 'rgba(255,255,255,0.88)',
                  }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}>
                    <span style={{ width: 7, height: 7, borderRadius: 999, background: NODE_SPECS[k].color }} />{NODE_SPECS[k].label}
                  </span>
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', lineHeight: 1.3 }}>{NODE_SPECS[k].hint}</span>
                </button>
              ))}
            </div>
          </div>
        </div>, doc.body)}
    </GraphEditCtx.Provider>
  );
};

/** 官方 `useReactFlow` 需要 Provider 才有实例 —— 外面包一层再把它交给内容组件。 */
const PipelineGraphEditor: React.FC<PipelineGraphEditorProps> = (props) => (
  <ReactFlowProvider>
    <PipelineGraphEditorInner {...props} />
  </ReactFlowProvider>
);

export default PipelineGraphEditor;
