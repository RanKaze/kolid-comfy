import comfy.model_management as mm
import torch
import torchvision.transforms.functional as F
import re

def get_similarity(similarity_model, image0, image1):
    if hasattr(similarity_model, "check"):
        return similarity_model.check(image0, image1)
    raise ValueError("similarity_model 必须实现 check 方法")

def get_tag(tagger, image, sep=", "):
    """
    使用 Florence-2 模型对图像进行打标 (Tagging)。
    严格遵循 ComfyUI 的模型管理和设备调度逻辑。
    
    Args:
        tagger (dict): ComfyUI Florence2Run 节点传入的模型字典。
                       包含 'model', 'processor', 'dtype'。
        image (torch.Tensor): ComfyUI 图像张量，形状 [H, W, C]。
        sep (str): 标签分隔符。

    Returns:
        str: 生成的标签字符串。
    """
    if isinstance(tagger, dict) and all(k in tagger for k in ("model", "processor", "dtype")):
        model = tagger['model']
        processor = tagger['processor']
        dtype = tagger['dtype']
        
        # 1. 设备管理
        device = mm.get_torch_device()
        offload_device = mm.unet_offload_device()
        model.to(device)

        try:
            # 2. 维度兼容处理 (修复之前的报错)
            # 如果是 4D [B,H,W,C]，取第一张；如果是 3D [H,W,C]，直接使用
            if image.dim() == 4:
                single_image = image[0]
            elif image.dim() == 3:
                single_image = image
            else:
                raise ValueError(f"Unsupported image dimensions: {image.dim()}")
                
            # 转换为 PIL Image
            image_pil = F.to_pil_image(single_image.permute(2, 0, 1).float())

            # 3. 关键修改：使用 <DETAILED_CAPTION> 任务
            # 这会让模型生成一段连贯的句子，而不是标签列表或坐标框
            prompt = "<DETAILED_CAPTION>"
            
            inputs = processor(
                text=prompt, 
                images=image_pil, 
                return_tensors="pt", 
                do_rescale=False
            ).to(dtype).to(device)

            # 4. 推理
            generated_ids = model.generate(
                input_ids=inputs["input_ids"],
                pixel_values=inputs["pixel_values"],
                max_new_tokens=1024,      # 详细描述需要更多 token
                do_sample=False,
                num_beams=1,
                use_cache=False
            )

            # 5. 解码与清洗
            # 注意：skip_special_tokens=True 可以自动去除 <s> 和 </s>
            results = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
            
            # 去除任务头 <DETAILED_CAPTION>
            # 结果通常格式为: "<DETAILED_CAPTION>A girl..."
            clean_results = results.replace(prompt, "").strip()
            
            return clean_results

        finally:
            # 6. 显存清理
            model.to(offload_device)
            mm.soft_empty_cache()
    elif hasattr(tagger, 'tag') and callable(getattr(tagger, 'tag')):
        return tagger.tag(image)
    raise ValueError("Invalid Florence2Run model dictionary")