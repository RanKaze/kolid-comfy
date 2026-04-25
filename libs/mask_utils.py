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
from torchvision.transforms import GaussianBlur
from typing import List, Union

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
    GPU 高效版 expand_mask（距离线性羽化）
    - grow: 正数向外膨胀，负数向内腐蚀
    - blur: 向内羽化距离（blur=30 → 距离边缘 >=30 像素处为1.0，最边缘为0.0，中间线性渐变）
    """
    print(f"[expand_mask_gpu] grow={grow} | blur={blur} | shape={mask.shape} | device={mask.device}")

    original_shape = mask.shape

    # ====================== 形状归一化 ======================
    if mask.dim() == 4:
        mask = mask.squeeze(1)      # [B,1,H,W] → [B,H,W]
    if mask.dim() == 2:
        mask = mask.unsqueeze(0)    # [H,W] → [B,H,W]

    # 确保在 GPU 上
    if not mask.is_cuda:
        mask = mask.to('cuda', non_blocking=True)

    m = mask.clone().float()
    B, H, W = m.shape

    # ====================== 1. Grow / Erode ======================
    kernel_size = 3
    padding = 1

    for _ in range(abs(grow)):
        if grow > 0:
            m = F.max_pool2d(m, kernel_size, stride=1, padding=padding)
        else:
            m = 1.0 - F.max_pool2d(1.0 - m, kernel_size, stride=1, padding=padding)

    # ====================== 2. 距离线性 Ramp（高效矢量化版） ======================
    if blur <= 0:
        result = m
    else:
        # 当前的二值 mask（内部区域）
        current = (m > 0.5).float()

        # 用于累积距离的 tensor（初始为 0）
        distance = torch.zeros_like(m)

        for i in range(blur):
            # 一次 binary erosion
            eroded = 1.0 - F.max_pool2d(1.0 - current, kernel_size, stride=1, padding=padding)
            eroded = (eroded > 0.5).float()

            # 当前最外层的 ring
            ring = current - eroded                     # 差值得到当前环

            # 赋值：最外环 (i=0) → 0.0，向内逐渐增大到 blur-1
            distance += ring * (i / blur)

            current = eroded

        # 剩余最内部区域（距离 >= blur）设为 1.0
        distance += current * 1.0

        # 只在原始膨胀区域内生效，外部强制为 0
        result = torch.where(m > 0.5, distance, torch.zeros_like(distance))

    # ====================== 恢复原始形状 ======================
    if len(original_shape) == 4:
        result = result.unsqueeze(1)

    return result

def combine_masks(
    masks: Union[torch.Tensor, List[torch.Tensor]], 
    mode: str = "max"
) -> torch.Tensor:
    """
    将多个 mask 合并成单个 [1, H, W] 的 mask
    
    支持以下所有输入格式：
        1. Tensor [N, H, W]
        2. Tensor [1, H, W]
        3. Tensor [H, W]
        4. List[Tensor]，每个元素为 [1, H, W]
        5. List[Tensor]，每个元素为 [H, W]
        6. List[Tensor]，每个元素为 [N, H, W]   ← 新增支持
    
    合并模式:
        "max"/"any"   → 并集（任意一个为1则为1，推荐用于 SAM/Grounding）
        "min"/"all"   → 交集（所有都为1才为1）
        "sum"         → 数值求和（重叠区域值更高）
        "mean"        → 取平均
    
    返回: torch.Tensor，形状固定为 [1, H, W]，值域 [0.0, 1.0]
    """

    if masks is None:
        raise ValueError("输入 masks 不能为空")

    # ====================== 第一步：统一转换为 [N_total, H, W] ======================
    if isinstance(masks, list):
        if len(masks) == 0:
            raise ValueError("mask list 不能为空")

        processed_list = []

        for idx, m in enumerate(masks):
            if not isinstance(m, torch.Tensor):
                raise TypeError(f"列表第 {idx} 个元素必须是 torch.Tensor")

            if m.dim() == 2:                    # [H, W]
                m = m.unsqueeze(0)              # → [1, H, W]

            elif m.dim() == 3:
                if m.shape[0] == 1:             # [1, H, W]
                    pass
                else:                           # [N, H, W] 或其他
                    # 关键处理：把 [N, H, W] 展平为多个 [1, H, W]
                    m = m.reshape(-1, m.shape[1], m.shape[2])   # [N*..., H, W]

            else:
                raise ValueError(f"列表第 {idx} 个 mask 维度非法: {m.dim()}D，形状: {m.shape}")

            processed_list.append(m)

        # 将所有处理后的 mask 拼接成一个大 batch
        batch_masks = torch.cat(processed_list, dim=0)   # [N_total, H, W]

    else:
        # 输入是单个 Tensor
        if not isinstance(masks, torch.Tensor):
            raise TypeError("masks 必须是 torch.Tensor 或 List[torch.Tensor]")

        if masks.dim() == 2:                        # [H, W]
            batch_masks = masks.unsqueeze(0)
        elif masks.dim() == 3:
            batch_masks = masks
        else:
            raise ValueError(f"Tensor 输入维度必须为 2D 或 3D，实际: {masks.dim()}D")

    # ====================== 第二步：如果只有一个 mask，直接返回 ======================
    if batch_masks.shape[0] == 0:
        raise ValueError("处理后 mask 数量不能为 0")

    if batch_masks.shape[0] == 1:
        combined = batch_masks.clone()
    else:
        # ====================== 第三步：根据 mode 合并 ======================
        mode = mode.lower().strip()

        if mode in ["max", "any"]:
            combined = torch.max(batch_masks, dim=0, keepdim=True)[0]
        elif mode in ["min", "all"]:
            combined = torch.min(batch_masks, dim=0, keepdim=True)[0]
        elif mode == "sum":
            combined = torch.sum(batch_masks, dim=0, keepdim=True)
        elif mode == "mean":
            combined = torch.mean(batch_masks, dim=0, keepdim=True)
        else:
            raise ValueError(f"不支持的模式: '{mode}'。支持模式: max, min, sum, mean, any, all")

    # ====================== 第四步：统一输出到 [0,1] 范围 ======================
    combined = torch.clamp(combined.float(), 0.0, 1.0)

    return combined

def mask_batch_to_list(masks: torch.Tensor) -> List[torch.Tensor]:
    """
    将形状为 [N, H, W] 的 batch mask 转换为 List[torch.Tensor]，
    每个元素形状为 [1, H, W]
    
    参数:
        masks: torch.Tensor, shape = [N, H, W]
    
    返回:
        List[torch.Tensor], 长度为 N，每个 tensor 的 shape = [1, H, W]
    """
    if masks.ndim != 3:
        raise ValueError(f"输入 tensor 的维度必须为 3 (N, H, W)，当前维度为 {masks.ndim}")
    
    N, H, W = masks.shape
    
    # 方法1：最清晰推荐的方式
    mask_list = [masks[i:i+1, :, :].clone() for i in range(N)]
    
    # 或者方法2：使用 unsqueeze（等价写法）
    # mask_list = [masks[i].unsqueeze(0) for i in range(N)]
    
    return mask_list

def mask_list_to_batch(mask_list: List[torch.Tensor]) -> torch.Tensor:
    """
    将 List[torch.Tensor]（每个元素形状为 [1, H, W]）转换回 [N, H, W] 的 batch tensor
    
    参数:
        mask_list: List[torch.Tensor]，每个 tensor 的形状必须为 [1, H, W]
    
    返回:
        torch.Tensor，形状为 [N, H, W]
    """
    if not mask_list:
        raise ValueError("mask_list 不能为空")
    
    # 检查第一个 mask 的形状
    first_mask = mask_list[0]
    if first_mask.ndim != 3 or first_mask.shape[0] != 1:
        raise ValueError(f"列表中每个 mask 的形状必须为 [1, H, W]，当前第一个 mask 形状为 {first_mask.shape}")
    
    # 检查所有 mask 形状是否一致（H 和 W）
    H, W = first_mask.shape[1], first_mask.shape[2]
    for i, mask in enumerate(mask_list):
        if mask.shape != (1, H, W):
            raise ValueError(f"第 {i} 个 mask 形状不一致，期望 [1, {H}, {W}]，实际为 {mask.shape}")
    
    # 拼接成 [N, H, W]
    # 方法1：推荐（最清晰且高效）
    batch_mask = torch.cat(mask_list, dim=0)   # [N, H, W]
    
    return batch_mask

def create_empty_mask(image):
    """
    根据输入 image 的尺寸创建一个纯黑的 mask（全 0）
    
    输入:
        image: 可以是 torch.Tensor 或 numpy.ndarray
               支持形状: (B, H, W, C)、(H, W, C)、(B, H, W)
    
    输出:
        torch.Tensor 形状 (B, H, W)，全为 0.0，适合作为 mask 使用
    """
    # 统一转为 numpy 获取形状
    if isinstance(image, torch.Tensor):
        img_np = image.cpu().numpy()
    else:
        img_np = np.asarray(image)

    # 提取 B, H, W
    if len(img_np.shape) == 4:           # (B, H, W, C)
        B, H, W, _ = img_np.shape
    elif len(img_np.shape) == 3:         # (H, W, C) 或 (B, H, W)
        if img_np.shape[-1] <= 4:        # 最后维度是通道数（RGB/RGBA）
            B, H, W = 1, img_np.shape[0], img_np.shape[1]
        else:                            # (B, H, W)
            B, H, W = img_np.shape
    else:
        raise ValueError(f"Unsupported image shape: {img_np.shape}")

    # 创建纯黑 mask (全 0)
    empty_mask = np.zeros((B, H, W), dtype=np.float32)

    # 转为 torch.Tensor
    tensor = torch.from_numpy(empty_mask).float().contiguous()

    return tensor

def invert_mask(mask):
    """
    反转 MASK（ComfyUI 标准的 MASK 类型）
    
    参数:
        mask: torch.Tensor, shape [B, H, W] 或 [H, W]，值域通常为 [0.0, 1.0] 的 float
    
    返回:
        torch.Tensor: 反转后的 mask（原来是 1 的地方变成 0，原来是 0 的地方变成 1）
    """
    if mask is None:
        return None
    
    # 确保是 tensor 并复制，避免原地修改
    mask = torch.as_tensor(mask, dtype=torch.float32)
    
    # 最常用且高效的反转方式（支持 batch）
    return 1.0 - mask