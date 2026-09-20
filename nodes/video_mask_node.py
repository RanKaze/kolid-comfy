# -*- coding: utf-8 -*-
"""
视频掩码算子系列节点(逐帧流式管道,与参考实现逐算子等价):

- VideoCombineMaskNode 参照 ComfyUI 核心节点 "Combine Masks"(MaskComposite):
  将 source_mask_video 按 (x, y) 贴合到 destination_mask_video 上做逐像素运算
- VideoMaskFixNode     参照 comfyui_essentials 的 "🔧 Mask Fix"(MaskFix):
  腐蚀/膨胀、填洞、去孤立像素、平滑、模糊
- VideoGrowMaskNode     参照 ComfyUI 核心的 "Grow Mask"(GrowMask):
  正向膨胀 / 负向收缩,tapered_corners 十字核或方形核

最佳内存管理:逐帧流式处理(ffmpeg rawvideo 进出),任意时刻每路视频
仅 1 帧驻留内存;输出为无损灰度视频(libx264 -qp 0 + gray,平坦区域压缩
效率高、体积小、边缘零损失),结果按内容哈希+参数磁盘缓存命中复用。
"""
import os

import numpy as np
import scipy.ndimage
import torch
import torchvision.transforms.v2 as T
from comfy_api.latest import io, ui, InputImpl

from ..libs.video_utils import get_video_metadata
from ..libs.video_transform import (
    cache_lookup,
    cache_output_paths,
    cache_store,
    compute_transform_key,
    stream_transform_video,
)
from .video_fit_node import (
    _video_source_path,
    _preview_ui,
    _is_changed_tag,
    _video_output,
)

CATEGORY = "Kolid-Toolkit"


def _u8_to_mask(frame):
    """uint8 灰度帧 → float32 [0,1](参考实现的 MASK 值域)。"""
    return np.ascontiguousarray(frame.astype(np.float32) / 255.0)


def _mask_to_u8(m):
    """float [0,1] → uint8(截断到合法域 + 四舍五入)。"""
    return (np.clip(m, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


def _cache_or_run(node_name, sources, params, run_fn):
    """公共缓存外壳:命中 → 返回缓存路径;未命中 → run_fn(out_path) 执行并入缓存。"""
    key = compute_transform_key(node_name, sources, params)
    hit = cache_lookup(key)
    if hit is not None:
        print(f"[{node_name}] Cache hit: {key[:12]}")
        return hit["image"]
    out_path, _ = cache_output_paths(key)
    print(f"[{node_name}] Cache miss: {key[:12]} -> processing")
    n = run_fn(out_path)
    cache_store(key, out_path)
    print(f"[{node_name}] Cached: {os.path.basename(out_path)} ({n} frames)")
    return out_path


# ============================================================
# VideoCombineMaskNode(参照 ComfyUI 核心 MaskComposite)
# ============================================================

class VideoCombineMaskNode:
    """将 source_mask_video 按 (x, y) 贴合到 destination_mask_video 做逐像素运算。

    语义与核心 MaskComposite 一致:源超出目标画布的部分被裁剪;
    画布外与无重叠区域保持 destination 不变;结果整体 clamp 到 [0, 1]。
    输出尺寸/帧数与 destination_mask_video 一致(副源耗尽后按黑帧参与运算)。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "destination_mask_video": ("VIDEO", {
                    "tooltip": "Base mask video; output size and frame count follow it"
                }),
                "source_mask_video": ("VIDEO", {
                    "tooltip": "Mask video pasted onto the destination at (x, y)"
                }),
                "x": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                "y": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                "operation": (["multiply", "add", "subtract", "and", "or", "xor"],),
            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("mask_video",)
    FUNCTION = "combine"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(s, destination_mask_video, source_mask_video, x, y, operation):
        return _is_changed_tag(
            [_video_source_path(destination_mask_video) if destination_mask_video else None,
             _video_source_path(source_mask_video) if source_mask_video else None],
            {"x": x, "y": y, "operation": operation})

    def combine(self, destination_mask_video, source_mask_video, x, y, operation):
        dst_path = _video_source_path(destination_mask_video)
        src_path = _video_source_path(source_mask_video)

        dmeta = get_video_metadata(dst_path)
        smeta = get_video_metadata(src_path)
        dw, dh = dmeta["width"], dmeta["height"]
        sw, sh = smeta["width"], smeta["height"]

        # 重叠区域(与核心 MaskComposite 相同的裁剪公式,x/y >= 0)
        right = min(x + sw, dw)
        bottom = min(y + sh, dh)
        vw, vh = right - x, bottom - y

        if vw <= 0 or vh <= 0:
            # 无重叠:输出即 destination(原版对越界会切片报错,这里更稳健地透传)
            print(f"[VideoCombineMaskNode] no overlap (x={x}, y={y}), passthrough")
            return io.NodeOutput(_video_output(dst_path), ui=_preview_ui(dst_path))

        if dmeta["frame_count"] > 0 and smeta["frame_count"] > 0 \
                and dmeta["frame_count"] != smeta["frame_count"]:
            print(f"[VideoCombineMaskNode] Warning: source frame count {smeta['frame_count']} "
                  f"!= destination {dmeta['frame_count']}; missing frames treated as black")

        print(f"[VideoCombineMaskNode] {dw}x{dh} + {sw}x{sh} at ({x},{y}) op={operation}")

        def frame_fn(frames):
            dst = torch.from_numpy(_u8_to_mask(frames[0]))
            src = torch.from_numpy(_u8_to_mask(frames[1]))
            out = dst.clone()
            src_portion = src[:vh, :vw]
            dst_portion = out[y:bottom, x:right]
            if operation == "multiply":
                out[y:bottom, x:right] = dst_portion * src_portion
            elif operation == "add":
                out[y:bottom, x:right] = dst_portion + src_portion
            elif operation == "subtract":
                out[y:bottom, x:right] = dst_portion - src_portion
            elif operation == "and":
                out[y:bottom, x:right] = torch.bitwise_and(
                    dst_portion.round().bool(), src_portion.round().bool()).float()
            elif operation == "or":
                out[y:bottom, x:right] = torch.bitwise_or(
                    dst_portion.round().bool(), src_portion.round().bool()).float()
            else:  # xor
                out[y:bottom, x:right] = torch.bitwise_xor(
                    dst_portion.round().bool(), src_portion.round().bool()).float()
            out = torch.clamp(out, 0.0, 1.0)
            return _mask_to_u8(out.numpy())

        out_path = _cache_or_run(
            "VideoCombineMaskNode",
            {"destination": dst_path, "source": src_path},
            {"x": x, "y": y, "operation": operation},
            lambda out: stream_transform_video(
                [(dst_path, dw, dh), (src_path, sw, sh)],
                out, dw, dh, dmeta["fps"], frame_fn))

        return io.NodeOutput(_video_output(out_path), ui=_preview_ui(out_path))


# ============================================================
# VideoMaskFixNode(参照 comfyui_essentials MaskFix)
# ============================================================

class VideoMaskFixNode:
    """掩码视频修复:腐蚀/膨胀 → 填洞 → 去孤立像素 → 平滑 → 模糊。

    算子与 essentials MaskFix 逐一对应:
    - erode_dilate <0 腐蚀 / >0 膨胀(scipy grey_erosion / grey_dilation,size=n×n)
    - fill_holes >0 闭运算填洞(grey_closing,size=n×n)
    - remove_isolated_pixels >0 开运算(grey_opening,size=n×n)
    - smooth >0 二值化(>0.5)后高斯模糊(kernel=n,偶数自动 +1)
    - blur >0 高斯模糊(kernel=n,偶数自动 +1)
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask_video": ("VIDEO",),
                "erode_dilate": ("INT", {"default": 0, "min": -256, "max": 256, "step": 1}),
                "fill_holes": ("INT", {"default": 0, "min": 0, "max": 128, "step": 1}),
                "remove_isolated_pixels": ("INT", {"default": 0, "min": 0, "max": 32, "step": 1}),
                "smooth": ("INT", {"default": 0, "min": 0, "max": 256, "step": 1}),
                "blur": ("INT", {"default": 0, "min": 0, "max": 256, "step": 1}),
            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("mask_video",)
    FUNCTION = "fix"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(s, mask_video, erode_dilate, fill_holes, remove_isolated_pixels,
                   smooth, blur):
        return _is_changed_tag(
            [_video_source_path(mask_video) if mask_video else None],
            {"erode_dilate": erode_dilate, "fill_holes": fill_holes,
             "remove_isolated_pixels": remove_isolated_pixels,
             "smooth": smooth, "blur": blur})

    def fix(self, mask_video, erode_dilate, fill_holes, remove_isolated_pixels, smooth, blur):
        source = _video_source_path(mask_video)

        if erode_dilate == 0 and fill_holes == 0 and remove_isolated_pixels == 0 \
                and smooth == 0 and blur == 0:
            print("[VideoMaskFixNode] all params zero, passthrough")
            return io.NodeOutput(_video_output(source), ui=_preview_ui(source))

        meta = get_video_metadata(source)
        w, h = meta["width"], meta["height"]
        print(f"[VideoMaskFixNode] {w}x{h} erode_dilate={erode_dilate} fill_holes={fill_holes} "
              f"remove_isolated={remove_isolated_pixels} smooth={smooth} blur={blur}")

        def frame_fn(frames):
            m = _u8_to_mask(frames[0])

            # 腐蚀/膨胀
            if erode_dilate != 0:
                n = abs(erode_dilate)
                if erode_dilate < 0:
                    m = scipy.ndimage.grey_erosion(m, size=(n, n))
                else:
                    m = scipy.ndimage.grey_dilation(m, size=(n, n))
            # 填洞(闭运算)
            if fill_holes > 0:
                m = scipy.ndimage.grey_closing(m, size=(fill_holes, fill_holes))
            # 去孤立像素(开运算)
            if remove_isolated_pixels > 0:
                m = scipy.ndimage.grey_opening(
                    m, size=(remove_isolated_pixels, remove_isolated_pixels))
            # 平滑(二值化 + 高斯)
            if smooth > 0:
                k = smooth + 1 if smooth % 2 == 0 else smooth
                t = torch.from_numpy(np.ascontiguousarray(m))
                m = T.functional.gaussian_blur((t > 0.5).float().unsqueeze(0), k).squeeze(0).numpy()
            # 模糊(高斯)
            if blur > 0:
                k = blur + 1 if blur % 2 == 0 else blur
                t = torch.from_numpy(np.ascontiguousarray(m))
                m = T.functional.gaussian_blur(t.unsqueeze(0), k).squeeze(0).numpy()

            return _mask_to_u8(m)

        out_path = _cache_or_run(
            "VideoMaskFixNode",
            {"source": source},
            {"erode_dilate": erode_dilate, "fill_holes": fill_holes,
             "remove_isolated_pixels": remove_isolated_pixels,
             "smooth": smooth, "blur": blur},
            lambda out: stream_transform_video(
                [(source, w, h)], out, w, h, meta["fps"], frame_fn))

        return io.NodeOutput(_video_output(out_path), ui=_preview_ui(out_path))


# ============================================================
# VideoGrowMaskNode(参照 ComfyUI 核心 GrowMask)
# ============================================================

class VideoGrowMaskNode:
    """掩码视频生长:expand >0 膨胀 / <0 收缩,迭代 3x3 形态学核。

    tapered_corners=True 用十字核(角点收缩,边缘圆润),False 用全 3x3 方核
    (与核心 GrowMask 完全一致:scipy grey_erosion/grey_dilation + footprint)。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask_video": ("VIDEO",),
                "expand": ("INT", {"default": 0, "min": -512, "max": 512, "step": 1}),
                "tapered_corners": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("mask_video",)
    FUNCTION = "grow"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(s, mask_video, expand, tapered_corners):
        return _is_changed_tag(
            [_video_source_path(mask_video) if mask_video else None],
            {"expand": expand, "tapered_corners": tapered_corners})

    def grow(self, mask_video, expand, tapered_corners):
        source = _video_source_path(mask_video)

        if expand == 0:
            print("[VideoGrowMaskNode] expand=0, passthrough")
            return io.NodeOutput(_video_output(source), ui=_preview_ui(source))

        meta = get_video_metadata(source)
        w, h = meta["width"], meta["height"]
        print(f"[VideoGrowMaskNode] {w}x{h} expand={expand} tapered={tapered_corners}")

        # 与核心 GrowMask 相同的核:tapered → 十字,否则全 3x3
        c = 0 if tapered_corners else 1
        kernel = np.array([[c, 1, c],
                           [1, 1, 1],
                           [c, 1, c]])

        def frame_fn(frames):
            m = _u8_to_mask(frames[0])
            for _ in range(abs(expand)):
                if expand < 0:
                    m = scipy.ndimage.grey_erosion(m, footprint=kernel)
                else:
                    m = scipy.ndimage.grey_dilation(m, footprint=kernel)
            return _mask_to_u8(m)

        out_path = _cache_or_run(
            "VideoGrowMaskNode",
            {"source": source},
            {"expand": expand, "tapered_corners": tapered_corners},
            lambda out: stream_transform_video(
                [(source, w, h)], out, w, h, meta["fps"], frame_fn))

        return io.NodeOutput(_video_output(out_path), ui=_preview_ui(out_path))
