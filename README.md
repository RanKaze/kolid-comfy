# Kolid-Comfy

一套基于 ComfyUI 的自定义节点扩展，提供图像/视频处理、AI 采样、交互式 Web UI 等功能，通过临时 HTTP 服务器（8500-8899 端口）提供交互式浏览器界面。

---

## 📋 交互式 Web UI 节点

这些节点会启动本地 HTTP 服务器并打开浏览器，允许用户通过可视化界面进行交互操作。

| 节点 | 功能说明 |
|------|----------|
| **SnapshotSwitchNode** | 动态输入选择器。连接多个上游输入后，打开浏览器页面预览所有输入内容，选择其中一个作为输出。支持 lazy 模式（不加载未选中输入）和历史快照缓存。 |
| **SnapshotPromptNode** | 提示词选择器。在浏览器中按分类浏览和选择 prompt 词条，支持 LoRA 选择、自定义 prompt 输入和预制词包（prefab）。输出合并后的 prompt 字符串、LoRA 列表和触发词。 |
| **SnapshotDetailerSamplerNode** | 交互式细节修复采样器。整合 mask 绘制 → 提示词选择 → AI 重绘 → 对比切换的完整循环流程。用户可多次迭代精修图片细节。 |
| **SnapshotAssetsNode** | tldraw 画布资源管理节点。提供拖放式图片/视频卡片管理面板，支持图片强度配置、prompt 输入、Slot 插槽配置。输出 prompt、图片列表、强度列表、视频列表和 slot 数据。 |
| **SnapshotGaussianNode** | 高斯点云预览节点。加载 PLY 文件并在浏览器中渲染 3D 高斯泼溅场景。支持 **GSplat**（轻量渲染）和 **SuperSplat**（需要 Node.js，魔改 UI）两种渲染方式。按 Enter 截图输出。 |
| **SnapshotImageNode** | 图片区域截图。在浏览器中打开图片，用户可拖拽选择矩形区域并截图输出。 |
| **SnapshotImagePointsNode** | SAM 坐标点标记。在图片上用鼠标标记正/负坐标点，输出 SAM3 格式的坐标数据，用于 SAM 模型分割。支持 modifying 模式缓存历史点位。 |
| **SnapshotMaskNode** | Mask 绘制工具。在浏览器中用画笔在图片上绘制 mask，支持画笔大小调节、detector 自动检测、mask 膨胀（grow）。 |
| **SnapshotOutpaintMaskNode** | Outpaint 扩展区域设置。在浏览器中通过拖拽边框设置上下左右扩展像素，输出扩展后的图片和 mask。 |
| **SnapshotVideoNode** | 视频时间戳选择。在浏览器中预览视频并精确定位到特定帧，输出时间戳和帧偏移量。 |
| **SnapshotCaptureNode** | 桌面截图工具。弹出浮动面板，支持 Shot（框选截图）和 Previous（加载上次缓存）两种模式。直接截取屏幕任意区域作为 ComfyUI 图片输入。 |

---

## 🖼️ 图像处理节点

| 节点 | 功能说明 |
|------|----------|
| **FitNode** | 图片适配缩放。将图片等比缩放后居中放入指定尺寸画布，空白区域用指定颜色填充。输出适配后的图片、位置信息和 mask。 |
| **RecoverFitNode** | 配合 FitNode 使用。根据 FitInfo 将适配后的图片恢复到原始尺寸。 |
| **ImageLimitPixelNode** | 像素数量限制。当图片像素超过设定值（默认 1MP）时自动缩小，输出 resize_info 供后续恢复。支持附带 mask 同步缩放。 |
| **ImageRecoverResizeNode** | 配合 ImageLimitPixelNode 使用。根据 resize_info 将图片恢复到原始尺寸。 |
| **ImageCropMaskNode** | Mask 裁剪。根据 mask 的包围盒裁剪图片，支持 reserve 参数留出边距。输出 crop_info 供后续恢复。 |
| **ImageRecoverCropNode** | 配合 ImageCropMaskNode 使用。将裁剪后的图片恢复到原始画布，支持 mask_blend / mask_only / bounds_only 三种恢复模式。支持列表输入（多图累积粘贴）。 |
| **ImageBatchNode** | 多图合批。将多张不同尺寸的图片统一转为相同尺寸的 Batch，居中填充。支持自定义宽高、对齐步长和填充颜色。 |
| **ImageRecoverBatchNode** | 配合 ImageBatchNode 使用。将 Batch 后的图片恢复为原始尺寸的列表。 |
| **ImageDetectContentNode** | 智能内容检测。检测图片是否有均匀边框（通过四角颜色分析），自动生成内容区域 mask，去除黑边/白边。 |
| **ImageToBase64Node** | 图片转 Base64 字符串。支持可选 data URI 前缀。 |
| **Base64ToImageNode** | Base64 字符串转图片（ComfyUI IMAGE 格式）。 |

---

## 🎨 采样管线节点 (Pipeline)

采样管线节点提供模块化的采样工作流，通过 PipelineData 在各节点间传递模型、图片、条件等上下文。

### 管线容器
| 节点 | 功能说明 |
|------|----------|
| **PipelineNode** | 管线数据容器。整合 model、clip、vae、image、latent、mask、sampler/scheduler 参数、context、reference、config 等所有采样相关数据，支持链式传递和增量更新。 |

### 上下文管理 (Context)
| 节点 | 功能说明 |
|------|----------|
| **ContextNode** | 上下文数据构建。按名称管理多组 positive/negative prompt 和 LoRA 配置，支持增量追加。 |
| **ContextQueryNode** | 上下文查询。通过相似度模型对图片进行匹配查询，根据 threshold 和 prompt_regex 自动选择合适的上下文配置。 |

### 参考数据管理 (Reference)
| 节点 | 功能说明 |
|------|----------|
| **ReferenceLatentNode** | 参考 Latent 设置。将 latent 附加到 ReferenceData 中，供采样时使用。 |
| **ReferenceContolNetNode** | ControlNet 参考设置。配置 ControlNet 及对应图片、强度、起止百分比。 |
| **ReferenceGuidanceNode** | 引导强度设置。配置 positive/negative guidance 值。 |
| **ReferenceIPAdapterNode** | IP-Adapter 参考设置。支持多种预设（STANDARD、PLUS、PLUS FACE 等），配置风格/构图权重、embed 组合方式、起止步数等。**支持列表输入**（多参考图）。 |

### 配置管理 (Config)
| 节点 | 功能说明 |
|------|----------|
| **ConfigNode** | 配置键值设置。将任意 key-value 存入 ConfigData。 |
| **ConfigGetNode** | 配置值获取。从 ConfigData 中按 key 读取值（以 STRING 返回）。 |
| **SamplerConfigNode** | 采样参数配置包。将 CFG、步数、采样器、调度器、正/负 prompt 打包为统一格式输出。 |

### 采样执行
| 节点 | 功能说明 |
|------|----------|
| **PipelineSamplerNode** | 基础采样器。支持 context_regex 上下文匹配、denoise 控制、step_rate 步数比例。可选 Tagger 自动打标追加 prompt。 |
| **PipelineSamplerAdvancedNode** | 高级采样器（KSamplerAdvanced 封装）。支持 add_noise、起止步数、leftover_noise 控制。 |
| **PipelineDetailerAdvancedNode** | 高级 Detailer 节点。完整实现 Crop → Limit Pixels → KSamplerAdvanced → Recover Size → Recover Crop 的细节修复管线。支持 detector 自动检测 mask、tagger 打标、inpaint 模式、foreach_mask（多 mask 独立处理）。 |
| **PipelineVideoSamplerAdvancedNode** | 视频逐帧采样。对视频片段逐帧执行高级采样。 |
| **PipelineDecodeNode** | 管线解码。将 pipeline 中的 latent 解码为 image。 |
| **PipelineLimitPixelNode** | 管线像素限制。对 pipeline 中的 image 进行像素限制，resize_info 自动压入栈中。 |
| **PipelineRecoverResizeNode** | 管线尺寸恢复。从栈中弹出 resize_info 并恢复图片尺寸。 |
| **PipelineAddNoiseNode** | 管线加噪。向 pipeline latent 添加噪声。 |
| **PipelineToggleMaskInpaintNode** | 管线 Inpaint 切换。设置或取消 inpaint mask 模式。 |
| **PipelineDetectNode** | 管线检测。在 pipeline 上运行 detector 生成 mask。 |
| **PipelineTagNode** | 管线打标。在 pipeline 上运行 tagger 生成 prompt。 |
| **PipelineGetPromptNode** | 管线 Prompt 获取。从 pipeline 中提取 prompt 和 LoRA 信息。 |
| **PipelineSamplerDataNode** | 管线采样数据获取。从 pipeline 中提取采样相关参数。 |
| **ApplyLorasNode** | 应用 LoRA。使用 pipeline 中的 LoRA 配置对 model/clip 进行 LoRA 注入。 |

---

## 🎬 视频节点

| 节点 | 功能说明 |
|------|----------|
| **VideoManagerNode** | 视频信息管理器。存储和传递视频片段信息字符串。 |
| **UrlVideoNode** | URL 视频下载。支持直接视频链接和 YouTube/Bilibili/Pornhub/Hanime1 等网页链接（通过 yt-dlp），自动缓存到本地。支持缓存管理。 |
| **GetVideoImageNode** | 视频单帧提取。根据时间戳和帧偏移从视频中提取单帧图片。 |
| **GetVideoImagesNode** | 视频多帧提取。按起止时间戳和帧偏移批量提取图片序列，支持自定义目标 FPS。 |
| **GetVideoInfoNode** | 视频信息获取。输出视频的 FPS、总帧数和时长。 |
| **GetVideoSegmentNode** | 视频片段提取。按起止时间戳提取视频片段（图片序列 + 音频），支持自定义 FPS。 |
| **PreviewVideo** | 视频预览。在 ComfyUI 界面中预览视频。 |
| **VideoWallpaperEngineNode** | Wallpaper Engine 视频加载。自动检测运行的 Wallpaper Engine 进程，通过软链接加载 workshop 中的视频壁纸。 |
| **VideoFolderLoaderNode** | 视频文件夹加载。从 ComfyUI input/videos 目录扫描并选择视频文件。 |
| **VideoGetFileInfoNode** | 视频文件信息。获取视频的文件名（无扩展名）和完整路径。 |
| **DiskImagesToVideoNode** | 图片序列转视频。将磁盘上保存的图片序列合成为视频文件（使用 ffmpeg）。支持自定义 FPS、CRF 和音频轨道。 |

---

## 🔊 音频节点

| 节点 | 功能说明 |
|------|----------|
| **GetVideoAudioNode** | 视频音频提取。从视频对象中提取完整音频，输出标准 ComfyUI AUDIO 格式 `{waveform: [1, C, T], sample_rate: int}`。 |
| **GetAudioSegmentNode** | 音频片段截取。按起止时间戳和帧偏移从音频中截取片段。 |

---

## 💾 磁盘 IO 节点

| 节点 | 功能说明 |
|------|----------|
| **DiskSaveImagesNode** | 图片保存到磁盘。将图片批量保存到 ComfyUI/output/Images 目录，支持清空模式（从头编号）和追加模式（续编号）。可附带 addition 文本描述（.txt 文件）。 |
| **DiskLoadImagesNode** | 磁盘图片加载。从指定文件夹加载已保存的图片序列和对应的 addition 文本。 |
| **DiskLoadImageCountNode** | 图片数量统计。返回指定文件夹中的图片数量。 |
| **LocalImageLoaderNode** | 本地随机图片加载。从指定根目录随机选择子目录并加载图片，支持 regex 过滤和顺序索引。自动管理 seed 和 index 状态。 |

---

## 🌐 网络加载节点

| 节点 | 功能说明 |
|------|----------|
| **EHentaiRandomNode** | E-Hentai 随机图片。根据搜索关键词随机获取漫画并加载指定页的图片。自动管理 seed 和 page_index 实现翻页遍历。 |
| **EHentaiURLNode** | E-Hentai URL 加载。直接通过画廊 URL 加载指定页面的图片。 |
| **PixivImageLoaderNode** | Pixiv 图片加载。支持 artwork（单作品）和 user（用户作品列表）两种模式，自动获取图片 URL 并下载。 |

---

## ⏱️ 时间戳节点

| 节点 | 功能说明 |
|------|----------|
| **TimestampDurationNode** | 时间戳时长计算。计算两个 hh:mm:ss 格式时间戳之间的时长，输出格式化的时间戳和秒数。 |
| **TimestampForLengthNode** | 时间戳偏移计算。在输入时间戳上加减指定秒数，输出新的时间戳和总秒数。 |

---

## 🔀 分支/流程控制节点

| 节点 | 功能说明 |
|------|----------|
| **BranchNoneNode** | None 值分支。当 check 输入为 None 时输出 on_none，否则输出 check。支持 lazy 加载。 |
| **IsOptionalNoneNode** | 可选输入检测。检测可选输入是否为空，输出布尔值。 |
| **BranchOptionalRequiredNode** | 可选转必需。将可选输入作为必需输出传递。 |
| **BranchGroupNode** | 分支组节点。空节点，用于组织工作流中的分支结构。 |
| **BranchSwitchNode** | 布尔开关。toggle 为 True 时输出 value，否则输出 None。支持 lazy 加载。 |
| **BranchSwitchesNode** | 多路选择器。通过 select_input 整数参数从多个输入中选择一个输出。 |
| **BranchBooleanNode** | 布尔透传。直接透传布尔 toggle 值。 |

---

## 📋 List 操作节点

| 节点 | 功能说明 |
|------|----------|
| **ListMergeNode** | 通用列表合并。将最多 4 个任意类型列表合并为一个列表。 |
| **ListDictMergeNode** | DICT 列表合并。将最多 4 个字典列表合并。 |
| **ListMaskMergeNode** | MASK 列表合并。将最多 4 个 mask 列表合并。 |
| **ListRegexPackMergeNode** | REGEX_PACK 列表合并。将最多 4 个正则包列表合并。 |

---

## 📖 Dictionary 操作节点

| 节点 | 功能说明 |
|------|----------|
| **DictionaryNewNode** | 字典创建。通过文本字符串（Python 字典字面量格式）创建字典。 |
| **DictionarySetNode** | 字典键值设置。向字典中设置指定 key 的 value，不存在则新增。 |
| **DictionaryGetNode** | 字典值获取。按 key 从字典中获取任意类型的值。 |
| **DictionaryValuesNode** | 字典值提取。提取字典中所有 value 并输出为列表。 |
| **DictIndexSetNode** | 索引化字典设置。将 key 与 index 拼接后作为键存入字典（如 `key + str(index)`）。 |
| **DictIndexGetNode** | 索引化字典获取。按 key + index 拼接后的键从字典获取值。 |
| **DictionaryListSetNode** | 字典列表批量设置。支持列表输入的字典批量操作，每个元素独立创建字典。 |
| **DictionaryConditionSetNode** | 条件字典设置。当 dictionary 中 condition 键的值为 True 时，才设置 key-value。 |
| **DictConditionSetFlag** | 条件字典 + 成功标志。与 DictionaryConditionSetNode 类似，额外输出是否设置成功的布尔值。 |
| **DictSwitch** | 字典条件分支。根据字典中 condition 键的值选择输出 on_success 或 on_failure。支持 lazy 加载。 |
| **DictionaryGetIntNode** | 字典整数获取。按 key 获取值并转换为 INT。 |
| **DictionaryGetFloatNode** | 字典浮点数获取。按 key 获取值并转换为 FLOAT。 |
| **DictionaryGetStringNode** | 字典字符串获取。按 key 获取值并转换为 STRING。 |
| **DictionaryGetBooleanNode** | 字典布尔获取。按 key 获取布尔值，同时返回字典本身和 flag。 |

---

## 📝 文本/字符串节点

| 节点 | 功能说明 |
|------|----------|
| **SmartJoinStringNode** | 智能字符串拼接。用分隔符拼接两个字符串，自动处理空字符串（不会产生多余分隔符）。 |
| **StringToIntNode** | 字符串转整数。将数字字符串转换为 INT 类型。 |
| **TextFormatNode** | 文本格式化。使用 Python 的 `str.format()` 对模板字符串进行格式化，支持最多 8 个输入占位符。 |
| **RegexMatcherNode** | 正则匹配。对输入字符串执行正则匹配，返回所有匹配项列表和是否有匹配的布尔值。 |
| **RegexPackMatcherNode** | 正则包匹配。从 REGEX_PACK 列表中筛选出匹配指定 key 和正则模式的包。 |
| **RegexPackerNode** | 正则打包。将 title、多个 content 和 value 打包为 REGEX_PACK 结构。 |
| **RegexUnpackerNode** | 正则解包。将 REGEX_PACK 解包还原为各字段。 |

---

## 🧮 数学/脚本节点

| 节点 | 功能说明 |
|------|----------|
| **MathNode** | 数学表达式计算。支持 x/y/z 输入变量和丰富的数学函数（sqrt、sin、cos、log、pow 等），安全执行用户输入的数学表达式。 |
| **ScriptNode** | 自定义 Python 脚本执行。在节点中执行用户编写的 Python 脚本，通过 `result` 变量返回结果。支持列表输入和输出。 |

---

## 📂 文件操作节点

| 节点 | 功能说明 |
|------|----------|
| **FileCheckNode** | 文件存在检查。检查指定路径的文件是否存在，返回布尔值。 |
| **LoadTextNode** | 文本文件加载。加载文本文件内容，自动过滤以 `#` 开头的注释行。 |
| **SaveTextNode** | 文本保存。将文本内容保存到指定文件路径，支持相对路径（相对于 ComfyUI/output）。 |
| **ExtractFolderNameNode** | 提取文件夹名。从完整路径中提取最后一级目录名。 |
| **OpenNode** | 文件打开。从 ComfyUI/output/Open 目录读取最新文件并用系统默认程序打开。 |

---

## 🎛️ LoRA 节点

| 节点 | 功能说明 |
|------|----------|
| **LoadLoraPackNode** | LoRA 配置打包。选择 LoRA 文件并配置正/负 prompt 和 model/clip 强度，打包为 REGEX_PACK 供后续使用。 |
| **LoadLoraFromPackNode** | LoRA 批量加载。从 REGEX_PACK 列表中逐个加载 LoRA 到 model 和 clip。支持列表输入。 |
| **TextEncodeFromPackNode** | 从 Pack 编码文本。从 REGEX_PACK 列表中提取所有 positive/negative 并与全局 prompt 合并，编码为 CONDITIONING。 |

---

## 🔧 工具节点

| 节点 | 功能说明 |
|------|----------|
| **NeedNode** | 空值输出。接收任意输入但始终输出 None。用于强制触发上游节点执行。 |
| **AnyPassNode** | 类型透传。将任意类型输入原样输出，用于绕过类型检查。 |
| **TypeDebugNode** | 类型调试。输出输入数据的类型名称，用于调试工作流中的数据类型问题。 |

---

## 🔭 高斯/3D 节点

| 节点 | 功能说明 |
|------|----------|
| **ExtrinsicsCompareNode** | 外参矩阵比较。比较两帧相机外参矩阵，计算相对位移（x/y/z）和相对旋转（pitch/yaw/roll 欧拉角）。 |

---

## 🖥️ 服务端口说明

| 服务 | 端口范围 |
|------|----------|
| GSplat/SuperSplat 渲染 | 8080-9000 |
| Switch 选择器 | 8600-8700 |
| Detailer Sampler | 8700-8800 |
| Assets 画布 | 8800-8900 |
| SuperSplat 前端 | 3000（常驻进程） |
