# 图像域节点:fit / 裁剪 / mask 预览 / gaussian / 分割。
from .fit_node import *
from .image_node import *
from .gaussian_node import *
from .subject_crop_node import *
from .eovsam_node import *

NODE_CONFIG = {
    "ImageFitNode": {"class": ImageFitNode, "name": "ImageFitNode"},
    "ImageRecoverFitNode": {"class": ImageRecoverFitNode, "name": "ImageRecoverFitNode"},
    "ImageMeetNode": {"class": ImageMeetNode, "name": "ImageMeetNode"},
    "ImageRecoverMeetNode": {"class": ImageRecoverMeetNode, "name": "ImageRecoverMeetNode"},

    "SnapshotGaussianNode": {"class": SnapshotGaussianNode, "name": "SnapshotGaussianNode"},
    "ExtrinsicsCompareNode": {"class": ExtrinsicsCompareNode, "name": "ExtrinsicsCompareNode"},

    "SnapshotImageNode": {"class": SnapshotImageNode, "name": "SnapshotImageNode"},
    "SnapshotImagePointsNode": {"class": SnapshotImagePointsNode, "name": "SnapshotImagePointsNode"},
    "SnapshotCaptureNode": {"class": SnapshotCaptureNode, "name": "SnapshotCaptureNode"},
    "ImageLimitPixelNode": {"class": ImageLimitPixelNode, "name": "ImageLimitPixelNode"},
    "LimitPixelNode": {"class": LimitPixelNode, "name": "LimitPixelNode"},
    "ImageRecoverResizeNode": {"class": ImageRecoverResizeNode, "name": "ImageRecoverResizeNode"},
    "ImageCropMaskNode": {"class": ImageCropMaskNode, "name": "ImageCropMaskNode"},
    "ImageRecoverCropNode": {"class": ImageRecoverCropNode, "name": "ImageRecoverCropNode"},
    "ImageBatchNode": {"class": ImageBatchNode, "name": "ImageBatchNode"},
    "ImageRecoverBatchNode": {"class": ImageRecoverBatchNode, "name": "ImageRecoverBatchNode"},
    "ImageDetectContentNode": {"class": ImageDetectContentNode, "name": "ImageDetectContentNode"},
    "SnapshotMaskNode": {"class": SnapshotMaskNode, "name": "SnapshotMaskNode"},
    "SnapshotOutpaintMaskNode": {"class": SnapshotOutpaintMaskNode, "name": "SnapshotOutpaintMaskNode"},

    "ImageSubjectCropNode": {"class": ImageSubjectCropNode, "name": "ImageSubjectCropNode"},
    "ImageRecoverSubjectCropNode": {"class": ImageRecoverSubjectCropNode, "name": "ImageRecoverSubjectCropNode"},
    "VideoSubjectCropNode": {"class": VideoSubjectCropNode, "name": "VideoSubjectCropNode"},
    "VideoRecoverSubjectCropNode": {"class": VideoRecoverSubjectCropNode, "name": "VideoRecoverSubjectCropNode"},

    "LoadEovSAM3Model": {"class": LoadEovSAM3Model, "name": "LoadEovSAM3Model"},
    "ImageSegmentationNode": {"class": ImageSegmentationNode, "name": "ImageSegmentationNode"},
    "ImageDetectNode": {"class": ImageDetectNode, "name": "ImageDetectNode (deprecated)"},
}
