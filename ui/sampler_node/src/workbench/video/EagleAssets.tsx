import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, ASSET_ITEM_TYPE, GLOBAL_ITEM_TYPE } from './Assets';
import { addAsset, newVidId, type VidController } from './model';
import { probeMedia } from './audio';
import type { InspectSel } from './Inspector';
import { CardScaleControl, aspectOf, cardHeightOf, justifiedRows, useAssetScale } from '../assetScale';

// ── Eagle 窗 ───────────────────────────────────────────────────────────────────────────────
// Eagle 的库和 Assets 不是同一种东西：那边是"这一份工程在用的资产"，这边是用户自己的**外部**素材库，
// 浏览方式是文件夹树 + 标签。所以它单占一扇 dock 窗，不挤进 Assets 的作用域条。
//
// **只读、零拷贝**：清单现读 Eagle 的 metadata，原件 / 缩略图由 `/api/eagle_*` 直接从 `.library`
// 目录伺服；这里不往 `data/assets` 写一个字节。拖进时间线/图层只记 URL。
//
// 布局照 Eagle 自己那套：左边 All / 文件夹树 / 标签，右边卡片；两套筛选可叠（文件夹 ∩ 标签）。

export type EagleItem = {
  id: string;
  name: string;
  file: string;
  ext: string;
  kind: 'image' | 'video' | 'audio';
  size: number;
  mtime: number;
  w: number;
  h: number;
  duration: number;
  tags: string[];
  folders: string[];
  /** Eagle 生成的缩略图文件名；没有就 null（图片退回原件、视频抓首帧）。 */
  thumb: string | null;
};

export type EagleFolder = {
  id: string; name: string; count: number; total: number;
  /** Eagle 的文件夹图标（photo / film3 / box / bookshelf）与颜色（red / green …）。 */
  icon?: string; color?: string;
  children: EagleFolder[];
};

export type EagleLib = {
  ok: boolean;
  root: string | null;
  name: string | null;
  folders: EagleFolder[];
  tags: { name: string; count: number }[];
  items: EagleItem[];
  /** 不支持在浏览器里直读的条目（PSD/FBX/TS、已删除、缺文件）—— 只报数，不画卡。 */
  hidden: number;
  error?: string;
};

const EAGLE_PAGE = 120;
const eagleUrl = (id: string): string => '/api/eagle_media/' + encodeURIComponent(id);
const eagleThumbUrl = (id: string): string => '/api/eagle_thumb/' + encodeURIComponent(id);
const folderName = (p: string): string => {
  if (!p) return '';
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
};
/** 读写数都带千位分隔 —— Eagle 自己那一栏就是这么写的。 */
const fmtCount = (n: number): string => n.toLocaleString();

// ── 图标与树 ──────────────────────────────────────────────────────────────────────────────
const EAGLE_TINTS: Record<string, string> = {
  red: '#ff5c5c', orange: '#ff9f0a', yellow: '#ffd60a', green: '#30d158',
  blue: '#4aa8ff', purple: '#bf5af2', pink: '#ff6b9d', brown: '#b08968', gray: '#8e8e93',
};
const eagleTint = (c?: string): string => {
  const key = String(c || '').toLowerCase();
  return EAGLE_TINTS[key] || (key.startsWith('#') ? key : '#8e8e93');
};

const EagleFolderGlyph: React.FC<{ color?: string; icon?: string; size?: number }> = ({ color, icon, size = 13 }) => {
  const c = eagleTint(color);
  const common = {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: c,
    strokeWidth: 1.3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
    style: { display: 'block', flexShrink: 0 },
  };
  if (icon === 'film3') return (
    <svg {...common}>
      <rect x="2" y="4" width="12" height="8" rx="1.2" />
      <path d="M4.6 4v8M8 4v8M11.4 4v8M2 6.6h12M2 9.4h12" opacity=".75" />
    </svg>
  );
  if (icon === 'box') return (
    <svg {...common}><path d="M8 2.2 13.5 5v6L8 13.8 2.5 11V5z" /><path d="M2.5 5 8 7.8 13.5 5M8 7.8v6" /></svg>
  );
  if (icon === 'bookshelf') return (
    <svg {...common}>
      <rect x="2.6" y="3" width="3.1" height="10" rx=".6" />
      <rect x="6.8" y="4" width="3.1" height="9" rx=".6" />
      <path d="M11 4.4l2.4 8.4" />
    </svg>
  );
  if (icon === 'photo') return (
    <svg {...common}>
      <rect x="2" y="3.2" width="12" height="9.6" rx="1.4" />
      <circle cx="5.6" cy="6.4" r="1.1" />
      <path d="M3 11.4l3.2-3.2 2.3 2.3 1.8-1.8 2.7 2.7" />
    </svg>
  );
  return (
    <svg {...common}>
      <path d="M2 5.4A1.4 1.4 0 0 1 3.4 4h2.9l1.4 1.6h4.9A1.4 1.4 0 0 1 14 7v5.6a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 12.6z" />
    </svg>
  );
};

const EagleAllIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"
    strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <rect x="2.2" y="2.2" width="4.6" height="4.6" rx="1" /><rect x="9.2" y="2.2" width="4.6" height="4.6" rx="1" />
    <rect x="2.2" y="9.2" width="4.6" height="4.6" rx="1" /><rect x="9.2" y="9.2" width="4.6" height="4.6" rx="1" />
  </svg>
);
const EagleTagGlyph = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"
    strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <path d="M8.4 2.2H13a.8.8 0 0 1 .8.8v4.6L7.4 14a1 1 0 0 1-1.4 0L2 10a1 1 0 0 1 0-1.4z" />
    <circle cx="10.8" cy="5.2" r="1" />
  </svg>
);
const EagleChevron: React.FC<{ open: boolean }> = ({ open }) => (
  <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4"
    strokeLinecap="round" strokeLinejoin="round"
    style={{ display: 'block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 90ms' }}>
    <path d="M3.5 2.5 6.5 5l-3 2.5" />
  </svg>
);
const EagleSidebarIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"
    strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <rect x="2" y="2.5" width="12" height="11" rx="1.4" />
    <path d="M6.4 2.5v11" />
  </svg>
);
const PlusIcon = () => (
  <svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
    <path d="M6 2.5v7M2.5 6h7" />
  </svg>
);

const rowBtn: React.CSSProperties = {
  flexShrink: 0, width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'none', border: 'none', borderRadius: 4, color: 'rgba(255,255,255,0.35)', cursor: 'pointer', padding: 0,
};
const selStyle: React.CSSProperties = {
  height: 20, fontSize: 9.5, color: 'rgba(255,255,255,0.6)', background: '#1b1b1e',
  border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 4, padding: '0 2px',
  outline: 'none', cursor: 'pointer', minWidth: 0,
};
const eagleRowStyle = (selected: boolean, depth = 0): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 3, height: 20, borderRadius: 4, flexShrink: 0,
  padding: `0 4px 0 ${4 + depth * 10}px`, cursor: 'pointer', userSelect: 'none', minWidth: 0,
  background: selected ? 'rgba(10,132,255,0.2)' : 'transparent',
  color: selected ? '#eaf3ff' : 'rgba(255,255,255,0.66)',
});
const eagleNameStyle: React.CSSProperties = {
  flex: 1, minWidth: 0, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const eagleCountStyle: React.CSSProperties = {
  flexShrink: 0, fontSize: 9, color: 'rgba(255,255,255,0.34)', fontVariantNumeric: 'tabular-nums',
};
const eagleSectionStyle: React.CSSProperties = {
  padding: '8px 6px 3px', fontSize: 8.5, fontWeight: 700, letterSpacing: 0.5,
  color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase',
};

const EagleTree: React.FC<{
  nodes: EagleFolder[];
  depth: number;
  selected: string;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}> = ({ nodes, depth, selected, expanded, onToggle, onSelect }) => (
  <>
    {nodes.map(f => {
      const kids = f.children || [];
      const open = expanded.has(f.id);
      return (
        <React.Fragment key={f.id}>
          <div
            style={eagleRowStyle(selected === f.id, depth)}
            onClick={() => onSelect(f.id)}
            title={f.name}
          >
            {kids.length ? (
              <button
                onClick={e => { e.stopPropagation(); onToggle(f.id); }}
                title={open ? 'Collapse' : 'Expand'}
                style={{
                  width: 11, height: 16, padding: 0, border: 'none', background: 'none',
                  color: 'rgba(255,255,255,0.4)', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
                }}
              ><EagleChevron open={open} /></button>
            ) : <span style={{ width: 11, flexShrink: 0 }} />}
            <EagleFolderGlyph color={f.color} icon={f.icon} />
            <span style={eagleNameStyle}>{f.name}</span>
            <span style={eagleCountStyle}>{fmtCount(f.total)}</span>
          </div>
          {kids.length > 0 && open && (
            <EagleTree nodes={kids} depth={depth + 1} selected={selected}
              expanded={expanded} onToggle={onToggle} onSelect={onSelect} />
          )}
        </React.Fragment>
      );
    })}
  </>
);

const EagleSidebar: React.FC<{
  folders: EagleFolder[];
  total: number;
  unfiled: number;
  selectedFolder: string;
  onFolder: (id: string) => void;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  tags: { name: string; count: number }[];
  selectedTag: string | null;
  onTag: (tag: string | null) => void;
}> = ({ folders, total, unfiled, selectedFolder, onFolder, expanded, onToggle, tags, selectedTag, onTag }) => {
  const folderCount = useMemo(() => {
    let n = 0;
    const walk = (fs: EagleFolder[]) => { for (const f of fs) { n++; walk(f.children || []); } };
    walk(folders);
    return n;
  }, [folders]);
  return (
    <div style={{
      // 窄窗里最多吃一半，剩下的一半至少还放得下一列卡片；宽窗按 168px 停住。
      width: 168, maxWidth: '50%', flexShrink: 0, alignSelf: 'stretch', overflowY: 'auto', overflowX: 'hidden',
      scrollbarWidth: 'thin', borderRight: '0.5px solid rgba(255,255,255,0.08)',
      padding: '4px 3px 12px', background: 'rgba(255,255,255,0.012)', minWidth: 0,
    }}>
      <div
        style={eagleRowStyle(!selectedFolder && !selectedTag)}
        onClick={() => { onFolder(''); onTag(null); }}
        title="Everything in the Eagle library"
      >
        <span style={{ width: 11, flexShrink: 0 }} />
        <span style={{ color: 'rgba(255,255,255,0.55)', display: 'flex' }}><EagleAllIcon /></span>
        <span style={eagleNameStyle}>All</span>
        <span style={eagleCountStyle}>{fmtCount(total)}</span>
      </div>

      <div style={eagleSectionStyle}>Folders ({folderCount})</div>
      <EagleTree nodes={folders} depth={0} selected={selectedFolder}
        expanded={expanded} onToggle={onToggle} onSelect={onFolder} />
      <div
        style={eagleRowStyle(selectedFolder === '__none__')}
        onClick={() => onFolder('__none__')}
        title="Items that are not in any folder"
      >
        <span style={{ width: 11, flexShrink: 0 }} />
        <EagleFolderGlyph color="gray" />
        <span style={eagleNameStyle}>Unfiled</span>
        <span style={eagleCountStyle}>{fmtCount(unfiled)}</span>
      </div>

      <div style={eagleSectionStyle}>Tags ({tags.length})</div>
      {tags.map(t => (
        <div
          key={t.name}
          style={eagleRowStyle(selectedTag === t.name)}
          onClick={() => onTag(selectedTag === t.name ? null : t.name)}
          title={t.name}
        >
          <span style={{ width: 11, flexShrink: 0 }} />
          <span style={{ color: 'rgba(255,255,255,0.45)', display: 'flex' }}><EagleTagGlyph /></span>
          <span style={eagleNameStyle}>{t.name}</span>
          <span style={eagleCountStyle}>{fmtCount(t.count)}</span>
        </div>
      ))}
      {!tags.length && (
        <div style={{ padding: '2px 6px', fontSize: 9, color: 'rgba(255,255,255,0.28)' }}>
          No tags in this library
        </div>
      )}
    </div>
  );
};

export const VidEagleAssets: React.FC<{
  vid?: VidController;
  canClaim?: boolean;
  /** 双击一张卡 = 交给 Inspector 放大看（由宿主打开 Inspector 窗）。 */
  onInspect?: (sel: InspectSel) => void;
}> = ({ vid, canClaim, onInspect }) => {
  const assetScale = useAssetScale('eagle');
  const cardH = cardHeightOf(assetScale);
  const [lib, setLib] = useState<EagleLib | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const forceRef = useRef(false);
  const [kind, setKind] = useState<'all' | 'image' | 'video' | 'audio'>('all');
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [treeOpen, setTreeOpen] = useState(true);
  const [sel, setSel] = useState<string | null>(null);
  const [shown, setShown] = useState(EAGLE_PAGE);
  const [gridW, setGridW] = useState(0);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<string | null>(null);

  const reload = useCallback((force = false) => {
    if (force) forceRef.current = true;
    setTick(t => t + 1);
  }, []);

  useEffect(() => {
    let alive = true;
    const force = forceRef.current;
    forceRef.current = false;
    setBusy(true);
    setErr(null);
    fetch('/api/eagle_lib' + (force ? '?refresh=1' : ''))
      .then(r => {
        if (!r.ok) {
          throw new Error(r.status === 404
            ? 'Eagle API is not available — restart the backend'
            : `Eagle list failed (${r.status})`);
        }
        return r.json();
      })
      .then((d: EagleLib) => {
        if (!alive) return;
        setLib(d && typeof d === 'object' ? d : null);
        if (d?.ok === false) setErr(d.error || 'Eagle library could not be read');
      })
      .catch(e => { if (alive) { setLib(null); setErr(String(e)); } })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [tick]);

  // 行布局要知道可用的内容宽度（显隐文件夹树、窗宽变化都会改它）。
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const read = () => setGridW(Math.max(0, Math.round(el.clientWidth - 16)));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 换了一份库：过滤、选中、展开都归零；根层文件夹默认展开（深层的保持折叠）。
  useEffect(() => {
    if (!lib?.root || rootRef.current === lib.root) return;
    rootRef.current = lib.root;
    setFolder('');
    setTag(null);
    setSel(null);
    setKind('all');
    setQ('');
    setExpanded(new Set(lib.folders.filter(f => (f.children || []).length).map(f => f.id)));
  }, [lib]);

  const folderList = useMemo(() => {
    const out: { id: string; name: string; depth: number; total: number }[] = [];
    const walk = (fs: EagleFolder[], depth: number) => {
      for (const f of fs) {
        out.push({ id: f.id, name: f.name, depth, total: f.total ?? f.count });
        walk(f.children || [], depth + 1);
      }
    };
    walk(lib?.folders || [], 0);
    return out;
  }, [lib]);

  /** 选父文件夹 = 连子文件夹一起看（否则点 "Image" 会得到一张空网格）。 */
  const folderIds = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const walk = (fs: EagleFolder[]): Set<string> => {
      const union = new Set<string>();
      for (const f of fs) {
        const ids = new Set<string>([f.id, ...walk(f.children || [])]);
        m.set(f.id, ids);
        ids.forEach(id => union.add(id));
      }
      return union;
    };
    walk(lib?.folders || []);
    return m;
  }, [lib]);

  const folderLabel = useMemo(() => {
    const m = new Map(folderList.map(f => [f.id, f.name] as [string, string]));
    return (ids: string[]): string => ids.map(id => m.get(id)).filter(Boolean).slice(0, 1).join('');
  }, [folderList]);

  const unfiled = useMemo(() => (lib?.items || []).filter(it => !it.folders.length).length, [lib]);

  useEffect(() => {
    if (lib && folder && folder !== '__none__' && !folderList.some(f => f.id === folder)) setFolder('');
  }, [lib, folder, folderList]);
  useEffect(() => {
    if (lib && tag && !lib.tags.some(t => t.name === tag)) setTag(null);
  }, [lib, tag]);

  const items = useMemo(() => {
    if (!lib?.ok) return [];
    const needle = q.trim().toLowerCase();
    return lib.items.filter(it => {
      if (kind !== 'all' && it.kind !== kind) return false;
      if (folder === '__none__') {
        if (it.folders.length) return false;
      } else if (folder) {
        const ids = folderIds.get(folder);
        if (!it.folders.some(id => ids?.has(id))) return false;
      }
      if (tag && !it.tags.includes(tag)) return false;
      if (!needle) return true;
      return it.name.toLowerCase().includes(needle)
        || it.file.toLowerCase().includes(needle)
        || it.tags.some(t => t.toLowerCase().includes(needle));
    });
  }, [lib, kind, folder, folderIds, tag, q]);

  useEffect(() => { setShown(EAGLE_PAGE); }, [lib, kind, folder, tag, q]);
  useEffect(() => {
    if (sel && !items.some(it => 'e:' + it.id === sel)) setSel(null);
  }, [items, sel]);

  useEffect(() => {
    if (shown >= items.length) return;
    const el = moreRef.current;
    if (!el) return;
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) setShown(n => n + EAGLE_PAGE);
    }, { root: gridRef.current, rootMargin: '320px' });
    io.observe(el);
    return () => io.disconnect();
  }, [shown, items.length]);

  const toggleFolder = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const claim = async (it: EagleItem) => {
    if (!vid || !canClaim) return;
    const url = eagleUrl(it.id);
    const info = await probeMedia(url, it.kind === 'audio' ? 'audio' : 'video');
    if (!info) { setErr('Could not read this Eagle file'); return; }
    vid.update(proj => addAsset(proj, {
      id: newVidId('as'), name: it.name, src: url, origin: 'file',
      kind: info.audioOnly ? 'audio' : 'video',
      duration: info.duration || it.duration, hasAudio: info.hasAudio,
    }), 'Add Eagle asset');
  };

  const pickLibrary = async () => {
    setErr(null);
    try {
      const r = await fetch('/api/io_pick', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'open', kind: 'folder', suggested: lib?.root || '' }),
      }).then(x => x.json());
      if (r?.cancelled || !r?.picks?.length) return;
      const w = await fetch('/api/eagle_lib', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: r.picks[0].path }),
      }).then(x => x.json());
      if (w?.ok) {
        rootRef.current = null;
        setLib(w as EagleLib);
        setErr(null);
      } else {
        setErr(w?.error || 'That folder is not an Eagle library');
      }
    } catch (e) { setErr(String(e)); }
  };

  const visible = items.slice(0, shown);
  // Eagle 那张网格的排法：整行铺满，行内图片等高。宽度还没量到时先按 320 排，量到会立刻重排。
  const rows = justifiedRows(
    visible.map(it => ({ it, ratio: aspectOf(it.w, it.h, it.kind === 'audio' ? 1.6 : 16 / 9) })),
    gridW || 320, cardH, 6,
  );
  const broken = !!err || (!!lib && !lib.ok);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#141416', minWidth: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 6px', borderBottom: '0.5px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
        <button
          title={treeOpen ? 'Hide folders and tags' : 'Show folders and tags'}
          onClick={() => setTreeOpen(o => !o)}
          style={{
            ...rowBtn, width: 20, height: 20, background: 'rgba(255,255,255,0.04)',
            border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 4,
            color: treeOpen ? '#3b9dff' : 'rgba(255,255,255,0.55)',
          }}
        ><EagleSidebarIcon /></button>
        <select value={kind} onChange={e => setKind(e.target.value as 'all' | 'image' | 'video' | 'audio')} style={selStyle}>
          <option value="all">All kinds</option>
          <option value="image">Images</option>
          <option value="video">Video</option>
          <option value="audio">Audio</option>
        </select>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search Eagle…"
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0, height: 20, fontSize: 9.5, color: 'rgba(255,255,255,0.75)',
            background: '#1b1b1e', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 4,
            padding: '0 5px', outline: 'none',
          }}
        />
        <CardScaleControl kind="eagle" />
        <button
          title="Read the Eagle library again from disk"
          onClick={() => reload(true)}
          style={{
            ...rowBtn, width: 'auto', height: 20, padding: '0 6px', flexShrink: 0,
            fontSize: 8.5, fontWeight: 600, border: '0.5px solid rgba(255,255,255,0.12)',
            borderRadius: 4, color: 'rgba(255,255,255,0.45)',
          }}
        >Rescan</button>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
        {treeOpen && (
          <EagleSidebar
            folders={lib?.folders || []}
            total={lib?.items.length || 0}
            unfiled={unfiled}
            selectedFolder={folder}
            onFolder={setFolder}
            expanded={expanded}
            onToggle={toggleFolder}
            tags={lib?.tags || []}
            selectedTag={tag}
            onTag={setTag}
          />
        )}
        <div
          ref={gridRef}
          style={{
            flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', scrollbarWidth: 'thin',
            padding: 8, display: 'flex', flexDirection: 'column', gap: 6,
          }}
        >
          {items.length === 0 && (
            <div style={{ width: '100%', padding: 16, fontSize: 11, color: 'rgba(255,255,255,0.35)', textAlign: 'center', lineHeight: 1.8, whiteSpace: 'pre-line' }}>
              {busy ? 'Scanning your Eagle library…'
                : err ? err
                  : !lib ? 'Reading the Eagle library…'
                    : !lib.ok ? 'No Eagle library found.\nUse Library… below to point at an Eagle .library folder.'
                      : lib.items.length === 0 ? 'This Eagle library has nothing this window can show.'
                        : 'Nothing matches.\nTry another folder, tag or search.'}
            </div>
          )}

          {/* 一行一个 flex 行：宽度是算好的，整行刚好铺满；行内所有卡的图片高度相同。 */}
          {rows.map((row, ri) => (
            <div key={'r' + ri} style={{ display: 'flex', gap: 6, width: '100%', flexShrink: 0, alignItems: 'flex-start' }}>
              {row.items.map(({ it }, i) => {
                const key = 'e:' + it.id;
                const url = eagleUrl(it.id);
                const folderText = folderLabel(it.folders);
                const drag: Record<string, string> = {
                  [ASSET_ITEM_TYPE]: JSON.stringify({ url, name: it.name, kind: it.kind }),
                };
                if (it.kind !== 'image') {
                  drag[GLOBAL_ITEM_TYPE] = JSON.stringify({ url, name: it.name, kind: it.kind });
                }
                const payload: InspectSel = {
                  key, name: it.name, kind: it.kind, src: url, duration: it.duration,
                  hasAudio: null, origin: 'Eagle', size: it.size,
                };
                return (
                  <Card
                    key={key}
                    cardH={row.height}
                    cardW={row.widths[i]}
                    selected={sel === key}
                    onClick={() => setSel(key)}
                    onDoubleClick={() => onInspect?.(payload)}
                    it={{
                      name: it.file || it.name, kind: it.kind, src: url,
                      duration: it.duration, hasAudio: null,
                      w: it.w, h: it.h,
                      poster: it.thumb ? eagleThumbUrl(it.id) : (it.kind === 'image' ? url : null),
                      byteFrom: 'eagle',
                      origin: folderText ? 'Eagle · ' + folderText : 'Eagle',
                      drag,
                      actions: canClaim && vid && it.kind !== 'image' ? (
                        <button
                          title={'Claim「' + it.name + '」into this project — references the Eagle file in place'}
                          onClick={() => void claim(it)}
                          style={rowBtn}
                        ><PlusIcon /></button>
                      ) : undefined,
                    }}
                  />
                );
              })}
            </div>
          ))}

          {shown < items.length && (
            <div
              ref={moreRef}
              style={{ width: '100%', padding: '6px 4px 10px', textAlign: 'center', fontSize: 9, color: 'rgba(255,255,255,0.3)' }}
            >
              {fmtCount(items.length - shown)} more — scroll to load
            </div>
          )}
        </div>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', flexShrink: 0,
        borderTop: '0.5px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.015)',
      }}>
        <span
          title={lib?.root || err || undefined}
          style={{
            fontSize: 9.5, color: broken ? '#ff8a80' : 'rgba(255,255,255,0.32)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
        >
          {busy ? 'scanning the Eagle library…'
            : err ? err
              : !lib ? 'loading…'
                : !lib.ok ? (lib.error || 'No Eagle library found')
                  : `${fmtCount(items.length)} ${items.length === 1 ? 'item' : 'items'} · Eagle`
                    + (lib.hidden ? ` · ${fmtCount(lib.hidden)} not shown` : '')}
        </span>
        <span style={{ flex: 1 }} />
        <span
          title={lib?.root || undefined}
          style={{
            fontSize: 9, color: 'rgba(255,255,255,0.26)', flexShrink: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >{folderName(lib?.root || '')}</span>
        <button
          title="Pick a different Eagle library (.library folder)"
          onClick={() => void pickLibrary()}
          style={{
            ...rowBtn, width: 'auto', height: 15, padding: '0 4px', flexShrink: 0,
            fontSize: 8.5, fontWeight: 600, border: '0.5px solid rgba(255,255,255,0.12)',
            borderRadius: 3, color: 'rgba(255,255,255,0.45)',
          }}
        >Library…</button>
      </div>
    </div>
  );
};
