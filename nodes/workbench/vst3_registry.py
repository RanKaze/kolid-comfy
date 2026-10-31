"""`.vstpreset` → 哪一个 `.vst3`、第几个类。

VST3 的预设文件里**没有插件路径**：头部只有组件那 16 字节 class id（TUID）。宿主是靠"我扫过
哪些插件、每个插件有哪些类"反查的。Cubase 有自己的那份库，我们没有 —— 这个文件从零建一份。

三条实测事实决定它的形状（本机 2026-10-31）：
  · 预设头是纯文本可解析的：`"VST3"` + int32 版本 + 16 字节 cid + 块表（每项 4 字节 id +
    两个 int64 的绝对偏移/长度，4 个 0 结尾）。**读 cid 不用碰插件**；
  · 反查只能问插件本身：本机的 HALion 7 / HALion Sonic / Kontakt 7 都没有 moduleinfo.json，
    而这三支的 cid 分别是 41D7633B… / 8D627080… / 4E545356…（Kontakt 的原始字节是 "NTSV"，
    正好是 "VSTN" 的小端写法 —— 所以这里一律比对**原始 16 字节**，不比对字符串形态）；
  · 扫一枚插件 0.4~0.5 秒（Kontakt 145MB 实测 0.50s，HALion 7 0.42s，HALion Sonic 0.06s）。
    所以结果必须落盘：按"插件路径 + mtime"记整份类清单，装/换了插件才重扫；cid 索引另记一份。

扫描走 worker（隔离进程）：插件代码不在 ComfyUI 里跑，崩了也只是那个子进程。这里的 scan 回调
由 audio_bridge 提供，本模块不自己起进程 —— 它只认"给我一条路径，回一串类"。
"""

from __future__ import annotations

import json
import os
import threading
import time

try:
    from ...libs.data_paths import data_file
except ImportError:                      # pragma: no cover —— 手跑这个文件时
    def data_file(kind, name):           # type: ignore
        here = os.path.dirname(os.path.abspath(__file__))
        return os.path.join(here, '..', '..', 'data', kind, name)


_LOCK = threading.RLock()
_CACHE_NAME = 'vst3_map.json'
_CACHE_VERSION = 1
# 一枚插件文件的上限：Kontakt 7 是 145 MB 的单文件，再大一倍就当它不是 VST3（或读不动）。
_MAX_PLUGIN_BYTES = 512 * 1024 * 1024
# 一次反查最多扫这么多个没记过的插件。扫不到就如实说"没找到"，下次再扫剩下那些 ——
# 不能让一条坏预设把整个请求拖成半分钟。
_MAX_SCAN_PER_CALL = 40


def _env_dirs():
    raw = os.environ.get('KOLID_VST3_DIRS') or ''
    for part in raw.split(os.pathsep):
        part = part.strip()
        if part:
            yield part


def plugin_dirs():
    """VST3 的标准安装位置。顺序 = 先系统级、后用户级（同名插件取先出现的那个）。"""
    out = []
    for d in _env_dirs():
        out.append(d)
    for key in ('CommonProgramFiles', 'CommonProgramFiles(x86)', 'ProgramFiles', 'ProgramFiles(x86)'):
        base = os.environ.get(key)
        if base:
            out.append(os.path.join(base, 'VST3'))
    local = os.environ.get('LOCALAPPDATA')
    if local:
        out.append(os.path.join(local, 'Programs', 'Common', 'VST3'))
    roaming = os.environ.get('APPDATA')
    if roaming:
        out.append(os.path.join(roaming, 'VST3'))
    seen, keep = set(), []
    for d in out:
        k = os.path.normcase(os.path.abspath(d))
        if k in seen:
            continue
        seen.add(k)
        if os.path.isdir(d):
            keep.append(d)
    return keep


def list_bundles(limit: int = 512):
    """标准目录下的 `.vst3`（文件或 bundle 目录）。一层子目录也认（Steinberg 就放在 `VST3\\Steinberg\\`）。"""
    out, seen = [], set()
    for root in plugin_dirs():
        for base, dirs, files in os.walk(root):
            depth = os.path.relpath(base, root).count(os.sep) + (0 if base == root else 1)
            if depth > 2:
                dirs[:] = []
                continue
            for name in sorted(dirs + files):
                low = name.lower()
                if not low.endswith('.vst3'):
                    continue
                full = os.path.join(base, name)
                k = os.path.normcase(os.path.abspath(full))
                if k in seen:
                    continue
                seen.add(k)
                out.append(full)
                if len(out) >= limit:
                    return out
            dirs[:] = [d for d in dirs if not d.lower().endswith('.vst3')]
    return out


# ── .vstpreset 头 ─────────────────────────────────────────────────────────────────────────────

def _rd_i32(buf, off):
    return int.from_bytes(buf[off:off + 4], 'little', signed=True)


def _rd_i64(buf, off):
    return int.from_bytes(buf[off:off + 8], 'little', signed=True)


def read_preset(path: str) -> dict:
    """只读头。返回 `{ok, cid, version, bytes, chunks, error}`；`cid` 是 32 位大写十六进制。

    块表按"4 个 0 结尾"扫，但**不信任**表里的偏移 —— 越界的项直接判坏（一个坏文件不该让
    这里抛异常，它只该得到一句 error）。
    """
    out = {'ok': False, 'cid': '', 'version': 0, 'bytes': 0, 'chunks': [], 'error': ''}
    full = os.path.abspath(str(path or ''))
    if not full or not os.path.isfile(full):
        out['error'] = 'no such file: %s' % full
        return out
    try:
        size = os.path.getsize(full)
        out['bytes'] = size
        if size < 68 or size > 256 * 1024 * 1024:
            out['error'] = 'not a VST3 preset (size %d)' % size
            return out
        with open(full, 'rb') as f:
            head = f.read(min(size, 4096))
    except OSError as e:
        out['error'] = str(e)
        return out
    if head[0:4] != b'VST3':
        out['error'] = 'missing the VST3 signature'
        return out
    out['version'] = _rd_i32(head, 4)
    out['cid'] = head[8:24].hex().upper()
    off = 24
    chunks = []
    while off + 4 <= len(head):
        if head[off:off + 4] == b'\0\0\0\0':
            break
        if off + 20 > len(head):
            break
        cid4 = head[off:off + 4].decode('latin-1')
        start, length = _rd_i64(head, off + 4), _rd_i64(head, off + 12)
        off += 20
        if start < 0 or length < 0 or start + length > size:
            out['chunks'] = []
            out['error'] = 'chunk table points outside the file'
            return out
        chunks.append({'id': cid4, 'offset': start, 'size': length})
        if len(chunks) > 64:
            break
    out['chunks'] = chunks
    if not chunks:
        out['error'] = 'no state chunk in this preset'
        return out
    out['ok'] = True
    return out


# ── 缓存 ─────────────────────────────────────────────────────────────────────────────────────

def cache_path() -> str:
    return data_file('sampler', _CACHE_NAME)


def _empty_cache():
    return {'v': _CACHE_VERSION, 'plugins': {}, 'cid': {}}


def _read_cache(path=None):
    path = path or cache_path()
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception:
        return _empty_cache()
    if not isinstance(data, dict) or data.get('v') != _CACHE_VERSION:
        return _empty_cache()            # 旧版本/坏文件：整份作废，重扫一次没什么损失
    plugins = data.get('plugins')
    cid = data.get('cid')
    if not isinstance(plugins, dict) or not isinstance(cid, dict):
        return _empty_cache()
    return data


def _write_cache(data, path=None):
    path = path or cache_path()
    tmp = path + '.tmp'
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, path)
    except OSError:
        pass                             # 写不动缓存不该让"装乐器"失败


def _mtime(path):
    try:
        return round(os.path.getmtime(path), 3)
    except OSError:
        return 0.0


def _remember(data, plugin_path, classes):
    data['plugins'][plugin_path] = {'mtime': _mtime(plugin_path), 'classes': classes,
                                    'scanned': int(time.time())}
    for c in classes:
        cid = str(c.get('cid') or '')
        if cid:
            data['cid'][cid] = {'path': plugin_path, 'cls': int(c.get('cls') or 0),
                                'name': str(c.get('name') or '')}


def resolve(cid: str, scan=None, force: bool = False, limit: int = _MAX_SCAN_PER_CALL,
            hint: str = '') -> dict:
    """cid → `{ok, path, cls, name, scanned, error}`。

    `scan(path)` 返回 `[{cls, cid, name, category}]`（见 audio_bridge.Engine.scan_plugin_classes）。
    缓存命中就不扫；`force` 只作用在"这条 cid 没查到"上 —— 已记过的插件清单照样复用。
    `hint` 是预设的路径/名字：Cubase 把预设按插件名分目录（`…\\Kontakt 7\\xxx.vstpreset`），
    名字对得上的插件先扫 —— 一枚 0.5s，25 枚就是十几秒，能少扫就少扫。
    """
    cid = str(cid or '').upper()
    res = {'ok': False, 'cid': cid, 'path': '', 'cls': 0, 'name': '', 'scanned': 0, 'error': ''}
    if len(cid) != 32:
        res['error'] = 'not a class id'
        return res
    with _LOCK:
        data = _read_cache()
        hit = data['cid'].get(cid)
        if hit and os.path.exists(str(hit.get('path') or '')):
            res.update({'ok': True, 'path': hit['path'], 'cls': int(hit.get('cls') or 0),
                        'name': str(hit.get('name') or '')})
            return res
        if scan is None:
            res['error'] = 'plugin scanner unavailable'
            return res
        bundles = list_bundles()
        if not bundles:
            res['error'] = 'no .vst3 found in the standard VST3 folders'
            return res
        low = str(hint or '').lower()

        def score(p):
            stem = os.path.basename(p)
            if stem.lower().endswith('.vst3'):
                stem = stem[:-5]
            s = stem.lower().strip()
            return 0 if s and s in low else 1

        bundles = sorted(bundles, key=score)      # 稳定排序：名字对得上的排前面，其余保持原序
        # 已经记过类清单且文件没变：直接在缓存里找这一条（可能上一轮记过但 cid 索引被清过）。
        dirty = False
        tried = 0
        for path in bundles:
            if tried >= limit:
                break
            known = data['plugins'].get(path)
            fresh = known and abs(float(known.get('mtime') or 0) - _mtime(path)) < 0.5
            if fresh:
                for c in known.get('classes') or []:
                    if str(c.get('cid') or '').upper() == cid:
                        res.update({'ok': True, 'path': path, 'cls': int(c.get('cls') or 0),
                                    'name': str(c.get('name') or '')})
                        return res
                continue
            try:
                if os.path.isfile(path) and os.path.getsize(path) > _MAX_PLUGIN_BYTES:
                    continue
                classes = scan(path) or []
            except Exception:
                classes = []
            tried += 1
            res['scanned'] = tried
            _remember(data, path, classes)
            dirty = True
            for c in classes:
                if str(c.get('cid') or '').upper() == cid:
                    res.update({'ok': True, 'path': path, 'cls': int(c.get('cls') or 0),
                                'name': str(c.get('name') or '')})
                    _write_cache(data)
                    return res
        if dirty:
            _write_cache(data)
        res['error'] = ('scanned %d plugin%s and did not find class %s'
                        % (res['scanned'], '' if res['scanned'] == 1 else 's',
                           cid[:8] + '…'))
        return res


def classes_of(plugin_path: str, scan=None, force: bool = False) -> list:
    """一个插件的类清单（缓存优先）。给"预设的 cid 与插件对不对得上"这一道检查用。"""
    path = os.path.abspath(str(plugin_path or ''))
    if not os.path.isfile(path) and not os.path.isdir(path):
        return []
    with _LOCK:
        data = _read_cache()
        known = data['plugins'].get(path)
        if not force and known and abs(float(known.get('mtime') or 0) - _mtime(path)) < 0.5:
            return list(known.get('classes') or [])
        if scan is None:
            return []
        classes = scan(path) or []
        _remember(data, path, classes)
        _write_cache(data)
        return classes


def fuid_to_raw_cid(text: str) -> str:
    """moduleinfo.json 里那种 `XXXXXXXX-XXXX-…` 串 → 原始 16 字节的 32 位十六进制。

    VST3 的 FUID 字符串把前三段按小端打印（Kontakt 的 "5653544E-…" 在内存里是 4E 54 53 56），
    而 `.vstpreset` 头与 `ka_vst3_class_cid` 都是原始字节 —— 中间必须过这一道。
    """
    hexs = str(text or '').replace('-', '').replace('{', '').replace('}', '').strip().upper()
    if len(hexs) != 32:
        return ''
    try:
        raw = bytes.fromhex(hexs)
    except ValueError:
        return ''
    return (raw[3::-1] + raw[5:3:-1] + raw[7:5:-1] + raw[8:]).hex().upper()
