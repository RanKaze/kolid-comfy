# ── 原生发声引擎（后端半边）────────────────────────────────────────────────────────────────────
#
# 声音**不经过浏览器**：`client/kolid_audio/KolidAudio.dll` 自己开声卡（winmm waveOut）、
# 自己跑一条音频线程、自己合成。这个模块只做三件事：装载它、把音符表递过去、回答"现在什么状态"。
#
# 时间不由这里产生。DLL 每块问一次 `KolidClock` 的 `kc_frames()`，所以声音的位置就是界面上
# 播放头的位置 —— 两只钟的毛病在这里不会长出来（见 clock_bridge.py 顶部那段说明）。
#
# 一件乐器两条路，**互斥**（两边吃的是同一张音符表，同时开就是两层声音叠在一起）：
#   · SFZ  → KolidAudio.dll 自己读样本（`ka_load_sfz`）；
#   · VST3 → 真插件在 `KaPluginWorker.exe` 里出声（`ka_vst3_*`，命令走共享内存）。
#     worker 在这边以 `PluginWorker` 起，插件那边崩了只是它自己死，宿主看得见"没答应"。
#     内置合成器（GM 音色兜底）**常闭**：声音只来自乐器，没装乐器的轨就安静。
#
# 缺 DLL 时整条链降级成 `available=False`：接口照旧回话，只是不出声。**不许抛异常**，
# 否则 ComfyUI 起不来；也**不许在 import 时开声卡**，否则每次启动都占着设备。
# ────────────────────────────────────────────────────────────────────────────────────────────

from __future__ import annotations

import base64
import ctypes
import os
import threading
import time
from typing import List, Optional

try:                                   # 正常是包内相对导入；下面那条给 `python audio_bridge.py` 用
    from . import clock_bridge
    from . import vst3_registry
except ImportError:                    # pragma: no cover
    import clock_bridge  # type: ignore
    import vst3_registry  # type: ignore

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))

MAX_NOTES = 8192
MAX_TRACKS = 32

# 试听音长：与内置合成器那条 0.7 秒对齐。插件那边按"渲了几块"数，所以换算成块数。
AUDITION_SECONDS = 0.7
# 时间线 PCM 的客户端协议版本。3 = 会话 + 片段 + 代际（见 _PcmBook）。旧页面不带这个字段 ——
# 它那边还有一条 WebAudio 在放同一段时间线，让它再交一份 PCM 就是双声，一律拒收。
PCM_CLIENT_ABI = 3
# 会话心跳超期：超过这么久没任何 PCM 操作，它名下的槽整批回收（关掉的窗/崩掉的页不留在引擎里）。
PCM_SESSION_TTL = 15.0
PCM_MAX_SLOTS = 64                 # 与 kolid_audio.c 的 KA_MAX_CLIPS 一致


# ── 时间线 PCM 的会话账本 ─────────────────────────────────────────────────────────────────────
# **以后任何"往引擎里送声音"的新功能都照这三条来**：
#   1. 同一时刻只有一个 owner 会话，只有 owner 的**摆放**会被接受 —— 两扇窗同时交同一段
#      PCM 就是同一段声音放两遍（切 Mute / 切 Loop 时"突然多一层"就是这么来的）。
#   2. 槽按 (会话, 片段) 认主：别人的槽看不见也拿不走；作者失联（心跳超期）或 release
#      （关窗 / 刷新）时整批回收 —— 关掉的窗不会留在引擎里继续响。
#   3. 摆放带**代际 gen**：比已应用的小就丢弃。切 Mute/Loop 会重推整份状态，乱序与重试
#      不能把旧摆放复活。
# 账本只在 Engine._lock 里读写（音频线程不碰它）。

class _PcmBook:
    def __init__(self) -> None:
        self._slots = {}        # slot -> {'sid', 'clip', 'gen'}
        self._sessions = {}     # sid -> {'seen': monotonic}
        self._owner = ''        # 唯一作者；**只由 POST /api/clock 的播放命令来定**

    def touch(self, sid: str, now: float) -> dict:
        st = self._sessions.get(sid)
        if st is None:
            st = self._sessions[sid] = {'seen': now}
        st['seen'] = now
        return st

    def sweep(self, now: float) -> list:
        dead = [sid for sid, st in self._sessions.items() if now - st['seen'] > PCM_SESSION_TTL]
        out = []
        for sid in dead:
            out.extend(self._drop_session(sid))
        return out

    def set_owner(self, sid: str, now: float) -> list:
        """把作者定成 sid（'' = 没有作者），返回**别人**的槽（调用方把它们静音，数据保留）。

        作者只由走带的播放命令来定（见 snapshot_sampler_node 的 /api/clock），所以
        "谁在出声"和"谁按了播放"是同一件事 —— 多扇窗各跑一份调度也不会互相抢。"""
        if sid:
            self.touch(sid, now)
        if sid == self._owner:
            return []
        self._owner = sid
        out = []
        for other in self._sessions:
            if other == sid:
                continue
            out.extend(s for s, e in self._slots.items() if e['sid'] == other)
        return out

    def claim(self, sid: str, now: float) -> list:
        """老客户端的主动认领：**只在还没有作者时**生效，已有作者一律不动（防多窗互抢）。"""
        self.touch(sid, now)
        if self._owner:
            return []
        return self.set_owner(sid, now)

    def owner(self) -> str:
        return self._owner

    def is_owner(self, sid: str) -> bool:
        return bool(sid) and sid == self._owner

    def slot_for(self, sid: str, clip: str) -> Optional[int]:
        slot = self.slot_of(sid, clip)
        if slot is not None:
            return slot
        for slot in range(PCM_MAX_SLOTS):
            if slot not in self._slots:
                self._slots[slot] = {'sid': sid, 'clip': clip, 'gen': 0}
                return slot
        return None

    def slot_of(self, sid: str, clip: str) -> Optional[int]:
        for slot, e in self._slots.items():
            if e['sid'] == sid and e['clip'] == clip:
                return slot
        return None

    def gen_ok(self, sid: str, clip: str, gen: int) -> bool:
        """代际闸：比这条片段已应用的旧就丢弃。gen=0 表示"不带代际"，照收。"""
        slot = self.slot_of(sid, clip)
        if slot is None:
            return False
        e = self._slots[slot]
        if gen and gen < e['gen']:
            return False
        if gen:
            e['gen'] = gen
        return True

    def drop_clip(self, sid: str, clip: str) -> Optional[int]:
        slot = self.slot_of(sid, clip)
        if slot is not None:
            self._slots.pop(slot, None)
        return slot

    def release(self, sid: str) -> list:
        out = self._drop_session(sid)
        if self._owner == sid:
            self._owner = ''
        return out

    def _drop_session(self, sid: str) -> list:
        out = [s for s, e in self._slots.items() if e['sid'] == sid]
        for s in out:
            self._slots.pop(s, None)
        self._sessions.pop(sid, None)
        if self._owner == sid:
            self._owner = ''
        return out
_WORKER_CLASS = None                  # plugin_worker.PluginWorker，首次用的时候才按路径加载

# 2b：一条 MIDI 轨 = 一支插件实例（一个 worker 进程）。槽 0..14 归轨，槽 15 是试听。
# 与 C 那边的 KA_MAX_PLUG 一致；两边对不上时 attach 会当场报 -94。
KA_MAX_PLUG = 16
PREVIEW_SLOT = 15
TRACK_SLOTS = PREVIEW_SLOT
# 工程里暂时消失的槽（关文档/删轨）先留着：大采样器的程序只活在实例里，
# 按 .vstpreset 重装回来是没有程序的（HALion）。最多留这么多个，多的按先后放掉。
PARKED_SLOTS_MAX = 3


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
            # VST3 也是后加的。**它们全都要先有 worker**（见 plugin_worker.py）——
            # 这些导出在宿主进程里只负责把命令写进共享内存，插件代码一行都不在这里跑。
            try:
                lib.ka_plug_attach.argtypes = [ctypes.c_wchar_p]
                lib.ka_plug_attach.restype = ctypes.c_int
                lib.ka_plug_ready.restype = ctypes.c_int
                lib.ka_plug_detach.restype = ctypes.c_int
                lib.ka_plug_heartbeat.restype = ctypes.c_int
                # 多实例槽（2b）。老 DLL 上没有这几个 —— 那边 _ensure_worker 会如实说"重启"。
                lib.ka_plug_attach_s.argtypes = [ctypes.c_int, ctypes.c_wchar_p]
                lib.ka_plug_attach_s.restype = ctypes.c_int
                lib.ka_plug_ready_s.argtypes = [ctypes.c_int]
                lib.ka_plug_ready_s.restype = ctypes.c_int
                lib.ka_plug_detach_s.argtypes = [ctypes.c_int]
                lib.ka_plug_detach_s.restype = ctypes.c_int
                lib.ka_plug_heartbeat_s.argtypes = [ctypes.c_int]
                lib.ka_plug_heartbeat_s.restype = ctypes.c_int
                lib.ka_plug_underruns_s.argtypes = [ctypes.c_int]
                lib.ka_plug_underruns_s.restype = ctypes.c_int
                lib.ka_plug_select.argtypes = [ctypes.c_int]
                lib.ka_plug_select.restype = ctypes.c_int
                lib.ka_vst3_bind.argtypes = [ctypes.c_int, ctypes.c_int]
                lib.ka_vst3_bind.restype = ctypes.c_int
                lib.ka_vst3_peak_s.argtypes = [ctypes.c_int]
                lib.ka_vst3_peak_s.restype = ctypes.c_int
                lib.ka_sfz_bind.argtypes = [ctypes.c_int]
                lib.ka_sfz_bind.restype = ctypes.c_int
                lib.ka_vst3_scan.argtypes = [ctypes.c_wchar_p]
                lib.ka_vst3_scan.restype = ctypes.c_int
                lib.ka_vst3_class.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
                lib.ka_vst3_class.restype = ctypes.c_int
                lib.ka_vst3_class_cid.argtypes = [ctypes.c_int, ctypes.c_char_p]
                lib.ka_vst3_class_cid.restype = ctypes.c_int
                lib.ka_vst3_open.argtypes = [ctypes.c_wchar_p, ctypes.c_int]
                lib.ka_vst3_open.restype = ctypes.c_int
                lib.ka_vst3_open_ex.argtypes = [ctypes.c_wchar_p, ctypes.c_int, ctypes.c_int]
                lib.ka_vst3_open_ex.restype = ctypes.c_int
                lib.ka_vst3_close.restype = ctypes.c_int
                lib.ka_vst3_live.argtypes = [ctypes.c_int]
                lib.ka_vst3_live.restype = ctypes.c_int
                lib.ka_vst3_state_load.argtypes = [ctypes.c_wchar_p,
                                                  ctypes.POINTER(ctypes.c_int32), ctypes.c_int]
                lib.ka_vst3_state_load.restype = ctypes.c_int
                lib.ka_vst3_state_save.argtypes = [ctypes.c_wchar_p]
                lib.ka_vst3_state_save.restype = ctypes.c_int
                lib.ka_vst3_audition.argtypes = [ctypes.c_int] * 4
                lib.ka_vst3_audition.restype = ctypes.c_int
                # 时间线音频段（PCM 片段）：旧 DLL 没有这几条 → hasattr 挡住，不整体降级。
                if hasattr(lib, 'ka_pcm_begin'):
                    lib.ka_pcm_begin.argtypes = [ctypes.c_int, ctypes.c_longlong, ctypes.c_int]
                    lib.ka_pcm_begin.restype = ctypes.c_int
                    lib.ka_pcm_write.argtypes = [ctypes.c_int, ctypes.c_longlong, ctypes.c_void_p, ctypes.c_int]
                    lib.ka_pcm_write.restype = ctypes.c_int
                    lib.ka_pcm_finish.argtypes = [ctypes.c_int]
                    lib.ka_pcm_finish.restype = ctypes.c_int
                    lib.ka_pcm_set.argtypes = [ctypes.c_int, ctypes.c_longlong, ctypes.c_longlong,
                                               ctypes.c_longlong, ctypes.c_float]
                    lib.ka_pcm_set.restype = ctypes.c_int
                    lib.ka_pcm_clear.argtypes = [ctypes.c_int]
                    lib.ka_pcm_clear.restype = ctypes.c_int
                    lib.ka_pcm_info.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_longlong)]
                    lib.ka_pcm_info.restype = ctypes.c_int
                lib.ka_vst3_notes_off.restype = ctypes.c_int
                lib.ka_vst3_note.argtypes = [ctypes.c_int] * 4
                lib.ka_vst3_note.restype = ctypes.c_int
                lib.ka_vst3_stage.argtypes = [ctypes.POINTER(ctypes.c_int)]
                lib.ka_vst3_stage.restype = ctypes.c_int
                lib.ka_vst3_info.argtypes = [ctypes.c_char_p, ctypes.c_int]
                lib.ka_vst3_info.restype = ctypes.c_int
                lib.ka_synth_off.argtypes = [ctypes.c_int]
                lib.ka_synth_off.restype = ctypes.c_int
            except AttributeError:
                pass
            return lib, path
        except Exception:
            continue
    return None, None


def _load_worker_class():
    """`client/kolid_audio/plugin_worker.py` 里的 PluginWorker。

    按路径加载而不是把 `client/kolid_audio` 塞进 sys.path：那是运行期的一个脚本目录，
    不是包；塞进去会让 `import` 在两套目录里认名字。
    """
    global _WORKER_CLASS
    if _WORKER_CLASS is not None:
        return _WORKER_CLASS
    path = os.path.join(_ROOT, 'client', 'kolid_audio', 'plugin_worker.py')
    if not os.path.isfile(path):
        return None
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location('kolid_plugin_worker', path)
        if spec is None or spec.loader is None:
            return None
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _WORKER_CLASS = getattr(mod, 'PluginWorker', None)
    except Exception:
        _WORKER_CLASS = None
    return _WORKER_CLASS


# `ka_v3_open` 的返回码（见 ka_vst3.h 顶部那段注释）与通道错误码（手写的 -91..-95）。
_PLUGIN_OPEN_REASON = {
    -1: 'the .vst3 could not be loaded (LoadLibrary failed)',
    -2: 'the plugin does not export GetPluginFactory',
    -3: 'the plugin would not create an instance',
    -4: 'the plugin initialise() failed',
    -5: 'the plugin is not an audio processor',
    -6: 'the plugin does not process 32-bit float audio',
    -7: 'the host could not allocate the audio buffers',
    -8: 'setupProcessing failed',
    -91: 'the plugin worker is not attached',
    -92: 'the plugin worker stopped answering (it may have crashed)',
    -93: 'the plugin worker timed out',
    -94: 'the shared-memory channel has the wrong shape',
    -95: 'the plugin worker was busy with another command',
}


def _plugin_reason(rc: int, stage: int = 0) -> str:
    text = _PLUGIN_OPEN_REASON.get(int(rc), 'open failed (rc=%d)' % int(rc))
    if stage:
        text += ' · step %d' % int(stage)
    return text


# 编辑器这道门的错误码：主线程那几个（-5..-21）是**通道**，-100 以下是 UI 线程把
# view 造起来时插件自己的回答（ka_v3_view_create 的 rc - 100）。
_EDITOR_REASON = {
    -5: 'the plugin is not open',
    -11: 'the editor thread could not start (no events)',
    -12: 'the editor thread could not start',
    -13: 'the editor thread did not come up in time',
    -14: 'the editor window host is missing',
    -20: 'the editor request could not be posted',
    -21: 'the plugin took too long to build its window',
    -7: 'the editor window could not be created',
    -8: 'the plugin refused the window (attached() failed)',
    -100: 'the plugin window reported no result',
    -101: 'the plugin has no controller to take a window from',
    -102: 'the plugin does not offer an editor view',
    -103: 'the plugin cannot host itself in a Windows window',
}


def _editor_reason(rc: int) -> str:
    return _EDITOR_REASON.get(int(rc), 'the plugin editor did not open (rc=%d)' % int(rc))


# VST3 允许控制器那两处 setState 回 E_NOTIMPL（"我这儿没有要同步的"），Ample 系就是这么答的。
_E_NOTIMPL = -2147467263  # 0x80004001


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
        # 每条轨的界面身份与乐器。音符表只认下标，身份与乐器只在这边用：
        #   `_track_ids`   = 轨 id（前端 model 的 MidiTrack.id），槽按它认主，挪位置不用重装；
        #   `_track_files` = 这条轨要的乐器（绝对路径，'' = 内置合成器）。
        self._track_ids: List[str] = []
        self._track_files: List[str] = []
        self._open = False
        self._rate = 48000
        self.last_error = ''
        # 2b：一个槽 = 一支插件实例（见 C 那边 g_plugs[]）。槽 0..14 归轨，15 是试听。
        # 每格：{'worker': PluginWorker|None, 'track': 轨 id|None, 'want': 乐器路径, 'st': {...}}
        self._slots: List[Optional[dict]] = [None] * KA_MAX_PLUG
        # SFZ 是进程内的采样引擎（AB 双槽），全机器只有一套采样内存 —— 所以它也只能绑一条轨。
        self._sfz = {'path': '', 'slot': None, 'zones': 0, 'failed': 0, 'kb': 0, 'error': ''}
        # `open()` 里也会调一次对账；那道闸只防重入，不改变"最终都会对上"。
        self._reconciling = False
        # 时间线 PCM 的会话账本（谁在出声、每段落在哪个槽、推到第几代）。
        self._pcm = _PcmBook()

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
            # 声音只来自乐器：内置合成器常闭，没装乐器的轨就安静。
            # 这根闸只挡合成器那半截，SFZ 采样 / VST3 槽 / 试听槽都不受影响（见 ka_trigger）。
            if hasattr(self._lib, 'ka_synth_off'):
                self._lib.ka_synth_off(1)
            if self._tracks:
                self._push_tracks()
            if self._notes:
                self._push_notes()
            self._reconcile()
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
        ids: List[str] = []
        files: List[str] = []
        for i, it in enumerate((items or [])[:MAX_TRACKS]):
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
            # id 是槽认主的凭据。老调用方（探针）不带它 —— 用下标当 id，行为与从前一致。
            ids.append(str(it.get('id') or ('t%d' % i)))
            files.append(str(it.get('instrument') or ''))
        with self._lock:
            self._tracks = rows
            self._track_ids = ids
            self._track_files = files
            if self._open:
                self._push_tracks()
            # 工程换了（读档 / 加轨 / 卸载）→ 让槽跟上。装过的不会再装一次。
            self._reconcile()
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
        """试听**这条轨上那件乐器**。停了也出声（插件与合成器本来就都这么实现）。

        找不到那条轨的实例时落到内置合成器 / SFZ —— 不借用试听槽：
        试听槽里放的可能是另一件乐器，借来响就是在骗人（"我明明点了这条轨"）。
        试听一件**还没进工程**的乐器走 `preview()`，那是另一件事。"""
        with self._lock:
            if not self._open:
                return {'ok': True, 'via': 'none'}
            slot = self._slot_of_track_index(track)
            if slot is not None and self._slot_open(slot) and self._slots[slot]['kind'] == 'vst3':
                blocks = max(1, int(round(AUDITION_SECONDS * self._rate / 512)))
                self._select(slot)
                rc = int(self._lib.ka_vst3_audition(int(note), int(vel), 0, blocks))
                return {'ok': rc >= 0, 'via': 'plugin', 'slot': slot, 'channel': 0,
                        'blocks': blocks, 'rc': rc}
            if self._sfz_on_index(track):
                self._lib.ka_audition(int(note), int(vel), int(track))
                return {'ok': True, 'via': 'sfz'}
            # 没装乐器就不再出声（内置合成器常闭）—— 报 'none'，别让界面以为它响了。
            return {'ok': True, 'via': 'none'}

    # ── 时间线音频段（PCM）：会话 + 片段 + 代际（见 _PcmBook 顶部三条不变量）─────────────
    def _pcm_sweep_locked(self) -> None:
        for slot in self._pcm.sweep(time.monotonic()):
            self._lib.ka_pcm_clear(slot)

    def pcm_set_owner(self, sid: str) -> dict:
        """走带的播放命令就是音频作者（`POST /api/clock` 调这里）。`sid = ''` = 没有作者，
        连同所有摆放一起静音（旧页面按播放时不带会话，它那边另外有一条 WebAudio，不该再叠引擎）。"""
        with self._lock:
            if not self.available:
                return {'ok': False}
            self._pcm_sweep_locked()
            others = self._pcm.set_owner(sid, time.monotonic())
            for slot in others:
                self._lib.ka_pcm_set(slot, 0, 0, 0, 0.0)
            return {'ok': True, 'deactivated': len(others), 'owner': sid}

    def pcm_claim(self, sid: str) -> dict:
        """老客户端的主动认领：只在**还没有作者**时生效（作者由播放命令定，见上）。"""
        with self._lock:
            if not self.available:
                return {'ok': False, 'error': 'pcm unavailable'}
            self._pcm_sweep_locked()
            others = self._pcm.claim(sid, time.monotonic())
            for slot in others:
                self._lib.ka_pcm_set(slot, 0, 0, 0, 0.0)
            return {'ok': True, 'deactivated': len(others)}

    def pcm_release(self, sid: str) -> dict:
        """关窗 / 刷新：把它名下的 PCM 整批还掉（否则关掉的窗还在引擎里响）。"""
        with self._lock:
            if not self.available:
                return {'ok': True, 'released': 0}
            self._pcm_sweep_locked()
            slots = self._pcm.release(sid)
            for slot in slots:
                self._lib.ka_pcm_clear(slot)
            return {'ok': True, 'released': len(slots)}

    def pcm_begin(self, sid: str, clip: str, frames: int, channels: int = 2) -> dict:
        with self._lock:
            if not self.available or not hasattr(self._lib, 'ka_pcm_begin'):
                return {'ok': False, 'error': 'pcm unavailable'}
            self._pcm_sweep_locked()
            self._pcm.touch(sid, time.monotonic())
            slot = self._pcm.slot_for(sid, clip)
            if slot is None:
                return {'ok': False, 'error': 'no free pcm slot'}
            rc = int(self._lib.ka_pcm_begin(int(slot), int(frames), int(channels)))
            return {'ok': rc == 0, 'slot': slot, 'frames': int(frames), 'rc': rc}

    def pcm_chunk(self, sid: str, clip: str, offset: int, data_b64: str) -> dict:
        """写入一段交错立体声 int16（base64）。chunk 只搬字节，不做解码。"""
        with self._lock:
            if not self.available or not hasattr(self._lib, 'ka_pcm_write'):
                return {'ok': False, 'error': 'pcm unavailable'}
            self._pcm_sweep_locked()
            self._pcm.touch(sid, time.monotonic())
            slot = self._pcm.slot_of(sid, clip)
            if slot is None:
                return {'ok': False, 'error': 'unknown pcm clip'}
            raw = base64.b64decode(data_b64 or '')
            frames = len(raw) // 4
            if frames <= 0:
                return {'ok': False, 'error': 'empty pcm chunk'}
            buf = ctypes.create_string_buffer(raw, len(raw))
            rc = int(self._lib.ka_pcm_write(int(slot), int(offset),
                                            ctypes.cast(buf, ctypes.c_void_p), int(frames)))
            return {'ok': rc == frames, 'slot': slot, 'offset': int(offset),
                    'frames': frames, 'rc': rc}

    def pcm_finish(self, sid: str, clip: str) -> dict:
        with self._lock:
            if not self.available or not hasattr(self._lib, 'ka_pcm_finish'):
                return {'ok': False, 'error': 'pcm unavailable'}
            self._pcm_sweep_locked()
            self._pcm.touch(sid, time.monotonic())
            slot = self._pcm.slot_of(sid, clip)
            if slot is None:
                return {'ok': False, 'error': 'unknown pcm clip'}
            return {'ok': int(self._lib.ka_pcm_finish(int(slot))) == 0}

    def pcm_set(self, sid: str, clip: str, gen: int, start: int, offset: int,
                length: int, gain: float = 1.0) -> dict:
        with self._lock:
            if not self.available or not hasattr(self._lib, 'ka_pcm_set'):
                return {'ok': False, 'error': 'pcm unavailable'}
            self._pcm_sweep_locked()
            self._pcm.touch(sid, time.monotonic())
            if self._pcm.slot_of(sid, clip) is None:
                return {'ok': False, 'error': 'unknown pcm clip'}
            # 只有作者能摆放：别的窗交上来的摆放一律不激活（同一段时间线只准一条声音）。
            if not self._pcm.is_owner(sid):
                return {'ok': False, 'not_owner': True}
            if not self._pcm.gen_ok(sid, clip, gen):
                return {'ok': True, 'dropped': 1}
            slot = self._pcm.slot_of(sid, clip)
            rc = int(self._lib.ka_pcm_set(int(slot), int(start), int(offset),
                                          int(length), float(gain)))
            return {'ok': rc == 0}

    def pcm_clear(self, sid: str, clip: str, gen: int = 0) -> dict:
        with self._lock:
            if not self.available or not hasattr(self._lib, 'ka_pcm_clear'):
                return {'ok': False, 'error': 'pcm unavailable'}
            self._pcm.touch(sid, time.monotonic())
            slot = self._pcm.slot_of(sid, clip)
            if slot is None:
                return {'ok': True}
            if gen and not self._pcm.gen_ok(sid, clip, gen):
                return {'ok': True, 'dropped': 1}
            rc = int(self._lib.ka_pcm_clear(int(slot)))
            self._pcm.drop_clip(sid, clip)
            return {'ok': rc == 0}

    def panic(self) -> dict:
        with self._lock:
            if self._open:
                for slot in range(KA_MAX_PLUG):
                    if self._slot_open(slot):
                        self._select(slot)
                        if hasattr(self._lib, 'ka_vst3_notes_off'):
                            self._lib.ka_vst3_notes_off()
                self._lib.ka_all_notes_off()
        return self.status()

    # ── 乐器槽：一条轨一件（2b）────────────────────────────────────────────────────────────────
    #
    # 槽 = 一支插件实例 = 一个 KaPluginWorker.exe + 一块共享内存。插件本体永远不在这个进程里，
    # 这边只写命令、读回执。四条不变量：
    #   1. 一个槽同一时刻最多属于一条轨；槽 15 是试听槽（不属于任何轨）。
    #   2. 槽按**轨 id** 认主，不按轨下标 —— 删掉前面一条轨，后面的不用重装。
    #   3. 装过的不会再装：`want` 相同就只把下标重绑一次（`bound` 没变就不绑）。
    #   4. 装失败也记在 `want` 上 —— 否则每拖一个音符都重试一次插件加载，界面会一卡一卡的。
    #      想再试一次走显式的 `track_instrument` / `preview`（它们不看 `want`，只看现在能不能出声）。
    #
    # SFZ 是例外：采样内存在进程里只有一套（ka_sfz.h 的 AB 双槽），所以它也只能属于一个槽。
    # 第二条轨要装**另一件** SFZ 时如实拒绝 —— 拿 A 的采样去当 B 的音色比报错糟得多。
    def _select(self, slot: int) -> int:
        """把 DLL 的"选中槽"挪到 slot —— 之后所有 ka_vst3_* 老签名都作用在这一槽上。"""
        if self.available and hasattr(self._lib, 'ka_plug_select'):
            return int(self._lib.ka_plug_select(int(slot)))
        return -1

    def _slot(self, slot: int) -> dict:
        st = self._slots[slot]
        if st is None:
            st = {'worker': None, 'track': None, 'want': '', 'bound': -2, 'kind': '',
                  'open': False, 'path': '', 'pluginPath': '', 'cls': 0, 'name': '',
                  'vendor': '', 'preset': '', 'cid': '', 'parked': '', 'parked_at': 0.0, 'error': '',
                  'editor': False, 'editorSize': [],
                  'zones': 0, 'failed': 0, 'kb': 0}
            self._slots[slot] = st
        return st

    def _slot_of(self) -> dict:
        """轨 id → 槽。"""
        out = {}
        for i, st in enumerate(self._slots):
            if st is not None and st.get('track'):
                out[st['track']] = i
        return out

    def _slot_of_track_index(self, index: int):
        if 0 <= int(index) < len(self._track_ids):
            return self._slot_of().get(self._track_ids[int(index)])
        return None

    def _slot_open(self, slot) -> bool:
        """这一槽现在真的在出声吗。挂掉的 worker 也算"没开" —— 界面不能对着尸体说 OK。"""
        if slot is None or not (0 <= int(slot) < KA_MAX_PLUG):
            return False
        st = self._slots[int(slot)]
        if not st or not st.get('open'):
            return False
        if st.get('kind') == 'sfz':
            return self._sfz['slot'] == int(slot) and bool(self._sfz['path'])
        w = st.get('worker')
        return bool(w is not None and w.running())

    def _sfz_on_index(self, index: int) -> bool:
        slot = self._slot_of_track_index(index)
        return slot is not None and self._sfz['slot'] == slot and bool(self._sfz['path'])

    def _slot_public(self, slot: int) -> dict:
        st = self._slots[slot]
        if st is None:
            return {'slot': slot, 'track': None, 'open': False, 'path': '', 'kind': '',
                    'name': '', 'error': '', 'zones': 0, 'failed': 0, 'kb': 0, 'peak': 0,
                    'editor': False, 'editorSize': []}
        out = {'slot': slot, 'track': st['track'], 'open': bool(st['open']),
               'path': st['path'], 'kind': st['kind'], 'name': st['name'],
               'cls': st['cls'], 'preset': st['preset'], 'cid': st['cid'],
               'error': st['error'], 'zones': st['zones'], 'failed': st['failed'],
               'kb': st['kb'], 'peak': 0,
               'editor': bool(st.get('editor')),
               'editorSize': list(st.get('editorSize') or [])}
        if out['open'] and st['kind'] == 'vst3':
            w = st.get('worker')
            if w is None or not w.running():
                out['open'] = False
                out['error'] = out['error'] or 'the plugin worker is gone'
            else:
                out['peak'] = int(self._lib.ka_vst3_peak_s(slot))
        if out['open'] and st['kind'] == 'sfz' and self._sfz['slot'] != slot:
            out['open'] = False
            out['error'] = out['error'] or 'the SFZ samples were unloaded'
        return out

    def _instrument_public(self, slot: int) -> dict:
        st = self._slot_public(slot)
        return {'path': st['path'], 'kind': st['kind'], 'name': st['name'],
                'zones': st['zones'], 'failed': st['failed'], 'kb': st['kb'],
                'error': st['error']}

    # ── worker 进程 ────────────────────────────────────────────────────────────────────────────
    def _ensure_worker(self, slot: int) -> bool:
        cls = _load_worker_class()
        if cls is None:
            self.last_error = 'plugin_worker.py is missing (client/kolid_audio)'
            return False
        if not hasattr(self._lib, 'ka_plug_attach_s'):
            self.last_error = ('this KolidAudio.dll has no per-track slots — restart ComfyUI '
                               'so it picks up the new build')
            return False
        st = self._slot(slot)
        w = st.get('worker')
        if w is not None:
            try:
                if w.attached() and w.running():
                    return True
            except Exception:
                pass
            try:
                w.stop()                      # 崩过 / 半连上：退掉重起一个
            except Exception:
                pass
            st['worker'] = None
            st['open'] = False
        try:
            # tag 里带槽号：共享内存名互不打架，同一个槽重起也能接到自己那一块。
            st['worker'] = cls(tag='bridge%d_s%d' % (os.getpid(), slot), slot=int(slot))
        except Exception as e:                # 起不来：把原因交出去，别抛给 HTTP 线程
            st['worker'] = None
            self.last_error = 'plugin worker failed to start: %s' % e
            return False
        return True

    def _stop_worker(self, slot: int) -> None:
        st = self._slots[slot]
        if st is None:
            return
        w = st.get('worker')
        if w is not None:
            try:
                w.stop()                      # 进程 terminate + 这一侧的映射放掉
            except Exception:
                pass
            st['worker'] = None
        if self.available and hasattr(self._lib, 'ka_plug_detach_s'):
            try:
                self._lib.ka_plug_detach_s(int(slot))
            except Exception:
                pass

    def worker_state(self, slot: int = PREVIEW_SLOT) -> dict:
        st = self._slots[slot]
        w = st.get('worker') if st else None
        return {'started': w is not None,
                'attached': bool(w is not None and w.attached()),
                'pid': getattr(getattr(w, 'proc', None), 'pid', 0) or 0}

    def scan_plugin_classes(self, path: str) -> list:
        """列一个 `.vst3` 的类清单 —— registry 靠它把预设里的 cid 反查成插件。

        **只问工厂，不实例化**（`ka_v3_scan` 里那一趟），所以扫一件不会留下一个活着的插件。
        扫描在 worker 进程里是全局的（不是每槽一份），用试听槽问就够了 —— 这里要的只是
        "这个 bundle 里有哪些类"。
        """
        if not self.available or not hasattr(self._lib, 'ka_vst3_scan'):
            return []
        with self._lock:
            if not self._ensure_worker(PREVIEW_SLOT):
                return []
            self._select(PREVIEW_SLOT)
            n = int(self._lib.ka_vst3_scan(os.path.abspath(str(path or ''))))
            if n <= 0:
                return []
            rows = []
            for i in range(n):
                buf = ctypes.create_string_buffer(1024)
                self._lib.ka_vst3_class(i, buf, 1024)
                parts = buf.value.decode('utf-8', 'replace').split('|')
                raw = ctypes.create_string_buffer(16)
                if self._lib.ka_vst3_class_cid(i, raw) != 16:
                    continue
                rows.append({
                    'cls': i,
                    'cid': raw.raw.hex().upper(),
                    'name': parts[3] if len(parts) > 3 else '',
                    'category': parts[2] if len(parts) > 2 else '',
                })
            return rows

    # ── 装 / 卸 ────────────────────────────────────────────────────────────────────────────────
    def _unload_sfz(self) -> None:
        if self.available and hasattr(self._lib, 'ka_unload_sfz'):
            # 先掐掉发声再卸 —— 声部里存的是 zone 指针，卸完再停会读空。
            self._lib.ka_all_notes_off()
            self._lib.ka_unload_sfz()
        self._sfz = {'path': '', 'slot': None, 'zones': 0, 'failed': 0, 'kb': 0, 'error': ''}

    def _unload_slot(self, slot: int) -> None:
        """把这一槽上的乐器收掉（槽本身和 worker 留着，方便马上换下一件）。"""
        st = self._slots[slot]
        if st is None:
            return
        if self.available:
            self._select(slot)
            if st['open'] and st['kind'] == 'vst3' and hasattr(self._lib, 'ka_vst3_close'):
                self._lib.ka_vst3_close()
            if self._sfz['slot'] == slot:
                self._unload_sfz()
        st.update({'open': False, 'path': '', 'pluginPath': '', 'kind': '', 'name': '',
                   'zones': 0, 'failed': 0, 'kb': 0, 'error': '', 'preset': '', 'cid': '',
                   'parked': '', 'parked_at': 0.0, 'editor': False, 'editorSize': []})

    def _free_slot(self, slot: int) -> None:
        """整槽放掉：乐器 + worker 进程 + 共享内存。空出来的槽给下一条轨用。"""
        if self._slots[slot] is None:
            return
        self._unload_slot(slot)
        self._stop_worker(slot)
        self._slots[slot] = None

    def _apply_slot(self, slot: int, res: dict) -> None:
        st = self._slot(slot)
        st.update({
            'kind': str(res.get('kind') or ''),
            'open': bool(res.get('ok')),
            'name': str(res.get('name') or ''),
            'zones': int(res.get('zones') or 0),
            'failed': int(res.get('failed') or 0),
            'kb': int(res.get('kb') or 0),
            'error': '' if res.get('ok') else str(res.get('error') or ''),
            'editor': False, 'editorSize': [],
        })

    def _load_sfz_into(self, slot: int, full: str) -> dict:
        if not (self.available and hasattr(self._lib, 'ka_load_sfz')):
            return {'ok': False, 'kind': 'sfz', 'path': full, 'error': 'this build has no SFZ loader'}
        owner = self._sfz['slot']
        if owner is not None and owner != slot:
            return {'ok': False, 'kind': 'sfz', 'path': full, 'untouched': True,
                    'error': 'only one SFZ instrument can be loaded at a time — it is already '
                             'on another track (%s)' % os.path.basename(self._sfz['path'])}
        if owner == slot and os.path.normcase(self._sfz['path']) == os.path.normcase(full):
            return {'ok': True, 'kind': 'sfz', 'path': full, 'zones': self._sfz['zones'],
                    'failed': self._sfz['failed'], 'kb': self._sfz['kb'], 'error': ''}
        self._unload_sfz()
        n = int(self._lib.ka_load_sfz(full))
        if n <= 0:
            code = int(self._lib.ka_sfz_err()) if hasattr(self._lib, 'ka_sfz_err') else 0
            reason = {
                -1: 'could not read the .sfz',
                -2: 'no <region> in this .sfz',
                -3: 'no sample could be decoded (err=%d)' % code,
            }.get(n, 'load failed (%d)' % n)
            self._sfz = {'path': full, 'slot': None, 'zones': 0, 'failed': 0, 'kb': 0,
                         'error': reason}
            return {'ok': False, 'kind': 'sfz', 'path': full, 'zones': 0, 'failed': 0,
                    'kb': 0, 'error': reason}
        buf = (ctypes.c_int32 * 3)()
        self._lib.ka_sfz_state(buf, 3)
        self._sfz = {'path': full, 'slot': slot, 'zones': int(buf[0]), 'failed': int(buf[1]),
                     'kb': int(buf[2]), 'error': ''}
        return {'ok': True, 'kind': 'sfz', 'path': full, 'zones': int(buf[0]),
                'failed': int(buf[1]), 'kb': int(buf[2]), 'error': ''}

    def _open_plugin_only(self, slot: int, full: str, cls: int) -> dict:
        """打开一支 `.vst3` 的第 cls 个类（不灌状态）。成功时这一槽就开始出声。"""
        if not self.available or not hasattr(self._lib, 'ka_vst3_open'):
            return {'ok': False, 'error': 'this build has no VST3 host'}
        if not self._open:
            got = self.open()
            if not got.get('open'):
                return {'ok': False, 'error': 'the audio device did not open: %s'
                                              % (got.get('error') or 'unknown')}
        if not self._ensure_worker(slot):
            return {'ok': False, 'error': self.last_error or 'plugin worker unavailable'}
        st = self._slot(slot)
        self._select(slot)
        if st['open']:
            self._lib.ka_vst3_close()
            st['open'] = False
        rc = int(self._lib.ka_vst3_open(full, max(0, int(cls))))
        if rc != 0:
            stage = ctypes.c_int(0)
            if hasattr(self._lib, 'ka_vst3_stage'):
                self._lib.ka_vst3_stage(ctypes.byref(stage))
            st['error'] = _plugin_reason(rc, stage.value)
            return {'ok': False, 'error': st['error'], 'plugin': self._slot_public(slot)}
        st.update({'open': True, 'kind': 'vst3', 'pluginPath': full, 'cls': int(cls), 'error': ''})
        # 给组件 setState 敲一次门（空流，回执通常是被拒）：HALion 这类引擎在"从未被
        # setState 过"时 `IComponent::getState` 恒回 0 字节 —— 程序只活在实例里、不进状态。
        # Cubase 每次实例化都会 setState；我们照做，之后普通"存状态"就能带上程序本体。
        if st.get('kind') == 'vst3' and hasattr(self._lib, 'ka_vst3_prime'):
            try:
                self._lib.ka_vst3_prime()
            except Exception:
                pass
        if hasattr(self._lib, 'ka_vst3_live'):
            self._lib.ka_vst3_live(1)         # 开始往 ring 里渲（宿主音频线程取走混进输出）
        if st['track'] is None and hasattr(self._lib, 'ka_vst3_bind'):
            self._lib.ka_vst3_bind(slot, -1)  # 试听槽/调试装法：不接工程里的音符
        return {'ok': True, 'plugin': self._slot_public(slot)}

    def _load_state(self, slot: int, full: str) -> dict:
        """把一份 `.vstpreset` 灌进这一槽已经开着的插件里（setState，不碰界面）。"""
        self._select(slot)
        got = (ctypes.c_int32 * 4)()
        rc = int(self._lib.ka_vst3_state_load(full, got, 4))
        detail = {
            'bytes': int(got[3]),
            'componentRc': int(got[0]),
            'controllerComponentRc': int(got[1]),
            'controllerRc': int(got[2]),
        }
        if rc != 0:
            reason = {-11: 'could not read the preset file', -12: 'the preset is too large',
                      -13: 'not a VST3 preset', -14: 'the preset has no state chunk',
                      -2: 'the plugin is not open'}.get(rc, 'state load failed (rc=%d)' % rc)
            return dict(detail, ok=False, error=reason, preset=full)
        # 三处 rc 都是插件自己给的"我收下了吗"。但**不是每处非 0 都算坏**：
        #   · kResultOk=0 / kResultTrue=1 都算收下；
        #   · 控制器那两处（setComponentState / IEditController::setState）返回 E_NOTIMPL
        #     是 VST3 明确允许的"我这儿没有要同步的"（Ample 系就是这么答的）。把它当失败
        #     会把一支明明装上了的插件关掉 —— 用户看到的就是"这一轨没声音了"。
        #   · 组件那一处（IComponent::setState）非成功就是真的没装上，仍然算坏。
        bad = []
        if detail['componentRc'] not in (0, 1):
            bad.append('componentRc')
        for k in ('controllerComponentRc', 'controllerRc'):
            if detail[k] not in (0, 1) and detail[k] != _E_NOTIMPL:
                bad.append(k)
        if bad:
            reason = 'the plugin rejected the state (%s)' % ', '.join(
                '%s=%d' % (k, detail[k]) for k in bad)
            return dict(detail, ok=False, error=reason, preset=full)
        if self._notes:
            self._push_notes()                # 换音色 = 换了一次时间：把表重推一遍
        return dict(detail, ok=True, preset=full)

    def _load_preset_into(self, slot: int, full: str) -> dict:
        """读预设的 cid → 找插件 → 打开 → 灌状态。全在**这一槽**里，不碰别的轨。"""
        preset = vst3_registry.read_preset(full)
        if not preset['ok']:
            return {'ok': False, 'kind': 'vst3', 'path': full, 'error': preset['error'],
                    'preset': preset}
        if not self.available or not hasattr(self._lib, 'ka_vst3_open'):
            return {'ok': False, 'kind': 'vst3', 'path': full,
                    'error': 'this build has no VST3 host', 'preset': preset}
        found = vst3_registry.resolve(preset['cid'], self.scan_plugin_classes, hint=full)
        if not found['ok']:
            return {'ok': False, 'kind': 'vst3', 'path': full, 'error':
                    '%s — the plugin for this preset is not installed, or it was not '
                    'found in the VST3 folders (%s)' % (found['error'], preset['cid'][:8]),
                    'preset': preset}
        st = self._slot(slot)
        same = (self._slot_open(slot) and st['kind'] == 'vst3'
                and os.path.normcase(st['pluginPath']) == os.path.normcase(found['path'])
                and int(st['cls']) == int(found['cls']))
        if not same:
            opened = self._open_plugin_only(slot, found['path'], int(found['cls']))
            if not opened.get('ok'):
                return {'ok': False, 'kind': 'vst3', 'path': full, 'error':
                        opened.get('error') or 'the plugin did not open', 'preset': preset}
            name, cid = '', ''
            for c in vst3_registry.classes_of(found['path'], self.scan_plugin_classes):
                if int(c.get('cls') or 0) == int(found['cls']):
                    name, cid = str(c.get('name') or ''), str(c.get('cid') or '')
                    break
            st.update({'name': name, 'cid': cid})
        loaded = self._load_state(slot, full)
        nbytes = int(loaded.get('bytes') or 0)
        st['kb'] = max(1, int(round(nbytes / 1024.0))) if loaded.get('ok') else 0
        st['preset'] = full
        st['error'] = '' if loaded.get('ok') else str(loaded.get('error') or '')
        if not loaded.get('ok'):
            # 没灌上状态 = 这不是用户要的音色。关掉它，别让"默认音色"冒充。
            if st['open']:
                self._select(slot)
                self._lib.ka_vst3_close()
                st['open'] = False
        return {'ok': bool(loaded.get('ok')), 'kind': 'vst3', 'path': full, 'name': st['name'],
                'zones': 0, 'failed': 0, 'kb': st['kb'], 'error': st['error'],
                'preset': loaded, 'plugin': self._slot_public(slot)}

    def _load_into(self, slot: int, full: str) -> dict:
        """按扩展名把一件乐器装进这一槽。`.sfz` / `.vstpreset` / `.vst3` 三条路，别的如实拒绝。

        `.vst3` 是直接开一支插件用它的默认音色（没有状态可灌）—— 乐器库的 Installed plug-in
        那一档就走这条，先有一条能出声的轨，再用轨道行的音色窗在插件自己的界面里挑音色。"""
        full = os.path.abspath(str(full or ''))
        st = self._slot(slot)
        if not full:
            res = {'ok': False, 'kind': '', 'path': '', 'error': 'no path'}
        elif not os.path.exists(full):
            res = {'ok': False, 'kind': '', 'path': full, 'error': 'no such file: %s' % full}
        else:
            ext = os.path.splitext(full)[1].lower()
            if ext not in ('.sfz', '.vstpreset', '.vst3'):
                res = {'ok': False, 'kind': '', 'path': full,
                       'error': 'this engine cannot play %s files yet' % ext}
            elif ext == '.sfz' and self._sfz['slot'] is not None \
                    and self._sfz['slot'] != int(slot):
                # 采样内存全机器只有一套（ka_sfz.h 的 AB 双槽），换一条轨用同一份文件也得重灌、
                # 并且会把前一条轨的采样顶掉 —— 所以**先拒，再谈卸**：这一槽原来在响的东西
                # 一根手指都不该动。要挪去别的轨，先在那条轨上卸掉。
                res = {'ok': False, 'kind': 'sfz', 'path': full, 'untouched': True,
                       'error': 'only one SFZ instrument can be loaded at a time — it is already '
                                'on another track (%s)' % os.path.basename(self._sfz['path'])}
            else:
                want_kind = 'sfz' if ext == '.sfz' else 'vst3'
                if st['open'] and st['kind'] != want_kind:
                    self._unload_slot(slot)   # 换了一条路：先把上一种收干净
                if want_kind == 'sfz':
                    self._stop_worker(slot)   # 采样乐器不占 worker 进程
                    res = self._load_sfz_into(slot, full)
                elif ext == '.vst3':
                    opened = self._open_plugin_only(slot, full, 0)
                    name = ''
                    if opened.get('ok'):
                        for c in vst3_registry.classes_of(full, self.scan_plugin_classes):
                            if int(c.get('cls') or 0) == 0:
                                name = str(c.get('name') or '')
                                break
                        name = name or os.path.splitext(os.path.basename(full))[0]
                    res = dict(opened, kind='vst3', path=full, zones=0, failed=0, kb=0, name=name)
                else:
                    res = self._load_preset_into(slot, full)
        if res.get('untouched'):
            return res                    # 什么都没动过：want/path 也别改，否则会对账成"装过坏的"
        self._apply_slot(slot, res)
        st['want'] = full
        st['path'] = full
        st['bound'] = -2
        if not res.get('ok'):
            self._select(slot)
            if st.get('worker') is not None and hasattr(self._lib, 'ka_vst3_bind'):
                self._lib.ka_vst3_bind(slot, -1)   # 没装上就别再喂音符
        return res

    # ── 绑定：谁吃哪条轨的音符 ────────────────────────────────────────────────────────────────
    def _bind_slots(self) -> None:
        if not self.available:
            return
        ids = {tid: i for i, tid in enumerate(self._track_ids)}
        for slot, st in enumerate(self._slots):
            if st is None or not st.get('track'):
                continue                  # 无主的槽（试听）由装它的那条路自己绑
            idx = ids.get(st['track'], -1)
            if idx == st.get('bound'):
                continue
            self._select(slot)
            if st.get('kind') == 'sfz':
                if hasattr(self._lib, 'ka_sfz_bind'):
                    self._lib.ka_sfz_bind(idx if self._sfz['slot'] == slot else -1)
            elif hasattr(self._lib, 'ka_vst3_bind'):
                self._lib.ka_vst3_bind(slot, idx)
            st['bound'] = idx

    # ── 挂起 / 领回：关文档再打开同一份工程时，实例还在就还能出声 ─────────────────────
    def _park_slot(self, slot: int) -> None:
        """这一轨从工程里消失了：先不卸，挂起来（停渲染、解绑）。"""
        st = self._slots[slot]
        if st is None:
            return
        if st.get('kind') != 'vst3' or not st.get('open') or not self._slot_open(slot):
            self._free_slot(slot)
            return
        st['parked'] = st.get('track') or st.get('parked') or ''
        st['parked_at'] = time.monotonic()
        st['track'] = None
        st['bound'] = -2
        try:
            self._select(slot)
            self._lib.ka_vst3_live(0)          # 停渲染：挂起的实例不该继续混进输出
            if hasattr(self._lib, 'ka_vst3_bind'):
                self._lib.ka_vst3_bind(slot, -1)
        except Exception:
            pass
        self._trim_parked()

    def _parked(self):
        return [(i, st) for i, st in enumerate(self._slots)
                if st is not None and not st.get('track') and st.get('parked')]

    def _trim_parked(self) -> None:
        parked = sorted(self._parked(), key=lambda x: x[1].get('parked_at') or 0.0)
        for slot, _st in parked[:-PARKED_SLOTS_MAX]:
            self._free_slot(slot)

    def _adopt_parked(self, tid: str, path: str):
        """挂起的实例里装着同一件乐器 → 接着用它（不重装：程序还在）。"""
        want = os.path.normcase(os.path.abspath(path))
        for slot, st in sorted(self._parked(), key=lambda x: -(x[1].get('parked_at') or 0.0)):
            if os.path.normcase(os.path.abspath(str(st.get('want') or ''))) != want:
                continue
            if not self._slot_open(slot):
                continue
            try:
                self._select(slot)
                self._lib.ka_vst3_live(1)
            except Exception:
                continue
            st['track'] = tid
            st['parked'] = ''
            st['bound'] = -2
            return slot
        return None

    def _reconcile(self) -> None:
        """让槽跟上工程：装了的不重装、删了的放掉、挪了位置的只重绑。"""
        if not self.available or self._reconciling:
            return
        self._reconciling = True
        try:
            byid = {}
            for i, tid in enumerate(self._track_ids):
                path = self._track_files[i] if i < len(self._track_files) else ''
                if path:
                    byid[tid] = path
            if not byid and not self._slot_of():
                self._bind_slots()
                return
            if not self._open:
                if not byid:
                    return
                got = self.open()          # 有乐器要装，就得先有设备（worker 的采样率从这儿拿）
                if not got.get('open'):
                    return
            # 1) 换了乐器 → 原位重装
            for tid, path in byid.items():
                slot = self._slot_of().get(tid)
                if slot is None:
                    continue
                st = self._slots[slot]
                if os.path.normcase(st['want']) == os.path.normcase(path):
                    continue
                self._unload_slot(slot)
                self._load_into(slot, path)
            # 2) 主人不在的槽 → 先挂起（关文档再打开时还要用它，见 _park_slot）
            for slot, st in enumerate(list(self._slots)):
                if st is not None and st.get('track') and st['track'] not in byid:
                    self._park_slot(slot)
            # 3) 新乐器 → 先领回挂起的那件，没有再找空槽装上
            taken = self._slot_of()
            for tid, path in byid.items():
                if tid in taken:
                    continue
                if self._adopt_parked(tid, path) is not None:
                    taken[tid] = True
                    continue
                slot = next((s for s in range(TRACK_SLOTS) if self._slots[s] is None), None)
                if slot is None:
                    # 槽用完了：放掉最旧的挂起实例再试一次
                    parked = self._parked()
                    if parked:
                        self._free_slot(parked[0][0])
                        slot = parked[0][0]
                if slot is None:
                    continue               # 还是没有：多出来的轨先走内置合成器
                st = self._slot(slot)
                st['track'] = tid
                self._load_into(slot, path)
            self._bind_slots()
        finally:
            self._reconciling = False

    # ── 对外：按轨装 / 卸 / 试听 ──────────────────────────────────────────────────────────────
    def _resolve_track(self, track):
        """轨 id 或轨下标 → 轨 id。认不出来就 None。"""
        t = str(track if track is not None else '')
        if t and t in self._track_ids:
            return t
        idx = _i(track, -1)
        if 0 <= idx < len(self._track_ids):
            return self._track_ids[idx]
        return None

    def track_instrument(self, track, path: str) -> dict:
        """给**这一条轨**装一件乐器（双击乐器库那一行走这里）。别的轨一件都不动。"""
        full = os.path.abspath(str(path or ''))
        with self._lock:
            tid = self._resolve_track(track)
            if tid is None:
                return {'ok': False, 'kind': '', 'path': full, 'error': 'no such track'}
            slot = self._slot_of().get(tid)
            if slot is None:
                slot = next((s for s in range(TRACK_SLOTS) if self._slots[s] is None), None)
                if slot is None:
                    return {'ok': False, 'kind': '', 'path': full,
                            'error': 'all %d instrument slots are in use' % TRACK_SLOTS}
            st = self._slot(slot)
            st['track'] = tid
            if self._slot_open(slot) and os.path.normcase(st['path']) == os.path.normcase(full):
                return dict(self._slot_public(slot), ok=True)
            if not full:
                return {'ok': False, 'kind': '', 'path': '', 'error': 'no path'}
            if not self._open:
                got = self.open()
                if not got.get('open'):
                    return {'ok': False, 'kind': '', 'path': full,
                            'error': 'the audio device did not open: %s'
                                     % (got.get('error') or 'unknown')}
            res = self._load_into(slot, full)
            if res.get('untouched'):
                # 被拒的装载什么都没动：槽里原来那件照旧在响，这里如实把"这次没装上"报出去。
                out = dict(self._slot_public(slot))
                out['ok'] = False
                out['error'] = str(res.get('error') or 'not loaded')
                return out
            self._bind_slots()
            out = dict(self._slot_public(slot))
            out['ok'] = bool(out['open'])
            return out

    def track_unload(self, track) -> dict:
        with self._lock:
            tid = self._resolve_track(track)
            slot = self._slot_of().get(tid) if tid else None
            if slot is not None:
                self._free_slot(slot)
        return self.status()

    # ── 插件编辑器：挑音色 + 存 .vstpreset ──────────────────────────────────────────────────────
    #
    # HALion/Kontakt 没有"选音色"的接口（程序列表全是占位），音色只能由它们自己的界面挑。
    # 所以：给这条轨的实例开插件自己的窗口（worker 的 UI 线程），用户在里面挑一次；关窗后
    # 把整块状态存成 .vstpreset —— 之后加载就是普通的预设装载，全自动、不再需要窗口。
    def _editor_slot(self, track):
        tid = self._resolve_track(track)
        slot = self._slot_of().get(tid) if tid else None
        if slot is None:
            return None, {'ok': False, 'error': 'this track has no instrument loaded'}
        st = self._slots[slot]
        if not self._slot_open(slot):
            return None, {'ok': False, 'slot': slot,
                          'error': st.get('error') or 'the instrument is not running'}
        if st.get('kind') != 'vst3':
            return None, {'ok': False, 'slot': slot,
                          'error': 'this instrument has no editable plugin window'}
        return slot, None

    def editor_open(self, track) -> dict:
        with self._lock:
            slot, bad = self._editor_slot(track)
            if bad:
                return bad
            st = self._slots[slot]
            # 已经开着也照样叫一遍 worker：它会把窗口抬到前台（用户再点 Edit 就是想看见它）。
            self._select(slot)
            out = (ctypes.c_int32 * 4)()
            rc = int(self._lib.ka_vst3_editor_open(out, 4))
            st['editor'] = bool(out[0])
            st['editorSize'] = [int(out[1]), int(out[2])]
            if rc != 0:
                return {'ok': False, 'slot': slot, 'rc': rc, 'error': _editor_reason(rc)}
            return {'ok': True, 'slot': slot, 'open': True, 'size': st['editorSize']}

    def editor_close(self, track) -> dict:
        with self._lock:
            slot, bad = self._editor_slot(track)
            if bad:
                return bad
            st = self._slots[slot]
            self._select(slot)
            rc = int(self._lib.ka_vst3_editor_close())
            if rc != 0:
                # 关失败时窗口还在：别把标记清掉，界面靠它继续轮询（清了就会以为已关、去存音色）。
                return {'ok': False, 'slot': slot, 'rc': rc,
                        'error': 'the editor did not close (rc=%d)' % rc}
            st['editor'] = False
            return {'ok': True, 'slot': slot, 'open': False}

    def editor_state(self, track) -> dict:
        """这条轨的编辑器还开着吗。用户点 X 关掉 = open 变 False（界面据此去存音色）。"""
        with self._lock:
            slot, bad = self._editor_slot(track)
            if bad:
                return dict(bad, open=False)
            st = self._slots[slot]
            if not st.get('editor'):
                return {'ok': True, 'slot': slot, 'open': False, 'size': []}
            self._select(slot)
            out = (ctypes.c_int32 * 4)()
            opened = int(self._lib.ka_vst3_editor_state(out, 4))
            if opened < 0:
                st['editor'] = False
                return {'ok': False, 'slot': slot, 'open': False, 'size': [],
                        'rc': opened, 'error': _editor_reason(opened)}
            st['editor'] = opened == 1
            st['editorSize'] = [int(out[1]), int(out[2])]
            return {'ok': True, 'slot': slot, 'open': st['editor'],
                    'closedByUser': int(out[0]), 'size': st['editorSize']}

    def editor_save(self, track, path: str) -> dict:
        """把这一槽**现在**的整块状态写成 .vstpreset（Cubase 同款布局）。"""
        full = os.path.abspath(str(path or ''))
        if not full:
            return {'ok': False, 'error': 'no output path'}
        with self._lock:
            slot, bad = self._editor_slot(track)
            if bad:
                return bad
            st = self._slots[slot]
            self._select(slot)
            n = int(self._lib.ka_vst3_state_save(full))
            if n <= 0:
                why = {-1: 'the plugin is not open', -2: 'out of memory',
                       -3: 'the plugin returned no state',
                       -4: 'the plugin returned an empty state'}.get(n, 'state save failed (rc=%d)' % n)
                return {'ok': False, 'slot': slot, 'rc': n, 'error': why}
            st['preset'] = full
            st['kb'] = max(1, int(round(n / 1024.0)))
            # 这条轨的乐器从这一刻起就是这份预设：`want` 先跟上，界面把新路径推进 `tracks`
            # 时对账看到的是同一个值 —— 实例不会被关掉重开，声音不断。
            st['want'] = full
            st['path'] = full
            return {'ok': True, 'slot': slot, 'path': full, 'preset': full,
                    'bytes': n, 'kb': st['kb'], 'name': st.get('name') or ''}

    def preview(self, path: str, note: int = -1, vel: int = 100) -> dict:
        """试听一件还没进工程的乐器：装在**试听槽**（15），不进任何轨的音符表。

        试听槽装的可能是另一件乐器 —— 所以工程的音符永远不会流到它这里（bind -1），
        它自己响的那一下来自 ka_vst3_audition / ka_audition。"""
        full = os.path.abspath(str(path or ''))
        with self._lock:
            if not full:
                return {'ok': False, 'path': '', 'error': 'no path'}
            if not self._open:
                got = self.open()
                if not got.get('open'):
                    return {'ok': False, 'path': full,
                            'error': 'the audio device did not open: %s'
                                     % (got.get('error') or 'unknown')}
            st = self._slot(PREVIEW_SLOT)
            st['track'] = None
            if not (self._slot_open(PREVIEW_SLOT)
                    and os.path.normcase(st['path']) == os.path.normcase(full)):
                self._load_into(PREVIEW_SLOT, full)
                self._select(PREVIEW_SLOT)
                if hasattr(self._lib, 'ka_vst3_bind'):
                    self._lib.ka_vst3_bind(PREVIEW_SLOT, -1)
                if st['kind'] == 'sfz' and hasattr(self._lib, 'ka_sfz_bind'):
                    self._lib.ka_sfz_bind(-2)  # 只给试听出声（工程里的音符拿不到这套采样）
            heard = None
            if note >= 0 and self._slot_open(PREVIEW_SLOT):
                if st['kind'] == 'vst3':
                    blocks = max(1, int(round(AUDITION_SECONDS * self._rate / 512)))
                    self._select(PREVIEW_SLOT)
                    rc = int(self._lib.ka_vst3_audition(int(note), int(vel), 0, blocks))
                    heard = 'plugin' if rc >= 0 else 'plugin-error'
                else:
                    self._lib.ka_audition(int(note), int(vel), -1)
                    heard = 'sfz'
            out = dict(self._slot_public(PREVIEW_SLOT))
            out['ok'] = bool(out['open'])
            out['heard'] = heard
            return out

    # ── 兼容老调用方（探针、旧脚本）：一律作用在试听槽 ──────────────────────────────────────
    def plugin_open(self, path: str, cls: int = 0) -> dict:
        full = os.path.abspath(str(path or ''))
        if not (os.path.isfile(full) or os.path.isdir(full)):
            return {'ok': False, 'error': 'no such plugin: %s' % full}
        with self._lock:
            st = self._slot(PREVIEW_SLOT)
            st['track'] = None
            out = self._open_plugin_only(PREVIEW_SLOT, full, _i(cls, 0))
            out['plugin'] = self.plugin_state()
            return out

    def plugin_load_preset(self, path: str) -> dict:
        full = os.path.abspath(str(path or ''))
        if not os.path.isfile(full):
            return {'ok': False, 'error': 'no such preset: %s' % full}
        with self._lock:
            if not self._slot_open(PREVIEW_SLOT):
                return {'ok': False, 'error': 'no plugin is open'}
            st = self._slot(PREVIEW_SLOT)
            loaded = self._load_state(PREVIEW_SLOT, full)
            st['preset'] = full
            st['error'] = '' if loaded.get('ok') else str(loaded.get('error') or '')
            return dict(loaded, plugin=self._slot_public(PREVIEW_SLOT))

    def plugin_close(self) -> dict:
        with self._lock:
            self._free_slot(PREVIEW_SLOT)
        return self.status()

    def load_instrument(self, path: str) -> dict:
        """老入口：装进试听槽（不试听）。按扩展名分派见 `_load_into`。"""
        full = os.path.abspath(str(path or ''))
        with self._lock:
            res = self.preview(full, -1)
        out = dict(res)
        out.pop('heard', None)
        out.pop('slot', None)
        return out

    def load_preset(self, preset_path: str) -> dict:
        return self.load_instrument(preset_path)

    def unload_instrument(self) -> dict:
        with self._lock:
            self._free_slot(PREVIEW_SLOT)
        return self.status()

    def instrument_zones(self, limit: int = 200) -> dict:
        """诊断：当前 SFZ 前 N 个 zone 的说明行。界面暂时不用，排障时直接 curl。"""
        rows = []
        if self.available and hasattr(self._lib, 'ka_sfz_zone') and self._sfz['zones']:
            buf = ctypes.create_string_buffer(512)
            for i in range(min(limit, self._sfz['zones'])):
                if self._lib.ka_sfz_zone(i, buf, 512) > 0:
                    rows.append(buf.value.decode('utf-8', 'replace'))
        return {'zones': rows, 'count': len(rows), 'path': self._sfz['path']}

    def _plugin_info(self, slot: int = PREVIEW_SLOT) -> dict:
        """插件自报的声道/采样率（`ka_vst3_info` 的六个数）。排障与界面读数用。"""
        info = {'inBus': 0, 'outBus': 0, 'inCh': 0, 'outCh': 0, 'eventIn': 0, 'rate': 0}
        st = self._slots[slot]
        if not st or not self._slot_open(slot) or not hasattr(self._lib, 'ka_vst3_info'):
            return info
        self._select(slot)
        buf = ctypes.create_string_buffer(256)
        if self._lib.ka_vst3_info(buf, 256) > 0:
            try:
                v = [int(x) for x in buf.value.decode('utf-8', 'replace').split('|')[:6]]
            except ValueError:
                return info
            keys = ['inBus', 'outBus', 'inCh', 'outCh', 'eventIn', 'rate']
            info.update(dict(zip(keys, v)))
        return info

    def plugin_state(self, slot: int = PREVIEW_SLOT) -> dict:
        st = self._slot_public(slot)
        st['info'] = self._plugin_info(slot)
        st['worker'] = self.worker_state(slot)
        if st['open'] and st['kind'] == 'vst3' and not st['worker']['attached']:
            st['open'] = False
            st['error'] = st['error'] or 'the plugin worker is gone'
        return st

    def track_instrument_state(self) -> list:
        """界面要的：每条装了乐器的轨现在是哪件、开着没有、卡在哪。"""
        out = []
        with self._lock:
            for slot, st in enumerate(self._slots[:TRACK_SLOTS]):
                if st is None or not st.get('track'):
                    continue
                row = self._slot_public(slot)
                row['slot'] = slot
                out.append(row)
        return out


    # ── 状态 ──
    def _peak_pair(self) -> tuple:
        """(引擎, 插件) 两个峰值，都是千分比。界面那条电平表要的是其中大的那个。"""
        with self._lock:
            synth = int(self._lib.ka_peak())
            plug = 0
            if hasattr(self._lib, 'ka_vst3_peak_s'):
                for s in range(KA_MAX_PLUG):
                    if self._slot_open(s) and self._slots[s]['kind'] == 'vst3':
                        plug = max(plug, int(self._lib.ka_vst3_peak_s(s)))
        return synth, plug

    def levels(self) -> dict:
        """电平表的快读口（`GET /api/audio?levels=1`）：只报此刻的峰值。

        Monitor 每 33ms 问一次；`status()` 要遍历每个槽的 worker 状态、乐器清单和 debug 计数，
        拿来当电平轮询太贵。这里只读两个 int：引擎的 `ka_peak` 与各插件共享内存里的峰。"""
        if not (self.available and self._open):
            return {'peak': 0}
        synth, plug = self._peak_pair()
        return {'peak': max(synth, plug)}

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
            # 试听槽的乐器（老字段，探针与旧脚本照读）。工程里每条轨的那件在 `instruments`。
            'instrument': self._instrument_public(PREVIEW_SLOT),
            'plugin': self.plugin_state(),
            'instruments': self.track_instrument_state(),
        }
        if self.available and self._open:
            with self._lock:
                out['clockBound'] = bool(self._lib.ka_clock_bound())
                out['played'] = int(self._lib.ka_played())
                out['position'] = int(self._lib.ka_position())
                # 内置合成器与各支插件各报各的峰（都是千分比）；界面那个电平表要的是
                # "现在有没有声"，所以取大的那个 —— 不然装了插件之后表永远停在 0。
                synth, plug = self._peak_pair()
                out['peak'] = synth
                if plug:
                    out['pluginPeak'] = plug
                    if plug > out['peak']:
                        out['peak'] = plug
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
        # 时间线 PCM 只有一个合法作者（PCM_CLIENT_ABI 里说的会话）。**旧页面不带会话** ——
        # 它那边还在用 WebAudio 播同一段时间线，放它交 PCM 进引擎就是同一声放两遍。
        if op.startswith('pcm_'):
            if _i(payload.get('v'), 0) != PCM_CLIENT_ABI:
                print('[audio] rejected pcm_%s from a pre-unification page (reload the page)'
                      % op[4:], flush=True)
                return {'ok': False, 'error': 'stale pcm client (reload the page)'}
            sid = str(payload.get('session') or '')
            if not sid:
                return {'ok': False, 'error': 'pcm session required'}
            if op == 'pcm_claim':
                return self.pcm_claim(sid)
            if op == 'pcm_release':
                return self.pcm_release(sid)
            clip = str(payload.get('clip') or '')
            if not clip:
                return {'ok': False, 'error': 'pcm clip required'}
            if op == 'pcm_begin':
                return self.pcm_begin(sid, clip, _i(payload.get('frames'), 0),
                                      _i(payload.get('channels'), 2))
            if op == 'pcm_chunk':
                return self.pcm_chunk(sid, clip, _i(payload.get('offset'), 0),
                                      str(payload.get('data') or ''))
            if op == 'pcm_finish':
                return self.pcm_finish(sid, clip)
            if op == 'pcm_set':
                return self.pcm_set(sid, clip, _i(payload.get('gen'), 0),
                                    _i(payload.get('start'), 0), _i(payload.get('offset'), 0),
                                    _i(payload.get('length'), 0),
                                    1.0 if payload.get('gain') is None else float(payload.get('gain')))
            if op == 'pcm_clear':
                return self.pcm_clear(sid, clip, _i(payload.get('gen'), 0))
            return {'ok': False, 'error': 'unknown pcm op'}
        if op == 'track_instrument':
            return self.track_instrument(payload.get('track'), payload.get('path') or '')
        if op == 'track_unload':
            return self.track_unload(payload.get('track'))
        if op == 'editor_open':
            return self.editor_open(payload.get('track'))
        if op == 'editor_close':
            return self.editor_close(payload.get('track'))
        if op == 'editor_state':
            return self.editor_state(payload.get('track'))
        if op == 'editor_save':
            return self.editor_save(payload.get('track'), payload.get('path') or '')
        if op == 'preview':
            return self.preview(payload.get('path') or payload.get('preset') or '',
                                _i(payload.get('note'), -1), _i(payload.get('vel'), 100))
        if op == 'load_sfz':
            return self.load_instrument(payload.get('path') or payload.get('sfz') or '')
        if op == 'load_instrument':
            return self.load_instrument(payload.get('path') or payload.get('preset') or '')
        if op == 'unload_sfz' or op == 'unload_instrument':
            return self.unload_instrument()
        if op == 'plugin_open':
            return self.plugin_open(payload.get('path') or '', _i(payload.get('cls'), 0))
        if op == 'plugin_preset':
            return self.plugin_load_preset(payload.get('path') or payload.get('preset') or '')
        if op == 'plugin_close':
            return self.plugin_close()
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
