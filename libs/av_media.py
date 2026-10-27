"""PyAV 直读：探测 / 精确取帧 / 缩略条 / 波形峰图。

替代 snapshot_sampler_node 里那几处"要一次媒体信息就 spawn 一个 ffprobe、要几张缩略图就
spawn 一个 ffmpeg"的调用。PyAV 是 ffmpeg 的 C 库绑定，解码器就在进程里，省掉进程创建和
管道搬运，更重要的是**能持有解码器状态**（顺序解码落在真实帧边界上）。

为什么只换这几处、不换编码：
    `_vid_encode` / `_vid_merge` / `_vid_ingest` / 代理转码仍然走 ffmpeg CLI。那几处是
    "喂一列帧进去、要一个 mp4 出来"，ffmpeg CLI 一条命令就完事；PyAV 编码要自己开输出
    容器、建流、手工喂帧、管 pix_fmt 与偶数宽高、管时间戳，代码量翻倍而收益为负。
    **解码取数换 PyAV，编码落盘留 ffmpeg。** 这是本模块的边界，别越界。

通用约定：
    * 每个函数都自己 av.open / close，不持有跨请求状态 —— ComfyUI 的 HTTP handler 是
      多线程的，共享容器要加锁，不值当；
    * 任何一步失败都返回 None / 空列表，**调用方回退到原来的 ffmpeg 路径**；
    * 返回的字段与 `_vid_ffprobe` 严格同构，前端与 API 契约一个字不改。

踩过的坑（改这里之前先读）：
    * `container.duration` 的单位是 1/AV_TIME_BASE = **微秒**，不是秒；
    * `stream.codec_context` 对 data/tmcd/字幕流是 **None**，取 .name 会炸；
    * `AudioStream.__getattr__` 会把 `average_rate` 转发给 codec_context 再抛
      AttributeError —— rate 只能对 video 流取；
    * 认专辑封面用 `stream.disposition`，但**不能**写
      `getattr(d, 'attached_pic', False)` —— Disposition 是 Flag 枚举，那样取到的是
      常量 `Disposition.attached_pic`(1024) 本身，恒为真，会把**每一个**视频流都当
      封面跳过（vcodec/width/height/fps 全变空）。必须位测试，见 `_is_attached_pic`。
"""

import os
import threading

# 惰性 import：av 不存在（或 DLL 缺）时本模块仍可被 import，调用方自然回退 ffmpeg。
_AV = None
_AV_MISSING = object()
_AV_LOCK = threading.Lock()


def _av():
    global _AV
    if _AV is None:
        with _AV_LOCK:
            if _AV is None:
                try:
                    import av as _m
                    _AV = _m
                except Exception:
                    _AV = _AV_MISSING
    return None if _AV is _AV_MISSING else _AV


def av_ok():
    """PyAV 能不能用。调用方拿它决定走新路还是回退。"""
    return _av() is not None


AV_DISPOSITION_ATTACHED_PIC = 0x0400

# 单次 seek 后最多解多少帧就放弃（正常 GOP 远小于此）—— 时间戳异常的流别在这儿解到天荒地老。
_MAX_DECODE_PER_SEEK = 4000


def _is_attached_pic(s):
    """这条流是不是专辑封面（ffprobe 的 disposition.attached_pic）。

    Disposition 是 Flag 枚举：`getattr(d, 'attached_pic', False)` 拿到的是**常量**
    `Disposition.attached_pic`(1024) 本身 —— 恒为真，会把每条视频流都判成封面。
    必须位测试。枚举类的 import 路径各版本不一，所以优先从实例取类，取不到就按
    ffmpeg 的常量掩码比。
    """
    d = getattr(s, 'disposition', None)
    if d is None:
        return False
    try:
        return bool(d & type(d).attached_pic)
    except Exception:
        pass
    try:
        return bool(d.value & AV_DISPOSITION_ATTACHED_PIC)
    except Exception:
        return False


def _video_stream(cont, av):
    """第一个真正的视频流（跳过封面与 codec_context 为空的流）。"""
    for s in cont.streams:
        if s.type != 'video':
            continue
        cc = s.codec_context
        if cc is None:
            continue
        if _is_attached_pic(s):
            continue
        return s
    return None


def probe(path):
    """媒体信息，字段与 `_vid_ffprobe` 同构：
    {'duration','vcodec','acodec','width','height','fps'}。失败返回 None。

    fps 取 video 流的 average_rate（PyAV 已解成分数，float() 即得），与 ffprobe 的
    avg_frame_rate 同源；duration 优先容器的（更准），量不到才用视频流自己的。
    """
    av = _av()
    if av is None or not (path and os.path.isfile(path)):
        return None
    try:
        cont = av.open(path, mode='r')
    except Exception:
        return None
    try:
        vcodec = acodec = None
        width = height = 0
        fps = 0.0
        vdur = 0.0
        for s in cont.streams:
            cc = s.codec_context
            if cc is None:
                continue
            if s.type == 'video' and vcodec is None:
                if _is_attached_pic(s):
                    continue
                vcodec = cc.name or ''
                width = int(cc.width or 0)
                height = int(cc.height or 0)
                try:
                    r = s.average_rate or s.base_rate
                    fps = float(r) if r else 0.0
                except (AttributeError, TypeError, ValueError):
                    fps = 0.0
                try:
                    if s.duration and s.time_base:
                        vdur = float(s.duration) * float(s.time_base)
                except (TypeError, ValueError):
                    vdur = 0.0
            elif s.type == 'audio' and acodec is None:
                acodec = cc.name or ''

        dur = 0.0
        try:
            if cont.duration is not None:
                # 单位是微秒（1/AV_TIME_BASE）
                dur = float(cont.duration) / 1000000.0
        except (TypeError, ValueError):
            dur = 0.0
        if dur <= 0:
            dur = vdur
        return {'duration': dur, 'vcodec': vcodec, 'acodec': acodec,
                'width': width, 'height': height, 'fps': fps}
    except Exception:
        return None
    finally:
        try:
            cont.close()
        except Exception:
            pass


def _open_video(path, threads=True):
    """开容器 + 取视频流，返回 (cont, st)；失败返回 (None, None)，调用方负责 close。

    `threads`：把解码器切成多线程。这是 strip 能不能打过 ffmpeg 的关键 —— 单线程顺序
    解一条 1080p 长片要 27s，多线程 + 分段 seek 是 0.4s（ffmpeg 的 fps 滤镜要 4.2s）。
    必须在第一次 decode 之前设，设完就生效。
    """
    av = _av()
    if av is None or not (path and os.path.isfile(path)):
        return None, None
    try:
        cont = av.open(path, mode='r')
    except Exception:
        return None, None
    st = _video_stream(cont, av)
    if st is None:
        try:
            cont.close()
        except Exception:
            pass
        return None, None
    if threads:
        cc = st.codec_context
        try:
            cc.thread_count = 0          # 0 = 自动（按核数）
        except Exception:
            pass
        try:
            cc.thread_type = 'AUTO'      # 帧级 + 片级并行
        except Exception:
            pass
    return cont, st


def _to_pil(frame, width=0, height=0):
    """帧 → PIL.Image。给了宽就缩到该宽（高按源比例取偶，与 ffmpeg 的 -2 同口径）。"""
    import numpy as np
    from PIL import Image
    sw, sh = frame.width, frame.height
    ow, oh = width, height
    if ow <= 0 and oh <= 0:
        ow, oh = sw, sh
    elif ow > 0:
        oh = max(2, int(round(ow * sh / sw / 2)) * 2)
    else:
        ow = max(2, int(round(oh * sw / sh / 2)) * 2)
    kw = {}
    if (ow, oh) != (sw, sh):
        kw = {'width': ow, 'height': oh}
    f = frame.reformat(format='rgb24', **kw) if kw else frame.reformat(format='rgb24')
    return Image.fromarray(f.to_ndarray(), 'RGB')


def _grab_at(cont, st, tsec, width=0):
    """在**已打开**的容器里取 tsec 秒处正在显示的那一帧，返回 PIL.Image 或 None。

    seek 只负责跳到目标之前最近的关键帧（backward=True），选哪一帧完全由解出来的 PTS
    决定 —— PTS <= t 的最后一帧（nearest-previous），与 `_vid_frames_av` 同口径，
    CFR / VFR 都成立。
    """
    tb = float(st.time_base) if st.time_base else 0.0
    base = float(st.start_time or 0) * tb if tb > 0 else 0.0
    try:
        want = base + max(0.0, float(tsec or 0))
    except (TypeError, ValueError):
        want = base
    if tb > 0:
        try:
            cont.seek(int(max(0.0, want) / tb), stream=st, backward=True, any_frame=False)
        except Exception:
            try:
                cont.seek(0)
            except Exception:
                pass
    last = None
    cnt = 0
    for frame in cont.decode(st):
        ft = frame.time
        if ft is None:                       # 无 PTS 的罕见流：第一张就是它
            last = frame
            break
        if float(ft) > want + 1e-5:
            break
        last = frame
        cnt += 1
        if cnt > _MAX_DECODE_PER_SEEK:       # 安全阀：异常流别在这儿解到天荒地老
            break
    if last is None:
        # 目标落在起始关键帧之前（seek 过头了）：从头再解一张。
        try:
            cont.seek(0, stream=st, backward=True, any_frame=False)
        except Exception:
            pass
        for frame in cont.decode(st):
            last = frame
            break
    if last is None:
        return None
    return _to_pil(last, width=width)


def frame_at(path, t, width=0):
    """取源内 t 秒处**正在显示**的那一帧，返回 PIL.Image；失败返回 None。

    ffmpeg 的 `-ss` 是"跳转后取第一张"，越靠片尾越容易落空 —— 老代码要再用 `-sseof`
    兜一次；这里一次 seek + 按 PTS 定位就拿到确定答案。
    """
    cont, st = _open_video(path)
    if cont is None:
        return None
    try:
        return _grab_at(cont, st, float(t or 0), width=width)
    except Exception:
        return None
    finally:
        try:
            cont.close()
        except Exception:
            pass


def strip(path, n, width=0):
    """按**真实帧号**在全片上均匀取 n 帧，返回 PIL.Image 列表；失败返回 []。

    与 ffmpeg `fps=n/duration` 滤镜的差别（这就是换它的理由）：fps 滤镜是按时间重排，
    n 张不一定铺得满 —— 尾帧常被 GOP 吞掉、张数会少，老代码要靠"缺的格子复制前一格"
    把洞补上，拖动扫过空洞会闪黑。这里是按帧号取，一定正好 n 张，且落在真实帧边界上。

    实现是**逐段 seek**：每个目标帧单独 backward seek 到它前面最近的关键帧，只解到目标
    为止 —— 而不是把全片顺序解一遍。实测（1080p60 / 7053 帧 / n=16）：

        顺序解一遍 + 单线程    26.8s
        顺序解一遍 + 多线程     3.6s
        逐段 seek   + 多线程     0.4s   <-- 本实现（ffmpeg 的 fps 滤镜是 4.2s）

    差一个量级，因为顺序解码把 7000 帧全解了，而 seek 只解每个目标所在的半个 GOP。
    缩略条有落盘缓存，这个代价本来只付一次 —— 快十倍是白捡的。
    """
    try:
        n = max(2, min(160, int(n or 16)))
    except (TypeError, ValueError):
        n = 16
    cont, st = _open_video(path)
    if cont is None:
        return []
    try:
        total = 0
        try:
            total = int(getattr(st, 'frames', 0) or 0)
        except (TypeError, ValueError):
            total = 0
        try:
            rate = float(st.average_rate or st.base_rate or 0)
        except (AttributeError, TypeError, ValueError):
            rate = 0.0
        if total <= 0 or rate <= 0:
            p = probe(path) or {}
            fps = float(p.get('fps') or 0)
            if rate <= 0:
                rate = fps
            if total <= 0 and fps > 0 and float(p.get('duration') or 0) > 0:
                total = max(1, int(round(float(p['duration']) * fps)))
        if total <= 1 or rate <= 0:
            # 量不到总帧数/帧率就退回"取一帧"：宁可少给，也不猜。
            one = frame_at(path, 0.0, width=width)
            return [one] * n if one else []
        idxs = [round(i * (total - 1) / (n - 1)) for i in range(n)]
        out = []
        prev = None
        for idx in idxs:
            img = _grab_at(cont, st, idx / rate, width=width)
            if img is None:
                img = prev          # 缺的格子复制前一格：缩略条宁可重复也不能有洞
            if img is None:
                continue
            prev = img
            out.append(img)
        return out
    except Exception:
        return []
    finally:
        try:
            cont.close()
        except Exception:
            pass


def wave_peaks(path, cols, rate=8000):
    """整条音轨的峰值包络，返回长度 cols 的 float 列表（0..1）；无音轨/失败返回 []。

    替代 ffmpeg 的 `showwavespic`：那个滤镜要 spawn 一个进程并把整条音频重采样一遍，
    这里解码+重采样都在进程内。画 PNG 交给 `wave_png`。
    """
    import numpy as np
    av = _av()
    if av is None or not (path and os.path.isfile(path)):
        return []
    try:
        cols = max(16, min(4096, int(cols or 1600)))
    except (TypeError, ValueError):
        cols = 1600
    try:
        cont = av.open(path, mode='r')
    except Exception:
        return []
    try:
        st = next((s for s in cont.streams
                   if s.type == 'audio' and s.codec_context is not None), None)
        if st is None:
            return []
        resampler = av.AudioResampler(format='s16', layout='mono', rate=rate)
        chunks = []
        for frame in cont.decode(st):
            try:
                for f in resampler.resample(frame):
                    chunks.append(f.to_ndarray())
            except Exception:
                break
        try:
            for f in resampler.resample(None):
                chunks.append(f.to_ndarray())
        except Exception:
            pass
        if not chunks:
            return []
        data = np.concatenate([c.reshape(-1) for c in chunks]).astype(np.float32) / 32768.0
        if data.size < cols:
            # 音频比要画的列数还短：按列插值补齐，别返回短数组让画布留空。
            idx = np.linspace(0, max(0, data.size - 1), cols).astype(int)
            data = data[idx] if data.size else np.zeros(cols, np.float32)
        step = max(1, data.size // cols)
        peaks = np.abs(data[:cols * step].reshape(cols, step)).max(axis=1)
        return [float(v) for v in peaks]
    except Exception:
        return []
    finally:
        try:
            cont.close()
        except Exception:
            pass


def wave_png(path, out_path, width=1600, height=128, color='#30d158'):
    """把 `wave_peaks` 画成 PNG 落盘，替代 ffmpeg 的 showwavespic 滤镜。
    成功返回 True。画出来的图是给时间线当底纹的，尺寸颜色沿用原滤镜的参数。
    """
    from PIL import Image, ImageDraw
    peaks = wave_peaks(path, width)
    if not peaks:
        return False
    try:
        c = color.lstrip('#')
        rgb = tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
    except Exception:
        rgb = (0x30, 0xd1, 0x58)
    img = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    dr = ImageDraw.Draw(img)
    mid = height / 2.0
    for x, p in enumerate(peaks[:width]):
        h = max(1, int(round(min(1.0, p) * mid)))
        dr.line((x, mid - h, x, mid + h), fill=rgb + (255,))
    try:
        img.save(out_path, 'PNG')
    except Exception:
        return False
    return os.path.isfile(out_path)
