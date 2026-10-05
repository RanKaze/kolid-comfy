# -*- coding: utf-8 -*-
"""
CreateVideoNode:IMAGE 批次(+可选 AUDIO)→ VIDEO(磁盘文件)。

逐帧 rawvideo 管道编码(任意时刻仅 1 帧驻留内存):
libx264 crf18 veryfast + yuv420p + faststart;有音频时 aac 192k。
输出时长以 帧数/fps 为准:音频过长截断、过短尾部静音(与 VideoReplaceAudioNode 同规则)。
结果按 帧内容哈希 + 音频内容哈希 + fps 磁盘缓存,相同输入不重编码。
"""
import hashlib
import json
import os
import subprocess
import wave

import torch

from comfy_api.latest import io

from ...libs.audio_utils import AUDIO_CACHE_DIR
from ...libs.video_transform import (
    cache_lookup,
    cache_output_paths,
    cache_store,
)
from ...libs.video_utils import FFMPEG_PATH
from .video_fit_node import _preview_ui, _video_output


CATEGORY = "Kolid-Toolkit"

# 算法版本号:任何影响输出字节的编码参数变更都必须 bump,防止命中旧缓存
ALGO_VERSION = 1


def _iter_frames_u8(images):
    """[B,H,W,C] float 0~1 → 逐帧 uint8 RGB numpy(内存恒定)。"""
    for i in range(int(images.shape[0])):
        frame = images[i][..., :3].clamp(0.0, 1.0) * 255.0
        yield frame.round().to(torch.uint8).cpu().contiguous().numpy()


def _frames_digest(images):
    """帧内容指纹:与编码输入完全一致的 uint8 字节 MD5。"""
    md5 = hashlib.md5()
    for frame in _iter_frames_u8(images):
        md5.update(frame.tobytes())
    return md5.hexdigest()


def _audio_digest(audio):
    """音频内容哈希 + 规范化后的 [C, T] 波形与采样率。"""
    wf = audio["waveform"].detach().cpu().contiguous().float()
    sr = int(audio.get("sample_rate") or 0) or 44100
    if wf.dim() == 1:
        wf = wf.unsqueeze(0)
    if wf.dim() == 3:
        wf = wf[0]
    if wf.dim() != 2:
        raise ValueError(f"音频波形维度异常: {tuple(wf.shape)}")
    if wf.shape[0] > 8 and wf.shape[1] <= 8:
        wf = wf.T  # 宽扁 [T, C] → [C, T]
    if wf.numel() == 0:
        raise ValueError("输入音频为空,无法创建视频。")
    digest = hashlib.sha1(
        wf.contiguous().numpy().tobytes() + sr.to_bytes(4, "little")).hexdigest()[:16]
    return digest, wf, sr


def _write_wav(path, wf, sr):
    """[C, T] float → 16bit PCM wav。"""
    pcm = (wf.clamp(-1.0, 1.0) * 32767.0).round().to(torch.int16).contiguous().numpy().T
    with wave.open(path, "wb") as f:
        f.setnchannels(int(wf.shape[0]))
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes(pcm.tobytes())


def _encode_frames(images, out_path, fps, audio_path=None):
    """逐帧写 ffmpeg stdin,编码为 mp4。"""
    n, h, w = (int(images.shape[0]), int(images.shape[1]), int(images.shape[2]))
    cmd = [FFMPEG_PATH, "-y", "-loglevel", "warning",
           "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{w}x{h}", "-framerate", f"{fps:.6f}", "-i", "-"]
    if audio_path:
        cmd += ["-i", audio_path, "-map", "0:v:0", "-map", "1:a:0"]
    if w % 2 or h % 2:
        cmd += ["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2"]  # yuv420p 要求偶数尺寸
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    if audio_path:
        cmd += ["-af", "apad", "-c:a", "aac", "-b:a", "192k",
                "-t", f"{n / fps:.6f}"]
    cmd += [out_path]

    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for frame in _iter_frames_u8(images):
            proc.stdin.write(frame.tobytes())
    except BrokenPipeError:
        pass  # ffmpeg 提前退出:真实原因在 stderr,下面统一抛出
    except BaseException:
        proc.kill()
        raise
    try:
        proc.stdin.close()
    except OSError:
        pass
    stderr = proc.stderr.read()
    if proc.wait() != 0:
        raise RuntimeError(
            f"ffmpeg 编码失败: {(stderr or b'').decode('utf-8', errors='replace')[-500:]}")


class CreateVideoNode:
    """IMAGE 批次(+可选 AUDIO)→ VIDEO。

    输入多少帧就是多少帧,时长 = 帧数 / fps。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {
                    "tooltip": "Frames to encode (batch dimension = frames)"
                }),
                "fps": ("FLOAT", {
                    "default": 16.0,
                    "min": 0.1,
                    "max": 960.0,
                    "step": 0.01,
                    "tooltip": "Frame rate of the output video"
                }),
            },
            "optional": {
                "audio": ("AUDIO", {
                    "tooltip": "Optional audio track (longer than the video is cut, shorter is padded with silence)"
                }),
            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    FUNCTION = "create"
    CATEGORY = CATEGORY

    def create(self, images, fps, audio=None):
        if images is None or int(images.shape[0]) == 0:
            raise ValueError("输入图像为空,无法创建视频。")
        n, h, w = (int(images.shape[0]), int(images.shape[1]), int(images.shape[2]))

        digest, wf, sr = (None, None, None)
        if audio is not None:
            digest, wf, sr = _audio_digest(audio)

        key = hashlib.md5(json.dumps({
            "node": "CreateVideoNode",
            "version": ALGO_VERSION,
            "frames": _frames_digest(images),
            "size": [n, w, h],
            "fps": float(fps),
            "audio": digest,
            "sample_rate": sr,
        }, sort_keys=True).encode("utf-8")).hexdigest()

        hit = cache_lookup(key)
        if hit is not None:
            print(f"[CreateVideoNode] Cache hit: {key[:12]}")
            return io.NodeOutput(_video_output(hit["image"]),
                                 ui=_preview_ui(hit["image"]))

        wav_path = None
        if wf is not None:
            wav_path = os.path.join(AUDIO_CACHE_DIR, f"cv_{digest}_{sr}.wav")
            if not os.path.exists(wav_path):
                _write_wav(wav_path, wf, sr)

        out_path, _ = cache_output_paths(key)
        print(f"[CreateVideoNode] {n} frames {w}x{h} @{fps:g}fps"
              + (f" + audio {wf.shape[-1] / sr:.2f}s@{sr}Hz" if wf is not None else "")
              + f" -> {n / fps:.2f}s")
        _encode_frames(images, out_path, float(fps), wav_path)
        cache_store(key, out_path)

        return io.NodeOutput(_video_output(out_path), ui=_preview_ui(out_path))
