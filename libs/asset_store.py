"""资产仓库（asset store）—— 全仓唯一的字节落点 + 一张库成员表。

设计见 `docs/assets_single_store_design.md`（v3）。这里只做"仓库"这一层，不管引用图，也不删东西
（回收是 A6 的事）。三条约定：

1. **id = 文件名 stem**（去掉扩展名），全仓引用一律用它。
   · 新写入：stem = `md5(bytes)` —— 内容寻址，同一份字节写两次只落一个文件；
   · 老库（assets_node 写的）：stem = `md5(base64)` —— 同样是内容摘要，照旧当 id 用。
     两条路都不重算、不改名、不搬家：它们都满足「唯一 + 由内容决定 + 永不重编号」，
     这正是 id 需要的全部性质。代价只是"老货与新货同字节却不同摘要"时会各存一份（极少见，不伤正确性）。
   · **不做全库重算哈希**：库里有 1.4 GB 视频，扫一遍算 md5 是几秒的代价，而目录本身已经把 id 端出来了。

2. **表只装「库成员 + 元数据覆盖」**（`data/assets/_index.json`）。
   不在表里的资产 = 会话级临时产物（scope=session），它们的名字就是文件、种类看扩展名，
   元数据按需现算。什么时候收由 GC 决定，这里不删。

3. **表里不存字节**。字节永远只在 `data/assets/<id><ext>` 里一份。
"""
import base64
import hashlib
import io
import json
import os
import threading
import time
import uuid
from urllib.parse import unquote_to_bytes

from .data_paths import data_dir

# ── 种类 ────────────────────────────────────────────────────────────────────
IMG_EXT = frozenset(('.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.tif', '.tiff'))
VID_EXT = frozenset(('.mp4', '.webm', '.avi', '.mov', '.m4v', '.mkv'))
AUD_EXT = frozenset(('.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'))

INDEX_NAME = '_index.json'
THUMB_DIR = '.thumbs'

_LOCK = threading.RLock()
_CACHE = {'sig': None, 'items': []}
_WH = {}                      # id → (w, h)：图片尺寸的进程内缓存（不进表，表只装库成员）


def asset_dir():
    """唯一落点：`data/assets/`（与 assets_node 的 `asset_cache_dir` 同一个函数、同一个目录）。"""
    return data_dir('assets')


def kind_of(name):
    """文件名 → 'image' | 'video' | 'audio'；认不出返回 None（不列、不当资产）。"""
    ext = os.path.splitext(str(name or ''))[1].lower()
    if ext in IMG_EXT:
        return 'image'
    if ext in VID_EXT:
        return 'video'
    if ext in AUD_EXT:
        return 'audio'
    return None


def _skip(name):
    """不算货的：隐藏文件、写一半的 `_tmp_`、索引本身。"""
    return (not name) or name.startswith('.') or name.startswith('_tmp_') or name == INDEX_NAME


# ── 表 ──────────────────────────────────────────────────────────────────────
def _index_path():
    return os.path.join(asset_dir(), INDEX_NAME)


def _load():
    """读表。坏表/旧表一律当空表 —— 表只是"库成员"，丢了不影响文件。

    第一次跑（表还不存在）会顺手做一次**认领**：`data/assets/` 里已有的货本来就都是"全局库"
    的成员，不认领的话窗里会把它们全显示成临时产物、而 Library 一栏空着。
    认领只做一次 —— 表一旦落盘就不再自动加，否则"把某件移出库"会被下一次读取又加回来。
    """
    if not os.path.exists(_index_path()):
        bootstrap_library()
    try:
        with open(_index_path(), 'r', encoding='utf-8') as f:
            raw = json.load(f)
        if isinstance(raw, dict) and isinstance(raw.get('assets'), dict):
            return raw
    except (OSError, ValueError):
        pass
    return {'version': 1, 'bootstrapped': True, 'assets': {}}


def _atomic_write(path, data):
    """先写 `_tmp_*` 再 os.replace —— 断电/并发都不会留下半个文件。"""
    tmp = os.path.join(os.path.dirname(path), '_tmp_%s%s' % (uuid.uuid4().hex[:8], os.path.splitext(path)[1]))
    try:
        with open(tmp, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _save(idx):
    with _LOCK:
        _atomic_write(_index_path(), json.dumps(idx, ensure_ascii=False, indent=1).encode('utf-8'))
        _CACHE['sig'] = None          # 成员变了：清单缓存作废


# ── 清单 ────────────────────────────────────────────────────────────────────
def _dir_sig():
    """目录签名：条数 + 目录 mtime + 表 mtime。任何增删/改表都会换签名。"""
    d = asset_dir()
    try:
        st = os.stat(d)
        n = len(os.listdir(d))
    except OSError:
        return None
    try:
        im = os.stat(_index_path()).st_mtime
    except OSError:
        im = 0
    return (round(st.st_mtime, 3), n, round(im, 3))


def _scan_files():
    """目录扫描（**不读表**）：每件货的 id/file/kind/size/mtime，新的在前。"""
    d = asset_dir()
    out = []
    try:
        names = os.listdir(d)
    except OSError:
        return out
    for name in names:
        if _skip(name):
            continue
        p = os.path.join(d, name)
        try:
            if not os.path.isfile(p):
                continue
            st = os.stat(p)
        except OSError:
            continue
        kind = kind_of(name)
        if not kind:
            continue
        out.append({'id': os.path.splitext(name)[0], 'file': name, 'kind': kind,
                    'size': st.st_size, 'mtime': st.st_mtime})
    out.sort(key=lambda x: (-x['mtime'], x['id']))
    return out


def bootstrap_library():
    """第一次跑：把库里已有的货全部认成**库成员**（理由见 `_load`）。返回 True = 这次认领了。

    只做一次，靠"表文件在不在"判定 —— 表一旦落盘，之后哪怕被删空也不再自动加人，
    否则"把某件移出库"会被下一次读取原样加回来。
    """
    with _LOCK:
        if os.path.exists(_index_path()):
            return False
        files = _scan_files()
        if not files:
            return False
        idx = {'version': 1, 'bootstrapped': True, 'assets': {}}
        for f in files:
            idx['assets'][f['id']] = {'name': f['file'], 'origin': 'legacy',
                                      'created': round(float(f['mtime']), 3)}
        try:
            _atomic_write(_index_path(),
                          json.dumps(idx, ensure_ascii=False, indent=1).encode('utf-8'))
        except OSError:
            return False
        _CACHE['sig'] = None
        return True


def _is_member(meta):
    """表里这一行算不算库成员。老表没有 `member` 字段（= 首次认领写下的那些）默认是成员。"""
    return bool(meta) and meta.get('member', True) is not False


def records(refresh=False):
    """列一遍仓库：每件货一条记录（新的在前）。

    记录字段：`id / file / kind / size / mtime / name / inLibrary / origin / created / tags`
    以及两个可直接喂给前端的地址：`url`（字节）、`thumb`（缩略图，只有图片有）。
    """
    with _LOCK:
        sig = _dir_sig()
        if not refresh and _CACHE['sig'] == sig and _CACHE['items']:
            return list(_CACHE['items'])

    idx = _load()                     # 读取时顺带完成首次认领（只在新表时发生一次）
    members = idx.get('assets') if isinstance(idx.get('assets'), dict) else {}
    items = []
    for f in _scan_files():
        meta = members.get(f['id']) or {}
        items.append({
            'id': f['id'],
            'file': f['file'],
            'kind': f['kind'],
            'size': f['size'],
            'mtime': f['mtime'],
            'name': meta.get('name') or f['file'],
            'inLibrary': _is_member(meta),
            'origin': meta.get('origin') or ('legacy' if _is_member(meta) else 'session'),
            'created': meta.get('created') or f['mtime'],
            'tags': list(meta.get('tags') or []),
            'meta': dict(meta),
            'url': '/api/asset_media/' + f['id'],
            'thumb': ('/api/asset_thumb/' + f['id']) if f['kind'] == 'image' else None,
        })
    with _LOCK:
        _CACHE['sig'] = _dir_sig()
        _CACHE['items'] = list(items)
    return items


def dimensions(rec):
    """图片原生像素（进程内缓存）。卡片按宽高比排流式网格，清单里要它。

    `rec` 来自 `records()`：只认 `id` 与 `file`，不重新扫目录。打不开就是 (0, 0) —— 调用方
    退回 16:9，不该让一张坏图把整份清单拖垮。
    """
    aid = str(rec.get('id') or '')
    if not aid:
        return (0, 0)
    with _LOCK:
        hit = _WH.get(aid)
    if hit is not None:
        return hit
    path = os.path.join(asset_dir(), str(rec.get('file') or ''))
    try:
        from PIL import Image
        with Image.open(path) as im:
            wh = (int(im.size[0]), int(im.size[1]))
    except Exception:
        wh = (0, 0)
    with _LOCK:
        _WH[aid] = wh
    return wh


def get(asset_id):
    """单件记录（含 `w/h`，图片才现算）；找不到返回 None。"""
    aid = resolve(asset_id)
    if not aid:
        return None
    for it in records():
        if it['id'] == aid:
            rec = dict(it)
            rec['path'] = os.path.join(asset_dir(), rec['file'])
            if rec['kind'] == 'image':
                rec['w'], rec['h'] = dimensions(rec)
            return rec
    return None


def resolve(ref):
    """引用 → 规范 id。允许只给前 8 位以上（唯一才认）；歧义/找不到返回 None。"""
    s = str(ref or '').strip()
    if not s:
        return None
    ids = {it['id'] for it in records()}
    if s in ids:
        return s
    if len(s) >= 8:
        hits = [i for i in ids if i.startswith(s)]
        if len(hits) == 1:
            return hits[0]
    return None


def path_of(ref):
    rec = get(ref)
    return rec['path'] if rec else None


# ── 写入 ────────────────────────────────────────────────────────────────────
_MAGIC = (
    (b'\x89PNG\r\n\x1a\n', '.png'),
    (b'\xff\xd8\xff', '.jpg'),
    (b'GIF87a', '.gif'), (b'GIF89a', '.gif'),
    (b'BM', '.bmp'),
    (b'II*\x00', '.tif'), (b'MM\x00*', '.tif'),
)


def sniff_ext(data):
    """按魔数猜扩展名（dataURL 里常常没带类型，或者带了是错的）。认不出返回 None。"""
    head = bytes(data[:16]) if data else b''
    for magic, ext in _MAGIC:
        if head.startswith(magic):
            return ext
    if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
        return '.webp'
    if head[:4] == b'RIFF' and head[8:12] == b'WAVE':
        return '.wav'
    if head[4:8] == b'ftyp':
        return '.mp4'
    if head[:4] == b'\x1a\x45\xdf\xa3':
        return '.webm'
    if head[:3] == b'ID3' or head[:2] == b'\xff\xfb':
        return '.mp3'
    if head[:4] == b'OggS':
        return '.ogg'
    return None


def dataurl_bytes(u):
    """dataURL / 裸 base64 → bytes。解不开返回 None（调用方据此跳过这一张，别炸整批）。

    用 `validate=True`：默认的 b64decode 会**静默丢掉**非法字符，`'@@@@'` 于是解出空串 ——
    那会让"损坏的图"混进仓库变成一张 0 字节的假货，比报错难查得多。
    """
    if not isinstance(u, str) or not u.strip():
        return None
    s = u.strip()

    def _b64(payload):
        payload = (payload or '').strip()
        if not payload:
            return None
        try:
            raw = base64.b64decode(payload + '=' * (-len(payload) % 4), validate=True)
        except Exception:
            return None
        return raw or None

    if s.startswith('data:'):
        comma = s.find(',')
        if comma < 0:
            return None
        head, payload = s[:comma], s[comma + 1:]
        if ';base64' in head:
            return _b64(payload)
        try:
            return unquote_to_bytes(payload) or None
        except Exception:
            return None
    return _b64(s)


def _ensure_index_exists():
    """把"表存在"这件事先钉下来（空表也算）。

    为什么要在第一次**写入**时就建表：`_load()` 的首次认领靠"表在不在"判定。如果第一次写进来的是
    一张 session 图（库里还没有表），之后任何一次读取都会触发认领，把它错误地升成库成员。
    先落一张空表，认领就只可能发生在"老库、从没写过"的那种情况下。
    """
    with _LOCK:
        if os.path.exists(_index_path()):
            return
        try:
            _atomic_write(_index_path(),
                          json.dumps({'version': 1, 'bootstrapped': True, 'assets': {}},
                                     ensure_ascii=False, indent=1).encode('utf-8'))
        except OSError:
            pass


def _existing_stem(aid):
    """仓库里是否已有这个 hash 的文件（任何扩展名）。返回文件名或 None。

    内容寻址的 id 是文件 stem —— 同一份字节必须只有**一个**文件。老代码先信名字里的扩展名，
    A4 的 `.cud` 导入又把名字一律写成 `role-id.png`（字节可能是 GIF/JPEG 原件），于是同一
    hash 会同时存在 `.gif` 和 `.png` 两份，`records()` 数出两件货、`get()` 只会碰到其中一份。
    """
    try:
        for f in os.listdir(asset_dir()):
            if f.startswith(aid + '.'):
                return f
    except OSError:
        pass
    return None


def put_bytes(data, name=None, ext=None, origin='upload', library=False, tags=None, meta=None):
    """把一份字节放进仓库。返回记录（含 id / url）。

    `library=True` 才写进表（= 库成员）；否则只是仓库里的一份临时字节（scope=session），
    等它被某份文档引用或被用户"加入库"时才需要署名 —— 这是 A1 的事。
    """
    if not data:
        return None
    raw = bytes(data)
    aid = hashlib.md5(raw).hexdigest()
    # 扩展名先信**魔数**，再信名字：字节是真理，名字是提示（见 _existing_stem）。
    ext = (ext or sniff_ext(raw) or os.path.splitext(str(name or ''))[1] or '').lower()
    if ext and not ext.startswith('.'):
        ext = '.' + ext
    if not kind_of('x' + ext):
        ext = sniff_ext(raw) or ext or '.png'
    fname = aid + ext
    path = os.path.join(asset_dir(), fname)
    if not os.path.exists(path):
        sibling = _existing_stem(aid)
        if sibling:
            fname, path = sibling, os.path.join(asset_dir(), sibling)
    if not os.path.exists(path):
        try:
            _atomic_write(path, raw)
        except OSError:
            # 并发导入同一份字节（A4 的保存会并发问哈希）时，另一个线程可能刚把它落好；
            # 也可能它正被读到（Windows 下 replace 会 PermissionError）。字节相同，
            # 文件在就算成功。
            if not os.path.exists(path):
                raise
    _ensure_index_exists()          # 先钉住"表存在"：否则首次读取会把这张图误认成库成员
    if library:
        set_library(aid, name=name, origin=origin, tags=tags, meta=meta)
        return get(aid)
    # 不做库成员时**不查表**（records() 是一次目录扫描）：图池每条都调这里，
    # 一次扫 154 个文件的代价不该压在热路径上。返回值按已知事实拼即可。
    return {'id': aid, 'file': fname, 'kind': kind_of(fname) or 'image',
            'size': len(data), 'url': '/api/asset_media/' + aid,
            'name': name or aid, 'inLibrary': False, 'origin': origin}


def set_library(ref, name=None, origin=None, tags=None, meta=None, on=True):
    """把一件货标成库成员（或撤销）。名字/标签/来源都落在这张表里，重启后还在。"""
    aid = resolve(ref)
    if not aid:
        return None
    idx = _load()
    members = idx.setdefault('assets', {})
    if on:
        cur = dict(members.get(aid) or {})
        cur.setdefault('created', time.time())
        cur['member'] = True
        if name:
            cur['name'] = str(name)
        if origin:
            cur['origin'] = str(origin)
        if tags is not None:
            cur['tags'] = [str(t) for t in (tags or [])]
        if isinstance(meta, dict):
            cur.update({str(k): v for k, v in meta.items()})
        members[aid] = cur
    else:
        # 撤销库成员身份：字节与名字/标签都留着，只把 member 落下 —— 重命名过的临时产物
        # 再被踢出库时不该把名字一起忘掉（A1 的 scope 是派生的，这张表也装非成员的元数据）。
        cur = dict(members.get(aid) or {})
        cur['member'] = False
        members[aid] = cur
    _save(idx)
    return get(aid)


def update_meta(ref, name=None, tags=None, meta=None):
    """只改元数据（名字/标签/附属字段），**不动库成员身份**。

    和 `set_library` 的区别：set_library 是「把货收进库 / 移出库」，默认 `on=True`；
    拿它来改名会把一张 session 图顺手升成库成员。A1 的卡片对两种作用域都给了改名键，
    所以这里单独开一条口，缺表时按 `member: False` 落一行（改名不能改变它属于哪一档）。

    `meta` 是机械字段的合并口（A5 起 `proxyOf` 这类"谁是谁的派生物"住这儿）：
    只并进去，不删键；给 None 的值就是显式删掉那个键。
    """
    aid = resolve(ref)
    if not aid:
        return None
    idx = _load()
    members = idx.setdefault('assets', {})
    cur = dict(members.get(aid) or {})
    if aid not in members:
        cur.setdefault('created', time.time())
        cur['member'] = False
    if name is not None:
        cur['name'] = str(name)
    if tags is not None:
        cur['tags'] = [str(t) for t in (tags or [])]
    if meta:
        for k, v in dict(meta).items():
            if v is None:
                cur.pop(str(k), None)
            else:
                cur[str(k)] = v
    members[aid] = cur
    _save(idx)
    return get(aid)


def rename(ref, name):
    return set_library(ref, name=name)


def delete(ref):
    """删一件货：字节 + 缩略图 + 表记录。返回被删的文件名；找不到返回 None。

    **没有引用检查** —— 引用图（文档 manifest / 图层 / 特效槽 / 时间线）要到 A4/A6 才存在。
    在那之前由调用方兜底：窗里的删除有确认框，且只对"仓库里没有人在用"的货开放。
    等引用图落地，这里要改成"有引用就拒绝并列出引用方"（见设计 §6）。
    """
    rec = get(ref)
    if not rec:
        return None
    aid = rec['id']
    idx = _load()
    members = idx.get('assets')
    if isinstance(members, dict) and aid in members:
        members.pop(aid, None)
        _save(idx)
    try:
        os.remove(rec['path'])
    except OSError:
        pass
    try:
        td = os.path.join(asset_dir(), THUMB_DIR)
        for f in os.listdir(td):
            if f.startswith(aid + '_'):
                try:
                    os.remove(os.path.join(td, f))
                except OSError:
                    pass
    except OSError:
        pass
    _WH.pop(aid, None)
    _CACHE['sig'] = None
    return rec['file']


# ── 缩略图 ──────────────────────────────────────────────────────────────────
def thumb_path(ref, w=160, force=False):
    """缩略图落盘路径（按需生成，缓存在 `data/assets/.thumbs/<id>_<w>.jpg`）。

    只有图片有；视频/音频走各自那套（`/api/vid_frame`、波形），这里不掺和。
    背景压成 #141416 —— 深色界面上的透明图不该白底发光。
    """
    rec = get(ref)
    if not rec or rec['kind'] != 'image':
        return None
    try:
        w = max(32, min(1024, int(w)))
    except (TypeError, ValueError):
        w = 160
    d = os.path.join(asset_dir(), THUMB_DIR)
    os.makedirs(d, exist_ok=True)
    tp = os.path.join(d, '%s_%d.jpg' % (rec['id'], w))
    if not force and os.path.exists(tp):
        try:
            if os.path.getmtime(tp) >= rec['mtime']:
                return tp
        except OSError:
            pass
    try:
        from PIL import Image
        with Image.open(rec['path']) as im:
            im.draft('RGB', (w * 2, w * 2))
            if im.mode in ('RGBA', 'LA', 'P'):
                rgba = im.convert('RGBA')
                bg = Image.new('RGB', rgba.size, (20, 20, 22))
                bg.paste(rgba, mask=rgba.split()[-1])
                im = bg
            else:
                im = im.convert('RGB')
            im.thumbnail((w, w), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, 'JPEG', quality=82, optimize=True)
        _atomic_write(tp, buf.getvalue())
        return tp
    except Exception:
        return None


def stats():
    """仓库概览：给窗底状态条用。"""
    items = records()
    by_kind = {}
    total = 0
    for it in items:
        by_kind[it['kind']] = by_kind.get(it['kind'], 0) + 1
        total += it['size']
    return {
        'count': len(items),
        'bytes': total,
        'byKind': by_kind,
        'library': sum(1 for it in items if it['inLibrary']),
        'dir': asset_dir(),
    }
