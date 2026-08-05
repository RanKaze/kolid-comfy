import inspect
from ..libs.utils import AlwaysEqualProxy, ByPassTypeTuple

MAX_INTERFACE_NUM = 20
any_type = AlwaysEqualProxy("*")


def parse_interface_config(config_str):
    """Parse "1:测试,3:测试更多" into {1: "测试", 3: "测试更多"}"""
    result = {}
    if not config_str:
        return result
    for item in config_str.split(","):
        item = item.strip()
        if not item or ":" not in item:
            continue
        parts = item.split(":", 1)
        try:
            port_num = int(parts[0].strip())
            port_name = parts[1].strip()
            if 1 <= port_num <= MAX_INTERFACE_NUM:
                result[port_num] = port_name
        except ValueError:
            continue
    return result


class InterfaceStartNode:
    """Interface Start: dynamic output ports drive dynamic input ports.
    When an output is connected to a downstream node, a corresponding input appears
    with the matching type. Values pass through and are packed into INTERFACE output."""

    @classmethod
    def INPUT_TYPES(cls):
        dyn_inputs = {"value1": (any_type,)}
        stack = inspect.stack()
        if len(stack) > 2 and stack[2].function == 'get_input_info':
            class AllContainer:
                def __contains__(self, item):
                    return True
                def __getitem__(self, key):
                    return (any_type,)
            dyn_inputs = AllContainer()

        return {
            "required": {
                "interface_config": ("STRING", {"default": "", "multiline": True}),
            },
            "optional": dyn_inputs,
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("INTERFACE",) + tuple([any_type] * MAX_INTERFACE_NUM)
    RETURN_NAMES = ("interface",) + tuple(["value%d" % i for i in range(1, MAX_INTERFACE_NUM + 1)])
    FUNCTION = "interface_start"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def interface_start(self, interface_config, **kwargs):
        ports = parse_interface_config(interface_config)
        values = []
        interface_values = {}
        for i in range(1, MAX_INTERFACE_NUM + 1):
            val = kwargs.get("value%d" % i, None)
            values.append(val)
            if i in ports:
                interface_values[i] = val
        interface_data = {"ports": ports, "values": interface_values}
        return tuple([interface_data] + values)


class InterfaceEndNode:
    """Interface End: dynamic input ports drive dynamic output ports.
    When an input is connected from an upstream node, a corresponding output appears
    with the matching type. Also receives INTERFACE data from InterfaceStartNode."""

    @classmethod
    def INPUT_TYPES(cls):
        dyn_inputs = {"value1": (any_type,)}
        stack = inspect.stack()
        if len(stack) > 2 and stack[2].function == 'get_input_info':
            class AllContainer:
                def __contains__(self, item):
                    return True
                def __getitem__(self, key):
                    return (any_type,)
            dyn_inputs = AllContainer()

        return {
            "required": {
                "interface": ("INTERFACE",),
                "interface_config": ("STRING", {"default": "", "multiline": True}),
            },
            "optional": dyn_inputs,
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = tuple([any_type] * MAX_INTERFACE_NUM)
    RETURN_NAMES = tuple(["value%d" % i for i in range(1, MAX_INTERFACE_NUM + 1)])
    FUNCTION = "interface_end"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def interface_end(self, interface, interface_config, **kwargs):
        interface_values = {}
        if isinstance(interface, dict) and "values" in interface:
            interface_values = interface["values"]

        result = []
        for i in range(1, MAX_INTERFACE_NUM + 1):
            val = kwargs.get("value%d" % i, None)
            if val is None:
                val = interface_values.get(i, None)
            result.append(val)
        return tuple(result)
