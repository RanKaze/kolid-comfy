# -*- coding: utf-8 -*-
"""
主体裁剪系列节点(参考 MaskVidExperiments 的 MVEx Subject Crop / Subject Uncrop):

- ImageSubjectCropNode / ImageRecoverSubjectCropNode:图像批版本,语义与
  MVEx 原版逐算子一致(裁剪规划、重采样、羽化贴回全部相同)
- VideoSubjectCropNode / VideoRecoverSubjectCropNode:视频文件版本,
  沿用磁盘缓存(源内容哈希+参数)与逐帧流式管道

内存管理(硬约束):规划只需要每帧主体的外接范围(4 个数字),
掩码视频流式逐帧计算范围,任意时刻不驻留帧序列;执行阶段为
ffmpeg rawvideo 逐帧管道。4K 长视频内存恒定。

与原版的差异(按要求):无 debug 输出;bboxes 输出改为 subject_crop_info
(INFO 类型,携带逐帧 boxes、源尺寸、输出尺寸);MVEx 的 DynamicCombo
mode 子参数展平为固定参数列表(对应 _cell_params 的标准单元映射)。
"""
import json
import math
import os
import subprocess

import numpy as np
import torch
import torchvision.transforms.functional as TF
from torchvision.transforms import InterpolationMode
from PIL import Image as PILImage

import comfy.utils
from comfy_api.latest import io, ui, InputImpl

from ..libs.video_utils import FFMPEG_PATH, get_video_metadata
from ..libs.video_transform import (
    CACHE_DIR,
    cache_lookup,
    cache_output_paths,
    cache_store,
    compute_transform_key,
)
from ..libs.subject_planner import plan as _plan_boxes, extents_from_frames
from .video_fit_node import (
    _video_source_path,
    _preview_ui,
    _is_changed_tag,
    _video_output,
)

CATEGORY = "Kolid-Toolkit"

_MODES = ["combined", "tracked", "zoomed"]

_INTERP_MAP = {
    "lanczos": InterpolationMode.LANCZOS,
    "bilinear": InterpolationMode.BILINEAR,
    "bicubic": InterpolationMode.BICUBIC,
    "nearest-exact": InterpolationMode.NEAREST_EXACT,
}


def _cell_params(sel, crop_scale, aspect_ratio, padding, prefer,
                 pad_surplus_tol, zoom_step, seamless_loop):
    """标准单元的规划器参数(与 MVEx _cell_params 相同的映射)。"""
    floor = {"guaranteed": 1.0, "firm": 0.7, "flexible": 0.0}[padding]
    still = prefer == "stillness"
    if sel == "tracked":
        oversize = 32.0 if still else 8.0
    else:
        oversize = float(pad_surplus_tol)
    return {
        "crop_scale": crop_scale,
        "min_padding_allowed": floor,
        "min_padding_allowed_window": 1 if padding == "guaranteed" else 16,
        "pad_deficit_tol": 16.0,
        "pad_surplus_tol": oversize,
        "resize_cost": 2.0 if still else 1.0,
        "movement_cost": 1.0,
        "center_pull": 1e-4,
        "end_tightening": 0.0,
        "end_tightening_window": 80 if floor > 0 else 0,
        "zoom_step": zoom_step,
        "max_zoom_rate": 0.0,
        "aspect_ratio": aspect_ratio,
        "seamless_loop": seamless_loop,
    }


def _build_p(mode, crop_scale, aspect_ratio, padding, prefer,
             pad_surplus_tol, zoom_step, seamless_loop):
    if mode == "combined":
        return {"crop_scale": crop_scale, "aspect_ratio": aspect_ratio}
    return _cell_params(mode, crop_scale, aspect_ratio, padding, prefer,
                        pad_surplus_tol, zoom_step, seamless_loop)


def _upscale_size(w, h, megapixels, divisible_by):
    """与 MVEx _upscale_size 一致:把 w x h 缩放到约 |megapixels| 百万像素。"""
    scale = math.sqrt(abs(megapixels) * 1024 * 1024 / (w * h))
    if megapixels > 0 and scale <= 1.0:
        return None
    return (max(1, round(w * scale / divisible_by)) * divisible_by,
            max(1, round(h * scale / divisible_by)) * divisible_by)


# ============================================================
# 图像批辅助(与 MVEx 原版相同的重采样路径 → 像素级一致)
# ============================================================

def _resize_image(img_hwc, w, h, method="lanczos"):
    if img_hwc.shape[0] == h and img_hwc.shape[1] == w:
        return img_hwc
    return comfy.utils.common_upscale(
        img_hwc.movedim(-1, 0).unsqueeze(0), w, h, method, "disabled"
    ).squeeze(0).movedim(0, -1)


def _resize_mask(mask_hw, w, h, method="bilinear"):
    if mask_hw.shape[0] == h and mask_hw.shape[1] == w:
        return mask_hw
    return comfy.utils.common_upscale(
        mask_hw[None, None], w, h, method, "disabled"
    )[0, 0]


def _resolve_output_size(boxes, info, sel, full_frame, divisible_by,
                         upscale_megapixels, img_w, img_h):
    """与 MVEx _plan_and_crop 的输出尺寸决策一致。

    返回 (size or None, img_method, mask_method)。
    """
    bw = max(b["width"] for b in boxes)
    bh = max(b["height"] for b in boxes)
    size = None
    img_method, mask_method = "lanczos", "bilinear"
    if full_frame:
        gw = math.ceil(bw / divisible_by) * divisible_by
        gh = math.ceil(bh / divisible_by) * divisible_by
        if (gw, gh) != (bw, bh):
            size = (gw, gh)
    elif sel == "zoomed":
        # 目标尺寸取最大规划框:最大那帧近似 1:1,其余只放大不损失细节
        th = math.ceil(bh / divisible_by) * divisible_by
        size = (math.ceil(th * info["aspect"] / divisible_by) * divisible_by, th)
    if upscale_megapixels != 0:
        up = _upscale_size(*(size or (bw, bh)), upscale_megapixels, divisible_by)
        if up is not None:
            size = up
            img_method, mask_method = "bicubic", "nearest-exact"
    return size, img_method, mask_method


def _make_info(boxes, info, sel, img_w, img_h, n, size):
    return {
        "boxes": boxes,
        "source_width": int(img_w),
        "source_height": int(img_h),
        "output_size": [int(size[0]), int(size[1])] if size else None,
        "frame_count": int(n),
        "mode": sel,
        "aspect": float(info["aspect"]),
    }


# ============================================================
# ImageSubjectCropNode(参考 MVEx Subject Crop,无 debug,bboxes→subject_crop_info)
# ============================================================

class ImageSubjectCropNode:
    """按主体掩码逐帧规划裁剪框,裁出等尺寸图像批。

    语义与 MVEx Subject Crop 相同:combined 一框包住主体全程;
    tracked 恒定尺寸框尽量不动;zoomed 框随主体大小变化并统一重采样到
    固定输出分辨率。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "原始图像批"}),
                "mask": ("MASK", {"tooltip": "主体掩码批,逐帧对应"}),
                "mode": (_MODES, {"tooltip": "combined: 一框包住主体整个行程; tracked: 恒定尺寸框,尽量保持不动; zoomed: 框跟随主体大小,统一重采样"}),
                "crop_scale": ("FLOAT", {"default": 1.5, "min": 0.0, "max": 4.0, "step": 0.05, "tooltip": "裁剪尺寸相对主体尺寸的倍数;1.0 紧贴,0 跳过裁剪(整帧直通)"}),
                "aspect_ratio": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 10.0, "step": 0.01, "tooltip": "宽/高比;0 由规划器自动选择"}),
                "padding": (["guaranteed", "firm", "flexible"], {"default": "firm", "tooltip": "crop_scale 边距的保障强度"}),
                "prefer": (["stillness", "tightness"], {"default": "stillness", "tooltip": "移动时牺牲什么:框更大更稳 vs 框更小更紧"}),
                "pad_surplus_tol": ("INT", {"default": 16, "min": 1, "max": 999, "tooltip": "(zoomed) 多余边距保持的帧数阈值"}),
                "zoom_step": ("FLOAT", {"default": 1.0, "min": 1.0, "max": 4.0, "step": 0.05, "tooltip": "(zoomed) 尺寸变化的量化步长;1.0 连续"}),
                "seamless_loop": ("BOOLEAN", {"default": False, "tooltip": "首尾无缝循环规划"}),
                "mask_threshold": ("FLOAT", {"default": 0.1, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "掩码大于该值计为主体"}),
                "divisible_by": ("INT", {"default": 16, "min": 1, "tooltip": "输出宽高向上取整到该倍数"}),
                "upscale_megapixels": ("FLOAT", {"default": 0.0, "min": -16.0, "max": 16.0, "step": 0.05, "tooltip": "重采样到该百万像素;0 关闭;负值允许缩小"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "SUBJECT_CROP_INFO")
    RETURN_NAMES = ("image", "mask", "subject_crop_info")
    FUNCTION = "crop"
    CATEGORY = CATEGORY

    def crop(self, image, mask, mode, crop_scale, aspect_ratio, padding, prefer,
             pad_surplus_tol, zoom_step, seamless_loop, mask_threshold,
             divisible_by, upscale_megapixels):
        if image.shape[0] != mask.shape[0]:
            raise ValueError(f"image ({image.shape[0]}) and mask ({mask.shape[0]}) must have the same frame count")
        if image.shape[1:3] != mask.shape[1:3]:
            raise ValueError(f"image ({image.shape[2]}x{image.shape[1]}) and mask ({mask.shape[2]}x{mask.shape[1]}) must have the same dimensions")
        if 0.0 < crop_scale < 1.0:
            raise ValueError("crop_scale must be 0 (full frame) or at least 1.0")
        full_frame = crop_scale <= 0.0

        n, img_h, img_w = mask.shape
        # 逐帧流式计算范围(不物化整段二值栈)
        tracks = extents_from_frames(
            (mask[i].cpu().numpy() for i in range(n)), mask_threshold)

        if full_frame:
            boxes = [{"x": 0, "y": 0, "width": img_w, "height": img_h}
                     for _ in range(n)]
            info = {"aspect": img_w / img_h}
        else:
            boxes, info = _plan_boxes(
                n, img_h, img_w, *tracks, mode,
                _build_p(mode, crop_scale, aspect_ratio, padding, prefer,
                         pad_surplus_tol, zoom_step, seamless_loop),
                divisible_by)

        size, img_method, mask_method = _resolve_output_size(
            boxes, info, mode, full_frame, divisible_by,
            upscale_megapixels, img_w, img_h)

        if size is not None:
            tw, th = size
            cropped_images = torch.stack([
                _resize_image(image[i, b["y"]:b["y"] + b["height"],
                                     b["x"]:b["x"] + b["width"], :], tw, th, img_method)
                for i, b in enumerate(boxes)
            ])
            cropped_masks = torch.stack([
                _resize_mask(mask[i, b["y"]:b["y"] + b["height"],
                                   b["x"]:b["x"] + b["width"]], tw, th, mask_method)
                for i, b in enumerate(boxes)
            ])
        else:
            cropped_images = torch.stack([
                image[i, b["y"]:b["y"] + b["height"], b["x"]:b["x"] + b["width"], :]
                for i, b in enumerate(boxes)
            ])
            cropped_masks = torch.stack([
                mask[i, b["y"]:b["y"] + b["height"], b["x"]:b["x"] + b["width"]]
                for i, b in enumerate(boxes)
            ])

        return (cropped_images, cropped_masks,
                _make_info(boxes, info, mode, img_w, img_h, n, size))


# ============================================================
# ImageRecoverSubjectCropNode(参考 MVEx Subject Uncrop)
# ============================================================

class ImageRecoverSubjectCropNode:
    """把处理后的裁剪批贴回原始图像批,羽化边缘,可用掩码限制粘贴区域。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "cropped_image": ("IMAGE", {"tooltip": "处理后的裁剪帧"}),
                "image": ("IMAGE", {"tooltip": "要贴回的原始帧"}),
                "subject_crop_info": ("SUBJECT_CROP_INFO", {"tooltip": "来自 ImageSubjectCropNode 的裁剪信息"}),
                "feather": ("INT", {"default": 16, "min": 0, "tooltip": "羽化宽度(像素),从裁剪边缘向内;贴到图像边缘的边不羽化"}),
            },
            "optional": {
                "cropped_mask": ("MASK", {"tooltip": "限制粘贴区域的掩码(逐裁剪帧,任意分辨率);原样使用,需软边请预先模糊"}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "recover"
    CATEGORY = CATEGORY

    def recover(self, cropped_image, image, subject_crop_info, feather, cropped_mask=None):
        boxes = subject_crop_info["boxes"]
        img_h, img_w = image.shape[1], image.shape[2]

        counts = {"cropped_image": cropped_image.shape[0], "image": image.shape[0]}
        if len(boxes) > 1:
            counts["boxes"] = len(boxes)
        if cropped_mask is not None and cropped_mask.shape[0] > 1:
            counts["cropped_mask"] = cropped_mask.shape[0]
        n = min(counts.values())
        if n < max(counts.values()):
            got = ", ".join(f"{k}={v}" for k, v in counts.items())
            print(f"[ImageRecoverSubjectCropNode] frame counts differ ({got}), using the first {n} frames of each")

        cropped_image = cropped_image[:n]
        image = image[:n]
        if cropped_mask is not None:
            cropped_mask = cropped_mask.expand(n, -1, -1) if cropped_mask.shape[0] == 1 else cropped_mask[:n]
        if len(boxes) == 1:
            boxes = boxes * n
        else:
            boxes = boxes[:n]

        out = image.clone()
        for i, b in enumerate(boxes):
            x, y, w, h = (int(round(b[k])) for k in ("x", "y", "width", "height"))
            x = min(max(x, 0), max(img_w - 1, 0))
            y = min(max(y, 0), max(img_h - 1, 0))
            w = min(w, img_w - x)
            h = min(h, img_h - y)
            if w <= 0 or h <= 0:
                continue
            crop = _resize_image(cropped_image[i], w, h)

            alpha = torch.ones(h, w, dtype=out.dtype, device=out.device)
            fx, fy = min(feather, w // 2), min(feather, h // 2)
            if fy > 0:
                ramp = torch.linspace(0, 1, fy + 2, dtype=out.dtype, device=out.device)[1:-1]
                if y > 0:
                    alpha[:fy, :] *= ramp[:, None]
                if y + h < img_h:
                    alpha[h - fy:, :] *= ramp.flip(0)[:, None]
            if fx > 0:
                ramp = torch.linspace(0, 1, fx + 2, dtype=out.dtype, device=out.device)[1:-1]
                if x > 0:
                    alpha[:, :fx] *= ramp[None, :]
                if x + w < img_w:
                    alpha[:, w - fx:] *= ramp.flip(0)[None, :]

            if cropped_mask is not None:
                m = _resize_mask(cropped_mask[i], w, h)
                alpha = alpha * m.clamp(0.0, 1.0).to(dtype=out.dtype, device=out.device)

            alpha = alpha[..., None]
            region = out[i, y:y + h, x:x + w, :]
            out[i, y:y + h, x:x + w, :] = crop.to(region) * alpha + region * (1 - alpha)

        return (out,)


# ============================================================
# 视频版:流式规划 + 逐帧管道
# ============================================================

def _stream_mask_extents(mask_path, threshold, meta):
    """流式解码掩码视频,逐帧记录主体范围(O(1) 内存)。"""
    w, h = meta["width"], meta["height"]
    proc = subprocess.Popen(
        [FFMPEG_PATH, "-noautorotate", "-loglevel", "warning", "-i", mask_path,
         "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        size = w * h
        thresh = threshold * 255.0
        bx0, bx1, by0, by1 = [], [], [], []
        n = 0
        while True:
            buf = proc.stdout.read(size)
            if not buf or len(buf) < size:
                break
            frame = np.frombuffer(buf, dtype=np.uint8).reshape(h, w)
            ys, xs = np.nonzero(frame > thresh)
            if len(xs):
                bx0.append(float(xs.min())); bx1.append(float(xs.max()))
                by0.append(float(ys.min())); by1.append(float(ys.max()))
            else:
                bx0.append(np.nan); bx1.append(np.nan)
                by0.append(np.nan); by1.append(np.nan)
            n += 1
        if n != meta["frame_count"]:
            print(f"[VideoSubjectCrop] warning: decoded {n} mask frames, metadata said {meta['frame_count']}")
        return n, (np.array(bx0), np.array(bx1), np.array(by0), np.array(by1))
    finally:
        proc.stdout.close()
        proc.kill()
        proc.wait()


def _resize_frame_u8(frame, tw, th, method):
    """uint8 帧(HxW 或 HxWx3)→ 重采样到 tw x th。
    lanczos 走 PIL(torchvision 不支持 lanczos,且与 comfy.common_upscale
    的 PIL 路径一致);其余走 torchvision 抗锯齿。"""
    if frame.shape[0] == th and frame.shape[1] == tw:
        return np.ascontiguousarray(frame)
    if method == "lanczos":
        return np.array(
            PILImage.fromarray(frame).resize((tw, th), PILImage.Resampling.LANCZOS),
            dtype=np.uint8, copy=True)
    is_gray = frame.ndim == 2
    f = frame.astype(np.float32) / 255.0
    if is_gray:
        t = torch.from_numpy(f)[None, None]
    else:
        t = torch.from_numpy(f).permute(2, 0, 1)[None]
    t = TF.resize(t, [th, tw], interpolation=_INTERP_MAP[method], antialias=True)[0]
    if is_gray:
        out = t.numpy()
    else:
        out = t.permute(1, 2, 0).numpy()
    return (np.clip(out, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


def _crop_resize_u8(frame, b, size, method):
    sub = frame[b["y"]:b["y"] + b["height"], b["x"]:b["x"] + b["width"]]
    if size is None:
        return np.ascontiguousarray(sub)
    return _resize_frame_u8(sub, size[0], size[1], method)


def _paste_frame_u8(crop_u8, orig_u8, b, feather, mask_u8):
    """单帧贴回(与 MVEx Subject Uncrop 相同的羽化/掩码逻辑,u8 域)。"""
    img_h, img_w = orig_u8.shape[:2]
    x, y = int(round(b["x"])), int(round(b["y"]))
    w, h = int(round(b["width"])), int(round(b["height"]))
    x = min(max(x, 0), max(img_w - 1, 0))
    y = min(max(y, 0), max(img_h - 1, 0))
    w = min(w, img_w - x)
    h = min(h, img_h - y)
    if w <= 0 or h <= 0:
        return orig_u8

    crop = _resize_frame_u8(crop_u8, w, h, "lanczos").astype(np.float32)

    alpha = torch.ones(h, w, dtype=torch.float32)
    fx, fy = min(feather, w // 2), min(feather, h // 2)
    if fy > 0:
        ramp = torch.linspace(0, 1, fy + 2)[1:-1]
        if y > 0:
            alpha[:fy, :] *= ramp[:, None]
        if y + h < img_h:
            alpha[h - fy:, :] *= ramp.flip(0)[:, None]
    if fx > 0:
        ramp = torch.linspace(0, 1, fx + 2)[1:-1]
        if x > 0:
            alpha[:, :fx] *= ramp[None, :]
        if x + w < img_w:
            alpha[:, w - fx:] *= ramp.flip(0)[None, :]

    if mask_u8 is not None:
        m = _resize_frame_u8(mask_u8, w, h, "bilinear")
        alpha = alpha * torch.from_numpy(m.astype(np.float32) / 255.0).clamp(0.0, 1.0)

    alpha = alpha.numpy()[..., None]
    region = orig_u8[y:y + h, x:x + w].astype(np.float32)
    blended = crop * alpha + region * (1 - alpha)
    out = orig_u8.copy()
    out[y:y + h, x:x + w] = (np.clip(blended, 0.0, 255.0) + 0.5).astype(np.uint8)
    return out


def _stream_pipes(dec_specs, enc_specs, frame_fn, n_expected):
    """通用逐帧流式管道。

    dec_specs: [(path, w, h, pixfmt)]  pixfmt: 'rgb24' | 'gray'
    enc_specs: [(out_path, w, h, fps, pixfmt, is_mask)]
    frame_fn(frames: list[np.ndarray]) -> list[np.ndarray] 与 enc_specs 对齐

    只处理前 n_expected 帧(调用方取各源帧数的最小值),任一路先耗尽即停止。
    停止后仍有剩余帧未消费的解码进程必须主动终止:只关 stdout 的话 ffmpeg
    写管道会得到 EPIPE(AVERROR(EPIPE),Windows 上回显为 4294967264)并非零
    退出,会被误判成解码失败。
    """
    decoders, encoders = [], []
    try:
        for path, w, h, fmt in dec_specs:
            decoders.append((path, subprocess.Popen(
                [FFMPEG_PATH, "-noautorotate", "-loglevel", "warning", "-i", path,
                 "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", fmt, "-"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE), fmt, w, h))
        for out_path, w, h, fps, fmt, is_mask in enc_specs:
            vcodec = (["-c:v", "libx264", "-preset", "veryfast", "-qp", "0",
                       "-pix_fmt", "gray"] if is_mask else
                      ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                       "-pix_fmt", "yuv420p", "-movflags", "+faststart"])
            encoders.append((subprocess.Popen(
                [FFMPEG_PATH, "-y", "-loglevel", "warning",
                 "-f", "rawvideo", "-pix_fmt", fmt,
                 "-s", f"{w}x{h}", "-framerate", f"{fps:.6f}", "-i", "-"]
                + vcodec + [out_path],
                stdin=subprocess.PIPE, stderr=subprocess.PIPE), out_path))

        def unit(fmt):
            return 3 if fmt == "rgb24" else 1

        count = 0
        eof_idx = -1
        while count < n_expected:
            frames = []
            for idx, (_, proc, fmt, w, h) in enumerate(decoders):
                size = w * h * unit(fmt)
                buf = proc.stdout.read(size)
                if not buf or len(buf) < size:
                    eof_idx = idx
                    break
                if fmt == "rgb24":
                    frames.append(np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3))
                else:
                    frames.append(np.frombuffer(buf, dtype=np.uint8).reshape(h, w))
            if eof_idx >= 0:
                break
            outs = frame_fn(frames)
            try:
                for (proc, _), o in zip(encoders, outs):
                    proc.stdin.write(np.ascontiguousarray(o).tobytes())
            except OSError:
                break  # 编码器提前退出:退出码与 stderr 在收尾处统一报告
            count += 1

        errors = []
        for proc, out_path in encoders:
            try:
                proc.stdin.close()
            except OSError:
                pass
            err = proc.stderr.read()
            if proc.wait() != 0:
                errors.append(
                    f"encoder -> {os.path.basename(out_path)}: "
                    f"{(err or b'').decode('utf-8', errors='replace')[-500:]}")
        for idx, (path, proc, fmt, w, h) in enumerate(decoders):
            if idx != eof_idx and proc.poll() is None:
                # 剩余帧不再消费(已处理够帧数,或其它流先耗尽):主动终止
                try:
                    proc.stdout.close()
                except Exception:
                    pass
                proc.kill()
                proc.wait()
                proc.stderr.read()
                continue
            try:
                proc.stdout.close()
            except Exception:
                pass
            err = proc.stderr.read()
            if proc.wait() != 0:
                errors.append(
                    f"decoder ({os.path.basename(path)}) exited with "
                    f"{proc.returncode}: "
                    f"{(err or b'').decode('utf-8', errors='replace')[-500:]}")
        if errors:
            raise RuntimeError("; ".join(errors))
        if count != n_expected:
            print(f"[stream] warning: processed {count} frames, expected {n_expected} "
                  f"(truncated to the shortest source)")
        return count
    finally:
        for proc, _ in encoders:
            if proc.poll() is None:
                try:
                    proc.stdin.close()
                except Exception:
                    pass
                proc.kill()
        for _, proc, _, _, _ in decoders:
            if proc.poll() is None:
                proc.kill()


def _info_sidecar_path(key):
    return os.path.join(CACHE_DIR, f"{key}_info.json")


def _video_crop_params(mode, crop_scale, aspect_ratio, padding, prefer,
                       pad_surplus_tol, zoom_step, seamless_loop,
                       mask_threshold, divisible_by, upscale_megapixels):
    return {
        "mode": mode, "crop_scale": crop_scale, "aspect_ratio": aspect_ratio,
        "padding": padding, "prefer": prefer, "pad_surplus_tol": pad_surplus_tol,
        "zoom_step": zoom_step, "seamless_loop": seamless_loop,
        "mask_threshold": mask_threshold, "divisible_by": divisible_by,
        "upscale_megapixels": upscale_megapixels,
    }


class VideoSubjectCropNode:
    """按主体掩码逐帧规划裁剪框,流式裁出等尺寸视频(带磁盘缓存)。

    规划仅逐帧记录主体范围(内存恒定);执行为 rawvideo 逐帧管道。
    输出 cropped_image_video(crf18)+ cropped_mask_video(无损灰度)
    + VIDEO_SUBJECT_CROP_INFO。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_video": ("VIDEO",),
                "mask_video": ("VIDEO", {"tooltip": "主体掩码视频,帧数须与 image_video 一致"}),
                "mode": (_MODES,),
                "crop_scale": ("FLOAT", {"default": 1.5, "min": 0.0, "max": 4.0, "step": 0.05}),
                "aspect_ratio": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 10.0, "step": 0.01}),
                "padding": (["guaranteed", "firm", "flexible"], {"default": "firm"}),
                "prefer": (["stillness", "tightness"], {"default": "stillness"}),
                "pad_surplus_tol": ("INT", {"default": 16, "min": 1, "max": 999}),
                "zoom_step": ("FLOAT", {"default": 1.0, "min": 1.0, "max": 4.0, "step": 0.05}),
                "seamless_loop": ("BOOLEAN", {"default": False}),
                "mask_threshold": ("FLOAT", {"default": 0.1, "min": 0.0, "max": 1.0, "step": 0.01}),
                "divisible_by": ("INT", {"default": 16, "min": 1}),
                "upscale_megapixels": ("FLOAT", {"default": 0.0, "min": -16.0, "max": 16.0, "step": 0.05}),
            },
        }

    RETURN_TYPES = ("VIDEO", "VIDEO", "VIDEO_SUBJECT_CROP_INFO")
    RETURN_NAMES = ("cropped_image_video", "cropped_mask_video", "subject_crop_info")
    FUNCTION = "crop"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(s, image_video, mask_video, **kwargs):
        return _is_changed_tag(
            [_video_source_path(image_video) if image_video else None,
             _video_source_path(mask_video) if mask_video else None],
            _video_crop_params(**{k: v for k, v in kwargs.items()
                                   if k in _video_crop_params.__code__.co_varnames}))

    def crop(self, image_video, mask_video, mode, crop_scale, aspect_ratio,
             padding, prefer, pad_surplus_tol, zoom_step, seamless_loop,
             mask_threshold, divisible_by, upscale_megapixels):
        image_path = _video_source_path(image_video)
        mask_path = _video_source_path(mask_video)
        imeta, mmeta = get_video_metadata(image_path), get_video_metadata(mask_path)
        if imeta["width"] != mmeta["width"] or imeta["height"] != mmeta["height"]:
            raise ValueError(f"image_video ({imeta['width']}x{imeta['height']}) and mask_video ({mmeta['width']}x{mmeta['height']}) must have the same dimensions")
        if imeta["frame_count"] != mmeta["frame_count"]:
            raise ValueError(f"image_video ({imeta['frame_count']} frames) and mask_video ({mmeta['frame_count']} frames) must have the same frame count")
        if 0.0 < crop_scale < 1.0:
            raise ValueError("crop_scale must be 0 (full frame) or at least 1.0")

        params = _video_crop_params(mode, crop_scale, aspect_ratio, padding,
                                    prefer, pad_surplus_tol, zoom_step,
                                    seamless_loop, mask_threshold,
                                    divisible_by, upscale_megapixels)
        key = compute_transform_key("VideoSubjectCropNode",
                                     {"image": image_path, "mask": mask_path},
                                     params)
        hit = cache_lookup(key)
        if hit is not None:
            info_path = _info_sidecar_path(key)
            if os.path.exists(info_path):
                with open(info_path, "r", encoding="utf-8") as f:
                    info = json.load(f)
                print(f"[VideoSubjectCropNode] Cache hit: {key[:12]}")
                return io.NodeOutput(
                    _video_output(hit["image"]), _video_output(hit["mask"]),
                    info, ui=_preview_ui(hit["image"]))

        img_w, img_h = imeta["width"], imeta["height"]
        n = imeta["frame_count"]
        full_frame = crop_scale <= 0.0

        # 流式规划:逐帧范围 → LP
        n_dec, tracks = _stream_mask_extents(mask_path, mask_threshold, mmeta)
        if full_frame:
            boxes = [{"x": 0, "y": 0, "width": img_w, "height": img_h}
                     for _ in range(n)]
            info = {"aspect": img_w / img_h}
        else:
            boxes, info = _plan_boxes(
                n, img_h, img_w, *tracks, mode,
                _build_p(mode, crop_scale, aspect_ratio, padding, prefer,
                         pad_surplus_tol, zoom_step, seamless_loop),
                divisible_by)

        size, img_method, mask_method = _resolve_output_size(
            boxes, info, mode, full_frame, divisible_by,
            upscale_megapixels, img_w, img_h)

        # 完全无需处理:整帧直通
        if all(b == {"x": 0, "y": 0, "width": img_w, "height": img_h} for b in boxes) \
                and (size is None or size == (img_w, img_h)):
            info_out = _make_info(boxes, info, mode, img_w, img_h, n, None)
            print("[VideoSubjectCropNode] full-frame passthrough")
            return io.NodeOutput(
                _video_output(image_path), _video_output(mask_path), info_out,
                ui=_preview_ui(image_path))

        tw, th = size if size is not None else (boxes[0]["width"], boxes[0]["height"])
        out_image, out_mask = cache_output_paths(key)
        print(f"[VideoSubjectCropNode] {n} frames {img_w}x{img_h} -> {tw}x{th} ({mode})")

        state = {"i": 0}

        def frame_fn(frames):
            img_f, mask_f = frames
            i = state["i"]
            state["i"] += 1
            return [
                _crop_resize_u8(img_f, boxes[i], size, img_method),
                _crop_resize_u8(mask_f, boxes[i], size, mask_method),
            ]

        _stream_pipes(
            [(image_path, img_w, img_h, "rgb24"),
             (mask_path, img_w, img_h, "gray")],
            [(out_image, tw, th, imeta["fps"], "rgb24", False),
             (out_mask, tw, th, imeta["fps"], "gray", True)],
            frame_fn, n)

        info_out = _make_info(boxes, info, mode, img_w, img_h, n, size)
        cache_store(key, out_image, out_mask)
        with open(_info_sidecar_path(key), "w", encoding="utf-8") as f:
            json.dump(info_out, f)
        return io.NodeOutput(
            _video_output(out_image), _video_output(out_mask), info_out,
            ui=_preview_ui(out_image))


class VideoRecoverSubjectCropNode:
    """把处理后的裁剪视频贴回原始视频(羽化边缘,可选掩码限制),带磁盘缓存。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "cropped_image_video": ("VIDEO", {"tooltip": "处理后的裁剪视频"}),
                "original_image_video": ("VIDEO", {"tooltip": "要贴回的原始视频"}),
                "subject_crop_info": ("VIDEO_SUBJECT_CROP_INFO", {"tooltip": "来自 VideoSubjectCropNode 的裁剪信息"}),
                "feather": ("INT", {"default": 16, "min": 0, "tooltip": "羽化宽度(像素);贴到视频边缘的边不羽化"}),
            },
            "optional": {
                "mask_video": ("VIDEO", {"tooltip": "限制粘贴区域的掩码视频(任意分辨率,与裁剪帧对应);原样使用,需软边请预先模糊"}),
            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("image_video",)
    FUNCTION = "recover"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(s, cropped_image_video, original_image_video,
                   subject_crop_info, feather, mask_video=None):
        info = subject_crop_info or {}
        return _is_changed_tag(
            [_video_source_path(cropped_image_video) if cropped_image_video else None,
             _video_source_path(original_image_video) if original_image_video else None,
             _video_source_path(mask_video) if mask_video else None],
            {"feather": feather,
             "info": json.dumps(info, sort_keys=True, default=str)[:4096]})

    def recover(self, cropped_image_video, original_image_video,
                subject_crop_info, feather, mask_video=None):
        crop_path = _video_source_path(cropped_image_video)
        orig_path = _video_source_path(original_image_video)
        mask_path = _video_source_path(mask_video) if mask_video is not None else None

        cmeta, ometa = get_video_metadata(crop_path), get_video_metadata(orig_path)
        boxes = subject_crop_info["boxes"]
        img_w, img_h = ometa["width"], ometa["height"]
        src_w, src_h = subject_crop_info.get("source_width", img_w), subject_crop_info.get("source_height", img_h)

        counts = {"cropped": cmeta["frame_count"], "original": ometa["frame_count"]}
        if len(boxes) > 1:
            counts["boxes"] = len(boxes)
        if mask_path:
            counts["mask"] = get_video_metadata(mask_path)["frame_count"]
        n = min(counts.values())
        if n < max(counts.values()):
            got = ", ".join(f"{k}={v}" for k, v in counts.items())
            print(f"[VideoRecoverSubjectCropNode] frame counts differ ({got}), using the first {n} frames of each")
        if len(boxes) == 1:
            boxes = boxes * n
        else:
            boxes = boxes[:n]

        params = {"feather": feather,
                  "info": json.dumps(subject_crop_info, sort_keys=True, default=str)[:4096]}
        key = compute_transform_key(
            "VideoRecoverSubjectCropNode",
            {"cropped": crop_path, "original": orig_path, "mask": mask_path},
            params)
        hit = cache_lookup(key)
        if hit is not None:
            print(f"[VideoRecoverSubjectCropNode] Cache hit: {key[:12]}")
            return io.NodeOutput(_video_output(hit["image"]), ui=_preview_ui(hit["image"]))

        # 完全无需处理:无掩码、无羽化、且源信息与目标同尺寸的整帧直通
        if mask_path is None and feather == 0 and \
                all(b == {"x": 0, "y": 0, "width": src_w, "height": src_h} for b in boxes) \
                and cmeta["width"] == src_w and cmeta["height"] == src_h:
            print("[VideoRecoverSubjectCropNode] passthrough")
            return io.NodeOutput(_video_output(orig_path), ui=_preview_ui(orig_path))

        out_path, _ = cache_output_paths(key)
        print(f"[VideoRecoverSubjectCropNode] {n} frames -> {img_w}x{img_h}")

        mmeta = get_video_metadata(mask_path) if mask_path else None
        dec_specs = [(crop_path, cmeta["width"], cmeta["height"], "rgb24"),
                     (orig_path, img_w, img_h, "rgb24")]
        if mask_path:
            dec_specs.append((mask_path, mmeta["width"], mmeta["height"], "gray"))

        state = {"i": 0}

        def frame_fn(frames):
            crop_f, orig_f = frames[0], frames[1]
            mask_f = frames[2] if len(frames) > 2 else None
            out = _paste_frame_u8(crop_f, orig_f, boxes[state["i"]], feather, mask_f)
            state["i"] += 1
            return [out]

        _stream_pipes(
            dec_specs,
            [(out_path, img_w, img_h, ometa["fps"], "rgb24", False)],
            frame_fn, n)

        cache_store(key, out_path)
        return io.NodeOutput(_video_output(out_path), ui=_preview_ui(out_path))
