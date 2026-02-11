# SPDX-License-Identifier: GPL-3.0-or-later

import os
import webbrowser
import threading
import http.server
import socketserver
import json
import base64
import numpy as np
from urllib.parse import urlparse, parse_qs, quote
import urllib
import folder_paths
import torch
import time
import subprocess
import sys
import socket
import threading
import requests
import queue
import io
from PIL import Image
import cv2
import comfy.model_management as mm
import signal
import shutil

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

def handleSnapShot(severHandler):
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
        
        # Create SnapShot directory in output folder
        snapshot_dir = os.path.join(folder_paths.output_directory, "SnapShot")
        os.makedirs(snapshot_dir, exist_ok=True)
        # Generate unique filename
        timestamp = int(time.time() * 1000)
        severHandler.server_instance.image_path = os.path.join(snapshot_dir, f"snapshot_{timestamp}.png")
        with open(severHandler.server_instance.image_path, 'wb') as f:
            f.write(image_data)
            
        # Signal that screenshot is ready
        severHandler.server_instance.screenshot_event.set()
    else:
        severHandler.send_error(500, "Server error")

def handleWindowClosed(severHandler):
    # Handle window closed notification
    if severHandler.server_instance:
        severHandler.send_response(200)
        severHandler.send_header('Content-type', 'application/json')
        severHandler.send_header("Access-Control-Allow-Origin", "*")
        severHandler.end_headers()
        severHandler.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
    else:
        severHandler.send_error(500, "Server error")

def getContents(ply_path) -> str:
    if not ply_path or ply_path.strip() == "":
        raise ValueError("PLY path cannot be empty")

    resolved = ply_path.strip().strip('"')
    if not os.path.exists(resolved):
        raise ValueError(f"PLY file not found: {resolved}")
    if not resolved.lower().endswith(".ply"):
        raise ValueError("File must be a .ply Gaussian splat")
    
    # Check file size to avoid memory issues
    file_size = os.path.getsize(resolved)
    max_file_size = 500 * 1024 * 1024  # 500MB limit
    if file_size > max_file_size:
        raise ValueError(f"PLY file is too large ({file_size / (1024*1024):.1f}MB). Maximum size is {max_file_size / (1024*1024)}MB")
    
    # Read PLY file data
    try:
        with open(resolved, 'rb') as f:
            ply_data = f.read()
        print(f"[SnapshotGaussian] Successfully read PLY file")
        return base64.b64encode(ply_data).decode('utf-8')
    except Exception as e:
        raise ValueError(f"Failed to read PLY file: {e}")
    
    

class GSplatServer:
    """Temporary HTTP server to serve the snapshot page and handle screenshot capture."""

    def __init__(self, contents, extrinsics, intrinsics, width, height):
        self.contents = contents
        self.extrinsics = extrinsics
        self.intrinsics = intrinsics
        self.width = width
        self.height = height
        self.image = None
        self.image_path = None
        self.server = None
        self.started = False
        self.screenshot_event = threading.Event()
        self.window_closed = False
        self.bowser_url = None

    def start(self):
        # Find an available port
        for port in range(8080, 9000):
            try:
                self.server = socketserver.TCPServer(('localhost', port), self.GSplatHandler)
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
            if self.path == '/gaussian_node.html':
                # Serve the gaussian_node.html file
                file_path = os.path.join(os.path.dirname(__file__), 'web', 'gaussian_node.html')
                if os.path.exists(file_path):
                    self.send_response(200)
                    self.send_header('Content-type', 'text/html')
                    self.end_headers()
                    with open(file_path, 'rb') as f:
                        self.wfile.write(f.read())
                else:
                    self.send_error(404, "File not found")
            elif self.path.startswith('/js/'):
                # Serve JavaScript files
                file_path = os.path.join(os.path.dirname(__file__), 'web', self.path[1:])
                if os.path.exists(file_path):
                    self.send_response(200)
                    self.send_header('Content-type', 'application/javascript')
                    self.end_headers()
                    with open(file_path, 'rb') as f:
                        self.wfile.write(f.read())
                else:
                    self.send_error(404, "File not found")
            elif self.path == '/contents':
                # Serve PLY data as JSON
                if self.server_instance:
                    try:
                        response = {
                            'contents': self.server_instance.contents,
                            'extrinsics': self.server_instance.extrinsics,
                            'intrinsics': self.server_instance.intrinsics,
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
                        self.send_error(500, f"Error processing PLY data: {e}")
                        return
                else:
                    self.send_error(500, "Server error")
            else:
                super().do_GET()

        def do_POST(self):
            if self.path == '/screenshot':
                handleSnapShot(self)
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
        self.image_path = None
        self.server = None
        self.started = False
        self.screenshot_event = threading.Event()
        self.window_closed = False
        self.bowser_url = None
        self.serve_subprocess = None

    def start(self):
        success = False
        # Find an available port
        for port in range(8080, 9000):
            try:
                self.server = socketserver.TCPServer(('localhost', port), self.SuperSplatHandler)
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
            "extrinsics": json.dumps(self.extrinsics.tolist() if hasattr(self.extrinsics, 'tolist') else self.extrinsics),
            "intrinsics": json.dumps(self.intrinsics.tolist() if hasattr(self.intrinsics, 'tolist') else self.intrinsics),
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
        supersplat_root = os.path.join(os.path.dirname(__file__), "supersplat")
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
                handleSnapShot(self)
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
    """Preview a Gaussian splat PLY file in a browser and take a snapshot when Enter is pressed."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "ply_path": ("STRING", {
                    "forceInput": True,
                    "tooltip": "PLY file path from upstream node",
                }),
                "extrinsics": ("EXTRINSICS", {
                    "tooltip": "Extrinsics from upstream node",
                }),
                "intrinsics": ("INTRINSICS", {
                    "tooltip": "Intrinsics from upstream node",
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
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("snapshot", "snapshot_path")
    FUNCTION = "take_snapshot"
    CATEGORY = "Kolid-Toolkit"
    
    @classmethod
    def IS_CHANGED(s):
        return float("nan")

    def take_snapshot(
        self,
        ply_path: str,
        extrinsics=None,
        intrinsics=None,
        method: str = "GSplat",
        width: int = 512,
        height: int = 512,
    ):
        contents = getContents(ply_path)
        focused_window = None
        if has_win32gui:
            focused_window = win32gui.GetForegroundWindow()

        # Start a temporary HTTP server to serve the snapshot page
        if method == "GSplat":
            server = GSplatServer(contents, extrinsics, intrinsics, width, height)
        elif method == "SuperSplat":
            filename = os.path.basename(ply_path)
            server = SuperSplatServer(filename, contents, extrinsics, intrinsics, width, height)
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

        print(f"[SnapshotGaussian] Opening browser at: {server.bowser_url}")
        webbrowser.open(server.bowser_url)

        # Wait for screenshot to be captured (indefinitely, but web page will notify on close)
        print("[SnapshotGaussian] Waiting for snapshot...")
        server.wait_for_screenshot()

        # Stop the server
        server.stop()

        # Restore window focus with enhanced reliability
        if has_win32gui and focused_window:
            time.sleep(0.5)
            focus_window(focused_window)

        if server.window_closed or server.image is None:
            raise ValueError("Window closed without taking screenshot")
        
        return (server.image, server.image_path)


