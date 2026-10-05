# Pipeline 核心:sampler / config / lora / train / prompt 程序引擎。
from .sampler_node import *
from .config_node import *
from .lora_node import *
from .train_node import *

NODE_CONFIG = {
    "SamplerConfigNode": {"class": SamplerConfigNode, "name": "SamplerConfigNode"},
    "ConfigNode": {"class": ConfigNode, "name": "ConfigNode"},
    "ConfigGetNode": {"class": ConfigGetNode, "name": "ConfigGetNode"},
    "ConfigModelNegativeNode": {"class": ConfigModelNegativeNode, "name": "ConfigModelNegativeNode"},
    "ConfigSigmasNode": {"class": ConfigSigmasNode, "name": "ConfigSigmasNode"},
    "ConfigArchitectureNode": {"class": ConfigArchitectureNode, "name": "ConfigArchitectureNode"},
    "ConfigPrintTagNode": {"class": ConfigPrintTagNode, "name": "ConfigPrintTagNode"},
    "ConfigPreviewImageNode": {"class": ConfigPreviewImageNode, "name": "ConfigPreviewImageNode"},
    "ConfigPreviewMaskNode": {"class": ConfigPreviewMaskNode, "name": "ConfigPreviewMaskNode"},
    "ConfigKrea2EditNode": {"class": ConfigKrea2EditNode, "name": "ConfigKrea2EditNode"},
    "ConfigQwenImage21Node": {"class": ConfigQwenImage21Node, "name": "ConfigQwenImage21Node"},

    "ContextNode": {"class": ContextNode, "name": "ContextNode"},
    "ContextQueryNode": {"class": ContextQueryNode, "name": "ContextQueryNode"},

    "ReferenceLatentNode": {"class": ReferenceLatentNode, "name": "ReferenceLatentNode"},
    "ReferenceImageNode": {"class": ReferenceImageNode, "name": "ReferenceImageNode"},
    "ReferenceContolNetNode": {"class": ReferenceContolNetNode, "name": "ReferenceContolNetNode"},
    "ReferenceGuidanceNode": {"class": ReferenceGuidanceNode, "name": "ReferenceGuidanceNode"},
    "ReferenceIPAdapterNode": {"class": ReferenceIPAdapterNode, "name": "ReferenceIPAdapterNode"},

    "PipelineNode": {"class": PipelineNode, "name": "PipelineNode"},
    "PipelineSamplerNode": {"class": PipelineSamplerNode, "name": "PipelineSamplerNode"},
    "PipelineSamplerAdvancedNode": {"class": PipelineSamplerAdvancedNode, "name": "PipelineSamplerAdvancedNode"},
    "PipelineDecodeNode": {"class": PipelineDecodeNode, "name": "PipelineDecodeNode"},
    "PipelineLimitPixelNode": {"class": PipelineLimitPixelNode, "name": "PipelineLimitPixelNode"},
    "PipelineRecoverResizeNode": {"class": PipelineRecoverResizeNode, "name": "PipelineRecoverResizeNode"},
    "PipelineAddNoiseNode": {"class": PipelineAddNoiseNode, "name": "PipelineAddNoiseNode"},
    "PipelineToggleMaskInpaintNode": {"class": PipelineToggleMaskInpaintNode, "name": "PipelineToggleMaskInpaintNode"},
    "PipelineEnableEditNode": {"class": PipelineEnableEditNode, "name": "PipelineEnableEditNode"},
    "PipelineEnableQwenEditNode": {"class": PipelineEnableQwenEditNode, "name": "PipelineEnableQwenEditNode"},
    "PipelineEnableGenerateTextNode": {"class": PipelineEnableGenerateTextNode, "name": "PipelineEnableGenerateTextNode"},
    "PipelineDetailerAdvancedNode": {"class": PipelineDetailerAdvancedNode, "name": "PipelineDetailerAdvancedNode"},
    "PipelineDetectNode": {"class": PipelineDetectNode, "name": "PipelineDetectNode"},
    "PipelineTagNode": {"class": PipelineTagNode, "name": "PipelineTagNode"},
    "PipelineGetPromptNode": {"class": PipelineGetPromptNode, "name": "PipelineGetPromptNode"},
    "PipelineSamplerDataNode": {"class": PipelineSamplerDataNode, "name": "PipelineSamplerDataNode"},
    "ApplyLorasNode": {"class": ApplyLorasNode, "name": "ApplyLorasNode"},
    "PipelineVideoSamplerAdvancedNode": {"class": PipelineVideoSamplerAdvancedNode, "name": "PipelineVideoSamplerAdvancedNode"},

    "LoadLoraPackNode": {"class": LoadLoraPackNode, "name": "LoadLoraPackNode"},
    "LoadLoraFromPackNode": {"class": LoadLoraFromPackNode, "name": "LoadLoraFromPackNode"},
    "TextEncodeFromPackNode": {"class": TextEncodeFromPackNode, "name": "TextEncodeFromPackNode"},

    "TrainEditLoraNode": {"class": TrainEditLoraNode, "name": "TrainEditLoraNode"},
}
