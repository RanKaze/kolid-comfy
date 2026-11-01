// ── 键位：宿主侧的读法与手 ──────────────────────────────────────────────────────────────────────
//
// 表的唯一真源在 `nodes/web/js/keymap.js`（画布页面直接加载的那一份），这里拿到的是构建时转出的
// 类型化副本（`keymap.generated.ts`，由 `tools/gen_keymap.cjs` 写，别手改）。
//
// 为什么判定逻辑要在这儿再写一遍：页面跑在 `<script>` 里、宿主跑在 bundle 里，物理上不能共用
// 一段代码。所以两边各写一份，靠 `temporary/_test_keymap_parity.mjs` 把同一批事件喂给两边逐条
// 对拍 —— 只有"答案一样"是可验证的，注释一样不算。
//
// 三条语义（与页面那份逐字对应）：
//   1. 修饰必须完全一致；Ctrl 在 macOS 上也算 Cmd。
//   2. `shiftAsParam` 的条目忽略 Shift（方向键微调靠它区分 1 / 10 像素）。
//   3. 未知 id 一律 false —— 拼错的 id 静默，不抛。
//
// 用户的自定义存 localStorage 的 `sampler.keymap`（同源，画布 iframe 与这里共用一份）。谁改了
// 另一边都能立刻看见：本窗口靠自定义事件，另一个 document 靠浏览器自己的 storage 事件。

import { KEYMAP, KEY_COMMAND_IDS, type KeyDef, type KeyScope } from './keymap.generated';

export { KEYMAP, KEY_COMMAND_IDS };
export type { KeyDef, KeyScope };

/** localStorage 的键，也是页面 HTML 里那份脚本用的同一个键。 */
export const KEYMAP_STORE = 'sampler.keymap';
const CHANGE_EVENT = 'kolid-keymap';

// 表在类型上是"字面量元组"（这样 KeyCommandId 才是那串确切的 id），迭代时收成 KeyDef[] ——
// 不然 `shiftAsParam` 这种只存在于部分成员上的可选字段会被 TS 判成"某些成员没有它"。
const DEFS: readonly KeyDef[] = KEYMAP;
const byId: Record<string, KeyDef> = {};
for (const d of DEFS) byId[d.id] = d;

// ── 覆盖表 ───────────────────────────────────────────────────────────────────────────────────
// 只收"表里真有的 id"，值只收 string | null（null = 用户显式解绑）。读到别的东西当没存过 ——
// 一份手改坏的 localStorage 不该让整个工作台的键全哑掉。
export type KeyOverrides = Record<string, string | null>;

const readOverrides = (): KeyOverrides => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEYMAP_STORE) || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: KeyOverrides = {};
    for (const k of Object.keys(raw)) {
      if (!byId[k]) continue;
      if (raw[k] === null || typeof raw[k] === 'string') out[k] = raw[k];
    }
    return out;
  } catch { return {}; }
};

let cache: KeyOverrides | null = null;
export const overrides = (): KeyOverrides => (cache ??= readOverrides());

const write = (next: KeyOverrides): void => {
  cache = next;
  try { localStorage.setItem(KEYMAP_STORE, JSON.stringify(next)); } catch { /* 存不下也本次生效 */ }
  // 本窗口的订阅者（Settings 那一屏、宿主的键判定）立刻知道；画布 iframe 走 storage 事件。
  try { window.dispatchEvent(new Event(CHANGE_EVENT)); } catch { /* 无 window（测试里） */ }
};

// ── chord 解析（与 js/keymap.js 的 parse 逐条一致）───────────────────────────────────────────
const MODS: Record<string, 'ctrl' | 'shift' | 'alt'> = {
  ctrl: 'ctrl', control: 'ctrl', cmd: 'ctrl', meta: 'ctrl', command: 'ctrl',
  shift: 'shift', alt: 'alt', option: 'alt', opt: 'alt',
};

export type Chord = { ctrl: boolean; shift: boolean; alt: boolean; key: string };

export const parseChord = (chord: string): Chord | null => {
  if (typeof chord !== 'string' || !chord) return null;
  const parts = chord.split('+');
  // "Ctrl++"：末尾空串是加号本身
  if (parts.length > 1 && parts[parts.length - 1] === '') { parts.pop(); parts[parts.length - 1] = '+'; }
  const out: Chord = { ctrl: false, shift: false, alt: false, key: '' };
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) return null;
    const m = MODS[p.toLowerCase()];
    if (m) { out[m] = true; continue; }
    if (out.key) return null;
    out.key = p.toLowerCase();
  }
  return out.key ? out : null;
};

// 事件的主键与一段 chord 的主键是不是同一个键（三条路一起认，见页面那份的同名函数）。
const keyMatch = (e: KeyboardEvent, key: string): boolean => {
  const k = String(e.key || '').toLowerCase();
  if (k === key) return true;
  if (key === 'space' || key === ' ') return k === ' ' || k === 'spacebar';
  if (key === 'esc') return k === 'escape';
  if (key.length === 1) {
    const up = key.toUpperCase();
    if (e.code === 'Key' + up) return true;
    if (e.code === 'Digit' + key) return true;
    if (e.code === 'Numpad' + key) return true;
  }
  const code: Record<string, string> = {
    tab: 'Tab', enter: 'Enter', escape: 'Escape', delete: 'Delete', backspace: 'Backspace',
    arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown',
  };
  return !!code[key] && e.code === code[key];
};

const modHeld = (e: KeyboardEvent): boolean => !!(e.ctrlKey || e.metaKey);

const matches = (e: KeyboardEvent, c: Chord, def?: KeyDef): boolean => {
  if (c.ctrl !== modHeld(e)) return false;
  if (c.alt !== !!e.altKey) return false;
  if (!def?.shiftAsParam && c.shift !== !!e.shiftKey) return false;
  return keyMatch(e, c.key);
};

// ── 录制互斥 ─────────────────────────────────────────────────────────────────────────────────
// Key Bindings 那一屏正在等用户按键时，全局热键必须全哑：否则录 Alt+P 会顺手把停靠编辑打开，
// 录 Ctrl+S 会顺手存一遍盘。宿主的热键都在 document 的捕获阶段，跟录制框同一层，谁先注册谁先
// 跑 —— 靠 stopPropagation 挡不住，只能让它们自己让路。
let recording = false;
export const setRecording = (v: boolean): void => { recording = v; };
export const isRecording = (): boolean => recording;

// ── 读 ───────────────────────────────────────────────────────────────────────────────────────
/** 这条命令此刻生效的键（用户覆盖优先；空数组 = 没绑）。 */
export const chordsOf = (id: string): readonly string[] => {
  const o = overrides();
  if (id in o) return o[id] === null ? [] : [o[id] as string];
  return byId[id]?.keys ?? [];
};

/** 这个事件是不是这条命令。
 *  `keyOnly` = 只认主键，不管按没按修饰键 —— 松键那一侧专用：按住 C 之后又按下 Shift 再松开，
 *  事件带的是 shiftKey=true，按"修饰键必须全等"判就永远不匹配 ⇒ 按住档的武装一直不撤，
 *  下一次点片段就被当成"剪"而不是"选中"。按下仍走全等（Ctrl+C 是别的命令）。 */
export const hit = (e: KeyboardEvent, id: string, opts?: { keyOnly?: boolean }): boolean => {
  const def = byId[id];
  if (!def) return false;
  for (const chord of chordsOf(id)) {
    const c = parseChord(chord);
    if (!c) continue;
    if (opts?.keyOnly ? keyMatch(e, c.key) : matches(e, c, def)) return true;
  }
  return false;
};

const NAMED: Record<string, string> = {
  ' ': 'Space', spacebar: 'Space', escape: 'Escape', esc: 'Escape', enter: 'Enter',
  tab: 'Tab', delete: 'Delete', backspace: 'Backspace', arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown',
};

/** 事件 → "Ctrl+Shift+Z"。只按了修饰键时返回 ''（录制要继续等主键）。 */
export const chordOf = (e: KeyboardEvent): string => {
  const k = String(e.key || '');
  if (!k) return '';
  if (/^(control|shift|alt|meta|os|hyper|super|capslock|fn|dead)$/i.test(k)) return '';
  if (k === 'Process' || k === 'Unidentified') return '';
  let key = NAMED[k.toLowerCase()];
  if (!key) {
    // 物理键位优先：中文输入法激活时 e.key 常是 'Process'，而 code 永远在。
    const letter = /^Key([A-Z])$/.exec(e.code || '');
    const digit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code || '');
    if (letter) key = letter[1];
    else if (digit) key = digit[1];
    else if (k.length === 1) key = k.toUpperCase();
  }
  if (!key) return '';
  const mods: string[] = [];
  if (modHeld(e)) mods.push('Ctrl');
  if (e.shiftKey) mods.push('Shift');
  if (e.altKey) mods.push('Alt');
  return [...mods, key].join('+');
};

/** 一条命令生效的面（`scopes` 没写就只有 `scope` 那一个）。 */
export const scopesOf = (def: KeyDef): readonly KeyScope[] => def.scopes ?? [def.scope];

/** 两个面集有交集 —— 只有交集非空的两条命令才可能同时吃到同一个键。 */
const shareScope = (a: KeyDef, b: KeyDef): boolean => {
  const sa = scopesOf(a);
  return scopesOf(b).some(s => sa.includes(s));
};

/** 面集有交集、且已经占了这个键的别的命令。 */
export const conflicts = (id: string, chord: string): KeyDef[] => {
  const self = byId[id];
  const b = parseChord(chord);
  if (!self || !b) return [];
  const out: KeyDef[] = [];
  for (const d of DEFS) {
    if (d.id === id || !shareScope(self, d)) continue;
    if (chordsOf(d.id).some(c => {
      const a = parseChord(c);
      return !!a && a.ctrl === b.ctrl && a.alt === b.alt && a.key === b.key
        && (d.shiftAsParam || a.shift === b.shift);
    })) out.push(d);
  }
  return out;
};

// ── 写 ───────────────────────────────────────────────────────────────────────────────────────
/** 绑一条命令。`null` = 解绑（键留在表里，只是没有键位）。返回归一化后的 chord 或 null。 */
export const setBinding = (id: string, chord: string | null): string | null => {
  if (!byId[id]) return null;
  let normalized: string | null = null;
  if (chord !== null) {
    const c = parseChord(chord);
    if (!c) return null;
    let key = chord.split('+').pop()?.trim() || '+';
    // 单个字母统一大写（与 chordOf 记下来的写法一致），标点/数字原样。
    if (key.length === 1 && /[a-z]/i.test(key)) key = key.toUpperCase();
    // 修饰顺序固定成 Ctrl+Shift+Alt+主键：同一组键只能存出一种写法，否则冲突检测会漏。
    normalized = [c.ctrl ? 'Ctrl' : '', c.shift ? 'Shift' : '', c.alt ? 'Alt' : '', key]
      .filter(Boolean).join('+');
  }
  write({ ...overrides(), [id]: normalized });
  return normalized;
};

export const resetBinding = (id: string): void => {
  const next = { ...overrides() };
  delete next[id];
  write(next);
};

export const resetAllBindings = (): void => write({});

/** 这一条是不是用户改过的（UI 上标个小点、也决定"恢复默认"是否可点）。 */
export const isCustom = (id: string): boolean => id in overrides();

// ── 订阅 ─────────────────────────────────────────────────────────────────────────────────────
/** 订阅键位变更（本窗口的改动 + 别的 document 改 localStorage）。 */
export const onKeymapChange = (fn: () => void): (() => void) => {
  const local = () => { cache = null; fn(); };
  const cross = (ev: StorageEvent) => { if (!ev.key || ev.key === KEYMAP_STORE) local(); };
  window.addEventListener(CHANGE_EVENT, local);
  window.addEventListener('storage', cross);
  return () => {
    window.removeEventListener(CHANGE_EVENT, local);
    window.removeEventListener('storage', cross);
  };
};

/** 按 group 收一遍（Key Bindings 屏的顺序就是表里的顺序，组也照首次出现的次序）。 */
export const groupedKeymap = (): { group: string; defs: KeyDef[] }[] => {
  const out: { group: string; defs: KeyDef[] }[] = [];
  for (const d of DEFS) {
    const g = out.find(x => x.group === d.group);
    if (g) g.defs.push(d);
    else out.push({ group: d.group, defs: [d] });
  }
  return out;
};

/** 显示用：macOS 上把 Ctrl 写成 ⌘（表里写的仍是 Ctrl —— 一个键，两种叫法）。 */
const IS_MAC = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || '');
export const displayChord = (chord: string): string => {
  if (!chord) return '';
  const parts = chord.split('+');
  const key = parts.pop() || '';
  const shown = parts.map(p => (IS_MAC ? { Ctrl: '⌘', Shift: '⇧', Alt: '⌥' }[p] || p : p));
  return [...shown, key].join(IS_MAC ? ' ' : '+');
};
