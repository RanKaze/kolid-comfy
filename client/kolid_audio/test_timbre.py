"""音色闸 —— 把"毛躁"拆成四条能离线复现的测量。

设备那条路上，一块什么时候来、播放头在哪都由声卡和时钟说了算，音色问题没法稳定复现。
所以这里走 ka_offline_begin / ka_render_offline：同一张音符表进去，同一串样本出来，
频谱和台阶都在这一串样本上量。

四条判据：
  1. 高音折返  —— C8 / E9 的方波（program 18）在旧实现里有 -30..-40dB 的折返峰，
                 现在换成加性带限振荡器，折返应低到 -50dB 以下；
  2. 和弦互调  —— 四个音一起响时，旧实现靠饱和曲线限幅，非谐波能量约 2%；
                 现在先做子块限幅再进饱和，应低于 0.2%；
  3. 换表重播  —— 播放途中重推音符表，旧实现会把已经播过的音全部重放；
                 现在从当前位置续上，只触发后面的音；
  4. 暂停台阶  —— 播放→暂停若把波形一步砍到 0，就是一声宽带咔哒；
                 现在走 12ms 释放，边界处不应出现大台阶。

用法：python test_timbre.py
"""

import ctypes
import math
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
DLL = HERE / "KolidAudio.dll"
RATE = 48000
BLOCK = 512

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


def load():
    if not DLL.exists():
        sys.exit(f"missing {DLL} - run build.ps1 first")
    d = ctypes.CDLL(str(DLL))
    d.ka_offline_begin.argtypes = [ctypes.c_int]
    d.ka_offline_begin.restype = None
    d.ka_render_offline.argtypes = [ctypes.POINTER(ctypes.c_int16), ctypes.c_int,
                                    ctypes.c_int64, ctypes.c_int]
    d.ka_render_offline.restype = ctypes.c_int
    d.ka_set_tracks.argtypes = [ctypes.POINTER(KaTrack), ctypes.c_int]
    d.ka_set_tracks.restype = ctypes.c_int
    d.ka_set_notes.argtypes = [ctypes.POINTER(KaNote), ctypes.c_int]
    d.ka_set_notes.restype = ctypes.c_int
    d.ka_debug.argtypes = [ctypes.POINTER(ctypes.c_int32), ctypes.c_int]
    d.ka_debug.restype = ctypes.c_int
    d.ka_stats_reset.restype = None
    return d


def start(d, track, notes):
    """重置离线引擎，推一条轨 + 一张表。"""
    d.ka_offline_begin(RATE)
    t = (KaTrack * 1)(KaTrack(*track))
    n = (KaNote * len(notes))(*[KaNote(*x) for x in notes])
    d.ka_set_tracks(t, 1)
    d.ka_set_notes(n, len(notes))


def render(d, frames, pos=0, playing=1):
    """从 pos 起渲染 frames 帧，返回交错立体声 int16 列表和新的 pos。"""
    out = []
    left = frames
    while left > 0:
        n = min(BLOCK, left)
        buf = (ctypes.c_int16 * (n * 2))()
        d.ka_render_offline(buf, n, pos, playing)
        out.extend(buf)
        pos += n
        left -= n
    return out, pos


def mono(x):
    return [x[i] / 32768.0 for i in range(0, len(x), 2)]


def fft(a):
    """原地基二 FFT（纯 Python，测试里只跑两次，不值得为它拉 numpy）。"""
    n = len(a)
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j ^= bit
        if i < j:
            a[i], a[j] = a[j], a[i]
    length = 2
    while length <= n:
        ang = -2.0 * math.pi / length
        wlen = complex(math.cos(ang), math.sin(ang))
        half = length >> 1
        for i in range(0, n, length):
            w = 1.0 + 0j
            for k in range(i, i + half):
                u = a[k]
                v = a[k + half] * w
                a[k] = u + v
                a[k + half] = u - v
                w *= wlen
        length <<= 1


def power_at(freqs, e, f, tol=3.0):
    """取 f 附近 ±tol Hz 内最大的一个 bin —— 频率不一定正好落在 bin 上。"""
    best = 0.0
    for i, x in enumerate(f):
        if abs(x - freqs) <= tol and e[i] > best:
            best = e[i]
    return best


def spectrum(y, n):
    """Hann 窗 + FFT，返回 (频率表, 功率表)。"""
    w = [0.5 - 0.5 * math.cos(2.0 * math.pi * i / (n - 1)) for i in range(n)]
    a = [complex(y[i] * w[i], 0.0) for i in range(n)]
    fft(a)
    half = n // 2
    e = [abs(a[i]) ** 2 for i in range(half)]
    f = [i * RATE / n for i in range(half)]
    return f, e


def note_hz(note):
    return 440.0 * 2.0 ** ((note - 69) / 12.0)


def alias_db(note, alias_hz):
    """方波高音：折返频率比基频低多少 dB。"""
    d = load()
    start(d, (18, 0, 1.0, 1.0, 0.5, 0, 0),
          [(0, note, 100, 0, 0, int(2.0 * RATE))])
    x, _ = render(d, int(1.2 * RATE))
    y = mono(x)[int(0.3 * RATE):int(0.3 * RATE) + 16384]
    f, e = spectrum(y, len(y))
    base = power_at(note_hz(note), e, f)
    alias = power_at(alias_hz, e, f)
    return 10.0 * math.log10(alias / base + 1e-30)


def inharmonic_pct():
    """四音和弦里落在谐波之外的能量占比（%）。"""
    d = load()
    notes = [60, 64, 67, 72]
    start(d, (0, 0, 1.0, 1.0, 0.5, 0, 0),
          [(0, p, 100, 0, 0, int(2.0 * RATE)) for p in notes])
    x, _ = render(d, int(2.0 * RATE))
    y = mono(x)[int(0.5 * RATE):int(0.5 * RATE) + 16384]
    f, e = spectrum(y, len(y))

    harm = [False] * len(f)
    for i, hz in enumerate(f):
        if hz < 40.0:
            harm[i] = True
    for p in notes:
        f0 = note_hz(p)
        k = 1
        while k * f0 < RATE / 2.0:
            for i, hz in enumerate(f):
                if abs(hz - k * f0) <= 12.0:
                    harm[i] = True
            k += 1
    total = sum(e)
    residue = sum(e[i] for i in range(len(e)) if not harm[i])
    return 100.0 * residue / total


def repush_fired():
    """播放途中重推同一张表，下一块会触发几个音（旧实现 ≈ 已播过的全部）。"""
    d = load()
    notes = [(0, 48 + (i % 12), 100, 0, int(i * 0.1 * RATE), int(0.09 * RATE))
             for i in range(60)]
    start(d, (0, 0, 1.0, 1.0, 0.5, 0, 0), notes)
    _, pos = render(d, int(1.2 * RATE))
    d.ka_stats_reset()
    n = (KaNote * len(notes))(*[KaNote(*z) for z in notes])
    d.ka_set_notes(n, len(notes))
    render(d, int(0.2 * RATE), pos)
    b = (ctypes.c_int32 * 19)()
    d.ka_debug(b, 19)
    return b[8], b[9], b[10]        # fired / late / steals


def pause_step():
    """播放→暂停那个边界上，相邻样本的最大台阶（满量程 = 1.0）。"""
    d = load()
    start(d, (0, 0, 1.0, 1.0, 0.5, 0, 0),
          [(0, 60, 100, 0, 0, int(4.0 * RATE))])
    x, pos = render(d, RATE)
    y = mono(x)
    buf = (ctypes.c_int16 * (BLOCK * 2))()
    d.ka_render_offline(buf, BLOCK, pos, 0)
    z = [buf[i] / 32768.0 for i in range(0, len(buf), 2)]
    return abs(z[0] - y[-1])


def main():
    if not DLL.exists():
        sys.exit(f"missing {DLL} - run build.ps1 first")

    a108 = alias_db(108, 18698.0)     # C8：旧实现 7 次谐波折返到 18.7k
    check("C8 方波没有强折返", a108 < -50.0, "%.1f dB" % a108)

    a112 = alias_db(112, 21630.0)     # E9：旧实现 5 次谐波折返到 21.6k
    check("E9 方波没有强折返", a112 < -50.0, "%.1f dB" % a112)

    ih = inharmonic_pct()
    check("四音和弦的非谐波能量很低", ih < 0.2, "%.4f%%" % ih)

    fired, late, steals = repush_fired()
    check("播放途中重推音符表不会重放旧音", fired <= 6,
          "fired=%d late=%d steals=%d" % (fired, late, steals))

    step = pause_step()
    check("暂停边界没有硬台阶", step < 0.05, "%.4f" % step)

    print()
    if failed:
        print("%d passed, %d failed" % (len(passed), len(failed)))
        return 1
    print("all %d checks passed" % len(passed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
