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
const clampInt = (v: unknown, lo: number, hi: number, d: number): number =>
  Math.min(hi, Math.max(lo, Math.round(num(v, d))));
/** 把一条总长按权重切段；最后一段吃掉舍入余量，各段之和恒等于总长。 */
const splitSpan = (total: number, weights: number[]): number[] => {
  const sum = weights.reduce((s, x) => s + x, 0);
  const out: number[] = [];
  let acc = 0;
  weights.forEach((w, i) => {
    const len = i === weights.length - 1 ? total - acc : Math.round(total * w / sum);
    out.push(len);
    acc += len;
  });
  return out;
};
const weightsOf = (v: unknown, n: number): number[] | null => {
  if (v == null) return Array(n).fill(1);
  const arr = Array.isArray(v) ? v.map(x => num(x, 0)) : [];
  return arr.length === n && arr.every(x => x > 0) ? arr : null;
};
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
    // 漫画格排版：一条调用摆出一整页分格(纸 + 每格一张空层 + 线稿层)。几何在这里算 ——
    // 页面只照矩形建层,边距/沟槽只有这一处算术;每格的图层 transform 用同一个页内矩形。
    case 'create_comic_layout': {
      const ui = getBlendUi();
      const pw = Math.round(num(a.w, ui.canvas.w));
      const ph = Math.round(num(a.h, ui.canvas.h));
      if (!(pw >= 8 && ph >= 8)) return fail('No canvas yet — pass w/h (or call set_canvas_size first).');
      if (pw > 8192 || ph > 8192) return fail('page out of range (8..8192 px per side)');
      // 与页面同一个像素上限（blend_node.html 的 MAX_CANVAS_PIXELS）：超了改尺寸会被静默拒绝，
      // 排版随后因尺寸对不上整条作废 —— 不如这里先把话说清楚。
      if (pw * ph > 40e6) return fail('page is over 40 megapixels — pick a smaller w/h');
      const ink = /^#[0-9a-fA-F]{6}$/.test(str(a.ink)) ? str(a.ink) : '#000000';
      const paperArg = str(a.paper);
      const paper = paperArg === 'none' ? '' : /^#[0-9a-fA-F]{6}$/.test(paperArg) ? paperArg : '#ffffff';
      const border = clampInt(a.border, 0, 40, 3);
      type Rect = { name: string; x: number; y: number; w: number; h: number };
      const rects: Rect[] = [];
      let grid = '';
      if (Array.isArray(a.panels) && a.panels.length) {
        a.panels.forEach((p, i) => {
          const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
          rects.push({
            name: str(o.name) || `Panel ${i + 1}`,
            x: Math.round(num(o.x)), y: Math.round(num(o.y)),
            w: Math.round(num(o.w)), h: Math.round(num(o.h)),
          });
        });
        if (rects.some(r => r.w < 8 || r.h < 8 || r.x < 0 || r.y < 0 || r.x + r.w > pw || r.y + r.h > ph)) {
          return fail('panels must be page rectangles in px — at least 8×8 and inside the page');
        }
        grid = 'custom panels';
      } else {
        const rows = clampInt(a.rows, 1, 12, 2);
        const cols = clampInt(a.cols, 1, 12, 2);
        const rowW = weightsOf(a.row_weights, rows);
        const colW = weightsOf(a.col_weights, cols);
        if (!rowW || !colW) return fail(`row_weights needs ${rows} positive numbers and col_weights ${cols}`);
        const short = Math.min(pw, ph);
        const margin = a.margin != null ? clampInt(a.margin, 0, Math.floor(short / 2), 0) : Math.max(8, Math.round(short * 0.04));
        const gutter = a.gutter != null ? clampInt(a.gutter, 0, Math.floor(short / 2), 0) : Math.max(6, Math.round(short * 0.03));
        const usableW = pw - 2 * margin - (cols - 1) * gutter;
        const usableH = ph - 2 * margin - (rows - 1) * gutter;
        if (usableW < 8 || usableH < 8) return fail('margin + gutter leave no room on the page');
        const colWidths = splitSpan(usableW, colW);
        const rowHeights = splitSpan(usableH, rowW);
        let y = margin;
        rowHeights.forEach(h => {
          let x = margin;
          colWidths.forEach(w => {
            rects.push({ name: `Panel ${rects.length + 1}`, x, y, w, h });
            x += w + gutter;
          });
          y += h + gutter;
        });
        grid = `${rows}×${cols} grid, margin ${margin}, gutter ${gutter}`;
      }
      if (ui.canvas.w !== pw || ui.canvas.h !== ph) ctx.uiSend('canvas-resize', { w: pw, h: ph });
      ctx.uiSend('panel-layout', {
        page: { w: pw, h: ph }, panels: rects, paper,
        frame: border > 0 ? { width: border, color: ink } : null,
      });
      const list = rects.slice(0, 24)
        .map(r => `${r.name} (${r.x},${r.y},${r.w}×${r.h})`).join('; ')
        + (rects.length > 24 ? `; …${rects.length - 24} more` : '');
      return sent(`${pw}×${ph} comic layout — ${grid}; ${rects.length} empty panel layer${rects.length === 1 ? '' : 's'}`
        + `${paper ? ` + paper ${paper}` : ''}${border > 0 ? ` + frame ${border}px ${ink}` : ''}. ${list}`);
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
