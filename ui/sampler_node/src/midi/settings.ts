// MIDI 的设置 —— 乐器库是哪条路径、往下扫几层。
//
// 真源是后端那份 data/sampler/midi.json（"这台机器的音源在哪儿"与浏览器无关，扫描也只能在后端做）。
// 这里把它包成一份**可订阅**的读法，好让 Settings 的 MIDI 屏和 Assets 的 Instruments 档看见同一个
// 数 —— 两处各存一份就会分叉：改了路径不重扫、或者一档说设过另一档说没设。
//
// 写是乐观的：先照用户的输入改本地、再 POST；后端回了带形状的答案就以它为准（它会把空白剪掉、
// 把深度夹进上限）。**形状闸**在这里不是洁癖 —— 老后端没有这条路由时回的是 404/`{}`，把空对象
// 当成设置收下会当场把用户填的路径抹成空。
import { useEffect, useState } from 'react';

export type LibraryState = { set: boolean; ok: boolean; reason: string };

export type MidiSettings = {
  /** 乐器库的根目录。空串 = 还没选。 */
  instrumentsLibrary: string;
  /** 往下展开几层目录（0 = 只看根目录）。 */
  scanDepth: number;
  /** 后端对这条路径的实话 —— 没设 / 不存在 / 不是目录 / 可读。 */
  state: LibraryState;
};

const NONE: LibraryState = { set: false, ok: false, reason: '' };
export const MIDI_SETTINGS_DEFAULT: MidiSettings = { instrumentsLibrary: '', scanDepth: 3, state: NONE };

let current: MidiSettings = { ...MIDI_SETTINGS_DEFAULT };
let loading: Promise<void> | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach(fn => fn());

/** 后端回的东西**认得出**才收（见文件头：`{}` 不是一份设置）。 */
const adopt = (data: unknown): MidiSettings | null => {
  const d = data as Partial<MidiSettings> | null;
  if (!d || typeof d !== 'object' || typeof d.instrumentsLibrary !== 'string' || typeof d.scanDepth !== 'number') {
    return null;
  }
  const st = d.state as Partial<LibraryState> | undefined;
  return {
    instrumentsLibrary: d.instrumentsLibrary,
    scanDepth: d.scanDepth,
    state: st && typeof st.ok === 'boolean'
      ? { set: !!st.set, ok: !!st.ok, reason: typeof st.reason === 'string' ? st.reason : '' }
      : NONE,
  };
};

/** 后端的字段名是下划线（`instruments_library`），这里转一次就往回走，不把两套名字散到组件里。 */
const fromWire = (data: unknown) => {
  const d = data as { instruments_library?: unknown; scan_depth?: unknown; state?: unknown } | null;
  if (!d || typeof d !== 'object') return null;
  return adopt({ instrumentsLibrary: d.instruments_library, scanDepth: d.scan_depth, state: d.state });
};

const toWire = (s: MidiSettings) => ({ instruments_library: s.instrumentsLibrary, scan_depth: s.scanDepth });

export const getMidiSettings = (): MidiSettings => current;

export const subscribeMidiSettings = (fn: () => void): (() => void) => {
  subs.add(fn);
  return () => { subs.delete(fn); };
};

/** 首次拉一次；之后同一页里谁再调都只等同一个 promise。 */
export const ensureMidiSettings = (): Promise<void> => {
  if (loading) return loading;
  loading = fetch('/api/midi_settings')
    .then(r => (r.ok ? r.json() : null))
    .then(data => {
      const next = fromWire(data);
      if (!next) return;                       // 路由不在 / 回了个空对象：保持默认，别覆盖
      current = next;
      emit();
    })
    .catch(() => { /* 拉不到就先用默认；用户改的时候还会再试一次 */ })
    .finally(() => { loading = null; });
  return loading;
};

/** 改一项。乐观写 + POST；后端把夹过的值回来时以它为准（失败就保持用户填的样子）。 */
export const patchMidiSettings = async (patch: Partial<Pick<MidiSettings, 'instrumentsLibrary' | 'scanDepth'>>): Promise<void> => {
  current = { ...current, ...patch };
  emit();
  try {
    const r = await fetch('/api/midi_settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toWire(current)),
    });
    const next = fromWire(r.ok ? await r.json() : null);
    if (!next) return;
    current = next;
    emit();
  } catch { /* 网络断 / 后端没起：界面留住用户填的值，下一次改动再写 */ }
};

export const useMidiSettings = (): MidiSettings => {
  const [value, setValue] = useState(current);
  useEffect(() => {
    const off = subscribeMidiSettings(() => setValue(current));
    void ensureMidiSettings();
    return off;
  }, []);
  return value;
};
