# SPDX-License-Identifier: GPL-3.0-or-later

import os
from pickle import NONE
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
import requests
import io
from PIL import Image
import cv2
import comfy.model_management as mm
import signal
import shutil
import torch.nn.functional as F
import pyautogui
from PySide6.QtCore import Qt, QRect, QPoint, QPropertyAnimation, QEasingCurve
from ..libs.image_utils import crop_mask, recover_crop, hex_to_rgb, batch_images, recover_batch, limit_pixels, recover_size, batch_image_mask_list
from ..libs.mask_utils import combine_masks, create_empty_mask
from ..libs.detect_utils import detect_mask
from PySide6.QtGui import QColor, QPainter, QPen, QGuiApplication, QPixmap, QImage, QPainterPath
from PySide6.QtWidgets import (QApplication, QWidget, QPushButton, QHBoxLayout, QVBoxLayout)
from server import PromptServer

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
    print("[SnapshotImage] win32gui not available, cannot restore window focus")
    

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
    print(f"[SnapshotImage] 等待端口 {port} 在 {host} 上可用...")
    
    while time.time() - start_time < timeout:
        try:
            # 尝试连接到端口
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(1)
            result = sock.connect_ex((host, port))
            sock.close()
            
            if result == 0:
                # 端口可用
                print(f"[SnapshotImage] 端口 {port} 已可用")
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
    raise TimeoutError(f"[SnapshotImage] 等待端口 {port} 超时（{timeout} 秒）")

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
        
        # Create SnapShot directory in output folder
        snapshot_dir = os.path.join(folder_paths.output_directory, "SnapShot")
        os.makedirs(snapshot_dir, exist_ok=True)
        # Generate unique filename
        timestamp = int(time.time() * 1000)
        severHandler.server_instance.image_path = os.path.join(snapshot_dir, f"snapshot_{timestamp}.png")
        with open(severHandler.server_instance.image_path, 'wb') as f:
            f.write(image_data)
            
        # Signal that screenshot is ready
        if set_event: severHandler.server_instance.screenshot_event.set()
    else:
        severHandler.send_error(500, "Server error")


def image_to_base64(image_tensor):
    """将图片张量转换为base64编码
    
    Args:
        image_tensor: 图片张量，形状为 (1, H, W, C)，值范围 [0, 1]
    
    Returns:
        str: base64编码的图片字符串
    """
    # 转换为numpy数组并反归一化
    img_array = (image_tensor.squeeze(0).cpu().numpy() * 255).astype(np.uint8)
    # 转换为BGR格式
    img_bgr = cv2.cvtColor(img_array, cv2.COLOR_RGB2BGR)
    # 编码为jpg
    _, buffer = cv2.imencode('.jpg', img_bgr)
    # 转换为base64
    base64_str = base64.b64encode(buffer).decode('utf-8')
    return f"data:image/jpeg;base64,{base64_str}"


def mask_to_base64(mask_tensor):
    """将mask张量转换为base64编码的PNG (红色半透明RGBA，透明背景)
    
    Args:
        mask_tensor: mask张量，形状为 (B, H, W) 或 (H, W)，值范围 [0, 1]
    
    Returns:
        str: base64编码的PNG图片字符串 (RGBA)
    """
    if isinstance(mask_tensor, torch.Tensor):
        mask_np = mask_tensor.cpu().numpy()
    else:
        mask_np = np.array(mask_tensor)
    
    # 去掉batch维度
    if mask_np.ndim == 3:
        mask_np = mask_np[0]
    
    mask_np = np.squeeze(mask_np)
    
    # 转为uint8 alpha通道
    mask_uint8 = (np.clip(mask_np, 0.0, 1.0) * 255).astype(np.uint8)
    h, w = mask_uint8.shape
    
    # 构建RGBA图像: 红色半透明前景 + 透明背景
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[:, :, 0] = 255   # R
    rgba[:, :, 3] = mask_uint8  # A (mask强度决定透明度)
    
    # cv2默认BGRA格式
    bgra = cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA)
    
    # 编码为png
    _, buffer = cv2.imencode('.png', bgra)
    base64_str = base64.b64encode(buffer).decode('utf-8')
    return f"data:image/png;base64,{base64_str}"


def detector_mask_to_base64(mask_tensor, alpha=0.6):
    """将detector返回的mask转为红色半透明RGBA base64，用于前端直接叠加绘制
    
    Args:
        mask_tensor: mask张量，形状 (B, H, W) 或 (H, W)，值范围 [0, 1]
        alpha: 叠加透明度系数
    
    Returns:
        str: base64编码的PNG图片字符串
    """
    if isinstance(mask_tensor, torch.Tensor):
        mask_np = mask_tensor.cpu().numpy()
    else:
        mask_np = np.array(mask_tensor)
    
    if mask_np.ndim == 3:
        mask_np = mask_np[0]
    mask_np = np.squeeze(mask_np)
    
    h, w = mask_np.shape
    mask_uint8 = (np.clip(mask_np, 0.0, 1.0) * 255).astype(np.uint8)
    
    # Create RGBA: red with mask as alpha
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[:, :, 0] = 255  # R
    rgba[:, :, 3] = (mask_uint8 * alpha).astype(np.uint8)  # A
    
    # Encode as PNG (BGRA for cv2)
    _, buffer = cv2.imencode('.png', cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
    base64_str = base64.b64encode(buffer).decode('utf-8')
    return f"data:image/png;base64,{base64_str}"


def handlePointsSelection(severHandler, set_event):
    # Handle points selection data
    content_length = int(severHandler.headers['Content-Length'])
    post_data = severHandler.rfile.read(content_length)
    data = json.loads(post_data)
    
    if severHandler.server_instance:
        # Get points data
        positive_points = data.get('positivePoints', [])
        negative_points = data.get('negativePoints', [])
        
        # Store points
        severHandler.server_instance.positive_points = positive_points
        severHandler.server_instance.negative_points = negative_points
        
        severHandler.send_response(200)
        severHandler.send_header('Content-type', 'application/json')
        severHandler.send_header("Access-Control-Allow-Origin", "*")
        severHandler.end_headers()
        severHandler.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
        
        # Signal that points selection is ready
        if set_event: severHandler.server_instance.screenshot_event.set()
    else:
        severHandler.send_error(500, "Server error")


class SnapshotImageNodeServer:
    """Temporary HTTP server to serve the snapshot page and handle image selection."""

    def __init__(self, image, width, height):
        self.image = image
        self.width = width
        self.height = height
        self.selected_image = None
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
                self.server = socketserver.TCPServer(('localhost', port), self.SnapshotImageNodeHandler)
                self.started = True
                print(f"[SnapshotImage] Server started on port {port}")
                break
            except:
                continue
            
        self.bowser_url = f"http://localhost:{port}/image_node.html"
        

        if not self.started:
            print("[SnapshotImage] Failed to start server")
            return

        # Store reference to self in the handler class
        self.SnapshotImageNodeHandler.server_instance = self

        # Serve forever
        try:
            self.server.serve_forever()
        except:
            pass

    def stop(self):
        if self.server:
            print("[SnapshotImage] Stopping server")
            self.server.shutdown()
            self.server.server_close()

    def wait_for_selection(self):
        """Wait for image selection indefinitely."""
        if( not waitSnapShot(self.screenshot_event)):
            raise Exception("Canceled")

    class SnapshotImageNodeHandler(http.server.SimpleHTTPRequestHandler):
        server_instance = None

        def do_GET(self):
            if self.path == '/image_node.html':
                # Serve the image_node.html file
                file_path = os.path.join(os.path.dirname(__file__), 'web', 'image_node.html')
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
                    self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
                    self.send_header('Pragma', 'no-cache')
                    self.send_header('Expires', '0')
                    self.end_headers()
                    with open(file_path, 'rb') as f:
                        self.wfile.write(f.read())
                else:
                    self.send_error(404, "File not found")
            elif path == '/image_data':
                # Serve image data as JSON
                if self.server_instance:
                    try:
                        # 将图片转换为base64
                        image_base64 = image_to_base64(self.server_instance.image)
                        response = {
                            'image': image_base64,
                            'width': self.server_instance.width,
                            'height': self.server_instance.height
                        }
                        # Set appropriate content length
                        response_data = json.dumps(response).encode('utf-8')
                        self.send_response(200)
                        self.send_header('Content-type', 'application/json')
                        self.send_header('Content-Length', str(len(response_data)))
                        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
                        self.send_header('Pragma', 'no-cache')
                        self.send_header('Expires', '0')
                        self.end_headers()
                        self.wfile.write(response_data)
                    except Exception as e:
                        self.send_error(500, f"Error processing image data: {e}")
                        return
                else:
                    self.send_error(500, "Server error")
            else:
                super().do_GET()

        def do_POST(self):
            if self.path == '/screenshot':
                handleSnapShot(self, True)
            elif self.path == '/window_closed':
                # Handle window closed event
                self.server_instance.window_closed = True
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
            else:
                super().do_POST()

        def log_message(self, format, *args):
            # Suppress server logs
            pass


class SnapshotImageNode:
    """Open an image in a browser, allow user to select a region by dragging, and return the selected region."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": "Input image to select from",
                }),
                "width": ("INT", {
                    "default": 512,
                    "min": 64,
                    "max": 2048,
                    "step": 1,
                    "tooltip": "Width of the preview window",
                }),
                "height": ("INT", {
                    "default": 512,
                    "min": 64,
                    "max": 2048,
                    "step": 1,
                    "tooltip": "Height of the preview window",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("selected_image", "image_path")
    FUNCTION = "select_image"
    CATEGORY = "Kolid-Toolkit"
    
    @classmethod
    def IS_CHANGED(s):
        return float("nan")

    def select_image(
        self,
        image,
        width: int = 512,
        height: int = 512,
    ):
        focused_window = None
        if has_win32gui:
            focused_window = win32gui.GetForegroundWindow()

        # Start a temporary HTTP server to serve the image selection page
        server = SnapshotImageNodeServer(image, width, height)
        server_thread = threading.Thread(target=server.start)
        server_thread.daemon = True
        server_thread.start()

        start_time = time.time()
        timeout = 10  # 10 seconds timeout
        while not server.started:
            if time.time() - start_time > timeout:
                raise RuntimeError(f"[SnapshotImage] Server startup timeout after {timeout} seconds")
            time.sleep(0.1)

        print(f"[SnapshotImage] Opening browser at: {server.bowser_url}")
        webbrowser.open(server.bowser_url)

        # Wait for image selection to be captured
        print("[SnapshotImage] Waiting for image selection...")
        server.wait_for_selection()

        # Stop the server
        server.stop()

        # Restore window focus
        if has_win32gui and focused_window:
            time.sleep(0.5)
            focus_window(focused_window)

        if server.window_closed or server.image is None:
            raise ValueError("Window closed without selecting image")
        
        return (server.image, server.image_path)


class SnapshotImagePointsNodeServer:
    """Temporary HTTP server to serve the image points selection page and handle points selection."""

    def __init__(self, image, initial_positive=None, initial_negative=None):
        self.image = image
        self.positive_points = initial_positive or []
        self.negative_points = initial_negative or []
        self.server = None
        self.started = False
        self.screenshot_event = threading.Event()
        self.window_closed = False
        self.bowser_url = None

    def start(self):
        # Find an available port
        for port in range(8080, 9000):
            try:
                self.server = socketserver.TCPServer(('localhost', port), self.SnapshotImagePointsNodeHandler)
                self.started = True
                print(f"[SnapshotImagePoints] Server started on port {port}")
                break
            except:
                continue
            
        self.bowser_url = f"http://localhost:{port}/image_points.html"
        

        if not self.started:
            print("[SnapshotImagePoints] Failed to start server")
            return

        # Store reference to self in the handler class
        self.SnapshotImagePointsNodeHandler.server_instance = self

        # Serve forever
        try:
            self.server.serve_forever()
        except:
            pass

    def stop(self):
        if self.server:
            print("[SnapshotImagePoints] Stopping server")
            self.server.shutdown()
            self.server.server_close()

    def wait_for_selection(self):
        """Wait for points selection indefinitely."""
        if( not waitSnapShot(self.screenshot_event)):
            raise Exception("Canceled")

    class SnapshotImagePointsNodeHandler(http.server.SimpleHTTPRequestHandler):
        server_instance = None

        def do_GET(self):
            if self.path == '/image_points.html':
                # Serve the image_points.html file
                file_path = os.path.join(os.path.dirname(__file__), 'web', 'image_points.html')
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
                    self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
                    self.send_header('Pragma', 'no-cache')
                    self.send_header('Expires', '0')
                    self.end_headers()
                    with open(file_path, 'rb') as f:
                        self.wfile.write(f.read())
                else:
                    self.send_error(404, "File not found")
            elif self.path == '/image_data':
                # Serve image data as JSON
                if self.server_instance:
                    try:
                        # 将图片转换为base64
                        image_base64 = image_to_base64(self.server_instance.image)
                        response = {
                            'image': image_base64,
                            'initial_positive_points': self.server_instance.positive_points,
                            'initial_negative_points': self.server_instance.negative_points
                        }
                        # Set appropriate content length
                        response_data = json.dumps(response).encode('utf-8')
                        self.send_response(200)
                        self.send_header('Content-type', 'application/json')
                        self.send_header('Content-Length', str(len(response_data)))
                        self.end_headers()
                        self.wfile.write(response_data)
                    except Exception as e:
                        self.send_error(500, f"Error processing image data: {e}")
                        return
                else:
                    self.send_error(500, "Server error")
            else:
                super().do_GET()

        def do_POST(self):
            if self.path == '/points':
                handlePointsSelection(self, True)
            elif self.path == '/window_closed':
                # Handle window closed event
                self.server_instance.window_closed = True
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
            else:
                super().do_POST()

        def log_message(self, format, *args):
            # Suppress log messages
            pass


class SnapshotImagePointsNode:
    """Open an image in a browser, allow user to select positive and negative points, and return the points."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": "Input image to select points from",
                }),
                "pos_points": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Additional positive points as JSON string",
                }),
                "neg_points": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Additional negative points as JSON string",
                }),
                "modifying": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "When True, open web interface to select points; when False, use current points without opening interface",
                }),
            },
            "optional": {
                "positive_points": ("SAM3_POINTS_PROMPT", {
                    "tooltip": "Initial positive points in SAM3 format",
                }),
                "negative_points": ("SAM3_POINTS_PROMPT", {
                    "tooltip": "Initial negative points in SAM3 format",
                })
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("SAM3_POINTS_PROMPT", "SAM3_POINTS_PROMPT")
    RETURN_NAMES = ("positive_points", "negative_points")
    FUNCTION = "select_points"
    CATEGORY = "Kolid-Toolkit"
    
    @classmethod
    def IS_CHANGED(cls, image, pos_points="", neg_points="", modifying=True, 
                   positive_points=None, negative_points=None, unique_id=None):
        # modifying=True 时，每次都强制打开界面重新点选
        if modifying:
            return float("nan")
        
        # modifying=False 时，通过 hash 判断输入是否变化
        try:
            import hashlib
            m = hashlib.md5()
            
            # 图像内容
            if hasattr(image, 'shape'):
                m.update(str(image.shape).encode())
            elif image is not None:
                m.update(str(image).encode())
            
            m.update(str(pos_points).encode())
            m.update(str(neg_points).encode())
            
            if positive_points is not None:
                m.update(str(positive_points).encode())
            if negative_points is not None:
                m.update(str(negative_points).encode())
            
            if unique_id is not None:
                m.update(str(unique_id).encode())
            
            return float(int(m.hexdigest(), 16) % (2**32))
        except:
            return float("nan")  # 保险措施

    def select_points(
        self,
        image,
        pos_points="",
        neg_points="",
        modifying=True,
        positive_points=None,
        negative_points=None,
        unique_id=None
    ):
        # Get image dimensions
        batch_size, img_height, img_width, channels = image.shape
        
        # Convert SAM3 format points to pixel coordinates
        initial_positive = []
        if positive_points and "points" in positive_points:
            for i, point in enumerate(positive_points["points"]):
                if positive_points["labels"][i] == 1:
                    x = int(point[0] * img_width)
                    y = int(point[1] * img_height)
                    initial_positive.append({"x": x, "y": y})
        
        initial_negative = []
        if negative_points and "points" in negative_points:
            for i, point in enumerate(negative_points["points"]):
                if negative_points["labels"][i] == 0:
                    x = int(point[0] * img_width)
                    y = int(point[1] * img_height)
                    initial_negative.append({"x": x, "y": y})
        
        # Parse and merge pos_points string
        if pos_points and pos_points.strip():
            try:
                pos_data = json.loads(pos_points.strip())
                if isinstance(pos_data, list):
                    for point in pos_data:
                        if isinstance(point, dict) and "x" in point and "y" in point:
                            initial_positive.append({"x": int(point["x"]), "y": int(point["y"])})
                        elif isinstance(point, (list, tuple)) and len(point) >= 2:
                            initial_positive.append({"x": int(point[0]), "y": int(point[1])})
            except json.JSONDecodeError:
                pass
        
        # Parse and merge neg_points string
        if neg_points and neg_points.strip():
            try:
                neg_data = json.loads(neg_points.strip())
                if isinstance(neg_data, list):
                    for point in neg_data:
                        if isinstance(point, dict) and "x" in point and "y" in point:
                            initial_negative.append({"x": int(point["x"]), "y": int(point["y"])})
                        elif isinstance(point, (list, tuple)) and len(point) >= 2:
                            initial_negative.append({"x": int(point[0]), "y": int(point[1])})
            except json.JSONDecodeError:
                pass

        if modifying:
            focused_window = None
            if has_win32gui:
                focused_window = win32gui.GetForegroundWindow()

            # Start a temporary HTTP server to serve the image points selection page
            server = SnapshotImagePointsNodeServer(image, initial_positive, initial_negative)
            server_thread = threading.Thread(target=server.start)
            server_thread.daemon = True
            server_thread.start()

            start_time = time.time()
            timeout = 10  # 10 seconds timeout
            while not server.started:
                if time.time() - start_time > timeout:
                    raise RuntimeError(f"[SnapshotImagePoints] Server startup timeout after {timeout} seconds")
                time.sleep(0.1)

            print(f"[SnapshotImagePoints] Opening browser at: {server.bowser_url}")
            webbrowser.open(server.bowser_url)

            # Wait for points selection to be captured
            print("[SnapshotImagePoints] Waiting for points selection...")
            server.wait_for_selection()

            # Stop the server
            server.stop()

            # Restore window focus
            if has_win32gui and focused_window:
                time.sleep(0.5)
                focus_window(focused_window)

            if server.window_closed:
                raise ValueError("Window closed without selecting points")
            
            # Use the points from the server
            selected_positive = server.positive_points
            selected_negative = server.negative_points
            
            # Send points back to widget for caching
            if unique_id is not None:
                from server import PromptServer
                pos_points_json = json.dumps([{"x": p['x'], "y": p['y']} for p in selected_positive])
                neg_points_json = json.dumps([{"x": n['x'], "y": n['y']} for n in selected_negative])
                PromptServer.instance.send_sync("kolid-comfy-widget-set", {"node_id": unique_id, "widget_name": "pos_points", "type": "STRING", "value": pos_points_json})
                PromptServer.instance.send_sync("kolid-comfy-widget-set", {"node_id": unique_id, "widget_name": "neg_points", "type": "STRING", "value": neg_points_json})
                # Set modifying to False after use
                PromptServer.instance.send_sync("kolid-comfy-widget-set", {"node_id": unique_id, "widget_name": "modifying", "type": "BOOLEAN", "value": False})
        else:
            # Use the initial points without opening the interface
            selected_positive = initial_positive
            selected_negative = initial_negative
        
        # Create positive points in SAM3 format
        positive_points_result = {"points": [], "labels": []}
        for p in selected_positive:
            normalized_x = p['x'] / img_width
            normalized_y = p['y'] / img_height
            positive_points_result["points"].append([normalized_x, normalized_y])
            positive_points_result["labels"].append(1)
        
        # Create negative points in SAM3 format
        negative_points_result = {"points": [], "labels": []}
        for n in selected_negative:
            normalized_x = n['x'] / img_width
            normalized_y = n['y'] / img_height
            negative_points_result["points"].append([normalized_x, normalized_y])
            negative_points_result["labels"].append(0)
        
        return (positive_points_result, negative_points_result)


class ImageLimitPixelNode:
    """Limit image pixel count by resizing if exceeding specified limit."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": "Input image to limit pixel count"
                }),
                "pixels": ("INT", {
                    "default": 1024 * 1024,  # 1MP
                    "min": 1,
                    "max": 1024 * 1024 * 1024,
                    "tooltip": "Maximum allowed pixel count"
                }),
                "align": ("INT", {
                    "default": 1,
                    "min": 1,
                    "max": 1024 * 1024 * 1024,
                    "tooltip": "Align the resized image to the nearest pixel grid"
                }),
            },
            "optional": {
                "mask": ("MASK", {
                    "tooltip": "Optional mask to resize alongside image"
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "RESIZE_INFO")
    RETURN_NAMES = ("image", "mask", "resize_info")
    FUNCTION = "limit_pixels"
    CATEGORY = "Kolid-Toolkit"

    def limit_pixels(self, image, pixels, align, mask=None):
        """Limit image pixel count by resizing if needed."""
        try:
            print("[ImageLimitPixelNode] Calling limit_pixels from image_utils")
            return limit_pixels(image, pixels, mask, align)
        except Exception as e:
            raise Exception(f"Failed to limit pixels: {e}")


class LimitPixelNode:
    """Compute limited pixel dimensions without resizing an image."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {
                    "default": 1024,
                    "min": 1,
                    "max": 1024 * 1024 * 1024,
                    "tooltip": "Original width"
                }),
                "height": ("INT", {
                    "default": 1024,
                    "min": 1,
                    "max": 1024 * 1024 * 1024,
                    "tooltip": "Original height"
                }),
                "pixels": ("INT", {
                    "default": 1024 * 1024,  # 1MP
                    "min": 1,
                    "max": 1024 * 1024 * 1024,
                    "tooltip": "Maximum allowed pixel count"
                }),
                "align": ("INT", {
                    "default": 1,
                    "min": 1,
                    "max": 1024 * 1024 * 1024,
                    "tooltip": "Align the resized dimensions to the nearest pixel grid"
                }),
            },
        }

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("width", "height")
    FUNCTION = "limit_pixels"
    CATEGORY = "Kolid-Toolkit"

    def limit_pixels(self, width, height, pixels, align):
        """Compute new width/height that fit within the pixel limit, preserving aspect ratio."""
        try:
            current_pixels = width * height

            if abs(current_pixels - pixels) < 100:
                return (width, height)

            aspect_ratio = width / height if height != 0 else 1.0

            if current_pixels < pixels:
                ideal_width = (pixels * aspect_ratio) ** 0.5
                ideal_height = ideal_width / aspect_ratio

                new_width = max(align, round(ideal_width / align) * align)
                new_height = max(align, round(ideal_height / align) * align)

                while new_width * new_height > pixels + 100:
                    new_width = max(align, new_width - align)
                    new_height = max(align, new_height - align)

                new_width = max(64, new_width)
                new_height = max(64, new_height)
            else:
                ideal_width = (pixels * aspect_ratio) ** 0.5
                ideal_height = ideal_width / aspect_ratio

                new_width = max(align, round(ideal_width / align) * align)
                new_height = max(align, round(ideal_height / align) * align)

                while new_width * new_height > pixels:
                    new_width = max(align, new_width - align)
                    new_height = max(align, new_height - align)

                new_width = max(16, new_width)
                new_height = max(16, new_height)

            return (new_width, new_height)
        except Exception as e:
            raise Exception(f"Failed to limit pixels: {e}")


class ImageRecoverResizeNode:
    """Recover image to original size using resize info."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": "Input image to recover"
                }),
                "resize_info": ("RESIZE_INFO", {
                    "tooltip": "Resize information from ImageLimitPixelNode"
                }),
            },
            "optional": {
                "mask": ("MASK", {
                    "tooltip": "Optional mask to recover alongside image"
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "recover_size"
    CATEGORY = "Kolid-Toolkit"

    def recover_size(self, image, resize_info, mask=None):
        """Recover image to original size using resize info."""
        try:
            print("[ImageRecoverResizeNode] Calling recover_size from image_utils")
            return recover_size(image, resize_info, mask)
        except Exception as e:
            raise Exception(f"Failed to recover image size: {e}")
        

class ImageCropMaskNode:
    """Crop image based on mask to remove transparent/non-masked areas."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "Input image to crop"}),
                "mask": ("MASK", {"tooltip": "Mask to use for cropping"}),
                "reserve": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 1000,
                    "step": 1,
                    "tooltip": "Number of pixels to reserve around the mask"
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "CROP_INFO")
    RETURN_NAMES = ("image", "mask", "crop_info")
    FUNCTION = "crop_mask"
    CATEGORY = "Kolid-Toolkit"

    def crop_mask(self, image, mask, reserve):
        try:
            print(f"[ImageCropMaskNode] Calling crop_mask from image_util")
            return crop_mask(image, mask, reserve)
        except Exception as e:
            raise Exception(f"Failed to crop image by mask: {e}")




class ImageRecoverCropNode:
    """Recover cropped image to original size using crop info."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "background": ("IMAGE", {"tooltip": "Background image to use as base"}),
                "image": ("IMAGE", {"tooltip": "Input cropped image to recover"}),
                "crop_info": ("CROP_INFO", {"tooltip": "Crop information from ImageCropMaskNode"}),
                "recover_method": (["mask_blend", "mask_only", "bounds_only"], {
                    "default": "mask_blend",
                    "tooltip": "Recover method..."
                }),
            },
            "optional": {
                "mask": ("MASK", {"tooltip": "Optional mask to recover alongside image"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "recover"
    CATEGORY = "Kolid-Toolkit"
    
    INPUT_IS_LIST = True

    def recover(self, background, image, crop_info, recover_method, mask=None):
        size = len(image)
        recover_method = recover_method[0]

        if len(background) == 1:
            # ==================== 单张 background：累积粘贴 ====================
            new_background = background[0].clone()

            collected_masks = []   # 用于收集所有 tmp_mask

            for i in range(size):
                curr_mask = mask[i] if (mask is not None and i < len(mask)) else None

                (tmp_background, tmp_mask) = recover_crop(
                    new_background, 
                    image[i], 
                    crop_info[i], 
                    recover_method, 
                    curr_mask
                )

                new_background = tmp_background   # 必须更新，让下一次在已修改的图上继续粘贴

                if tmp_mask is not None:
                    collected_masks.append(tmp_mask)

            # ==================== mask 统一合并（修复形状问题） ====================
            if collected_masks:
                # 关键修复：强制转为 [N, H, W]
                all_masks = torch.stack(collected_masks, dim=0)   # 当前很可能是 [6, 1, H, W]
                
                if all_masks.dim() == 4:
                    all_masks = all_masks.squeeze(1)   # [6, 1, H, W] → [6, H, W]
                elif all_masks.dim() == 2:
                    all_masks = all_masks.unsqueeze(0) # [H, W] → [1, H, W]
                
                # 现在形状一定是 [N, H, W]，可以安全传入
                new_mask = combine_masks(all_masks, mode="max")
            else:
                new_mask = None

            return (new_background, new_mask)

        else:
            # 多张 background 的情况保持你原来的代码（或改成 list 返回）
            if len(background) != size:
                raise ValueError(f"Background image count ({len(background)}) must match image count ({size})")
            
            backgrounds = []
            masks = [] if mask is not None else None

            for i in range(size):
                (tmp_background, tmp_mask) = recover_crop(
                    background[i], image[i], crop_info[i], recover_method, 
                    mask[i] if mask is not None else None
                )
                backgrounds.append(tmp_background)
                if tmp_mask is not None:
                    masks.append(tmp_mask)

            return (backgrounds, masks if masks is not None else None)

class ImageBatchNode:
    """将多个不同尺寸的 IMAGE 和 MASK 转为统一尺寸的 Batch，居中填充。
    
    最终对称处理逻辑：
    - 只设置 width > 0（height=0）：按 width 缩小后，target_h 自动向上对齐 align
    - 只设置 height > 0（width=0）：按 height 缩小后，target_w 自动向上对齐 align
    - 同时设置 width 和 height：强制使用指定尺寸（不强制 align）
    - width=height=0：使用 align 进行倍数对齐
    """
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "align": ("INT", {
                    "default": 16,
                    "min": 0,
                    "max": 128,
                    "step": 1,
                    "tooltip": "当只设置单方向（width或height）或都不设置时，用于最终尺寸对齐（推荐16）"
                }),
                "width": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 4096,
                    "tooltip": "只设置此值：按宽度缩小 + 高度自动计算并 align 对齐"
                }),
                "height": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 4096,
                    "tooltip": "只设置此值：按高度缩小 + 宽度自动计算并 align 对齐"
                }),
            },
            "optional": {
                "masks": ("MASK",),
                "fill_image": ("STRING", {
                    "default": "#000000",
                    "multiline": False,
                    "tooltip": "填充颜色，支持 #RRGGBB"
                }),
                "fill_mask": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                }),
            }
        }

    INPUT_IS_LIST = True
    RETURN_TYPES = ("IMAGE", "MASK", "BATCH_INFO")
    RETURN_NAMES = ("image", "mask", "batch_info")
    FUNCTION = "batch_images"
    CATEGORY = "image/batch"

    def batch_images(self, images, align=16, width=0, height=0, masks=None, fill_image="#000000", fill_mask=0.0):
        return batch_image_mask_list(images, align, width, height, masks, fill_image, fill_mask)



class ImageRecoverBatchNode:
    """恢复节点 - 把 Batch 后的图像和 mask 恢复为原始尺寸的 List
    image: [1, H, W, 3]
    mask:  [1, H, W]
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "batch_info": ("BATCH_INFO",),
            },
            "optional": {
                "mask": ("MASK",),
            }
        }

    OUTPUT_IS_LIST = (True, True)

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("images", "masks")
    FUNCTION = "recover"
    CATEGORY = "image/batch"

    def recover(self, image, batch_info, mask=None):
        return recover_batch(image, batch_info, mask)
    
class SnapshotCaptureNode:
    """Capture screenshot from desktop with region selection. Supports Previous cached image."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "cached_image": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "Snapshot/xxx.png (auto updated)"
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "capture_image"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(cls, cached_image="", **kwargs):
        # 使用 nan 让节点在 cached_image 变化时也能触发更新
        return float("nan")

    def capture_image(self, cached_image, unique_id):
        try:
            import os
            import sys
            import time
            import numpy as np
            import pyautogui
            import folder_paths
            from PIL import Image

            try:
                import torch
            except ImportError:
                torch = None

            from server import PromptServer  # 用于更新 widget

            from PySide6.QtCore import (
                Qt, QRect, QPoint, QPropertyAnimation,
                QEasingCurve, QEventLoop, Signal,
            )
            from PySide6.QtGui import (
                QColor, QPainter, QPen, QGuiApplication,
                QPixmap, QImage, QRegion,
            )
            from PySide6.QtWidgets import (
                QApplication, QWidget, QPushButton,
                QHBoxLayout, QVBoxLayout, QLabel,
            )
        except ImportError as e:
            raise ImportError(
                "SnapshotCaptureNode requires: PySide6, pyautogui, pillow\n"
                "Install with: pip install PySide6 pyautogui pillow"
            ) from e

        # ====================== 准备目录 ======================
        input_dir = folder_paths.get_input_directory()
        snapshot_dir = os.path.join(input_dir, "Snapshot")
        os.makedirs(snapshot_dir, exist_ok=True)

        app = QApplication.instance()
        owns_app = app is None
        if app is None:
            app = QApplication(sys.argv)

        # ====================== FloatingCapturePanel (新增 Previous 按钮) ======================
        class FloatingCapturePanel(QWidget):
            closed_with_action = Signal(str)  # 传递 action: "capture", "previous", "cancel"

            def __init__(self, current_cached=""):
                super().__init__()
                self.action = "cancel"
                self._drag_pos = None
                self._final_pos = None

                self.setWindowFlags(
                    Qt.FramelessWindowHint |
                    Qt.WindowStaysOnTopHint |
                    Qt.Tool |
                    Qt.NoDropShadowWindowHint
                )
                self.setAttribute(Qt.WA_TranslucentBackground, True)
                self.setFixedSize(320, 150)

                self._build_ui(current_cached)
                self._update_mask()
                self._move_to_primary_screen_bottom_right()
                self._play_spawn_animation()
                self._remove_windows_shadow()

            def _build_ui(self, current_cached):
                root = QVBoxLayout(self)
                root.setContentsMargins(0, 0, 0, 0)
                root.setSpacing(0)

                self.card = QWidget(self)
                self.card.setObjectName("captureCard")

                card_layout = QVBoxLayout(self.card)
                card_layout.setContentsMargins(16, 16, 16, 16)
                card_layout.setSpacing(12)

                title = QLabel("屏幕截图")
                title.setObjectName("titleLabel")

                tip = QLabel("点击 Shot 框选截图\nPrevious 加载上次缓存")
                tip.setObjectName("tipLabel")

                row = QHBoxLayout()
                row.setContentsMargins(0, 0, 0, 0)
                row.setSpacing(8)

                self.shot_btn = QPushButton("Shot")
                self.shot_btn.setObjectName("shotBtn")
                self.shot_btn.clicked.connect(self.on_capture_click)

                self.prev_btn = QPushButton("Previous")
                self.prev_btn.setObjectName("prevBtn")
                self.prev_btn.clicked.connect(self.on_previous_click)
                if not current_cached:
                    self.prev_btn.setEnabled(False)

                self.cancel_btn = QPushButton("Cancel")
                self.cancel_btn.setObjectName("cancelBtn")
                self.cancel_btn.clicked.connect(self.on_exit_click)

                row.addWidget(self.shot_btn, 1)
                row.addWidget(self.prev_btn, 1)
                row.addWidget(self.cancel_btn, 1)

                card_layout.addWidget(title)
                card_layout.addWidget(tip)
                card_layout.addLayout(row)

                root.addWidget(self.card)

                self.setStyleSheet("""
                    QWidget#captureCard {
                        background: rgba(18, 18, 20, 245);
                        border-radius: 10px;
                    }
                    QLabel#titleLabel {
                        color: white;
                        font-size: 15px;
                        font-weight: 700;
                    }
                    QLabel#tipLabel {
                        color: rgba(255, 255, 255, 160);
                        font-size: 12px;
                    }
                    QPushButton {
                        border: none;
                        border-radius: 8px;
                        min-height: 36px;
                        padding: 0 14px;
                        font-size: 13px;
                        font-weight: 600;
                        color: white;
                        background: #2C2C2E;
                    }
                    QPushButton#shotBtn {
                        background: #0A84FF;
                    }
                    QPushButton#shotBtn:hover { background: #3395FF; }
                    QPushButton#shotBtn:pressed { background: #006FE8; }
                    QPushButton#prevBtn {
                        background: #58585C;
                    }
                    QPushButton#prevBtn:hover { background: #6E6E73; }
                    QPushButton#prevBtn:pressed { background: #48484C; }
                    QPushButton#cancelBtn:hover { background: #3A3A3C; }
                    QPushButton#cancelBtn:pressed { background: #242426; }
                """)

            def _update_mask(self):
                self.setMask(QRegion(self.rect()))

            def resizeEvent(self, event):
                super().resizeEvent(event)
                self._update_mask()

            def showEvent(self, event):
                super().showEvent(event)
                self._update_mask()

            def paintEvent(self, event):
                painter = QPainter(self)
                painter.setRenderHint(QPainter.Antialiasing, True)
                pen = QPen(QColor(10, 132, 255), 2)
                painter.setPen(pen)
                painter.setBrush(Qt.NoBrush)
                rect = self.rect().adjusted(1, 1, -1, -1)
                painter.drawRect(rect)

            def _move_to_primary_screen_bottom_right(self):
                screen = QGuiApplication.primaryScreen()
                geo = screen.availableGeometry()
                margin = 24
                x = geo.x() + geo.width() - self.width() - margin
                y = geo.y() + geo.height() - self.height() - margin
                self._final_pos = QPoint(x, y)
                self.move(x, y)

            def _play_spawn_animation(self):
                start_pos = QPoint(self._final_pos.x(), self._final_pos.y() + 30)
                self.move(start_pos)
                anim = QPropertyAnimation(self, b"pos", self)
                anim.setDuration(220)
                anim.setStartValue(start_pos)
                anim.setEndValue(self._final_pos)
                anim.setEasingCurve(QEasingCurve.OutCubic)
                anim.start()

            def _remove_windows_shadow(self):
                try:
                    import ctypes
                    hwnd = int(self.winId())
                    DWMWA_NCRENDERING_POLICY = 2
                    DWMNCRP_DISABLED = 1
                    ctypes.windll.dwmapi.DwmSetWindowAttribute(
                        hwnd, DWMWA_NCRENDERING_POLICY,
                        ctypes.byref(ctypes.c_uint(DWMNCRP_DISABLED)), 
                        ctypes.sizeof(ctypes.c_uint)
                    )
                except:
                    pass

            def on_capture_click(self):
                self.action = "capture"
                self.close()

            def on_previous_click(self):
                self.action = "previous"
                self.close()

            def on_exit_click(self):
                self.action = "cancel"
                self.close()

            def closeEvent(self, event):
                self.closed_with_action.emit(self.action)
                super().closeEvent(event)

            # 拖拽支持保持不变
            def mousePressEvent(self, event):
                if event.button() == Qt.LeftButton:
                    child = self.childAt(event.position().toPoint())
                    if isinstance(child, QPushButton):
                        event.ignore()
                        return
                    self._drag_pos = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
                    event.accept()

            def mouseMoveEvent(self, event):
                if self._drag_pos is not None and event.buttons() & Qt.LeftButton:
                    self.move(event.globalPosition().toPoint() - self._drag_pos)
                    self._final_pos = self.pos()
                    event.accept()

            def mouseReleaseEvent(self, event):
                self._drag_pos = None
                event.accept()

        # ====================== ScreenshotOverlay (保持原逻辑，略微优化) ======================
        class QImageWrapper:
            @staticmethod
            def pil_to_qpixmap(pil_image):
                from PIL.ImageQt import ImageQt
                qt_image = ImageQt(pil_image.convert("RGBA"))
                if isinstance(qt_image, QImage):
                    return QPixmap.fromImage(qt_image)
                return QPixmap.fromImage(QImage(qt_image))

        class ScreenshotOverlay(QWidget):
            closed_with_action = Signal()

            def __init__(self):
                super().__init__()
                self.start_point = QPoint()
                self.end_point = QPoint()
                self.selecting = False
                self.captured = False
                self.image = None  # PIL Image

                screens = QGuiApplication.screens()
                left = min(s.geometry().left() for s in screens)
                top = min(s.geometry().top() for s in screens)
                right = max(s.geometry().right() for s in screens)
                bottom = max(s.geometry().bottom() for s in screens)
                self.virtual_rect = QRect(left, top, right - left + 1, bottom - top + 1)

                self.setGeometry(self.virtual_rect)
                self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool)
                self.setAttribute(Qt.WA_TranslucentBackground, True)
                self.setCursor(Qt.CrossCursor)
                self.setMouseTracking(True)
                self.setFocusPolicy(Qt.StrongFocus)

                primary_screen = QGuiApplication.primaryScreen()
                self.dpr = float(primary_screen.devicePixelRatio()) if primary_screen else 1.0

                full_img = pyautogui.screenshot(
                    region=(
                        int(round(self.virtual_rect.x() * self.dpr)),
                        int(round(self.virtual_rect.y() * self.dpr)),
                        int(round(self.virtual_rect.width() * self.dpr)),
                        int(round(self.virtual_rect.height() * self.dpr)),
                    )
                )
                self.full_pil = full_img
                self.background = QImageWrapper.pil_to_qpixmap(full_img)

            def paintEvent(self, event):
                painter = QPainter(self)
                painter.setRenderHint(QPainter.Antialiasing, True)

                # 背景 + 暗遮罩
                painter.drawPixmap(self.rect(), self.background)
                painter.fillRect(self.rect(), QColor(8, 8, 10, 110))

                if self.selecting or self.captured:
                    rect = QRect(self.start_point, self.end_point).normalized()

                    # 高亮选中区域
                    painter.save()
                    painter.setClipRect(rect)
                    painter.drawPixmap(self.rect(), self.background)
                    painter.restore()

                    # 直角蓝色框选
                    pen = QPen(QColor(10, 132, 255), 2)
                    painter.setPen(pen)
                    painter.setBrush(QColor(10, 132, 255, 30))
                    painter.drawRect(rect)

            def keyPressEvent(self, event):
                if event.key() == Qt.Key_Escape:
                    self.close()

            def mousePressEvent(self, event):
                if event.button() == Qt.LeftButton:
                    self.start_point = event.position().toPoint()
                    self.end_point = self.start_point
                    self.selecting = True
                    self.update()
                elif event.button() == Qt.RightButton:
                    self.close()

            def mouseMoveEvent(self, event):
                if self.selecting:
                    self.end_point = event.position().toPoint()
                    self.update()

            def mouseReleaseEvent(self, event):
                if event.button() == Qt.LeftButton and self.selecting:
                    self.end_point = event.position().toPoint()
                    self.selecting = False

                    rect = QRect(self.start_point, self.end_point).normalized()
                    if rect.width() > 10 and rect.height() > 10:
                        left_px = int(round(rect.x() * self.dpr))
                        top_px = int(round(rect.y() * self.dpr))
                        right_px = int(round((rect.x() + rect.width()) * self.dpr))
                        bottom_px = int(round((rect.y() + rect.height()) * self.dpr))

                        self.image = self.full_pil.crop((left_px, top_px, right_px, bottom_px))
                        self.captured = True

                    self.close()

            def closeEvent(self, event):
                self.closed_with_action.emit()
                super().closeEvent(event)


        # ====================== 执行流程 ======================
        def wait_for_close(widget, signal_name="closed_with_action"):
            loop = QEventLoop()
            getattr(widget, signal_name).connect(loop.quit)
            loop.exec()

        panel = FloatingCapturePanel(current_cached=cached_image)
        panel.show()
        panel.raise_()
        panel.activateWindow()
        wait_for_close(panel, "closed_with_action")

        action = panel.action if hasattr(panel, 'action') else "cancel"

        if action == "cancel":
            if owns_app:
                app.quit()
            raise ValueError("Capture canceled by user")

        if action == "previous":
            if not cached_image or not os.path.exists(os.path.join(input_dir, cached_image)):
                if owns_app:
                    app.quit()
                raise ValueError("No previous image cached or file not found")
            
            # 加载 Previous
            full_path = os.path.join(input_dir, cached_image)
            pil_img = Image.open(full_path).convert("RGB")
            
            img_array = np.array(pil_img).astype(np.float32) / 255.0
            img_array = np.expand_dims(img_array, axis=0)
            img_tensor = torch.from_numpy(img_array) if torch is not None else img_array

            if owns_app:
                app.quit()
            return (img_tensor,)

        # action == "capture"
        overlay = ScreenshotOverlay()
        overlay.show()
        overlay.raise_()
        overlay.activateWindow()
        wait_for_close(overlay)

        if not overlay.captured or overlay.image is None:
            if owns_app:
                app.quit()
            raise ValueError("No screenshot captured")

        # ====================== 保存到 input/Snapshot 并缓存路径 ======================
        timestamp = int(time.time() * 1000)
        rel_path = f"Snapshot/capture_{timestamp}.png"
        full_save_path = os.path.join(input_dir, rel_path)

        overlay.image.save(full_save_path, "PNG")

        print(f"[SnapshotCapture] Image saved to: {full_save_path}")

        # 更新 cached_image widget 到前端
        try:
            PromptServer.instance.send_sync(
                "kolid-comfy-widget-set",
                {
                    "node_id": unique_id,
                    "widget_name": "cached_image",
                    "type": "STRING",
                    "value": rel_path
                }
            )
        except Exception as e:
            print(f"[SnapshotCapture] Warning: Failed to update cached_image widget: {e}")

        # ====================== 转为 ComfyUI IMAGE ======================
        img_array = np.array(overlay.image)
        if len(img_array.shape) == 2:
            img_array = np.stack([img_array] * 3, axis=-1)
        elif img_array.shape[2] == 4:
            img_array = img_array[:, :, :3]

        img_array = img_array.astype(np.float32) / 255.0
        img_array = np.expand_dims(img_array, axis=0)

        img_tensor = torch.from_numpy(img_array) if torch is not None else img_array

        if owns_app:
            app.quit()

        return (img_tensor,)


class ImageDetectContentNode:
    """
    自定义节点：ImageDetectContentNode
    输入：image
    输出：mask（内容区域为1，边框区域为0）
    功能：智能检测图片是否有均匀边框（参考四角颜色），自动返回内容遮罩
    """
    
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE",),
                "tolerance": ("FLOAT", {
                    "default": 0.06,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.005,
                    "display": "number"
                }),  # 内容与边框颜色的容差
                "border_threshold": ("FLOAT", {
                    "default": 0.08,
                    "min": 0.0,
                    "max": 0.5,
                    "step": 0.01,
                    "display": "number"
                }),  # 判断是否有边框的严格程度（越小越严格）
            }
        }

    RETURN_TYPES = ("MASK", "BOOLEAN")
    RETURN_NAMES = ("mask", "has_border")
    FUNCTION = "detect_content"
    CATEGORY = "image/processing"

    def detect_content(self, image, tolerance, border_threshold):
        batch_size, height, width, channels = image.shape
        masks = []
        has_borders = []
        
        for b in range(batch_size):
            img = image[b]  # [H, W, C]
            
            if channels == 4:
                rgb = img[:, :, :3]
            else:
                rgb = img
            
            # 取四角颜色（每个角取 3x3 区域平均，避免单个像素噪声）
            def get_corner_color(y, x, size=3):
                half = size // 2
                patch = rgb[max(0, y-half):min(height, y+half+1), 
                           max(0, x-half):min(width, x+half+1)]
                return patch.mean(dim=(0, 1))
            
            corners = [
                get_corner_color(0, 0),           # 左上
                get_corner_color(0, width-1),     # 右上
                get_corner_color(height-1, 0),    # 左下
                get_corner_color(height-1, width-1)  # 右下
            ]
            
            border_color = torch.stack(corners).mean(dim=0)  # [3]
            
            # 计算每个像素与边框颜色的差异
            diff = torch.norm(rgb - border_color, dim=-1)  # [H, W]
            
            # 初步内容区域（差异 > tolerance）
            content_mask = (diff > tolerance).float()
            
            # === 判断是否有边框 ===
            # 1. 四角颜色是否接近（方差小）
            corner_diffs = torch.stack([torch.norm(c - border_color) for c in corners])
            corners_consistent = corner_diffs.max() < border_threshold * 2.0
            
            # 2. 边缘是否有大量接近边框色的像素
            border_pixels = (diff < tolerance).float()
            edge_border_ratio = 0.0
            if height > 10 and width > 10:
                top_edge = border_pixels[0:5, :].mean()
                bottom_edge = border_pixels[-5:, :].mean()
                left_edge = border_pixels[:, 0:5].mean()
                right_edge = border_pixels[:, -5:].mean()
                edge_border_ratio = (top_edge + bottom_edge + left_edge + right_edge) / 4.0
            
            has_border = corners_consistent and (edge_border_ratio > 0.4)
            
            if not has_border:
                # 无边框 → 返回全白遮罩（整图都是内容）
                mask = torch.ones((height, width), dtype=torch.float32, device=image.device)
            else:
                # 有边框 → 找到内容的最小包围矩形
                if content_mask.sum() == 0:
                    mask = torch.zeros((height, width), dtype=torch.float32, device=image.device)
                else:
                    rows = torch.any(content_mask, dim=1).nonzero(as_tuple=True)[0]
                    cols = torch.any(content_mask, dim=0).nonzero(as_tuple=True)[0]
                    
                    if len(rows) == 0 or len(cols) == 0:
                        mask = torch.zeros((height, width), dtype=torch.float32, device=image.device)
                    else:
                        min_row = max(0, rows.min().item() - 2)   # 轻微扩展避免裁太紧
                        max_row = min(height, rows.max().item() + 3)
                        min_col = max(0, cols.min().item() - 2)
                        max_col = min(width, cols.max().item() + 3)
                        
                        mask = torch.zeros((height, width), dtype=torch.float32, device=image.device)
                        mask[min_row:max_row, min_col:max_col] = 1.0
            
            masks.append(mask)
            has_borders.append(has_border)
        
        output_mask = torch.stack(masks, dim=0)
        output_has_border = torch.tensor(has_borders, dtype=torch.bool, device=image.device)
        
        return (output_mask, output_has_border)

def handleMask(serverHandler, set_event):
    # Handle mask drawing data
    content_length = int(serverHandler.headers['Content-Length'])
    post_data = serverHandler.rfile.read(content_length)
    data = json.loads(post_data)
    
    if serverHandler.server_instance:
        # Get mask data
        rawMask_base64 = data.get('mask')
        # Extract base64 data
        base64_data = rawMask_base64.split(',')[1]
        mask_data = base64.b64decode(base64_data)
        
        # Decode to numpy
        nparr = np.frombuffer(mask_data, np.uint8)
        mask_bgra = cv2.imdecode(nparr, cv2.IMREAD_UNCHANGED)  # May have alpha channel
        
        if mask_bgra is None:
            serverHandler.send_error(500, "Failed to decode mask image")
            return
        
        # Convert to grayscale: if has alpha, use it; otherwise use red channel intensity
        if mask_bgra.ndim == 3:
            if mask_bgra.shape[2] == 4:
                # Use alpha channel as mask intensity
                mask_gray = mask_bgra[:, :, 3].astype(np.float32) / 255.0
            else:
                # Use max of RGB channels
                mask_gray = mask_bgra[:, :, :3].max(axis=2).astype(np.float32) / 255.0
        else:
            mask_gray = mask_bgra.astype(np.float32) / 255.0
        
        # Get original image dimensions
        original_image = serverHandler.server_instance.get_image()
        if hasattr(original_image, 'shape'):
            if len(original_image.shape) == 4:
                _, orig_h, orig_w, _ = original_image.shape
            elif len(original_image.shape) == 3:
                orig_h, orig_w, _ = original_image.shape
            else:
                orig_h, orig_w = mask_gray.shape
        else:
            orig_h, orig_w = mask_gray.shape
        
        # Resize mask to match original image dimensions
        if mask_gray.shape[0] != orig_h or mask_gray.shape[1] != orig_w:
            mask_gray = cv2.resize(mask_gray, (orig_w, orig_h), interpolation=cv2.INTER_LINEAR)
        
        # Binarize: any painted area becomes 1.0
        mask_gray = (mask_gray > 0).astype(np.float32)
        
        # Add batch dimension -> [1, H, W]
        mask_array = np.expand_dims(mask_gray, axis=0)
        
        # Validate loop token to prevent stale iframe submissions
        loop = data.get('loop', '0')
        expected_loop = getattr(serverHandler.server_instance, '_expected_loop', '0')
        if loop != expected_loop:
            serverHandler.send_response(400)
            serverHandler.send_header('Content-type', 'application/json')
            serverHandler.send_header("Access-Control-Allow-Origin", "*")
            serverHandler.end_headers()
            serverHandler.wfile.write(json.dumps({'error': f'stale loop: expected {expected_loop}, got {loop}'}).encode('utf-8'))
            return

        # Convert to torch tensor
        loop_index = int(loop) if loop is not None else 0
        try:
            import torch
            serverHandler.server_instance.set_mask(torch.from_numpy(mask_array).float(), loop_index=loop_index)
        except ImportError:
            serverHandler.server_instance.set_mask(mask_array.astype(np.float32), loop_index=loop_index)
        
        serverHandler.send_response(200)
        serverHandler.send_header('Content-type', 'application/json')
        serverHandler.send_header("Access-Control-Allow-Origin", "*")
        serverHandler.end_headers()
        serverHandler.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
        
        # Signal that mask is ready
        if set_event:
            serverHandler.server_instance.screenshot_event.set()
    else:
        serverHandler.send_error(500, "Server error")


def handleDetect(serverHandler):
    """Handle detector request and return mask as base64 for frontend overlay."""
    content_length = int(serverHandler.headers['Content-Length'])
    post_data = serverHandler.rfile.read(content_length)
    data = json.loads(post_data)
    
    instance = serverHandler.server_instance
    if not instance or instance.detector is None:
        serverHandler.send_error(400, "No detector available")
        return
    
    try:
        # Use frontend params directly (all parameters are controlled from the web UI)
        params = {
            'threshold': data.get('threshold', 0.5),
            'dilation': data.get('dilation', 4),
            'crop_factor': data.get('crop_factor', 1.5),
            'drop_size': data.get('drop_size', 0),
            'prompt': data.get('prompt', ''),
            'fill_mask': data.get('fill_mask', True),
        }
        
        image = instance.get_image()
        # Ensure image is a single image tensor for detect_mask
        if hasattr(image, 'shape') and len(image.shape) == 4:
            # Use first image in batch
            single_image = image[0]
        else:
            single_image = image
        
        # Run detection
        mask_list = detect_mask(
            detector=instance.detector,
            image=single_image,
            threshold=params['threshold'],
            dilation=params['dilation'],
            crop_factor=params['crop_factor'],
            drop_size=params['drop_size'],
            prompt=params['prompt'],
            fill_mask=params['fill_mask'],
        )
        
        if mask_list is None or len(mask_list) == 0:
            serverHandler.send_response(200)
            serverHandler.send_header('Content-type', 'application/json')
            serverHandler.send_header("Access-Control-Allow-Origin", "*")
            serverHandler.end_headers()
            serverHandler.wfile.write(json.dumps({'mask': None, 'message': 'No objects detected'}).encode('utf-8'))
            return
        
        # Combine masks (OR)
        combined = combine_masks(mask_list, mode="max")
        # Ensure shape is [1, H, W]
        if combined.dim() == 2:
            combined = combined.unsqueeze(0)
        
        # Convert to base64 overlay image
        mask_base64 = detector_mask_to_base64(combined)
        
        serverHandler.send_response(200)
        serverHandler.send_header('Content-type', 'application/json')
        serverHandler.send_header("Access-Control-Allow-Origin", "*")
        serverHandler.end_headers()
        serverHandler.wfile.write(json.dumps({'mask': mask_base64}).encode('utf-8'))
        
    except Exception as e:
        import traceback
        print(f"[SnapshotMask] Detection failed: {e}")
        traceback.print_exc()
        serverHandler.send_response(500)
        serverHandler.send_header('Content-type', 'application/json')
        serverHandler.send_header("Access-Control-Allow-Origin", "*")
        serverHandler.end_headers()
        serverHandler.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))


def handleGrow(serverHandler):
    """Handle grow request: dilate the provided mask and return overlay base64."""
    content_length = int(serverHandler.headers['Content-Length'])
    post_data = serverHandler.rfile.read(content_length)
    data = json.loads(post_data)
    
    try:
        rawMask_base64 = data.get('mask')
        grow = int(data.get('grow', 0))
        
        if not rawMask_base64 or grow <= 0:
            serverHandler.send_response(200)
            serverHandler.send_header('Content-type', 'application/json')
            serverHandler.send_header("Access-Control-Allow-Origin", "*")
            serverHandler.end_headers()
            serverHandler.wfile.write(json.dumps({'mask': rawMask_base64}).encode('utf-8'))
            return
        
        # Extract base64 data
        base64_data = rawMask_base64.split(',')[1]
        mask_data = base64.b64decode(base64_data)
        
        # Decode to numpy (RGBA)
        nparr = np.frombuffer(mask_data, np.uint8)
        mask_bgra = cv2.imdecode(nparr, cv2.IMREAD_UNCHANGED)
        
        if mask_bgra is None:
            serverHandler.send_error(500, "Failed to decode mask image")
            return
        
        # Extract alpha channel as binary mask
        if mask_bgra.ndim == 3 and mask_bgra.shape[2] == 4:
            mask_gray = (mask_bgra[:, :, 3] > 0).astype(np.uint8) * 255
        else:
            mask_gray = cv2.cvtColor(mask_bgra, cv2.COLOR_BGR2GRAY)
            mask_gray = (mask_gray > 0).astype(np.uint8) * 255
        
        # Dilate
        k = grow * 2 + 1
        kernel = np.ones((k, k), np.uint8)
        dilated = cv2.dilate(mask_gray, kernel, iterations=1)
        
        # Convert to red overlay base64
        h, w = dilated.shape
        rgba = np.zeros((h, w, 4), dtype=np.uint8)
        rgba[:, :, 0] = 255
        rgba[:, :, 3] = (dilated > 0).astype(np.uint8) * 153  # alpha 0.6 = 153
        
        _, buffer = cv2.imencode('.png', cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
        base64_str = base64.b64encode(buffer).decode('utf-8')
        result_base64 = f"data:image/png;base64,{base64_str}"
        
        serverHandler.send_response(200)
        serverHandler.send_header('Content-type', 'application/json')
        serverHandler.send_header("Access-Control-Allow-Origin", "*")
        serverHandler.end_headers()
        serverHandler.wfile.write(json.dumps({'mask': result_base64}).encode('utf-8'))
        
    except Exception as e:
        import traceback
        print(f"[SnapshotMask] Grow failed: {e}")
        traceback.print_exc()
        serverHandler.send_response(500)
        serverHandler.send_header('Content-type', 'application/json')
        serverHandler.send_header("Access-Control-Allow-Origin", "*")
        serverHandler.end_headers()
        serverHandler.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))


class SnapshotMaskNodeServer:
    """Temporary HTTP server to serve the mask drawing page and handle mask submission."""

    def __init__(self, image, initial_mask=None, detector=None):
        self._image = image
        self._initial_mask = initial_mask
        self.detector = detector
        # 使用 threading.Lock + _mask_history[] 替代 queue.Queue
        # 每个 loop 的 mask 按索引存储，可随时回溯
        self._mask_lock = threading.Lock()
        self._mask_history = []   # 按索引存储每个循环的 mask
        self._current_mask = None # 最新提交的 mask（用于 peek）
        self.server = None
        self.started = False
        self.screenshot_event = threading.Event()
        self.window_closed = False
        self.browser_url = None
        self._expected_loop = '0'

    def start(self):
        # Find an available port
        class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
            pass
        for port in range(8080, 9000):
            try:
                self.server = ThreadingTCPServer(('localhost', port), self.SnapshotMaskNodeHandler)
                self.server.node_server = self  # each server instance holds its own node server
                self.started = True
                print(f"[SnapshotMask] Server started on port {port}")
                break
            except Exception:
                continue
        
        self.browser_url = f"http://localhost:{port}/mask_node.html"
        
        if not self.started:
            print("[SnapshotMask] Failed to start server")
            return
        
        # Serve forever
        try:
            self.server.serve_forever()
        except Exception:
            pass

    def stop(self):
        if self.server:
            print("[SnapshotMask] Stopping server")
            self.server.shutdown()
            self.server.server_close()

    def clear(self):
        """Clear all stored masks."""
        with self._mask_lock:
            old_hist = [(i, id(m), f"{m.sum().item():.1f}" if m is not None else "None") for i, m in enumerate(self._mask_history)]
            self._mask_history.clear()
            self._current_mask = None
            self._initial_mask = None
        print(f"[MASK-TRACE] SnapshotMaskNodeServer.clear | cleared history was {old_hist}")

    def set_image(self, image):
        self._image = image

    def get_image(self):
        return self._image

    def set_mask(self, mask, loop_index=None):
        with self._mask_lock:
            if loop_index is not None:
                # 确保列表足够长
                while len(self._mask_history) <= loop_index:
                    self._mask_history.append(None)
                # 竞争检测：如果该索引已有 mask，打印日志
                old_at_idx = self._mask_history[loop_index]
                if old_at_idx is not None:
                    print(f"[SnapshotMask] RACE WARNING: overwriting existing mask at index {loop_index}")
                self._mask_history[loop_index] = mask
                hist_status = [(i, id(m), f"{m.sum().item():.1f}" if m is not None else "None") for i, m in enumerate(self._mask_history)]
                print(f"[MASK-TRACE] SnapshotMaskNodeServer.set_mask | loop_index={loop_index} | mask id={id(mask)}, sum={mask.sum().item() if hasattr(mask, 'sum') else 'N/A'} | history={hist_status}")
            else:
                print(f"[MASK-TRACE] SnapshotMaskNodeServer.set_mask | NO loop_index | mask id={id(mask)}, sum={mask.sum().item() if hasattr(mask, 'sum') else 'N/A'}")
            self._current_mask = mask
        if getattr(self, '_on_mask_set', None) is not None:
            try:
                self._on_mask_set(mask, loop_index)
            except Exception as e:
                print(f"[SnapshotMask] _on_mask_set error: {e}")

    def set_expected_loop(self, loop):
        self._expected_loop = str(loop)

    def get_mask_for_loop(self, loop_index):
        """按循环索引获取 mask（返回克隆，防止外部修改）。"""
        with self._mask_lock:
            hist_status = [(i, id(m), f"{m.sum().item():.1f}" if m is not None else "None") for i, m in enumerate(self._mask_history)]
            if 0 <= loop_index < len(self._mask_history):
                mask = self._mask_history[loop_index]
                if mask is not None:
                    cloned = mask.clone()
                    print(f"[MASK-TRACE] SnapshotMaskNodeServer.get_mask_for_loop | loop_index={loop_index} | src id={id(mask)}, sum={mask.sum().item():.1f} | cloned id={id(cloned)} | history={hist_status}")
                    return cloned
            print(f"[MASK-TRACE] SnapshotMaskNodeServer.get_mask_for_loop | loop_index={loop_index} | NOT FOUND | history={hist_status}")
            return None

    def get_latest_mask(self):
        """获取最新提交的 mask（返回克隆）。"""
        with self._mask_lock:
            if self._current_mask is not None:
                return self._current_mask.clone()
            return None

    def peek_latest_mask(self):
        """非消费性读取：返回最新 mask 的引用，供预览接口使用。"""
        with self._mask_lock:
            return self._current_mask

    def set_initial_mask(self, initial_mask):
        self._initial_mask = initial_mask

    def get_initial_mask(self):
        return self._initial_mask

    def wait_for_selection(self):
        """Wait for mask submission indefinitely."""
        if not waitSnapShot(self.screenshot_event):
            raise Exception("Canceled")

    class SnapshotMaskNodeHandler(http.server.SimpleHTTPRequestHandler):
        @property
        def server_instance(self):
            return getattr(self.server, 'node_server', None)

        def do_GET(self):
            path = self.path.split('?')[0]
            if path == '/mask_node.html':
                # Serve the mask_node.html file
                file_path = os.path.join(os.path.dirname(__file__), 'web', 'mask_node.html')
                if os.path.exists(file_path):
                    self.send_response(200)
                    self.send_header('Content-type', 'text/html')
                    self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
                    self.send_header('Pragma', 'no-cache')
                    self.send_header('Expires', '0')
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
            elif path == '/image_data':
                # Serve image data as JSON
                if self.server_instance:
                    try:
                        image_base64 = image_to_base64(self.server_instance.get_image())
                        response = {
                            'image': image_base64
                        }
                        if self.server_instance.get_initial_mask() is not None:
                            response['initial_mask'] = mask_to_base64(self.server_instance.get_initial_mask())
                        # Detector info
                        response['has_detector'] = self.server_instance.detector is not None
                        response_data = json.dumps(response).encode('utf-8')
                        self.send_response(200)
                        self.send_header('Content-type', 'application/json')
                        self.send_header('Content-Length', str(len(response_data)))
                        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
                        self.send_header('Pragma', 'no-cache')
                        self.send_header('Expires', '0')
                        self.end_headers()
                        self.wfile.write(response_data)
                    except Exception as e:
                        self.send_error(500, f"Error processing image data: {e}")
                        return
                else:
                    self.send_error(500, "Server error")
            elif path == '/get_mask':
                # Return current mask as base64 PNG (peek only, do not consume)
                if self.server_instance and self.server_instance.peek_latest_mask() is not None:
                    try:
                        mask_base64 = mask_to_base64(self.server_instance.peek_latest_mask())
                        response = {'mask': mask_base64}
                        response_data = json.dumps(response).encode('utf-8')
                        self.send_response(200)
                        self.send_header('Content-type', 'application/json')
                        self.send_header('Content-Length', str(len(response_data)))
                        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
                        self.send_header('Pragma', 'no-cache')
                        self.send_header('Expires', '0')
                        self.send_header("Access-Control-Allow-Origin", "*")
                        self.end_headers()
                        self.wfile.write(response_data)
                    except Exception as e:
                        self.send_error(500, f"Error encoding mask: {e}")
                else:
                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({'mask': None}).encode('utf-8'))
            else:
                super().do_GET()

        def do_POST(self):
            if self.path == '/mask':
                handleMask(self, True)
            elif self.path == '/detect':
                handleDetect(self)
            elif self.path == '/grow':
                handleGrow(self)
            elif self.path == '/clear':
                if self.server_instance:
                    self.server_instance.clear()
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
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
            # Suppress server logs
            pass


class SnapshotMaskNode:
    """Open an image in a browser, allow user to draw a mask with a brush, and return the mask."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": "Input image to draw mask on",
                }),
            },
            "optional": {
                "mask": ("MASK", {
                    "tooltip": "Optional initial mask to load into the editor",
                }),
                "detector": ("*", {
                    "tooltip": "Optional detector for auto-detection",
                }),
            },
        }

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("mask",)
    FUNCTION = "draw_mask"
    CATEGORY = "Kolid-Toolkit"
    
    @classmethod
    def IS_CHANGED(s):
        return float("nan")

    def draw_mask(self, image, mask=None, detector=None):
        focused_window = None
        if has_win32gui:
            focused_window = win32gui.GetForegroundWindow()

        # Start a temporary HTTP server to serve the mask drawing page
        server = SnapshotMaskNodeServer(image, initial_mask=mask, detector=detector)

        # Use new API: _on_mask_set callback to capture mask
        result_mask = [None]
        def _on_mask_set(m, loop_index=None):
            result_mask[0] = m
        server._on_mask_set = _on_mask_set

        server_thread = threading.Thread(target=server.start)
        server_thread.daemon = True
        server_thread.start()

        start_time = time.time()
        timeout = 10  # 10 seconds timeout
        while not server.started:
            if time.time() - start_time > timeout:
                raise RuntimeError(f"[SnapshotMask] Server startup timeout after {timeout} seconds")
            time.sleep(0.1)

        print(f"[SnapshotMask] Opening browser at: {server.browser_url}")
        webbrowser.open(server.browser_url)

        # Wait for mask to be submitted
        print("[SnapshotMask] Waiting for mask drawing...")
        server.wait_for_selection()

        # Stop the server
        server.stop()

        # Restore window focus
        if has_win32gui and focused_window:
            time.sleep(0.5)
            focus_window(focused_window)

        if server.window_closed or result_mask[0] is None:
            raise ValueError("Window closed without drawing mask")
        
        return (result_mask[0],)


class SnapshotOutpaintMaskNodeServer:
    """Temporary HTTP server to serve the outpaint mask page and handle user confirmation."""

    def __init__(self, image):
        self._image = image
        self.server = None
        self.started = False
        self.confirm_event = threading.Event()
        self.window_closed = False
        self.browser_url = None
        self.result = None

    def start(self):
        class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
            pass
        for port in range(8080, 9000):
            try:
                self.server = ThreadingTCPServer(('localhost', port), self.OutpaintMaskHandler)
                self.server.node_server = self
                self.started = True
                print(f"[SnapshotOutpaintMask] Server started on port {port}")
                break
            except Exception:
                continue

        self.browser_url = f"http://localhost:{port}/outpaint_mask_node.html"

        if not self.started:
            print("[SnapshotOutpaintMask] Failed to start server")
            return

        try:
            self.server.serve_forever()
        except Exception:
            pass

    def stop(self):
        if self.server:
            print("[SnapshotOutpaintMask] Stopping server")
            self.server.shutdown()
            self.server.server_close()

    def wait_for_selection(self):
        if not waitSnapShot(self.confirm_event):
            raise Exception("Canceled")

    class OutpaintMaskHandler(http.server.SimpleHTTPRequestHandler):
        @property
        def server_instance(self):
            return getattr(self.server, 'node_server', None)

        def do_GET(self):
            path = self.path.split('?')[0]
            if path == '/outpaint_mask_node.html':
                file_path = os.path.join(os.path.dirname(__file__), 'web', 'outpaint_mask_node.html')
                if os.path.exists(file_path):
                    self.send_response(200)
                    self.send_header('Content-type', 'text/html')
                    self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
                    self.send_header('Pragma', 'no-cache')
                    self.send_header('Expires', '0')
                    self.end_headers()
                    with open(file_path, 'rb') as f:
                        self.wfile.write(f.read())
                else:
                    self.send_error(404, "File not found")
            elif path == '/image_data':
                if self.server_instance:
                    try:
                        image_base64 = image_to_base64(self.server_instance.get_image())
                        response = {'image': image_base64}
                        response_data = json.dumps(response).encode('utf-8')
                        self.send_response(200)
                        self.send_header('Content-type', 'application/json')
                        self.send_header('Content-Length', str(len(response_data)))
                        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
                        self.send_header('Pragma', 'no-cache')
                        self.send_header('Expires', '0')
                        self.end_headers()
                        self.wfile.write(response_data)
                    except Exception as e:
                        self.send_error(500, f"Error processing image data: {e}")
                        return
                else:
                    self.send_error(500, "Server error")
            else:
                super().do_GET()

        def do_POST(self):
            if self.path == '/confirm':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    self.server_instance.result = {
                        'top': data.get('top', 0),
                        'bottom': data.get('bottom', 0),
                        'left': data.get('left', 0),
                        'right': data.get('right', 0),
                    }
                    self.server_instance.confirm_event.set()

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
            elif self.path == '/window_closed':
                if self.server_instance:
                    self.server_instance.window_closed = True
                    self.server_instance.confirm_event.set()
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
            else:
                super().do_POST()

        def log_message(self, format, *args):
            pass

    def get_image(self):
        return self._image


class SnapshotOutpaintMaskNode:
    """Open an image in a browser, allow user to set outpaint padding, and return the expanded image and mask."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": "Input image to set outpaint area on",
                }),
            },
        }

    RETURN_TYPES = ("MASK", "IMAGE")
    RETURN_NAMES = ("mask", "image")
    FUNCTION = "outpaint_mask"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(s):
        return float("nan")

    def outpaint_mask(self, image):
        focused_window = None
        if has_win32gui:
            focused_window = win32gui.GetForegroundWindow()

        # Start a temporary HTTP server to serve the outpaint page
        server = SnapshotOutpaintMaskNodeServer(image)

        server_thread = threading.Thread(target=server.start)
        server_thread.daemon = True
        server_thread.start()

        start_time = time.time()
        timeout = 10
        while not server.started:
            if time.time() - start_time > timeout:
                raise RuntimeError(f"[SnapshotOutpaintMask] Server startup timeout after {timeout} seconds")
            time.sleep(0.1)

        print(f"[SnapshotOutpaintMask] Opening browser at: {server.browser_url}")
        webbrowser.open(server.browser_url)

        # Wait for user confirmation
        print("[SnapshotOutpaintMask] Waiting for user confirmation...")
        server.wait_for_selection()

        # Stop the server
        server.stop()

        # Restore window focus
        if has_win32gui and focused_window:
            time.sleep(0.5)
            focus_window(focused_window)

        if server.window_closed or server.result is None:
            raise ValueError("Window closed without confirming outpaint")

        # Process the result
        top = server.result['top']
        bottom = server.result['bottom']
        left = server.result['left']
        right = server.result['right']

        # Get original dimensions
        if len(image.shape) == 4:
            b, orig_h, orig_w, c = image.shape
        elif len(image.shape) == 3:
            b, orig_h, orig_w = image.shape
            c = 3
        else:
            raise ValueError(f"Unexpected image shape: {image.shape}")

        new_h = orig_h + top + bottom
        new_w = orig_w + left + right

        print(f"[SnapshotOutpaintMask] Original: {orig_w}x{orig_h}, New: {new_w}x{new_h}, padding: T={top}, B={bottom}, L={left}, R={right}")

        # Create expanded image (black padding)
        if len(image.shape) == 4:
            expanded_image = torch.zeros((b, new_h, new_w, c), dtype=image.dtype, device=image.device)
            expanded_image[:, top:top + orig_h, left:left + orig_w, :] = image
        else:
            expanded_image = torch.zeros((b, new_h, new_w), dtype=image.dtype, device=image.device)
            expanded_image[:, top:top + orig_h, left:left + orig_w] = image

        # Create mask: new area = 1, original area = 0
        mask = torch.ones((b, new_h, new_w), dtype=torch.float32, device=image.device)
        mask[:, top:top + orig_h, left:left + orig_w] = 0.0

        return (mask, expanded_image)
