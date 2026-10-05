# 磁盘与网络 IO 节点:本地/远程图片加载、落盘、文本与 base64 存取。
from .disk_node import *
from .save_load_node import *
from .open_node import *
from .ehentai_node import *
from .pixiv_node import *

NODE_CONFIG = {
    "LocalImageLoaderNode": {"class": LocalImageLoaderNode, "name": "LocalImageLoaderNode"},
    "DiskSaveImagesNode": {"class": DiskSaveImagesNode, "name": "DiskSaveImagesNode"},
    "DiskLoadImagesNode": {"class": DiskLoadImagesNode, "name": "DiskLoadImagesNode"},
    "DiskLoadImageCountNode": {"class": DiskLoadImageCountNode, "name": "DiskLoadImageCountNode"},
    "DiskImagesToVideoNode": {"class": DiskImagesToVideoNode, "name": "DiskImagesToVideoNode"},
    "SaveDataToNode": {"class": SaveDataToNode, "name": "SaveDataToNode"},

    "SaveTextNode": {"class": SaveTextNode, "name": "SaveTextNode"},
    "LoadTextNode": {"class": LoadTextNode, "name": "LoadTextNode"},
    "FileCheckNode": {"class": FileCheckNode, "name": "FileCheckNode"},
    "ImageToBase64Node": {"class": ImageToBase64Node, "name": "ImageToBase64Node"},
    "Base64ToImageNode": {"class": Base64ToImageNode, "name": "Base64ToImageNode"},

    "OpenNode": {"class": OpenNode, "name": "OpenNode"},

    "EHentaiRandomNode": {"class": EHentaiRandomNode, "name": "EHentaiRandomNode"},
    "EHentaiURLNode": {"class": EHentaiURLNode, "name": "EHentaiURLNode"},
    "PixivImageLoaderNode": {"class": PixivImageLoaderNode, "name": "PixivImageLoaderNode"},
}
