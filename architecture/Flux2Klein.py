from nodes import CLIPTextEncode


def apply_model_patch(model_patcher):
    """Flux2Klein: 不需要 model patch，reference_latents 直接由模型原生支持。"""
    return model_patcher


def get_conditioning(self, mode, clip, vae, prompt, reference_latent, reference_image, reference, conditioning_set_values, VAEDecode):
    """Flux2Klein: 原有逻辑，reference_latents 直接附加到 conditioning。"""
    has_ref = (reference_latent is not None) or (reference.reference_latents and len(reference.reference_latents) > 0)

    # 文本编码走跨 run memo（ref 附加在其后，不污染 memo 值）
    condition = self.memo_text_encode(
        'flux2klein', prompt, None,
        lambda: CLIPTextEncode().encode(clip=clip, text=prompt)[0])

    # 有 reference 时深拷贝，避免追加 reference_latents 污染缓存
    if has_ref:
        import copy
        condition = copy.deepcopy(condition)

    if reference_latent is not None:
        condition = conditioning_set_values(condition, {"reference_latents": [reference_latent["samples"]]}, append=True)
        print(f"[Reference] Flux2Klein: 1 current latent attached")

    if reference.reference_latents is not None:
        for lat in reference.reference_latents:
            condition = conditioning_set_values(condition, {"reference_latents": [lat["samples"]]}, append=True)
        if len(reference.reference_latents) > 0:
            print(f"[Reference] Flux2Klein: {len(reference.reference_latents)} reference latent(s) attached")

    return condition
