// ── 音色窗的会话 ─────────────────────────────────────────────────────────────────────────────
//
// HALion / Kontakt 不提供"列音色"的接口，只能开它们自己的界面挑。窗口是 worker 进程里的
// 真系统窗口，页面这头只做三件事：开、等它被关掉、关掉时把状态存成 `.vstpreset` 并挂回这一轨。
//
// **会话为什么住在这里，而不是轨道窗里**：轨道窗只在 MIDI 模式挂载，而"双击乐器 → 加轨 →
// 弹窗"是在 Assets（任何模式都开着）里发生的。会话放在模块里，两处都能发起，切模式也不丢；
// 只有"往工程里写哪条轨"要问宿主（useMidiHost 一直挂着，见 setEditorHost）。
//
// 一个**列表**不是单个：每条轨的实例在自己的 worker 里，它们各自的窗口可以同时开着。
// 只记一个的话，先开的那扇关掉时没人轮询，挑好的音色就丢了。

import { nativeEngine } from './engine';
import { reloadInstruments } from './library';
import { type MidiProject, updateTrack } from './model';
import { ensureMidiSettings } from './settings';

export type EditorTone = 'info' | 'error';

export type EditorState = {
  /** 窗口还开着的轨。轨道窗据此点亮 Edit。 */
  open: string[];
  /** 正在开/存的那条轨（按钮置灰，防连点）。 */
  busy: string;
  /** 最近一句回话（开不出来、存不下来、存好了）。 */
  note: { text: string; tone: EditorTone } | null;
};

/** 宿主给的四件东西：读**当前这份**工程、走唯一写口改它、按文档取轨、按文档写。
 *  后两件是给"存盘时收别处的音色窗"用的（见 flushEditorSaves）。 */
type Host = {
  getProject: () => MidiProject;
  update: (fn: (p: MidiProject) => MidiProject, label?: string) => void;
  /** 某份文档的轨（不必是屏幕上这份）。 */
  tracksOf: (uid: number) => { id: string; name: string }[];
  /** 写某份文档（不必是屏幕上这份）。 */
  updateIn: (uid: number, fn: (p: MidiProject) => MidiProject, label?: string) => void;
  /** 这条轨住哪份文档；null = 还没有归属。 */
  docOf: (trackId: string) => number | null;
  /** 置脏（tab 上的 ●、关前询问）：开窗本身就意味着"这一轨的声音要变了"。 */
  dirty: (uid: number) => void;
};

let host: Host | null = null;
let state: EditorState = { open: [], busy: '', note: null };
const subs = new Set<() => void>();
let pending: string[] = [];
let noteTimer: number | null = null;
let pollTimer: number | null = null;
let ticking = false;
/** 正在关/存的那几条轨。轮询与工具可能同时看到"关掉了"，这一层挡住第二次存盘
 *  （存两次会往预设库里多落一份同样的音色）。 */
const closing = new Set<string>();

const emit = (): void => {
  for (const fn of subs) { try { fn(); } catch { /* 一扇窗坏了不拖累别的 */ } }
};
const patch = (p: Partial<EditorState>): void => { state = { ...state, ...p }; emit(); };

export const editorState = (): EditorState => state;

/** 订阅会话状态（轨道窗的 Edit 高亮、底栏回话都读它）。 */
export const subscribeEditor = (fn: () => void): (() => void) => {
  subs.add(fn);
  return () => { subs.delete(fn); };
};

const say = (text: string, tone: EditorTone = 'info'): void => {
  patch({ note: { text, tone } });
  if (noteTimer !== null) window.clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => { noteTimer = null; patch({ note: null }); },
    tone === 'error' ? 9000 : 5000);
};

/** 宿主（useMidiHost）挂上来。挂上那一拍把等着开窗的请求交出去。 */
export const setEditorHost = (h: Host | null): void => {
  host = h;
  if (!h) return;
  const ids = pending;
  pending = [];
  for (const id of ids) void openSoundWindow(id);
};

/** 请求给这条轨开音色窗（双击乐器库里一件插件本体时用）。
 *  宿主还没挂上就先排队 —— 别把请求丢了，也别在没人接的时候假装开过。 */
export const requestSoundWindow = (track: string): void => {
  if (!track || pending.includes(track)) return;
  if (!host) { pending = pending.concat(track); return; }
  void openSoundWindow(track);
};

/** 开这一轨的插件窗口。窗口关掉前一直轮询；关掉那一刻存音色、改工程字段、刷新乐器库。 */
export const openSoundWindow = async (trackId: string): Promise<void> => {
  if (!host || state.busy) return;
  const tr = host.getProject().tracks.find(x => x.id === trackId);
  if (!tr?.instrument) return;
  const project = host.getProject();
  patch({ busy: trackId });
  try {
    // 引擎那头可能还不认识这条轨（刚加的那一帧工程还没推过去）—— 先把整表推过去并等后端
    // 认领。少了这一步，`track_instrument` 会得到 "no such track"，双击乐器就永远装不上。
    // 引擎里那件失败/不是工程里这一件时也走这条路：先把要开的那件真的装上，再开窗。
    const want = tr.instrument.replace(/\\/g, '/').toLowerCase();
    const cur = (nativeEngine.getStatus().instruments || []).find(r => r.track === trackId);
    if (!cur || cur.open === false || String(cur.path || '').replace(/\\/g, '/').toLowerCase() !== want) {
      await nativeEngine.syncTracks(project);
      const loaded = await nativeEngine.trackInstrument(trackId, tr.instrument);
      if (loaded.error) {
        say('Could not load this instrument: ' + loaded.error, 'error');
        return;
      }
    }
    const r = await nativeEngine.openTrackEditor(trackId);
    if (!r.ok) {
      // 自己就没有窗口的插件（Ample 那批构建）不是故障，别用红字吓人。
      const noWindow = /does not offer an editor view/.test(r.error);
      say(noWindow
        ? 'This plug-in has no window of its own — there is nothing to pick here.'
        : 'Could not open the plug-in window: ' + (r.error || 'unknown error'),
        noWindow ? 'info' : 'error');
      return;
    }
    if (!state.open.includes(trackId)) patch({ open: state.open.concat(trackId) });
    // 打上"这份文档变了"的标记：挑完音色不关窗、也不点保存就走（关程序/换 tab）时，
    // 至少会让工作台在关前问一句 —— 那一趟的保存会把窗口里此刻的声音收进去（flushEditorSaves）。
    const uid = host.docOf(trackId);
    if (uid != null) host.dirty(uid);
    startPolling();
  } finally {
    patch({ busy: '' });
  }
};

const startPolling = (): void => {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => { void tick(); }, 500);
};

const tick = async (): Promise<void> => {
  if (ticking) return;
  ticking = true;
  try {
    for (const id of state.open.slice()) {
      const st = await nativeEngine.trackEditorState(id);
      if (st.ok && st.open) continue;
      patch({ open: state.open.filter(x => x !== id) });
      if (!st.ok) say(st.error || 'The plug-in window is gone', 'error');
      else void finishEdit(id);
    }
  } finally {
    ticking = false;
  }
  if (!state.open.length && pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
};

export type SaveEditorResult = {
  ok: boolean;
  path: string;
  name: string;
  kb: number;
  error: string;
};

/** 窗口关掉了：存音色 → 把这一轨的乐器换成那份预设 → 刷新乐器库。 */
const finishEdit = async (id: string): Promise<SaveEditorResult> => {
  const out: SaveEditorResult = { ok: false, path: '', name: '', kb: 0, error: '' };
  if (!host) { out.error = 'no MIDI host'; return out; }
  if (closing.has(id)) { out.error = 'this sound is already being saved'; return out; }
  closing.add(id);
  const tr = host.getProject().tracks.find(x => x.id === id);
  patch({ busy: id });
  try {
    const r = await nativeEngine.saveTrackEditor(id, tr?.name || '');
    out.path = r.path;
    out.name = r.name;
    out.kb = r.kb;
    if (!r.ok) {
      out.error = r.error || 'unknown error';
      say('Could not save this sound: ' + out.error, 'error');
      return out;
    }
    out.ok = true;
    // 引擎那头已经把这一槽的乐器指到新预设上（不重载实例），工程字段跟着写才对得上。
    // 写**这条轨住的那份**文档：开窗期间用户可能已经切走了，只写屏幕上这份就会把它丢掉。
    const put = (p: MidiProject) =>
      (p.tracks.some(t => t.id === id) ? updateTrack(p, id, { instrument: r.path }) : p);
    const uid = host.docOf(id);
    if (uid != null) host.updateIn(uid, put, 'Save sound');
    else host.update(put, 'Save sound');
    void ensureMidiSettings().then(() => void reloadInstruments(true));
    say(`Saved "${r.name}" into the instrument library` + (r.warning ? ' — ' + r.warning : ''));
    return out;
  } finally {
    closing.delete(id);
    patch({ busy: '' });
  }
};

/**
 * 存盘前把**这一份文档**里还开着的音色窗收一次：把窗口里此刻的声音存成 `.vstpreset`，
 * 新路径写回那条轨。**不关窗、不打断试听**。
 *
 * 为什么存盘要管这件事：把音色挂回轨道这一步原本只发生在"关窗"那一刻（finishEdit）——
 * 用户挑好音色、但没关窗就点了保存，文件里留下的还是上一次的路径，重开就是另一副声音。
 * 返回收了几条（失败的不算，回话由 say 负责）。
 */
export const flushEditorSaves = async (uid: number): Promise<number> => {
  if (!host) return 0;
  let saved = 0;
  for (const t of host.tracksOf(uid)) {
    if (!state.open.includes(t.id) || closing.has(t.id)) continue;
    closing.add(t.id);
    try {
      const r = await nativeEngine.saveTrackEditor(t.id, t.name);
      if (!r.ok) { say('Could not save this sound: ' + (r.error || 'unknown error'), 'error'); continue; }
      const id = t.id, path = r.path;
      host.updateIn(uid, p => (p.tracks.some(x => x.id === id)
        ? updateTrack(p, id, { instrument: path }) : p), 'Save sound');
      saved++;
    } catch (e) {
      say('Could not save this sound: ' + String(e), 'error');
    } finally {
      closing.delete(t.id);
    }
  }
  return saved;
};

export type CloseEditorResult = SaveEditorResult & {
  /** 窗口本来就已经关着（用户自己点过 X）。这时不重复存盘。 */
  alreadyClosed: boolean;
};

/**
 * 关掉这条轨的插件窗口。默认**照用户点 X 那条路**把声音存成 `.vstpreset` 并挂回这一轨；
 * `save:false` 只关不存（卸乐器前用 —— 那份声音没有留下的意义）。
 *
 * 窗口已经关着时不重复存盘：轮询多半已经存过了，再存一份会往预设库里多落一个同样的音色。
 */
export const closeSoundWindow = async (
  trackId: string, opts: { save?: boolean } = {},
): Promise<CloseEditorResult> => {
  const out: CloseEditorResult = { ok: false, alreadyClosed: false, path: '', name: '', kb: 0, error: '' };
  if (!trackId) { out.error = 'no track id'; return out; }
  if (state.busy) { out.error = 'another window action is still running'; return out; }
  patch({ busy: trackId });
  try {
    const st = await nativeEngine.trackEditorState(trackId);
    if (!st.ok) { out.error = st.error || 'could not read the plug-in window state'; return out; }
    if (!st.open) {
      out.ok = true;
      out.alreadyClosed = true;
      patch({ open: state.open.filter(x => x !== trackId) });
      return out;
    }
    const r = await nativeEngine.closeTrackEditor(trackId);
    if (!r.ok) {
      out.error = r.error || 'the plug-in window did not close';
      say('Could not close the plug-in window: ' + out.error, 'error');
      return out;
    }
    patch({ open: state.open.filter(x => x !== trackId) });
    out.ok = true;
    if (opts.save === false) return out;
    const saved = await finishEdit(trackId);
    return { ...saved, alreadyClosed: false, error: saved.error };
  } finally {
    patch({ busy: '' });
  }
};
