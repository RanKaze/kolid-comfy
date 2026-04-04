import os
import subprocess
import json
import hashlib
import torch
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