# SPDX-License-Identifier: GPL-3.0-or-later

import os
import webbrowser
from ...libs.client_host import open_ui
import threading
import http.server
import socketserver
import json
import base64
import numpy as np
from urllib.parse import urlparse, parse_qs, quote
import urllib
import torch
import time
import subprocess
import sys
import socket
import threading
import requests

from ...libs.data_paths import web_file
import queue
import io
from PIL import Image
import cv2
import comfy.model_management as mm
import signal
import shutil
import hashlib
import torch.nn.functional as F
from comfy_api.latest import Types

# Try to import win32gui for Windows window focus management
try:
    import win32gui
    import win32con
    has_win32gui = True

    def focus_window(hwnd):
        if not hwnd or not win32gui.IsWindow(hwnd):
            print("无效窗口句柄")
            return False

        # 如果窗口最小化，先恢复
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)

        # 技巧1：如果是控制台程序，先激活自己的控制台窗口（绕过前台限制）
        if sys.stdin.isatty():  # 判断是否在控制台运行
            try:
                own_console = win32console.GetConsoleWindow()
                if own_console:
                    win32gui.SetForegroundWindow(own_console)
            except:
                pass  # 忽略错误（如 GUI 环境无控制台）

        # 技巧2：使用 SetForegroundWindow（仅当当前进程有权限时有效）
        try:
            win32gui.SetForegroundWindow(hwnd)
            return True
        except Exception as e:
            print(f"SetForegroundWindow 失败: {e}")

        # 备用方案：强制置顶再取消（视觉上“聚焦”）
        win32gui.SetWindowPos(
            hwnd,
            win32con.HWND_TOPMOST,
            0, 0, 0, 0,
            win32con.SWP_NOMOVE | win32con.SWP_NOSIZE
        )
        win32gui.SetWindowPos(
            hwnd,
            win32con.HWND_NOTOPMOST,
            0, 0, 0, 0,
            win32con.SWP_NOMOVE | win32con.SWP_NOSIZE
        )
        return True
    
except ImportError:
    has_win32gui = False
    print("[SnapshotGaussian] win32gui not available, cannot restore window focus")
    

    
def waitSnapShot(event, check_interval = 0.05) -> bool:
    while not event.is_set():
        if mm.processing_interrupted():
            return False
        event.wait(check_interval)
    return True

def waitPort(port, host='localhost', timeout=30, interval=0.05):
    """等待指定端口在本地主机上可用
    
    Args:
        port: 要等待的端口号
        host: 主机名，默认为 localhost
        timeout: 超时时间（秒），默认为 30 秒
        interval: 检查间隔（秒），默认为 0.5 秒
    
    Raises:
        TimeoutError: 如果在超时时间内端口不可用
    """
    import socket
    import time
    
    start_time = time.time()
    print(f"[SnapshotGaussian] 等待端口 {port} 在 {host} 上可用...")
    
    while time.time() - start_time < timeout:
        try:
            # 尝试连接到端口
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(1)
            result = sock.connect_ex((host, port))
            sock.close()
            
            if result == 0:
                # 端口可用
                print(f"[SnapshotGaussian] 端口 {port} 已可用")
                return
        except Exception as e:
            # 发生异常，继续等待
            pass
        
        # 检查是否超时
        if time.time() - start_time > timeout:
            break
        
        # 等待下一次检查
        time.sleep(interval)
    
    # 超时
    raise TimeoutError(f"[SnapshotGaussian] 等待端口 {port} 超时（{timeout} 秒）")

class _SnapshotServer(socketserver.ThreadingTCPServer):
    """Handle each browser connection in its own (daemon) thread.

    The plain TCPServer runs one request inline, so a connection the webview opens
    but never writes to - or one that stops reading the ~50 MB body - wedges
    serve_forever, and BaseServer.shutdown() then waits for it: a cancel sat for
    41 s in server.stop() before raising. daemon threads keep _Threads empty, so
    neither shutdown() nor server_close() waits for those connections.
    """
    daemon_threads = True


def checkPort(port, host='localhost'):
    """检查指定端口是否在本地主机上可用
    
    Args:
        port: 要检查的端口号
        host: 主机名，默认为 localhost
    
    Returns:
        bool: 如果端口可用则返回 True，否则返回 False
    """
    import socket
    try:
        # 尝试连接到端口
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(1)
        result = sock.connect_ex((host, port))
        sock.close()
        
        return result == 0
    except Exception:
        return False

def handleSnapShot(severHandler, set_event):
    # Handle screenshot data
    content_length = int(severHandler.headers['Content-Length'])
    post_data = severHandler.rfile.read(content_length)
    data = json.loads(post_data)
    
    if severHandler.server_instance:
        # 获取图片数据
        rawImage_base64 = data.get('image')
        # 从base64字符串中提取图片数据
        base64_data = rawImage_base64.split(',')[1]
        image_data = base64.b64decode(base64_data)
        
        # 直接解码为numpy，跳过PIL
        nparr = np.frombuffer(image_data, np.uint8)
        img_bgr = cv2.imdecode(nparr, cv2.IMREAD_COLOR)          # 直接得到HWC/BGR/uint8
        img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)        # 转RGB
        img_array = img_rgb.astype(np.float32) / 255.0             # 归一化
        img_array = np.expand_dims(img_array, axis=0)              # 加batch维

        # 转Tensor
        try:
            import torch
            severHandler.server_instance.image = torch.from_numpy(img_array)
        except ImportError:
            severHandler.server_instance.image = img_array
        
        severHandler.send_response(200)
        severHandler.send_header('Content-type', 'application/json')
        severHandler.send_header("Access-Control-Allow-Origin", "*")
        severHandler.end_headers()
        severHandler.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))

        # Signal that screenshot is ready
        if set_event: severHandler.server_instance.screenshot_event.set()
    else:
        severHandler.send_error(500, "Server error")

def handleExtrinsics(severHandler, set_event):
    # Handle extrinsics data
    print("[SnapshotGaussian] Received POST request: /extrinsics")
    content_length = int(severHandler.headers['Content-Length'])
    post_data = severHandler.rfile.read(content_length)
    data = json.loads(post_data)

    if severHandler.server_instance:
        # 获取相机外参
        extrinsics = data.get('extrinsics')
        # 处理base64编码的extrinsics数据
        if isinstance(extrinsics, str):
            try:
                # 解码base64
                decoded_data = base64.b64decode(extrinsics)
                # 解析JSON
                extrinsics = json.loads(decoded_data)
            except Exception as e:
                print(f"[SnapshotGaussian] Error decoding extrinsics: {e}")
        # 转换为numpy数组
        severHandler.server_instance.out_extrinsics = np.array(extrinsics).reshape(4, 4)
        
        severHandler.send_response(200)
        severHandler.send_header('Content-type', 'application/json')
        severHandler.send_header("Access-Control-Allow-Origin", "*")
        severHandler.end_headers()
        severHandler.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
        
        if set_event: severHandler.server_instance.screenshot_event.set()
    else:
        severHandler.send_error(500, "Server error")

def handleWindowClosed(severHandler):
    # Page fires this on unload (sendBeacon, no readable response). Only act when
    # no snapshot exists yet: unblock the wait so the node reports the close
    # instead of hanging. If a snapshot was already posted, ignore it.
    instance = severHandler.server_instance
    if instance and instance.image is None:
        instance.window_closed = True
        instance.screenshot_event.set()
    severHandler.send_response(200)
    severHandler.send_header('Content-type', 'application/json')
    severHandler.send_header("Access-Control-Allow-Origin", "*")
    severHandler.end_headers()
    severHandler.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))

# SH band-0 constant, same value comfy_extras/nodes_gaussian_splat.py uses to read sh[..., 0, :] back.
_SH_C0 = 0.28209479177387814
_SPLAT_RECORD = np.dtype([("xyz", "<f4", 3), ("scale", "<f4", 3),
                          ("rgba", "u1", 4), ("quat", "u1", 4)])
_SPLAT_MAX_SPLATS = 16_000_000  # ~500MB of records, the cap getContents used to put on the file it read


def _splat_record_view(splat, item):
    """Batch item `item` of a ComfyUI SPLAT as one (N,) array of 32-byte .splat records.

    SPLAT stores render-ready values (linear scale, opacity in [0,1], sh DC as (rgb-0.5)/C0), which is
    exactly the .splat record layout, so this is a quantization pass and not a re-activation.
    """
    end = int(splat.counts[item].item()) if splat.counts is not None else splat.positions.shape[1]
    if end <= 0:
        return np.empty(0, _SPLAT_RECORD)
    cut = lambda t: t[item, :end].cpu().float().numpy()

    xyz = cut(splat.positions)
    scale = cut(splat.scales)
    quat = cut(splat.rotations)
    quat = quat / np.linalg.norm(quat, axis=1, keepdims=True).clip(1e-12)
    rgba = np.concatenate(
        [np.clip(cut(splat.sh)[:, 0, :] * _SH_C0 + 0.5, 0.0, 1.0),
         cut(splat.opacities).clip(0.0, 1.0)],
        axis=1)

    rec = np.empty(end, _SPLAT_RECORD)
    rec["xyz"] = xyz
    rec["scale"] = scale
    rec["rgba"] = np.round(rgba * 255.0).astype(np.uint8)
    rec["quat"] = np.round(quat * 128.0 + 128.0).clip(0, 255).astype(np.uint8)
    return rec


def getContents(splat) -> str:
    if splat is None:
        raise ValueError("No splat received from upstream node")

    batch = splat.positions.shape[0]
    total = sum(int(splat.counts[i].item()) if splat.counts is not None else splat.positions.shape[1]
                for i in range(batch))
    if total == 0:
        raise ValueError("Splat is empty")
    if total > _SPLAT_MAX_SPLATS:
        raise ValueError(f"Splat is too large ({total:,} splats). Maximum is {_SPLAT_MAX_SPLATS:,}")

    # Every batch item goes into the one scene the viewer renders.
    records = [rec for rec in (_splat_record_view(splat, i) for i in range(batch)) if rec.size]
    print(f"[SnapshotGaussian] Serialized {total:,} splats from {len(records)} batch item(s) to .splat")
    return base64.b64encode(b"".join(rec.tobytes() for rec in records)).decode("utf-8")
    
    

class GSplatServer:
    """Temporary HTTP server to serve the snapshot page and handle screenshot capture."""

    def __init__(self, contents, extrinsics, intrinsics, width, height):
        self.contents = contents
        self.extrinsics = extrinsics
        self.intrinsics = intrinsics
        self.width = width
        self.height = height
        self.image = None
        self.server = None
        self.started = False
        self.screenshot_event = threading.Event()
        self.window_closed = False
        self.bowser_url = None
        self.out_extrinsics = None

    def start(self):
        # Find an available port
        for port in range(8080, 9000):
            try:
                self.server = _SnapshotServer(('localhost', port), self.GSplatHandler)
                self.started = True
                print(f"[SnapshotGaussian] Server started on port {port}")
                break
            except:
                continue
            
        self.bowser_url = f"http://localhost:{port}/gaussian_node.html"
        

        if not self.started:
            print("[SnapshotGaussian] Failed to start server")
            return

        # Store reference to self in the handler class
        self.GSplatHandler.server_instance = self

        # Serve forever
        try:
            self.server.serve_forever()
        except:
            pass

    def stop(self):
        if self.server:
            print("[SnapshotGaussian] Stopping server")
            self.server.shutdown()
            self.server.server_close()

    def wait_for_screenshot(self):
        """Wait for screenshot indefinitely."""
        if( not waitSnapShot(self.screenshot_event)):
            raise Exception("Canceled")

    class GSplatHandler(http.server.SimpleHTTPRequestHandler):
        server_instance = None

        def do_GET(self):
            print(f"[SnapshotGaussian] Received GET request: {self.path}")
            # The per-run token rides on the document URL and is not part of the route.
            path = self.path.split('?', 1)[0]
            if path == '/gaussian_node.html':
                # Serve the gaussian_node.html file
                file_path = web_file('gaussian_node.html')
                if os.path.exists(file_path):
                    self.send_response(200)
                    self.send_header('Content-type', 'text/html')
                    self.end_headers()
                    with open(file_path, 'rb') as f:
                        self.wfile.write(f.read())
                else:
                    self.send_error(404, "File not found")
            elif path.startswith('/js/'):
                # Serve JavaScript files
                file_path = web_file(path[1:])
                if os.path.exists(file_path):
                    self.send_response(200)
                    self.send_header('Content-type', 'application/javascript')
                    self.end_headers()
                    with open(file_path, 'rb') as f:
                        self.wfile.write(f.read())
                else:
                    self.send_error(404, "File not found")
            elif path == '/contents':
                # Serve splat records as JSON
                if self.server_instance:
                    try:
                        extrinsics = self.server_instance.extrinsics
                        intrinsics = self.server_instance.intrinsics
                        response = {
                            'contents': self.server_instance.contents,
                            'extrinsics': extrinsics.tolist() if hasattr(extrinsics, 'tolist') else extrinsics,
                            'intrinsics': intrinsics.tolist() if hasattr(intrinsics, 'tolist') else intrinsics,
                            'width': self.server_instance.width,
                            'height': self.server_instance.height
                        }
                        # Set appropriate content length
                        response_data = json.dumps(response).encode('utf-8')
                        self.send_response(200)
                        self.send_header('Content-type', 'application/json')
                        self.send_header('Content-Length', str(len(response_data)))
                        self.end_headers()
                        self.wfile.write(response_data)
                    except Exception as e:
                        self.send_error(500, f"Error processing splat data: {e}")
                        return
                else:
                    self.send_error(500, "Server error")
            else:
                super().do_GET()

        def do_POST(self):
            print(f"[SnapshotGaussian] Received POST request: {self.path}")
            if self.path == '/screenshot':
                handleSnapShot(self, True)
            elif self.path == '/window_closed':
                handleWindowClosed(self)
            else:
                super().do_POST()

        def log_message(self, format, *args):
            # Suppress server logs
            pass

class SuperSplatServer:
    """Temporary HTTP server to serve the snapshot page and handle screenshot capture."""

    def __init__(self, filename, contents, extrinsics, intrinsics, width, height):
        self.filename = filename
        self.contents = contents
        self.extrinsics = extrinsics
        self.intrinsics = intrinsics
        self.width = width
        self.height = height
        self.image = None
        self.server = None
        self.started = False
        self.screenshot_event = threading.Event()
        self.window_closed = False
        self.bowser_url = None
        self.serve_subprocess = None
        self.out_extrinsics = None

    def start(self):
        success = False
        # Find an available port
        for port in range(8080, 9000):
            try:
                self.server = _SnapshotServer(('localhost', port), self.SuperSplatHandler)
                print(f"[SnapshotGaussian] Server started on port {port}")
                success = True
                break
            except:
                continue
            
        if (not success):
            raise Exception("[SnapshotGaussian] Failed to start server")
            
        tempUrl = quote(f"http://localhost:{port}", safe='')
        
        # 如果服务器开着就不用另外开了..
        if not checkPort(3000, "localhost"):
            self.run_process()
            waitPort(3000, "localhost")
        
        # 準備 URL 參數
        params = {
            "snapshot": "true",
            "width": str(int(self.width)),
            "height": str(int(self.height)),
            "extrinsics": json.dumps(self.extrinsics.tolist() if self.extrinsics is not None and hasattr(self.extrinsics, 'tolist') else (self.extrinsics if self.extrinsics is not None else None)),
            "intrinsics": json.dumps(self.intrinsics.tolist() if self.intrinsics is not None and hasattr(self.intrinsics, 'tolist') else (self.intrinsics if self.intrinsics is not None else None)),
            "server": tempUrl,
        }
        
        # 組成完整 URL
        query_string = urllib.parse.urlencode(params)
        self.bowser_url = f"http://localhost:3000/?{query_string}"
        print(f"[SnapshotGaussian] Browser URL: {self.bowser_url}")

        # Store reference to self in the handler class
        self.SuperSplatHandler.server_instance = self

        # Serve forever
        try:
            self.started = True
            self.server.serve_forever()
        except:
            pass
        
    def run_process(self):
        # 假设 SuperSplat 项目根目录与当前脚本同级，可根据实际路径调整
        supersplat_root = web_file("supersplat")
        if not os.path.isdir(supersplat_root):
            raise RuntimeError("SuperSplat 项目目录未找到，请确保位于节点同级目录下的 SuperSplat 文件夹中")
        
        npx_path = shutil.which("npx")
        # 构建命令
        cmd = ["npx", "serve", "dist", "-C"]
        # 跨平台设置：创建新进程组
        if sys.platform == "win32":
            # Windows: CREATE_NEW_PROCESS_GROUP 允许我们稍后发送 CTRL_BREAK_EVENT
            self.serve_subprocess = subprocess.Popen(
                cmd,
                cwd=supersplat_root,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                shell=True,
                text=True  
            )
        else:
            # Unix-like: 使用 os.setsid 创建新会话（即新进程组）
            self.serve_subprocess = subprocess.Popen(
                cmd,
                preexec_fn=os.setsid,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                shell=True,
                text=True
            )

    def terminate_process(self):
        return
        if self.serve_subprocess is None:
            return
        proc = self.serve_subprocess
        if proc is None or proc.poll() is not None:
            self.serve_subprocess = None
            return

        try:
            if sys.platform == "win32":
                # 必须确保启动时用了 CREATE_NEW_PROCESS_GROUP
                proc.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                # 先尝试 SIGTERM 到整个进程组
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                except (ProcessLookupError, OSError):
                    # 进程组已不存在，继续 wait 即可
                    pass

            # 等待优雅退出
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            # 强制 kill
            if proc.poll() is None:
                if sys.platform == "win32":
                    proc.kill()
                else:
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                    except (ProcessLookupError, OSError):
                        pass
                proc.wait()  # 确保回收资源

        except (ProcessLookupError, OSError):
            # 极端情况：进程已消失，但仍需 wait 防止僵尸
            try:
                proc.wait()
            except (ProcessLookupError, OSError):
                pass

        finally:
            self.serve_subprocess = None

    def stop(self):
        """停止服务器和相关进程"""
        # 先停止服务器
        if self.server:
            print("[SnapshotGaussian] Stopping server")
            try:
                self.server.shutdown()
                self.server.server_close()
            except Exception as e:
                print(f"[SnapshotGaussian] Error stopping server: {e}")
        self.terminate_process()

    def __del__(self):
        """析构函数，确保在对象被销毁时停止 subprocess"""
        # 确保在对象被销毁时也能清理 subprocess
        if hasattr(self, 'serve_subprocess') and self.serve_subprocess:
            self.terminate_process()

    def wait_for_screenshot(self):
        """Wait for screenshot indefinitely."""
        if not waitSnapShot(self.screenshot_event):
            self.terminate_process()
            raise Exception("Canceled")

    class SuperSplatHandler(http.server.SimpleHTTPRequestHandler):
        server_instance = None

        def do_GET(self):
            print(f"[SnapshotGaussian] Received GET request: {self.path}")
            if self.path == '/api/latest-upload':
                self.send_response(200)
                self.send_header("Content-type", "application/json; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()

                response = {"filename": self.server_instance.filename, "contents": self.server_instance.contents}
                self.wfile.write(json.dumps(response).encode("utf-8"))
            elif self.path == '/api/latest-upload/consumed':
                self.send_response(200)
                self.send_header("Content-type", "application/json; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
            else:
                self.send_error(404)
                self.send_header("Access-Control-Allow-Origin", "*")

        def do_POST(self):
            print(f"[SnapshotGaussian] Received POST request: {self.path}")
            if self.path == '/screenshot':
                handleSnapShot(self, False)
            elif self.path == '/extrinsics':
                handleExtrinsics(self, True)
            elif self.path == '/window_closed':
                handleWindowClosed(self)
            else:
                super().do_POST()

        def do_OPTIONS(self):
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def log_message(self, format, *args):
            # Suppress server logs
            pass

class SnapshotGaussianNode:
    """Preview a Gaussian splat in a browser and take a snapshot when Enter is pressed."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "splat": ("SPLAT", {
                    "forceInput": True,
                    "tooltip": "Gaussian splat from upstream node (Image To Gaussian Splat, Get Splat, ...)",
                }),
                "method": ("COMBO", {
                    "default": "GSplat",
                    "options": ["GSplat", "SuperSplat"],
                    "tooltip": "Type of Gaussian splat renderer",
                }),
                "width": ("INT", {
                    "default": 512,
                    "min": 64,
                    "max": 2048,
                    "step": 1,
                    "tooltip": "Width of the screenshot",
                }),
                "height": ("INT", {
                    "default": 512,
                    "min": 64,
                    "max": 2048,
                    "step": 1,
                    "tooltip": "Height of the screenshot",
                }),
            },
            "optional": {
                "extrinsics": ("EXTRINSICS", {
                    "tooltip": "Extrinsics from upstream node",
                }),
                "intrinsics": ("INTRINSICS", {
                    "tooltip": "Intrinsics from upstream node",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "EXTRINSICS")
    RETURN_NAMES = ("snapshot", "extrinsics")
    FUNCTION = "take_snapshot"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(s, **kwargs):
        return float("nan")

    def take_snapshot(
        self,
        splat,
        extrinsics=None,
        intrinsics=None,
        method: str = "GSplat",
        width: int = 512,
        height: int = 512,
    ):
        contents = getContents(splat)
        focused_window = None
        if has_win32gui:
            focused_window = win32gui.GetForegroundWindow()

        # Start a temporary HTTP server to serve the snapshot page
        if method == "GSplat":
            server = GSplatServer(contents, extrinsics, intrinsics, width, height)
        elif method == "SuperSplat":
            server = SuperSplatServer("gaussian.splat", contents, extrinsics, intrinsics, width, height)
        else:
            raise ValueError(f"Unknown method: {method}")
        server_thread = threading.Thread(target=server.start)
        server_thread.daemon = True
        server_thread.start()

        start_time = time.time()
        timeout = 10  # 10 seconds timeout
        while not server.started:
            if time.time() - start_time > timeout:
                raise RuntimeError(f"[SnapshotGaussian] Server startup timeout after {timeout} seconds")
            time.sleep(0.1)

        # KolidUI (and Chrome/Edge) bring an already-open tab with an identical URL to
        # the foreground instead of reloading it, so a page left behind by a cancelled
        # run would be re-shown with its server long gone and nothing to load. A
        # per-run token makes every snapshot a fresh document.
        url = server.bowser_url + ('&' if '?' in server.bowser_url else '?') + \
            "run=%d" % (time.time() * 1000)
        print(f"[SnapshotGaussian] Opening browser at: {url}")
        open_ui(url)

        # Wait for screenshot to be captured (indefinitely, but web page will notify on close)
        print("[SnapshotGaussian] Waiting for snapshot...")
        try:
            server.wait_for_screenshot()
        finally:
            # Cancel/exception paths used to leave the bound port and its thread alive,
            # so every later run drifted up to a new port.
            server.stop()

        # Restore window focus with enhanced reliability
        if has_win32gui and focused_window:
            time.sleep(0.5)
            focus_window(focused_window)

        if server.window_closed or server.image is None:
            raise ValueError("Window closed without taking screenshot")
        
        return (server.image, server.out_extrinsics if server.out_extrinsics is not None else None)


# SHARP's encoder is the slow part; the decoder only depends on the focal length. Single-entry cache,
# same as the SHARP pack's own predict node, so re-running with a new focal_length_mm skips the encoder.
_sharp_encode_cache = {"image_hash": None, "monodepth_output": None, "image_resized": None}


def focal_length_px(width: int, height: int, f_mm: float) -> float:
    """35mm-film focal length (mm) -> pixels, over the image diagonal (36x24mm frame)."""
    return f_mm * np.sqrt(width**2 + height**2) / np.sqrt(36**2 + 24**2)


class ImageToGaussianSplatNode:
    """Lift image(s) into a Gaussian splat with SHARP and return it as a ComfyUI SPLAT (nothing on disk)."""

    INTERNAL_SHAPE = (1536, 1536)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("SHARP_MODEL", {
                    "tooltip": "SHARP model from Load SHARP Model",
                }),
                "image": ("IMAGE", {
                    "tooltip": "Source image(s). The batch dim becomes the splat batch.",
                }),
            },
            "optional": {
                "focal_length_mm": ("FLOAT", {
                    "default": 30.0,
                    "min": 0.0,
                    "max": 500.0,
                    "step": 0.1,
                    "tooltip": "Focal length in mm (35mm equivalent). 0 = auto (defaults to 30mm). "
                               "Same image + new focal length only re-runs the cheap decode step.",
                }),
            },
        }

    RETURN_TYPES = ("SPLAT", "EXTRINSICS", "INTRINSICS")
    RETURN_NAMES = ("splat", "extrinsics", "intrinsics")
    FUNCTION = "predict"
    CATEGORY = "Kolid-Toolkit"

    @torch.no_grad()
    def predict(self, model: dict, image: torch.Tensor, focal_length_mm: float = 30.0):
        from sharp.utils.gaussians import convert_rgb_to_spherical_harmonics
        from sharp.utils.color_space import linearRGB2sRGB

        if image.dim() == 3:
            image = image.unsqueeze(0)

        predictor = model["predictor"]
        device = torch.device(model["device"])

        # Per batch item: positions, linear scales, wxyz quats, opacities in [0,1], SH (N, 1, 3).
        # SHARP predicts linearRGB colors and its own PLY export bakes sRGB into the SH DC term so
        # public renderers show it unchanged - keep that, the viewers here read sh[..., 0, :] as color.
        items = []
        extrinsics = intrinsics = None
        flat = lambda t: t.flatten(0, 1).float().cpu()
        for i in range(image.shape[0]):
            image_np = (image[i, :, :, :3].cpu().numpy() * 255).astype(np.uint8)
            height, width = image_np.shape[:2]
            f_px = focal_length_px(width, height, focal_length_mm if focal_length_mm > 0 else 30.0)

            print(f"[ImageToGaussianSplat] Image {i + 1}/{image.shape[0]}: {width}x{height}, f={f_px:.1f}px")
            g = self._predict_image(predictor, image_np, f_px, device)
            flat = lambda t: t.flatten(0, 1).float().cpu()
            sh = convert_rgb_to_spherical_harmonics(linearRGB2sRGB(g.colors.flatten(0, 1)))
            items.append((flat(g.mean_vectors), flat(g.singular_values), flat(g.quaternions),
                          flat(g.opacities).reshape(-1, 1), sh[:, None, :].cpu()))

            if i == 0:
                # One camera for the merged scene: the first image's, which is what SharpPredict
                # hands over for a batch too.
                extrinsics = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
                intrinsics = [[float(f_px), 0.0, width * 0.5], [0.0, float(f_px), height * 0.5], [0.0, 0.0, 1.0]]

        return (self._to_splat(items), extrinsics, intrinsics)

    def _predict_image(self, predictor, image_np: np.ndarray, f_px: float, device: torch.device):
        from sharp.utils.gaussians import unproject_gaussians

        internal_h, internal_w = self.INTERNAL_SHAPE
        height, width = image_np.shape[:2]

        image_pt = torch.from_numpy(image_np.copy()).float().to(device).permute(2, 0, 1) / 255.0
        image_resized_pt = F.interpolate(
            image_pt[None],
            size=(internal_h, internal_w),
            mode="bilinear",
            align_corners=True,
        )

        image_hash = hashlib.sha256(image_np.tobytes()).hexdigest()[:16]
        if _sharp_encode_cache["image_hash"] == image_hash:
            print("[ImageToGaussianSplat] Cache hit - reusing encoded features")
            monodepth_output = _sharp_encode_cache["monodepth_output"]
            image_resized_pt = _sharp_encode_cache["image_resized"]
        else:
            print("[ImageToGaussianSplat] Cache miss - running encoder (the slow part)...")
            monodepth_output, _ = predictor.encode(image_resized_pt)
            _sharp_encode_cache["image_hash"] = image_hash
            _sharp_encode_cache["monodepth_output"] = monodepth_output
            _sharp_encode_cache["image_resized"] = image_resized_pt

        # f_px is a numpy float64; the decoder broadcasts the factor into its float32 features,
        # so it has to be pinned to float32 here (torch.tensor() alone would give double).
        disparity_factor = torch.tensor([f_px / width], dtype=torch.float32, device=device)
        gaussians_ndc = predictor.decode(monodepth_output, image_resized_pt, disparity_factor)

        intrinsics = torch.tensor(
            [
                [f_px, 0, width / 2, 0],
                [0, f_px, height / 2, 0],
                [0, 0, 1, 0],
                [0, 0, 0, 1],
            ],
            dtype=torch.float32,
            device=device,
        )
        intrinsics_resized = intrinsics.clone()
        intrinsics_resized[0] *= internal_w / width
        intrinsics_resized[1] *= internal_h / height

        return unproject_gaussians(
            gaussians_ndc, torch.eye(4, device=device), intrinsics_resized, self.INTERNAL_SHAPE
        )

    def _to_splat(self, items):
        """Zero-pad the batch to the longest item, the way ComfyUI's own splat nodes store a batch."""
        counts = torch.tensor([int(t[0].shape[0]) for t in items], dtype=torch.int32)
        max_n = int(counts.max().item())

        def pad(field_index, fill):
            out = torch.full((len(items), max_n) + items[0][field_index].shape[1:], fill, dtype=torch.float32)
            for b, item in enumerate(items):
                t = item[field_index]
                out[b, : t.shape[0]] = t
            return out

        positions = pad(0, 0.0)
        rotations = pad(2, 0.0)
        # Padded rows carry an identity quaternion instead of the degenerate all-zero one.
        for b, item in enumerate(items):
            rotations[b, item[2].shape[0]:, 0] = 1.0

        return Types.SPLAT(
            positions=positions,
            scales=pad(1, 0.0),
            rotations=rotations,
            opacities=pad(3, 0.0),
            sh=pad(4, 0.0),
            counts=counts,
        )


def normalize_angle(angle, range_type='±180'):
    """
    将角度规范化到标准范围
    
    参数:
        angle: 输入角度（度）
        range_type: '±180' → [-180, 180]
                    '0-360' → [0, 360)
                    '±90'   → [-90, 90]
    
    返回:
        规范化后的角度
    """
    # 先确保在 [0, 360) 范围内
    angle = angle % 360
    
    if range_type == '±180':
        # 转换到 [-180, 180]
        if angle > 180:
            angle -= 360
    elif range_type == '±90':
        # 转换到 [-90, 90]
        if angle > 180:
            angle -= 360
        # 注意：±90 范围可能需要特殊处理，取决于应用场景
    elif range_type == '0-360':
        pass  # 已经是 [0, 360)
    
    return angle

def rotationMatrixToEulerAngles(R, output_angle = True):
    """
    从旋转矩阵计算欧拉角 (ZYX 顺序)
    结合 arctan2 的四象限优势 + clip 的数值保护
    """
    sy = np.sqrt(R[0,0] * R[0,0] + R[1,0] * R[1,0])
    singular = sy < 1e-6
    
    if not singular:
        pitch = np.arctan2(R[2,1], R[2,2])
        yaw   = np.arctan2(-R[2,0], sy)  # 用 arctan2 保持四象限
        roll  = np.arctan2(R[1,0], R[0,0])
    else:
        pitch = np.arctan2(-R[1,2], R[1,1])
        yaw   = np.arctan2(-R[2,0], sy)  # 奇异点时 sy≈0，但仍可用
        roll  = 0
        
    if output_angle:
        pitch = np.degrees(pitch)
        yaw   = np.degrees(yaw)
        roll  = np.degrees(roll)
        
        # 可选: 规范化到 [-180, 180]
        pitch = normalize_angle(pitch, '±180')
        yaw = normalize_angle(yaw, '±180')
        roll = normalize_angle(roll, '±180')
    
    return pitch, yaw, roll

class ExtrinsicsCompareNode:
    """Compare two extrinsics matrices and output relative translation (x,y,z) and rotation (pitch,yaw,roll)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "current": ("EXTRINSICS", {
                    "tooltip": "Current extrinsics matrix",
                }),
                "next": ("EXTRINSICS", {
                    "tooltip": "Next extrinsics matrix",
                }),
            },
        }

    RETURN_TYPES = ("FLOAT", "FLOAT", "FLOAT", "FLOAT", "FLOAT", "FLOAT")
    RETURN_NAMES = ("x", "y", "z", "pitch", "yaw", "roll")
    FUNCTION = "compare_extrinsics"
    CATEGORY = "Kolid-Toolkit"

    
    
    def compare_extrinsics(self, current, next):
        """
        Calculate relative transform between two extrinsics matrices.
        OpenCV坐标系: X-right, Y-down, Z-forward (右手系)
        欧拉角: XYZ旋转顺序
        """
        # Convert inputs to numpy arrays if needed
        if current is None:
            current = np.eye(4)
        elif not isinstance(current, np.ndarray):
            current = np.array(current).reshape(4, 4)
        
        if next is None:
            next = np.eye(4)
        elif not isinstance(next, np.ndarray):
            next = np.array(next).reshape(4, 4)
        
        # ✅ 修正: 从 current 到 next 的变换
        current_inv = np.linalg.inv(current)
        relative_transform = np.dot(next, current_inv)
        
        # Extract translation
        translation = relative_transform[:3, 3]
        x, y, z = translation
        
        # Extract rotation matrix
        R = relative_transform[:3, :3]
        
        pitch, yaw, roll = rotationMatrixToEulerAngles(R)
        
        return (x, y, z, pitch, yaw, roll)



