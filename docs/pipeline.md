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
