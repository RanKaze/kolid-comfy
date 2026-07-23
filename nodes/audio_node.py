import os
import subprocess
import json
import hashlib
import torch
import torchaudio
import torch.nn.functional as F
import numpy as np
from ..libs.timestamp import parse_timestamp
from ..libs.video_utils import FFMPEG_PATH, AUDIO_CACHE_DIR
from ..libs.audio_utils import load_audio_from_file, extract_audio_segment, extract_audio_from_video



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