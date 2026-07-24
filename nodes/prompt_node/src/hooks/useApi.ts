import { useState, useCallback } from 'react';
import type {
  AllPrompts, AllLibraries, PointsResponse,
  CategoryDisplayModes, CategorySizeModes,
  LoraFolders, LoraSelectionData, AllApplications,
} from '../types';

const API_BASE = '';

export function useApi() {
  const [allPrompts, setAllPrompts] = useState<AllPrompts>({});
  const [allLibraries, setAllLibraries] = useState<AllLibraries>({});
  const [categoryDisplayModes, setCategoryDisplayModes] = useState<CategoryDisplayModes>({});
  const [categorySizeModes, setCategorySizeModes] = useState<CategorySizeModes>({});
  const [customPrompts, setCustomPrompts] = useState('');
  const [lastSelected, setLastSelected] = useState<string[]>([]);
  const [lastSelectedLoras, setLastSelectedLoras] = useState<LoraSelectionData[]>([]);
  const [lastSelectedPrefabs, setLastSelectedPrefabs] = useState<{ guid: string; active?: boolean }[]>([]);
  const [loraData, setLoraData] = useState<LoraFolders>({});
  const [loraRegex, setLoraRegex] = useState('');
  const [loraFolderMeta, setLoraFolderMeta] = useState<Record<string, {bg_image?: string; bg_video?: string}>>({});
  const [parsedPrompts, setParsedPrompts] = useState<string[]>([]);
  const [allApplications, setAllApplications] = useState<AllApplications>({});
  const [lastSelectedApplications, setLastSelectedApplications] = useState<{ id: string; active?: boolean }[]>([]);

  const loadData = useCallback(async () => {
    const res = await fetch(`${API_BASE}/prompts_data`);
    const data: PointsResponse & { last_selected_loras?: LoraSelectionData[]; lora_regex?: string; applications?: AllApplications; last_selected_applications?: { id: string; active?: boolean }[] } = await res.json();
    setAllPrompts(data.categories);
    setAllLibraries(data.libraries || {});
    setCategoryDisplayModes(data.category_display_modes || {});
    setCategorySizeModes(data.category_size_modes || {});
    setLastSelected(data.last_selected || []);
    setLastSelectedLoras(data.last_selected_loras || []);
    setLastSelectedPrefabs(data.last_selected_prefabs || []);
    setCustomPrompts(data.custom_prompts || '');
    setLoraRegex(data.lora_regex || '');
    setParsedPrompts(data.parsed_prompts || []);
    setAllApplications(data.applications || {});
    setLastSelectedApplications(data.last_selected_applications || []);
    return data;
  }, []);

  const submitSelection = useCallback(async (prompts: string[], custom: string, loras: LoraSelectionData[], prefabs?: { guid: string }[], applications?: { id: string; active: boolean }[], onBeforeClose?: () => void) => {
    const res = await fetch(`${API_BASE}/select_prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompts, custom_prompts: custom, loras, prefabs, applications }),
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
    setLoraFolderMeta(data.folder_meta || {});
    setLoraRegex(data.lora_regex || '');
    return data.folders || {};
  }, []);

  return {
    allPrompts, setAllPrompts,
    allLibraries, setAllLibraries,
    categoryDisplayModes, setCategoryDisplayModes,
    categorySizeModes, setCategorySizeModes,
    customPrompts, setCustomPrompts,
    lastSelected, lastSelectedLoras, lastSelectedPrefabs,
    loraData, setLoraData, loraRegex, loraFolderMeta, setLoraFolderMeta, parsedPrompts,
    allApplications, setAllApplications, lastSelectedApplications,
    loadData, submitSelection, closeWindow, loadLoraData,
  };
}
