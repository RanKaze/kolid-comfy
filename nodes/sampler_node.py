from pickle import DICT
import re
import comfy
import folder_paths
import os
import torch
import gc
import json
import math
import time
from PIL import Image
from nodes import common_ksampler, VAEEncode, VAEEncodeForInpaint, KSamplerAdvanced, VAEDecode, SetLatentNoiseMask, CLIPTextEncode
from comfy_api.latest import ComfyExtension, io, ui, Input, InputImpl, Types
import comfy.model_management as mm
from ..libs.image_utils import limit_pixels, recover_size, crop_mask, recover_crop
from ..libs.detect_utils import detect_mask
from ..libs.mask_utils import combine_masks, create_empty_mask, expand_mask, invert_mask
from ..libs.caption_utils import get_tag, get_similarity
from decord import VideoReader, cpu
from ..libs.image_utils import draw_mask_on_image, draw_mask, batch_images
import comfy.sampler_helpers
import latent_preview


# ====================== Dual Model CFG Guider ======================
class DualModelCFGGuider(comfy.samplers.CFGGuider):
    """使用两个不同 model 的 CFG Guider：正向用 model，负向用 model_negative"""

    def __init__(self, model_patcher, model_patcher_negative):
        super().__init__(model_patcher)
        self.model_patcher_negative = model_patcher_negative
        self.inner_model_negative = None
        self.model_options_negative = model_patcher_negative.model_options

    def outer_sample(self, noise, latent_image, sampler, sigmas,
                     denoise_mask=None, callback=None, disable_pbar=False,
                     seed=None, latent_shapes=None):
        self.inner_model, self.conds, self.loaded_models = \
            comfy.sampler_helpers.prepare_sampling(
                self.model_patcher, noise.shape, self.conds, self.model_options)

        self.inner_model_negative, _, loaded_models_neg = \
            comfy.sampler_helpers.prepare_sampling(
                self.model_patcher_negative, noise.shape,
                self.conds, self.model_options_negative)
        self.loaded_models.extend(loaded_models_neg)

        device = self.model_patcher.load_device
        noise = noise.to(device=device, dtype=torch.float32)
        latent_image = latent_image.to(device=device, dtype=torch.float32)
        sigmas = sigmas.to(device)
        comfy.samplers.cast_to_load_options(
            self.model_options, device=device,
            dtype=self.model_patcher.model_dtype())
        comfy.samplers.cast_to_load_options(
            self.model_options_negative, device=device,
            dtype=self.model_patcher_negative.model_dtype())

        try:
            self.model_patcher.pre_run()
            self.model_patcher_negative.pre_run()
            output = self.inner_sample(
                noise, latent_image, device, sampler, sigmas,
                denoise_mask, callback, disable_pbar, seed,
                latent_shapes=latent_shapes)
        finally:
            self.model_patcher.cleanup()
            self.model_patcher_negative.cleanup()

        comfy.sampler_helpers.cleanup_models(self.conds, self.loaded_models)
        del self.inner_model
        del self.inner_model_negative
        del self.loaded_models
        return output

    def predict_noise(self, x, timestep, model_options={}, seed=None):
        positive_cond = self.conds.get("positive", None)
        negative_cond = self.conds.get("negative", None)

        if math.isclose(self.cfg, 1.0) and \
           model_options.get("disable_cfg1_optimization", False) == False:
            out = comfy.samplers.calc_cond_batch(
                self.inner_model, [positive_cond], x, timestep, model_options)
            return out[0]

        out_pos = comfy.samplers.calc_cond_batch(
            self.inner_model, [positive_cond], x, timestep, model_options)
        out_neg = comfy.samplers.calc_cond_batch(
            self.inner_model_negative, [negative_cond], x, timestep,
            self.model_options_negative)

        return comfy.samplers.cfg_function(
            self.inner_model, out_pos[0], out_neg[0], self.cfg,
            x, timestep, model_options=model_options,
            cond=positive_cond, uncond=negative_cond)


def _ksampler(model, seed, steps, cfg, sampler_name, scheduler, positive, negative,
              latent, denoise=1.0, disable_noise=False, start_step=None, last_step=None,
              force_full_denoise=False, sigmas=None, model_negative=None):
    """统一采样函数：支持 custom sigmas 和 dual model CFG"""
    latent_image = latent["samples"]
    latent_image = comfy.sample.fix_empty_latent_channels(
        model, latent_image,
        latent.get("downscale_ratio_spacial", None),
        latent.get("downscale_ratio_temporal", None))

    if disable_noise:
        noise = torch.zeros(latent_image.size(), dtype=latent_image.dtype,
                             layout=latent_image.layout, device="cpu")
    else:
        batch_inds = latent.get("batch_index", None)
        noise = comfy.sample.prepare_noise(latent_image, seed, batch_inds)

    noise_mask = None
    if "noise_mask" in latent:
        noise_mask = latent["noise_mask"]

    # 计算 sigmas：若外部传入则直接使用，否则从 steps/scheduler/denoise 计算
    if sigmas is not None:
        actual_steps = len(sigmas) - 1
    else:
        ksampler = comfy.samplers.KSampler(
            model, steps=steps, device=model.load_device,
            sampler=sampler_name, scheduler=scheduler, denoise=denoise,
            model_options=model.model_options)
        sigmas = ksampler.sigmas
        actual_steps = steps

    # 截断 sigmas（与 KSampler.sample 逻辑一致）
    if last_step is not None and last_step < (len(sigmas) - 1):
        sigmas = sigmas[:last_step + 1]
        if force_full_denoise:
            sigmas[-1] = 0
    if start_step is not None:
        if start_step < (len(sigmas) - 1):
            sigmas = sigmas[start_step:]
        else:
            out = latent.copy()
            out.pop("downscale_ratio_spacial", None)
            out.pop("downscale_ratio_temporal", None)
            out["samples"] = latent_image
            return (out,)

    sampler_obj = comfy.samplers.sampler_object(sampler_name)
    callback = latent_preview.prepare_callback(model, actual_steps)
    disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED

    if model_negative is not None:
        guider = DualModelCFGGuider(model, model_negative)
    else:
        guider = comfy.samplers.CFGGuider(model)
    guider.set_conds(positive, negative)
    guider.set_cfg(cfg)
    samples = guider.sample(noise, latent_image, sampler_obj, sigmas,
                            denoise_mask=noise_mask, callback=callback,
                            disable_pbar=disable_pbar, seed=seed)
    samples = samples.to(device=comfy.model_management.intermediate_device(),
                         dtype=comfy.model_management.intermediate_dtype())

    out = latent.copy()
    out.pop("downscale_ratio_spacial", None)
    out.pop("downscale_ratio_temporal", None)
    out["samples"] = samples
    return (out,)


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

# Build cache once at module load time
_build_lora_cache()


def set_inpaint_mask(resized_image: torch.Tensor, resized_mask: torch.Tensor, vae, grow_mask_by: int = 0):
    """
    【新增独立函数】处理 inpaint_mode 下的 mask 与 image 预处理
    对应原 PipelineDetailerAdvancedNode 中的 inpaint_mode 逻辑
    
    返回: (processed_image, noise_mask_latent)
    """
    import torch
    import math
    
    # 获取 VAE 压缩率（通常是 8）
    downscale_ratio = vae.spacial_compression_encode() if hasattr(vae, 'spacial_compression_encode') else 8
    
    # 计算对齐后的尺寸
    x = (resized_image.shape[1] // downscale_ratio) * downscale_ratio
    y = (resized_image.shape[2] // downscale_ratio) * downscale_ratio
    
    # 插值调整 mask 到图像尺寸
    resized_mask = torch.nn.functional.interpolate(
        resized_mask.reshape((-1, 1, resized_mask.shape[-2], resized_mask.shape[-1])),
        size=(resized_image.shape[1], resized_image.shape[2]),
        mode="bilinear"
    )

    resized_image = resized_image.clone()
    
    # 裁剪到 VAE 对齐尺寸
    if resized_image.shape[1] != x or resized_image.shape[2] != y:
        x_offset = (resized_image.shape[1] % downscale_ratio) // 2
        y_offset = (resized_image.shape[2] % downscale_ratio) // 2
        resized_image = resized_image[:, x_offset:x + x_offset, y_offset:y + y_offset, :]
        resized_mask = resized_mask[:, :, x_offset:x + x_offset, y_offset:y + y_offset]

    # 根据 grow_mask_by 扩展 mask（用于 latent 空间无缝过渡）
    if grow_mask_by == 0:
        mask_erosion = resized_mask
    else:
        kernel_tensor = torch.ones((1, 1, grow_mask_by, grow_mask_by))
        padding = math.ceil((grow_mask_by - 1) / 2)
        mask_erosion = torch.clamp(
            torch.nn.functional.conv2d(resized_mask.round(), kernel_tensor, padding=padding),
            0, 1
        )

    # 将 mask 区域的图像内容置为灰色（0.5）
    m = (1.0 - resized_mask.round()).squeeze(1)
    for i in range(3):
        resized_image[:, :, :, i] -= 0.5
        resized_image[:, :, :, i] *= m
        resized_image[:, :, :, i] += 0.5

    # 编码为 latent 并附加 noise_mask
    t = vae.encode(resized_image)
    tmp_latent = {
        "samples": t,
        "noise_mask": mask_erosion[:, :, :x, :y].round()
    }
    
    return resized_image, tmp_latent

def conditioning_set_values(conditioning, values={}, append=False):
    c = []
    for t in conditioning:
        n = [t[0], t[1].copy()]
        for k in values:
            val = values[k]
            if append:
                old_val = n[1].get(k, None)
                if old_val is not None:
                    val = old_val + val

            n[1][k] = val
        c.append(n)

    return c

def get_loras_from_string(loras: str) -> list[str]:
    """从 LoRA 格式字符串中提取 lora 条目列表。"""
    if not loras:
        return []
    return re.findall(r"(?<=\<)(lora(?:_path)?:[^>]+)(?=\>)", loras)


class SamplerContext:
    def __init__(self):
        self.positive = None
        self.negative = None
        self.loras = None
    def copy(self):
        new = SamplerContext()
        new.positive = self.positive
        new.negative = self.negative
        new.loras = self.loras
        return new

class ContextData:
    def __init__(self):
        self.contexts = {}
        self.queries = {}
    
    def copy(self):
        new = ContextData()
        new.contexts = self.contexts.copy()
        new.queries = self.queries.copy()
        return new
    
    def get_context(self, regex_pattern: str) -> (str, str, list[str]):
        if self.contexts is None:
            raise ValueError("PipelineData 中 contexts 为空")
        positive_parts = []
        negative_parts = []
        loras = []

        for name, context in self.contexts.items():
            if re.match(regex_pattern, name):
                if context.positive:
                    positive_parts.append(context.positive.strip())
                if context.negative:
                    negative_parts.append(context.negative.strip())
                if context.loras:
                    loras.extend(context.loras)

        positive = ",".join(positive_parts).strip(",")
        negative = ",".join(negative_parts).strip(",")
        return (positive, negative, loras, )
    
    def get_prompt_context(self, prompt: str | None, image: torch.Tensor | None) -> (str, str, list[str]):
        if self.contexts is None:
            raise ValueError("PipelineData 中 contexts 为空")
        
        positive_parts = []
        negative_parts = []
        loras = []
        if prompt is not None and prompt != '' and image is not None:  
            for qurey_id, query_datas in self.queries.items():
                match_index = -1
                match_score = 0
                data_size = len(query_datas)
                for query_data_index in range(data_size):
                    query_data = query_datas[query_data_index]
                    original_image = query_data["image"]
                    model = query_data["model"]
                    threshold = query_data["threshold"]
                    prompt_regex = query_data["prompt_regex"]
                    need_context_regex = query_data["need_context_regex"]
                    if re.match(prompt_regex, prompt):
                        similarity = get_similarity(model, original_image, image)
                        print(f"[Query({qurey_id})]({prompt_regex}): {need_context_regex} : {similarity}({threshold})")
                        if similarity > threshold:
                            if similarity > match_score:
                                match_index = query_data_index
                                match_score = similarity
                                break
                    else:
                        print(f"[Query({qurey_id})]({prompt_regex}): Fail Prompt")
                if match_index != -1:
                    for name, context in self.contexts.items():
                        query_data = query_datas[match_index]
                        need_context_regex = query_data["need_context_regex"]
                        if re.match(need_context_regex, name):
                            if context.positive:
                                positive_parts.append(context.positive.strip())
                            if context.negative:
                                negative_parts.append(context.negative.strip())
                            if context.loras:
                                loras.extend(context.loras)

        positive = ",".join(positive_parts).strip(",")
        negative = ",".join(negative_parts).strip(",")
        return (positive, negative, loras, )

from ..architecture import Krea2 as arch_krea2
from ..architecture import Flux2Klein as arch_flux2klein
from ..architecture import QwenEdit as arch_qwen_edit


class ReferenceData:
    def __init__(self):
        self.reference_latents = []
        self.reference_controls = []
        self.reference_ipadapters = []
        self.positive_guidance = None
        self.negative_guidance = None

    def copy(self):
        new = ReferenceData()
        new.reference_latents = self.reference_latents.copy()
        new.reference_controls = self.reference_controls.copy()
        new.reference_ipadapters = self.reference_ipadapters.copy()
        new.positive_guidance = self.positive_guidance
        new.negative_guidance = self.negative_guidance
        return new
    

class ConfigData(dict):
    pass


class SamplerCache:
    def __init__(self):
        self._cache = {}

    def copy(self):
        new = SamplerCache()
        new._cache = self._cache.copy()
        return new

    @staticmethod
    def _apply_loras(model_patcher, clip_patcher, loras):
        """对 model_patcher / clip_patcher 应用 LoRA 列表，返回 (model_patcher, clip_patcher)"""
        if not loras:
            return model_patcher, clip_patcher

        print(f"Loading LoRAs: {loras}")

        for item in loras:
            if not isinstance(item, str) or not item.strip():
                continue

            lora_str = item.strip()
            if lora_str.startswith("<") and lora_str.endswith(">"):
                lora_str = lora_str[1:-1].strip()

            try:
                if lora_str.startswith("lora_path:"):
                    body = lora_str[len("lora_path:"):]
                    last_colon = body.rfind(":")
                    if last_colon == -1:
                        print(f"Warning: 格式错误，需要 lora_path:path:strength: {lora_str}")
                        continue
                    lora_path = body[:last_colon].strip()
                    strength = float(body[last_colon+1:].strip())
                    lora_name = lora_path.replace("/", "\\").split("\\")[-1]
                elif lora_str.startswith("lora:"):
                    parts = lora_str.split(":", 2)
                    if len(parts) != 3:
                        print(f"Warning: 格式错误，需要 lora:name:strength: {lora_str}")
                        continue
                    lora_name = parts[1].strip()
                    strength = float(parts[2].strip())
                    lora_path = _lora_path_cache.get(lora_name)
                    if lora_path is None:
                        for key in _lora_path_cache:
                            if key == lora_name or key.endswith("/" + lora_name) or key.endswith("\\" + lora_name):
                                lora_path = _lora_path_cache[key]
                                break
                    if lora_path is None:
                        print(f"Warning: 未找到 LoRA 文件: {lora_name}")
                        continue
                else:
                    print(f"Warning: 必须以 lora: 或 lora_path: 开头: {lora_str}")
                    continue

                lora_dict = comfy.utils.load_torch_file(lora_path, safe_load=True)

                model_patcher, clip_patcher = comfy.sd.load_lora_for_models(
                    model_patcher,
                    clip_patcher,
                    lora_dict,
                    strength,
                    strength
                )

                print(f"✓ Applied LoRA: {lora_name} (strength={strength})")

            except Exception as e:
                print(f"Failed to load LoRA '{item}': {type(e).__name__} - {e}")

        return model_patcher, clip_patcher

    def get_model_clip(self, model, clip, loras: list = None, reference: ReferenceData = None, model_negative=None):
        if model is None:
            raise ValueError("传入的 model 不能为空")

        if loras is None:
            loras = []

        # ---- 正向 model + clip ----
        cache_key = (id(model), id(clip) if clip is not None else None, frozenset(loras))

        if cache_key in self._cache:
            print(f"✓ LoRA model cache hit")
            model_patcher, clip_patcher = self._cache[cache_key]
        else:
            model_patcher, clip_patcher = self._apply_loras(model, clip, loras)
            result = (model_patcher, clip_patcher)
            self._cache[cache_key] = result

        # ---- 负向 model (也应用相同 LoRA) ----
        model_negative_patcher = None
        if model_negative is not None:
            neg_cache_key = (id(model_negative), None, frozenset(loras))

            if neg_cache_key in self._cache:
                print(f"✓ LoRA model_negative cache hit")
                model_negative_patcher, _ = self._cache[neg_cache_key]
            else:
                model_negative_patcher, _ = self._apply_loras(model_negative, None, loras)
                self._cache[neg_cache_key] = (model_negative_patcher, None)

        # ========== 应用 Reference IPAdapter ==========
        if reference is not None and reference.reference_ipadapters:
            try:
                from nodes import NODE_CLASS_MAPPINGS as ALL_NODE_CLASS_MAPPINGS
            except Exception:
                ALL_NODE_CLASS_MAPPINGS = {}

            for ipa_cfg in reference.reference_ipadapters:
                preset = ipa_cfg.get("preset")
                weight_style = ipa_cfg.get("weight_style", 1.0)
                weight_composition = ipa_cfg.get("weight_composition", 1.0)
                expand_style = ipa_cfg.get("expand_style", False)
                combine_embeds = ipa_cfg.get("combine_embeds", "average")
                start_at = ipa_cfg.get("start_at", 0.0)
                end_at = ipa_cfg.get("end_at", 1.0)
                embeds_scaling = ipa_cfg.get("embeds_scaling", "V only")
                cache_mode = ipa_cfg.get("cache_mode", "all")
                image_style = ipa_cfg.get("image_style")
                image_composition = ipa_cfg.get("image_composition")
                image_negative = ipa_cfg.get("image_negative")
                attn_mask = ipa_cfg.get("attn_mask")
                clip_vision = ipa_cfg.get("clip_vision")

                if image_style is None:
                    continue

                easy_ipa_class = None
                for key in ["easy ipadapterStyleComposition", "ipadapterStyleComposition"]:
                    if key in ALL_NODE_CLASS_MAPPINGS:
                        easy_ipa_class = ALL_NODE_CLASS_MAPPINGS[key]
                        break

                if easy_ipa_class is not None:
                    try:
                        ipa_instance = easy_ipa_class()
                        model_patcher, _ = ipa_instance.apply(
                            model=model_patcher,
                            preset=preset,
                            weight_style=weight_style,
                            weight_composition=weight_composition,
                            expand_style=expand_style,
                            combine_embeds=combine_embeds,
                            start_at=start_at,
                            end_at=end_at,
                            embeds_scaling=embeds_scaling,
                            cache_mode=cache_mode,
                            image_style=image_style,
                            image_composition=image_composition,
                            image_negative=image_negative,
                            clip_vision=clip_vision,
                            attn_mask=attn_mask,
                        )
                        print(f"✓ Applied Reference IPAdapter: preset={preset}, weight_style={weight_style}, weight_composition={weight_composition}")
                    except Exception as e:
                        print(f"Failed to apply Reference IPAdapter (preset={preset}): {type(e).__name__} - {e}")
                else:
                    print(f"Warning: ComfyUI-Easy-Use 的 ipadapterStyleComposition 节点未找到，跳过 Reference IPAdapter 应用")

        return (model_patcher, clip_patcher, model_negative_patcher)


# ====================== PipelineData 类（只返回 condition） ======================
import traceback

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
                 context=None,
                 reference=None,
                 config=None,
                 ):
        
        self.cache = cache
        self.model = model
        self.clip = clip
        self.vae = vae
        self.image = image
        self.latent = latent
        self._mask = None
        self.mask = mask  # 通过 setter 赋值以触发追踪
        self.sampler_name = sampler_name
        self.scheduler = scheduler
        self.steps = steps
        self.cfg = cfg
        self.context = context if context else ContextData()
        self.reference = reference if reference else ReferenceData()
        self.config = config if config else ConfigData()
        self.resize_info_stack = []  # 使用栈来存储 resize_info
        
        # Conditioning 缓存: key = (clip_id, prompt, frozenset(loras)) → condition
        self._conditioning_cache = {}

    @property
    def mask(self):
        return self._mask

    @mask.setter
    def mask(self, value):
        old = self._mask
        self._mask = value
        # 仅在 mask 实际变化（id 不同）时打印，避免 clone 后相同值重复打印
        if old is not value:
            stack = traceback.format_stack(limit=4)
            caller = stack[-2].strip() if len(stack) >= 2 else 'unknown'
            old_info = f"id={id(old)}, shape={old.shape}, sum={old.sum().item():.1f}" if old is not None else "None"
            new_info = f"id={id(value)}, shape={value.shape}, sum={value.sum().item():.1f}" if value is not None else "None"
            print(f"[MASK-TRACE] PipelineData.mask CHANGED | old={old_info} | new={new_info}")
            print(f"[MASK-TRACE]   caller: {caller}")
    def copy(self):
        new = PipelineData(
            cache=self.cache.copy() if self.cache else None,
            model=self.model,
            clip=self.clip,
            vae=self.vae,
            image=self.image,
            latent=self.latent,
            mask=self.mask.clone() if self.mask is not None else None,  # 深拷贝 mask，杜绝跨 pipeline 的引用共享
            sampler_name=self.sampler_name,
            scheduler=self.scheduler,
            steps=self.steps,
            cfg=self.cfg,
            context=self.context.copy() if self.context else None,
            reference=self.reference.copy() if self.reference else None,
            config=self.config.copy() if self.config else None,
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
    def get_conditioning(self, mode, clip, vae, prompt: str, reference_latent = None, reference_image = None, reference = None):
        if clip is None:
            raise ValueError("无法获取有效的 clip")
        if self.cache is None:
            raise ValueError("PipelineData 中 cache 为空")
        if prompt is None:
            prompt = ""

        architecture = self.config.get("architecture") if self.config else None
        condition = None

        # QwenEdit: 独立步骤，可叠加在 architecture 之上
        if self.config and self.config.get("enable_qwen_edit"):
            condition = arch_qwen_edit.get_conditioning(
                self, mode, clip, vae, prompt, reference_latent, reference_image,
                reference, conditioning_set_values, VAEDecode
            )

        # Architecture: 基础 conditioning
        if architecture and re.search(r"Krea2", architecture, re.IGNORECASE):
            condition = arch_krea2.get_conditioning(
                self, mode, clip, vae, prompt, reference_latent, reference_image,
                reference, conditioning_set_values, VAEDecode
            )
        elif architecture and re.search(r"Flux2Klein", architecture, re.IGNORECASE):
            condition = arch_flux2klein.get_conditioning(
                self, mode, clip, vae, prompt, reference_latent, reference_image,
                reference, conditioning_set_values, VAEDecode
            )
        else:
            if condition is None:
                # 默认: 无 reference 处理
                cache_key = (id(clip), prompt)
                if cache_key in self._conditioning_cache:
                    print(f"✓ Conditioning cache hit")
                    condition = self._conditioning_cache[cache_key]
                else:
                    print(f"x Conditioning cache miss")
                    condition = CLIPTextEncode().encode(clip=clip, text=prompt)[0]
                    self._conditioning_cache[cache_key] = condition
                return condition
        
        if reference.reference_controls is not None:
            for control in reference.reference_controls:
                control_net = control["control_net"]
                image = control["image"]
                if image is None:
                    image = reference_image
                strength = control["strength"]
                start_percent = control["start_percent"]
                end_percent = control["end_percent"]

                # ==================== 应用 ControlNet 到 conditioning ====================
                if strength <= 0:
                    continue  # strength 为 0 时跳过

                # 准备 control_hint (ComfyUI 标准做法：从 HWC -> CHW)
                control_hint = image.movedim(-1, 1)  # [B, H, W, C] -> [B, C, H, W]

                # 对 positive 和 negative 都应用（如果你只想应用到 positive，可只处理 condition）
                # 这里因为你的函数只返回一个 condition（通常是 positive），我们只处理当前 condition
                c = []  # 新的 conditioning list
                for t in condition:  # condition 通常是 list of [tensor, dict]
                    d = t[1].copy()   # 复制 metadata dict

                    # 处理 controlnet 链（防止重复 apply 同一个 controlnet）
                    prev_cnet = d.get('control', None)
                    
                    # 这里我们简化处理：每次都新建一个 controlnet 实例（推荐做法）
                    c_net = control_net.copy().set_cond_hint(
                        control_hint, 
                        strength, 
                        (start_percent, end_percent),
                        vae=vae, 
                        extra_concat=[]  # 如果有 extra_concat 可以在这里传入
                    )
                    
                    if prev_cnet is not None:
                        c_net.set_previous_controlnet(prev_cnet)

                    d['control'] = c_net
                    d['control_apply_to_uncond'] = False  # 通常设为 False，避免影响 negative

                    n = [t[0], d]
                    c.append(n)

                condition = c  # 更新 condition
        
        if mode == "positive":
            if reference.positive_guidance is not None:
                condition = conditioning_set_values(condition, {"guidance": reference.positive_guidance})   
        elif mode == "negative":
            if reference.negative_guidance is not None:
                condition = conditioning_set_values(condition, {"guidance": reference.negative_guidance})   
                
        return condition


class ContextNode:
    @classmethod
    def INPUT_TYPES(s):
        return{
            "required": {
                "name": ("STRING", {"default": ""}),    
            },
            "optional": {
                "context": ("CONTEXT_DATA",),
                "loras": ("STRING", {"forceInput": True}),
                "positive": ("STRING", {"forceInput": True}),
                "negative": ("STRING", {"forceInput": True}),
            }
        }
        
    RETURN_TYPES = ("CONTEXT_DATA",)
    RETURN_NAMES = ("context",)
    FUNCTION = "process"
    CATEGORY = "sampling/custom"
    
    def process(self,
                name="",
                context : ContextData = None,
                loras=None,
                positive=None,
                negative=None):
        if context is None:
            context = ContextData()
        else:
            context = context.copy()
        
        if name in context.contexts:
            sampler_context = context.contexts[name]
            if sampler_context.positive is None:
                sampler_context.positive = positive
            elif positive is not None:
                sampler_context.positive += ',' + positive
                
            if sampler_context.negative is None:
                sampler_context.negative = negative
            elif negative is not None:
                sampler_context.negative += ',' + negative
                
            if sampler_context.loras is None:
                sampler_context.loras = get_loras_from_string(loras)
            elif loras is not None:
                sampler_context.loras.extend(get_loras_from_string(loras))
                
        else:
            sampler_context = SamplerContext()
            sampler_context.positive = positive
            sampler_context.negative = negative
            if loras is not None:
                sampler_context.loras = get_loras_from_string(loras)
            else:
                sampler_context.loras = None
            context.contexts[name] = sampler_context

        return (context,)
    
class ContextQueryNode:
    @classmethod
    def INPUT_TYPES(s):
        return{
            "required": {
                "query_id": ("STRING", {"default": ""}),
                "image": ("IMAGE",),  
                "threshold": ("FLOAT", {"default": 0.8}),  
                "similarity_model": ("*",),
                "prompt_regex": ("STRING", {"default": ".+"}),
                "need_context_regex": ("STRING", {"default": ""}),
            },
            "optional": {
                "context": ("CONTEXT_DATA",),
            }
        }
        
    RETURN_TYPES = ("CONTEXT_DATA",)
    RETURN_NAMES = ("context",)
    FUNCTION = "process"
    CATEGORY = "sampling/custom"
    
    def process(self, query_id, image, threshold, similarity_model, prompt_regex, need_context_regex,
                context : ContextData = None):
        if context is None:
            context = ContextData()
        else:
            context = context.copy()
        
        if query_id not in context.queries:
            context.queries[query_id] = []
            
        context.queries[query_id].append({
            "image": image,
            "threshold": threshold,
            "model": similarity_model,
            "prompt_regex": prompt_regex,
            "need_context_regex": need_context_regex,
        })
        
        return (context,)

class ReferenceLatentNode:
    INPUT_IS_LIST = True

    @classmethod
    def INPUT_TYPES(s):
        return{
            "required": {
            },
            "optional": {
                "reference": ("REFERENCE_DATA",),
                "latent": ("LATENT",),
            }
        }
        
    RETURN_TYPES = ("REFERENCE_DATA",)
    RETURN_NAMES = ("reference",)
    FUNCTION = "process"
    CATEGORY = "sampling/custom"
    
    def process(self,
                reference=None,
                latent=None):
        if reference is None:
            reference = ReferenceData()
        else:
            reference = reference[0].copy() if isinstance(reference, list) else reference.copy()
        
        if latent is not None:
            for lat in (latent if isinstance(latent, list) else [latent]):
                reference.reference_latents.append(lat)
        return (reference,)

class ReferenceImageNode:
    INPUT_IS_LIST = True

    @classmethod
    def INPUT_TYPES(s):
        return{
            "required": {
            },
            "optional": {
                "reference": ("REFERENCE_DATA",),
                "image": ("IMAGE",),
                "vae": ("VAE",),
            }
        }
        
    RETURN_TYPES = ("REFERENCE_DATA",)
    RETURN_NAMES = ("reference",)
    FUNCTION = "process"
    CATEGORY = "sampling/custom"
    
    def process(self,
                reference=None,
                image=None,
                vae=None):
        if reference is None:
            reference = ReferenceData()
        else:
            reference = reference[0].copy() if isinstance(reference, list) else reference.copy()
        
        if image is not None:
            vae = vae[0] if isinstance(vae, list) else vae
            for img in (image if isinstance(image, list) else [image]):
                latent = VAEEncode().encode(vae=vae, pixels=img)[0]
                reference.reference_latents.append(latent)
        return (reference,)

class ReferenceContolNetNode:
    @classmethod
    def INPUT_TYPES(s):
        return{
            "required": {
            },
            "optional": {
                "reference": ("REFERENCE_DATA",),
                "control_net": ("CONTROL_NET",),
                "image": ("IMAGE",),
                "strength": ("FLOAT", {"default": 1.0}),
                "start_percent": ("FLOAT", {"default": 0.0}),
                "end_percent": ("FLOAT", {"default": 1.0}),
            }
        }
        
    RETURN_TYPES = ("REFERENCE_DATA",)
    RETURN_NAMES = ("reference",)
    FUNCTION = "process"
    CATEGORY = "sampling/custom"
    
    def process(self,
                reference : ReferenceData = None,
                control_net=None, 
                image=None,
                strength=None,
                start_percent=None,
                end_percent=None):
        if reference is None:
            reference = ReferenceData()
        else:
            reference = reference.copy()
        
        if control_net is not None:
            reference.reference_controls.append({"control_net": control_net, "image": image, "strength": strength, "start_percent": start_percent, "end_percent": end_percent})
        return (reference,)

class ReferenceGuidanceNode:
    @classmethod
    def INPUT_TYPES(s):
        return{
            "required": {
            },
            "optional": {
                "reference": ("REFERENCE_DATA",),
                "positive_guidance": ("FLOAT", {"forceInput": True}),
                "negative_guidance": ("FLOAT", {"forceInput": True}),
            }
        }

    RETURN_TYPES = ("REFERENCE_DATA",)
    RETURN_NAMES = ("reference",)
    FUNCTION = "process"
    CATEGORY = "sampling/custom"

    def process(self,
                reference : ReferenceData = None,
                positive_guidance=None,
                negative_guidance=None):
        if reference is None:
            reference = ReferenceData()
        else:
            reference = reference.copy()

        if positive_guidance is not None:
            reference.positive_guidance = positive_guidance
        if negative_guidance is not None:
            reference.negative_guidance = negative_guidance

        return (reference,)

class ReferenceIPAdapterNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "preset": ([
                    'LIGHT - SD1.5 only (low strength)',
                    'STANDARD (medium strength)',
                    'VIT-G (medium strength)',
                    'PLUS (high strength)',
                    'PLUS (kolors genernal)',
                    'REGULAR - FLUX and SD3.5 only (high strength)',
                    'PLUS FACE (portraits)',
                    'FULL FACE - SD1.5 only (portraits stronger)',
                    'COMPOSITION'
                ],),
                "weight_style": ("FLOAT", {"default": 1.0, "min": -1, "max": 5, "step": 0.05}),
                "weight_composition": ("FLOAT", {"default": 1.0, "min": -1, "max": 5, "step": 0.05}),
                "expand_style": ("BOOLEAN", {"default": False}),
                "combine_embeds": (["concat", "add", "subtract", "average", "norm average"], {"default": "average"}),
                "start_at": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.001}),
                "end_at": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.001}),
                "embeds_scaling": (['V only', 'K+V', 'K+V w/ C penalty', 'K+mean(V) w/ C penalty'],),
                "cache_mode": (["insightface only", "clip_vision only", "ipadapter only", "all", "none"], {"default": "all"}),
            },
            "optional": {
                "reference": ("REFERENCE_DATA",),
                "image_style": ("IMAGE",),
                "image_composition": ("IMAGE",),
                "image_negative": ("IMAGE",),
                "attn_mask": ("MASK",),
                "clip_vision": ("CLIP_VISION",),
            }
        }

    RETURN_TYPES = ("REFERENCE_DATA",)
    RETURN_NAMES = ("reference",)
    FUNCTION = "process"
    CATEGORY = "sampling/custom"
    INPUT_IS_LIST = True

    def _normalize_list(self, value, max_len):
        """将值标准化为长度为 max_len 的列表，单值则复制补齐。"""
        if value is None:
            return [None] * max_len
        if not isinstance(value, list):
            return [value] * max_len
        if len(value) >= max_len:
            return value[:max_len]
        # 单元素列表则复制补齐
        if len(value) == 1:
            return value * max_len
        # 多元素但不足，用最后一个值补齐
        return value + [value[-1]] * (max_len - len(value))

    def _list_len(self, value):
        """获取列表长度，非列表返回 1（表示单个值），None 返回 0。"""
        if value is None:
            return 0
        if isinstance(value, list):
            return len(value)
        return 1

    def process(self,
                preset,
                weight_style,
                weight_composition,
                expand_style,
                combine_embeds,
                start_at,
                end_at,
                embeds_scaling,
                cache_mode,
                reference=None,
                image_style=None,
                image_composition=None,
                image_negative=None,
                attn_mask=None,
                clip_vision=None):
        # 以 image_style 和 image_composition 两者最大长度为准
        max_len = max(self._list_len(image_style), self._list_len(image_composition))

        # 如果两者都为空（max_len == 0），直接返回 reference 或空 ReferenceData
        if max_len == 0:
            if reference is None:
                return (ReferenceData(),)
            return (reference.copy() if isinstance(reference, ReferenceData) else reference[0].copy(),)

        preset = self._normalize_list(preset, max_len)
        weight_style = self._normalize_list(weight_style, max_len)
        weight_composition = self._normalize_list(weight_composition, max_len)
        expand_style = self._normalize_list(expand_style, max_len)
        combine_embeds = self._normalize_list(combine_embeds, max_len)
        start_at = self._normalize_list(start_at, max_len)
        end_at = self._normalize_list(end_at, max_len)
        embeds_scaling = self._normalize_list(embeds_scaling, max_len)
        cache_mode = self._normalize_list(cache_mode, max_len)
        reference = self._normalize_list(reference, max_len)
        image_style = self._normalize_list(image_style, max_len)
        image_composition = self._normalize_list(image_composition, max_len)
        image_negative = self._normalize_list(image_negative, max_len)
        attn_mask = self._normalize_list(attn_mask, max_len)
        clip_vision = self._normalize_list(clip_vision, max_len)

        # 取第一个 reference 作为基础
        first_ref = reference[0]
        if first_ref is None:
            base_ref = ReferenceData()
        else:
            base_ref = first_ref.copy()

        # 逐个追加 ipadapter 配置
        for i in range(max_len):
            # 如果 image_style 和 image_composition 都为 None 则跳过
            if image_style[i] is None and image_composition[i] is None:
                continue

            ref = reference[i]
            if ref is not None and ref is not first_ref:
                # 合并其他 reference 的已有数据
                base_ref.reference_latents.extend(ref.reference_latents)
                base_ref.reference_controls.extend(ref.reference_controls)
                base_ref.reference_ipadapters.extend(ref.reference_ipadapters)
                if ref.positive_guidance is not None:
                    base_ref.positive_guidance = ref.positive_guidance
                if ref.negative_guidance is not None:
                    base_ref.negative_guidance = ref.negative_guidance

            base_ref.reference_ipadapters.append({
                "preset": preset[i],
                "weight_style": weight_style[i],
                "weight_composition": weight_composition[i],
                "expand_style": expand_style[i],
                "combine_embeds": combine_embeds[i],
                "start_at": start_at[i],
                "end_at": end_at[i],
                "embeds_scaling": embeds_scaling[i],
                "cache_mode": cache_mode[i],
                "image_style": image_style[i],
                "image_composition": image_composition[i],
                "image_negative": image_negative[i],
                "attn_mask": attn_mask[i],
                "clip_vision": clip_vision[i],
            })

        return (base_ref,)

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
                "context": ("CONTEXT_DATA",),
                "reference": ("REFERENCE_DATA",),   
                "config": ("CONFIG_DATA",),

            }
        }

    RETURN_TYPES = ("PIPELINE_DATA", "SAMPLER_CACHE", "MODEL", "CLIP", "VAE", 
                    "IMAGE", "LATENT", "MASK", comfy.samplers.KSampler.SAMPLERS, comfy.samplers.KSampler.SCHEDULERS, "INT", "FLOAT", "CONTEXT_DATA", "REFERENCE_DATA", "CONFIG_DATA",)
    
    RETURN_NAMES = ("pipeline", "cache", "model", "clip", "vae", 
                    "image", "latent", "mask", "sampler_name", "scheduler", "steps", "cfg", "context", "reference", "config",)
    
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
                context : ContextData = None,
                reference : ReferenceData = None,
                config : ConfigData = None,
                ):
        
        if pipeline is not None:
            next_pipeline = pipeline.copy()
        else:
            next_pipeline = PipelineData()

        # 更新字段
        if cache is not None:
            next_pipeline.cache = cache
        if next_pipeline.cache is None:
            next_pipeline.cache = SamplerCache()
            
        if model is not None:
            next_pipeline.model = model
        if clip is not None:
            next_pipeline.clip = clip
        if vae is not None:
            next_pipeline.vae = vae
        if image is not None:
            next_pipeline.image = image
        if latent is not None:
            next_pipeline.latent = latent
        if mask is not None:
            next_pipeline.mask = mask
        if sampler_name is not None:
            next_pipeline.sampler_name = sampler_name
        if scheduler is not None:
            next_pipeline.scheduler = scheduler
        if steps is not None:
            next_pipeline.steps = steps
        if cfg is not None:
            next_pipeline.cfg = cfg
            
            
        if context is not None:
            next_pipeline.context = context.copy()
        elif next_pipeline.context is None:
            next_pipeline.context = ContextData()
            
        if reference is not None:
            next_pipeline.reference = reference.copy()
        elif next_pipeline.reference is None:
            next_pipeline.reference = ReferenceData()
            
        if config is not None:
            next_pipeline.config = config.copy()
        elif next_pipeline.config is None:
            next_pipeline.config = ConfigData()
        
        return (
            next_pipeline,
            next_pipeline.cache,
            next_pipeline.model,
            next_pipeline.clip,
            next_pipeline.vae,
            next_pipeline.image,
            next_pipeline.latent,
            next_pipeline.mask,
            next_pipeline.sampler_name,
            next_pipeline.scheduler,
            next_pipeline.steps,
            next_pipeline.cfg,
            next_pipeline.context,
            next_pipeline.reference,
            next_pipeline.config,
        )
        
class ConfigNode:
    @classmethod
    def INPUT_TYPES(s):
        return{
            "optional": {
                "config": ("CONFIG_DATA",),
                "key": ("STRING", {"default": ""}),
                "value": ("*"),
            }
        }
        
    RETURN_TYPES = ("CONFIG_DATA",)
    RETURN_NAMES = ("config",)
    FUNCTION = "process"
    CATEGORY = "sampling/custom"
    
    def process(self,
                config : ConfigData = None,
                key="",
                value= None):
        if config is None:
            config = ConfigData()
        else:
            config = config.copy()
        
        config[key] = value
        return (config,)

class ConfigGetNode:
    @classmethod
    def INPUT_TYPES(s):
        return{
            "required": {
                "key": ("STRING", {"default": ""}),
            },
            "optional": {
                "config": ("CONFIG_DATA",),
            }
        }
        
    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("value",)
    FUNCTION = "process"
    CATEGORY = "sampling/custom"
    
    def process(self,
                key="",
                config : ConfigData = None):
        if config is None:
            return (None,)
        
        value = config.get(key, None)
        return (value,)

# ====================== SamplerNode ======================
class PipelineSamplerNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
                "bypass": ("BOOLEAN", {"default": False}),
                "need_reference_latent": ("BOOLEAN", {"default": False}),
                "context_regex": ("STRING", {"default": ".+"}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "control_after_generate": True}),
            },
            "optional": {
                "tagger": ("*",),
            }
        }

    RETURN_TYPES = ("PIPELINE_DATA", "STRING",)
    RETURN_NAMES = ("pipeline", "tag",)
    FUNCTION = "sample"
    CATEGORY = "sampling/custom"

    def sample(self, pipeline: PipelineData, bypass, need_reference_latent, context_regex, denoise, seed, tagger=None):
        if bypass:
            return (pipeline,)
        
        next_pipeline = pipeline.copy()

        if next_pipeline.cache is None:
            raise ValueError("PipelineData 中 cache 为空")

        if next_pipeline.model is None:
            raise ValueError("PipelineData 中 model 为空，无法采样")
  
        image = next_pipeline.image
        # 获取 latent（支持 mask inpaint）
        latent = next_pipeline.get_latent()
        
        context_positive, context_negative, context_loras = next_pipeline.context.get_context(context_regex)

        if tagger is not None:
            if image is None:
                image = VAEDecode().decode(vae=next_pipeline.vae, samples=latent)[0]
            tagger_positive = get_tag(tagger, image)
            if next_pipeline.config.get("print_tag") is True:
                print(f"[TAG]: {tagger_positive}")
            context_positive = context_positive + ',' + tagger_positive
        else:
            tagger_positive = ''
            
        tmp_positive, tmp_negative, tmp_loras = next_pipeline.context.get_prompt_context(tagger_positive, image)
        if tmp_positive:
            context_positive = tmp_positive
        if tmp_negative:
            context_negative = tmp_negative
        if tmp_loras:
            context_loras.extend(tmp_loras)
            
        # 获取打过 LoRA 的 model 和 clip（以及可选的 model_negative）
        model_negative = next_pipeline.config.get("model_negative")
        model_to_use, clip_to_use, model_negative_to_use = next_pipeline.cache.get_model_clip(
            model=next_pipeline.model,
            clip=next_pipeline.clip,
            loras=context_loras,
            reference=next_pipeline.reference,
            model_negative=model_negative
        )

        # 获取 condition（使用新的 get_conditioning）
        positive_condition = next_pipeline.get_conditioning(
            mode="positive",
            clip=clip_to_use,
            vae=next_pipeline.vae,
            prompt=context_positive,
            reference_latent=latent if need_reference_latent else None,
            reference_image=image,
            reference=next_pipeline.reference
        )
        negative_condition = next_pipeline.get_conditioning(
            mode="negative",
            clip=clip_to_use,
            vae=next_pipeline.vae,
            prompt=context_negative,
            reference_latent=latent if need_reference_latent else None,
            reference_image=image,
            reference=next_pipeline.reference
        )

        sampler_name = next_pipeline.sampler_name if next_pipeline.sampler_name is not None else "euler"
        scheduler    = next_pipeline.scheduler    if next_pipeline.scheduler    is not None else "normal"
        steps        = next_pipeline.steps        if next_pipeline.steps         is not None else 20
        cfg          = next_pipeline.cfg          if next_pipeline.cfg          is not None else 8.0

        # 执行采样
        sampled_latent = _ksampler(
            model=model_to_use,
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler=scheduler,
            positive=positive_condition,
            negative=negative_condition,
            latent=latent,
            denoise=denoise,
            sigmas=next_pipeline.config.get("sigmas"),
            model_negative=model_negative_to_use,
        )[0]

        next_pipeline.latent = sampled_latent
        
        if next_pipeline.config.get("preview_image") is True:
            preview_image = VAEDecode().decode(vae=next_pipeline.vae, samples=sampled_latent)[0]
            return io.NodeOutput(next_pipeline, context_positive, ui=ui.PreviewImage(preview_image))
        return (next_pipeline, context_positive,)


# ====================== SamplerAdvancedNode ======================
class PipelineSamplerAdvancedNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
                "bypass": ("BOOLEAN", {"default": False}),
                "need_reference_latent": ("BOOLEAN", {"default": False}),
                "context_regex": ("STRING", {"default": ".+"}),
                "add_noise": (["enable", "disable"], {"default": "enable"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "start_step_rate": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0}),
                "end_step_rate": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0}),
                "return_with_leftover_noise": (["disable", "enable"], {"default": "disable"}),
            },
            "optional": {
                "tagger": ("*",),
            }   
        }

    RETURN_TYPES = ("PIPELINE_DATA", "STRING",)
    RETURN_NAMES = ("pipeline", "tag",)
    FUNCTION = "sample_advanced"
    CATEGORY = "sampling/custom"

    def sample_advanced(self, pipeline: PipelineData, bypass, need_reference_latent, context_regex, add_noise,
                        seed, start_step_rate, end_step_rate, return_with_leftover_noise, tagger=None):
        if bypass:
            return (pipeline,)
        
        if end_step_rate <= 0 or end_step_rate < start_step_rate:
            return (pipeline,)
    
        next_pipeline = pipeline.copy()

        if next_pipeline.cache is None:
            raise ValueError("PipelineData 中 cache 为空")
        
        if next_pipeline.model is None:
            raise ValueError("PipelineData 中 model 为空，无法采样")
        
        context_positive, context_negative, context_loras = next_pipeline.context.get_context(context_regex)

        image = next_pipeline.image
        # 获取 latent（支持 mask inpaint）
        latent = next_pipeline.get_latent()
        
        if tagger is not None:
            if image is None:
                image = VAEDecode().decode(vae=next_pipeline.vae, samples=latent)[0]
            tagger_positive = get_tag(tagger, image)
            if next_pipeline.config.get("print_tag") is True:
                print(f"[TAG]: {tagger_positive}")
            context_positive = context_positive + ',' + tagger_positive
        else:
            tagger_positive = ''
            
        tmp_positive, tmp_negative, tmp_loras = next_pipeline.context.get_prompt_context(tagger_positive, image)
        if tmp_positive:
            context_positive = tmp_positive
        if tmp_negative:
            context_negative = tmp_negative
        if tmp_loras:
            context_loras.extend(tmp_loras)
            
        sampler_name = next_pipeline.sampler_name if next_pipeline.sampler_name is not None else "euler"
        scheduler    = next_pipeline.scheduler    if next_pipeline.scheduler    is not None else "normal"
        steps        = next_pipeline.steps        if next_pipeline.steps        is not None else 20
        cfg          = next_pipeline.cfg          if next_pipeline.cfg          is not None else 8.0
        
        start_at_step = int(start_step_rate * steps)
        end_at_step = int(end_step_rate * steps)
        if end_at_step < start_at_step:
            end_at_step = start_at_step
            
        # 获取打过 LoRA 的 model 和 clip（以及可选的 model_negative）
        model_negative = next_pipeline.config.get("model_negative")
        model_to_use, clip_to_use, model_negative_to_use = next_pipeline.cache.get_model_clip(
            model=next_pipeline.model,
            clip=next_pipeline.clip,
            loras=context_loras,
            reference=next_pipeline.reference,
            model_negative=model_negative
        )

        # 获取 condition（使用新的 get_conditioning）
        positive_condition = next_pipeline.get_conditioning(
            mode="positive",
            clip=clip_to_use,
            vae=next_pipeline.vae,
            prompt=context_positive,
            reference_latent=latent if need_reference_latent else None,
            reference_image=image,
            reference=next_pipeline.reference
        )
        negative_condition = next_pipeline.get_conditioning(
            mode="negative",
            clip=clip_to_use,
            vae=next_pipeline.vae,
            prompt=context_negative,
            reference_latent=latent if need_reference_latent else None,
            reference_image=image,
            reference=next_pipeline.reference
        )

        sampled_latent = _ksampler(
            model=model_to_use,
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler=scheduler,
            positive=positive_condition,
            negative=negative_condition,
            latent=latent,
            disable_noise=(add_noise == "disable"),
            start_step=start_at_step,
            last_step=end_at_step,
            force_full_denoise=(return_with_leftover_noise == "disable"),
            sigmas=next_pipeline.config.get("sigmas"),
            model_negative=model_negative_to_use,
        )[0]

        next_pipeline.latent = sampled_latent
        
        if next_pipeline.config.get("preview_image") is True:
            preview_image = VAEDecode().decode(vae=next_pipeline.vae, samples=sampled_latent)[0]
            return io.NodeOutput(next_pipeline, context_positive, ui=ui.PreviewImage(preview_image))
        return (next_pipeline, context_positive,)

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
                "bypass": ("BOOLEAN", {"default": False}),
                "need_reference_latent": ("BOOLEAN", {"default": False}),
                "context_regex": ("STRING", {"default": ".+"}),
                # Sampling 参数
                "add_noise": (["enable", "disable"], {"default": "enable"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "start_step_rate": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 1.0}),
                "end_step_rate": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0}),
                "return_with_leftover_noise": (["disable", "enable"], {"default": "disable"}),

                # Detailer 参数
                "detector_threshold": ("FLOAT", {"default": 0.2, "min": 0.0, "max": 1.0, "step": 0.01}),
                "detector_prompt": ("STRING", {"default": "", "multiline": False}),
                "detector_dilation": ("INT", {"default": 4}),
                "detector_crop_factor": ("FLOAT", {"default": 1.5}),
                "detector_drop_size": ("INT", {"default": 0}),
                "detector_grow": ("INT", {"default": 32}),
                "detector_blur": ("INT", {"default": 32}),
               
                # Crop & Resize 参数
                "pixels": ("INT", {"default": 1024*1024, "min": 1, "max": 1024*1024*1024}),
                "align": ("INT", {"default": 8, "min": 1, "max": 1024*1024*1024}),
                "crop_reserve": ("INT", {"default": 32}),

                # Recover 参数
                "recover_method": (["bounds_only", "mask_blend", "mask_only"], {"default": "mask_blend"}),
                "inpaint_mode": ("BOOLEAN", {"default": False}),
                "foreach_mask": ("BOOLEAN", {"default": False}),
                "tagger_mask": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "detector": ("*",),        # 通配符
                "tagger": ("*",),         # 通配符
                "image": ("IMAGE",),      
                "mask": ("MASK",),        
            }
        }

    RETURN_TYPES = ("PIPELINE_DATA", "IMAGE", "MASK", "STRING",)
    RETURN_NAMES = ("pipeline", "image", "mask", "generated_prompt",)
    FUNCTION = "detailer"
    CATEGORY = "sampling/custom"
    
    OUTPUT_IS_LIST = (False, True, True, True,)
    INPUT_IS_LIST = True

    def detailer(self, pipeline, bypass, need_reference_latent, context_regex,
                 add_noise, seed, start_step_rate, end_step_rate, return_with_leftover_noise,
                 detector_threshold, detector_prompt,
                 detector_dilation, detector_crop_factor, detector_drop_size, detector_grow, detector_blur,
                 pixels, align, crop_reserve,
                 recover_method, inpaint_mode, foreach_mask, tagger_mask,
                 detector=None, tagger=None, image=None, mask=None):
        
        # ==================== 统一处理 INPUT_IS_LIST ====================
        pipeline = pipeline[0]
        bypass = bypass[0]
        context_regex = context_regex[0]
        add_noise = add_noise[0]
        seed = seed[0]
        start_step_rate = start_step_rate[0]
        end_step_rate = end_step_rate[0]
        return_with_leftover_noise = return_with_leftover_noise[0]
        
        detector_threshold = detector_threshold[0]
        detector_prompt = detector_prompt[0]
        detector_dilation = detector_dilation[0]
        detector_crop_factor = detector_crop_factor[0]
        detector_drop_size = detector_drop_size[0]
        detector_grow = detector_grow[0]
        detector_blur = detector_blur[0]
        
        pixels = pixels[0]
        align = align[0]
        crop_reserve = crop_reserve[0]
        recover_method = recover_method[0]
        inpaint_mode = inpaint_mode[0]
        foreach_mask = foreach_mask[0]
        tagger_mask = tagger_mask[0]    
        
        detector = None if detector is None else detector[0]
        tagger = None if tagger is None else tagger[0]

        # ==================== Bypass 与早期返回 ====================
        if bypass:
            return (pipeline, None, None, "")

        if end_step_rate <= 0 or end_step_rate < start_step_rate:
            return (pipeline, None, None, "")

        # ==================== 复制 pipeline 并进行检查 ====================
        next_pipeline = pipeline.copy()   # 必须先复制

        if next_pipeline.cache is None:
            raise ValueError("PipelineData 中 cache 为空")
        if next_pipeline.model is None:
            raise ValueError("PipelineData 中 model 为空，无法 Detailer")

        # ==================== 公共项 ====================
        
        context_positive, context_negative, context_loras = next_pipeline.context.get_context(context_regex)

        # ==================== 准备原始图像和 mask ====================
        if image is not None:
            original_images = image if isinstance(image, list) else [image]
        else:
            original_images = [next_pipeline.get_image()] if hasattr(next_pipeline, 'get_image') else []

        image_size = len(original_images)
        
        detailer_mask_start = []
        detailer_mask_count = []

        if mask is not None:
            if foreach_mask:
                detailer_masks = []
                index = 0
                for img in original_images:
                    detailer_masks.extend(mask)
                    count = len(mask)
                    detailer_mask_start.append(index)
                    detailer_mask_count.append(count)
                    index += count     
            else:  
                if len(mask) != len(original_images):
                    raise ValueError("mask 数量必须与 image 数量相同")
                detailer_masks = mask
                for index in range(image_size):
                    detailer_mask_start.append(index)
                    detailer_mask_count.append(1)
        elif detector is not None:
            detailer_masks = []
            index = 0
            
            for img in original_images:
                mask_list = detect_mask(
                    detector=detector,
                    image=img,
                    threshold=detector_threshold,
                    dilation=detector_dilation,
                    crop_factor=detector_crop_factor,
                    drop_size=detector_drop_size,
                    prompt=detector_prompt
                )
                if foreach_mask:
                    if mask_list is None:
                        detailer_mask_start.append(index)
                        detailer_mask_count.append(0)
                    else:
                        detailer_masks.extend(mask_list)
                        count = len(mask_list)
                        detailer_mask_start.append(index)
                        detailer_mask_count.append(count)
                        index += count
                else:
                    if mask_list is None:
                        detailer_mask_start.append(index)
                        detailer_mask_count.append(0)
                    else:
                        detailer_masks.append(combine_masks(mask_list))
                        count = 1
                        detailer_mask_start.append(index)
                        detailer_mask_count.append(count)
                        index += count
        else:
            raise ValueError("detector 或 mask 必须提供")

        mask_size = len(detailer_masks)

        # 扩展 mask
        for mask_index in range(mask_size):
            detailer_masks[mask_index] = expand_mask(detailer_masks[mask_index], grow=detector_grow, blur=detector_blur)
        
        # ==================== Crop ====================
        cropped_images = []
        cropped_masks = []
        crop_infos = []
        processing_mapping = []
        
        for image_index in range(image_size):
            mask_start = detailer_mask_start[image_index]
            mask_count = detailer_mask_count[image_index]
            for mask_index in range(mask_start, mask_start + mask_count):
                cropped_image, cropped_mask, crop_info = crop_mask(
                    image=original_images[image_index],
                    mask=detailer_masks[mask_index],
                    reserve=crop_reserve
                )
                processing_mapping.append(image_index)
                cropped_images.append(cropped_image)
                cropped_masks.append(cropped_mask)
                crop_infos.append(crop_info)
                
        processing_size = len(cropped_images)
        # ==================== Resize + Encode + Conditioning ====================
        resized_images = []
        resized_masks = []
        resize_infos = []
        tmp_latents = []
        
        # ==================== Sampling 参数 ====================
        sampler_name = next_pipeline.sampler_name or "euler"
        scheduler = next_pipeline.scheduler or "normal"
        steps = next_pipeline.steps or 20
        cfg = next_pipeline.cfg or 8.0

        start_at_step = int(start_step_rate * steps)
        end_at_step = int(end_step_rate * steps)
        
        for processing_index in range(processing_size):
            resized_image, resized_mask, resize_info = limit_pixels(
                image=cropped_images[processing_index],
                pixels=pixels,
                mask=cropped_masks[processing_index],
                align=align,
            )
            
            resized_images.append(resized_image)
            resized_masks.append(resized_mask)
            resize_infos.append(resize_info)
            
            # 提前编码 latent，避免在 conditioning 计算时 tmp_latent 未定义
            if inpaint_mode:
                 _, tmp_latent = set_inpaint_mask(
                    resized_image=resized_images[processing_index],
                    resized_mask=resized_masks[processing_index],
                    vae=next_pipeline.vae,
                    grow_mask_by=0
                )
            else:
                tmp_latent = VAEEncode().encode(
                    vae=next_pipeline.vae, 
                    pixels=resized_images[processing_index]
                )[0]
            tmp_latents.append(tmp_latent)
    
    
        tagger_positives = []
        # ==================== KSamplerAdvanced ====================
        for processing_index in range(processing_size):    
            # Tagger
            if tagger is not None:
                if tagger_mask:
                    tagger_image = draw_mask_on_image(resized_images[processing_index], invert_mask(resized_masks[processing_index]), (255, 255, 255, 255))
                else:
                    tagger_image = resized_images[processing_index]
                tagger_positive = get_tag(tagger, tagger_image)
                if next_pipeline.config.get("print_tag") is True:
                    print(f"[TAG]: {tagger_positive}")
            else:
                tagger_image = resized_images[processing_index]
                tagger_positive = ''
            tagger_positives.append(tagger_positive)
            
            # 使用局部 prompt，避免累加
            current_positive = context_positive + (',' + tagger_positive if tagger_positive else '')
            current_negative = context_negative
            current_loras = context_loras.copy()
            
            #spatial_rate = crop_infos[processing_index].get("spatial_rate", 1.0)
            
            tmp_positive, tmp_negative, tmp_loras = next_pipeline.context.get_prompt_context(tagger_positive, tagger_image)
            if tmp_positive:
                current_positive += ',' + tmp_positive
            if tmp_negative:
                current_negative += ',' + tmp_negative
            if tmp_loras:
                current_loras.extend(tmp_loras)
            
            model_negative = next_pipeline.config.get("model_negative")
            model_to_use, clip_to_use, model_negative_to_use = next_pipeline.cache.get_model_clip(
                model=next_pipeline.model,
                clip=next_pipeline.clip,
                loras=current_loras,
                reference=next_pipeline.reference,
                model_negative=model_negative
            )

            tmp_latent = tmp_latents[processing_index]
            
            positive_condition = next_pipeline.get_conditioning(
                mode="positive",
                clip=clip_to_use, 
                vae=next_pipeline.vae,
                prompt=current_positive, 
                reference_latent=tmp_latent if need_reference_latent else None,
                reference_image=resized_images[processing_index],
                reference=next_pipeline.reference
            )
            
            negative_condition = next_pipeline.get_conditioning(
                mode="negative",
                clip=clip_to_use, 
                vae=next_pipeline.vae,
                prompt=current_negative, 
                reference_latent=tmp_latent if need_reference_latent else None,
                reference_image=resized_images[processing_index],
                reference=next_pipeline.reference
            )
            
            tmp_latents[processing_index] = _ksampler(
                model=model_to_use,
                seed=seed,
                steps=steps,
                cfg=cfg,
                sampler_name=sampler_name,
                scheduler=scheduler,
                positive=positive_condition,
                negative=negative_condition,
                latent=tmp_latent,
                disable_noise=(add_noise == "disable"),
                start_step=start_at_step,
                last_step=end_at_step,
                force_full_denoise=(return_with_leftover_noise == "disable"),
                sigmas=next_pipeline.config.get("sigmas"),
                model_negative=model_negative_to_use,
            )[0]
        
        # ==================== Decode ====================
        detailed_images = []
        for processing_index in range(processing_size):
            detailed_images.append(
                VAEDecode().decode(vae=next_pipeline.vae, samples=tmp_latents[processing_index])[0]
            )

        # ==================== Recover Size ====================
        recovered_images = []
        recovered_masks = []
        for processing_index in range(processing_size):
            recovered_image, recovered_mask = recover_size(
                image=detailed_images[processing_index],
                resize_info=resize_infos[processing_index],
                mask=resized_masks[processing_index]
            )
            recovered_images.append(recovered_image)
            recovered_masks.append(recovered_mask)

        # ==================== Recover Crop ====================
        final_images = []
        final_masks = []
        
        for image_index in range(image_size):
            if detailer_mask_count[image_index] == 0:
                final_images.append(original_images[image_index])
                final_masks.append(None)
            elif detailer_mask_count[image_index] == 1:
                final_images.append(None)
                final_masks.append(None)
            else:
                final_images.append(original_images[image_index].clone())
                final_masks.append(create_empty_mask(original_images[image_index]))
        
        for processing_index in range(processing_size):
            image_index = processing_mapping[processing_index]
            if detailer_mask_count[image_index] == 0:
                raise ValueError("image_index 为 %d 的图像没有 mask" % image_index)
            elif detailer_mask_count[image_index] == 1:
                final_images[image_index], final_masks[image_index] = recover_crop(
                    background=original_images[image_index],
                    image=recovered_images[processing_index],
                    crop_info=crop_infos[processing_index],
                    recover_method=recover_method,
                    mask=recovered_masks[processing_index]
                )
            else:
                tmp_image, tmp_mask = recover_crop(
                    background=final_images[image_index],
                    image=recovered_images[processing_index],
                    crop_info=crop_infos[processing_index],
                    recover_method=recover_method,
                    mask=recovered_masks[processing_index]
                )
                final_images[image_index] = tmp_image
                final_masks[image_index] = combine_masks([final_masks[image_index], tmp_mask])

        # ==================== 更新 pipeline 并返回 ====================
        next_pipeline.image = final_images[0]
        next_pipeline.latent = None

        del cropped_images, cropped_masks, crop_infos
        del resized_images, resized_masks, resize_infos
        del tmp_latents
        del detailed_images, recovered_images, recovered_masks

        gc.collect()
        mm.soft_empty_cache()

        has_preview = False
        if next_pipeline.config.get("preview_image") is True:
            preview_image = final_images[0]
            has_preview = True
        if next_pipeline.config.get("preview_mask") is True:
            preview_mask = draw_mask(final_masks[0])
            has_preview = True
        
        if has_preview:
            if preview_image is not None and preview_mask is not None:
                final_preview_image = batch_images(preview_image, preview_mask)
            elif preview_image is not None:
                final_preview_image = preview_image
            elif preview_mask is not None:
                final_preview_image = preview_mask
            return io.NodeOutput(next_pipeline, final_images, final_masks, tagger_positives, ui=ui.PreviewImage(final_preview_image))
        
        
        return (next_pipeline, final_images, final_masks, tagger_positives)


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
        next_pipeline = pipeline.copy()

        # latent 是列表 → 逐个解码后 cat 成 batch
        if isinstance(next_pipeline.latent, list):
            decoded_list = []
            for lat in next_pipeline.latent:
                dec = VAEDecode().decode(vae=next_pipeline.vae, samples=lat)[0]
                if dec.dim() == 3:
                    dec = dec.unsqueeze(0)
                decoded_list.append(dec)
            if not decoded_list:
                return (next_pipeline, next_pipeline.get_image())
            h, w = decoded_list[0].shape[1], decoded_list[0].shape[2]
            resized = []
            for img in decoded_list:
                if img.shape[1] != h or img.shape[2] != w:
                    img = torch.nn.functional.interpolate(
                        img.permute(0, 3, 1, 2), size=(h, w), mode='bilinear'
                    ).permute(0, 2, 3, 1)
                resized.append(img)
            batch = torch.cat(resized, dim=0)
            return (next_pipeline, batch)

        # image 是列表 → cat 成 batch
        if isinstance(next_pipeline.image, list):
            imgs = []
            for img in next_pipeline.image:
                if img.dim() == 3:
                    img = img.unsqueeze(0)
                imgs.append(img)
            if not imgs:
                return (next_pipeline, next_pipeline.get_image())
            h, w = imgs[0].shape[1], imgs[0].shape[2]
            resized = []
            for img in imgs:
                if img.shape[1] != h or img.shape[2] != w:
                    img = torch.nn.functional.interpolate(
                        img.permute(0, 3, 1, 2), size=(h, w), mode='bilinear'
                    ).permute(0, 2, 3, 1)
                resized.append(img)
            batch = torch.cat(resized, dim=0)
            return (next_pipeline, batch)

        return (next_pipeline, next_pipeline.get_image())
    

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
                    "min": 1,
                    "max": 1024 * 1024 * 1024,
                    "tooltip": "Maximum allowed pixel count"
                }),
                "align": ("INT", {
                    "default": 1,
                    "min": 1,
                    "max": 1024 * 1024 * 1024,
                    "tooltip": "Align the resized image to the nearest pixel grid"
                }),
            },
        }

    RETURN_TYPES = ("PIPELINE_DATA",)
    RETURN_NAMES = ("pipeline",)
    FUNCTION = "limit_pixels"
    CATEGORY = "sampling/custom"

    def limit_pixels(self, pipeline, pixels, align):
        """Limit image pixel count in pipeline by resizing if needed."""
        try:
            next_pipeline = pipeline.copy()
            
            # 获取 image（如果不存在则从 latent 解码）
            next_pipeline.get_image()

            # 调用 image_utils 中的 limit_pixels 函数
            resized_image, resized_mask, resize_info = limit_pixels(next_pipeline.image, pixels, next_pipeline.mask, align)

            # 更新 pipeline 中的图像和掩码
            next_pipeline.image = resized_image
            next_pipeline.mask = resized_mask
            # 将 resize_info 推入栈中
            next_pipeline.resize_info_stack.append(resize_info)

            return (next_pipeline,)

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
            next_pipeline = pipeline.copy()
            
            # 获取 image（如果不存在则从 latent 解码）
            next_pipeline.get_image()

            # 从栈中弹出 resize_info
            if not next_pipeline.resize_info_stack:
                raise ValueError("No resize info in stack")
            resize_info = next_pipeline.resize_info_stack.pop()

            # 调用 image_utils 中的 recover_size 函数
            recovered_image, recovered_mask = recover_size(next_pipeline.image, resize_info, next_pipeline.mask)

            # 更新 pipeline 中的图像和掩码
            next_pipeline.image = recovered_image
            next_pipeline.mask = recovered_mask

            return (next_pipeline,)

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
        
        next_pipeline = pipeline.copy()
        latent = next_pipeline.get_latent()
        samples = latent["samples"].clone()  # 避免修改原 tensor

        # 生成噪声并添加
        batch_inds = latent.get("batch_index", None)
        noise = comfy.sample.prepare_noise(samples, seed, batch_inds)

        if noise_strength != 1.0:
            noise = noise * noise_strength

        samples = samples + noise

        # 更新 pipeline 中的 latent
        next_pipeline.latent = {"samples": samples, **{k: v for k, v in latent.items() if k != "samples"}}

        return (next_pipeline,)
    
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
        next_pipeline = pipeline.copy()
        latent = next_pipeline.get_latent()
        
        if "noise_mask" in latent:
            del latent["noise_mask"] 
        
        if not enable:
            return (next_pipeline,)
        
        inpaint_mask = mask if mask is not None else next_pipeline.mask
        latent = SetLatentNoiseMask().set_mask(
            samples=latent,
            mask=inpaint_mask,
            grow_mask_by=grow_mask_by
        )[0]
            
        return (next_pipeline,)
    

# ====================== PipelineEnableEditNode ======================
class PipelineEnableEditNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
                "enable": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("PIPELINE_DATA",)
    RETURN_NAMES = ("pipeline",)
    FUNCTION = "enable_edit"
    CATEGORY = "sampling/custom"

    def enable_edit(self, pipeline, enable):
        next_pipeline = pipeline.copy()
        next_pipeline.config["enable_edit"] = enable

        if enable and next_pipeline.model is not None:
            architecture = next_pipeline.config.get("architecture") if next_pipeline.config else None
            if architecture and re.search(r"Krea2", architecture, re.IGNORECASE):
                ref_boost = next_pipeline.config.get("ref_boost", 1.0)
                ref_boost_a = next_pipeline.config.get("ref_boost_a", 1.0)
                ref_boost_mask = next_pipeline.config.get("ref_boost_mask", None)
                fit_mode = next_pipeline.config.get("fit_mode", "fit")
                vae = next_pipeline.vae
                pixel_state = {"fit_mode": fit_mode, "vae": vae, "source_images": None, "source_latents": None, "px_cache": {}}
                next_pipeline.model = arch_krea2.apply_model_patch(
                    next_pipeline.model, ref_boost, ref_boost_a, ref_boost_mask, fit_mode, vae, pixel_state)
                print(f"[EnableEdit] Krea2 edit source patch applied (ref_boost={ref_boost}, ref_boost_a={ref_boost_a}, fit_mode={fit_mode})")
                model_neg = next_pipeline.config.get("model_negative")
                if model_neg is not None:
                    next_pipeline.config["model_negative"] = arch_krea2.apply_model_patch(
                        model_neg, ref_boost, ref_boost_a, ref_boost_mask, fit_mode, vae, pixel_state)
                    print("[EnableEdit] Krea2 edit source patch applied to model_negative")
            elif architecture and re.search(r"Flux2Klein", architecture, re.IGNORECASE):
                next_pipeline.model = arch_flux2klein.apply_model_patch(next_pipeline.model)
                print("[EnableEdit] Flux2Klein: no model patch needed")

        return (next_pipeline,)


# ====================== PipelineEnableQwenEditNode ======================
class PipelineEnableQwenEditNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
                "enable": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("PIPELINE_DATA",)
    RETURN_NAMES = ("pipeline",)
    FUNCTION = "enable_qwen_edit"
    CATEGORY = "sampling/custom"

    def enable_qwen_edit(self, pipeline, enable):
        next_pipeline = pipeline.copy()
        next_pipeline.config["enable_qwen_edit"] = enable

        if enable:
            print("[EnableQwenEdit] QwenImageEditPlus conditioning enabled")

        return (next_pipeline,)


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
                "detector_threshold": ("FLOAT", {"default": 0.2, "min": 0.0, "max": 1.0, "step": 0.01}),
                "detector_prompt": ("STRING", {"default": "", "multiline": False}),
                "detector_dilation": ("INT", {"default": 4, "min": 0, "max": 64}),
                "detector_crop_factor": ("FLOAT", {"default": 1.5, "min": 1.0, "max": 4.0, "step": 0.1}),
                "detector_drop_size": ("INT", {"default": 0, "min": 0, "max": 512}),
                
                "detector_grow": ("INT", {"default": 0, "min": 0, "max": 1024 * 1024 * 1024}),
                "detector_blur": ("INT", {"default": 0, "min": 0, "max": 1024 * 1024 * 1024}),
            }
        }

    RETURN_TYPES = ("PIPELINE_DATA", "MASK")
    RETURN_NAMES = ("pipeline", "mask")
    FUNCTION = "detect"
    CATEGORY = "sampling/custom"

    def detect(self, pipeline: PipelineData,
               detector,
               detector_threshold, detector_prompt,
               detector_dilation=4, detector_crop_factor=1.5, detector_drop_size=0,
               detector_grow=0, detector_blur=0):

        if detector is None:
            raise ValueError("必须传入 detector 对象（detector 为必填输入）")

        next_pipeline = pipeline.copy()

        # ====================== 1. 获取原始图像 ======================
        original_image = next_pipeline.get_image()          # (B, H, W, C) tensor

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
        
        detailer_mask = expand_mask(detailer_mask, grow=detector_grow, blur=detector_blur)

        # 原样返回 pipeline（不做任何修改）
        return (next_pipeline, detailer_mask,)
    
class PipelineGetPromptNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
                "context_regex": ("STRING", {"default": ".+"}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("positive", "negative", "loras")
    FUNCTION = "get_prompt"
    CATEGORY = "sampling/custom"

    def get_prompt(self, pipeline, context_regex):
        positive, negative, loras = pipeline.context.get_context(context_regex)
        # 将 loras 列表转换为字符串
        loras_str = ",".join(loras) if loras else ""
        return (positive, negative, loras_str)

class PipelineSamplerDataNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
                "context_regex": ("STRING", {"default": ".+"}),
            }
        }

    RETURN_TYPES = ("PIPELINE_DATA", "MODEL", "CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("pipeline", "model", "positive", "negative", "latent")
    FUNCTION = "get_sampler_data"
    CATEGORY = "sampling/custom"

    def get_sampler_data(self, pipeline, context_regex):
        next_pipeline = pipeline.copy()
        
        # 获取 positive 和 negative
        positive_str, negative_str, loras = next_pipeline.context.get_context(context_regex)
        
        # 获取 model 和 clip（应用 loras）
        model_negative = next_pipeline.config.get("model_negative")
        model_to_use, clip_to_use, model_negative_to_use = next_pipeline.cache.get_model_clip(
            model=next_pipeline.model,
            clip=next_pipeline.clip,
            loras=loras,
            reference=next_pipeline.reference,
            model_negative=model_negative
        )
        
        # 获取 latent
        latent = next_pipeline.get_latent()
        
        # 将字符串转换为 CONDITIONING
        positive_condition = next_pipeline.get_conditioning(
            mode="positive",
            clip=clip_to_use,
            vae=next_pipeline.vae,
            prompt=positive_str,
            reference=next_pipeline.reference
        )
        
        negative_condition = next_pipeline.get_conditioning(
            mode="negative",
            clip=clip_to_use,
            vae=next_pipeline.vae,
            prompt=negative_str,
            reference=next_pipeline.reference
        )
        
        return (next_pipeline, model_to_use, positive_condition, negative_condition, latent)

class ApplyLorasNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("MODEL",),
                "loras": ("STRING", {"forceInput": True, "default": ""}),
            }
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "apply_loras"
    CATEGORY = "sampling/custom"
    INPUT_IS_LIST = True

    def apply_loras(self, model, loras):
        # INPUT_IS_LIST=True 时所有输入都是列表
        if not model:
            raise ValueError("model 输入不能为空")
        model_patcher = model[0]

        # 收集所有 lora 配置（支持逗号分隔和列表混合）
        all_lora_items = []
        for lora_str in loras:
            if not isinstance(lora_str, str) or not lora_str.strip():
                continue
            for item in lora_str.split(","):
                item = item.strip()
                if item:
                    all_lora_items.append(item)

        if not all_lora_items:
            return (model_patcher,)

        print(f"Loading LoRAs: {all_lora_items}")

        for item in all_lora_items:
            if not isinstance(item, str) or not item.strip():
                continue

            lora_str = item.strip()
            if lora_str.startswith("<") and lora_str.endswith(">"):
                lora_str = lora_str[1:-1].strip()

            try:
                if lora_str.startswith("lora_path:"):
                    # Direct path mode: path may contain ':' (Windows drive letter)
                    # Format: lora_path:path:strength  — split from the rightmost ':'
                    body = lora_str[len("lora_path:"):]
                    last_colon = body.rfind(":")
                    if last_colon == -1:
                        print(f"Warning: 格式错误，需要 lora_path:path:strength: {lora_str}")
                        continue
                    lora_path = body[:last_colon].strip()
                    strength = float(body[last_colon+1:].strip())
                    lora_name = lora_path.replace("/", "\\").split("\\")[-1]
                elif lora_str.startswith("lora:"):
                    # Normal mode: lora:name:strength
                    parts = lora_str.split(":", 2)
                    if len(parts) != 3:
                        print(f"Warning: 格式错误，需要 lora:name:strength: {lora_str}")
                        continue
                    lora_name = parts[1].strip()
                    strength = float(parts[2].strip())
                    lora_path = _lora_path_cache.get(lora_name)
                    if lora_path is None:
                        for key in _lora_path_cache:
                            if key == lora_name or key.endswith("/" + lora_name) or key.endswith("\\" + lora_name):
                                lora_path = _lora_path_cache[key]
                                break
                    if lora_path is None:
                        print(f"Warning: 未找到 LoRA 文件: {lora_name}")
                        continue
                else:
                    print(f"Warning: 必须以 lora: 或 lora_path: 开头: {lora_str}")
                    continue

                lora_dict = comfy.utils.load_torch_file(lora_path, safe_load=True)
                model_patcher, _ = comfy.sd.load_lora_for_models(
                    model_patcher,
                    None,
                    lora_dict,
                    strength,
                    strength
                )

                print(f"✓ Applied LoRA: {lora_name} (strength={strength})")

            except Exception as e:
                print(f"Failed to load LoRA '{item}': {type(e).__name__} - {e}")

        return (model_patcher,)

class PipelineTagNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
                "tagger": ("*",),                    # 改为 required
            }
        }
        
    RETURN_TYPES = ("PIPELINE_DATA", "STRING")
    RETURN_NAMES = ("pipeline", "tag")
    FUNCTION = "tag"
    CATEGORY = "sampling/custom"
    
    def tag(self, pipeline: PipelineData, tagger):
        if tagger is None:
            raise ValueError("必须传入 tagger 对象（tagger 为必填输入）")
        
        next_pipeline = pipeline.copy()
        image = next_pipeline.get_image()
        tag = get_tag(tagger, image)
        if next_pipeline.config.get("print_tag") is True:
            print(f"[TAG]: {tag}")
        return (next_pipeline, tag,)
    
class PipelineVideoSamplerAdvancedNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
                "video": ("VIDEO",),
                "sampler_fps": ("FLOAT", {"default": 0, "min": 0, "max": 999999}),
                "folder_name": ("STRING", {"default": "video_detailer_frames"}),

                "images_per_run": ("INT", {"default": 4, "min": 1, "max": 16, "step": 1}),

                "bypass": ("BOOLEAN", {"default": False}),
                "need_reference_latent": ("BOOLEAN", {"default": False}),
                "context_regex": ("STRING", {"default": ".+"}),
                # Sampling 参数
                "add_noise": (["enable", "disable"], {"default": "enable"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "start_step_rate": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 1.0}),
                "end_step_rate": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0}),
                "return_with_leftover_noise": (["disable", "enable"], {"default": "disable"}),

                # Detailer 参数
                "detector_threshold": ("FLOAT", {"default": 0.2, "min": 0.0, "max": 1.0, "step": 0.01}),
                "detector_prompt": ("STRING", {"default": "", "multiline": False}),
                "detector_dilation": ("INT", {"default": 4}),
                "detector_crop_factor": ("FLOAT", {"default": 1.5}),
                "detector_drop_size": ("INT", {"default": 0}),
                "detector_grow": ("INT", {"default": 32}),
                "detector_blur": ("INT", {"default": 32}),

                # Crop & Resize 参数
                "pixels": ("INT", {"default": 1024*1024, "min": 1, "max": 1024*1024*1024}),
                "align": ("INT", {"default": 8, "min": 1, "max": 1024*1024*1024}),
                "crop_reserve": ("INT", {"default": 32}),

                # Recover 参数
                "recover_method": (["bounds_only", "mask_blend", "mask_only"], {"default": "mask_blend"}),
                "inpaint_mode": ("BOOLEAN", {"default": False}),
                "foreach_mask": ("BOOLEAN", {"default": False}),
                "tagger_mask": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "detector": ("*",),
                "tagger": ("*",),
            }
        }

    RETURN_TYPES = ("PIPELINE_DATA", "FLOAT", "INT")
    RETURN_NAMES = ("pipeline", "video_fps", "processed_frames")
    FUNCTION = "sample_advanced_video"
    CATEGORY = "sampling/custom"

    def sample_advanced_video(self, pipeline, video, sampler_fps, folder_name, images_per_run,
                              bypass, need_reference_latent, context_regex,
                              add_noise, seed, start_step_rate, end_step_rate, return_with_leftover_noise,
                              detector_threshold, detector_prompt, detector_dilation,
                              detector_crop_factor, detector_drop_size, detector_grow, detector_blur,
                              pixels, align, crop_reserve, recover_method,
                              inpaint_mode=False, foreach_mask=False, tagger_mask=False,
                              detector=None, tagger=None):

        if isinstance(bypass, (list, tuple)) and len(bypass) > 0:
            bypass = bypass[0]
        if bypass:
            return (pipeline, 0.0, 0)

        # ====================== 导入 ======================
        import decord
        from decord import VideoReader, cpu
        import gc
        import torch
        import os
        import json
        import time
        from PIL import Image

        decord.bridge.set_bridge('torch')

        next_pipeline = pipeline.copy()
        if getattr(next_pipeline, 'cache', None) is None or getattr(next_pipeline, 'model', None) is None:
            raise ValueError("PipelineData 中 cache 或 model 为空")

        context_positive, context_negative, context_loras = next_pipeline.context.get_context(context_regex)

        # ====================== 视频读取 ======================
        video_path = video.get_stream_source() if hasattr(video, 'get_stream_source') else str(video)
        
        vr = VideoReader(video_path, ctx=cpu(0))
        video_frame_count = len(vr)
        original_fps = float(vr.get_avg_fps())
        del vr

        if sampler_fps <= 0 or abs(sampler_fps - original_fps) < 0.001:
            sampler_fps = original_fps
            step = 1.0
            print(f"[PipelineVideoSampler] Using original FPS: {original_fps:.2f}")
        else:
            step = original_fps / sampler_fps
            print(f"[PipelineVideoSampler] Sampling at {sampler_fps:.2f} FPS (step ≈ {step:.3f})")

        frame_indices = []
        i = 0.0
        while i < video_frame_count:
            idx = int(round(i))
            if idx < video_frame_count:
                frame_indices.append(idx)
            i += step

        print(f"[PipelineVideoSampler] Total frames to process: {len(frame_indices)}")

        # ====================== 输出目录 & Progress JSON ======================
        output_dir = os.path.join(folder_paths.output_directory, "Images", folder_name)
        os.makedirs(output_dir, exist_ok=True)
        progress_path = os.path.join(output_dir, "progress.json")

        start_from_index = 0
        last_processed_frame = -1

        if os.path.exists(progress_path):
            try:
                with open(progress_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                last_processed_frame = data.get("last_processed_frame", -1)
                
                if last_processed_frame >= 0:
                    for idx_pos, frame_idx in enumerate(frame_indices):
                        if frame_idx > last_processed_frame:
                            start_from_index = idx_pos
                            break
                    else:
                        start_from_index = len(frame_indices)
            except Exception as e:
                print(f"[PipelineVideoSampler] Failed to read progress.json: {e}")

        if start_from_index >= len(frame_indices):
            print("[PipelineVideoSampler] Nothing to process. All frames completed.")
            return (next_pipeline, float(sampler_fps), len(frame_indices))

        processed_count = start_from_index
        current_index = start_from_index + 1

        steps = getattr(next_pipeline, 'steps', 20)
        actual_start_step = int(steps * float(start_step_rate))
        actual_end_step = int(steps * float(end_step_rate))

        # ====================== 分批处理 ======================
        total_to_process = len(frame_indices)
        i = start_from_index

        while i < total_to_process:
            batch_indices = frame_indices[i : i + images_per_run]
            if not batch_indices:
                break

            print(f"[PipelineVideoSampler] Processing batch frames {batch_indices[0]} ~ {batch_indices[-1]}")

            vr = VideoReader(video_path, ctx=cpu(0))
            frames_tensor = vr.get_batch(batch_indices).float() / 255.0
            del vr

            images = [frames_tensor[j:j+1] for j in range(frames_tensor.shape[0])]

            # 【修改】调用时传入新增参数
            restored_list = self.run_detailer_on_frame(
                images=images,
                detector=detector,
                detector_threshold=detector_threshold,
                detector_prompt=detector_prompt,
                detector_dilation=detector_dilation,
                detector_crop_factor=detector_crop_factor,
                detector_drop_size=detector_drop_size,
                detector_grow=detector_grow,
                detector_blur=detector_blur,
                pixels=pixels,
                align=align,
                crop_reserve=crop_reserve,
                recover_method=recover_method,
                inpaint_mode=inpaint_mode,        # 【新增】
                foreach_mask=foreach_mask,        # 【新增】
                tagger_mask=tagger_mask,          # 【新增】
                next_pipeline=next_pipeline,
                context_positive=context_positive,
                context_negative=context_negative,
                context_loras=context_loras,
                need_reference_latent=need_reference_latent,
                actual_start_step=actual_start_step,
                actual_end_step=actual_end_step,
                return_with_leftover_noise=return_with_leftover_noise,
                add_noise=add_noise,
                seed=seed,
                sampler_name=getattr(next_pipeline, 'sampler_name', "euler"),
                scheduler=getattr(next_pipeline, 'scheduler', "normal"),
                steps=steps,
                cfg=getattr(next_pipeline, 'cfg', 8.0),
                reference=next_pipeline.reference,
                tagger=tagger
            )

            if isinstance(restored_list, list) and restored_list:
                final_batch = torch.cat(restored_list, dim=0)
            elif isinstance(restored_list, torch.Tensor):
                final_batch = restored_list
            else:
                final_batch = torch.zeros((0, 3, 8, 8), device="cpu")

            self._save_batch_images(final_batch, output_dir, current_index)

            batch_size = len(restored_list) if isinstance(restored_list, list) else 1
            current_index += batch_size
            processed_count += batch_size
            i += batch_size

            del frames_tensor, images, restored_list, final_batch
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.synchronize()

            # 更新进度
            try:
                progress_data = {
                    "current_index": current_index,
                    "last_processed_frame": batch_indices[-1],
                    "processed_count": processed_count,
                    "total_to_process": total_to_process,
                    "sampler_fps": sampler_fps,
                    "timestamp": time.strftime("%Y-%m-%d %H:%M:%S")
                }
                with open(progress_path, "w", encoding="utf-8") as f:
                    json.dump(progress_data, f, indent=4, ensure_ascii=False)
            except Exception as e:
                print(f"[PipelineVideoSampler] Failed to write progress.json: {e}")

        print(f"[PipelineVideoSampler] Finished. Saved {processed_count} frames at {sampler_fps} FPS.")
        return (next_pipeline, float(sampler_fps), processed_count)


    # ====================== 核心 Detailer 处理函数（已大幅对齐 DetailerAdvanced） ======================
    def run_detailer_on_frame(self, images, detector, detector_threshold, detector_prompt,
                              detector_dilation, detector_crop_factor, detector_drop_size,
                              detector_grow, detector_blur, pixels, align, crop_reserve,
                              recover_method, inpaint_mode, foreach_mask, tagger_mask,   # 【新增】两个参数
                              next_pipeline, context_positive,
                              context_negative, context_loras, need_reference_latent, 
                              actual_start_step, actual_end_step,
                              return_with_leftover_noise, add_noise, seed, 
                              sampler_name, scheduler, steps, cfg, reference, tagger=None):

        import torch
        import gc
        from comfy.model_management import soft_empty_cache as mm_soft_empty_cache

        size = len(images)

        # ==================== 检测 mask（对齐 DetailerAdvanced 逻辑） ====================
        detailer_masks = []
        detailer_mask_start = []
        detailer_mask_count = []
        index = 0

        for i in range(size):
            if detector is None:
                raise ValueError("detector must be provided for video detailer")

            mask_list = detect_mask(
                detector=detector,
                image=images[i],
                threshold=detector_threshold,
                dilation=detector_dilation,
                crop_factor=detector_crop_factor,
                drop_size=detector_drop_size,
                prompt=detector_prompt
            )

            if foreach_mask:
                if mask_list is None or len(mask_list) == 0:
                    detailer_mask_start.append(index)
                    detailer_mask_count.append(0)
                else:
                    detailer_masks.extend(mask_list)
                    count = len(mask_list)
                    detailer_mask_start.append(index)
                    detailer_mask_count.append(count)
                    index += count
            else:
                if mask_list is None or len(mask_list) == 0:
                    detailer_mask_start.append(index)
                    detailer_mask_count.append(0)
                else:
                    combined = combine_masks(mask_list) if len(mask_list) > 1 else mask_list[0]
                    detailer_masks.append(combined)
                    detailer_mask_start.append(index)
                    detailer_mask_count.append(1)
                    index += 1

        # 扩展 mask
        for m in range(len(detailer_masks)):
            detailer_masks[m] = expand_mask(detailer_masks[m], grow=detector_grow, blur=detector_blur)

        # ==================== Crop ====================
        cropped_images = []
        cropped_masks = []
        crop_infos = []
        processing_mapping = []

        for image_index in range(size):
            mask_start = detailer_mask_start[image_index]
            mask_count = detailer_mask_count[image_index]
            for mask_index in range(mask_start, mask_start + mask_count):
                if mask_count == 0:
                    cropped_images.append(None)
                    cropped_masks.append(None)
                    crop_infos.append(None)
                    processing_mapping.append(image_index)
                    continue
                cropped_image, cropped_mask, crop_info = crop_mask(
                    image=images[image_index],
                    mask=detailer_masks[mask_index],
                    reserve=crop_reserve
                )
                cropped_images.append(cropped_image)
                cropped_masks.append(cropped_mask)
                crop_infos.append(crop_info)
                processing_mapping.append(image_index)

        processing_size = len(cropped_images)

        # ==================== Resize + Encode + Conditioning ====================
        resized_images = []
        resized_masks = []
        resize_infos = []

        for processing_index in range(processing_size):
            if cropped_images[processing_index] is None:
                resized_images.append(None)
                resized_masks.append(None)
                resize_infos.append(None)
                continue

            resized_image, resized_mask, resize_info = limit_pixels(
                image=cropped_images[processing_index],
                pixels=pixels,
                mask=cropped_masks[processing_index],
                align=align,
            )
            
            resized_images.append(resized_image)
            resized_masks.append(resized_mask)
            resize_infos.append(resize_info)

        tmp_latents = []
        # ==================== KSamplerAdvanced ====================
        for processing_index in range(processing_size):
            if resized_images[processing_index] is None:
                tmp_latents.append(None)
                continue
            if inpaint_mode:
                _, tmp_latent = set_inpaint_mask(
                    resized_image=resized_images[processing_index],
                    resized_mask=resized_masks[processing_index],
                    vae=next_pipeline.vae,
                    grow_mask_by=0          # 可改为可配置参数
                )
            else:
                tmp_latent = VAEEncode().encode(
                    vae=next_pipeline.vae, 
                    pixels=resized_images[processing_index]
                )[0]

            
            if tagger is not None:
                if tagger_mask:
                    tagger_image = draw_mask_on_image(resized_images[processing_index], invert_mask(resized_masks[processing_index]), (255, 255, 255, 255))
                else:
                    tagger_image = resized_images[processing_index]
                tagger_positive = get_tag(tagger, tagger_image)
                if next_pipeline.config.get("print_tag") is True:
                    print(f"[TAG]: {tagger_positive}")
            else:
                tagger_image = resized_images[processing_index]
                tagger_positive = ''
                
            current_positive = context_positive + (',' + tagger_positive if tagger_positive else '')
            current_negative = context_negative
            current_loras = context_loras.copy()
            
            tmp_positive, tmp_negative, tmp_loras = next_pipeline.context.get_prompt_context(tagger_positive, tagger_image)
            if tmp_positive:
                current_positive += (',' + tmp_positive)
            if tmp_negative:
                current_negative += (',' + tmp_negative)
            if tmp_loras:
                current_loras.extend(tmp_loras)
                
                
            model_negative = next_pipeline.config.get("model_negative")
            model_to_use, clip_to_use, model_negative_to_use = next_pipeline.cache.get_model_clip(
                model=next_pipeline.model, clip=next_pipeline.clip, loras=current_loras,
                reference=reference,
                model_negative=model_negative
            )
            
            positive_condition = next_pipeline.get_conditioning(
                mode="positive", clip=clip_to_use, vae=next_pipeline.vae,
                prompt=current_positive,
                reference_latent=tmp_latent if need_reference_latent else None,
                reference_image=resized_images[processing_index],
                reference=reference
            )
            
            negative_condition = next_pipeline.get_conditioning(
                mode="negative", clip=clip_to_use, vae=next_pipeline.vae,
                prompt=current_negative,
                reference_latent=tmp_latent if need_reference_latent else None,
                reference_image=resized_images[processing_index],
                reference=reference
            )
            
            sampled = _ksampler(
                model=model_to_use,
                seed=seed,
                steps=steps,
                cfg=cfg,
                sampler_name=sampler_name,
                scheduler=scheduler,
                positive=positive_condition,
                negative=negative_condition,
                latent=tmp_latent,
                disable_noise=(add_noise == "disable"),
                start_step=actual_start_step,
                last_step=actual_end_step,
                force_full_denoise=(return_with_leftover_noise == "disable"),
                sigmas=next_pipeline.config.get("sigmas"),
                model_negative=model_negative_to_use,
            )[0]
            
            tmp_latents.append(sampled.detach() if hasattr(sampled, 'detach') else sampled)

        # ==================== Decode ====================
        detailed_images = []
        for processing_index in range(processing_size):
            if tmp_latents[processing_index] is None:
                detailed_images.append(None)
                continue
            detailed_images.append(
                VAEDecode().decode(vae=next_pipeline.vae, samples=tmp_latents[processing_index])[0]
            )

        # ==================== Recover Size ====================
        recovered_images = []
        recovered_masks = []
        for processing_index in range(processing_size):
            if detailed_images[processing_index] is None:
                recovered_images.append(None)
                recovered_masks.append(None)
                continue
            recovered_image, recovered_mask = recover_size(
                image=detailed_images[processing_index],
                resize_info=resize_infos[processing_index],
                mask=resized_masks[processing_index]
            )
            recovered_images.append(recovered_image)
            recovered_masks.append(recovered_mask)

        # ==================== Recover Crop ====================
        final_images = [img.clone() if img is not None else None for img in images]

        for processing_index in range(processing_size):
            if cropped_images[processing_index] is None:
                continue
            image_index = processing_mapping[processing_index]
            final_image, _ = recover_crop(
                background=final_images[image_index],
                image=recovered_images[processing_index],
                crop_info=crop_infos[processing_index],
                recover_method=recover_method,
                mask=recovered_masks[processing_index]
            )
            final_images[image_index] = final_image

        # 彻底清理
        del (cropped_images, cropped_masks, crop_infos, resized_images, resized_masks,
             resize_infos, tmp_latents,
             detailed_images, recovered_images, recovered_masks, detailer_masks)

        gc.collect()
        mm_soft_empty_cache()

        return final_images


    # ====================== 保存函数（保持不变） ======================
    def _save_batch_images(self, images, output_dir, start_index):
        if not isinstance(images, torch.Tensor) or images.shape[0] == 0:
            return

        for idx in range(images.shape[0]):
            current_num = start_index + idx
            image_tensor = images[idx]

            np_image = (image_tensor * 255.0).clamp(0, 255).to(torch.uint8).cpu().numpy()
            mode = "RGBA" if np_image.shape[-1] == 4 else "RGB"
            if np_image.shape[-1] > 3:
                np_image = np_image[..., :3]

            pil_image = Image.fromarray(np_image, mode=mode)
            save_path = os.path.join(output_dir, f"{current_num:06d}.png")

            try:
                pil_image.save(save_path, compress_level=4)
            except Exception as e:
                print(f"Error saving frame {save_path}: {e}")