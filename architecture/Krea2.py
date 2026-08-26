"""Krea2 架构模块 — 基于 comfyui-krea2edit 的单流 forward + grounded encode。

单流架构: 序列 = [text | source(frame=1) | target(frame=0)]
通过 RoPE frame index 区分源/目标，匹配 krea2_edit LoRA 的训练方式。

参考: F:\\ComfyDB\\custom_nodes\\comfyui-krea2edit\\__init__.py
"""
import math
import torch
import torch.nn.functional as F
import comfy
import comfy.ldm.common_dit
import comfy.utils


VLM_MAX_PIXELS = 384 * 384
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


def _imgids_offset(bs, frame, gh, gw, th, tw, device):
    """stride-1 整数位置 ID，居中偏移。用于 fit 模式下已对齐目标网格密度的参考。"""
    off_h, off_w = max(0, (th - gh) // 2), max(0, (tw - gw) // 2)
    ids = torch.zeros(gh, gw, 3, device=device, dtype=torch.float32)
    ids[..., 0] = frame
    ids[..., 1] = (torch.arange(gh, device=device, dtype=torch.float32) + off_h)[:, None]
    ids[..., 2] = (torch.arange(gw, device=device, dtype=torch.float32) + off_w)[None, :]
    return ids.reshape(1, gh * gw, 3).repeat(bs, 1, 1)


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


def _fit_encode_image(image, vae, H, W, cache, key, fit_mode="crop"):
    """像素空间源图适配: 在 VAE 编码前完成 crop/resize，避免 latent 空间插值模糊。

    H, W 为目标 latent 尺寸; px_h=H*8, px_w=W*8 为目标像素尺寸。
    fit_mode='fit': 按比例缩放后居中放置（stride-1 位置 ID 匹配训练几何）。
    fit_mode='crop': center-crop 到目标宽高比后 resize 到精确目标像素尺寸。
    """
    key = key + (fit_mode,)
    if key in cache:
        return cache[key]
    print(f"[Krea2] _fit_encode_image: mode={fit_mode} in={tuple(image.shape)} target_latent={H}x{W}", flush=True)
    px_h, px_w = H * 8, W * 8
    img = image.movedim(-1, 1)  # B,H,W,C -> B,C,H,W
    ih, iw = img.shape[-2:]
    if fit_mode == "fit":
        sc = min(px_h / ih, px_w / iw)
        CROP_TOL = 0.08
        if ih * sc >= px_h * (1 - CROP_TOL) and iw * sc >= px_w * (1 - CROP_TOL):
            s = max(px_h / ih, px_w / iw)
            ch, cw = min(ih, int(round(px_h / s))), min(iw, int(round(px_w / s)))
            y0, x0 = (ih - ch) // 2, (iw - cw) // 2
            img = img[..., y0:y0 + ch, x0:x0 + cw]
            nh, nw = px_h, px_w
        else:
            nh = min(max(16, int(ih * sc) // 16 * 16), max(16, px_h // 16 * 16))
            nw = min(max(16, int(iw * sc) // 16 * 16), max(16, px_w // 16 * 16))
        img = F.interpolate(img.float(), size=(nh, nw), mode="bicubic", antialias=True)
        lat = vae.encode(img.movedim(1, -1)[..., :3].clamp(0, 1))
        cache[key] = lat
        return lat
    # crop (default): center-crop to target AR, then resize
    s = max(px_h / ih, px_w / iw)
    ch, cw = min(ih, int(round(px_h / s))), min(iw, int(round(px_w / s)))
    y0, x0 = (ih - ch) // 2, (iw - cw) // 2
    img = img[..., y0:y0 + ch, x0:x0 + cw]
    img = F.interpolate(img.float(), size=(px_h, px_w), mode="bicubic", antialias=True)
    lat = vae.encode(img.movedim(1, -1)[..., :3].clamp(0, 1))
    cache[key] = lat
    return lat


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
                       ref_boost=1.0, ref_boost_a=1.0, ref_boost_mask=None,
                       ref_native=False, pos_mode="anchor"):
    """Krea2 SingleStreamDiT forward，带源参考块。

    单流架构: [text | source(frame=1..N) | target(frame=0)]
    通过 RoPE frame index 区分源/目标，匹配 krea2_edit LoRA 训练。

    m           : SingleStreamDiT 实例
    x           : (B,C,H,W) 或 (B,C,T,H,W) 噪声目标潜空间
    ref_latents : 源潜空间列表 (来自 extra_conds/conditioning)
    context     : (B, seq, txtlayers*txtdim) — Qwen3-VL 编码
    ref_native  : True = 源已在目标分辨率（像素路径），跳过 _fit_src
    pos_mode    : 'stride1' = 居中偏移位置 ID（fit 模式），'anchor' = 锚点位置
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
    # 裸 tensor 时按整体包裹（list(tensor) 会沿 dim0 错误迭代）
    src_list = ref_latents if isinstance(ref_latents, (list, tuple)) else [ref_latents]
    srcs = []
    for sl in src_list:
        src = _to_4d(sl).to(x.device, x.dtype)
        if src.shape[0] != bs:
            src = src[:1].expand(bs, *src.shape[1:])
        if not ref_native and src.shape[-2:] != (H, W):
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
    if pos_mode == "stride1" and ref_native:
        if any(h_ - gh > 2 or w_ - gw > 2 for gh, gw in src_grids):
            print("[Krea2] NOTE: fit margins >2 tokens (source/output aspect-ratio gap is large). "
                  "fit is trained for matched/near-matched AR; for a big AR change prefer 'crop', "
                  "or set the output AR closer to the source.", flush=True)
        ref_ids = [_imgids_offset(bs, i + 1, gh, gw, h_, w_, device)
                   for i, (gh, gw) in enumerate(src_grids)]
    else:
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

def apply_model_patch(model_patcher, ref_boost=1.0, ref_boost_a=1.0, ref_boost_mask=None,
                      fit_mode="fit", vae=None, pixel_state=None):
    """对 Krea2 模型做 edit forward patch（单流 + RoPE frame 区分）。

    对齐 comfyui-krea2edit (source patch) 的数据流：source 由节点级
    pixel_state 闭包持有（不经 conditioning 管道）——
      - source_images + vae: 像素路径（fit/crop，按目标分辨率编码，防模糊）
      - source_latents: latent fallback（无 vae/像素时）
    conditioning 只承载 grounded encode 的语义输出（纯文本+vision tokens）。
    pixel_state: 可选共享状态 dict，用于多个 model patcher（如 model_negative）共享同一组源图。
    """
    m = model_patcher.clone()
    base_model = m.model
    dit = m.get_model_object("diffusion_model")

    orig_forward = dit.forward

    if pixel_state is None:
        pixel_state = {"fit_mode": fit_mode, "vae": vae,
                       "source_images": None, "source_latents": None, "px_cache": {}}
    # ref_boost 三参数动态化: pixel_state 优先（block 级逐块切换），
    # patch 参数作为初始默认（主 SamplerNode / PipelineEnableEditNode 路径）
    pixel_state.setdefault("ref_boost", ref_boost)
    pixel_state.setdefault("ref_boost_a", ref_boost_a)
    pixel_state.setdefault("ref_boost_mask", ref_boost_mask)
    m.model_options["_krea2_pixel_state"] = pixel_state

    def forward(x, timesteps, context, attention_mask=None, transformer_options={}, ref_latents=None, **kwargs):
        # ref_latents 参数仅作签名兼容（原生 execute 签名含此位）；
        # source 一律来自 pixel_state（节点级注入，对齐参考闭包持有模式）
        src_images = pixel_state.get("source_images")
        src_latents = pixel_state.get("source_latents")
        pxe = pixel_state.get("vae")
        fmode = pixel_state.get("fit_mode", "crop")
        rb = pixel_state.get("ref_boost", ref_boost)
        rba = pixel_state.get("ref_boost_a", ref_boost_a)
        rbm = pixel_state.get("ref_boost_mask", ref_boost_mask)

        if src_images is not None and pxe is not None and len(src_images) > 0:
            # 像素路径: 按目标分辨率编码源图（防模糊）
            xx = _to_4d(x)
            Hh, Ww = xx.shape[-2], xx.shape[-1]
            src = []
            for i, img in enumerate(src_images):
                lat = _fit_encode_image(img, pxe, Hh, Ww, pixel_state["px_cache"], (str(i), Hh, Ww), fmode)
                src.append(base_model.process_latent_in(lat))
            ref_native = (fmode == "fit")
            pos_mode = ("stride1" if fmode == "fit" else "anchor")
        elif src_latents is not None and len(src_latents) > 0:
            # latent fallback: 与目标同网格（detailer 场景 source==target 初始 latent）
            src = [base_model.process_latent_in(_to_4d(sl)) for sl in src_latents]
            ref_native = False
            pos_mode = "anchor"
        else:
            return orig_forward(x, timesteps, context, attention_mask=attention_mask,
                                transformer_options=transformer_options, **kwargs)

        return krea2_edit_forward(dit, x, timesteps, context, src, transformer_options,
                                  ref_boost=rb, ref_boost_a=rba, ref_boost_mask=rbm,
                                  ref_native=ref_native, pos_mode=pos_mode)

    m.add_object_patch("diffusion_model.forward", forward)
    return m


def pre_encode_sources(pixel_state, Hh, Ww):
    """采样前预热像素路径 px_cache（对齐参考 target_latent 的预编码用途）。

    在采样循环外 VAE 编码源图，避免 mid-sampling VAE 加载驱逐扩散模型
    （参考警告: 'the VAE is pulled onto the GPU mid-sampling and can evict
    part of the diffusion model, slowing every remaining step'）。
    Hh/Ww 为目标 latent 网格尺寸（samples.shape[-2:]）。
    """
    src_images = pixel_state.get("source_images") if pixel_state else None
    pxe = pixel_state.get("vae") if pixel_state else None
    if not src_images or pxe is None:
        return
    fmode = pixel_state.get("fit_mode", "crop")
    for i, img in enumerate(src_images):
        _fit_encode_image(img, pxe, Hh, Ww, pixel_state["px_cache"], (str(i), Hh, Ww), fmode)
    print(f"[Krea2] pre-encoded {len(src_images)} source(s) at target {Hh * 8}x{Ww * 8}px "
          f"(before sampling, fit_mode={fmode})", flush=True)


# ====================== 条件编码 (grounded encode) ======================

def get_conditioning(self, mode, clip, vae, prompt, reference_latent, reference_image, reference, conditioning_set_values, VAEDecode):
    """Krea2: grounded encode（纯语义路径，对齐 Krea2EditGroundedEncode）。

    prompt + 源图经 Qwen3-VL（vision tokens + system prompt 模板）；
    negative = 空 prompt + 同图（训练 unconditional）。
    外观路径（source patch）由 model patch 的 pixel_state 承担，
    conditioning 不携带任何 latent —— 对齐参考节点数据流分离设计。
    """
    grounding_px = self.config.get("grounding_px", GROUNDING_PX_DEFAULT) if self.config else GROUNDING_PX_DEFAULT
    system_prompt = self.config.get("krea2_system_prompt", "") if self.config else ""
    sp = system_prompt.strip() if system_prompt else SYSTEM_PROMPT_DEFAULT

    images_vl = []
    source_images_pixel = []  # 像素空间源图（side-channel 写入 pixel_state）

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

        # 像素路径源图（原始分辨率，forward 时按目标分辨率裁剪+编码）
        source_images_pixel.append(reference_image[:, :, :, :3])

    # 处理额外参考潜空间 (来自 ReferenceImageNode / ReferenceLatentNode / context_reference)
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

        # 像素路径源图
        source_images_pixel.append(decoded[:, :, :, :3])

    if len(images_vl) > 0:
        print(f"[Reference] Krea2: {len(images_vl)} reference image(s) -> grounded encode")

    # side-channel: 像素源图写入 pixel_state（主 SamplerNode 的 edit 入口；
    # snapshot 节点随后做节点级覆盖写 + 预编码）
    pixel_state = self.model.model_options.get("_krea2_pixel_state", None) if self.model is not None else None
    if pixel_state is not None and pixel_state.get("vae") is not None and len(source_images_pixel) > 0:
        pixel_state["source_images"] = source_images_pixel
        pixel_state["px_cache"].clear()
        print(f"[Krea2] pixel path: {len(source_images_pixel)} source image(s) stored for forward-time encoding")

    # 构建 grounded encode 模板 (带 system prompt)
    nimg = len(images_vl)
    vis = "<|vision_start|><|image_pad|><|vision_end|>" * nimg
    template = ("<|im_start|>system\n" + sp + "<|im_end|>\n<|im_start|>user\n"
                + vis + "{}<|im_end|>\n<|im_start|>assistant\n")

    # CFG negative grounding: 训练的 unconditional = 空 prompt + 同图。
    # 对齐 Krea2EditGroundedEncode 的用法: "ground the NEGATIVE too:
    # empty prompt, same image (matches training's unconditional)"。
    # negative prompt 文本仅在无图可 ground 时保留 (text-only fallback)。
    encode_prompt = "" if (mode == 'negative' and nimg > 0) else prompt
    tokens = clip.tokenize(encode_prompt, images=images_vl, llama_template=template)
    condition = clip.encode_from_tokens_scheduled(tokens)

    return condition
