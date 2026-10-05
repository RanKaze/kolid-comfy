"""节点实现包,按领域拆成六个子包:

- logic     纯逻辑/字符串/字典/分支,无 UI
- image     图像域节点(fit/crop/mask/分割/gaussian)
- video     视频与音频域节点
- io        磁盘与网络读写(disk/save_load/ehentai/pixiv)
- pipeline  采样器与 pipeline 核心(sampler/config/lora/train)
- workbench 工作台套件(snapshot_* / prompt / assets / interface)

每个子包的 __init__.py 负责自己的 NODE_CONFIG 分注册表,
根 __init__.py 只做合并。
"""
