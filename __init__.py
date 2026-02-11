from .nodes.fit_node import *
from .nodes.regex_matcher_node import *
from .nodes.extract_folder_name_node import *
from .nodes.string_to_int_node import *
from .nodes.regex_pack_matcher_node import *
from .nodes.type_debuger_node import *
from .nodes.smart_join_string_node import *
from .nodes.dictionary_node import *
from .nodes.branch_node import * 
from .nodes.list_node import *
from .nodes.math_node import *
from .nodes.script_node import *
from .nodes.config_node import *
from .nodes.save_load_node import *
from .nodes.lora_node import *
from .nodes.util_node import *
from .nodes.ehentai_node import *
from .nodes.disk_node import *
from .nodes.pixiv_node import *
from .nodes.gaussian_node import *
from .nodes.open_node import *

class SDPPPLayout:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
                "comment": ("STRING", {"default": "", "multiline": True}),
            }
        }

    INPUT_IS_LIST = True
    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "excute"
    CATEGORY = "Kolid-Toolkit"

    def excute(self, comment):  
        return ()
    
    

NODE_CONFIG = {
    "FitNode": {"class": FitNode, "name": "FitNode"},
    "RecoverFitNode": {"class": RecoverFitNode, "name": "RecoverFitNode"},
    "RegexMatcherNode": {"class": RegexMatcherNode, "name": "RegexMatcherNode"},
    "StringToIntNode" : {"class": StringToIntNode, "name": "StringToIntNode"},
    "ExtractFolderNameNode" : {"class": ExtractFolderNameNode, "name": "ExtractFolderNameNode"},
    
    "DictIndexSetNode" : {"class": DictIndexSetNode, "name": "DictIndexSetNode"},
    "DictIndexGetNode" : {"class": DictIndexGetNode, "name": "DictIndexGetNode"},
    "DictionaryListSetNode" : {"class": DictionaryListSetNode, "name": "DictionaryListSetNode"},
    "DictionaryValuesNode" : {"class": DictionaryValuesNode, "name": "DictionaryValuesNode"},
    "DictionaryNewNode" : {"class": DictionaryNewNode, "name": "DictionaryNewNode"},
    "DictionarySetNode" : {"class": DictionarySetNode, "name": "DictionarySetNode"},
    "DictionaryGetNode" : {"class": DictionaryGetNode, "name": "DictionaryGetNode"},
    "DictionaryGetIntNode" : {"class": DictionaryGetIntNode, "name": "DictionaryGetIntNode"},
    "DictionaryGetStringNode" : {"class": DictionaryGetStringNode, "name": "DictionaryGetStringNode"},
    "DictionaryGetFloatNode" : {"class": DictionaryGetFloatNode, "name": "DictionaryGetFloatNode"},
    "DictionaryConditionSetNode" : {"class": DictionaryConditionSetNode, "name": "DictionaryConditionSetNode"},
    "DictionaryGetBooleanNode" : {"class": DictionaryGetBooleanNode, "name": "DictionaryGetBooleanNode"},
    "DictConditionSetFlag" : {"class": DictConditionSetFlag, "name": "DictConditionSetFlag"},
    "DictSwitch" : {"class": DictSwitch, "name": "DictSwitch"},
    
    
    "ListMergeNode" : {"class": ListMergeNode, "name": "ListMergeNode"},
    "ListDictMergeNode" : {"class": ListDictMergeNode, "name": "ListDictMergeNode"},
    "ListMaskMergeNode" : {"class": ListMaskMergeNode, "name": "ListMaskMergeNode"},
    "ListRegexPackMergeNode" : {"class": ListRegexPackMergeNode, "name": "ListRegexPackMergeNode"},
    
    "BranchNoneNode" : {"class": BranchNoneNode, "name": "BranchNoneNode"},
    "BranchToggleNode" : {"class": BranchToggleNode, "name": "BranchToggleNode"},
    "BranchBooleanNode" : {"class": BranchBooleanNode, "name": "BranchBooleanNode"},
    
    "TypeDebugNode" : {"class": TypeDebugNode, "name": "TypeDebugNode"},
    
    "SmartJoinStringNode" : {"class": SmartJoinStringNode, "name": "SmartJoinStringNode"},
    
    "RegexPackMatcherNode" : {"class": RegexPackMatcherNode, "name": "RegexPackMatcherNode"},
    "RegexPackerNode" : {"class": RegexPackerNode, "name": "RegexPackerNode"},
    "RegexUnpackerNode" : {"class": RegexUnpackerNode, "name": "RegexUnpackerNode"},
    
    "MathNode" : {"class": MathNode, "name": "MathNode"},
    "ScriptNode" : {"class": ScriptNode, "name": "ScriptNode"},
    
    "SamplerConfigNode" : {"class": SamplerConfigNode, "name": "SamplerConfigNode"},
    
    "SaveTextNode" : {"class": SaveTextNode, "name": "SaveTextNode"},
    "LoadTextNode" : {"class": LoadTextNode, "name": "LoadTextNode"},
    "FileCheckNode" : {"class": FileCheckNode, "name": "FileCheckNode"},
    
    "LoadLoraPackNode" : {"class": LoadLoraPackNode, "name": "LoadLoraPackNode"},
    "LoadLoraFromPackNode" : {"class": LoadLoraFromPackNode, "name": "LoadLoraFromPackNode"},
    "TextEncodeFromPackNode" : {"class": TextEncodeFromPackNode, "name": "TextEncodeFromPackNode"},
    
    "AnyPassNode" : {"class": AnyPassNode, "name": "AnyPassNode"},
    
    "SDPPPLayout" : {"class": SDPPPLayout, "name": "SDPPPLayout"},
    "EHentaiRandomNode" : {"class": EHentaiRandomNode, "name": "EHentaiRandomNode"},
    "EHentaiURLNode" : {"class": EHentaiURLNode, "name": "EHentaiURLNode"},
    "LocalImageLoaderNode" : {"class": LocalImageLoaderNode, "name": "LocalImageLoaderNode"},
    "PixivImageLoaderNode" : {"class": PixivImageLoaderNode, "name": "PixivImageLoaderNode"},
    
    "SnapshotGaussianNode" : {"class": SnapshotGaussianNode, "name": "SnapshotGaussianNode"},
    
    "OpenNode" : {"class": OpenNode, "name": "OpenNode"},
}

def generate_node_mappings(node_config):
    node_class_mappings = {}
    node_display_name_mappings = {}

    for node_name, node_info in node_config.items():
        node_class_mappings[node_name] = node_info["class"]
        node_display_name_mappings[node_name] = node_info.get("name", node_info["class"].__name__)

    return node_class_mappings, node_display_name_mappings

NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS = generate_node_mappings(NODE_CONFIG)
WEB_DIRECTORY = "javascript"
