"""QwenImage21 架构模块 — 实现 TextEncodeQwenImage21 逻辑（Qwen-Image-2.1 统一编码）。

参考图像同时走两条路径：
- 语义路径: 缩放后的图像交给 Qwen3-VL text encoder（vision tokens，槽位自动插入 <image1>…）
- 外观路径: **同一尺寸**图像 VAE 编码为 reference_latents（DiT 原生支持，按 image_slots 拼接）

与 QwenEdit(Edit-Plus) 的差异：
- vision 与 VAE 使用同一尺寸（每个 vision token 对齐 2x2 latent），尺寸按 32 取整
- 不拼接 "Picture N:" 前缀与 llama_template（tokenizer 自动生成模板与图像槽位）
- keep_vision=False 表示 text encoder 丢弃 vision tokens，图像仅经 DiT 的 reference_latents 注入
- 有 alpha 时 vision 侧按白底合成 RGB，VAE 侧保留 4 通道
- 与 detailer 联用时第一格参考图 = 本块工作图本身（source_latent 直传，尺寸不再重推）

参考: comfy_extras/nodes_qwen.py TextEncodeQwenImage21
"""
import math
import re
import comfy.utils

# 参考图缩放边长（0 = 保持自身尺寸，仅按 SLOT_ALIGN 取整）
RESOLUTION_DEFAULT = 0
# vision token 32px = 2x2 latent(16px)，参考图尺寸需 32 对齐才能与 latent 网格对齐
SLOT_ALIGN = 32
# 兼容 "QwenImage21" / "Qwen-Image-2.1" / "Qwen Image 2.1" 等写法
ARCH_PATTERN = r"Qwen[\s_-]*Image[\s_-]*2"


def matches(config):
    """config.architecture 是否指向 QwenImage2.1。"""
    architecture = config.get("architecture") if config else None
    return bool(architecture and re.search(ARCH_PATTERN, architecture, re.IGNORECASE))


def adjust_align(align):
    """采样尺寸对齐：detailer crop 需与 vision/latent 共享的 32 像素格对齐。"""
    return max(int(align), SLOT_ALIGN)


def apply_model_patch(model_patcher):
    """QwenImage21: 不需要 model patch，reference_latents 由模型原生支持。"""
    return model_patcher


def _slot_size(samples, resolution):
    """(B, C, H, W) → 槽位像素尺寸 (width, height)，32 对齐。

    resolution > 0: 面积约 resolution^2，保持宽高比（对齐 TextEncodeQwenImage21 的 resize）；
    resolution = 0: 保持自身尺寸（与采样目标同尺寸，"任何其它尺寸都会偏移编辑"）。
    """
    h, w = samples.shape[2], samples.shape[3]
    if resolution and resolution > 0:
        ratio = w / h
        width = round(math.sqrt(resolution * resolution * ratio) / SLOT_ALIGN) * SLOT_ALIGN
        height = round(math.sqrt(resolution * resolution / ratio) / SLOT_ALIGN) * SLOT_ALIGN
    else:
        width, height = round(w / SLOT_ALIGN) * SLOT_ALIGN, round(h / SLOT_ALIGN) * SLOT_ALIGN
    return max(SLOT_ALIGN, width), max(SLOT_ALIGN, height)


def _slot_images(vae, reference_latent, reference_image, reference, VAEDecode):
    """收集参考图像（HWC，槽位顺序）：当前 pipeline 图像优先，其余 reference_latents 解码。"""
    images = []
    if reference_image is not None:
        images.append(reference_image)
    elif reference_latent is not None and vae is not None:
        images.append(VAEDecode().decode(vae=vae, samples={"samples": reference_latent["samples"]})[0])

    if vae is not None:
        for lat in reference.reference_latents:
            images.append(VAEDecode().decode(vae=vae, samples={"samples": lat["samples"]})[0])

    return images


def get_conditioning(self, mode, clip, vae, prompt, reference_latent, reference_image,
                     reference, conditioning_set_values, VAEDecode, source_latent=None):
    """QwenImage21: TextEncodeQwenImage21 逻辑（positive / negative 携带同一组参考图）。

    source_latent: 调用方已经为**第一张参考图**编码好的 target latent（detailer 的
    tmp_latent["samples"]）。给出时第一格不再自行推导尺寸、也不再重编码：图像原样进
    视觉槽位，latent 直接沿用 source_latent。核心里 reference 的 RoPE 网格以 target
    为中心、还带奇偶修正（qwen_image21/model.py build_sequence），第一格与 target 的
    网格差半格，编辑就整体偏移 —— 让它等于 target 的编码源，比事后按 _slot_size 重推
    可靠。resolution 与 qwen_image21_resolution 从第二格起才起作用。
    """
    resolution = RESOLUTION_DEFAULT
    if self.config:
        resolution = self.config.get("qwen_image21_resolution", RESOLUTION_DEFAULT)

    images = _slot_images(vae, reference_latent, reference_image, reference, VAEDecode)
    # 第一格钉在 source_latent 的几何上，只对"就是这张工作图"的槽位成立
    pinned = source_latent is not None and reference_image is not None

    images_vl = []
    ref_latents = []
    for index, image in enumerate(images):
        samples = image[:1].movedim(-1, 1)  # B,H,W,C -> B,C,H,W，每个槽位一张图
        first = pinned and index == 0
        if first:
            s = image[:1]
        else:
            width, height = _slot_size(samples, resolution)
            if (width, height) == (samples.shape[3], samples.shape[2]):
                s = image[:1]
            else:
                s = comfy.utils.common_upscale(samples, width, height, "lanczos", "disabled").movedim(1, -1)

        rgb = s[:, :, :, :3]
        if s.shape[-1] > 3:
            # vision 塔看白底合成后的 RGB，VAE 保留全部 4 通道
            rgb = rgb * s[:, :, :, 3:] + (1.0 - s[:, :, :, 3:])
        images_vl.append(rgb)
        if vae is not None:
            ref_latents.append(source_latent[:1] if first else vae.encode(s))

    if len(images_vl) > 0:
        print(f"[QwenImage21] {len(images_vl)} reference image(s) -> vision slots + "
              f"{len(ref_latents)} reference latent(s)")
    try:
        from ..libs import debug_trace as dbg
        for _i, _img in enumerate(images_vl):
            _lat = ref_latents[_i] if _i < len(ref_latents) else None
            dbg.record_stage(f'OffsetProbe Q21 slot{_i}', block=0,
                             img_shape=list(_img.shape),
                             latent_shape=(list(_lat.shape) if _lat is not None else None),
                             pinned=(pinned and _i == 0),
                             keep_vision=keep_vision,
                             resolution=resolution)
    except Exception as _e:
        print(f"[QwenImage21] OffsetProbe record failed: {_e!r}")

    # 无 vae 时 latent 路径不可用，保留 vision tokens 让图像只经 text encoder 生效
    keep_vision = len(ref_latents) == 0
    tokens = clip.tokenize(prompt, images=images_vl, keep_vision=keep_vision, prevent_empty_text=True)
    condition = clip.encode_from_tokens_scheduled(tokens)

    if len(ref_latents) > 0:
        condition = conditioning_set_values(condition, {"reference_latents": ref_latents}, append=True)

    return condition
