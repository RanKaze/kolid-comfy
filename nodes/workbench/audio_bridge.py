# ── 原生发声引擎（后端半边）────────────────────────────────────────────────────────────────────
#
# 声音**不经过浏览器**：`client/kolid_audio/KolidAudio.dll` 自己开声卡（winmm waveOut）、
# 自己跑一条音频线程、自己合成。这个模块只做三件事：装载它、把音符表递过去、回答"现在什么状态"。
#
# 时间不由这里产生。DLL 每块问一次 `KolidClock` 的 `kc_frames()`，所以声音的位置就是界面上
# 播放头的位置 —— 两只钟的毛病在这里不会长出来（见 clock_bridge.py 顶部那段说明）。
#
# 缺 DLL 时整条链降级成 `available=False`：接口照旧回话，只是不出声。**不许抛异常**，
# 否则 ComfyUI 起不来；也**不许在 import 时开声卡**，否则每次启动都占着设备。
# ────────────────────────────────────────────────────────────────────────────────────────────

from __future__ import annotations

import ctypes
import os
import threading
from typing import List, Optional

try:                                   # 正常是包内相对导入；下面那条给 `python audio_bridge.py` 用
    from . import clock_bridge
except ImportError:                    # pragma: no cover
    import clock_bridge  # type: ignore

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))

MAX_NOTES = 8192
MAX_TRACKS = 32


class _KaTrack(ctypes.Structure):
    _fields_ = [
        ('program', ctypes.c_int32),
        ('channel', ctypes.c_int32),
        ('vel_scale', ctypes.c_float),
        ('gain', ctypes.c_float),
        ('pan', ctypes.c_float),
        ('mute', ctypes.c_int32),
        ('solo', ctypes.c_int32),
    ]


class _KaNote(ctypes.Structure):
    _fields_ = [
        ('track', ctypes.c_int32),
        ('note', ctypes.c_int32),
        ('vel', ctypes.c_int32),
        ('pad', ctypes.c_int32),
        ('start', ctypes.c_int64),
        ('len', ctypes.c_int64),
    ]


# 结构体大小是 C 那边 ctypes 对齐的契约，变了会静默读错字段 —— 启动时就说清楚。
assert ctypes.sizeof(_KaTrack) == 28, ctypes.sizeof(_KaTrack)
assert ctypes.sizeof(_KaNote) == 32, ctypes.sizeof(_KaNote)


def _dll_candidates():
    env = os.environ.get('KOLID_AUDIO_DLL')
    if env:
        yield env
    yield os.path.join(_ROOT, 'client', 'kolid_audio', 'KolidAudio.dll')
    yield os.path.join(_HERE, 'KolidAudio.dll')


def _load_dll():
    for path in _dll_candidates():
        if not path or not os.path.exists(path):
            continue
        try:
            lib = ctypes.CDLL(path)
            lib.ka_version.restype = ctypes.c_int
            lib.ka_open.argtypes = [ctypes.c_int]
            lib.ka_open.restype = ctypes.c_int
            lib.ka_close.restype = None
            lib.ka_is_open.restype = ctypes.c_int
            lib.ka_sample_rate.restype = ctypes.c_int
            lib.ka_played.restype = ctypes.c_longlong
            lib.ka_position.restype = ctypes.c_longlong
            lib.ka_peak.restype = ctypes.c_int
            lib.ka_bind_clock.argtypes = [ctypes.c_char_p]
            lib.ka_bind_clock.restype = ctypes.c_int
            lib.ka_clock_bound.restype = ctypes.c_int
            lib.ka_set_notes.argtypes = [ctypes.POINTER(_KaNote), ctypes.c_int]
            lib.ka_set_notes.restype = ctypes.c_int
            lib.ka_set_tracks.argtypes = [ctypes.POINTER(_KaTrack), ctypes.c_int]
            lib.ka_set_tracks.restype = ctypes.c_int
            lib.ka_all_notes_off.restype = None
            lib.ka_audition.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
            lib.ka_audition.restype = None
            lib.ka_debug.argtypes = [ctypes.POINTER(ctypes.c_int32), ctypes.c_int]
            lib.ka_debug.restype = ctypes.c_int
            # SFZ 是后加的：老 DLL 上没有这几个符号，缺了就当"这台机器只能合成"，
            # 不要让整个引擎因此不可用。
            try:
                lib.ka_load_sfz.argtypes = [ctypes.c_wchar_p]   # UTF-16，中文路径不会被 ANSI 代码页吃掉
                lib.ka_load_sfz.restype = ctypes.c_int
                lib.ka_unload_sfz.restype = None
                lib.ka_sfz_state.argtypes = [ctypes.POINTER(ctypes.c_int32), ctypes.c_int]
                lib.ka_sfz_state.restype = ctypes.c_int
                lib.ka_sfz_zone.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
                lib.ka_sfz_zone.restype = ctypes.c_int
                lib.ka_sfz_err.restype = ctypes.c_int
            except AttributeError:
                pass
            return lib, path
        except Exception:
            continue
    return None, None


def _f(value, default: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v != v or v in (float('inf'), float('-inf')):
        return default
    return v


def _i(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


class Engine:
    """进程内唯一的那一份声音。开设备是**显式**的（`open`），不是构造时。"""

    def __init__(self):
        self._lock = threading.RLock()
        self._lib, self._path = _load_dll()
        self.available = self._lib is not None
        self._notes: List[_KaNote] = []
        self._tracks: List[_KaTrack] = []
        self._open = False
        self._rate = 48000
        self.last_error = ''
        # 当前装载的采样乐器。`path` 为空 = 走内置合成器（那 24 个声部）。
        self._instrument = {'path': '', 'zones': 0, 'failed': 0, 'kb': 0, 'error': ''}

    # ── 生命周期 ──
    def open(self, rate: int = 0) -> dict:
        if not self.available:
            return self.status()
        with self._lock:
            if self._open:
                return self.status()
            clock = clock_bridge.get_clock()
            snap = clock.snapshot()
            want = int(rate) if rate else int(snap.get('rate') or 48000)
            if not (8000 <= want <= 192000):
                want = 48000
            err = self._lib.ka_open(want)
            if err != 0:
                self.last_error = 'waveOutOpen failed (MMRESULT=%d)' % err
                return self.status()
            # 采样率必须跟时钟一致，否则音符的帧位置全错。
            if int(snap.get('rate') or 0) != want:
                try:
                    clock.set_sample_rate(want)
                except Exception:
                    pass
            # 绑时钟：DLL 拿 kc_frames / kc_playing 的地址，之后每块自己问。
            dll_path = getattr(clock, 'dll_path', '') or ''
            bound = 0
            if dll_path and os.path.exists(dll_path):
                bound = self._lib.ka_bind_clock(dll_path.encode('utf-8'))
            self._open = True
            self._rate = want
            self.last_error = '' if bound else 'clock not bound (audio free-runs)'
            if self._tracks:
                self._push_tracks()
            if self._notes:
                self._push_notes()
            return self.status()

    def close(self) -> dict:
        with self._lock:
            if self._lib is not None and self._open:
                self._lib.ka_close()
            self._open = False
            return self.status()

    # ── 数据 ──
    def set_tracks(self, items) -> dict:
        rows: List[_KaTrack] = []
        for it in (items or [])[:MAX_TRACKS]:
            if not isinstance(it, dict):
                continue
            rows.append(_KaTrack(
                program=max(0, min(127, _i(it.get('program'), 0))),
                channel=max(0, min(15, _i(it.get('channel'), 0))),
                vel_scale=max(0.05, min(4.0, _f(it.get('velScale'), 1.0))),
                gain=max(0.0, min(2.0, _f(it.get('gain'), 1.0))),
                pan=max(0.0, min(1.0, _f(it.get('pan'), 0.5))),
                mute=1 if it.get('mute') else 0,
                solo=1 if it.get('solo') else 0,
            ))
        with self._lock:
            self._tracks = rows
            if self._open:
                self._push_tracks()
        return self.status()

    def set_notes(self, items) -> dict:
        rows: List[_KaNote] = []
        for it in (items or [])[:MAX_NOTES]:
            # 界面推的是紧凑数组 [track, note, vel, start, len]；手写调试时也认 dict。
            if isinstance(it, dict):
                t_i, n_i, v_i = it.get('track'), it.get('note'), it.get('vel')
                s_i, l_i = it.get('start'), it.get('len')
            elif isinstance(it, (list, tuple)) and len(it) >= 5:
                t_i, n_i, v_i, s_i, l_i = it[0], it[1], it[2], it[3], it[4]
            else:
                continue
            start = max(0, _i(s_i, 0))
            length = max(1, _i(l_i, 1))
            rows.append(_KaNote(
                track=max(0, _i(t_i, 0)),
                note=max(0, min(127, _i(n_i, 60))),
                vel=max(1, min(127, _i(v_i, 100))),
                pad=0,
                start=start,
                len=length,
            ))
        # DLL 假定表按 start 升序（它用二分找 seek 后的位置）。这里排一次，别让它去钳。
        rows.sort(key=lambda n: n.start)
        with self._lock:
            self._notes = rows
            if self._open:
                self._push_notes()
        return self.status()

    def _push_tracks(self):
        if not self._tracks:
            return
        arr = (_KaTrack * len(self._tracks))(*self._tracks)
        self._lib.ka_set_tracks(arr, len(self._tracks))

    def _push_notes(self):
        if not self._notes:
            self._lib.ka_set_notes(None, 0)
            return
        arr = (_KaNote * len(self._notes))(*self._notes)
        self._lib.ka_set_notes(arr, len(self._notes))

    def audition(self, note: int, vel: int = 100, track: int = 0) -> dict:
        with self._lock:
            if self._open:
                self._lib.ka_audition(int(note), int(vel), int(track))
        return {'ok': True}

    def panic(self) -> dict:
        with self._lock:
            if self._open:
                self._lib.ka_all_notes_off()
        return self.status()

    # ── 采样乐器（SFZ）──
    def load_instrument(self, path: str) -> dict:
        """装载一个 .sfz。返回 zone 数；失败时 `error` 说清卡在哪一步，不静默。"""
        path = str(path or '')
        if not path:
            return {'ok': False, 'error': 'no path'}
        if not self.available or not hasattr(self._lib, 'ka_load_sfz'):
            return {'ok': False, 'error': 'this build has no SFZ loader'}
        full = os.path.abspath(path)
        if not os.path.isfile(full):
            return {'ok': False, 'error': 'no such file: %s' % full}
        with self._lock:
            n = int(self._lib.ka_load_sfz(full))
            if n <= 0:
                code = int(self._lib.ka_sfz_err()) if hasattr(self._lib, 'ka_sfz_err') else 0
                reason = {
                    -1: 'could not read the .sfz',
                    -2: 'no <region> in this .sfz',
                    -3: 'no sample could be decoded (err=%d)' % code,
                }.get(n, 'load failed (%d)' % n)
                self._instrument = {'path': full, 'zones': 0, 'failed': 0, 'kb': 0, 'error': reason}
                return dict(self._instrument, ok=False)
            st = (ctypes.c_int32 * 3)()
            self._lib.ka_sfz_state(st, 3)
            self._instrument = {
                'path': full, 'zones': int(st[0]), 'failed': int(st[1]),
                'kb': int(st[2]), 'error': '',
            }
            return dict(self._instrument, ok=True)

    def unload_instrument(self) -> dict:
        with self._lock:
            if self.available and hasattr(self._lib, 'ka_unload_sfz'):
                # 先掐掉发声再卸 —— 声部里存的是 zone 指针，卸完再停会读空。
                self._lib.ka_all_notes_off()
                self._lib.ka_unload_sfz()
            self._instrument = {'path': '', 'zones': 0, 'failed': 0, 'kb': 0, 'error': ''}
        return self.status()

    def instrument_zones(self, limit: int = 200) -> dict:
        """诊断：当前乐器前 N 个 zone 的说明行。界面暂时不用，排障时直接 curl。"""
        rows = []
        if self.available and hasattr(self._lib, 'ka_sfz_zone') and self._instrument['zones']:
            buf = ctypes.create_string_buffer(512)
            for i in range(min(limit, self._instrument['zones'])):
                if self._lib.ka_sfz_zone(i, buf, 512) > 0:
                    rows.append(buf.value.decode('utf-8', 'replace'))
        return {'zones': rows, 'count': len(rows)}

    # ── 状态 ──
    def status(self) -> dict:
        out = {
            'available': self.available,
            'open': self._open,
            'rate': self._rate,
            'dll': self._path or '',
            'clockBound': False,
            'notes': len(self._notes),
            'tracks': len(self._tracks),
            'played': -1,
            'position': -1,
            'peak': 0,
            'error': self.last_error,
            'instrument': dict(self._instrument),
        }
        if self.available and self._open:
            with self._lock:
                out['clockBound'] = bool(self._lib.ka_clock_bound())
                out['played'] = int(self._lib.ka_played())
                out['position'] = int(self._lib.ka_position())
                out['peak'] = int(self._lib.ka_peak())
                buf = (ctypes.c_int32 * 8)()
                self._lib.ka_debug(buf, 8)
                out['voices'] = int(buf[5])
                out['seeks'] = int(buf[6])
                out['writeError'] = int(buf[2])
        return out

    def apply(self, op: str, payload: dict) -> dict:
        op = str(op or '')
        payload = payload or {}
        if op == 'open':
            return self.open(_i(payload.get('rate'), 0))
        if op == 'close':
            return self.close()
        if op == 'tracks':
            return self.set_tracks(payload.get('tracks'))
        if op == 'notes':
            return self.set_notes(payload.get('notes'))
        if op == 'audition':
            return self.audition(_i(payload.get('note'), 60), _i(payload.get('vel'), 100),
                                 _i(payload.get('track'), 0))
        if op == 'panic':
            return self.panic()
        if op == 'load_sfz':
            return self.load_instrument(payload.get('path') or payload.get('sfz') or '')
        if op == 'unload_sfz':
            return self.unload_instrument()
        if op == 'status':
            return self.status()
        raise ValueError('unknown audio op: %r' % op)


_ENGINE: Optional[Engine] = None
_ENGINE_LOCK = threading.Lock()


def get_engine() -> Engine:
    global _ENGINE
    with _ENGINE_LOCK:
        if _ENGINE is None:
            _ENGINE = Engine()
        return _ENGINE


if __name__ == '__main__':
    # 手跑一遍：python nodes/workbench/audio_bridge.py
    import time

    e = get_engine()
    print('available =', e.available, e._path)
    c = clock_bridge.get_clock()
    c.seek(0)
    e.open()
    print('opened =', e.status())
    e.set_tracks([{'program': 0, 'channel': 0, 'velScale': 1.0},
                  {'program': 0, 'channel': 9, 'velScale': 1.0}])
    notes = []
    for i in range(8):
        notes.append({'track': 0, 'note': 60 + i * 2, 'vel': 100,
                      'start': int(i * 0.25 * 48000), 'len': int(0.22 * 48000)})
    e.set_notes(notes)
    c.play()
    time.sleep(0.6)
    print('playing =', e.status())
    c.pause()
    time.sleep(0.15)
    print('paused =', e.status())
    e.close()
