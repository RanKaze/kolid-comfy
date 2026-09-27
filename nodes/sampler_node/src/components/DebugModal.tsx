import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { DebugTraceResponse, DebugTraceStep } from '../types';

/**
 * DebugModal —— 上一次 Run / Generate 的全过程快照。
 *
 * 数据来自后端 /api/debug_trace：每跑一次 detailer 就重新收集一份（只保留最近一次）。
 * 这里只负责呈现，不做任何过滤/截断之外的加工：
 *  - 顶部一行元信息（时间、来源、状态、图数）
 *  - 章节筛选（全部 / Prompt 链路 / 图像 / Block）
 *  - 每个 block 一张可折叠卡片，卡片里 prompt 用等宽字体折叠显示，过程图是缩略图网格
 *  - 点任意缩略图 → 大图预览（Esc / 点背景关闭）
 */

const KIND_META: Record<DebugTraceStep['kind'], { label: string; color: string; icon: string }> = {
  stage: { label: 'Stage', color: '#8e8e93', icon: 'stage' },
  prompt: { label: 'Prompt', color: '#0a84ff', icon: 'prompt' },
  image: { label: 'Image', color: '#30d158', icon: 'image' },
  mask: { label: 'Mask', color: '#ff9f0a', icon: 'mask' },
  block: { label: 'Block', color: '#bf5af2', icon: 'block' },
  error: { label: 'Error', color: '#ff453a', icon: 'error' },
};

// SF Symbol style stroke icons（与 EditPhase 的 TabIcon 同风格），
// 用 currentColor 跟随周围文字颜色。
export const DbgIcon: React.FC<{ name: string; size?: number }> = ({ name, size = 12 }) => {
  const sw = 1.8;
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: sw, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, style: { display: 'block', flexShrink: 0 } };
  switch (name) {
    case 'bug': return (
      <svg {...p}>
        <circle cx="12" cy="13.5" r="4.5" />
        <path d="M10.5 5.5h3M12 9V5.5M9.5 4l1.6 2.4M14.5 4l-1.6 2.4" />
        <path d="M7.8 11.5L4 9.8M7.3 14H3.5M8.2 16.5l-3.5 2.5" strokeWidth={1.5} />
        <path d="M16.2 11.5L20 9.8M16.7 14H20.5M15.8 16.5l3.5 2.5" strokeWidth={1.5} />
      </svg>
    );
    case 'reload': return (
      <svg {...p}>
        <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
        <path d="M20.5 3.5V8H16" />
      </svg>
    );
    case 'close': return (
      <svg {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>
    );
    case 'log': return (
      <svg {...p}>
        <circle cx="4.5" cy="6.5" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="4.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="4.5" cy="17.5" r="1.1" fill="currentColor" stroke="none" />
        <path d="M8.5 6.5h11M8.5 12h8M8.5 17.5h9.5" strokeWidth={1.6} />
      </svg>
    );
    case 'chevronRight': return (
      <svg {...p}><path d="M9 5l7 7-7 7" /></svg>
    );
    case 'chevronDown': return (
      <svg {...p}><path d="M5 9l7 7 7-7" /></svg>
    );
    case 'stage': return (
      <svg {...p}><path d="M5 21V4M5 4.5h13L15.5 9 18 13.5H5" /></svg>
    );
    case 'prompt': return (
      <svg {...p}><path d="M4 6.5h16M4 11.5h12M4 16.5h9" strokeWidth={1.6} /></svg>
    );
    case 'image': return (
      <svg {...p}>
        <rect x="3" y="5" width="18" height="14" rx="2.5" />
        <circle cx="8.5" cy="10" r="1.3" fill="currentColor" stroke="none" />
        <path d="M3.5 17l5-4.5 4 3.5 4-4 4 4" strokeWidth={1.5} />
      </svg>
    );
    case 'mask': return (
      <svg {...p}>
        <rect x="4" y="4" width="16" height="16" rx="3.5" />
        <path d="M12 4H7.5A3.5 3.5 0 0 0 4 7.5v9A3.5 3.5 0 0 0 7.5 20H12z" fill="currentColor" stroke="none" opacity="0.45" />
      </svg>
    );
    case 'block': return (
      <svg {...p}>
        <rect x="4" y="4" width="16" height="6.5" rx="2" />
        <rect x="4" y="13.5" width="16" height="6.5" rx="2" />
      </svg>
    );
    case 'error': return (
      <svg {...p}>
        <path d="M12 3.8L21.3 20H2.7z" />
        <path d="M12 9.5v4.2M12 17v.01" />
      </svg>
    );
    default: return <svg {...p}><circle cx="12" cy="12" r="9" /></svg>;
  }
};

type Filter = 'all' | 'prompt' | 'image' | 'block';

const DebugModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [trace, setTrace] = useState<DebugTraceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [zoom, setZoom] = useState<{ src: string; label: string; w: number; h: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/debug_trace', { cache: 'no-store' });
      const data: DebugTraceResponse = await res.json();
      setTrace(data);
    } catch {
      setTrace(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Esc 关闭大图，再按一次关闭整个弹窗
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (zoom) setZoom(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [zoom, onClose]);

  const steps = trace?.steps || [];

  const shown = useMemo(() => {
    if (filter === 'all') return steps;
    if (filter === 'prompt') return steps.filter(s => s.kind === 'prompt' || s.kind === 'block' || s.kind === 'stage');
    if (filter === 'image') return steps.filter(s => s.kind === 'image' || s.kind === 'mask');
    return steps.filter(s => s.kind === 'block');
  }, [steps, filter]);

  // 按 block 分组：block 分节标题开启一个新组，直到下一个分节标题。
  const groups = useMemo(() => {
    const out: { header: DebugTraceStep | null; items: DebugTraceStep[] }[] = [];
    let cur: { header: DebugTraceStep | null; items: DebugTraceStep[] } = { header: null, items: [] };
    for (const s of shown) {
      if (s.kind === 'block') {
        if (cur.header || cur.items.length) out.push(cur);
        cur = { header: s, items: [] };
      } else {
        cur.items.push(s);
      }
    }
    if (cur.header || cur.items.length) out.push(cur);
    return out;
  }, [shown]);

  const imageTotal = steps.filter(s => s.kind === 'image' || s.kind === 'mask').length;

  const fmtTime = (iso?: string | null) => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString();
    } catch { return iso; }
  };

  const statusColor = (st?: string) =>
    st === 'done' ? '#30d158' : st === 'error' ? '#ff453a' : st === 'running' ? '#0a84ff' : 'rgba(255,255,255,0.45)';

  return (
    <div style={S.overlay} onClick={onClose}>
      {/* Inline style props cannot reach ::-webkit-scrollbar, and this modal is dark on a page whose
          default scrollbars are light. The rules live here and are scoped by class, matching the
          workbench's own overlay scrollbar (faint pill, transparent track, no buttons). */}
      <style>{`
        .dbg-scroll { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.22) transparent; }
        .dbg-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
        .dbg-scroll::-webkit-scrollbar-track { background: transparent; }
        .dbg-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.22); border: 3px solid transparent; border-radius: 8px; background-clip: padding-box; }
        .dbg-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.36); background-clip: padding-box; }
        .dbg-scroll::-webkit-scrollbar-corner { background: transparent; }
        .dbg-scroll::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
      `}</style>
      <div style={S.shell} onClick={e => e.stopPropagation()}>
        {/* ── 头部 ── */}
        <div style={S.head}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{ color: 'rgba(255,255,255,0.8)', display: 'flex' }}><DbgIcon name="bug" size={17} /></span>
            <div style={{ minWidth: 0 }}>
              <div style={S.headTitle}>Run Debug</div>
              <div style={S.headSub}>
                上一次 Run / Generate 的全过程快照
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <button style={S.iconBtn} title="重新读取快照" onClick={() => void load()}><DbgIcon name="reload" size={13} /></button>
            <button style={S.iconBtn} title="关闭 (Esc)" onClick={onClose}><DbgIcon name="close" size={12} /></button>
          </div>
        </div>

        {/* ── 元信息条 ── */}
        <div style={S.metaBar}>
          {trace?.available ? (
            <>
              <span style={S.metaChip}>
                <b style={{ color: statusColor(trace.meta?.status) }}>{trace.meta?.status || 'unknown'}</b>
              </span>
              <span style={S.metaChip}>来源 <b>{trace.meta?.from_blend ? 'Blend 工作台' : 'Run Detailer'}</b></span>
              <span style={S.metaChip}>时间 <b>{fmtTime(trace.generated_at || trace.meta?.generated_at)}</b></span>
              <span style={S.metaChip}>记录 <b>{steps.length}</b></span>
              <span style={S.metaChip}>过程图 <b>{imageTotal}</b></span>
              {trace.truncated && <span style={{ ...S.metaChip, color: '#ff9f0a' }}>过程图已达上限</span>}
              {trace.meta?.error && (
                <span style={{ ...S.metaChip, color: '#ff453a', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={trace.meta.error}>
                  错误：{trace.meta.error}
                </span>
              )}
            </>
          ) : (
            <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>
              还没有可用的快照 —— 先跑一次 Run / Generate。
            </span>
          )}
          <div style={{ flex: 1 }} />
          <div style={S.filters}>
            {([['all', '全部'], ['prompt', 'Prompt 链路'], ['image', '过程图'], ['block', '只看 Block']] as [Filter, string][]).map(([k, label]) => (
              <button key={k} style={{ ...S.filterBtn, ...(filter === k ? S.filterBtnOn : {}) }}
                onClick={() => setFilter(k)}>{label}</button>
            ))}
          </div>
        </div>

        {/* ── 主体 ── */}
        <div className="dbg-scroll" style={S.body}>
          {loading && <div style={S.empty}>读取中…</div>}
          {!loading && !trace?.available && (
            <div style={S.empty}>
              还没有快照。<br />
              <span style={{ fontSize: 12, opacity: 0.6 }}>
                触发一次 Run Detailer（或 Blend 工作台里的 Generate / ▶ preset），然后再打开这里。
              </span>
            </div>
          )}
          {!loading && trace?.available && groups.length === 0 && (
            <div style={S.empty}>当前筛选下没有内容。</div>
          )}

          {!loading && groups.map((g, gi) => {
            const isCollapsed = collapsed.has(gi);
            const k = g.header || { kind: 'stage' as const, label: '（链外步骤）', data: {} };
            const meta = KIND_META[k.kind] || KIND_META.stage;
            return (
              <div key={gi} style={S.group}>
                <button
                  style={{ ...S.groupHead, borderLeftColor: meta.color }}
                  onClick={() => setCollapsed(prev => {
                    const next = new Set(prev);
                    if (next.has(gi)) next.delete(gi); else next.add(gi);
                    return next;
                  })}
                >
                  <span style={{ color: meta.color, display: 'flex' }}><DbgIcon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={11} /></span>
                  <span style={{ color: meta.color, fontWeight: 700, fontSize: 12.5 }}>{k.label}</span>
                  {k.detail ? <span style={S.groupDetail}>{k.detail}</span> : null}
                  <div style={{ flex: 1 }} />
                  <span style={S.groupCount}>{g.items.length}</span>
                </button>
                {!isCollapsed && (
                  <div style={S.groupBody}>
                    {k.data && Object.keys(k.data).length > 0 && (
                      <div style={S.kvRow}>
                        {Object.entries(k.data).map(([key, val]) => (
                          <span key={key} style={S.kv}>
                            <span style={S.kvKey}>{key}</span>
                            <span style={S.kvVal}>{renderValue(val)}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    {g.items.map((s, si) => <StepView key={si} step={s} onZoom={setZoom} />)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── 大图预览 ── */}
      {zoom && (
        <div style={S.zoomOverlay} onClick={e => { e.stopPropagation(); setZoom(null); }}>
          <div style={S.zoomBar}>
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{zoom.label}</span>
            <span style={{ fontSize: 11, opacity: 0.6 }}>{zoom.w}×{zoom.h}</span>
            <button style={S.iconBtn} onClick={e => { e.stopPropagation(); setZoom(null); }}><DbgIcon name="close" size={12} /></button>
          </div>
          <img src={zoom.src} alt={zoom.label} style={S.zoomImg} onClick={e => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
};

// ── 单条记录 ──
const StepView: React.FC<{
  step: DebugTraceStep;
  onZoom: (z: { src: string; label: string; w: number; h: number }) => void;
}> = ({ step, onZoom }) => {
  const meta = KIND_META[step.kind] || KIND_META.stage;
  const [open, setOpen] = useState(false);
  const text: string = step.data?.text ?? '';
  const long = text.length > 400;

  return (
    <div style={{ ...S.step, borderLeftColor: meta.color + '66' }}>
      <div style={S.stepHead}>
        <span style={{ color: meta.color, display: 'flex', flexShrink: 0 }}><DbgIcon name={meta.icon} size={12} /></span>
        <span style={S.stepLabel}>{step.label}</span>
        {step.detail ? <span style={S.stepDetail}>{step.detail}</span> : null}
        {typeof step.data?.chars === 'number' && (
          <span style={S.badge}>{step.data.chars} 字符</span>
        )}
        {step.data?.applied === true && <span style={{ ...S.badge, color: '#30d158' }}>已应用</span>}
        {step.data?.applied === false && <span style={{ ...S.badge, color: '#ff9f0a' }}>未生效</span>}
      </div>

      {/* prompt 文本 */}
      {step.kind === 'prompt' && (
        <div>
          <pre className="dbg-scroll" style={{ ...S.pre, maxHeight: open || !long ? 320 : 92 }}>{text || '（空）'}</pre>
          {long && (
            <button style={S.moreBtn} onClick={() => setOpen(o => !o)}>
              {open ? '收起' : `展开全部（${text.length} 字符）`}
            </button>
          )}
          {renderPromptExtras(step.data)}
        </div>
      )}

      {/* 其它 kind 的 data（去掉已单独渲染的 text/chars） */}
      {step.kind !== 'prompt' && step.data && Object.keys(step.data).length > 0 && (
        <div style={S.kvRow}>
          {Object.entries(step.data)
            .filter(([k]) => !['text', 'chars'].includes(k))
            .map(([k, v]) => (
              <span key={k} style={S.kv}>
                <span style={S.kvKey}>{k}</span>
                <span style={S.kvVal}>{renderValue(v)}</span>
              </span>
            ))}
        </div>
      )}

      {/* 缩略图网格 */}
      {!!step.items?.length && (
        <div style={S.grid}>
          {step.items.map((it, i) => (
            <button key={i} style={S.thumb}
              title={`${it.label}${it.note ? ' — ' + it.note : ''} (${it.width}×${it.height})`}
              onClick={() => onZoom({ src: it.dataUrl, label: it.label, w: it.width, h: it.height })}>
              <img src={it.dataUrl} alt={it.label} style={S.thumbImg} />
              <span style={S.thumbCap}>{it.label}</span>
              <span style={S.thumbSize}>{it.width}×{it.height}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// prompt entry 里的附属字段（loras / negative / extra_prompt / instruction …）
const renderPromptExtras = (data?: Record<string, any>) => {
  if (!data) return null;
  const rows: [string, any][] = [];
  const skip = new Set(['text', 'chars']);
  for (const [k, v] of Object.entries(data)) {
    if (skip.has(k)) continue;
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    rows.push([k, v]);
  }
  if (!rows.length) return null;
  return (
    <div style={S.kvRow}>
      {rows.map(([k, v]) => (
        <span key={k} style={S.kv}>
          <span style={S.kvKey}>{k}</span>
          <span style={S.kvVal}>{renderValue(v)}</span>
        </span>
      ))}
    </div>
  );
};

const renderValue = (v: any): string => {
  if (v === null) return 'null';
  if (v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + '…' : v;
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (v.every(x => typeof x !== 'object')) {
      const s = v.join(', ');
      return s.length > 240 ? s.slice(0, 240) + '…' : s;
    }
    return JSON.stringify(v, null, 0).slice(0, 300) + (JSON.stringify(v).length > 300 ? '…' : '');
  }
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 300 ? s.slice(0, 300) + '…' : s;
  }
  return String(v);
};

const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 9000,
    background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28,
  },
  shell: {
    width: 'min(1180px, 96vw)', height: 'min(88vh, 1000px)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    background: '#141416', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 14,
    boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
    // Also tells the UA that anything it paints for us (form controls, scrollbars it owns) is dark.
    colorScheme: 'dark',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif",
  },
  head: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    padding: '12px 16px', borderBottom: '0.5px solid rgba(255,255,255,0.09)', flexShrink: 0,
  },
  headTitle: { fontSize: 14, fontWeight: 700, color: '#fff' },
  headSub: { fontSize: 11, color: 'rgba(255,255,255,0.42)', marginTop: 1 },
  iconBtn: {
    width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(255,255,255,0.07)', border: '0.5px solid rgba(255,255,255,0.12)',
    borderRadius: 8, color: 'rgba(255,255,255,0.75)', cursor: 'pointer', fontSize: 12.5,
  },
  metaBar: {
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    padding: '9px 16px', borderBottom: '0.5px solid rgba(255,255,255,0.07)',
    background: 'rgba(255,255,255,0.02)', flexShrink: 0,
  },
  metaChip: {
    fontSize: 11, color: 'rgba(255,255,255,0.55)', background: 'rgba(255,255,255,0.05)',
    border: '0.5px solid rgba(255,255,255,0.08)', borderRadius: 999, padding: '2px 9px',
    whiteSpace: 'nowrap',
  },
  filters: { display: 'flex', gap: 4 },
  filterBtn: {
    fontSize: 11, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
    background: 'transparent', border: '0.5px solid rgba(255,255,255,0.14)',
    color: 'rgba(255,255,255,0.55)',
  },
  filterBtnOn: {
    background: 'rgba(10,132,255,0.2)', borderColor: 'rgba(10,132,255,0.55)', color: '#fff', fontWeight: 600,
  },
  body: { flex: 1, overflowY: 'auto', padding: '12px 16px 20px' },
  empty: { padding: '48px 20px', textAlign: 'center', color: 'rgba(255,255,255,0.4)', fontSize: 13, lineHeight: 1.7 },
  group: { marginBottom: 14, border: '0.5px solid rgba(255,255,255,0.09)', borderRadius: 10, overflow: 'hidden' },
  groupHead: {
    width: '100%', display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
    padding: '9px 12px', cursor: 'pointer', background: 'rgba(255,255,255,0.045)',
    border: 'none', borderLeft: '3px solid', color: '#fff',
  },
  groupDetail: { fontSize: 11, color: 'rgba(255,255,255,0.42)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 520 },
  groupCount: { fontSize: 10.5, color: 'rgba(255,255,255,0.4)', background: 'rgba(255,255,255,0.07)', borderRadius: 999, padding: '1px 7px' },
  groupBody: { padding: '10px 12px 12px', display: 'flex', flexDirection: 'column', gap: 9 },
  step: {
    borderLeft: '2px solid', paddingLeft: 10, display: 'flex', flexDirection: 'column', gap: 6,
  },
  stepHead: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
  stepLabel: { fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.86)' },
  stepDetail: { fontSize: 11, color: 'rgba(255,255,255,0.4)' },
  badge: {
    fontSize: 10, color: 'rgba(255,255,255,0.5)', background: 'rgba(255,255,255,0.07)',
    borderRadius: 999, padding: '1px 7px', fontVariantNumeric: 'tabular-nums',
  },
  pre: {
    margin: 0, padding: '8px 10px', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    background: 'rgba(0,0,0,0.35)', border: '0.5px solid rgba(255,255,255,0.08)', borderRadius: 8,
    color: 'rgba(255,255,255,0.82)', fontSize: 11.5, lineHeight: 1.55,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    transition: 'max-height 0.15s ease',
  },
  moreBtn: {
    marginTop: 4, fontSize: 10.5, padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
    background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.12)',
    color: 'rgba(255,255,255,0.6)',
  },
  kvRow: { display: 'flex', flexWrap: 'wrap', gap: '4px 10px' },
  kv: { display: 'flex', alignItems: 'baseline', gap: 5, fontSize: 10.5, maxWidth: '100%' },
  kvKey: { color: 'rgba(255,255,255,0.38)', flexShrink: 0 },
  kvVal: {
    color: 'rgba(255,255,255,0.72)', wordBreak: 'break-word',
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
  grid: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  thumb: {
    width: 132, padding: 0, cursor: 'zoom-in', textAlign: 'left',
    background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.12)',
    borderRadius: 8, overflow: 'hidden', position: 'relative',
  },
  thumbImg: { width: '100%', height: 92, objectFit: 'contain', display: 'block', background: '#0a0a0a' },
  thumbCap: { display: 'block', padding: '4px 6px 0', fontSize: 10, color: 'rgba(255,255,255,0.62)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  thumbSize: { display: 'block', padding: '0 6px 5px', fontSize: 9.5, color: 'rgba(255,255,255,0.32)', fontVariantNumeric: 'tabular-nums' },
  zoomOverlay: {
    position: 'fixed', inset: 0, zIndex: 9100, background: 'rgba(0,0,0,0.9)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24,
  },
  zoomBar: { display: 'flex', alignItems: 'center', gap: 10, color: '#fff' },
  zoomImg: { maxWidth: '94vw', maxHeight: '84vh', objectFit: 'contain', borderRadius: 8, background: '#0a0a0a' },
};

export default DebugModal;
