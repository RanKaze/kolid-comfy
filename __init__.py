# kolid-comfy 入口:只做各领域子包注册表的合并。
# 节点类与各自的 NODE_CONFIG 分录都在 nodes/<领域>/ 里维护。
from .nodes.logic import NODE_CONFIG as _logic_config
from .nodes.image import NODE_CONFIG as _image_config
from .nodes.video import NODE_CONFIG as _video_config
from .nodes.io import NODE_CONFIG as _io_config
from .nodes.pipeline import NODE_CONFIG as _pipeline_config
from .nodes.workbench import NODE_CONFIG as _workbench_config

NODE_CONFIG = {}
for _config in (_logic_config, _image_config, _video_config,
                _io_config, _pipeline_config, _workbench_config):
    NODE_CONFIG.update(_config)


def generate_node_mappings(node_config):
    node_class_mappings = {}
    node_display_name_mappings = {}

    for node_name, node_info in node_config.items():
        node_class_mappings[node_name] = node_info["class"]
        node_display_name_mappings[node_name] = node_info.get("name", node_info["class"].__name__)

    return node_class_mappings, node_display_name_mappings


NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS = generate_node_mappings(NODE_CONFIG)
WEB_DIRECTORY = "javascript"
