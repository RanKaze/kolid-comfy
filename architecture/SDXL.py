import torch
import comfy


def apply_model_patch(model_patcher):
    """对 SDXL UNet 做 reference-only attention patch：
    在采样前将参考图 latent 在 t=0 下跑一次 forward，收集每层 self-attention 的 k/v，
    在主 forward 时拼接到当前层的 k/v 上。"""
    m = model_patcher.clone()

    ref_cache = {}

    def attn1_patch(q, k, v, extra_options):
        block = extra_options.get("block", ("", 0))
        idx = extra_options.get("transformer_index", 0)
        key = (str(block), idx)
        if key in ref_cache:
            ref_k, ref_v = ref_cache[key]
            k = torch.cat([k, ref_k.to(k.device, k.dtype)], dim=1)
            v = torch.cat([v, ref_v.to(v.device, v.dtype)], dim=1)
        return q, k, v

    def capture_attn1_patch(q, k, v, extra_options):
        block = extra_options.get("block", ("", 0))
        idx = extra_options.get("transformer_index", 0)
        key = (str(block), idx)
        ref_cache[key] = (k.clone().cpu(), v.clone().cpu())
        return q, k, v

    base_model = m.model
    orig_extra_conds = base_model.extra_conds

    def extra_conds(**kwargs):
        out = orig_extra_conds(**kwargs)
        ref_latents = kwargs.get("reference_latents", None)
        if ref_latents is not None and len(ref_latents) > 0:
            ref_cache.clear()
            m.set_model_attn1_patch(capture_attn1_patch)
            try:
                for ref_lat in ref_latents:
                    ref_samples = base_model.process_latent_in(ref_lat)
                    zero_t = torch.zeros((ref_samples.shape[0],), device=ref_samples.device, dtype=ref_samples.dtype)
                    with torch.no_grad():
                        base_model.predict_noise(ref_samples, zero_t, {}, **{"reference_latents": None})
            finally:
                m.set_model_attn1_patch(attn1_patch)
        return out

    m.set_model_attn1_patch(attn1_patch)
    m.add_object_patch("extra_conds", extra_conds)
    return m


def get_conditioning(self, mode, clip, vae, prompt, reference_latent, reference_image, reference, conditioning_set_values, VAEDecode):
    """SDXL: concat_latent 或 reference_latents（取决于 enable_edit）。"""
    from nodes import CLIPTextEncode

    cache_key = (id(clip), prompt)

    if cache_key in self._conditioning_cache:
        print(f"✓ Conditioning cache hit")
        condition = self._conditioning_cache[cache_key]
    else:
        print(f"x Conditioning cache miss")
        condition = CLIPTextEncode().encode(clip=clip, text=prompt)[0]
        self._conditioning_cache[cache_key] = condition

    ref_latents = []
    if reference_latent is not None:
        ref_latents.append(reference_latent["samples"])
    for lat in reference.reference_latents:
        ref_latents.append(lat["samples"])

    if self.config.get("enable_edit") and len(ref_latents) > 0:
        condition = conditioning_set_values(condition, {"reference_latents": ref_latents}, append=True)
        print(f"[Reference] SDXL: {len(ref_latents)} reference latent(s) -> reference_latents")
    elif len(ref_latents) > 0:
        condition = conditioning_set_values(condition, {"concat_latent": {"samples": ref_latents[0]}})
        print(f"[Reference] SDXL: {len(ref_latents)} reference latent(s) -> concat_latent")

    return condition
