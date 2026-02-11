import os

class SmartJoinStringNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "str0": ("STRING", {"default": ""}),
                "str1": ("STRING", {"default": ""}),
                "delimiter" : ("STRING", {"default": ","}),
            }
        }

    RETURN_TYPES = ("STRING",)
    FUNCTION = "join_string"
    CATEGORY = "Kolid-Toolkit"

    def join_string(self, str0, str1, delimiter):
        if str0 == "":
            return(str1,)
        if str1 == "":
            return(str0,)
        return(str0 + delimiter +str1,)