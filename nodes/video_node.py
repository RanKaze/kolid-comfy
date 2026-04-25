import cv2
import numpy as np
import torch
import tempfile
import os
import shutil
import json
import hashlib
import re
import socketserver
import http.server
import threading
import time
import webbrowser
from urllib.parse import urlparse
from comfy_api.latest import ComfyExtension, io, ui, Input, InputImpl, Types
import folder_paths
from pathlib import Path
from ..libs.timestamp import parse_timestamp
from ..libs.video_utils import (
    download_pornhub, is_pornhub_url, download_youtube, is_youtube_url,
    download_hanime1, is_hanime1_url, download_video_with_ytdlp,
    remux_to_mp4, get_video_correct_ext, get_video_fps, extract_images_segment
)
from ..libs.folder_utils import scan_folder, get_video_list_from_input, get_video_dict_from_list, get_file_names_from_dict, get_file_names_list
from typing import List, Optional
import psutil
from ..libs.audio_utils import extract_audio_from_video, extract_audio_segment
from server import PromptServer
import json

FFMPEG_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "plugins", "ffmpeg", "bin", "ffmpeg.exe")
FFPROBE_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "plugins", "ffmpeg", "bin", "ffprobe.exe")
import subprocess

# Import waitSnapShot function
try:
    from .image_node import waitSnapShot
except ImportError:
    # Define local version if import fails
    def waitSnapShot(event, check_interval=0.05) -> bool:
        while not event.is_set():
            import comfy.model_management as mm
            if mm.processing_interrupted():
                return False
            event.wait(check_interval)
        return True


# Cache directory for downloaded videos (in ComfyUI input directory)
INPUT_DIR = folder_paths.get_input_directory()
CACHE_DIR = os.path.join(INPUT_DIR, "video_cache")
if not os.path.exists(CACHE_DIR):
    os.makedirs(CACHE_DIR)
    print(f"[UrlVideoLoader] Created cache directory: {CACHE_DIR}")

# Cache index file path (in video_cache directory)
CACHE_INDEX_FILE = os.path.join(CACHE_DIR, "UrlVideoNodeCache.json")


def load_cache_index():
    """Load the cache index from JSON file."""
    if os.path.exists(CACHE_INDEX_FILE):
        try:
            with open(CACHE_INDEX_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"[UrlVideoLoader] Warning: Failed to load cache index: {e}")
    return {}

def save_cache_index(cache_index):
    """Save the cache index to JSON file."""
    try:
        with open(CACHE_INDEX_FILE, 'w', encoding='utf-8') as f:
            json.dump(cache_index, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[UrlVideoLoader] Warning: Failed to save cache index: {e}")


def get_video_fps(video_path):
    """Get video real FPS, returns 30 on failure."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise Exception(f"Failed to open video: {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS)
    return fps


class VideoManagerNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"videoInfo": ("String", {"default": "", "multiline": False})},
        }

    RETURN_TYPES = ("VideoSegments",)
    RETURN_NAMES = ("video_segments",)
    FUNCTION = "execute"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def VALIDATE_INPUTS(s, input_types):
        return True

    def execute(self, videoInfo):
        return (videoInfo,)


class UrlVideoNode:
    """Download video from URL and return Video object.
    
    Supports both direct video URLs and webpage URLs (YouTube, Bilibili, etc.).
    For webpage URLs, uses yt-dlp to download the video.
    Supports video caching to avoid re-downloading.
    """

    @classmethod
    def INPUT_TYPES(cls):
        # 假设你要列出 custom_nodes/my_folder 下的所有文件
        cache_index = load_cache_index()
        cache_paths = ["URL"]
        for video_id, video_info in cache_index.items():
            cache_paths.append(video_info["title"])
            
        return {
            "required": {
                "url": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Video URL or webpage URL (YouTube, Bilibili, etc.)",
                }),
                "cache_path": (cache_paths, {"default": cache_paths[0] if cache_paths else ""}),  # COMBO 类型
            },
            "optional": {
                "clear_cache": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Clear cached video and re-download",
                }),
            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    FUNCTION = "load_video"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(s, url, cache_path="URL", clear_cache=False):
        return f"{url}_{cache_path}_{clear_cache}"

    def get_url_hash(self, url):
        """Get a hash for the URL to use as cache key."""
        return hashlib.md5(url.encode()).hexdigest()

    def get_cache_path(self, video_title, video_ext):
        """Get the cache file path for a video."""
        safe_title = re.sub(r'[<>:"/\\|?*]', '_', video_title)
        safe_title = safe_title.strip('. ')
        cache_filename = f"{safe_title}.{video_ext}"
        return os.path.join(CACHE_DIR, cache_filename)

    def is_direct_video_url(self, url):
        """Check if URL is a direct video file link."""
        parsed = urlparse(url)
        path = parsed.path.lower()
        video_extensions = ['.mp4', '.webm', '.avi', '.mov', '.mkv', '.flv', '.m4v', '.3gp']
        return any(path.endswith(ext) for ext in video_extensions)

    def download_direct_video(self, url, clear_cache=False):
        """Download a direct video URL to local cache."""
        try:
            print(f"[UrlVideoLoader] Downloading direct video URL: {url}")

            url_hash = self.get_url_hash(url)

            # Parse URL to get filename
            parsed = urlparse(url)
            path = parsed.path
            filename = os.path.basename(path)
            if not filename:
                filename = f"video_{url_hash}.mp4"

            # Get file extension
            _, ext = os.path.splitext(filename)
            if not ext:
                ext = '.mp4'
                filename = f"{filename}{ext}"

            # Create cache path
            cache_path = os.path.join(CACHE_DIR, filename)

            # Download video using requests
            print(f"[UrlVideoLoader] Downloading video to: {cache_path}")
            import requests

            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }

            response = requests.get(url, headers=headers, stream=True, timeout=300)
            response.raise_for_status()

            # Download with progress
            total_size = int(response.headers.get('content-length', 0))
            downloaded = 0

            with open(cache_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        if total_size > 0:
                            progress = (downloaded / total_size) * 100
                            if downloaded % (1024 * 1024) < 8192:
                                print(f"[UrlVideoLoader] Download progress: {progress:.1f}%")

            # Check if download was successful
            if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
                file_size = os.path.getsize(cache_path)
                print(f"[UrlVideoLoader] Video downloaded to cache: {cache_path} ({file_size} bytes)")
                return cache_path
            else:
                raise Exception(f"Failed to download video to cache: {cache_path}")

        except Exception as e:
            import traceback
            print(f"[UrlVideoLoader] Full traceback:")
            traceback.print_exc()
            raise Exception(f"Direct video download failed: {e}")

    def load_video(self, url, cache_path="URL", clear_cache=False):
        """Download video from URL and return Video object."""
        if cache_path == "URL":
            if not url or not url.strip():
                raise ValueError("URL cannot be empty")

            try:
                video_path = None
                url_hash = self.get_url_hash(url)

                # Check if video is already cached (only for yt-dlp URLs which have titles)
                if not clear_cache and not self.is_direct_video_url(url):
                    cache_index = load_cache_index()
                    if url_hash in cache_index:
                        cached_info = cache_index[url_hash]
                        video_title = cached_info.get('title', '')
                        if video_title:
                            safe_title = re.sub(r'[<>:"/\\|?*]', '_', video_title)
                            safe_title = safe_title.strip('. ')
                            cached_path = os.path.join(CACHE_DIR, f"{safe_title}.mp4")
                            if os.path.exists(cached_path) and os.path.getsize(cached_path) > 0:
                                print(f"[UrlVideoLoader] Found cached video: {cached_path}")
                                video_path = cached_path

                # Download video if not cached
                if video_path is None:
                    if self.is_direct_video_url(url):
                        video_path = self.download_direct_video(url, clear_cache)
                    elif is_pornhub_url(url):
                        video_path = download_pornhub(url, clear_cache)
                    elif is_youtube_url(url):
                        video_path = download_youtube(url, clear_cache)
                    elif is_hanime1_url(url):
                        video_path = download_hanime1(url, clear_cache)
                    else:
                        video_path = download_video_with_ytdlp(url, clear_cache)

                    print(f"[UrlVideoLoader] Video path: {video_path}")
                    real_format_name = get_video_correct_ext(video_path)
                    _, format_name = os.path.splitext(video_path)
                    
                    # 同步正确的拓展名..防止之后的逻辑出错.
                    if real_format_name != format_name:
                        print(f"[UrlVideoLoader] Video format mismatch: {real_format_name} != {format_name}")
                        new_video_path = video_path.replace(f"{format_name}", f"{real_format_name}")
                        shutil.move(video_path, new_video_path)
                        video_path = new_video_path
                    
                    # 如果它不是mp4..那么需要转化为mp4.
                    if real_format_name != ".mp4":
                    # If not proper MP4 format, try remux first, then full conversion if needed
                        remuxed_path = remux_to_mp4(video_path)
                        if remuxed_path and os.path.exists(remuxed_path):
                            video_path = remuxed_path
                        else:
                            print("[UrlVideoLoader] Remux failed, using original path")

                    cache_index = load_cache_index()
                    cache_index[url_hash] = {
                        'url': url,
                        'video_id': url_hash,
                        'title': os.path.splitext(os.path.basename(video_path))[0],
                        'cache_path': video_path
                    }
                    save_cache_index(cache_index)
                    print(f"[UrlVideoLoader] Updated cache index")
                
            except Exception as e:
                raise Exception(f"Failed to load video: {e}")
        else:
            cache_index = load_cache_index()
            for video_id, video_info in cache_index.items():
                if video_info["title"] == cache_path:
                    video_path = video_info["cache_path"]
                    break
        # Create Video object from path
        print(f"[UrlVideoLoader] Creating Video object from: {video_path}")
        video = InputImpl.VideoFromFile(video_path)

        print(f"[UrlVideoLoader] Video loaded successfully")

        video_path, fileName, subfolder = self.ensure_input(video_path)

        return io.NodeOutput(video, ui=ui.PreviewVideo([ui.SavedResult(fileName, subfolder, io.FolderType.input)]))

    def ensure_input(self, video_path):
        """Ensure video is in input directory, return (video_path, fileName, subfolder)."""
        input_dir = folder_paths.get_input_directory()
        video_filename = os.path.basename(video_path)

        if not video_path.startswith(input_dir):
            target_path = os.path.join(input_dir, video_filename)
            if not os.path.exists(target_path):
                shutil.copy2(video_path, target_path)
                print(f"[PreviewVideo] Copied video to: {target_path}")
            video_path = target_path
            subfolder = ""
        else:
            print(f"[PreviewVideo] Video already in input directory")
            video_dir = os.path.dirname(video_path)
            subfolder = os.path.relpath(video_dir, input_dir)

        fileName = os.path.basename(video_path)
        return video_path, fileName, subfolder


class GetVideoImageNode:
    """Extract a single frame from a Video object at a specified timestamp with frame offset."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("VIDEO", {
                    "tooltip": "Input video object",
                }),
                "timestamp": ("STRING", {
                    "default": "00:00:00",
                    "multiline": False,
                    "tooltip": "Timestamp in hh:mm:ss format",
                }),
                "frame_offset": ("INT", {
                    "default": 0,
                    "tooltip": "Frame offset from timestamp (can be negative)",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "get_frame"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(s, video, timestamp, frame_offset):
        video_path = video.get_stream_source() if hasattr(video, 'get_stream_source') else str(video)
        return f"{video_path}_{timestamp}_{frame_offset}"

    def get_frame(self, video, timestamp, frame_offset):
        """Extract a frame from the video at timestamp position with frame offset."""
        video_path = video.get_stream_source()
        print(f"[GetVideoImage] Video path: {video_path}")

        start_time = 0
        duration = None

        if hasattr(video, '_VideoFromFile__start_time'):
            start_time = video._VideoFromFile__start_time
            print(f"[GetVideoImage] Video start time: {start_time}s")

        if hasattr(video, 'get_duration'):
            duration = video.get_duration()
            print(f"[GetVideoImage] Video duration: {duration}s")

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise Exception(f"Failed to open video: {video_path}")

        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS)
        print(f"[GetVideoImage] Video info - frame_count: {frame_count}, fps: {fps}")

        timestamp_seconds = parse_timestamp(timestamp)
        print(f"[GetVideoImage] Requested timestamp: {timestamp_seconds}s")
        base_time = start_time + timestamp_seconds
        base_frame = int(base_time * fps)
        print(f"[GetVideoImage] Base frame index: {base_frame}")

        actual_frame = base_frame + frame_offset
        print(f"[GetVideoImage] Final frame index with offset: {actual_frame}")

        if actual_frame >= frame_count:
            print(f"[GetVideoImage] Warning: Frame index {actual_frame} exceeds frame count {frame_count}")
            actual_frame = frame_count - 1
        if actual_frame < 0:
            print(f"[GetVideoImage] Warning: Frame index {actual_frame} is negative, using 0")
            actual_frame = 0

        cap.set(cv2.CAP_PROP_POS_FRAMES, actual_frame)
        ret, frame_data = cap.read()
        cap.release()

        if not ret:
            raise Exception(f"Failed to read frame at index {actual_frame}")

        frame_rgb = cv2.cvtColor(frame_data, cv2.COLOR_BGR2RGB)

        img_array = frame_rgb.astype(np.float32) / 255.0
        img_array = np.expand_dims(img_array, axis=0)
        image_tensor = torch.from_numpy(img_array)

        print(f"[GetVideoImage] Frame loaded successfully: {frame_data.shape[1]}x{frame_data.shape[0]}")

        return (image_tensor,)


class VideoServer:
    """Temporary HTTP server to serve the video preview page and handle timestamp capture."""

    def __init__(self, video_path, fps=30, timestamp="00:00:00", frame_offset=0):
        self.video_path = video_path
        self.fps = fps                      # 新增：真实帧率
        self.initial_timestamp = timestamp  # 新增：初始时间戳
        self.initial_frame_offset = frame_offset  # 新增：初始帧偏移
        self.timestamp = "00:00:00"
        self.frame_offset = 0
        self.server = None
        self.started = False
        self.timestamp_event = threading.Event()
        self.window_closed = False
        self.browser_url = None

    def start(self):
        for port in range(8080, 9000):
            try:
                self.server = http.server.HTTPServer(('localhost', port), self.VideoHandler)
                self.started = True
                print(f"[SnapshotVideo] Server started on port {port}")
                break
            except:
                continue

        self.browser_url = f"http://localhost:{port}/video_node.html"

        if not self.started:
            print("[SnapshotVideo] Failed to start server")
            return

        self.VideoHandler.server_instance = self
        try:
            self.server.serve_forever()
        except:
            pass

    def stop(self):
        if self.server:
            print("[SnapshotVideo] Stopping server")
            self.server.shutdown()
            self.server.server_close()

    def wait_for_timestamp(self):
        if not waitSnapShot(self.timestamp_event):
            raise Exception("Canceled")

    class VideoHandler(http.server.SimpleHTTPRequestHandler):
        server_instance = None

        def do_GET(self):
            if self.path in ('/', '/video_node.html'):
                try:
                    web_dir = os.path.join(os.path.dirname(__file__), "web")
                    file_path = os.path.join(web_dir, "video_node.html")
                    with open(file_path, 'rb') as f:
                        content = f.read()
                    self.send_response(200)
                    self.send_header('Content-type', 'text/html')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(content)
                    return
                except Exception as e:
                    self.send_error(404, f"HTML file not found: {e}")
                    return

            elif self.path == '/video_data':
                data = {
                    'video_path': os.path.basename(self.server_instance.video_path),
                    'fps': self.server_instance.fps,          # 新增：传递真实 FPS
                    'initial_timestamp': self.server_instance.initial_timestamp,  # 新增：初始时间戳
                    'initial_frame_offset': self.server_instance.initial_frame_offset  # 新增：初始帧偏移
                }
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps(data).encode('utf-8'))
                return

            # ==================== 服务视频文件（支持 Range 请求） ====================
            elif self.path.startswith('/video/'):
                from urllib.parse import unquote
                requested_file = unquote(self.path[len('/video/'):])
                video_dir = os.path.dirname(self.server_instance.video_path)
                full_path = os.path.join(video_dir, requested_file)

                if not os.path.abspath(full_path).startswith(os.path.abspath(video_dir)):
                    self.send_error(403, "Access denied")
                    return

                if not os.path.exists(full_path) or not os.path.isfile(full_path):
                    self.send_error(404, f"Video file not found: {requested_file}")
                    return

                try:
                    file_size = os.path.getsize(full_path)
                    range_header = self.headers.get('Range')
                    if range_header:
                        try:
                            range_str = range_header.split('=')[1]
                            range_parts = range_str.split('-')
                            start = int(range_parts[0]) if range_parts[0] else 0
                            end = int(range_parts[1]) if range_parts[1] else file_size - 1
                            if start > end or start >= file_size:
                                self.send_error(416, "Range Not Satisfiable")
                                return
                            end = min(end, file_size - 1)
                            length = end - start + 1
                            status = 206
                            content_range = f'bytes {start}-{end}/{file_size}'
                        except:
                            start = length = file_size
                            status = 200
                            content_range = None
                    else:
                        start = length = file_size
                        status = 200
                        content_range = None

                    with open(full_path, 'rb') as f:
                        f.seek(start)
                        content = f.read(length)

                    ext = full_path.lower()
                    if ext.endswith('.mp4'):
                        content_type = 'video/mp4'
                    elif ext.endswith('.webm'):
                        content_type = 'video/webm'
                    elif ext.endswith(('.ogg', '.ogv')):
                        content_type = 'video/ogg'
                    else:
                        content_type = 'application/octet-stream'

                    self.send_response(status)
                    self.send_header('Content-type', content_type)
                    self.send_header('Content-Length', str(length))
                    self.send_header('Accept-Ranges', 'bytes')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    if content_range:
                        self.send_header('Content-Range', content_range)
                    self.end_headers()
                    self.wfile.write(content)
                    return
                except Exception as e:
                    self.send_error(500, f"Error serving video: {e}")
                    return

            else:
                # 静态文件（js/css）
                try:
                    web_dir = os.path.join(os.path.dirname(__file__), "web")
                    file_path = os.path.join(web_dir, self.path.lstrip('/'))
                    if os.path.exists(file_path) and os.path.isfile(file_path):
                        with open(file_path, 'rb') as f:
                            content = f.read()
                        if file_path.endswith('.js'):
                            content_type = 'application/javascript'
                        elif file_path.endswith('.css'):
                            content_type = 'text/css'
                        else:
                            content_type = 'application/octet-stream'
                        self.send_response(200)
                        self.send_header('Content-type', content_type)
                        self.send_header("Access-Control-Allow-Origin", "*")
                        self.end_headers()
                        self.wfile.write(content)
                    else:
                        self.send_error(404, "Static file not found")
                except Exception as e:
                    self.send_error(500, f"Server error: {e}")

        def do_POST(self):
            if self.path == '/timestamp':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    self.server_instance.timestamp = data.get('timestamp', "00:00:00")
                    self.server_instance.frame_offset = data.get('frame_offset', 0)
                    self.server_instance.timestamp_event.set()

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")
            elif self.path == '/window_closed':
                self.server_instance.window_closed = True
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
            else:
                super().do_POST()

        def log_message(self, format, *args):
            pass


class SnapshotVideoNode:
    """Preview a video in a browser and return the current timestamp and frame offset when Enter is pressed."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("VIDEO", {
                    "tooltip": "Input video object"
                }),
                "timestamp": ("STRING", {
                    "default": "00:00:00",
                    "multiline": False,
                    "tooltip": "Start timestamp in hh:mm:ss format"
                }),
                "frame_offset": ("INT", {
                    "default": 0,
                    "tooltip": "Frame offset from start timestamp"
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("timestamp", "frame_offset")
    FUNCTION = "capture_timestamp"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(s, video, timestamp, frame_offset):
        return float("nan")

    def capture_timestamp(self, video, timestamp, frame_offset, unique_id):
        video_path = video.get_stream_source()
        
        # 新增：获取真实 FPS
        fps = get_video_fps(video_path)
        print(f"[SnapshotVideo] Video FPS detected: {fps}")

        server = VideoServer(video_path, fps, timestamp, frame_offset)          # 传入 fps, timestamp, frame_offset
        server_thread = threading.Thread(target=server.start)
        server_thread.daemon = True
        server_thread.start()

        start_time = time.time()
        while not server.started:
            if time.time() - start_time > 10:
                raise RuntimeError("[SnapshotVideo] Server startup timeout")
            time.sleep(0.1)

        print(f"[SnapshotVideo] Opening browser at: {server.browser_url}")
        webbrowser.open(server.browser_url)

        print("[SnapshotVideo] Waiting for timestamp selection...")
        server.wait_for_timestamp()

        server.stop()

        if server.window_closed:
            raise ValueError("Window closed without selecting timestamp")
        
        PromptServer.instance.send_sync("kolid-comfy-widget-set", {"node_id": unique_id, "widget_name": "timestamp", "type": "STRING", "value": f"{server.timestamp}"})
        PromptServer.instance.send_sync("kolid-comfy-widget-set", {"node_id": unique_id, "widget_name": "frame_offset", "type": "INT", "value": f"{server.frame_offset}"})
        return (server.timestamp, server.frame_offset)

class GetVideoImagesNode:
    """Extract multiple frames from a Video object starting at timestamp+frame position."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("VIDEO", {
                    "tooltip": "Input video object",
                }),
                "start_timestamp": ("STRING", {
                    "default": "00:00:00",
                    "multiline": False,
                    "tooltip": "Start timestamp in hh:mm:ss format",
                }),
                "start_frame_offset": ("INT", {
                    "default": 0,
                    "tooltip": "Frame offset from start timestamp",
                }),
                "end_timestamp": ("STRING", {
                    "default": "00:01:00",
                    "multiline": False,
                    "tooltip": "End timestamp in hh:mm:ss format",
                }),
                "end_frame_offset": ("INT", {
                    "default": 0,
                    "tooltip": "Frame offset from end timestamp",
                }),
                "fps": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "max": 1000.0,
                    "step": 0.1,
                    "tooltip": "Target FPS for frame extraction. 0 means extract all frames.",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "get_frames"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(s, video, start_timestamp, start_frame_offset, end_timestamp, end_frame_offset, fps):
        video_path = video.get_stream_source() if hasattr(video, 'get_stream_source') else str(video)
        return f"{video_path}_{start_timestamp}_{start_frame_offset}_{end_timestamp}_{end_frame_offset}_{fps}"

    def get_frames(self, video, start_timestamp, start_frame_offset, end_timestamp, end_frame_offset, fps):
        """Extract multiple frames from the video."""
        try:
            # Use the utility function to extract frames
            image_tensor, fps = extract_images_segment(
                video, 
                start_timestamp=start_timestamp, 
                start_frame_offset=start_frame_offset, 
                end_timestamp=end_timestamp, 
                end_frame_offset=end_frame_offset,
                fps=fps
            )
            return (image_tensor,)
        except Exception as e:
            raise Exception(f"Failed to get frames: {e}")


class GetVideoInfoNode:
    """Get video information including fps, frame count, and duration."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("VIDEO", {
                    "tooltip": "Input video object",
                }),
            },
        }

    RETURN_TYPES = ("FLOAT", "FLOAT", "FLOAT")
    RETURN_NAMES = ("fps", "frames", "duration")
    FUNCTION = "get_info"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(s, video):
        video_path = video.get_stream_source() if hasattr(video, 'get_stream_source') else str(video)
        return video_path

    def get_info(self, video):
        """Get video info including fps, frame count, and duration."""
        video_path = video.get_stream_source()
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise Exception(f"Failed to open video: {video_path}")

        fps = cap.get(cv2.CAP_PROP_FPS)
        frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
        duration = frame_count / fps if fps > 0 else 0

        cap.release()

        if hasattr(video, '_VideoFromFile__start_time'):
            start_time = video._VideoFromFile__start_time
            duration = duration - start_time
            frame_count = int(duration * fps)

        if hasattr(video, 'get_duration'):
            video_duration = video.get_duration()
            if video_duration > 0:
                duration = video_duration
                frame_count = int(duration * fps)

        return (float(fps), float(frame_count), float(duration))


class GetVideoSegmentNode:
    """Extract video segment (frames and audio) based on timestamp and duration."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("VIDEO", {
                    "tooltip": "Input video object",
                }),
                "start_timestamp": ("STRING", {
                    "default": "00:00:00",
                    "multiline": False,
                    "tooltip": "Start timestamp in hh:mm:ss format",
                }),
                "start_frame_offset": ("INT", {
                    "default": 0,
                    "tooltip": "Frame offset from start timestamp",
                }),
                "end_timestamp": ("STRING", {
                    "default": "00:01:00",
                    "multiline": False,
                    "tooltip": "End timestamp in hh:mm:ss format",
                }),
                "end_frame_offset": ("INT", {
                    "default": 0,
                    "tooltip": "Frame offset from end timestamp",
                }),
                "fps": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "max": 1000.0,
                    "step": 0.1,
                    "tooltip": "Target FPS for frame extraction. 0 means extract all frames.",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "FLOAT")
    RETURN_NAMES = ("images", "audio", "fps")
    FUNCTION = "extract_segment"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(s, video, start_timestamp, start_frame_offset, end_timestamp, end_frame_offset, fps):
        video_path = video.get_stream_source() if hasattr(video, 'get_stream_source') else str(video)
        return f"{video_path}_{start_timestamp}_{start_frame_offset}_{end_timestamp}_{end_frame_offset}_{fps}"

    def extract_segment(self, video, start_timestamp, start_frame_offset, end_timestamp, end_frame_offset, fps):
        """Extract video segment (frames and audio)."""
        try:
            # Extract frames using the utility function
            image_tensor, original_fps = extract_images_segment(
                video, 
                start_timestamp=start_timestamp, 
                start_frame_offset=start_frame_offset, 
                end_timestamp=end_timestamp, 
                end_frame_offset=end_frame_offset,
                fps=fps
            )
            print(f"[GetVideoSegment] Successfully extracted frames")

            # Extract full audio first
            full_audio = extract_audio_from_video(video)
            print(f"[GetVideoSegment] Successfully extracted full audio")

            # Calculate duration for audio segment
            start_seconds = parse_timestamp(start_timestamp)
            end_seconds = parse_timestamp(end_timestamp)
            duration_seconds = end_seconds - start_seconds
            
            # Convert duration back to timestamp format
            hours = int(duration_seconds // 3600)
            minutes = int((duration_seconds % 3600) // 60)
            seconds = duration_seconds % 60
            duration = f"{hours:02d}:{minutes:02d}:{seconds:06.3f}"

            # Extract audio segment
            audio_segment = extract_audio_segment(
                full_audio, 
                start_timestamp, 
                start_frame_offset, 
                end_timestamp, 
                end_frame_offset, 
                original_fps
            )
            print(f"[GetVideoSegment] Successfully extracted audio segment")

            if fps is None or fps <= 0:
                return (image_tensor, audio_segment, float(original_fps))
            else:
                return (image_tensor, audio_segment, float(fps))

        except Exception as e:
            raise Exception(f"Failed to extract video segment: {e}")


class PreviewVideo:
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("VIDEO", {
                    "tooltip": "Input video object",
                })
            },
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "preview_video"
    CATEGORY = "Kolid-Toolkit"
    OUTPUT_NODE = True
    
    def preview_video(self, video):
        """Preview the video in the Comfy UI."""
        try:
            video_path = video.get_stream_source()
            print(f"[PreviewVideo] Video path: {video_path}")

            if not os.path.exists(video_path):
                raise Exception(f"Video file not found: {video_path}")

            input_dir = folder_paths.get_input_directory()
            video_filename = os.path.basename(video_path)

            if not video_path.startswith(input_dir):
                target_path = os.path.join(input_dir, video_filename)
                if not os.path.exists(target_path):
                    shutil.copy2(video_path, target_path)
                    print(f"[PreviewVideo] Copied video to: {target_path}")
                video_path = target_path
                subfolder = ""
            else:
                print(f"[PreviewVideo] Video already in input directory")
                video_dir = os.path.dirname(video_path)
                subfolder = os.path.relpath(video_dir, input_dir)

            fileName = os.path.basename(video_path)

            return io.NodeOutput(ui=ui.PreviewVideo([ui.SavedResult(fileName, subfolder, io.FolderType.input)]))

        except Exception as e:
            raise Exception(f"Failed to preview video: {e}")
        



class VideoWallpaperEngineNode:
    """Load video from Wallpaper Engine - 通过 input/WallpaperEngine 软链接加载"""

    CACHE_FILE_NAME = "video_wallpaper_engine_cache.json"
    CACHE_TIMEOUT = 30.0
    LINK_NAME = "WallpaperEngine"   # input 文件夹中的软链接名称

    @classmethod
    def get_cache_dir(cls) -> str:
        input_dir = folder_paths.get_input_directory()
        cache_dir = os.path.join(input_dir, "cache")
        os.makedirs(cache_dir, exist_ok=True)
        return cache_dir

    @classmethod
    def get_cache_file_path(cls) -> str:
        return os.path.join(cls.get_cache_dir(), cls.CACHE_FILE_NAME)

    @classmethod
    def load_cache(cls):
        cache_path = cls.get_cache_file_path()
        if not os.path.exists(cache_path):
            return [], 0.0
        try:
            with open(cache_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return data.get("titles", []), data.get("timestamp", 0.0)
        except Exception:
            return [], 0.0

    @classmethod
    def save_cache(cls, titles: List[str]):
        try:
            cache_path = cls.get_cache_file_path()
            data = {"titles": titles, "timestamp": time.time()}
            with open(cache_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    @classmethod
    def create_symlink_in_input(cls, target_path: str) -> bool:
        """在 ComfyUI/input 中创建 WallpaperEngine 软链接"""
        if not target_path or not os.path.exists(target_path):
            return False

        input_dir = folder_paths.get_input_directory()
        link_path = os.path.join(input_dir, cls.LINK_NAME)

        # 已存在且正确则跳过
        if os.path.exists(link_path) or os.path.islink(link_path):
            try:
                if os.path.realpath(link_path) == os.path.realpath(target_path):
                    print(f"[VideoWallpaperEngine] 软链接已存在且正确: input/{cls.LINK_NAME} → {target_path}")
                    return True
                else:
                    if os.path.islink(link_path):
                        os.unlink(link_path)
            except Exception:
                pass

        try:
            os.symlink(target_path, link_path, target_is_directory=True)
            print(f"[VideoWallpaperEngine] ✓ 成功创建软链接: input/{cls.LINK_NAME} → {target_path}")
            print(f"   以后所有视频路径都将通过 input/WallpaperEngine 访问")
            return True
        except FileExistsError:
            print(f"[VideoWallpaperEngine] 软链接已存在: input/{cls.LINK_NAME}")
            return True
        except PermissionError:
            print(f"[VideoWallpaperEngine] × 创建软链接失败：权限不足")
            print("   请以**管理员身份**运行 ComfyUI，或开启 Windows 开发者模式")
            return False
        except Exception as e:
            print(f"[VideoWallpaperEngine] × 创建软链接失败: {e}")
            return False

    @classmethod
    def get_workshop_path_from_running_process(cls) -> Optional[str]:
        """从进程获取真实 workshop 路径，并创建软链接"""
        print("[VideoWallpaperEngine] 尝试从运行中的 Wallpaper Engine 获取路径...")

        for proc in psutil.process_iter(['name', 'exe']):
            try:
                proc_name = (proc.info.get('name') or '').lower()
                if not any(k in proc_name for k in ["wallpaper32", "wallpaper64", "wallpaper_engine"]):
                    continue

                exe_path = proc.info.get('exe')
                if not exe_path or not os.path.exists(exe_path):
                    continue

                print(f"[VideoWallpaperEngine] 找到进程: {exe_path}")

                wallpaper_dir = os.path.dirname(exe_path)
                common_dir = os.path.dirname(wallpaper_dir)
                steamapps_dir = os.path.dirname(common_dir)

                workshop_path = os.path.join(steamapps_dir, "workshop", "content", "431960")

                if os.path.exists(workshop_path):
                    print(f"[VideoWallpaperEngine] ✓ 获取到真实 workshop 路径: {workshop_path}")
                    # 创建软链接（后续所有操作都走软链接）
                    cls.create_symlink_in_input(workshop_path)
                    return workshop_path
            except Exception:
                continue

        print("[VideoWallpaperEngine] × 未找到正在运行的 Wallpaper Engine 进程")
        return None

    @classmethod
    def get_link_path(cls) -> str:
        """获取软链接的完整路径"""
        input_dir = folder_paths.get_input_directory()
        return os.path.join(input_dir, cls.LINK_NAME)

    @classmethod
    def INPUT_TYPES(cls):
        video_titles = cls.scan_wallpaper_engine_videos()
        if not video_titles:
            video_titles = ["No video wallpapers found"]

        return {
            "required": {
                "video_title": (video_titles, {
                    "tooltip": "Select a video from Wallpaper Engine (via input/WallpaperEngine)",
                }),
            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    FUNCTION = "load_video"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def scan_wallpaper_engine_videos(cls) -> List[str]:
        cache_titles, cache_time = cls.load_cache()
        current_time = time.time()

        if cache_titles and (current_time - cache_time < cls.CACHE_TIMEOUT):
            print(f"[VideoWallpaperEngine] 使用缓存: {len(cache_titles)} 个视频")
            return cache_titles[:]

        video_titles: List[str] = []
        link_path = cls.get_link_path()

        if not os.path.exists(link_path) or not os.path.isdir(link_path):
            print(f"[VideoWallpaperEngine] × 软链接 input/WallpaperEngine 不存在或无效")
            print("   请确保 Wallpaper Engine 正在后台运行，然后刷新节点")
            cls.save_cache(video_titles)
            return video_titles

        print(f"[VideoWallpaperEngine] 通过软链接扫描: {link_path}")
        video_count = 0

        try:
            for item_id in os.listdir(link_path):
                item_path = os.path.join(link_path, item_id)
                if not os.path.isdir(item_path):
                    continue

                project_json_path = os.path.join(item_path, "project.json")
                if not os.path.exists(project_json_path):
                    continue

                try:
                    with open(project_json_path, 'r', encoding='utf-8') as f:
                        project_data = json.load(f)

                    file_path = project_data.get('file', '')
                    title = project_data.get('title', '').strip()

                    if title and file_path.lower().endswith(('.mp4', '.webm')) and title not in video_titles:
                        video_titles.append(title)
                        video_count += 1
                except Exception:
                    continue

            video_titles.sort()
            print(f"[VideoWallpaperEngine] 扫描完成，发现 {video_count} 个视频壁纸")
            cls.save_cache(video_titles)
        except Exception as e:
            print(f"[VideoWallpaperEngine] 扫描出错: {e}")

        return video_titles

    @classmethod
    def IS_CHANGED(cls, video_title):
        return video_title

    def load_video(self, video_title: str):
        if video_title == "No video wallpapers found":
            raise Exception("没有找到视频壁纸。请确保 Wallpaper Engine 正在后台运行并已创建软链接。")

        link_path = self.get_link_path()
        if not os.path.exists(link_path):
            raise Exception(f"软链接 input/{self.LINK_NAME} 不存在。请确保 Wallpaper Engine 正在运行，然后刷新节点。")

        video_path = None
        try:
            for item_id in os.listdir(link_path):
                item_path = os.path.join(link_path, item_id)
                if not os.path.isdir(item_path):
                    continue

                project_json_path = os.path.join(item_path, "project.json")
                if not os.path.exists(project_json_path):
                    continue

                try:
                    with open(project_json_path, 'r', encoding='utf-8') as f:
                        project_data = json.load(f)

                    if project_data.get('title', '').strip() == video_title:
                        file_rel = project_data.get('file', '')
                        if file_rel.lower().endswith(('.mp4', '.webm')):
                            # ★★★ 关键修改：完全通过软链接构建 video_path ★★★
                            candidate_path = os.path.normpath(os.path.join(link_path, item_id, file_rel))
                            if os.path.exists(candidate_path):
                                video_path = candidate_path
                                break
                except Exception:
                    continue

            if video_path is None:
                raise Exception(f"未找到视频文件: {video_title}")

            print(f"[VideoWallpaperEngine] 通过软链接加载: {video_path}")
            video = InputImpl.VideoFromFile(video_path)
            print(f"[VideoWallpaperEngine] 视频加载成功")
            
            try:
                video_path = video.get_stream_source()
                print(f"[PreviewVideo] Video path: {video_path}")

                if not os.path.exists(video_path):
                    raise Exception(f"Video file not found: {video_path}")

                input_dir = folder_paths.get_input_directory()
                video_filename = os.path.basename(video_path)

                if not video_path.startswith(input_dir):
                    target_path = os.path.join(input_dir, video_filename)
                    if not os.path.exists(target_path):
                        shutil.copy2(video_path, target_path)
                        print(f"[PreviewVideo] Copied video to: {target_path}")
                    video_path = target_path
                    subfolder = ""
                else:
                    print(f"[PreviewVideo] Video already in input directory")
                    video_dir = os.path.dirname(video_path)
                    subfolder = os.path.relpath(video_dir, input_dir)

                fileName = os.path.basename(video_path)

                return io.NodeOutput(video, ui=ui.PreviewVideo([ui.SavedResult(fileName, subfolder, io.FolderType.input)]))

            except Exception as e:
                raise Exception(f"Failed to preview video: {e}")

        except Exception as e:
            raise Exception(f"加载视频失败 '{video_title}': {e}")

class VideoFolderLoaderNode:
    """
    遍历 input/videos 文件夹（支持软链接），生成 mp4 文件 combo，
    输出完整视频路径（可直接接 VHS_LoadVideoPath）
    """
    
    @classmethod
    def INPUT_TYPES(cls):
        video_list = get_video_list_from_input("videos")
        video_list = get_file_names_list(video_list)
        
        default_video = video_list[0] if video_list else "No mp4 files found"
        
        return {
            "required": {
                "file_name": (video_list, {"default": default_video}),
            }
        }
    
    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    
    FUNCTION = "load_video"
    CATEGORY = "Kolid-Toolkit"
    
    def __init__(self):
        # 推荐在这里缓存一次，避免每次执行都重新扫描
        self.video_list = get_video_list_from_input("videos") or ["No mp4 files found"]
        self.video_dict = get_video_dict_from_list(self.video_list)
    
    def load_video(self, file_name):
        if file_name not in self.video_dict or file_name == "No mp4 files found":
            raise FileNotFoundError(f"视频文件不存在: {file_name}")
        
        """返回完整路径（支持软链接）"""
        video_path = self.video_dict[file_name]

        video = InputImpl.VideoFromFile(video_path)

        input_dir = folder_paths.get_input_directory()
        video_dir = os.path.dirname(video_path)
        subfolder = os.path.relpath(video_dir, input_dir) if video_dir.startswith(input_dir) else ""
        
        return io.NodeOutput(video, ui=ui.PreviewVideo([ui.SavedResult(file_name, subfolder, io.FolderType.input)]))


class VideoGetFileInfoNode:
    """Get video file info (name without extension and full path) from Video object."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("VIDEO", {
                    "tooltip": "Input video object",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("file_name", "path")
    FUNCTION = "get_file_info"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(s, video):
        video_path = video.get_stream_source() if hasattr(video, 'get_stream_source') else str(video)
        return video_path

    def get_file_info(self, video):
        """Get video file name without extension and full path."""
        video_path = video.get_stream_source()
        file_name = os.path.splitext(os.path.basename(video_path))[0]
        print(f"[VideoGetFileInfo] File name: {file_name}, Path: {video_path}")
        return (file_name, video_path)
        