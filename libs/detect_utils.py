import numpy as np
import torch
from collections import namedtuple
import torchvision.transforms.functional as F
from PIL import Image, ImageDraw
import comfy.model_management as mm

def detect_mask(detector, image, threshold=0.5, dilation=4,
                crop_factor=1.5, drop_size=0, prompt="",
                # 暴露的参数
                max_new_tokens=512,
                num_beams=3,
                do_sample=False,
                fill_mask=True):
    """
    Florence-2 detect_mask - 最终干净版
    支持 fill_mask 参数（参考 Florence2Run 逻辑）
    """
    if isinstance(detector, dict) and all(k in detector for k in ("model", "processor", "dtype")):
        # Florence-2 分支
        florence_model = detector
        model = florence_model['model']
        processor = florence_model['processor']
        dtype = florence_model['dtype']

        # 使用 ComfyUI 设备管理（优先 GPU）
        device = mm.get_torch_device()

        # 移动模型到 GPU（仅在需要时）
        if next(model.parameters()).device != device:
            model = model.to(device)

        # 任务选择
        if prompt and prompt.strip():
            task_prompt = '<REFERRING_EXPRESSION_SEGMENTATION>'
            full_prompt = task_prompt + " " + prompt.strip()
        else:
            task_prompt = '<DENSE_REGION_CAPTION>'
            full_prompt = task_prompt

        # 记录原始图像尺寸（保证 Mask 尺寸正确）
        if len(image.shape) == 4:                    # [B, H, W, C]
            B, H_orig, W_orig, C = image.shape
            img_for_processor = image[0].permute(2, 0, 1)
        else:
            H_orig, W_orig, C = image.shape
            img_for_processor = image.permute(2, 0, 1)

        # 为 processor 准备图像（轻度 resize 加速，不影响最终 mask）
        img_processor = img_for_processor
        if max(H_orig, W_orig) > 1024:
            img_processor = F.resize(img_processor, 768, interpolation=F.InterpolationMode.BICUBIC)

        image_pil = F.to_pil_image(img_processor.cpu())

        # processor 输入
        inputs = processor(
            text=full_prompt,
            images=image_pil,
            return_tensors="pt",
            do_rescale=False
        ).to(dtype).to(device)

        # 生成
        with torch.no_grad():
            generated_ids = model.generate(
                input_ids=inputs["input_ids"],
                pixel_values=inputs["pixel_values"],
                max_new_tokens=max_new_tokens,
                do_sample=do_sample,
                num_beams=num_beams,
                use_cache=True,
                early_stopping=True,
            )

        generated_text = processor.batch_decode(generated_ids, skip_special_tokens=False)[0]

        # 后处理 - 使用原始尺寸
        parsed_answer = processor.post_process_generation(
            generated_text, 
            task=task_prompt, 
            image_size=(W_orig, H_orig)
        )

        # ==================== 生成 Mask（核心：实现 fill_mask） ====================
        if fill_mask:
            # fill_mask=True → 填充白色（参考 Florence2Run 中的逻辑）
            mask_image = Image.new('L', (W_orig, H_orig), color=0)
            mask_draw = ImageDraw.Draw(mask_image)
            fill_value = 255
        else:
            # fill_mask=False → 只画轮廓（透明/黑色背景，只留边框）
            mask_image = Image.new('L', (W_orig, H_orig), color=0)
            mask_draw = ImageDraw.Draw(mask_image)
            fill_value = 0   # 不填充内部

        if task_prompt == '<REFERRING_EXPRESSION_SEGMENTATION>':
            predictions = parsed_answer.get(task_prompt, {})
            polygons_groups = predictions.get('polygons', [])

            for group in polygons_groups:
                for polygon in group:
                    try:
                        poly_np = np.array(polygon, dtype=np.float32).reshape(-1, 2)
                        poly_np = np.clip(poly_np, [0, 0], [W_orig-1, H_orig-1])
                        poly_list = poly_np.reshape(-1).tolist()
                        if len(poly_list) >= 6:
                            # fill_mask 决定是否填充
                            mask_draw.polygon(poly_list, outline=255, fill=fill_value)
                    except:
                        continue

        else:  # DENSE_REGION_CAPTION
            bboxes = parsed_answer.get(task_prompt, {}).get('bboxes', [])
            for bbox in bboxes:
                try:
                    x0, y0, x1, y1 = map(int, bbox)
                    x0, y0 = max(0, x0), max(0, y0)
                    x1, y1 = min(W_orig, x1), min(H_orig, y1)
                    if x1 - x0 > drop_size and y1 - y0 > drop_size:
                        # fill_mask 决定是否填充矩形
                        mask_draw.rectangle([x0, y0, x1, y1], fill=fill_value if fill_mask else 0)
                        if not fill_mask:
                            # 只画轮廓时额外绘制边框
                            mask_draw.rectangle([x0, y0, x1, y1], outline=255, width=2)
                except:
                    continue

        # 转为 ComfyUI Mask 格式 [1, H, W]
        mask_tensor = F.to_tensor(mask_image).float()

        # 膨胀处理（无论 fill_mask 如何，都对最终 mask 进行膨胀）
        if dilation > 0:
            k = int(dilation * 2 + 1)
            mask_tensor = mask_tensor.unsqueeze(0)
            mask_tensor = torch.nn.functional.max_pool2d(
                mask_tensor, kernel_size=k, stride=1, padding=dilation
            )
            mask_tensor = mask_tensor.squeeze(0)

        return mask_tensor.contiguous().cpu()

    # 其他 detector（如 YOLO）兼容
    elif hasattr(detector, "detect_combined"):
        mask = detector.detect_combined(image, threshold, dilation)
        if mask is None:
            return None
        return mask.unsqueeze(0) if mask.dim() == 2 else mask

    raise ValueError(f"不支持的 detector 类型: {type(detector)}")

SEG = namedtuple("SEG",
    ['cropped_image', 'cropped_mask', 'confidence', 'crop_region', 'bbox', 'label', 'control_net_wrapper'],
    defaults=[None])

def segs_to_combined_mask(segs):
    shape = segs[0]
    h = shape[0]
    w = shape[1]

    mask = np.zeros((h, w), dtype=np.uint8)

    for seg in segs[1]:
        cropped_mask = seg.cropped_mask
        crop_region = seg.crop_region
        mask[crop_region[1]:crop_region[3], crop_region[0]:crop_region[2]] |= (cropped_mask * 255).astype(np.uint8)

    return torch.from_numpy(mask.astype(np.float32) / 255.0)


def segs_to_masklist(segs):
    shape = segs[0]
    h = shape[0]
    w = shape[1]

    masks = []
    for seg in segs[1]:
        if isinstance(seg.cropped_mask, np.ndarray):
            cropped_mask = torch.from_numpy(seg.cropped_mask)
        else:
            cropped_mask = seg.cropped_mask

        if cropped_mask.ndim == 2:
            cropped_mask = cropped_mask.unsqueeze(0)

        n = len(cropped_mask)

        mask = torch.zeros((n, h, w), dtype=torch.uint8)
        crop_region = seg.crop_region
        mask[:, crop_region[1]:crop_region[3], crop_region[0]:crop_region[2]] |= (cropped_mask * 255).to(torch.uint8)
        mask = (mask / 255.0).to(torch.float32)

        for x in mask:
            masks.append(x)

    if len(masks) == 0:
        empty_mask = torch.zeros((h, w), dtype=torch.float32, device="cpu")
        masks = [empty_mask]

    return masks

def dilate_segs(segs, factor):
    if factor == 0:
        return segs

    new_segs = []
    for seg in segs[1]:
        new_mask = dilate_mask(seg.cropped_mask, factor)
        new_seg = SEG(seg.cropped_image, new_mask, seg.confidence, seg.crop_region, seg.bbox, seg.label, seg.control_net_wrapper)
        new_segs.append(new_seg)

    return (segs[0], new_segs)