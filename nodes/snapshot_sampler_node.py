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
from PIL import Image
import torch
import comfy.model_management as mm

# =============================================================================
# 导入现有模块
# =============================================================================
from ..libs.utils import AlwaysEqualProxy

try:
    from .prompt_node import SnapshotPromptServer, SnapshotPromptNode
except ImportError as e:
    print(f"[SnapshotDetailerSampler] Warning: cannot import prompt_node: {e}")
    SnapshotPromptServer = None
    SnapshotPromptNode = None

from ..libs.image_utils import limit_pixels, recover_size, crop_mask, recover_crop, tensor_to_base64, composite_layers, decode_mask_alpha, decode_decal_rgba, decode_image_dataurl, merge_mask_alpha
from ..libs.mask_utils import expand_mask
from ..libs.caption_utils import get_tag
from nodes import KSamplerAdvanced, VAEEncode, VAEDecode
from .sampler_node import get_loras_from_string
from ..architecture import Krea2 as arch_krea2, Flux2Klein as arch_flux2klein, QwenImage21 as arch_qwen_image21
import gc


# =============================================================================
# Detailer 产出回贴几何（Recover Crop 关闭时）
# =============================================================================
def detail_place_rect(crop_info, patch=None):
    """crop_info + 产出图 → Blend 画布把它贴回原位所需的全部几何。

    坐标链（每一步都在压缩这幅图，贴回去就是原路反演）：

        original_image (ow x oh)                 ← Blend 画布，run 时的 context
          └ crop_mask  → cropped image (cw x ch)，左上角落在 (crop_x, crop_y)
              └ limit_pixels → patch (pw x ph)   ← 模型真正跑的工作分辨率，sx/sy 是这一步的缩放比

    注意 limit_pixels 是**会放大**的（当前像素数小于目标时按 aspect 放大并对齐 align），
    所以 pw x ph 通常既不等于 cw x ch，也不是同一边长比例：pw/ph 只能近似 cx 的比例。
    唯一的硬约束是「整张 patch 必须盖满 crop 矩形的 cw x ch」——这正是开着 Recover Crop
    时 recover_size + recover_crop 的结果（recover_size 先把 patch 拉回 cw x ch，再由
    recover_crop 贴到 [crop_y:, crop_x:]），两条路径必须在画布上得到同一个矩形。

    于是这里给出的不是一个画好的 transform，而是让前端自己算的原始量：crop 矩形用
    **这次 run 的原始图像素**表示（ow/oh 同单位），外加 patch 自身尺寸与缩放比便于核对。
    纯算术、不依赖 torch，方便单测。
    """
    info = crop_info or {}
    ow = int(info.get('original_width') or 0)
    oh = int(info.get('original_height') or 0)
    if ow <= 0 or oh <= 0:
        return None
    x = int(info.get('crop_x') or 0)
    y = int(info.get('crop_y') or 0)
    # 缺 crop_width/height 时退回整图（对齐 crop_mask 的空 mask 分支语义）
    w = int(info.get('crop_width') or ow)
    h = int(info.get('crop_height') or oh)
    # 夹回原图范围：crop_mask 正常不会越界，但越界会把 patch 贴到画布外
    x = max(0, min(x, ow - 1))
    y = max(0, min(y, oh - 1))
    w = max(1, min(w, ow - x))
    h = max(1, min(h, oh - y))

    pw, ph = 0, 0
    if patch is not None and hasattr(patch, 'shape') and len(patch.shape) >= 3:
        ph = int(patch.shape[-3])
        pw = int(patch.shape[-2])

    return {
        'x': x, 'y': y, 'w': w, 'h': h,     # crop 矩形，单位 = 本次 run 的原始图像素
        'ow': ow, 'oh': oh,                 # 同一幅原始图的尺寸（= run 时的画布尺寸）
        'pw': pw, 'ph': ph,                 # 返回的 patch 自身像素尺寸
        'sx': (pw / w) if w else 0.0,       # limit_pixels 施加的缩放比，供前端核对
        'sy': (ph / h) if h else 0.0,
    }


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
        self.interface_packages = []
        self.pipeline_packages = []
        if package is not None:
            # Robust flattening: package may be a dict, a list of dicts, or a nested list
            flat = []
            if isinstance(package, dict):
                flat = [package]
            elif isinstance(package, list):
                for p in package:
                    if isinstance(p, dict):
                        flat.append(p)
                    elif isinstance(p, list):
                        flat.extend([x for x in p if isinstance(x, dict)])
            self.packages = flat
            for p in self.packages:
                if p.get("type") == "pipeline":
                    self.pipeline_packages.append(p)
                else:
                    self.interface_packages.append(p)
            print(f"[SnapshotDetailerSampler] package input: type={type(package).__name__}, "
                  f"len={len(package) if isinstance(package, (list, dict)) else 1}, "
                  f"total={len(self.packages)}, interface={len(self.interface_packages)}, pipeline={len(self.pipeline_packages)}")

        cfg = config or {}
        self.add_noise = cfg.get('add_noise', 'enable')
        self.start_step_rate = cfg.get('start_step_rate', 0.8)
        self.end_step_rate = cfg.get('end_step_rate', 1.0)
        self.pixels = cfg.get('pixels', 1048576)
        self.align = cfg.get('align', 8)
        self.crop_reserve = cfg.get('crop_reserve', 32)
        self.mask_grow = cfg.get('mask_grow', 32)
        self.mask_blur = cfg.get('mask_blur', 32)
        self.enable_edit = cfg.get('enable_edit', False)
        self.edit_mode = cfg.get('edit_mode', 'fit')
        self.ref_boost = cfg.get('ref_boost', 4.0)
        self.ref_boost_a = cfg.get('ref_boost_a', 1.0)
        self.enable_ref_boost_mask = cfg.get('enable_ref_boost_mask', False)
        self.grounding_px = cfg.get('grounding_px', 768)
        self.context_reference = cfg.get('context_reference', False)
        self.context_reference_key = cfg.get('context_reference_key', None)

        # Pipeline Block chain (default: single Detailer block from INPUT_TYPES defaults)
        self.blocks = cfg.get('blocks')
        if not self.blocks:
            self.blocks = [{
                'id': 'block-1',
                'type': 'detailer',
                'name': 'Detailer',
                'params': {
                    'add_noise': self.add_noise,
                    'start_step_rate': self.start_step_rate,
                    'end_step_rate': self.end_step_rate,
                    'pixels': self.pixels,
                    'align': self.align,
                    'crop_reserve': self.crop_reserve,
                    'recover_crop': True,
                    'enable_edit': self.enable_edit,
                    'edit_mode': self.edit_mode,
                    'ref_boost': self.ref_boost,
                    'ref_boost_a': self.ref_boost_a,
                    'enable_ref_boost_mask': self.enable_ref_boost_mask,
                    'grounding_px': self.grounding_px,
                    'context_reference': self.context_reference,
                    'context_reference_key': self.context_reference_key,
                },
            }]

        self.tag_result = None

        # Multi-set Pipeline Blocks ("tabs" in the workbench). Legacy configs only carry the flat
        # `blocks` list — migrate it into a single "Default" set so the tab model and the runner's
        # flat chain always agree. `self.blocks` keeps mirroring the ACTIVE set: the runner and
        # the Blend workbench only ever see one chain, the sets are a UI/存储 layer on top.
        self.blocks_sets = cfg.get('blocks_sets')
        if not (isinstance(self.blocks_sets, list) and self.blocks_sets):
            self.blocks_sets = [{'id': 'set-1', 'name': 'Default', 'blocks': self.blocks}]
        self.active_block_set = cfg.get('active_block_set')
        if not any(s.get('id') == self.active_block_set for s in self.blocks_sets):
            self.active_block_set = self.blocks_sets[0].get('id')
        active_set = next((s for s in self.blocks_sets if s.get('id') == self.active_block_set), None)
        if active_set and active_set.get('blocks'):
            self.blocks = active_set['blocks']
        # Disk persistence: the tab sets survive ComfyUI restarts (the in-memory chain only lives
        # as long as the session). The file wins over the migrated config when it exists.
        f_sets, f_active = self._load_blocks_sets_file()
        if f_sets:
            self.blocks_sets = f_sets
            self.active_block_set = f_active if any(s.get('id') == f_active for s in f_sets) else f_sets[0].get('id')
            active_set = next((s for s in self.blocks_sets if s.get('id') == self.active_block_set), None)
            if active_set and active_set.get('blocks'):
                self.blocks = active_set['blocks']
        self.detail_status = 'idle'
        self.detail_error = None
        self.detail_progress = 0       # 0..1
        self.detail_total_steps = 0
        self.detail_current_step = 0
        self.interface_status = 'idle'
        self.interface_error = None
        self.interface_progress = 0
        self.interface_total_steps = 0
        self.interface_current_step = 0
        self.finished = False
        self.finish_selected_key = None
        self.finish_selected_keys = None  # 多选 keys 列表
        self.window_closed = False

        # 历史图片画廊
        self.selected_history = []
        self._history_tensors = {}  # key → tensor (原始引用，避免 base64 往返)
        self._history_counter = 0
        self.current_context_key = None  # 当前作为 context 的 history key

        # 最新结果
        self.original_image = None
        self.detailed_image = None
        self.original_key = None   # history key of the original image
        self.detailed_key = None   # history key of the detailed image

        # Blend 工作台（Draw tab）：画布合成图就是 Context Image，
        # 合成结果 + 纯 Mask 层随 blend_action 一次性送达，不再走 history key 切换。
        self.blend_image = None
        self.blend_mask = None
        self.blend_prompt = ''
        # 逐 run 的 start_step_rate 覆盖（按 detailer block 的位置索引）。
        # 由「图层右键 → Generate」下发；主循环取用后立即清空，避免污染下一次普通 Run。
        self.pending_start_steps = []

        # Interface 执行结果 keys（最近一次）
        self.interface_result_keys = []

        # 子服务器
        self.prompt_server = None
        self.main_server = None
        self.main_port = None
        self.prompt_url = ""
        self.browser_url = ""
        self.started = False

        # 事件驱动：前端发送 action，主循环等待并处理
        self._action_queue = queue.Queue()
        self._action_event = threading.Event()

    # -------------------------------------------------------------------------
    # 生命周期
    # -------------------------------------------------------------------------
    def start(self, initial_image=None):
        # 1) Prompt server
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

        # 2) Main server
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
        print(f"[SnapshotDetailerSampler] Prompt server at {self.prompt_url}")

        t_main = threading.Thread(target=self.main_server.serve_forever)
        t_main.daemon = True
        t_main.start()

    def stop(self):
        print("[SnapshotDetailerSampler] stop() called")
        def _stop(server, name):
            if server:
                try:
                    print(f"[SnapshotDetailerSampler] Stopping {name}...")
                    server.stop()
                    print(f"[SnapshotDetailerSampler] {name} stopped.")
                except Exception as e:
                    print(f"[SnapshotDetailerSampler] Error stopping {name}: {e}")
        threads = []
        for s, name in [(self.prompt_server, 'prompt_server')]:
            t = threading.Thread(target=_stop, args=(s, name))
            t.daemon = True
            t.start()
            threads.append(t)
        print("[SnapshotDetailerSampler] Stopping main_server...")
        if self.main_server:
            try:
                self.main_server.shutdown()
                self.main_server.server_close()
            except Exception as e:
                print(f"[SnapshotDetailerSampler] Error stopping main_server: {e}")
        print("[SnapshotDetailerSampler] main_server stopped.")
        for t in threads:
            t.join(timeout=2.0)
        print("[SnapshotDetailerSampler] All servers stopped.")

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
    def add_history(self, image, name=None, place=None):
        """添加一张图片到历史画廊。保留 tensor 引用以避免 base64 往返。

        place 只有「Recover Crop 关闭」的 detailer run 会提供：归一化的放置矩形
        (x, y, w, h, ow, oh)。此时 image 是 RGBA —— alpha 就是 crop 工作区的 mask，
        图层自带的 alpha 承担裁剪，所以 history 项不再需要额外的 mask 字段。前端
        据此把它作为一个新图层贴回原位，而不是由后端合成。
        """
        self._history_counter += 1
        key = f'history_{self._history_counter}'
        # 记录尺寸供前端过滤同尺寸图片
        h, w = 0, 0
        if image is not None and hasattr(image, 'shape'):
            shp = image.shape
            if len(shp) == 4:
                h, w = shp[1], shp[2]
            elif len(shp) == 3:
                h, w = shp[0], shp[1]
        # 保留 tensor 引用
        self._history_tensors[key] = image
        self.selected_history.append({
            'key': key,
            'src': tensor_to_base64(image),
            'name': name or f'#{self._history_counter}',
            'width': w,
            'height': h,
            'place': place,
        })
        if len(self.selected_history) > 20:
            old = self.selected_history.pop(0)
            self._history_tensors.pop(old['key'], None)

    def get_history_list(self):
        """返回历史画廊列表（base64 缩略图）。"""
        return [{'key': h['key'], 'name': h['name'], 'src': h['src'],
                 'width': h.get('width', 0), 'height': h.get('height', 0),
                 'place': h.get('place')}
                for h in self.selected_history]

    def get_history_image(self, key):
        """根据 key 获取历史图片 tensor。优先返回 tensor 引用，避免 base64 decode。"""
        tensor = self._history_tensors.get(key)
        if tensor is not None:
            return tensor
        # Fallback: 从 base64 decode（兼容旧数据）
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
                    # 带 alpha 的图保留 4 通道（QwenImage21 这类 alpha 架构需要），其余统一转 RGB
                    if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
                        img = img.convert('RGBA')
                    elif img.mode != 'RGB':
                        img = img.convert('RGB')
                    arr = np.array(img).astype(np.float32) / 255.0
                    return torch.from_numpy(arr).unsqueeze(0)
                except Exception as e:
                    print(f"[SnapshotDetailerSampler] Failed to load history image: {e}")
                    return None
        return None

    def compose_blend(self, layer_specs, width=0, height=0, mask_data_url=None):
        """把图层栈合成成一张图（不写历史），返回 (image, mask)。

        layer_specs: [{'key'|'src', 'mask': dataURL|None, 'decal': dataURL|None, 'transform': {...}|None, 'visible': bool}]
        列表自下而上（[0] 是最底层）。图层像素优先用 history key；拖入的本地图片没有 key，
        改用它自己的 data URL（'src'）。画布尺寸优先用 width/height，否则取最底层图片的原始尺寸。

        mask_data_url 是画布顶层的「纯 Mask 层」（alpha = 覆盖率，按画布尺寸栅格化），
        与图层自身的 coverage mask 无关 —— 返回的 mask 为 [1,H,W] float 或 None（无遮罩）。
        """
        if not layer_specs:
            raise ValueError('Missing layers')
        resolved = []
        for spec in layer_specs:
            key = spec.get('key') or ''
            tensor = self.get_history_image(key) if key else None
            if tensor is None:
                tensor = decode_image_dataurl(spec.get('src'))
            if tensor is None:
                raise LookupError(f'Image not found: {key or "dropped image"}')
            if tensor.dim() == 4:
                tensor = tensor[0]
            resolved.append({
                'image': tensor,
                'transform': spec.get('transform'),
                'mask': spec.get('mask'),
                'decal': spec.get('decal'),
                'visible': spec.get('visible', True),
            })
        canvas_w = int(width or 0)
        canvas_h = int(height or 0)
        if canvas_w <= 0 or canvas_h <= 0:
            canvas_h, canvas_w = resolved[0]['image'].shape[0], resolved[0]['image'].shape[1]
        for layer in resolved:
            # 蒙版与 decal 都在图层自身尺寸下生效，随图层一起被 transform（缩放/旋转）
            layer_h, layer_w = layer['image'].shape[0], layer['image'].shape[1]
            layer['mask'] = decode_mask_alpha(layer['mask'], layer_w, layer_h)
            layer['decal'] = decode_decal_rgba(layer['decal'], layer_w, layer_h)
        blended = composite_layers(resolved, canvas_w, canvas_h)
        # 纯 Mask 层整体按画布尺寸栅格化，squeeze 成 [1,H,W] 与 pipeline.mask 同构。
        # collapse_opaque=False：这一层「全白」= 整块画布都被覆盖，绝不能当成「没有蒙版」
        # （那样 Full / 涂满画布都会被误判成没画，弹出 "Mask is required"）。
        blend_mask = decode_mask_alpha(mask_data_url, canvas_w, canvas_h, collapse_opaque=False)
        if blend_mask is not None:
            blend_mask = blend_mask.squeeze(-1)
        return blended, blend_mask

    def _apply_tag_result(self, tag):
        """把打标结果写进 prompt 阶段：替换 parsing 来源的项，保留 normal/program。

        返回 (parsed_selected, parsed_custom)。由 /api/blend_action 的 tag 分派调用，
        保证「Tag 只产出 prompt、不碰 Context」这一语义。
        """
        self.tag_result = tag
        parsed_selected, parsed_custom = [], tag
        if self.prompt_server is not None:
            if SnapshotPromptNode is not None:
                parsed_selected, parsed_custom = SnapshotPromptNode._parse_raw_prompt(tag)
            new_prompts = [
                p for p in (self.prompt_server.selected_prompts or [])
                if not (isinstance(p, dict) and p.get('source', 'normal') == 'parsing')
            ]
            new_prompts.extend({'text': p, 'source': 'parsing'} for p in parsed_selected)
            self.prompt_server.selected_prompts = new_prompts
            self.prompt_server.custom_prompts = parsed_custom
        return parsed_selected, parsed_custom

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
                "widget_name": "align", "type": "INT", "value": str(self.align),
            })
            ps.send_sync("kolid-comfy-widget-set", {
                "node_id": self.unique_id,
                "widget_name": "crop_reserve", "type": "INT", "value": str(self.crop_reserve),
            })
            ps.send_sync("kolid-comfy-widget-set", {
                "node_id": self.unique_id,
                "widget_name": "mask_grow", "type": "INT", "value": str(self.mask_grow),
            })
            ps.send_sync("kolid-comfy-widget-set", {
                "node_id": self.unique_id,
                "widget_name": "mask_blur", "type": "INT", "value": str(self.mask_blur),
            })
            ps.send_sync("kolid-comfy-widget-set", {
                "node_id": self.unique_id,
                "widget_name": "enable_edit", "type": "STRING", "value": "enable" if self.enable_edit else "disable",
            })
        except Exception as e:
            print(f"[SnapshotDetailerSampler] Widget sync failed: {e}")

    def _blocks_sets_file(self):
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), 'blocks_sets.json')

    def _load_blocks_sets_file(self):
        """Persisted tab sets from disk, or (None, None) when absent/corrupt."""
        try:
            with open(self._blocks_sets_file(), 'r', encoding='utf-8') as f:
                data = json.load(f)
            sets = data.get('blocks_sets') if isinstance(data, dict) else None
            if isinstance(sets, list) and sets:
                return sets, data.get('active_block_set')
        except Exception:
            pass
        return None, None

    def _save_blocks_sets_file(self):
        try:
            with open(self._blocks_sets_file(), 'w', encoding='utf-8') as f:
                json.dump({'blocks_sets': self.blocks_sets,
                           'active_block_set': self.active_block_set},
                          f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[SnapshotDetailerSampler] Failed to save blocks_sets: {e}")

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
        if 'align' in data:
            self.align = int(data['align'])
            dirty = True
        if 'crop_reserve' in data:
            self.crop_reserve = int(data['crop_reserve'])
            dirty = True
        if 'mask_grow' in data:
            self.mask_grow = int(data['mask_grow'])
            dirty = True
        if 'mask_blur' in data:
            self.mask_blur = int(data['mask_blur'])
            dirty = True
        if 'enable_edit' in data:
            self.enable_edit = bool(data['enable_edit'])
            dirty = True
        if 'context_reference' in data:
            self.context_reference = bool(data['context_reference'])
            dirty = True
        if 'context_reference_key' in data:
            self.context_reference_key = data['context_reference_key']
        # Multi-set Pipeline Blocks (the workbench's tabs). Sets/active arrive together with the
        # active set's blocks mirrored in `blocks`; either way the active set wins and the runner
        # only ever sees its flat chain.
        if 'blocks_sets' in data:
            sets = data['blocks_sets']
            if isinstance(sets, list) and sets:
                self.blocks_sets = sets
        if 'active_block_set' in data and data['active_block_set']:
            self.active_block_set = data['active_block_set']
        if 'blocks_sets' in data or 'active_block_set' in data:
            if not any(s.get('id') == self.active_block_set for s in self.blocks_sets):
                self.active_block_set = self.blocks_sets[0].get('id')
            active_set = next((s for s in self.blocks_sets if s.get('id') == self.active_block_set), None)
            if active_set is not None:
                self._set_blocks(active_set.get('blocks') or [])
                dirty = True
            self._save_blocks_sets_file()
        if 'blocks' in data:
            self._set_blocks(data['blocks'])
            dirty = True
        if dirty:
            self._sync_widgets()

    def _set_blocks(self, blocks):
        """Adopt a flat block chain as the active one and sync widget-visible params.

        Used by both the legacy `blocks` key and the multi-set tabs path — whichever way the
        chain arrives, the first detailer's params still drive the ComfyUI widget display."""
        self.blocks = blocks or []
        # Sync individual params from first detailer block for ComfyUI widget display
        first_detailer = next((b for b in self.blocks if isinstance(b, dict) and b.get('type') == 'detailer'), None)
        if first_detailer:
            bp = first_detailer.get('params', first_detailer)
            self.add_noise = bp.get('add_noise', self.add_noise)
            self.start_step_rate = float(bp.get('start_step_rate', self.start_step_rate))
            self.end_step_rate = float(bp.get('end_step_rate', self.end_step_rate))
            self.pixels = int(bp.get('pixels', self.pixels))
            self.align = int(bp.get('align', self.align))
            self.crop_reserve = int(bp.get('crop_reserve', self.crop_reserve))
            self.enable_edit = bool(bp.get('enable_edit', self.enable_edit))
            self.edit_mode = bp.get('edit_mode', self.edit_mode)
            self.ref_boost = float(bp.get('ref_boost', self.ref_boost))
            self.ref_boost_a = float(bp.get('ref_boost_a', self.ref_boost_a))
            self.enable_ref_boost_mask = bool(bp.get('enable_ref_boost_mask', self.enable_ref_boost_mask))
            self.grounding_px = int(bp.get('grounding_px', self.grounding_px))
            self.context_reference = bool(bp.get('context_reference', self.context_reference))
            self.context_reference_key = bp.get('context_reference_key', self.context_reference_key)

    # -------------------------------------------------------------------------
    # HTTP 请求处理器
    # -------------------------------------------------------------------------
    class MainHandler(http.server.SimpleHTTPRequestHandler):
        server_instance = None

        def log_message(self, format, *args):
            pass

        @staticmethod
        def _get_current_architecture(inst):
            """当前 pipeline 的模型架构名（用于前端按架构渲染 DetailerBlock 设置）。"""
            try:
                node = getattr(inst, 'node_instance', None)
                pipeline = getattr(node, '_current_pipeline', None)
                cfg = getattr(pipeline, 'config', None)
                return cfg.get('architecture') if isinstance(cfg, dict) else None
            except Exception:
                return None

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
                    'prompt_url': inst.prompt_url if inst else '',
                    'detail_status': inst.detail_status if inst else 'idle',
                    'add_noise': inst.add_noise if inst else 'enable',
                    'start_step_rate': inst.start_step_rate if inst else 0.8,
                    'end_step_rate': inst.end_step_rate if inst else 1.0,
                    'pixels': inst.pixels if inst else 1048576,
                    'align': inst.align if inst else 8,
                    'crop_reserve': inst.crop_reserve if inst else 32,
                    'mask_grow': inst.mask_grow if inst else 32,
                    'mask_blur': inst.mask_blur if inst else 32,
                    'enable_edit': inst.enable_edit if inst else False,
                    'context_reference': inst.context_reference if inst else False,
                    'context_reference_key': inst.context_reference_key if inst else None,
                    'has_tagger': inst.tagger is not None if inst else False,
                    'current_context_key': getattr(inst, 'current_context_key', None),
                    'architecture': self._get_current_architecture(inst),
                    'has_package': bool(inst and inst.interface_packages),
                    'package_count': len(inst.interface_packages) if inst else 0,
                    'has_pipeline_package': bool(inst and inst.pipeline_packages),
                    'pipeline_package_count': len(inst.pipeline_packages) if inst else 0,
                    'blocks': inst.blocks if inst else [],
                    'blocks_sets': inst.blocks_sets if inst else [],
                    'active_block_set': inst.active_block_set if inst else None,
                })
                return

            if self.path == '/api/status':
                self._send_json({
                    'detail_status': inst.detail_status if inst else 'idle',
                    'error': getattr(inst, 'detail_error', None),
                    'progress': inst.detail_progress if inst else 0,
                    'current_step': inst.detail_current_step if inst else 0,
                    'total_steps': inst.detail_total_steps if inst else 0,
                    'interface_status': getattr(inst, 'interface_status', 'idle') if inst else 'idle',
                    'interface_error': getattr(inst, 'interface_error', None) if inst else None,
                    'interface_progress': getattr(inst, 'interface_progress', 0) if inst else 0,
                    'interface_current_step': getattr(inst, 'interface_current_step', 0) if inst else 0,
                    'interface_total_steps': getattr(inst, 'interface_total_steps', 0) if inst else 0,
                    'interface_result_keys': getattr(inst, 'interface_result_keys', []) if inst else [],
                })
                return

            if self.path == '/api/package':
                if not inst or not inst.interface_packages:
                    self._send_json({'interfaces': []})
                    return

                from .interface_node import InterfacePackageNode
                epi = getattr(inst, 'extra_pnginfo', None)
                if isinstance(epi, list):
                    epi = epi[0] if epi else {}

                interfaces = []
                for pkg in inst.interface_packages:
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

                    # Resolve COMBO candidate options from the upstream node that
                    # feeds this Start port (best-effort; falls back to []).
                    sub_prompt = fresh_pkg.get('sub_prompt', {})
                    start_id = fresh_pkg.get('start_node_id', '')
                    start_inputs = sub_prompt.get(start_id, {}).get('inputs', {}) if start_id else {}

                    def get_combo_options(port_num):
                        link = start_inputs.get('value' + str(port_num))
                        if not isinstance(link, (list, tuple)) or len(link) < 1:
                            return []
                        up_id = str(link[0])
                        up_node = sub_prompt.get(up_id, {})
                        up_type = up_node.get('class_type', '')
                        if not up_type:
                            return []
                        try:
                            import nodes as comfy_nodes
                            cls = comfy_nodes.NODE_CLASS_MAPPINGS.get(up_type)
                            if not cls:
                                return []
                            it = cls.INPUT_TYPES()
                        except Exception:
                            return []
                        options = []
                        for cat in ('required', 'optional'):
                            ci = it.get(cat, {})
                            if not isinstance(ci, dict):
                                continue
                            for _name, val in ci.items():
                                if isinstance(val, tuple) and len(val) >= 1 and isinstance(val[0], list):
                                    options.extend(str(x) for x in val[0])
                        # de-dup, preserve order
                        seen = set()
                        result = []
                        for o in options:
                            if o not in seen:
                                seen.add(o)
                                result.append(o)
                        return result

                    def make_port(num, name, ptype):
                        is_inject = ptype in ('PIPELINE_DATA', 'IMAGE', 'MASK')
                        is_manual = ptype in ('STRING', 'INT', 'FLOAT', 'BOOLEAN', 'COMBO')
                        port = {
                            'num': num,
                            'name': name,
                            'type': ptype,
                            'value': None,
                            'category': 'inject' if is_inject else ('manual' if is_manual else 'port'),
                        }
                        if ptype == 'COMBO':
                            port['options'] = get_combo_options(num)
                        return port

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

            if self.path == '/api/pipeline_package':
                if not inst or not inst.pipeline_packages:
                    self._send_json({'pipeline_packages': []})
                    return
                pipeline_packages = []
                for pkg in inst.pipeline_packages:
                    pipelines = []
                    for i, p in enumerate(pkg.get('pipelines', [])):
                        pipelines.append({"name": p.get("name", f"Pipeline {i+1}"), "node_id": p.get("node_id", "")})
                    pipeline_packages.append({
                        "name": pkg.get("name", "PipelineGroup"),
                        "pipelines": pipelines,
                    })
                self._send_json({"pipeline_packages": pipeline_packages})
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

            self.send_error(404)

        def do_POST(self):
            inst = self.server_instance

            if self.path == '/api/update_config':
                length = int(self.headers.get('Content-Length', 0))
                data = json.loads(self.rfile.read(length)) if length else {}
                inst._apply_params(data)
                self._send_json({'ok': True})
                return

            if self.path == '/api/execute_interface':
                length = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(length)) if length else {}
                interface_index = body.get('interface_index', 0)
                manual_values = body.get('manual_values', {})
                exec_options = body.get('exec_options', {})
                inst.put_action('execute_interface', interface_index=interface_index, manual_values=manual_values, exec_options=exec_options)
                self._send_json({'ok': True})
                return

            if self.path == '/api/switch_pipeline':
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    package_idx = int(body.get('package_idx', 0))
                    pipeline_idx = int(body.get('pipeline_idx', 0))
                    if not inst or package_idx >= len(inst.pipeline_packages):
                        self._send_json({'success': False, 'error': 'Invalid package index'}, 400)
                        return
                    pkg = inst.pipeline_packages[package_idx]
                    pipelines = pkg.get('pipelines', [])
                    if pipeline_idx >= len(pipelines):
                        self._send_json({'success': False, 'error': 'Invalid pipeline index'}, 400)
                        return
                    pipeline_info = pipelines[pipeline_idx]
                    upstream_node_id = pipeline_info.get("node_id", "")

                    # Execute the upstream node via InterfaceExecutor to get PIPELINE_DATA
                    from .interface_node import InterfaceExecutor
                    epi = getattr(inst, 'extra_pnginfo', None)
                    if isinstance(epi, list):
                        epi = epi[0] if epi else {}
                    # Provide current pipeline as fallback for unresolved PIPELINE_DATA inputs
                    current_pipeline = inst.node_instance._current_pipeline
                    executor = InterfaceExecutor(
                        extra_pnginfo=epi,
                        get_pipeline=lambda: current_pipeline,
                    )
                    output_values = {}
                    try:
                        executor._try_execute_external(upstream_node_id, output_values)
                    except Exception as ex:
                        self._send_json({'success': False, 'error': f'Failed to execute upstream node {upstream_node_id}: {ex}'}, 500)
                        return
                    if upstream_node_id not in output_values or not output_values[upstream_node_id]:
                        self._send_json({'success': False, 'error': f'Failed to execute upstream node {upstream_node_id}: execution returned no output'}, 500)
                        return
                    new_pipeline = output_values[upstream_node_id][0]
                    if new_pipeline is None:
                        self._send_json({'success': False, 'error': 'Upstream node returned None pipeline'}, 500)
                        return

                    # Switch pipeline (preserve history)
                    # Inherit image/latent from current pipeline if new pipeline lacks them
                    if new_pipeline.image is None and current_pipeline is not None and current_pipeline.image is not None:
                        new_pipeline.image = current_pipeline.image
                    if new_pipeline.latent is None and current_pipeline is not None and current_pipeline.latent is not None:
                        new_pipeline.latent = current_pipeline.latent
                    if new_pipeline.mask is None and current_pipeline is not None and current_pipeline.mask is not None:
                        new_pipeline.mask = current_pipeline.mask
                    inst.node_instance._current_pipeline = new_pipeline.copy()
                    inst.node_instance._base_pipeline = inst.node_instance._current_pipeline
                    new_image = new_pipeline.get_image() if hasattr(new_pipeline, 'get_image') else None
                    inst.node_instance._switch_image(inst, new_image, context_key=inst.current_context_key)
                    # Update lora_regex from new pipeline's architecture
                    new_arch = new_pipeline.config.get("architecture") if new_pipeline.config else None
                    old_arch = current_pipeline.config.get("architecture") if current_pipeline and current_pipeline.config else None
                    print(f"[PipelineSwitch] old_arch={old_arch}, new_arch={new_arch}, config_keys={list(new_pipeline.config.keys()) if new_pipeline.config else 'None'}")
                    if new_arch:
                        new_arch = str(new_arch)
                        inst.lora_regex = new_arch
                        if inst.prompt_server:
                            inst.prompt_server.update_lora_regex(new_arch)
                    elif old_arch:
                        # If new pipeline didn't set architecture, keep old regex
                        print(f"[PipelineSwitch] WARNING: new pipeline has no architecture in config, keeping old lora_regex={inst.lora_regex}")
                    print(f"[PipelineSwitch] Switched to pipeline '{pipeline_info.get('name', '')}' (node {upstream_node_id}), lora_regex='{new_arch or inst.lora_regex}'")
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
                print("[SnapshotDetailerSampler] Finish action received, selected_keys:", inst.finish_selected_keys)
                # 唤醒 prompt 以防阻塞
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
                    # 带 alpha 的图保留 4 通道（QwenImage21 这类 alpha 架构需要），其余统一转 RGB
                    if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
                        img = img.convert('RGBA')
                    elif img.mode != 'RGB':
                        img = img.convert('RGB')
                    arr = np.array(img).astype(np.float32) / 255.0
                    tensor = torch.from_numpy(arr).unsqueeze(0)
                    inst.add_history(tensor, name=f'Loaded #{len(inst.selected_history) + 1}')
                    # 拖上来的图要立刻能被设成「参考图」，所以把新 key 回给调用方
                    new_key = inst.selected_history[-1]['key'] if inst.selected_history else None
                    self._send_json({'success': True, 'key': new_key})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'success': False, 'error': str(e)}, 500)
                return

            if self.path == '/api/resize_image':
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    key = body.get('key', '')
                    width = int(body.get('width', 0))
                    height = int(body.get('height', 0))
                    if not key or width <= 0 or height <= 0:
                        self._send_json({'success': False, 'error': 'Invalid key, width or height'}, 400)
                        return
                    # 获取历史图片 tensor
                    tensor = inst.get_history_image(key)
                    if tensor is None:
                        self._send_json({'success': False, 'error': 'Image not found'}, 404)
                        return
                    # tensor 可能是 [B,H,W,C] 或 [H,W,C]
                    if tensor.dim() == 4:
                        img = tensor[0]
                    elif tensor.dim() == 3:
                        img = tensor
                    else:
                        self._send_json({'success': False, 'error': f'Unexpected tensor dim: {tensor.dim()}'}, 400)
                        return
                    # img: [H,W,C] float32 0-1
                    orig_h, orig_w = img.shape[0], img.shape[1]
                    # numpy → PIL resize → numpy
                    arr = (img.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
                    pil_img = Image.fromarray(arr)
                    pil_img = pil_img.resize((width, height), Image.LANCZOS)
                    arr2 = np.array(pil_img).astype(np.float32) / 255.0
                    resized_tensor = torch.from_numpy(arr2)
                    if tensor.dim() == 4:
                        resized_tensor = resized_tensor.unsqueeze(0)
                    # 添加到历史
                    name = None
                    for h in inst.selected_history:
                        if h['key'] == key:
                            name = f"{h['name']} ({width}x{height})"
                            break
                    inst.add_history(resized_tensor, name=name)
                    new_key = inst.selected_history[-1]['key']
                    self._send_json({'success': True, 'key': new_key})
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

            if self.path == '/api/blend_action':
                # Blend 工作台的统一入口：一次合成（图在 tensor 上，不走 PNG 往返），三种分派。
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    action = body.get('action', '')
                    if action not in ('blend', 'tag', 'detailer', 'layer_generate'):
                        self._send_json({'success': False, 'error': f'Unknown action: {action}'}, 400)
                        return

                    # layer_generate does NOT go through compose_blend: the caller sends one layer's
                    # own image and that layer's own mask as separate payloads, because the layer may
                    # be smaller than / offset on the canvas and the canvas composite is not what it
                    # wants refined. Nothing about the canvas is involved.
                    if action == 'layer_generate':
                        layer_image = decode_image_dataurl(body.get('layer_image'))
                        if layer_image is None:
                            self._send_json({'success': False, 'error': 'That layer has no decodable image'}, 400)
                            return
                        # The layer's own mask is authored at the layer's native size, so it is
                        # decoded in that space rather than against the canvas.
                        layer_h, layer_w = int(layer_image.shape[0]), int(layer_image.shape[1])
                        layer_mask = decode_mask_alpha(
                            body.get('layer_mask'), layer_w, layer_h, collapse_opaque=False,
                        )
                        if layer_mask is None or float(layer_mask.sum()) == 0:
                            self._send_json({'success': False, 'error': 'Mask is required — paint that layer\'s own mask before generating'}, 400)
                            return
                        if layer_image.dim() == 3:
                            layer_image = layer_image.unsqueeze(0)
                        start_steps = body.get('start_steps')
                        if not isinstance(start_steps, list):
                            start_steps = []
                        inst.blend_image = layer_image
                        inst.blend_mask = layer_mask.squeeze(-1)
                        inst.blend_prompt = (body.get('extra_prompt') or '').strip()
                        # Consumed once by the main loop, then cleared, so a later toolbar run is
                        # not silently stuck on these overrides.
                        inst.pending_start_steps = [float(v) for v in start_steps]
                        inst.put_action('run_detailer', from_blend=True, extra_prompt=inst.blend_prompt)
                        self._send_json({'success': True})
                        return

                    image, mask = inst.compose_blend(
                        body.get('layers') or [],
                        width=body.get('width'), height=body.get('height'),
                        mask_data_url=body.get('mask'),
                    )

                    if action == 'blend':
                        # 归档：合成图进历史画廊，不动 Context（Context 就是画布本身）
                        inst.add_history(image, name=f'Blend #{len(inst.selected_history) + 1}')
                        self._send_json({'success': True, 'key': inst.selected_history[-1]['key']})
                        return

                    if action == 'tag':
                        # 纯读取：拿画布合成图 + Mask 层打标，结果只写进 prompt 阶段
                        if inst.tagger is None:
                            self._send_json({'success': False, 'error': 'Tagger not configured'})
                            return
                        if inst.node_instance is None:
                            self._send_json({'success': False, 'error': 'Node not ready'})
                            return
                        mode = body.get('tag_mode', 'mask')
                        tag = inst.node_instance._run_tag_on_image(image, mask, inst.tagger, mode)
                        parsed_selected, parsed_custom = inst._apply_tag_result(tag)
                        self._send_json({'success': True, 'tag': tag, 'tags': parsed_selected, 'custom': parsed_custom})
                        return

                    # action == 'detailer'：合成结果交给主循环执行（主循环在另一个线程）
                    if mask is None or float(mask.sum()) == 0:
                        self._send_json({'success': False, 'error': 'Mask is required — paint the mask layer before running the detailer'}, 400)
                        return
                    inst.blend_image = image
                    inst.blend_mask = mask
                    inst.blend_prompt = (body.get('extra_prompt') or '').strip()
                    inst.put_action('run_detailer', from_blend=True, extra_prompt=inst.blend_prompt)
                    self._send_json({'success': True})
                except LookupError as e:
                    self._send_json({'success': False, 'error': str(e)}, 404)
                except ValueError as e:
                    self._send_json({'success': False, 'error': str(e)}, 400)
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'success': False, 'error': str(e)}, 500)
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
                "mask_grow": ("INT", {"default": 32, "min": 0, "max": 256, "step": 1}),
                "mask_blur": ("INT", {"default": 32, "min": 0, "max": 256, "step": 1}),
                "enable_edit": (["disable", "enable"], {"default": "disable"}),
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

    # -------------------------------------------------------------------------
    # Tag
    # -------------------------------------------------------------------------
    def _run_tag_on_image(self, tag_image, mask, tagger, mode='mask'):
        """对给定图像 + 遮罩打标，与 pipeline 状态无关（供 Blend 工作台直接调用）。"""
        from ..libs.caption_utils import get_tag
        from ..libs.image_utils import crop_mask
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
            trigger_words = []
            for lora_item in loras:
                if isinstance(lora_item, dict):
                    if not lora_item.get('active', True):
                        continue
                    file_path = lora_item.get('file_path', '') or lora_item.get('file_name', '')
                    if hasattr(prompt_server, '_resolve_lora_file_path'):
                        file_path = prompt_server._resolve_lora_file_path(file_path)
                    strength = lora_item.get('strength', 1.0)
                    lora_str_parts.append(f"<lora_path:{file_path}:{strength}>")
                    trigger_words.extend(lora_item.get('active_tags', []))
                else:
                    lora_str_parts.append(str(lora_item))
            user_loras = ','.join(lora_str_parts)
            if trigger_words:
                trigger_str = ', '.join(trigger_words)
                user_positive = user_positive + ', ' + trigger_str if user_positive else trigger_str
        return user_positive, user_loras

    # -------------------------------------------------------------------------
    # Detailer
    # -------------------------------------------------------------------------
    def _run_pipeline_blocks(self, pipeline, user_mask, user_positive, user_loras, global_params, blocks, server=None):
        seed = global_params['seed']
        mask_grow = int(global_params.get('mask_grow', 32))
        mask_blur = int(global_params.get('mask_blur', 32))
        context_regex = global_params['context_regex']
        # Per-run start_step_rate overrides, indexed by the position of a detailer block in the
        # pipeline. This is how the workbench's per-layer "Generate" dialog replaces the pipeline's
        # start step for one run without editing the pipeline itself. An empty list (the normal
        # case) leaves every block on its configured value.
        start_step_overrides = global_params.get('start_step_overrides') or []

        next_pipeline = pipeline.copy()
        if next_pipeline.cache is None:
            raise ValueError('PipelineData cache is empty')
        if next_pipeline.model is None:
            raise ValueError('PipelineData model is empty, cannot Detailer')

        original_image = next_pipeline.get_image()
        if original_image is None:
            raise ValueError("No image available for detailer")

        if user_mask is not None:
            user_mask = user_mask.clone()
            user_mask = (user_mask > 0).float()
        expanded_mask = expand_mask(user_mask, grow=mask_grow, blur=mask_blur)

        # First detailer block: crop_mask (using its crop_reserve)
        # 整条链（含 interface block）都在 crop 工作区坐标系内运行；run 之前 crop，
        # run 之后由 recover 系列复原。interface block 不重算/不操作 mask 的 crop，
        # 但其输出尺寸须与 crop 工作区连贯（由用户/子图保证，pipeline 内不做 resize）。
        first_detailer = next((b for b in blocks if b.get('type') == 'detailer'), blocks[0])
        first_bp = first_detailer.get('params', first_detailer)
        first_crop_reserve = int(first_bp.get('crop_reserve', 32))
        # Preprocess Settings 的 Recover Crop 开关（与 crop_reserve 一样取自第一个
        # detailer block）。关掉时这一趟产出停在 crop 工作区：不 recover_size、不
        # recover_crop，patch 连同裁剪矩形交给前端，由 Blend 画布用 transform 贴回原位。
        do_recover_crop = bool(first_bp.get('recover_crop', True))
        cropped_image, cropped_mask, crop_info = crop_mask(
            image=original_image,
            mask=expanded_mask,
            reserve=first_crop_reserve
        )

        # limit_pixels 提到 crop 之后只做一次，确定全局工作分辨率（所有 block 共享）。
        # pixels / align 统一取自 first_bp（第一个 detailer block 的参数），取消每个
        # block 各自的 pixels/align。interface 之后的 block 不再单独 limit，pipeline
        # 内不做额外 resize。
        limit_pixels_val = int(first_bp.get('pixels', 1048576))
        limit_align = int(first_bp.get('align', 8))
        # QwenImage2.1: crop 尺寸需与 vision token / latent 共享的 32 像素格对齐
        if arch_qwen_image21.matches(next_pipeline.config):
            limit_align = arch_qwen_image21.adjust_align(limit_align)
        resized_image, resized_mask, resize_info = limit_pixels(
            image=cropped_image,
            pixels=limit_pixels_val,
            mask=cropped_mask,
            align=limit_align,
        )

        current_image = resized_image
        current_mask = resized_mask
        last_resize_info = None
        last_resized_mask = None

        # Save original pipeline state for restoration after each block
        _orig_enable_edit = next_pipeline.config.get("enable_edit") if next_pipeline.config else None
        _orig_grounding_px = next_pipeline.config.get("grounding_px") if next_pipeline.config else None
        _orig_ref_latents = list(next_pipeline.reference.reference_latents) if next_pipeline.reference and next_pipeline.reference.reference_latents else []
        _orig_model = next_pipeline.model
        _orig_model_negative = next_pipeline.config.get("model_negative") if next_pipeline.config else None

        # Enable Edit: 在 block 循环之前对 pipeline model 统一打一次补丁（与
        # PipelineEnableEditNode / 主 SamplerNode 路径相同的机制）。ref_boost 等
        # 为 pipeline 级 config，对所有 block 相同；fit_mode 由 block 级
        # edit_mode 逐 block 写入 pixel_state（forward 动态读取）。之后循环内
        # get_model_clip() 的 clone 共享补丁闭包（含 pixel_state），节点级
        # source 注入（source_images / source_latents）直接写入 pixel_state ——
        # conditioning 只承载 grounded encode 语义输出（数据流分离，对齐
        # krea2edit source patch 参考）。Krea2: source patch（fit/crop 双模式）；
        # Flux2Klein: 原生 ref 路径。
        _edit_patched = False
        _edit_pixel_state = None
        _any_edit = any(
            (b.get('params', b) or {}).get('enable_edit', False)
            for b in blocks if b.get('type') != 'interface'
        )
        if _any_edit:
            architecture = next_pipeline.config.get("architecture") if next_pipeline.config else None
            if architecture and re.search(r"Krea2", architecture, re.IGNORECASE):
                ref_boost = next_pipeline.config.get("ref_boost", 1.0)
                ref_boost_a = next_pipeline.config.get("ref_boost_a", 1.0)
                ref_boost_mask = next_pipeline.config.get("ref_boost_mask", None)
                vae = next_pipeline.vae
                pixel_state = {"fit_mode": "fit", "vae": vae, "source_images": None, "source_latents": None, "px_cache": {}}
                next_pipeline.model = arch_krea2.apply_model_patch(
                    next_pipeline.model, ref_boost, ref_boost_a, ref_boost_mask, "fit", vae, pixel_state)
                if _orig_model_negative is not None:
                    next_pipeline.config["model_negative"] = arch_krea2.apply_model_patch(
                        _orig_model_negative, ref_boost, ref_boost_a, ref_boost_mask, "fit", vae, pixel_state)
                _edit_patched = True
                _edit_pixel_state = pixel_state
                print(f"[Detailer] Krea2 edit patch applied to pipeline model (ref_boost={ref_boost}, ref_boost_a={ref_boost_a})")
            elif architecture and re.search(r"Flux2Klein", architecture, re.IGNORECASE):
                next_pipeline.model = arch_flux2klein.apply_model_patch(next_pipeline.model)
                if _orig_model_negative is not None:
                    next_pipeline.config["model_negative"] = arch_flux2klein.apply_model_patch(_orig_model_negative)
                _edit_patched = True
                print("[Detailer] Flux2Klein edit patch applied to pipeline model")

        try:
            # Position of the current block among the detailer blocks only. The workbench's
            # start-step overrides are indexed that way, so interface blocks must not consume an
            # index (see start_step_overrides above).
            detailer_idx = -1
            for i, block in enumerate(blocks):
                is_last = (i == len(blocks) - 1)

                # 每个 block 执行前检查 interrupt 状态
                mm.throw_exception_if_processing_interrupted()

                if block.get('type') == 'interface':
                    # Interface 块在 chain 内执行：以当前 pipeline 的 image/mask 作为输入，
                    # 执行子图后把结果写回 pipeline，作为下一 block 的输入（不加入 history）。
                    print(f"[PipelineBlock {i+1}/{len(blocks)}] Interface block — executing sub-graph (chain mode)")
                    bp = block.get('params', block)
                    # 按接口名绑定（接口包重排/增删不会错绑到别的接口）；旧配置没有名字时
                    # 回退到下标。名字解不出 = 接口已不存在 → 标记性跳过（bypass），不中断 chain。
                    interface_name = bp.get('interface_name')
                    interface_idx = -1
                    if interface_name:
                        interface_idx = next(
                            (j for j, p in enumerate(server.interface_packages)
                             if isinstance(p, dict) and (p.get('name') or '') == interface_name),
                            -1)
                        if interface_idx < 0:
                            print(f"[PipelineBlock {i+1}] WARNING: interface '{interface_name}' not found "
                                  f"({len(server.interface_packages)} interface packages) — MISSING, bypassing block")
                            continue
                    else:
                        interface_idx = int(bp.get('interface_idx', block.get('interface_index', -1)))
                    if interface_idx < 0 or interface_idx >= len(server.interface_packages):
                        print(f"[PipelineBlock {i+1}] WARNING: invalid interface_idx={interface_idx}, skipping block")
                        continue

                    exec_options = {
                        'operation': bp.get('operation', 'default'),
                        'crop_reserve': int(bp.get('crop_reserve', 32)),
                        'image_keys': bp.get('image_keys', {}) or {},
                    }
                    manual_values = bp.get('manual_values', {}) or {}

                    # 输入图/mask：优先用本 block 显式选择的 context image；否则沿用
                    # 上一 block 输出的 current_image / current_mask（即 pipeline 流水线传递）。
                    # 注意：传入 interface 的 mask 需 clone 一个独立副本——interface 子图可能
                    # in-place 修改传入的 mask tensor，若不隔离会通过引用共享污染上游 pipeline。
                    block_input_img = current_image
                    block_input_mask = current_mask.clone() if current_mask is not None else None
                    ctx_img_key = bp.get('context_image_key')
                    if ctx_img_key and server is not None:
                        sel_img = server.get_history_image(ctx_img_key)
                        if sel_img is not None:
                            block_input_img = sel_img
                            print(f"[PipelineBlock {i+1}] Interface using context image key={ctx_img_key}")
                        else:
                            print(f"[PipelineBlock {i+1}] WARNING: context image key '{ctx_img_key}' not found, using pipeline image")
                    ctx_mask_key = bp.get('context_mask_key')
                    if ctx_mask_key and server is not None:
                        sel_mask = server.get_history_image(ctx_mask_key)
                        if sel_mask is not None:
                            block_input_mask = sel_mask
                            print(f"[PipelineBlock {i+1}] Interface using context mask key={ctx_mask_key}")

                    result_img, result_mask = self._execute_interface(
                        server, interface_idx, manual_values,
                        exec_options=exec_options,
                        input_image=block_input_img,
                        input_mask=block_input_mask,
                        return_image=True,
                        base_pipeline=next_pipeline,
                    )

                    # 写回 pipeline + 局部变量，供下一 block 串联（block 间以 pipeline 传递
                    # 全部上下文：image/mask/model/clip/context/loras 等）。interface 子图
                    # 的输出尺寸由其自身决定（与 crop 工作区连贯由用户/子图保证），直接注入
                    # pipeline 原样往下传递——不在 pipeline 内做任何 image/mask 的 resize。
                    # mask 也写回（但不做 mask 的 crop 重算等操作）。
                    next_pipeline.image = result_img
                    next_pipeline.mask = result_mask
                    current_image = result_img
                    current_mask = result_mask
                    print(f"[PipelineBlock {i+1}] Interface done: result shape={result_img.shape if hasattr(result_img, 'shape') else None}")
                    continue

                # Detailer block params (support both nested 'params' dict and flat)
                bp = block.get('params', block)
                add_noise = bp.get('add_noise', 'enable')
                start_step_rate = float(bp.get('start_step_rate', 0.8))
                # A per-run override, positional across detailer blocks. `None` is "no override",
                # which is why this cannot be a plain falsy check: 0.0 is a legitimate value.
                detailer_idx += 1
                if detailer_idx < len(start_step_overrides):
                    _ovr = start_step_overrides[detailer_idx]
                    if _ovr is not None:
                        start_step_rate = max(0.0, min(1.0, float(_ovr)))
                        print(f"[PipelineBlock {i+1}] start_step_rate overridden to {start_step_rate} for this run")
                end_step_rate = float(bp.get('end_step_rate', 1.0))
                enable_edit = bp.get('enable_edit', False)
                edit_mode = bp.get('edit_mode', 'fit')  # Krea2 source-patch 模式: fit | crop
                ref_boost = float(bp.get('ref_boost', 4.0))
                ref_boost_a = float(bp.get('ref_boost_a', 1.0))
                enable_ref_boost_mask = bp.get('enable_ref_boost_mask', False)
                grounding_px = int(bp.get('grounding_px', 768))
                # Context Ref 没有开关：选了参考图就走该通道。
                # 'context_reference' 只是旧配置里的遗留字段，不再参与判定。
                context_reference_key = bp.get('context_reference_key')
                # 每个 detailer block 自带 context_regex（默认 ".+"），覆盖全局值，
                # 用于决定该 block 解出 pipeline.context 中的哪些 lora/prompt。
                block_context_regex = bp.get('context_regex', context_regex) or '.+'

                print(f"[PipelineBlock {i+1}/{len(blocks)}] Detailer: noise={add_noise}, steps={start_step_rate}-{end_step_rate}, edit={enable_edit}, edit_mode={edit_mode}, ref_boost={ref_boost}/{ref_boost_a}, mask_boost={enable_ref_boost_mask}, grounding_px={grounding_px}, last={is_last}")

                # 全局工作分辨率已在 crop 后一次性 limit 确定（见上方）。此处把当前 block
                # 的实际输入（可能已被上游 interface 块替换）同步为处理图，不再重复 limit。
                resized_image, resized_mask = current_image, current_mask

                # VAEEncode
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

                # Condition — 每个 detailer block 实时从当前 pipeline.context 解出
                # lora/prompt（不提前解析），以捕获上游 interface 块对 pipeline 的修改。
                context_positive, context_negative, context_loras = next_pipeline.context.get_context(block_context_regex)
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

                # Restore reference_latents to original before per-block injection
                next_pipeline.reference.reference_latents = list(_orig_ref_latents)

                # Enable Edit 补丁已在循环前统一应用到 pipeline model（含
                # model_negative），get_model_clip 返回的 clone 自动携带补丁闭包；
                # 此处仅记录本 block 的开关状态供 debug / UI 使用。
                next_pipeline.config["enable_edit"] = enable_edit
                # block 级 grounding_px: Krea2 grounded encode 的 VLM 看图分辨率
                # 上限（正/负条件共用 — 同一 get_conditioning 路径）
                next_pipeline.config["grounding_px"] = grounding_px
                # block 级 edit 参数: forward 从 pixel_state 动态读取，支持逐
                # block 切换 —— edit_mode（fit/crop 几何）与 ref_boost 三参数
                # （注意力增强; enable_ref_boost_mask 启用时以 context mask
                # [当前块裁剪区 mask, 与源图同网格] 限定增强区域）
                if _edit_pixel_state is not None:
                    _edit_pixel_state["fit_mode"] = edit_mode
                    _edit_pixel_state["ref_boost"] = ref_boost
                    _edit_pixel_state["ref_boost_a"] = ref_boost_a
                    _edit_pixel_state["ref_boost_mask"] = (
                        resized_mask if (enable_edit and enable_ref_boost_mask) else None
                    )

                # Context Reference injection (per-block)
                if enable_edit and context_reference_key and server is not None:
                    ref_img = server.get_history_image(context_reference_key)
                    if ref_img is not None:
                        ref_latent = VAEEncode().encode(vae=next_pipeline.vae, pixels=ref_img)[0]
                        next_pipeline.reference.reference_latents.append(ref_latent)
                        print(f"[Block {i+1}] Context reference injected: key={context_reference_key}")
                    else:
                        print(f"[Block {i+1}] WARNING: context reference key '{context_reference_key}' not found")

                print(f"[Block {i+1}] reference.reference_latents count: {len(next_pipeline.reference.reference_latents)}")

                # Reference args by architecture — Enable Edit 统一控制 edit 路径
                # Krea2: source patch + grounded encode (语义+像素双路径)
                # Flux2Klein: 原生 ref_latents — 当前块 latent 作为 reference
                architecture = next_pipeline.config.get("architecture") if next_pipeline.config else None
                is_krea2 = bool(architecture and re.search(r"Krea2", architecture, re.IGNORECASE))
                is_flux2klein = bool(architecture and re.search(r"Flux2Klein", architecture, re.IGNORECASE))

                ref_latent_arg = tmp_latent if (is_flux2klein and enable_edit) else None
                ref_image_arg = resized_image if ((is_krea2 and enable_edit) or not is_flux2klein) else None

                positive_condition = next_pipeline.get_conditioning(
                    mode='positive',
                    clip=clip_to_use,
                    vae=next_pipeline.vae,
                    prompt=current_positive,
                    reference_latent=ref_latent_arg,
                    reference_image=ref_image_arg,
                    reference=next_pipeline.reference
                )

                negative_condition = next_pipeline.get_conditioning(
                    mode='negative',
                    clip=clip_to_use,
                    vae=next_pipeline.vae,
                    prompt=current_negative,
                    reference_latent=ref_latent_arg,
                    reference_image=ref_image_arg,
                    reference=next_pipeline.reference
                )

                # 节点级 pixel_state 注入（对齐 krea2edit source patch 数据流）：
                # source 由 snapshot 节点直接写入 patch 闭包，不经 conditioning 管道。
                # - edit on: source_latents = 当前块 latent（identity edit: source==target
                #   初始网格）；并在采样外预编码像素源（对齐参考 target_latent 用途，
                #   避免 mid-sampling VAE 加载驱逐扩散模型）
                # - edit off: 清空残留（覆盖 get_conditioning side-channel 写入），走原生 forward
                if _edit_pixel_state is not None:
                    if enable_edit and is_krea2:
                        _edit_pixel_state["source_latents"] = [tmp_latent["samples"]]
                        _edit_pixel_state["px_cache"] = {}
                        if _edit_pixel_state.get("source_images"):
                            Hh, Ww = tmp_latent["samples"].shape[-2], tmp_latent["samples"].shape[-1]
                            arch_krea2.pre_encode_sources(_edit_pixel_state, Hh, Ww)
                    else:
                        _edit_pixel_state["source_images"] = None
                        _edit_pixel_state["source_latents"] = None
                        _edit_pixel_state["px_cache"] = {}

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

                # Recover to pre-resize (cropped) resolution so next block starts at cropped size
                if not is_last:
                    recovered_decoded, _ = recover_size(
                        image=decoded_image,
                        resize_info=resize_info,
                        mask=resized_mask
                    )
                    current_image = recovered_decoded
                    current_mask = cropped_mask
                else:
                    current_image = decoded_image
                    current_mask = resized_mask

                last_resize_info = resize_info
                last_resized_mask = resized_mask

                print(f"[Block {i+1}] Done: decoded shape={decoded_image.shape}")
        finally:
            # Restore pipeline state
            if next_pipeline.config is not None:
                next_pipeline.config["enable_edit"] = _orig_enable_edit
                if _orig_grounding_px is not None:
                    next_pipeline.config["grounding_px"] = _orig_grounding_px
                else:
                    # 原值缺失时删除 key，避免 None 覆盖 get_conditioning 的默认值回退
                    next_pipeline.config.pop("grounding_px", None)
                if _edit_patched:
                    next_pipeline.config["model_negative"] = _orig_model_negative
            if next_pipeline.reference is not None:
                next_pipeline.reference.reference_latents = _orig_ref_latents
            if _edit_patched:
                # 返回的 pipeline 会成为 _current_pipeline，必须还原为未打补丁的
                # model，避免补丁闭包（含 source_images/px_cache）跨运行滞留
                next_pipeline.model = _orig_model

        # 收尾：整条链（含 interface block）都在 crop 工作区坐标系里跑，这里把它落地。
        # Recover Crop 开 → recover_size（分辨率复原）+ recover_crop（按 crop_info 合成
        # 回全图），即原行为。
        # Recover Crop 关 → 两个都不做：patch 保持工作分辨率，工作区 mask 合进它的 alpha，
        # 连同裁剪矩形一起交给前端，由 Blend 画布作为新图层用 transform 贴回原位 ——
        # transform 的缩放本身就承担了 recover_size 的职责，所以可以一起省掉。
        detail_meta = None
        if do_recover_crop:
            if last_resize_info is not None:
                recovered_image, recovered_mask = recover_size(
                    image=current_image,
                    resize_info=last_resize_info,
                    mask=last_resized_mask
                )
            else:
                recovered_image, recovered_mask = current_image, current_mask

            final_image, final_mask = recover_crop(
                background=original_image,
                image=recovered_image,
                crop_info=crop_info,
                recover_method='mask_blend',
                mask=recovered_mask
            )
        else:
            # 工作区 mask 合进产出图的 alpha：这张 RGBA 就是「要贴回原位的新图层」本身。
            # 前端不再需要额外的 mask 字段 —— 图层自带的 alpha 就承担了裁剪，
            # 贴回去的观感与 recover_crop(mask_blend) 一致，而这次得到的是一个
            # 普通图层，可以继续改 transform / 继续画。
            work_mask = last_resized_mask if last_resized_mask is not None else current_mask
            # place 用 merge 之前的 current_image 量 patch 尺寸 —— merge 不动空间尺寸，
            # 但这样就不依赖 merge 的返回形状。
            place = detail_place_rect(crop_info, current_image)
            final_image = merge_mask_alpha(current_image, work_mask)
            detail_meta = {'place': place}
            print(f"[Detailer] Recover Crop off — returning the RGBA crop-workspace patch "
                  f"{tuple(final_image.shape)} covering the crop rect "
                  f"({place['x']},{place['y']}) {place['w']}x{place['h']} of {place['ow']}x{place['oh']} "
                  f"(patch scale sx={place['sx']:.4f} sy={place['sy']:.4f})")

        detailed_image = final_image

        # Context 就是 Blend 画布合成图，detailer 产出不再接管；关掉 Recover Crop 时产出
        # 只是画布上的一块 patch，更不能顶替整幅 context，故保持原合成图。
        next_pipeline.image = final_image if do_recover_crop else original_image
        next_pipeline.latent = None
        next_pipeline.mask = user_mask

        gc.collect()
        mm.soft_empty_cache()

        return next_pipeline, original_image, detailed_image, detail_meta

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


        # 关键：切换 context 时同步 _base_pipeline 的 image/mask。
        # run_detailer 每次基于 _base_pipeline.copy() 执行（见 sample()），若不在此同步，
        # 注入的仍是初始化时的原始 image，导致用户切换 context 后 run 仍用旧图。
        if self._base_pipeline is not None:
            self._base_pipeline.image = new_image
            self._base_pipeline.mask = self._current_pipeline.mask

    # -------------------------------------------------------------------------
    # Interface Package 执行
    # -------------------------------------------------------------------------
    def _sync_pipeline_updates(self, target, source):
        """将 source pipeline（interface 子图返回的、被修改过的 pipeline）中
        实际输出/修改的字段合并回 target pipeline（chain 中的上游 pipeline）。

        只覆盖 source 中非 None 的字段，且跳过 image/mask（image/mask 由
        interface 的结果图单独写回），其余字段（model/clip/vae/context/
        reference/config/sampler_name/scheduler/steps/cfg 等）均按 interface
        的修改生效，使后续 detailer block 拿到被 interface 修改后的 model 等。
        """
        if target is None or source is None:
            return
        sync_fields = (
            'model', 'clip', 'vae',
            'sampler_name', 'scheduler', 'steps', 'cfg',
            'context', 'reference', 'config',
        )
        for f in sync_fields:
            val = getattr(source, f, None)
            if val is not None and getattr(target, f, None) is not val:
                setattr(target, f, val)
        # loras 以 list 形式存在于 context 中，已在 context 同步时覆盖；
        # 若 PipelineData 另有显式 loras 字段也一并同步
        if hasattr(source, 'loras') and getattr(source, 'loras', None) is not None:
            setattr(target, 'loras', getattr(source, 'loras'))

    def _execute_interface(self, server, interface_idx, manual_values, exec_options=None,
                            input_image=None, input_mask=None, return_image=False,
                            base_pipeline=None):
        """Execute a sub-graph via InterfaceExecutor.

        Args:
            return_image: 若 True，执行结果只作为返回值 (result_img, result_mask)，
                          不写入 history、不切换 context（用于 chain 内 interface 块，
                          结果作为 pipeline 流转的中间图）。
            input_image / input_mask: 显式指定的输入图/mask（chain 内由上一 block 提供）。
                                      未指定时回退到 base_pipeline 的 image/mask。
            base_pipeline: 执行所基于的 pipeline（chain 内为上一 block 输出的 pipeline，
                          携带 model/clip/context/image/mask）。未指定时回退到
                          self._current_pipeline（独立 interface tab 执行场景）。
                          注意：chain 模式下不在此提前解析 prompt tab 的 lora/prompt，
                          上下文完全由 pipeline 原样传递，由后续 detailer block 解析。
        """
        if interface_idx >= len(server.interface_packages):
            raise ValueError(f"Interface index {interface_idx} out of range ({len(server.interface_packages)} interface packages)")

        exec_options = exec_options or {}
        operation = exec_options.get('operation', 'default')
        image_keys = exec_options.get('image_keys', {})  # {port_num_str: history_key}
        crop_reserve = int(exec_options.get('crop_reserve', 32))

        pkg = server.interface_packages[interface_idx]
        from .interface_node import InterfaceExecutor

        # pipeline 来源：优先使用 chain 传入的 base_pipeline（上一 block 输出的 pipeline，
        # 携带正确的 model/clip/context/image/mask）；否则回退独立 tab 的 _current_pipeline。
        chain_mode = base_pipeline is not None
        base_src = base_pipeline if chain_mode else self._current_pipeline
        injected_pipeline = base_src.copy() if base_src else None

        # 仅在非 chain 模式（独立 interface tab）提前把 prompt tab 的 lora/prompt 注入到
        # pipeline 上下文；chain 模式完全通过 pipeline 传递，不在此解析 prompt/lora。
        if not chain_mode:
            user_positive, user_loras = self._parse_prompt(server.prompt_server)
            if injected_pipeline and (user_positive or user_loras):
                from .sampler_node import SamplerContext
                entry = SamplerContext()
                entry.positive = user_positive
                entry.negative = ''
                entry.loras = get_loras_from_string(user_loras) if user_loras else []
                injected_pipeline.context.contexts['__prompt_tab__'] = entry
        # 默认注入的图 + mask (context image)
        # chain 模式：优先使用调用方显式传入的输入图/mask（来自上一 block 的 pipeline）
        base_img = input_image if input_image is not None else (
            injected_pipeline.get_image() if injected_pipeline else None)
        base_mask = input_mask if input_mask is not None else (
            injected_pipeline.mask if injected_pipeline else None)

        # 关键：把 resized 工作区图/mask 同步进 injected_pipeline，使子图内部通过
        # pipeline.get_image()/pipeline.mask 取到的也是预处理后的工作区尺寸（而非原始全图）。
        # 否则子图若从 pipeline 取 image，会拿到 crop/limit 之前的原始全图，与 mask 尺寸
        # 不一致导致后续 recover_crop 崩溃。此处仅同步尺寸状态，不做额外 resize。
        if injected_pipeline is not None:
            if base_img is not None:
                injected_pipeline.image = base_img
            if base_mask is not None:
                injected_pipeline.mask = base_mask

        # 构建端口级图片覆盖
        port_overrides = {}
        for port_num_str, key in image_keys.items():
            if key:
                img = server.get_history_image(key)
                if img is not None:
                    port_overrides[int(port_num_str)] = img
                    print(f"[InterfaceExec] Port {port_num_str} image override: key={key}")

        injected_img = base_img
        injected_mask = base_mask
        pending_crop = None

        # Crop mask 区域 (基于 context image + mask)
        if operation == 'crop':
            if base_img is None or base_mask is None:
                raise ValueError("Crop operation requires both image and mask")
            exp_mask = expand_mask(base_mask, grow=32, blur=32)
            cropped_img, cropped_mask, crop_info = crop_mask(
                image=base_img, mask=exp_mask, reserve=crop_reserve)
            injected_img, injected_mask = cropped_img, cropped_mask
            pending_crop = {
                'crop_info': crop_info,
                'original': base_img,
                'mask': cropped_mask,
            }
            print(f"[InterfaceExec] cropped {base_img.shape} → {cropped_img.shape} crop_info={crop_info}")

        # 记录 interface 结果 keys
        server.interface_result_keys = []

        # 不在执行期直接加 history——等 uncrop 之后再以最终图加入
        def _on_result_image(img, name):
            pass

        # chain 模式：捕获 interface 返回的（被修改过的）pipeline，
        # 将其 model/clip/context/lora 等修改写回上游 pipeline，
        # 使后续 detailer block 拿到的就是被 interface 修改后的 model 等。
        result_pipeline = None

        def _on_result_pipeline(pipe, name):
            nonlocal result_pipeline
            if pipe is not None:
                result_pipeline = pipe

        executor = InterfaceExecutor(
            extra_pnginfo=getattr(server, 'extra_pnginfo', None),
            on_progress=lambda cur, total: setattr(server, 'interface_current_step', cur) or setattr(server, 'interface_total_steps', total) or setattr(server, 'interface_progress', cur / max(total, 1)),
            get_pipeline=lambda: injected_pipeline,
            get_image=lambda: injected_img,
            get_mask=lambda: injected_mask,
            on_result_image=_on_result_image,
            on_result_pipeline=_on_result_pipeline if return_image else None,
            on_sampler_progress=lambda cur, total, node_id: setattr(server, 'interface_current_step', cur) or setattr(server, 'interface_total_steps', total) or setattr(server, 'interface_progress', cur / max(total, 1)),
        )

        results = executor.execute(pkg, manual_values, port_overrides=port_overrides)

        # Uncrop：将裁剪结果复原回完整图
        if pending_crop is not None:
            uncropped_results = []
            for item in results:
                ptype, img, name = item
                if ptype == 'IMAGE':
                    uncropped, _ = recover_crop(
                        background=pending_crop['original'],
                        image=img,
                        crop_info=pending_crop['crop_info'],
                        recover_method='mask_blend',
                        mask=pending_crop['mask'],
                    )
                    uncropped_results.append(('IMAGE', uncropped, name))
                else:
                    uncropped_results.append(item)
            results = uncropped_results
            print(f"[InterfaceExec] uncropped {len(results)} results back to full size")

        # 提取结果图 / mask
        result_img = None
        result_mask = base_mask
        for ptype, img, name in results:
            if ptype == 'IMAGE' and result_img is None:
                result_img = img
                print(f"[InterfaceExec] result image: {name} {img.shape if hasattr(img, 'shape') else ''}")

        if return_image:
            # chain 模式：仅返回结果，不写 history / 不切换 context
            if result_img is None:
                print("[InterfaceExec] WARNING: no IMAGE result returned, keeping input")
                result_img = base_img
            # 将 interface 内部对 pipeline 的修改（model/clip/context/loras 等）写回上游
            # pipeline，使后续 detailer block 拿到的是被 interface 修改后的 model 等。
            if result_pipeline is not None and base_pipeline is not None:
                self._sync_pipeline_updates(base_pipeline, result_pipeline)
                print(f"[InterfaceExec] chain: synced interface pipeline updates (model/clip/context/loras) back to upstream pipeline")
            return result_img, result_mask

        # 以最终（可能已 uncrop）图加入 history，并记录 keys
        for ptype, img, name in results:
            if ptype == 'IMAGE':
                server.add_history(img, name=name)
                if server.selected_history:
                    server.interface_result_keys.append(server.selected_history[-1]['key'])

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
               align=8, crop_reserve=32, mask_grow=32, mask_blur=32, enable_edit="disable", detector=None, tagger=None, asset="", package=None,
               extra_pnginfo=None, unique_id=None):
        mm.throw_exception_if_processing_interrupted()

        self._current_pipeline = pipeline.copy() if pipeline else None
        # 保存"原始 pipeline"引用：仅在初始化 / Pipeline tab 切换时设定。
        # 每次 Run detailer 都基于它的副本执行，run 之间不共享、不累积修改。
        self._base_pipeline = self._current_pipeline

        # Derive lora_regex from pipeline's architecture config if not explicitly provided
        if not lora_regex and pipeline and pipeline.config:
            arch = pipeline.config.get("architecture")
            if arch:
                lora_regex = str(arch)

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
                'mask_grow': mask_grow,
                'mask_blur': mask_blur,
                'enable_edit': enable_edit == "enable",
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

                        # Blend 工作台：输入图 = 画布合成图，遮罩 = 纯 Mask 层，两者随 action 送达。
                        # 走这条路时完全不动 _current_pipeline 的 image/mask，也就没有 context 切换。
                        from_blend = bool(action.get('from_blend'))
                        blend_image = server.blend_image if from_blend else None
                        if from_blend:
                            current_mask = server.blend_mask
                        else:
                            current_mask = self._current_pipeline.mask
                        if current_mask is not None:
                            current_mask = current_mask.clone()

                        # 追加 prompt：只拼在 _parse_prompt 的结果之后，不写回 prompt 阶段状态，
                        # 所以语义上是「追加描述」而不是「替换 prompt」。
                        extra_prompt = (action.get('extra_prompt') or '').strip() if from_blend else ''
                        if extra_prompt:
                            user_positive = f"{user_positive}, {extra_prompt}" if user_positive else extra_prompt

                        # 遮罩必须存在，否则 detailer 无意义
                        if current_mask is None or (hasattr(current_mask, 'sum') and current_mask.sum().item() == 0):
                            server.detail_status = 'error'
                            server.detail_error = 'Mask is required — paint the mask layer before running the detailer'
                            continue

                        # 每次 Run 都基于"原始 pipeline"的副本执行——run 之间不共享、
                        # 不累积上一轮对 pipeline 的修改。用户当前绘制的 mask 属于交互
                        # 状态，单独合并进副本（原始 image / model 来自 base）。
                        if self._base_pipeline is None:
                            server.detail_status = 'error'
                            server.detail_error = 'Pipeline not initialized — switch a pipeline in the Pipeline tab first'
                            continue
                        run_pipeline = self._base_pipeline.copy()
                        run_pipeline.mask = current_mask.clone() if current_mask is not None else None

                        # Blend 工作台：输入图就是画布合成图（Blend 画布 = Context Image）。
                        if blend_image is not None:
                            run_pipeline.image = blend_image.clone()

                        # 诊断：打印 mask 和 image 的尺寸信息
                        diag_img = run_pipeline.image
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

                        # Build global_params and blocks for pipeline execution
                        # 逐 run 的 start step 覆盖：取用即清空，这样下一次普通 Run 一定回落到
                        # pipeline 自己的值（否则上一轮 Generate 的覆盖会偷偷留下来）。
                        start_step_overrides = list(server.pending_start_steps or [])
                        server.pending_start_steps = []
                        global_params = {
                            'seed': seed,
                            'mask_grow': server.mask_grow,
                            'mask_blur': server.mask_blur,
                            'context_regex': context_regex,
                            'start_step_overrides': start_step_overrides,
                        }
                        blocks = server.blocks

                        next_pipeline, original_image, detailed_image, detail_meta = self._run_pipeline_blocks(
                            run_pipeline, current_mask, user_positive, user_loras, global_params, blocks, server=server
                        )

                        server.original_image = original_image
                        server.detailed_image = detailed_image
                        # Context 就是 Blend 画布本身，detailer 产出不再接管 context，
                        # 所以这里不记 context key（产出图由前端作为新图层叠加到画布上）。
                        server.original_key = None
                        server.detail_status = 'done'

                        # 添加到历史画廊。Recover Crop 关闭时带放置矩形 —— 产出图本身已是
                        # RGBA（alpha = 工作区 mask），Blend 工作台据此把它作为新图层
                        # transform 贴回原位。
                        server.add_history(
                            detailed_image,
                            name=f'Detail #{len(server.selected_history)}',
                            place=(detail_meta or {}).get('place'),
                        )
                        new_key = server.selected_history[-1]['key']
                        server.detailed_key = new_key

                        # 更新 pipeline（保留 model/vae/latent 等流转状态）
                        self._current_pipeline = next_pipeline

                        # 清理 prompt 中的 program-sourced 项（parsing tag 保留，在 tag 阶段转换）
                        if server.prompt_server:
                            server.prompt_server.selected_prompts = [
                                p for p in (server.prompt_server.selected_prompts or [])
                                if not (isinstance(p, dict) and p.get('source', 'normal') == 'program')
                            ]
                            # 先保存完整的 program 处理后的结果（含 program 来源项），用于预览/快照，
                            # 再剥离 program 项用于实际生成。
                            full_loras = list(server.prompt_server.selected_loras) if isinstance(server.prompt_server.selected_loras, list) else []
                            full_prefabs = list(server.prompt_server.selected_prefabs) if isinstance(server.prompt_server.selected_prefabs, list) else []
                            server.prompt_server.selected_loras = [
                                l for l in full_loras
                                if l.get('source', 'normal') != 'program'
                            ]
                            server.prompt_server.selected_prefabs = [
                                p for p in full_prefabs
                                if p.get('source', 'normal') != 'program'
                            ]
                            server.prompt_server.last_selected = [
                                p['text'] if isinstance(p, dict) else p
                                for p in server.prompt_server.selected_prompts
                                if (p.get('source', 'normal') if isinstance(p, dict) else 'normal') != 'program'
                            ]
                            # 快照/预览使用完整结果（保留 program 添加/修改的 lora 与 prefab）
                            server.prompt_server.last_selected_loras = full_loras
                            server.prompt_server.last_selected_prefabs = full_prefabs
                            server.prompt_server.custom_prompts = ''

                    except Exception as e:
                        # Check if this is a ComfyUI interrupt
                        if mm.processing_interrupted() or "interrupt" in str(e).lower() or "processing" in str(e).lower():
                            print("[SnapshotDetailerSampler] Interrupted during detailer")
                            break
                        import traceback
                        traceback.print_exc()
                        server.detail_status = 'error'
                        server.detail_error = str(e)
                    finally:
                        comfy.utils.set_progress_bar_global_hook(orig_hook)
                        server.detail_progress = 1.0 if server.detail_status == 'done' else server.detail_progress
                        # 本次 run 的 blend 输入已消费完，释放引用
                        server.blend_image = None
                        server.blend_mask = None
                        server.blend_prompt = ''

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
                    exec_options = action.get('exec_options', {})
                    server.interface_status = 'running'
                    server.interface_error = None
                    server.interface_progress = 0
                    server.interface_current_step = 0
                    server.interface_total_steps = 0
                    try:
                        self._execute_interface(server, interface_idx, manual_values, exec_options)
                        server.interface_status = 'done'
                        server.interface_progress = 1.0
                    except Exception as e:
                        if mm.processing_interrupted() or "interrupt" in str(e).lower() or "processing" in str(e).lower():
                            print("[SnapshotDetailerSampler] Interrupted during interface execution")
                            break
                        import traceback
                        traceback.print_exc()
                        server.interface_status = 'error'
                        server.interface_error = str(e)
                    finally:
                        gc.collect()
                        mm.soft_empty_cache()

        finally:
            print("[SnapshotDetailerSampler] Stopping servers...")
            server.stop()
            print("[SnapshotDetailerSampler] Servers stopped.")

        # 如果是因 interrupt 而 break 出循环，重新抛出异常通知 ComfyUI
        if mm.processing_interrupted():
            raise RuntimeError("Processing interrupted")

        if server.window_closed and not server.finished:
            raise RuntimeError("[SnapshotDetailerSampler] Window closed without finishing")

        # 如果用户在 finish 时选了历史图片，用它作为最终输出
        # 先清空已有的 image 和 latent，再追加选中的图片
        if server.finish_selected_keys and len(server.finish_selected_keys) > 0:
            selected_images = []
            for key in server.finish_selected_keys:
                img = server.get_history_image(key)
                if img is not None:
                    selected_images.append(img)
            if selected_images:
                self._current_pipeline.image = selected_images if len(selected_images) > 1 else selected_images[0]
            self._current_pipeline.latent = None

        result = self._current_pipeline
        self._current_pipeline = None

        if result is None:
            raise RuntimeError("[SnapshotDetailerSampler] Pipeline is None")
        return (result,)
