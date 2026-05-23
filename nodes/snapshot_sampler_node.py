import os
import re
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

# Detailer 工具函数（内联，不再引用 sampler_node 中的节点）
from ..libs.image_utils import limit_pixels, recover_size, crop_mask, recover_crop, draw_mask, draw_mask_on_image, batch_images
from ..libs.mask_utils import expand_mask, combine_masks, create_empty_mask, invert_mask
from ..libs.detect_utils import detect_mask
from ..libs.caption_utils import get_tag
from nodes import KSamplerAdvanced, VAEEncode, VAEDecode
import gc


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


def _set_inpaint_mask(resized_image: torch.Tensor, resized_mask: torch.Tensor, vae, grow_mask_by: int = 0):
    """处理 inpaint_mode 下的 mask 与 image 预处理"""
    import math
    downscale_ratio = vae.spacial_compression_encode() if hasattr(vae, 'spacial_compression_encode') else 8
    x = (resized_image.shape[1] // downscale_ratio) * downscale_ratio
    y = (resized_image.shape[2] // downscale_ratio) * downscale_ratio
    resized_mask = torch.nn.functional.interpolate(
        resized_mask.reshape((-1, 1, resized_mask.shape[-2], resized_mask.shape[-1])),
        size=(resized_image.shape[1], resized_image.shape[2]),
        mode="bilinear"
    )
    resized_image = resized_image.clone()
    if resized_image.shape[1] != x or resized_image.shape[2] != y:
        x_offset = (resized_image.shape[1] % downscale_ratio) // 2
        y_offset = (resized_image.shape[2] % downscale_ratio) // 2
        resized_image = resized_image[:, x_offset:x + x_offset, y_offset:y + y_offset, :]
        resized_mask = resized_mask[:, :, x_offset:x + x_offset, y_offset:y + y_offset]
    if grow_mask_by == 0:
        mask_erosion = resized_mask
    else:
        kernel_tensor = torch.ones((1, 1, grow_mask_by, grow_mask_by))
        padding = math.ceil((grow_mask_by - 1) / 2)
        mask_erosion = torch.clamp(
            torch.nn.functional.conv2d(resized_mask.round(), kernel_tensor, padding=padding),
            0, 1
        )
    m = (1.0 - resized_mask.round()).squeeze(1)
    for i in range(3):
        resized_image[:, :, :, i] -= 0.5
        resized_image[:, :, :, i] *= m
        resized_image[:, :, :, i] += 0.5
    t = vae.encode(resized_image)
    tmp_latent = {"samples": t, "noise_mask": mask_erosion[:, :, :x, :y].round()}
    return resized_image, tmp_latent
class SnapshotDetailerSamplerServer:
    """
    Composed server that orchestrates:
      - SnapshotMaskNodeServer   (mask editing iframe)
      - SnapshotPromptServer     (prompt selection iframe)
      - Main HTTP server         (React UI + detailer API)
    """

    def __init__(self, pipeline, seed, detector, tagger, lora_regex="",
                 add_noise="enable", start_step_rate=0.8, end_step_rate=1.0,
                 pixels=1048576, align=8, crop_reserve=32, unique_id=None, context_regex=".+"):
        self.pipeline = pipeline.copy() if pipeline else None
        self.seed = seed
        self.detector = detector
        self.tagger = tagger
        self.tag_result = None
        self.tag_previews = None
        self.lora_regex = lora_regex
        self.lora_path_mode = True
        self.add_noise = add_noise
        self.start_step_rate = start_step_rate
        self.end_step_rate = end_step_rate
        self.pixels = pixels
        self.align = align
        self.crop_reserve = crop_reserve
        self.unique_id = unique_id
        self.context_regex = context_regex

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

        # selected_history: list of {'key', 'src', 'name'} for switch history display
        self.selected_history = []

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

    def _generate_tag_previews(self):
        """Generate three preview images for tag selection: full, mask_crop, covered."""
        if self.current_image is None or self.mask_server is None or self.mask_server.mask is None:
            return {}
        try:
            from ..libs.image_utils import crop_mask
            img = self.current_image
            mask = self.mask_server.mask
            if img.dim() == 3:
                img = img.unsqueeze(0)
            if mask.dim() == 2:
                mask = mask.unsqueeze(0)
            # 1. Full image
            previews = {'full': _tensor_to_base64(img)}
            # 2. Mask crop + 3. Covered
            try:
                cropped_img, cropped_mask, _ = crop_mask(img, mask, reserve=32)
                previews['mask'] = _tensor_to_base64(cropped_img)
                # Covered: mask area keeps original, outside becomes white
                white_bg = torch.ones_like(cropped_img)
                mask_expanded = cropped_mask.unsqueeze(-1).float()
                covered = cropped_img * mask_expanded + white_bg * (1 - mask_expanded)
                previews['covered'] = _tensor_to_base64(covered)
            except Exception as e:
                print(f'[TagPreview] crop failed: {e}')
                previews['mask'] = previews['full']
                previews['covered'] = previews['full']
            return previews
        except Exception as e:
            print(f'[TagPreview] error: {e}')
            return {}

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

    def _sync_widgets(self):
        """Sync current parameter values back to ComfyUI node widgets via PromptServer."""
        if self.unique_id is None:
            return
        try:
            from server import PromptServer
            ps = PromptServer.instance
            if ps is None:
                return
            ps.send_sync("kolid-comfy-widget-set", {
                "node_id": self.unique_id,
                "widget_name": "add_noise",
                "type": "STRING",
                "value": self.add_noise,
            })
            ps.send_sync("kolid-comfy-widget-set", {
                "node_id": self.unique_id,
                "widget_name": "start_step_rate",
                "type": "FLOAT",
                "value": str(self.start_step_rate),
            })
            ps.send_sync("kolid-comfy-widget-set", {
                "node_id": self.unique_id,
                "widget_name": "end_step_rate",
                "type": "FLOAT",
                "value": str(self.end_step_rate),
            })
            ps.send_sync("kolid-comfy-widget-set", {
                "node_id": self.unique_id,
                "widget_name": "pixels",
                "type": "INT",
                "value": str(self.pixels),
            })
            ps.send_sync("kolid-comfy-widget-set", {
                "node_id": self.unique_id,
                "widget_name": "crop_reserve",
                "type": "INT",
                "value": str(self.crop_reserve),
            })
        except Exception as e:
            print(f"[SnapshotDetailerSampler] Widget sync failed: {e}")

    def _apply_params(self, data):
        """Apply parameter overrides from frontend request body."""
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

    def stop(self):
        self.event.set()
        # Stop all servers in background threads to avoid blocking on shutdown()
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
            print(f"[SnapshotDetailerSampler] ===== loop={self.loop_count} =====")
            prompt_parts = []
            for p in ps.selected_prompts:
                if p.startswith('<') and p.endswith('>'):
                    prompt_parts.append(p[1:-1])
                else:
                    prompt_parts.append(p.replace('[', '').replace(']', ''))
            if ps.custom_prompts:
                prompt_parts.append(ps.custom_prompts)
            user_positive = ', '.join(prompt_parts)

            # loras: 直接复用 SnapshotPromptServer 的格式化逻辑
            print(f"[SnapshotDetailerSampler] ps.selected_prompts={ps.selected_prompts}")
            print(f"[SnapshotDetailerSampler] ps.custom_prompts='{ps.custom_prompts}'")
            print(f"[SnapshotDetailerSampler] ps.selected_loras={ps.selected_loras}")
            print(f"[SnapshotDetailerSampler] ps.selected_prefabs={ps.selected_prefabs}")
            user_loras = ps.get_active_loras_string(lora_path_mode=True)
            print(f"[SnapshotDetailerSampler] user_positive='{user_positive}'")
            print(f"[SnapshotDetailerSampler] user_loras='{user_loras}'")

            # --- inline detailer logic ---------------------------------------
            next_pipeline = self.pipeline.copy()
            if next_pipeline.cache is None:
                raise ValueError('PipelineData cache is empty')
            if next_pipeline.model is None:
                raise ValueError('PipelineData model is empty, cannot Detailer')

            context_positive, context_negative, context_loras = next_pipeline.context.get_context(self.context_regex)
            print(f"[SnapshotDetailerSampler] context_positive='{context_positive}'")
            print(f"[SnapshotDetailerSampler] context_negative='{context_negative}'")
            print(f"[SnapshotDetailerSampler] context_loras={context_loras}")

            original_images = [next_pipeline.get_image()]
            image_size = 1
            detailer_mask_start = [0]
            detailer_mask_count = [1]
            detailer_masks = [user_mask]

            detailer_masks[0] = expand_mask(detailer_masks[0], grow=32, blur=32)

            cropped_images = []
            cropped_masks = []
            crop_infos = []
            processing_mapping = []

            for image_index in range(image_size):
                mask_start = detailer_mask_start[image_index]
                mask_count = detailer_mask_count[image_index]
                for mask_index in range(mask_start, mask_start + mask_count):
                    cropped_image, cropped_mask, crop_info = crop_mask(
                        image=original_images[image_index],
                        mask=detailer_masks[mask_index],
                        reserve=self.crop_reserve
                    )
                    processing_mapping.append(image_index)
                    cropped_images.append(cropped_image)
                    cropped_masks.append(cropped_mask)
                    crop_infos.append(crop_info)

            processing_size = len(cropped_images)

            resized_images = []
            resized_masks = []
            resize_infos = []
            tmp_latents = []

            sampler_name = next_pipeline.sampler_name or 'euler'
            scheduler = next_pipeline.scheduler or 'normal'
            steps = next_pipeline.steps or 20
            cfg = next_pipeline.cfg or 8.0

            start_at_step = int(self.start_step_rate * steps)
            end_at_step = int(self.end_step_rate * steps)

            for processing_index in range(processing_size):
                resized_image, resized_mask, resize_info = limit_pixels(
                    image=cropped_images[processing_index],
                    pixels=self.pixels,
                    mask=cropped_masks[processing_index],
                    align=self.align,
                )
                resized_images.append(resized_image)
                resized_masks.append(resized_mask)
                resize_infos.append(resize_info)

                tmp_latent = VAEEncode().encode(
                    vae=next_pipeline.vae,
                    pixels=resized_images[processing_index]
                )[0]
                tmp_latents.append(tmp_latent)

            for processing_index in range(processing_size):
                current_positive = ','.join([p for p in [context_positive, user_positive] if p])
                current_negative = context_negative
                current_loras = context_loras.copy()
                if user_loras:
                    current_loras.extend(get_loras_from_string(user_loras))
                print(f"[SnapshotDetailerSampler] current_positive='{current_positive}'")
                print(f"[SnapshotDetailerSampler] current_negative='{current_negative}'")
                print(f"[SnapshotDetailerSampler] current_loras={current_loras}")

                tmp_positive, tmp_negative, tmp_loras = next_pipeline.context.get_prompt_context('', resized_images[processing_index])
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

                tmp_latent = tmp_latents[processing_index]

                positive_condition = next_pipeline.get_conditioning(
                    mode='positive',
                    clip=clip_to_use,
                    vae=next_pipeline.vae,
                    prompt=current_positive,
                    reference_latent=None,
                    reference_image=resized_images[processing_index],
                    reference=next_pipeline.reference
                )

                negative_condition = next_pipeline.get_conditioning(
                    mode='negative',
                    clip=clip_to_use,
                    vae=next_pipeline.vae,
                    prompt=current_negative,
                    reference_latent=None,
                    reference_image=resized_images[processing_index],
                    reference=next_pipeline.reference
                )

                tmp_latents[processing_index] = KSamplerAdvanced().sample(
                    model=model_to_use,
                    add_noise=self.add_noise,
                    noise_seed=self.seed,
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

            detailed_images = []
            for processing_index in range(processing_size):
                detailed_images.append(
                    VAEDecode().decode(vae=next_pipeline.vae, samples=tmp_latents[processing_index])[0]
                )

            recovered_images = []
            recovered_masks = []
            for processing_index in range(processing_size):
                recovered_image, recovered_mask = recover_size(
                    image=detailed_images[processing_index],
                    resize_info=resize_infos[processing_index],
                    mask=resized_masks[processing_index]
                )
                recovered_images.append(recovered_image)
                recovered_masks.append(recovered_mask)

            final_images = [None]
            final_masks = [None]

            for processing_index in range(processing_size):
                image_index = processing_mapping[processing_index]
                final_images[image_index], final_masks[image_index] = recover_crop(
                    background=original_images[image_index],
                    image=recovered_images[processing_index],
                    crop_info=crop_infos[processing_index],
                    recover_method='mask_blend',
                    mask=recovered_masks[processing_index]
                )

            next_pipeline.image = final_images[0]
            next_pipeline.latent = None

            del cropped_images, cropped_masks, crop_infos
            del resized_images, resized_masks, resize_infos
            del tmp_latents
            del detailed_images, recovered_images, recovered_masks

            gc.collect()
            mm.soft_empty_cache()

            images = final_images
            masks = final_masks

            self.pipeline = next_pipeline
            self.detailed_image = images[0] if images else None
            if self.detailed_image is not None:
                self.pipeline.image = self.detailed_image

            # --- start switch server for result selection ----------------------
            if SnapshotSwitchServer is not None and self.detailed_image is not None:
                try:
                    self.switch_server = SnapshotSwitchServer(
                        input_keys=['original', 'detailed'],
                        input_previews={
                            'original': {'type': 'image', 'data': _tensor_to_base64(self.original_image)},
                            'detailed': {'type': 'image', 'data': _tensor_to_base64(self.detailed_image)},
                        },
                        connection_info={
                            '__node_title__': 'Detailer Result',
                            'original': 'Original',
                            'detailed': 'Detailed',
                        },
                        history=self.selected_history,
                    )
                    t_switch = threading.Thread(target=self.switch_server.start)
                    t_switch.daemon = True
                    t_switch.start()
                    t0 = time.time()
                    while not self.switch_server.started:
                        if time.time() - t0 > 10:
                            print("[SnapshotDetailerSampler] Switch server startup timeout")
                            break
                        time.sleep(0.01)
                    if self.switch_server.started:
                        self.switch_url = self.switch_server.browser_url
                        print(f"[SnapshotDetailerSampler] Switch server at {self.switch_url}")
                except Exception as e:
                    print(f"[SnapshotDetailerSampler] Failed to start switch server: {e}")

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
                    'switch_url': inst.switch_url if inst else '',
                    'loop_count': inst.loop_count if inst else 0,
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
                if inst is None:
                    self._send_json({'error': 'not ready'})
                    return
                previews = inst._generate_tag_previews()
                self._send_json(previews)
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
                length = int(self.headers.get('Content-Length', 0))
                data = json.loads(self.rfile.read(length)) if length else {}
                inst._apply_params(data)
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
                # Determine which image to use based on switch selection or fallback
                selected_key = None
                if inst.switch_server:
                    selected_key = inst.switch_server.selected_key
                use_detailed = data.get('use_detailed', True)
                selected_image = None
                if selected_key == 'detailed' and inst.detailed_image is not None:
                    selected_image = inst.detailed_image
                elif selected_key == 'original':
                    selected_image = inst.current_image
                elif use_detailed and inst.detailed_image is not None:
                    selected_image = inst.detailed_image
                if selected_image is not None:
                    inst.current_image = selected_image.clone()
                    # save selected image to history for next switch display
                    inst.selected_history.append({
                        'key': f'loop_{inst.loop_count}',
                        'src': _tensor_to_base64(selected_image),
                        'name': f'Loop {inst.loop_count} Result',
                    })
                    # limit history to last 10
                    if len(inst.selected_history) > 10:
                        inst.selected_history = inst.selected_history[-10:]
                inst.loop_count += 1
                inst.detailed_image = None
                inst.detail_status = 'idle'
                inst.detail_error = None
                inst.phase = 'edit'
                # 保留 prompt/lora/prefab，但清空 custom_prompts（每次循环独立）
                if inst.prompt_server:
                    inst.prompt_server.last_selected = inst.prompt_server.selected_prompts[:]
                    inst.prompt_server.last_selected_loras = inst.prompt_server.selected_loras[:]
                    inst.prompt_server.last_selected_prefabs = inst.prompt_server.selected_prefabs[:]
                    inst.prompt_server.custom_prompts = ''
                if inst.mask_server:
                    inst.mask_server.image = inst.current_image
                    inst.mask_server.mask = None
                    inst.mask_server.initial_mask = None
                # stop switch server in background to avoid blocking
                if inst.switch_server:
                    def _stop_switch():
                        try:
                            inst.switch_server.stop()
                        except Exception:
                            pass
                    t = threading.Thread(target=_stop_switch)
                    t.daemon = True
                    t.start()
                    inst.switch_server = None
                    inst.switch_url = ''
                self._send_json({'ok': True})
                return

            if self.path == '/api/finish':
                inst.finished = True
                inst.event.set()
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
                    from ..libs.caption_utils import get_tag
                    from ..libs.image_utils import crop_mask
                    tag_image = inst.current_image
                    if inst.mask_server and inst.mask_server.mask is not None:
                        try:
                            img = tag_image
                            mask = inst.mask_server.mask
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
                            # mode == 'full' uses original tag_image
                        except Exception as mask_err:
                            print(f"[RunTag] crop_mask failed, falling back to full: {mask_err}")
                    tag = get_tag(inst.tagger, tag_image)
                    inst.tag_result = tag
                    if inst.prompt_server:
                        inst.prompt_server.custom_prompts = tag
                    self._send_json({'success': True, 'tag': tag})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'success': False, 'error': str(e)})
                return

            if self.path == '/api/auto_tag':
                try:
                    if inst.tagger is None:
                        self._send_json({'success': False, 'error': 'Tagger not configured. Connect a tagger to the node input.'})
                        return
                    from ..libs.caption_utils import get_tag
                    from ..libs.image_utils import crop_mask
                    tag_image = inst.current_image
                    # If user mask is available, crop to the masked region
                    if inst.mask_server and inst.mask_server.mask is not None:
                        try:
                            img = tag_image
                            mask = inst.mask_server.mask
                            if img.dim() == 3:
                                img = img.unsqueeze(0)
                            if mask.dim() == 2:
                                mask = mask.unsqueeze(0)
                            cropped_img, _, _ = crop_mask(img, mask, reserve=32)
                            tag_image = cropped_img
                        except Exception as mask_err:
                            print(f"[AutoTag] crop_mask failed, falling back to full image: {mask_err}")
                    tag = get_tag(inst.tagger, tag_image)
                    if inst.prompt_server:
                        inst.prompt_server.custom_prompts = tag
                    self._send_json({'success': True, 'tag': tag})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'success': False, 'error': str(e)})
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

    def sample(self, pipeline, seed, lora_regex="", context_regex=".+", add_noise="enable",
               start_step_rate=0.8, end_step_rate=1.0, pixels=1048576,
               align=8, crop_reserve=32, detector=None, tagger=None, unique_id=None):
        mm.throw_exception_if_processing_interrupted()

        server = SnapshotDetailerSamplerServer(
            pipeline, seed, detector, tagger, lora_regex,
            add_noise, start_step_rate, end_step_rate, pixels, align, crop_reserve,
            unique_id, context_regex,
        )
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
