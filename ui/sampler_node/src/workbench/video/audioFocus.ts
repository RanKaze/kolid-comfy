import { audioCtx } from './audio';

// ── 独占音频槽(THE audio slot)───────────────────────────────────────────────────────────────
// 全页**只允许一个窗出声**:Inspector 在放、时间线 Player 就不能放,反之亦然 —— 将来的预听、
// 提示音也一样。仲裁、电平显示(Audio Monitor)都收在这一个模块里,新声源只要三步:
//
//   1. 播放开始 →  acquireAudioSlot({ id, label, probe }, onRevoked)
//   2. 暂停/结束/卸载 →  releaseAudioSlot(id)
//   3. onRevoked 里把自己 pause(被别人抢占时仲裁方调它;pause 会顺带走第 2 步)
//
// 就没有别的了:槽永远至多一个持有者,**后来者赢** —— 新按下的播放把旧的顶掉(用户刚点的那个
// 就是他想听的),被顶掉的一方在自己的 onRevoked 里安静下来。Monitor 只认"现在谁持着槽"。
//
// probe(电平探头)是声明方自己搭的 WebAudio 小图:源 → 上混 → 分光 → [gain → analyser]×2 →
// destination。声明方图自己管,Monitor 只**读** analyser、拨 gain —— 两边只认这四个节点。

export type AudioProbe = {
  /** 左/右声道电平探针(时域数据,RMS/峰值都从这里算)。 */
  analyserL: AnalyserNode;
  analyserR: AnalyserNode;
  /** 声道闸(Monitor 的 S 键拨它):1 = 通,0 = 哑。分析器在闸**之后** —— 哑掉的声道电平真掉。 */
  gainL: GainNode;
  gainR: GainNode;
};

export type AudioHolder = {
  /** 声源 id:'inspector' / 'player' / …… 释放与幂等申请都按它对账。 */
  id: string;
  /** Monitor 上显示的名号,如 'Inspector — Demo clip'。 */
  label: string;
  probe: AudioProbe;
};

let holder: AudioHolder | null = null;
let revoke: (() => void) | null = null;
const subs = new Set<() => void>();
const emit = () => { for (const fn of subs) fn(); };

export const currentAudioHolder = (): AudioHolder | null => holder;
export const subscribeAudioFocus = (fn: () => void): (() => void) => {
  subs.add(fn);
  return () => { subs.delete(fn); };
};

/** 申请独占。同一 id = 刷新(label/探头/回调);别人持着 = 先调它的 onRevoked(它自己 pause +
 *  release),然后把槽交给来者。永不拒绝 —— 拒绝会把"按了播放没反应"这种坏手感发给用户。 */
export const acquireAudioSlot = (h: AudioHolder, onRevoked: () => void): void => {
  if (holder?.id === h.id) { holder = h; revoke = onRevoked; emit(); return; }
  if (holder && revoke) {
    const r = revoke;
    revoke = null;
    try { r(); } catch { /* 旧持有者的收尾不许挡新声源上路 */ }
  }
  holder = h;
  revoke = onRevoked;
  emit();
};

export const releaseAudioSlot = (id: string): void => {
  if (holder?.id !== id) return;
  holder = null;
  revoke = null;
  emit();
};

// ── 探头搭建 ─────────────────────────────────────────────────────────────────────────────────
// 任意 AudioNode(媒体元素源 / 增益总线 / …… )接成双声道探头。先过一层**强制立体声**的增益:
// 单声源(单声道 mp3、mono 采样)走 speakers 解释上混,左右两只表都有话可说 —— 否则 splitter
// 的右臂是空的,右表永远贴底,看起来像坏表。

export const buildStereoProbe = (src: AudioNode): AudioProbe => {
  const c = audioCtx();
  const up = c.createGain();
  up.channelCount = 2;
  up.channelCountMode = 'explicit';
  up.channelInterpretation = 'speakers';
  const split = c.createChannelSplitter(2);
  const arm = (ch: 0 | 1) => {
    const g = c.createGain();
    const a = c.createAnalyser();
    a.fftSize = 1024;
    split.connect(g, ch);
    g.connect(a);
    a.connect(c.destination);      // analyser 直通:声音照常出喇叭,电平只是顺手读一份
    return { g, a };
  };
  const L = arm(0), R = arm(1);
  src.connect(up);
  up.connect(split);
  return { analyserL: L.a, analyserR: R.a, gainL: L.g, gainR: R.g };
};
