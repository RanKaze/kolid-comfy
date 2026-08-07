import os
import re
import json
import threading
import queue
import http.server
import socketserver
import webbrowser
import time
import base64
import io
import numpy as np
import cv2
from PIL import Image
import torch
import comfy.model_management as mm

# =============================================================================
# 导入现有模块
# =============================================================================
from ..libs.utils import AlwaysEqualProxy

try:
    from .image_node import SnapshotMaskNodeServer, waitSnapShot
except ImportError as e:
    print(f"[SnapshotDetailerSampler] Warning: cannot import image_node: {e}")
    SnapshotMaskNodeServer = None
    waitSnapShot = None

try:
    from .prompt_node import SnapshotPromptServer, SnapshotPromptNode
except ImportError as e:
    print(f"[SnapshotDetailerSampler] Warning: cannot import prompt_node: {e}")
    SnapshotPromptServer = None
    SnapshotPromptNode = None

from ..libs.image_utils import limit_pixels, recover_size, crop_mask, recover_crop, draw_mask, draw_mask_on_image, batch_images, tensor_to_base64, mask_to_base64, set_inpaint_mask
from ..libs.mask_utils import expand_mask, combine_masks, create_empty_mask, invert_mask, parse_mask_base64
from ..libs.caption_utils import get_tag
from nodes import KSamplerAdvanced, VAEEncode, VAEDecode
from .sampler_node import get_loras_from_string
import gc


# =============================================================================
# SnapshotDetailerSamplerServer：前后端交互服务器
# =============================================================================
class SnapshotDetailerSamplerServer:
    """
    事件驱动的交互服务器。不再有固定阶段顺序，前端通过 tab 自由切换。
    后端通过 action queue 接收前端指令（run_detailer / select_image / finish）。
    """

    def __init__(self, detector, tagger, lora_regex, asset=None, package=None,
                 node_instance=None, unique_id=None, config=None, extra_pnginfo=None, prompt=None):
        self.detector = detector
        self.tagger = tagger
        self.extra_pnginfo = extra_pnginfo
        self.asset = asset
        self.lora_regex = lora_regex
        self.node_instance = node_instance
        self.unique_id = unique_id
        self.packages = []
        if package:
            if isinstance(package, list):
                self.packages = [p for p in package if isinstance(p, dict)]
            elif isinstance(package, dict):
                self.packages = [package]

        cfg = config or {}
        self.add_noise = cfg.get('add_noise', 'enable')
        self.start_step_rate = cfg.get('start_step_rate', 0.8)
        self.end_step_rate = cfg.get('end_step_rate', 1.0)
        self.pixels = cfg.get('pixels', 1048576)
        self.align = cfg.get('align', 8)
        self.crop_reserve = cfg.get('crop_reserve', 32)

        self.tag_result = None
        self.detail_status = 'idle'
        self.detail_error = None
        self.detail_progress = 0       # 0..1
        self.detail_total_steps = 0
        self.detail_current_step = 0
        self.finished = False
        self.finish_selected_key = None
        self.finish_selected_keys = None  # 多选 keys 列表
        self.window_closed = False

        # 历史图片画廊
        self.selected_history = []
        self._history_counter = 0
        self.current_context_key = None  # 当前作为 context 的 history key

        # 最新结果
        self.original_image = None
        self.detailed_image = None
        self.original_key = None   # history key of the original image
        self.detailed_key = None   # history key of the detailed image
        self.debug_recover_data = None

        # Interface 执行结果 keys（最近一次）
        self.interface_result_keys = []

        # 子服务器
        self.mask_server = None
        self.prompt_server = None
        self.main_server = None
        self.main_port = None
        self.mask_url = ""
        self.prompt_url = ""
        self.browser_url = ""
        self.started = False

        # 事件驱动：前端发送 action，主循环等待并处理
        self._action_queue = queue.Queue()
        self._action_event = threading.Event()

    def _on_mask_set(self, mask, loop_index=None):
        """Mask 编辑器 confirm 回调。直接写入 pipeline.mask。"""
        if self.node_instance is not None:
            self.node_instance._on_mask_set(mask)

    # -------------------------------------------------------------------------
    # 生命周期
    # -------------------------------------------------------------------------
    def start(self, initial_image=None):
        # 1) Mask server
        if SnapshotMaskNodeServer is None:
            raise RuntimeError("SnapshotMaskNodeServer not available")
        self.mask_server = SnapshotMaskNodeServer(
            image=initial_image,
            detector=self.detector,
        )
        self.mask_server._on_mask_set = self._on_mask_set
        t_mask = threading.Thread(target=self.mask_server.start)
        t_mask.daemon = True
        t_mask.start()

        t0 = time.time()
        while not self.mask_server.started:
            if time.time() - t0 > 10:
                raise RuntimeError("[SnapshotDetailerSampler] Mask server startup timeout")
            time.sleep(0.01)

        _, mask_port = self.mask_server.server.server_address
        self.mask_url = f"http://localhost:{mask_port}/mask_node.html"

        # 2) Prompt server
        if SnapshotPromptServer is None:
            raise RuntimeError("SnapshotPromptServer not available")
        self.prompt_server = SnapshotPromptServer(
            port=None,
            last_selected=[],
            lora_regex=self.lora_regex,
            last_selected_loras=[],
            last_selected_prefabs=[],
        )
        self.prompt_server.lora_path_mode = True
        self.prompt_server.tagger = self.tagger
        self.prompt_server.asset = self.asset
        t_prompt = threading.Thread(target=self.prompt_server.start)
        t_prompt.daemon = True
        t_prompt.start()

        t0 = time.time()
        while not self.prompt_server.started:
            if time.time() - t0 > 10:
                raise RuntimeError("[SnapshotDetailerSampler] Prompt server startup timeout")
            time.sleep(0.01)

        self.prompt_url = self.prompt_server.browser_url

        # 3) Main server
        class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
            pass
        for port in range(8700, 8800):
            try:
                self.main_server = ThreadedHTTPServer(
                    ('localhost', port), self.MainHandler
                )
                self.main_port = port
                self.started = True
                break
            except Exception:
                continue

        if not self.started:
            raise RuntimeError("[SnapshotDetailerSampler] Main server startup failed")

        self.browser_url = f"http://localhost:{self.main_port}/sampler_node.html"
        self.MainHandler.server_instance = self

        print(f"[SnapshotDetailerSampler] Main server on {self.main_port}")
        print(f"[SnapshotDetailerSampler] Mask server at {self.mask_url}")
        print(f"[SnapshotDetailerSampler] Prompt server at {self.prompt_url}")

        t_main = threading.Thread(target=self.main_server.serve_forever)
        t_main.daemon = True
        t_main.start()

    def stop(self):
        if self.mask_server:
            self.mask_server._on_mask_set = None
        def _stop(server):
            if server:
                try:
                    server.stop()
                except Exception:
                    pass
        threads = []
        for s in (self.mask_server, self.prompt_server):
            t = threading.Thread(target=_stop, args=(s,))
            t.daemon = True
            t.start()
            threads.append(t)
        if self.main_server:
            try:
                self.main_server.shutdown()
                self.main_server.server_close()
            except Exception:
                pass
        for t in threads:
            t.join(timeout=2.0)

    # -------------------------------------------------------------------------
    # 事件驱动
    # -------------------------------------------------------------------------
    def put_action(self, action, **kwargs):
        """前端通过 HTTP handler 调用，向队列中放入一个 action。"""
        self._action_queue.put({'action': action, **kwargs})
        self._action_event.set()

    def wait_for_action(self):
        """主循环等待下一个 action。"""
        # Check queue first — action may have been queued while we were busy
        if not self._action_queue.empty():
            return self._action_queue.get()
        self._action_event.clear()
        while not self._action_event.is_set():
            if mm.processing_interrupted():
                return None
            if self.window_closed:
                return None
            self._action_event.wait(0.05)
        # Check queue again after event was set
        if not self._action_queue.empty():
            return self._action_queue.get()
        return None

    # -------------------------------------------------------------------------
    # 历史画廊
    # -------------------------------------------------------------------------
    def add_history(self, image, name=None):
        """添加一张图片到历史画廊。"""
        self._history_counter += 1
        key = f'history_{self._history_counter}'
        self.selected_history.append({
            'key': key,
            'src': tensor_to_base64(image),
            'name': name or f'#{self._history_counter}',
        })
        if len(self.selected_history) > 20:
            self.selected_history = self.selected_history[-20:]

    def get_history_list(self):
        """返回历史画廊列表（base64 缩略图）。"""
        return [{'key': h['key'], 'name': h['name'], 'src': h['src']} for h in self.selected_history]

    def get_history_image(self, key):
        """根据 key 获取历史图片 tensor。"""
        for h in self.selected_history:
            if h['key'] == key:
                try:
                    src = h['src']
                    if ',' in src:
                        b64_data = src.split(',', 1)[1]
                    else:
                        b64_data = src
                    img_bytes = base64.b64decode(b64_data)
                    img = Image.open(io.BytesIO(img_bytes))
                    if img.mode != 'RGB':
                        img = img.convert('RGB')
                    arr = np.array(img).astype(np.float32) / 255.0
                    return torch.from_numpy(arr).unsqueeze(0)
                except Exception as e:
                    print(f"[SnapshotDetailerSampler] Failed to load history image: {e}")
                    return None
        return None

    # -------------------------------------------------------------------------
    # 参数同步
    # -------------------------------------------------------------------------
    def _sync_widgets(self):
        if self.unique_id is None:
            return
        try:
            from server import PromptServer
            ps = PromptServer.instance
            if ps is None:
                return
            ps.send_sync("kolid-comfy-widget-set", {
                "node_id": self.unique_id,
                "widget_name": "add_noise", "type": "STRING", "value": self.add_noise,
            })
            ps.send_sync("kolid-comfy-widget-set", {
                "node_id": self.unique_id,
                "widget_name": "start_step_rate", "type": "FLOAT", "value": str(self.start_step_rate),
            })
            ps.send_sync("kolid-comfy-widget-set", {
                "node_id": self.unique_id,
                "widget_name": "end_step_rate", "type": "FLOAT", "value": str(self.end_step_rate),
            })
            ps.send_sync("kolid-comfy-widget-set", {
                "node_id": self.unique_id,
                "widget_name": "pixels", "type": "INT", "value": str(self.pixels),
            })
            ps.send_sync("kolid-comfy-widget-set", {
                "node_id": self.unique_id,
                "widget_name": "crop_reserve", "type": "INT", "value": str(self.crop_reserve),
            })
        except Exception as e:
            print(f"[SnapshotDetailerSampler] Widget sync failed: {e}")

    def _apply_params(self, data):
        dirty = False
        if 'add_noise' in data:
            self.add_noise = data['add_noise']
            dirty = True
        if 'start_step_rate' in data:
            self.start_step_rate = float(data['start_step_rate'])
            dirty = True
        if 'end_step_rate' in data:
            self.end_step_rate = float(data['end_step_rate'])
            dirty = True
        if 'pixels' in data:
            self.pixels = int(data['pixels'])
            dirty = True
        if 'crop_reserve' in data:
            self.crop_reserve = int(data['crop_reserve'])
            dirty = True
        if dirty:
            self._sync_widgets()

    # -------------------------------------------------------------------------
    # HTTP 请求处理器
    # -------------------------------------------------------------------------
    class MainHandler(http.server.SimpleHTTPRequestHandler):
        server_instance = None

        def log_message(self, format, *args):
            pass

        def _send_json(self, data, status=200):
            self.send_response(status)
            self.send_header('Content-type', 'application/json')
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode('utf-8'))

        def do_OPTIONS(self):
            self.send_response(200)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.end_headers()

        def do_GET(self):
            inst = self.server_instance

            if self.path in ('/', '/sampler_node.html'):
                file_path = os.path.join(os.path.dirname(__file__), 'web', 'sampler_node.html')
                if os.path.exists(file_path):
                    self.send_response(200)
                    self.send_header('Content-type', 'text/html')
                    self.end_headers()
                    with open(file_path, 'rb') as f:
                        self.wfile.write(f.read())
                else:
                    self.send_error(404, "sampler_node.html not found")
                return

            if self.path == '/blend_node.html':
                file_path = os.path.join(os.path.dirname(__file__), 'web', 'blend_node.html')
                if os.path.exists(file_path):
                    self.send_response(200)
                    self.send_header('Content-type', 'text/html')
                    self.end_headers()
                    with open(file_path, 'rb') as f:
                        self.wfile.write(f.read())
                else:
                    self.send_error(404, "blend_node.html not found")
                return

            if self.path == '/api/config':
                self._send_json({
                    'mask_url': inst.mask_url if inst else '',
                    'prompt_url': inst.prompt_url if inst else '',
                    'detail_status': inst.detail_status if inst else 'idle',
                    'add_noise': inst.add_noise if inst else 'enable',
                    'start_step_rate': inst.start_step_rate if inst else 0.8,
                    'end_step_rate': inst.end_step_rate if inst else 1.0,
                    'pixels': inst.pixels if inst else 1048576,
                    'crop_reserve': inst.crop_reserve if inst else 32,
                    'has_tagger': inst.tagger is not None if inst else False,
                    'current_context_key': getattr(inst, 'current_context_key', None),
                    'has_package': bool(inst and inst.packages),
                    'package_count': len(inst.packages) if inst else 0,
                })
                return

            if self.path == '/api/status':
                self._send_json({
                    'detail_status': inst.detail_status if inst else 'idle',
                    'error': getattr(inst, 'detail_error', None),
                    'progress': inst.detail_progress if inst else 0,
                    'current_step': inst.detail_current_step if inst else 0,
                    'total_steps': inst.detail_total_steps if inst else 0,
                    'interface_result_keys': getattr(inst, 'interface_result_keys', []) if inst else [],
                })
                return

            if self.path == '/api/package':
                if not inst or not inst.packages:
                    self._send_json({'interfaces': []})
                    return

                from .interface_node import InterfacePackageNode
                epi = getattr(inst, 'extra_pnginfo', None)
                if isinstance(epi, list):
                    epi = epi[0] if epi else {}

                interfaces = []
                for pkg in inst.packages:
                    end_id = pkg.get('end_node_id', '')

                    # Get fresh package from extra_pnginfo for full port info
                    fresh_pkg = pkg
                    if epi and isinstance(epi, dict) and end_id:
                        pkg_node = InterfacePackageNode()
                        fresh = pkg_node.get_package(end_id, epi, None)
                        if fresh and fresh[0]:
                            fresh_pkg = fresh[0]

                    start_types = fresh_pkg.get('start_types', {})
                    end_types = fresh_pkg.get('types', {})

                    def make_port(num, name, ptype):
                        is_inject = ptype in ('PIPELINE_DATA', 'IMAGE', 'MASK')
                        is_manual = ptype in ('STRING', 'INT', 'FLOAT', 'BOOLEAN', 'COMBO')
                        return {
                            'num': num,
                            'name': name,
                            'type': ptype,
                            'value': None,
                            'category': 'inject' if is_inject else ('manual' if is_manual else 'port'),
                        }

                    # Start ports: ONLY from start_types (Start node's connected value ports)
                    start_ports = []
                    for port_num_str, ptype in sorted(start_types.items(), key=lambda x: int(x[0]) if str(x[0]).isdigit() else 0):
                        port_num = int(port_num_str) if isinstance(port_num_str, str) else port_num_str
                        start_ports.append(make_port(port_num, 'value' + str(port_num), ptype))

                    # End ports: ONLY from end_types (End node's connected value ports)
                    end_ports = []
                    for port_num_str, ptype in sorted(end_types.items(), key=lambda x: int(x[0]) if str(x[0]).isdigit() else 0):
                        port_num = int(port_num_str) if isinstance(port_num_str, str) else port_num_str
                        end_ports.append(make_port(port_num, 'value' + str(port_num), ptype))

                    interfaces.append({
                        'name': fresh_pkg.get('name', pkg.get('name', '')),
                        'start_ports': start_ports,
                        'end_ports': end_ports,
                    })
                self._send_json({'interfaces': interfaces})
                return

            if self.path == '/api/has_mask':
                has = inst.mask_server is not None and inst.mask_server.peek_latest_mask() is not None
                self._send_json({'has_mask': has})
                return

            if self.path == '/api/has_prompt':
                has = (inst.prompt_server is not None and
                       (getattr(inst.prompt_server, 'selected_prompts', None) or
                        getattr(inst.prompt_server, 'custom_prompts', None) or
                        getattr(inst.prompt_server, 'selected_loras', None)))
                self._send_json({'has_prompt': bool(has)})
                return

            if self.path == '/api/result':
                if inst and inst.original_image is not None and inst.detailed_image is not None:
                    try:
                        self._send_json({
                            'original_image': tensor_to_base64(inst.original_image),
                            'detailed_image': tensor_to_base64(inst.detailed_image),
                            'original_key': getattr(inst, 'original_key', None),
                            'detailed_key': getattr(inst, 'detailed_key', None),
                            'current_context_key': getattr(inst, 'current_context_key', None),
                        })
                    except Exception as e:
                        self._send_json({'error': str(e)}, 500)
                else:
                    self._send_json({'error': 'Result not ready'}, 404)
                return

            if self.path == '/api/history':
                self._send_json({'history': inst.get_history_list() if inst else []})
                return

            if self.path == '/api/tag_previews':
                if inst is None or inst.node_instance is None:
                    self._send_json({'error': 'not ready'})
                    return
                pipeline = inst.node_instance.get_current_pipeline()
                # 使用 pipeline 中已应用的 mask（由 /api/submit_mask 在进入 Tag 前设置）
                mask = pipeline.mask if pipeline else None
                previews = inst.node_instance._generate_tag_previews(pipeline, mask)
                self._send_json(previews)
                return

            if self.path == '/api/debug_recover_data':
                if inst is None:
                    self._send_json({'error': 'not ready'})
                    return
                data = inst.debug_recover_data
                if data is None:
                    self._send_json({'error': 'debug data not available yet'})
                    return
                self._send_json(data)
                return

            self.send_error(404)

        def do_POST(self):
            inst = self.server_instance

            if self.path == '/api/update_config':
                length = int(self.headers.get('Content-Length', 0))
                data = json.loads(self.rfile.read(length)) if length else {}
                inst._apply_params(data)
                self._send_json({'ok': True})
                return

            if self.path == '/api/run_detailer':
                inst.put_action('run_detailer')
                self._send_json({'ok': True})
                return

            if self.path == '/api/execute_interface':
                length = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(length)) if length else {}
                interface_index = body.get('interface_index', 0)
                manual_values = body.get('manual_values', {})
                inst.put_action('execute_interface', interface_index=interface_index, manual_values=manual_values)
                self._send_json({'ok': True})
                return

            if self.path == '/api/submit_mask':
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    mask_b64 = body.get('mask', '')
                    brush_mode = body.get('brush_mode', 'binary')
                    strength = float(body.get('strength', 1.0))
                    center = float(body.get('center', 1.0))
                    edge = float(body.get('edge', 0.0))
                    gamma = float(body.get('gamma', 2.0))
                    if not mask_b64:
                        self._send_json({'success': False, 'error': 'No mask data'}, 400)
                        return
                    if inst.node_instance is None or inst.node_instance._current_pipeline is None:
                        self._send_json({'success': False, 'error': 'Pipeline not ready'}, 400)
                        return
                    pipeline = inst.node_instance._current_pipeline
                    img = pipeline.image
                    if img is None:
                        img = pipeline.get_image()
                    if img is None:
                        self._send_json({'success': False, 'error': 'No image'}, 400)
                        return
                    orig_h, orig_w = (img.shape[1], img.shape[2]) if img.dim() == 4 else (img.shape[0], img.shape[1])
                    # Decode base64 mask
                    raw = mask_b64.split(',')[1] if ',' in mask_b64 else mask_b64
                    mask_bytes = base64.b64decode(raw)
                    mask_img = Image.open(io.BytesIO(mask_bytes))
                    if mask_img.mode != 'RGBA':
                        mask_img = mask_img.convert('RGBA')
                    # Use alpha channel as mask
                    mask_gray = np.array(mask_img)[:, :, 3].astype(np.float32) / 255.0
                    # Resize to match pipeline image dimensions
                    if mask_gray.shape[0] != orig_h or mask_gray.shape[1] != orig_w:
                        mask_gray = cv2.resize(mask_gray, (orig_w, orig_h), interpolation=cv2.INTER_LINEAR)
                    # Apply brush mode transform
                    # Brush softness is already baked into the alpha channel (radial gradient in canvas)
                    # Binary: threshold any non-zero alpha to full strength
                    if brush_mode == 'binary':
                        mask_gray = (mask_gray > 0).astype(np.float32) * strength
                    else:
                        # Linear / Exponential: alpha already encodes the gradient, just clip
                        mask_gray = np.clip(mask_gray, 0, 1)
                    mask_tensor = torch.from_numpy(mask_gray).unsqueeze(0)  # [1, H, W]
                    print(f"[DIAG] submit_mask: received mask_img={mask_img.size} mode={mask_img.mode} → gray_shape={mask_gray.shape} sum={mask_gray.sum():.1f} max={mask_gray.max():.3f} → tensor_shape={mask_tensor.shape} brush_mode={brush_mode}")
                    inst.node_instance._on_mask_set(mask_tensor)
                    # Also update mask server's stored mask so peek_latest_mask works
                    if inst.mask_server:
                        inst.mask_server.set_mask(mask_tensor)
                    self._send_json({'success': True})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'success': False, 'error': str(e)}, 500)
                return

            if self.path == '/api/select_image':
                length = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(length)) if length else {}
                key = body.get('key', '')
                inst.put_action('select_image', key=key)
                self._send_json({'ok': True})
                return

            if self.path == '/api/finish':
                length = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(length)) if length else {}
                selected_keys = body.get('selected_keys')
                if selected_keys is not None and isinstance(selected_keys, list):
                    inst.finish_selected_keys = selected_keys
                    inst.finish_selected_key = selected_keys[0] if len(selected_keys) == 1 else None
                else:
                    # 兼容旧格式 single key
                    selected_key = body.get('selected_key')
                    inst.finish_selected_key = selected_key
                    inst.finish_selected_keys = [selected_key] if selected_key else None
                inst.finished = True
                inst.put_action('finish')
                # 唤醒 mask/prompt 以防阻塞
                if inst.mask_server:
                    inst.mask_server.screenshot_event.set()
                if inst.prompt_server:
                    inst.prompt_server.prompt_event.set()
                self._send_json({'ok': True})
                return

            if self.path == '/api/add_context_image':
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    image_b64 = body.get('image', '')
                    if not image_b64:
                        self._send_json({'success': False, 'error': 'No image data'}, 400)
                        return
                    # 解码 base64 → tensor
                    if ',' in image_b64:
                        b64_data = image_b64.split(',', 1)[1]
                    else:
                        b64_data = image_b64
                    img_bytes = base64.b64decode(b64_data)
                    img = Image.open(io.BytesIO(img_bytes))
                    if img.mode != 'RGB':
                        img = img.convert('RGB')
                    arr = np.array(img).astype(np.float32) / 255.0
                    tensor = torch.from_numpy(arr).unsqueeze(0)
                    inst.add_history(tensor, name=f'Loaded #{len(inst.selected_history) + 1}')
                    self._send_json({'success': True})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'success': False, 'error': str(e)}, 500)
                return

            if self.path == '/api/load_from_assets':
                try:
                    if inst.node_instance is None:
                        self._send_json({'success': False, 'error': 'Node instance not available'})
                        return
                    asset_data = inst.asset or ''
                    if not asset_data or not asset_data.strip():
                        self._send_json({'success': False, 'error': 'No asset data configured'})
                        return
                    count = inst.node_instance._load_from_assets(inst, asset_data)
                    self._send_json({'success': True, 'count': count})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'success': False, 'error': str(e)}, 500)
                return

            if self.path == '/api/blend':
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    bg_key = body.get('background_key', '')
                    fg_key = body.get('foreground_key', '')
                    mask_b64 = body.get('mask', '')
                    if not bg_key or not fg_key or not mask_b64:
                        self._send_json({'success': False, 'error': 'Missing bg_key, fg_key, or mask'}, 400)
                        return
                    bg_img = inst.get_history_image(bg_key)
                    fg_img = inst.get_history_image(fg_key)
                    if bg_img is None or fg_img is None:
                        self._send_json({'success': False, 'error': 'Image not found'}, 400)
                        return
                    # Ensure same dimensions — resize fg to match bg
                    bg_h, bg_w = bg_img.shape[1], bg_img.shape[2]
                    if fg_img.shape[1] != bg_h or fg_img.shape[2] != bg_w:
                        fg_img = torch.nn.functional.interpolate(
                            fg_img.permute(0, 3, 1, 2), size=(bg_h, bg_w), mode='bilinear'
                        ).permute(0, 2, 3, 1)
                    # Decode mask
                    raw = mask_b64.split(',')[1] if ',' in mask_b64 else mask_b64
                    mask_bytes = base64.b64decode(raw)
                    mask_img = Image.open(io.BytesIO(mask_bytes))
                    if mask_img.mode != 'RGBA':
                        mask_img = mask_img.convert('RGBA')
                    mask_gray = np.array(mask_img)[:, :, 3].astype(np.float32) / 255.0
                    # Resize mask to match image
                    if mask_gray.shape[0] != bg_h or mask_gray.shape[1] != bg_w:
                        mask_gray = cv2.resize(mask_gray, (bg_w, bg_h), interpolation=cv2.INTER_LINEAR)
                    mask_gray = np.clip(mask_gray, 0, 1)
                    # Alpha blend: result = bg * (1 - alpha) + fg * alpha
                    alpha = torch.from_numpy(mask_gray).unsqueeze(0).unsqueeze(-1)  # [1, H, W, 1]
                    blended = bg_img * (1 - alpha) + fg_img * alpha
                    blended = torch.clamp(blended, 0, 1)
                    inst.add_history(blended, name=f'Blend #{len(inst.selected_history)}')
                    new_key = inst.selected_history[-1]['key']
                    self._send_json({'success': True, 'key': new_key})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'success': False, 'error': str(e)}, 500)
                return

            if self.path == '/api/run_tag':
                try:
                    if inst.tagger is None:
                        self._send_json({'success': False, 'error': 'Tagger not configured'})
                        return
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    mode = body.get('mode', 'mask')
                    tag = ''
                    if inst.node_instance:
                        pipeline = inst.node_instance.get_current_pipeline()
                        mask = pipeline.mask if pipeline else None
                        tag = inst.node_instance._run_tag(pipeline, mask, inst.tagger, mode)
                    inst.tag_result = tag
                    if inst.prompt_server:
                        parsed_selected, parsed_custom = [], tag
                        if SnapshotPromptNode is not None:
                            parsed_selected, parsed_custom = SnapshotPromptNode._parse_raw_prompt(tag)
                        # 移除旧的 parsing tag，保留 normal/program tag，然后添加新的 parsing tag
                        new_prompts = [
                            p for p in (inst.prompt_server.selected_prompts or [])
                            if not (isinstance(p, dict) and p.get('source', 'normal') == 'parsing')
                        ]
                        new_prompts.extend({'text': p, 'source': 'parsing'} for p in parsed_selected)
                        inst.prompt_server.selected_prompts = new_prompts
                        inst.prompt_server.custom_prompts = parsed_custom
                    self._send_json({'success': True, 'tag': tag, 'tags': parsed_selected, 'custom': parsed_custom})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'success': False, 'error': str(e)})
                return

            if self.path == '/window_closed':
                inst.window_closed = True
                inst.put_action('window_closed')
                self._send_json({'ok': True})
                return

            self.send_error(404)


# =============================================================================
# SnapshotDetailerSamplerNode
# =============================================================================
class SnapshotDetailerSamplerNode:
    """
    事件驱动的交互式细节修复节点。
    前端通过 tab 自由切换 Mask/Tag/Prompt/Draw/Context，后端通过 action queue 响应。
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "lora_regex": ("STRING", {"default": "", "multiline": False}),
                "context_regex": ("STRING", {"default": ".+", "multiline": False}),
                "add_noise": (["enable", "disable"], {"default": "enable"}),
                "start_step_rate": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 1.0, "step": 0.01}),
                "end_step_rate": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "pixels": ("INT", {"default": 1048576, "min": 65536, "max": 16777216, "step": 65536}),
                "align": ("INT", {"default": 8, "min": 1, "max": 64, "step": 1}),
                "crop_reserve": ("INT", {"default": 32, "min": 0, "max": 256, "step": 1}),
            },
            "optional": {
                "detector": ("*",),
                "tagger": ("*",),
                "asset": ("STRING", {"default": "", "multiline": True, "tooltip": "Assets snapshot: JSON string (normal mode) or name (global mode) for Tag From Assets button"}),
                "package": ("*",),
            },
            "hidden": {
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("PIPELINE_DATA",)
    RETURN_NAMES = ("pipeline",)
    FUNCTION = "sample"
    CATEGORY = "sampling/custom"

    @classmethod
    def IS_CHANGED(s, **kwargs):
        return float("nan")

    def get_current_pipeline(self):
        return getattr(self, '_current_pipeline', None)

    def _on_mask_set(self, mask):
        """Mask 编辑器 confirm → 直接写入 pipeline.mask。"""
        if self._current_pipeline is not None and mask is not None:
            self._current_pipeline.mask = mask.clone()

    # -------------------------------------------------------------------------
    # Tag
    # -------------------------------------------------------------------------
    def _generate_tag_previews(self, pipeline, mask):
        if pipeline is None or pipeline.image is None or mask is None:
            return {}
        try:
            from ..libs.image_utils import crop_mask
            img = pipeline.image
            if img.dim() == 3:
                img = img.unsqueeze(0)
            if mask.dim() == 2:
                mask = mask.unsqueeze(0)
            previews = {'full': tensor_to_base64(img)}
            try:
                cropped_img, cropped_mask, _ = crop_mask(img, mask, reserve=32)
                previews['mask'] = tensor_to_base64(cropped_img)
                white_bg = torch.ones_like(cropped_img)
                mask_expanded = cropped_mask.unsqueeze(-1).float()
                covered = cropped_img * mask_expanded + white_bg * (1 - mask_expanded)
                previews['covered'] = tensor_to_base64(covered)
            except Exception as e:
                print(f'[TagPreview] crop failed: {e}')
                previews['mask'] = previews['full']
                previews['covered'] = previews['full']
            return previews
        except Exception as e:
            print(f'[TagPreview] error: {e}')
            return {}

    def _run_tag(self, pipeline, mask, tagger, mode='mask'):
        from ..libs.caption_utils import get_tag
        from ..libs.image_utils import crop_mask
        tag_image = pipeline.image if pipeline is not None else None
        if mask is not None:
            try:
                img = tag_image
                if img.dim() == 3:
                    img = img.unsqueeze(0)
                if mask.dim() == 2:
                    mask = mask.unsqueeze(0)
                cropped_img, cropped_mask, _ = crop_mask(img, mask, reserve=32)
                if mode == 'mask':
                    tag_image = cropped_img
                elif mode == 'covered':
                    white_bg = torch.ones_like(cropped_img)
                    mask_expanded = cropped_mask.unsqueeze(-1).float()
                    tag_image = cropped_img * mask_expanded + white_bg * (1 - mask_expanded)
            except Exception as mask_err:
                print(f"[RunTag] crop_mask failed, falling back to full: {mask_err}")
        return get_tag(tagger, tag_image)

    # -------------------------------------------------------------------------
    # Load From Assets
    # -------------------------------------------------------------------------
    def _load_from_assets(self, server, asset_data):
        """Open SnapshotAssetsServer for image selection, add selected images to history."""
        import webbrowser
        from .assets_node import SnapshotAssetsServer, SnapshotAssetsNode

        # Determine mode: JSON string → normal mode, else → global mode name
        global_mode = True
        canvas_snapshot = None
        if asset_data and asset_data.strip():
            try:
                parsed = json.loads(asset_data.strip())
                if isinstance(parsed, dict):
                    canvas_snapshot = asset_data.strip()
                    global_mode = False
            except (json.JSONDecodeError, ValueError):
                pass

        if global_mode and asset_data and asset_data.strip():
            snap_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data", "snapshots")
            snap_path = os.path.join(snap_dir, f"{asset_data.strip()}.json")
            if os.path.exists(snap_path):
                with open(snap_path, 'r', encoding='utf-8') as f:
                    canvas_snapshot = f.read()

        assets_server = SnapshotAssetsServer(
            input_data=asset_data,
            canvas_snapshot=canvas_snapshot,
            enable_image=True,
            enable_image_config=False,
            image_config="",
            enable_video=False,
            enable_audio=False,
            enable_prompt=False,
            enable_slot=False,
            global_mode=global_mode,
        )
        server_thread = threading.Thread(target=assets_server.start)
        server_thread.daemon = True
        server_thread.start()

        start_time = time.time()
        while not assets_server.started:
            try:
                mm.throw_exception_if_processing_interrupted()
            except Exception:
                assets_server.stop()
                raise
            if time.time() - start_time > 10:
                assets_server.stop()
                raise RuntimeError("[load_from_assets] Server startup timeout")
            time.sleep(0.01)

        print(f"[load_from_assets] Opening browser at: {assets_server.browser_url}")
        webbrowser.open(assets_server.browser_url)

        if not assets_server.wait_for_confirm():
            assets_server.stop()
            return 0
        assets_server.stop()

        selected_images = getattr(assets_server, 'selected_images', [])
        if not selected_images:
            return 0

        count = 0
        for img_data in selected_images:
            if isinstance(img_data, dict):
                image_url = img_data.get('image', '')
                if not image_url:
                    continue
                tensor = SnapshotAssetsNode._decode_image_data(image_url)
                server.add_history(tensor, name=f'Asset #{len(server.selected_history) + 1}')
                count += 1

        print(f"[load_from_assets] Added {count} images to history")
        return count

    # -------------------------------------------------------------------------
    # Prompt 解析
    # -------------------------------------------------------------------------
    def _parse_prompt(self, prompt_server):
        user_positive = ''
        user_loras = ''
        if prompt_server:
            selected = prompt_server.selected_prompts
            custom = prompt_server.custom_prompts
            parts = []
            for p in selected:
                text = p['text'] if isinstance(p, dict) else p
                if text.startswith('<') and text.endswith('>'):
                    parts.append(text[1:-1])
                else:
                    parts.append(text)
            if custom:
                parts.append(custom)
            user_positive = ','.join(parts)
            loras = prompt_server.selected_loras or []
            lora_str_parts = []
            for lora_item in loras:
                if isinstance(lora_item, dict):
                    file_path = lora_item.get('file_path', '') or lora_item.get('file_name', '')
                    strength = lora_item.get('strength', 1.0)
                    lora_str_parts.append(f"<lora_path:{file_path}:{strength}>")
                else:
                    lora_str_parts.append(str(lora_item))
            user_loras = ','.join(lora_str_parts)
        return user_positive, user_loras

    # -------------------------------------------------------------------------
    # Detailer
    # -------------------------------------------------------------------------
    def _run_detailer(self, pipeline, user_mask, user_positive, user_loras, params):
        seed = params['seed']
        add_noise = params['add_noise']
        start_step_rate = params['start_step_rate']
        end_step_rate = params['end_step_rate']
        pixels = params['pixels']
        align = params['align']
        crop_reserve = params['crop_reserve']
        context_regex = params['context_regex']

        next_pipeline = pipeline.copy()
        if next_pipeline.cache is None:
            raise ValueError('PipelineData cache is empty')
        if next_pipeline.model is None:
            raise ValueError('PipelineData model is empty, cannot Detailer')

        context_positive, context_negative, context_loras = next_pipeline.context.get_context(context_regex)

        original_image = next_pipeline.get_image()
        if original_image is None:
            raise ValueError("No image available for detailer")

        if user_mask is not None:
            user_mask = user_mask.clone()
        expanded_mask = expand_mask(user_mask, grow=32, blur=32)

        cropped_image, cropped_mask, crop_info = crop_mask(
            image=original_image,
            mask=expanded_mask,
            reserve=crop_reserve
        )

        resized_image, resized_mask, resize_info = limit_pixels(
            image=cropped_image,
            pixels=pixels,
            mask=cropped_mask,
            align=align,
        )

        tmp_latent = VAEEncode().encode(
            vae=next_pipeline.vae,
            pixels=resized_image
        )[0]

        sampler_name = next_pipeline.sampler_name or 'euler'
        scheduler = next_pipeline.scheduler or 'normal'
        steps = next_pipeline.steps or 20
        cfg = next_pipeline.cfg or 8.0

        start_at_step = int(start_step_rate * steps)
        end_at_step = int(end_step_rate * steps)

        current_positive = ','.join([p for p in [context_positive, user_positive] if p])
        current_negative = context_negative
        current_loras = context_loras.copy()
        current_loras.extend(get_loras_from_string(user_loras))

        tmp_positive, tmp_negative, tmp_loras = next_pipeline.context.get_prompt_context('', resized_image)
        if tmp_positive:
            current_positive += ',' + tmp_positive
        if tmp_negative:
            current_negative += ',' + tmp_negative
        if tmp_loras:
            current_loras.extend(tmp_loras)

        model_negative = next_pipeline.config.get("model_negative")
        model_to_use, clip_to_use, model_negative_to_use = next_pipeline.cache.get_model_clip(
            model=next_pipeline.model,
            clip=next_pipeline.clip,
            loras=current_loras,
            model_negative=model_negative
        )

        positive_condition = next_pipeline.get_conditioning(
            mode='positive',
            clip=clip_to_use,
            vae=next_pipeline.vae,
            prompt=current_positive,
            reference_latent=None,
            reference_image=resized_image,
            reference=next_pipeline.reference
        )

        negative_condition = next_pipeline.get_conditioning(
            mode='negative',
            clip=clip_to_use,
            vae=next_pipeline.vae,
            prompt=current_negative,
            reference_latent=None,
            reference_image=resized_image,
            reference=next_pipeline.reference
        )

        from .sampler_node import _ksampler
        sampled_latent = _ksampler(
            model=model_to_use,
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler=scheduler,
            positive=positive_condition,
            negative=negative_condition,
            latent=tmp_latent,
            disable_noise=(add_noise == "disable"),
            start_step=start_at_step,
            last_step=end_at_step,
            force_full_denoise=True,
            sigmas=next_pipeline.config.get("sigmas"),
            model_negative=model_negative_to_use,
        )[0]

        decoded_image = VAEDecode().decode(vae=next_pipeline.vae, samples=sampled_latent)[0]

        recovered_image, recovered_mask = recover_size(
            image=decoded_image,
            resize_info=resize_info,
            mask=resized_mask
        )

        final_image, final_mask = recover_crop(
            background=original_image,
            image=recovered_image,
            crop_info=crop_info,
            recover_method='mask_blend',
            mask=recovered_mask
        )

        detailed_image = final_image

        try:
            debug_recover_data = {
                'background': tensor_to_base64(original_image),
                'image': tensor_to_base64(recovered_image),
                'mask': mask_to_base64(recovered_mask),
                'crop_x': crop_info.get('crop_x', 0),
                'crop_y': crop_info.get('crop_y', 0),
                'crop_width': crop_info.get('crop_width', 0),
                'crop_height': crop_info.get('crop_height', 0),
                'original_width': crop_info.get('original_width', 0),
                'original_height': crop_info.get('original_height', 0),
            }
        except Exception as dbg_e:
            print(f'[Debug] failed to save recover debug data: {dbg_e}')
            debug_recover_data = None

        next_pipeline.image = final_image
        next_pipeline.latent = None
        next_pipeline.mask = final_mask

        gc.collect()
        mm.soft_empty_cache()

        return next_pipeline, original_image, detailed_image, debug_recover_data

    # -------------------------------------------------------------------------
    # 切换图片时更新 mask server：尺寸相同则保留 mask，否则清除
    # -------------------------------------------------------------------------
    def _switch_image(self, server, new_image, context_key=None):
        """切换 pipeline 的图片并更新 mask server。尺寸相同则保留 mask。"""
        old_image = self._current_pipeline.image
        old_h, old_w = (old_image.shape[1], old_image.shape[2]) if old_image is not None and hasattr(old_image, 'shape') and old_image.dim() >= 3 else (0, 0)
        new_h, new_w = (new_image.shape[1], new_image.shape[2]) if new_image is not None and hasattr(new_image, 'shape') and new_image.dim() >= 3 else (0, 0)

        self._current_pipeline.image = new_image
        server.current_context_key = context_key

        if server.mask_server:
            server.mask_server.set_image(new_image)
            if old_h != new_h or old_w != new_w:
                # 尺寸不同，mask 不通用，清除
                server.mask_server.clear()
                self._current_pipeline.mask = None
                print(f"[SnapshotDetailerSampler] Image size changed ({old_w}x{old_h} → {new_w}x{new_h}), mask cleared")
            else:
                print(f"[SnapshotDetailerSampler] Image size unchanged ({new_w}x{new_h}), mask preserved")

    # -------------------------------------------------------------------------
    # Interface Package 执行
    # -------------------------------------------------------------------------
    def _execute_interface(self, server, interface_idx, manual_values):
        """Execute a sub-graph via InterfaceExecutor."""
        if interface_idx >= len(server.packages):
            raise ValueError(f"Interface index {interface_idx} out of range ({len(server.packages)} packages)")

        pkg = server.packages[interface_idx]
        from .interface_node import InterfaceExecutor

        # 将 prompt tab 的 lora/prompt 注入到 pipeline 副本中
        user_positive, user_loras = self._parse_prompt(server.prompt_server)
        injected_pipeline = self._current_pipeline.copy() if self._current_pipeline else None
        if injected_pipeline and (user_positive or user_loras):
            from .sampler_node import SamplerContext
            entry = SamplerContext()
            entry.positive = user_positive
            entry.negative = ''
            entry.loras = get_loras_from_string(user_loras) if user_loras else []
            injected_pipeline.context.contexts['__prompt_tab__'] = entry

        # 记录 interface 结果 keys
        server.interface_result_keys = []

        def _on_result_image(img, name):
            server.add_history(img, name=name)
            # add_history appends to selected_history; get the key
            if server.selected_history:
                server.interface_result_keys.append(server.selected_history[-1]['key'])

        executor = InterfaceExecutor(
            extra_pnginfo=getattr(server, 'extra_pnginfo', None),
            on_progress=lambda cur, total: setattr(server, 'detail_current_step', cur) or setattr(server, 'detail_total_steps', total) or setattr(server, 'detail_progress', cur / max(total, 1)),
            get_pipeline=lambda: injected_pipeline,
            get_image=lambda: injected_pipeline.get_image() if injected_pipeline else None,
            get_mask=lambda: injected_pipeline.mask if injected_pipeline else None,
            on_result_image=_on_result_image,
            on_result_pipeline=None,
            on_sampler_progress=lambda cur, total, node_id: setattr(server, 'detail_current_step', cur) or setattr(server, 'detail_total_steps', total) or setattr(server, 'detail_progress', cur / max(total, 1)),
        )

        results = executor.execute(pkg, manual_values)

        # Auto-select last added image as context
        if results:
            new_key = server.selected_history[-1]['key']
            last_image = server.get_history_image(new_key)
            if last_image is not None:
                self._switch_image(server, last_image, context_key=new_key)
                print(f"[InterfaceExec] Auto-set context to {new_key}")

    # -------------------------------------------------------------------------
    # 主入口
    # -------------------------------------------------------------------------
    def sample(self, pipeline, seed, lora_regex="", context_regex=".+", add_noise="enable",
               start_step_rate=0.8, end_step_rate=1.0, pixels=1048576,
               align=8, crop_reserve=32, detector=None, tagger=None, asset="", package=None,
               extra_pnginfo=None, unique_id=None):
        mm.throw_exception_if_processing_interrupted()

        self._current_pipeline = pipeline.copy() if pipeline else None

        server = SnapshotDetailerSamplerServer(
            detector=detector,
            tagger=tagger,
            lora_regex=lora_regex,
            asset=asset,
            package=package,
            node_instance=self,
            unique_id=unique_id,
            extra_pnginfo=extra_pnginfo,
            config={
                'add_noise': add_noise,
                'start_step_rate': start_step_rate,
                'end_step_rate': end_step_rate,
                'pixels': pixels,
                'align': align,
                'crop_reserve': crop_reserve,
                'context_regex': context_regex,
            }
        )
        server.start(initial_image=self._current_pipeline.image if self._current_pipeline else None)

        t0 = time.time()
        while not server.started:
            mm.throw_exception_if_processing_interrupted()
            if time.time() - t0 > 15:
                server.stop()
                raise RuntimeError("[SnapshotDetailerSampler] Server startup timeout")
            time.sleep(0.01)

        # 添加初始图片到历史画廊
        if self._current_pipeline and self._current_pipeline.image is not None:
            server.add_history(self._current_pipeline.image, name='Original')
            server.current_context_key = server.selected_history[-1]['key']

        print(f"[SnapshotDetailerSampler] Opening browser at: {server.browser_url}")
        webbrowser.open(server.browser_url)

        params = {
            'seed': seed,
            'add_noise': add_noise,
            'start_step_rate': start_step_rate,
            'end_step_rate': end_step_rate,
            'pixels': pixels,
            'align': align,
            'crop_reserve': crop_reserve,
            'context_regex': context_regex,
        }

        try:
            while not server.finished:
                try:
                    mm.throw_exception_if_processing_interrupted()
                except Exception as e:
                    if "interrupt" in str(e).lower() or "processing" in str(e).lower():
                        break
                    raise
                if mm.processing_interrupted():
                    break

                # 等待前端 action
                action = server.wait_for_action()
                if action is None:
                    break

                act = action.get('action')

                if act == 'window_closed':
                    break

                if act == 'finish':
                    break

                if act == 'run_detailer':
                    server.detail_status = 'running'
                    server.detail_error = None
                    server.detail_progress = 0
                    server.detail_current_step = 0
                    server.detail_total_steps = 0
                    # Set up progress tracking via ComfyUI's global hook
                    import comfy.utils
                    orig_hook = comfy.utils.PROGRESS_BAR_HOOK
                    def _progress_hook(current, total, preview=None, **kwargs):
                        server.detail_current_step = current
                        server.detail_total_steps = total
                        if total > 0:
                            server.detail_progress = current / total
                    comfy.utils.set_progress_bar_global_hook(_progress_hook)
                    try:
                        user_positive, user_loras = self._parse_prompt(server.prompt_server)
                        current_mask = self._current_pipeline.mask
                        if current_mask is not None:
                            current_mask = current_mask.clone()

                        # 遮罩必须存在，否则 detailer 无意义
                        if current_mask is None or (hasattr(current_mask, 'sum') and current_mask.sum().item() == 0):
                            server.detail_status = 'error'
                            server.detail_error = 'Mask is required — draw a mask before running the detailer'
                            continue

                        # 诊断：打印 mask 和 image 的尺寸信息
                        diag_img = self._current_pipeline.image
                        if diag_img is not None:
                            diag_img_h, diag_img_w = (diag_img.shape[1], diag_img.shape[2]) if diag_img.dim() == 4 else (diag_img.shape[0], diag_img.shape[1])
                        else:
                            diag_img_h, diag_img_w = 0, 0
                        if current_mask is not None:
                            diag_mask_shape = str(current_mask.shape)
                            diag_mask_sum = current_mask.sum().item()
                            diag_mask_max = current_mask.max().item()
                        else:
                            diag_mask_shape = 'None'
                            diag_mask_sum = 0
                            diag_mask_max = 0
                        print(f"[DIAG] run_detailer: image={diag_img_w}x{diag_img_h} mask_shape={diag_mask_shape} mask_sum={diag_mask_sum:.1f} mask_max={diag_mask_max:.3f}")

                        next_pipeline, original_image, detailed_image, debug_data = self._run_detailer(
                            self._current_pipeline, current_mask, user_positive, user_loras, params
                        )

                        server.original_image = original_image
                        server.detailed_image = detailed_image
                        server.original_key = server.current_context_key  # 记录 detailer 运行前的 context key
                        server.debug_recover_data = debug_data
                        server.detail_status = 'done'

                        # 添加到历史画廊
                        server.add_history(detailed_image, name=f'Detail #{len(server.selected_history)}')
                        new_key = server.selected_history[-1]['key']
                        server.detailed_key = new_key

                        # 更新 pipeline
                        self._current_pipeline = next_pipeline

                        # 更新 mask server 的图片（与 select_image 相同逻辑：尺寸相同则保留 mask）
                        self._switch_image(server, next_pipeline.image, context_key=new_key)

                        # 清理 prompt 中的 program-sourced 项（parsing tag 保留，在 tag 阶段转换）
                        if server.prompt_server:
                            server.prompt_server.selected_prompts = [
                                p for p in (server.prompt_server.selected_prompts or [])
                                if not (isinstance(p, dict) and p.get('source', 'normal') == 'program')
                            ]
                            server.prompt_server.selected_loras = [
                                l for l in (server.prompt_server.selected_loras or [])
                                if l.get('source', 'normal') != 'program'
                            ] if isinstance(server.prompt_server.selected_loras, list) else []
                            server.prompt_server.selected_prefabs = [
                                p for p in (server.prompt_server.selected_prefabs or [])
                                if p.get('source', 'normal') != 'program'
                            ] if isinstance(server.prompt_server.selected_prefabs, list) else []
                            server.prompt_server.last_selected = [
                                p['text'] if isinstance(p, dict) else p
                                for p in server.prompt_server.selected_prompts
                                if (p.get('source', 'normal') if isinstance(p, dict) else 'normal') != 'program'
                            ]
                            server.prompt_server.last_selected_loras = list(server.prompt_server.selected_loras)
                            server.prompt_server.last_selected_prefabs = list(server.prompt_server.selected_prefabs)
                            server.prompt_server.custom_prompts = ''

                    except Exception as e:
                        # Check if this is a ComfyUI interrupt
                        if mm.processing_interrupted() or 'Interrupt' in type(e).__name__:
                            print("[SnapshotDetailerSampler] Interrupted during detailer")
                            break
                        import traceback
                        traceback.print_exc()
                        server.detail_status = 'error'
                        server.detail_error = str(e)
                    finally:
                        comfy.utils.set_progress_bar_global_hook(orig_hook)
                        server.detail_progress = 1.0 if server.detail_status == 'done' else server.detail_progress

                    gc.collect()
                    mm.soft_empty_cache()

                if act == 'select_image':
                    key = action.get('key', '')
                    img = server.get_history_image(key)
                    if img is not None:
                        self._switch_image(server, img, context_key=key)
                        print(f"[SnapshotDetailerSampler] Selected history image: {key}")

                if act == 'execute_interface':
                    interface_idx = action.get('interface_index', 0)
                    manual_values = action.get('manual_values', {})
                    server.detail_status = 'running'
                    server.detail_error = None
                    server.detail_progress = 0
                    try:
                        self._execute_interface(server, interface_idx, manual_values)
                        server.detail_status = 'done'
                        server.detail_progress = 1.0
                    except Exception as e:
                        if mm.processing_interrupted() or 'Interrupt' in type(e).__name__:
                            print("[SnapshotDetailerSampler] Interrupted during interface execution")
                            break
                        import traceback
                        traceback.print_exc()
                        server.detail_status = 'error'
                        server.detail_error = str(e)
                    finally:
                        gc.collect()
                        mm.soft_empty_cache()

        finally:
            server.stop()

        if server.window_closed and not server.finished:
            raise RuntimeError("[SnapshotDetailerSampler] Window closed without finishing")

        # 如果用户在 finish 时选了历史图片，用它作为最终输出
        if server.finish_selected_keys and len(server.finish_selected_keys) > 1:
            # 多选：收集所有选中的图片，直接存为列表到 pipeline.image
            selected_images = []
            for key in server.finish_selected_keys:
                img = server.get_history_image(key)
                if img is not None:
                    selected_images.append(img)
            if selected_images:
                self._current_pipeline.image = selected_images
        elif server.finish_selected_key:
            img = server.get_history_image(server.finish_selected_key)
            if img is not None:
                self._current_pipeline.image = img

        result = self._current_pipeline
        self._current_pipeline = None

        if result is None:
            raise RuntimeError("[SnapshotDetailerSampler] Pipeline is None")
        return (result,)
