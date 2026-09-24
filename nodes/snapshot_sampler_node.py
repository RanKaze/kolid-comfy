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
import copy
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
from ..libs.generate_text_utils import apply_generate_text_to_prompt
from ..libs import debug_trace as dbg
from ..architecture import Krea2 as arch_krea2, Flux2Klein as arch_flux2klein, QwenImage21 as arch_qwen_image21
import gc
import uuid


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
        if not isinstance(self.blocks_sets, list):
            self.blocks_sets = [{'id': 'set-1', 'name': 'Default', 'blocks': self.blocks}]
        self.active_block_set = cfg.get('active_block_set')
        if self.blocks_sets:
            if not any(s.get('id') == self.active_block_set for s in self.blocks_sets):
                self.active_block_set = self.blocks_sets[0].get('id')
        else:
            self.active_block_set = None
        active_set = next((s for s in self.blocks_sets if s.get('id') == self.active_block_set), None)
        if active_set and active_set.get('blocks'):
            self.blocks = active_set['blocks']
        # Disk persistence: the tab sets survive ComfyUI restarts (the in-memory chain only lives
        # as long as the session). The file wins over the migrated config when it exists.
        f_sets, f_active = self._load_blocks_sets_file()
        if f_sets is not None:
            self.blocks_sets = f_sets
            if f_sets:
                self.active_block_set = f_active if any(s.get('id') == f_active for s in f_sets) else f_sets[0].get('id')
                active_set = next((s for s in self.blocks_sets if s.get('id') == self.active_block_set), None)
                if active_set and active_set.get('blocks'):
                    self.blocks = active_set['blocks']
            else:
                self.active_block_set = None
                self.blocks = []
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
        # 逐 run 的 pipeline preset 选择（blocks_sets 里某一 set 的 id）。
        # 由「图层右键 → Generate」的 enum 下发；主循环取用后立即清空，避免污染下一次普通 Run。
        self.pending_generate_preset = None

        # Query 块：run 到它时链条停在这里等用户在弹窗里挑 prompt。run 循环阻塞在
        # pending_query['event'] 上；前端轮询 /api/status 看到 pending_query 就弹窗，
        # 回答 POST 到 /api/query_answer 唤醒。None = 当前没有块在等。
        self.pending_query = None
        # 一个 Query 块等多久（秒）。超时按用户的选择 = 中止整条链。
        self.query_timeout = 600

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

    def _first_detailer_enable_mask(self, preset_id=None):
        """生效链第一个 detailer 的 Enable Mask 总闸（默认开）。

        preset_id 能解出 block set 时看那套链，否则看激活 tab 的镜像（self.blocks）——
        与 run_detailer 主循环选链的优先级一致。Enable Mask 关 = 不做围绕 mask 的
        grow/blur/crop 预处理，整幅图就是工作区：Mask 层没画也允许跑（run 的
        「Mask is required」闸门据此放行，mask 变成可选的重绘限制）。

        ★ 类归属：Server（HTTP handler 用 inst.、主循环用 server. 都拿得到 blocks 镜像）。
        """
        blocks = self.blocks or []
        if preset_id:
            preset_set = next(
                (s for s in (self.blocks_sets or [])
                 if isinstance(s, dict) and s.get('id') == preset_id and s.get('blocks')),
                None,
            )
            if preset_set is not None:
                blocks = preset_set['blocks']
        bp = next((b.get('params', b) for b in blocks
                   if isinstance(b, dict) and b.get('type') == 'detailer'), None)
        return bool(bp.get('enable_mask', True)) if isinstance(bp, dict) else True

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
            if isinstance(sets, list):
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
            if isinstance(sets, list):
                self.blocks_sets = sets
        if 'active_block_set' in data and data['active_block_set']:
            self.active_block_set = data['active_block_set']
        if 'blocks_sets' in data or 'active_block_set' in data:
            if self.blocks_sets:
                if not any(s.get('id') == self.active_block_set for s in self.blocks_sets):
                    self.active_block_set = self.blocks_sets[0].get('id')
                active_set = next((s for s in self.blocks_sets if s.get('id') == self.active_block_set), None)
                if active_set is not None:
                    self._set_blocks(active_set.get('blocks') or [])
            else:
                self.active_block_set = None
                self._set_blocks([])
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
            # pixels / align / crop_reserve 不再从块参数同步 —— 它们是 GLOBAL SETTINGS
            # （server config），不按 preset 区分；块里遗留的旧值一律忽略。
            self.enable_edit = bool(bp.get('enable_edit', self.enable_edit))
            self.edit_mode = bp.get('edit_mode', self.edit_mode)
            self.ref_boost = float(bp.get('ref_boost', self.ref_boost))
            self.ref_boost_a = float(bp.get('ref_boost_a', self.ref_boost_a))
            self.enable_ref_boost_mask = bool(bp.get('enable_ref_boost_mask', self.enable_ref_boost_mask))
            self.grounding_px = int(bp.get('grounding_px', self.grounding_px))
            self.context_reference = bool(bp.get('context_reference', self.context_reference))
            self.context_reference_key = bp.get('context_reference_key', self.context_reference_key)

    # ------------------------------------------------------------------
    # Prompt presets — 共享、持久化的 selection 模板；Prompt 块只存 preset_id 引用。
    # 预设内容（tags/custom/loras/prefabs/programs 的 raw selection）存 nodes/prompt_presets.json，
    # 编辑 preset 即影响所有引用它的块；run 时按块顺序注入其后的 detailer（纯临时）。
    # ------------------------------------------------------------------
    def _prompt_presets_file(self):
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), 'prompt_presets.json')

    def _load_prompt_presets(self):
        """Persisted prompt presets: [{'id','name','selection'}]. Absent/corrupt file -> []."""
        try:
            with open(self._prompt_presets_file(), encoding='utf-8') as f:
                data = json.load(f)
            presets = data.get('presets') if isinstance(data, dict) else data
            if isinstance(presets, list):
                return [p for p in presets if isinstance(p, dict) and p.get('id')]
        except Exception:
            pass
        return []

    def _save_prompt_presets(self, presets):
        with open(self._prompt_presets_file(), 'w', encoding='utf-8') as f:
            json.dump({'presets': presets}, f, ensure_ascii=False, indent=2)

    def _find_prompt_preset(self, preset_id):
        if not preset_id:
            return None
        for p in self._load_prompt_presets():
            if isinstance(p, dict) and p.get('id') == preset_id:
                return p
        return None

    def _prompt_preset_selection(self, preset_id):
        """Raw selection of the referenced preset; {} when unset/missing (block = pass-through)."""
        preset = self._find_prompt_preset(preset_id)
        sel = preset.get('selection') if isinstance(preset, dict) else None
        return sel if isinstance(sel, dict) else {}

    def _create_prompt_preset(self, name=None):
        presets = self._load_prompt_presets()
        if isinstance(name, str) and name.strip():
            name = name.strip()
        else:
            existing = {p.get('name') for p in presets}
            k = 1
            while f'Preset {k}' in existing:
                k += 1
            name = f'Preset {k}'
        preset = {'id': 'preset-' + uuid.uuid4().hex[:12], 'name': name, 'selection': {}}
        presets.append(preset)
        self._save_prompt_presets(presets)
        return preset

    def _save_prompt_preset_selection(self, preset_id, selection):
        presets = self._load_prompt_presets()
        for p in presets:
            if p.get('id') == preset_id:
                p['selection'] = selection
                self._save_prompt_presets(presets)
                return True
        return False

    def _rename_prompt_preset(self, preset_id, name):
        if not isinstance(name, str) or not name.strip():
            return False
        presets = self._load_prompt_presets()
        for p in presets:
            if p.get('id') == preset_id:
                p['name'] = name.strip()
                self._save_prompt_presets(presets)
                return True
        return False

    def _delete_prompt_preset(self, preset_id):
        """Delete the preset only. Blocks keep the now-dangling id on purpose: the UI
        renders it as `(missing)` so the reference stays visible and can be re-pointed,
        and a run treats a missing preset as an empty selection (logged + skipped).
        Nothing is rewritten behind the user's back."""
        presets = self._load_prompt_presets()
        kept = [p for p in presets if p.get('id') != preset_id]
        if len(kept) == len(presets):
            return False
        self._save_prompt_presets(kept)
        return True

    def _pending_query_view(self):
        """What /api/status publishes: which Query block is parked waiting for an answer.

        The run loop owns the wait (it blocks on the event); this is only the read-only
        projection the sampler polls to know it must open the prompt dialog. The event
        itself never crosses the wire.
        """
        q = self.pending_query
        if not q:
            return None
        return {'id': q.get('id'), 'name': q.get('name'), 'index': q.get('index')}

    def _answer_pending_query(self, selection=None, cancelled=False):
        """Release a parked Query block with the user's choice (or their cancellation).

        `selection` is the RAW prompt-node selection — the run loop merges it and runs its
        programs exactly like a prompt block's preset. `cancelled` (closing the dialog,
        not answering) aborts the whole chain. False = nothing was waiting.
        """
        q = self.pending_query
        if not q:
            return False
        if cancelled:
            q['cancelled'] = True
        else:
            q['answer'] = selection if isinstance(selection, dict) else {}
        self.pending_query = None
        evt = q.get('event')
        if evt is not None:
            evt.set()
        return True

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
                    'pending_query': inst._pending_query_view() if inst else None,
                })
                return

            if self.path == '/api/debug_trace':
                self._send_json(dbg.debug_trace_snapshot())
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

            if self.path == '/api/prompt_presets':
                self._send_json({'presets': inst._load_prompt_presets() if inst else []})
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

            if self.path == '/api/prompt_presets':
                # Prompt preset 管理：Prompt 块引用的共享 selection 模板（prompt_node.html
                # 的 preset 作用域 iframe 通过 action=save 写入），持久化到
                # nodes/prompt_presets.json。action: create | save | rename | delete。
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    action = body.get('action') or ''
                    if action == 'create':
                        self._send_json({'ok': True, 'preset': inst._create_prompt_preset(body.get('name'))})
                    elif action == 'save':
                        selection = body.get('selection')
                        if not isinstance(selection, dict):
                            self._send_json({'ok': False, 'error': 'selection must be an object'}, 400)
                        elif inst._save_prompt_preset_selection(body.get('id') or '', selection):
                            self._send_json({'ok': True})
                        else:
                            self._send_json({'ok': False, 'error': 'preset not found'}, 404)
                    elif action == 'rename':
                        if inst._rename_prompt_preset(body.get('id') or '', body.get('name')):
                            self._send_json({'ok': True})
                        else:
                            self._send_json({'ok': False, 'error': 'preset not found or bad name'}, 404)
                    elif action == 'delete':
                        if inst._delete_prompt_preset(body.get('id') or ''):
                            self._send_json({'ok': True})
                        else:
                            self._send_json({'ok': False, 'error': 'preset not found'}, 404)
                    else:
                        self._send_json({'ok': False, 'error': f'unknown action {action!r}'}, 400)
                except Exception as e:
                    self._send_json({'ok': False, 'error': str(e)}, 500)
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

            if self.path == '/api/query_answer':
                # 一个 Query 块正停在链条里等用户挑 prompt。`selection` 是 prompt UI 的 raw
                # 选择（后端按 prompt 块同样的规则合并 + 跑 programs）；`cancelled` = 用户
                # 关掉了弹窗 —— 整条链中止。
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    answered = inst._answer_pending_query(
                        selection=body.get('selection'),
                        cancelled=bool(body.get('cancelled')),
                    ) if inst else False
                    self._send_json({'success': answered})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'success': False, 'error': str(e)}, 500)
                return

            if self.path == '/api/cancel_run':
                # 前端 Run 按钮在运行中变成 Cancel。点击 = 走 ComfyUI 的原生打断：
                # 全局 interrupt 标志让 KSampler 在下一个采样步抛
                # InterruptProcessingException；块循环里的检查点会在 block / Generate
                # Text 边界抛同一个异常。run_detailer 的 except 把它转成
                # status='cancelled'（不炸节点、不停 server）。
                try:
                    mm.interrupt_current_processing(True)
                    print("[SnapshotDetailerSampler] Cancel requested — interrupt flag set")
                    self._send_json({'success': True})
                except Exception as e:
                    self._send_json({'success': False, 'error': str(e)}, 500)
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
                        # The Generate dialog's Pipeline Preset enum: which block set runs this
                        # generate. Invalid/absent ids fall back to the server's runner chain.
                        preset_id = body.get('preset_id')
                        if not isinstance(preset_id, str) or not preset_id:
                            preset_id = None
                        inst.blend_image = layer_image
                        inst.blend_mask = layer_mask.squeeze(-1)
                        inst.blend_prompt = (body.get('extra_prompt') or '').strip()
                        # Consumed once by the main loop, then cleared, so a later toolbar run is
                        # not silently stuck on this preset.
                        inst.pending_generate_preset = preset_id
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
                    # 遮罩必须存在，否则 detailer 无意义 —— 例外：Enable Mask 总闸关
                    # （生效链第一个 detailer 的 params.enable_mask，随 Run 设置里的
                    # preset 解析）时整幅都是工作区，Mask 层没画也允许跑。
                    if (inst._first_detailer_enable_mask(body.get('preset_id'))
                            and (mask is None or float(mask.sum()) == 0)):
                        self._send_json({'success': False, 'error': 'Mask is required — paint the mask layer before running the detailer'}, 400)
                        return
                    inst.blend_image = image
                    inst.blend_mask = mask
                    inst.blend_prompt = (body.get('extra_prompt') or '').strip()
                    # The Run settings dialog's Pipeline Preset: which block set runs this pass.
                    # Absent / invalid -> the runner's own chain (the active tab). Consumed once
                    # by the main loop, so a later run is not stuck on a stale choice.
                    run_preset = body.get('preset_id')
                    if not isinstance(run_preset, str) or not run_preset:
                        run_preset = None
                    inst.pending_generate_preset = run_preset
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
    def _expand_prefabs(self, prompt_server, selected=None):
        """Expand selected prefab instances into (prompt_texts, loras).

        `selected` defaults to the prompt server's own selection; the prompt-BLOCK runner
        passes an explicit (program-resolved) instance list instead. A synced prefab entry
        carries only INSTANCE state — guid, active flag, per-tag-group
        active flags, per-lora active flags (see the prompt iframe's sync-prompt payload). The
        tag and lora CONTENT lives in the prefab library, looked up by guid. Without this
        expansion a user whose prompt lives in a prefab — the common case, and the log proves
        it: "/select_prompt received: prompts=0 ... loras=0, prefabs=1" — generated with an
        EMPTY prompt, because _parse_prompt() used to read only selected_prompts /
        custom_prompts / selected_loras and dropped prefabs entirely. The main graph run was
        never affected (SnapshotPromptNode.snapshot_prompt expands prefabs there), which is
        exactly why only the interactive Generate / Run-Detailer looked "not injected".
        Mirrors snapshot_prompt()'s expansion: per-tag-group active state, [decoration]
        nesting, (text:strength) wrapping, prefab custom_prompts, recursive children,
        per-lora active state and lora_regex validity.
        """
        texts = []
        loras = []
        if prompt_server is None:
            return texts, loras
        if selected is None:
            selected = getattr(prompt_server, 'selected_prefabs', None) or []
        if not selected:
            return texts, loras
        guid_to_prefab = {}
        for lib_data in (getattr(prompt_server, 'libraries_data', None) or {}).values():
            if isinstance(lib_data, dict):
                for pf in (lib_data.get('prefabs') or []):
                    guid = pf.get('guid') if isinstance(pf, dict) else None
                    if guid:
                        guid_to_prefab[guid] = pf
        valid_paths = getattr(prompt_server, '_valid_lora_paths', None) or set()

        def expand(node, visited):
            if not isinstance(node, dict) or not node.get('active', True):
                return
            guid = node.get('guid')
            if not guid or guid in visited:
                return
            visited.add(guid)
            pf = guid_to_prefab.get(guid)
            if not pf:
                return
            # Per-group active state lives on the INSTANCE under tag_groups (the sync payload's
            # format: {guid, active, tag_groups: [{key, active}], loras, children}); the
            # standalone graph flow stores the same states under `tags`. Read both.
            tag_states = {
                t.get('key'): t.get('active', True)
                for t in (node.get('tag_groups') or node.get('tags') or [])
                if isinstance(t, dict)
            }
            for tag_group in pf.get('tag_groups', pf.get('tags', [])):
                # Group identity: the interactive library stores a group NAME under `key`; the
                # standalone format identifies a group by its joined tag names. Try both.
                def group_key(g):
                    if isinstance(g, dict) and g.get('key'):
                        return g.get('key')
                    tags = g.get('tags') if isinstance(g, dict) else g
                    return ' '.join(
                        t.get('name') or t.get('prompt', '') for t in (tags or []) if isinstance(t, dict))
                # New TagGroup format: { tags: [...], strength } — strength wraps the group.
                if isinstance(tag_group, dict) and 'tags' in tag_group:
                    group_tags = tag_group.get('tags', [])
                    group_strength = tag_group.get('strength', 1.0)
                    if not tag_states.get(group_key(tag_group), True):
                        continue
                    parts = []
                    for i, tag in enumerate(group_tags):
                        if isinstance(tag, dict):
                            prompt_text = tag.get('prompt', '')
                            deco_level = len(group_tags) - 1 - i  # last = 0 (base)
                            text = ('[' * deco_level + prompt_text + ']' * deco_level) if deco_level > 0 else prompt_text
                            parts.append(text)
                    if parts:
                        # Same cleaned form the detailer consumes: no [] decoration, (x:strength) kept.
                        prompt_str = ' '.join(parts).replace('[', '').replace(']', '')
                        if group_strength != 1.0:
                            prompt_str = f"({prompt_str}:{group_strength})"
                        if prompt_str not in texts:
                            texts.append(prompt_str)
                # Old format: Tag[] — per-tag decoration/strength.
                elif isinstance(tag_group, list):
                    if not tag_states.get(group_key(tag_group), True):
                        continue
                    parts = []
                    for tag in tag_group:
                        if isinstance(tag, dict):
                            prompt_text = tag.get('prompt', '')
                            deco = tag.get('decoration_num') or 0
                            strength = tag.get('strength', 1.0)
                            text = ('[' * deco + prompt_text + ']' * deco) if deco > 0 else prompt_text
                            if strength != 1.0:
                                text = f"({text}:{strength})"
                            parts.append(text)
                    if parts:
                        prompt_str = ' '.join(parts).replace('[', '').replace(']', '')
                        if prompt_str not in texts:
                            texts.append(prompt_str)
            cp = pf.get('custom_prompts', '')
            if cp:
                texts.append(cp)
            # Collect loras (per-lora active state from the instance, lora_regex validity)
            lora_states = {l.get('file_path'): l.get('active', True) for l in node.get('loras', [])}
            for lora_item in pf.get('loras', []):
                if not isinstance(lora_item, dict):
                    continue
                file_path = lora_item.get('file_path', '') or lora_item.get('file_name', '')
                if not file_path:
                    continue
                normalized_path = file_path.replace('\\', '/')
                if valid_paths and normalized_path not in valid_paths and file_path not in valid_paths:
                    continue
                if not lora_states.get(file_path, True):
                    continue
                exists = any((l.get('file_path', '') or l.get('file_name', '')) == file_path for l in loras)
                if not exists:
                    loras.append(lora_item)
            for child in node.get('children', []):
                expand(child, visited)

        for sp in selected:
            expand(sp, set())
        return texts, loras

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

            loras = list(prompt_server.selected_loras or [])
            # Prefab contents are part of the user's prompt: expand them (tags -> prompt text,
            # prefab loras -> loadable loras) and merge. See _expand_prefabs() for why this
            # cannot be skipped — a prefab-only selection otherwise generates with no prompt.
            prefab_texts, prefab_loras = self._expand_prefabs(prompt_server)
            loras.extend(prefab_loras)
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
            for text in prefab_texts:
                user_positive = f"{user_positive}, {text}" if user_positive else text
        return user_positive, user_loras

    # -------------------------------------------------------------------------
    # Prompt block（pipeline block type='prompt'）运行时解析
    # -------------------------------------------------------------------------
    def _resolve_prompt_block(self, server, block_params):
        # 块只存 preset 引用；内容来自共享 preset（未配置/被删 = 空 selection = 直通）
        sel = server._prompt_preset_selection((block_params or {}).get('preset_id'))
        return self._resolve_prompt_selection(server, sel)

    def _resolve_prompt_selection(self, server, sel):
        """Resolve one raw selection into (user_positive, user_loras) for the detailers AFTER it.

        Shared by the prompt block (whose selection is a persisted preset) and the Query
        block (whose selection is picked by the user at run time) — both are transient
        injections with identical semantics.

        Semantics (与产品确认过的行为一致):
          - 合并 = prompt 节点全局最终选择（selected_prompts/loras/prefabs，已是全局
            program 的产物）在前 + 该 raw selection 追加在后（source='program'
            的项剥离——它们会由 selection 的 program 重新生成，与前端 useProgram 语义一致）。
          - selection 的 applications(programs) 在**合并后的整体 selection**上执行（后端
            quickjs 引擎，移植 useProgram.ts），所以程序能过滤/修改全局内容。
          - 输出拼装顺序与 _parse_prompt 完全一致：texts + custom -> <lora:...> ->
            trigger words -> prefab texts。全局在前、selection 在后由合并顺序保证。
          - 纯临时：只影响本次 run 中排在该块之后的 detailer，不写回任何状态。
        """
        ps = server.prompt_server if server else None
        if ps is None:
            return '', ''
        sel = sel or {}

        # --- 合并 tags：全局在前（text -> 单 tag TagGroup），block 在后 ---
        merged_tags = []
        for p in (getattr(ps, 'selected_prompts', None) or []):
            text = p.get('text') if isinstance(p, dict) else str(p)
            src = p.get('source', 'normal') if isinstance(p, dict) else 'normal'
            if text.startswith('<') and text.endswith('>'):
                text = text[1:-1]
            if not text:
                continue
            merged_tags.append({'tags': [{'name': text, 'prompt': text, 'category': ''}],
                                'strength': 1.0, 'source': src})
        for g in (sel.get('tags') or []):
            if isinstance(g, dict) and g.get('source', 'normal') == 'program':
                continue
            if isinstance(g, dict):
                merged_tags.append(copy.deepcopy(g))

        # --- 合并 loras（按 file_path 去重，全局优先）与 prefabs（按 guid 去重）---
        merged_loras = []
        seen_lora = set()
        for l in list(getattr(ps, 'selected_loras', None) or []) + list(sel.get('loras') or []):
            if not isinstance(l, dict):
                continue
            fp = l.get('file_path') or l.get('file_name')
            if not fp or fp in seen_lora:
                continue
            seen_lora.add(fp)
            merged_loras.append(copy.deepcopy(l))
        merged_prefabs = []
        seen_guid = set()
        for p in list(getattr(ps, 'selected_prefabs', None) or []) + list(sel.get('prefabs') or []):
            if not isinstance(p, dict):
                continue
            guid = p.get('guid')
            if not guid or guid in seen_guid:
                continue
            seen_guid.add(guid)
            merged_prefabs.append(copy.deepcopy(p))

        custom_parts = [c for c in [getattr(ps, 'custom_prompts', '') or '', sel.get('custom_prompts') or ''] if c]
        merged_custom = '\n'.join(custom_parts)

        # --- block 的 programs 在合并 selection 上执行（无 programs = 原样通过）---
        from .prompt_program_engine import PromptProgramEngine, tags_to_display_string
        engine = PromptProgramEngine(ps)
        result = engine.run(sel.get('programs') or [], merged_tags, merged_loras, merged_prefabs, merged_custom)

        # --- 拼装（与 _parse_prompt 相同的顺序与格式）---
        parts = []
        for g in result['result_tags']:
            text = tags_to_display_string(g)
            if text.startswith('<') and text.endswith('>'):
                text = text[1:-1]
            if text:
                parts.append(text)
        if result['result_custom_prompts']:
            parts.append(result['result_custom_prompts'])
        user_positive = ','.join(parts)

        loras = list(result['result_loras'])
        prefab_texts, prefab_loras = self._expand_prefabs(ps, selected=result['result_prefabs'])
        loras.extend(prefab_loras)
        lora_str_parts = []
        trigger_words = []
        for lora_item in loras:
            if isinstance(lora_item, dict):
                if not lora_item.get('active', True):
                    continue
                file_path = lora_item.get('file_path', '') or lora_item.get('file_name', '')
                if hasattr(ps, '_resolve_lora_file_path'):
                    file_path = ps._resolve_lora_file_path(file_path)
                strength = lora_item.get('strength', 1.0)
                lora_str_parts.append(f"<lora_path:{file_path}:{strength}>")
                trigger_words.extend(lora_item.get('active_tags', []))
            else:
                lora_str_parts.append(str(lora_item))
        user_loras = ','.join(lora_str_parts)
        if trigger_words:
            trigger_str = ', '.join(trigger_words)
            user_positive = user_positive + ', ' + trigger_str if user_positive else trigger_str
        for text in prefab_texts:
            user_positive = f"{user_positive}, {text}" if user_positive else text
        return user_positive, user_loras

    def _await_query_answer(self, server, block, index):
        """Park the chain on a Query block until the user answers its prompt dialog.

        The run loop blocks on an Event while /api/status publishes the pending query and
        /api/query_answer releases it. ComfyUI's interrupt still reaches a parked chain.
        Cancelling the dialog (or never answering) ABORTS the whole chain — the user asked
        for the run to stop rather than continue with a prompt they never chose.
        """
        import threading as _threading
        import time as _time
        evt = _threading.Event()
        query = {
            'id': 'query-%d-%d' % (index, int(_time.time() * 1000)),
            'name': (block.get('name') if isinstance(block, dict) else None) or 'Query',
            'index': index,
            'event': evt,
            'answer': None,
            'cancelled': False,
        }
        server.pending_query = query
        print(f"[PipelineBlock {index + 1}] Query block '{query['name']}' — waiting for the user's prompt choice")
        timeout = float(getattr(server, 'query_timeout', 600) or 600)
        deadline = _time.time() + timeout
        try:
            while not evt.wait(0.5):
                mm.throw_exception_if_processing_interrupted()
                if _time.time() >= deadline:
                    raise RuntimeError(f'Query timed out after {int(timeout)}s — the chain was aborted')
        finally:
            # Whatever happens (answer / cancel / interrupt), nothing stays parked.
            server.pending_query = None
        if query['cancelled']:
            raise RuntimeError('Query cancelled — the chain was aborted')
        if query['answer'] is None:
            raise RuntimeError('Query answered with nothing — the chain was aborted')
        return query['answer']

    def _resolve_ref_image_for_generate_text(self, server, key):
        """取 Enable Edit 的 Ref Image（Context Ref 选中的那张），供 Generate Text 使用。

        语义（用户确认）：只有 `enable_edit` 开着、且该 block 真的选了 Ref Image 时才送图；
        取不到就返回 None（调用方静默降级为纯文本）。整体 fail-open —— 这里绝不抛异常，
        否则会顺着生成链路把整条采样链带崩。返回 [B,H,W,C] float tensor 或 None。

        ★ 类归属：必须留在 SnapshotDetailerSamplerNode（run 链路 `self.` 调用），
        不能搬到 Server —— 跨顶层类会退化成只在实机 run 时才炸的 AttributeError。
        """
        if server is None or not key:
            return None
        try:
            img = server.get_history_image(key)
            if img is None:
                print(f"[GenerateText] ref image key '{key}' not found — text-only")
                return None
            from ..libs.generate_text_utils import normalize_ref_image
            return normalize_ref_image(img)
        except Exception as e:
            print(f"[GenerateText] ref image lookup failed ({e}) — text-only")
            return None

    def _preflight_generate_text_images(self, images, clip, params):
        """把「这批图到底能不能变成 embedding」实测一遍，供 Debug 显示。

        用户反馈「感觉传进去的 image 并没有正确影响 text generate」—— 光看
        `describe_image_support` 的名字推断不够，这里**真的跑一次 tokenize**，
        数 token 流里有没有 `{'type': 'image'}` 元素：
          · (True,  '已确认 N 个 image embedding 进入 token 流')
          · (False, '★ 图不会生效 — use_default_template=False 绕过了视觉模板 …')
          · (None,  '未验证（tokenize 探针不可用: …)）
        全程 fail-open，绝不抛进采样链（探测用的 tokenize 不产生任何副作用：
        不采样、不解码、不碰 model）。
        """
        if not images or clip is None:
            return None, ''
        # ★ 探测 helper 一律用「模块级 import」拿，别在函数里 `from ..libs import`：
        #   相对导入会解析成 `kolid_comfy.libs.generate_text_utils`，一旦换了加载方式
        #   （装包 / spec_from_file_location / 测试 exec）就会 ImportError，外部表现
        #   是「静默不验证」—— 也就是说这个诊断自己会静默失效。
        try:
            from libs.generate_text_utils import (
                normalize_ref_images, describe_image_support,
                _tokens_contain_image_embedding, text_defeats_vision_template,
                strip_leading_chat_template)
        except Exception:
            try:
                from ..libs.generate_text_utils import (
                    normalize_ref_images, describe_image_support,
                    _tokens_contain_image_embedding, text_defeats_vision_template,
                    strip_leading_chat_template)
            except Exception as e:
                return None, f'未验证（helper 不可用: {e}）'
        try:
            # ★★ 探针必须走与运行时**同一条入口**：`images=`（list of [1,H,W,C]），
            #   而不是 `image=`；两者在 qwen3vl 里等价（内部会拆成同一个 list），
            #   但统一入口能保证 Debug 结论与 run_generate_text 的实测结论一致。
            #   踩过的坑：这里曾写成 `clip.tokenize(batch, ...)` —— 把整张图当 text 传，
            #   于是永远数不到 image embedding，Debug 里长期假报「图不会生效」，
            #   与 run_generate_text 的实测结论自相矛盾。
            img_list, kept = normalize_ref_images(images, single=True)
            if img_list is None:
                return False, '★ 图不会生效 — 没有可用图（尺寸不一致 / 归一失败）'
            ok, why = describe_image_support(clip, bool((params or {}).get(
                'use_default_template', True)))
            if not ok:
                return False, f'★ 图不会生效 — {why}'
            use_tpl = bool((params or {}).get('use_default_template', True))
            # ★★ 还有一个更隐蔽的坑：文本若以 `<|im_start|>` 之类的 chat 模板标记开头，
            #   编码器 qwen3vl.py:167 的 `skip_template = skip_template or
            #   text.startswith('<|im_start|>')` 会直接绕掉视觉模板 → 图静默失效。
            #   ★ 探针文本必须与运行时一致地做 strip（指令为空时文本就是 chat 模板本身，
            #   运行时已经 strip 掉了，探针不 strip 就会得出相反的结论）。
            instr = str((params or {}).get('_instruction') or '').strip()
            probe_text = instr if instr else 'x'
            try:
                probe_text, _ = strip_leading_chat_template(probe_text)
            except Exception:
                pass
            if not probe_text.strip():
                probe_text = 'x'  # 编码器对空文本会走 prevent_empty_text 分支
            tokens = clip.tokenize(
                probe_text, images=img_list, skip_template=not use_tpl,
                min_length=1, prevent_empty_text=True)
            found, count = _tokens_contain_image_embedding(tokens)
            if found:
                return True, (f'已确认生效 — {count} 个 image embedding 进入 token 流'
                              f'（{len(kept)} 张图）')
            return False, ('★ 图不会生效 — clip.tokenize 收到了图，但 token 流里'
                           '没有任何 image embedding（视觉模板被绕过 / 编码器非多模态）')
        except Exception as e:
            return None, f'未验证（tokenize 探针失败: {type(e).__name__}: {e}）'

    # -------------------------------------------------------------------------
    # Detailer
    # -------------------------------------------------------------------------
    def _run_pipeline_blocks(self, pipeline, user_mask, user_positive, user_loras, global_params, blocks, server=None, extra_prompt=''):
        seed = global_params['seed']
        mask_grow = int(global_params.get('mask_grow', 32))
        mask_blur = int(global_params.get('mask_blur', 32))
        context_regex = global_params['context_regex']
        next_pipeline = pipeline.copy()
        if next_pipeline.cache is None:
            raise ValueError('PipelineData cache is empty')
        if next_pipeline.model is None:
            raise ValueError('PipelineData model is empty, cannot Detailer')

        original_image = next_pipeline.get_image()
        if original_image is None:
            raise ValueError("No image available for detailer")

        dbg.record_block(0, f'链条开始（共 {len(blocks)} 个 block）',
                         f'enable_mask={bool((blocks[0].get("params", blocks[0]) or {}).get("enable_mask", True))}')
        dbg.record_stage('原始输入',
                         f'image={tuple(original_image.shape)}',
                         block=0,
                         user_positive=user_positive,
                         user_loras=list(user_loras or []))
        dbg.record_image('裁剪前原图（original_image）', original_image, block=0)
        if user_mask is not None:
            dbg.record_mask('原始 mask（未扩张）', user_mask, block=0)

        if user_mask is not None:
            user_mask = user_mask.clone()
            user_mask = (user_mask > 0).float()
        # First detailer block: Preprocess Settings 的开关存在它的 params 上（recover_crop /
        # enable_mask / enable_limit），所以这些开关每个 Pipeline Preset 各自一份。
        # crop_reserve / pixels / align 是 GLOBAL SETTINGS（server config → global_params），
        # 不再按 preset 区分。必须在这里先取 —— mask 扩张也要看 enable_mask。
        first_detailer = next((b for b in blocks if b.get('type') == 'detailer'), blocks[0])
        first_bp = first_detailer.get('params', first_detailer)
        # Enable Mask 关 = 不做围绕 mask 的三步预处理：grow/blur 归零、不按 mask 裁剪、
        # 不 recover crop。mask 本身仍然限制重绘区域 —— 关掉的只是它外面那几层。
        enable_mask = bool(first_bp.get('enable_mask', True))
        if not enable_mask:
            mask_grow = 0
            mask_blur = 0
        # mask 可能整体缺席（Enable Mask 关 + 没画 Mask 层）：expand_mask 不接受 None，
        # 没有 mask 就没有可扩张的东西，直接置 None（下游全部对 None 容错）。
        expanded_mask = (expand_mask(user_mask, grow=mask_grow, blur=mask_blur)
                         if user_mask is not None else None)
        dbg.record_mask('扩张 / 羽化后 mask', expanded_mask, block=0,
                        detail=f'grow={mask_grow}, blur={mask_blur}')

        # 整条链（含 interface block）都在 crop 工作区坐标系内运行；run 之前 crop，
        # run 之后由 recover 系列复原。interface block 不重算/不操作 mask 的 crop，
        # 但其输出尺寸须与 crop 工作区连贯（由用户/子图保证，pipeline 内不做 resize）。
        first_crop_reserve = int(global_params.get('crop_reserve', 32))
        # Preprocess Settings 的 Recover Crop 开关（与 crop_reserve 一样取自第一个
        # detailer block）。关掉时这一趟产出停在 crop 工作区：不 recover_size、不
        # recover_crop，patch 连同裁剪矩形交给前端，由 Blend 画布用 transform 贴回原位。
        do_recover_crop = bool(first_bp.get('recover_crop', True))
        if enable_mask:
            cropped_image, cropped_mask, crop_info = crop_mask(
                image=original_image,
                mask=expanded_mask,
                reserve=first_crop_reserve
            )
        else:
            # Enable Mask 关：整幅图就是工作区。没有裁剪矩形（crop_info=None），收尾
            # 也就不走 recover 与「patch 贴回」两条路 —— 产出本身就是整幅结果。
            cropped_image, cropped_mask, crop_info = original_image, expanded_mask, None
            print(f"[Detailer] Enable Mask off — no grow/blur, no crop, no recover; "
                  f"workspace = the full image {tuple(original_image.shape)}")
            dbg.record_stage('裁剪跳过（Enable Mask 关）',
                             f'工作区 = 整幅图 {tuple(original_image.shape)}', block=0)

        # limit_pixels 提到 crop 之后只做一次，确定全局工作分辨率（所有 block 共享）。
        # pixels / align 取自 GLOBAL SETTINGS（global_params ← server config），不再按
        # preset 区分。interface 之后的 block 不再单独 limit，pipeline 内不做额外 resize。
        limit_pixels_val = int(global_params.get('pixels', 1048576))
        limit_align = int(global_params.get('align', 8))
        # QwenImage2.1: crop 尺寸需与 vision token / latent 共享的 32 像素格对齐
        # 即使 Enable Limit 关掉也要保住 —— 它的 latent 网格不接受未对齐尺寸。
        needs_grid_align = bool(arch_qwen_image21.matches(next_pipeline.config))
        if needs_grid_align:
            limit_align = arch_qwen_image21.adjust_align(limit_align)
        enable_limit = bool(first_bp.get('enable_limit', True))
        if not enable_limit and not needs_grid_align:
            # Enable Limit 关：不缩放也不对齐，工作分辨率 = 裁剪（或整幅）分辨率。
            resized_image, resized_mask, resize_info = cropped_image, cropped_mask, None
        else:
            # 关掉像素预算但架构要求对齐时，把目标定成「当前像素 + 一格」：既不放大也
            # 不缩小，只让 limit_pixels 把尺寸落到 align 的格子上。
            budget = limit_pixels_val
            if not enable_limit:
                _b, _h, _w, _c = cropped_image.shape
                budget = _h * _w + 4 * limit_align * limit_align
            resized_image, resized_mask, resize_info = limit_pixels(
                image=cropped_image,
                pixels=budget,
                mask=cropped_mask,
                align=limit_align,
            )

        current_image = resized_image
        current_mask = resized_mask
        last_resize_info = None
        dbg.record_stage('裁剪 + 缩放后工作区',
                         f'image={tuple(resized_image.shape)}'
                         + (f', mask={tuple(resized_mask.shape)}' if resized_mask is not None else ', mask=None'),
                         block=0,
                         crop_info=({k: (list(v) if isinstance(v, tuple) else v)
                                     for k, v in crop_info.items()} if isinstance(crop_info, dict) else crop_info),
                         resize_info=(list(resize_info) if isinstance(resize_info, (list, tuple)) else resize_info))
        dbg.record_image('裁剪 / 缩放后工作图', resized_image, block=0)
        dbg.record_mask('裁剪 / 缩放后工作 mask', resized_mask, block=0)
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

                    dbg.record_block(i + 1, f'Block {i+1} · Interface',
                                     str(bp.get('interface_name') or f'idx={interface_idx}'),
                                     operation=exec_options.get('operation'),
                                     crop_reserve=exec_options.get('crop_reserve'),
                                     image_keys=exec_options.get('image_keys') or {},
                                     manual_values=manual_values)
                    dbg.record_image(f'Block {i+1} · Interface 输入图', block_input_img, block=i + 1)
                    dbg.record_mask(f'Block {i+1} · Interface 输入 mask', block_input_mask, block=i + 1)

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
                    dbg.record_image(f'Block {i+1} · Interface 输出图', result_img, block=i + 1)
                    dbg.record_mask(f'Block {i+1} · Interface 输出 mask', result_mask, block=i + 1)
                    continue

                if block.get('type') == 'query':
                    # Query 块：链条停在这里，前端弹 prompt UI 让用户现场挑；回答按 prompt 块
                    # 的语义合并注入（全局在前 + 本次选择在后 + programs 在合并结果上执行），
                    # 只影响其后的 detailer。取消/超时 = 中止整条链（用户明确要求）。
                    answer = self._await_query_answer(server, block, i)
                    user_positive, user_loras = self._resolve_prompt_selection(server, answer)
                    # Extra Prompt has the final append: a Query block replaces the prompt-tab
                    # content, but the extra typed in Blend right now must survive it.
                    if extra_prompt:
                        user_positive = f"{user_positive}, {extra_prompt}" if user_positive else extra_prompt
                    print(f"[PipelineBlock {i+1}/{len(blocks)}] Query block answered: "
                          f"positive='{user_positive[:200]}' ({len(user_positive)} chars), loras='{user_loras[:150]}'")
                    dbg.record_prompt(f'Block {i+1} · Query 块回答后', user_positive,
                                      block=i + 1, loras=list(user_loras or []))
                    continue

                if block.get('type') == 'prompt':
                    # Prompt 块：把「全局选择 + 块引用 preset 的 selection」合并后跑 preset
                    # 的 programs（后端 quickjs 引擎），替换此后的 user_positive / user_loras。
                    # 纯临时注入 —— 只影响排在该块之后的 detailer，不写回任何状态。
                    bp = block.get('params', block)
                    preset_id = bp.get('preset_id') if isinstance(bp, dict) else None
                    if not preset_id or server._find_prompt_preset(preset_id) is None:
                        print(f"[PipelineBlock {i+1}] Prompt block has no preset selected — skipped (prompt unchanged)")
                        continue
                    try:
                        user_positive, user_loras = self._resolve_prompt_block(server, bp)
                        # Extra Prompt has the final append: a prompt block replaces the prompt-tab
                        # content, but the extra typed in Blend right now must survive it.
                        if extra_prompt:
                            user_positive = f"{user_positive}, {extra_prompt}" if user_positive else extra_prompt
                        print(f"[PipelineBlock {i+1}/{len(blocks)}] Prompt block applied: "
                              f"positive='{user_positive[:200]}' ({len(user_positive)} chars), loras='{user_loras[:150]}'")
                        dbg.record_prompt(f'Block {i+1} · Prompt 块生效后', user_positive,
                                          block=i + 1, loras=list(user_loras or []))
                    except Exception as e:
                        # fail-open：程序执行失败保留之前的 prompt，不中断整条链
                        import traceback
                        traceback.print_exc()
                        print(f"[PipelineBlock {i+1}] WARNING: prompt block failed ({e}) — keeping previous prompt")
                        dbg.record_error(f'Block {i+1} · Prompt 块失败', str(e),
                                         block=i + 1, where='prompt_block')
                    continue

                # Detailer block params (support both nested 'params' dict and flat)
                bp = block.get('params', block)
                add_noise = bp.get('add_noise', 'enable')
                start_step_rate = float(bp.get('start_step_rate', 0.8))
                end_step_rate = float(bp.get('end_step_rate', 1.0))
                enable_edit = bp.get('enable_edit', False)
                # 块级 Generate Text 开关（默认关）：只有 pipeline config 的
                # enable_generate_text 也开着时才真正生效（二级门控）。
                enable_text_generate = bool(bp.get('enable_text_generate', False))
                # Override Prompt（默认关）：开着时本块 Generate Text 的指令用块里的
                # override_prompt 原样替代 pipeline 的 generate_text_prompt
                # （留空 = 空指令，positive 原样进 CLIP）。只在 enable_text_generate
                # 生效时有意义。
                enable_override_prompt = bool(bp.get('enable_override_prompt', False))
                override_prompt = str(bp.get('override_prompt', '') or '')
                edit_mode = bp.get('edit_mode', 'fit')  # Krea2 source-patch 模式: fit | crop
                ref_boost = float(bp.get('ref_boost', 4.0))
                ref_boost_a = float(bp.get('ref_boost_a', 1.0))
                enable_ref_boost_mask = bp.get('enable_ref_boost_mask', False)
                grounding_px = int(bp.get('grounding_px', 768))
                # Context Ref 没有开关：选了参考图就走该通道。
                # 'context_reference' 只是旧配置里的遗留字段，不再参与判定。
                # v2 多参考：context_reference_keys（list）是权威来源，顺序 = 注入顺序；
                # 旧配置的单 key 兜底并入列表尾（UI 会把它镜像成列表最后一项）。
                context_reference_keys = bp.get('context_reference_keys')
                if not isinstance(context_reference_keys, list):
                    context_reference_keys = []
                context_reference_keys = [k for k in context_reference_keys
                                          if isinstance(k, str) and k]
                context_reference_key = bp.get('context_reference_key')
                if context_reference_key and context_reference_key not in context_reference_keys:
                    context_reference_keys.append(context_reference_key)
                # 每个 detailer block 自带 context_regex（默认 ".+"），覆盖全局值，
                # 用于决定该 block 解出 pipeline.context 中的哪些 lora/prompt。
                block_context_regex = bp.get('context_regex', context_regex) or '.+'

                print(f"[PipelineBlock {i+1}/{len(blocks)}] Detailer: noise={add_noise}, steps={start_step_rate}-{end_step_rate}, edit={enable_edit}, textgen={enable_text_generate}, edit_mode={edit_mode}, ref_boost={ref_boost}/{ref_boost_a}, mask_boost={enable_ref_boost_mask}, grounding_px={grounding_px}, last={is_last}")
                dbg.record_block(i + 1, f'Block {i+1} · Detailer',
                                 f'{block.get("name", "")}',
                                 add_noise=add_noise,
                                 start_step_rate=start_step_rate,
                                 end_step_rate=end_step_rate,
                                 enable_edit=enable_edit,
                                 enable_text_generate=enable_text_generate,
                                 enable_override_prompt=enable_override_prompt,
                                 override_prompt_used=(override_prompt if (enable_text_generate and enable_override_prompt) else None),
                                 edit_mode=edit_mode,
                                 ref_boost=ref_boost,
                                 ref_boost_a=ref_boost_a,
                                 enable_ref_boost_mask=enable_ref_boost_mask,
                                 grounding_px=grounding_px,
                                 context_regex=block_context_regex,
                                 is_last=is_last)
                dbg.record_image(f'Block {i+1} · 输入工作图', resized_image, block=i + 1)
                dbg.record_mask(f'Block {i+1} · 输入工作 mask', resized_mask, block=i + 1)

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
                dbg.record_prompt(f'Block {i+1} · a) context 解出（regex={block_context_regex}）',
                                  context_positive, block=i + 1,
                                  loras=list(context_loras or []))
                dbg.record_prompt(f'Block {i+1} · b) context + user_positive 拼接', current_positive,
                                  block=i + 1,
                                  user_positive=user_positive)
                # Generate Text（MARKER_GENERATE_TEXT_BLOCK）：上游 Pipeline 若启用了
                # PipelineEnableGenerateTextNode，且本块 params 的 enable_text_generate
                # 开着（默认关），就把指令 prompt 与当前 positive 拼起来交给文本生成
                # CLIP，用生成结果完全替换 current_positive。参数与 clip 都来自上游
                # 节点。产物只作用于当前块（current_positive 每块都从 context 重新解出，
                # 不跨块传递）。pipeline 没开 enable_generate_text 时块开关无效。
                if next_pipeline.config.get('enable_generate_text') and enable_text_generate:
                    # Override Prompt 生效时用块级指令替代 pipeline 的 generate_text_prompt
                    # （空字符串就是空指令：positive 原样进 CLIP，不套指令拼接）。
                    _gt_instruction = (override_prompt if enable_override_prompt
                                       else next_pipeline.config.get('generate_text_prompt', ''))
                    _gt_before = current_positive
                    # Enable Edit 开 → 送图（多模态 CLIP 看图改写）：
                    #   第一张 = next_pipeline.image（链上传递的那张，pipeline 就是靠它
                    #            在 block 间传图的；interface 块会写回，detailer 不改它）
                    #   随后 = 本块选的所有 Ref Image（v2 多参考，按列表顺序能传几张传几张）
                    # Edit 关 → 完全不传图（不做隐藏行为）。
                    _gt_images = []
                    _gt_sources = []
                    _gt_ref_keys = []
                    _gt_img_status = 'n/a（未送图）'
                    if enable_edit:
                        _chain_img = next_pipeline.get_image()
                        if _chain_img is not None:
                            _gt_images.append(_chain_img)
                            _gt_sources.append('pipeline.image（链上工作图）')
                        for _ref_key in context_reference_keys:
                            _ref_img = self._resolve_ref_image_for_generate_text(server, _ref_key)
                            if _ref_img is not None:
                                _gt_images.append(_ref_img)
                                _gt_sources.append(f'Ref Image（{_ref_key}）')
                                _gt_ref_keys.append(_ref_key)
                        # 明确告诉 Debug：这些图**会不会真的影响**生成。
                        # 先按名字/模板做静态判断，再**实测一次 tokenize**（数 image
                        # embedding）—— 后者才是「图真的进了 token 流」的唯一证据。
                        if _gt_images:
                            _gt_clip = (next_pipeline.config.get('generate_text_clip')
                                        or next_pipeline.clip)
                            _gt_params = next_pipeline.config.get('generate_text') or {}
                            _gt_img_status = '未知'
                            try:
                                from ..libs.generate_text_utils import describe_image_support
                                _ok, _why = describe_image_support(
                                    _gt_clip,
                                    bool(_gt_params.get('use_default_template', True)))
                                _gt_img_status = ('会生效 — ' if _ok else '★ 不会生效 — ') + _why
                            except Exception as _e:
                                _gt_img_status = f'unknown ({_e})'
                            try:
                                _p_ok, _p_why = self._preflight_generate_text_images(
                                    _gt_images, _gt_clip,
                                    {**_gt_params,
                                     '_instruction': _gt_instruction})
                                if _p_why:
                                    _gt_img_status = _p_why
                                elif _p_ok is not None:
                                    _gt_img_status = ('已确认生效 — ' if _p_ok
                                                      else '★ 不会生效 — ') + _gt_img_status
                            except Exception as _e:
                                print(f'[GenerateText] preflight probe failed ({_e})')
                            print(f'[GenerateText] [block {i + 1}] image status: {_gt_img_status}')
                    dbg.record_prompt(f'Block {i+1} · c) Generate Text 输入（指令 + positive）',
                                      current_positive, block=i + 1,
                                      instruction=_gt_instruction,
                                      override_prompt=enable_override_prompt,
                                      params=next_pipeline.config.get('generate_text'),
                                      image_count=len(_gt_images),
                                      ref_image_keys=_gt_ref_keys,
                                      image_status=_gt_img_status)
                    # Debug：把每一张真正送进 Generate Text 的图单独画出来，标注来源
                    for _gi, _gimg in enumerate(_gt_images):
                        _gsrc = _gt_sources[_gi] if _gi < len(_gt_sources) else f'第 {_gi + 1} 张'
                        dbg.record_image(f'Block {i+1} · c{_gi + 1}) Generate Text 输入图 — {_gsrc}',
                                         _gimg, block=i + 1,
                                         detail=f'第 {_gi + 1} 张 / 共 {len(_gt_images)} 张')
                    try:
                        current_positive, _gt_used = apply_generate_text_to_prompt(
                            next_pipeline, current_positive,
                            _gt_instruction,
                            label=f' [block {i + 1}]',
                            images=_gt_images or None)
                        if _gt_used:
                            print(f'[PipelineBlock {i + 1}/{len(blocks)}] Generate Text applied: '
                                  f"positive='{current_positive[:200]}' ({len(current_positive)} chars)")
                        dbg.record_prompt(f'Block {i+1} · d) Generate Text 输出（new_positive）',
                                          current_positive, block=i + 1,
                                          applied=bool(_gt_used),
                                          images_sent=len(_gt_images),
                                          before=_gt_before)
                    except Exception as e:
                        # fail-open：生成失败保留原 prompt，不中断整条链
                        import traceback
                        traceback.print_exc()
                        print(f'[PipelineBlock {i + 1}] WARNING: Generate Text failed ({e}) — keeping previous prompt')
                        dbg.record_error(f'Block {i+1} · Generate Text 失败', str(e),
                                         block=i + 1, where='generate_text')
                # Cancel 检查点：Generate Text 的 LLM 调用是同步长任务，块首的检查点
                # 够不着它内部——这里在生成结束/conditioning 之前再吃一次 interrupt，
                # 让「在 text generate 里点 Cancel」的请求在当前块内就生效。
                mm.throw_exception_if_processing_interrupted()
                current_positive_before_query = current_positive
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

                dbg.record_prompt(f'Block {i+1} · e) 最终 positive（送入 conditioning）',
                                  current_positive, block=i + 1,
                                  negative=current_negative,
                                  loras=list(current_loras),
                                  query_positive=tmp_positive or '',
                                  query_negative=tmp_negative or '',
                                  before_query=current_positive_before_query)

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

                # Context Reference injection (per-block) — v2 多参考：逐张编码并 append，
                # 顺序 = context_reference_keys（旧单 key 已并入列表尾）。
                if enable_edit and context_reference_keys and server is not None:
                    for _ref_key in context_reference_keys:
                        ref_img = server.get_history_image(_ref_key)
                        if ref_img is not None:
                            ref_latent = VAEEncode().encode(vae=next_pipeline.vae, pixels=ref_img)[0]
                            next_pipeline.reference.reference_latents.append(ref_latent)
                            print(f"[Block {i+1}] Context reference injected: key={_ref_key}")
                        else:
                            print(f"[Block {i+1}] WARNING: context reference key '{_ref_key}' not found")

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
                    if resize_info is not None:
                        recovered_decoded, _ = recover_size(
                            image=decoded_image,
                            resize_info=resize_info,
                            mask=resized_mask
                        )
                        current_image = recovered_decoded
                    else:
                        # Enable Limit 关：从没缩放过，工作区尺寸恒定，无需复原。
                        current_image = decoded_image
                    current_mask = cropped_mask
                else:
                    current_image = decoded_image
                    current_mask = resized_mask

                last_resize_info = resize_info
                last_resized_mask = resized_mask

                print(f"[Block {i+1}] Done: decoded shape={decoded_image.shape}")
                # _ksampler 返回的是 LATENT dict（{'samples': tensor}），不是 tensor ——
                # 这里统一取形状，避免直接 .shape 炸掉（曾栽过一次）。
                def _latent_shape(lat):
                    try:
                        if isinstance(lat, dict):
                            lat = lat.get('samples')
                        return list(lat.shape) if hasattr(lat, 'shape') else None
                    except Exception:
                        return None
                dbg.record_image(f'Block {i+1} · 采样解码输出', decoded_image, block=i + 1,
                                 detail=f'latent={_latent_shape(sampled_latent)}')
                dbg.record_stage(f'Block {i+1} · 输出 / 传递给下一块',
                                 f'current_image={tuple(current_image.shape)}',
                                 block=i + 1,
                                 is_last=is_last,
                                 decoded_shape=list(decoded_image.shape),
                                 latent_shape=_latent_shape(sampled_latent),
                                 has_resize_info=resize_info is not None)
                if not is_last:
                    dbg.record_image(f'Block {i+1} · 复原到裁剪分辨率（传给下一块）', current_image,
                                     block=i + 1)
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
        if not enable_mask:
            # Enable Mask 关：整幅工作区即产出，没有裁剪矩形可复原。
            final_image, final_mask = current_image, current_mask
        elif do_recover_crop:
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
        dbg.record_stage('收尾 / 恢复',
                         ('Enable Mask 关 → 整幅就是产出' if not enable_mask
                          else ('Recover Crop 开 → recover_size + recover_crop' if do_recover_crop
                                else 'Recover Crop 关 → 保持工作分辨率，产出为 RGBA patch')),
                         block=0,
                         enable_mask=enable_mask,
                         do_recover_crop=do_recover_crop)
        dbg.record_image('链条最终产出（recover 之后）', final_image, block=0)

        # Context 就是 Blend 画布合成图，detailer 产出不再接管；关掉 Recover Crop 时产出
        # 只是画布上的一块 patch，更不能顶替整幅 context，故保持原合成图。
        next_pipeline.image = final_image if (enable_mask and do_recover_crop) else original_image
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
            # Generate Text（MARKER_GENERATE_TEXT_INTERFACE）：独立 interface tab 时，
            # 上游 pipeline 若启用了 PipelineEnableGenerateTextNode，同样在 prompt
            # 注入点替换 positive（与 Draw tab block 链的语义保持一致）。
            if injected_pipeline and injected_pipeline.config.get('enable_generate_text'):
                try:
                    # interface 块没有 Enable Edit / Ref Image 概念 → 始终纯文本
                    # （image 省略即 None），与 block 链里未选 Ref Image 时一致。
                    user_positive, _gt_used = apply_generate_text_to_prompt(
                        injected_pipeline, user_positive,
                        injected_pipeline.config.get('generate_text_prompt', ''),
                        label=' [interface]')
                    if _gt_used:
                        print(f"[interface] Generate Text applied: positive='{user_positive[:200]}'")
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    print(f'[interface] WARNING: Generate Text failed ({e}) — keeping previous prompt')
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
                    # Debug：每一次 Run / Generate 开一份新 trace（丢弃上一份）。
                    # Context 标题右侧的 Debug 按钮读的就是它。
                    dbg.begin_trace({
                        'from_blend': bool(action.get('from_blend')),
                        'action': 'run_detailer',
                    })
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
                        # 可观测性：Generate / Run Detailer 实际注入的 prompt tab 内容。
                        # 曾因 prefab 不展开而静默为空（见 _expand_prefabs 注释），这行让
                        # 「没注入」在日志里一眼可见。
                        print(f"[run_detailer] prompt tab: positive='{user_positive[:200]}' ({len(user_positive)} chars), loras={user_loras}")
                        dbg.record_prompt('1. Prompt tab（_parse_prompt 解析结果）', user_positive,
                                          loras=list(user_loras or []))

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
                        if extra_prompt:
                            print(f"[run_detailer] extra prompt appended: '{extra_prompt}'")
                            dbg.record_prompt('2. Extra Prompt 追加后', user_positive,
                                              extra_prompt=extra_prompt,
                                              loras=list(user_loras or []))

                        # 遮罩必须存在，否则 detailer 无意义 —— 例外：Enable Mask 总闸关
                        # （生效链第一个 detailer 的 params.enable_mask）时整幅都是工作区，
                        # Mask 层没画也允许跑。这里只是读 pending preset 不清空（取用即清
                        # 仍在下方 blocks 解析处），两条路的选链优先级保持一致。
                        if current_mask is None or (hasattr(current_mask, 'sum') and current_mask.sum().item() == 0):
                            if server._first_detailer_enable_mask(server.pending_generate_preset):
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
                        dbg.record_stage('3. Run 上下文',
                                         f'image={diag_img_w}x{diag_img_h}, mask={diag_mask_shape}',
                                         from_blend=bool(action.get('from_blend')),
                                         image_size=f'{diag_img_w}x{diag_img_h}',
                                         mask_shape=diag_mask_shape,
                                         mask_sum=round(float(diag_mask_sum), 1),
                                         mask_max=round(float(diag_mask_max), 3),
                                         model=type(run_pipeline.model).__name__ if run_pipeline.model is not None else None,
                                         architecture=(run_pipeline.config.get('architecture')
                                                       if run_pipeline.config else None))
                        dbg.record_image('输入图（Blend 画布合成图 / Context）', diag_img)
                        dbg.record_mask('输入 Mask（Mask 层）', current_mask,
                                        detail=f'sum={diag_mask_sum:.0f}')

                        # Build global_params and blocks for pipeline execution
                        # 逐 run 的 preset 选择：取用即清空，下一次普通 Run 一定回落到当前
                        # 激活 tab 的链（否则上一轮 Generate 选的 preset 会偷偷留下来）。
                        preset_id = server.pending_generate_preset
                        server.pending_generate_preset = None
                        preset_set = next(
                            (s for s in (server.blocks_sets or [])
                             if s.get('id') == preset_id and s.get('blocks')),
                            None,
                        ) if preset_id else None
                        if preset_set is not None:
                            print(f"[run_detailer] using pipeline preset '{preset_set.get('name')}' ({len(preset_set['blocks'])} blocks)")
                        global_params = {
                            'seed': seed,
                            'mask_grow': server.mask_grow,
                            'mask_blur': server.mask_blur,
                            # GLOBAL SETTINGS：所有 preset 共享同一份（server config）
                            'crop_reserve': server.crop_reserve,
                            'pixels': server.pixels,
                            'align': server.align,
                            'context_regex': context_regex,
                        }
                        blocks = preset_set['blocks'] if preset_set is not None else server.blocks
                        dbg.record_stage(
                            '4. Pipeline 链',
                            f"{len(blocks)} 个 block"
                            + (f"（preset「{preset_set.get('name')}」）" if preset_set is not None else '（当前激活 tab）'),
                            blocks=[{'index': i + 1, 'type': b.get('type'),
                                     'name': b.get('name')} for i, b in enumerate(blocks)],
                            global_params=dict(global_params),
                        )

                        next_pipeline, original_image, detailed_image, detail_meta = self._run_pipeline_blocks(
                            run_pipeline, current_mask, user_positive, user_loras, global_params, blocks, server=server,
                            extra_prompt=extra_prompt
                        )

                        server.original_image = original_image
                        server.detailed_image = detailed_image
                        dbg.record_image('最终产出（detailed image）', detailed_image,
                                         detail=f'detail_meta={"有 place 矩形" if detail_meta else "无"}')
                        if detail_meta:
                            dbg.record_stage('最终产出元数据', 'Recover Crop 关闭 — 产出是待贴回的 RGBA patch',
                                             place=detail_meta.get('place'))
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

                    except mm.InterruptProcessingException:
                        # Cancel 按钮（/api/cancel_run）触发的打断。InterruptProcessingException
                        # 继承 BaseException，下面的 except Exception 接不住——不接的话它会
                        # 炸穿整个节点（server 一起被停掉）。这里转成干净的「已取消」。
                        print("[SnapshotDetailerSampler] Run cancelled by user")
                        server.detail_status = 'cancelled'
                        server.detail_error = None
                        dbg.record_stage('Run 已取消', 'cancelled by user (interrupt)')
                    except Exception as e:
                        # Check if this is a ComfyUI interrupt
                        if mm.processing_interrupted() or "interrupt" in str(e).lower() or "processing" in str(e).lower():
                            print("[SnapshotDetailerSampler] Interrupted during detailer")
                            break
                        import traceback
                        traceback.print_exc()
                        server.detail_status = 'error'
                        server.detail_error = str(e)
                        dbg.record_error('run_detailer 异常', str(e), where='run_detailer')
                    finally:
                        comfy.utils.set_progress_bar_global_hook(orig_hook)
                        server.detail_progress = 1.0 if server.detail_status == 'done' else server.detail_progress
                        dbg.record_stage('Run 结束', f"status={server.detail_status}"
                                         + (f", error={server.detail_error}" if server.detail_error else ''))
                        _tr = dbg.current_trace()
                        if _tr is not None:
                            _tr.meta['status'] = server.detail_status
                            _tr.meta['error'] = server.detail_error
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
                    except mm.InterruptProcessingException:
                        # Cancel 打断（同 run_detailer 的处理）：转成干净的取消，
                        # 不让异常炸穿节点。回 idle 让 Execute 按钮恢复可点。
                        print("[SnapshotDetailerSampler] Interface run cancelled by user")
                        server.interface_status = 'idle'
                        server.interface_error = None
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
