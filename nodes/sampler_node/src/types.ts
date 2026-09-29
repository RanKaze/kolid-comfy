export interface ServerConfig {
  prompt_url: string;
  detail_status: 'idle' | 'running' | 'done' | 'error';
  /** GLOBAL SETTINGS —— 节点端口已全部取消，这里就是前端唯一读写的地方。
   *  ref_* / tgen_* 是输入侧显存**上限**（只压不涨，0 = 关闭），语义与 pixels 的"目标"相反。 */
  pixels: number;
  align: number;
  crop_reserve: number;
  mask_grow: number;
  mask_blur: number;
  ref_pixels?: number;
  ref_align?: number;
  tgen_pixels?: number;
  tgen_align?: number;
  /** 当前 pipeline 的模型架构（按架构渲染 DetailerBlock 的 edit 设置） */
  architecture?: string | null;
  has_tagger: boolean;
  /** Detector 工具总闸：节点的 detector 输入有没有连东西 */
  has_detector: boolean;
  has_package: boolean;
  package_count: number;
  has_pipeline_package: boolean;
  pipeline_package_count: number;
  blocks: PipelineBlock[];
  /** 多套 Pipeline Blocks（工作台里的 tabs）；`blocks` 始终是激活那一套的镜像 */
  blocks_sets?: BlockSet[];
  active_block_set?: string | null;
  /** Pipeline Settings（Draw 页）：选中的 pipeline + 按名字绑定的九个 override */
  pipeline_settings?: PipelineSettings;
  /** Interface tab 的持久化配置：端口改名 / 模式开关 / block 端口绑定（按包名索引） */
  interface_meta?: InterfaceMeta;
  /** 此刻真正加载在节点上的那条 pipeline 名字（'' = 节点输入口那条，从未切换过） */
  loaded_pipeline_name?: string;
}

/** 一套 Pipeline Blocks = 一个 tab。id 稳定（重命名不改 id），blocks 与旧模型同构。 */
export interface BlockSet {
  id: string;
  name: string;
  blocks: PipelineBlock[];
  /** 这套链跑起来时用哪条 pipeline：'' = 不切换（[Current Select] 语义）、
   *  PIPELINE_CURRENT_SELECT、或某个 pipeline 名字。绑定按名字（不是索引）。 */
  pipeline_name?: string | null;
}

/** '[Default]' —— 节点输入口那条 pipeline。它的身份后端从来没有收集过，所以一旦选过别的
 *  就再也回不去：enum 里这颗选项只在"还没选过任何东西"时出现。 */
export const PIPELINE_DEFAULT = '[Default]';
/** '[Current Select]' —— 不做任何切换，用当前已加载的那一条。 */
export const PIPELINE_CURRENT_SELECT = '[Current Select]';

/** 可 override 的九项，与后端 PIPELINE_OVERRIDE_KEYS 一一对应（顺序即 UI 顺序）。
 *  ref_* / tgen_* 是**输入侧上限**（只压不涨，0 = 关闭），其余是工作区/预处理参数。 */
export type PipelineOverrideKey = 'mask_grow' | 'mask_blur' | 'crop_reserve' | 'pixels' | 'align'
  | 'ref_pixels' | 'ref_align' | 'tgen_pixels' | 'tgen_align';
export const PIPELINE_OVERRIDE_KEYS: PipelineOverrideKey[] =
  ['mask_grow', 'mask_blur', 'crop_reserve', 'pixels', 'align',
   'ref_pixels', 'ref_align', 'tgen_pixels', 'tgen_align'];

export interface PipelineOverride {
  value: number;
  enabled: boolean;
}

/** 整份 Pipeline Settings。override 按 pipeline **名字**存（不是 node_id）—— 这是用户要的
 *  "跟随 pipeline 持久化"；代价是重名的两条会共享同一份 override。 */
export interface PipelineSettings {
  selected: string;
  overrides: Record<string, Partial<Record<PipelineOverrideKey, PipelineOverride>>>;
}

export const EMPTY_PIPELINE_SETTINGS: PipelineSettings = { selected: '', overrides: {} };

export interface DetailerBlockParams {
  /** 'enable' = Random（加随机噪声）、'disable' = None、'invert' = DDIM 反演往返 */
  add_noise: string;
  start_step_rate: number;
  end_step_rate: number;
  pixels: number;
  align: number;
  crop_reserve: number;
  /** 关掉时不 recover crop（也不 recover resize）：产出保持 crop 工作区分辨率，
   *  作为新图层由 Blend 画布用 transform 贴回原位；开 = 合成回整幅图（原行为）。 */
  recover_crop?: boolean;
  /** Preprocess Settings 的 Enable Fit（默认关）：图层 Generate 带 place 矩形回来时，
   *  新图层先继承源图层 mask 在 place 框内的那一块，再自动 Fit Mask，把图层框缩到
   *  mask 真正的外接框（grow/feather 的死区被裁掉）。关 = 产出铺满整个 crop 框。
   *  只在 Enable Mask 开时可见/可操作。 */
  enable_fit?: boolean;
  /** Preprocess Settings 的 Enable Mask 总闸（默认开）。关 = 不做 mask 扩张/羽化
   *  （grow/blur 归零）、不按 mask 裁剪（crop_reserve 无效）、不 recover crop；
   *  产出直接落在整幅图坐标系。mask 本身仍然限制重绘区域。 */
  enable_mask?: boolean;
  /** Preprocess Settings 的 Enable Limit 总闸（默认开）。关 = 不做像素上限，
   *  也不做 align 对齐（工作分辨率 = 裁剪/整幅分辨率）。Qwen 架构例外：仍会
   *  强制 32 对齐，否则 latent / vision token 网格不接受。 */
  enable_limit?: boolean;
  enable_edit: boolean;
  /** 块级 Generate Text 开关（默认关）：仅当 pipeline 也启用了 Generate Text 时才生效 */
  enable_text_generate?: boolean;
  /** Override Prompt（默认关）：开着时本块 Generate Text 指令用 override_prompt 替代 pipeline 的 prompt（空 = 空指令） */
  enable_override_prompt?: boolean;
  /** Override Prompt 的指令文本（仅 enable_override_prompt 开且有 generate text 时参与运算） */
  override_prompt?: string;
  /** Krea2 source-patch 编辑模式: fit = 整图适配 + stride-1 位置（防模糊）; crop = center-crop 几何 */
  edit_mode?: 'fit' | 'crop';
  /** Krea2: 最后一个参考（源图）的 target->ref 注意力乘数, >1 拉向参考外观 */
  ref_boost?: number;
  /** Krea2: 第一个参考（场景, 仅多参考时生效）的注意力乘数 */
  ref_boost_a?: number;
  /** Krea2: 启用后以 context mask（当前块裁剪区 mask）限定 ref_boost 增强区域 */
  enable_ref_boost_mask?: boolean;
  /** Krea2: grounded encode 的 VLM 看图分辨率上限（正/负条件共用）, 默认 768 */
  grounding_px?: number;
  /** 该 detailer block 解出 pipeline.context 的 lora/prompt 时使用的正则（默认 ".+"） */
  context_regex?: string;
}

export interface InterfaceBlockParams {
  /** 选中的 interface 子图索引（对应后端 interface_packages）。仅作旧配置兼容/运行时镜像，
   *  绑定以 interface_name 为准（重排/增删接口包不会错绑），运行时按名字解析。 */
  interface_idx: number;
  /** 绑定的 interface 子图名字（稳定标识）。null = 旧配置尚未迁移 */
  interface_name?: string | null;
  /** default = 直接执行; crop = 先 crop 再执行（带 crop_reserve 余量） */
  operation: 'default' | 'crop';
  crop_reserve: number;
  /** 端口图片覆盖: { 端口num: history key }，从 history 选择 */
  image_keys: Record<string, string>;
  /** 可选的 context 源图/源mask（history key）；留空则沿用 pipeline 流式传递（上一 block 输出） */
  context_image_key: string | null;
  context_mask_key: string | null;
  manual_values: Record<string, any>;
}

/** prompt block 的私有 selection（prompt_node 界面 block 作用域保存的 raw 选择）。
 *  run 时与 prompt 节点全局选择合并，block 的 programs 在合并结果上执行（临时注入）。 */
export interface PromptBlockSelection {
  tags?: any[];
  custom_prompts?: string;
  loras?: any[];
  prefabs?: any[];
  programs?: any[];
}

/** Prompt 块引用的共享、持久化 preset（内容存后端 prompt_presets.json，块只存 id）。 */
export interface PromptPreset {
  id: string;
  name: string;
  selection?: PromptBlockSelection | null;
}

export interface PromptBlockParams {
  /** 引用的 preset id；null = 未配置（运行时跳过该块） */
  preset_id?: string | null;
}

/** Query 块：run 到它时链条暂停并弹出 prompt UI，用户挑完 Confirm 才继续。
 *  回答按 prompt 块同样的语义合并（全局在前 + 本次选择在后 + programs 跑在合并结果上），
 *  只影响其后的 detailer；关掉弹窗 = 中止整条链。
 *
 *  `preset_id` = 与 prompt 块共用的那个 preset：弹窗以它的 selection 为初始勾选。
 *  null = 未绑定，弹窗从空白开始（旧的 Query 行为）。
 *  `persistent` = 只在与 preset 绑定时有用：Confirm 那一刻把弹窗的最终完整 selection
 *  整体写回 preset（下次 run/下次打开弹窗即看到），关着则本次修改只活在当前 run 里。 */
export interface QueryBlockParams {
  preset_id?: string | null;
  persistent?: boolean;
}

export interface PipelineBlock {
  id: string;
  type: 'detailer' | 'interface' | 'prompt' | 'query';
  name: string;
  params: DetailerBlockParams | InterfaceBlockParams | PromptBlockParams | QueryBlockParams;
  interface_index?: number;
  exec_options?: InterfaceExecOptions;
}

/** 一个正停在链条里等用户回答的 Query 块（/api/status 下发；null = 没有块在等）。 */
export interface PendingQuery {
  id: string;
  name: string;
  index: number;
  /** 该 Query 块绑定的 preset（弹窗以此为初始勾选；null/缺省 = 从空白开始） */
  preset_id?: string | null;
  /** Confirm 时后端会把最终 selection 写回该 preset */
  persistent?: boolean;
}

/**
 * 一条"行为"记录 —— 取代工作台画布顶部那颗常显的状态药丸。
 * 工作台每一次 setStatus 都改发 'blend-log' 给宿主，宿主自己的动作（跑 preset / Execute /
 * 取消 / 载入）也写进来，只留最近 32 条，由 Context 标题行的 Log 按钮按需展开。
 */
export interface ActionLogEntry {
  at: number;
  text: string;
  kind: '' | 'success' | 'error';
}

export interface StatusResponse {
  /** cancelled = 工作台的 Cancel 打断了本次运行（/api/cancel_run） */
  detail_status: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  error?: string;
  progress?: number;
  current_step?: number;
  total_steps?: number;
  interface_status?: 'idle' | 'running' | 'done' | 'error';
  interface_error?: string;
  interface_progress?: number;
  interface_current_step?: number;
  interface_total_steps?: number;
  interface_result_keys?: string[];
  /** 离线 processor 的结果清单（key/port/type/name），done 时由宿主按端口发回工作台 */
  interface_result_meta?: { key: string; port: number; type: string; name: string }[];
  pending_query?: PendingQuery | null;
  /** preset 绑定的 pipeline 可能在本次 run 里被现加载 —— 名字与架构都跟着变，轮询时顺手同步 */
  loaded_pipeline_name?: string;
  architecture?: string | null;
}

export interface TagPreviews {
  full?: string;
  mask?: string;
  covered?: string;
}

export interface DebugReferenceImage {
  name: string;
  src: string;
}

export interface DebugRecoverData {
  background: string;
  image: string;
  mask: string;
  crop_x: number;
  crop_y: number;
  crop_width: number;
  crop_height: number;
  original_width: number;
  original_height: number;
  reference_images: DebugReferenceImage[];
}

/**
 * 上一次 Run / Generate 的调试快照（/api/debug_trace）。
 * `steps` 是按执行顺序排列的记录：stage = 文字说明，prompt = 某一阶段的提示词，
 * image / mask 带 `items` 缩略图，block = 一个 block 的分节标题，error = 某步失败。
 */
export interface DebugTraceItem {
  label: string;
  /** 这张图本身，按真实分辨率编码（服务端不再缩预览）。 */
  dataUrl: string;
  /** 这张图进入管线的实际分辨率。 */
  width: number;
  height: number;
  /** 尺寸由哪颗像素旋钮定下来的（limit_pixels 的目标/上限）；没走 limit 就没有。 */
  pixels?: number;
  /** 尺寸落的那格 align；align=1（没落格）时服务端不发。 */
  align?: number;
}

export interface DebugTraceStep {
  kind: 'stage' | 'prompt' | 'image' | 'mask' | 'block' | 'error';
  label: string;
  detail?: string;
  /** 属于哪个 block；0 = 链外 / 全局，null = 未标注 */
  block?: number | null;
  data?: Record<string, any>;
  items?: DebugTraceItem[];
}

export interface DebugTraceMeta {
  generated_at?: string | null;
  from_blend?: boolean;
  action?: string;
  status?: 'idle' | 'running' | 'done' | 'error';
  error?: string | null;
  [k: string]: any;
}

export interface DebugTraceResponse {
  available: boolean;
  generated_at?: string | null;
  meta?: DebugTraceMeta | null;
  steps: DebugTraceStep[];
  image_count: number;
  truncated: boolean;
}

export interface StagingItem {
  /** 内部图池条目 id（'staging_N'）。Extra Prompt 的 <image_id:...> / 端口图 / Finish 都引用它。 */
  id: string;
  name: string;
  src: string;
  width?: number;
  height?: number;
  /** hidden = 生成侧自动登记的条目（Original 种子 / run、接口产出）：不进工作区条带，
   *  条带只展示用户主动拖入/导入的图。宿主镜像按此字段过滤。 */
  hidden?: boolean;
  /** Recover Crop 关闭时：产出 patch 要贴回哪块画布区域。此模式下 src 是 RGBA —— alpha
   *  就是 crop 工作区的 mask，图层自带裁剪。
   *  x/y/w/h 是 crop 矩形，单位 = 本次 run 的原始图像素（ow x oh）；
   *  pw/ph 是 patch 自身的像素尺寸，sx/sy 是 limit_pixels 施加的缩放比。 */
  place?: {
    x: number; y: number; w: number; h: number;
    ow: number; oh: number;
    pw: number; ph: number; sx: number; sy: number;
  } | null;
}

export interface InterfaceExecOptions {
  image_source_key?: string | null;
  operation: 'default' | 'crop';
  crop_reserve: number;
}

/**
 * `draw` is now the Blend workbench: its canvas composite IS the Context Image, and the pure
 * Mask layer supplies the mask. The standalone `mask` / `blend` / `tag` tabs were folded into
 * it (the Tag buttons live in its toolbar). `context` and `pipeline` are gone for the same
 * reason — the pipeline switch lives in the Draw panel's Pipeline Settings section now, and
 * nothing in the workbench reads a separately-selected context image any more.
 */
export type Tab = 'prompt' | 'draw' | 'interface';

export interface InterfacePort {
  num: number;
  name: string;
  type: string;
  value: any;
  category: 'inject' | 'manual' | 'port';
  options?: string[];
}

export interface InterfaceInfo {
  name: string;
  start_ports: InterfacePort[];
  end_ports: InterfacePort[];
  /** Interface tab 贴在包上的标注（/api/package 已按名字合并）。 */
  modes?: { block: boolean; processor: boolean };
  block_ports?: { in?: number; out?: number };
}

/** 一个 interface 的持久化配置（blocks_sets.json 的 interface_meta 键，按包名索引）。
 *  端口名只是展示 —— 执行全程按端口号走。names 的键是端口号字符串。 */
export interface InterfaceMetaEntry {
  names?: { start?: Record<string, string>; end?: Record<string, string> };
  modes?: { block: boolean; processor: boolean };
  block_ports?: { in?: number; out?: number };
}

export type InterfaceMeta = Record<string, InterfaceMetaEntry>;

export interface PipelineInfo {
  name: string;
  node_id: string;
}

export interface PipelinePackageInfo {
  name: string;
  pipelines: PipelineInfo[];
}

/** 第一个 detailer block 上的某布尔总闸（Preprocess Settings 的开关都存在它的 params 里）。
 *  Blend 工作台的 Run 预检、preset 行的 ▶ 图标与后端闸门共用同一语义：enable_mask 关 = 不做
 *  围绕 mask 的预处理、整幅就是工作区，Mask 层没画也能跑；enable_fit 开 = 图层 Generate 的产出
 *  继承源 mask 后贴合。
 *  setId 解不出链时退回第一套（与后端选链的优先级一致）；默认值由调用方传入，
 *  必须与后端/工作台读同一 key 时的默认一致（enable_mask 后端默认开）。 */
export function firstDetailerFlag(
  blockSets: BlockSet[], setId: string | null,
  key: 'enable_mask' | 'enable_fit', dflt: boolean,
): boolean {
  const set = blockSets.find(s => s.id === setId) || blockSets[0];
  const fd = set?.blocks.find(b => b.type === 'detailer');
  const dp = fd ? (fd.params as DetailerBlockParams) : undefined;
  return dp ? (dp[key] ?? dflt) : dflt;
}
