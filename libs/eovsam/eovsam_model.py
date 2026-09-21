# -*- coding: utf-8 -*-
"""
EOVSAM3 推理封装（论文 hustvl/EOVSAM 的 ComfyUI 移植版，仅推理）。

流程（对应 EOVSAM.py 的 eval 路径 + configs/eval_semantic.yaml）:
  1. 构建 SAM3 图像模型（eval_only），用 RADIO c-radio_v4-h 替换视觉 trunk
  2. 加载 eovsam.pth（含 EOVSAM 附加头: pixel_proj / cdt / void_embedding /
     cross_attn_head_pool_logits / attn_pool_logit_scale / logit_scale / out_vocab_logit_scale）
  3. detect(): 双路文本编码（SAM3 text encoder + SigLIP2-g VILD 模板），
     单次前向，按实例返回软 mask 与类别
"""
import logging
import os
from typing import Dict, List, Optional, Tuple

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

from .radio_loader import load_radio_model, replace_sam3_encoder

logger = logging.getLogger("kolid-comfy.eovsam")

# eval_semantic.yaml 关键配置
VILD_PROMPT = [
    "a photo of a {}.",
    "This is a photo of a {}",
    "There is a {} in the scene",
    "There is the {} in the scene",
    "a photo of a {} in the scene",
    "a photo of a small {}.",
    "a photo of a medium {}.",
    "a photo of a large {}.",
    "This is a photo of a small {}.",
    "This is a photo of a medium {}.",
    "This is a photo of a large {}.",
    "There is a small {} in the scene.",
    "There is a medium {} in the scene.",
    "There is a large {} in the scene.",
]
SAM_PROMPT = ["{}"]

TEXT_ENCODER_BS = 128


class MaskPooling(nn.Module):
    """来自 maft fcclip_transformer_decoder 的 MaskPooling。"""

    def forward(self, x, mask):
        # x: [B, C, H, W], mask: [B, Q, H, W]
        if not x.shape[-2:] == mask.shape[-2:]:
            mask = F.interpolate(mask, size=x.shape[-2:], mode="bilinear", align_corners=False)
        with torch.no_grad():
            mask = mask.detach()
            mask = (mask > 0).to(mask.dtype)
            denorm = mask.sum(dim=(-1, -2), keepdim=True) + 1e-8
        return torch.einsum("bchw,bqhw->bqc", x, mask / denorm)


def get_classification_logits(x, text_classifier, logit_scale, num_templates=None):
    """来自 EOVSAM.py 的 get_classification_logits。"""
    text_classifier = F.normalize(text_classifier, dim=-1)
    x = F.normalize(x, dim=-1)
    logit_scale = torch.clamp(logit_scale.exp(), max=100)
    if len(text_classifier.shape) == 2:
        pred_logits = logit_scale * x @ text_classifier.T
    else:
        pred_logits = logit_scale * x @ text_classifier.permute(0, 2, 1)

    final_pred_logits = []
    cur_idx = 0
    for num_t in num_templates:
        final_pred_logits.append(pred_logits[:, :, cur_idx: cur_idx + num_t].max(-1).values)
        cur_idx += num_t
    return torch.stack(final_pred_logits, dim=-1)


class EovsamModel(nn.Module):
    """EOVSAM 模型（推理用，结构与官方 EOVSAM meta-arch 的参数命名一致以便加载 eovsam.pth）。"""

    def __init__(self, bpe_path: str, device: str = "cuda"):
        super().__init__()
        from .eovsam_sam3 import model_builder as mb
        from .eovsam_sam3.model.content_dependent_transfer import ContentDependentTransfer
        from .eovsam_sam3.model.data_misc import FindStage  # noqa: F401 (re-export)

        self.device_type = device
        self.register_buffer("pixel_mean", torch.Tensor([127.5, 127.5, 127.5]).view(-1, 1, 1), False)
        self.register_buffer("pixel_std", torch.Tensor([127.5, 127.5, 127.5]).view(-1, 1, 1), False)

        # ---- SAM3 detector ----
        vision_encoder = mb._create_vision_backbone(enable_inst_interactivity=False)
        text_encoder = mb._create_text_encoder(bpe_path)
        backbone = mb._create_vl_backbone(vision_encoder, text_encoder)
        transformer = mb._create_sam3_transformer(use_gate=False)
        dot_prod_scoring = mb._create_dot_product_scoring()
        segmentation_head = mb._create_segmentation_head()
        input_geometry_encoder = mb._create_geometry_encoder()
        self.detector = mb._create_sam3_model(
            backbone, transformer, input_geometry_encoder,
            segmentation_head, dot_prod_scoring, None, True,
        )
        self.detector.eval()

        # ---- RADIO ----
        radio_model = load_radio_model(
            "c-radio_v4-h",
            device="cpu",  # 先在 CPU 上构建，加载 eovsam.pth 后再统一搬运
            num_prompts_to_insert=5,  # 与 checkpoint 的 tuner.prompts [32,5,1280] 对齐（config.py 默认）
            insert_start_layer=1,
            insert_end_layer=-1,
        )
        self.detector, self.radio_adaptor = replace_sam3_encoder(self.detector, radio_model, device="cpu")
        # VPT.ENABLE=False -> 提示 token 不激活
        radio_blocks = getattr(getattr(self.radio_adaptor, "student", None), "model", None)
        radio_blocks = getattr(radio_blocks, "blocks", None)
        if hasattr(radio_blocks, "is_active"):
            radio_blocks.is_active = False
        if hasattr(radio_blocks, "grad_checkpointing"):
            radio_blocks.grad_checkpointing = False

        # ---- EOVSAM 附加头（参数名与官方 checkpoint 一致）----
        self.use_pe_text = False
        self.use_cos_sim = True
        self.out_vocab_logit_scale = None

        self.use_query_proj = False
        self.query_proj = None

        self.use_pixel_proj = True
        self.pixel_proj = nn.Linear(256, 256)

        self.num_decoder_layers = len(self.detector.transformer.decoder.layers)
        self.num_decoder_cross_attn_heads = (
            self.detector.transformer.decoder.layers[0].cross_attn.num_heads
        )
        self.cross_attn_head_pool_logits = nn.Parameter(
            torch.zeros(self.num_decoder_layers, self.num_decoder_cross_attn_heads)
        )

        self.num_cdt = 1
        self.cdt = ContentDependentTransfer(d_model=1536, nhead=8, panoptic_on=False)
        self.out_vocab_logit_scale = nn.Parameter(torch.ones([]) * np.log(1 / 0.07))

        self.mask_pooling = MaskPooling()

        # ATTNPOOL
        self.use_attnpool = True
        self.attn_pool_logit_scale = nn.Parameter(torch.ones([]) * np.log(1))

        # 分类超参（eval_semantic.yaml）
        self.use_softmax = True
        self.void_embedding = nn.Embedding(1, 256)
        self.logit_scale = nn.Parameter(torch.ones([]) * np.log(1 / 0.07))

        self.add_pixelfeat = True
        self.alpha = 0.7
        self.beta = 1.0

        self.PROMPT = VILD_PROMPT
        self.SAM_PROMPT = SAM_PROMPT

        # 文本编码缓存（key = 词表元组）
        self._sam_cache: Dict[tuple, dict] = {}
        self._siglip_cache: Dict[tuple, dict] = {}
        self.SAM_language_features = None
        self.SAM_language_mask = None

    # ---------------- checkpoint ----------------

    def load_eovsam_checkpoint(self, checkpoint_path: str):
        print(f"[EOVSAM] Loading checkpoint: {checkpoint_path}")
        ckpt = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
        if "model" in ckpt and isinstance(ckpt["model"], dict):
            sd = ckpt["model"]
        else:
            sd = ckpt
        missing, unexpected = self.load_state_dict(sd, strict=False)
        # 只报告关键模块的缺失
        key_missing = [k for k in missing if k.startswith(("detector.transformer", "detector.backbone.text", "pixel_proj", "cdt", "void_embedding", "cross_attn_head_pool_logits", "attn_pool_logit_scale", "logit_scale", "out_vocab_logit_scale"))]
        if key_missing:
            print(f"[EOVSAM] WARNING missing keys ({len(key_missing)}): {key_missing[:10]}")
        if unexpected:
            print(f"[EOVSAM] {len(unexpected)} unexpected keys (ignored)")
        n_loaded = sum(1 for k in sd if k in dict(self.named_parameters()) or k in dict(self.named_buffers()))
        print(f"[EOVSAM] Checkpoint loaded: {n_loaded}/{len(sd)} entries mapped")

    # ---------------- 文本编码 ----------------

    def _compress_language_features(self, language_features, language_mask):
        valid_mask = ~language_mask
        valid_lengths = valid_mask.sum(dim=1)
        max_valid_len = int(valid_lengths.max().item()) if valid_lengths.numel() > 0 else 0

        compressed_features = language_features[:, :max_valid_len, :].new_zeros(
            language_features.shape[0], max_valid_len, language_features.shape[-1]
        )
        compressed_mask = torch.ones(
            language_mask.shape[0], max_valid_len,
            dtype=torch.bool, device=language_mask.device,
        )
        for idx in range(language_features.shape[0]):
            curr_len = int(valid_lengths[idx].item())
            if curr_len == 0:
                continue
            compressed_features[idx, :curr_len] = language_features[idx, valid_mask[idx]]
            compressed_mask[idx, :curr_len] = False
        return compressed_features, compressed_mask

    @torch.no_grad()
    def _get_sam_text_classifier(self, class_names: List[str]):
        """SAM3 text encoder 词表编码（SAM_PROMPT=['{}'] 模板），带缓存。"""
        key = tuple(class_names)
        if key in self._sam_cache:
            return self._sam_cache[key]["classifier"], self._sam_cache[key]["num_templates"]

        sam_class_names = [t.format(w) for w in class_names for t in self.SAM_PROMPT]
        num_templates = [len(self.SAM_PROMPT)] * len(class_names)

        text_classifier, text_feat, language_mask = [], [], []
        for idx in range(0, len(sam_class_names), TEXT_ENCODER_BS):
            state_text = self.detector.backbone.forward_text(
                sam_class_names[idx: idx + TEXT_ENCODER_BS], device=self.device
            )
            batch_text_feat = state_text["language_features"].detach()
            mask = state_text["language_mask"]
            batch_text_feat = batch_text_feat.permute(1, 0, 2)
            text_classifier.append(batch_text_feat)
            text_feat.append(batch_text_feat)
            language_mask.append(mask)

        text_classifier = torch.cat(text_classifier, dim=0)
        text_feat = torch.cat(text_feat, dim=0)
        language_mask = torch.cat(language_mask, dim=0)

        text_feat = text_feat.reshape(
            text_feat.shape[0] // len(self.SAM_PROMPT), len(self.SAM_PROMPT),
            text_feat.shape[-2], text_feat.shape[-1],
        )
        text_feat /= (text_feat.norm(dim=-1, keepdim=True) + 1e-6)
        text_feat[language_mask.view(
            text_feat.shape[0], text_feat.shape[1], text_feat.shape[2]
        )] = 0.0
        language_features = text_feat.mean(1)

        text_classifier = text_classifier.reshape(
            text_classifier.shape[0] // len(self.SAM_PROMPT), len(self.SAM_PROMPT),
            text_classifier.shape[-2], text_classifier.shape[-1],
        )
        text_classifier /= (text_classifier.norm(dim=-1, keepdim=True) + 1e-6)
        text_classifier[language_mask.view(
            text_classifier.shape[0], text_classifier.shape[1], text_classifier.shape[2]
        )] = 0.0
        text_classifier = text_classifier.mean(-2)
        text_classifier /= (text_classifier.norm(dim=-1, keepdim=True) + 1e-6)
        text_classifier = text_classifier.mean(1)
        text_classifier /= (text_classifier.norm(dim=-1, keepdim=True) + 1e-6)

        sam_language_mask = torch.min(
            language_mask.view(
                language_features.shape[0], len(self.SAM_PROMPT), language_features.shape[1]
            ), dim=1,
        ).values
        sam_language_features, sam_language_mask = self._compress_language_features(
            language_features.detach(), sam_language_mask
        )

        self._sam_cache[key] = {
            "classifier": text_classifier.detach(),
            "num_templates": num_templates,
            "language_features": sam_language_features,
            "language_mask": sam_language_mask,
        }
        return text_classifier.detach(), num_templates

    @torch.no_grad()
    def _get_siglip_text_classifier(self, class_names: List[str]):
        """SigLIP2-g + VILD 模板词表编码，带缓存。"""
        key = tuple(class_names)
        if key in self._siglip_cache:
            return self._siglip_cache[key]["classifier"], self._siglip_cache[key]["num_templates"]

        templated = [t.format(w) for w in class_names for t in self.PROMPT]
        num_templates = [len(self.PROMPT)] * len(class_names)

        text_classifier = []
        for idx in range(0, len(templated), TEXT_ENCODER_BS):
            batch = self.radio_adaptor.get_text_classifier(
                templated[idx: idx + TEXT_ENCODER_BS], device=self.device
            )
            text_classifier.append(batch)
        # [C*T, D]，class-major 排列（每类连续 T 个模板行）。
        # attnpool 的 get_classification_logits 按类切模板块后取 max，模板维度必须保留，不能平均！
        text_classifier = torch.cat(text_classifier, dim=0)
        text_classifier = F.normalize(text_classifier, dim=-1)

        self._siglip_cache[key] = {
            "classifier": text_classifier.detach(),
            "num_templates": num_templates,
        }
        return text_classifier.detach(), num_templates

    # ---------------- attn pool ----------------

    def _get_cross_attn_head_pool_weights(self, num_layers=None, device=None, dtype=None):
        head_pool_weights = F.softmax(self.cross_attn_head_pool_logits, dim=-1)
        if num_layers is not None:
            head_pool_weights = head_pool_weights[:num_layers]
        if device is not None or dtype is not None:
            head_pool_weights = head_pool_weights.to(
                device=device if device is not None else head_pool_weights.device,
                dtype=dtype if dtype is not None else head_pool_weights.dtype,
            )
        return head_pool_weights

    def _aggregate_cross_attn_weights(self, cross_attn_weights):
        if cross_attn_weights is None:
            raise ValueError("cross_attn_weights is required for attention pooling")
        if cross_attn_weights.dim() == 5:
            head_pool_weights = self._get_cross_attn_head_pool_weights(
                num_layers=cross_attn_weights.shape[0],
                device=cross_attn_weights.device,
                dtype=cross_attn_weights.dtype,
            )
            return torch.einsum("kh,kbhnl->kbnl", head_pool_weights, cross_attn_weights)
        if cross_attn_weights.dim() == 4:
            head_pool_weights = self._get_cross_attn_head_pool_weights(
                device=cross_attn_weights.device,
                dtype=cross_attn_weights.dtype,
            )[-1]
            return torch.einsum("h,bhnl->bnl", head_pool_weights, cross_attn_weights)
        raise ValueError(
            f"Expected cross-attention weights [K, B, H, Q, L] or [B, H, Q, L], got {tuple(cross_attn_weights.shape)}"
        )

    def _compute_attn_pool_cls_logits(self, cross_attn_weights, pool_feature, text_classifier, num_templates):
        pooled_cross_attn_weights = self._aggregate_cross_attn_weights(cross_attn_weights)
        if pooled_cross_attn_weights.dim() == 3:
            pooled_cross_attn_weights = pooled_cross_attn_weights.unsqueeze(0)

        bs = pool_feature.shape[0]
        num_queries = pooled_cross_attn_weights.shape[2]
        radio_img_feat = pool_feature.view(bs, pool_feature.shape[1], -1).permute(0, 2, 1)

        attn_pool_logit_scale = torch.clamp(self.attn_pool_logit_scale.exp(), max=100)
        pooled_cross_attn_weights = (
            torch.log(pooled_cross_attn_weights + 1e-6) * attn_pool_logit_scale
        ).softmax(-1)
        pooled_img_feat = torch.einsum("bld,kbnl->kbnd", radio_img_feat, pooled_cross_attn_weights)

        if text_classifier.dim() == 3:
            attn_cls_results = []
            for b in range(bs):
                attn_cls_result = get_classification_logits(
                    pooled_img_feat[:, b, :, :],
                    text_classifier[b],
                    self.out_vocab_logit_scale,
                    num_templates,
                )
                attn_cls_results.append(attn_cls_result)
            return torch.stack(attn_cls_results, dim=1)

        attn_cls_results = get_classification_logits(
            pooled_img_feat.reshape(-1, num_queries, pooled_img_feat.shape[-1]),
            text_classifier,
            self.out_vocab_logit_scale,
            num_templates,
        )
        return attn_cls_results.view(
            pooled_img_feat.shape[0], bs, num_queries, attn_cls_results.shape[-1],
        )

    # ---------------- 推理 ----------------

    @property
    def device(self):
        return self.pixel_mean.device

    @torch.no_grad()
    def detect(
        self,
        image: torch.Tensor,
        class_names: List[str],
        resolution: int = 1152,
        threshold: float = 0.5,
    ) -> Tuple[List[torch.Tensor], List[str], List[float]]:
        """
        Args:
            image: RGB 图像张量 [H, W, 3] 或 [3, H, W]，float 0-1
            class_names: 类别词表
            resolution: 推理分辨率（须为 16 的倍数，默认 1152）
            threshold: 实例置信度阈值

        Returns:
            (masks, labels, scores): 每实例 [H, W] 二值 mask (0/1)、类别词、置信度
        """
        assert len(class_names) > 0, "class_names 不能为空"

        # ---- 输入预处理: [H,W,3]/[3,H,W] 0-1 -> [1,3,res,res] (-1,1) ----
        if image.dim() == 4:
            image = image[0]
        if image.shape[0] == 3 and image.dim() == 3:
            img_chw = image
        else:
            img_chw = image.permute(2, 0, 1)
        orig_h, orig_w = int(img_chw.shape[-2]), int(img_chw.shape[-1])
        if (orig_h, orig_w) != (resolution, resolution):
            img_chw = F.interpolate(
                img_chw.unsqueeze(0), size=(resolution, resolution),
                mode="bilinear", align_corners=False,
            ).squeeze(0)
        x = img_chw.unsqueeze(0).to(self.device, torch.float32)
        # 输入为 0-1 浮点，而 pixel_mean/std=127.5 按 0-255 值域定义（原版吃 uint8）。
        # 必须先放大到 0-255 再归一化到 (-1,1)，否则图像会被抹成 ≈-1 常量导致全部 void。
        x = (x * 255.0 - self.pixel_mean) / self.pixel_std  # [1,3,H,W] in (-1,1)
        bs = 1

        # ---- 词表文本编码（双路, 带缓存）----
        SAM_text_classifier, SAM_num_templates = self._get_sam_text_classifier(class_names)
        if self.void_embedding is not None:
            SAM_text_classifier = torch.cat(
                [SAM_text_classifier, F.normalize(self.void_embedding.weight, dim=-1)], dim=0
            )
        siglip_classifier, siglip_num_templates = self._get_siglip_text_classifier(class_names)

        # ---- FindStage / prompt ----
        from .eovsam_sam3.model.data_misc import FindStage

        find_stage = FindStage(
            img_ids=torch.arange(bs, device=self.device, dtype=torch.long),
            text_ids=torch.arange(bs, device=self.device, dtype=torch.long),
            input_boxes=None, input_boxes_mask=None, input_boxes_label=None,
            input_points=None, input_points_mask=None,
        )
        geometric_prompt = self.detector._get_dummy_prompt(bs)
        # dummy prompt（含 _init_point 生成的默认中心点）以 fp32 创建，
        # 需对齐模型精度，否则 geometry_encoder 混精度崩溃
        _model_dtype = next(self.parameters()).dtype
        for _attr in ("box_embeddings", "point_embeddings", "mask_embeddings"):
            _t = getattr(geometric_prompt, _attr, None)
            if isinstance(_t, torch.Tensor) and torch.is_floating_point(_t) and _t.dtype != _model_dtype:
                setattr(geometric_prompt, _attr, _t.to(_model_dtype))

        # ---- 图像编码 ----
        backbone_out_vision = self.detector.backbone.forward_image(x)
        img_feat = backbone_out_vision["vision_features"].detach()
        backbone_fpn = backbone_out_vision["backbone_fpn"]
        for k in range(len(backbone_fpn)):
            backbone_fpn[k] = backbone_fpn[k].detach()

        # language features -> 输入格式（同 EOVSAM.forward）
        language_features = self._sam_cache[tuple(class_names)]["language_features"].to(self.device)
        language_mask = self._sam_cache[tuple(class_names)]["language_mask"].to(self.device)
        flat_language_features = language_features.reshape(-1, language_features.shape[-1])
        flat_language_mask = language_mask.reshape(-1)
        flat_language_features = flat_language_features[~flat_language_mask]
        language_features_input = flat_language_features.unsqueeze(0).expand(bs, -1, -1)
        language_mask_input = torch.zeros(
            bs, language_features_input.shape[1], dtype=torch.bool, device=self.device
        )

        backbone_out = {
            "img_batch_all_stages": img_feat,
            "vision_pos_enc": backbone_out_vision["vision_pos_enc"],
            "backbone_fpn": backbone_fpn,
            "language_features": language_features_input.permute(1, 0, 2),
            "language_mask": language_mask_input,
        }

        # ---- encode prompt -> encoder ----
        prompt, prompt_mask, backbone_out = self.detector._encode_prompt(
            backbone_out, find_stage, geometric_prompt
        )
        backbone_out, encoder_out, _ = self.detector._run_encoder(
            backbone_out, find_stage, prompt, prompt_mask
        )

        # ---- decoder ----
        query_embed = self.detector.transformer.decoder.query_embed.weight
        query_embed = query_embed.unsqueeze(1).repeat(1, bs, 1)

        hs, reference_boxes, dec_presence_out, dec_presence_feats, cross_attn_weights = (
            self.detector.transformer.decoder(
                tgt=query_embed,
                memory=encoder_out["encoder_hidden_states"],
                memory_key_padding_mask=encoder_out["padding_mask"],
                pos=encoder_out["pos_embed"],
                reference_boxes=None,
                level_start_index=encoder_out["level_start_index"],
                spatial_shapes=encoder_out["spatial_shapes"],
                valid_ratios=encoder_out["valid_ratios"],
                tgt_mask=None,
                memory_text=prompt,
                text_attention_mask=prompt_mask,
                apply_dac=False,
                use_presence_token=False,
                return_attn_weights=self.use_attnpool,
                return_all_attn_weights=False,
            )
        )
        hs = hs.transpose(1, 2)
        reference_boxes = reference_boxes.transpose(1, 2)
        if dec_presence_out is not None:
            dec_presence_out = dec_presence_out.transpose(1, 2)

        out = {
            "encoder_hidden_states": encoder_out["encoder_hidden_states"],
            "prev_encoder_out": {
                "encoder_out": encoder_out,
                "backbone_out": backbone_out,
            },
            "presence_feats": dec_presence_feats,
        }
        self.detector._update_scores_and_boxes(
            out, hs, reference_boxes, prompt, prompt_mask,
            dec_presence_out=dec_presence_out,
        )

        self.detector._run_segmentation_heads(
            out=out,
            backbone_out=backbone_out,
            img_ids=find_stage.img_ids,
            vis_feat_sizes=encoder_out["vis_feat_sizes"],
            encoder_hidden_states=out["encoder_hidden_states"],
            prompt=prompt,
            prompt_mask=prompt_mask,
            hs=hs,
            aux_masks=False,
        )

        outputs = out
        N = outputs["pred_masks"].shape[1]
        queries = outputs["obj_queries"]

        # ---- attnpool 分类（SigLIP2-g + CDT）----
        pool_cls_logits = None
        if self.use_attnpool:
            radio_img_feat = backbone_out_vision["vit_feature"][0]["siglip2-g"]["features"]
            pool_cross_attn_weights = cross_attn_weights[-1]

            text_classifier = siglip_classifier
            if self.cdt is not None:
                text_classifier = self.cdt(radio_img_feat.detach(), text_classifier)

            attn_cls_results = self._compute_attn_pool_cls_logits(
                pool_cross_attn_weights,
                radio_img_feat,
                text_classifier,
                siglip_num_templates,
            )
            pool_cls_logits = attn_cls_results[-1]  # [bs, N, C]

        # ---- query 路径分类（最后一层 i=5, add_pixelfeat）----
        i = self.num_decoder_layers - 1  # 最后一层
        tp_queries = queries[i]
        if self.add_pixelfeat:
            pixel_embed = outputs["pixel_embed"]
            pooled_pixel_embed = self.mask_pooling(pixel_embed, outputs["pred_masks"])
            if self.use_pixel_proj:
                pooled_pixel_embed = self.pixel_proj(pooled_pixel_embed)
            tp_queries = tp_queries + pooled_pixel_embed
        if self.use_cos_sim:
            tp_queries = F.normalize(tp_queries, dim=-1, p=2)

        query_names_results = torch.einsum("bnd,cd->bnc", tp_queries, SAM_text_classifier)
        if self.use_cos_sim:
            cur_logit_scale = self.logit_scale.exp()
            cur_logit_scale = torch.clamp(cur_logit_scale, max=100.0)
            query_names_results = cur_logit_scale * query_names_results

        # 每模板 max + void 列
        query_cls_results = []
        cur_idx = 0
        for num_t in SAM_num_templates:
            query_cls_results.append(query_names_results[:, :, cur_idx: cur_idx + num_t].max(-1).values)
            cur_idx += num_t
        if self.void_embedding is not None:
            query_cls_results.append(query_names_results[:, :, -1])
        query_cls_results_final = torch.stack(query_cls_results, dim=-1)  # [bs, N, C+1]

        # ---- ensemble（自定义词表: 全部按 unseen, beta 路径）----
        # 分类概率融合在 fp32 下计算（bf16 的 pow/log 有效位数不足，张量很小无成本）
        query_cls_results_final = query_cls_results_final.float()
        pool_cls_logits = pool_cls_logits.float() if pool_cls_logits is not None else None
        if self.use_softmax:
            is_void_prob = F.softmax(query_cls_results_final, dim=-1)[..., -1:]
            in_vocab_cls_probs = query_cls_results_final[..., :-1].softmax(-1)
            out_vocab_cls_probs = pool_cls_logits.softmax(-1)
        else:
            in_vocab_cls_probs = torch.sigmoid(query_cls_results_final[..., :-1])
            out_vocab_cls_probs = F.softmax(pool_cls_logits, dim=-1)
            is_void_prob = torch.sigmoid(query_cls_results_final[..., -1:])

        eps = 1e-7
        probs_unseen = (in_vocab_cls_probs + eps) ** (1 - self.beta) * (out_vocab_cls_probs + eps) ** self.beta

        # category_overlapping_mask 全 0（unseen）-> 纯 beta 路径
        ensemble_logits = probs_unseen.log()

        final_probs = torch.cat(
            [ensemble_logits.softmax(-1) * (1.0 - is_void_prob), is_void_prob], dim=-1
        )

        # ---- 按实例输出 ----
        mask_pred_i = F.interpolate(
            outputs["pred_masks"][0].unsqueeze(0),
            size=(orig_h, orig_w), mode="bilinear", align_corners=False,
        ).squeeze(0)  # [N, H, W]
        mask_pred_prob = mask_pred_i.sigmoid()

        probs = final_probs[0].float()  # [N, C+1]
        # EOVSAM_DEBUG=1 时打印每实例分数分布（诊断零检测问题用，默认关闭）
        if os.environ.get("EOVSAM_DEBUG"):
            print(f"[EOVSAM-DEBUG] N={N} | 词表={class_names} | threshold={threshold}")
            best_non_void = probs[:, :-1].max(-1).values
            order = torch.argsort(best_non_void, descending=True)
            for n in order[:12].tolist():
                row = " ".join(f"{c}={probs[n, ci]:.3f}" for ci, c in enumerate(class_names))
                print(f"  query{n}: void={probs[n, -1]:.3f} best_non_void={best_non_void[n]:.3f} | {row}")
        masks, labels, scores = [], [], []
        for n in range(N):
            score, cls_idx = probs[n].max(-1)
            if int(cls_idx) == len(class_names):  # void
                continue
            if float(score) < threshold:
                continue
            masks.append((mask_pred_prob[n] > 0.5).to(mask_pred_prob.dtype))  # 二值化 (0/1)
            labels.append(class_names[int(cls_idx)])
            scores.append(float(score))

        return masks, labels, scores


# ---------------- 模型缓存 ----------------

_MODEL_CACHE: Dict[tuple, EovsamModel] = {}


def get_or_build_model(
    checkpoint_path: str,
    precision: str = "bf16",
    device: Optional[str] = None,
) -> EovsamModel:
    """模块级模型缓存；key = (checkpoint, precision)。"""
    import comfy.model_management as mm

    key = (str(checkpoint_path), str(precision))
    if key in _MODEL_CACHE:
        return _MODEL_CACHE[key]

    if device is None:
        device = mm.get_torch_device()

    bpe_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "eovsam_sam3", "assets", "bpe_simple_vocab_16e6.txt.gz",
    )
    dtype = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}[precision]

    print(f"[EOVSAM] Building EOVSAM3 model (precision={precision}, device={device}) ...")
    model = EovsamModel(bpe_path=bpe_path, device=device)
    model.load_eovsam_checkpoint(checkpoint_path)

    model = model.to(device)
    if dtype != torch.float32:
        model = model.to(dtype)
    # RADIO conditioner 的 dtype 属性来自 half ckpt args，整体 cast 后已陈旧，
    # 会把归一化输出转回 fp32 导致 embedder 混精度崩溃 —— 同步为目标精度
    cond = getattr(getattr(getattr(model, "radio_adaptor", None), "student", None), "input_conditioner", None)
    if cond is not None:
        cond.dtype = dtype
    model.eval()
    for p in model.parameters():
        p.requires_grad_(False)

    _MODEL_CACHE[key] = model
    return model
