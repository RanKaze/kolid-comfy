import io
import base64
import torch
import torch.nn.functional as F
import numpy as np
import cv2
from PIL import Image, ImageFilter, ImageChops, ImageDraw, ImageOps, ImageEnhance, ImageFont

def tensor2pil(t_image: torch.Tensor)  -> Image:
    return Image.fromarray(np.clip(255.0 * t_image.cpu().numpy().squeeze(), 0, 255).astype(np.uint8))

def pil2tensor(image:Image) -> torch.Tensor:
    return torch.from_numpy(np.array(image).astype(np.float32) / 255.0).unsqueeze(0)

def image_to_base64(image_tensor):
    """将 ComfyUI 的 IMAGE tensor 转为 base64（假设是 torch tensor，shape [B,H,W,C]）"""
    # 根据你的实际 IMAGE 格式调整（这里假设是 [1, H, W, 3] float32 0-1）
    img = (image_tensor[0] * 255).clamp(0, 255).byte().cpu().numpy()
    pil_img = Image.fromarray(img)
    buffer = io.BytesIO()
    pil_img.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("utf-8")

def hex_to_rgb(hex_color: str):
    """将 #RRGGBB 或 #RGB 转为 torch tensor [3]"""
    hex_color = hex_color.lstrip('#').strip()
    if len(hex_color) == 3:
        hex_color = ''.join(c * 2 for c in hex_color)
    if len(hex_color) != 6:
        raise ValueError("Invalid hex color")
    rgb = tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))
    return torch.tensor(rgb, dtype=torch.float32) / 255.0

def crop_mask(image, mask, reserve):
    """
    Crop image and mask based on mask bounds with reserve
    """
    try:
        B, H, W, C = image.shape
        Bm, Hm, Wm = mask.shape

        if H != Hm or W != Wm:
            raise ValueError("Image and mask must have the same spatial dimensions")

        # ==================== 关键修复：统一设备 ====================
        device = image.device
        if mask.device != device:
            mask = mask.to(device, non_blocking=True)

        print(f"[crop_mask] {W}x{H} | reserve={reserve} | batch={B} | device={device}")

        # ------------------- 向量化计算 bounding box -------------------
        m = mask.unsqueeze(1).float()

        row_sum = m.sum(dim=(1, 3))
        col_sum = m.sum(dim=(1, 2))

        def get_bounds(proj):
            valid = proj > 0
            indices = torch.arange(proj.shape[1], device=device, dtype=torch.long).unsqueeze(0).expand_as(proj)
            min_idx = torch.where(valid, indices, torch.full_like(indices, H + 1))
            max_idx = torch.where(valid, indices, torch.full_like(indices, -1))
            min_val = min_idx.min(dim=1)[0]
            max_val = max_idx.max(dim=1)[0]
            return min_val, max_val

        min_y, max_y = get_bounds(row_sum)
        min_x, max_x = get_bounds(col_sum)

        empty_mask = (min_y > max_y) | (min_x > max_x)

        # 加上 reserve 并 clamp
        min_x = torch.clamp(min_x - reserve, min=0)
        min_y = torch.clamp(min_y - reserve, min=0)
        max_x = torch.clamp(max_x + reserve, max=W - 1)
        max_y = torch.clamp(max_y + reserve, max=H - 1)

        crop_w = torch.where(empty_mask, torch.tensor(W, device=device), max_x - min_x + 1)
        crop_h = torch.where(empty_mask, torch.tensor(H, device=device), max_y - min_y + 1)

        max_crop_h = int(crop_h.max().item())
        max_crop_w = int(crop_w.max().item())

        cropped_images = []
        cropped_masks_list = []
        crop_infos = []

        original_area = W * H

        for i in range(B):
            if empty_mask[i]:
                cropped_images.append(image[i])
                cropped_masks_list.append(mask[i])
                crop_area = W * H
                crop_info = {
                    "original_width": W,
                    "original_height": H,
                    "crop_x": 0,
                    "crop_y": 0,
                    "crop_width": W,
                    "crop_height": H,
                    "spatial_rate": 1.0
                }
            else:
                x1, y1 = int(min_x[i]), int(min_y[i])
                x2, y2 = int(max_x[i]) + 1, int(max_y[i]) + 1

                cropped_img = image[i, y1:y2, x1:x2, :]
                cropped_msk = mask[i, y1:y2, x1:x2]

                # Padding 到最大尺寸
                if cropped_img.shape[0] < max_crop_h or cropped_img.shape[1] < max_crop_w:
                    pad_h = max_crop_h - cropped_img.shape[0]
                    pad_w = max_crop_w - cropped_img.shape[1]
                    cropped_img = F.pad(cropped_img.permute(2, 0, 1), (0, pad_w, 0, pad_h)).permute(1, 2, 0)
                    cropped_msk = F.pad(cropped_msk.unsqueeze(0), (0, pad_w, 0, pad_h)).squeeze(0)

                cropped_images.append(cropped_img)
                cropped_masks_list.append(cropped_msk)

                crop_width = x2 - x1
                crop_height = y2 - y1
                crop_area = crop_width * crop_height
                spatial_rate = crop_area / original_area if original_area > 0 else 0.0
                crop_info = {
                    "original_width": W,
                    "original_height": H,
                    "crop_x": x1,
                    "crop_y": y1,
                    "crop_width": crop_width,
                    "crop_height": crop_height,
                    "spatial_rate": spatial_rate
                }

            crop_infos.append(crop_info)

        cropped_image_tensor = torch.stack(cropped_images, dim=0)
        cropped_mask_tensor = torch.stack(cropped_masks_list, dim=0)

        final_crop_info = crop_infos[0]

        print(f"[MASK-TRACE] crop_mask OUTPUT | crop_info={final_crop_info} | cropped_mask shape={cropped_mask_tensor.shape} | sum={cropped_mask_tensor.sum().item():.1f}")
        return (cropped_image_tensor, cropped_mask_tensor, final_crop_info)

    except Exception as e:
        raise Exception(f"Failed to crop image by mask: {e}")

def recover_crop(background, image, crop_info, recover_method, mask=None):
    """
    Recover cropped image to original size using crop info
    """
    try:
        ow = crop_info.get("original_width")
        oh = crop_info.get("original_height")
        cx = crop_info.get("crop_x")
        cy = crop_info.get("crop_y")

        if None in (ow, oh, cx, cy):
            raise ValueError("Crop info missing required fields")

        B, H, W, C = image.shape

        # ==================== 仅保留一行 print ====================
        print(f"[recover_crop] {W}x{H} → {ow}x{oh} | method={recover_method}")

        # ==================== 统一设备 ====================
        device = background.device
        if image.device != device:
            image = image.to(device, non_blocking=True)
        if mask is not None and mask.device != device:
            mask = mask.to(device, non_blocking=True)

        # 从 background 克隆开始
        recovered = background.clone()

        # 准备要粘贴的区域
        crop_region = recovered[:, cy:cy + H, cx:cx + W, :]

        if recover_method == "bounds_only":
            # 直接硬覆盖（不需要 mask）
            crop_region.copy_(image)

        elif recover_method in ["mask_blend", "mask_only"]:
            if mask is None:
                raise ValueError(f"{recover_method} requires mask input")

            # mask 转为 (B, 1, H, W)
            m = mask.unsqueeze(1)[:, :, :H, :W].float()   # (B, 1, H, W)
            m3 = m.expand(-1, C, -1, -1).permute(0, 2, 3, 1)  # (B, H, W, C)

            if recover_method == "mask_blend":
                # 柔和混合（推荐，大多数情况使用这个）
                blended = crop_region * (1 - m3) + image * m3
                crop_region.copy_(blended)

            elif recover_method == "mask_only":
                # 只保留 mask 区域的内容（硬抠图，不混合背景）
                # 等价于：background * (1 - mask) + image * mask，但只在 mask 区域替换
                crop_region.copy_(image * m3 + crop_region * (1 - m3))  # 或者更直接：
                # crop_region.copy_(torch.where(m3 > 0.5, image, crop_region))

        else:
            raise ValueError(f"Unknown recover_method: {recover_method}. "
                           f"Supported: bounds_only, mask_blend, mask_only")

        # ------------------- 处理 recovered_mask 输出 -------------------
        recovered_mask = None
        if mask is not None:
            Bm, Hm, Wm = mask.shape
            recovered_mask = torch.zeros((Bm, oh, ow), dtype=background.dtype, device=device)
            # 把 cropped mask 放回原始位置
            recovered_mask[:, cy:cy + Hm, cx:cx + Wm] = mask[:, :Hm, :Wm]

        _rc_sum = f"{recovered_mask.sum().item():.1f}" if recovered_mask is not None else "N/A"
        print(f"[MASK-TRACE] recover_crop OUTPUT | recovered_mask shape={recovered_mask.shape if recovered_mask is not None else None} | sum={_rc_sum}")
        return (recovered, recovered_mask)

    except Exception as e:
        raise Exception(f"Failed to recover cropped image: {e}")

def batch_image_mask_list(images, align=16, width=0, height=0, masks=None, fill_image="#000000", fill_mask=0.0):
    """
    将多个不同尺寸的 IMAGE 和 MASK 转为统一尺寸的 Batch，居中填充
    
    最终对称处理逻辑：
    - 只设置 width > 0（height=0）：按 width 缩小后，target_h 自动向上对齐 align
    - 只设置 height > 0（width=0）：按 height 缩小后，target_w 自动向上对齐 align
    - 同时设置 width 和 height：强制使用指定尺寸（不强制 align）
    - width=height=0：基于所有图片的面积加权平均宽高比自动计算最优尺寸
    
    Args:
        images: list of (H, W, C) or (1, H, W, C) tensors
        align: int, alignment for dimensions
        width: int, target width
        height: int, target height
        masks: list of (H, W) or (1, H, W) tensors
        fill_image: str, hex color for filling
        fill_mask: float, value for filling mask
    
    Returns:
        batched_images: (B, target_h, target_w, C) tensor
        batched_masks: (B, target_h, target_w) tensor
        batch_info: dict with batch information
    """
    # 处理 INPUT_IS_LIST
    if isinstance(align, list):     align = align[0] if align else 16
    if isinstance(width, list):     width = width[0] if width else 0
    if isinstance(height, list):    height = height[0] if height else 0
    if isinstance(fill_image, list): fill_image = fill_image[0] if fill_image else "#000000"
    if isinstance(fill_mask, list): fill_mask = fill_mask[0] if fill_mask else 0.0

    if not isinstance(images, list):
        images = [images]
    if len(images) == 0:
        raise ValueError("至少需要输入一张图片")

    processed_images = [img.squeeze(0) if len(img.shape) == 4 and img.shape[0] == 1 else img for img in images]
    device = processed_images[0].device
    dtype = processed_images[0].dtype

    # 预计算 auto 模式（width=0, height=0）的最优目标尺寸
    # 算法：面积加权平均宽高比 + 最大图片像素数作为像素预算
    if width == 0 and height == 0:
        all_dims = [(p.shape[1], p.shape[0], p.shape[1] * p.shape[0]) for p in processed_images]
        total_area = sum(d[2] for d in all_dims)
        if total_area > 0:
            weighted_ar = sum((d[0] / d[1]) * d[2] for d in all_dims) / total_area
        else:
            weighted_ar = 1.0
        target_pixels = max(d[2] for d in all_dims)
        t_h = int((target_pixels / weighted_ar) ** 0.5)
        t_w = int(t_h * weighted_ar)
        if align > 1:
            t_w = ((t_w + align - 1) // align) * align
            t_h = ((t_h + align - 1) // align) * align
        print(f"[batch_image_mask_list] auto mode: weighted_ar={weighted_ar:.4f}, target_pixels={target_pixels}, target={t_w}x{t_h}")

    # 第一步：计算每张图片缩小后的 new_h, new_w
    new_dims = []
    for img in processed_images:
        orig_h, orig_w = img.shape[0], img.shape[1]

        if width > 0 and height > 0:
            scale = min(width / orig_w, height / orig_h)
        elif width > 0:
            scale = width / orig_w
        elif height > 0:
            scale = height / orig_h
        else:
            # auto 模式：使用预计算的加权平均宽高比目标尺寸
            scale = min(t_w / orig_w, t_h / orig_h)

        new_h = int(orig_h * scale)
        new_w = int(orig_w * scale)
        new_dims.append((new_h, new_w, scale, orig_h, orig_w))

    # 第二步：决定最终 target_w / target_h + align 对齐（已对称处理）
    if width > 0 and height > 0:
        # 同时限制 → 使用固定尺寸，不强制 align
        target_w = width
        target_h = height
    elif width > 0:
        # 只限制 width → 宽度固定，高度自动计算后向上对齐 align
        target_w = width
        content_max_h = max(nd[0] for nd in new_dims)
        target_h = ((content_max_h + align - 1) // align) * align if align > 1 else content_max_h
    elif height > 0:
        # 只限制 height → 高度固定，宽度自动计算后向上对齐 align
        target_h = height
        content_max_w = max(nd[1] for nd in new_dims)
        target_w = ((content_max_w + align - 1) // align) * align if align > 1 else content_max_w
    else:
        # auto 模式：使用预计算的最优目标尺寸
        target_h = t_h
        target_w = t_w

    # 创建填充背景
    try:
        rgb = hex_to_rgb(fill_image)
        fill_bg = rgb.to(device=device, dtype=dtype).view(1, 1, 3).expand(target_h, target_w, 3)
    except Exception:
        fill_bg = torch.zeros((target_h, target_w, 3), dtype=dtype, device=device)

    batched_images = fill_bg.unsqueeze(0).repeat(len(images), 1, 1, 1).clone()

    batched_masks = None
    if masks is not None:
        if not isinstance(masks, list):
            masks = [masks]
        batched_masks = torch.full((len(images), target_h, target_w), fill_mask, dtype=torch.float32, device=device)

    batch_info_list = []

    for i, (new_h, new_w, scale, orig_h, orig_w) in enumerate(new_dims):
        pad_top = (target_h - new_h) // 2
        pad_left = (target_w - new_w) // 2

        # 缩放图像
        img_resized = F.interpolate(
            processed_images[i].unsqueeze(0).permute(0, 3, 1, 2),
            size=(new_h, new_w),
            mode="bicubic",
            align_corners=False
        ).permute(0, 2, 3, 1).squeeze(0)

        batched_images[i, pad_top:pad_top + new_h, pad_left:pad_left + new_w] = img_resized

        # 处理 mask
        if batched_masks is not None and i < len(masks):
            mask = masks[i]
            if len(mask.shape) == 3 and mask.shape[0] == 1:
                mask = mask.squeeze(0)
            mask_resized = F.interpolate(
                mask.unsqueeze(0).unsqueeze(0),
                size=(new_h, new_w),
                mode="nearest"
            ).squeeze(0).squeeze(0)
            batched_masks[i, pad_top:pad_top + new_h, pad_left:pad_left + new_w] = mask_resized

        batch_info_list.append({
            "original_height": orig_h,
            "original_width": orig_w,
            "target_height": target_h,
            "target_width": target_w,
            "pad_top": pad_top,
            "pad_left": pad_left,
            "content_height": new_h,
            "content_width": new_w,
            "scale": scale,
        })

    if batched_masks is None:
        batched_masks = torch.full((len(images), target_h, target_w), fill_mask, dtype=torch.float32, device=device)

    batch_info = {
        "batch_size": len(images),
        "target_height": target_h,
        "target_width": target_w,
        "align": align,
        "target_width_param": width,
        "target_height_param": height,
        "per_image_info": batch_info_list,
        "fill_hex": fill_image,
        "fill_mask": fill_mask,
    }

    return (batched_images, batched_masks, batch_info)


def recover_batch(image, batch_info, mask=None):
    """
    恢复节点 - 把 Batch 后的图像和 mask 恢复为原始尺寸的 List
    
    Args:
        image: (B, H, W, 3) tensor
        batch_info: dict with batch information
        mask: (B, H, W) tensor, optional
    
    Returns:
        recovered_images: list of (1, orig_h, orig_w, 3) tensors
        recovered_masks: list of (1, orig_h, orig_w) tensors
    """
    per_image_info = batch_info.get("per_image_info", [])
    B = len(per_image_info)
    if B == 0:
        raise ValueError("batch_info 中没有 per_image_info 数据")

    recovered_images = []
    recovered_masks = []

    # ====================== 处理输入 image ======================
    if isinstance(image, torch.Tensor):
        if image.dim() == 4:
            # [B, H, W, 3] → 拆分成 list of [1, H, W, 3]
            image_list = [image[i:i+1] for i in range(B)]
        else:
            image_list = [image.unsqueeze(0) if image.dim() == 3 else image]
    else:
        image_list = []
        for img in (image if isinstance(image, list) else [image]):
            if isinstance(img, torch.Tensor):
                if img.dim() == 3:
                    image_list.append(img.unsqueeze(0))
                elif img.dim() == 4 and img.shape[0] == 1:
                    image_list.append(img)
                else:
                    image_list.append(img)
            else:
                image_list.append(img)

    # ====================== 处理输入 mask ======================
    if mask is not None:
        if isinstance(mask, torch.Tensor):
            if mask.dim() == 3:
                mask_list = [mask[i:i+1] for i in range(B)]   # [B, H, W] → list of [1, H, W]
            elif mask.dim() == 4 and mask.shape[1] == 1:
                mask_list = [mask[i:i+1].squeeze(1) for i in range(B)]
            else:
                mask_list = [mask.unsqueeze(0) if mask.dim() == 2 else mask]
        else:
            mask_list = []
            for m in (mask if isinstance(mask, list) else [mask]):
                if isinstance(m, torch.Tensor):
                    if m.dim() == 2:
                        mask_list.append(m.unsqueeze(0))
                    else:
                        mask_list.append(m)
                else:
                    mask_list.append(m)
    else:
        mask_list = [None] * B

    # ====================== 逐个恢复 ======================
    for i in range(B):
        info = per_image_info[i]

        orig_h = info["original_height"]
        orig_w = info["original_width"]
        pad_top = info.get("pad_top", 0)
        pad_left = info.get("pad_left", 0)
        content_h = info.get("content_height", 0)
        content_w = info.get("content_width", 0)

        # ==================== 恢复 Image ====================
        current_img = image_list[i]
        if current_img.dim() == 3:
            current_img = current_img.unsqueeze(0)  # → [1, H, W, 3]

        # 裁剪出有效内容区域
        cropped = current_img[0, pad_top:pad_top + content_h, pad_left:pad_left + content_w, :]

        # 缩放回原始尺寸
        if content_h != orig_h or content_w != orig_w:
            img_resized = F.interpolate(
                cropped.unsqueeze(0).permute(0, 3, 1, 2),   # [1, 3, content_h, content_w]
                size=(orig_h, orig_w),
                mode="bicubic",
                align_corners=False
            ).permute(0, 2, 3, 1)                          # → [1, orig_h, orig_w, 3]
        else:
            img_resized = cropped.unsqueeze(0)

        recovered_images.append(img_resized)

        # ==================== 恢复 Mask ====================
        if mask_list[i] is not None:
            current_mask = mask_list[i]
            if current_mask.dim() == 2:
                current_mask = current_mask.unsqueeze(0)    # [1, H, W]
            elif current_mask.dim() == 3 and current_mask.shape[0] != 1:
                current_mask = current_mask.unsqueeze(0)

            cropped_mask = current_mask[0, pad_top:pad_top + content_h, pad_left:pad_left + content_w]

            if content_h != orig_h or content_w != orig_w:
                mask_resized = F.interpolate(
                    cropped_mask.unsqueeze(0).unsqueeze(0),   # [1, 1, content_h, content_w]
                    size=(orig_h, orig_w),
                    mode="nearest"
                ).squeeze(0)                                  # → [1, orig_h, orig_w]
            else:
                mask_resized = cropped_mask.unsqueeze(0)

            recovered_masks.append(mask_resized)
        else:
            # 无 mask 时返回全 0 mask
            zero_mask = torch.zeros((1, orig_h, orig_w), dtype=torch.float32, device=current_img.device)
            recovered_masks.append(zero_mask)

    return (recovered_images, recovered_masks)


def limit_pixels(image, pixels, mask=None, align=1):
    """
    Limit image pixel count by resizing if needed, with optional dimension alignment.
    """
    try:
        B, H, W, C = image.shape
        current_pixels = H * W

        # ==================== 仅保留这一行 print ====================
        print(f"[limit_pixels] {W}x{H} ({current_pixels:,} px) → target {pixels:,} px | align={align}")

        # 如果当前像素数已经接近目标（允许少量误差），直接返回
        if abs(current_pixels - pixels) < 100:
            resize_info = {
                "original_width": W,
                "original_height": H,
                "resized_width": W,
                "resized_height": H,
                "aspect_ratio": W / H if H != 0 else 1.0,
                "scale_factor": 1.0,
                "align": align,
                "was_upscaled": False
            }
            return (image, mask, resize_info)

        aspect_ratio = W / H if H != 0 else 1.0

        if current_pixels < pixels:
            # ==================== 需要放大 ====================
            ideal_width = (pixels * aspect_ratio) ** 0.5
            ideal_height = ideal_width / aspect_ratio

            new_width = max(align, round(ideal_width / align) * align)
            new_height = max(align, round(ideal_height / align) * align)

            while new_width * new_height > pixels + 100:
                new_width = max(align, new_width - align)
                new_height = max(align, new_height - align)

            new_width = max(64, new_width)
            new_height = max(64, new_height)

        else:
            # ==================== 需要缩小 ====================
            ideal_width = (pixels * aspect_ratio) ** 0.5
            ideal_height = ideal_width / aspect_ratio

            new_width = max(align, round(ideal_width / align) * align)
            new_height = max(align, round(ideal_height / align) * align)

            while new_width * new_height > pixels:
                new_width = max(align, new_width - align)
                new_height = max(align, new_height - align)

            new_width = max(16, new_width)
            new_height = max(16, new_height)

        # ---------- 纯 PyTorch 批量缩放 ----------
        img_tensor = image.permute(0, 3, 1, 2).contiguous()

        resized_img = F.interpolate(
            img_tensor,
            size=(new_height, new_width),
            mode='bicubic',
            align_corners=False,
            antialias=True
        )

        resized_image = resized_img.permute(0, 2, 3, 1).contiguous()

        # ---------- 处理 mask ----------
        resized_mask = mask
        if mask is not None:
            mask_tensor = mask.unsqueeze(1)
            resized_m = F.interpolate(
                mask_tensor,
                size=(new_height, new_width),
                mode='bicubic',
                align_corners=False,
                antialias=True
            )
            resized_mask = resized_m.squeeze(1).clamp(0.0, 1.0)

        # 创建 resize_info
        resize_info = {
            "original_width": W,
            "original_height": H,
            "resized_width": new_width,
            "resized_height": new_height,
            "aspect_ratio": aspect_ratio,
            "scale_factor": new_width / W,
            "align": align,
            "was_upscaled": current_pixels < pixels
        }

        _lp_sum = f"{resized_mask.sum().item():.1f}" if resized_mask is not None else "N/A"
        print(f"[MASK-TRACE] limit_pixels OUTPUT | resized_mask shape={resized_mask.shape if resized_mask is not None else None} | sum={_lp_sum}")
        return (resized_image, resized_mask, resize_info)

    except Exception as e:
        raise Exception(f"Failed to limit pixels: {e}")


def recover_size(image, resize_info, mask=None):
    """
    Recover image and mask back to original size using resize_info.
    """
    try:
        original_width = resize_info.get("original_width")
        original_height = resize_info.get("original_height")

        if original_width is None or original_height is None:
            raise ValueError("Resize info missing original dimensions")

        B, current_h, current_w, C = image.shape

        print(f"[recover_size] {current_w}x{current_h} → {original_width}x{original_height}")

        # ==================== 统一设备 ====================
        device = image.device
        if mask is not None and mask.device != device:
            mask = mask.to(device, non_blocking=True)

        if current_w == original_width and current_h == original_height:
            return (image, mask)

        # 恢复图像
        img_tensor = image.permute(0, 3, 1, 2).contiguous()
        recovered_img = F.interpolate(
            img_tensor,
            size=(original_height, original_width),
            mode='bicubic',
            align_corners=False,
            antialias=True
        )
        recovered_image = recovered_img.permute(0, 2, 3, 1).contiguous()

        # 恢复 mask
        recovered_mask = mask
        if mask is not None:
            if len(mask.shape) == 3:
                mask_tensor = mask.unsqueeze(1)
                recovered_m = F.interpolate(
                    mask_tensor,
                    size=(original_height, original_width),
                    mode='bicubic',
                    align_corners=False,
                    antialias=True
                )
                recovered_mask = recovered_m.squeeze(1).clamp_(0.0, 1.0)

        _rs_sum = f"{recovered_mask.sum().item():.1f}" if recovered_mask is not None else "N/A"
        print(f"[MASK-TRACE] recover_size OUTPUT | recovered_mask shape={recovered_mask.shape if recovered_mask is not None else None} | sum={_rs_sum}")
        return (recovered_image, recovered_mask)

    except Exception as e:
        raise Exception(f"Failed to recover image size: {e}")
    
def draw_mask_on_image(image, mask, color=(0, 255, 0, 128)):
    """
    将 mask 绘制到 image 上，返回适合 ui.PreviewImage 的 Tensor
    输出格式: torch.Tensor (B, H, W, 3)，值范围 0.0~1.0
    """
    # 转为 numpy float32
    image = np.asarray(image, dtype=np.float32)
    mask = np.asarray(mask, dtype=np.float32)

    # ====================== 处理 image ======================
    if len(image.shape) == 3:           # (H, W, C) → 加 batch
        image = image[None, ...]
    
    B, H, W, C = image.shape

    if C == 4:
        image = image[..., :3]          # 丢弃 alpha 通道，只保留 RGB 用于预览
    elif C != 3:
        raise ValueError(f"Unsupported image channels: {C}")

    # ====================== 处理 mask ======================
    if len(mask.shape) == 3:
        if mask.shape[0] != B:          # 单张 mask (H, W)
            mask = mask[None, ...]
    elif len(mask.shape) == 4:
        mask = mask[..., 0]

    # mask 统一到 0~1
    if mask.max() > 1.0:
        mask = mask / 255.0

    # ====================== 颜色混合 ======================
    r, g, b, a = [x / 255.0 for x in color]   # 转 0~1

    overlay = np.full((B, H, W, 3), [r, g, b], dtype=np.float32)
    effective_alpha = (a * mask)[..., None]   # (B, H, W, 1)

    # 混合
    result = image * (1 - effective_alpha) + overlay * effective_alpha

    result = np.clip(result, 0.0, 1.0)

    # ====================== 转 Tensor ======================
    tensor = torch.from_numpy(result).float()   # (B, H, W, 3)

    return tensor

def draw_mask(mask, color=(0, 255, 0, 128)):
    """
    根据 mask 生成预览图像
    - 输出尺寸完全跟随 mask 的尺寸
    - 有 mask 的地方显示指定颜色（带 alpha 透明度）
    - 没有 mask 的地方为纯黑色
    
    参数:
        mask:  mask，可以是 (H, W), (B, H, W), (H, W, 1), (B, H, W, 1)
        color: RGBA 颜色，例如 (0, 255, 0, 128) 绿色半透明
    
    返回:
        torch.Tensor 形状 (B, H, W, 3)，值范围 0.0 ~ 1.0，适合 ui.PreviewImage
    """
    # 转为 numpy float32
    mask = np.asarray(mask, dtype=np.float32)

    # ====================== 统一 mask 形状为 (B, H, W) ======================
    if len(mask.shape) == 2:                    # (H, W)
        mask = mask[None, ...]                  # → (1, H, W)
    elif len(mask.shape) == 4:                  # (B, H, W, 1)
        mask = mask[..., 0]                     # → (B, H, W)
    # 否则已经是 (B, H, W) 则不需要处理

    B, H, W = mask.shape

    # mask 值统一到 0~1
    if mask.max() > 1.0:
        mask = mask / 255.0

    # ====================== 生成图像 ======================
    r, g, b, a = [c / 255.0 for c in color]

    # 创建全黑背景
    result = np.zeros((B, H, W, 3), dtype=np.float32)

    # 在 mask 区域填充颜色（应用 alpha）
    effective_alpha = a * mask[..., None]       # (B, H, W, 1)

    result = result * (1 - effective_alpha) + np.array([r, g, b], dtype=np.float32) * effective_alpha

    # ====================== 转 Tensor ======================
    tensor = torch.from_numpy(result).float().contiguous()   # (B, H, W, 3)

    return tensor

def tensor_to_base64(image_tensor: torch.Tensor) -> str:
    """Convert an image tensor [B,H,W,C] or [1,H,W,C] to base64 JPEG data URL."""
    img_array = (image_tensor.squeeze(0).cpu().numpy() * 255).astype(np.uint8)
    img = Image.fromarray(img_array, mode='RGB')
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=90)
    b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
    return f"data:image/jpeg;base64,{b64}"


def mask_to_base64(mask_tensor: torch.Tensor) -> str:
    """Convert a mask tensor [B,H,W] or [H,W] to base64 grayscale JPEG data URL."""
    m = mask_tensor.squeeze().cpu().numpy()
    img_array = (np.clip(m, 0, 1) * 255).astype(np.uint8)
    img = Image.fromarray(img_array, mode='L')
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=90)
    b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
    return f"data:image/jpeg;base64,{b64}"


def set_inpaint_mask(resized_image: torch.Tensor, resized_mask: torch.Tensor, vae, grow_mask_by: int = 0):
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


def batch_images(image0, image1):
    """
    将两张图片合并成 batch（形状从单张变成 B=2）
    
    输入:
        image0, image1: 可以是以下任意格式：
                        - torch.Tensor (H, W, C) 或 (1, H, W, C)
                        - numpy.ndarray (H, W, C) 或 (1, H, W, C)
    
    输出:
        torch.Tensor，形状 (2, H, W, C)，值范围保持原样（推荐 0~1）
    """
    # 统一转为 numpy
    def to_numpy(img):
        if isinstance(img, torch.Tensor):
            img = img.cpu().numpy()
        else:
            img = np.asarray(img)
        return img

    img0 = to_numpy(image0)
    img1 = to_numpy(image1)

    # 如果是 (1, H, W, C) 这种带 batch 的，先去掉 batch 维度
    if len(img0.shape) == 4 and img0.shape[0] == 1:
        img0 = img0[0]
    if len(img1.shape) == 4 and img1.shape[0] == 1:
        img1 = img1[0]

    # 检查尺寸是否一致
    if img0.shape != img1.shape:
        raise ValueError(f"Two images must have the same shape. Got {img0.shape} and {img1.shape}")

    # 合并成 batch: (2, H, W, C)
    batched = np.stack([img0, img1], axis=0)

    # 转成 torch.Tensor
    tensor = torch.from_numpy(batched).float().contiguous()

    return tensor