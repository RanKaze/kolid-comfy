class ListMergeNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "list0": ("*",),
                "list1": ("*",),
                "list2": ("*",),
                "list3": ("*",),
            }
        }

    RETURN_TYPES = ("List",)
    RETURN_NAMES = ("List",)
    INPUT_IS_LIST = True
    OUTPUT_IS_LIST = (True,)
    FUNCTION = "merge"
    CATEGORY = "Kolid-Toolkit"
    
    @classmethod
    def VALIDATE_INPUTS(s, input_types):
        return True

    def merge(self, list0 = None, list1 = None, list2 = None, list3 = None):
        ret = []
        if list0 is not None:
            for item0 in list0:
                ret.append(item0)
        if list1 is not None:
            for item1 in list1:
                ret.append(item1)
        if list2 is not None:
            for item2 in list2:
                ret.append(item2)
        if list3 is not None:
            for item3 in list3:
                ret.append(item3)
        return (ret,)
    
class ListDictMergeNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "list0": ("DICT",),
                "list1": ("DICT",),
                "list2": ("DICT",),
                "list3": ("DICT",),
            }
        }

    RETURN_TYPES = ("DICT",)
    RETURN_NAMES = ("DICT",)
    INPUT_IS_LIST = True
    OUTPUT_IS_LIST = (True,)
    FUNCTION = "merge"
    CATEGORY = "Kolid-Toolkit"

    def merge(self, list0 = None, list1 = None, list2 = None, list3 = None):
        ret = []
        if list0 is not None:
            for item0 in list0:
                ret.append(item0)
        if list1 is not None:
            for item1 in list1:
                ret.append(item1)
        if list2 is not None:
            for item2 in list2:
                ret.append(item2)
        if list3 is not None:
            for item3 in list3:
                ret.append(item3)
        return (ret,)
    
class ListMaskMergeNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "list0": ("MASK",),
                "list1": ("MASK",),
                "list2": ("MASK",),
                "list3": ("MASK",),
            }
        }

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("MASK",)
    INPUT_IS_LIST = True
    OUTPUT_IS_LIST = (True,)
    FUNCTION = "merge"
    CATEGORY = "Kolid-Toolkit"

    def merge(self, list0 = None, list1 = None, list2 = None, list3 = None):
        ret = []
        if list0 is not None:
            for item0 in list0:
                ret.append(item0)
        if list1 is not None:
            for item1 in list1:
                ret.append(item1)
        if list2 is not None:
            for item2 in list2:
                ret.append(item2)
        if list3 is not None:
            for item3 in list3:
                ret.append(item3)
        return (ret,)
    
class ListRegexPackMergeNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "list0": ("REGEX_PACK",),
                "list1": ("REGEX_PACK",),
                "list2": ("REGEX_PACK",),
                "list3": ("REGEX_PACK",),
            }
        }

    RETURN_TYPES = ("REGEX_PACK",)
    RETURN_NAMES = ("REGEX_PACK",)
    INPUT_IS_LIST = True
    OUTPUT_IS_LIST = (True,)
    FUNCTION = "merge"
    CATEGORY = "Kolid-Toolkit"

    def merge(self, list0 = None, list1 = None, list2 = None, list3 = None):
        ret = []
        if list0 is not None:
            for item0 in list0:
                ret.append(item0)
        if list1 is not None:
            for item1 in list1:
                ret.append(item1)
        if list2 is not None:
            for item2 in list2:
                ret.append(item2)
        if list3 is not None:
            for item3 in list3:
                ret.append(item3)
        return (ret,)