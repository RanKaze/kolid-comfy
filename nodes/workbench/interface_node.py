import inspect
import json
import os
from ...libs.utils import AlwaysEqualProxy, ByPassTypeTuple

from comfy_execution.graph_utils import is_link
import comfy.model_management as mm

MAX_INTERFACE_NUM = 20
any_type = AlwaysEqualProxy("*")
_UNRESOLVED = object()  # sentinel for unresolved link values


def _alias_target(entry):
    """展开 `_subgraph_output_aliases` 的值：(internal_node_id, output_slot)。

    新格式是 [id, slot]；旧存档/旧代码写的是裸 id，那时一律按输出槽 0 读 ——
    子图某个输出若不是从内部节点第 0 个口连出来的（很常见），按 0 读会静默
    拿到另一个值，也就是"接错线"。
    """
    if isinstance(entry, (list, tuple)) and len(entry) == 2:
        return str(entry[0]), int(entry[1])
    return str(entry), 0


def _widget_names_of(node):
    """存档里这条节点各 widget 的 `(名字, 是否已转成连线输入)`，按槽序。

    新前端在每个 input 条目上带 `widget: {name}`，所以"哪一格是什么"是可查的。
    节点包后来增删了 widget 时，`widgets_values` 的格数和当前 INPUT_TYPES 对不上，
    按位置读就会整体错位（提示词串跑进 motion_amplitude 这类）；有名字表就能按
    名字把值对上，存档里多出来的名字直接跳过。

    第二个元素很关键：把某个 widget 转成输入口之后，前端有的版本**仍把它的值留
    在 widgets_values 里**，有的版本会删掉 —— 对齐时两种约定都要试。
    """
    names = []
    for inp in (node.get("inputs") or []) if isinstance(node, dict) else []:
        if not isinstance(inp, dict) or inp.get("widget") is None:
            continue
        cand = _widget_entry_names(inp)
        names.append((cand[0] if cand else None, inp.get("link") is not None))
    return names


def _widgets_by_stored_names(widget_params, widgets_names, values):
    """按存档里的 widget 名字对齐 widgets_values；对不齐返回 None。

    节点包后来增/删了 widget 时，存档里的格子数和当前 INPUT_TYPES 对不上，按位置
    读会整体错位（提示词串跑进 motion_amplitude、'euler' 跑进 scheduler 这类）。
    名字表能直接规避：多余的旧名字连同它的值一起跳过。

    已转成输入的 widget 有两种存档约定（值留着 / 值删掉），这里两种都走一遍，
    取"正好把值用完"的那种；都对不齐返回 None，交调用方退回按位置的老办法。
    """
    if not isinstance(widgets_names, list) or not widgets_names:
        return None
    if not isinstance(values, list) or not values:
        return None
    opts_of = {n: (o or {}) for n, _t, o in widget_params}
    pairs = []
    for nm in widgets_names:
        if isinstance(nm, (tuple, list)) and len(nm) == 2:
            pairs.append((nm[0], bool(nm[1])))
        else:
            pairs.append((nm, False))

    def _walk(skip_linked):
        out = {}
        i = 0
        for nm, linked in pairs:
            if skip_linked and linked:
                continue  # 转成输入口的 widget：存档里没留值，也不占格
            if i >= len(values):
                return None
            if nm in opts_of:
                out[nm] = values[i]
                i += 1
                if opts_of[nm].get("control_after_generate"):
                    if i >= len(values):
                        return None
                    i += 1
            elif isinstance(nm, str) and "." in nm:
                out[nm] = values[i]
                i += 1
            else:
                i += 1
        return out if i == len(values) else None

    for skip in (False, True):
        got = _walk(skip)
        if got is not None:
            return got
    return None


def _node_passthrough(cls):
    """一口进一口出（AnyPass / ByPass 这类直通节点）→ True。

    这种节点不做运算，只是把值搬过去；因此"想要哪个上游输出"这个名字可以穿过
    它继续往上找，也可以在日志里把它展开成 `7748:0 ← 7745:8`。
    """
    if cls is None or len(getattr(cls, "RETURN_TYPES", ()) or ()) != 1:
        return False
    try:
        it = cls.INPUT_TYPES()
    except Exception:
        return False
    if not isinstance(it, dict):
        return False
    names = [n for cat in ("required", "optional") for n in (it.get(cat) or {})]
    return len(names) == 1


def _sg_boundary_widget_entry(sg_node, sg_data, slot):
    """Return the subgraph node's input entry for a boundary slot, or None.

    Promoted widget inputs carry a 'widget' key on the subgraph node instance.
    Used by the callers to tell "this port is a widget" (a missing value should
    fall back to the internal node's own default) from "this port is a plain
    link" (a missing value is a real unresolved boundary).
    """
    if not isinstance(sg_node, dict):
        return None
    node_inputs = sg_node.get("inputs") or []
    if not isinstance(node_inputs, list):
        return None
    defs = (sg_data or {}).get("inputs") or []

    # Find the node's input entry for this boundary slot (index match, verified by name)
    entry = None
    if 0 <= slot < len(node_inputs) and isinstance(node_inputs[slot], dict):
        cand = node_inputs[slot]
        def_name = defs[slot].get("name") if slot < len(defs) and isinstance(defs[slot], dict) else None
        if def_name is None or cand.get("name") == def_name:
            entry = cand
    if entry is None and slot < len(defs) and isinstance(defs[slot], dict):
        # Fallback: match by definition name
        def_name = defs[slot].get("name")
        entry = next((i for i in node_inputs if isinstance(i, dict) and i.get("name") == def_name), None)
    if not isinstance(entry, dict) or not entry.get("widget"):
        return None
    return entry


def _widget_entry_names(entry):
    """Candidate names for a widget-bearing input entry, most specific first."""
    names = []
    widget = entry.get("widget")
    if isinstance(widget, dict) and isinstance(widget.get("name"), str):
        names.append(widget["name"])
    if isinstance(entry.get("name"), str):
        names.append(entry["name"])
    return names


def _coerce_boundary_widget_value(val, def_type):
    """按边界声明的标量类型收敛一个 widget 值；收不拢就当作没有值。

    收不拢说明这个格子里装的不是这个口该有的东西（前端少写/多写一格时，
    位置表会整体错位），继续往下传只会让内部节点在 `str > float` 这种地方
    才炸；这里直接返回 _UNRESOLVED，让调用方退回节点自己的默认值。
    """
    if val is None:
        return _UNRESOLVED
    try:
        if def_type == "FLOAT":
            return float(val)
        if def_type == "INT":
            return int(float(val))
    except (TypeError, ValueError):
        return _UNRESOLVED
    if def_type == "BOOLEAN":
        if isinstance(val, str):
            return val.lower() in ("true", "1", "yes")
        return bool(val)
    return val


def _find_subgraph(subgraph_by_type, node_type):
    """按 type 找子图定义：原样 → 去连字符/小写 → None。

    前端两种写法都出现过：节点 type 是子图 uuid，个别存档里连字符/大小写对不上
    （nested 子图尤其常见），所以命中不了再归一化比一次。
    """
    if not isinstance(node_type, str) or not node_type:
        return None
    if not isinstance(subgraph_by_type, dict):
        return None
    sg = subgraph_by_type.get(node_type)
    if sg is None:
        sg = subgraph_by_type.get(node_type.replace("-", "").lower())
    return sg


def _instance_input_index(sg_node, def_name):
    """子图定义里的输入名 → 这颗实例的 `inputs` 数组下标（没这一格就 None）。

    子图定义可以声明 15 个输入，而实例上可能只有 14 格 —— 某个输入既没连线、也
    没在实例上生成槽（现场：`motion_amplitude`）。这时**后面所有下标都相差 1**，
    拿"定义下标"去比父图连线的 `target_slot` 就会把 sampler_name 接到 scheduler
    的线上。所以一律先按名字换成实例下标。
    """
    for i, entry in enumerate((sg_node or {}).get("inputs") or []):
        if isinstance(entry, dict) and entry.get("name") == def_name:
            return i
    return None


def _sg_boundary_widget_value(sg_node, sg_data, slot):
    """Resolve a subgraph boundary input from the subgraph node's own widget values.

    Promoted widget inputs store their value on the subgraph node instance, not in
    any link. 三级来源：

    1. ``widgets_values_named`` 按**定义里的输入名**取 —— 最稳，实例上连槽都没有
       也照样能取到（现场：motion_amplitude 就是"没连线、走 subgraph 上的 widget"）；
    2. 实例上那个输入条目存在时的命名表（按条目名，兼容 widget.name 与 input.name 不同）；
    3. ``widgets_values`` 位置表 —— 只有"带 widget 的输入槽数 == 值个数"时才可信。

    Returns _UNRESOLVED when there is no trustworthy value.
    """
    defs = (sg_data or {}).get("inputs") or []
    def_name = defs[slot].get("name", "") if 0 <= slot < len(defs) and isinstance(defs[slot], dict) else ""
    def_type = defs[slot].get("type", "") if 0 <= slot < len(defs) and isinstance(defs[slot], dict) else ""

    named = sg_node.get("widgets_values_named")
    if isinstance(named, dict) and def_name and def_name in named:
        val = _coerce_boundary_widget_value(named[def_name], def_type)
        if val is not _UNRESOLVED:
            return val

    entry = _sg_boundary_widget_entry(sg_node, sg_data, slot)
    if entry is None:
        return _UNRESOLVED

    # 2) 命名表：键就是 promoted widget 的名字，逐个对，不做位置猜测。
    if isinstance(named, dict):
        for nm in _widget_entry_names(entry):
            if nm in named:
                return _coerce_boundary_widget_value(named[nm], def_type)

    # 2) 位置表：槽位数与值个数对不上时说明这份存档的格子不准，不猜。
    wv = sg_node.get("widgets_values")
    if not isinstance(wv, list) or not wv:
        return _UNRESOLVED
    node_inputs = [i for i in (sg_node.get("inputs") or []) if isinstance(i, dict)]
    widget_entries = [i for i in node_inputs if i.get("widget")]
    if len(widget_entries) != len(wv):
        return _UNRESOLVED
    pos = None
    for i, e in enumerate(widget_entries):
        if e is entry:
            pos = i
            break
    if pos is None:
        for i, e in enumerate(widget_entries):
            if e.get("name") == entry.get("name"):
                pos = i
                break
    if pos is None or pos >= len(wv):
        return _UNRESOLVED
    return _coerce_boundary_widget_value(wv[pos], def_type)

# Global injection dict: {start_node_id: {port_num: value}}
_interface_injections = {}

# Global capture dict: {prompt_id: [package_dict, ...]}
_interface_captures = {}


def parse_port_types(port_types_str):
    """Parse port_types JSON string into {port_num: type_str}"""
    if not port_types_str:
        return {}
    try:
        raw = json.loads(port_types_str)
        return {int(k): v for k, v in raw.items()}
    except (json.JSONDecodeError, ValueError):
        return {}


class InterfaceStartNode:
    """Interface Start: input-driven dynamic ports.
    Connect value1 → value1 output appears + value2 input added.
    Values pass through and are packed into INTERFACE output for InterfaceEndNode."""

    @classmethod
    def INPUT_TYPES(cls):
        dyn_inputs = {}
        stack = inspect.stack()
        if len(stack) > 2 and stack[2].function == 'get_input_info':
            class AllContainer:
                def __contains__(self, item):
                    return True
                def __getitem__(self, key):
                    return (any_type,)
            dyn_inputs = AllContainer()
        else:
            dyn_inputs = {}

        return {
            "required": {
                "interface_name": ("STRING", {"default": "", "multiline": False}),
            },
            "optional": dyn_inputs,
            "hidden": {
                "port_types": ("STRING", {"default": "{}"}),
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ByPassTypeTuple(("*",))
    RETURN_NAMES = ByPassTypeTuple(("interface",))
    FUNCTION = "interface_start"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def interface_start(self, interface_name, port_types="{}", unique_id=None, **kwargs):
        types = parse_port_types(port_types)
        injections = _interface_injections.get(str(unique_id), {})

        values = []
        interface_values = {}
        _trace = []
        for i in range(1, MAX_INTERFACE_NUM + 1):
            if i in injections:
                val = injections[i]
                _src = 'inj'
            else:
                val = kwargs.get("value%d" % i, None)
                _src = 'kwargs' if val is not None else '-'
            values.append(val)
            # port_types 可能未被序列化到 prompt（隐藏 widget），为空时 passthrough 所有非 None 值
            if i in types or (not types and val is not None):
                interface_values[i] = val
                _kept = ''
            else:
                _kept = '(被 port_types 门掉, 不进 interface_values)' if val is not None else ''
            if _src != '-' or _kept:
                _trace.append("%d:%s%s%s" % (i, _src, type(val).__name__[:4] if val is not None else '', _kept))
        print("[InterfacePorts] start#%s execute types_from_port_types=%d %s"
              % (unique_id, len(types), " ".join(_trace) or "(全空)"))

        interface_data = {
            "name": interface_name,
            "types": types,
            "values": interface_values,
            "start_node_id": str(unique_id) if unique_id else "",
        }
        return tuple([interface_data] + values)


class InterfaceEndNode:
    """Interface End: input-driven dynamic ports.
    Connect value1 → value1 output appears + value2 input added.
    Also outputs a PACKAGE dict for SnapshotDetailerSamplerNode."""

    @classmethod
    def INPUT_TYPES(cls):
        dyn_inputs = {}
        stack = inspect.stack()
        if len(stack) > 2 and stack[2].function == 'get_input_info':
            class AllContainer:
                def __contains__(self, item):
                    return True
                def __getitem__(self, key):
                    return (any_type,)
            dyn_inputs = AllContainer()
        else:
            dyn_inputs = {}

        return {
            "required": {
                "interface": ("INTERFACE",),
            },
            "optional": dyn_inputs,
            "hidden": {
                "port_types": ("STRING", {"default": "{}"}),
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ByPassTypeTuple(("*",))
    RETURN_NAMES = ByPassTypeTuple(("value",))
    FUNCTION = "interface_end"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def interface_end(self, interface, port_types="{}", unique_id=None, **kwargs):
        types = parse_port_types(port_types)
        interface_name = ""
        interface_values = {}
        start_node_id = ""

        if isinstance(interface, dict):
            interface_name = interface.get("name", "")
            interface_values = interface.get("values", {})
            start_node_id = interface.get("start_node_id", "")

        outputs = []
        for i in range(1, MAX_INTERFACE_NUM + 1):
            val = kwargs.get("value%d" % i, None)
            if val is None:
                val = interface_values.get(i, None)
            # port_types 可能未被序列化到 prompt（隐藏 widget），为空时 passthrough 所有非 None 值
            if i in types or not types:
                outputs.append(val)
            else:
                outputs.append(None)

        return tuple(outputs)


class InterfacePackageNode:
    """Takes a node_id (InterfaceEndNode ID) and outputs a PACKAGE containing
    the entire sub-graph between InterfaceStartNode and InterfaceEndNode, including
    any ComfyUI subgraph nodes (expanded from workflow.subgraphs[])."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "node_id": ("STRING", {"default": "", "multiline": False, "tooltip": "Node ID of the InterfaceEndNode to reference"}),
            },
            "hidden": {
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("PACKAGE",)
    RETURN_NAMES = ("package",)
    FUNCTION = "get_package"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    @staticmethod
    def _build_node_lookup(workflow):
        """Build node_by_id and subgraph_by_type lookups from a workflow dict."""
        nodes = workflow.get("nodes", [])
        links = workflow.get("links", [])
        node_by_id = {str(n.get("id")): n for n in nodes}
        # Subgraphs are stored in workflow["definitions"]["subgraphs"]
        subgraphs = []
        definitions = workflow.get("definitions", {})
        if isinstance(definitions, dict):
            subgraphs = definitions.get("subgraphs", [])
        if not subgraphs:
            subgraphs = workflow.get("subgraphs", [])
        subgraph_by_type = {str(sg.get("id")): sg for sg in subgraphs if isinstance(sg, dict) and "id" in sg}
        # 前端两种写法都出现过：节点 type 是子图 uuid，但个别存档的 uuid 带/不带连字符
        # 对不上（nested 子图尤其常见）。补一份归一化索引，命中不了再按名字兜一次。
        for sg in subgraphs:
            if not isinstance(sg, dict):
                continue
            for key in (sg.get("id"), sg.get("name")):
                if isinstance(key, str) and key:
                    subgraph_by_type.setdefault(key.replace("-", "").lower(), sg)
        return node_by_id, links, subgraph_by_type

    _subgraph_of = staticmethod(lambda subgraph_by_type, node_type:
                               _find_subgraph(subgraph_by_type, node_type))

    @staticmethod
    def _get_node_inputs(node, links):
        """Get a node's input links as {name: [origin_id, origin_slot]}."""
        result = {}
        for inp in node.get("inputs", []):
            if isinstance(inp, dict):
                link_id = inp.get("link")
                name = inp.get("name", "")
                if link_id is not None:
                    for link in links:
                        if len(link) >= 5 and link[0] == link_id:
                            result[name] = [str(link[1]), link[2]]
                            break
        return result

    @staticmethod
    def _get_node_downstream(node_id, links):
        """Get downstream node IDs from links."""
        result = []
        for link in links:
            if len(link) >= 5 and str(link[1]) == node_id:
                result.append(str(link[3]))
        return result

    @staticmethod
    def _get_node_upstream(node_id, links):
        """Get upstream (origin_id, origin_slot) pairs from links."""
        result = []
        for link in links:
            if len(link) >= 5 and str(link[3]) == node_id:
                result.append((str(link[1]), link[2], link[4]))
        return result

    @classmethod
    def _expand_subgraph(cls, sg_node_id, sg_node, subgraph_by_type, links, sub_prompt,
                         parent_node_id=None, prefix=None):
        """Expand a ComfyUI subgraph node into its internal nodes.

        `prefix` 只在"子图里再套子图"的递归里给：成品里的节点 id 是
        `父实例.本实例.内部节点`，而父图连线的 target 仍然只写**本层**的裸 id。
        """
        sg_type = sg_node.get("type", "")
        sg_data = cls._subgraph_of(subgraph_by_type, sg_type)
        if not sg_data:
            return {}

        sg_nodes = sg_data.get("nodes", [])
        sg_links_raw = sg_data.get("links", [])

        # Normalize links to list format: could be list of lists or dict keyed by id
        if isinstance(sg_links_raw, dict):
            sg_links = list(sg_links_raw.values())
        elif isinstance(sg_links_raw, list):
            sg_links = sg_links_raw
        else:
            sg_links = []

        # Build link lookup: link_id → link_data
        # link could be [id, origin_id, origin_slot, target_id, target_slot, type] (list)
        # or {"id":..., "origin_id":..., "origin_slot":..., "target_id":..., "target_slot":..., "type":...} (dict)
        link_by_id = {}
        for sl in sg_links:
            if isinstance(sl, list) and len(sl) >= 5:
                link_by_id[sl[0]] = sl
            elif isinstance(sl, dict):
                lid = sl.get("id")
                if lid is not None:
                    link_by_id[lid] = sl

        def get_link_origin(link_data):
            if isinstance(link_data, list):
                return str(link_data[1]), link_data[2]
            elif isinstance(link_data, dict):
                return str(link_data.get("origin_id")), link_data.get("origin_slot")
            return None, None

        def get_link_target(link_data):
            if isinstance(link_data, list):
                return str(link_data[3]), link_data[4]
            elif isinstance(link_data, dict):
                return str(link_data.get("target_id")), link_data.get("target_slot")
            return None, None

        # Find SubgraphNodeInput and SubgraphNodeOutput proxy nodes
        sg_in_node = None
        sg_out_node = None
        for sn in sg_nodes:
            st = sn.get("type", "")
            if st in ("graph/input", "SubgraphNodeInput"):
                sg_in_node = sn
            elif st in ("graph/output", "SubgraphNodeOutput"):
                sg_out_node = sn

        prefix = f"{sg_node_id}." if prefix is None else prefix
        # 成品里这颗子图节点的 id（顶层就是 "7743"，嵌套则是 "7744.6280"）
        self_id = prefix[:-1] if prefix.endswith(".") else prefix
        sg_in_id = str(sg_in_node.get("id")) if sg_in_node else ""
        sg_out_id = str(sg_out_node.get("id")) if sg_out_node else ""

        # If no explicit proxy nodes, check for virtual IDs (negative IDs like -10, -11)
        # These are implicit subgraph boundary ports not in the nodes list
        if not sg_in_node or not sg_out_node:
            # Collect all referenced node IDs that are NOT in sg_nodes
            sg_node_ids = {str(sn.get("id")) for sn in sg_nodes}
            referenced_ids = set()
            for sl in sg_links:
                o, _ = get_link_origin(sl)
                t, _ = get_link_target(sl)
                if o and o not in sg_node_ids:
                    referenced_ids.add(o)
                if t and t not in sg_node_ids:
                    referenced_ids.add(t)
            # Negative IDs are subgraph input/output ports
            # An origin with negative ID = subgraph input (data flows IN from parent)
            # A target with negative ID = subgraph output (data flows OUT to parent)
            virtual_input_ids = {rid for rid in referenced_ids if rid.startswith("-")}
            if virtual_input_ids and not sg_in_node:
                pass  # No print

        print(f"[InterfacePackageNode] Subgraph {sg_node_id}: in_node={'yes' if sg_in_node else 'no'}({sg_in_id}) out_node={'yes' if sg_out_node else 'no'}({sg_out_id})")
        # Log subgraph inputs/outputs definitions
        sg_inputs = sg_data.get("inputs", [])
        sg_outputs = sg_data.get("outputs", [])
        # Log the subgraph node's own inputs/outputs in the parent graph
        # print(f"[InterfacePackageNode]   sg_data inputs: {sg_inputs}")
        # print(f"[InterfacePackageNode]   sg_data outputs: {sg_outputs}")
        # print(f"[InterfacePackageNode]   sg_node inputs: {sg_node.get('inputs', [])}")
        # print(f"[InterfacePackageNode]   sg_node outputs: {sg_node.get('outputs', [])}")

        # Extract internal nodes (skip proxy nodes)
        for sn in sg_nodes:
            sn_id = str(sn.get("id"))
            sn_type = sn.get("type", "")
            if sn_type in ("graph/input", "graph/output", "SubgraphNodeInput", "SubgraphNodeOutput"):
                continue

            # 子图里还套着子图（现场：7744 里的 [Config] Architecture）——
            # 不展开的话，执行时 class_type 是个 uuid，直接 SKIP，它的输出永远
            # 没有值，下游只能吃默认值（"很多 fallback"的来源之一）。
            # 递归用**本层**的 links 解边界，节点 id 再往前缀一层。
            if cls._subgraph_of(subgraph_by_type, sn_type):
                cls._expand_subgraph(sn_id, sn, subgraph_by_type, sg_links, sub_prompt,
                                     prefix=f"{prefix}{sn_id}.")
                continue

            sn_inputs = {}
            for inp in sn.get("inputs", []):
                if isinstance(inp, dict):
                    link_id = inp.get("link")
                    name = inp.get("name", "")
                    if link_id is not None and link_id in link_by_id:
                        sl = link_by_id[link_id]
                        origin, origin_slot = get_link_origin(sl)
                        # Check if origin is a proxy node (SubgraphNodeInput or virtual negative ID)
                        is_proxy_input = (origin == sg_in_id) or (origin and origin.startswith("-") and origin not in {str(sn2.get("id")) for sn2 in sg_nodes})
                        if is_proxy_input:
                            # This input comes from outside the subgraph (via SubgraphNodeInput or virtual port)
                            # The origin_slot corresponds to the parent subgraph node's input slot
                            sn_inputs[name] = {"_sg_input_slot": origin_slot}
                        else:
                            sn_inputs[name] = [f"{prefix}{origin}", origin_slot]
                    elif link_id is not None:
                        # Link ID exists but not in link_by_id — try parent graph links
                        # This happens when the link crosses subgraph boundary
                        found = False
                        for pl in links:
                            if isinstance(pl, list) and len(pl) >= 5 and pl[0] == link_id:
                                parent_origin = str(pl[1])
                                parent_origin_slot = pl[2]
                                sn_inputs[name] = [parent_origin, parent_origin_slot]
                                found = True
                                break
                        if not found:
                            print(f"[InterfacePackageNode]   WARNING: link_id {link_id} for {sn_id}.{name} not found anywhere")
                    elif link_id is None and name:
                        # Unconnected input — skip (will be filled with default at execution)
                        pass

            sub_prompt[f"{prefix}{sn_id}"] = {
                "class_type": sn_type,
                "inputs": sn_inputs,
                "_widgets_values": sn.get("widgets_values", []),
                "_widgets_names": _widget_names_of(sn),
                "_outputs_names": [o.get("name") for o in (sn.get("outputs") or [])],
                "_widgets_values_named": sn.get("widgets_values_named") or {},
                "mode": sn.get("mode", 0),
            }

        # Resolve subgraph input connections (proxy node or virtual negative IDs)
        # For each virtual input port, resolve the value from:
        # 1. sg_data.inputs[slot].name — match to injected values (pipeline/image/mask)
        # 2. sg_data.inputs[slot].widget values
        sg_node_id_set = {str(sn.get("id")) for sn in sg_nodes}
        sg_data_inputs = sg_data.get("inputs", [])

        # Build a mapping: virtual slot → input name & type
        virtual_input_map = {}  # slot → {name, type}
        for i, si in enumerate(sg_data_inputs):
            virtual_input_map[i] = {"name": si.get("name", ""), "type": si.get("type", "")}

        for sl in sg_links:
            origin, origin_slot = get_link_origin(sl)
            target_id, target_slot = get_link_target(sl)
            # Check if origin is a proxy/virtual input
            is_proxy = (sg_in_node and origin == sg_in_id) or \
                       (origin and origin.startswith("-") and origin not in sg_node_id_set)
            if not is_proxy:
                continue

            internal_target = f"{prefix}{target_id}"

            # Get the input definition for this virtual slot
            input_def = virtual_input_map.get(origin_slot, {})
            input_name = input_def.get("name", "")
            input_type = input_def.get("type", "")
            # 内部连线用的是**定义**里的槽号，父图连线用的是**实例**里的槽号；
            # 实例少一格（motion_amplitude）时两者不再相等，必须按名字换算。
            inst_slot = _instance_input_index(sg_node, input_name)

            # Resolve the value: check sg_node's input links in parent graph
            resolved = False
            # First try parent graph links
            for pl in links:
                # Support both list and dict link formats
                if isinstance(pl, list) and len(pl) >= 5:
                    pl_target_id = str(pl[3])
                    pl_target_slot = pl[4]
                    pl_origin_id = str(pl[1])
                    pl_origin_slot = pl[2]
                elif isinstance(pl, dict):
                    pl_target_id = str(pl.get("target_id", ""))
                    pl_target_slot = pl.get("target_slot", -1)
                    pl_origin_id = str(pl.get("origin_id", ""))
                    pl_origin_slot = pl.get("origin_slot", -1)
                else:
                    continue
                if pl_target_id == sg_node_id and inst_slot is not None \
                        and pl_target_slot == inst_slot:
                    if internal_target in sub_prompt:
                        for inp_name, inp_val in sub_prompt[internal_target].get("inputs", {}).items():
                            if isinstance(inp_val, dict) and inp_val.get("_sg_input_slot") == origin_slot:
                                sub_prompt[internal_target]["inputs"][inp_name] = [pl_origin_id, pl_origin_slot]
                    resolved = True
                    break

            # If not resolved via parent links, try the subgraph node's own
            # promoted widget values, then fall back to a pending virtual input
            # to be resolved at execution time using injected values
            if not resolved and internal_target in sub_prompt:
                wval = _sg_boundary_widget_value(sg_node, sg_data, origin_slot)
                if wval is not _UNRESOLVED:
                    for inp_name, inp_val in sub_prompt[internal_target].get("inputs", {}).items():
                        if isinstance(inp_val, dict) and inp_val.get("_sg_input_slot") == origin_slot:
                            sub_prompt[internal_target]["inputs"][inp_name] = wval
                elif _sg_boundary_widget_entry(sg_node, sg_data, origin_slot) is not None:
                    # 这是个 promoted widget 口，但存档里没有可信的值（比如前端把
                    # widgets_values 写多/写少了一格）。保留 _sg_input_slot 占位，
                    # 执行时直接跳过这个输入，让内部节点自己的默认值生效 ——
                    # 猜一格相邻的值（提示词串）比用默认值更糟。
                    print("[InterfacePorts] promoted widget slot %s/%s: 存档值不可信, "
                          "改用内部节点默认值" % (sg_node.get("id", "?"), origin_slot))
                else:
                    for inp_name, inp_val in sub_prompt[internal_target].get("inputs", {}).items():
                        if isinstance(inp_val, dict) and inp_val.get("_sg_input_slot") == origin_slot:
                            sub_prompt[internal_target]["inputs"][inp_name] = {
                                "_virtual_input": True,
                                "name": input_name,
                                "type": input_type,
                            }

        # Resolve subgraph output connections (proxy node or virtual negative IDs)
        output_aliases = sub_prompt.setdefault("_subgraph_output_aliases", {})
        for sl in sg_links:
            target, target_slot = get_link_target(sl)
            # Check if target is a proxy output (SubgraphNodeOutput or virtual negative ID not in sg_nodes)
            is_proxy_out = (sg_out_node and target == sg_out_id) or \
                           (target and target.startswith("-") and target not in sg_node_id_set)
            if not is_proxy_out:
                continue

            origin, origin_slot = get_link_origin(sl)
            internal_origin = f"{prefix}{origin}"
            # 记住内部节点用的是**哪个输出槽**：子图输出 N ← 内部节点 X 的第 K 个口，
            # 丢掉 K 就变成"永远读 X 的第 0 个口"。
            output_aliases[f"{self_id}:{target_slot}"] = [internal_origin, origin_slot]

        return sub_prompt

    def get_package(self, node_id, extra_pnginfo=None, unique_id=None):
        if isinstance(extra_pnginfo, list):
            extra_pnginfo = extra_pnginfo[0] if extra_pnginfo else {}
        if isinstance(node_id, list):
            node_id = node_id[0] if node_id else ""
        if not node_id:
            return (None,)

        node_id_str = str(node_id).strip()

        workflow = None
        if isinstance(extra_pnginfo, dict):
            workflow = extra_pnginfo.get("workflow") or extra_pnginfo.get("prompt")
        if not workflow or "nodes" not in workflow:
            return (None,)

        node_by_id, links, subgraph_by_type = self._build_node_lookup(workflow)

        # Find the InterfaceEndNode by ID
        end_node = node_by_id.get(node_id_str)
        if not end_node or end_node.get("type") != "InterfaceEndNode":
            return (None,)

        # Find the 'interface' input (slot 0) → start_node_id
        start_node_id = ""
        for link in links:
            if len(link) >= 5 and str(link[3]) == node_id_str and link[4] == 0:
                start_node_id = str(link[1])
                break

        # Read interface_name from start node
        interface_name = ""
        if start_node_id:
            sn = node_by_id.get(start_node_id)
            if sn and sn.get("type") == "InterfaceStartNode":
                sw = sn.get("widgets_values", [])
                if sw:
                    interface_name = str(sw[0]) if sw[0] else ""

        # Collect nodes belonging to the interface subgraph.
        #
        # Definition: the interface subgraph is the upstream-closure of End
        # (all nodes that can reach End), EXCEPT we do NOT follow past the
        # InterfaceStartNode. The Start node's own inputs are provided by
        # boundary injection (_build_injections), so its upstream (nodes before
        # Start, e.g. 7416) must NOT be executed. Any other node's upstream
        # (e.g. a model loader 7442 feeding an internal node 7443) IS part of
        # the interface and must be executed.
        #
        # This fixes the previous bug where "Start downstream ∩ End upstream"
        # wrongly excluded root nodes (no-input source nodes like loaders)
        # whose output ultimately reaches End.

        # Backward reachability from End; stop ascending once we hit Start.
        sub_graph_ids = set()
        queue = [node_id_str]
        while queue:
            nid = queue.pop(0)
            if nid in sub_graph_ids:
                continue
            sub_graph_ids.add(nid)
            # Do not follow Start's inputs further upstream — they are injected.
            if nid == start_node_id:
                continue
            for (up_origin, _, _) in self._get_node_upstream(nid, links):
                if up_origin not in sub_graph_ids:
                    queue.append(up_origin)

        # Always include Start and End
        sub_graph_ids.add(start_node_id)
        sub_graph_ids.add(node_id_str)

        # Build sub_prompt
        sub_prompt = {}
        # Map of SetNode widget names → node_id, for resolving GetNode references.
        # SetNode stores a variable name in widgets_values[0] ("Constant" widget).
        set_node_map = {}  # {var_name: set_node_id}
        get_node_refs = []  # [(get_node_id, var_name)]
        for nid in sub_graph_ids:
            n = node_by_id.get(nid)
            if not n:
                continue

            node_type = n.get("type", "")

            # Track SetNode/GetNode (KJNodes virtual nodes — pure frontend,
            # no backend class). They must be resolved to direct connections.
            if node_type == "SetNode":
                wv = n.get("widgets_values", [])
                if wv and wv[0]:
                    set_node_map[wv[0]] = nid
                # SetNode itself is skipped, but its upstream must still be
                # traversed so the real source node is included in sub_graph_ids.
                for (up_origin, _, _) in self._get_node_upstream(nid, links):
                    if up_origin not in sub_graph_ids:
                        queue.append(up_origin)
                continue  # Don't add SetNode to sub_prompt
            elif node_type == "GetNode":
                wv = n.get("widgets_values", [])
                if wv and wv[0]:
                    get_node_refs.append((nid, wv[0]))
                # GetNode is skipped — its upstream is the SetNode's upstream,
                # which is already handled by SetNode traversal above.
                continue  # Don't add GetNode to sub_prompt

            # Check if this is a subgraph node
            if _find_subgraph(subgraph_by_type, node_type):
                self._expand_subgraph(nid, n, subgraph_by_type, links, sub_prompt)
                continue

            # Regular node
            inputs = self._get_node_inputs(n, links)
            # Keep ALL links — internal links will be resolved from output_values,
            # external links will be resolved at execution time from extra_pnginfo
            #
            # InterfaceStartNode's inputs that point outside the subgraph (its
            # upstream, e.g. 7416) are boundary-injected values, NOT nodes to
            # execute. Drop those links so Start takes the injected valueN kwargs
            # instead of trying to evaluate a node before Start.
            if nid == start_node_id:
                filtered = {}
                for name, link in inputs.items():
                    origin_id = str(link[0]) if isinstance(link, (list, tuple)) else str(link)
                    if origin_id not in sub_graph_ids:
                        # External source → provided by injection, not executed.
                        continue
                    filtered[name] = link
                inputs = filtered
            wv = n.get("widgets_values", [])
            sub_prompt[nid] = {
                "class_type": node_type,
                "inputs": inputs,
                "_widgets_values": wv,
                "_widgets_names": _widget_names_of(n),
                "_outputs_names": [o.get("name") for o in (n.get("outputs") or [])],
                "_widgets_values_named": n.get("widgets_values_named") or {},
                "mode": n.get("mode", 0),
            }

        # Resolve GetNode references: replace any link pointing to a GetNode
        # with the actual upstream link from its corresponding SetNode's input.
        # GetNode/SetNode are pure frontend virtual nodes (KJNodes) with no
        # backend class — ComfyUI's frontend resolves them during prompt
        # serialization via getInputLink(), but interface sub_prompt is built
        # directly from workflow JSON so we must do the resolution here.
        if get_node_refs:
            # Build a link lookup: link_id → [origin_id, origin_slot, ...]
            link_by_id_local = {}
            for link in links:
                if isinstance(link, list) and len(link) >= 5:
                    link_by_id_local[link[0]] = link

            # If SetNode wasn't found in sub_graph_ids (e.g. it's outside the
            # interface subgraph), search the entire workflow for it by name.
            if not set_node_map:
                for sn_id, sn_node in node_by_id.items():
                    if sn_node.get("type") == "SetNode":
                        sn_wv = sn_node.get("widgets_values", [])
                        if sn_wv and sn_wv[0]:
                            set_node_map[sn_wv[0]] = sn_id

            # For each GetNode, find its SetNode's input link and record the
            # mapping: get_node_id → (real_origin_id, real_origin_slot)
            get_resolution = {}  # {get_node_id: [origin_id, origin_slot]}
            for get_nid, var_name in get_node_refs:
                set_nid = set_node_map.get(var_name)
                if not set_nid:
                    print(f"[InterfacePackageNode] WARNING: GetNode '{var_name}' has no matching SetNode")
                    continue
                set_node = node_by_id.get(set_nid, {})
                # SetNode has one input (slot 0) — find the link connected to it
                set_inputs = set_node.get("inputs", [])
                resolved = False
                for si in set_inputs:
                    if isinstance(si, dict):
                        lid = si.get("link")
                        if lid is not None and lid in link_by_id_local:
                            sl = link_by_id_local[lid]
                            real_origin = str(sl[1])
                            real_slot = sl[2]
                            get_resolution[get_nid] = [real_origin, real_slot]
                            # Ensure the real source node is in sub_graph_ids
                            if real_origin not in sub_graph_ids:
                                sub_graph_ids.add(real_origin)
                                # Also add it to sub_prompt
                                rn = node_by_id.get(real_origin)
                                if rn:
                                    r_inputs = self._get_node_inputs(rn, links)
                                    sub_prompt[real_origin] = {
                                        "class_type": rn.get("type", ""),
                                        "inputs": r_inputs,
                                        "_widgets_values": rn.get("widgets_values", []),
                                        "_widgets_names": _widget_names_of(rn),
                                        "_outputs_names": [o.get("name") for o in (rn.get("outputs") or [])],
                                        "_widgets_values_named": rn.get("widgets_values_named") or {},
                                        "mode": rn.get("mode", 0),
                                    }
                            resolved = True
                            break
                if not resolved:
                    # SetNode input might be unconnected — value is from widget or None
                    print(f"[InterfacePackageNode] WARNING: SetNode '{var_name}' has no connected input")

            # Replace all references to GetNode IDs in sub_prompt links
            if get_resolution:
                for nid, node in sub_prompt.items():
                    node_inputs = node.get("inputs", {})
                    for name, val in list(node_inputs.items()):
                        if is_link(val):
                            origin_id = str(val[0])
                            if origin_id in get_resolution:
                                real_link = get_resolution[origin_id]
                                node_inputs[name] = real_link
                                print(f"[InterfacePackageNode] Resolved GetNode link: {nid}.{name} → {real_link[0]}:{real_link[1]}")
        types = {}
        for link in links:
            if len(link) >= 5 and str(link[3]) == node_id_str and link[4] >= 1:
                link_type = link[5] if len(link) > 5 else "*"
                if link_type and link_type != "*":
                    types[link[4]] = link_type

        # Read port_types from Start and End nodes' hidden widget
        # port_types is a hidden STRING widget — in extra_pnginfo it's stored in widgets_values
        # but the order depends on which visible widgets exist first.
        # InterfaceStartNode: required=interface_name (STRING), hidden=port_types (STRING)
        # InterfaceEndNode: required=interface (INTERFACE - not a widget), hidden=port_types (STRING)
        # So for Start: widgets_values = [interface_name, port_types]
        # For End: widgets_values = [port_types] (interface is a link, not a widget)

        start_node = node_by_id.get(start_node_id, {})
        end_wv = end_node.get("widgets_values", []) if end_node else []

        start_port_types = {}
        end_port_types = {}

        # port_types 是隐藏 STRING widget，不会被序列化到 widgets_values。
        # 直接从节点的 inputs 数组 + links 推断类型（与 JS updatePortTypesWidget 同逻辑）。
        import re as _re
        link_by_id = {}
        for link in links:
            if isinstance(link, list) and len(link) >= 5:
                link_by_id[link[0]] = link

        def infer_port_types(node_obj, from_outputs=False):
            """从节点的 inputs 数组推断 {port_num_str: type_str}。
            from_outputs: 输入侧说不出具体类型时, 认这个节点自己的输出槽类型。"""
            result = {}
            for inp in (node_obj.get("inputs") or []):
                if not isinstance(inp, dict):
                    continue
                name = inp.get("name", "")
                m = _re.match(r"value(\d+)", name)
                if not m:
                    continue
                port_num = m.group(1)
                link_id = inp.get("link")
                if link_id is None:
                    continue
                link = link_by_id.get(link_id)
                if link and len(link) >= 6:
                    lt = link[5]
                    if lt and lt != "*":
                        result[port_num] = lt
            # Start 的 value 端口类型是前端算出来的, 规则是"输入侧优先, 输入侧是任意
            # 类型时借下游端口那条线的类型"。上游是 AnyPass 这类 `*` 输出口时, 输入侧
            # 连线冻在 `*` (前端建线时 commonType 把 `*` 剔掉后只剩下游的类型, 而这里
            # 两边都是 `*`), 于是这份类型只存在于 Start 自己的输出槽上 —— 它同样进存档。
            # 输入侧能说话时仍然输入侧赢, 与前端 resolveStartPortType 的优先级一致。
            if from_outputs:
                for out in (node_obj.get("outputs") or []):
                    if not isinstance(out, dict):
                        continue
                    m = _re.match(r"value(\d+)", out.get("name", ""))
                    if not m:
                        continue
                    port_num = m.group(1)
                    if port_num in result:
                        continue
                    ot = out.get("type")
                    if ot and ot != "*":
                        result[port_num] = ot
            return result

        start_port_types = infer_port_types(start_node, from_outputs=True)
        end_port_types = infer_port_types(end_node)

        # ── 端口的展示名与默认值: 从"这一口喂到的那个内部节点输入"算出来 ──────────
        # 不新存一份真值: 画布上你给内部节点设的那个输入(名字 + widget 值)就是这一口在
        # Interface 里该显示的名字和默认值。widgets_values 与"带 widget 键的输入"同序对齐
        # (既有连线又有 widget 的输入照样占一格), 两者数量对不上就说明这份存档的格子数不准,
        # 宁可不给默认值也不猜。IMAGE/MASK 这类非 widget 输入没有默认值, 只有名字。
        _no_widget_value = object()

        def _class_input_default(class_type, input_name):
            """第二档: 类定义 INPUT_TYPES 里写着的 default —— 新建节点时空着的那格
            ComfyUI 自己就是填的这个。存档那条读不到时才用它, 且只在类确实声明了
            default 时用; 没有就仍然留空, 不编数字。"""
            try:
                import nodes as comfy_nodes
                cls = comfy_nodes.NODE_CLASS_MAPPINGS.get(class_type or '')
                it = cls.INPUT_TYPES() if cls else None
            except Exception:
                return _no_widget_value
            # 候选表写了、却没写 default 的 COMBO (像 sampler_node 的 preset / embeds_scaling
            # 那种 ([...],) 写法, 节点作者很常这么写)。ComfyUI 自己的 widget 就是落在候选第一项,
            # 所以这里也照第一项 —— 否则 COMBO 口会算出"没有默认值": 面板摆一个空框, 实跑注入
            # None, 界面上看到的和图里跑的不是同一个值。
            combo_first = None
            if not isinstance(it, dict):
                return _no_widget_value
            for cat in ('required', 'optional'):
                ci = it.get(cat)
                if not isinstance(ci, dict):
                    continue
                spec = ci.get(input_name)
                if not isinstance(spec, (tuple, list)) or not len(spec):
                    continue
                for extra in spec[1:]:
                    if isinstance(extra, dict) and 'default' in extra:
                        return extra['default']
                if combo_first is None and isinstance(spec[0], (list, tuple)) and len(spec[0]):
                    combo_first = str(spec[0][0])
            return combo_first if combo_first is not None else _no_widget_value

        def _widget_value_of_input(node_obj, entry_idx):
            # 存档里 widgets_values 是**一条无名字的数组**, 只能按"inputs[] 里带 widget 的
            # 槽位顺序"对齐去读。对齐一旦不成立就宁可不给默认值 —— 猜错数字比没有数字更坏。
            # 三种失败各有各的说法, 面板上"框里只有 placeholder"时打的就是这几行。
            who = "%s#%s value-input[%s]" % (node_obj.get('type', '?'), node_obj.get('id', '?'), entry_idx)
            ins = node_obj.get("inputs") or []
            entry = ins[entry_idx] if 0 <= entry_idx < len(ins) else None
            if not isinstance(entry, dict) or "widget" not in entry:
                print("[InterfacePorts] 默认值缺席 %s: 这条输入在存档里没有 widget (%s), "
                      "它是个连线口" % (who, 'no entry' if not isinstance(entry, dict) else 'widget key missing'))
                return _no_widget_value
            # 新前端的命名表按名字给值, 不受数组长度错位影响, 优先用。
            named = node_obj.get("widgets_values_named")
            if isinstance(named, dict):
                for nm in _widget_entry_names(entry):
                    if nm in named and named[nm] is not None:
                        return named[nm]
            wv = node_obj.get("widgets_values")
            if not isinstance(wv, list):
                print("[InterfacePorts] 默认值缺席 %s: 存档里没有 widgets_values 数组 (是 %s)"
                      % (who, type(wv).__name__))
                return _no_widget_value
            widget_slots = [i for i, e in enumerate(ins)
                            if isinstance(e, dict) and "widget" in e]
            if len(widget_slots) != len(wv):
                print("[InterfacePorts] 默认值缺席 %s: 带 widget 的输入槽 %d 个, widgets_values "
                      "%d 项, 对不齐 (槽=%s / 值=%s)"
                      % (who, len(widget_slots), len(wv), widget_slots,
                         [type(x).__name__ for x in wv][:12]))
                return _no_widget_value
            pos = widget_slots.index(entry_idx)
            return wv[pos]

        start_labels = {}    # {port: 第一个被喂到的输入名}
        start_defaults = {}  # {port: 第一个带 widget 的被喂输入的存档值}
        start_targets = {}   # {port: {'class_type', 'input_name'}} 供 COMBO 取候选项
        for out in (start_node.get("outputs") or []):
            m = _re.match(r"value(\d+)$", out.get("name", "") or "")
            if not m:
                continue
            port = m.group(1)
            for link_id in (out.get("links") or []):
                link = link_by_id.get(link_id)
                if not link or len(link) < 5:
                    continue
                tgt = node_by_id.get(str(link[3]))
                t_ins = (tgt or {}).get("inputs") or []
                ti = link[4]
                if not tgt or not (0 <= ti < len(t_ins)):
                    continue
                entry = t_ins[ti]
                in_name = entry.get("name") if isinstance(entry, dict) else None
                if not isinstance(in_name, str) or not in_name:
                    continue
                start_labels.setdefault(port, in_name)
                if port not in start_targets and isinstance(entry, dict) and "widget" in entry:
                    start_targets[port] = {"class_type": tgt.get("type", ""),
                                           "input_name": in_name}
                    val = _widget_value_of_input(tgt, ti)
                    _src = '存档'
                    if val is _no_widget_value:
                        val = _class_input_default(tgt.get('type', ''), in_name)
                        _src = '类默认'
                    if val is not _no_widget_value:
                        start_defaults[port] = val
                        print("[InterfacePorts] 默认值 value%s <- %s#%s.%s (%s)"
                              % (port, tgt.get('type', '?'), tgt.get('id', '?'), in_name, _src))

        # ── 端口类型诊断 ─────────────────────────────────────────────────
        # 一份存档里能证明"这个口是什么类型"的一共四个地方: 输入槽 / 输入线 / 输出槽 /
        # 输出线。逐口全打出来, 空口就能直接看出是前端没写、线冻在 `*`、还是这份存档
        # 根本就不是当前那张图。
        print("[InterfacePorts] build '%s' start=%s end=%s source=%s wf_nodes=%d links=%d subgraph=%d"
              % (interface_name, start_node_id, node_id_str,
                 "workflow" if "nodes" in workflow else "prompt",
                 len(workflow.get("nodes") or []), len(links), len(sub_graph_ids)))

        def _dump_port_types(node_obj, side, resolved, extras=None):
            by_name_in = {i.get("name"): i for i in (node_obj.get("inputs") or [])
                          if isinstance(i, dict)}
            by_name_out = {o.get("name"): o for o in (node_obj.get("outputs") or [])
                           if isinstance(o, dict)}
            names = [k for k in set(list(by_name_in) + list(by_name_out))
                     if k and _re.match(r"value(\d+)$", k)]
            for name in sorted(names, key=lambda n: int(n[5:])):
                port = _re.match(r"value(\d+)$", name).group(1)
                inp = by_name_in.get(name) or {}
                out = by_name_out.get(name) or {}
                in_link = link_by_id.get(inp.get("link"))
                in_wire = str(in_link[5]) if in_link and len(in_link) >= 6 else "-"
                out_wires = sorted({str(link_by_id[l][5]) for l in (out.get("links") or [])
                                    if l in link_by_id and len(link_by_id[l]) >= 6})
                print("[InterfacePorts]   %-5s %-7s in_slot=%-13s in_wire=%-13s "
                      "out_slot=%-13s out_wire=%-13s => %s%s"
                      % (side, name, inp.get("type") or "-", in_wire,
                         out.get("type") or "-", ",".join(out_wires) or "-",
                         resolved.get(port) or "MISSING",
                         ("  " + extras[port]) if extras and port in extras else ""))

        def _derived_note(port):
            parts = []
            if port in start_labels:
                parts.append("name=%s" % start_labels[port])
            if port in start_defaults:
                parts.append("default=%r" % (start_defaults[port],))
            else:
                parts.append("default=-")
            return " ".join(parts)

        _dump_port_types(start_node, "START", start_port_types,
                         {p: _derived_note(p) for p in start_labels})
        _dump_port_types(end_node, "END", end_port_types)

        # Collect subgraph node widget values and input definitions
        # These are used to resolve virtual inputs that aren't connected to Start
        sg_widget_values = {}  # {sg_node_id: widgets_values}
        sg_input_defs = []     # [{name, type}] from all subgraph nodes' definitions
        for nid in sub_graph_ids:
            n = node_by_id.get(nid)
            if not n:
                continue
            node_type = n.get("type", "")
            if _find_subgraph(subgraph_by_type, node_type):
                sg = _find_subgraph(subgraph_by_type, node_type)
                sg_widget_values[nid] = n.get("widgets_values", [])
                for si in sg.get("inputs", []):
                    sg_input_defs.append({"name": si.get("name", ""), "type": si.get("type", ""), "sg_node_id": nid})

        package = {
            "name": interface_name,
            "types": end_port_types,
            "start_types": start_port_types,
            "start_labels": start_labels,
            "start_defaults": start_defaults,
            "start_targets": start_targets,
            "values": {},
            "start_node_id": start_node_id,
            "end_node_id": node_id_str,
            "sub_prompt": sub_prompt,
            "sg_widget_values": sg_widget_values,
            "sg_input_defs": sg_input_defs,
        }
        return (package,)


class InterfaceCaptureNode:
    """Capture node: receives PACKAGE output from InterfaceEndNode and stores it.
    Used as OUTPUT_NODE in sub-prompt execution to capture results."""
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "package": ("PACKAGE",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt_id": "PROMPT_ID",
            }
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "capture"
    CATEGORY = "Kolid-Toolkit"
    OUTPUT_NODE = True

    def capture(self, package, unique_id=None, prompt_id=None):
        if prompt_id:
            _interface_captures.setdefault(prompt_id, []).append(package)
        return {}


class PackageMergeNode:
    """Merge a variable number of PACKAGE inputs into a single PACKAGE (list) output.

    The frontend (javascript/interface_node.js) keeps exactly one empty trailing
    input slot, adding `packageN` slots as inputs get connected and trimming
    trailing empties on disconnect — same dynamic-slot design as BranchSwitchesNode.
    """

    @classmethod
    def INPUT_TYPES(cls):
        dyn_inputs = {"package1": ("PACKAGE", {"tooltip": "Connect a package to add another input slot."})}
        # ComfyUI calls INPUT_TYPES() from get_input_info() while validating a
        # specific (possibly dynamic) input name; accept any `packageN` then.
        stack = inspect.stack()
        if stack[2].function == "get_input_info":
            class AllContainer:
                def __contains__(self, item):
                    return True

                def __getitem__(self, key):
                    return "PACKAGE", {}
            dyn_inputs = AllContainer()

        return {
            "required": {},
            "optional": dyn_inputs,
        }

    RETURN_TYPES = ("PACKAGE",)
    RETURN_NAMES = ("package",)
    FUNCTION = "merge"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def merge(self, **kwargs):
        def sort_key(key):
            suffix = key[len("package"):]
            return int(suffix) if suffix.isdigit() else 0

        packages = []
        for key in sorted((k for k in kwargs if k.startswith("package")), key=sort_key):
            pkg = kwargs.get(key)
            if pkg is None:
                continue
            if isinstance(pkg, list):
                for item in pkg:
                    if isinstance(item, dict):
                        packages.append(item)
                    elif isinstance(item, list):
                        packages.extend([x for x in item if isinstance(x, dict)])
            elif isinstance(pkg, dict):
                packages.append(pkg)
        print(f"[PackageMergeNode] Merged {len(packages)} packages")
        return (packages,)


class PipelinePackageNode:
    """Takes a node_id (pivot node), analyzes all PIPELINE_DATA inputs
    connected to that node from the graph, outputs a PACKAGE with pipeline refs.

    The pivot node is any node in the workflow that has PIPELINE_DATA input connections.
    PipelinePackageNode does NOT execute upstream nodes — it only collects graph structure.
    Actual pipeline data is obtained at interaction time via InterfaceExecutor._try_execute_external.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "node_id": ("STRING", {"default": "", "multiline": False, "tooltip": "Node ID of the pivot node whose PIPELINE_DATA inputs will be collected"}),
            },
            "hidden": {
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("PACKAGE",)
    RETURN_NAMES = ("package",)
    FUNCTION = "get_package"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    @staticmethod
    def _infer_node_title(node_obj, subgraph_by_type=None):
        """Infer a display title for a node from its properties."""
        title = node_obj.get("title", "")
        if title:
            return title
        node_type = node_obj.get("type", "Unknown")
        # If type is a subgraph UUID, look up the subgraph's name
        sg = InterfacePackageNode._subgraph_of(subgraph_by_type or {}, node_type)
        if sg is not None:
            sg_name = sg.get("name", "")
            if sg_name:
                return sg_name
        return node_type

    def get_package(self, node_id, extra_pnginfo=None, unique_id=None):
        if isinstance(extra_pnginfo, list):
            extra_pnginfo = extra_pnginfo[0] if extra_pnginfo else {}
        if isinstance(node_id, list):
            node_id = node_id[0] if node_id else ""
        if not node_id:
            return (None,)

        node_id_str = str(node_id).strip()

        workflow = None
        if isinstance(extra_pnginfo, dict):
            workflow = extra_pnginfo.get("workflow") or extra_pnginfo.get("prompt")
        if not workflow or "nodes" not in workflow:
            return (None,)

        node_by_id, links, subgraph_by_type = InterfacePackageNode._build_node_lookup(workflow)

        pivot_node = node_by_id.get(node_id_str)
        if not pivot_node:
            return (None,)

        # Find all PIPELINE_DATA inputs on the pivot node
        pipelines = []
        for inp in pivot_node.get("inputs", []):
            if not isinstance(inp, dict):
                continue
            link_id = inp.get("link")
            if link_id is None:
                continue
            # Find the link to get origin node + type
            for link in links:
                if isinstance(link, list) and len(link) >= 6 and link[0] == link_id:
                    origin_id = str(link[1])
                    origin_slot = link[2]
                    link_type = link[5]
                    if link_type == "PIPELINE_DATA":
                        origin_node = node_by_id.get(origin_id)
                        name = self._infer_node_title(origin_node, subgraph_by_type) if origin_node else f"Pipeline {len(pipelines) + 1}"
                        pipelines.append({
                            "name": name,
                            "node_id": origin_id,
                            "origin_slot": origin_slot,
                        })
                    break

        pkg = {
            "type": "pipeline",
            "name": self._infer_node_title(pivot_node, subgraph_by_type),
            "pipelines": pipelines,
            "node_id": node_id_str,
        }
        print(f"[PipelinePackageNode] Collected {len(pipelines)} pipelines from pivot node {node_id_str}")
        return (pkg,)


# =============================================================================
# InterfaceExecutor — 执行 interface 子图的引擎
# =============================================================================
class InterfaceExecutor:
    """执行 InterfaceStartNode → InterfaceEndNode 之间的子图。
    通过回调接口注入值和提取结果，不直接依赖 SnapshotDetailerSamplerNode。"""

    def __init__(self, extra_pnginfo=None, on_progress=None,
                 get_pipeline=None, get_image=None, get_mask=None,
                 on_result_image=None, on_result_pipeline=None,
                 on_sampler_progress=None):
        """
        Args:
            extra_pnginfo: 完整前端工作流 JSON（含 definitions.subgraphs）
            on_progress: callback(current_step, total_steps) 更新节点执行进度
            get_pipeline: callback() → PipelineData，用于注入 PIPELINE_DATA 类型端口
            get_image: callback() → IMAGE tensor，用于注入 IMAGE 类型端口
            get_mask: callback() → MASK tensor，用于注入 MASK 类型端口
            on_result_image: callback(image_tensor, name) 处理输出的 IMAGE
            on_result_pipeline: callback(pipeline_data, name) 处理输出的 PIPELINE_DATA
            on_sampler_progress: callback(current, total, node_id) 更新采样进度
        """
        self.extra_pnginfo = extra_pnginfo
        self.on_progress = on_progress
        self.get_pipeline = get_pipeline
        self.get_image = get_image
        self.get_mask = get_mask
        self.on_result_image = on_result_image
        self.on_result_pipeline = on_result_pipeline
        self.on_sampler_progress = on_sampler_progress
        self._sg_widget_values = {}  # Set during execute from pkg
        self._sg_input_defs = []
        # nid → {输入名: "来源节点:输出槽"}；只用来把"类型不对/回退"的日志指回那根线。
        self._link_src = {}
        self._guard_nodes = set()   # 已经打印过连线表的节点（每个节点只打一次）
        self._sub_prompt = {}       # 当前这次执行的 sub_prompt（日志追溯用）
        # Allow List：这一次 execute 是不是按"一列图"跑（见 execute 的 list_mode）。
        self.list_mode = False
        # 与最近一次 execute() 的 results 逐条对齐的端口号 —— 离线 processor 按
        # 「哪个 end 端口出的这张图/mask」落位，靠它对表。
        self.result_ports = []

    def execute(self, pkg, manual_values=None, port_overrides=None, list_mode=False):
        """执行一个 interface package。
        Args:
            pkg: InterfacePackageNode 输出的 PACKAGE dict
            manual_values: {port_num: value} 手动输入值（STRING/INT/FLOAT/BOOLEAN）
            port_overrides: {port_num: value} 端口级覆盖值（优先于回调注入）；
                list_mode 下 image/mask 口的覆盖值可以是**一列**（list of tensor）
            list_mode: Allow List —— 内部节点按 INPUT_IS_LIST 分流（直通 list / 逐帧跑再合并）
        Returns:
            list of extracted values (images, pipelines, etc.)
        """
        manual_values = manual_values or {}
        self.list_mode = bool(list_mode)
        start_id = pkg.get('start_node_id', '')
        end_id = pkg.get('end_node_id', '')
        interface_name = pkg.get('name', '')
        if not start_id or not end_id:
            raise ValueError("Package missing start_node_id or end_node_id")

        # 1. 从 EXTRA_PNGINFO 重建 sub_prompt（含子图内部节点）
        self._rebuild_package(pkg, end_id)
        self._sg_widget_values = pkg.get('sg_widget_values', {})
        self._sg_input_defs = pkg.get('sg_input_defs', [])

        sub_prompt = pkg.get('sub_prompt', {})
        if not sub_prompt:
            raise RuntimeError("Package has no sub_prompt")
        self._sub_prompt = sub_prompt   # 日志里追"值到底来自哪根线"要用

        print(f"[InterfaceExecutor] === Starting '{interface_name}' ===")
        print(f"[InterfaceExecutor] start={start_id} end={end_id} start_types={pkg.get('start_types', {})} nodes={list(sub_prompt.keys())}")

        # 2. 注入值
        injections = self._build_injections(pkg, manual_values)
        if port_overrides:
            for port_num, val in port_overrides.items():
                if val is not None:
                    pn = int(port_num) if isinstance(port_num, str) else port_num
                    injections[pn] = val
        _interface_injections[start_id] = injections
        print(f"[InterfaceExecutor] Injected {len(injections)} values")

        try:
            # 3. Widget 映射
            self._map_all_widgets(sub_prompt)

            # 4. 懒求值：从 End 节点开始递归求值
            output_values = {}
            self._eval_cache = output_values
            self._eval_stack = set()  # 循环检测
            self._link_src = {}       # nid → {输入名: "来源节点:输出槽"}，只用于日志定位
            self._guard_nodes = set()
            self._eval_count = 0
            self._eval_total = len([n for n in sub_prompt if not n.startswith("_")])

            self._evaluate_node(end_id, sub_prompt, start_id, end_id, pkg, output_values)

            # 5. 提取结果
            results = self._extract_results(pkg, end_id, output_values, interface_name)
            print(f"[InterfaceExecutor] === Done: {len(results)} results ===")
            return results
        finally:
            _interface_injections.pop(start_id, None)
            print(f"[InterfaceExecutor] Cleared injections for {start_id}")

    # ---- 内部方法 ----

    def _rebuild_package(self, pkg, end_id):
        """从 EXTRA_PNGINFO 重建 sub_prompt"""
        epi = self.extra_pnginfo
        if isinstance(epi, list):
            epi = epi[0] if epi else {}
        if epi and isinstance(epi, dict):
            pkg_node = InterfacePackageNode()
            fresh = pkg_node.get_package(end_id, epi, None)
            if fresh and fresh[0] and fresh[0].get('sub_prompt'):
                pkg.clear()
                pkg.update(fresh[0])
                print(f"[InterfaceExecutor] Rebuilt: {len(pkg.get('sub_prompt', {}))} nodes")

    def _build_injections(self, pkg, manual_values):
        """构建注入值字典 — 基于 Start 节点的端口类型"""
        injections = {}
        start_types = pkg.get('start_types', {})
        manual_keys = sorted({str(k) for k in (manual_values or {})})
        for port_num_str, port_type in start_types.items():
            port_num = int(port_num_str) if isinstance(port_num_str, str) else port_num_str
            if port_type == 'MASK' and self.get_mask:
                injections[port_num] = self.get_mask()
                _src = 'mask(画面)'
            elif port_type == 'IMAGE' and self.get_image:
                injections[port_num] = self.get_image()
                _src = 'image(画面)'
            elif port_type == 'PIPELINE_DATA' and self.get_pipeline:
                injections[port_num] = self.get_pipeline()
                _src = 'pipeline(画面)'
            elif str(port_num) in manual_values or port_num in manual_values:
                mv = manual_values.get(str(port_num), manual_values.get(port_num))
                if port_type == 'INT' and mv is not None:
                    injections[port_num] = int(mv)
                elif port_type == 'FLOAT' and mv is not None:
                    injections[port_num] = float(mv)
                elif port_type == 'BOOLEAN' and mv is not None:
                    injections[port_num] = str(mv).lower() in ('true', '1', 'yes')
                else:
                    injections[port_num] = mv
                _src = 'manual'
            else:
                # 面板没送这个口 —— 用你在画布上给这一口喂到的那个输入设的值, 而不是 None。
                # 面板显示的默认值和实跑的值因此是同一次计算, 不会出现"看着 1、跑的是 None"。
                dv = (pkg.get('start_defaults') or {}).get(str(port_num))
                tgt = (pkg.get('start_targets') or {}).get(str(port_num)) or {}
                injections[port_num] = dv
                _src = ('存档默认值(%s.%s)' % (tgt.get('class_type', '?'), tgt.get('input_name', '?'))
                        if dv is not None else 'NONE(面板没送, 存档也没设这个口)')
            print("[InterfacePorts] inject start=%s port=%s type=%-13s <- %s"
                  % (pkg.get('start_node_id'), port_num, port_type, _src))
        # 面板送来的口与 start_types 完全对不上时, 上面的循环一个都不会走到 —— 只打差集
        unused = [k for k in manual_keys
                  if k not in {str(p) for p in start_types} and k.isdigit()]
        if unused:
            print("[InterfacePorts] inject start=%s manual_values 里有但 start_types 没有的口: %s"
                  % (pkg.get('start_node_id'), ",".join(unused)))
        return injections

    def _map_all_widgets(self, sub_prompt):
        """对所有节点做 widget 值映射"""
        import nodes as comfy_nodes
        for nid, node in sub_prompt.items():
            if nid.startswith("_"):
                continue
            widgets_values = node.pop("_widgets_values", [])
            widgets_named = node.pop("_widgets_values_named", None)
            widgets_names = node.pop("_widgets_names", None)
            if not widgets_values and not widgets_named:
                continue
            class_type = node.get("class_type", "")
            class_def = comfy_nodes.NODE_CLASS_MAPPINGS.get(class_type)
            if not class_def:
                continue
            widget_dict = self._build_widget_dict(class_def, widgets_values, widgets_named, widgets_names)
            for name, val in widget_dict.items():
                existing = node.get("inputs", {}).get(name)
                if isinstance(existing, dict) and existing.get("_virtual_input"):
                    # Virtual input placeholder — replace with actual widget value
                    node["inputs"][name] = val
                elif name not in node.get("inputs", {}):
                    node["inputs"][name] = val

    @staticmethod
    def _build_widget_dict(class_def, widgets_values, widgets_values_named=None, widgets_names=None):
        """从 widgets_values 数组（或前端的命名表）构建 {name: typed_value} 字典。

        新前端会把值按名字写进 ``widgets_values_named``：DynamicCombo 的子输入在
        那里就是 ``resize_type.width`` 这种点号名，而位置表 ``widgets_values`` 里
        它们是展开后的若干槽位，单靠 INPUT_TYPES 的顶层声明序对不出来。所以优先
        用命名表；其次是存档自带的 widget 名字表（``inputs[].widget.name``，能扛住
        节点包增删 widget 造成的格子数不一致）；两者都没有才按声明序消费。
        """
        import inspect as _inspect
        if not widgets_values and not widgets_values_named:
            return {}
        try:
            input_types = class_def.INPUT_TYPES()
        except Exception:
            return {}
        func_name = getattr(class_def, "FUNCTION", "execute")
        func = getattr(class_def, func_name, None)
        if func is None:
            return {}
        # If FUNCTION is EXECUTE_NORMALIZED (new ComfyNode API), use the real execute method for signature
        if func_name == "EXECUTE_NORMALIZED":
            real_func = getattr(class_def, "execute", None)
            if real_func is not None:
                func = real_func
        try:
            sig = _inspect.signature(func)
        except Exception:
            return {}
        # Only keep named parameters (POSITIONAL_OR_KEYWORD, KEYWORD_ONLY), skip *args/**kwargs/self
        param_names = [
            p for p, v in sig.parameters.items()
            if v.kind in (_inspect.Parameter.POSITIONAL_OR_KEYWORD, _inspect.Parameter.KEYWORD_ONLY, _inspect.Parameter.POSITIONAL_ONLY)
            and p != 'self'
        ]
        declared = []  # [(name, type, opts)] in INPUT_TYPES order
        for cat in ("required", "optional"):
            ci = input_types.get(cat, {})
            if not isinstance(ci, dict):
                continue
            for name, val in ci.items():
                if not isinstance(val, tuple) or len(val) < 1:
                    continue
                t = val[0]
                opts = val[1] if len(val) >= 2 and isinstance(val[1], dict) else {}
                declared.append((name, t, opts))
        declared_names = {n for n, _t, _o in declared}

        # 无论有没有位置表，都先按 INPUT_TYPES 建一张 name → 标量类型表：
        # 命名表的值也要过一遍类型收敛（前端命名表里可能留着字符串形式）。
        link_names = set(input_types.get("hidden") or {})
        widget_types = {}
        widget_params = []  # [(name, type, opts)]
        for name, t, opts in declared:
            # All hidden inputs are system-provided, never mapped from widgets_values
            if opts.get("forceInput", False):
                link_names.add(name)
                continue
            if isinstance(t, str) and t in ("STRING", "INT", "FLOAT", "BOOLEAN", "COMBO", "COMFY_DYNAMICCOMBO_V3"):
                # New ComfyUI API nodes use string type tags like "COMBO";
                # old API nodes use a raw list for combo boxes.
                widget_types[name] = t
                widget_params.append((name, t, opts))
            elif isinstance(t, list):
                widget_types[name] = "COMBO"
                widget_params.append((name, t, opts))
            elif isinstance(opts.get("options"), list):
                # io_type 不是字符串的 DynamicCombo 变体
                widget_types[name] = "COMFY_DYNAMICCOMBO_V3"
                widget_params.append((name, t, opts))
            else:
                link_names.add(name)

        def _coerce_values(d):
            for name, val in list(d.items()):
                if val is None:
                    continue
                wt = widget_types.get(name, "")
                if wt == "INT":
                    try: d[name] = int(val)
                    except (ValueError, TypeError): pass
                elif wt == "FLOAT":
                    try: d[name] = float(val)
                    except (ValueError, TypeError): pass
                elif wt == "BOOLEAN":
                    if isinstance(val, str):
                        d[name] = val.lower() in ("true", "1", "yes")
                    else:
                        d[name] = bool(val)
            return d

        # 1. 新前端：按名字给值。点号子输入原样保留；丢掉 control_after_generate
        #    这类只属于前端的伪字段（execute 的签名里没有，传进去会 TypeError）。
        named_result = {}
        if isinstance(widgets_values_named, dict):
            for name, val in widgets_values_named.items():
                if val is None:
                    continue
                if name in declared_names or name in param_names or "." in str(name):
                    named_result[name] = val
        if not widgets_values:
            return _coerce_values(named_result)

        # 2. 存档自带 widget 名字表：按名字对齐（能扛住节点包增删 widget）
        by_name = _widgets_by_stored_names(widget_params, widgets_names, widgets_values)
        if by_name is not None:
            by_name.update(named_result)
            return _coerce_values(by_name)

        # 3. 旧工作流：按位置消费。
        # 存档里 widgets_values 是前端按 INPUT_TYPES 声明序摆的, 消费也必须按这个序 ——
        # 有些第三方节点 (如 essentials 的 ImageResize) execute 签名把两个参数写反了,
        # 按签名序对位会把 method 的值喂给 interpolation。签名里有但 INPUT_TYPES 没声明的
        # 参数 (前端画不出 widget, 不占槽) 只在还有剩余槽位时才消费。
        seen = {n for n, _t, _o in widget_params}
        widget_params += [(p, None, {}) for p in param_names
                          if p not in link_names and p not in seen]

        def _dynamic_slots(name, opts, selected):
            """DynamicCombo 选中 option 后，它的子输入各占一个后续槽位。"""
            slots = []
            for opt in (opts.get("options") or []):
                if opt.get("key") != selected:
                    continue
                for cat in ("required", "optional"):
                    for sub_name, sub_val in ((opt.get("inputs") or {}).get(cat) or {}).items():
                        sub_t = sub_val[0] if isinstance(sub_val, (tuple, list)) and sub_val else None
                        key = f"{name}.{sub_name}"
                        if isinstance(sub_t, str) and sub_t in ("STRING", "INT", "FLOAT", "BOOLEAN", "COMBO"):
                            widget_types[key] = sub_t
                        slots.append((key, sub_t, {}))
                break
            return slots

        result = {}
        val_idx = 0
        queue = list(widget_params)
        qi = 0
        while qi < len(queue) and val_idx < len(widgets_values):
            name, t, opts = queue[qi]
            qi += 1
            if isinstance(t, str) and t == "COMFY_DYNAMICCOMBO_V3":
                selected = widgets_values[val_idx]
                val_idx += 1
                result[name] = selected
                queue[qi:qi] = _dynamic_slots(name, opts, selected)
                continue
            result[name] = widgets_values[val_idx]
            val_idx += 1
            if opts.get("control_after_generate") and val_idx < len(widgets_values):
                val_idx += 1
        _coerce_values(result)
        # 命名表是前端当前状态，优先于按位置猜出来的值
        result.update(named_result)
        return _coerce_values(result)

    def _evaluate_node(self, nid, sub_prompt, start_id, end_id, pkg, output_values):
        """从 End 节点开始递归求值（懒求值）。
        
        只有被下游节点实际需要的节点才会被执行。
        支持 ComfyUI 的 check_lazy_status 机制：
        - 先用已有输入调用 check_lazy_status，获取需要的 input 名称列表
        - 只递归求值那些需要的上游节点
        - 对没有 check_lazy_status 的节点，求值所有 link 输入
        """
        import nodes as comfy_nodes

        # 0. 缓存检查
        if nid in output_values:
            return output_values[nid]

        # 中断检查：在每个节点执行前检查 ComfyUI 的 interrupt 状态
        mm.throw_exception_if_processing_interrupted()

        # 循环检测
        if nid in self._eval_stack:
            raise RuntimeError(f"Circular dependency detected at node {nid}")
        self._eval_stack.add(nid)

        try:
            node = sub_prompt[nid]
            class_type = node.get("class_type", "")
            class_def = comfy_nodes.NODE_CLASS_MAPPINGS.get(class_type)
            if not class_def:
                print(f"[InterfaceExecutor] SKIP {nid}: '{class_type}' not found")
                output_values[nid] = ()
                return output_values[nid]

            # 节点 mode（前端工作流原样带过来）：4 = Bypass（不执行函数，输入按类型
            # 穿透到输出，与前端 graphToPrompt 的重连规则一致）；2 = Mute（不执行）。
            # 之前不看 mode，bypass 掉的 LoRA/guidance 节点在子图里照样执行并打补丁。
            _mode = node.get("mode", 0)
            if _mode == 4:
                output_values[nid] = self._bypass_passthrough(
                    nid, node, class_def, sub_prompt, start_id, end_id, pkg, output_values)
                print(f"[InterfaceExecutor]   BYPASS {nid} ({class_type}) → "
                      f"passthrough {[(type(v).__name__ if v is not None else 'None') for v in output_values[nid]]}")
                return output_values[nid]
            if _mode == 2:
                print(f"[InterfaceExecutor]   SKIP {nid} ({class_type}): muted (mode=2)")
                output_values[nid] = ()
                return output_values[nid]

            self._eval_count += 1
            if self.on_progress:
                self.on_progress(self._eval_count, self._eval_total)
            print(f"[InterfaceExecutor] ({self._eval_count}/{self._eval_total}) {nid} ({class_type})")

            node_inputs = node.get("inputs", {})

            # 1. 第一遍：解析非 link 输入 + 注入 hidden 输入
            inputs = {}
            pending_links = {}  # name -> (origin_id, output_slot)

            import json as _json
            if nid == end_id:
                inputs["port_types"] = _json.dumps({str(k): v for k, v in pkg.get('types', {}).items()})
            if nid == start_id:
                inputs["port_types"] = _json.dumps({str(k): v for k, v in pkg.get('start_types', {}).items()})
                inputs["unique_id"] = start_id

            src_map = self._link_src.setdefault(nid, {})
            for name, val in node_inputs.items():
                if is_link(val):
                    origin_id = str(val[0])
                    output_slot = int(val[1])
                    aliases = sub_prompt.get("_subgraph_output_aliases", {})
                    alias_key = f"{origin_id}:{output_slot}"
                    if alias_key in aliases:
                        origin_id, output_slot = _alias_target(aliases[alias_key])
                    src_map[name] = f"{origin_id}:{output_slot}"
                    # 检查是否已缓存
                    resolved = self._resolve_link(origin_id, output_slot, sub_prompt, start_id, end_id, pkg, output_values, nid, name)
                    if resolved is not _UNRESOLVED:
                        inputs[name] = resolved
                    else:
                        pending_links[name] = (origin_id, output_slot)
                elif isinstance(val, dict) and val.get("_virtual_input"):
                    inputs[name] = self._resolve_virtual(val, output_values, start_id)
                elif isinstance(val, dict) and "_sg_input_slot" in val:
                    pass  # Unresolved, skip
                else:
                    inputs[name] = val

            # 2. 填充默认值（在 lazy check 之前，让 check_lazy_status 能看到 widget 值）
            #    同时收集 optional 输入名称，供 check_lazy_status 调用时填充 None
            optional_names = set()
            try:
                it = class_def.INPUT_TYPES()
                for rn, rd in it.get("required", {}).items():
                    if rn not in inputs and isinstance(rd, tuple) and len(rd) >= 2:
                        opts = rd[1] if isinstance(rd[1], dict) else {}
                        if opts.get("default") is not None:
                            inputs[rn] = opts["default"]
                        elif isinstance(rd[0], list) and rd[0]:
                            inputs[rn] = rd[0][0]
                for on in it.get("optional", {}):
                    optional_names.add(on)
            except Exception:
                pass

            # 3. 懒求值：check_lazy_status
            has_lazy = callable(getattr(class_def, "check_lazy_status", None))

            if has_lazy:
                # 用已有输入（pending links 设为 None）调用 check_lazy_status
                # 同时把所有未连接的 optional 输入也以 None 填入，
                # 这样 check_lazy_status 的 **kwargs 才能看到完整的 optional 输入列表
                lazy_inputs = dict(inputs)
                for name in pending_links:
                    lazy_inputs[name] = None
                for on in optional_names:
                    if on not in lazy_inputs and on not in pending_links:
                        lazy_inputs[on] = None
                obj_tmp = class_def()
                try:
                    required = obj_tmp.check_lazy_status(**lazy_inputs)
                    print(f"[InterfaceExecutor]   check_lazy_status returned: {required}")
                except Exception as _lazy_err:
                    print(f"[InterfaceExecutor]   check_lazy_status exception: {_lazy_err}")
                    required = None

                if required:
                    # 只求值 check_lazy_status 声明需要的输入
                    for name in required:
                        if name in pending_links:
                            origin_id, output_slot = pending_links[name]
                            self._eval_link(origin_id, output_slot, sub_prompt, start_id, end_id, pkg, output_values, nid)
                            val = self._get_output(origin_id, output_slot, output_values)
                            if val is not _UNRESOLVED:
                                inputs[name] = val
                                del pending_links[name]
                        else:
                            # 未连线的 optional 输入：保持 None，让节点函数能通过 kwargs 访问
                            inputs[name] = None
                    # 未被 check_lazy_status 要求的 pending links 跳过（懒求值）
                else:
                    # check_lazy_status 返回 None 或抛异常：回退到求值所有 pending links
                    for name, (origin_id, output_slot) in list(pending_links.items()):
                        self._eval_link(origin_id, output_slot, sub_prompt, start_id, end_id, pkg, output_values, nid)
                        val = self._get_output(origin_id, output_slot, output_values)
                        if val is not _UNRESOLVED:
                            inputs[name] = val
                            del pending_links[name]
                    # 填充所有未连接的 optional 输入为 None
                    for on in optional_names:
                        if on not in inputs:
                            inputs[on] = None

            else:
                # 没有 check_lazy_status：求值所有 pending links
                for name, (origin_id, output_slot) in list(pending_links.items()):
                    self._eval_link(origin_id, output_slot, sub_prompt, start_id, end_id, pkg, output_values, nid)
                    val = self._get_output(origin_id, output_slot, output_values)
                    if val is not _UNRESOLVED:
                        inputs[name] = val
                        del pending_links[name]

            # 3.5 送进节点前统一 IMAGE 输入的通道数：工作台合成的图是 RGBA，
            #     第三方节点按 ComfyUI 的 [B,H,W,3] 契约做 normalize，拿到 4 通道
            #     会在广播 mean/std 时直接崩（DepthAnything 等 preprocessor 典型）。
            self._coerce_image_inputs(class_type, class_def, inputs)

            # 3.6 标量类型对齐：存档/连线偶尔把 FLOAT/INT 口喂成字符串（widget
            #     格子错位、或口接错线）。第三方节点直接拿去做 `str > float` 会在
            #     很深的地方才炸，这里先按 INPUT_TYPES 收敛；收不拢就用类默认值并留一行日志。
            self._coerce_scalar_inputs(nid, class_def, inputs)

            # 4. 执行节点
            _dbg = []
            for _k, _v in inputs.items():
                if hasattr(_v, 'shape'):
                    _dbg.append(f"{_k}={tuple(_v.shape)}")
                elif hasattr(_v, 'model'):
                    _dbg.append(f"{_k}=PipelineData")
                elif _v is None:
                    _dbg.append(f"{_k}=None")
                else:
                    _dbg.append(f"{_k}={type(_v).__name__}")
            print(f"[InterfaceExecutor]   inputs: {_dbg}")
            if pending_links:
                print(f"[InterfaceExecutor]   pending_links: {list(pending_links.keys())}")
            if has_lazy:
                print(f"[InterfaceExecutor]   optional_names: {sorted(optional_names)}")

            try:
                obj = class_def()
                func = getattr(obj, getattr(class_def, "FUNCTION", "execute"))
                is_list_node = bool(getattr(class_def, "INPUT_IS_LIST", False))
                # Allow List（list_mode）：list 输入按**这个节点**是不是 INPUT_IS_LIST 分流 ——
                #  * INPUT_IS_LIST：整列直接进（ComfyUI 的约定就是所有入参都是 list）；
                #  * 否则：逐帧跑一遍（每个 list 输入按下标对齐，短的用最后一帧补），
                #    产物按输出槽位合并回 list —— 下游拿到的还是"一列"。
                # Start / End 两个边界节点不参与：它们是管道不是处理器，list 原样穿透
                # （Start 的输出槽就是那列，End 收下那列交给 _extract_results 拆）。
                frame_inputs = ({} if (nid == start_id or nid == end_id)
                                else self._list_frame_inputs(inputs)) if self.list_mode else {}
                if frame_inputs and not is_list_node:
                    n_runs = len(next(iter(frame_inputs.values())))
                    runs = []
                    for i in range(n_runs):
                        mm.throw_exception_if_processing_interrupted()
                        one = dict(inputs)
                        for _k, _v in frame_inputs.items():
                            one[_k] = _v[i] if i < len(_v) else _v[-1]
                        runs.append(self._call_node(class_def, func, one, nid, is_list_node))
                    output_values[nid] = self._merge_list_runs(runs)
                    print(f"[InterfaceExecutor]   list-map ×{n_runs} → "
                          f"{len(output_values[nid])} output slots (merged)")
                else:
                    output_values[nid] = self._call_node(class_def, func, inputs, nid, is_list_node)
                print(f"[InterfaceExecutor]   → {len(output_values[nid])} outputs")
            except Exception as e:
                import traceback
                traceback.print_exc()
                raise RuntimeError(f"Node {nid} ({class_type}) failed: {e}")
        finally:
            self._eval_stack.discard(nid)

        return output_values[nid]

    # ---- Allow List：逐帧跑 + 合并 ----

    @staticmethod
    def _is_scalar(v):
        return v is None or isinstance(v, (str, int, float, bool))

    @classmethod
    def _list_frame_inputs(cls, inputs):
        """inputs 里那些"一列值"的入口：list 且不是纯标量列。

        list 模式下一列只可能来自两处：边界注入（视频逐帧拆出来的帧列）和上游被 map
        过的节点的合并输出。纯标量列（widget 值之类）不算 —— 它们进节点就该是单个值。
        """
        out = {}
        for k, v in inputs.items():
            if isinstance(v, list) and v and not all(cls._is_scalar(x) for x in v):
                out[k] = v
        return out

    @staticmethod
    def _v3_class_clone(class_def, nid):
        """V3 节点（IO.ComfyNode）执行前必须 clone 一份并注入 hidden。

        core 里由 map_node_over_list → PREPARE_CLASS_CLONE 完成这件事；我们直接拿
        注册表里的原类执行时，class 上的 hidden 恒为 None（_ComfyNodeBaseInternal
        的类属性默认值），GetImageSize 这类读 hidden.unique_id 的节点会在 execute
        里抛 AttributeError: 'NoneType' object has no attribute 'unique_id'。
        """
        try:
            from comfy_api.internal import _ComfyNodeInternal
            from comfy_api.latest._io import Hidden
        except Exception:
            return class_def
        try:
            if not (isinstance(class_def, type) and issubclass(class_def, _ComfyNodeInternal)):
                return class_def
            return class_def.PREPARE_CLASS_CLONE({"hidden_inputs": {Hidden.unique_id: nid}})
        except Exception as e:
            print(f"[InterfaceExecutor]   V3 clone failed {nid}: {e}")
            return class_def

    @staticmethod
    def _nest_v3_dynamic_inputs(class_def, inputs, nid):
        """V3 Schema 的 DynamicCombo / DynamicSlot 输入在 prompt 里是点号路径
        （resize_type.width、resize_type.height），而 execute 收到的是嵌套 dict
        （resize_type={"resize_type": "scale dimensions", "width": ...}）。

        core 在 execution.py 的 map_node_over_list 里用 build_nested_inputs 做这一步；
        这里直接照搬，否则 kwargs 里会多出 'resize_type.width' 这种参数，节点报
        TypeError: execute() got an unexpected keyword argument。同时把未激活的
        动态选项（例如换成按倍率缩放后残留的 resize_type.width）过滤掉。
        """
        if not any("." in str(k) for k in inputs):
            return inputs
        try:
            from comfy_api.internal import _ComfyNodeInternal
            from comfy_api.latest import _io as _io_v3
        except Exception:
            return inputs
        try:
            if not (isinstance(class_def, type) and issubclass(class_def, _ComfyNodeInternal)):
                return inputs
        except Exception:
            return inputs
        try:
            valid_inputs, _hidden, v3_data = _io_v3.get_finalized_class_inputs(
                class_def.INPUT_TYPES(), inputs)
            if not v3_data.get("dynamic_paths"):
                return inputs
            if not getattr(class_def, "ACCEPT_ALL_INPUTS", False):
                known = (set(valid_inputs.get("required") or {}) |
                         set(valid_inputs.get("optional") or {}))
                inputs = {k: v for k, v in inputs.items() if k in known}
            return _io_v3.build_nested_inputs(inputs, v3_data)
        except Exception as e:
            print(f"[InterfaceExecutor]   V3 nested inputs failed {nid}: {e}")
            return inputs

    def _call_node(self, class_def, func, inputs, nid, is_list_node):
        """跑一次节点：INPUT_IS_LIST 的约定包装 + 采样进度钩子 + 宿主返回约定解开。
        map 路径里每一帧都走这一句，所以钩子的安装/卸载必须在每次调用内自成一对。"""
        v3_cls = self._v3_class_clone(class_def, nid)
        if v3_cls is not class_def:
            # 重新绑定到 clone 上，execute 里才能读到 clone.hidden
            func = getattr(v3_cls, getattr(class_def, "FUNCTION", "execute"))
        if not is_list_node:
            # DynamicCombo 的点号路径必须先收成嵌套 dict 再进 execute
            inputs = self._nest_v3_dynamic_inputs(class_def, inputs, nid)
        if is_list_node:
            inputs = {k: [v] if not isinstance(v, list) else v for k, v in inputs.items()}
        orig_hook = None
        if self.on_sampler_progress:
            try:
                import comfy.utils
                orig_hook = comfy.utils.PROGRESS_BAR_HOOK
                def _sampler_hook(current, total, preview=None, **kwargs):
                    if self.on_sampler_progress:
                        self.on_sampler_progress(current, total, nid)
                comfy.utils.set_progress_bar_global_hook(_sampler_hook)
            except Exception:
                pass
        try:
            result = func(**inputs)
        finally:
            if orig_hook is not None:
                try:
                    import comfy.utils
                    comfy.utils.set_progress_bar_global_hook(orig_hook)
                except Exception:
                    pass
        # 宿主约定 (execution.py:359 get_output_from_returns): 节点返回
        # {"ui": ..., "result": (...)} 时 result 才是出参, ui 给前端。KJNodes 的
        # GetImageSizeAndCount 等这么写; 不解开就只有一个 dict 出参, 下游按槽位
        # 取值全部落空, 输入会静默退回 widget 默认值。
        if isinstance(result, dict):
            result = result.get("result", ())
        if result is None:
            result = ()
        else:
            # Unwrap ComfyNode API NodeOutput objects
            try:
                from comfy_api.latest._io import NodeOutput
                if isinstance(result, NodeOutput):
                    result = tuple(result.args) if result.args else ()
            except ImportError:
                pass
            if not isinstance(result, tuple):
                result = (result,)
        return result

    @staticmethod
    def _merge_list_runs(runs):
        """逐帧跑的产物按输出槽位合并回 list（转置）：第 i 槽收齐每次跑的第 i 个出参。
        下游因此拿到的还是"一列"—— INPUT_IS_LIST 的节点直接吃，非 list 的再 map 一遍。"""
        if not runs:
            return ()
        n_slots = len(runs[0])
        merged = []
        for slot in range(n_slots):
            merged.append([r[slot] if slot < len(r) else None for r in runs])
        return tuple(merged)

    # ---- link 解析辅助 ----

    def _bypass_passthrough(self, nid, node, class_def, sub_prompt, start_id, end_id, pkg, output_values):
        """mode=4（Bypass）：不执行节点函数，把连接的输入按类型穿透到对应输出。

        与前端 graphToPrompt 对被 bypass 节点的重连规则一致：每个输出槽找第一个
        **类型相同**的未占用连线输入；类型对不上时回退到第一个未占用的连线输入。
        （KSampler bypass 时 LATENT 输出接的是 latent_image 而不是第一个输入 model，
        证明前端是按类型而非按序号穿透。）
        """
        input_types = {}
        try:
            it = class_def.INPUT_TYPES()
            for _cat in ("required", "optional"):
                for _name, _rd in (it.get(_cat) or {}).items():
                    if isinstance(_rd, tuple) and len(_rd) >= 1 and isinstance(_rd[0], str):
                        input_types[_name] = _rd[0]
        except Exception:
            pass
        aliases = sub_prompt.get("_subgraph_output_aliases", {})
        used = set()
        node_inputs = node.get("inputs", {})
        result = []
        for _slot, out_type in enumerate(getattr(class_def, "RETURN_TYPES", ()) or ()):
            picked = None
            for _name, _val in node_inputs.items():
                if is_link(_val) and _name not in used and input_types.get(_name) == out_type:
                    picked = _name
                    break
            if picked is None:
                for _name, _val in node_inputs.items():
                    if is_link(_val) and _name not in used and _name in input_types:
                        picked = _name
                        break
            if picked is None:
                result.append(None)
                continue
            used.add(picked)
            _link = node_inputs[picked]
            origin_id, output_slot = str(_link[0]), int(_link[1])
            _alias_key = f"{origin_id}:{output_slot}"
            if _alias_key in aliases:
                origin_id, output_slot = _alias_target(aliases[_alias_key])
            self._eval_link(origin_id, output_slot, sub_prompt, start_id, end_id, pkg, output_values, nid)
            _v = self._get_output(origin_id, output_slot, output_values)
            result.append(None if _v is _UNRESOLVED else _v)
        return tuple(result)

    def _resolve_link(self, origin_id, output_slot, sub_prompt, start_id, end_id, pkg, output_values, nid, name):
        """尝试从缓存解析 link 输出，返回值或 _UNRESOLVED"""
        # 直接缓存
        if origin_id in output_values:
            ot = output_values[origin_id]
            if output_slot < len(ot):
                return ot[output_slot]
            return _UNRESOLVED

        # End 节点的 value 输入 → 从 Start 输出回溯
        if nid == end_id and name.startswith("value"):
            import re as _re
            m = _re.match(r"value(\d+)", name)
            if m:
                pn = int(m.group(1))
                so = output_values.get(start_id, ())
                if pn < len(so):
                    return so[pn]

        # prefix 匹配
        for ov_key in output_values:
            if ov_key.endswith("." + origin_id):
                ot = output_values[ov_key]
                if output_slot < len(ot):
                    return ot[output_slot]
                return _UNRESOLVED

        return _UNRESOLVED

    def _eval_link(self, origin_id, output_slot, sub_prompt, start_id, end_id, pkg, output_values, nid=None):
        """递归求值一个 link 引用的上游节点"""
        # 已缓存
        if origin_id in output_values:
            return

        # End 节点的 value 输入 → 从 Start 输出回溯
        # (这里不需要，_resolve_link 已处理)

        # prefix 匹配
        for ov_key in output_values:
            if ov_key.endswith("." + origin_id):
                return

        # 在 sub_prompt 中 → 递归求值
        if origin_id in sub_prompt:
            self._evaluate_node(origin_id, sub_prompt, start_id, end_id, pkg, output_values)
            return

        # 边界外节点（InterfaceStartNode 之前 / 不在 interface 子图内）
        # interface 子图是封闭的，只允许通过 Start 边界注入与外界交互。
        # 不再递归执行外部节点（那会把 Start 之前的节点一并拉进来执行），
        # 而是尝试从 Start 节点的注入输出解析该边界输入；解析不到则明确报错。
        resolved = self._resolve_external_boundary(origin_id, output_slot, sub_prompt, start_id, end_id, pkg, output_values)
        if not resolved:
            raise RuntimeError(
                f"[InterfaceExecutor] Node {nid}: input links to node '{origin_id}' "
                f"which is outside the interface subgraph (before InterfaceStartNode). "
                f"Interface nodes may only reference nodes within the interface or values "
                f"injected through the InterfaceStartNode boundary."
            )

    def _get_output(self, origin_id, output_slot, output_values):
        """从 output_values 取值，支持 prefix 匹配"""
        if origin_id in output_values:
            ot = output_values[origin_id]
            if output_slot < len(ot):
                return ot[output_slot]
        for ov_key in output_values:
            if ov_key.endswith("." + origin_id):
                ot = output_values[ov_key]
                if output_slot < len(ot):
                    return ot[output_slot]
        return _UNRESOLVED

    def _resolve_external_boundary(self, origin_id, output_slot, sub_prompt, start_id, end_id, pkg, output_values):
        """尝试将 interface 边界外的 link 解析为 Start 节点注入的边界输入。

        interface 子图是封闭的：子图内节点引用的外部值，只能通过 InterfaceStartNode
        的注入输出（由 _build_injections 注入的 PIPELINE_DATA / IMAGE / MASK 等）提供。
        这里先在已缓存的 Start 输出里按 alias 匹配，匹配不到则返回 False，由调用方报错。
        """
        # Start 节点已被执行，其注入输出就在 output_values[start_id]
        start_outputs = output_values.get(start_id, ())
        if not start_outputs:
            return False

        # 1) 通过 subgraph_output_aliases 把外部节点映射到 Start 的某个输出端口
        aliases = sub_prompt.get("_subgraph_output_aliases", {})
        alias_key = f"{origin_id}:{output_slot}"
        if alias_key in aliases:
            mapped, mapped_slot = _alias_target(aliases[alias_key])
            # mapped 是一个 boundary 节点 id，其输出被 alias 到 Start 的某个端口
            mapped_outputs = output_values.get(mapped, ())
            if mapped_outputs and len(mapped_outputs) > mapped_slot:
                return True

        # 2) 直接按 (origin_id, output_slot) 在 Start 注入输出里查找
        #    interface 内部节点若经 Start 边界连接，其 link 的 origin 应为 start_id，
        #    因此走到这里的 origin 是越界节点；这里仅做前缀兜底匹配，避免误判。
        for ov_key in output_values:
            if ov_key.endswith("." + origin_id):
                ot = output_values[ov_key]
                if output_slot < len(ot):
                    return True

        return False

    def _resolve_virtual(self, val, output_values, start_id):
        """解析子图虚拟输入（子图边界端口在父图未连线时产生）。
        
        注入只发生在 Start 节点处（通过 _build_injections）。
        这里不猜测、不 fallback——找不到值就报错。
        """
        vname = val.get("name", "")
        vtype = val.get("type", "")

        # Note: promoted widget boundary inputs are resolved eagerly from the
        # subgraph node's widgets_values in _expand_subgraph, so they never
        # reach this point. Placeholders here are genuinely unconnected ports.

        raise ValueError(
            f"Unresolved virtual input: name={vname!r}, type={vtype!r}. "
            f"This subgraph boundary port has no connection in the parent graph. "
            f"Either connect it to an external node, or ensure the Start node "
            f"provides a matching port type."
        )

    def _expand_nested_subgraph(self, sn_id, sn, subgraph_by_type, parent_links, sub_prompt, parent_prefix, parent_sg_node_id, parent_sg_data, output_values):
        """递归展开嵌套 subgraph 节点的内部节点到 sub_prompt 中。"""
        sg_type = sn.get("type", "")
        sg_data = _find_subgraph(subgraph_by_type, sg_type)
        if not sg_data:
            print(f"[InterfaceExecutor] Nested subgraph {sn_id}: type '{sg_type}' not found in subgraph definitions")
            return

        nested_sg_nodes = sg_data.get("nodes", [])
        nested_sg_links_raw = sg_data.get("links", [])
        if isinstance(nested_sg_links_raw, dict):
            nested_sg_links = list(nested_sg_links_raw.values())
        elif isinstance(nested_sg_links_raw, list):
            nested_sg_links = nested_sg_links_raw
        else:
            nested_sg_links = []

        nested_link_by_id = {}
        for sl in nested_sg_links:
            if isinstance(sl, list) and len(sl) >= 5:
                nested_link_by_id[sl[0]] = sl
            elif isinstance(sl, dict):
                lid = sl.get("id")
                if lid is not None:
                    nested_link_by_id[lid] = sl

        def get_origin(ld):
            if isinstance(ld, list): return str(ld[1]), ld[2]
            if isinstance(ld, dict): return str(ld.get("origin_id")), ld.get("origin_slot")
            return None, None

        def get_target(ld):
            if isinstance(ld, list): return str(ld[3]), ld[4]
            if isinstance(ld, dict): return str(ld.get("target_id")), ld.get("target_slot")
            return None, None

        nested_prefix = parent_prefix + sn_id + "."
        nested_sg_id_set = {str(n.get("id")) for n in nested_sg_nodes}

        # Find nested output proxy for alias mapping
        nested_out_node = None
        for n in nested_sg_nodes:
            if n.get("type") in ("graph/output", "SubgraphNodeOutput"):
                nested_out_node = n
                break

        for n in nested_sg_nodes:
            n_id = str(n.get("id"))
            n_type = n.get("type", "")
            if n_type in ("graph/input", "graph/output", "SubgraphNodeInput", "SubgraphNodeOutput"):
                continue
            # Double-nested subgraph
            if _find_subgraph(subgraph_by_type, n_type):
                self._expand_nested_subgraph(nested_prefix + n_id, n, subgraph_by_type, nested_sg_links, sub_prompt, nested_prefix, sn_id, sg_data, output_values)
                continue

            n_inputs = {}
            for inp in n.get("inputs", []):
                if not isinstance(inp, dict):
                    continue
                lid = inp.get("link")
                nm = inp.get("name", "")
                if lid is not None and lid in nested_link_by_id:
                    ld = nested_link_by_id[lid]
                    origin, origin_slot = get_origin(ld)
                    origin_node_obj = next((x for x in nested_sg_nodes if str(x.get("id")) == origin), None)
                    is_virtual = origin and origin.startswith("-") and origin not in nested_sg_id_set
                    if (origin_node_obj and origin_node_obj.get("type") in ("graph/input", "SubgraphNodeInput")) or is_virtual:
                        # Boundary input — resolve from parent subgraph's links or parent graph
                        resolved = False
                        # 定义槽号 → 实例下标（实例可能少一格，见 _instance_input_index）
                        ndefs = sg_data.get("inputs") or []
                        _def_name = (ndefs[origin_slot].get("name", "")
                                     if 0 <= origin_slot < len(ndefs) and isinstance(ndefs[origin_slot], dict) else "")
                        inst_slot = _instance_input_index(sn, _def_name)
                        # Check parent subgraph links (the subgraph containing sn)
                        for pl in parent_links:
                            if isinstance(pl, list) and len(pl) >= 5 and str(pl[3]) == sn_id \
                                    and inst_slot is not None and pl[4] == inst_slot:
                                p_origin = str(pl[1])
                                p_slot = pl[2]
                                # Resolve from parent sub_prompt or parent graph
                                p_prefixed = parent_prefix + p_origin
                                if p_prefixed in sub_prompt:
                                    n_inputs[nm] = [p_prefixed, p_slot]
                                elif p_origin in output_values and p_slot < len(output_values[p_origin]):
                                    n_inputs[nm] = output_values[p_origin][p_slot]
                                else:
                                    n_inputs[nm] = [p_origin, p_slot]
                                resolved = True
                                break
                        if not resolved:
                            # Check if PIPELINE_DATA can be injected
                            sg_inputs_defs = sg_data.get("inputs", [])
                            if origin_slot < len(sg_inputs_defs):
                                inp_def = sg_inputs_defs[origin_slot]
                                if inp_def.get("type") == "PIPELINE_DATA" and self.get_pipeline is not None:
                                    n_inputs[nm] = self.get_pipeline()
                                    resolved = True
                        if not resolved:
                            # Promoted widget input — value lives on the nested subgraph node's widgets_values
                            wval = _sg_boundary_widget_value(sn, sg_data, origin_slot)
                            if wval is not _UNRESOLVED:
                                n_inputs[nm] = wval
                                resolved = True
                        if not resolved:
                            print(f"[InterfaceExecutor]   Nested subgraph input slot {origin_slot} unresolved for {nested_prefix + n_id}.{nm}")
                    else:
                        n_inputs[nm] = [nested_prefix + origin, origin_slot]
                elif lid is not None:
                    # Try parent links
                    for pl in parent_links:
                        if isinstance(pl, list) and len(pl) >= 5 and pl[0] == lid:
                            n_inputs[nm] = [str(pl[1]), pl[2]]
                            break
            sub_prompt[nested_prefix + n_id] = {
                "class_type": n_type,
                "inputs": n_inputs,
                "_widgets_values": n.get("widgets_values", []),
                "_widgets_names": _widget_names_of(n),
                "_outputs_names": [o.get("name") for o in (n.get("outputs") or [])],
                "_widgets_values_named": n.get("widgets_values_named") or {},
                "mode": n.get("mode", 0),
            }

        # Map nested subgraph outputs to its internal output proxy's inputs
        if nested_out_node:
            nested_out_id = str(nested_out_node.get("id"))
            for sl in nested_sg_links:
                target, target_slot = get_target(sl)
                if target == nested_out_id:
                    origin, origin_slot = get_origin(sl)
                    internal_origin = nested_prefix + origin
                    aliases = sub_prompt.setdefault("_subgraph_output_aliases", {})
                    aliases[parent_prefix + sn_id + ":" + str(target_slot)] = [internal_origin, origin_slot]
        else:
            # No explicit output proxy — check virtual negative IDs
            for sl in nested_sg_links:
                target, target_slot = get_target(sl)
                if target and target.startswith("-") and target not in nested_sg_id_set:
                    origin, origin_slot = get_origin(sl)
                    internal_origin = nested_prefix + origin
                    aliases = sub_prompt.setdefault("_subgraph_output_aliases", {})
                    aliases[parent_prefix + sn_id + ":" + str(target_slot)] = [internal_origin, origin_slot]

    def _try_execute_subgraph(self, sg_node_id, sg_node, subgraph_by_type, links, output_values):
        """展开并执行一个 ComfyUI subgraph 节点，返回其输出 tuple。"""
        sg_type = sg_node.get("type", "")
        sg_data = _find_subgraph(subgraph_by_type, sg_type)
        if not sg_data:
            raise RuntimeError(f"Subgraph {sg_node_id}: type '{sg_type}' not found in subgraph definitions")

        sg_nodes = sg_data.get("nodes", [])
        sg_links_raw = sg_data.get("links", [])
        # Normalize links
        if isinstance(sg_links_raw, dict):
            sg_links = list(sg_links_raw.values())
        elif isinstance(sg_links_raw, list):
            sg_links = sg_links_raw
        else:
            sg_links = []

        # Build link lookup
        link_by_id = {}
        for sl in sg_links:
            if isinstance(sl, list) and len(sl) >= 5:
                link_by_id[sl[0]] = sl
            elif isinstance(sl, dict):
                lid = sl.get("id")
                if lid is not None:
                    link_by_id[lid] = sl

        def get_link_origin(link_data):
            if isinstance(link_data, list):
                return str(link_data[1]), link_data[2]
            elif isinstance(link_data, dict):
                return str(link_data.get("origin_id")), link_data.get("origin_slot")
            return None, None

        def get_link_target(link_data):
            if isinstance(link_data, list):
                return str(link_data[3]), link_data[4]
            elif isinstance(link_data, dict):
                return str(link_data.get("target_id")), link_data.get("target_slot")
            return None, None

        # Find output proxy node (graph/output or SubgraphNodeOutput)
        sg_out_node = None
        for sn in sg_nodes:
            if sn.get("type") in ("graph/output", "SubgraphNodeOutput"):
                sg_out_node = sn
                break

        prefix = f"{sg_node_id}."
        sg_node_id_set = {str(sn.get("id")) for sn in sg_nodes}

        # Expand internal nodes into sub_prompt (skip proxy nodes)
        sub_prompt = {}
        for sn in sg_nodes:
            sn_id = str(sn.get("id"))
            sn_type = sn.get("type", "")
            if sn_type in ("graph/input", "graph/output", "SubgraphNodeInput", "SubgraphNodeOutput"):
                continue
            # Check if this is a nested subgraph node — recursively expand
            if _find_subgraph(subgraph_by_type, sn_type):
                self._expand_nested_subgraph(sn_id, sn, subgraph_by_type, links, sub_prompt, prefix, sg_node_id, sg_data, output_values)
                continue
            sn_inputs = {}
            for inp in sn.get("inputs", []):
                if isinstance(inp, dict):
                    link_id = inp.get("link")
                    name = inp.get("name", "")
                    if link_id is not None and link_id in link_by_id:
                        sl = link_by_id[link_id]
                        origin, origin_slot = get_link_origin(sl)
                        is_proxy_input = (origin and origin.startswith("-") and origin not in sg_node_id_set) or \
                                         (sg_out_node and origin == str(sg_out_node.get("id")))
                        # Actually we need to check if origin is graph/input proxy
                        origin_node_obj = next((n for n in sg_nodes if str(n.get("id")) == origin), None)
                        is_virtual_input = origin and origin.startswith("-") and origin not in sg_node_id_set
                        if (origin_node_obj and origin_node_obj.get("type") in ("graph/input", "SubgraphNodeInput")) or is_virtual_input:
                            # This input comes from subgraph boundary (proxy node or virtual negative ID)
                            # origin_slot 是**定义**槽号；父图连线用的是**实例**下标，按名字换算
                            resolved = False
                            _defs = sg_data.get("inputs") or []
                            _dname = (_defs[origin_slot].get("name", "")
                                      if 0 <= origin_slot < len(_defs) and isinstance(_defs[origin_slot], dict) else "")
                            inst_slot = _instance_input_index(sg_node, _dname)
                            for pl in links:
                                if isinstance(pl, list) and len(pl) >= 5:
                                    if str(pl[3]) == sg_node_id and inst_slot is not None and pl[4] == inst_slot:
                                        parent_origin = str(pl[1])
                                        parent_origin_slot = pl[2]
                                        if parent_origin in output_values and parent_origin_slot < len(output_values[parent_origin]):
                                            sn_inputs[name] = output_values[parent_origin][parent_origin_slot]
                                        else:
                                            ext = self._try_execute_external(parent_origin, output_values)
                                            if ext is not None and parent_origin_slot < len(ext):
                                                sn_inputs[name] = ext[parent_origin_slot]
                                        resolved = True
                                        break
                            if not resolved:
                                # Check if it's a PIPELINE_DATA input that can be injected
                                sg_inputs_defs = sg_data.get("inputs", [])
                                if origin_slot < len(sg_inputs_defs):
                                    inp_def = sg_inputs_defs[origin_slot]
                                    if inp_def.get("type") == "PIPELINE_DATA" and self.get_pipeline is not None:
                                        sn_inputs[name] = self.get_pipeline()
                                        resolved = True
                            if not resolved:
                                # Promoted widget input — value lives on the subgraph node's widgets_values
                                wval = _sg_boundary_widget_value(sg_node, sg_data, origin_slot)
                                if wval is not _UNRESOLVED:
                                    sn_inputs[name] = wval
                                    resolved = True
                            if not resolved:
                                print(f"[InterfaceExecutor]   Subgraph input slot {origin_slot} unresolved for {sn_id}.{name}")
                        else:
                            sn_inputs[name] = [prefix + origin, origin_slot]
                    elif link_id is not None:
                        # Try parent graph links
                        for pl in links:
                            if isinstance(pl, list) and len(pl) >= 5 and pl[0] == link_id:
                                sn_inputs[name] = [str(pl[1]), pl[2]]
                                break
            sub_prompt[prefix + sn_id] = {
                "class_type": sn_type,
                "inputs": sn_inputs,
                "_widgets_values": sn.get("widgets_values", []),
                "_widgets_names": _widget_names_of(sn),
                "_outputs_names": [o.get("name") for o in (sn.get("outputs") or [])],
                "_widgets_values_named": sn.get("widgets_values_named") or {},
                "mode": sn.get("mode", 0),
            }

        # Find the output proxy node to determine which internal node produces each output
        if not sg_out_node:
            # No explicit output proxy — check virtual negative IDs
            # Find links targeting negative IDs
            output_aliases = {}
            for sl in sg_links:
                target, target_slot = get_link_target(sl)
                if target and target.startswith("-") and target not in sg_node_id_set:
                    origin, origin_slot = get_link_origin(sl)
                    output_aliases[f"{sg_node_id}:{target_slot}"] = [prefix + origin, origin_slot]
            # Execute all internal nodes, then find outputs via aliases
            self._map_all_widgets(sub_prompt)
            self._eval_cache = output_values
            self._eval_stack = set()
            self._eval_count = 0
            self._eval_total = len([n for n in sub_prompt if not n.startswith("_")])
            for alias_key, (internal_origin, _slot) in output_aliases.items():
                if internal_origin in sub_prompt and internal_origin not in output_values:
                    self._evaluate_node(internal_origin, sub_prompt, "", "", {"start_types": {}, "types": {}}, output_values)
            # Map subgraph output slots to internal node outputs
            sg_outputs = sg_data.get("outputs", [])
            result = []
            for i, out_def in enumerate(sg_outputs):
                alias_key = f"{sg_node_id}:{i}"
                target = output_aliases.get(alias_key)
                internal_origin, internal_slot = _alias_target(target) if target else (None, 0)
                ot = output_values.get(internal_origin) if internal_origin else None
                if ot and internal_slot < len(ot):
                    result.append(ot[internal_slot])
                else:
                    result.append(None)
            result = tuple(result)
            output_values[sg_node_id] = result
            return result

        # Has explicit graph/output proxy — find which internal nodes feed into it
        sg_out_id = str(sg_out_node.get("id"))
        output_targets = {}  # slot → [internal_node_id, output_slot]
        for sl in sg_links:
            origin, origin_slot = get_link_origin(sl)
            target, target_slot = get_link_target(sl)
            if target == sg_out_id:
                output_targets[target_slot] = [prefix + origin, origin_slot]

        # Widget mapping
        self._map_all_widgets(sub_prompt)
        print(f"[InterfaceExecutor] Subgraph {sg_node_id}: {len(sub_prompt)} internal nodes: {list(sub_prompt.keys())}")
        for nid, node in sub_prompt.items():
            print(f"[InterfaceExecutor]   {nid} ({node.get('class_type', '?')}) inputs={node.get('inputs', {})}")

        # Execute internal nodes that feed into the output proxy
        self._eval_cache = output_values
        self._eval_stack = set()
        self._eval_count = 0
        self._eval_total = len([n for n in sub_prompt if not n.startswith("_")])
        for slot, target in output_targets.items():
            internal_origin, _slot = _alias_target(target)
            if internal_origin in sub_prompt and internal_origin not in output_values:
                self._evaluate_node(internal_origin, sub_prompt, "", "", {"start_types": {}, "types": {}}, output_values)

        # Build result tuple: slot N → 内部节点的第 K 个输出口（K 来自连线，不能假定 0）
        max_slot = max(output_targets.keys()) if output_targets else -1
        result = []
        for i in range(max_slot + 1):
            target = output_targets.get(i)
            internal_origin, internal_slot = _alias_target(target) if target else (None, 0)
            ot = output_values.get(internal_origin) if internal_origin else None
            result.append(ot[internal_slot] if ot and internal_slot < len(ot) else None)
        result = tuple(result)
        output_values[sg_node_id] = result
        print(f"[InterfaceExecutor] Subgraph {sg_node_id} executed: {len(result)} outputs")
        return result

    def _try_execute_external(self, node_id, output_values):
        """从 extra_pnginfo 查找并执行外部节点（递归解析依赖）"""
        if node_id in output_values:
            return output_values[node_id]
        epi = self.extra_pnginfo
        if isinstance(epi, list):
            epi = epi[0] if epi else {}
        if not epi or not isinstance(epi, dict):
            raise RuntimeError(f"External node {node_id}: no extra_pnginfo available")
        workflow = epi.get("workflow") or epi.get("prompt") or {}
        nodes_list = workflow.get("nodes", [])
        links = workflow.get("links", [])
        target = None
        for n in nodes_list:
            if str(n.get("id")) == str(node_id):
                target = n
                break
        if not target:
            raise RuntimeError(f"External node {node_id}: node not found in workflow")
        import nodes as comfy_nodes
        node_type = target.get("type", "")
        class_def = comfy_nodes.NODE_CLASS_MAPPINGS.get(node_type)
        if not class_def:
            # Check if this is a subgraph node (type is a UUID in subgraph_by_type)
            node_by_id, links, subgraph_by_type = InterfacePackageNode._build_node_lookup(workflow)
            if InterfacePackageNode._subgraph_of(subgraph_by_type, node_type):
                return self._try_execute_subgraph(node_id, target, subgraph_by_type, links, output_values)
            raise RuntimeError(f"External node {node_id}: type '{node_type}' not in NODE_CLASS_MAPPINGS and not a known subgraph")
        inputs = {}
        for inp in target.get("inputs", []):
            if isinstance(inp, dict):
                lid = inp.get("link")
                nm = inp.get("name", "")
                inp_type = inp.get("type", "")
                if lid is not None:
                    for link in links:
                        if len(link) >= 5 and link[0] == lid:
                            oid = str(link[1])
                            oslot = link[2]
                            if oid in output_values and oslot < len(output_values[oid]):
                                inputs[nm] = output_values[oid][oslot]
                            else:
                                # 递归：外部节点依赖另一个外部节点
                                ext = self._try_execute_external(oid, output_values)
                                if ext is not None and oslot < len(ext):
                                    inputs[nm] = ext[oslot]
                                else:
                                    print(f"[InterfaceExecutor]   External dep {oid} unresolved for {node_id}.{nm}")
                            break
                elif inp_type == "PIPELINE_DATA" and self.get_pipeline is not None:
                    # Unconnected PIPELINE_DATA input — inject current pipeline
                    inputs[nm] = self.get_pipeline()
                    print(f"[InterfaceExecutor]   Injected pipeline for {node_id}.{nm} (unconnected)")
        wv = target.get("widgets_values", [])
        wd = self._build_widget_dict(class_def, wv, target.get("widgets_values_named"),
                                     _widget_names_of(target))
        for nm, v in wd.items():
            if nm not in inputs:
                inputs[nm] = v
        try:
            it = class_def.INPUT_TYPES()
            for rn, rd in it.get("required", {}).items():
                if rn not in inputs and isinstance(rd, tuple) and len(rd) >= 2:
                    opts = rd[1] if isinstance(rd[1], dict) else {}
                    if opts.get("default") is not None:
                        inputs[rn] = opts["default"]
                    elif isinstance(rd[0], list) and rd[0]:
                        inputs[rn] = rd[0][0]
        except Exception:
            pass
        # 与子图内节点同一条规则：第三方节点只认 [B,H,W,3] 的 IMAGE
        self._coerce_image_inputs(node_type, class_def, inputs)
        print(f"[InterfaceExecutor] External: {node_id} ({target.get('type')}) inputs={{{', '.join(f'{k}={type(v).__name__}' for k, v in inputs.items())}}}")
        try:
            obj = class_def()
            func = getattr(obj, getattr(class_def, "FUNCTION", "execute"))
            is_list_node = bool(getattr(class_def, "INPUT_IS_LIST", False))
            # Allow List：与子图内节点同一条分流（INPUT_IS_LIST 直通 / 否则逐帧跑再合并）。
            frame_inputs = self._list_frame_inputs(inputs) if self.list_mode else {}
            if frame_inputs and not is_list_node:
                n_runs = len(next(iter(frame_inputs.values())))
                runs = []
                for i in range(n_runs):
                    mm.throw_exception_if_processing_interrupted()
                    one = dict(inputs)
                    for _k, _v in frame_inputs.items():
                        one[_k] = _v[i] if i < len(_v) else _v[-1]
                    runs.append(self._call_node(class_def, func, one, node_id, is_list_node))
                result = self._merge_list_runs(runs)
                print(f"[InterfaceExecutor]   external list-map ×{n_runs} → merged")
            else:
                result = self._call_node(class_def, func, inputs, node_id, is_list_node)
            output_values[node_id] = result
            return result
        except Exception as e:
            import traceback
            traceback.print_exc()
            raise RuntimeError(f"External node {node_id} ({target.get('type', '?')}) failed: {e}")

    # ---- IMAGE 输入通道归一化（RGBA → RGB）----

    _own_pkg_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    @staticmethod
    def _port_io_type(spec):
        """从 INPUT_TYPES 的端口声明里取出 io 类型字符串。

        兼容三种写法：老式字符串 "IMAGE"、老式元组 ("IMAGE", {...})、以及
        ComfyUI v3 schema 的 IO.IMAGE 对象（io_type 属性 / get_io_type()）。
        """
        if isinstance(spec, str):
            return spec
        if isinstance(spec, (tuple, list)):
            return InterfaceExecutor._port_io_type(spec[0]) if spec else None
        v = getattr(spec, 'io_type', None)
        if isinstance(v, str):
            return v
        getter = getattr(spec, 'get_io_type', None)
        if callable(getter):
            try:
                v = getter()
            except Exception:
                v = None
            if isinstance(v, str):
                return v
        return None

    @classmethod
    def _image_input_names(cls, class_def):
        """节点声明里类型为 IMAGE 的输入名集合；取不到/没有则返回 None。"""
        try:
            it = class_def.INPUT_TYPES()
        except Exception:
            return None
        if not isinstance(it, dict):
            return None
        names = set()
        for section in ('required', 'optional'):
            sec = it.get(section)
            if not isinstance(sec, dict):
                continue
            for name, spec in sec.items():
                if cls._port_io_type(spec) == 'IMAGE':
                    names.add(name)
        return names or None

    @classmethod
    def _is_own_node(cls, class_def):
        """本项目自带的节点 —— alpha VAE 链路刻意保留 4 通道，不做压平。"""
        try:
            src = os.path.abspath(inspect.getfile(class_def))
        except Exception:
            return False
        return src.startswith(cls._own_pkg_root + os.sep)

    @staticmethod
    def _flatten_alpha_on_white(img):
        """[B,H,W,4] → [B,H,W,3]：透明区按白底合成。

        与 libs.image_utils.flatten_alpha_on_white 同语义（vision 塔/打标看到
        的就是这张白底图），就地实现以免给这个文件多加一条 import。
        """
        return img[..., :3] * img[..., 3:4] + (1.0 - img[..., 3:4])

    @classmethod
    def _coerce_one_image(cls, val, label=""):
        """单张图：4 通道压成 3 通道，其余原样返回（None 表示无需改动）。"""
        shape = getattr(val, 'shape', None)
        if shape is None or len(shape) != 4 or shape[-1] != 4:
            return None
        new = cls._flatten_alpha_on_white(val)
        print(f"[InterfaceExecutor]   IMAGE input RGBA → RGB (alpha flattened on white): "
              f"{label or 'image'} {tuple(shape)} → {tuple(new.shape)}")
        return new

    def _coerce_scalar_inputs(self, nid, class_def, inputs):
        """按 INPUT_TYPES 把标量输入收敛成声明类型（数字 / 布尔 / 候选项）。

        Interface 这条执行路径不经过 ComfyUI 的 validate_inputs，所以错位的 widget
        值或接错类型的线会一路带到节点函数里，最后在很深的地方报
        `'>' not supported between instances of 'str' and 'float'` 或
        `'float' object cannot be interpreted as an integer`，看不出是哪个口哪条线。
        这里在调用前统一收一次：

        * FLOAT ⇄ INT 互转：`range(steps)` 这类口拿到 20.0 必崩（链上的
          CM_IntBinaryOperation / ScriptNode 算出来天然是 float），而 KSampler
          之类只做 `if x not in 候选: 退回第一项`，错了也不吭声；
        * 字符串数字（"1.0" → 1.0）；
        * 布尔："true"/1 → True；
        * 候选项（COMBO）：类型不对（例如 scheduler 收到一个 int）时退回默认值 /
          第一项 —— 与 core 的 `if x not in SCHEDULERS: x = SCHEDULERS[0]` 同义，
          区别只是这里会打日志，并把值来自哪根线一起写出来（core 是静默的）。

        收不拢就打一行能定位到节点/输入/值的日志。INPUT_IS_LIST 的节点、以及值
        本身是 list/tuple 的（Allow List 逐帧输入）不在这里处理。
        """
        import numbers

        if class_def is None:
            return
        if getattr(class_def, "INPUT_IS_LIST", False):
            return
        try:
            input_types = class_def.INPUT_TYPES()
        except Exception:
            return
        if not isinstance(input_types, dict):
            return

        def _guard(name, declared, val, extra):
            _dump_wiring_once()
            shown = repr(val)
            if len(shown) > 60:
                shown = shown[:57] + "..."
            print(f"[InterfaceExecutor]   TYPE guard {nid}.{name}: 声明为 {declared} "
                  f"但收到 {type(val).__name__}({shown}){_src_of(name)}, {extra}")

        def _src_of(name):
            """这个输入的值从哪根线来；穿过直通节点一路展开成 `7748:0 ← 7745:8`。"""
            src = (self._link_src.get(nid) or {}).get(name)
            if not src:
                return " [来自存档格子]"
            chain = [src]
            cur = src
            for _ in range(3):
                if ":" not in cur:
                    break
                origin_id, slot = cur.rsplit(":", 1)
                origin = (getattr(self, "_sub_prompt", None) or {}).get(origin_id)
                if not isinstance(origin, dict):
                    break
                try:
                    import nodes as _cn
                    cls = _cn.NODE_CLASS_MAPPINGS.get(origin.get("class_type", ""))
                except Exception:
                    cls = None
                if not _node_passthrough(cls):
                    break
                inner = [v for v in (origin.get("inputs") or {}).values() if is_link(v)]
                if len(inner) != 1:
                    break
                cur = f"{inner[0][0]}:{inner[0][1]}"
                chain.append(cur)
            return " [来自 " + " ← ".join(chain) + "]"

        def _dump_wiring_once():
            """第一次在这个节点上拦到类型问题时，把它所有连线打一遍 —— 错位时
            邻居的名字一眼就能对上（sampler_name 收到的是 scheduler 的值…）。"""
            if nid in self._guard_nodes:
                return
            self._guard_nodes.add(nid)
            m = self._link_src.get(nid) or {}
            if m:
                print(f"[InterfaceExecutor]   连线 {nid}: "
                      + ", ".join(f"{k}<-{v}" for k, v in m.items()))

        for cat in ("required", "optional"):
            ci = input_types.get(cat)
            if not isinstance(ci, dict):
                continue
            for name, spec in ci.items():
                if name not in inputs:
                    continue
                if not isinstance(spec, (tuple, list)) or not spec:
                    continue
                t = spec[0]
                opts = spec[1] if len(spec) >= 2 and isinstance(spec[1], dict) else {}
                val = inputs[name]
                if val is None or isinstance(val, (list, tuple, dict)):
                    continue

                # ---- 数字 / 布尔 ----
                if t in ("FLOAT", "INT", "BOOLEAN"):
                    try:
                        if t == "FLOAT":
                            inputs[name] = float(val)          # int / bool / 数字串都吃
                        elif t == "INT":
                            raw = val if isinstance(val, numbers.Real) else float(str(val))
                            nv = int(round(float(raw)))
                            if not isinstance(raw, numbers.Integral) and float(raw) != nv:
                                _guard(name, t, val, f"四舍五入成 {nv}")
                            inputs[name] = nv
                        elif isinstance(val, str):
                            inputs[name] = val.lower() in ("true", "1", "yes")
                        else:
                            inputs[name] = bool(val)
                        continue
                    except (TypeError, ValueError):
                        default = opts.get("default")
                        _guard(name, t, val,
                               f"改用默认值 {default!r}" if default is not None
                               else "该类没有默认值, 原样传下去")
                        if default is not None:
                            inputs[name] = default
                    continue

                # ---- 候选项 ----
                if not isinstance(val, (numbers.Number, str)):
                    continue  # tensor / 对象之类：不是 combo 值，别拿 == 去比
                if t == "COMBO":
                    options = opts.get("options")
                elif isinstance(t, list):
                    options = t
                else:
                    continue
                if not isinstance(options, list) or not options:
                    continue
                if any(isinstance(o, (dict, list)) for o in options):
                    continue
                if val in options:
                    continue
                # 类型对得上、只是这个值不在表里：不动它，只留一行提示。
                # 前端把某个口接错线时，值往往是另一个 widget 的合法值（例如提示词
                # 接到 sampler_name），节点那边会静默退回默认，日志是唯一线索；
                # 而"文件被删/改名"这种正常失配也走这里，让节点自己报错更准。
                numeric_opts = any(isinstance(o, numbers.Number) and not isinstance(o, bool)
                                   for o in options)
                val_numeric = isinstance(val, numbers.Number) and not isinstance(val, bool)
                if val_numeric == numeric_opts:
                    if isinstance(val, str) and len(options) > 1:
                        _dump_wiring_once()
                        print(f"[InterfaceExecutor]   TYPE hint {nid}.{name}: {val!r}{_src_of(name)} "
                              f"不在这 {len(options)} 个候选项里, 节点可能自己退回默认")
                    continue
                # 类型不对（例如 scheduler 收到一个 int）：跟 core 一致，退默认/第一项。
                # 曾经想把整数当"老工作流的 combo 下标"解释，但那等于把接错线的
                # 值翻译成另一个合法值，比直接退默认更难查 —— 只把这层可能性写进日志。
                default = opts.get("default")
                pick = default if default in options else options[0]
                as_index = (f"（若按老下标解释会是 {options[int(val)]!r}）"
                            if isinstance(val, numbers.Integral) and not isinstance(val, bool)
                            and 0 <= int(val) < len(options) else "")
                _guard(name, f"COMBO[{len(options)}]", val,
                       f"回退到 {pick!r}{as_index}")
                inputs[name] = pick

    def _coerce_image_inputs(self, class_type, class_def, inputs):
        """把声明为 IMAGE 的输入里的 RGBA 压成 RGB。

        ComfyUI 的 IMAGE 契约是 [B,H,W,3]，而工作台合成出来的工作图是 RGBA
        （alpha 承载蒙版/透明区）。第三方节点（preprocessor、ControlNet 等）
        按 3 通道写死 normalize，拿到 4 通道就会在广播 mean/std 时崩：
        "operands could not be broadcast together with shapes (518,518,4) (3,)"。
        只在把值交给节点的这一刻压平，pipeline 内部的 alpha 语义不受影响。
        """
        if class_def is None or self._is_own_node(class_def):
            return
        names = self._image_input_names(class_def)
        if not names:
            return
        for name in names:
            if name not in inputs:
                continue
            val = inputs[name]
            label = f"{class_type}.{name}"
            if isinstance(val, (list, tuple)):
                # INPUT_IS_LIST：逐元素压平（注意别用 `or`，tensor 的真值判定会抛）
                coerced = []
                for v in val:
                    nv = self._coerce_one_image(v, label)
                    coerced.append(nv if nv is not None else v)
                inputs[name] = type(val)(coerced)
                continue
            new = self._coerce_one_image(val, label)
            if new is not None:
                inputs[name] = new

    def _normalize_image_value(self, val):
        """把 ComfyUI 节点的 IMAGE 输出统一归一化为 tensor 列表。

        支持：torch.Tensor / numpy.ndarray / NodeOutput / list / 含 'result' 或
        'images' 字段的 preview dict（部分自定义节点会返回此类结构）。
        """
        import torch
        try:
            from comfy_api.latest._io import NodeOutput
            has_node_output = True
        except ImportError:
            NodeOutput = None
            has_node_output = False

        # NodeOutput 包装
        if has_node_output and isinstance(val, NodeOutput):
            val = tuple(val.args) if val.args else None

        # dict 形式（preview / 部分自定义节点）：优先取 result / images
        if isinstance(val, dict):
            for key in ('result', 'images', 'image', 'IMAGE'):
                if key in val and val[key] is not None:
                    val = val[key]
                    break
            else:
                # 没有可识别字段，返回空（避免下游把 dict 当 tensor）
                return []

        # list / tuple：逐元素递归归一化
        if isinstance(val, (list, tuple)):
            out = []
            for item in val:
                out.extend(self._normalize_image_value(item))
            return out

        # tensor / numpy
        if hasattr(val, 'shape') and len(getattr(val, 'shape', ())) >= 2:
            return [val]

        return []

    def _extract_results(self, pkg, end_id, output_values, interface_name):
        """从 End 节点输出提取结果。支持 list 输出：list 中每个元素作为独立结果。"""
        end_outputs = output_values.get(end_id, ())
        end_types = pkg.get('types', {})
        results = []
        self.result_ports = []
        added_count = 0

        def _add_one(ptype, val, name, port_num):
            nonlocal added_count
            if ptype == 'PIPELINE_DATA':
                if hasattr(val, 'get_image'):
                    try:
                        img = val.get_image()
                        if img is not None:
                            results.append(('IMAGE', img, name))
                            self.result_ports.append(port_num)
                            if self.on_result_image:
                                self.on_result_image(img, name)
                            added_count += 1
                    except Exception:
                        pass
                elif hasattr(val, 'image') and val.image is not None:
                    results.append(('IMAGE', val.image, name))
                    self.result_ports.append(port_num)
                    if self.on_result_image:
                        self.on_result_image(val.image, name)
                    added_count += 1
                if self.on_result_pipeline:
                    self.on_result_pipeline(val, name)
            elif ptype == 'IMAGE':
                # 归一化 IMAGE 输出：ComfyUI 节点可能返回 tensor / numpy / list / 或
                # 含 'result'/'images' 字段的 preview dict（如部分自定义节点的返回结构）。
                tensors = self._normalize_image_value(val)
                for img in tensors:
                    results.append(('IMAGE', img, name))
                    self.result_ports.append(port_num)
                    if self.on_result_image:
                        self.on_result_image(img, name)
                    added_count += 1
            else:
                results.append((ptype, val, name))
                self.result_ports.append(port_num)
                added_count += 1

        for port_num_str, port_type in end_types.items():
            port_num = int(port_num_str) if isinstance(port_num_str, str) else port_num_str
            idx = port_num - 1
            if idx < 0 or idx >= len(end_outputs):
                continue
            val = end_outputs[idx]
            if val is None:
                continue
            if isinstance(val, list):
                for item in val:
                    if item is None:
                        continue
                    _add_one(port_type, item, f'{interface_name} #{added_count + 1}', port_num)
            else:
                _add_one(port_type, val, f'{interface_name} #{added_count + 1}', port_num)
        return results
