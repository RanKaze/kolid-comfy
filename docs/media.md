# 🎬 视频节点

[← 返回主 README](../README.md)

---

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
