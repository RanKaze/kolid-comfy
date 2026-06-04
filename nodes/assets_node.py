import os
import json
import threading
import http.server
import webbrowser
import time
import base64
import hashlib
import urllib.parse
import io
import comfy.model_management as mm


def check_interrupted():
    try:
        mm.throw_exception_if_processing_interrupted()
    except Exception:
        raise
    try:
        if mm.processing_interrupted():
            return True
        if hasattr(mm, 'interrupted') and mm.interrupted:
            return True
        if hasattr(mm, 'check_interrupt') and mm.check_interrupt():
            return True
    except Exception:
        pass
    return False


class SnapshotAssetsServer:
    """HTTP server for SnapshotAssetsNode to let user drag/drop images and confirm selection."""

    def __init__(self, input_data=""):
        self.port = None
        self.server = None
        self.started = False
        self.confirm_event = threading.Event()
        self.window_closed = False
        self.browser_url = None
        self.selected_images = []
        self.input_data = input_data
        self.should_stop = False

    def start(self):
        import socketserver
        class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
            pass
        for port in range(8800, 8900):
            try:
                self.server = ThreadingHTTPServer(('localhost', port), self.AssetsHandler)
                self.port = port
                self.started = True
                print(f"[SnapshotAssets] Server started on port {port}")
                break
            except Exception:
                continue

        self.browser_url = f"http://localhost:{self.port}/assets_node.html"

        if not self.started:
            print("[SnapshotAssets] Failed to start server")
            return

        self.AssetsHandler.server_instance = self
        try:
            self.server.serve_forever()
        except Exception:
            pass

    def stop(self):
        self.should_stop = True
        self.confirm_event.set()
        if self.server:
            print("[SnapshotAssets] Stopping server")
            try:
                self.server.shutdown()
                self.server.server_close()
            except Exception:
                pass

    def wait_for_confirm(self, check_interval=0.001):
        print("[SnapshotAssets] Waiting for user confirmation...")
        while not self.confirm_event.is_set():
            try:
                mm.throw_exception_if_processing_interrupted()
            except Exception as e:
                if "interrupt" in str(e).lower() or "processing" in str(e).lower():
                    print(f"[SnapshotAssets] Interrupt detected: {e}")
                    return False
                raise
            if check_interrupted():
                print("[SnapshotAssets] Interrupted!")
                return False
            if self.should_stop:
                return False
            self.confirm_event.wait(check_interval)
        return True

    class AssetsHandler(http.server.SimpleHTTPRequestHandler):
        server_instance = None

        def do_GET(self):
            if self.path in ('/', '/assets_node.html'):
                try:
                    web_dir = os.path.join(os.path.dirname(__file__), "web")
                    file_path = os.path.join(web_dir, "assets_node.html")
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

            elif self.path == '/input_data':
                data = {
                    'input_data': self.server_instance.input_data if self.server_instance else '',
                }
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps(data).encode('utf-8'))
                return

            self.send_error(404, "Not found")

        def do_POST(self):
            if self.path == '/confirm':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    self.server_instance.selected_images = data.get('images', [])
                    self.server_instance.confirm_event.set()

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({'success': True}).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")
                return

            elif self.path == '/window_closed':
                if self.server_instance:
                    self.server_instance.window_closed = True
                    self.server_instance.confirm_event.set()
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
                return

            self.send_error(404, "Not found")

        def log_message(self, format, *args):
            pass


class SnapshotAssetsNode:
    """Opens a tldraw-based web page where users can drag/drop images as cards,
    select them, and confirm. Outputs a list of dicts: [{"image": tensor}, ...]
    where each tensor is a ComfyUI-compatible image [B, H, W, C]."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "Data": ("STRING", {"default": "", "multiline": False}),
            },
        }

    RETURN_TYPES = ("DICT",)
    RETURN_NAMES = ("Data",)
    OUTPUT_IS_LIST = (True,)
    FUNCTION = "snapshot_assets"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(s, Data):
        return float("nan")

    @staticmethod
    def _decode_base64_image(data_url: str):
        """Decode a base64 data URL to a ComfyUI-compatible torch tensor [B, H, W, C]."""
        import numpy as np
        from PIL import Image
        import torch

        if ',' in data_url:
            data_url = data_url.split(',', 1)[1]

        img_bytes = base64.b64decode(data_url)
        img = Image.open(io.BytesIO(img_bytes))

        if img.mode != 'RGB':
            img = img.convert('RGB')

        arr = np.array(img).astype(np.float32) / 255.0
        tensor = torch.from_numpy(arr).unsqueeze(0)  # [1, H, W, 3]
        return tensor

    def snapshot_assets(self, Data):
        server = SnapshotAssetsServer(input_data=Data)
        server_thread = threading.Thread(target=server.start)
        server_thread.daemon = True
        server_thread.start()

        start_time = time.time()
        while not server.started:
            try:
                mm.throw_exception_if_processing_interrupted()
            except Exception as e:
                if "interrupt" in str(e).lower() or "processing" in str(e).lower():
                    print(f"[SnapshotAssets] Interrupted during startup: {e}")
                    server.stop()
                    raise RuntimeError("[SnapshotAssets] Interrupted during startup")
                raise
            if check_interrupted():
                print("[SnapshotAssets] Interrupted during startup!")
                server.stop()
                raise RuntimeError("[SnapshotAssets] Interrupted during startup")
            if time.time() - start_time > 10:
                raise RuntimeError("[SnapshotAssets] Server startup timeout")
            time.sleep(0.01)

        print(f"[SnapshotAssets] Opening browser at: {server.browser_url}")
        webbrowser.open(server.browser_url)

        if not server.wait_for_confirm():
            print("[SnapshotAssets] Interrupted or timed out")
            server.stop()
            raise RuntimeError("[SnapshotAssets] Interrupted or timed out")
        server.stop()

        selected_images = server.selected_images
        if not selected_images:
            raise RuntimeError("[SnapshotAssets] No images selected")

        result = []
        for img_b64 in selected_images:
            try:
                tensor = self._decode_base64_image(img_b64)
                result.append({"image": tensor})
            except Exception as e:
                print(f"[SnapshotAssets] Failed to decode image: {e}")
                raise RuntimeError(f"[SnapshotAssets] Failed to decode image: {e}")

        print(f"[SnapshotAssets] Output {len(result)} images")
        return (result,)
