// ── 乐器轨道窗 ──────────────────────────────────────────────────────────────────────────────
//
// 一根轨 = 一个乐器 + 一个 MIDI 通道 + 一把力度基线。四样东西在这一行上都要能改，因为调音色、
// 分通道、压整体力度，是编曲里最常伸手的三件事，让它们各占一扇窗只会让手来回跑。
//
// "力度"在这里有两层，故意分开：
//   * 轨上的那根推子（velScale）= 这**一件乐器**整体的强弱，0.1×..2×，不改任何音符；
//   * 卷帘下那条泳道 = **每个音**自己的 1..127，音符自己带的东西。
// 发出去的是两者相乘。把它们合成一个数，用户就永远没法"整体压一点、但那个重音要保住"。
//
// 第十通道（MIDI 规定是鼓）在通道下拉里标出来 —— 不是禁止，是提醒。

import React, { useEffect, useRef, useState } from 'react';
import { clock } from './clock';
import { midiOut } from './output';
import { DRUM_CHANNEL, GM_PROGRAMS, addTrack, programName, removeTrack, updateTrack } from './model';
import type { MidiCtl } from './types';

const S = {
  wrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } as React.CSSProperties,
  head: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
    borderBottom: '0.5px solid rgba(255,255,255,0.08)', flexShrink: 0,
  } as React.CSSProperties,
  list: { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' } as React.CSSProperties,
  row: (on: boolean, color: string): React.CSSProperties => ({
    display: 'grid',
    // 音色名让出余量（`minmax(0,1fr)`），program 有条 120px 的上限但可以缩 —— 窄栏里先挤它，
    // 因为"这一轨叫什么"比"GM 第几号"更要紧；完整音色名在 title 里。
    gridTemplateColumns: '3px minmax(0,1fr) minmax(0,120px) 40px 22px 22px',
    gridTemplateRows: 'auto auto',
    alignItems: 'center', columnGap: 5, rowGap: 1,
    padding: '5px 8px 5px 0',
    background: on ? 'rgba(10,132,255,0.16)' : 'transparent',
    borderBottom: '0.5px solid rgba(255,255,255,0.05)',
    cursor: 'pointer', position: 'relative',
    boxShadow: on ? `inset 2px 0 0 ${color}` : 'none',
    /* 这一行要接 Delete 键（删轨），所以要能拿到焦点；拿到了就别画一圈系统蓝框 ——
       那圈会让人以为在编辑什么。 */
    outline: 'none',
  }),
  name: { fontSize: 11.5, fontWeight: 600, color: 'rgba(255,255,255,0.9)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as React.CSSProperties,
  sub: { fontSize: 9.5, color: 'rgba(255,255,255,0.4)' } as React.CSSProperties,
  sel: {
    fontSize: 9.5, padding: '1px 2px', borderRadius: 4, width: '100%', minWidth: 0,
    background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.12)',
    color: 'rgba(255,255,255,0.75)', outline: 'none',
  } as React.CSSProperties,
  tiny: (on: boolean, tint = '#0a84ff'): React.CSSProperties => ({
    width: 20, height: 18, borderRadius: 4, cursor: 'pointer', fontSize: 9, fontWeight: 700,
    lineHeight: '17px', padding: 0,
    background: on ? tint : 'rgba(255,255,255,0.06)',
    border: '0.5px solid rgba(255,255,255,0.14)', color: on ? '#fff' : 'rgba(255,255,255,0.6)',
  }),
  vel: {
    gridColumn: '2 / span 5', display: 'flex', alignItems: 'center', gap: 5, height: 14,
  } as React.CSSProperties,
  add: {
    margin: '6px 8px', padding: '4px 8px', borderRadius: 5, cursor: 'pointer',
    fontSize: 10.5, fontWeight: 600, background: 'rgba(255,255,255,0.07)',
    border: '0.5px solid rgba(255,255,255,0.16)', color: 'rgba(255,255,255,0.8)',
    flexShrink: 0,
  } as React.CSSProperties,
};

/** 轨力度推子。外观与卷帘那根 zoom 同一族（`.midi-slider`，CSS 在 Workspace 的 MIDI_CSS 里），
 *  手感上补两件这排最常做的事：**滚轮微调 5%**（"整体压一点点"是一根一根滚出来的）、
 *  **双击回 100%**。滚轮必须走原生监听才能 preventDefault（React 的 onWheel 是 passive 的）。 */
const VelScaleSlider: React.FC<{ value: number; onChange: (v: number) => void; title?: string }> = ({ value, onChange, title }) => {
  const ref = useRef<HTMLInputElement | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  const cur = useRef(value);
  cur.current = value;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const next = cur.current - Math.sign(ev.deltaY) * 0.05;
      cb.current(Math.round(Math.max(0.1, Math.min(2, next)) * 100) / 100);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  return (
    <input ref={ref} className="midi-slider" type="range" min={0.1} max={2} step={0.01} value={value}
      style={{
        flex: '1 1 auto', minWidth: 0,
        '--fill': Math.round(((value - 0.1) / 1.9) * 100) + '%',
      } as React.CSSProperties}
      onChange={e => onChange(Number(e.target.value))}
      onDoubleClick={() => onChange(1)}
      title={title} />
  );
};

export const MidiTracks: React.FC<{ ctl: MidiCtl }> = ({ ctl }) => {
  const { project, update } = ctl;
  const [renaming, setRenaming] = useState('');
  // 删到只剩一条时说一句 —— 否则按 Delete 什么也没发生，会以为键坏了。
  const [note, setNote] = useState('');

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <span style={{ fontSize: 10.5, fontWeight: 600, color: 'rgba(255,255,255,0.55)' }}>
          {project.tracks.length} instruments
        </span>
        <span style={{ flex: 1 }} />
      </div>
      {note && (
        <div style={{ padding: '2px 4px 4px', fontSize: 9.5, color: 'rgba(255,159,10,0.9)' }}>{note}</div>
      )}

      <div style={S.list}>
        {project.tracks.map(t => {
          const on = t.id === project.selTrack;
          return (
            <div key={t.id} style={S.row(on, t.color)}
              tabIndex={0}
              onClick={() => { ctl.select(t.id, ''); midiOut.programChange(t.channel, t.program); }}
              onDoubleClick={() => setRenaming(t.id)}
              onKeyDown={e => {
                // 删除改走 Delete 键：这一排不再挂 × 按钮（挤在 20px 一行里，误点一次就少一轨）。
                // 焦点在这一行上按 Delete = 删**这条轨**；焦点在卷帘上按 Delete = 删选中的音。
                // 最后一条轨删不掉（model 里就挡着），否则整窗变成一个没有乐器的空壳。
                if (e.key !== 'Delete' && e.key !== 'Backspace') return;
                if (renaming === t.id) return;
                e.preventDefault();
                e.stopPropagation();
                if (project.tracks.length <= 1) {
                  setNote('That is the last instrument — a project needs at least one.');
                  return;
                }
                update(p => removeTrack(p, t.id), 'Remove track');
                setNote('');
              }}
            >
              <div style={{ width: 3, height: 26, borderRadius: 2, background: t.color, opacity: on ? 1 : 0.55 }} />

              {renaming === t.id ? (
                <input autoFocus defaultValue={t.name} style={{ ...S.name, width: '100%', background: 'rgba(0,0,0,0.4)', border: '0.5px solid rgba(10,132,255,0.7)', borderRadius: 4, padding: '1px 4px' }}
                  onBlur={e => { update(p => updateTrack(p, t.id, { name: e.target.value.trim() || t.name }), 'Rename track'); setRenaming(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(''); }}
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <span style={S.name} title={`${t.name} — 双击改名`}>{t.name}</span>
              )}

              <select
                value={t.program}
                onChange={e => update(p => updateTrack(p, t.id, { program: Number(e.target.value) }), 'Program')}
                onClick={e => e.stopPropagation()}
                style={S.sel}
                title={`Program ${t.program} — ${programName(t.program)}（外部音源按 GM 认这个号）`}
              >
                {GM_PROGRAMS.map((n, i) => <option key={i} value={i}>{String(i).padStart(3, '0')} {n}</option>)}
              </select>

              <select
                value={t.channel}
                onChange={e => update(p => updateTrack(p, t.id, { channel: Number(e.target.value) }), 'Channel')}
                onClick={e => e.stopPropagation()}
                style={S.sel}
                title={t.channel === DRUM_CHANNEL ? 'Channel 10 — 鼓（MIDI 规定）' : 'MIDI 通道'}
              >
                {Array.from({ length: 16 }, (_, i) => (
                  <option key={i} value={i}>{i === DRUM_CHANNEL ? '10·dr' : i + 1}</option>
                ))}
              </select>

              <button style={S.tiny(t.mute, '#ff453a')} title="Mute"
                onClick={e => { e.stopPropagation(); update(p => updateTrack(p, t.id, { mute: !t.mute }), 'Mute'); }}>M</button>
              <button style={S.tiny(t.solo, '#ffd60a')} title="Solo"
                onClick={e => { e.stopPropagation(); update(p => updateTrack(p, t.id, { solo: !t.solo }), 'Solo'); }}>S</button>

              {/* 力度基线：整轨乘数。双击回到 100%。 */}
              <div style={S.vel} onClick={e => e.stopPropagation()}>
                <span style={{ ...S.sub, width: 30, textAlign: 'right' }} title="Track velocity (×)">vel</span>
                <VelScaleSlider value={t.velScale}
                  title={`这一轨整体力度 ×${t.velScale.toFixed(2)}（发出去的力度 = 音符自己的 × 这个；滚轮微调、双击回 100%）`}
                  onChange={v => update(p => updateTrack(p, t.id, { velScale: v }), 'Track velocity')} />
                <span style={{ ...S.sub, width: 30 }}>{Math.round(t.velScale * 100)}%</span>
              </div>
            </div>
          );
        })}
      </div>

      <button style={S.add} onClick={() => update(p => addTrack(p), 'Add track')}>+ Instrument</button>
    </div>
  );
};

/** 当前播放头在这条轨上按着哪几个音（卷帘与轨道行的高亮共用）。 */
export const soundingNotes = (ctl: MidiCtl): Set<number> => {
  const t = ctl.track;
  if (!t || !clock.isPlaying()) return new Set();
  const beat = clock.seconds() * (ctl.project.tempo / 60);
  const out = new Set<number>();
  for (const n of t.notes) if (beat >= n.start && beat < n.start + n.dur) out.add(n.pitch);
  return out;
};
