import os
import json
import threading
import http.server
import webbrowser
import time
import base64
import io
import numpy as np
from PIL import Image
import torch
import comfy.model_management as mm

# =============================================================================
# Import existing modules (composition, not duplication)
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
    from .sampler_node import PipelineDetailerAdvancedNode, ContextNode, PipelineData
except ImportError as e:
    print(f"[SnapshotDetailerSampler] Warning: cannot import sampler_node: {e}")
    PipelineDetailerAdvancedNode = None
    ContextNode = None
    PipelineData = None


# =============================================================================
# Helpers
# =============================================================================
def _tensor_to_base64(image_tensor: torch.Tensor) -> str:
    """Convert an image tensor [B,H,W,C] or [1,H,W,C] to base64 JPEG data URL."""
    img_array = (image_tensor.squeeze(0).cpu().numpy() * 255).astype(np.uint8)
    img = Image.fromarray(img_array, mode='RGB')
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=90)
    b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
    return f"data:image/jpeg;base64,{b64}"


# =============================================================================
# Main HTTP Server
# =============================================================================
class SnapshotDetailerSamplerServer:
    """
    Composed server that orchestrates:
      - SnapshotMaskNodeServer   (mask editing iframe)
      - SnapshotPromptServer     (prompt selection iframe)
      - Main HTTP server         (React UI + detailer API)
    """

    def __init__(self, pipeline, seed, detector, tagger, lora_regex=""):
        self.pipeline = pipeline.copy() if pipeline else None
        self.seed = seed
        self.detector = detector
        self.tagger = tagger
        self.lora_regex = lora_regex

        self.current_image = pipeline.get_image() if pipeline else None
        self.original_image = None
        self.detailed_image = None

        self.loop_count = 0
        self.phase = 'edit'
        self.detail_status = 'idle'
        self.detail_error = None
        self.finished = False
        self.window_closed = False
        self.event = threading.Event()

        self.mask_server = None
        self.prompt_server = None
        self.main_server = None
        self.main_port = None
        self.mask_url = ""
        self.prompt_url = ""
        self.browser_url = ""
        self.started = False

    # -------------------------------------------------------------------------
    # Lifecycle
    # -------------------------------------------------------------------------
    def start(self):
        # 1) Mask server ------------------------------------------------------
        if SnapshotMaskNodeServer is None:
            raise RuntimeError("SnapshotMaskNodeServer not available")
        self.mask_server = SnapshotMaskNodeServer(
            image=self.current_image,
            detector=self.detector,
        )
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

        # 2) Prompt server ----------------------------------------------------
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
        t_prompt = threading.Thread(target=self.prompt_server.start)
        t_prompt.daemon = True
        t_prompt.start()

        t0 = time.time()
        while not self.prompt_server.started:
            if time.time() - t0 > 10:
                raise RuntimeError("[SnapshotDetailerSampler] Prompt server startup timeout")
            time.sleep(0.01)

        self.prompt_url = self.prompt_server.browser_url

        # 3) Main server ------------------------------------------------------
        for port in range(8700, 8800):
            try:
                self.main_server = http.server.HTTPServer(
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

        try:
            self.main_server.serve_forever()
        except Exception:
            pass

    def stop(self):
        self.event.set()
        if self.mask_server:
            try:
                self.mask_server.stop()
            except Exception:
                pass
        if self.prompt_server:
            try:
                self.prompt_server.stop()
            except Exception:
                pass
        if self.main_server:
            try:
                self.main_server.shutdown()
                self.main_server.server_close()
            except Exception:
                pass

    # -------------------------------------------------------------------------
    # Detailer execution (background thread)
    # -------------------------------------------------------------------------
    def _run_detailer(self):
        self.detail_status = 'running'
        self.detail_error = None
        try:
            # --- read user mask ------------------------------------------------
            user_mask = self.mask_server.mask if self.mask_server else None
            if user_mask is None:
                raise ValueError("Mask not submitted yet. Draw a mask and press Enter.")

            # --- read user prompt ----------------------------------------------
            ps = self.prompt_server
            prompt_parts = []
            for p in ps.selected_prompts:
                if p.startswith('<') and p.endswith('>'):
                    prompt_parts.append(p[1:-1])
                else:
                    prompt_parts.append(p.replace('[', '').replace(']', ''))
            if ps.custom_prompts:
                prompt_parts.append(ps.custom_prompts)
            user_positive = ', '.join(prompt_parts)

            # loras
            lora_parts = []
            for lr in ps.selected_loras:
                if not lr.get('active', True):
                    continue
                fp = lr.get('file_path', '') or lr.get('file_name', '')
                st = lr.get('strength', 1.0)
                fn = lr.get('file_name', '') or fp.split('/')[-1].split('\\')[-1]
                lora_parts.append(f"<lora:{fn}:{st}>")
            user_loras = ', '.join(lora_parts)

            # --- inject temporary context --------------------------------------
            ctx_name = f"__user_detailer__{self.loop_count}"
            self.pipeline.context = ContextNode().process(
                name=ctx_name,
                context=self.pipeline.context,
                positive=user_positive,
                negative="",
                loras=user_loras,
            )[0]

            # --- call PipelineDetailerAdvancedNode -----------------------------
            node = PipelineDetailerAdvancedNode()
            next_pipeline, images, masks, _ = node.detailer(
                pipeline=[self.pipeline],
                bypass=[False],
                need_reference_latent=[False],
                context_regex=[ctx_name],
                add_noise=["enable"],
                seed=[self.seed],
                start_step_rate=[0.8],
                end_step_rate=[1.0],
                return_with_leftover_noise=["disable"],
                detector_threshold=[0.2],
                detector_prompt=[""],
                detector_dilation=[4],
                detector_crop_factor=[1.5],
                detector_drop_size=[0],
                detector_grow=[32],
                detector_blur=[32],
                pixels=[1024 * 1024],
                align=[8],
                crop_reserve=[32],
                recover_method=["mask_blend"],
                inpaint_mode=[False],
                foreach_mask=[False],
                tagger_mask=[False],
                detector=[None],
                tagger=[self.tagger],
                image=None,
                mask=[user_mask],
            )

            self.pipeline = next_pipeline
            self.detailed_image = images[0] if images else None
            if self.detailed_image is not None:
                self.pipeline.image = self.detailed_image
            self.detail_status = 'done'

        except Exception as e:
            import traceback
            print(f"[SnapshotDetailerSampler] Detailer error: {e}")
            traceback.print_exc()
            self.detail_error = str(e)
            self.detail_status = 'error'

    # -------------------------------------------------------------------------
    # HTTP Handler
    # -------------------------------------------------------------------------
    class MainHandler(http.server.SimpleHTTPRequestHandler):
        server_instance = None

        def log_message(self, format, *args):
            pass

        def _send_json(self, data, status=200):
            self.send_response(status)
            self.send_header('Content-type', 'application/json')
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
                    'loop_count': inst.loop_count if inst else 0,
                })
                return

            if self.path == '/api/status':
                self._send_json({
                    'detail_status': inst.detail_status if inst else 'idle',
                    'loop_count': inst.loop_count if inst else 0,
                    'error': getattr(inst, 'detail_error', None),
                })
                return

            if self.path == '/api/has_mask':
                has = inst.mask_server is not None and inst.mask_server.mask is not None
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
                            'original_image': _tensor_to_base64(inst.original_image),
                            'detailed_image': _tensor_to_base64(inst.detailed_image),
                        })
                    except Exception as e:
                        self._send_json({'error': str(e)}, 500)
                else:
                    self._send_json({'error': 'Result not ready'}, 404)
                return

            self.send_error(404)

        def do_POST(self):
            inst = self.server_instance

            if self.path == '/api/run_detail':
                if inst.detail_status == 'running':
                    self._send_json({'started': False, 'error': 'Already running'})
                    return
                if inst.mask_server is None or inst.mask_server.mask is None:
                    self._send_json({
                        'started': False,
                        'error': 'Mask not submitted. Draw a mask and press Enter.'
                    })
                    return
                inst.original_image = inst.current_image.clone()
                inst.detail_status = 'running'
                inst.detail_error = None
                t = threading.Thread(target=inst._run_detailer)
                t.daemon = True
                t.start()
                self._send_json({'started': True})
                return

            if self.path == '/api/next_loop':
                length = int(self.headers.get('Content-Length', 0))
                data = json.loads(self.rfile.read(length)) if length else {}
                use_detailed = data.get('use_detailed', True)
                if use_detailed and inst.detailed_image is not None:
                    inst.current_image = inst.detailed_image
                inst.loop_count += 1
                inst.detailed_image = None
                inst.detail_status = 'idle'
                inst.detail_error = None
                inst.phase = 'edit'
                if inst.mask_server:
                    inst.mask_server.image = inst.current_image
                    inst.mask_server.mask = None
                self._send_json({'ok': True})
                return

            if self.path == '/api/finish':
                inst.finished = True
                inst.event.set()
                self._send_json({'ok': True})
                return

            if self.path == '/window_closed':
                inst.window_closed = True
                inst.event.set()
                self._send_json({'ok': True})
                return

            self.send_error(404)


# =============================================================================
# ComfyUI Node
# =============================================================================
class SnapshotDetailerSamplerNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "lora_regex": ("STRING", {"default": "", "multiline": False}),
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
    def IS_CHANGED(s):
        return float("nan")

    def sample(self, pipeline, seed, lora_regex="", detector=None, tagger=None):
        mm.throw_exception_if_processing_interrupted()

        server = SnapshotDetailerSamplerServer(pipeline, seed, detector, tagger, lora_regex)
        t_server = threading.Thread(target=server.start)
        t_server.daemon = True
        t_server.start()

        # Wait for startup
        t0 = time.time()
        while not server.started:
            mm.throw_exception_if_processing_interrupted()
            if time.time() - t0 > 15:
                server.stop()
                raise RuntimeError("[SnapshotDetailerSampler] Server startup timeout")
            time.sleep(0.01)

        print(f"[SnapshotDetailerSampler] Opening browser at: {server.browser_url}")
        webbrowser.open(server.browser_url)

        # Wait for finish / interrupt / window close
        while not server.event.is_set():
            try:
                mm.throw_exception_if_processing_interrupted()
            except Exception as e:
                if "interrupt" in str(e).lower() or "processing" in str(e).lower():
                    print("[SnapshotDetailerSampler] Interrupted")
                    server.stop()
                    raise RuntimeError("[SnapshotDetailerSampler] Interrupted")
                raise
            if mm.processing_interrupted():
                server.stop()
                raise RuntimeError("[SnapshotDetailerSampler] Interrupted")
            server.event.wait(0.05)

        server.stop()

        if server.window_closed and not server.finished:
            raise RuntimeError("[SnapshotDetailerSampler] Window closed without finishing")

        result = server.pipeline
        if result is None:
            raise RuntimeError("[SnapshotDetailerSampler] Pipeline is None")
        return (result,)
