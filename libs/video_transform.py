# -*- coding: utf-8 -*-
"""
视频几何变换核心工具(VideoLimitPixel/Meet/Fit/Recover 系列节点共用):

- 源视频内容哈希:流式 MD5,按 (path, size, mtime) 二级缓存,大文件只哈希一次
- 变换结果磁盘缓存:key = md5(节点名 + 源/掩码/背景内容哈希 + 参数 + 算法版本),
  相同输入直接复用已生成文件——不产生新的视频拷贝、不重编码
- ffmpeg 滤镜执行:image 流(crf18 + 音频透传,失败降级 aac)/ mask 流(无损灰度,体积小)
- 尺寸计算算法与 Image 系列节点逐行对齐,保证 fit→recover 往返一致
"""
import hashlib
import json
import os
import subprocess
import threading
import time

import numpy as np

import folder_paths

from .video_utils import FFMPEG_PATH, get_video_metadata

# 算法版本号:任何影响输出字节的滤镜/编码变更都必须 bump,防止命中旧缓存
ALGO_VERSION = 1

CACHE_DIR = os.path.join(folder_paths.get_output_directory(), "videocache")
INDEX_FILE = os.path.join(CACHE_DIR, "index.json")
CACHE_SUBFOLDER = "videocache"   # 相对 output 目录,供预览 UI 引用

_CACHE_LOCK = threading.Lock()
_HASH_CHUNK_SIZE = 8 * 1024 * 1024

os.makedirs(CACHE_DIR, exist_ok=True)
print(f"[VideoTransform] Cache directory: {CACHE_DIR}")


# ============================================================
# 缓存索引(读写加锁,内容哈希二级缓存也存这里)
# ============================================================

def _load_index():
    """加载缓存索引 JSON;损坏时重置为空索引。"""
    if os.path.exists(INDEX_FILE):
        try:
            with open(INDEX_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict):
                data.setdefault("files", {})    # path -> {size, mtime, md5}
                data.setdefault("entries", {})  # key -> {image, mask, created}
                return data
        except Exception as e:
            print(f"[VideoTransform] Warning: failed to load cache index: {e}")
    return {"files": {}, "entries": {}}


def _save_index(index):
    try:
        with open(INDEX_FILE, 'w', encoding='utf-8') as f:
            json.dump(index, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[VideoTransform] Warning: failed to save cache index: {e}")


def video_content_hash(video_path):
    """源视频内容哈希:流式 MD5,按 (path, size, mtime) 二级缓存。

    大视频只在实际内容变化时才重新哈希一次。
    """
    video_path = os.path.abspath(video_path)
    stat = os.stat(video_path)
    size, mtime = stat.st_size, stat.st_mtime

    with _CACHE_LOCK:
        cached = _load_index()["files"].get(video_path)
        if cached and cached.get("size") == size and cached.get("mtime") == mtime:
            return cached["md5"]

    md5 = hashlib.md5()
    with open(video_path, 'rb') as f:
        for chunk in iter(lambda: f.read(_HASH_CHUNK_SIZE), b''):
            md5.update(chunk)
    digest = md5.hexdigest()

    with _CACHE_LOCK:
        index = _load_index()
        index["files"][video_path] = {"size": size, "mtime": mtime, "md5": digest}
        _save_index(index)
    return digest


def compute_transform_key(node_name, sources, params):
    """计算缓存 key。

    node_name: 节点类名
    sources:   {名字: 视频路径或 None},所有参与变换的源文件(源/掩码/背景)
    params:   全部影响输出字节的参数(含 info 字典)
    """
    source_hashes = {}
    for name, path in (sources or {}).items():
        source_hashes[name] = video_content_hash(path) if path else None
    payload = {
        "node": node_name,
        "version": ALGO_VERSION,
        "sources": source_hashes,
        "params": params,
    }
    return hashlib.md5(
        json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()


def cache_lookup(key):
    """命中且文件仍存在 → {"image": 路径, "mask": 路径或 None};未命中返回 None。"""
    with _CACHE_LOCK:
        entry = _load_index()["entries"].get(key)
    if not entry:
        return None
    image_path = os.path.join(CACHE_DIR, entry["image"]) if entry.get("image") else None
    mask_path = os.path.join(CACHE_DIR, entry["mask"]) if entry.get("mask") else None
    if not image_path or not os.path.exists(image_path):
        return None
    if entry.get("mask") and (not mask_path or not os.path.exists(mask_path)):
        return None
    return {"image": image_path, "mask": mask_path}


def cache_store(key, image_path, mask_path=None):
    with _CACHE_LOCK:
        index = _load_index()
        index["entries"][key] = {
            "image": os.path.basename(image_path),
            "mask": os.path.basename(mask_path) if mask_path else None,
            "created": time.time(),
        }
        _save_index(index)


def cache_output_paths(key):
    """未命中时,输出文件应写入的目标路径。"""
    return (
        os.path.join(CACHE_DIR, f"{key}.mp4"),
        os.path.join(CACHE_DIR, f"{key}_mask.mp4"),
    )


# ============================================================
# 内存视频源落盘
# ============================================================

def _video_ext_from_head(head):
    """按文件头猜测容器扩展名(ffmpeg 按内容探测,扩展名仅供预览引用)。"""
    if head[4:8] == b"ftyp":
        return ".mp4"
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return ".mkv"
    if head[8:12] == b"AVI ":
        return ".avi"
    if head[:4] == b"OggS":
        return ".ogv"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    return ".mp4"


def video_stream_to_file(stream):
    """把 VIDEO 的内存流(BytesIO)落盘到缓存目录,返回文件路径。

    VIDEO 来自内存实现(VideoFromComponents / VideoFromList 等)时,
    get_stream_source() 返回 BytesIO 而非路径,而 ffprobe 与 ffmpeg 变换
    都需要磁盘路径。文件名取内容 MD5 → 同一内容只写一次,使 IS_CHANGED
    与变换缓存 key 在多次执行之间保持稳定。
    """
    tmp_path = os.path.join(
        CACHE_DIR, f"_inmem_{os.getpid()}_{threading.get_ident()}.tmp")
    md5 = hashlib.md5()
    head = b""
    try:
        stream.seek(0)
        with open(tmp_path, "wb") as f:
            while True:
                chunk = stream.read(_HASH_CHUNK_SIZE)
                if not chunk:
                    break
                if len(head) < 16:
                    head = (head + chunk)[:16]
                md5.update(chunk)
                f.write(chunk)
    except BaseException:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise
    finally:
        stream.seek(0)

    path = os.path.join(
        CACHE_DIR, f"inmem_{md5.hexdigest()}{_video_ext_from_head(head)}")
    if os.path.exists(path):
        try:
            os.remove(tmp_path)
        except OSError:
            pass
    else:
        os.replace(tmp_path, path)
    return path


# ============================================================
# ffmpeg 执行
# ============================================================

def _run_ffmpeg(cmd):
    """执行 ffmpeg,失败时抛出携带 stderr 尾部的异常。

    使用 Popen + 显式管道(与 video_utils._run_ffprobe_json 同理,
    规避部分插件环境对 subprocess.run 的 monkey-patch)。
    """
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        _, stderr = proc.communicate()
    except BaseException:
        try:
            proc.kill()
        except Exception:
            pass
        raise
    if proc.returncode != 0:
        raise Exception((stderr or b'').decode('utf-8', errors='replace')[-800:])


def interpolation_flag(interpolation):
    """torch 插值名 → ffmpeg scale flags。"""
    return {
        "nearest": "neighbor",
        "bilinear": "bilinear",
        "bicubic": "bicubic",
    }.get(interpolation, "bilinear")


def transform_video_file(source_path, out_path, filters, kind):
    """对单个视频文件应用滤镜并输出到 out_path。

    kind == "image": libx264 crf18 veryfast yuv420p,音频透传(-c:a copy),
                     音频与 mp4 容器不兼容时自动降级 aac 重编码
    kind == "mask":  libx264 -qp 0 无损 + gray 灰度,丢音频——掩码大片平坦
                     区域无损压缩效率极高,体积小且边缘零损失
    """
    if kind == "image":
        base_cmd = [FFMPEG_PATH, "-y", "-noautorotate", "-i", source_path,
                    "-map", "0:v:0", "-map", "0:a?", "-vf", filters,
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                    "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
        try:
            _run_ffmpeg(base_cmd + ["-c:a", "copy", out_path])
        except Exception:
            print("[VideoTransform] audio copy failed, retrying with aac re-encode")
            _run_ffmpeg(base_cmd + ["-c:a", "aac", "-b:a", "192k", out_path])
    else:
        cmd = [FFMPEG_PATH, "-y", "-noautorotate", "-i", source_path,
               "-map", "0:v:0", "-an", "-vf", f"{filters},format=gray",
               "-c:v", "libx264", "-preset", "veryfast", "-qp", "0",
               "-pix_fmt", "gray", out_path]
        _run_ffmpeg(cmd)


def transform_recover_meet_with_background(fg_path, bg_path, out_path,
                                           region_w, region_h, region_x, region_y,
                                           orig_w, orig_h, flag):
    """RecoverMeet 带 background 的完美还原:前景缩放回内容区域后叠到背景上。

    音频取前景(主处理视频)的音轨。
    """
    filter_complex = (
        f"[0:v]scale={region_w}:{region_h}:flags={flag}[fg];"
        f"[1:v][fg]overlay={region_x}:{region_y}[v]"
    )
    base_cmd = [FFMPEG_PATH, "-y", "-noautorotate", "-i", fg_path,
                "-noautorotate", "-i", bg_path,
                "-filter_complex", filter_complex,
                "-map", "[v]", "-map", "0:a?",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    try:
        _run_ffmpeg(base_cmd + ["-c:a", "copy", out_path])
    except Exception:
        print("[VideoTransform] audio copy failed, retrying with aac re-encode")
        _run_ffmpeg(base_cmd + ["-c:a", "aac", "-b:a", "192k", out_path])


def parse_padding_color(padding_color):
    """'255, 255, 255' / '#FFFFFF' / 'FFFFFF' → ffmpeg 颜色 '0xRRGGBB'。

    解析规则与 ImageFitNode/ImageRecoverMeetNode 一致(RGB 或 Hex)。
    """
    s = str(padding_color).strip()
    if ',' in s:
        parts = [max(0, min(255, int(p))) for p in s.split(',')[:3]]
        while len(parts) < 3:
            parts.append(255)
        return "0x{:02X}{:02X}{:02X}".format(*parts)
    s = s.lstrip('#')
    if len(s) >= 6:
        return "0x" + s[:6].upper()
    raise ValueError(f"Invalid padding color: {padding_color}")


# ============================================================
# 尺寸计算(与 Image 系列节点逐行对齐)
# ============================================================

def compute_limit_pixel_dims(width, height, pixels, align):
    """与 libs/image_utils.limit_pixels 对齐:限制像素数,保持宽高比 + 网格对齐。

    返回 (new_width, new_height);与原尺寸相同表示无需变换。
    """
    current_pixels = width * height
    if abs(current_pixels - pixels) < 100:
        return width, height

    aspect_ratio = width / height if height != 0 else 1.0
    ideal_width = (pixels * aspect_ratio) ** 0.5
    ideal_height = ideal_width / aspect_ratio

    new_width = max(align, round(ideal_width / align) * align)
    new_height = max(align, round(ideal_height / align) * align)

    if current_pixels < pixels:
        # 需要放大
        while new_width * new_height > pixels + 100:
            new_width = max(align, new_width - align)
            new_height = max(align, new_height - align)
        new_width = max(64, new_width)
        new_height = max(64, new_height)
    else:
        # 需要缩小
        while new_width * new_height > pixels:
            new_width = max(align, new_width - align)
            new_height = max(align, new_height - align)
        new_width = max(16, new_width)
        new_height = max(16, new_height)

    return new_width, new_height


def compute_fit_dims(src_w, src_h, width, height):
    """与 ImageFitNode 对齐:等比缩放至完整放入画布(允许留边)。

    返回 (target_w, target_h, offset_x, offset_y)。
    max(1, ...) 防御极端宽高比下 int 截断为 0。
    """
    height_rate = height / src_h
    width_rate = width / src_w

    if height_rate < width_rate:
        # 高度撑满,宽度留边
        target_height = height
        target_width = max(1, int(src_w * height_rate))
        remain = width - target_width
        offset_x = int(remain / 2)
        offset_y = 0
    else:
        # 宽度撑满,高度留边
        target_height = max(1, int(src_h * width_rate))
        target_width = width
        remain = height - target_height
        offset_y = int(remain / 2)
        offset_x = 0

    return target_width, target_height, offset_x, offset_y


def compute_meet_dims(src_w, src_h, width, height):
    """与 ImageMeetNode 对齐:等比缩放至完全覆盖画布,居中裁剪。

    返回 (target_w, target_h, offset_x, offset_y, region_x, region_y, region_w, region_h)。
    注意:target 用 max(width/height, ...) 钳制——Image 版在 int 截断时可能
    产生比画布小的目标尺寸(torch 切片静默吞掉),ffmpeg 的 crop 会直接报错,
    这里向上钳制保证裁剪窗永远合法。
    """
    height_rate = height / src_h
    width_rate = width / src_w
    rate = max(width_rate, height_rate)

    target_width = max(width, int(src_w * rate))
    target_height = max(height, int(src_h * rate))

    offset_x = int((target_width - width) / 2)
    offset_y = int((target_height - height) / 2)

    # 换算回原图坐标系的内容区域,供 RecoverMeet 使用(与 Image 版公式一致)
    recover_rate = src_w / target_width
    region_x = int(offset_x * recover_rate)
    region_y = int(offset_y * src_h / target_height)
    region_width = int(width * recover_rate)
    region_height = int(height * src_h / target_height)

    return target_width, target_height, offset_x, offset_y, region_x, region_y, region_width, region_height


# ============================================================
# 逐帧流式处理管道(视频掩码算子节点用)
# ============================================================

def stream_transform_video(sources, out_path, out_width, out_height, out_fps, frame_fn,
                           src_formats=None, mode="mask", audio_source=None):
    """逐帧流式视频处理:多路 rawvideo 解码 → frame_fn → 编码。

    最佳内存管理:任意时刻每路视频只有 1 帧驻留内存(4K 灰度单帧约 8MB),
    全程不缓存帧序列,适合任意分辨率/时长的视频。

    sources:     [(path, width, height), ...];第 0 路为主源(定义输出帧数与 fps),
                 其余路按帧索引对齐,耗尽后以黑帧补齐
    out_fps:     输出帧率(取主源 fps)
    frame_fn:    fn(frames: list[np.ndarray uint8]) -> np.ndarray uint8
                 (out_height x out_width[, 3];各路形状由 src_formats 决定)
    src_formats: 每路解码像素格式("gray" / "rgb24"),默认全 gray;
                 gray → HxW,rgb24 → HxWx3
    mode:        "mask" 无损灰度输出(-qp 0 + gray,掩码用,默认);
                 "image" 彩色输出(crf18 + yuv420p + faststart)
    audio_source: mode="image" 时可选,从该文件取音频转 aac 一并封装
    返回处理的帧数。
    """
    decoders = []
    encoder = None
    try:
        if src_formats is None:
            src_formats = ["gray"] * len(sources)
        for (path, w, h), fmt in zip(sources, src_formats):
            decoders.append(subprocess.Popen(
                [FFMPEG_PATH, "-noautorotate", "-loglevel", "warning", "-i", path,
                 "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", fmt, "-"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE))

        if mode == "image":
            cmd = [FFMPEG_PATH, "-y", "-loglevel", "warning",
                   "-f", "rawvideo", "-pix_fmt", "rgb24",
                   "-s", f"{out_width}x{out_height}", "-framerate", f"{out_fps:.6f}", "-i", "-"]
            if audio_source:
                # 不加 -shortest:主源是 stdin 管道,ffmpeg 未知其长度,
                # 若音频略短会导致末尾视频帧被截掉
                cmd += ["-i", audio_source, "-map", "0:v:0", "-map", "1:a?",
                        "-c:a", "aac", "-b:a", "192k"]
            cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                    "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_path]
        else:
            cmd = [FFMPEG_PATH, "-y", "-loglevel", "warning",
                   "-f", "rawvideo", "-pix_fmt", "gray",
                   "-s", f"{out_width}x{out_height}", "-framerate", f"{out_fps:.6f}", "-i", "-",
                   "-c:v", "libx264", "-preset", "veryfast", "-qp", "0",
                   "-pix_fmt", "gray", out_path]
        encoder = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)

        frame_bytes = [w * h * (3 if f == "rgb24" else 1)
                       for (_, w, h), f in zip(sources, src_formats)]
        shapes = [((h, w, 3) if f == "rgb24" else (h, w))
                  for (_, w, h), f in zip(sources, src_formats)]
        count = 0
        while True:
            buf = decoders[0].stdout.read(frame_bytes[0])
            if not buf or len(buf) < frame_bytes[0]:
                break
            frames = [np.frombuffer(buf, dtype=np.uint8).reshape(shapes[0])]
            for i in range(1, len(decoders)):
                b = decoders[i].stdout.read(frame_bytes[i])
                if not b or len(b) < frame_bytes[i]:
                    # 副源耗尽:以黑帧补齐(等效于无源区域)
                    frames.append(np.zeros(shapes[i], dtype=np.uint8))
                else:
                    frames.append(np.frombuffer(b, dtype=np.uint8).reshape(shapes[i]))
            encoder.stdin.write(frame_fn(frames).tobytes())
            count += 1

        encoder.stdin.close()
        enc_err = encoder.stderr.read()
        enc_rc = encoder.wait()
        for d in decoders:
            try:
                d.stdout.close()
            except Exception:
                pass
            d.stderr.read()
            if d.wait() != 0:
                raise Exception(f"ffmpeg decoder exited with code {d.returncode}")
        if enc_rc != 0:
            raise Exception((enc_err or b'').decode('utf-8', errors='replace')[-800:])
        return count
    finally:
        # 异常退出时终止所有子进程,防止残留进程与管道死锁
        if encoder is not None and encoder.poll() is None:
            try:
                encoder.stdin.close()
            except Exception:
                pass
            encoder.kill()
        for d in decoders:
            if d.poll() is None:
                d.kill()


def decode_gray_frames(path, width, height, max_frames=4):
    """调试/测试用:解码视频前 max_frames 帧为 uint8 灰度数组列表。"""
    proc = subprocess.Popen(
        [FFMPEG_PATH, "-noautorotate", "-loglevel", "warning", "-i", path,
         "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        frames = []
        size = width * height
        while len(frames) < max_frames:
            buf = proc.stdout.read(size)
            if not buf or len(buf) < size:
                break
            frames.append(np.frombuffer(buf, dtype=np.uint8).reshape(height, width).copy())
        return frames
    finally:
        proc.stdout.close()
        proc.kill()
        proc.wait()
