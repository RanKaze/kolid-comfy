import React, { useSyncExternalStore } from 'react';

// ── 资产卡片的尺度 ─────────────────────────────────────────────────────────────────────────
// 卡片的**高度一致**，宽度由图片自己的宽高比推出来；scale 只改高度，于是每一列都按同一比例变宽变窄。
// Assets 与 Eagle 是**两扇不同的窗**：各记各的 scale（原来共用一颗值，拖一处两处一起变，
// 而 Eagle 的网格和 Assets 的流水排法本来就不该是同一个大小）。各自落 localStorage。
/** 哪扇窗的 scale。`assets` = Assets 窗，`eagle` = Eagle 窗。 */
export type ScaleKind = 'assets' | 'eagle';

const KEYS: Record<ScaleKind, string> = {
  assets: 'sampler.assetCardScale',
  eagle: 'sampler.eagleCardScale',
};
const MIN = 0.6, MAX = 2;
/** scale = 1 时缩略图那一块的高度。文字区另有固定高度，卡片总高随之一致。 */
export const CARD_BASE_H = 112;

const clamp = (n: number): number => Math.min(MAX, Math.max(MIN, Math.round(n * 20) / 20));

/** 一颗独立的小 store：读 localStorage、钉住当前值、通知订阅者。 */
const makeStore = (key: string) => {
  const read = (): number => {
    try {
      const v = Number(localStorage.getItem(key));
      return Number.isFinite(v) && v > 0 ? clamp(v) : 1;
    } catch { return 1; }
  };
  let current = read();
  const subs = new Set<() => void>();
  return {
    get: (): number => current,
    set: (v: number): void => {
      const next = clamp(v);
      if (next === current) return;
      current = next;
      try { localStorage.setItem(key, String(next)); } catch { /* 隐私模式 / 配额满：这一趟照用 */ }
      subs.forEach(fn => fn());
    },
    subscribe: (fn: () => void): (() => void) => { subs.add(fn); return () => { subs.delete(fn); }; },
  };
};

const STORES: Record<ScaleKind, ReturnType<typeof makeStore>> = {
  assets: makeStore(KEYS.assets),
  eagle: makeStore(KEYS.eagle),
};

export const getAssetScale = (kind: ScaleKind = 'assets'): number => STORES[kind].get();
export const setAssetScale = (v: number, kind: ScaleKind = 'assets'): void => { STORES[kind].set(v); };
export const useAssetScale = (kind: ScaleKind = 'assets'): number =>
  useSyncExternalStore(STORES[kind].subscribe, STORES[kind].get, () => 1);
/** scale → 缩略图高度（px）。 */
export const cardHeightOf = (scale: number): number => Math.max(48, Math.round(CARD_BASE_H * scale));

/** 原生尺寸 → 宽高比；缺尺寸时退回 16:9。 */
export const aspectOf = (w?: number, h?: number, fallback = 16 / 9): number =>
  w && h && w > 0 && h > 0 ? w / h : fallback;

export type JustifiedRow<T> = { items: T[]; height: number; widths: number[] };

/**
 * Justified 行布局（Eagle 那张网格的排法）：先按目标高猜分行，再让**整行**按宽高比把可用宽度
 * 分完 —— 于是每一行都正好铺满，行内每张卡的图片高度仍然一致。
 *
 * 为什么不是 CSS flex-wrap：flex-wrap 按"目标宽"断行，断完行尾会剩一截空白；Eagle 的排法是把
 * 那一截按比例分给这一行，图片因此略高一点、宽度撑到右边。**最后一行例外**：按目标高与自己的
 * 宽高比排，宽度不硬拉满（一张图不该被拉成一整行）。
 */
export function justifiedRows<T extends { ratio: number }>(
  items: readonly T[], width: number, targetH: number, gap: number,
): JustifiedRow<T>[] {
  const W = Math.max(1, width);
  const H = Math.max(24, targetH);
  const G = Math.max(0, gap);
  const out: JustifiedRow<T>[] = [];
  let cur: T[] = [];
  let sum = 0;
  const flush = (last: boolean) => {
    if (!cur.length) return;
    const avail = Math.max(1, W - G * (cur.length - 1));
    // 最后一行永远按目标高排，宽度不硬拉满 —— 用户点名要的。
    let h = last ? H : avail / sum;
    const height = Math.max(12, Math.round(h));
    const widths = cur.map(it => Math.max(1, Math.floor(h * it.ratio)));
    let slack = Math.round(avail) - widths.reduce((a, b) => a + b, 0);
    for (let i = 0; slack > 0; i = (i + 1) % widths.length, slack--) widths[i] += 1;
    for (let i = 0; slack < 0 && i < widths.length * 4; i++) {
      const j = i % widths.length;
      if (widths[j] > 1) { widths[j] -= 1; slack += 1; }
    }
    out.push({ items: cur, height, widths });
    cur = [];
    sum = 0;
  };
  for (const it of items) {
    cur.push(it);
    sum += it.ratio;
    if (H * sum + G * (cur.length - 1) >= W) flush(false);
  }
  flush(true);
  return out;
}

/** 工具条上那颗尺度滑杆：高度一致、宽度跟随图片比例，这一颗只改"多大一张"。
 *  `kind` 决定它拧的是哪扇窗的那颗值（Assets / Eagle 互不影响）。 */
export const CardScaleControl: React.FC<{ kind?: ScaleKind }> = ({ kind = 'assets' }) => {
  const scale = useAssetScale(kind);
  return (
    <span
      title={kind === 'eagle'
        ? 'Eagle scale — every card keeps the same height; width follows each asset\'s own aspect ratio'
        : 'Assets scale — every card keeps the same height; width follows each asset\'s own aspect ratio'}
      style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}
    >
      <input
        type="range"
        min={MIN}
        max={MAX}
        step={0.05}
        value={scale}
        onChange={e => setAssetScale(Number(e.target.value), kind)}
        onPointerDown={e => e.stopPropagation()}
        style={{ width: 56, height: 14, margin: 0, accentColor: '#3b9dff', cursor: 'pointer' }}
      />
      <span style={{
        width: 26, textAlign: 'right', fontSize: 8.5, color: 'rgba(255,255,255,0.38)',
        fontVariantNumeric: 'tabular-nums',
      }}>{Math.round(scale * 100)}%</span>
    </span>
  );
};
