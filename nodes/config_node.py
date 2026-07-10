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