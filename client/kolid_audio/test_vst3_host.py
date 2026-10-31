"""VST3 宿主闸 —— 用自己的插件当尺子，量宿主这一侧到底对不对。

为什么要自带插件：本机装的那批（Ample Sound / Kontakt / HALion）都是采样乐器，装上之后
一片静音。静音既可能"宿主送错了缓冲"，也可能"它自己没有音色库/授权"，光看它们分不清。
`testplug/KaTestSynth.vst3` 是这里自己编的最小插件：只听 noteOn/noteOff、只出一根正弦，
它响就说明宿主的通道是通的。

跑法： python client/kolid_audio/test_vst3_host.py
      python client/kolid_audio/test_vst3_host.py --real    # 再把本机真插件挨个试一遍
"""

import ctypes
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from plugin_worker import PluginWorker          # noqa: E402
PLUG = os.path.join(HERE, 'testplug', 'KaTestSynth.vst3')
VST3_DIR = r'C:\Program Files\Common Files\VST3'
RATE = 48000
BLOCK = 512

ok = 0
bad = 0


def check(name, cond, detail=''):
    global ok, bad
    if cond:
        ok += 1
        print('PASS  %s' % name + (('  (%s)' % detail) if detail else ''))
    else:
        bad += 1
        print('FAIL  %s' % name + (('  (%s)' % detail) if detail else ''))


def bind(w):
    d = w.dll
    for n, a, r in [
        ('ka_vst3_scan', [ctypes.c_wchar_p], ctypes.c_int),
        ('ka_vst3_open', [ctypes.c_wchar_p, ctypes.c_int], ctypes.c_int),
        ('ka_vst3_close', [], None),
        ('ka_vst3_note', [ctypes.c_int] * 4, ctypes.c_int),
        ('ka_vst3_render', [ctypes.c_void_p, ctypes.c_int], ctypes.c_int),
        ('ka_vst3_peak', [], ctypes.c_int),
        ('ka_vst3_info', [ctypes.c_char_p, ctypes.c_int], ctypes.c_int),
        ('ka_vst3_buses', [ctypes.c_char_p, ctypes.c_int], ctypes.c_int),
        ('ka_vst3_events', [ctypes.POINTER(ctypes.c_int), ctypes.c_int], ctypes.c_int),
        ('ka_vst3_frames', [], ctypes.c_int),
        ('ka_vst3_stage', [ctypes.POINTER(ctypes.c_int)], ctypes.c_int),
        ('ka_vst3_live', [ctypes.c_int], ctypes.c_int),
        ('ka_plug_heartbeat', [], ctypes.c_int),
    ]:
        f = getattr(d, n)
        f.argtypes = a
        f.restype = r
    return d


def run(d, frames=BLOCK, capture=False):
    """渲染一块；capture=True 时把交错立体声收回来。"""
    buf = (ctypes.c_float * 1024)()
    rc = d.ka_vst3_render(ctypes.cast(buf, ctypes.c_void_p) if capture else None, frames)
    return rc, (list(buf)[:frames * 2] if capture else None)


def zero_crossings(interleaved):
    left = interleaved[0::2]
    n = 0
    for i in range(1, len(left)):
        if (left[i - 1] <= 0.0) != (left[i] <= 0.0):
            n += 1
    return n


def main():
    if not os.path.isfile(PLUG):
        print('missing %s - run client/kolid_audio/testplug/build_testplug.ps1 first' % PLUG)
        return 1
    w = PluginWorker()
    try:
        return run_host(w)
    finally:
        w.stop()


def run_host(w):
    d = bind(w)

    print('== 清单与打开 ==')
    check('the fixture plugin is scannable', d.ka_vst3_scan(PLUG) == 1)
    check('a fresh host refuses to render before open', d.ka_vst3_render(None, BLOCK) == -1)
    check('open the fixture plugin', d.ka_vst3_open(PLUG, 0) == 0)
    # 不开 live：ka_vst3_render 是同步的（"我现在就要这一块"），跟 ring 那条路无关。
    # ring 是给设备混音用的，提前量会让音符晚几块才响 —— 量力度/音高必须避开它。

    b = ctypes.create_string_buffer(512)
    d.ka_vst3_info(b, 512)
    geom = b.value.decode().split('|')
    check('one audio output bus', geom[1] == '1', b.value.decode())
    check('stereo out', geom[3] == '2', b.value.decode())
    check('one event input', geom[4] == '1', b.value.decode())
    check('sample rate follows the engine', geom[5] == str(RATE), geom[5])

    d.ka_vst3_buses(b, 512)
    lines = [l for l in b.value.decode().split('\n') if l]
    check('bus list reports the audio out', any(l.startswith('a|o|0|ch2') for l in lines),
          ' / '.join(lines))

    print('== 静音基线 ==')
    rc, _ = run(d)
    check('render works with no note', rc == 0)
    check('and stays silent', d.ka_vst3_peak() == 0, 'peak=%d' % d.ka_vst3_peak())

    print('== 发声 ==')
    check('note on accepted', d.ka_vst3_note(1, 0, 69, 100) > 0)
    peaks = []
    for _ in range(6):
        run(d)
        peaks.append(d.ka_vst3_peak())
    check('a note makes sound', max(peaks) > 20, 'peaks=%s' % peaks)
    check('the level is steady (not one noisy block)', min(peaks[1:]) > 20, 'peaks=%s' % peaks)

    st = (ctypes.c_int * 3)()
    d.ka_vst3_events(st, 3)
    check('the plugin asked for the event list', st[0] > 0, 'asked=%d pulled=%d' % (st[0], st[1]))
    check('the plugin pulled exactly one note', st[1] == 1, 'pulled=%d' % st[1])

    print('== 音高 ==')
    _, buf = run(d, capture=True)
    check('render can hand back the samples', buf is not None and any(abs(v) > 0.001 for v in buf))
    # A4=440Hz：512 帧约 4.7 个周期 → 约 9~10 次过零
    zc = zero_crossings(buf)
    check('A4 measures near 440 Hz', 7 <= zc <= 12, '%d zero crossings in %d frames' % (zc, BLOCK))

    print('== 力度与释放 ==')
    d.ka_vst3_note(0, 0, 69, 0)
    tail = []
    for _ in range(80):
        run(d)
        tail.append(d.ka_vst3_peak())
    check('note off fades to silence', tail[-1] == 0, 'last=%d' % tail[-1])
    check('release is gradual, not a cliff', any(0 < v < max(tail[:5] or [1]) for v in tail[:20]),
          'first=%d mid=%d' % (tail[0], tail[20]))

    d.ka_vst3_note(1, 0, 60, 127)
    run(d)
    loud = d.ka_vst3_peak()
    d.ka_vst3_note(0, 0, 60, 0)
    for _ in range(80):
        run(d)
    d.ka_vst3_note(1, 0, 60, 20)
    run(d)
    soft = d.ka_vst3_peak()
    d.ka_vst3_note(0, 0, 60, 0)
    check('velocity scales the level', loud > soft > 0, 'vel127=%d vel20=%d' % (loud, soft))

    print('== 收尾与重开 ==')
    frames = d.ka_vst3_frames()
    check('frame counter advances', frames > 0, 'frames=%d' % frames)
    d.ka_vst3_close()
    check('closed host refuses to render', d.ka_vst3_render(None, BLOCK) == -1)
    check('reopen works', d.ka_vst3_open(PLUG, 0) == 0)
    check('frames restart on reopen', d.ka_vst3_frames() == 0, 'frames=%d' % d.ka_vst3_frames())
    d.ka_vst3_close()

    if '--real' in sys.argv:
        print('== 本机真插件（只跑一遍，看会不会崩、有没有声） ==')
        names = []
        for nm in sorted(os.listdir(VST3_DIR)):
            if nm.lower().endswith('.vst3'):
                names.append(os.path.join(VST3_DIR, nm))
        for p in names:
            n = d.ka_vst3_scan(p)
            if n <= 0:
                print('  SKIP  %-24s scan=%d' % (os.path.basename(p), n))
                continue
            rc = d.ka_vst3_open(p, 0)
            if rc != 0:
                st = ctypes.c_int(0)
                last = d.ka_vst3_stage(ctypes.byref(st))
                print('  FAIL  %-24s open=%d stage=%d rc=%d'
                      % (os.path.basename(p), rc, st.value, last))
                continue
            d.ka_vst3_note(1, 0, 60, 110)
            pk = 0
            for _ in range(24):
                d.ka_vst3_render(None, BLOCK)
                pk = max(pk, d.ka_vst3_peak())
            d.ka_vst3_note(0, 0, 60, 0)
            d.ka_vst3_close()
            print('  %-6s %-24s peak=%d' % ('OK' if pk else 'SILENT', os.path.basename(p), pk))

    print()
    if bad:
        print('%d passed, %d failed' % (ok, bad))
    else:
        print('all %d checks passed' % ok)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
