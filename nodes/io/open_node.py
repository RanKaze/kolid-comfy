import os
import subprocess
import platform
import folder_paths

class OpenNode:
    """Open files with their corresponding software based on file extension."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"file_path": ("STRING", {"default": ""})},
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("file_path",)
    FUNCTION = "open_file"
    CATEGORY = "Kolid-Toolkit"
    
    @classmethod
    def IS_CHANGED(cls):
        return float("nan")
    
    def open_file(self, file_path):
        """打开指定路径的文件"""
        if not file_path:
            raise ValueError("No file path provided")
        
        self._open_with_default_app(file_path)
        
        """从 output/Open 目录读取第一个文件的路径，打开它并返回文件路径。"""
        # 获取 output/Open 目录路径
        open_dir = os.path.join(folder_paths.output_directory, "Open")
        print(f"[OpenNode] Looking for files in: {open_dir}")
        
        # 检查目录是否存在
        if not os.path.exists(open_dir):
            os.makedirs(open_dir, exist_ok=True)
            print(f"[OpenNode] Created directory: {open_dir}")
        
        # 列出目录中的所有文件
        files = []
        for file_name in os.listdir(open_dir):
            file_path = os.path.join(open_dir, file_name)
            if os.path.isfile(file_path):
                files.append(file_path)
        
        # 检查是否有文件
        if not files:
            raise ValueError(f"No files found in directory: {open_dir}")
        
        # 按修改时间排序，最新的文件优先
        files.sort(key=os.path.getmtime, reverse=True)
        target_file = files[0]
        
        print(f"[OpenNode] Found {len(files)} files")
        print(f"[OpenNode] Selected file: {target_file}")
        return (target_file,)
    
    def _open_with_default_app(self, file_path):
        """使用默认应用程序打开文件"""
        current_os = platform.system()
        try:
            if current_os == "Windows":
                # On Windows, use start command
                print("[OpenNode] Using Windows default application")
                subprocess.run(["start", "", file_path], shell=True, check=True)
            elif current_os == "Darwin":
                # On macOS, use open command
                print("[OpenNode] Using macOS default application")
                subprocess.run(["open", file_path], check=True)
            elif current_os == "Linux":
                # On Linux, use xdg-open command
                print("[OpenNode] Using Linux default application")
                subprocess.run(["xdg-open", file_path], check=True)
            else:
                # For other OS, try to use the default method
                print("[OpenNode] Using default method")
                os.startfile(file_path)
            
            print(f"[OpenNode] Successfully opened file with default application: {file_path}")
        except Exception as e:
            print(f"[OpenNode] Error opening with default application: {e}")
            raise