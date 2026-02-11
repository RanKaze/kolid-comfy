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