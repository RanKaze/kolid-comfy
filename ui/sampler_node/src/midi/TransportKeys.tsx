// ── 传输键：两种模式共用的一套「回起点 / 播停 / 停止 / 循环」────────────────────────────────
//
// 语义只写在这里，MIDI 主窗底部的 Transport 与 Video 监视器下的走带条都渲染这一个组件 ——
// 两边按钮长得可以不一样（keyStyle 由宿主给），做的事情必须是同一件：
//   ⏮   回**入点**（时间线没有入/出点时才回 0）
//   ▶/⏸ 播 / 停；播放头停在片尾时按播放 = 先回入点再播（不从头突然窜起来）
//   ■   暂停并回到与 ⏮ 同一处（不是"停在那儿"）
//   LOOP 循环开关：开 = 圈住整条时间线，关 = 清掉范围。区间只有一份（时间线的入/出点），
//        所以这个键在两种模式里是同一个动作，由宿主传进来的 onToggleLoop 落笔。
//
// 位置一律问 clock，这里不缓存秒数；播放态也由宿主从 clock 的订阅里抄进来（两边同源）。

import React from 'react';
import { clock } from './clock';
import { transport } from './transportActions';

export type TransportRange = {
  on: boolean;
  /** 入点（秒）。`on` 为假时不看它。 */
  inSec: number;
};

/** 回起点的落点：有范围回入点，没有回 0。两处都按这一句算，别再各写一份。 */
export const homeSec = (r: TransportRange): number => (r.on ? Math.max(0, r.inSec) : 0);

const defaultKey = (on = false): React.CSSProperties => ({
  minWidth: 28, height: 24, padding: '0 9px', borderRadius: 6, cursor: 'pointer',
  fontSize: 12, fontWeight: 700, lineHeight: '22px',
  background: on ? 'rgba(10,132,255,0.9)' : 'rgba(255,255,255,0.07)',
  border: '0.5px solid rgba(255,255,255,0.16)', color: on ? '#fff' : 'rgba(255,255,255,0.82)',
});

/** 循环图标：两支首尾相接的圆角箭头（与界面里其它图标同一套描边画法，不用文字）。
 *  颜色跟 currentColor 走 —— 开/关两态由按钮的 color 决定。 */
export const LoopIcon: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"
       style={{ display: 'block' }} aria-hidden="true">
    <path d="M17.5 2.5l3 3-3 3" />
    <path d="M4 12V10.5a4 4 0 014-4h12.2" />
    <path d="M6.5 21.5l-3-3 3-3" />
    <path d="M20 12v1.5a4 4 0 01-4 4H3.8" />
  </svg>
);

/** 图标键：宿主给的皮肤之上只补"居中"这一条 —— 文字键的 lineHeight/padding 对 SVG 不适用。 */
const iconKey = (base: React.CSSProperties): React.CSSProperties => ({
  ...base, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
});

export const TransportKeys: React.FC<{
  playing: boolean;
  range: TransportRange;
  /** 工程长度（秒）：播放头已经在片尾时，按播放先回起点。<=0 = 不知道长度，不做这件事。 */
  endSec: number;
  onToggleLoop: () => void;
  /** 键的外观（两处各一套皮肤）。 */
  keyStyle?: (on?: boolean) => React.CSSProperties;
}> = ({ playing, range, endSec, onToggleLoop, keyStyle }) => {
  const key = keyStyle ?? defaultKey;
  const home = (): void => { transport.seek(homeSec(range)); };
  const stop = (): void => { transport.stopAt(homeSec(range)); };
  const toggle = (): void => {
    if (playing) { transport.pause(); return; }
    const t = clock.seconds();
    if (endSec > 0 && t >= endSec - 1e-3) transport.seek(homeSec(range));
    transport.play();
  };
  return (
    <>
      <button style={key()} title="回入点（没有入/出点就回开头）" onClick={home}>⏮</button>
      <button style={key(playing)} title={playing ? '暂停' : '播放'} onClick={toggle}>
        {playing ? '⏸' : '▶'}
      </button>
      <button style={key()} title="停止：暂停并回到与 ⏮ 同一处" onClick={stop}>■</button>
      <button style={iconKey(key(range.on))}
        aria-label="Loop" aria-pressed={range.on}
        title={range.on
          ? '循环开：播到出点跳回入点。关掉 = 清掉入/出点（整条时间线）'
          : '循环关：打开 = 把整条时间线圈成入/出点开始循环'}
        onClick={onToggleLoop}><LoopIcon /></button>
    </>
  );
};
