import comfy
import folder_paths
import os
import torch
from nodes import common_ksampler, VAEEncode, VAEEncodeForInpaint, KSamplerAdvanced, VAEDecode, SetLatentNoiseMask   
from ..libs.image_utils import limit_pixels, recover_size, crop_mask, recover_crop
from ..libs.detect_utils import detect_mask
from ..libs.mask_utils import expand_mask

# ====================== 全局 LoRA 路径缓存（脚本加载时自动构建） ======================
_lora_path_cache = {}  # key: lora_name, value: full file path

def _build_lora_cache():
    global _lora_path_cache
    _lora_path_cache.clear()

    lora_dirs = folder_paths.get_folder_paths("loras")
    print(f"正在构建 LoRA 路径缓存（支持子文件夹），搜索目录: {len(lora_dirs)} 个")

    count = 0
    for base_dir in lora_dirs:
        if not os.path.isdir(base_dir):
            continue
        for root, _, files in os.walk(base_dir):
            for file in files:
                if file.endswith(('.safetensors', '.pt', '.ckpt', '.pth')):
                    rel_path = os.path.relpath(os.path.join(root, file), base_dir)
                    name_without_ext = os.path.splitext(rel_path)[0].replace("\\", "/")

                    full_path = os.path.join(root, file)
                    _lora_path_cache[name_without_ext] = full_path

                    base_name = os.path.splitext(file)[0]
                    if base_name not in _lora_path_cache:
                        _lora_path_cache[base_name] = full_path

                    count += 1

    print(f"✓ LoRA 缓存构建完成！共找到 **{len(_lora_path_cache)}** 个 LoRA 文件（含子文件夹）")
    if len(_lora_path_cache) == 0:
        print("警告：未找到任何 LoRA 文件，请检查 ComfyUI/models/loras 目录下是否有 .safetensors 文件")

_build_lora_cache()   # 脚本加载时立即执行

# ====================== ParseLoRAConfigsNode ======================
class ParseLoRAConfigsNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "lora_string": ("STRING", {
                    "default": "<lora:高分辨率修正:0.2>, <lora:hiten:1.0>",
                    "multiline": True,
                    "placeholder": "仅支持 <lora:name:weight> 格式（支持子文件夹）\n示例：\n<lora:高分辨率修正:0.2> <lora:hiten:1.0>"
                }),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("loras",)
    FUNCTION = "parse"
    CATEGORY = "sampling/custom"

    def parse(self, lora_string: str):
        if not lora_string or not lora_string.strip():
            return ("",)

        cleaned = lora_string.replace("\n", " ").replace(",", " ")
        parts = [p.strip() for p in cleaned.split() if p.strip()]

        items = []
        for part in parts:
            if part.startswith("<lora:") and part.endswith(">"):
                inner = part[1:-1].strip()
                if inner.startswith("lora:"):
                    items.append(inner)
            elif part.startswith("<") and part.endswith(">"):
                print(f"Warning: 格式必须为 <lora:name:weight>: {part}")

        result = "\n".join(items)
        if items:
            print(f"Parsed {len(items)} LoRA configs: {items}")
        return (result,)


class SamplerContext:
    def __init__(self):
        self.name = None
        self.positive = None
        self.negative = None
        self.loras = None
    def copy(self):
        new = SamplerContext()
        new.positive = self.positive
        new.negative = self.negative
        new.loras = self.loras
        return new

# ====================== SamplerCache 类（最终修复版） ======================
class SamplerCache:
    def __init__(self):
        self._cache = {}

    def copy(self):
        new = SamplerCache()
        new._cache = self._cache.copy()
        return new

    def get_model_clip(self, model, clip, loras: list = None):
        if model is None:
            raise ValueError("传入的 model 不能为空")

        if loras is None:
            loras = []

        cache_key = (id(model), id(clip) if clip is not None else None, frozenset(loras))

        if cache_key in self._cache:
            print(f"✓ LoRA model cache hit")
            return self._cache[cache_key]

        model_patcher = model
        clip_patcher = clip

        if not loras:
            result = (model_patcher, clip_patcher)
            self._cache[cache_key] = result
            return result

        print(f"Loading LoRAs: {loras}")

        for item in loras:
            if not isinstance(item, str) or not item.strip():
                continue

            lora_str = item.strip()

            try:
                if not lora_str.startswith("lora:"):
                    print(f"Warning: 必须以 lora: 开头: {lora_str}")
                    continue

                parts = lora_str.split(":", 2)
                if len(parts) != 3:
                    print(f"Warning: 格式错误，需要 lora:name:weight: {lora_str}")
                    continue

                _, lora_name, strength_part = parts
                lora_name = lora_name.strip()
                strength = float(strength_part.strip())

                # 查找完整路径（支持子文件夹）
                lora_path = _lora_path_cache.get(lora_name)
                if lora_path is None:
                    for key in _lora_path_cache:
                        if key == lora_name or key.endswith("/" + lora_name) or key.endswith("\\" + lora_name):
                            lora_path = _lora_path_cache[key]
                            break

                if lora_path is None:
                    print(f"Warning: 未找到 LoRA 文件: {lora_name}")
                    continue

                # === 关键修复：先加载 state_dict，再传入 load_lora_for_models ===
                lora_dict = comfy.utils.load_torch_file(lora_path, safe_load=True)

                model_patcher, clip_patcher = comfy.sd.load_lora_for_models(
                    model_patcher, 
                    clip_patcher, 
                    lora_dict,          # ← 这里必须传 dict，而不是路径
                    strength, 
                    strength
                )

                print(f"✓ Applied LoRA: {lora_name} (strength={strength})")

            except Exception as e:
                print(f"Failed to load LoRA '{item}': {type(e).__name__} - {e}")

        result = (model_patcher, clip_patcher)
        self._cache[cache_key] = result
        return result


# ====================== PipelineData 类（只返回 condition） ======================
class PipelineData:
    def __init__(self,
                 cache=None,
                 model=None,
                 clip=None,
                 vae=None,
                 image=None,
                 latent=None,
                 mask=None,
                 sampler_name=None,
                 scheduler=None,
                 steps=None,
                 cfg=None,
                 loras=None,
                 positive=None,
                 negative=None):
        
        self.cache = cache
        self.model = model
        self.clip = clip
        self.vae = vae
        self.image = image
        self.latent = latent
        self.mask = mask
        self.sampler_name = sampler_name
        self.scheduler = scheduler
        self.steps = steps
        self.cfg = cfg
        self.loras = loras
        self.positive = positive
        self.negative = negative
        self.resize_info_stack = []  # 使用栈来存储 resize_info
        
        # Conditioning 缓存: key = (clip_id, prompt, frozenset(loras)) → condition
        self._conditioning_cache = {}

    def copy(self):
        new = PipelineData(
            cache=self.cache.copy() if self.cache else None,
            model=self.model,
            clip=self.clip,
            vae=self.vae,
            image=self.image,
            latent=self.latent,
            mask=self.mask,
            sampler_name=self.sampler_name,
            scheduler=self.scheduler,
            steps=self.steps,
            cfg=self.cfg,
            loras=self.loras,
            positive=self.positive,
            negative=self.negative
        )
        new.resize_info_stack = self.resize_info_stack.copy()  # 复制栈
        new._conditioning_cache = self._conditioning_cache.copy()
        return new

    # ==================== 获取 Latent ====================
    def get_latent(self):
        if self.latent is not None:
            return self.latent

        if self.image is None:
            raise ValueError("PipelineData 中 latent 和 image 不能同时为 None")

        if self.vae is None:
            raise ValueError("PipelineData 中 vae 为空，无法编码 image")

        latent_out = VAEEncode().encode(
            vae=self.vae, pixels=self.image
        )[0]

        self.image = None
        self.latent = latent_out
        return self.latent

    # ==================== 获取 Image ====================
    def get_image(self):
        if self.image is not None:
            return self.image

        if self.latent is None:
            raise ValueError("PipelineData 中 image 和 latent 都为空，无法获取 image")

        if self.vae is None:
            raise ValueError("PipelineData 中 vae 为空，无法从 latent 解码 image")

        from nodes import VAEDecode
        decoded_image = VAEDecode().decode(vae=self.vae, samples=self.latent)[0]
        self.image = decoded_image
        self.latent = None  # 解码后将 latent 设置为 None
        return self.image

    # ==================== 获取 Conditioning（只返回 condition，带缓存） ====================
    def get_conditioning(self, clip, prompt: str):
        """
        使用 cache.get_model_clip 获取打过 LoRA 的 clip，
        生成并返回单个 condition (positive conditioning)
        """
        if self.cache is None:
            raise ValueError("PipelineData 中 cache 为空")

        if prompt is None:
            prompt = ""

        # 生成缓存 key
        cache_key = (
            id(clip),
            prompt
        )

        # 检查缓存
        if cache_key in self._conditioning_cache:
            print(f"✓ Conditioning cache hit")
            return self._conditioning_cache[cache_key]

        if clip is None:
            raise ValueError("无法获取有效的 clip")

        # 生成 conditioning
        from nodes import CLIPTextEncode
        condition = CLIPTextEncode().encode(clip=clip, text=prompt)[0]

        # 存入缓存
        self._conditioning_cache[cache_key] = condition

        return condition


# ====================== PipelineDataNode ======================
class PipelineNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {},
            "optional": {
                "pipeline": ("PIPELINE_DATA",),
                "cache": ("SAMPLER_CACHE",),
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "image": ("IMAGE",),
                "latent": ("LATENT",),
                "mask": ("MASK",),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"default": "euler", "forceInput": True}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"default": "normal", "forceInput": True}),
                "steps": ("INT", {"forceInput": True}),
                "cfg": ("FLOAT", {"forceInput": True}),
                "loras": ("STRING", {"forceInput": True}),
                "positive": ("STRING", {"forceInput": True}),
                "negative": ("STRING", {"forceInput": True}),
            }
        }

    RETURN_TYPES = ("PIPELINE_DATA", "SAMPLER_CACHE", "MODEL", "CLIP", "VAE", 
                    "IMAGE", "LATENT", "MASK", comfy.samplers.KSampler.SAMPLERS, comfy.samplers.KSampler.SCHEDULERS, "INT", "FLOAT", "STRING", "STRING", "STRING",)
    
    RETURN_NAMES = ("pipeline", "cache", "model", "clip", "vae", 
                    "image", "latent", "mask", "sampler_name", "scheduler", "steps", "cfg", "loras", "positive", "negative",)
    
    FUNCTION = "process"
    CATEGORY = "sampling/custom"

    def process(self,
                pipeline=None,
                cache=None,
                model=None,
                clip=None,
                vae=None,
                image=None,
                latent=None,
                mask=None,
                sampler_name="euler",
                scheduler="normal",
                steps=None,
                cfg=None,
                loras=None,
                positive=None,
                negative=None):
        
        if pipeline is not None:
            config = pipeline.copy()
        else:
            config = PipelineData()

        # 更新字段
        if cache is not None:
            config.cache = cache
        if config.cache is None:
            config.cache = SamplerCache()
            
        if model is not None:
            config.model = model
        if clip is not None:
            config.clip = clip
        if vae is not None:
            config.vae = vae
        if image is not None:
            config.image = image
        if latent is not None:
            config.latent = latent
        if mask is not None:
            config.mask = mask
        if sampler_name is not None:
            config.sampler_name = sampler_name
        if scheduler is not None:
            config.scheduler = scheduler
        if steps is not None:
            config.steps = steps
        if cfg is not None:
            config.cfg = cfg
        if loras is not None:
            config.loras = loras
        if positive is not None:
            config.positive = positive
        if negative is not None:
            config.negative = negative

        return (
            config,
            config.cache,
            config.model,
            config.clip,
            config.vae,
            config.image,
            config.latent,
            config.mask,
            config.sampler_name,
            config.scheduler,
            config.steps,
            config.cfg,
            config.loras,
            config.positive,
            config.negative
        )

# ====================== SamplerNode ======================
class PipelineSamplerNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "step_rate": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0}),
            },
            "optional": {
                "loras": ("STRING", {"forceInput": True, "multiline": False}),  # 新增
                "positive": ("STRING", {"forceInput": True, "multiline": False}),  # 新增
                "negative": ("STRING", {"forceInput": True, "multiline": False}),  # 新增
            }
        }

    RETURN_TYPES = ("PIPELINE_DATA",)
    RETURN_NAMES = ("pipeline",)
    FUNCTION = "sample"
    CATEGORY = "sampling/custom"

    def sample(self, pipeline: PipelineData, denoise, seed, step_rate,
               loras=None, positive=None, negative=None):
        
        if step_rate <= 0:
            return (pipeline,)
        
        config = pipeline.copy()

        if config.cache is None:
            raise ValueError("PipelineData 中 cache 为空")

        if config.model is None:
            raise ValueError("PipelineData 中 model 为空，无法采样")

        if loras is None:
            loras = config.loras
        if positive is None:
            positive = config.positive
        if negative is None:
            negative = config.negative
        
        # 解析 lora_configs（支持多行输入）
        lora_list = [line.strip() for line in loras.split("\n") if line.strip()]

        # 获取打过 LoRA 的 model 和 clip
        model_to_use, clip_to_use = config.cache.get_model_clip(
            model=config.model,
            clip=config.clip,
            loras=lora_list
        )

        # 获取 latent（支持 mask inpaint）
        latent = config.get_latent()

        # 获取 condition（使用新的 get_conditioning）
        positive_condition = config.get_conditioning(
            clip=clip_to_use,
            prompt=positive
        )
        negative_condition = config.get_conditioning(
            clip=clip_to_use,
            prompt=negative
        )

        sampler_name = config.sampler_name if config.sampler_name is not None else "euler"
        scheduler    = config.scheduler    if config.scheduler    is not None else "normal"
        steps        = config.steps       if config.steps         is not None else 20
        cfg          = config.cfg          if config.cfg          is not None else 8.0
        
        steps = int(step_rate * steps)
        
        # 执行采样
        sampled_latent = common_ksampler(
            model=model_to_use,
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler=scheduler,
            positive=positive_condition,
            negative=negative_condition,
            latent=latent,
            denoise=denoise
        )[0]

        config.latent = sampled_latent
        return (config,)


# ====================== SamplerAdvancedNode ======================
class PipelineSamplerAdvancedNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
                "add_noise": (["enable", "disable"], {"default": "enable"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "start_step_rate": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0}),
                "end_step_rate": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0}),
                "return_with_leftover_noise": (["disable", "enable"], {"default": "disable"}),
            },
            "optional": {
                "loras": ("STRING", {"forceInput": True, "multiline": False}),  # 新增
                "positive": ("STRING", {"forceInput": True, "multiline": False}),  # 新增
                "negative": ("STRING", {"forceInput": True, "multiline": False}),  # 新增
            }   
        }

    RETURN_TYPES = ("PIPELINE_DATA",)
    RETURN_NAMES = ("pipeline",)
    FUNCTION = "sample_advanced"
    CATEGORY = "sampling/custom"

    def sample_advanced(self, pipeline: PipelineData, add_noise,
                        seed, start_step_rate, end_step_rate, return_with_leftover_noise,
                        loras=None, positive=None, negative=None):
        
        if end_step_rate <= 0 or end_step_rate < start_step_rate:
            return (pipeline,)
    
        config = pipeline.copy()

        if config.cache is None:
            raise ValueError("PipelineData 中 cache 为空")

        if config.model is None:
            raise ValueError("PipelineData 中 model 为空，无法采样")
        
        if loras is None:
            loras = config.loras
        if positive is None:
            positive = config.positive
        if negative is None:
            negative = config.negative

        # 解析 lora_configs（支持多行输入）
        lora_list = [line.strip() for line in loras.split("\n") if line.strip()]

        # 获取打过 LoRA 的 model 和 clip
        model_to_use, clip_to_use = config.cache.get_model_clip(
            model=config.model,
            clip=config.clip,
            loras=lora_list
        )

        # 获取 latent（支持 mask inpaint）
        latent = config.get_latent()
        
        # 获取 condition（使用新的 get_conditioning）
        positive_condition = config.get_conditioning(
            clip=clip_to_use,
            prompt=positive
        )
        negative_condition = config.get_conditioning(
            clip=clip_to_use,
            prompt=negative
        )

        sampler_name = config.sampler_name if config.sampler_name is not None else "euler"
        scheduler    = config.scheduler    if config.scheduler    is not None else "normal"
        steps        = config.steps       if config.steps         is not None else 20
        cfg          = config.cfg          if config.cfg          is not None else 8.0
        
        start_at_step = int(start_step_rate * steps)
        end_at_step = int(end_step_rate * steps)
        if end_at_step < start_at_step:
            end_at_step = start_at_step
        

        sampled_latent = KSamplerAdvanced().sample(
            model=model_to_use,
            add_noise=add_noise,
            noise_seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler=scheduler,
            positive=positive_condition,
            negative=negative_condition,
            latent_image=latent,
            start_at_step=start_at_step,
            end_at_step=end_at_step,
            return_with_leftover_noise=return_with_leftover_noise
        )[0]

        config.latent = sampled_latent
        return (config,)

# ====================== PipelineDetailerAdvancedNode ======================
class PipelineDetailerAdvancedNode:
    """
    高级 Detailer 节点（支持 Crop + Resize + Recover）
    重绘流程：Crop → Limit Pixels → KSamplerAdvanced → Recover Size → Recover Crop
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
                # Sampling 参数
                "add_noise": (["enable", "disable"], {"default": "enable"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "start_step_rate": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 1.0}),
                "end_step_rate": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0}),
                "return_with_leftover_noise": (["disable", "enable"], {"default": "disable"}),

                # Detailer 参数
                "detector_threshold": ("FLOAT", {"default": 0.3, "min": 0.0, "max": 1.0, "step": 0.01}),
                "detector_prompt": ("STRING", {"default": "", "multiline": False}),
                "detector_dilation": ("INT", {"default": 4}),
                "detector_crop_factor": ("FLOAT", {"default": 1.5}),
                "detector_drop_size": ("INT", {"default": 0}),
                "detector_grow": ("INT", {"default": 32}),
                "detector_blur": ("INT", {"default": 32}),

                # Crop & Resize 参数
                "pixels": ("INT", {"default": 1024*1024}),
                "crop_reserve": ("INT", {"default": 32}),

                # Recover 参数
                "recover_method": (["bounds_only", "mask_blend", "mask_only"], {"default": "mask_blend"}),
            },
            "optional": {
                "detector": ("*",),        # 通配符
                "mask": ("MASK",),         # 可选外部 mask（优先级更高）
                # LoRA & Prompt
                "loras": ("STRING", {"forceInput": True, "multiline": False}),
                "positive": ("STRING", {"forceInput": True, "multiline": False}),
                "negative": ("STRING", {"forceInput": True, "multiline": False}),
            }
        }

    RETURN_TYPES = ("PIPELINE_DATA", "MASK", "IMAGE", "MASK",)
    RETURN_NAMES = ("pipeline", "detailer_mask", "draw_image", "draw_mask",)
    FUNCTION = "detailer"
    CATEGORY = "sampling/custom"

    def detailer(self, pipeline: PipelineData,
                 add_noise, seed, start_step_rate, end_step_rate, return_with_leftover_noise,
                 detector_threshold, detector_prompt,
                 detector_dilation, detector_crop_factor, detector_drop_size, detector_grow, detector_blur,
                 pixels, crop_reserve,
                 recover_method,
                 detector=None, mask=None, loras=None, positive=None, negative=None):

        if end_step_rate <= 0 or end_step_rate < start_step_rate:
            return (pipeline, None, None, None,)

        config = pipeline.copy()

        if config.cache is None:
            raise ValueError("PipelineData 中 cache 为空")
        if config.model is None:
            raise ValueError("PipelineData 中 model 为空，无法 Detailer")

        original_image = config.get_image()          # (B, H, W, C) tensor

        detailer_mask = None

        if mask is not None:
            detailer_mask = mask
            print("使用外部输入的 mask 进行 Detailer")
        elif detector is not None:
            detailer_mask = detect_mask(
                detector=detector,
                image=original_image,
                threshold=detector_threshold,
                dilation=detector_dilation,
                crop_factor=detector_crop_factor,
                drop_size=detector_drop_size,
                prompt=detector_prompt
            )
            if detailer_mask is None:
                return (pipeline, None, None, None,)
        else:
            raise ValueError("detector 或 mask 必须提供")

        detailer_mask = expand_mask(detailer_mask, grow=detector_grow, blur=detector_blur)
        
        if loras is None:
            loras = config.loras
        if positive is None:
            positive = config.positive
        if negative is None:
            negative = config.negative
        
        lora_list = [line.strip() for line in loras.split("\n") if line.strip()]
        
        model_to_use, clip_to_use = config.cache.get_model_clip(
            model=config.model,
            clip=config.clip,
            loras=lora_list
        )

        positive_condition = config.get_conditioning(clip=clip_to_use, prompt=positive)
        negative_condition = config.get_conditioning(clip=clip_to_use, prompt=negative)
        
        cropped_image, cropped_mask, crop_info = crop_mask(
            image=original_image,
            mask=detailer_mask,
            reserve=crop_reserve
        )

        resized_image, resized_mask, resize_info = limit_pixels(
            image=cropped_image,
            pixels=pixels,
            mask=cropped_mask
        )
        
        tmp_latent = VAEEncode().encode(
            vae=config.vae, 
            pixels=resized_image
        )[0]

        sampler_name = config.sampler_name or "euler"
        scheduler = config.scheduler or "normal"
        steps = config.steps or 20
        cfg = config.cfg or 8.0

        start_at_step = int(start_step_rate * steps)
        end_at_step = int(end_step_rate * steps)

        tmp_latent = KSamplerAdvanced().sample(
            model=model_to_use,
            add_noise=add_noise,
            noise_seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler=scheduler,
            positive=positive_condition,
            negative=negative_condition,
            latent_image=tmp_latent,
            start_at_step=start_at_step,
            end_at_step=end_at_step,
            return_with_leftover_noise=return_with_leftover_noise
        )[0]
        
        detailed_image = VAEDecode().decode(vae=config.vae, samples=tmp_latent)[0]

        recovered_image, recovered_mask = recover_size(
            image=detailed_image,
            resize_info=resize_info,
            mask=resized_mask
        )

        final_image, final_mask = recover_crop(
            background=original_image,
            image=recovered_image,
            crop_info=crop_info,
            recover_method=recover_method,
            mask=recovered_mask
        )

        config.image = final_image
        config.latent = None

        return (config, final_mask, resized_image, resized_mask)


# ====================== SamplerDecodeNode ======================
class PipelineDecodeNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
            }
        }

    RETURN_TYPES = ("PIPELINE_DATA", "IMAGE")
    RETURN_NAMES = ("pipeline", "image")
    FUNCTION = "decode"
    CATEGORY = "sampling/custom"

    def decode(self, pipeline: PipelineData):
        config = pipeline.copy()
        return (config, config.get_image())
    

# ====================== PipelineLimitPixelNode ======================
class PipelineLimitPixelNode:
    """Limit image pixel count in pipeline by resizing if exceeding specified limit."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
                "pixels": ("INT", {
                    "default": 1024 * 1024,  # 1MP
                    "tooltip": "Maximum allowed pixel count"
                }),
            },
        }

    RETURN_TYPES = ("PIPELINE_DATA",)
    RETURN_NAMES = ("pipeline",)
    FUNCTION = "limit_pixels"
    CATEGORY = "sampling/custom"

    def limit_pixels(self, pipeline, pixels):
        """Limit image pixel count in pipeline by resizing if needed."""
        try:
            config = pipeline.copy()
            
            # 获取 image（如果不存在则从 latent 解码）
            config.get_image()

            # 调用 image_utils 中的 limit_pixels 函数
            resized_image, resized_mask, resize_info = limit_pixels(config.image, pixels, config.mask)

            # 更新 pipeline 中的图像和掩码
            config.image = resized_image
            config.mask = resized_mask
            # 将 resize_info 推入栈中
            config.resize_info_stack.append(resize_info)

            return (config,)

        except Exception as e:
            raise Exception(f"Failed to limit pixels: {e}")


# ====================== PipelineRecoverResizeNode ======================
class PipelineRecoverResizeNode:
    """Recover image to original size in pipeline using resize info."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
            },
        }

    RETURN_TYPES = ("PIPELINE_DATA",)
    RETURN_NAMES = ("pipeline",)
    FUNCTION = "recover_size"
    CATEGORY = "sampling/custom"

    def recover_size(self, pipeline):
        """Recover image to original size in pipeline using resize info."""
        try:
            config = pipeline.copy()
            
            # 获取 image（如果不存在则从 latent 解码）
            config.get_image()

            # 从栈中弹出 resize_info
            if not config.resize_info_stack:
                raise ValueError("No resize info in stack")
            resize_info = config.resize_info_stack.pop()

            # 调用 image_utils 中的 recover_size 函数
            recovered_image, recovered_mask = recover_size(config.image, resize_info, config.mask)

            # 更新 pipeline 中的图像和掩码
            config.image = recovered_image
            config.mask = recovered_mask

            return (config,)

        except Exception as e:
            raise Exception(f"Failed to recover image size: {e}")

# ====================== PipelineAddNoiseNode ======================
class PipelineAddNoiseNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
                "add_noise": ("BOOLEAN", {"default": True}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "noise_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
            }
        }

    RETURN_TYPES = ("PIPELINE_DATA",)
    RETURN_NAMES = ("pipeline",)
    FUNCTION = "add_noise"
    CATEGORY = "sampling/custom"

    def add_noise(self, pipeline, add_noise, seed=0, noise_strength=1.0):
        if not add_noise:
            # 不加噪声（返回原始 latent）
            return (pipeline,)
        
        config = pipeline.copy()
        latent = config.get_latent()
        samples = latent["samples"].clone()  # 避免修改原 tensor

        # 生成噪声并添加
        batch_inds = latent.get("batch_index", None)
        noise = comfy.sample.prepare_noise(samples, seed, batch_inds)

        if noise_strength != 1.0:
            noise = noise * noise_strength

        samples = samples + noise

        # 更新 pipeline 中的 latent
        config.latent = {"samples": samples, **{k: v for k, v in latent.items() if k != "samples"}}

        return (config,)
    
class PipelineToggleMaskInpaintNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
                "grow_mask_by": ("INT", {"default": 0}),
                "enable": ("BOOLEAN", {"default": True})
            },
            "optional": {
                "mask": ("MASK",)
            }
        }
        
    RETURN_TYPES = ("PIPELINE_DATA",)
    RETURN_NAMES = ("pipeline",)
    FUNCTION = "toggle_mask_inpaint"
    CATEGORY = "sampling/custom"
    
    def toggle_mask_inpaint(self, pipeline, grow_mask_by, enable, mask=None):
        config = pipeline.copy()
        latent = config.get_latent()
        
        if "noise_mask" in latent:
            del latent["noise_mask"] 
        
        if not enable:
            return (config,)
        
        inpaint_mask = mask if mask is not None else config.mask
        latent = SetLatentNoiseMask().set_mask(
            samples=latent,
            mask=inpaint_mask,
            grow_mask_by=grow_mask_by
        )[0]
            
        return (config,)
    
    
# ====================== PipelineDetectNode ======================
class PipelineDetectNode:
    """
    专门的检测节点：只负责从 detector 中提取 mask
    detector 为必填输入，不再支持外部 mask 输入
    输出 pipeline（原样传递）和提取出的 mask
    """
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
                "detector": ("*",),                    # 改为 required

                # Detector 参数
                "detector_threshold": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
                "detector_prompt": ("STRING", {"default": "face, person", "multiline": False}),
                "detector_dilation": ("INT", {"default": 4, "min": 0, "max": 64}),
                "detector_crop_factor": ("FLOAT", {"default": 1.5, "min": 1.0, "max": 4.0, "step": 0.1}),
                "detector_drop_size": ("INT", {"default": 0, "min": 0, "max": 512}),
            }
        }

    RETURN_TYPES = ("PIPELINE_DATA", "MASK")
    RETURN_NAMES = ("pipeline", "mask")
    FUNCTION = "detect"
    CATEGORY = "sampling/custom"

    def detect(self, pipeline: PipelineData,
               detector,
               detector_threshold=0.5, detector_prompt="face, person",
               detector_dilation=4, detector_crop_factor=1.5, detector_drop_size=0):

        if detector is None:
            raise ValueError("必须传入 detector 对象（detector 为必填输入）")

        config = pipeline.copy()

        # ====================== 1. 获取原始图像 ======================
        original_image = config.get_image()          # (B, H, W, C) tensor

        # ====================== 2. 生成 Detection Mask ======================
        detailer_mask = detect_mask(
            detector=detector,
            image=original_image,
            threshold=detector_threshold,
            dilation=detector_dilation,
            crop_factor=detector_crop_factor,
            drop_size=detector_drop_size,
            prompt=detector_prompt
        )

        # 原样返回 pipeline（不做任何修改）
        return (config, detailer_mask,)