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