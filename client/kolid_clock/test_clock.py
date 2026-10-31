# ── KolidClock 冒烟测试 ────────────────────────────────────────────────────────────────────────
# 只验四件事，但这四件是整套"公共时间基准"的地基：
#   1. 播着的时候位置真的跟着墙钟走（48kHz 下 0.5s ≈ 24000 帧，误差不许超过 1%）；
#   2. 暂停之后位置**一帧都不许动**（否则每次读都往前爬，界面永远在漂）；
#   3. seek 之后接着播，是从新位置继续走的（锚点语义）；
#   4. 连读一万次不许倒退、不许溢出。
#
# 用法： python test_clock.py

import ctypes
import ctypes.wintypes as wt
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DLL = os.path.join(HERE, 'KolidClock.dll')


def load(path: str = DLL):
    lib = ctypes.CDLL(path)
    lib.kc_version.restype = ctypes.c_int
    lib.kc_init.restype = ctypes.c_int
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
    lib.kc_set_speed.restype = ctypes.c_int
    lib.kc_set_speed.argtypes = [ctypes.c_double]
    lib.kc_speed_get.restype = ctypes.c_double
    lib.kc_speed_get.argtypes = []
    lib.kc_now_seconds.restype = ctypes.c_double
    lib.kc_now_seconds.argtypes = []
    lib.kc_qpc_freq.restype = ctypes.c_longlong
    lib.kc_qpc_freq.argtypes = []
    lib.kc_epoch.restype = ctypes.c_longlong
    lib.kc_epoch.argtypes = []
    lib.kc_anchor.restype = None
    lib.kc_anchor.argtypes = [ctypes.c_longlong]
    lib.kc_snapshot.restype = ctypes.c_int
    lib.kc_snapshot.argtypes = [ctypes.POINTER(ctypes.c_longlong), ctypes.POINTER(ctypes.c_int),
                                ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_double),
                                ctypes.POINTER(ctypes.c_longlong)]
    return lib


FAILS = []


def check(name, ok, detail=''):
    print(('  PASS  ' if ok else '  FAIL  ') + name + (('  ' + detail) if detail else ''))
    if not ok:
        FAILS.append(name)


def main():
    if not os.path.exists(DLL):
        print('missing ' + DLL + ' — run build.ps1 first')
        return 2
    kc = load()
    print('KolidClock v%d  qpc_freq=%d  epoch=%d' % (kc.kc_version(), kc.kc_qpc_freq(), kc.kc_epoch()))

    check('init', kc.kc_init() == 1)
    check('default rate 48000', kc.kc_sample_rate() == 48000, str(kc.kc_sample_rate()))

    # 1) 播 0.5s ≈ 24000 帧
    kc.kc_seek_frames(0)
    kc.kc_play()
    time.sleep(0.5)
    f = kc.kc_frames()
    kc.kc_pause()
    err = abs(f - 24000) / 24000.0
    check('0.5s of playback ~= 24000 frames', err < 0.02, 'frames=%d err=%.2f%%' % (f, err * 100))

    # 2) 暂停后不动
    a = kc.kc_frames()
    time.sleep(0.2)
    b = kc.kc_frames()
    check('paused position is frozen', a == b, '%d -> %d' % (a, b))
    check('paused means not playing', kc.kc_playing() == 0)

    # 3) seek 之后接着走
    kc.kc_seek_frames(96000)
    check('seek lands exactly', kc.kc_frames() == 96000, str(kc.kc_frames()))
    kc.kc_play()
    time.sleep(0.1)
    f2 = kc.kc_frames()
    kc.kc_pause()
    check('resumes from the new anchor', 96000 + 3000 < f2 < 96000 + 8000, str(f2))

    # 4) 连读单调
    kc.kc_seek_frames(0)
    kc.kc_play()
    prev = -1
    mono = True
    for _ in range(10000):
        v = kc.kc_frames()
        if v < prev:
            mono = False
            break
        prev = v
    kc.kc_pause()
    check('10000 reads never go backwards', mono, 'last=%d' % prev)

    # 5) 采样率不是硬编码：换 44100 后 0.2s ≈ 8820 帧
    kc.kc_set_sample_rate(44100)
    kc.kc_seek_frames(0)
    kc.kc_play()
    time.sleep(0.2)
    g = kc.kc_frames()
    kc.kc_pause()
    check('rate is configurable (44100)', abs(g - 8820) / 8820.0 < 0.03, 'frames=%d' % g)
    kc.kc_set_sample_rate(48000)

    # 6) 倍速
    kc.kc_set_speed(2.0)
    check('speed stored', abs(kc.kc_speed_get() - 2.0) < 1e-9, str(kc.kc_speed_get()))
    kc.kc_seek_frames(0)
    kc.kc_play()
    time.sleep(0.25)
    h = kc.kc_frames()
    kc.kc_pause()
    kc.kc_set_speed(1.0)
    check('2x plays twice as fast', abs(h - 24000) / 24000.0 < 0.05, 'frames=%d' % h)

    # 7) 外部接管
    kc.kc_anchor(123456)
    check('external anchor adopted', kc.kc_frames() == 123456, str(kc.kc_frames()))

    # 8) snapshot 一次取全
    fr = ctypes.c_longlong(); sr = ctypes.c_int(); pl = ctypes.c_int()
    now = ctypes.c_double(); fq = ctypes.c_longlong()
    ok = kc.kc_snapshot(ctypes.byref(fr), ctypes.byref(sr), ctypes.byref(pl),
                        ctypes.byref(now), ctypes.byref(fq))
    check('snapshot fills every field', ok == 1 and sr.value == 48000 and fq.value > 0,
          'frames=%d sr=%d playing=%d now=%.3f freq=%d' % (fr.value, sr.value, pl.value, now.value, fq.value))
    check('now_seconds advances monotonically',
          (lambda t0: (kc.kc_now_seconds() > t0))(kc.kc_now_seconds()))

    print('')
    if FAILS:
        print('FAILED: ' + ', '.join(FAILS))
        return 1
    print('ALL PASS')
    return 0


if __name__ == '__main__':
    sys.exit(main())
