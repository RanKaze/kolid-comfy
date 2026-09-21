# -*- coding: utf-8 -*-
"""
视频 VAE 编码节点(语义与核心 VAEEncode 一致,输入换为视频文件):

VAEEncodeVideoNode: video + vae → LATENT

视频加载为 batch=总帧数、宽高与源视频一致的 IMAGE 张量,
按普通 images 走 vae.encode(核心 VAE 内部自动按显存分批,
OOM 时回退 tiled 编码)。返回 {"samples": latent}。

帧数对齐:视频 VAE(如 Wan)时间压缩比 R(见
vae.temporal_compression_decode(),Wan=4,图像 VAE=1),只能表示
1+k*R 帧的输入,内部对其它帧数做向下截断,且解码恰好还原
1+k*R 帧。因此源视频帧数不是 1+k*R 时,latent/解码帧数会比源
少最多 R-1 帧,下游按源帧数对齐就会错位。frame_align 决定:
pad = 重复末帧补到上一网格点(不丢内容,默认);
trim = 裁到网格内(丢弃末尾不足一组的帧);
none = 原样送入(保持旧的内部截断行为)。
处理结果会打印实际帧数映射,便于核对。

缓存:latent 按 md5(源内容哈希 + VAE 指纹 + 版本 + 对齐参数) 存
output/videocache/{key}_latent.pt,相同输入直接载入,
避免重复编码。VAE 指纹 = 结构(key/shape/dtype)+ 权重采样,
换权重会得到不同 key。
"""
import hashlib
import json
import os

import numpy as np
import torch
from decord import VideoReader, cpu

from ..libs.video_transform import CACHE_DIR, video_content_hash
from .video_fit_node import _video_source_path, _is_changed_tag

CATEGORY = "Kolid-Toolkit"

LATENT_ALGO_VERSION = 2


def _load_frames_tensor(path):
    """视频文件 → [N,H,W,C] float32(0-1),N 为总帧数,宽高原样。"""
    vr = VideoReader(path, ctx=cpu(0))
    frames = vr.get_batch(range(len(vr))).asnumpy()  # [N,H,W,3] uint8
    return torch.from_numpy(frames.astype(np.float32) / 255.0)


def _temporal_ratio(vae):
    """VAE 时间压缩比 R(图像 VAE 为 1)。与核心 temporal_compression_decode 同源。"""
    try:
        r = vae.temporal_compression_decode()
    except Exception:
        r = None
    try:
        return max(1, int(r))
    except (TypeError, ValueError):
        return 1


def _align_frames(pixels, mode, ratio):
    """把帧批对齐到 VAE 可表示的 1+k*R 网格,返回 (帧批, 有效帧数, 解码帧数)。"""
    n = pixels.shape[0]
    if ratio <= 1 or mode == "none":
        latent_t = 1 + max(0, n - 1) // ratio
        return pixels, n, 1 + (latent_t - 1) * ratio
    if mode == "trim":
        eff = 1 + ((n - 1) // ratio) * ratio
    else:  # pad
        eff = 1 + ((n - 1 + ratio - 1) // ratio) * ratio
    if eff <= n:
        return pixels[:eff], eff, eff
    tail = pixels[-1:].repeat(eff - n, 1, 1, 1)
    return torch.cat([pixels, tail], dim=0), eff, eff


def _vae_fingerprint(vae):
    """轻量 VAE 身份指纹:结构(key+shape+dtype)+ 前几个张量的权重采样。"""
    h = hashlib.md5()
    try:
        sd = vae.first_stage_model.state_dict()
        keys = sorted(sd.keys())
        for k in keys:
            t = sd[k]
            h.update(f"{k}|{tuple(t.shape)}|{t.dtype}\n".encode("utf-8"))
        sampled = 0
        for k in keys:
            t = sd[k]
            if t.numel() == 0:
                continue
            h.update(t.detach().flatten()[:2048].cpu()
                     .contiguous().view(torch.uint8).numpy().tobytes())
            sampled += 1
            if sampled >= 8:
                break
    except Exception:
        h.update(b"<no-state-dict>")
    return h.hexdigest()


def _latent_key(source, vae_fp, align_tag):
    payload = {
        "node": "VAEEncodeVideoNode",
        "version": LATENT_ALGO_VERSION,
        "sources": {"video": video_content_hash(source)},
        "vae": vae_fp,
        "align": align_tag,
    }
    return hashlib.md5(
        json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()


def _load_latent_cache(cache_path):
    if not os.path.exists(cache_path):
        return None
    try:
        try:
            data = torch.load(cache_path, map_location="cpu", weights_only=True)
        except TypeError:
            data = torch.load(cache_path, map_location="cpu")
        if isinstance(data, dict) and "samples" in data:
            return data
    except Exception as e:
        print(f"[VAEEncodeVideoNode] Warning: failed to load cache: {e}")
    return None


class VAEEncodeVideoNode:
    """视频 → LATENT(视频加载为全帧图像批,按 images 编码)。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("VIDEO", {"tooltip": "Input video to encode"}),
                "vae": ("VAE", {"tooltip": "VAE model"}),
                "frame_align": (["pad", "trim", "none"], {
                    "default": "pad",
                    "tooltip": "pad: 重复末帧补到 VAE 时间网格(1+k*R,不丢内容); "
                               "trim: 裁到网格内(丢弃末尾不足一组的帧); "
                               "none: 不处理,VAE 内部截断会使解码帧数少于源"}),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("latent",)
    FUNCTION = "encode"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(s, video, vae, frame_align="pad"):
        return _is_changed_tag(
            [_video_source_path(video) if video else None],
            {"vae": _vae_fingerprint(vae),
             "align": f"{frame_align}|{_temporal_ratio(vae)}"})

    def encode(self, video, vae, frame_align="pad"):
        source = _video_source_path(video)

        ratio = _temporal_ratio(vae)
        align_tag = f"{frame_align}|{ratio}"
        key = _latent_key(source, _vae_fingerprint(vae), align_tag)
        cache_path = os.path.join(CACHE_DIR, f"{key}_latent.pt")
        cached = _load_latent_cache(cache_path)
        if cached is not None:
            print(f"[VAEEncodeVideoNode] Cache hit: {key[:12]} "
                  f"(latent {tuple(cached['samples'].shape)})")
            return (cached,)

        pixels = _load_frames_tensor(source)
        n = pixels.shape[0]
        pixels, eff, decoded = _align_frames(pixels, frame_align, ratio)
        if eff != n:
            print(f"[VAEEncodeVideoNode] Frames {n} -> {eff} "
                  f"(align {frame_align}, temporal ratio {ratio}), decode -> {decoded}")
        elif decoded != n:
            print(f"[VAEEncodeVideoNode] WARNING: frames {n} (align none, temporal ratio "
                  f"{ratio}) decode -> {decoded}, {n - decoded} trailing frames dropped by VAE")
        else:
            print(f"[VAEEncodeVideoNode] Frames {n} "
                  f"(align {frame_align}, temporal ratio {ratio}), decode -> {decoded}")

        t = vae.encode(pixels)
        latent = {"samples": t}

        try:
            torch.save(latent, cache_path)
            print(f"[VAEEncodeVideoNode] Cached: {os.path.basename(cache_path)}")
        except Exception as e:
            print(f"[VAEEncodeVideoNode] Warning: failed to save cache: {e}")

        return (latent,)
