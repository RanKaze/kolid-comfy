# 视频 / 音频域节点。
from .video_fit_node import *
from .video_node import *
from .video_segmentation_node import *
from .video_create_node import *
from .video_mask_node import *
from .video_vae_node import *
from .timestamp_node import *
from .audio_node import *
from .mask_preview_node import *

NODE_CONFIG = {
    "VideoManagerNode": {"class": VideoManagerNode, "name": "VideoManagerNode"},
    "UrlVideoNode": {"class": UrlVideoNode, "name": "UrlVideoNode"},
    "GetVideoImageNode": {"class": GetVideoImageNode, "name": "GetVideoImageNode"},
    "GetVideoImagesNode": {"class": GetVideoImagesNode, "name": "GetVideoImagesNode"},
    "GetVideoInfoNode": {"class": GetVideoInfoNode, "name": "GetVideoInfoNode"},
    "SnapshotVideoNode": {"class": SnapshotVideoNode, "name": "SnapshotVideoNode"},
    "Preview Video": {"class": PreviewVideo, "name": "Preview Video"},
    "VideoWallpaperEngineNode": {"class": VideoWallpaperEngineNode, "name": "VideoWallpaperEngineNode"},
    "VideoFolderLoaderNode": {"class": VideoFolderLoaderNode, "name": "VideoFolderLoaderNode"},
    "VideoGetFileInfoNode": {"class": VideoGetFileInfoNode, "name": "VideoGetFileInfoNode"},

    "VideoLimitPixelNode": {"class": VideoLimitPixelNode, "name": "VideoLimitPixelNode"},
    "VideoLimitFpsNode": {"class": VideoLimitFpsNode, "name": "VideoLimitFpsNode"},
    "VideoMeetNode": {"class": VideoMeetNode, "name": "VideoMeetNode"},
    "VideoFitNode": {"class": VideoFitNode, "name": "VideoFitNode"},
    "VideoRecoverResizeNode": {"class": VideoRecoverResizeNode, "name": "VideoRecoverResizeNode"},
    "VideoRecoverMeetNode": {"class": VideoRecoverMeetNode, "name": "VideoRecoverMeetNode"},
    "VideoRecoverFitNode": {"class": VideoRecoverFitNode, "name": "VideoRecoverFitNode"},

    "VideoSegmentationNode": {"class": VideoSegmentationNode, "name": "VideoSegmentationNode"},
    "CreateVideoNode": {"class": CreateVideoNode, "name": "CreateVideoNode"},
    "VAEEncodeVideoNode": {"class": VAEEncodeVideoNode, "name": "VAEEncodeVideoNode"},

    "VideoCombineMaskNode": {"class": VideoCombineMaskNode, "name": "VideoCombineMaskNode"},
    "VideoMaskFixNode": {"class": VideoMaskFixNode, "name": "VideoMaskFixNode"},
    "VideoGrowMaskNode": {"class": VideoGrowMaskNode, "name": "VideoGrowMaskNode"},
    "VideoGetMaskNode": {"class": VideoGetMaskNode, "name": "VideoGetMaskNode"},

    "TimestampDurationNode": {"class": TimestampDurationNode, "name": "TimestampDurationNode"},
    "TimestampForLengthNode": {"class": TimestampForLengthNode, "name": "TimestampForLengthNode"},

    "GetVideoAudioNode": {"class": GetVideoAudioNode, "name": "GetVideoAudioNode"},
    "GetAudioInfoNode": {"class": GetAudioInfoNode, "name": "GetAudioInfoNode"},
    "GetAudioSegmentNode": {"class": GetAudioSegmentNode, "name": "GetAudioSegmentNode"},
    "VideoReplaceAudioNode": {"class": VideoReplaceAudioNode, "name": "VideoReplaceAudioNode"},
    "VAEEncodeAudioTiled": {"class": VAEEncodeAudioTiled, "name": "VAE Encode Audio (Tiled)"},
    "GetVideoSegmentNode": {"class": GetVideoSegmentNode, "name": "GetVideoSegmentNode"},

    "ImageAndMaskPreviewNode": {"class": ImageAndMaskPreviewNode, "name": "ImageAndMaskPreviewNode"},
    "VideoAndMaskPreviewNode": {"class": VideoAndMaskPreviewNode, "name": "VideoAndMaskPreviewNode"},
}
