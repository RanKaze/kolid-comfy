"""QwenEdit 架构模块 — 实现 TextEncodeQwenImageEditPlus 逻辑。

使用 Qwen VL 的 vision tokens 让 VLM "看到"参考图像（语义路径），
同时将参考潜空间附加到 conditioning（外观路径）。

参考: comfy_extras/nodes_qwen.py TextEncodeQwenImageEditPlus
"""
import math
import torch
import comfy
import comfy.utils


VLM_MAX_PIXELS = 384 * 384
VAE_MAX_PIXELS = 1024 * 1024

LLAMA_TEMPLATE = (
    "<|im_start|>system\n"
    "Describe the key features of the input image (color, shape, size, texture, objects, background), "
    "then explain how the user's text instruction should alter or modify the image. "
    "Generate a new image that meets the user's requirements while maintaining consistency "
    "with the original input where appropriate.<|im_end|>\n"
    "<|im_start|>user\n{}<|im_end|>\n"
    "<|im_start|>assistant\n"
)


def _fit_area(samples, max_pixels, snap=1):
    """将 (B, C, H, W) 图像缩小（不放大）到 max_pixels 以内，保持宽高比，对齐到 snap。"""
    h, w = samples.shape[2], samples.shape[3]
    scale = min(1.0, math.sqrt(max_pixels / (w * h)))
    nw = max(round(w * scale / snap) * snap, snap)
    nh = max(round(h * scale / snap) * snap, snap)
    if (nh, nw) == (h, w):
        return samples
    return comfy.utils.common_upscale(samples, nw, nh, "area", "disabled")


def apply_model_patch(model_patcher):
    """QwenEdit: 不需要 model patch，reference_latents 由模型原生支持。"""
    return model_patcher


def get_conditioning(self, mode, clip, vae, prompt, reference_latent, reference_image,
                     reference, conditioning_set_values, VAEDecode):
    """QwenEdit: TextEncodeQwenImageEditPlus 逻辑。

    - VLM 图像: 从 reference_image + 解码 reference.reference_latents → 384×384
    - reference_latents: 直接使用 reference.reference_latents 的原始潜空间 + VAE 编码 reference_image
    """
    images_vl = []
    ref_latents = []
    image_prompt = ""

    # 处理当前 pipeline 图像 (reference_image) — 编辑场景的源图
    if reference_image is not None:
        samples = reference_image.movedim(-1, 1)  # B,H,W,C -> B,C,H,W
        # VLM 图像: 384×384
        s_vl = _fit_area(samples, VLM_MAX_PIXELS)
        images_vl.append(s_vl.movedim(1, -1)[:, :, :, :3])
        # VAE 潜空间: 1024×1024 (对齐到 8)
        s_vae = _fit_area(samples, VAE_MAX_PIXELS, snap=8)
        ref_latents.append(vae.encode(s_vae.movedim(1, -1)[:, :, :, :3]))
        image_prompt += "Picture {}: <|vision_start|><|image_pad|><|vision_end|>".format(len(images_vl))

    # 处理额外参考潜空间 (来自 ReferenceImageNode / ReferenceLatentNode)
    for lat in reference.reference_latents:
        samples = lat["samples"]
        # 解码为图像用于 VLM
        decoded = VAEDecode().decode(vae=vae, samples={"samples": samples})[0]
        s = decoded.movedim(-1, 1)  # B,C,H,W
        # VLM 图像: 384×384
        s_vl = _fit_area(s, VLM_MAX_PIXELS)
        images_vl.append(s_vl.movedim(1, -1)[:, :, :, :3])
        # reference_latents: 直接使用原始潜空间
        ref_latents.append(samples)
        image_prompt += "Picture {}: <|vision_start|><|image_pad|><|vision_end|>".format(len(images_vl))

    if len(images_vl) > 0:
        print(f"[QwenEdit] {len(images_vl)} reference image(s) -> VLM encode + reference_latents")

    tokens = clip.tokenize(image_prompt + prompt, images=images_vl, llama_template=LLAMA_TEMPLATE)
    condition = clip.encode_from_tokens_scheduled(tokens)

    if len(ref_latents) > 0:
        condition = conditioning_set_values(condition, {"reference_latents": ref_latents}, append=True)

    return condition
