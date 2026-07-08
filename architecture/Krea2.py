import math
import torch
import comfy
import comfy.conds
import comfy.ldm.common_dit
import comfy.utils


VLM_MAX_PIXELS = 384 * 384
REF_LATENT_MAX_PIXELS = 1024 * 1024
REF_SNAP = 16


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
    """对 Krea2 模型做 reference latent patch（index_timestep_zero 方法）。"""
    from einops import rearrange
    from comfy.ldm.flux.layers import timestep_embedding

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

    def _block_ref_forward(block, x, vec, refvec, split, freqs, transformer_options):
        m_ = block.mod(vec)
        r_ = block.mod(refvec)

        def mod(h, scale, shift):
            return torch.cat(
                (
                    (1 + m_[scale]) * h[:, :split] + m_[shift],
                    (1 + r_[scale]) * h[:, split:] + r_[shift],
                ),
                dim=1,
            )

        def gate(h, g):
            return torch.cat((m_[g] * h[:, :split], r_[g] * h[:, split:]), dim=1)

        x = x + gate(
            block.attn(
                mod(block.prenorm(x), 0, 1),
                freqs,
                None,
                transformer_options=transformer_options,
            ),
            2,
        )
        x = x + gate(block.mlp(mod(block.postnorm(x), 3, 4)), 5)
        return x

    def _forward_with_refs(self, x, timesteps, context, ref_latents, transformer_options):
        temporal = x.ndim == 5
        if temporal:
            b5, c5, t5, h5, w5 = x.shape
            x = x.reshape(b5 * t5, c5, h5, w5)
        bs, c, H_orig, W_orig = x.shape
        patch = self.patch
        x = comfy.ldm.common_dit.pad_to_patch_size(x, (patch, patch))
        H, W = x.shape[-2], x.shape[-1]
        h_, w_ = H // patch, W // patch
        device = x.device

        context = self._unpack_context(context)

        img = rearrange(x, "b c (h ph) (w pw) -> b (h w) (c ph pw)", ph=patch, pw=patch)

        ref_tokens = []
        ref_pos = []
        for i, ref in enumerate(ref_latents):
            if ref.ndim == 5:
                rb, rc, rt, rh5, rw5 = ref.shape
                ref = ref.reshape(rb * rt, rc, rh5, rw5)
            ref = comfy.ldm.common_dit.pad_to_patch_size(
                ref.to(device, x.dtype), (patch, patch)
            )
            ref = comfy.utils.repeat_to_batch_size(ref, bs)
            rh, rw = ref.shape[-2] // patch, ref.shape[-1] // patch
            ref_tokens.append(
                rearrange(ref, "b c (h ph) (w pw) -> b (h w) (c ph pw)", ph=patch, pw=patch)
            )
            rid = torch.zeros(rh, rw, 3, device=device, dtype=torch.float32)
            rid[..., 0] = i + 1.0
            rid[..., 1] = torch.arange(rh, device=device, dtype=torch.float32)[:, None]
            rid[..., 2] = torch.arange(rw, device=device, dtype=torch.float32)[None, :]
            ref_pos.append(rid.reshape(1, rh * rw, 3).repeat(bs, 1, 1))
        reftok = torch.cat(ref_tokens, dim=1)
        refpos = torch.cat(ref_pos, dim=1)
        reflen = reftok.shape[1]

        img = self.first(torch.cat((img, reftok), dim=1))

        t = self.tmlp(timestep_embedding(timesteps, self.tdim).unsqueeze(1).to(img.dtype))
        tvec = self.tproj(t)
        t0 = self.tmlp(
            timestep_embedding(torch.zeros_like(timesteps), self.tdim)
            .unsqueeze(1)
            .to(img.dtype)
        )
        tvec0 = self.tproj(t0)

        context = self.txtfusion(
            context, mask=None, transformer_options=transformer_options
        )
        context = self.txtmlp(context)

        txtlen, imglen = context.shape[1], img.shape[1]
        combined = torch.cat((context, img), dim=1)
        split = txtlen + imglen - reflen

        txtpos = torch.zeros(bs, txtlen, 3, device=device, dtype=torch.float32)
        imgids = torch.zeros(h_, w_, 3, device=device, dtype=torch.float32)
        imgids[..., 1] = torch.arange(h_, device=device, dtype=torch.float32)[:, None]
        imgids[..., 2] = torch.arange(w_, device=device, dtype=torch.float32)[None, :]
        imgpos = imgids.reshape(1, h_ * w_, 3).repeat(bs, 1, 1)
        pos = torch.cat((txtpos, imgpos, refpos), dim=1)

        freqs = self.pe_embedder(pos)

        for block in self.blocks:
            combined = _block_ref_forward(
                block, combined, tvec, tvec0, split, freqs, transformer_options
            )

        final = self.last(combined, t)
        out = final[:, txtlen:split, :]
        out = rearrange(
            out,
            "b (h w) (c ph pw) -> b c (h ph) (w pw)",
            h=h_,
            w=w_,
            ph=patch,
            pw=patch,
            c=self.channels,
        )
        out = out[:, :, :H_orig, :W_orig]
        if temporal:
            out = out.reshape(b5, t5, self.channels, H_orig, W_orig).movedim(1, 2)
        return out

    def forward(x, timesteps, context, attention_mask=None, transformer_options={}, ref_latents=None, **kwargs):
        if ref_latents is None or len(ref_latents) == 0:
            return orig_forward(x, timesteps, context, attention_mask=attention_mask, transformer_options=transformer_options, **kwargs)
        return _forward_with_refs(dit, x, timesteps, context, ref_latents, transformer_options)

    m.add_object_patch("extra_conds", extra_conds)
    m.add_object_patch("extra_conds_shapes", extra_conds_shapes)
    m.add_object_patch("diffusion_model.forward", forward)
    return m


def get_conditioning(self, mode, clip, vae, prompt, reference_latent, reference_image, reference, conditioning_set_values, VAEDecode):
    """Krea2: VLM 编码 + 参考潜空间。返回 (condition, ) 或 None 表示不匹配。"""
    from comfy.text_encoders.krea2 import KREA2_TEMPLATE

    images_vl = []
    ref_latents = []
    image_prompt = ""

    if reference_image is not None:
        samples = reference_image.movedim(-1, 1)
        images_vl.append(_fit_area(samples, VLM_MAX_PIXELS).movedim(1, -1))
        if vae is not None:
            s = _fit_area(samples, REF_LATENT_MAX_PIXELS, snap=REF_SNAP)
            ref_latents.append(vae.encode(s.movedim(1, -1)[:, :, :, :3]))
        image_prompt += "Picture {}: <|vision_start|><|image_pad|><|vision_end|>".format(len(images_vl))

    for lat in reference.reference_latents:
        samples = lat["samples"]
        decoded = VAEDecode().decode(vae=vae, samples={"samples": samples})[0]
        s = decoded.movedim(-1, 1)
        images_vl.append(_fit_area(s, VLM_MAX_PIXELS).movedim(1, -1))
        ref_latents.append(vae.encode(_fit_area(s, REF_LATENT_MAX_PIXELS, snap=REF_SNAP).movedim(1, -1)[:, :, :, :3]))
        image_prompt += "Picture {}: <|vision_start|><|image_pad|><|vision_end|>".format(len(images_vl))

    if len(images_vl) > 0:
        print(f"[Reference] Krea2: {len(images_vl)} reference image(s) -> VLM encode + VAE re-encode")

    tokens = clip.tokenize(
        image_prompt + prompt, images=images_vl, llama_template=KREA2_TEMPLATE
    )
    condition = clip.encode_from_tokens_scheduled(tokens)

    if len(ref_latents) > 0:
        condition = conditioning_set_values(
            condition, {"reference_latents": ref_latents}, append=True
        )

    return condition
