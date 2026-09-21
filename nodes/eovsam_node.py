# -*- coding: utf-8 -*-
"""
EOVSAM3 节点：
- LoadEovSAM3Model：加载 EOVSAM3 模型（EOVSAM: RADIO + SAM3 开放词汇分割）
  首次运行自动从 HuggingFace 下载 eovsam.pth (~7.7GB) 到 models/eovsam/
  输出 JSON-safe 的模型配置 dict，实际模型构建在 libs/eovsam/eovsam_model.py 中（带缓存）
  消费方式：接入 SnapshotDetailer 等 detector 输入（prompt 为逗号分隔词表）
- ImageSegmentationNode：图像开放词汇分割（image + 掩码表达式 prompt → mask）
  （旧注册名 ImageDetectNode 保留为 deprecated 别名，仅供旧工作流加载）
"""
import os
import logging

import torch
import folder_paths

log = logging.getLogger("kolid-comfy.eovsam")

_EOVSAM_MODELS_DIR = os.path.join(folder_paths.models_dir, "eovsam")
os.makedirs(_EOVSAM_MODELS_DIR, exist_ok=True)

try:
    from huggingface_hub import hf_hub_download
    HF_HUB_AVAILABLE = True
except ImportError:
    HF_HUB_AVAILABLE = False

HF_REPO_ID = "HaominPeng/EOVSAM"
HF_FILENAME = "eovsam.pth"


class LoadEovSAM3Model:
    """加载 EOVSAM3 模型配置（含权重自动下载）。"""

    MODEL_DIR = "models/eovsam"
    MODEL_FILENAME = "eovsam.pth"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "precision": (["bf16", "fp16", "fp32"], {
                    "default": "bf16",
                    "tooltip": "模型精度。bf16 推荐（与论文训练 AMP 一致）；fp32 最精确但显存翻倍",
                }),
                "resolution": ("INT", {
                    "default": 1152, "min": 448, "max": 2048, "step": 16,
                    "tooltip": "推理分辨率（16 的倍数）。论文默认 1152，RADIO patch16 对齐",
                }),
            },
        }

    RETURN_TYPES = ("EOVSAM3_MODEL",)
    RETURN_NAMES = ("eovsam3_model",)
    FUNCTION = "execute"
    CATEGORY = "kolid/detector"

    @classmethod
    def execute(cls, precision, resolution):
        checkpoint_path = os.path.join(_EOVSAM_MODELS_DIR, cls.MODEL_FILENAME)

        if not os.path.exists(checkpoint_path):
            if not HF_HUB_AVAILABLE:
                raise ImportError(
                    "[EOVSAM3] 未找到 huggingface_hub，无法自动下载模型。\n"
                    "请安装: pip install huggingface_hub\n"
                    f"或手动下载权重到: {checkpoint_path}\n"
                    f"下载地址: https://huggingface.co/{HF_REPO_ID}/resolve/main/{HF_FILENAME}"
                )
            log.info("[EOVSAM3] 模型不存在，开始从 HuggingFace 下载 (~7.7GB) ...")
            print(f"[EOVSAM3] Downloading eovsam.pth (~7.7GB) from huggingface.co/{HF_REPO_ID} ...")
            hf_hub_download(
                repo_id=HF_REPO_ID,
                filename=HF_FILENAME,
                local_dir=_EOVSAM_MODELS_DIR,
            )
            if not os.path.exists(checkpoint_path):
                raise RuntimeError(f"[EOVSAM3] 下载完成但未找到权重文件: {checkpoint_path}")
            print(f"[EOVSAM3] 权重下载完成: {checkpoint_path}")

        # JSON-safe 配置（跨节点传递，实际模型在 get_or_build_model 中缓存构建）
        config = {
            "eovsam_checkpoint": str(checkpoint_path),
            "precision": str(precision),
            "resolution": int(resolution),
        }
        return (config,)


class ImageSegmentationNode:
    """
    图像开放词汇分割节点：image + prompt（掩码表达式）→ mask。

    prompt 为掩码表达式，术语阈值内嵌其中，例如:
      "(body:0.2-face:0.2)&(human:0.1)"
      "max(body:0.2,skin:0.2)"
      "x=grow(character:0.1,20);y=grow(skin:0.2,-5);x-y"（赋值后可复用）
    运算符: & 交集、+ 并集、- 差集；函数: max / min / grow（可嵌套）；
    语句以 ';' 或换行分隔，'名字 = 表达式' 赋值后即可引用，最后一条语句的值即结果；
    未写阈值的术语默认 0.2；invert=True 时输出掩码取反（1 - mask）。

    - detector 未连接时默认使用 EOVSAM3（复用 LoadEovSAM3Model 的自动下载逻辑）
    - 已连接时透传给 detect_mask，兼容所有已支持的检测器（EOVSAM3 / SAM3 / Florence-2）
    - 每术语独立检测（未检出 → 该术语全 0），表达式合成最终二值 mask
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "prompt": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "掩码表达式，例如 (body:0.2-face:0.2)&(human:0.1)、"
                               "max(person:0.2,car:0.3) 或 "
                               "x=grow(character:0.1,20);x-face:0.2"
                               "（';' 或换行分隔语句，'x = 表达式' 赋值后可复用，"
                               "每个变量只计算一次）；"
                               "术语不带阈值时默认 0.2",
                }),
                "invert": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "取反输出掩码（1 - mask）：保留背景、抠掉检测目标。"
                               "在整个表达式求值之后应用。",
                }),
            },
            "optional": {
                "detector": ("*", {
                    "tooltip": "检测器（EOVSAM3_MODEL 等）。不连接时默认使用 EOVSAM3（首次自动下载权重）",
                }),
            },
        }

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("mask",)
    FUNCTION = "detect"
    CATEGORY = "kolid/detector"

    @classmethod
    def detect(cls, image, prompt, detector=None, invert=False):
        from ..libs.detect_utils import detect_mask
        from ..libs.mask_utils import combine_masks
        from ..libs.mask_expression import (
            parse_mask_expression,
            collect_terms,
            eval_expression,
        )

        if not str(prompt).strip():
            raise ValueError(
                "[ImageSegmentationNode] prompt 不能为空，请输入掩码表达式，"
                "例如: (body:0.2-face:0.2)&(human:0.1)"
            )

        # detector 未连接 → 默认 EOVSAM3（bf16 / 1152，含权重自动下载）
        if detector is None:
            detector = LoadEovSAM3Model.execute("bf16", 1152)[0]

        ast = parse_mask_expression(str(prompt), default_threshold=0.2)
        terms = collect_terms(ast)

        batch, height, width = int(image.shape[0]), int(image.shape[1]), int(image.shape[2])
        device = image.device
        masks = []
        for b in range(batch):
            frame = image[b]
            # 逐术语独立检测（未检出的术语 → 全 0 mask），再按表达式合成
            term_masks = {}
            for name, threshold in terms:
                try:
                    mask_list = detect_mask(
                        detector=detector,
                        image=frame,
                        threshold=threshold,
                        dilation=0,
                        crop_factor=1.5,
                        drop_size=0,
                        prompt=name,
                    )
                except RuntimeError as e:
                    # EOVSAM3 未检测到对象时抛出带提示的错误 → 该术语全 0
                    if "未检测到任何对象" in str(e):
                        print(f"[ImageSegmentationNode] 第 {b + 1}/{batch} 帧 "
                              f"术语 '{name}' 未检出 (threshold={threshold})")
                        mask_list = []
                    else:
                        raise
                if mask_list:
                    term_masks[(name, threshold)] = combine_masks(
                        mask_list, mode="max").squeeze(0)
                else:
                    term_masks[(name, threshold)] = torch.zeros(height, width)

            final = eval_expression(ast, term_masks)
            if invert:
                final = 1.0 - final
            masks.append(final.to(device=device, dtype=torch.float32))

        return (torch.stack(masks, dim=0),)


class ImageDetectNode(ImageSegmentationNode):
    """旧注册名（已弃用）：仅为加载旧工作流保留，新工作流请用 ImageSegmentationNode。"""

    DEPRECATED = True


NODE_CLASS_MAPPINGS = {
    "LoadEovSAM3Model": LoadEovSAM3Model,
    "ImageSegmentationNode": ImageSegmentationNode,
    "ImageDetectNode": ImageDetectNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoadEovSAM3Model": "Load EovSAM3 Model",
    "ImageSegmentationNode": "Image Segmentation",
    "ImageDetectNode": "ImageDetectNode (deprecated)",
}
