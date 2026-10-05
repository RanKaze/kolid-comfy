# 工作台套件:snapshot 采样器/绘制/区域切换、prompt、assets、interface 打包、application。
# snapshot_region_node 没有可注册的节点类,是 prompt/工作台共用的支撑模块,这里显式导入。
from . import snapshot_region_node  # noqa: F401
from .prompt_node import *
from .switch_node import *
from .snapshot_sampler_node import *
from .snapshot_draw_node import *
from .assets_node import *
from .assets_info_collect_node import *
from .interface_node import *
from .application_node import *

NODE_CONFIG = {
    "SnapshotPromptNode": {"class": SnapshotPromptNode, "name": "SnapshotPromptNode"},
    "SnapshotSwitchNode": {"class": SnapshotSwitchNode, "name": "SnapshotSwitchNode"},
    "SnapshotDetailerSamplerNode": {"class": SnapshotDetailerSamplerNode, "name": "SnapshotDetailerSamplerNode"},
    "SnapshotDrawNode": {"class": SnapshotDrawNode, "name": "SnapshotDrawNode"},
    "SnapshotAssetsNode": {"class": SnapshotAssetsNode, "name": "SnapshotAssetsNode"},
    "AssetsInfoCollectNode": {"class": AssetsInfoCollectNode, "name": "AssetsInfoCollectNode"},

    "InterfaceStartNode": {"class": InterfaceStartNode, "name": "InterfaceStartNode"},
    "InterfaceEndNode": {"class": InterfaceEndNode, "name": "InterfaceEndNode"},
    "InterfacePackageNode": {"class": InterfacePackageNode, "name": "InterfacePackageNode"},
    "InterfaceCaptureNode": {"class": InterfaceCaptureNode, "name": "InterfaceCaptureNode"},
    "PackageMergeNode": {"class": PackageMergeNode, "name": "PackageMergeNode"},
    "PipelinePackageNode": {"class": PipelinePackageNode, "name": "PipelinePackageNode"},

    "ApplicationNode": {"class": ApplicationNode, "name": "ApplicationNode"},
}
