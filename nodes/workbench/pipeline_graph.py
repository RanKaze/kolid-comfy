"""Pipeline Blocks —— 图模型的**后端镜像**。

与前端 `ui/sampler_node/src/workbench/pipeline-graph.ts` 一一对应：节点端口表、默认参数、
`blocks_to_graph` 迁移、Execute 拓扑排序、校验规则都必须逐条一致。改这里就要同步改那边。

为什么需要镜像：旧模型是线性 block 数组，后端 `_run_pipeline_blocks` 顺序消费；新模型是一张
有向图（Execute 定序/分支，Image/Mask/Info 是显式数据边），后端要有能力**把旧格式自动迁移
成图**，并按图执行。前端画布与后端引擎共用这一份"端口真源"，才不会各写一套规则。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# 端口
# ---------------------------------------------------------------------------

PORT_EXEC = 'exec'
PORT_IMAGE = 'image'
PORT_MASK = 'mask'
PORT_ANY = 'any'
PORT_CROP_INFO = 'crop_info'
PORT_SCALE_INFO = 'scale_info'
PORT_LIMIT_INFO = 'limit_info'
PORT_MEET_INFO = 'meet_info'
PORT_FIT_INFO = 'fit_info'

# 端口 = (id, kind, label)。id 是节点内唯一标识（同 kind 可出现多次：detect 有两条 exec）。
def _P(pid: str, kind: str, label: str) -> Tuple[str, str, str]:
    return (pid, kind, label)

_EXEC = _P('exec', PORT_EXEC, 'Execute')
_EXEC_YES = _P('exec_yes', PORT_EXEC, 'Has Mask')
_EXEC_NO = _P('exec_no', PORT_EXEC, 'No Mask')
_IMAGE = _P('image', PORT_IMAGE, 'Image')
_MASK = _P('mask', PORT_MASK, 'Mask')
_CROP_INFO = _P('crop_info', PORT_CROP_INFO, 'Crop Info')
_SCALE_INFO = _P('scale_info', PORT_SCALE_INFO, 'Scale Info')
_LIMIT_INFO = _P('limit_info', PORT_LIMIT_INFO, 'Limit Info')
_MEET_INFO = _P('meet_info', PORT_MEET_INFO, 'Meet Info')
_FIT_INFO = _P('fit_info', PORT_FIT_INFO, 'Fit Info')

# kind -> {'label','color','hint','inputs':[...],'outputs':[...]}
NODE_SPECS: Dict[str, Dict[str, Any]] = {
    'start': {'label': 'Start', 'color': '#30d158', 'hint': '链条入口', 'inputs': [],
              'outputs': [_IMAGE, _MASK, _EXEC]},
    'end': {'label': 'End', 'color': '#ff453a', 'hint': '链条出口', 'inputs': [_IMAGE, _MASK, _EXEC],
            'outputs': []},
    'detailer': {'label': 'Detailer', 'color': '#30d158', 'hint': 'Refine the masked region',
                 'inputs': [_EXEC, _IMAGE, _MASK], 'outputs': [_EXEC, _IMAGE]},
    'interface': {'label': 'Interface', 'color': '#bf5af2', 'hint': 'Run an interface sub-graph',
                  'inputs': [_EXEC, _IMAGE, _MASK], 'outputs': [_EXEC, _IMAGE, _MASK]},
    'prompt': {'label': 'Prompt', 'color': '#64d2ff', 'hint': 'Inject a shared prompt preset',
               'inputs': [_EXEC], 'outputs': [_EXEC]},
    'query': {'label': 'Query', 'color': '#ffd60a', 'hint': 'Stop the run and ask for a prompt',
              'inputs': [_EXEC], 'outputs': [_EXEC]},
    'tagger': {'label': 'Tagger', 'color': '#ff9f0a', 'hint': 'Tag the incoming image',
               'inputs': [_EXEC, _IMAGE], 'outputs': [_EXEC]},
    'scale': {'label': 'Scale', 'color': '#5e5ce6', 'hint': 'Resize the working image',
              'inputs': [_EXEC, _IMAGE, _MASK], 'outputs': [_EXEC, _IMAGE, _MASK, _SCALE_INFO]},
    'recover_scale': {'label': 'Recover Scale', 'color': '#5e5ce6', 'hint': 'Undo a Scale',
                      'inputs': [_EXEC, _IMAGE, _MASK, _SCALE_INFO], 'outputs': [_EXEC, _IMAGE, _MASK]},
    'limit': {'label': 'Limit', 'color': '#8e8e93', 'hint': 'Re-apply the pixel budget',
              'inputs': [_EXEC, _IMAGE, _MASK], 'outputs': [_EXEC, _IMAGE, _MASK, _LIMIT_INFO]},
    'recover_limit': {'label': 'Recover Limit', 'color': '#8e8e93', 'hint': 'Return to the pre-Limit resolution',
                      'inputs': [_EXEC, _IMAGE, _MASK, _LIMIT_INFO], 'outputs': [_EXEC, _IMAGE, _MASK]},
    'crop': {'label': 'Crop', 'color': '#ff375f', 'hint': 'Crop to the Mask bounding box',
             'inputs': [_EXEC, _IMAGE, _MASK], 'outputs': [_EXEC, _IMAGE, _MASK, _CROP_INFO]},
    'recover_crop': {'label': 'Recover Crop', 'color': '#ff375f', 'hint': 'Paste a Crop back',
                     'inputs': [_EXEC, _IMAGE, _MASK, _CROP_INFO], 'outputs': [_EXEC, _IMAGE, _MASK]},
    'meet': {'label': 'Meet', 'color': '#0a84ff', 'hint': 'Cover the target frame then centre-crop',
             'inputs': [_EXEC, _IMAGE, _MASK], 'outputs': [_EXEC, _IMAGE, _MASK, _MEET_INFO]},
    'recover_meet': {'label': 'Recover Meet', 'color': '#0a84ff', 'hint': 'Put a Meet back',
                     'inputs': [_EXEC, _IMAGE, _MASK, _MEET_INFO], 'outputs': [_EXEC, _IMAGE, _MASK]},
    'fit': {'label': 'Fit', 'color': '#64d2ff', 'hint': 'Contain the target frame then pad',
            'inputs': [_EXEC, _IMAGE, _MASK], 'outputs': [_EXEC, _IMAGE, _MASK, _FIT_INFO]},
    'recover_fit': {'label': 'Recover Fit', 'color': '#64d2ff', 'hint': 'Take a Fit back',
                    'inputs': [_EXEC, _IMAGE, _MASK, _FIT_INFO], 'outputs': [_EXEC, _IMAGE, _MASK]},
    'detect': {'label': 'Detect', 'color': '#ffd60a', 'hint': 'Detect; branch Has Mask / No Mask',
               'inputs': [_EXEC, _IMAGE], 'outputs': [_EXEC_YES, _EXEC_NO, _MASK]},
    # Switch（倒过来的 switch / gather）：输入多头、输出单头。端口是动态的（见 node_ports）。
    'switch': {'label': 'Switch', 'color': '#ff9f0a', 'hint': 'Gather many exec heads into one exec + N data',
               'inputs': [], 'outputs': []},
}

# Switch 端口 id 约定（与前端 pipeline-graph.ts 逐条一致）
SW_EXEC_OUT = 'eo'


def sw_exec_in(b: int) -> str:
    return f'ei:{b}'


def sw_data_in(b: int, j: int) -> str:
    return f'di:{b}:{j}'


def sw_data_out(i: int) -> str:
    return f'do:{i}'


def switch_n(params: Dict[str, Any]) -> int:
    """N = 各分枝 data 数的最大值。"""
    branches = (params or {}).get('branches') or []
    n = 0
    for br in branches:
        try:
            n = max(n, max(0, int((br or {}).get('data') or 0)))
        except (TypeError, ValueError):
            pass
    return n


def node_ports(node: Dict[str, Any]):
    """现算一个节点的端口表：(inputs, outputs)，每项 (id, kind, label)。Switch 动态。"""
    if node.get('kind') == 'switch':
        branches = (node.get('params') or {}).get('branches') or []
        inputs: List[Tuple[str, str, str]] = []
        for b, br in enumerate(branches):
            inputs.append((sw_exec_in(b), PORT_EXEC, f'Exec {b + 1}'))
            try:
                cnt = max(0, int((br or {}).get('data') or 0))
            except (TypeError, ValueError):
                cnt = 0
            for j in range(cnt):
                inputs.append((sw_data_in(b, j), PORT_ANY, f'Data {j + 1}'))
        outputs: List[Tuple[str, str, str]] = [(SW_EXEC_OUT, PORT_EXEC, 'Execute')]
        for i in range(switch_n(node.get('params') or {})):
            outputs.append((sw_data_out(i), PORT_ANY, f'Data {i + 1}'))
        return inputs, outputs
    spec = NODE_SPECS.get(str(node.get('kind') or ''), {})
    return spec.get('inputs', []), spec.get('outputs', [])


def port_kind_node(node: Dict[str, Any], direction: str, port_id: str) -> Optional[str]:
    """节点级端口 kind 查询（Switch 也能正确解析）。"""
    inputs, outputs = node_ports(node)
    for pid, kind, _label in (inputs if direction == 'in' else outputs):
        if pid == port_id:
            return kind
    return None

OP_INFO_PORT = {'crop': _CROP_INFO, 'scale': _SCALE_INFO, 'limit': _LIMIT_INFO,
                'meet': _MEET_INFO, 'fit': _FIT_INFO}
RECOVER_INFO_KIND = {'recover_crop': PORT_CROP_INFO, 'recover_scale': PORT_SCALE_INFO,
                     'recover_limit': PORT_LIMIT_INFO, 'recover_meet': PORT_MEET_INFO,
                     'recover_fit': PORT_FIT_INFO}

START_ID = 'start'
END_ID = 'end'
_GAP_X = 300


def port_kind(kind: str, direction: str, port_id: str) -> Optional[str]:
    """查某节点某方向某端口的 kind；找不到返回 None。"""
    spec = NODE_SPECS.get(kind)
    if not spec:
        return None
    lst = spec['inputs'] if direction == 'in' else spec['outputs']
    for pid, pkind, _label in lst:
        if pid == port_id:
            return pkind
    return None


def _has(kind: str, direction: str, pkind: str) -> bool:
    spec = NODE_SPECS.get(kind)
    if not spec:
        return False
    lst = spec['inputs'] if direction == 'in' else spec['outputs']
    return any(k == pkind for _i, k, _l in lst)


def primary_exec_out(kind: str) -> str:
    """沿旧线性链继续时默认接哪条 exec 输出（detect 走"命中"）。"""
    return 'exec_yes' if kind == 'detect' else 'exec'


# ---------------------------------------------------------------------------
# 图结构
# ---------------------------------------------------------------------------

def make_edge(seq: List[int], source: str, source_port: str, target: str, target_port: str) -> Dict[str, Any]:
    e = {'id': f'e-{seq[0]}', 'source': source, 'sourcePort': source_port,
         'target': target, 'targetPort': target_port}
    seq[0] += 1
    return e


def blocks_to_graph(blocks: List[Dict[str, Any]]) -> Dict[str, Any]:
    """旧 blocks[] → 图。规则与前端 blocksToGraph 逐条一致。"""
    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []
    by_id: Dict[str, Dict[str, Any]] = {}
    seq = [0]

    start = {'id': START_ID, 'kind': 'start', 'name': 'Start', 'x': 0, 'y': 0, 'params': {}}
    nodes.append(start); by_id[START_ID] = start

    image_src = START_ID
    mask_src = START_ID
    open_frames: List[str] = []
    prev_node, prev_port, prev_kind = START_ID, 'exec', 'start'

    for i, b in enumerate(blocks or []):
        kind = str(b.get('type') or '')
        if kind not in NODE_SPECS:
            continue
        nid = str(b.get('id') or f'block-{i + 1}')
        node = {
            'id': nid, 'kind': kind,
            'name': b.get('name') or NODE_SPECS[kind]['label'],
            'x': (i + 1) * _GAP_X, 'y': 0,
            'params': dict(b.get('params') or {}),
            'interface_index': b.get('interface_index'),
            'exec_options': b.get('exec_options'),
        }
        nodes.append(node); by_id[nid] = node

        # Execute：detect 的两条输出（命中/未命中）都接到下一颗 —— 旧链不分支，
        # 迁移出的图因此不带分支约束，行为与旧链一字不差。
        for p in (('exec_yes', 'exec_no') if prev_kind == 'detect' else (prev_port,)):
            edges.append(make_edge(seq, prev_node, p, nid, 'exec'))
        prev_node, prev_port, prev_kind = nid, primary_exec_out(kind), kind

        if _has(kind, 'in', PORT_IMAGE):
            edges.append(make_edge(seq, image_src, 'image', nid, 'image'))
        if _has(kind, 'out', PORT_IMAGE):
            image_src = nid
        if _has(kind, 'in', PORT_MASK):
            edges.append(make_edge(seq, mask_src, 'mask', nid, 'mask'))
        if _has(kind, 'out', PORT_MASK):
            mask_src = nid

        if any(_has(kind, 'out', k) for k in
               (PORT_CROP_INFO, PORT_SCALE_INFO, PORT_LIMIT_INFO, PORT_MEET_INFO, PORT_FIT_INFO)):
            open_frames.append(nid)
        want_info = RECOVER_INFO_KIND.get(kind)
        if want_info:
            for j in range(len(open_frames) - 1, -1, -1):
                cand = by_id.get(open_frames[j])
                if cand and port_kind_node(cand, 'out', want_info) == want_info:
                    edges.append(make_edge(seq, cand['id'], want_info, nid, want_info))
                    open_frames.pop(j)
                    break

    end = {'id': END_ID, 'kind': 'end', 'name': 'End', 'x': (len(blocks or []) + 1) * _GAP_X,
           'y': 0, 'params': {}}
    nodes.append(end); by_id[END_ID] = end
    for p in (('exec_yes', 'exec_no') if prev_kind == 'detect' else (prev_port,)):
        edges.append(make_edge(seq, prev_node, p, END_ID, 'exec'))
    edges.append(make_edge(seq, image_src, 'image', END_ID, 'image'))
    edges.append(make_edge(seq, mask_src, 'mask', END_ID, 'mask'))

    return {'nodes': nodes, 'edges': edges}


# ---------------------------------------------------------------------------
# 执行顺序 / 校验
# ---------------------------------------------------------------------------

def exec_order(graph: Dict[str, Any]) -> List[str]:
    """Execute 边上的拓扑排序（Kahn）。分支图同样成立；有环时排不满全部节点。"""
    nodes = {n['id']: n for n in graph.get('nodes', [])}
    children: Dict[str, List[str]] = {nid: [] for nid in nodes}
    indeg: Dict[str, int] = {nid: 0 for nid in nodes}
    for e in graph.get('edges', []):
        s, t = e.get('source'), e.get('target')
        if s not in nodes or t not in nodes:
            continue
        if port_kind_node(nodes[s], 'out', e.get('sourcePort')) != PORT_EXEC:
            continue
        if port_kind_node(nodes[t], 'in', e.get('targetPort')) != PORT_EXEC:
            continue
        children[s].append(t)
        indeg[t] += 1
    ready = [nid for nid, d in indeg.items() if d == 0]
    order: List[str] = []
    seen = set()
    while ready:
        ready.sort(key=lambda nid: (nodes[nid].get('x', 0), nodes[nid].get('y', 0)))
        nid = ready.pop(0)
        if nid in seen:
            continue
        seen.add(nid); order.append(nid)
        for c in children.get(nid, []):
            indeg[c] -= 1
            if indeg[c] == 0:
                ready.append(c)
    return order


def graph_to_blocks(graph: Dict[str, Any]) -> List[Dict[str, Any]]:
    """图 → 旧 blocks[]（按 Execute 拓扑顺序；分支信息会丢失，仅过渡期用）。"""
    nodes = {n['id']: n for n in graph.get('nodes', [])}
    out: List[Dict[str, Any]] = []
    for nid in exec_order(graph):
        n = nodes.get(nid)
        if not n or n['kind'] in ('start', 'end'):
            continue
        out.append({'id': n['id'], 'type': n['kind'], 'name': n.get('name'),
                    'params': n.get('params') or {}, 'interface_index': n.get('interface_index'),
                    'exec_options': n.get('exec_options')})
    return out


def validate_graph(graph: Dict[str, Any]) -> List[str]:
    """返回校验问题文案列表（空 = 通过）。"""
    issues: List[str] = []
    nodes = {n['id']: n for n in graph.get('nodes', [])}
    if START_ID not in nodes:
        issues.append('缺少 Start 节点')
    if END_ID not in nodes:
        issues.append('缺少 End 节点')
    connected_in = {(e.get('target'), e.get('targetPort')) for e in graph.get('edges', [])}
    for n in graph.get('nodes', []):
        spec = NODE_SPECS.get(n['kind'])
        if not spec:
            issues.append(f"未知节点类型 {n['kind']}")
            continue
        # Switch：动态端口 —— 不逐端口要求"全连"，只要求至少一条 exec 头接了线
        if n['kind'] == 'switch':
            any_exec_in = any(
                e.get('target') == n['id'] and port_kind_node(n, 'in', e.get('targetPort')) == PORT_EXEC
                for e in graph.get('edges', []))
            if not any_exec_in:
                issues.append(f"{n.get('name')} 至少要让一条 Exec 头接上线")
            out_exec = any(e.get('source') == n['id'] and e.get('sourcePort') == SW_EXEC_OUT
                           for e in graph.get('edges', []))
            if not out_exec:
                issues.append(f"{n.get('name')} 的 Execute 输出未连接")
            continue
        # 逐端口的"未连接"合并成一条（接线是可编辑的中间态，拆成 N 行只会刷屏）
        missing = [label for pid, _k, label in spec['inputs'] if (n['id'], pid) not in connected_in]
        if missing:
            issues.append(f"{n.get('name')} 有 {len(missing)} 个输入端口未连接：" + ' / '.join(missing))
    if len(exec_order(graph)) < len(graph.get('nodes', [])):
        issues.append('Execute 连线成环')
    return issues


def graph_from_config(entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """从一份 block set / 顶层 config 里取图：优先新字段 `graph`；没有就由旧 `blocks` 迁移。
    两者都没有时返回 None（调用方自己决定兜底）。"""
    if not isinstance(entry, dict):
        return None
    g = entry.get('graph')
    if isinstance(g, dict) and isinstance(g.get('nodes'), list):
        return g
    blocks = entry.get('blocks')
    if isinstance(blocks, list):
        return blocks_to_graph(blocks)
    return None


# ---------------------------------------------------------------------------
# 执行计划：拓扑序 + 运行时分支约束 + 显式边取数
# ---------------------------------------------------------------------------

def _exec_children(graph: Dict[str, Any]) -> Dict[str, List[Tuple[str, str]]]:
    """node → [(child, source_port_id)]，只走 exec 边（Switch 的动态端口也认）。"""
    nodes = {n['id']: n for n in graph.get('nodes', [])}
    out: Dict[str, List[Tuple[str, str]]] = {nid: [] for nid in nodes}
    for e in graph.get('edges', []):
        s, t = e.get('source'), e.get('target')
        if s not in nodes or t not in nodes:
            continue
        if port_kind_node(nodes[s], 'out', e.get('sourcePort')) != PORT_EXEC:
            continue
        if port_kind_node(nodes[t], 'in', e.get('targetPort')) != PORT_EXEC:
            continue
        out[s].append((t, str(e.get('sourcePort'))))
    return out


def _reachable_depth_first(graph: Dict[str, Any], start_id: str) -> set:
    """从 start_id 沿 exec 边可达的全部节点（含自身）。"""
    children = _exec_children(graph)
    seen = {start_id}
    stack = [start_id]
    while stack:
        cur = stack.pop()
        for nxt, _port in children.get(cur, []):
            if nxt not in seen:
                seen.add(nxt); stack.append(nxt)
    return seen


def branch_guards(graph: Dict[str, Any]) -> Dict[str, List[Tuple[str, str]]]:
    """算每个节点的**运行时分支约束**：{node_id: [(detect_id, 'yes'|'no'), ...]}。

    判据：对每个 detect 的两条 exec 输出分别求可达集 reachY / reachN。
      · 只在 reachY 里 → 约束 (detect, 'yes')：命中才跑；
      · 只在 reachN 里 → 约束 (detect, 'no')：未命中才跑；
      · 两边都在 → 无约束（分支已汇聚，无条件跑）。
    多个 detect 的约束取并集（嵌套分支自然成立）。detect 自身与 Start 不设约束。
    返回里只保留有约束的节点。"""
    nodes = {n['id']: n for n in graph.get('nodes', [])}
    guards: Dict[str, List[Tuple[str, str]]] = {}
    for n in graph.get('nodes', []):
        if n['kind'] != 'detect':
            continue
        children = _exec_children(graph)
        reach_yes = set(); reach_no = set()
        for child, port in children.get(n['id'], []):
            sub = _reachable_depth_first(graph, child)
            if port == 'exec_yes':
                reach_yes |= sub
            elif port == 'exec_no':
                reach_no |= sub
        for nid in reach_yes - reach_no:
            guards.setdefault(nid, []).append((n['id'], 'yes'))
        for nid in reach_no - reach_yes:
            guards.setdefault(nid, []).append((n['id'], 'no'))
    return guards


def input_sources(graph: Dict[str, Any]) -> Dict[str, Dict[str, Tuple[str, str]]]:
    """每个节点的输入端口 → 它连到哪（源节点 id, 源端口 id）。用于显式取数。"""
    res: Dict[str, Dict[str, Tuple[str, str]]] = {}
    nodes = {n['id']: n for n in graph.get('nodes', [])}
    for e in graph.get('edges', []):
        t = e.get('target')
        if t not in nodes:
            continue
        res.setdefault(t, {})[str(e.get('targetPort'))] = (str(e.get('source')), str(e.get('sourcePort')))
    return res


def exec_plan(graph: Dict[str, Any]) -> List[Dict[str, Any]]:
    """把图编译成一张**执行计划**：按 Execute 拓扑序排列的步骤，每步带
    `id / kind / params / guard / inputs`。执行器照着它跑；detect 处由运行时决定
    guard 约束是否放行。"""
    nodes = {n['id']: n for n in graph.get('nodes', [])}
    guards = branch_guards(graph)
    sources = input_sources(graph)
    plan: List[Dict[str, Any]] = []
    for nid in exec_order(graph):
        n = nodes.get(nid)
        if not n or n['kind'] in ('start', 'end'):
            continue
        plan.append({
            'id': nid,
            'kind': n['kind'],
            'name': n.get('name'),
            'params': n.get('params') or {},
            'interface_index': n.get('interface_index'),
            'exec_options': n.get('exec_options'),
            'guard': guards.get(nid, []),
            'inputs': sources.get(nid, {}),
        })
    return plan

