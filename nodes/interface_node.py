import inspect
import json
from ..libs.utils import AlwaysEqualProxy, ByPassTypeTuple

MAX_INTERFACE_NUM = 20
any_type = AlwaysEqualProxy("*")

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
        for i in range(1, MAX_INTERFACE_NUM + 1):
            if i in injections:
                val = injections[i]
            else:
                val = kwargs.get("value%d" % i, None)
            values.append(val)
            # port_types 可能未被序列化到 prompt（隐藏 widget），为空时 passthrough 所有非 None 值
            if i in types or (not types and val is not None):
                interface_values[i] = val

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
        return node_by_id, links, subgraph_by_type

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
    def _expand_subgraph(cls, sg_node_id, sg_node, subgraph_by_type, links, sub_prompt, parent_node_id=None):
        """Expand a ComfyUI subgraph node into its internal nodes."""
        sg_type = sg_node.get("type", "")
        sg_data = subgraph_by_type.get(sg_type)
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

        prefix = f"{sg_node_id}."
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
                if pl_target_id == sg_node_id and pl_target_slot == origin_slot:
                    if internal_target in sub_prompt:
                        for inp_name, inp_val in sub_prompt[internal_target].get("inputs", {}).items():
                            if isinstance(inp_val, dict) and inp_val.get("_sg_input_slot") == origin_slot:
                                sub_prompt[internal_target]["inputs"][inp_name] = [pl_origin_id, pl_origin_slot]
                    resolved = True
                    break

            # If not resolved via parent links, store as a pending virtual input
            # to be resolved at execution time using injected values
            if not resolved and internal_target in sub_prompt:
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
            output_aliases[f"{sg_node_id}:{target_slot}"] = internal_origin

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

        # Collect nodes on paths from Start to End
        # Algorithm: forward reachability from Start ∩ backward reachability from End
        
        # 1. Forward reachability: all nodes reachable downstream from Start
        forward_reachable = set()
        queue = [start_node_id]
        while queue:
            nid = queue.pop(0)
            if nid in forward_reachable:
                continue
            forward_reachable.add(nid)
            for tid in self._get_node_downstream(nid, links):
                if tid not in forward_reachable:
                    queue.append(tid)
        
        # 2. Backward reachability: all nodes that can reach End (upstream of End)
        # Also include nodes upstream of End's value inputs
        backward_reachable = set()
        queue = [node_id_str]
        while queue:
            nid = queue.pop(0)
            if nid in backward_reachable:
                continue
            backward_reachable.add(nid)
            for (up_origin, _, _) in self._get_node_upstream(nid, links):
                if up_origin not in backward_reachable:
                    queue.append(up_origin)
        
        # 3. Intersection: nodes on a path from Start to End
        sub_graph_ids = forward_reachable & backward_reachable
        # Always include Start and End
        sub_graph_ids.add(start_node_id)
        sub_graph_ids.add(node_id_str)

        # Build sub_prompt
        sub_prompt = {}
        for nid in sub_graph_ids:
            n = node_by_id.get(nid)
            if not n:
                continue

            node_type = n.get("type", "")

            # Check if this is a subgraph node
            if node_type in subgraph_by_type:
                self._expand_subgraph(nid, n, subgraph_by_type, links, sub_prompt)
                continue

            # Regular node
            inputs = self._get_node_inputs(n, links)
            # Keep ALL links — internal links will be resolved from output_values,
            # external links will be resolved at execution time from extra_pnginfo
            sub_prompt[nid] = {
                "class_type": node_type,
                "inputs": inputs,
                "_widgets_values": n.get("widgets_values", []),
            }

        # Infer types from End's value inputs
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

        def infer_port_types(node_obj):
            """从节点的 inputs 数组推断 {port_num_str: type_str}"""
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
            return result

        start_port_types = infer_port_types(start_node)
        end_port_types = infer_port_types(end_node)

        # Collect subgraph node widget values and input definitions
        # These are used to resolve virtual inputs that aren't connected to Start
        sg_widget_values = {}  # {sg_node_id: widgets_values}
        sg_input_defs = []     # [{name, type}] from all subgraph nodes' definitions
        for nid in sub_graph_ids:
            n = node_by_id.get(nid)
            if not n:
                continue
            node_type = n.get("type", "")
            if node_type in subgraph_by_type:
                sg = subgraph_by_type[node_type]
                sg_widget_values[nid] = n.get("widgets_values", [])
                for si in sg.get("inputs", []):
                    sg_input_defs.append({"name": si.get("name", ""), "type": si.get("type", ""), "sg_node_id": nid})

        package = {
            "name": interface_name,
            "types": end_port_types,
            "start_types": start_port_types,
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
    """Merge multiple PACKAGE inputs into a single PACKAGE (list) output."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "package1": ("PACKAGE",),
                "package2": ("PACKAGE",),
                "package3": ("PACKAGE",),
                "package4": ("PACKAGE",),
            },
        }

    RETURN_TYPES = ("PACKAGE",)
    RETURN_NAMES = ("package",)
    FUNCTION = "merge"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def merge(self, **kwargs):
        packages = []
        for i in range(1, 5):
            pkg = kwargs.get("package%d" % i)
            if pkg is not None:
                if isinstance(pkg, list):
                    packages.extend(pkg)
                else:
                    packages.append(pkg)
        return (packages,)


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

    def execute(self, pkg, manual_values=None):
        """执行一个 interface package。
        Args:
            pkg: InterfacePackageNode 输出的 PACKAGE dict
            manual_values: {port_num: value} 手动输入值（STRING/INT/FLOAT/BOOLEAN）
        Returns:
            list of extracted values (images, pipelines, etc.)
        """
        manual_values = manual_values or {}
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

        print(f"[InterfaceExecutor] === Starting '{interface_name}' ===")
        print(f"[InterfaceExecutor] start={start_id} end={end_id} start_types={pkg.get('start_types', {})} nodes={list(sub_prompt.keys())}")

        # 2. 注入值
        injections = self._build_injections(pkg, manual_values)
        _interface_injections[start_id] = injections
        print(f"[InterfaceExecutor] Injected {len(injections)} values")

        try:
            # 3. Widget 映射
            self._map_all_widgets(sub_prompt)

            # 4. 拓扑排序并执行
            output_values = {}
            execution_order = self._topo_sort(sub_prompt, start_id, end_id)
            print(f"[InterfaceExecutor] Order: {execution_order}")

            for i, nid in enumerate(execution_order):
                if nid.startswith("_"):
                    continue
                self._execute_node(nid, sub_prompt, execution_order, start_id, end_id, pkg, output_values, i)

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
        for port_num_str, port_type in start_types.items():
            port_num = int(port_num_str) if isinstance(port_num_str, str) else port_num_str
            if port_type == 'MASK' and self.get_mask:
                injections[port_num] = self.get_mask()
            elif port_type == 'IMAGE' and self.get_image:
                injections[port_num] = self.get_image()
            elif port_type == 'PIPELINE_DATA' and self.get_pipeline:
                injections[port_num] = self.get_pipeline()
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
            else:
                injections[port_num] = None
        return injections

    def _map_all_widgets(self, sub_prompt):
        """对所有节点做 widget 值映射"""
        import nodes as comfy_nodes
        for nid, node in sub_prompt.items():
            if nid.startswith("_"):
                continue
            widgets_values = node.pop("_widgets_values", [])
            if not widgets_values:
                continue
            class_type = node.get("class_type", "")
            class_def = comfy_nodes.NODE_CLASS_MAPPINGS.get(class_type)
            if not class_def:
                continue
            widget_dict = self._build_widget_dict(class_def, widgets_values)
            for name, val in widget_dict.items():
                existing = node.get("inputs", {}).get(name)
                if isinstance(existing, dict) and existing.get("_virtual_input"):
                    # Virtual input placeholder — replace with actual widget value
                    node["inputs"][name] = val
                elif name not in node.get("inputs", {}):
                    node["inputs"][name] = val

    @staticmethod
    def _build_widget_dict(class_def, widgets_values):
        """从 widgets_values 数组构建 {name: typed_value} 字典"""
        import inspect as _inspect
        if not widgets_values:
            return {}
        func_name = getattr(class_def, "FUNCTION", "execute")
        func = getattr(class_def, func_name, None)
        if func is None:
            return {}
        sig = _inspect.signature(func)
        param_names = [p for p in sig.parameters if p != 'self' and p != 'kwargs']
        try:
            input_types = class_def.INPUT_TYPES()
        except Exception:
            return {}
        link_names = set()
        widget_types = {}
        for cat in ("required", "optional", "hidden"):
            ci = input_types.get(cat, {})
            if isinstance(ci, dict):
                for name, val in ci.items():
                    if isinstance(val, tuple) and len(val) >= 1:
                        t = val[0]
                        opts = val[1] if len(val) >= 2 and isinstance(val[1], dict) else {}
                        if opts.get("forceInput", False):
                            link_names.add(name)
                        if isinstance(t, str) and t in ("STRING", "INT", "FLOAT", "BOOLEAN"):
                            widget_types[name] = t
                        elif isinstance(t, list):
                            widget_types[name] = "COMBO"
                        else:
                            link_names.add(name)
        widget_params = [p for p in param_names if p not in link_names]
        cag_flags = set()
        for i, name in enumerate(widget_params):
            for cat in ("required", "optional"):
                ci = input_types.get(cat, {})
                if isinstance(ci, dict) and name in ci:
                    val = ci[name]
                    if isinstance(val, tuple) and len(val) >= 2 and isinstance(val[1], dict):
                        if val[1].get("control_after_generate", False):
                            cag_flags.add(i)
                    break
        result = {}
        val_idx = 0
        for i, name in enumerate(widget_params):
            if val_idx >= len(widgets_values):
                break
            result[name] = widgets_values[val_idx]
            val_idx += 1
            if i in cag_flags and val_idx < len(widgets_values):
                val_idx += 1
        for name, val in list(result.items()):
            if val is None:
                continue
            wt = widget_types.get(name, "")
            if wt == "INT":
                try: result[name] = int(val)
                except (ValueError, TypeError): pass
            elif wt == "FLOAT":
                try: result[name] = float(val)
                except (ValueError, TypeError): pass
            elif wt == "BOOLEAN":
                if isinstance(val, str):
                    result[name] = val.lower() in ("true", "1", "yes")
                else:
                    result[name] = bool(val)
        return result

    @staticmethod
    def _topo_sort(sub_prompt, start_id, end_id):
        """拓扑排序"""
        deps = {}
        for nid, node in sub_prompt.items():
            if nid.startswith("_"):
                continue
            deps[nid] = set()
            for val in node.get("inputs", {}).values():
                if isinstance(val, list) and len(val) == 2:
                    origin = str(val[0])
                    if origin in sub_prompt:
                        deps[nid].add(origin)
        order = []
        visited = set()
        temp = set()
        def visit(nid):
            if nid in visited:
                return
            if nid in temp:
                return
            temp.add(nid)
            for d in deps.get(nid, set()):
                visit(d)
            temp.discard(nid)
            visited.add(nid)
            order.append(nid)
        visit(str(start_id))
        for nid in sub_prompt:
            if not nid.startswith("_"):
                visit(nid)
        return order

    def _execute_node(self, nid, sub_prompt, execution_order, start_id, end_id, pkg, output_values, step_idx):
        """执行单个节点"""
        import nodes as comfy_nodes
        node = sub_prompt[nid]
        class_type = node.get("class_type", "")
        class_def = comfy_nodes.NODE_CLASS_MAPPINGS.get(class_type)
        if not class_def:
            print(f"[InterfaceExecutor] SKIP {nid}: '{class_type}' not found")
            return

        if self.on_progress:
            self.on_progress(step_idx, len(execution_order))
        print(f"[InterfaceExecutor] ({step_idx+1}/{len(execution_order)}) {nid} ({class_type})")

        inputs = {}
        node_inputs = node.get("inputs", {})

        # 注入 port_types / unique_id
        import json as _json
        if nid == end_id:
            inputs["port_types"] = _json.dumps({str(k): v for k, v in pkg.get('types', {}).items()})
        if nid == start_id:
            inputs["port_types"] = _json.dumps({str(k): v for k, v in pkg.get('start_types', {}).items()})
            inputs["unique_id"] = start_id

        for name, val in node_inputs.items():
            if isinstance(val, list) and len(val) == 2:
                origin_id = str(val[0])
                output_slot = int(val[1])
                aliases = sub_prompt.get("_subgraph_output_aliases", {})
                alias_key = f"{origin_id}:{output_slot}"
                if alias_key in aliases:
                    origin_id = aliases[alias_key]
                    output_slot = 0
                if origin_id in output_values:
                    ot = output_values[origin_id]
                    if output_slot < len(ot):
                        inputs[name] = ot[output_slot]
                elif nid == end_id and name.startswith("value"):
                    import re as _re
                    m = _re.match(r"value(\d+)", name)
                    if m:
                        pn = int(m.group(1))
                        so = output_values.get(start_id, ())
                        if pn < len(so):
                            inputs[name] = so[pn]
                else:
                    # Try matching with prefix — origin_id might be without prefix
                    # while output_values key has prefix (e.g. "6463" vs "6972.6463")
                    matched = False
                    for ov_key in output_values:
                        if ov_key.endswith("." + origin_id):
                            ot = output_values[ov_key]
                            if output_slot < len(ot):
                                inputs[name] = ot[output_slot]
                                matched = True
                                break
                    if not matched:
                        if nid == end_id and name.startswith("value"):
                            pass  # Already tried above
                        elif origin_id in sub_prompt:
                            print(f"[InterfaceExecutor]   WARNING: {name} ← {origin_id} not in output_values (pending in sub_prompt)")
                        else:
                            # 外部节点：不在 sub_prompt 中，按需执行
                            ext_result = self._try_execute_external(origin_id, output_values)
                            if ext_result is not None and output_slot < len(ext_result):
                                inputs[name] = ext_result[output_slot]
                            else:
                                print(f"[InterfaceExecutor]   WARNING: {name} ← {origin_id} external resolve failed")
            elif isinstance(val, dict) and val.get("_virtual_input"):
                inputs[name] = self._resolve_virtual(val, output_values, start_id)
            elif isinstance(val, dict) and "_sg_input_slot" in val:
                pass  # Unresolved, skip
            else:
                inputs[name] = val

        # 填充默认值
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

        # Debug: log tensor shapes for troubleshooting
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
        try:
            obj = class_def()
            func = getattr(obj, getattr(class_def, "FUNCTION", "execute"))
            if getattr(class_def, "INPUT_IS_LIST", False):
                inputs = {k: [v] if not isinstance(v, list) else v for k, v in inputs.items()}

            # Hook ComfyUI progress bar for sampler-like nodes
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
                # Restore original hook
                if orig_hook is not None:
                    try:
                        import comfy.utils
                        comfy.utils.set_progress_bar_global_hook(orig_hook)
                    except Exception:
                        pass

            if result is None:
                result = ()
            elif not isinstance(result, tuple):
                result = (result,)
            output_values[nid] = result
            print(f"[InterfaceExecutor]   → {len(result)} outputs")
        except Exception as e:
            import traceback
            traceback.print_exc()
            raise RuntimeError(f"Node {nid} ({class_type}) failed: {e}")

    def _resolve_virtual(self, val, output_values, start_id):
        """解析子图虚拟输入（子图边界端口在父图未连线时产生）。
        
        注入只发生在 Start 节点处（通过 _build_injections）。
        这里不猜测、不 fallback——找不到值就报错。
        """
        vname = val.get("name", "")
        vtype = val.get("type", "")

        # TODO: 从 sg_widget_values 查找（子图节点自身的 widget 值）
        # 目前未实现

        raise ValueError(
            f"Unresolved virtual input: name={vname!r}, type={vtype!r}. "
            f"This subgraph boundary port has no connection in the parent graph. "
            f"Either connect it to an external node, or ensure the Start node "
            f"provides a matching port type."
        )

    def _try_execute_external(self, node_id, output_values):
        """从 extra_pnginfo 查找并执行外部节点（递归解析依赖）"""
        if node_id in output_values:
            return output_values[node_id]
        epi = self.extra_pnginfo
        if isinstance(epi, list):
            epi = epi[0] if epi else {}
        if not epi or not isinstance(epi, dict):
            return None
        workflow = epi.get("workflow") or epi.get("prompt") or {}
        nodes_list = workflow.get("nodes", [])
        links = workflow.get("links", [])
        target = None
        for n in nodes_list:
            if str(n.get("id")) == str(node_id):
                target = n
                break
        if not target:
            return None
        import nodes as comfy_nodes
        class_def = comfy_nodes.NODE_CLASS_MAPPINGS.get(target.get("type", ""))
        if not class_def:
            return None
        inputs = {}
        for inp in target.get("inputs", []):
            if isinstance(inp, dict):
                lid = inp.get("link")
                nm = inp.get("name", "")
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
        wv = target.get("widgets_values", [])
        wd = self._build_widget_dict(class_def, wv)
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
        print(f"[InterfaceExecutor] External: {node_id} ({target.get('type')})")
        try:
            obj = class_def()
            func = getattr(obj, getattr(class_def, "FUNCTION", "execute"))
            if getattr(class_def, "INPUT_IS_LIST", False):
                inputs = {k: [v] if not isinstance(v, list) else v for k, v in inputs.items()}
            result = func(**inputs)
            if result is None:
                result = ()
            elif not isinstance(result, tuple):
                result = (result,)
            output_values[node_id] = result
            return result
        except Exception as e:
            print(f"[InterfaceExecutor] External {node_id} failed: {e}")
            return None

    def _extract_results(self, pkg, end_id, output_values, interface_name):
        """从 End 节点输出提取结果"""
        end_outputs = output_values.get(end_id, ())
        end_types = pkg.get('types', {})
        results = []
        added_count = 0
        for port_num_str, port_type in end_types.items():
            port_num = int(port_num_str) if isinstance(port_num_str, str) else port_num_str
            idx = port_num - 1
            if idx < 0 or idx >= len(end_outputs):
                continue
            val = end_outputs[idx]
            if val is None:
                continue
            name = f'{interface_name} #{added_count + 1}'
            if port_type == 'PIPELINE_DATA':
                if hasattr(val, 'get_image'):
                    try:
                        img = val.get_image()
                        if img is not None:
                            results.append(('IMAGE', img, name))
                            if self.on_result_image:
                                self.on_result_image(img, name)
                            added_count += 1
                    except Exception:
                        pass
                elif hasattr(val, 'image') and val.image is not None:
                    results.append(('IMAGE', val.image, name))
                    if self.on_result_image:
                        self.on_result_image(val.image, name)
                    added_count += 1
                if self.on_result_pipeline:
                    self.on_result_pipeline(val, name)
            elif port_type == 'IMAGE':
                results.append(('IMAGE', val, name))
                if self.on_result_image:
                    self.on_result_image(val, name)
                added_count += 1
            else:
                results.append((port_type, val, name))
        return results
