export interface ServerConfig {
  mask_url: string;
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
}

export interface DetailerBlockParams {
  add_noise: string;
  start_step_rate: number;
  end_step_rate: number;
  pixels: number;
  align: number;
  crop_reserve: number;
  enable_edit: boolean;
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
}

export interface PipelineBlock {
  id: string;
  type: 'detailer' | 'interface';
  name: string;
  params: DetailerBlockParams;
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

export interface StatusResponse {
  detail_status: 'idle' | 'running' | 'done' | 'error';
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

export interface HistoryItem {
  key: string;
  name: string;
  src: string;
}

export interface HistoryItem {
  key: string;
  name: string;
  src: string;
  width?: number;
  height?: number;
}

export interface InterfaceExecOptions {
  image_source_key?: string | null;
  operation: 'default' | 'crop';
  crop_reserve: number;
}

export type Tab = 'mask' | 'tag' | 'prompt' | 'draw' | 'blend' | 'context' | 'interface' | 'pipeline';

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
