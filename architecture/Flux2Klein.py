from nodes import CLIPTextEncode


def apply_model_patch(model_patcher):
    """Flux2Klein: 不需要 model patch，reference_latents 直接由模型原生支持。"""
    return model_patcher


def get_conditioning(self, mode, clip, vae, prompt, reference_latent, reference_image, reference, conditioning_set_values, VAEDecode):
    """Flux2Klein: 原有逻辑，reference_latents 直接附加到 conditioning。"""
    cache_key = (id(clip), prompt)

    if cache_key in self._conditioning_cache:
        print(f"✓ Conditioning cache hit")
        condition = self._conditioning_cache[cache_key]
    else:
        print(f"x Conditioning cache miss")
        condition = CLIPTextEncode().encode(clip=clip, text=prompt)[0]
        self._conditioning_cache[cache_key] = condition

    if reference_latent is not None:
        condition = conditioning_set_values(condition, {"reference_latents": [reference_latent["samples"]]}, append=True)
        print(f"[Reference] Flux2Klein: 1 current latent attached")

    if reference.reference_latents is not None:
        for lat in reference.reference_latents:
            condition = conditioning_set_values(condition, {"reference_latents": [lat["samples"]]}, append=True)
        if len(reference.reference_latents) > 0:
            print(f"[Reference] Flux2Klein: {len(reference.reference_latents)} reference latent(s) attached")

    return condition
