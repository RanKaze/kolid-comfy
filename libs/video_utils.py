import os
import re
import shutil
import subprocess
import json
from urllib.parse import urlparse
from pathlib import Path
from seleniumbase import Driver
import folder_paths
import random
import time

try:
    import yt_dlp
    YT_DLP_AVAILABLE = True
except ImportError:
    YT_DLP_AVAILABLE = False

try:
    import cv2
    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False

FFMPEG_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "plugins", "ffmpeg", "bin", "ffmpeg.exe")
FFPROBE_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "plugins", "ffmpeg", "bin", "ffprobe.exe")

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
CACHE_DIR = os.path.join(INPUT_DIR, "video_cache")
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
    if not CV2_AVAILABLE:
        return 30.0
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise Exception(f"Failed to open video: {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS)
    return fps


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


def extract_images_segment(video, start_timestamp, start_frame_offset, end_timestamp, end_frame_offset, fps=None):
    """Extract multiple frames from a video based on start and end timestamps with offsets.
    
    Args:
        video: Video object
        start_timestamp: Start timestamp string
        start_frame_offset: Offset for start frame
        end_timestamp: End timestamp string
        end_frame_offset: Offset for end frame
        fps: Target FPS for extraction. If None, extract all frames.
    """
    import cv2
    import numpy as np
    import torch
    from .timestamp import parse_timestamp
    
    try:
        video_path = video.get_stream_source()
        print(f"[VideoUtils] Video path: {video_path}")

        start_time = 0
        if hasattr(video, '_VideoFromFile__start_time'):
            start_time = video._VideoFromFile__start_time
            print(f"[VideoUtils] Video start time: {start_time}s")

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise Exception(f"Failed to open video: {video_path}")

        video_frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        original_fps = cap.get(cv2.CAP_PROP_FPS)
        print(f"[VideoUtils] Video info - frame_count: {video_frame_count}, original fps: {original_fps}")

        # Parse start timestamp
        start_timestamp_seconds = parse_timestamp(start_timestamp)
        print(f"[VideoUtils] Start timestamp: {start_timestamp_seconds}s")
        base_start_time = start_time + start_timestamp_seconds
        base_start_frame = int(base_start_time * original_fps)
        print(f"[VideoUtils] Base start frame index: {base_start_frame}")

        # Calculate actual start frame with offset
        actual_start_frame = base_start_frame + start_frame_offset
        print(f"[VideoUtils] Start frame with offset: {actual_start_frame}")

        # Parse end timestamp
        end_timestamp_seconds = parse_timestamp(end_timestamp)
        print(f"[VideoUtils] End timestamp: {end_timestamp_seconds}s")
        base_end_time = start_time + end_timestamp_seconds
        base_end_frame = int(base_end_time * original_fps)
        print(f"[VideoUtils] Base end frame index: {base_end_frame}")

        # Calculate actual end frame with offset
        actual_end_frame = base_end_frame + end_frame_offset
        print(f"[VideoUtils] End frame with offset: {actual_end_frame}")

        # Ensure frames are within bounds
        if actual_start_frame >= video_frame_count:
            print(f"[VideoUtils] Warning: Start frame {actual_start_frame} exceeds frame count {video_frame_count}")
            actual_start_frame = video_frame_count - 1
        if actual_start_frame < 0:
            print(f"[VideoUtils] Warning: Start frame {actual_start_frame} is negative, using 0")
            actual_start_frame = 0
        if actual_end_frame >= video_frame_count:
            print(f"[VideoUtils] Warning: End frame {actual_end_frame} exceeds frame count {video_frame_count}")
            actual_end_frame = video_frame_count - 1
        if actual_end_frame < 0:
            print(f"[VideoUtils] Warning: End frame {actual_end_frame} is negative, using 0")
            actual_end_frame = 0
        if actual_end_frame < actual_start_frame:
            print(f"[VideoUtils] Warning: End frame {actual_end_frame} is before start frame {actual_start_frame}, swapping")
            actual_start_frame, actual_end_frame = actual_end_frame, actual_start_frame

        # Calculate frames to extract
        if fps is None or fps <= 0:
            # Extract all frames
            total_target_frames = actual_end_frame - actual_start_frame + 1
            print(f"[VideoUtils] Extracting all frames: {total_target_frames}")
            target_frames = list(range(actual_start_frame, actual_end_frame + 1))
        else:
            # Calculate based on specified fps
            duration = (actual_end_frame - actual_start_frame) / original_fps
            print(f"[VideoUtils] Segment duration: {duration:.2f} seconds")
            target_frame_count = int(duration * fps)
            print(f"[VideoUtils] Target frames based on fps {fps}: {target_frame_count}")
            
            if target_frame_count <= 0:
                # Fall back to extracting all frames
                print(f"[VideoUtils] Target frame count is {target_frame_count}, falling back to extracting all frames")
                total_target_frames = actual_end_frame - actual_start_frame + 1
                target_frames = list(range(actual_start_frame, actual_end_frame + 1))
            else:
                # Generate frame indices to extract
                if target_frame_count == 1:
                    # Just take the middle frame
                    target_frames = [actual_start_frame + (actual_end_frame - actual_start_frame) // 2]
                else:
                    # Uniformly sample frames
                    step = (actual_end_frame - actual_start_frame) / (target_frame_count - 1)
                    target_frames = [int(actual_start_frame + i * step) for i in range(target_frame_count)]
                    # Ensure we don't exceed end frame
                    target_frames[-1] = min(target_frames[-1], actual_end_frame)

        images = []
        for target_frame in target_frames:
            cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
            ret, frame_data = cap.read()
            if not ret:
                print(f"[VideoUtils] Warning: Failed to read frame {target_frame}, skipping")
                continue

            frame_rgb = cv2.cvtColor(frame_data, cv2.COLOR_BGR2RGB)
            img_array = frame_rgb.astype(np.float32) / 255.0
            images.append(img_array)

        cap.release()

        if not images:
            raise Exception("No frames were extracted from video")

        images_array = np.stack(images, axis=0)
        image_tensor = torch.from_numpy(images_array)
        print(f"[VideoUtils] Successfully extracted {len(images)} frames, shape: {images_array.shape}")

        return image_tensor, original_fps

    except Exception as e:
        raise Exception(f"Failed to extract image segment: {e}")