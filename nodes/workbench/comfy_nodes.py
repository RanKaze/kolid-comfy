"""Pipeline 节点 → ComfyUI 节点类的适配层。

pipeline graph 里的几何节点不再自己实现像素处理：按目标 ComfyUI 节点的
`INPUT_TYPES` 组装参数、直接调用它的 `FUNCTION`、按 `RETURN_TYPES` 取回值。
pipeline 侧只留 exec/分支/逐帧几何栈的编排。

约定（都是"装配"而不是"另写一套算法"）：
  · 节点在 mask 缺省时返回的元数会变（fit/meet 有 mask 是 3 元、没有是 2 元），
    这里统一补齐成 (image, info, mask) / (image, mask)；
  · 节点要求 mask 与 image 同尺寸，送进去前先按 image 的 H/W 归一；
  · width/height = 0 在节点里是"零尺寸"，pipeline 的语义是"用当前尺寸"，
    所以在适配层把 0 解析成当前 W/H。
"""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

import torch
import torch.nn.functional as F

from ..image.fit_node import (
    ImageFitNode,
    ImageMeetNode,
    ImageRecoverFitNode,
    ImageRecoverMeetNode,
)
from ..image.image_node import ImageCropMaskNode, ImageRecoverCropNode


def _mask_for(image: torch.Tensor, mask: Optional[torch.Tensor]) -> Optional[torch.Tensor]:
    """把 mask 归一到与 image 同批同尺寸的 [B,H,W]（None 原样返回）。"""
    if mask is None:
        return None
    m = mask
    if m.dim() == 4:
        m = m[..., 0] if int(m.shape[-1]) == 1 else m.squeeze(1)
    elif m.dim() == 2:
        m = m.unsqueeze(0)
    if m.dim() != 3:
        m = m.reshape(int(m.shape[0]), int(m.shape[-2]), int(m.shape[-1]))
    b, h, w = int(image.shape[0]), int(image.shape[1]), int(image.shape[2])
    if int(m.shape[0]) != b:
        m = m[:1].expand(b, -1, -1) if int(m.shape[0]) == 1 else m[:b]
    if int(m.shape[1]) != h or int(m.shape[2]) != w:
        m = F.interpolate(m.unsqueeze(1), size=(h, w), mode='bilinear', align_corners=False).squeeze(1)
    return m.contiguous()


# ---------------------------------------------------------------------------
# Crop / Recover Crop —— ImageCropMaskNode / ImageRecoverCropNode
# ---------------------------------------------------------------------------

def crop(image: torch.Tensor, mask: torch.Tensor, reserve: int):
    """ImageCropMaskNode.crop_mask → (image, mask, crop_info)。"""
    return ImageCropMaskNode().crop_mask(image, _mask_for(image, mask), int(reserve))


def recover_crop(background: torch.Tensor, image: torch.Tensor,
                 crop_info: Dict[str, Any], recover_method: str,
                 mask: Optional[torch.Tensor] = None
                 ) -> Tuple[torch.Tensor, Optional[torch.Tensor]]:
    """ImageRecoverCropNode.recover → (image, mask)。

    该节点是 INPUT_IS_LIST 的（ComfyUI 会把每个入参包成列表传进来），
    这里按同样的形态调用：单张图 = 长度为 1 的列表。
    """
    node = ImageRecoverCropNode()
    out_img, out_mask = node.recover(
        [background], [image], [crop_info], [str(recover_method)],
        [_mask_for(image, mask)] if mask is not None else None)
    return out_img, out_mask


# ---------------------------------------------------------------------------
# Fit / Recover Fit —— ImageFitNode / ImageRecoverFitNode
# ---------------------------------------------------------------------------

def fit(image: torch.Tensor, mask: Optional[torch.Tensor], width: int, height: int,
        interpolation: str, padding_color: str):
    """ImageFitNode.fit → (image, fit_info, mask)。"""
    w = int(width or 0) or int(image.shape[2])
    h = int(height or 0) or int(image.shape[1])
    out = ImageFitNode().fit(image, w, h, str(interpolation), str(padding_color),
                             _mask_for(image, mask))
    img, info = out[0], out[1]
    m = out[2] if len(out) > 2 else None
    return img, info, m


def recover_fit(image: torch.Tensor, mask: Optional[torch.Tensor],
                fit_info: Dict[str, Any], interpolation: str
                ) -> Tuple[torch.Tensor, Optional[torch.Tensor]]:
    """ImageRecoverFitNode.recover_fit → (image, mask)。"""
    out = ImageRecoverFitNode().recover_fit(image, fit_info, str(interpolation),
                                            _mask_for(image, mask))
    return out[0], out[1]


# ---------------------------------------------------------------------------
# Meet / Recover Meet —— ImageMeetNode / ImageRecoverMeetNode
# ---------------------------------------------------------------------------

def meet(image: torch.Tensor, mask: Optional[torch.Tensor], width: int, height: int,
         interpolation: str):
    """ImageMeetNode.meet → (image, meet_info, mask)。"""
    w = int(width or 0) or int(image.shape[2])
    h = int(height or 0) or int(image.shape[1])
    out = ImageMeetNode().meet(image, w, h, str(interpolation), _mask_for(image, mask))
    img, info = out[0], out[1]
    m = out[2] if len(out) > 2 else None
    return img, info, m


def recover_meet(image: torch.Tensor, mask: Optional[torch.Tensor],
                 meet_info: Dict[str, Any], interpolation: str, padding_color: str,
                 background: Optional[torch.Tensor] = None
                 ) -> Tuple[torch.Tensor, Optional[torch.Tensor]]:
    """ImageRecoverMeetNode.recover_meet → (image, mask)。"""
    out = ImageRecoverMeetNode().recover_meet(
        image, meet_info, str(interpolation), str(padding_color),
        background, _mask_for(image, mask))
    return out[0], out[1]
