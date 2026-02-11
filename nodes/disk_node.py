import os
import random
import re
import requests
from PIL import Image
import io
import torch
import comfy.utils

class LocalImageLoaderNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "root_directory": ("STRING", {"default": "", "multiline": False}),
                "random_seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "index": ("INT", {"default": 0, "min": 0, "max": 10000}),
                "search": ("STRING", {"default": ".*", "multiline": False})
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "INT")
    RETURN_NAMES = ("image", "new_seed", "new_index", "node_id")
    FUNCTION = "load_image"
    CATEGORY = "Kolid-Toolkit"

    def load_image(self, root_directory, random_seed, index, search, unique_id):
        # 设置随机种子
        random.seed(random_seed)
        
        # 尝试加载本地图片
        try:
            # 验证根目录是否存在
            if not os.path.exists(root_directory):
                raise Exception(f"Root directory does not exist: {root_directory}")
            
            # 搜索符合条件的目录
            matching_dirs = []
            for dirpath, dirnames, filenames in os.walk(root_directory):
                # 只考虑直接子目录
                if dirpath == root_directory:
                    for dirname in dirnames:
                        if re.match(search, dirname):
                            matching_dirs.append(os.path.join(dirpath, dirname))
            
            if not matching_dirs:
                raise Exception(f"No matching directories found in {root_directory}")
            
            # 随机选择一个目录
            selected_dir = random.choice(matching_dirs)
            
            # 获取目录中的图片文件
            image_extensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']
            image_files = []
            for filename in os.listdir(selected_dir):
                ext = os.path.splitext(filename)[1].lower()
                if ext in image_extensions:
                    image_files.append(os.path.join(selected_dir, filename))
            
            # 按照文件名排序
            image_files.sort()
            
            if not image_files:
                raise Exception(f"No image files found in {selected_dir}")
            
            # 根据index选择文件
            if index >= len(image_files):
                target_file = image_files[-1]
            else:
                target_file = image_files[index]
            
            # 加载图片
            image = Image.open(target_file)
            if image.mode != "RGB":
                image = image.convert("RGB")
            
            # 转换为ComfyUI需要的格式
            import numpy as np
            image_array = np.array(image).astype(np.float32) / 255.0
            # 添加batch维度并调整为BHWC格式
            image_array = np.expand_dims(image_array, axis=0)
            image_tensor = torch.from_numpy(image_array)
            
            # 计算下一次的seed和index
            next_index = index + 1
            next_seed = random_seed
            
            # 如果已经到达最后一个文件，重新生成seed并重置index
            if next_index >= len(image_files):
                next_seed = random.randint(0, 0xffffffffffffffff)
                next_index = 0
            
            return (image_tensor, next_seed, next_index, int(unique_id))
            
        except Exception as e:
            # 如果出错，返回默认图片
            print(f"Error in LocalImageLoaderNode: {e}")
            # 创建一个默认的红色错误图片
            error_image = Image.new("RGB", (512, 512), color="red")
            import numpy as np
            error_array = np.array(error_image).astype(np.float32) / 255.0
            # 添加batch维度并调整为BHWC格式
            error_array = np.expand_dims(error_array, axis=0)
            error_tensor = torch.from_numpy(error_array)
            
            # 出错时保持原seed不变，index加1
            error_next_seed = random_seed
            error_next_index = index + 1
            return (error_tensor, error_next_seed, error_next_index, int(unique_id))
