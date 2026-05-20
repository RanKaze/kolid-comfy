export interface PromptData {
  id: string;
  name: string;
  prompt: string;
  preview: string;
  tags?: string | string[];
  decorations?: string | string[];
  mute_decorations?: string[];
}

export interface CategoryData {
  bg_image?: string;
  tags?: string[];
  decorations?: string[];
  prompts?: PromptData[];
  [key: string]: unknown;
}

export interface Tag {
  decoration_num: number;
  name: string;
  prompt: string;
}

export type TagGroup = Tag[];

export interface SelectedPrefabLoraState {
  file_path: string;
  active: boolean;
}

export interface SelectedPrefabTagState {
  key: string;
  active: boolean;
}

export interface SelectedPrefabItem {
  guid: string;
  active: boolean;
  tags: SelectedPrefabTagState[];
  loras: SelectedPrefabLoraState[];
  children: SelectedPrefabItem[];
}

export interface SelectedPrefabRef {
  guid: string;
  active?: boolean;
  tags?: SelectedPrefabTagState[];
  loras?: SelectedPrefabLoraState[];
  children?: SelectedPrefabItem[];
}

export interface PrefabData {
  name: string;
  tags: TagGroup[];
  custom_prompts?: string;
  preview?: string;
  loras?: LoraSelectionData[];
  selected_prefabs?: SelectedPrefabRef[];
  guid?: string;
}

export interface LibraryData {
  bg_image?: string;
  prompt_ids?: string[];
  display_mode?: string;
  size_mode?: string;
  prefabs?: PrefabData[];
  [key: string]: unknown;
}

export interface AllPrompts {
  [category: string]: CategoryData;
}

export interface AllLibraries {
  [name: string]: LibraryData;
}

export interface CategoryDisplayModes {
  [name: string]: string;
}

export interface CategorySizeModes {
  [name: string]: string;
}

export interface FocusPoint {
  x: number;
  y: number;
}

export interface FocusPoints {
  [id: string]: FocusPoint;
}

export interface PointsResponse {
  categories: AllPrompts;
  libraries: AllLibraries;
  last_selected: string[];
  category_display_modes: CategoryDisplayModes;
  category_size_modes: CategorySizeModes;
  prompt_foldout: boolean;
  custom_prompts: string;
  last_selected_prefabs?: { guid: string; active?: boolean }[];
}

export interface DragState {
  type: 'category' | 'prompt' | 'library' | 'prefab' | null;
  item: string | null;
  category: string | null;
  element: HTMLElement | null;
  library: string | null;
  index: number | null;
}

export interface TemporaryContext {
  matchFn: (p: PromptData, cat: string) => boolean;
  basePrompt: string;
  title: string;
  tagGroups: TagGroup[];
  originalExpandedCategories: Set<string>;
  level: number;
}

export type TempContextMode = 'tag' | 'lora' | 'prefab';

export interface TempContextRestorePoint {
  name: string;
  customPrompts: string;
  prefabTags: TagGroup[];
  prefabLoras: LoraSelectionData[];
  prefabSelectedPrefabs: SelectedPrefabRef[];
  previewUrl: string;
  previewVisible: boolean;
  focusX: number;
  focusY: number;
  focusVisible: boolean;
  modalData: { lib: string; idx: number };
}

export interface LoraTempState {
  strength: number;
  active_tags: string[];
  active: boolean;
  split_mode: boolean;
}

export interface TempContextLayer {
  type: TempContextMode;
  title: string;
  // tag mode fields
  matchFn?: (p: PromptData, cat: string) => boolean;
  basePrompt?: string;
  tagGroups?: TagGroup[];
  level?: number;
  // lora/prefab mode fields
  selections?: string[];
  restorePoint?: TempContextRestorePoint;
  // lora mode: per-file-path state
  loraStates?: Record<string, LoraTempState>;
}

export interface LoraItemData {
  name: string;
  file_name: string;
  file_path: string;
  preview_url: string;
  tags?: string[];
  metadata: Record<string, unknown>;
}

export interface LoraSelectionData {
  file_path: string;
  name: string;
  strength: number;
  active_tags: string[];
  active: boolean;
  split_mode?: boolean;
}

export interface LoraFolders {
  [folder: string]: LoraItemData[];
}
