import { useState, useCallback } from 'react';
import type {
  AllPrompts, AllLibraries, PointsResponse,
  CategoryDisplayModes, CategorySizeModes,
  LoraFolders, LoraSelectionData,
} from '../types';

const API_BASE = '';

export function useApi() {
  const [allPrompts, setAllPrompts] = useState<AllPrompts>({});
  const [allLibraries, setAllLibraries] = useState<AllLibraries>({});
  const [categoryDisplayModes, setCategoryDisplayModes] = useState<CategoryDisplayModes>({});
  const [categorySizeModes, setCategorySizeModes] = useState<CategorySizeModes>({});
  const [customPrompts, setCustomPrompts] = useState('');
  const [promptFoldout, setPromptFoldout] = useState(false);
  const [lastSelected, setLastSelected] = useState<string[]>([]);
  const [lastSelectedLoras, setLastSelectedLoras] = useState<LoraSelectionData[]>([]);
  const [lastSelectedPrefabs, setLastSelectedPrefabs] = useState<{ guid: string; active?: boolean }[]>([]);
  const [loraData, setLoraData] = useState<LoraFolders>({});
  const [loraRegex, setLoraRegex] = useState('');

  const loadData = useCallback(async () => {
    const res = await fetch(`${API_BASE}/prompts_data`);
    const data: PointsResponse & { last_selected_loras?: LoraSelectionData[]; lora_regex?: string } = await res.json();
    setAllPrompts(data.categories);
    setAllLibraries(data.libraries || {});
    setCategoryDisplayModes(data.category_display_modes || {});
    setCategorySizeModes(data.category_size_modes || {});
    setPromptFoldout(data.prompt_foldout || false);
    setLastSelected(data.last_selected || []);
    setLastSelectedLoras(data.last_selected_loras || []);
    setLastSelectedPrefabs(data.last_selected_prefabs || []);
    setCustomPrompts(data.custom_prompts || '');
    setLoraRegex(data.lora_regex || '');
    return data;
  }, []);

  const submitSelection = useCallback(async (prompts: string[], custom: string, loras: LoraSelectionData[], prefabs?: { guid: string }[], onBeforeClose?: () => void) => {
    const res = await fetch(`${API_BASE}/select_prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompts, custom_prompts: custom, loras, prefabs }),
    });
    if (res.ok) {
      onBeforeClose?.();
      window.close();
    }
  }, []);

  const closeWindow = useCallback(() => {
    fetch(`${API_BASE}/window_closed`, { method: 'POST' });
    window.close();
  }, []);

  const loadLoraData = useCallback(async () => {
    const res = await fetch(`${API_BASE}/lora_data`);
    const data = await res.json();
    setLoraData(data.folders || {});
    setLoraRegex(data.lora_regex || '');
    return data.folders || {};
  }, []);

  return {
    allPrompts, setAllPrompts,
    allLibraries, setAllLibraries,
    categoryDisplayModes, setCategoryDisplayModes,
    categorySizeModes, setCategorySizeModes,
    customPrompts, setCustomPrompts,
    promptFoldout, lastSelected, lastSelectedLoras, lastSelectedPrefabs,
    loraData, setLoraData, loraRegex,
    loadData, submitSelection, closeWindow, loadLoraData,
  };
}
