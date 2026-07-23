

class AssetsInfoCollectNode:
    """Collect a specific key's values from infos list.

    Input: infos (list of dicts from SnapshotAssetsNode), key (string)
    Output: list of values for that key across all infos entries.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "infos": ("*", {
                    "tooltip": "Image infos from SnapshotAssetsNode (list of dicts)"
                }),
                "key": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Key to collect from each info dict"
                }),
            },
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("values",)
    INPUT_IS_LIST = True
    OUTPUT_IS_LIST = (True,)
    FUNCTION = "collect"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(s, infos, key):
        return float("nan")

    def collect(self, infos, key):
        # infos is a list of dicts (INPUT_IS_LIST=True, upstream OUTPUT_IS_LIST=True)
        # key is also a list (INPUT_IS_LIST=True), use key[0]
        actual_key = key[0] if isinstance(key, list) and key else key
        if not infos or not actual_key:
            return ([],)
        values = []
        for item in infos:
            if isinstance(item, dict) and actual_key in item:
                values.append(item[actual_key])
            else:
                values.append(None)
        print(f"[AssetsInfoCollect] Collected {len(values)} values for key '{actual_key}'")
        return (values,)
