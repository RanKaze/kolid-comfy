# 💾 磁盘 IO 节点

[← 返回主 README](../README.md)

---

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
