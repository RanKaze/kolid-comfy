import os
import re
import json
import hashlib
import mimetypes
import threading
import queue
import http.server
import socketserver
import webbrowser
from ...libs.client_host import open_ui, is_open_with_app, set_open_with_app
import time
import base64
from urllib.parse import parse_qs, quote, unquote, urlparse
import io
import copy
import shutil
import subprocess
import numpy as np
from PIL import Image
import torch
import comfy.model_management as mm

# =============================================================================
# 导入现有模块
# =============================================================================
from ...libs.utils import AlwaysEqualProxy
from ...libs.data_paths import PACK_ROOT, data_dir, data_file, web_file
from ...libs import asset_store

try:
    from .prompt_node import SnapshotPromptServer, SnapshotPromptNode
except ImportError as e:
    print(f"[SnapshotDetailerSampler] Warning: cannot import prompt_node: {e}")
    SnapshotPromptServer = None
    SnapshotPromptNode = None

# Agent dock 窗的后端(LLM 会话编排)。requests 缺失也不许拖死整个节点 —— 只少这扇窗的路由。
try:
    from . import agent_backend
except ImportError as e:
    print(f"[SnapshotDetailerSampler] Warning: cannot import agent_backend: {e}")
    agent_backend = None

# 公共时间基准（MIDI 模式）。整个插件里"现在几点"只有一个出处，别处只准读数 —— 详见
# clock_bridge 头部的注释。DLL 缺失不算致命：那边会自动退到同语义的 QPC 替身。
try:
    from . import clock_bridge
except Exception as e:      # noqa: BLE001 —— 任何原因都不该让节点起不来
    print(f"[SnapshotDetailerSampler] Warning: cannot import clock_bridge: {e}")
    clock_bridge = None

# 原生发声引擎（MIDI 模式）。声音由 client/kolid_audio/KolidAudio.dll 直接开声卡合成，
# 不经过浏览器。DLL 缺失同样不致命：那边报 available=False，界面照常画谱、只是不出声。
try:
    from . import audio_bridge
except Exception as e:      # noqa: BLE001
    print(f"[SnapshotDetailerSampler] Warning: cannot import audio_bridge: {e}")
    audio_bridge = None

from ...libs.image_utils import limit_pixels, recover_size, crop_mask, recover_crop, tensor_to_base64, composite_layers, decode_mask_alpha, decode_decal_rgba, decode_image_dataurl, merge_mask_alpha, recover_scale_image, _geo_info_at
from ...libs.mask_utils import expand_mask
from ...libs.video_utils import get_video_metadata
from ...libs import av_media
from ...libs.caption_utils import get_tag
from nodes import KSamplerAdvanced, VAEEncode, VAEDecode
from ..pipeline.sampler_node import get_loras_from_string, ConditioningCacheStore
from ...libs.generate_text_utils import apply_generate_text_to_prompt
from ...libs import debug_trace as dbg
from ...architecture import Krea2 as arch_krea2, Flux2Klein as arch_flux2klein, QwenImage21 as arch_qwen_image21
from .pipeline_graph import (blocks_to_graph, graph_from_config, exec_plan, port_kind,
                            OP_INFO_PORT, START_ID, END_ID, switch_n, sw_exec_in,
                            sw_data_in, sw_data_out, sanitize_graph,
                            GEO_SOFT_KINDS, soft_frame_will_close,
                            switch_live_branches, switch_branch_order)
# 几何节点一律走 ComfyUI 节点类（见 comfy_nodes.py）：pipeline 侧只做编排，
# 像素处理与节点面板上跑出来的是同一份实现。
from .comfy_nodes import (crop as node_crop, recover_crop as node_recover_crop,
                          fit as node_fit, recover_fit as node_recover_fit,
                          meet as node_meet, recover_meet as node_recover_meet)
import gc
import uuid


# =============================================================================
# detailer block 之间的 seed 传递
# =============================================================================
def next_seed(prev):
    """由上一个 seed 生成下一个 seed。

    哈希而不是 +1：链里块数可能到十几，逐个加一会全挤在相邻整数上，而
    torch 的 randn 是逐位取随机数，相邻 seed 的首段噪声并不"长得开"。
    取 sha256 前 8 字节压回 ComfyUI 的 INT 上限，纯函数、跨进程可复现。
    """
    digest = hashlib.sha256(str(int(prev) & 0xFFFFFFFFFFFFFFFF).encode()).digest()
    return int.from_bytes(digest[:8], 'big') & 0xFFFFFFFFFFFFFFFF


# =============================================================================
# Debug 面板的 lora 读数
# =============================================================================
def debug_lora_entries(loras):
    """把链路里的 lora 值归一成"一条 lora 一个条目"，供 Debug 记录用。

    loras 一路是以 `<lora_path:文件:强度>` 逗号拼接的**字符串**在跑（_parse_prompt /
    _resolve_prompt_* 的返回值都是这种形态），早期 Debug 直接写 list(user_loras) 等于把字符串
    拆成单字符，面板上就成了 '<, l, o, r, a, _, p, a, t, h, :' 的花汤。context 那条路径本来就
    是 list，所以两种入口都从这里走，显示口径只有这一个。
    """
    if isinstance(loras, str):
        return get_loras_from_string(loras)
    return list(loras or [])


# =============================================================================
# 链上的几何帧（Crop / Meet / Fit 压帧，Recover 块弹帧）
# =============================================================================
# 一条链里几何步骤天生是**嵌套**的：Crop 把坐标系缩到一块，Recover Crop 才把它还回去。
# 中间再插一个 Meet，就必须先还 Meet 才能还 Crop —— 跨种类恢复会用错坐标系，产出静默
# 变形（看着只是"缩放怪怪的"），所以这里把「只能弹栈顶、且种类要对上」写成唯一判据。
GEO_RECOVER_LABEL = {
    'crop': 'Recover Crop',
    'meet': 'Recover Meet',
    'fit': 'Recover Fit',
    'scale': 'Recover Scale',
    'limit': 'Recover Limit',
}

# 「软帧」：Scale / Limit 只改分辨率 —— 不裁、不补边、不挪坐标。它们的帧压上栈是为了让
# 显式的 Recover Scale / Recover Limit 能**完美还原**（吃那一步之前的图当背景），但如果
# 没恢复也不会让产出落错位置（链尾的 recover_size 会把它带回原始落点）。所以：
#   ① 链尾不算漏（否则所有带 Scale 块的老链都要补一颗 Recover Scale）；
#   ② 上方的 Crop/Meet/Fit 要恢复时，先把软帧自动收掉（还原无歧义，不该逼用户补块）。
# 反过来 Crop/Meet/Fit 是**硬帧**：没恢复就是坐标系统错位，链尾必须报错。
# 软帧/硬帧的种类表与「后面那颗 Recover 会不会还掉这一层」的判据都在 pipeline_graph
# （纯 python，可单测）：GEO_SOFT_KINDS / GEO_KINDS / soft_frame_will_close。


def _geo_kind_label(kind):
    return str(kind or '').replace('_', ' ').title() or 'nothing'


def geo_pop_frame(geo_open, kind, block_no):
    """弹栈顶那一帧；栈顶不是同类 = 报错（并把帧放回去，栈保持原样）。"""
    frame = geo_open.pop() if geo_open else None
    if frame is not None and frame.get('kind') == kind:
        return frame
    if frame is not None:
        geo_open.append(frame)
    raise RuntimeError(
        f"{GEO_RECOVER_LABEL.get(kind, _geo_kind_label(kind))} block (block {block_no}) found "
        f"{_geo_kind_label(frame.get('kind')) if frame else 'nothing'} still open above it — "
        f"close that one first (a Recover block only restores the step directly above it).")


def geo_leftover_error(geo_open):
    """链尾还开着**硬**几何帧 = 漏了 Recover 块。返回要抛的错（None = 干净收尾）。

    **不自动兜底**：链尾那两步隐式恢复只认链首那次 crop，拿内层裁剪的结果去贴外层，
    产出会静默变形 —— 报错比"看起来对了一点"好查得多。
    软帧（Scale / Limit）不算漏：它们的帧只是"还能不能完美还原"的凭据，不收也不落错位置。
    """
    hard = [f for f in geo_open if f.get('kind') not in GEO_SOFT_KINDS]
    if not hard:
        return None
    left = ', '.join(f"{_geo_kind_label(f.get('kind'))} (block {f.get('block')})" for f in hard)
    need = ' → '.join(GEO_RECOVER_LABEL.get(f.get('kind'), 'Recover') for f in reversed(hard))
    return RuntimeError(
        f'The chain ends with geometry still open: {left}. Add the matching recover block after '
        f'each one ({need}) — otherwise the result keeps that step\'s coordinate system and '
        f'cannot be placed back on the canvas.')


# =============================================================================
# Detailer 产出回贴几何（Recover Crop 关闭时）
# =============================================================================
def detail_place_rect(crop_info, patch=None):
    """crop_info + 产出图 → Blend 画布把它贴回原位所需的全部几何。

    坐标链（每一步都在压缩这幅图，贴回去就是原路反演）：

        original_image (ow x oh)                 ← Blend 画布，run 时的 context
          └ crop_mask  → cropped image (cw x ch)，左上角落在 (crop_x, crop_y)
              └ limit_pixels → patch (pw x ph)   ← 模型真正跑的工作分辨率，sx/sy 是这一步的缩放比

    注意 limit_pixels 是**会放大**的（当前像素数小于目标时按 aspect 放大并对齐 align），
    所以 pw x ph 通常既不等于 cw x ch，也不是同一边长比例：pw/ph 只能近似 cx 的比例。
    唯一的硬约束是「整张 patch 必须盖满 crop 矩形的 cw x ch」——这正是开着 Recover Crop
    时 recover_size + recover_crop 的结果（recover_size 先把 patch 拉回 cw x ch，再由
    recover_crop 贴到 [crop_y:, crop_x:]），两条路径必须在画布上得到同一个矩形。

    于是这里给出的不是一个画好的 transform，而是让前端自己算的原始量：crop 矩形用
    **这次 run 的原始图像素**表示（ow/oh 同单位），外加 patch 自身尺寸与缩放比便于核对。
    纯算术、不依赖 torch，方便单测。
    """
    # crop_info 在 batch 下是**逐帧 list**（各帧 bbox 不同）；这里是给前端算单张 patch 的
    # 贴回矩形（视频模式不靠它贴 —— 产物直接编码成视频），取第 0 帧那一份即可。
    info = _geo_info_at(crop_info, 0) if crop_info else {}
    ow = int(info.get('original_width') or 0)
    oh = int(info.get('original_height') or 0)
    if ow <= 0 or oh <= 0:
        return None
    x = int(info.get('crop_x') or 0)
    y = int(info.get('crop_y') or 0)
    # 缺 crop_width/height 时退回整图（对齐 crop_mask 的空 mask 分支语义）
    w = int(info.get('crop_width') or ow)
    h = int(info.get('crop_height') or oh)
    # 夹回原图范围：crop_mask 正常不会越界，但越界会把 patch 贴到画布外
    x = max(0, min(x, ow - 1))
    y = max(0, min(y, oh - 1))
    w = max(1, min(w, ow - x))
    h = max(1, min(h, oh - y))

    pw, ph = 0, 0
    if patch is not None and hasattr(patch, 'shape') and len(patch.shape) >= 3:
        ph = int(patch.shape[-3])
        pw = int(patch.shape[-2])

    return {
        'x': x, 'y': y, 'w': w, 'h': h,     # crop 矩形，单位 = 本次 run 的原始图像素
        'ow': ow, 'oh': oh,                 # 同一幅原始图的尺寸（= run 时的画布尺寸）
        'pw': pw, 'ph': ph,                 # 返回的 patch 自身像素尺寸
        'sx': (pw / w) if w else 0.0,       # limit_pixels 施加的缩放比，供前端核对
        'sy': (ph / h) if h else 0.0,
    }


# =============================================================================
# Extra Prompt 里的嵌图标记（<image_id:...>）解析
# =============================================================================
# Blend 工作台的工作区条目点击后会把 <image_id:staging_N> 嵌进 Extra Prompt 文本
# （光标处）。Run 时在这里统一解析：引用图按**首次出现顺序**去重编号 —— context
# 工作图恒为 <image 1>，引用图依次为 <image 2>、<image 3>……（重复引用同一张复用
# 同一号）。解码后的文本（标记重写成 <image N>）才会被追加进 positive；解不出的
# id（图已从工作区移除）跳过并从解码文本中移除该标记，留下警告。
IMAGE_ID_TOKEN_RE = re.compile(r'<image_id:([^<>\s]+)>')
# 保留 id：Context Image（工作区最左侧那张固定卡片）。它不指向任何 staging 条目，
# 而是在解码时直接展开成 <image 1> —— context 图在 Enable Edit 下恒为 image 1。
CONTEXT_IMAGE_ID = 'context'

# 保留 id：Guidance 卡（Blend 工作台 Guidances 栈的那一张总卡）。与 context 不同，它就是一条
# 货真价实的 staging 条目 —— 能删、能被 <image_id:staging_guidance> 引用、能被 run 当参考图，
# 只是全工作区固定只有这一张，重发布时由 /api/guidance_card 原地换像素。
GUIDANCE_STAGING_ID = 'staging_guidance'

# Prompt 正文里**用户手写**的引用编号（<Image2> / <image 2>）：<image 1> 恒为 context 图，
# 2 起对应 Extra Prompt 里解析出的引用图（见 parse_prompt_image_refs）。Enable Edit 下若
# 某个编号还没有对应的 ref image，Run 前会弹窗让用户从工作区补一张。
# 只认裸编号 —— '<image_id:staging_2>' 里 'image' 后面是 '_'，不会误匹配。
IMAGE_REF_TOKEN_RE = re.compile(r'<\s*image\s*(\d+)\s*>', re.IGNORECASE)


def max_prompt_image_ref(text):
    """Prompt 正文里出现的最大引用编号（没有就是 0）。

    只认 <image N> 这种裸编号；<image_id:...> 不匹配（'image' 后面是 '_'）。
    <image 1> 是 context 图、不占 ref 编号，所以调用方从 2 起算。
    """
    mx = 0
    for m in IMAGE_REF_TOKEN_RE.finditer(text or ''):
        try:
            n = int(m.group(1))
        except (TypeError, ValueError):
            continue
        if n > mx:
            mx = n
    return mx


def image_bytes_to_tensor(img_bytes):
    """图片字节 → [1, H, W, 3|4] float tensor（dataURL 与仓库正身共用的解码方向）。

    带 alpha 的图保留 4 通道（QwenImage21 这类 alpha 架构需要），其余统一转 RGB。
    解不出图就抛异常，让调用方按各自语义决定是跳过这张还是整单失败。
    """
    img = Image.open(io.BytesIO(img_bytes))
    if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
        img = img.convert('RGBA')
    elif img.mode != 'RGB':
        img = img.convert('RGB')
    arr = np.array(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def dataurl_to_tensor(image_b64):
    """dataURL → [1, H, W, 3|4] float tensor（工作区入库用的那一个方向）。"""
    b64_data = image_b64.split(',', 1)[1] if ',' in image_b64 else image_b64
    return image_bytes_to_tensor(base64.b64decode(b64_data))


# ---- Pose 估计的把手（模型与推理都不在本包里）----
# 一条 2D 关键点通路：图 → DWPose → POSE_KEYPOINT 字典**原样**回前端，那边把 18 点映射成人形
# 骨头角（nodes/web/js/pose_openpose.js，照参考 vnccs_openpose_import.js 的解析路）。认 runtime 里
# 已装好的 comfyui_controlnet_aux：走 onnx 那一对（yolox_l 检框 + dw-ll_ucoco 解 133 点，它的前 18
# 点换位后就是 COCO-18/OpenPose 序，controlnet_aux 的 custom_hf_download 先查自己 ckpts 再谈下载）。
# 装不上 = 抛给调用方发 error 回执；装上过就复用同一份权重（DwposeDetector 内部还有全局缓存）。
_POSE_ESTIMATOR = None
_POSE_ESTIMATOR_LOCK = threading.Lock()

# 界面探针的"拉一下"标志。页面每三秒来问一次，want 比 done 新就抓一份送上来 ——
# 于是"看一眼现场"由发起的这一端决定，不必让页面上的人按键。只存在内存里：这是
# 一次请求，不是状态，落成文件会留下"上次没人消费"的残渣，让下一次心跳莫名抓一份。
_UI_PROBE_PULL = {'want': 0.0, 'done': 0.0}

# 界面探针的**实时通道**（与 temporary/ui_probe_sink.py 同一套语义）：页面长轮询 `/cmd` 取一条
# 表达式，就地求值后 `POST /res` 回传；这一端 `POST /eval` 就同步拿到活页面里的值。
# 之所以要它：快照与重放只能回答"这份拷贝里是否也有"，而排查 UI 要的是"读我现在眼前这个状态"。
_UI_PROBE_INBOX = queue.Queue()
_UI_PROBE_CV = threading.Condition()
_UI_PROBE_RES = {}
_UI_PROBE_SESS = {}


def pose_estimator():
    global _POSE_ESTIMATOR
    if _POSE_ESTIMATOR is not None:
        return _POSE_ESTIMATOR
    from custom_controlnet_aux.dwpose import DwposeDetector
    _POSE_ESTIMATOR = DwposeDetector.from_pretrained(
        "hr16/UnJIT-DWPose", "yzd-v/DWPose",
        det_filename="yolox_l.onnx", pose_filename="dw-ll_ucoco.onnx",
        torchscript_device="cpu")
    return _POSE_ESTIMATOR


def pose_estimate(image_tensor):
    """[1,H,W,3|4] float(0-1) → POSE_KEYPOINT 字典。

    DWPose 吃 comfy 的 RGB uint8；alpha 不参与 —— 抠过底的图层就是它自己的颜色。
    锁一把是因为 ort session 的 run 不赌它可重入（ThreadedHTTPServer 会并发进来）。
    """
    t = image_tensor[0] if image_tensor.dim() == 4 else image_tensor
    rgb = (t[..., :3].clamp(0, 1) * 255 + 0.5).to(torch.uint8).cpu().numpy()
    estimator = pose_estimator()
    with _POSE_ESTIMATOR_LOCK:
        _, pose_json = estimator(rgb, include_body=True, include_hand=False,
                                 include_face=False, output_type='np', image_and_json=True)
    return pose_json


def staging_image_to_mask(img):
    """[1,H,W,C] 工作区图 → [1,H,W] float mask（取亮度）。

    Processor 的 MASK 端口覆盖走的就是 staging 运输（图都是 PNG dataURL），落到
    端口上时按这个方向转。带 alpha 的图亮度用 RGB 均值 —— mask 语义里 alpha 不参与
    （透明处的颜色依然算数），与工作台「把图当 mask 读」的读法一致。
    """
    if img is None or not hasattr(img, 'shape'):
        return None
    if img.dim() == 4:
        return img[..., :3].mean(dim=-1)
    if img.dim() == 3:
        if img.shape[-1] in (3, 4):
            return img[..., :3].mean(dim=-1).unsqueeze(0)
        return img
    if img.dim() == 2:
        return img.unsqueeze(0)
    return None


def cud_composite_bytes(path):
    """读一份 .cud 的**合成图**字节（PNG/JPEG），取不到返回 None。

    .cud v5 的排布：`CUD1` + 4 字节头长（小端）+ JSON 头 + 一串按 assets 顺序首尾相接的
    字节。头里的 `composite` 指名哪一枚 asset 是"整幅合成"，每一枚自带 `length` ——
    偏移量就是排在它前面那些 length 的和。生成器要的首/末帧正是这一幅：用户眼里"这份工程
    现在的画面"，而不是某一层的原始像素。
    """
    try:
        if not path or not str(path).lower().endswith('.cud'):
            return None
        with open(path, 'rb') as f:
            blob = f.read()
        if len(blob) < 12 or blob[:4] != b'CUD1':
            print(f'[CudFrame] not a .cud (bad magic): {path}')
            return None
        import struct
        hlen = struct.unpack('<I', blob[4:8])[0]
        head = json.loads(blob[8:8 + hlen].decode('utf-8'))
        assets = head.get('assets') or []
        if not assets:
            print(f'[CudFrame] no assets in {path}')
            return None
        # 合成那一枚：头里指了就用指的那枚，没指就用第一枚合成图（role == 'composite'）。
        want = head.get('composite')
        pick = None
        if isinstance(want, int):
            pick = next((a for a in assets if a.get('id') == want), None)
        if pick is None:
            pick = next((a for a in assets if a.get('role') == 'composite'), None)
        if pick is None:
            pick = assets[0]
        off = 8 + hlen
        for a in assets:
            if a is pick:
                break
            off += int(a.get('length') or 0)
        n = int(pick.get('length') or 0)
        if n <= 0 or off + n > len(blob):
            print(f'[CudFrame] truncated payload in {path}')
            return None
        return blob[off:off + n]
    except Exception as e:
        print(f'[CudFrame] cannot read {path}: {type(e).__name__}: {e}')
        return None


def cud_asset_bytes(path, asset_id):
    """取 .cud 里第 `asset_id` 枚资源的**原始字节**（P2：RenderPlan 的资源解析）。

    与 cud_composite_bytes 同一套排布：`CUD1` + 4 字节头长 + JSON 头 + 按 assets 顺序首尾相接。
    `asset_id` 是头里 `assets[].id`（老档里图层用它、attributes 的 surface 也用它）。
    """
    try:
        if not path or not str(path).lower().endswith('.cud'):
            return None
        with open(path, 'rb') as f:
            blob = f.read()
        if len(blob) < 12 or blob[:4] != b'CUD1':
            return None
        import struct
        hlen = struct.unpack('<I', blob[4:8])[0]
        head = json.loads(blob[8:8 + hlen].decode('utf-8'))
        off = 8 + hlen
        for a in head.get('assets') or []:
            n = int(a.get('length') or 0)
            if a.get('id') == asset_id:
                if n <= 0 or off + n > len(blob):
                    return None
                return blob[off:off + n]
            off += n
        return None
    except Exception as e:
        print(f'[CudAsset] cannot read {path}#{asset_id}: {type(e).__name__}: {e}')
        return None


def cud_thumb_path(path, w=96):
    """一份 .cud 合成图的**缩略图**落盘路径（按需生成，取不到返回 None）。

    缓存落在资产仓库的 .thumbs/ 里（cud_ 前缀 + 路径哈希 + mtime —— 工程一存盘 mtime 变，
    键就换，旧图自然失效），画质规则照抄 asset_store.thumb_path：透明压到 #141416 上，
    深色界面不白底发光。
    """
    try:
        w = max(32, min(1024, int(w)))
    except (TypeError, ValueError):
        w = 96
    try:
        abspath = os.path.abspath(path)
        mt = os.path.getmtime(abspath)
    except OSError:
        return None
    d = os.path.join(asset_store.asset_dir(), asset_store.THUMB_DIR)
    os.makedirs(d, exist_ok=True)
    key = hashlib.md5(abspath.lower().encode('utf-8')).hexdigest()[:16]
    tp = os.path.join(d, 'cud_%s_%d_%d.jpg' % (key, int(mt), w))
    if os.path.exists(tp):
        return tp
    raw = cud_composite_bytes(abspath)
    if not raw:
        return None
    try:
        from PIL import Image
        with Image.open(io.BytesIO(raw)) as im:
            if im.mode in ('RGBA', 'LA', 'P'):
                rgba = im.convert('RGBA')
                bg = Image.new('RGB', rgba.size, (20, 20, 22))
                bg.paste(rgba, mask=rgba.split()[-1])
                im = bg
            else:
                im = im.convert('RGB')
            im.thumbnail((w, w), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, 'JPEG', quality=82, optimize=True)
        asset_store._atomic_write(tp, buf.getvalue())
        return tp
    except Exception as e:
        print(f'[CudFrame] thumb failed for {path}: {type(e).__name__}: {e}')
        return None


def processor_input_tensor(key, server):
    """Processor 的 image_keys 一项 → [1,H,W,C] tensor（取不到返回 None）。

    `asset:<哈希>` 是 Assets 来源：仓库里那份字节就是正身，按内容地址直接读 —— 不经过
    图池，也就不存在"同一张图再塞一份"和指错条目。
    `cud:<路径>` 是 .cud 工程来源（video generator 的首/末帧）：后端自己读那份工程的
    **合成图**当这一帧 —— 工程不用先打开，字节也不必绕一圈浏览器。
    其余（数字 staging id）仍走内存里的 tensor 引用：画布派生的输入是在途数据，不属于仓库。
    """
    s = str(key or '')
    if s.startswith('asset:'):
        path = asset_store.path_of(s[len('asset:'):])
        if not path:
            print(f'[InterfaceExec] asset input {s}: no bytes in the store')
            return None
        try:
            with open(path, 'rb') as f:
                return image_bytes_to_tensor(f.read())
        except Exception as e:
            print(f'[InterfaceExec] asset input {s}: {e}')
            return None
    if s.startswith('cud:'):
        raw = cud_composite_bytes(s[len('cud:'):])
        if not raw:
            print(f'[InterfaceExec] cud input {s}: no composite image')
            return None
        try:
            return image_bytes_to_tensor(raw)
        except Exception as e:
            print(f'[InterfaceExec] cud input {s}: {e}')
            return None
    return server.get_staging_image(s)


def mask_as_image(mask):
    """mask → 3 通道黑白图：`[1,H,W]`（兼容 `[H,W]` / `[B,H,W,1]`）→ `[B,H,W,3]`。

    两处用它：
      · staging 写回蒙版（接口的 MASK 产出没有直接过线的通道，staging 只运图）；
      · 图里把 mask 接到 **image 端口**上（见 pipeline_graph.ports_compatible）——
        那份 mask 在此按亮度铺成灰度 RGB，之后就是一张普通的图。
    """
    m = mask
    if m is None or not hasattr(m, 'shape'):
        return None
    while m.dim() > 2 and m.shape[-1] == 1:
        m = m[..., 0]
    if m.dim() == 2:
        m = m.unsqueeze(0)
    if m.dim() != 3:
        return None
    return m.unsqueeze(-1).expand(-1, -1, -1, 3).clamp(0.0, 1.0).contiguous()


# staging 那条路的旧名字（语义相同，保留是因为它是"给 staging 用"的那份说明）。
staging_mask_to_image = mask_as_image


def parse_prompt_image_refs(text, resolve):
    """解析 text 里的 <image_id:xxx> 标记。

    resolve(id) → bool：该 id 是否能解出一张图（由调用方提供，通常包着
    server.get_staging_image）。纯字符串处理、不依赖 torch，方便单测。

    返回 (ref_ids, decoded_text, missing)：
      ref_ids      引用图 id 列表（首次出现顺序、去重；'context' 不在其中）
      decoded_text 标记重写成 <image N>（N 从 2 起）后的文本；失效标记被移除
      missing      解不出的 id 列表（按出现顺序，不去重）
    """
    ref_ids = []
    index_by_id = {}
    missing = []

    def _sub(m):
        mid = m.group(1)
        if mid == CONTEXT_IMAGE_ID:
            # context 图恒为 <image 1>（Enable Edit 下它本来就是第一张参考图），
            # 插不插进文本都在 refs 里 —— 所以这里只解码，**不占引用编号**。
            return '<image 1>'
        if not resolve(mid):
            missing.append(mid)
            return ''          # 失效引用：从解码文本中移除
        if mid not in index_by_id:
            index_by_id[mid] = len(ref_ids) + 2   # <image 1> 留给 context 图
            ref_ids.append(mid)
        return '<image %d>' % index_by_id[mid]

    decoded = IMAGE_ID_TOKEN_RE.sub(_sub, text or '')
    return ref_ids, decoded, missing


# =============================================================================
# 文档 IO：原生文件对话框 + 令牌登记表
# =============================================================================
# Blend 工作台的 Load / Save / Save As / Export / Import 全部走这里选文件。
#
# 为什么在后端弹：页面原先用 File System Access 的 showSaveFilePicker，浏览器会在每次 Ctrl+S
# 前插一条自己的"将所作更改保存至…"提示，用户要求把它绕开。本服务器和浏览器在同一台机器上
# （browser_url 是 localhost，节点用 webbrowser.open 打开页面），所以 tkinter 的原生对话框出现
# 在同一块桌面上，而**已绑定文档的回写一个弹窗都不需要**。
#
# 为什么只认 token 不认路径：MainHandler 对任意 Origin 应答（CORS *）。若读写端点接受前端传来
# 的路径，/api/io_read 立刻就是一个任意文件读取口。对话框返回路径 → 服务端存进登记表 → 前端拿
# 到不透明 token，之后所有读写只能用 token，路径从不出服务端。
#
# 为什么单独一个常驻线程：Tk 不是线程安全的，而 HTTP handler 每个请求一个线程。所有对话框排进
# 一条队列，由唯一那根线程上唯一的 root 执行；对话框本身是原生模态的，只挡住那根线程。
#
# "最近一份 .cud"记在 data/sampler/recent_cud.json，只在上面那条原生对话框的路上写（那是后端唯一拿得到
# 真实路径的一趟；浏览器 handle 与 <input type=file> 都没有路径可记）。读回来时同样由服务端自己
# mint token，页面从头到尾无从指定路径 —— 这条记录的用途是"重开你自己上次挑过的那份文件"，
# 不是第二个文件读取口。
IO_FILE_KINDS = {
    'cud': {
        'label': 'Context document',
        'patterns': ['*.cud'],
        'extension': '.cud',
        'mime': 'application/octet-stream',
    },
    'png': {
        'label': 'PNG image',
        'patterns': ['*.png'],
        'extension': '.png',
        'mime': 'image/png',
    },
    'image': {
        'label': 'Image',
        'patterns': ['*.png', '*.jpg', '*.jpeg', '*.webp', '*.gif', '*.bmp',
                     '*.tif', '*.tiff', '*.avif', '*.svg', '*.psd'],
        'extension': '.png',
        'mime': 'image/*',
    },
    # MIDI 的乐器库是一条**目录**，不是一份文件 —— 所以它不进 token 表（没有字节可读），
    # 只把选中的路径原样回给调用方。folder=True 是这一类的唯一标记。
    'folder': {
        'label': 'Folder',
        'patterns': [],
        'extension': '',
        'mime': '',
        'folder': True,
    },
}

# Video Generator 的固定槽（与前端 types.ts 的 VIDEO_GEN_SLOTS 逐条同名）：
# 一个开了 Video Generator 的 interface 被声明成一台视频生成器 —— 这些槽各绑一个真实端口，
# 时间线上的 generator 段照这份绑定填参数、接产物。
# `reference`（参考视频）是**可选**的第 9 个槽，只在配置里 video_ref 开着时才允许存在：
# 它是一个 IMAGE 口，段上选一条时间线视频轨，跑的时候把那条轨在段的时间窗内采样成一列图喂进来。
VIDEO_GEN_SLOTS = ('prompt', 'width', 'height', 'duration', 'fps',
                   'first_frame', 'last_frame', 'reference', 'video')

# 工作台自己那三份用户内容（blocks 链与 DEFAULT SETTING、Prompt 预设、最近一份 .cud 的路径）
# 住 data/sampler/，与 data/prompt、data/switch 同级，整目录进 .gitignore。以前它们躺在 nodes/
# 里、其中两份还归了 git —— 那是每台机器各写各的运行状态，不是包的代码。
def _workbench_file(name):
    """data/sampler/<name>（落点由 libs/data_paths 定）；nodes/ 里那份旧文件首次访问时搬进来。"""
    target = data_file('sampler', name)
    legacy = os.path.join(os.path.dirname(os.path.abspath(__file__)), name)
    # 搬家那刻 ComfyUI 可能还带着旧代码在跑，它下一次写就写回 legacy —— 所以比 mtime，
    # 而不是"target 有了就不管 legacy"，否则那之后的改动会静默丢在旧位置。
    if os.path.exists(legacy) and (not os.path.exists(target)
                                   or os.path.getmtime(legacy) > os.path.getmtime(target)):
        shutil.move(legacy, target)
    return target


# 布局档案（Layout 那一格）：用户存下来的几种**摆法**，外加一份「默认」。
#
# 它落盘，不能只活在浏览器的 localStorage 里：这个页面的宿主是
# `http://127.0.0.1:<8700..8799>/sampler_node.html`，端口是 `start_servers` 一个一个试出来的
# （8700 被占就 8701，以此类推）。换一个端口就是换一个 origin，浏览器里那份存档当场看不见 ——
# 用户看到的就是"我存的布局下次打开就没了"。盘上的文件跟端口无关，端口怎么变都是同一份。
_LAYOUTS_LOCK = threading.Lock()
_LAYOUTS_MAX = 40


def _layouts_read():
    """读档案。形状不认识就当成空的 —— 一份坏档案不该让页面打不开。

    档案里有三样东西，别混：
      · `items`   —— 用户起名字存下来的槽位（Layout 那一格的清单）；
      · `default` —— ★：**一片空白的页面**从哪一份起手（没有"上一次"时的备份答案）；
      · `current` —— 用户**此刻**的摆法。页面每次动一下布局就写回这里（实时、去抖），
                     下一次打开就原样还给他。它不是一个槽位 —— 不进清单、不占 40 份的限额，
                     也不会因为被别的存档挤掉而消失。
    """
    empty = {'v': 1, 'default': None, 'items': [], 'current': None}
    try:
        with open(_workbench_file('dock_layouts.json'), 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception:
        return empty
    items = []
    if isinstance(data, dict):
        for it in (data.get('items') or []):
            # 一份档案要能装回去，至少得有名字和一棵树；其余的字段（时间戳）缺了也不碍事。
            if not isinstance(it, dict) or not isinstance(it.get('name'), str):
                continue
            dock = it.get('dock')
            if not isinstance(dock, dict) or not isinstance(dock.get('tree'), dict):
                continue
            at = it.get('at')
            items.append({'name': it['name'][:64],
                          'at': at if isinstance(at, (int, float)) else 0,
                          'dock': dock})
    names = [i['name'] for i in items]
    default = data.get('default') if isinstance(data, dict) else None
    if not isinstance(default, str) or default not in names:
        default = None
    # 「此刻的摆法」：只有一棵树是必须的，时间戳缺了就记 0。
    current = None
    cur = data.get('current') if isinstance(data, dict) else None
    if isinstance(cur, dict):
        dock = cur.get('dock')
        if isinstance(dock, dict) and isinstance(dock.get('tree'), dict):
            at = cur.get('at')
            current = {'at': at if isinstance(at, (int, float)) else 0, 'dock': dock}
    return {'v': 1, 'default': default, 'items': items, 'current': current}


def _layouts_write(store):
    """先写临时文件再换名：写到一半断电/被杀，磁盘上还是上一份完整的档案。"""
    path = _workbench_file('dock_layouts.json')
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(store, f, ensure_ascii=False)
    os.replace(tmp, path)


def _layouts_apply(action, name, dock=None):
    """改档案：save / delete / default / current。返回 (store, error)，error 是 (http_code, message) 或 None。

    逻辑放在这里而不是路由里，是为了能在 ComfyUI 之外单测这一套（路由只剩下读 body / 回 JSON）。
    `current`（页面此刻的摆法）在这四条路上都**原样留着** —— 存一份取名的布局、删一份、
    换一颗 ★，都不该把用户当前摆在屏幕上的那个样子动一下。
    """
    name = (name or '')[:64]
    with _LAYOUTS_LOCK:
        store = _layouts_read()
        items = store['items']
        default = store['default']
        current = store['current']
        if action == 'save':
            if not name:
                return None, (400, 'name required')
            if not isinstance(dock, dict) or not isinstance(dock.get('tree'), dict):
                return None, (400, 'dock must hold a tree')
            entry = {'name': name, 'at': time.time() * 1000, 'dock': dock}
            # 同名 = 同一个槽位更新（不是多一份）；最近存的排最前，超过上限把最老的挤掉。
            items = [entry] + [i for i in items if i['name'] != name]
            items = items[:_LAYOUTS_MAX]
            if default and default not in [i['name'] for i in items]:
                default = None
        elif action == 'current':
            # 页面自己每隔一会儿就把屏幕上的摆法写回来一次。**只认一棵树**，形状不对就当没听见
            # （一次坏包不该把用户上一份好布局顶掉）。
            if not isinstance(dock, dict) or not isinstance(dock.get('tree'), dict):
                return None, (400, 'dock must hold a tree')
            current = {'at': time.time() * 1000, 'dock': dock}
        elif action == 'delete':
            items = [i for i in items if i['name'] != name]
            if default == name:
                default = None
        elif action == 'default':
            if name and name not in [i['name'] for i in items]:
                return None, (404, 'no such layout')
            default = name or None
        else:
            return None, (400, 'unknown action %r' % action)
        store = {'v': 1, 'default': default, 'items': items, 'current': current}
        _layouts_write(store)
    return store, None


# =============================================================================
# MIDI：乐器库（一条本机路径）与它下面的东西
# =============================================================================
# Assets 窗的 Instruments 那一档**自己不存东西** —— 每次照用户填的那条路径现扫。所以这一节只有
# 两件事：记住那条路径（data/sampler/midi.json，和 dock 布局同一个抽屉），按它列出乐器。
#
# 路径为什么在后端而不是 localStorage：它是"这台机器的音源在哪儿"，与浏览器、与哪份文档都无关；
# 而扫描只能在后端做（页面拿不到目录）。真源只有这一份，页面读回来只是回显。
_MIDI_LOCK = threading.Lock()
# 扫描的护栏。音源库动辄几万个文件，而这一档是给人**看和挑**的，不是索引器 —— 超了如实报截断，
# 不偷偷截断。深度上限挡的是"选了整个盘"这种误操作。
_INSTRUMENT_SCAN_LIMIT = 4000
_INSTRUMENT_DEPTH_MAX = 6
_INSTRUMENT_DEPTH_DEFAULT = 3
# 只有**这个程序播得出来**的才算 playable。SFZ 是纯文本 + wav，引擎里读得动；VST3 与 .fxp 现在
# 只知道它们在哪儿，播不动 —— 列出来但标暗，别让人以为点了会响。
_INSTRUMENT_PLAYABLE = {'sfz': True, 'vst3-preset': True, 'surge-fxp': False,
                        'kontakt': False, 'vstsound': False}

# ── 一颗库里"一件乐器"是哪种文件 ───────────────────────────────────────────────────────────────
# 光认 .sfz 会让 Cubase / Kontakt / HALion 那种库整个变成 0 条 —— 用户把 `F:\Cubase Lib` 绑上去，
# 界面上什么都没有，看着像"绑定没生效"。而那种库里根本没有 .sfz：乐器是 .nki（Kontakt），音色库是
# .vstsound（HALion）。所以列出来的口径改成"**这是什么格式的乐器**"，播不播得动另说：
#   ext         → (backend, 来源标签, 可播)
# 不列的：.ncw（Kontakt 的压缩采样，几万个，是采样不是乐器）、.nkc/.nkr/.nkx（库容器，跟着 .nki 走）、
# .nksn（Kontakt 快照 = 预设，不是独立乐器）、.nicnt（库许可证描述）。
_INSTRUMENT_FILE_KINDS = {
    '.sfz': ('sfz', 'SFZ', True),
    '.vstpreset': ('vst3-preset', 'VST3 Preset', True),
    '.nki': ('kontakt', 'Kontakt', False),
    '.vstsound': ('vstsound', 'HALion', False),
}


def _midi_read():
    """读 MIDI 设置。形状不认识就退回默认 —— 一份坏设置不该让这一屏打不开。"""
    out = {'instruments_library': '', 'presets_library': '', 'scan_depth': _INSTRUMENT_DEPTH_DEFAULT}
    try:
        with open(_workbench_file('midi.json'), 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception:
        return out
    if isinstance(data, dict):
        lib = data.get('instruments_library')
        if isinstance(lib, str):
            out['instruments_library'] = lib[:1024]
        pres = data.get('presets_library')
        if isinstance(pres, str):
            out['presets_library'] = pres[:1024]
        depth = data.get('scan_depth')
        if isinstance(depth, (int, float)) and not isinstance(depth, bool):
            out['scan_depth'] = max(0, min(_INSTRUMENT_DEPTH_MAX, int(depth)))
    return out


def _midi_write(patch):
    """合并写。**只认这三个键** —— 页面送来的别的一律不收（这不是一个通用设置抽屉）。"""
    if not isinstance(patch, dict):
        raise ValueError('settings must be an object')
    with _MIDI_LOCK:
        cur = _midi_read()
        if 'instruments_library' in patch:
            lib = patch.get('instruments_library')
            if not isinstance(lib, str):
                raise ValueError('instruments_library must be a string')
            cur['instruments_library'] = lib.strip()[:1024]
        if 'presets_library' in patch:
            pres = patch.get('presets_library')
            if not isinstance(pres, str):
                raise ValueError('presets_library must be a string')
            cur['presets_library'] = pres.strip()[:1024]
        if 'scan_depth' in patch:
            depth = patch.get('scan_depth')
            if not isinstance(depth, (int, float)) or isinstance(depth, bool):
                raise ValueError('scan_depth must be a number')
            cur['scan_depth'] = max(0, min(_INSTRUMENT_DEPTH_MAX, int(depth)))
        path = _workbench_file('midi.json')
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(cur, f, ensure_ascii=False)
        os.replace(tmp, path)
    return cur


def _library_state(path):
    """一条路径的实话 —— 没设 / 不存在 / 不是目录 / 可读。前端照它决定画清单还是画一句话。"""
    if not path:
        return {'set': False, 'ok': False, 'reason': 'no library folder chosen yet'}
    if not os.path.exists(path):
        return {'set': True, 'ok': False, 'reason': 'folder does not exist'}
    if not os.path.isdir(path):
        return {'set': True, 'ok': False, 'reason': 'that path is a file, not a folder'}
    return {'set': True, 'ok': True, 'reason': ''}


def _scan_instruments(root, depth):
    """列出 root 下的乐器。返回 (source, items, truncated)。

    两条路，按"这颗库到底是什么"自动选，不让用户选：
      · 有 catalog.json（原项目那种入库清单）—— 它已经逐条验证过，直接读，source='catalog'；
      · 没有 —— 扫目录，source='scan'。一枚 .sfz 是一件乐器；一个 .vst3 bundle（在 Windows 上
        是**目录**）也是一件，bundle 里面不再往下走 —— 那里是二进制，不是音色。
    """
    catalog = os.path.join(root, 'catalog.json')
    base = os.path.abspath(root)
    if os.path.isfile(catalog):
        try:
            if os.path.getsize(catalog) <= 64 * 1024 * 1024:
                with open(catalog, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                presets = data.get('presets') if isinstance(data, dict) else None
                if isinstance(presets, list) and presets:
                    items = []
                    for p in presets[:_INSTRUMENT_SCAN_LIMIT]:
                        if not isinstance(p, dict):
                            continue
                        backend = str(p.get('backend') or '')
                        model = p.get('model') if isinstance(p.get('model'), dict) else {}
                        src = p.get('source') if isinstance(p.get('source'), dict) else {}
                        where = ''
                        for key in ('sfizz_sfz_path', 'preset_path', 'plugin_path'):
                            if isinstance(p.get(key), str) and p[key]:
                                where = p[key]
                                break
                        items.append({
                            'id': str(p.get('id') or ''),
                            'name': str(p.get('name') or p.get('variant_name') or ''),
                            'model': str(model.get('name') or ''),
                            'family': str(p.get('family') or ''),
                            'backend': backend,
                            'source': str(src.get('product') or src.get('library') or ''),
                            'playable': bool(_INSTRUMENT_PLAYABLE.get(backend, False)),
                            'verified': bool(p.get('audio_verified')),
                            'where': where[:400],
                            'root': base,
                        })
                    return 'catalog', items, len(presets) > len(items)
        except Exception:
            pass  # 读不动就当没有 catalog，退回扫目录（一颗坏清单不该让整档空着）
    items = []
    truncated = False
    for dirpath, dirnames, filenames in os.walk(base):
        rel = os.path.relpath(dirpath, base)
        level = 0 if rel == '.' else rel.count(os.sep) + 1
        if level >= depth:
            dirnames[:] = []
        keep = []
        for d in sorted(dirnames):
            if d.lower().endswith('.vst3'):
                full = os.path.join(dirpath, d)
                items.append({
                    'id': os.path.relpath(full, base).replace(os.sep, '/'),
                    'name': d[:-5],
                    'model': '' if rel == '.' else rel.split(os.sep)[-1],
                    'family': '', 'backend': 'vst3-plugin', 'source': 'VST3 Plug-in',
                    'playable': True, 'verified': False,
                    'where': os.path.relpath(full, base).replace(os.sep, '/'),
                    'root': base,
                })
            else:
                keep.append(d)
        dirnames[:] = keep
        for fn in sorted(filenames):
            kind = _INSTRUMENT_FILE_KINDS.get(os.path.splitext(fn)[1].lower())
            if not kind:
                continue
            backend, label, playable = kind
            full = os.path.join(dirpath, fn)
            items.append({
                'id': os.path.relpath(full, base).replace(os.sep, '/'),
                'name': os.path.splitext(fn)[0],
                'model': '' if rel == '.' else rel.split(os.sep)[-1],
                'family': '', 'backend': backend, 'source': label,
                'playable': playable, 'verified': playable,
                'where': os.path.relpath(full, base).replace(os.sep, '/'),
                'root': base,
            })
        if len(items) >= _INSTRUMENT_SCAN_LIMIT:
            truncated = True
            items = items[:_INSTRUMENT_SCAN_LIMIT]
            break
    items.sort(key=lambda it: (it['model'].casefold(), it['name'].casefold()))
    return 'scan', items, truncated


def _scan_presets(root, depth):
    """预设根：`.vstpreset` → (by_stem, items, truncated)。

    这里是**唯一**能让 Kontakt / HALion 那类库出声的东西：.nki/.vstsound 是封闭容器，
    本引擎解不了；用户在宿主里把音色导成 `.vstpreset`，引擎就靠它把整份状态灌进真插件。
    by_stem 只用来给同名的 .nki 找出声的钥匙（见 _pair_presets），不参与界面。
    """
    by_stem = {}
    items = []
    truncated = False
    base = os.path.abspath(root)
    for dirpath, dirnames, filenames in os.walk(base):
        rel = os.path.relpath(dirpath, base)
        level = 0 if rel == '.' else rel.count(os.sep) + 1
        if level >= depth:
            dirnames[:] = []
        dirnames[:] = [d for d in sorted(dirnames) if not d.lower().endswith('.vst3')]
        for fn in sorted(filenames):
            if not fn.lower().endswith('.vstpreset'):
                continue
            where = os.path.relpath(os.path.join(dirpath, fn), base).replace(os.sep, '/')
            by_stem.setdefault(os.path.splitext(fn)[0].casefold(), where)
            items.append({
                'id': 'preset:' + where,
                'name': os.path.splitext(fn)[0],
                'model': '' if rel == '.' else rel.split(os.sep)[-1],
                'family': '', 'backend': 'vst3-preset', 'source': 'VST3 Preset',
                'playable': True, 'verified': False,
                'where': where, 'root': base,
            })
        if len(items) >= _INSTRUMENT_SCAN_LIMIT:
            truncated = True
            items = items[:_INSTRUMENT_SCAN_LIMIT]
            break
    return by_stem, items, truncated


def _pair_presets(items, inst_root, presets_root, by_stem):
    """给 .nki/.vstsound 找同一件乐器的 `.vstpreset`：先看同目录同 stem，再按名字在预设根里找。

    找到就把 `where` 指到预设、`root` 指到它所在的那棵根 —— 界面拿 (root, where) 拼绝对路径，
    双击/试听才会真的装上那件乐器，而不是对着一份 .nki 说"播不动"。
    返回 (预设根里被用掉的相对路径, 同目录被用掉的绝对路径) —— 两条都别在界面上再列一遍。
    """
    used_rel = set()
    used_abs = set()
    for it in items:
        if it.get('backend') not in ('kontakt', 'vstsound') or it.get('playable'):
            continue
        stem = os.path.splitext(it['name'])[0].casefold()
        sibling = os.path.splitext(os.path.join(inst_root, it['where'].replace('/', os.sep)))[0] + '.vstpreset'
        if os.path.isfile(sibling):
            it.update(where=os.path.relpath(sibling, inst_root).replace(os.sep, '/'),
                      root=inst_root, playable=True)
            used_abs.add(os.path.normcase(sibling))
            continue
        rel = by_stem.get(stem)
        if rel and presets_root:
            it.update(where=rel, root=presets_root, playable=True)
            used_rel.add(rel)
    return used_rel, used_abs


def _installed_plugin_items():
    """本机装着的 VST3 插件（标准 VST3 目录）—— 一条轨可以**从插件开始**。

    为什么要有这一档：HALion / Kontakt 的音色库是封闭容器，声音只能由插件自己挑；而"挑"的
    前提是这一轨先有一支跑着的实例。装上插件 = 它的默认音色，之后用轨道行的音色窗开它的界面。
    名字取 bundle 文件名；不为了列表去逐个实例化（一支要几百毫秒到几秒）。
    """
    try:
        from . import vst3_registry
        bundles = vst3_registry.list_bundles()
    except Exception:
        return []
    out = []
    for full in bundles:
        name = os.path.basename(full.rstrip('\\/'))
        if name.lower().endswith('.vst3'):
            name = name[:-5]
        out.append({
            'id': 'plugin:' + full, 'name': name, 'model': 'Plug-in',
            'family': '', 'backend': 'vst3-plugin', 'source': 'Installed plug-in',
            'playable': True, 'verified': False, 'where': full, 'root': '',
        })
    return out


def _instruments_payload():
    """给 Assets 窗的 Instruments 档：路径 + 状态 + 清单，一次给全，页面不用再问第二遍。

    两棵根：乐器库（.sfz/.nki/.vstsound/.vstpreset）与预设库（用户从宿主导出的 .vstpreset）。
    两棵都能只设一棵 —— 只设预设库照样能挑能放（VST3 那类库的正确用法）。
    另外本机装着的 VST3 插件总是列出来：它不是"某个文件夹里的东西"，是这台机器的事实。
    """
    settings = _midi_read()
    path = settings['instruments_library']
    presets_path = settings['presets_library']
    state = _library_state(path)
    presets_state = _library_state(presets_path)
    plugin_items = _installed_plugin_items()
    payload = {'ok': state['ok'], 'root': path, 'state': state,
               'presets_root': presets_path, 'presets_state': presets_state,
               'scan_depth': settings['scan_depth'],
               'source': 'none', 'items': [], 'total': 0, 'truncated': False, 'error': '',
               'elapsed_ms': 0}
    if not state['ok'] and not presets_state['ok'] and not plugin_items:
        return payload
    started = time.time()
    try:
        source, items, truncated = 'none', [], False
        by_stem, preset_items = {}, []
        if state['ok']:
            source, items, truncated = _scan_instruments(path, settings['scan_depth'])
        if presets_state['ok']:
            by_stem, preset_items, more = _scan_presets(presets_path, settings['scan_depth'])
            truncated = truncated or more
            if source == 'none':
                source = 'scan'
        used_rel, used_abs = _pair_presets(items, path, presets_path, by_stem)
        items = [it for it in items
                 if it.get('backend') != 'vst3-preset'
                 or os.path.normcase(os.path.join(it.get('root') or '',
                                                  it['where'].replace('/', os.sep))) not in used_abs]
        items.extend(p for p in preset_items if p['where'] not in used_rel)
        items.extend(plugin_items)
        items.sort(key=lambda it: (it['model'].casefold(), it['name'].casefold()))
        payload.update({'ok': True, 'source': source, 'items': items,
                        'total': len(items), 'truncated': truncated})
    except Exception as e:
        # 盘被拔了、没有权限 —— 如实报，别把整档画成"空库"（空库和读不到是两件事）。
        payload.update({'ok': False, 'error': str(e)[:300],
                        'state': {'set': True, 'ok': False, 'reason': str(e)[:200]}})
    payload['elapsed_ms'] = int((time.time() - started) * 1000)
    return payload


def _editor_preset_folder():
    """自动存的 `.vstpreset` 落到哪：预设库；没设就落 data/sampler/presets 并把它设成预设库。

    为什么不设就悄悄写进 data/：存了而列表里看不见 = 用户以为存丢了。顺手把设置写上，
    下一趟扫库就能看见这一份（`auto_set` 让界面知道这条设置是这次替它补的）。
    返回 (目录, 是否刚补的设置, 提示)。设了却用不了（盘没挂/没权限）时退到本地，
    提示里说明 —— 这份音色是用户刚挑的，不能因为设置指错地方就丢掉。
    """
    settings = _midi_read()
    wanted = (settings.get('presets_library') or '').strip()
    if wanted:
        folder = os.path.abspath(wanted)
        try:
            os.makedirs(folder, exist_ok=True)
            return folder, False, ''
        except OSError:
            note = 'the presets folder "%s" is not usable; saved next to the app instead' % wanted
    else:
        note = ''
    folder = os.path.join(data_dir('sampler'), 'presets')
    os.makedirs(folder, exist_ok=True)
    if not wanted:
        _midi_write({'presets_library': folder})
        return folder, True, ''
    return folder, False, note


def _editor_preset_target(folder, stem, current=''):
    """这一份写哪个文件名：同名已在、且**就是这一轨现在挂的那份** → 覆盖（调音色不该多一份）；
    否则加序号。返回 (路径, 名字)。"""
    cur = os.path.normcase(os.path.abspath(current)) if current else ''
    name, n = stem, 2
    while True:
        path = os.path.join(folder, name + '.vstpreset')
        if not os.path.exists(path):
            return path, name
        if cur and os.path.normcase(os.path.abspath(path)) == cur:
            return path, name
        if n > 200:
            return path, name            # 极端重名：覆盖最后这一份，别把存盘卡死
        name = '%s %d' % (stem, n)
        n += 1


def _audio_editor_save(data):
    """编辑器关窗 → 把这一槽**现在**的状态存成 .vstpreset 并入乐器库。

    用户不导出任何东西：窗口里挑完、关掉，这一下就是"另存音色"。名字默认取轨名，
    所以同一条轨反复调就是同一份文件在更新，不会一次一份堆满预设库。
    """
    if audio_bridge is None:
        return {'ok': False, 'error': 'audio bridge unavailable'}
    engine = audio_bridge.get_engine()
    track = data.get('track')
    rows = engine.track_instrument_state()
    row = next((r for r in rows if str(r.get('track')) == str(track)), None)
    name = str(data.get('name') or '').strip()
    if not name and row:
        name = str(row.get('name') or '') or os.path.splitext(
            os.path.basename(str(row.get('path') or '')))[0]
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', ' ', name)
    stem = re.sub(r'\s+', ' ', stem).strip()[:64].strip().strip('.') or 'Instrument'
    try:
        folder, auto_set, note = _editor_preset_folder()
    except OSError as e:
        return {'ok': False, 'error': 'the presets folder is not usable: %s' % e}
    current = str((row or {}).get('preset') or '')
    if not current and (row or {}).get('path', '').lower().endswith('.vstpreset'):
        current = str(row.get('path'))
    target, saved_name = _editor_preset_target(folder, stem, current)
    res = engine.editor_save(track, target)
    if not res.get('ok'):
        return res
    res.update({'folder': folder, 'name': saved_name,
                'presets_root': _midi_read().get('presets_library') or folder,
                'autoPresetsFolder': auto_set})
    if note:
        res['warning'] = note
    return res


def _layouts_boot_payload():
    """页面**第一帧**要用的那一份摆法，随 HTML 一起送下去（见下面 do_GET 里的注入）。

    为什么要塞进 HTML，而不是让页面 mount 之后再 fetch：晚一步就来不及了 —— 页面会先按
    localStorage 里那份（或者干脆按内置默认）把窗摆一遍，等 `/api/layouts` 回来再跳一次。
    用户看到的就是"打开时闪一下默认布局"。localhost 上这一跳也就几十毫秒，可它跳的是**整页的
    形状**，比什么都显眼。塞进 HTML 就没有"晚一步"这回事：脚本解析时答案已经在手上。

    空壳（没有 `current`、也没有 ★）时给 null —— 页面据此知道"这一趟真的什么都没有"，
    照内置默认摆，并且**不许**把那个默认写回盘上（见前端的 `armed`）。
    """
    store = _layouts_read()
    cur = store['current']
    items = store['items']
    def_dock = None
    if store['default']:
        for it in items:
            if it['name'] == store['default']:
                def_dock = it['dock']
                break
    if cur is None and def_dock is None:
        return None
    return {'v': 1,
            'current': cur['dock'] if cur else None,
            'currentAt': cur['at'] if cur else 0,
            'default': def_dock,
            'defaultName': store['default']}


def _inject_boot_layout(html):
    """把上面那份塞进 `</head>` 之前。塞不进去就把页面原样发出去 —— 一份布局不该挡住页面。"""
    try:
        payload = _layouts_boot_payload()
        if payload is None:
            return html
        blob = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
        # 树里只有 id / 数字，可 JSON 里万一出现 `</script` 就会把脚本提前截断 —— 一律打断。
        blob = blob.replace('</', '<\\/')
        tag = '<script>window.__DOCK_BOOT__=%s;</script>' % blob
        at = html.find('</head>')
        if at < 0:
            return html
        return html[:at] + tag + '\n  ' + html[at:]
    except Exception:
        return html


# =============================================================================
# Video 资产入库（Assets 是 Video 工程所有数据的来源）：ffprobe 探测 + 按需转码代理。
#
# 浏览器的时间线（<video> + WebAudio）只咬得动它认识的容器/编码；ComfyUI 世界里的素材
# 什么都有（HEVC、ProRes、MPEG-4 Part 2、怪封装…）。本地文件拖进 Assets / Tracks 时走这里：
#   1. 文件字节按内容哈希落盘（data/sampler/media/vid/）—— 同一文件只存一份，拖几次都是
#      同一条 URL，刷新/换端口都活着（blob: 活不过刷新的时代到此为止）；
#   2. ffprobe 读时长/有无音轨/编码；浏览器可解（mp4/webm/m4v/mov + h264/vp8/vp9/av1 +
#      aac/mp3/opus）就原样伺候；咬不动就转一条 H.264+AAC faststart 的代理片；
#   3. 纯音频（无视频流）原样伺候 —— 前端只拿 audioOnly 决定改派音频轨。
# ffmpeg 找不到时（PATH / KOLID_FFMPEG_DIR 环境变量）整条路降级：前端自己回退旧的
# <video> 探测 + blob: 路径。逻辑全在模块级函数里，ComfyUI 之外可单测（路由只读 body）。
_VID_VC_OK = {'h264', 'vp8', 'vp9', 'av1'}
_VID_AC_OK = {'aac', 'mp3', 'opus', 'vorbis', 'flac'}
_VID_CONT_OK = {'.mp4', '.m4v', '.webm', '.mov'}


def _vid_media_dir():
    """资产媒体库的落点：data/sampler/media/vid/。"""
    return os.path.join(data_dir('sampler'), 'media', 'vid')


def _vid_media_path(ref):
    """媒体引用 → 盘上路径（A5：字节的家搬进资产仓库后，这里就是那个兼容 resolver）。

    `ref` 三种写法都收，因为文件里、旧工程里、新代码里三种都还在：
      · `/api/vid_media/<file>` 或裸 `<file>` —— 老 URL 面，继续有效；
      · `/api/asset_media/<hash>` 或裸 `<hash>` —— 仓库正身（A5 起的原件）；
      · 绝对路径只在"它确实就在这两个目录里"时放行（老 .cud 写过路径）。

    先看 media/vid（老货 + 派生缓存：波形、抽帧、merge 产物），再看仓库。找不到返回 None ——
    调用方据此报 404 / 画"缺失"，**不要**退回"随便找一个同名的"。
    """
    s = str(ref or '').strip()
    if not s:
        return None
    for pre in ('/api/vid_media/', '/api/asset_media/', '/api/global_media/'):
        if s.startswith(pre):
            s = s[len(pre):]
            break
    s = unquote(s.split('?', 1)[0])
    name = os.path.basename(s)
    if not name:
        return None
    p = os.path.join(_vid_media_dir(), name)
    if os.path.isfile(p):
        return p
    # 仓库认 hash（带不带扩展名都行：`<md5>`、`<md5>.mp4`）。
    rec = asset_store.get(name) or asset_store.get(os.path.splitext(name)[0])
    return rec['path'] if rec else None


# =============================================================================
# 全局资产库（Assets 窗的 Global 开关读的就是这一份）
#
# 落点**就是节点那一份** —— `data_dir('assets')`，与 assets_node 的 `asset_cache_dir`
# 同一个函数、同一个目录。它是跨文档共用的素材：不随任何 .cud 走，谁打开都能看见；
# 而上面那个 `_vid_media_dir()` 是**某一份工程**自己入库的东西。
# 别在别处再开一份"全局"目录 —— 只有一个落点，才对得起节点写进去的那些字节。
#
# 清单与 id 由 `libs/asset_store.py` 统一给（扩展名 → 种类也只剩它那一份判定）。


def _global_assets_dir():
    """全局资产库的落点 = 节点那一份：data/assets/。"""
    return data_dir('assets')


# ffprobe 的记性：`名字 → (字节数, 落盘时间, {hasAudio, duration})`。**按大小+时间认货** ——
# 文件被换掉（同名不同内容）时 key 对不上，自然重探。一个文件近 0.3s，整库几十个视频
# 串行要十来秒，所以只探一次、之后全走这张表。
_GA_PROBE_CACHE: dict = {}
_GA_PROBE_LOCK = threading.Lock()


def _global_probe(name, path, size, mtime):
    """一件货的"媒体事实"：有没有音轨（卡上的 AUD 角标）+ 时长（悬停扫片要按时刻取格）。
    探不到（没 ffprobe / 咬不动）= `hasAudio: None` —— **"不知道"就别画角标**，
    猜一个错的比不画更糟。"""
    with _GA_PROBE_LOCK:
        hit = _GA_PROBE_CACHE.get(name)
        if hit and hit[0] == size and hit[1] == mtime:
            return hit[2]
    try:
        probe = _vid_ffprobe(path) or {}
    except Exception:
        probe = {}
    info = {'hasAudio': bool(probe.get('acodec')) if probe else None,
            'duration': float(probe.get('duration') or 0)}
    with _GA_PROBE_LOCK:
        _GA_PROBE_CACHE[name] = (size, mtime, info)
    return info


def _global_assets_list():
    """列一遍全局资产：名字 / 可播 URL / 类型 / 字节数 / 落盘时间（新的在前）。

    清单来自资产仓库（`libs/asset_store.py`）—— 那是唯一落点，也是 id 的来源。字段与旧版
    **逐字兼容**：`name` 仍是文件名、`url` 仍是 `/api/global_media/<文件名>`
    （视频资产窗的拖拽载荷认的就是这两个，别动它们）。新增 `hash` / `inLibrary` / `thumb`
    三个字段，老调用方不看即可。

    媒体（视频/音频）的 `hasAudio`（卡上那个 AUD 角标）与 `duration`（悬停扫片按时刻取格
    要它）由 ffprobe 探 —— 整库并发跑一遍，只在第一次慢；图片不探。
    """
    d = _global_assets_dir()
    items = []
    try:
        recs = asset_store.records()
        # A5：转码代理是**内部件**（时间线拿它播，用户不该在窗里看见第二张卡）。
        # 原件那一条带上 `playHash`：拖进时间线/播放一律用可播的那份，`hash` 仍是正身。
        proxy_of = {}
        for rec in recs:
            po = (rec.get('meta') or {}).get('proxyOf')
            if po:
                proxy_of.setdefault(str(po), rec['id'])
        for rec in recs:
            if (rec.get('meta') or {}).get('proxyOf'):
                continue
            items.append({
                'name': rec['file'],
                'url': '/api/global_media/' + quote(rec['file']),
                'kind': rec['kind'],
                'size': rec['size'],
                'mtime': rec['mtime'],
                'hasAudio': None,
                'duration': 0,
                'hash': rec['id'],
                'playHash': proxy_of.get(rec['id']),
                'inLibrary': rec['inLibrary'],
                'origin': rec['origin'],
                'displayName': rec['name'],
                'tags': list(rec.get('tags') or []),
                'thumb': ('/api/asset_thumb/' + rec['id']) if rec['kind'] == 'image' else None,
            })
    except Exception as e:
        print('[global_assets] list failed: %s' % e)
        return items
    # 只有媒体（视频/音频）要探；并发 8 条 —— 一个 ffprobe 近 0.3s，串行会把第一次打开拖到十几秒。
    media = [it for it in items if it['kind'] in ('video', 'audio')]
    if media:
        try:
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=8) as pool:
                infos = list(pool.map(
                    lambda it: _global_probe(it['name'], os.path.join(d, it['name']),
                                             it['size'], it['mtime']), media))
            for it, info in zip(media, infos):
                it['hasAudio'] = info['hasAudio']
                it['duration'] = info['duration']
        except Exception:
            pass          # 并发那套没起来：角标不画、扫片退回首帧，清单照给
    return items


def _send_media_file(h, path, cacheable=True):
    """带 Range 的文件伺服 —— <video> 的 seek 靠它。返回 True = 响应已发出（404 交给调用方）。
    全局资产与工程媒体库两条路共用这一份，免得两边各写一遍字节搬运。"""
    if not os.path.isfile(path):
        return False
    size = os.path.getsize(path)
    mime = mimetypes.guess_type(path)[0] or 'application/octet-stream'
    start, end, code = 0, size - 1, 200
    rng = h.headers.get('Range') or ''
    if rng.startswith('bytes='):
        try:
            a, b = rng.split('=', 1)[1].split('-', 1)
            start = int(a) if a else 0
            end = min(int(b), size - 1) if b else size - 1
            code = 206
        except (ValueError, IndexError):
            start, end, code = 0, size - 1, 200
    length = max(0, end - start + 1)
    try:
        h.send_response(code)
        h.send_header('Content-type', mime)
        h.send_header('Accept-Ranges', 'bytes')
        h.send_header('Cache-Control', 'max-age=31536000, immutable' if cacheable else 'no-store')
        if code == 206:
            h.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        h.send_header('Content-Length', str(length))
        h.end_headers()
        if length:
            with open(path, 'rb') as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(1 << 20, remaining))
                    if not chunk:
                        break
                    h.wfile.write(chunk)
                    remaining -= len(chunk)
    except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
        # <video> 拖完进度条就断开是常态（seek 会重新发 Range 请求），浏览器自己会重连；
        # 这里静默收摊，别在每个断流上抛一整段 traceback。
        return True
    return True


def _ff_bin(name):
    """ffmpeg / ffprobe 可执行文件：先看 PATH，再试 KOLID_FFMPEG_DIR（指到 bin 目录），
    最后落到**包内自带的那份**（plugins/ffmpeg/bin，与 video_node / video_utils 同一落点）。
    ComfyUI 进程的 PATH 是启动那一刻的：ffmpeg 后装进系统、或从精简启动器起来时它看不见 ——
    包内这份随仓库走，是那时唯一还在的。找不到才交 None，由调用方降级（前端回退 blob:）。"""
    exe = shutil.which(name)
    if exe:
        return exe
    fname = name + ('.exe' if os.name == 'nt' else '')
    dirs = [os.environ.get('KOLID_FFMPEG_DIR'),
            os.path.join(PACK_ROOT, 'plugins', 'ffmpeg', 'bin')]
    for d in dirs:
        if not d:
            continue
        cand = os.path.join(d, fname)
        if os.path.isfile(cand):
            return cand
    return None


def _vid_ffprobe(path):
    """ffprobe -show_format -show_streams 的瘦封装。attached_pic（专辑封面）不算视频流。

    PyAV 直读优先（libs/av_media）：解码器在进程内，省掉一次 ffprobe 子进程，字段与下面
    ffprobe 这条分支严格同构（已逐字段比对过）。PyAV 不在 / 打不开这个文件才回退。
    """
    try:
        p = av_media.probe(path)
    except Exception:
        p = None
    if p:
        return p
    fp = _ff_bin('ffprobe')
    if not fp:
        return None
    try:
        out = subprocess.run([fp, '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', path],
                             capture_output=True, timeout=60)
        data = json.loads(out.stdout.decode('utf-8', 'replace'))
    except Exception:
        return None
    vcodec = acodec = None
    width = height = 0
    fps = 0.0
    def _rate(v):
        """'30000/1001' → 29.97；读不出来算 0（调用方走"按秒抽帧"的旧路）。"""
        try:
            a, _, b = str(v or '').partition('/')
            return float(a) / float(b or 1)
        except (TypeError, ValueError):
            return 0.0
    for s in (data.get('streams') or []):
        t = s.get('codec_type')
        if t == 'video' and vcodec is None and not (s.get('disposition') or {}).get('attached_pic'):
            vcodec = s.get('codec_name') or ''
            try:
                width = int(s.get('width') or 0)
                height = int(s.get('height') or 0)
            except (TypeError, ValueError):
                width = height = 0
            # 源帧率：抽帧要按**源帧号**取（见 _vid_frames），VFR 只能近似。
            fps = _rate(s.get('avg_frame_rate')) or _rate(s.get('r_frame_rate'))
        elif t == 'audio' and acodec is None:
            acodec = s.get('codec_name') or ''
    try:
        dur = float((data.get('format') or {}).get('duration') or 0)
    except (TypeError, ValueError):
        dur = 0
    return {'duration': dur, 'vcodec': vcodec, 'acodec': acodec,
            'width': width, 'height': height, 'fps': fps}


def _vid_browser_ok(ext, probe):
    """这套容器+编码 <video> 能不能直接咬。纯音频不在这里判（一律原样伺候）。"""
    if probe is None or ext not in _VID_CONT_OK:
        return False
    if probe['vcodec']:
        return (probe['vcodec'].lower() in _VID_VC_OK
                and (not probe['acodec'] or probe['acodec'].lower() in _VID_AC_OK))
    return False


def _vid_previews(path, probe, d):
    """给已入库的媒体生成时间线预览。波形（有音轨才有）在入库时一次生成 —— 整段源的波形
    PNG，前端按片段自己的 offset/duration 线性裁窗，裁剪天然跟随。视频的首帧/尾帧不在这里
    生成：片段会被裁剪，帧位置跟着 offset/duration 走，走按需的 /api/vid_frame（见 _vid_frame）。
    预览是锦上添花，任何一步失败都静默跳过。返回 {'waveform': URL}（或空 dict）。"""
    out = {}
    if not probe.get('acodec'):
        return out
    ff = _ff_bin('ffmpeg')
    if not ff:
        return out
    base = os.path.splitext(os.path.basename(path))[0]
    wave = os.path.join(d, base + '_wave.png')
    if not os.path.exists(wave):
        # PyAV 直读优先（libs/av_media）：解码 + 重采样都在进程内，且按真实峰值包络画。
        # 旧的 showwavespic 滤镜画出来只有 ±4px（几乎是条平线），新路与 ffmpeg 解出的
        # 原始 PCM 逐列一致（实测相关系数 1.0000）。拿不到才回退滤镜。
        ok_w = False
        try:
            ok_w = av_media.wave_png(path, wave, width=1600, height=128, color='#30d158')
        except Exception:
            ok_w = False
        if not ok_w:
            subprocess.run([ff, '-y', '-i', path, '-filter_complex',
                            'aformat=channel_layouts=mono,showwavespic=s=1600x128:colors=#30d158',
                            '-frames:v', '1', wave], capture_output=True, timeout=180)
    if os.path.exists(wave):
        out['waveform'] = '/api/vid_media/' + os.path.basename(wave)
    return out


def _vid_frame(path, t):
    """提取源内 t 秒处的一帧小图（时间线片段的头/尾帧用）。按 (文件, 秒两位小数) 落盘缓存。
    t 越出源尾（裁剪后片段贴着源尾是常态）就退回 -sseof 抓最后一帧。返回 jpg 路径或 None。"""
    ff = _ff_bin('ffmpeg')
    if not ff or not os.path.isfile(path):
        return None
    try:
        t = max(0.0, round(float(t or 0), 2))
    except (TypeError, ValueError):
        return None
    base = os.path.splitext(os.path.basename(path))[0]
    out = os.path.join(_vid_media_dir(), f'{base}_f{t:.2f}.jpg')
    if not os.path.exists(out):
        # PyAV 直读优先（libs/av_media）：一次 seek + 按 PTS 定位就拿到确定答案，比 spawn
        # 一个 ffmpeg 快，也不用下面的 -sseof 兜片尾。拿不到才回退 ffmpeg。
        img = None
        try:
            img = av_media.frame_at(path, t, width=160)
        except Exception:
            img = None
        if img is not None:
            try:
                img.save(out, 'JPEG', quality=85)
            except Exception:
                pass
        if not os.path.exists(out):
            r = subprocess.run([ff, '-y', '-ss', f'{t:.2f}', '-i', path, '-vf', 'scale=160:-2',
                                '-frames:v', '1', '-update', '1', out], capture_output=True, timeout=60)
            if r.returncode != 0 or not os.path.exists(out):
                r = subprocess.run([ff, '-y', '-sseof', '-0.3', '-i', path, '-vf', 'scale=160:-2',
                                    '-frames:v', '1', '-update', '1', out], capture_output=True, timeout=60)
                if r.returncode != 0 or not os.path.exists(out):
                    return None
    return out


def _vid_strip(path, n):
    """一次抽出 n 张均匀铺满全片的缩略帧 —— 时间线拖动/裁剪时那张"跟手"的预览图取的就是
    它们。按 (文件, 张数) 落盘缓存为 `<stem>_s<NN>.jpg`，换端口、重开浏览器都还在。
    返回 URL 列表；ffmpeg 不在或这不是能解的媒体就返回 None。"""
    ff = _ff_bin('ffmpeg')
    if not ff or not os.path.isfile(path):
        return None
    try:
        n = max(2, min(160, int(n or 16)))
    except (TypeError, ValueError):
        n = 16
    stem = os.path.splitext(os.path.basename(path))[0]
    # 缩略帧是**派生缓存**，永远落 media/vid —— 源文件现在住在仓库里（A5），
    # 跟着源路径写就会把 jpg 当成新资产铺进 data/assets（还会被清单数成货）。
    d = _vid_media_dir()
    outs = [os.path.join(d, f'{stem}_s{i:03d}.jpg') for i in range(n)]
    if not all(os.path.exists(p) for p in outs):
        # PyAV 直读优先（libs/av_media）：按**帧号**均匀取，正好 n 张，落在真实帧边界上；
        # 而且逐段 seek 只解每个目标所在的半个 GOP，比全片顺序解快一个量级（实测 n=16：
        # 0.5s vs ffmpeg fps 滤镜的 3.6s）。拿不到才回退 ffmpeg。
        imgs: list = []
        try:
            imgs = av_media.strip(path, n, width=288)
        except Exception:
            imgs = []
        if len(imgs) == n:
            for img, p in zip(imgs, outs):
                try:
                    img.save(p, 'JPEG', quality=85)
                except Exception:
                    pass
        if not all(os.path.exists(p) for p in outs):
            probe = _vid_ffprobe(path) or {}
            total = probe.get('duration') or 0
            # fps = n/时长：让 ffmpeg 自己把 n 张铺到整片上（首尾都给到）。
            fps = (n / total) if total > 0 else 1
            # -start_number 0：image2 默认从 1 开始编号，而上面的文件名是 _s000 起算的。
            # scale 288：监视器替身图要放大到整窗，160 太糊；288 宽的 jpeg 仍在几 KB 量级。
            subprocess.run([ff, '-y', '-i', path, '-vf', f'fps={fps:.4f},scale=288:-2',
                               '-frames:v', str(n), '-start_number', '0',
                               os.path.join(d, f'{stem}_s%03d.jpg')],
                           capture_output=True, timeout=300)
    # 抽不满时（片子太短 / 尾帧被 GOP 吞掉）缺的那几格用前一格顶上 —— 缩略条宁可重复，
    # 也不能有洞：拖动扫过空洞会闪黑。
    made: list[str] = []
    for p in outs:
        if not os.path.exists(p) and made:
            try:
                shutil.copyfile(made[-1], p)
            except OSError:
                continue
        if os.path.exists(p):
            made.append(p)
    if len(made) < 2:
        return None
    return ['/api/vid_media/' + os.path.basename(p) for p in outs]


# Allow List（Processor 的视频那条路）：把一段视频按帧拆成一列 tensor，再把一列 tensor
# 编码回一段视频。两端都走 ffmpeg 的 rawvideo 管道（不落中间文件），帧尺寸在抽取时
# 就压到工作分辨率 —— 一列 1080p 的 float32 帧动辄几 GB，抽之前必须缩。
_VID_FRAME_MAX_W = 720      # ffprobe 量不到源尺寸时的兜底长边（也只缩不放）
_VID_FRAME_MAX_N = 150      # 一列帧的条数上限（再多内存扛不住，也让用户知道代价）
# Video Generator 的参考视频是**一层输入**，不参与处理器那种分段落位：它必须与段的
# 输出逐帧对齐，所以条数按段长 × 输出帧率走，不能套 150 的处理器上限。3600 ≈ 20 分钟
# @30fps，与处理器那套范围上限同一量级；帧尺寸仍由 _vid_work_size 的 1.5GiB 预算压。
_VID_REF_MAX_N = 3600
_VID_FRAME_BUDGET = 1536 * 1024 * 1024   # 一列帧（float32 RGB）的总字节预算 ≈ 1.5 GiB
_VID_CRF = 18               # 产物重编码质量（20 偏软，18 基本看不出二次编码损失）
_VID_PRESET = 'medium'      # veryfast 在同 CRF 下细节保留更差；产物都是短片段，medium 代价可接受


def _vid_work_size(sw, sh, n):
    """这一列帧的工作尺寸：长边按内存预算反推，短边按源比例取偶。

    帧列是一列 float32 RGB 张量，总字节 = n × 长边 × 短边 × 12。所以短片段可以按源分辨率
    进链路（1080p 的 15 帧 ≈ 0.36 GB），帧数越多长边越小，峰值内存封在 _VID_FRAME_BUDGET。
    "只缩不放"：长边不会超过源。量不到源尺寸时返回 (0, 0)，调用方走兜底分支。
    """
    if sw <= 0 or sh <= 0:
        return 0, 0
    long_edge = max(sw, sh)
    aspect = min(sw, sh) / long_edge
    budget_long = int((_VID_FRAME_BUDGET / max(1, n) / (12.0 * aspect)) ** 0.5)
    long_edge = max(2, min(long_edge, budget_long))
    long_edge -= long_edge % 2            # 偶数：_vid_encode 不用再为奇数宽高裁一列
    if sw >= sh:
        ow, oh = long_edge, max(2, int(round(long_edge * sh / sw / 2)) * 2)
    else:
        oh, ow = long_edge, max(2, int(round(long_edge * sw / sh / 2)) * 2)
    return ow, oh


def _vid_frames_av(path, start_f, n, pf, probe, work_n=None):
    """PyAV 按**时间戳**精确取帧，返回 [1,H,W,3] float tensor 列表（失败返回 None）。

    输出第 k 帧对应源时间 (start_f + k) / pf；取该时刻**正在显示**的源帧 ——
    PTS <= 该时间的最后一帧（nearest-previous）。这是播放器与 ComfyUI 自带
    VideoFromFile 的解码口径（见 comfy_api/latest/_input_impl/video_types.py：
    帧由 PyAV 解出、时间由帧自己的 PTS 决定），对 CFR / VFR 都成立：

      * 不再用"时间 × 平均帧率 = 帧号"换算。avg_frame_rate 只是全片平均，VFR、
        可变 GOP、元数据不准的源上它和真实帧边界对不上，按帧号切会在接缝处
        多一帧/少一帧；
      * 不再用 ffmpeg 的 -ss 输入跳转 + 手工下标切帧。seek 只负责"跳到目标之前
        最近的关键帧"，选哪一帧完全由解出来的 PTS 决定，seek 落点差一帧也不影响
        结果；
      * seek 到目标前一秒内，逐帧解码到窗口尾，只保留命中的 n 帧，内存与旧路一致。

    `work_n`：算工作尺寸时按这一列**总共**多少帧估预算（参考视频分多片采样时，
    各片必须用同一个总帧数，画面尺寸才一致）。缺省 = 本片 n。
    """
    try:
        import av
    except Exception:
        return None
    try:
        cont = av.open(path, mode='r')
    except Exception:
        return None
    try:
        st = next((s for s in cont.streams if s.type == 'video'), None)
        if st is None:
            return None
        tb = float(st.time_base) if st.time_base else 0.0
        # PTS 的原点：容器 start_time（多数 mp4 为 0；带 priming 的源可能非 0，
        # 与 ffmpeg -ss 的"相对文件起点"口径对齐）。
        base = float(st.start_time or 0) * tb if tb > 0 else 0.0
        rate = float(st.average_rate or 0) or float(probe.get('fps') or 0) or pf
        if rate <= 0:
            rate = 30.0
        targets = [base + (start_f + k) / pf for k in range(n)]
        sw = int(probe.get('width') or st.width or 0)
        sh = int(probe.get('height') or st.height or 0)
        ow, oh = _vid_work_size(sw, sh, int(work_n or n))
        if tb > 0:
            try:
                # backward：落在目标之前最近的关键帧上；之后逐帧解码、按 PTS 选。
                cont.seek(int(max(0.0, targets[0]) / tb), stream=st,
                          backward=True, any_frame=False)
            except Exception:
                cont.seek(0)

        def conv(frame):
            f = frame
            if ow > 0 and oh > 0 and (f.width != ow or f.height != oh):
                f = f.reformat(width=ow, height=oh, format='rgb24')
            else:
                f = f.reformat(format='rgb24')
            a = f.to_ndarray()
            return torch.from_numpy(np.ascontiguousarray(a)).to(torch.float32).div_(255.0).unsqueeze(0)

        out: list = []
        ti = 0
        eps = 1e-5                     # 10µs：远小于任意帧间隔，只用来吸收浮点误差
        last_frame = None
        last_t = 0.0
        last_dur = 1.0 / rate
        last_tensor = None
        for frame in cont.decode(st):
            ft = frame.time
            if ft is None:             # 无 PTS 的罕见流：按标称帧率推一个
                ft = last_t + (1.0 / rate if last_frame is not None else 0.0)
            ft = float(ft)
            fdur = float(frame.duration) * tb if (frame.duration and tb > 0) else 1.0 / rate
            if last_frame is None:
                last_frame, last_t, last_dur = frame, ft, fdur
                continue
            # 目标时间严格落在上一帧之后、这一帧之前 → 那些目标都由上一帧代表。
            while ti < n and targets[ti] + eps < ft:
                if last_tensor is None:
                    last_tensor = conv(last_frame)
                # 同一源帧被连续多个输出帧命中（升帧率时必然发生）—— 后续几帧给副本，
                # 免得下游若有原地修改把整段一起改掉。
                out.append(last_tensor if not out or out[-1] is not last_tensor else last_tensor.clone())
                ti += 1
            if ti >= n:
                break
            last_frame, last_t, last_dur = frame, ft, fdur
            last_tensor = None
        # 流结束：窗口尾部落在最后一帧"仍在显示"的时间内的，用最后一帧补齐；
        # 超出源尾的不补（调用方按实际条数落位，补出来的帧是重复内容）。
        if ti < n and last_frame is not None:
            if last_tensor is None:
                last_tensor = conv(last_frame)
            while ti < n and targets[ti] <= last_t + last_dur + eps:
                out.append(last_tensor if not out or out[-1] is not last_tensor else last_tensor.clone())
                ti += 1
        return out or None
    except Exception:
        return None
    finally:
        try:
            cont.close()
        except Exception:
            pass


def _vid_frames(path, ss=0.0, t=None, n=None, fps=None, f0=None, work_n=None, max_n=None):
    """从 [ss, ss+t] 里抽 n 帧，返回 [1,H,W,3] float tensor 的列表。

    入口是**帧段**：`f0` = 源文件内按 fps 的整数起始帧号（优先于 ss），`n` = 帧数。
    首选 `_vid_frames_av`：按 PyAV 解出的**帧 PTS** 选"该时刻正在显示的源帧"，
    段与段按同一时间网格首尾相接，接缝不重复也不跳帧（CFR / VFR 都成立）。
    PyAV 不可用或解不开时才退回 ffmpeg：有源帧率时按帧号取帧，量不到就按秒 + fps
    滤镜铺 n 张。
    n 与 fps 二选一（都给了按 n）。抽不满 n 张（片子比区间短）就返回实际抽到的那些 ——
    调用方按实际条数落位，不补帧（补出来的帧是重复内容，编码出来是卡顿）。
    帧尺寸在抽取时按帧列内存预算压到工作分辨率（见 _vid_work_size，只缩不放）——
    一列全尺寸的 float32 帧动辄几 GB，抽之前必须缩。
    `work_n` / `max_n` 只给"一列参考视频"用：前者按整列总帧数算尺寸（多片一致），
    后者放宽单次条数上限（参考视频要按段长整段对齐，不能被 150 帧的处理器上限截断）。
    返回 None = 抽不了（ffmpeg 不在 / 解不开 / 一帧都没抽到）。
    """
    ff = _ff_bin('ffmpeg')
    if not ff or not os.path.isfile(path):
        return None
    try:
        ss = max(0.0, float(ss or 0))
    except (TypeError, ValueError):
        ss = 0.0
    # 工程帧率：段网格、f0 都按它计。缺省 30 与旧行为一致。
    try:
        pf = float(fps or 0)
    except (TypeError, ValueError):
        pf = 0.0
    if pf <= 0:
        pf = 30.0
    # 本段第一帧的**工程帧号**：f0 优先；旧客户端只发 ss 时按 ss×pf 落回同一套网格。
    # 起点一律走整数帧号 —— 秒数只是它的表示，真正决定取哪一帧的是帧号。
    if f0 is not None:
        try:
            start_f = max(0, int(f0))
        except (TypeError, ValueError):
            start_f = int(ss * pf + 1e-6)
    else:
        start_f = int(ss * pf + 1e-6)
    ss = start_f / pf
    if n is not None:
        try:
            t = float(n) / pf
        except (TypeError, ValueError):
            t = None
    probe = _vid_ffprobe(path) or {}
    total = probe.get('duration') or 0
    try:
        _fps_req = float(fps or 0)
    except (TypeError, ValueError):
        _fps_req = 0.0
    if t is None:
        # n + fps 一起给的时候，区间长度就是 n / fps —— 不能拿"整段剩下的时长"当 t：
        # 那会把 n 帧摊到整段上（抽出来的 fps 远低于请求值），编码却仍按 fps 写，
        # 产物看起来就是被快进了好几倍。
        if n is not None and _fps_req > 0:
            try:
                t = float(n) / _fps_req
            except (TypeError, ValueError):
                t = max(0.0, total - ss)
        else:
            t = max(0.0, total - ss)
    try:
        t = max(0.05, float(t))
    except (TypeError, ValueError):
        return None
    if n is None:
        try:
            n = int(round(float(fps or 30) * t))
        except (TypeError, ValueError):
            n = 30
    n = max(1, int(n))
    if max_n is not None:
        try:
            n = max(1, min(int(max_n), n))
        except (TypeError, ValueError):
            n = max(1, min(_VID_FRAME_MAX_N, n))
    else:
        n = max(1, min(_VID_FRAME_MAX_N, n))
    # 首选精确路径：PyAV 按帧 PTS 选"该时刻正在显示的源帧"（见 _vid_frames_av）。
    # 它对源帧率元数据、seek 落点都不敏感 —— 下面按帧号切帧的 ffmpeg 路只作兜底。
    av_frames = _vid_frames_av(path, start_f, n, pf, probe, work_n=work_n)
    if av_frames:
        print(f'[VidFrames] {os.path.basename(path)} f0={start_f} n={n} pf={pf:.3f} '
              f'→ {len(av_frames)}/{n} frames (pyav pts)')
        return av_frames
    # 抽出来的尺寸：长边按**实际要解的帧数**对应的内存预算反推（见 _vid_work_size），
    # 短边按比例取偶。按源帧号取帧时实际解码 need 帧（可能多于 n），预算按 need 算。
    # 宽高必须都钉死成这里算出的数值，不能把高度交给 ffmpeg 的 h=-2 去推：
    # 1080p 缩到 720 长边时 round(202.5)=202（银行家舍入）→ 404，而 ffmpeg 把 405 对齐到
    # 偶数 → 406。rawvideo 是按 per = ow*oh*3 手工切帧的，每帧差 2 行就会逐帧累积漂移
    # （15 帧 ≈ 30 行），表现为画面在 Y 轴上越跑越偏。竖屏（高 > 宽）封顶的是高，一律按
    # w= 写会把竖屏宽度顶到 720、高度涨到 720 以上，同样对不上。
    sw, sh = int(probe.get('width') or 0), int(probe.get('height') or 0)
    src_fps = float(probe.get('fps') or 0)
    start_src, need = 0, 0
    if src_fps > 0:
        # 本段首帧在**源文件里的帧号**，以及本段要用到的源帧数。
        # need 必须由首尾两个帧号相减得到，不能用 (n-1)×src_fps/pf 直接算 ——
        # start_f×src_fps/pf 的小数部分会把它整体推后一帧（25fps 源配 30fps 工程时
        # 每段都要多解一帧才够，否则段尾少一帧）。
        start_src = int(start_f * src_fps / pf + 1e-6)
        last_src = int((start_f + n - 1) * src_fps / pf + 1e-6)
        need = last_src - start_src + 1
    # 源帧率比工程帧率高太多时（>8×）按源速解码的帧数会爆掉，退回 fps 滤镜那条路。
    by_index = src_fps > 0 and need <= max(8 * n + 8, 600)
    ow, oh = _vid_work_size(sw, sh, int(work_n or (need if by_index else n)))
    if ow > 0 and oh > 0:
        scale = f"scale=w={ow}:h={oh}"
    else:
        scale = f"scale=w=min({_VID_FRAME_MAX_W}\\,iw):h=-2"
    if by_index:
        # **按源帧号取帧**：输出第 k 帧 = 源第 floor((start_f+k)×src_fps/pf) 帧。
        # 段与段之间因此是按源帧号的硬分界 —— 上一段最后一帧恰好是下一段首帧的前一帧。
        # 不能交给 ffmpeg 的 fps 滤镜"就近取帧"：它会在接缝处把下一段的首帧提前取进
        # 上一段（源 25fps / 29.97fps 配 30fps 工程时每段交界处一帧重复，播放就是一顿）。
        # seek 落到本段首帧上、再往前 0.1ms —— 保证这一帧不会因"seek 点之前"被丢掉。
        # -ss 相对文件起点计（含 container start_time），所以只用帧号/源帧率即可。
        seek = max(0.0, start_src / src_fps - 1e-4)
        cmd = [ff, '-v', 'error', '-ss', f'{seek:.6f}', '-i', path,
               '-vf', f'{scale},format=rgb24', '-frames:v', str(need), '-f', 'rawvideo', '-']
    else:
        # 兜底（量不到源帧率 / 帧率比过大）：fps = n/t，让 ffmpeg 把 n 张铺到整个区间上。
        vf = f'fps={n / t:.4f},{scale},format=rgb24'
        # seek 点按微秒**向下**截断，不能按毫秒四舍五入：段起点常是 k/fps 这类无限小数
        # （如 32/30 = 1.066666…），四舍五入成 1.067 会越过源帧 32 的时间戳 1.066667，
        # ffmpeg 把这帧当"seek 点之前"丢掉；下一段的起点仍按名义网格算，于是又从同一帧
        # 开始取 —— 接缝处一帧重复、同时上一段末尾少一帧（32→33→…→48 与下一段 48 起）。
        # 向下截到微秒只让 seek 点落在边界帧上或之前 <1µs，远小于任意帧间隔
        # （120fps 也有 8.3ms），不会多带前一帧。
        ss_eff = int(ss * 1e6) / 1e6
        cmd = [ff, '-v', 'error', '-ss', f'{ss_eff:.6f}', '-t', f'{t:.6f}', '-i', path,
               '-vf', vf, '-frames:v', str(n), '-f', 'rawvideo', '-']
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=300)
    except Exception:
        return None
    if r.returncode != 0 or not r.stdout:
        return None
    raw = r.stdout
    if ow > 0 and oh > 0:
        per = ow * oh * 3
        got = len(raw) // per
        if got <= 0:
            return None
        h, w = oh, ow
    else:
        # 量不到源尺寸（ffprobe 没给宽高）：按总字节反推最接近的帧数因子。
        per = None
        for guess in range(need if by_index else n, 0, -1):
            if len(raw) % (guess * 3) == 0:
                cand = len(raw) // (guess * 3)
                sq = int(cand ** 0.5)
                if sq * sq == cand:
                    per, got, h, w = cand, guess, sq, sq
                    break
        if per is None:
            return None
    arr = np.frombuffer(raw[:got * per], dtype=np.uint8).reshape(got, h, w, 3)
    if by_index:
        frames = []
        for k in range(n):
            local = int((start_f + k) * src_fps / pf + 1e-6) - start_src
            if local < 0 or local >= got:
                break
            frames.append(torch.from_numpy(arr[local:local + 1].astype(np.float32) / 255.0))
        if not frames:
            return None
        print(f'[VidFrames] {os.path.basename(path)} f0={start_f} n={n} '
              f'src={src_fps:.3f}fps srcFrames={start_src}..{last_src} → {len(frames)}/{n} frames {w}x{h}')
        return frames
    frames = [torch.from_numpy(arr[i:i + 1].astype(np.float32) / 255.0) for i in range(got)]
    print(f'[VidFrames] {os.path.basename(path)} ss={ss:.2f} t={t:.2f} → {got} frames {w}x{h}')
    return frames


def _vid_frames_of(val):
    """一枚 IMAGE/MASK 结果 → **逐帧** list。

    图片口的生成器有两种吐法：一颗 `[B,H,W,C]`（一批帧叠在一张 tensor 上，ComfyUI 的
    IMAGE 就是它）或 list 模式下每帧一枚 `[H,W,C]`。编码只认逐帧，所以这里统一拆开 ——
    其余形状（裸 `[H,W]` 的 mask）原样当一帧。
    """
    if val is None:
        return []
    if isinstance(val, (list, tuple)):
        out = []
        for v in val:
            out.extend(_vid_frames_of(v))
        return out
    shp = getattr(val, 'shape', None)
    if shp is None or len(shp) <= 3:
        return [val]
    try:
        return [val[k] for k in range(int(shp[0]))]
    except Exception:
        return [val]


def _vid_encode(frames, fps=30, name='proc'):
    """把一列 [1,H,W,3]（或 [1,H,W] mask）float tensor 编码成一段 H.264 mp4。

    尺寸不齐（处理器每帧吐了不同大小）时统一缩到第一帧的尺寸 —— rawvideo 管道要求
    每帧字节数一致。mask 列走灰度（三通道同值），出来的片段在时间线上按亮度读。
    落盘在资产媒体库（与 _vid_ingest 同一处），返回持久 URL 或 None。
    """
    ff = _ff_bin('ffmpeg')
    if not ff or not frames:
        return None
    try:
        fps = max(1.0, min(120.0, float(fps or 30)))
    except (TypeError, ValueError):
        fps = 30.0

    def _hw_c(frame):
        """帧 → (H, W)。

        **别按维数一刀切**：管线吐出来的是单帧 `[H,W,3]` / `[H,W,1]`（`batch_out[k]` 之后
        就是 3 维），而 `_rgb` 读的也是 `[H,W,C]`；老的 `(shp[-2], shp[-1])` 假设的是
        `[C,H,W]`，对 `[404,720,3]` 会算成 `720x3` —— ffmpeg 拿 3 像素宽去开 libx264
        （yuv420p 要求偶数宽高）当场退出，整个视频编码返回 None（video 模式最后那句
        "Encoding the result to mp4 failed" 就是它）。所以 3 维按"最后一维是不是通道数"判。
        """
        shp = getattr(frame, 'shape', None)
        if shp is None:
            return None
        n = len(shp)
        if n == 4:                       # [B,H,W,C] / [B,C,H,W]：倒数第三、第二都是 H,W
            return (int(shp[-3]), int(shp[-2]))
        if n == 3:                       # [H,W,C]（主）或 [C,H,W]（少量调用方）
            if int(shp[-1]) in (1, 3, 4):
                return (int(shp[0]), int(shp[1]))
            return (int(shp[1]), int(shp[2]))
        if n == 2:                       # 裸 mask [H,W]
            return (int(shp[0]), int(shp[1]))
        return None

    def _rgb(frame, size):
        a = frame.detach().cpu().numpy() if hasattr(frame, 'detach') else np.asarray(frame)
        while a.ndim > 3 and a.shape[-1] == 1:
            a = a[..., 0]
        if a.ndim == 2:
            a = a[None, ..., None]
        if a.ndim == 3:                       # [H,W,C] → 补 batch
            a = a[None, ...]
        a = a[0]
        if a.shape[-1] == 1:                  # mask → 灰度三通道
            a = np.repeat(a, 3, axis=-1)
        elif a.shape[-1] == 4:
            a = a[..., :3]
        h, w = size
        if a.shape[0] != h or a.shape[1] != w:
            im = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)).resize((w, h), Image.LANCZOS)
            a = np.asarray(im).astype(np.float32) / 255.0
        return (np.clip(a, 0, 1) * 255).astype(np.uint8)

    first = _hw_c(frames[0])
    if first is None:
        return None
    h, w = first
    # libx264 + yuv420p 要求偶数宽高：奇数尺寸（链上几何块会算出 1179、825 这种）
    # 直接开编会以 "width not divisible by 2" 退出。统一砍到偶数，缩放交给 _rgb。
    h -= h % 2
    w -= w % 2
    if h < 2 or w < 2:
        print(f'[VidEncode] refusing to encode a {w}x{h} frame')
        return None
    d = _vid_media_dir()
    os.makedirs(d, exist_ok=True)
    stem = re.sub(r'[^\w\-. ]+', '_', str(name or 'proc'))[:60] or 'proc'
    # 指纹必须含内容，而且要覆盖**整幅画面**：只采几帧左上角 16x16 的话，固定机位/
    # 纯色背景的片子角上整段都不变，同 preset、同帧数的相邻两段会撞成同一个文件名
    # —— 第二段直接命中第一段的 mp4，回放看起来就是"每一段都是同一批帧/接缝重复"。
    # （实测 vector.mp4 的左上角 16x16 全片一模一样。）这里每帧按整幅画面隔行隔列
    # 采样到约 256×256 再入 hash：角、边缘、主体都参与，成本远低于编码本身。
    # v2 前缀同时把旧版本算出来的缓存键整体作废，避免继续复用有问题的旧产物。
    _fp = hashlib.sha1(f'v2|{stem}|{len(frames)}|{fps:.3f}|{h}x{w}|crf{_VID_CRF}|{_VID_PRESET}'.encode('utf-8'))
    _st = max(1, int(max(h, w) / 256))
    for _f in frames:
        try:
            _a = _rgb(_f, (h, w))
            _fp.update(np.ascontiguousarray(_a[::_st, ::_st]).tobytes())
        except Exception:
            pass
    h16 = _fp.hexdigest()[:12]
    out = os.path.join(d, f'{h16}_{stem}.mp4')
    if os.path.exists(out):
        return '/api/vid_media/' + os.path.basename(out)
    cmd = [ff, '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
           '-s', f'{w}x{h}', '-r', f'{fps:.3f}', '-i', '-',
           '-c:v', 'libx264', '-preset', _VID_PRESET, '-crf', str(_VID_CRF),
           '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]
    proc = None
    try:
        # stderr 收进管道而不是丢掉：失败时要能说出原因（原来 DEVNULL + 只返回 None，
        # 上层只有一句 "check the ComfyUI console"，而 console 里什么都没有）。
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                stderr=subprocess.PIPE)
        for fr in frames:
            proc.stdin.write(_rgb(fr, (h, w)).tobytes())
        proc.stdin.close()
        # 先等退出再读 stderr：反过来的话一个卡死的 ffmpeg 会让 read 无限等，
        # 而 wait 有超时兜底（超时走 except，进程被杀掉、错误照样打出来）。
        rc = proc.wait(timeout=600)
        err = proc.stderr.read()
        if rc != 0 or not os.path.exists(out):
            msg = (err or b'').decode('utf-8', 'replace').strip().replace('\n', ' | ')
            print(f'[VidEncode] ffmpeg failed rc={rc} {w}x{h} {len(frames)} frames: '
                  f'{msg[:400] or "(no stderr)"}')
            return None
    except Exception as e:
        try:
            proc.kill()
        except Exception:
            pass
        print(f'[VidEncode] encode threw: {type(e).__name__}: {e}')
        return None
    print(f'[VidEncode] {len(frames)} frames {w}x{h}@{fps:.0f}fps → {os.path.basename(out)}')
    return '/api/vid_media/' + os.path.basename(out)


def _vid_publish(val, name='vgen', want_fps=None):
    """把一枚 **VIDEO 产物**搬进视频媒体库，返回 (url, frames, fps) 或 (None, 0, 0)。

    `val` 是生成器自己吐出来的 VIDEO 对象（VideoFromFile / VideoFromComponents 都是它）：
    它的字节可能躺在 videocache 里的一份临时文件上，也可能是一段内存流（BytesIO）——
    两种都得先落成一个**持久**文件，时间线上那段刷新之后才还播得出来。落点照 `_vid_encode`
    那一套（media/vid，按内容指纹命名 —— 同内容复用同一份，重跑不会堆一摞副本）。

    `want_fps`（Fixed FPS 那颗开关带来的目标帧率）给了就顺手把容器的帧率钉死：
    生成器的帧数已经是 duration × fps，差的是"说好 24fps、出来 23.976"这半帧 ——
    段长按 fps 折算时长，差半帧就是差几十毫秒，段与段之间会挤出缝。
    """
    try:
        src = val.get_stream_source() if hasattr(val, 'get_stream_source') else val
    except Exception as e:
        print(f'[VidPublish] cannot read the VIDEO object: {type(e).__name__}: {e}')
        return (None, 0, 0.0)
    if hasattr(src, 'read'):                      # 内存流：先落盘再谈其余（ffmpeg 也只认路径）
        try:
            from ...libs.video_transform import video_stream_to_file
            src = video_stream_to_file(src)
        except Exception as e:
            print(f'[VidPublish] cannot spill the video stream to disk: {type(e).__name__}: {e}')
            return (None, 0, 0.0)
    try:
        src = os.fspath(src)
    except TypeError:
        print('[VidPublish] VIDEO object carries no usable path')
        return (None, 0, 0.0)
    if not src or not os.path.exists(src):
        print(f'[VidPublish] video file is gone: {src}')
        return (None, 0, 0.0)

    d = _vid_media_dir()
    os.makedirs(d, exist_ok=True)
    stem = re.sub(r'[^\w\-. ]+', '_', str(name or 'vgen'))[:60] or 'vgen'
    # 指纹 = 文件内容的哈希（生成器每次吐的文件名可能一样、内容不同，按名会撞）。
    try:
        with open(src, 'rb') as fh:
            _h = hashlib.sha1()
            for chunk in iter(lambda: fh.read(1 << 20), b''):
                _h.update(chunk)
        h16 = _h.hexdigest()[:16]
    except Exception:
        h16 = 'vgen'
    out = os.path.join(d, f'{h16}_{stem}.mp4')
    try:
        if os.path.abspath(src) != os.path.abspath(out):
            shutil.copyfile(src, out)
    except Exception as e:
        print(f'[VidPublish] copy failed: {type(e).__name__}: {e}')
        return (None, 0, 0.0)

    # Fixed FPS：目标帧率给了、且实际帧率对不上（容差 0.01fps）就重编码一次钉死它。
    try:
        meta = get_video_metadata(out)
        frames = int(meta.get('frame_count') or 0)
        fps = float(meta.get('fps') or 0)
    except Exception as e:
        print(f'[VidPublish] probe failed ({e}) — keeping the file as-is')
        return ('/api/vid_media/' + os.path.basename(out), 0, 0.0)
    try:
        want = float(want_fps) if want_fps is not None else 0.0
    except (TypeError, ValueError):
        want = 0.0
    if want > 0 and fps > 0 and abs(fps - want) > 0.01:
        ff = _ff_bin('ffmpeg')
        fixed = os.path.join(d, f'{h16}_{stem}_fps{int(round(want))}.mp4')
        if ff and not os.path.exists(fixed):
            cmd = [ff, '-v', 'error', '-y', '-i', out, '-c:v', 'libx264',
                   '-preset', _VID_PRESET, '-crf', str(_VID_CRF),
                   '-vf', f'fps={want:.6f}', '-pix_fmt', 'yuv420p',
                   '-movflags', '+faststart', fixed]
            try:
                rc = subprocess.run(cmd, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.PIPE, timeout=900).returncode
                if rc == 0 and os.path.exists(fixed):
                    out = fixed
                    fps = want
                    print(f'[VidPublish] re-stamped to {fps:.3f}fps → {os.path.basename(out)}')
                else:
                    print(f'[VidPublish] fps re-stamp failed rc={rc} — keeping {fps:.3f}fps')
            except Exception as e:
                print(f'[VidPublish] fps re-stamp threw: {type(e).__name__}: {e}')
    print(f'[VidPublish] {os.path.basename(out)} — {frames} frames @ {fps:.3f}fps')
    return ('/api/vid_media/' + os.path.basename(out), frames, fps)


def _vid_ingest(raw, name):
    """入库主体。`raw` = 文件字节，`name` = 原文件名（只取盘名和扩展名）。
    返回 {'ok': True, src, name, duration, hasAudio, audioOnly, transcoded} 或 {'ok': False, error}。"""
    if not raw:
        return {'ok': False, 'error': 'empty upload'}
    ff = _ff_bin('ffmpeg')
    fp = _ff_bin('ffprobe')
    if not ff or not fp:
        return {'ok': False, 'error': 'ffmpeg not available on the server'}
    base = os.path.basename(name or 'media').strip() or 'media'
    stem, ext = os.path.splitext(base)
    ext = ext.lower() or '.mp4'
    stem = re.sub(r'[^\w\-. ]+', '_', stem)[:60] or 'media'
    d = _vid_media_dir()
    os.makedirs(d, exist_ok=True)
    # A5：原件按内容进资产仓库（`<md5>.<ext>`），media/vid 只剩派生缓存（波形/抽帧/merge 产物）。
    # `src` 仍返回 `/api/vid_media/<file>` —— 那是 URL 面，不是落点；`/api/vid_media/` 现在
    # 经 `_vid_media_path` 落到仓库。老 .cud 里那些 `sha1_名字.mp4` 也照旧在 media/vid 里活着。
    rec = asset_store.put_bytes(raw, name=base, origin='vid-ingest')
    if not rec:
        return {'ok': False, 'error': 'asset store refused the bytes'}
    # 非库成员的 put_bytes 不落元数据行，清单只能读到哈希文件名。用户拖进来的片子得有个
    # 认得出的名字（`Rabbit Dance_.mp4`），所以这里补一行：只写名字/来源，member 仍是 False。
    # 同字节已经在库、而且用户已经给它起过名 → 一个字都不动（拖一次文件不改别人的名字）。
    _cur = asset_store.get(rec['id']) or {}
    if not _cur.get('inLibrary') and _cur.get('name') in (None, _cur.get('file')):
        asset_store.update_meta(rec['id'], name=base, meta={'origin': 'vid-ingest'})
    inbox = os.path.join(asset_store.asset_dir(), rec['file'])
    probe = _vid_ffprobe(inbox)
    if probe is None or (not probe['vcodec'] and not probe['acodec']):
        return {'ok': False, 'error': 'not decodable media (ffprobe found no streams)'}
    audio_only = not probe['vcodec']
    src = inbox
    proxy = None
    transcoded = False
    if not audio_only and not _vid_browser_ok(ext, probe):
        # 代理片也是一份字节：先落临时文件给 ffmpeg，再整份进仓库（同一份代理只存一次）。
        tmp_out = os.path.join(d, f'_tmp_{rec["id"][:16]}_proxy.mp4')
        try:
            r = subprocess.run(
                [ff, '-y', '-i', inbox, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', str(_VID_CRF),
                 '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', tmp_out],
                capture_output=True, timeout=600)
            if r.returncode != 0 or not os.path.exists(tmp_out):
                tail = r.stderr.decode('utf-8', 'replace')[-300:] if r.stderr else 'unknown'
                return {'ok': False, 'error': 'transcode failed: ' + tail}
            with open(tmp_out, 'rb') as f:
                praw = f.read()
            prec = asset_store.put_bytes(praw, name=f'{stem}_proxy.mp4', origin='vid-proxy')
            if not prec:
                return {'ok': False, 'error': 'asset store refused the proxy'}
            # 代理是**派生件**：记一笔"我是谁的代理"，清单据此把两张卡并成一张（原件那张
            # 带 playHash），GC 也据此知道两个哈希是同一件货的两份字节。
            asset_store.update_meta(prec['id'], name=f'{stem}_proxy.mp4',
                                    meta={'proxyOf': rec['id'], 'origin': 'vid-proxy'})
            src = os.path.join(asset_store.asset_dir(), prec['file'])
            proxy = prec['id']
            transcoded = True
        finally:
            try:
                if os.path.isfile(tmp_out):
                    os.remove(tmp_out)
            except OSError:
                pass
    previews = _vid_previews(src, probe, d)
    return {'ok': True,
            'src': '/api/vid_media/' + os.path.basename(src),
            'asset': rec['id'],
            'proxy': proxy,
            'name': base,
            'duration': probe['duration'],
            'hasAudio': bool(probe['acodec']),
            'audioOnly': audio_only,
            'transcoded': transcoded,
            'waveform': previews.get('waveform')}


def _vid_merge(parts, name='merged'):
    """把时间线上几段视频按顺序拼成一条新文件（POST /api/vid_merge）。

    `parts` = [{'f': '/api/vid_media/xxx.mp4', 'in': 0.0, 'out': 3.2}, ...] —— f 是媒体库 URL，
    in/out 是这一段在源文件里的起止秒。先试 concat demuxer 流拷贝（快、不损画质）；拼不动
    （编码/尺寸/帧率不一致，或入出点落在关键帧缝里）再退到 concat 滤镜重编码，统一到第一段的
    尺寸/帧率。输出落在资产媒体库，文件名按文件身份 + 入出点哈希缓存 —— 同样的拼接第二次
    直接命中，不会重复写盘。
    """
    ff = _ff_bin('ffmpeg')
    fp = _ff_bin('ffprobe')
    if not ff or not fp:
        return {'ok': False, 'error': 'ffmpeg not available on the server'}
    if not isinstance(parts, list) or len(parts) < 2:
        return {'ok': False, 'error': 'need at least two parts'}
    # 片段/资产名不带扩展名：时间线上显示的是逻辑名，扩展名由 src 决定。
    nm = os.path.splitext(os.path.basename(str(name or 'merged')))[0] or 'merged'
    d = _vid_media_dir()
    paths, spans = [], []
    for i, pt in enumerate(parts):
        if not isinstance(pt, dict):
            return {'ok': False, 'error': f'part {i} is not an object'}
        raw = str(pt.get('f') or '')
        path = _vid_media_path(raw)
        if not path or not os.path.isfile(path):
            return {'ok': False, 'error': f'part {i}: media file not found'}
        try:
            a = max(0.0, float(pt.get('in') or 0))
            b = float(pt.get('out'))
        except (TypeError, ValueError):
            return {'ok': False, 'error': f'part {i}: bad in/out'}
        if not (b > a):
            return {'ok': False, 'error': f'part {i}: out must be greater than in'}
        paths.append(path)
        spans.append((a, b))
    # 缓存键：文件身份（大小 + mtime_ns，同名重写也会换 key）+ 入出点 + 版本前缀。
    h = hashlib.sha1(b'merge-v1')
    for path, (a, b) in zip(paths, spans):
        try:
            st = os.stat(path)
        except OSError:
            return {'ok': False, 'error': 'media file disappeared'}
        h.update(f'{os.path.basename(path)}|{st.st_size}|{st.st_mtime_ns}|{a:.6f}|{b:.6f}\n'.encode('utf-8'))
    out = os.path.join(d, f'merge_{h.hexdigest()[:16]}.mp4')
    if os.path.isfile(out):
        probe = _vid_ffprobe(out)
        if probe is not None:
            return {'ok': True, 'src': '/api/vid_media/' + os.path.basename(out),
                    'name': nm,
                    'duration': probe['duration'] or sum(b - a for a, b in spans),
                    'hasAudio': bool(probe['acodec'])}
    os.makedirs(d, exist_ok=True)
    tmp = out + f'.{os.getpid()}.part.mp4'
    listing = out + f'.{os.getpid()}.txt'

    def _q(p):
        return "'" + p.replace("'", "'\\''") + "'"

    try:
        with open(listing, 'w', encoding='utf-8') as f:
            for path, (a, b) in zip(paths, spans):
                f.write(f'file {_q(path)}\n')
                f.write(f'inpoint {a:.6f}\n')
                f.write(f'outpoint {b:.6f}\n')
        r = subprocess.run(
            [ff, '-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
             '-i', listing, '-c', 'copy', '-an', '-movflags', '+faststart', tmp],
            capture_output=True, timeout=1800)
        ok = r.returncode == 0 and os.path.isfile(tmp) and os.path.getsize(tmp) > 0
        if not ok:
            # 回退：逐段 -ss/-t 切开，统一缩放/补边/帧率后 concat 重编码。
            probe0 = _vid_ffprobe(paths[0]) or {}
            try:
                w = int(probe0.get('width') or 0)
                hgt = int(probe0.get('height') or 0)
                fps = float(probe0.get('fps') or 0) or 30.0
            except (TypeError, ValueError):
                w, hgt, fps = 0, 0, 30.0
            if w < 2 or hgt < 2:
                return {'ok': False, 'error': 'cannot read the source resolution'}
            w -= w % 2
            hgt -= hgt % 2
            fps = max(1.0, min(120.0, fps))
            cmd = [ff, '-y', '-hide_banner', '-loglevel', 'error']
            for path, (a, b) in zip(paths, spans):
                cmd += ['-ss', f'{a:.6f}', '-t', f'{b - a:.6f}', '-i', path]
            chains = [
                f'[{i}:v]scale={w}:{hgt}:force_original_aspect_ratio=decrease,'
                f'pad={w}:{hgt}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps:.6f}[v{i}]'
                for i in range(len(paths))
            ]
            graph = ';'.join(chains) + ';' + ''.join(f'[v{i}]' for i in range(len(paths))) \
                + f'concat=n={len(paths)}:v=1:a=0[outv]'
            cmd += ['-filter_complex', graph, '-map', '[outv]', '-an',
                    '-c:v', 'libx264', '-preset', _VID_PRESET, '-crf', str(_VID_CRF),
                    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp]
            r = subprocess.run(cmd, capture_output=True, timeout=1800)
            if r.returncode != 0 or not os.path.isfile(tmp) or os.path.getsize(tmp) == 0:
                tail = r.stderr.decode('utf-8', 'replace')[-400:] if r.stderr else 'unknown'
                return {'ok': False, 'error': 'stitch failed: ' + tail}
        os.replace(tmp, out)
    finally:
        for p in (tmp, listing):
            try:
                if os.path.isfile(p):
                    os.remove(p)
            except OSError:
                pass
    probe = _vid_ffprobe(out)
    if probe is None:
        return {'ok': False, 'error': 'stitched file is not decodable'}
    return {'ok': True, 'src': '/api/vid_media/' + os.path.basename(out),
            'name': nm,
            'duration': probe['duration'] or sum(b - a for a, b in spans),
            'hasAudio': bool(probe['acodec'])}


class DocumentIo:
    """原生对话框 + token→绝对路径 登记表，供 MainHandler 的 /api/io_* 四条路由与
    /api/recent_cud 使用。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._tokens = {}            # token -> {'path', 'mime'}
        self._jobs = None            # queue.Queue，常驻线程的任务口
        self._thread = None
        self._tk_checked = False
        self._tk_ok = False

    # ---- 能力 ----
    def available(self):
        """tkinter 是否可用（venv 可能是无 Tk 的精简构建）。只探测一次。"""
        if not self._tk_checked:
            self._tk_checked = True
            try:
                import tkinter                       # noqa: F401
                from tkinter import filedialog       # noqa: F401
                self._tk_ok = True
            except Exception:
                self._tk_ok = False
        return self._tk_ok

    def _ensure_thread(self):
        if self._thread is not None and self._thread.is_alive():
            return True
        q = queue.Queue()
        t = threading.Thread(target=self._worker, args=(q,), daemon=True, name='blend-file-dialog')
        self._jobs = q
        self._thread = t
        t.start()
        return True

    def _worker(self, jobs):
        """唯一持有 Tk root 的线程：逐个取出请求，弹原生对话框，回传结果。"""
        try:
            import tkinter as tk
            root = tk.Tk()
            root.withdraw()                          # 只要对话框，不要一块空白窗体
            try:
                root.attributes('-topmost', True)    # 别让它跑到 ComfyUI 窗口后面
            except Exception:
                pass
        except Exception as e:
            while True:
                job = jobs.get()
                if job is None:
                    return
                _, reply = job
                reply.put(('err', 'tkinter root could not be created: %s' % e))
        while True:
            job = jobs.get()
            if job is None:
                break
            spec, reply = job
            try:
                reply.put(('ok', self._ask(root, **spec)))
            except Exception as e:
                reply.put(('err', str(e)))
        try:
            root.destroy()
        except Exception:
            pass

    @staticmethod
    def _ask(root, mode, kind, suggested, multiple):
        from tkinter import filedialog
        spec = IO_FILE_KINDS.get(kind) or IO_FILE_KINDS['cud']
        if spec.get('folder'):
            # 目录选择：只有一个 askdirectory，没有"保存目录"这回事，suggested 当起始位置。
            # 起始位置必须是真目录 —— Tk 拿到一条不存在的 initialdir 会当场抛，用户就只看到
            # 一句"dialog failed"，明明是要换一条路径。
            extra = {'initialdir': suggested} if suggested and os.path.isdir(suggested) else {}
            path = filedialog.askdirectory(parent=root, title='Choose folder', **extra)
            return [path] if path else []
        filetypes = [(spec['label'], ' '.join(spec['patterns'])), ('All files', '*.*')]
        if mode == 'save':
            path = filedialog.asksaveasfilename(
                parent=root, title='Save as', filetypes=filetypes,
                defaultextension=spec['extension'], initialfile=suggested or '')
            return [path] if path else []
        paths = filedialog.askopenfilename(
            parent=root, title='Open', filetypes=filetypes, multiple=bool(multiple))
        if isinstance(paths, str):
            paths = [paths] if paths else []
        return [p for p in (paths or []) if p]

    # ---- 登记表 ----
    def _document(self, path, kind):
        """把一条真实路径收进登记表，返回前端使用的文档描述。

        mime 由扩展名推断，推断不出（.cud）退回该类别的默认值 —— 前端拿它造 File。
        """
        spec = IO_FILE_KINDS.get(kind) or IO_FILE_KINDS['cud']
        mime = mimetypes.guess_type(path)[0] or spec['mime']
        try:
            size = os.path.getsize(path)
        except OSError:
            size = 0
        abspath = os.path.abspath(path)
        token = uuid.uuid4().hex
        with self._lock:
            self._tokens[token] = {'path': abspath, 'mime': mime, 'size': size}
        return {'token': token, 'name': os.path.basename(abspath), 'path': abspath,
                'size': size, 'mime': mime}

    def resolve(self, token):
        with self._lock:
            entry = self._tokens.get(token or '')
        return entry['path'] if entry else None

    def entry(self, token):
        with self._lock:
            entry = self._tokens.get(token or '')
        return dict(entry) if entry else None

    def forget(self, token):
        with self._lock:
            self._tokens.pop(token or '', None)

    def open_path(self, path, kind='cud'):
        """把一条**早已落袋**的路径收进登记表，返回与对话框同形的文档描述符。

        与 _document 的差别只在入口约束：路径必须确实是该类别的文件且仍在盘上。唯一的调用
        方是时间线帧卡的跳转 —— 那条路径是用户当年从对话框挑进工程的，这里只是把它重新
        mint 成 token 交给工作台的 Load 通道，不新增"页面指定任意路径"的面。
        """
        if not isinstance(path, str) or not path:
            return None
        spec = IO_FILE_KINDS.get(kind) or IO_FILE_KINDS['cud']
        ext = spec.get('extension')
        if ext and not path.lower().endswith(ext):
            return None
        if not os.path.isfile(path):
            return None
        return self._document(path, kind)

    # ---- 最近一份 .cud ----
    def _remember_cud(self, path):
        """把这条路径写成"上次打开的那份文档"。写失败只记账，不影响这次的挑选。"""
        try:
            with open(_workbench_file('recent_cud.json'), 'w', encoding='utf-8') as f:
                json.dump({'path': os.path.abspath(path)}, f, ensure_ascii=False)
        except Exception as e:
            print(f"[SnapshotDetailerSampler] could not record the recent .cud: {e}")

    def reopen_recent_cud(self):
        """把上次那一份 .cud 重新登记成一个文档描述符，无需对话框。

        返回 (doc, reason) 其一为 None。路径只从服务端自己写下的记录里读，页面无从指定；
        描述符与对话框同形（含一个现 mint 的 token），所以前端照旧走 /api/io_read 取字节、
        Save 照旧原地写回同一个文件。
        """
        try:
            with open(_workbench_file('recent_cud.json'), encoding='utf-8') as f:
                recorded = json.load(f)
        except FileNotFoundError:
            return None, 'no .cud has been opened with the file dialog on this machine yet'
        except Exception as e:
            return None, f'the recent-document record could not be read ({e})'
        path = (recorded or {}).get('path') if isinstance(recorded, dict) else None
        if not (isinstance(path, str) and path):
            return None, 'no .cud has been opened with the file dialog on this machine yet'
        if not os.path.isfile(path):
            return None, f'{os.path.basename(path)} is no longer at {path}'
        try:
            return self._document(path, 'cud'), None
        except Exception as e:
            return None, str(e)

    # ---- 会话恢复：这次开着的那批 .cud ----
    def remember_open_cuds(self, paths):
        """把宿主讲报的活动文档集写成"这次会话开着这些"。宿主是唯一作者：它看到的是
        工作台的实时播报（开关文档都会来一趟），比后端自己记账（拿不到"关了"）准。
        写失败只记账，不影响这次运行。"""
        clean = []
        for p in (paths or []):
            if isinstance(p, str) and p:
                clean.append(os.path.abspath(p))
        try:
            with open(_workbench_file('open_cuds.json'), 'w', encoding='utf-8') as f:
                json.dump({'paths': clean}, f, ensure_ascii=False)
        except Exception as e:
            print(f"[SnapshotDetailerSampler] could not record open cuds: {e}")

    def restore_open_cuds(self):
        """把上一次会话开着的那批 .cud 重新登记成文档描述符（顺序 = 当时的打开序）。

        路径只从服务端自己写下的记录里读，页面无从指定；已经不在盘上的跳过。
        描述符与对话框同形（现 mint 的 token），前端照旧走 /api/io_read 取字节。
        """
        try:
            with open(_workbench_file('open_cuds.json'), encoding='utf-8') as f:
                recorded = json.load(f)
        except FileNotFoundError:
            return []
        except Exception as e:
            print(f"[SnapshotDetailerSampler] could not read open cuds: {e}")
            return []
        paths = (recorded or {}).get('paths') if isinstance(recorded, dict) else None
        if not isinstance(paths, list):
            return []
        docs = []
        for p in paths:
            if not (isinstance(p, str) and p and os.path.isfile(p)):
                continue
            try:
                docs.append(self._document(p, 'cud'))
            except Exception as e:
                print(f"[SnapshotDetailerSampler] could not mint descriptor for {p}: {e}")
        return docs

    # ---- 对外三条 ----
    def pick(self, mode, kind, suggested='', multiple=False):
        """弹出原生对话框，返回选中的文档描述列表（用户取消则为空表）。

        每项 {token, name, path, size, mime}：token 之后独占寻址，path/name 只是给读数看的。
        """
        if not self.available():
            return None
        self._ensure_thread()
        reply = queue.Queue()
        self._jobs.put(({'mode': mode, 'kind': kind, 'suggested': suggested or '',
                         'multiple': multiple}, reply))
        status, result = reply.get()
        if status == 'err':
            raise RuntimeError(result)
        if kind == 'folder':
            # 目录没有字节可读，不该进 token 表（那是个"读这份文件"的口）。只回报路径本身。
            return [{'token': '', 'name': os.path.basename(p.rstrip('\\/')) or p,
                     'path': p, 'size': 0, 'mime': ''} for p in (result or []) if p]
        picks = [self._document(p, kind) for p in (result or [])]
        if kind == 'cud' and picks:
            self._remember_cud(picks[0]['path'])
        return picks

    def write(self, token, data):
        """覆盖写回这份文档：先落 .tmp 再 os.replace，中途失败不会把原文练废。"""
        path = self.resolve(token)
        if not path:
            return False, 'unknown document token'
        tmp = path + '.tmp'
        try:
            with open(tmp, 'wb') as f:
                f.write(data)
            os.replace(tmp, path)
        except PermissionError:
            # 最常见的一种失败：文档正被别的程序占着。措辞与前端 stale handle 分支一致。
            try:
                os.remove(tmp)
            except OSError:
                pass
            return False, 'the file is open elsewhere or is read-only'
        except Exception as e:
            try:
                os.remove(tmp)
            except OSError:
                pass
            return False, str(e)
        with self._lock:
            self._tokens[token]['size'] = len(data)
        return True, None

    def read(self, token):
        path = self.resolve(token)
        if not path:
            return None, 'unknown document token'
        try:
            with open(path, 'rb') as f:
                return f.read(), None
        except Exception as e:
            return None, str(e)


doc_io = DocumentIo()


# =============================================================================
# Pipeline Settings（选中项）/ Architecture Settings（按架构正则命中）
# —— 与前端 types.ts 里的字面量一一对应
# =============================================================================
# preset 的 pipeline 绑定只有两类取值：
#   ''                    = [Default]，节点输入口那条 pipeline。它的名字/信息从未被收集过，
#                           所以一旦选过别的 pipeline，前端就把这个选项收起来（无从切回）。
#   PIPELINE_CURRENT_SELECT = [Current Select]，用当前已加载的那一条，不做任何切换。
#   其余字符串            = pipeline 在 /api/pipeline_package 里的名字（重名时取第一个）。
PIPELINE_CURRENT_SELECT = '[Current Select]'
# 架构规则可以覆盖的那九项 —— 与 DEFAULT SETTING 同名同义，区别只是「命中这条架构的规则跑的时候
# 盖掉默认值」，且每一项必须 toggle 开着才生效。
# 后四个（ref_*/tgen_*）是**输入侧上限**：pixels 只许往下压，永不放大。
ARCH_OVERRIDE_KEYS = ('mask_grow', 'mask_blur', 'crop_reserve', 'pixels', 'align',
                      'ref_pixels', 'ref_align', 'tgen_pixels', 'tgen_align')


# =============================================================================
# SnapshotDetailerSamplerServer：前后端交互服务器
# =============================================================================
class SnapshotDetailerSamplerServer:
    """
    事件驱动的交互服务器。不再有固定阶段顺序，前端通过 tab 自由切换。
    后端通过 action queue 接收前端指令（run_detailer / select_image / finish）。
    """

    # DEFAULT SETTING 的唯一一份状态：前端 Settings 页的 Default Setting 改动 → POST /api/update_config
    # → 落盘 data/sampler/blocks_sets.json 的 global_params。每次执行都现读它 —— 节点上没有同名端口，
    # 所以除了这份文件不存在第二个来源，不会出现互相覆盖。
    # ref_* / tgen_* 是输入侧的显存封顶（喂给 ref image / generate text 之前先 limit_pixels
    # 的 cap_only 模式压一刀），0 = 不设上限。
    GLOBAL_PARAM_DEFAULTS = {'pixels': 1048576, 'align': 8, 'crop_reserve': 32,
                             'mask_grow': 32, 'mask_blur': 32,
                             'ref_pixels': 1048576, 'ref_align': 8,
                             'tgen_pixels': 1048576, 'tgen_align': 8}

    def __init__(self, detector, tagger, lora_regex, asset=None, package=None,
                 node_instance=None, unique_id=None, config=None, extra_pnginfo=None, prompt=None):
        self.detector = detector
        self.tagger = tagger
        self.extra_pnginfo = extra_pnginfo
        self.asset = asset
        self.lora_regex = lora_regex
        self.node_instance = node_instance
        self.unique_id = unique_id
        self.packages = []
        self.interface_packages = []
        self.pipeline_packages = []
        if package is not None:
            # Robust flattening: package may be a dict, a list of dicts, or a nested list
            flat = []
            if isinstance(package, dict):
                flat = [package]
            elif isinstance(package, list):
                for p in package:
                    if isinstance(p, dict):
                        flat.append(p)
                    elif isinstance(p, list):
                        flat.extend([x for x in p if isinstance(x, dict)])
            self.packages = flat
            for p in self.packages:
                if p.get("type") == "pipeline":
                    self.pipeline_packages.append(p)
                else:
                    self.interface_packages.append(p)
            print(f"[SnapshotDetailerSampler] package input: type={type(package).__name__}, "
                  f"len={len(package) if isinstance(package, (list, dict)) else 1}, "
                  f"total={len(self.packages)}, interface={len(self.interface_packages)}, pipeline={len(self.pipeline_packages)}")

        cfg = config or {}
        # DEFAULT SETTING 只有一个来源：前端 Settings 页写入的那份落盘文件
        # （改动即 POST → _apply_params → _save_global_params_file）。server 是在 sample()
        # 里现建的，所以每次执行都是现读，取到的就是前端当前的值。节点上不再有这些端口 ——
        # 两处各存一份必然不同步。
        _persisted = self._load_global_params_file()
        for _k, _d in self.GLOBAL_PARAM_DEFAULTS.items():
            try:
                setattr(self, _k, int(_persisted.get(_k, _d)))
            except (TypeError, ValueError):
                setattr(self, _k, _d)

        # Pipeline Block chain (default: single Detailer block with the workbench defaults).
        # 采样参数属于每个 detailer block（工作台 Edit 页），这里只是新建链时的初值。
        self.blocks = cfg.get('blocks')
        if not self.blocks:
            self.blocks = [{
                'id': 'block-1',
                'type': 'detailer',
                'name': 'Detailer',
                'params': {
                    'add_noise': 'enable',
                    'start_step_rate': 0.8,
                    'end_step_rate': 1.0,
                    'pixels': self.pixels,
                    'align': self.align,
                    'crop_reserve': self.crop_reserve,
                    'recover_crop': True,
                    'enable_edit': False,
                    'edit_mode': 'fit',
                    'ref_boost': 4.0,
                    'ref_boost_a': 1.0,
                    'enable_ref_boost_mask': False,
                    'grounding_px': 768,
                },
            }]

        self.tag_result = None

        # Multi-set Pipeline Blocks ("tabs" in the workbench). Legacy configs only carry the flat
        # `blocks` list — migrate it into a single "Default" set so the tab model and the runner's
        # flat chain always agree. `self.blocks` keeps mirroring the ACTIVE set: the runner and
        # the Blend workbench only ever see one chain, the sets are a UI/存储 layer on top.
        self.blocks_sets = cfg.get('blocks_sets')
        if not isinstance(self.blocks_sets, list):
            self.blocks_sets = [{'id': 'set-1', 'name': 'Default', 'blocks': self.blocks}]
        self.active_block_set = cfg.get('active_block_set')
        if self.blocks_sets:
            if not any(s.get('id') == self.active_block_set for s in self.blocks_sets):
                self.active_block_set = self.blocks_sets[0].get('id')
        else:
            self.active_block_set = None
        active_set = next((s for s in self.blocks_sets if s.get('id') == self.active_block_set), None)
        if active_set and active_set.get('blocks'):
            self.blocks = active_set['blocks']
        # Disk persistence: the tab sets survive ComfyUI restarts (the in-memory chain only lives
        # as long as the session). The file wins over the migrated config when it exists.
        f_sets, f_active = self._load_blocks_sets_file()
        if f_sets is not None:
            self.blocks_sets = f_sets
            if f_sets:
                self.active_block_set = f_active if any(s.get('id') == f_active for s in f_sets) else f_sets[0].get('id')
                active_set = next((s for s in self.blocks_sets if s.get('id') == self.active_block_set), None)
                if active_set and active_set.get('blocks'):
                    self.blocks = active_set['blocks']
            else:
                self.active_block_set = None
                self.blocks = []
        # 图镜像：激活 set 若是新格式（带 `graph`）就用它，否则由旧 `blocks` 自动迁移成图。
        # 后端执行引擎按 `self.graph` 跑；`self.blocks` 保留为旧格式镜像（摘要 / 兼容）。
        _active = next((s for s in (self.blocks_sets or [])
                        if s.get('id') == self.active_block_set), None)
        self.graph = graph_from_config(_active) if _active else None
        if self.graph is None:
            self.graph = blocks_to_graph(self.blocks or [])
        # Pipeline Settings：选中的 pipeline 名字（`overrides` 是旧版按名字存的那份，原样保留、
        # 无人再读）。与 blocks_sets 同路（config 只是初值，落盘文件赢）—— 同样是纯 UI 状态。
        self.pipeline_settings = self._normalize_pipeline_settings(cfg.get('pipeline_settings'))
        _f_ps = self._load_pipeline_settings_file()
        if _f_ps is not None:
            self.pipeline_settings = _f_ps
        # Architecture Settings：按 pipeline architecture 正则命中的覆盖规则（Settings tab）。
        # 顺序 = 优先级，所以整份列表就是状态本身。
        self.arch_settings = self._normalize_arch_settings(cfg.get('arch_settings'))
        _f_arch = self._load_arch_settings_file()
        if _f_arch is not None:
            self.arch_settings = _f_arch
        # Interface meta：Interface tab 里给每个 interface 配置的东西 —— 端口改名、
        # block/processor 模式开关、block 模式的两个端口绑定。接口包本身每次从工作流
        # 图现推导、不可持久化，所以这些「贴在包上的标注」按包名字单独落盘。
        self.interface_meta = self._normalize_interface_meta(cfg.get('interface_meta'))
        _f_im = self._load_interface_meta_file()
        if _f_im is not None:
            self.interface_meta = _f_im
        # 当前真的加载在 node 上的是哪条 pipeline（'' = 节点输入口那条 = [Default]）。
        # server 每次节点执行都是新建的，所以这份身份天然随执行复位，不需要额外清理。
        self.loaded_pipeline_node_id = ''
        self.loaded_pipeline_name = ''
        # lora_regex 换过几代的记账。Prompt tab 那张 LoRA 卡的灰名单是从 prompt server 拉的这份
        # regex，服务端重扫（update_lora_regex）浏览器是看不见的，所以代数只在 regex 真的变了时才
        # +1：手动切换与 run 循环里 preset 绑定共用这一处，宿主页拿它判断那份 UI 是不是脏了。
        self.pipeline_lora_epoch = 0
        self.detail_status = 'idle'
        self.detail_error = None
        self.detail_progress = 0       # 0..1
        self.detail_total_steps = 0
        self.detail_current_step = 0
        self.interface_status = 'idle'
        self.interface_error = None
        self.interface_progress = 0
        self.interface_total_steps = 0
        self.interface_current_step = 0
        self.interface_result_meta = []   # 离线 processor 执行的结果明细（key/port/type/name）
        # 视频模式的 Pipeline Preset 跑（逐帧过 block 链 → 编码回一段视频）。与 interface_*
        # 平行的一套状态：前端按 preset_video_status 轮询，别和 processor 抢同一组字段
        # （两条路可能先后跑，语义混在一起排查时看不出是谁在动）。
        self.preset_video_status = 'idle'
        self.preset_video_error = None
        self.preset_video_progress = 0
        self.preset_video_current = 0
        self.preset_video_total = 0
        self.preset_video_meta = []
        self.finished = False
        self.finish_selected_key = None
        self.finish_selected_keys = None  # 多选 keys 列表
        self.window_closed = False

        # 工作区（staging）：唯一的图池。拖进来的文件、run 初始图、接口/Blend/Run 结果
        # 都落在这里；detailer 的 Ref Image、接口端口图/掩码都引用这里的条目。
        # 图层不再绑定条目 id —— 图层自带像素（见 blend_node.html），这里只存「可复用的图」。
        self.staging_items = []
        self._staging_tensors = {}  # id → tensor (原始引用，避免 base64 往返)
        self._staging_counter = 0

        # 最新结果
        self.original_image = None
        self.detailed_image = None
        self.original_key = None   # staging id of the original image
        self.detailed_key = None   # staging id of the detailed image

        # Blend 工作台（Draw tab）：画布合成图就是 Context Image，
        # 合成结果 + 纯 Mask 层随 blend_action 一次性送达，不再走 history key 切换。
        self.blend_image = None
        self.blend_mask = None
        self.blend_prompt = ''
        # 逐 run 的 pipeline preset 选择（blocks_sets 里某一 set 的 id）。
        # 由「图层右键 → Generate」的 enum 下发；主循环取用后立即清空，避免污染下一次普通 Run。
        self.pending_generate_preset = None

        # Query 块：run 到它时链条停在这里等用户在弹窗里挑 prompt。run 循环阻塞在
        # pending_query['event'] 上；前端轮询 /api/status 看到 pending_query 就弹窗，
        # 回答 POST 到 /api/query_answer 唤醒。None = 当前没有块在等。
        self.pending_query = None
        # 一个 Query 块等多久（秒）。超时按用户的选择 = 中止整条链。
        self.query_timeout = 600

        # Enable Output 的两处记账（每次 run 开头清空，链跑完由 _save_run_output_png 读回）：
        # last_effective_prompt_selection = 这次真正生效的合并选择（prompt / query 块在
        # _resolve_prompt_selection 出口暂存；链里没有这类块时保持 None，落盘回落到 prompt
        # 节点全局）；last_clip_positive = 最后一个 detailer 块真正送进 CLIP 的串；
        # last_output_positive = 同一刻的「纯用户选择」——不掺 pipeline context 的 prompt、
        # 不掺 lora 触发词（触发词由 'lora' 键的 active_tags 自己提供，读回不重复）。
        self.last_effective_prompt_selection = None
        self.last_clip_positive = ''
        self.last_output_positive = ''

        # Interface 执行结果 keys（最近一次）
        self.interface_result_keys = []

        # 子服务器
        self.prompt_server = None
        self.main_server = None
        self.main_port = None
        self.prompt_url = ""
        self.browser_url = ""
        self.started = False

        # 事件驱动：前端发送 action，主循环等待并处理
        self._action_queue = queue.Queue()
        self._action_event = threading.Event()

    # -------------------------------------------------------------------------
    # 生命周期
    # -------------------------------------------------------------------------
    def start(self):
        # 1) Prompt server
        if SnapshotPromptServer is None:
            raise RuntimeError("SnapshotPromptServer not available")
        self.prompt_server = SnapshotPromptServer(
            port=None,
            last_selected=[],
            lora_regex=self.lora_regex,
            last_selected_loras=[],
            last_selected_prefabs=[],
        )
        self.prompt_server.lora_path_mode = True
        self.prompt_server.tagger = self.tagger
        self.prompt_server.asset = self.asset
        t_prompt = threading.Thread(target=self.prompt_server.start)
        t_prompt.daemon = True
        t_prompt.start()

        t0 = time.time()
        while not self.prompt_server.started:
            if time.time() - t0 > 10:
                raise RuntimeError("[SnapshotDetailerSampler] Prompt server startup timeout")
            time.sleep(0.01)

        self.prompt_url = self.prompt_server.browser_url

        # 2) Main server
        class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True  # server_close() must not join handlers stuck in sendall
            # 默认 backlog 只有 5：拖动预览这类**成串**的短请求会把 accept 队列塞满，
            # 其他接口（/api/global_assets 等）会直接连不上、前端看到 "did not answer"。
            # 线程模型本身能并发，排队长一点即可；真正重的抽帧请求由前端去抖。
            request_queue_size = 64
        for port in range(8700, 8800):
            try:
                self.main_server = ThreadedHTTPServer(
                    ('localhost', port), self.MainHandler
                )
                self.main_port = port
                self.started = True
                break
            except Exception:
                continue

        if not self.started:
            raise RuntimeError("[SnapshotDetailerSampler] Main server startup failed")

        # 页面一律走 127.0.0.1:Agent dock 的 DSH 窗 iframe 的是 127.0.0.1:<dsh_port>,而 dsh 的鉴权
        # cookie 是 SameSite=Strict + 绑定 authority=127.0.0.1:<port>。页面若在 localhost,它就成了
        # 跨站祖先 —— 浏览器不发 Strict cookie,iframe 只会显示 401。同站是嵌入的前置条件。
        self.browser_url = f"http://127.0.0.1:{self.main_port}/sampler_node.html"
        self.MainHandler.server_instance = self

        print(f"[SnapshotDetailerSampler] Main server on {self.main_port}")
        print(f"[SnapshotDetailerSampler] Prompt server at {self.prompt_url}")

        t_main = threading.Thread(target=self.main_server.serve_forever)
        t_main.daemon = True
        t_main.start()

    def stop(self):
        print("[SnapshotDetailerSampler] stop() called")
        def _stop(server, name):
            if server:
                try:
                    print(f"[SnapshotDetailerSampler] Stopping {name}...")
                    server.stop()
                    print(f"[SnapshotDetailerSampler] {name} stopped.")
                except Exception as e:
                    print(f"[SnapshotDetailerSampler] Error stopping {name}: {e}")
        threads = []
        for s, name in [(self.prompt_server, 'prompt_server')]:
            t = threading.Thread(target=_stop, args=(s, name))
            t.daemon = True
            t.start()
            threads.append(t)
        print("[SnapshotDetailerSampler] Stopping main_server...")
        if self.main_server:
            try:
                self.main_server.shutdown()
                self.main_server.server_close()
            except Exception as e:
                print(f"[SnapshotDetailerSampler] Error stopping main_server: {e}")
        print("[SnapshotDetailerSampler] main_server stopped.")
        for t in threads:
            t.join(timeout=2.0)
        print("[SnapshotDetailerSampler] All servers stopped.")

    # -------------------------------------------------------------------------
    # 事件驱动
    # -------------------------------------------------------------------------
    def put_action(self, action, **kwargs):
        """前端通过 HTTP handler 调用，向队列中放入一个 action。"""
        self._action_queue.put({'action': action, **kwargs})
        self._action_event.set()

    def wait_for_action(self):
        """主循环等待下一个 action。"""
        # Check queue first — action may have been queued while we were busy
        if not self._action_queue.empty():
            return self._action_queue.get()
        self._action_event.clear()
        while not self._action_event.is_set():
            if mm.processing_interrupted():
                return None
            if self.window_closed:
                return None
            self._action_event.wait(0.05)
        # Check queue again after event was set
        if not self._action_queue.empty():
            return self._action_queue.get()
        return None

    # -------------------------------------------------------------------------
    # 历史画廊
    # -------------------------------------------------------------------------
    def add_staging(self, image, name=None, place=None, hidden=False, sid=None):
        """添加一张图到工作区。保留 tensor 引用以避免 base64 往返。

        hidden=True 的条目只作内部引用（seed 画布的 Original、run/接口的产出图），
        不进工作区条带 —— 条带只展示用户主动拖入/导入的图。宿主按此字段过滤镜像。

        place 只有「Recover Crop 关闭」的 detailer run 会提供：归一化的放置矩形
        (x, y, w, h, ow, oh)。此时 image 是 RGBA —— alpha 就是 crop 工作区的 mask，
        图层自带的 alpha 承担裁剪，所以条目不需要额外的 mask 字段。前端据此把
        它作为一个新图层贴回原位，而不是由后端合成。

        sid 钉住条目 id，不再另起一个计数器号：Guidance 卡靠它在工作区里永远只占
        一格，重发布时原地换像素（顺序、位置都不变），而不是越积越多。
        """
        if sid is None:
            self._staging_counter += 1
            sid = f'staging_{self._staging_counter}'
        # 记录尺寸供前端展示
        h, w = 0, 0
        if image is not None and hasattr(image, 'shape'):
            shp = image.shape
            if len(shp) == 4:
                h, w = shp[1], shp[2]
            elif len(shp) == 3:
                h, w = shp[0], shp[1]
        # 保留 tensor 引用
        self._staging_tensors[sid] = image
        # 字节进仓库（A2）：图池不再"只活在内存里" —— 每一张都落到 data/assets/，id 由内容决定
        # （同一张图只存一份）。条目上记 `asset`（hash）与 `url`（可直接喂 <img>），`src` 仍留一份
        # base64 给还没改完的调用方（页面的 .cud 保存、旧 chip 渲染）—— 等 v6 把文档改成存 hash，
        # 这一份才退休。存失败不影响图池本身：`asset` 为 None 时一切照旧走 base64。
        src = tensor_to_base64(image)
        asset = None
        try:
            raw = asset_store.dataurl_bytes(src)
            rec = asset_store.put_bytes(raw, name=name, origin='staging', library=False) if raw else None
            asset = rec['id'] if rec else None
        except Exception as e:
            print(f"[Staging] asset store skipped: {e}")
        entry = {
            'id': sid,
            'src': src,
            'asset': asset,
            'url': ('/api/asset_media/' + asset) if asset else None,
            'name': name or f'#{self._staging_counter}',
            'width': w,
            'height': h,
            'place': place,
            'hidden': bool(hidden),
        }
        for i, old in enumerate(self.staging_items):
            if old['id'] == sid:
                # 原地替换：条目留在它原来的格子里，只换图。
                self.staging_items[i] = entry
                return sid
        self.staging_items.append(entry)
        if len(self.staging_items) > 40:
            old = self.staging_items.pop(0)
            self._staging_tensors.pop(old['id'], None)
        return sid

    def get_staging_list(self):
        """返回工作区条目列表（base64 图，宿主直接可渲染）。

        `asset` / `url` 是 A2 加的两条：这张图在**仓库**里的 id 与字节地址。老调用方只认 `src`
        也照常工作 —— 但新代码（Assets 窗、特效绑定）应该按 `asset` 走，那才是唯一副本。
        """
        return [{'id': s['id'], 'name': s['name'], 'src': s['src'],
                 'asset': s.get('asset'), 'url': s.get('url'),
                 'width': s.get('width', 0), 'height': s.get('height', 0),
                 'hidden': bool(s.get('hidden')), 'place': s.get('place')}
                for s in self.staging_items]

    def _first_detailer_enable_mask(self, preset_id=None):
        """生效链的 Enable Mask 总闸（默认开）。

        这枚开关现在住在**图里那块黑板**（board 节点）上；旧格式存在第一个 detailer 的
        params 里 —— 黑板没有这枚 key 时回落到那里，存量 preset 不迁移也能跑。

        preset_id 能解出 block set 时看那套链，否则看激活 tab 的镜像（self.blocks / self.graph）——
        与 run_detailer 主循环选链的优先级一致。Enable Mask 关 = 不做围绕 mask 的
        grow/blur/crop 预处理，整幅图就是工作区：Mask 层没画也允许跑（run 的
        「Mask is required」闸门据此放行，Start/End 也不再有 Mask 端口）。

        ★ 类归属：Server（HTTP handler 用 inst.、主循环用 server. 都拿得到 blocks 镜像）。
        """
        blocks = self.blocks or []
        graph = self.graph
        if preset_id:
            preset_set = next(
                (s for s in (self.blocks_sets or [])
                 if isinstance(s, dict) and s.get('id') == preset_id and s.get('blocks')),
                None,
            )
            if preset_set is not None:
                blocks = preset_set['blocks']
                if isinstance(preset_set.get('graph'), dict):
                    graph = preset_set['graph']
        board = next((n.get('params') or {} for n in (graph or {}).get('nodes') or []
                      if isinstance(n, dict) and n.get('kind') == 'board'), {})
        if isinstance(board.get('enable_mask'), bool):
            return board['enable_mask']
        bp = next((b.get('params', b) for b in blocks
                   if isinstance(b, dict) and b.get('type') == 'detailer'), None)
        return bool(bp.get('enable_mask', True)) if isinstance(bp, dict) else True

    def _chain_makes_own_mask(self, preset_id=None):
        """这条链会不会**自己造 mask**：在第一个 detailer 之前（或整条链里没有 detailer 时，
        任何一个位置）出现过 Detect 块。

        有这个块时，Run 的「Mask is required」闸门要放行 —— 用户完全可以什么都不画，
        让检测结果当 mask 用。选链优先级与 _first_detailer_enable_mask 一致。
        """
        blocks = self.blocks or []
        if preset_id:
            preset_set = next(
                (s for s in (self.blocks_sets or [])
                 if isinstance(s, dict) and s.get('id') == preset_id and s.get('blocks')),
                None,
            )
            if preset_set is not None:
                blocks = preset_set['blocks']
        first_detailer = next(
            (i for i, b in enumerate(blocks)
             if isinstance(b, dict) and b.get('type') == 'detailer'), len(blocks))
        return any(isinstance(b, dict) and b.get('type') == 'detect'
                   for b in list(blocks)[:first_detailer])

    def _run_enable_edit(self, preset_id=None):
        """生效链里是否有任一 detailer 块开了 Enable Edit。

        选链优先级与 _first_detailer_enable_mask / run_detailer 主循环一致。Enable Edit
        决定 Run 前是否要检查 prompt 里的 <image N> 引用有没有对应的 ref image。
        """
        blocks = self.blocks or []
        if preset_id:
            preset_set = next(
                (s for s in (self.blocks_sets or [])
                 if isinstance(s, dict) and s.get('id') == preset_id and s.get('blocks')),
                None,
            )
            if preset_set is not None:
                blocks = preset_set['blocks']
        for b in blocks:
            if not isinstance(b, dict) or b.get('type') != 'detailer':
                continue
            bp = b.get('params', b)
            if isinstance(bp, dict) and bp.get('enable_edit'):
                return True
        return False

    def _current_prompt_text(self):
        """Prompt tab 此刻的正文字符串（不含 lora / prefab 展开，够用来扫 <image N>）。

        拼装规则与 _parse_prompt 的文本部分一致：selected / custom / temporary 三段。
        """
        ps = self.prompt_server
        if ps is None:
            return ''
        parts = []
        for p in (getattr(ps, 'selected_prompts', None) or []):
            text = p['text'] if isinstance(p, dict) else p
            text = text or ''
            if text.startswith('<') and text.endswith('>'):
                text = text[1:-1]
            parts.append(text)
        custom = getattr(ps, 'custom_prompts', None)
        if custom:
            parts.append(custom)
        parts.extend(getattr(ps, 'temporary_prompts', None) or [])
        # 当前已加载那条 pipeline 的正向提示词也一并扫（用户说 B 含 pipeline 正向）。
        # 运行时若 preset 切换了 pipeline，这里用的是切换前那条 —— 宁可多扫不漏扫，
        # 误报时用户取消弹窗即可。
        try:
            node = getattr(self, 'node_instance', None)
            pipe = getattr(node, '_current_pipeline', None)
            ctx = getattr(pipe, 'context', None)
            if ctx is not None and hasattr(ctx, 'get_context'):
                pos, _neg, _loras = ctx.get_context('.+')
                if pos:
                    parts.append(pos)
        except Exception:
            pass
        return ','.join(parts)

    def edit_ref_shortfall(self, preset_id, extra_prompt):
        """Enable Edit 下 prompt 引用了 <image N>（N≥2）但工作区 ref image 不够时的缺口。

        返回 None = 无需弹窗；否则 {'need': 需要的 ref 总数, 'have': 现有 ref 数}。
        `<image 1>` 是 context 图、不占 ref，所以 need = 最大编号 - 1。
        """
        if not self._run_enable_edit(preset_id):
            return None
        need = max_prompt_image_ref(self._current_prompt_text()) - 1
        if need <= 0:
            return None
        have = 0
        if extra_prompt:
            ref_ids, _decoded, _missing = parse_prompt_image_refs(
                extra_prompt, lambda k: self.get_staging_image(k) is not None)
            have = len(ref_ids)
        if have >= need:
            return None
        return {'need': need, 'have': have}

    def get_staging_image(self, sid):
        """根据 id 获取工作区图片 tensor。优先返回 tensor 引用，避免 base64 decode。

        兼容：旧配置里的 'history_N' 引用解析不到（工作区 id 一律 'staging_N'），
        返回 None，由调用方按「引用缺失」容错处理。
        """
        tensor = self._staging_tensors.get(sid)
        if tensor is not None:
            return tensor
        # Fallback: 从 base64 decode（张量被上限淘汰后仍可从自带 src 恢复）
        for s in self.staging_items:
            if s['id'] == sid:
                try:
                    src = s['src']
                    if ',' in src:
                        b64_data = src.split(',', 1)[1]
                    else:
                        b64_data = src
                    img_bytes = base64.b64decode(b64_data)
                    img = Image.open(io.BytesIO(img_bytes))
                    # 带 alpha 的图保留 4 通道（QwenImage21 这类 alpha 架构需要），其余统一转 RGB
                    if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
                        img = img.convert('RGBA')
                    elif img.mode != 'RGB':
                        img = img.convert('RGB')
                    arr = np.array(img).astype(np.float32) / 255.0
                    return torch.from_numpy(arr).unsqueeze(0)
                except Exception as e:
                    print(f"[SnapshotDetailerSampler] Failed to load staging image: {e}")
                    return None
        return None

    def compose_blend(self, layer_specs, width=0, height=0, mask_data_url=None, attributes=None):
        """把图层栈合成成一张图（不写工作区），返回 (image, mask)。

        layer_specs: [{'src': dataURL, 'attrs': [表键], 'transform': {...}|None, 'visible': bool}]
        列表自下而上（[0] 是最底层）。图层自带像素（data URL），不绑定任何图池 id。
        画布尺寸优先用 width/height，否则取最底层图片的原始尺寸。

        `attrs` 是图层条带上**归后端重放**的那一段，顺序即生效顺序（decal 叠、mask 裁，与前端画布
        同一条「从左到右」的规矩）；特效链不会出现在这里，前端已经把它们烘进 src 了。面本身不跟着
        每层重复编码 —— 它住在同包上来的 `attributes` 表里（`[{'id','type','image'}]`，一枚一份 PNG），
        图层那条只剩表键，所以两层引用同一枚蒙版时后端拿到的是同一份像素（与 .cud v5 同一份账）。
        旧负载没有 `attrs` 这个键，按它原本的 `decal` 再 `mask` 读 —— 那正是条带的默认顺序，那种形状
        的面就内联在条目里。

        mask_data_url 是画布顶层的「纯 Mask 层」（alpha = 覆盖率，按画布尺寸栅格化），
        与图层自身的 coverage mask 无关 —— 返回的 mask 为 [1,H,W] float 或 None（无遮罩）。
        """
        if not layer_specs:
            raise ValueError('Missing layers')
        table = {a.get('id'): a for a in (attributes or []) if a and a.get('id')}
        resolved = []
        for spec in layer_specs:
            src = spec.get('src')
            # src 为空 = 前端的空白图层（刻意设计），等价于一张全透明图，不报错。
            # 前端已保证只发送可解码的 data URL（不可信的 src 会先用图层像素重编码
            # 成 PNG）；这里再兜底：万一仍解码失败，按空白图层继续合成并打日志，
            # 绝不让整个 Blend/Run 动作因单张图层报错中断。
            tensor = decode_image_dataurl(src) if src else None
            if src and tensor is None:
                print(f"[SnapshotDetailerSampler] layer image failed to decode "
                      f"({len(src)} chars, head={src[:48]!r}) — treating as a transparent blank layer")
            if tensor is not None and tensor.dim() == 4:
                tensor = tensor[0]
            attrs = spec.get('attrs')
            if attrs is None:
                attrs = [{'type': 'image', 'image': spec.get('decal')},
                         {'type': 'mask', 'image': spec.get('mask')}]
            # 只认这两种:链类 attribute 只有 WebGL 跑得动,前端烘完才发,永远不会跨这条边界。
            pending = []
            for a in attrs:
                # 图层那条只剩表键,值在同包的表里。键解不到就是包与表不同源（转发漏了或版本错位），
                # 宁可在合成前抛，也不能悄悄少乘一层蒙版 —— 那正是一次合成与两次合成的语义漂移。
                if isinstance(a, str):
                    if a not in table:
                        raise ValueError(f'layer keys attribute {a!r} but the payload carries no such face')
                    a = table[a]
                # P0 改名：老负载写 decal、新负载写 image，两种都收，往下统一成 image
                # （再往后 `a['type'] == 'mask'` 分两条解码路，其余一律走 decal 那条 RGBA 解码）。
                t = (a.get('type') if isinstance(a, dict) else None)
                if t == 'decal':
                    t = 'image'
                if a and t in ('image', 'mask') and a.get('image'):
                    pending.append({'type': t, 'src': a.get('image')})
            resolved.append({
                'image': tensor,        # None = 空白图层，画布尺寸确定后补全透明
                'transform': spec.get('transform'),
                'attrs': pending,
                'visible': spec.get('visible', True),
            })
        canvas_w = int(width or 0)
        canvas_h = int(height or 0)
        if canvas_w <= 0 or canvas_h <= 0:
            first = next((l['image'] for l in resolved if l['image'] is not None), None)
            if first is None:
                raise ValueError('Missing layers')
            canvas_h, canvas_w = first.shape[0], first.shape[1]
        for layer in resolved:
            if layer['image'] is None:
                layer['image'] = torch.zeros((canvas_h, canvas_w, 4), dtype=torch.float32)
        for layer in resolved:
            # 蒙版与 decal 都在图层自身尺寸下生效，随图层一起被 transform（缩放/旋转）
            layer_h, layer_w = layer['image'].shape[0], layer['image'].shape[1]
            layer['attrs'] = [{'type': a['type'],
                               'image': (decode_mask_alpha(a['src'], layer_w, layer_h)
                                         if a['type'] == 'mask' else
                                         decode_decal_rgba(a['src'], layer_w, layer_h))}
                              for a in layer['attrs']]
        blended = composite_layers(resolved, canvas_w, canvas_h)
        # composite_layers 刻意返回**预乘 alpha**（整栈 source-over 在预乘空间做），
        # 但这一层往后的一切图像空间消费方都是**直通 alpha** 语义：staging/预览 PNG、
        # 打标的白底合成、vision 塔预处理、alpha VAE、recover_crop 的背景混合
        # （都做 rgb*alpha + white*(1-alpha)）。预乘缓冲喂进去会在蒙版边缘再乘一次
        # alpha → 灰色条带。在这里做一次标准的 premul→straight 逆转（a≈0 处颜色无
        # 定义，取黑）。a 为 0/1 的像素两种表示相同，不受影响。
        if blended.shape[-1] == 4:
            _a = blended[..., 3:4]
            _rgb = torch.where(_a > 1e-4, blended[..., :3] / _a.clamp_min(1e-4),
                               torch.zeros_like(blended[..., :3]))
            blended = torch.cat([_rgb.clamp(0.0, 1.0), _a], dim=-1)
        # 纯 Mask 层整体按画布尺寸栅格化，squeeze 成 [1,H,W] 与 pipeline.mask 同构。
        # collapse_opaque=False：这一层「全白」= 整块画布都被覆盖，绝不能当成「没有蒙版」
        # （那样 Full / 涂满画布都会被误判成没画，弹出 "Mask is required"）。
        blend_mask = decode_mask_alpha(mask_data_url, canvas_w, canvas_h, collapse_opaque=False)
        if blend_mask is not None:
            blend_mask = blend_mask.squeeze(-1)
        return blended, blend_mask

    def _apply_tag_result(self, tag):
        """把打标结果写进 prompt 阶段：替换 parsing 来源的项，保留 normal/program。

        返回 (parsed_selected, temporary_list)。由 /api/blend_action 的 tag 分派调用，
        保证「Tag 只产出 prompt、不碰 Context」这一语义。解析不出来的段进 Temporary
        Prompts（和 matched 项同属这一次打标，随 prompt 节点的生命周期走），不写进
        custom_prompts，所以不会被持久化成用户的自定义词条。clear_tag 传空串 = 两边都清空。
        """
        self.tag_result = tag
        parsed_selected, parsed_unmatched = [], [tag]
        if SnapshotPromptNode is not None:
            parsed_selected, parsed_unmatched = SnapshotPromptNode._parse_raw_prompt(tag)
        temporary = [t.strip() for t in parsed_unmatched if t and t.strip()]
        if self.prompt_server is not None:
            new_prompts = [
                p for p in (self.prompt_server.selected_prompts or [])
                if not (isinstance(p, dict) and p.get('source', 'normal') == 'parsing')
            ]
            new_prompts.extend({'text': p, 'source': 'parsing'} for p in parsed_selected)
            self.prompt_server.selected_prompts = new_prompts
            self.prompt_server.temporary_prompts = temporary
        return parsed_selected, temporary

    # -------------------------------------------------------------------------
    # 全局参数 / block 链持久化
    # -------------------------------------------------------------------------
    def _blocks_sets_file(self):
        return _workbench_file('blocks_sets.json')

    def _load_blocks_sets_file(self):
        """Persisted tab sets from disk, or (None, None) when absent/corrupt."""
        try:
            with open(self._blocks_sets_file(), 'r', encoding='utf-8') as f:
                data = json.load(f)
            sets = data.get('blocks_sets') if isinstance(data, dict) else None
            if isinstance(sets, list):
                return sets, data.get('active_block_set')
        except Exception:
            pass
        return None, None

    def _read_sets_file(self):
        """Whole persisted JSON (possibly {}), shared by the two save paths so neither
        ever clobbers the other's keys."""
        try:
            with open(self._blocks_sets_file(), 'r', encoding='utf-8') as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _load_global_params_file(self):
        gp = self._read_sets_file().get('global_params')
        return gp if isinstance(gp, dict) else {}

    def _save_global_params_file(self):
        try:
            data = self._read_sets_file()
            data['global_params'] = {k: getattr(self, k) for k in self.GLOBAL_PARAM_DEFAULTS}
            with open(self._blocks_sets_file(), 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[SnapshotDetailerSampler] Failed to save global params: {e}")

    def _save_blocks_sets_file(self):
        try:
            data = self._read_sets_file()
            data['blocks_sets'] = self.blocks_sets
            data['active_block_set'] = self.active_block_set
            with open(self._blocks_sets_file(), 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[SnapshotDetailerSampler] Failed to save blocks_sets: {e}")

    # -------------------------------------------------------------------------
    # Pipeline Settings（选中项 + 按名字的 override）与 pipeline 名字解析
    # -------------------------------------------------------------------------
    def _normalize_pipeline_settings(self, raw):
        """Coerce anything on disk / from the frontend into the canonical shape.

        {'selected': str, 'overrides': {<pipeline name>: {<key>: {'value': int, 'enabled': bool}}}}
        Unknown keys are dropped rather than kept — a stale key would silently win over a
        DEFAULT SETTING value at run time.

        `overrides` is LEGACY: the per-pipeline-name override was replaced by Architecture Settings
        and nothing reads it any more. It is still normalized and written back untouched because the
        frontend keeps sending the object it got, so a user who upgrades loses nothing.
        """
        out = {'selected': '', 'overrides': {}}
        if not isinstance(raw, dict):
            return out
        sel = raw.get('selected')
        out['selected'] = sel if isinstance(sel, str) else ''
        ov = raw.get('overrides')
        if isinstance(ov, dict):
            for name, entry in ov.items():
                if not isinstance(name, str) or not isinstance(entry, dict):
                    continue
                one = {}
                for k in ARCH_OVERRIDE_KEYS:
                    v = entry.get(k)
                    if not isinstance(v, dict):
                        continue
                    try:
                        value = int(v.get('value'))
                    except (TypeError, ValueError):
                        continue
                    one[k] = {'value': value, 'enabled': bool(v.get('enabled'))}
                if one:
                    out['overrides'][name] = one
        return out

    def _load_pipeline_settings_file(self):
        """Persisted Pipeline Settings, or None when the key is absent (first run)."""
        ps = self._read_sets_file().get('pipeline_settings')
        return self._normalize_pipeline_settings(ps) if isinstance(ps, dict) else None

    def _save_pipeline_settings_file(self):
        try:
            data = self._read_sets_file()
            data['pipeline_settings'] = self.pipeline_settings
            with open(self._blocks_sets_file(), 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[SnapshotDetailerSampler] Failed to save pipeline_settings: {e}")

    # -------------------------------------------------------------------------
    # Architecture Settings（按 pipeline architecture 正则命中的覆盖规则）
    # -------------------------------------------------------------------------
    def _normalize_arch_settings(self, raw):
        """Coerce anything on disk / from the frontend into the canonical shape.

        {'rules': [{'id': str, 'architecture': <regex str>,
                   'overrides': {<key>: {'value': int, 'enabled': bool}}}]}
        Order is priority (first match wins), so the list is kept exactly as sent. A rule without a
        usable id is dropped — nothing could target it. Unknown override keys are dropped, an
        unknown/empty architecture pattern is kept verbatim (the matcher refuses to use it, which
        is what the frontend already flags in the field's tooltip).
        """
        out = {'rules': []}
        if not isinstance(raw, dict):
            return out
        rules = raw.get('rules')
        if not isinstance(rules, list):
            return out
        for r in rules:
            if not isinstance(r, dict):
                continue
            rid = r.get('id')
            if not isinstance(rid, str) or not rid:
                continue
            arch = r.get('architecture')
            one = {}
            ov = r.get('overrides')
            if isinstance(ov, dict):
                for k in ARCH_OVERRIDE_KEYS:
                    v = ov.get(k)
                    if not isinstance(v, dict):
                        continue
                    try:
                        value = int(v.get('value'))
                    except (TypeError, ValueError):
                        continue
                    one[k] = {'value': value, 'enabled': bool(v.get('enabled'))}
            out['rules'].append({'id': rid,
                                 'architecture': arch if isinstance(arch, str) else '',
                                 'overrides': one})
        return out

    def _load_arch_settings_file(self):
        """Persisted Architecture Settings, or None when the key is absent (first run)."""
        a = self._read_sets_file().get('arch_settings')
        return self._normalize_arch_settings(a) if isinstance(a, dict) else None

    def _save_arch_settings_file(self):
        try:
            data = self._read_sets_file()
            data['arch_settings'] = self.arch_settings
            with open(self._blocks_sets_file(), 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[SnapshotDetailerSampler] Failed to save arch_settings: {e}")

    def arch_overrides(self, architecture):
        """Resolve `architecture` against the rules: (enabled values, matched rule id or '').

        The rules are read top to bottom and the FIRST one whose regex matches wins, whole — a
        later rule can never add to it. Three refusals, in this order:
          * no architecture on the run (None / '')      -> nothing matches, all rules skipped;
          * empty pattern                               -> never matches (re.search('', x) would
                                                            match anything, which is the opposite
                                                            of an unset pattern);
          * a pattern Python cannot compile             -> skipped with one warning per call.
        A rule that matches but has every toggle off wins anyway: it just changes nothing.
        """
        if not architecture:
            return {}, ''
        for r in (self.arch_settings or {}).get('rules') or []:
            pattern = r.get('architecture') or ''
            if not pattern.strip():
                continue
            try:
                hit = re.search(pattern, architecture, re.IGNORECASE)
            except re.error as e:
                print(f"[SnapshotDetailerSampler] Skipping arch rule '{r.get('id')}' — "
                      f"invalid regex {pattern!r}: {e}")
                continue
            if not hit:
                continue
            ov = r.get('overrides') or {}
            return {k: v['value'] for k, v in ov.items()
                    if isinstance(v, dict) and v.get('enabled') and k in ARCH_OVERRIDE_KEYS}, r['id']
        return {}, ''

    # -------------------------------------------------------------------------
    # Interface meta（按 interface 名字贴的标注：端口改名 / 模式 / block 端口绑定）
    # -------------------------------------------------------------------------
    def _normalize_interface_meta(self, raw):
        """把磁盘 / 前端来的任意形状收敛成规范形，未知键一律丢弃。

        {<interface name>: {'names':   {'start': {<port num>: label}, 'end': {...}},
                            'modes':   {'block': bool, 'processor': bool},
                            'block_ports': {'in': <start port num>, 'out': <end port num>},
                            'output_targets': {<port num>: 'new_layer'|'selected_layer'|
                                               'selected_mask'|'asset'},
                            'input_sources': {<port num>: 'layers'|'selected'|'asset'|
                                               'main_mask'|'selected_mask'|'selected_alpha'|'mask_alpha'},
                            'allow_list': bool}}
        端口号一律收成 str（JSON 键本就是字符串），label 去空白、空 label 视为没改。
        `asset` = Processor 的仓库那一档；老的 `staging` 仍收（页面按 asset 读）。
        output_targets / input_sources = image/mask 出口的默认落位与入口的默认来源（Processor
        小窗的初值），取值出枚举就丢。
        allow_list = Allow List 开关：Processor 吃/吐整列图（视频逐帧那条路），执行时按节点
        是不是 INPUT_IS_LIST 分流（见 InterfaceExecutor 的 list_mode）。
        """
        out = {}
        if not isinstance(raw, dict):
            return out
        dst_enum = {'new_layer', 'selected_layer', 'selected_mask', 'asset', 'staging'}
        src_enum = {'layers', 'selected', 'asset', 'staging', 'main_mask', 'selected_mask',
                    'selected_alpha', 'mask_alpha', 'video'}
        for name, entry in raw.items():
            if not isinstance(name, str) or not name or not isinstance(entry, dict):
                continue
            one = {}
            raw_names = entry.get('names')
            if isinstance(raw_names, dict):
                names = {}
                for side in ('start', 'end'):
                    sub = raw_names.get(side)
                    if not isinstance(sub, dict):
                        continue
                    clean = {}
                    for num, label in sub.items():
                        if (isinstance(num, str) and num.isdigit()
                                and isinstance(label, str) and label.strip()):
                            clean[str(int(num))] = label.strip()
                    if clean:
                        names[side] = clean
                if names:
                    one['names'] = names
            modes = entry.get('modes')
            if isinstance(modes, dict):
                one['modes'] = {'block': bool(modes.get('block')),
                                'processor': bool(modes.get('processor')),
                                # Video Generator：把这个包声明成一台视频生成器（八个固定槽各绑一个端口）。
                                'video_generator': bool(modes.get('video_generator'))}
            # Video Generator 的槽位绑定：槽名 → 端口号（1..20）。槽名出表就丢 —— 未知的槽
            # 段那一侧不认，留着只会让"这段到底绑了什么"说不清。
            # Fixed FPS 开着时前端根本不给 fps 槽，这里也就把那一口摘掉（万一老配置里还留着）。
            vg = entry.get('video_gen')
            if isinstance(vg, dict):
                vg_ports = {}
                raw_ports = vg.get('ports')
                if isinstance(raw_ports, dict):
                    for slot, num in raw_ports.items():
                        if slot in VIDEO_GEN_SLOTS and isinstance(num, int) and 1 <= num <= 20:
                            vg_ports[slot] = num
                vg_fixed = bool(vg.get('fixed_fps'))
                if vg_fixed:
                    vg_ports.pop('fps', None)
                # Video Reference 关着 = 参考槽整行不出现，绑过也一并解掉（与前端同一口径）。
                vg_ref = bool(vg.get('video_ref'))
                if not vg_ref:
                    vg_ports.pop('reference', None)
                # 固定帧率：1..120，读不出来退 16（前端同一个兜底）。
                vg_val = 16.0
                try:
                    _f = float(vg.get('fixed_fps_value'))
                    if 1.0 <= _f <= 120.0:
                        vg_val = _f
                except (TypeError, ValueError):
                    pass
                one['video_gen'] = {'ports': vg_ports, 'fixed_fps': vg_fixed,
                                    'fixed_fps_value': vg_val, 'video_ref': vg_ref}
            bp = entry.get('block_ports')
            if isinstance(bp, dict):
                ports = {}
                for side in ('in', 'out'):
                    v = bp.get(side)
                    if isinstance(v, int) and 1 <= v <= 20:
                        ports[side] = v
                if ports:
                    one['block_ports'] = ports
            targets = entry.get('output_targets')
            if isinstance(targets, dict):
                clean_targets = {}
                for num, dst in targets.items():
                    if isinstance(num, str) and num.isdigit() and dst in dst_enum:
                        clean_targets[str(int(num))] = dst
                if clean_targets:
                    one['output_targets'] = clean_targets
            sources = entry.get('input_sources')
            if isinstance(sources, dict):
                clean_sources = {}
                for num, src in sources.items():
                    if isinstance(num, str) and num.isdigit() and src in src_enum:
                        clean_sources[str(int(num))] = src
                if clean_sources:
                    one['input_sources'] = clean_sources
            if 'allow_list' in entry:
                one['allow_list'] = bool(entry.get('allow_list'))
            if one:
                out[name] = one
        return out

    def _load_interface_meta_file(self):
        im = self._read_sets_file().get('interface_meta')
        return self._normalize_interface_meta(im) if isinstance(im, dict) else None

    def _save_interface_meta_file(self):
        try:
            data = self._read_sets_file()
            data['interface_meta'] = self.interface_meta
            with open(self._blocks_sets_file(), 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[SnapshotDetailerSampler] Failed to save interface_meta: {e}")

    def find_pipeline_by_name(self, name):
        """Resolve a pipeline by its package name → {'package_idx','pipeline_idx','node_id'}.

        Names come from inferred node titles and are NOT unique; the first match wins, which is
        the same rule the workbench's enum uses. Returns None when the pipeline is gone
        (renamed / package disconnected) — presets and overrides then read as `Missing`.
        """
        if not isinstance(name, str) or not name:
            return None
        for pi, pkg in enumerate(self.pipeline_packages or []):
            for qi, p in enumerate(pkg.get('pipelines') or []):
                if p.get('name') == name:
                    return {'package_idx': pi, 'pipeline_idx': qi,
                            'node_id': p.get('node_id', ''), 'name': name}
        return None

    def preset_pipeline_name(self, set_id):
        """Which pipeline a block set (pipeline preset) runs with: '' = [Default]."""
        s = next((x for x in (self.blocks_sets or [])
                  if isinstance(x, dict) and x.get('id') == set_id), None)
        name = s.get('pipeline_name') if isinstance(s, dict) else None
        return name if isinstance(name, str) else ''

    def _apply_params(self, data):
        for _k in self.GLOBAL_PARAM_DEFAULTS:
            if _k in data:
                setattr(self, _k, int(data[_k]))
        if any(k in data for k in self.GLOBAL_PARAM_DEFAULTS):
            self._save_global_params_file()
        # Multi-set Pipeline Blocks (the workbench's tabs). Sets/active arrive together with the
        # active set's blocks mirrored in `blocks`; either way the active set wins and the runner
        # only ever sees its flat chain.
        if 'blocks_sets' in data:
            sets = data['blocks_sets']
            if isinstance(sets, list):
                self.blocks_sets = sets
        if 'active_block_set' in data and data['active_block_set']:
            self.active_block_set = data['active_block_set']
        if 'blocks_sets' in data or 'active_block_set' in data:
            if self.blocks_sets:
                if not any(s.get('id') == self.active_block_set for s in self.blocks_sets):
                    self.active_block_set = self.blocks_sets[0].get('id')
                active_set = next((s for s in self.blocks_sets if s.get('id') == self.active_block_set), None)
                if active_set is not None:
                    self._set_blocks(active_set.get('blocks') or [], active_set.get('graph'))
            else:
                self.active_block_set = None
                self._set_blocks([])
            self._save_blocks_sets_file()
        if 'graph' in data and isinstance(data['graph'], dict):
            # 新格式：前端直接送图（每个 set 也带 graph）。图为准，blocks 只是它的投影。
            self._set_blocks(data.get('blocks') or self.blocks or [], data['graph'])
            self._save_blocks_sets_file()
        elif 'blocks' in data:
            self._set_blocks(data['blocks'])
        # Pipeline Settings 整份替换（前端是唯一作者：选中项，外加旧版按名字的 override 原样带回）。
        if 'pipeline_settings' in data:
            self.pipeline_settings = self._normalize_pipeline_settings(data['pipeline_settings'])
            self._save_pipeline_settings_file()
        # Architecture Settings 整份替换：列表顺序就是优先级，不能合并、只能整体覆盖。
        if 'arch_settings' in data:
            self.arch_settings = self._normalize_arch_settings(data['arch_settings'])
            self._save_arch_settings_file()
        # Interface meta 整份替换（前端是唯一作者：Interface tab 的改名 / 模式 / 端口绑定）。
        if 'interface_meta' in data:
            self.interface_meta = self._normalize_interface_meta(data['interface_meta'])
            self._save_interface_meta_file()
        # Open With Application（Settings tab 的 user preference）：写共享偏好文件，
        # 各节点执行时的 open_ui 从那里读 —— 不挂在某个节点实例上。
        if 'open_with_app' in data:
            set_open_with_app(bool(data['open_with_app']))

    def _set_blocks(self, blocks, graph=None):
        """Adopt a flat block chain (and its graph) as the active one.

        Used by both the legacy `blocks` key and the multi-set tabs path. `graph` 是新格式的图：
        给了就采用；只给 `blocks`（旧格式）就**就地迁移成图**，磁盘与执行都用它。`self.blocks`
        仍是旧格式镜像，`self.graph` 才是执行引擎读的那一份。"""
        self.blocks = blocks or []
        if isinstance(graph, dict) and isinstance(graph.get('nodes'), list):
            self.graph = graph
        else:
            self.graph = blocks_to_graph(self.blocks)
        if self.blocks_sets and self.active_block_set is not None:
            for s in self.blocks_sets:
                if s.get('id') == self.active_block_set:
                    s['graph'] = self.graph
                    break

    # ------------------------------------------------------------------
    # Prompt presets — 共享、持久化的 selection 模板；Prompt 块只存 preset_id 引用。
    # 预设内容（tags/custom/loras/prefabs/programs 的 raw selection）存 data/sampler/prompt_presets.json，
    # 编辑 preset 即影响所有引用它的块；run 时按块顺序注入其后的 detailer（纯临时）。
    # ------------------------------------------------------------------
    def _prompt_presets_file(self):
        return _workbench_file('prompt_presets.json')

    def _load_prompt_presets(self):
        """Persisted prompt presets: [{'id','name','selection'}]. Absent/corrupt file -> []."""
        try:
            with open(self._prompt_presets_file(), encoding='utf-8') as f:
                data = json.load(f)
            presets = data.get('presets') if isinstance(data, dict) else data
            if isinstance(presets, list):
                return [p for p in presets if isinstance(p, dict) and p.get('id')]
        except Exception:
            pass
        return []

    def _save_prompt_presets(self, presets):
        with open(self._prompt_presets_file(), 'w', encoding='utf-8') as f:
            json.dump({'presets': presets}, f, ensure_ascii=False, indent=2)

    def _find_prompt_preset(self, preset_id):
        if not preset_id:
            return None
        for p in self._load_prompt_presets():
            if isinstance(p, dict) and p.get('id') == preset_id:
                return p
        return None

    def _prompt_preset_selection(self, preset_id):
        """Raw selection of the referenced preset; {} when unset/missing (block = pass-through)."""
        preset = self._find_prompt_preset(preset_id)
        sel = preset.get('selection') if isinstance(preset, dict) else None
        return sel if isinstance(sel, dict) else {}

    def _create_prompt_preset(self, name=None):
        presets = self._load_prompt_presets()
        if isinstance(name, str) and name.strip():
            name = name.strip()
        else:
            existing = {p.get('name') for p in presets}
            k = 1
            while f'Preset {k}' in existing:
                k += 1
            name = f'Preset {k}'
        preset = {'id': 'preset-' + uuid.uuid4().hex[:12], 'name': name, 'selection': {}}
        presets.append(preset)
        self._save_prompt_presets(presets)
        return preset

    def _save_prompt_preset_selection(self, preset_id, selection):
        presets = self._load_prompt_presets()
        for p in presets:
            if p.get('id') == preset_id:
                p['selection'] = selection
                self._save_prompt_presets(presets)
                return True
        return False

    def _rename_prompt_preset(self, preset_id, name):
        if not isinstance(name, str) or not name.strip():
            return False
        presets = self._load_prompt_presets()
        for p in presets:
            if p.get('id') == preset_id:
                p['name'] = name.strip()
                self._save_prompt_presets(presets)
                return True
        return False

    def _delete_prompt_preset(self, preset_id):
        """Delete the preset only. Blocks keep the now-dangling id on purpose: the UI
        renders it as `(missing)` so the reference stays visible and can be re-pointed,
        and a run treats a missing preset as an empty selection (logged + skipped).
        Nothing is rewritten behind the user's back."""
        presets = self._load_prompt_presets()
        kept = [p for p in presets if p.get('id') != preset_id]
        if len(kept) == len(presets):
            return False
        self._save_prompt_presets(kept)
        return True

    def _pending_query_view(self):
        """What /api/status publishes: which Query block is parked waiting for an answer.

        The run loop owns the wait (it blocks on the event); this is only the read-only
        projection the sampler polls to know it must open the prompt dialog. The event
        itself never crosses the wire. `preset_id` rides along so the dialog can seed
        itself from the bound preset (same scope the preset editor uses); `persistent`
        tells the sampler UI whether the answer will be written back.
        """
        q = self.pending_query
        if not q:
            return None
        return {'id': q.get('id'), 'name': q.get('name'), 'index': q.get('index'),
                'preset_id': q.get('preset_id'), 'persistent': bool(q.get('persistent'))}

    def _answer_pending_query(self, selection=None, cancelled=False):
        """Release a parked Query block with the user's choice (or their cancellation).

        `selection` is the RAW prompt-node selection — the run loop merges it and runs its
        programs exactly like a prompt block's preset. `cancelled` (closing the dialog,
        not answering) aborts the whole chain. False = nothing was waiting.

        A Persistent Query overwrites its bound preset with this final selection, here and
        not in the run loop: the write has to be on disk before this request answers, so the
        sampler can refresh the preset summaries without racing the parked thread. Fail-open
        — persistence is for NEXT run, it must never break THIS one.
        """
        q = self.pending_query
        if not q:
            return False
        if cancelled:
            q['cancelled'] = True
        else:
            q['answer'] = selection if isinstance(selection, dict) else {}
            if q.get('persistent'):
                preset_id = q.get('preset_id')
                before = (self._prompt_preset_selection(preset_id).get('loras') or [])
                after = (q['answer'].get('loras') or [])
                try:
                    if self._save_prompt_preset_selection(preset_id, q['answer']):
                        print(f"[Query] answer persisted into preset '{preset_id}' "
                              f"(loras {len(before)} -> {len(after)})")
                        if before and not after:
                            print(f"[Query] WARNING: preset '{preset_id}' had {len(before)} lora(s), "
                                  "the answer carried none — the write-back emptied it")
                    else:
                        print(f"[Query] WARNING: preset '{preset_id}' is gone — answer not persisted")
                except Exception as e:
                    print(f"[Query] WARNING: could not persist the answer ({e})")
        self.pending_query = None
        evt = q.get('event')
        if evt is not None:
            evt.set()
        return True

    # -------------------------------------------------------------------------
    # HTTP 请求处理器
    # -------------------------------------------------------------------------
    class MainHandler(http.server.SimpleHTTPRequestHandler):
        server_instance = None

        def log_message(self, format, *args):
            pass

        @staticmethod
        def _get_current_architecture(inst):
            """当前 pipeline 的模型架构名（用于前端按架构渲染 DetailerBlock 设置）。"""
            try:
                node = getattr(inst, 'node_instance', None)
                pipeline = getattr(node, '_current_pipeline', None)
                cfg = getattr(pipeline, 'config', None)
                return cfg.get('architecture') if isinstance(cfg, dict) else None
            except Exception:
                return None

        def _send_json(self, data, status=200):
            self.send_response(status)
            self.send_header('Content-type', 'application/json')
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode('utf-8'))

        def do_OPTIONS(self):
            self.send_response(200)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.end_headers()

        def do_GET(self):
            inst = self.server_instance

            # 两个页面都是**单文件**构建产物(js/css 全内联),前端 build 一次就该刷新即生效 —— 所以和下面
            # js/fx/attr 同款发 no-store,别让浏览器/WebView 的缓存把新版挡在门外。禁缓存是开发回路的
            # 命门,这条路由偏偏漏了:页面不带验证器(无 ETag/Last-Modified),一旦被缓存就只能等它自己过期。
            # 路径按 urlparse 取:URL 上挂 `?v=` 这类缓存参数不该把这条精确匹配顶成 404。
            page = urlparse(self.path).path
            # 旧页签/书签/文档站的链接可能还带 localhost。页面 origin 必须是 127.0.0.1
            # （见 browser_url 处的注释：DSH 嵌入要求同站），所以在三条页面路由上把它们重定向过去。
            if page in ('/', '/sampler_node.html', '/blend_node.html'):
                host = (self.headers.get('Host') or '').rsplit(':', 1)[0].strip('[]').lower()
                if host == 'localhost':
                    self.send_response(302)
                    self.send_header('Location', 'http://127.0.0.1:%d%s'
                                     % (self.server.server_address[1], self.path))
                    self.send_header('Cache-Control', 'no-store')
                    self.end_headers()
                    return
            if page in ('/', '/sampler_node.html', '/blend_node.html'):
                name = 'blend_node.html' if page == '/blend_node.html' else 'sampler_node.html'
                file_path = web_file(name)
                if os.path.exists(file_path):
                    self.send_response(200)
                    self.send_header('Content-type', 'text/html')
                    self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
                    self.end_headers()
                    with open(file_path, 'rb') as f:
                        raw = f.read()
                    # 顶栏（sampler_node）的那一份布局随页面一起送下去：用户上次摆的样子在**第一帧**
                    # 就已经在手上，不必等页面 mount 再去问一次（那一次就是"打开时闪一下默认布局"）。
                    # 见 `_layouts_boot_payload`。工作台（blend_node）没有 dock，原样发。
                    if name == 'sampler_node.html':
                        try:
                            html = _inject_boot_layout(raw.decode('utf-8'))
                            raw = html.encode('utf-8')
                        except Exception:
                            pass
                    self.wfile.write(raw)
                else:
                    self.send_error(404, "%s not found" % name)
                return

            # 图层特效链按特效拆在 web/fx/ 下,图层 attribute 拆在 web/attr/ 下,3D 图层的 three.js
            # 内置包放在 web/js/ 下,blend_node.html 都用 <script src> 引它们,所以工作台得能送这些
            # 文件。只认这三个目录直属的 .js:realpath 之后再验归属,../ 与绝对路径都翻不出去。禁缓存
            # 是开发回路的命门 —— 否则改了特效文件刷新页面还是旧的。
            req_path = urlparse(self.path).path
            for sub in ('fx', 'js', 'attr'):
                prefix = '/' + sub + '/'
                if not req_path.startswith(prefix):
                    continue
                root = os.path.realpath(web_file(sub))
                name = req_path[len(prefix):]
                file_path = os.path.realpath(os.path.join(root, name))
                if (not name.endswith('.js') or os.path.dirname(file_path) != root
                        or not os.path.isfile(file_path)):
                    self.send_error(404, "%s module not found" % sub)
                    return
                self.send_response(200)
                self.send_header('Content-type', 'text/javascript; charset=utf-8')
                self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                with open(file_path, 'rb') as f:
                    self.wfile.write(f.read())
                return

            # Pose attribute 的模型资产 (VNMHJS02 包 ~36MB + 三张皮肤贴图) 住在 git 外的
            # data/pose/ 里。与上面三个模块目录不同: 这堆是**大文件且极少变**, 必须真缓存
            # (immutable) —— 页面每次刷新都重拉 48MB 是不可接受的; 归属校验与上面同一套
            # (realpath 之后再验直属), 只多放宽后缀 (png/md/gz/bin)。
            if req_path.startswith('/pose-asset/'):
                root = os.path.realpath(data_dir('pose'))
                name = req_path[len('/pose-asset/'):]
                file_path = os.path.realpath(os.path.join(root, name))
                if (not name or os.path.dirname(file_path) != root
                        or not os.path.isfile(file_path)):
                    self.send_error(404, "pose asset not found")
                    return
                ctype = 'application/octet-stream'
                if name.endswith('.png'):
                    ctype = 'image/png'
                elif name.endswith(('.md', '.txt')):
                    ctype = 'text/plain; charset=utf-8'
                elif name.endswith('.gz'):
                    ctype = 'application/gzip'
                self.send_response(200)
                self.send_header('Content-type', ctype)
                self.send_header('Cache-Control', 'public, max-age=31536000, immutable')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                with open(file_path, 'rb') as f:
                    self.wfile.write(f.read())
                return

            # Agent dock 窗:/api/agent/* 整族交给 agent_backend(LLM 会话循环 + 设置存储)。
            # 工具本体在浏览器侧执行 —— 后端只编排与转发,协议见 agent_backend.py 模块注释。
            # 导入失败的兜底**必须回 JSON**:跌进静态 404 的 HTML 页,前端就只能报"应答不是 JSON",
            # 分不清"进程还是旧代码"和"agent_backend 导入失败"这两回事。
            if urlparse(self.path).path.startswith('/api/agent'):
                if agent_backend is None:
                    self._send_json({'ok': False, 'error': 'agent backend failed to import — check the '
                        'ComfyUI console for "[SnapshotDetailerSampler] Warning: cannot import agent_backend" '
                        '(usually a missing dependency, e.g. pip install requests into this python)'}, 503)
                    return
                agent_backend.handle(self)
                return

            if self.path == '/api/config':
                self._send_json({
                    'prompt_url': inst.prompt_url if inst else '',
                    'detail_status': inst.detail_status if inst else 'idle',
                    # DEFAULT SETTING 的全部键（前端 Settings 页的唯一真源）—— 按
                    # GLOBAL_PARAM_DEFAULTS 回显，加参数不必再来这里补一行。
                    **{k: (getattr(inst, k, d) if inst else d)
                       for k, d in SnapshotDetailerSamplerServer.GLOBAL_PARAM_DEFAULTS.items()},
                    'has_tagger': inst.tagger is not None if inst else False,
                    # Detector 工具的总闸：节点没连 detector 时整块工具隐藏。
                    'has_detector': inst.detector is not None if inst else False,
                    'architecture': self._get_current_architecture(inst),
                    'has_package': bool(inst and inst.interface_packages),
                    'package_count': len(inst.interface_packages) if inst else 0,
                    'has_pipeline_package': bool(inst and inst.pipeline_packages),
                    'pipeline_package_count': len(inst.pipeline_packages) if inst else 0,
                    'blocks': inst.blocks if inst else [],
                    'graph': getattr(inst, 'graph', None) if inst else None,
                    'blocks_sets': inst.blocks_sets if inst else [],
                    'active_block_set': inst.active_block_set if inst else None,
                    # Pipeline Settings（此刻选中的 pipeline 名字；overrides 是旧数据）与这条节点上
                    # 真正加载的那条 pipeline 的名字。'' = 还没选过 = [Default]（节点输入口那条）。
                    'pipeline_settings': inst.pipeline_settings if inst else {'selected': '', 'overrides': {}},
                    # Architecture Settings：Settings tab 那串按架构正则命中的规则。
                    'arch_settings': getattr(inst, 'arch_settings', {'rules': []}) if inst else {'rules': []},
                    'interface_meta': getattr(inst, 'interface_meta', {}) if inst else {},
                    'loaded_pipeline_name': getattr(inst, 'loaded_pipeline_name', '') if inst else '',
                    # User preference（Settings tab 的 Application 条目）：执行到节点时打开方式 ——
                    # 开 = KolidUI 不在就把 Kolid Desktop.exe 拉起来再注入；关 = 原逻辑（在就注入，
                    # 不在退浏览器）。真源在 libs.client_host 的共享偏好文件里，跨节点生效。
                    'open_with_app': is_open_with_app(),
                    # Prompt tab 的 LoRA 灰名单跟着哪一代 regex 拉的 —— 宿主页拿它判断要不要重拉。
                    'pipeline_lora_epoch': getattr(inst, 'pipeline_lora_epoch', 0) if inst else 0,
                })
                return

            if self.path == '/api/status':
                self._send_json({
                    'detail_status': inst.detail_status if inst else 'idle',
                    'error': getattr(inst, 'detail_error', None),
                    'progress': inst.detail_progress if inst else 0,
                    'current_step': inst.detail_current_step if inst else 0,
                    'total_steps': inst.detail_total_steps if inst else 0,
                    'interface_status': getattr(inst, 'interface_status', 'idle') if inst else 'idle',
                    'interface_error': getattr(inst, 'interface_error', None) if inst else None,
                    'interface_progress': getattr(inst, 'interface_progress', 0) if inst else 0,
                    'interface_current_step': getattr(inst, 'interface_current_step', 0) if inst else 0,
                    'interface_total_steps': getattr(inst, 'interface_total_steps', 0) if inst else 0,
                    'interface_result_keys': getattr(inst, 'interface_result_keys', []) if inst else [],
                    'interface_result_meta': getattr(inst, 'interface_result_meta', []) if inst else [],
                    # 视频模式的 preset 跑（逐帧过链 + 编码回视频），与 interface_* 平行。
                    'preset_video_status': getattr(inst, 'preset_video_status', 'idle') if inst else 'idle',
                    'preset_video_error': getattr(inst, 'preset_video_error', None) if inst else None,
                    'preset_video_progress': getattr(inst, 'preset_video_progress', 0) if inst else 0,
                    'preset_video_current': getattr(inst, 'preset_video_current', 0) if inst else 0,
                    'preset_video_total': getattr(inst, 'preset_video_total', 0) if inst else 0,
                    'preset_video_meta': getattr(inst, 'preset_video_meta', []) if inst else [],
                    'pending_query': inst._pending_query_view() if inst else None,
                    # 一条 preset 绑定的 pipeline 可能在这次 run 里被现加载（见 run_detailer）：
                    # 名字与架构都跟着变，前端轮询时顺手同步，不用重拉 config。
                    'loaded_pipeline_name': getattr(inst, 'loaded_pipeline_name', '') if inst else '',
                    'pipeline_lora_epoch': getattr(inst, 'pipeline_lora_epoch', 0) if inst else 0,
                    'architecture': self._get_current_architecture(inst),
                })
                return

            if self.path == '/api/debug_trace':
                self._send_json(dbg.debug_trace_snapshot())
                return

            # ── 界面探针 ─────────────────────────────────────────────────────────
            # 布局问题的快照存取。前端 Alt+D / 角标点一下就把"当时的模型 + 实际渲染 + 问题清单
            # + 操作轨迹"发到这里；存成 temporary/ui_probe/ 下的一个 .json（外加一份 .md 摘要），
            # 于是**谁都能直接读文件**，不必经过这一层。
            probe_path = urlparse(self.path).path
            if probe_path.startswith('/api/ui_probe'):
                from ...libs import ui_probe_store as ups
                tail = probe_path[len('/api/ui_probe'):]
                if tail in ('', '/'):
                    self._send_json({'ok': True,
                                     'count': len(ups.listing()),
                                     'dir': ups.DIR,
                                     'files': ups.listing()[:20]})
                    return
                if tail == '/list':
                    self._send_json({'ok': True, 'dir': ups.DIR, 'files': ups.listing()})
                    return
                if tail == '/latest':
                    snap = ups.latest()
                    if snap is None:
                        self._send_json({'ok': False, 'error': 'no snapshot yet'}, 404)
                    else:
                        self._send_json(snap)
                    return
                if tail == '/get':
                    name = urlparse(self.path).query
                    name = parse_qs(name).get('name', [''])[0]
                    snap = ups.load(name)
                    if snap is None:
                        self._send_json({'ok': False, 'error': 'not found: %r' % name}, 404)
                    else:
                        self._send_json(snap)
                    return
                if tail == '/build':
                    # "页面上的 build 是不是当前源码构建的" —— 排查的第一个问题，直接给答案。
                    self._send_json({'ok': True, 'build': ups.build_info()})
                    return
                if tail == '/pull':
                    want = _UI_PROBE_PULL['want'] if _UI_PROBE_PULL['want'] > _UI_PROBE_PULL['done'] else 0
                    self._send_json({'ok': True, 'want': want})
                    return
                if tail == '/cmd':
                    # 页面在这里挂着等指令（长轮询）。服务端是多线程的（见 ThreadingMixIn），
                    # 挂住一个连接不会挡住别的请求。
                    pqs = parse_qs(urlparse(self.path).query)
                    try:
                        wait = float(pqs.get('wait', ['0'])[0] or 0)
                    except ValueError:
                        wait = 0.0
                    sid = pqs.get('sid', [''])[0]
                    if sid:
                        _UI_PROBE_SESS[sid] = {'sid': sid, 'url': pqs.get('url', [''])[0],
                                               'build': pqs.get('build', [''])[0],
                                               'vp': pqs.get('vp', [''])[0], 'at': time.time()}
                    try:
                        cmd = _UI_PROBE_INBOX.get(timeout=max(0.0, min(wait, 30)))
                    except queue.Empty:
                        cmd = None
                    self._send_json({'ok': True, 'cmd': cmd})
                    return
                if tail == '/sessions':
                    now = time.time()
                    self._send_json({'ok': True, 'sessions': [
                        dict(v, age=round(now - v['at'], 1)) for v in list(_UI_PROBE_SESS.values())]})
                    return
                if tail == '/view':
                    file_path = web_file('probe_viewer.html')
                    if os.path.exists(file_path):
                        self.send_response(200)
                        self.send_header('Content-type', 'text/html; charset=utf-8')
                        self.send_header('Cache-Control', 'no-store')
                        self.end_headers()
                        with open(file_path, 'rb') as f:
                            self.wfile.write(f.read())
                    else:
                        self.send_error(404, 'probe_viewer.html not found (rebuild the ui)')
                    return
                self._send_json({'ok': False, 'error': 'unknown ui_probe path: %s' % tail}, 404)
                return

            if self.path == '/api/package':
                if not inst or not inst.interface_packages:
                    self._send_json({'interfaces': []})
                    return

                from .interface_node import InterfacePackageNode
                epi = getattr(inst, 'extra_pnginfo', None)
                if isinstance(epi, list):
                    epi = epi[0] if epi else {}
                # 显示用的类型来自 inst.extra_pnginfo —— 那是**上一次 run 图片里带的存档**,
                # 不是画布上当前的图。改完连线没重新跑一次, 这里读到的就还是旧存档。
                _wf = epi.get('workflow') if isinstance(epi, dict) else None
                print("[InterfacePorts] /api/package epi=%s keys=%s wf_nodes=%s stored=%d"
                      % ('yes' if epi else 'NO',
                         sorted(epi.keys())[:4] if isinstance(epi, dict) else '-',
                         len(_wf.get('nodes') or []) if isinstance(_wf, dict) else 'no-workflow',
                         len(inst.interface_packages)))

                interfaces = []
                for pkg in inst.interface_packages:
                    end_id = pkg.get('end_node_id', '')

                    # Get fresh package from extra_pnginfo for full port info
                    fresh_pkg = pkg
                    _from = 'stored'
                    if epi and isinstance(epi, dict) and end_id:
                        pkg_node = InterfacePackageNode()
                        fresh = pkg_node.get_package(end_id, epi, None)
                        if fresh and fresh[0]:
                            fresh_pkg = fresh[0]
                            _from = 'rebuilt-from-epi'

                    start_types = fresh_pkg.get('start_types', {})
                    end_types = fresh_pkg.get('types', {})
                    print("[InterfacePorts] /api/package end=%s via=%s start_types=%s end_types=%s"
                          % (end_id, _from, start_types or '{}', end_types or '{}'))

                    # 这一口的名字 / 默认值 / 候选项, 全部来自 get_package 从存档算出的那条
                    # "它喂到的内部节点输入" —— 面板不再自造一份真值。
                    start_labels = fresh_pkg.get('start_labels', {}) or {}
                    start_defaults = fresh_pkg.get('start_defaults', {}) or {}
                    start_targets = fresh_pkg.get('start_targets', {}) or {}
                    # 面板上每个框里的数字就该等于这里的一个值; 空 dict = 后端这次没算出
                    # 任何默认值 (上面 get_package 的"默认值缺席 ..."会说明为什么)。
                    print("[InterfacePorts] /api/package '%s' 名字=%s 默认值=%s 候选来源=%s"
                          % (fresh_pkg.get('name', pkg.get('name', '')),
                             sorted(start_labels), sorted(start_defaults), sorted(start_targets)))

                    def get_combo_options(port_num):
                        tgt = start_targets.get(str(port_num)) or {}
                        in_name = tgt.get('input_name')
                        if not in_name:
                            print("[InterfacePorts] COMBO port=%s: 存档里没算出它喂到的输入 "
                                  "(targets=%s), 取不到候选项" % (port_num, sorted(start_targets)))
                            return []
                        try:
                            import nodes as comfy_nodes
                            cls = comfy_nodes.NODE_CLASS_MAPPINGS.get(tgt.get('class_type', ''))
                            if not cls:
                                return []
                            it = cls.INPUT_TYPES()
                        except Exception:
                            return []
                        options = []
                        for cat in ('required', 'optional'):
                            ci = it.get(cat, {})
                            if not isinstance(ci, dict):
                                continue
                            val = ci.get(in_name)
                            if isinstance(val, tuple) and len(val) >= 1 and isinstance(val[0], list):
                                options = [str(x) for x in val[0]]
                        # de-dup, preserve order
                        seen = set()
                        result = []
                        for o in options:
                            if o not in seen:
                                seen.add(o)
                                result.append(o)
                        return result

                    def make_port(num, name, ptype, default=None):
                        is_inject = ptype in ('PIPELINE_DATA', 'IMAGE', 'MASK')
                        is_manual = ptype in ('STRING', 'INT', 'FLOAT', 'BOOLEAN', 'COMBO')
                        port = {
                            'num': num,
                            'name': name,
                            'type': ptype,
                            # inject 类的值来自画面, 不给它摆一个会误导的"默认值"
                            'value': None if is_inject else default,
                            'category': 'inject' if is_inject else ('manual' if is_manual else 'port'),
                        }
                        if ptype == 'COMBO':
                            port['options'] = get_combo_options(num)
                        return port

                    # Interface meta（改名 / 模式 / block 端口绑定）按包名字贴回来。
                    # 端口名本身只是展示 —— 执行全程按端口号走,改名不影响链路。
                    iface_name = fresh_pkg.get('name', pkg.get('name', ''))
                    meta = (getattr(inst, 'interface_meta', None) or {}).get(iface_name) or {}
                    names_meta = meta.get('names') or {}

                    def port_label(side, num):
                        # 你改过的名 > 从端口算出的名(它喂到的那个输入) > valueN 兜底
                        named = (names_meta.get(side) or {}).get(str(num))
                        if named:
                            return named
                        if side == 'start' and start_labels.get(str(num)):
                            return start_labels[str(num)]
                        return 'value' + str(num)

                    # Start ports: ONLY from start_types (Start node's connected value ports)
                    start_ports = []
                    for port_num_str, ptype in sorted(start_types.items(), key=lambda x: int(x[0]) if str(x[0]).isdigit() else 0):
                        port_num = int(port_num_str) if isinstance(port_num_str, str) else port_num_str
                        start_ports.append(make_port(port_num, port_label('start', port_num), ptype,
                                                     start_defaults.get(port_num_str)))

                    # End ports: ONLY from end_types (End node's connected value ports)
                    end_ports = []
                    for port_num_str, ptype in sorted(end_types.items(), key=lambda x: int(x[0]) if str(x[0]).isdigit() else 0):
                        port_num = int(port_num_str) if isinstance(port_num_str, str) else port_num_str
                        end_ports.append(make_port(port_num, port_label('end', port_num), ptype))

                    interfaces.append({
                        'name': iface_name,
                        'start_ports': start_ports,
                        'end_ports': end_ports,
                        'modes': meta.get('modes') or {'block': False, 'processor': False,
                                                       'video_generator': False},
                        'block_ports': meta.get('block_ports') or {},
                        # Video Generator：八个固定槽各绑了哪个端口（空表 = 还没绑 / 没开这个模式）。
                        'video_gen': meta.get('video_gen') or {},
                        # image/mask 出口的默认落位与入口的默认来源（Processor 小窗的初值），没有就是空表。
                        'output_targets': meta.get('output_targets') or {},
                        'input_sources': meta.get('input_sources') or {},
                        # Allow List：Processor 吃/吐整列图（视频逐帧那条路）。
                        'allow_list': bool(meta.get('allow_list')),
                    })
                self._send_json({'interfaces': interfaces})
                return

            if self.path == '/api/pipeline_package':
                if not inst or not inst.pipeline_packages:
                    self._send_json({'pipeline_packages': []})
                    return
                pipeline_packages = []
                for pkg in inst.pipeline_packages:
                    pipelines = []
                    for i, p in enumerate(pkg.get('pipelines', [])):
                        pipelines.append({"name": p.get("name", f"Pipeline {i+1}"), "node_id": p.get("node_id", "")})
                    pipeline_packages.append({
                        "name": pkg.get("name", "PipelineGroup"),
                        "pipelines": pipelines,
                    })
                self._send_json({"pipeline_packages": pipeline_packages})
                return

            if self.path == '/api/has_prompt':
                has = (inst.prompt_server is not None and
                       (getattr(inst.prompt_server, 'selected_prompts', None) or
                        getattr(inst.prompt_server, 'custom_prompts', None) or
                        getattr(inst.prompt_server, 'selected_loras', None)))
                self._send_json({'has_prompt': bool(has)})
                return

            if self.path == '/api/result':
                if inst and inst.original_image is not None and inst.detailed_image is not None:
                    try:
                        self._send_json({
                            'original_image': tensor_to_base64(inst.original_image),
                            'detailed_image': tensor_to_base64(inst.detailed_image),
                            'original_key': getattr(inst, 'original_key', None),
                            'detailed_key': getattr(inst, 'detailed_key', None),
                        })
                    except Exception as e:
                        self._send_json({'error': str(e)}, 500)
                else:
                    self._send_json({'error': 'Result not ready'}, 404)
                return

            if self.path == '/api/staging':
                self._send_json({'staging': inst.get_staging_list() if inst else []})
                return

            # ── 公共时间基准 ── MIDI 模式的所有窗（传输条、钢琴卷帘、力度泳道）都从这里对表。
            # 一次给全：帧 / 采样率 / 在播 / QPC 轴上的秒数 / 频率 / 后端是谁。前端拿 `now` 做
            # 一次往返折半的对齐，之后本地插值，隔几秒回来重校一次（见 midi/clock.ts）。
            if page == '/api/clock':
                if clock_bridge is None:
                    self._send_json({'error': 'clock bridge unavailable'}, 500)
                    return
                self._send_json(clock_bridge.get_clock().snapshot())
                return

            # ── 原生发声引擎的状态 ── 只报数，不开设备。开设备是 POST 的事。
            if page == '/api/audio':
                if audio_bridge is None:
                    self._send_json({'available': False, 'error': 'audio bridge unavailable'})
                    return
                # 电平表的快读口：Monitor 持槽期间 33ms 问一次，只回一个峰值（千分比）。
                # status() 那一大坨（每槽 worker 状态、乐器清单、debug 计数）不该跟着这么问。
                if (parse_qs(urlparse(self.path).query).get('levels') or [''])[0] == '1':
                    self._send_json(audio_bridge.get_engine().levels())
                    return
                self._send_json(audio_bridge.get_engine().status())
                return

            if self.path == '/api/prompt_presets':
                self._send_json({'presets': inst._load_prompt_presets() if inst else []})
                return

            # 布局档案：Layout 那一格读的就是这一份（见 _layouts_read 上面那段说明 —— 它必须落盘，
            # 因为同一个页面会落在 8700..8799 里某个端口上，而 localStorage 是 per-origin 的）。
            if self.path == '/api/layouts':
                with _LAYOUTS_LOCK:
                    store = _layouts_read()
                self._send_json({'ok': True, 'kind': 'layouts',
                                 'default': store['default'], 'items': store['items'],
                                 'current': store['current']})
                return

            # ---- MIDI：乐器库。Settings 的 MIDI 屏与 Assets 的 Instruments 档读的是同一份 ----
            if self.path == '/api/midi_settings':
                settings = _midi_read()
                self._send_json({'ok': True, **settings,
                                 'state': _library_state(settings['instruments_library']),
                                 'presets_state': _library_state(settings['presets_library'])})
                return

            if self.path == '/api/instruments':
                self._send_json(_instruments_payload())
                return

            # ---- 文档 IO：前端问一次能力，之后就只按 token 读文件 ----
            if self.path == '/api/io_caps':
                self._send_json({'pick': doc_io.available()})
                return

            if self.path.startswith('/api/io_read'):
                token = (parse_qs(urlparse(self.path).query).get('token') or [''])[0]
                data, err = doc_io.read(token)
                if err:
                    self._send_json({'success': False, 'error': err}, 404)
                    return
                entry = doc_io.entry(token) or {}
                self.send_response(200)
                self.send_header('Content-type', entry.get('mime') or 'application/octet-stream')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data)
                return

            # 空 pipeline 时的补救入口：让工作台重开上次那份 .cud。描述符由服务端从自己写下的
            # 记录里造，页面只说"要不要"，说不出"哪一个"。
            if self.path == '/api/recent_cud':
                doc, reason = doc_io.reopen_recent_cud()
                self._send_json({'ok': doc is not None, 'doc': doc, 'reason': reason})
                return

            # 会话恢复的读口：上一次会话开着的那批 .cud（宿主每次播报后写的活动集），
            # 原样重开 —— 刷新后文档窗口原地认领保留位，不再留一排 Untitled 幽灵 tab。
            if self.path == '/api/open_cuds':
                self._send_json({'ok': True, 'docs': doc_io.restore_open_cuds()})
                return

            # 全局资产库：Assets 窗的 Global 开关问的就是这一份清单（落点 = 节点那一份
            # data/assets/，见 _global_assets_list）。只读，不写 —— 往里加货是节点的事。
            if self.path == '/api/global_assets':
                try:
                    items = _global_assets_list()
                    self._send_json({'ok': True, 'dir': _global_assets_dir(), 'assets': items})
                except Exception as e:
                    self._send_json({'ok': False, 'error': str(e), 'assets': []}, 500)
                return

            # 全局资产的文件伺服（带 Range —— <video> 的 seek 靠它）。
            if self.path.startswith('/api/global_media/'):
                # 同 vid_media：文件名里的空格/中文会被浏览器百分号编码，必须解码回来再拼路径。
                fname = os.path.basename(unquote(urlparse(self.path).path[len('/api/global_media/'):]))
                if not _send_media_file(self, os.path.join(_global_assets_dir(), fname)):
                    self.send_error(404)
                return

            # ── 资产仓库（A0）───────────────────────────────────────────────────────
            # 设计见 docs/assets_single_store_design.md。这里只开"仓库"的**读口**，不改任何既有语义：
            #   GET /api/assets              清单（?scope=library|session|all  &kind=  &q=  &refresh=1）
            #   GET /api/asset/<ref>         单件元数据（ref 可只给前 8 位以上，唯一才认）
            #   GET /api/asset_media/<ref>   字节（带 Range，<video> 的 seek 靠它；内容寻址，可长缓存）
            #   GET /api/asset_thumb/<ref>   缩略图（图片才生成，落 .thumbs/；?w=160）
            # ref = 文件名 stem（新货是 md5(bytes)，老货沿用 md5(base64) —— 见 asset_store 顶部注释）。
            req = urlparse(self.path)
            if req.path.rstrip('/') == '/api/assets':
                qs = parse_qs(req.query)
                scope = (qs.get('scope') or ['all'])[0]
                kind = (qs.get('kind') or [''])[0]
                needle = (qs.get('q') or [''])[0].strip().lower()
                refresh = (qs.get('refresh') or ['0'])[0].lower() in ('1', 'true', 'yes')
                try:
                    items = asset_store.records(refresh=refresh)
                    if kind and kind not in ('all', '*'):
                        items = [it for it in items if it['kind'] == kind]
                    if scope == 'library':
                        items = [it for it in items if it['inLibrary']]
                    elif scope == 'session':
                        items = [it for it in items if not it['inLibrary']]
                    if needle:
                        items = [it for it in items
                                 if needle in it['name'].lower() or needle in it['id']
                                 or needle in it['origin'].lower()]
                    self._send_json({'ok': True, 'dir': _global_assets_dir(), 'scope': scope,
                                     'total': len(items), 'assets': items})
                except Exception as e:
                    self._send_json({'ok': False, 'error': str(e), 'assets': []}, 500)
                return

            if urlparse(self.path).path == '/api/cud_asset':
                qs = parse_qs(urlparse(self.path).query)
                cud_path = unquote((qs.get('path') or [''])[0])
                try:
                    aid = int((qs.get('id') or ['-1'])[0])
                except (TypeError, ValueError):
                    aid = -1
                data = cud_asset_bytes(cud_path, aid)
                if data is None:
                    self.send_error(404)
                    return
                if data[:8] == b'\x89PNG\r\n\x1a\n':
                    ctype = 'image/png'
                elif data[:2] == b'\xff\xd8':
                    ctype = 'image/jpeg'
                else:
                    ctype = 'application/octet-stream'
                self.send_response(200)
                self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'max-age=3600')
                self.end_headers()
                self.wfile.write(data)
                return

            if req.path.startswith('/api/asset_media/'):
                ref = unquote(req.path[len('/api/asset_media/'):]).strip('/')
                path = asset_store.path_of(ref)
                if not path or not _send_media_file(self, path):
                    self.send_error(404)
                return

            if req.path.startswith('/api/asset_thumb/'):
                ref = unquote(req.path[len('/api/asset_thumb/'):]).strip('/')
                qs = parse_qs(req.query)
                try:
                    tw = int((qs.get('w') or ['160'])[0])
                except (TypeError, ValueError):
                    tw = 160
                tp = asset_store.thumb_path(ref, tw)
                if not tp:
                    self.send_error(404)
                    return
                data = open(tp, 'rb').read()
                self.send_response(200)
                self.send_header('Content-type', 'image/jpeg')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'max-age=31536000, immutable')
                self.end_headers()
                self.wfile.write(data)
                return

            if req.path == '/api/cud_frame_thumb':
                # ?path=<.cud 绝对路径>&w=96 — 时间线帧卡上的 .cud 绑定预览：合成图的缩略。
                # 路径只来自用户挑进工程的绑定（kind:'cud' 的帧引用），非 .cud / 不在盘上一律 404。
                qs = parse_qs(req.query)
                p = (qs.get('path') or [''])[0]
                try:
                    tw = int((qs.get('w') or ['96'])[0])
                except (TypeError, ValueError):
                    tw = 96
                tp = cud_thumb_path(p, tw) if p.lower().endswith('.cud') else None
                if not tp:
                    self.send_error(404)
                    return
                data = open(tp, 'rb').read()
                self.send_response(200)
                self.send_header('Content-type', 'image/jpeg')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                self.wfile.write(data)
                return

            if req.path.startswith('/api/asset/'):
                ref = unquote(req.path[len('/api/asset/'):]).strip('/')
                rec = asset_store.get(ref)
                if not rec:
                    self._send_json({'ok': False, 'error': 'not found', 'ref': ref}, 404)
                    return
                rec.pop('path', None)
                self._send_json({'ok': True, 'asset': rec})
                return

            # 资产媒体库：Video 工程 Assets 的文件伺服（带 Range —— <video> 的 seek 靠它）。
            # A5 起 `_vid_media_path` 会先看 media/vid（派生缓存/老货）、再看资产仓库：
            # 同一张 URL 面，字节的家已经搬进 `data/assets/`。
            if self.path.startswith('/api/vid_media/'):
                # 文件名里的空格/中文等会被浏览器百分号编码（`Rabbit%20Dance_.mp4`）：这里必须解码
                # 回来，否则拼出的路径永远对不上盘上的文件 → 404 → <video> 报
                # MEDIA_ERR_SRC_NOT_SUPPORTED（videoWidth=0，播放头照走、画面全空）。
                path = _vid_media_path(unquote(urlparse(self.path).path[len('/api/vid_media/'):]))
                if not (path and _send_media_file(self, path)):
                    self.send_error(404)
                return

            # 按需帧提取：片段的头/尾帧（t 跟着片段的 offset/duration 走，裁剪即新帧）。
            if self.path.startswith('/api/vid_frame'):
                qs = parse_qs(urlparse(self.path).query)
                # `f` 是媒体引用：老 `<file>` / 新 `<hash>.<ext>` 都行；`d=global` 仍被接受，
                # 但解析已经统一走 `_vid_media_path`（仓库那一侧自己会兜住）。
                path = _vid_media_path((qs.get('f') or [''])[0])
                try:
                    t = float((qs.get('t') or ['0'])[0])
                except ValueError:
                    t = 0.0
                jpg = _vid_frame(path, t) if path else None
                if not jpg:
                    self.send_error(404)
                    return
                data = open(jpg, 'rb').read()
                self.send_response(200)
                self.send_header('Content-type', 'image/jpeg')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'max-age=31536000, immutable')
                self.end_headers()
                self.wfile.write(data)
                return

            # 整条缩略帧：一次抽 n 张铺满全片，供时间线拖动/裁剪时跟手预览。
            if self.path.startswith('/api/vid_strip'):
                qs = parse_qs(urlparse(self.path).query)
                try:
                    n = int((qs.get('n') or ['16'])[0])
                except ValueError:
                    n = 16
                # 解析同 `/api/vid_frame`：`f` 可以是老文件名或仓库哈希；`d=global` 不再需要，
                # 但仍然接受（老页面/老探针还在发）。
                path = _vid_media_path((qs.get('f') or [''])[0])
                urls = _vid_strip(path, n) if path else []
                self._send_json({'ok': bool(urls), 'urls': urls or []})
                return

            self.send_error(404)

        def do_POST(self):
            inst = self.server_instance

            # 界面探针的"拉一下"：把 want 立起来，页面下一次心跳就会自己抓一份送上来。
            probe_post = urlparse(self.path).path
            if probe_post == '/api/ui_probe/pull':
                _UI_PROBE_PULL['want'] = time.time()
                self._send_json({'ok': True, 'want': _UI_PROBE_PULL['want']})
                return

            # ── 公共时间基准的写口 ── 传输条按一下 = 落到这里一次（play / pause / toggle /
            # seek / rate / speed）。前端**不自己算位置**：它只是把意图说出来，位置由这一个宿主给。
            if probe_post == '/api/clock':
                if clock_bridge is None:
                    self._send_json({'error': 'clock bridge unavailable'}, 500)
                    return
                _len = int(self.headers.get('Content-Length', 0))
                _data = json.loads(self.rfile.read(_len)) if _len else {}
                try:
                    _snap = clock_bridge.get_clock().apply(
                        str(_data.get('action') or ''), _data.get('value'))
                    # **谁按了播放，时间线的 PCM 就归谁**：这条是音频作者的唯一来源。
                    # 多窗不会互相抢（各自只看到"在播"是镜像）；旧页面点播不带 session，
                    # 就把作者清空 —— 它那边另有 WebAudio，引擎这边不该再叠一份。
                    if audio_bridge is not None and isinstance(_snap, dict) and _snap.get('playing'):
                        audio_bridge.get_engine().pcm_set_owner(str(_data.get('session') or ''))
                    self._send_json(_snap)
                except Exception as _exc:      # noqa: BLE001 —— 参数错了要说清，不是 500
                    self._send_json({'error': str(_exc)}, 400)
                return

            # ── 原生发声引擎的写口 ── open / close / tracks / notes / audition / panic。
            # 音符与轨道是**整张表**推过来（不是增量）：一次十几 KB，比维护两套增量协议稳。
            if probe_post == '/api/audio':
                if audio_bridge is None:
                    self._send_json({'available': False, 'error': 'audio bridge unavailable'}, 500)
                    return
                _len = int(self.headers.get('Content-Length', 0))
                _data = json.loads(self.rfile.read(_len)) if _len else {}
                try:
                    # 存音色要落盘到乐器库：文件名/预设根由这边定（见 _audio_editor_save）
                    if str(_data.get('op') or '') == 'editor_save':
                        self._send_json(_audio_editor_save(_data))
                        return
                    self._send_json(audio_bridge.get_engine().apply(
                        str(_data.get('op') or ''), _data))
                except ValueError as _exc:
                    self._send_json({'error': str(_exc)}, 400)
                except Exception as _exc:      # noqa: BLE001
                    self._send_json({'error': str(_exc)}, 500)
                return
            if probe_post == '/api/ui_probe/ack':
                _UI_PROBE_PULL['done'] = time.time()
                self._send_json({'ok': True})
                return
            if probe_post == '/api/ui_probe/res':
                # 页面把表达式的求值结果交回来，唤醒正在 /eval 上等着的那个人。
                _len = int(self.headers.get('Content-Length', 0))
                _data = json.loads(self.rfile.read(_len)) if _len else {}
                with _UI_PROBE_CV:
                    _UI_PROBE_RES[str(_data.get('id') or '')] = {
                        'ok': bool(_data.get('ok')), 'value': _data.get('value'), 'error': _data.get('error')}
                    _UI_PROBE_CV.notify_all()
                self._send_json({'ok': True})
                return
            if probe_post == '/api/ui_probe/eval':
                _len = int(self.headers.get('Content-Length', 0))
                _data = json.loads(self.rfile.read(_len)) if _len else {}
                expr = str(_data.get('expr') or '')
                try:
                    wait_s = float(_data.get('timeout') or 20)
                except (TypeError, ValueError):
                    wait_s = 20.0
                if not expr:
                    self._send_json({'ok': False, 'error': 'empty expr'}, 400)
                    return
                if not _UI_PROBE_SESS:
                    self._send_json({'ok': False,
                                     'error': '没有页面接上来：页面要加载带巡检回路的产物（刷新一次）'}, 409)
                    return
                cid = '%x%x' % (int(time.time() * 1000) & 0xffffffff, id(_data) & 0xffff)
                _UI_PROBE_INBOX.put({'id': cid, 'expr': expr, 'at': time.time()})
                deadline = time.time() + max(1.0, min(wait_s, 60))
                with _UI_PROBE_CV:
                    while cid not in _UI_PROBE_RES and time.time() < deadline:
                        _UI_PROBE_CV.wait(timeout=max(0.05, deadline - time.time()))
                    res = _UI_PROBE_RES.pop(cid, None)
                if res is None:
                    self._send_json({'ok': False, 'error': '超时：指令发出去了，没有页面回来'}, 504)
                else:
                    self._send_json(res)
                return

            # 界面探针收到一份快照：落盘 + 回文件名。前端拿到文件名就够说清"存在哪了"。
            if probe_post == '/api/ui_probe':
                try:
                    from ...libs import ui_probe_store as ups
                    length = int(self.headers.get('Content-Length', 0))
                    snap = json.loads(self.rfile.read(length)) if length else {}
                    info = ups.save(snap)
                    build = ups.build_info()
                    problems = snap.get('problems') or []
                    print('[UIProbe] saved %s (%dKB, %d problems: %s) build=%s stale=%s'
                          % (info['file'], info['bytes'] // 1024, len(problems),
                             ','.join(sorted({str(p.get('code')) for p in problems}))[:200],
                             (snap.get('build') or '?'), build.get('stale')))
                    self._send_json({'ok': True, 'file': info['file'], 'dir': info['dir'],
                                     'bytes': info['bytes'], 'build': build})
                except Exception as e:
                    print('[UIProbe] rejected snapshot: %s' % e)
                    self._send_json({'ok': False, 'error': str(e)}, 400)
                return

            # 同上:POST 侧的 /api/agent/*(send/tool/cancel/config)。
            if urlparse(self.path).path.startswith('/api/agent'):
                if agent_backend is None:
                    self._send_json({'ok': False, 'error': 'agent backend failed to import — check the '
                        'ComfyUI console for "[SnapshotDetailerSampler] Warning: cannot import agent_backend" '
                        '(usually a missing dependency, e.g. pip install requests into this python)'}, 503)
                    return
                agent_backend.handle(self)
                return

            if self.path == '/api/update_config':
                length = int(self.headers.get('Content-Length', 0))
                data = json.loads(self.rfile.read(length)) if length else {}
                inst._apply_params(data)
                self._send_json({'ok': True})
                return

            # 会话恢复的写口：宿主把工作台播报的活动文档集（.cud 路径，打开序）落盘。
            # 下一次页面打开时 GET /api/open_cuds 从这份记录原样重开。
            if self.path == '/api/open_cuds':
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    doc_io.remember_open_cuds(body.get('paths'))
                    self._send_json({'ok': True})
                except Exception as e:
                    self._send_json({'ok': False, 'error': str(e)}, 500)
                return

            if self.path == '/api/prompt_presets':
                # Prompt preset 管理：Prompt 块引用的共享 selection 模板（prompt_node.html
                # 的 preset 作用域 iframe 通过 action=save 写入），持久化到
                # data/sampler/prompt_presets.json。action: create | save | rename | delete。
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    action = body.get('action') or ''
                    if action == 'create':
                        self._send_json({'ok': True, 'preset': inst._create_prompt_preset(body.get('name'))})
                    elif action == 'save':
                        selection = body.get('selection')
                        if not isinstance(selection, dict):
                            self._send_json({'ok': False, 'error': 'selection must be an object'}, 400)
                        elif inst._save_prompt_preset_selection(body.get('id') or '', selection):
                            self._send_json({'ok': True})
                        else:
                            self._send_json({'ok': False, 'error': 'preset not found'}, 404)
                    elif action == 'rename':
                        if inst._rename_prompt_preset(body.get('id') or '', body.get('name')):
                            self._send_json({'ok': True})
                        else:
                            self._send_json({'ok': False, 'error': 'preset not found or bad name'}, 404)
                    elif action == 'delete':
                        if inst._delete_prompt_preset(body.get('id') or ''):
                            self._send_json({'ok': True})
                        else:
                            self._send_json({'ok': False, 'error': 'preset not found'}, 404)
                    else:
                        self._send_json({'ok': False, 'error': f'unknown action {action!r}'}, 400)
                except Exception as e:
                    self._send_json({'ok': False, 'error': str(e)}, 500)
                return

            # 布局档案的写口。action:            #   save    —— `{name, dock}`：同名覆盖（同一个槽位更新），新的排最前，最多 40 份；
            #   delete  —— `{name}`：只删档案，屏幕上那份布局不动；删掉的若是默认，默认一起清掉；
            #   default —— `{name}`：把这一份设成默认（空 = 取消默认）。页面每次打开从这里起手。
            # 回的还是**整份**档案，前端拿它当唯一真相：不用自己猜"刚才那次写到底成没成"。
            if self.path == '/api/layouts':
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    store, err = _layouts_apply(str(body.get('action') or 'save'),
                                                str(body.get('name') or ''), body.get('dock'))
                    if err:
                        self._send_json({'ok': False, 'error': err[1]}, err[0])
                        return
                    self._send_json({'ok': True, 'kind': 'layouts',
                                     'default': store['default'], 'items': store['items'],
                                     'current': store['current']})
                except Exception as e:
                    self._send_json({'ok': False, 'error': str(e)}, 500)
                return

            # Video 资产入库：body = 文件字节，?name= 原文件名。后端落盘 + ffprobe + 按需转
            # H.264 代理（见 _vid_ingest 顶上的说明）。前端拿回持久 src 喂给 Assets / Tracks。
            if self.path.startswith('/api/vid_ingest'):
                try:
                    qs = parse_qs(urlparse(self.path).query)
                    name = (qs.get('name') or ['media'])[0]
                    length = int(self.headers.get('Content-Length', 0))
                    raw = self.rfile.read(length) if length else b''
                    res = _vid_ingest(raw, name)
                    self._send_json(res, 200 if res.get('ok') else 500)
                except Exception as e:
                    self._send_json({'ok': False, 'error': str(e)}, 500)
                return

            # 时间线多选视频段的合并：body = {parts: [{f, in, out}...], name}。
            # 后端按入出点切好后拼成一条新文件（见 _vid_merge），前端拿回持久 src 原位替换。
            if self.path == '/api/vid_merge':
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    res = _vid_merge(body.get('parts'), str(body.get('name') or 'merged'))
                    self._send_json(res, 200 if res.get('ok') else 500)
                except Exception as e:
                    self._send_json({'ok': False, 'error': str(e)}, 500)
                return

            if self.path == '/api/execute_interface':
                length = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(length)) if length else {}
                interface_index = body.get('interface_index', 0)
                manual_values = body.get('manual_values', {})
                exec_options = body.get('exec_options', {})
                inst.put_action('execute_interface', interface_index=interface_index, manual_values=manual_values, exec_options=exec_options)
                self._send_json({'ok': True})
                return

            if self.path == '/api/preset_video':
                # 视频模式的 Pipeline Preset 跑：一段一段来（宿主按段发），每段 = 抽帧 →
                # 逐帧过 preset 的 block 链 → 编码回 mp4。与 execute_interface 同一条队列/
                # 同一套轮询口径，只是状态字段换成 preset_video_*。
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    inst.put_action('preset_video',
                                    preset_id=body.get('preset_id') or None,
                                    extra_prompt=body.get('extra_prompt') or '',
                                    video_inputs=body.get('video_inputs') or {},
                                    mask_input=body.get('mask_input') or None)
                    self._send_json({'ok': True})
                except Exception as e:
                    self._send_json({'ok': False, 'error': str(e)}, 500)
                return

            if self.path == '/api/switch_pipeline':
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    package_idx = int(body.get('package_idx', 0))
                    pipeline_idx = int(body.get('pipeline_idx', 0))
                    if not inst or package_idx >= len(inst.pipeline_packages):
                        self._send_json({'success': False, 'error': 'Invalid package index'}, 400)
                        return
                    pkg = inst.pipeline_packages[package_idx]
                    pipelines = pkg.get('pipelines', [])
                    if pipeline_idx >= len(pipelines):
                        self._send_json({'success': False, 'error': 'Invalid pipeline index'}, 400)
                        return
                    pipeline_info = pipelines[pipeline_idx]
                    # 加载本身（执行上游节点 + 换 current/base pipeline + 架构与 lora_regex）
                    # 与 run 循环里 preset 绑定用的是同一份代码。
                    ok, err = inst.node_instance._load_pipeline_from_node(
                        inst, pipeline_info.get('node_id', ''), pipeline_info.get('name', ''))
                    self._send_json({'success': True} if ok
                                    else {'success': False, 'error': err}, 200 if ok else 500)
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'success': False, 'error': str(e)}, 500)
                return

            if self.path == '/api/select_image':
                length = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(length)) if length else {}
                key = body.get('key', '')
                inst.put_action('select_image', key=key)
                self._send_json({'ok': True})
                return

            if self.path == '/api/finish':
                length = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(length)) if length else {}
                selected_keys = body.get('selected_keys')
                if selected_keys is not None and isinstance(selected_keys, list):
                    inst.finish_selected_keys = selected_keys
                    inst.finish_selected_key = selected_keys[0] if len(selected_keys) == 1 else None
                else:
                    # 兼容旧格式 single key
                    selected_key = body.get('selected_key')
                    inst.finish_selected_key = selected_key
                    inst.finish_selected_keys = [selected_key] if selected_key else None
                inst.finished = True
                inst.put_action('finish')
                print("[SnapshotDetailerSampler] Finish action received, selected_keys:", inst.finish_selected_keys)
                # 唤醒 prompt 以防阻塞
                if inst.prompt_server:
                    inst.prompt_server.prompt_event.set()
                self._send_json({'ok': True})
                return

            if self.path == '/api/query_answer':
                # 一个 Query 块正停在链条里等用户挑 prompt。`selection` 是 prompt UI 的 raw
                # 选择（后端按 prompt 块同样的规则合并 + 跑 programs）；`cancelled` = 用户
                # 关掉了弹窗 —— 整条链中止。
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    answered = inst._answer_pending_query(
                        selection=body.get('selection'),
                        cancelled=bool(body.get('cancelled')),
                    ) if inst else False
                    self._send_json({'success': answered})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'success': False, 'error': str(e)}, 500)
                return

            if self.path == '/api/cancel_run':
                # 工作台浮出的 Cancel 按钮。点击 = 走 ComfyUI 的原生打断：
                # 全局 interrupt 标志让 KSampler 在下一个采样步抛
                # InterruptProcessingException；块循环里的检查点会在 block / Generate
                # Text 边界抛同一个异常。run_detailer 的 except 把它转成
                # status='cancelled'（不炸节点、不停 server）。
                try:
                    mm.interrupt_current_processing(True)
                    print("[SnapshotDetailerSampler] Cancel requested — interrupt flag set")
                    self._send_json({'success': True})
                except Exception as e:
                    self._send_json({'success': False, 'error': str(e)}, 500)
                return

            if urlparse(self.path).path in ('/api/asset_update', '/api/asset_delete'):
                # 仓库的管理口（A1 起的"改造/删除"）：
                #   update {id, name?, tags?}  —— 只改表里的元数据，不碰字节
                #   delete {id}                —— 删字节 + 缩略图 + 表记录（引用检查 A6 才做）
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    aid = str(body.get('id') or '').strip()
                    if not aid:
                        self._send_json({'ok': False, 'error': 'No id'}, 400)
                        return
                    if urlparse(self.path).path == '/api/asset_update':
                        rec = asset_store.update_meta(
                            aid, name=body.get('name'), tags=body.get('tags'))
                        if not rec:
                            self._send_json({'ok': False, 'error': 'not found', 'id': aid}, 404)
                            return
                        rec.pop('path', None)
                        self._send_json({'ok': True, 'asset': rec})
                        return
                    gone = asset_store.delete(aid)
                    self._send_json({'ok': bool(gone), 'removed': gone})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'ok': False, 'error': str(e)}, 500)
                return

            if urlparse(self.path).path == '/api/assets_exist':
                # 批量"这些哈希还在不在"（A5 的缺失/relink）：打开工程与每次改动后问一次，
                # 缺的片段画红线、Assets 卡挂 MISSING。只读仓库，不写任何东西。
                # body = {ids: [hash…]} → {ok, have:[…], missing:[…]}（顺序按传入）。
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    ids = body.get('ids') if isinstance(body, dict) else None
                    want = [str(i).strip() for i in (ids or []) if str(i).strip()]
                    have, missing = [], []
                    for aid in dict.fromkeys(want):      # 去重但保序
                        (have if asset_store.get(aid) else missing).append(aid)
                    self._send_json({'ok': True, 'have': have, 'missing': missing})
                except Exception as e:
                    self._send_json({'ok': False, 'error': str(e)}, 500)
                return

            if urlparse(self.path).path == '/api/asset_import':
                # 往仓库里放字节（A0 的唯一写口）：{images:[dataURL…], names:[…], library?:bool, origin?}
                # 也收单张 {data|image:'dataURL', name}。id 由**内容**决定（md5(bytes)），
                # 同一张图重复导入不长第二份 —— 调用方拿返回的 id 就能当引用用。
                # `library` 默认 true：用户/接口主动导进来的货就是库成员（A1 才会出现 session 的写入方）。
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    raw = body.get('images')
                    if not isinstance(raw, list) or not raw:
                        raw = [body.get('data') or body.get('image') or '']
                    raw = [u for u in raw if isinstance(u, str) and u]
                    if not raw:
                        self._send_json({'ok': False, 'error': 'No image data'}, 400)
                        return
                    names = body.get('names') if isinstance(body.get('names'), list) else None
                    library = body.get('library', True)
                    origin = str(body.get('origin') or 'upload')
                    added, failed = [], 0
                    for idx, dataurl in enumerate(raw):
                        data = asset_store.dataurl_bytes(dataurl)
                        if not data:
                            failed += 1
                            continue
                        nm = None
                        if names and idx < len(names) and names[idx]:
                            nm = names[idx]
                        elif len(raw) == 1:
                            nm = body.get('name')
                        rec = asset_store.put_bytes(data, name=nm, origin=origin,
                                                    library=bool(library))
                        if rec:
                            rec.pop('path', None)
                            added.append(rec)
                        else:
                            failed += 1
                    self._send_json({'ok': bool(added), 'added': added, 'failed': failed,
                                     'error': None if added else 'All images failed to decode'})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'ok': False, 'error': str(e)}, 500)
                return

            if self.path == '/api/staging':
                # 工作区批量上传：{images: [dataURL, ...], name?} → 逐张解码存 tensor。
                # 返回新条目（含 id），调用方立刻能把 id 设成 Ref Image / 加为图层。
                # replace=True = 整池换水（staging 是 .cud 的文档态）：先逐掉全部**可见**条目，
                # 再按 ids 原样落回 —— Extra Prompt chip 与 fx 绑定都按编号引用图池，换 mint
                # 会让它们指错图。hidden 条目（run 的 seed、Processor 输入/产出）是会话的
                # 在途数据，不属于任何文档，换水不动它。空 images + replace = 纯清空。
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    replace = bool(body.get('replace'))
                    ids = body.get('ids') if isinstance(body.get('ids'), list) else None
                    if replace:
                        for old in list(inst.staging_items):
                            if not old.get('hidden'):
                                inst._staging_tensors.pop(old['id'], None)
                        inst.staging_items = [s for s in inst.staging_items if s.get('hidden')]
                    images = body.get('images')
                    if not isinstance(images, list) or not images:
                        images = [body.get('image', '')]
                    images = [u for u in images if isinstance(u, str) and u]
                    if not images:
                        if replace:
                            self._send_json({'success': True, 'added': []})
                            return
                        self._send_json({'success': False, 'error': 'No image data'}, 400)
                        return

                    added = []
                    names = body.get('names') if isinstance(body.get('names'), list) else None
                    for idx, dataurl in enumerate(images):
                        try:
                            tensor = dataurl_to_tensor(dataurl)
                        except Exception as dec_err:
                            print(f"[Staging] skipped image #{idx + 1}: {dec_err}")
                            continue
                        chosen = names[idx] if (names and idx < len(names) and names[idx]) else None
                        sid = (ids[idx] if (replace and ids and idx < len(ids)
                                           and isinstance(ids[idx], str) and ids[idx]) else None)
                        if replace:
                            # 换水落回文档自带条目：名字逐条原样用，不再加 " #N" 后缀。
                            name = chosen or body.get('name') or 'Loaded'
                        else:
                            base_name = chosen or body.get('name') or 'Loaded'
                            name = base_name if len(images) == 1 else f"{base_name} #{len(inst.staging_items) + 1}"
                        # hidden=True（Processor 的输入等）只进图池不进条带 —— 跟接口产出同款。
                        sid = inst.add_staging(tensor, name=name, hidden=bool(body.get('hidden')), sid=sid)
                        added.append({'id': sid, 'name': name, 'src': dataurl})
                    if not added:
                        self._send_json({'success': False, 'error': 'All images failed to decode'}, 400)
                        return
                    if replace:
                        # 计数器顶到现存最大数字号之后，之后新加的才不会撞文档带回来的号。
                        for s in inst.staging_items:
                            m = re.match(r'staging_(\d+)$', s['id'])
                            if m:
                                inst._staging_counter = max(inst._staging_counter, int(m.group(1)))
                    self._send_json({'success': True, 'added': added})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'success': False, 'error': str(e)}, 500)
                return

            if self.path == '/api/staging_remove':
                # 从工作区移除一个条目（张量引用一并释放）。
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    sid = body.get('id', '')
                    before = len(inst.staging_items)
                    inst.staging_items = [s for s in inst.staging_items if s['id'] != sid]
                    inst._staging_tensors.pop(sid, None)
                    self._send_json({'success': True, 'removed': before - len(inst.staging_items)})
                except Exception as e:
                    self._send_json({'success': False, 'error': str(e)}, 500)
                return

            if self.path == '/api/guidance_card':
                # Guidances 栈的唯一总卡：image = 合成好的 PNG dataURL（Layers 合成 + 整个
                # guidance 栈压在上面），原地替换保留条目；image 为空 = 撤回这张卡（栈被清空）。
                # 客户端不能指定 id —— 这张卡只可能落在 GUIDANCE_STAGING_ID 那一格。
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    dataurl = body.get('image')
                    if not isinstance(dataurl, str) or not dataurl:
                        before = len(inst.staging_items)
                        inst.staging_items = [s for s in inst.staging_items if s['id'] != GUIDANCE_STAGING_ID]
                        inst._staging_tensors.pop(GUIDANCE_STAGING_ID, None)
                        self._send_json({'success': True, 'withdrawn': before != len(inst.staging_items)})
                        return
                    try:
                        tensor = dataurl_to_tensor(dataurl)
                    except Exception as dec_err:
                        self._send_json({'success': False, 'error': f'Could not decode the guidance image ({dec_err})'}, 400)
                        return
                    sid = inst.add_staging(tensor, name=body.get('name') or 'Guidance',
                                           sid=GUIDANCE_STAGING_ID)
                    self._send_json({'success': True, 'id': sid})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'success': False, 'error': str(e)}, 500)
                return

            if self.path == '/api/resize_image':
                # 工作区条目缩放变体：源条目不动，产物作为新条目进工作区。
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    sid = body.get('id', '')
                    width = int(body.get('width', 0))
                    height = int(body.get('height', 0))
                    if not sid or width <= 0 or height <= 0:
                        self._send_json({'success': False, 'error': 'Invalid id, width or height'}, 400)
                        return
                    # 获取工作区图片 tensor
                    tensor = inst.get_staging_image(sid)
                    if tensor is None:
                        self._send_json({'success': False, 'error': 'Image not found'}, 404)
                        return
                    # tensor 可能是 [B,H,W,C] 或 [H,W,C]
                    if tensor.dim() == 4:
                        img = tensor[0]
                    elif tensor.dim() == 3:
                        img = tensor
                    else:
                        self._send_json({'success': False, 'error': f'Unexpected tensor dim: {tensor.dim()}'}, 400)
                        return
                    # img: [H,W,C] float32 0-1
                    orig_h, orig_w = img.shape[0], img.shape[1]
                    # numpy → PIL resize → numpy
                    arr = (img.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
                    pil_img = Image.fromarray(arr)
                    pil_img = pil_img.resize((width, height), Image.LANCZOS)
                    arr2 = np.array(pil_img).astype(np.float32) / 255.0
                    resized_tensor = torch.from_numpy(arr2)
                    if tensor.dim() == 4:
                        resized_tensor = resized_tensor.unsqueeze(0)
                    # 添加到工作区
                    name = None
                    for s in inst.staging_items:
                        if s['id'] == sid:
                            name = f"{s['name']} ({width}x{height})"
                            break
                    new_id = inst.add_staging(resized_tensor, name=name)
                    new_item = next((s for s in inst.staging_items if s['id'] == new_id), None)
                    self._send_json({'success': True, 'id': new_id,
                                     'item': new_item if new_item is not None else {'id': new_id, 'name': name}})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'success': False, 'error': str(e)}, 500)
                return

            if self.path == '/api/load_from_assets':
                try:
                    if inst.node_instance is None:
                        self._send_json({'success': False, 'error': 'Node instance not available'})
                        return
                    asset_data = inst.asset or ''
                    if not asset_data or not asset_data.strip():
                        self._send_json({'success': False, 'error': 'No asset data configured'})
                        return
                    count = inst.node_instance._load_from_assets(inst, asset_data)
                    self._send_json({'success': True, 'count': count})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'success': False, 'error': str(e)}, 500)
                return

            if self.path == '/api/pose_estimate':
                # 工作台「从图取姿态」那一颗按钮的背面。两种来源：
                #   staging 给 id —— 图就在服务端手里（张量缓存, 淘汰了就从条目自带 src 恢复），
                #                      不再走一次 base64 往返；
                #   layer   给 dataURL —— 图层像素只活在浏览器里，前端折合完 decal/FX/蒙版再送来。
                # 回的是 DWPose 的 POSE_KEYPOINT 字典原样（people 全给，选哪个人由前端按占幅决定）。
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    source = body.get('source')
                    if source == 'staging':
                        sid = body.get('id')
                        tensor = inst.get_staging_image(sid) if isinstance(sid, str) and sid else None
                        if tensor is None:
                            self._send_json({'success': False,
                                             'error': f'Workspace image {sid} is gone'}, 404)
                            return
                    elif source == 'layer':
                        png = body.get('png')
                        if not isinstance(png, str) or not png:
                            self._send_json({'success': False, 'error': 'No layer pixels sent'}, 400)
                            return
                        tensor = dataurl_to_tensor(png)
                    else:
                        self._send_json({'success': False, 'error': f'Unknown pose source {source}'}, 400)
                        return
                    try:
                        t0 = time.time()
                        pose_json = pose_estimate(tensor)
                    except Exception as est_err:
                        # 缺 controlnet_aux / 缺 onnxruntime / 模型下不来，都是这一句。
                        import traceback
                        traceback.print_exc()
                        self._send_json({'success': False,
                                         'error': f'DWPose unavailable: {est_err}'}, 503)
                        return
                    people = len((pose_json or {}).get('people') or [])
                    ms = round((time.time() - t0) * 1000)
                    print(f"[Pose estimate] {pose_json.get('canvas_width')}×"
                          f"{pose_json.get('canvas_height')} → {people} people in {ms}ms")
                    self._send_json({'success': True, 'pose': pose_json,
                                     'people': people, 'ms': ms})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'success': False, 'error': str(e)}, 500)
                return

            if self.path == '/api/blend_action':
                # Blend 工作台的统一入口：一次合成（图在 tensor 上，不走 PNG 往返），三种分派。
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    action = body.get('action', '')
                    if action not in ('blend', 'tag', 'detailer', 'layer_generate', 'clear_tag', 'detect'):
                        self._send_json({'success': False, 'error': f'Unknown action: {action}'}, 400)
                        return

                    # Clear Tag: touches only the prompt stage — no canvas, no composite, no
                    # tagger. Running _apply_tag_result('') drops the parsing-source tags exactly
                    # the way a real tag replaces them, and returns empty tag/tags/custom so the
                    # host pushes a cleared state into the prompt editor.
                    if action == 'clear_tag':
                        parsed_selected, parsed_temporary = inst._apply_tag_result('')
                        self._send_json({'success': True, 'tag': '', 'tags': parsed_selected, 'custom': '', 'temporary': parsed_temporary})
                        return

                    # layer_generate does NOT go through compose_blend: the caller sends one layer's
                    # own image and that layer's own mask as separate payloads, because the layer may
                    # be smaller than / offset on the canvas and the canvas composite is not what it
                    # wants refined. Nothing about the canvas is involved.
                    if action == 'layer_generate':
                        layer_image = decode_image_dataurl(body.get('layer_image'))
                        if layer_image is None:
                            self._send_json({'success': False, 'error': 'That layer has no decodable image'}, 400)
                            return
                        # The layer's own mask is authored at the layer's native size, so it is
                        # decoded in that space rather than against the canvas.
                        layer_h, layer_w = int(layer_image.shape[0]), int(layer_image.shape[1])
                        layer_mask = decode_mask_alpha(
                            body.get('layer_mask'), layer_w, layer_h, collapse_opaque=False,
                        )
                        if layer_mask is None or float(layer_mask.sum()) == 0:
                            self._send_json({'success': False, 'error': 'Mask is required — paint that layer\'s own mask before generating'}, 400)
                            return
                        if layer_image.dim() == 3:
                            layer_image = layer_image.unsqueeze(0)
                        # The Generate dialog's Pipeline Preset enum: which block set runs this
                        # generate. Invalid/absent ids fall back to the server's runner chain.
                        preset_id = body.get('preset_id')
                        if not isinstance(preset_id, str) or not preset_id:
                            preset_id = None
                        # Enable Edit 下 prompt 里 <image N> 引用缺 ref image 时不启动本次 run，
                        # 把缺口回给前端，由它弹窗从工作区让用户补图（见 edit_ref_shortfall）。
                        _shortfall = inst.edit_ref_shortfall(preset_id, (body.get('extra_prompt') or '').strip())
                        if _shortfall is not None:
                            self._send_json({'success': False, 'ref_request': _shortfall,
                                             'error': 'This prompt references a ref image — pick one from the workspace'})
                            return
                        inst.blend_image = layer_image
                        inst.blend_mask = layer_mask.squeeze(-1)
                        inst.blend_prompt = (body.get('extra_prompt') or '').strip()
                        # Consumed once by the main loop, then cleared, so a later toolbar run is
                        # not silently stuck on this preset.
                        inst.pending_generate_preset = preset_id
                        inst.put_action('run_detailer', from_blend=True, extra_prompt=inst.blend_prompt)
                        self._send_json({'success': True})
                        return

                    # detailer：前端 blendCanvas 已经把图层栈合成好了 —— 预览里看到
                    # 的就是这张图（浏览器原生 source-over，直通 alpha PNG）。直接把它
                    # 送进管线，不再让后端按 layers 重合成一遍，消除两套合成语义漂移在
                    # 蒙版边缘产生的灰色条带。解不出图（旧前端 / 画布被污染）时回落到
                    # 后端合成。Layer Tag 也走这条：前端把「合成图按该 Layer 原生网格抠好 +
                    # 该 Layer 自带蒙版」预制送来，后端直接复用现成的 mask/covered/full 语义喂 tagger。
                    comp = decode_image_dataurl(body.get('composite')) if action in ('detailer', 'tag', 'detect') else None
                    if comp is not None:
                        if comp.dim() == 3:
                            comp = comp.unsqueeze(0)
                        _ch, _cw = int(comp.shape[1]), int(comp.shape[2])
                        image = comp
                        mask = decode_mask_alpha(body.get('mask'), _cw, _ch, collapse_opaque=False)
                        if mask is not None:
                            mask = mask.squeeze(-1)
                    else:
                        image, mask = inst.compose_blend(
                            body.get('layers') or [],
                            width=body.get('width'), height=body.get('height'),
                            mask_data_url=body.get('mask'),
                            attributes=body.get('attributes'),
                        )

                    if action == 'blend':
                        # 合成图不再进工作区（工作区只收用户主动拖入的图）—— 以 dataURL
                        # 返回，前端把它作为新的智能图层加到画布顶层（图层自带像素，
                        # 不绑 id）。想让它进工作区的用户会自己拖进来。
                        self._send_json({'success': True, 'id': None,
                                         'image': tensor_to_base64(image)})
                        return

                    if action == 'tag':
                        # 纯读取：拿画布合成图 + Mask 层打标，结果只写进 prompt 阶段
                        if inst.tagger is None:
                            self._send_json({'success': False, 'error': 'Tagger not configured'})
                            return
                        if inst.node_instance is None:
                            self._send_json({'success': False, 'error': 'Node not ready'})
                            return
                        mode = body.get('tag_mode', 'mask')
                        tag = inst.node_instance._run_tag_on_image(image, mask, inst.tagger, mode)
                        parsed_selected, parsed_temporary = inst._apply_tag_result(tag)
                        self._send_json({'success': True, 'tag': tag, 'tags': parsed_selected, 'custom': '', 'temporary': parsed_temporary})
                        return

                    if action == 'detect':
                        # Detector 工具：source 图由前端合成好送来（All Layers = 画布合成图，
                        # Selected Layer = 那一层自己的结算面），prompt 按 VideoSegmentationNode
                        # 的掩码表达式语法逐 term 检测（collect_terms 给出 name:threshold 对，
                        # 与 video 节点同一套 parse/eval），Empty prompt 直接整图一次检测。
                        # 结果按 invert 翻转、再乘 Main Mask（Masked 变体由前端随 payload 带
                        # mask，且已换算到 source 图自己的网格），以「白=覆盖」的 RGBA PNG 返回
                        # —— 亮度进不了 mask 面，alpha 就是覆盖度，四个 destination 都由前端落地。
                        if inst.detector is None:
                            self._send_json({'success': False, 'error': 'No detector is connected to the node'})
                            return
                        from ...libs.detect_utils import detect_mask
                        from ...libs.mask_utils import combine_masks
                        from ...libs.mask_expression import parse_mask_expression, collect_terms, eval_expression
                        params = body.get('detect') or {}
                        prompt = str(params.get('prompt') or '').strip()
                        try:
                            threshold = float(params.get('threshold', 0.5))
                        except (TypeError, ValueError):
                            threshold = 0.5
                        threshold = min(1.0, max(0.0, threshold))
                        invert = bool(params.get('invert'))
                        img = image[0] if image.dim() == 4 else image
                        # Detect 也是「最近一次动作」: 一次 detect = 一份新 trace (与 Run
                        # 同一个只留最近一次的约定), Debug 窗口里看得见表达式、源图、
                        # 每个术语检到几张、以及最终落地的那张蒙版。
                        _src = str(params.get('source') or '')
                        _dst = str(params.get('dest') or '')
                        _SRC_LABELS = {'all': 'All Layers', 'all_masked': 'Masked All Layers',
                                       'selected': 'Selected Layer', 'selected_masked': 'Masked Selected Layer'}
                        _DST_LABELS = {'main_mask': 'Main Mask', 'selected_mask': 'Selected Mask',
                                       'staging': 'Staging', 'new_layer': 'New Layer'}
                        dbg.begin_trace({'from_blend': True, 'action': 'detect'})
                        dbg.record_prompt('Detect 表达式', prompt,
                                          source=_SRC_LABELS.get(_src, _src or '—'),
                                          dest=_DST_LABELS.get(_dst, _dst or '—'),
                                          threshold=threshold, invert=invert)
                        dbg.record_image('Detect 源图', img)
                        if mask is not None and float(mask.sum()) > 0:
                            dbg.record_mask('随行的 Mask', mask)
                        if prompt:
                            root = parse_mask_expression(prompt, threshold)
                            # eval_expression 用 (name, threshold) 二元组作键 —— 只放名字它永远
                            # 找不到, 同一个词换阈值就该是两条独立的掩码。
                            term_masks = {}
                            for name, t in collect_terms(root):
                                term_hits = detect_mask(detector=inst.detector, image=img,
                                                        threshold=float(t), prompt=name)
                                combined = combine_masks(term_hits, mode='max')
                                term_masks[(name, float(t))] = combined
                                dbg.record_mask(f"术语 '{name}' @ {t}", combined,
                                                detail=f'{len(term_hits)} 个实例')
                            result = eval_expression(root, term_masks)
                        else:
                            result = combine_masks(
                                detect_mask(detector=inst.detector, image=img,
                                            threshold=threshold, prompt=''),
                                mode='max')
                        if invert:
                            result = 1.0 - result
                        if mask is not None and float(mask.sum()) > 0:
                            m = mask[0] if mask.dim() == 3 else mask
                            result = result * m
                        dbg.record_mask('Detect 结果', result,
                                        detail=('invert 后' if invert else '') +
                                        ('乘 Main Mask' if mask is not None and float(mask.sum()) > 0 else ''))
                        arr = result.detach().cpu().numpy()
                        arr = np.clip(arr, 0.0, 1.0)
                        if arr.ndim == 3:
                            arr = arr[0]
                        rgba = np.zeros((arr.shape[0], arr.shape[1], 4), dtype=np.uint8)
                        rgba[..., 0:3] = 255
                        rgba[..., 3] = (arr * 255).astype(np.uint8)
                        buf = io.BytesIO()
                        Image.fromarray(rgba, mode='RGBA').save(buf, format='PNG')
                        _tr = dbg.current_trace()
                        if _tr is not None:
                            _tr.meta['status'] = 'done'
                        self._send_json({'success': True,
                                         'mask': 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')})
                        return

                    # action == 'detailer'：合成结果交给主循环执行（主循环在另一个线程）
                    # 遮罩必须存在，否则 detailer 无意义 —— 例外：Enable Mask 总闸关
                    # （生效链第一个 detailer 的 params.enable_mask，随 Run 设置里的
                    # preset 解析）时整幅都是工作区，Mask 层没画也允许跑。
                    if (inst._first_detailer_enable_mask(body.get('preset_id'))
                            and (mask is None or float(mask.sum()) == 0)):
                        self._send_json({'success': False, 'error': 'Mask is required — paint the mask layer before running the detailer'}, 400)
                        return
                    # Enable Edit 下 prompt 里 <image N> 引用缺 ref image 时不启动本次 run，
                    # 把缺口回给前端，由它弹窗从工作区让用户补图（见 edit_ref_shortfall）。
                    _shortfall = inst.edit_ref_shortfall(body.get('preset_id'), (body.get('extra_prompt') or '').strip())
                    if _shortfall is not None:
                        self._send_json({'success': False, 'ref_request': _shortfall,
                                         'error': 'This prompt references a ref image — pick one from the workspace'})
                        return
                    inst.blend_image = image
                    inst.blend_mask = mask
                    inst.blend_prompt = (body.get('extra_prompt') or '').strip()
                    # The Run settings dialog's Pipeline Preset: which block set runs this pass.
                    # Absent / invalid -> the runner's own chain (the active tab). Consumed once
                    # by the main loop, so a later run is not stuck on a stale choice.
                    run_preset = body.get('preset_id')
                    if not isinstance(run_preset, str) or not run_preset:
                        run_preset = None
                    inst.pending_generate_preset = run_preset
                    inst.put_action('run_detailer', from_blend=True, extra_prompt=inst.blend_prompt)
                    self._send_json({'success': True})
                except LookupError as e:
                    self._send_json({'success': False, 'error': str(e)}, 404)
                except ValueError as e:
                    self._send_json({'success': False, 'error': str(e)}, 400)
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'success': False, 'error': str(e)}, 500)
                return

            # ---- 文档 IO：对话框由后端弹，路径只在服务端流转 ----
            if self.path == '/api/cud_open':
                # {path: '<.cud 绝对路径>'} → {ok, doc:{token,name,path,size,mime}}
                # 跳转通道：帧卡绑的 .cud 要打开编辑时，把那条**用户挑进工程的**路径重新
                # mint 成对话框同形的描述符；前端拿它走 blend-reopen-cud（已开着就切换，
                # 没开着就 Load 开新窗）。约束在 open_path 里：非 .cud / 不在盘上一律拒绝。
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    doc = doc_io.open_path(str(body.get('path') or ''), 'cud')
                    if doc is None:
                        self._send_json({'ok': False, 'error': 'not a readable .cud'})
                    else:
                        self._send_json({'ok': True, 'doc': doc})
                except Exception as e:
                    self._send_json({'ok': False, 'error': str(e)}, 500)
                return

            # MIDI 设置：只认 instruments_library / presets_library / scan_depth 三个键（见 _midi_write）。
            if self.path == '/api/midi_settings':
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    settings = _midi_write(body)
                    self._send_json({'ok': True, **settings,
                                     'state': _library_state(settings['instruments_library']),
                                     'presets_state': _library_state(settings['presets_library'])})
                except Exception as e:
                    self._send_json({'ok': False, 'error': str(e)}, 400)
                return

            if self.path == '/api/io_pick':
                # {mode: 'open'|'save', kind: 'cud'|'png'|'image', suggested, multiple}
                # → {cancelled, picks:[{token,name,path,size,mime}]}
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    mode = 'save' if body.get('mode') == 'save' else 'open'
                    kind = body.get('kind') if body.get('kind') in IO_FILE_KINDS else 'cud'
                    picks = doc_io.pick(mode, kind,
                                        suggested=str(body.get('suggested') or ''),
                                        multiple=bool(body.get('multiple')))
                    if picks is None:
                        self._send_json({'cancelled': True, 'picks': [], 'unavailable': True})
                    else:
                        self._send_json({'cancelled': not picks, 'picks': picks})
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    self._send_json({'cancelled': True, 'picks': [], 'error': str(e)}, 500)
                return

            if self.path.startswith('/api/io_write'):
                # 原始字节直接进 body（不是 dataURL：几百 MB 的上下文经不起再一次三分之一膨胀）
                try:
                    token = (parse_qs(urlparse(self.path).query).get('token') or [''])[0]
                    length = int(self.headers.get('Content-Length', 0))
                    data = self.rfile.read(length) if length else b''
                    ok, err = doc_io.write(token, data)
                    self._send_json({'success': ok, 'error': err, 'size': len(data)})
                except Exception as e:
                    self._send_json({'success': False, 'error': str(e)}, 500)
                return

            if self.path == '/window_closed':
                inst.window_closed = True
                inst.put_action('window_closed')
                self._send_json({'ok': True})
                return

            self.send_error(404)


# =============================================================================
# SnapshotDetailerSamplerNode
# =============================================================================
class SnapshotDetailerSamplerNode:
    """
    事件驱动的交互式细节修复节点。
    前端通过 tab 自由切换 Mask/Tag/Prompt/Draw/Context，后端通过 action queue 响应。
    """

    @classmethod
    def INPUT_TYPES(s):
        # 采样参数不在节点上：add_noise / start_step_rate / end_step_rate / enable_edit /
        # context_regex 属于每个 detailer block（工作台 Edit 页），pixels / align /
        # crop_reserve / mask_grow / mask_blur 属于 DEFAULT SETTING（落盘）。节点端口
        # 留着只会和前端各存一份、Run 时互相覆盖，所以全部取消。
        return {
            "required": {
                "pipeline": ("PIPELINE_DATA",),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "lora_regex": ("STRING", {"default": "", "multiline": False}),
            },
            "optional": {
                "detector": ("*",),
                "tagger": ("*",),
                "asset": ("STRING", {"default": "", "multiline": True, "tooltip": "Assets snapshot: JSON string (normal mode) or name (global mode) for Tag From Assets button"}),
                "package": ("*",),
            },
            "hidden": {
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("PIPELINE_DATA",)
    RETURN_NAMES = ("pipeline",)
    FUNCTION = "sample"
    CATEGORY = "sampling/custom"

    @classmethod
    def IS_CHANGED(s, **kwargs):
        return float("nan")

    def get_current_pipeline(self):
        return getattr(self, '_current_pipeline', None)

    # -------------------------------------------------------------------------
    # Tag
    # -------------------------------------------------------------------------
    def _run_tag_on_image(self, tag_image, mask, tagger, mode='mask'):
        """对给定图像 + 遮罩打标，与 pipeline 状态无关（供 Blend 工作台直接调用）。"""
        from ...libs.caption_utils import get_tag
        from ...libs.image_utils import crop_mask
        if mask is not None:
            try:
                img = tag_image
                if img.dim() == 3:
                    img = img.unsqueeze(0)
                if mask.dim() == 2:
                    mask = mask.unsqueeze(0)
                cropped_img, cropped_mask, _ = crop_mask(img, mask, reserve=32)
                if mode == 'mask':
                    tag_image = cropped_img
                elif mode == 'covered':
                    white_bg = torch.ones_like(cropped_img)
                    mask_expanded = cropped_mask.unsqueeze(-1).float()
                    tag_image = cropped_img * mask_expanded + white_bg * (1 - mask_expanded)
            except Exception as mask_err:
                print(f"[RunTag] crop_mask failed, falling back to full: {mask_err}")
        return get_tag(tagger, tag_image)

    # -------------------------------------------------------------------------
    # Load From Assets
    # -------------------------------------------------------------------------
    def _load_from_assets(self, server, asset_data):
        """Open SnapshotAssetsServer for image selection, add selected images to history."""
        import webbrowser
        from .assets_node import SnapshotAssetsServer, SnapshotAssetsNode

        # Determine mode: JSON string → normal mode, else → global mode name
        global_mode = True
        canvas_snapshot = None
        if asset_data and asset_data.strip():
            try:
                parsed = json.loads(asset_data.strip())
                if isinstance(parsed, dict):
                    canvas_snapshot = asset_data.strip()
                    global_mode = False
            except (json.JSONDecodeError, ValueError):
                pass

        if global_mode and asset_data and asset_data.strip():
            snap_dir = data_dir('snapshots')
            snap_path = os.path.join(snap_dir, f"{asset_data.strip()}.json")
            if os.path.exists(snap_path):
                with open(snap_path, 'r', encoding='utf-8') as f:
                    canvas_snapshot = f.read()

        assets_server = SnapshotAssetsServer(
            input_data=asset_data,
            canvas_snapshot=canvas_snapshot,
            enable_image=True,
            enable_image_config=False,
            image_config="",
            enable_video=False,
            enable_audio=False,
            enable_prompt=False,
            enable_slot=False,
            global_mode=global_mode,
        )
        server_thread = threading.Thread(target=assets_server.start)
        server_thread.daemon = True
        server_thread.start()

        start_time = time.time()
        while not assets_server.started:
            try:
                mm.throw_exception_if_processing_interrupted()
            except Exception:
                assets_server.stop()
                raise
            if time.time() - start_time > 10:
                assets_server.stop()
                raise RuntimeError("[load_from_assets] Server startup timeout")
            time.sleep(0.01)

        print(f"[load_from_assets] Opening browser at: {assets_server.browser_url}")
        open_ui(assets_server.browser_url)

        if not assets_server.wait_for_confirm():
            assets_server.stop()
            return 0
        assets_server.stop()

        selected_images = getattr(assets_server, 'selected_images', [])
        if not selected_images:
            return 0

        count = 0
        for img_data in selected_images:
            if isinstance(img_data, dict):
                image_url = img_data.get('image', '')
                if not image_url:
                    continue
                tensor = SnapshotAssetsNode._decode_image_data(image_url)
                server.add_staging(tensor, name=f'Asset #{len(server.staging_items) + 1}')
                count += 1

        print(f"[load_from_assets] Added {count} images to staging")
        return count

    # -------------------------------------------------------------------------
    # Prompt 解析
    # -------------------------------------------------------------------------
    def _expand_prefabs(self, prompt_server, selected=None):
        """Expand selected prefab instances into (prompt_texts, loras).

        `selected` defaults to the prompt server's own selection; the prompt-BLOCK runner
        passes an explicit (program-resolved) instance list instead. A synced prefab entry
        carries only INSTANCE state — guid, active flag, per-tag-group
        active flags, per-lora active flags (see the prompt iframe's sync-prompt payload). The
        tag and lora CONTENT lives in the prefab library, looked up by guid. Without this
        expansion a user whose prompt lives in a prefab — the common case, and the log proves
        it: "/select_prompt received: prompts=0 ... loras=0, prefabs=1" — generated with an
        EMPTY prompt, because _parse_prompt() used to read only selected_prompts /
        custom_prompts / selected_loras and dropped prefabs entirely. The main graph run was
        never affected (SnapshotPromptNode.snapshot_prompt expands prefabs there), which is
        exactly why only the interactive Generate / Run-Detailer looked "not injected".
        Mirrors snapshot_prompt()'s expansion: per-tag-group active state, [decoration]
        nesting, (text:strength) wrapping, prefab custom_prompts, recursive children,
        per-lora active state and lora_regex validity.
        """
        texts = []
        loras = []
        if prompt_server is None:
            return texts, loras
        if selected is None:
            selected = getattr(prompt_server, 'selected_prefabs', None) or []
        if not selected:
            return texts, loras
        guid_to_prefab = {}
        for lib_data in (getattr(prompt_server, 'libraries_data', None) or {}).values():
            if isinstance(lib_data, dict):
                for pf in (lib_data.get('prefabs') or []):
                    guid = pf.get('guid') if isinstance(pf, dict) else None
                    if guid:
                        guid_to_prefab[guid] = pf

        def expand(node, visited):
            if not isinstance(node, dict) or not node.get('active', True):
                return
            guid = node.get('guid')
            if not guid or guid in visited:
                return
            visited.add(guid)
            pf = guid_to_prefab.get(guid)
            if not pf:
                return
            # Per-group active state lives on the INSTANCE under tag_groups (the sync payload's
            # format: {guid, active, tag_groups: [{key, active}], loras, children}); the
            # standalone graph flow stores the same states under `tags`. Read both.
            tag_states = {
                t.get('key'): t.get('active', True)
                for t in (node.get('tag_groups') or node.get('tags') or [])
                if isinstance(t, dict)
            }
            for tag_group in pf.get('tag_groups', pf.get('tags', [])):
                # Group identity: the interactive library stores a group NAME under `key`; the
                # standalone format identifies a group by its joined tag names. Try both.
                def group_key(g):
                    if isinstance(g, dict) and g.get('key'):
                        return g.get('key')
                    tags = g.get('tags') if isinstance(g, dict) else g
                    return ' '.join(
                        t.get('name') or t.get('prompt', '') for t in (tags or []) if isinstance(t, dict))
                # New TagGroup format: { tags: [...], strength } — strength wraps the group.
                if isinstance(tag_group, dict) and 'tags' in tag_group:
                    group_tags = tag_group.get('tags', [])
                    group_strength = tag_group.get('strength', 1.0)
                    if not tag_states.get(group_key(tag_group), True):
                        continue
                    parts = []
                    for i, tag in enumerate(group_tags):
                        if isinstance(tag, dict):
                            prompt_text = tag.get('prompt', '')
                            deco_level = len(group_tags) - 1 - i  # last = 0 (base)
                            text = ('[' * deco_level + prompt_text + ']' * deco_level) if deco_level > 0 else prompt_text
                            parts.append(text)
                    if parts:
                        # Same cleaned form the detailer consumes: no [] decoration, (x:strength) kept.
                        prompt_str = ' '.join(parts).replace('[', '').replace(']', '')
                        if group_strength != 1.0:
                            prompt_str = f"({prompt_str}:{group_strength})"
                        if prompt_str not in texts:
                            texts.append(prompt_str)
                # Old format: Tag[] — per-tag decoration/strength.
                elif isinstance(tag_group, list):
                    if not tag_states.get(group_key(tag_group), True):
                        continue
                    parts = []
                    for tag in tag_group:
                        if isinstance(tag, dict):
                            prompt_text = tag.get('prompt', '')
                            deco = tag.get('decoration_num') or 0
                            strength = tag.get('strength', 1.0)
                            text = ('[' * deco + prompt_text + ']' * deco) if deco > 0 else prompt_text
                            if strength != 1.0:
                                text = f"({text}:{strength})"
                            parts.append(text)
                    if parts:
                        prompt_str = ' '.join(parts).replace('[', '').replace(']', '')
                        if prompt_str not in texts:
                            texts.append(prompt_str)
            cp = pf.get('custom_prompts', '')
            if cp:
                texts.append(cp)
            # Collect loras (per-lora active state from the instance, lora_regex validity)
            lora_states = {l.get('file_path'): l.get('active', True) for l in node.get('loras', [])}
            for lora_item in pf.get('loras', []):
                if not isinstance(lora_item, dict):
                    continue
                file_path = lora_item.get('file_path', '') or lora_item.get('file_name', '')
                if not file_path:
                    continue
                if not prompt_server.lora_allowed_by_regex(file_path):
                    continue
                if not lora_states.get(file_path, True):
                    continue
                exists = any((l.get('file_path', '') or l.get('file_name', '')) == file_path for l in loras)
                if not exists:
                    loras.append(lora_item)
            for child in node.get('children', []):
                expand(child, visited)

        for sp in selected:
            expand(sp, set())
        return texts, loras

    def _parse_prompt(self, prompt_server):
        user_positive = ''
        user_loras = ''
        if prompt_server:
            selected = prompt_server.selected_prompts
            custom = prompt_server.custom_prompts
            parts = []
            for p in selected:
                text = p['text'] if isinstance(p, dict) else p
                if text.startswith('<') and text.endswith('>'):
                    parts.append(text[1:-1])
                else:
                    parts.append(text)
            if custom:
                parts.append(custom)
            # The latest tag's unparseable segments live in the editor's Temporary Prompts,
            # so they belong to this pass's prompt as well — just never persisted.
            parts.extend(getattr(prompt_server, 'temporary_prompts', None) or [])
            user_positive = ','.join(parts)

            loras = list(prompt_server.selected_loras or [])
            # Prefab contents are part of the user's prompt: expand them (tags -> prompt text,
            # prefab loras -> loadable loras) and merge. See _expand_prefabs() for why this
            # cannot be skipped — a prefab-only selection otherwise generates with no prompt.
            prefab_texts, prefab_loras = self._expand_prefabs(prompt_server)
            loras.extend(prefab_loras)
            lora_str_parts = []
            trigger_words = []
            # Model-only 标记（Edit Lora 的持久配置，按指纹存、这里换算回路径查表一次）：
            # 拼进 <lora_path:...:strength:model_only>，加载端据此跳过 CLIP。
            try:
                slider_cfgs = prompt_server._get_lora_slider_configs_by_filepath() or {}
            except Exception:
                slider_cfgs = {}
            # 同款过滤（prompt_node 的 get_active_loras_string / lora_allowed_by_regex）：
            # 架构 regex 没命中的 lora 不加载，也不出标记词 —— 命中集为空同样是真状态，全拒。
            for lora_item in loras:
                if isinstance(lora_item, dict):
                    if not lora_item.get('active', True):
                        continue
                    file_path = lora_item.get('file_path', '') or lora_item.get('file_name', '')
                    if hasattr(prompt_server, '_resolve_lora_file_path'):
                        file_path = prompt_server._resolve_lora_file_path(file_path)
                    if not file_path:
                        continue
                    if not prompt_server.lora_allowed_by_regex(file_path):
                        print(f"[QueryLora] SKIP (prompt tab): 不在当前架构 lora_regex 命中集 — {file_path}")
                        continue
                    strength = lora_item.get('strength', 1.0)
                    model_only = bool(lora_item.get('model_only', False)) or bool((slider_cfgs.get(file_path) or {}).get('model_only', False))
                    lora_str_parts.append(f"<lora_path:{file_path}:{strength}" + (":model_only" if model_only else "") + ">")
                    trigger_words.extend(lora_item.get('active_tags', []))
                else:
                    lora_str_parts.append(str(lora_item))
            user_loras = ','.join(lora_str_parts)
            # Trigger words lead the prompt: a lora's own vocabulary is what the model
            # was trained to key on, so it goes before the user's tag list.
            # 记下这次拼进去的触发词串：Enable Output 的 `prompt` 键编码用户选择时要剥掉
            # 它（触发词由 'lora' 键自己带，读回后不该重复出现）。链上有 prompt/Query 块
            # 时 _resolve_prompt_selection 会整体替换 user_positive 并覆写这里。
            self._last_trigger_str = ''
            if trigger_words:
                trigger_str = ', '.join(trigger_words)
                user_positive = trigger_str + (', ' + user_positive if user_positive else '')
                self._last_trigger_str = trigger_str
            for text in prefab_texts:
                user_positive = f"{user_positive}, {text}" if user_positive else text
        return user_positive, user_loras

    # -------------------------------------------------------------------------
    # Prompt block（pipeline block type='prompt'）运行时解析
    # -------------------------------------------------------------------------
    def _resolve_prompt_block(self, server, block_params):
        # 块只存 preset 引用；内容来自共享 preset（未配置/被删 = 空 selection = 直通）
        sel = server._prompt_preset_selection((block_params or {}).get('preset_id'))
        return self._resolve_prompt_selection(server, sel)

    def _resolve_prompt_selection(self, server, sel, merge_global=True):
        """Resolve one raw selection into (user_positive, user_loras) for the detailers AFTER it.

        Shared by the prompt block (whose selection is a persisted preset) and the Query
        block (whose selection is picked by the user at run time) — both are transient
        injections with identical semantics.

        `merge_global=False`（生成器轨的轨级提示词）：只渲染 preset 本身，不合并 prompt tab
        的全局选择、不碰 temporary_prompts、也不覆写 last_effective_prompt_selection /
        _last_trigger_str —— 产出的串由调用方自己拼接（追加在段提示词后面），不是一次
        detailer 级的整条替换。

        Semantics (与产品确认过的行为一致):
          - 合并 = prompt 节点全局最终选择（selected_prompts/loras/prefabs，已是全局
            program 的产物）在前 + 该 raw selection 追加在后（source='program'
            的项剥离——它们会由 selection 的 program 重新生成，与前端 useProgram 语义一致）。
          - selection 的 applications(programs) 在**合并后的整体 selection**上执行（后端
            quickjs 引擎，移植 useProgram.ts），所以程序能过滤/修改全局内容。
          - 输出拼装顺序与 _parse_prompt 完全一致：trigger words -> texts + custom ->
            prefab texts（<lora:...> 是独立端口，不进文本）。全局在前、selection 在后由合并顺序保证。
          - 纯临时：只影响本次 run 中排在该块之后的 detailer，不写回任何状态。
        """
        ps = server.prompt_server if server else None
        if ps is None:
            return '', ''
        sel = sel or {}

        # 诊断（run 级，一次一行）：trigger words 丢失只可能发生在下面这三处之一 ——
        # 进来时 tags 就是空、全局那份压过 block 那份、或拼装末尾没接上。逐个打出来对照。
        def _lora_diag(tag, items):
            parts = []
            for l in items or []:
                if isinstance(l, dict):
                    parts.append('{}|active={}|active_tags={}|split_mode={}'.format(
                        l.get('file_path') or l.get('file_name'),
                        l.get('active', True), l.get('active_tags'), l.get('split_mode')))
                else:
                    parts.append('(non-dict){}'.format(l))
            print(f"[QueryLora] {tag}: {parts}")
        if merge_global:
            _lora_diag('global selected_loras', getattr(ps, 'selected_loras', None))
        _lora_diag('block selection loras', sel.get('loras'))

        # --- 合并 tags：全局在前（text -> 单 tag TagGroup），block 在后 ---
        merged_tags = []
        if merge_global:
            for p in (getattr(ps, 'selected_prompts', None) or []):
                text = p.get('text') if isinstance(p, dict) else str(p)
                src = p.get('source', 'normal') if isinstance(p, dict) else 'normal'
                if text.startswith('<') and text.endswith('>'):
                    text = text[1:-1]
                if not text:
                    continue
                merged_tags.append({'tags': [{'name': text, 'prompt': text, 'category': ''}],
                                    'strength': 1.0, 'source': src})
        for g in (sel.get('tags') or []):
            if isinstance(g, dict) and g.get('source', 'normal') == 'program':
                continue
            if isinstance(g, dict):
                merged_tags.append(copy.deepcopy(g))


        # --- 合并 loras（全局优先）与 prefabs（按 guid 去重）---
        # 去重键要先过 _resolve_lora_file_path：全局那份的 file_path 在落盘时被换成了指纹
        # （prompt_node.py:1154），preset/Query 回答带的是真实路径，字面比较会把同一条 lora
        # 判成两条（重复加载 + 标记词重复）。region 的同款去重就是先解析再比（3995-3997）。
        def _lora_identity(l):
            fp = l.get('file_path') or l.get('file_name') or ''
            if not fp:
                return ''
            return ps._resolve_lora_file_path(fp) if hasattr(ps, '_resolve_lora_file_path') else fp
        merged_loras = []
        seen_lora = set()
        global_loras = list(getattr(ps, 'selected_loras', None) or []) if merge_global else []
        for l in global_loras + list(sel.get('loras') or []):
            if not isinstance(l, dict):
                continue
            key = _lora_identity(l)
            if not key or key in seen_lora:
                continue
            seen_lora.add(key)
            merged_loras.append(copy.deepcopy(l))
        merged_prefabs = []
        seen_guid = set()
        global_prefabs = list(getattr(ps, 'selected_prefabs', None) or []) if merge_global else []
        for p in global_prefabs + list(sel.get('prefabs') or []):
            if not isinstance(p, dict):
                continue
            guid = p.get('guid')
            if not guid or guid in seen_guid:
                continue
            seen_guid.add(guid)
            merged_prefabs.append(copy.deepcopy(p))

        custom_parts = [c for c in
                        ([getattr(ps, 'custom_prompts', '') or ''] if merge_global else [])
                        + [sel.get('custom_prompts') or '']
                        if c]
        merged_custom = '\n'.join(custom_parts)

        # --- block 的 programs 在合并 selection 上执行（无 programs = 原样通过）---
        from ..pipeline.prompt_program_engine import PromptProgramEngine, tags_to_display_string
        engine = PromptProgramEngine(ps)
        result = engine.run(sel.get('programs') or [], merged_tags, merged_loras, merged_prefabs, merged_custom)

        # --- 拼装（与 _parse_prompt 相同的顺序与格式）---
        parts = []
        for g in result['result_tags']:
            text = tags_to_display_string(g)
            if text.startswith('<') and text.endswith('>'):
                text = text[1:-1]
            if text:
                parts.append(text)
        if result['result_custom_prompts']:
            parts.append(result['result_custom_prompts'])
        # Same as _parse_prompt: the last tag's unparseable segments are this pass's prompt.
        if merge_global:
            parts.extend(getattr(ps, 'temporary_prompts', None) or [])
        user_positive = ','.join(parts)

        loras = list(result['result_loras'])
        prefab_texts, prefab_loras = self._expand_prefabs(ps, selected=result['result_prefabs'])
        loras.extend(prefab_loras)
        lora_str_parts = []
        trigger_words = []
        # Model-only 标记（同 _parse_prompt）：Edit Lora 的持久配置兜底 + 条目自带优先。
        try:
            slider_cfgs = ps._get_lora_slider_configs_by_filepath() or {}
        except Exception:
            slider_cfgs = {}
        # 与 prompt 节点自己的输出同一条规矩（lora_allowed_by_regex）：没被当前架构
        # lora_regex 命中的 lora 既不加载，也不出标记词 —— 命中集为空（该架构在库里
        # 没有 lora）同样是真状态，此时全拒，而不是把过滤整个关掉。
        for lora_item in loras:
            if isinstance(lora_item, dict):
                if not lora_item.get('active', True):
                    continue
                file_path = lora_item.get('file_path', '') or lora_item.get('file_name', '')
                if hasattr(ps, '_resolve_lora_file_path'):
                    file_path = ps._resolve_lora_file_path(file_path)
                if not file_path:
                    continue
                if not ps.lora_allowed_by_regex(file_path):
                    print(f"[QueryLora] SKIP: 不在当前架构 lora_regex 命中集 — {file_path}")
                    continue
                strength = lora_item.get('strength', 1.0)
                model_only = bool(lora_item.get('model_only', False)) or bool((slider_cfgs.get(file_path) or {}).get('model_only', False))
                lora_str_parts.append(f"<lora_path:{file_path}:{strength}" + (":model_only" if model_only else "") + ">")
                trigger_words.extend(lora_item.get('active_tags', []))
            else:
                lora_str_parts.append(str(lora_item))
        user_loras = ','.join(lora_str_parts)
        # Same leading position as _parse_prompt: trigger words before every other segment.
        # merge_global=False 只把触发词编进**这次返回的串**（调用方自己拼接），
        # 不覆写 _last_trigger_str —— 那颗记的是整条 run 真正生效的合并选择。
        self._last_trigger_str = ''
        if trigger_words:
            trigger_str = ', '.join(trigger_words)
            user_positive = trigger_str + (', ' + user_positive if user_positive else '')
            if merge_global:
                self._last_trigger_str = trigger_str
        for text in prefab_texts:
            user_positive = f"{user_positive}, {text}" if user_positive else text
        if not merge_global:
            return user_positive, user_loras
        # 诊断：库里 trainedWords（lora_data[*]['tags']）能不能兜住这次的空 active_tags。
        lib_tags = {}
        for items in (getattr(ps, 'lora_data', None) or {}).values():
            for it in items or []:
                if isinstance(it, dict) and it.get('file_path'):
                    lib_tags[it['file_path']] = it.get('tags') or []
        _lora_diag('merged→loadable', loras)
        print(f"[QueryLora] library tags by path: { {k.split('/')[-1]: v for k, v in lib_tags.items() if k in [l.get('file_path') for l in loras if isinstance(l, dict)]} }")
        print(f"[QueryLora] final trigger_words={trigger_words} | user_loras={user_loras}")
        _mo = [p.strip() for p in user_loras.split(',') if p.strip().endswith(':model_only>')]
        print(f"[QueryLora] model-only (CLIP untouched): {_mo if _mo else 'none'}")
        # Enable Output 读的就是这份「这次真正生效的合并选择」：引擎产物（program 生成/过滤
        # 之后的结果）在这里定格，落盘时按 cache_data 的键形重放，不再跑第二次引擎。
        server.last_effective_prompt_selection = {
            'prompts': [{'text': tags_to_display_string(g) if isinstance(g, dict) else str(g),
                         'source': g.get('source', 'normal') if isinstance(g, dict) else 'normal'}
                        for g in result['result_tags']],
            'loras': result['result_loras'],
            'prefabs': result['result_prefabs'],
            'custom_prompts': result['result_custom_prompts'],
            'programs': list(sel.get('programs') or []),
            'filter_tag_groups': result['filter_tag_groups'],
            'filter_loras': result['filter_loras'],
            'filter_prefabs': result['filter_prefabs'],
        }
        return user_positive, user_loras

    def _save_run_output_png(self, server, image):
        """Enable Output：这一趟的最终产出连同 prompt 编码写进 outputs/ 的 PNG。

        `parameters` chunk 的键形与 SnapshotPromptNode 的 cache 输出一字不差（见
        prompt_node.py:4057-4069），所以这张图能被 PromptNode 的「Load From Image」
        原样读回。内容按这次真正生效的东西编：链里有 prompt / Query 块就编块出口
        暂存的合并选择，没有这类块则回落到 prompt 节点的全局选择；`prompt` 键是
        这次生效的**用户选择**（标签 / 自定义 / prefab 文本，剥离了打头的 lora 触发词，
        也不掺 pipeline context 自带的 prompt 与 Generate Text 的改写 —— 触发词由
        'lora' 键的 active_tags 自己提供，读回后不该重复出现）。落盘路径与命名走
        ComfyUI 自己的计数（get_save_image_path → detailer_00001_.png）。

        整份 fail-open：写盘失败只打 [Output] 警告，不能把一趟已完成的 run 变成 error。
        """
        try:
            import folder_paths
            from PIL.PngImagePlugin import PngInfo
            from ..io.disk_node import _sanitize_json

            if image is None:
                print("[Output] WARNING: no final image to save")
                return
            tensor = image[0] if image.dim() == 4 else image
            arr = (tensor.detach().cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
            h, w = int(arr.shape[0]), int(arr.shape[1])
            pil = Image.fromarray(arr, mode='RGBA' if arr.shape[-1] == 4 else 'RGB')

            ps = server.prompt_server
            eff = server.last_effective_prompt_selection
            if eff is not None:
                prompt_items = eff['prompts']
                loras = eff['loras']
                prefabs = eff['prefabs']
                programs = eff['programs']
                custom = eff['custom_prompts']
                f_tags, f_loras, f_prefabs = (eff['filter_tag_groups'], eff['filter_loras'],
                                              eff['filter_prefabs'])
                source = 'effective selection'
            else:
                # 没有 prompt / Query 块 = prompt 节点的全局选择就是这次的输入。取的是链跑完、
                # 主循环剥离 program 项**之前**的状态，所以这里能看到 program 加出来的东西。
                prompt_items = [({'text': p['text'], 'source': p.get('source', 'normal')}
                                 if isinstance(p, dict) else {'text': p, 'source': 'normal'})
                                for p in (getattr(ps, 'selected_prompts', None) or [])]
                loras = getattr(ps, 'selected_loras', None) or []
                prefabs = getattr(ps, 'selected_prefabs', None) or []
                programs = getattr(ps, 'selected_programs', None) or []
                custom = getattr(ps, 'custom_prompts', '') or ''
                f_tags = getattr(ps, 'filter_tag_groups', None) or []
                f_loras = getattr(ps, 'filter_loras', None) or []
                f_prefabs = getattr(ps, 'filter_prefabs', None) or []
                source = 'prompt node global'

            # 落盘存指纹而不是路径（与 prompt 节点一致）：读回时按当前扫描的指纹重定位路径。
            if (ps is not None and hasattr(ps, '_convert_loras_to_fingerprint_keys')
                    and all(isinstance(l, dict) for l in loras)):
                loras = ps._convert_loras_to_fingerprint_keys(loras)

            # region 与 prompt_node.py:4043-4047 同形：region_result 是前端每次上报的整包，
            # 这里只取读回需要的三样，预览图那种派生量不进元数据。
            region_json = ''
            rr = getattr(ps, 'region_result', None)
            if rr:
                try:
                    region_json = json.dumps({
                        'boxes': rr.get('boxes', []),
                        'format_slots': rr.get('format_slots', {}),
                        'background_context': rr.get('background_context', None),
                    }, ensure_ascii=False)
                except Exception:
                    region_json = ''

            cache_data = {
                # 用户自己的选择（无 pipeline prompt / 无 lora 触发词，见块循环捕获处）。
                'prompt': getattr(server, 'last_output_positive', '') or '',
                'prompts': json.dumps(prompt_items, ensure_ascii=False),
                'lora': json.dumps(loras, ensure_ascii=False),
                'prefab': json.dumps(prefabs, ensure_ascii=False),
                'program': json.dumps(programs, ensure_ascii=False),
                'prompt_parsing': ", ".join(getattr(ps, 'parsed_prompts', []) or []),
                'custom_prompts': custom,
                'filter_tag_groups': json.dumps(f_tags, ensure_ascii=False),
                'filter_loras': json.dumps(f_loras, ensure_ascii=False),
                'filter_prefabs': json.dumps(f_prefabs, ensure_ascii=False),
                'region': region_json,
            }
            data_json = json.dumps(_sanitize_json(cache_data), ensure_ascii=False)

            full_output_folder, filename, counter, _subfolder, _prefix = folder_paths.get_save_image_path(
                'detailer', folder_paths.get_output_directory(), w, h)
            os.makedirs(full_output_folder, exist_ok=True)
            path = os.path.join(full_output_folder, f"{filename}_{counter:05}_.png")
            metadata = PngInfo()
            metadata.add_text('parameters', data_json)
            pil.save(path, format='PNG', pnginfo=metadata, compress_level=4)
            print(f"[Output] saved {path} ({w}x{h}, {len(prompt_items)} tag(s), "
                  f"{len(loras)} lora(s), source={source}, prompt={len(cache_data['prompt'])} chars)")
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"[Output] WARNING: failed to write the output PNG: {e}")

    def _model_only_paths(self, ps):
        """Model-only lora 的路径集合（持久 slider config，盘上重载 —— 跨实例保鲜）。"""
        if ps is None or not hasattr(ps, '_get_lora_slider_configs_by_filepath'):
            return []
        try:
            cfgs = ps._get_lora_slider_configs_by_filepath() or {}
        except Exception:
            return []
        return [str(p).replace('\\', '/') for p, c in cfgs.items()
                if isinstance(c, dict) and c.get('model_only')]

    @staticmethod
    def _mark_model_only(lora_items, mo_paths):
        """给缺 `:model_only` 尾标的 lora 串按持久配置补标记。

        context 里的串是 prompt 节点上次图执行时冻结的 —— 之后才打开的 model_only
        只有在这里补标，同一趟 run 才能生效（ producers 侧的拼串只覆盖「新执行」）。
        匹配按路径与文件名两个口径：同名副本共享同一指纹/同一份配置，标哪条都命中。
        """
        if not lora_items or not mo_paths:
            return lora_items
        mo_lower = [p.lower() for p in mo_paths]
        mo_stems = []
        for p in mo_lower:
            name = p.rsplit('/', 1)[-1]
            mo_stems.append(name.rsplit('.', 1)[0] if '.' in name else name)
        out = []
        for item in lora_items:
            s = item.strip() if isinstance(item, str) else str(item)
            if s.endswith(':model_only>') or not (s.startswith('<') and s.endswith('>')):
                out.append(item)
                continue
            body = s[1:-1]
            # 按 _apply_loras 的真实解析语义解出路径/名字，再与持久配置精确匹配 ——
            # 不能拿原始串做尾段剥离（split-mode 串 :strength:tag 会让匹配落空）。
            hit = False
            try:
                if body.startswith('lora_path:'):
                    b = body[len('lora_path:'):]
                    last = b.rfind(':')
                    if last != -1 and b[last + 1:] != 'model_only':
                        path_l = b[:last].replace('\\', '/').lower()
                        nm = path_l.rsplit('/', 1)[-1]
                        st = nm.rsplit('.', 1)[0] if '.' in nm else nm
                        hit = any(path_l == pl or st == stem
                                  for pl, stem in zip(mo_lower, mo_stems))
                elif body.startswith('lora:'):
                    parts = body.split(':', 2)
                    if len(parts) >= 2:
                        nm = parts[1].replace('\\', '/').lower()
                        st = nm.rsplit('.', 1)[0] if '.' in nm else nm
                        hit = any(nm == p.rsplit('/', 1)[-1] or nm == stem or st == stem
                                  for p, stem in zip(mo_lower, mo_stems))
            except Exception:
                hit = False
            out.append(s[:-1] + ':model_only>' if hit else s)
        return out

    def _await_query_answer(self, server, block, index):
        """Park the chain on a Query block until the user answers its prompt dialog.

        The run loop blocks on an Event while /api/status publishes the pending query and
        /api/query_answer releases it. ComfyUI's interrupt still reaches a parked chain.
        Cancelling the dialog (or never answering) ABORTS the whole chain — the user asked
        for the run to stop rather than continue with a prompt they never chose.

        A Query may bind the same shared preset a prompt block uses: the wait publishes it so
        the dialog opens pre-ticked from it, and `persistent` rides along so the answer
        handler can write the final selection back into that preset (see
        `_answer_pending_query`). Without persistence the answer lives only in this run.
        """
        import threading as _threading
        import time as _time
        evt = _threading.Event()
        bp = block.get('params', block) if isinstance(block, dict) else None
        preset_id = bp.get('preset_id') if isinstance(bp, dict) else None
        query = {
            'id': 'query-%d-%d' % (index, int(_time.time() * 1000)),
            'name': (block.get('name') if isinstance(block, dict) else None) or 'Query',
            'index': index,
            'preset_id': preset_id,
            'persistent': bool(isinstance(bp, dict) and bp.get('persistent')) and bool(preset_id),
            'event': evt,
            'answer': None,
            'cancelled': False,
        }
        server.pending_query = query
        print(f"[PipelineBlock {index + 1}] Query block '{query['name']}' — waiting for the user's prompt choice"
              + (f" (preset '{preset_id}'" + (', persistent)' if query['persistent'] else ')') if preset_id else ''))
        timeout = float(getattr(server, 'query_timeout', 600) or 600)
        deadline = _time.time() + timeout
        try:
            while not evt.wait(0.5):
                mm.throw_exception_if_processing_interrupted()
                if _time.time() >= deadline:
                    raise RuntimeError(f'Query timed out after {int(timeout)}s — the chain was aborted')
        finally:
            # Whatever happens (answer / cancel / interrupt), nothing stays parked.
            server.pending_query = None
        if query['cancelled']:
            raise RuntimeError('Query cancelled — the chain was aborted')
        if query['answer'] is None:
            raise RuntimeError('Query answered with nothing — the chain was aborted')
        return query['answer']

    def _resolve_ref_image_for_generate_text(self, server, key):
        """取 Enable Edit 的 Ref Image（工作区条目 id），供 Generate Text 使用。

        语义（用户确认）：只有 `enable_edit` 开着、且该 block 真的选了 Ref Image 时才送图；
        取不到就返回 None（调用方静默降级为纯文本）。整体 fail-open —— 这里绝不抛异常，
        否则会顺着生成链路把整条采样链带崩。返回 [B,H,W,C] float tensor 或 None。

        ★ 类归属：必须留在 SnapshotDetailerSamplerNode（run 链路 `self.` 调用），
        不能搬到 Server —— 跨顶层类会退化成只在实机 run 时才炸的 AttributeError。
        """
        if server is None or not key:
            return None
        try:
            img = server.get_staging_image(key)
            if img is None:
                print(f"[GenerateText] ref image id '{key}' not found in staging — text-only")
                return None
            from ...libs.generate_text_utils import normalize_ref_image
            return normalize_ref_image(img)
        except Exception as e:
            print(f"[GenerateText] ref image lookup failed ({e}) — text-only")
            return None

    def _debug_reference_slots(self, block_no, ref_image, ref_latent, injected, pipeline,
                               work_limit=None, ref_limit=None,
                               work_align=None, ref_align=None):
        """把本块 conditioning **真正收到的每一张参考图**按槽位顺序记进 Debug。

        编号对齐 `parse_prompt_image_refs` 解码出的 `<image N>`：1 = context 图，2 起 =
        Extra Prompt 里的 staging 引用（首次出现顺序）。`<image 1>` 以前在面板上是空的 ——
        它不经过注入循环，而是随 `reference_image`（或 Flux2Klein 的本块 latent）从另一条
        入口进 get_conditioning，于是"看不到"被当成了"没嵌进去"。

        ★ 类归属同 `_resolve_ref_image_for_generate_text`：只在 run 链路的 `self.` 上调用。
        """
        if dbg.current_trace() is None:
            return
        vae = pipeline.vae
        slots = []
        # QwenImage21 的第一格是"直传"：与本块 target latent 同一份像素、同一份 latent，
        # 不再独立推尺寸重编码 —— 面板要说清楚，别让人以为它被 ref 旋钮管过。
        is_qwen21 = bool(arch_qwen_image21.matches(pipeline.config))
        first_note = ''
        if is_qwen21:
            first_note = '与 target latent 同源同尺寸，不再缩放；ref 旋钮只管第 2 张起'
        if ref_image is not None:
            if not (work_limit or work_align):
                # 上游 interface 块换过工作图（或 Limit 关）：括号里没旋钮可显示，
                # 就把"尺寸从哪来"写进正文，避免读数空着被误认成没约束。
                first_note += ('；本块尺寸沿用上游产出，未被全局 pixels/align 缩放'
                               if first_note else '尺寸 = 上游产出（未被全局 pixels/align 缩放）')
            slots.append(('Context Image（本块工作图，Enable Edit 下即 <image 1>）', ref_image,
                          work_limit, work_align, first_note))
        elif ref_latent is not None and vae is not None:
            try:
                slots.append(('本块 latent（Flux2Klein 的第一张参考是 latent，此为解码预览）',
                              VAEDecode().decode(vae=vae, samples={'samples': ref_latent['samples']})[0],
                              work_limit, work_align, ''))
            except Exception as e:
                print(f"[Debug] reference slot latent decode failed: {e}")
        for _key, _img in injected:
            slots.append((f'Extra Prompt 嵌图 <image_id:{_key}> → reference_latents', _img,
                          ref_limit, ref_align, ''))

        if not slots:
            dbg.record_stage(f'Block {block_no} · 参考图',
                             '一张都没进 conditioning（Enable Edit 关着时引用图根本不注入）',
                             block=block_no)
            return
        # pipeline 自带的 reference_latents 会插在 context 和嵌图之间，那样 <image N> 的
        # 编号就和真实槽位错位了。正常情况下它是空的，一旦出现必须在面板上说清楚。
        _extra = len((pipeline.reference.reference_latents if pipeline.reference else None) or []) - len(injected)
        if _extra > 0:
            dbg.record_stage(f'Block {block_no} · 参考图编号错位',
                             f'pipeline 自带 {_extra} 条 reference_latents，排在嵌图之前 —— '
                             f'嵌图的实际槽位比文本里的 <image N> 大 {_extra}',
                             block=block_no)
        for n, (_src, _img, _limit, _align, _note) in enumerate(slots, start=1):
            dbg.record_image(f'Block {block_no} · Ref <image {n}>', _img, block=block_no,
                             pixel_limit=_limit, align=_align,
                             detail=f'共 {len(slots)} 张 · 第 {n} 张 · 来源：{_src}'
                                    + (f' · {_note}' if _note else ''))

    def _preflight_generate_text_images(self, images, clip, params):
        """把「这批图到底能不能变成 embedding」实测一遍，供 Debug 显示。

        用户反馈「感觉传进去的 image 并没有正确影响 text generate」—— 光看
        `describe_image_support` 的名字推断不够，这里**真的跑一次 tokenize**，
        数 token 流里有没有 `{'type': 'image'}` 元素：
          · (True,  '已确认 N 个 image embedding 进入 token 流')
          · (False, '★ 图不会生效 — use_default_template=False 绕过了视觉模板 …')
          · (None,  '未验证（tokenize 探针不可用: …)）
        全程 fail-open，绝不抛进采样链（探测用的 tokenize 不产生任何副作用：
        不采样、不解码、不碰 model）。
        """
        if not images or clip is None:
            return None, ''
        # ★ 探测 helper 一律用「模块级 import」拿，别在函数里 `from ..libs import`：
        #   相对导入会解析成 `kolid_comfy.libs.generate_text_utils`，一旦换了加载方式
        #   （装包 / spec_from_file_location / 测试 exec）就会 ImportError，外部表现
        #   是「静默不验证」—— 也就是说这个诊断自己会静默失效。
        try:
            from libs.generate_text_utils import (
                normalize_ref_images, describe_image_support,
                _tokens_contain_image_embedding, text_defeats_vision_template,
                strip_leading_chat_template)
        except Exception:
            try:
                from ...libs.generate_text_utils import (
                    normalize_ref_images, describe_image_support,
                    _tokens_contain_image_embedding, text_defeats_vision_template,
                    strip_leading_chat_template)
            except Exception as e:
                return None, f'未验证（helper 不可用: {e}）'
        try:
            # ★★ 探针必须走与运行时**同一条入口**：`images=`（list of [1,H,W,C]），
            #   而不是 `image=`；两者在 qwen3vl 里等价（内部会拆成同一个 list），
            #   但统一入口能保证 Debug 结论与 run_generate_text 的实测结论一致。
            #   踩过的坑：这里曾写成 `clip.tokenize(batch, ...)` —— 把整张图当 text 传，
            #   于是永远数不到 image embedding，Debug 里长期假报「图不会生效」，
            #   与 run_generate_text 的实测结论自相矛盾。
            img_list, kept = normalize_ref_images(images, single=True)
            if img_list is None:
                return False, '★ 图不会生效 — 没有可用图（尺寸不一致 / 归一失败）'
            ok, why = describe_image_support(clip, bool((params or {}).get(
                'use_default_template', True)))
            if not ok:
                return False, f'★ 图不会生效 — {why}'
            use_tpl = bool((params or {}).get('use_default_template', True))
            # ★★ 还有一个更隐蔽的坑：文本若以 `<|im_start|>` 之类的 chat 模板标记开头，
            #   编码器 qwen3vl.py:167 的 `skip_template = skip_template or
            #   text.startswith('<|im_start|>')` 会直接绕掉视觉模板 → 图静默失效。
            #   ★ 探针文本必须与运行时一致地做 strip（指令为空时文本就是 chat 模板本身，
            #   运行时已经 strip 掉了，探针不 strip 就会得出相反的结论）。
            instr = str((params or {}).get('_instruction') or '').strip()
            probe_text = instr if instr else 'x'
            try:
                probe_text, _ = strip_leading_chat_template(probe_text)
            except Exception:
                pass
            if not probe_text.strip():
                probe_text = 'x'  # 编码器对空文本会走 prevent_empty_text 分支
            tokens = clip.tokenize(
                probe_text, images=img_list, skip_template=not use_tpl,
                min_length=1, prevent_empty_text=True)
            found, count = _tokens_contain_image_embedding(tokens)
            if found:
                return True, (f'已确认生效 — {count} 个 image embedding 进入 token 流'
                              f'（{len(kept)} 张图）')
            return False, ('★ 图不会生效 — clip.tokenize 收到了图，但 token 流里'
                           '没有任何 image embedding（视觉模板被绕过 / 编码器非多模态）')
        except Exception as e:
            return None, f'未验证（tokenize 探针失败: {type(e).__name__}: {e}）'

    # -------------------------------------------------------------------------
    # Detailer
    # -------------------------------------------------------------------------
    def frames_from_batch(self, batch_image, batch_mask=None, base_pipeline=None):
        """一段 batch 的像素 → **一串 pipeline**（每帧一条）。

        视频 segment 的真实载体：执行器之间传的是 `List[PipelineData]`，不是
        `[N,H,W,C]` 张量。这样每帧自带自己的 image / mask / latent / 几何帧栈，
        裁剪框、工作分辨率、检测结论都逐帧成立 —— 6 帧里只有 3 帧检出人物时，
        没检出的那 3 帧原样穿过，不会被硬裁一块再贴回去；也不会出现"图与 mask 不同
        网格"（那是两条显式边拉到一起才有的问题，单帧下 manifest 里没有这个可能）。

        共享层（**同一个对象，逐帧不重建**）：model / clip / vae / context /
        reference / config / `_cond_store`。私有层：image / mask / latent /
        `resize_info_stack` / SamplerCache（`inverted_latent` 的键只有 block 序号，
        共享的话第二帧会盖掉第一帧那份噪声）。
        """
        base = base_pipeline if base_pipeline is not None else self._base_pipeline
        if base is None:
            raise ValueError('Pipeline not initialized — pick a pipeline in Pipeline Settings first')
        img = batch_image
        if img is None:
            return []
        if isinstance(img, (list, tuple)):
            # 已经是"一列帧"（视频抽帧的产物）：不拼 batch，逐帧原样包成 pipeline。
            frames = [f if f.dim() == 4 else f.unsqueeze(0) for f in img]
            n = len(frames)
            img = None
        else:
            if img.dim() == 3:
                img = img.unsqueeze(0)
            n = int(img.shape[0])
            frames = [img[i:i + 1] for i in range(n)]
        msk = batch_mask
        if msk is not None:
            if msk.dim() == 2:
                msk = msk.unsqueeze(0)
            elif msk.dim() == 4:
                msk = msk[..., 0] if msk.shape[-1] == 1 else msk.squeeze(1)
            # 逐帧各自对齐到自己的帧网格（两张视频的像素尺寸不一定相同）。
            per = []
            for i in range(n):
                m = msk[i] if msk.shape[0] > 1 else msk[0]
                h, w = int(frames[i].shape[1]), int(frames[i].shape[2])
                if tuple(m.shape[-2:]) != (h, w):
                    m = torch.nn.functional.interpolate(
                        m.unsqueeze(0).unsqueeze(1).float(),
                        size=(h, w), mode='bilinear', align_corners=False,
                    ).squeeze(0).squeeze(0)
                per.append(m)
            msk = per
        else:
            per = [None] * n

        pipes = []
        for i in range(n):
            p = base.copy()                      # 共享 model / clip / vae / _cond_store
            # cache 也按引用共享（`copy()` 原本会浅拷贝一份）：执行器内部还会再 copy
            # 一层（`next_pipeline = pipeline.copy()`），所以某一帧写进去的 inverted
            # latent 不会串到别的帧；这里共享省掉的是每帧一份 dict。
            p.cache = base.cache
            p.image = frames[i]                  # [1,H,W,C]：与单图路径同形
            p.mask = per[i] if msk is not None else None
            p.latent = None
            pipes.append(p)
        return pipes

    # 一"组"帧最多同时停在阶段点上多少帧。组内是阶段对齐推进的（所有帧的 text
    # encode 连着算、所有帧的采样连着跑），代价是这一组的中间状态同时驻留内存：
    # 每帧一份工作图 + 一份几何帧栈（crop/limit 的原像素）。8 帧一组在 SDXL 工作
    # 分辨率下约几百 MB，换来的是一次模型上下文里干完一组；段再长就自动切组。
    _STAGE_GROUP = 8

    def _run_pipeline_frames(self, pipes, masks, seeds, user_positive, user_loras,
                             global_params, blocks, server=None, extra_prompt='',
                             prompt_ref_ids=None, graph=None, on_frame=None):
        """一串 pipeline（每帧一条）跑完整条链 —— 视频 segment 的事件循环。

        每帧仍是**独立一趟**：自己的裁剪框、自己的工作分辨率、自己的检测结论
        （逐帧分枝）、自己的几何帧栈。推进顺序是**块优先**（block-major）：

            第 k 颗节点：整组帧全部做完 → 一起交给第 k+1 颗
            第 k+1 颗节点：整组帧全部做完 → 一起交给第 k+2 颗 …

        即"一个 List 在当前节点内处理完，再整体触发下游"：节点之间不交错，一颗
        节点进一次上下文就干完整组帧。detailer 内部的阶段点（conditioning /
        解码屏障）也只在**这一颗节点内部**对齐 —— 整组的 text encode 连着做完才
        逐帧采样，采样全做完才一起解码。

        实现上每帧是一条协程（`_run_pipeline_steps`）：它在每颗节点开头 yield 一个
        `{'kind':'block'}`，在 detailer 内部 yield `{'kind':'cond'|'decode'}`。
        这里按这两类停点做锁步推进，单帧语义因此逐位不变。
        """
        n = len(pipes)
        outs, origs, metas = [None] * n, [None] * n, [None] * n
        last_pipe = None
        done_count = 0
        _total = int(getattr(server, 'preset_video_total', 0) or 0) if server is not None else 0

        group = max(1, int(self._STAGE_GROUP or 1))
        for gstart in range(0, n, group):
            gidx = list(range(gstart, min(n, gstart + group)))
            gens = {}
            for fi in gidx:
                gp = dict(global_params or {})
                if seeds and fi < len(seeds):
                    # 每帧一套种子：帧 i 从 seeds[i] 起，块内仍按 next_seed 往下发。
                    gp['seed'] = int(seeds[fi])
                gens[fi] = self._run_pipeline_steps(
                    pipes[fi],
                    masks[fi] if masks else None,
                    user_positive, user_loras, gp, blocks,
                    server=server, extra_prompt=extra_prompt,
                    prompt_ref_ids=prompt_ref_ids, graph=graph,
                )
            pending = list(gidx)
            # 每条帧当前停住的停点（块边界 / 阶段点）。`resp` 里有条目的帧下一轮被
            # 放行；没有条目 = 被压住不动（别的帧还在同一颗节点里没做完）。
            reqs, resp = {}, {fi: None for fi in gidx}
            fenced = 0          # 整组已经集体越过的最远块号（块边界 index 语义）
            try:
                while pending:
                    if mm.processing_interrupted():
                        raise mm.InterruptProcessingException()
                    # ── 阶段一：把"有回传"的帧推到下一个停点（或跑完）──────────
                    for fi in list(pending):
                        if fi not in resp:
                            continue
                        try:
                            reqs[fi] = gens[fi].send(resp.pop(fi))
                        except StopIteration as stop:
                            pending.remove(fi)
                            reqs.pop(fi, None)
                            _np, _orig, detailed, meta = stop.value
                            last_pipe = _np
                            if detailed is not None:
                                outs[fi] = detailed if detailed.dim() == 4 else detailed.unsqueeze(0)
                            if _orig is not None:
                                origs[fi] = _orig if _orig.dim() == 4 else _orig.unsqueeze(0)
                            metas[fi] = meta
                            done_count += 1
                            if n > 1:
                                print(f"[PipelineFrames] {fi + 1}/{n} done"
                                      f"{'' if detailed is None else ' — ' + str(tuple(detailed.shape))}")
                            if _total:
                                server.preset_video_current = done_count
                                server.preset_video_progress = done_count / _total
                            if on_frame is not None:
                                on_frame(fi, n, detailed)
                    if not pending:
                        break

                    # ── 阶段二：同一颗节点内部的阶段点，整组攒齐再算 ────────────
                    # 全部帧的 text encode 背靠背做，中间不插采样 —— CLIP 因此只在
                    # 上下文里进一次。同键（同 clip / 同提示词 / 同 lora / 同参考）
                    # 的帧直接共享同一份 conditioning：一组帧共用一个提示词时，
                    # 实际只编一次。
                    _stage = [fi for fi in pending
                              if (reqs.get(fi) or {}).get('kind') in ('cond', 'decode')]
                    if _stage:
                        _conds = [(fi, reqs[fi]) for fi in _stage
                                  if reqs[fi].get('kind') == 'cond']
                        if len(_conds) > 1:
                            _uniq = len({req.get('key') for _, req in _conds})
                            print(f"[CondStage] block {_conds[0][1].get('block')}: "
                                  f"{len(_conds)} frame(s) → {_uniq} distinct encode(s), "
                                  f"{len(_conds) - _uniq} shared")
                        _seen = {}
                        resp = {}
                        for fi, req in _conds:
                            _k = req.get('key')
                            if _k is not None and _k in _seen:
                                resp[fi] = _seen[_k]
                                req['elapsed'] = 0.0      # 没编，按共享记 0
                                continue
                            resp[fi] = self._serve_stage(req)
                            if _k is not None:
                                _seen[_k] = resp[fi]
                        for fi in _stage:
                            resp.setdefault(fi, None)     # decode 屏障：send(None) 放行
                        continue

                    # ── 阶段三：块边界。只放行"最靠后"的那一批 ─────────────────
                    # 帧 i 停在 index=k 表示它已经做完 0..k-1 颗节点。最小 index 的那批
                    # 先走完当前这颗，跑到下一个边界；其余帧原地压住 —— 于是整组帧
                    # 永远停在同一颗节点上，"整组做完再一起下行"成立。
                    _bnd = {fi: int((reqs.get(fi) or {}).get('index') or 0) for fi in pending}
                    _mi = min(_bnd.values())
                    resp = {fi: None for fi, ix in _bnd.items() if ix == _mi}
                    if _mi > fenced:
                        fenced = _mi
                        _nb = int((reqs.get(pending[0]) or {}).get('total') or 0)
                        _nm = (reqs.get(pending[0]) or {}).get('name') or ''
                        print(f"[StageFence] {len(resp)}/{n} frame(s) finished block "
                              f"{_mi}/{_nb or '?'}{'' if not _nm else ' (' + str(_nm) + ')'}"
                              f" — moving on to the next block")
                        # 进度条按"块"报：块优先下每帧是同一时刻收工的，帧粒度没有意义。
                        if _total and _nb:
                            server.preset_video_current = int(round(_total * _mi / _nb))
                            server.preset_video_progress = min(0.99, _mi / float(_nb))
            finally:
                # 中途出错 / 被取消：把还挂着的协程关掉，让它们各自的 finally 复原
                # pipeline 状态（model / config 的补丁不能留在共享层上）。
                for fi, g in gens.items():
                    if fi in pending:
                        try:
                            g.close()
                        except Exception:
                            pass

        detailed_all = torch.cat([o for o in outs if o is not None], dim=0) \
            if any(o is not None for o in outs) else None
        orig_all = torch.cat([o for o in origs if o is not None], dim=0) \
            if any(o is not None for o in origs) else None
        _meta = next((m for m in metas if m), None)
        return last_pipe, orig_all, detailed_all, _meta

    def _run_pipeline_blocks(self, pipeline, user_mask, user_positive, user_loras, global_params, blocks, server=None, extra_prompt='', prompt_ref_ids=None, graph=None, frame_seeds=None):
        """跑一条链（或一串帧）。

        `pipeline` 传单个 `PipelineData` = 图像模式：就地驱动同一条协程，
        遇到阶段点立刻算掉，行为与以前一字不差。

        传一串 = 视频段：交给 `_run_pipeline_frames` **按节点锁步推进整组帧** ——
        一颗节点把整组帧全部处理完，才整体交给下一颗（块优先）；detailer 内部再
        把整组的 text encode 连着做完，才放开逐帧采样。
        """
        if isinstance(pipeline, (list, tuple)):
            return self._run_pipeline_frames(
                list(pipeline),
                list(user_mask) if isinstance(user_mask, (list, tuple)) else user_mask,
                frame_seeds, user_positive, user_loras, global_params, blocks,
                server=server, extra_prompt=extra_prompt,
                prompt_ref_ids=prompt_ref_ids, graph=graph,
            )
        gen = self._run_pipeline_steps(
            pipeline, user_mask, user_positive, user_loras, global_params, blocks,
            server=server, extra_prompt=extra_prompt,
            prompt_ref_ids=prompt_ref_ids, graph=graph, frame_seeds=frame_seeds,
        )
        resp = None
        while True:
            try:
                req = gen.send(resp)
            except StopIteration as stop:
                return stop.value
            resp = self._serve_stage(req)

    # 停点（协程 yield 出来的请求）怎么满足：
    #   'block' = 块边界（马上要跑第 index 颗节点）—— 一串帧时是锁步栅栏
    #   'cond'  = 算这一步的 positive / negative conditioning（CLIP text encode）
    #   'decode'= 屏障，只表示"接下来要占 VAE"，没有数据
    # 单条链（图像模式）在这里立刻放行 / 立刻算；一串帧（视频段）由
    # `_run_pipeline_frames` 整组攒齐后连着算 —— 这就是"先一个 List 做下来"。
    def _serve_stage(self, req):
        if not req:
            return None
        if req.get('kind') == 'cond':
            t0 = time.perf_counter()
            value = req['compute']()
            req['elapsed'] = time.perf_counter() - t0
            return value
        return None

    @staticmethod
    def _cond_cache_key(pipeline, clip, positive, negative, ref_latent, ref_image, latent):
        """conditioning 的复用键：**get_conditioning 真正读到的输入**逐项钉死。

        键相等 ⇒ 两次调用在语义上不可区分（同一份 clip / 同一段提示词 / 同一组
        lora / 同一张参考图 / 同一份 config）⇒ 结果必然相同，可以安全共享同一份
        conditioning，不必各自再编一遍。
        - `source_latent` 只有 QwenImage2.1 会读（第一格参考图沿用 target latent）。
          别的架构把它算进键里，每帧的 latent 对象都不同 ⇒ 永远不命中。
        - 参考图 / 参考 latent 在 enable_edit 时就是**逐帧的裁剪区**，id 本来就不同，
          于是这类块自然退化成逐帧编码（该逐帧的就得逐帧）。
        """
        try:
            cfg = tuple(sorted((str(k), str(v)) for k, v in (pipeline.config or {}).items()))
        except Exception:
            cfg = None
        try:
            refs = tuple(id(x) for x in (getattr(pipeline.reference, 'reference_latents', None) or []))
        except Exception:
            refs = ()
        try:
            src = id(latent['samples']) if arch_qwen_image21.matches(pipeline.config) else None
        except Exception:
            src = None
        return ('cond', id(clip), id(pipeline.vae), positive, negative,
                getattr(pipeline, '_cache_loras', None), id(ref_latent), id(ref_image),
                src, cfg, refs)

    def _run_pipeline_steps(self, pipeline, user_mask, user_positive, user_loras, global_params, blocks, server=None, extra_prompt='', prompt_ref_ids=None, graph=None, frame_seeds=None):
        seed = global_params['seed']
        mask_grow = int(global_params.get('mask_grow', 32))
        mask_blur = int(global_params.get('mask_blur', 32))
        context_regex = global_params['context_regex']
        next_pipeline = pipeline.copy()
        if next_pipeline.cache is None:
            raise ValueError('PipelineData cache is empty')
        if next_pipeline.model is None:
            raise ValueError('PipelineData model is empty, cannot Detailer')

        # 两头都空 = 没有任何像素来源：pipeline 没带图，而画布也没交出合成图。这句话以前写在
        # get_image() 下面，永远读不到 —— image 与 latent 皆空时 get_image 自己先抛一句中文长串。
        if next_pipeline.image is None and next_pipeline.latent is None:
            raise ValueError('No image available for detailer — the pipeline carries no image and the '
                             'Blend canvas delivered no composite (add a layer, or open a .cud, first)')
        original_image = next_pipeline.get_image()

        # ── 执行计划：图优先，线性旧链回落 ──────────────────────────────────
        # 图与「旧 blocks 迁移出的图」**逐条相等**时，图就是旧链的同一件事 —— 直接走老
        # 循环（行为一字不差）；只有用户真的在画布上改过接线（分叉 / 重连 / 增删边）时，
        # 才切到图引擎：按 Execute 拓扑序执行、运行时按 detect 命中/未命中放行分支、
        # 并从显式 Image/Mask/Info 边取数。
        # 这一步不碰像素，提前到链首埋点之前做 —— trace 里的 "共 N 个 block" 必须报
        # 真正要执行的步数（旧 blocks 是迁移遗留，缺 switch、含未接线节点，不能拿它数）。
        steps = None
        graph_mode = False
        # 本次运行那条链的图：调用方按它所选的 preset set 传进来；没传就回落实例镜像
        # （激活 set 的图），再不行就地由 blocks 迁移。
        _pg = graph if isinstance(graph, dict) and graph.get('nodes') else getattr(self, 'graph', None)
        if isinstance(_pg, dict) and _pg.get('nodes'):
            try:
                # 执行前先净化：把不合法的东西（悬空边/端口不存在/kind 不匹配/环…）丢掉，
                # 保证执行计划一定建立在合法的图上 —— 与前端载入时的净化同一套规则。
                _pg = sanitize_graph(_pg)
                _expected = blocks_to_graph(blocks)
                _sig = lambda g: sorted(
                    (e.get('source'), e.get('sourcePort'), e.get('target'), e.get('targetPort'))
                    for e in g.get('edges', []))
                if _sig(_pg) != _sig(_expected):
                    steps = exec_plan(_pg)
                    graph_mode = True
            except Exception as _e:
                print(f'[Detailer] graph planning failed, falling back to the flat chain: {_e}')
        if not graph_mode:
            steps = [{'id': b.get('id'), 'type': b.get('type'), 'name': b.get('name'),
                      'params': b.get('params', b), 'interface_index': b.get('interface_index'),
                      'exec_options': b.get('exec_options'), 'guard': [], 'inputs': None}
                     for b in blocks]

        # Preprocess 的三枚开关（enable_mask / recover_crop / enable_limit）现在住在图里的黑板
        # 节点上（旧格式存在第一个 detailer 的 params，黑板缺 key 时回落到那里）；数值参数
        # crop_reserve / pixels / align 是 DEFAULT SETTING（server config → global_params），
        # 不按 preset 区分。必须在这里先取 —— mask 扩张也要看 enable_mask。
        # 没有旧 blocks（纯图 preset）时 first_detailer 为 None —— 开关全走黑板。
        first_detailer = next((b for b in blocks if b.get('type') == 'detailer'), None)
        first_bp = (first_detailer or {}).get('params') or {}
        # 这三枚开关现在的家在**图里那块黑板**（board 节点）；旧格式存在第一个 detailer 的
        # params 上 —— 黑板没有该 key 时回落到那里，存量 preset 不迁移也能跑。
        _pg_pre = graph if isinstance(graph, dict) and graph.get('nodes') else getattr(self, 'graph', None)
        _board = next((n.get('params') or {} for n in (_pg_pre or {}).get('nodes') or []
                       if isinstance(n, dict) and n.get('kind') == 'board'), {})
        # Enable Mask 关 = 不做围绕 mask 的三步预处理：grow/blur 归零、不按 mask 裁剪、
        # 不 recover crop（Start / End 也没有 Mask 端口）。mask 本身仍然限制重绘区域。
        enable_mask = bool(_board.get('enable_mask', first_bp.get('enable_mask', True)))

        # 这里的开关必须**就是**下面真正生效的那一份（黑板优先），不能再拿 blocks[0]
        # 的 params 读 —— blocks 是旧链投影，detect 打头、黑板不在里面，读出来恒为 True。
        dbg.record_block(0, f'链条开始（共 {len(steps)} 个 block）',
                         f'enable_mask={enable_mask}')
        dbg.record_stage('原始输入',
                         f'image={tuple(original_image.shape)}',
                         block=0,
                         user_positive=user_positive,
                         user_loras=debug_lora_entries(user_loras))
        dbg.record_image('裁剪前原图（original_image）', original_image, block=0)
        if user_mask is not None:
            dbg.record_mask('原始 mask（未扩张）', user_mask, block=0)

        if user_mask is not None:
            user_mask = user_mask.clone()
            user_mask = (user_mask > 0).float()

        if not enable_mask:
            mask_grow = 0
            mask_blur = 0
        # mask 可能整体缺席（Enable Mask 关 + 没画 Mask 层）：expand_mask 不接受 None，
        # 没有 mask 就没有可扩张的东西，直接置 None（下游全部对 None 容错）。
        expanded_mask = (expand_mask(user_mask, grow=mask_grow, blur=mask_blur)
                         if user_mask is not None else None)
        dbg.record_mask('扩张 / 羽化后 mask', expanded_mask, block=0,
                        detail=f'grow={mask_grow}, blur={mask_blur}')

        # 整条链（含 interface block）都在 crop 工作区坐标系内运行；run 之前 crop，
        # run 之后由 recover 系列复原。interface block 不重算/不操作 mask 的 crop，
        # 但其输出尺寸须与 crop 工作区连贯（由用户/子图保证，pipeline 内不做 resize）。
        first_crop_reserve = int(global_params.get('crop_reserve', 32))
        # Preprocess 的 Recover Crop 开关（与 crop_reserve 一样，现在取自黑板）。关掉时这一趟
        # 产出停在 crop 工作区：不 recover_size、不 recover_crop，patch 连同裁剪矩形交给前端，
        # 由 Blend 画布用 transform 贴回原位。
        do_recover_crop = bool(_board.get('recover_crop', first_bp.get('recover_crop', True)))
        if enable_mask and expanded_mask is not None:
            cropped_image, cropped_mask, crop_info = crop_mask(
                image=original_image,
                mask=expanded_mask,
                reserve=first_crop_reserve
            )
        elif enable_mask:
            # Enable Mask 开着但**没有 mask**：链上有 Detect 块时这是合法状态 —— 整幅就是
            # 工作区，mask 由 Detect 在链里现造（没有 Detect 的话 run_detailer 的闸门早拦了，
            # 走不到这里）。没有裁剪矩形，链尾也就不贴、不做 patch 回贴。
            cropped_image, cropped_mask, crop_info = original_image, None, None
            print("[Detailer] Enable Mask on but no mask was given — workspace = the full image; "
                  "a Detect block has to supply the mask")
            dbg.record_stage('裁剪跳过（没有 mask，等 Detect 造）',
                             f'工作区 = 整幅图 {tuple(original_image.shape)}', block=0)
        else:
            # Enable Mask 关：整幅图就是工作区。没有裁剪矩形（crop_info=None），收尾
            # 也就不走 recover 与「patch 贴回」两条路 —— 产出本身就是整幅结果。
            cropped_image, cropped_mask, crop_info = original_image, expanded_mask, None
            print(f"[Detailer] Enable Mask off — no grow/blur, no crop, no recover; "
                  f"workspace = the full image {tuple(original_image.shape)}")
            dbg.record_stage('裁剪跳过（Enable Mask 关）',
                             f'工作区 = 整幅图 {tuple(original_image.shape)}', block=0)

        # limit_pixels 提到 crop 之后只做一次，确定全局工作分辨率（所有 block 共享）。
        # pixels / align 取自 DEFAULT SETTING（global_params ← server config），不再按
        # preset 区分。interface 之后的 block 不再单独 limit，pipeline 内不做额外 resize。
        limit_pixels_val = int(global_params.get('pixels', 1048576))
        limit_align = int(global_params.get('align', 8))
        # 输入侧显存封顶：ref image 与 generate text 的图在进 VAE / 多模态塔**之前**先按
        # cap_only 语义 limit 一刀 —— pixels 是上限而不是目标（只压不涨），align 向下落格。
        # pixels=0 = 不设上限（limit_pixels 的 cap_only 分支把 falsy pixels 当"无预算"）。
        ref_cap_pixels = int(global_params.get('ref_pixels', 0))
        ref_cap_align = int(global_params.get('ref_align', 8)) or 1
        tgen_cap_pixels = int(global_params.get('tgen_pixels', 0))
        tgen_cap_align = int(global_params.get('tgen_align', 8)) or 1
        # QwenImage2.1: crop 尺寸需与 vision token / latent 共享的 32 像素格对齐
        # 即使 Enable Limit 关掉也要保住 —— 它的 latent 网格不接受未对齐尺寸。
        needs_grid_align = bool(arch_qwen_image21.matches(next_pipeline.config))
        if needs_grid_align:
            limit_align = arch_qwen_image21.adjust_align(limit_align)
        enable_limit = bool(_board.get('enable_limit', first_bp.get('enable_limit', True)))
        if not enable_limit and not needs_grid_align:
            # Enable Limit 关：不缩放也不对齐，工作分辨率 = 裁剪（或整幅）分辨率。
            resized_image, resized_mask, resize_info = cropped_image, cropped_mask, None
        elif enable_limit:
            # Pixels 是"目标"（limit_pixels 语义）：大图缩小、小图放大补足到预算。
            resized_image, resized_mask, resize_info = limit_pixels(
                cropped_image, limit_pixels_val, cropped_mask, limit_align)
        else:
            # Limit 关但架构要求格子对齐（QwenImage2.1 的 latent/vision 网格）：
            # 同一次 limit_pixels 调用里只落格不缩放 —— pixels 传 None 即
            # "不设像素目标"，仅就近吸附到 align 格，尺寸变动至多半格。
            resized_image, resized_mask, resize_info = limit_pixels(
                cropped_image, None, cropped_mask, limit_align)

        current_image = resized_image
        current_mask = resized_mask
        # 链首 Limit 的那一份 resize_info 就是「还没还掉的那次缩放」。以前这里是 None、
        # 只有 detailer 跑完才把它接过来（见 block 循环末尾），于是**一条没有 detailer 的
        # 链**（纯几何链）链尾既不 recover_size 也不贴得回去，recover_crop 会因为尺寸不匹配
        # 直接抛。现在开局就认它 —— 有 detailer 的链随后会把它覆盖成同一个值，行为不变。
        last_resize_info = resize_info
        last_resized_mask = resized_mask
        # 「最近那一次 Scale / Limit 的**前后尺寸**」（= limit_pixels 自己吐的那份）。
        # detailer 的中途复原要落回**这一步之前**的尺寸 —— 那是链上当前的坐标系，后面的
        # Recover 块都按它算。不能拿 last_resize_info 顶替：它的 original_* 是**链首复原
        # 落点**（= 原始输入尺寸），链首 crop/limit 之后又摆了显式 Scale/Limit 时两者会
        # 分叉 —— 用错就把重绘结果先压回原始尺寸、再被后面的 Recover 拉回工作尺寸，
        # 白白多一次降采样（1272x824 → 720x404 → 1179x760）。
        step_resize_info = resize_info
        # 工作分辨率是被哪颗像素旋钮定下来的（None = Enable Limit 关，尺寸就是裁剪结果）。
        # interface 块会把 current_image 换成子图产物 —— 那张没被 limit 过，届时置 None。
        work_pixel_limit = limit_pixels_val if enable_limit else None
        # 落格同理：没走 limit 也没走架构格子（或 align=1）时这张图不曾被对齐过，不给读数。
        work_align = (limit_align if (enable_limit or needs_grid_align) and limit_align > 1
                      else None)
        dbg.record_stage('裁剪 + 缩放后工作区',
                         f'image={tuple(resized_image.shape)}'
                         + (f', mask={tuple(resized_mask.shape)}' if resized_mask is not None else ', mask=None'),
                         block=0,
                         crop_info=({k: (list(v) if isinstance(v, tuple) else v)
                                     for k, v in crop_info.items()} if isinstance(crop_info, dict) else crop_info),
                         resize_info=(list(resize_info) if isinstance(resize_info, (list, tuple)) else resize_info))
        dbg.record_image('裁剪 / 缩放后工作图', resized_image, block=0,
                         pixel_limit=work_pixel_limit, align=work_align)
        dbg.record_mask('裁剪 / 缩放后工作 mask', resized_mask, block=0,
                        pixel_limit=work_pixel_limit, align=work_align)

        # ── 链上的几何帧（Crop / Meet / Fit 各压一帧，Recover 块按类弹栈）─────────────
        # 两个口径：①**总闸照旧**工作 —— 链首那次隐式 crop 不因为这个新机制搬家，
        # 它只是把 crop_info 记成「开着的」，于是链中的 Recover Crop 块也能提前把它消费掉
        # （消费后链尾就不再贴第二遍）；②显式块是**额外一层**，Crop/Meet/Fit 各自压帧，
        # Recover 只弹**栈顶且同类**的那一帧 —— 跨种类恢复会把坐标算错，所以宁可报错。
        # 没放任何新块时 geo_open 恒空、crop_info_open 恒等于 crop_info ⇒ 老链路一字不差。
        crop_info_open = crop_info
        geo_open = []

        # ── 软帧收尾（Scale / Limit）─────────────────────────────────────────────
        # Crop/Meet/Fit 的 Recover 要弹自己那帧时，如果上面压着 Scale/Limit，**先按背景把
        # 尺寸还原回去**再弹 —— 那两步只改分辨率，还原没有歧义，没道理逼用户多补两颗块。
        # keep = 别收同类的软帧（Recover Scale 要弹的就是它自己那一帧）。
        # 用闭包是因为它要改 current_image / current_mask 这一对工作值（与各分支同源）。
        def _close_soft_frames(_geo, keep=None):
            nonlocal current_image, current_mask, last_resize_info, last_resized_mask
            nonlocal step_resize_info
            while (_geo and _geo[-1].get('kind') in GEO_SOFT_KINDS
                   and _geo[-1].get('kind') != keep):
                _f = _geo.pop()
                _bg = _f.get('bg')
                _before = f'{int(current_image.shape[2])}x{int(current_image.shape[1])}'
                current_image, current_mask = recover_scale_image(
                    current_image, current_mask,
                    {'original_width': int(_bg.shape[2]), 'original_height': int(_bg.shape[1])},
                    background=_bg)
                # 记账跟着回到那一档：original_* 仍是链首的原始落点，只有 resized_* 换掉。
                if last_resize_info is not None:
                    last_resize_info = {
                        **last_resize_info,
                        'resized_width': int(current_image.shape[2]),
                        'resized_height': int(current_image.shape[1]),
                        'scale_factor': int(current_image.shape[2]) / max(
                            1, int(last_resize_info.get('original_width') or 1)),
                    }
                last_resized_mask = current_mask
                step_resize_info = None
                print(f'[PipelineBlock] auto-closed {_geo_kind_label(_f.get("kind"))} frame from '
                      f'block {_f.get("block")} ({_before} → '
                      f'{int(current_image.shape[2])}x{int(current_image.shape[1])})')

        # Save original pipeline state for restoration after each block
        _orig_enable_edit = next_pipeline.config.get("enable_edit") if next_pipeline.config else None
        _orig_grounding_px = next_pipeline.config.get("grounding_px") if next_pipeline.config else None
        _orig_ref_latents = list(next_pipeline.reference.reference_latents) if next_pipeline.reference and next_pipeline.reference.reference_latents else []
        _orig_model = next_pipeline.model
        _orig_model_negative = next_pipeline.config.get("model_negative") if next_pipeline.config else None

        # Enable Edit: 在 block 循环之前对 pipeline model 统一打一次补丁（与
        # PipelineEnableEditNode / 主 SamplerNode 路径相同的机制）。ref_boost 等
        # 为 pipeline 级 config，对所有 block 相同；fit_mode 由 block 级
        # edit_mode 逐 block 写入 pixel_state（forward 动态读取）。之后循环内
        # get_model_clip() 的 clone 共享补丁闭包（含 pixel_state），节点级
        # source 注入（source_images / source_latents）直接写入 pixel_state ——
        # conditioning 只承载 grounded encode 语义输出（数据流分离，对齐
        # krea2edit source patch 参考）。Krea2: source patch（fit/crop 双模式）；
        # Flux2Klein: 原生 ref 路径。
        _edit_patched = False
        _edit_pixel_state = None
        _any_edit = any(
            (b.get('params', b) or {}).get('enable_edit', False)
            for b in blocks if b.get('type') != 'interface'
        )
        if _any_edit:
            architecture = next_pipeline.config.get("architecture") if next_pipeline.config else None
            if architecture and re.search(r"Krea2", architecture, re.IGNORECASE):
                ref_boost = next_pipeline.config.get("ref_boost", 1.0)
                ref_boost_a = next_pipeline.config.get("ref_boost_a", 1.0)
                ref_boost_mask = next_pipeline.config.get("ref_boost_mask", None)
                vae = next_pipeline.vae
                pixel_state = {"fit_mode": "fit", "vae": vae, "source_images": None, "source_latents": None, "px_cache": {}}
                next_pipeline.model = arch_krea2.apply_model_patch(
                    next_pipeline.model, ref_boost, ref_boost_a, ref_boost_mask, "fit", vae, pixel_state)
                if _orig_model_negative is not None:
                    next_pipeline.config["model_negative"] = arch_krea2.apply_model_patch(
                        _orig_model_negative, ref_boost, ref_boost_a, ref_boost_mask, "fit", vae, pixel_state)
                _edit_patched = True
                _edit_pixel_state = pixel_state
                print(f"[Detailer] Krea2 edit patch applied to pipeline model (ref_boost={ref_boost}, ref_boost_a={ref_boost_a})")
            elif architecture and re.search(r"Flux2Klein", architecture, re.IGNORECASE):
                next_pipeline.model = arch_flux2klein.apply_model_patch(next_pipeline.model)
                if _orig_model_negative is not None:
                    next_pipeline.config["model_negative"] = arch_flux2klein.apply_model_patch(_orig_model_negative)
                _edit_patched = True
                print("[Detailer] Flux2Klein edit patch applied to pipeline model")

        try:
            # 执行计划（steps / graph_mode / _pg）已经在链首埋点之前算好了 —— 这里直接用。
            # 图引擎的端口值表：Start 交出链首裁剪/缩放后的工作图与 mask。
            _values = {(START_ID, 'image'): resized_image, (START_ID, 'mask'): resized_mask}
            _det_verdict = {}      # detect 节点 id → 命中与否（运行时分支依据）
            # 这次真正**执行过**的节点（switch 判"哪条分枝活着"用，见 switch 分支）。
            # 被 guard / 缺输入 / 缺值跳过的不算 —— 它们的产物只可能是旧值。
            _ran = {START_ID}
            # 节点 id → kind（switch 要靠它认出 exec 头的源是不是 detect）。
            _kind_of = ({str(n.get('id')): n.get('kind') for n in (_pg.get('nodes') or [])}
                        if (graph_mode and isinstance(_pg, dict)) else {})
            _prev = None           # 上一颗真正执行的节点 {id,kind,index}
            _step_inputs = None    # 当前节点的显式输入连线（图模式才有）
            det_hit = True         # 每轮默认 True；只有 detect 会改写

            def _take_explicit_info(_info_kind):
                """图模式下：当前节点若有指向该类型 Info 的显式边，取其帧并从 geo_open 摘掉
                （显式配对后不再靠"弹栈顶"）。非图模式 / 无边 → None（回落老栈）。"""
                if not (graph_mode and _step_inputs):
                    return None
                _src = _step_inputs.get(_info_kind)
                if _src is None:
                    return None
                _fr = _values.get((_src[0], _src[1]))
                if _fr is None:
                    return None
                for _j in range(len(geo_open) - 1, -1, -1):
                    if geo_open[_j] is _fr:
                        geo_open.pop(_j)
                        break
                return _fr

            for i, step in enumerate(steps):
                # ── 块边界 ───────────────────────────────────────────────────
                # 每颗节点开头停一下，把"我马上要跑第 i 颗"交出去。一串帧时由
                # `_run_pipeline_frames` 做锁步：整组帧都做完第 i 颗，才一起放行第
                # i+1 颗 —— 一个 List 在当前节点内处理完，再整体触发下游。
                # 单条链（图像模式）就地放行（`_serve_stage` 对这种停点返回 None），
                # 行为与以前一字不差。
                yield {'kind': 'block', 'index': i, 'total': len(steps),
                       'name': step.get('name') or step.get('type') or step.get('kind')}
                block = {'id': step.get('id') if step.get('id') is not None else f'block-{i+1}',
                         'type': step.get('type') or step.get('kind'),
                         'name': step.get('name'),
                         'params': step.get('params') or {},
                         'interface_index': step.get('interface_index'),
                         'exec_options': step.get('exec_options')}
                _kind = block['type']
                is_last = (i == len(steps) - 1)

                # (1) 收下上一颗节点的输出存进值表（图模式；detect 顺带记命中）
                if graph_mode and _prev is not None:
                    _pid, _pk, _pi = _prev['id'], _prev['kind'], _prev['index']
                    if port_kind(_pk, 'out', 'image') == 'image':
                        _values[(_pid, 'image')] = current_image
                    if port_kind(_pk, 'out', 'mask') == 'mask':
                        _values[(_pid, 'mask')] = current_mask
                    _iop = OP_INFO_PORT.get(_pk)
                    if _iop is not None and geo_open and geo_open[-1].get('block') == _pi + 1:
                        _values[(_pid, _iop[0])] = geo_open[-1]
                    if _pk == 'detect':
                        _det_verdict[_pid] = bool(det_hit)
                    _prev = None

                # (2) 运行时分支约束：detect 分支决定只在该放行时才跑这颗节点
                _guard = step.get('guard') or []
                if graph_mode and _guard:
                    _ok = True
                    for _did, _want in _guard:
                        _hit = _det_verdict.get(_did)
                        if _hit is None or (_hit != (_want == 'yes')):
                            _ok = False
                            break
                    if not _ok:
                        print(f"[PipelineBlock {i+1}/{len(steps)}] {block.get('name') or _kind} skipped "
                              f"(detect branch not taken)")
                        continue

                # (3) 显式取数：从连线指向的源端口拿 image / mask。
                # **数据只沿显式连线流动** —— 没给某类输入接线，这颗就拿不到那份数据，
                # 绝不沿用上一颗执行过的节点的工作图/mask（那种隐式流转语义不确定、也无法校验）。
                _step_inputs = step.get('inputs') if graph_mode else None
                if graph_mode:
                    if port_kind(_kind, 'in', 'image') == 'image':
                        _isrc = (_step_inputs or {}).get('image')
                        if _isrc is None:
                            print(f"[PipelineBlock {i+1}/{len(steps)}] {block.get('name') or _kind} skipped "
                                  f"(Image input is not connected)")
                            continue
                        _iv = _values.get((_isrc[0], _isrc[1]))
                        if _iv is None:
                            print(f"[PipelineBlock {i+1}/{len(steps)}] {block.get('name') or _kind} skipped "
                                  f"(Image input has no value)")
                            continue
                        # 目标端口要 image，拿到的东西却不像 image —— 按 mask 处理，铺成
                        # 3 通道黑白图（ComfyUI 的 IMAGE 恒为 [B,H,W,3]，所以形状就是判据）：
                        #   · 源端口明写是 Mask（图里 mask → image 的合法接线，见 ports_compatible）；
                        #   · 源端口是 Switch 的 data 口（any，链上看不出类型，只能在运行时判）。
                        _ishape = tuple(getattr(_iv, 'shape', ()) or ())
                        if len(_ishape) != 4 or int(_ishape[-1]) != 3:
                            _mi = mask_as_image(_iv)
                            if _mi is None:
                                print(f"[PipelineBlock {i+1}/{len(steps)}] {block.get('name') or _kind} skipped "
                                      f"(the Mask wired into Image has an unusable shape: {_ishape})")
                                continue
                            print(f"[PipelineBlock {i+1}] Mask wired into an Image input — "
                                  f"{_ishape} → {tuple(_mi.shape)} (greyscale RGB)")
                            _iv = _mi
                        current_image = _iv
                        next_pipeline.image = _iv
                    if port_kind(_kind, 'in', 'mask') == 'mask':
                        _msrc = (_step_inputs or {}).get('mask')
                        # 没接线（可选端口未连，或连线缺失）= 这颗没有 mask。
                        current_mask = _values.get((_msrc[0], _msrc[1])) if _msrc is not None else None

                # 图与 mask 必须同网格。显式取数时两者可能来自**不同的上游端口**（image 接
                # detailer 的输出、mask 接更上游 Limit/Detect 的输出），各自停在自己的分辨率
                # 上 —— 后面任何按 mask 合成的块都会死在尺寸校验里（真踩过：
                # image=404x720 而 mask=824x1272）。mask 是这张图的覆盖图，跟着图走才对。
                if (current_mask is not None and current_image is not None
                        and tuple(current_mask.shape[-2:]) != tuple(current_image.shape[1:3])):
                    print(f'[PipelineBlock {i+1}] mask {tuple(current_mask.shape)} is off the image '
                          f'grid {tuple(current_image.shape[1:3])} — resampling the mask onto it')
                    _mt = current_mask
                    if _mt.dim() == 2:
                        _mt = _mt.unsqueeze(0).unsqueeze(0)
                    elif _mt.dim() == 3:
                        _mt = _mt.unsqueeze(1)
                    else:                      # [B,H,W,C]（如 4 通道 mask）：取首通道
                        _mt = _mt[..., :1].permute(0, 3, 1, 2)
                    current_mask = torch.nn.functional.interpolate(
                        _mt.float(),
                        size=(int(current_image.shape[1]), int(current_image.shape[2])),
                        mode='bilinear', align_corners=False).squeeze(1).clamp_(0.0, 1.0)
                    next_pipeline.mask = current_mask

                det_hit = True
                _ran.add(block['id'])
                _prev = {'id': block['id'], 'kind': _kind, 'index': i}

                # 每个 block 执行前检查 interrupt 状态
                mm.throw_exception_if_processing_interrupted()

                # ── Switch（倒过来的 switch / gather）──────────────────────────
                # 输入多头（每条分枝 = 一个 exec 头 + 它下面的若干 data，data 无类型），输出单头：
                # 1 个 exec + N 个 data，N = 各分枝 data 数的最大值。
                #
                # 取数顺序：**先看这次真走了哪条分枝**，走的那条优先；剩下的按原顺序兜底。
                # 只按"分枝顺序取第一个有值的"是不够的 —— 未命中那条分枝的数据口通常接
                # Start.image（永远有值），于是它会顶掉真正跑完的那条（人物细化整条链的
                # 产出就被换回原图，看着像"没生效"）。
                if block.get('type') == 'switch':
                    _sw_id = block['id']
                    _branches = (block.get('params') or {}).get('branches') or []
                    _n_out = switch_n(block.get('params') or {})
                    _live = switch_live_branches(
                        len(_branches),
                        {_b: (_step_inputs or {}).get(sw_exec_in(_b))
                         for _b in range(len(_branches))},
                        _det_verdict, _ran, _kind_of)
                    _order = switch_branch_order(len(_branches), _live)
                    _filled = 0
                    for _i in range(_n_out):
                        _val = None
                        for _b in _order:
                            _src = (_step_inputs or {}).get(sw_data_in(_b, _i))
                            if _src is None:
                                continue
                            _v = _values.get((_src[0], _src[1]))
                            if _v is not None:
                                _val = _v
                                break
                        _values[(_sw_id, sw_data_out(_i))] = _val
                        if _val is not None:
                            _filled += 1
                    print(f"[PipelineBlock {i+1}/{len(steps)}] Switch block: "
                          f"{len(_branches)} branch(es) → exec + {_n_out} data ({_filled} filled, "
                          f"live={[b + 1 for b in _live] or 'none'})")
                    dbg.record_block(i + 1, f'Block {i+1} · Switch',
                                     f'{len(_branches)} branches → {_n_out} data',
                                     branches=len(_branches), outputs=_n_out, filled=_filled,
                                     live_branches=[b + 1 for b in _live])
                    continue

                if block.get('type') == 'interface':
                    # Interface 块在 chain 内执行：以当前 pipeline 的 image/mask 作为输入，
                    # 执行子图后把结果写回 pipeline，作为下一 block 的输入（不加入 history）。
                    print(f"[PipelineBlock {i+1}/{len(steps)}] Interface block — executing sub-graph (chain mode)")
                    bp = block.get('params', block)
                    # 按接口名绑定（接口包重排/增删不会错绑到别的接口）；旧配置没有名字时
                    # 回退到下标。名字解不出 = 接口已不存在 → 标记性跳过（bypass），不中断 chain。
                    interface_name = bp.get('interface_name')
                    interface_idx = -1
                    if interface_name:
                        interface_idx = next(
                            (j for j, p in enumerate(server.interface_packages)
                             if isinstance(p, dict) and (p.get('name') or '') == interface_name),
                            -1)
                        if interface_idx < 0:
                            print(f"[PipelineBlock {i+1}] WARNING: interface '{interface_name}' not found "
                                  f"({len(server.interface_packages)} interface packages) — MISSING, bypassing block")
                            continue
                    else:
                        interface_idx = int(bp.get('interface_idx', block.get('interface_index', -1)))
                    if interface_idx < 0 or interface_idx >= len(server.interface_packages):
                        print(f"[PipelineBlock {i+1}] WARNING: invalid interface_idx={interface_idx}, skipping block")
                        continue

                    exec_options = {
                        'operation': bp.get('operation', 'default'),
                        'crop_reserve': int(bp.get('crop_reserve', 32)),
                        'image_keys': bp.get('image_keys', {}) or {},
                    }
                    manual_values = bp.get('manual_values', {}) or {}

                    # 输入图/mask：优先用本 block 显式选择的 context image；否则沿用
                    # 上一 block 输出的 current_image / current_mask（即 pipeline 流水线传递）。
                    # 注意：传入 interface 的 mask 需 clone 一个独立副本——interface 子图可能
                    # in-place 修改传入的 mask tensor，若不隔离会通过引用共享污染上游 pipeline。
                    block_input_img = current_image
                    block_input_mask = current_mask.clone() if current_mask is not None else None
                    ctx_img_key = bp.get('context_image_key')
                    if ctx_img_key and server is not None:
                        sel_img = server.get_staging_image(ctx_img_key)
                        if sel_img is not None:
                            block_input_img = sel_img
                            print(f"[PipelineBlock {i+1}] Interface using staging image id={ctx_img_key}")
                        else:
                            print(f"[PipelineBlock {i+1}] WARNING: staging image id '{ctx_img_key}' not found, using pipeline image")
                    ctx_mask_key = bp.get('context_mask_key')
                    if ctx_mask_key and server is not None:
                        sel_mask = server.get_staging_image(ctx_mask_key)
                        if sel_mask is not None:
                            block_input_mask = sel_mask
                            print(f"[PipelineBlock {i+1}] Interface using context mask key={ctx_mask_key}")

                    dbg.record_block(i + 1, f'Block {i+1} · Interface',
                                     str(bp.get('interface_name') or f'idx={interface_idx}'),
                                     operation=exec_options.get('operation'),
                                     crop_reserve=exec_options.get('crop_reserve'),
                                     image_keys=exec_options.get('image_keys') or {},
                                     manual_values=manual_values)
                    dbg.record_image(f'Block {i+1} · Interface 输入图', block_input_img, block=i + 1)
                    dbg.record_mask(f'Block {i+1} · Interface 输入 mask', block_input_mask, block=i + 1)

                    # 子图里的节点能扛多大 batch 不由我们保证（第三方节点多半按单图写的），
                    # 所以 batch 在这里就地拆帧跑 —— 与 Detect 同一口径：只拆这一个块，
                    # 不走"每帧一遍整链"。
                    _if_B = (int(block_input_img.shape[0])
                             if block_input_img is not None and block_input_img.dim() == 4 else 1)
                    if _if_B > 1:
                        print(f"[PipelineBlock {i+1}] Interface block: running per-frame on a "
                              f"batch of {_if_B} (sub-graph nodes take one image at a time)")
                        _if_imgs, _if_masks = [], []
                        for _k in range(_if_B):
                            _ri, _rm = self._execute_interface(
                                server, interface_idx, manual_values,
                                exec_options=exec_options,
                                input_image=block_input_img[_k:_k + 1],
                                input_mask=(block_input_mask[_k:_k + 1]
                                            if block_input_mask is not None else None),
                                return_image=True,
                                base_pipeline=next_pipeline,
                            )
                            _if_imgs.append(_ri if _ri.dim() == 4 else _ri.unsqueeze(0))
                            _if_masks.append(_rm if (_rm is not None and _rm.dim() == 3)
                                             else (_rm.unsqueeze(0) if _rm is not None else None))
                        result_img = torch.cat(_if_imgs, dim=0)
                        result_mask = (torch.cat(_if_masks, dim=0)
                                       if all(m is not None for m in _if_masks) else None)
                    else:
                        result_img, result_mask = self._execute_interface(
                            server, interface_idx, manual_values,
                            exec_options=exec_options,
                            input_image=block_input_img,
                            input_mask=block_input_mask,
                            return_image=True,
                            base_pipeline=next_pipeline,
                        )

                    # 写回 pipeline + 局部变量，供下一 block 串联（block 间以 pipeline 传递
                    # 全部上下文：image/mask/model/clip/context/loras 等）。interface 子图
                    # 的输出尺寸由其自身决定（与 crop 工作区连贯由用户/子图保证），直接注入
                    # pipeline 原样往下传递——不在 pipeline 内做任何 image/mask 的 resize。
                    # mask 也写回（但不做 mask 的 crop 重算等操作）。
                    next_pipeline.image = result_img
                    next_pipeline.mask = result_mask
                    current_image = result_img
                    current_mask = result_mask
                    # 子图产物的尺寸由它自己决定，全局 pixels 目标没有作用在它身上。
                    work_pixel_limit = None
                    work_align = None
                    print(f"[PipelineBlock {i+1}] Interface done: result shape={result_img.shape if hasattr(result_img, 'shape') else None}")
                    dbg.record_image(f'Block {i+1} · Interface 输出图', result_img, block=i + 1)
                    dbg.record_mask(f'Block {i+1} · Interface 输出 mask', result_mask, block=i + 1)
                    continue

                if block.get('type') == 'query':
                    # Query 块：链条停在这里，前端弹 prompt UI 让用户现场挑；回答按 prompt 块
                    # 的语义合并注入（全局在前 + 本次选择在后 + programs 在合并结果上执行），
                    # 只影响其后的 detailer。取消/超时 = 中止整条链（用户明确要求）。
                    # 绑定了 preset 的 Query 以 preset 为弹窗初始勾选；Persistent 的写回发生在
                    # /api/query_answer 里（见 _answer_pending_query），这里只消费回答本身。
                    answer = self._await_query_answer(server, block, i)
                    user_positive, user_loras = self._resolve_prompt_selection(server, answer)
                    # Extra Prompt has the final append: a Query block replaces the prompt-tab
                    # content, but the extra typed in Blend right now must survive it.
                    if extra_prompt:
                        user_positive = f"{user_positive}, {extra_prompt}" if user_positive else extra_prompt
                    print(f"[PipelineBlock {i+1}/{len(steps)}] Query block answered: "
                          f"positive='{user_positive[:200]}' ({len(user_positive)} chars), loras='{user_loras[:150]}'")
                    dbg.record_prompt(f'Block {i+1} · Query 块回答后', user_positive,
                                      block=i + 1, loras=debug_lora_entries(user_loras))
                    continue

                if block.get('type') == 'prompt':
                    # Prompt 块：把「全局选择 + 块引用 preset 的 selection」合并后跑 preset
                    # 的 programs（后端 quickjs 引擎），替换此后的 user_positive / user_loras。
                    # 纯临时注入 —— 只影响排在该块之后的 detailer，不写回任何状态。
                    bp = block.get('params', block)
                    preset_id = bp.get('preset_id') if isinstance(bp, dict) else None
                    if not preset_id or server._find_prompt_preset(preset_id) is None:
                        print(f"[PipelineBlock {i+1}] Prompt block has no preset selected — skipped (prompt unchanged)")
                        continue
                    try:
                        user_positive, user_loras = self._resolve_prompt_block(server, bp)
                        # Extra Prompt has the final append: a prompt block replaces the prompt-tab
                        # content, but the extra typed in Blend right now must survive it.
                        if extra_prompt:
                            user_positive = f"{user_positive}, {extra_prompt}" if user_positive else extra_prompt
                        print(f"[PipelineBlock {i+1}/{len(steps)}] Prompt block applied: "
                              f"positive='{user_positive[:200]}' ({len(user_positive)} chars), loras='{user_loras[:150]}'")
                        dbg.record_prompt(f'Block {i+1} · Prompt 块生效后', user_positive,
                                          block=i + 1, loras=debug_lora_entries(user_loras))
                    except Exception as e:
                        # fail-open：程序执行失败保留之前的 prompt，不中断整条链
                        import traceback
                        traceback.print_exc()
                        print(f"[PipelineBlock {i+1}] WARNING: prompt block failed ({e}) — keeping previous prompt")
                        dbg.record_error(f'Block {i+1} · Prompt 块失败', str(e),
                                         block=i + 1, where='prompt_block')
                    continue

                if block.get('type') == 'tagger':
                    # Tagger 块：对链中当前图（上一块的输出）跑 tagger，把 tag 追加到
                    # user_positive —— 只影响其后的 detailer（后续 prompt/query 块替换
                    # prompt 时自然被替换掉）。mode = mask（裁 mask 区域）| covered
                    # （mask 区域合成到白底）| full（整图）。
                    # mask/covered 在链中该位置没有 mask = 报错中止整条链（用户指定语义）。
                    bp = block.get('params', block)
                    tag_mode = (bp.get('mode', 'full') or 'full') if isinstance(bp, dict) else 'full'
                    if server is None or getattr(server, 'tagger', None) is None:
                        print(f"[PipelineBlock {i+1}] WARNING: Tagger block but the node has no tagger input — skipped (prompt unchanged)")
                        dbg.record_error(f'Block {i+1} · Tagger 块跳过', '节点没有 tagger 输入',
                                         block=i + 1, where='tagger_block')
                        continue
                    if tag_mode in ('mask', 'covered') and current_mask is None:
                        raise RuntimeError(
                            f"Tagger block (mode={tag_mode}) requires a mask at this point in the chain — "
                            f"paint a Mask layer first or switch the block to Full Tag")
                    tag_img = current_image
                    tag_mask = current_mask if tag_mode != 'full' else None
                    dbg.record_block(i + 1, f'Block {i+1} · Tagger', str(tag_mode), tag_mode=tag_mode)
                    dbg.record_image(f'Block {i+1} · Tagger 输入图', tag_img, block=i + 1)
                    if tag_mask is not None:
                        dbg.record_mask(f'Block {i+1} · Tagger 输入 mask', tag_mask, block=i + 1)
                    tag = self._run_tag_on_image(tag_img, tag_mask, server.tagger, tag_mode)
                    tag = (tag or '').strip()
                    if tag:
                        # 与 Blend 的 Tag 工具同一条 parsing 通道:解析后写入 prompt 阶段的
                        # parsing 来源条目(selected_prompts)与 temporary_prompts。后续 prompt/
                        # query 块的合并会带上这些 parsing tag,programs 因此能逐 tag 过滤/改写
                        # (用户要求:tagger 结果必须受后续 prompt 块的 program 影响);
                        # user_positive 仍直接追加,让 tagger 与下一个 prompt 块之间的 detailer 也拿到。
                        if server is not None:
                            try:
                                server._apply_tag_result(tag)
                            except Exception as tag_apply_err:
                                print(f"[PipelineBlock {i+1}] WARNING: applying tag result failed ({tag_apply_err})")
                        user_positive = f"{user_positive}, {tag}" if user_positive else tag
                    print(f"[PipelineBlock {i+1}/{len(steps)}] Tagger block ({tag_mode}): "
                          f"tag='{tag[:200]}' -> positive='{user_positive[:200]}'")
                    dbg.record_prompt(f'Block {i+1} · Tagger 块追加后', user_positive,
                                      block=i + 1, loras=debug_lora_entries(user_loras))
                    continue

                if block.get('type') == 'scale':
                    # Scale 块：把链上当前工作图按比例缩放（scale × W/H 后就近落 align
                    # 格，语义对齐 limit_pixels 的落格）。与 interface 块同理，结果写回
                    # pipeline + 局部变量往下传；并且刷新 resize_info / last_resize_info
                    # —— 收尾的 recover_size 只认 original_*（crop 前尺寸，= 复原落点，
                    # 不变），resized_* 换成缩放后的工作分辨率后，「Recover Crop 关」的
                    # patch 与「开」时的取整都沿新尺寸成立。
                    bp = block.get('params', block)
                    scale_val = float(bp.get('scale', 1.0) or 1.0)
                    if not (scale_val > 0):  # 0 / 负数 / NaN（手改配置）→ 兜底为不缩放
                        scale_val = 1.0
                    # Use Pipeline Align（默认开）：沿用链首那颗 DEFAULT SETTING align
                    # （limit_align 已按架构调整过：QwenImage2.1 抬到 32）。关 = 用块自己的
                    # Align，仍需过一遍同样的架构调整。
                    use_pipeline_align = bool(bp.get('use_pipeline_align', True))
                    if use_pipeline_align:
                        scale_align = limit_align
                    else:
                        scale_align = int(bp.get('align', 8) or 1)
                        if arch_qwen_image21.matches(next_pipeline.config):
                            scale_align = arch_qwen_image21.adjust_align(scale_align)
                    in_h, in_w = int(current_image.shape[1]), int(current_image.shape[2])
                    scale_bg = current_image          # 压帧要的是**缩放前**那张（Recover Scale 吃它）
                    scaled_image, scaled_mask, scale_info = limit_pixels(
                        current_image, mask=current_mask, align=scale_align, scale=scale_val)

                    next_pipeline.image = scaled_image
                    next_pipeline.mask = scaled_mask
                    current_image = scaled_image
                    current_mask = scaled_mask
                    if scale_info is not None:
                        # 帧：Scale 只改分辨率，恢复 = 缩回这张 bg 的尺寸再按 mask 合成。
                        # 没恢复也**不算漏**（软帧），链尾的 recover_size 会带回原始落点。
                        geo_open.append({'kind': 'scale', 'info': {
                            'original_width': in_w, 'original_height': in_h,
                            'resized_width': int(scale_info['resized_width']),
                            'resized_height': int(scale_info['resized_height']),
                        }, 'bg': scale_bg, 'bg_mask': None, 'block': i + 1, 'node': block['id']})
                        # resize_info.original_* = 复原落点（crop 前尺寸，Enable Mask 关
                        # 时 = 整幅），沿用链首记录，不随缩放移动；只有 resized_* 换成
                        # 新工作分辨率。scale_factor 保留 scale_info 的实测值（落格后
                        # 会与输入 scale 略有出入，如 1.5 → 0.5 格步长的实际比）。
                        resize_info = {
                            "original_width": int(cropped_image.shape[2]),
                            "original_height": int(cropped_image.shape[1]),
                            "resized_width": scale_info["resized_width"],
                            "resized_height": scale_info["resized_height"],
                            "aspect_ratio": scale_info["aspect_ratio"],
                            "scale_factor": scale_info["scale_factor"],
                            "align": scale_align,
                            "was_upscaled": scale_info["was_upscaled"],
                        }
                        last_resize_info = resize_info
                        last_resized_mask = scaled_mask
                        step_resize_info = scale_info      # 这一步的前后尺寸（原始输入尺寸 ≠ 它）
                        # 缩放后的分辨率由 scale 旋钮决定，不再是像素目标/链首对齐。
                        work_pixel_limit = None
                        work_align = scale_align if scale_align > 1 else None

                    out_h, out_w = int(scaled_image.shape[1]), int(scaled_image.shape[2])
                    print(f"[PipelineBlock {i+1}/{len(steps)}] Scale block: {in_w}x{in_h} → "
                          f"{out_w}x{out_h} (scale={scale_val}, align={scale_align}"
                          + (" pipeline)" if use_pipeline_align else " block)"))
                    dbg.record_block(i + 1, f'Block {i+1} · Scale',
                                     f"scale={scale_val} align={scale_align}",
                                     scale=scale_val,
                                     align=scale_align,
                                     use_pipeline_align=use_pipeline_align,
                                     from_size=[in_w, in_h],
                                     to_size=[out_w, out_h])
                    dbg.record_image(f'Block {i+1} · Scale 输出图', scaled_image, block=i + 1,
                                     align=(scale_align if scale_align > 1 else None))
                    if scaled_mask is not None:
                        dbg.record_mask(f'Block {i+1} · Scale 输出 mask', scaled_mask, block=i + 1,
                                        align=(scale_align if scale_align > 1 else None))
                    continue

                # ── Limit：链中按像素预算再限一次分辨率 ───────────────────────────
                # 语义与链首那次隐式 limit 完全同源（limit_pixels），区别只是位置由用户摆：
                # 想在几块之前降分辨率、后面再还回去，就 Limit + Recover Limit 成对用。
                # Pixels / Align 填 0 = 跟随 DEFAULT SETTING（与 Scale 的 Use Pipeline Align
                # 同一口径）；Cap Only 开 = pixels 是上限（只缩不涨，也就不需要恢复）。
                if block.get('type') == 'limit':
                    bp = block.get('params', block)
                    limit_block_pixels = int(bp.get('pixels', 0) or 0) or int(limit_pixels_val or 0)
                    limit_block_align = int(bp.get('align', 0) or 0) or limit_align
                    if arch_qwen_image21.matches(next_pipeline.config):
                        limit_block_align = arch_qwen_image21.adjust_align(limit_block_align)
                    limit_cap_only = bool(bp.get('cap_only', False))
                    before_w, before_h = int(current_image.shape[2]), int(current_image.shape[1])
                    limit_bg = current_image
                    l_img, l_mask, l_info = limit_pixels(
                        current_image, limit_block_pixels, current_mask,
                        limit_block_align, cap_only=limit_cap_only)
                    next_pipeline.image = l_img
                    next_pipeline.mask = l_mask
                    current_image, current_mask = l_img, l_mask
                    if l_info is not None:
                        geo_open.append({'kind': 'limit', 'info': dict(l_info), 'bg': limit_bg,
                                         'bg_mask': None, 'block': i + 1, 'node': block['id']})
                        # 与 Scale 分支同一套记账：original_* = 链首那个复原落点（不随本块
                        # 移动），resized_* = 新的工作分辨率 —— 链尾 recover_size 据此还原。
                        resize_info = {
                            "original_width": int(cropped_image.shape[2]),
                            "original_height": int(cropped_image.shape[1]),
                            "resized_width": int(l_info["resized_width"]),
                            "resized_height": int(l_info["resized_height"]),
                            "aspect_ratio": l_info["aspect_ratio"],
                            "scale_factor": l_info["scale_factor"],
                            "align": limit_block_align,
                            "was_upscaled": l_info["was_upscaled"],
                        }
                        last_resize_info = resize_info
                        last_resized_mask = l_mask
                        step_resize_info = l_info          # 这一步的前后尺寸（原始输入尺寸 ≠ 它）
                    work_pixel_limit = None if limit_cap_only else limit_block_pixels
                    work_align = limit_block_align if limit_block_align > 1 else None
                    after_w, after_h = int(l_img.shape[2]), int(l_img.shape[1])
                    print(f"[PipelineBlock {i+1}/{len(steps)}] Limit block: {before_w}x{before_h} → "
                          f"{after_w}x{after_h} (pixels={limit_block_pixels}, align={limit_block_align}"
                          + (", cap_only)" if limit_cap_only else ")"))
                    dbg.record_block(i + 1, f'Block {i+1} · Limit',
                                     f'{before_w}x{before_h} → {after_w}x{after_h}',
                                     pixels=limit_block_pixels, align=limit_block_align,
                                     cap_only=limit_cap_only,
                                     from_size=[before_w, before_h],
                                     to_size=[after_w, after_h])
                    dbg.record_image(f'Block {i+1} · Limit 输出图', l_img, block=i + 1)
                    if l_mask is not None:
                        dbg.record_mask(f'Block {i+1} · Limit 输出 mask', l_mask, block=i + 1)
                    continue

                # ── Crop：按当前 mask 的外接框把工作区裁掉一层 ─────────────────────
                # 与链首那次隐式 crop 完全同一套算法（crop_mask + reserve），区别只是它发生
                # 在链的**中间**：裁完 mask 也跟着裁，后续 detailer 按这块更小的区域采样。
                # 这一帧压进 geo_open，谁恢复谁弹 —— 没恢复就在链尾报错（见链尾那段）。
                if block.get('type') == 'crop':
                    bp = block.get('params', block)
                    use_pipe_reserve = bool(bp.get('use_pipeline_reserve', True)) if isinstance(bp, dict) else True
                    # 块自己的 reserve 缺省 0 —— 与 ImageCropMaskNode 的默认值一致（开
                    # Use Pipeline Reserve 时才换成 DEFAULT SETTING 那一份）。
                    crop_block_reserve = (int(global_params.get('crop_reserve', 32)) if use_pipe_reserve
                                          else max(0, int(bp.get('reserve', 0) or 0)))
                    if current_mask is None or float(current_mask.sum()) <= 0:
                        raise RuntimeError(
                            f"Crop block (block {i+1}) needs a mask at this point in the chain — nothing "
                            f"is painted on the Mask layer, so there is no box to crop to. Paint one, "
                            f"put a Detect block above it, or drop this Crop block.")
                    # crop_mask 只认 [B,H,W]；interface 子图可能回一张 2D 的 mask。
                    crop_input_mask = current_mask
                    if crop_input_mask.dim() == 4:
                        crop_input_mask = crop_input_mask.squeeze(1)
                    if crop_input_mask.dim() == 2:
                        crop_input_mask = crop_input_mask.unsqueeze(0)
                    before_w, before_h = int(current_image.shape[2]), int(current_image.shape[1])
                    c_img, c_mask, c_info = node_crop(current_image, crop_input_mask,
                                                      crop_block_reserve)
                    # crop_mask 帧：bg/bg_mask 是裁之前的整幅（坐标与原图同维），
                    # crop_mask 是裁完那份（与裁出的 image 同维）—— recover_crop 要的
                    # 是后者（它按 cx/cy 把 mask 贴回画布），所以恢复时的兜底 mask 用它。
                    geo_open.append({'kind': 'crop', 'info': c_info, 'bg': current_image,
                                     'bg_mask': crop_input_mask, 'crop_mask': c_mask,
                                     'block': i + 1, 'node': block['id']})
                    next_pipeline.image = c_img
                    next_pipeline.mask = c_mask
                    current_image, current_mask = c_img, c_mask
                    work_pixel_limit = None
                    work_align = None
                    after_w, after_h = int(c_img.shape[2]), int(c_img.shape[1])
                    print(f"[PipelineBlock {i+1}/{len(steps)}] Crop block: {before_w}x{before_h} → "
                          f"{after_w}x{after_h} (reserve={crop_block_reserve}"
                          + (" pipeline)" if use_pipe_reserve else " block)"))
                    dbg.record_block(i + 1, f'Block {i+1} · Crop',
                                     f'{before_w}x{before_h} → {after_w}x{after_h}',
                                     reserve=crop_block_reserve,
                                     use_pipeline_reserve=use_pipe_reserve,
                                     crop_info=({k: (list(v) if isinstance(v, tuple) else v)
                                                 for k, v in c_info.items()}
                                                if isinstance(c_info, dict) else c_info),
                                     from_size=[before_w, before_h],
                                     to_size=[after_w, after_h])
                    dbg.record_image(f'Block {i+1} · Crop 输出图', c_img, block=i + 1)
                    dbg.record_mask(f'Block {i+1} · Crop 输出 mask', c_mask, block=i + 1)
                    continue

                # ── Recover Crop：把最近一次 Crop 贴回去 ───────────────────────────
                # 背景就是 Crop 那一刻的图 —— 所以裁掉的边缘是原内容，不是色块。
                # 栈上没显式 Crop 时，它消费的是**链首那次隐式 crop**（提前恢复：后面的块
                # 就在整幅坐标系里跑，链尾也不会再贴第二遍）。
                if block.get('type') == 'recover_crop':
                    # Recover Method 与 ImageRecoverCropNode 同三档：
                    #   mask_blend（默认）羽化混合 —— 裁掉的边缘留背景，内容按 mask 覆盖度过渡
                    #   mask_only        只把 mask 覆盖到的像素贴回来（硬抠图）
                    #   bounds_only      整块硬覆盖，不需要 mask
                    rc_bp = block.get('params', block)
                    rc_method = str(rc_bp.get('recover_method') or 'mask_blend') if isinstance(rc_bp, dict) else 'mask_blend'
                    if rc_method not in ('mask_blend', 'mask_only', 'bounds_only'):
                        rc_method = 'mask_blend'
                    # 栈上还有显式帧就必须弹栈顶（且得是 Crop）；栈空才回落到链首那次隐式 crop。
                    # 上方压着 Scale / Limit（只改分辨率）时先自动收掉 —— 否则
                    # 「Crop → Scale → Recover Crop」会因为中间夹了个 Scale 就报错。
                    _close_soft_frames(geo_open)
                    frame = _take_explicit_info('crop_info') or (geo_pop_frame(geo_open, 'crop', i + 1) if geo_open else None)
                    if (rc_method != 'bounds_only'
                            and current_mask is None
                            and (frame is None or frame.get('crop_mask') is None)):
                        raise RuntimeError(
                            f"Recover Crop block (block {i+1}) uses Recover Method '{rc_method}', which "
                            f"needs a mask — the chain has none at this point. Use 'bounds_only', or put "
                            f"a Detect block above it to make one.")
                    before_w, before_h = int(current_image.shape[2]), int(current_image.shape[1])
                    if frame is not None:
                        r_img, r_mask = node_recover_crop(
                            frame['bg'], current_image, frame['info'], rc_method,
                            current_mask if current_mask is not None else frame.get('crop_mask'))
                        src = f'block {frame["block"]}'
                    elif crop_info_open is not None:
                        # 链首那两步是**隐式**的（Crop 在外、Limit 在内）。要回到整幅，就得
                        # 先把 Limit 那层缩放还掉 —— 用户看不见那一步，不该让他再放一个
                        # Recover Limit 才让 Recover Crop 生效，这里顺手关掉。
                        if last_resize_info is not None:
                            current_image, current_mask = recover_size(
                                image=current_image, resize_info=last_resize_info,
                                mask=(last_resized_mask if last_resized_mask is not None
                                      else current_mask))
                            last_resize_info = None
                            last_resized_mask = None
                            print(f"[PipelineBlock {i+1}] Recover Crop also closed the chain-start "
                                  f"Limit (working res → crop res)")
                        r_img, r_mask = node_recover_crop(
                            original_image, current_image, crop_info_open, rc_method, current_mask)
                        crop_info_open = None
                        src = 'the chain-start crop'
                    else:
                        raise RuntimeError(
                            f"Recover Crop block (block {i+1}) has nothing to restore — there is no "
                            f"Crop block above it and the chain-start crop was already recovered.")
                    next_pipeline.image = r_img
                    next_pipeline.mask = r_mask
                    current_image, current_mask = r_img, r_mask
                    work_pixel_limit = None
                    work_align = None
                    print(f"[PipelineBlock {i+1}/{len(steps)}] Recover Crop block: {before_w}x{before_h} → "
                          f"{int(r_img.shape[2])}x{int(r_img.shape[1])} (restored {src}, method={rc_method})")
                    dbg.record_block(i + 1, f'Block {i+1} · Recover Crop', f'restored {src}',
                                     recover_method=rc_method)
                    dbg.record_image(f'Block {i+1} · Recover Crop 输出图', r_img, block=i + 1)
                    if r_mask is not None:
                        dbg.record_mask(f'Block {i+1} · Recover Crop 输出 mask', r_mask, block=i + 1)
                    continue

                # ── Meet（cover）/ Recover Meet：换画幅的成对几何 ──────────────────
                # Meet = 等比放大到盖满 W×H 再居中裁；Recover Meet 把结果缩回原图坐标系的
                # 内容区、贴回 Meet 之前的整幅图（裁掉的边缘因此是原内容）。
                if block.get('type') == 'meet':
                    bp = block.get('params', block)
                    meet_w = int(bp.get('width', 0) or 0)
                    meet_h = int(bp.get('height', 0) or 0)
                    meet_interp = str(bp.get('interpolation') or 'bilinear')
                    before_w, before_h = int(current_image.shape[2]), int(current_image.shape[1])
                    m_img, m_info, m_mask = node_meet(
                        current_image, current_mask, meet_w, meet_h, meet_interp)
                    geo_open.append({'kind': 'meet', 'info': m_info, 'bg': current_image,
                                     'bg_mask': current_mask, 'block': i + 1, 'node': block['id']})
                    next_pipeline.image = m_img
                    next_pipeline.mask = m_mask
                    current_image, current_mask = m_img, m_mask
                    work_pixel_limit = None
                    work_align = None
                    after_w, after_h = int(m_img.shape[2]), int(m_img.shape[1])
                    print(f"[PipelineBlock {i+1}/{len(steps)}] Meet block: {before_w}x{before_h} → "
                          f"{after_w}x{after_h} (cover {meet_w or 'auto'}x{meet_h or 'auto'})")
                    dbg.record_block(i + 1, f'Block {i+1} · Meet',
                                     f'{before_w}x{before_h} → {after_w}x{after_h}',
                                     width=meet_w, height=meet_h, interpolation=meet_interp,
                                     meet_info=dict(m_info),
                                     from_size=[before_w, before_h],
                                     to_size=[after_w, after_h])
                    dbg.record_image(f'Block {i+1} · Meet 输出图', m_img, block=i + 1)
                    if m_mask is not None:
                        dbg.record_mask(f'Block {i+1} · Meet 输出 mask', m_mask, block=i + 1)
                    continue

                if block.get('type') == 'recover_meet':
                    _close_soft_frames(geo_open)
                    frame = _take_explicit_info('meet_info') or geo_pop_frame(geo_open, 'meet', i + 1)
                    bp = block.get('params', block)
                    rm_interp = str(bp.get('interpolation') or 'bilinear') if isinstance(bp, dict) else 'bilinear'
                    # 与 ImageRecoverMeetNode 对齐：background 是**可选输入**，不接就是有损还原
                    # （被裁掉的边缘填 padding_color）。链上那一步之前的整幅图天然就在帧里，
                    # 所以默认还是用背景 —— 关掉它才走补色那条路。
                    rm_use_bg = bool(bp.get('use_background', True)) if isinstance(bp, dict) else True
                    rm_pad = str(bp.get('padding_color') or '255, 255, 255') if isinstance(bp, dict) else '255, 255, 255'
                    before_w, before_h = int(current_image.shape[2]), int(current_image.shape[1])
                    r_img, r_mask = node_recover_meet(
                        current_image, current_mask, frame['info'], rm_interp, rm_pad,
                        frame['bg'] if rm_use_bg else None)
                    next_pipeline.image = r_img
                    next_pipeline.mask = r_mask
                    current_image, current_mask = r_img, r_mask
                    work_pixel_limit = None
                    work_align = None
                    print(f"[PipelineBlock {i+1}/{len(steps)}] Recover Meet block: {before_w}x{before_h} → "
                          f"{int(r_img.shape[2])}x{int(r_img.shape[1])} (restored block {frame['block']}, "
                          f"{'background' if rm_use_bg else 'padding ' + rm_pad})")
                    dbg.record_block(i + 1, f'Block {i+1} · Recover Meet',
                                     f'restored block {frame["block"]}', interpolation=rm_interp,
                                     use_background=rm_use_bg, padding_color=rm_pad)
                    dbg.record_image(f'Block {i+1} · Recover Meet 输出图', r_img, block=i + 1)
                    if r_mask is not None:
                        dbg.record_mask(f'Block {i+1} · Recover Meet 输出 mask', r_mask, block=i + 1)
                    continue

                # ── Fit（contain）/ Recover Fit：等比装进 W×H，居中补边 ─────────────
                if block.get('type') == 'fit':
                    bp = block.get('params', block)
                    fit_w = int(bp.get('width', 0) or 0)
                    fit_h = int(bp.get('height', 0) or 0)
                    fit_interp = str(bp.get('interpolation') or 'bilinear')
                    fit_pad = str(bp.get('padding_color') or '255, 255, 255')
                    before_w, before_h = int(current_image.shape[2]), int(current_image.shape[1])
                    f_img, f_info, f_mask = node_fit(
                        current_image, current_mask, fit_w, fit_h,
                        fit_interp, fit_pad)
                    geo_open.append({'kind': 'fit', 'info': f_info, 'bg': current_image,
                                     'bg_mask': current_mask, 'block': i + 1, 'node': block['id']})
                    next_pipeline.image = f_img
                    next_pipeline.mask = f_mask
                    current_image, current_mask = f_img, f_mask
                    work_pixel_limit = None
                    work_align = None
                    after_w, after_h = int(f_img.shape[2]), int(f_img.shape[1])
                    print(f"[PipelineBlock {i+1}/{len(steps)}] Fit block: {before_w}x{before_h} → "
                          f"{after_w}x{after_h} (contain {fit_w or 'auto'}x{fit_h or 'auto'}, pad={fit_pad})")
                    dbg.record_block(i + 1, f'Block {i+1} · Fit',
                                     f'{before_w}x{before_h} → {after_w}x{after_h}',
                                     width=fit_w, height=fit_h, interpolation=fit_interp,
                                     padding_color=fit_pad, fit_info=dict(f_info),
                                     from_size=[before_w, before_h],
                                     to_size=[after_w, after_h])
                    dbg.record_image(f'Block {i+1} · Fit 输出图', f_img, block=i + 1)
                    if f_mask is not None:
                        dbg.record_mask(f'Block {i+1} · Fit 输出 mask', f_mask, block=i + 1)
                    continue

                if block.get('type') == 'recover_fit':
                    _close_soft_frames(geo_open)
                    frame = _take_explicit_info('fit_info') or geo_pop_frame(geo_open, 'fit', i + 1)
                    bp = block.get('params', block)
                    rf_interp = str(bp.get('interpolation') or 'bilinear') if isinstance(bp, dict) else 'bilinear'
                    before_w, before_h = int(current_image.shape[2]), int(current_image.shape[1])
                    r_img, r_mask = node_recover_fit(current_image, current_mask,
                                                     frame['info'], rf_interp)
                    next_pipeline.image = r_img
                    next_pipeline.mask = r_mask
                    current_image, current_mask = r_img, r_mask
                    work_pixel_limit = None
                    work_align = None
                    print(f"[PipelineBlock {i+1}/{len(steps)}] Recover Fit block: {before_w}x{before_h} → "
                          f"{int(r_img.shape[2])}x{int(r_img.shape[1])} (restored block {frame['block']})")
                    dbg.record_block(i + 1, f'Block {i+1} · Recover Fit',
                                     f'restored block {frame["block"]}', interpolation=rf_interp)
                    dbg.record_image(f'Block {i+1} · Recover Fit 输出图', r_img, block=i + 1)
                    if r_mask is not None:
                        dbg.record_mask(f'Block {i+1} · Recover Fit 输出 mask', r_mask, block=i + 1)
                    continue

                # ── Recover Scale / Recover Limit：把一次改分辨率还原回去 ──────────
                # 两种块共用一套帧（Scale/Limit 各压一帧、带那一步之前的图），所以还原是
                # **完美**的：重绘过的地方用当前像素，其余用背景原像素（不吃二次重采样）。
                #
                # Recover Limit 有两条路：
                #   ① 栈顶是 Limit 帧 → 弹它（链中的 Limit 块）；
                #   ② 栈里没有 Limit 帧 → 回落成老口径：还掉链首那次隐式 Limit
                #      （Scale 块会改写 last_resize_info，所以吃的永远是当前生效的那一份）。
                if block.get('type') in ('recover_scale', 'recover_limit'):
                    kind = 'scale' if block.get('type') == 'recover_scale' else 'limit'
                    bp = block.get('params', block)
                    r_interp = str(bp.get('interpolation') or 'bilinear') if isinstance(bp, dict) else 'bilinear'
                    before_w, before_h = int(current_image.shape[2]), int(current_image.shape[1])
                    frame = _take_explicit_info('scale_info' if kind == 'scale' else 'limit_info')
                    # 顶上若是另一种软帧（Scale ↔ Limit）先收掉：两者都只改分辨率，
                    # 跨着收没有歧义，不该为了顺序问题逼用户再补一颗块。
                    _close_soft_frames(geo_open, keep=kind)
                    if frame is None and geo_open and geo_open[-1].get('kind') == kind:
                        frame = geo_open.pop()
                    if frame is None and kind == 'limit' and last_resize_info is not None:
                        # 老口径：栈上没有 Limit 帧时，还掉链首那次隐式 Limit（顶上是
                        # Crop/Meet/Fit 也照旧这么办 —— 这颗块本来就是"还缩放"的兜底）。
                        r_img, r_mask = recover_size(
                            image=current_image, resize_info=last_resize_info,
                            mask=(last_resized_mask if last_resized_mask is not None else current_mask))
                        last_resize_info = None
                        last_resized_mask = None
                        step_resize_info = None
                        src = 'the chain-start Limit'
                    elif frame is not None:
                        r_img, r_mask = recover_scale_image(
                            current_image, current_mask, frame['info'],
                            background=frame.get('bg'), interpolation=r_interp)
                        src = f"block {frame['block']}"
                        # 已回到那一步之前的尺寸：记账跟着回到那一档（original_* 不动）。
                        if last_resize_info is not None:
                            last_resize_info = {
                                **last_resize_info,
                                'resized_width': int(r_img.shape[2]),
                                'resized_height': int(r_img.shape[1]),
                            }
                        last_resized_mask = r_mask
                        # 这一步已经还掉了，后面再遇 detailer 不该再往它身上复原。
                        step_resize_info = None
                    elif geo_open:
                        # 顶上是 Crop/Meet/Fit（硬帧）：直接交给统一文案报"先收哪一个"
                        # （这一句必然抛，geo_pop_frame 不会静默返回）。
                        geo_pop_frame(geo_open, kind, i + 1)
                        raise RuntimeError('unreachable')
                    else:
                        raise RuntimeError(
                            f"{GEO_RECOVER_LABEL[kind]} block (block {i+1}) has nothing to restore — "
                            f"there is no {_geo_kind_label(kind)} step above it and the chain-start "
                            f"Limit is already recovered or never applied.")
                    next_pipeline.image = r_img
                    next_pipeline.mask = r_mask
                    current_image, current_mask = r_img, r_mask
                    work_pixel_limit = None
                    work_align = None
                    print(f"[PipelineBlock {i+1}/{len(steps)}] {GEO_RECOVER_LABEL[kind]} block: "
                          f"{before_w}x{before_h} → {int(r_img.shape[2])}x{int(r_img.shape[1])} "
                          f"(restored {src})")
                    dbg.record_block(i + 1, f'Block {i+1} · {GEO_RECOVER_LABEL[kind]}',
                                     f'restored {src}', interpolation=r_interp)
                    dbg.record_image(f'Block {i+1} · {GEO_RECOVER_LABEL[kind]} 输出图', r_img, block=i + 1)
                    if r_mask is not None:
                        dbg.record_mask(f'Block {i+1} · {GEO_RECOVER_LABEL[kind]} 输出 mask', r_mask,
                                        block=i + 1)
                    continue

                # ── Detect：run 到这里现跑一次 detector，结果当作 pipeline 的 mask ──
                # 表达式语法与 Detector 小窗完全同一套（parse/collect/eval），空表达式 = 整图
                # 检测一次。产出是 [1,H,W] 的「白=覆盖」，尺寸对不上当前工作图就插值对齐
                # （detector 内部会缩到自己的分辨率，这一步不能省）。
                if block.get('type') == 'detect':
                    bp = block.get('params', block)
                    if server is None or getattr(server, 'detector', None) is None:
                        raise RuntimeError(
                            f"Detect block (block {i+1}) needs a detector — connect one to the node's "
                            f"detector input, or remove this block.")
                    from ...libs.detect_utils import detect_mask as _detect_mask
                    from ...libs.mask_utils import combine_masks as _combine_masks
                    from ...libs.mask_expression import (
                        parse_mask_expression as _parse_expr,
                        collect_terms as _collect_terms,
                        eval_expression as _eval_expr,
                    )
                    det_prompt = str(bp.get('prompt') or '').strip()
                    try:
                        det_threshold = float(bp.get('threshold', 0.5))
                    except (TypeError, ValueError):
                        det_threshold = 0.5
                    det_threshold = min(1.0, max(0.0, det_threshold))
                    det_invert = bool(bp.get('invert'))
                    dbg.record_block(i + 1, f'Block {i+1} · Detect',
                                     det_prompt or '(whole image)',
                                     prompt=det_prompt, threshold=det_threshold,
                                     invert=det_invert)
                    dbg.record_image(f'Block {i+1} · Detect 输入图', current_image, block=i + 1)

                    # 检测器一次只吃一张图（Grounding / SAM3 都不是按批写的），所以 batch 在
                    # 这里**就地拆帧跑** —— 但只拆这一个块，不算整链重入：模型/CLIP/VAE 的
                    # 上下文切换仍然只在块间发生一次，而不是每帧一遍。
                    def _detect_one(det_img):
                        if det_prompt:
                            _root = _parse_expr(det_prompt, det_threshold)
                            _term_masks = {}
                            for _name, _t in _collect_terms(_root):
                                _hits = _detect_mask(detector=server.detector, image=det_img,
                                                     threshold=float(_t), prompt=_name)
                                _combined = _combine_masks(_hits, mode='max')
                                _term_masks[(_name, float(_t))] = _combined
                                dbg.record_mask(f"Block {i+1} · 术语 '{_name}' @ {_t}", _combined,
                                                block=i + 1, detail=f'{len(_hits)} 个实例')
                            _m = _eval_expr(_root, _term_masks)
                        else:
                            _m = _combine_masks(
                                _detect_mask(detector=server.detector, image=det_img,
                                             threshold=det_threshold, prompt=''),
                                mode='max')
                        if det_invert:
                            _m = 1.0 - _m
                        # 对齐到当前工作图的网格：detector 自己那一档分辨率与链上的不同。
                        if _m.dim() == 2:
                            _m = _m.unsqueeze(0)
                        if _m.dim() == 4:
                            _m = _m.squeeze(1)
                        if (int(_m.shape[1]) != int(current_image.shape[1])
                                or int(_m.shape[2]) != int(current_image.shape[2])):
                            _m = torch.nn.functional.interpolate(
                                _m.unsqueeze(1).float(),
                                size=(int(current_image.shape[1]), int(current_image.shape[2])),
                                mode='bilinear', align_corners=False,
                            ).squeeze(1)
                        return _m.float().clamp_(0.0, 1.0)

                    _B = int(current_image.shape[0]) if current_image.dim() == 4 else 1
                    if _B > 1:
                        print(f"[PipelineBlock {i+1}/{len(steps)}] Detect block: running per-frame "
                              f"on a batch of {_B} (the detector takes one image at a time)")
                    det_mask = torch.cat(
                        [_detect_one(current_image[_k]) for _k in range(_B)], dim=0) if _B > 1 else _detect_one(
                        current_image[0] if current_image.dim() == 4 else current_image)
                    next_pipeline.mask = det_mask
                    current_mask = det_mask
                    # 运行时分支依据：命中 = 检测出了非空 mask。图引擎据此放行 exec_yes /
                    # exec_no 两条分支（旧线性链不看它）。
                    det_hit = bool(det_mask is not None and float(det_mask.sum()) > 0.0)
                    print(f"[PipelineBlock {i+1}/{len(steps)}] Detect block: "
                          f"{det_prompt or '(whole image)'} → mask {tuple(det_mask.shape)} "
                          f"(sum={float(det_mask.sum()):.0f})")
                    dbg.record_mask(f'Block {i+1} · Detect 结果（新 pipeline mask）', det_mask,
                                    block=i + 1,
                                    detail=f'sum={float(det_mask.sum()):.0f}')
                    continue

                # Detailer block params (support both nested 'params' dict and flat)
                bp = block.get('params', block)
                add_noise = bp.get('add_noise', 'enable')
                start_step_rate = float(bp.get('start_step_rate', 0.8))
                end_step_rate = float(bp.get('end_step_rate', 1.0))
                enable_edit = bp.get('enable_edit', False)
                # 块级 Generate Text 开关（默认关）：只有 pipeline config 的
                # enable_generate_text 也开着时才真正生效（二级门控）。
                enable_text_generate = bool(bp.get('enable_text_generate', False))
                # Override Prompt（默认关）：开着时本块 Generate Text 的指令用块里的
                # override_prompt 原样替代 pipeline 的 generate_text_prompt
                # （留空 = 空指令，positive 原样进 CLIP）。只在 enable_text_generate
                # 生效时有意义。
                enable_override_prompt = bool(bp.get('enable_override_prompt', False))
                override_prompt = str(bp.get('override_prompt', '') or '')
                edit_mode = bp.get('edit_mode', 'fit')  # Krea2 source-patch 模式: fit | crop
                ref_boost = float(bp.get('ref_boost', 4.0))
                ref_boost_a = float(bp.get('ref_boost_a', 1.0))
                enable_ref_boost_mask = bp.get('enable_ref_boost_mask', False)
                grounding_px = int(bp.get('grounding_px', 768))
                # Context Ref 没有开关：Ref 图不再逐块手选 —— Blend 工作台 Extra
                # Prompt 文本里的 <image_id:...> 标记在 run 入口统一解析（见
                # parse_prompt_image_refs），所有 detailer block 共用同一组引用图
                # （context 工作图 = <image 1>，引用图 = <image 2>+）。旧配置里的
                # per-block context_reference_keys / context_reference_key 已废弃。
                context_reference_keys = list(prompt_ref_ids or [])
                # 每个 detailer block 自带 context_regex（默认 ".+"），覆盖全局值，
                # 用于决定该 block 解出 pipeline.context 中的哪些 lora/prompt。
                block_context_regex = bp.get('context_regex', context_regex) or '.+'

                # seed 链条：全局 seed 只是第一格，之后每格由前一格哈希出来（见 next_seed）。
                # 共用同一个 seed 意味着每个块拿到**同一个**噪声张量，链子就成了自我重复。
                block_seed = seed
                seed = next_seed(seed)

                print(f"[PipelineBlock {i+1}/{len(steps)}] Detailer: noise={add_noise}, seed={block_seed}, steps={start_step_rate}-{end_step_rate}, edit={enable_edit}, textgen={enable_text_generate}, edit_mode={edit_mode}, ref_boost={ref_boost}/{ref_boost_a}, mask_boost={enable_ref_boost_mask}, grounding_px={grounding_px}, last={is_last}")
                dbg.record_block(i + 1, f'Block {i+1} · Detailer',
                                 f'{block.get("name", "")}',
                                 add_noise=add_noise,
                                 seed=block_seed,
                                 start_step_rate=start_step_rate,
                                 end_step_rate=end_step_rate,
                                 enable_edit=enable_edit,
                                 enable_text_generate=enable_text_generate,
                                 enable_override_prompt=enable_override_prompt,
                                 override_prompt_used=(override_prompt if (enable_text_generate and enable_override_prompt) else None),
                                 edit_mode=edit_mode,
                                 ref_boost=ref_boost,
                                 ref_boost_a=ref_boost_a,
                                 enable_ref_boost_mask=enable_ref_boost_mask,
                                 grounding_px=grounding_px,
                                 context_regex=block_context_regex,
                                 is_last=is_last)
                # 全局工作分辨率已在 crop 后一次性 limit 确定（见上方）。此处把当前 block
                # 的实际输入（可能已被上游 interface 块替换）同步为处理图，不再重复 limit。
                resized_image, resized_mask = current_image, current_mask
                # 记录必须在同步之后：紧接着就是 VAEEncode(pixels=resized_image)，
                # 同步前手里拿的还是上一块的工作图（interface 之后两者尺寸不同）。
                dbg.record_image(f'Block {i+1} · 输入工作图', resized_image, block=i + 1,
                                 pixel_limit=work_pixel_limit, align=work_align)
                dbg.record_mask(f'Block {i+1} · 输入工作 mask', resized_mask, block=i + 1,
                                pixel_limit=work_pixel_limit, align=work_align)

                # VAEEncode
                tmp_latent = VAEEncode().encode(
                    vae=next_pipeline.vae,
                    pixels=resized_image
                )[0]
                # 逐帧种子：视频 batch 里每一帧要有**各自的噪声**（同一份噪声会让整段长得
                # 一模一样）。走 latent['noise_seeds'] —— _ksampler 会为每一帧单独起一个
                # generator，与逐帧跑时 next_seed 的节奏逐位等价。
                # 注意别写成 latent['batch_index']：那是 comfy prepare_noise 的**紧凑索引**
                # （内部按 range(unique_inds[-1]+1) 逐个抽），塞裸种子会炸（uint64 → float64）。
                if frame_seeds:
                    _B = int(tmp_latent['samples'].shape[0])
                    if _B > 1 and len(frame_seeds) >= _B:
                        tmp_latent['noise_seeds'] = [int(s) for s in frame_seeds[:_B]]
                        print(f"[PipelineBlock {i+1}] Detailer: per-frame noise seeds for {_B} "
                              f"frames (first={tmp_latent['noise_seeds'][0]})")

                sampler_name = next_pipeline.sampler_name or 'euler'
                scheduler = next_pipeline.scheduler or 'normal'
                # 变量名不能叫 steps —— 外层 for 的 **`steps` 是执行计划列表**（见上方
                # exec_plan / 线性链），在这里被赋值成 int 会让下一轮循环头的
                # `len(steps)` 抛 `int has no len()`（只要链里 detailer 后面还有块就必炸）。
                sample_steps = next_pipeline.steps or 20
                cfg = next_pipeline.cfg or 8.0

                start_at_step = int(start_step_rate * sample_steps)
                end_at_step = int(end_step_rate * sample_steps)

                # Condition — 每个 detailer block 实时从当前 pipeline.context 解出
                # lora/prompt（不提前解析），以捕获上游 interface 块对 pipeline 的修改。
                context_positive, context_negative, context_loras = next_pipeline.context.get_context(block_context_regex)
                current_positive = ','.join([p for p in [context_positive, user_positive] if p])
                # Enable Output 的 `prompt` 键在此刻定格：user_positive 已是本块最终形态
                # （prompt / Query 块与 extra prompt 都已处理，每块覆写一次 → 留下最后一个
                # detailer 的输入），在这里剥掉打头的 lora 触发词串 —— pipeline context 的
                # prompt（context_positive 与后面 get_prompt_context 的补全）和 Generate
                # Text 的改写都只属于这一趟采样，不进读回用的用户选择。落盘键形见
                # _save_run_output_png。
                if server is not None:
                    _clean_positive = user_positive
                    _trigger_str = getattr(self, '_last_trigger_str', '') or ''
                    if _trigger_str and _clean_positive.startswith(_trigger_str):
                        _clean_positive = _clean_positive[len(_trigger_str):]
                        if _clean_positive.startswith(','):
                            _clean_positive = _clean_positive[1:]
                        _clean_positive = _clean_positive.strip()
                    server.last_output_positive = _clean_positive
                dbg.record_prompt(f'Block {i+1} · a) context 解出（regex={block_context_regex}）',
                                  context_positive, block=i + 1,
                                  loras=list(context_loras or []))
                dbg.record_prompt(f'Block {i+1} · b) context + user_positive 拼接', current_positive,
                                  block=i + 1,
                                  user_positive=user_positive)
                # Generate Text（MARKER_GENERATE_TEXT_BLOCK）：上游 Pipeline 若启用了
                # PipelineEnableGenerateTextNode，且本块 params 的 enable_text_generate
                # 开着（默认关），就把指令 prompt 与当前 positive 拼起来交给文本生成
                # CLIP，用生成结果完全替换 current_positive。参数与 clip 都来自上游
                # 节点。产物只作用于当前块（current_positive 每块都从 context 重新解出，
                # 不跨块传递）。pipeline 没开 enable_generate_text 时块开关无效。
                if next_pipeline.config.get('enable_generate_text') and enable_text_generate:
                    # Override Prompt 生效时用块级指令替代 pipeline 的 generate_text_prompt
                    # （空字符串就是空指令：positive 原样进 CLIP，不套指令拼接）。
                    _gt_instruction = (override_prompt if enable_override_prompt
                                       else next_pipeline.config.get('generate_text_prompt', ''))
                    _gt_before = current_positive
                    # Enable Edit 开 → 送图（多模态 CLIP 看图改写）：
                    #   第一张 = next_pipeline.image（链上传递的那张，pipeline 就是靠它
                    #            在 block 间传图的；interface 块会写回，detailer 不改它）
                    #   随后 = 本块选的所有 Ref Image（v2 多参考，按列表顺序能传几张传几张）
                    # Edit 关 → 完全不传图（不做隐藏行为）。
                    _gt_images = []
                    _gt_sources = []
                    _gt_ref_keys = []
                    _gt_img_status = 'n/a（未送图）'
                    if enable_edit:
                        # 链上没像素时下面那句 `is not None` 本来就打算跳过送图（只带 refs），
                        # 所以这里要 None，别让 get_image 抢先把整块打断。
                        _chain_img = next_pipeline.get_image(required=False)
                        if _chain_img is not None:
                            _gt_images.append(_chain_img)
                            _gt_sources.append('pipeline.image（链上工作图）')
                        for _ref_key in context_reference_keys:
                            _ref_img = self._resolve_ref_image_for_generate_text(server, _ref_key)
                            if _ref_img is not None:
                                _gt_images.append(_ref_img)
                                _gt_sources.append(f'Ref Image（{_ref_key}）')
                                _gt_ref_keys.append(_ref_key)
                        # 输入侧封顶：这些图即将进多模态塔，先各自压到 tgen_pixels 上限
                        # （cap_only = 只缩不涨，align 向下落格）。压不压、压到多大只由
                        # (H,W) 决定，所以 normalize_ref_images 的"形状不一致就丢弃"分组
                        # 不会因为封顶而新丢图。
                        for _i, _gt in enumerate(_gt_images):
                            _gt_capped, _, _ = limit_pixels(_gt, tgen_cap_pixels,
                                                            align=tgen_cap_align, cap_only=True)
                            _gt_images[_i] = _gt_capped
                        # 明确告诉 Debug：这些图**会不会真的影响**生成。
                        # 先按名字/模板做静态判断，再**实测一次 tokenize**（数 image
                        # embedding）—— 后者才是「图真的进了 token 流」的唯一证据。
                        if _gt_images:
                            _gt_clip = (next_pipeline.config.get('generate_text_clip')
                                        or next_pipeline.clip)
                            _gt_params = next_pipeline.config.get('generate_text') or {}
                            _gt_img_status = '未知'
                            try:
                                from ...libs.generate_text_utils import describe_image_support
                                _ok, _why = describe_image_support(
                                    _gt_clip,
                                    bool(_gt_params.get('use_default_template', True)))
                                _gt_img_status = ('会生效 — ' if _ok else '★ 不会生效 — ') + _why
                            except Exception as _e:
                                _gt_img_status = f'unknown ({_e})'
                            try:
                                _p_ok, _p_why = self._preflight_generate_text_images(
                                    _gt_images, _gt_clip,
                                    {**_gt_params,
                                     '_instruction': _gt_instruction})
                                if _p_why:
                                    _gt_img_status = _p_why
                                elif _p_ok is not None:
                                    _gt_img_status = ('已确认生效 — ' if _p_ok
                                                      else '★ 不会生效 — ') + _gt_img_status
                            except Exception as _e:
                                print(f'[GenerateText] preflight probe failed ({_e})')
                            print(f'[GenerateText] [block {i + 1}] image status: {_gt_img_status}')
                    dbg.record_prompt(f'Block {i+1} · c) Generate Text 输入（指令 + positive）',
                                      current_positive, block=i + 1,
                                      instruction=_gt_instruction,
                                      override_prompt=enable_override_prompt,
                                      params=next_pipeline.config.get('generate_text'),
                                      image_count=len(_gt_images),
                                      ref_image_keys=_gt_ref_keys,
                                      image_status=_gt_img_status)
                    # Debug：把每一张真正送进 Generate Text 的图单独画出来，标注来源
                    for _gi, _gimg in enumerate(_gt_images):
                        _gsrc = _gt_sources[_gi] if _gi < len(_gt_sources) else f'第 {_gi + 1} 张'
                        dbg.record_image(f'Block {i+1} · c{_gi + 1}) Generate Text 输入图 — {_gsrc}',
                                         _gimg, block=i + 1,
                                         pixel_limit=(tgen_cap_pixels or None),
                                         align=(tgen_cap_align if tgen_cap_align > 1 else None),
                                         detail=f'第 {_gi + 1} 张 / 共 {len(_gt_images)} 张')
                    try:
                        current_positive, _gt_used = apply_generate_text_to_prompt(
                            next_pipeline, current_positive,
                            _gt_instruction,
                            label=f' [block {i + 1}]',
                            images=_gt_images or None)
                        if _gt_used:
                            print(f'[PipelineBlock {i + 1}/{len(blocks)}] Generate Text applied: '
                                  f"positive='{current_positive[:200]}' ({len(current_positive)} chars)")
                        dbg.record_prompt(f'Block {i+1} · d) Generate Text 输出（new_positive）',
                                          current_positive, block=i + 1,
                                          applied=bool(_gt_used),
                                          images_sent=len(_gt_images),
                                          before=_gt_before)
                    except Exception as e:
                        # fail-open：生成失败保留原 prompt，不中断整条链
                        import traceback
                        traceback.print_exc()
                        print(f'[PipelineBlock {i + 1}] WARNING: Generate Text failed ({e}) — keeping previous prompt')
                        dbg.record_error(f'Block {i+1} · Generate Text 失败', str(e),
                                         block=i + 1, where='generate_text')
                # Cancel 检查点：Generate Text 的 LLM 调用是同步长任务，块首的检查点
                # 够不着它内部——这里在生成结束/conditioning 之前再吃一次 interrupt，
                # 让「在 text generate 里点 Cancel」的请求在当前块内就生效。
                mm.throw_exception_if_processing_interrupted()
                current_positive_before_query = current_positive
                current_negative = context_negative
                current_loras = context_loras.copy()
                current_loras.extend(get_loras_from_string(user_loras))
                # Model-only 补标（持久配置为准）：context 里的串是 prompt 节点上次图执行
                # 时冻结的，之后才打开的 model_only 在这里补上，同一趟立即生效。
                _ps = server.prompt_server if server is not None else None
                _mo_paths = self._model_only_paths(_ps)
                if _mo_paths:
                    _patched = self._mark_model_only(current_loras, _mo_paths)
                    if _patched != current_loras:
                        print(f"[PipelineBlock] model-only flags patched at run time: "
                              f"{[x for x in _patched if ':model_only>' in str(x)]}")
                    current_loras = _patched

                tmp_positive, tmp_negative, tmp_loras = next_pipeline.context.get_prompt_context('', resized_image)
                if tmp_positive:
                    current_positive += ',' + tmp_positive
                if tmp_negative:
                    current_negative += ',' + tmp_negative
                if tmp_loras:
                    current_loras.extend(tmp_loras)

                dbg.record_prompt(f'Block {i+1} · e) 最终 positive（送入 conditioning）',
                                  current_positive, block=i + 1,
                                  negative=current_negative,
                                  loras=list(current_loras),
                                  query_positive=tmp_positive or '',
                                  query_negative=tmp_negative or '',
                                  before_query=current_positive_before_query)
                # Enable Output 的 `prompt` 键不再用这一整串（context 补全与触发词都混在
                # 里面）。last_clip_positive 保留作调试对照；落盘编码的是用户自己的选择
                # （server.last_output_positive，块循环在 context 拼接处捕获）。
                if server is not None:
                    server.last_clip_positive = current_positive

                model_negative = next_pipeline.config.get("model_negative")
                model_to_use, clip_to_use, model_negative_to_use = next_pipeline.cache.get_model_clip(
                    model=next_pipeline.model,
                    clip=next_pipeline.clip,
                    loras=current_loras,
                    model_negative=model_negative
                )
                # 跨 run 文本编码 memo 的键部件：lora clone 每次 run 都是新对象，
                # 只有集合值跨 run 稳定（键 = base clip 身份 + loras 集合 + prompt）。
                next_pipeline._cache_loras = frozenset(current_loras)

                # Restore reference_latents to original before per-block injection
                next_pipeline.reference.reference_latents = list(_orig_ref_latents)

                # Enable Edit 补丁已在循环前统一应用到 pipeline model（含
                # model_negative），get_model_clip 返回的 clone 自动携带补丁闭包；
                # 此处仅记录本 block 的开关状态供 debug / UI 使用。
                next_pipeline.config["enable_edit"] = enable_edit
                # block 级 grounding_px: Krea2 grounded encode 的 VLM 看图分辨率
                # 上限（正/负条件共用 — 同一 get_conditioning 路径）
                next_pipeline.config["grounding_px"] = grounding_px
                # block 级 edit 参数: forward 从 pixel_state 动态读取，支持逐
                # block 切换 —— edit_mode（fit/crop 几何）与 ref_boost 三参数
                # （注意力增强; enable_ref_boost_mask 启用时以 context mask
                # [当前块裁剪区 mask, 与源图同网格] 限定增强区域）
                if _edit_pixel_state is not None:
                    _edit_pixel_state["fit_mode"] = edit_mode
                    _edit_pixel_state["ref_boost"] = ref_boost
                    _edit_pixel_state["ref_boost_a"] = ref_boost_a
                    _edit_pixel_state["ref_boost_mask"] = (
                        resized_mask if (enable_edit and enable_ref_boost_mask) else None
                    )

                # Context Reference injection (per-block) — Ref 图来自 Extra Prompt 文本
                # 解析出的全局 refs（prompt_ref_ids，首次出现顺序 = 注入顺序）。
                # _injected_refs 把**编码前**的像素留给付费的槽位清单：那是 get_conditioning
                # 解码回来的同一张图，省一次 VAEDecode。
                # 计时就是 conditioning 那一步自己的耗时（阶段点里量的），
                # 不再从 ref 注入开始算 —— 那个数在 staging 下会把等待时间也算进去。
                _cc_h0 = self._cond_store.stats['hits']
                _cc_m0 = self._cond_store.stats['misses']
                _injected_refs = []
                if enable_edit and context_reference_keys and server is not None:
                    for _ref_key in context_reference_keys:
                        ref_img = server.get_staging_image(_ref_key)
                        if ref_img is not None:
                            # 输入侧封顶：ref 马上要进 VAE 编码，像素数直接决定显存 ——
                            # 编码前压到 ref_pixels 上限（cap_only = 只缩不涨，align 向下
                            # 落格）。_injected_refs 记的也就是这张压过的图，Debug 槽位
                            # 清单与真正进 get_conditioning 的像素保持一致。
                            # 压+编码走跨 run memo（键含 staging id 与 vae 身份）——
                            # 图没换就不重复编码；命中时返回同一份 latent 对象，
                            # 下游的 decode/槽位编码缓存随之命中。
                            _vae_now = next_pipeline.vae

                            def _cap_encode(_img=ref_img, _vae=_vae_now):
                                _capped, _, _ = limit_pixels(_img, ref_cap_pixels,
                                                             align=ref_cap_align, cap_only=True)
                                return _capped, VAEEncode().encode(vae=_vae, pixels=_capped)[0]

                            ref_img, ref_latent = next_pipeline.memoized(
                                ('ctxref', _ref_key, ref_cap_pixels, ref_cap_align, id(_vae_now)),
                                (ref_img, _vae_now), _cap_encode)
                            next_pipeline.reference.reference_latents.append(ref_latent)
                            _injected_refs.append((_ref_key, ref_img))
                            print(f"[Block {i+1}] Context reference injected: id={_ref_key}")
                        else:
                            print(f"[Block {i+1}] WARNING: context reference id '{_ref_key}' not found in staging")
                            dbg.record_error(
                                f'Block {i+1} · Ref Image 缺失', f"staging id '{_ref_key}' 不存在",
                                block=i + 1, where='context_reference')

                print(f"[Block {i+1}] reference.reference_latents count: {len(next_pipeline.reference.reference_latents)}")

                # Reference args by architecture — 普遍规则：Enable Edit 关 = 不送图。
                # Krea2: source patch + grounded encode (语义+像素双路径)，两路都归 enable_edit 管。
                # Flux2Klein: 原生 ref_latents — 当前块 latent 作为 reference（同样只跟 enable_edit）。
                # 其余架构（QwenImage21 等）: edit 关时 reference_image=None，
                #   第一格 pin 随之失效（architecture/QwenImage21.py:92），工作图彻底不进轨迹。
                architecture = next_pipeline.config.get("architecture") if next_pipeline.config else None
                is_krea2 = bool(architecture and re.search(r"Krea2", architecture, re.IGNORECASE))
                is_flux2klein = bool(architecture and re.search(r"Flux2Klein", architecture, re.IGNORECASE))

                ref_latent_arg = tmp_latent if (is_flux2klein and enable_edit) else None
                ref_image_arg = resized_image if enable_edit and not is_flux2klein else None
                # [EditGate] 门闸读数：这行**不出现**=进程跑的还是旧代码（没重载）；
                # 出现且 ref_image=sent=该块 Enable Edit 开着，图按设计进 conditioning。
                print(f"[Block {i+1}] EditGate: enable_edit={enable_edit} arch={architecture} "
                      f"ref_image={'sent' if ref_image_arg is not None else 'NOT sent'} "
                      f"ref_latent={'sent' if ref_latent_arg is not None else 'none'} "
                      f"pipeline_ref_latents={len(next_pipeline.reference.reference_latents)}")

                # 参考图槽位清单（含 <image 1>）—— 必须在 args 定下来之后、真正 conditioning
                # 之前记，记的才是 get_conditioning 马上要收到的东西。
                self._debug_reference_slots(i + 1, ref_image_arg, ref_latent_arg,
                                            _injected_refs, next_pipeline,
                                            work_limit=work_pixel_limit,
                                            ref_limit=(ref_cap_pixels or None),
                                            work_align=work_align,
                                            ref_align=(ref_cap_align if ref_cap_align > 1 else None))

                # ── 阶段点：conditioning（CLIP text encode）────────────────────────
                # 这一段不在这里直接算，而是 yield 出去交给驱动方：
                #   单条链 → `_serve_stage` 立刻算（图像模式行为不变）；
                #   一串帧 → `_run_pipeline_frames` 把**整组帧的**请求攒齐后连着算完，
                #            再一起放行去采样（CLIP 只进一次上下文，采样也只进一次）。
                # 两个 mode 打包在同一个请求里：positive 与 negative 必须背靠背编码，
                # 中间插进别的东西只会让 CLIP 再被清出去一次。
                def _encode_pair():
                    _pos = next_pipeline.get_conditioning(
                        mode='positive',
                        clip=clip_to_use,
                        vae=next_pipeline.vae,
                        prompt=current_positive,
                        reference_latent=ref_latent_arg,
                        reference_image=ref_image_arg,
                        reference=next_pipeline.reference,
                        # ref_image_arg 就是 resized_image，本块的 target latent 也由它编码而来
                        # —— 把这份 latent 交下去，QwenImage21 的第一格就不再重推尺寸（见其模块头）
                        source_latent=tmp_latent["samples"]
                    )
                    _neg = next_pipeline.get_conditioning(
                        mode='negative',
                        clip=clip_to_use,
                        vae=next_pipeline.vae,
                        prompt=current_negative,
                        reference_latent=ref_latent_arg,
                        reference_image=ref_image_arg,
                        reference=next_pipeline.reference,
                        source_latent=tmp_latent["samples"]
                    )
                    return _pos, _neg

                _cond_req = {
                    'kind': 'cond',
                    'block': i + 1,
                    'prompt': current_positive,
                    'negative': current_negative,
                    # 跨帧复用的判据：把 get_conditioning 真正读到的输入逐项钉死。
                    # 键相等 ⇒ 两次调用在语义上不可区分 ⇒ 结果必然相同，可以共享。
                    'key': self._cond_cache_key(
                        next_pipeline, clip_to_use, current_positive, current_negative,
                        ref_latent_arg, ref_image_arg, tmp_latent),
                    'compute': _encode_pair,
                }
                positive_condition, negative_condition = yield _cond_req

                _st = self._cond_store.stats
                print(f"[CondCache] block {i+1}: conditioning "
                      f"{float(_cond_req.get('elapsed') or 0):.2f}s | "
                      f"hits={_st['hits'] - _cc_h0} misses={_st['misses'] - _cc_m0} | "
                      f"store {self._cond_store.report()}")

                # 节点级 pixel_state 注入（对齐 krea2edit source patch 数据流）：
                # source 由 snapshot 节点直接写入 patch 闭包，不经 conditioning 管道。
                # - edit on: source_latents = 当前块 latent（identity edit: source==target
                #   初始网格）；并在采样外预编码像素源（对齐参考 target_latent 用途，
                #   避免 mid-sampling VAE 加载驱逐扩散模型）
                # - edit off: 清空残留（覆盖 get_conditioning side-channel 写入），走原生 forward
                if _edit_pixel_state is not None:
                    if enable_edit and is_krea2:
                        _edit_pixel_state["source_latents"] = [tmp_latent["samples"]]
                        _edit_pixel_state["px_cache"] = {}
                        if _edit_pixel_state.get("source_images"):
                            Hh, Ww = tmp_latent["samples"].shape[-2], tmp_latent["samples"].shape[-1]
                            arch_krea2.pre_encode_sources(_edit_pixel_state, Hh, Ww)
                    else:
                        _edit_pixel_state["source_images"] = None
                        _edit_pixel_state["source_latents"] = None
                        _edit_pixel_state["px_cache"] = {}

                from ..pipeline.sampler_node import _ksampler
                # Invert：噪声这一路彻底交给反演（_ksampler 把爬梯段和重绘段拼成一张
                # 非单调梯子，一趟跑完），随机噪声不再叠加，所以 disable_noise 也一并成立。
                invert_info = {} if add_noise == 'invert' else None
                try:
                    _pc = positive_condition[0][1] if positive_condition else {}
                    _nc = negative_condition[0][1] if negative_condition else {}
                    _slots = _pc.get('image_slots')
                    if _slots is not None and hasattr(_slots, 'tolist'):
                        _slots = _slots.tolist()
                    _patches = getattr(model_to_use, 'patches', None)
                    _patch_desc = {}
                    if isinstance(_patches, dict):
                        for _k in _patches:
                            _arch = _k[0] if isinstance(_k, tuple) and _k else str(_k)
                            _patch_desc[_arch] = _patch_desc.get(_arch, 0) + len(_patches[_k])
                    _mo = getattr(model_to_use, 'model_options', None) or {}
                    _ptext = str(positive_condition[0][0]) if positive_condition else ''
                    _ntext = str(negative_condition[0][0]) if negative_condition else ''
                    dbg.record_stage('OffsetProbe 采样入口', block=i + 1,
                                     latent_shape=list(tmp_latent['samples'].shape),
                                     has_noise_mask=('noise_mask' in tmp_latent),
                                     steps=sample_steps, start_step=start_at_step, end_step=end_at_step,
                                     cfg=cfg, sampler=sampler_name, scheduler=scheduler,
                                     seed=block_seed,
                                     has_model_negative=model_negative_to_use is not None,
                                     sigmas_override=bool(next_pipeline.config.get('sigmas')),
                                     pos_cond_keys=sorted(_pc.keys()),
                                     neg_cond_keys=sorted(_nc.keys()),
                                     image_slots=_slots,
                                     model_patch_counts=_patch_desc,
                                     model_options_keys=sorted(_mo.keys()))
                    dbg.record_prompt('OffsetProbe positive 全文', _ptext, block=i + 1)
                    dbg.record_prompt('OffsetProbe negative 全文', _ntext, block=i + 1)
                except Exception as _probe_err:
                    dbg.record_error('OffsetProbe 失败', _probe_err, block=i + 1, where='detailer _ksampler 前')
                sampled_latent = _ksampler(
                    model=model_to_use,
                    seed=block_seed,
                    steps=sample_steps,
                    cfg=cfg,
                    sampler_name=sampler_name,
                    scheduler=scheduler,
                    positive=positive_condition,
                    negative=negative_condition,
                    latent=tmp_latent,
                    disable_noise=(add_noise != "enable"),
                    start_step=start_at_step,
                    last_step=end_at_step,
                    force_full_denoise=True,
                    sigmas=next_pipeline.config.get("sigmas"),
                    model_negative=model_negative_to_use,
                    invert=(add_noise == 'invert'),
                    invert_info=invert_info,
                )[0]

                if invert_info is not None:
                    peak = invert_info.get('peak')
                    if peak is not None:
                        # 噪声 latent 进 pipeline cache：它是"这张图配的那份噪声"，
                        # 下游块/节点想跳过自己那趟爬梯就直接取，不必再反演一次。
                        inverted = dict(tmp_latent)
                        inverted['samples'] = peak
                        next_pipeline.cache.set_inverted_latent(i + 1, inverted)
                    if invert_info.get('noop'):
                        detail = '未执行（start_step 越界，本块梯子是空的）'
                    else:
                        detail = (f"爬 {invert_info.get('climb_rungs', 0)} 级 / 共 "
                                  f"{invert_info.get('steps_total', 0)} 步（euler）· "
                                  f"σ_peak={invert_info.get('sigma_peak', 0.0):.4f}")
                    print(f"[Block {i+1}] Invert: {detail}")
                    dbg.record_stage('Invert 往返', detail, block=i + 1,
                                     steps_total=invert_info.get('steps_total'),
                                     sigma_peak=invert_info.get('sigma_peak'),
                                     sampler='euler',
                                     peak_captured=(peak is not None),
                                     noop=bool(invert_info.get('noop')))

                # ── 阶段点：decode 屏障 ─────────────────────────────────────────
                # 视频段里这一步让**所有帧先采样完**再一起解码：采样与解码各占一次
                # 模型上下文（SDXL ↔ VAE 来回驱逐是逐帧串行里最贵的一笔）。
                yield {'kind': 'decode', 'block': i + 1}

                decoded_image = VAEDecode().decode(vae=next_pipeline.vae, samples=sampled_latent)[0]

                # Recover to pre-resize (cropped) resolution so next block starts at cropped size
                # 落点是**最近那次 Scale/Limit 之前**的尺寸（step_resize_info），不是
                # resize_info.original_* —— 后者是链首复原落点（= 原始输入尺寸）；链首之后
                # 又摆了显式 Scale/Limit 时两者不是一档，用错会多绕一次降采样。
                #
                # 但后面若有一颗 Recover 要还掉**当前这层**软帧（Limit → Detailer →
                # Recover Limit 这种"夹心"接法），这里就不能先缩回去：那颗 Recover 本来就
                # 按 frame 里的「前 → 后」尺寸一次还原（还会用那一步之前的原像素补 mask
                # 之外的区域）。先缩一次、它再缩一次 = 白白多一趟重采样，mask 还要先被
                # 重采样到它自己的网格（真踩过：image 已是 1179x760 而 mask 还是 1272x824）。
                _soft_closer = None if is_last else soft_frame_will_close(geo_open, steps, i)
                if _soft_closer is not None:
                    current_image = decoded_image
                    current_mask = resized_mask
                    print(f"[Block {i+1}] keeping the working resolution "
                          f"{int(decoded_image.shape[2])}x{int(decoded_image.shape[1])} — "
                          f"{GEO_RECOVER_LABEL.get(geo_open[-1].get('kind'), 'Recover')} at block "
                          f"{i + 1 + _soft_closer} restores it in one pass")
                elif not is_last:
                    _mid_info = step_resize_info if step_resize_info is not None else resize_info
                    if _mid_info is not None:
                        recovered_decoded, recovered_mask = recover_size(
                            image=decoded_image,
                            resize_info=_mid_info,
                            mask=resized_mask
                        )
                        current_image = recovered_decoded
                        # mask 要用"本块输入 mask 按同一档缩放还原回来"的那一份 —— 它才是
                        # 链上当前生效的 mask（可能被上游 Detect / Crop 重造过）在这一分辨率
                        # 下的对应物。旧的 `= cropped_mask` 是链首隐式 crop 的那份：在「mask
                        # 由链内 Detect 现造」时它是 None，会把链内 mask 直接抹掉，随后的
                        # Recover Limit 跟着丢 None，Recover Crop 兜底到整幅 mask → 尺寸不符崩溃。
                        current_mask = recovered_mask if recovered_mask is not None else cropped_mask
                    else:
                        # Enable Limit 关：从没缩放过，工作区尺寸恒定，无需复原。
                        current_image = decoded_image
                        current_mask = resized_mask
                else:
                    current_image = decoded_image
                    current_mask = resized_mask

                last_resize_info = resize_info
                last_resized_mask = resized_mask

                print(f"[Block {i+1}] Done: decoded shape={decoded_image.shape}")
                # _ksampler 返回的是 LATENT dict（{'samples': tensor}），不是 tensor ——
                # 这里统一取形状，避免直接 .shape 炸掉（曾栽过一次）。
                def _latent_shape(lat):
                    try:
                        if isinstance(lat, dict):
                            lat = lat.get('samples')
                        return list(lat.shape) if hasattr(lat, 'shape') else None
                    except Exception:
                        return None
                dbg.record_image(f'Block {i+1} · 采样解码输出', decoded_image, block=i + 1,
                                 detail=f'latent={_latent_shape(sampled_latent)}')
                dbg.record_stage(f'Block {i+1} · 输出 / 传递给下一块',
                                 f'current_image={tuple(current_image.shape)}',
                                 block=i + 1,
                                 is_last=is_last,
                                 decoded_shape=list(decoded_image.shape),
                                 latent_shape=_latent_shape(sampled_latent),
                                 has_resize_info=resize_info is not None)
                if not is_last:
                    _label = ('保持工作分辨率（下游 Recover 一次还原）' if _soft_closer is not None
                              else '复原到裁剪分辨率（传给下一块）')
                    dbg.record_image(f'Block {i+1} · {_label}', current_image, block=i + 1)

            # 图模式的产出 = **流进 End.image 的那一份**，不是"最后执行过哪颗节点的工作图"。
            # 汇聚节点（switch）的产物只挂在端口值表里、不经过 current_image —— 不从这里
            # 取就永远拿不到（switch 后面的链会白跑）。
            if graph_mode and isinstance(_pg, dict):
                for _e in _pg.get('edges') or []:
                    if str(_e.get('target')) != END_ID:
                        continue
                    _tport = str(_e.get('targetPort') or '')
                    if _tport not in ('image', 'mask'):
                        continue
                    _v = _values.get((str(_e.get('source')), str(_e.get('sourcePort'))))
                    if _v is None or not hasattr(_v, 'dim'):
                        continue
                    if _tport == 'image' and _v.dim() == 4:
                        if _v is not current_image:
                            print(f'[PipelineBlock] chain product follows End.image from '
                                  f'{_e.get("source")}:{_e.get("sourcePort")} → {tuple(_v.shape)}')
                        current_image = _v
                        next_pipeline.image = _v
                    elif _tport == 'mask' and _v.dim() in (2, 3):
                        if _v is not current_mask:
                            print(f'[PipelineBlock] chain mask follows End.mask from '
                                  f'{_e.get("source")}:{_e.get("sourcePort")} → {tuple(_v.shape)}')
                        current_mask = _v
                        next_pipeline.mask = _v
        finally:
            # Restore pipeline state
            if next_pipeline.config is not None:
                next_pipeline.config["enable_edit"] = _orig_enable_edit
                if _orig_grounding_px is not None:
                    next_pipeline.config["grounding_px"] = _orig_grounding_px
                else:
                    # 原值缺失时删除 key，避免 None 覆盖 get_conditioning 的默认值回退
                    next_pipeline.config.pop("grounding_px", None)
                if _edit_patched:
                    next_pipeline.config["model_negative"] = _orig_model_negative
            if next_pipeline.reference is not None:
                next_pipeline.reference.reference_latents = _orig_ref_latents
            if _edit_patched:
                # 返回的 pipeline 会成为 _current_pipeline，必须还原为未打补丁的
                # model，避免补丁闭包（含 source_images/px_cache）跨运行滞留
                next_pipeline.model = _orig_model

        # 收尾：整条链（含 interface block）都在 crop 工作区坐标系里跑，这里把它落地。
        # Recover Crop 开 → recover_size（分辨率复原）+ recover_crop（按 crop_info 合成
        # 回全图），即原行为。
        # Recover Crop 关 → 两个都不做：patch 保持工作分辨率，工作区 mask 合进它的 alpha，
        # 连同裁剪矩形一起交给前端，由 Blend 画布作为新图层用 transform 贴回原位 ——
        # transform 的缩放本身就承担了 recover_size 的职责，所以可以一起省掉。
        detail_meta = None
        # 还开着的显式几何帧 = 用户漏了 Recover 块（判据与措辞见 geo_leftover_error）。
        _leftover = geo_leftover_error(geo_open)
        if _leftover is not None:
            raise _leftover
        # 只剩软帧（Scale / Limit）就丢掉：链尾这两步本来就会把分辨率带回原始落点，
        # 它们只是"还能不能完美还原"的凭据，不收也不会让产出落错位置。
        if geo_open:
            print('[Detailer] chain ends with un-recovered '
                  + ', '.join(f"{_geo_kind_label(f.get('kind'))}(block {f.get('block')})"
                              for f in geo_open)
                  + ' — the end-of-chain recover_size handles the resolution, dropping those frames')
        if not enable_mask:
            # Enable Mask 关：整幅工作区即产出，没有裁剪矩形可复原。但 align 落格
            # （Qwen2.1 + Limit 关）仍动过尺寸 —— resize_info 非 None 时必须按它把
            # 工作分辨率还原回裁剪/整幅尺寸，产出尺寸才和输入一致。
            if last_resize_info is not None:
                recovered_image, recovered_mask = recover_size(
                    image=current_image,
                    resize_info=last_resize_info,
                    mask=last_resized_mask
                )
                final_image, final_mask = recovered_image, recovered_mask
            else:
                final_image, final_mask = current_image, current_mask
        elif do_recover_crop:
            if last_resize_info is not None:
                recovered_image, recovered_mask = recover_size(
                    image=current_image,
                    resize_info=last_resize_info,
                    mask=last_resized_mask
                )
            else:
                recovered_image, recovered_mask = current_image, current_mask

            if crop_info_open is not None:
                final_image, final_mask = recover_crop(
                    background=original_image,
                    image=recovered_image,
                    crop_info=crop_info_open,
                    recover_method='mask_blend',
                    mask=recovered_mask
                )
            else:
                # 链中已经有 Recover Crop 块把（隐式那次）crop 贴回去了：此刻工作图就在
                # 整幅坐标系里，链尾再贴一遍等于贴错位置 —— 直接用当前结果。
                final_image, final_mask = recovered_image, recovered_mask
                print('[Detailer] chain-start crop was already restored by a Recover Crop block '
                      '— skipping the end-of-chain paste')
        else:
            # 工作区 mask 合进产出图的 alpha：这张 RGBA 就是「要贴回原位的新图层」本身。
            # 前端不再需要额外的 mask 字段 —— 图层自带的 alpha 就承担了裁剪，
            # 贴回去的观感与 recover_crop(mask_blend) 一致，而这次得到的是一个
            # 普通图层，可以继续改 transform / 继续画。
            work_mask = last_resized_mask if last_resized_mask is not None else current_mask
            if crop_info_open is not None:
                # place 用 merge 之前的 current_image 量 patch 尺寸 —— merge 不动空间尺寸，
                # 但这样就不依赖 merge 的返回形状。
                place = detail_place_rect(crop_info_open, current_image)
                final_image = merge_mask_alpha(current_image, work_mask)
                detail_meta = {'place': place}
                print(f"[Detailer] Recover Crop off — returning the RGBA crop-workspace patch "
                      f"{tuple(final_image.shape)} covering the crop rect "
                      f"({place['x']},{place['y']}) {place['w']}x{place['h']} of {place['ow']}x{place['oh']} "
                      f"(patch scale sx={place['sx']:.4f} sy={place['sy']:.4f})")
            else:
                # 同上：crop 已被 Recover Crop 块提前贴回，产出就是整幅结果，没有 place 可给。
                final_image = merge_mask_alpha(current_image, work_mask)

        detailed_image = final_image
        dbg.record_stage('收尾 / 恢复',
                         ('Enable Mask 关 → 整幅就是产出' if not enable_mask
                          else ('Recover Crop 开 → recover_size + recover_crop' if do_recover_crop
                                else 'Recover Crop 关 → 保持工作分辨率，产出为 RGBA patch')),
                         block=0,
                         enable_mask=enable_mask,
                         do_recover_crop=do_recover_crop,
                         crop_still_open=bool(crop_info_open is not None),
                         geometry_frames_closed=bool(not any(
                             f.get('kind') not in GEO_SOFT_KINDS for f in geo_open)),
                         soft_frames_dropped=[f.get('block') for f in geo_open
                                              if f.get('kind') in GEO_SOFT_KINDS])
        dbg.record_image('链条最终产出（recover 之后）', final_image, block=0)

        # Context 就是 Blend 画布合成图，detailer 产出不再接管；关掉 Recover Crop 时产出
        # 只是画布上的一块 patch，更不能顶替整幅 context，故保持原合成图。
        next_pipeline.image = final_image if (enable_mask and do_recover_crop) else original_image
        next_pipeline.latent = None
        next_pipeline.mask = user_mask

        gc.collect()
        mm.soft_empty_cache()

        return next_pipeline, original_image, detailed_image, detail_meta

    # -------------------------------------------------------------------------
    # 按 node_id 现加载一条 pipeline —— /api/switch_pipeline（Pipeline Settings 选）与
    # run_detailer（preset 绑定）共用这一份。执行上游节点取 PIPELINE_DATA 是这里唯一昂贵
    # 的一步（模型/VAE/CLIP 全在那条链上重建），所以 run 循环只在「这次要的 pipeline 和已
    # 加载的不是同一条」时才调它。
    # -------------------------------------------------------------------------
    def _load_pipeline_from_node(self, server, upstream_node_id, pipeline_name=''):
        """→ (ok, error). 成功时把 node 的 current/base pipeline 换成它，并记住身份。"""
        if not upstream_node_id:
            return False, 'Pipeline has no source node id'
        from .interface_node import InterfaceExecutor
        epi = getattr(server, 'extra_pnginfo', None)
        if isinstance(epi, list):
            epi = epi[0] if epi else {}
        # Provide current pipeline as fallback for unresolved PIPELINE_DATA inputs
        current_pipeline = self._current_pipeline
        executor = InterfaceExecutor(
            extra_pnginfo=epi,
            get_pipeline=lambda: current_pipeline,
        )
        output_values = {}
        try:
            executor._try_execute_external(upstream_node_id, output_values)
        except Exception as ex:
            return False, f'Failed to execute upstream node {upstream_node_id}: {ex}'
        if upstream_node_id not in output_values or not output_values[upstream_node_id]:
            return False, (f'Failed to execute upstream node {upstream_node_id}: '
                           f'execution returned no output')
        new_pipeline = output_values[upstream_node_id][0]
        if new_pipeline is None:
            return False, 'Upstream node returned None pipeline'

        # Inherit image/latent/mask from the current pipeline if the new one lacks them
        if new_pipeline.image is None and current_pipeline is not None and current_pipeline.image is not None:
            new_pipeline.image = current_pipeline.image
        if new_pipeline.latent is None and current_pipeline is not None and current_pipeline.latent is not None:
            new_pipeline.latent = current_pipeline.latent
        if new_pipeline.mask is None and current_pipeline is not None and current_pipeline.mask is not None:
            new_pipeline.mask = current_pipeline.mask
        self._current_pipeline = new_pipeline.copy()
        self._base_pipeline = self._current_pipeline
        # 换到一条既无 image 又无 latent 的管线是合法状态（工作台那侧自己去要上次那一份 .cud），
        # 所以这里要 None 就够，别让它抛 —— 以前这句把整条切换打成页面上的一行红字，run 循环走
        # 同一个 loader 时更是直接打断整趟。有 latent 仍然解码（下面 required=False 不管这一路）。
        new_image = new_pipeline.get_image(required=False) if hasattr(new_pipeline, 'get_image') else None
        self._switch_image(server, new_image)
        # Update lora_regex from the new pipeline's architecture
        new_arch = new_pipeline.config.get("architecture") if new_pipeline.config else None
        old_arch = current_pipeline.config.get("architecture") if current_pipeline and current_pipeline.config else None
        print(f"[PipelineSwitch] old_arch={old_arch}, new_arch={new_arch}, config_keys={list(new_pipeline.config.keys()) if new_pipeline.config else 'None'}")
        if new_arch:
            new_arch = str(new_arch)
            # 一条谓词管住 lora 侧的全部动作：架构没变（例如 preset 每趟都点名同一条）既不重扫
            # 磁盘（update_lora_regex → refresh_loras 会顺带 propagate 给进程里每一个 prompt 实例），
            # 也不惊动 Prompt tab。server 与它的 prompt server 都在构造时就带着同一枚 regex，所以
            # 这里比出的"相等"不存在两边不一致的可能。
            if new_arch != server.lora_regex:
                server.lora_regex = new_arch
                server.pipeline_lora_epoch += 1
                if server.prompt_server:
                    server.prompt_server.update_lora_regex(new_arch)
        elif old_arch:
            # If new pipeline didn't set architecture, keep old regex
            print(f"[PipelineSwitch] WARNING: new pipeline has no architecture in config, keeping old lora_regex={server.lora_regex}")
        # 身份记账：run 循环靠它判断「这次要不要重新加载」。
        server.loaded_pipeline_node_id = upstream_node_id
        server.loaded_pipeline_name = pipeline_name or ''
        print(f"[PipelineSwitch] Switched to pipeline '{pipeline_name}' (node {upstream_node_id}), "
              f"lora_regex='{new_arch or server.lora_regex}', epoch={server.pipeline_lora_epoch}")
        return True, None

    # -------------------------------------------------------------------------
    # 切换图片时更新 mask server：尺寸相同则保留 mask，否则清除
    # -------------------------------------------------------------------------
    def _switch_image(self, server, new_image):
        """切换 pipeline 的图片并更新 mask server。尺寸相同则保留 mask。"""
        old_image = self._current_pipeline.image
        old_h, old_w = (old_image.shape[1], old_image.shape[2]) if old_image is not None and hasattr(old_image, 'shape') and old_image.dim() >= 3 else (0, 0)
        new_h, new_w = (new_image.shape[1], new_image.shape[2]) if new_image is not None and hasattr(new_image, 'shape') and new_image.dim() >= 3 else (0, 0)

        self._current_pipeline.image = new_image


        # 关键：切换 context 时同步 _base_pipeline 的 image/mask。
        # run_detailer 每次基于 _base_pipeline.copy() 执行（见 sample()），若不在此同步，
        # 注入的仍是初始化时的原始 image，导致用户切换 context 后 run 仍用旧图。
        if self._base_pipeline is not None:
            self._base_pipeline.image = new_image
            self._base_pipeline.mask = self._current_pipeline.mask

    # -------------------------------------------------------------------------
    # Interface Package 执行
    # -------------------------------------------------------------------------
    def _sync_pipeline_updates(self, target, source):
        """将 source pipeline（interface 子图返回的、被修改过的 pipeline）中
        实际输出/修改的字段合并回 target pipeline（chain 中的上游 pipeline）。

        只覆盖 source 中非 None 的字段，且跳过 image/mask（image/mask 由
        interface 的结果图单独写回），其余字段（model/clip/vae/context/
        reference/config/sampler_name/scheduler/steps/cfg 等）均按 interface
        的修改生效，使后续 detailer block 拿到被 interface 修改后的 model 等。
        """
        if target is None or source is None:
            return
        sync_fields = (
            'model', 'clip', 'vae',
            'sampler_name', 'scheduler', 'steps', 'cfg',
            'context', 'reference', 'config',
        )
        for f in sync_fields:
            val = getattr(source, f, None)
            if val is not None and getattr(target, f, None) is not val:
                setattr(target, f, val)
        # loras 以 list 形式存在于 context 中，已在 context 同步时覆盖；
        # 若 PipelineData 另有显式 loras 字段也一并同步
        if hasattr(source, 'loras') and getattr(source, 'loras', None) is not None:
            setattr(target, 'loras', getattr(source, 'loras'))

    def _run_preset_video(self, server, action, seed=0):
        """视频模式跑一条 Pipeline Preset：抽一列帧 → **每帧一条 pipeline** 走同一条链
        → 编码回 mp4。

        与 run_detailer 的差别只有"输入是一列帧而不是一张图"：preset 解析、pipeline 绑定、
        Preprocess 开关、prompt/lora 注入全部走同一份 `_run_pipeline_blocks`，所以同一套
        preset 在视频里跑出来的单帧结果与图像模式完全一致。

        **执行器之间传的是 `List[PipelineData]`**（见 `frames_from_batch`）：每帧自带自己的
        image / mask / latent / 几何帧栈，所以裁剪框、工作分辨率、检测结论都是逐帧的。
        model / clip / vae / 条件仓库 / cache 按引用共享，逐帧跑不重建模型；放弃的只是
        合批采样那份吞吐（逐帧 ksampler，见 `_skapler` 的 batch 日志）。

        mask 来自宿主传来的 `mask_input`（视频模式 Mask 轨的画面，亮度 = 覆盖）；没有就
        不送 mask（整幅都是工作区）。产物不落图层/图池 —— 这一段视频回给宿主按段落位。
        """
        preset_id = action.get('preset_id') or None
        extra_prompt = (action.get('extra_prompt') or '').strip()
        vi = action.get('video_inputs') or {}
        # 宿主按 {port: spec} 发（与 processor 同形）；单口场景也接受裸 spec。
        spec = vi.get('0') if isinstance(vi, dict) and isinstance(vi.get('0'), dict) else vi
        if not isinstance(spec, dict) or not spec.get('file'):
            raise ValueError('No video input for the preset run')

        fname = os.path.basename(str(spec.get('file') or ''))
        vpath = _vid_media_path(spec.get('file')) or os.path.join(_vid_media_dir(), fname)
        frames = _vid_frames(vpath, ss=spec.get('ss', 0), t=spec.get('t'),
                             n=spec.get('n'), fps=spec.get('fps'), f0=spec.get('f0'))
        if not frames:
            raise ValueError(f'No frames extracted from {fname} — is the file still in the asset library?')
        try:
            enc_fps = float(spec.get('fps') or 30)
        except (TypeError, ValueError):
            enc_fps = 30.0
        server.preset_video_total = len(frames)
        server.preset_video_current = 0
        server.preset_video_progress = 0.0
        print(f"[PresetVideo] {fname} → {len(frames)} frames @ {enc_fps:.1f}fps, preset={preset_id or '(active tab)'}")

        # Mask 轨：同一段窗口抽同样条数，取亮度当覆盖（白 = 覆盖）。抽不满/没给 = 该帧无 mask。
        mask_frames = None
        m_in = action.get('mask_input')
        if isinstance(m_in, dict) and m_in.get('file'):
            mname = os.path.basename(str(m_in.get('file') or ''))
            mpath = _vid_media_path(m_in.get('file')) or os.path.join(_vid_media_dir(), mname)
            mask_frames = _vid_frames(mpath, ss=m_in.get('ss', 0), t=m_in.get('t'),
                                      n=m_in.get('n') or len(frames), fps=m_in.get('fps') or enc_fps,
                                      f0=m_in.get('f0'))
            if not mask_frames:
                print(f"[PresetVideo] mask track gave no frames ({mname}) — running without a mask")
            else:
                print(f"[PresetVideo] mask track {mname} → {len(mask_frames)} frames")

        # preset 的选链规则与 run_detailer 完全一致（同一份优先级）：给了 id 且这一套还在就用它，
        # 否则用当前激活 tab 的链。pipeline 绑定也跟着这一套走 —— 不能出现"按 A 套选链、
        # 却按 B 套的 pipeline 跑"。
        preset_set = next(
            (s for s in (server.blocks_sets or [])
             if s.get('id') == preset_id and s.get('blocks')),
            None,
        ) if preset_id else None
        blocks = preset_set['blocks'] if preset_set is not None else server.blocks
        run_set_id = preset_set['id'] if preset_set is not None else server.active_block_set
        run_graph = graph_from_config(preset_set) if preset_set is not None else getattr(server, 'graph', None)
        if preset_set is not None:
            print(f"[PresetVideo] using pipeline preset '{preset_set.get('name')}' ({len(preset_set['blocks'])} blocks)")

        wanted_pipeline = server.preset_pipeline_name(run_set_id)
        if wanted_pipeline and wanted_pipeline != PIPELINE_CURRENT_SELECT:
            target = server.find_pipeline_by_name(wanted_pipeline)
            if target is None:
                raise ValueError(f"Pipeline '{wanted_pipeline}' is missing — it no longer exists "
                                 f"in the connected package; rebind it in Pipeline Settings")
            if server.loaded_pipeline_node_id != target['node_id']:
                ok, err = self._load_pipeline_from_node(server, target['node_id'], wanted_pipeline)
                if not ok:
                    raise ValueError(err)

        if self._base_pipeline is None:
            raise ValueError('Pipeline not initialized — pick a pipeline in Pipeline Settings first')

        user_positive, user_loras = self._parse_prompt(server.prompt_server)
        if extra_prompt:
            user_positive = f"{user_positive}, {extra_prompt}" if user_positive else extra_prompt

        # 产出帧的 fps 与抽取 fps 相同 —— 段长在时间线上因此对得上（n / fps 秒）。
        #
        # ── 每帧一条 pipeline，逐帧过链 ──────────────────────────────────────────
        # 执行器之间传的是 `List[PipelineData]`（见 `frames_from_batch`）：每帧自带
        # 自己的 image / mask / latent / 几何帧栈，于是裁剪框、工作分辨率、检测结论
        # 都是逐帧的 —— 6 帧里只有 3 帧检出人物时，没检出的那 3 帧原样穿过。
        # 共享的是 model / clip / vae / 条件仓库（`PipelineData.copy()` 按引用继承），
        # 所以逐帧跑并不会重建模型，省掉的是合批采样那部分吞吐。
        if mm.processing_interrupted():
            raise mm.InterruptProcessingException()
        n_frames = len(frames)
        masks = None
        if mask_frames:
            # mask 轨：每帧各自对齐到自己的帧网格，然后逐帧下发。不再叠成 [N,H,W] ——
            # 两张视频的像素尺寸不一定相同，叠之前得先 pad，那是 batch 时代的账。
            masks = []
            for i in range(n_frames):
                mf = mask_frames[i] if i < len(mask_frames) else mask_frames[-1]
                m = mf[0] if mf.dim() == 4 else mf
                if m.shape[-1] != 1:
                    m = m.mean(dim=-1, keepdim=True)
                fh, fw = int(frames[i].shape[-3]), int(frames[i].shape[-2])
                if int(m.shape[0]) != fh or int(m.shape[1]) != fw:
                    m = torch.nn.functional.interpolate(
                        m.permute(2, 0, 1).unsqueeze(0),
                        size=(fh, fw),
                        mode='bilinear', align_corners=False,
                    ).squeeze(0).permute(1, 2, 0)
                masks.append(m.squeeze(-1))

        # 逐帧种子：整段共用一份噪声会让每一帧长得一模一样，所以按 next_seed 的节奏
        # 排出 N 个种子，帧 i 从 seeds[i] 起（块内仍按 next_seed 往下发）。
        frame_seeds = []
        _s = seed
        for _ in range(n_frames):
            frame_seeds.append(_s)
            _s = next_seed(_s)

        pipes = self.frames_from_batch(frames, None, base_pipeline=self._base_pipeline)
        print(f"[PresetVideo] {n_frames} frames → {len(pipes)} pipelines "
              f"(shared model/clip/vae, per-frame geometry & detect)")

        run_architecture = (pipes[0].config.get('architecture')
                            if pipes and pipes[0].config else None)
        global_params = {
            'seed': seed,
            **{k: getattr(server, k) for k in server.GLOBAL_PARAM_DEFAULTS},
            'context_regex': '.+',
        }
        arch_overrides, _rule = server.arch_overrides(run_architecture)
        if arch_overrides:
            global_params.update(arch_overrides)

        # 进度按帧报（`_run_pipeline_frames` 每跑完一帧写一次），不再是"0 然后 1"。
        server.preset_video_total = n_frames
        server.preset_video_current = 0
        server.preset_video_progress = 0.0
        _next, _orig, detailed, detail_meta = self._run_pipeline_blocks(
            pipes, masks, user_positive, user_loras, global_params, blocks,
            server=server, extra_prompt=extra_prompt, graph=run_graph,
            frame_seeds=frame_seeds,
        )
        if detailed is None:
            raise ValueError(f'The chain produced no image for this segment ({n_frames} frames)')
        batch_out = detailed if detailed.dim() == 4 else detailed.unsqueeze(0)
        if batch_out.shape[0] != n_frames:
            # 链吐出的条数与喂进去的对不上（有帧没产出）—— 按帧数截断/告警，
            # 宁可少给也别把错位的结果编进视频。
            print(f"[PresetVideo] WARNING: the chain returned {batch_out.shape[0]} images for "
                  f"{n_frames} frames — truncating to {min(batch_out.shape[0], n_frames)}")
        out_frames = [batch_out[k] for k in range(min(batch_out.shape[0], n_frames))]
        server.preset_video_current = n_frames
        server.preset_video_progress = 1.0
        if detail_meta:
            print(f"[PresetVideo] Recover Crop is off — the chain returned a patch "
                  f"({tuple(batch_out.shape)}), the video is that patch")

        url = _vid_encode(out_frames, fps=enc_fps,
                          name=f'preset_{preset_set.get("name") if preset_set else "run"}')
        if not url:
            raise ValueError('Encoding the result to mp4 failed — check the ComfyUI console')
        server.preset_video_meta = [{
            'port': 0,
            'type': 'IMAGE',
            'name': (preset_set.get('name') if preset_set is not None else 'Preset'),
            'video': url,
            'frames': len(out_frames),
        }]
        print(f"[PresetVideo] done: {len(out_frames)} frames → {url}")

    def _execute_interface(self, server, interface_idx, manual_values, exec_options=None,
                            input_image=None, input_mask=None, return_image=False,
                            base_pipeline=None):
        """Execute a sub-graph via InterfaceExecutor.

        Args:
            return_image: 若 True，执行结果只作为返回值 (result_img, result_mask)，
                          不写入 history、不切换 context（用于 chain 内 interface 块，
                          结果作为 pipeline 流转的中间图）。
            input_image / input_mask: 显式指定的输入图/mask（chain 内由上一 block 提供）。
                                      未指定时回退到 base_pipeline 的 image/mask。
            base_pipeline: 执行所基于的 pipeline（chain 内为上一 block 输出的 pipeline，
                          携带 model/clip/context/image/mask）。未指定时回退到
                          self._current_pipeline（独立 interface tab 执行场景）。
                          注意：chain 模式下不在此提前解析 prompt tab 的 lora/prompt，
                          上下文完全由 pipeline 原样传递，由后续 detailer block 解析。
        """
        if interface_idx >= len(server.interface_packages):
            raise ValueError(f"Interface index {interface_idx} out of range ({len(server.interface_packages)} interface packages)")

        exec_options = exec_options or {}
        operation = exec_options.get('operation', 'default')
        image_keys = exec_options.get('image_keys', {})  # {port_num_str: history_key}
        crop_reserve = int(exec_options.get('crop_reserve', 32))

        pkg = server.interface_packages[interface_idx]
        from .interface_node import InterfaceExecutor

        # pipeline 来源：优先使用 chain 传入的 base_pipeline（上一 block 输出的 pipeline，
        # 携带正确的 model/clip/context/image/mask）；否则回退独立 tab 的 _current_pipeline。
        chain_mode = base_pipeline is not None
        base_src = base_pipeline if chain_mode else self._current_pipeline
        injected_pipeline = base_src.copy() if base_src else None

        # Debug：独立执行（Interface tab Execute / 离线 Processor）开一份自己的 trace ——
        # 与 run_detailer 的 trace 同一模型，Debug 窗口原样能读。chain 内的 interface 块
        # 不在这里开：那份 trace 归整条 run，另开会把 run 已收集的过程整份丢掉。
        own_trace = False
        if not chain_mode:
            dbg.begin_trace({
                'from_blend': False,
                'action': 'execute_interface',
                'interface': pkg.get('name', ''),
                'interface_index': interface_idx,
                'offline': bool(exec_options.get('offline')),
            })
            own_trace = dbg.current_trace() is not None

        # 仅在非 chain 模式（独立 interface tab）提前把 prompt tab 的 lora/prompt 注入到
        # pipeline 上下文；chain 模式完全通过 pipeline 传递，不在此解析 prompt/lora。
        if not chain_mode:
            user_positive, user_loras = self._parse_prompt(server.prompt_server)
            # Generate Text（MARKER_GENERATE_TEXT_INTERFACE）：独立 interface tab 时，
            # 上游 pipeline 若启用了 PipelineEnableGenerateTextNode，同样在 prompt
            # 注入点替换 positive（与 Draw tab block 链的语义保持一致）。
            # 离线 Processor 不走这里：那是 block 链的环节（一次真实 LLM 调用 +
            # 文本编码器整卡加载），Processor 只跑 interface 子图本身。
            if (injected_pipeline and injected_pipeline.config.get('enable_generate_text')
                    and not exec_options.get('offline')):
                try:
                    # interface 块没有 Enable Edit / Ref Image 概念 → 始终纯文本
                    # （image 省略即 None），与 block 链里未选 Ref Image 时一致。
                    user_positive, _gt_used = apply_generate_text_to_prompt(
                        injected_pipeline, user_positive,
                        injected_pipeline.config.get('generate_text_prompt', ''),
                        label=' [interface]')
                    if _gt_used:
                        print(f"[interface] Generate Text applied: positive='{user_positive[:200]}'")
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    print(f'[interface] WARNING: Generate Text failed ({e}) — keeping previous prompt')
            if injected_pipeline and (user_positive or user_loras):
                from ..pipeline.sampler_node import SamplerContext
                entry = SamplerContext()
                entry.positive = user_positive
                entry.negative = ''
                entry.loras = get_loras_from_string(user_loras) if user_loras else []
                # Model-only 补标（同块循环）：注入的串也要按持久配置补齐。
                _mo = self._mark_model_only(entry.loras, self._model_only_paths(server.prompt_server if server else None))
                if _mo != entry.loras:
                    print(f"[interface] model-only flags patched at run time: {[x for x in _mo if ':model_only>' in str(x)]}")
                entry.loras = _mo
                injected_pipeline.context.contexts['__prompt_tab__'] = entry
        if own_trace:
            dbg.record_prompt('Prompt tab（注入 pipeline 上下文）', user_positive,
                              loras=debug_lora_entries(user_loras))
        # 默认注入的图 + mask (context image)
        # chain 模式：优先使用调用方显式传入的输入图/mask（来自上一 block 的 pipeline）
        base_img = input_image if input_image is not None else (
            injected_pipeline.get_image(required=False) if injected_pipeline else None)
        base_mask = input_mask if input_mask is not None else (
            injected_pipeline.mask if injected_pipeline else None)

        # 关键：把 resized 工作区图/mask 同步进 injected_pipeline，使子图内部通过
        # pipeline.get_image()/pipeline.mask 取到的也是预处理后的工作区尺寸（而非原始全图）。
        # 否则子图若从 pipeline 取 image，会拿到 crop/limit 之前的原始全图，与 mask 尺寸
        # 不一致导致后续 recover_crop 崩溃。此处仅同步尺寸状态，不做额外 resize。
        if injected_pipeline is not None:
            if base_img is not None:
                injected_pipeline.image = base_img
            if base_mask is not None:
                injected_pipeline.mask = base_mask

        if own_trace:
            dbg.record_stage(
                '执行模式',
                '离线 processor —— pipeline 当前图不改动' if exec_options.get('offline')
                else 'Interface tab 独立执行',
                interface=pkg.get('name', ''), index=interface_idx, operation=operation)
            dbg.record_image('上下文图（pipeline 当前图）', base_img)
            dbg.record_mask('上下文 mask', base_mask)

        # 构建端口级图片覆盖。端口声明为 MASK 的走亮度转换 —— 覆盖值都是 [1,H,W,C] 图，
        # 直接灌进 mask 端口形状不对。
        # image_keys 的每项可以是 staging id（画布派生的在途图）或 `asset:<哈希>`（Processor
        # 的 Assets 来源，后端直接从仓库读字节）；Allow List 下还可以是**一列**这样的键。
        # video_inputs 直接按 {file, f0, n, fps} 帧段抽帧成一列（旧快照的 {file, ss, t, …}
        # 仍照旧按秒走）—— 两条路都落成
        # port_overrides 里的 list，由 InterfaceExecutor 的 list_mode 分流。
        start_types = pkg.get('start_types', {})
        _start_names = ((getattr(server, 'interface_meta', None) or {})
                        .get(pkg.get('name', '')) or {}).get('names', {}).get('start') or {}
        list_mode = bool(exec_options.get('list_mode'))
        video_inputs = exec_options.get('video_inputs') or {}
        port_overrides = {}
        for port_num_str, key in image_keys.items():
            keys = key if isinstance(key, list) else [key]
            imgs = [processor_input_tensor(k, server) for k in keys if k]
            imgs = [x for x in imgs if x is not None]
            if not imgs:
                continue
            declared = start_types.get(str(port_num_str))
            if declared == 'MASK':
                vals = [staging_image_to_mask(x) for x in imgs]
            else:
                vals = imgs
            port_overrides[int(port_num_str)] = vals if (list_mode or len(vals) > 1) else vals[0]
            if own_trace:
                _pname = _start_names.get(str(port_num_str)) or f'value{port_num_str}'
                _what = ('asset ' if all(str(k).startswith('asset:') for k in keys if k) else 'staging ')
                _detail = f'{_what}{keys}' + (f'（{len(vals)} 张一列）' if len(vals) > 1 else '')
                _detail += '（亮度转 mask）' if declared == 'MASK' else ''
                if declared == 'MASK':
                    dbg.record_mask(f'输入覆盖 · {_pname}', vals[0], detail=_detail)
                else:
                    dbg.record_image(f'输入覆盖 · {_pname}', vals[0], detail=_detail)
            print(f"[InterfaceExec] Port {port_num_str} image override: "
                  f"ids={keys} ({declared or 'IMAGE'}, {len(vals)} frame(s))")
        # 视频入口：按片段信息抽帧（ffmpeg 直接读资产库里的文件，不绕浏览器）。
        for port_num_str, spec in video_inputs.items():
            if not isinstance(spec, dict):
                continue
            fname = os.path.basename(str(spec.get('file') or ''))
            vpath = _vid_media_path(spec.get('file')) or os.path.join(_vid_media_dir(), fname)
            frames = _vid_frames(vpath, ss=spec.get('ss', 0), t=spec.get('t'),
                                 n=spec.get('n'), fps=spec.get('fps'), f0=spec.get('f0'))
            if not frames:
                raise ValueError(f'Video input for port {port_num_str}: no frames extracted from {fname}')
            declared = start_types.get(str(port_num_str))
            vals = [staging_image_to_mask(f) for f in frames] if declared == 'MASK' else frames
            port_overrides[int(port_num_str)] = vals
            if own_trace:
                _pname = _start_names.get(str(port_num_str)) or f'value{port_num_str}'
                if declared == 'MASK':
                    dbg.record_mask(f'视频输入 · {_pname}', vals[0],
                                    detail=f'{fname} 抽 {len(vals)} 帧（亮度转 mask）')
                else:
                    dbg.record_image(f'视频输入 · {_pname}', vals[0], detail=f'{fname} 抽 {len(vals)} 帧')
            print(f"[InterfaceExec] Port {port_num_str} video input: {fname} → {len(vals)} frames")

        # Video Generator 的参考视频：段的绝对时间窗映射到一条时间线视频轨，前端按输出
        # 帧率把它切成若干**帧段**（跨片段时一片一段），这里逐片按同一套帧号网格抽帧，
        # 拼成一整列喂给参考口。行的条数与段长严格对齐 —— 少了就报错（映射位置有空、
        # 或源比声明的时长还短），不静默补/截。
        reference_video = exec_options.get('reference_video') or {}
        for port_num_str, spec in reference_video.items():
            if not isinstance(spec, dict):
                continue
            try:
                rfps = float(spec.get('fps') or 0)
            except (TypeError, ValueError):
                rfps = 0.0
            if rfps <= 0:
                raise ValueError(f'Reference video for port {port_num_str}: no sampling FPS was sent.')
            pieces = spec.get('specs') if isinstance(spec.get('specs'), list) else []
            try:
                expect = int(spec.get('expect') or 0)
            except (TypeError, ValueError):
                expect = 0
            want_total = expect or sum(
                max(0, int(p.get('n') or 0)) for p in pieces if isinstance(p, dict))
            want_total = max(1, min(_VID_REF_MAX_N, want_total))
            frames = []
            used = []
            for idx, piece in enumerate(pieces):
                if not isinstance(piece, dict):
                    continue
                fname = os.path.basename(str(piece.get('file') or ''))
                try:
                    want = max(1, int(piece.get('n') or 0))
                except (TypeError, ValueError):
                    want = 1
                vpath = _vid_media_path(piece.get('file')) or os.path.join(_vid_media_dir(), fname)
                if not vpath or not os.path.isfile(vpath):
                    raise ValueError(
                        f'Reference video for port {port_num_str}: media {fname!r} is missing '
                        f'from the asset store (piece {idx + 1}/{len(pieces)}).')
                got = _vid_frames(vpath, n=want, fps=rfps, f0=piece.get('f0'),
                                  work_n=want_total, max_n=_VID_REF_MAX_N)
                if not got:
                    raise ValueError(
                        f'Reference video for port {port_num_str}: no frames extracted from '
                        f'{fname} (piece {idx + 1}/{len(pieces)}).')
                if len(got) < want:
                    raise ValueError(
                        f'Reference video for port {port_num_str}: {fname} yielded '
                        f'{len(got)}/{want} frames — the mapped range is not fully covered.')
                frames.extend(got)
                used.append(f'{fname}[{int(piece.get("f0") or 0)}+{want}]')
            if not frames:
                raise ValueError(f'Reference video for port {port_num_str}: empty reference range.')
            if expect and len(frames) != expect:
                raise ValueError(
                    f'Reference video for port {port_num_str}: expected {expect} frames, got '
                    f'{len(frames)} — the mapped range is not fully covered.')
            declared = start_types.get(str(port_num_str))
            vals = [staging_image_to_mask(f) for f in frames] if declared == 'MASK' else frames
            port_overrides[int(port_num_str)] = vals
            if own_trace:
                _pname = _start_names.get(str(port_num_str)) or f'value{port_num_str}'
                _detail = f'{len(vals)} 帧 @ {rfps:.3f}fps · ' + ', '.join(used)
                if declared == 'MASK':
                    dbg.record_mask(f'参考视频 · {_pname}', vals[0], detail=_detail)
                else:
                    dbg.record_image(f'参考视频 · {_pname}', vals[0], detail=_detail)
            print(f"[InterfaceExec] Port {port_num_str} reference video: "
                  f"{len(vals)} frames @ {rfps:.3f}fps from {', '.join(used)}")

        # 生成器链条的共享帧：前一段的**产物末帧**喂进这一段的首帧口。src 是 placeProcOutput
        # 落位时入库的那份（资产库/媒体库 URL），这里解回盘上路径、按源帧号抽末帧 ——
        # 前段绑了末帧卡时前端直接给 image_keys，不走这里。
        chain_frames = exec_options.get('chain_frames') or {}
        for port_num_str, spec in chain_frames.items():
            if not isinstance(spec, dict):
                continue
            src = str(spec.get('src') or '')
            vpath = _vid_media_path(src)
            if not vpath:
                raise ValueError(f'Chained first frame for port {port_num_str}: cannot resolve media {src!r} '
                                 f"— the previous segment's result is missing from the asset store.")
            probe = _vid_ffprobe(vpath)
            if not probe or not probe.get('duration'):
                raise ValueError(f'Chained first frame for port {port_num_str}: no duration probed from '
                                 f'{os.path.basename(vpath)}.')
            try:
                pf = float(spec.get('fps') or 0)
            except (TypeError, ValueError):
                pf = 0.0
            if pf <= 0:
                pf = 30.0
            # 最后一个"正在显示"的源帧号：dur*pf 落在网格上时 -ε 才不会多出一格。
            last_f = max(0, int(probe['duration'] * pf - 1e-6))
            frames = None
            for f0 in (last_f, max(0, last_f - 1)):
                frames = _vid_frames(vpath, ss=0.0, t=1.0 / pf, n=1, fps=pf, f0=f0)
                if frames:
                    last_f = f0
                    break
            if not frames:
                raise ValueError(f'Chained first frame for port {port_num_str}: no frames extracted from '
                                 f'{os.path.basename(vpath)}.')
            declared = start_types.get(str(port_num_str))
            val = staging_image_to_mask(frames[0]) if declared == 'MASK' else frames[0]
            port_overrides[int(port_num_str)] = val
            if own_trace:
                _pname = _start_names.get(str(port_num_str)) or f'value{port_num_str}'
                _detail = f'{os.path.basename(vpath)} 末帧（帧号 {last_f}）'
                if declared == 'MASK':
                    dbg.record_mask(f'链式首帧 · {_pname}', val, detail=_detail + '（亮度转 mask）')
                else:
                    dbg.record_image(f'链式首帧 · {_pname}', val, detail=_detail)
            print(f"[InterfaceExec] Port {port_num_str} chained first frame: "
                  f"{os.path.basename(vpath)} f0={last_f} ({declared or 'IMAGE'})")

        # 生成器的**参考图**：未绑定（且没有链式首帧）的首/末帧由前端按绝对时间解析成
        # {file, f0, fps} —— 这里只抽那一帧、单张注入。已经由 image_keys / chain_frames
        # 占着的口一律不覆盖（显式绑定与链永远优先）。
        frame_refs = exec_options.get('frame_refs') or {}
        for port_num_str, spec in frame_refs.items():
            if not isinstance(spec, dict):
                continue
            pnum = int(port_num_str)
            if pnum in port_overrides:
                continue
            fname = os.path.basename(str(spec.get('file') or ''))
            vpath = _vid_media_path(spec.get('file')) or os.path.join(_vid_media_dir(), fname)
            if not vpath or not os.path.isfile(vpath):
                raise ValueError(f'Reference frame for port {port_num_str}: media {fname!r} '
                                 f'is missing from the asset store.')
            try:
                rfps = float(spec.get('fps') or 0)
            except (TypeError, ValueError):
                rfps = 0.0
            if rfps <= 0:
                rfps = 30.0
            try:
                rf0 = max(0, int(spec.get('f0') or 0))
            except (TypeError, ValueError):
                rf0 = 0
            frames = _vid_frames(vpath, n=1, fps=rfps, f0=rf0)
            if not frames:
                raise ValueError(f'Reference frame for port {port_num_str}: no frame extracted '
                                 f'from {fname} at f0={rf0} ({rfps:.3f}fps).')
            declared = start_types.get(str(port_num_str))
            val = staging_image_to_mask(frames[0]) if declared == 'MASK' else frames[0]
            port_overrides[pnum] = val
            if own_trace:
                _pname = _start_names.get(str(port_num_str)) or f'value{port_num_str}'
                _detail = f'{fname} 第 {rf0} 帧 @ {rfps:.3f}fps'
                if declared == 'MASK':
                    dbg.record_mask(f'参考图 · {_pname}', val, detail=_detail)
                else:
                    dbg.record_image(f'参考图 · {_pname}', val, detail=_detail)
            print(f"[InterfaceExec] Port {port_num_str} reference frame: "
                  f"{fname} f0={rf0} @ {rfps:.3f}fps")

        # 生成器的**提示词 preset**（段级 + 轨级）：各自渲染成串**按序追加**在段 prompt 口
        # 的纯文本后面 —— 端口纯文本在前、段 preset 在后、轨级 preset 最后（与前端约定的
        # 三层合并一致）。merge_global=False：只渲染 preset 本身，不掺 prompt tab 的全局
        # 选择 —— 这些是段/轨自己的附加词，与 prompt tab 那份无关。
        _vg_track = exec_options.get('vgen') if isinstance(exec_options.get('vgen'), dict) else None
        _vg_prompt_port = ((_vg_track.get('ports') or {}).get('prompt')
                           if isinstance(_vg_track, dict) and isinstance(_vg_track.get('ports'), dict) else None)
        _vg_preset_ids = []
        if isinstance(_vg_track, dict):
            for _key, _label in (('prompt_preset_id', '段提示词 preset'),
                                 ('track_prompt_preset_id', '轨道提示词 preset')):
                if _vg_track.get(_key):
                    _vg_preset_ids.append((_key, _label, _vg_track.get(_key)))
        if _vg_preset_ids and _vg_prompt_port and not chain_mode:
            _key = str(_vg_prompt_port)
            for _pkey, _label, _pid in _vg_preset_ids:
                _sel = server._prompt_preset_selection(_pid) \
                    if hasattr(server, '_prompt_preset_selection') else None
                _pos, _ = self._resolve_prompt_selection(server, _sel, merge_global=False)
                if not _pos:
                    continue
                _base = manual_values.get(_key) if isinstance(manual_values, dict) else None
                manual_values[_key] = f"{_base}, {_pos}" if _base else _pos
                if own_trace:
                    dbg.record_prompt(f'{_label}（追加到段提示词后）', _pos)
                print(f"[InterfaceExec] vgen {_label} {_pid} appended to "
                      f"port {_vg_prompt_port}: '{_pos[:120]}'")

        injected_img = base_img
        injected_mask = base_mask
        pending_crop = None

        # Crop mask 区域 (基于 context image + mask)
        if operation == 'crop':
            if base_img is None or base_mask is None:
                raise ValueError("Crop operation requires both image and mask")
            exp_mask = expand_mask(base_mask, grow=32, blur=32)
            cropped_img, cropped_mask, crop_info = crop_mask(
                image=base_img, mask=exp_mask, reserve=crop_reserve)
            injected_img, injected_mask = cropped_img, cropped_mask
            pending_crop = {
                'crop_info': crop_info,
                'original': base_img,
                'mask': cropped_mask,
            }
            print(f"[InterfaceExec] cropped {base_img.shape} → {cropped_img.shape} crop_info={crop_info}")
            if own_trace:
                dbg.record_stage('Crop 工作区',
                                 f'{tuple(base_img.shape)} → {tuple(cropped_img.shape)}',
                                 reserve=crop_reserve)
                dbg.record_image('Crop 后工作图', cropped_img)
                dbg.record_mask('Crop 后工作 mask', cropped_mask)

        # 记录 interface 结果 keys
        server.interface_result_keys = []
        server.interface_result_meta = []

        # 不在执行期直接加 history——等 uncrop 之后再以最终图加入
        def _on_result_image(img, name):
            pass

        # chain 模式：捕获 interface 返回的（被修改过的）pipeline，
        # 将其 model/clip/context/lora 等修改写回上游 pipeline，
        # 使后续 detailer block 拿到的就是被 interface 修改后的 model 等。
        result_pipeline = None

        def _on_result_pipeline(pipe, name):
            nonlocal result_pipeline
            if pipe is not None:
                result_pipeline = pipe

        executor = InterfaceExecutor(
            extra_pnginfo=getattr(server, 'extra_pnginfo', None),
            on_progress=lambda cur, total: setattr(server, 'interface_current_step', cur) or setattr(server, 'interface_total_steps', total) or setattr(server, 'interface_progress', cur / max(total, 1)),
            get_pipeline=lambda: injected_pipeline,
            get_image=lambda: injected_img,
            get_mask=lambda: injected_mask,
            on_result_image=_on_result_image,
            on_result_pipeline=_on_result_pipeline if return_image else None,
            on_sampler_progress=lambda cur, total, node_id: setattr(server, 'interface_current_step', cur) or setattr(server, 'interface_total_steps', total) or setattr(server, 'interface_progress', cur / max(total, 1)),
        )

        try:
            results = executor.execute(pkg, manual_values, port_overrides=port_overrides,
                                       list_mode=list_mode)
        except mm.InterruptProcessingException:
            # Cancel（/api/cancel_run）触发的打断：标成 cancelled，别写成 error。
            if own_trace:
                dbg.record_stage('执行已取消', 'cancelled by user (interrupt)')
                _tr = dbg.current_trace()
                if _tr is not None:
                    _tr.meta['status'] = 'cancelled'
            raise
        except Exception as e:
            if own_trace:
                dbg.record_error('interface 执行异常', str(e), where='_execute_interface')
                _tr = dbg.current_trace()
                if _tr is not None:
                    _tr.meta['status'] = 'error'
                    _tr.meta['error'] = str(e)
            raise

        # Uncrop：将裁剪结果复原回完整图
        if pending_crop is not None:
            uncropped_results = []
            for item in results:
                ptype, img, name = item
                if ptype == 'IMAGE':
                    uncropped, _ = recover_crop(
                        background=pending_crop['original'],
                        image=img,
                        crop_info=pending_crop['crop_info'],
                        recover_method='mask_blend',
                        mask=pending_crop['mask'],
                    )
                    uncropped_results.append(('IMAGE', uncropped, name))
                else:
                    uncropped_results.append(item)
            results = uncropped_results
            print(f"[InterfaceExec] uncropped {len(results)} results back to full size")
            if own_trace:
                dbg.record_stage('Uncrop', f'{len(results)} 个结果复原回完整图')

        # 离线 processor 语义：结果（IMAGE 与 MASK 都算）全部作为隐藏 staging 条目送回，
        # 端口对应关系记进 interface_result_meta 供工作台按端口落位；pipeline 当前图
        # 一概不动 —— processor 是「拿工作台的图去算一枚结果」，不是接力 run。
        if exec_options.get('offline'):
            _end_names = ((getattr(server, 'interface_meta', None) or {})
                          .get(pkg.get('name', '')) or {}).get('names', {}).get('end') or {}
            result_ports = getattr(executor, 'result_ports', [])
            # 视频入口那条路（Allow List + video_inputs）：每个 image/mask 出口的那一列
            # **编码成一段视频**回给宿主（新轨上的片段），不再逐张进图池 —— 逐张落图层
            # 对一列几百帧没有意义。编码 fps 用入口的 fps（= 抽帧 fps，时长因此对得上）。
            if video_inputs:
                encode_fps = 30.0
                for spec in video_inputs.values():
                    if isinstance(spec, dict) and spec.get('fps'):
                        try:
                            encode_fps = float(spec['fps'])
                        except (TypeError, ValueError):
                            pass
                        break
                groups = {}
                for i, (ptype, val, name) in enumerate(results):
                    port_num = result_ports[i] if i < len(result_ports) else None
                    if ptype not in ('IMAGE', 'MASK'):
                        continue
                    groups.setdefault(port_num, []).append((ptype, val, name))
                for port_num, items in groups.items():
                    ptype, _, name = items[0]
                    vals = [v for _, v, _ in items]
                    url = _vid_encode(vals, fps=encode_fps, name=f"{pkg.get('name', 'proc')}_v{port_num}")
                    if not url:
                        continue
                    server.interface_result_keys.append('')
                    server.interface_result_meta.append(
                        {'key': None, 'port': port_num, 'type': ptype, 'name': name,
                         'video': url, 'frames': len(vals)})
                    if own_trace:
                        _pname = (_end_names.get(str(port_num)) if port_num is not None else None) \
                            or (f'value{port_num}' if port_num is not None else name)
                        if ptype == 'MASK':
                            dbg.record_mask(f'输出 · {_pname}', vals[0],
                                            detail=f'{len(vals)} 帧编码成视频 {url}')
                        else:
                            dbg.record_image(f'输出 · {_pname}', vals[0],
                                             detail=f'{len(vals)} 帧编码成视频 {url}')
                if own_trace:
                    dbg.record_stage('离线结果（视频）',
                                     f'{len(server.interface_result_meta)} 段视频编码回宿主，pipeline 当前图未改动')
                    _tr = dbg.current_trace()
                    if _tr is not None:
                        _tr.meta['status'] = 'done'
                print(f"[InterfaceExec] offline processor (video): "
                      f"{len(server.interface_result_meta)} video results, pipeline untouched")
                return None
            # Video Generator：VIDEO 出口的产物原样搬进媒体库回给宿主。
            # 帧率只决定"片怎么编 / 怎么钉容器"，**与段长无关** —— 段长是时间线上那一截
            # （前端按 clip.duration 落位）：生成器按 16fps 出、工程是 30fps，对不上是常态。
            # 段自己揣着一份绑定快照（exec_options.vgen）：接口后来改了绑定，老段仍按自己
            # 当时那份跑 —— 所以段给的优先，没有才退回 server.interface_meta 上现在这份。
            _vg_cfg = exec_options.get('vgen') if isinstance(exec_options.get('vgen'), dict) else None
            if not _vg_cfg:
                _vg_cfg = ((getattr(server, 'interface_meta', None) or {})
                           .get(pkg.get('name', '')) or {}).get('video_gen') or {}
            _vg_ports = _vg_cfg.get('ports') if isinstance(_vg_cfg, dict) else None
            _vg_ports = _vg_ports if isinstance(_vg_ports, dict) else {}
            _vg_fixed = bool(_vg_cfg.get('fixed_fps')) if isinstance(_vg_cfg, dict) else False
            _vg_vport = _vg_ports.get('video') or None
            # 帧率的两个来源：Fixed FPS 开着 = 这台生成器**写死**的那个数（不进图、不绑端口，
            # 由前端那颗开关旁边的框填，比如 16）；关着 = fps 槽那一口喂进去的值。
            # 图片型出口**无论如何都得有个帧率**去编码，所以关着时也读一份（读不到再反推/兜 30）。
            # 注意它只决定"片怎么编/怎么钉"，**与段长无关** —— 段长是时间线上那一截，
            # 生成器 16fps 出、工程 30fps，对不上是常态。
            _vg_fps = None
            if _vg_fixed:
                try:
                    _v = float(_vg_cfg.get('fixed_fps_value'))
                    if _v > 0:
                        _vg_fps = _v
                except (TypeError, ValueError):
                    _vg_fps = None
                if not _vg_fps:
                    _vg_fps = 16.0
            elif _vg_ports.get('fps'):
                try:
                    _v = float((manual_values or {}).get(str(_vg_ports['fps'])))
                    if _v > 0:
                        _vg_fps = _v
                except (TypeError, ValueError, KeyError):
                    _vg_fps = None
            _want_fps = _vg_fps if _vg_fixed else None
            _vg_dur = None
            if _vg_ports.get('duration'):
                try:
                    _d = float((manual_values or {}).get(str(_vg_ports['duration'])))
                    if _d > 0:
                        _vg_dur = _d
                except (TypeError, ValueError, KeyError):
                    _vg_dur = None
            # 被生成器接走的结果下标 —— 后面那趟"其余结果进图池"要跳过它们（否则图片型
            # 生成器的帧既成了视频、又塞一份进图池）。
            _vg_taken = set()
            for i, (ptype, val, name) in enumerate(results):
                if ptype != 'VIDEO':
                    continue
                port_num = result_ports[i] if i < len(result_ports) else None
                url, frames, fps = _vid_publish(
                    val, name=f"{pkg.get('name', 'vgen')}_v{port_num}", want_fps=_want_fps)
                if not url:
                    continue
                _vg_taken.add(i)
                server.interface_result_keys.append('')
                server.interface_result_meta.append(
                    {'key': None, 'port': port_num, 'type': 'VIDEO', 'name': name,
                     'video': url, 'frames': frames, 'fps': fps})
                print(f"[InterfaceExec] video generator: port {port_num} → {url} "
                      f"({frames} frames @ {fps:.3f}fps)")
                if own_trace:
                    _pname = (_end_names.get(str(port_num)) if port_num is not None else None) or name
                    dbg.record_stage('输出 · ' + str(_pname),
                                     f'{frames} 帧 @ {fps:.3f}fps → {url}')
            # video 槽绑在 **IMAGE 口**上的那一类生成器：产物是一批帧而不是一个 mp4 ——
            # 就在这里把它们现编成一段（帧率 = fps 槽喂进去的那个数），于是时间线上
            # 图片型生成器与真·视频生成器长得一模一样：段按 frames/fps 落位、照常重跑。
            if _vg_vport:
                _vframes, _vname = [], ''
                for i, (ptype, val, name) in enumerate(results):
                    if ptype != 'IMAGE' or i in _vg_taken:
                        continue
                    port_num = result_ports[i] if i < len(result_ports) else None
                    if port_num != _vg_vport:
                        continue
                    _vg_taken.add(i)
                    _vname = _vname or name
                    _vframes.extend(_vid_frames_of(val))
                if _vframes:
                    if _vg_fps and _vg_fps > 0:
                        _enc = _vg_fps
                    elif _vg_dur and _vg_dur > 0:
                        _enc = len(_vframes) / _vg_dur
                    else:
                        _enc = 30.0
                    _enc = max(1.0, min(120.0, float(_enc)))
                    # Fixed FPS：帧率是写死的，于是"这段该有多少帧"也是可算的（duration × fps）。
                    # 少了几帧就用最后一帧顶上（**只补不裁**，且只补小缺口 —— 差一半以上说明
                    # 生成器另有打算，别硬凑；段长仍然是段自己的长度，不受它影响）。
                    if _vg_fixed and _vg_dur:
                        _want_n = int(round(_vg_dur * _enc))
                        while 0 < len(_vframes) < _want_n and _want_n - len(_vframes) <= max(2, _want_n // 2):
                            _vframes.append(_vframes[-1])
                        if len(_vframes) < _want_n:
                            print(f'[InterfaceExec] image out: {len(_vframes)} frames for '
                                  f'{_vg_dur}s @ {_enc:.3f}fps (want {_want_n}) — leaving it as the '
                                  f'generator returned it')
                    url = _vid_encode(_vframes, fps=_enc,
                                      name=f"{pkg.get('name', 'vgen')}_v{_vg_vport}")
                    if url:
                        server.interface_result_keys.append('')
                        server.interface_result_meta.append(
                            {'key': None, 'port': _vg_vport, 'type': 'IMAGE', 'name': _vname,
                             'video': url, 'frames': len(_vframes), 'fps': _enc, 'stitched': True})
                        print(f"[InterfaceExec] video generator (image out): port {_vg_vport} → {url} "
                              f"({len(_vframes)} frames @ {_enc:.3f}fps, stitched)")
                        if own_trace:
                            _pname = _end_names.get(str(_vg_vport)) or _vname
                            dbg.record_image(f'输出 · {_pname}', _vframes[0],
                                             detail=f'{len(_vframes)} 帧现编成视频 {url}')
                    else:
                        # 编码没成（多半是 ffmpeg 不在）：撤销"接走"，让这批帧照常进图池，
                        # 用户至少能看到图 —— 段那一侧报"没有视频产物"。
                        for i in [k for k, (pt, _, _) in enumerate(results)
                                  if pt == 'IMAGE' and (result_ports[k] if k < len(result_ports) else None) == _vg_vport]:
                            _vg_taken.discard(i)
            for i, (ptype, val, name) in enumerate(results):
                if i in _vg_taken:
                    continue
                port_num = result_ports[i] if i < len(result_ports) else None
                if ptype == 'IMAGE':
                    sid = server.add_staging(val, name=name, hidden=True)
                elif ptype == 'MASK':
                    sid = server.add_staging(staging_mask_to_image(val), name=name, hidden=True)
                else:
                    continue
                server.interface_result_keys.append(sid)
                server.interface_result_meta.append(
                    {'key': sid, 'port': port_num, 'type': ptype, 'name': name})
                if own_trace:
                    _pname = (_end_names.get(str(port_num)) if port_num is not None else None) \
                        or (f'value{port_num}' if port_num is not None else name)
                    _detail = f'staging {sid}' + ('（mask→灰度图，工作台侧再落位）' if ptype == 'MASK' else '')
                    if ptype == 'MASK':
                        dbg.record_mask(f'输出 · {_pname}', val, detail=_detail)
                    else:
                        dbg.record_image(f'输出 · {_pname}', val, detail=_detail)
            if own_trace:
                dbg.record_stage('离线结果',
                                 f'{len(server.interface_result_meta)} 个结果进图池（hidden），pipeline 当前图未改动')
                _tr = dbg.current_trace()
                if _tr is not None:
                    _tr.meta['status'] = 'done'
            print(f"[InterfaceExec] offline processor: {len(server.interface_result_meta)} results, pipeline untouched")
            return None

        # 提取结果图 / mask
        result_img = None
        result_mask = base_mask
        for ptype, img, name in results:
            if ptype == 'IMAGE' and result_img is None:
                result_img = img
                print(f"[InterfaceExec] result image: {name} {img.shape if hasattr(img, 'shape') else ''}")

        if return_image:
            # chain 模式：仅返回结果，不写 history / 不切换 context
            if result_img is None:
                print("[InterfaceExec] WARNING: no IMAGE result returned, keeping input")
                result_img = base_img
            # 将 interface 内部对 pipeline 的修改（model/clip/context/loras 等）写回上游
            # pipeline，使后续 detailer block 拿到的是被 interface 修改后的 model 等。
            if result_pipeline is not None and base_pipeline is not None:
                self._sync_pipeline_updates(base_pipeline, result_pipeline)
                print(f"[InterfaceExec] chain: synced interface pipeline updates (model/clip/context/loras) back to upstream pipeline")
            return result_img, result_mask

        # 以最终（可能已 uncrop）图加入内部图池（hidden：前端据条目 id 展示接口结果，
        # 但接口产出不进工作区条带），并记录条目 id
        for ptype, img, name in results:
            if ptype == 'IMAGE':
                server.interface_result_keys.append(
                    server.add_staging(img, name=name, hidden=True))
                if own_trace:
                    dbg.record_image(f'输出 · {name}', img)

        # 接口结果图同时接管 pipeline image（后续 block / 下一次 run 从它继续）
        if results:
            new_key = server.interface_result_keys[-1]
            last_image = server.get_staging_image(new_key)
            if last_image is not None:
                self._switch_image(server, last_image)
                print(f"[InterfaceExec] Pipeline image updated from staging {new_key}")
        if own_trace:
            dbg.record_stage('执行结束',
                             f'{len(server.interface_result_keys)} 个结果进图池（hidden）')
            _tr = dbg.current_trace()
            if _tr is not None:
                _tr.meta['status'] = 'done'

    # -------------------------------------------------------------------------
    # 主入口
    # -------------------------------------------------------------------------
    def sample(self, pipeline, seed, lora_regex="", detector=None, tagger=None, asset="",
               package=None, extra_pnginfo=None, unique_id=None):
        mm.throw_exception_if_processing_interrupted()

        # pipeline 口是必需口，交回 None 就没有任何东西可跑（画布、Run、finish 落图全指着它）。
        # 这句检查原来只在末尾，于是中途两处裸访问（_switch_image、finish 落图）会先炸成
        # AttributeError —— 挪到这里，两条路一起断在一句话上。
        if pipeline is None:
            raise RuntimeError("[SnapshotDetailerSampler] Pipeline is None")

        self._current_pipeline = pipeline.copy()
        # 保存"原始 pipeline"引用：仅在初始化 / Pipeline tab 切换时设定。
        # 每次 Run detailer 都基于它的副本执行，run 之间不共享、不累积修改。
        self._base_pipeline = self._current_pipeline
        # 跨 run 条件缓存仓库：挂在节点实例上 —— 每次 Run 都用上游管线重建整条
        # 链（副本不复用），仓库是唯一能活过 run 的载体。run 内一切沿 copy() 继承。
        if getattr(self, '_cond_store', None) is None:
            self._cond_store = ConditioningCacheStore()
        self._cond_store.begin_run()
        self._cond_store.sweep()
        self._base_pipeline._cond_store = self._cond_store

        # Derive lora_regex from pipeline's architecture config if not explicitly provided
        if not lora_regex and pipeline.config:
            arch = pipeline.config.get("architecture")
            if arch:
                lora_regex = str(arch)

        server = SnapshotDetailerSamplerServer(
            detector=detector,
            tagger=tagger,
            lora_regex=lora_regex,
            asset=asset,
            package=package,
            node_instance=self,
            unique_id=unique_id,
            extra_pnginfo=extra_pnginfo,
        )
        server.start()

        t0 = time.time()
        while not server.started:
            mm.throw_exception_if_processing_interrupted()
            if time.time() - t0 > 15:
                server.stop()
                raise RuntimeError("[SnapshotDetailerSampler] Server startup timeout")
            time.sleep(0.01)

        # 初始图进内部图池（hidden：前端种子画布从这里取，但不占工作区条带 ——
        # 工作区只收用户主动拖入的图）。没有图就没有种子，工作台那侧会自己去要上次那一份
        # .cud（GET /api/recent_cud），所以这句写在日志里而不是让它静默成一块空画布。
        if self._current_pipeline.image is not None:
            server.original_key = server.add_staging(self._current_pipeline.image, name='Original', hidden=True)
        else:
            print("[SnapshotDetailerSampler] pipeline carries no image — the Blend canvas has no seed; "
                  "the workbench will ask for the last .cud opened here")

        print(f"[SnapshotDetailerSampler] Opening browser at: {server.browser_url}")
        open_ui(server.browser_url)

        try:
            while not server.finished:
                try:
                    mm.throw_exception_if_processing_interrupted()
                except Exception as e:
                    if "interrupt" in str(e).lower() or "processing" in str(e).lower():
                        break
                    raise
                if mm.processing_interrupted():
                    break

                # 等待前端 action
                action = server.wait_for_action()
                if action is None:
                    break

                act = action.get('action')

                if act == 'window_closed':
                    break

                if act == 'finish':
                    break

                if act == 'run_detailer':
                    server.detail_status = 'running'
                    server.detail_error = None
                    server.detail_progress = 0
                    server.detail_current_step = 0
                    server.detail_total_steps = 0
                    # Debug：每一次 Run / Generate 开一份新 trace（丢弃上一份）。
                    # Context 标题右侧的 Debug 按钮读的就是它。
                    dbg.begin_trace({
                        'from_blend': bool(action.get('from_blend')),
                        'action': 'run_detailer',
                    })
                    # Set up progress tracking via ComfyUI's global hook
                    import comfy.utils
                    orig_hook = comfy.utils.PROGRESS_BAR_HOOK
                    def _progress_hook(current, total, preview=None, **kwargs):
                        server.detail_current_step = current
                        server.detail_total_steps = total
                        if total > 0:
                            server.detail_progress = current / total
                    comfy.utils.set_progress_bar_global_hook(_progress_hook)
                    try:
                        # 每次 run 重新记账：Enable Output 落盘只认这一趟里块出口暂存的选择与
                        # 最后一份送进 CLIP 的串，上一趟的残留不能被复用。
                        server.last_effective_prompt_selection = None
                        server.last_clip_positive = ''
                        server.last_output_positive = ''
                        user_positive, user_loras = self._parse_prompt(server.prompt_server)
                        # 可观测性：Generate / Run Detailer 实际注入的 prompt tab 内容。
                        # 曾因 prefab 不展开而静默为空（见 _expand_prefabs 注释），这行让
                        # 「没注入」在日志里一眼可见。
                        print(f"[run_detailer] prompt tab: positive='{user_positive[:200]}' ({len(user_positive)} chars), loras={user_loras}")
                        # Model-only 名单（这一趟哪些 lora 只改 model 不改 CLIP）——核对
                        # 标记有没有在 payload / cache 往返中跟丢，就看这行和块内 [QueryLora]。
                        _mo = [p.strip() for p in user_loras.split(',') if p.strip().endswith(':model_only>')]
                        if _mo:
                            print(f"[run_detailer] MODEL-ONLY loras this run ({len(_mo)}): {_mo}")
                        else:
                            print(f"[run_detailer] model-only loras this run: none (every lora patches model + CLIP)")
                        dbg.record_prompt('1. Prompt tab（_parse_prompt 解析结果）', user_positive,
                                          loras=debug_lora_entries(user_loras))

                        # Blend 工作台：输入图 = 画布合成图，遮罩 = 纯 Mask 层，两者随 action 送达。
                        # 走这条路时完全不动 _current_pipeline 的 image/mask，也就没有 context 切换。
                        from_blend = bool(action.get('from_blend'))
                        blend_image = server.blend_image if from_blend else None
                        if from_blend:
                            current_mask = server.blend_mask
                        else:
                            current_mask = self._current_pipeline.mask
                        if current_mask is not None:
                            current_mask = current_mask.clone()

                        # 追加 prompt：只拼在 _parse_prompt 的结果之后，不写回 prompt 阶段状态，
                        # 所以语义上是「追加描述」而不是「替换 prompt」。
                        # <image_id:...> 嵌图标记在追加前统一解析：引用图 = 全局 refs
                        # （所有 detailer block 共用），标记解码成 <image N> 后才进 positive。
                        extra_prompt = (action.get('extra_prompt') or '').strip() if from_blend else ''
                        prompt_ref_ids = []
                        missing_ref_ids = []
                        if extra_prompt:
                            prompt_ref_ids, extra_prompt, missing_ref_ids = parse_prompt_image_refs(
                                extra_prompt, lambda k: server.get_staging_image(k) is not None)
                        if missing_ref_ids:
                            print(f"[run_detailer] WARNING: extra prompt references missing staging ids "
                                  f"(tokens removed from prompt): {missing_ref_ids}")
                        if extra_prompt:
                            user_positive = f"{user_positive}, {extra_prompt}" if user_positive else extra_prompt
                        if extra_prompt:
                            print(f"[run_detailer] extra prompt appended: '{extra_prompt}' "
                                  f"(prompt refs: {prompt_ref_ids})")
                            dbg.record_prompt('2. Extra Prompt 追加后', user_positive,
                                              extra_prompt=extra_prompt,
                                              ref_ids=list(prompt_ref_ids),
                                              missing_ref_ids=list(missing_ref_ids),
                                              loras=debug_lora_entries(user_loras))

                        # 逐 run 的 preset 选择：取用即清空，下一次普通 Run 一定回落到当前
                        # 激活 tab 的链（否则上一轮 Generate 选的 preset 会偷偷留下来）。
                        # 这段解析必须排在"Mask is required"闸门与 pipeline 切换之前 ——
                        # 闸门看哪条链、切哪条 pipeline、跑哪条链，三者必须是同一套 set。
                        preset_id = server.pending_generate_preset
                        server.pending_generate_preset = None
                        preset_set = next(
                            (s for s in (server.blocks_sets or [])
                             if s.get('id') == preset_id and s.get('blocks')),
                            None,
                        ) if preset_id else None
                        if preset_set is not None:
                            print(f"[run_detailer] using pipeline preset '{preset_set.get('name')}' ({len(preset_set['blocks'])} blocks)")
                        blocks = preset_set['blocks'] if preset_set is not None else server.blocks
                        run_set_id = preset_set['id'] if preset_set is not None else server.active_block_set
                        run_graph = graph_from_config(preset_set) if preset_set is not None else getattr(server, 'graph', None)

                        # 遮罩必须存在，否则 detailer 无意义 —— 例外：Enable Mask 总闸关
                        # （生效链第一个 detailer 的 params.enable_mask）时整幅都是工作区，
                        # Mask 层没画也允许跑。闸门与主循环共用 _first_detailer_enable_mask，
                        # 两条路的选链优先级保持一致。
                        # 第二个例外：链上有 Detect 块（且在第一个 detailer 之前）—— mask 由
                        # 它现造，用户不必先画一层。
                        if current_mask is None or (hasattr(current_mask, 'sum') and current_mask.sum().item() == 0):
                            if (server._first_detailer_enable_mask(preset_id)
                                    and not server._chain_makes_own_mask(preset_id)):
                                server.detail_status = 'error'
                                server.detail_error = 'Mask is required — paint the mask layer before running the detailer'
                                continue

                        # 每次 Run 都基于"原始 pipeline"的副本执行——run 之间不共享、
                        # 不累积上一轮对 pipeline 的修改。用户当前绘制的 mask 属于交互
                        # 状态，单独合并进副本（原始 image / model 来自 base）。
                        if self._base_pipeline is None:
                            server.detail_status = 'error'
                            server.detail_error = 'Pipeline not initialized — pick a pipeline in Pipeline Settings first'
                            continue

                        # Pipeline Settings：这套链绑定了具体 pipeline 名字才切换。
                        # '' = [Default]、[Current Select] = 用当前已加载的那条，都不切。
                        # 加载要走一遍上游、极耗性能，所以只有"这次要的和上次加载的不是同一条"
                        # 时才真的 load —— node_id 是唯一稳定键（名字是推断出来的标题，会重名）。
                        wanted_pipeline = server.preset_pipeline_name(run_set_id)
                        if wanted_pipeline and wanted_pipeline != PIPELINE_CURRENT_SELECT:
                            target = server.find_pipeline_by_name(wanted_pipeline)
                            if target is None:
                                server.detail_status = 'error'
                                server.detail_error = (f"Pipeline '{wanted_pipeline}' is missing — "
                                                       f"it no longer exists in the connected package; "
                                                       f"rebind it in Pipeline Settings")
                                continue
                            if server.loaded_pipeline_node_id == target['node_id']:
                                print(f"[run_detailer] pipeline '{wanted_pipeline}' already loaded — skip switch")
                            else:
                                print(f"[run_detailer] switching pipeline to '{wanted_pipeline}' "
                                      f"(node_id={target['node_id']}) for set '{run_set_id}'")
                                ok, err = self._load_pipeline_from_node(
                                    server, target['node_id'], wanted_pipeline)
                                if not ok:
                                    server.detail_status = 'error'
                                    server.detail_error = err
                                    continue

                        run_pipeline = self._base_pipeline.copy()
                        run_pipeline.mask = current_mask.clone() if current_mask is not None else None

                        # Blend 工作台：输入图就是画布合成图（Blend 画布 = Context Image）。
                        if blend_image is not None:
                            run_pipeline.image = blend_image.clone()

                        # 诊断：打印 mask 和 image 的尺寸信息
                        diag_img = run_pipeline.image
                        if diag_img is not None:
                            diag_img_h, diag_img_w = (diag_img.shape[1], diag_img.shape[2]) if diag_img.dim() == 4 else (diag_img.shape[0], diag_img.shape[1])
                        else:
                            diag_img_h, diag_img_w = 0, 0
                        if current_mask is not None:
                            diag_mask_shape = str(current_mask.shape)
                            diag_mask_sum = current_mask.sum().item()
                            diag_mask_max = current_mask.max().item()
                        else:
                            diag_mask_shape = 'None'
                            diag_mask_sum = 0
                            diag_mask_max = 0
                        print(f"[DIAG] run_detailer: image={diag_img_w}x{diag_img_h} mask_shape={diag_mask_shape} mask_sum={diag_mask_sum:.1f} mask_max={diag_mask_max:.3f}")
                        dbg.record_stage('3. Run 上下文',
                                         f'image={diag_img_w}x{diag_img_h}, mask={diag_mask_shape}',
                                         from_blend=bool(action.get('from_blend')),
                                         image_size=f'{diag_img_w}x{diag_img_h}',
                                         mask_shape=diag_mask_shape,
                                         mask_sum=round(float(diag_mask_sum), 1),
                                         mask_max=round(float(diag_mask_max), 3),
                                         model=type(run_pipeline.model).__name__ if run_pipeline.model is not None else None,
                                         architecture=(run_pipeline.config.get('architecture')
                                                       if run_pipeline.config else None))
                        dbg.record_image('输入图（Blend 画布合成图 / Context）', diag_img)
                        dbg.record_mask('输入 Mask（Mask 层）', current_mask,
                                        detail=f'sum={diag_mask_sum:.0f}')

                        # Build global_params for pipeline execution.
                        # 每个 DEFAULT SETTING 键都取 server 上的当前值（键名与 global_params
                        # 完全一致，所以这里直接摊平）；命中的那条架构规则把 toggle 开着的项覆盖掉
                        # （toggle 关的键压根不在 arch_overrides 的返回里，于是继续吃默认值）。
                        run_architecture = (run_pipeline.config.get('architecture')
                                            if run_pipeline.config else None)
                        global_params = {
                            'seed': seed,
                            **{k: getattr(server, k) for k in server.GLOBAL_PARAM_DEFAULTS},
                            # 兜底值：每个 detailer block 自带 context_regex（Edit 页），
                            # 只有没写这个键的遗留块才回落到 ".+"（全量 context）。
                            'context_regex': '.+',
                        }
                        arch_overrides, arch_rule_id = server.arch_overrides(run_architecture)
                        if arch_overrides:
                            global_params.update(arch_overrides)
                            print(f"[run_detailer] arch '{run_architecture}' matched rule '{arch_rule_id}' "
                                  f"— overrides applied: {arch_overrides}")
                        dbg.record_stage(
                            '4. Pipeline 链',
                            f"{len(blocks)} 个 block"
                            + (f"（preset「{preset_set.get('name')}」）" if preset_set is not None else '（当前激活 tab）'),
                            blocks=[{'index': i + 1, 'type': b.get('type'),
                                     'name': b.get('name')} for i, b in enumerate(blocks)],
                            global_params=dict(global_params),
                            architecture=run_architecture,
                            arch_rule=arch_rule_id or None,
                        )

                        next_pipeline, original_image, detailed_image, detail_meta = self._run_pipeline_blocks(
                            run_pipeline, current_mask, user_positive, user_loras, global_params, blocks, server=server,
                            extra_prompt=extra_prompt, prompt_ref_ids=prompt_ref_ids, graph=run_graph
                        )

                        server.original_image = original_image
                        server.detailed_image = detailed_image
                        dbg.record_image('最终产出（detailed image）', detailed_image,
                                         detail=f'detail_meta={"有 place 矩形" if detail_meta else "无"}')
                        if detail_meta:
                            dbg.record_stage('最终产出元数据', 'Recover Crop 关闭 — 产出是待贴回的 RGBA patch',
                                             place=detail_meta.get('place'))
                        # Context 就是 Blend 画布本身，detailer 产出不再接管 context，
                        # 所以这里不记 context key（产出图由前端作为新图层叠加到画布上）。
                        server.original_key = None
                        server.detail_status = 'done'

                        # 产出图进内部图池（hidden：不进工作区条带 —— 生成结果只有
                        # 用户主动拖入才会出现在工作区；前端仍按 detailed_key 从
                        # /api/staging 取到条目，作为新图层叠加到画布上，图层自带像素）。
                        # Recover Crop 关闭时带放置矩形 —— 产出图本身已是
                        # RGBA（alpha = 工作区 mask），Blend 工作台据此把它作为新图层
                        # transform 贴回原位。
                        server.detailed_key = server.add_staging(
                            detailed_image,
                            name=f'Detail #{len(server.staging_items)}',
                            place=(detail_meta or {}).get('place'),
                            hidden=True,
                        )

                        # 更新 pipeline（保留 model/vae/latent 等流转状态）
                        self._current_pipeline = next_pipeline

                        # Enable Output（Preprocess 的开关，现在住在图里的黑板节点上；旧格式存在
                        # 生效链第一个 detailer 的 params —— 黑板缺 key 时回落到那里）。落不落盘
                        # 只看这一颗开关：整幅 Run 与一趟图层 Generate 都走这条，不分流。
                        # 必须排在下面剥离 program 项之前 —— 那时 selected_* 还是这次的真值。
                        _board_eo = next((n.get('params') or {} for n in (run_graph or {}).get('nodes') or []
                                          if isinstance(n, dict) and n.get('kind') == 'board'), {})
                        first_d = next((b for b in blocks
                                        if isinstance(b, dict) and b.get('type') == 'detailer'), None)
                        _first_dp = (first_d.get('params', first_d) or {}) if first_d is not None else {}
                        if bool(_board_eo.get('enable_output', _first_dp.get('enable_output', False))):
                            self._save_run_output_png(server, detailed_image)

                        # 清理 prompt 中的 program-sourced 项（parsing tag 保留，在 tag 阶段转换）
                        if server.prompt_server:
                            server.prompt_server.selected_prompts = [
                                p for p in (server.prompt_server.selected_prompts or [])
                                if not (isinstance(p, dict) and p.get('source', 'normal') == 'program')
                            ]
                            # 先保存完整的 program 处理后的结果（含 program 来源项），用于预览/快照，
                            # 再剥离 program 项用于实际生成。
                            full_loras = list(server.prompt_server.selected_loras) if isinstance(server.prompt_server.selected_loras, list) else []
                            full_prefabs = list(server.prompt_server.selected_prefabs) if isinstance(server.prompt_server.selected_prefabs, list) else []
                            server.prompt_server.selected_loras = [
                                l for l in full_loras
                                if l.get('source', 'normal') != 'program'
                            ]
                            server.prompt_server.selected_prefabs = [
                                p for p in full_prefabs
                                if p.get('source', 'normal') != 'program'
                            ]
                            server.prompt_server.last_selected = [
                                p['text'] if isinstance(p, dict) else p
                                for p in server.prompt_server.selected_prompts
                                if (p.get('source', 'normal') if isinstance(p, dict) else 'normal') != 'program'
                            ]
                            # 快照/预览使用完整结果（保留 program 添加/修改的 lora 与 prefab）
                            server.prompt_server.last_selected_loras = full_loras
                            server.prompt_server.last_selected_prefabs = full_prefabs
                            server.prompt_server.custom_prompts = ''

                    except mm.InterruptProcessingException:
                        # Cancel 按钮（/api/cancel_run）触发的打断。InterruptProcessingException
                        # 继承 BaseException，下面的 except Exception 接不住——不接的话它会
                        # 炸穿整个节点（server 一起被停掉）。这里转成干净的「已取消」。
                        print("[SnapshotDetailerSampler] Run cancelled by user")
                        server.detail_status = 'cancelled'
                        server.detail_error = None
                        dbg.record_stage('Run 已取消', 'cancelled by user (interrupt)')
                    except Exception as e:
                        # Check if this is a ComfyUI interrupt
                        if mm.processing_interrupted() or "interrupt" in str(e).lower() or "processing" in str(e).lower():
                            print("[SnapshotDetailerSampler] Interrupted during detailer")
                            break
                        import traceback
                        traceback.print_exc()
                        server.detail_status = 'error'
                        server.detail_error = str(e)
                        dbg.record_error('run_detailer 异常', str(e), where='run_detailer')
                    finally:
                        comfy.utils.set_progress_bar_global_hook(orig_hook)
                        server.detail_progress = 1.0 if server.detail_status == 'done' else server.detail_progress
                        dbg.record_stage('Run 结束', f"status={server.detail_status}"
                                         + (f", error={server.detail_error}" if server.detail_error else ''))
                        _tr = dbg.current_trace()
                        if _tr is not None:
                            _tr.meta['status'] = server.detail_status
                            _tr.meta['error'] = server.detail_error
                        # 本次 run 的 blend 输入已消费完，释放引用
                        server.blend_image = None
                        server.blend_mask = None
                        server.blend_prompt = ''

                    gc.collect()
                    mm.soft_empty_cache()

                if act == 'select_image':
                    # 设为 pipeline 当前图（工作台右键/宿主入口均可触发）
                    key = action.get('key', '')
                    img = server.get_staging_image(key)
                    if img is not None:
                        self._switch_image(server, img)
                        print(f"[SnapshotDetailerSampler] Pipeline image set from staging: {key}")

                if act == 'execute_interface':
                    interface_idx = action.get('interface_index', 0)
                    manual_values = action.get('manual_values', {})
                    exec_options = action.get('exec_options', {})
                    server.interface_status = 'running'
                    server.interface_error = None
                    server.interface_progress = 0
                    server.interface_current_step = 0
                    server.interface_total_steps = 0
                    try:
                        self._execute_interface(server, interface_idx, manual_values, exec_options)
                        server.interface_status = 'done'
                        server.interface_progress = 1.0
                    except mm.InterruptProcessingException:
                        # Cancel 打断（同 run_detailer 的处理）：转成干净的取消，
                        # 不让异常炸穿节点。回 idle 让 Execute 按钮恢复可点。
                        print("[SnapshotDetailerSampler] Interface run cancelled by user")
                        server.interface_status = 'idle'
                        server.interface_error = None
                    except Exception as e:
                        if mm.processing_interrupted() or "interrupt" in str(e).lower() or "processing" in str(e).lower():
                            print("[SnapshotDetailerSampler] Interrupted during interface execution")
                            break
                        import traceback
                        traceback.print_exc()
                        server.interface_status = 'error'
                        server.interface_error = str(e)
                    finally:
                        gc.collect()
                        mm.soft_empty_cache()

                if act == 'preset_video':
                    # 视频模式的 Pipeline Preset：一段一趟（宿主按段发）。逐帧过链 + 编码，
                    # 产出 URL 写进 preset_video_meta，宿主轮询到 done 后按段落位。
                    server.preset_video_status = 'running'
                    server.preset_video_error = None
                    server.preset_video_progress = 0
                    server.preset_video_current = 0
                    server.preset_video_total = 0
                    server.preset_video_meta = []
                    dbg.begin_trace({
                        'from_blend': False,
                        'action': 'preset_video',
                        'preset_id': action.get('preset_id'),
                    })
                    try:
                        self._run_preset_video(server, action, seed=seed)
                        server.preset_video_status = 'done'
                        server.preset_video_progress = 1.0
                    except mm.InterruptProcessingException:
                        print("[SnapshotDetailerSampler] Preset video run cancelled by user")
                        server.preset_video_status = 'idle'
                        server.preset_video_error = None
                    except Exception as e:
                        if mm.processing_interrupted() or "interrupt" in str(e).lower():
                            print("[SnapshotDetailerSampler] Interrupted during preset video run")
                            break
                        import traceback
                        traceback.print_exc()
                        server.preset_video_status = 'error'
                        server.preset_video_error = str(e)
                        dbg.record_error('preset 视频跑异常', str(e), where='_run_preset_video')
                    finally:
                        _tr = dbg.current_trace()
                        if _tr is not None:
                            _tr.meta['status'] = server.preset_video_status
                            _tr.meta['error'] = server.preset_video_error
                        gc.collect()
                        mm.soft_empty_cache()

        finally:
            print("[SnapshotDetailerSampler] Stopping servers...")
            server.stop()
            print("[SnapshotDetailerSampler] Servers stopped.")

        # 如果是因 interrupt 而 break 出循环，抛 ComfyUI 的干净取消异常通知它 ——
        # 裸 RuntimeError 会被执行框架当真正的故障渲染成红色 traceback，
        # InterruptProcessingException 才是 Cancel 按钮同款的"已取消"。
        if mm.processing_interrupted():
            raise mm.InterruptProcessingException()

        if server.window_closed and not server.finished:
            raise RuntimeError("[SnapshotDetailerSampler] Window closed without finishing")

        # 如果用户在 finish 时选了工作区图片，用它作为最终输出
        # 先清空已有的 image 和 latent，再追加选中的图片
        if server.finish_selected_keys and len(server.finish_selected_keys) > 0:
            selected_images = []
            for key in server.finish_selected_keys:
                img = server.get_staging_image(key)
                if img is not None:
                    selected_images.append(img)
            if selected_images:
                self._current_pipeline.image = selected_images if len(selected_images) > 1 else selected_images[0]
            self._current_pipeline.latent = None

        result = self._current_pipeline
        self._current_pipeline = None
        return (result,)
