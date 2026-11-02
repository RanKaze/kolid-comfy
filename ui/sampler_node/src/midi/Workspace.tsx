// ── MIDI 界面（一扇窗）──────────────────────────────────────────────────────────────────────
//
//   ┌───────────────────────────────────────────────────────────┐
//   │ 标尺：段范围游标（右端楔形把手）+ 播放头三角              │  ← 与 Tracks 同一套画法
//   ├───────────────────────────────────────────────────────────┤
//   │ Piano Roll                                                │
//   │ 音符 + 力度泳道                                            │
//   ├───────────────────────────────────────────────────────────┤
//   │ Transport  ⏮ ■ ▶  0:12.480  3.2.220  BPM 拍号  LOOP  GRID  ZOOM │  ← 横贯底部
//   └───────────────────────────────────────────────────────────┘
//
// 轨与段的列表**不在这里**：乐器轨就是 Tracks 窗里的轨，乐器段就是时间线上的段 ——
// 选哪一段，"卷帘"就编哪一段（见 useMidiHost 的 editor）。这样乐器轨和音频轨天生同住一排，
// 不会再出现"MIDI 窗里一套轨、Tracks 里另一套"的两份真相。
//
// 走带条贴底：正文（卷帘）才是这一窗的主体，播放控制是"随时按一下"的把手，不该占标题下面
// 第一条最显眼的位置 —— 视频那边的 Transport 也在底部，两处读法一致。
// 比例里只剩一条横线（力度泳道），双击回默认。横向比例（pps）与吸附网格住在底部 Transport。
// 这些是**视图态**，不属工程也不进撤销栈。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { hit, isRecording } from '../keybindings';
import { onGlobalKey, onGlobalKeyUp } from '../hotkeys';
import { disarmCut, getCut, pressCutKey, releaseCutKey, setHover } from '../workbench/cutStore';
import { DEFAULT_PPS, KEY_W, MidiPianoRoll, ZOOM_MAX, ZOOM_MIN } from './PianoRoll';
import { MidiTransport } from './Transport';
import { setMidiTool } from './tool';
import type { MidiCtl } from './types';

/** MIDI 里的滑杆（底部 Transport 的 zoom）—— 与 Tracks 窗那根 Opacity 同一族，一字不差地照搬它的
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

const S = {
  wrap: {
    display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
    background: '#101114', color: 'rgba(255,255,255,0.85)',
  } as React.CSSProperties,
  body: { display: 'flex', flex: 1, minHeight: 0 } as React.CSSProperties,
  right: { flex: 1, minWidth: 0, position: 'relative', display: 'flex', flexDirection: 'column' } as React.CSSProperties,
  empty: {
    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    pointerEvents: 'none', fontSize: 12, color: 'rgba(255,255,255,0.3)',
  } as React.CSSProperties,
};

export const MidiWorkspace: React.FC<{ ctl: MidiCtl }> = ({ ctl }) => {
  // 卷帘的视图态（吸附刻度、横向比例）住在这一层：控件在底部 Transport，消费在卷帘里。
  const [gridBeats, setGridBeats] = useState(0.25);
  const [pps, setPps] = useState(DEFAULT_PPS);
  // 卷帘的滚动容器 —— 缩放要把视口中心那一拍钉住。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ppsRef = useRef(pps);
  ppsRef.current = pps;

  // ── Cut / Brush / Eraser / Cursor 的键（C / B / E / A）──────────────────────────────────
  // 判定只看**指针在不在这扇窗上**（cutStore 的 hover，拍板 3），不看键盘焦点：焦点可能还留在
  // 画布 iframe 里（宿主的热键桥会把同一个键送到这里），而用户的手已经挪到卷帘上了。
  // 输入框里不抢键（轨头那种内联输入不该被 B/E 打断）；Key Bindings 录制时整条让路。
  useEffect(() => {
    const inField = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      const tag = el?.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el?.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || isRecording() || inField(e.target)) return;
      if (getCut().hover !== 'midi') return;
      if (hit(e, 'cut.midi')) {
        e.preventDefault();
        pressCutKey('cut.midi');
        return;
      }
      // A 是"把笔放下"：指针回到普通箭头，空白处不再落音（见 PianoRoll 的 onDown）。
      if (hit(e, 'tool.cursor')) {
        e.preventDefault();
        setMidiTool('cursor');
        disarmCut('cut.midi');
        return;
      }
      // 拿起一支笔 = 放下剪刀：两者都是"指针落在音符上该干什么"，同时武装只会互相吃掉手势。
      if (hit(e, 'tool.brush')) {
        e.preventDefault();
        setMidiTool('brush');
        disarmCut('cut.midi');
        return;
      }
      if (hit(e, 'tool.eraser')) {
        e.preventDefault();
        setMidiTool('eraser');
        disarmCut('cut.midi');
      }
    };
    // 松键不按 hover 过滤：按住档的武装必须在键松开时解除，哪怕指针已经挪出这扇窗。
    // 也只认主键（keyOnly）：松手那一刻按着 Shift/Ctrl，事件照样算"这把剪刀松了"。
    const onKeyUp = (e: KeyboardEvent) => {
      if (hit(e, 'cut.midi', { keyOnly: true })) releaseCutKey('cut.midi');
    };
    // 走宿主的热键桥（onGlobalKey）：焦点还留在画布 iframe 里时，窗口自己的 keydown 收不到。
    const un1 = onGlobalKey(onKey);
    const un2 = onGlobalKeyUp(onKeyUp);
    return () => {
      un1();
      un2();
      setHover('midi', false);
      // 卸载时键还按着 ⇒ 等不到那次 keyup：撤掉"键按下的这一档"（面板的黏住态不动）。
      releaseCutKey('cut.midi');
    };
  }, []);

  /** 缩放：**把视口中心那一拍钉在原地**。只改 pps 的话内容宽度变了而 scrollLeft 不动，
   *  用户一拖滑杆视野就跑到别处、还得再找回来 —— 这是缩放"不好用"的最大来源。
   *  中心必须在改之前按旧值记下：变窄时浏览器会先把 scrollLeft 夹回去，那之后还原不出来。 */
  const zoomTo = useCallback((next: number) => {
    const prev = ppsRef.current;
    const v = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(next)));
    if (v === prev) return;
    const host = scrollRef.current;
    const span = host ? Math.max(1, host.clientWidth - KEY_W) : 0;
    const centerBeat = host ? (host.scrollLeft + span / 2) / prev : 0;
    ppsRef.current = v;
    setPps(v);
    // 内容宽度要等这一帧的布局，所以挪 scrollLeft 放到下一帧。
    if (host) requestAnimationFrame(() => { host.scrollLeft = Math.max(0, centerBeat * v - span / 2); });
  }, []);

  const hasTracks = ctl.project.tracks.length > 0;

  return (
    <div style={S.wrap}
      onPointerEnter={() => setHover('midi', true)}
      onPointerLeave={() => setHover('midi', false)}>
      <style>{MIDI_CSS}</style>
      <div style={S.body}>
        <div style={S.right}>
          {ctl.editor
            ? <MidiPianoRoll ctl={ctl} gridBeats={gridBeats} pps={pps} scrollRef={scrollRef} />
            : (
              <div style={S.empty}>
                {hasTracks
                  ? 'No MIDI segment yet — double-click a MIDI lane in Tracks to add one.'
                  : 'No MIDI tracks yet — add one from the instrument library, or right-click Tracks.'}
              </div>
            )}
        </div>
      </div>
      <MidiTransport ctl={ctl} gridBeats={gridBeats} onGrid={setGridBeats} pps={pps} onZoom={zoomTo} />
    </div>
  );
};
