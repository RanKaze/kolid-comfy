// ── Cut 的武装状态与"指针在哪一面" ─────────────────────────────────────────────────────────────
//
// 三处 Cut 默认都是 C：画布裁切（页面里的模态框）、时间线剪段、卷帘剪音符。**按哪一条由鼠标所在
// 的面决定**（拍板 3）—— 所以这里只记两件宿主看得见的事：指针指着哪一面、以及"剪"此刻有没有
// 武装。键盘焦点不参与判定：焦点在画布 iframe 里时页面与宿主会收到同一个键（见 hotkeys.ts 的桥），
// 两边各自检查自己那一面有没有被指着（页面用 cursorInside，宿主用这里的 hover）。
//
// 武装默认是**按住**（拍板 2 的 a 档）：按下键武装、松开解除；面板上那颗按钮永远是"按一下切换"
// 的黏住态。用户可以在 Key Bindings 的 Cut 行里把键改成 Toggle —— 那份偏好住在 localStorage
// （`sampler.cutArm`），与键位表分开放：它不是一个键，是这条命令的手势。
//
// 指针位置：时间线 / 卷帘是宿主自己的 DOM，进出由各自根元素的 onPointerEnter / onPointerLeave
// 报；画布是 iframe，宿主收不到里面的指针事件 —— 页面在鼠标进出画布时发一条 `blend-canvas-hover`
// （见 blend_node.html 的 viewport mouseenter / mouseleave 与 App.tsx 的收口）。

import { useSyncExternalStore } from 'react';
import { precisionCursor } from './cursors';

export type CutCommand = 'cut.timeline' | 'cut.midi';
export type CutSurface = 'canvas' | 'timeline' | 'midi';
/** 键的手势：hold = 按住才武装（默认），toggle = 按一下切换。 */
export type ArmMode = 'hold' | 'toggle';

const COMMANDS: readonly CutCommand[] = ['cut.timeline', 'cut.midi'];
const PREF_STORE = 'sampler.cutArm';

export const surfaceOfCut = (cmd: CutCommand): CutSurface => (cmd === 'cut.timeline' ? 'timeline' : 'midi');

const readModes = (): Record<CutCommand, ArmMode> => {
  const out: Record<CutCommand, ArmMode> = { 'cut.timeline': 'hold', 'cut.midi': 'hold' };
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_STORE) || '{}') as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const k of COMMANDS) if (raw[k] === 'toggle' || raw[k] === 'hold') out[k] = raw[k] as ArmMode;
  } catch { /* 读不出来 = 全默认 */ }
  return out;
};

let modes = readModes();
const armed: Record<CutCommand, boolean> = { 'cut.timeline': false, 'cut.midi': false };
/** 这一次武装是不是**键**按下的。松键只解除自己按下的那一次 —— 面板按出来的黏住态，
 *  用户松开一个长按的键不该把它撤掉。 */
const byKey: Record<CutCommand, boolean> = { 'cut.timeline': false, 'cut.midi': false };

let canvasHover = false;
let timelineHover = false;
let midiHover = false;

const hovered = (): CutSurface | null =>
  canvasHover ? 'canvas' : timelineHover ? 'timeline' : midiHover ? 'midi' : null;

export type CutSnapshot = {
  armed: Record<CutCommand, boolean>;
  hover: CutSurface | null;
  modes: Record<CutCommand, ArmMode>;
};

const build = (): CutSnapshot => ({
  armed: { 'cut.timeline': armed['cut.timeline'], 'cut.midi': armed['cut.midi'] },
  hover: hovered(),
  modes: { 'cut.timeline': modes['cut.timeline'], 'cut.midi': modes['cut.midi'] },
});

const listeners = new Set<() => void>();
let snap: CutSnapshot = build();
const emit = (): void => { snap = build(); for (const fn of [...listeners]) fn(); };

export const subscribeCut = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};
export const getCut = (): CutSnapshot => snap;
/** 组件里读它：武装态、指针在的那一面、两条命令各自的手势。 */
export const useCut = (): CutSnapshot => useSyncExternalStore(subscribeCut, getCut);

/** 页面/面板报"指针进了这一面"。四面互斥（指针只在一个地方），所以哪个为真就是哪一面。 */
export const setHover = (surface: CutSurface, inside: boolean): void => {
  const before = hovered();
  if (surface === 'canvas') canvasHover = inside;
  else if (surface === 'timeline') timelineHover = inside;
  else midiHover = inside;
  if (hovered() !== before) emit();
};

/** 键按下：按住档先武装、不翻面；切换档按一下就翻。 */
export const pressCutKey = (cmd: CutCommand): void => {
  if (modes[cmd] === 'toggle') {
    armed[cmd] = !armed[cmd];
    byKey[cmd] = false;
  } else {
    armed[cmd] = true;
    byKey[cmd] = true;
  }
  emit();
};

/** 键松开：只解除"键按下的那一次"。 */
export const releaseCutKey = (cmd: CutCommand): void => {
  if (!byKey[cmd]) return;
  byKey[cmd] = false;
  armed[cmd] = false;
  emit();
};

/** 面板按钮：黏住态（与键的手势无关，按一下切换）。 */
export const setCutArmed = (cmd: CutCommand, on: boolean): void => {
  if (armed[cmd] === on && !byKey[cmd]) return;
  armed[cmd] = on;
  byKey[cmd] = false;
  emit();
};
export const toggleCut = (cmd: CutCommand): void => setCutArmed(cmd, !armed[cmd]);
export const disarmCut = (cmd: CutCommand): void => setCutArmed(cmd, false);

/** Key Bindings 里那颗 Hold / Toggle 分段控件写它。 */
export const setArmMode = (cmd: CutCommand, mode: ArmMode): void => {
  if (modes[cmd] === mode) return;
  modes = { ...modes, [cmd]: mode };
  // 从按住改成切换：已经按着的这一次直接变成黏住（byKey 清掉，松键不再撤）。
  if (mode === 'toggle') byKey[cmd] = false;
  try { localStorage.setItem(PREF_STORE, JSON.stringify(modes)); } catch { /* 存不下也本次生效 */ }
  emit();
};

// 窗口失焦不会有 keyup —— 按住档的武装在这里兜底松开（与 Timeline 那条剃刀老规矩一致）。
if (typeof window !== 'undefined') {
  window.addEventListener('blur', () => {
    let changed = false;
    for (const cmd of COMMANDS) {
      if (byKey[cmd]) { byKey[cmd] = false; armed[cmd] = false; changed = true; }
    }
    if (changed) emit();
  });
}

// 剪刀光标：按住或黏住 Cut 时整面换成它。与画笔 / 橡皮同一套"准星 + 徽章"（见 cursors.ts）——
// 剪哪一拍是要瞄准的，热点落在准星交点上。Tracks 的片段与卷帘的音符共用这一份。
export const CUT_CURSOR = precisionCursor(
  "<circle cx='4.1' cy='11.7' r='1.8'/><circle cx='4.1' cy='4.3' r='1.8'/>"
  + "<path d='M5.6 10.5 13.4 2.7M5.6 5.5l7.8 7.8'/>",
);
