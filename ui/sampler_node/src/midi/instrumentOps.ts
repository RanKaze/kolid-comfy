// ── 把一件乐器装到一条轨上 ──────────────────────────────────────────────────────────────────
//
// 两条入口说的是同一件事：Assets 里双击一行（加一条新轨），和 agent 的
// `set_track_instrument`（有 track_id 就地换、没有就新加）。逻辑住在这里而不是各自抄一份 ——
// 中间那步"先 syncTracks 再 track_instrument"漏掉一次，后端就回 "no such track"：双击装不上、
// agent 也装不上，而且从界面上看不出是少推了一次表。
//
// 失败一律把工程里的路径撤回：留着一件装不上的乐器，轨道窗会显示它、每次推工程还会去重试。

import { nativeEngine } from './engine';
import { addTrack, type MidiProject, removeTrack, updateTrack } from './model';
import { requestSoundWindow } from './soundWindow';

/** 工具与面板都只需要这两样：读当前工程、走唯一写口。`MidiCtl` 天然满足。 */
export type MidiWrite = {
  project: MidiProject;
  update: (fn: (p: MidiProject) => MidiProject, label?: string) => void;
};

export type LoadInstrumentResult = {
  ok: boolean;
  trackId: string;
  /** 这条轨是这次新加的（轨名 = 乐器名）。 */
  created: boolean;
  path: string;
  kind: string;
  zones: number;
  failed: number;
  kb: number;
  /** 插件自报的类名（VST3），读不到就是空。 */
  name: string;
  error: string;
  /** 装的是插件本体 ⇒ 已替用户请求弹窗（挑音色）。 */
  editorRequested: boolean;
};

export const loadInstrumentOnTrack = async (
  midi: MidiWrite,
  opts: { path: string; trackId?: string; name?: string },
): Promise<LoadInstrumentResult> => {
  const path = String(opts.path || '');
  const label = opts.name?.trim() || 'instrument';
  const out: LoadInstrumentResult = {
    ok: false, trackId: '', created: false, path, kind: '', zones: 0, failed: 0, kb: 0,
    name: '', error: '', editorRequested: false,
  };
  if (!path) { out.error = 'no path'; return out; }
  const existing = opts.trackId ? midi.project.tracks.find(t => t.id === opts.trackId) : null;
  if (opts.trackId && !existing) { out.error = `no track ${opts.trackId}`; return out; }
  const prev = existing?.instrument || '';
  out.trackId = existing?.id || '';

  // 推整表要用**改完这一轨之后**的那份工程 —— update 的回调里把它记下来（和面板里一样）。
  const after = { p: midi.project };
  if (!existing) {
    midi.update(p => {
      const next = addTrack(p, label);
      out.trackId = next.selTrack;
      after.p = next;
      return next;
    }, `Add ${label}`);
    out.created = true;
  }
  midi.update(p => {
    const next = updateTrack(p, out.trackId, { instrument: path });
    after.p = next;
    return next;
  }, `Load ${label}`);

  // 新轨还压在 120ms 去抖里，后端此刻不认识这个 id —— 直接 track_instrument 会回
  // "no such track"。先整表推过去并等它认领。
  await nativeEngine.syncTracks(after.p);
  const inst = await nativeEngine.trackInstrument(out.trackId, path);
  out.kind = inst.kind || '';
  out.zones = inst.zones || 0;
  out.failed = inst.failed || 0;
  out.kb = inst.kb || 0;
  out.name = inst.name || '';
  if (inst.error) {
    // 没装上就别把这条路径留在工程里（换乐器时退回**原来那件**，它多半还在响）。
    // 这条轨是这趟新建的 → 整条撤掉：留一条装不上、也开不了音色窗的空轨，用户只会看到
    // 一串同名乐器（"库里的 HALion 条目双击全都加轨失败"就是这么堆出来的）。
    if (out.created) midi.update(p => removeTrack(p, out.trackId), `Add ${label}`);
    else midi.update(p => updateTrack(p, out.trackId, { instrument: prev }), `Load ${label}`);
    out.error = inst.error;
    return out;
  }
  out.ok = true;
  // 装的是插件本体（不是预设）：它自己没有给用户的音色，窗口该自己弹出来让人挑。
  if (/\.vst3$/i.test(path)) { requestSoundWindow(out.trackId); out.editorRequested = true; }
  return out;
};
