// ── MIDI 界面（一扇窗，三块）─────────────────────────────────────────────────────────────────
//
// 布局是固定的三块，不再拆成四扇可以乱摆的窗：
//
//   ┌───────────────────────────────────────────────────────────┐
//   │ Transport  ⏮ ■ ▶   0:12.480   3.2.220   BPM 拍号  LOOP  ⏱ │  ← 横贯顶部
//   ├──────────────╫───────────╫────────────────────────────────┤
//   │ INSTRUMENTS  ║           ║ Piano Roll                     │  ← 两条分隔条都能拖
//   │ 轨 / 音色     ║           ║ 音符                           │
//   │              ║           ╠════════════════════════════════╣
//   │              ║           ║ 力度泳道                        │
//   └──────────────╨───────────╨────────────────────────────────┘
//
// 为什么不再让它们各占一扇 dock 窗：编曲是"改音色 → 看音符 → 压力度 → 再听一遍"这种来回，
// 窗一多，手就在窗口管理上跑掉了，还会把卷帘挤成一条缝。所以整件事只有一个落点：
// **模式主窗的正文**（与 Video 模式把播放器放进主窗同一个道理，见 EditPhase 的 docBodies）。
//
// 比例全可拖（这是这个界面的硬要求）：左栏宽度在 Splitter 上左右拖、力度泳道高度在卷帘
// 下面那条横线上上下拖，两处都双击回默认。宽度/高度是**视图态**，按 origin 存在
// localStorage（layoutPrefs.ts），不属工程也不进撤销栈。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_LAYOUT, readLayout, writeLayout } from './layoutPrefs';
import { MidiPianoRoll } from './PianoRoll';
import { Splitter } from './Splitter';
import { MidiTracks } from './TrackList';
import { MidiTransport } from './Transport';
import type { MidiCtl } from './types';

const TRACK_MIN = 160;
const TRACK_MAX = 620;
/** 卷帘至少留这么宽 —— 拖到头等于把卷帘关掉，那不叫调比例。 */
const ROLL_MIN = 260;

/** MIDI 里的滑杆（卷帘 zoom、轨力度）—— 与 Tracks 窗那根 Opacity 同一族，一字不差地照搬它的
 *  三条结论：**方角**（这排控件里没有药丸）、**槽底不透明中性色**（半透明会染上旁边的高亮底色）、
 *  **拇指平时藏起来**（一块白方块放在这么窄的一行里等于第二枚高亮徽章，比数值还抢眼）。
 *  两条量过像素的坑照抄：轨道**不许写 border** —— 0.5px 边框会让渐变图块平铺出右边缘溢色、
 *  并把内容盒从 6px 压到 5px 使拇指上下不居中；发丝线一律走 box-shadow: inset。
 *  走过的那段用 --fill（行内写百分比）切一刀填蓝，不用再叠一条进度节点（会被 flex 挤歪）。
 *  注意这是**模板字符串**：正文里不能出现反引号和美元花括号。 */
const MIDI_CSS = `
.midi-slider { -webkit-appearance: none; appearance: none; height: 14px; margin: 0; padding: 0;
  background: transparent; cursor: pointer; outline: none; }
.midi-slider::-webkit-slider-runnable-track {
  height: 6px; border-radius: 2px; border: 0;
  background-color: #212125;
  background-image: linear-gradient(90deg, rgba(110,160,225,0.78) 0 var(--fill, 50%), transparent var(--fill, 50%) 100%);
  background-repeat: no-repeat;
  box-shadow: inset 0 0 0 0.5px rgba(255,255,255,0.13); }
.midi-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none;
  width: 2px; height: 6px; margin-top: 0; border: 0; border-radius: 1px; background: transparent; }
.midi-slider:hover::-webkit-slider-thumb,
.midi-slider:focus-visible::-webkit-slider-thumb,
.midi-slider:active::-webkit-slider-thumb { background: rgba(255,255,255,0.9); }
.midi-slider::-moz-range-track { height: 6px; border-radius: 2px; border: 0;
  background: #212125; box-shadow: inset 0 0 0 0.5px rgba(255,255,255,0.13); }
.midi-slider::-moz-range-progress { height: 6px; border-radius: 2px; background: rgba(110,160,225,0.78); }
.midi-slider::-moz-range-thumb { width: 2px; height: 6px; border-radius: 1px; background: transparent; border: 0; }
.midi-slider:hover::-moz-range-thumb { background: rgba(255,255,255,0.9); }
`;

/** 这一刻允许的最大栏宽：既要给卷帘留够，也不许吃掉整窗的一半以上。
 *  主窗被 dock 拖窄时它会自动跟着缩 —— 否则左栏 330 会把卷帘压成 0（实测过）。 */
const capFor = (hostW: number) =>
  Math.max(TRACK_MIN, Math.min(TRACK_MAX, Math.min(hostW - ROLL_MIN, hostW * 0.6)));

const S = {
  wrap: {
    display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
    background: '#101114', color: 'rgba(255,255,255,0.85)',
  } as React.CSSProperties,
  body: { display: 'flex', flex: 1, minHeight: 0 } as React.CSSProperties,
  left: {
    display: 'flex', flexDirection: 'column', minWidth: 0, flexShrink: 0,
    background: '#16171a',
  } as React.CSSProperties,
  right: { flex: 1, minWidth: 0, position: 'relative', display: 'flex', flexDirection: 'column' } as React.CSSProperties,
  empty: {
    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    pointerEvents: 'none', fontSize: 12, color: 'rgba(255,255,255,0.3)',
  } as React.CSSProperties,
};

export const MidiWorkspace: React.FC<{ ctl: MidiCtl }> = ({ ctl }) => {
  const [trackW, setTrackW] = useState(() => readLayout().trackW);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // 拖动是**增量**式的：按下时记住当时的宽度，之后只加位移。宽度还要一份 ref ——
  // onStart 里读 state 会读到上一次渲染的值，而它正是在被改的那个。
  const wRef = useRef(trackW);
  wRef.current = trackW;
  const baseW = useRef(trackW);

  const startLeft = useCallback(() => { baseW.current = wRef.current; }, []);

  // 夹在 [TRACK_MIN, TRACK_MAX]，再夹到"卷帘还剩得下 ROLL_MIN"。窗口窄的时候
  // 后一条先命中 —— 不然拖出来的左栏会把卷帘压成一条缝。
  const dragLeft = useCallback((x: number, x0: number) => {
    const el = bodyRef.current;
    if (!el) return;
    const cap = capFor(el.getBoundingClientRect().width);
    setTrackW(Math.round(Math.max(TRACK_MIN, Math.min(cap, baseW.current + (x - x0)))));
  }, []);

  const commitLeft = useCallback(() => setTrackW(w => { writeLayout({ trackW: w }); return w; }), []);
  const resetLeft = useCallback(() => {
    const el = bodyRef.current;
    const w = el ? Math.min(DEFAULT_LAYOUT.trackW, capFor(el.getBoundingClientRect().width)) : DEFAULT_LAYOUT.trackW;
    setTrackW(Math.round(w));
    // 记的是**默认值**，不是被窄窗挤出来的那个数 —— 否则下次开在大屏上还是窄的。
    writeLayout({ trackW: DEFAULT_LAYOUT.trackW });
  }, []);

  // 窗自己变小（dock 拖窄、分屏）时把左栏收回来 —— 存的 px 是上次那扇窗的，不能一直信。
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const cap = capFor(el.getBoundingClientRect().width);
      setTrackW(prev => (prev > cap ? Math.round(cap) : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div style={S.wrap}>
      <style>{MIDI_CSS}</style>
      <MidiTransport ctl={ctl} />
      <div ref={bodyRef} style={S.body}>
        <div style={{ ...S.left, width: trackW }}>
          <MidiTracks ctl={ctl} />
        </div>
        <Splitter axis="x" onStart={startLeft} onDrag={dragLeft} onEnd={commitLeft} onReset={resetLeft}
          title="拖动改变乐器栏宽度（双击复位）" />
        <div style={S.right}>
          <MidiPianoRoll ctl={ctl} />
          {ctl.project.tracks.length === 0 && (
            <div style={S.empty}>No instrument yet — press “+ Instrument” on the left.</div>
          )}
        </div>
      </div>
    </div>
  );
};
