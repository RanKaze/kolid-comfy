import os
import hashlib
import base64
import io

import folder_paths
import torch
from PIL import Image
import numpy as np

from ..libs.utils import AlwaysEqualProxy

any_type = AlwaysEqualProxy("*")


# ====================== 基础节点 ======================

class FileCheckNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "file_path": ("STRING", {"default": "", "multiline": False}),
            }
        }

    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("exists",)
    FUNCTION = "check_file"
    CATEGORY = "Kolid-Toolkit"

    def check_file(self, file_path=""):
        return (os.path.exists(file_path),)

    @classmethod
    def IS_CHANGED(cls, file_path):
        if not file_path or not os.path.exists(file_path):
            return float("nan")
        try:
            return os.path.getmtime(file_path)
        except:
            return float("nan")


class LoadTextNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "file_path": ("STRING", {"default": "", "multiline": False}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "load_file"
    CATEGORY = "Kolid-Toolkit"

    def load_file(self, file_path=""):
        if not file_path:
            return ("",)

        if not os.path.exists(file_path):
            return ("",)

        try:
            with open(file_path, "r", encoding="utf-8", newline="\n") as f:
                text = f.read()

            # 过滤掉以 # 开头的注释行
            lines = []
            for line in io.StringIO(text):
                stripped = line.strip()
                if stripped and not stripped.startswith("#"):
                    lines.append(stripped.replace("\r", ""))

            return ("\n".join(lines),)

        except Exception:
            return ("",)

    @classmethod
    def IS_CHANGED(cls, file_path):
        if not file_path or not os.path.exists(file_path):
            return float("nan")
        try:
            m = hashlib.sha256()
            with open(file_path, "rb") as f:
                m.update(f.read())
            return m.hexdigest()
        except:
            return float("nan")


class SaveTextNode:
    def __init__(self):
        self.output_dir = folder_paths.output_directory

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "data": ("STRING", {"default": "", "forceInput": True, "multiline": True}),
                "output_path": ("STRING", {"default": "", "multiline": False}),  # 必须是完整文件路径（如 output/result.txt）
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("saved_text",)
    FUNCTION = "save_text"
    CATEGORY = "Kolid-Toolkit"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, data, output_path):
        m = hashlib.sha256()
        m.update(data.encode("utf-8"))
        m.update(str(output_path).encode("utf-8"))
        return m.hexdigest()

    def save_text(self, data, output_path):
        if not output_path or output_path.strip() == "":
            return (data,)

        # 如果是相对路径，则相对于 ComfyUI/output
        if not os.path.isabs(output_path):
            output_path = os.path.join(self.output_dir, output_path)

        # 确保目录存在
        directory = os.path.dirname(output_path)
        if directory:
            os.makedirs(directory, exist_ok=True)

        try:
            # 统一按普通文本文件处理（不再区分 csv）
            with open(output_path, "w", encoding="utf-8", newline="\n") as f:
                f.write(data)
        except Exception:
            pass  # 静默失败

        return (data,)


# ====================== Image <-> Base64 节点 ======================

class ImageToBase64Node:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "include_prefix": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("base64_string",)
    FUNCTION = "convert"
    CATEGORY = "Kolid-Toolkit/Image"

    def convert(self, image, include_prefix=True):
        if image is None or len(image) == 0:
            return ("",)

        try:
            # 支持 batch，取第一张
            img_tensor = image[0] if len(image.shape) == 4 else image
            i = 255. * img_tensor.cpu().numpy()
            pil_img = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))

            buffer = io.BytesIO()
            pil_img.save(buffer, format="PNG", optimize=True)
            img_bytes = buffer.getvalue()
            b64 = base64.b64encode(img_bytes).decode("utf-8")

            if include_prefix:
                b64 = f"data:image/png;base64,{b64}"

            return (b64,)
        except Exception:
            return ("",)


class Base64ToImageNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "base64_string": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "convert"
    CATEGORY = "Kolid-Toolkit/Image"

    def convert(self, base64_string):
        if not base64_string or base64_string.strip() == "":
            return (torch.zeros((1, 64, 64, 3), dtype=torch.float32),)

        try:
            # 移除可能的 data: URL 前缀
            if "," in base64_string and base64_string.startswith("data:"):
                base64_string = base64_string.split(",", 1)[1]

            img_bytes = base64.b64decode(base64_string.strip())
            pil_img = Image.open(io.BytesIO(img_bytes)).convert("RGB")

            img_np = np.array(pil_img).astype(np.float32) / 255.0
            img_tensor = torch.from_numpy(img_np)[None, ...]

            return (img_tensor,)
        except Exception:
            return (torch.zeros((1, 64, 64, 3), dtype=torch.float32),)