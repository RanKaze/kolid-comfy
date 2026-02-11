import requests
import random
import json
from PIL import Image
import io
import base64
import torch
import comfy.utils
from server import PromptServer


def get_page(gallery_url, headers, page_index):
    """根据page_index获取单个图片页面链接和总页数"""
    # 获取画廊详情页面
    response = requests.get(gallery_url, headers=headers, timeout=30)
    if response.status_code != 200:
        raise Exception(f"Failed to get gallery: {response.status_code}")
    
    # 提取图片总数和每页显示数量
    # 示例：Showing 1 - 40 of 100 images
    import re
    page_info_pattern = re.compile(r'Showing \d+ - (\d+) of (\d+) images')
    match = page_info_pattern.search(response.text)
    
    total_pages = 1000  # 默认值
    
    if not match:
        # 如果没找到，尝试提取Pages信息
        page_info_pattern = re.compile(r'Pages:\s*(\d+)')
        match = page_info_pattern.search(response.text)
        if not match:
            # 如果还是没找到，回退到提取当前页面的链接
            page_pattern = re.compile(r'href="(https://e[-x]hentai\.org/s/[a-f0-9]+/\d+-\d+)"')
            pages = page_pattern.findall(response.text)
            if not pages:
                raise Exception("No pages found in gallery")
            # 根据page_index选择页面
            if page_index >= len(pages):
                return pages[-1], total_pages
            else:
                return pages[page_index], total_pages
    
    # 提取每页显示数量和总图片数
    per_page = int(match.group(1))
    total_images = int(match.group(2))
    total_pages = total_images
    
    # 计算需要访问的缩略图页面和页面在该缩略图页面中的位置
    thumbnail_page = page_index // per_page
    page_in_thumbnail = page_index % per_page
    
    # 构建缩略图页面URL
    thumbnail_url = f"{gallery_url}?p={thumbnail_page}"
    thumbnail_response = requests.get(thumbnail_url, headers=headers, timeout=30)
    
    if thumbnail_response.status_code != 200:
        raise Exception(f"Failed to get thumbnail page: {thumbnail_response.status_code}")
    
    # 提取图片页面链接（支持E-Hentai和ExHentai）
    page_pattern = re.compile(r'href="(https://e[-x]hentai\.org/s/[a-f0-9]+/\d+-\d+)"')
    pages = page_pattern.findall(thumbnail_response.text)
    
    if not pages:
        raise Exception("No pages found in thumbnail page")
    
    # 根据page_in_thumbnail选择页面
    if page_in_thumbnail >= len(pages):
        return pages[-1], total_pages
    else:
        return pages[page_in_thumbnail], total_pages

class EHentaiRandomNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "random_seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "page_index": ("INT", {"default": 0, "min": 0, "max": 1000}),
                "search": ("STRING", {"default": "", "multiline": False})
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING", "INT", "INT", "INT")
    RETURN_NAMES = ("image", "gallery_url", "new_seed", "new_page", "node_id")
    FUNCTION = "get_random_image"
    CATEGORY = "Kolid-Toolkit"

    def get_random_image(self, random_seed, page_index, search, unique_id):
        # 设置随机种子
        random.seed(random_seed)
        
        # 尝试从e-hentai获取随机漫画
        try:
            # 构建搜索URL
            import urllib.parse
            search_query = urllib.parse.quote(search) if search else ""
            search_url = f"https://e-hentai.org/?f_doujinshi=1&f_manga=1&f_artistcg=1&f_gamecg=1&f_western=1&f_non-h=1&f_imageset=1&f_cosplay=1&f_asianporn=1&f_misc=1&f_search={search_query}&f_apply=Apply+Filter"
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
            }
            
            # 获取搜索结果
            response = requests.get(search_url, headers=headers, timeout=30)
            if response.status_code != 200:
                raise Exception(f"Failed to get search results: {response.status_code}")
            
            # 解析HTML获取漫画链接（支持E-Hentai和ExHentai）
            import re
            gallery_pattern = re.compile(r'href="(https://e[-x]hentai\.org/g/\d+/[a-f0-9]+/)"')
            galleries = gallery_pattern.findall(response.text)
            
            if not galleries:
                raise Exception("No galleries found")
            
            # 随机选择一个漫画
            random_gallery = random.choice(galleries)
            
            # 获取指定页面链接和总页数
            target_page, total_pages = get_page(random_gallery, headers, page_index)
            
            # 获取图片页面
            page_response = requests.get(target_page, headers=headers, timeout=30)
            if page_response.status_code != 200:
                raise Exception(f"Failed to get page: {page_response.status_code}")
            
            # 解析图片链接
            image_pattern = re.compile(r'<img id="img" src="([^"]+)"')
            image_match = image_pattern.search(page_response.text)
            
            if not image_match:
                raise Exception("No image found on page")
            
            image_url = image_match.group(1)
            
            # 获取图片（带进度条）
            # 首先获取文件大小
            with requests.get(image_url, headers=headers, stream=True, timeout=30) as r:
                if r.status_code != 200:
                    raise Exception(f"Failed to get image: {r.status_code}")
                
                # 获取文件大小
                total_size = int(r.headers.get('content-length', 0))
                if total_size == 0:
                    # 如果没有Content-Length头，使用默认值
                    total_size = 1024 * 1024 * 5  # 假设5MB
                
                # 创建进度条
                pbar = comfy.utils.ProgressBar(total_size)
                
                # 分块下载
                chunks = []
                downloaded_size = 0
                chunk_size = 8192
                
                for chunk in r.iter_content(chunk_size=chunk_size):
                    if chunk:
                        chunks.append(chunk)
                        downloaded_size += len(chunk)
                        # 更新进度条
                        pbar.update(len(chunk))
                
                # 合并所有块
                image_content = b''.join(chunks)
            
            # 处理图片
            image = Image.open(io.BytesIO(image_content))
            if image.mode != "RGB":
                image = image.convert("RGB")
            
            # 转换为ComfyUI需要的格式
            import numpy as np
            image_array = np.array(image).astype(np.float32) / 255.0
            # 添加batch维度并调整为BHWC格式
            image_array = np.expand_dims(image_array, axis=0)
            image_tensor = torch.from_numpy(image_array)
            
            # 计算下一次的seed和page_index
            next_page_index = page_index + 1
            next_seed = random_seed
            
            # 如果已经到达最后一页，重新生成seed并重置page_index
            if next_page_index >= total_pages:
                next_seed = random.randint(0, 0xffffffffffffffff)
                next_page_index = 0
            
            # 返回结果，包括下一次的seed和page_index
            return (image_tensor, random_gallery, next_seed, next_page_index, int(unique_id) if unique_id else 0)
            
        except Exception as e:
            # 如果出错，返回默认图片
            print(f"Error in EHentaiRandomNode: {e}")
            # 创建一个默认的红色错误图片
            error_image = Image.new("RGB", (512, 512), color="red")
            import numpy as np
            error_array = np.array(error_image).astype(np.float32) / 255.0
            # 添加batch维度并调整为BHWC格式
            error_array = np.expand_dims(error_array, axis=0)
            error_tensor = torch.from_numpy(error_array)
            # 返回错误结果，包括下一次的seed和page_index
            # 出错时保持原seed不变，页码加1
            error_next_seed = random_seed
            error_next_page = page_index + 1
            return (error_tensor, "", error_next_seed, error_next_page, int(unique_id) if unique_id else 0)



class EHentaiURLNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "gallery_url": ("STRING", {"default": "", "multiline": False}),
                "page_index": ("INT", {"default": 0, "min": 0, "max": 1000})
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("image", "gallery_url")
    FUNCTION = "get_image"
    CATEGORY = "Kolid-Toolkit"

    def get_image(self, gallery_url, page_index):
        # 尝试从指定的e-hentai URL获取图片
        try:
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
            }
            
            # 获取漫画页面
            gallery_response = requests.get(gallery_url, headers=headers, timeout=30)
            if gallery_response.status_code != 200:
                raise Exception(f"Failed to get gallery: {gallery_response.status_code}")
            
            # 获取指定页面链接
            target_page, _ = get_page(gallery_url, headers, page_index)
            
            # 获取图片页面
            page_response = requests.get(target_page, headers=headers, timeout=30)
            if page_response.status_code != 200:
                raise Exception(f"Failed to get page: {page_response.status_code}")
            
            # 解析图片链接
            image_pattern = re.compile(r'<img id="img" src="([^"]+)"')
            image_match = image_pattern.search(page_response.text)
            
            if not image_match:
                raise Exception("No image found on page")
            
            image_url = image_match.group(1)
            
            # 获取图片（带进度条）
            # 首先获取文件大小
            with requests.get(image_url, headers=headers, stream=True, timeout=30) as r:
                if r.status_code != 200:
                    raise Exception(f"Failed to get image: {r.status_code}")
                
                # 获取文件大小
                total_size = int(r.headers.get('content-length', 0))
                if total_size == 0:
                    # 如果没有Content-Length头，使用默认值
                    total_size = 1024 * 1024 * 5  # 假设5MB
                
                # 创建进度条
                pbar = comfy.utils.ProgressBar(total_size)
                
                # 分块下载
                chunks = []
                downloaded_size = 0
                chunk_size = 8192
                
                for chunk in r.iter_content(chunk_size=chunk_size):
                    if chunk:
                        chunks.append(chunk)
                        downloaded_size += len(chunk)
                        # 更新进度条
                        pbar.update(len(chunk))
                
                # 合并所有块
                image_content = b''.join(chunks)
            
            # 处理图片
            image = Image.open(io.BytesIO(image_content))
            if image.mode != "RGB":
                image = image.convert("RGB")
            
            # 转换为ComfyUI需要的格式
            import numpy as np
            image_array = np.array(image).astype(np.float32) / 255.0
            # 添加batch维度并调整为BHWC格式
            image_array = np.expand_dims(image_array, axis=0)
            image_tensor = torch.from_numpy(image_array)
            
            return (image_tensor, gallery_url)
            
        except Exception as e:
            # 如果出错，返回默认图片
            print(f"Error in EHentaiURLNode: {e}")
            # 创建一个默认的红色错误图片
            error_image = Image.new("RGB", (512, 512), color="red")
            import numpy as np
            error_array = np.array(error_image).astype(np.float32) / 255.0
            # 添加batch维度并调整为BHWC格式
            error_array = np.expand_dims(error_array, axis=0)
            error_tensor = torch.from_numpy(error_array)
            return (error_tensor, gallery_url)