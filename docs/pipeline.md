# 🎨 采样管线节点 (Pipeline)

[← 返回主 README](../README.md)

采样管线节点提供模块化的采样工作流，通过 PipelineData 在各节点间传递模型、图片、条件等上下文。

---

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

## 上下文管理 (Context)

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

## 参考数据管理 (Reference)

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

## 配置管理 (Config)

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

设置模型架构名称（如 Krea2、Flux2Klein、QwenEdit、QwenImage21）。

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

### ConfigQwenImage21Node

Qwen-Image-2.1 编辑参数配置。设置参考图缩放边长（`config["qwen_image21_resolution"]`）。

架构名设置 `QwenImage21` 时启用该架构的编辑模式（等价于 ComfyUI `TextEncodeQwenImage21` 节点的设计）：

- 参考图（Detailer 为 crop 图）与采样目标同尺寸，缩放按 32 取整（vision token 与 2x2 latent 网格对齐）
- 图像同时进入 Qwen3-VL text encoder（vision slots，prompt 里可用 `<image1>` 引用）与 `reference_latents`（DiT 原生拼接）
- 无需 model patch；PipelineEnableEditNode 对该架构为空操作
- Detailer 会强制 crop 尺寸 32 对齐（`PipelineDetailerAdvancedNode` 的 align、快照 Detailer 的 align 均自动提升到 32）

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| config | CONFIG_DATA | ❌ | 上游配置 |
| resolution | INT | ❌ | 参考图缩放边长，32 的倍数（默认 0=保持参考图自身尺寸并与采样目标同尺寸，推荐；>0 时面积约 resolution²，其它尺寸会偏移编辑） |

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

## 采样执行

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

启用编辑模式。设置 config["enable_edit"] 并根据架构应用模型 patch（Krea2 / Flux2Klein；QwenImage21 无需 patch）。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pipeline | PIPELINE_DATA | ✅ | 管线数据 |
| enable | BOOLEAN | ✅ | 是否启用编辑模式（默认 True） |

**输出:** `pipeline` (PIPELINE_DATA)

---

### PipelineEnableGenerateTextNode

启用 Generate Text。对齐 ComfyUI 的 `Generate Text`（`TextGenerate`）节点：开启后，把本节点的 `prompt`（指令）与 pipeline 中的 positive 提示词拼成 `prompt\n\npositive`，交给一个**文本生成** CLIP（Gemma / Qwen 等 LLM 编码器）生成新文本，然后用生成结果**完全替换** positive。

> 注意：`clip` 必须是**能生成文本**的编码器（如 Gemma 3），普通 SD/SDXL/Flux 的文本编码器没有 `generate` 方法，会失败。

设置写入 `config["enable_generate_text"] / ["generate_text_prompt"] / ["generate_text"]`，可选 `["generate_text_clip"]`；真正的生成发生在采样链的 prompt 注入点（`_run_pipeline_blocks` 的每个 Detailer block、以及照 `_parse_prompt` 之后的 interface 路径）。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| pipeline | PIPELINE_DATA | ✅ | 管线数据 |
| enable | BOOLEAN | ✅ | 是否启用（默认 True；prompt 为空时自动视为关闭） |
| prompt | STRING | ✅ | 指令 prompt（多行）。与 positive 拼接后送入 Generate Text |
| max_length | INT | ✅ | 最大生成 token 数 1-32768（默认 512） |
| sampling_mode | COMBO | ✅ | on / off（默认 on）。off = 不采样（贪心解码） |
| temperature | FLOAT | ✅ | 0.01-2.0（默认 0.7） |
| top_k | INT | ✅ | 0-1000（默认 64，0 = 关闭该过滤） |
| top_p | FLOAT | ✅ | 0.0-1.0（默认 0.95） |
| min_p | FLOAT | ✅ | 0.0-1.0（默认 0.05） |
| repetition_penalty | FLOAT | ✅ | 0.0-5.0（默认 1.05，1.0 = 无惩罚） |
| presence_penalty | FLOAT | ✅ | 0.0-5.0（默认 0.0） |
| thinking | BOOLEAN | ✅ | 模型支持时启用思考模式（默认 False） |
| use_default_template | BOOLEAN | ✅ | 使用模型内置 system prompt/模板（默认 True） |
| mtp | COMBO | ✅ | 投机解码：auto / off / 2 / 3 / 4 / 5（默认 auto）。无 MTP 权重时无效 |
| seed | INT | ✅ | 随机种子，带 control_after_generate（默认 0） |
| clip | CLIP | ❌ | 生成用 CLIP。未连接时回落 pipeline 自带 clip |

**输出:** `pipeline` (PIPELINE_DATA)

#### 图像随 Enable Edit 一起送入（多模态）

当某个 Detailer block 满足「`Enable Edit` 开着」时，会把图一并送进 Generate Text —— 文本编码器可以**看着图**改写提示词，而不再只依赖文字。

**送图规则（按顺序）：**

1. **第一张 = `pipeline.image`** —— 链上传递的那张工作图（pipeline 就是靠它在 block 间传图；interface 块会写回，detailer 块不改它）。
2. **之后追加 Ref Image** —— 该 block 选中的 `context_reference_key`，**能传几张传几张**。
3. **`Enable Edit` 关闭 → 完全不传图**（不做隐藏行为，与 Edit 语义一致）。
4. **interface 路径不传图**：interface 块没有 Enable Edit / Ref Image 概念，始终纯文本。

多图**不自己拼批次**，而是按 ComfyUI 原生约定交给编码器：`images=<list of [1,H,W,C]>`
（详见下节）。尺寸与首图不一致的后续图会被**跳过**（绝不 resize，避免改变语义）。

> ⚠️ `clip` 必须是**多模态**文本编码器（如 Gemma 3 vision、Qwen-VL）。纯文本编码器不接受图像，此时会**静默降级为纯文本**（日志出现 `images rejected ... retrying text-only`），不会中断采样链。

##### ★★ 直接对齐 ComfyUI 原生 Generate Text 的送图设计

送图这件事上，我们**不做自己的发明**，逐项对齐 ComfyUI 原生实现。关键事实（均来自本地
ComfyUI 0.37.0 源码）：

**① 原生的 `image=` 与「其他所有节点」的 `images=` 其实是同一条路。**

```python
# comfy_extras/nodes_textgen.py:49-56 —— 唯一用 image=（单数）的原生节点
@classmethod
def execute(cls, clip, prompt, max_length, sampling_mode, image=None, thinking=False,
            use_default_template=True, video=None, audio=None, mtp="auto", system_prompt=""):
    tokens = clip.tokenize(prompt, image=image, skip_template=not use_default_template,
                           min_length=1, thinking=thinking, video=video, audio=audio,
                           system_prompt=system_prompt if use_default_template else "")

# comfy/text_encoders/qwen3vl.py:162-165 —— image= 只是在内部拆成同一份 list
def tokenize_with_weights(self, text, return_word_ids=False, llama_template=None, images=[],
                          prevent_empty_text=False, thinking=False, skip_template=False,
                          system_prompt="", **kwargs):
    image = kwargs.get("image", None)
    if image is not None and len(images) == 0:
        images = [image[i:i + 1] for i in range(image.shape[0])]   # ← 就是这一行
```

而**其他所有**把图交给文本编码器的原生节点，用的都是 `images=`（list of `[1,H,W,C]`）：

| 文件 | 行 | 形态 |
|------|----|------|
| `nodes_qwen.py` | 43, 47 | `images = [image[:, :, :, :3]]` → `tokenize(prompt, images=images)` |
| `nodes_joyimage.py` | 54, 55 | `[_resize_reference(i) for i in images]` → `tokenize(prompt, images=resized_images)` |
| `nodes_minimax_h3.py` | 143–156 | `images.append(img)` → `tokenize(prompt, images=images)` |
| `nodes_boogu.py` | 66, 78 | `images_vl.append(s.movedim(1, -1)[:, :, :, :3])` → `tokenize(prompt, images=images_vl)` |

两条路在编码器里汇成**同一份** `images` list，所以**语义完全等价**；我们统一走 `images=`
（原生规范入口、兼容面更宽），只有调原生 `TextGenerate.execute` 时才用它的 `image=`
形参（把 list 拼回 `[B,H,W,C]`）。因此 `normalize_ref_images(..., single=True)` → list，
`single=False` → 批次，两形态张数一致。

**② 图像形状契约（别用错）**：`comfy/text_encoders/qwen_vl.py:process_qwen2vl_images`
要求 **BHWC**（它第一件事就是 `batch_size, height, width, channels = images.shape`
然后 `permute(0,3,1,2)`），且内部只用 `images[0]`。ComfyUI 的 IMAGE 本身就是
`[B,H,W,C]` float，所以**原样透传即可，不要 movedim、不要归一化**。

**③ `use_default_template` 是图能不能生效的总开关**（最容易误判的一种失败）：

这是最容易误判的一种失败：日志里明明打出 `images attached … → batch=[…]`，也调到了
`clip.tokenize(..., image=...)`，**但生成结果和图毫无关系**。根因在 ComfyUI 侧：

```python
# comfy_extras/nodes_textgen.py:53
tokens = clip.tokenize(prompt, image=image, skip_template=not use_default_template, ...)

# comfy/text_encoders/qwen3vl.py:167-172
skip_template = skip_template or text.startswith('<|im_start|>')
if skip_template:
    llama_text = text            # ← 直接吐原始文本：不套模板
else:
    template = self.llama_template_images      # ← 只有这条才带 <|vision_start|><|image_pad|><|vision_end|>
    ...
# 之后才按 151655（<|image_pad|>）把图塞成 {'type': 'image', 'data': …}
```

也就是说，**`use_default_template=False` ⇒ `skip_template=True` ⇒ 模板被绕过 ⇒ token 流里
一个 `<|image_pad|>` 都没有 ⇒ 图被彻底丢弃，而表面上「成功传入」**。

所以想让它生效，必须同时满足：

1. Pipeline 里 `use_default_template = True`（默认就是 True，**别关**）；
2. `clip` 是多模态编码器（Gemma 3/4 vision、Qwen3-VL 家族…）。

**自动诊断**：`_preflight_generate_text_images()`（`nodes/snapshot_sampler_node.py`）会在真正
生成之前**实测一次 `clip.tokenize`**，把 token 流里的 image embedding 数出来，三态结论：

| 结论 | 含义 |
|------|------|
| `已确认生效 — N 个 image embedding 进入 token 流（M 张图）` | 图真的会参与生成 |
| `★ 不会生效 — …`（绕过模板 / 非多模态 / 图不可用） | 传了也是白传，日志与 Debug 都会点明原因 |
| `未验证（tokenize 探针失败: …）` | 探测本身失败（fail-open，不影响采样链） |

该结论会写进 Run Debug 的 `c)` 条目（`image_status` 字段）并打到日志
（`[GenerateText] [block N] image status: …`），所以**不用再靠感觉判断**。

> **注意：`use_default_template=True` 并不保证图一定生效。** 编码器可能不是多模态、
> 或视觉模板里没有可替换的 pad 槽。所以运行时还有一道**独立的实测闸门**（见下）。

##### ★ 运行时硬闸门：图没变成 embedding 就绝不假装成功

`run_generate_text()` 在生成前会**用同一个 clip 单独跑一次 `tokenize`** 并数 image
embedding（`_tokens_contain_image_embedding`）：

- **有 embedding** → 打印 `image embedding CONFIRMED: N embedded (the image WILL affect the result)`，正常生成；
- **没有 embedding** → 打印 `★ image embedding MISSING …`，**闸掉原生路径**，并在回退路径里
  主动抛错，由降级链**丢掉图重试纯文本**（日志 `images rejected … retrying text-only`）。

也就是说「传了图但图没生效」**永远不会被当成成功**：要么图真的生效，要么明确降级为纯文本并留下日志。
这道闸门不依赖 `use_default_template` 的取值推断，只看 token 流里实际有没有 image embedding。

兼容性探测还有两个坑，都已在 `libs/generate_text_utils.py` 里处理：

1. `CLIP.tokenize` 的真实签名是 `(text, return_word_ids=False, **kwargs)` —— 多模态关键字全藏在 `**kwargs` 里。因此**不能**用「`images`/`image` 不在形参列表」判定「不支持图像」，否则真机上会永久降级、功能静默失效。判定必须认 `VAR_KEYWORD`。
2. `TextGenerate.execute` 若确实没有 `image` 形参（旧版本），则**明确抛错**触发降级，而不是把 `image` 悄悄丢掉后假装成功。

**★ 探针必须和运行时走同一条入口**：`_preflight_generate_text_images()` 曾经写成
`clip.tokenize(batch, skip_template=…, min_length=1)` —— 把**图当成 `text` 传**，于是
`images` 永远为空、token 流里永远没有 image embedding，Debug 里长期**假报「图不会生效」**，
和 `run_generate_text` 的实测结论自相矛盾。现在两处都是
`clip.tokenize(<text>, images=<list of [1,H,W,C]>, skip_template=…, min_length=1, …)`，
并且探针用了非空文本（`'x'` + `prevent_empty_text=True`）。

> ⚠️ `_tokens_contain_image_embedding` 的下探层级必须与 ComfyUI 一致：
> `tokens[key] = [batch]` → `batch = [token_entry]` → `token_entry = [(elem, weight), …]`，
> image dict 在**第三层**。只扫两层会 100% 漏判，诊断会变成「永远说图没生效」的假报警。

**Debug 可见性**：Debug Modal 里每个送图的 block 会有 `c1)` / `c2)` … 条目（`Generate Text 输入图 — pipeline.image（链上工作图）` / `… — Ref Image（<key>）`），点击放大即可看到**实际送进去的每一张图**；`c)` 条目标注送入张数，`d)` 标注意为 `images_sent`。

---

### Run Debug Trace（Draw tab 的 🐞 Debug 按钮）

Draw tab 左侧 Context 标题右侧有一个 **🐞 Debug** 按钮，打开一个 Modal，展示**上一次
Run / Generate 的全过程快照**：各阶段 prompt（含 Generate Text 前后）、每个 Block 调用
后的数据、以及中间过程图 / 遮罩。只保留最近一次 run，每次 run 开始时重置。

**收集器**：`libs/debug_trace.py`

| API | 用途 |
|-----|------|
| `begin_trace(meta)` | 开一份新 trace，丢弃上一份 |
| `record_stage(label, detail, block, **data)` | 一条文字说明 + 结构化字段 |
| `record_prompt(label, text, block, **data)` | 某一阶段的提示词（自动算 `chars`） |
| `record_image(label, tensor, ...)` / `record_mask(...)` | 过程图 / 遮罩（可传 tensor，序列化时才编码） |
| `record_block(index, label, ...)` | 一个 block 的分节标题 |
| `record_error(label, err, ...)` | 某步失败 |
| `debug_trace_snapshot()` | 序列化成 `/api/debug_trace` 的响应 |

**记录点（按执行顺序）**

1. `1. Prompt tab` — `_parse_prompt` 解析结果
2. `2. Extra Prompt 追加后` — Blend 工具栏输入的追加结果
3. `3. Run 上下文` — image/mask 尺寸、mask 统计、model 类型、architecture
4. `4. Pipeline 链` — block 列表 + preset 名 + global_params
5. 链条开头：原始输入图 / 未扩张 mask / 扩张后 mask / 裁剪+缩放后工作图与 mask
6. 每个 block：
   - `a) context 解出` / `b) context + user_positive 拼接`
   - `c) Generate Text 输入` / `c1) c2) … Generate Text 输入图` / `d) Generate Text 输出`（启用时）
     —— 每张**真正送进 Generate Text 的图**单独一条，标注来源（`pipeline.image（链上工作图）` 或 `Ref Image（<key>）`）并可点击放大
   - `e) 最终 positive`（含 negative / loras / query 追加）
   - 输入工作图与 mask、采样解码输出、复原到裁剪分辨率的图
7. `Prompt 块生效后` / `Query 块回答后`（这两类 block）
8. Interface block：输入图 / 输入 mask / 输出图 / 输出 mask
9. `收尾 / 恢复` — 三路恢复路径的选择（Enable Mask 关 / Recover Crop 开 / 关）
10. `最终产出（detailed image）` 与 `链条最终产出（recover 之后）`
11. `Run 结束`（状态）/ `run_detailer 异常`

**边界**：所有埋点 fail-open —— 任何一步炸掉只打印一行警告，绝不中断整条链。单份
trace 的过程图上限 `MAX_IMAGES_PER_TRACE = 240`，单图超过 `MAX_IMAGE_PIXELS` 会等比缩小。

> ⚠️ **扩展埋点时的硬性规则**：fail-open 只保护 `record_*` 的**内部**——传进去的**实参表达式
> 在调用之前就已经求值**，写崩了照样炸整条链。所以实参必须是无副作用的取值，尤其是形状：
>
> - **`LATENT` 是 dict，不是 tensor**。`_ksampler` 返回 `{'samples': tensor, ...}`，
>   对它取 `.shape` 会 `AttributeError`（真实翻车过一次）。取形状请走 `_latent_shape()` 这类
>   安全 helper（兼容 dict → `['samples']`、`hasattr(shape)` 兜底、内部 try/except）。
> - `libs/debug_trace.py` 的 `record_image/record_mask` 接受 tensor 或 numpy 数组；
>   维度归一和缩放都在内部完成，不要在埋点处预处理。

**前端**：`nodes/sampler_node/src/components/DebugModal.tsx`。按 block 折叠分组，支持
筛选（全部 / Prompt 链路 / 过程图 / 只看 Block），缩略图点击放大（Esc 关闭）。

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
