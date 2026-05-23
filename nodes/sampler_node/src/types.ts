export interface ServerConfig {
  mask_url: string;
  prompt_url: string;
  switch_url: string;
  loop_count: number;
  add_noise: string;
  start_step_rate: number;
  end_step_rate: number;
  pixels: number;
  crop_reserve: number;
  has_tagger: boolean;
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
  loop_count: number;
  error?: string;
}

export interface ResultResponse {
  original_image: string;
  detailed_image: string;
}

export type Phase = 'mask' | 'tag' | 'prompt' | 'waiting' | 'switch';

export interface TagPreviews {
  full?: string;
  mask?: string;
  covered?: string;
}
