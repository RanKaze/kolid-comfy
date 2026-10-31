// Agent 工具面的**唯一真源**（schema 一半）。
//
// 为什么在这里：工具的执行体只可能在浏览器里（`tools.ts` 的 run 分支），schema 与执行体
// 分居两个语言、两个文件时就一定会漂 —— 靠事后对账（跑测试）发现的漏写，等于没发现。
// 现在两者同处 `agent/` 目录，`tools.ts` 用 `AgentToolName` 做 switch 穷尽检查：
// 加了 schema 不写执行 ⇒ 编译报错；写了 case 但 schema 没登记 ⇒ TS2367 编译报错。
//
// 后端不 import 这份文件。构建（`npm run build -w sampler_node`）末尾由
// `tools/gen_agent_tools.cjs` 转成 `nodes/workbench/agent_tools.json`，后端按 mtime 热读，
// 所以改工具不用重启 ComfyUI。**不要手改那份 JSON**。

/** JSON Schema 的一个子集：只覆盖工具参数实际用到的形状。 */
export type AgentJsonSchema = {
  type?: string | readonly string[];
  description?: string;
  enum?: readonly string[];
  items?: AgentJsonSchema;
  properties?: Record<string, AgentJsonSchema>;
  required?: readonly string[];
  default?: unknown;
  [k: string]: unknown;
};

export type AgentToolSchema = {
  /** 工具名（与 `runAgentTool` 的分支、MCP 的 `mcp__kolid-workbench__<name>` 一致）。 */
  name: string;
  /** 给模型看的说明：做什么、边界在哪、什么时候别用。 */
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, AgentJsonSchema>;
    required: readonly string[];
  };
};

export const TOOLS = [
  {
    name: 'get_app_state',
    description: 'Snapshot of everything you can operate: mode (image/video), whether a document is open, canvas size, fps, transport (playhead seconds, playing), tracks, clips, assets, current selection, layer/guidance stacks, staging items, pipeline presets, video-generator interfaces, mask track binding.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'seek',
    description: 'Move the timeline playhead to `time` seconds.',
    parameters: { type: 'object', properties: { time: { type: 'number', description: 'seconds from 0' } }, required: ['time'] },
  },
  {
    name: 'play',
    description: 'Start playback.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'pause',
    description: 'Pause playback.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'select_clips',
    description: 'Set the timeline selection to these clip ids (empty array = clear selection). With a single Layer-kind clip and focus=true, also makes it the layer editing target (Layers/Guidances panels switch to its layer set).',
    parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, focus: { type: 'boolean', description: 'switch the layer edit target (default true)' } }, required: ['ids'] },
  },
  {
    name: 'add_track',
    description: 'Add a timeline track: video | audio | layer | process.',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['video', 'audio', 'layer', 'process'] } }, required: ['kind'] },
  },
  {
    name: 'remove_track',
    description: 'Remove a track and everything on it.',
    parameters: { type: 'object', properties: { track_id: { type: 'string' } }, required: ['track_id'] },
  },
  {
    name: 'rename_track',
    description: 'Rename a track.',
    parameters: { type: 'object', properties: { track_id: { type: 'string' }, name: { type: 'string' } }, required: ['track_id', 'name'] },
  },
  {
    name: 'place_asset',
    description: 'Place an asset from the project asset table onto the timeline.',
    parameters: { type: 'object', properties: { asset_id: { type: 'string' }, track_id: { type: 'string' }, time: { type: 'number', description: 'default = current playhead' } }, required: ['asset_id'] },
  },
  {
    name: 'move_clip',
    description: 'Move a clip to a new start time (and optionally another track). Linked audio/video twins move together unless only_self.',
    parameters: { type: 'object', properties: { clip_id: { type: 'string' }, start: { type: 'number' }, track_id: { type: 'string' }, only_self: { type: 'boolean' } }, required: ['clip_id', 'start'] },
  },
  {
    name: 'trim_clip',
    description: 'Trim a clip edge: edge=in moves the head, edge=out the tail; `time` is the new edge position on the timeline (seconds).',
    parameters: { type: 'object', properties: { clip_id: { type: 'string' }, edge: { type: 'string', enum: ['in', 'out'] }, time: { type: 'number' } }, required: ['clip_id', 'edge', 'time'] },
  },
  {
    name: 'split_clip',
    description: 'Split a clip at `time` (timeline seconds) into two.',
    parameters: { type: 'object', properties: { clip_id: { type: 'string' }, time: { type: 'number' } }, required: ['clip_id', 'time'] },
  },
  {
    name: 'remove_clips',
    description: 'Delete clips from the timeline.',
    parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
  },
  {
    name: 'add_layer_clip',
    description: 'Create an empty Layer segment (compositing container) on a layer track; creates the track when missing. Editing its layer set = select_clips focus.',
    parameters: { type: 'object', properties: { time: { type: 'number' }, duration: { type: 'number', description: 'default 5s' }, track_id: { type: 'string' } }, required: [] },
  },
  {
    name: 'select_layer',
    description: 'Select a layer row in the workbench (canvas compositing).',
    parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
  {
    name: 'add_layer',
    // Stash 不再是一种图层（它是条带上一枚 attribute：拍下"这一层以下所有图层的合成"）。要它就先
    // add_layer 再 ui_action('attr-add', { layerId, type: 'stash' }) —— 那一枚落在条带末尾，
    // 挂在它右边的特效链就作用于下面那一整叠。
    description: 'Add a new empty layer onto a stack: stack=layers|guidances. To snapshot the layers under it, add a Stash attribute afterwards via ui_action attr-add (type=“stash”).',
    parameters: { type: 'object', properties: { stack: { type: 'string', enum: ['layers', 'guidances'] } }, required: ['stack'] },
  },
  {
    name: 'create_comic_layout',
    description: 'Lay out a comic / manga page on the canvas — layout only, no artwork. Creates one empty layer per panel (named Panel N, sized and placed at its page rectangle, ready for layer_generate), an optional paper layer underneath and an optional frame-line layer on top; the whole layout is one undo step. Use it for requests like "漫画格排版 / 分镜排版 / panel grid / comic page layout". rows/cols (+ optional row_weights / col_weights) make a regular grid; `panels` with explicit px rectangles makes an irregular page. Omit w/h to keep the current canvas; when they differ the canvas is resized first.',
    parameters: { type: 'object', properties: { w: { type: 'number', description: 'page width px (default: current canvas)' }, h: { type: 'number', description: 'page height px (default: current canvas)' }, rows: { type: 'number', description: 'grid rows, 1..12 (default 2)' }, cols: { type: 'number', description: 'grid columns, 1..12 (default 2)' }, row_weights: { type: 'array', items: { type: 'number' }, description: 'relative row heights, one per row (default equal)' }, col_weights: { type: 'array', items: { type: 'number' }, description: 'relative column widths, one per column (default equal)' }, margin: { type: 'number', description: 'page margin px (default ~4% of the short side)' }, gutter: { type: 'number', description: 'gap between panels px (default ~3% of the short side)' }, border: { type: 'number', description: 'panel frame line width px; 0 = no frame layer (default 3)' }, ink: { type: 'string', description: 'frame colour #rrggbb (default #000000)' }, paper: { type: 'string', description: 'paper colour #rrggbb, or "none" for a transparent page (default #ffffff)' }, panels: { type: 'array', description: 'explicit panel rectangles in page px (overrides rows/cols) — use for irregular pages', items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, name: { type: 'string' } }, required: ['x', 'y', 'w', 'h'] } } }, required: [] },
  },
  {
    name: 'remove_layer',
    description: 'Remove a layer row.',
    parameters: { type: 'object', properties: { id: { type: 'number' }, stack: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'duplicate_layer',
    description: 'Duplicate a layer row.',
    parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
  {
    name: 'rename_layer',
    description: 'Rename a layer row.',
    parameters: { type: 'object', properties: { id: { type: 'number' }, name: { type: 'string' } }, required: ['id', 'name'] },
  },
  {
    name: 'set_layer_opacity',
    description: 'Set a layer overall opacity 0..1.',
    parameters: { type: 'object', properties: { id: { type: 'number' }, opacity: { type: 'number' } }, required: ['id', 'opacity'] },
  },
  {
    name: 'toggle_layer_visibility',
    description: 'Toggle a layer eye.',
    parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
  {
    name: 'layer_generate',
    description: 'Run the layer Generate (image generation) on a layer row.',
    parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
  {
    name: 'layer_from_asset',
    description: 'Insert a repo asset (content hash) as a new layer image.',
    parameters: { type: 'object', properties: { hash: { type: 'string' }, name: { type: 'string' }, stack: { type: 'string', enum: ['layers', 'guidances'] } }, required: ['hash'] },
  },
  {
    name: 'set_extra_prompt',
    description: 'Set the Extra Prompt text used by Blend / Tag runs.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'run_blend',
    description: 'Start a Blend run (canvas -> processed result into staging).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'run_tag',
    description: 'Start a Tag run (annotate the canvas).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'run_pipeline',
    description: 'Run a pipeline preset on the active document (the workbench main run). Omit preset_id to use the active preset.',
    parameters: { type: 'object', properties: { preset_id: { type: 'string' } }, required: [] },
  },
  {
    name: 'cancel_run',
    description: 'Cancel the currently running generation.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_canvas_size',
    description: 'Resize the canvas (pixels).',
    parameters: { type: 'object', properties: { w: { type: 'number' }, h: { type: 'number' } }, required: ['w', 'h'] },
  },
  {
    name: 'undo',
    description: 'Undo the last edit (works in both image and video mode).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'redo',
    description: 'Redo an undone edit.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'view_fit',
    description: 'Fit the canvas view (zoom to content).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_fps',
    description: 'Set the video project output frame rate.',
    parameters: { type: 'object', properties: { fps: { type: 'number' } }, required: ['fps'] },
  },
  {
    name: 'set_paint_color',
    description: 'Set the painting foreground color (#rrggbb).',
    parameters: { type: 'object', properties: { fg: { type: 'string' } }, required: ['fg'] },
  },
  {
    name: 'set_brush',
    description: 'Configure the brush.',
    parameters: { type: 'object', properties: { size: { type: 'number' }, strength: { type: 'number' } }, required: [] },
  },
  {
    name: 'add_vgen_segment',
    description: 'Add a Video Generator segment for interface #interface_index onto the process track (opens its prompt card for the user to fill).',
    parameters: { type: 'object', properties: { interface_index: { type: 'number' } }, required: ['interface_index'] },
  },
  {
    name: 'add_continue_segment',
    description: 'Like add_vgen_segment but seeds the new segment with the last frame of the currently selected video segment (continuation).',
    parameters: { type: 'object', properties: { interface_index: { type: 'number' } }, required: ['interface_index'] },
  },
  {
    name: 'document',
    description: 'Document actions. new = blank document in its own window; load = pick a .cud (native open dialog — the user finishes it); save = silent when the file path is known, otherwise a native Save dialog; save-as = always asks where; export-png = write the composite (visible layers, no guidances) as a PNG; import = pick images/PSD as new layers (native dialog); close = close the active document.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['new', 'load', 'save', 'save-as', 'export-png', 'import', 'close'] } }, required: ['action'] },
  },
  {
    name: 'get_prompt_state',
    description: "[SELECTION read] Read the Prompt tab's CURRENT SELECTION (the prompt_node iframe): the free-text custom prompt, selected prompt cards (with ids + display text), LoRAs (name/strength/active), prefabs and programs. Does NOT touch the library. Call this before editing so you act on the live selection, not a stale guess.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'prompt_library',
    description: '[DISCOVERY, read-only] List the prompt-card library so you can discover card ids/names to reference in set_prompt / prompt_card_*. Changes nothing — neither creates nor selects. Optional category filters to one category.',
    parameters: { type: 'object', properties: { category: { type: 'string', description: 'only list this category (default: all)' } }, required: ['category'] },
  },
  {
    name: 'set_prompt',
    description: '[SELECTION edit] Edit the Prompt tab SELECTION only (what feeds generation). This does NOT create or save any library item — it composes the active selection from EXISTING library items. Each optional field replaces that part of the selection. custom_prompt = free text; prompts = list of {id} / {category,name} / {category,prompt} / {text}, applied per prompt_mode (replace|add|remove, default replace); loras = list of {name|file_path, strength?, active?}; prefabs = list of {guid, active?}; programs = list of {id, active?}. The change is applied in the Prompt tab AND persisted to the prompt server the detailer reads. Unresolvable items are reported in warnings, not dropped.',
    parameters: { type: 'object', properties: { custom_prompt: { type: 'string', description: 'replace the free-text custom prompt' }, prompt_mode: { type: 'string', enum: ['replace', 'add', 'remove'], description: 'how prompts list is applied (default replace)' }, prompts: { type: 'array', items: { type: 'object' }, description: 'prompt cards to set/add/remove; each {id} or {category,name} or {category,prompt} or {text}' }, loras: { type: 'array', items: { type: 'object' }, description: 'LoRA selection: each {name|file_path, strength?, active?}' }, prefabs: { type: 'array', items: { type: 'object' }, description: 'prefab selection: each {guid, active?}' }, programs: { type: 'array', items: { type: 'object' }, description: 'program selection: each {id, active?}' } }, required: [] },
  },
  {
    name: 'prompt_card_add',
    description: '[LIBRARY add] Create a NEW prompt card in the library (the category is created if missing). Library write only — this does NOT select the card; call set_prompt afterward to include it in the active prompt. Returns the new card id.',
    parameters: { type: 'object', properties: { category: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, natural: { type: 'boolean' } }, required: ['category', 'name', 'prompt'] },
  },
  {
    name: 'prompt_card_update',
    description: '[LIBRARY edit] Edit an existing prompt card in the library by id: change its name/prompt/category/tags/natural. Library write only — does NOT change the current selection.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' }, category: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, natural: { type: 'boolean' } }, required: ['id'] },
  },
  {
    name: 'prompt_card_delete',
    description: '[LIBRARY delete] Delete a prompt card from the library by id. Library delete only — does NOT touch the selection.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'lora_library',
    description: "[DISCOVERY, read-only] List every LoRA available in the Prompt tab library (from loraData): each entry gives file_path, name and tags. Use this to discover the file_path/name to reference in set_prompt's loras field. Changes nothing — neither creates nor selects.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'prefab_library',
    description: "[DISCOVERY, read-only] List every prefab available in the Prompt tab library (from allLibraries): each entry gives guid, name, the tag_groups/loras/custom_prompts it applies, and the library name. Use this to discover the guid (and library name for prefab_add) to reference in set_prompt's prefabs field. Changes nothing — neither creates nor selects.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'program_library',
    description: "[DISCOVERY, read-only] List every program available in the Prompt tab library: each entry gives id and name. Use this to discover the id to reference in set_prompt's programs field. Changes nothing — neither creates nor selects.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'prefab_add',
    description: "[LIBRARY add] Add a NEW prefab to a prefab library. Requires library (a name from prefab_library's libraries list) and name. Optional tag_groups (list), loras (list), custom_prompts (string), selected_prefabs (list) and image (base64 data URL). Library write only — does NOT select the new prefab; call set_prompt afterward to include it in the active prompt. Returns the new guid.",
    parameters: { type: 'object', properties: { library: { type: 'string' }, name: { type: 'string' }, tag_groups: { type: 'array' }, loras: { type: 'array' }, custom_prompts: { type: 'string' }, selected_prefabs: { type: 'array' }, image: { type: 'string' } }, required: ['library', 'name'] },
  },
  {
    name: 'prefab_update',
    description: '[LIBRARY edit] Update an existing prefab in the library by guid (from prefab_library). Only the provided fields change: name, tag_groups, loras, custom_prompts, selected_prefabs, image (base64). Located by guid across all libraries. Library write only — does NOT change the current selection.',
    parameters: { type: 'object', properties: { guid: { type: 'string' }, name: { type: 'string' }, tag_groups: { type: 'array' }, loras: { type: 'array' }, custom_prompts: { type: 'string' }, selected_prefabs: { type: 'array' }, image: { type: 'string' } }, required: ['guid'] },
  },
  {
    name: 'prefab_delete',
    description: '[LIBRARY delete] Delete a prefab from the library by guid (from prefab_library). Library delete only — does NOT touch the selection. Returns ok.',
    parameters: { type: 'object', properties: { guid: { type: 'string' } }, required: ['guid'] },
  },
  {
    name: 'program_add',
    description: '[LIBRARY add] Add a NEW program to a program category. Requires name. Optional code, category (defaults to "Applications"), image (base64), selected_programs, multi_program, enable_*_context flags, context_*_guids/paths/texts and *_builtin_* arrays. Library write only — does NOT select the new program; call set_prompt afterward to include it in the active prompt. Returns the new id.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, code: { type: 'string' }, category: { type: 'string' }, image: { type: 'string' }, selected_programs: { type: 'array' }, multi_program: { type: 'boolean' }, enable_prefab_context: { type: 'boolean' }, enable_lora_context: { type: 'boolean' }, enable_tag_context: { type: 'boolean' }, context_prefab_guids: { type: 'array' }, context_lora_paths: { type: 'array' }, context_tag_texts: { type: 'array' }, prefab_builtin_guids: { type: 'array' }, lora_builtin_paths: { type: 'array' }, tag_group_builtin_texts: { type: 'array' }, prefab_builtin_inactive: { type: 'array' }, lora_builtin_inactive: { type: 'array' }, tag_group_builtin_inactive: { type: 'array' }, prefab_builtin_display: { type: 'array' }, lora_builtin_display: { type: 'array' }, tag_group_builtin_display: { type: 'array' } }, required: ['name'] },
  },
  {
    name: 'program_update',
    description: '[LIBRARY edit] Update an existing program in the library by id (from program_library). Only the provided fields change (name, code, image, video, selected_programs, multi_program, enable_*_context, context_* and *_builtin_* arrays). Located by id across all categories. Library write only — does NOT change the current selection.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, code: { type: 'string' }, image: { type: 'string' }, video: { type: 'string' }, selected_programs: { type: 'array' }, multi_program: { type: 'boolean' }, enable_prefab_context: { type: 'boolean' }, enable_lora_context: { type: 'boolean' }, enable_tag_context: { type: 'boolean' }, context_prefab_guids: { type: 'array' }, context_lora_paths: { type: 'array' }, context_tag_texts: { type: 'array' }, prefab_builtin_guids: { type: 'array' }, lora_builtin_paths: { type: 'array' }, tag_group_builtin_texts: { type: 'array' }, prefab_builtin_inactive: { type: 'array' }, lora_builtin_inactive: { type: 'array' }, tag_group_builtin_inactive: { type: 'array' }, prefab_builtin_display: { type: 'array' }, lora_builtin_display: { type: 'array' }, tag_group_builtin_display: { type: 'array' } }, required: ['id'] },
  },
  {
    name: 'program_delete',
    description: '[LIBRARY delete] Delete a program from the library by id (from program_library). Library delete only — does NOT touch the selection. Returns ok.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'lora_refresh',
    description: '[LIBRARY scan] Rescan the lora folders on disk so newly added .safetensors/.metadata.json files appear in lora_library. Call this after new lora files are dropped into the folder. Returns ok with the new lora count. Read-only scan (LoRAs are files, so there is no add/delete); does NOT change the current selection.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'lora_update',
    description: "[LIBRARY/asset edit] Edit a LoRA's slider config (LoRAs are files, so there is no add/delete). Currently supports model_only (boolean): when true the lora patches the model only, not CLIP. Identify the lora by file_path or fingerprint. Asset edit only — does NOT change the current selection.",
    parameters: { type: 'object', properties: { file_path: { type: 'string' }, fingerprint: { type: 'string' }, model_only: { type: 'boolean' } }, required: ['model_only'] },
  },
  {
    name: 'get_ui_actions',
    description: '[DISCOVERY, read-only] List the workbench UI action keys you can fire with ui_action. Each entry: action (the key), kind (none|string|number|boolean|array|object), payload (the TS type of the value), doc (what it does). Every button, slider and menu item in the workbench is one of these. Filter by `group` (action prefix: layer/fx/attr/paint/brush/view/mask/staging/processor/... ) or by a keyword in `q`. Changes nothing.',
    parameters: { type: 'object', properties: { group: { type: 'string', description: 'only actions whose key starts with this prefix' }, q: { type: 'string', description: 'only actions whose key/doc contains this text' } }, required: [] },
  },
  {
    name: 'ui_action',
    description: "[UI] Fire a workbench UI action — exactly what the matching button / slider / menu item does. `action` must be a key from get_ui_actions (unknown keys are rejected, not silently ignored). `value` is that key's payload: omit it for kind=none, pass the bare value for kind=string|number|boolean|array, pass an object for kind=object (field names are in the payload type). Prefer a dedicated tool when one exists (seek, add_layer, prompt_*, ...) — those validate more and say more in the result; use ui_action for everything else. Read get_app_state first when the action depends on ids (layers, clips, assets).",
    parameters: { type: 'object', properties: { action: { type: 'string', description: 'an action key from get_ui_actions' }, value: { description: "that action's payload (omit when kind=none)" } }, required: ['action'] },
  },
  {
    name: 'set_timeline_zoom',
    description: 'Set the timeline zoom level (pixels per second).',
    parameters: { type: 'object', properties: { pps: { type: 'number', description: 'pixels per second, roughly 5..600 (default 60)' } }, required: ['pps'] },
  },
  {
    name: 'toggle_track_mute',
    description: 'Toggle mute on a track (video/audio/layer each have their own meaning).',
    parameters: { type: 'object', properties: { track_id: { type: 'string' } }, required: ['track_id'] },
  },
  {
    name: 'toggle_track_solo',
    description: 'Toggle solo on a track: an audio track solos audio, a video track solos video; layer tracks do not take solo.',
    parameters: { type: 'object', properties: { track_id: { type: 'string' } }, required: ['track_id'] },
  },
  {
    name: 'move_track',
    description: 'Reorder a track by index (array order = top-to-bottom order, which is compositing order for video tracks).',
    parameters: { type: 'object', properties: { track_id: { type: 'string' }, to: { type: 'number', description: 'target index, 0 = top' } }, required: ['track_id', 'to'] },
  },
  {
    name: 'set_mask_track',
    description: 'Bind the mask track to a video track (or clear it with track_id=null).',
    parameters: { type: 'object', properties: { track_id: { type: ['string', 'null'] } }, required: [] },
  },
  {
    name: 'toggle_vgen_chain',
    description: "Link / unlink two Video Generator segments at their seam (what Ctrl+click on the seam does): the second segment then takes the first one's last frame. Needs same track, both generator segments, touching start/end, and the second one binding first_frame. Already linked to `prev` ⇒ unlinks.",
    parameters: { type: 'object', properties: { prev_clip_id: { type: 'string' }, next_clip_id: { type: 'string' } }, required: ['prev_clip_id', 'next_clip_id'] },
  },

  // ── MIDI 乐器：每条轨一件（路径住工程里，引擎那头按轨各开一支实例）──
  // 这一组就是 MIDI 模式下"乐器"那一列能做的事：看、找、装/换、开插件窗挑音色、关窗自动存成
  // .vstpreset、卸、试听。窗口是真的系统窗口，开在插件自己的进程里 —— 这里只是替用户按那几个键。
  {
    name: 'get_midi_state',
    description: '[READ] Snapshot of the MIDI half of the active document: tempo / time signature / transport (playing, seconds), the selected track, the preview slot, and every MIDI track with channel, instrument path, velocity base, mute/solo, note count, plus what the native engine reports for it (loaded? open? editor window? error). Read this first to get real track ids.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'instrument_library',
    description: "[DISCOVERY, read-only] List the instruments found under the Instruments Library folder (Settings → MIDI): name, model, format, source, absolute path, and whether this engine can play it. Pass a returned `path` to set_track_instrument. `force` re-scans the folders — use it after the user adds files on disk.",
    parameters: { type: 'object', properties: {
      q: { type: 'string', description: 'case-insensitive filter over name / model / source / path' },
      playable_only: { type: 'boolean', description: 'only rows this engine can actually play (default false)' },
      force: { type: 'boolean', description: 're-scan the folders first (default false)' },
      limit: { type: 'number', description: 'max rows to print, 1..500 (default 80)' },
    }, required: [] },
  },
  {
    name: 'set_track_instrument',
    description: "[WRITE] Load an instrument onto a MIDI track — this is what the track then plays. With `track_id` it replaces that track's instrument; without it a new MIDI track named after the instrument is created. `path` must be absolute (.sfz samples, a .vst3 plug-in, or a .vstpreset) — call instrument_library to get one. Loading a .vst3 plug-in itself also opens its own window so a sound can be picked (close_instrument_window saves it). On failure the track keeps its previous sound and the error says why.",
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'absolute path to a .sfz / .vst3 / .vstpreset' },
      track_id: { type: 'string', description: 'existing MIDI track to load into (omit = add a new track)' },
      name: { type: 'string', description: 'name for the new track (default: the file name)' },
    }, required: ['path'] },
  },
  {
    name: 'unload_track_instrument',
    description: '[WRITE] Remove the instrument from a MIDI track — the track stays (its notes stay), it just stops sounding. Any plug-in window open for it is closed without saving.',
    parameters: { type: 'object', properties: { track_id: { type: 'string' } }, required: ['track_id'] },
  },
  {
    name: 'open_instrument_window',
    description: "[WRITE] Open the instrument's own plug-in window (its real UI, a system window) for a track — how HALion / Kontakt sounds get picked: the user chooses a sound there, then closes the window (or you call close_instrument_window) and it is saved as a .vstpreset that becomes this track's instrument. Only VST3 instruments have a window; SFZ instruments do not.",
    parameters: { type: 'object', properties: { track_id: { type: 'string' } }, required: ['track_id'] },
  },
  {
    name: 'close_instrument_window',
    description: "[WRITE] Close the plug-in window opened by open_instrument_window and save its current state as a .vstpreset into the preset folder; the track's instrument switches to that preset in place (no reload, sound does not stop). Returns the saved path. Exactly what the user's window X does — if the user already closed it, nothing is saved twice.",
    parameters: { type: 'object', properties: { track_id: { type: 'string' } }, required: ['track_id'] },
  },
  {
    name: 'audition_note',
    description: '[ACTION] Play one note to hear it, without touching the transport or the project notes. `track_id` auditions the instrument loaded on that track (its own channel); `path` auditions a library item in the preview slot (it does not enter the project). Returns the engine peak measured right after: 0 means nothing came out — the sound may not map that key (drum kits and split programs do not cover every pitch).',
    parameters: { type: 'object', properties: {
      pitch: { type: 'number', description: 'MIDI pitch 0..127 (60 = C4)' },
      vel: { type: 'number', description: 'velocity 1..127 (default 100)' },
      track_id: { type: 'string', description: 'audition the instrument on this track' },
      path: { type: 'string', description: 'audition this library item in the preview slot instead' },
    }, required: ['pitch'] },
  },
] as const satisfies readonly AgentToolSchema[];

export type AgentToolName = (typeof TOOLS)[number]['name'];

/** 名字集合（运行时用；类型层面由 `AgentToolName` 兜住）。 */
export const AGENT_TOOL_NAMES: readonly string[] = TOOLS.map(t => t.name);
