// ── Transport：横贯 MIDI 界面底部的那一条 ────────────────────────────────────────────────────
//
// 这一格是"公共时间基准"唯一露脸的地方，也是整套编曲的把手：
//   ⏮ ■ ▶/❙❙ │ 绝对时间 与 小节.拍.tick │ BPM 拍号 │ LOOP │ GRID │ ZOOM
//
// 三个刻意的选择：
//   * 读数**不进 React** —— 每帧 60 次重渲染会把播放头自己拖卡。走 useClockText 直接写
//     textContent，DOM 只动那一处文字。
//   * BPM 与拍号是**工程的属性**，不是时钟的属性。改 BPM 变的是"一拍多长"，拍本身不动 ——
//     音符不用重排，播放头会当场按新速度走（时钟只认秒，秒由这里换算）。
//   * 时钟与输出端口的**诊断不占位置**：本机引擎在页面挂载时自己接上（useMidiHost 的 probe），
//     用户不需要知道谁是权威、偏了几毫秒。编曲时这一条只留真正要调的东西 —— 网格与缩放。
//   * 循环的 A/B **不在这里改**：范围游标长在卷帘标尺上（与 Tracks 同一套楔形把手，拖了
//     就是改范围）。这里只留一枚 LOOP 开关 —— 一个动作一个入口。

import React, { useEffect, useRef, useState } from 'react';
import { clock, fmtBarBeat, fmtClock } from './clock';
import { useClockText } from './hooks';
import { MAX_TEMPO, MIN_TEMPO, beatToSeconds, clampInt, quantizeTrack, secondsToBeat } from './model';
import { DEFAULT_PPS, GRID_CHOICES, ZOOM_MAX, ZOOM_MIN } from './PianoRoll';
import { TransportKeys } from './TransportKeys';
import type { MidiCtl } from './types';

const C = {
  bar: {
    display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flexShrink: 0,
    padding: '7px 10px', background: '#1b1c20',
    borderTop: '0.5px solid rgba(255,255,255,0.10)',
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
};

export const MidiTransport: React.FC<{
  ctl: MidiCtl;
  /** 吸附刻度（拍）—— 状态在 Workspace，卷帘与这里共用。 */
  gridBeats: number;
  onGrid: (beats: number) => void;
  /** 每拍多少像素。 */
  pps: number;
  /** 缩放（会夹到 ZOOM_MIN..ZOOM_MAX，并保持视口中心那一拍不动）。 */
  onZoom: (pps: number) => void;
}> = ({ ctl, gridBeats, onGrid, pps, onZoom }) => {
  const { project, update } = ctl;
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const barRef = useRef<HTMLSpanElement | null>(null);
  const [bpmText, setBpmText] = useState(String(project.tempo));

  // 工程换了（切文档 / 撤销）：输入框跟着走，但用户正在打字时不抢。
  useEffect(() => { setBpmText(String(project.tempo)); }, [project.tempo]);

  useClockText(timeRef, fmtClock);
  useClockText(barRef, s => fmtBarBeat(s, project.tempo, project.timeSig));


  const setTempo = (v: number) => {
    update(p => ({ ...p, tempo: clampInt(v, MIN_TEMPO, MAX_TEMPO) }), 'Tempo');
  };

  const zoomRef = useRef<HTMLInputElement | null>(null);
  // 连续滚轮事件可能比一次重渲染来得密，所以步长读 ref；自己先把目标写进去，下一条才不会原地踏步。
  const ppsRef = useRef(pps);
  ppsRef.current = pps;
  const zoomFill = Math.round(((pps - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)) * 100) + '%';

  // 原生 range 对滚轮完全没反应，而缩放是这排控件里最常反复微调的一件事。
  // 必须走原生监听才能 preventDefault（React 的 onWheel 挂的是 passive 监听）。
  useEffect(() => {
    const el = zoomRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const step = Math.max(1, Math.round(ppsRef.current * 0.08));
      const v = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, ppsRef.current - Math.sign(ev.deltaY) * step));
      ppsRef.current = v;
      onZoom(v);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onZoom]);

  return (
    <div style={C.bar}>
      {/* 走带键与 Video 监视器下那条**同一个组件**（midi/TransportKeys）：回入点、播停、
          停止、循环四种语义只写一份。这里只把皮肤（C.key）交给它。 */}
      <div style={C.group}>
        <TransportKeys
          playing={ctl.playing}
          range={{ on: project.loop.on, inSec: beatToSeconds(project.loop.a, project.tempo) }}
          endSec={ctl.endSec}
          onToggleLoop={ctl.toggleLoop}
          keyStyle={C.key}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 150 }}>
        <span ref={timeRef} style={C.readout}>0:00.000</span>
        <span style={C.sub}>of {fmtClock(ctl.endSec)}</span>
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

      {/* 网格：画音符、拖动、改长度、量化都按这一档吸附。按钮与拍号那组同款（mini-btn），
          因为它们是同一层的"离散选项"，不该长得像走带键。 */}
      <div style={C.group} title="网格（拍）：画音符、拖动、拉伸与量化的吸附刻度">
        <span style={C.sub}>grid</span>
        {GRID_CHOICES.map(gc => {
          const on = Math.abs(gridBeats - gc.beats) < 1e-6;
          return (
            <button key={gc.label}
              style={{ ...C.key(on), minWidth: 22, height: 22, padding: '0 6px', fontSize: 10, lineHeight: '20px' }}
              onClick={() => onGrid(gc.beats)}>{gc.label}</button>
          );
        })}
        <button style={{ ...C.key(), height: 22, padding: '0 7px', fontSize: 10, lineHeight: '20px' }}
          title="把这一段里的音符起点吸附到这个网格"
          onClick={() => { if (ctl.editor) ctl.updateEditor(t => quantizeTrack(t, gridBeats), 'Quantize'); }}>Quantize</button>
      </div>

      {/* 缩放靠右：它是"看多远"的旋钮，和左边那些"改工程"的控件不同类。 */}
      <div style={{ ...C.group, marginLeft: 'auto' }} title="横向缩放（滚轮微调，双击回默认）">
        <span style={C.sub}>zoom</span>
        <input ref={zoomRef} className="midi-slider" type="range"
          min={ZOOM_MIN} max={ZOOM_MAX} step={1} value={pps}
          style={{ width: 96, flex: '0 0 auto', '--fill': zoomFill } as React.CSSProperties}
          onChange={e => onZoom(Number(e.target.value))}
          onDoubleClick={() => onZoom(DEFAULT_PPS)} />
        <span style={{ ...C.sub, width: 34 }}>{Math.round(pps)}px</span>
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
