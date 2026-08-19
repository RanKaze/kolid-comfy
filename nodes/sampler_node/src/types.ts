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
  has_tagger: boolean;
  current_context_key: string | null;
  has_package: boolean;
  package_count: number;
  has_pipeline_package: boolean;
  pipeline_package_count: number;
}

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
