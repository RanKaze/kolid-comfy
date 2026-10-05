import os

class ExtractFolderNameNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "path": ("STRING", {"default": ""}),
            }
        }

    RETURN_TYPES = ("STRING",)
    FUNCTION = "extract"
    CATEGORY = "Kolid-Toolkit"

    def extract(self, path):
        folder_name = os.path.basename(os.path.normpath(path))
        return (folder_name,)