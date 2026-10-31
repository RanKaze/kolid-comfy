// MIDI 的**视图态**：栏宽、泳道高。不属工程（换文档不该跟着变）、不进撤销栈、不入 .cud ——
// 它跟"这个窗口多大"是一回事，所以按 origin 记在 localStorage 里（与 dock 布局同一套规矩）。
//
// 拖完就存，下次打开还是你的比例；拖歪了双击分隔条回默认。

const KEY = 'sampler.midiLayout';

export type MidiLayout = {
  /** 左栏（乐器）宽度。 */
  trackW: number;
  /** 底部力度泳道高度。 */
  velH: number;
};

export const DEFAULT_LAYOUT: MidiLayout = { trackW: 330, velH: 86 };

export const readLayout = (): MidiLayout => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<MidiLayout>;
    const num = (v: unknown, d: number) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : d);
    return { trackW: num(raw.trackW, DEFAULT_LAYOUT.trackW), velH: num(raw.velH, DEFAULT_LAYOUT.velH) };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
};

export const writeLayout = (patch: Partial<MidiLayout>): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readLayout(), ...patch }));
  } catch { /* 隐私模式 / 配额满：拖还是能拖，只是记不住 */ }
};
