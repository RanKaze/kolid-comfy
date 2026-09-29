import io
import base64
import math
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

def align_alpha_channels(image_a, image_b):
    """RGB(3 通道) 与 RGBA(4 通道) 混用时，把通道数少的一方补出不透明的 alpha(=1.0)。

    QwenImage21 等带 alpha 的 VAE 会解码出 4 通道图，与图库里原有的 3 通道图
    （背景/mask 预览等）做逐元素运算前需要先对齐通道。通道数差不是 1 时原样返回，
    由调用方自己的 shape 校验报错。
    """
    channels_a = image_a.shape[-1]
    channels_b = image_b.shape[-1]
    if channels_a == channels_b:
        return image_a, image_b
    if channels_a + 1 == channels_b:
        image_a = torch.cat([image_a, torch.ones_like(image_a[..., :1])], dim=-1)
    elif channels_b + 1 == channels_a:
        image_b = torch.cat([image_b, torch.ones_like(image_b[..., :1])], dim=-1)
    return image_a, image_b


def flatten_alpha_on_white(image):
    """RGBA -> RGB，透明区域按白底合成（与模型的 vision 侧一致）。非 4 通道原样返回。"""
    if image is None or image.shape[-1] != 4:
        return image
    rgb = image[..., :3]
    alpha = image[..., 3:]
    return rgb * alpha + (1.0 - alpha)


def ensure_rgba(image):
    """3 通道补不透明 alpha 得到 4 通道；已是 4 通道原样返回。"""
    if image.shape[-1] == 4:
        return image
    return torch.cat([image, torch.ones_like(image[..., :1])], dim=-1)


def merge_mask_alpha(image, mask):
    """把 mask 合进 image 的 alpha 通道 → [B,H,W,4] 的「带透明度的产出」。

    「Recover Crop 关闭」的 detailer 产出就是这个形状：RGB 是 crop 工作区的产出像素，
    alpha 是同一工作区的 mask 覆盖率（`last_resized_mask`）。它对外只是一张普通的 RGBA
    图 —— 前端拿它当一个普通图层贴回原位，画布上的 alpha 合成天然等价于原来的
    recover_crop(mask_blend)，所以不需要再单独传一张 mask 图。

    image: [B,H,W,3]，或 [B,H,W,4]（4 通道时原 alpha 被 mask 顶替）
    mask:  [B,H,W] / [B,H,W,1] / [H,W]；None 表示全可见（等价 ensure_rgba）
          空间尺寸与 image 不一致时按双线性缩放到 image 尺寸。
    """
    if mask is None:
        return ensure_rgba(image)
    if image.dim() == 3:
        image = image.unsqueeze(0)
    if mask.dim() == 2:
        mask = mask.unsqueeze(0)
    if mask.dim() == 3:
        mask = mask.unsqueeze(-1)
    b, h, w = image.shape[0], image.shape[1], image.shape[2]
    mask = mask.to(device=image.device, dtype=image.dtype)
    if mask.shape[0] != b:
        # 单张 mask 服务整个 batch；反过来的情况（mask 比图多）不可表达，取第一张
        mask = mask[:1].expand(b, -1, -1, -1)
    if mask.shape[1] != h or mask.shape[2] != w:
        mask = F.interpolate(mask.permute(0, 3, 1, 2), size=(h, w),
                             mode='bilinear', align_corners=False).permute(0, 2, 3, 1)
    return torch.cat([image[..., :3], mask.clamp(0.0, 1.0)], dim=-1)


def warp_layer(image, transform, canvas_w, canvas_h):
    """把 [H,W,4] 图层按 transform 摆进 canvas_w x canvas_h 的画布。

    transform: {cx, cy, w, h, rotation}；cx/cy 为图层中心在画布中的归一化位置，
    w/h 为图层占画布的归一化宽高，rotation 为弧度（画布坐标系，y 向下，正值为视觉顺时针）。
    与前端 canvas 的 translate(cx*W, cy*H) → rotate(θ) → drawImage(居中, tw*W, th*H) 等价。

    采样前给源图 replicate 补 1 个像素的边：放大图层时最外一圈画布像素的 bilinear
    取样点会落到源图边界之外，不补边会掺进 padding 的 0，使图层边缘变成半透明
    （默认铺满画布时表现为画布四边发虚）。
    """
    if image.dim() == 3:
        image = image.unsqueeze(0)
    _, h, w, c = image.shape
    transform = transform or {}
    cx = float(transform.get('cx', 0.5)) * canvas_w
    cy = float(transform.get('cy', 0.5)) * canvas_h
    tw = max(float(transform.get('w', 1.0)) * canvas_w, 1e-3)
    th = max(float(transform.get('h', 1.0)) * canvas_h, 1e-3)
    rot = float(transform.get('rotation', 0.0))
    cos_r, sin_r = math.cos(rot), math.sin(rot)

    pad = 1
    pad_w, pad_h = w + 2 * pad, h + 2 * pad
    # 画布归一化坐标 → 补边后图层的归一化坐标（align_corners=False）
    theta = torch.tensor([[
        cos_r * canvas_w * w / (tw * pad_w), sin_r * canvas_h * w / (tw * pad_w),
        (cos_r * (canvas_w / 2 - cx) + sin_r * (canvas_h / 2 - cy)) * 2 * w / (tw * pad_w),
    ], [
        -sin_r * canvas_w * h / (th * pad_h), cos_r * canvas_h * h / (th * pad_h),
        (-sin_r * (canvas_w / 2 - cx) + cos_r * (canvas_h / 2 - cy)) * 2 * h / (th * pad_h),
    ]], dtype=image.dtype, device=image.device).unsqueeze(0)

    padded = F.pad(image.permute(0, 3, 1, 2), (pad, pad, pad, pad), mode='replicate')
    grid = F.affine_grid(theta, size=(1, c, canvas_h, canvas_w), align_corners=False)
    warped = F.grid_sample(padded, grid, mode='bilinear',
                           padding_mode='zeros', align_corners=False)
    return warped.permute(0, 2, 3, 1)[0]


def decode_mask_alpha(mask_data_url, width, height, collapse_opaque=True):
    """前端蒙版 PNG（alpha 通道 = 覆盖率）→ [1,H,W,1] float 张量。

    width/height 为目标尺寸（蒙版按目标空间生效，会缩放到该尺寸）。

    `collapse_opaque` 区分两种调用场景，语义完全相反，**不要混用**：

    - `True`（默认，用于**图层自带的 mask**）：全不透明 → 返回 None，
      因为"整张都可见"和"没有蒙版"对图层来说是同一件事。
    - `False`（用于**画布顶层的纯 Mask 层**）：全不透明 → 返回全 1 张量。
      这一层没有"没有蒙版"这种状态 —— 全白正是用户点 `Full`（或把整块画布
      涂满）想要的结果。折叠成 None 会让调用方以为"用户什么都没画"，
      于是弹出 "Mask is required"，而屏幕上明明画满了。
    """
    if not mask_data_url or not isinstance(mask_data_url, str):
        return None
    try:
        raw = mask_data_url.split(',', 1)[1] if ',' in mask_data_url else mask_data_url
        img = Image.open(io.BytesIO(base64.b64decode(raw)))
        if img.mode != 'RGBA':
            img = img.convert('RGBA')
        alpha = np.array(img)[..., 3].astype(np.float32) / 255.0
        tensor = torch.from_numpy(alpha).unsqueeze(0).unsqueeze(-1)  # [1,h,w,1]
        if tensor.shape[1] != height or tensor.shape[2] != width:
            tensor = F.interpolate(tensor.permute(0, 3, 1, 2), size=(height, width),
                                   mode='bilinear', align_corners=False).permute(0, 2, 3, 1)
        tensor = tensor.clamp(0.0, 1.0)
        if collapse_opaque and float(tensor.min()) >= 1.0 - 1e-4:
            return None
        return tensor
    except Exception as e:
        print(f"[BlendLayers] mask decode failed: {e}")
        return None


def decode_decal_rgba(decal_data_url, width, height):
    """前端 decal PNG → [1,H,W,4] float 张量（直通 alpha，未预乘）。

    width/height 为目标图层尺寸（decal 与图层原图同空间，会缩放到该尺寸）。
    返回 None 表示"无 decal/完全透明"（空串、解码失败或 alpha 全 0）。
    """
    if not decal_data_url or not isinstance(decal_data_url, str):
        return None
    try:
        raw = decal_data_url.split(',', 1)[1] if ',' in decal_data_url else decal_data_url
        img = Image.open(io.BytesIO(base64.b64decode(raw)))
        if img.mode != 'RGBA':
            img = img.convert('RGBA')
        arr = np.array(img).astype(np.float32) / 255.0
        tensor = torch.from_numpy(arr).unsqueeze(0)  # [1,h,w,4]
        if tensor.shape[1] != height or tensor.shape[2] != width:
            tensor = F.interpolate(tensor.permute(0, 3, 1, 2), size=(height, width),
                                   mode='bilinear', align_corners=False).permute(0, 2, 3, 1)
        tensor = tensor.clamp(0.0, 1.0)
        if float(tensor[..., 3].max()) <= 1e-4:
            return None
        return tensor
    except Exception as e:
        print(f"[BlendLayers] decal decode failed: {e}")
        return None


def decode_image_dataurl(image_data_url):
    """前端拖入的本地图片 data URL → [H,W,4] float 直通 alpha 张量。

    这类图层没有 history key，像素由前端直接带过来，所以按前端画布的
    RGBA 语义解码（保留透明像素），失败返回 None。
    """
    if not image_data_url or not isinstance(image_data_url, str):
        return None
    try:
        raw = image_data_url.split(',', 1)[1] if ',' in image_data_url else image_data_url
        img = Image.open(io.BytesIO(base64.b64decode(raw)))
        if img.mode != 'RGBA':
            img = img.convert('RGBA')
        arr = np.array(img).astype(np.float32) / 255.0
        return torch.from_numpy(arr)  # [H,W,4]
    except Exception as e:
        print(f"[BlendLayers] layer image decode failed: {e}")
        return None


def composite_layers(layers, canvas_w, canvas_h):
    """自下而上合成图层，返回 [1,H,W,C]。

    layers: [{'image': [H,W,C] float, 'transform': {...}|None, 'attrs': [{'type','image'}],
              'visible': bool}]
    `attrs` 是前端图层条带上**归后端重放的那一段**,按列表顺序逐个生效 (与画布同源的同一条规矩:
    从左到右 = 先应用的在前)。`decal` 用 source-over 叠在当前图之上,`mask` 把当前图裁掉;
    所以 `[decal, mask]` 与 `[mask, decal]` 是两张不同的图 —— 贴片在蒙版右边就不受蒙版裁切。
    特效链不会出现在这里: 只有 WebGL 跑得动,前端已经烘进 `image` 了 (见 blend_node 的 fxSplitForBackend)。
    旧负载 (只有 `mask`/`decal` 两个键) 仍按这个先后读: 那正是条带默认的那条 `Decal·Mask`。
    然后按 transform 采样（用预乘 alpha 避免缩放/旋转边缘出现黑边），最后 source-over 叠加。
    结果全部不透明时返回 3 通道，否则返回 4 通道。

    ⚠️ 返回值是**预乘 alpha**（`rgb` 已经乘过自己的 `alpha`），不是直通 alpha —— 
    这是刻意的：整个栈都在预乘空间里做 source-over，插值/叠加在预乘空间才无黑边。
    注意：管线侧（VAE、打标、vision 塔等）约定的是**直通 alpha**，所以
    `compose_blend` 在把结果交给它们之前会做一次 premul→straight 逆转；
    直接调用本函数的消费方必须自己按预乘语义读。
    只有「全部不透明」（`alpha == 1`）时两者等价，此时直接返回 3 通道 RGB。

    **不要**在这里除以 alpha 得到「直通 RGBA」。那是以前的写法，也是「蒙版覆盖率
    不为 0/1 的地方发灰」的根因：`out_pm` 已经是整个栈合成后的**预乘**结果，而
    `out_a` 是**栈的**不透明度、不是 `out_pm` 自己的透明度；拿前者除后者会把颜色
    按 `1/out_a` 放大（两层各 50% 覆盖时纯红叠纯蓝被放大成 [0.33,0,0.67]，
    正确值应是 [0.25,0,0.5]），下游再乘一次 alpha → 颜色被拉向灰。alpha 越低越灰，
    所以「多层 + 蒙版遮蔽」时最明显。
    """
    canvas_w, canvas_h = max(int(canvas_w), 1), max(int(canvas_h), 1)
    dtype = layers[0]['image'].dtype if layers else torch.float32
    out_pm = torch.zeros(1, canvas_h, canvas_w, 3, dtype=dtype)
    out_a = torch.zeros(1, canvas_h, canvas_w, 1, dtype=dtype)

    for layer in layers:
        if not layer.get('visible', True):
            continue
        image = ensure_rgba(layer['image'])
        if image.dim() == 3:
            image = image.unsqueeze(0)
        attrs = layer.get('attrs')
        if attrs is None:
            attrs = [{'type': 'decal', 'image': layer.get('decal')},
                     {'type': 'mask', 'image': layer.get('mask')}]
        for attr in attrs:
            a = attr.get('image')
            if a is None:
                continue
            if attr.get('type') == 'mask':
                image = image * a
                continue
            if attr.get('type') != 'decal':
                # 链类 attribute 只有 WebGL 跑得动,前端烘完才发,永远不会跨这条边界;认不出的类型
                # 就当没这一步,绝不当成贴片盖一下 —— 那会把一句描述画成一块墨。
                continue
            # 直通 alpha 的 source-over。旧公式 rgb' = d_rgb*d_a + dst_rgb*(1-d_a)
            # 只在 dst 不透明时等价；dst 透明（空白图层/透明 PNG 区域）时 decal
            # 颜色会被按 d_a 再压暗一次（软边发暗）。out_rgb 分母是 out_a，
            # 两者都透明时分子为 0，clamp 后安全。
            d_a = a[..., 3:4]
            dst_a = image[..., 3:4]
            # 注意别叫 out_a —— 那是下面的画布 alpha 累加器，遮蔽会把 decal alpha
            # 错当成已合成结果参与 source-over。
            blend_a = d_a + dst_a * (1.0 - d_a)
            blend_rgb = (a[..., :3] * d_a + image[..., :3] * dst_a * (1.0 - d_a)) / blend_a.clamp_min(1e-6)
            image = torch.cat([blend_rgb, blend_a], dim=-1)
        premultiplied = torch.cat([image[..., :3] * image[..., 3:4], image[..., 3:4]], dim=-1)
        warped = warp_layer(premultiplied, layer.get('transform'), canvas_w, canvas_h)
        rgb, alpha = warped[..., :3], warped[..., 3:4]
        out_pm = rgb + out_pm * (1.0 - alpha)
        out_a = alpha + out_a * (1.0 - alpha)
        out_pm = out_pm.clamp(0.0, 1.0)
        out_a = out_a.clamp(0.0, 1.0)

    if float(out_a.min()) >= 1.0 - 1e-4:
        # Fully opaque everywhere: premultiplied == straight, so hand back plain RGB.
        return out_pm.clamp(0.0, 1.0)
    # Keep the premultiplied colour. Dividing by out_a here would inflate it by
    # 1/out_a and make every semi-covered pixel read as grey once a consumer
    # multiplies by alpha again (the old behaviour — see the docstring).
    return torch.cat([out_pm, out_a], dim=-1).clamp(0.0, 1.0)


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
        # 必须"阻塞"搬运：mask 常来自 GPU（expand_mask 会把 mask 放到 cuda），
        # 而非阻塞的 D2H 拷贝返回时 CPU 侧数据可能尚未落地，紧接着做的
        # bbox 统计会读到还没写入的 0 → 裁剪框算错（Full 遮罩被裁掉一部分，
        # 表现为 debug 里 Mask 尺寸小于 Background）。这里去掉 non_blocking。
        device = image.device
        if mask.device != device:
            mask = mask.to(device)

        print(f"[crop_mask] {W}x{H} | reserve={reserve} | batch={B} | device={device}")

        # ------------------- 向量化计算 bounding box -------------------
        m = mask.unsqueeze(1).float()

        row_sum = m.sum(dim=(1, 3))
        col_sum = m.sum(dim=(1, 2))

        def get_bounds(proj):
            # 无效位置用哨兵填充：min 用 n（比任何合法下标都大），max 用 -1。
            # 注意不能共用固定的 H+1：列方向的合法下标可到 W-1，当 W-1 > H+1 时
            # 哨兵会被 min 当成真正的最小列号（例如只有右侧有内容的 mask）。
            n = proj.shape[1]
            valid = proj > 0
            indices = torch.arange(n, device=proj.device, dtype=torch.long).unsqueeze(0).expand_as(proj)
            min_idx = torch.where(valid, indices, torch.full_like(indices, n))
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

                print(f"[DIAG] crop_mask bbox: x1={x1} y1={y1} x2={x2} y2={y2} crop_w={x2-x1} crop_h={y2-y1} image={W}x{H} mask_sum={mask[i].sum().item():.1f}")

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

        # QwenImage21 等 alpha VAE 解码出 4 通道，背景可能是 3 通道：先对齐再加权混合
        background, image = align_alpha_channels(background, image)

        B, H, W, C = image.shape

        # ==================== 仅保留一行 print ====================
        print(f"[recover_crop] {W}x{H} → {ow}x{oh} | method={recover_method}")

        # ==================== 统一设备 ====================
        # 同样必须是阻塞搬运：下面马上要用 mask/image 参与逐元素运算与切片赋值，
        # 非阻塞 D2H 会让这些读取拿到未落地的数据。
        device = background.device
        if image.device != device:
            image = image.to(device)
        if mask is not None and mask.device != device:
            mask = mask.to(device)

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


_GPU_CHUNK_BUDGET = 1024 * 1024 * 1024


def _interpolate_chunked(src, dst, new_h, new_w, antialias, device):
    """Resize [B,C,H,W] -> [B,C,new_h,new_w] in chunks into dst.

    - GPU (CUDA) path uses a double-buffered pinned-memory pipeline so PCIe
      upload, interpolation and download OVERLAP instead of serializing
    - CPU / non-CUDA path falls back to plain chunked interpolation
    - antialias is caller-controlled (only meaningful when downscaling)
    """
    B, C, H, W = src.shape
    kwargs = dict(size=(new_h, new_w), mode='bicubic', align_corners=False, antialias=antialias)
    bytes_per_frame = (H * W + new_h * new_w) * C * src.element_size()
    chunk = max(1, int(_GPU_CHUNK_BUDGET // max(1, bytes_per_frame * 3)))

    if device is None or not (isinstance(device, torch.device) and device.type == 'cuda'):
        for i in range(0, B, chunk):
            j = min(i + chunk, B)
            dst[i:j].copy_(F.interpolate(src[i:j].contiguous(), **kwargs))
        return

    if chunk >= B:
        # Whole batch fits: single upload/interpolate/download
        x = src.contiguous().to(device, non_blocking=True)
        # D2H 必须阻塞：dst 是调用方马上要读的 CPU 张量，异步拷贝会让调用方
        # 读到未写完的缓冲（表现为图片出现整块黑/缺失区域）。
        dst.copy_(F.interpolate(x, **kwargs))
        return

    # Double-buffered pipeline: while the GPU interpolates/downloads chunk k,
    # the CPU stages chunk k+1 into the other pinned buffer.
    staging_in = [torch.empty((chunk, C, H, W), dtype=src.dtype, pin_memory=True)
                  for _ in range(2)]
    staging_out = [torch.empty((chunk, C, new_h, new_w), dtype=src.dtype, pin_memory=True)
                   for _ in range(2)]
    events_out = [torch.cuda.Event() for _ in range(2)]
    pending = {}

    def _collect(b):
        if b in pending:
            i0, m0 = pending.pop(b)
            events_out[b].synchronize()
            dst[i0:i0 + m0].copy_(staging_out[b][:m0])

    for idx, i in enumerate(range(0, B, chunk)):
        j = min(i + chunk, B)
        m = j - i
        b = idx % 2
        if b in pending:
            # GPU finished reading this buffer (d2h completed => h2d completed)
            _collect(b)
        staging_in[b][:m].copy_(src[i:j])
        x = staging_in[b][:m].to(device, non_blocking=True)
        y = F.interpolate(x, **kwargs)
        staging_out[b][:m].copy_(y, non_blocking=True)
        events_out[b].record()
        pending[b] = (i, m)
    for b in range(2):
        _collect(b)


def limit_pixels(image, pixels=None, mask=None, align=1, cap_only=False):
    """
    Limit image pixel count by resizing if needed, with optional dimension alignment.

    pixels=None：不设定像素目标，仅把尺寸就近落 align 格（Qwen2.1 预处理在
    Enable Limit 关时走这条）；无需变化时原样返回且 resize_info=None。

    cap_only=True：pixels 是**上限**而不是目标 —— 只允许缩小，永不放大，落格一律
    向下取整。用于输入侧显存封顶（ref image / generate text 图），此时没有
    recover 需求，所以预算内直接原样返回 resize_info=None。
    """
    try:
        B, H, W, C = image.shape
        current_pixels = H * W

        # ==================== 仅保留这一行 print ====================
        print(f"[limit_pixels] {W}x{H} ({current_pixels:,} px) → "
              + ("ceiling " if cap_only else "target ")
              + (f"{pixels:,} px" if pixels else "none (align-snap only)")
              + f" | align={align} cap_only={cap_only}")

        # ---------- cap_only：上限语义分支（只缩不涨）----------
        # pixels 是天花板而不是目标：预算内不缩放，只把宽高**向下**落 align 格；
        # 超预算才按原比例缩小到格内。输出宽高恒 ≤ 输入，所以调用方不需要
        # recover_size（resize_info 在无变化时为 None）。
        if cap_only:
            step = align if align and align > 1 else 1
            aspect_ratio = W / H if H != 0 else 1.0
            if pixels and current_pixels > pixels:
                ideal_width = (pixels * aspect_ratio) ** 0.5
                ideal_height = ideal_width / aspect_ratio
                new_width = max(step, int(ideal_width // step) * step)
                new_height = max(step, int(ideal_height // step) * step)
                while new_width * new_height > pixels:
                    new_width = max(step, new_width - step)
                    new_height = max(step, new_height - step)
            else:
                new_width = max(step, (W // step) * step)
                new_height = max(step, (H // step) * step)
            # 兜底：小图（任一边 < align）不得被凑格放大
            new_width = min(new_width, W)
            new_height = min(new_height, H)
            if new_width == W and new_height == H:
                print(f"[limit_pixels] {W}x{H} under the ceiling and on the "
                      f"{align}-grid — untouched")
                return (image, mask, None)
            ideal_width, ideal_height = float(new_width), float(new_height)
            was_upscaled = False
            need_antialias = True
        # 仅落格模式：像素数不设目标，只把宽高就近吸附到 align 格。
        elif pixels is None:
            step = align if align and align > 1 else 1
            new_width = max(step, round(W / step) * step)
            new_height = max(step, round(H / step) * step)
            if new_width == W and new_height == H:
                print(f"[limit_pixels] {W}x{H} already on the {align}-grid — untouched")
                return (image, mask, None)
            ideal_width, ideal_height = float(new_width), float(new_height)
            aspect_ratio = W / H if H != 0 else 1.0
            was_upscaled = new_width * new_height > current_pixels
            need_antialias = new_height < H
        else:
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

            ideal_width, ideal_height = float(new_width), float(new_height)
            was_upscaled = current_pixels < pixels
            # ---------- antialias 仅缩小时启用 ----------
            # antialias bicubic 在 CPU 上极慢；放大时 antialias 无意义，直接跳过
            need_antialias = current_pixels > pixels

        device = image.device
        try:
            import comfy.model_management as mm
            gpu = mm.get_torch_device()
            if gpu is not None and gpu.type != "cpu":
                device = gpu
        except Exception:
            if torch.cuda.is_available():
                device = torch.device("cuda")
        print(f"[limit_pixels] device={device}, antialias={need_antialias}, batch={B}")

        src = image.permute(0, 3, 1, 2)                              # [B, C, H, W] 视图，不拷贝
        resized_image = torch.empty((B, new_height, new_width, C),
                                    dtype=image.dtype, device=image.device)
        dst = resized_image.permute(0, 3, 1, 2)                      # [B, C, newH, newW] 视图

        _interpolate_chunked(src, dst, new_height, new_width, need_antialias, device)

        # ---------- 处理 mask ----------
        resized_mask = mask
        if mask is not None:
            mask_tensor = mask.unsqueeze(1)                          # [B, 1, H, W]
            mask_dst = torch.empty((mask_tensor.shape[0], 1, new_height, new_width),
                                   dtype=mask_tensor.dtype, device=mask_tensor.device)
            _interpolate_chunked(mask_tensor, mask_dst, new_height, new_width, need_antialias, device)
            resized_mask = mask_dst.squeeze(1).clamp(0.0, 1.0)

        # 创建 resize_info
        resize_info = {
            "original_width": W,
            "original_height": H,
            "resized_width": new_width,
            "resized_height": new_height,
            "aspect_ratio": aspect_ratio,
            "scale_factor": new_width / W,
            "align": align,
            "was_upscaled": was_upscaled
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
        # 阻塞搬运：mask 会被直接 return 给调用方并立即参与后续运算，
        # 非阻塞 D2H 会让调用方读到尚未落地的数据。
        device = image.device
        if mask is not None and mask.device != device:
            mask = mask.to(device)

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
    """Convert an image tensor [B,H,W,C] or [1,H,W,C] to a base64 data URL.

    4 通道 (RGBA) 走 PNG 以保留 alpha；否则走 JPEG。
    """
    img_array = (image_tensor.squeeze(0).cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
    if img_array.ndim == 3 and img_array.shape[-1] == 4:
        buf = io.BytesIO()
        Image.fromarray(img_array).save(buf, format='PNG')
        b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
        return f"data:image/png;base64,{b64}"
    if img_array.ndim == 3 and img_array.shape[-1] > 3:
        img_array = img_array[..., :3]
    img = Image.fromarray(img_array)
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

    # RGB 与 RGBA 混用时把少的一方补出不透明 alpha，避免因为通道数不同直接报错
    if img0.shape[-1] + 1 == img1.shape[-1]:
        img0 = np.concatenate([img0, np.ones_like(img0[..., :1])], axis=-1)
    elif img1.shape[-1] + 1 == img0.shape[-1]:
        img1 = np.concatenate([img1, np.ones_like(img1[..., :1])], axis=-1)

    # 检查尺寸是否一致
    if img0.shape != img1.shape:
        raise ValueError(f"Two images must have the same shape. Got {img0.shape} and {img1.shape}")

    # 合并成 batch: (2, H, W, C)
    batched = np.stack([img0, img1], axis=0)

    # 转成 torch.Tensor
    tensor = torch.from_numpy(batched).float().contiguous()

    return tensor