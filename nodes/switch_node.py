import os
import json
import threading
import http.server
import webbrowser
import time
import inspect
import io
import base64
import comfy.model_management as mm

from ..libs.utils import AlwaysEqualProxy, compare_revision

any_type = AlwaysEqualProxy("*")
lazy_options = {"lazy": True} if compare_revision(2543) else {}

# Cache to prevent multiple web pages from opening for the same node in a single execution
_selection_cache = {}
_selection_locks = {}
_CACHE_TTL = 30.0  # seconds


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


def _preview_value(value):
    """Convert a ComfyUI input value to a preview dict for the web UI."""
    # Int
    if isinstance(value, int):
        return {"type": "int", "data": str(value)}

    # Text / float / bool
    if isinstance(value, (str, float, bool)):
        return {"type": "text", "data": str(value)}

    # Try tensor -> image base64
    try:
        import torch
        import numpy as np
        from PIL import Image
        if isinstance(value, torch.Tensor):
            t = value
            # Remove leading batch dimension(s)
            if t.dim() >= 3:
                t = t[0]
                while t.dim() > 2 and t.shape[0] == 1:
                    t = t.squeeze(0)
            arr = t.cpu().numpy()
            if arr.dtype in (np.float32, np.float64):
                arr = (arr * 255).clip(0, 255).astype(np.uint8)
            if arr.ndim == 2:
                img = Image.fromarray(arr, mode="L")
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                b64 = base64.b64encode(buf.getvalue()).decode()
                return {"type": "mask", "data": f"data:image/png;base64,{b64}"}
            elif arr.ndim == 3 and arr.shape[2] == 1:
                img = Image.fromarray(arr[:, :, 0], mode="L")
            elif arr.ndim == 3 and arr.shape[2] == 3:
                img = Image.fromarray(arr, mode="RGB")
            elif arr.ndim == 3 and arr.shape[2] == 4:
                img = Image.fromarray(arr, mode="RGBA")
            else:
                return {"type": "json", "data": json.dumps({"shape": list(arr.shape), "dtype": str(arr.dtype)})}
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode()
            return {"type": "image", "data": f"data:image/png;base64,{b64}"}
    except Exception:
        pass

    # Numpy array fallback
    try:
        import numpy as np
        from PIL import Image
        if isinstance(value, np.ndarray):
            arr = value
            # Remove leading batch dimension(s)
            if arr.ndim >= 3:
                arr = arr[0]
                while arr.ndim > 2 and arr.shape[0] == 1:
                    arr = arr.squeeze(axis=0)
            if arr.dtype in (np.float32, np.float64):
                arr = (arr * 255).clip(0, 255).astype(np.uint8)
            if arr.ndim == 2:
                img = Image.fromarray(arr, mode="L")
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                b64 = base64.b64encode(buf.getvalue()).decode()
                return {"type": "mask", "data": f"data:image/png;base64,{b64}"}
            elif arr.ndim == 3 and arr.shape[2] == 1:
                img = Image.fromarray(arr[:, :, 0], mode="L")
            elif arr.ndim == 3 and arr.shape[2] == 3:
                img = Image.fromarray(arr, mode="RGB")
            elif arr.ndim == 3 and arr.shape[2] == 4:
                img = Image.fromarray(arr, mode="RGBA")
            else:
                return {"type": "json", "data": json.dumps({"shape": list(arr.shape), "dtype": str(arr.dtype)})}
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode()
            return {"type": "image", "data": f"data:image/png;base64,{b64}"}
    except Exception:
        pass

    # PIL Image
    try:
        from PIL import Image
        if isinstance(value, Image.Image):
            buf = io.BytesIO()
            value.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode()
            return {"type": "image", "data": f"data:image/png;base64,{b64}"}
    except Exception:
        pass

    # Fallback: JSON serialize
    try:
        return {"type": "json", "data": json.dumps(value, default=str, ensure_ascii=False, indent=2)[:2000]}
    except Exception:
        return {"type": "json", "data": str(type(value).__name__)}


class SnapshotSwitchServer:
    """HTTP server for SnapshotSwitchNode to let user select which input to output."""

    def __init__(self, input_keys=None, input_previews=None, connection_info=None):
        self.port = None
        self.server = None
        self.started = False
        self.selection_event = threading.Event()
        self.window_closed = False
        self.browser_url = None
        self.selected_key = None
        self.custom_image = None
        self.input_keys = input_keys or []
        self.input_previews = input_previews or {}
        self.connection_info = connection_info or {}
        self.should_stop = False

    def start(self):
        for port in range(8600, 8700):
            try:
                self.server = http.server.HTTPServer(('localhost', port), self.SwitchHandler)
                self.port = port
                self.started = True
                print(f"[SnapshotSwitch] Server started on port {port}")
                break
            except Exception:
                continue

        self.browser_url = f"http://localhost:{self.port}/switch_node.html"

        if not self.started:
            print("[SnapshotSwitch] Failed to start server")
            return

        self.SwitchHandler.server_instance = self
        try:
            self.server.serve_forever()
        except Exception:
            pass

    def stop(self):
        self.should_stop = True
        self.selection_event.set()
        if self.server:
            print("[SnapshotSwitch] Stopping server")
            try:
                self.server.shutdown()
                self.server.server_close()
            except Exception:
                pass

    def wait_for_selection(self, check_interval=0.001):
        print("[SnapshotSwitch] Waiting for user selection...")
        while not self.selection_event.is_set():
            try:
                mm.throw_exception_if_processing_interrupted()
            except Exception as e:
                if "interrupt" in str(e).lower() or "processing" in str(e).lower():
                    print(f"[SnapshotSwitch] Interrupt detected: {e}")
                    return False
                raise
            if check_interrupted():
                print("[SnapshotSwitch] Interrupted!")
                return False
            if self.should_stop:
                return False
            self.selection_event.wait(check_interval)
        return True

    class SwitchHandler(http.server.SimpleHTTPRequestHandler):
        server_instance = None

        def do_GET(self):
            if self.path in ('/', '/switch_node.html'):
                try:
                    web_dir = os.path.join(os.path.dirname(__file__), "web")
                    file_path = os.path.join(web_dir, "switch_node.html")
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

            elif self.path == '/inputs_data':
                data = {
                    'input_keys': self.server_instance.input_keys if self.server_instance else [],
                    'input_previews': self.server_instance.input_previews if self.server_instance else {},
                    'connection_info': self.server_instance.connection_info if self.server_instance else {},
                }
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps(data).encode('utf-8'))
                return

            self.send_error(404, "Not found")

        def do_POST(self):
            if self.path == '/select_input':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    self.server_instance.selected_key = data.get('selected_key', '')
                    self.server_instance.custom_image = data.get('custom_image')
                    self.server_instance.selection_event.set()

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
                    self.server_instance.selection_event.set()
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
                return

            self.send_error(404, "Not found")

        def log_message(self, format, *args):
            pass


class SnapshotSwitchNode:
    """Dynamically expandable inputs. Opens a web page to select which input to output. Supports lazy loading."""

    @classmethod
    def INPUT_TYPES(cls):
        dyn_inputs = {"input1": (any_type, lazy_options)}
        stack = inspect.stack()
        if len(stack) > 2 and stack[2].function == 'get_input_info':
            class AllContainer:
                def __contains__(self, item):
                    return True

                def __getitem__(self, key):
                    return any_type, lazy_options
            dyn_inputs = AllContainer()

        return {
            "required": {
                "lazy_switch": ("BOOLEAN", {"default": True}),
                "connection_info": ("STRING", {"default": "{}", "multiline": False}),
            },
            "optional": dyn_inputs,
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("output",)
    FUNCTION = "snapshot_switch"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    @classmethod
    def IS_CHANGED(s, lazy_switch, connection_info, **kwargs):
        unique_id = kwargs.get('unique_id')
        if unique_id is not None and unique_id in _selection_cache:
            del _selection_cache[unique_id]
        return float("nan")

    def _do_open_web(self, input_keys, input_previews, connection_info):
        """Internal: actually open browser and block until user selects an input."""
        server = SnapshotSwitchServer(
            input_keys=input_keys,
            input_previews=input_previews,
            connection_info=connection_info,
        )
        server_thread = threading.Thread(target=server.start)
        server_thread.daemon = True
        server_thread.start()

        start_time = time.time()
        while not server.started:
            try:
                mm.throw_exception_if_processing_interrupted()
            except Exception as e:
                if "interrupt" in str(e).lower() or "processing" in str(e).lower():
                    print(f"[SnapshotSwitch] Interrupted during startup: {e}")
                    server.stop()
                    raise RuntimeError("[SnapshotSwitch] Interrupted during startup")
                raise
            if check_interrupted():
                print("[SnapshotSwitch] Interrupted during startup!")
                server.stop()
                raise RuntimeError("[SnapshotSwitch] Interrupted during startup")
            if time.time() - start_time > 10:
                raise RuntimeError("[SnapshotSwitch] Server startup timeout")
            time.sleep(0.01)

        print(f"[SnapshotSwitch] Opening browser at: {server.browser_url}")
        webbrowser.open(server.browser_url)

        if not server.wait_for_selection():
            print("[SnapshotSwitch] Interrupted or timed out")
            server.stop()
            raise RuntimeError("[SnapshotSwitch] Interrupted or timed out")
        server.stop()

        selected_key = server.selected_key
        if not selected_key or (selected_key not in input_keys and selected_key != "__custom__"):
            raise RuntimeError("[SnapshotSwitch] No input selected")

        custom_image = server.custom_image if selected_key == "__custom__" else None
        return selected_key, custom_image

    def _open_web_and_select(self, input_keys, input_previews, connection_info, unique_id):
        """Open browser and block until user selects an input.
        Uses a short-lived cache so the same node doesn't open multiple pages in one execution."""
        if unique_id is None:
            return self._do_open_web(input_keys, input_previews, connection_info)

        lock = _selection_locks.setdefault(unique_id, threading.Lock())
        with lock:
            # Check cache
            if unique_id in _selection_cache:
                cached_key, cached_image, cached_time = _selection_cache[unique_id]
                if time.time() - cached_time < _CACHE_TTL:
                    print(f"[SnapshotSwitch] Using cached selection: {cached_key}")
                    return cached_key, cached_image
                # Expired, remove
                del _selection_cache[unique_id]

            selected_key, custom_image = self._do_open_web(input_keys, input_previews, connection_info)
            _selection_cache[unique_id] = (selected_key, custom_image, time.time())
            return selected_key, custom_image

    def check_lazy_status(self, lazy_switch, connection_info, unique_id, **kwargs):
        input_keys = sorted([k for k in kwargs if k.startswith('input')], key=lambda x: int(x[5:]))

        if not lazy_switch:
            # Non-lazy mode: load all inputs so their content can be previewed
            return input_keys

        # Lazy mode: always open web page for selection
        if not input_keys:
            return []

        conn_map = {}
        try:
            conn_map = json.loads(connection_info or '{}')
        except Exception:
            pass

        selected_key, _ = self._open_web_and_select(
            input_keys=input_keys,
            input_previews={},
            connection_info=conn_map,
            unique_id=unique_id,
        )
        return [selected_key]

    @staticmethod
    def _decode_custom_image(custom_image_b64):
        """Decode a base64 image string to a ComfyUI-compatible torch tensor [B, H, W, C]."""
        if not custom_image_b64:
            raise RuntimeError("[SnapshotSwitch] No custom image provided")

        import base64
        from PIL import Image
        import numpy as np
        import torch

        # Remove data URI prefix if present
        if ',' in custom_image_b64:
            custom_image_b64 = custom_image_b64.split(',', 1)[1]

        img_bytes = base64.b64decode(custom_image_b64)
        img = Image.open(io.BytesIO(img_bytes))

        # Convert to RGB
        if img.mode != 'RGB':
            img = img.convert('RGB')

        arr = np.array(img).astype(np.float32) / 255.0
        tensor = torch.from_numpy(arr).unsqueeze(0)  # [1, H, W, 3]
        return tensor

    def snapshot_switch(self, lazy_switch, connection_info, unique_id, **kwargs):
        input_keys = sorted([k for k in kwargs if k.startswith('input')], key=lambda x: int(x[5:]))

        if not input_keys:
            raise RuntimeError("[SnapshotSwitch] No inputs connected")

        conn_map = {}
        try:
            conn_map = json.loads(connection_info or '{}')
        except Exception:
            pass

        try:
            if lazy_switch:
                # Selection was made in check_lazy_status
                # ComfyUI will only call snapshot_switch with the selected input in kwargs
                if len(input_keys) == 1:
                    selected_key = input_keys[0]
                    print(f"[SnapshotSwitch] (lazy) Selected: {selected_key}")
                    return (kwargs[selected_key],)
                # Fallback if multiple inputs somehow present
                selected_key, custom_image = self._open_web_and_select(
                    input_keys=input_keys,
                    input_previews={},
                    connection_info=conn_map,
                    unique_id=unique_id,
                )
                print(f"[SnapshotSwitch] (lazy fallback) Selected: {selected_key}")
                if selected_key == "__custom__":
                    return (self._decode_custom_image(custom_image),)
                return (kwargs[selected_key],)

            # Non-lazy mode: build previews and open web page during execution
            input_previews = {}
            for key in input_keys:
                input_previews[key] = _preview_value(kwargs[key])

            selected_key, custom_image = self._open_web_and_select(
                input_keys=input_keys,
                input_previews=input_previews,
                connection_info=conn_map,
                unique_id=unique_id,
            )
            print(f"[SnapshotSwitch] (non-lazy) Selected: {selected_key}")
            if selected_key == "__custom__":
                return (self._decode_custom_image(custom_image),)
            return (kwargs[selected_key],)
        finally:
            # Clear cache after execution to prevent stale selections in subsequent runs
            _selection_cache.pop(unique_id, None)
