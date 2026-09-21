# -*- coding: utf-8 -*-
"""
VideoSegmentationNode - 逐帧文本掩码表达式分割节点（SAM3 / EOVSAM3）

参考 ComfyUI-SAM3 的 SAM3Grounding / SAM3VideoSegmentation 设计：
每帧独立进行文本 grounding 检测（非跟踪传播），因此每个术语的
置信度阈值在每一帧上都生效。

输入 image_video（VIDEO），输出 mask_video（VIDEO）：无损灰度掩码视频
（libx264 -qp 0 + gray，与其它 Video 掩码节点格式一致）。
最佳内存管理：ffmpeg rawvideo 流式进出，任意时刻仅 1 帧驻留内存；
结果按内容哈希+参数磁盘缓存命中复用（命中时不加载模型）。

text_prompt 掩码表达式格式（如 "(skin:0.2)&(head:0.3)-eye(0.1)+(nose:0.1)"）：
  - 术语:  name / name:0.3 / name(0.3) / (name:0.3)，支持多词概念（如 "red car:0.4"）
  - 运算符（从左到右计算，无优先级，可用括号分组）:
      &  交集
      +  并集（| 为别名）
      -  差集
  - 函数（参数间逗号分隔，可嵌套）:
      max(a, b, ...)  逐像素取最大
      min(a, b, ...)  逐像素取最小
      grow(x, n)      n>0 掩码膨胀 n 像素,n<0 掩码腐蚀 |n| 像素(缩小),
                      如 "grow(person:0.2, 5)"、"grow(person:0.2, -8)"
  - 同一术语在一帧内检测到多个实例时，取所有实例掩码的并集

模型依赖 ComfyUI-SAM3（LoadSAM3Model 节点输出的 SAM3_MODEL_CONFIG），
通过 sys.modules 共享其模型缓存，不会重复加载模型。
"""
import gc
import importlib
import json
import logging
import os
import subprocess
import sys

import numpy as np
import torch
from PIL import Image
from comfy_api.latest import io

from ..libs.mask_expression import (
    parse_mask_expression,
    collect_terms,
    eval_expression,
)
from ..libs.video_utils import FFMPEG_PATH, get_video_metadata
from ..libs.video_transform import (
    cache_lookup,
    cache_output_paths,
    cache_store,
    compute_transform_key,
)
from .video_fit_node import (
    _video_source_path,
    _preview_ui,
    _is_changed_tag,
    _video_output,
)

log = logging.getLogger("kolid-comfy")


# =============================================================================
# SAM3 模型获取（跨包复用 ComfyUI-SAM3 的模块级模型缓存）
# =============================================================================

def _get_sam3_model_cache():
    """获取 ComfyUI-SAM3 的 nodes._model_cache 模块。

    与 SAM3 官方节点共享同一个已加载模块，从而共享模块级模型缓存，
    避免重复构建/加载模型。优先从 sys.modules 查找 ComfyUI 已加载的
    顶层包（ComfyUI 以目录路径作为模块名注册），找不到时再把
    custom_nodes 目录注入 sys.path 后导入。
    """
    # 1) ComfyUI 已加载的 ComfyUI-SAM3 顶层模块
    top = None
    for key, mod in list(sys.modules.items()):
        if key.endswith("ComfyUI-SAM3") and hasattr(mod, "nodes"):
            top = mod
            break

    nodes_pkg = None
    if top is not None:
        nodes_pkg = top.nodes
    else:
        # 2) 兜底：注入 custom_nodes 目录后直接导入
        try:
            import folder_paths
            cn_dir = folder_paths.folder_names_and_paths["custom_nodes"][0][0]
        except Exception:
            cn_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        if cn_dir not in sys.path:
            sys.path.insert(0, cn_dir)
        try:
            nodes_pkg = importlib.import_module("ComfyUI-SAM3.nodes")
        except ImportError:
            raise ImportError(
                "未找到 ComfyUI-SAM3 包。请在 custom_nodes 下安装 ComfyUI-SAM3 "
                "后再使用 VideoSegmentationNode。"
            )

    # _model_cache 由 SAM3 节点首次执行时延迟导入，可能尚未成为包属性
    mc = getattr(nodes_pkg, "_model_cache", None)
    if mc is None:
        try:
            mc = importlib.import_module(f"{nodes_pkg.__name__}._model_cache")
        except ImportError:
            raise ImportError("导入 ComfyUI-SAM3 的 nodes._model_cache 模块失败。")
    return mc


# =============================================================================
# 逐帧流式分割管道（ffmpeg rawvideo 解码 → SAM3 → 无损灰度编码）
# =============================================================================

def _model_config_key(detector):
    """SAM3 模型配置 → 稳定字符串（LoadSAM3Model 输出为 JSON-safe dict）。"""
    try:
        return json.dumps(detector, sort_keys=True, ensure_ascii=False)
    except Exception:
        return str(detector)


def _stream_segment_video(source, start_time, out_path, width, height, fps,
                          root, unique_terms, process_frame, total_hint):
    """逐帧流式分割：ffmpeg rgb24 解码 → process_frame 逐帧推理 → 无损灰度编码。

    process_frame(pil_image) -> {(name, threshold): [H, W] float mask}，
    由检测器种类（SAM3 / EOVSAM3）决定具体实现。
    最佳内存管理：任意时刻仅 1 帧 + 检测模型驻留内存，不缓存帧序列，
    适合任意分辨率/时长的视频。掩码编码与其它 Video 掩码节点一致
    （libx264 -qp 0 + gray，边缘零损失）。返回处理的帧数。
    """
    import comfy.model_management
    import comfy.utils

    dec_cmd = [FFMPEG_PATH, "-noautorotate", "-loglevel", "warning"]
    if start_time > 0:
        # VideoFromFile 对象可能引用从 start_time 开始的子片段
        dec_cmd += ["-ss", f"{start_time:.6f}"]
    dec_cmd += ["-i", source, "-map", "0:v:0",
                "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]

    frame_size = width * height * 3
    decoder = subprocess.Popen(dec_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    encoder = subprocess.Popen(
        [FFMPEG_PATH, "-y", "-loglevel", "warning",
         "-f", "rawvideo", "-pix_fmt", "gray",
         "-s", f"{width}x{height}", "-framerate", f"{fps:.6f}", "-i", "-",
         "-c:v", "libx264", "-preset", "veryfast", "-qp", "0",
         "-pix_fmt", "gray", out_path],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    pbar = comfy.utils.ProgressBar(total_hint) if total_hint > 0 else None
    count = 0
    try:
        while True:
            buf = decoder.stdout.read(frame_size)
            if not buf or len(buf) < frame_size:
                break
            comfy.model_management.throw_exception_if_processing_interrupted()

            frame = np.frombuffer(buf, dtype=np.uint8).reshape(height, width, 3)
            pil_image = Image.fromarray(frame.copy())

            # 逐术语检测（检测器无关回调）
            term_masks = process_frame(pil_image)

            # 按表达式合成最终掩码（从左到右布尔运算），写为 uint8 灰度帧
            final_mask = eval_expression(root, term_masks)
            out_frame = (final_mask.clamp(0.0, 1.0) * 255.0 + 0.5).to(torch.uint8)
            encoder.stdin.write(out_frame.numpy().tobytes())

            del term_masks, final_mask
            count += 1
            if pbar is not None:
                pbar.update(1)
            if count % 10 == 0:
                if total_hint > 0:
                    print(f"[VideoSegmentation] processed {count}/{total_hint} frames")
                else:
                    print(f"[VideoSegmentation] processed {count} frames")
                gc.collect()

        if pbar is not None and count > 0:
            # 实际帧数与估算不一致时校正，保证前端进度条收在 100%
            pbar.update_absolute(count, total=count)

        encoder.stdin.close()
        enc_err = encoder.stderr.read()
        enc_rc = encoder.wait()
        decoder.stdout.close()
        dec_err = decoder.stderr.read()
        dec_rc = decoder.wait()
        if dec_rc != 0:
            raise Exception(f"ffmpeg decoder exited with code {dec_rc}: "
                            f"{(dec_err or b'').decode('utf-8', errors='replace')[-800:]}")
        if enc_rc != 0:
            raise Exception((enc_err or b'').decode('utf-8', errors='replace')[-800:])
        return count
    finally:
        # 异常退出时终止子进程，防止残留进程与管道死锁
        if encoder.poll() is None:
            try:
                encoder.stdin.close()
            except Exception:
                pass
            encoder.kill()
        if decoder.poll() is None:
            decoder.kill()


def _make_sam3_process_frame(processor, unique_terms, height, width):
    """SAM3 检测回调：每帧 set_image 后逐术语 grounding 检测，实例并集。"""

    def process_frame(pil_image):
        # 提取本帧图像特征（每帧一次）
        state = processor.set_image(pil_image)
        term_masks = {}
        for name, threshold in unique_terms:
            # 直接赋值阈值属性：set_confidence_threshold() 在 state 已含
            # boxes 时会用旧文本重跑一次 grounding 推理（每术语多一次浪费），
            # 属性赋值无副作用，set_text_prompt 内部推理时读取该属性。
            processor.confidence_threshold = threshold
            state = processor.set_text_prompt(name, state)
            det_masks = state.get("masks")
            if det_masks is None or det_masks.numel() == 0 or det_masks.shape[0] == 0:
                term_mask = torch.zeros(height, width)
            else:
                if det_masks.ndim == 4 and det_masks.shape[1] == 1:
                    det_masks = det_masks.squeeze(1)
                # 该术语所有实例的并集
                term_mask = det_masks.any(dim=0).float().cpu()
            term_masks[(name, threshold)] = term_mask
        return term_masks

    return process_frame


def _make_eovsam_process_frame(model, unique_terms, height, width, resolution):
    """EOVSAM3 检测回调：每帧逐术语 detect（返回二值 mask），实例取并集。"""

    def process_frame(pil_image):
        img = torch.from_numpy(np.asarray(pil_image).copy()).float() / 255.0  # [H, W, C]
        term_masks = {}
        for name, threshold in unique_terms:
            try:
                # detect 返回 (masks, labels, scores) 三元组，取 masks 列表
                det_masks, _, _ = model.detect(
                    image=img, class_names=[name],
                    resolution=resolution, threshold=threshold,
                )
            except RuntimeError:
                det_masks = []
            term_mask = torch.zeros(height, width)
            for m in det_masks:
                if tuple(m.shape) != (height, width):
                    continue
                # detect 返回二值 mask（0/1，可能 bf16/cuda）→ CPU fp32 后取并集
                term_mask = torch.maximum(term_mask, m.to(device="cpu", dtype=torch.float32))
            term_masks[(name, threshold)] = term_mask
        return term_masks

    return process_frame


# =============================================================================
# 节点
# =============================================================================

class VideoSegmentationNode:
    """逐帧文本掩码表达式分割节点（SAM3 / EOVSAM3，输入 image_video，输出 mask_video）。

    text_prompt 格式: "(skin:0.2)&(head:0.3)-eye(0.1)+(nose:0.1)"

    每帧独立 grounding 检测（无跟踪传播），每术语的阈值逐帧生效。
    运算符从左到右计算：& 交集、+ 并集、- 差集，可用括号分组。
    函数：max/min 逐像素取最值，grow(x, n) 膨胀（n>0）/腐蚀（n<0，即缩小）。
    输出为无损灰度掩码视频（与其它 Video 掩码节点格式一致），
    流式处理 + 磁盘缓存命中复用。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_video": ("VIDEO", {
                    "tooltip": "Input video to segment (e.g. from UrlVideoNode / VideoFolderLoaderNode)",
                }),
                "detector": ("*", {
                    "tooltip": "检测器: SAM3 model config (LoadSAM3Model, ComfyUI-SAM3) "
                               "或 EOVSAM3_MODEL (LoadEovSAM3Model)",
                }),
                "text_prompt": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Mask expression, e.g. '(skin:0.2)&(head:0.3)-eye(0.1)+(nose:0.1)'. "
                               "Operators (left-to-right): & intersect, + union, - subtract, | union. "
                               "Term syntax: name, name:0.3, name(0.3), (name:0.3).",
                }),
                "default_threshold": ("FLOAT", {
                    "default": 0.2, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "Confidence threshold used by terms without an explicit threshold.",
                }),
            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("mask_video",)
    FUNCTION = "execute"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(cls, detector, image_video, text_prompt, default_threshold=0.2):
        return _is_changed_tag(
            [_video_source_path(image_video) if image_video else None],
            {"text_prompt": text_prompt, "default_threshold": default_threshold,
             "model": _model_config_key(detector)})

    def execute(self, detector, image_video, text_prompt, default_threshold=0.2):
        """每帧对每个术语独立 grounding 检测，按表达式合成掩码，流式写入掩码视频。"""
        import comfy.model_management

        if not text_prompt or not text_prompt.strip():
            raise ValueError(
                "text_prompt 为空。请输入掩码表达式，例如 "
                "'(skin:0.2)&(head:0.3)-eye(0.1)+(nose:0.1)'。"
            )

        source = _video_source_path(image_video)

        # 解析表达式，收集去重术语（每帧每术语只推理一次）
        try:
            root = parse_mask_expression(text_prompt, default_threshold)
        except ValueError as e:
            raise ValueError(f"text_prompt 无效: {e}")
        unique_terms = collect_terms(root, [])
        print(f"[VideoSegmentation] expression: '{text_prompt}'")
        print(f"[VideoSegmentation] terms (name, threshold): {unique_terms}")

        # 磁盘缓存：命中直接复用（不加载模型）
        key = compute_transform_key(
            "VideoSegmentationNode",
            {"source": source},
            {"text_prompt": text_prompt, "default_threshold": default_threshold,
             "model": _model_config_key(detector)})
        hit = cache_lookup(key)
        if hit is not None:
            print(f"[VideoSegmentationNode] Cache hit: {key[:12]}")
            return io.NodeOutput(_video_output(hit["image"]), ui=_preview_ui(hit["image"]))
        out_path, _ = cache_output_paths(key)
        print(f"[VideoSegmentationNode] Cache miss: {key[:12]} -> processing")

        meta = get_video_metadata(source)
        w, h = meta["width"], meta["height"]
        fps = meta["fps"]
        total = meta["frame_count"]
        if total <= 0 and fps > 0:
            # 容器缺帧数时按时长估算，保证前端进度条可用
            dur = float(meta.get("duration") or 0)
            if dur > 0:
                total = int(dur * fps)

        if w <= 0 or h <= 0 or fps <= 0:
            raise ValueError(f"无效的视频元数据: {w}x{h} @ {fps}fps ({source})")

        # VideoFromFile 对象可能引用从 start_time 开始的子片段
        start_time = getattr(image_video, "_VideoFromFile__start_time", 0.0) or 0.0
        if start_time > 0:
            total = max(0, int(total - start_time * fps))

        if isinstance(detector, dict) and "eovsam_checkpoint" in detector:
            # ---- EOVSAM3（LoadEovSAM3Model 输出；模型在 get_or_build_model 内缓存）----
            from ..libs.eovsam.eovsam_model import get_or_build_model as _get_eovsam
            eovsam_model = _get_eovsam(
                checkpoint_path=detector["eovsam_checkpoint"],
                precision=detector.get("precision", "bf16"),
            )
            process_frame = _make_eovsam_process_frame(
                eovsam_model, unique_terms, h, w,
                int(detector.get("resolution", 1152)))
            print(f"[VideoSegmentation] detector: EOVSAM3 (precision="
                  f"{detector.get('precision', 'bf16')})")
        else:
            # ---- SAM3（LoadSAM3Model 输出；与 ComfyUI-SAM3 官方节点共享模块级缓存）----
            model_cache = _get_sam3_model_cache()
            sam3_model = model_cache.get_or_build_model(detector)
            comfy.model_management.load_models_gpu([sam3_model])

            processor = sam3_model.processor
            device = sam3_model.current_device
            if hasattr(processor, "sync_device_with_model"):
                processor.sync_device_with_model()
            elif hasattr(processor, "device") and str(processor.device) != str(device):
                processor.device = str(device)

            process_frame = _make_sam3_process_frame(processor, unique_terms, h, w)
            print(f"[VideoSegmentation] detector: SAM3")

        print(f"[VideoSegmentation] {w}x{h} @ {fps:g}fps, {os.path.basename(source)}")

        count = _stream_segment_video(
            source, start_time, out_path, w, h, fps,
            root, unique_terms, process_frame, total)

        if count <= 0:
            raise ValueError("没有可处理的帧。")

        cache_store(key, out_path)
        print(f"[VideoSegmentationNode] Cached: {os.path.basename(out_path)} ({count} frames)")
        print(f"[VideoSegmentation] done: {count} frames, size {w}x{h}")

        gc.collect()
        comfy.model_management.soft_empty_cache()

        return io.NodeOutput(_video_output(out_path), ui=_preview_ui(out_path))


NODE_CLASS_MAPPINGS = {
    "VideoSegmentationNode": VideoSegmentationNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoSegmentationNode": "Video Segmentation (SAM3 Mask Expression)",
}
