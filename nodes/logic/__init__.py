# 纯逻辑节点:字符串 / 字典 / 列表 / 分支 / 数学 / 脚本,无 UI。
from .branch_node import *
from .list_node import *
from .dictionary_node import *
from .math_node import *
from .script_node import *
from .regex_matcher_node import *
from .regex_pack_matcher_node import *
from .string_to_int_node import *
from .smart_join_string_node import *
from .type_debugger_node import *
from .util_node import *
from .extract_folder_name_node import *

NODE_CONFIG = {
    "RegexMatcherNode": {"class": RegexMatcherNode, "name": "RegexMatcherNode"},
    "StringToIntNode": {"class": StringToIntNode, "name": "StringToIntNode"},
    "ExtractFolderNameNode": {"class": ExtractFolderNameNode, "name": "ExtractFolderNameNode"},

    "DictIndexSetNode": {"class": DictIndexSetNode, "name": "DictIndexSetNode"},
    "DictIndexGetNode": {"class": DictIndexGetNode, "name": "DictIndexGetNode"},
    "DictionaryListSetNode": {"class": DictionaryListSetNode, "name": "DictionaryListSetNode"},
    "DictionaryValuesNode": {"class": DictionaryValuesNode, "name": "DictionaryValuesNode"},
    "DictionaryNewNode": {"class": DictionaryNewNode, "name": "DictionaryNewNode"},
    "DictionarySetNode": {"class": DictionarySetNode, "name": "DictionarySetNode"},
    "DictionaryGetNode": {"class": DictionaryGetNode, "name": "DictionaryGetNode"},
    "DictionaryGetIntNode": {"class": DictionaryGetIntNode, "name": "DictionaryGetIntNode"},
    "DictionaryGetStringNode": {"class": DictionaryGetStringNode, "name": "DictionaryGetStringNode"},
    "DictionaryGetFloatNode": {"class": DictionaryGetFloatNode, "name": "DictionaryGetFloatNode"},
    "DictionaryConditionSetNode": {"class": DictionaryConditionSetNode, "name": "DictionaryConditionSetNode"},
    "DictionaryGetBooleanNode": {"class": DictionaryGetBooleanNode, "name": "DictionaryGetBooleanNode"},
    "DictConditionSetFlag": {"class": DictConditionSetFlag, "name": "DictConditionSetFlag"},
    "DictSwitch": {"class": DictSwitch, "name": "DictSwitch"},

    "ListMergeNode": {"class": ListMergeNode, "name": "ListMergeNode"},
    "ListDictMergeNode": {"class": ListDictMergeNode, "name": "ListDictMergeNode"},
    "ListMaskMergeNode": {"class": ListMaskMergeNode, "name": "ListMaskMergeNode"},
    "ListRegexPackMergeNode": {"class": ListRegexPackMergeNode, "name": "ListRegexPackMergeNode"},

    "BranchNoneNode": {"class": BranchNoneNode, "name": "BranchNoneNode"},
    "IsOptionalNoneNode": {"class": IsOptionalNoneNode, "name": "IsOptionalNoneNode"},
    "BranchOptionalRequiredNode": {"class": BranchOptionalRequiredNode, "name": "BranchOptionalRequiredNode"},
    "BranchGroupNode": {"class": BranchGroupNode, "name": "BranchGroupNode"},
    "BranchSwitchNode": {"class": BranchSwitchNode, "name": "BranchSwitchNode"},
    "BranchSwitchesNode": {"class": BranchSwitchesNode, "name": "BranchSwitchesNode"},
    "BranchBooleanNode": {"class": BranchBooleanNode, "name": "BranchBooleanNode"},
    "BranchManagerNode": {"class": BranchManagerNode, "name": "BranchManagerNode"},

    "TypeDebugNode": {"class": TypeDebugNode, "name": "TypeDebugNode"},
    "SmartJoinStringNode": {"class": SmartJoinStringNode, "name": "SmartJoinStringNode"},

    "RegexPackMatcherNode": {"class": RegexPackMatcherNode, "name": "RegexPackMatcherNode"},
    "RegexPackerNode": {"class": RegexPackerNode, "name": "RegexPackerNode"},
    "RegexUnpackerNode": {"class": RegexUnpackerNode, "name": "RegexUnpackerNode"},

    "MathNode": {"class": MathNode, "name": "MathNode"},
    "ScriptNode": {"class": ScriptNode, "name": "ScriptNode"},

    "NeedNode": {"class": NeedNode, "name": "NeedNode"},
    "AnyPassNode": {"class": AnyPassNode, "name": "AnyPassNode"},
    "TextFormatNode": {"class": TextFormatNode, "name": "TextFormatNode"},
}
