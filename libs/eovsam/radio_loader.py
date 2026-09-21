# -*- coding: utf-8 -*-
"""
RADIO (c-radio_v4-h) 加载器 + SAM3 视觉编码器替换。

改编自:
- NVlabs/RADIO hubconf.py 的 radio_model()
- EOVSAM sam3/RADIOwrapper.py

差异:
- 不经过 torch.hub(source='local')，直接使用 vendored radio 包
- RADIO_Adaptor 输出不再强制 .float()，以支持整体 bf16/fp16 推理
"""
import math
import warnings
from typing import Dict, Any, List, Optional

import torch
from torch import nn
from torch.hub import load_state_dict_from_url

from timm.models import clean_state_dict

from .radio.adaptor_registry import adaptor_registry
from .radio.common import RadioResource, RESOURCE_MAP
from .radio.enable_damp import configure_damp_from_args
from .radio.enable_spectral_reparam import (
    disable_spectral_reparam,
    configure_spectral_reparam_from_args,
)
from .radio.feature_normalizer import FeatureNormalizer, IntermediateFeatureNormalizer
from .radio.radio_model import RADIOModel, create_model_from_args
from .radio.input_conditioner import get_default_conditioner


def _get_prefix_state_dict(state_dict: Dict[str, Any], prefix: str):
    return {k[len(prefix):]: v for k, v in state_dict.items() if k.startswith(prefix)}


def load_radio_model(
    version: str = "c-radio_v4-h",
    device: str = "cuda",
    adaptor_names: Optional[List[str]] = None,
    num_prompts_to_insert: int = 5,  # EOVSAM config.py 默认值，与 eovsam.pth 的 tuner.prompts [32,5,1280] 对齐
    insert_start_layer: int = 1,
    insert_end_layer: int = -1,
) -> RADIOModel:
    """从 NVlabs 发布的 URL 加载 RADIO 模型（缓存于 torch hub 目录）。"""
    if adaptor_names is None:
        adaptor_names = ["sam3", "siglip2-g", "dino_v3_7b"]

    resource = RESOURCE_MAP[version]
    print(f"[EOVSAM] Downloading/loading RADIO '{version}' from {resource.url} ...")
    chk = load_state_dict_from_url(
        resource.url, progress=True, map_location="cpu", weights_only=False,
    )

    if "state_dict_ema" in chk:
        state_dict = chk["state_dict_ema"]
        chk["args"].spectral_reparam = False
        chk["args"].spectral_heads = False
        chk["args"].damp = None
    else:
        state_dict = chk["state_dict"]

    args = chk["args"]
    mod = create_model_from_args(args)

    mod_state_dict = _get_prefix_state_dict(state_dict, "base_model.")

    if args.spectral_reparam:
        configure_spectral_reparam_from_args(
            mod, args, state_dict_guidance=mod_state_dict
        )

    if getattr(args, "damp", None):
        configure_damp_from_args(mod, args)

    state_dict = clean_state_dict(state_dict)

    key_warn = mod.load_state_dict(mod_state_dict, strict=False)
    if key_warn.missing_keys:
        warnings.warn(f"RADIO missing keys: {key_warn.missing_keys}")
    if key_warn.unexpected_keys:
        warnings.warn(f"RADIO unexpected keys: {key_warn.unexpected_keys}")

    if chk["args"].spectral_reparam:
        disable_spectral_reparam(mod)
        chk["args"].spectral_reparam = False

    conditioner = get_default_conditioner()
    conditioner.load_state_dict(_get_prefix_state_dict(state_dict, "input_conditioner."))

    dtype = getattr(chk["args"], "dtype", torch.float32)
    mod.to(dtype=dtype)
    conditioner.dtype = dtype

    cls_token_per_teacher = getattr(chk["args"], "cls_token_per_teacher", True)
    if cls_token_per_teacher:
        name_to_idx_map = dict()
        for i, t in enumerate(chk["args"].teachers):
            if t.get("use_summary", True):
                name = t["name"]
                if name not in name_to_idx_map:
                    name_to_idx_map[name] = i
        summary_idxs = torch.tensor(sorted(name_to_idx_map.values()), dtype=torch.int64)
    else:
        summary_idxs = torch.tensor([0], dtype=torch.int64)

    teachers = chk["args"].teachers
    adaptors = dict()
    for adaptor_name in adaptor_names:
        for tidx, tconf in enumerate(teachers):
            if tconf["name"] == adaptor_name:
                break
        else:
            raise ValueError(
                f"Unable to find adaptor '{adaptor_name}'. Known: "
                f"{list(t['name'] for t in teachers)}"
            )

        ttype = tconf["type"]
        pf_idx_head = f"_heads.{tidx}"
        pf_name_head = f"_heads.{adaptor_name}"
        pf_idx_feat = f"_feature_projections.{tidx}"
        pf_name_feat = f"_feature_projections.{adaptor_name}"

        adaptor_state = dict()
        for k, v in state_dict.items():
            if k.startswith(pf_idx_head):
                adaptor_state["summary" + k[len(pf_idx_head):]] = v
            elif k.startswith(pf_name_head):
                adaptor_state["summary" + k[len(pf_name_head):]] = v
            elif k.startswith(pf_idx_feat):
                adaptor_state["feature" + k[len(pf_idx_feat):]] = v
            elif k.startswith(pf_name_feat):
                adaptor_state["feature" + k[len(pf_name_feat):]] = v

        adaptor = adaptor_registry.create_adaptor(ttype, chk["args"], tconf, adaptor_state)

        if cls_token_per_teacher:
            token_slot = tconf.get("token_slot", tidx)
        else:
            token_slot = 0

        adaptor.head_idx = token_slot
        adaptors[adaptor_name] = adaptor

    feat_norm_sd = _get_prefix_state_dict(state_dict, "_feature_normalizer.")
    feature_normalizer = None
    if feat_norm_sd:
        feature_normalizer = FeatureNormalizer(feat_norm_sd["mean"].shape[0], dtype=dtype)
        feature_normalizer.load_state_dict(feat_norm_sd)

    inter_feat_norm_sd = _get_prefix_state_dict(state_dict, "_intermediate_feature_normalizer.")
    inter_feature_normalizer = None
    if inter_feat_norm_sd:
        inter_feature_normalizer = IntermediateFeatureNormalizer(
            *inter_feat_norm_sd["means"].shape[:2],
            rot_per_layer=inter_feat_norm_sd["rotation"].ndim == 3,
            dtype=dtype,
        )
        inter_feature_normalizer.load_state_dict(inter_feat_norm_sd)

    radio = RADIOModel(
        mod,
        conditioner,
        summary_idxs=summary_idxs,
        patch_size=resource.patch_size,
        max_resolution=resource.max_resolution,
        window_size=None,
        preferred_resolution=resource.preferred_resolution,
        adaptors=adaptors,
        feature_normalizer=feature_normalizer,
        inter_feature_normalizer=inter_feature_normalizer,
        num_prompts_to_insert=num_prompts_to_insert,
        insert_start_layer=insert_start_layer,
        insert_end_layer=insert_end_layer,
    )
    radio = radio.to(device)
    radio.eval()
    print("[EOVSAM] RADIO model loaded.")
    return radio


class RADIO_Adaptor(nn.Module):
    """用 RADIO student 特征替换 SAM3 的 ViT trunk。"""

    def __init__(self, student: nn.Module, input_size, output_channels: int):
        super().__init__()
        self.student = student
        self.input_size = (
            input_size if isinstance(input_size, (tuple, list)) else (input_size, input_size)
        )
        # SAM3 的 ViT 有 channel_list 属性供 neck 使用
        self.channel_list = [output_channels]
        self.sig2_adaptor = self.student.adaptors["siglip2-g"]

    @torch.no_grad()
    def get_text_classifier(self, text_list, device):
        text_input = self.sig2_adaptor.tokenizer(text_list).to(device)
        text_tokens = self.sig2_adaptor.encode_text(text_input, normalize=True)
        return text_tokens

    @torch.no_grad()
    def forward(self, images: torch.Tensor):
        # 输入归一化到 [0, 1]（SAM3 用 [-1,1] 约定）
        images = (images + 1) / 2

        student_dtype = next(self.student.parameters()).dtype
        # 输入对齐 student dtype（half ckpt 为 bf16；整体 cast 后为对应精度），否则 embedder 线性层混精度崩溃
        if images.dtype != student_dtype:
            images = images.to(student_dtype)

        # 仅当 student 为 fp32 时启用 bf16 autocast（half ckpt / 已 cast 的模型直接原生精度运行）
        use_autocast = images.is_cuda and student_dtype == torch.float32
        with torch.autocast("cuda", dtype=torch.bfloat16, enabled=use_autocast):
            student_output = self.student(images)
            if isinstance(student_output, dict):
                features = student_output["sam3"][1]
                dino_features = student_output["dino_v3_7b"][1]
            _, backbone_features = student_output["backbone"]
            sig2_vis_features = self.sig2_adaptor.head_mlp(backbone_features)
            del student_output
            del backbone_features

        patch_size = int(
            round(math.sqrt(images.shape[-2] * images.shape[-1] / features.shape[1]))
        )
        rows = images.shape[-2] // patch_size
        cols = images.shape[-1] // patch_size

        from einops import rearrange

        features = rearrange(features, "b (r c) d -> b d r c", r=rows, c=cols)
        sig2_vis_features = rearrange(sig2_vis_features, "b (r c) d -> b d r c", r=rows, c=cols)
        dino_features = rearrange(dino_features, "b (r c) d -> b d r c", r=rows, c=cols)

        # 输出 dtype 对齐 SAM3 neck 权重（支持整体 bf16/fp16/fp32 推理）
        neck = getattr(self, "_neck_ref", None)
        if neck is not None:
            out_dtype = next(neck.parameters()).dtype
            if out_dtype != features.dtype:
                features = features.to(out_dtype)
                sig2_vis_features = sig2_vis_features.to(out_dtype)
                dino_features = dino_features.to(out_dtype)

        other_output = {
            "siglip2-g": {"features": sig2_vis_features},
            "dino_v3_7b": {"features": dino_features},
        }
        return [other_output, features]


def replace_sam3_encoder(sam3_model, radio_model, device: str = "cuda"):
    """把 SAM3 的视觉编码器 trunk 替换为 RADIO Adaptor。"""
    original_encoder = sam3_model.backbone.vision_backbone
    sam3_dim = original_encoder.trunk.patch_embed.proj.out_channels
    adaptor = RADIO_Adaptor(
        student=radio_model,
        input_size=1152,
        output_channels=sam3_dim,
    )
    # 引用 neck（绕过 nn.Module 注册，避免参数双重注册/state_dict 键污染），用于 forward 时对齐输出 dtype
    object.__setattr__(adaptor, "_neck_ref", original_encoder)
    sam3_model.backbone.vision_backbone.trunk = adaptor
    return sam3_model, adaptor
