// Pipeline Blocks —— 图模型（xyflow 版）
//
// 旧模型是一条**线性数组**（PipelineBlock[]），链上的"成对几何操作"（Crop/Recover Crop、
// Scale/Recover Scale、Limit/Recover Limit、Meet/Recover Meet、Fit/Recover Fit）靠后端一条
// **隐式帧栈**配对 —— 「Recover 恢复栈顶那一帧」。这在图里站不住：图可以分支、可以夹别的
// 节点，隐式栈会错配。
//
// 新模型把一条链摊成一张有向图：
//   · **Execute** 端口定义触发顺序（数据流/激活流）—— 谁先谁后、以及"这一趟走哪条分支"
//     只由它决定。detect 有两条 exec 输出（命中/未命中），运行时按检测结果二选一；
//   · **Image / Mask** 端口是**显式数据边**，必须连线（不再有"沿链隐式流转"）；
//   · **Info** 端口按操作类型强命名：crop_info / scale_info / limit_info / meet_info /
//     fit_info。几何操作输出自己那一份，Recover 只接受对应类型的 Info——类型不匹配直接
//     连不上/校验报错。彻底取代"统称 Frame + 按 kind 猜"；
//   · 一条链有且只有一个 **Start**（出 Image/Mask/Execute）和一个 **End**（入
//     Image/Mask/Execute）。
//
// 这个文件是**唯一的真源**：节点 kind 表（端口 + 默认参数 + 配色）都在这里，编辑器与
// 迁移函数共用。后端有一份镜像（nodes/workbench/pipeline_graph.py），迁移/校验规则必须
// 与这里逐条一致。

import type { PipelineBlock, PipelineBlockKind } from '../types';

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

/** 端口种类。exec = 触发/分支；image / mask = 显式数据流；*_info = 几何操作的成对凭据；
 *  any = 无类型数据（Switch 节点的 data 端口，可接任意数据、也能接到任意类型输入）。 */
export type PortKind =
  | 'exec' | 'image' | 'mask' | 'any'
  | 'crop_info' | 'scale_info' | 'limit_info' | 'meet_info' | 'fit_info';

/** 一个端口。`id` 是节点内的唯一标识（同一种 kind 可以出现多个：detect 有两条 exec），
 *  `kind` 决定它能和谁相连。连线两端存的是 **id**。 */
export interface PortSpec {
  id: string;
  kind: PortKind;
  /** 画在 handle 旁的小字 */
  label: string;
}

const P = (id: string, kind: PortKind, label: string): PortSpec => ({ id, kind, label });

const EXEC = P('exec', 'exec', 'Execute');
/** detect 的两条 exec 输出：命中（有 mask）/ 未命中（无 mask），运行时二选一。 */
const EXEC_YES = P('exec_yes', 'exec', 'Has Mask');
const EXEC_NO = P('exec_no', 'exec', 'No Mask');
const IMAGE = P('image', 'image', 'Image');
const MASK = P('mask', 'mask', 'Mask');
const CROP_INFO = P('crop_info', 'crop_info', 'Crop Info');
const SCALE_INFO = P('scale_info', 'scale_info', 'Scale Info');
const LIMIT_INFO = P('limit_info', 'limit_info', 'Limit Info');
const MEET_INFO = P('meet_info', 'meet_info', 'Meet Info');
const FIT_INFO = P('fit_info', 'fit_info', 'Fit Info');

/** 几何操作 kind → 它输出的 Info 端口。 */
export const OP_INFO_PORT: Record<string, PortSpec> = {
  crop: CROP_INFO, scale: SCALE_INFO, limit: LIMIT_INFO, meet: MEET_INFO, fit: FIT_INFO,
};
/** Recover kind → 它需要的 Info kind（强类型：只接受这一种）。 */
export const RECOVER_INFO_KIND: Partial<Record<PipelineBlockKind, PortKind>> = {
  recover_crop: 'crop_info',
  recover_scale: 'scale_info',
  recover_limit: 'limit_info',
  recover_meet: 'meet_info',
  recover_fit: 'fit_info',
};

/** 图里的节点 kind：两个端点 + Switch + 全部 block 类型。 */
export type NodeKind = 'start' | 'end' | 'switch' | PipelineBlockKind;

export interface NodeSpec {
  label: string;
  color: string;
  hint: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
}

// 每个 kind 的端口表。约定：
//   · 会改动/传递图像的节点都有 image 进/出；prompt/query/tagger/detect 不产图 ——
//     tagger/detect **只消费 image、不输出 image**（下游要图就从更上游的画一条边过去）。
//   · prompt/query 是纯上下文副作用，只有 Execute。
//   · 几何操作输出各自类型的 Info；Recover 消费对应类型的 Info。
export const NODE_SPECS: Record<NodeKind, NodeSpec> = {
  start: {
    label: 'Start', color: '#30d158',
    hint: '链的入口 —— 交出 Blend 画布合成图与 Mask 层，并从这里开始执行。',
    inputs: [],
    outputs: [IMAGE, MASK, EXEC],
  },
  end: {
    label: 'End', color: '#ff453a',
    hint: '链的出口 —— 收下最终的 Image 与 Mask，交给工作台收尾（recover / 落盘）。',
    inputs: [IMAGE, MASK, EXEC],
    outputs: [],
  },
  detailer: {
    label: 'Detailer', color: '#30d158',
    hint: 'Refine the masked region', inputs: [EXEC, IMAGE, MASK],
    outputs: [EXEC, IMAGE],
  },
  interface: {
    label: 'Interface', color: '#bf5af2',
    hint: 'Run an interface sub-graph inside the chain', inputs: [EXEC, IMAGE, MASK],
    outputs: [EXEC, IMAGE, MASK],
  },
  prompt: {
    label: 'Prompt', color: '#64d2ff',
    hint: 'Inject a shared prompt preset for the nodes after it', inputs: [EXEC],
    outputs: [EXEC],
  },
  query: {
    label: 'Query', color: '#ffd60a',
    hint: 'Stop the run here and ask you for a prompt', inputs: [EXEC],
    outputs: [EXEC],
  },
  tagger: {
    label: 'Tagger', color: '#ff9f0a',
    hint: 'Tag the incoming image and append the tag to the prompt after it',
    inputs: [EXEC, IMAGE], outputs: [EXEC],
  },
  scale: {
    label: 'Scale', color: '#5e5ce6',
    hint: 'Resize the working image by a ratio and snap it to the align grid',
    inputs: [EXEC, IMAGE, MASK], outputs: [EXEC, IMAGE, MASK, SCALE_INFO],
  },
  recover_scale: {
    label: 'Recover Scale', color: '#5e5ce6',
    hint: 'Undo a Scale — connect Scale Info to the Scale being undone',
    inputs: [EXEC, IMAGE, MASK, SCALE_INFO], outputs: [EXEC, IMAGE, MASK],
  },
  limit: {
    label: 'Limit', color: '#8e8e93',
    hint: 'Re-apply the pixel budget mid-chain', inputs: [EXEC, IMAGE, MASK],
    outputs: [EXEC, IMAGE, MASK, LIMIT_INFO],
  },
  recover_limit: {
    label: 'Recover Limit', color: '#8e8e93',
    hint: 'Return to the resolution from before a Limit — connect Limit Info to it',
    inputs: [EXEC, IMAGE, MASK, LIMIT_INFO], outputs: [EXEC, IMAGE, MASK],
  },
  crop: {
    label: 'Crop', color: '#ff375f',
    hint: 'Crop the working area to the Mask bounding box — connect Crop Info to a Recover Crop',
    inputs: [EXEC, IMAGE, MASK], outputs: [EXEC, IMAGE, MASK, CROP_INFO],
  },
  recover_crop: {
    label: 'Recover Crop', color: '#ff375f',
    hint: 'Paste a Crop back into the image it came from — connect Crop Info to it',
    inputs: [EXEC, IMAGE, MASK, CROP_INFO], outputs: [EXEC, IMAGE, MASK],
  },
  meet: {
    label: 'Meet', color: '#0a84ff',
    hint: 'Cover: scale until it fills the target frame, then centre-crop',
    inputs: [EXEC, IMAGE, MASK], outputs: [EXEC, IMAGE, MASK, MEET_INFO],
  },
  recover_meet: {
    label: 'Recover Meet', color: '#0a84ff',
    hint: 'Put a Meet back — connect Meet Info to it',
    inputs: [EXEC, IMAGE, MASK, MEET_INFO], outputs: [EXEC, IMAGE, MASK],
  },
  fit: {
    label: 'Fit', color: '#64d2ff',
    hint: 'Contain: scale until it fits the target frame, then pad',
    inputs: [EXEC, IMAGE, MASK], outputs: [EXEC, IMAGE, MASK, FIT_INFO],
  },
  recover_fit: {
    label: 'Recover Fit', color: '#64d2ff',
    hint: 'Take a Fit back — connect Fit Info to it',
    inputs: [EXEC, IMAGE, MASK, FIT_INFO], outputs: [EXEC, IMAGE, MASK],
  },
  detect: {
    label: 'Detect', color: '#ffd60a',
    hint: 'Detect on the incoming image. Two exec outs: Has Mask (hit) / No Mask (miss) — only one runs.',
    inputs: [EXEC, IMAGE], outputs: [EXEC_YES, EXEC_NO, MASK],
  },
  // Switch（倒过来的 switch / gather）：**输入多头、输出单头**。每条输入分枝 = 一个 exec +
  // 它下面任意数量的 data（无类型）；输出 = 1 个 exec + N 个 data，N = 各分枝 data 数的最大值。
  // 端口是**动态的**（随 params.branches 变），所以这里只放标签/配色，端口由 switchPorts() 现算。
  switch: {
    label: 'Switch', color: '#ff9f0a',
    hint: 'Gather: many exec heads (each with its own untyped data), merge index-wise into one exec + N data',
    inputs: [], outputs: [],
  },
};

/** Switch 节点的端口 id 约定（前后端镜像必须一致）：
 *   输入 exec：`ei:{b}`          —— 第 b 条分枝的 exec 头
 *   输入 data：`di:{b}:{j}`      —— 第 b 条分枝下第 j 个 data
 *   输出 exec：`eo`
 *   输出 data：`do:{i}`          —— 第 i 个汇聚后的 data（i ∈ [0, N)） */
export const SW_EXEC_IN = (b: number) => `ei:${b}`;
export const SW_DATA_IN = (b: number, j: number) => `di:${b}:${j}`;
export const SW_EXEC_OUT = 'eo';
export const SW_DATA_OUT = (i: number) => `do:${i}`;

export interface SwitchBranch { data: number; }
export interface SwitchParams { branches: SwitchBranch[]; }

/** N = 各分枝 data 数的最大值（0 分枝时 N=0）。 */
export function switchN(params: Record<string, any>): number {
  const branches = (params?.branches as SwitchBranch[]) || [];
  return branches.reduce((m, br) => Math.max(m, Math.max(0, Number(br?.data) || 0)), 0);
}

/** 现算一个节点的端口表：Switch 动态，其余取静态 NODE_SPECS。 */
export function nodePorts(node: Pick<GraphNode, 'kind' | 'params'>): { inputs: PortSpec[]; outputs: PortSpec[] } {
  if (node.kind === 'switch') {
    const branches = (node.params?.branches as SwitchBranch[]) || [];
    const inputs: PortSpec[] = [];
    branches.forEach((br, b) => {
      inputs.push({ id: SW_EXEC_IN(b), kind: 'exec', label: b === 0 ? 'Execute' : `Exec ${b + 1}` });
      const n = Math.max(0, Number(br?.data) || 0);
      for (let j = 0; j < n; j++) inputs.push({ id: SW_DATA_IN(b, j), kind: 'any', label: `Data ${j + 1}` });
    });
    const outputs: PortSpec[] = [{ id: SW_EXEC_OUT, kind: 'exec', label: 'Execute' }];
    const N = switchN(node.params || {});
    for (let i = 0; i < N; i++) outputs.push({ id: SW_DATA_OUT(i), kind: 'any', label: `Data ${i + 1}` });
    return { inputs, outputs };
  }
  const spec = NODE_SPECS[node.kind];
  return { inputs: spec?.inputs || [], outputs: spec?.outputs || [] };
}

/** 节点级端口 kind 查询（Switch 也能正确解析）。 */
export function portKindOfNode(node: Pick<GraphNode, 'kind' | 'params'>, dir: 'in' | 'out', portId: string): PortKind | undefined {
  const { inputs, outputs } = nodePorts(node);
  return (dir === 'in' ? inputs : outputs).find(p => p.id === portId)?.kind;
}

/** 几何操作节点：带对应类型的 Info 输出，可与 Recover 配对。 */
export const OP_KINDS = ['crop', 'scale', 'limit', 'meet', 'fit'] as const;

/** 沿旧线性链继续时默认接哪条 exec 输出（detect 走"命中"，旧链不分支）。 */
export function primaryExecOut(kind: NodeKind): string {
  if (kind === 'detect') return EXEC_YES.id;
  if (kind === 'switch') return SW_EXEC_OUT;
  return EXEC.id;
}

// ---------------------------------------------------------------------------
// 图的数据结构
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  /** 节点在画布上的位置 */
  x: number;
  y: number;
  params: Record<string, any>;
  /** interface 节点专用（与旧 PipelineBlock.interface_index 同义） */
  interface_index?: number;
  exec_options?: Record<string, any>;
}

/** 一条边。两端的 `sourcePort`/`targetPort` 都是**端口 id**（见 NodeSpec）。 */
export interface GraphEdge {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
}

export interface PipelineGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const START_ID = 'start';
export const END_ID = 'end';

/** 查一个**静态**节点类型某端口的 kind（Switch 请用 portKindOfNode）。 */
export function portKindOf(kind: NodeKind, dir: 'in' | 'out', portId: string): PortKind | undefined {
  const spec = NODE_SPECS[kind];
  if (!spec) return undefined;
  const list = dir === 'in' ? spec.inputs : spec.outputs;
  return list.find(p => p.id === portId)?.kind;
}

// ---------------------------------------------------------------------------
// 默认参数（与 App.tsx handleAddBlock 逐条同源）
// ---------------------------------------------------------------------------

export function defaultParamsFor(kind: NodeKind): Record<string, any> {
  switch (kind) {
    case 'detailer': return {
      add_noise: 'enable', start_step_rate: 0.8, end_step_rate: 1.0,
      pixels: 1048576, align: 8, crop_reserve: 32, recover_crop: true,
      enable_edit: false, edit_mode: 'fit', ref_boost: 4.0, ref_boost_a: 1.0,
      enable_ref_boost_mask: false, grounding_px: 768, context_regex: '.+',
    };
    case 'interface': return {
      interface_idx: 0, operation: 'default', crop_reserve: 32, image_keys: {},
      context_image_key: null, context_mask_key: null, manual_values: {},
    };
    case 'prompt': return { preset_id: null };
    case 'query': return {};
    case 'tagger': return { mode: 'mask' };
    case 'scale': return { scale: 1.0, align: 8, use_pipeline_align: true };
    case 'crop': return { reserve: 0, use_pipeline_reserve: true };
    case 'meet': return { width: 0, height: 0, interpolation: 'bilinear' };
    case 'fit': return { width: 0, height: 0, interpolation: 'bilinear', padding_color: '255, 255, 255' };
    case 'recover_meet': return { interpolation: 'bilinear', use_background: true, padding_color: '255, 255, 255' };
    case 'recover_fit':
    case 'recover_scale': return { interpolation: 'bilinear' };
    case 'recover_crop': return { recover_method: 'mask_blend' };
    case 'recover_limit': return {};
    case 'limit': return { pixels: 0, align: 0, cap_only: false };
    case 'detect': return { prompt: '', threshold: 0.5, invert: false };
    case 'switch': return { branches: [{ data: 1 }] };
    default: return {};
  }
}

/** 新节点默认名（Start/End 之外的 kind 用 spec.label）。 */
export function defaultNameFor(kind: NodeKind): string {
  return NODE_SPECS[kind].label;
}

// ---------------------------------------------------------------------------
// 迁移：旧 blocks[] → PipelineGraph
// ---------------------------------------------------------------------------

const GAP_X = 300;

/**
 * 把旧线性 block 数组迁移成图。规则与后端 `blocks_to_graph` 必须一致：
 *   1. 建 Start / End 两端 + 每个 block 一个节点（沿 X 轴等距排布）；
 *   2. **Execute**：Start → b0 → b1 → … → End。旧链不分支，遇到 detect 时它两条
 *      exec 输出（命中 / 未命中）**都**接到下一颗 —— 迁移出的图因此不带分支约束，
 *      行为与旧链一字不差。
 *   3. **Image / Mask**：从上游最近的"提供该数据的节点"显式连线。prompt/query 没有
 *      数据端口、tagger/detect **只消费不产出** image，都会被跳过（数据源不变）。
 *      detect 产出 mask，成为新的 mask 源。
 *   4. **Info**：按旧后端的"栈顶配对"语义给 Recover 自动接线 —— 遇到几何操作压栈，
 *      遇到 Recover 弹"最近一个同类操作"并连一条对应类型的 Info 边。找不到同类时留空
 *      （后端有链首隐式帧的兜底，例如 Recover Limit 吃链首 limit）。
 */
export function blocksToGraph(blocks: PipelineBlock[]): PipelineGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const byId = new Map<string, GraphNode>();

  nodes.push({ id: START_ID, kind: 'start', name: 'Start', x: 0, y: 0, params: {} });
  byId.set(START_ID, nodes[0]);

  let imageSrc = START_ID;
  let maskSrc = START_ID;
  const openFrames: string[] = [];
  let seq = 0;
  const eid = () => `e-${seq++}`;

  let prevExec: { node: string; port: string; kind: NodeKind } = { node: START_ID, port: EXEC.id, kind: 'start' };
  blocks.forEach((b, i) => {
    const kind = b.type as NodeKind;
    const spec = NODE_SPECS[kind];
    if (!spec) return; // 未知 kind：跳过
    const id = b.id || `block-${i + 1}`;
    const node: GraphNode = {
      id, kind, name: b.name || spec.label,
      x: (i + 1) * GAP_X, y: 0, params: { ...(b.params || {}) },
      interface_index: b.interface_index, exec_options: b.exec_options,
    };
    nodes.push(node); byId.set(id, node);

    // Execute：从上一颗的 exec 输出进来。detect 例外 —— 旧链不分支，两条分支
    // （命中 / 未命中）都继续走到下一颗，所以下游节点接**两条** exec 边；这样迁移出的
    // 图不带任何分支约束，行为与旧链一字不差。用户想按命中分流时，删掉其中一条即可。
    const fromPrev: string[] = prevExec.kind === 'detect'
      ? [EXEC_YES.id, EXEC_NO.id]
      : [prevExec.port];
    for (const _p of fromPrev) {
      edges.push({ id: eid(), source: prevExec.node, sourcePort: _p, target: id, targetPort: EXEC.id });
    }
    prevExec = { node: id, kind, port: primaryExecOut(kind) };

    const has = (dir: 'in' | 'out', k: PortKind) =>
      (dir === 'in' ? spec.inputs : spec.outputs).some(p => p.kind === k);

    // Image / Mask 数据边（只消费不产出的节点，数据源不更新 —— 下游自动接到更上游）
    if (has('in', 'image')) {
      edges.push({ id: eid(), source: imageSrc, sourcePort: 'image', target: id, targetPort: 'image' });
    }
    if (has('out', 'image')) imageSrc = id;
    if (has('in', 'mask')) {
      edges.push({ id: eid(), source: maskSrc, sourcePort: 'mask', target: id, targetPort: 'mask' });
    }
    if (has('out', 'mask')) maskSrc = id;

    // Info 配对
    if (has('out', 'crop_info') || has('out', 'scale_info') || has('out', 'limit_info')
        || has('out', 'meet_info') || has('out', 'fit_info')) {
      openFrames.push(id);
    }
    const wantInfo = RECOVER_INFO_KIND[b.type];
    if (wantInfo) {
      for (let j = openFrames.length - 1; j >= 0; j--) {
        const cand = byId.get(openFrames[j]);
        if (cand && portKindOf(cand.kind, 'out', wantInfo) === wantInfo) {
          edges.push({ id: eid(), source: cand.id, sourcePort: wantInfo, target: id, targetPort: wantInfo });
          openFrames.splice(j, 1);
          break;
        }
      }
    }
  });

  // End
  const endNode: GraphNode = { id: END_ID, kind: 'end', name: 'End', x: (blocks.length + 1) * GAP_X, y: 0, params: {} };
  nodes.push(endNode); byId.set(END_ID, endNode);
  const endExecPorts: string[] = prevExec.kind === 'detect' ? [EXEC_YES.id, EXEC_NO.id] : [prevExec.port];
  for (const _p of endExecPorts) {
    edges.push({ id: eid(), source: prevExec.node, sourcePort: _p, target: END_ID, targetPort: EXEC.id });
  }
  edges.push({ id: eid(), source: imageSrc, sourcePort: 'image', target: END_ID, targetPort: 'image' });
  edges.push({ id: eid(), source: maskSrc, sourcePort: 'mask', target: END_ID, targetPort: 'mask' });

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// 执行顺序（Execute 边上的拓扑排序；分支图同样成立）
// ---------------------------------------------------------------------------

/**
 * 沿 Execute 边做拓扑排序，返回"从 Start 可达"的执行顺序。
 * 线性链退化成 Start → b0 → b1 → … → End；分支图按 Kahn 算法给出一个合法顺序
 * （detect 的两条分支都在，运行时再决定走哪条）。
 */
export function execOrder(graph: PipelineGraph): string[] {
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const children = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of graph.nodes) { children.set(n.id, []); indeg.set(n.id, 0); }
  for (const e of graph.edges) {
    const sN = nodes.get(e.source); const tN = nodes.get(e.target);
    if (!sN || !tN) continue;
    const sk = portKindOfNode(sN, 'out', e.sourcePort);
    const tk = portKindOfNode(tN, 'in', e.targetPort);
    if (sk !== 'exec' || tk !== 'exec') continue;
    children.get(e.source)!.push(e.target);
    indeg.set(e.target, (indeg.get(e.target) || 0) + 1);
  }
  const order: string[] = [];
  const ready: string[] = [];
  for (const [id, d] of indeg) if (d === 0) ready.push(id);
  const seen = new Set<string>();
  while (ready.length) {
    // 稳定顺序：优先取画布靠左（x 小）的节点，保证线性链的顺序可预期
    ready.sort((a, b) => (nodes.get(a)!.x - nodes.get(b)!.x) || (nodes.get(a)!.y - nodes.get(b)!.y));
    const id = ready.shift()!;
    if (seen.has(id)) continue;
    seen.add(id); order.push(id);
    for (const c of children.get(id) || []) {
      indeg.set(c, (indeg.get(c) || 0) - 1);
      if ((indeg.get(c) || 0) === 0) ready.push(c);
    }
  }
  return order;
}

/** 把图投影回旧的参数数组（只保留 block 节点，按 Execute 拓扑顺序）。分支信息会丢失 ——
 *  仅用于过渡期（给旧后端 / 摘要）。 */
export function graphToBlocks(graph: PipelineGraph): PipelineBlock[] {
  const order = execOrder(graph);
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const out: PipelineBlock[] = [];
  for (const id of order) {
    const n = byId.get(id);
    if (!n || n.kind === 'start' || n.kind === 'end' || n.kind === 'switch') continue;
    out.push({
      id: n.id, type: n.kind as PipelineBlockKind, name: n.name,
      params: n.params as any, interface_index: n.interface_index, exec_options: n.exec_options as any,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export interface GraphIssue { nodeId: string; port?: string; message: string; }

/** 校验图的接线：必需端口已连、Execute 无环、Info 类型匹配、detect 至少接一条分支。 */
export function validateGraph(graph: PipelineGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  if (!byId.has(START_ID)) issues.push({ nodeId: START_ID, message: '缺少 Start 节点' });
  if (!byId.has(END_ID)) issues.push({ nodeId: END_ID, message: '缺少 End 节点' });

  const connectedIn = new Set<string>();   // `${node}:${portId}`
  for (const e of graph.edges) connectedIn.add(`${e.target}:${e.targetPort}`);

  for (const n of graph.nodes) {
    const spec = NODE_SPECS[n.kind];
    if (!spec) { issues.push({ nodeId: n.id, message: `未知节点类型 ${n.kind}` }); continue; }

    // Switch：动态端口 —— 不逐端口要求"全连"，只要求至少一条 exec 头接了线
    if (n.kind === 'switch') {
      const anyExecIn = graph.edges.some(e => e.target === n.id && portKindOfNode(n, 'in', e.targetPort) === 'exec');
      if (!anyExecIn) issues.push({ nodeId: n.id, port: 'ei:0', message: `${n.name} 至少要让一条 Exec 头接上线` });
      const outExec = graph.edges.some(e => e.source === n.id && e.sourcePort === SW_EXEC_OUT);
      if (!outExec) issues.push({ nodeId: n.id, port: SW_EXEC_OUT, message: `${n.name} 的 Execute 输出未连接` });
      continue;
    }

    // 逐端口的"未连接"合并成**一条**：接线是可编辑的中间态，拆成 N 行只会刷屏。
    const missing = spec.inputs.filter(port => !connectedIn.has(`${n.id}:${port.id}`));
    if (missing.length) {
      issues.push({
        nodeId: n.id, port: missing[0].id,
        message: `${n.name} 有 ${missing.length} 个输入端口未连接：${missing.map(p => p.label).join(' / ')}`,
      });
    }
    // 强类型 Info：Recover 只接受对应类型
    const wantKind = RECOVER_INFO_KIND[n.kind as PipelineBlockKind];
    if (wantKind) {
      const ie = graph.edges.find(e => e.target === n.id && e.targetPort === wantKind);
      if (ie) {
        const src = byId.get(ie.source);
        if (!src || portKindOfNode(src, 'out', ie.sourcePort) !== wantKind) {
          issues.push({ nodeId: n.id, port: wantKind, message: `${n.name} 的 Info 必须来自对应类型（${wantKind}）的几何操作` });
        }
      }
    }
    // detect：两条 exec 输出至少接一条
    if (n.kind === 'detect') {
      const used = graph.edges.some(e => e.source === n.id &&
        (e.sourcePort === 'exec_yes' || e.sourcePort === 'exec_no'));
      if (!used) issues.push({ nodeId: n.id, port: 'exec_yes', message: `${n.name} 的 Has Mask / No Mask 至少接一条` });
    }
  }

  // Execute 环检测：execOrder 是一张覆盖全部节点的 Execute 拓扑排序，
  // 有环时 Kahn 无法把所有节点排完 → 排序长度 < 节点总数。
  if (execOrder(graph).length < graph.nodes.length) {
    issues.push({ nodeId: '', message: 'Execute 连线成环' });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 参数表（给编辑器画通用 inspector —— 免得每种节点各写一坨 JSX）
// ---------------------------------------------------------------------------

export interface ParamField {
  key: string;
  label: string;
  kind: 'number' | 'text' | 'bool' | 'select';
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  title?: string;
  /** 只在该节点满足条件时显示（如 Scale 的 Align 仅在 Use Pipeline Align 关时可见） */
  when?: (params: Record<string, any>) => boolean;
}

const INTERP = [
  { value: 'nearest', label: 'nearest' },
  { value: 'bilinear', label: 'bilinear' },
  { value: 'bicubic', label: 'bicubic' },
];

/** 每种节点在 inspector 里可编辑的字段。prompt / query / interface 走各自专用渲染（见编辑器）。 */
export const PARAM_FIELDS: Partial<Record<NodeKind, ParamField[]>> = {
  detailer: [
    { key: 'add_noise', label: 'Add Noise', kind: 'select', options: [{ value: 'enable', label: 'enable' }, { value: 'disable', label: 'disable' }] },
    { key: 'start_step_rate', label: 'Start', kind: 'number', min: 0, max: 1, step: 0.01, title: '采样起始步比例' },
    { key: 'end_step_rate', label: 'End', kind: 'number', min: 0, max: 1, step: 0.01, title: '采样结束步比例' },
    { key: 'enable_edit', label: 'Enable Edit', kind: 'bool' },
    { key: 'edit_mode', label: 'Edit Mode', kind: 'select', options: [{ value: 'fit', label: 'fit' }, { value: 'crop', label: 'crop' }] },
    { key: 'ref_boost', label: 'Ref Boost', kind: 'number', step: 0.1 },
    { key: 'ref_boost_a', label: 'Ref Boost A', kind: 'number', step: 0.1 },
    { key: 'enable_ref_boost_mask', label: 'Ref Boost Mask', kind: 'bool' },
    { key: 'grounding_px', label: 'Grounding px', kind: 'number', step: 8 },
    { key: 'context_regex', label: 'Context Regex', kind: 'text' },
  ],
  tagger: [
    { key: 'mode', label: 'Mode', kind: 'select', options: [
      { value: 'mask', label: 'Mask Tag' }, { value: 'covered', label: 'Covered Tag' }, { value: 'full', label: 'Full Tag' }] },
  ],
  scale: [
    { key: 'scale', label: 'Scale', kind: 'number', min: 0.01, max: 16, step: 0.01 },
    { key: 'use_pipeline_align', label: 'Use Pipeline Align', kind: 'bool' },
    { key: 'align', label: 'Align', kind: 'number', min: 1, max: 64, step: 1, when: p => !(p.use_pipeline_align ?? true) },
  ],
  crop: [
    { key: 'use_pipeline_reserve', label: 'Use Pipeline Reserve', kind: 'bool' },
    { key: 'reserve', label: 'Reserve', kind: 'number', min: 0, step: 1, when: p => !(p.use_pipeline_reserve ?? true) },
  ],
  limit: [
    { key: 'pixels', label: 'Pixels', kind: 'number', min: 0, step: 1024 },
    { key: 'align', label: 'Align', kind: 'number', min: 0, max: 64, step: 1 },
    { key: 'cap_only', label: 'Cap Only', kind: 'bool' },
  ],
  meet: [
    { key: 'width', label: 'Width', kind: 'number', min: 0, max: 2048, step: 8 },
    { key: 'height', label: 'Height', kind: 'number', min: 0, max: 2048, step: 8 },
    { key: 'interpolation', label: 'Interpolation', kind: 'select', options: INTERP },
  ],
  fit: [
    { key: 'width', label: 'Width', kind: 'number', min: 0, max: 2048, step: 8 },
    { key: 'height', label: 'Height', kind: 'number', min: 0, max: 2048, step: 8 },
    { key: 'interpolation', label: 'Interpolation', kind: 'select', options: INTERP },
    { key: 'padding_color', label: 'Padding', kind: 'text' },
  ],
  recover_crop: [
    { key: 'recover_method', label: 'Method', kind: 'select', options: [
      { value: 'mask_blend', label: 'mask_blend' }, { value: 'mask_only', label: 'mask_only' }, { value: 'bounds_only', label: 'bounds_only' }] },
  ],
  recover_scale: [{ key: 'interpolation', label: 'Interpolation', kind: 'select', options: INTERP }],
  recover_meet: [
    { key: 'interpolation', label: 'Interpolation', kind: 'select', options: INTERP },
    { key: 'use_background', label: 'Use Background', kind: 'bool' },
    { key: 'padding_color', label: 'Padding', kind: 'text', when: p => !(p.use_background ?? true) },
  ],
  recover_fit: [{ key: 'interpolation', label: 'Interpolation', kind: 'select', options: INTERP }],
  detect: [
    { key: 'prompt', label: 'Prompt', kind: 'text' },
    { key: 'threshold', label: 'Threshold', kind: 'number', min: 0, max: 1, step: 0.01 },
    { key: 'invert', label: 'Invert', kind: 'bool' },
  ],
};

// ---------------------------------------------------------------------------
// 兼容别名
// ---------------------------------------------------------------------------

export type { PipelineBlock, PipelineBlockKind };
