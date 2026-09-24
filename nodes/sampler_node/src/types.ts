export interface ServerConfig {
  prompt_url: string;
  detail_status: 'idle' | 'running' | 'done' | 'error';
  add_noise: string;
  start_step_rate: number;
  end_step_rate: number;
  pixels: number;
  align: number;
  crop_reserve: number;
  mask_grow: number;
  mask_blur: number;
  enable_edit: boolean;
  context_reference: boolean;
  context_reference_key: string | null;
  /** 当前 pipeline 的模型架构（按架构渲染 DetailerBlock 的 edit 设置） */
  architecture?: string | null;
  has_tagger: boolean;
  current_context_key: string | null;
  has_package: boolean;
  package_count: number;
  has_pipeline_package: boolean;
  pipeline_package_count: number;
  blocks: PipelineBlock[];
  /** 多套 Pipeline Blocks（工作台里的 tabs）；`blocks` 始终是激活那一套的镜像 */
  blocks_sets?: BlockSet[];
  active_block_set?: string | null;
}

/** 一套 Pipeline Blocks = 一个 tab。id 稳定（重命名不改 id），blocks 与旧模型同构。 */
export interface BlockSet {
  id: string;
  name: string;
  blocks: PipelineBlock[];
}

export interface DetailerBlockParams {
  add_noise: string;
  start_step_rate: number;
  end_step_rate: number;
  pixels: number;
  align: number;
  crop_reserve: number;
  /** 关掉时不 recover crop（也不 recover resize）：产出保持 crop 工作区分辨率，
   *  作为新图层由 Blend 画布用 transform 贴回原位；开 = 合成回整幅图（原行为）。 */
  recover_crop?: boolean;
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
  context_reference: boolean;
  context_reference_key: string | null;
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

/** Query 块没有可调参数：run 到它时链条暂停并弹出 prompt UI，用户挑完 Confirm 才继续。
 *  回答按 prompt 块同样的语义合并（全局在前 + 本次选择在后 + programs 跑在合并结果上），
 *  只影响其后的 detailer；关掉弹窗 = 中止整条链。 */
export type QueryBlockParams = Record<string, never>;

export interface PipelineBlock {
  id: string;
  type: 'detailer' | 'interface' | 'prompt' | 'query';
  name: string;
  params: DetailerBlockParams | InterfaceBlockParams | PromptBlockParams | QueryBlockParams;
  interface_index?: number;
  exec_options?: InterfaceExecOptions;
}

/** @deprecated Use PipelineBlock[] + global mask_grow/mask_blur instead */
export interface DetailerParams {
  add_noise: string;
  start_step_rate: number;
  end_step_rate: number;
  pixels: number;
  align: number;
  crop_reserve: number;
  mask_grow: number;
  mask_blur: number;
  enable_edit: boolean;
  context_reference: boolean;
  context_reference_key: string | null;
}

/** 一个正停在链条里等用户回答的 Query 块（/api/status 下发；null = 没有块在等）。 */
export interface PendingQuery {
  id: string;
  name: string;
  index: number;
}

export interface StatusResponse {
  /** cancelled = Run 按钮的 Cancel 打断了本次运行（/api/cancel_run） */
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
  pending_query?: PendingQuery | null;
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
  dataUrl: string;
  width: number;
  height: number;
  note?: string;
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

export interface HistoryItem {
  key: string;
  name: string;
  src: string;
  width?: number;
  height?: number;
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
 * it (the Tag buttons live in its toolbar).
 */
export type Tab = 'prompt' | 'draw' | 'context' | 'interface' | 'pipeline';

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
}

export interface PipelineInfo {
  name: string;
  node_id: string;
}

export interface PipelinePackageInfo {
  name: string;
  pipelines: PipelineInfo[];
}
