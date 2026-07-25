import { useMemo } from 'react';
import type {
  AllPrompts, AllPrograms, SelectedProgramItem, ProgramData,
  TagGroup, LoraItemData, LoraSelectionData, SelectedPrefabItem, AllLibraries,
} from '../types';
import { tagsToDisplayString, parseStringToTags } from './useSelection';

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
  allLibraries: AllLibraries,
  allLoraData: Record<string, LoraItemData[]>,
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
    function resolvePrograms(programIds: string[], depth = 0) {
      for (const pid of programIds) {
        if (resolved.has(pid)) continue;
        resolved.add(pid);
        const app = programById.get(pid);
        if (!app) continue;
        // Execute sub-programs first (recursive) — even if parent has no code
        const subPrograms = (app.selected_programs || []).filter(sp => sp.active !== false);
        if (subPrograms.length > 0) {
          resolvePrograms(subPrograms.map(sp => sp.id), depth + 1);
        }
        // Only add to execution list if this program has actual code
        if (app.code && app.code.trim()) {
          activePrograms.push({ code: app.code, name: app.name });
        }
      }
    }
    // Debug: log selected programs and programById
    console.log('[useProgram] selectedPrograms:', JSON.stringify(selectedPrograms));
    console.log('[useProgram] programById keys:', [...programById.keys()]);
    console.log('[useProgram] allPrograms keys:', Object.keys(allPrograms));

    for (const sa of selectedPrograms) {
      if (!sa.active) continue;
      resolvePrograms([sa.id]);
    }

    // Debug: log resolved program chain
    console.log('[useProgram] activePrograms count:', activePrograms.length);
    if (activePrograms.length > 0) {
      console.log('[useProgram] Resolved program chain:', activePrograms.map((p, i) => `${i}:${p.name}`));
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

    // Build all_tags from allPrompts
    const allTags: Record<string, { name: string; prompt: string; category: string; decorations: string[]; tags: string[]; mute_decorations: string[] }> = {};

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
      }
    }

    // Build context — enrich each Tag with decorations and tags from allTags
    let ctxTags: TagGroup[] = selectedTags.map(g => ({
      ...g,
      tags: g.tags.map(t => {
        const info = allTags[t.prompt.toLowerCase()];
        return {
          ...t,
          decorations: info?.decorations || [],
          tags: info?.tags || [],
        };
      }),
    }));
    let ctxLoras: LoraSelectionData[] = selectedLoras.map(l => {
      const sel = loraSelections[l.file_path];
      return { file_path: l.file_path, name: l.name, strength: sel?.strength ?? 1.0, active_tags: sel?.activeTags ?? [], active: sel?.active ?? true, split_mode: sel?.split_mode };
    });
    // Build guid → PrefabData lookup
    const prefabDataMap = new Map<string, any>();
    for (const libData of Object.values(allLibraries)) {
      for (const pf of (libData.prefabs || [])) {
        if (pf.guid) prefabDataMap.set(pf.guid, pf);
      }
    }

    // Build merged prefab data: selection state + actual tags/loras/custom_prompts
    const buildMergedPrefab = (item: SelectedPrefabItem): any => {
      const pfData = prefabDataMap.get(item.guid);
      return {
        guid: item.guid,
        active: item.active,
        // Selection state: which tag groups / loras are active
        tag_states: item.tag_groups.map(t => ({ ...t })),
        lora_states: item.loras.map(l => ({ ...l })),
        // Actual data from prefab definition
        name: pfData?.name || '',
        tag_groups: pfData?.tag_groups ? pfData.tag_groups.map((g: any) => ({ ...g, tags: g.tags ? g.tags.map((t: any) => ({ ...t })) : g.map((t: any) => ({ ...t })) })) : [],
        loras: pfData?.loras ? pfData.loras.map((l: any) => ({ ...l })) : [],
        custom_prompts: pfData?.custom_prompts || '',
        preview: pfData?.preview || '',
        children: item.children.map(c => buildMergedPrefab(c)),
      };
    };
    let ctxPrefabs: any[] = selectedPrefabs.map(p => buildMergedPrefab(p));
    let ctxCustomPrompts = customPrompts;

    // Find the root program for context inheritance
    const rootProgram = selectedPrograms.find(sp => sp.active);
    const rootProgramData = rootProgram ? programById.get(rootProgram.id) : null;

    // Run each program
    for (const prog of activePrograms) {
      // Build context variables from root program instance's context selections
      let prefabContext: any[] = [];
      let loraContext: LoraSelectionData[] = [];
      let promptContext: TagGroup[] = [];

      if (rootProgram && rootProgramData) {
        if (rootProgramData.enable_prefab_context && rootProgram.context_prefab_guids) {
          prefabContext = rootProgram.context_prefab_guids.map((guid: string) => {
            const pfData = prefabDataMap.get(guid);
            if (!pfData) return null;
            const isActive = !(rootProgram.context_prefab_inactive || []).includes(guid);
            return { guid, name: pfData.name || '', tag_groups: pfData.tag_groups || [], loras: pfData.loras || [], custom_prompts: pfData.custom_prompts || '', preview: pfData.preview || '', active: isActive };
          }).filter(Boolean);
        }
        if (rootProgramData.enable_lora_context && rootProgram.context_lora_paths) {
          const loraLookup = new Map<string, LoraItemData>();
          for (const items of Object.values(allLoraData)) { for (const item of items) loraLookup.set(item.file_path, item); }
          loraContext = rootProgram.context_lora_paths.map((fp: string) => {
            const item = loraLookup.get(fp);
            if (!item) return null;
            const isActive = !(rootProgram.context_lora_inactive || []).includes(fp);
            const sel = loraSelections[fp];
            return { file_path: fp, name: item.name, strength: sel?.strength ?? 1.0, active_tags: sel?.activeTags ?? item.tags ?? [], active: isActive, split_mode: sel?.split_mode };
          }).filter(Boolean) as LoraSelectionData[];
        }
        if (rootProgramData.enable_prompt_context && rootProgram.context_prompt_texts) {
          promptContext = rootProgram.context_prompt_texts.map((text: string) => {
            const isActive = !(rootProgram.context_prompt_inactive || []).includes(text);
            const tg = parseStringToTags(text, allPrompts);
            return { ...tg, active: isActive };
          });
        }
      }

      try {
        const fn = new Function(
          'tag_groups', 'loras', 'prefabs', 'custom_prompts', 'prompts_data', 'all_tags',
          'prefab_context', 'lora_context', 'prompt_context',
          prog.code,
        );
        const result = fn(
          ctxTags.map(g => ({ ...g, tags: g.tags.map(t => ({ ...t, decorations: t.decorations ? [...t.decorations] : [], tags: t.tags ? [...t.tags] : [] })) })),
          ctxLoras.map(l => ({ ...l })),
          ctxPrefabs.map(p => ({
            ...p,
            tag_groups: p.tag_groups ? p.tag_groups.map((g: any) => ({ ...g, tags: g.tags ? g.tags.map((t: any) => ({ ...t })) : [] })) : [],
            loras: p.loras ? p.loras.map((l: any) => ({ ...l })) : [],
            tag_states: p.tag_states ? p.tag_states.map((t: any) => ({ ...t })) : [],
            lora_states: p.lora_states ? p.lora_states.map((l: any) => ({ ...l })) : [],
            children: p.children ? p.children.map((c: any) => ({ ...c })) : [],
          })),
          ctxCustomPrompts,
          allPrompts,
          allTags,
          prefabContext,
          loraContext,
          promptContext,
        );
        if (result && typeof result === 'object') {
          if (Array.isArray(result.tag_groups)) ctxTags = result.tag_groups;
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
  }, [selectedPrograms, allPrograms, selectedTags, selectedLoras, loraSelections, selectedPrefabs, customPrompts, allPrompts, allLibraries, allLoraData]);
}
