from comfy import model_management
import math
import numpy as np
import numpy
import torch
import torch.nn.functional as F
import scipy
from .image_utils import tensor2pil, pil2tensor
from scipy import ndimage
from PIL import Image, ImageFilter, ImageChops, ImageDraw, ImageOps, ImageEnhance, ImageFont

def make_2d_mask(mask):
    if len(mask.shape) == 4:
        return mask.squeeze(0).squeeze(0)

    elif len(mask.shape) == 3:
        return mask.squeeze(0)

    return mask

def erosion_mask(mask, grow_mask_by):
    mask = make_2d_mask(mask)

    w = mask.shape[1]
    h = mask.shape[0]

    device = comfy.model_management.get_torch_device()
    mask = mask.clone().to(device)
    mask2 = torch.nn.functional.interpolate(mask.reshape((-1, 1, mask.shape[-2], mask.shape[-1])), size=(w, h), mode="bilinear").to(device)
    if grow_mask_by == 0:
        mask_erosion = mask2
    else:
        kernel_tensor = torch.ones((1, 1, grow_mask_by, grow_mask_by)).to(device)
        padding = math.ceil((grow_mask_by - 1) / 2)

        mask_erosion = torch.clamp(torch.nn.functional.conv2d(mask2.round(), kernel_tensor, padding=padding), 0, 1)

    return mask_erosion[:, :, :w, :h].round().cpu()

def expand_mask(mask: torch.Tensor, grow: int, blur: int) -> torch.Tensor:
    """
    【高效GPU版】完全符合你的需求：
    - grow：按像素精确膨胀/腐蚀（使用 max_pool2d 实现）
    - blur：按像素到边界的距离线性渐变 → 值 = min(距离 / blur, 1.0)
    - 背景永远保持干净的 0
    - 完全纯 PyTorch 实现，支持 GPU，速度远超 scipy.distance_transform_edt
    - 尤其适合大分辨率 / 大 batch / ComfyUI 工作流
    """
    # 保存原始形状（支持 [B, H, W] 或 [B, 1, H, W]）
    original_shape = mask.shape
    if mask.dim() == 4:
        mask = mask.squeeze(1)          # [B,1,H,W] → [B,H,W]
    if mask.dim() == 2:
        mask = mask.unsqueeze(0)        # 单张图也支持

    # ====================== 1. Grow / Erode ======================
    m = mask.clone().float()
    kernel_size = 3
    padding = 1

    for _ in range(abs(grow)):
        if grow > 0:                    # 膨胀
            m = F.max_pool2d(m, kernel_size, stride=1, padding=padding)
        else:                           # 腐蚀
            m = 1.0 - F.max_pool2d(1.0 - m, kernel_size, stride=1, padding=padding)

    # ====================== 2. 距离线性 ramp（核心高效实现） ======================
    if blur <= 0:
        result = m
    else:
        result = torch.zeros_like(m, dtype=torch.float32)
        current = m > 0.5                       # 当前二值区域（bool tensor）

        for i in range(blur):
            # binary erosion（纯 torch 实现）
            eroded = 1.0 - F.max_pool2d(1.0 - current.float(), 
                                        kernel_size, stride=1, padding=padding) > 0.5
            
            # 当前最外层“环”（距离边界最近的像素）
            ring = current & ~eroded
            
            # 赋值：最外环 i=0 → 0.0，逐渐向内增大
            result[ring] = float(i) / blur
            
            current = eroded

        # 剩余最内部区域（距离 ≥ blur）直接设为 1.0
        result[current] = 1.0

        # 确保背景永远是 0
        result = torch.where(m > 0.5, result, torch.zeros_like(result))

    # ====================== 恢复原始形状 ======================
    if len(original_shape) == 4:
        result = result.unsqueeze(1)        # [B, H, W] → [B, 1, H, W]

    return result