import { useState, useCallback, useRef } from 'react';
import type {
  AllPrompts, AllLibraries, PointsResponse,
  CategoryDisplayModes, CategorySizeModes,
  LoraFolders, LoraSelectionData, LoraSliderConfig, AllPrograms,
} from '../types';
import { PRESET_SCOPE, SCOPED_SELECTION, SAMPLER_BASE, fetchPromptPresetSelection } from '../blockScope';
import { migrateProgramTagRefs } from './useSelection';

const API_BASE = '';

export function useApi() {
  const [allPrompts, setAllPrompts] = useState<AllPrompts>({});
  const [allLibraries, setAllLibraries] = useState<AllLibraries>({});
  const [categoryDisplayModes, setCategoryDisplayModes] = useState<CategoryDisplayModes>({});
  const [categorySizeModes, setCategorySizeModes] = useState<CategorySizeModes>({});
  const [customPrompts, setCustomPrompts] = useState('');
  const [temporaryPrompts, setTemporaryPrompts] = useState<string[]>([]);
  const temporaryPromptsRef = useRef<string[]>([]);
  temporaryPromptsRef.current = temporaryPrompts;
  const [lastSelected, setLastSelected] = useState<string[]>([]);
  // null = the seed (global selection OR preset selection) has not arrived yet. The restore
  // effects must not infer "nothing selected" from an empty array during mount — that race
  // latched them off and silently dropped the seeded loras/prefabs/programs.
  const [lastSelectedLoras, setLastSelectedLoras] = useState<LoraSelectionData[] | null>(null);
  const [lastSelectedPrefabs, setLastSelectedPrefabs] = useState<{ guid: string; active?: boolean }[] | null>(null);
  const [loraData, setLoraData] = useState<LoraFolders>({});
  const [loraDataReady, setLoraDataReady] = useState(false);
  const [loraRegex, setLoraRegex] = useState('');
  const [loraFolderMeta, setLoraFolderMeta] = useState<Record<string, {bg_image?: string; bg_video?: string}>>({});
  const [loraSliderConfigs, setLoraSliderConfigs] = useState<Record<string, LoraSliderConfig>>({});
  const [parsedPrompts, setParsedPrompts] = useState<string[]>([]);
  const [hasTagger, setHasTagger] = useState(false);
  const [hasAsset, setHasAsset] = useState(false);
  const [allPrograms, setAllPrograms] = useState<AllPrograms>({});
  const [lastSelectedPrograms, setLastSelectedPrograms] = useState<any[] | null>(null);

  const loadData = useCallback(async () => {
    // Mark the seed as "in flight" first: a reload (region / preset context switch) clears the
    // restored state, and the restore effects must wait for THIS load instead of latching onto
    // the previous context's arrays while the refs are still false.
    setLastSelectedLoras(null);
    setLastSelectedPrefabs(null);
    setLastSelectedPrograms(null);
    // Preset scope: restore the referenced preset's selection instead of the prompt node's
    // global one — the same UI edits a shared preset referenced by Pipeline prompt blocks.
    const presetSelection = await fetchPromptPresetSelection();
    const res = await fetch(`${API_BASE}/prompts_data`);
    const data: PointsResponse & { last_selected_loras?: LoraSelectionData[]; lora_regex?: string; programs?: AllPrograms; last_selected_programs?: any[] } = await res.json();
    setAllPrompts(data.categories);
    setAllLibraries(data.libraries || {});
    setCategoryDisplayModes(data.category_display_modes || {});
    setCategorySizeModes(data.category_size_modes || {});
    // An unbound Query starts EMPTY on purpose: the user picks this pass's prompt from
    // scratch. A Query that binds a preset is seeded from it like the preset editor is.
    setLastSelected((presetSelection?.tags as string[]) || (SCOPED_SELECTION ? [] : (data.last_selected || [])));
    setLastSelectedLoras((presetSelection?.loras as LoraSelectionData[]) || (SCOPED_SELECTION ? [] : (data.last_selected_loras || [])));
    setLastSelectedPrefabs((presetSelection?.prefabs as { guid: string; active?: boolean }[]) || (SCOPED_SELECTION ? [] : (data.last_selected_prefabs || [])));
    setCustomPrompts(SCOPED_SELECTION ? (presetSelection?.custom_prompts ?? '') : (data.custom_prompts || ''));
    setTemporaryPrompts(SCOPED_SELECTION ? [] : (data.temporary_prompts || []));
    setLoraRegex(data.lora_regex || '');
    setParsedPrompts(data.parsed_prompts || []);
    setHasTagger(data.has_tagger || false);
    setHasAsset(data.has_asset || false);
    setAllPrograms(migrateProgramTagRefs(data.programs || {}, data.categories));
    setLastSelectedPrograms((presetSelection?.programs as any[]) || (SCOPED_SELECTION ? [] : (data.last_selected_programs || [])));
    return { ...data, preset_selection: presetSelection };
  }, []);

  const submitSelection = useCallback(async (prompts: { text: string; source: string }[], custom: string, loras: LoraSelectionData[], prefabs?: any[], programs?: any[], filterTags?: any[], filterLoras?: any[], filterPrefabs?: any[], onBeforeClose?: () => void, keepParsing?: boolean) => {
    const res = await fetch(`${API_BASE}/select_prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompts, custom_prompts: custom, temporary_prompts: temporaryPromptsRef.current, loras, prefabs, programs, filter_tag_groups: filterTags || [], filter_loras: filterLoras || [], filter_prefabs: filterPrefabs || [], keep_parsing: keepParsing || false }),
    });
    if (res.ok) {
      onBeforeClose?.();
      window.close();
    }
  }, []);

  const syncSelection = useCallback(async (prompts: { text: string; source: string }[], custom: string, loras: LoraSelectionData[], prefabs?: any[], programs?: any[], filterTags?: any[], filterLoras?: any[], filterPrefabs?: any[]) => {
    await fetch(`${API_BASE}/select_prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompts, custom_prompts: custom, temporary_prompts: temporaryPromptsRef.current, loras, prefabs, programs, filter_tag_groups: filterTags || [], filter_loras: filterLoras || [], filter_prefabs: filterPrefabs || [], keep_parsing: false }),
    });
  }, []);

  const closeWindow = useCallback(() => {
    fetch(`${API_BASE}/window_closed`, { method: 'POST' });
    window.close();
  }, []);

  const loadLoraData = useCallback(async () => {
    setLoraDataReady(false);
    const res = await fetch(`${API_BASE}/lora_data`);
    const data = await res.json();
    setLoraData(data.folders || {});
    setLoraFolderMeta(data.folder_meta || {});
    setLoraSliderConfigs(data.lora_slider_configs || {});
    setLoraRegex(data.lora_regex || '');
    // An empty scan is a real state (the architecture's lora_regex matched nothing), not
    // "still loading" — the restore effects need to tell the two apart.
    setLoraDataReady(true);
    return data.folders || {};
  }, []);

  return {
    allPrompts, setAllPrompts,
    allLibraries, setAllLibraries,
    categoryDisplayModes, setCategoryDisplayModes,
    categorySizeModes, setCategorySizeModes,
    customPrompts, setCustomPrompts,
    temporaryPrompts, setTemporaryPrompts,
    lastSelected, lastSelectedLoras, lastSelectedPrefabs,
    loraData, setLoraData, loraDataReady, loraRegex, loraFolderMeta, setLoraFolderMeta, loraSliderConfigs, setLoraSliderConfigs, parsedPrompts,
    hasTagger,
    hasAsset,
    allPrograms, setAllPrograms, lastSelectedPrograms,
    loadData, submitSelection, syncSelection, closeWindow, loadLoraData,
  };
}
