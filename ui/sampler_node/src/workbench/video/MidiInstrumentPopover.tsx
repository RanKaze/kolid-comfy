// ── Tracks 轨头的乐器弹窗 ──────────────────────────────────────────────────────────────────
//
// 乐器归**轨道**（不是归 MIDI 模式）：那条 MIDI 轨头上的乐器键就是唯一入口 —— 挑库里的
// 音色、开插件自己的窗口、换通道、压整轨力度，都在这扇小窗里做完。MIDI 模式因此不再另摆
// 一份"乐器列"：轨与段只有一份，入口也只留这一处。
//
// 写法沿用 Assets / Timeline 的 portal + fixed 定位（不受轨道区滚动裁剪），选中/撤销/落盘
// 全走宿主的 `midi.update`（= 视频工程那一个写口），这里不自己存状态。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { nativeEngine } from '../../midi/engine';
import { loadInstrumentOnTrack } from '../../midi/instrumentOps';
import { instrumentAbsPath, reloadInstruments, useInstrumentLibrary, type InstrumentItem } from '../../midi/library';
import { DRUM_CHANNEL, updateTrack as updateMidiTrack } from '../../midi/model';
import { editorState, openSoundWindow, subscribeEditor } from '../../midi/soundWindow';
import type { MidiCtl } from '../../midi/types';
import type { VidTrack } from './model';

const W = 336;

const instrumentLabel = (path: string, name?: string): string => {
  if (name) return name;
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return (parts[parts.length - 1] || path).replace(/\.(vstpreset|vst3|sfz)$/i, '');
};

const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

const backendLabel = (b: string): string =>
  b === 'sfz' ? 'SFZ sample' : b === 'vst3-preset' ? 'plug-in preset' : b === 'surge-fxp' ? 'Surge patch' : b;

/** 整轨力度推子：滚轮微调 5%、双击回 100%（与轨道窗那根同一个手感）。
 *  这里不挂 `.midi-slider` —— 那套 CSS 住在 MIDI 工作区，Tracks 这边没有。 */
const VelScaleSlider: React.FC<{ value: number; onChange: (v: number) => void }> = ({ value, onChange }) => {
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
    <input ref={ref} type="range" min={0.1} max={2} step={0.01} value={value}
      onChange={e => onChange(Number(e.target.value))}
      onDoubleClick={() => onChange(1)}
      title={`Track velocity ×${value.toFixed(2)} — every note on this track is scaled by it (each note keeps its own velocity). Wheel = ±5%, double-click = 100%.`}
      style={{ flex: '1 1 auto', minWidth: 0, accentColor: '#bf5af2', height: 14 }} />
  );
};

const head: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
  color: 'rgba(255,255,255,0.38)',
};

const btn = (on = false, tint = '#bf5af2'): React.CSSProperties => ({
  height: 20, padding: '0 8px', borderRadius: 5, cursor: 'pointer',
  fontSize: 10.5, fontWeight: 600, lineHeight: '19px',
  background: on ? tint : 'rgba(255,255,255,0.06)',
  border: '0.5px solid rgba(255,255,255,0.16)',
  color: on ? '#fff' : 'rgba(255,255,255,0.78)',
});

export const MidiInstrumentPopover: React.FC<{
  track: VidTrack;
  /** 锚点：乐器键的屏幕矩形（left / bottom + 4）。 */
  x: number;
  y: number;
  midi: MidiCtl;
  onClose: () => void;
}> = ({ track, x, y, midi, onClose }) => {
  const lib = useInstrumentLibrary();
  // 引擎那头这一轨的装载结果（装上了没有、卡在哪）。乐器很少变，订阅只在"每轨乐器"变了才响。
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  useEffect(() => nativeEngine.subscribe(bump), []);
  const row = (nativeEngine.getStatus().instruments || []).find(r => r.track === track.id);
  const instBad = !!row && !row.open;

  // 音色窗的会话：开窗状态与回话都在 soundWindow 那个模块里（切模式也不丢）。
  const [ed, setEd] = useState(editorState);
  useEffect(() => subscribeEditor(() => setEd(editorState())), []);

  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);

  // 打开就问一次库（reloadInstruments 自己有 inflight 合并，重复开窗不会连扫）。
  useEffect(() => { void reloadInstruments(); }, []);

  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = rootRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const current = norm(track.instrument || '');
  const playable = useMemo(() => (lib.lib?.items || []).filter(it => it.playable), [lib]);
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return playable;
    return playable.filter(it =>
      (it.name + ' ' + it.model + ' ' + it.source + ' ' + it.backend).toLowerCase().includes(needle));
  }, [playable, q]);
  const total = playable.length;

  // 只有真插件（VST3 / .vstpreset）有自己得开的窗口；SFZ 的"音色"就是那个文件本身。
  const editable = row?.kind === 'vst3' || /\.(vst3|vstpreset)$/i.test(track.instrument || '');

  const pick = async (it: InstrumentItem) => {
    if (busy) return;
    setBusy('load');
    setNote(null);
    const r = await loadInstrumentOnTrack(
      { project: midi.project, update: midi.update },
      { path: instrumentAbsPath(it, lib.lib?.root || ''), trackId: track.id, name: it.name },
    );
    setBusy('');
    if (!r.ok) { setNote({ text: r.error || 'Could not load this instrument.', tone: 'error' }); return; }
    setNote({
      text: `Loaded ${r.name || it.name}` + (r.zones ? ` — ${r.zones} zone${r.zones === 1 ? '' : 's'}` : '')
        + (r.editorRequested ? ', its own window is opening so you can pick a sound.' : '.'),
      tone: 'info',
    });
  };

  const unload = () => {
    if (busy) return;
    setBusy('unload');
    void nativeEngine.trackUnload(track.id);
    midi.update(p => updateMidiTrack(p, track.id, { instrument: '' }), 'Unload instrument');
    setBusy('');
  };

  // 竖屏放不下就往锚点上方翻；高度封在视口里，列表自己滚。
  const openUp = y + 420 > window.innerHeight - 8;
  const top = Math.max(8, openUp ? y - 28 - 420 : y);
  const left = Math.max(8, Math.min(x, window.innerWidth - W - 8));
  const maxHeight = Math.max(220, window.innerHeight - top - 8);

  return createPortal(
    <div
      ref={rootRef}
      data-vid-inst-pop={track.id}
      onPointerDown={e => e.stopPropagation()}
      onContextMenu={e => e.preventDefault()}
      style={{
        position: 'fixed', zIndex: 9999, left, top, width: W, maxHeight,
        display: 'flex', flexDirection: 'column', minHeight: 0,
        padding: 8, gap: 7, borderRadius: 9,
        background: 'rgba(34,34,38,0.985)', border: '0.5px solid rgba(255,255,255,0.16)',
        boxShadow: '0 12px 36px rgba(0,0,0,0.6)', color: 'rgba(255,255,255,0.9)',
        fontSize: 11,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ ...head, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {track.name} · instrument
        </span>
        <button style={{ ...btn(), width: 20, padding: 0 }} title="Close" onClick={onClose}>×</button>
      </div>

      {/* 现在装着什么 —— 名字 + 全路径（悬停看路径/引擎回话）。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 11.5, fontWeight: 600,
            color: instBad ? '#ff8a80' : track.instrument ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.3)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
            title={track.instrument
              ? instrumentLabel(track.instrument, row?.name) + '\n' + track.instrument
                + (row?.error ? '\n' + row.error : row?.open ? '\nLoaded in this track\'s own plug-in instance' : '\nNot loaded into the engine yet')
              : 'No instrument — this track is silent. Pick one from the library below.'}
          >{track.instrument ? instrumentLabel(track.instrument, row?.name) : 'No instrument'}</div>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {track.instrument
              ? (row?.kind || (/\.sfz$/i.test(track.instrument) ? 'sfz' : 'preset')).toUpperCase()
                + ' · ' + track.instrument.split(/[\\/]/).pop()
              : 'silent until an instrument is loaded'}
          </div>
        </div>
        {editable && (
          <button style={{ ...btn(ed.open.includes(track.id)), opacity: ed.busy === track.id ? 0.5 : 1 }}
            title={'Edit — opens this instrument\'s own window (the plug-in\'s real UI). Pick a sound there, then close the window: it is saved into the instrument library and becomes this track\'s sound.'}
            onClick={() => { if (!ed.busy) void openSoundWindow(track.id); }}
          >{ed.open.includes(track.id) ? 'Edit · open' : 'Edit'}</button>
        )}
        {!!track.instrument && (
          <button style={{ ...btn(false, '#ff453a'), opacity: busy ? 0.5 : 1 }}
            title="Unload — this track stops sounding. The notes stay on its segments."
            onClick={unload}
          >Unload</button>
        )}
      </div>

      {ed.note && (
        <div style={{ fontSize: 9.5, lineHeight: 1.4, color: ed.note.tone === 'error' ? '#ff8a80' : 'rgba(255,255,255,0.6)' }}>
          {ed.note.text}
        </div>
      )}
      {note && (
        <div style={{ fontSize: 9.5, lineHeight: 1.4, color: note.tone === 'error' ? '#ff8a80' : 'rgba(255,255,255,0.6)' }}>
          {note.text}
        </div>
      )}

      {/* 通道 + 整轨力度：编曲里最常伸手的两件，和装音色同一扇窗。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={head}>Ch</span>
        <select
          value={track.channel ?? 0}
          onChange={e => midi.update(p => updateMidiTrack(p, track.id, { channel: Number(e.target.value) }), 'Channel')}
          title={track.channel === DRUM_CHANNEL
            ? 'Channel 10 — drums by MIDI convention. The notes are sent on this channel; the instrument decides what that means.'
            : 'MIDI channel this track sends its notes on.'}
          style={{
            width: 62, height: 20, borderRadius: 5, background: 'rgba(255,255,255,0.06)',
            border: '0.5px solid rgba(255,255,255,0.16)', color: 'rgba(255,255,255,0.8)',
            fontSize: 10, padding: '0 2px', outline: 'none',
          }}
        >
          {Array.from({ length: 16 }, (_, i) => (
            <option key={i} value={i} style={{ background: '#222226' }}>{i === DRUM_CHANNEL ? '10 · dr' : i + 1}</option>
          ))}
        </select>
        <span style={{ ...head, marginLeft: 4 }}>Vel</span>
        <VelScaleSlider value={track.velScale ?? 1}
          onChange={v => midi.update(p => updateMidiTrack(p, track.id, { velScale: v }), 'Track velocity')} />
        <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.4)', width: 32, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {Math.round((track.velScale ?? 1) * 100)}%
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => e.stopPropagation()}
          placeholder="Search the instrument library…"
          style={{
            flex: 1, minWidth: 0, height: 22, borderRadius: 5, padding: '0 7px',
            background: 'rgba(0,0,0,0.35)', border: '0.5px solid rgba(255,255,255,0.16)',
            color: 'rgba(255,255,255,0.88)', fontSize: 10.5, outline: 'none',
          }} />
        <button style={{ ...btn(), opacity: lib.loading ? 0.5 : 1 }}
          title="Rescan the instrument library (same folder as MIDI Settings)."
          onClick={() => { if (!lib.loading) void reloadInstruments(true); }}
        >Rescan</button>
      </div>

      <div style={{
        flex: 1, minHeight: 60, overflowY: 'auto', overflowX: 'hidden',
        borderRadius: 6, border: '0.5px solid rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.22)',
      }}>
        {items.map(it => {
          const path = instrumentAbsPath(it, lib.lib?.root || '');
          const isCur = !!current && norm(path) === current;
          return (
            <button
              key={it.id}
              disabled={!!busy}
              onClick={() => void pick(it)}
              title={path
                + '\n' + backendLabel(it.backend)
                + (it.model ? '\n' + it.model : '')
                + (it.verified ? '\nSound was verified when it was catalogued' : '')
                + '\nClick to load it into this track.'}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
                padding: '5px 7px', border: 'none', borderRadius: 0,
                borderBottom: '0.5px solid rgba(255,255,255,0.05)',
                background: isCur ? 'rgba(191,90,242,0.16)' : 'transparent',
                color: 'rgba(255,255,255,0.88)', cursor: busy ? 'default' : 'pointer',
                opacity: busy && busy !== 'load' ? 0.5 : 1,
              }}
              onMouseEnter={e => { if (!isCur) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
              onMouseLeave={e => { if (!isCur) e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ width: 3, height: 16, borderRadius: 1.5, background: '#bf5af2', opacity: isCur ? 1 : 0.45, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10.5, fontWeight: 600 }}>
                {it.name}
              </span>
              <span style={{ flexShrink: 0, maxWidth: 132, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 9, color: 'rgba(255,255,255,0.36)' }}>
                {it.model || it.source || backendLabel(it.backend)}
              </span>
              {isCur && <span style={{ flexShrink: 0, fontSize: 9, color: '#bf5af2' }}>current</span>}
            </button>
          );
        })}
        {!items.length && (
          <div style={{ padding: '10px 8px', fontSize: 9.5, lineHeight: 1.5, color: 'rgba(255,255,255,0.42)' }}>
            {lib.loading ? 'Scanning the instrument library…'
              : lib.error ? lib.error
                : !lib.lib ? 'Instrument list unavailable — the backend may not have been restarted since this was added.'
                  : !total ? (lib.lib.root ? 'No playable instruments in this folder. Point MIDI Settings at a folder with .sfz / .vstpreset files, then Rescan.' : 'No instrument folder is set — choose one in MIDI Settings, then Rescan.')
                    : 'Nothing matches this search.'}
          </div>
        )}
      </div>

      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.34)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {total ? `${items.length} of ${total} playable` : ''}
        {total && lib.lib?.truncated ? ' · list truncated' : ''}
      </div>
    </div>,
    document.body,
  );
};
