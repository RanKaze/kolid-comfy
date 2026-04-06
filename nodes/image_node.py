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
import queue
import io
from PIL import Image
import cv2
import comfy.model_management as mm
import signal
import shutil
import torch.nn.functional as F
import pyautogui
from PySide6.QtCore import Qt, QRect, QPoint, QPropertyAnimation, QEasingCurve
from ..libs.image_utils import crop_mask, recover_crop, hex_to_rgb, batch_images, recover_batch, limit_pixels, recover_size
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
                    "min": 1000,
                    "max": 100000000,
                    "step": 1000,
                    "tooltip": "Maximum allowed pixel count"
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

    def limit_pixels(self, image, pixels, mask=None):
        """Limit image pixel count by resizing if needed."""
        try:
            print("[ImageLimitPixelNode] Calling limit_pixels from image_utils")
            return limit_pixels(image, pixels, mask)
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
    FUNCTION = "recover_crop"
    CATEGORY = "Kolid-Toolkit"

    def recover_crop(self, background, image, crop_info, recover_method, mask=None):
        try:
            print(f"[ImageRecoverCropNode] Calling recover_crop from image_util")
            return recover_crop(background, image, crop_info, recover_method, mask)
        except Exception as e:
            raise Exception(f"Failed to recover cropped image: {e}")



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
        return batch_images(images, align, width, height, masks, fill_image, fill_mask)



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