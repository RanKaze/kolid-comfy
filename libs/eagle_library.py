"""Eagle 素材库 —— 只读、零拷贝。

Eagle 的库是一个 `<name>.library` 目录：`images/<id>.info/` 每格放原件、`<name>_thumbnail.png`
与 `metadata.json`；库根还有 `metadata.json`（文件夹树）、`mtime.json`（每个条目的改动时间）。
这里**不往 `data/assets/` 写任何字节**：清单现读 Eagle 的 metadata，缩略图与原件都由 HTTP
层直接从 Eagle 目录伺服（见 snapshot_sampler_node 的 `/api/eagle_*` 三条读口）。

库的位置按这条顺序确定（都是只读探测，不改 Eagle 自己的配置）：
  1. 环境变量 `KOLID_EAGLE_LIBRARY`
  2. `data/sampler/eagle_library.json` 里用户点选过的路径
  3. Eagle 自己 leveldb 里记着的那条当前库
  4. Documents/Eagle、Pictures/Eagle、Desktop，以及各固定盘根下两层的 `*.library`

缓存按库根的签名（metadata/mtime/images 的 mtime）失效；签名变了只重读改动过的条目
（mtime.json 是 Eagle 写的逐条改动时间），所以开着 Eagle 用素材时不会每次都全扫 4211 份 JSON。
"""
import json
import math
import os
import re
import string
import threading
import time
from collections import Counter
from urllib.parse import unquote

from .data_paths import data_file

IMG_EXT = frozenset(('.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.tif', '.tiff'))
VID_EXT = frozenset(('.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi'))
AUD_EXT = frozenset(('.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'))

CONFIG_NAME = 'eagle_library.json'
LIB_SUFFIX = '.library'
_ID_RE = re.compile(r'^[A-Za-z0-9_-]{4,40}$')
_DRIVE_RE = re.compile(rb'[A-Za-z]:[\\/][^\x00"<>|\r\n]{0,180}?\.library', re.I)

_LOCK = threading.RLock()
_BUILD = threading.Lock()
_CACHE = {
    'root': None, 'sig': None, 'mtimes': {},
    'items': None, 'folders': [], 'tags': [], 'hidden': 0, 'at': 0,
}
_DETECTED = {'root': None, 'checked': False}
# 解析结果也记一份：抽帧是热路径（每个未命中的 f 都会问一次），别每次都去读配置文件。
_ROOT = {'path': None, 'resolved': False}


def kind_of(ext):
    """扩展名 → 'image' | 'video' | 'audio'；不认识的返回 None（PSD/FBX 这类不列）。"""
    e = '.' + str(ext or '').lower().lstrip('.')
    if e in IMG_EXT:
        return 'image'
    if e in VID_EXT:
        return 'video'
    if e in AUD_EXT:
        return 'audio'
    return None


def _valid(path):
    return bool(path) and os.path.isdir(os.path.join(path, 'images')) \
        and os.path.isfile(os.path.join(path, 'metadata.json'))


def _config_path():
    return data_file('sampler', CONFIG_NAME)


def _read_config():
    try:
        with open(_config_path(), 'r', encoding='utf-8') as f:
            raw = json.load(f)
        return str(raw.get('path') or '') if isinstance(raw, dict) else ''
    except (OSError, ValueError):
        return ''


def _write_config(path):
    p = _config_path()
    tmp = p + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump({'path': path}, f, ensure_ascii=False, indent=1)
        os.replace(tmp, p)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass


def _pick_library(path):
    """用户给的路径 → 真正的库目录。既收 .library 本身，也收它的父目录（父目录里恰好一个库时）。"""
    if _valid(path):
        return os.path.abspath(path)
    if path and os.path.isdir(path):
        try:
            hits = [os.path.join(path, n) for n in os.listdir(path)
                    if n.lower().endswith(LIB_SUFFIX) and _valid(os.path.join(path, n))]
        except OSError:
            hits = []
        if len(hits) == 1:
            return os.path.abspath(hits[0])
    return None


def _from_eagle_state():
    """Eagle 的 leveldb 里存着当前 / 最近打开过的库路径（百分号编码的文件 URL）。"""
    appdata = os.environ.get('APPDATA') or os.path.join(
        os.path.expanduser('~'), 'AppData', 'Roaming')
    d = os.path.join(appdata, 'Eagle', 'Local Storage', 'leveldb')
    try:
        names = sorted(os.listdir(d), key=lambda n: -os.path.getmtime(os.path.join(d, n)))
    except OSError:
        return None
    for name in names:
        p = os.path.join(d, name)
        try:
            if not os.path.isfile(p) or os.path.getsize(p) > 64 * 1024 * 1024:
                continue
            with open(p, 'rb') as f:
                raw = f.read()
        except OSError:
            continue
        for hit in _DRIVE_RE.finditer(raw):
            try:
                cand = unquote(hit.group(0).decode('latin-1'))
            except Exception:
                continue
            if _valid(cand):
                return os.path.abspath(cand)
    return None


def _from_known_dirs():
    home = os.path.expanduser('~')
    bases = [os.path.join(home, 'Documents', 'Eagle'),
             os.path.join(home, 'Pictures', 'Eagle'),
             os.path.join(home, 'Desktop')]
    for base in bases:
        try:
            names = os.listdir(base)
        except OSError:
            continue
        for n in names:
            p = os.path.join(base, n)
            if n.lower().endswith(LIB_SUFFIX) and _valid(p):
                return os.path.abspath(p)
    return None


def _from_drives():
    """固定盘根下两层找 `*.library`（Eagle 常把库放在自选目录，如 F:/Pathes/资产.library）。"""
    for letter in string.ascii_uppercase:
        root = '%s:\\' % letter
        if not os.path.isdir(root):
            continue
        try:
            first = os.listdir(root)
        except OSError:
            continue
        for name in first:
            p = os.path.join(root, name)
            if name.lower().endswith(LIB_SUFFIX) and _valid(p):
                return os.path.abspath(p)
            if not os.path.isdir(p):
                continue
            try:
                subs = os.listdir(p)
            except OSError:
                continue
            for sub in subs:
                q = os.path.join(p, sub)
                if sub.lower().endswith(LIB_SUFFIX) and _valid(q):
                    return os.path.abspath(q)
    return None


def resolve_root():
    """库根。环境变量 / 用户点选优先；其余是自动探测（每个进程只探一次）。"""
    if _ROOT['resolved']:
        cached = _ROOT['path']
        if (not cached) or _valid(cached):
            return cached
        # 记着的那条库没了（盘符换了/目录删了）：重新探测一次。
        _DETECTED['checked'] = False
    hit = None
    env = os.environ.get('KOLID_EAGLE_LIBRARY')
    if env:
        hit = _pick_library(env)
    if not hit:
        hit = _pick_library(_read_config())
    if not hit and not _DETECTED['checked']:
        _DETECTED['root'] = (_from_eagle_state() or _from_known_dirs()
                             or _from_drives())
        _DETECTED['checked'] = True
    if not hit:
        hit = _DETECTED['root']
    _ROOT.update({'path': hit, 'resolved': True})
    return hit


def set_path(path):
    """把用户挑的目录记成库位置。返回库根；不是 Eagle 库返回 None。"""
    hit = _pick_library(str(path or '').strip().strip('"'))
    if not hit:
        return None
    _write_config(hit)
    _DETECTED.update({'root': hit, 'checked': True})
    _ROOT.update({'path': hit, 'resolved': True})
    with _LOCK:
        _CACHE.update({'root': None, 'sig': None, 'mtimes': {}, 'items': None})
    return hit


# ── 扫描 ────────────────────────────────────────────────────────────────────
def _sig(root):
    parts = []
    for name in ('metadata.json', 'mtime.json', 'tags.json'):
        try:
            st = os.stat(os.path.join(root, name))
            parts.append((name, st.st_mtime_ns, st.st_size))
        except OSError:
            parts.append((name, 0, 0))
    try:
        st = os.stat(os.path.join(root, 'images'))
        parts.append(('images', st.st_mtime_ns))
    except OSError:
        parts.append(('images', 0))
    return tuple(parts)


def _mtime_map(root):
    """mtime.json：条目 id → Eagle 记的改动毫秒。读不到就返回 None（走全扫）。"""
    try:
        with open(os.path.join(root, 'mtime.json'), 'r', encoding='utf-8') as f:
            raw = json.load(f)
        if not isinstance(raw, dict):
            return None
        return {str(k): int(v) for k, v in raw.items()}
    except (OSError, ValueError, TypeError):
        return None


def _item_ids(root):
    try:
        return {n[:-5] for n in os.listdir(os.path.join(root, 'images'))
                if n.endswith('.info')}
    except OSError:
        return set()


def _read_item(root, item_id):
    """读一格 metadata + 找到原件/缩略图。返回 (record, reason)；reason='other' 是不支持的格式。"""
    d = os.path.join(root, 'images', item_id + '.info')
    try:
        with open(os.path.join(d, 'metadata.json'), 'r', encoding='utf-8') as f:
            m = json.load(f)
    except (OSError, ValueError):
        return None, 'missing'
    if not isinstance(m, dict) or m.get('isDeleted'):
        return None, 'missing'
    ext = str(m.get('ext') or '').lower().lstrip('.')
    kind = kind_of(ext)
    if not kind:
        return None, 'other'
    name = str(m.get('name') or item_id)
    media = os.path.join(d, '%s.%s' % (name, ext))
    if not os.path.isfile(media):
        media = None
        try:
            for fn in os.listdir(d):
                if fn.lower().endswith('.' + ext):
                    media = os.path.join(d, fn)
                    break
        except OSError:
            pass
        if not media or not os.path.isfile(media):
            return None, 'missing'
    # metadata 里的 name 也当不可信输入：它只准落在这一格 .info 目录里。
    media = os.path.abspath(media)
    if not media.startswith(os.path.abspath(d) + os.sep):
        return None, 'missing'
    try:
        st = os.stat(media)
    except OSError:
        return None, 'missing'

    stem = os.path.splitext(os.path.basename(media))[0]
    thumb = None
    for cand in ('%s_thumbnail.png' % stem, '%s_thumbnail.webp' % stem,
                 '%s_thumbnail.jpg' % stem, 'thumbnail.png'):
        if os.path.isfile(os.path.join(d, cand)):
            thumb = cand
            break
    if thumb is None:
        try:
            for fn in os.listdir(d):
                if '_thumbnail.' in fn.lower() or fn.lower().startswith('thumbnail.'):
                    thumb = fn
                    break
        except OSError:
            pass

    try:
        w = int(m.get('width') or m.get('resolutionWidth') or 0)
        h = int(m.get('height') or m.get('resolutionHeight') or 0)
    except (TypeError, ValueError):
        w, h = 0, 0
    try:
        duration = float(m.get('duration') or 0)
    except (TypeError, ValueError):
        duration = 0.0
    if not math.isfinite(duration):
        duration = 0.0
    return {
        'id': item_id,
        'name': name,
        'file': os.path.basename(media),
        'ext': ext,
        'kind': kind,
        'size': st.st_size,
        'mtime': st.st_mtime,
        'w': w, 'h': h,
        'duration': round(duration, 3),
        'tags': [str(t) for t in (m.get('tags') or []) if t],
        'folders': [str(f) for f in (m.get('folders') or []) if f],
        'thumb': thumb,
        'hasAudio': None,
    }, None


def _folders(root, counts):
    try:
        with open(os.path.join(root, 'metadata.json'), 'r', encoding='utf-8') as f:
            raw = json.load(f)
        tree = raw.get('folders') if isinstance(raw, dict) else None
    except (OSError, ValueError):
        tree = None

    def walk(nodes):
        out = []
        for node in nodes if isinstance(nodes, list) else []:
            if not isinstance(node, dict):
                continue
            fid = str(node.get('id') or '')
            kids = walk(node.get('children'))
            direct = counts.get(fid, 0)
            out.append({
                'id': fid,
                'name': str(node.get('name') or ''),
                'count': direct,
                # 子树合计：窗里选父文件夹时连子文件夹里的货一起列，读数得是同一口径。
                'total': direct + sum(k['total'] for k in kids),
                # Eagle 自己给文件夹配的图标与颜色（photo / film3 / box / bookshelf；red / green）。
                'icon': str(node.get('icon') or ''),
                'color': str(node.get('iconColor') or ''),
                'children': kids,
            })
        return out

    return walk(tree)


def _build(root, full=False):
    sig = _sig(root)
    with _LOCK:
        if _CACHE['root'] == root and _CACHE['sig'] == sig and _CACHE['items'] is not None:
            return
    with _BUILD:
        with _LOCK:
            if _CACHE['root'] == root and _CACHE['sig'] == sig and _CACHE['items'] is not None:
                return
            items = {} if full else dict(_CACHE['items'] or {})
            known = {} if full else dict(_CACHE['mtimes'] or {})
            if _CACHE['root'] != root:
                items, known = {}, {}

        ids = _item_ids(root)
        mtimes = None if full else _mtime_map(root)
        if mtimes is None:
            todo = list(ids)                 # 没有 mtime.json：只能逐条读
            mtimes = {}
        else:
            ids |= set(mtimes)
            todo = [i for i in ids
                    if i not in items or known.get(i) != mtimes.get(i)]

        for i in set(items) - ids:
            items.pop(i, None)
        for i in todo:
            rec, _why = _read_item(root, i)
            if rec:
                items[i] = rec
            else:
                items.pop(i, None)

        counts = Counter()
        for rec in items.values():
            for fid in rec['folders']:
                counts[fid] += 1
        tags = Counter(t for rec in items.values() for t in rec['tags'])
        with _LOCK:
            _CACHE.update({
                'root': root, 'sig': sig, 'mtimes': dict(mtimes),
                'items': items,
                'folders': _folders(root, counts),
                'tags': [{'name': k, 'count': v} for k, v in tags.most_common()],
                'hidden': max(0, len(ids) - len(items)),
                'at': time.time(),
            })


def snapshot(refresh=False):
    """Eagle 窗的整份清单。refresh=True = 无视缓存重读一遍（显式 Rescan）。"""
    root = resolve_root()
    if not root:
        return {'ok': False, 'error': 'No Eagle library found',
                'root': None, 'name': None, 'folders': [], 'tags': [],
                'items': [], 'hidden': 0, 'scanned': 0}
    try:
        _build(root, full=bool(refresh))
    except Exception as e:                       # noqa: BLE001 —— 坏库不该炸掉 HTTP 线程
        return {'ok': False, 'error': 'Eagle library could not be read: %s' % e,
                'root': root, 'name': os.path.basename(root), 'folders': [], 'tags': [],
                'items': [], 'hidden': 0, 'scanned': 0}
    with _LOCK:
        items = sorted(_CACHE['items'].values(), key=lambda r: (-r['mtime'], r['name'].lower()))
        return {'ok': True, 'root': root, 'name': os.path.basename(root),
                'folders': _CACHE['folders'], 'tags': _CACHE['tags'],
                'items': items, 'hidden': _CACHE['hidden'], 'scanned': _CACHE['at']}


def _record(ref):
    item_id = str(ref or '').strip()
    if not _ID_RE.match(item_id):
        return None
    with _LOCK:
        rec = (_CACHE['items'] or {}).get(item_id)
    if rec is None:
        snapshot()                               # 第一次访问：现扫一遍再认
        with _LOCK:
            rec = (_CACHE['items'] or {}).get(item_id)
    return rec


def media_path(ref):
    """Eagle 条目的原件路径（只读）。id 只按缓存认，路径不来自请求串。"""
    rec = _record(ref)
    if not rec:
        return None
    p = os.path.join(_CACHE['root'] or '', 'images', rec['id'] + '.info', rec['file'])
    return p if os.path.isfile(p) else None


def thumb_path(ref):
    """Eagle 自己生成的缩略图（`<name>_thumbnail.png`）路径；没有就 None。"""
    rec = _record(ref)
    if not rec or not rec.get('thumb'):
        return None
    p = os.path.join(_CACHE['root'] or '', 'images', rec['id'] + '.info', rec['thumb'])
    return p if os.path.isfile(p) else None
