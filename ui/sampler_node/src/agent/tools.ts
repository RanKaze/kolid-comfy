import type { BlendDocCommand, BlendStack, BlendUiSend, BlockSet } from '../types';
import {
  type VidController, type VidClip, addLayerClip, addTrack, moveClip, placeAsset, removeClip,
  removeTrack, renameTrack, splitClip, trimClip, moveTrack, setMaskTrack, toggleVgenChain,
} from '../workbench/video/model';
import { getVidSelection, setVidSelection } from '../workbench/video/selection';
import { getBlendUi } from '../workbench/store';
import { pulseForTool } from '../workbench/surfaces';
import { UI_ACTIONS, UI_ACTION_IDS } from './uiActions.generated';
import { AGENT_TOOL_NAMES, type AgentToolName } from './toolSchemas';

// ── Agent 工具的执行体(全部住在浏览器)────────────────────────────────────────────────────────
// 工具面的唯一真源是同目录的 `toolSchemas.ts`(名字/说明/参数表);这份文件按名字分发执行。
// 两者靠**类型**咬合,不靠事后对账:
//   · 有 schema 没写分支 ⇒ 下面 switch 的 default 里 `const missing: never` 编译报错;
//   · 写了分支但 schema 没登记 ⇒ `case` 与 `AgentToolName` 无重叠,TS2367 编译报错。
// 于是"某次之后漏写"不可能发生 —— 加工具必须先加 schema 再写分支,两半缺一 build 就红。
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
  /** 活跃文档的 uid（`close` 这类"按文档"的命令要它；页面按 uid 找文档，传 null 什么也不会发生）。 */
  docUid: number | null;
  /** Agent 窗(dsh)的工作区 = 当前 cud 的所在目录;`''` = 没有 cud(绑仓库根),
   *  `null` = 工作台还没播报过文档,先别改绑。 */
  cudDir: string | null;
  vidMode: 'image' | 'video';
  blockSets: BlockSet[];
  activeBlockSetId: string;
  runPreset: (id: string) => void;
  cancelRun: () => void;
  docCommand: (action: BlendDocCommand, uid?: number) => void;
  setFps: (v: number) => void;
  vgen: {
    list: AgentVgenEntry[];
    add: (ifaceIndex: number) => void;
    cont: { name: string } | null;
    addContinue: (ifaceIndex: number) => void;
  };
  /** 把一次 Prompt tab 的读写请求转成跨源 postMessage 发给 prompt_node iframe,等它回
   *  `agent-prompt-result`。iframe 没挂载 / 没加载 → 返回 {ok:false,error}。 */
  promptBridge: (type: string, payload?: unknown) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
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

const TOOL_NAME_SET: ReadonlySet<string> = new Set(AGENT_TOOL_NAMES);

export const runAgentTool = async (name: string, rawArgs: unknown, ctx: AgentCtx): Promise<ToolResult> => {
  const a = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  const vid = ctx.vid;
  const update = vid.update;
  const needDoc = (): ToolResult | null =>
    ctx.docOpen ? null : fail('No document open — ask the user to open/create a project first (New / Load).');

  // 名字不在 toolSchemas.ts 里就不往下走:页面拿到不认识的工具名什么也不会发生,
  // 不挡就等于让模型以为做了(通常是工具表刚变、宿主还是旧包)。
  if (!TOOL_NAME_SET.has(name))
    return fail(`unknown tool "${name}" — the workbench page is probably running an older build; `
      + `reload it and retry. (page knows ${AGENT_TOOL_NAMES.length} tools, e.g. `
      + `${AGENT_TOOL_NAMES.slice(0, 6).join(', ')}…)`);

  const tool = name as AgentToolName;
  // 亮一下这扇窗：让用户看见 agent 正在动这里。纯提示 —— 不改状态、不进历史，
  // 目标面板由 workbench/surfaces.ts 从工具名/动作键算出来。
  pulseForTool(tool, a, ctx.docUid);
  switch (tool) {
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
      ctx.uiSend('layer-add', { stack, kind: 'default' });
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
      const action = str(a.action) as BlendDocCommand;
      const ALLOWED: BlendDocCommand[] = ['new', 'load', 'save', 'save-as', 'export-png', 'import', 'close'];
      if (!ALLOWED.includes(action))
        return fail(`action must be one of ${ALLOWED.join('|')}`);
      // close 是按文档的：页面 closeDocument(uid) 找不到 uid 就静默返回 false —— 不带 uid 等于没按。
      if (action === 'close') {
        if (ctx.docUid === null || ctx.docUid === undefined)
          return fail('no active document to close');
        ctx.docCommand('close', ctx.docUid);
        return sent(`closed document ${ctx.docUid}`);
      }
      ctx.docCommand(action);
      // 三条会弹原生对话框（load / save-as / import）：工具不替用户按下确认，如实说"对话框已开"。
      const dialog = action === 'load' || action === 'save-as' || action === 'import';
      return sent(dialog
        ? `${action}: the native file dialog is open — the user picks the file; ask them to confirm when done`
        : `${action} done`);
    }
    // ── Prompt tab 读写(iframe 里的 prompt_node)── 经 promptBridge 跨源收发,详情见 tools.ts 顶部。
    case 'get_prompt_state': {
      const r = await ctx.promptBridge('agent-prompt-get');
      if (!r.ok) return fail(r.error || 'prompt tab did not respond');
      const v = (r.value || {}) as any;
      const lines: string[] = [];
      lines.push('custom_prompt: ' + (v.custom_prompt || '(empty)'));
      lines.push('prompts(' + (v.prompts?.length || 0) + '): ' + (v.prompts || []).map((p: any) => p.id ? `[${p.id}] ${p.text}` : p.text).join(' | '));
      lines.push('loras(' + (v.loras?.length || 0) + '): ' + (v.loras || []).map((l: any) => `${l.name} @${l.strength}${l.active ? '' : ' [off]'}`).join(' | '));
      lines.push('prefabs(' + (v.prefabs?.length || 0) + '): ' + (v.prefabs || []).map((p: any) => `${p.name || p.guid}${p.active ? '' : ' [off]'}`).join(' | '));
      lines.push('programs(' + (v.programs?.length || 0) + '): ' + (v.programs || []).map((p: any) => `${p.name || p.id}${p.active ? '' : ' [off]'}`).join(' | '));
      return { ok: true, content: lines.join('\n') };
    }
    case 'prompt_library': {
      const cat = a.category ? str(a.category) : undefined;
      const r = await ctx.promptBridge('agent-prompt-library', cat ? { category: cat } : {});
      if (!r.ok) return fail(r.error || 'prompt tab did not respond');
      const v = (r.value || {}) as any;
      const cats = v.categories || {};
      const lines: string[] = [];
      for (const [c, ps] of Object.entries(cats) as [string, any[]][]) {
        lines.push(`# ${c} (${ps.length})`);
        for (const p of ps) lines.push(`  - ${p.id} | ${p.name} | ${p.prompt}`);
      }
      return { ok: true, content: lines.length ? lines.join('\n') : 'library empty' };
    }
    case 'lora_library': {
      const r = await ctx.promptBridge('agent-prompt-lora-library');
      if (!r.ok) return fail(r.error || 'prompt tab did not respond');
      const v = (r.value || {}) as any;
      const loras = v.loras || [];
      const lines = loras.map((l: any) => `${l.file_path} | ${l.name}${(l.tags?.length) ? ' [' + l.tags.join(',') + ']' : ''}`);
      return { ok: true, content: `loras(${loras.length}):\n` + (lines.length ? lines.join('\n') : '(none)') };
    }
    case 'prefab_library': {
      const r = await ctx.promptBridge('agent-prompt-prefab-library');
      if (!r.ok) return fail(r.error || 'prompt tab did not respond');
      const v = (r.value || {}) as any;
      const prefabs = v.prefabs || [];
      const lines = prefabs.map((p: any) => `${p.guid} | ${p.name || '(unnamed)'}`);
      return { ok: true, content: `prefabs(${prefabs.length}):\n` + (lines.length ? lines.join('\n') : '(none)') };
    }
    case 'program_library': {
      const r = await ctx.promptBridge('agent-prompt-program-library');
      if (!r.ok) return fail(r.error || 'prompt tab did not respond');
      const v = (r.value || {}) as any;
      const programs = v.programs || [];
      const lines = programs.map((p: any) => `${p.id} | ${p.name || '(unnamed)'}`);
      return { ok: true, content: `programs(${programs.length}):\n` + (lines.length ? lines.join('\n') : '(none)') };
    }
    // ── Prefab 库增删改（guid 引用，后端经 library+index 定位）──
    case 'prefab_add': {
      const r = await ctx.promptBridge('agent-prompt-prefab-add', {
        library: str(a.library), name: str(a.name),
        tag_groups: a.tag_groups, loras: a.loras,
        custom_prompts: a.custom_prompts, selected_prefabs: a.selected_prefabs, image: a.image,
      });
      if (!r.ok) return fail(r.error || 'prompt tab did not respond');
      const v = (r.value || {}) as any;
      return { ok: true, content: `prefab added guid=${v.guid} in library "${a.library}"` };
    }
    case 'prefab_update': {
      const body: any = { guid: str(a.guid) };
      if (a.name !== undefined) body.name = str(a.name);
      if (a.tag_groups !== undefined) body.tag_groups = a.tag_groups;
      if (a.loras !== undefined) body.loras = a.loras;
      if (a.custom_prompts !== undefined) body.custom_prompts = a.custom_prompts;
      if (a.selected_prefabs !== undefined) body.selected_prefabs = a.selected_prefabs;
      if (a.image !== undefined) body.image = a.image;
      const r = await ctx.promptBridge('agent-prompt-prefab-update', body);
      if (!r.ok) return fail(r.error || 'prompt tab did not respond');
      return { ok: true, content: 'prefab updated' };
    }
    case 'prefab_delete': {
      const r = await ctx.promptBridge('agent-prompt-prefab-delete', { guid: str(a.guid) });
      if (!r.ok) return fail(r.error || 'prompt tab did not respond');
      return { ok: true, content: 'prefab deleted' };
    }
    // ── Program 库增删改（id 引用）──
    case 'program_add': {
      const body: any = { name: str(a.name) };
      for (const k of ['code', 'category', 'image', 'video', 'selected_programs', 'enable_prefab_context', 'enable_lora_context', 'enable_tag_context', 'context_prefab_guids', 'context_lora_paths', 'context_tag_texts', 'multi_program', 'prefab_builtin_guids', 'lora_builtin_paths', 'tag_group_builtin_texts', 'prefab_builtin_inactive', 'lora_builtin_inactive', 'tag_group_builtin_inactive', 'prefab_builtin_display', 'lora_builtin_display', 'tag_group_builtin_display']) {
        if (a[k] !== undefined) body[k] = a[k];
      }
      const r = await ctx.promptBridge('agent-prompt-program-add', body);
      if (!r.ok) return fail(r.error || 'prompt tab did not respond');
      const v = (r.value || {}) as any;
      return { ok: true, content: `program added id=${v.id}` };
    }
    case 'program_update': {
      const body: any = { id: str(a.id) };
      for (const k of ['name', 'code', 'image', 'video', 'selected_programs', 'enable_prefab_context', 'enable_lora_context', 'enable_tag_context', 'context_prefab_guids', 'context_lora_paths', 'context_tag_texts', 'multi_program', 'prefab_builtin_guids', 'lora_builtin_paths', 'tag_group_builtin_texts', 'prefab_builtin_inactive', 'lora_builtin_inactive', 'tag_group_builtin_inactive', 'prefab_builtin_display', 'lora_builtin_display', 'tag_group_builtin_display']) {
        if (a[k] !== undefined) body[k] = a[k];
      }
      const r = await ctx.promptBridge('agent-prompt-program-update', body);
      if (!r.ok) return fail(r.error || 'prompt tab did not respond');
      return { ok: true, content: 'program updated' };
    }
    case 'program_delete': {
      const r = await ctx.promptBridge('agent-prompt-program-delete', { id: str(a.id) });
      if (!r.ok) return fail(r.error || 'prompt tab did not respond');
      return { ok: true, content: 'program deleted' };
    }
    // ── LoRA：刷新 + 编辑滑块配置（无增删，文件型）──
    case 'lora_refresh': {
      const r = await ctx.promptBridge('agent-prompt-lora-refresh');
      if (!r.ok) return fail(r.error || 'prompt tab did not respond');
      const v = (r.value || {}) as any;
      return { ok: true, content: `lora list refreshed (count=${v.lora_count ?? '?'})` };
    }
    case 'lora_update': {
      const body: any = {};
      if (a.file_path !== undefined) body.file_path = str(a.file_path);
      if (a.fingerprint !== undefined) body.fingerprint = str(a.fingerprint);
      if (a.model_only !== undefined) body.model_only = a.model_only;
      const r = await ctx.promptBridge('agent-prompt-lora-update', body);
      if (!r.ok) return fail(r.error || 'prompt tab did not respond');
      return { ok: true, content: `lora slider config updated (model_only=${a.model_only})` };
    }
    case 'set_prompt': {
      const patch: any = {};
      if (a.custom_prompt !== undefined) patch.custom_prompt = str(a.custom_prompt);
      if (a.prompt_mode !== undefined) patch.prompt_mode = str(a.prompt_mode);
      if (a.prompts !== undefined) patch.prompts = a.prompts;
      if (a.loras !== undefined) patch.loras = a.loras;
      if (a.prefabs !== undefined) patch.prefabs = a.prefabs;
      if (a.programs !== undefined) patch.programs = a.programs;
      const r = await ctx.promptBridge('agent-prompt-set', patch);
      if (!r.ok) return fail(r.error || 'prompt tab did not respond');
      const v = (r.value || {}) as any;
      const changed = Object.entries(v.changed || {}).filter(([, x]) => x).map(([k]) => k).join(', ');
      let msg = 'prompt updated' + (changed ? ` (${changed})` : '');
      if ((v.warnings || []).length) msg += '; warnings: ' + (v.warnings as string[]).join('; ');
      return { ok: true, content: msg };
    }
    case 'prompt_card_add': {
      const r = await ctx.promptBridge('agent-prompt-card-add', {
        category: str(a.category), name: str(a.name), prompt: str(a.prompt),
        tags: a.tags, natural: a.natural,
      });
      if (!r.ok) return fail(r.error || 'prompt tab did not respond');
      const v = (r.value || {}) as any;
      return { ok: true, content: `prompt card added id=${v.id}` };
    }
    case 'prompt_card_update': {
      const body: any = { id: str(a.id) };
      if (a.name !== undefined) body.name = str(a.name);
      if (a.prompt !== undefined) body.prompt = str(a.prompt);
      if (a.category !== undefined) body.category = str(a.category);
      if (a.tags !== undefined) body.tags = a.tags;
      if (a.natural !== undefined) body.natural = a.natural;
      const r = await ctx.promptBridge('agent-prompt-card-update', body);
      if (!r.ok) return fail(r.error || 'prompt tab did not respond');
      return { ok: true, content: 'prompt card updated' };
    }
    case 'prompt_card_delete': {
      const r = await ctx.promptBridge('agent-prompt-card-delete', { id: str(a.id) });
      if (!r.ok) return fail(r.error || 'prompt tab did not respond');
      return { ok: true, content: 'prompt card deleted' };
    }

    // ── 时间线面板上那些"不是按钮"的操作 ────────────────────────────────────────────
    case 'set_timeline_zoom': {
      const e = needDoc(); if (e) return e;
      const pps = Math.max(5, Math.min(600, num(a.pps, 60)));
      vid.setPps(pps);
      return sent(`timeline zoom ${r3(pps)} px/s`);
    }
    case 'toggle_track_mute': {
      const e = needDoc(); if (e) return e;
      const id = str(a.track_id);
      const tr = vid.project.tracks.find(t => t.id === id);
      if (!tr) return fail(`no track ${id}`);
      vid.toggleMute(id);
      return sent(`${vid.mute.has(id) ? 'muted' : 'unmuted'} ${tr.kind} track ${tr.name || id}`);
    }
    case 'toggle_track_solo': {
      const e = needDoc(); if (e) return e;
      const id = str(a.track_id);
      const tr = vid.project.tracks.find(t => t.id === id);
      if (!tr) return fail(`no track ${id}`);
      if (tr.kind === 'layer') return fail('layer tracks do not take solo');
      vid.toggleSolo(id, tr.kind);
      const on = tr.kind === 'audio' ? vid.solo.audio.has(id) : vid.solo.video.has(id);
      return sent(`solo ${on ? 'on' : 'off'} for ${tr.kind} track ${tr.name || id}`);
    }
    case 'move_track': {
      const e = needDoc(); if (e) return e;
      const id = str(a.track_id);
      if (!vid.project.tracks.some(t => t.id === id)) return fail(`no track ${id}`);
      const to = clampInt(a.to, 0, Math.max(0, vid.project.tracks.length - 1), 0);
      update(p => moveTrack(p, id, to), 'Move track (agent)');
      return sent(`track ${id} → index ${to}`);
    }
    case 'set_mask_track': {
      const e = needDoc(); if (e) return e;
      const id = a.track_id === null || a.track_id === undefined ? null : str(a.track_id);
      if (id === null) { update(p => setMaskTrack(p, null), 'Clear mask track (agent)'); return sent('mask track cleared'); }
      const tr = vid.project.tracks.find(t => t.id === id && t.kind === 'video');
      if (!tr) return fail(`no video track ${id} (mask binds to a video track only)`);
      update(p => setMaskTrack(p, id), 'Set mask track (agent)');
      return sent(`mask track = ${tr.name || id}`);
    }
    case 'toggle_vgen_chain': {
      const e = needDoc(); if (e) return e;
      const prevId = str(a.prev_clip_id), nextId = str(a.next_clip_id);
      const prev = vid.project.clips.find(c => c.id === prevId);
      const next = vid.project.clips.find(c => c.id === nextId);
      if (!prev || !next) return fail(`no clip ${!prev ? prevId : nextId}`);
      const linked = next.vgen?.chainPrev === prevId;
      if (!linked) {
        // 不成立的接缝在原函数里是**静默不动**的，先自己检查一遍，把话说清楚。
        if (!prev.vgen || !next.vgen) return fail('both clips must be Video Generator segments');
        if (!next.vgen.ports.first_frame) return fail(`${nextId} does not bind the first-frame port`);
        if (prev.trackId !== next.trackId) return fail('the two segments are on different tracks');
        if (Math.abs(prev.start + prev.duration - next.start) > 0.001)
          return fail('not a seam: the first segment must end exactly where the second starts');
      }
      update(p => toggleVgenChain(p, prevId, nextId), 'Link generator segments (agent)');
      return sent(linked ? `unlinked ${nextId} from ${prevId}` : `linked ${nextId} ← ${prevId}`);
    }

    // ── 界面动作键：把"用户能按的"整张表交出去 ──────────────────────────────────────
    // 目录来自 uiActions.generated.ts（由 types.ts 的 BlendUiAction/BlendUiPayloads 生成），
    // 所以界面加一个按钮、这里就多一条，中间没有手抄的一步。
    case 'get_ui_actions': {
      const group = str(a.group).trim();
      const q = str(a.q).trim().toLowerCase();
      let rows = UI_ACTIONS;
      if (group) {
        const pre = group.endsWith('-') ? group : group + '-';
        rows = rows.filter(r => r.action === group || r.action.startsWith(pre));
      }
      if (q) rows = rows.filter(r => (r.action + ' ' + r.doc).toLowerCase().includes(q));
      if (!rows.length) return fail(`no action matches${group ? ` group="${group}"` : ''}${q ? ` q="${q}"` : ''}`);
      const line = (r: typeof rows[number]) => r.action + `  [${r.kind}]`
        + (r.payload === 'undefined' ? '' : `  value: ${r.payload}`)
        + (r.doc ? `  — ${r.doc}` : '');
      const head = `${rows.length}/${UI_ACTIONS.length} action key(s)`
        + (group || q ? '' : `; groups: ${[...new Set(UI_ACTIONS.map(r => r.action.split('-')[0]))].sort().join(' ')}`)
        + '. Fire them with ui_action.';
      return { ok: true, content: head + '\n' + rows.map(line).join('\n') };
    }
    case 'ui_action': {
      const action = str(a.action).trim();
      if (!UI_ACTION_IDS.has(action)) {
        // 拼错的键在页面上是**静默不动**的（消息没人接），挡在这里比让 agent 以为按了要好。
        const near = UI_ACTIONS.map(r => r.action)
          .filter(k => k.startsWith(action.split('-')[0]) || action.startsWith(k.split('-')[0]))
          .slice(0, 10);
        return fail(`unknown ui action "${action}" (the page would silently ignore it). `
          + (near.length ? `near: ${near.join(', ')}` : 'call get_ui_actions to list the keys'));
      }
      const info = UI_ACTIONS.find(r => r.action === action)!;
      const has = a.value !== undefined && a.value !== null;
      if (info.kind !== 'none' && !has) {
        return fail(`${action} needs a value — payload type: ${info.payload}. `
          + (info.doc ? `${info.doc}. ` : '') + 'call get_ui_actions for the fields.');
      }
      // uiSend 的类型是"键 → 载荷"的映射；这里键是运行时字符串，形状已由目录校验过。
      (ctx.uiSend as (act: string, value?: unknown) => void)(action, has ? a.value : undefined);
      return sent(`${action}${has ? ' ' + JSON.stringify(a.value).slice(0, 200) : ''}`);
    }
    default: {
      // 走到这里说明 toolSchemas.ts 登记了一个没有执行体的工具。`missing` 必须是 never:
      // 少写一个分支这一行就编译不过 —— 这就是"漏写"的机械防线,别把它改成 string 或加 `!`。
      const missing: never = tool;
      return fail(`tool "${String(missing)}" is declared in toolSchemas.ts but has no implementation`);
    }
  }
};
