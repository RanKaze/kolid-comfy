# 🖼️ 图像处理节点

[← 返回主 README](../README.md)

---

### ImageFitNode

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

### ImageRecoverFitNode

配合 ImageFitNode 使用。根据 FitInfo 将适配后的图片恢复到原始尺寸。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| image | IMAGE | ✅ | 适配后的图片 |
| fitInfo | FIT_INFO | ✅ | 来自 ImageFitNode 的 FitInfo |
| interpolation | COMBO | ✅ | 插值模式：nearest / bilinear / bicubic（默认 bilinear） |
| mask | MASK | ❌ | 可选 mask，同步恢复 |

**输出:** `Image` (IMAGE), `Mask` (MASK)

---

### ImageMeetNode

图片覆盖裁剪。将图片等比缩放到完全覆盖指定尺寸画布（允许超出），再居中裁剪成 width×height，比例不变，无填充。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| image | IMAGE | ✅ | 输入图片 |
| width | INT | ✅ | 目标画布宽度 0-2048（默认 0=不限制） |
| height | INT | ✅ | 目标画布高度 0-2048（默认 0=不限制） |
| interpolation | COMBO | ✅ | 插值模式：nearest / bilinear / bicubic（默认 bilinear） |
| mask | MASK | ❌ | 可选 mask，同步缩放和裁剪 |

**输出:** `Image` (IMAGE), `MeetInfo` (MEET_INFO), `Mask` (MASK)

---

### ImageRecoverMeetNode

配合 ImageMeetNode 使用。将处理后的 meet 图恢复到原始尺寸。

- 连接 `background`（原图）：把内容贴回原图，被裁剪的边缘保留原图内容，完美还原。
- 不连接 `background`：有损还原，被裁剪的边缘用 padding_color 填充。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| image | IMAGE | ✅ | 处理后的 meet 图 |
| meetInfo | MEET_INFO | ✅ | 来自 ImageMeetNode 的 MeetInfo |
| interpolation | COMBO | ✅ | 插值模式：nearest / bilinear / bicubic（默认 bilinear） |
| padding_color | STRING | ✅ | 有损还原时的填充颜色，支持 `R, G, B` 或 `#RRGGBB`（默认 "255, 255, 255"） |
| background | IMAGE | ❌ | 原图背景，连接则贴回原图完美还原 |
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
