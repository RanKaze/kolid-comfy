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
    # 黑板（board）= 画布上那张悬浮的 Preprocess 卡片。**不参与执行**：没有端口、不进执行序、
    # 也不投影回 blocks。整条链共读它的 params（enable_mask 还决定 Start/End 有没有 Mask 端口）。
    'board': {'label': 'Preprocess', 'color': '#ff9f0a', 'hint': '整条链的预处理开关',
              'inputs': [], 'outputs': []},
}

# 可选输入端口：不连线也合法 —— 那是"这个节点没有这份数据"。数据只沿显式连线流动，
# 绝不从上一颗执行过的节点隐式顶上来。Detailer / Interface 的 mask 只是"限定工作区"的额外输入。
OPTIONAL_INPUT_PORTS: Dict[str, set] = {
    'detailer': {PORT_MASK},
    'interface': {PORT_MASK},
    # End 的 mask 纯属图示（执行计划不收 End，收尾直接拿最后一颗执行过的工作图/mask）。
    'end': {PORT_MASK},
}

# Switch 端口 id 约定（与前端 pipeline-graph.ts 逐条一致）
SW_EXEC_OUT = 'eo'

# 黑板节点：每张图恒有且只有一块，id 固定。
BOARD_ID = 'board'

# 黑板上的 8 个预处理开关 —— 旧格式存在"第一个 detailer 的 params"上，迁移时搬到黑板。
PREPROCESS_KEYS = ('enable_mask', 'recover_crop', 'enable_fit', 'enable_limit', 'enable_output',
                   'enable_dynamic_layer', 'dynamic_layer_limit', 'dynamic_layer_ctx')
PREPROCESS_DEFAULTS: Dict[str, Any] = {
    'enable_mask': True, 'recover_crop': True, 'enable_fit': False, 'enable_limit': True,
    'enable_output': False, 'enable_dynamic_layer': False,
    'dynamic_layer_limit': True, 'dynamic_layer_ctx': True,
}


def is_schedulable(kind: str) -> bool:
    """参与执行序的节点类型。黑板没有端口，不进执行序，也不投影回 blocks。"""
    return kind != 'board'


def board_params(graph: Dict[str, Any]) -> Dict[str, Any]:
    """这块黑板的参数（缺黑板 = 全默认）。"""
    for n in (graph or {}).get('nodes', []) or []:
        if n.get('kind') == 'board':
            return {**PREPROCESS_DEFAULTS, **(n.get('params') or {})}
    return dict(PREPROCESS_DEFAULTS)


def graph_enable_mask(graph: Dict[str, Any]) -> bool:
    """这块黑板的 Enable Mask（缺黑板 / 缺字段 = 开）。"""
    for n in (graph or {}).get('nodes', []) or []:
        if n.get('kind') == 'board':
            return (n.get('params') or {}).get('enable_mask', True) is not False
    return True


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


def node_ports(node: Dict[str, Any], enable_mask: bool = True):
    """现算一个节点的端口表：(inputs, outputs)，每项 (id, kind, label)。
    Switch 动态；Start / End 的 Mask 端口随黑板的 Enable Mask 消失。"""
    kind = str(node.get('kind') or '')
    if kind == 'switch':
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
    spec = NODE_SPECS.get(kind, {})
    ins, outs = spec.get('inputs', []), spec.get('outputs', [])
    if kind in ('start', 'end'):
        f = (lambda lst: [p for p in lst if p[1] != PORT_MASK]) if not enable_mask else (lambda lst: lst)
        return f(ins), f(outs)
    return ins, outs


def port_kind_node(node: Dict[str, Any], direction: str, port_id: str,
                   enable_mask: bool = True) -> Optional[str]:
    """节点级端口 kind 查询（Switch / Start / End 的动态端口也能正确解析）。"""
    inputs, outputs = node_ports(node, enable_mask)
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


def port_kind(kind: str, direction: str, port_id: str, enable_mask: bool = True) -> Optional[str]:
    """查某节点某方向某端口的 kind；找不到返回 None。
    Start / End 的 Mask 端口随黑板的 Enable Mask 消失（拿得到图时优先用 port_kind_node）。"""
    spec = NODE_SPECS.get(kind)
    if not spec:
        return None
    lst = spec['inputs'] if direction == 'in' else spec['outputs']
    for pid, pkind, _label in lst:
        if pid != port_id:
            continue
        if pkind == PORT_MASK and not enable_mask and kind in ('start', 'end'):
            return None
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

    # 黑板：Preprocess 那 8 个开关原本存在"第一个 detailer 的 params"上（每个 preset 一份），
    # 迁移时搬到黑板上 —— 黑板是**每张图一块**的配置，语义与"每个 preset 一份"完全同形。
    first_d = next((b for b in (blocks or []) if str(b.get('type') or '') == 'detailer'), None)
    dp = ((first_d or {}).get('params') or {}) if isinstance((first_d or {}).get('params'), dict) else {}
    board_p = dict(PREPROCESS_DEFAULTS)
    for k in PREPROCESS_KEYS:
        if dp.get(k) is not None:
            board_p[k] = dp[k]
    enable_mask = board_p.get('enable_mask') is not False
    nodes.append({'id': BOARD_ID, 'kind': 'board', 'name': 'Preprocess', 'x': 0, 'y': -170,
                  'params': board_p})

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
        # interface 的选中目标只有**一个**真源：params['interface_idx']。旧格式把它存在顶层
        # interface_index 上 —— 迁移时挪进 params，之后顶层那份由 graph_to_blocks 从 params 反算。
        params = dict(b.get('params') or {})
        if kind == 'interface' and params.get('interface_idx') is None:
            params['interface_idx'] = b.get('interface_index') if isinstance(b.get('interface_index'), int) else 0
        node = {
            'id': nid, 'kind': kind,
            'name': b.get('name') or NODE_SPECS[kind]['label'],
            'x': (i + 1) * _GAP_X, 'y': 0,
            'params': params,
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
        # Enable Mask 关时 Start 根本没有 Mask 输出，mask 这条线整条不接。
        if enable_mask and _has(kind, 'in', PORT_MASK):
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
    if enable_mask:
        edges.append(make_edge(seq, mask_src, 'mask', END_ID, 'mask'))

    return {'nodes': nodes, 'edges': edges}


# ---------------------------------------------------------------------------
# 执行顺序 / 校验
# ---------------------------------------------------------------------------

def exec_order(graph: Dict[str, Any]) -> List[str]:
    """Execute 边上的拓扑排序（Kahn）。分支图同样成立；有环时排不满全部节点。
    黑板这类不参与执行的节点**不进**这张排序（留着会被当成一颗待执行的节点）。"""
    nodes = {n['id']: n for n in graph.get('nodes', [])}
    children: Dict[str, List[str]] = {nid: [] for nid, n in nodes.items() if is_schedulable(str(n.get('kind') or ''))}
    indeg: Dict[str, int] = {nid: 0 for nid in children}
    for e in graph.get('edges', []):
        s, t = e.get('source'), e.get('target')
        if s not in nodes or t not in nodes:
            continue
        if s not in indeg or t not in indeg:      # 有一端不参与执行：这条边不算
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
        if not n or n['kind'] in ('start', 'end') or not is_schedulable(n['kind']):
            continue
        # 顶层 interface_index 从 params 反算 —— 单一真源在节点 params 上。
        iface_idx = n.get('interface_index')
        if n['kind'] == 'interface':
            p = n.get('params') or {}
            iface_idx = p.get('interface_idx', iface_idx)
        out.append({'id': n['id'], 'type': n['kind'], 'name': n.get('name'),
                    'params': n.get('params') or {}, 'interface_index': iface_idx,
                    'exec_options': n.get('exec_options')})
    return out


def validate_graph(graph: Dict[str, Any]) -> List[str]:
    """返回校验问题文案列表（空 = 通过）。"""
    issues: List[str] = []
    nodes = {n['id']: n for n in graph.get('nodes', [])}
    enable_mask = graph_enable_mask(graph)
    if START_ID not in nodes:
        issues.append('缺少 Start 节点')
    if END_ID not in nodes:
        issues.append('缺少 End 节点')
    connected_in = {(e.get('target'), e.get('targetPort')) for e in graph.get('edges', [])}
    # Start 必须至少接出去一条 —— 它是链的入口；一条都没接时执行序会从"第一颗没有 exec 输入的
    # 节点"开始，整条链与画布入口脱钩。
    if START_ID in nodes and not any(e.get('source') == START_ID for e in graph.get('edges', [])):
        issues.append('Start 一条线都没接出去 —— 这条链与画布入口脱钩了')
    for n in graph.get('nodes', []):
        spec = NODE_SPECS.get(n['kind'])
        if not spec:
            issues.append(f"未知节点类型 {n['kind']}")
            continue
        if not is_schedulable(n['kind']):   # 黑板：没有端口，不参与校验
            continue
        # Switch：动态端口 —— 不逐端口要求"全连"，只要求至少一条 exec 头接了线
        if n['kind'] == 'switch':
            any_exec_in = any(
                e.get('target') == n['id'] and port_kind_node(n, 'in', e.get('targetPort'), enable_mask) == PORT_EXEC
                for e in graph.get('edges', []))
            if not any_exec_in:
                issues.append(f"{n.get('name')} 至少要让一条 Exec 头接上线")
            out_exec = any(e.get('source') == n['id'] and e.get('sourcePort') == SW_EXEC_OUT
                           for e in graph.get('edges', []))
            if not out_exec:
                issues.append(f"{n.get('name')} 的 Execute 输出未连接")
            continue
        # 逐端口的"未连接"合并成一条（接线是可编辑的中间态，拆成 N 行只会刷屏）。
        # 可选端口（Detailer / Interface / End 的 Mask）不连线也合法；Start / End 的 Mask
        # 在 Enable Mask 关时取现算端口表（那时它根本不存在）。
        optional = OPTIONAL_INPUT_PORTS.get(n['kind'], set())
        in_ports, _out_ports = node_ports(n, enable_mask)
        missing = [label for pid, _k, label in in_ports
                   if pid not in optional and (n['id'], pid) not in connected_in]
        if missing:
            issues.append(f"{n.get('name')} 有 {len(missing)} 个输入端口未连接：" + ' / '.join(missing))
    # 环检测：分母只在**参与执行的节点**里数（黑板之类的要去掉，否则永远"缺一个"）。
    schedulable = sum(1 for n in graph.get('nodes', []) if is_schedulable(str(n.get('kind') or '')))
    if len(exec_order(graph)) < schedulable:
        issues.append('Execute 连线成环')
    return issues


def _exec_cycle_back_edges(nodes: List[Dict[str, Any]], edges: List[Dict[str, Any]]) -> set:
    """DFS 找 exec 环里回指的边，返回要丢掉的边 id 集合。"""
    by_id = {n['id']: n for n in nodes}
    is_exec = []
    for e in edges:
        s, t = by_id.get(e.get('source')), by_id.get(e.get('target'))
        if not s or not t:
            continue
        if port_kind_node(s, 'out', e.get('sourcePort')) != PORT_EXEC:
            continue
        if port_kind_node(t, 'in', e.get('targetPort')) != PORT_EXEC:
            continue
        is_exec.append(e)
    adj: Dict[str, List[Tuple[str, str]]] = {n['id']: [] for n in nodes}
    for e in is_exec:
        adj[e['source']].append((e['target'], e['id']))
    state: Dict[str, int] = {}
    drop = set()

    def dfs(nid: str):
        state[nid] = 1
        for to, eid in adj.get(nid, []):
            if eid in drop:
                continue
            st = state.get(to, 0)
            if st == 1:
                drop.add(eid)          # 回边 → 成环 → 丢掉
            elif st == 0:
                dfs(to)
        state[nid] = 2

    for n in nodes:
        if state.get(n['id'], 0) == 0:
            dfs(n['id'])
    return drop


def sanitize_graph(graph: Dict[str, Any]) -> Dict[str, Any]:
    """把图修成**一定合法**：丢未知节点 / 悬空边 / 端口不存在 / kind 不匹配 / 重复边 / exec 环；
    缺 Start / End 就补。返回新 dict（不改原对象）。加载与执行前都过一遍。"""
    seen = set()
    nodes: List[Dict[str, Any]] = []
    has_board = False
    for n in (graph or {}).get('nodes', []) or []:
        if n.get('kind') not in NODE_SPECS or n.get('id') in seen:
            continue
        if n.get('kind') == 'board':
            if has_board:
                continue          # 黑板只留一块
            has_board = True
        seen.add(n['id'])
        nodes.append(dict(n))
    if START_ID not in seen:
        nodes.insert(0, {'id': START_ID, 'kind': 'start', 'name': 'Start', 'x': 0, 'y': 0, 'params': {}})
    if END_ID not in seen:
        nodes.append({'id': END_ID, 'kind': 'end', 'name': 'End', 'x': 0, 'y': 0, 'params': {}})

    # 黑板：旧图里还没有（那时 Preprocess 挂在"第一个 detailer 的 params"上）就补一块 ——
    # 参数从图里第一颗 detailer 的 params 抄过来；已有的那块补齐缺的 key。
    board_i = next((i for i, n in enumerate(nodes) if n.get('kind') == 'board'), -1)
    if board_i >= 0:
        b = nodes[board_i]
        nodes[board_i] = {**b, 'params': {**PREPROCESS_DEFAULTS, **(b.get('params') or {})}}
    else:
        src = next((n for n in nodes if n.get('kind') == 'detailer'), None)
        sp = (src or {}).get('params') or {}
        params = dict(PREPROCESS_DEFAULTS)
        for k in PREPROCESS_KEYS:
            if sp.get(k) is not None:
                params[k] = sp[k]
        nodes.insert(0, {'id': BOARD_ID, 'kind': 'board', 'name': 'Preprocess',
                         'x': 0, 'y': -170, 'params': params})
        seen.add(BOARD_ID)

    # Enable Mask 关 = Start 的 Mask 输出 / End 的 Mask 输入不存在 → 指向它们的边在这里
    # 因为"端口已不存在"被丢掉（与前端选的"端口直接消失"同一条规则）。
    enable_mask = graph_enable_mask({'nodes': nodes})

    by_id = {n['id']: n for n in nodes}
    seen_edge = set()
    used_ids: set = set()
    edges: List[Dict[str, Any]] = []
    for e in (graph or {}).get('edges', []) or []:
        s, t = by_id.get(e.get('source')), by_id.get(e.get('target'))
        if not s or not t:
            continue
        if not is_schedulable(s['kind']) or not is_schedulable(t['kind']):
            continue              # 黑板没有端口，连着它的边一律不算
        sk = port_kind_node(s, 'out', e.get('sourcePort'), enable_mask)
        tk = port_kind_node(t, 'in', e.get('targetPort'), enable_mask)
        if not sk or not tk:
            continue
        if not (sk == tk or sk == PORT_ANY or tk == PORT_ANY):
            continue
        key = (e.get('source'), e.get('sourcePort'), e.get('target'), e.get('targetPort'))
        if key in seen_edge:
            continue
        seen_edge.add(key)
        # 边 id **就在这里**唯一化（在环检测之前）：同 id 的两条边会被 xyflow 当成同一条；
        # 更要命的是环检测按 id 丢边 —— 同 id 会一丢丢两条，连带误删合法的线。
        eid = e.get('id')
        if not eid or eid in used_ids:
            base = eid or 'e'
            k = 1
            while f'{base}-d{k}' in used_ids:
                k += 1
            eid = f'{base}-d{k}'
        used_ids.add(eid)
        edges.append(e if eid == e.get('id') else {**e, 'id': eid})

    # 环检测。此时 id 已唯一，按 id 丢边不会错杀。
    drop = _exec_cycle_back_edges(nodes, edges)
    return {'nodes': nodes, 'edges': [e for e in edges if e.get('id') not in drop]}


def graph_from_config(entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """从一份 block set / 顶层 config 里取图：优先新字段 `graph`；没有就由旧 `blocks` 迁移。
    两者都没有时返回 None。取到的图**先净化**，保证执行器拿到的图合法。"""
    if not isinstance(entry, dict):
        return None
    g = entry.get('graph')
    if not (isinstance(g, dict) and isinstance(g.get('nodes'), list)):
        blocks = entry.get('blocks')
        if not isinstance(blocks, list):
            return None
        g = blocks_to_graph(blocks)
    return sanitize_graph(g)


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
        if not n or n['kind'] in ('start', 'end') or not is_schedulable(n['kind']):
            continue
        params = n.get('params') or {}
        iface_idx = n.get('interface_index')
        if n['kind'] == 'interface':
            iface_idx = params.get('interface_idx', iface_idx)
        plan.append({
            'id': nid,
            'kind': n['kind'],
            'name': n.get('name'),
            'params': params,
            'interface_index': iface_idx,
            'exec_options': n.get('exec_options'),
            'guard': guards.get(nid, []),
            'inputs': sources.get(nid, {}),
        })
    return plan

