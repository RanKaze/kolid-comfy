export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  type: 'obj' | 'text';
  text: string;
  desc: string;
  palette: string[];
  locked?: boolean;
  nobbox?: boolean;
}

export interface ServerConfig {
  image: string | null;
  width: number;
  height: number;
  background: string;
  high_level_description: string;
  aesthetics: string;
  lighting: string;
  medium: string;
  style_palette: string;
  bbox_order: 'yx' | 'xy';
  coord_mode: 'normalized' | 'absolute';
  output_format: 'compact' | 'pretty';
  bg_brightness: number;
  initial_boxes: string;
}

export interface ConfirmPayload {
  boxes: Box[];
  style_palette: string[];
  background: string;
  high_level_description: string;
  aesthetics: string;
  lighting: string;
  medium: string;
}

export type DragMode =
  | 'move'
  | 'draw'
  | 'resize-tl' | 'resize-tr' | 'resize-bl' | 'resize-br'
  | 'resize-t' | 'resize-b' | 'resize-l' | 'resize-r'
  | null;

export interface CanvasHandle {
  boxes: Box[];
  activeIdx: number;
  imageEl: HTMLImageElement | null;
  canvasEl: HTMLCanvasElement | null;
}
