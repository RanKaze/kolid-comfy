export interface ServerConfig {
  mask_url: string;
  prompt_url: string;
  detail_status: 'idle' | 'running' | 'done' | 'error';
  add_noise: string;
  start_step_rate: number;
  end_step_rate: number;
  pixels: number;
  crop_reserve: number;
  has_tagger: boolean;
  current_context_key: string | null;
  has_package: boolean;
  package_count: number;
}

export interface DetailerParams {
  add_noise: string;
  start_step_rate: number;
  end_step_rate: number;
  pixels: number;
  crop_reserve: number;
}

export interface StatusResponse {
  detail_status: 'idle' | 'running' | 'done' | 'error';
  error?: string;
  progress?: number;
  current_step?: number;
  total_steps?: number;
  interface_result_keys?: string[];
}

export interface TagPreviews {
  full?: string;
  mask?: string;
  covered?: string;
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
}

export interface HistoryItem {
  key: string;
  name: string;
  src: string;
}

export type Tab = 'mask' | 'tag' | 'prompt' | 'draw' | 'blend' | 'context' | 'interface';

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
