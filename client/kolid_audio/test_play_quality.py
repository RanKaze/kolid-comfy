"""播放质量闸 —— 把"音质差 / 不同步 / 漏音"这三句抱怨翻译成四个能看的数。

不听耳朵，看计数：
  fired   —— 音符表里每个音都真的被触发了吗？少一个就是**漏音**。
  late    —— 有几个是位置跳过去之后补发的（应该很少；很多说明位置推进不连续）。
  steals  —— 抢过几次声部（一直涨 = 声部不够，音会被拦腰截断）。
  drift   —— 引擎位置与权威时钟差多少帧（大 = 同步差）。

外加一条**听感**上的硬指标：把每个音符的时间窗单独采一遍峰值，
整段里"该响的时候是静音"的窗数必须为零 —— 这才是用户说的"有音节没有正常响"。

跑法： python client/kolid_audio/test_play_quality.py
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
    _fields_ = [("program", ctypes.c_int32), ("channel", ctypes.c_int32),
                ("vel_scale", ctypes.c_float), ("gain", ctypes.c_float),
                ("pan", ctypes.c_float), ("mute", ctypes.c_int32), ("solo", ctypes.c_int32)]


class KaNote(ctypes.Structure):
    _fields_ = [("track", ctypes.c_int32), ("note", ctypes.c_int32),
                ("vel", ctypes.c_int32), ("pad", ctypes.c_int32),
                ("start", ctypes.c_int64), ("len", ctypes.c_int64)]


def dbg(d):
    b = (ctypes.c_int32 * 14)()
    n = d.ka_debug(b, 14)
    if n < 14:
        raise SystemExit("ka_debug 只给了 %d 个字段，需要 14 —— DLL 太旧" % n)
    return {"loops": b[0], "write_ok": b[1], "write_err": b[2], "peak": b[3],
            "open": b[4], "voices": b[5], "seeks": b[6], "bound": b[7],
            "fired": b[8], "late": b[9], "steals": b[10], "drift": b[11],
            "drift_max": b[12], "voices_used": b[13]}


def main():
    d = ctypes.CDLL(str(DLL))
    d.ka_open.argtypes = [ctypes.c_int]
    d.ka_open.restype = ctypes.c_int
    d.ka_bind_clock.argtypes = [ctypes.c_char_p]
    d.ka_set_notes.argtypes = [ctypes.POINTER(KaNote), ctypes.c_int]
    d.ka_set_tracks.argtypes = [ctypes.POINTER(KaTrack), ctypes.c_int]
    d.ka_debug.argtypes = [ctypes.POINTER(ctypes.c_int32), ctypes.c_int]
    d.ka_peak.restype = ctypes.c_int
    d.ka_stats_reset.restype = None

    clock = ctypes.CDLL(str(CLOCK))
    clock.kc_init.restype = ctypes.c_int
    clock.kc_set_sample_rate.argtypes = [ctypes.c_int]
    clock.kc_frames.restype = ctypes.c_longlong
    clock.kc_playing.restype = ctypes.c_int
    clock.kc_seek_frames.argtypes = [ctypes.c_longlong]
    clock.kc_init()
    clock.kc_set_sample_rate(RATE)

    if d.ka_open(RATE) != 0:
        check("打开声卡", False, "MMSYSERR!=0")
        return finish()
    if d.ka_bind_clock(str(CLOCK).encode()) != 1:
        check("绑上时钟", False)
        return finish()

    tracks = (KaTrack * 1)()
    tracks[0] = KaTrack(0, 0, 1.0, 1.0, 0.5, 0, 0)
    d.ka_set_tracks(tracks, 1)

    # 48 个音，每 0.2 秒一个，每个长 0.15 秒 —— 首尾相接但不重叠，
    # 这样每个音都有自己的时间窗，漏没漏一采就知道。
    N = 48
    GAP = 0.20
    LEN = 0.15
    notes = (KaNote * N)()
    for i in range(N):
        notes[i] = KaNote(0, 60 + (i % 8) * 2, 100, 0,
                          int(i * GAP * RATE), int(LEN * RATE))

    d.ka_stats_reset()
    d.ka_set_notes(notes, N)
    clock.kc_seek_frames(0)
    clock.kc_play()

    # 逐个音符窗采峰值：窗内连采 8 次取最大，躲开包络起落与采样时机。
    silent_windows = []
    peaks_seen = []
    drifts = []
    t0 = time.time()
    for i in range(N):
        # 走到这个音该响的时刻（时钟为准，不是 sleep 累加 —— 累加会漂）
        want_at = i * GAP + 0.02
        while True:
            now = clock.kc_frames() / float(RATE)
            if now >= want_at:
                break
            if time.time() - t0 > 60:
                break
            time.sleep(0.004)
        pk = 0
        for _ in range(8):
            pk = max(pk, d.ka_peak())
            if i >= 4:                       # 头几个窗是开机过程，不计入
                drifts.append(abs(dbg(d)["drift"]))
            time.sleep(0.008)
        peaks_seen.append(pk)
        if pk <= 0:
            silent_windows.append(i)

    st = dbg(d)
    clock.kc_pause()
    d.ka_close()

    print("   fired=%d late=%d steals=%d drift=%d drift_max=%d seeks=%d"
          % (st["fired"], st["late"], st["steals"], st["drift"], st["drift_max"], st["seeks"]))
    print("   peaks=%s" % peaks_seen[:16])
    print("   稳态偏差(帧): 中位=%d 最大=%d 样本=%d"
          % (sorted(drifts)[len(drifts) // 2] if drifts else -1,
             max(drifts) if drifts else -1, len(drifts)))

    check("每个音都被触发了（不漏音）", st["fired"] >= N,
          "fired=%d / %d" % (st["fired"], N))
    # 开播头一秒设备还没报位置，会有几个音被"补发"。补发也算响了（不是漏音），
    # 所以这里放宽到 4；真正要盯的是 fired 必须等于音符数。
    check("几乎没有迟到补发的音", st["late"] <= 4, "late=%d" % st["late"])
    check("不抢声部", st["steals"] == 0, "steals=%d" % st["steals"])
    check("没有一个是静音窗（该响的都响了）", not silent_windows,
          "silent=%s" % silent_windows[:8])
    check("与时钟的偏差在一块以内", abs(st["drift"]) <= 512, "drift=%d" % st["drift"])
    check("稳态偏差一直在一块以内（不是靠最后一次采样蒙的）",
          bool(drifts) and max(drifts) <= 512, "max=%d" % (max(drifts) if drifts else -1))
    check("播放途中没有硬跳（seek）", st["seeks"] <= 1, "seeks=%d" % st["seeks"])
    check("设备写入没报错", st["write_err"] == 0, "err=%d" % st["write_err"])
    check("电平没有一直顶在天花板上（没削波）",
          max(peaks_seen) < 999, "max=%d‰" % max(peaks_seen))
    return finish()


def finish():
    print()
    if failed:
        print("%d passed, %d failed" % (len(passed), len(failed)))
        return 1
    print("all %d checks passed" % len(passed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
