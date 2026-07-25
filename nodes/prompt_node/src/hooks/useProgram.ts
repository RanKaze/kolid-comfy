import { useMemo } from 'react';
import type {
  AllPrompts, AllPrograms, SelectedProgramItem, ProgramData,
  TagGroup, LoraItemData, LoraSelectionData, SelectedPrefabItem,
} from '../types';
import { tagsToDisplayString } from './useSelection';

function toList(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

export interface ProgramResult {
  filteredTags: TagGroup[];
  filteredLoras: LoraSelectionData[];
  filteredPrefabs: SelectedPrefabItem[];
  filteredCustomPrompts: string;
  removedTagKeys: Set<string>;
  removedLoraPaths: Set<string>;
  removedPrefabGuids: Set<string>;
  addedTagKeys: Set<string>;
  addedLoraPaths: Set<string>;
  addedPrefabGuids: Set<string>;
}

export function useProgram(
  selectedPrograms: SelectedProgramItem[],
  allPrograms: AllPrograms,
  selectedTags: TagGroup[],
  selectedLoras: LoraItemData[],
  loraSelections: Record<string, { activeTags: string[]; strength: number; active: boolean; split_mode?: boolean }>,
  selectedPrefabs: SelectedPrefabItem[],
  customPrompts: string,
  allPrompts: AllPrompts,
): ProgramResult {
  return useMemo(() => {
    // Build a lookup of all programs by id
    const programById = new Map<string, ProgramData>();
    for (const catData of Object.values(allPrograms)) {
      for (const app of (catData.programs || [])) {
        programById.set(app.id, app);
      }
    }

    // Collect active programs in order, resolving sub-programs recursively
    const activePrograms: { code: string; name: string }[] = [];
    const resolved = new Set<string>();
    function resolvePrograms(programIds: string[]) {
      for (const pid of programIds) {
        if (resolved.has(pid)) continue;
        resolved.add(pid);
        const app = programById.get(pid);
        if (!app || !app.code || !app.code.trim()) continue;
        // Execute sub-programs first
        if (app.selected_programs && app.selected_programs.length > 0) {
          resolvePrograms(app.selected_programs.filter(sp => sp.active !== false).map(sp => sp.id));
        }
        activePrograms.push({ code: app.code, name: app.name });
      }
    }
    for (const sa of selectedPrograms) {
      if (!sa.active) continue;
      resolvePrograms([sa.id]);
    }

    const noProgramsResult: ProgramResult = {
      filteredTags: selectedTags,
      filteredLoras: selectedLoras.map(l => {
        const sel = loraSelections[l.file_path];
        return { file_path: l.file_path, name: l.name, strength: sel?.strength ?? 1.0, active_tags: sel?.activeTags ?? [], active: sel?.active ?? true, split_mode: sel?.split_mode };
      }),
      filteredPrefabs: selectedPrefabs,
      filteredCustomPrompts: customPrompts,
      removedTagKeys: new Set(),
      removedLoraPaths: new Set(),
      removedPrefabGuids: new Set(),
      addedTagKeys: new Set(),
      addedLoraPaths: new Set(),
      addedPrefabGuids: new Set(),
    };

    if (activePrograms.length === 0) {
      return noProgramsResult;
    }

    // Build all_tags, tag_index, decoration_index from allPrompts
    const allTags: Record<string, { name: string; prompt: string; category: string; decorations: string[]; tags: string[]; mute_decorations: string[] }> = {};
    const tagIndex: Record<string, string[]> = {};
    const decorationIndex: Record<string, string[]> = {};

    for (const [cat, catData] of Object.entries(allPrompts)) {
      const cd = catData as any;
      const catDecos = toList(cd.decorations).map(d => d.toLowerCase());
      const catTags = toList(cd.tags).map(t => t.toLowerCase());
      const prompts: any[] = cd.prompts || [];
      for (const p of prompts) {
        if (!p.prompt) continue;
        const key = p.prompt.toLowerCase();
        const pDecos = toList(p.decorations).map(d => d.toLowerCase());
        const pTags = toList(p.tags).map(t => t.toLowerCase());
        const pMute = toList(p.mute_decorations).map(d => d.toLowerCase());
        allTags[key] = {
          name: p.name || p.prompt,
          prompt: p.prompt,
          category: cat,
          decorations: [...new Set([...catDecos, ...pDecos])],
          tags: [...new Set([...catTags, ...pTags])],
          mute_decorations: pMute,
        };
        for (const t of allTags[key].tags) {
          if (!tagIndex[t]) tagIndex[t] = [];
          tagIndex[t].push(allTags[key].prompt);
        }
        for (const d of allTags[key].decorations) {
          if (!decorationIndex[d]) decorationIndex[d] = [];
          decorationIndex[d].push(allTags[key].prompt);
        }
      }
    }

    // Build context — is_from_parsing is already set on each tag
    let ctxTags: TagGroup[] = selectedTags.map(g => g.map(t => ({ ...t })));
    let ctxLoras: LoraSelectionData[] = selectedLoras.map(l => {
      const sel = loraSelections[l.file_path];
      return { file_path: l.file_path, name: l.name, strength: sel?.strength ?? 1.0, active_tags: sel?.activeTags ?? [], active: sel?.active ?? true, split_mode: sel?.split_mode };
    });
    let ctxPrefabs: SelectedPrefabItem[] = selectedPrefabs.map(p => ({ ...p }));
    let ctxCustomPrompts = customPrompts;

    // Run each program
    for (const prog of activePrograms) {
      try {
        const fn = new Function(
          'tags', 'loras', 'prefabs', 'custom_prompts', 'prompts_data', 'all_tags', 'tag_index', 'decoration_index',
          prog.code,
        );
        const result = fn(
          ctxTags.map(g => g.map(t => ({ ...t }))),
          ctxLoras.map(l => ({ ...l })),
          ctxPrefabs.map(p => ({ ...p })),
          ctxCustomPrompts,
          allPrompts,
          allTags,
          tagIndex,
          decorationIndex,
        );
        if (result && typeof result === 'object') {
          if (Array.isArray(result.tags)) ctxTags = result.tags;
          if (Array.isArray(result.loras)) ctxLoras = result.loras;
          if (Array.isArray(result.prefabs)) ctxPrefabs = result.prefabs;
          if (typeof result.custom_prompts === 'string') ctxCustomPrompts = result.custom_prompts;
        }
      } catch (e) {
        console.error(`[Program] Error in '${prog.name}':`, e);
      }
    }

    // Compute removed and added sets
    const originalTagKeys = new Set(selectedTags.map(g => tagsToDisplayString(g)));
    const filteredTagKeys = new Set(ctxTags.map(g => tagsToDisplayString(g)));
    const removedTagKeys = new Set<string>();
    const addedTagKeys = new Set<string>();
    for (const key of originalTagKeys) {
      if (!filteredTagKeys.has(key)) removedTagKeys.add(key);
    }
    for (const key of filteredTagKeys) {
      if (!originalTagKeys.has(key)) addedTagKeys.add(key);
    }

    const originalLoraPaths = new Set(selectedLoras.map(l => l.file_path));
    const filteredLoraPaths = new Set(ctxLoras.map(l => l.file_path));
    const removedLoraPaths = new Set<string>();
    const addedLoraPaths = new Set<string>();
    for (const fp of originalLoraPaths) {
      if (!filteredLoraPaths.has(fp)) removedLoraPaths.add(fp);
    }
    for (const fp of filteredLoraPaths) {
      if (!originalLoraPaths.has(fp)) addedLoraPaths.add(fp);
    }

    const originalPrefabGuids = new Set(selectedPrefabs.map(p => p.guid));
    const filteredPrefabGuids = new Set(ctxPrefabs.map(p => p.guid));
    const removedPrefabGuids = new Set<string>();
    const addedPrefabGuids = new Set<string>();
    for (const guid of originalPrefabGuids) {
      if (!filteredPrefabGuids.has(guid)) removedPrefabGuids.add(guid);
    }
    for (const guid of filteredPrefabGuids) {
      if (!originalPrefabGuids.has(guid)) addedPrefabGuids.add(guid);
    }

    return {
      filteredTags: ctxTags,
      filteredLoras: ctxLoras,
      filteredPrefabs: ctxPrefabs,
      filteredCustomPrompts: ctxCustomPrompts,
      removedTagKeys,
      removedLoraPaths,
      removedPrefabGuids,
      addedTagKeys,
      addedLoraPaths,
      addedPrefabGuids,
    };
  }, [selectedPrograms, allPrograms, selectedTags, selectedLoras, loraSelections, selectedPrefabs, customPrompts, allPrompts]);
}
