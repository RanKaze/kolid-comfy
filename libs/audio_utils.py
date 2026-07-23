import os
import subprocess
import torch
import numpy as np
import json
import hashlib
import wave

import folder_paths
INPUT_DIR = folder_paths.get_input_directory()
AUDIO_CACHE_DIR = os.path.join(INPUT_DIR, "audio_cache")
if not os.path.exists(AUDIO_CACHE_DIR):
    os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)

def load_audio_from_file(wav_path: str) -> dict:
    """安全加载 WAV 并转为 [1, C, T] 格式"""
    with wave.open(wav_path, 'r') as wav_file:
        sample_rate = wav_file.getframerate()
        num_channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        num_frames = wav_file.getnframes()
        raw_data = wav_file.readframes(num_frames)

        if sample_width != 2:
            raise ValueError(f"Only 16-bit PCM supported, got sample_width={sample_width}")

        audio_np = np.frombuffer(raw_data, dtype=np.int16).astype(np.float32)
        audio_np /= 32768.0

        waveform = torch.from_numpy(audio_np)

        if num_channels == 1:
            waveform = waveform.unsqueeze(0).unsqueeze(0)   # [1, 1, T]
        else:
            waveform = waveform.reshape(-1, num_channels)   # [T, C]
            waveform = waveform.transpose(0, 1)             # [C, T]
            waveform = waveform.unsqueeze(0)                # [1, C, T]

        return {
            "waveform": waveform.float(),
            "sample_rate": int(sample_rate)
        }


def extract_audio_segment(audio, start_timestamp, start_frame_offset, end_timestamp, end_frame_offset, fps=None):
    """Extract audio segment based on start and end timestamps with offsets."""
    from .timestamp import parse_timestamp
    
    # Get waveform and sample rate from audio
    waveform = audio.get("waveform")
    sample_rate = audio.get("sample_rate")
    
    if waveform is None or sample_rate is None:
        raise ValueError("Audio object must contain waveform and sample_rate")
    
    # Calculate start and end times in seconds
    start_time = parse_timestamp(start_timestamp)
    end_time = parse_timestamp(end_timestamp)
    duration_seconds = end_time - start_time
    
    if duration_seconds <= 0:
        raise ValueError("End timestamp must be after start timestamp")
    
    # Use frame-based calculation if fps is provided
    if fps is not None:
        # Calculate start frame
        base_start_frame = int(start_time * fps)
        actual_start_frame = base_start_frame + start_frame_offset
        
        # Calculate end frame
        base_end_frame = int(end_time * fps)
        actual_end_frame = base_end_frame + end_frame_offset
        
        # Convert back to seconds
        start_time = actual_start_frame / fps
        end_time = actual_end_frame / fps
        duration_seconds = end_time - start_time
        
        print(f"[AudioUtils] Frame-based timing: start={actual_start_frame} @ {fps}fps, end={actual_end_frame} @ {fps}fps")
        print(f"[AudioUtils] Converted to seconds: start={start_time}s, end={end_time}s, duration={duration_seconds}s")
    
    # Calculate start and end samples
    start_sample = int(start_time * sample_rate)
    end_sample = int((start_time + duration_seconds) * sample_rate)
    
    # Ensure start and end samples are within bounds
    total_samples = waveform.shape[-1] if len(waveform.shape) > 1 else len(waveform)
    if start_sample >= total_samples:
        print(f"[AudioUtils] Warning: Start sample {start_sample} exceeds total samples {total_samples}")
        start_sample = total_samples - 1
    if start_sample < 0:
        print(f"[AudioUtils] Warning: Start sample {start_sample} is negative, using 0")
        start_sample = 0
    if end_sample > total_samples:
        print(f"[AudioUtils] Warning: End sample {end_sample} exceeds total samples {total_samples}, truncating")
        end_sample = total_samples
    if end_sample <= start_sample:
        raise ValueError("End sample must be greater than start sample")
    
    # Extract segment
    if len(waveform.shape) > 1:
        # Handle multi-channel audio
        segment = waveform[..., start_sample:end_sample]
    else:
        # Handle mono audio
        segment = waveform[start_sample:end_sample]
    
    # Create audio dictionary for the segment
    audio_segment = {
        "waveform": segment,
        "sample_rate": sample_rate
    }
    
    print(f"[AudioUtils] Extracted audio segment: {start_time}s to {start_time + duration_seconds}s")
    print(f"[AudioUtils] Samples: {start_sample} to {end_sample} (total {end_sample - start_sample} samples)")
    
    return audio_segment


def load_audio_from_any_file(audio_path: str) -> dict:
    """Load audio from any format file path (mp3, flac, wav, ogg, m4a, etc.) using FFmpeg.

    If the file is already a WAV, loads directly. Otherwise converts to WAV
    (pcm_s16le, 44100Hz, stereo) with caching, then loads.
    """
    import os
    import subprocess
    import hashlib
    from .video_utils import FFMPEG_PATH, AUDIO_CACHE_DIR

    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    # If already WAV, load directly
    if audio_path.lower().endswith('.wav'):
        return load_audio_from_file(audio_path)

    if not os.path.exists(FFMPEG_PATH):
        raise FileNotFoundError(f"FFmpeg not found at: {FFMPEG_PATH}")

    # Generate cache key and filename
    audio_key = hashlib.md5(audio_path.encode('utf-8')).hexdigest()
    audio_name = os.path.splitext(os.path.basename(audio_path))[0]
    cache_file = os.path.join(AUDIO_CACHE_DIR, f"{audio_name}_{audio_key[:8]}.wav")

    # Check cache
    if os.path.exists(cache_file):
        try:
            print(f"[AudioUtils] Loading audio from cache: {cache_file}")
            return load_audio_from_file(cache_file)
        except Exception as e:
            print(f"[AudioUtils] Cache load failed: {e}, re-converting...")
            try:
                os.remove(cache_file)
            except Exception:
                pass

    # Convert using FFmpeg
    cmd = [
        FFMPEG_PATH, '-i', audio_path,
        '-vn',
        '-acodec', 'pcm_s16le',
        '-ar', '44100',
        '-ac', '2',
        '-f', 'wav',
        '-y',
        cache_file
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg failed: {result.stderr.strip()}")

        audio_dict = load_audio_from_file(cache_file)
        print(f"[AudioUtils] Audio loaded | Shape: {audio_dict['waveform'].shape} @ {audio_dict['sample_rate']}Hz")
        return audio_dict
    except Exception as e:
        print(f"[AudioUtils] Conversion error: {e}")
        raise


def extract_audio_from_video(video):
    """Extract audio from video using FFmpeg with caching."""
    import os
    import subprocess
    import json
    import hashlib
    from .video_utils import FFMPEG_PATH, AUDIO_CACHE_DIR
    
    # Get video path
    if hasattr(video, 'get_stream_source'):
        video_path = video.get_stream_source()
    elif hasattr(video, 'video_path'):
        video_path = video.video_path
    else:
        raise ValueError("Video object must have 'get_stream_source()' or 'video_path' attribute")

    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video file not found: {video_path}")

    # Generate cache key and filename
    video_key = hashlib.md5(video_path.encode('utf-8')).hexdigest()
    video_name = os.path.splitext(os.path.basename(video_path))[0]
    cache_file = os.path.join(AUDIO_CACHE_DIR, f"{video_name}_{video_key[:8]}.wav")
    cache_index_file = os.path.join(AUDIO_CACHE_DIR, "GetVideoAudioNodeCache.json")

    # Load cache index
    def load_cache_index():
        if os.path.exists(cache_index_file):
            try:
                with open(cache_index_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception as e:
                print(f"[AudioUtils] Warning: Failed to load cache index: {e}")
        return {}

    def save_cache_index(cache_index):
        try:
            with open(cache_index_file, 'w', encoding='utf-8') as f:
                json.dump(cache_index, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[AudioUtils] Warning: Failed to save cache index: {e}")

    # Check cache
    cache_index = load_cache_index()
    if video_key in cache_index:
        cache_info = cache_index[video_key]
        cached_file = cache_info.get("cache_path")
        if cached_file and os.path.exists(cached_file):
            try:
                print(f"[AudioUtils] Loading audio from cache: {cached_file}")
                audio_dict = load_audio_from_file(cached_file)
                print(f"[AudioUtils] Cache loaded | Shape: {audio_dict['waveform'].shape} @ {audio_dict['sample_rate']}Hz")
                return audio_dict
            except Exception as e:
                print(f"[AudioUtils] Cache load failed: {e}, re-extracting...")
                cache_index.pop(video_key, None)
                save_cache_index(cache_index)

    # Check FFmpeg
    if not os.path.exists(FFMPEG_PATH):
        raise FileNotFoundError(f"FFmpeg not found at: {FFMPEG_PATH}")

    # Extract audio using FFmpeg
    cmd = [
        FFMPEG_PATH, '-i', video_path,
        '-vn',
        '-acodec', 'pcm_s16le',
        '-ar', '44100',
        '-ac', '2',
        '-f', 'wav',
        '-y',
        cache_file
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg failed: {result.stderr.strip()}")

        audio_dict = load_audio_from_file(cache_file)

        # Update cache index
        cache_index[video_key] = {
            "video_path": video_path,
            "cache_path": cache_file,
            "sample_rate": audio_dict["sample_rate"],
            "channels": audio_dict["waveform"].shape[1],
            "samples": audio_dict["waveform"].shape[2]
        }
        save_cache_index(cache_index)

        print(f"[AudioUtils] Audio extracted | Shape: {audio_dict['waveform'].shape} @ {audio_dict['sample_rate']}Hz")
        return audio_dict

    except Exception as e:
        print(f"[AudioUtils] Extraction error: {e}")
        raise