from ..libs.utils import AlwaysEqualProxy, compare_revision
import comfy_execution
import inspect

any_type = AlwaysEqualProxy("*")
lazy_options = {"lazy": True} if compare_revision(2543) else {}

class BranchNoneNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "check": (any_type,),
                "on_none": (any_type, lazy_options),
            },
        }

    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("*",)
    FUNCTION = "execute"
    CATEGORY = "Kolid-Toolkit"

    def check_lazy_status(self, check, on_none=None):
        if check is None:
            return ["on_none"]

    def execute(self, *args, **kwargs):
        return (kwargs['on_none'] if kwargs['check'] is None else kwargs['check'],)
    
class IsOptionalNoneNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "optional": {
                "check": ("*",),
            },
        }
        
    # 建議加上這段，明確告訴後端不要做嚴格類型檢查
    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        # kwargs 會收到所有實際傳進來的輸入，例如 {'check': some_value} 或空 dict
        # 我們什麼都不用檢查，直接放行
        return True

    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("is_none",)
    FUNCTION = "execute"
    CATEGORY = "Kolid-Toolkit"

    def execute(self, check = None):
        return (check is None,)
    
class BranchOptionalRequiredNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "optional": {
                "required": ("*",),
            },
        }
        
    # 建議加上這段，明確告訴後端不要做嚴格類型檢查
    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        # kwargs 會收到所有實際傳進來的輸入，例如 {'check': some_value} 或空 dict
        # 我們什麼都不用檢查，直接放行
        return True

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("required",)
    FUNCTION = "execute"
    CATEGORY = "Kolid-Toolkit"

    def execute(self, required = None):
        return (required,)
    
class BranchGroupNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "excute"
    CATEGORY = "Kolid-Toolkit"

    def excute(self):  
        return ()    

_branch_optional = {
    "relay_expression": ("STRING", {"default": "", "multiline": True, "tooltip": "Relay expression for boolean logic between nodes. Variables are other Branch Switch/Boolean node titles or types. e.g: '(!NodeA&&NodeB)||NodeC'. Supports '..' to go up to parent graph, '{id}' to match by node id, and ':' to enter subgraphs: e.g: '..SubGraphNode:NodeA'", "advanced": True}),
    "active_config": ("STRING", {"default": "", "multiline": True, "advanced": True, "tooltip": "Format: <op>:<target_type>:<target_value>[,]. op: mute/!mute/bypass/!bypass/foldout/!foldout/expand/!expand/hide/!hide. target_type: name/id/group. target_value: node name, node id, or group name. Applied when toggle=true, inverted when toggle=false. e.g: 'mute:name:NodeA,expand:name:NodeB'"}),
}

class BranchSwitchNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "value": ("*", {"lazy" : True}),
                "toggle": ("BOOLEAN", {"default": False})
            },
            "optional": _branch_optional,
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("*",)
    FUNCTION = "execute"
    CATEGORY = "Kolid-Toolkit"

    def check_lazy_status(self, value, toggle):
        if toggle:
            return ["value"]
        return []

    def execute(self, *args, **kwargs):
        toggleValue = kwargs['toggle']
        if toggleValue:
            return (kwargs['value'],)
        return (None,)
    

class BranchBooleanNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "toggle": ("BOOLEAN", {"default": False})
            },
            "optional": _branch_optional,
        }

    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("toggle",)
    FUNCTION = "execute"
    CATEGORY = "Kolid-Toolkit"

    def execute(self, toggle, **kwargs):
        return (toggle,)
    
class BranchSwitchesNode:
    @classmethod
    def INPUT_TYPES(cls):
        dyn_inputs = {"input1": (any_type, {"lazy": True, "tooltip": "Any input. When connected, one more input slot is added."}), }
        stack = inspect.stack()
        if stack[2].function == 'get_input_info':
            # bypass validation
            class AllContainer:
                def __contains__(self, item):
                    return True

                def __getitem__(self, key):
                    return any_type, {"lazy": True}
            dyn_inputs = AllContainer()
        
        return {
            "required": {
                "select" : (["[None]"], {"default": "[None]"}),
                "select_input": ("INT", {
                    "default": 0,
                    "min": 0,
                    "step": 1,
                }),
                "select_config": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "advanced": True,
                    "tooltip": "Format: <select_index>:<op>:<target>[,]. op: mute/!mute/bypass/!bypass/set/!set. target: name:<node_name> or id:<node_id> or group:<group_name>. set/!set only applies to Branch Switch/Boolean nodes, setting their toggle to true/false"
                }),
            },
            "optional": dyn_inputs,
        }

    RETURN_TYPES = ("*", "STRING", "INT")
    RETURN_NAMES = ("output", "select", "select_index")
    FUNCTION = "switch"
    CATEGORY = "custom/branch"

    @classmethod
    def VALIDATE_INPUTS(cls, select, select_input, select_config, **kwargs):
        return True

    def check_lazy_status(self, select, select_input, **kwargs):
        if select_input <= 0:
            return []
        selected_key = f"input{select_input}"
        if selected_key not in kwargs:
            return []
        return [selected_key]

    def switch(self, select, select_input, **kwargs):
        input_keys = [k for k in kwargs if k.startswith('input')]
        selected_key = f"input{select_input}"
        if select_input <= 0 or selected_key not in kwargs:
            raise ValueError(f"select_input {select_input} is out of range for input keys {input_keys}")
        input = kwargs[selected_key]
        return (input, select, select_input)
