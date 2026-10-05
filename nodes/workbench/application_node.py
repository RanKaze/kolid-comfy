class ApplicationNode:
    """Pure frontend node. Collects widgets from other nodes and displays them in a single wrapper widget."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "collect_nodes": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "Format: id:234,id:145,regex:test,name:TT",
                }),
            },
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "execute"
    CATEGORY = "Kolid-Toolkit"

    def execute(self, collect_nodes):
        return ()
