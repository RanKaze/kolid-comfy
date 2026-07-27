# Kolid-Comfy

一套基于 ComfyUI 的自定义节点扩展，提供图像/视频处理、AI 采样、交互式 Web UI 等功能，通过临时 HTTP 服务器（8080-8899 端口）提供交互式浏览器界面。

---

## 📋 交互式 Web UI 节点

这些节点会启动本地 HTTP 服务器并打开浏览器，允许用户通过可视化界面进行交互操作。

### SnapshotSwitchNode

动态输入选择器。连接多个上游输入后，打开浏览器页面预览所有输入内容，选择其中一个作为输出。支持 lazy 模式（不加载未选中输入）和历史快照缓存。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| lazy_switch | BOOLEAN | ✅ | 默认 True，启用懒加载模式（仅加载被选中的输入） |
| global_cache | BOOLEAN | ✅ | 默认 False，启用全局缓存 |
| connection_info | STRING | ✅ | 连接信息 JSON，自动管理 |
| input1+ | * | ❌ | 动态扩展输入，可连接任意类型，自动添加更多输入槽 |

**输出:** `output` (*)

---

### SnapshotPromptNode

提示词选择器。在浏览器中按分类浏览和选择 prompt 词条，支持 LoRA 选择、自定义 prompt 输入和预制词包（prefab）。输出合并后的 prompt 字符串、LoRA 列表和触发词。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| prompt_cache | BOOLEAN | ✅ | 是否缓存 prompt 选择状态 |
| prompt | STRING | ✅ | prompt 文本（多行） |
| prompt_parsing | STRING | ✅ | prompt 解析规则 |
| lora_cache | BOOLEAN | ✅ | 是否缓存 LoRA 选择状态 |
| lora_path_mode | BOOLEAN | ✅ | LoRA 路径模式（True=直接路径，False=名称模式） |
| lora_regex | STRING | ✅ | LoRA 正则过滤表达式 |
| lora | STRING | ✅ | LoRA 选择数据（多行 JSON） |
| prefab_cache | BOOLEAN | ✅ | 是否缓存预制词包状态 |
| prefab | STRING | ✅ | 预制词包数据（多行 JSON） |
| program_cache | BOOLEAN | ✅ | 是否缓存 Program 状态 |
| program | STRING | ✅ | Program 代码数据（多行 JSON） |
| enable_region | BOOLEAN | ❌ | 启用 bbox 区域编辑器 + caption JSON 输出 |
| image | IMAGE | ❌ | 用于 bbox 区域编辑的可选图片 |
| width | INT | ❌ | 画布宽度（默认 1024） |
| height | INT | ❌ | 画布高度（默认 1024） |
| bg_brightness | INT | ❌ | 背景亮度 0-100（默认 25） |
| region | STRING | ❌ | 上次运行的缓存区域数据 |
| region_format | STRING | ❌ | 带占位符的 JSON 模板 |
| tagger | * | ❌ | Florence2 tagger 模型，用于 Tag From Image 按钮 |
| asset | STRING | ❌ | Assets 快照 JSON 或名称，用于 Tag From Assets 按钮 |

**输出:** `prompt` (STRING), `active_loras` (STRING), `lora_trigger_words` (STRING), `merged_prompt` (STRING), `region_prompt` (STRING), `region_active_loras` (STRING), `preview` (IMAGE), `bboxes` (BBOX), `width` (INT), `height` (INT), `cache` (DICT)

---

### SnapshotDetailerSamplerNode

交互式细节修复采样器。整合 mask 绘制 → 提示词选择 → AI 重绘 → 对比切换的完整循环流程。用户可多次迭代精修图片细节。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pipeline | PIPELINE_DATA | ✅ | 管线数据 |
| seed | INT | ✅ | 随机种子 |
| lora_regex | STRING | ✅ | LoRA 正则过滤表达式 |
| context_regex | STRING | ✅ | 上下文匹配正则（默认 ".+"） |
| add_noise | COMBO | ✅ | 加噪模式：enable/disable |
| start_step_rate | FLOAT | ✅ | 起始步数比例 0.0-1.0（默认 0.8） |
| end_step_rate | FLOAT | ✅ | 结束步数比例 0.0-1.0（默认 1.0） |
| pixels | INT | ✅ | 像素限制（默认 1048576） |
| align | INT | ✅ | 对齐步长（默认 8） |
| crop_reserve | INT | ✅ | 裁剪边距（默认 32） |
| detector | * | ❌ | 检测器模型 |
| tagger | * | ❌ | Tagger 模型 |

**输出:** `pipeline` (PIPELINE_DATA)

---

### SnapshotAssetsNode

tldraw 画布资源管理节点。提供拖放式图片/视频卡片管理面板，支持图片强度配置、prompt 输入、Slot 插槽配置。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| data | STRING | ✅ | 画布数据 JSON（多行） |
| global_mode | BOOLEAN | ✅ | 全局模式（True=数据存全局，False=节点内） |
| enable_prompt | BOOLEAN | ✅ | 启用 prompt 输入 |
| enable_image | BOOLEAN | ✅ | 启用图片卡片（默认 True） |
| enable_image_config | BOOLEAN | ✅ | 启用图片自定义配置 |
| image_config | STRING | ✅ | 图片配置格式（如 `test0:Float:1.0(0.0,1.0,0.1)`） |
| enable_video | BOOLEAN | ✅ | 启用视频卡片（默认 True） |
| enable_video_config | BOOLEAN | ✅ | 启用视频自定义配置 |
| video_config | STRING | ✅ | 视频配置格式 |
| enable_audio | BOOLEAN | ✅ | 启用音频卡片（默认 True） |
| enable_audio_config | BOOLEAN | ✅ | 启用音频自定义配置 |
| audio_config | STRING | ✅ | 音频配置格式 |
| enable_slot | BOOLEAN | ✅ | 启用 Slot 插槽 |
| slot_config | STRING | ✅ | Slot 配置格式（如 `Image:slot0(test0:Float:1.0(0.0,1.0,0.1)),Video:slot1`） |

**输出:** `prompt` (STRING), `image` (IMAGE[]), `image_infos` (*), `video` (VIDEO[]), `video_infos` (*), `audio` (AUDIO[]), `audio_infos` (*), `slot` (*), `slot_infos` (*)

---

### SnapshotGaussianNode

高斯点云预览节点。加载 PLY 文件并在浏览器中渲染 3D 高斯泼溅场景。支持 **GSplat**（轻量渲染）和 **SuperSplat**（需要 Node.js，魔改 UI）两种渲染方式。按 Enter 截图输出。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| ply_path | STRING | ✅ | PLY 文件路径（来自上游节点） |
| method | COMBO | ✅ | 渲染方式：GSplat / SuperSplat（默认 GSplat） |
| width | INT | ✅ | 截图宽度 64-2048（默认 512） |
| height | INT | ✅ | 截图高度 64-2048（默认 512） |
| extrinsics | EXTRINSICS | ❌ | 相机外参矩阵（来自上游节点） |
| intrinsics | INTRINSICS | ❌ | 相机内参矩阵（来自上游节点） |

**输出:** `snapshot` (IMAGE), `snapshot_path` (STRING), `extrinsics` (EXTRINSICS)

---

### SnapshotImageNode

图片区域截图。在浏览器中打开图片，用户可拖拽选择矩形区域并截图输出。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| image | IMAGE | ✅ | 输入图片 |
| width | INT | ✅ | 预览窗口宽度 64-2048（默认 512） |
| height | INT | ✅ | 预览窗口高度 64-2048（默认 512） |

**输出:** `selected_image` (IMAGE), `image_path` (STRING)

---

### SnapshotImagePointsNode

SAM 坐标点标记。在图片上用鼠标标记正/负坐标点，输出 SAM3 格式的坐标数据，用于 SAM 模型分割。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| image | IMAGE | ✅ | 输入图片 |
| pos_points | STRING | ✅ | 额外正坐标点 JSON 字符串 |
| neg_points | STRING | ✅ | 额外负坐标点 JSON 字符串 |
| modifying | BOOLEAN | ✅ | True=打开界面重新点选，False=使用当前点位不打开界面 |
| positive_points | SAM3_POINTS_PROMPT | ❌ | 初始正坐标点（SAM3 格式） |
| negative_points | SAM3_POINTS_PROMPT | ❌ | 初始负坐标点（SAM3 格式） |

**输出:** `positive_points` (SAM3_POINTS_PROMPT), `negative_points` (SAM3_POINTS_PROMPT), `positive_coords` (STRING), `negative_coords` (STRING)

---

### SnapshotMaskNode

Mask 绘制工具。在浏览器中用画笔在图片上绘制 mask，支持画笔大小调节、detector 自动检测、mask 膨胀（grow）。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| image | IMAGE | ✅ | 输入图片 |
| mask | MASK | ❌ | 初始 mask（加载到编辑器） |
| detector | * | ❌ | 检测器模型（自动检测 mask） |

**输出:** `mask` (MASK)

---

### SnapshotOutpaintMaskNode

Outpaint 扩展区域设置。在浏览器中通过拖拽边框设置上下左右扩展像素，输出扩展后的图片和 mask。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| image | IMAGE | ✅ | 输入图片 |

**输出:** `mask` (MASK), `image` (IMAGE)

---

### SnapshotVideoNode

视频时间戳选择。在浏览器中预览视频并精确定位到特定帧，输出时间戳和帧偏移量。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| video | VIDEO | ✅ | 输入视频对象 |
| timestamp | STRING | ✅ | 起始时间戳 hh:mm:ss 格式 |
| frame_offset | INT | ✅ | 帧偏移量 |

**输出:** `timestamp` (STRING), `frame_offset` (INT)

---

### SnapshotCaptureNode

桌面截图工具。弹出浮动面板，支持 Shot（框选截图）和 Previous（加载上次缓存）两种模式。直接截取屏幕任意区域作为 ComfyUI 图片输入。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| cached_image | STRING | ✅ | 上次缓存的截图路径（自动更新） |

**输出:** `image` (IMAGE)

---

### SnapshotRegionNode

区域编辑节点。在浏览器中绘制 bbox 区域并输入描述，输出 caption JSON、预览图和像素空间 bboxes。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| width | INT | ✅ | 画布宽度 64-16384（默认 1024） |
| height | INT | ✅ | 画布高度 64-16384（默认 1024） |
| background | STRING | ✅ | 场景背景描述（必填） |
| image | IMAGE | ❌ | 可选输入图片，在图片上绘制区域 |
| high_level_description | STRING | ❌ | 整体概述描述 |
| aesthetics | STRING | ❌ | 风格描述 |
| lighting | STRING | ❌ | 光照描述 |
| medium | STRING | ❌ | 媒介描述 |
| style_palette_data | STRING | ❌ | 风格调色板 JSON（来自上次运行） |
| import_json | STRING | ❌ | 导入完整 caption JSON 预填编辑器 |
| bbox_order | COMBO | ❌ | bbox 轴序：yx / xy（默认 yx） |
| coord_mode | COMBO | ❌ | 坐标模式：normalized / absolute（默认 normalized） |
| output_format | COMBO | ❌ | 输出格式：compact / pretty（默认 compact） |
| bg_brightness | INT | ❌ | 背景亮度 0-100（默认 25） |
| data_cache | BOOLEAN | ❌ | 是否缓存区域数据到 widget（默认 True） |
| cached_data | STRING | ❌ | 上次运行的缓存数据 |
| enable_snapshot_prompt | BOOLEAN | ❌ | 在左侧面板嵌入 SnapshotPromptNode 编辑器（默认 False） |

**输出:** `prompt` (STRING), `preview` (IMAGE), `bboxes` (BBOX), `width` (INT), `height` (INT)

---

## 🖼️ 图像处理节点

### FitNode

图片适配缩放。将图片等比缩放后居中放入指定尺寸画布，空白区域用指定颜色填充。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| image | IMAGE | ✅ | 输入图片 |
| width | INT | ✅ | 目标画布宽度 0-2048（默认 0=不限制） |
| height | INT | ✅ | 目标画布高度 0-2048（默认 0=不限制） |
| interpolation | COMBO | ✅ | 插值模式：nearest / bilinear / bicubic（默认 bilinear） |
| padding_color | STRING | ✅ | 填充颜色，支持 `R, G, B` 或 `#RRGGBB`（默认 "255, 255, 255"） |
| mask | MASK | ❌ | 可选 mask，同步缩放 |

**输出:** `Image` (IMAGE), `FitInfo` (FIT_INFO), `Mask` (MASK)

---

### RecoverFitNode

配合 FitNode 使用。根据 FitInfo 将适配后的图片恢复到原始尺寸。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| image | IMAGE | ✅ | 适配后的图片 |
| fitInfo | FIT_INFO | ✅ | 来自 FitNode 的 FitInfo |
| interpolation | COMBO | ✅ | 插值模式：nearest / bilinear / bicubic（默认 bilinear） |
| mask | MASK | ❌ | 可选 mask，同步恢复 |

**输出:** `Image` (IMAGE), `Mask` (MASK)

---

### ImageLimitPixelNode

像素数量限制。当图片像素超过设定值（默认 1MP）时自动缩小，输出 resize_info 供后续恢复。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| image | IMAGE | ✅ | 输入图片 |
| pixels | INT | ✅ | 最大像素数（默认 1048576=1MP） |
| align | INT | ✅ | 对齐到最近的像素网格（默认 1） |
| mask | MASK | ❌ | 可选 mask，同步缩放 |

**输出:** `image` (IMAGE), `mask` (MASK), `resize_info` (RESIZE_INFO)

---

### LimitPixelNode

计算受限像素尺寸（不实际缩放图片）。根据原始宽高和像素限制，输出缩放后的目标宽高。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| width | INT | ✅ | 原始宽度（默认 1024） |
| height | INT | ✅ | 原始高度（默认 1024） |
| pixels | INT | ✅ | 最大像素数（默认 1048576=1MP） |
| align | INT | ✅ | 对齐步长（默认 1） |

**输出:** `width` (INT), `height` (INT)

---

### ImageRecoverResizeNode

配合 ImageLimitPixelNode 使用。根据 resize_info 将图片恢复到原始尺寸。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| image | IMAGE | ✅ | 缩放后的图片 |
| resize_info | RESIZE_INFO | ✅ | 来自 ImageLimitPixelNode 的 resize_info |
| mask | MASK | ❌ | 可选 mask，同步恢复 |

**输出:** `image` (IMAGE), `mask` (MASK)

---

### ImageCropMaskNode

Mask 裁剪。根据 mask 的包围盒裁剪图片，支持 reserve 参数留出边距。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| image | IMAGE | ✅ | 输入图片 |
| mask | MASK | ✅ | 用于裁剪的 mask |
| reserve | INT | ✅ | mask 边距像素数 0-1000（默认 0） |

**输出:** `image` (IMAGE), `mask` (MASK), `crop_info` (CROP_INFO)

---

### ImageRecoverCropNode

配合 ImageCropMaskNode 使用。将裁剪后的图片恢复到原始画布，支持 mask_blend / mask_only / bounds_only 三种恢复模式。支持列表输入（多图累积粘贴）。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| background | IMAGE | ✅ | 背景图（作为恢复底板） |
| image | IMAGE | ✅ | 裁剪后的图片 |
| crop_info | CROP_INFO | ✅ | 来自 ImageCropMaskNode 的 crop_info |
| recover_method | COMBO | ✅ | 恢复方式：mask_blend / mask_only / bounds_only（默认 mask_blend） |
| mask | MASK | ❌ | 可选 mask，同步恢复 |

**输出:** `image` (IMAGE), `mask` (MASK)

---

### ImageBatchNode

多图合批。将多张不同尺寸的图片统一转为相同尺寸的 Batch，居中填充。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| images | IMAGE | ✅ | 输入图片（支持列表） |
| align | INT | ✅ | 尺寸对齐步长 0-128（默认 16） |
| width | INT | ✅ | 目标宽度 0-4096（默认 0=自动计算，0=按面积加权平均） |
| height | INT | ✅ | 目标高度 0-4096（默认 0=自动计算） |
| masks | MASK | ❌ | 可选 mask 列表，同步处理 |
| fill_image | STRING | ❌ | 图片填充颜色 #RRGGBB（默认 "#000000"） |
| fill_mask | FLOAT | ❌ | mask 填充值 0.0-1.0（默认 0.0） |

**输出:** `image` (IMAGE), `mask` (MASK), `batch_info` (BATCH_INFO)

---

### ImageRecoverBatchNode

配合 ImageBatchNode 使用。将 Batch 后的图片恢复为原始尺寸的列表。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| image | IMAGE | ✅ | Batch 后的图片 |
| batch_info | BATCH_INFO | ✅ | 来自 ImageBatchNode 的 batch_info |
| mask | MASK | ❌ | 可选 mask，同步恢复 |

**输出:** `images` (IMAGE[]), `masks` (MASK[])

---

### ImageDetectContentNode

智能内容检测。检测图片是否有均匀边框（通过四角颜色分析），自动生成内容区域 mask，去除黑边/白边。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| image | IMAGE | ✅ | 输入图片 |
| tolerance | FLOAT | ✅ | 内容与边框颜色容差 0.0-1.0（默认 0.06） |
| border_threshold | FLOAT | ✅ | 判断是否有边框的严格程度 0.0-0.5（默认 0.08，越小越严格） |

**输出:** `mask` (MASK), `has_border` (BOOLEAN)

---

### ImageToBase64Node

图片转 Base64 字符串。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| image | IMAGE | ✅ | 输入图片 |
| include_prefix | BOOLEAN | ✅ | 是否包含 data URI 前缀（默认 True） |

**输出:** `base64_string` (STRING)

---

### Base64ToImageNode

Base64 字符串转图片（ComfyUI IMAGE 格式）。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| base64_string | STRING | ✅ | Base64 编码的图片字符串（多行） |

**输出:** `image` (IMAGE)

---

### AssetsInfoCollectNode

从 SnapshotAssetsNode 的 infos 列表中收集指定 key 的值。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| infos | * | ✅ | 来自 SnapshotAssetsNode 的 infos（dict 列表） |
| key | STRING | ✅ | 要从每个 info dict 中收集的 key 名称 |

**输出:** `values` (*)

---

## 🎨 采样管线节点 (Pipeline)

采样管线节点提供模块化的采样工作流，通过 PipelineData 在各节点间传递模型、图片、条件等上下文。

### PipelineNode

管线数据容器。整合 model、clip、vae、image、latent、mask、sampler/scheduler 参数、context、reference、config 等所有采样相关数据，支持链式传递和增量更新。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pipeline | PIPELINE_DATA | ❌ | 上游管线数据（增量更新） |
| cache | SAMPLER_CACHE | ❌ | 采样器缓存（LoRA 缓存等） |
| model | MODEL | ❌ | 模型 |
| clip | CLIP | ❌ | CLIP 模型 |
| vae | VAE | ❌ | VAE 模型 |
| image | IMAGE | ❌ | 图片 |
| latent | LATENT | ❌ | Latent |
| mask | MASK | ❌ | Mask |
| sampler_name | COMBO | ❌ | 采样器名称（forceInput） |
| scheduler | COMBO | ❌ | 调度器（forceInput） |
| steps | INT | ❌ | 步数（forceInput） |
| cfg | FLOAT | ❌ | CFG 值（forceInput） |
| context | CONTEXT_DATA | ❌ | 上下文数据 |
| reference | REFERENCE_DATA | ❌ | 参考数据 |
| config | CONFIG_DATA | ❌ | 配置数据 |

**输出:** `pipeline`, `cache`, `model`, `clip`, `vae`, `image`, `latent`, `mask`, `sampler_name`, `scheduler`, `steps`, `cfg`, `context`, `reference`, `config`

---

### ContextNode

上下文数据构建。按名称管理多组 positive/negative prompt 和 LoRA 配置，支持增量追加。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | STRING | ✅ | 上下文名称（用于后续匹配） |
| context | CONTEXT_DATA | ❌ | 上游上下文（增量追加） |
| loras | STRING | ❌ | LoRA 配置字符串（forceInput） |
| positive | STRING | ❌ | 正向 prompt（forceInput） |
| negative | STRING | ❌ | 负向 prompt（forceInput） |

**输出:** `context` (CONTEXT_DATA)

---

### ContextQueryNode

上下文查询。通过相似度模型对图片进行匹配查询，根据 threshold 和 prompt_regex 自动选择合适的上下文配置。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query_id | STRING | ✅ | 查询 ID |
| image | IMAGE | ✅ | 查询图片 |
| threshold | FLOAT | ✅ | 相似度阈值（默认 0.8） |
| similarity_model | * | ✅ | 相似度模型 |
| prompt_regex | STRING | ✅ | prompt 匹配正则（默认 ".+"） |
| need_context_regex | STRING | ✅ | 需要的上下文正则（默认 ""） |
| context | CONTEXT_DATA | ❌ | 上游上下文 |

**输出:** `context` (CONTEXT_DATA)

---

### ReferenceLatentNode

参考 Latent 设置。将 latent 附加到 ReferenceData 中，供采样时使用。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| reference | REFERENCE_DATA | ❌ | 上游参考数据 |
| latent | LATENT | ❌ | 参考 latent |

**输出:** `reference` (REFERENCE_DATA)

---

### ReferenceImageNode

参考图片设置。将图片 VAE 编码为 latent 后附加到 ReferenceData。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| reference | REFERENCE_DATA | ❌ | 上游参考数据 |
| image | IMAGE | ❌ | 参考图片 |
| vae | VAE | ❌ | VAE 模型（用于编码） |

**输出:** `reference` (REFERENCE_DATA)

---

### ReferenceContolNetNode

ControlNet 参考设置。配置 ControlNet 及对应图片、强度、起止百分比。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| reference | REFERENCE_DATA | ❌ | 上游参考数据 |
| control_net | CONTROL_NET | ❌ | ControlNet 模型 |
| image | IMAGE | ❌ | ControlNet 输入图片 |
| strength | FLOAT | ❌ | 强度（默认 1.0） |
| start_percent | FLOAT | ❌ | 起始百分比（默认 0.0） |
| end_percent | FLOAT | ❌ | 结束百分比（默认 1.0） |

**输出:** `reference` (REFERENCE_DATA)

---

### ReferenceGuidanceNode

引导强度设置。配置 positive/negative guidance 值。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| reference | REFERENCE_DATA | ❌ | 上游参考数据 |
| positive_guidance | FLOAT | ❌ | 正向引导值（forceInput） |
| negative_guidance | FLOAT | ❌ | 负向引导值（forceInput） |

**输出:** `reference` (REFERENCE_DATA)

---

### ReferenceIPAdapterNode

IP-Adapter 参考设置。支持多种预设，配置风格/构图权重、embed 组合方式、起止步数等。**支持列表输入**（多参考图）。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| preset | COMBO | ✅ | 预设：LIGHT / STANDARD / VIT-G / PLUS / PLUS FACE / COMPOSITION 等 |
| weight_style | FLOAT | ✅ | 风格权重 -1~5（默认 1.0） |
| weight_composition | FLOAT | ✅ | 构图权重 -1~5（默认 1.0） |
| expand_style | BOOLEAN | ✅ | 是否扩展风格（默认 False） |
| combine_embeds | COMBO | ✅ | embed 组合方式：concat / add / subtract / average / norm average（默认 average） |
| start_at | FLOAT | ✅ | 起始步数比例 0.0-1.0（默认 0.0） |
| end_at | FLOAT | ✅ | 结束步数比例 0.0-1.0（默认 1.0） |
| embeds_scaling | COMBO | ✅ | embed 缩放方式：V only / K+V / K+V w/ C penalty / K+mean(V) w/ C penalty |
| cache_mode | COMBO | ✅ | 缓存模式：insightface only / clip_vision only / ipadapter only / all / none（默认 all） |
| reference | REFERENCE_DATA | ❌ | 上游参考数据 |
| image_style | IMAGE | ❌ | 风格参考图片 |
| image_composition | IMAGE | ❌ | 构图参考图片 |
| image_negative | IMAGE | ❌ | 负向参考图片 |
| attn_mask | MASK | ❌ | 注意力 mask |
| clip_vision | CLIP_VISION | ❌ | CLIP Vision 模型 |

**输出:** `reference` (REFERENCE_DATA)

---

### ConfigNode

配置键值设置。将任意 key-value 存入 ConfigData。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| config | CONFIG_DATA | ❌ | 上游配置（增量更新） |
| key | STRING | ❌ | 配置键名（默认 ""） |
| value | * | ❌ | 配置值（任意类型） |

**输出:** `config` (CONFIG_DATA)

---

### ConfigGetNode

配置值获取。从 ConfigData 中按 key 读取值。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| key | STRING | ✅ | 要获取的配置键名 |
| config | CONFIG_DATA | ❌ | 上游配置 |

**输出:** `value` (*)

---

### ConfigModelNegativeNode

设置负向模型（model_negative），用于负向采样。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| config | CONFIG_DATA | ❌ | 上游配置 |
| model_negative | MODEL | ❌ | 负向模型 |

**输出:** `config` (CONFIG_DATA)

---

### ConfigSigmasNode

设置自定义 Sigmas。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| config | CONFIG_DATA | ❌ | 上游配置 |
| sigmas | SIGMAS | ❌ | Sigmas |

**输出:** `config` (CONFIG_DATA)

---

### ConfigArchitectureNode

设置模型架构名称（如 Krea2、Flux2Klein、QwenEdit）。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| config | CONFIG_DATA | ❌ | 上游配置 |
| architecture | STRING | ❌ | 架构名称（默认 ""） |

**输出:** `config` (CONFIG_DATA)

---

### ConfigPrintTagNode

设置是否打印 Tagger 生成的标签。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| config | CONFIG_DATA | ❌ | 上游配置 |
| print_tag | BOOLEAN | ❌ | 是否打印标签（默认 False） |

**输出:** `config` (CONFIG_DATA)

---

### ConfigPreviewImageNode

设置是否预览采样后的图片。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| config | CONFIG_DATA | ❌ | 上游配置 |
| preview_image | BOOLEAN | ❌ | 是否预览图片（默认 True） |

**输出:** `config` (CONFIG_DATA)

---

### ConfigPreviewMaskNode

设置是否预览 mask。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| config | CONFIG_DATA | ❌ | 上游配置 |
| preview_mask | BOOLEAN | ❌ | 是否预览 mask（默认 True） |

**输出:** `config` (CONFIG_DATA)

---

### ConfigKrea2EditNode

Krea2 编辑参数配置。设置参考保真度、VLM 图像分辨率等。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| config | CONFIG_DATA | ❌ | 上游配置 |
| ref_boost | FLOAT | ❌ | 参考保真度 0-1000（默认 1.0，>1 更贴近参考，<1 放松） |
| ref_boost_a | FLOAT | ❌ | 第一个参考（场景）的 boost（默认 1.0，单参考时无效） |
| ref_boost_mask | MASK | ❌ | 可选区域 mask，限制最后一个参考的 boost 范围 |
| grounding_px | INT | ❌ | VLM 输入图像最长边上限 0-4096（默认 768，0=原始分辨率） |

**输出:** `config` (CONFIG_DATA)

---

### SamplerConfigNode

采样参数配置包。将 CFG、步数、采样器、调度器、正/负 prompt 打包为统一格式输出。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| cfg | FLOAT | ✅ | CFG 值 0.0-100.0（默认 8.0） |
| steps | INT | ✅ | 采样步数 1-10000（默认 20） |
| sampler_name | COMBO | ✅ | 采样器名称 |
| scheduler | COMBO | ✅ | 调度器名称 |
| positive | STRING | ✅ | 正向 prompt（多行） |
| negative | STRING | ✅ | 负向 prompt（多行） |

**输出:** `cfg`, `steps`, `sampler_name`, `scheduler`, `positive`, `negative`

---

### PipelineSamplerNode

基础采样器。支持 context_regex 上下文匹配、denoise 控制。可选 Tagger 自动打标追加 prompt。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pipeline | PIPELINE_DATA | ✅ | 管线数据 |
| bypass | BOOLEAN | ✅ | 是否跳过（默认 False） |
| need_reference_latent | BOOLEAN | ✅ | 是否使用参考 latent（默认 False） |
| context_regex | STRING | ✅ | 上下文匹配正则（默认 ".+"） |
| denoise | FLOAT | ✅ | 去噪强度 0.0-1.0（默认 1.0） |
| seed | INT | ✅ | 随机种子 |
| tagger | * | ❌ | Tagger 模型 |

**输出:** `pipeline` (PIPELINE_DATA), `tag` (STRING)

---

### PipelineSamplerAdvancedNode

高级采样器（KSamplerAdvanced 封装）。支持 add_noise、起止步数、leftover_noise 控制。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pipeline | PIPELINE_DATA | ✅ | 管线数据 |
| bypass | BOOLEAN | ✅ | 是否跳过（默认 False） |
| need_reference_latent | BOOLEAN | ✅ | 是否使用参考 latent（默认 False） |
| context_regex | STRING | ✅ | 上下文匹配正则（默认 ".+"） |
| add_noise | COMBO | ✅ | 加噪模式：enable / disable（默认 enable） |
| seed | INT | ✅ | 随机种子 |
| start_step_rate | FLOAT | ✅ | 起始步数比例 0.0-1.0（默认 0.0） |
| end_step_rate | FLOAT | ✅ | 结束步数比例 0.0-1.0（默认 1.0） |
| return_with_leftover_noise | COMBO | ✅ | 残留噪声：disable / enable（默认 disable） |
| tagger | * | ❌ | Tagger 模型 |

**输出:** `pipeline` (PIPELINE_DATA), `tag` (STRING)

---

### PipelineDetailerAdvancedNode

高级 Detailer 节点。完整实现 Crop → Limit Pixels → KSamplerAdvanced → Recover Size → Recover Crop 的细节修复管线。支持 detector 自动检测 mask、tagger 打标、inpaint 模式、foreach_mask（多 mask 独立处理）。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pipeline | PIPELINE_DATA | ✅ | 管线数据 |
| bypass | BOOLEAN | ✅ | 是否跳过（默认 False） |
| need_reference_latent | BOOLEAN | ✅ | 是否使用参考 latent（默认 False） |
| context_regex | STRING | ✅ | 上下文匹配正则（默认 ".+"） |
| add_noise | COMBO | ✅ | 加噪模式：enable / disable（默认 enable） |
| seed | INT | ✅ | 随机种子 |
| start_step_rate | FLOAT | ✅ | 起始步数比例 0.0-1.0（默认 0.8） |
| end_step_rate | FLOAT | ✅ | 结束步数比例 0.0-1.0（默认 1.0） |
| return_with_leftover_noise | COMBO | ✅ | 残留噪声：disable / enable（默认 disable） |
| detector_threshold | FLOAT | ✅ | 检测器阈值 0.0-1.0（默认 0.2） |
| detector_prompt | STRING | ✅ | 检测器 prompt |
| detector_dilation | INT | ✅ | 检测器膨胀（默认 4） |
| detector_crop_factor | FLOAT | ✅ | 检测器裁剪因子（默认 1.5） |
| detector_drop_size | INT | ✅ | 检测器丢弃尺寸（默认 0） |
| detector_grow | INT | ✅ | mask 扩展像素（默认 32） |
| detector_blur | INT | ✅ | mask 模糊像素（默认 32） |
| pixels | INT | ✅ | 像素限制（默认 1048576） |
| align | INT | ✅ | 对齐步长（默认 8） |
| crop_reserve | INT | ✅ | 裁剪边距（默认 32） |
| recover_method | COMBO | ✅ | 恢复方式：bounds_only / mask_blend / mask_only（默认 mask_blend） |
| inpaint_mode | BOOLEAN | ✅ | 是否使用 inpaint 模式（默认 False） |
| foreach_mask | BOOLEAN | ✅ | 是否每个 mask 独立处理（默认 False） |
| tagger_mask | BOOLEAN | ✅ | Tagger 是否使用 mask（默认 False） |
| detector | * | ❌ | 检测器模型 |
| tagger | * | ❌ | Tagger 模型 |
| image | IMAGE | ❌ | 自定义图片（覆盖 pipeline 中的图片） |
| mask | MASK | ❌ | 自定义 mask（覆盖 pipeline 中的 mask） |

**输出:** `pipeline` (PIPELINE_DATA), `image` (IMAGE[]), `mask` (MASK[]), `generated_prompt` (STRING[])

---

### PipelineVideoSamplerAdvancedNode

视频逐帧采样。对视频片段逐帧执行高级采样。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pipeline | PIPELINE_DATA | ✅ | 管线数据 |
| video | VIDEO | ✅ | 输入视频 |
| sampler_fps | FLOAT | ✅ | 采样 FPS（默认 0=使用原视频 FPS） |
| folder_name | STRING | ✅ | 帧保存文件夹名（默认 "video_detailer_frames"） |
| images_per_run | INT | ✅ | 每次处理帧数 1-16（默认 4） |
| bypass | BOOLEAN | ✅ | 是否跳过（默认 False） |
| need_reference_latent | BOOLEAN | ✅ | 是否使用参考 latent（默认 False） |
| context_regex | STRING | ✅ | 上下文匹配正则（默认 ".+"） |
| add_noise | COMBO | ✅ | 加噪模式：enable / disable（默认 enable） |
| seed | INT | ✅ | 随机种子 |
| start_step_rate | FLOAT | ✅ | 起始步数比例 0.0-1.0（默认 0.8） |
| end_step_rate | FLOAT | ✅ | 结束步数比例 0.0-1.0（默认 1.0） |
| return_with_leftover_noise | COMBO | ✅ | 残留噪声：disable / enable（默认 disable） |
| detector_threshold | FLOAT | ✅ | 检测器阈值 0.0-1.0（默认 0.2） |
| detector_prompt | STRING | ✅ | 检测器 prompt |
| detector_dilation | INT | ✅ | 检测器膨胀（默认 4） |
| detector_crop_factor | FLOAT | ✅ | 检测器裁剪因子（默认 1.5） |
| detector_drop_size | INT | ✅ | 检测器丢弃尺寸（默认 0） |
| detector_grow | INT | ✅ | mask 扩展像素（默认 32） |
| detector_blur | INT | ✅ | mask 模糊像素（默认 32） |
| pixels | INT | ✅ | 像素限制（默认 1048576） |
| align | INT | ✅ | 对齐步长（默认 8） |
| crop_reserve | INT | ✅ | 裁剪边距（默认 32） |
| recover_method | COMBO | ✅ | 恢复方式（默认 mask_blend） |
| inpaint_mode | BOOLEAN | ✅ | 是否使用 inpaint 模式（默认 False） |
| foreach_mask | BOOLEAN | ✅ | 是否每个 mask 独立处理（默认 False） |
| tagger_mask | BOOLEAN | ✅ | Tagger 是否使用 mask（默认 False） |
| detector | * | ❌ | 检测器模型 |
| tagger | * | ❌ | Tagger 模型 |

**输出:** `pipeline` (PIPELINE_DATA), `video_fps` (FLOAT), `processed_frames` (INT)

---

### PipelineDecodeNode

管线解码。将 pipeline 中的 latent 解码为 image。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pipeline | PIPELINE_DATA | ✅ | 管线数据 |

**输出:** `pipeline` (PIPELINE_DATA), `image` (IMAGE)

---

### PipelineLimitPixelNode

管线像素限制。对 pipeline 中的 image 进行像素限制，resize_info 自动压入栈中。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pipeline | PIPELINE_DATA | ✅ | 管线数据 |
| pixels | INT | ✅ | 最大像素数（默认 1048576） |
| align | INT | ✅ | 对齐步长（默认 1） |

**输出:** `pipeline` (PIPELINE_DATA)

---

### PipelineRecoverResizeNode

管线尺寸恢复。从栈中弹出 resize_info 并恢复图片尺寸。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pipeline | PIPELINE_DATA | ✅ | 管线数据 |

**输出:** `pipeline` (PIPELINE_DATA)

---

### PipelineAddNoiseNode

管线加噪。向 pipeline latent 添加噪声。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pipeline | PIPELINE_DATA | ✅ | 管线数据 |
| add_noise | BOOLEAN | ✅ | 是否加噪（默认 True） |
| seed | INT | ✅ | 随机种子（默认 0） |
| noise_strength | FLOAT | ✅ | 噪声强度 0.0-1.0（默认 1.0） |

**输出:** `pipeline` (PIPELINE_DATA)

---

### PipelineToggleMaskInpaintNode

管线 Inpaint 切换。设置或取消 inpaint mask 模式。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pipeline | PIPELINE_DATA | ✅ | 管线数据 |
| grow_mask_by | INT | ✅ | mask 扩展像素（默认 0） |
| enable | BOOLEAN | ✅ | 是否启用 inpaint（默认 True） |
| mask | MASK | ❌ | 自定义 mask（覆盖 pipeline 中的 mask） |

**输出:** `pipeline` (PIPELINE_DATA)

---

### PipelineEnableEditNode

启用编辑模式。设置 config["enable_edit"] 并根据架构应用模型 patch（Krea2 / Flux2Klein）。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pipeline | PIPELINE_DATA | ✅ | 管线数据 |
| enable | BOOLEAN | ✅ | 是否启用编辑模式（默认 True） |

**输出:** `pipeline` (PIPELINE_DATA)

---

### PipelineEnableQwenEditNode

启用 QwenEdit 模式。设置 config["enable_qwen_edit"]。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pipeline | PIPELINE_DATA | ✅ | 管线数据 |
| enable | BOOLEAN | ✅ | 是否启用 QwenEdit（默认 True） |

**输出:** `pipeline` (PIPELINE_DATA)

---

### PipelineDetectNode

管线检测。在 pipeline 上运行 detector 生成 mask。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pipeline | PIPELINE_DATA | ✅ | 管线数据 |
| detector | * | ✅ | 检测器模型 |
| detector_threshold | FLOAT | ✅ | 检测器阈值 0.0-1.0（默认 0.2） |
| detector_prompt | STRING | ✅ | 检测器 prompt |
| detector_dilation | INT | ✅ | 检测器膨胀 0-64（默认 4） |
| detector_crop_factor | FLOAT | ✅ | 检测器裁剪因子 1.0-4.0（默认 1.5） |
| detector_drop_size | INT | ✅ | 检测器丢弃尺寸 0-512（默认 0） |
| detector_grow | INT | ✅ | mask 扩展像素（默认 0） |
| detector_blur | INT | ✅ | mask 模糊像素（默认 0） |

**输出:** `pipeline` (PIPELINE_DATA), `mask` (MASK)

---

### PipelineTagNode

管线打标。在 pipeline 上运行 tagger 生成 prompt。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pipeline | PIPELINE_DATA | ✅ | 管线数据 |
| tagger | * | ✅ | Tagger 模型 |

**输出:** `pipeline` (PIPELINE_DATA), `tag` (STRING)

---

### PipelineGetPromptNode

管线 Prompt 获取。从 pipeline 中提取 prompt 和 LoRA 信息。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pipeline | PIPELINE_DATA | ✅ | 管线数据 |
| context_regex | STRING | ✅ | 上下文匹配正则（默认 ".+"） |

**输出:** `positive` (STRING), `negative` (STRING), `loras` (STRING)

---

### PipelineSamplerDataNode

管线采样数据获取。从 pipeline 中提取采样相关参数。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pipeline | PIPELINE_DATA | ✅ | 管线数据 |
| context_regex | STRING | ✅ | 上下文匹配正则（默认 ".+"） |

**输出:** `pipeline` (PIPELINE_DATA), `model` (MODEL), `positive` (CONDITIONING), `negative` (CONDITIONING), `latent` (LATENT)

---

### ApplyLorasNode

应用 LoRA。使用 loras 字符串对 model 进行 LoRA 注入。支持 `lora:name:strength` 和 `lora_path:path:strength` 格式。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| model | MODEL | ✅ | 基础模型 |
| loras | STRING | ✅ | LoRA 配置字符串（forceInput，逗号分隔） |

**输出:** `model` (MODEL)

---

## 🎬 视频节点

### VideoManagerNode

视频信息管理器。存储和传递视频片段信息字符串。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| videoInfo | STRING | ✅ | 视频信息字符串 |

**输出:** `video_segments` (VideoSegments)

---

### UrlVideoNode

URL 视频下载。支持直接视频链接和 YouTube/Bilibili/Pornhub/Hanime1 等网页链接（通过 yt-dlp），自动缓存到本地。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | STRING | ✅ | 视频或网页 URL |
| cache_path | COMBO | ✅ | 缓存选择（"URL"=使用 URL 下载，或选择已缓存视频） |
| clear_cache | BOOLEAN | ❌ | 清除缓存并重新下载（默认 False） |

**输出:** `video` (VIDEO)

---

### GetVideoImageNode

视频单帧提取。根据时间戳和帧偏移从视频中提取单帧图片。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| video | VIDEO | ✅ | 输入视频对象 |
| timestamp | STRING | ✅ | 时间戳 hh:mm:ss 格式（默认 "00:00:00"） |
| frame_offset | INT | ✅ | 帧偏移量（可为负数，默认 0） |

**输出:** `image` (IMAGE)

---

### GetVideoImagesNode

视频多帧提取。按起止时间戳和帧偏移批量提取图片序列，支持自定义目标 FPS。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| video | VIDEO | ✅ | 输入视频对象 |
| start_timestamp | STRING | ✅ | 起始时间戳 hh:mm:ss（默认 "00:00:00"） |
| start_frame_offset | INT | ✅ | 起始帧偏移（默认 0） |
| end_timestamp | STRING | ✅ | 结束时间戳 hh:mm:ss（默认 "00:01:00"） |
| end_frame_offset | INT | ✅ | 结束帧偏移（默认 0） |
| fps | FLOAT | ✅ | 目标 FPS，0=提取所有帧（默认 0.0） |

**输出:** `images` (IMAGE)

---

### GetVideoInfoNode

视频信息获取。输出视频的 FPS、总帧数和时长。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| video | VIDEO | ✅ | 输入视频对象 |

**输出:** `fps` (FLOAT), `frames` (FLOAT), `duration` (FLOAT)

---

### GetVideoSegmentNode

视频片段提取。按起止时间戳提取视频片段（图片序列 + 音频），支持自定义 FPS。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| video | VIDEO | ✅ | 输入视频对象 |
| start_timestamp | STRING | ✅ | 起始时间戳 hh:mm:ss（默认 "00:00:00"） |
| start_frame_offset | INT | ✅ | 起始帧偏移（默认 0） |
| end_timestamp | STRING | ✅ | 结束时间戳 hh:mm:ss（默认 "00:01:00"） |
| end_frame_offset | INT | ✅ | 结束帧偏移（默认 0） |
| fps | FLOAT | ✅ | 目标 FPS，0=提取所有帧（默认 0.0） |

**输出:** `images` (IMAGE), `audio` (AUDIO), `fps` (FLOAT)

---

### PreviewVideo

视频预览。在 ComfyUI 界面中预览视频。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| video | VIDEO | ✅ | 输入视频对象 |

**输出:** 无（预览节点）

---

### VideoWallpaperEngineNode

Wallpaper Engine 视频加载。自动检测运行的 Wallpaper Engine 进程，通过软链接加载 workshop 中的视频壁纸。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| video_title | COMBO | ✅ | 从 Wallpaper Engine 扫描到的视频列表中选择 |

**输出:** `video` (VIDEO)

---

### VideoFolderLoaderNode

视频文件夹加载。从 ComfyUI input/videos 目录扫描并选择视频文件。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file_name | COMBO | ✅ | 从 input/videos 目录扫描到的视频文件列表中选择 |

**输出:** `video` (VIDEO)

---

### VideoGetFileInfoNode

视频文件信息。获取视频的文件名（无扩展名）和完整路径。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| video | VIDEO | ✅ | 输入视频对象 |

**输出:** `file_name` (STRING), `path` (STRING)

---

### DiskImagesToVideoNode

图片序列转视频。将磁盘上保存的图片序列合成为视频文件（使用 ffmpeg）。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| folder_name | STRING | ✅ | 图片序列所在文件夹名 |
| file_name | STRING | ✅ | 输出视频文件名（不含扩展名） |
| fps | FLOAT | ✅ | 输出视频 FPS 1.0-120.0（默认 24.0） |
| crf | INT | ✅ | CRF 质量 0-51（默认 18） |
| audio | AUDIO | ❌ | 可选音频轨道 |

**输出:** `video_path` (STRING)

---

## 🔊 音频节点

### GetVideoAudioNode

视频音频提取。从视频对象中提取完整音频，输出标准 ComfyUI AUDIO 格式。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| video | VIDEO | ✅ | 输入视频对象 |

**输出:** `audio` (AUDIO)

---

### GetAudioInfoNode

音频信息获取。输出音频时长（秒）。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| audio | AUDIO | ✅ | 输入音频对象 |

**输出:** `duration` (FLOAT)

---

### GetAudioSegmentNode

音频片段截取。按起止时间戳和帧偏移从音频中截取片段。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| audio | AUDIO | ✅ | 输入音频对象 |
| start_timestamp | STRING | ✅ | 起始时间戳 hh:mm:ss（默认 "00:00:00"） |
| end_timestamp | STRING | ✅ | 结束时间戳 hh:mm:ss（默认 "00:01:00"） |
| start_frame_offset | INT | ❌ | 起始帧偏移（forceInput） |
| end_frame_offset | INT | ❌ | 结束帧偏移（forceInput） |
| fps | FLOAT | ❌ | FPS（forceInput） |

**输出:** `audio_segment` (AUDIO)

---

### VAEEncodeAudioTiled

音频 VAE 编码（分块）。将音频编码为 latent，用于音频生成模型。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| audio | AUDIO | ✅ | 输入音频对象 |
| vae | VAE | ✅ | VAE 模型（需支持音频编码） |

**输出:** `latent` (LATENT)

---

## 💾 磁盘 IO 节点

### DiskSaveImagesNode

图片保存到磁盘。将图片批量保存到 ComfyUI/output/Images 目录，支持清空模式和追加模式。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| images | IMAGE | ✅ | 输入图片 |
| folder_name | STRING | ✅ | 保存文件夹名（默认 "my_images"） |
| folder_clear | BOOLEAN | ✅ | True=清空文件夹后保存，False=追加续编号（默认 True） |
| addition | STRING | ❌ | 附带文本描述（每个图片一个 .txt 文件，forceInput） |

**输出:** `folder_name` (STRING)

---

### DiskLoadImagesNode

磁盘图片加载。从指定文件夹加载已保存的图片序列和对应的 addition 文本。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| folder_name | STRING | ✅ | 加载文件夹名（默认 "my_images"） |

**输出:** `images` (IMAGE[]), `additions` (STRING[])

---

### DiskLoadImageCountNode

图片数量统计。返回指定文件夹中的图片数量。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| folder_name | STRING | ✅ | 文件夹名（默认 "my_images"） |

**输出:** `count` (INT)

---

### LocalImageLoaderNode

本地随机图片加载。从指定根目录随机选择子目录并加载图片，支持 regex 过滤和顺序索引。自动管理 seed 和 index 状态。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| root_directory | STRING | ✅ | 根目录路径 |
| random_seed | INT | ✅ | 随机种子 |
| index | INT | ✅ | 图片索引 0-10000（默认 0） |
| search | STRING | ✅ | 子目录名正则过滤（默认 ".*"） |

**输出:** `image` (IMAGE)

---

### SaveDataToNode

将 dict 数据编码到最新生成的 PNG 图片中作为 metadata（A1111 风格）。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| signal | * | ✅ | 触发信号（任意类型，用于触发上游执行） |
| data | DICT | ✅ | 要编码的字典数据 |

**输出:** `signal` (*)

---

## 🌐 网络加载节点

### EHentaiRandomNode

E-Hentai 随机图片。根据搜索关键词随机获取漫画并加载指定页的图片。自动管理 seed 和 page_index 实现翻页遍历。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| random_seed | INT | ✅ | 随机种子 |
| page_index | INT | ✅ | 页码索引 0-1000（默认 0） |
| search | STRING | ✅ | 搜索关键词 |

**输出:** `image` (IMAGE), `gallery_url` (STRING)

---

### EHentaiURLNode

E-Hentai URL 加载。直接通过画廊 URL 加载指定页面的图片。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| gallery_url | STRING | ✅ | 画廊 URL |
| page_index | INT | ✅ | 页码索引 0-1000（默认 0） |

**输出:** `image` (IMAGE), `gallery_url` (STRING)

---

### PixivImageLoaderNode

Pixiv 图片加载。支持 artwork（单作品）和 user（用户作品列表）两种模式。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| mode | COMBO | ✅ | 模式：artwork / user（默认 artwork） |
| id | INT | ✅ | artwork ID 或 user ID |
| page_index | INT | ✅ | 页码索引 0-100（默认 0，0=随机） |

**输出:** `image` (IMAGE), `new_index` (INT), `node_id` (INT)

---

## ⏱️ 时间戳节点

### TimestampDurationNode

时间戳时长计算。计算两个 hh:mm:ss 格式时间戳之间的时长。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| start_timestamp | STRING | ✅ | 起始时间戳 hh:mm:ss（默认 "00:00:00"） |
| end_timestamp | STRING | ✅ | 结束时间戳 hh:mm:ss（默认 "00:01:00"） |

**输出:** `duration_timestamp` (STRING), `duration_seconds` (INT)

---

### TimestampForLengthNode

时间戳偏移计算。在输入时间戳上加减指定秒数。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| input_timestamp | STRING | ✅ | 输入时间戳 hh:mm:ss（默认 "00:00:00"） |
| seconds | INT | ✅ | 增减秒数 -3600~3600（默认 60） |

**输出:** `result_timestamp` (STRING), `result_seconds` (INT)

---

## 🔀 分支/流程控制节点

### BranchNoneNode

None 值分支。当 check 输入为 None 时输出 on_none，否则输出 check。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| check | * | ✅ | 检查值 |
| on_none | * | ❌ | check 为 None 时的输出（lazy 加载） |

**输出:** `*` (任意类型)

---

### IsOptionalNoneNode

可选输入检测。检测可选输入是否为空，输出布尔值。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| check | * | ❌ | 可选输入值 |

**输出:** `is_none` (BOOLEAN)

---

### BranchOptionalRequiredNode

可选转必需。将可选输入作为必需输出传递。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| required | * | ❌ | 可选输入值 |

**输出:** `required` (任意类型)

---

### BranchGroupNode

分支组节点。空节点，用于组织工作流中的分支结构。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| 无 | | | |

**输出:** 无

---

### BranchSwitchNode

布尔开关。toggle 为 True 时输出 value，否则输出 None。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| value | * | ✅ | 输入值（lazy 加载） |
| toggle | BOOLEAN | ✅ | 开关（默认 False） |
| relay_expression | STRING | ❌ | 中继表达式，用于节点间布尔逻辑 |
| active_config | STRING | ❌ | 激活配置：mute/bypass/foldout 等操作 |

**输出:** `*` (任意类型)

---

### BranchSwitchesNode

多路选择器。通过 select_input 整数参数从多个输入中选择一个输出。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| select | COMBO | ✅ | 选择显示（默认 "[None]"） |
| select_input | INT | ✅ | 选择输入索引（默认 0） |
| select_config | STRING | ✅ | 选择配置：mute/bypass/set 等操作 |
| input1+ | * | ❌ | 动态扩展输入（lazy 加载，自动添加更多） |

**输出:** `output` (*), `select` (STRING), `select_index` (INT)

---

### BranchBooleanNode

布尔透传。直接透传布尔 toggle 值。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| toggle | BOOLEAN | ✅ | 布尔值（默认 False） |
| relay_expression | STRING | ❌ | 中继表达式 |
| active_config | STRING | ❌ | 激活配置 |

**输出:** `toggle` (BOOLEAN)

---

### BranchManagerNode

纯前端节点。显示所有分支节点的依赖关系图。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| 无 | | | |

**输出:** 无

---

## 📋 List 操作节点

### ListMergeNode

通用列表合并。将最多 4 个任意类型列表合并为一个列表。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| list0 | * | ❌ | 列表 0 |
| list1 | * | ❌ | 列表 1 |
| list2 | * | ❌ | 列表 2 |
| list3 | * | ❌ | 列表 3 |

**输出:** `List` (LIST)

---

### ListDictMergeNode

DICT 列表合并。将最多 4 个字典列表合并。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| list0 | DICT | ❌ | 列表 0 |
| list1 | DICT | ❌ | 列表 1 |
| list2 | DICT | ❌ | 列表 2 |
| list3 | DICT | ❌ | 列表 3 |

**输出:** `DICT` (DICT[])

---

### ListMaskMergeNode

MASK 列表合并。将最多 4 个 mask 列表合并。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| list0 | MASK | ❌ | 列表 0 |
| list1 | MASK | ❌ | 列表 1 |
| list2 | MASK | ❌ | 列表 2 |
| list3 | MASK | ❌ | 列表 3 |

**输出:** `MASK` (MASK[])

---

### ListRegexPackMergeNode

REGEX_PACK 列表合并。将最多 4 个正则包列表合并。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| list0 | REGEX_PACK | ❌ | 列表 0 |
| list1 | REGEX_PACK | ❌ | 列表 1 |
| list2 | REGEX_PACK | ❌ | 列表 2 |
| list3 | REGEX_PACK | ❌ | 列表 3 |

**输出:** `REGEX_PACK` (REGEX_PACK[])

---

## 📖 Dictionary 操作节点

### DictionaryNewNode

字典创建。通过文本字符串（Python 字典字面量格式）创建字典。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dictionary_text | STRING | ✅ | Python 字典字面量字符串（多行） |

**输出:** `Dict` (DICT)

---

### DictionarySetNode

字典键值设置。向字典中设置指定 key 的 value，不存在则新增。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| key | STRING | ✅ | 键名 |
| value | * | ✅ | 值（任意类型） |
| dictionary | DICT | ❌ | 上游字典 |

**输出:** `Dict` (DICT)

---

### DictionaryGetNode

字典值获取。按 key 从字典中获取任意类型的值。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dictionary | DICT | ✅ | 字典 |
| key | STRING | ✅ | 键名 |

**输出:** `*` (任意类型)

---

### DictionaryValuesNode

字典值提取。提取字典中所有 value 并输出为列表。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dictionary | DICT | ✅ | 字典 |

**输出:** `values` (LIST)

---

### DictIndexSetNode

索引化字典设置。将 key 与 index 拼接后作为键存入字典（如 `key + str(index)`）。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| index | * | ✅ | 索引值（任意类型） |
| key | STRING | ✅ | 键名前缀 |
| value | * | ✅ | 值 |
| dictionary | DICT | ❌ | 上游字典 |

**输出:** `Dict` (DICT)

---

### DictIndexGetNode

索引化字典获取。按 key + index 拼接后的键从字典获取值。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dictionary | DICT | ✅ | 字典 |
| index | * | ✅ | 索引值 |
| key | STRING | ✅ | 键名前缀 |

**输出:** `value` (任意类型)

---

### DictionaryListSetNode

字典列表批量设置。支持列表输入的字典批量操作，每个元素独立创建字典。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| key | STRING | ✅ | 键名 |
| values | * | ✅ | 值列表 |
| dictionary | DICT | ❌ | 上游字典模板 |

**输出:** `Dict` (DICT[])

---

### DictionaryConditionSetNode

条件字典设置。当 dictionary 中 condition 键的值为 True 时，才设置 key-value。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| condition | STRING | ✅ | 条件键名 |
| key | STRING | ✅ | 要设置的键名 |
| value | * | ✅ | 要设置的值 |
| dictionary | DICT | ❌ | 上游字典 |

**输出:** `Dict` (DICT)

---

### DictConditionSetFlag

条件字典 + 成功标志。与 DictionaryConditionSetNode 类似，额外输出是否设置成功的布尔值。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| condition | STRING | ✅ | 条件键名 |
| key | STRING | ✅ | 要设置的键名 |
| value | BOOLEAN | ✅ | 要设置的布尔值（默认 True） |
| dictionary | DICT | ❌ | 上游字典 |

**输出:** `Dict` (DICT), `Success` (BOOLEAN)

---

### DictSwitch

字典条件分支。根据字典中 condition 键的值选择输出 on_success 或 on_failure。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dictionary | DICT | ✅ | 字典 |
| condition | STRING | ✅ | 条件键名 |
| key | STRING | ✅ | 结果存储键名 |
| on_failure | * | ✅ | 失败时的输出 |
| on_success | * | ❌ | 成功时的输出（lazy 加载） |

**输出:** `Dict` (DICT), `*` (任意类型)

---

### DictionaryGetIntNode

字典整数获取。按 key 获取值并转换为 INT。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dictionary | DICT | ✅ | 字典 |
| key | STRING | ✅ | 键名 |

**输出:** `value` (INT)

---

### DictionaryGetFloatNode

字典浮点数获取。按 key 获取值并转换为 FLOAT。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dictionary | DICT | ✅ | 字典 |
| key | STRING | ✅ | 键名 |

**输出:** `value` (FLOAT)

---

### DictionaryGetStringNode

字典字符串获取。按 key 获取值并转换为 STRING。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dictionary | DICT | ✅ | 字典 |
| key | STRING | ✅ | 键名 |

**输出:** `value` (STRING)

---

### DictionaryGetBooleanNode

字典布尔获取。按 key 获取布尔值，同时返回字典本身和 flag。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dictionary | DICT | ✅ | 字典 |
| key | STRING | ✅ | 键名 |

**输出:** `dict` (DICT), `flag` (BOOLEAN)

---

## 📝 文本/字符串节点

### SmartJoinStringNode

智能字符串拼接。用分隔符拼接两个字符串，自动处理空字符串。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| str0 | STRING | ✅ | 字符串 0 |
| str1 | STRING | ✅ | 字符串 1 |
| delimiter | STRING | ✅ | 分隔符（默认 ","） |

**输出:** (STRING)

---

### StringToIntNode

字符串转整数。将数字字符串转换为 INT 类型。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| text | STRING | ✅ | 数字字符串 |

**输出:** `number` (INT)

---

### TextFormatNode

文本格式化。使用 Python 的 `str.format()` 对模板字符串进行格式化，支持最多 8 个输入占位符。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| template | STRING | ✅ | 格式模板字符串（用 {0}, {1}... 或 {name} 占位） |
| input0~input7 | * | ❌ | 最多 8 个输入值 |

**输出:** `text` (STRING)

---

### RegexMatcherNode

正则匹配。对输入字符串执行正则匹配，返回所有匹配项列表和是否有匹配的布尔值。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| regex_pattern | STRING | ✅ | 正则表达式（默认 `\w+`） |
| input_string | STRING | ✅ | 输入字符串 |

**输出:** `matches` (STRING[]), `has_matches` (BOOLEAN)

---

### RegexPackMatcherNode

正则包匹配。从 REGEX_PACK 列表中筛选出匹配指定 key 和正则模式的包。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| match_key | STRING | ✅ | 匹配的 key（如 "title"，默认 "title"） |
| regex_pattern | STRING | ✅ | 正则表达式 |
| input_packs | REGEX_PACK | ✅ | 输入的正则包列表 |

**输出:** `packs` (REGEX_PACK[])

---

### RegexPackerNode

正则打包。将 title、多个 content 和 value 打包为 REGEX_PACK 结构。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | STRING | ✅ | 标题 |
| content0 | STRING | ✅ | 内容 0 |
| content1 | STRING | ✅ | 内容 1 |
| content2 | STRING | ✅ | 内容 2 |
| value0 | FLOAT | ✅ | 值 0（默认 1.0） |
| value1 | FLOAT | ✅ | 值 1（默认 1.0） |

**输出:** `pack` (REGEX_PACK)

---

### RegexUnpackerNode

正则解包。将 REGEX_PACK 解包还原为各字段。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pack | REGEX_PACK | ✅ | 正则包 |

**输出:** `title` (STRING), `content0` (STRING), `content1` (STRING), `content2` (STRING), `value0` (FLOAT), `value1` (FLOAT)

---

## 🧮 数学/脚本节点

### MathNode

数学表达式计算。支持 x/y/z 输入变量和丰富的数学函数，安全执行用户输入的数学表达式。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| math_expression | STRING | ✅ | 数学表达式（多行，可用 x/y/z 变量） |
| x | * | ❌ | 变量 x |
| y | * | ❌ | 变量 y |
| z | * | ❌ | 变量 z |

**输出:** `int` (INT), `float` (FLOAT)

---

### ScriptNode

自定义 Python 脚本执行。在节点中执行用户编写的 Python 脚本，通过 `result` 变量返回结果。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| script | STRING | ✅ | Python 脚本代码（多行） |
| x | * | ❌ | 变量 x |
| y | * | ❌ | 变量 y |
| z | * | ❌ | 变量 z |

**输出:** `result` (*), `list` (*)

---

## 📂 文件操作节点

### FileCheckNode

文件存在检查。检查指定路径的文件是否存在。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file_path | STRING | ✅ | 文件路径 |

**输出:** `exists` (BOOLEAN)

---

### LoadTextNode

文本文件加载。加载文本文件内容，自动过滤以 `#` 开头的注释行。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file_path | STRING | ✅ | 文件路径 |

**输出:** `text` (STRING)

---

### SaveTextNode

文本保存。将文本内容保存到指定文件路径，支持相对路径（相对于 ComfyUI/output）。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| data | STRING | ✅ | 文本内容（forceInput） |
| output_path | STRING | ✅ | 输出文件路径 |

**输出:** `saved_text` (STRING)

---

### ExtractFolderNameNode

提取文件夹名。从完整路径中提取最后一级目录名。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| path | STRING | ✅ | 完整路径 |

**输出:** (STRING)

---

### OpenNode

文件打开。从 ComfyUI/output/Open 目录读取最新文件并用系统默认程序打开。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file_path | STRING | ✅ | 文件路径 |

**输出:** `file_path` (STRING)

---

## 🎛️ LoRA 节点

### LoadLoraPackNode

LoRA 配置打包。选择 LoRA 文件并配置正/负 prompt 和 model/clip 强度，打包为 REGEX_PACK。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| lora | COMBO | ✅ | LoRA 文件名列表 |
| enable | BOOLEAN | ✅ | 是否启用（默认 True） |
| positive | STRING | ✅ | 正向 prompt |
| negative | STRING | ✅ | 负向 prompt |
| strength_model | FLOAT | ✅ | 模型强度（默认 1.0） |
| strength_clip | FLOAT | ✅ | CLIP 强度（默认 1.0） |

**输出:** `pack` (REGEX_PACK)

---

### LoadLoraFromPackNode

LoRA 批量加载。从 REGEX_PACK 列表中逐个加载 LoRA 到 model 和 clip。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| model | MODEL | ✅ | 基础模型 |
| clip | CLIP | ✅ | CLIP 模型 |
| packs | REGEX_PACK | ✅ | LoRA 包列表 |

**输出:** `model` (MODEL), `clip` (CLIP)

---

### TextEncodeFromPackNode

从 Pack 编码文本。从 REGEX_PACK 列表中提取所有 positive/negative 并与全局 prompt 合并，编码为 CONDITIONING。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| clip | CLIP | ✅ | CLIP 模型 |
| packs | REGEX_PACK | ✅ | LoRA 包列表 |
| pos_global | STRING | ✅ | 全局正向 prompt（forceInput） |
| neg_global | STRING | ✅ | 全局负向 prompt（forceInput） |

**输出:** `positive` (CONDITIONING), `negative` (CONDITIONING), `pos_local` (STRING), `neg_local` (STRING)

---

## 🔧 工具节点

### NeedNode

空值输出。接收任意输入但始终输出 None。用于强制触发上游节点执行。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| any | * | ✅ | 任意输入 |

**输出:** `none` (None)

---

### AnyPassNode

类型透传。将任意类型输入原样输出，用于绕过类型检查。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| any | * | ✅ | 任意输入 |

**输出:** `any` (任意类型)

---

### TypeDebugNode

类型调试。输出输入数据的类型名称，用于调试工作流中的数据类型问题。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| any | * | ✅ | 任意输入 |

**输出:** `log` (STRING)

---

### ApplicationNode

纯前端节点。收集其他节点的 widget 并在单一包装 widget 中显示。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| collect_nodes | STRING | ✅ | 收集格式：`id:234,id:145,regex:test,name:TT`（多行） |

**输出:** 无

---

## 🔭 高斯/3D 节点

### ExtrinsicsCompareNode

外参矩阵比较。比较两帧相机外参矩阵，计算相对位移（x/y/z）和相对旋转（pitch/yaw/roll 欧拉角）。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| current | EXTRINSICS | ✅ | 当前外参矩阵 |
| next | EXTRINSICS | ✅ | 下一帧外参矩阵 |

**输出:** `x` (FLOAT), `y` (FLOAT), `z` (FLOAT), `pitch` (FLOAT), `yaw` (FLOAT), `roll` (FLOAT)

---

## 🏋️ 训练节点

### TrainEditLoraNode

训练 reference latent LoRA。通过节点图传入训练数据，训练用于编辑的 LoRA。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| model | MODEL | ✅ | 基础模型 |
| latents | LATENT | ✅ | 目标图潜空间（支持 batch） |
| positive | CONDITIONING | ✅ | 正样本 conditioning（需包含 reference_latents） |
| rank | INT | ✅ | LoRA 秩 1-128（默认 32） |
| alpha | FLOAT | ✅ | LoRA 缩放系数 0.1-512.0（默认 16.0） |
| learning_rate | FLOAT | ✅ | 学习率（默认 0.0005） |
| steps | INT | ✅ | 总训练步数（默认 1000） |
| batch_size | INT | ✅ | batch 大小（默认 1） |
| grad_accumulation_steps | INT | ✅ | 梯度累积步数（默认 1） |
| optimizer | COMBO | ✅ | 优化器：AdamW / Adam / SGD / RMSprop（默认 AdamW） |
| loss_function | COMBO | ✅ | 损失函数：MSE / L1 / Huber / SmoothL1（默认 MSE） |
| seed | INT | ✅ | 随机种子 |
| training_dtype | COMBO | ✅ | 训练精度：bf16 / fp32 / none（默认 bf16） |
| architecture | COMBO | ✅ | 架构：Krea2 / Flux2Klein（默认 Krea2） |
| output_name | STRING | ✅ | 输出 LoRA 文件名（默认 "reference_lora"） |
| save_every | INT | ✅ | 每 N 步保存检查点（默认 500） |

**输出:** `lora_path` (STRING)

---

## 🖥️ 服务端口说明

| 服务 | 端口范围 |
|------|----------|
| GSplat/SuperSplat 渲染 | 8080-9000 |
| Switch 选择器 | 8600-8700 |
| Detailer Sampler | 8700-8800 |
| Assets 画布 | 8800-8900 |
| SuperSplat 前端 | 3000（常驻进程） |
