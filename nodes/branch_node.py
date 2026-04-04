from ..libs.utils import AlwaysEqualProxy, compare_revision

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