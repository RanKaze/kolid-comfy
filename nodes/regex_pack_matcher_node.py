import re

class RegexPackMatcherNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "match_key":("STRING", {"default": "title", "multiline": False}),
                "regex_pattern": ("STRING", {"default": r"\w+", "multiline": False}),
                "input_packs": ("REGEX_PACK",),
            }
        }

    INPUT_IS_LIST = True
    OUTPUT_IS_LIST = (True, )
    RETURN_TYPES = ("REGEX_PACK",)
    RETURN_NAMES = ("packs",)
    FUNCTION = "match_regex_packs"
    CATEGORY = "Kolid-Toolkit"

    def match_regex_packs(self, match_key, regex_pattern, input_packs):
        pattern = re.compile(regex_pattern[0])
        matched_packs = []
        for pack in input_packs:
            if pattern.search(pack[match_key[0]]):
                matched_packs.append(pack)
        return (matched_packs,)

        
class RegexPackerNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "title": ("STRING",{"default": "", "multiline": False}),
                "content0": ("STRING", {"default": "", "multiline": False}),
                "content1": ("STRING", {"default": "", "multiline": False}),
                "content2": ("STRING", {"default": "", "multiline": False}),
                "value0": ("FLOAT", {"default": 1.0}),
                "value1": ("FLOAT", {"default": 1.0}),
            }
        }

    RETURN_TYPES = ("REGEX_PACK",)
    RETURN_NAMES = ("pack",)
    FUNCTION = "pack"
    CATEGORY = "Kolid-Toolkit"

    def pack(self, title, content0, content1, content2, value0, value1):
        p = {
            "title" : title, 
            "content0" : content0,
            "content1" : content1,
            "content2" : content2,
            "value0" : value0,
            "value1" : value1,
        }
        return (p,)
    
class RegexUnpackerNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pack": ("REGEX_PACK",),
            }
        }

    RETURN_TYPES = ("STRING","STRING","STRING","STRING","FLOAT","FLOAT")
    RETURN_NAMES = ("title", "content0", "content1", "content2", "value0", "value1") 
    FUNCTION = "unpack"
    CATEGORY = "Kolid-Toolkit"

    def unpack(self, pack):
        return (pack["title"], pack["content0"], pack["content1"], pack["content2"], pack["value0"], pack["value1"])
