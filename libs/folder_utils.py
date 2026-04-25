import os
import folder_paths

def scan_folder(folder_path, file_filter_callback):
    """
    通用文件夹扫描函数 - 增强版软链接支持
    """
    matched_files = []
    
    if not os.path.exists(folder_path):
        return matched_files

    for root, dirs, files in os.walk(folder_path, followlinks=True, onerror=None):
        for file in files:
            full_path = os.path.join(root, file)
            
            # 调用回调过滤
            if file_filter_callback(full_path):
                matched_files.append(full_path)
                
    return matched_files


def get_video_list_from_input(folder_name="videos"):
    """获取 input/videos 下的 mp4 文件列表（强力支持软链接）"""
    
    input_dir = folder_paths.get_input_directory()
    videos_dir = os.path.join(input_dir, folder_name)
    
    # 确保目录存在
    if not os.path.exists(videos_dir):
        os.makedirs(videos_dir)
        return []   # 新建空目录时返回空列表

    def is_mp4(full_path):
        # 1. 后缀检查（不区分大小写）
        if not full_path.lower().endswith('.mp4'):
            return False
        
        # 2. 增强的文件存在性检查（支持软链接）
        try:
            # os.path.isfile() + os.access() 更可靠
            if not os.path.isfile(full_path):
                return False
            
            # 额外检查：文件是否可读（防止坏软链接）
            if not os.access(full_path, os.R_OK):
                return False
                
            # 可选：检查文件大小 > 0（排除空文件/坏链接）
            if os.path.getsize(full_path) == 0:
                return False
                
        except (OSError, PermissionError, FileNotFoundError):
            # 坏软链接、权限问题等 → 直接过滤掉
            return False
            
        return True

    # 执行扫描
    video_full_paths = scan_folder(videos_dir, is_mp4)
    return video_full_paths

def get_video_dict_from_list(full_path_list):
    """
    将绝对路径列表转换为 {文件名: 绝对路径} 的字典
    :param full_path_list: 包含文件绝对路径的列表
    :return: {文件名: 绝对路径} 的字典
    """
    return {os.path.basename(path): path for path in full_path_list}

def get_file_names_from_dict(video_dict):
    """
    从视频字典中提取所有文件名（即字典的键）
    :param video_dict: {文件名: 绝对路径} 的字典
    :return: 包含所有文件名的列表
    """
    if not isinstance(video_dict, dict):
        return []
    
    # list(dict.keys()) 可以直接提取所有键并转为列表
    return list(video_dict.keys())

def get_file_names_list(full_path_list):
    """
    从视频字典中提取所有文件名（即字典的键）
    :param video_dict: {文件名: 绝对路径} 的字典
    :return: 包含所有文件名的列表
    """
    if not isinstance(full_path_list, list):
        return []
    
    temp_list = [os.path.basename(path) for path in full_path_list]
    temp_list.sort(key=str.lower)
    return temp_list
