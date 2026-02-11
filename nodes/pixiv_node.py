import requests
import random
import json
from PIL import Image
import io
import base64
import torch
import comfy.utils
import re

class PixivImageLoaderNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": (["artwork", "user"], {"default": "artwork"}),
                "id": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "page_index": ("INT", {"default": 0, "min": 0, "max": 100})
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT")
    RETURN_NAMES = ("image", "new_index", "node_id")
    FUNCTION = "load_image"
    CATEGORY = "Kolid-Toolkit"

    def load_image(self, mode, id, page_index, unique_id):
        # 使用时间作为随机种子
        import time
        random.seed(int(time.time() * 1000000))
        
        # 尝试加载pixiv图片
        try:
            # 提取实际的ID
            # 对于artwork URL: https://www.pixiv.net/artworks/140686760#1
            # 对于user URL: https://www.pixiv.net/users/42956154
            if mode == "artwork":
                # 直接使用id作为artwork ID
                artwork_id = str(id)
                
                # 确定要使用的page_index
                if page_index == 0:
                    # 随机选择一张图片（不依赖random_seed）
                    # 首先获取作品的总页数
                    total_pages = self._get_artwork_page_count(artwork_id)
                    if total_pages > 1:
                        # 随机选择一个页面（从0开始）
                        # 使用random模块选择一个随机整数
                        random_page = random.randint(0, total_pages - 1)
                        image_url = self._get_artwork_image_url(artwork_id, random_page)
                    else:
                        # 单页作品
                        image_url = self._get_artwork_image_url(artwork_id, 0)
                else:
                    # 使用指定的page_index（从1开始）
                    # 转换为从0开始的索引
                    actual_page = page_index - 1
                    image_url = self._get_artwork_image_url(artwork_id, actual_page)
            else:  # user mode
                # 直接使用id作为user ID
                user_id = str(id)
                
                # 获取用户作品列表（按最新顺序）
                user_artworks = self._get_user_artworks(user_id)
                
                if not user_artworks:
                    # 如果没有找到作品，使用默认作品
                    default_artworks = ["118990608", "140686760"]
                    artwork_id = random.choice(default_artworks)
                else:
                    # 根据page_index选择作品
                    if page_index == 0:
                        # 随机选择一个作品
                        artwork_id = random.choice(user_artworks)
                    else:
                        # 按顺序选择作品，超出范围则循环
                        artwork_index = (page_index - 1) % len(user_artworks)
                        artwork_id = user_artworks[artwork_index]
                
                # 加载图片
                image_url = self._get_artwork_image_url(artwork_id, 0)
            
            # 下载图片
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                "Referer": "https://www.pixiv.net/"
            }
            
            # 下载图片（带进度条）
            print(f"Downloading image from: {image_url}")
            
            # 首先获取文件大小
            with requests.get(image_url, headers=headers, stream=True, timeout=30) as r:
                if r.status_code != 200:
                    raise Exception(f"Failed to download image: {r.status_code}")
                
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
                response_content = b''.join(chunks)
            
            # 处理图片
            image = Image.open(io.BytesIO(response_content))
            if image.mode != "RGB":
                image = image.convert("RGB")
            
            # 转换为ComfyUI需要的格式
            import numpy as np
            image_array = np.array(image).astype(np.float32) / 255.0
            # 添加batch维度并调整为BHWC格式
            image_array = np.expand_dims(image_array, axis=0)
            image_tensor = torch.from_numpy(image_array)
            
            # 计算下一次的index
            next_index = page_index
            
            if mode == "artwork":
                if page_index == 0:
                    # page_index为0时不增加
                    next_index = 0
                else:
                    # 获取作品的总页数
                    total_pages = self._get_artwork_page_count(artwork_id)
                    # 递增page_index，如果超出范围则循环到1
                    next_index = page_index + 1
                    if next_index > total_pages:
                        next_index = 1
            elif mode == "user":
                if page_index == 0:
                    # page_index为0时不增加
                    next_index = 0
                else:
                    # 递增page_index，循环使用
                    next_index = page_index + 1
            
            return (image_tensor, next_index, int(unique_id))
            
        except Exception as e:
            # 如果出错，返回默认图片
            print(f"Error in PixivImageLoaderNode: {e}")
            # 创建一个默认的红色错误图片
            error_image = Image.new("RGB", (512, 512), color="red")
            import numpy as np
            error_array = np.array(error_image).astype(np.float32) / 255.0
            # 添加batch维度并调整为BHWC格式
            error_array = np.expand_dims(error_array, axis=0)
            error_tensor = torch.from_numpy(error_array)
            
            # 出错时根据模式调整index
            if mode == "artwork":
                if page_index == 0:
                    error_next_index = 0
                else:
                    error_next_index = page_index + 1
            else:  # user mode
                if page_index == 0:
                    error_next_index = 0
                else:
                    error_next_index = page_index + 1
            return (error_tensor, error_next_index, int(unique_id))
    
    def _get_artwork_page_count(self, artwork_id):
        """获取指定artwork的总页数"""
        # 首先尝试使用pixiv.cat作为替代方案
        try:
            import requests
            # 尝试访问pixiv.cat的第一页
            cat_url = f"https://pixiv.cat/{artwork_id}.jpg"
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
                "Accept-Encoding": "gzip, deflate, br",
                "Connection": "keep-alive",
                "Upgrade-Insecure-Requests": "1"
            }
            
            # 尝试获取图片，检查是否存在
            response = requests.get(cat_url, headers=headers, timeout=30)
            if response.status_code == 200:
                # 尝试获取第二页，判断是否有多页
                cat_url_2 = f"https://pixiv.cat/{artwork_id}-2.jpg"
                response_2 = requests.get(cat_url_2, headers=headers, timeout=30)
                if response_2.status_code == 200:
                    # 尝试获取更多页面，直到失败
                    page_count = 2
                    while True:
                        cat_url_next = f"https://pixiv.cat/{artwork_id}-{page_count+1}.jpg"
                        response_next = requests.get(cat_url_next, headers=headers, timeout=30)
                        if response_next.status_code == 200:
                            page_count += 1
                        else:
                            break
                    return page_count
                else:
                    # 只有一页
                    return 1
        except:
            # pixiv.cat失败，尝试直接访问pixiv
            pass
        
        # 构造artwork页面URL
        artwork_url = f"https://www.pixiv.net/artworks/{artwork_id}"
        
        # 使用更完整的headers，模拟真实浏览器
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Accept-Encoding": "gzip, deflate, br",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
            "Cache-Control": "max-age=0"
        }
        
        try:
            response = requests.get(artwork_url, headers=headers, timeout=30)
            if response.status_code != 200:
                # 如果失败，返回默认值1
                return 1
            
            # 尝试提取图片URL，通过数量判断总页数
            image_pattern = re.compile(r'"original":\s*"([^"]+)"')
            matches = image_pattern.findall(response.text)
            if matches:
                return len(matches)
            
            # 尝试从页面中提取总页数信息
            page_count_pattern = re.compile(r'\d+\s*/\s*(\d+)')
            match = page_count_pattern.search(response.text)
            if match:
                return int(match.group(1))
            
            # 尝试其他可能的页数信息格式
            alt_pattern = re.compile(r'Page\s*\d+\s*/\s*(\d+)')
            alt_match = alt_pattern.search(response.text)
            if alt_match:
                return int(alt_match.group(1))
            
            # 如果无法提取，返回默认值1
            return 1
        except Exception as e:
            # 如果出错，返回默认值1
            print(f"Error in _get_artwork_page_count: {e}")
            return 1
    
    def _get_artwork_image_url(self, artwork_id, page_index):
        """获取指定artwork的图片URL"""
        # 这里需要实现获取pixiv artwork图片URL的逻辑
        # 由于pixiv的限制，这里使用一个简化的实现
        # 实际使用中可能需要使用pixiv API或其他方法
        # 注意：这个实现可能无法访问需要登录的内容
        
        # 构造artwork页面URL
        artwork_url = f"https://www.pixiv.net/artworks/{artwork_id}"
        
        # 使用更完整的headers，模拟真实浏览器
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Accept-Encoding": "gzip, deflate, br",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
            "Cache-Control": "max-age=0"
        }
        
        # 首先尝试使用pixiv.cat作为替代方案，因为直接访问pixiv经常会返回403
        try:
            # 对于多页作品
            if page_index > 0:
                cat_url = f"https://pixiv.cat/{artwork_id}-{page_index+1}.jpg"
            else:
                # 对于单页作品
                cat_url = f"https://pixiv.cat/{artwork_id}.jpg"
            return cat_url
        except:
            # 如果pixiv.cat失败，尝试直接访问pixiv
            pass
        
        response = requests.get(artwork_url, headers=headers, timeout=30)
        if response.status_code != 200:
            raise Exception(f"Failed to get artwork page: {response.status_code}")
        
        # 尝试从页面中提取图片URL
        # 注意：这个方法可能会因为pixiv页面结构变化而失效
        # 更好的方法是使用pixiv API
        
        # 尝试提取图片URL，支持单页和多页作品
        image_pattern = re.compile(r'"original":\s*"([^"]+)"')
        matches = image_pattern.findall(response.text)
        if matches:
            # 确保page_index不超出范围
            if page_index >= len(matches):
                page_index = 0
            image_url = matches[page_index]
            # 替换转义字符
            image_url = image_url.replace('\\/', '/')
            return image_url
        
        # 如果无法提取图片URL，使用默认图片
        raise Exception("Failed to extract image URL from artwork page")
    
    def _get_user_artworks(self, user_id):
        """获取用户的作品列表（按最新顺序）"""
        # 尝试使用不同的方法获取用户作品列表
        
        # 方法1：尝试使用pixiv.cat的用户页面
        try:
            import requests
            import re
            
            # 构造pixiv.cat用户页面URL
            cat_url = f"https://pixiv.cat/user/{user_id}"
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
                "Accept-Encoding": "gzip, deflate, br",
                "Connection": "keep-alive",
                "Upgrade-Insecure-Requests": "1"
            }
            
            response = requests.get(cat_url, headers=headers, timeout=30)
            if response.status_code == 200:
                # 尝试从pixiv.cat页面中提取作品ID列表
                # 匹配像 "https://pixiv.cat/118990608.jpg" 这样的链接
                artwork_pattern = re.compile(r'https://pixiv\.cat/(\d+)\.jpg')
                matches = artwork_pattern.findall(response.text)
                
                if matches:
                    # 去重并保持顺序
                    seen = set()
                    unique_artworks = []
                    for artwork in matches:
                        if artwork not in seen:
                            seen.add(artwork)
                            unique_artworks.append(artwork)
                    return unique_artworks
        except Exception as e:
            print(f"Error with pixiv.cat: {e}")
            pass
        
        # 方法2：尝试使用直接访问pixiv用户页面，使用更完整的headers
        try:
            # 构造用户页面URL
            user_url = f"https://www.pixiv.net/users/{user_id}"
            
            # 使用更完整的headers，模拟真实浏览器
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Accept-Encoding": "gzip, deflate, br, zstd",
                "Connection": "keep-alive",
                "Upgrade-Insecure-Requests": "1",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "none",
                "Sec-Fetch-User": "?1",
                "Cache-Control": "max-age=0"
            }
            
            response = requests.get(user_url, headers=headers, timeout=30)
            if response.status_code == 200:
                # 尝试使用多种正则表达式模式提取作品ID
                patterns = [
                    r'/artworks/(\d+)',
                    r'https://www\.pixiv\.net/artworks/(\d+)',
                    r'artworks/(\d+)',
                    r'"illustId":"(\d+)"',
                    r'"id":(\d+),"title"',
                    r'"id":"(\d+)","title"'
                ]
                
                all_matches = []
                for pattern in patterns:
                    artwork_pattern = re.compile(pattern)
                    matches = artwork_pattern.findall(response.text)
                    all_matches.extend(matches)
                
                if all_matches:
                    # 去重并保持顺序
                    seen = set()
                    unique_artworks = []
                    for artwork in all_matches:
                        if artwork not in seen:
                            seen.add(artwork)
                            unique_artworks.append(artwork)
                    return unique_artworks
        except Exception as e:
            print(f"Error with pixiv.net: {e}")
            pass
        
        # 方法3：尝试使用 Pixiv API 获取用户作品列表
        try:
            # 构造 API URL
            api_url = f"https://www.pixiv.net/ajax/user/{user_id}/profile/all"
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
                "Accept": "application/json",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Accept-Encoding": "gzip, deflate, br, zstd",
                "Connection": "keep-alive",
                "Upgrade-Insecure-Requests": "1",
                "Sec-Fetch-Dest": "empty",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Site": "same-origin",
                "Cache-Control": "max-age=0"
            }
            
            response = requests.get(api_url, headers=headers, timeout=30)
            if response.status_code == 200:
                # 尝试解析 JSON 响应
                import json
                data = json.loads(response.text)
                
                # 尝试从 JSON 中提取作品 ID 列表
                if "body" in data and "illusts" in data["body"]:
                    illusts = data["body"]["illusts"]
                    if illusts:
                        # 获取所有作品 ID
                        artwork_ids = list(illusts.keys())
                        return artwork_ids
        except Exception as e:
            print(f"Error with pixiv API: {e}")
            pass
        
        # 方法4：如果所有方法都失败，返回默认作品
        return ["118990608", "140686760"]
    
    def _get_random_artwork_from_user(self, user_id):
        """从指定用户的作品中随机选择一个artwork"""
        # 获取用户作品列表
        user_artworks = self._get_user_artworks(user_id)
        
        if user_artworks:
            # 随机选择一个作品
            return random.choice(user_artworks)
        else:
            # 如果没有找到作品，使用默认作品
            default_artworks = ["118990608", "140686760"]
            return random.choice(default_artworks)
    
    @classmethod
    def IS_CHANGED(s, page_index, **kwargs):
        """判断节点是否已更改"""
        if page_index == 0:
            # 如果page_index为0，返回float("nan")表示节点已更改
            return float("nan")
        else:
            # 如果page_index不为0，返回page_index
            return page_index

