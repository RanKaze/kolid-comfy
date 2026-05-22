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
from .nodes.image_node import *
from .nodes.open_node import *
from .nodes.branch_node import * 
from .nodes.video_node import *
from .nodes.timestamp_node import *
from .nodes.audio_node import *
from .nodes.prompt_node import *
from .nodes.switch_node import *
from .nodes.sampler_node import *
    

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
    "IsOptionalNoneNode" : {"class": IsOptionalNoneNode, "name": "IsOptionalNoneNode"},
    "BranchOptionalRequiredNode" : {"class": BranchOptionalRequiredNode, "name": "BranchOptionalRequiredNode"},
    "BranchGroupNode" : {"class": BranchGroupNode, "name": "BranchGroupNode"},
    "BranchSwitchNode" : {"class": BranchSwitchNode, "name": "BranchSwitchNode"},
    "BranchSwitchesNode" : {"class": BranchSwitchesNode, "name": "BranchSwitchesNode"},
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
    
    "NeedNode" : {"class": NeedNode, "name": "NeedNode"},   
    "AnyPassNode" : {"class": AnyPassNode, "name": "AnyPassNode"},
    "TextFormatNode" : {"class": TextFormatNode, "name": "TextFormatNode"},
    
    "EHentaiRandomNode" : {"class": EHentaiRandomNode, "name": "EHentaiRandomNode"},
    "EHentaiURLNode" : {"class": EHentaiURLNode, "name": "EHentaiURLNode"},
    "LocalImageLoaderNode" : {"class": LocalImageLoaderNode, "name": "LocalImageLoaderNode"},
    "DiskSaveImagesNode" : {"class": DiskSaveImagesNode, "name": "DiskSaveImagesNode"},
    "DiskLoadImagesNode" : {"class": DiskLoadImagesNode, "name": "DiskLoadImagesNode"},
    "DiskLoadImageCountNode" : {"class": DiskLoadImageCountNode, "name": "DiskLoadImageCountNode"},
    "DiskImagesToVideoNode" : {"class": DiskImagesToVideoNode, "name": "DiskImagesToVideoNode"},
    "PixivImageLoaderNode" : {"class": PixivImageLoaderNode, "name": "PixivImageLoaderNode"},
    
    "SnapshotGaussianNode" : {"class": SnapshotGaussianNode, "name": "SnapshotGaussianNode"},
    "ExtrinsicsCompareNode" : {"class": ExtrinsicsCompareNode, "name": "ExtrinsicsCompareNode"},
    "SnapshotImageNode" : {"class": SnapshotImageNode, "name": "SnapshotImageNode"},
    "SnapshotImagePointsNode" : {"class": SnapshotImagePointsNode, "name": "SnapshotImagePointsNode"},
    "SnapshotCaptureNode" : {"class": SnapshotCaptureNode, "name": "SnapshotCaptureNode"},
    "OpenNode" : {"class": OpenNode, "name": "OpenNode"},
    "VideoManagerNode": {"class": VideoManagerNode, "name": "VideoManagerNode"},
    "UrlVideoNode": {"class": UrlVideoNode, "name": "UrlVideoNode"},
    "GetVideoImageNode": {"class": GetVideoImageNode, "name": "GetVideoImageNode"},
    "GetVideoImagesNode": {"class": GetVideoImagesNode, "name": "GetVideoImagesNode"},
    "GetVideoInfoNode": {"class": GetVideoInfoNode, "name": "GetVideoInfoNode"},
    "SnapshotVideoNode": {"class": SnapshotVideoNode, "name": "SnapshotVideoNode"},
    
    "Preview Video": {"class": PreviewVideo, "name": "Preview Video"},
    
    "TimestampDurationNode": {"class": TimestampDurationNode, "name": "TimestampDurationNode"},
    "TimestampForLengthNode": {"class": TimestampForLengthNode, "name": "TimestampForLengthNode"},
    
    "GetVideoAudioNode": {"class": GetVideoAudioNode, "name": "GetVideoAudioNode"},
    "GetAudioSegmentNode": {"class": GetAudioSegmentNode, "name": "GetAudioSegmentNode"},
    "GetVideoSegmentNode": {"class": GetVideoSegmentNode, "name": "GetVideoSegmentNode"},
    "VideoWallpaperEngineNode": {"class": VideoWallpaperEngineNode, "name": "VideoWallpaperEngineNode"},
    "VideoFolderLoaderNode": {"class": VideoFolderLoaderNode, "name": "VideoFolderLoaderNode"},
    "VideoGetFileInfoNode": {"class": VideoGetFileInfoNode, "name": "VideoGetFileInfoNode"},
    "SnapshotPromptNode": {"class": SnapshotPromptNode, "name": "SnapshotPromptNode"},
    "SnapshotSwitchNode": {"class": SnapshotSwitchNode, "name": "SnapshotSwitchNode"},
    
    "ImageLimitPixelNode": {"class": ImageLimitPixelNode, "name": "ImageLimitPixelNode"},
    "ImageRecoverResizeNode": {"class": ImageRecoverResizeNode, "name": "ImageRecoverResizeNode"},
    "ImageCropMaskNode": {"class": ImageCropMaskNode, "name": "ImageCropMaskNode"},
    "ImageRecoverCropNode": {"class": ImageRecoverCropNode, "name": "ImageRecoverCropNode"},
    "ImageBatchNode": {"class": ImageBatchNode, "name": "ImageBatchNode"},
    "ImageRecoverBatchNode": {"class": ImageRecoverBatchNode, "name": "ImageRecoverBatchNode"},
    "ImageDetectContentNode": {"class": ImageDetectContentNode, "name": "ImageDetectContentNode"},
    "SnapshotMaskNode": {"class": SnapshotMaskNode, "name": "SnapshotMaskNode"},
    
    "ImageToBase64Node": {"class": ImageToBase64Node, "name": "ImageToBase64Node"},
    "Base64ToImageNode": {"class": Base64ToImageNode, "name": "Base64ToImageNode"},
    
    "ReferenceLatentNode": {"class": ReferenceLatentNode, "name": "ReferenceLatentNode"},
    "ReferenceContolNetNode": {"class": ReferenceContolNetNode, "name": "ReferenceContolNetNode"},
    "ReferenceGuidanceNode": {"class": ReferenceGuidanceNode, "name": "ReferenceGuidanceNode"}, 
    
    "ConfigNode": {"class": ConfigNode, "name": "ConfigNode"},
    "ConfigGetNode": {"class": ConfigGetNode, "name": "ConfigGetNode"},
    "ContextNode": {"class": ContextNode, "name": "ContextNode"},
    "ContextQueryNode": {"class": ContextQueryNode, "name": "ContextQueryNode"},
    "PipelineNode": {"class": PipelineNode, "name": "PipelineNode"},
    "PipelineSamplerNode": {"class": PipelineSamplerNode, "name": "PipelineSamplerNode"},
    "PipelineSamplerAdvancedNode": {"class": PipelineSamplerAdvancedNode, "name": "PipelineSamplerAdvancedNode"},
    "PipelineDecodeNode": {"class": PipelineDecodeNode, "name": "PipelineDecodeNode"},
    "PipelineLimitPixelNode": {"class": PipelineLimitPixelNode, "name": "PipelineLimitPixelNode"},
    "PipelineRecoverResizeNode": {"class": PipelineRecoverResizeNode, "name": "PipelineRecoverResizeNode"},
    "PipelineAddNoiseNode": {"class": PipelineAddNoiseNode, "name": "PipelineAddNoiseNode"},
    "PipelineToggleMaskInpaintNode": {"class": PipelineToggleMaskInpaintNode, "name": "PipelineToggleMaskInpaintNode"},
    "PipelineDetailerAdvancedNode": {"class": PipelineDetailerAdvancedNode, "name": "PipelineDetailerAdvancedNode"},
    "PipelineDetectNode": {"class": PipelineDetectNode, "name": "PipelineDetectNode"},
    "PipelineTagNode": {"class": PipelineTagNode, "name": "PipelineTagNode"},
    "PipelineGetPromptNode": {"class": PipelineGetPromptNode, "name": "PipelineGetPromptNode"},
    "PipelineSamplerDataNode": {"class": PipelineSamplerDataNode, "name": "PipelineSamplerDataNode"},
    "PipelineVideoSamplerAdvancedNode": {"class": PipelineVideoSamplerAdvancedNode, "name": "PipelineVideoSamplerAdvancedNode"},
    
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
