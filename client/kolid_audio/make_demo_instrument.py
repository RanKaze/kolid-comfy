"""造一个能立刻听见的示例乐器（3 个采样覆盖整个键盘）。

为什么需要它：`F:\\Cubase Lib` 那种库里一个 `.sfz` 都没有（全是 Kontakt 的 .nki 与 HALion 的
.vstsound），引擎读不了。有一个真的能响的 SFZ，才能证明"采样这条路"是通的，而不是又一层
"列表里有、点了不响"。

产物：data/sampler/demo-keys/{demo-keys.sfz, epiano-C2.wav, epiano-C4.wav, epiano-C6.wav}

音色：加法合成的电钢琴 —— 五个泛音、各自按不同速度衰减。不是钢琴，但一听就知道是"录下来的
一个音"而不是正弦波，这正是采样与合成器的区别。

用法：python make_demo_instrument.py
"""

import math
import pathlib
import struct
import wave

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent.parent / "data" / "sampler" / "demo-keys"
RATE = 48000
DUR = 1.5           # 秒；loop 点在 0.5s 之后
LOOP_S = 0.55

# (泛音, 振幅, 衰减速率)
PARTIALS = [(1, 1.00, 1.1), (2, 0.52, 1.9), (3, 0.26, 2.8), (4, 0.13, 3.7), (5, 0.07, 4.6)]

NOTES = [
    ("epiano-C2", 65.406),     # C2
    ("epiano-C4", 261.626),    # C4
    ("epiano-C6", 1046.502),   # C6
]


def render(freq):
    n = int(DUR * RATE)
    buf = [0.0] * n
    for h, amp, dec in PARTIALS:
        f = freq * h
        if f >= RATE / 2:
            break
        w = 2 * math.pi * f / RATE
        for i in range(n):
            t = i / RATE
            buf[i] += amp * math.exp(-t * dec) * math.sin(w * i)
    peak = max(abs(v) for v in buf) or 1.0
    return [v * 0.62 / peak for v in buf]


def loop_points(freq):
    """把 loop 点对齐到整周期 —— 不对齐的话每次回绕都会咔一声（相位跳变）。"""
    period = RATE / freq
    start = int(round((LOOP_S * RATE) / period)) * period
    end = int(round((DUR - 0.02) * RATE / period)) * period
    return int(start), int(end), period


def write_wav(path, samples):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", max(-32768, min(32767, int(v * 32767)))) for v in samples))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    lines = [
        "// Kolid demo instrument - 3 samples stretched across the keyboard.",
        "// Double-click it in Assets -> Instruments to load it into the native engine.",
        "<group> ampeg_attack=0.003 ampeg_decay=1.6 ampeg_sustain=0 ampeg_release=0.35",
        "        amp_veltrack=80 loop_mode=loop_continuous",
    ]
    zones = [("epiano-C2", 36, 0, 47), ("epiano-C4", 60, 48, 71), ("epiano-C6", 84, 72, 127)]
    for (name, freq), (_, key, lo, hi) in zip(NOTES, zones):
        samples = render(freq)
        write_wav(OUT / (name + ".wav"), samples)
        ls, le, _ = loop_points(freq)
        lines.append(
            "<region> sample=%s.wav lokey=%d hikey=%d pitch_keycenter=%d lovel=0 hivel=127 "
            "loop_start=%d loop_end=%d" % (name, lo, hi, key, ls, le)
        )
        print("%s.wav  %d frames  loop %d..%d  (%.1f KB)" % (
            name, len(samples), ls, le, (OUT / (name + ".wav")).stat().st_size / 1024))
    (OUT / "demo-keys.sfz").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("->", OUT / "demo-keys.sfz")


if __name__ == "__main__":
    main()
