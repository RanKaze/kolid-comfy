export interface ServerConfig {
  prompt_url: string;
  detail_status: 'idle' | 'running' | 'done' | 'error';
  /** DEFAULT SETTING（Settings tab）—— 节点端口已全部取消，这里就是前端唯一读写的地方。
   *  ref_* / tgen_* 是输入侧显存**上限**（只压不涨，0 = 关闭），语义与 pixels 的"目标"相反。
   *  架构规则命中的那几项会盖掉这里的值（见 ArchSettings）。 */
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
  /** Draw 页 Pipeline Settings：选中要加载哪条 pipeline。`overrides` 是旧版按名字存的
   *  那份数据 —— 后端不再读它，前端仍原样回写，免得一次保存就把磁盘内容洗掉。 */
  pipeline_settings?: PipelineSettings;
  /** Settings tab：按 pipeline architecture 正则匹配的覆盖规则（自上而下第一条命中整条赢） */
  arch_settings?: ArchSettings;
  /** Interface tab 的持久化配置：端口改名 / 模式开关 / block 端口绑定（按包名索引） */
  interface_meta?: InterfaceMeta;
  /** Settings tab 的 user preference：执行到节点时的打开方式。开 = KolidUI 不在就把
   *  Kolid Desktop.exe 拉起来再注入；关 = 原逻辑（在就注入，不在退浏览器）。 */
  open_with_app?: boolean;
  /** 此刻真正加载在节点上的那条 pipeline 名字（'' = 节点输入口那条，从未切换过） */
  loaded_pipeline_name?: string;
  /** lora_regex 换过几代（只有真变了才 +1）。Prompt tab 那张 LoRA 卡的灰名单跟着它走。 */
  pipeline_lora_epoch?: number;
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

/** Default Setting 的九项，也是架构规则能覆盖的九项 —— 与后端 ARCH_OVERRIDE_KEYS 一一对应
 *  （顺序即 UI 顺序）。ref_* / tgen_* 是**输入侧上限**（只压不涨，0 = 关闭），
 *  其余是工作区/预处理参数。 */
export type OverrideKey = 'mask_grow' | 'mask_blur' | 'crop_reserve' | 'pixels' | 'align'
  | 'ref_pixels' | 'ref_align' | 'tgen_pixels' | 'tgen_align';
export const OVERRIDE_KEYS: OverrideKey[] =
  ['mask_grow', 'mask_blur', 'crop_reserve', 'pixels', 'align',
   'ref_pixels', 'ref_align', 'tgen_pixels', 'tgen_align'];

export interface ParamOverride {
  value: number;
  enabled: boolean;
}

/** 整份 Pipeline Settings。`selected` 由 Draw 页 Pipeline Settings 独家作者；
 *  `overrides` 是旧版按 pipeline **名字**存的那份覆盖 —— 覆盖能力已经搬进架构规则，
 *  后端不再读它，但这份数据既读也回写，磁盘上已有的一次都不弄丢。 */
export interface PipelineSettings {
  selected: string;
  overrides: Record<string, Partial<Record<OverrideKey, ParamOverride>>>;
}

export const EMPTY_PIPELINE_SETTINGS: PipelineSettings = { selected: '', overrides: {} };

/** 一条架构规则：拿 `architecture` 当正则去匹配本次 run 那条 pipeline 的架构
 *  （后端 re.search + IGNORECASE，与后端 Krea2/Flux2Klein 判据同口径）。
 *  命中的**整条**规则生效，规则里 toggle 关着的键仍继承 Default Setting；自上而下
 *  第一条命中就停，所以列表顺序就是优先级。
 *  pattern 为空或正则非法 = 这条永远不命中（后端跳过）。 */
export interface ArchRule {
  id: string;
  architecture: string;
  overrides: Partial<Record<OverrideKey, ParamOverride>>;
}

export interface ArchSettings {
  rules: ArchRule[];
}

export const EMPTY_ARCH_SETTINGS: ArchSettings = { rules: [] };

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
  /** Preprocess Settings 的 Enable Output（默认关）。开 = 这一趟的最终产出另外
   *  写一张 PNG 进 outputs（detailer_00001_.png），`parameters` chunk 与
   *  SnapshotPromptNode 的 Cache 同形，可被 Load From Image 读回。整幅 Run 与
   *  图层 Generate 都算「这一趟的最终产出」，落不落盘只看这颗开关。 */
  enable_output?: boolean;
  /** Preprocess Settings 的 Dynamic Layer 总闸（默认关）。开 = 这个 preset 的 ▶ Run 不再
   *  直接跑整幅链：工作台进入框选模式，用户拖完框跳过分辨率弹窗直接建出 Dynamic Layer，
   *  并立刻在该层上自动 Generate（跑的就是刚点的这条链）。Esc 取消 = 什么也不跑。 */
  enable_dynamic_layer?: boolean;
  /** Dynamic Layer 的 Layer Limit（默认开）。开 = 建层分辨率自动按 DEFAULT SETTING 的
   *  Pixels 预算算（rate = √(Pixels ÷ 框面积)，与分辨率弹窗里的 Limit 勾选同一公式）；
   *  关 = rate 1，层按框的原生像素建。仅 Dynamic Layer 开时生效。 */
  dynamic_layer_limit?: boolean;
  /** Dynamic Layer 的 Layer Context（默认开）。开 = 自动 Generate 用框下方所有图层的
   *  合成当 context（img2img）；关 = 新层是空的，context 落到该层分辨率上的噪声
   *  （框内纯 txt2img）。仅 Dynamic Layer 开时生效。 */
  dynamic_layer_ctx?: boolean;
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

/** Tagger 块：对链中当前图（上一块的输出）跑 tagger，把 tag 追加到 user_positive ——
 *  只影响其后的 detailer（后续 prompt/query 块替换 prompt 时自然被替换掉）。
 *  mode: mask = 裁 mask 区域打标；covered = mask 区域合成到白底打标；full = 整图打标。
 *  mask/covered 在链中该位置没有 mask = 报错中止整条链。 */
export interface TaggerBlockParams {
  mode: 'mask' | 'covered' | 'full';
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
  type: 'detailer' | 'interface' | 'prompt' | 'query' | 'tagger' | 'scale';
  name: string;
  params: DetailerBlockParams | InterfaceBlockParams | PromptBlockParams | QueryBlockParams | TaggerBlockParams | ScaleBlockParams;
  interface_index?: number;
  exec_options?: InterfaceExecOptions;
}

/** Scale 块：把链上当前工作图按比例缩放并落 Align 格 —— 语义对齐 DEFAULT SETTING 的
 *  limit_pixels（宽高各自乘 scale 后就近吸附到 align 像素格；scale=1 时只落格不缩放）。
 *  只影响其后的 block：缩放后的尺寸就是后续 detailer 的采样分辨率；收尾仍按原 Recover
 *  契约落回画布（Recover Crop 开 → 复原到裁剪尺寸后贴回全图；关 → patch 保留缩放后的
 *  工作分辨率，随 place 交给前端变换贴回）。 */
export interface ScaleBlockParams {
  /** 缩放比例：1 = 不缩放（仍会落 align 格），>1 放大，<1 缩小 */
  scale: number;
  /** Use Pipeline Align 关时生效的块级像素格（同 limit_pixels 的 align；QwenImage2.1 会自动抬到 32） */
  align: number;
  /** 开（默认）：沿用 pipeline 的 align（DEFAULT SETTING 那一份，链首同一来源）；
   *  关：用块自己的 align。 */
  use_pipeline_align?: boolean;
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
  /** 同一趟里 lora_regex 也可能换了代：Prompt tab 的 LoRA 灰名单要跟这一枚 */
  pipeline_lora_epoch?: number;
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
 * it (the Tag buttons live in its toolbar). `context` and `pipeline` followed them — the pipeline
 * switch lives in the Draw panel's Pipeline Settings section now, and nothing in the workbench
 * reads a separately-selected context image any more.
 * `settings` is the numeric home: the Default Setting (nine values) plus the architecture rules
 * that may override them, taken out of the Draw panel so the workbench gets the width back.
 */
export type Tab = 'prompt' | 'draw' | 'interface' | 'settings';

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
  /** image/mask 出口的默认落位（键 = 端口号字符串），Processor 小窗拿它当初值。 */
  output_targets?: Record<string, string>;
  /** image/mask 入口的默认来源（键 = 端口号字符串），Processor 小窗拿它当初值。 */
  input_sources?: Record<string, string>;
}

/** Processor 输出落位的四个去处（blend_node 的 PROCESSOR_DST_* 表同名）。 */
export type ProcessorDst = 'new_layer' | 'selected_layer' | 'selected_mask' | 'staging';

/** Processor 输入来源的七个去处（blend_node 的 PROCESSOR_SRC_* 表同名）。 */
export type ProcessorSrc = 'layers' | 'selected' | 'staging' | 'main_mask' | 'selected_mask' | 'selected_alpha' | 'mask_alpha';

/** 一个 interface 的持久化配置（blocks_sets.json 的 interface_meta 键，按包名索引）。
 *  端口名只是展示 —— 执行全程按端口号走。names 的键是端口号字符串。 */
export interface InterfaceMetaEntry {
  names?: { start?: Record<string, string>; end?: Record<string, string> };
  modes?: { block: boolean; processor: boolean };
  block_ports?: { in?: number; out?: number };
  /** image/mask 出口的默认落位（键 = 端口号字符串），后端归一化时按枚举收敛。 */
  output_targets?: Partial<Record<string, ProcessorDst>>;
  /** image/mask 入口的默认来源（键 = 端口号字符串），后端归一化时按枚举收敛。 */
  input_sources?: Partial<Record<string, ProcessorSrc>>;
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
  key: 'enable_mask' | 'enable_fit' | 'enable_dynamic_layer' | 'dynamic_layer_limit' | 'dynamic_layer_ctx',
  dflt: boolean,
): boolean {
  const set = blockSets.find(s => s.id === setId) || blockSets[0];
  const fd = set?.blocks.find(b => b.type === 'detailer');
  const dp = fd ? (fd.params as DetailerBlockParams) : undefined;
  return dp ? (dp[key] ?? dflt) : dflt;
}

/** 工作台里打开着的每一份 .cud。文档本体、历史、合成全在 iframe 里，宿主只画它的 dock 窗口：
 *  `uid` 既是文档单元的名字来源(doc:<uid>)，也是 activate / close 的句柄。工作台页面重载后
 *  uid 从 1 重新发，所以记住的摆位从不替一个文档留窗口。 */
export type BlendDoc = { uid: number; name: string; kind: string | null; dirty: boolean; path: string | null };

/** 一次播报的全量快照：开着的文档、哪一份是当前活动文档、以及有没有一个 IO 动作把文档锁住
 *  （锁住 = File 的六个动作全灰）。`announced` 是"这是不是第一份播报"：宿主页面加载后、工作台
 *  第一次播报前，开文档集是**未知**而不是空 —— 布局要按未知对待（画布窗口的位置留在存档里），
 *  按空集处理会在刷新时把画布每次都对回默认位置。 */
export type BlendDocs = { activeUid: number | null; busy: boolean; docs: BlendDoc[]; announced: boolean };

export const EMPTY_BLEND_DOCS: BlendDocs = { activeUid: null, busy: false, docs: [], announced: false };

/** 宿主顶栏与文档窗口 tab 发回工作台的文档动作 —— 与 iframe 里 DOC_COMMANDS 的八个键一一对应。 */
export type BlendDocCommand = 'new' | 'load' | 'save' | 'save-as' | 'export-png' | 'import' | 'activate' | 'close';

/** 工作台把图层 / 工具 / 属性面板交还给宿主渲染时要读的状态：一次播报的全量快照。
 *  标题条那句说明在注册表里，不在这里 —— 页面只在这句真会随状态改写时（Brush 落点、Mask 目标）
 *  才把它补进快照，那一格搬过来时再加字段，不预先修一条没人读的通道。 */
/** 一颗笔形工具（Brush / Eraser 同族）的读数：模式决定哪几根旋钮有可见差别，所以三块面板共用一条。 */
export type BlendPen = { mode: string; size: number; strength: number; center: number; edge: number; gamma: number };

/** 条带上的一枚 attribute。`face` 是这一枚在快照 `faces` 里的键（链没有面，所以交空串）；`glyph` 是
 *  它没有面时**仍然要画**的那枚记号 —— 只有 effects 那一类有，内容是 fx 注册表自己的魔棒 SVG，
 *  与页面 `ATTR_KINDS.chain.chip` 画的是同一位作者。`badge` 是 attribute 注册表自己报的那枚类型角标
 *  —— 注册表还住在页面那一侧，原样交过来就是唯一一份。`title` 只有真值源那一句，"Ctrl+click …"那半句
 *  是面板的措辞，归这一侧。 */
export type BlendAttrChip = {
  guid: string; type: string; label: string; kind: string; chipClass: string;
  badge: string; badgeClass: string; face: string; glyph: string; enabled: boolean; armed: boolean; title: string;
};

/** 一条特效链里的一步。`icon` 与 `readout` 都由页面的 fx 注册表算好（图标库与那句读数都还在那边）。 */
export type BlendChainStep = { id: number; type: string; label: string; icon: string; readout: string; enabled: boolean };

/** 摊在图层行上方的那条链容器。空链不占位，所以 `steps` 永远至少一步（页面交数组那一趟就是这么过滤的）。 */
export type BlendChainLane = { guid: string; bypass: boolean; skip: string; steps: BlendChainStep[] };

/** 条带末尾那颗 `+` 菜单里的一类 attribute。顺序就是页面注册表的声明序，`addTitle` 是注册表自己那句
 *  （它没写过才是页面那句模板补的）—— 有哪几类、加进去会做什么，只有注册表答得出。`kind` 是注册表
 *  的分支（surface / chain / generator）：只有 surface 那一类（decal / mask）带 frameTrack，视频模式下
 *  加入前要问"绑哪条 video 轨"，所以这一侧得认得出来。 */
export type BlendAttrKind = { type: string; label: string; addTitle: string; kind: string };

/** 右键菜单每一条的出现/灰掉所问的那六个谓词。菜单归宿主摆（拍板 5.a），但这些事实只有页面答得出：
 *  `genHasImg` 与行上 ▶ 那句用的不是同一个判据（方向层恒算有图，哪怕还没墨），`cudDocOpen` 问的是
 *  "那个项目此刻开着"，与 `cudLinked`（链接注册表）不同源。条目文案与位置全在 React 那一侧。 */
export type BlendRowMenu = {
  genHasImg: boolean; hasBuffer: boolean; canvasReady: boolean;
  groupSize: number; hasText: boolean; cudDocOpen: boolean;
};

/** 一行属于哪一摞。交的是页面自己那两个字面量（`WORK_STACK` / `GUIDANCE_STACK`），不是宿主 dock 的
 *  单元名 —— 跨摞拖行与"从工作区落进哪一格"回发的都是这一句，两边因此不可能各造一套名字。 */
export type BlendStack = 'layer' | 'guidance';

/** 图层行 = 一行描述符。缩略图一律是键：真正的像素走 `BlendUi.faces`，见页面的 face 通道。
 *  `badgeSvg` 是那枚类型角标本身的画法（七支，认的是图层谓词），与 attribute 的 `badge`、链里那枚
 *  `icon` 同一套规矩：画法由页面那位唯一作者交过来，配色与摆位归这一侧的 CSS。 */
export type BlendLayerRow = {
  id: number; name: string; kind: string; badgeSvg: string; stack: BlendStack; cudName: string; cudLinked: boolean;
  selected: boolean; grouped: boolean; visible: boolean; canGen: boolean; hasImg: boolean;
  native: { w: number; h: number }; orig: string; canvas: string; hover: string;
  menu: BlendRowMenu;
  attrs: BlendAttrChip[]; chains: BlendChainLane[];
};

export type BlendHistoryStep = { i: number; label: string; face: string; current: boolean };

export type BlendHistory = {
  limit: number; canUndo: boolean; canRedo: boolean; steps: BlendHistoryStep[];
};

/** 参数面里的一行。页面按 fx 注册表把**那一步**声明的旋钮编成这一串 —— `when` 过滤、`kind:'fold'` 的
 *  组内组外、贴图/方向槽的绑定状态全在页面判（判据只有注册表答得出），宿主只按 `kind` 画控件。
 *  所以这里交的是画它要的全部事实，一行都不留"回过来问页面"的口子：值、读数、选项的显示文本、
 *  绑没绑、绑的那张图此刻还在不在。十种 kind 就是注册表里那十种行的画法（`range` 是 def.kind 缺省
 *  那一支；`lattice` 与 `curve` 是原来两块专用编辑面剩下的两块真内容 —— 专用编辑面这个概念已经没了）。 */
type BlendFxRowBase = { key: string; label: string; tip: string; readout: string };
export type BlendFxRow =
  | (BlendFxRowBase & { kind: 'fold'; open: boolean })
  | (BlendFxRowBase & { kind: 'range'; value: number; min: number; max: number; step: number })
  | (BlendFxRowBase & { kind: 'check'; flag: boolean })
  | (BlendFxRowBase & { kind: 'flag'; flag: boolean; onText: string; offText: string })
  | (BlendFxRowBase & { kind: 'color'; value: string })
  | (BlendFxRowBase & { kind: 'enum'; value: string; options: string[]; labels: string[] })
  | (BlendFxRowBase & { kind: 'map'; role: string; optional: boolean; bound: boolean; missing: boolean; title: string })
  | (BlendFxRowBase & { kind: 'dir'; bound: boolean; missing: boolean; title: string; types: string[] })
  | (BlendFxRowBase & { kind: 'lattice'; hasGrid: boolean; active: boolean; editLabel: string; hint: string })
  | (BlendFxRowBase & { kind: 'curve';
      channels: { value: string; label: string }[]; channel: string;
      points: [number, number][]; lut: [number, number][]; minGap: number });

/** 此刻展开参数的那一步（一趟最多一步 —— `fxOpenId` 那一个变量说的就是它）。`rows` 按声明序，
 *  折叠头后面跟着它组里的行；坐标三样就是宿主回发时带回来的那三样。 */
export type BlendFxOpenStep = {
  layerId: number; attrId: string; stepId: number;
  type: string; label: string; readout: string; rows: BlendFxRow[];
};

/** 参数面上每一句回发的坐标：哪一层、哪一枚 Effects 容器、链里的第几步。三样缺一就落不到那一步上。 */
export type BlendFxCoord = { layerId: number; attrId: string; stepId: number };

/** 笔尖此刻落在那一枚**面**（decal / mask）上时，Effect Parameters 那一格摆的就是它的参数：
 *  Frame source 的绑定与可回发的坐标。`trackId` 是记录自己的 `frameTrack`（'' = 用画好的面）；
 *  轨道列表归宿主（它在管 Video 工程），不在这一份里。 */
export type BlendAttrOpen = {
  layerId: number; attrId: string; type: string; label: string; trackId: string;
};

/** ---- 工具面板（原来挂在页面侧栏那六格：Text / Geometry / 3D / Pose / Detector / Processor）----
 *  每格正文从这一份快照读、按下去发的是一条动作键 —— 与画布那几格同一套边界，只是这几格的控件比
 *  按钮多一点（滑杆 / 颜色 / 枚举 / 输入框），所以形状也照着那几样的真值源写。 */

/** Text 那一格：选中层最左那枚 Text 记录的样子，页面 `updateTextPanel` 原来摆给 DOM 的那几样。
 *  `on` = 选中的层带一枚 Text 步骤（那一格因此点亮，字本身仍在画布上双击改）。`fontLabel` 是那一行
 *  按钮上的字，`fontFace` 是它自己那张脸（按钮就用它画），`fontMissing` = 本机没有这个字体（按钮转红，
 *  与缺失贴图同一套告警色）。`color` 是 6 位 hex —— 颜色输入的取值、色块和右边那句读数都由它来。 */
export type BlendTextUi = {
  on: boolean; fontLabel: string; fontFace: string; fontMissing: boolean;
  padding: number; weight: string; color: string;
};

/** geometry 家族（direction / point / ray / plane）一枚记录此刻的形状 —— 世界位置、四元数朝向、
 *  本色。与页面 `attr/geometry.js` 的 desc 同一套（页面那一侧的 `sanitizeDirectionDescriptor` 是唯一
 *  的形状裁定），这里是它的只读镜像。 */
export type BlendGeometryDesc = {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  color: string;
};

/** Geometry 那一格：选中层那枚 geometry 家族记录的舞台与读数。`on` = 有这枚记录（那一格因此点亮、
 *  摆出 three.js 舞台）。`desc` 就是上面那份镜像 —— 舞台、六格数字、色块与 Reset 读的都是它。
 *  `ref` 是画布平面贴的那张参考图（此刻的 context image，唯独不含正在编辑的这一枚，页面缩到 ≤384
 *  的 PNG；`refVersion` 只在参考图真变过之后才 ++，所以寻常一帧里字符串与版本都不动）。`canvasW/H`
 *  是**文档画布**尺寸 —— 平面的比例由它折出，与舞台自己的取景框无关。相机轨道与 W/E/X 把手模式
 *  是纯视图状态，住在宿主，不进这一份。 */
export type BlendGeometryUi = {
  on: boolean;
  kind: string | null;
  desc: BlendGeometryDesc | null;
  ref: string;
  refVersion: number;
  canvasW: number;
  canvasH: number;
};

/** Pose 记录此刻的形状 —— 与页面 `attr/pose.js` 的 `sanitizePoseDescriptor` 同一套（页面那一侧是唯一
 *  的形状裁定），这里是它的只读镜像。形态七参 / 姿态（骨头角 + 骨位 + 模型旋转）/ 捕获取景（FOV 30、
 *  dist 45）/ 皮肤档 / 颜色 / 背景（null = 透明底）。 */
export type BlendPoseDesc = {
  mesh: {
    age: number; gender: number; weight: number; muscle: number;
    height: number; breast_size: number; firmness: number; show_genitals?: boolean;
  };
  pose: {
    bones: Record<string, [number, number, number]>;
    bonePositions: Record<string, [number, number, number]>;
    modelRotation: [number, number, number];
  };
  cam: { yaw: number; pitch: number; zoom: number; offsetX: number; offsetY: number };
  skin: string;
  color: string;
  bg: [number, number, number] | null;
};

/** Pose 那一格：`on` = 选中层带一枚 Pose 步骤（那一格因此点亮、摆出 three.js 舞台）。`desc` 就是上面
 *  那份镜像 —— 舞台（形态装配 + 姿态 + 捕获取景）、七颗滑块、皮肤三档、颜色、背景、取景五格、Reset 与
 *  From image 读的都是它。`layerW/H` 是目标层的**原生**像素尺寸 —— 舞台那条黄线取景框按它的比例画
 *  （框就是输出的边界），与舞台自己的取景框无关。相机轨道、关节选中、把手拖动是纯视图状态，住在宿主，
 *  不进这一份。 */
export type BlendPoseUi = { on: boolean; desc: BlendPoseDesc | null; layerW: number; layerH: number };

/** 3D 那一格：选中层那枚 3D 记录的跳转与状态（`update3DPanel` 原来那三句话）。`on` = 有这枚记录，
 *  `canOpen` = 它带着一个还能进去的 sceneUid（没有就整颗 Open Scene 灰掉），`note` 是那句状态 ——
 *  措辞由页面按"烘了没有 / 场景 tab 还在不在"现拼，宿主只负责摆出来。 */
export type BlendScene3dUi = { on: boolean; canOpen: boolean; note: string };

/** Detector 那一格：detector 输入连着时才有得用。`available` 来自宿主的 hasDetector（不连时那一格
 *  就是一句空态，页面原来是把整节 display:none 掉）；其余三样是小窗里那三颗控件此刻的取值 —— 它们
 *  住在页面，宿主摆的是镜像，每次落值都走动作键回来。 */
export type BlendDetectorUi = { available: boolean; prompt: string; threshold: number; invert: boolean };

/** Processor 那一格的一枚候选（来源 / 落位共用一份形状）：值和它那张卡上的短名 + 说明。 */
export type BlendProcChoice = { value: string; label: string; tip: string };

/** 一行输入口（image / mask）：它叫什么、那句类型说明，和这一行此刻选中的来源 + 可选项。选了 Staging
 *  的 image 输入多带一份工作区条目表（`staging`），null = 这一行不是那种情况。 */
export type BlendProcInRow = {
  num: number; name: string; hint: string; options: BlendProcChoice[]; cur: string;
  staging: { options: { id: string; name: string }[]; cur: string } | null;
};

/** 一行参数（这个接口带的 widget）。控件跟着类型走 —— `bool` / `number` / `text` / `choices`（≤3 枚
 *  分段按钮）/ `select`（候选多到一行铺不开）。`value` 是页面按"拧过没有"算出来的取值（数字与文字
 *  统一成字符串发过来，bool 读 `on`）；`tip` 是那句说明（它把"图里派生的那个值"也写进去了，由页面现拼）；
 *  `options` 只有枚举那两档才有，候选的说明（"the value the graph carries"）也随它一起来。 */
export type BlendProcParamRow = {
  num: number; name: string; tip: string;
  kind: 'bool' | 'number' | 'text' | 'choices' | 'select';
  on: boolean; value: string; step: string; placeholder: string;
  options: BlendProcChoice[]; cur: string;
};

/** 一行输出口（image / mask / pipeline）：落位的候选与此刻选中。 */
export type BlendProcOutRow = {
  num: number; name: string; hint: string; options: BlendProcChoice[]; cur: string;
};

/** Processor 那一格的全部状态。`names` 是 interface 枚举（按声明序），`indices` 与它平行 —— 每枚接口
 *  的后端 package 下标，换 interface 时把这个下标连同名字发回去（名字会撞，位置会漂，下标不会）。
 *  `choice` 是列表里的位置（-1 = 一个都没有，那一格给一句空态）；三段行由页面按当前 interface 现拼 ——
 *  段为空就不出现（与页面那三句 `if (inPorts.length)` 一字不差）。行里的每一颗控件都是页面那一段 DOM
 *  的等值物。 */
export type BlendProcessorUi = {
  names: string[]; indices: number[]; choice: number;
  inputs: BlendProcInRow[]; params: BlendProcParamRow[]; outputs: BlendProcOutRow[];
};

/** Staging 那一格（画布底部那条工作区整条搬进宿主后合成的一格）：Extra Prompt 的序列化文本 + 那一格
 *  要亮的按钮 / 那根进度条读的几个布尔。
 *  条目表**不在**这一格里 —— 工作区权威在宿主（App.staging 从 /api/staging 拉），条目、上传、删除都不
 *  过页面。两张钉卡的预览也不在这里：Context 用宿主已收到的 `blendPreview`，Guidance 用图池里
 *  `staging_guidance` 那一张（页面本来就把它传进图池）。
 *  `prompt` 是唯一与页面共享的真值源：页面存它（.cud / run payload 都读它），宿主摆的是镜像；编辑的
 *  那一下走 `staging-prompt` 回来。`busy` = 有一趟 run 在飞（Blend/Tag 都灰）、`cancelLive` = 这一趟是
 *  detailer（Cancel 才浮出来）、`progress` 是那根条此刻的宽度（-1 = 未知，画成一段不定进度）。 */
export type BlendStaging = {
  prompt: string;
  placeholder: string;
  busy: boolean;
  cancelLive: boolean;
  progress: number;
  hasTagger: boolean;
};

export type BlendUi = {
  /** 工作台当前工具，页面 `mode` 那颗变量的镜像（'transform' | 'rect' | 'lasso' | 'pan' | 'zoom'
   *  | 'rotate' | 'canvasModify' | 'none' …）。一颗变量喂六个高亮，所以只镜像它本身。 */
  mode: string;
  canvas: { w: number; h: number };
  transform: { readout: string };
  /** 缩放 · 角度 ·（翻转），页面把三个数拼成一句的那串。 */
  view: { readout: string };
  /** 这一笔落在哪一层/哪一面，页面原来用三个谓词现拼 tooltip 那句；措辞搬到 React 一侧，
   *  所以快照只给谓词，不给整句 —— 一句说明留一个作者。`ring` 是色环此刻的取值，页面算光标环
   *  用的是同一句 paintRGBA()，两边因此不会各说一套。 */
  paint: { maskLayer: boolean; decal: boolean; tool: string; selection: boolean; ring: string };
  tools: { brush: BlendPen; eraser: BlendPen; bucket: { tolerance: number; continuous: boolean; allLayers: boolean } };
  /** 调色盘那一格的全部状态。刻意不传 HSV —— 传的是页面自己那五个变量的原样（两颗 hex、两个
   *  Alpha、一份单独存着的色相方向、盘式），盘上怎么画、拖出什么颜色，由边界这一侧用**同一份**
   *  算术算出来（workbench/colour.ts，函数体逐字节相同，门禁相比）。灰/黑/白反解不出方向，所以
   *  hue 必须单独传 —— 少了它，拖到黑再拖回来方向就丢了，那是页面早年踩过的坑。 */
  color: { fg: string; bg: string; fgAlpha: number; bgAlpha: number; hue: number; mode: string };
  /** Mask 那一格（页面原来的 #maskSection + #maskDock 合成一格）。它选中与否读的是 paint.maskLayer，
   *  这一格里没有第二份。剩下的两颗仍是真值源：那颗层的显示开关，和它那张覆盖面 —— 覆盖面是这一页
   *  绘制引擎里的活位图，宿主页画不出它，所以像素必须过边界，这是这一列里第一格需要传像素的面。
   *  `still` 只在面真的动过时才重编（按 surface 身份 + paintGen 失效），编成 84 边长的 PNG；没动过时
   *  快照里那句字符串一字不差，queueBlendUi 的等值去重因此整条都不发。 */
  mask: { visible: boolean; still: string };
  /** Layers / Guidances 两格的两摞行。这里只有描述符：谁、挂着哪几枚 attribute、链里有哪几步、哪一颗
   *  该亮。文字、摆法、空态那句、七种类型角标都在这一侧；页面留的是谓词与真值源。 */
  stacks: { layers: BlendLayerRow[]; guidances: BlendLayerRow[] };
  /** 两格头部那颗「看加特效前的原样」开关的读数 —— 页面自己那份状态，宿主亮的就是它。链里每一步也带
   *  同一个布尔（`BlendChainLane.bypass`），但一枚容器都没挂的时候，头部那颗按钮仍要知道自己按下去没有。
   *  `wand` 是这颗按钮的画法等值：它不能由 React 自己抄一份魔棒 SVG（那是第二份真相），所以由页面把
   *  `fxWandSvg()` 的原串放进快照 —— 条带上那枚链 chip 用的是同一个作者，一次赋值就不再变。 */
  fx: { bypass: boolean; wand: string; open: BlendFxOpenStep | null };
  /** 笔尖落在那一枚面 attribute（decal / mask）上时的参数面。链没有展开时，Effect Parameters 那一格
   *  摆的就是这一枚的 Frame source 下拉；链展开时 `fx.open` 占位（一次只摊一块参数面）。 */
  attrOpen: BlendAttrOpen | null;
  /** Layers 那一格 Add 菜单里那条「往后的图是 raster 还是 smart object」的勾。它是页面那一份持久偏好
   *  （`blend.rasterDrop`）的镜像 —— 宿主只管摆这条目与亮这颗勾，翻开与否落在页面那一句里。 */
  rasterDrop: boolean;
  /** 条带末尾那颗 `+` 的菜单条目（注册表的声明序）。boot 之前它是空表 —— 与页面同一个样子：那一格
   *  菜单在没有快照时没有任何条目可摆。 */
  attrKinds: BlendAttrKind[];
  /** History 那一格。步子住在页面那两支摞里（undo/redo），这里只收一份列子：`i` 就是 `history-jump`
   *  认的下标（redo 那一头按重做的先后排在 undo 之后），`label` 是那一步进栈时带上的那句话，`face`
   *  是这一步在 `faces` 里的键 —— 预览 PNG 在**那一步刚落地**那一趟编好、从此不再动（画面后来往前走
   *  也改不到它），所以它和行面共用同一道可见区/封顶闸，但一次都不重编。`limit` 与那两颗开关的读数
   *  同样出自页面（HISTORY_LIMIT 写死 60），这里不数步子。 */
  history: BlendHistory;
  /** ---- 六格工具面板 ---- */
  /** Text：选中层那枚 Text 步骤的四样读数（字体、padding、字重、颜色），和"这一格该不该亮"。 */
  text: BlendTextUi;
  /** Geometry：选中层那枚 direction/point/ray/plane 记录的世界形状 + 舞台参考图。 */
  geometry: BlendGeometryUi;
  /** Pose：选中层那枚 Pose 记录的形态/姿态/取景/皮肤形状 + 目标层原生尺寸。 */
  pose: BlendPoseUi;
  /** 3D：选中层那枚 3D 记录的跳转与状态那三句话。 */
  scene3d: BlendScene3dUi;
  /** Detector：总闸 + 小窗那三颗控件的取值。 */
  detector: BlendDetectorUi;
  /** Processor：interface 枚举与三段端口行。 */
  processor: BlendProcessorUi;
  /** Staging：画布底部那条工作区（Extra Prompt + Blend/Tag + 图池条 + Cancel / 进度）整条搬进宿主后合成的一格。 */
  staging: BlendStaging;
  /** 缩略图本身（键 → data URL）。它是**增量**：一条快照只装这一帧新要给的几张，发完页面就清；
   *  宿主按键合并成一份 store（不住 React 树里，见 workbench/faces）。判据是逐张失效 + 只编可见区 +
   *  每帧封顶 —— 40 行 × 6 枚最坏一档两兆多一帧，那是把 postMessage 当显存用。 */
  faces: Record<string, string>;
};

export const EMPTY_BLEND_UI: BlendUi = {
  mode: 'none', canvas: { w: 0, h: 0 }, transform: { readout: '' }, view: { readout: '' },
  paint: { maskLayer: false, decal: false, tool: 'brush', selection: false, ring: '' },
  tools: {
    brush: { mode: 'exponential', size: 40, strength: 1, center: 1, edge: 0, gamma: 2 },
    eraser: { mode: 'exponential', size: 60, strength: 1, center: 1, edge: 0, gamma: 2 },
    bucket: { tolerance: 0.2, continuous: true, allLayers: false },
  },
  // 与页面那三颗初值一字不差：第一条快照没到之前，格子也得报一个真颜色。
  color: { fg: '#ff3b30', bg: '#ffffff', fgAlpha: 1, bgAlpha: 1, hue: 0, mode: 'rgba' },
  // 这一格选中与否读的是 paint.maskLayer（它就是 selectedId === MASK_LAYER_ID），所以这里不再存第二份。
  mask: { visible: true, still: '' },
  // 第一条快照没到之前，两格各是一摞空行 + 一张面都没有 —— 与页面 boot 那一次播报同一个样子。
  stacks: { layers: [], guidances: [] },
  // 第一条快照没到之前，头部那颗开关是按下与否都还没说过 —— off，魔棒还没有画法可摆（空串就是不画），
  // 参数面也没有一步摊着（open = null 就是"这一列里没人展开"）。
  fx: { bypass: false, wand: '', open: null },
  // 第一条快照没到之前，笔尖没有落在任何一枚面上 —— 参数面与页面 boot 那一次播报同一个样子。
  attrOpen: null,
  // 页面的初值是 off（localStorage 没有记过就是 smart object），boot 那一次 syncRasterToggleUI 会把
  // 真值补进快照 —— 在那之前这一格也不该亮着勾。
  rasterDrop: false,
  attrKinds: [],
  // boot 之前没有任何步子可列：页面第一次播报（resetHistory 那一句）会把这一步自己补成列子的头一条。
  history: { limit: 0, canUndo: false, canRedo: false, steps: [] },
  // 六格工具面板：第一条快照没到之前，各格都是"还没有人在编辑"那个样子 —— 与页面 boot 那一次播报相同。
  // Text 的字体名给 '—'（页面 textFontLabel 对不上那一支的回落字），字号 / 字重 / 颜色照描述符初值。
  text: { on: false, fontLabel: '—', fontFace: '', fontMissing: false, padding: 0, weight: 'normal', color: '#ffffff' },
  // Geometry 空态：没有 geometry 记录、没有参考图、画布尺寸为 0 —— 与页面 boot 那一次播报同一个样子。
  geometry: { on: false, kind: null, desc: null, ref: '', refVersion: 0, canvasW: 0, canvasH: 0 },
  // Pose 空态：没有 Pose 记录、没有层面尺寸 —— 与页面 boot 那一次播报同一个样子。
  pose: { on: false, desc: null, layerW: 0, layerH: 0 },
  // 3D 与 Detector / Processor 一律空态：没有记录 / 没有 detector / 一个 processor interface 都没有。
  scene3d: { on: false, canOpen: false, note: '—' },
  detector: { available: false, prompt: '', threshold: 0.5, invert: false },
  processor: { names: [], indices: [], choice: -1, inputs: [], params: [], outputs: [] },
  // Staging 空态：Extra Prompt 空着（占位句照页面那条 data-placeholder），没有 run 在飞、进度条不显，
  // Tagger 默认在（blend-config 那一次播报会把真值补上）。
  staging: {
    prompt: '',
    placeholder: 'Extra prompt — appended after the prompt stage (Run only). Click a staging item below to insert an image at the cursor.',
    busy: false, cancelLive: false, progress: -1, hasTagger: true,
  },
  faces: {},
};

/** React 面板发回工作台的动作 —— 与 iframe 里 UI_COMMANDS 的键一一对应（门禁逐键对表，119 条）。旋钮类带
 *  value，开关类不带（点了就是点一下，没有取值）。
 *  行上那一批（一行、条带上的一枚、链里的一步、历史的一步）载荷一律是**坐标**：哪一层、哪一枚、第几步、
 *  落在谁的哪一侧 —— 本体永远留在页面那一侧。链里那一步的**参数面**（新添的 10 条：展开/收起、两笔落值、
 *  折叠开合、贴图与方向两类绑定、扭曲网格三颗钮、曲线那一格的全部手势）同样只交坐标 + 那一行的 key：
 *  行有什么、值是什么，由页面按 fx 注册表现编（快照 `fx.open.rows`），这里不存在第二份旋钮清单。
 *  `'visible-faces'` 仍压在最末：它是一条通道而不是一颗按钮，而且门禁钉的就是"`| 'visible-faces';`"这一句
 *  在联合类型的最末 —— 顺序没有语义，动了它反而要重钉一条本来就成立的判据。 */
export type BlendUiAction =
  | 'canvas-size' | 'canvas-modify' | 'canvas-resize' | 'layer-set'
  | 'transform-adjust' | 'transform-fill'
  | 'select-rect' | 'select-lasso' | 'select-all' | 'select-none'
  | 'view-pan' | 'view-zoom' | 'view-rotate' | 'view-fit' | 'view-reset'
  | 'view-zoom-in' | 'view-zoom-out' | 'view-rot-ccw' | 'view-rot-cw' | 'view-flip'
  | 'brush-mode' | 'brush-size' | 'brush-strength' | 'brush-center' | 'brush-edge' | 'brush-gamma'
  | 'eraser-mode' | 'eraser-size' | 'eraser-strength' | 'eraser-center' | 'eraser-edge' | 'eraser-gamma'
  | 'bucket-tolerance' | 'bucket-continuous' | 'bucket-all-layers'
  | 'paint-color' | 'paint-alpha' | 'paint-hue' | 'paint-mode' | 'paint-swap'
  | 'mask-invert' | 'mask-layer-invert' | 'mask-layer-full' | 'mask-layer-clear'
  | 'mask-layer-eye' | 'mask-layer-select'
  | 'layer-select' | 'layer-rename' | 'layer-jump' | 'layer-generate' | 'layer-eye'
  | 'layer-remove' | 'layer-duplicate' | 'layer-expand' | 'layer-fit-mask' | 'layer-split-mask'
  | 'layer-rasterize' | 'layer-text-edit' | 'layer-combine' | 'layer-move'
  | 'layer-add' | 'layer-clear' | 'raster-drop' | 'hover-face'
  | 'cud-refresh' | 'cud-relink'
  | 'attr-open' | 'attr-toggle' | 'attr-remove' | 'attr-duplicate' | 'attr-apply' | 'attr-add' | 'attr-move'
  | 'attr-frame-source'
  | 'fx-step-toggle' | 'fx-step-remove' | 'fx-step-move' | 'fx-bypass'
  | 'fx-step-open' | 'fx-param-live' | 'fx-param-commit' | 'fx-fold-toggle'
  | 'fx-map-pick' | 'fx-map-bind' | 'fx-dir-pick' | 'fx-dir-bind' | 'fx-lattice' | 'fx-curve'
  | 'history-undo' | 'history-redo' | 'history-jump' | 'history-clear'
  | 'text-font' | 'text-padding' | 'text-weight' | 'text-color'
  | 'geometry-desc' | 'geometry-commit' | 'geometry-reset'
  | 'pose-desc' | 'pose-commit' | 'pose-reset-pose' | 'pose-reset-all' | 'pose-from-image'
  | 'scene3d-open'
  | 'detector-prompt' | 'detector-threshold' | 'detector-invert' | 'detector-run'
  | 'processor-interface' | 'processor-pick' | 'processor-staging' | 'processor-param'
  | 'processor-run' | 'processor-reset'
  | 'staging-prompt' | 'staging-blend' | 'staging-tag' | 'staging-cancel'
  | 'stage-layer' | 'layer-from-staging'
  | 'visible-faces';

/** 每个动作键的载荷形状，一条边界一个作者：`undefined` = 这一条不需要取值。
 *  它是这张边界的**唯一**一份形状说明 —— 页面落点 (`UI_COMMANDS` 里那五句 `uiRow`/`uiLayer`/`uiAttr`/
 *  `uiFxStep`/`uiStack`) 逐个字段读回来并当场夹，所以这里写严一点漏不掉什么；反过来，这里漏一个键、
 *  或多一个键，`BLEND_UI_PAYLOAD_COVERAGE` 那一句就编译不过。 */
export type BlendUiPayloads = {
  'canvas-size': undefined;
  'canvas-modify': undefined;
  /** 直接设画布尺寸（宿主侧那两颗输入框用）：Video 模式下活画布的弹窗看不见窗口外，
   *  所以给一条带值的路，落地仍是页面同一个 setCanvasSize。 */
  'canvas-resize': { w: number; h: number };
  /** 切到某套图层（Video 的 Layer 段）。`key: ''` = 回到文档主图层。 */
  'layer-set': { key: string };
  'transform-adjust': undefined;
  'transform-fill': undefined;
  'select-rect': undefined;
  'select-lasso': undefined;
  'select-all': undefined;
  'select-none': undefined;
  'view-pan': undefined;
  'view-zoom': undefined;
  'view-rotate': undefined;
  'view-fit': undefined;
  'view-reset': undefined;
  'view-zoom-in': undefined;
  'view-zoom-out': undefined;
  'view-rot-ccw': undefined;
  'view-rot-cw': undefined;
  'view-flip': undefined;
  'brush-mode': string;
  'brush-size': number;
  'brush-strength': number;
  'brush-center': number;
  'brush-edge': number;
  'brush-gamma': number;
  'eraser-mode': string;
  'eraser-size': number;
  'eraser-strength': number;
  'eraser-center': number;
  'eraser-edge': number;
  'eraser-gamma': number;
  'bucket-tolerance': number;
  'bucket-continuous': boolean;
  'bucket-all-layers': boolean;
  'paint-color': string;
  'paint-alpha': number;
  'paint-hue': number;
  'paint-mode': string;
  'paint-swap': undefined;
  'mask-invert': undefined;
  'mask-layer-invert': undefined;
  'mask-layer-full': undefined;
  'mask-layer-clear': undefined;
  'mask-layer-eye': undefined;
  'mask-layer-select': undefined;
  /** 可见区：宿主那侧 IntersectionObserver 量出来的面键全集。它是**整份**而不是增量 —— 页面拿它当闸，
   *  不在集合里的面一张都不编；发过一次就顶着，所以这条必须能传数组。 */
  'visible-faces': string[];
  /** `from` 说的是按在行的哪一处：缩略图那一下把笔交给变换，行身那一下只换选中。`shift` 按住 = 加进组。 */
  'layer-select': { id: number; from?: 'thumb' | 'row'; shift?: boolean };
  /** 头部那口 Add 菜单：一类一条，落到哪一摞由 `stack` 说。`dynamic` 是画布手势的起点（在画布上拉一个
   *  矩形再问分辨率），所以这一条发的是"开始那一下"，不是"造好一层"。 */
  'layer-add': { stack: BlendStack; kind: 'default' | 'stash' | 'dynamic' | 'cud' };
  /** Clear All：只清点那一摞（Layers 那颗不动 Guidances，反之亦然），落点仍是页面的 clearStack。 */
  'layer-clear': { stack: BlendStack };
  /** Layers 那一格 Add 菜单里那条 `menuitemcheckbox`（Guidances 的菜单没有这条）：往后的图落成 raster
   *  还是 smart object。它翻的是页面那一份持久偏好（`blend.rasterDrop`），所以这条不带值 ——
   *  菜单里那颗勾的明暗读的是快照 `rasterDrop`，不是这里。 */
  'raster-drop': undefined;
  /** Alt+悬浮那一行的**原分辨率**放大图：发的是"请给我这一行的那一张"，像素照旧走面通道
   *  （键 `layer:<id>:hover`，封顶 480）。按需的一张，不进每帧那套可见区 + 预算的算法。 */
  'hover-face': { id: number };
  'layer-rename': { id: number; name: string };
  'layer-jump': { id: number };
  'layer-generate': { id: number };
  'layer-eye': { id: number };
  'layer-remove': { id: number };
  'layer-duplicate': { id: number };
  'layer-expand': { id: number };
  'layer-fit-mask': { id: number };
  'layer-split-mask': { id: number };
  'layer-rasterize': { id: number };
  'layer-text-edit': { id: number };
  'layer-combine': undefined;
  /** `toId` 为 null = 落到这一摞的末尾（今天"拖到空列表"那一句）；`above` 是宿主量出来的上半还是下半。 */
  'layer-move': { id: number; toId: number | null; above: boolean; stack: BlendStack };
  'cud-refresh': { id: number };
  'cud-relink': { id: number };
  'attr-open': { layerId: number; attrId: string };
  'attr-toggle': { layerId: number; attrId: string };
  'attr-remove': { layerId: number; attrId: string };
  'attr-duplicate': { layerId: number; attrId: string };
  'attr-apply': { layerId: number; attrId: string };
  'attr-add': { layerId: number; type: string; trackId?: string };
  /** 面 attribute 的 Frame source：绑到哪条视频轨（'' = 解绑，仍用画好的那张面）。 */
  'attr-frame-source': { layerId: number; attrId: string; trackId: string };
  /** 条带上的一步换位置：`beforeAttrId` 是落点那一枚，`after` 说的是插它前面还是后面；为空 = 追加尾步。 */
  'attr-move': {
    attrId: string; fromLayerId: number; toLayerId: number;
    beforeAttrId?: string | null; after: boolean;
  };
  /** 那一步的 id 是数字（fx/core.js 的 ++fxSeq），页面的 `uiFxStep` 按 `x.id === stepId` 找 —— 传字符串
   *  永远找不到，那两句会静默什么都不做。所以这里钉死 number。 */
  'fx-step-toggle': { layerId: number; attrId: string; stepId: number };
  'fx-step-remove': { layerId: number; attrId: string; stepId: number };
  /** 链里的一步搬家：`index` 是宿主在那条链里量出来的落位（越靠下越早），跨层时连同记录一起交。 */
  'fx-step-move': {
    layerId: number; attrId: string; stepId: number;
    toLayerId: number; toAttrId: string; index: number;
  };
  'fx-bypass': undefined;
  /** 展开/收起**那一步**的参数面（就是 chip 上那一下点击，toggle 语义在页面 `fxOpenId` 那一句里）。
   *  一趟只有一步摊着，所以这一格不需要"是哪几行"，坐标三样就够。 */
  'fx-step-open': BlendFxCoord;
  /** 一行旋钮的两次落笔，分工与 DOM 那对 input/change 一字不差：`live` 只清缓存重画布、不记账，
   *  `commit` 才记一步历史（「某行」changed 那句由页面按 def.label 说）。值按那一行的 kind 归，
   *  第三种形状一概不收。 */
  'fx-param-live': BlendFxCoord & { key: string; value: number | string | boolean };
  'fx-param-commit': BlendFxCoord & { key: string; value: number | string | boolean };
  /** 折叠组头那一下：开合是纯 UI 状态，不进存档、不进撤销，翻完只是让组里那批行重播一次。 */
  'fx-fold-toggle': BlendFxCoord & { key: string };
  /** 贴图槽的**两个**动作：开那口选图器，和行尾那枚 ×（ref 给 null）。绑定本身落 params[slot.key]，
   *  整块替换不原地改 —— 那个对象在 undo 快照之间是共享引用。 */
  'fx-map-pick': BlendFxCoord & { key: string };
  'fx-map-bind': BlendFxCoord & { key: string; ref: { key: string; name: string } | null };
  /** 方向引用同一套：检索全项目的那口选择器，和行尾那枚 ×。这里交的是那枚记录的 guid。 */
  'fx-dir-pick': BlendFxCoord & { key: string };
  'fx-dir-bind': BlendFxCoord & { key: string; ref: string | null };
  /** 扭曲网格那一行的三颗钮：摊开（没有网格就先铺一个四边形）、收起、丢掉。 */
  'fx-lattice': BlendFxCoord & { which: 'edit' | 'hide' | 'drop' };
  /** 曲线那一格的全部手势。宿主量出归一化坐标发回来，夹 x 的那道闸、"范围外不加"那条判据、
   *  首末点删不得那一条都住在页面（fx/curves.js），所以 `settle` 不带标签 —— 那句话说的是**这一次
   *  手势**（拖点 / 拖输入黑点 / 拖输入白点），由页面记得的那一样决定，不能由下一次按的东西代它说话。 */
  'fx-curve': BlendFxCoord & {
    op: 'focus' | 'add' | 'move' | 'input' | 'remove' | 'settle' | 'reset';
    channel?: string; index?: number; x?: number; y?: number; which?: 'black' | 'white';
  };
  'history-undo': undefined;
  'history-redo': undefined;
  /** 跳到第 i 步：绝对下标，不是"再退一步"。页面自己数 |i - 现在| 次原语。 */
  'history-jump': number;
  'history-clear': undefined;
  /** ---- 六格工具面板 ---- */
  /** Text：Font 那一颗只开那一口选字器（取值由选择器自己回写，不进这条载荷）；Padding / Weight / Color
   *  就是它们原来那行 `patchSelectedText` —— 值照控件给。 */
  'text-font': undefined;
  'text-padding': number;
  'text-weight': string;
  'text-color': string;
  /** Geometry 家族：舞台与六格读数/色块/Reset 都在宿主，动作落到那枚记录的 desc 上 —— 与页面原来
   *  那几颗控件同一个写口 `patchGizmoTarget`（整只换 desc）。`live` = 拖动/连续输入期间只重画、
   *  不重修行列表；`geometry-commit` 那一趟才立一步历史（`label` 是这一步的名字）。 */
  'geometry-desc': { patch: Partial<BlendGeometryDesc>; live?: boolean };
  'geometry-commit': { label?: string };
  'geometry-reset': undefined;
  /** Pose：与 Geometry 同一条 desc 通道 —— 舞台/滑杆/色块/取景格/Reset/From image 都在宿主，动作落到
   *  那枚记录的 desc 上（页面写口 `patchPoseTarget`）。`live` 同 Geometry。两条 Reset 有各自的落点：
   *  `pose-reset-pose` 只回静止姿态（网格与取景不动），`pose-reset-all` 走 ATTR_TYPES.pose.defaults。
   *  `pose-from-image` 开页面那一页的选图 modal + DWPose 估算，不改 desc 本身（估完由页面写）。 */
  'pose-desc': { patch: Partial<BlendPoseDesc>; live?: boolean };
  'pose-commit': { label?: string };
  'pose-reset-pose': undefined;
  'pose-reset-all': undefined;
  'pose-from-image': undefined;
  /** 3D 那一格的 Open Scene：把选中层那枚 3D 记录的场景开成 tab（页面 open3DSceneDocument）。 */
  'scene3d-open': undefined;
  /** Detector 那三颗控件：prompt 每敲一下发一次（页面存真值），滑杆与勾同理；Detect 那一颗开对话框。 */
  'detector-prompt': string;
  'detector-threshold': number;
  'detector-invert': boolean;
  'detector-run': undefined;
  /** Processor：换 interface、挑来源/落位（`side` + 端口号 + 选中的值）、挑工作区条目、
   *  拧一口参数（值按那一口的类型归：布尔 / 数字 / 字符串）。换 interface 发的是身份（package 下标 +
   *  名字）；只有旧页面才只认位置，所以数字那一档留着。 */
  'processor-interface': number | { index: number; name: string };
  'processor-pick': { side: 'in' | 'out'; port: number; value: string };
  'processor-staging': { port: number; id: string };
  'processor-param': { port: number; value: number | string | boolean };
  'processor-run': undefined;
  'processor-reset': undefined;
  /** Staging 那一格：Extra Prompt 每次编辑（宿主序列化后的整串）发一次，页面存它并标脏；Blend / Tag /
   *  Cancel 三颗就是画布底栏那三颗按钮原来那一下（Cancel 只发消息，收尾在宿主的 status 轮询）。图池条
   *  的上传 / 删除不走这条边界 —— 那是宿主自己的后端动作（App 的 stageUpload / stageRemove）。 */
  'staging-prompt': string;
  'staging-blend': undefined;
  'staging-tag': undefined;
  'staging-cancel': undefined;
  'stage-layer': { id: number };
  'layer-from-staging': { id: string; stack?: BlendStack };
};

/** 发送口：泛型把动作键和它的载荷绑死 —— `'visible-faces'` 不给数组就编译不过，旋钮给了字符串也编译不过。
 *  App 的 `sendBlendUiCommand`、EditPhase 的 `onBlendUiCommand`、每一格的 `send` 用的都是这一条，
 *  所以这条边界上只有一个作者。 */
export type BlendUiSend = <A extends BlendUiAction>(action: A, value?: BlendUiPayloads[A]) => void;

// 编译期对表（不是运行时探针）：这张表与 BlendUiAction 少一键或多一键，这一句就赋不进 true。
type BlendUiPayloadGap = Exclude<BlendUiAction, keyof BlendUiPayloads>
  | Exclude<keyof BlendUiPayloads, BlendUiAction>;
type BlendUiPayloadCoverage = [BlendUiPayloadGap] extends [never] ? true : BlendUiPayloadGap;
export const BLEND_UI_PAYLOAD_COVERAGE: BlendUiPayloadCoverage = true;

