import React from 'react';
import type { ActionLogEntry } from '../types';

/**
 * LogPanel —— 最近 32 条行为记录,dock 窗正文。
 *
 * 它替代的是工作台画布顶部那颗常显的状态药丸:动作反馈不再占住画布,而是攒成日志按需展开。
 * 条目来自两处 —— 工作台每次 setStatus 都发一条 'blend-log' 给宿主,宿主自己的动作(跑 preset /
 * Execute / 取消 / 载入 / Query)也写进同一个列表。这里只负责呈现,不做过滤。
 *
 * 曾经是一颗 Context 条上的按钮开的整屏 Modal;现在它是一扇正式的 dock 窗,正文填满自己的格子。
 */
export const LogPanel: React.FC<{ entries: ActionLogEntry[] }> = ({ entries }) => {
  const now = Date.now();
  const rows = [...entries].reverse();

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, colorScheme: 'dark' }}>
      <style>{`
        .log-scroll { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.22) transparent; }
        .log-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
        .log-scroll::-webkit-scrollbar-track { background: transparent; }
        .log-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.22); border: 3px solid transparent; border-radius: 8px; background-clip: padding-box; }
        .log-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.36); background-clip: padding-box; }
        .log-scroll::-webkit-scrollbar-corner { background: transparent; }
        .log-scroll::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0, padding: '4px 10px 2px' }}>
        <span style={{
          fontSize: 10.5, fontWeight: 700, color: 'rgba(255,255,255,0.6)',
          background: 'rgba(255,255,255,0.07)', border: '0.5px solid rgba(255,255,255,0.12)',
          borderRadius: 999, padding: '2px 8px',
        }}>{rows.length} / 32</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.32)' }}>工作台与本页的每一步反馈</span>
      </div>
      <div className="log-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 0' }}>
        {rows.length === 0 ? (
          <div style={{ padding: 20, fontSize: 13, color: 'rgba(255,255,255,0.3)' }}>还没有记录 —— 先做一次操作(跑一个 preset、拖一张图、点一下 Blend)。</div>
        ) : rows.map((e, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '4px 14px', fontSize: 12, lineHeight: 1.5 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, transform: 'translateY(-2px)', background: e.kind === 'error' ? '#ff453a' : e.kind === 'success' ? '#30d158' : 'rgba(255,255,255,0.28)' }} />
            <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 10.5, color: 'rgba(255,255,255,0.32)', flexShrink: 0 }}>{fmtTime(e.at)}</span>
            <span style={{ flex: 1, minWidth: 0, color: e.kind === 'error' ? '#ff6961' : e.kind === 'success' ? '#30d158' : 'rgba(255,255,255,0.82)' }}>
              {e.text}
            </span>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.28)', opacity: i === 0 ? 1 : 0.5 }}>{age(now - e.at)}</span>
          </div>
        ))}
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
