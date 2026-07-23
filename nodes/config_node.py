import comfy.samplers


class ConfigModelNegativeNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "config": ("CONFIG_DATA",),
                "model_negative": ("MODEL",),
            }
        }

    RETURN_TYPES = ("CONFIG_DATA",)
    RETURN_NAMES = ("config",)
    FUNCTION = "process"
    CATEGORY = "sampling/custom"

    def process(self, config=None, model_negative=None):
        from .sampler_node import ConfigData
        if config is None:
            config = ConfigData()
        else:
            config = config.copy()
        if model_negative is not None:
            config["model_negative"] = model_negative
        return (config,)


class ConfigSigmasNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "config": ("CONFIG_DATA",),
                "sigmas": ("SIGMAS",),
            }
        }

    RETURN_TYPES = ("CONFIG_DATA",)
    RETURN_NAMES = ("config",)
    FUNCTION = "process"
    CATEGORY = "sampling/custom"

    def process(self, config=None, sigmas=None):
        from .sampler_node import ConfigData
        if config is None:
            config = ConfigData()
        else:
            config = config.copy()
        if sigmas is not None:
            config["sigmas"] = sigmas
        return (config,)


class ConfigArchitectureNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "config": ("CONFIG_DATA",),
                "architecture": ("STRING", {"default": ""}),
            }
        }

    RETURN_TYPES = ("CONFIG_DATA",)
    RETURN_NAMES = ("config",)
    FUNCTION = "process"
    CATEGORY = "sampling/custom"

    def process(self, config=None, architecture=""):
        from .sampler_node import ConfigData
        if config is None:
            config = ConfigData()
        else:
            config = config.copy()
        if architecture:
            config["architecture"] = architecture
        return (config,)


class ConfigPrintTagNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "config": ("CONFIG_DATA",),
                "print_tag": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = ("CONFIG_DATA",)
    RETURN_NAMES = ("config",)
    FUNCTION = "process"
    CATEGORY = "sampling/custom"

    def process(self, config=None, print_tag=False):
        from .sampler_node import ConfigData
        if config is None:
            config = ConfigData()
        else:
            config = config.copy()
        config["print_tag"] = print_tag
        return (config,)


class ConfigPreviewImageNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "config": ("CONFIG_DATA",),
                "preview_image": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("CONFIG_DATA",)
    RETURN_NAMES = ("config",)
    FUNCTION = "process"
    CATEGORY = "sampling/custom"

    def process(self, config=None, preview_image=True):
        from .sampler_node import ConfigData
        if config is None:
            config = ConfigData()
        else:
            config = config.copy()
        config["preview_image"] = preview_image
        return (config,)


class ConfigPreviewMaskNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "config": ("CONFIG_DATA",),
                "preview_mask": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("CONFIG_DATA",)
    RETURN_NAMES = ("config",)
    FUNCTION = "process"
    CATEGORY = "sampling/custom"

    def process(self, config=None, preview_mask=True):
        from .sampler_node import ConfigData
        if config is None:
            config = ConfigData()
        else:
            config = config.copy()
        config["preview_mask"] = preview_mask
        return (config,)


class ConfigKrea2EditNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "config": ("CONFIG_DATA",),
                "ref_boost": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1000.0, "step": 0.01, "round": 0.001,
                                        "tooltip": "参考保真度调节: 乘以 target->reference 的注意力。1.0=关闭, >1 更贴近参考外观, <1 放松。"}),
                "ref_boost_a": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1000.0, "step": 0.01, "round": 0.001,
                                           "tooltip": "第一个参考(场景)的 boost。单参考时无效。"}),
                "ref_boost_mask": ("MASK", {"tooltip": "可选区域 mask, 限制最后一个参考的 boost 范围(如人脸)。空=整个参考。"}),
                "grounding_px": ("INT", {"default": 768, "min": 0, "max": 4096, "step": 64,
                                         "tooltip": "VLM 输入图像最长边上限。0=原始分辨率。"}),
            }
        }

    RETURN_TYPES = ("CONFIG_DATA",)
    RETURN_NAMES = ("config",)
    FUNCTION = "process"
    CATEGORY = "sampling/custom"

    def process(self, config=None, ref_boost=1.0, ref_boost_a=1.0, ref_boost_mask=None, grounding_px=768):
        from .sampler_node import ConfigData
        if config is None:
            config = ConfigData()
        else:
            config = config.copy()
        config["ref_boost"] = ref_boost
        config["ref_boost_a"] = ref_boost_a
        config["grounding_px"] = grounding_px
        if ref_boost_mask is not None:
            config["ref_boost_mask"] = ref_boost_mask
        return (config,)


class SamplerConfigNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "cfg": ("FLOAT", {
                    "default": 8.0,
                    "min": 0.0,
                    "max": 100.0,
                    "step": 0.1,
                    "round": 0.01
                }),
                "steps": ("INT", {
                    "default": 20,
                    "min": 1,
                    "max": 10000
                }),
                # 使用官方提供的字符串列表
                "sampler_name": (comfy.samplers.SAMPLER_NAMES, ),
                "scheduler": (comfy.samplers.SCHEDULER_NAMES, ),
                "positive": ("STRING", {
                    "default": "",
                    "multiline": True
                }),
                "negative": ("STRING", {
                    "default": "",
                    "multiline": True
                }),
            }
        }

    RETURN_TYPES = ("FLOAT", "INT", comfy.samplers.KSampler.SAMPLERS, comfy.samplers.KSampler.SCHEDULERS, "STRING", "STRING")
    RETURN_NAMES = ("cfg", "steps", "sampler_name", "scheduler", "positive", "negative")
    FUNCTION = "pack"
    CATEGORY = "Kolid-Toolkit"

    def pack(self, cfg, steps, sampler_name, scheduler, positive, negative):
        # 直接把输入原样打包返回
        return (cfg, steps, sampler_name, scheduler, positive, negative)