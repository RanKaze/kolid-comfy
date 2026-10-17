"""界面探针的快照存取 —— 后端只做四件事：收下来、存成文件、列出来、读回去。

**为什么是文件而不是数据库**：快照的消费者是排查问题的人（和读同一台机器的 agent），
他们都长处在一个"读一个 JSON 文件"的位置上，而文件放在明处意味着**不需要任何接口也能看**。
索引单独存一份 `index.json`，是因为列历史时不该为了一个标题把每个几百 KB 的快照都读一遍。

放在 `temporary/ui_probe/`：与无头 harness（temporary/ 下那几个 `.cjs`）同一个根，
于是"浏览器里抓一份 → 立刻在无头环境里重放"这条回路不需要在目录之间搬文件。
"""
from __future__ import annotations

import json
import os
import re
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, 'temporary', 'ui_probe')
INDEX = os.path.join(DIR, 'index.json')
# 保留多少份。快照是"出问题的那一刻"，不是归档；攒太多反而让"最新"变得不好找。
KEEP = 60
# 单个快照的上限。真超了说明抓的东西不对（比如把图片塞进去了），收下也没用。
MAX_BYTES = 24 * 1024 * 1024
_NAME_OK = re.compile(r'^[A-Za-z0-9._-]{1,120}$')


def _ensure() -> None:
    os.makedirs(DIR, exist_ok=True)


def _read_index() -> list[dict]:
    try:
        with open(INDEX, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _write_index(rows: list[dict]) -> None:
    _ensure()
    tmp = INDEX + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    os.replace(tmp, INDEX)


def _summary(snap: dict) -> dict:
    """索引里留一行元信息：够在列表里认出来，又不至于把整份快照读进来。"""
    page = snap.get('page') or {}
    vp = page.get('viewport') or {}
    body = page.get('body') or {}
    problems = snap.get('problems') or []
    by = {'error': 0, 'warn': 0, 'info': 0}
    for p in problems:
        lv = p.get('level')
        if lv in by:
            by[lv] += 1
    dock = snap.get('dock') or {}
    rows = dock.get('rows') or []
    return {
        'id': snap.get('id'),
        'at': snap.get('at'),
        'build': snap.get('build'),
        'label': snap.get('label') or '',
        'viewport': [vp.get('w'), vp.get('h')],
        'dockW': body.get('dockW'),
        'spill': (body.get('bodyW') or 0) - (body.get('innerW') or 0),
        'outline': snap.get('outline') or '',
        'nodes': len(rows),
        'errors': by['error'],
        'warns': by['warn'],
        'infos': by['info'],
        'codes': [p.get('code') for p in problems][:12],
    }


def save(snap: dict) -> dict:
    """收一份快照。文件名用快照自己的 id（时间戳在前，天然可排序）。"""
    if not isinstance(snap, dict) or snap.get('kind') != 'kolid-ui-probe':
        raise ValueError('not a ui-probe snapshot')
    _ensure()
    raw = json.dumps(snap, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(raw) > MAX_BYTES:
        raise ValueError('snapshot too large: %d bytes' % len(raw))
    at = str(snap.get('at') or '')
    base = str(snap.get('id') or '')
    if not _NAME_OK.match(base):
        # 有些客户端不会给 id，或给的形状不合法：用收下的时刻现造一个，绝不用它拼路径。
        base = time.strftime('%Y-%m-%dT%H-%M-%S', time.localtime()) + '-' + str(int(time.time() * 1000) % 1000)
    name = base + '.json'
    path = os.path.join(DIR, name)
    with open(path, 'wb') as f:
        f.write(raw)
    # 再落一份人读的 .md：`cat temporary/ui_probe/<id>.md` 就能拿到结论，不必先跑查看器，
    # 也不必让读的人去啃几百 KB 的 JSON。
    try:
        with open(os.path.join(DIR, base + '.md'), 'w', encoding='utf-8') as f:
            f.write(report_text(snap))
    except Exception:
        pass

    rows = [r for r in _read_index() if r.get('file') != name]
    rows.append({'file': name, 'bytes': len(raw), 'savedAt': time.strftime('%Y-%m-%dT%H:%M:%S'), **_summary(snap)})
    rows.sort(key=lambda r: str(r.get('at') or r.get('savedAt') or ''))
    for old in rows[:-KEEP]:
        try:
            os.remove(os.path.join(DIR, str(old.get('file'))))
        except Exception:
            pass
    _write_index(rows[-KEEP:])
    return {'file': name, 'dir': DIR, 'bytes': len(raw)}


def listing() -> list[dict]:
    rows = _read_index()
    have = {r.get('file') for r in rows}
    # 索引与目录不一致时以目录为准（有人手工删过文件），顺手把缺失的补回来。
    try:
        on_disk = {n for n in os.listdir(DIR) if n.endswith('.json') and n != 'index.json'}
    except Exception:
        on_disk = set()
    for n in sorted(on_disk - have):
        p = os.path.join(DIR, n)
        try:
            with open(p, 'r', encoding='utf-8') as f:
                snap = json.load(f)
            rows.append({'file': n, 'bytes': os.path.getsize(p), 'savedAt': '', **_summary(snap)})
        except Exception:
            continue
    rows = [r for r in rows if r.get('file') in on_disk or not on_disk]
    rows.sort(key=lambda r: str(r.get('at') or ''), reverse=True)
    return rows


def load(name: str) -> dict | None:
    if not _NAME_OK.match(name or '') or '..' in name:
        return None
    path = os.path.join(DIR, name)
    if os.path.dirname(os.path.abspath(path)) != os.path.abspath(DIR):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def latest() -> dict | None:
    rows = listing()
    if rows:
        got = load(str(rows[0].get('file')))
        if got:
            return got
    # 索引没了也别回空手：目录里最新的那个文件就是答案。
    try:
        names = [n for n in os.listdir(DIR) if n.endswith('.json') and n != 'index.json']
        names.sort(key=lambda n: os.path.getmtime(os.path.join(DIR, n)), reverse=True)
        return load(names[0]) if names else None
    except Exception:
        return None


def build_info() -> dict:
    """页面上的 build 是不是由**当前源码**构建的 —— 排查时的第一个问题。

    判据不用构建戳，而是直接比文件时间：产物比源码旧就是旧的。这比任何自报的版本号都硬，
    因为版本号可以被忘记更新，而 mtime 不会。
    """
    web = os.path.join(ROOT, 'nodes', 'web', 'sampler_node.html')
    src_dir = os.path.join(ROOT, 'ui', 'sampler_node', 'src')
    out_m = os.path.getmtime(web) if os.path.exists(web) else 0
    newest, newest_at = 0.0, ''
    for base, _dirs, files in os.walk(src_dir):
        for n in files:
            p = os.path.join(base, n)
            try:
                m = os.path.getmtime(p)
            except OSError:
                continue
            if m > newest:
                newest, newest_at = m, os.path.relpath(p, ROOT)
    cfg = os.path.join(ROOT, 'ui', 'sampler_node', 'vite.config.ts')
    if os.path.exists(cfg) and os.path.getmtime(cfg) > newest:
        newest, newest_at = os.path.getmtime(cfg), 'ui/sampler_node/vite.config.ts'
    return {
        'bundle': 'nodes/web/sampler_node.html',
        'bundleAt': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(out_m)) if out_m else None,
        'bundleMtime': out_m,
        'newestSrc': newest_at,
        'newestSrcMtime': newest,
        'stale': bool(out_m and newest and newest > out_m + 1),
        'viewer': os.path.exists(os.path.join(ROOT, 'nodes', 'web', 'probe_viewer.html')),
        'dir': DIR,
        'count': len(listing()),
    }


def report_text(snap: dict) -> str:
    """快照的文件版摘要：`temporary/ui_probe/<id>.md`，方便直接读而不必先跑一遍查看器。"""
    page = snap.get('page') or {}
    vp = page.get('viewport') or {}
    body = page.get('body') or {}
    out = ['# 界面探针快照 ' + str(snap.get('id') or ''),
           'build %s · %s · 视口 %sx%s@%sx' % (snap.get('build'), snap.get('at'), vp.get('w'), vp.get('h'), vp.get('dpr')),
           '布局：%s' % (snap.get('outline') or ''),
           '', '## 问题（%d）' % len(snap.get('problems') or [])]
    for p in snap.get('problems') or []:
        out.append('- [%s] %s @%s' % (p.get('level'), p.get('code'), p.get('where')))
        out.append('  %s' % p.get('message'))
        if p.get('numbers'):
            out.append('  `%s`' % ' '.join('%s=%s' % kv for kv in p['numbers'].items()))
    rows = (snap.get('dock') or {}).get('rows') or []
    blocks = [r for r in rows if r.get('kind') == 'b']
    if blocks:
        out += ['', '## block 声明 / 显示', '| block | 声明 | 显示 | flex | 可拖 |', '| --- | --- | --- | --- | --- |']
        for r in blocks:
            t = r.get('travel') or {}
            out.append('| %s | %s | %s | %s | %s |' % (
                r.get('block'), r.get('declared') if r.get('declared') is not None else 'free',
                r.get('rendered'), r.get('flex'),
                ('%d–%d' % (t.get('lo', 0), t.get('hi', 0))) if t else '—'))
    out += ['', '视口内宽 %s / 文档宽 %s' % (body.get('innerW'), body.get('bodyW'))]
    return '\n'.join(out) + '\n'
