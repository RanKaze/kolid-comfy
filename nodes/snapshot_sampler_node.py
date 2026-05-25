import os
import re
import json
import threading
import http.server
import socketserver
import webbrowser
import time
import base64
import io
import urllib.request
import numpy as np
from PIL import Image
import torch
import comfy.model_management as mm

# =============================================================================
# 导入现有模块（组合式复用，避免代码重复）
# =============================================================================
try:
    from .image_node import SnapshotMaskNodeServer, waitSnapShot
except ImportError as e:
    print(f"[SnapshotDetailerSampler] Warning: cannot import image_node: {e}")
    SnapshotMaskNodeServer = None
    waitSnapShot = None

try:
    from .prompt_node import SnapshotPromptServer
except ImportError as e:
    print(f"[SnapshotDetailerSampler] Warning: cannot import prompt_node: {e}")
    SnapshotPromptServer = None

try:
    from .switch_node import SnapshotSwitchServer
except ImportError as e:
    print(f"[SnapshotDetailerSampler] Warning: cannot import switch_node: {e}")
    SnapshotSwitchServer = None

try:
    from .sampler_node import ContextNode, PipelineData, get_loras_from_string
except ImportError as e:
    print(f"[SnapshotDetailerSampler] Warning: cannot import sampler_node: {e}")
    ContextNode = None
    PipelineData = None
    get_loras_from_string = None

from ..libs.image_utils import limit_pixels, recover_size, crop_mask, recover_crop, draw_mask, draw_mask_on_image, batch_images, tensor_to_base64, mask_to_base64, set_inpaint_mask
from ..libs.mask_utils import expand_mask, combine_masks, create_empty_mask, invert_mask, parse_mask_base64
from ..libs.detect_utils import detect_mask
from ..libs.caption_utils import get_tag
from nodes import KSamplerAdvanced, VAEEncode, VAEDecode
import gc


# =============================================================================
# SnapshotDetailerSamplerServer：只负责前后端交互，不存储 pipeline
# =============================================================================
class SnapshotDetailerSamplerServer:
    """
    前后端交互服务器，不持有任何业务状态（如 pipeline）。
    所有需要 pipeline/image/mask 的请求都通过 node_instance 委托给 Node 获取。
    职责：
      - 管理 HTTP 子服务器（mask / prompt / switch / main）
      - 提供状态查询 API（phase, detail_status, URLs 等），loop_count 由 Node 管理
      - 提供阻塞等待接口（wait_for_mask / wait_for_prompt / wait_for_switch）
      - 处理前端参数更新（_apply_params / _sync_widgets）
    """

    def __init__(self, detector, tagger, lora_regex,
                 node_instance=None, unique_id=None, config=None):
        """
        注意：构造函数不再接收 pipeline。
        初始图片通过 start(initial_image=...) 传入。
        """
        self.detector = detector
        self.tagger = tagger
        self.lora_regex = lora_regex
        self.node_instance = node_instance  # 业务逻辑委托对象
        self.unique_id = unique_id

        cfg = config or {}
        self.add_noise = cfg.get('add_noise', 'enable')
        self.start_step_rate = cfg.get('start_step_rate', 0.8)
        self.end_step_rate = cfg.get('end_step_rate', 1.0)
        self.pixels = cfg.get('pixels', 1048576)
        self.align = cfg.get('align', 8)
        self.crop_reserve = cfg.get('crop_reserve', 32)

        self.tag_result = None
        self.tag_previews = None
        self.phase = 'edit'
        self.detail_status = 'idle'
        self.detail_error = None
        self.finished = False
        self.window_closed = False
        self.event = threading.Event()
        self.selected_history = []

        # 这些属于前后端交互状态，不是业务对象 pipeline
        self.original_image = None
        self.detailed_image = None
        self.debug_recover_data = None

        self.mask_server = None
        self.prompt_server = None
        self.switch_server = None
        self.main_server = None
        self.main_port = None
        self.mask_url = ""
        self.prompt_url = ""
        self.switch_url = ""
        self.browser_url = ""
        self.started = False

    def _on_mask_set(self, mask, loop_index=None):
        """
        Mask 编辑器 confirm 时的回调。
        Server 不直接修改 pipeline，而是委托给 Node 处理。
        """
        if self.node_instance is not None:
            self.node_instance._on_mask_set(mask, loop_index)

    # -------------------------------------------------------------------------
    # 生命周期：启动 / 停止
    # -------------------------------------------------------------------------
    def start(self, initial_image=None):
        """
        启动所有子服务器。初始图片通过 initial_image 传入，不依赖 pipeline。
        """
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
            prompt_foldout=False,
            lora_regex=self.lora_regex,
            last_selected_loras=[],
            last_selected_prefabs=[],
        )
        self.prompt_server.lora_path_mode = True
        t_prompt = threading.Thread(target=self.prompt_server.start)
        t_prompt.daemon = True
        t_prompt.start()

        t0 = time.time()
        while not self.prompt_server.started:
            if time.time() - t0 > 10:
                raise RuntimeError("[SnapshotDetailerSampler] Prompt server startup timeout")
            time.sleep(0.01)

        self.prompt_url = self.prompt_server.browser_url

        # 3) Switch server（预创建，detailer 完成后才启动）
        if SnapshotSwitchServer is not None:
            self.switch_server = SnapshotSwitchServer(
                input_keys=['original', 'detailed'],
                input_previews={
                    'original': {'type': 'image', 'data': tensor_to_base64(initial_image if initial_image is not None else torch.zeros(1, 512, 512, 3))},
                    'detailed': {'type': 'image', 'data': tensor_to_base64(initial_image if initial_image is not None else torch.zeros(1, 512, 512, 3))},
                },
                connection_info={
                    '__node_title__': 'Detailer Result',
                    'original': 'Original',
                    'detailed': 'Detailed',
                },
                history=self.selected_history,
            )

        # 4) Main server
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
        """停止所有子服务器。"""
        self.event.set()
        # 关闭回调，防止旧服务器的延迟请求修改当前 pipeline
        if self.mask_server:
            self.mask_server._on_mask_set = None
        def _stop_mask():
            if self.mask_server:
                try:
                    self.mask_server.stop()
                except Exception:
                    pass
        def _stop_prompt():
            if self.prompt_server:
                try:
                    self.prompt_server.stop()
                except Exception:
                    pass
        def _stop_main():
            if self.main_server:
                try:
                    self.main_server.shutdown()
                    self.main_server.server_close()
                except Exception:
                    pass
        threads = []
        for fn in (_stop_mask, _stop_prompt, _stop_main):
            t = threading.Thread(target=fn)
            t.daemon = True
            t.start()
            threads.append(t)
        for t in threads:
            t.join(timeout=2.0)

    # -------------------------------------------------------------------------
    # 用户事件等待接口
    # -------------------------------------------------------------------------
    def wait_for_mask(self):
        # 设置当前轮次 token，拒绝来自旧 iframe 的 stale mask 提交
        if self.mask_server is not None:
            self.mask_server.set_expected_loop(str(self.node_instance.get_loop_count() if self.node_instance else 0))
        self.mask_server.screenshot_event.clear()
        self.mask_server.window_closed = False
        if not waitSnapShot(self.mask_server.screenshot_event):
            return False
        if self.finished:
            return False
        return not self.mask_server.window_closed

    def wait_for_prompt(self):
        self.prompt_server.prompt_event.clear()
        self.prompt_server.window_closed = False
        if not waitSnapShot(self.prompt_server.prompt_event):
            return False
        if self.finished:
            return False
        return not self.prompt_server.window_closed

    def start_switch_server(self, original_image, detailed_image):
        if self.switch_server is None:
            return False
        self.switch_server.should_stop = False
        self.switch_server.started = False
        self.switch_server.selection_event.clear()
        self.switch_server.selected_key = None
        self.switch_server.window_closed = False
        self.switch_server.input_previews['original'] = {'type': 'image', 'data': tensor_to_base64(original_image)}
        self.switch_server.input_previews['detailed'] = {'type': 'image', 'data': tensor_to_base64(detailed_image)}

        t_switch = threading.Thread(target=self.switch_server.start)
        t_switch.daemon = True
        t_switch.start()

        t0 = time.time()
        while not self.switch_server.started:
            if time.time() - t0 > 10:
                print("[SnapshotDetailerSampler] Switch server startup timeout")
                return False
            time.sleep(0.01)

        if self.switch_server.started and self.switch_server.browser_url:
            self.switch_url = self.switch_server.browser_url
        return True

    def wait_for_switch(self):
        if self.switch_server is None:
            return True
        if not self.switch_server.wait_for_selection():
            return False
        if self.switch_server.window_closed:
            return False
        if self.finished:
            return False
        return True

    def stop_switch_server(self):
        if self.switch_server:
            self.switch_server.stop()
        self.switch_url = ''

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
        return dirty

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

            if self.path == '/api/config':
                self._send_json({
                    'mask_url': inst.mask_url if inst else '',
                    'prompt_url': inst.prompt_url if inst else '',
                    'switch_url': inst.switch_url if inst else '',
                    'loop_count': inst.node_instance.get_loop_count() if inst and inst.node_instance else 0,
                    'add_noise': inst.add_noise if inst else 'enable',
                    'start_step_rate': inst.start_step_rate if inst else 0.8,
                    'end_step_rate': inst.end_step_rate if inst else 1.0,
                    'pixels': inst.pixels if inst else 1048576,
                    'crop_reserve': inst.crop_reserve if inst else 32,
                    'has_tagger': inst.tagger is not None if inst else False,
                })
                return

            if self.path == '/api/status':
                self._send_json({
                    'detail_status': inst.detail_status if inst else 'idle',
                    'phase': inst.phase if inst else 'edit',
                    'loop_count': inst.node_instance.get_loop_count() if inst and inst.node_instance else 0,
                    'switch_url': inst.switch_url if inst else '',
                    'error': getattr(inst, 'detail_error', None),
                })
                return

            if self.path == '/api/has_mask':
                # 使用 peek_mask() 而非 get_mask()：状态查询不能消费队列中的 mask
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
                        })
                    except Exception as e:
                        self._send_json({'error': str(e)}, 500)
                else:
                    self._send_json({'error': 'Result not ready'}, 404)
                return

            if self.path == '/api/switch_status':
                if inst and inst.switch_server:
                    self._send_json({
                        'selected': inst.switch_server.selected_key,
                        'window_closed': inst.switch_server.window_closed,
                    })
                else:
                    self._send_json({'selected': None, 'window_closed': False})
                return

            if self.path == '/api/tag_previews':
                if inst is None or inst.node_instance is None:
                    self._send_json({'error': 'not ready'})
                    return
                # 通过 node_instance 获取当前 pipeline，Server 不存储 pipeline
                pipeline = inst.node_instance.get_current_pipeline()
                # 使用 peek_mask() 而非 get_mask()：/api/tag_previews 只是预览，不能消费队列中的 mask
                mask = inst.mask_server.peek_latest_mask() if inst.mask_server else None
                print(f"[DEBUG] /api/tag_previews: peek_latest_mask shape={mask.shape if mask is not None else None}, sum={mask.sum().item() if mask is not None else 'N/A'}")
                print(f"[DEBUG] /api/tag_previews: pipeline.mask shape={pipeline.mask.shape if pipeline and pipeline.mask is not None else None}, same_tensor={mask is (pipeline.mask if pipeline else None)}")
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

            if self.path == '/api/finish':
                inst.finished = True
                inst.event.set()
                # 唤醒所有可能正在阻塞的 Phase，让循环立即退出
                if inst.mask_server:
                    inst.mask_server.screenshot_event.set()
                if inst.prompt_server:
                    inst.prompt_server.prompt_event.set()
                if inst.switch_server:
                    inst.switch_server.selection_event.set()
                self._send_json({'ok': True})
                return

            if self.path == '/api/run_tag':
                try:
                    if inst.tagger is None:
                        self._send_json({'success': False, 'error': 'Tagger not configured'})
                        return
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    mode = body.get('mode', 'mask')
                    # 通过 node_instance 获取当前 pipeline，Server 不存储 pipeline
                    tag = ''
                    if inst.node_instance:
                        pipeline = inst.node_instance.get_current_pipeline()
                        # 使用 pipeline.mask 而非 get_mask()：run_tag 发生在 mask phase 之后，
                        # mask 已经被消费并保存到 pipeline 中；get_mask() 会再次消费队列
                        mask = pipeline.mask if pipeline else None
                        print(f"[DEBUG] /api/run_tag ({mode}): mask shape={mask.shape if mask is not None else None}, sum={mask.sum().item() if mask is not None else 'N/A'}")
                        tag = inst.node_instance._run_tag(pipeline, mask, inst.tagger, mode)
                    inst.tag_result = tag
                    if inst.prompt_server:
                        inst.prompt_server.custom_prompts = tag
                    self._send_json({'success': True, 'tag': tag})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'success': False, 'error': str(e)})
                finally:
                    pass
                return

            if self.path == '/window_closed':
                inst.window_closed = True
                inst.event.set()
                self._send_json({'ok': True})
                return

            self.send_error(404)



# =============================================================================
# SnapshotDetailerSamplerNode：包含所有主要业务逻辑，管理 pipeline 生命周期
# =============================================================================
class SnapshotDetailerSamplerNode:
    """
    ComfyUI 节点：Snapshot Detailer Sampler。
    职责：
      - 管理 pipeline 生命周期（存储在 self._current_pipeline）
      - 包含 detailer 核心采样逻辑（_run_detailer）
      - 包含 tag 生成和预览逻辑（_generate_tag_previews / _run_tag）
      - 驱动整个交互循环（sample 方法中的 mask -> prompt -> detailer -> switch）
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
            }
        }

    RETURN_TYPES = ("PIPELINE_DATA",)
    RETURN_NAMES = ("pipeline",)
    FUNCTION = "sample"
    CATEGORY = "sampling/custom"

    @classmethod
    def IS_CHANGED(s, **kwargs):
        return float("nan")

    # -------------------------------------------------------------------------
    # Pipeline 状态管理（Node 持有，Server 不存储）
    # -------------------------------------------------------------------------
    def get_current_pipeline(self):
        """供 Server 的 HTTP handler 调用，获取当前 pipeline。"""
        return getattr(self, '_current_pipeline', None)

    def get_current_mask(self):
        """供 Server 的 HTTP handler 调用，获取当前 mask。"""
        return self._current_pipeline.mask if self._current_pipeline is not None else None

    def get_loop_count(self):
        """供 Server 的 HTTP handler 调用，获取当前循环计数。"""
        return getattr(self, '_loop_count', 0)

    def _on_mask_set(self, mask, loop_index=None):
        """
        Server 的 mask confirm 回调委托到这里。
        Node 直接修改 self._current_pipeline.mask。
        使用 clone 切断引用，避免多线程共享 tensor 导致意外修改。
        重要：校验 loop_index 必须匹配当前 _loop_count，防止非 mask phase 期间的
        stale mask 提交错误覆盖 pipeline.mask（例如在 prompt/tag/switch phase 时
        _expected_loop 尚未更新，handleMask 可能放行旧 loop 的 mask）。
        """
        pm = self._current_pipeline.mask if self._current_pipeline is not None else None
        print(f"[MASK-TRACE] _on_mask_set ENTER | loop={loop_index} | incoming mask id={id(mask)}, shape={mask.shape if mask is not None else None}, sum={mask.sum().item() if mask is not None else 'N/A'} | pipeline.mask id={id(pm)}, shape={pm.shape if pm is not None else None}, sum={pm.sum().item() if pm is not None else 'N/A'}")
        if loop_index is not None and loop_index != self._loop_count:
            print(f"[MASK-TRACE] _on_mask_set REJECTED | received loop_index={loop_index}, current _loop_count={self._loop_count}")
            return
        if self._current_pipeline is not None:
            self._current_pipeline.mask = mask.clone() if mask is not None else None
            pm2 = self._current_pipeline.mask
            print(f"[MASK-TRACE] _on_mask_set DONE | loop={loop_index} | pipeline.mask now id={id(pm2)}, shape={pm2.shape if pm2 is not None else None}, sum={pm2.sum().item() if pm2 is not None else 'N/A'}")

    # -------------------------------------------------------------------------
    # 业务逻辑：Tag 相关
    # -------------------------------------------------------------------------
    def _generate_tag_previews(self, pipeline, mask):
        """
        为 Tag 阶段生成三种预览图：
          - full   : 原图全貌
          - mask   : 按 mask 裁剪后的区域
          - covered: mask 区域内保留原图，区域外填充白色
        参数：
          pipeline : PipelineData 实例（由 Node 传入，不从 Server 读取）
          mask     : mask tensor
        返回 dict，供前端 /api/tag_previews 接口使用。
        """
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
        """
        运行 tagger 生成 prompt。返回 tag 字符串。
        参数：
          pipeline : PipelineData 实例（由 Node 传入，不从 Server 读取）
          mask     : mask tensor
          tagger   : 外部 tagger 节点
          mode     : 'mask' / 'covered' / 'full'
        """
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
    # 业务逻辑：Prompt 解析
    # -------------------------------------------------------------------------
    def _parse_prompt(self, prompt_server):
        """从 prompt_server 解析用户选择的 positive prompt 和 lora 字符串。"""
        user_positive = ''
        user_loras = ''
        if prompt_server:
            selected = prompt_server.selected_prompts
            custom = prompt_server.custom_prompts
            parts = []
            for p in selected:
                if p.startswith('<') and p.endswith('>'):
                    parts.append(p[1:-1])
                else:
                    parts.append(p)
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
    # 业务逻辑：Switch 结果应用
    # -------------------------------------------------------------------------
    def _apply_switch_selection(self, pipeline, selected, original_image, detailed_image, selected_history):
        """根据用户在 switch 界面的选择，更新 pipeline.image。"""
        if selected == 'original':
            pipeline.image = original_image.clone() if original_image is not None else None
        elif selected == 'detailed' or not selected:
            pipeline.image = detailed_image.clone() if detailed_image is not None else None
        else:
            selected_image = None
            for h in selected_history:
                if h.get('key') == selected:
                    src = h.get('src', '')
                    b64_data = src.split(',', 1)[1] if ',' in src else src
                    img_bytes = base64.b64decode(b64_data)
                    img = Image.open(io.BytesIO(img_bytes))
                    if img.mode != 'RGB':
                        img = img.convert('RGB')
                    arr = np.array(img).astype(np.float32) / 255.0
                    selected_image = torch.from_numpy(arr).unsqueeze(0)
                    break
            if selected_image is not None:
                pipeline.image = selected_image
                print(f"[SnapshotDetailerSampler] User selected history image: {selected}")
            else:
                pipeline.image = detailed_image.clone() if detailed_image is not None else None
                print(f"[SnapshotDetailerSampler] Unknown selection '{selected}', fallback to detailed")
        return pipeline

    # -------------------------------------------------------------------------
    # 业务逻辑：Detailer 核心采样
    # -------------------------------------------------------------------------
    def _run_detailer(self, pipeline, user_mask, user_positive, user_loras, params):
        """
        执行完整的 detailer 采样流水线。
        参数：
          pipeline      : 当前 PipelineData（由 Node 传入，不从 Server 读取）
          user_positive : 用户输入的 positive prompt
          user_loras    : 用户选择的 lora 字符串
          params        : dict，包含采样参数
        返回: (next_pipeline, original_image, detailed_image, debug_recover_data)
        注意：next_pipeline.mask 已被设为 full-size 最终 mask，供下一轮使用。
        """
        seed = params['seed']
        add_noise = params['add_noise']
        start_step_rate = params['start_step_rate']
        end_step_rate = params['end_step_rate']
        pixels = params['pixels']
        align = params['align']
        crop_reserve = params['crop_reserve']
        context_regex = params['context_regex']
        loop_count = params.get('loop_count', 0)  # 仅用于打印

        next_pipeline = pipeline.copy()
        npm = next_pipeline.mask
        print(f"[MASK-TRACE] _run_detailer: after pipeline.copy() | next_pipeline.mask id={id(npm)}, shape={npm.shape if npm is not None else None}, sum={npm.sum().item() if npm is not None else 'N/A'}")
        if next_pipeline.cache is None:
            raise ValueError('PipelineData cache is empty')
        if next_pipeline.model is None:
            raise ValueError('PipelineData model is empty, cannot Detailer')

        context_positive, context_negative, context_loras = next_pipeline.context.get_context(context_regex)
        print(f"[SnapshotDetailerSampler] context_positive='{context_positive}'")
        print(f"[SnapshotDetailerSampler] context_negative='{context_negative}'")
        print(f"[SnapshotDetailerSampler] context_loras={context_loras}")

        original_image = next_pipeline.get_image()
        if original_image is None:
            raise ValueError("No image available for detailer")

        # ====== 单 mask 处理流程 ======
        if user_mask is not None:
            user_mask = user_mask.clone()
        print(f"[DEBUG] _run_detailer START: user_mask id={id(user_mask)}, shape={user_mask.shape if user_mask is not None else None}, sum={user_mask.sum().item() if user_mask is not None else 'N/A'}")
        expanded_mask = expand_mask(user_mask, grow=32, blur=32)
        print(f"[DEBUG] _run_detailer after expand_mask: expanded_mask id={id(expanded_mask)}, sum={expanded_mask.sum().item():.1f}")

        cropped_image, cropped_mask, crop_info = crop_mask(
            image=original_image,
            mask=expanded_mask,
            reserve=crop_reserve
        )
        print(f"[DEBUG] _run_detailer after crop_mask: cropped_mask id={id(cropped_mask)}, sum={cropped_mask.sum().item():.1f}")

        resized_image, resized_mask, resize_info = limit_pixels(
            image=cropped_image,
            pixels=pixels,
            mask=cropped_mask,
            align=align,
        )
        print(f"[DEBUG] _run_detailer after limit_pixels: resized_mask id={id(resized_mask)}, sum={resized_mask.sum().item():.1f}")

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
        
        print(f"[SnapshotDetailerSampler] current_positive='{current_positive}'")
        print(f"[SnapshotDetailerSampler] current_negative='{current_negative}'")
        print(f"[SnapshotDetailerSampler] current_loras={current_loras}")

        tmp_positive, tmp_negative, tmp_loras = next_pipeline.context.get_prompt_context('', resized_image)
        if tmp_positive is not None:
            current_positive += ',' + tmp_positive
        if tmp_negative is not None:
            current_negative += ',' + tmp_negative
        if tmp_loras is not None:
            current_loras.extend(tmp_loras)

        model_to_use, clip_to_use = next_pipeline.cache.get_model_clip(
            model=next_pipeline.model,
            clip=next_pipeline.clip,
            loras=current_loras
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

        sampled_latent = KSamplerAdvanced().sample(
            model=model_to_use,
            add_noise=add_noise,
            noise_seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler=scheduler,
            positive=positive_condition,
            negative=negative_condition,
            latent_image=tmp_latent,
            start_at_step=start_at_step,
            end_at_step=end_at_step,
            return_with_leftover_noise='disable'
        )[0]

        decoded_image = VAEDecode().decode(vae=next_pipeline.vae, samples=sampled_latent)[0]

        recovered_image, recovered_mask = recover_size(
            image=decoded_image,
            resize_info=resize_info,
            mask=resized_mask
        )
        print(f"[DEBUG] _run_detailer after recover_size: recovered_mask id={id(recovered_mask)}, sum={recovered_mask.sum().item():.1f}")

        final_image, final_mask = recover_crop(
            background=original_image,
            image=recovered_image,
            crop_info=crop_info,
            recover_method='mask_blend',
            mask=recovered_mask
        )
        print(f"[DEBUG] _run_detailer after recover_crop: final_mask id={id(final_mask)}, sum={final_mask.sum().item():.1f}")

        # detailed_image 保持与原多 mask 版本一致的语义：recover_crop 后的 full-size 图像
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

        # 将 full-size 最终 mask 放入 pipeline.mask，供下一轮作为初始 mask
        print(f"[MASK-TRACE] _run_detailer: before assignment | next_pipeline.mask id={id(next_pipeline.mask)}, sum={next_pipeline.mask.sum().item() if next_pipeline.mask is not None else 'N/A'}")
        next_pipeline.image = final_image
        next_pipeline.latent = None
        next_pipeline.mask = final_mask
        print(f"[MASK-TRACE] _run_detailer: after assignment | next_pipeline.mask id={id(next_pipeline.mask)}, sum={next_pipeline.mask.sum().item() if next_pipeline.mask is not None else 'N/A'}")

        gc.collect()
        mm.soft_empty_cache()

        return next_pipeline, original_image, detailed_image, debug_recover_data

    # -------------------------------------------------------------------------
    # ComfyUI 节点执行入口
    # -------------------------------------------------------------------------
    def sample(self, pipeline, seed, lora_regex="", context_regex=".+", add_noise="enable",
               start_step_rate=0.8, end_step_rate=1.0, pixels=1048576,
               align=8, crop_reserve=32, detector=None, tagger=None, unique_id=None):
        """
        ComfyUI 节点执行入口。
        pipeline 的生命周期完全由 Node 管理，Server 不存储 pipeline。
        流程：
          1. Node 初始化 self._current_pipeline
          2. 创建 Server（不传 pipeline）
          3. Server.start(initial_image=...) 传入初始图片
          4. Node 驱动主循环，通过 self._current_pipeline 传递业务状态
          5. Server 只负责前后端交互（等待用户、返回状态）
        """
        mm.throw_exception_if_processing_interrupted()

        # ---------- 1. Node 初始化状态 ----------
        self._current_pipeline = pipeline.copy() if pipeline else None
        self._loop_count = 0

        # ---------- 2. 创建 Server，不传 pipeline ----------
        server = SnapshotDetailerSamplerServer(
            detector=detector,
            tagger=tagger,
            lora_regex=lora_regex,
            node_instance=self,
            unique_id=unique_id,
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

        # 等待启动
        t0 = time.time()
        while not server.started:
            mm.throw_exception_if_processing_interrupted()
            if time.time() - t0 > 15:
                server.stop()
                raise RuntimeError("[SnapshotDetailerSampler] Server startup timeout")
            time.sleep(0.01)

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
                # 检查中断
                try:
                    mm.throw_exception_if_processing_interrupted()
                except Exception as e:
                    if "interrupt" in str(e).lower() or "processing" in str(e).lower():
                        print("[SnapshotDetailerSampler] Interrupted")
                        break
                    raise
                if mm.processing_interrupted():
                    print("[SnapshotDetailerSampler] Interrupted")
                    break

                # ============================================================
                # Phase 1: Mask
                # ============================================================
                server.phase = 'mask'
                server.detail_status = 'idle'
                server.detail_error = None
                pm = self._current_pipeline.mask
                print(f"[PHASE-TRACE] Loop {self._loop_count} ENTER mask | pipeline.mask id={id(pm)}, shape={pm.shape if pm is not None else None}, sum={pm.sum().item() if pm is not None else 'N/A'}")
                print(f"[SnapshotDetailerSampler] Loop {self._loop_count}: waiting for mask...")
                if not server.wait_for_mask():
                    print("[SnapshotDetailerSampler] Interrupted during mask phase")
                    break
                
                user_mask = server.mask_server.get_mask_for_loop(self._loop_count)
                if user_mask is not None:
                    user_mask = user_mask.clone()
                    print(f"[SnapshotDetailerSampler] Loop {self._loop_count}: mask consumed from server, shape={user_mask.shape}, sum={user_mask.sum().item()}")
                else:
                    print(f"[SnapshotDetailerSampler] Loop {self._loop_count}: WARNING - no mask from server, using pipeline.mask as fallback")
                    # 防御性 fallback：如果 server 没有返回 mask，使用 pipeline 中已有的 mask
                    # 这种情况理论上不应发生，但为了防止竞争导致空指针
                    user_mask = self._current_pipeline.mask
                    if user_mask is not None:
                        user_mask = user_mask.clone()
                        print(f"[SnapshotDetailerSampler] Loop {self._loop_count}: fallback mask shape={user_mask.shape}, sum={user_mask.sum().item()}")
                self._current_pipeline.mask = user_mask
                print(f"[DEBUG] After wait_for_mask: pipeline.mask shape={self._current_pipeline.mask.shape if self._current_pipeline.mask is not None else None}")
                print(f"[DEBUG] After wait_for_mask: mask_server has mask? {server.mask_server.peek_latest_mask() is not None}")
                
                pipeline_mask = self._current_pipeline.mask

                print(f"[DEBUG] Loop {self._loop_count} - User Mask | shape={user_mask.shape if user_mask is not None else None} | sum={user_mask.sum().item() if user_mask is not None else 0}")
                print(f"[DEBUG] Loop {self._loop_count} - Pipeline Mask | shape={pipeline_mask.shape if pipeline_mask is not None else None} | sum={pipeline_mask.sum().item() if pipeline_mask is not None else 0}")
                print(f"[DEBUG] Are they the same object? {user_mask is pipeline_mask}")

                # ============================================================
                # Phase 2: Prompt
                # ============================================================
                server.phase = 'prompt'
                pm = self._current_pipeline.mask
                print(f"[PHASE-TRACE] Loop {self._loop_count} ENTER prompt | pipeline.mask id={id(pm)}, shape={pm.shape if pm is not None else None}, sum={pm.sum().item() if pm is not None else 'N/A'}")
                print(f"[SnapshotDetailerSampler] Loop {self._loop_count}: waiting for prompt...")
                if not server.wait_for_prompt():
                    print("[SnapshotDetailerSampler] Interrupted during prompt phase")
                    break

                user_positive, user_loras = self._parse_prompt(server.prompt_server)

                # ============================================================
                # Phase 3: Detailer
                # ============================================================
                server.phase = 'waiting'
                server.detail_status = 'running'
                server.detail_error = None
                pm = self._current_pipeline.mask
                print(f"[PHASE-TRACE] Loop {self._loop_count} ENTER waiting/detailer | pipeline.mask id={id(pm)}, shape={pm.shape if pm is not None else None}, sum={pm.sum().item() if pm is not None else 'N/A'}")
                print(f"[SnapshotDetailerSampler] Loop {self._loop_count}: running detailer...")

                try:
                    # 重新从 pipeline 获取 mask，防止用户在 prompt/tag 阶段更新 mask 后使用旧值
                    current_mask = self._current_pipeline.mask
                    if current_mask is not None:
                        current_mask = current_mask.clone()
                    print(f"[DEBUG] Before detailer: current_mask shape={current_mask.shape if current_mask is not None else None}, sum={current_mask.sum().item() if current_mask is not None else 'N/A'}")
                    peek = server.mask_server.peek_latest_mask()
                    print(f"[DEBUG] Before detailer: mask_server.peek_mask shape={peek.shape if peek is not None else None}")
                    print(f"[DEBUG] Before detailer: are they same tensor? {current_mask is peek}")
                    next_pipeline, original_image, detailed_image, debug_data = self._run_detailer(
                        self._current_pipeline, current_mask, user_positive, user_loras,
                        {**params, 'loop_count': self._loop_count}
                    )
                    npm = next_pipeline.mask
                    print(f"[PHASE-TRACE] Loop {self._loop_count} DETAILER DONE | next_pipeline.mask id={id(npm)}, shape={npm.shape if npm is not None else None}, sum={npm.sum().item() if npm is not None else 'N/A'}")
                    server.original_image = original_image
                    server.detailed_image = detailed_image
                    server.debug_recover_data = debug_data
                    server.detail_status = 'done'
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    server.detail_status = 'error'
                    server.detail_error = str(e)
                    continue

                # ============================================================
                # Phase 4: Switch
                # ============================================================
                server.phase = 'switch'
                npm = next_pipeline.mask
                print(f"[PHASE-TRACE] Loop {self._loop_count} ENTER switch | next_pipeline.mask id={id(npm)}, shape={npm.shape if npm is not None else None}, sum={npm.sum().item() if npm is not None else 'N/A'}")
                print(f"[SnapshotDetailerSampler] Loop {self._loop_count}: waiting for switch selection...")

                if server.switch_server is not None:
                    server.start_switch_server(server.original_image, server.detailed_image)

                    if not server.wait_for_switch():
                        print("[SnapshotDetailerSampler] Interrupted during switch phase")
                        break

                    server.stop_switch_server()

                    selected = server.switch_server.selected_key
                    next_pipeline = self._apply_switch_selection(
                        next_pipeline, selected, server.original_image, server.detailed_image, server.selected_history
                    )

                # ============================================================
                # Phase 5: Next loop
                # ============================================================
                self._loop_count += 1
                if server.mask_server:
                    server.mask_server.set_expected_loop(str(self._loop_count))
                npm = next_pipeline.mask if next_pipeline is not None else None
                print(f"[PHASE-TRACE] Loop {self._loop_count - 1} END → next loop {self._loop_count} | next_pipeline.mask id={id(npm)}, shape={npm.shape if npm is not None else None}, sum={npm.sum().item() if npm is not None else 'N/A'}")
                print(f"[SnapshotDetailerSampler] Next loop: {self._loop_count}")

                if next_pipeline is not None and next_pipeline.image is not None:
                    server.selected_history.append({
                        'key': f'loop_{self._loop_count - 1}',
                        'src': tensor_to_base64(next_pipeline.image),
                        'name': f'Loop {self._loop_count - 1} Result',
                    })
                    if len(server.selected_history) > 10:
                        server.selected_history = server.selected_history[-10:]

                if server.mask_server:
                    server.mask_server.set_image(next_pipeline.image if next_pipeline is not None else None)
                    server.mask_server.clear()

                self._current_pipeline = next_pipeline
                pm = self._current_pipeline.mask if self._current_pipeline is not None else None
                print(f"[PHASE-TRACE] Loop {self._loop_count} START | _current_pipeline.mask id={id(pm)}, shape={pm.shape if pm is not None else None}, sum={pm.sum().item() if pm is not None else 'N/A'}")

                if server.prompt_server:
                    server.prompt_server.last_selected = server.prompt_server.selected_prompts[:]
                    server.prompt_server.last_selected_loras = server.prompt_server.selected_loras[:]
                    server.prompt_server.last_selected_prefabs = server.prompt_server.selected_prefabs[:]
                    server.prompt_server.selected_prompts = []
                    server.prompt_server.selected_loras = []
                    server.prompt_server.selected_prefabs = []
                    server.prompt_server.custom_prompts = ''

                server.detailed_image = None
                server.detail_status = 'idle'
                server.detail_error = None
                server.original_image = None

                gc.collect()
                mm.soft_empty_cache()

        finally:
            server.stop()

        if server.window_closed and not server.finished:
            raise RuntimeError("[SnapshotDetailerSampler] Window closed without finishing")

        result = self._current_pipeline
        self._current_pipeline = None
        self._loop_count = 0

        if result is None:
            raise RuntimeError("[SnapshotDetailerSampler] Pipeline is None")
        return (result,)
