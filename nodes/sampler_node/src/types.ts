export interface ServerConfig {
  mask_url: string;
  prompt_url: string;
  loop_count: number;
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

export type Phase = 'edit' | 'loading' | 'select';
