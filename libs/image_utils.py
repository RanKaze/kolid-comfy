import torch
import torch.nn.functional as F

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
    
    Args:
        image: (B, H, W, C) tensor
        mask: (B, H, W) tensor
        reserve: int, number of pixels to reserve around the mask
    
    Returns:
        cropped_image: (B, crop_h, crop_w, C) tensor
        cropped_mask: (B, crop_h, crop_w) tensor
        crop_info: dict with original and crop dimensions
    """
    try:
        B, H, W, C = image.shape
        Bm, Hm, Wm = mask.shape

        if H != Hm or W != Wm:
            raise ValueError("Image and mask must have the same spatial dimensions")

        device = image.device
        dtype = image.dtype

        print(f"[ImageUtil] Image: {W}x{H}, Batch: {B}, Reserve: {reserve}")

        # ------------------- 向量化计算 bounding box -------------------
        # mask -> (B, 1, H, W)
        m = mask.unsqueeze(1).float()  # 确保是 float

        # 找到每张 mask 的非零区域（向量化）
        # row 投影
        row_sum = m.sum(dim=(1, 3))          # (B, H)
        col_sum = m.sum(dim=(1, 2))          # (B, W)

        # 找出每张图的最小/最大索引（支持空 mask）
        def get_bounds(proj):
            # proj shape: (B, size)
            valid = proj > 0
            indices = torch.arange(proj.shape[1], device=device, dtype=torch.long).unsqueeze(0).expand_as(proj)
            
            min_idx = torch.where(valid, indices, torch.full_like(indices, H + 1))
            max_idx = torch.where(valid, indices, torch.full_like(indices, -1))
            
            min_val = min_idx.min(dim=1)[0]
            max_val = max_idx.max(dim=1)[0]
            return min_val, max_val

        min_y, max_y = get_bounds(row_sum)
        min_x, max_x = get_bounds(col_sum)

        # 处理完全空的 mask（没有非零像素）
        empty_mask = (min_y > max_y) | (min_x > max_x)
        if empty_mask.any():
            print(f"[ImageUtil] {empty_mask.sum().item()} empty masks detected, returning original")

        # 加上 reserve 并 clamp
        min_x = torch.clamp(min_x - reserve, min=0)
        min_y = torch.clamp(min_y - reserve, min=0)
        max_x = torch.clamp(max_x + reserve, max=W - 1)
        max_y = torch.clamp(max_y + reserve, max=H - 1)

        # 计算 crop 大小（对空 mask 使用原始尺寸）
        crop_w = torch.where(empty_mask, torch.tensor(W, device=device), max_x - min_x + 1)
        crop_h = torch.where(empty_mask, torch.tensor(H, device=device), max_y - min_y + 1)

        # ------------------- 准备输出 -------------------
        # 我们需要把不同大小的 crop 放进 tensor，通常 ComfyUI 期望 batch 内尺寸一致
        # 这里取 batch 中最大的 crop 尺寸做 padding（最稳妥的方式）
        max_crop_h = int(crop_h.max().item())
        max_crop_w = int(crop_w.max().item())

        cropped_images = []
        cropped_masks_list = []
        crop_infos = []

        for i in range(B):
            if empty_mask[i]:
                # 空 mask：返回原始
                cropped_images.append(image[i])
                cropped_masks_list.append(mask[i])
                crop_info = {
                    "original_width": W,
                    "original_height": H,
                    "crop_x": 0,
                    "crop_y": 0,
                    "crop_width": W,
                    "crop_height": H
                }
            else:
                # 正常 crop
                x1, y1 = int(min_x[i]), int(min_y[i])
                x2, y2 = int(max_x[i]) + 1, int(max_y[i]) + 1

                cropped_img = image[i, y1:y2, x1:x2, :]
                cropped_msk = mask[i, y1:y2, x1:x2]

                # 如果 batch 内 crop 大小不一致，需要 padding 到最大尺寸
                if cropped_img.shape[0] < max_crop_h or cropped_img.shape[1] < max_crop_w:
                    pad_h = max_crop_h - cropped_img.shape[0]
                    pad_w = max_crop_w - cropped_img.shape[1]
                    cropped_img = F.pad(cropped_img.permute(2,0,1), (0, pad_w, 0, pad_h)).permute(1,2,0)
                    cropped_msk = F.pad(cropped_msk.unsqueeze(0), (0, pad_w, 0, pad_h)).squeeze(0)

                cropped_images.append(cropped_img)
                cropped_masks_list.append(cropped_msk)

                crop_info = {
                    "original_width": W,
                    "original_height": H,
                    "crop_x": x1,
                    "crop_y": y1,
                    "crop_width": x2 - x1,
                    "crop_height": y2 - y1
                }

            crop_infos.append(crop_info)

        # 堆叠成 batch tensor
        cropped_image_tensor = torch.stack(cropped_images, dim=0)
        cropped_mask_tensor = torch.stack(cropped_masks_list, dim=0)

        # 返回第一个 crop_info（与原节点保持一致，假设 batch 内 crop 大小接近）
        final_crop_info = crop_infos[0]

        print(f"[ImageUtil] Final cropped size: {max_crop_w}x{max_crop_h}")

        return (cropped_image_tensor, cropped_mask_tensor, final_crop_info)

    except Exception as e:
        raise Exception(f"Failed to crop image by mask: {e}")


def recover_crop(background, image, crop_info, recover_method, mask=None):
    """
    Recover cropped image to original size using crop info
    
    Args:
        background: (B, original_h, original_w, C) tensor
        image: (B, crop_h, crop_w, C) tensor
        crop_info: dict with original and crop dimensions
        recover_method: str, one of "mask_blend", "mask_only", "bounds_only"
        mask: (B, crop_h, crop_w) tensor, optional
    
    Returns:
        recovered: (B, original_h, original_w, C) tensor
        recovered_mask: (B, original_h, original_w) tensor, optional
    """
    try:
        # 提取 crop_info
        ow = crop_info.get("original_width")
        oh = crop_info.get("original_height")
        cx = crop_info.get("crop_x")
        cy = crop_info.get("crop_y")
        # crop_w/h 可以不强制检查（用 image 的实际尺寸）

        if None in (ow, oh, cx, cy):
            raise ValueError("Crop info missing required fields")

        # 确保 background 尺寸正确
        if background.shape[2] != ow or background.shape[1] != oh:
            raise ValueError(f"Background must be {ow}x{oh}, got {background.shape[2]}x{background.shape[1]}")

        device = background.device
        dtype = background.dtype
        B, H, W, C = image.shape  # 当前 cropped image 的 batch, height, width, channels

        # 输出图像直接从 background 克隆（更快且节省内存）
        recovered = background.clone()

        # 准备 cropped 区域
        crop_region = recovered[:, cy:cy + H, cx:cx + W, :]

        if recover_method == "bounds_only":
            # 最简单也最快：直接覆盖
            crop_region.copy_(image)

        else:
            # 需要 mask 的情况
            if mask is None:
                raise ValueError(f"{recover_method} requires mask input")

            # mask 转成 (B, 1, H, W) 并扩展到 3 通道
            m = mask.unsqueeze(1)  # (B, 1, mask_h, mask_w)
            m = m[:, :, :H, :W]    # 防止 mask 尺寸比 image 大
            m3 = m.expand(-1, C, -1, -1).permute(0, 2, 3, 1)  # (B, H, W, C)

            if recover_method in ["mask_blend", "mask_only"]:
                # 统一用 alpha blending 公式（mask_only 时相当于 mask > 0 的硬 blend）
                blended = crop_region * (1 - m3) + image * m3
                crop_region.copy_(blended)

        # ------------------- 处理 mask 输出 -------------------
        recovered_mask = None
        if mask is not None:
            Bm, Hm, Wm = mask.shape
            recovered_mask = torch.zeros((Bm, oh, ow), dtype=dtype, device=device)

            # 把 cropped mask 放回原位置（支持 batch）
            recovered_mask[:, cy:cy + Hm, cx:cx + Wm] = mask[:, :Hm, :Wm]

        return (recovered, recovered_mask)

    except Exception as e:
        raise Exception(f"Failed to recover cropped image: {e}")

def batch_images(images, align=16, width=0, height=0, masks=None, fill_image="#000000", fill_mask=0.0):
    """
    将多个不同尺寸的 IMAGE 和 MASK 转为统一尺寸的 Batch，居中填充
    
    最终对称处理逻辑：
    - 只设置 width > 0（height=0）：按 width 缩小后，target_h 自动向上对齐 align
    - 只设置 height > 0（width=0）：按 height 缩小后，target_w 自动向上对齐 align
    - 同时设置 width 和 height：强制使用指定尺寸（不强制 align）
    - width=height=0：使用 align 进行倍数对齐
    
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
            # align 模式
            max_orig_h = max(p.shape[0] for p in processed_images)
            max_orig_w = max(p.shape[1] for p in processed_images)
            t_h = ((max_orig_h + align - 1) // align) * align if align > 1 else max_orig_h
            t_w = ((max_orig_w + align - 1) // align) * align if align > 1 else max_orig_w
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
        # 纯 align 模式
        target_h = max(nd[0] for nd in new_dims)
        target_w = max(nd[1] for nd in new_dims)
        if align > 1:
            target_h = ((target_h + align - 1) // align) * align
            target_w = ((target_w + align - 1) // align) * align

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
