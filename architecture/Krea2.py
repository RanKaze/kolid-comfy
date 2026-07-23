"""Krea2 架构模块 — 基于 comfyui-krea2edit 的单流 forward + grounded encode。

单流架构: 序列 = [text | source(frame=1) | target(frame=0)]
通过 RoPE frame index 区分源/目标，匹配 krea2_edit LoRA 的训练方式。

参考: F:\\ComfyDB\\custom_nodes\\comfyui-krea2edit\\__init__.py
"""
import math
import torch
import torch.nn.functional as F
import comfy
import comfy.conds
import comfy.ldm.common_dit
import comfy.utils


VLM_MAX_PIXELS = 384 * 384
REF_LATENT_MAX_PIXELS = 1024 * 1024
REF_SNAP = 16
GROUNDING_PX_DEFAULT = 768

SYSTEM_PROMPT_DEFAULT = (
    "Describe the image by detailing the color, shape, size, "
    "texture, quantity, text, spatial relationships of the objects and background:"
)


# ====================== 辅助函数 ======================

def _imgids(bs, frame, h_, w_, device):
    """生成 3 轴 RoPE 位置 ID: (frame, y_index, x_index)。"""
    ids = torch.zeros(h_, w_, 3, device=device, dtype=torch.float32)
    ids[..., 0] = frame
    ids[..., 1] = torch.arange(h_, device=device, dtype=torch.float32)[:, None]
    ids[..., 2] = torch.arange(w_, device=device, dtype=torch.float32)[None, :]
    return ids.reshape(1, h_ * w_, 3).repeat(bs, 1, 1)


def _to_4d(v):
    """(B,C,T,H,W) -> (B*T,C,H,W); 4D 直接返回。"""
    if v.ndim == 5:
        b, c, t, h, w = v.shape
        return v.reshape(b * t, c, h, w)
    return v


def _fit_src(src, H, W):
    """将源潜空间适配到目标网格: 中心裁剪到目标宽高比，然后 resize。"""
    sh, sw = src.shape[-2:]
    if (sh, sw) == (H, W):
        return src
    s = max(H / sh, W / sw)
    ch, cw = min(sh, int(round(H / s))), min(sw, int(round(W / s)))
    y0, x0 = (sh - ch) // 2, (sw - cw) // 2
    src = src[..., y0:y0 + ch, x0:x0 + cw]
    return F.interpolate(src.float(), size=(H, W), mode="bilinear")


def _fit_area(samples, max_pixels, snap=1):
    """将 (B, C, H, W) 图像缩小（不放大）到 max_pixels 以内，保持宽高比，对齐到 snap。"""
    h, w = samples.shape[2], samples.shape[3]
    scale = min(1.0, math.sqrt(max_pixels / (w * h)))
    nw = max(round(w * scale / snap) * snap, snap)
    nh = max(round(h * scale / snap) * snap, snap)
    if (nh, nw) == (h, w):
        return samples
    return comfy.utils.common_upscale(samples, nw, nh, "area", "disabled")


def _ref_attn_bias(boosts, boost_mask, txtlen, slens, tgtlen, mask_hw, device, dtype):
    """构建加性注意力偏置矩阵，用于 ref_boost。

    boosts: 每个参考的 target->ref 注意力乘数（最后一个 = 主体）。
    boost_mask: 可选的区域 mask，限制最后一个参考的 boost 范围。
    """
    nsrc = len(slens)
    offs = [txtlen]
    for sl in slens:
        offs.append(offs[-1] + sl)
    rows0 = offs[-1]
    L = rows0 + tgtlen
    bias = torch.zeros(1, 1, L, L, device=device, dtype=dtype)
    for i, b in enumerate(boosts):
        if b == 1.0:
            continue
        off, sl = offs[i], slens[i]
        if boost_mask is not None and i == nsrc - 1 and mask_hw is not None:
            mask = boost_mask[:1]
            if mask.ndim == 2:
                mask = mask[None]
            mask = F.interpolate(mask[None].float(), size=mask_hw[i], mode="area")[0, 0]
            cols = off + torch.nonzero(mask.reshape(-1) > 0.5, as_tuple=True)[0].to(device)
        else:
            cols = torch.arange(off, off + sl, device=device)
        bias[:, :, rows0:, cols] = math.log(max(b, 1e-4))
    return bias


# ====================== 核心 forward ======================

def krea2_edit_forward(m, x, timesteps, context, ref_latents, transformer_options,
                       ref_boost=1.0, ref_boost_a=1.0, ref_boost_mask=None):
    """Krea2 SingleStreamDiT forward，带源参考块。

    单流架构: [text | source(frame=1..N) | target(frame=0)]
    通过 RoPE frame index 区分源/目标，匹配 krea2_edit LoRA 训练。

    m           : SingleStreamDiT 实例
    x           : (B,C,H,W) 或 (B,C,T,H,W) 噪声目标潜空间
    ref_latents : 源潜空间列表 (来自 extra_conds/conditioning)
    context     : (B, seq, txtlayers*txtdim) — Qwen3-VL 编码
    """
    from einops import rearrange
    from comfy.ldm.flux.layers import timestep_embedding

    patch = m.patch

    temporal = x.ndim == 5
    if temporal:
        b5, c5, t5, h5, w5 = x.shape
    x = _to_4d(x)
    bs, c, H_orig, W_orig = x.shape

    x = comfy.ldm.common_dit.pad_to_patch_size(x, (patch, patch), padding_mode="replicate")
    H, W = x.shape[-2], x.shape[-1]
    h_, w_ = H // patch, W // patch

    # 处理源潜空间: 适配目标网格、pad、batch
    src_list = list(ref_latents) if not isinstance(ref_latents, (list, tuple)) else ref_latents
    srcs = []
    for sl in src_list:
        src = _to_4d(sl).to(x.device, x.dtype)
        if src.shape[0] != bs:
            src = src[:1].expand(bs, *src.shape[1:])
        if src.shape[-2:] != (H, W):
            src = _fit_src(src, H, W).to(x.dtype)
        srcs.append(comfy.ldm.common_dit.pad_to_patch_size(src, (patch, patch), padding_mode="replicate"))
    src_grids = [(s_.shape[-2] // patch, s_.shape[-1] // patch) for s_ in srcs]

    context = m._unpack_context(context)

    tgt_img = m.first(rearrange(x, "b c (h ph) (w pw) -> b (h w) (c ph pw)", ph=patch, pw=patch))
    src_imgs = [m.first(rearrange(s_, "b c (h ph) (w pw) -> b (h w) (c ph pw)", ph=patch, pw=patch))
                for s_ in srcs]

    t = m.tmlp(timestep_embedding(timesteps, m.tdim).unsqueeze(1).to(tgt_img.dtype))
    tvec = m.tproj(t)

    context = m.txtfusion(context, mask=None, transformer_options=transformer_options)
    context = m.txtmlp(context)

    txtlen, tgtlen = context.shape[1], tgt_img.shape[1]
    srclen = sum(si.shape[1] for si in src_imgs)
    combined = torch.cat([context] + src_imgs + [tgt_img], dim=1)  # [text | refs... | target]

    device = combined.device
    ref_ids = [_imgids(bs, i + 1, gh, gw, device) for i, (gh, gw) in enumerate(src_grids)]
    pos = torch.cat([
        torch.zeros(bs, txtlen, 3, device=device, dtype=torch.float32)]   # text @ frame=0
        + ref_ids                                                          # refs @ frame=1,2,...
        + [_imgids(bs, 0, h_, w_, device)],                                # target @ frame=0
        dim=1)
    freqs = m.pe_embedder(pos)

    attn_bias = None
    if ref_boost != 1.0 or ref_boost_a != 1.0:
        boosts = [ref_boost_a] * (len(src_imgs) - 1) + [ref_boost]
        attn_bias = _ref_attn_bias(boosts, ref_boost_mask, txtlen,
                                   [si.shape[1] for si in src_imgs], tgtlen,
                                   src_grids, combined.device, combined.dtype)

    for block in m.blocks:
        combined = block(combined, tvec, freqs, attn_bias, transformer_options=transformer_options)

    final = m.last(combined, t)
    out = final[:, txtlen + srclen: txtlen + srclen + tgtlen, :]  # 只取 target tokens
    out = rearrange(out, "b (h w) (c ph pw) -> b c (h ph) (w pw)",
                    h=h_, w=w_, ph=patch, pw=patch, c=m.channels)
    out = out[:, :, :H_orig, :W_orig]
    if temporal:
        out = out.reshape(b5, t5, m.channels, H_orig, W_orig).movedim(1, 2)
    return out


# ====================== 模型 patch ======================

def apply_model_patch(model_patcher, ref_boost=1.0, ref_boost_a=1.0, ref_boost_mask=None):
    """对 Krea2 模型做 edit forward patch（单流 + RoPE frame 区分）。

    使用 extra_conds 机制传递 reference_latents，
    forward 使用 krea2_edit_forward（单流架构）。
    """
    m = model_patcher.clone()
    base_model = m.model
    dit = m.get_model_object("diffusion_model")

    orig_extra_conds = base_model.extra_conds
    orig_extra_conds_shapes = base_model.extra_conds_shapes
    orig_forward = dit.forward

    def extra_conds(**kwargs):
        out = orig_extra_conds(**kwargs)
        ref_latents = kwargs.get("reference_latents", None)
        if ref_latents is not None:
            out["ref_latents"] = comfy.conds.CONDList(
                [base_model.process_latent_in(lat) for lat in ref_latents]
            )
        return out

    def extra_conds_shapes(**kwargs):
        out = orig_extra_conds_shapes(**kwargs)
        ref_latents = kwargs.get("reference_latents", None)
        if ref_latents is not None:
            out["ref_latents"] = list(
                [1, 16, sum(map(lambda a: math.prod(a.size()), ref_latents)) // 16]
            )
        return out

    def forward(x, timesteps, context, attention_mask=None, transformer_options={}, ref_latents=None, **kwargs):
        if ref_latents is None or len(ref_latents) == 0:
            return orig_forward(x, timesteps, context, attention_mask=attention_mask, transformer_options=transformer_options, **kwargs)
        return krea2_edit_forward(dit, x, timesteps, context, ref_latents, transformer_options,
                                  ref_boost=ref_boost, ref_boost_a=ref_boost_a, ref_boost_mask=ref_boost_mask)

    m.add_object_patch("extra_conds", extra_conds)
    m.add_object_patch("extra_conds_shapes", extra_conds_shapes)
    m.add_object_patch("diffusion_model.forward", forward)
    return m


# ====================== 条件编码 (grounded encode) ======================

def get_conditioning(self, mode, clip, vae, prompt, reference_latent, reference_image, reference, conditioning_set_values, VAEDecode):
    """Krea2: grounded encode + 参考潜空间。

    使用 system prompt 模板让 VLM "看到"源图（语义路径），
    同时 VAE 编码源图为潜空间并附加到 conditioning（外观路径）。
    """
    grounding_px = self.config.get("grounding_px", GROUNDING_PX_DEFAULT) if self.config else GROUNDING_PX_DEFAULT
    system_prompt = self.config.get("krea2_system_prompt", "") if self.config else ""
    sp = system_prompt.strip() if system_prompt else SYSTEM_PROMPT_DEFAULT

    images_vl = []
    ref_latents = []

    # 处理当前 pipeline 图像 (reference_image) — 编辑场景的源图
    if reference_image is not None:
        samples = reference_image.movedim(-1, 1)  # B,H,W,C -> B,C,H,W
        h, w = samples.shape[2], samples.shape[3]

        # VLM 图像: 缩小到 grounding_px 以内
        if grounding_px and max(h, w) > grounding_px:
            s = grounding_px / max(h, w)
            samples_vl = comfy.utils.common_upscale(samples, round(w * s), round(h * s), "area", "disabled")
        else:
            samples_vl = samples
        images_vl.append(samples_vl.movedim(1, -1)[:, :, :, :3])

        # VAE 潜空间: 缩小到 REF_LATENT_MAX_PIXELS 以内
        s_fit = _fit_area(samples, REF_LATENT_MAX_PIXELS, snap=REF_SNAP)
        ref_latents.append(vae.encode(s_fit.movedim(1, -1)[:, :, :, :3]))

    # 处理额外参考潜空间 (来自 ReferenceImageNode / ReferenceLatentNode)
    for lat in reference.reference_latents:
        samples = lat["samples"]
        decoded = VAEDecode().decode(vae=vae, samples={"samples": samples})[0]
        s = decoded.movedim(-1, 1)  # B,C,H,W

        # VLM 图像
        h, w = s.shape[2], s.shape[3]
        if grounding_px and max(h, w) > grounding_px:
            scale = grounding_px / max(h, w)
            s_vl = comfy.utils.common_upscale(s, round(w * scale), round(h * scale), "area", "disabled")
        else:
            s_vl = s
        images_vl.append(s_vl.movedim(1, -1)[:, :, :, :3])

        # VAE 潜空间
        s_fit = _fit_area(s, REF_LATENT_MAX_PIXELS, snap=REF_SNAP)
        ref_latents.append(vae.encode(s_fit.movedim(1, -1)[:, :, :, :3]))

    if len(images_vl) > 0:
        print(f"[Reference] Krea2: {len(images_vl)} reference image(s) -> grounded encode + VAE re-encode")

    # 构建 grounded encode 模板 (带 system prompt)
    nimg = len(images_vl)
    vis = "<|vision_start|><|image_pad|><|vision_end|>" * nimg
    template = ("<|im_start|>system\n" + sp + "<|im_end|>\n<|im_start|>user\n"
                + vis + "{}<|im_end|>\n<|im_start|>assistant\n")

    tokens = clip.tokenize(prompt, images=images_vl, llama_template=template)
    condition = clip.encode_from_tokens_scheduled(tokens)

    if len(ref_latents) > 0:
        condition = conditioning_set_values(
            condition, {"reference_latents": ref_latents}, append=True
        )

    return condition
