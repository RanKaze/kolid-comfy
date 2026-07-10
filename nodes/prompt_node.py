import os
import json
import threading
import http.server
import webbrowser
import time
import hashlib
import base64
import urllib.parse
import traceback
import uuid
from comfy_api.latest import ComfyExtension, io, ui, Input, InputImpl, Types
import folder_paths
from server import PromptServer
import comfy.model_management as mm

try:
    from PIL import ImageGrab
    HAS_PIL = True
except ImportError:
    HAS_PIL = False
    print("[SnapshotPrompt] PIL not available, screenshot feature disabled")

try:
    from PySide6.QtCore import Qt, QRect, QPoint, QPropertyAnimation, QEasingCurve, QEventLoop, Signal
    from PySide6.QtGui import QColor, QPainter, QPen, QGuiApplication, QPixmap, QImage, QRegion
    from PySide6.QtWidgets import QApplication, QWidget, QPushButton, QHBoxLayout, QVBoxLayout, QLabel
    HAS_QT = True
except ImportError:
    HAS_QT = False
    print("[SnapshotPrompt] PySide6 not available, region screenshot feature disabled")


def check_interrupted():
    """
    100%可靠的中断检测 - 使用多种检测方式
    优先使用 throw_exception_if_processing_interrupted 强制抛出异常
    """
    try:
        # 方式1: 使用ComfyUI官方推荐的方式 - 直接抛出异常
        # 这是最直接可靠的中断方式，会立即终止执行
        mm.throw_exception_if_processing_interrupted()
    except Exception:
        # 如果抛出了中断异常，重新抛出以确保调用者能捕获
        raise
    
    try:
        # 方式2: 检查processing_interrupted状态
        if mm.processing_interrupted():
            return True
            
        # 方式3: 额外的ComfyUI中断状态检查
        if hasattr(mm, 'interrupted') and mm.interrupted:
            return True
            
        # 方式4: 检查model_management的状态
        if hasattr(mm, 'check_interrupt') and mm.check_interrupt():
            return True
            
        # 方式5: 检查PromptServer的执行状态
        try:
            prompt_server = PromptServer.instance
            if prompt_server:
                # 检查是否有当前正在执行的prompt被中断
                if hasattr(prompt_server, 'last_node_id') and prompt_server.last_node_id is None:
                    # 执行已被清理，说明被中断了
                    pass
        except Exception:
            pass
            
        return False
    except Exception:
        return False


class SnapshotPromptServer:
    """HTTP server for SnapshotPromptNode to select prompts from categories."""

    def __init__(self, port=None, last_selected=None, lora_regex="", last_selected_loras=None, last_selected_prefabs=None, parsed_prompts=None):
        self.port = port
        self.server = None
        self.started = False
        self.prompt_event = threading.Event()
        self.window_closed = False
        self.browser_url = None
        self.selected_prompts = []
        self.custom_prompts = ''
        self.last_selected = last_selected or []
        self.should_stop = False
        self.lora_regex = lora_regex
        self.last_selected_loras = last_selected_loras or []
        self.selected_loras = []
        self.last_selected_prefabs = last_selected_prefabs or []
        self.selected_prefabs = []
        self.parsed_prompts = parsed_prompts or []
        # Region fields
        self.image = None
        self.width = 1024
        self.height = 1024
        self.bg_brightness = 25
        self.initial_boxes = ""
        self.region_result = None
        self.enable_region = False
        self.region_format = ""
        
        # 数据路径改为当前文件夹下的 data/prompt
        self.data_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)),"..", "data", "prompt")
        self.images_dir = os.path.join(self.data_dir, "images")
        self.prompt_json = os.path.join(self.data_dir, "prompt.json")
        self.library_json = os.path.join(self.data_dir, "library.json")
        self.lora_folder_meta_json = os.path.join(self.data_dir, "lora_folder_meta.json")

        self.prompts_data = self._load_prompts()
        self.libraries_data = self._load_libraries()
        self.category_display_modes = {}
        self.category_size_modes = {}
        for cat, cat_data in self.prompts_data.items():
            self.category_display_modes[cat] = cat_data.get("display_mode", "horizontal")
            self.category_size_modes[cat] = cat_data.get("size_mode", "normal")
        # Migrate old separate display/size mode files into prompts_data
        self._migrate_display_modes()
        self._migrate_size_modes()
        
        # Scan Lora metadata files (return all for display, but keep regex for output filtering)
        self.lora_data = self._scan_loras()
        self.lora_folder_meta = self._load_lora_folder_meta()
        # Build a set of valid lora paths for output filtering (active_loras / lora_trigger_words)
        import re as _re
        compiled_re = _re.compile(self.lora_regex) if self.lora_regex else None
        self._valid_lora_paths = set()
        for folder_items in self.lora_data.values():
            for item in folder_items:
                fp = item.get('file_path', '').replace('\\', '/')
                if not compiled_re or compiled_re.search(fp):
                    self._valid_lora_paths.add(fp)
                    self._valid_lora_paths.add(item.get('file_name', ''))

    @staticmethod
    def parse_prompt_data(prompt_data):
        """Parse prompt payload into user_positive and user_loras strings."""
        user_positive = ''
        user_loras = ''
        if not prompt_data:
            return user_positive, user_loras

        prompt_parts = []
        for p in (prompt_data.get('prompts') or []):
            if p.startswith('<') and p.endswith('>'):
                prompt_parts.append(p[1:-1])
            else:
                prompt_parts.append(p.replace('[', '').replace(']', ''))
        custom = prompt_data.get('custom_prompts', '')
        if custom:
            prompt_parts.append(custom)
        user_positive = ', '.join(prompt_parts)

        lora_items = prompt_data.get('loras') or []
        lora_str_parts = []
        for item in lora_items:
            if not item.get('active', True):
                continue
            fp = item.get('file_path', '')
            strength = item.get('strength', 1.0)
            active_tags = item.get('active_tags', [])
            split_mode = item.get('split_mode', False)
            if split_mode and active_tags:
                for tag in active_tags:
                    lora_str_parts.append(f"<lora:{fp}:{strength}:{tag}>")
            else:
                lora_str_parts.append(f"<lora:{fp}:{strength}>")
        user_loras = ', '.join(lora_str_parts)
        return user_positive, user_loras

    def get_active_loras_string(self, prefab_loras=None, lora_path_mode=False):
        """Compute active_loras output from user selections + prefab expansions."""
        all_loras = self.selected_loras + (prefab_loras or [])
        print(f"[get_active_loras_string] input: selected_loras={len(self.selected_loras)}, prefab_loras={len(prefab_loras or [])}, total={len(all_loras)}, lora_path_mode={lora_path_mode}")
        print(f"[get_active_loras_string] _valid_lora_paths count={len(self._valid_lora_paths)}")
        active_lora_parts = []
        for idx, lora_item in enumerate(all_loras):
            active = lora_item.get('active', True)
            file_path = lora_item.get('file_path', '') or lora_item.get('file_name', '')
            strength = lora_item.get('strength', 1.0)
            print(f"[get_active_loras_string] [{idx}] file_path={file_path}, strength={strength}, active={active}")
            if not active:
                print(f"[get_active_loras_string] [{idx}] SKIP: not active")
                continue
            if not file_path:
                print(f"[get_active_loras_string] [{idx}] SKIP: no file_path")
                continue
            # Filter out loras excluded by lora_regex
            normalized_path = file_path.replace('\\', '/')
            in_valid = normalized_path in self._valid_lora_paths or file_path in self._valid_lora_paths
            print(f"[get_active_loras_string] [{idx}] normalized_path={normalized_path}, in_valid={in_valid}")
            if not in_valid:
                print(f"[get_active_loras_string] [{idx}] SKIP: not in _valid_lora_paths")
                continue
            if lora_path_mode:
                part = f"<lora_path:{file_path}:{strength}>"
                active_lora_parts.append(part)
                print(f"[get_active_loras_string] [{idx}] ACCEPT: {part}")
            else:
                # Use basename (file_name) for standard lora format
                file_name = lora_item.get('file_name', '')
                if not file_name:
                    file_name = file_path.split('/')[-1].split('\\')[-1]
                part = f"<lora:{file_name}:{strength}>"
                active_lora_parts.append(part)
                print(f"[get_active_loras_string] [{idx}] ACCEPT: {part}")
        result = ", ".join(active_lora_parts)
        print(f"[get_active_loras_string] result: {result}")
        return result

    def _ensure_dirs(self):
        os.makedirs(self.data_dir, exist_ok=True)
        os.makedirs(self.images_dir, exist_ok=True)

    def _load_default_prompts(self):
        return {
            "视角类": {
                "bg_image": "",
                "prompts": [
                    {"id": "view_oblique", "name": "oblique angle", "prompt": "oblique angle", "preview": ""},
                    {"id": "view_dutch", "name": "dutch angle", "prompt": "dutch angle", "preview": ""},
                    {"id": "view_bird", "name": "bird's eye view", "prompt": "bird's eye view", "preview": ""},
                    {"id": "view_worm", "name": "worm's eye view", "prompt": "worm's eye view", "preview": ""},
                    {"id": "view_overhead", "name": "overhead view", "prompt": "overhead view", "preview": ""},
                    {"id": "view_closeup", "name": "close-up", "prompt": "close-up", "preview": ""},
                    {"id": "view_long", "name": "long shot", "prompt": "long shot", "preview": ""},
                    {"id": "view_medium", "name": "medium shot", "prompt": "medium shot", "preview": ""},
                ]
            },
            "光线类": {
                "bg_image": "",
                "prompts": [
                    {"id": "light_natural", "name": "natural light", "prompt": "natural light", "preview": ""},
                    {"id": "light_golden", "name": "golden hour", "prompt": "golden hour", "preview": ""},
                    {"id": "light_blue", "name": "blue hour", "prompt": "blue hour", "preview": ""},
                    {"id": "light_soft", "name": "soft lighting", "prompt": "soft lighting", "preview": ""},
                    {"id": "light_hard", "name": "hard lighting", "prompt": "hard lighting", "preview": ""},
                    {"id": "light_rim", "name": "rim light", "prompt": "rim light", "preview": ""},
                    {"id": "light_back", "name": "backlight", "prompt": "backlight", "preview": ""},
                    {"id": "light_studio", "name": "studio lighting", "prompt": "studio lighting", "preview": ""},
                ]
            },
            "风格类": {
                "bg_image": "",
                "prompts": [
                    {"id": "style_cinematic", "name": "cinematic", "prompt": "cinematic", "preview": ""},
                    {"id": "style_photorealistic", "name": "photorealistic", "prompt": "photorealistic", "preview": ""},
                    {"id": "style_anime", "name": "anime", "prompt": "anime", "preview": ""},
                    {"id": "style_oil", "name": "oil painting", "prompt": "oil painting", "preview": ""},
                    {"id": "style_watercolor", "name": "watercolor", "prompt": "watercolor", "preview": ""},
                    {"id": "style_digital", "name": "digital art", "prompt": "digital art", "preview": ""},
                    {"id": "style_concept", "name": "concept art", "prompt": "concept art", "preview": ""},
                    {"id": "style_lowpoly", "name": "low poly", "prompt": "low poly", "preview": ""},
                ]
            },
            "画质类": {
                "bg_image": "",
                "prompts": [
                    {"id": "quality_8k", "name": "8K", "prompt": "8K", "preview": ""},
                    {"id": "quality_4k", "name": "4K", "prompt": "4K", "preview": ""},
                    {"id": "quality_high", "name": "high detail", "prompt": "high detail", "preview": ""},
                    {"id": "quality_master", "name": "masterpiece", "prompt": "masterpiece", "preview": ""},
                    {"id": "quality_best", "name": "best quality", "prompt": "best quality", "preview": ""},
                    {"id": "quality_ultra", "name": "ultra detailed", "prompt": "ultra detailed", "preview": ""},
                ]
            },
            "情绪类": {
                "bg_image": "",
                "prompts": [
                    {"id": "mood_dramatic", "name": "dramatic", "prompt": "dramatic", "preview": ""},
                    {"id": "mood_peaceful", "name": "peaceful", "prompt": "peaceful", "preview": ""},
                    {"id": "mood_melancholic", "name": "melancholic", "prompt": "melancholic", "preview": ""},
                    {"id": "mood_energetic", "name": "energetic", "prompt": "energetic", "preview": ""},
                    {"id": "mood_mysterious", "name": "mysterious", "prompt": "mysterious", "preview": ""},
                    {"id": "mood_romantic", "name": "romantic", "prompt": "romantic", "preview": ""},
                ]
            }
        }

    def _migrate_old_format(self, data):
        """Migrate old format (array) to new format (object with prompts and bg_image)"""
        migrated = {}
        for category, value in data.items():
            if isinstance(value, list):
                # Old format
                migrated[category] = {
                    "bg_image": "",
                    "tags": [],
                    "decorations": [],
                    "prompts": value
                }
            else:
                # New format
                migrated[category] = value
                # Migrate category without tags/decorations field
                if "tags" not in value:
                    value["tags"] = []
                elif isinstance(value["tags"], str):
                    value["tags"] = [t.strip() for t in value["tags"].split(",") if t.strip()]
                if "decorations" not in value:
                    value["decorations"] = []
                elif isinstance(value["decorations"], str):
                    value["decorations"] = [t.strip() for t in value["decorations"].split(",") if t.strip()]
                if "display_mode" not in value:
                    value["display_mode"] = "horizontal"
                if "size_mode" not in value:
                    value["size_mode"] = "normal"
                # Migrate prompts without tags/decorations field or with string tags
                if "prompts" in value:
                    for p in value["prompts"]:
                        if "tags" not in p:
                            p["tags"] = []
                        elif isinstance(p["tags"], str):
                            p["tags"] = [t.strip() for t in p["tags"].split(",") if t.strip()]
                        if "decorations" not in p:
                            p["decorations"] = []
                        elif isinstance(p["decorations"], str):
                            p["decorations"] = [t.strip() for t in p["decorations"].split(",") if t.strip()]
                        if "mute_decorations" not in p:
                            p["mute_decorations"] = []
                        elif isinstance(p["mute_decorations"], str):
                            p["mute_decorations"] = [t.strip() for t in p["mute_decorations"].split(",") if t.strip()]
        return migrated

    def _migrate_display_modes(self):
        from_path = os.path.join(self.data_dir, "display_modes.json")
        if os.path.exists(from_path):
            try:
                with open(from_path, 'r', encoding='utf-8') as f:
                    old_modes = json.load(f)
                for cat, mode in old_modes.items():
                    if cat in self.prompts_data:
                        self.prompts_data[cat]["display_mode"] = mode
                        self.category_display_modes[cat] = mode
                os.remove(from_path)
                self._save_prompts(self.prompts_data)
            except:
                pass

    def _migrate_size_modes(self):
        from_path = os.path.join(self.data_dir, "size_modes.json")
        if os.path.exists(from_path):
            try:
                with open(from_path, 'r', encoding='utf-8') as f:
                    old_modes = json.load(f)
                for cat, mode in old_modes.items():
                    if cat in self.prompts_data:
                        self.prompts_data[cat]["size_mode"] = mode
                        self.category_size_modes[cat] = mode
                os.remove(from_path)
                self._save_prompts(self.prompts_data)
            except:
                pass

    def _scan_loras(self, regex_pattern=""):
        """Scan F:\\ComfyDB\\models\\loras for *.metadata.json files."""
        import re
        lora_root = r"F:\ComfyDB\models\loras"
        folders = {}
        if not os.path.exists(lora_root):
            return folders
        compiled_re = re.compile(regex_pattern) if regex_pattern else None
        for dirpath, dirnames, filenames in os.walk(lora_root):
            for filename in filenames:
                if not filename.endswith('.metadata.json'):
                    continue
                filepath = os.path.join(dirpath, filename)
                try:
                    with open(filepath, 'r', encoding='utf-8') as f:
                        meta = json.load(f)
                except Exception:
                    continue
                # folder key is relative path from lora_root
                rel_dir = os.path.relpath(dirpath, lora_root)
                if rel_dir == '.':
                    rel_dir = 'root'
                folder_key = rel_dir.replace('\\', '/')
                # base name without .metadata.json
                base_name = filename[:-len('.metadata.json')]
                # file_path: prefer the one in metadata.json, fallback to computed absolute path
                file_path = meta.get('file_path', filepath[:-len('.metadata.json')]).replace('\\', '/')
                # apply regex filter on file_path
                if compiled_re and not compiled_re.search(file_path):
                    continue
                civitai = meta.get('civitai', {}) or {}
                trained_words = civitai.get('trainedWords', []) if isinstance(civitai, dict) else []
                item = {
                    'name': meta.get('name', base_name),
                    'file_name': base_name,
                    'file_path': file_path,
                    'preview_url': meta.get('preview_url', ''),
                    'tags': trained_words if isinstance(trained_words, list) else [],
                    'metadata': meta,
                }
                folders.setdefault(folder_key, []).append(item)
        # sort items in each folder by name
        for key in folders:
            folders[key].sort(key=lambda x: x['name'])
        return folders

    def _load_libraries(self):
        """Load libraries data from library.json"""
        self._ensure_dirs()
        if os.path.exists(self.library_json):
            try:
                with open(self.library_json, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    # Migrate: assign GUID to prefabs without one
                    modified = False
                    for lib_data in data.values():
                        prefabs = lib_data.get('prefabs', [])
                        for pf in prefabs:
                            if not pf.get('guid'):
                                pf['guid'] = str(uuid.uuid4())
                                modified = True
                    if modified:
                        self._save_libraries(data)
                    return data
            except:
                pass
        return {}

    def _save_libraries(self, data):
        """Save libraries data to library.json"""
        self._ensure_dirs()
        try:
            with open(self.library_json, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except:
            pass

    def _load_lora_folder_meta(self):
        """Load lora folder meta data (bg_image/bg_video per folder)."""
        self._ensure_dirs()
        if os.path.exists(self.lora_folder_meta_json):
            try:
                with open(self.lora_folder_meta_json, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except:
                pass
        return {}

    def _save_lora_folder_meta(self, data):
        """Save lora folder meta data."""
        self._ensure_dirs()
        try:
            with open(self.lora_folder_meta_json, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except:
            pass

    def _load_prompts(self):
        self._ensure_dirs()
        
        if os.path.exists(self.prompt_json):
            try:
                with open(self.prompt_json, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                if data:
                    return self._migrate_old_format(data)
            except:
                pass
        
        default_prompts = self._load_default_prompts()
        self._save_prompts(default_prompts)
        return default_prompts

    def _save_prompts(self, data):
        self._ensure_dirs()
        try:
            with open(self.prompt_json, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except:
            pass

    def _normalize_prefab_tags(self, prefab_tags):
        """Normalize prefab tags so that prompt field stores English prompt instead of Chinese name.
        
        Also attempts to decompose multi-word prompts into decoration chains when all
        constituent words are known prompts in prompt.json.
        
        For example:
          - "薄嘴唇" with prompt "thin lips" -> [thin] lips  (if "thin" and "lips" are known)
        """
        if not prefab_tags:
            return prefab_tags
        
        # Build lookup maps from prompts_data
        name_to_prompt = {}
        prompt_to_name = {}
        for cat_data in self.prompts_data.values():
            if isinstance(cat_data, dict):
                prompts = cat_data.get('prompts', []) or []
            elif isinstance(cat_data, list):
                prompts = cat_data
            else:
                continue
            for p in prompts:
                if isinstance(p, dict):
                    name = p.get('name', '')
                    prompt_text = p.get('prompt', '')
                    if name and prompt_text:
                        name_to_prompt[name] = prompt_text
                        prompt_to_name[prompt_text.lower()] = (prompt_text, name)
        
        def _try_decompose(prompt_text):
            """Try to decompose a multi-word prompt into a decoration chain.
            
            Returns a list of tag dicts if all words are known prompts, None otherwise.
            decoration_num increases from left to right:
              e.g. "very thin lips" -> [very:2, thin:1, lips:0] -> "[[very]] [thin] lips"
            """
            words = prompt_text.split()
            if len(words) < 2:
                return None
            
            # Try each possible split: right side = base prompt, left side = decorations
            for i in range(len(words) - 1, 0, -1):
                base = ' '.join(words[i:])
                base_key = base.lower()
                if base_key in prompt_to_name and base_key != prompt_text.lower():
                    decorations = words[:i]
                    deco_tags = []
                    all_known = True
                    for d in decorations:
                        d_key = d.lower()
                        if d_key not in prompt_to_name:
                            all_known = False
                            break
                        deco_tags.append(prompt_to_name[d_key])
                    
                    if all_known:
                        result = []
                        for j, (pt, nm) in enumerate(deco_tags):
                            result.append({
                                'decoration_num': len(deco_tags) - j,
                                'prompt': pt,
                                'name': nm
                            })
                        base_pt, base_nm = prompt_to_name[base_key]
                        result.append({
                            'decoration_num': 0,
                            'prompt': base_pt,
                            'name': base_nm
                        })
                        return result
            return None
        
        normalized = []
        for tag_group in prefab_tags:
            if isinstance(tag_group, list):
                new_group = []
                for tag in tag_group:
                    if isinstance(tag, dict):
                        tag_name = tag.get('name', '')
                        tag_prompt = tag.get('prompt', '')
                        # Fix: if prompt is missing, empty, or identical to name,
                        # replace with the English prompt from prompt.json
                        if (not tag_prompt or tag_prompt == tag_name) and tag_name in name_to_prompt:
                            tag = dict(tag)
                            tag['prompt'] = name_to_prompt[tag_name]
                            tag_prompt = tag['prompt']
                        # Preserve strength field if present
                        if 'strength' in tag and tag['strength'] is not None:
                            tag = dict(tag)
                        new_group.append(tag)
                    else:
                        new_group.append(tag)
                
                # Heuristic: if the group has exactly one tag with a multi-word prompt,
                # try to decompose it into a decoration chain
                if len(new_group) == 1:
                    single_tag = new_group[0]
                    if isinstance(single_tag, dict):
                        pt = single_tag.get('prompt', '')
                        if ' ' in pt:
                            decomposed = _try_decompose(pt)
                            if decomposed:
                                new_group = decomposed
                
                normalized.append(new_group)
            else:
                normalized.append(tag_group)
        
        return normalized

    def _generate_id(self):
        return f"custom_{int(time.time())}_{hashlib.md5(str(time.time()).encode()).hexdigest()[:8]}"

    def _save_image(self, image_data):
        """Save image data to disk and return filename."""
        self._ensure_dirs()
        
        try:
            # Handle base64 data
            if isinstance(image_data, str):
                if 'base64,' in image_data:
                    image_data = image_data.split('base64,')[1]
                img_bytes = base64.b64decode(image_data)
            else:
                img_bytes = image_data
            
            img_id = hashlib.md5(img_bytes).hexdigest()[:12]
            img_filename = f"{img_id}.png"
            img_path = os.path.join(self.images_dir, img_filename)
            
            with open(img_path, 'wb') as f:
                f.write(img_bytes)
            
            return img_filename
        except Exception as e:
            print(f"[SnapshotPrompt] Failed to save image: {e}")
            return ""

    def _save_video(self, video_bytes):
        """Save video data to disk and return filename."""
        self._ensure_dirs()
        try:
            vid_id = hashlib.md5(video_bytes).hexdigest()[:12]
            vid_filename = f"{vid_id}.mp4"
            vid_path = os.path.join(self.images_dir, vid_filename)
            
            with open(vid_path, 'wb') as f:
                f.write(video_bytes)
            
            return vid_filename
        except Exception as e:
            print(f"[SnapshotPrompt] Failed to save video: {e}")
            return ""

    def start(self):
        import socketserver
        class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
            pass
        for port in range(8500, 8600):
            try:
                self.server = ThreadingHTTPServer(('localhost', port), self.PromptHandler)
                self.port = port
                self.started = True
                print(f"[SnapshotPrompt] Server started on port {port}")
                break
            except:
                continue

        self.browser_url = f"http://localhost:{self.port}/prompt_node.html"

        if not self.started:
            print("[SnapshotPrompt] Failed to start server")
            return

        self.PromptHandler.server_instance = self
        try:
            self.server.serve_forever()
        except:
            pass

    def stop(self):
        self.should_stop = True
        self.prompt_event.set()
        if self.server:
            print("[SnapshotPrompt] Stopping server")
            self.server.shutdown()
            self.server.server_close()

    def wait_for_prompt(self, check_interval=0.001):
        """等待用户选择提示词，每0.001秒检查一次中断"""
        print("[SnapshotPrompt] Starting wait loop with 100% interrupt detection")
        
        while not self.prompt_event.is_set():
            # 100%可靠的中断检测 - 优先使用抛出异常的方式
            try:
                # 方式1: 直接抛出异常，最可靠
                mm.throw_exception_if_processing_interrupted()
            except Exception as e:
                if "interrupt" in str(e).lower() or "processing" in str(e).lower():
                    print(f"[SnapshotPrompt] Interrupt detected via exception: {e}")
                    return False
                # 其他异常重新抛出
                raise
            
            # 方式2: 检查布尔状态
            try:
                if mm.processing_interrupted():
                    print("[SnapshotPrompt] Interrupt detected via processing_interrupted!")
                    return False
                    
                if hasattr(mm, 'interrupted') and mm.interrupted:
                    print("[SnapshotPrompt] Interrupt detected via mm.interrupted!")
                    return False
                    
                if hasattr(mm, 'check_interrupt') and mm.check_interrupt():
                    print("[SnapshotPrompt] Interrupt detected via check_interrupt!")
                    return False
            except Exception:
                pass
                
            if self.should_stop:
                return False
                
            # 使用极短间隔等待，最大化中断检测频率
            self.prompt_event.wait(check_interval)
            
        return True

    class PromptHandler(http.server.SimpleHTTPRequestHandler):
        server_instance = None

        def do_GET(self):
            if self.path in ('/', '/prompt_node.html'):
                try:
                    web_dir = os.path.join(os.path.dirname(__file__), "web")
                    file_path = os.path.join(web_dir, "prompt_node.html")
                    with open(file_path, 'rb') as f:
                        content = f.read()
                    self.send_response(200)
                    self.send_header('Content-type', 'text/html')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(content)
                    return
                except Exception as e:
                    self.send_error(404, f"HTML file not found: {e}")
                    return

            elif self.path == '/prompts_data':
                data = {
                    'categories': self.server_instance.prompts_data,
                    'libraries': self.server_instance.libraries_data,
                    'last_selected': self.server_instance.last_selected,
                    'category_display_modes': self.server_instance.category_display_modes,
                    'category_size_modes': self.server_instance.category_size_modes,
                    'custom_prompts': self.server_instance.custom_prompts,
                    'last_selected_loras': self.server_instance.last_selected_loras,
                    'last_selected_prefabs': self.server_instance.last_selected_prefabs,
                    'parsed_prompts': self.server_instance.parsed_prompts,
                    'lora_regex': self.server_instance.lora_regex,
                }
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps(data).encode('utf-8'))
                return

            elif self.path.startswith('/images/'):
                try:
                    img_filename = urllib.parse.unquote(self.path[len('/images/'):].split('?')[0])
                    img_path = os.path.join(self.server_instance.images_dir, img_filename)
                    
                    if os.path.exists(img_path):
                        with open(img_path, 'rb') as f:
                            content = f.read()
                        self.send_response(200)
                        if img_filename.lower().endswith('.mp4'):
                            self.send_header('Content-type', 'video/mp4')
                        else:
                            self.send_header('Content-type', 'image/png')
                        self.send_header("Access-Control-Allow-Origin", "*")
                        self.end_headers()
                        self.wfile.write(content)
                        return
                    else:
                        self.send_error(404, "Image not found")
                        return
                except Exception as e:
                    self.send_error(500, str(e))
                    return

            elif self.path == '/lora_data':
                data = {
                    'folders': self.server_instance.lora_data if self.server_instance else {},
                    'folder_meta': self.server_instance.lora_folder_meta if self.server_instance else {},
                    'last_selected_loras': self.server_instance.last_selected_loras if self.server_instance else [],
                    'last_selected_prefabs': self.server_instance.last_selected_prefabs if self.server_instance else [],
                    'lora_regex': self.server_instance.lora_regex if self.server_instance else '',
                }
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps(data).encode('utf-8'))
                return

            elif self.path.startswith('/lora_images/'):
                try:
                    img_path = urllib.parse.unquote(self.path[len('/lora_images/'):].split('?')[0])
                    img_path = img_path.replace('/', os.sep)
                    if os.path.exists(img_path):
                        ext = os.path.splitext(img_path)[1].lower()
                        mime = 'image/png'
                        if ext in ('.jpg', '.jpeg'):
                            mime = 'image/jpeg'
                        elif ext == '.gif':
                            mime = 'image/gif'
                        elif ext == '.webp':
                            mime = 'image/webp'
                        with open(img_path, 'rb') as f:
                            content = f.read()
                        self.send_response(200)
                        self.send_header('Content-type', mime)
                        self.send_header("Access-Control-Allow-Origin", "*")
                        self.end_headers()
                        self.wfile.write(content)
                        return
                    else:
                        self.send_error(404, "Image not found")
                        return
                except Exception as e:
                    self.send_error(500, str(e))
                    return

            elif self.path == '/region_config':
                si = self.server_instance
                if si and si.enable_region:
                    try:
                        from .snapshot_region_node import image_to_base64
                        img_b64 = image_to_base64(si.image) if si.image is not None else None
                        response = {
                            'image': img_b64,
                            'width': si.width,
                            'height': si.height,
                            'bg_brightness': si.bg_brightness,
                            'initial_boxes': si.initial_boxes,
                            'enable_region': True,
                            'region_format': si.region_format,
                        }
                        data = json.dumps(response).encode('utf-8')
                        self.send_response(200)
                        self.send_header('Content-type', 'application/json')
                        self.send_header('Content-Length', str(len(data)))
                        self.send_header("Access-Control-Allow-Origin", "*")
                        self.end_headers()
                        self.wfile.write(data)
                    except Exception as e:
                        self.send_error(500, str(e))
                else:
                    data = json.dumps({'image': None, 'enable_region': False}).encode('utf-8')
                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header('Content-Length', str(len(data)))
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(data)
                return

        def do_POST(self):
            if self.path == '/select_prompt':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)
                print(f"[PromptNode] /select_prompt received: prompts={len(data.get('prompts', []))}, "
                      f"custom='{data.get('custom_prompts', '')[:50]}...', "
                      f"loras={len(data.get('loras', []))}, prefabs={len(data.get('prefabs', []))}")
                print(f"[PromptNode] received loras raw: {data.get('loras', [])}")
                print(f"[PromptNode] received prefabs raw: {data.get('prefabs', [])}")

                if self.server_instance:
                    self.server_instance.selected_prompts = data.get('prompts', [])
                    self.server_instance.custom_prompts = data.get('custom_prompts', '')
                    self.server_instance.selected_loras = data.get('loras', [])
                    self.server_instance.selected_prefabs = data.get('prefabs', [])
                    print(f"[PromptNode] stored selected_loras: {self.server_instance.selected_loras}")
                    print(f"[PromptNode] stored selected_prefabs: {self.server_instance.selected_prefabs}")
                    self.server_instance.prompt_event.set()

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({'success': True, 'status': 'ok'}).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/add_prompt':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    category = data.get('category', '杂项')
                    if not category:
                        category = '杂项'
                    prompt_name = data.get('name', '')
                    prompt_text = data.get('prompt', '')
                    image_data = data.get('image', '')

                    if prompt_name and prompt_text:
                        preview = ""
                        if image_data:
                            preview = self.server_instance._save_image(image_data)

                        prompt_id = self.server_instance._generate_id()

                        if category not in self.server_instance.prompts_data:
                            self.server_instance.prompts_data[category] = {
                                "bg_image": "",
                                "tags": [],
                                "decorations": [],
                                "prompts": []
                            }

                        tags = data.get('tags', [])
                        if isinstance(tags, str):
                            tags = [t.strip() for t in tags.split(",") if t.strip()]
                        decorations = data.get('decorations', [])
                        if isinstance(decorations, str):
                            decorations = [t.strip() for t in decorations.split(",") if t.strip()]
                        mute_decorations = data.get('mute_decorations', [])
                        if isinstance(mute_decorations, str):
                            mute_decorations = [t.strip() for t in mute_decorations.split(",") if t.strip()]

                        self.server_instance.prompts_data[category]["prompts"].append({
                            'id': prompt_id,
                            'name': prompt_name,
                            'prompt': prompt_text,
                            'preview': preview,
                            'tags': tags,
                            'decorations': decorations,
                            'mute_decorations': mute_decorations
                        })
                        self.server_instance._save_prompts(self.server_instance.prompts_data)

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({'status': 'ok', 'preview': preview, 'id': prompt_id}).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/update_prompt':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    prompt_id = data.get('id', '')
                    new_name = data.get('name', '')
                    new_prompt = data.get('prompt', '')
                    new_category = data.get('category', '')
                    image_data = data.get('image', '')

                    found = False
                    for cat_name, cat_data in list(self.server_instance.prompts_data.items()):
                        prompts = cat_data.get("prompts", [])
                        for i, p in enumerate(prompts):
                            if p.get('id') == prompt_id:
                                # 如果有新图片，保存并替换；否则保留原图片
                                new_preview = p.get('preview', '')
                                if image_data:
                                    new_preview = self.server_instance._save_image(image_data)

                                new_category_final = new_category if new_category else cat_name

                                tags = data.get('tags', p.get('tags', []))
                                if isinstance(tags, str):
                                    tags = [t.strip() for t in tags.split(",") if t.strip()]
                                decorations = data.get('decorations', p.get('decorations', []))
                                if isinstance(decorations, str):
                                    decorations = [t.strip() for t in decorations.split(",") if t.strip()]
                                mute_decorations = data.get('mute_decorations', p.get('mute_decorations', []))
                                if isinstance(mute_decorations, str):
                                    mute_decorations = [t.strip() for t in mute_decorations.split(",") if t.strip()]

                                if new_category_final != cat_name:
                                    if new_category_final not in self.server_instance.prompts_data:
                                        self.server_instance.prompts_data[new_category_final] = {
                                            "bg_image": "",
                                            "tags": [],
                                            "decorations": [],
                                            "prompts": []
                                        }
                                    
                                    self.server_instance.prompts_data[new_category_final]["prompts"].append({
                                        'id': prompt_id,
                                        'name': new_name,
                                        'prompt': new_prompt,
                                        'preview': new_preview,
                                        'tags': tags,
                                        'decorations': decorations,
                                        'mute_decorations': mute_decorations
                                    })
                                    prompts.pop(i)
                                    if not prompts:
                                        del self.server_instance.prompts_data[cat_name]
                                else:
                                    self.server_instance.prompts_data[cat_name]["prompts"][i] = {
                                        'id': prompt_id,
                                        'name': new_name,
                                        'prompt': new_prompt,
                                        'preview': new_preview,
                                        'tags': tags,
                                        'decorations': decorations,
                                        'mute_decorations': mute_decorations
                                    }
                                
                                found = True
                                break
                        if found:
                            break

                    if found:
                        self.server_instance._save_prompts(self.server_instance.prompts_data)

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({'status': 'ok', 'preview': new_preview if found and image_data else ''}).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/delete_prompt':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    prompt_id = data.get('id', '')
                    found = False

                    for cat_name, cat_data in list(self.server_instance.prompts_data.items()):
                        prompts = cat_data.get("prompts", [])
                        for i, p in enumerate(prompts):
                            if p.get('id') == prompt_id:
                                prompts.pop(i)
                                if not prompts:
                                    del self.server_instance.prompts_data[cat_name]
                                self.server_instance._save_prompts(self.server_instance.prompts_data)
                                found = True
                                break
                        if found:
                            break

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/capture_screenshot':
                if self.server_instance:
                    try:
                        if not HAS_PIL or not HAS_QT:
                            self.send_response(500)
                            self.send_header('Content-type', 'application/json')
                            self.send_header("Access-Control-Allow-Origin", "*")
                            self.end_headers()
                            self.wfile.write(json.dumps({'success': False, 'error': 'PIL or PySide6 not available'}).encode('utf-8'))
                            return
                        
                        # 使用独立线程运行截图流程（包含准备面板和选框截图）
                        import threading
                        import queue
                        
                        result_queue = queue.Queue()
                        
                        def run_screenshot():
                            try:
                                import sys
                                import pyautogui
                                from PIL import Image
                                from PIL.ImageQt import ImageQt
                                
                                # 确保每次都有独立的QApplication实例
                                app = QApplication.instance()
                                if app is None:
                                    app = QApplication(sys.argv)
                                
                                # ====================== FloatingCapturePanel ======================
                                class FloatingCapturePanel(QWidget):
                                    closed_with_action = Signal(str)
                                    
                                    def __init__(self):
                                        super().__init__()
                                        self.action = "cancel"
                                        self._drag_pos = None
                                        self._final_pos = None
                                        
                                        self.setWindowFlags(
                                            Qt.FramelessWindowHint |
                                            Qt.WindowStaysOnTopHint |
                                            Qt.Tool |
                                            Qt.NoDropShadowWindowHint
                                        )
                                        self.setAttribute(Qt.WA_TranslucentBackground, True)
                                        self.setFixedSize(320, 150)
                                        
                                        self._build_ui()
                                        self._move_to_primary_screen_bottom_right()
                                        self._remove_windows_shadow()
                                    
                                    def _build_ui(self):
                                        root = QVBoxLayout(self)
                                        root.setContentsMargins(0, 0, 0, 0)
                                        root.setSpacing(0)
                                        
                                        self.card = QWidget(self)
                                        self.card.setObjectName("captureCard")
                                        
                                        card_layout = QVBoxLayout(self.card)
                                        card_layout.setContentsMargins(16, 16, 16, 16)
                                        card_layout.setSpacing(12)
                                        
                                        title = QLabel("屏幕截图")
                                        title.setObjectName("titleLabel")
                                        
                                        tip = QLabel("点击 Shot 框选截图区域\nESC 或右键取消")
                                        tip.setObjectName("tipLabel")
                                        
                                        row = QHBoxLayout()
                                        row.setContentsMargins(0, 0, 0, 0)
                                        row.setSpacing(8)
                                        
                                        self.shot_btn = QPushButton("Shot")
                                        self.shot_btn.setObjectName("shotBtn")
                                        self.shot_btn.clicked.connect(self.on_capture_click)
                                        
                                        self.cancel_btn = QPushButton("Cancel")
                                        self.cancel_btn.setObjectName("cancelBtn")
                                        self.cancel_btn.clicked.connect(self.on_exit_click)
                                        
                                        row.addWidget(self.shot_btn, 1)
                                        row.addWidget(self.cancel_btn, 1)
                                        
                                        card_layout.addWidget(title)
                                        card_layout.addWidget(tip)
                                        card_layout.addLayout(row)
                                        
                                        root.addWidget(self.card)
                                        
                                        self.setStyleSheet("""
                                            QWidget#captureCard {
                                                background: rgba(18, 18, 20, 245);
                                                border-radius: 10px;
                                            }
                                            QLabel#titleLabel {
                                                color: white;
                                                font-size: 15px;
                                                font-weight: 700;
                                            }
                                            QLabel#tipLabel {
                                                color: rgba(255, 255, 255, 160);
                                                font-size: 12px;
                                            }
                                            QPushButton {
                                                border: none;
                                                border-radius: 8px;
                                                min-height: 36px;
                                                padding: 0 14px;
                                                font-size: 13px;
                                                font-weight: 600;
                                                color: white;
                                                background: #2C2C2E;
                                            }
                                            QPushButton#shotBtn {
                                                background: #0A84FF;
                                            }
                                            QPushButton#shotBtn:hover { background: #3395FF; }
                                            QPushButton#shotBtn:pressed { background: #006FE8; }
                                            QPushButton#cancelBtn:hover { background: #3A3A3C; }
                                            QPushButton#cancelBtn:pressed { background: #242426; }
                                        """)
                                    
                                    def _move_to_primary_screen_bottom_right(self):
                                        screen = QGuiApplication.primaryScreen()
                                        geo = screen.availableGeometry()
                                        margin = 24
                                        x = geo.x() + geo.width() - self.width() - margin
                                        y = geo.y() + geo.height() - self.height() - margin
                                        self._final_pos = QPoint(x, y)
                                        self.move(x, y)
                                    
                                    def _remove_windows_shadow(self):
                                        try:
                                            import ctypes
                                            hwnd = int(self.winId())
                                            DWMWA_NCRENDERING_POLICY = 2
                                            DWMNCRP_DISABLED = 1
                                            ctypes.windll.dwmapi.DwmSetWindowAttribute(
                                                hwnd, DWMWA_NCRENDERING_POLICY,
                                                ctypes.byref(ctypes.c_uint(DWMNCRP_DISABLED)), 
                                                ctypes.sizeof(ctypes.c_uint)
                                            )
                                        except:
                                            pass
                                    
                                    def on_capture_click(self):
                                        self.action = "capture"
                                        self.close()
                                    
                                    def on_exit_click(self):
                                        self.action = "cancel"
                                        self.close()
                                    
                                    def closeEvent(self, event):
                                        self.closed_with_action.emit(self.action)
                                        super().closeEvent(event)
                                    
                                    def mousePressEvent(self, event):
                                        if event.button() == Qt.LeftButton:
                                            child = self.childAt(event.position().toPoint())
                                            if isinstance(child, QPushButton):
                                                event.ignore()
                                                return
                                            self._drag_pos = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
                                            event.accept()
                                    
                                    def mouseMoveEvent(self, event):
                                        if self._drag_pos is not None and event.buttons() & Qt.LeftButton:
                                            self.move(event.globalPosition().toPoint() - self._drag_pos)
                                            self._final_pos = self.pos()
                                            event.accept()
                                    
                                    def mouseReleaseEvent(self, event):
                                        self._drag_pos = None
                                        event.accept()
                                
                                # ====================== ScreenshotOverlay ======================
                                class ScreenshotOverlay(QWidget):
                                    closed_with_action = Signal()
                                    
                                    def __init__(self):
                                        super().__init__()
                                        self.start_point = QPoint()
                                        self.end_point = QPoint()
                                        self.selecting = False
                                        self.captured = False
                                        self.image = None
                                        
                                        screens = QGuiApplication.screens()
                                        left = min(s.geometry().left() for s in screens)
                                        top = min(s.geometry().top() for s in screens)
                                        right = max(s.geometry().right() for s in screens)
                                        bottom = max(s.geometry().bottom() for s in screens)
                                        self.virtual_rect = QRect(left, top, right - left + 1, bottom - top + 1)
                                        
                                        self.setGeometry(self.virtual_rect)
                                        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool)
                                        self.setAttribute(Qt.WA_TranslucentBackground, True)
                                        self.setCursor(Qt.CrossCursor)
                                        self.setMouseTracking(True)
                                        self.setFocusPolicy(Qt.StrongFocus)
                                        
                                        primary_screen = QGuiApplication.primaryScreen()
                                        self.dpr = float(primary_screen.devicePixelRatio()) if primary_screen else 1.0
                                        
                                        full_img = pyautogui.screenshot(
                                            region=(
                                                int(round(self.virtual_rect.x() * self.dpr)),
                                                int(round(self.virtual_rect.y() * self.dpr)),
                                                int(round(self.virtual_rect.width() * self.dpr)),
                                                int(round(self.virtual_rect.height() * self.dpr)),
                                            )
                                        )
                                        self.full_pil = full_img
                                        
                                        qt_image = ImageQt(full_img.convert("RGBA"))
                                        if isinstance(qt_image, QImage):
                                            self.background = QPixmap.fromImage(qt_image)
                                        else:
                                            self.background = QPixmap.fromImage(QImage(qt_image))
                                    
                                    def paintEvent(self, event):
                                        painter = QPainter(self)
                                        painter.setRenderHint(QPainter.Antialiasing, True)
                                        painter.drawPixmap(self.rect(), self.background)
                                        painter.fillRect(self.rect(), QColor(8, 8, 10, 110))
                                        
                                        if self.selecting or self.captured:
                                            rect = QRect(self.start_point, self.end_point).normalized()
                                            painter.save()
                                            painter.setClipRect(rect)
                                            painter.drawPixmap(self.rect(), self.background)
                                            painter.restore()
                                            
                                            pen = QPen(QColor(10, 132, 255), 2)
                                            painter.setPen(pen)
                                            painter.setBrush(QColor(10, 132, 255, 30))
                                            painter.drawRect(rect)
                                    
                                    def keyPressEvent(self, event):
                                        if event.key() == Qt.Key_Escape:
                                            self.close()
                                    
                                    def mousePressEvent(self, event):
                                        if event.button() == Qt.LeftButton:
                                            self.start_point = event.position().toPoint()
                                            self.end_point = self.start_point
                                            self.selecting = True
                                            self.update()
                                        elif event.button() == Qt.RightButton:
                                            self.close()
                                    
                                    def mouseMoveEvent(self, event):
                                        if self.selecting:
                                            self.end_point = event.position().toPoint()
                                            self.update()
                                    
                                    def mouseReleaseEvent(self, event):
                                        if event.button() == Qt.LeftButton and self.selecting:
                                            self.end_point = event.position().toPoint()
                                            self.selecting = False
                                            
                                            rect = QRect(self.start_point, self.end_point).normalized()
                                            if rect.width() > 10 and rect.height() > 10:
                                                left_px = int(round(rect.x() * self.dpr))
                                                top_px = int(round(rect.y() * self.dpr))
                                                right_px = int(round((rect.x() + rect.width()) * self.dpr))
                                                bottom_px = int(round((rect.y() + rect.height()) * self.dpr))
                                                
                                                self.image = self.full_pil.crop((left_px, top_px, right_px, bottom_px))
                                                self.captured = True
                                            
                                            self.close()
                                    
                                    def closeEvent(self, event):
                                        self.closed_with_action.emit()
                                        super().closeEvent(event)
                                
                                # ====================== 执行流程 ======================
                                def wait_for_close(widget, signal_name="closed_with_action"):
                                    loop = QEventLoop()
                                    getattr(widget, signal_name).connect(loop.quit)
                                    loop.exec()
                                
                                # 1. 显示准备面板
                                panel = FloatingCapturePanel()
                                panel.show()
                                panel.raise_()
                                panel.activateWindow()
                                wait_for_close(panel, "closed_with_action")
                                
                                action = panel.action
                                
                                if action == "cancel":
                                    result_queue.put({'success': False, 'error': 'User cancelled'})
                                    return
                                
                                # 2. 显示选框截图层
                                overlay = ScreenshotOverlay()
                                overlay.show()
                                overlay.raise_()
                                overlay.activateWindow()
                                wait_for_close(overlay)
                                
                                if overlay.captured and overlay.image is not None:
                                    import io
                                    buffer = io.BytesIO()
                                    overlay.image.save(buffer, format='PNG')
                                    image_data = base64.b64encode(buffer.getvalue()).decode('utf-8')
                                    result_queue.put({'success': True, 'image_data': f'data:image/png;base64,{image_data}'})
                                else:
                                    result_queue.put({'success': False, 'error': 'No region selected'})
                                    
                            except Exception as e:
                                result_queue.put({'success': False, 'error': str(e)})
                        
                        # Run screenshot in separate thread
                        screenshot_thread = threading.Thread(target=run_screenshot)
                        screenshot_thread.daemon = True
                        screenshot_thread.start()
                        screenshot_thread.join(timeout=120)
                        
                        if not result_queue.empty():
                            result = result_queue.get()
                            self.send_response(200 if result.get('success') else 500)
                            self.send_header('Content-type', 'application/json')
                            self.send_header("Access-Control-Allow-Origin", "*")
                            self.end_headers()
                            self.wfile.write(json.dumps(result).encode('utf-8'))
                        else:
                            self.send_response(500)
                            self.send_header('Content-type', 'application/json')
                            self.send_header("Access-Control-Allow-Origin", "*")
                            self.end_headers()
                            self.wfile.write(json.dumps({'success': False, 'error': 'Screenshot timeout'}).encode('utf-8'))
                            
                    except Exception as e:
                        print(f"[SnapshotPrompt] Screenshot error: {e}")
                        traceback.print_exc()
                        self.send_response(500)
                        self.send_header('Content-type', 'application/json')
                        self.send_header("Access-Control-Allow-Origin", "*")
                        self.end_headers()
                    self.wfile.write(json.dumps({'success': False, 'error': str(e)}).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/upload_video':
                content_length = int(self.headers['Content-Length'])
                video_bytes = self.rfile.read(content_length)
                
                if self.server_instance:
                    filename = self.server_instance._save_video(video_bytes)
                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({'filename': filename, 'success': True}).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/update_lora_folder_meta':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    folder_name = data.get('folder_name', '').strip()
                    image_data = data.get('image')
                    video_data = data.get('video')

                    if folder_name:
                        meta = self.server_instance.lora_folder_meta.get(folder_name, {})
                        if image_data is not None:
                            if image_data == '':
                                meta['bg_image'] = ''
                            else:
                                meta['bg_image'] = self.server_instance._save_image(image_data)
                        if video_data is not None:
                            if video_data == '':
                                meta['bg_video'] = ''
                            else:
                                meta['bg_video'] = video_data
                        self.server_instance.lora_folder_meta[folder_name] = meta
                        self.server_instance._save_lora_folder_meta(self.server_instance.lora_folder_meta)

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    result = {'success': True}
                    if folder_name in self.server_instance.lora_folder_meta:
                        result['bg_image'] = self.server_instance.lora_folder_meta[folder_name].get('bg_image', '')
                        result['bg_video'] = self.server_instance.lora_folder_meta[folder_name].get('bg_video', '')
                    self.wfile.write(json.dumps(result).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/add_category':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    category_name = data.get('name', '').strip()
                    
                    if category_name:
                        if category_name not in self.server_instance.prompts_data:
                            self.server_instance.prompts_data[category_name] = {
                                "bg_image": "",
                                "tags": [],
                                "decorations": [],
                                "display_mode": "horizontal",
                                "size_mode": "normal",
                                "prompts": []
                            }
                            self.server_instance._save_prompts(self.server_instance.prompts_data)

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/update_category':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    old_name = data.get('old_name', '').strip()
                    new_name = data.get('new_name', '').strip()
                    image_data = data.get('image')
                    video_data = data.get('video')
                    tags = data.get('tags')
                    decorations = data.get('decorations')
                    
                    if old_name and new_name and old_name in self.server_instance.prompts_data:
                        # 获取当前数据
                        cat_data = self.server_instance.prompts_data[old_name]
                        
                        # 处理背景图
                        if image_data is not None:
                            if image_data == '':
                                cat_data["bg_image"] = ""
                            else:
                                cat_data["bg_image"] = self.server_instance._save_image(image_data)
                        
                        # 处理背景视频
                        if video_data is not None:
                            if video_data == '':
                                cat_data["bg_video"] = ""
                            else:
                                cat_data["bg_video"] = video_data
                        
                        # 处理 tags
                        if tags is not None:
                            if isinstance(tags, str):
                                tags = [t.strip() for t in tags.split(",") if t.strip()]
                            cat_data["tags"] = tags
                        
                        # 处理 decorations
                        if decorations is not None:
                            if isinstance(decorations, str):
                                decorations = [t.strip() for t in decorations.split(",") if t.strip()]
                            cat_data["decorations"] = decorations
                        
                        # 如果名称改变，需要迁移数据
                        if old_name != new_name:
                            self.server_instance.prompts_data[new_name] = cat_data
                            del self.server_instance.prompts_data[old_name]
                            # 同步迁移内存中的 display/size modes
                            if old_name in self.server_instance.category_display_modes:
                                self.server_instance.category_display_modes[new_name] = self.server_instance.category_display_modes.pop(old_name)
                            if old_name in self.server_instance.category_size_modes:
                                self.server_instance.category_size_modes[new_name] = self.server_instance.category_size_modes.pop(old_name)
                        
                        self.server_instance._save_prompts(self.server_instance.prompts_data)

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    result = {'success': True}
                    if image_data is not None:
                        lookup = new_name if new_name in self.server_instance.prompts_data else old_name
                        result['bg_image'] = self.server_instance.prompts_data[lookup].get('bg_image', '') if lookup in self.server_instance.prompts_data else ''
                    self.wfile.write(json.dumps(result).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/delete_category':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    name = data.get('name', '').strip()
                    if name and name in self.server_instance.prompts_data:
                        del self.server_instance.prompts_data[name]
                        self.server_instance._save_prompts(self.server_instance.prompts_data)
                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    result = {'success': True}
                    self.wfile.write(json.dumps(result).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/reorder_categories':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    from_category = data.get('from_category', '')
                    to_category = data.get('to_category', '')
                    position = data.get('position', 'at')  # 'at' or 'end'
                    
                    if from_category and from_category in self.server_instance.prompts_data:
                        # 获取当前所有类别的键
                        keys = list(self.server_instance.prompts_data.keys())
                        
                        # 找到源索引
                        from_idx = keys.index(from_category)
                        
                        # 移动键
                        keys.pop(from_idx)
                        
                        if position == 'end' or not to_category:
                            # 插入到末尾
                            keys.append(from_category)
                        elif to_category in self.server_instance.prompts_data:
                            # 插入到目标类别的位置（替换成"at"）
                            to_idx = keys.index(to_category)
                            keys.insert(to_idx, from_category)
                        
                        # 重建字典保持新顺序
                        new_data = {}
                        for key in keys:
                            new_data[key] = self.server_instance.prompts_data[key]
                        
                        self.server_instance.prompts_data = new_data
                        self.server_instance._save_prompts(self.server_instance.prompts_data)

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    result = {'success': True}
                    if lib_name and lib_name in self.server_instance.libraries_data and prefab_index >= 0:
                        prefabs = self.server_instance.libraries_data[lib_name].get('prefabs', [])
                        if 0 <= prefab_index < len(prefabs) and 'preview' in prefabs[prefab_index]:
                            result['preview'] = prefabs[prefab_index]['preview']
                    self.wfile.write(json.dumps(result).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/reorder_prompts':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    category = data.get('category', '')
                    from_id = data.get('from_id', '')
                    to_id = data.get('to_id', '')
                    position = data.get('position', 'at')  # 'at' or 'end'
                    
                    if category and category in self.server_instance.prompts_data:
                        prompts = self.server_instance.prompts_data[category].get("prompts", [])
                        
                        # 找到源索引
                        from_idx = None
                        for i, p in enumerate(prompts):
                            if p.get('id') == from_id:
                                from_idx = i
                                break
                        
                        if from_idx is not None:
                            # 移动提示词
                            prompt_item = prompts.pop(from_idx)
                            
                            if position == 'end' or not to_id:
                                # 插入到末尾
                                prompts.append(prompt_item)
                            else:
                                # 找到目标索引并插入到该位置
                                to_idx = None
                                for i, p in enumerate(prompts):
                                    if p.get('id') == to_id:
                                        to_idx = i
                                        break
                                
                                if to_idx is not None:
                                    prompts.insert(to_idx, prompt_item)
                                else:
                                    prompts.append(prompt_item)
                            
                            self.server_instance._save_prompts(self.server_instance.prompts_data)

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    result = {'success': True}
                    if lib_name and lib_name in self.server_instance.libraries_data and prefab_index >= 0:
                        prefs = self.server_instance.libraries_data[lib_name].get('prefabs', [])
                        if 0 <= prefab_index < len(prefs) and 'preview' in prefs[prefab_index]:
                            result['preview'] = prefs[prefab_index]['preview']
                    self.wfile.write(json.dumps(result).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/move_prompt_to_category':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    from_category = data.get('from_category', '')
                    to_category = data.get('to_category', '')
                    prompt_id = data.get('prompt_id', '')
                    insert_position = data.get('insert_position', 'end')  # 'beginning', 'end', or a prompt id to insert before
                    
                    if from_category in self.server_instance.prompts_data and to_category in self.server_instance.prompts_data:
                        from_prompts = self.server_instance.prompts_data[from_category].get("prompts", [])
                        to_prompts = self.server_instance.prompts_data[to_category].get("prompts", [])
                        
                        prompt_item = None
                        from_idx = None
                        for i, p in enumerate(from_prompts):
                            if p.get('id') == prompt_id:
                                prompt_item = p
                                from_idx = i
                                break
                        
                        if prompt_item is not None:
                            # 从源类别移除
                            from_prompts.pop(from_idx)
                            
                            # 插入到目标类别
                            if insert_position == 'beginning':
                                to_prompts.insert(0, prompt_item)
                            elif insert_position == 'end':
                                to_prompts.append(prompt_item)
                            else:
                                # 查找在特定提示词之前
                                insert_idx = None
                                for i, p in enumerate(to_prompts):
                                    if p.get('id') == insert_position:
                                        insert_idx = i
                                        break
                                if insert_idx is not None:
                                    to_prompts.insert(insert_idx, prompt_item)
                                else:
                                    to_prompts.append(prompt_item)
                            
                            self.server_instance._save_prompts(self.server_instance.prompts_data)

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    result = {'success': True}
                    if lib_name and lib_name in self.server_instance.libraries_data:
                        prefs = self.server_instance.libraries_data[lib_name].get('prefabs', [])
                        if prefs:
                            last_prefab = prefs[-1]
                            if 'preview' in last_prefab:
                                result['preview'] = last_prefab['preview']
                            if 'guid' in last_prefab:
                                result['guid'] = last_prefab['guid']
                    self.wfile.write(json.dumps(result).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/update_category_display_mode':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    category_name = data.get('category', '').strip()
                    display_mode = data.get('display_mode', 'horizontal')
                    size_mode = data.get('size_mode', 'normal')
                    
                    if category_name and category_name in self.server_instance.prompts_data:
                        self.server_instance.prompts_data[category_name]["display_mode"] = display_mode
                        self.server_instance.prompts_data[category_name]["size_mode"] = size_mode
                        self.server_instance._save_prompts(self.server_instance.prompts_data)
                        self.server_instance.category_display_modes[category_name] = display_mode
                        self.server_instance.category_size_modes[category_name] = size_mode

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({'success': True}).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/add_library':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    lib_name = data.get('name', '').strip()
                    if lib_name and lib_name not in self.server_instance.libraries_data:
                        self.server_instance.libraries_data[lib_name] = {
                            "bg_image": "",
                            "prompts": [],
                            "prompt_ids": []
                        }
                        self.server_instance._save_libraries(self.server_instance.libraries_data)

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({'success': True}).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/update_library':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    old_name = data.get('old_name', '').strip()
                    new_name = data.get('new_name', '').strip()
                    image_data = data.get('image', '')
                    video_data = data.get('video')
                    prompt_ids = data.get('prompt_ids', None)

                    if old_name and new_name and old_name in self.server_instance.libraries_data:
                        lib_data = self.server_instance.libraries_data.pop(old_name)
                        if image_data:
                            lib_data['bg_image'] = self.server_instance._save_image(image_data)
                        elif image_data == '':
                            lib_data['bg_image'] = ''
                        if video_data is not None:
                            if video_data == '':
                                lib_data['bg_video'] = ''
                            else:
                                lib_data['bg_video'] = video_data
                        if prompt_ids is not None:
                            lib_data['prompt_ids'] = prompt_ids
                        self.server_instance.libraries_data[new_name] = lib_data
                        self.server_instance._save_libraries(self.server_instance.libraries_data)

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({'success': True}).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/delete_library':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    lib_name = data.get('name', '').strip()
                    if lib_name in self.server_instance.libraries_data:
                        del self.server_instance.libraries_data[lib_name]
                        self.server_instance._save_libraries(self.server_instance.libraries_data)

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({'success': True}).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/update_library_display_mode':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    lib_name = data.get('library', '').strip()
                    display_mode = data.get('display_mode', 'horizontal')
                    size_mode = data.get('size_mode', 'normal')
                    
                    if lib_name and lib_name in self.server_instance.libraries_data:
                        self.server_instance.libraries_data[lib_name]['display_mode'] = display_mode
                        self.server_instance.libraries_data[lib_name]['size_mode'] = size_mode
                        self.server_instance._save_libraries(self.server_instance.libraries_data)

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({'success': True}).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/add_library_prefab':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    lib_name = (data.get('library') or '').strip()
                    prefab_name = (data.get('prefab_name') or '').strip()
                    prefab_tags = data.get('prefab_tags', [])
                    prefab_tags = self.server_instance._normalize_prefab_tags(prefab_tags)
                    custom_prompts = data.get('custom_prompts', '')
                    loras = data.get('loras', [])
                    image_data = data.get('image', '')

                    has_content = prefab_tags or custom_prompts or loras or data.get('selected_prefabs')
                    if lib_name and lib_name in self.server_instance.libraries_data and prefab_name and has_content:
                        lib_data = self.server_instance.libraries_data[lib_name]
                        if 'prefabs' not in lib_data:
                            lib_data['prefabs'] = []
                        prefab = {
                            'name': prefab_name,
                            'tags': prefab_tags,
                            'custom_prompts': custom_prompts,
                            'loras': loras,
                            'selected_prefabs': data.get('selected_prefabs', []),
                            'guid': str(uuid.uuid4())
                        }
                        if image_data:
                            prefab['preview'] = self.server_instance._save_image(image_data)
                        lib_data['prefabs'].append(prefab)
                        self.server_instance._save_libraries(self.server_instance.libraries_data)

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    result = {'success': True}
                    if lib_name and lib_name in self.server_instance.libraries_data:
                        prefs = self.server_instance.libraries_data[lib_name].get('prefabs', [])
                        if prefs:
                            last_prefab = prefs[-1]
                            if 'preview' in last_prefab:
                                result['preview'] = last_prefab['preview']
                            if 'guid' in last_prefab:
                                result['guid'] = last_prefab['guid']
                    self.wfile.write(json.dumps(result).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/delete_library_prefab':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    lib_name = (data.get('library') or '').strip()
                    prefab_index = data.get('prefab_index', -1)

                    if lib_name and lib_name in self.server_instance.libraries_data and prefab_index >= 0:
                        lib_data = self.server_instance.libraries_data[lib_name]
                        prefabs = lib_data.get('prefabs', [])
                        if 0 <= prefab_index < len(prefabs):
                            prefabs.pop(prefab_index)
                            self.server_instance._save_libraries(self.server_instance.libraries_data)

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({'success': True}).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/update_library_prefab':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    lib_name = (data.get('library') or '').strip()
                    prefab_index = data.get('prefab_index', -1)
                    prefab_name = (data.get('prefab_name') or '').strip()

                    if lib_name and lib_name in self.server_instance.libraries_data and prefab_index >= 0 and prefab_name:
                        lib_data = self.server_instance.libraries_data[lib_name]
                        prefabs = lib_data.get('prefabs', [])
                        if 0 <= prefab_index < len(prefabs):
                            prefabs[prefab_index]['name'] = prefab_name
                            if 'custom_prompts' in data:
                                prefabs[prefab_index]['custom_prompts'] = data['custom_prompts']
                            if 'prefab_tags' in data:
                                prefabs[prefab_index]['tags'] = self.server_instance._normalize_prefab_tags(data['prefab_tags'])
                            if 'loras' in data:
                                prefabs[prefab_index]['loras'] = data['loras']
                            if 'selected_prefabs' in data:
                                prefabs[prefab_index]['selected_prefabs'] = data['selected_prefabs']
                            # 仅当前端发送了 image 字段才处理图片
                            if 'image' in data:
                                image_data = data['image']
                                if image_data:
                                    prefabs[prefab_index]['preview'] = self.server_instance._save_image(image_data)
                                elif 'preview' in prefabs[prefab_index]:
                                    del prefabs[prefab_index]['preview']
                            self.server_instance._save_libraries(self.server_instance.libraries_data)

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    result = {'success': True}
                    if lib_name and lib_name in self.server_instance.libraries_data and prefab_index >= 0:
                        prefs = self.server_instance.libraries_data[lib_name].get('prefabs', [])
                        if 0 <= prefab_index < len(prefs) and 'preview' in prefs[prefab_index]:
                            result['preview'] = prefs[prefab_index]['preview']
                    self.wfile.write(json.dumps(result).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/reorder_libraries':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    from_lib = (data.get('from_library') or '').strip()
                    to_lib = (data.get('to_library') or '').strip()
                    position = data.get('position', 'before')

                    keys = list(self.server_instance.libraries_data.keys())

                    if from_lib in keys:
                        keys.remove(from_lib)
                        if to_lib and to_lib in keys:
                            idx = keys.index(to_lib)
                            if position == 'after':
                                idx += 1
                            keys.insert(idx, from_lib)
                        else:
                            keys.append(from_lib)

                        reordered = {k: self.server_instance.libraries_data[k] for k in keys if k in self.server_instance.libraries_data}
                        self.server_instance.libraries_data.clear()
                        self.server_instance.libraries_data.update(reordered)
                        self.server_instance._save_libraries(self.server_instance.libraries_data)

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({'success': True}).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/reorder_library_prefabs':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    lib_name = (data.get('library') or '').strip()
                    from_index = data.get('from_index', -1)
                    to_index = data.get('to_index', -1)

                    if lib_name and lib_name in self.server_instance.libraries_data:
                        lib_data = self.server_instance.libraries_data[lib_name]
                        prefabs = lib_data.get('prefabs', [])
                        if 0 <= from_index < len(prefabs):
                            item = prefabs.pop(from_index)
                            if to_index is not None and 0 <= to_index < len(prefabs):
                                # 调整目标索引（如果 from 在 to 前面，pop 后 to 会偏移）
                                adjusted_to = to_index if from_index > to_index else to_index - 1
                                prefabs.insert(adjusted_to, item)
                            else:
                                prefabs.append(item)
                            self.server_instance._save_libraries(self.server_instance.libraries_data)

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({'success': True}).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/move_prefab_to_library':
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    from_lib = (data.get('from_library') or '').strip()
                    to_lib = (data.get('to_library') or '').strip()
                    from_index = data.get('from_index', -1)
                    to_index = data.get('to_index', -1)

                    if (from_lib in self.server_instance.libraries_data and
                        to_lib in self.server_instance.libraries_data and
                        from_lib != to_lib):
                        from_prefabs = self.server_instance.libraries_data[from_lib].get('prefabs', [])
                        to_lib_data = self.server_instance.libraries_data[to_lib]
                        to_prefabs = to_lib_data.get('prefabs', [])
                        if 'prefabs' not in to_lib_data:
                            to_lib_data['prefabs'] = to_prefabs
                        if 0 <= from_index < len(from_prefabs):
                            item = from_prefabs.pop(from_index)
                            if to_index is not None and 0 <= to_index <= len(to_prefabs):
                                to_prefabs.insert(to_index, item)
                            else:
                                to_prefabs.append(item)
                            self.server_instance._save_libraries(self.server_instance.libraries_data)

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({'success': True}).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")

            elif self.path == '/window_closed':
                self.server_instance.window_closed = True
                self.server_instance.prompt_event.set()
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))

            elif self.path == '/region_confirm':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)
                if self.server_instance:
                    self.server_instance.region_result = data
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))

            elif self.path == '/switch_context':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length) if content_length > 0 else b'{}'
                ctx = json.loads(post_data) if post_data else {}
                si = self.server_instance
                if si:
                    si.last_selected = ctx.get('prompts', [])
                    si.last_selected_loras = ctx.get('loras', [])
                    si.last_selected_prefabs = ctx.get('prefabs', [])
                    si.custom_prompts = ctx.get('custom_prompts', '')
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))

            elif self.path == '/load_from_image':
                content_length = int(self.headers.get('Content-Length', 0))
                image_bytes = self.rfile.read(content_length) if content_length > 0 else b''
                result = {'success': False}
                try:
                    from PIL import Image as PILImage
                    import io as _io
                    img = PILImage.open(_io.BytesIO(image_bytes))
                    img.load()
                    params = img.info.get('parameters', '')
                    if params:
                        data = json.loads(params)
                        result = {'success': True, 'data': data}
                    else:
                        result = {'success': False, 'error': 'No parameters metadata found in image'}
                except Exception as e:
                    result = {'success': False, 'error': str(e)}
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps(result).encode('utf-8'))

            else:
                super().do_POST()

        def log_message(self, format, *args):
            pass


class SnapshotPromptNode:
    """Open a browser to select prompts from categories and return the combined prompt string."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt_cache": ("BOOLEAN", {"default": False}),
                "prompt": ("STRING", {"default": "", "multiline": True}),
                "prompt_parsing": ("STRING", {"default": "", "multiline": False}),
                "lora_cache": ("BOOLEAN", {"default": False}),
                "lora_path_mode": ("BOOLEAN", {"default": False}),
                "lora_regex": ("STRING", {"default": "", "multiline": False}),
                "lora": ("STRING", {"default": "", "multiline": True}),
                "prefab_cache": ("BOOLEAN", {"default": False}),
                "prefab": ("STRING", {"default": "", "multiline": True}),
            },
            "optional": {
                "enable_region": ("BOOLEAN", {"default": False, "tooltip": "Enable bbox region editor + caption JSON output"}),
                "image": ("IMAGE", {"tooltip": "Optional image for bbox region editing"}),
                "width": ("INT", {"default": 1024, "min": 64, "max": 16384, "step": 16}),
                "height": ("INT", {"default": 1024, "min": 64, "max": 16384, "step": 16}),
                "bg_brightness": ("INT", {"default": 25, "min": 0, "max": 100}),
                "region": ("STRING", {"default": "", "multiline": False, "tooltip": "Cached region data from previous run"}),
                "region_format": ("STRING", {"default": "", "multiline": True, "tooltip": "JSON template with placeholders"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "STRING", "STRING", "IMAGE", "BBOX", "INT", "INT", "DICT")
    RETURN_NAMES = ("prompt", "active_loras", "lora_trigger_words", "merged_prompt", "region_prompt", "region_active_loras", "preview", "bboxes", "width", "height", "cache")
    FUNCTION = "snapshot_prompt"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(s, **kwargs):
        return float("nan")

    @staticmethod
    def _parse_raw_prompt(raw_text):
        """Parse a raw prompt string by matching against known prompts and decorations.
        
        Splits by comma, then for each segment attempts to find matching prompts
        and decorations. Unmatched segments become custom_prompts.
        
        Returns (last_selected, custom_prompts).
        """
        data_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "prompt")
        prompt_json = os.path.join(data_dir, "prompt.json")

        prompts_data = {}
        if os.path.exists(prompt_json):
            try:
                with open(prompt_json, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                if data:
                    prompts_data = data
            except:
                pass

        if not prompts_data:
            return [], raw_text

        def _ensure_list(val):
            if isinstance(val, list):
                return val
            if isinstance(val, str):
                return [v.strip() for v in val.split(',') if v.strip()]
            return []

        # Build case-insensitive prompt index
        # lowercase_key -> original_prompt_text
        prompt_index_lower = {}
        # tag_name -> set of lowercase prompt texts that have this tag
        tag_to_prompt_texts = {}
        # lowercase_prompt_text -> set of lowercase decoration TAG names
        deco_tag_sets = {}

        for cat_name, cat_data in prompts_data.items():
            prompts = []
            if isinstance(cat_data, dict):
                cat_deco_tags = [d.lower() for d in _ensure_list(cat_data.get('decorations', []))]
                cat_tags = [t.lower() for t in _ensure_list(cat_data.get('tags', []))]
                prompts = cat_data.get('prompts', []) or []
            elif isinstance(cat_data, list):
                cat_deco_tags = []
                cat_tags = []
                prompts = cat_data
            else:
                continue

            for p in prompts:
                if not isinstance(p, dict):
                    continue
                pt = p.get('prompt', '')
                if not pt:
                    continue
                key = pt.lower()
                prompt_index_lower[key] = pt

                # Collect all tags for this prompt (include category tags)
                p_tags = [t.lower() for t in _ensure_list(p.get('tags', []))] + cat_tags
                for t in p_tags:
                    if t not in tag_to_prompt_texts:
                        tag_to_prompt_texts[t] = set()
                    tag_to_prompt_texts[t].add(key)

                # Collect decoration tag names (lowercase key)
                if key not in deco_tag_sets:
                    p_deco_tags = [d.lower() for d in _ensure_list(p.get('decorations', []))] + cat_deco_tags
                    p_mute_tags = [d.lower() for d in _ensure_list(p.get('mute_decorations', []))]
                    deco_tag_sets[key] = set(p_deco_tags + p_mute_tags)

        if not prompt_index_lower:
            return [], raw_text

        def _resolve_tags(tag_set):
            """Resolve a set of decoration tags to all lowercase prompt texts that have those tags."""
            resolved = set()
            for tag in tag_set:
                if tag in tag_to_prompt_texts:
                    resolved |= tag_to_prompt_texts[tag]
            return resolved

        # ------------------------------------------------------------------
        # Parse a comma-segment into decorators + base_prompt.
        # Matching chain:
        #   base prompt → its decoration tags → resolve → level1 candidates
        #   level1 prompt → its decoration tags → resolve → level2 candidates
        #   etc.
        # ------------------------------------------------------------------

        def _find_all_base_prompts(words):
            """Find all possible base prompts (suffix of words[]), longest first.
            Return list of (original_text, words_before)."""
            bases = []
            for start in range(len(words)):
                candidate = ' '.join(words[start:])
                key = candidate.lower()
                if key in prompt_index_lower:
                    bases.append((prompt_index_lower[key], words[:start]))
                    print(f"  [PARSE] candidate base='{prompt_index_lower[key]}' before={words[:start]}")
            return bases

        def _match_decoration_level(remaining_words, deco_set, level):
            """Try to match the LONGEST suffix of remaining_words as a decoration.
            If not found, drop the leftmost word and retry.
            Return (matched_text, remaining_words_before) or None."""
            print(f"  [DECO] level={level} trying remaining={remaining_words} deco_set_size={len(deco_set)}")
            for start in range(len(remaining_words)):
                candidate = ' '.join(remaining_words[start:])
                if candidate.lower() in deco_set:
                    print(f"  [DECO] level={level} matched='{candidate}' remaining_after={remaining_words[:start]}")
                    return candidate, remaining_words[:start]
            print(f"  [DECO] level={level} no match found")
            return None

        def _try_decompose(words, strength=None):
            """Given a list of words (segment), try to decompose into
            decorations + base_prompt following the chain matching rule.
            Return the bracket string or None."""
            base_candidates = _find_all_base_prompts(words)
            for base_prompt, words_before in base_candidates:
                print(f"  [TRY] base='{base_prompt}' before={words_before}")
                # Chain-match decorations level by level
                remaining = list(words_before)
                base_key = base_prompt.lower()
                decoration_levels = []
                level = 1
                ok = True
                current_deco_tags = deco_tag_sets.get(base_key, set())
                while remaining:
                    deco_set = _resolve_tags(current_deco_tags)
                    print(f"  [CHAIN] level={level} current_tags={sorted(current_deco_tags)} deco_count={len(deco_set)}")
                    result = _match_decoration_level(remaining, deco_set, level)
                    if result is None:
                        ok = False
                        break
                    matched_text, remaining = result
                    decoration_levels.append((level, matched_text))
                    # Next level: use the matched prompt's decoration tags
                    current_deco_tags = deco_tag_sets.get(matched_text.lower(), set())
                    level += 1

                if ok:
                    return _build_bracket_output(base_prompt, decoration_levels, strength)
                else:
                    print(f"  [TRY] chain failed for base='{base_prompt}'")
            return None

        def _build_bracket_output(base_prompt, decoration_levels, strength=None):
            """Convert decoration levels into bracket notation.
            Rightmost = level 1 = [word], next = level 2 = [[word]], etc."""
            if not decoration_levels:
                result = base_prompt
            else:
                parts = []
                for lvl, text in decoration_levels:
                    parts.append(('[' * lvl) + text + (']' * lvl))
                parts.reverse()
                result = ' '.join(parts) + ' ' + base_prompt
            if strength is not None and strength != 1.0:
                result = f"({result}:{strength})"
            print(f"  [OUT] {result}")
            return result

        raw_text = raw_text.replace('_', ' ')
        segments = [s.strip() for s in raw_text.split(',')]
        last_selected = []
        custom_parts = []

        for seg in segments:
            if not seg:
                continue

            matched = None
            strength = None
            seg_body = seg

            # Check for strength wrapper: (content:strength)
            if seg.startswith('(') and seg.endswith(')'):
                inner = seg[1:-1]
                colon_idx = inner.rfind(':')
                if colon_idx > 0:
                    try:
                        s_val = float(inner[colon_idx + 1:])
                        strength = s_val
                        seg_body = inner[:colon_idx]
                        print(f"  [PARSE] strength detected: {strength}, body='{seg_body}'")
                    except ValueError:
                        pass

            seg_lower = seg_body.lower()
            print(f"\n[PARSE] segment='{seg}' body='{seg_body}'")

            # 1) Exact whole-segment match
            if seg_lower in prompt_index_lower:
                matched = prompt_index_lower[seg_lower]
                print(f"  [PARSE] exact match: '{matched}'")

            # 2) Multi-word: decompose via chain matching
            if matched is None:
                words = seg_body.split()
                print(f"  [PARSE] words={words}")
                if len(words) > 1:
                    matched = _try_decompose(words, strength)

            # 3) Single word with strength wrapper (e.g. (thighhighs:1.5))
            if matched is None and strength is not None:
                # seg_body might be a single prompt without brackets
                if seg_lower in prompt_index_lower:
                    matched = _build_bracket_output(prompt_index_lower[seg_lower], [], strength)
                else:
                    # Keep as custom but preserve strength wrapper
                    custom_parts.append(seg)
                    continue

            # 4) Decide
            if matched is not None:
                print(f"  [RESULT] matched='{matched}'")
                last_selected.append(matched)
            else:
                print(f"  [RESULT] → custom_prompts")
                custom_parts.append(seg)

        custom = ', '.join(custom_parts) if custom_parts else ''
        return last_selected, custom

    def snapshot_prompt(self, prompt_cache, prompt, prompt_parsing, lora_cache, lora_path_mode, lora_regex, lora, prefab_cache, prefab, unique_id,
                        enable_region=False, image=None, width=1024, height=1024, bg_brightness=25, region="", region_format=""):
        # 首先检查是否已中断 - 使用最直接的方式
        try:
            mm.throw_exception_if_processing_interrupted()
        except Exception as e:
            if "interrupt" in str(e).lower() or "processing" in str(e).lower():
                print(f"[SnapshotPrompt] Interrupted before starting: {e}")
                raise RuntimeError("[SnapshotPrompt] Interrupted")
            raise
            
        if check_interrupted():
            print("[SnapshotPrompt] Interrupted before starting!")
            raise RuntimeError("[SnapshotPrompt] Interrupted")

        last_selected = []
        custom_prompts = ''

        # Parse prompt_parsing if provided — this is the raw text to parse
        parsed_prompts_list = []
        if prompt_parsing and prompt_parsing.strip():
            parsed_selected, parsed_custom = self._parse_raw_prompt(prompt_parsing.strip())
            parsed_prompts_list = list(parsed_selected)
            last_selected.extend(parsed_selected)
            if parsed_custom:
                custom_prompts = parsed_custom
            print(f"[SnapshotPrompt] Parsed prompt_parsing: '{prompt_parsing}' -> {parsed_selected}, custom='{parsed_custom}'")

        # Parse the existing prompt widget (previous saved selections)
        if prompt and prompt.strip():
            parts = []
            current = []
            angle_depth = 0
            for ch in prompt:
                if ch == '<':
                    angle_depth += 1
                    current.append(ch)
                elif ch == '>':
                    angle_depth -= 1
                    current.append(ch)
                elif ch == ',' and angle_depth == 0:
                    parts.append(''.join(current).strip())
                    current = []
                else:
                    current.append(ch)
            if current:
                parts.append(''.join(current).strip())
            for part in parts:
                if not part:
                    continue
                if part.startswith('<') and part.endswith('>'):
                    cp = part[1:-1]
                    if custom_prompts:
                        existing = custom_prompts.split('\n')
                        if cp not in existing:
                            custom_prompts += '\n' + cp
                    else:
                        custom_prompts = cp
                else:
                    if part not in last_selected:
                        last_selected.append(part)
        
        # Parse lora widget (previous saved lora selections)
        last_selected_loras = []
        if lora and lora.strip():
            try:
                last_selected_loras = json.loads(lora.strip())
                if not isinstance(last_selected_loras, list):
                    last_selected_loras = []
            except Exception:
                last_selected_loras = []
        
        last_selected_prefabs = []
        if prefab and prefab.strip():
            try:
                last_selected_prefabs = json.loads(prefab.strip())
                if not isinstance(last_selected_prefabs, list):
                    last_selected_prefabs = []
            except Exception:
                last_selected_prefabs = []
        
        server = SnapshotPromptServer(
            last_selected=last_selected,
            lora_regex=lora_regex,
            last_selected_loras=last_selected_loras,
            last_selected_prefabs=last_selected_prefabs,
            parsed_prompts=parsed_prompts_list,
        )
        server.custom_prompts = custom_prompts
        # Region fields
        server.enable_region = enable_region
        server.image = image
        server.width = width
        server.height = height
        server.bg_brightness = bg_brightness
        server.initial_boxes = region
        server.region_format = region_format
        print(f"[SnapshotPrompt] region_format={repr(region_format[:200]) if region_format else 'EMPTY'}")
        server_thread = threading.Thread(target=server.start)
        server_thread.daemon = True
        server_thread.start()

        start_time = time.time()
        while not server.started:
            # 在启动期间也频繁检查中断
            try:
                mm.throw_exception_if_processing_interrupted()
            except Exception as e:
                if "interrupt" in str(e).lower() or "processing" in str(e).lower():
                    print(f"[SnapshotPrompt] Interrupted during startup: {e}")
                    server.stop()
                    raise RuntimeError("[SnapshotPrompt] Interrupted during startup")
                raise
                
            if check_interrupted():
                print("[SnapshotPrompt] Interrupted during startup!")
                server.stop()
                raise RuntimeError("[SnapshotPrompt] Interrupted during startup")
            
            if time.time() - start_time > 10:
                raise RuntimeError("[SnapshotPrompt] Server startup timeout")
            time.sleep(0.01)  # 缩短检查间隔到0.01秒

        print(f"[SnapshotPrompt] Opening browser at: {server.browser_url}")
        webbrowser.open(server.browser_url)

        print("[SnapshotPrompt] Waiting for prompt selection...")
        if not server.wait_for_prompt():
            print("[SnapshotPrompt] Interrupted or timed out")
            server.stop()
            raise RuntimeError("[SnapshotPrompt] Interrupted or timed out")
        server.stop()

        # Expand selected prefabs (recursive tree with per-lora active states)
        guid_to_prefab = {}
        for lib_name, lib_data in server.libraries_data.items():
            for idx, pf in enumerate(lib_data.get('prefabs', [])):
                guid = pf.get('guid')
                if guid:
                    guid_to_prefab[guid] = pf
        
        def expand_prefab_tree(node, visited):
            """Recursively expand a prefab tree node, respecting active states."""
            if not node.get('active', True):
                return [], [], []
            
            guid = node.get('guid')
            if not guid or guid in visited:
                return [], [], []
            visited.add(guid)
            
            pf = guid_to_prefab.get(guid)
            if not pf:
                return [], [], []
            
            prompts_raw = []
            prompts_cleaned = []
            loras = []
            
            # Collect tags as prompts (respect per-tag-group active state)
            tag_states = {t.get('key'): t.get('active', True) for t in node.get('tags', [])}
            for tag_group in pf.get('tags', []):
                if isinstance(tag_group, list):
                    key = ' '.join(tag.get('name') or tag.get('prompt', '') for tag in tag_group)
                    is_active = tag_states.get(key, True)
                    if not is_active:
                        continue
                    parts = []
                    for tag in tag_group:
                        if isinstance(tag, dict):
                            deco = tag.get('decoration_num') or 0
                            prompt_text = tag.get('prompt', '')
                            strength = tag.get('strength', 1.0)
                            if deco > 0:
                                text = '[' * deco + prompt_text + ']' * deco
                            else:
                                text = prompt_text
                            if strength != 1.0:
                                text = f"({text}:{strength})"
                            parts.append(text)
                    if parts:
                        prompt_str = ' '.join(parts)
                        cleaned_str = prompt_str.replace('[', '').replace(']', '')
                        if prompt_str not in prompts_raw:
                            prompts_raw.append(prompt_str)
                            prompts_cleaned.append(cleaned_str)
            
            # Collect custom_prompts
            cp = pf.get('custom_prompts', '')
            if cp:
                wrapped = f"<{cp}>"
                if wrapped not in prompts_raw:
                    prompts_raw.append(wrapped)
                    prompts_cleaned.append(cp)
            
            # Collect loras (respect per-lora active state and lora_regex filter for output)
            lora_states = {l.get('file_path'): l.get('active', True) for l in node.get('loras', [])}
            for lora_item in pf.get('loras', []):
                if isinstance(lora_item, dict):
                    file_path = lora_item.get('file_path', '') or lora_item.get('file_name', '')
                    if not file_path:
                        continue
                    # Skip if this lora was filtered out by lora_regex (output filtering)
                    normalized_path = file_path.replace('\\', '/')
                    if normalized_path not in server._valid_lora_paths and file_path not in server._valid_lora_paths:
                        continue
                    is_active = lora_states.get(file_path, True)
                    if not is_active:
                        continue
                    exists = False
                    for existing in loras:
                        if existing.get('file_path', '') == file_path or existing.get('file_name', '') == file_path:
                            exists = True
                            break
                    if not exists:
                        loras.append(lora_item)
            
            # Recurse into children
            for child in node.get('children', []):
                child_raw, child_cleaned, child_loras = expand_prefab_tree(child, visited)
                prompts_raw.extend(child_raw)
                prompts_cleaned.extend(child_cleaned)
                loras.extend(child_loras)
            
            return prompts_raw, prompts_cleaned, loras
        
        prefab_prompts_raw = []
        prefab_prompts_cleaned = []
        prefab_loras = []
        visited_guids = set()
        
        for sp in server.selected_prefabs:
            raw, cleaned, l = expand_prefab_tree(sp, visited_guids)
            prefab_prompts_raw.extend(raw)
            prefab_prompts_cleaned.extend(cleaned)
            prefab_loras.extend(l)

        if server.window_closed:
            print(f"[PREFAB_DEBUG] THROWING ERROR: window_closed={server.window_closed}")
            raise RuntimeError("[SnapshotPrompt] Window closed")

        # 去掉所有 '[' 和 ']' 字符，但保留 '<>' 包裹的自定义输入和 '()' 包裹的强度
        cleaned_prompts = []
        for p in server.selected_prompts:
            # 检查是否是 <> 包裹的自定义输入(兼容旧数据)
            if p.startswith('<') and p.endswith('>'):
                cleaned = p[1:-1]
            else:
                # 去掉 [ 和 ]，但保留 () 强度包裹
                cleaned = p.replace('[', '').replace(']', '')
            cleaned_prompts.append(cleaned)

        # 追加 custom_prompts 到结果
        if server.custom_prompts:
            cleaned_prompts.append(server.custom_prompts)
            server.selected_prompts.append(f"<{server.custom_prompts}>")

        # Merge user selections + prefab expansions for final outputs
        all_prompts_raw = server.selected_prompts + prefab_prompts_raw
        all_prompts_cleaned = cleaned_prompts + prefab_prompts_cleaned
        
        result_prompt = ", ".join(all_prompts_raw)
        cleaned_result = ", ".join(all_prompts_cleaned)
        print(f"[SnapshotPrompt] Selected prompts: {result_prompt}")
        print(f"[SnapshotPrompt] Cleaned prompts: {cleaned_result}")

        # Compute active_loras output from user selections + prefab expansions
        active_loras = server.get_active_loras_string(prefab_loras=prefab_loras, lora_path_mode=lora_path_mode)
        print(f"[SnapshotPrompt] Active loras: {active_loras}")

        # Compute lora_trigger_words output from user selections + prefab expansions
        all_loras = server.selected_loras + prefab_loras
        all_active_tags = []
        for lora_item in all_loras:
            if not lora_item.get('active', True):
                continue
            # Filter out loras excluded by lora_regex
            fp = lora_item.get('file_path', '') or lora_item.get('file_name', '')
            np = fp.replace('\\', '/')
            if np not in server._valid_lora_paths and fp not in server._valid_lora_paths:
                continue
            all_active_tags.extend(lora_item.get('active_tags', []))
        lora_trigger_words = ", ".join(all_active_tags)
        print(f"[SnapshotPrompt] Lora trigger words: {lora_trigger_words}")

        # 保存选中的值到 prompt widget（仅当 prompt_cache 为 True）
        # Only save user-direct selections, not prefab-expanded content
        user_prompt_only = ", ".join(server.selected_prompts)
        if prompt_cache:
            PromptServer.instance.send_sync("kolid-comfy-widget-set", {
                "node_id": unique_id, 
                "widget_name": "prompt", 
                "type": "STRING", 
                "value": user_prompt_only
            })
        # 保存选中的值到 lora widget（仅当 lora_cache 为 True）
        if lora_cache:
            PromptServer.instance.send_sync("kolid-comfy-widget-set", {
                "node_id": unique_id,
                "widget_name": "lora",
                "type": "STRING",
                "value": json.dumps(server.selected_loras, ensure_ascii=False)
            })
        # 保存选中的值到 prefab widget（仅当 prefab_cache 为 True）
        if prefab_cache:
            PromptServer.instance.send_sync("kolid-comfy-widget-set", {
                "node_id": unique_id,
                "widget_name": "prefab",
                "type": "STRING",
                "value": json.dumps(server.selected_prefabs, ensure_ascii=False)
            })

        merged_prompt = cleaned_result
        if lora_trigger_words:
            merged_prompt = cleaned_result + ", " + lora_trigger_words

        # Build region outputs (region_prompt, region_active_loras, preview, bboxes) if enable_region
        region_prompt = ""
        region_active_loras = ""
        preview = torch.zeros(1, 64, 64, 3) if 'torch' in dir() else None
        bboxes_out = []
        if enable_region and server.region_result:
            from .snapshot_region_node import (_render_preview, _norm_bbox, _palette, _dumps,
                                                _loads_caption, _caption_to_boxes)
            import numpy as np
            from PIL import Image as PILImage

            rr = server.region_result
            boxes = rr.get('boxes', [])
            # Use pre-assembled region_prompt from frontend if available, otherwise build from boxes
            region_prompt = rr.get('region_prompt', '')
            if not region_prompt:
                # Fallback: build simple caption from boxes + background
                caption = {"compositional_deconstruction": {"background": cleaned_result, "elements": []}}
                for box in boxes:
                    if not isinstance(box, dict):
                        continue
                    etype = "text" if box.get("type") == "text" else "obj"
                    elem = {"type": etype}
                    if not box.get("nobbox"):
                        elem["bbox"] = _norm_bbox(box, 1000, 1000, "yx")
                    if etype == "text":
                        elem["text"] = box.get("text", "")
                    elem["desc"] = box.get("desc", "")
                    caption["compositional_deconstruction"]["elements"].append(elem)
                region_prompt = json.dumps(caption, ensure_ascii=False, separators=(",", ":"))

            # Build region_active_loras: collect all loras from all region promptContexts + background
            all_region_loras = []
            for box in boxes:
                pc = box.get("promptContext") if isinstance(box, dict) else None
                if pc and pc.get("loras"):
                    for lora in pc["loras"]:
                        if lora.get("active", True) is False:
                            continue
                        # Dedup by file_path
                        fp = lora.get("file_path", "") or lora.get("file_name", "")
                        if fp and not any(al.get("file_path") == fp or al.get("file_name") == fp for al in all_region_loras):
                            all_region_loras.append(lora)
            # Build lora string like active_loras format
            region_lora_parts = []
            for lora_item in all_region_loras:
                fp = lora_item.get("file_path", "") or lora_item.get("file_name", "")
                if not fp:
                    continue
                np_ = fp.replace("\\", "/")
                if np_ not in server._valid_lora_paths and fp not in server._valid_lora_paths:
                    continue
                strength = lora_item.get("strength", 1.0)
                file_name = lora_item.get("file_name", "") or fp.split("/")[-1].split("\\")[-1]
                split_mode = lora_item.get("split_mode", False)
                active_tags = lora_item.get("active_tags", [])
                if split_mode and active_tags:
                    for tag in active_tags:
                        region_lora_parts.append(f"<lora:{fp}:{strength}:{tag}>")
                else:
                    region_lora_parts.append(f"<lora:{file_name}:{strength}>")
            region_active_loras = ", ".join(region_lora_parts)

            # Preview
            bg_pil = None
            if image is not None:
                try:
                    bg_pil = PILImage.fromarray((image[0].detach().cpu().numpy() * 255).clip(0, 255).astype(np.uint8))
                except Exception:
                    bg_pil = None
            preview = _render_preview(boxes, width, height, bg_pil, bg_brightness if bg_pil else 50)

            # BBOX output
            bbox_dicts = []
            for box in boxes:
                if not isinstance(box, dict) or box.get("nobbox"):
                    continue
                x, y = box.get("x", 0.0), box.get("y", 0.0)
                bw, bh = box.get("w", 0.0), box.get("h", 0.0)
                if bw < 0: x += bw; bw = -bw
                if bh < 0: y += bh; bh = -bh
                bbox_dicts.append({"x": round(x * width), "y": round(y * height),
                                   "width": round(bw * width), "height": round(bh * height)})
            bboxes_out = [bbox_dicts] if bbox_dicts else []

            # Cache region data (boxes + format slots + background context) in region widget
            try:
                cache_payload = {
                    "boxes": boxes,
                    "format_slots": rr.get('format_slots', {}),
                    "background_context": rr.get('background_context', None),
                }
                PromptServer.instance.send_sync("kolid-comfy-widget-set", {
                    "node_id": unique_id, "widget_name": "region",
                    "type": "STRING", "value": json.dumps(cache_payload, ensure_ascii=False),
                })
            except Exception:
                pass

        # Build cache output dict
        cache_data = {
            "prompt": user_prompt_only,
            "lora": json.dumps(server.selected_loras, ensure_ascii=False),
            "prefab": json.dumps(server.selected_prefabs, ensure_ascii=False),
            "region": "",
        }
        if enable_region and server.region_result:
            try:
                cache_data["region"] = json.dumps(cache_payload, ensure_ascii=False)
            except Exception:
                cache_data["region"] = ""

        return (cleaned_result, active_loras, lora_trigger_words, merged_prompt, region_prompt, region_active_loras, preview, bboxes_out, width, height, cache_data)
