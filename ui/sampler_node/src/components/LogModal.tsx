import React, { useEffect } from 'react';
import type { ActionLogEntry } from '../types';
import { DbgIcon } from './DebugModal';

/**
 * LogModal —— 最近 32 条行为记录。
 *
 * 它替代的是工作台画布顶部那颗常显的状态药丸：动作反馈不再占住画布，而是攒成日志按需展开。
 * 条目来自两处 —— 工作台每次 setStatus 都发一条 'blend-log' 给宿主，宿主自己的动作（跑 preset /
 * Execute / 取消 / 载入 / Query）也写进同一个列表。这里只负责呈现，不做过滤。
 */
const LogModal: React.FC<{ entries: ActionLogEntry[]; onClose: () => void }> = ({ entries, onClose }) => {
  const now = Date.now();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = [...entries].reverse();

  return (
    <div style={S.overlay} onClick={onClose}>
      <style>{`
        .log-scroll { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.22) transparent; }
        .log-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
        .log-scroll::-webkit-scrollbar-track { background: transparent; }
        .log-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.22); border: 3px solid transparent; border-radius: 8px; background-clip: padding-box; }
        .log-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.36); background-clip: padding-box; }
        .log-scroll::-webkit-scrollbar-corner { background: transparent; }
        .log-scroll::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
      `}</style>
      <div style={S.shell} onClick={e => e.stopPropagation()}>
        <div style={S.head}>
          <span style={{ color: 'rgba(255,255,255,0.8)', display: 'flex' }}><DbgIcon name="log" size={17} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={S.headTitle}>Action Log</div>
            <div style={S.headSub}>画布上那段时间不再常显了 —— 这里是它攒下来的最近 32 条行为</div>
          </div>
          <span style={S.countChip}>{rows.length} / 32</span>
          <button style={S.iconBtn} title="关闭 (Esc)" onClick={onClose}><DbgIcon name="close" size={12} /></button>
        </div>
        <div className="log-scroll" style={S.body}>
          {rows.length === 0 ? (
            <div style={S.empty}>还没有记录 —— 先做一次操作（跑一个 preset、拖一张图、点一下 Blend）。</div>
          ) : rows.map((e, i) => (
            <div key={i} style={S.row}>
              <span style={{ ...S.dot, background: e.kind === 'error' ? '#ff453a' : e.kind === 'success' ? '#30d158' : 'rgba(255,255,255,0.28)' }} />
              <span style={S.time}>{fmtTime(e.at)}</span>
              <span style={{ ...S.text, color: e.kind === 'error' ? '#ff6961' : e.kind === 'success' ? '#30d158' : 'rgba(255,255,255,0.82)' }}>
                {e.text}
              </span>
              <span style={{ ...S.age, opacity: i === 0 ? 1 : 0.5 }}>{age(now - e.at)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const pad = (n: number) => String(n).padStart(2, '0');

function fmtTime(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 9000,
    background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    colorScheme: 'dark',
  },
  shell: {
    width: 'min(680px, 92vw)', maxHeight: '78vh', display: 'flex', flexDirection: 'column',
    background: 'rgba(28,28,30,0.96)', border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: 14,
    boxShadow: '0 24px 70px rgba(0,0,0,0.6)', overflow: 'hidden',
  },
  head: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', flexShrink: 0,
    borderBottom: '0.5px solid rgba(255,255,255,0.08)',
  },
  headTitle: { fontSize: 13.5, fontWeight: 700, color: '#fff' },
  headSub: { fontSize: 11, color: 'rgba(255,255,255,0.42)', marginTop: 1 },
  countChip: {
    fontSize: 10.5, fontWeight: 700, color: 'rgba(255,255,255,0.6)', flexShrink: 0,
    background: 'rgba(255,255,255,0.07)', border: '0.5px solid rgba(255,255,255,0.12)',
    borderRadius: 999, padding: '2px 8px',
  },
  iconBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    width: 24, height: 24, background: 'rgba(255,255,255,0.06)',
    border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 7,
    color: 'rgba(255,255,255,0.7)', cursor: 'pointer',
  },
  body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 0' },
  row: {
    display: 'flex', alignItems: 'baseline', gap: 8, padding: '4px 14px',
    fontSize: 12, lineHeight: 1.5,
  },
  dot: { width: 5, height: 5, borderRadius: '50%', flexShrink: 0, transform: 'translateY(-2px)' },
  time: { fontVariantNumeric: 'tabular-nums', fontSize: 10.5, color: 'rgba(255,255,255,0.32)', flexShrink: 0 },
  text: { flex: 1, minWidth: 0 },
  age: { fontSize: 10, color: 'rgba(255,255,255,0.28)', flexShrink: 0 },
  empty: { padding: 20, fontSize: 13, color: 'rgba(255,255,255,0.3)' },
};

export default LogModal;
