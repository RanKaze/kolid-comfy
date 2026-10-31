// ── 时钟的 React 接口 ────────────────────────────────────────────────────────────────────────
//
// 只做一件事：把 `clock` 的广播接进组件，**且不逼组件每帧重渲染**。
//
// 时间的读法有两种，用错哪种都难受：
//   * `useClockFrame(fn)` —— 每帧回调，fn 里直接改 DOM / 画 canvas。播放头、时间读数走这条。
//   * `useClockState(sel)` —— 只在"状态"变化时重渲染（在播/停、采样率、对齐源）。按钮、标签走这条。
//
// 之所以不给一个 `useState(seconds)`：那会让整棵面板树每秒重渲染 60 次，播放头反而更卡。

import { useEffect, useReducer, useRef } from 'react';
import type { RefObject } from 'react';
import { clock, type ClockStatus } from './clock';

/** 每帧回调。fn 会拿到最新引用（不必 useCallback 包，也不会因为闭包变旧而失效）。 */
export const useClockFrame = (fn: () => void): void => {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => clock.subscribe(() => ref.current()), []);
};

/** 状态快照：只在 ready / source / playing / sampleRate 变化时才重渲染。 */
export const useClockStatus = (): ClockStatus => {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const key = useRef('');
  useEffect(() => clock.subscribe(() => {
    const s = clock.status();
    const next = `${s.ready}|${s.source}|${s.playing}|${s.sampleRate}`;
    if (next !== key.current) {
      key.current = next;
      bump();
    }
  }), []);
  return clock.status();
};

/** 把"此刻的播放头"写进一个元素的文字里（不触发渲染）。`fmt` 每帧调用。 */
export const useClockText = (el: RefObject<HTMLElement | null>, fmt: (seconds: number) => string): void => {
  const f = useRef(fmt);
  f.current = fmt;
  useClockFrame(() => {
    if (!el.current) return;
    const s = f.current(clock.seconds());
    if (el.current.textContent !== s) el.current.textContent = s;
  });
};
