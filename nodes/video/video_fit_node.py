# -*- coding: utf-8 -*-
"""
视频几何变换系列节点(与 Image 系列节点参数对齐,输入/输出均为 VIDEO 类型):

- VideoLimitPixelNode     参照 ImageLimitPixelNode:限制像素数,等比缩放
- VideoMeetNode            参照 ImageMeetNode:等比缩放至完全覆盖,居中裁剪
- VideoFitNode             参照 ImageFitNode:等比缩放至完整放入,留边填充
- VideoRecoverResizeNode   参照 ImageRecoverResizeNode:还原到原始尺寸
- VideoRecoverMeetNode     参照 ImageRecoverMeetNode:还原 Meet(支持背景完美还原)
- VideoRecoverFitNode      参照 ImageRecoverFitNode:还原 Fit(裁掉留边后缩放回原尺寸)

变换通过捆绑的 ffmpeg 完成(纯 CPU);结果按
md5(节点名 + 源/掩码/背景内容哈希 + 参数 + 算法版本) 磁盘缓存,
相同输入直接复用文件——不产生新的视频拷贝、不重编码。
"""
import json
import os

import folder_paths
from comfy_api.latest import io, ui, InputImpl

from ...libs.video_utils import get_video_metadata
from ...libs.video_transform import (
    CACHE_SUBFOLDER,
    cache_lookup,
    cache_output_paths,
    cache_store,
    compute_transform_key,
    compute_fit_dims,
    compute_limit_pixel_dims,
    compute_meet_dims,
    interpolation_flag,
    parse_padding_color,
    transform_recover_meet_with_background,
    transform_video_file,
    video_stream_to_file,
)

CATEGORY = "Kolid-Toolkit"


# ============================================================
# 公共辅助
# ============================================================

def _video_source_path(video):
    """从 VIDEO 对象解析源文件路径并校验存在。

    内存视频(VideoFromComponents / VideoFromList 等)的
    get_stream_source() 返回 BytesIO,先落盘到 videocache 再用路径处理。
    """
    if video is None:
        return None
    source = (video.get_stream_source()
              if hasattr(video, "get_stream_source") else str(video))
    if hasattr(source, "read"):
        source = video_stream_to_file(source)
    else:
        source = os.fspath(source)
    if not os.path.exists(source):
        raise FileNotFoundError(f"Video file not found: {source}")
    return source


def _validate_mask_video(mask_path, src_w, src_h, src_frame_count=0):
    """校验 mask_video 尺寸与 image_video 一致(与 Image 系列节点同规则)。"""
    if mask_path is None:
        return
    mmeta = get_video_metadata(mask_path)
    if mmeta["width"] != src_w or mmeta["height"] != src_h:
        raise ValueError(
            f"mask_video: {mmeta['width']}x{mmeta['height']} "
            f"img_video: {src_w}x{src_h} Mask的尺寸与image不同!")
    if src_frame_count > 0 and mmeta["frame_count"] > 0 and mmeta["frame_count"] != src_frame_count:
        print(f"[VideoTransform] Warning: mask frame count {mmeta['frame_count']} "
              f"!= image {src_frame_count}")


def _preview_ui(image_path, mask_path=None):
    """构造 PreviewVideo UI。

    缓存输出在 output/videocache 下(FolderType.output);
    直通源文件(用户上传)在 input 下(FolderType.input)。
    """
    input_dir = folder_paths.get_input_directory()
    output_dir = folder_paths.get_output_directory()
    results = []
    for p in (image_path, mask_path):
        if p is None:
            continue
        ap = os.path.abspath(p)
        if ap.startswith(output_dir + os.sep) or ap == output_dir:
            folder, base = io.FolderType.output, output_dir
        elif ap.startswith(input_dir + os.sep) or ap == input_dir:
            folder, base = io.FolderType.input, input_dir
        else:
            folder, base = io.FolderType.input, None
        subfolder = os.path.relpath(os.path.dirname(ap), base) if base else ""
        results.append(ui.SavedResult(os.path.basename(ap), subfolder, folder))
    if not results:
        return None
    return ui.PreviewVideo(results)


def _transform_and_cache(node_name, sources, params,
                         image_filters, mask_filters, bg_spec=None):
    """缓存查找 → 命中直接复用;未命中执行 ffmpeg 并入缓存。

    sources: {"source": 路径, "mask": 路径或 None, "background": 路径或 None}
    返回 (image_path, mask_path 或 None)。
    """
    key = compute_transform_key(node_name, sources, params)
    hit = cache_lookup(key)
    if hit is not None:
        print(f"[{node_name}] Cache hit: {key[:12]}")
        return hit["image"], hit["mask"]

    out_path, mask_out_path = cache_output_paths(key)
    source = sources.get("source")
    mask = sources.get("mask")

    print(f"[{node_name}] Cache miss: {key[:12]} -> encoding")
    if bg_spec is not None:
        # RecoverMeet 带 background:前景缩放回内容区域后叠加到背景上(完美还原)
        transform_recover_meet_with_background(
            source, bg_spec["background"], out_path,
            bg_spec["region_w"], bg_spec["region_h"],
            bg_spec["region_x"], bg_spec["region_y"],
            bg_spec["orig_w"], bg_spec["orig_h"], bg_spec["flag"])
    else:
        transform_video_file(source, out_path, image_filters, "image")

    mask_out = None
    if mask is not None:
        transform_video_file(mask, mask_out_path, mask_filters, "mask")
        mask_out = mask_out_path

    cache_store(key, out_path, mask_out)
    print(f"[{node_name}] Cached: image={os.path.basename(out_path)}")
    return out_path, mask_out


def _info_json(info):
    try:
        return json.dumps(info, sort_keys=True, ensure_ascii=False)
    except Exception:
        return str(info)


def _is_changed_tag(paths, params):
    """IS_CHANGED 公共标签:路径 + mtime + 参数。"""
    parts = []
    for p in paths:
        if not p:
            parts.append("none")
            continue
        try:
            parts.append(f"{p}_{os.path.getmtime(p)}")
        except OSError:
            parts.append(str(p))
    parts.append(_info_json(params))
    return "_".join(parts)


def _video_output(image_path):
    return InputImpl.VideoFromFile(image_path)


# ============================================================
# VideoLimitPixelNode(参照 ImageLimitPixelNode)
# ============================================================

class VideoLimitPixelNode:
    """限制视频像素数,超出时等比缩放(保持宽高比 + 网格对齐)。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_video": ("VIDEO", {
                    "tooltip": "Input video to limit pixel count"
                }),
                "pixels": ("INT", {
                    "default": 1024 * 1024,  # 1MP
                    "min": 1,
                    "max": 1024 * 1024 * 1024,
                    "tooltip": "Maximum allowed pixel count"
                }),
                "align": ("INT", {
                    "default": 1,
                    "min": 1,
                    "max": 1024 * 1024 * 1024,
                    "tooltip": "Align the resized video to the nearest pixel grid"
                }),
            },
            "optional": {
                "mask_video": ("VIDEO", {
                    "tooltip": "Optional mask video to resize alongside image video"
                }),
            },
        }

    RETURN_TYPES = ("VIDEO", "VIDEO", "VIDEO_RESIZE_INFO")
    RETURN_NAMES = ("image_video", "mask_video", "resize_info")
    FUNCTION = "limit_pixels"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(s, image_video, pixels, align, mask_video=None):
        return _is_changed_tag(
            [_video_source_path(image_video) if image_video else None,
             _video_source_path(mask_video) if mask_video else None],
            {"pixels": pixels, "align": align})

    def limit_pixels(self, image_video, pixels, align, mask_video=None):
        source = _video_source_path(image_video)
        mask = _video_source_path(mask_video) if mask_video is not None else None

        meta = get_video_metadata(source)
        src_w, src_h = meta["width"], meta["height"]
        _validate_mask_video(mask, src_w, src_h, meta.get("frame_count", 0))

        new_w, new_h = compute_limit_pixel_dims(src_w, src_h, pixels, align)

        resize_info = {
            "original_width": src_w,
            "original_height": src_h,
            "resized_width": new_w,
            "resized_height": new_h,
            "aspect_ratio": src_w / src_h if src_h != 0 else 1.0,
            "scale_factor": new_w / src_w,
            "align": align,
            "was_upscaled": src_w * src_h < pixels
        }

        if (new_w, new_h) == (src_w, src_h):
            # 无需变换,透传源文件
            print(f"[VideoLimitPixelNode] {src_w}x{src_h} within limit, passthrough")
            results = [_video_output(source), None, resize_info]
            return io.NodeOutput(*results, ui=_preview_ui(source, mask))

        print(f"[VideoLimitPixelNode] {src_w}x{src_h} ({src_w * src_h:,} px) "
              f"-> {new_w}x{new_h} | align={align}")

        filters = f"scale={new_w}:{new_h}:flags=bicubic"
        out_path, mask_out = _transform_and_cache(
            "VideoLimitPixelNode",
            {"source": source, "mask": mask},
            {"pixels": pixels, "align": align},
            filters, filters)

        results = [_video_output(out_path),
                   _video_output(mask_out) if mask_out else None,
                   resize_info]
        return io.NodeOutput(*results, ui=_preview_ui(out_path, mask_out))


# ============================================================
# VideoMeetNode(参照 ImageMeetNode)
# ============================================================

class VideoMeetNode:
    """等比缩放视频至完全覆盖画布(允许超出),居中裁剪。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_video": ("VIDEO",),
                "width": ("INT", {"default": 0, "min": 0, "max": 2048, "step": 8}),
                "height": ("INT", {"default": 0, "min": 0, "max": 2048, "step": 8}),
                "interpolation": (["nearest", "bilinear", "bicubic"], {"default": "bilinear"}),
            },
            "optional": {
                "mask_video": ("VIDEO",),
            }
        }

    RETURN_TYPES = ("VIDEO", "VIDEO_MEET_INFO", "VIDEO")
    RETURN_NAMES = ("image_video", "meet_info", "mask_video")
    FUNCTION = "meet"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(s, image_video, width, height, interpolation, mask_video=None):
        return _is_changed_tag(
            [_video_source_path(image_video) if image_video else None,
             _video_source_path(mask_video) if mask_video else None],
            {"width": width, "height": height, "interpolation": interpolation})

    def meet(self, image_video, width, height, interpolation, mask_video=None):
        source = _video_source_path(image_video)
        mask = _video_source_path(mask_video) if mask_video is not None else None

        meta = get_video_metadata(source)
        src_w, src_h = meta["width"], meta["height"]
        _validate_mask_video(mask, src_w, src_h, meta.get("frame_count", 0))

        (target_w, target_h, offset_x, offset_y,
         region_x, region_y, region_w, region_h) = compute_meet_dims(src_w, src_h, width, height)

        meet_info = {
            "x": offset_x,
            "y": offset_y,
            "originalWidth": src_w,
            "originalHeight": src_h,
            "targetWidth": target_w,
            "targetHeight": target_h,
            "regionX": region_x,
            "regionY": region_y,
            "regionWidth": region_w,
            "regionHeight": region_h
        }

        print(f"[VideoMeetNode] {src_w}x{src_h} -> {width}x{height} "
              f"(scale {target_w}x{target_h}, crop at {offset_x},{offset_y})")

        flag = interpolation_flag(interpolation)
        filters = (f"scale={target_w}:{target_h}:flags={flag},"
                   f"crop={width}:{height}:{offset_x}:{offset_y}")
        out_path, mask_out = _transform_and_cache(
            "VideoMeetNode",
            {"source": source, "mask": mask},
            {"width": width, "height": height, "interpolation": interpolation},
            filters, filters)

        results = [_video_output(out_path), meet_info,
                   _video_output(mask_out) if mask_out else None]
        return io.NodeOutput(*results, ui=_preview_ui(out_path, mask_out))


# ============================================================
# VideoFitNode(参照 ImageFitNode)
# ============================================================

class VideoFitNode:
    """等比缩放视频至完整放入画布(允许留边),留边用 padding_color 填充。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_video": ("VIDEO",),
                "width": ("INT", {"default": 0, "min": 0, "max": 2048, "step": 8}),
                "height": ("INT", {"default": 0, "min": 0, "max": 2048, "step": 8}),
                "interpolation": (["nearest", "bilinear", "bicubic"], {"default": "bilinear"}),
                "padding_color": ("STRING", {"default": "255, 255, 255"}),
            },
            "optional": {
                "mask_video": ("VIDEO",),
            }
        }

    RETURN_TYPES = ("VIDEO", "VIDEO_FIT_INFO", "VIDEO")
    RETURN_NAMES = ("image_video", "fit_info", "mask_video")
    FUNCTION = "fit"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(s, image_video, width, height, interpolation, padding_color,
                   mask_video=None):
        return _is_changed_tag(
            [_video_source_path(image_video) if image_video else None,
             _video_source_path(mask_video) if mask_video else None],
            {"width": width, "height": height, "interpolation": interpolation,
             "padding_color": padding_color})

    def fit(self, image_video, width, height, interpolation, padding_color, mask_video=None):
        source = _video_source_path(image_video)
        mask = _video_source_path(mask_video) if mask_video is not None else None

        meta = get_video_metadata(source)
        src_w, src_h = meta["width"], meta["height"]
        _validate_mask_video(mask, src_w, src_h, meta.get("frame_count", 0))

        target_w, target_h, offset_x, offset_y = compute_fit_dims(src_w, src_h, width, height)

        fit_info = {
            "x": offset_x,
            "y": offset_y,
            "originalWidth": src_w,
            "originalHeight": src_h,
            "targetWidth": target_w,
            "targetHeight": target_h
        }

        print(f"[VideoFitNode] {src_w}x{src_h} -> {width}x{height} "
              f"(scale {target_w}x{target_h}, pad at {offset_x},{offset_y})")

        flag = interpolation_flag(interpolation)
        color = parse_padding_color(padding_color)
        filters = (f"scale={target_w}:{target_h}:flags={flag},"
                   f"pad={width}:{height}:{offset_x}:{offset_y}:color={color}")
        out_path, mask_out = _transform_and_cache(
            "VideoFitNode",
            {"source": source, "mask": mask},
            {"width": width, "height": height, "interpolation": interpolation,
             "padding_color": color},
            filters, filters)

        results = [_video_output(out_path), fit_info,
                   _video_output(mask_out) if mask_out else None]
        return io.NodeOutput(*results, ui=_preview_ui(out_path, mask_out))


# ============================================================
# VideoRecoverResizeNode(参照 ImageRecoverResizeNode)
# ============================================================

class VideoRecoverResizeNode:
    """使用 resize_info 将视频还原回原始尺寸。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_video": ("VIDEO", {
                    "tooltip": "Input video to recover"
                }),
                "resize_info": ("VIDEO_RESIZE_INFO", {
                    "tooltip": "Resize information from VideoLimitPixelNode"
                }),
            },
            "optional": {
                "mask_video": ("VIDEO", {
                    "tooltip": "Optional mask video to recover alongside image video"
                }),
            },
        }

    RETURN_TYPES = ("VIDEO", "VIDEO")
    RETURN_NAMES = ("image_video", "mask_video")
    FUNCTION = "recover_size"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(s, image_video, resize_info, mask_video=None):
        return _is_changed_tag(
            [_video_source_path(image_video) if image_video else None,
             _video_source_path(mask_video) if mask_video else None],
            {"resize_info": resize_info})

    def recover_size(self, image_video, resize_info, mask_video=None):
        source = _video_source_path(image_video)
        mask = _video_source_path(mask_video) if mask_video is not None else None

        orig_w = resize_info.get("original_width")
        orig_h = resize_info.get("original_height")
        if orig_w is None or orig_h is None:
            raise ValueError("Resize info missing original dimensions")

        meta = get_video_metadata(source)
        if meta["width"] == orig_w and meta["height"] == orig_h:
            # 尺寸已一致,透传
            print(f"[VideoRecoverResizeNode] already {orig_w}x{orig_h}, passthrough")
            return io.NodeOutput(_video_output(source), None,
                                 ui=_preview_ui(source, mask))

        print(f"[VideoRecoverResizeNode] {meta['width']}x{meta['height']} "
              f"-> {orig_w}x{orig_h}")

        filters = f"scale={orig_w}:{orig_h}:flags=bicubic"
        out_path, mask_out = _transform_and_cache(
            "VideoRecoverResizeNode",
            {"source": source, "mask": mask},
            {"resize_info": resize_info},
            filters, filters)

        return io.NodeOutput(_video_output(out_path),
                             _video_output(mask_out) if mask_out else None,
                             ui=_preview_ui(out_path, mask_out))


# ============================================================
# VideoRecoverMeetNode(参照 ImageRecoverMeetNode)
# ============================================================

class VideoRecoverMeetNode:
    """使用 meet_info 将 Meet 后的视频还原回原始尺寸。

    提供 background 时完美还原(被裁剪的边缘保留背景内容),
    否则有损还原(被裁剪的边缘用 padding_color 填充)。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_video": ("VIDEO",),
                "meet_info": ("VIDEO_MEET_INFO",),
                "interpolation": (["nearest", "bilinear", "bicubic"], {"default": "bilinear"}),
                "padding_color": ("STRING", {"default": "255, 255, 255"}),
            },
            "optional": {
                "background": ("VIDEO",),
                "mask_video": ("VIDEO",),
            }
        }

    RETURN_TYPES = ("VIDEO", "VIDEO")
    RETURN_NAMES = ("image_video", "mask_video")
    FUNCTION = "recover_meet"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(s, image_video, meet_info, interpolation, padding_color,
                   background=None, mask_video=None):
        return _is_changed_tag(
            [_video_source_path(image_video) if image_video else None,
             _video_source_path(background) if background else None,
             _video_source_path(mask_video) if mask_video else None],
            {"meet_info": meet_info, "interpolation": interpolation,
             "padding_color": padding_color})

    def recover_meet(self, image_video, meet_info, interpolation, padding_color,
                     background=None, mask_video=None):
        source = _video_source_path(image_video)
        mask = _video_source_path(mask_video) if mask_video is not None else None

        region_x = meet_info["regionX"]
        region_y = meet_info["regionY"]
        region_w = meet_info["regionWidth"]
        region_h = meet_info["regionHeight"]

        orig_w = meet_info["originalWidth"]
        orig_h = meet_info["originalHeight"]

        flag = interpolation_flag(interpolation)
        color = parse_padding_color(padding_color)

        print(f"[VideoRecoverMeetNode] -> {orig_w}x{orig_h} "
              f"(region {region_w}x{region_h} at {region_x},{region_y})")

        sources = {"source": source, "mask": mask}
        params = {"meet_info": meet_info, "interpolation": interpolation,
                  "padding_color": color}
        bg_spec = None

        if background is not None:
            # 贴回背景视频,完美还原(被裁剪的边缘保留背景内容)
            bg_path = _video_source_path(background)
            bg_meta = get_video_metadata(bg_path)
            if bg_meta["width"] != orig_w or bg_meta["height"] != orig_h:
                raise ValueError(
                    f"background:{bg_meta['width']}x{bg_meta['height']} "
                    f"meetInfo原图尺寸:{orig_w}x{orig_h} 不匹配!")
            sources["background"] = bg_path
            bg_spec = {
                "background": bg_path,
                "region_w": region_w, "region_h": region_h,
                "region_x": region_x, "region_y": region_y,
                "orig_w": orig_w, "orig_h": orig_h,
                "flag": flag,
            }
            image_filters = None
        else:
            # 有损还原:缩放回内容区域后 pad 到原尺寸
            image_filters = (f"scale={region_w}:{region_h}:flags={flag},"
                             f"pad={orig_w}:{orig_h}:{region_x}:{region_y}:color={color}")

        # mask 无背景概念,固定用黑色(0)填充画布外区域
        mask_filters = (f"scale={region_w}:{region_h}:flags={flag},"
                        f"pad={orig_w}:{orig_h}:{region_x}:{region_y}:color=black")

        out_path, mask_out = _transform_and_cache(
            "VideoRecoverMeetNode", sources, params,
            image_filters, mask_filters, bg_spec=bg_spec)

        return io.NodeOutput(_video_output(out_path),
                             _video_output(mask_out) if mask_out else None,
                             ui=_preview_ui(out_path, mask_out))


# ============================================================
# VideoRecoverFitNode(参照 ImageRecoverFitNode)
# ============================================================

class VideoRecoverFitNode:
    """使用 fit_info 将 Fit 后的视频还原:裁掉留边,缩放回原始尺寸。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_video": ("VIDEO",),
                "fit_info": ("VIDEO_FIT_INFO",),
                "interpolation": (["nearest", "bilinear", "bicubic"], {"default": "bilinear"}),
            },
            "optional": {
                "mask_video": ("VIDEO",),
            }
        }

    RETURN_TYPES = ("VIDEO", "VIDEO")
    RETURN_NAMES = ("image_video", "mask_video")
    FUNCTION = "recover_fit"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(s, image_video, fit_info, interpolation, mask_video=None):
        return _is_changed_tag(
            [_video_source_path(image_video) if image_video else None,
             _video_source_path(mask_video) if mask_video else None],
            {"fit_info": fit_info, "interpolation": interpolation})

    def recover_fit(self, image_video, fit_info, interpolation, mask_video=None):
        source = _video_source_path(image_video)
        mask = _video_source_path(mask_video) if mask_video is not None else None

        target_w = fit_info["targetWidth"]
        target_h = fit_info["targetHeight"]
        x = fit_info["x"]
        y = fit_info["y"]
        orig_w = fit_info["originalWidth"]
        orig_h = fit_info["originalHeight"]

        print(f"[VideoRecoverFitNode] crop {target_w}x{target_h} at {x},{y} "
              f"-> scale {orig_w}x{orig_h}")

        flag = interpolation_flag(interpolation)
        filters = (f"crop={target_w}:{target_h}:{x}:{y},"
                   f"scale={orig_w}:{orig_h}:flags={flag}")

        out_path, mask_out = _transform_and_cache(
            "VideoRecoverFitNode",
            {"source": source, "mask": mask},
            {"fit_info": fit_info, "interpolation": interpolation},
            filters, filters)

        return io.NodeOutput(_video_output(out_path),
                             _video_output(mask_out) if mask_out else None,
                             ui=_preview_ui(out_path, mask_out))


# ============================================================
# VideoLimitFpsNode(参照 ImageLimitPixelNode 的"限制"语义,作用于帧率)
# ============================================================

class VideoLimitFpsNode:
    """限制视频帧率,超出上限时重采样(fps filter);源帧率未超上限时直通。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_video": ("VIDEO", {
                    "tooltip": "Input video to limit frame rate"
                }),
                "fps": ("FLOAT", {
                    "default": 16.0,
                    "min": 0.1,
                    "max": 960.0,
                    "step": 0.01,
                    "tooltip": "Maximum allowed frame rate"
                }),
            },
            "optional": {
                "mask_video": ("VIDEO", {
                    "tooltip": "Optional mask video to resample alongside image video"
                }),
            },
        }

    RETURN_TYPES = ("VIDEO", "VIDEO")
    RETURN_NAMES = ("image_video", "mask_video")
    FUNCTION = "limit_fps"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(s, image_video, fps, mask_video=None):
        return _is_changed_tag(
            [_video_source_path(image_video) if image_video else None,
             _video_source_path(mask_video) if mask_video else None],
            {"fps": fps})

    def limit_fps(self, image_video, fps, mask_video=None):
        source = _video_source_path(image_video)
        mask = _video_source_path(mask_video) if mask_video is not None else None

        src_fps = float(get_video_metadata(source)["fps"])
        if src_fps <= fps + 1e-6:
            print(f"[VideoLimitFpsNode] {src_fps:g} fps <= {fps:g}, passthrough")
            return io.NodeOutput(
                _video_output(source),
                _video_output(mask) if mask else None,
                ui=_preview_ui(source, mask))

        print(f"[VideoLimitFpsNode] {src_fps:g} -> {fps:g} fps")
        filters = f"fps={fps:g}"
        out_path, mask_out = _transform_and_cache(
            "VideoLimitFpsNode",
            {"source": source, "mask": mask},
            {"fps": fps},
            filters, filters)

        return io.NodeOutput(_video_output(out_path),
                             _video_output(mask_out) if mask_out else None,
                             ui=_preview_ui(out_path, mask_out))
