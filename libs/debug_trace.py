"""Run Debug Trace —— 「上一次 Run / Generate 到底发生了什么」的快照收集器。

Draw tab 的 Context 标题右侧那个 Debug 按钮读的就是它：每一次 detailer run
（普通 Run Detailer，或 Blend 工作台里的 Generate / ▶ preset）开始时新建一份
trace，链条每走一步就往里追加一条记录，run 结束后封存。``/api/debug_trace``
把这个快照序列化下发（过程图 / 遮罩 = base64 data URL）。

设计约束
--------
- **只保留最近一次 run**：``begin_trace()`` 直接丢弃上一份。收集期间不会让内存
  无限增长，run 时长 = 快照寿命。
- **绝不因为埋点炸掉整条链**：所有公开方法都吞异常并打印一行警告。debug 是观测
  工具，不是产品功能的一部分。
- **图像惰性编码**：调用方可以直接塞 tensor，模块在 ``snapshot()`` 时统一转
  base64。这样埋点处只多一次引用赋值，run 期间的开销可以忽略。
- **prompt 不用截断**：debug 的价值就在于看到完整文本，只在序列化时给前端的
  展示做折叠（前端负责）。

记录模型
--------
一份 trace = ``{'meta': {...}, 'steps': [entry, ...]}``，entry 是：

    {
      'kind': 'stage' | 'prompt' | 'image' | 'mask' | 'block' | 'error',
      'label': '人类可读的标题',
      'detail': '一行补充说明（可选）',
      'block': 1,                 # 属于哪个 block（0 = 链外/全局），可选
      'data': {...},              # 结构化字段（prompt / loras / shape / 参数…）
      'items': [ {label, dataUrl, width, height} ],   # 图像类 entry 的缩略图
    }
"""

from __future__ import annotations

import traceback

__all__ = [
    'DebugTrace',
    'begin_trace',
    'current_trace',
    'clear_trace',
    'record_stage',
    'record_prompt',
    'record_prompt_stages',
    'record_image',
    'record_mask',
    'record_block',
    'record_error',
    'debug_trace_snapshot',
    'has_debug_trace',
]

# 单份 trace 的过程图上限 —— 防止某个病态工作流（几十个 block × 多张中间图）
# 把 base64 撑到几百 MB。超出后新的图被丢弃并记一条说明。
MAX_IMAGES_PER_TRACE = 240
# 单张图的像素上限。超过就等比缩小再编码，避免大图 base64 吃掉几百 KB。
MAX_IMAGE_PIXELS = 1024 * 1024


def _shrink(image_tensor, max_pixels=MAX_IMAGE_PIXELS):
    """把 [B,H,W,C] / [H,W,C] / [B,H,W] / [H,W] 归一成 [1,H,W,C] 并限制像素总量。

    返回 ``(tensor, note)``，note 是被缩放时的说明（否则空串）。
    """
    import torch

    t = image_tensor
    if t is None:
        return None, ''
    if not isinstance(t, torch.Tensor):
        try:
            t = torch.as_tensor(t)
        except Exception:
            return None, ''
    if t.dim() == 2:
        t = t.unsqueeze(0).unsqueeze(-1)          # [H,W] -> [1,H,W,1]
    elif t.dim() == 3:
        # [H,W,C] 或 [B,H,W] —— 用最后一个维度是否像通道来区分
        if t.shape[-1] in (1, 3, 4):
            t = t.unsqueeze(0)                    # [1,H,W,C]
        else:
            t = t.unsqueeze(-1)                   # [1,H,W,1]
    elif t.dim() == 4:
        pass
    else:
        return None, ''
    if t.shape[-1] not in (1, 3, 4):
        t = t[..., :1]
    if t.shape[-1] == 1:
        t = t.repeat(1, 1, 1, 3)                  # mask 类单通道 → 灰度 RGB
    note = ''
    try:
        h, w = int(t.shape[1]), int(t.shape[2])
        if h * w > max_pixels:
            import torch.nn.functional as F
            import math
            scale = math.sqrt(max_pixels / float(h * w))
            nh = max(1, int(round(h * scale)))
            nw = max(1, int(round(w * scale)))
            src = t.permute(0, 3, 1, 2)
            t = F.interpolate(src.float(), size=(nh, nw), mode='bilinear', align_corners=False)
            t = t.permute(0, 2, 3, 1)
            note = f'{w}x{h} 缩放到 {nw}x{nh}'
    except Exception:
        pass
    return t.float().clamp(0, 1), note


class DebugTrace:
    """一次 run 的快照。线程安全靠「单 run 单写」的既有约定（主循环串行）。"""

    def __init__(self, meta=None):
        self.meta = dict(meta or {})
        self.steps = []
        self.image_count = 0
        self.truncated = False

    # ------------------------------------------------------------------
    # 写入
    # ------------------------------------------------------------------
    def _add(self, entry):
        try:
            self.steps.append(entry)
        except Exception:
            pass

    def stage(self, label, detail='', block=None, **data):
        self._add({
            'kind': 'stage',
            'label': str(label),
            'detail': str(detail or ''),
            'block': block,
            'data': dict(data) if data else {},
        })
        return self

    def prompt(self, label, text, block=None, **data):
        payload = {'text': '' if text is None else str(text),
                   'chars': len(str(text or ''))}
        payload.update(data)
        self._add({
            'kind': 'prompt',
            'label': str(label),
            'detail': '',
            'block': block,
            'data': payload,
        })
        return self

    def add_image(self, label, image_tensor, detail='', block=None,
                  minify=True, **data):
        """记录一张过程图。image_tensor 为 None 时静默跳过。"""
        if image_tensor is None:
            return self
        if self.image_count >= MAX_IMAGES_PER_TRACE:
            if not self.truncated:
                self.truncated = True
                self._add({
                    'kind': 'stage',
                    'label': '过程图数量已达上限',
                    'detail': f'最多保留 {MAX_IMAGES_PER_TRACE} 张，后续的图被丢弃',
                    'block': None,
                    'data': {},
                })
            return self
        try:
            import io
            import base64
            from PIL import Image

            t, note = _shrink(image_tensor) if minify else (image_tensor, '')
            if t is None:
                return self
            arr = t.squeeze(0).cpu().numpy()
            if arr.ndim == 3 and arr.shape[-1] == 1:
                arr = arr[..., 0]
            arr = (arr * 255).clip(0, 255).astype('uint8')
            if arr.ndim == 3 and arr.shape[-1] == 3:
                buf = io.BytesIO()
                Image.fromarray(arr).save(buf, format='JPEG', quality=85)
                data_url = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode('utf-8')
            elif arr.ndim == 3 and arr.shape[-1] == 4:
                buf = io.BytesIO()
                Image.fromarray(arr, mode='RGBA').save(buf, format='PNG')
                data_url = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('utf-8')
            else:
                buf = io.BytesIO()
                Image.fromarray(arr).save(buf, format='PNG')
                data_url = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('utf-8')
            h = int(arr.shape[0])
            w = int(arr.shape[1]) if arr.ndim >= 2 else 1
            item = {
                'label': str(label),
                'dataUrl': data_url,
                'width': w,
                'height': h,
                'note': note or str(detail or ''),
            }
            payload = dict(data)
            if detail and not note:
                payload['shape'] = f'{w}x{h}'
            self._add({
                'kind': 'image',
                'label': str(label),
                'detail': str(detail or ''),
                'block': block,
                'data': payload,
                'items': [item],
            })
            self.image_count += 1
        except Exception as e:
            print(f'[DebugTrace] image encode failed for "{label}": {e}')
        return self

    def add_mask(self, label, mask_tensor, detail='', block=None, **data):
        """记录一张遮罩。mask 可能是 [B,H,W] / [H,W] / 已有 3 通道的图。"""
        if mask_tensor is None:
            return self
        try:
            t = mask_tensor
            if hasattr(t, 'dim') and t.dim() == 3 and t.shape[0] == 1:
                t = t.squeeze(0)
            if hasattr(t, 'dim') and t.dim() == 2:
                t = t.unsqueeze(-1)
            self.add_image(label, t, detail=detail, block=block, **data)
        except Exception as e:
            print(f'[DebugTrace] mask encode failed for "{label}": {e}')
        return self

    def block(self, index, label, detail='', **data):
        self._add({
            'kind': 'block',
            'label': str(label),
            'detail': str(detail or ''),
            'block': index,
            'data': dict(data) if data else {},
        })
        return self

    def error(self, label, err, block=None, where=''):
        self._add({
            'kind': 'error',
            'label': str(label),
            'detail': str(err),
            'block': block,
            'data': {'where': str(where or '')},
        })
        return self

    # ------------------------------------------------------------------
    # 读出
    # ------------------------------------------------------------------
    def snapshot(self):
        return {
            'generated_at': self.meta.get('generated_at'),
            'meta': dict(self.meta),
            'steps': list(self.steps),
            'image_count': self.image_count,
            'truncated': self.truncated,
        }


# ======================================================================
# 模块级单例 —— 与「最近一次 run」的生命周期绑定的线程局部状态。
# 主循环串行处理 action，所以一把全局锁 + 一个当前 trace 足够。
# ======================================================================
_current = None


def begin_trace(meta=None):
    """开一份新 trace，丢弃上一份。返回新 trace。"""
    global _current
    try:
        _current = DebugTrace(meta)
    except Exception as e:
        print(f'[DebugTrace] begin failed: {e}')
        _current = None
    return _current


def current_trace():
    return _current


def clear_trace():
    global _current
    _current = None


def has_debug_trace():
    return _current is not None and bool(_current.steps)


def _with_trace(fn, *args, **kwargs):
    """所有 record_* 的统一入口：没有 trace 时静默跳过，异常绝不外泄。"""
    t = _current
    if t is None:
        return None
    try:
        return fn(t, *args, **kwargs)
    except Exception:
        print('[DebugTrace] record failed:')
        traceback.print_exc()
        return None


def record_stage(label, detail='', block=None, **data):
    return _with_trace(DebugTrace.stage, label, detail, block, **data)


def record_prompt(label, text, block=None, **data):
    return _with_trace(DebugTrace.prompt, label, text, block, **data)


def record_image(label, image_tensor, detail='', block=None, **data):
    return _with_trace(DebugTrace.add_image, label, image_tensor, detail, block, **data)


def record_mask(label, mask_tensor, detail='', block=None, **data):
    return _with_trace(DebugTrace.add_mask, label, mask_tensor, detail, block, **data)


def record_block(index, label, detail='', **data):
    return _with_trace(DebugTrace.block, index, label, detail, **data)


def record_error(label, err, block=None, where=''):
    return _with_trace(DebugTrace.error, label, err, block, where)


def record_prompt_stages(stages, block=None, prefix=''):
    """把一组 ``[(label, text), ...]`` 依次记成 prompt entry（快捷方式）。

    埋点处通常成串地产生 prompt 快照（解析 → 追加 extra → 每块拼接 …），
    这个帮手避免在链条里堆一列 record_prompt 调用。
    """
    for label, text in stages or []:
        record_prompt(f'{prefix}{label}', text, block=block)


def debug_trace_snapshot():
    t = _current
    if t is None:
        return {'meta': None, 'steps': [], 'image_count': 0, 'truncated': False,
                'available': False}
    snap = t.snapshot()
    snap['available'] = True
    return snap
