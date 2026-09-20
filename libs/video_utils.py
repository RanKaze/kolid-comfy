import os
import re
import shutil
import subprocess
import json
import threading
from collections import deque
from urllib.parse import urlparse
from pathlib import Path
from seleniumbase import Driver
import folder_paths
import random
import time
import torch
import numpy as np
from decord import VideoReader, cpu
import decord
from .timestamp import parse_timestamp
import cv2
from PIL import Image
import hashlib

try:
    import yt_dlp
    YT_DLP_AVAILABLE = True
except ImportError:
    YT_DLP_AVAILABLE = False


FFMPEG_BIN_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "plugins", "ffmpeg", "bin")
FFMPEG_PATH = os.path.join(FFMPEG_BIN_PATH, "ffmpeg.exe")
FFPROBE_PATH = os.path.join(FFMPEG_BIN_PATH, "ffprobe.exe")

# Cookie file path for hanime1
COOKIES_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "cookies")
os.makedirs(COOKIES_DIR, exist_ok=True)
print(f"[comfy-kolid] Cookies 将保存到: {COOKIES_DIR}")

def get_cookies_with_seleniumbase(
    url: str,
    proxy: str = None,
    headless: bool = True,      # 先用 False 测试，确认能过再改 True
    wait_seconds: int = 22
):
    """
    使用 SeleniumBase UC Mode 获取 cookies（同步，稳定）
    """
    print(f"🚀 SeleniumBase UC Mode 正在访问: {url} (headless={headless})")
    
    try:
        driver = Driver(
            uc=True,                    # 关键：Undetected Chrome Mode
            headless=headless,
            headless2=False,            # headless2 有时更稳，可尝试 True
            proxy=proxy,
            no_sandbox=True,
            disable_gpu=False if headless else True,
        )
        
        driver.uc_open_with_reconnect(url, 4)   # 带重连，适合 Cloudflare
        
        # 模拟人类行为（滚动 + 等待）
        for _ in range(3):
            driver.execute_script("window.scrollBy(0, arguments[0]);", random.randint(400, 900))
            time.sleep(random.uniform(2.0, 5.0))
        
        driver.uc_gui_click_captcha()   # 自动尝试点击 Turnstile / Challenge（如果出现）
        
        print(f"等待 Cloudflare 挑战通过... ({wait_seconds} 秒)")
        time.sleep(wait_seconds)
        
        # 获取 cookies
        cookies = driver.get_cookies()
        print(f"✅ 获取到 {len(cookies)} 个 cookies")
        
        # 转为 dict 格式方便保存
        cookie_list = []
        for c in cookies:
            cookie_list.append({
                "domain": c.get("domain"),
                "path": c.get("path", "/"),
                "secure": c.get("secure", False),
                "expires": c.get("expiry", 0),
                "name": c.get("name"),
                "value": c.get("value")
            })
        
        driver.quit()
        return cookie_list
        
    except Exception as e:
        print(f"❌ SeleniumBase 获取 cookies 失败: {e}")
        if 'driver' in locals():
            try:
                driver.quit()
            except:
                pass
        raise


def save_cookies_for_yt_dlp(cookies, cookie_file: str):
    """保存为 yt-dlp Netscape 格式"""
    with open(cookie_file, "w", encoding="utf-8") as f:
        f.write("# Netscape HTTP Cookie File\n")
        f.write("# Generated for ComfyUI + yt-dlp\n\n")
        
        for cookie in cookies:
            domain = cookie.get("domain", "").lstrip(".")
            if not domain.startswith(".") and "." in domain:
                domain = "." + domain
            path = cookie.get("path", "/")
            secure = "TRUE" if cookie.get("secure", False) else "FALSE"
            expires = int(cookie.get("expires", 0))
            name = cookie.get("name", "")
            value = cookie.get("value", "")
            
            f.write(f"{domain}\tTRUE\t{path}\t{secure}\t{expires}\t{name}\t{value}\n")
    
    print(f"✅ Cookies 已保存: {cookie_file}")


INPUT_DIR = folder_paths.get_input_directory()
# 视频缓存统一放在 ComfyUI output/videocache 下(所有 video 相关节点共用)
CACHE_DIR = os.path.join(folder_paths.get_output_directory(), "videocache")
AUDIO_CACHE_DIR = os.path.join(INPUT_DIR, "audio_cache")
if not os.path.exists(CACHE_DIR):
    os.makedirs(CACHE_DIR, exist_ok=True)
if not os.path.exists(AUDIO_CACHE_DIR):
    os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)

ext_map = {
    "mp4": ".mp4",
    "mov,mp4,m4a,3gp,3g2,mj2": ".mp4",
    "mov": ".mov",
    "webm": ".webm",
    "matroska,webm": ".mkv",
    "matroska": ".mkv",
    "mkv": ".mkv",
    "avi": ".avi",
    "flv": ".flv",
    "3gp": ".3gp",
    "3g2": ".3g2",
    "mpeg": ".mpg",
    "mpegts": ".ts",
    "mpegts,h264": ".ts",
    "wav": ".wav",
    "ogg": ".ogg",
    "ogv": ".ogv",
    "asf": ".wmv",
    "wmv": ".wmv",
    "rm": ".rm",
    "rmvb": ".rmvb",
    "quicktime": ".mov",
    "ismv": ".ismv",
    "ism": ".ism",
    "f4v": ".f4v",
    "m4v": ".m4v",
}


def is_pornhub_url(url):
    """Check if URL is a Pornhub URL."""
    parsed = urlparse(url.lower())
    return "pornhub.com" in parsed.netloc


def is_youtube_url(url):
    """Check if URL is a YouTube URL."""
    parsed = urlparse(url.lower())
    return "youtube.com" in parsed.netloc or "youtu.be" in parsed.netloc


def is_hanime1_url(url):
    """Check if URL is a Hanime1 URL."""
    parsed = urlparse(url.lower())
    return "hanime1.me" in parsed.netloc or "hanime1.tv" in parsed.netloc


def get_video_correct_ext(video_path):
    """Get actual video format name using ffprobe."""
    cmd = [
        FFPROBE_PATH,
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        video_path
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            raise Exception(f"ffprobe failed with code {result.returncode}")

        data = json.loads(result.stdout)
        fmt = data.get("format", {})
        format_name = fmt.get("format_name", "").lower()

        print(f"[VideoUtils] ===== Video Format Info =====")
        print(f"[VideoUtils] format_name       : {format_name}")
        print(f"[VideoUtils] format_long_name  : {fmt.get('format_long_name', '')}")
        print(f"[VideoUtils] duration          : {fmt.get('duration', 'N/A')}")
        print(f"[VideoUtils] size              : {fmt.get('size', 'N/A')} bytes")
        print(f"[VideoUtils] ============================")

        if format_name in ext_map:
            return ext_map[format_name]

        for stream in data.get("streams", []):
            if stream.get("codec_type") == "video":
                codec = stream.get("codec_name", "").lower()
                if codec in ("h264", "avc", "avc1"):
                    if "mp4" in format_name or "mov" in format_name:
                        return ".mp4"
                elif codec in ("vp8", "vp9"):
                    return ".webm"
                elif codec == "theora":
                    return ".ogv"
                elif codec in ("mpeg4", "msmpeg4v3"):
                    if "avi" in format_name:
                        return ".avi"
                    if "mp4" in format_name:
                        return ".mp4"

        print(f"[VideoUtils] Unable to determine extension, format_name={format_name}")
        return ""

    except subprocess.TimeoutExpired:
        print("[VideoUtils] ffprobe execution timeout")
        return ""
    except json.JSONDecodeError:
        print("[VideoUtils] ffprobe output is not valid JSON")
        return ""
    except Exception as e:
        print(f"[VideoUtils] Unexpected error: {e}")
        return ""


def remux_to_mp4(input_path):
    """Fast remux to MP4 container without re-encoding via MKV intermediate."""
    input_path = Path(input_path).resolve()
    if not input_path.is_file():
        print(f"[VideoUtils] Not a file: {input_path}")
        return None

    temp_mkv = input_path.with_suffix(".remux_temp.mkv")
    # 确保最终输出路径与输入路径不同
    if input_path.suffix.lower() == ".mp4":
        # 如果输入已经是mp4，使用不同的文件名
        final_output = input_path.with_name(f"{input_path.stem}_remuxed.mp4")
    else:
        final_output = input_path.with_suffix(".mp4")

    print(f"[VideoUtils] Remuxing step 1: {input_path} -> {temp_mkv}")

    cmd1 = [
        FFMPEG_PATH,
        "-y",
        "-i", str(input_path),
        "-c", "copy",
        "-f", "matroska",
        str(temp_mkv)
    ]

    try:
        result1 = subprocess.run(
            cmd1,
            capture_output=True,
            text=True,
            timeout=600,
            check=False
        )

        if result1.returncode != 0:
            print(f"[VideoUtils] Step 1 failed (code {result1.returncode})")
            err = result1.stderr.strip()
            if err:
                print(f"[VideoUtils] FFmpeg error:\n{err[:1500]}")
            if temp_mkv.exists():
                temp_mkv.unlink()
            return None

        if not temp_mkv.exists() or temp_mkv.stat().st_size < 100_000:
            print("[VideoUtils] Step 1 output is empty or too small")
            if temp_mkv.exists():
                temp_mkv.unlink()
            return None

        print(f"[VideoUtils] Remuxing step 2: {temp_mkv} -> {final_output}")

        cmd2 = [
            FFMPEG_PATH,
            "-y",
            "-i", str(temp_mkv),
            "-c", "copy",
            "-movflags", "+faststart",
            str(final_output)
        ]

        result2 = subprocess.run(
            cmd2,
            capture_output=True,
            text=True,
            timeout=600,
            check=False
        )

        temp_mkv.unlink()
        print(f"[VideoUtils] Deleted temp file: {temp_mkv}")

        if result2.returncode != 0:
            print(f"[VideoUtils] Step 2 failed (code {result2.returncode})")
            err = result2.stderr.strip()
            if err:
                print(f"[VideoUtils] FFmpeg error:\n{err[:1500]}")
            return None

        if not final_output.exists() or final_output.stat().st_size < 100_000:
            print("[VideoUtils] Step 2 output is empty or too small")
            if final_output.exists():
                final_output.unlink()
            return None

        # Only delete original if it's different from final output
        if input_path != final_output and input_path.exists():
            input_path.unlink()
            print(f"[VideoUtils] Deleted original file: {input_path}")

        print(f"[VideoUtils] Remux successful: {final_output}")
        return str(final_output)

    except Exception as e:
        print(f"[VideoUtils] Remux unexpected error: {e}")
        if temp_mkv.exists():
            temp_mkv.unlink()
        return None


def get_video_fps(video_path):
    """Get video real FPS, returns 30 on failure."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise Exception(f"Failed to open video: {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS)
    return fps


# ==================== VHS-style fast segment extraction (ffmpeg pipe) ====================

_FFPROBE_METADATA_CACHE = {}


def _run_ffprobe_json(video_path):
    """Run ffprobe and return parsed JSON metadata.

    Uses Popen with explicit pipes instead of subprocess.run(capture_output=True),
    because some ComfyUI plugin environments monkey-patch subprocess.run in ways
    that silently drop captured output (stdout becomes None).
    """
    if not os.path.exists(FFPROBE_PATH):
        raise FileNotFoundError(f"ffprobe not found: {FFPROBE_PATH}")

    cmd = [
        FFPROBE_PATH, '-v', 'quiet', '-print_format', 'json',
        '-show_format', '-show_streams', video_path
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        stdout, stderr = proc.communicate()
    except BaseException:
        try:
            proc.kill()
        except Exception:
            pass
        raise

    if proc.returncode != 0 or not stdout:
        err = (stderr or b'').decode('utf-8', errors='replace')[:300]
        raise Exception(f"ffprobe failed (code {proc.returncode}): {err}")

    try:
        return json.loads(stdout.decode('utf-8', errors='replace'))
    except json.JSONDecodeError as e:
        raise Exception(f"ffprobe returned invalid JSON: {e}")


def _metadata_from_opencv(video_path):
    """Fallback metadata via OpenCV (metadata-only query, no decoding).
    Note: cannot detect audio stream, so has_audio is optimistic; downstream
    code falls back to the legacy path if audio extraction then fails.
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise Exception(f"Failed to open video: {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()

    if fps <= 0:
        fps = 30.0
    duration = frame_count / fps if frame_count > 0 else 0.0
    return {
        "fps": fps,
        "frame_count": max(0, frame_count),
        "width": width,
        "height": height,
        "duration": duration,
        "has_audio": True,
    }


def get_video_metadata(video_path):
    """Get video metadata via ffprobe, cached by (path, mtime).

    Returns dict with: fps, frame_count, width, height, duration, has_audio.
    width/height are the STORED dimensions (extraction uses -noautorotate,
    matching decord/OpenCV legacy behavior).
    """
    video_path = os.path.abspath(video_path)
    try:
        mtime = os.path.getmtime(video_path)
    except OSError:
        mtime = 0
    cache_key = (video_path, mtime)
    if cache_key in _FFPROBE_METADATA_CACHE:
        return _FFPROBE_METADATA_CACHE[cache_key]

    try:
        data = _run_ffprobe_json(video_path)
    except Exception as e:
        print(f"[VideoUtils] ffprobe metadata failed ({e}), falling back to OpenCV")
        metadata = _metadata_from_opencv(video_path)
        _FFPROBE_METADATA_CACHE[cache_key] = metadata
        return metadata

    vstream = None
    astream = None
    for s in data.get("streams", []):
        if s.get("codec_type") == "video" and vstream is None:
            vstream = s
        elif s.get("codec_type") == "audio" and astream is None:
            astream = s

    if vstream is None:
        raise Exception(f"No video stream found in {video_path}")

    # FPS: prefer avg_frame_rate, fallback to r_frame_rate
    fps = 0.0
    for rate in (vstream.get("avg_frame_rate"), vstream.get("r_frame_rate")):
        try:
            if rate and rate not in ("0/0", "N/A"):
                num, den = rate.split("/")
                den_f = float(den)
                if den_f > 0:
                    candidate = float(num) / den_f
                    if candidate > 0:
                        fps = candidate
                        break
        except (ValueError, AttributeError):
            continue
    if fps <= 0:
        raise Exception(f"Could not determine FPS for {video_path}")

    width = int(vstream.get("width", 0))
    height = int(vstream.get("height", 0))
    if width <= 0 or height <= 0:
        raise Exception(f"Could not determine resolution for {video_path}")

    # NOTE: width/height are the STORED dimensions. Frame extraction uses
    # -noautorotate (VHS/decord-compatible behavior), so the rawvideo pipe
    # always matches these dims — no ambiguity, no reshape failures.

    duration = 0.0
    try:
        duration = float(vstream.get("duration") or data.get("format", {}).get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0

    frame_count = 0
    try:
        frame_count = int(vstream.get("nb_frames") or 0)
    except (TypeError, ValueError):
        frame_count = 0
    if frame_count <= 0 and duration > 0:
        frame_count = int(duration * fps)
    if frame_count <= 0:
        # Last resort: OpenCV metadata query (fast, no decoding)
        cap = cv2.VideoCapture(video_path)
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()

    metadata = {
        "fps": fps,
        "frame_count": max(0, frame_count),
        "width": width,
        "height": height,
        "duration": duration,
        "has_audio": astream is not None,
    }
    _FFPROBE_METADATA_CACHE[cache_key] = metadata
    return metadata


_STDERR_TAIL_LINES = 30
_PIPE_CHUNK = 4 * 1024 * 1024


def _read_ffmpeg_output(proc, num_bytes=None, chunk_size=_PIPE_CHUNK, on_chunk=None):
    """Read proc.stdout in chunks until num_bytes are read, or until EOF when
    num_bytes is None. Returns the bytes read.

    Fail-fast: no timeouts, no retries, no artificial waits. The read finishes
    as fast as ffmpeg produces data; if ffmpeg errors out, it exits and the
    read returns immediately (EOF) with its stderr tail available for the error.
    on_chunk(cumulative_bytes) fires after each chunk for progress reporting.
    """
    chunk_size = max(1, int(chunk_size))
    chunks = []
    total = 0
    remaining = num_bytes
    while True:
        want = chunk_size if remaining is None else min(remaining, chunk_size)
        if want <= 0:
            break
        chunk = proc.stdout.read(want)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if on_chunk is not None:
            on_chunk(total)
        if remaining is not None:
            remaining -= len(chunk)
            if remaining <= 0:
                break
    return b''.join(chunks)


def _spawn_ffmpeg(cmd):
    """Spawn ffmpeg and start a daemon thread draining stderr.

    stderr MUST be drained concurrently: otherwise ffmpeg can block writing to
    a full stderr pipe (64KB) while we block reading stdout -> permanent
    deadlock (the classic "node stuck forever" failure).

    Returns (proc, stderr_tail_deque).
    """
    if not os.path.exists(FFMPEG_PATH):
        raise FileNotFoundError(f"ffmpeg not found: {FFMPEG_PATH}")

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    stderr_tail = deque(maxlen=_STDERR_TAIL_LINES)

    def _drain_stderr():
        try:
            for line in iter(proc.stderr.readline, b''):
                text = line.decode('utf-8', errors='backslashreplace').strip()
                if text:
                    stderr_tail.append(text)
        except Exception:
            pass

    threading.Thread(target=_drain_stderr, daemon=True).start()
    return proc, stderr_tail


def _reap_ffmpeg(proc):
    """Close stdout and reap the process. Returns the returncode."""
    try:
        proc.stdout.close()
    except Exception:
        pass
    return proc.wait()


def _run_ffmpeg_pipe(cmd, num_bytes=None, label="ffmpeg", chunk_size=_PIPE_CHUNK, on_chunk=None):
    """Run ffmpeg reading raw bytes from its stdout pipe.

    - NO timeouts / watchdogs / retries: failures surface immediately —
      ffmpeg exits on error and we raise with its stderr tail attached
    - the process is always reaped, even on errors

    Returns (data, returncode, stderr_tail_text).
    """
    proc, stderr_tail = _spawn_ffmpeg(cmd)
    try:
        data = _read_ffmpeg_output(proc, num_bytes, chunk_size, on_chunk)
    except BaseException:
        try:
            proc.kill()
        except Exception:
            pass
        raise
    finally:
        ret = _reap_ffmpeg(proc)

    stderr_text = '\n'.join(stderr_tail)
    return data, ret, stderr_text


def extract_frames_segment_ffmpeg(video_path, start_sec, num_frames, video_filters=None, metadata=None, progress_cb=None):
    """VHS-style fast frame extraction: two-stage seek (fast keyframe jump +
    precise 4s alignment), decode ONLY the requested span, pipe raw RGB frames
    back (single pass, no temp files, no full decode, no autorotate).

    video_filters: optional list of ffmpeg -vf filters (e.g. ["fps=12", "scale=768:1365"])
    applied during the same decode pass (VHS-style resize-at-load).
    progress_cb(frames_done) is called periodically with the number of frames
    decoded so far (int, capped at num_frames) for progress display.

    Returns (image_tensor [N, H, W, 3] float32 in 0..1, frames_read).
    """
    if metadata is None:
        metadata = get_video_metadata(video_path)
    width = metadata["width"]
    height = metadata["height"]
    num_frames = int(num_frames)
    if num_frames <= 0:
        raise Exception("No frames to extract")

    start_sec = max(0.0, float(start_sec))

    # VHS ffmpeg_generator seek strategy: when target is > 4s into the file,
    # seek fast to (start - 4) BEFORE -i (keyframe jump) and trim the remaining
    # 4s precisely AFTER -i (decoder-level), guaranteeing alignment.
    cmd = [FFMPEG_PATH, '-hide_banner', '-nostats', '-v', 'error',
           '-nostdin', '-noautorotate']
    if start_sec > 4.0:
        cmd += ['-ss', f'{start_sec - 4.0:.6f}', '-i', video_path, '-ss', '4']
    else:
        cmd += ['-ss', f'{start_sec:.6f}', '-i', video_path]
    if video_filters:
        cmd += ['-vf', ','.join(video_filters)]
    cmd += ['-frames:v', str(num_frames), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']

    frame_bytes = width * height * 3
    # Read+convert in whole-frame chunks (~16MB) so the progress bar covers the
    # ENTIRE pipeline: decode AND float conversion, with no dead time afterwards.
    chunk_size = max(1, (16 * 1024 * 1024) // frame_bytes) * frame_bytes

    image_tensor = torch.empty((num_frames, height, width, 3), dtype=torch.float32)
    frames_read = 0

    proc, stderr_tail = _spawn_ffmpeg(cmd)
    try:
        while frames_read < num_frames:
            want = min(chunk_size, (num_frames - frames_read) * frame_bytes)
            chunk = proc.stdout.read(want)
            if not chunk:
                break  # EOF: stream ended early
            n = len(chunk) // frame_bytes
            if n > 0:
                arr = np.frombuffer(chunk, dtype=np.uint8, count=n * frame_bytes).copy()
                image_tensor[frames_read:frames_read + n] = (
                    torch.from_numpy(arr.reshape(n, height, width, 3)).float())
                image_tensor[frames_read:frames_read + n].div_(255.0)
                frames_read += n
            if progress_cb is not None:
                progress_cb(frames_read)
    except BaseException:
        try:
            proc.kill()
        except Exception:
            pass
        raise
    finally:
        ret = _reap_ffmpeg(proc)

    stderr_text = '\n'.join(stderr_tail)
    if frames_read == 0:
        raise Exception(f"ffmpeg frame extraction failed (code {ret}): {stderr_text[:500]}")
    if ret != 0:
        print(f"[VideoUtils] ffmpeg frame extraction warning (code {ret}): {stderr_text[:300]}")

    print(f"[VideoUtils] ffmpeg extracted {frames_read}/{num_frames} frames @ {width}x{height}")
    return image_tensor[:frames_read], frames_read


def extract_audio_segment_ffmpeg(video_path, start_sec, duration, sample_rate=44100, channels=2):
    """Decode ONLY the requested audio span via ffmpeg (s16le pipe, no temp files,
    no full-track decode). Returns {waveform [1, C, T], sample_rate}.
    """
    duration = float(duration)
    if duration <= 0:
        raise ValueError("Audio duration must be positive")

    cmd = [
        FFMPEG_PATH, '-hide_banner', '-nostats', '-v', 'error', '-nostdin',
        '-ss', f'{max(0.0, float(start_sec)):.6f}',
        '-i', video_path,
        '-t', f'{duration:.6f}',
        '-vn', '-acodec', 'pcm_s16le',
        '-ar', str(int(sample_rate)), '-ac', str(int(channels)),
        '-f', 's16le', 'pipe:1'
    ]
    data, ret, stderr_text = _run_ffmpeg_pipe(cmd, label="ffmpeg audio extraction")

    if len(data) == 0:
        raise Exception(f"No audio decoded (code {ret}): {stderr_text[:300]}")

    audio_np = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
    usable = (len(audio_np) // channels) * channels
    audio_np = audio_np[:usable].reshape(-1, channels).T          # [C, T]
    waveform = torch.from_numpy(audio_np.copy()).unsqueeze(0)     # [1, C, T]

    print(f"[VideoUtils] ffmpeg audio segment: {waveform.shape[-1]} samples @ {sample_rate}Hz")
    return {"waveform": waveform, "sample_rate": int(sample_rate)}


def download_video_with_ytdlp(url, clear_cache=False):
    """Use yt-dlp Python library to download the video with integrity checks."""
    temp_path = None
    print(f"[VideoUtils] Processing URL: {url}")

    if not YT_DLP_AVAILABLE:
        raise Exception("yt-dlp Python library not available")

    ydl_opts_info = {'quiet': True, 'no_warnings': True}
    with yt_dlp.YoutubeDL(ydl_opts_info) as ydl:
        info = ydl.extract_info(url, download=False)
        video_id = info.get('id', 'video')
        video_ext = info.get('ext', 'mp4')
        video_title = info.get('title', 'Unknown')
        video_duration = info.get('duration', 0)

    print(f"[VideoUtils] Title: {video_title}, Duration: {video_duration}s")

    safe_title = re.sub(r'[<>:"/\\|?*]', '_', video_title).strip('. ')
    cache_path = os.path.join(CACHE_DIR, f"{safe_title}.{video_ext}")
    temp_path = cache_path + ".downloading"
    if os.path.exists(temp_path):
        os.remove(temp_path)

    ydl_opts = {
        'user_agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'outtmpl': temp_path,

        'ffmpeg_location': FFMPEG_PATH,

        'format_sort': [
            'res:1080',
            'res:720',
            '+vcodec:h264',
            '+acodec:aac',
            'size',
            'br',
            'ext:mp4',
        ],

        'format': 'bestvideo+bestaudio/best',
        'merge_output_format': 'mp4',
        'noplaylist': True,
        'quiet': False,
        'no_warnings': False,
        'continuedl': True,

        'retries': 10,
        'fragment_retries': 10,

        'concurrent_fragments': 5,
        'http_chunk_size': 10 * 1024 * 1024,
    }

    print(f"[VideoUtils] Downloading to: {temp_path}")
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])

    # yt-dlp adds .mp4 extension after merging
    actual_temp_path = temp_path + ".mp4"
    if not os.path.exists(actual_temp_path):
        actual_temp_path = temp_path

    verify_cmd = [
        FFMPEG_PATH, '-v', 'error', '-i', actual_temp_path,
        '-f', 'null', '-'
    ]
    verify_result = subprocess.run(
        verify_cmd, capture_output=True, text=True, timeout=120
    )

    if verify_result.returncode != 0:
        raise Exception(f"Downloaded file is corrupted: {verify_result.stderr[:500]}")

    if os.path.exists(cache_path):
        os.remove(cache_path)
    shutil.move(actual_temp_path, cache_path)

    file_size = os.path.getsize(cache_path)
    print(f"[VideoUtils] Success: {cache_path} ({file_size} bytes)")
    return cache_path


def download_pornhub(url, clear_cache=False):
    """Download video from Pornhub URL using yt-dlp with integrity checks."""
    temp_path = None
    print(f"[PornhubDownloader] Processing URL: {url}")

    if not YT_DLP_AVAILABLE:
        raise Exception("yt-dlp Python library not available")

    ydl_opts_info = {'quiet': True, 'no_warnings': True}
    with yt_dlp.YoutubeDL(ydl_opts_info) as ydl:
        info = ydl.extract_info(url, download=False)
        video_id = info.get('id', 'video')
        video_ext = info.get('ext', 'mp4')
        video_title = info.get('title', 'Unknown')
        video_duration = info.get('duration', 0)

    print(f"[PornhubDownloader] Title: {video_title}, Duration: {video_duration}s")

    safe_title = re.sub(r'[<>:"/\\|?*]', '_', video_title).strip('. ')
    cache_path = os.path.join(CACHE_DIR, f"{safe_title}.{video_ext}")
    temp_path = cache_path + ".downloading"
    if os.path.exists(temp_path):
        os.remove(temp_path)

    ydl_opts = {
        'user_agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'outtmpl': temp_path,

        'format_sort': [
            'res:1080',
            'res:720',
            '+vcodec:h264',
            '+acodec:aac',
            'size',
            'br',
            'ext:mp4',
        ],

        'format': 'bestvideo+bestaudio/best',
        'merge_output_format': 'mp4',
        'noplaylist': True,
        'quiet': False,
        'no_warnings': False,
        'continuedl': True,

        'retries': 10,
        'fragment_retries': 10,

        'concurrent_fragments': 5,
        'http_chunk_size': 10 * 1024 * 1024,
    }

    print(f"[PornhubDownloader] Downloading to: {temp_path}")
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])

    # yt-dlp adds .mp4 extension after merging
    actual_temp_path = temp_path + ".mp4"
    if not os.path.exists(actual_temp_path):
        actual_temp_path = temp_path

    verify_cmd = [
        FFMPEG_PATH, '-v', 'error', '-i', actual_temp_path,
        '-f', 'null', '-'
    ]
    verify_result = subprocess.run(
        verify_cmd, capture_output=True, text=True, timeout=120
    )

    if verify_result.returncode != 0:
        raise Exception(f"Downloaded file is corrupted: {verify_result.stderr[:500]}")

    if os.path.exists(cache_path):
        os.remove(cache_path)
    shutil.move(actual_temp_path, cache_path)

    file_size = os.path.getsize(cache_path)
    print(f"[PornhubDownloader] Success: {cache_path} ({file_size} bytes)")
    return cache_path


def download_youtube(url, clear_cache=False):
    """Download video from YouTube URL using yt-dlp with integrity checks."""
    temp_path = None
    print(f"[YouTubeDownloader] Processing URL: {url}")

    if not YT_DLP_AVAILABLE:
        raise Exception("yt-dlp Python library not available")

    ydl_opts_info = {'quiet': True, 'no_warnings': True}
    with yt_dlp.YoutubeDL(ydl_opts_info) as ydl:
        info = ydl.extract_info(url, download=False)
        video_id = info.get('id', 'video')
        video_ext = info.get('ext', 'mp4')
        video_title = info.get('title', 'Unknown')
        video_duration = info.get('duration', 0)

    print(f"[YouTubeDownloader] Title: {video_title}, Duration: {video_duration}s")

    safe_title = re.sub(r'[<>:"/\\|?*]', '_', video_title).strip('. ')
    cache_path = os.path.join(CACHE_DIR, f"{safe_title}.{video_ext}")
    temp_path = cache_path + ".downloading"
    if os.path.exists(temp_path):
        os.remove(temp_path)

    ydl_opts = {
        'user_agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'outtmpl': temp_path,

        'ffmpeg_location': FFMPEG_PATH,

        'format_sort': [
            'res:1080',
            'res:720',
            '+vcodec:h264',
            '+acodec:aac',
            'size',
            'br',
            'ext:mp4',
        ],

        'format': 'bestvideo+bestaudio/best',
        'merge_output_format': 'mp4',
        'noplaylist': True,
        'quiet': False,
        'no_warnings': False,
        'continuedl': True,

        'retries': 10,
        'fragment_retries': 10,

        'concurrent_fragments': 5,
        'http_chunk_size': 10 * 1024 * 1024,
    }

    print(f"[YouTubeDownloader] Downloading to: {temp_path}")
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])

    # yt-dlp adds .mp4 extension after merging
    actual_temp_path = temp_path + ".mp4"
    if not os.path.exists(actual_temp_path):
        actual_temp_path = temp_path

    verify_cmd = [
        FFMPEG_PATH, '-v', 'error', '-i', actual_temp_path,
        '-f', 'null', '-'
    ]
    verify_result = subprocess.run(
        verify_cmd, capture_output=True, text=True, timeout=120
    )

    if verify_result.returncode != 0:
        raise Exception(f"Downloaded file is corrupted: {verify_result.stderr[:500]}")

    if os.path.exists(cache_path):
        os.remove(cache_path)
    shutil.move(actual_temp_path, cache_path)

    file_size = os.path.getsize(cache_path)
    print(f"[YouTubeDownloader] Success: {cache_path} ({file_size} bytes)")
    return cache_path



def download_hanime1(url: str, clear_cache: bool = False):
    """Download video from hanime1 URL using SeleniumBase UC + yt-dlp (修复 Cloudflare 403)"""
    print(f"[Hanime1Downloader] Processing URL: {url}")

    if not YT_DLP_AVAILABLE:
        raise Exception("yt-dlp Python library not available")

    # ====================== Step 1: SeleniumBase 获取 cookies ======================
    cookie_file = os.path.join(COOKIES_DIR, "hanime1_cookies.txt")
    
    if clear_cache and os.path.exists(cookie_file):
        try:
            os.remove(cookie_file)
        except:
            pass

    print(f"[Hanime1Downloader] 使用 SeleniumBase UC Mode 绕过 Cloudflare...")
    
    driver = None
    try:
        driver = Driver(
            uc=True,
            headless=True,              # 调试时请改为 False
            headless2=False,
            no_sandbox=True,
        )

        driver.uc_open_with_reconnect(url, 4)

        for _ in range(3):
            driver.execute_script("window.scrollBy(0, arguments[0]);", random.randint(400, 900))
            time.sleep(random.uniform(2.0, 5.0))

        driver.uc_gui_click_captcha()
        print(f"[Hanime1Downloader] 等待 Cloudflare 挑战通过... (约 25 秒)")
        time.sleep(25)

        cookies = driver.get_cookies()
        with open(cookie_file, "w", encoding="utf-8") as f:
            f.write("# Netscape HTTP Cookie File\n")
            f.write("# Generated for ComfyUI Hanime1 Downloader\n\n")
            for c in cookies:
                domain = c.get("domain", "").lstrip(".")
                if not domain.startswith(".") and "." in domain:
                    domain = "." + domain
                path = c.get("path", "/")
                secure = "TRUE" if c.get("secure", False) else "FALSE"
                expires = int(c.get("expiry", 0))
                name = c.get("name", "")
                value = c.get("value", "")
                f.write(f"{domain}\tTRUE\t{path}\t{secure}\t{expires}\t{name}\t{value}\n")

        print(f"[Hanime1Downloader] Cookies 已保存: {cookie_file}")

    except Exception as e:
        print(f"[Hanime1Downloader] SeleniumBase 失败: {e}")
        raise Exception(f"Failed to bypass Cloudflare: {e}")
    finally:
        if driver is not None:
            try:
                driver.quit()
            except:
                pass

    # ====================== Step 2: 获取视频信息 ======================
    ydl_opts_info = {
        'quiet': True,
        'no_warnings': True,
        'cookies': cookie_file,
        'impersonate': 'chrome',                    # 推荐方式
    }

    with yt_dlp.YoutubeDL(ydl_opts_info) as ydl:
        info = ydl.extract_info(url, download=False)
        video_title = info.get('title', 'Unknown')
        video_duration = info.get('duration', 0)

    print(f"[Hanime1Downloader] Title: {video_title}, Duration: {video_duration}s")

    # ====================== Step 3: 下载视频 ======================
    safe_title = re.sub(r'[<>:"/\\|?*]', '_', video_title).strip('. ')
    cache_path = os.path.join(CACHE_DIR, f"{safe_title}.mp4")
    temp_path = cache_path + ".downloading"

    if os.path.exists(temp_path):
        try:
            os.remove(temp_path)
        except:
            pass

    ydl_opts = {
        'outtmpl': temp_path,
        'ffmpeg_location': FFMPEG_PATH,
        'cookies': cookie_file,

        'impersonate': 'chrome',                    # 关键修复
        'extractor_args': {'generic': {'impersonate': 'chrome'}},

        'format': 'bestvideo+bestaudio/best',
        'merge_output_format': 'mp4',
        'noplaylist': True,
        'continuedl': True,

        'retries': 12,
        'fragment_retries': 12,
        'concurrent_fragments': 5,
        'http_chunk_size': 10 * 1024 * 1024,

        'user_agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    }

    print(f"[Hanime1Downloader] Downloading to: {temp_path}")
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])

    actual_temp_path = temp_path + ".mp4" if os.path.exists(temp_path + ".mp4") else temp_path

    # ====================== Step 4: 完整性校验 ======================
    verify_cmd = [FFMPEG_PATH, '-v', 'error', '-i', actual_temp_path, '-f', 'null', '-']
    verify_result = subprocess.run(verify_cmd, capture_output=True, text=True, timeout=120)

    if verify_result.returncode != 0:
        raise Exception(f"Downloaded file is corrupted: {verify_result.stderr[:500]}")

    # ====================== Step 5: 移动到缓存 ======================
    if os.path.exists(cache_path):
        try:
            os.remove(cache_path)
        except:
            pass
    shutil.move(actual_temp_path, cache_path)

    file_size = os.path.getsize(cache_path)
    print(f"[Hanime1Downloader] Success: {cache_path} ({file_size} bytes)")
    return cache_path


def extract_images_segment(video, start_timestamp, start_frame_offset,
                           end_timestamp, end_frame_offset, fps=None):
    """Extract multiple frames from a video - decord 版（按你想要的逻辑修复）"""
    try:
        video_path = video.get_stream_source()

        start_time = 0
        if hasattr(video, '_VideoFromFile__start_time'):
            start_time = video._VideoFromFile__start_time

        decord.bridge.set_bridge('torch')
        vr = VideoReader(video_path, ctx=cpu(0))

        video_frame_count = len(vr)
        original_fps = vr.get_avg_fps()

        # 时间戳转基础帧号
        start_ts_sec = parse_timestamp(start_timestamp)
        end_ts_sec = parse_timestamp(end_timestamp)

        base_start = int((start_time + start_ts_sec) * original_fps)
        base_end = int((start_time + end_ts_sec) * original_fps)

        print(f"[VideoUtils] Video info - frame_count: {video_frame_count}, original fps: {original_fps}")

        if fps is None or fps <= 0 or abs(fps - original_fps) < 0.001:  # 接近 original_fps 时
            # 直接使用原始偏移量，取全部帧
            actual_start = max(0, base_start + start_frame_offset)
            actual_end = min(video_frame_count - 1, base_end + end_frame_offset)
            if actual_end < actual_start:
                actual_start, actual_end = actual_end, actual_start
            target_frames = list(range(actual_start, actual_end))
            print(f"[VideoUtils] Using direct offset mode (fps=None or same as original)")
        else:
            # 你想要的逻辑：把 offset 视为 “目标 fps 下的偏移”，转换为实际帧
            start_frame_offset_actual = int(start_frame_offset / fps * original_fps)
            end_frame_offset_actual = int(end_frame_offset / fps * original_fps)

            actual_start = max(0, base_start + start_frame_offset_actual)
            actual_end = min(video_frame_count - 1, base_end + end_frame_offset_actual)
            if actual_end < actual_start:
                actual_start, actual_end = actual_end, actual_start

            # 关键修复：步长必须是整数 + 正确生成 target_frames
            step = original_fps / fps
            target_frames = []
            i = float(actual_start)   # 用 float 避免累积误差
            while i <= actual_end + 1e-6:   # 加一点容差
                frame_idx = int(round(i))   # round 让帧号更准确
                if 0 <= frame_idx < video_frame_count:
                    target_frames.append(frame_idx)
                i += step

            print(f"[VideoUtils] Scaled offset mode: actual offset {start_frame_offset_actual} ~ {end_frame_offset_actual}")

        print(f"[VideoUtils] Extracting from frame {actual_start} to {actual_end} "
              f"(original offset: {start_frame_offset} ~ {end_frame_offset})")
        print(f"[VideoUtils] Extracting {len(target_frames)} frames @ {fps} fps (step ≈ {original_fps/fps if fps else 1:.2f})")

        if not target_frames:
            raise Exception("No frames to extract")

        # 批量解码
        frames_tensor = vr.get_batch(target_frames)
        image_tensor = frames_tensor.float() / 255.0

        print(f"[VideoUtils] Successfully extracted {len(target_frames)} frames, shape: {image_tensor.shape}")

        return image_tensor, original_fps

    except Exception as e:
        raise Exception(f"Failed to extract image segment: {e}")
    
def disk_images_to_video(
    folder_name: str,
    file_name: str,
    fps: float = 24.0,      # ← 这里改为 float，默认 24.0
    crf: int = 18,
    audio: dict = None
) -> str:
    """
    低内存版：图像序列转视频
    """
    output_dir = os.path.join(folder_paths.output_directory, "Images", folder_name)
    if not os.path.exists(output_dir):
        print(f"[disk_images_to_video] Folder not found: {output_dir}")
        return ""

    # 扫描 PNG 文件
    png_files = []
    for f in os.listdir(output_dir):
        if f.lower().endswith(".png"):
            try:
                num = int(os.path.splitext(f)[0])
                png_files.append((num, f))
            except ValueError:
                continue

    if not png_files:
        print(f"[disk_images_to_video] No PNG files in {output_dir}")
        return ""

    png_files.sort(key=lambda x: x[0])
    total_frames = len(png_files)

    # 获取图像尺寸
    first_img_path = os.path.join(output_dir, png_files[0][1])
    with Image.open(first_img_path) as pil_img:
        if pil_img.mode not in ("RGB", "RGBA"):
            pil_img = pil_img.convert("RGB")
        width, height = pil_img.size

    if not file_name.lower().endswith(".mp4"):
        file_name += ".mp4"

    temp_video_path = os.path.join(output_dir, f"temp_{file_name}")
    final_video_path = os.path.join(output_dir, file_name)

    # 使用 float 类型的 fps
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')

    video_writer = cv2.VideoWriter(
        temp_video_path, 
        fourcc, 
        fps,                                   # ← 现在已经是 float
        (int(width), int(height))
    )

    if not video_writer.isOpened():
        print(f"[disk_images_to_video] Failed to open VideoWriter: {temp_video_path}")
        return ""

    print(f"[disk_images_to_video] Creating video: {final_video_path}")
    print(f"    Frames: {total_frames} | FPS: {fps} | Resolution: {width}x{height}")

    for idx, (_, png_name) in enumerate(png_files):
        img_path = os.path.join(output_dir, png_name)
        
        with Image.open(img_path) as pil_img:
            if pil_img.mode not in ("RGB", "RGBA"):
                pil_img = pil_img.convert("RGB")
            frame = np.array(pil_img)
            frame = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
            video_writer.write(frame)

        if (idx + 1) % 100 == 0 or (idx + 1) == total_frames:
            print(f"    Progress: {idx + 1}/{total_frames} frames")

    video_writer.release()
    print(f"[disk_images_to_video] Silent video created: {temp_video_path}")

    # ==================== 音频合并 ====================
    if audio is not None and isinstance(audio, dict) and "waveform" in audio:
        try:
            temp_audio_path = os.path.join(output_dir, f"temp_audio_{hashlib.md5(str(folder_name).encode()).hexdigest()[:8]}.wav")
            
            waveform = audio["waveform"]
            sample_rate = audio.get("sample_rate", 44100)
            
            if len(waveform.shape) == 3:
                waveform = waveform[0]

            import soundfile as sf
            sf.write(temp_audio_path, waveform.cpu().numpy().T, sample_rate)

            cmd = [
                FFMPEG_PATH, "-y",
                "-i", temp_video_path,
                "-i", temp_audio_path,
                "-c:v", "libx264",
                "-crf", str(crf),
                "-c:a", "aac",
                "-map", "0:v:0",
                "-map", "1:a:0",
                "-shortest",
                final_video_path
            ]

            print(f"[disk_images_to_video] Merging audio...")
            result = subprocess.run(cmd, capture_output=True, text=True)

            if result.returncode == 0:
                os.remove(temp_video_path)
                if os.path.exists(temp_audio_path):
                    os.remove(temp_audio_path)
                print(f"[disk_images_to_video] Final video saved: {final_video_path}")
                return final_video_path
            else:
                print(f"[disk_images_to_video] FFmpeg merge failed: {result.stderr}")
                os.rename(temp_video_path, final_video_path)
                return final_video_path

        except Exception as e:
            print(f"[disk_images_to_video] Audio merge error: {e}")
            if os.path.exists(temp_video_path):
                os.rename(temp_video_path, final_video_path)
            return final_video_path
    else:
        os.rename(temp_video_path, final_video_path)
        print(f"[disk_images_to_video] Video saved (no audio): {final_video_path}")
        return final_video_path