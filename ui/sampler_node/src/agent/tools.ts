import type { BlendDocCommand, BlendStack, BlendUiSend, BlockSet } from '../types';
import {
  type VidController, type VidClip, addLayerClip, addTrack, moveClip, placeAsset, removeClip,
  removeTrack, renameTrack, splitClip, trimClip,
} from '../workbench/video/model';
import { getVidSelection, setVidSelection } from '../workbench/video/selection';
import { getBlendUi } from '../workbench/store';

// ── Agent 工具的执行体(全部住在浏览器)────────────────────────────────────────────────────────
// schema 的唯一真源在 nodes/workbench/agent_backend.py 的 AGENT_TOOLS;这份文件按名字分发执行。
// 每个工具返回 `{ok, content}`:content 是交给 LLM 的文本结果 —— 精简、可读、说人话,别把整个
// 工程对象倒回去。ctx 每轮渲染由 EditPhase 重新组装,AgentPanel 经 ref 取最新的那份用。

export type AgentVgenEntry = {
  name: string; index: number; ports: Record<string, number>;
  fixed_fps: boolean; fixed_fps_value?: number; missing: string[]; ready: boolean;
};

/** data/sampler/agent_settings.json 的镜像。Settings 页不再有 Agent 屏 —— Agent 窗只读
 *  dsh_port / dsh_autostart(端口回退与自动启动);dsh_* 四项是 DeepSeek Harness sidecar
 *  (agent_dsh.py)的启动参数。base_url/api_key/model/temperature/max_steps/system_extra 属于
 *  已撤掉界面的内建 Chat 回路(agent_backend.py 仍保留它的 run 循环)。 */
export type AgentConfig = {
  base_url: string; api_key: string; model: string;
  temperature: number; max_steps: number; system_extra: string;
  dsh_port: number; dsh_command: string; dsh_api_key: string; dsh_autostart: boolean;
};

export type AgentCtx = {
  uiSend: BlendUiSend;
  vid: VidController;
  /** 有没有开着的文档(没开 = 时间线/图层工具都该报"no document")。 */
  docOpen: boolean;
  /** Agent 窗(dsh)的工作区 = 当前 cud 的所在目录;`''` = 没有 cud(绑仓库根),
   *  `null` = 工作台还没播报过文档,先别改绑。 */
  cudDir: string | null;
  vidMode: 'image' | 'video';
  blockSets: BlockSet[];
  activeBlockSetId: string;
  runPreset: (id: string) => void;
  cancelRun: () => void;
  docCommand: (action: BlendDocCommand) => void;
  setFps: (v: number) => void;
  vgen: {
    list: AgentVgenEntry[];
    add: (ifaceIndex: number) => void;
    cont: { name: string } | null;
    addContinue: (ifaceIndex: number) => void;
  };
};

const num = (v: unknown, d = 0): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : d;
};
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const clipShort = (c: VidClip) => ({
  id: c.id, track: c.trackId, kind: c.kind, name: c.name,
  start: r3(c.start), dur: r3(c.duration), offset: r3(c.offset), src_dur: r3(c.srcDuration),
  audio: c.hasAudio || undefined, layer_key: c.layerKey || undefined,
  group: c.groupId || undefined, busy: (c.pending || c.vgen) ? true : undefined,
});

export const getAgentAppState = (ctx: AgentCtx): string => {
  const p = ctx.vid.project;
  const ui = getBlendUi();
  const sel = getVidSelection();
  const stack = (rows: typeof ui.stacks.layers) => rows.map(r => ({
    id: r.id, name: r.name, kind: r.kind, visible: r.visible, opacity: r.opacity,
    has_img: r.hasImg, can_gen: r.canGen, selected: r.selected || undefined,
  }));
  const snap = {
    mode: ctx.vidMode,
    doc_open: ctx.docOpen,
    canvas: ui.canvas,
    fps: p.fps,
    transport: { time: r3(ctx.vid.transport.get()), playing: ctx.vid.playing },
    tracks: p.tracks.map(t => ({
      id: t.id, name: t.name, kind: t.kind,
      muted: ctx.vid.mute.has(t.id) || undefined,
      soloed: (ctx.vid.solo.audio.has(t.id) || ctx.vid.solo.video.has(t.id)) || undefined,
    })),
    clips: p.clips.map(clipShort),
    assets: p.assets.map(a => ({ id: a.id, name: a.name, kind: a.kind, duration: r3(a.duration) })),
    selection: [...sel],
    layers: stack(ui.stacks.layers),
    guidances: stack(ui.stacks.guidances),
    staging: ctx.vid.staging.filter(s => !s.hidden).map(s => ({ id: s.id, name: s.name, asset: s.asset || undefined })),
    history: { can_undo: ui.history.canUndo, can_redo: ui.history.canRedo, steps: ui.history.steps.length },
    brush: ui.tools.brush, color: ui.color.fg,
    presets: ctx.blockSets.map(s => ({ id: s.id, name: s.name, active: s.id === ctx.activeBlockSetId || undefined })),
    vgen: ctx.vgen.list.map(v => ({ index: v.index, name: v.name, ready: v.ready, missing: v.missing })),
    mask_track: p.maskTrackId || null,
  };
  return JSON.stringify(snap);
};

type ToolResult = { ok: boolean; content: string };
const sent = (what: string): ToolResult => ({ ok: true, content: `done: ${what}` });
const fail = (content: string): ToolResult => ({ ok: false, content });

export const runAgentTool = async (name: string, rawArgs: unknown, ctx: AgentCtx): Promise<ToolResult> => {
  const a = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  const vid = ctx.vid;
  const update = vid.update;
  const needDoc = (): ToolResult | null =>
    ctx.docOpen ? null : fail('No document open — ask the user to open/create a project first (New / Load).');

  switch (name) {
    case 'get_app_state':
      return { ok: true, content: getAgentAppState(ctx) };

    case 'seek': {
      const e = needDoc(); if (e) return e;
      vid.seek(Math.max(0, num(a.time)));
      return sent(`playhead at ${r3(vid.transport.get())}s`);
    }
    case 'play': {
      const e = needDoc(); if (e) return e;
      vid.setPlaying(true); return sent('playing');
    }
    case 'pause': {
      const e = needDoc(); if (e) return e;
      vid.setPlaying(false); return sent('paused');
    }
    case 'select_clips': {
      const e = needDoc(); if (e) return e;
      const ids = (Array.isArray(a.ids) ? a.ids : []).map(str).filter(id => vid.project.clips.some(c => c.id === id));
      setVidSelection(new Set(ids));
      if (ids.length === 1 && a.focus !== false) {
        const clip = vid.project.clips.find(c => c.id === ids[0]);
        if (clip && clip.kind === 'layer') vid.focusClip(clip);
      }
      return sent(ids.length ? `selected ${ids.length} clip(s)` : 'selection cleared');
    }
    case 'add_track': {
      const e = needDoc(); if (e) return e;
      const kind = str(a.kind) as 'video' | 'audio' | 'layer' | 'process';
      if (!['video', 'audio', 'layer', 'process'].includes(kind)) return fail('kind must be video|audio|layer|process');
      let added = '';
      update(p0 => {
        const p = addTrack(p0, kind);
        added = p.tracks[p.tracks.length - 1]?.id ?? '';
        return p;
      }, 'Add track (agent)');
      return sent(`added ${kind} track ${added}`);
    }
    case 'remove_track': {
      const e = needDoc(); if (e) return e;
      const id = str(a.track_id);
      update(p => removeTrack(p, id), 'Remove track (agent)');
      return sent(`removed track ${id}`);
    }
    case 'rename_track': {
      const e = needDoc(); if (e) return e;
      const id = str(a.track_id);
      update(p => renameTrack(p, id, str(a.name)), 'Rename track (agent)');
      return sent(`renamed track ${id}`);
    }
    case 'place_asset': {
      const e = needDoc(); if (e) return e;
      const asset = vid.project.assets.find(x => x.id === str(a.asset_id));
      if (!asset) return fail(`asset ${str(a.asset_id)} not in project assets`);
      update(p => placeAsset(p, asset, a.track_id ? str(a.track_id) : null, Math.max(0, num(a.time, vid.transport.get()))),
        'Place asset (agent)');
      return sent(`placed asset ${asset.name}`);
    }
    case 'move_clip': {
      const e = needDoc(); if (e) return e;
      const id = str(a.clip_id);
      update(p => moveClip(p, id, Math.max(0, num(a.start)), a.track_id ? str(a.track_id) : undefined, a.only_self !== true),
        'Move clip (agent)');
      return sent(`moved clip ${id}`);
    }
    case 'trim_clip': {
      const e = needDoc(); if (e) return e;
      const id = str(a.clip_id);
      update(p => trimClip(p, id, str(a.edge) === 'in' ? 'l' : 'r', num(a.time), a.only_self !== true),
        'Trim clip (agent)');
      return sent(`trimmed clip ${id}`);
    }
    case 'split_clip': {
      const e = needDoc(); if (e) return e;
      const id = str(a.clip_id);
      update(p => splitClip(p, id, num(a.time), a.only_self !== true), 'Split clip (agent)');
      return sent(`split clip ${id}`);
    }
    case 'remove_clips': {
      const e = needDoc(); if (e) return e;
      const ids = (Array.isArray(a.ids) ? a.ids : []).map(str);
      update(p => ids.reduce((acc, id) => removeClip(acc, id), p), 'Delete clip (agent)');
      setVidSelection(new Set());
      return sent(`removed ${ids.length} clip(s)`);
    }
    case 'add_layer_clip': {
      const e = needDoc(); if (e) return e;
      let clipId = '';
      update(p0 => {
        const trackId = a.track_id ? str(a.track_id)
          : (p0.tracks.find(t => t.kind === 'layer')?.id ?? null);
        if (trackId) {
          const p = addLayerClip(p0, trackId, Math.max(0, num(a.time, vid.transport.get())), Math.max(0.2, num(a.duration, 5)));
          clipId = p.clips[p.clips.length - 1]?.id ?? '';
          return p;
        }
        const withTrack = addTrack(p0, 'layer');
        const tid = withTrack.tracks[withTrack.tracks.length - 1].id;
        const p = addLayerClip(withTrack, tid, Math.max(0, num(a.time, vid.transport.get())), Math.max(0.2, num(a.duration, 5)));
        clipId = p.clips[p.clips.length - 1]?.id ?? '';
        return p;
      }, 'Add layer segment (agent)');
      return clipId ? sent(`created layer clip ${clipId}`) : fail('could not create layer clip');
    }
    case 'select_layer':
      ctx.uiSend('layer-select', { id: num(a.id), from: 'row' });
      return sent(`selected layer ${num(a.id)}`);
    case 'add_layer': {
      const stack = (str(a.stack) === 'guidance' ? 'guidance' : 'layer') as BlendStack;
      ctx.uiSend('layer-add', { stack, kind: str(a.kind) === 'stash' ? 'stash' : 'default' });
      return sent(`added layer on ${stack} stack`);
    }
    case 'remove_layer':
      ctx.uiSend('layer-remove', { id: num(a.id) });
      return sent(`removed layer ${num(a.id)}`);
    case 'duplicate_layer':
      ctx.uiSend('layer-duplicate', { id: num(a.id) });
      return sent(`duplicated layer ${num(a.id)}`);
    case 'rename_layer':
      ctx.uiSend('layer-rename', { id: num(a.id), name: str(a.name) });
      return sent('renamed layer');
    case 'set_layer_opacity':
      ctx.uiSend('layer-opacity', { id: num(a.id), opacity: Math.min(1, Math.max(0, num(a.opacity, 1))) });
      return sent('set layer opacity');
    case 'toggle_layer_visibility':
      ctx.uiSend('layer-eye', { id: num(a.id) });
      return sent('toggled layer eye');
    case 'layer_generate':
      ctx.uiSend('layer-generate', { id: num(a.id) });
      return sent(`layer ${num(a.id)} generate started (watch progress on the layer row / Log window)`);
    case 'layer_from_asset': {
      const hash = str(a.hash);
      ctx.uiSend('layer-from-asset', {
        url: `/api/asset_media/${hash}`, hash, name: a.name ? str(a.name) : undefined,
        stack: str(a.stack) === 'guidance' ? 'guidance' : 'layer',
      });
      return sent(`inserted asset ${hash.slice(0, 10)} as layer`);
    }
    case 'set_extra_prompt':
      ctx.uiSend('staging-prompt', str(a.text));
      return sent('set extra prompt');
    case 'run_blend':
      ctx.uiSend('staging-blend');
      return sent('Blend run started (progress in the canvas bottom bar / Log window)');
    case 'run_tag':
      ctx.uiSend('staging-tag');
      return sent('Tag run started');
    case 'run_pipeline': {
      const preset = (a.preset_id ? ctx.blockSets.find(s => s.id === str(a.preset_id)) : null)
        ?? ctx.blockSets.find(s => s.id === ctx.activeBlockSetId)
        ?? ctx.blockSets[0];
      if (!preset) return fail('no pipeline presets configured');
      ctx.runPreset(preset.id);
      return sent(`pipeline preset "${preset.name}" started (progress in the Run status segment / Log window)`);
    }
    case 'cancel_run':
      ctx.cancelRun();
      return sent('cancel requested');
    case 'set_canvas_size': {
      const w = Math.round(num(a.w)), h = Math.round(num(a.h));
      if (w < 8 || h < 8 || w > 8192 || h > 8192) return fail('canvas size out of range (8..8192)');
      ctx.uiSend('canvas-resize', { w, h });
      return sent(`canvas ${w}x${h}`);
    }
    case 'undo': ctx.uiSend('history-undo'); return sent('undo');
    case 'redo': ctx.uiSend('history-redo'); return sent('redo');
    case 'view_fit': ctx.uiSend('view-fit'); return sent('view fitted');
    case 'set_fps': {
      ctx.setFps(Math.round(num(a.fps, 30)));
      return sent('fps set');
    }
    case 'set_paint_color': {
      const fg = str(a.fg);
      if (!/^#[0-9a-fA-F]{6}$/.test(fg)) return fail('fg must be #rrggbb');
      ctx.uiSend('paint-color', fg);
      return sent(`color ${fg}`);
    }
    case 'set_brush': {
      if (a.size != null) ctx.uiSend('brush-size', Math.max(1, num(a.size, 40)));
      if (a.strength != null) ctx.uiSend('brush-strength', Math.min(1, Math.max(0, num(a.strength, 1))));
      return sent('brush configured');
    }
    case 'add_vgen_segment': {
      const e = needDoc(); if (e) return e;
      const idx = Math.round(num(a.interface_index, -1));
      const ent = ctx.vgen.list.find(v => v.index === idx);
      if (!ent || !ent.ready) return fail(`video-generator interface #${idx} missing or not ready`);
      ctx.vgen.add(idx);
      return sent(`Video Generator segment added for "${ent.name}" — its prompt card is open for the user`);
    }
    case 'add_continue_segment': {
      const e = needDoc(); if (e) return e;
      if (!ctx.vgen.cont) return fail('no single video segment selected on the timeline');
      const idx = Math.round(num(a.interface_index, -1));
      const ent = ctx.vgen.list.find(v => v.index === idx);
      if (!ent || !ent.ready) return fail(`video-generator interface #${idx} missing or not ready`);
      ctx.vgen.addContinue(idx);
      return sent(`continue segment added after "${ctx.vgen.cont.name}" for "${ent.name}"`);
    }
    case 'document': {
      const action = str(a.action);
      if (action !== 'new' && action !== 'save') return fail('action must be new|save');
      ctx.docCommand(action as 'new' | 'save');
      return action === 'save'
        ? sent('save requested (a native dialog opens when the project has no file yet)')
        : sent('new document requested');
    }
    default:
      return fail(`unknown tool "${name}"`);
  }
};
