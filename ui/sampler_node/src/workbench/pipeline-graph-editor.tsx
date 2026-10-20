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
// 端口颜色按 kind 分：exec 灰 / image 绿 / mask 青 / *_info 紫。连线只有同 kind 能连。

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position,
  useNodesState, useEdgesState, addEdge, reconnectEdge, useReactFlow,
  type Node, type Edge, type NodeProps, type Connection, type NodeChange, type EdgeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  NODE_SPECS, portKindOfNode, nodePorts, validateGraph, defaultParamsFor, defaultNameFor, PARAM_FIELDS,
  START_ID, END_ID,
  type PipelineGraph, type NodeKind, type PortKind, type PortSpec, type ParamField,
} from './pipeline-graph';

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

const toRfNodes = (g: PipelineGraph): Node<PipeNodeData>[] =>
  g.nodes.map(n => ({
    id: n.id, type: 'pipe',
    position: { x: n.x ?? 0, y: n.y ?? 0 },
    data: { kind: n.kind, name: n.name, params: n.params || {} },
  }));

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
  return n ? portKindOfNode(n, 'out', portId) : undefined;
};

/** **结构性**指纹：节点 id/kind/name/params + 边。**不含坐标** —— 拖拽时坐标每帧都在变，
 *  若把坐标算进来，父级把图回传时会把内部节点按旧坐标重置，拖拽就被打断。 */
const structSig = (g: PipelineGraph): string =>
  g.nodes.map(n => `${n.id},${n.kind},${n.name},${JSON.stringify(n.params || {})}`).join('|')
  + '#' + g.edges.map(e => `${e.source}:${e.sourcePort}>${e.target}:${e.targetPort}`).join('|');

/** xyflow 的 nodes/edges → 我们的图模型。 */
const graphFromRf = (rfNodes: Node<PipeNodeData>[], rfEdges: Edge[]): PipelineGraph => ({
  nodes: rfNodes.map(n => ({
    id: n.id, kind: n.data.kind, name: n.data.name,
    x: Math.round(n.position.x), y: Math.round(n.position.y),
    params: n.data.params || {},
  })),
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
  presets?: { id: string; name: string }[];
  interfaces?: { name: string }[];
  onCreatePreset?: () => Promise<string | null>;
  onRenamePreset?: (id: string, name: string) => void;
  onEditPreset?: (id: string) => void;
  onDeletePreset?: (id: string) => void;
}

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

/** interface 节点的内联选择：写 interface_idx（名字由 App 侧的一次性迁移补齐）。 */
const InlineInterfacePicker: React.FC<{ nodeId: string; value: number | undefined }> = ({ nodeId, value }) => {
  const api = useContext(GraphEditCtx);
  if (!api) return null;
  if (!api.interfaces) return <div style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.4)' }}>idx: {String(value ?? 0)}</div>;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
      <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.55)' }}>Interface</span>
      <select className="nodrag" value={String(value ?? 0)} onChange={e => api.updateParam(nodeId, 'interface_idx', Number(e.target.value))}
        style={{ ...ctrlStyle, width: 130 }}>
        {api.interfaces.length === 0
          ? <option value="0">— none —</option>
          : api.interfaces.map((it, i) => <option key={i} value={i} style={{ background: '#1c1c1e' }}>{it.name}</option>)}
      </select>
    </div>
  );
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

const PipeNode: React.FC<NodeProps<Node<PipeNodeData>>> = ({ id, data, selected }) => {
  const api = useContext(GraphEditCtx);
  const spec = NODE_SPECS[data.kind];
  if (!spec) return <div style={{ color: '#ff6961', fontSize: 11 }}>未知: {String(data.kind)}</div>;
  const ports = nodePorts({ kind: data.kind, params: data.params });
  const fields = (PARAM_FIELDS[data.kind] || []).filter(f => !f.when || f.when(data.params));
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
          {data.kind === 'interface' && <InlineInterfacePicker nodeId={id} value={data.params.interface_idx} />}
          {fields.map(f => (
            <InlineField key={f.key} field={f} value={data.params[f.key]} onSet={v => setParam(f.key, v)} />
          ))}
          {fields.length === 0 && data.kind !== 'prompt' && data.kind !== 'interface' && data.kind !== 'switch' && (
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
  interfaces?: { name: string }[];
  onCreatePreset?: () => Promise<string | null>;
  onRenamePreset?: (id: string, name: string) => void;
  onEditPreset?: (id: string) => void;
  onDeletePreset?: (id: string) => void;
  /** 'fill' = 铺满父容器（父级要给它确定高度）；number = 固定像素高。 */
  height?: number | 'fill';
}

const PipelineGraphEditorInner: React.FC<PipelineGraphEditorProps> = ({
  graph, onChange, presets, interfaces,
  onCreatePreset, onRenamePreset, onEditPreset, onDeletePreset, height = 460,
}) => {
  const rf = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<PipeNodeData>>(toRfNodes(graph));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toRfEdges(graph));
  const lastSig = useRef<string>(structSig(graph));
  const seqRef = useRef(0);

  // 外部**结构性**换图（切 tab / 载入 / 别处改参数）才重建内部状态。坐标变化不触发重建 ——
  // 否则拖拽中途父级把图回传，会按旧坐标把节点重置，拖拽就断了。
  useEffect(() => {
    const sig = structSig(graph);
    if (sig !== lastSig.current) {
      setNodes(toRfNodes(graph)); setEdges(toRfEdges(graph)); lastSig.current = sig;
    }
  }, [graph, setNodes, setEdges]);

  const emit = useCallback((rfNodes: Node<PipeNodeData>[], rfEdges: Edge[]) => {
    const g = graphFromRf(rfNodes, rfEdges);
    lastSig.current = structSig(g);
    onChange(g);
  }, [onChange]);

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
      const okS = nodePorts({ kind: s.data.kind, params: s.data.params }).outputs.some(p => p.id === e.sourceHandle);
      const okT = nodePorts({ kind: t.data.kind, params: t.data.params }).inputs.some(p => p.id === e.targetHandle);
      return okS && okT;
    });
    // 剪掉悬空边后**照旧往下走 emit** —— 不能 early return：同一帧里用户删的那条边也要通知父级，
    // 否则父级的图还留着它，稍后一次重渲染就会把删掉的边同步回来（"删不掉"）。
    if (valid.length !== edges.length) setEdges(valid);
    const g = graphFromRf(nodes, valid);
    if (structSig(g) !== lastSig.current) emit(nodes, valid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

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
    presets, interfaces, onCreatePreset, onRenamePreset, onEditPreset, onDeletePreset,
  }), [presets, interfaces, onCreatePreset, onRenamePreset, onEditPreset, onDeletePreset, setNodes]);

  const isValidConnection = useCallback((c: Connection | Edge): boolean => {
    const sk = portKindOfKind(graph, c.source!, String(c.sourceHandle));
    const tgt = graph.nodes.find(n => n.id === c.target);
    const tk = tgt ? portKindOfNode(tgt, 'in', String(c.targetHandle)) : undefined;
    if (!sk || !tk) return false;
    // 同 kind 可连；任何一端是 any（Switch 的 data）也能连。
    return sk === tk || sk === 'any' || tk === 'any';
  }, [graph]);

  // 新建边：官方 addEdge。id 必须**与迁移生成的不撞车** —— 迁移的边 id 形如 `e-0`、`e-1`
  // （blocksToGraph 的 eid），所以这里用 `e-n<n>` 前缀；撞 id 会让 xyflow 把它们并成一条，
  // 表现就是"删不掉 / 删一条剩一条"。
  const onConnect = useCallback((c: Connection) => {
    const kind = portKindOfKind(graph, c.source!, String(c.sourceHandle)) || 'exec';
    setEdges(els => addEdge({
      ...c, id: `e-n${seqRef.current++}`,
      interactionWidth: 24,
      style: { stroke: portColor(kind), strokeWidth: 1.6 },
    }, els) as Edge[]);
  }, [graph, setEdges]);

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
  const addNode = useCallback((kind: NodeKind) => addNodeAt(kind), [addNodeAt]);

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
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [paneMenu]);

  const issues = useMemo(() => validateGraph(graph), [graph]);
  const addKinds = (Object.keys(NODE_SPECS) as NodeKind[]).filter(k => k !== 'start' && k !== 'end');

  const fill = height === 'fill';
  const canvasH: React.CSSProperties = fill
    ? { flex: 1, minHeight: 360 }
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: fill ? 1 : undefined, minHeight: 0, height: fill ? '100%' : undefined }}>
        <div className="nodrag" style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
          <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.5)' }}>Add:</span>
          {addKinds.map(k => (
            <button key={k} type="button" title={NODE_SPECS[k].hint} onClick={() => addNode(k)}
              style={{
                fontSize: 10, padding: '2px 7px', borderRadius: 999, cursor: 'pointer',
                background: `${NODE_SPECS[k].color}22`, color: 'rgba(255,255,255,0.85)',
                border: `0.5px solid ${NODE_SPECS[k].color}66`,
              }}>{NODE_SPECS[k].label}</button>
          ))}
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>· 画布上右键也可加</span>
        </div>

        {issues.length > 0 && (
          <div style={{
            fontSize: 10.5, color: '#ffd60a', background: 'rgba(255,214,10,0.08)',
            border: '0.5px solid rgba(255,214,10,0.3)', borderRadius: 8, padding: '4px 9px',
          }}>
            {issues.slice(0, 3).map((it, i) => <div key={i}>• {it.message}</div>)}
            {issues.length > 3 && <div>… 共 {issues.length} 处</div>}
          </div>
        )}

        <div className="pg-flow" style={{ ...canvasH, borderRadius: 10, overflow: 'hidden', border: '0.5px solid rgba(255,255,255,0.1)' }}>
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
        </div>
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
        </div>, document.body)}

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
        </div>, document.body)}
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
