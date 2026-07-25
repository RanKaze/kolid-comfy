// Type definitions for Program context variables
// This file is the single source of truth — imported as raw text via Vite ?raw

interface Tag {
  /** 0=base, 1=[deco], 2=[[deco]] */
  decoration_num: number;
  name: string;
  prompt: string;
  strength?: number;
  category: string;
  is_from_parsing?: boolean;
}

type TagGroup = Tag[];

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
  tags: TagGroup[];
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

type TagIndex = { [tag: string]: string[] };
type DecorationIndex = { [decoration: string]: string[] };

declare const tags: TagGroup[];
declare const loras: Lora[];
declare const prefabs: Prefab[];
declare const custom_prompts: string;
declare const prompts_data: PromptsData;
declare const all_tags: { [prompt: string]: AllTagsEntry };
declare const tag_index: TagIndex;
declare const decoration_index: DecorationIndex;
