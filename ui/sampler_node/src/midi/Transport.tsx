// ── Transport：横贯 MIDI 界面顶部的那一条 ────────────────────────────────────────────────────
//
// 这一格是"公共时间基准"唯一露脸的地方，也是整套编曲的把手：
//   ⏮ ■ ▶/❙❙ │ 绝对时间 与 小节.拍.tick │ BPM 拍号 │ LOOP A→B │ 时钟健康度 + 输出端口
//
// 三个刻意的选择：
//   * 读数**不进 React** —— 每帧 60 次重渲染会把播放头自己拖卡。走 useClockText 直接写
//     textContent，DOM 只动那一处文字。
//   * BPM 与拍号是**工程的属性**，不是时钟的属性。改 BPM 变的是"一拍多长"，拍本身不动 ——
//     音符不用重排，播放头会当场按新速度走（时钟只认秒，秒由这里换算）。
//   * 端口与时钟的**细节**不铺成一张卡片，收进那颗 chip 的 title 与一次点击（重校）。走带条
//     在编曲时一直看得见，铺开诊断会把 BPM 和循环挤出去 —— 需要细看时 hover 一下就有。

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { clock, fmtBarBeat, fmtClock } from './clock';
import { NATIVE_PORT_ID } from './engine';
import { useClockStatus, useClockText } from './hooks';
import { midiOut } from './output';
import { MAX_TEMPO, MIN_TEMPO, beatToSeconds, clampInt, projectBeats, secondsToBeat } from './model';
import type { MidiCtl } from './types';

const C = {
  bar: {
    display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flexShrink: 0,
    padding: '7px 10px', background: '#1b1c20',
    borderBottom: '0.5px solid rgba(255,255,255,0.10)',
  } as React.CSSProperties,
  group: { display: 'flex', alignItems: 'center', gap: 4 } as React.CSSProperties,
  // 走带的三个键比别处高一点：这是手指最常落地的地方。
  key: (on = false): React.CSSProperties => ({
    minWidth: 28, height: 26, padding: '0 9px', borderRadius: 6, cursor: 'pointer',
    fontSize: 12, fontWeight: 700, lineHeight: '24px',
    background: on ? 'rgba(10,132,255,0.9)' : 'rgba(255,255,255,0.07)',
    border: '0.5px solid rgba(255,255,255,0.16)', color: on ? '#fff' : 'rgba(255,255,255,0.82)',
  }),
  readout: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontVariantNumeric: 'tabular-nums',
    fontSize: 14, fontWeight: 600, color: '#fff', letterSpacing: 0.3,
  } as React.CSSProperties,
  sub: { fontSize: 10.5, color: 'rgba(255,255,255,0.45)', fontVariantNumeric: 'tabular-nums' } as React.CSSProperties,
  num: {
    width: 52, height: 22, padding: '0 6px', borderRadius: 5, fontSize: 11, textAlign: 'center',
    background: 'rgba(255,255,255,0.07)', border: '0.5px solid rgba(255,255,255,0.16)',
    color: '#fff', fontVariantNumeric: 'tabular-nums', outline: 'none',
  } as React.CSSProperties,
  sep: { width: 1, height: 20, background: 'rgba(255,255,255,0.12)', margin: '0 4px' } as React.CSSProperties,
  chip: (ok: boolean): React.CSSProperties => ({
    fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 999, cursor: 'pointer',
    background: ok ? 'rgba(48,209,88,0.16)' : 'rgba(255,159,10,0.16)',
    border: `0.5px solid ${ok ? 'rgba(48,209,88,0.45)' : 'rgba(255,159,10,0.45)'}`,
    color: ok ? '#30d158' : '#ff9f0a', whiteSpace: 'nowrap',
  }),
};

export const MidiTransport: React.FC<{ ctl: MidiCtl }> = ({ ctl }) => {
  const { project, update } = ctl;
  const status = useClockStatus();
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const barRef = useRef<HTMLSpanElement | null>(null);
  const driftRef = useRef<HTMLSpanElement | null>(null);
  const [bpmText, setBpmText] = useState(String(project.tempo));

  // 工程换了（切文档 / 撤销）：输入框跟着走，但用户正在打字时不抢。
  useEffect(() => { setBpmText(String(project.tempo)); }, [project.tempo]);

  useClockText(timeRef, fmtClock);
  useClockText(barRef, s => fmtBarBeat(s, project.tempo, project.timeSig));

  // 漂移是诊断量，每帧写一次文字就够，不必让 React 参与。
  useEffect(() => clock.subscribe(() => {
    if (!driftRef.current) return;
    const st = clock.status();
    driftRef.current.textContent = st.ready ? `${st.driftMs >= 0 ? '+' : ''}${st.driftMs.toFixed(1)}ms` : '—';
  }), []);

  const ports = useSyncExternalStore(
    cb => midiOut.subscribe(cb),
    () => midiOut.getPorts(),
  );
  const selected = midiOut.getSelected();

  const end = projectBeats(project);
  const totalSec = beatToSeconds(end, project.tempo);

  const setTempo = (v: number) => {
    update(p => ({ ...p, tempo: clampInt(v, MIN_TEMPO, MAX_TEMPO) }), 'Tempo');
  };

  // 那颗 chip 的 title：整条时间基准的诊断都在这里（谁说的、偏多少、一个来回多久、多少赫兹）。
  const clockTitle = status.source === 'native'
    ? [
      `时间基准：${status.backend || 'native'}（后端原生传输，所有窗都从这里取时间）`,
      `drift ${status.driftMs.toFixed(1)} ms · 往返 ${status.rttMs.toFixed(1)} ms`,
      `采样率 ${status.sampleRate} Hz · 对上了 ${status.ready ? '是' : '否'}`,
      '点一下立刻重校。',
    ].join('\n')
    : [
      '这只钟现在是**本地的** —— 后端没接上（这一版 ComfyUI 重启后才有 /api/clock），',
      '别指望它和外部音源严格对齐。点一下重试。',
      `采样率 ${status.sampleRate} Hz`,
    ].join('\n');

  return (
    <div style={C.bar}>
      <div style={C.group}>
        <button style={C.key()} title="回到开头 (Home)"
          onClick={() => ctl.seekBeat(0)}>⏮</button>
        <button style={C.key()} title="Stop — 回到循环起点（没开循环就回 0）"
          onClick={() => { ctl.pause(); ctl.seekBeat(project.loop.on ? project.loop.a : 0); }}>■</button>
        <button style={C.key(status.playing)} title="Play / Pause (Space)"
          onClick={() => (ctl.playing ? ctl.pause() : ctl.play())}>
          {ctl.playing ? '❙❙' : '▶'}
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 150 }}>
        <span ref={timeRef} style={C.readout}>0:00.000</span>
        <span style={C.sub}>of {fmtClock(totalSec)}</span>
      </div>
      <span ref={barRef} style={{ ...C.readout, fontSize: 12, color: 'rgba(255,255,255,0.72)' }}>1.1.000</span>

      <div style={C.sep} />

      <div style={C.group} title="Tempo — 每分钟四分音符数。改它只改「一拍多长」，音符原地不动。">
        <input
          style={C.num}
          value={bpmText}
          onChange={e => {
            setBpmText(e.target.value);
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v >= MIN_TEMPO && v <= MAX_TEMPO) setTempo(v);
          }}
          onBlur={() => setBpmText(String(project.tempo))}
          title="BPM"
        />
        <span style={C.sub}>BPM</span>
      </div>

      <div style={C.group} title="拍号">
        {[2, 3, 4, 6, 7].map(n => (
          <button key={n} style={{ ...C.key(project.timeSig[0] === n), minWidth: 20, height: 22, padding: '0 5px', fontSize: 10.5, lineHeight: '20px' }}
            onClick={() => update(p => ({ ...p, timeSig: [n, p.timeSig[1]] }), 'Time signature')}>{n}</button>
        ))}
        <span style={C.sub}>/</span>
        {[4, 8].map(d => (
          <button key={d} style={{ ...C.key(project.timeSig[1] === d), minWidth: 20, height: 22, padding: '0 5px', fontSize: 10.5, lineHeight: '20px' }}
            onClick={() => update(p => ({ ...p, timeSig: [p.timeSig[0], d] }), 'Time signature')}>{d}</button>
        ))}
      </div>

      <div style={C.sep} />

      <div style={C.group}>
        <button style={{ ...C.key(project.loop.on), height: 22, lineHeight: '20px', fontSize: 10.5 }}
          title="循环：播到 B 就跳回 A"
          onClick={() => update(p => ({ ...p, loop: { ...p.loop, on: !p.loop.on } }), 'Loop')}>LOOP</button>
        <input style={{ ...C.num, width: 42 }} value={project.loop.a}
          title="循环 A（拍）"
          onChange={e => update(p => ({ ...p, loop: { ...p.loop, a: Math.max(0, Number(e.target.value) || 0) } }), 'Loop A')} />
        <span style={C.sub}>→</span>
        <input style={{ ...C.num, width: 42 }} value={project.loop.b}
          title="循环 B（拍）"
          onChange={e => update(p => ({ ...p, loop: { ...p.loop, b: Math.max(1, Number(e.target.value) || 0) } }), 'Loop B')} />
      </div>

      {/* 公共时钟 + 输出端口：**一整簇**，用 marginLeft:auto 靠右。窗窄了它会整块换到第二行，
          仍然靠右 —— 中间那根 `flex:1` 撑杆换行之后会把这一簇甩到左边，看着像失手掉下来的。 */}
      <div style={{ ...C.group, marginLeft: 'auto' }}>
        {/* 时钟的健康度：谁是权威、偏了多少。点一下立刻重校一次。 */}
        <button style={C.chip(status.source === 'native')} title={clockTitle} onClick={() => clock.resync()}>
          {status.source === 'native' ? `CLOCK ${status.backend === 'dll' ? 'DLL' : 'QPC'}` : 'CLOCK LOCAL'}
        </button>
        <span ref={driftRef} style={{ ...C.sub, minWidth: 46 }}>—</span>

        <select
          value={selected}
          onChange={e => {
            const id = e.target.value;
            // 选自己的引擎不该弹 Web MIDI 权限框 —— 那条路根本用不到浏览器 MIDI。
            if (id === NATIVE_PORT_ID) { midiOut.select(id); return; }
            void midiOut.connect().then(() => midiOut.select(id));
          }}
          style={{ ...C.num, width: 154, height: 24, textAlign: 'left' }}
          title={ports.length
            ? '发声的那一头：本机引擎（Kolid Native Engine）或外部 MIDI 端口'
            : '还没有可用的出口 —— 没有本机引擎就先编译 KolidAudio.dll；要外部音源点 Connect'}
        >
          {ports.length === 0 && <option value="">{midiOut.getError() || 'No MIDI out'}</option>}
          {ports.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {!ports.some(p => p.id !== NATIVE_PORT_ID) && (
          <button style={{ ...C.key(), height: 24, lineHeight: '22px', fontSize: 10.5 }}
            title="申请 Web MIDI 访问权，把外部硬件 / VST 宿主列进来"
            onClick={() => { void midiOut.connect(); }}>Connect</button>
        )}
        <button style={{ ...C.key(), height: 24, lineHeight: '22px', fontSize: 10.5 }}
          title="重扫端口（插拔设备后用；不重新申请访问权）"
          onClick={() => midiOut.rescan()}>⟳</button>
        <button style={{ ...C.key(), height: 24, lineHeight: '22px', fontSize: 10.5 }}
          title="All Notes Off — 卡住的音一口气全放掉"
          onClick={() => midiOut.allNotesOff()}>⏻</button>
      </div>
    </div>
  );
};

/** 把播放头拖到某一拍（标尺、卷帘、任何地方都用这一句，别各写一遍换算）。 */
export const seekToBeat = (ctl: MidiCtl, beat: number): void => {
  ctl.seekBeat(Math.max(0, beat));
};

/** 传输条与卷帘共用的"现在第几拍"。 */
export const currentBeat = (tempo: number): number => secondsToBeat(clock.seconds(), tempo);
