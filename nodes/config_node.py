import comfy.samplers

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