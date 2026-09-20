# -*- coding: utf-8 -*-
"""
视频 VAE 编码节点(语义与核心 VAEEncode 一致,输入换为视频文件):

VAEEncodeVideoNode: video + vae → LATENT

视频加载为 batch=总帧数、宽高与源视频一致的 IMAGE 张量,
按普通 images 走 vae.encode(核心 VAE 内部自动按显存分批,
OOM 时回退 tiled 编码)。返回 {"samples": latent}。

缓存:latent 按 md5(源内容哈希 + VAE 指纹 + 版本) 存
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

LATENT_ALGO_VERSION = 1


def _load_frames_tensor(path):
    """视频文件 → [N,H,W,C] float32(0-1),N 为总帧数,宽高原样。"""
    vr = VideoReader(path, ctx=cpu(0))
    frames = vr.get_batch(range(len(vr))).asnumpy()  # [N,H,W,3] uint8
    return torch.from_numpy(frames.astype(np.float32) / 255.0)


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


def _latent_key(source, vae_fp):
    payload = {
        "node": "VAEEncodeVideoNode",
        "version": LATENT_ALGO_VERSION,
        "sources": {"video": video_content_hash(source)},
        "vae": vae_fp,
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
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("latent",)
    FUNCTION = "encode"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(s, video, vae):
        return _is_changed_tag(
            [_video_source_path(video) if video else None],
            {"vae": _vae_fingerprint(vae)})

    def encode(self, video, vae):
        source = _video_source_path(video)

        key = _latent_key(source, _vae_fingerprint(vae))
        cache_path = os.path.join(CACHE_DIR, f"{key}_latent.pt")
        cached = _load_latent_cache(cache_path)
        if cached is not None:
            print(f"[VAEEncodeVideoNode] Cache hit: {key[:12]}")
            return (cached,)

        pixels = _load_frames_tensor(source)
        t = vae.encode(pixels)
        latent = {"samples": t}

        try:
            torch.save(latent, cache_path)
            print(f"[VAEEncodeVideoNode] Cached: {os.path.basename(cache_path)}")
        except Exception as e:
            print(f"[VAEEncodeVideoNode] Warning: failed to save cache: {e}")

        return (latent,)
