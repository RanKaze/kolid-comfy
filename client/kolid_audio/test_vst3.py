"""VST3 ABI 闸 —— 只验证"我们认得的 ABI 和真插件对上"。

为什么这些检查值得写：这一层没有 SDK 兜底，vtable 差一格、IID 少反一个字节，
后果都不是"报个错"，而是**跳到别的函数上**。所以只要这台机器上有插件，就必须拿它当尺子量。

跑法： python client/kolid_audio/test_vst3.py
      python client/kolid_audio/test_vst3.py --all     # 把本机 VST3 目录全扫一遍
"""

import ctypes
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from plugin_worker import PluginWorker          # noqa: E402
VST3_DIR = r'C:\Program Files\Common Files\VST3'

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


def load(w):
    dll = w.dll
    dll.ka_vst3_scan.argtypes = [ctypes.c_wchar_p]
    dll.ka_vst3_scan.restype = ctypes.c_int
    dll.ka_vst3_factory.argtypes = [ctypes.c_char_p, ctypes.c_int]
    dll.ka_vst3_class.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    dll.ka_vst3_class.restype = ctypes.c_int
    dll.ka_vst3_err.restype = ctypes.c_int
    dll.ka_vst3_dbg.restype = ctypes.c_char_p
    dll.ka_vst3_class_cid.argtypes = [ctypes.c_int, ctypes.c_char_p]
    dll.ka_vst3_class_cid.restype = ctypes.c_int
    return dll


def scan(dll, path):
    """→ (类数, 工厂串, [(cid_hex, cardinality, category, name), ...])"""
    n = dll.ka_vst3_scan(path)
    if n < 0:
        return n, '', []
    buf = ctypes.create_string_buffer(2048)
    dll.ka_vst3_factory(buf, 2048)
    fac = buf.value.decode('utf-8', 'replace')
    rows = []
    for i in range(n):
        dll.ka_vst3_class(i, buf, 2048)
        cid, card, cat, name = buf.value.decode('utf-8', 'replace').split('|', 3)
        rows.append((cid, int(card), cat, name))
    return n, fac, rows


def main():
    w = PluginWorker()
    try:
        return run(w)
    finally:
        w.stop()


def run(w):
    dll = load(w)
    print('== 扁平 .vst3（Ample Sound / JUCE） ==')
    aba = os.path.join(VST3_DIR, 'ABA.vst3')
    n, fac, rows = scan(dll, aba)
    check('flat .vst3 scans', n == 2, 'n=%d' % n)
    check('factory vendor is the real one', fac.startswith('Ample Sound|'), fac)
    check('has an Audio Module Class', any('Audio Module Class' in r[2] for r in rows),
          ' | '.join(r[2] for r in rows))
    check('name reaches us intact', any(r[3] == 'Ample Bass A' for r in rows),
          ' | '.join(r[3] for r in rows))
    check('cid is 32 hex chars', all(len(r[0]) == 32 for r in rows))
    check('cid raw bytes are 16', (lambda: (lambda b: dll.ka_vst3_class_cid(0, b) == 16)(
        ctypes.create_string_buffer(16)))())
    # 可读文本 UID：Ample 的组件 cid 前三个字节是 "ATS"，能当弱校验用
    check('component cid looks like a text UID', rows[0][0].startswith('41545356'), rows[0][0][:8])

    print('== 另一支 Ample（cid 应不同） ==')
    n2, _, rows2 = scan(dll, os.path.join(VST3_DIR, 'AGSC.vst3'))
    check('second amples sounds', n2 == 2, 'n=%d' % n2)
    check('different plugin → different cid', rows2[0][0] != rows[0][0],
          '%s vs %s' % (rows2[0][0][:8], rows[0][0][:8]))
    check('different plugin → different name', rows2[0][3] != rows[0][3],
          '%s vs %s' % (rows2[0][3], rows[0][3]))

    print('== 目录型 bundle（Steinberg） ==')
    hal = os.path.join(VST3_DIR, r'Steinberg\HALion 7.vst3')
    if os.path.isdir(hal):
        n3, fac3, rows3 = scan(dll, hal)
        check('bundle dir resolves to the inner dll', n3 > 0,
              'n=%d dbg=%s' % (n3, (dll.ka_vst3_dbg() or b'').decode('utf-8', 'replace')))
        check('steinberg vendor', fac3.startswith('Steinberg'), fac3)
        check('bundle exposes 4 classes', n3 == 4, 'n=%d' % n3)
        check('inner dll is not double-suffixed',
              not (dll.ka_vst3_dbg() or b'').decode('utf-8', 'replace').endswith('.vst3.vst3'))
    else:
        print('SKIP  no Steinberg bundle on this machine')

    print('== 其他厂商 ==')
    kon = os.path.join(VST3_DIR, 'Kontakt 7.vst3')
    if os.path.isfile(kon):
        n4, fac4, rows4 = scan(dll, kon)
        check('kontakt scans', n4 >= 2, 'n=%d' % n4)
        check('kontakt vendor', fac4.startswith('Native Instruments'), fac4)
        check('kontakt has a compatibility class',
              any('Compatibility' in r[2] for r in rows4), ' | '.join(r[2] for r in rows4))

    print('== 错误路径 ==')
    check('missing file -> -2', dll.ka_vst3_scan(os.path.join(VST3_DIR, 'nope.vst3')) == -2)
    check('plain dll without the entry point -> -3',
          dll.ka_vst3_scan(r'C:\Windows\System32\notepad.exe') == -3,
          'err=%d' % dll.ka_vst3_err())
    check('null path -> -1', dll.ka_vst3_scan(None) == -1)
    check('empty path -> -2 (empty string is not null)', dll.ka_vst3_scan('') == -2)

    if '--all' in sys.argv:
        print('== 本机 VST3 目录全扫 ==')
        files = []
        for root, dirs, names in os.walk(VST3_DIR):
            for nm in names:
                if nm.lower().endswith('.vst3'):
                    files.append(os.path.join(root, nm))
            # bundle 里的内层文件不用重复扫，只认外面的
            dirs[:] = [d for d in dirs if not d.lower().endswith('.vst3') or root == VST3_DIR]
        fails = []
        for f in files:
            nn, ff, _rr = scan(dll, f)
            if nn <= 0:
                fails.append((f, nn))
        check('every .vst3 in %s scans' % VST3_DIR, not fails,
              '%d files, %d failed%s' % (len(files), len(fails),
                                         (': ' + '; '.join(os.path.basename(f) for f, _ in fails[:3]))
                                         if fails else ''))

    print()
    if bad:
        print('%d passed, %d failed' % (ok, bad))
    else:
        print('all %d checks passed' % ok)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
