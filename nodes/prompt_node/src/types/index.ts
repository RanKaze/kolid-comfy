export interface PromptData {
  id: string;
  name: string;
  prompt: string;
  preview: string;
  tags?: string | string[];
}

export interface CategoryData {
  bg_image?: string;
  bg_video?: string;
  tags?: string[];
  prompts?: PromptData[];
  [key: string]: unknown;
}

export interface Tag {
  name: string;
  prompt: string;
  category: string;
  tags?: string[];
}

export type SourceMode = 'normal' | 'parsing' | 'program';

export interface TagGroup {
  tags: Tag[];
  strength: number;
  source: SourceMode;
}

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
  tag_groups: SelectedPrefabTagState[];
  loras: SelectedPrefabLoraState[];
  children: SelectedPrefabItem[];
  source?: SourceMode;
}

export interface SelectedPrefabRef {
  guid: string;
  active?: boolean;
  tag_groups?: SelectedPrefabTagState[];
  loras?: SelectedPrefabLoraState[];
  children?: SelectedPrefabItem[];
}

export interface PrefabData {
  name: string;
  tag_groups: TagGroup[];
  custom_prompts?: string;
  preview?: string;
  loras?: LoraSelectionData[];
  selected_prefabs?: SelectedPrefabRef[];
  guid?: string;
}

export interface LibraryData {
  bg_image?: string;
  bg_video?: string;
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
  custom_prompts: string;
  parsed_prompts?: string[];
  last_selected_prefabs?: { guid: string; active?: boolean }[];
  has_tagger?: boolean;
  has_asset?: boolean;
}

export interface DragState {
  type: 'category' | 'prompt' | 'library' | 'prefab' | 'application' | 'program' | null;
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

export type TempContextMode = 'tag' | 'lora' | 'prefab' | 'program' | 'prefabCtx' | 'loraCtx' | 'tagCtx' | 'prefabBuiltin' | 'loraBuiltin' | 'tagGroupBuiltin';

export interface TempContextRestorePoint {
  name: string;
  customPrompts: string;
  prefabTags: TagGroup[];
  prefabLoras: LoraSelectionData[];
  prefabSelectedPrefabs: SelectedPrefabRef[];
  programSelectedPrograms?: { id: string; active?: boolean }[];
  enablePrefabCtx?: boolean;
  enableLoraCtx?: boolean;
  enableTagCtx?: boolean;
  ctxPrefabGuids?: string[];
  ctxLoraPaths?: string[];
  ctxTagTexts?: string[];
  prefabBuiltinGuids?: string[];
  loraBuiltinPaths?: string[];
  tagGroupBuiltinTexts?: string[];
  prefabBuiltinInactive?: string[];
  loraBuiltinInactive?: string[];
  tagGroupBuiltinInactive?: string[];
  prefabBuiltinDisplay?: string[];
  loraBuiltinDisplay?: string[];
  tagGroupBuiltinDisplay?: string[];
  previewUrl: string;
  previewVisible: boolean;
  focusX: number;
  focusY: number;
  focusVisible: boolean;
  modalData: { lib: string; idx: number } | { programId: string; instanceIndex?: number };
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
  source?: SourceMode;
}

export interface LoraSliderMark {
  value: number;
  label: string;
}

export interface LoraSliderConfig {
  enabled: boolean;
  min: number;
  max: number;
  step: number;
  default_value: number;
  min_name: string;
  max_name: string;
  reverse: boolean;
  marks: LoraSliderMark[];
}

export interface LoraSelectionData {
  file_path: string;
  name: string;
  strength: number;
  active_tags: string[];
  active: boolean;
  split_mode?: boolean;
  slider_config?: LoraSliderConfig;
  source?: SourceMode;
}

export interface LoraFolders {
  [folder: string]: LoraItemData[];
}

// ═══ Region Context ═══

/** Base context — shared by all context types (background, region, etc.) */
export interface PromptContextBase {
  prompts: string[];
  custom_prompts: string;
  loras: LoraSelectionData[];
  prefabs: SelectedPrefabItem[];
  /** Human-readable label for this context (e.g. "Background", "Region 01") */
  label: string;
}

/** A region's prompt context — extends base with spatial data */
export interface RegionContext extends PromptContextBase {
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

/** A region box on the canvas — its promptContext is the base context */
export interface RegionBox {
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
  promptContext?: PromptContextBase | null;
}

/** Singleton background context */
export interface BackgroundContext extends PromptContextBase {
  isBackground: true;
}

// ═══ Application ═══

export interface SelectedProgramRef {
  id: string;
  active?: boolean;
  context_prefab_guids?: string[];
  context_lora_paths?: string[];
  context_tag_texts?: string[];
  context_prefab_inactive?: string[];
  context_lora_inactive?: string[];
  context_tag_inactive?: string[];
}

export interface ProgramData {
  id: string;
  name: string;
  code: string;
  preview?: string;
  selected_programs?: SelectedProgramRef[];
  enable_prefab_context?: boolean;
  enable_lora_context?: boolean;
  enable_tag_context?: boolean;
  multi_program?: boolean;
  prefab_builtin_guids?: string[];
  lora_builtin_paths?: string[];
  tag_group_builtin_texts?: string[];
  prefab_builtin_inactive?: string[];
  lora_builtin_inactive?: string[];
  tag_group_builtin_inactive?: string[];
  prefab_builtin_display?: string[];
  lora_builtin_display?: string[];
  tag_group_builtin_display?: string[];
}

export interface ProgramCategoryData {
  programs: ProgramData[];
  bg_image?: string;
  bg_video?: string;
  display_mode?: string;
  size_mode?: string;
  [key: string]: unknown;
}

export type AllPrograms = { [category: string]: ProgramCategoryData };

export interface SelectedProgramItem {
  id: string;
  active: boolean;
  // Per-instance context overrides (independent copies for multi_program)
  context_prefab_guids?: string[];
  context_lora_paths?: string[];
  context_tag_texts?: string[];
  context_prefab_inactive?: string[];
  context_lora_inactive?: string[];
  context_tag_inactive?: string[];
}
