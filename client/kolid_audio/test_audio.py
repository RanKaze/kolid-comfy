"""KolidAudio.dll 冒烟测试：设备、合成器、时钟跟随。

三层判据，缺一层都不算"出声"：
  1. waveOutOpen 返回 0            —— 设备打开；
  2. ka_played() 持续增长、ka_peak() > 0 —— 驱动在消耗我们写的样本，且缓冲里真的有声音；
  3. ka_position() 跟 kc_frames() 对齐 —— 声音在走带上的位置就是界面显示的位置。

用法：python test_audio.py
"""

import ctypes
import pathlib
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
DLL = HERE / "KolidAudio.dll"
CLOCK = HERE.parent / "kolid_clock" / "KolidClock.dll"

RATE = 48000
passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


class KaTrack(ctypes.Structure):
    _fields_ = [
        ("program", ctypes.c_int32),
        ("channel", ctypes.c_int32),
        ("vel_scale", ctypes.c_float),
        ("gain", ctypes.c_float),
        ("pan", ctypes.c_float),
        ("mute", ctypes.c_int32),
        ("solo", ctypes.c_int32),
    ]


class KaNote(ctypes.Structure):
    _fields_ = [
        ("track", ctypes.c_int32),
        ("note", ctypes.c_int32),
        ("vel", ctypes.c_int32),
        ("pad", ctypes.c_int32),
        ("start", ctypes.c_int64),
        ("len", ctypes.c_int64),
    ]


def load():
    if not DLL.exists():
        sys.exit(f"missing {DLL} - run build.ps1 first")
    d = ctypes.CDLL(str(DLL))
    d.ka_version.restype = ctypes.c_int
    d.ka_open.argtypes = [ctypes.c_int]
    d.ka_open.restype = ctypes.c_int
    d.ka_close.restype = None
    d.ka_is_open.restype = ctypes.c_int
    d.ka_sample_rate.restype = ctypes.c_int
    d.ka_played.restype = ctypes.c_longlong
    d.ka_position.restype = ctypes.c_longlong
    d.ka_peak.restype = ctypes.c_int
    d.ka_bind_clock.argtypes = [ctypes.c_char_p]
    d.ka_bind_clock.restype = ctypes.c_int
    d.ka_clock_bound.restype = ctypes.c_int
    d.ka_set_notes.argtypes = [ctypes.POINTER(KaNote), ctypes.c_int]
    d.ka_set_notes.restype = ctypes.c_int
    d.ka_set_tracks.argtypes = [ctypes.POINTER(KaTrack), ctypes.c_int]
    d.ka_set_tracks.restype = ctypes.c_int
    d.ka_all_notes_off.restype = None
    d.ka_debug.argtypes = [ctypes.POINTER(ctypes.c_int32), ctypes.c_int]
    d.ka_debug.restype = ctypes.c_int
    return d


def dbg(d):
    b = (ctypes.c_int32 * 8)()
    d.ka_debug(b, 8)
    return {
        "loops": b[0], "write_ok": b[1], "write_err": b[2], "peak": b[3],
        "open": b[4], "voices": b[5], "seeks": b[6], "bound": b[7],
    }


def load_clock():
    c = ctypes.CDLL(str(CLOCK))
    c.kc_init.restype = ctypes.c_int
    c.kc_set_sample_rate.argtypes = [ctypes.c_int]
    c.kc_set_sample_rate.restype = ctypes.c_int
    c.kc_frames.restype = ctypes.c_longlong
    c.kc_playing.restype = ctypes.c_int
    c.kc_play.restype = None
    c.kc_pause.restype = None
    c.kc_seek_frames.argtypes = [ctypes.c_longlong]
    c.kc_seek_frames.restype = None
    c.kc_init()
    c.kc_set_sample_rate(RATE)
    return c


def main():
    d = load()
    check("版本号", d.ka_version() == 1, f"v{d.ka_version()}")

    err = d.ka_open(RATE)
    check("打开默认声卡（waveOut）", err == 0, f"MMSYSERR={err}")
    if err != 0:
        return finish()

    clock = load_clock()
    bound = d.ka_bind_clock(str(CLOCK).encode())
    check("绑上公共时钟 KolidClock", bound == 1, f"bound={d.ka_clock_bound()}")

    tracks = (KaTrack * 2)()
    tracks[0] = KaTrack(0, 0, 1.0, 1.0, 0.5, 0, 0)    # 钢琴
    tracks[1] = KaTrack(0, 9, 1.0, 0.9, 0.5, 0, 0)    # channel 9 = 鼓
    check("推轨道表", d.ka_set_tracks(tracks, 2) == 2)

    notes = (KaNote * 12)()
    for i in range(8):                                  # C 大调音阶，每 0.25s 一个
        notes[i] = KaNote(0, 60 + i * 2, 100, 0, int(i * 0.25 * RATE), int(0.22 * RATE))
    for i in range(4):                                  # 每 0.5s 一记底鼓
        notes[8 + i] = KaNote(1, 36, 110, 0, int(i * 0.5 * RATE), int(0.2 * RATE))
    check("推音符表", d.ka_set_notes(notes, 12) == 12)

    clock.kc_seek_frames(0)
    clock.kc_play()
    # 连采若干次取最大：音阶之间有 30ms 空隙，单次采样正好落在空隙里会误判成没声音。
    peak_max = 0
    for _ in range(12):
        time.sleep(0.05)
        peak_max = max(peak_max, d.ka_peak())
    st = dbg(d)
    d1 = d.ka_played()
    pos = d.ka_position()
    fr = clock.kc_frames()
    check("设备在消耗缓冲", d1 > 0, f"played={d1}")
    check("有声音（峰值非零）", peak_max > 0, f"peak={peak_max}‰ voices={st['voices']}")
    check("音频位置跟随时钟（<150ms）", abs(pos - fr) < int(0.15 * RATE), f"pos={pos} clock={fr} 差={pos - fr}")

    time.sleep(0.40)
    before = d.ka_peak()
    clock.kc_pause()
    time.sleep(0.45)
    st2 = dbg(d)
    check("暂停后静音", st2["peak"] == 0, f"暂停前 peak={before} 暂停后={st2['peak']}")

    # 试听**不看传输的脸色**：暂停着也要能响。
    # 老实现把「!playing」整块短路成静音，而试听音的触发排在短路之后 —— 于是暂停时点 ♪ 一声不出。
    # 顺带验第二条：试听音绕开轨道增益，M/S 或"还没推过轨道表"都掐不掉它。
    tracks[0].mute = 1
    tracks[1].mute = 1
    d.ka_set_tracks(tracks, 2)
    time.sleep(0.2)
    d.ka_audition(60, 100, 0)
    ap = []
    for _ in range(16):
        time.sleep(0.05)
        ap.append(d.ka_peak())
    check("暂停时试听也出声（全轨静音也掐不掉）", max(ap) > 0, f"peaks={ap[:6]}… max={max(ap)}")
    time.sleep(0.9)
    tracks[0].mute = 0
    tracks[1].mute = 0
    d.ka_set_tracks(tracks, 2)

    clock.kc_seek_frames(int(2.0 * RATE))
    clock.kc_play()
    time.sleep(0.45)
    pos2 = d.ka_position()
    fr2 = clock.kc_frames()
    check("seek 后位置跟上", abs(pos2 - fr2) < int(0.2 * RATE), f"pos={pos2} clock={fr2}")
    check("seek 被记了一笔", dbg(d)["seeks"] > 0, f"seeks={dbg(d)['seeks']}")

    tracks[0].mute = 1
    tracks[1].mute = 1
    d.ka_set_tracks(tracks, 2)
    time.sleep(0.35)
    check("全部静音后峰值归零", d.ka_peak() == 0, f"peak={d.ka_peak()}")

    d.ka_all_notes_off()
    d.ka_close()
    clock.kc_pause()
    check("关闭后 is_open 归零", d.ka_is_open() == 0)
    check("关闭后 played 报 -1", d.ka_played() == -1)
    check("关两次不炸", (d.ka_close(), True)[1])
    return finish()


def finish():
    print(f"\n{len(passed)} passed, {len(failed)} failed")
    if failed:
        print("failed: " + ", ".join(failed))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
