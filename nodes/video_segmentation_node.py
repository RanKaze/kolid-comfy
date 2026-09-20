# -*- coding: utf-8 -*-
"""
VideoSegmentationNode - 逐帧文本掩码表达式分割节点（基于 SAM3）

参考 ComfyUI-SAM3 的 SAM3Grounding / SAM3VideoSegmentation 设计：
每帧独立进行文本 grounding 检测（非跟踪传播），因此每个术语的
置信度阈值在每一帧上都生效。

text_prompt 掩码表达式格式（如 "(skin:0.2)&(head:0.3)-eye(0.1)+(nose:0.1)"）：
  - 术语:  name / name:0.3 / name(0.3) / (name:0.3)，支持多词概念（如 "red car:0.4"）
  - 运算符（从左到右计算，无优先级，可用括号分组）:
      &  交集
      +  并集（| 为别名）
      -  差集
  - 同一术语在一帧内检测到多个实例时，取所有实例掩码的并集

模型依赖 ComfyUI-SAM3（LoadSAM3Model 节点输出的 SAM3_MODEL_CONFIG），
通过 sys.modules 共享其模型缓存，不会重复加载模型。
"""
import gc
import hashlib
import importlib
import logging
import os
import sys

import numpy as np
import torch
from PIL import Image

log = logging.getLogger("kolid-comfy")


# =============================================================================
# 掩码表达式解析
# =============================================================================

_SPECIAL_CHARS = "()&+|-|:"


class _Term:
    """叶子节点：术语（名称 + 置信度阈值）"""
    __slots__ = ("name", "threshold")

    def __init__(self, name, threshold):
        self.name = name
        self.threshold = threshold


class _Group:
    """括号分组节点"""
    __slots__ = ("inner",)

    def __init__(self, inner):
        self.inner = inner


class _BinOp:
    """二元运算节点：& / + / | / -"""
    __slots__ = ("op", "left", "right")

    def __init__(self, op, left, right):
        self.op = op
        self.left = left
        self.right = right


def _tokenize(text):
    """切分为 ('special', 字符) 与 ('atom', 原文) 两类 token。

    atom 允许包含空格（多词概念），边界仅由特殊字符决定。
    """
    tokens = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in _SPECIAL_CHARS:
            tokens.append(("special", c))
            i += 1
        else:
            j = i
            while j < n and text[j] not in _SPECIAL_CHARS:
                j += 1
            raw = text[i:j]
            # 丢弃纯空白片段（运算符周围、行首尾的空白），
            # 保留 atom 内部的空白（多词概念）
            if raw.strip():
                tokens.append(("atom", raw))
            i = j
    return tokens


def _parse_threshold(raw):
    s = raw.strip()
    try:
        t = float(s)
    except (TypeError, ValueError):
        raise ValueError(
            f"掩码表达式中的阈值 '{s}' 无效，应为 [0, 1] 内的数字。"
        )
    if not (0.0 <= t <= 1.0):
        raise ValueError(f"阈值必须在 [0, 1] 内，当前为 {t}。")
    return t


class _Parser:
    """递归下降解析器：expr := primary (OP primary)*"""

    def __init__(self, tokens, default_threshold):
        self.tokens = tokens
        self.pos = 0
        self.default_threshold = default_threshold

    def _peek(self, k=0):
        idx = self.pos + k
        if idx < len(self.tokens):
            return self.tokens[idx]
        return (None, None)

    def _next(self):
        tok = self._peek()
        self.pos += 1
        return tok

    def parse(self):
        if not self.tokens:
            raise ValueError("掩码表达式为空。")
        node = self._parse_expr()
        if self.pos != len(self.tokens):
            kind, val = self._peek()
            raise ValueError(f"掩码表达式在第 {self.pos} 个 token '{val}' 处存在多余内容。")
        return node

    def _parse_expr(self):
        node = self._parse_primary()
        while True:
            kind, val = self._peek()
            if kind == "special" and val in ("&", "+", "-", "|"):
                self._next()
                right = self._parse_primary()
                node = _BinOp(val, node, right)
            else:
                return node

    def _parse_primary(self):
        kind, val = self._peek()
        if kind is None:
            raise ValueError("掩码表达式意外结束。")

        if kind == "special":
            if val == "(":
                self._next()
                node = self._parse_expr()
                kind, val = self._peek()
                if not (kind == "special" and val == ")"):
                    raise ValueError("掩码表达式中缺少 ')'。")
                self._next()
                return _Group(node)
            raise ValueError(f"掩码表达式中出现意外的 '{val}'，此处应为术语名或 '('。")

        # atom：术语名（可带阈值）
        self._next()
        name = val.strip()
        if not name:
            raise ValueError("掩码表达式中的术语名为空。")
        threshold = self.default_threshold

        kind2, val2 = self._peek()
        if kind2 == "special" and val2 == ":":
            # name:0.3 形式
            self._next()
            kind3, val3 = self._peek()
            if kind3 != "atom":
                raise ValueError(f"术语 '{name}' 之后的 ':' 后缺少阈值数值。")
            self._next()
            threshold = _parse_threshold(val3)
        elif kind2 == "special" and val2 == "(":
            # name(0.3) 后缀阈值形式：需要向前看两步（数字 + ')'）
            kind3, val3 = self._peek(1)
            kind4, val4 = self._peek(2)
            if kind3 == "atom" and kind4 == "special" and val4 == ")":
                self._next()
                self._next()
                self._next()
                threshold = _parse_threshold(val3)

        return _Term(name, threshold)


def parse_mask_expression(text, default_threshold=0.2):
    """将掩码表达式字符串解析为 AST。

    示例："(skin:0.2)&(head:0.3)-eye(0.1)+(nose:0.1)"
    """
    if text is None:
        raise ValueError("掩码表达式为 None。")
    return _Parser(_tokenize(text), default_threshold).parse()


def collect_terms(node, out=None):
    """收集 AST 中去重后的 (name, threshold) 术语列表（保持顺序）。"""
    if out is None:
        out = []
    if isinstance(node, _Term):
        key = (node.name, node.threshold)
        if key not in out:
            out.append(key)
    elif isinstance(node, _Group):
        collect_terms(node.inner, out)
    elif isinstance(node, _BinOp):
        collect_terms(node.left, out)
        collect_terms(node.right, out)
    else:
        raise TypeError(f"未知的 AST 节点类型: {type(node)}")
    return out


def eval_expression(node, term_masks):
    """基于每术语的 [H, W] float 掩码（0/1）对 AST 求值。

    运算符：& 交集、+ / | 并集、- 差集。
    """
    if isinstance(node, _Term):
        key = (node.name, node.threshold)
        if key not in term_masks:
            raise KeyError(f"术语 '{node.name}:{node.threshold}' 未检测。")
        return term_masks[key]
    if isinstance(node, _Group):
        return eval_expression(node.inner, term_masks)
    if isinstance(node, _BinOp):
        left = eval_expression(node.left, term_masks)
        right = eval_expression(node.right, term_masks)
        if node.op == "&":
            return left * right
        if node.op in ("+", "|"):
            return torch.clamp(left + right, max=1.0)
        if node.op == "-":
            return left * (1.0 - right)
        raise ValueError(f"未知运算符 '{node.op}'。")
    raise TypeError(f"未知的 AST 节点类型: {type(node)}")


# =============================================================================
# SAM3 模型获取（跨包复用 ComfyUI-SAM3 的模块级模型缓存）
# =============================================================================

def _get_sam3_model_cache():
    """获取 ComfyUI-SAM3 的 nodes._model_cache 模块。

    与 SAM3 官方节点共享同一个已加载模块，从而共享模块级模型缓存，
    避免重复构建/加载模型。优先从 sys.modules 查找 ComfyUI 已加载的
    顶层包（ComfyUI 以目录路径作为模块名注册），找不到时再把
    custom_nodes 目录注入 sys.path 后导入。
    """
    # 1) ComfyUI 已加载的 ComfyUI-SAM3 顶层模块
    top = None
    for key, mod in list(sys.modules.items()):
        if key.endswith("ComfyUI-SAM3") and hasattr(mod, "nodes"):
            top = mod
            break

    nodes_pkg = None
    if top is not None:
        nodes_pkg = top.nodes
    else:
        # 2) 兜底：注入 custom_nodes 目录后直接导入
        try:
            import folder_paths
            cn_dir = folder_paths.folder_names_and_paths["custom_nodes"][0][0]
        except Exception:
            cn_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        if cn_dir not in sys.path:
            sys.path.insert(0, cn_dir)
        try:
            nodes_pkg = importlib.import_module("ComfyUI-SAM3.nodes")
        except ImportError:
            raise ImportError(
                "未找到 ComfyUI-SAM3 包。请在 custom_nodes 下安装 ComfyUI-SAM3 "
                "后再使用 VideoSegmentationNode。"
            )

    # _model_cache 由 SAM3 节点首次执行时延迟导入，可能尚未成为包属性
    mc = getattr(nodes_pkg, "_model_cache", None)
    if mc is None:
        try:
            mc = importlib.import_module(f"{nodes_pkg.__name__}._model_cache")
        except ImportError:
            raise ImportError("导入 ComfyUI-SAM3 的 nodes._model_cache 模块失败。")
    return mc


# =============================================================================
# 帧迭代器
# =============================================================================

def _tensor_frames_iter(video_frames):
    """将 [N, H, W, C] 图像张量逐帧转为 PIL。返回 (生成器, 帧数)。"""
    n = int(video_frames.shape[0])

    def gen():
        for i in range(n):
            frame = video_frames[i].cpu().numpy()
            frame = (np.clip(frame, 0.0, 1.0) * 255.0).astype(np.uint8)
            yield Image.fromarray(frame)

    return gen(), n


def _video_frames_iter(video):
    """将 ComfyUI VIDEO 对象（文件源）逐帧读取为 PIL。返回 (生成器, 总帧数)。"""
    import cv2

    source = video.get_stream_source()
    if not isinstance(source, str):
        # 非 file-backed 源（如 BytesIO）：物化帧后走张量路径
        components = video.get_components()
        return _tensor_frames_iter(components.images)

    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        raise ValueError(f"无法打开视频: {source}")

    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # VideoFromFile 对象可能引用从 start_time 开始的子片段
    start_time = getattr(video, "_VideoFromFile__start_time", 0.0) or 0.0
    if start_time > 0:
        cap.set(cv2.CAP_PROP_POS_MSEC, start_time * 1000.0)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total = max(0, int(total - start_time * fps))

    def gen():
        try:
            while True:
                ret, frame = cap.read()
                if not ret:
                    break
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                yield Image.fromarray(rgb)
        finally:
            cap.release()

    return gen(), max(total, 0)


# =============================================================================
# 节点
# =============================================================================

class VideoSegmentationNode:
    """逐帧 SAM3 掩码表达式分割节点。

    text_prompt 格式: "(skin:0.2)&(head:0.3)-eye(0.1)+(nose:0.1)"

    每帧独立 grounding 检测（无跟踪传播），每术语的阈值逐帧生效。
    运算符从左到右计算：& 交集、+ 并集、- 差集，可用括号分组。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "sam3_model_config": ("SAM3_MODEL_CONFIG", {
                    "tooltip": "SAM3 model config from LoadSAM3Model node (ComfyUI-SAM3)",
                }),
                "text_prompt": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Mask expression, e.g. '(skin:0.2)&(head:0.3)-eye(0.1)+(nose:0.1)'. "
                               "Operators (left-to-right): & intersect, + union, - subtract, | union. "
                               "Term syntax: name, name:0.3, name(0.3), (name:0.3).",
                }),
            },
            "optional": {
                "video_frames": ("IMAGE", {
                    "tooltip": "Video frames as batch [N, H, W, C]. Used when 'video' is not connected.",
                }),
                "video": ("VIDEO", {
                    "tooltip": "Video object (e.g. from UrlVideoNode / VideoFolderLoaderNode). "
                               "Takes priority over video_frames if both connected.",
                }),
                "default_threshold": ("FLOAT", {
                    "default": 0.2, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "Confidence threshold used by terms without an explicit threshold.",
                }),
            },
        }

    RETURN_TYPES = ("MASK", "IMAGE", "IMAGE")
    RETURN_NAMES = ("masks", "frames", "visualization")
    FUNCTION = "execute"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(cls, sam3_model_config, text_prompt, video_frames=None, video=None,
                   default_threshold=0.2):
        # 内容指纹：避免同输入重复推理
        h = hashlib.md5()
        if video is not None:
            try:
                source = video.get_stream_source()
                if isinstance(source, str):
                    h.update(source.encode())
                    try:
                        h.update(str(os.path.getmtime(source)).encode())
                        h.update(str(os.path.getsize(source)).encode())
                    except OSError:
                        h.update(b"file_error")
                else:
                    h.update(str(video.get_frame_count()).encode())
                    h.update(str(video.get_dimensions()).encode())
            except Exception:
                h.update(str(id(video)).encode())
        elif video_frames is not None:
            h.update(str(video_frames.shape).encode())
            first = video_frames[0].cpu().numpy()
            last = video_frames[-1].cpu().numpy()
            h.update(first[0, 0, :].tobytes())
            h.update(first[-1, -1, :].tobytes())
            h.update(last[0, 0, :].tobytes())
            h.update(last[-1, -1, :].tobytes())
        else:
            h.update(b"no_input")
        return f"{h.hexdigest()}_{text_prompt}_{default_threshold}_{sam3_model_config}"

    def execute(self, sam3_model_config, text_prompt, video_frames=None, video=None,
                default_threshold=0.2):
        """每帧对每个术语独立 grounding 检测，再按表达式合成掩码。"""
        import comfy.model_management
        import comfy.utils

        if video is None and video_frames is None:
            raise ValueError("请连接 'video' 或 'video_frames' 输入之一。")
        if not text_prompt or not text_prompt.strip():
            raise ValueError(
                "text_prompt 为空。请输入掩码表达式，例如 "
                "'(skin:0.2)&(head:0.3)-eye(0.1)+(nose:0.1)'。"
            )

        # 解析表达式，收集去重术语（每帧每术语只推理一次）
        try:
            root = parse_mask_expression(text_prompt, default_threshold)
        except ValueError as e:
            raise ValueError(f"text_prompt 无效: {e}")
        unique_terms = collect_terms(root, [])
        print(f"[VideoSegmentation] expression: '{text_prompt}'")
        print(f"[VideoSegmentation] terms (name, threshold): {unique_terms}")

        # 加载模型（与 ComfyUI-SAM3 官方节点共享模块级缓存）
        model_cache = _get_sam3_model_cache()
        sam3_model = model_cache.get_or_build_model(sam3_model_config)
        comfy.model_management.load_models_gpu([sam3_model])

        processor = sam3_model.processor
        device = sam3_model.current_device
        if hasattr(processor, "sync_device_with_model"):
            processor.sync_device_with_model()
        elif hasattr(processor, "device") and str(processor.device) != str(device):
            processor.device = str(device)

        # 帧来源（video 优先）
        if video is not None:
            frames_iter, total = _video_frames_iter(video)
        else:
            frames_iter, total = _tensor_frames_iter(video_frames)

        if total <= 0:
            raise ValueError("没有可处理的帧。")

        # 预分配 CPU 输出（逐帧填充；实际帧数与容器头不符时最后裁剪）
        first_pil = next(frames_iter)
        w, h = first_pil.size
        masks_out = torch.zeros(total, h, w)
        frames_out = torch.zeros(total, h, w, 3)
        vis_out = torch.zeros(total, h, w, 3)

        pbar = comfy.utils.ProgressBar(total)
        frame_idx = 0
        for pil_image in [first_pil] + list(frames_iter):
            comfy.model_management.throw_exception_if_processing_interrupted()

            # 提取本帧图像特征（每帧一次）
            state = processor.set_image(pil_image)

            # 对每个术语独立 grounding 检测
            term_masks = {}
            for name, threshold in unique_terms:
                # 直接赋值阈值属性：set_confidence_threshold() 在 state 已含
                # boxes 时会用旧文本重跑一次 grounding 推理（每术语多一次浪费），
                # 属性赋值无副作用，set_text_prompt 内部推理时读取该属性。
                processor.confidence_threshold = threshold
                state = processor.set_text_prompt(name, state)
                det_masks = state.get("masks")
                if det_masks is None or det_masks.numel() == 0 or det_masks.shape[0] == 0:
                    term_mask = torch.zeros(h, w)
                else:
                    if det_masks.ndim == 4 and det_masks.shape[1] == 1:
                        det_masks = det_masks.squeeze(1)
                    # 该术语所有实例的并集
                    term_mask = det_masks.any(dim=0).float().cpu()
                term_masks[(name, threshold)] = term_mask

            # 按表达式合成最终掩码（从左到右布尔运算）
            final_mask = eval_expression(root, term_masks)

            frame_np = np.asarray(pil_image, dtype=np.float32) / 255.0
            masks_out[frame_idx] = final_mask
            frames_out[frame_idx] = torch.from_numpy(frame_np)
            vis_out[frame_idx] = self._visualize(frame_np, final_mask)

            del state, term_masks
            frame_idx += 1
            pbar.update(1)

            if frame_idx % 10 == 0:
                print(f"[VideoSegmentation] processed {frame_idx}/{total} frames")
                gc.collect()

        # 实际帧数与容器头不一致时裁剪
        if frame_idx != total:
            print(f"[VideoSegmentation] 容器报告 {total} 帧，实际解码 {frame_idx} 帧")
            masks_out = masks_out[:frame_idx]
            frames_out = frames_out[:frame_idx]
            vis_out = vis_out[:frame_idx]

        print(f"[VideoSegmentation] done: {frame_idx} frames, size {w}x{h}")

        gc.collect()
        comfy.model_management.soft_empty_cache()

        return (masks_out, frames_out, vis_out)

    @staticmethod
    def _visualize(frame_np, mask, alpha=0.5):
        """将 [H, W] 0/1 掩码以青色半透明叠加到 [H, W, 3] 帧上。"""
        frame_t = torch.from_numpy(frame_np)
        m3 = mask.unsqueeze(-1)
        color = torch.tensor([0.0, 1.0, 1.0])
        return frame_t * (1.0 - alpha * m3) + color * (alpha * m3)


NODE_CLASS_MAPPINGS = {
    "VideoSegmentationNode": VideoSegmentationNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoSegmentationNode": "Video Segmentation (SAM3 Mask Expression)",
}
