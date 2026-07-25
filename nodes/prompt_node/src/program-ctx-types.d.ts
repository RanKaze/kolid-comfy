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

/**
 * Selected tag groups in the current prompt.
 * Each group has `tags` (deco_n → deco_1 → base), `strength`, and `source`.
 */
declare const tag_groups: TagGroup[];

/** Selected loras with their strength and active tag states. */
declare const loras: Lora[];

/** Selected prefabs (merged: selection state + tag/lora data from prefab definitions). */
declare const prefabs: Prefab[];

/** Free-form custom prompt text entered by the user. */
declare const custom_prompts: string;

/** Full prompt library data, organized by category. */
declare const prompts_data: PromptsData;

/** Lookup table: prompt text → metadata (decorations, tags, mute_decorations). */
declare const all_tags: { [prompt: string]: AllTagsEntry };

/** Prefab context injected from the root program's context selections. */
declare const prefab_context: Prefab[];

/** Lora context injected from the root program's context selections. */
declare const lora_context: Lora[];

/** Prompt context injected from the root program's context selections. */
declare const prompt_context: TagGroup[];

/**
 * The return value of a program. Filters remove matching items; gens add new items.
 * `custom_prompts` replaces the custom prompt text if provided.
 */
interface ProgramReturn {
  /** Tag groups to remove from selection. */
  filter_tag_groups?: TagGroup[];
  /** Loras to remove from selection. */
  filter_loras?: Lora[];
  /** Prefabs to remove from selection. */
  filter_prefabs?: Prefab[];
  /** New tag groups to add. */
  gen_tag_groups?: TagGroup[];
  /** New loras to add. */
  gen_loras?: Lora[];
  /** New prefabs to add. */
  gen_prefabs?: Prefab[];
  /** Replacement custom prompt text. */
  custom_prompts?: string;
}
