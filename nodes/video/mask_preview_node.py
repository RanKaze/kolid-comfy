# -*- coding: utf-8 -*-
"""
掩码叠加预览系列节点(Image / Video 一对,参数与视觉规则一致):

- ImageAndMaskPreviewNode: image + mask → 把 mask 按 mask_color/mask_opacity
  叠加到图像上,输出叠加后的 IMAGE,并在 UI 中预览结果;纯内存张量运算,不落盘。
- VideoAndMaskPreviewNode: image_video + mask_video → 逐帧叠加后的 VIDEO,
  一并产生视频预览;结果按内容哈希 + 参数磁盘缓存命中复用
  (与 Video 系列其它掩码算子同一套缓存)。

mask_color 支持 "255,255,255"(0-255)与 "1.0,1.0,1.0"(0-1)两种写法:
分量全部 ≤ 1 时按 0-1 解释(故 "1,1,1" 与 "1.0,1.0,1.0" 同为白色),
其它按 0-255;单分量写法等同于三分量("255" = 白色)。
mask_opacity 是叠加的整体不透明度(0 = 原图不变)。

视频侧逐帧流式处理(ffmpeg rawvideo 进出):image_video 解 rgb24、
mask_video 解灰度,任意时刻每路仅 1 帧驻留内存;输出 crf18 彩色视频,
源音频转 aac 一并保留。mask_video 尺寸必须与 image_video 一致,帧数不足
时按黑帧补齐(等效于无叠加)。
"""
import os

import numpy as np
import torch
from comfy_api.latest import io, ui

from ...libs.video_transform import stream_transform_video
from ...libs.video_utils import get_video_metadata
from .video_fit_node import (
    _video_source_path,
    _validate_mask_video,
    _preview_ui,
    _is_changed_tag,
    _video_output,
)
from .video_mask_node import _cache_or_run

CATEGORY = "Kolid-Toolkit"


def _parse_mask_color(text):
    """'255,255,255' / '1.0,1.0,1.0' / '255' → (r, g, b) float 0-1。"""
    raw = str(text).strip()
    parts = [p.strip() for p in raw.split(",") if p.strip() != ""]
    if not parts:
        raise ValueError(f"Invalid mask_color: '{text}' (expected '255,255,255' or '1.0,1.0,1.0')")
    try:
        vals = [float(p) for p in parts]
    except ValueError:
        raise ValueError(f"Invalid mask_color: '{text}' (expected '255,255,255' or '1.0,1.0,1.0')")
    if any(v < 0.0 or v > 255.0 for v in vals):
        raise ValueError(f"mask_color 分量必须在 0-1 或 0-255 范围内: '{text}'")
    if len(vals) == 1:
        vals = vals * 3
    if len(vals) != 3:
        raise ValueError(f"mask_color 需要 1 或 3 个分量(如 '255,255,255' 或 '1.0,1.0,1.0'): '{text}'")
    if all(v <= 1.0 for v in vals):
        return tuple(vals)
    return tuple(v / 255.0 for v in vals)


def _color_tag(color):
    """规范化的颜色标签(供缓存 key / IS_CHANGED 使用,两种写法归一)。"""
    return ",".join(f"{c:.4f}" for c in color)


def _normalize_mask(mask):
    """MASK → [B, H, W] float(0-1);兼容 [H,W] / [B,H,W] / [B,H,W,1]。"""
    m = mask
    if m.ndim == 4:
        m = m[..., 0]
    elif m.ndim == 2:
        m = m.unsqueeze(0)
    if m.ndim != 3:
        raise ValueError(f"Unsupported mask shape: {tuple(mask.shape)}")
    m = m.float()
    if float(m.max()) > 1.0:
        m = m / 255.0
    # 非原地:mask 可能是 expand 出来的广播视图,原地写入会报
    # "more than one element of the written-to tensor refers to a single memory location"
    return m.clamp(0.0, 1.0)


def _composite_mask(image, mask, color, opacity):
    """image [B,H,W,C] + mask → [B,H,W,3](RGB,0-1)。"""
    img = image
    if img.ndim == 3:
        img = img.unsqueeze(0)
    if img.ndim != 4:
        raise ValueError(f"Unsupported image shape: {tuple(image.shape)}")
    if img.shape[-1] == 4:
        img = img[..., :3]
    elif img.shape[-1] != 3:
        raise ValueError(f"Unsupported image channels: {img.shape[-1]}")

    m = _normalize_mask(mask)
    if m.shape[-2:] != img.shape[1:3]:
        raise ValueError(f"mask {m.shape[-2]}x{m.shape[-1]} 与 image "
                         f"{img.shape[1]}x{img.shape[2]} 尺寸不一致!")
    if m.shape[0] != img.shape[0]:
        if m.shape[0] == 1:
            m = m.expand(img.shape[0], -1, -1)
        elif img.shape[0] == 1:
            img = img.expand(m.shape[0], -1, -1, -1)
        else:
            raise ValueError(f"mask batch {m.shape[0]} 与 image batch {img.shape[0]} 不一致!")

    img = img.float()
    alpha = (m * float(opacity)).clamp_(0.0, 1.0).unsqueeze(-1)
    rgb = torch.tensor(color, dtype=img.dtype, device=img.device).view(1, 1, 1, 3)
    return (img * (1.0 - alpha) + rgb * alpha).clamp_(0.0, 1.0)


class ImageAndMaskPreviewNode:
    """image + mask → 叠加 mask_color(可调透明度)的 IMAGE,并在 UI 中预览。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "Base image"}),
                "mask": ("MASK", {"tooltip": "Mask to overlay (0-1, same size as image)"}),
                "mask_opacity": ("FLOAT", {
                    "default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01, "round": 0.01,
                    "tooltip": "叠加不透明度:0 = 原图, 1 = 完全不透明"}),
                "mask_color": ("STRING", {
                    "default": "255,255,255",
                    "tooltip": "叠加颜色:'255,255,255'(0-255)或 '1.0,1.0,1.0'(0-1)"}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "preview"
    CATEGORY = CATEGORY

    def preview(self, image, mask, mask_opacity, mask_color):
        color = _parse_mask_color(mask_color)
        out = _composite_mask(image, mask, color, mask_opacity)
        print(f"[ImageAndMaskPreviewNode] {image.shape[0]} image(s) "
              f"{image.shape[2]}x{image.shape[1]} mask={_color_tag(color)} "
              f"opacity={mask_opacity}")
        return io.NodeOutput(out, ui=ui.PreviewImage(out))


class VideoAndMaskPreviewNode:
    """image_video + mask_video → 叠加 mask_color(可调透明度)的 VIDEO(带预览)。

    输出尺寸/帧率/帧数跟随 image_video;mask_video 耗尽后按黑帧补齐。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_video": ("VIDEO", {
                    "tooltip": "Base video; output size/frame count/fps follow it"}),
                "mask_video": ("VIDEO", {
                    "tooltip": "Grayscale mask video overlaid in mask_color "
                               "(must match image_video size)"}),
                "mask_opacity": ("FLOAT", {
                    "default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01, "round": 0.01,
                    "tooltip": "叠加不透明度:0 = 原视频, 1 = 完全不透明"}),
                "mask_color": ("STRING", {
                    "default": "255,255,255",
                    "tooltip": "叠加颜色:'255,255,255'(0-255)或 '1.0,1.0,1.0'(0-1)"}),
            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    FUNCTION = "preview"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(s, image_video, mask_video, mask_opacity, mask_color):
        return _is_changed_tag(
            [_video_source_path(image_video) if image_video else None,
             _video_source_path(mask_video) if mask_video else None],
            {"mask_opacity": round(float(mask_opacity), 4),
             "mask_color": _color_tag(_parse_mask_color(mask_color))})

    def preview(self, image_video, mask_video, mask_opacity, mask_color):
        img_path = _video_source_path(image_video)
        mask_path = _video_source_path(mask_video)
        color = _parse_mask_color(mask_color)
        color_tag = _color_tag(color)

        meta = get_video_metadata(img_path)
        w, h, fps = meta["width"], meta["height"], meta["fps"]
        _validate_mask_video(mask_path, w, h, meta["frame_count"])

        if float(mask_opacity) <= 0.0:
            print("[VideoAndMaskPreviewNode] opacity 0, passthrough")
            return io.NodeOutput(_video_output(img_path), ui=_preview_ui(img_path))

        print(f"[VideoAndMaskPreviewNode] {w}x{h} mask={color_tag} "
              f"opacity={mask_opacity} <- {os.path.basename(img_path)}")

        rgb = np.array(color, dtype=np.float32)

        def frame_fn(frames):
            img = frames[0].astype(np.float32) / 255.0
            m = (frames[1].astype(np.float32) / 255.0) * float(mask_opacity)
            out = img * (1.0 - m[..., None]) + rgb * m[..., None]
            return (np.clip(out, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)

        out_path = _cache_or_run(
            "VideoAndMaskPreviewNode",
            {"image": img_path, "mask": mask_path},
            {"mask_opacity": round(float(mask_opacity), 4), "mask_color": color_tag},
            lambda out: stream_transform_video(
                [(img_path, w, h), (mask_path, w, h)], out, w, h, fps, frame_fn,
                src_formats=["rgb24", "gray"], mode="image",
                audio_source=img_path if meta.get("has_audio") else None))

        return io.NodeOutput(_video_output(out_path), ui=_preview_ui(out_path))
