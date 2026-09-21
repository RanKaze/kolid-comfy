"""
SnapshotDrawNode - 交互式绘画节点
输入 image，输出 image。通过浏览器界面在图片上进行自由绘画
（笔刷 / 橡皮 / 色盘 / 吸色）。逻辑与 UI 参考 SnapshotMaskNode。
"""

import os
import json
import base64
import threading
import http.server
import socketserver
import webbrowser
import time

import numpy as np
import cv2
import torch

from .image_node import image_to_base64, waitSnapShot


# =============================================================================
# SnapshotDrawServer - 参考 SnapshotMaskNodeServer 的结构
# =============================================================================
class SnapshotDrawServer:
    """Temporary HTTP server to serve the drawing page and handle draw submission."""

    def __init__(self, image):
        self._image = image
        self._draw_lock = threading.Lock()
        self._current_draw = None  # 最新合成图 tensor (1, H, W, C)
        self.server = None
        self.started = False
        self.screenshot_event = threading.Event()
        self.window_closed = False
        self.browser_url = None
        self._on_draw_set = None

    def start(self):
        # Find an available port
        class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
            pass
        for port in range(8080, 9000):
            try:
                self.server = ThreadingTCPServer(('localhost', port), self.SnapshotDrawNodeHandler)
                self.server.node_server = self  # each server instance holds its own node server
                self.started = True
                print(f"[SnapshotDraw] Server started on port {port}")
                break
            except Exception:
                continue

        self.browser_url = f"http://localhost:{port}/draw_node.html"

        if not self.started:
            print("[SnapshotDraw] Failed to start server")
            return

        # Serve forever
        try:
            self.server.serve_forever()
        except Exception:
            pass

    def stop(self):
        if self.server:
            print("[SnapshotDraw] Stopping server")
            self.server.shutdown()
            self.server.server_close()

    def clear(self):
        """Clear stored draw."""
        with self._draw_lock:
            self._current_draw = None

    def set_image(self, image):
        self._image = image

    def get_image(self):
        return self._image

    def set_draw(self, draw):
        with self._draw_lock:
            self._current_draw = draw
        if getattr(self, '_on_draw_set', None) is not None:
            try:
                self._on_draw_set(draw)
            except Exception as e:
                print(f"[SnapshotDraw] _on_draw_set error: {e}")

    def get_draw(self):
        """获取最新绘制结果（返回克隆）。"""
        with self._draw_lock:
            if self._current_draw is not None:
                return self._current_draw.clone()
            return None

    def peek_draw(self):
        """非消费性读取：返回最新绘制结果的引用，供预览接口使用。"""
        with self._draw_lock:
            return self._current_draw

    def wait_for_selection(self):
        """Wait for draw submission indefinitely."""
        if not waitSnapShot(self.screenshot_event):
            raise Exception("Canceled")

    class SnapshotDrawNodeHandler(http.server.SimpleHTTPRequestHandler):
        @property
        def server_instance(self):
            return getattr(self.server, 'node_server', None)

        def _send_json(self, data, status=200):
            body = json.dumps(data).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split('?')[0]
            if path in ('/', '/draw_node.html'):
                # Serve the draw_node.html file
                file_path = os.path.join(os.path.dirname(__file__), 'web', 'draw_node.html')
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
                # Serve image data as JSON
                if self.server_instance:
                    try:
                        response = {
                            'image': image_to_base64(self.server_instance.get_image())
                        }
                        # 返回当前绘制结果（合成图），供前端恢复绘画层
                        draw = self.server_instance.peek_draw()
                        if draw is not None:
                            img = self.server_instance.get_image()
                            img_h, img_w = (img.shape[1], img.shape[2]) if hasattr(img, 'shape') and img.ndim == 4 else (img.shape[0], img.shape[1]) if hasattr(img, 'shape') else (0, 0)
                            draw_h, draw_w = (draw.shape[1], draw.shape[2]) if hasattr(draw, 'shape') and draw.ndim == 4 else (draw.shape[0], draw.shape[1]) if hasattr(draw, 'shape') else (0, 0)
                            if img_h == draw_h and img_w == draw_w:
                                response['initial_draw'] = image_to_base64(draw)
                        self._send_json(response)
                    except Exception as e:
                        self.send_error(500, f"Error processing image data: {e}")
                        return
                else:
                    self.send_error(500, "Server error")
            elif path == '/get_draw':
                # Return current draw as base64 PNG (peek only, do not consume)
                if self.server_instance and self.server_instance.peek_draw() is not None:
                    try:
                        self._send_json({'draw': image_to_base64(self.server_instance.peek_draw())})
                    except Exception as e:
                        self.send_error(500, f"Error encoding draw: {e}")
                else:
                    self._send_json({'draw': None})
            else:
                super().do_GET()

        def do_POST(self):
            if self.path == '/draw':
                self._handle_draw()
            elif self.path == '/clear':
                if self.server_instance:
                    self.server_instance.clear()
                self._send_json({'status': 'ok'})
            elif self.path == '/window_closed':
                if self.server_instance:
                    self.server_instance.window_closed = True
                self._send_json({'status': 'ok'})
            else:
                super().do_POST()

        def _handle_draw(self):
            """接收前端合成的绘画图并存储为 tensor。confirm=true 时触发完成事件。"""
            if not self.server_instance:
                self.send_error(500, "Server error")
                return
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                draw_b64 = data.get('image')
                confirm = bool(data.get('confirm', False))
                if not draw_b64:
                    self._send_json({'status': 'error', 'message': 'no image data'})
                    return

                # Decode base64 -> numpy
                raw = draw_b64.split(',')[1] if ',' in draw_b64 else draw_b64
                img_bytes = base64.b64decode(raw)
                nparr = np.frombuffer(img_bytes, np.uint8)
                img = cv2.imdecode(nparr, cv2.IMREAD_UNCHANGED)

                if img is None:
                    self._send_json({'status': 'error', 'message': 'decode failed'})
                    return

                # Get original image dimensions
                original_image = self.server_instance.get_image()
                orig_channels = 3
                if hasattr(original_image, 'shape'):
                    if len(original_image.shape) == 4:
                        _, orig_h, orig_w, orig_channels = original_image.shape
                    elif len(original_image.shape) == 3:
                        orig_h, orig_w, orig_channels = original_image.shape
                    else:
                        orig_h, orig_w = img.shape[0], img.shape[1]
                else:
                    orig_h, orig_w = img.shape[0], img.shape[1]

                # Resize draw to match original image dimensions
                if img.shape[0] != orig_h or img.shape[1] != orig_w:
                    img = cv2.resize(img, (orig_w, orig_h), interpolation=cv2.INTER_LINEAR)

                # Convert to RGB（原图带 alpha 时保留 alpha，避免 RGBA 图经绘画后被压成 RGB）
                if img.ndim == 2:
                    result = cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)
                elif img.shape[2] == 4 and orig_channels == 4:
                    result = cv2.cvtColor(img, cv2.COLOR_BGRA2RGBA)
                elif img.shape[2] == 4:
                    result = cv2.cvtColor(img, cv2.COLOR_BGRA2RGB)
                else:
                    result = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)

                # Convert to tensor (1, H, W, C) in [0, 1]
                tensor = torch.from_numpy(result.astype(np.float32) / 255.0).unsqueeze(0)
                self.server_instance.set_draw(tensor)

                # Confirm 模式（独立节点）：触发完成事件
                if confirm:
                    self.server_instance.screenshot_event.set()

                self._send_json({'status': 'ok'})
            except Exception as e:
                print(f"[SnapshotDraw] _handle_draw error: {e}")
                self._send_json({'status': 'error', 'message': str(e)}, 500)

        def log_message(self, format, *args):
            # Suppress server logs
            pass


# =============================================================================
# SnapshotDrawNode - 参考 SnapshotMaskNode 的交互模式
# =============================================================================
class SnapshotDrawNode:
    """Open an image in a browser, allow user to draw on it with brush/eraser/palette/eyedropper, and return the painted image."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": "Input image to draw on",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "draw_image"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(s):
        return float("nan")

    def draw_image(self, image):
        focused_window = None
        if has_win32gui:
            focused_window = win32gui.GetForegroundWindow()

        # Start a temporary HTTP server to serve the drawing page
        server = SnapshotDrawServer(image)

        # Use callback to capture draw result
        result_draw = [None]
        def _on_draw_set(d):
            result_draw[0] = d
        server._on_draw_set = _on_draw_set

        server_thread = threading.Thread(target=server.start)
        server_thread.daemon = True
        server_thread.start()

        start_time = time.time()
        timeout = 10  # 10 seconds timeout
        while not server.started:
            if time.time() - start_time > timeout:
                raise RuntimeError(f"[SnapshotDraw] Server startup timeout after {timeout} seconds")
            time.sleep(0.1)

        print(f"[SnapshotDraw] Opening browser at: {server.browser_url}")
        webbrowser.open(server.browser_url)

        # Wait for draw to be submitted
        print("[SnapshotDraw] Waiting for drawing...")
        server.wait_for_selection()

        # Stop the server
        server.stop()

        # Restore window focus
        if has_win32gui and focused_window:
            time.sleep(0.5)
            focus_window(focused_window)

        if server.window_closed or result_draw[0] is None:
            raise ValueError("Window closed without drawing")

        return (result_draw[0],)


# Reuse win32 focus helpers from image_node (same as SnapshotMaskNode)
try:
    import win32gui
    has_win32gui = True
except ImportError:
    has_win32gui = False

if has_win32gui:
    try:
        from .image_node import focus_window
    except ImportError:
        def focus_window(hwnd):
            try:
                win32gui.SetForegroundWindow(hwnd)
            except Exception:
                pass
else:
    def focus_window(hwnd):
        pass
