from ..libs.utils import AlwaysEqualProxy

any_type = AlwaysEqualProxy("*")

class AnyPassNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
                "any": (any_type),
            }
        }
    
    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("any",)
    FUNCTION = "execute"
    CATEGORY = "Kolid-Toolkit"
    
    @classmethod
    def VALIDATE_INPUTS(s, input_types):
        return True

    def execute(self, any):
        return (any,)


class TextFormatNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "template": ("STRING", {
                    "default": "{}",
                    "multiline": True,
                    "tooltip": "Format template string, use {0}, {1}, ... or {name} for placeholders",
                }),
            },
            "optional": {
                "input0": (any_type, {"tooltip": "First input value"}),
                "input1": (any_type, {"tooltip": "Second input value"}),
                "input2": (any_type, {"tooltip": "Third input value"}),
                "input3": (any_type, {"tooltip": "Fourth input value"}),
                "input4": (any_type, {"tooltip": "Fifth input value"}),
                "input5": (any_type, {"tooltip": "Sixth input value"}),
                "input6": (any_type, {"tooltip": "Seventh input value"}),
                "input7": (any_type, {"tooltip": "Eighth input value"}),
            }
        }
    
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "execute"
    CATEGORY = "Kolid-Toolkit"
    
    @classmethod
    def VALIDATE_INPUTS(s, input_types):
        return True

    def execute(self, template, **kwargs):
        values = []
        for i in range(8):
            key = f"input{i}"
            if key in kwargs and kwargs[key] is not None:
                values.append(kwargs[key])
        
        try:
            result = template.format(*values)
        except (IndexError, KeyError) as e:
            result = f"Format error: {e}"
        
        return (result,)