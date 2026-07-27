# 📝 文本/字符串节点

[← 返回主 README](../README.md)

---

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
