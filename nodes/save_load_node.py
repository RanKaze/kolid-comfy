from typing import Optional
import os
import csv
import folder_paths
from PIL import Image
import numpy as np
import torch
from ..libs.utils import AlwaysEqualProxy, compare_revision
from ..libs.log import log_node_info, log_node_warn
import hashlib

any_type = AlwaysEqualProxy("*")

class FileCheckNode:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "file_path": ("STRING", {"default": '', "multiline": False}),
            }
        }
        
        
    @classmethod
    def IS_CHANGED(s, file_path):
        return float("nan")
        
    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("exists",)
    FUNCTION = "check_file"
    CATEGORY = "Kolid-Toolkit"

    def check_file(self, file_path=''):
        return (os.path.exists(file_path),)

class LoadTextNode:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "file_path": ("STRING", {"default": '', "multiline": False}),
            }
        }
        
        
    @classmethod
    def IS_CHANGED(s, file_path):
        m = hashlib.sha256()
        with open(file_path, 'rb') as f:
            m.update(f.read())
        return m.digest().hex()
        
    RETURN_TYPES = ("STRING", "DICT",)
    RETURN_NAMES = ("text", 'dict',)
    FUNCTION = "load_file"
    CATEGORY = "Kolid-Toolkit"

    def load_file(self, file_path=''):

        filename = ( os.path.basename(file_path).split('.', 1)[0]
            if '.' in os.path.basename(file_path) else os.path.basename(file_path) )
        if not os.path.exists(file_path):
            cstr(f"The path `{file_path}` specified cannot be found.").error.print()
            return ('', {filename: []})
        with open(file_path, 'r', encoding="utf-8", newline='\n') as file:
            text = file.read()

        import io
        lines = []
        for line in io.StringIO(text):
            if not line.strip().startswith('#'):
                lines.append(line.replace("\n",'').replace("\r",''))

        return ("\n".join(lines),)


class SaveTextNode:

    def __init__(self):
        self.output_dir = folder_paths.output_directory
        self.type = 'output'

    @classmethod
    def INPUT_TYPES(s):
        input_types = {}
        input_types['required'] = {
            "text": ("STRING", {"default": "", "forceInput": True}),
            "output_file_path": ("STRING", {"multiline": False, "default": ""}),
            "file_name": ("STRING", {"multiline": False, "default": ""}),
            "file_extension": (["txt", "csv"],),
            "overwrite": ("BOOLEAN", {"default": True}),
        }
        input_types['optional'] = {
            "image": ("IMAGE",),
        }
        return input_types

    @classmethod
    def IS_CHANGED(s, text, output_file_path, file_name, file_extension, overwrite):
        """
        当以下任意情况发生时，返回不同值，强制节点重新执行：
        1. 输入的 text 内容发生变化
        2. 输出文件内容发生变化（仅当文件已存在时）
        3. overwrite 为 False 且文件已存在（避免意外覆盖）
        """
        # 先将 text 本身纳入哈希
        m = hashlib.sha256()
        m.update(text.encode('utf-8'))  # text 变化必触发重新执行

        # 构建完整文件路径
        filepath = str(os.path.join(output_file_path, file_name)) + "." + file_extension

        # 如果文件存在，再将文件内容纳入哈希
        if os.path.exists(filepath):
            try:
                with open(filepath, 'rb') as f:
                    m.update(f.read())  # 文件内容变了也触发
            except Exception:
                pass  # 读失败也视为变化

        # 额外考虑 overwrite 参数（可选）
        # 如果 overwrite=False 且文件已存在，也应该触发重新计算（用户可能想改名或改路径）
        if not overwrite and os.path.exists(filepath):
            m.update(b"no_overwrite_but_file_exists")  # 强制变化

        return m.hexdigest()  # 返回字符串哈希，更安全稳定（比 digest() 更好）

    RETURN_TYPES = ("STRING", "IMAGE", any_type,)
    RETURN_NAMES = ("text", 'image', '*',)

    FUNCTION = "save_text"
    OUTPUT_NODE = False
    CATEGORY = "Kolid-Toolkit"

    def save_image(self, images, filename_prefix='', extension='png',quality=100, prompt=None,
                   extra_pnginfo=None, delimiter='_', filename_number_start='true', number_padding=4,
                   overwrite_mode='prefix_as_filename', output_path='', show_history='true', show_previews='true',
                   embed_workflow='true', lossless_webp=False, ):
        results = list()
        for image in images:
            i = 255. * image.cpu().numpy()
            img = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))

            # Delegate metadata/pnginfo
            if extension == 'webp':
                img_exif = img.getexif()
                workflow_metadata = ''
                prompt_str = ''
                if prompt is not None:
                    prompt_str = json.dumps(prompt)
                    img_exif[0x010f] = "Prompt:" + prompt_str
                if extra_pnginfo is not None:
                    for x in extra_pnginfo:
                        workflow_metadata += json.dumps(extra_pnginfo[x])
                img_exif[0x010e] = "Workflow:" + workflow_metadata
                exif_data = img_exif.tobytes()
            else:
                metadata = PngInfo()
                if embed_workflow == 'true':
                    if prompt is not None:
                        metadata.add_text("prompt", json.dumps(prompt))
                    if extra_pnginfo is not None:
                        for x in extra_pnginfo:
                            metadata.add_text(x, json.dumps(extra_pnginfo[x]))
                exif_data = metadata

            file = f"{filename_prefix}.{extension}"

            # Save the images
            try:
                output_file = os.path.abspath(os.path.join(output_path, file))
                if extension in ["jpg", "jpeg"]:
                    img.save(output_file,
                             quality=quality, optimize=True)
                elif extension == 'webp':
                    img.save(output_file,
                             quality=quality, lossless=lossless_webp, exif=exif_data)
                elif extension == 'png':
                    img.save(output_file,
                             pnginfo=exif_data, optimize=True)
                elif extension == 'bmp':
                    img.save(output_file)
                elif extension == 'tiff':
                    img.save(output_file,
                             quality=quality, optimize=True)
                else:
                    img.save(output_file,
                             pnginfo=exif_data, optimize=True)

            except OSError as e:
                print(e)
            except Exception as e:
                print(e)

    def save_text(self, text, output_file_path, file_name, file_extension, overwrite, filename_number_start='true', image=None, prompt=None,
                  extra_pnginfo=None):
        if isinstance(file_name, list):
            file_name = file_name[0]
        filepath = str(os.path.join(output_file_path, file_name)) + "." + file_extension
        index = 1

        if (output_file_path == "" or file_name == ""):
            log_node_warn("Save Text", "No file details found. No file output.")
            return ()

        if not os.path.exists(output_file_path):
            os.makedirs(output_file_path)

        if overwrite:
            file_mode = "w"
        else:
            file_mode = "a"

        log_node_info("Save Text", f"Saving to {filepath}")

        if file_extension == "csv":
            text_list = []
            for i in text.split("\n"):
                text_list.append(i.strip())

            with open(filepath, file_mode, newline="", encoding='utf-8') as csv_file:
                csv_writer = csv.writer(csv_file)
                # Write each line as a separate row in the CSV file
                for line in text_list:
                    csv_writer.writerow([line])
        else:
            with open(filepath, file_mode, newline="", encoding='utf-8') as text_file:
                for line in text:
                    text_file.write(line)

        result = {"result": (text, None, None)}

        if image is not None:
            imagepath = os.path.join(output_file_path, file_name)
            image_index = 1
            if not overwrite:
                while os.path.exists(filepath):
                    if os.path.exists(filepath):
                        imagepath = str(os.path.join(output_file_path, file_name)) + "_" + str(index)
                        index = index + 1
                    else:
                        break
            # result = self.save_images(image, imagepath, prompt, extra_pnginfo)

            delimiter = '_'
            number_padding = 4
            lossless_webp = (False,)

            original_output = self.output_dir

            # Setup output path
            if output_file_path in [None, '', "none", "."]:
                output_path = self.output_dir
            else:
                output_path = ''
            if not os.path.isabs(output_file_path):
                output_path = os.path.join(self.output_dir, output_path)
            base_output = os.path.basename(output_path)
            if output_path.endswith("ComfyUI/output") or output_path.endswith(r"ComfyUI\output"):
                base_output = ""

            # Check output destination
            if output_path.strip() != '':
                if not os.path.isabs(output_path):
                    output_path = os.path.join(folder_paths.output_directory, output_path)
                if not os.path.exists(output_path.strip()):
                    print(
                        f'The path `{output_path.strip()}` specified doesn\'t exist! Creating directory.')
                    os.makedirs(output_path, exist_ok=True)

            images = []
            images.append(image)
            images = torch.cat(images, dim=0)
            self.save_image(images, imagepath, 'png', 100, prompt, extra_pnginfo, filename_number_start=filename_number_start, output_path=output_path, delimiter=delimiter,
                             number_padding=number_padding, lossless_webp=lossless_webp)

            log_node_info("Save Text", f"Saving Image to {imagepath}")
            result['result'] = (text, image, None)

        return result