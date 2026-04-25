import os
import random
import re
import requests
from PIL import Image
import io
import torch
import comfy.utils
from server import PromptServer
from comfy_api.latest import ComfyExtension, io, ui, Input, InputImpl, Types
import folder_paths
import numpy as np
import cv2
from ..libs.video_utils import disk_images_to_video

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

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
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
            
            # 更新输入端的seed和index
            if unique_id is not None:
                try:
                    PromptServer.instance.send_sync(
                        "kolid-comfy-widget-set",
                        {
                            "node_id": unique_id,
                            "widget_name": "random_seed",
                            "type": "INT",
                            "value": next_seed
                        }
                    )
                    PromptServer.instance.send_sync(
                        "kolid-comfy-widget-set",
                        {
                            "node_id": unique_id,
                            "widget_name": "index",
                            "type": "INT",
                            "value": next_index
                        }
                    )
                except Exception as e:
                    print(f"[LocalImageLoaderNode] Warning: Failed to update widgets: {e}")
            
            return (image_tensor,)
            
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
            
            # 更新输入端的seed和index
            if unique_id is not None:
                try:
                    PromptServer.instance.send_sync(
                        "kolid-comfy-widget-set",
                        {
                            "node_id": unique_id,
                            "widget_name": "random_seed",
                            "type": "INT",
                            "value": error_next_seed
                        }
                    )
                    PromptServer.instance.send_sync(
                        "kolid-comfy-widget-set",
                        {
                            "node_id": unique_id,
                            "widget_name": "index",
                            "type": "INT",
                            "value": error_next_index
                        }
                    )
                except Exception as e:
                    print(f"[LocalImageLoaderNode] Warning: Failed to update widgets: {e}")
            
            return (error_tensor,)


def get_max_image_number(folder_name: str) -> int:
    """获取当前文件夹中最大的图片编号（只看 .png 文件），没有文件返回 0"""
    output_dir = os.path.join(folder_paths.output_directory, "Images", folder_name)
    if not os.path.exists(output_dir):
        return 0

    max_num = 0
    for f in os.listdir(output_dir):
        if f.lower().endswith(".png"):
            try:
                # 提取纯数字部分（忽略可能的其他字符，增强鲁棒性）
                name = os.path.splitext(f)[0]
                # 只取开头的连续数字
                num_str = ''.join(c for c in name if c.isdigit())
                if num_str:
                    num = int(num_str)
                    if num > max_num:
                        max_num = num
            except (ValueError, TypeError):
                continue
    return max_num

def get_folder_hash(folder_name: str) -> str:
    """
    计算指定文件夹中所有 .png 和 .txt 文件的哈希值（用于 IS_CHANGED）
    文件夹不存在或为空时返回固定字符串，保证稳定。
    """
    output_dir = os.path.join(folder_paths.output_directory, "Images", folder_name)
    
    if not os.path.exists(output_dir):
        return "folder_not_exist"

    m = hashlib.sha256()
    
    # 只考虑 .png 和对应的 .txt 文件，按文件名排序保证顺序一致
    files = sorted([f for f in os.listdir(output_dir) 
                    if f.lower().endswith(('.png', '.txt'))])
    
    for filename in files:
        file_path = os.path.join(output_dir, filename)
        try:
            # 写入文件名（防止仅内容变化但文件名不变的情况）
            m.update(filename.encode('utf-8'))
            
            # 写入文件内容
            with open(file_path, 'rb') as f:
                m.update(f.read())
        except (OSError, IOError):
            continue  # 某个文件读取失败就跳过
    
    return m.hexdigest()

class DiskSaveImagesNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "folder_name": ("STRING", {"default": "my_images"}),
                "folder_clear": ("BOOLEAN", {"default": True, "label_on": "Clear Folder", "label_off": "Append (continue numbering)"}),
            },
            "optional": {
                "addition": ("STRING", {"default": "", "multiline": True, "forceInput": True}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("folder_name",)
    FUNCTION = "save_images"
    CATEGORY = "image/DiskIO"
    
    INPUT_IS_LIST = True   # 保持原样

    def save_images(self, images, folder_name, folder_clear=True, addition=None):
        # ====================== 处理 list 输入（因为 INPUT_IS_LIST=True） ======================
        # folder_name
        if isinstance(folder_name, list):
            folder_name = folder_name[0] if folder_name else "default_folder"

        # folder_clear（布尔值也可能被包装成 list）
        if isinstance(folder_clear, list):
            folder_clear = folder_clear[0] if folder_clear else True

        # addition（可选，可能为 list 或 None）
        if isinstance(addition, list):
            additions = addition
        elif addition is not None:
            additions = [addition]
        else:
            additions = None

        # ====================== 准备目录 ======================
        base_dir = os.path.join(folder_paths.output_directory, "Images")
        output_dir = os.path.join(base_dir, folder_name)
        os.makedirs(output_dir, exist_ok=True)

        # ====================== 决定起始编号 ======================
        if folder_clear:
            # 清空模式：删除旧的 .png 和 .txt
            for f in os.listdir(output_dir):
                if f.lower().endswith((".png", ".txt")):
                    try:
                        os.unlink(os.path.join(output_dir, f))
                    except OSError:
                        pass
            start_index = 1
        else:
            # 追加模式：每次强制重新计算最大编号
            max_num = get_max_image_number(folder_name)
            start_index = max_num + 1 if max_num > 0 else 1

        # ====================== 处理 images 张量 → 展平为单张列表 ======================
        all_images = []
        if isinstance(images, list):
            for batch in images:
                if batch is None:
                    continue
                if isinstance(batch, torch.Tensor):
                    if batch.dim() == 4:      # batch of images
                        for i in range(batch.shape[0]):
                            all_images.append(batch[i])
                    elif batch.dim() == 3:    # single image
                        all_images.append(batch)
        else:
            # 单个 tensor 输入
            if isinstance(images, torch.Tensor):
                if images.dim() == 4:
                    for i in range(images.shape[0]):
                        all_images.append(images[i])
                elif images.dim() == 3:
                    all_images.append(images)

        total_to_save = len(all_images)
        if total_to_save == 0:
            return (f"No images to save in folder: {folder_name}",)

        # ====================== addition 长度严格检查 ======================
        if additions is not None and len(additions) != total_to_save:
            raise ValueError(
                f"addition length mismatch! Expected {total_to_save} items, got {len(additions)}."
            )

        # ====================== 保存图片和文本 ======================
        for idx in range(total_to_save):
            current_num = start_index + idx
            image_tensor = all_images[idx]

            # 张量转 PIL
            np_image = (image_tensor * 255.0).clamp(0, 255).to(torch.uint8).cpu().numpy()
            mode = "RGBA" if np_image.shape[-1] == 4 else "RGB"
            if np_image.shape[-1] > 3 and mode == "RGB":
                np_image = np_image[..., :3]

            pil_image = Image.fromarray(np_image, mode=mode)
            save_path = os.path.join(output_dir, f"{current_num}.png")
            
            try:
                pil_image.save(save_path, compress_level=4)
            except Exception as e:
                print(f"Error saving image {save_path}: {e}")

            # 保存对应的 .txt
            if additions is not None:
                txt_content = str(additions[idx]) if additions[idx] is not None else ""
                txt_path = os.path.join(output_dir, f"{current_num}.txt")
                try:
                    with open(txt_path, "w", encoding="utf-8") as f:
                        f.write(txt_content)
                except Exception as e:
                    print(f"Error saving text {txt_path}: {e}")

        # ====================== 返回信息 ======================
        action = "Cleared and saved" if folder_clear else "Appended (continued numbering)"
        end_num = start_index + total_to_save - 1
        add_info = " + additions" if additions is not None else ""
        print(f"{action}\nSaved {start_index}.png ~ {end_num}.png ({total_to_save} images{add_info})")

        return (folder_name,)

    @classmethod
    def IS_CHANGED(cls, images, folder_name, folder_clear=True, addition=None):
        # folder_name 处理
        if isinstance(folder_name, list):
            folder_name = folder_name[0] if folder_name else "default_folder"

        # 追加模式必须强制执行（返回 nan）
        if isinstance(folder_clear, list):
            folder_clear = folder_clear[0] if folder_clear else True
        
        if not folder_clear:
            return float("nan")
        
        # 清空模式使用输入哈希避免无谓重复执行
        try:
            if isinstance(images, list):
                h = hash(str([i.shape if isinstance(i, torch.Tensor) else str(i) for i in images]))
            else:
                h = hash(images.shape if isinstance(images, torch.Tensor) else str(images))
            return h
        except Exception:
            return float("nan")


# ====================== Load 节点保持不变 ======================
class DiskLoadImagesNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder_name": ("STRING", {"default": "my_images"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("images", "additions")
    FUNCTION = "load_images"
    CATEGORY = "image/DiskIO"
    
    INPUT_IS_LIST = True
    OUTPUT_IS_LIST = (True, True)

    def load_images(self, folder_name):
        if isinstance(folder_name, list):
            folder_name_list = folder_name
        else:
            folder_name_list = [folder_name]

        image_results = []
        addition_results = []

        for fname in folder_name_list:
            output_dir = os.path.join(folder_paths.output_directory, "Images", fname)
            if not os.path.exists(output_dir):
                image_results.append(torch.zeros((0, 512, 512, 3), dtype=torch.float32))
                addition_results.append(None)
                continue

            png_files = []
            for f in os.listdir(output_dir):
                if f.lower().endswith(".png"):
                    try:
                        num = int(os.path.splitext(f)[0])
                        png_files.append((num, f))
                    except ValueError:
                        continue

            if not png_files:
                image_results.append(torch.zeros((0, 512, 512, 3), dtype=torch.float32))
                addition_results.append(None)
                continue

            png_files.sort(key=lambda x: x[0])

            image_tensors = []
            additions = []

            for num, png_name in png_files:
                img_path = os.path.join(output_dir, png_name)
                with Image.open(img_path) as pil_img:
                    if pil_img.mode not in ("RGB", "RGBA"):
                        pil_img = pil_img.convert("RGB")
                    np_img = np.array(pil_img).astype(np.float32) / 255.0
                    tensor_img = torch.from_numpy(np_img)
                    image_tensors.append(tensor_img)

                txt_path = os.path.join(output_dir, f"{num}.txt")
                if os.path.exists(txt_path):
                    with open(txt_path, "r", encoding="utf-8") as f:
                        content = f.read().strip()
                    additions.append(content if content else None)
                else:
                    additions.append(None)

            batch = torch.stack(image_tensors, dim=0) if image_tensors else torch.zeros((0, 512, 512, 3), dtype=torch.float32)
            image_results.append(batch)
            addition_results.append(additions if additions else None)

        return (image_results, addition_results)

    @classmethod
    def IS_CHANGED(cls, folder_name):
        if isinstance(folder_name, list):
            folder_name = folder_name[0] if folder_name else "default_folder"
        return get_folder_hash(folder_name)


class DiskLoadImageCountNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder_name": ("STRING", {"default": "my_images"}),
            }
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("count",)
    FUNCTION = "get_count"
    CATEGORY = "image/DiskIO"

    def get_count(self, folder_name):
        if isinstance(folder_name, list):
            folder_name = folder_name[0] if folder_name else "default_folder"
        return (get_max_image_number(folder_name),)

    @classmethod
    def IS_CHANGED(cls, folder_name):
        if isinstance(folder_name, list):
            folder_name = folder_name[0] if folder_name else "default_folder"
        return get_folder_hash(folder_name)
    
class DiskImagesToVideoNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder_name": ("STRING", {"default": "my_images"}),
                "file_name": ("STRING", {"default": "output_video"}),
                "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 0.01}),  # ← 改为 FLOAT，更精确
                "crf": ("INT", {"default": 18, "min": 0, "max": 51}),
            },
            "optional": {
                "audio": ("AUDIO",),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("video_path",)
    FUNCTION = "execute"
    CATEGORY = "image/DiskIO"

    def execute(self, folder_name, file_name, fps=24.0, crf=18, audio=None):   # fps 默认 float
        return (disk_images_to_video(folder_name, file_name, float(fps), crf, audio),)

    @classmethod
    def IS_CHANGED(cls, folder_name, file_name, fps, crf, audio=None):
        return get_folder_hash(folder_name)