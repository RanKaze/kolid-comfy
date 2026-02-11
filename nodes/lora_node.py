import os
import folder_paths
from ..libs.utils import AlwaysEqualProxy
import torch
from nodes import LoraLoader, CLIPTextEncode

class LoadLoraPackNode:
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "lora": (folder_paths.get_filename_list("loras"),),
                "enable" :  ("BOOLEAN", {"default" : True}),
                "positive": ("STRING", {"default": "", "multiline": False}),
                "negative": ("STRING", {"default": "", "multiline": False}),
                "strength_model": ("FLOAT", {"default": 1.0}),
                "strength_clip": ("FLOAT", {"default": 1.0}),
            },
            "hidden":{
                "sdppp_pos": ("STRING", {"default": "", "multiline": False}),
            }
        }

    RETURN_TYPES = ("REGEX_PACK",)
    RETURN_NAMES = ("pack",)
    FUNCTION = "excute"
    CATEGORY = "Kolid-Toolkit"

    def excute(self, lora, enable, positive, negative, strength_model, strength_clip):
        if enable:
            p = {
                "lora" : lora, 
                "positive" : positive,
                "negative" : negative,
                "strength_model" : strength_model,
                "strength_clip" : strength_clip,
            }
            return (p,)
        else:
            return (None,)
        
        
class LoadLoraFromPackNode:
    
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "packs": ("REGEX_PACK",),
            }
        }

    INPUT_IS_LIST = True
    RETURN_TYPES = ("MODEL","CLIP",)
    RETURN_NAMES = ("model","clip",)
    FUNCTION = "excute"
    CATEGORY = "Kolid-Toolkit"

    def excute(self, model, clip, packs):
        model = model[0]
        clip = clip[0]
        for pack in packs:
            strength_model = pack["strength_model"]
            strength_clip = pack["strength_clip"]
            if strength_model != 0 and strength_clip != 0:
                model, clip = LoraLoader().load_lora(model, clip, pack["lora"], strength_model, strength_clip)
            
        return (model, clip,)
    
    
    
class TextEncodeFromPackNode:
    
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
                "clip": ("CLIP",),
                "packs": ("REGEX_PACK",),
                "pos_global": ("STRING", {"default": "", "forceInput": True}),
                "neg_global": ("STRING", {"default": "", "forceInput": True}),
            }
        }

    INPUT_IS_LIST = True
    RETURN_TYPES = ("CONDITIONING","CONDITIONING","STRING","STRING",)
    RETURN_NAMES = ("positive","negative","pos_local","neg_local",)
    FUNCTION = "excute"
    CATEGORY = "Kolid-Toolkit"

    def excute(self, clip, packs, pos_global, neg_global):
        clip = clip[0]
        posG = pos_global[0]
        negG = neg_global[0]
        
        posL = ",".join(
            p["positive"] for p in packs 
            if p.get("positive")  # 自动过滤 None、空字符串、False 等
        )
        
        negL = ",".join(
            p["negative"] for p in packs 
            if p.get("negative")  # 自动过滤 None、空字符串、False 等
        )
        
        pos = result = ", ".join(filter(None, [posG, posL]))
        neg = result = ", ".join(filter(None, [negG, negL]))
        
        posEncoded = CLIPTextEncode().encode(clip=clip, text=pos)
        negEncoded = CLIPTextEncode().encode(clip=clip, text=neg)
            
        return (posEncoded[0], negEncoded[0], posL, negL, )