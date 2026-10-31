"""SFZ 采样器的离线验证（不碰 ComfyUI）。

三件事，缺一件就等于没接通：
  1. 解析：一个最小 .sfz 里 region 的 key/vel/loop/gain 都落到了 zone 上；
  2. 解码：wav（PCM16 / PCM24 / float32）都被读成 float，帧数对得上；
  3. 出声：装载之后按一个音，声卡真的在消耗样本，且峰值不为 0。

用法：python test_sfz.py
"""

import ctypes
import math
import pathlib
import struct
import sys
import tempfile
import time
import wave

HERE = pathlib.Path(__file__).resolve().parent
DLL = HERE / "KolidAudio.dll"
CLOCK = HERE.parent / "kolid_clock" / "KolidClock.dll"
RATE = 48000

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


# ── 造素材 ────────────────────────────────────────────────────────────────────
def make_wav(path, seconds=1.0, rate=44100, ch=1, bits=16, hz=440.0):
    n = int(seconds * rate)
    frames = bytearray()
    for i in range(n):
        v = math.sin(2 * math.pi * hz * i / rate) * 0.5
        s = int(v * 32767)
        for _ in range(ch):
            if bits == 16:
                frames += struct.pack("<h", s)
            elif bits == 24:
                frames += struct.pack("<i", s << 8)[0:3]
            else:
                frames += struct.pack("<i", s << 16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(ch)
        w.setsampwidth(bits // 8)
        w.setframerate(rate)
        w.writeframes(bytes(frames))


def make_float_wav(path, seconds=0.5, rate=48000):
    n = int(seconds * rate)
    data = b"".join(struct.pack("<f", math.sin(2 * math.pi * 440.0 * i / rate) * 0.5) for i in range(n))
    fmt = struct.pack("<HHIIHH", 3, 1, rate, rate * 4, 4, 32)
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(data)) + data
    path.write_bytes(b"RIFF" + struct.pack("<I", len(body)) + body)


class KaTrack(ctypes.Structure):
    _fields_ = [("program", ctypes.c_int32), ("channel", ctypes.c_int32),
                ("vel_scale", ctypes.c_float), ("gain", ctypes.c_float),
                ("pan", ctypes.c_float), ("mute", ctypes.c_int32), ("solo", ctypes.c_int32)]


class KaNote(ctypes.Structure):
    _fields_ = [("track", ctypes.c_int32), ("note", ctypes.c_int32), ("vel", ctypes.c_int32),
                ("pad", ctypes.c_int32), ("start", ctypes.c_int64), ("len", ctypes.c_int64)]


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


def load():
    if not DLL.exists():
        sys.exit(f"missing {DLL} - run build.ps1 first")
    d = ctypes.CDLL(str(DLL))
    d.ka_open.argtypes = [ctypes.c_int]
    d.ka_open.restype = ctypes.c_int
    d.ka_close.restype = None
    d.ka_peak.restype = ctypes.c_int
    d.ka_position.restype = ctypes.c_int64
    d.ka_played.restype = ctypes.c_int64
    d.ka_is_open.restype = ctypes.c_int
    d.ka_load_sfz.argtypes = [ctypes.c_wchar_p]
    d.ka_load_sfz.restype = ctypes.c_int
    d.ka_unload_sfz.restype = None
    d.ka_sfz_err.restype = ctypes.c_int
    d.ka_sfz_state.argtypes = [ctypes.POINTER(ctypes.c_int32), ctypes.c_int]
    d.ka_sfz_state.restype = ctypes.c_int
    d.ka_sfz_zone.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    d.ka_sfz_zone.restype = ctypes.c_int
    d.ka_audition.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
    d.ka_all_notes_off.restype = None
    d.ka_bind_clock.argtypes = [ctypes.c_char_p]
    d.ka_bind_clock.restype = ctypes.c_int
    d.ka_set_tracks.argtypes = [ctypes.POINTER(KaTrack), ctypes.c_int]
    d.ka_set_tracks.restype = ctypes.c_int
    d.ka_set_notes.argtypes = [ctypes.POINTER(KaNote), ctypes.c_int]
    d.ka_set_notes.restype = ctypes.c_int
    return d


def sfz_state(d):
    buf = (ctypes.c_int32 * 3)()
    d.ka_sfz_state(buf, 3)
    return list(buf)


def zone_info(d, i):
    buf = ctypes.create_string_buffer(512)
    if d.ka_sfz_zone(i, buf, 512) <= 0:
        return ""
    return buf.value.decode("utf-8", "replace")


def main():
    d = load()
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="kolid-sfz-"))

    # ── 1. 解析 + 解码 ────────────────────────────────────────────────────────
    make_wav(tmp / "tone.wav", seconds=1.0, rate=44100, ch=1, bits=16)
    (tmp / "basic.sfz").write_text(
        "// minimal\n"
        "<group> ampeg_attack=0.001 ampeg_release=0.2\n"
        "<region> sample=tone.wav lokey=0 hikey=127 pitch_keycenter=60 lovel=0 hivel=127\n"
        "         loop_mode=loop_continuous loop_start=1000 loop_end=44099 volume=-6\n",
        encoding="utf-8")

    n = d.ka_load_sfz(str(tmp / "basic.sfz"))
    check("load returns zone count", n == 1, f"{n} err={d.ka_sfz_err()}")
    st = sfz_state(d)
    check("one zone, no failures", st[0] == 1 and st[1] == 0, st)
    info = zone_info(d, 0)
    check("zone info shape", info.startswith("tone.wav|60|0-127|0-127|44100|44100"), info)

    # 相对路径 + 多 zone + 中文目录名（UTF-16 路径这一步）
    sub = tmp / "中文 音色"
    sub.mkdir()
    make_wav(sub / "a16.wav", seconds=0.3, bits=16)
    make_wav(sub / "a24.wav", seconds=0.3, bits=24)
    (sub / "multi.sfz").write_text(
        "<region> sample=a16.wav lokey=0 hikey=59 pitch_keycenter=48\n"
        "<region> sample=a24.wav lokey=60 hikey=127 pitch_keycenter=72\n",
        encoding="utf-8")
    n = d.ka_load_sfz(str(sub / "multi.sfz"))
    check("two zones under a non-ascii path", n == 2, n)
    z1 = zone_info(d, 1)
    check("zone 1 maps the upper keys", "|72|60-127|" in z1, z1)

    # 24 位要真的解出来：帧数 = 0.3 * 44100 = 13230
    check("24-bit decoded to frames", z1.endswith("|13230"), z1)

    # float32 wav
    make_float_wav(tmp / "f32.wav")
    (tmp / "f32.sfz").write_text("<region> sample=f32.wav pitch_keycenter=60\n", encoding="utf-8")
    n = d.ka_load_sfz(str(tmp / "f32.sfz"))
    check("float32 wav loads", n == 1, n)
    check("float32 frames", zone_info(d, 0).endswith("|24000"), zone_info(d, 0))

    # 坏路径 / 空 sfz 要如实报错，不是静默成功
    check("missing file -> -1", d.ka_load_sfz(str(tmp / "nope.sfz")) == -1)
    (tmp / "empty.sfz").write_text("// nothing here\n", encoding="utf-8")
    check("no region -> -2", d.ka_load_sfz(str(tmp / "empty.sfz")) == -2)
    (tmp / "badwav.sfz").write_text("<region> sample=nope.wav pitch_keycenter=60\n", encoding="utf-8")
    check("undecodable sample -> -3", d.ka_load_sfz(str(tmp / "badwav.sfz")) == -3)

    # ── 2. 出声 ───────────────────────────────────────────────────────────────
    # 走的是界面上真实的那条链：时钟播放 → 音符表 → 声部。ka_audition 也测，但它只是 Ctrl+点
    # 试听那条旁路；主路径必须自己能响。
    r = d.ka_open(RATE)
    check("device opens", r == 0, r)
    if r == 0:
        clock = load_clock()
        check("clock binds", d.ka_bind_clock(str(CLOCK).encode()) == 1)

        tracks = (KaTrack * 1)()
        tracks[0] = KaTrack(0, 0, 1.0, 1.0, 0.5, 0, 0)
        d.ka_set_tracks(tracks, 1)

        def play_once():
            # 音符不能排在 0 帧：seek(0) 之后音频线程第一块就已经追到几百帧外，start=0 的音符
            # 会被当成"已经过去了"直接跳过（这条当初让 peak 一直是 0）。排在 0.4 秒处。
            notes = (KaNote * 1)()
            notes[0] = KaNote(0, 60, 110, 0, int(0.4 * RATE), int(0.4 * RATE))
            d.ka_set_notes(notes, 1)
            clock.kc_seek_frames(0)
            clock.kc_play()
            top = 0
            for _ in range(26):
                time.sleep(0.03)
                top = max(top, d.ka_peak())
            clock.kc_pause()
            time.sleep(0.08)
            return top

        n = d.ka_load_sfz(str(tmp / "basic.sfz"))
        check("reload before playing", n == 1, n)
        peak = play_once()
        check("sample voice produced signal", peak > 20, f"peak={peak}")

        # 卸掉之后必须回到合成器（不是静音）——这是"切乐器不能把程序改成只会采样"的闸。
        d.ka_all_notes_off()
        d.ka_unload_sfz()
        check("unload clears zones", sfz_state(d)[0] == 0, sfz_state(d))
        peak2 = play_once()
        check("synth still sounds after unload", peak2 > 20, f"peak={peak2}")
        d.ka_close()

    print()
    if failed:
        print(f"{len(failed)} failed / {len(passed) + len(failed)}")
        for f in failed:
            print("  - " + f)
        sys.exit(1)
    print(f"all {len(passed)} checks passed")


if __name__ == "__main__":
    main()
