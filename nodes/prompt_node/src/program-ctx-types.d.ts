// Type definitions for Program context variables
// This file is the single source of truth — imported as raw text via Vite ?raw

interface Tag {
  name: string;
  prompt: string;
  category: string;
  /** Available decorations for this prompt (from category + prompt definitions) */
  decorations?: string[];
  /** Classification tags for this prompt (from category + prompt definitions) */
  tags?: string[];
}

interface TagGroup {
  /** [deco_n, ..., deco_1, base] — last element is base */
  tags: Tag[];
  strength: number;
  source: 'normal' | 'parsing' | 'program';
}

interface Lora {
  file_path: string;
  name: string;
  strength: number;
  active_tags: string[];
  active: boolean;
  split_mode?: boolean;
}

interface PrefabTagState {
  key: string;
  active: boolean;
}

interface PrefabLoraState {
  file_path: string;
  active: boolean;
}

interface Prefab {
  guid: string;
  active: boolean;
  name: string;
  tag_groups: TagGroup[];
  loras: Lora[];
  custom_prompts: string;
  preview: string;
  tag_states: PrefabTagState[];
  lora_states: PrefabLoraState[];
  children: Prefab[];
}

interface AllTagsEntry {
  name: string;
  prompt: string;
  category: string;
  decorations: string[];
  tags: string[];
  mute_decorations: string[];
}

interface PromptData {
  id: string;
  name: string;
  prompt: string;
  preview?: string;
  tags?: string[];
  decorations?: string[];
  mute_decorations?: string[];
}

interface PromptsData {
  [category: string]: {
    bg_image?: string;
    bg_video?: string;
    tags?: string[];
    decorations?: string[];
    prompts?: PromptData[];
  };
}

declare const tag_groups: TagGroup[];
declare const loras: Lora[];
declare const prefabs: Prefab[];
declare const custom_prompts: string;
declare const prompts_data: PromptsData;
declare const all_tags: { [prompt: string]: AllTagsEntry };
declare const prefab_context: Prefab[];
declare const lora_context: Lora[];
declare const prompt_context: TagGroup[];
