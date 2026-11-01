/**
 * "谁动了哪扇窗" —— agent 脉冲的目标解析。
 *
 * 两条来源，都尽量让机器算：
 *  1. **工具**：`TOOL_SURFACE` 是 `Record<AgentToolName, …>`，少一个键 `tsc` 就报错（和
 *     `tools.ts` 的 switch 穷尽检查同一招）。语义就在工具名旁边，不另开一份清单。
 *  2. **动作键**：`ui_action` 的 125 个键有前缀（`layer-` / `brush-` / `view-` …），而前缀
 *     基本就是面板 id —— 所以只写一小张**别名表**（`layer→layers` 这种），其余原样试，
 *     试不出来退回画布。加新面板不需要来改这里。
 *
 * 为什么可以粗：这是**提示**，不是路由。指错一扇窗只是提示不准，不会有任何行为差异；
 * 所以宁可"大多数有提示"也不要为了 100% 精确去维护一张 125 行的表。
 */
import type { AgentToolName } from '../agent/toolSchemas';
import { pulseUnit } from './agentPulse';

/** 目标面板。`doc` 在运行时换成 `doc:<uid>`（文档窗是每份 .cud 一扇，id 带 uid）。 */
export type AgentSurface = string;

/** 动作键前缀 → 面板 id。**只写对不上的那些**：`brush-` / `view-` / `history-` 之类的
 *  前缀本身就是面板 id，不需要登记。 */
const ACTION_ALIAS: Record<string, AgentSurface> = {
  layer: 'layers',       // 面板叫 layers（复数）
  select: 'selection',   // 面板叫 selection
  paint: 'canvas',       // 画笔落在画布上
  hover: 'canvas',
  stage: 'canvas',
  fx: 'layers',          // 效果链挂在图层上，弹窗是它的延伸
  raster: 'layers',
  visible: 'layers',
  panel: 'layers',       // 漫画格排版是造图层
  attr: 'guidances',     // 属性行住在 Guidances
  mask: 'guidances',     // Mask 已经是 Guidances 的第一行（不再是一扇窗）
  cud: 'toolbar',        // 文档级（开/存/导）走顶栏
};

/** 这些前缀**本身就是** dock 的面板 id（`WORKBENCH_UNITS` + 宿主那几格）。 */
const PANEL_PREFIXES = new Set([
  'staging', 'canvas', 'transform', 'color', 'brush', 'bucket', 'eraser', 'selection', 'cut', 'cursor', 'view',
  'text', 'geometry', 'scene3d', 'pose', 'detector', 'processor', 'videogen', 'guidances',
  'layers', 'history', 'layout',
  'toolbar', 'context', 'pipeline', 'presets', 'blocks',
  'vtracks', 'vassets', 'vinspector', 'vkf', 'vaudio', 'log', 'debug', 'probe', 'agent',
]);

/** 一个动作键作用在哪扇窗。认不出来就记在画布上（绝大多数没登记的键最终都改画布）。 */
export function surfaceOfAction(action: string): AgentSurface {
  const prefix = String(action || '').split('-')[0];
  const alias = ACTION_ALIAS[prefix];
  if (alias) return alias;
  if (PANEL_PREFIXES.has(prefix)) return prefix;
  return 'doc';
}

/**
 * 每个工具碰到哪扇窗。`none` = 只读或作用面不在 dock 里（prompt 那一组走另一个 iframe），
 * `auto` = 由参数决定（`ui_action` 看动作键）。
 */
export const TOOL_SURFACE: Record<AgentToolName, AgentSurface> = {
  get_app_state: 'none',

  // ── 时间线 ──
  seek: 'vtracks', play: 'vtracks', pause: 'vtracks',
  select_clips: 'vtracks', add_track: 'vtracks', remove_track: 'vtracks', rename_track: 'vtracks',
  place_asset: 'vtracks', move_clip: 'vtracks', trim_clip: 'vtracks', split_clip: 'vtracks',
  remove_clips: 'vtracks', add_layer_clip: 'vtracks', set_fps: 'vtracks',
  set_timeline_zoom: 'vtracks', toggle_track_mute: 'vtracks', toggle_track_solo: 'vtracks',
  move_track: 'vtracks', set_mask_track: 'vtracks',

  // ── 图层 ──
  select_layer: 'layers', add_layer: 'layers', create_comic_layout: 'layers',
  remove_layer: 'layers', duplicate_layer: 'layers', rename_layer: 'layers',
  set_layer_opacity: 'layers', toggle_layer_visibility: 'layers',
  layer_generate: 'layers', layer_from_asset: 'layers',

  // ── 画布与它那一列工具 ──
  set_canvas_size: 'canvas', view_fit: 'view', set_paint_color: 'color', set_brush: 'brush',

  // ── 生成：进度条与结果在 Staging（画布底栏那一格）──
  set_extra_prompt: 'staging', run_blend: 'staging', run_tag: 'staging',
  run_pipeline: 'staging', cancel_run: 'staging',

  // ── 历史 ──
  undo: 'history', redo: 'history',

  // ── Video Generator ──
  add_vgen_segment: 'videogen', add_continue_segment: 'videogen', toggle_vgen_chain: 'videogen',

  // ── MIDI 乐器 ── MIDI 模式的轨道窗/卷帘不吃脉冲（它们不住在 dock 的单元表里），
  // 与其点亮一扇错的窗，不如不点。窗口本身的出现就是用户看到的结果。
  get_midi_state: 'none', instrument_library: 'none',
  set_track_instrument: 'none', unload_track_instrument: 'none',
  open_instrument_window: 'none', close_instrument_window: 'none', audition_note: 'none',

  // ── 文档 ──
  document: 'toolbar',

  // ── Prompt 那一组：prompt_node 是侧栏 tab 里的独立 iframe，不是 dock 窗 —— 锚点是那个 tab ──
  get_prompt_state: 'tab:prompt', set_prompt: 'tab:prompt',
  prompt_library: 'tab:prompt', lora_library: 'tab:prompt',
  prefab_library: 'tab:prompt', program_library: 'tab:prompt',
  prefab_add: 'tab:prompt', prefab_update: 'tab:prompt', prefab_delete: 'tab:prompt',
  program_add: 'tab:prompt', program_update: 'tab:prompt', program_delete: 'tab:prompt',
  lora_refresh: 'tab:prompt', lora_update: 'tab:prompt',
  prompt_card_add: 'tab:prompt', prompt_card_update: 'tab:prompt', prompt_card_delete: 'tab:prompt',

  // ── 目录本身只读 ──
  get_ui_actions: 'none',

  // ── 透传：目标由动作键决定 ──
  ui_action: 'auto',
};

/**
 * 工具开始执行时点亮它的目标窗。**执行前**调用 —— 用户看到的是"它现在正在动这扇窗"，
 * 而不是"它动过"。
 */
export function pulseForTool(
  name: AgentToolName,
  args: Record<string, unknown>,
  docUid: number | null,
): void {
  const raw = name === 'ui_action'
    ? surfaceOfAction(String(args?.action ?? ''))
    : TOOL_SURFACE[name];
  const unit = raw === 'doc'
    ? (docUid === null || docUid === undefined ? null : `doc:${docUid}`)
    : raw;
  if (!unit || unit === 'none' || unit === 'auto') return;
  pulseUnit(unit, name === 'ui_action' ? `agent · ${String(args?.action ?? '')}` : `agent · ${name}`);
}
