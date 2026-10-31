# ── 公共时间基准（后端半边）──────────────────────────────────────────────────────────────────
#
# 整个插件里只有这一处**产生**时间，其余地方（HTTP、前端单例、每一扇 MIDI 窗）都只是读数。
#
# 权威有两级：
#   1. `client/kolid_clock/KolidClock.dll` —— 原生实现，QPC 单调计数 + 传输锚点，见那边的注释；
#   2. 找不到 DLL（没编译、或部署包里没带）时，这里用 kernel32 的 QPC 现场做一个**同语义**的
#      替身。两者对外暴露的东西一模一样，`snapshot()['source']` 会说清当前是谁在答。
#      这条回退不是敷衍：DLL 只负责把"公共"这件事钉在一个宿主上，而 QPC 的精度本来就是它给的，
#      Python 版一样是 QPC，唯一差别是多一层解释器调用（微秒级，传输位置根本看不出来）。
#
# 为什么不让前端直接用 performance.now()：那个钟是**页面**的，不是**系统**的 —— 页面切到后台、
# 被别的标签抢了核，rAF 与定时器都会被节流，而 external MIDI 输出用的是系统时间戳。两边一旦
# 不同源，界面上的播放头就会和听感错开，而且错多少每次都不一样。所以时间必须以系统 QPC 为源，
# 页面只做"对齐 + 插值"（见 ui/sampler_node/src/midi/clock.ts）。
#
# 这个模块**不 import comfy**，可以单独跑（tests 里有冒烟用例）。
# ────────────────────────────────────────────────────────────────────────────────────────────

from __future__ import annotations

import ctypes
import ctypes.wintypes as _wt
import os
import sys
import threading
import time
from typing import Optional


# ── DLL 定位 ─────────────────────────────────────────────────────────────────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))


def _dll_candidates():
    env = os.environ.get('KOLID_CLOCK_DLL')
    if env:
        yield env
    yield os.path.join(_ROOT, 'client', 'kolid_clock', 'KolidClock.dll')
    yield os.path.join(_HERE, 'KolidClock.dll')
    yield os.path.join(_HERE, 'native', 'KolidClock.dll')


def _load_dll():
    for path in _dll_candidates():
        if not path or not os.path.exists(path):
            continue
        try:
            lib = ctypes.CDLL(path)
            lib.kc_version.restype = ctypes.c_int
            lib.kc_init.restype = ctypes.c_int
            lib.kc_init.argtypes = []
            lib.kc_sample_rate.restype = ctypes.c_int
            lib.kc_sample_rate.argtypes = []
            lib.kc_set_sample_rate.restype = ctypes.c_int
            lib.kc_set_sample_rate.argtypes = [ctypes.c_int]
            lib.kc_frames.restype = ctypes.c_longlong
            lib.kc_frames.argtypes = []
            lib.kc_playing.restype = ctypes.c_int
            lib.kc_playing.argtypes = []
            lib.kc_play.restype = None
            lib.kc_play.argtypes = []
            lib.kc_pause.restype = None
            lib.kc_pause.argtypes = []
            lib.kc_seek_frames.restype = None
            lib.kc_seek_frames.argtypes = [ctypes.c_longlong]
            lib.kc_anchor.restype = None
            lib.kc_anchor.argtypes = [ctypes.c_longlong]
            lib.kc_set_speed.restype = ctypes.c_int
            lib.kc_set_speed.argtypes = [ctypes.c_double]
            lib.kc_speed_get.restype = ctypes.c_double
            lib.kc_speed_get.argtypes = []
            lib.kc_snapshot.restype = ctypes.c_int
            lib.kc_snapshot.argtypes = [ctypes.POINTER(ctypes.c_longlong), ctypes.POINTER(ctypes.c_int),
                                        ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_double),
                                        ctypes.POINTER(ctypes.c_longlong)]
            if lib.kc_init() != 1:
                continue
            return lib, path
        except Exception:
            continue
    return None, None


# ── 回退：与 DLL 同语义的 Python 版 ──────────────────────────────────────────────────────────
_k32 = ctypes.windll.kernel32


class _PyTransport:
    """和 kolid_clock.c 里那份实现逐条对应：锚点 (qpc, frames) + 采样率 + 倍速。"""

    def __init__(self):
        self._lock = threading.Lock()
        f = ctypes.c_longlong()
        _k32.QueryPerformanceFrequency(ctypes.byref(f))
        self.freq = int(f.value) or 1
        self.rate = 48000
        self.speed = 1.0
        self.playing = False
        self._qpc = self._now_qpc()
        self._frames = 0
        self.epoch = self._qpc

    def _now_qpc(self) -> int:
        v = ctypes.c_longlong()
        _k32.QueryPerformanceCounter(ctypes.byref(v))
        return int(v.value)

    def _render(self) -> int:
        if self.playing and self.speed != 0.0:
            now = self._now_qpc()
            delta = now - self._qpc
            if delta > 0:
                whole = int(delta * self.rate * self.speed / self.freq)
                if whole:
                    self._frames += whole
                    self._qpc += int(whole * self.freq / (self.rate * self.speed))
        if self._frames < 0:
            self._frames = 0
        return self._frames

    # 与 DLL 同名，桥那一层无差别调用
    def frames(self) -> int:
        with self._lock:
            return self._render()

    def play(self):
        with self._lock:
            if not self.playing:
                self._render()
                self._qpc = self._now_qpc()
                self.playing = True

    def pause(self):
        with self._lock:
            if self.playing:
                self._render()
                self.playing = False

    def seek(self, frames: int):
        with self._lock:
            self._frames = max(0, int(frames))
            self._qpc = self._now_qpc()

    def anchor(self, frames: int):
        self.seek(frames)

    def set_speed(self, speed: float):
        with self._lock:
            self._render()
            self.speed = float(speed)
            self._qpc = self._now_qpc()

    def now_seconds(self) -> float:
        return (self._now_qpc() - self.epoch) / float(self.freq)


# ── 桥 ──────────────────────────────────────────────────────────────────────────────────────
class Clock:
    """进程内唯一的那一份时间。所有读取都走 `snapshot()`。"""

    def __init__(self):
        self._lock = threading.RLock()
        lib, path = _load_dll()
        self._lib = lib
        self._path = path
        self._py: Optional[_PyTransport] = None
        if lib is None:
            self._py = _PyTransport()
        self.source = 'dll' if lib is not None else 'qpc-python'
        self.dll_path = path or ''

    # ── 读 ──
    def snapshot(self) -> dict:
        """一次给全：帧 / 采样率 / 在播 / 系统时刻 / 频率 / 后端是谁。
        `now` 是**同一个 QPC 轴上**的秒数（从 init 起算），前端拿它对表。"""
        with self._lock:
            if self._lib is not None:
                fr = ctypes.c_longlong()
                sr = ctypes.c_int()
                pl = ctypes.c_int()
                now = ctypes.c_double()
                fq = ctypes.c_longlong()
                self._lib.kc_snapshot(ctypes.byref(fr), ctypes.byref(sr), ctypes.byref(pl),
                                      ctypes.byref(now), ctypes.byref(fq))
                frames, rate, playing, seconds, freq = fr.value, sr.value, bool(pl.value), now.value, fq.value
                speed = self._lib.kc_speed_get()
            else:
                py = self._py
                frames = py.frames()
                rate = py.rate
                playing = py.playing
                seconds = py.now_seconds()
                freq = py.freq
                speed = py.speed
        return {
            'frames': int(frames),
            'rate': int(rate),
            'playing': bool(playing),
            'now': float(seconds),      # 秒（QPC 轴，从 init 起算）
            'freq': int(freq),
            'speed': float(speed),
            'source': self.source,
            # 服务器**发出这一份**的时刻（墙钟毫秒）。前端算往返时间用，不参与对齐。
            'sent_ms': time.time() * 1000.0,
        }

    # ── 写 ──
    def play(self):
        with self._lock:
            if self._lib is not None:
                self._lib.kc_play()
            else:
                self._py.play()

    def pause(self):
        with self._lock:
            if self._lib is not None:
                self._lib.kc_pause()
            else:
                self._py.pause()

    def toggle(self) -> bool:
        with self._lock:
            playing = bool(self._lib.kc_playing()) if self._lib is not None else self._py.playing
            if playing:
                self.pause()
            else:
                self.play()
            return not playing

    def seek(self, frames: int):
        frames = max(0, int(frames))
        with self._lock:
            if self._lib is not None:
                self._lib.kc_seek_frames(frames)
            else:
                self._py.seek(frames)

    def seek_seconds(self, seconds: float):
        snap = self.snapshot()
        self.seek(int(round(max(0.0, float(seconds)) * snap['rate'])))

    def set_sample_rate(self, rate: int):
        rate = int(rate)
        if not (1000 <= rate <= 768000):
            raise ValueError('sample rate out of range: %r' % rate)
        with self._lock:
            if self._lib is not None:
                if not self._lib.kc_set_sample_rate(rate):
                    raise ValueError('dll rejected sample rate %r' % rate)
            else:
                self._py.rate = rate

    def set_speed(self, speed: float):
        speed = float(speed)
        if not (-16.0 < speed < 16.0):
            raise ValueError('speed out of range: %r' % speed)
        with self._lock:
            if self._lib is not None:
                if not self._lib.kc_set_speed(speed):
                    raise ValueError('dll rejected speed %r' % speed)
            else:
                self._py.set_speed(speed)

    def apply(self, action: str, value=None) -> dict:
        """一条动作 = 一次改动。前端只发这两个词（见 ui 的 clock.ts）。"""
        if action == 'play':
            self.play()
        elif action == 'pause':
            self.pause()
        elif action == 'toggle':
            self.toggle()
        elif action == 'seek_frames':
            self.seek(int(value or 0))
        elif action == 'seek':
            self.seek_seconds(float(value or 0.0))
        elif action == 'rate':
            self.set_sample_rate(int(value or 48000))
        elif action == 'speed':
            self.set_speed(float(value if value is not None else 1.0))
        else:
            raise ValueError('unknown clock action: %r' % action)
        return self.snapshot()


_CLOCK: Optional[Clock] = None
_CLOCK_LOCK = threading.Lock()


def get_clock() -> Clock:
    global _CLOCK
    with _CLOCK_LOCK:
        if _CLOCK is None:
            _CLOCK = Clock()
        return _CLOCK


def clock_status() -> dict:
    """给自检/诊断用：不推进任何东西，只说清后端是谁。"""
    c = get_clock()
    return {'source': c.source, 'dll': c.dll_path, 'ok': True}


if __name__ == '__main__':
    # 手跑一遍：python nodes/workbench/clock_bridge.py
    c = get_clock()
    print('source =', c.source, c.dll_path)
    print('snapshot =', c.snapshot())
    c.seek(0)
    c.play()
    time.sleep(0.3)
    s = c.snapshot()
    c.pause()
    print('after 0.3s =', s['frames'], 'frames @', s['rate'], '->', round(s['frames'] / s['rate'], 3), 's')
    if abs(s['frames'] / s['rate'] - 0.3) > 0.05:
        print('FAIL: transport does not follow the wall clock')
        sys.exit(1)
    print('OK')
