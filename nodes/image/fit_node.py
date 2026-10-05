import numpy as np
import time
import torch
import torch.nn.functional as F
import torchvision.transforms as T
import io
import base64
import random
import math
import os
import re
import json

class ImageFitNode:
    
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE",),
                "width": ("INT", {"default": 0, "min": 0, "max": 2048, "step": 8}),
                "height": ("INT", {"default": 0, "min": 0, "max": 2048, "step": 8}),
                "interpolation": (["nearest", "bilinear", "bicubic"], {"default": "bilinear"}),
                "padding_color": ("STRING", {"default": "255, 255, 255"}),
            },
            "optional": {
                "mask": ("MASK",),
            }
        }

    RETURN_TYPES = ("IMAGE", "FIT_INFO", "MASK",)
    RETURN_NAMES = ("Image", "FitInfo", "Mask",)
    FUNCTION = "fit"

    CATEGORY = "Kolid-Toolkit"

    def fit(self, image, width, height, interpolation, padding_color, mask=None): 
        img_batchSize, img_height, img_width, img_channelCount = image.size()     
        
        if ',' in padding_color:
            color_list = np.clip([int(channel) for channel in padding_color.split(',')], 0, 255) # RGB format
        else:
            padding_color = padding_color.lstrip('#')
            color_list = [int(padding_color[i:i+2], 16) for i in (0, 2, 4)] # Hex format
        
        if mask is not None:
            if len(mask.size())>3:
                mask = mask.squeeze(1)
            try:
                mask_batchSize, mask_height, mask_width = mask.size()
            except:
                raise ValueError(f"mask:{mask.size()} img:{image.size()}")
            if img_batchSize != mask_batchSize or img_height != mask_height or img_width != mask_width:
                raise ValueError(f"mask:{mask.size()} img:{image.size() }Mask的尺寸与image不同!")
        
        new_image = torch.zeros(
            (img_batchSize, height, width, img_channelCount),
            dtype=torch.float32,
        );
        
        new_image[:,:,:,0] = color_list[0] / 255
        new_image[:,:,:,1] = color_list[1] / 255
        new_image[:,:,:,2] = color_list[2] / 255
    
        if mask is not None:
            new_mask = torch.zeros(
                (mask_batchSize, height, width),
                dtype=torch.float32,
            )

        
        #把图片缩放到全部能够被放下
        heightRate = height / img_height
        widthRate = width / img_width

        if heightRate < widthRate:
            target_height = height
            target_width = (int)(img_width * heightRate)
            paddingWidth = True
        else:
            target_height = (int)(img_height * widthRate)
            target_width = width
            paddingWidth = False
            
        
        tmp_img = F.interpolate(
            image.permute(0, 3, 1, 2),#BHWC=>BCHW
            size=(target_height, target_width),  # 目标高度和宽度
            mode=interpolation,    # 插值模式
            align_corners=False if interpolation != "nearest" else None
        ).permute(0, 2, 3, 1)

        if mask is not None:
            mask = mask.unsqueeze(1)
            tmp_mask = F.interpolate(
                mask,
                size=(target_height, target_width),  # 目标高度和宽度
                mode=interpolation,    # 插值模式
                align_corners=False if interpolation != "nearest" else None
            )
            tmp_mask = tmp_mask.squeeze(1)

        #看一下需要padding宽还是高.
        if paddingWidth:
            remain = width - target_width
            offset = (int)(remain / 2)
            new_image[:, :, offset:offset + target_width, :] = tmp_img
            if mask is not None:
                new_mask[:, :, offset:offset + target_width] = tmp_mask
        else:
            remain = height - target_height
            offset = (int)(remain / 2)
            new_image[:, offset:offset + target_height, :, :] = tmp_img
            if mask is not None:
                new_mask[:, offset:offset + target_height, :] = tmp_mask

        fit_Info = {
            "x" : offset if paddingWidth else 0,
            "y" : 0 if paddingWidth else offset,
            "originalWidth" :  img_width,
            "originalHeight" : img_height,
            "targetWidth" : target_width,
            "targetHeight" : target_height
        }

        if mask is not None:
            return (new_image, fit_Info, new_mask,)
        return (new_image, fit_Info)
        

class ImageRecoverFitNode:
    
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE",),
                "fitInfo": ("FIT_INFO",),
                "interpolation": (["nearest", "bilinear", "bicubic"], {"default": "bilinear"}),
            },
            "optional": {
                "mask": ("MASK",),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("Image", "Mask")
    FUNCTION = "recover_fit"

    CATEGORY = "Kolid-Toolkit"

    def recover_fit(self, image, fitInfo, interpolation, mask=None): 
        img_batchSize, img_height, img_width, img_channelCount = image.size()     
        
        if mask is not None:
            if len(mask.size())>3:
                mask = mask.squeeze(1)
            try:
                mask_batchSize, mask_height, mask_width = mask.size()
            except:
                raise ValueError(f"mask:{mask.size()} img:{image.size()}")
            if img_batchSize != mask_batchSize or img_height != mask_height or img_width != mask_width:
                raise ValueError(f"mask:{mask.size()} img:{image.size()}Mask的尺寸与image不同!")
        
        targetWidth = fitInfo["targetWidth"]
        targetHeight = fitInfo["targetHeight"]
        
        originalWidth = fitInfo["originalWidth"]
        originalHeight = fitInfo["originalHeight"]
        
        x = fitInfo["x"]
        y = fitInfo["y"]
        
        tmp_img = image[:,y:y+targetHeight,x:x+targetWidth,:]
        if(mask is not None):
            tmp_mask = mask[:,y:y+targetHeight,x:x+targetWidth]
        
        new_image = F.interpolate(
            tmp_img.permute(0, 3, 1, 2),#BHWC=>BCHW
            size=(originalHeight, originalWidth),  # 目标高度和宽度
            mode=interpolation,    # 插值模式
            align_corners=False if interpolation != "nearest" else None
        ).permute(0, 2, 3, 1)

        if mask is not None:
            tmp_mask = tmp_mask.unsqueeze(1)
            new_mask = F.interpolate(
                tmp_mask,
                size=(originalHeight, originalWidth),  # 目标高度和宽度
                mode=interpolation,    # 插值模式
                align_corners=False if interpolation != "nearest" else None
            )
            new_mask = new_mask.squeeze(1)
        
        if mask is not None:
            return (new_image, new_mask,)
        return (new_image,)


class ImageMeetNode:
    
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE",),
                "width": ("INT", {"default": 0, "min": 0, "max": 2048, "step": 8}),
                "height": ("INT", {"default": 0, "min": 0, "max": 2048, "step": 8}),
                "interpolation": (["nearest", "bilinear", "bicubic"], {"default": "bilinear"}),
            },
            "optional": {
                "mask": ("MASK",),
            }
        }

    RETURN_TYPES = ("IMAGE", "MEET_INFO", "MASK",)
    RETURN_NAMES = ("Image", "MeetInfo", "Mask",)
    FUNCTION = "meet"

    CATEGORY = "Kolid-Toolkit"

    def meet(self, image, width, height, interpolation, mask=None): 
        img_batchSize, img_height, img_width, img_channelCount = image.size()     
        
        if mask is not None:
            if len(mask.size())>3:
                mask = mask.squeeze(1)
            try:
                mask_batchSize, mask_height, mask_width = mask.size()
            except:
                raise ValueError(f"mask:{mask.size()} img:{image.size()}")
            if img_batchSize != mask_batchSize or img_height != mask_height or img_width != mask_width:
                raise ValueError(f"mask:{mask.size()} img:{image.size()}Mask的尺寸与image不同!")
        
        #把图片等比缩放到完全覆盖画布(允许超出)
        heightRate = height / img_height
        widthRate = width / img_width
        rate = max(widthRate, heightRate)

        target_width = (int)(img_width * rate)
        target_height = (int)(img_height * rate)
            
        tmp_img = F.interpolate(
            image.permute(0, 3, 1, 2),#BHWC=>BCHW
            size=(target_height, target_width),  # 目标高度和宽度
            mode=interpolation,    # 插值模式
            align_corners=False if interpolation != "nearest" else None
        ).permute(0, 2, 3, 1)

        if mask is not None:
            mask = mask.unsqueeze(1)
            tmp_mask = F.interpolate(
                mask,
                size=(target_height, target_width),  # 目标高度和宽度
                mode=interpolation,    # 插值模式
                align_corners=False if interpolation != "nearest" else None
            )
            tmp_mask = tmp_mask.squeeze(1)

        #居中裁剪成width,height
        offset_x = (int)((target_width - width) / 2)
        offset_y = (int)((target_height - height) / 2)

        new_image = tmp_img[:, offset_y:offset_y + height, offset_x:offset_x + width, :]
        if mask is not None:
            new_mask = tmp_mask[:, offset_y:offset_y + height, offset_x:offset_x + width]

        #换算回原图坐标系的内容区域,供RecoverMeet使用
        recoverRate = img_width / target_width
        region_x = (int)(offset_x * recoverRate)
        region_y = (int)(offset_y * img_height / target_height)
        region_width = (int)(width * recoverRate)
        region_height = (int)(height * img_height / target_height)

        meet_Info = {
            "x" : offset_x,
            "y" : offset_y,
            "originalWidth" :  img_width,
            "originalHeight" : img_height,
            "targetWidth" : target_width,
            "targetHeight" : target_height,
            "regionX" : region_x,
            "regionY" : region_y,
            "regionWidth" : region_width,
            "regionHeight" : region_height
        }

        if mask is not None:
            return (new_image, meet_Info, new_mask,)
        return (new_image, meet_Info)


class ImageRecoverMeetNode:
    
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE",),
                "meetInfo": ("MEET_INFO",),
                "interpolation": (["nearest", "bilinear", "bicubic"], {"default": "bilinear"}),
                "padding_color": ("STRING", {"default": "255, 255, 255"}),
            },
            "optional": {
                "background": ("IMAGE",),
                "mask": ("MASK",),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("Image", "Mask")
    FUNCTION = "recover_meet"

    CATEGORY = "Kolid-Toolkit"

    def recover_meet(self, image, meetInfo, interpolation, padding_color, background=None, mask=None): 
        img_batchSize, img_height, img_width, img_channelCount = image.size()     
        
        if mask is not None:
            if len(mask.size())>3:
                mask = mask.squeeze(1)
            try:
                mask_batchSize, mask_height, mask_width = mask.size()
            except:
                raise ValueError(f"mask:{mask.size()} img:{image.size()}")
            if img_batchSize != mask_batchSize or img_height != mask_height or img_width != mask_width:
                raise ValueError(f"mask:{mask.size()} img:{image.size()}Mask的尺寸与image不同!")
        
        if ',' in padding_color:
            color_list = np.clip([int(channel) for channel in padding_color.split(',')], 0, 255) # RGB format
        else:
            padding_color = padding_color.lstrip('#')
            color_list = [int(padding_color[i:i+2], 16) for i in (0, 2, 4)] # Hex format
        
        regionX = meetInfo["regionX"]
        regionY = meetInfo["regionY"]
        regionWidth = meetInfo["regionWidth"]
        regionHeight = meetInfo["regionHeight"]
        
        originalWidth = meetInfo["originalWidth"]
        originalHeight = meetInfo["originalHeight"]
        
        #把处理过的meet图缩放回原图坐标系的内容区域
        tmp_img = F.interpolate(
            image.permute(0, 3, 1, 2),#BHWC=>BCHW
            size=(regionHeight, regionWidth),  # 目标高度和宽度
            mode=interpolation,    # 插值模式
            align_corners=False if interpolation != "nearest" else None
        ).permute(0, 2, 3, 1)

        if mask is not None:
            mask = mask.unsqueeze(1)
            tmp_mask = F.interpolate(
                mask,
                size=(regionHeight, regionWidth),  # 目标高度和宽度
                mode=interpolation,    # 插值模式
                align_corners=False if interpolation != "nearest" else None
            )
            tmp_mask = tmp_mask.squeeze(1)
        
        if background is not None:
            #贴回原图,完美还原(被裁剪的边缘保留原图内容)
            bg_batchSize, bg_height, bg_width, bg_channelCount = background.size()
            if bg_batchSize != img_batchSize or bg_width != originalWidth or bg_height != originalHeight:
                raise ValueError(f"background:{background.size()} meetInfo原图尺寸:{originalWidth}x{originalHeight} 不匹配!")
            
            new_image = background.clone().to(dtype=torch.float32)
        else:
            #有损还原,被裁剪的边缘用padding_color填充
            new_image = torch.zeros(
                (img_batchSize, originalHeight, originalWidth, img_channelCount),
                dtype=torch.float32,
            )
            new_image[:,:,:,0] = color_list[0] / 255
            new_image[:,:,:,1] = color_list[1] / 255
            new_image[:,:,:,2] = color_list[2] / 255
        
        new_image[:, regionY:regionY + regionHeight, regionX:regionX + regionWidth, :] = tmp_img
        
        if mask is not None:
            new_mask = torch.zeros(
                (img_batchSize, originalHeight, originalWidth),
                dtype=torch.float32,
            )
            new_mask[:, regionY:regionY + regionHeight, regionX:regionX + regionWidth] = tmp_mask
        
        if mask is not None:
            return (new_image, new_mask,)
        return (new_image,)