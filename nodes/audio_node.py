import os
import subprocess
import json
import hashlib
import torch
import torchaudio
import torch.nn.functional as F
import numpy as np
from ..libs.timestamp import parse_timestamp
from ..libs.video_utils import FFMPEG_PATH, AUDIO_CACHE_DIR, get_video_metadata
from ..libs.audio_utils import load_audio_from_file, extract_audio_segment, extract_audio_from_video
from ..libs.video_transform import (
    _run_ffmpeg,
    cache_lookup,
    cache_store,
    cache_output_paths,
    compute_transform_key,
)
from .video_fit_node import (
    _video_source_path,
    _video_output,
    _preview_ui,
    _is_changed_tag,
)
from comfy_api.latest import io



CACHE_INDEX_FILE = os.path.join(AUDIO_CACHE_DIR, "GetVideoAudioNodeCache.json")


def load_audio_cache_index():
    if os.path.exists(CACHE_INDEX_FILE):
        try:
            with open(CACHE_INDEX_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"[GetVideoAudio] Warning: Failed to load cache index: {e}")
    return {}


def save_audio_cache_index(cache_index):
    try:
        with open(CACHE_INDEX_FILE, 'w', encoding='utf-8') as f:
            json.dump(cache_index, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[GetVideoAudio] Warning: Failed to save cache index: {e}")


class GetVideoAudioNode:
    """从 VIDEO 对象中提取音频，返回标准 ComfyUI AUDIO 对象 {waveform: [1, C, T], sample_rate: int}"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("VIDEO", {
                    "tooltip": "Video object to extract audio from"
                }),
            },
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "extract_audio"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(cls, video):
        if hasattr(video, 'get_stream_source'):
            return video.get_stream_source()
        elif hasattr(video, 'video_path'):
            return video.video_path
        return str(id(video))

    def extract_audio(self, video):
        """Extract audio from video."""
        try:
            # Use the utility function to extract audio
            audio_dict = extract_audio_from_video(video)
            return (audio_dict,)
        except Exception as e:
            raise Exception(f"Failed to extract audio: {e}")


class GetAudioInfoNode:
    """Get audio duration in seconds."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO", {
                    "tooltip": "Audio object to get info from"
                }),
            },
        }

    RETURN_TYPES = ("FLOAT",)
    RETURN_NAMES = ("duration",)
    FUNCTION = "get_info"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(s, audio):
        waveform = audio.get("waveform")
        sample_rate = audio.get("sample_rate")
        if waveform is not None:
            return f"{waveform.shape}_{sample_rate}"
        return str(id(audio))

    def get_info(self, audio):
        waveform = audio.get("waveform")
        sample_rate = audio.get("sample_rate")
        if waveform is None or sample_rate is None:
            raise ValueError("Audio object must contain waveform and sample_rate")
        total_samples = waveform.shape[-1]
        duration = total_samples / sample_rate
        return (float(duration),)


class GetAudioSegmentNode:
    """Extract audio segment based on timestamp and frame parameters."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO", {
                    "tooltip": "Audio object to extract segment from"
                }),
                "start_timestamp": ("STRING", {
                    "default": "00:00:00",
                    "multiline": False,
                    "tooltip": "Start timestamp in hh:mm:ss format"
                }),
                "end_timestamp": ("STRING", {
                    "default": "00:01:00",
                    "multiline": False,
                    "tooltip": "End timestamp in hh:mm:ss format"
                }),
            },
            "optional": {
                "start_frame_offset": ("INT", {
                    "forceInput": True,
                    "tooltip": "Frame offset from start timestamp"
                }),
                "end_frame_offset": ("INT", {
                    "forceInput": True,
                    "tooltip": "Frame offset from end timestamp"
                }),
                "fps": ("FLOAT", {
                    "forceInput": True,
                    "tooltip": "Frames per second"
                })
            }
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio_segment",)
    FUNCTION = "extract_segment"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(s, audio, start_timestamp, start_frame_offset, end_timestamp, end_frame_offset, fps=None):
        return f"{start_timestamp}_{start_frame_offset}_{end_timestamp}_{end_frame_offset}_{fps}"

    def extract_segment(self, audio, start_timestamp, start_frame_offset, end_timestamp, end_frame_offset, fps=None):
        """Extract audio segment based on parameters."""
        try:  
            # Use the utility function to extract segment
            audio_segment = extract_audio_segment(
                audio, 
                start_timestamp, 
                start_frame_offset, 
                end_timestamp, 
                end_frame_offset, 
                fps
            )
            return (audio_segment,)
        except Exception as e:
            raise Exception(f"Failed to extract audio segment: {e}")


class VAEEncodeAudioTiled:
    """Encode audio to latent using tiled VAE encoding."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO", {
                    "tooltip": "Audio object to encode"
                }),
                "vae": ("VAE", {
                    "tooltip": "VAE model to use for encoding"
                }),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("latent",)
    FUNCTION = "encode"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(cls, audio, vae):
        waveform = audio.get("waveform")
        sample_rate = audio.get("sample_rate")
        if waveform is not None:
            return f"{waveform.shape}_{sample_rate}"
        return str(id(audio))

    def encode(self, vae, audio):
        waveform = audio["waveform"]
        sample_rate = audio["sample_rate"]

        # --- vae_sr (SFT: getattr(vae, "audio_sample_rate", 48000)) ---
        vae_sr = getattr(vae, "audio_sample_rate", 48000)

        # --- duration & latent_length (SFT: _get_source_duration_seconds + generate) ---
        sr = max(int(sample_rate), 1)
        duration = waveform.shape[-1] / sr
        latent_length = max(10, round(duration * vae_sr / 1920))

        # --- normalize audio (SFT: _normalize_audio_to_stereo_48k) ---
        if waveform.dim() == 2:
            waveform = waveform.unsqueeze(0)
        elif waveform.dim() == 1:
            waveform = waveform.unsqueeze(0).unsqueeze(0)

        if waveform.dim() == 3 and waveform.shape[1] > waveform.shape[2] and waveform.shape[2] <= 8:
            waveform = waveform.movedim(-1, 1)

        if waveform.shape[1] == 1:
            waveform = waveform.repeat(1, 2, 1)
        elif waveform.shape[1] > 2:
            waveform = waveform[:, :2, :]

        if sample_rate != vae_sr:
            waveform = torchaudio.functional.resample(waveform, sample_rate, vae_sr)

        waveform = torch.clamp(waveform, -1.0, 1.0)

        # --- pad / truncate (SFT: _build_source_latent) ---
        target_samples = latent_length * 1920
        if waveform.shape[-1] < target_samples:
            waveform = F.pad(waveform, (0, target_samples - waveform.shape[-1]))
        elif waveform.shape[-1] > target_samples:
            waveform = waveform[:, :, :target_samples]

        # --- encode (SFT: _vae_encode_with_optional_tiling) ---
        t = vae.encode_tiled(waveform.movedim(1, -1), tile_y=1)
        return ({"samples": t},)


class VideoReplaceAudioNode:
    """替换视频音轨：视频流无损 copy，音轨替换为输入的 AUDIO。

    原视频无论有没有音轨都可工作（只取其视频流）；
    输出时长以原视频为准：音频过长被截断、过短则尾部静音。
    最佳内存管理：ffmpeg 文件到文件流式 remux（-c:v copy 不重编码）；
    结果按视频内容哈希 + 音频内容哈希磁盘缓存命中复用（output/videocache）。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("VIDEO", {
                    "tooltip": "Input video (its audio track, if any, will be replaced)"
                }),
                "audio": ("AUDIO", {
                    "tooltip": "New audio track"
                }),
            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    FUNCTION = "execute"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(cls, video, audio):
        src = _video_source_path(video) if video is not None else None
        wf = audio.get("waveform") if isinstance(audio, dict) else None
        fp = "none"
        if wf is not None:
            fp = (f"{tuple(wf.shape)}_{float(wf.float().abs().sum()):.3f}"
                  f"_{audio.get('sample_rate')}")
        return _is_changed_tag([src], {"audio_fp": fp})

    @staticmethod
    def _audio_hash(audio):
        """音频内容哈希 + 规范化后的 [C, T] 波形与采样率。"""
        wf = audio["waveform"]
        sr = int(audio.get("sample_rate") or 0)
        if sr <= 0:
            sr = 44100
        wf = wf.detach().cpu().contiguous().float()
        if wf.dim() == 1:
            wf = wf.unsqueeze(0)
        if wf.dim() == 3:
            wf = wf[0]
        if wf.dim() != 2:
            raise ValueError(f"音频波形维度异常: {tuple(wf.shape)}")
        # 宽扁 [T, C]（C<=8）转置为 [C, T]
        if wf.shape[0] > 8 and wf.shape[1] <= 8:
            wf = wf.T
        if wf.numel() == 0:
            raise ValueError("输入音频为空，无法替换音轨。")
        h = hashlib.sha1(wf.numpy().tobytes() + sr.to_bytes(4, "little")).hexdigest()[:16]
        return h, wf, sr

    def execute(self, video, audio):
        src = _video_source_path(video)
        ahash, wf, sr = self._audio_hash(audio)

        key = compute_transform_key(
            "VideoReplaceAudioNode", {"video": src},
            {"audio": ahash, "sr": sr},
        )
        cached = cache_lookup(key)
        if cached:
            print(f"[VideoReplaceAudio] cache hit: {os.path.basename(cached['image'])}")
            return io.NodeOutput(
                _video_output(cached["image"]), ui=_preview_ui(cached["image"]))

        # ---- waveform [C, T] → 16bit PCM wav（复用 input/audio_cache）----
        import wave as _wave
        wav_path = os.path.join(AUDIO_CACHE_DIR, f"vra_{ahash}_{sr}.wav")
        if not os.path.exists(wav_path):
            pcm = (wf.clamp(-1, 1) * 32767.0).round().to(torch.int16)
            pcm = pcm.numpy().T  # [T, C] 交错
            with _wave.open(wav_path, "wb") as f:
                f.setnchannels(int(wf.shape[0]))
                f.setsampwidth(2)
                f.setframerate(sr)
                f.writeframes(pcm.tobytes())

        # ---- remux：只取源视频流 + 新音轨，视频流无损 copy ----
        meta = get_video_metadata(src)
        dur = float(meta.get("duration") or 0)
        out_path, _ = cache_output_paths(key)
        cmd = [
            FFMPEG_PATH, "-y",
            "-i", src, "-i", wav_path,
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        ]
        if dur > 0:
            # 输出时长以原视频为准：音频过长截断，过短尾部静音
            cmd += ["-t", f"{dur:.6f}"]
        cmd += ["-movflags", "+faststart", out_path]
        _run_ffmpeg(cmd)

        cache_store(key, out_path)
        print(f"[VideoReplaceAudio] done: {os.path.basename(out_path)} "
              f"(dur={dur:.2f}s, audio {wf.shape[-1] / sr:.2f}s @{sr}Hz)")
        return io.NodeOutput(_video_output(out_path), ui=_preview_ui(out_path))