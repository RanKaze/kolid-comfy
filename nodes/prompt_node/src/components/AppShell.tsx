import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import type {
  AllPrompts, AllLibraries, PointsResponse,
  CategoryDisplayModes, CategorySizeModes, FocusPoints, DragState,
  PromptData, TagGroup, PrefabData, CategoryData, LibraryData, ProgramData, AllPrograms, ProgramCategoryData, SelectedProgramItem, SelectedProgramRef,
  LoraItemData, LoraSelectionData, SelectedPrefabItem, SelectedPrefabRef, SelectedPrefabLoraState, SelectedPrefabTagState,
  PromptContextBase, RegionContext, RegionBox, BackgroundContext,
} from '../types';
import {
  categoryGroup, libraryGroup, categoryDisplay, libraryDisplay, programGroup,
} from '../modules';
import {
  parseStringToTags, tagsToDisplayName, tagsToDisplayString,
  findPromptData, getPromptDecorations, combineTagGroups,
  isBasePromptSelectedInTags, findTagGroupByBasePrompt,
  tryParseLine,
} from '../hooks/useSelection';
import { useApi } from '../hooks/useApi';
import { useTempContext } from '../hooks/useTempContext';
import { useProgram, buildAllTagsLookup, enrichTagGroups, buildLoraSelectionData } from '../hooks/useProgram';
import { SearchBar } from './SearchBar';
import { PrefabItem } from './PrefabItem';
import { CustomPromptsEditor } from './CustomPromptsEditor';
import { ProgramCodeEditor } from './ProgramCodeEditor';
import { LoraFolderCard } from './LoraFolderCard';
import { Lora } from './Lora';
import { TextToggle } from './TextToggle';
import RegionCanvas from './RegionCanvas';
import { RegionFormatManager } from '../RegionFormatManager';

/* ========== Inline SVG Icons (no emoji) ========== */
const iconPalette = <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle',marginRight:'6px'}}><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>;
const iconArrowLeft = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle',marginRight:'4px'}}><path d="M19 12H5M12 19l-7-7 7-7"/></svg>;
const iconGrip = <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{verticalAlign:'middle'}}><circle cx="9" cy="6" r="1.8"/><circle cx="9" cy="12" r="1.8"/><circle cx="9" cy="18" r="1.8"/><circle cx="15" cy="6" r="1.8"/><circle cx="15" cy="12" r="1.8"/><circle cx="15" cy="18" r="1.8"/></svg>;
const iconGrid = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>;
const iconGear = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>;
const iconLayers = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>;
const iconTrash = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>;
const iconChevronUp = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M18 15l-6-6-6 6"/></svg>;
const iconChevronDown = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M6 9l6 6 6-6"/></svg>;
const iconX = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M18 6L6 18M6 6l12 12"/></svg>;
const iconClipboard = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle',marginRight:'4px'}}><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>;
const iconLoadFromImage = <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle',marginRight:'6px'}}><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>;
const iconPlus = <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M12 5v14M5 12h14"/></svg>;
const iconCode = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>;

const ZOOM_DELAY = 2000;
let zoomTimer: ReturnType<typeof setTimeout> | null = null;
let leaveTimer: ReturnType<typeof setTimeout> | null = null;
let currentZoomItem: HTMLElement | null = null;
let isDragging = false;

const dragState: DragState = { type: null, item: null, category: null, element: null, library: null, index: null };
let dragDropController: AbortController | null = null;
let initDone = false;
let zoomRestoreSelector: string | null = null;
let zoomRestoreVars: Record<string, string> = {};

function clearZoomState() {
  if (zoomTimer) { clearTimeout(zoomTimer); zoomTimer = null; }
  if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
  if (currentZoomItem) {
    currentZoomItem.classList.remove('zoom-view', 'zoom-exit');
    currentZoomItem = null;
  }
}

function snapshotZoom() {
  if (currentZoomItem) {
    const el = currentZoomItem;
    if (el.dataset.prefab) {
      zoomRestoreSelector = `.prompt-item[data-prefab="${el.dataset.prefab}"]`;
    } else if (el.dataset.id) {
      zoomRestoreSelector = `.prompt-item[data-id="${el.dataset.id}"]`;
    } else {
      zoomRestoreSelector = null;
      return;
    }
    zoomRestoreVars = {
      '--zoom-width': el.style.getPropertyValue('--zoom-width'),
      '--zoom-height': el.style.getPropertyValue('--zoom-height'),
      '--zoom-offset-x': el.style.getPropertyValue('--zoom-offset-x'),
      '--zoom-offset-y': el.style.getPropertyValue('--zoom-offset-y'),
    };
  }
}

// Build prompt text from a PromptContextBase — same logic as region desc:
// direct prompts (strip brackets) + prefab expansion (strip brackets) + custom + lora trigger words
function buildPromptText(ctx: PromptContextBase, findPrefabByGuid: (guid: string) => PrefabData | null): string {
  const parts: string[] = [];
  // 1. Direct prompts — strip [ and ]
  for (const p of (ctx.prompts || [])) {
    const cleaned = p.replace(/\[/g, '').replace(/\]/g, '');
    if (cleaned) parts.push(cleaned);
  }
  // 2. Prefab prompts — expand tree, strip brackets
  function expandPrefabPrompts(items: any[]): string[] {
    const result: string[] = [];
    for (const item of items) {
      if (item.active === false) continue;
      const prefab = findPrefabByGuid(item.guid);
      if (prefab && prefab.tag_groups) {
        const savedTags = item.tag_groups || [];
        for (const group of prefab.tag_groups) {
          if (!Array.isArray(group)) continue;
          const names = group.map((t: any) => t.name || t.prompt || '');
          let key = names.join(' ');
          const str = group.strength ?? 1.0;
          if (str !== 1.0) key = `${key}:${str}`;
          const saved = savedTags.find((st: any) => st.key === key);
          if (saved && saved.active === false) continue;
          const pp: string[] = [];
          for (let i = 0; i < group.tags.length; i++) {
            const tag = group.tags[i];
            const pt = tag.prompt || ''; if (!pt) continue;
            const d = group.tags.length - 1 - i; const s = group.strength;
            let t: string; if (d > 0) t = '['.repeat(d) + pt + ']'.repeat(d); else t = pt;
            if (s !== 1.0) t = `(${t}:${s})`; pp.push(t);
          }
          if (pp.length) { const ps = pp.join(' '); result.push(ps.replace(/\[/g, '').replace(/\]/g, '')); }
        }
      }
      if (prefab && prefab.custom_prompts) result.push(prefab.custom_prompts);
      if (item.children) result.push(...expandPrefabPrompts(item.children));
    }
    return result;
  }
  parts.push(...expandPrefabPrompts(ctx.prefabs || []));
  // 3. Custom prompts
  if ((ctx.custom_prompts || '').trim()) parts.push(ctx.custom_prompts.trim());
  // 4. Lora trigger words
  for (const l of (ctx.loras || [])) {
    if (l.active === false) continue;
    parts.push(...(l.active_tags || []));
  }
  // 5. Prefab lora tags
  function expandPrefabLoraTags(items: any[]): string[] {
    const result: string[] = [];
    for (const item of items) {
      if (item.active === false) continue;
      const prefab = findPrefabByGuid(item.guid);
      if (prefab && prefab.loras) {
        for (const pl of prefab.loras) {
          if (pl.active === false) continue;
          result.push(...(pl.active_tags || []));
        }
      }
      if (item.children) result.push(...expandPrefabLoraTags(item.children));
    }
    return result;
  }
  parts.push(...expandPrefabLoraTags(ctx.prefabs || []));
  return parts.filter(Boolean).join(', ');
}

export function AppShell() {
  const api = useApi();
  const { allPrompts, allLibraries, categoryDisplayModes, categorySizeModes,
    customPrompts, setCustomPrompts, loadData: apiLoadData, submitSelection, closeWindow, loraRegex,
    setAllPrompts, setAllLibraries, setCategoryDisplayModes, setCategorySizeModes,
    loraData, loadLoraData, lastSelectedLoras, lastSelectedPrefabs, loraFolderMeta, setLoraFolderMeta, parsedPrompts,
    allPrograms, setAllPrograms, lastSelectedPrograms,
    sources,
  } = api;

  const isLoraFiltered = useCallback((item: LoraItemData) => {
    if (!loraRegex) return false;
    const regex = new RegExp(loraRegex);
    return !regex.test(item.file_path);
  }, [loraRegex]);

  const [selectedTags, setSelectedTags] = useState<TagGroup[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFilter, setSelectedFilter] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [expandedLibraries, setExpandedLibraries] = useState<Set<string>>(new Set());
  const [animating, setAnimating] = useState<Set<string>>(new Set());
  const [focusPoints, setFocusPoints] = useState<FocusPoints>({});
  const [categoryFocusPoints, setCategoryFocusPoints] = useState<Record<string, {x:number;y:number}>>({});
  const [videoVolumes, setVideoVolumes] = useState<Record<string, number>>({});
  const [clarityPoints, setClarityPoints] = useState<Record<string, Array<{x:number;y:number}>>>({});
  const tempCtx = useTempContext();
  interface LoraSelectionState {
    activeTags: string[];
    strength: number;
    active: boolean;
    split_mode?: boolean;
  }
  const [selectedLoras, setSelectedLoras] = useState<LoraItemData[]>([]);
  const [loraSelections, setLoraSelections] = useState<Record<string, LoraSelectionState>>({});
  const [selectedPrefabs, setSelectedPrefabs] = useState<SelectedPrefabItem[]>([]);
  const prefabRestoredRef = useRef(false);
  const [selectedPrograms, setSelectedPrograms] = useState<SelectedProgramItem[]>([]);
  const programRestoredRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loadFromImageData, setLoadFromImageData] = useState<any>(null);

  // Tags that came from prompt_parsing — used to mark is_from_parsing on tag objects during loadData
  const parsedTagKeys = useMemo(() => {
    const set = new Set<string>();
    for (const str of parsedPrompts) {
      const tags = parseStringToTags(str, allPrompts);
      set.add(tagsToDisplayString(tags));
    }
    return set;
  }, [parsedPrompts, allPrompts]);

  // Tags added via CustomPromptsEditor — always blue (original), never purple
  const [customAddedTagKeys, setCustomAddedTagKeys] = useState<Set<string>>(new Set());

  // Listen for auto-tag messages from parent window
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'auto-tag' && typeof event.data.tag === 'string') {
        const tag = event.data.tag.trim();
        setCustomPrompts(prev => {
          if (!prev) return tag;
          const existing = prev.split('\n').map(s => s.trim()).filter(Boolean);
          if (existing.includes(tag)) return prev;
          return prev + '\n' + tag;
        });
      } else if (event.data?.type === 'get-prompt') {
        // Atomic collection: return current prompt/lora/prefab data to parent
        const promptsToSend = selectedTags.map(g => tagsToDisplayString(g));
        const lorasPayload: LoraSelectionData[] = selectedLoras.map(l => {
          const sel = loraSelections[l.file_path];
          return {
            file_path: l.file_path,
            name: l.name,
            strength: sel?.strength ?? 1.0,
            active_tags: sel?.activeTags ?? [],
            active: sel?.active ?? true,
            split_mode: sel?.split_mode,
          };
        });
        const prefabsPayload = selectedPrefabs.map(p => ({ guid: p.guid, active: p.active, tag_groups: p.tag_groups, loras: p.loras, children: p.children }));
        window.parent.postMessage({
          type: 'prompt-data',
          data: {
            prompts: promptsToSend,
            custom_prompts: customPrompts,
            loras: lorasPayload,
            prefabs: prefabsPayload,
          }
        }, '*');
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [setCustomPrompts, selectedTags, selectedLoras, loraSelections, selectedPrefabs, customPrompts]);

  // Helper: find prefab by guid across all libraries
  const findPrefabByGuid = useCallback((guid: string): PrefabData | null => {
    for (const libData of Object.values(allLibraries)) {
      for (const pf of libData.prefabs || []) {
        if (pf.guid === guid) return pf;
      }
    }
    return null;
  }, [allLibraries]);

  // Helper: build recursive SelectedPrefabItem tree from a guid
  const buildPrefabItemTree = useCallback((guid: string, visited = new Set<string>()): SelectedPrefabItem | null => {
    if (visited.has(guid)) return null;
    const prefab = findPrefabByGuid(guid);
    if (!prefab) return null;
    visited.add(guid);
    return {
      guid,
      active: true,
      tag_groups: (prefab.tag_groups || []).map(g => ({
        key: tagsToDisplayName(g as any),
        active: true,
      })),
      loras: (prefab.loras || []).map(l => ({
        file_path: l.file_path || (l as any).file_name || '',
        active: true,
      })),
      children: (prefab.selected_prefabs || [])
        .map(sp => buildPrefabItemTree(sp.guid, new Set(visited)))
        .filter(Boolean) as SelectedPrefabItem[],
    };
  }, [findPrefabByGuid]);

  // Helper: cascade active state to all children and loras
  const cascadeActive = useCallback((item: SelectedPrefabItem, active: boolean): SelectedPrefabItem => ({
    ...item,
    active,
    tag_groups: item.tag_groups.map(t => ({ ...t, active })),
    loras: item.loras.map(l => ({ ...l, active })),
    children: item.children.map(c => cascadeActive(c, active)),
  }), []);

  // Helper: toggle active on a tree node by guid (recursive search)
  const toggleTreeActive = useCallback((items: SelectedPrefabItem[], guid: string): SelectedPrefabItem[] =>
    items.map(item => {
      if (item.guid === guid) {
        return cascadeActive(item, !item.active);
      }
      return { ...item, children: toggleTreeActive(item.children, guid) };
    }),
  [cascadeActive]);

  // Helper: toggle lora active on a tree node by guid (recursive search)
  const toggleTreeLora = useCallback((items: SelectedPrefabItem[], guid: string, filePath: string): SelectedPrefabItem[] =>
    items.map(item => {
      if (item.guid === guid) {
        return { ...item, loras: item.loras.map(l => l.file_path === filePath ? { ...l, active: !l.active } : l) };
      }
      return { ...item, children: toggleTreeLora(item.children, guid, filePath) };
    }),
  []);

  const [imgVersion, setImgVersion] = useState(0);
  // Region state
  const [enableRegion, setEnableRegion] = useState(false);
  const [regionFormat, setRegionFormat] = useState('');
  const [formatSlots, setFormatSlots] = useState<any[]>([]);
  const [activeSlotId, setActiveSlotId] = useState<string | null>(null);
  const activeSlotIdRef = useRef<string | null>(null);
  useEffect(() => { activeSlotIdRef.current = activeSlotId; }, [activeSlotId]);
  const formatSlotContextsRef = useRef<Map<string, PromptContextBase>>(new Map());
  const formatManagerRef = useRef<RegionFormatManager | null>(null);
  const [regionImage, setRegionImage] = useState('');
  const [regionW, setRegionW] = useState(1024);
  const [regionH, setRegionH] = useState(1024);
  const [regionBg, setRegionBg] = useState(25);
  const [regionOpacity, setRegionOpacity] = useState(14);
  const [regionBoxes, setRegionBoxes] = useState<RegionBox[]>([]);
  const [regionActiveIdx, setRegionActiveIdx] = useState(-1);
  const regionBoxesRef = useRef<RegionBox[]>([]);
  const regionActiveRef = useRef(-1);
  useEffect(() => { regionBoxesRef.current = regionBoxes; }, [regionBoxes]);
  useEffect(() => { regionActiveRef.current = regionActiveIdx; }, [regionActiveIdx]);
  const imgUrl = useCallback((path: string) => path ? `/images/${path}?v=${imgVersion}` : '', [imgVersion]);
  const [, forceRender] = useState(0);
  const rerender = useCallback(() => forceRender(n => n + 1), []);

  const toList = useCallback((v: string | string[] | undefined): string[] => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
    return [];
  }, []);

  const allFilterOptions = useMemo(() => {
    const set = new Set<string>();
    for (const catData of Object.values(allPrompts)) {
      const cd = catData as any;
      (Array.isArray(cd.decorations) ? cd.decorations : typeof cd.decorations === 'string' ? cd.decorations.split(',').map((s: string) => s.trim()).filter(Boolean) : []).forEach((d: string) => set.add(d));
      (Array.isArray(cd.tags) ? cd.tags : typeof cd.tags === 'string' ? cd.tags.split(',').map((s: string) => s.trim()).filter(Boolean) : []).forEach((t: string) => set.add(t));
      if (cd.prompts) {
        for (const p of cd.prompts) {
          toList(p.decorations).forEach((d: string) => set.add(d));
          toList(p.tags).forEach((t: string) => set.add(t));
        }
      }
    }
    return [...set].sort();
  }, [allPrompts, toList]);

  // Auto-reset filter when its value no longer exists in any prompt
  useEffect(() => {
    if (selectedFilter && !allFilterOptions.includes(selectedFilter)) {
      setSelectedFilter('');
    }
  }, [selectedFilter, allFilterOptions]);

  const bgSizesRef = useRef<Record<string,{w:number;h:number}>>({});
  const bgBaseRef = useRef<Record<string,{x:number;y:number}>>({});
  const categoryFocusRef = useRef<Record<string,{x:number;y:number}>>({});
  const shakeRef = useRef({ ox:0, oy:0, tx:0, ty:0, lt: Date.now() });
  const mouseRef = useRef({ x:0, y:0 });
  const bgAnimRunningRef = useRef(false);

  // Keep categoryFocusRef in sync with state
  useEffect(() => { categoryFocusRef.current = categoryFocusPoints; }, [categoryFocusPoints]);

  // ========== LOAD DATA ==========
  const loadData = useCallback(async () => {
    const data = await apiLoadData();
    const lastSelected = data.last_selected || [];

    // Build parsed keys from loaded data to mark is_from_parsing
    const loadedParsedKeys = new Set<string>();
    for (const str of (data.parsed_prompts || [])) {
      const tags = parseStringToTags(str, data.categories);
      loadedParsedKeys.add(tagsToDisplayString(tags));
    }
    const sources = (data as any).sources || {};

    const tagGroups = lastSelected
      .filter(str => !str.startsWith('<') || !str.endsWith('>'))
      .map(str => {
        const tg = parseStringToTags(str, data.categories);
        const key = tagsToDisplayString(tg);
        const isFromParsing = loadedParsedKeys.has(key);
        const source = (sources[key] as 'parsing' | 'program') || (isFromParsing ? 'parsing' as const : 'normal' as const);
        return { ...tg, tags: tg.tags.map(t => ({ ...t })), source };
      });
    setSelectedTags(tagGroups);

    let cp = data.custom_prompts || '';
    for (const str of lastSelected) {
      const m = str.match(/^<(.+)>$/);
      if (m) {
        const recovered = m[1];
        if (cp) {
          if (!cp.split('\n').map(s => s.trim()).includes(recovered)) cp += '\n' + recovered;
        } else { cp = recovered; }
      }
    }
    setCustomPrompts(cp);

    return data;
  }, [apiLoadData, setCustomPrompts, setSelectedTags]);

  const loraRestoredRef = useRef(false);

  useEffect(() => {
    loadData().then(() => {
      try { const s = localStorage.getItem('kolid_focus_points'); if (s) setFocusPoints(JSON.parse(s)); } catch {}
      try { const s = localStorage.getItem('kolid_category_focus_points'); if (s) setCategoryFocusPoints(JSON.parse(s)); } catch {}
      try { const s = localStorage.getItem('kolid_video_volumes'); if (s) setVideoVolumes(JSON.parse(s)); } catch {}
      try { const s = localStorage.getItem('kolid_clarity_points'); if (s) setClarityPoints(JSON.parse(s)); } catch {}
    });
    loadLoraData();
    // Fetch region config
    fetch('/region_config').then(r=>r.json()).then(d=>{
      if(d.image){setRegionImage(d.image);}
      setRegionW(d.width||1024); setRegionH(d.height||1024); setRegionBg(d.bg_brightness||25);
      setEnableRegion(!!d.enable_region);
      if (d.region_format) {
        setRegionFormat(d.region_format);
        const mgr = new RegionFormatManager(d.region_format);
        formatManagerRef.current = mgr;
        const slots = mgr.getContextSlots();
        setFormatSlots(slots);
        console.log('[RegionFormat] Parsed format:', d.region_format.substring(0, 100), 'slots:', slots);
      } else if (d.enable_region) {
        console.log('[RegionFormat] No region_format provided in config');
      }
      try {
        const cd = JSON.parse(d.initial_boxes || '[]');
        if (Array.isArray(cd)) {
          // Old format: just boxes
          setRegionBoxes(cd);
        } else if (cd && typeof cd === 'object') {
          // New format: { boxes, format_slots, background_context }
          if (Array.isArray(cd.boxes)) setRegionBoxes(cd.boxes);
          if (cd.format_slots && typeof cd.format_slots === 'object') {
            for (const [k, v] of Object.entries(cd.format_slots)) {
              formatSlotContextsRef.current.set(k, v as PromptContextBase);
            }
          }
          if (cd.background_context) {
            backgroundContextRef.current = cd.background_context;
          }
        }
      } catch {}
    }).catch(()=>{});
  }, []);

  // POST region data on changes
  const regionConfirmTimer = useRef<any>(null);
  useEffect(() => {
    if (!enableRegion) return;
    if (regionConfirmTimer.current) clearTimeout(regionConfirmTimer.current);
    regionConfirmTimer.current = setTimeout(() => {
      fetch('/region_confirm', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ boxes: regionBoxesRef.current }),
      }).catch(()=>{});
    }, 500);
  }, [regionBoxes, enableRegion]);

  // Context switching for regions
  const prevRegionActiveRef = useRef(-2);
  const isRegionReloadingRef = useRef(false);
  const backgroundContextRef = useRef<BackgroundContext | null>(null);

  useEffect(() => {
    if (!enableRegion) return;
    // Skip if a format slot is active (format slots manage their own context switching)
    if (activeSlotId !== null) {
      prevRegionActiveRef.current = regionActiveIdx;
      return;
    }
    if (regionActiveIdx === prevRegionActiveRef.current) return;
    const prevIdx = prevRegionActiveRef.current;
    prevRegionActiveRef.current = regionActiveIdx;

    // Save current prompt selection to the previous context
    const promptsToSend = selectedTags.map(g => tagsToDisplayString(g));
    const lorasPayload: LoraSelectionData[] = selectedLoras.map(l => {
      const sel = loraSelections[l.file_path];
      return { file_path: l.file_path, name: l.name, strength: sel?.strength ?? 1.0, active_tags: sel?.activeTags ?? [], active: sel?.active ?? true, split_mode: sel?.split_mode };
    });
    const prefabsPayload = selectedPrefabs.map(p => ({ guid: p.guid, active: p.active, tag_groups: p.tag_groups, loras: p.loras, children: p.children }));
    const currentCtx: PromptContextBase = {
      prompts: promptsToSend, custom_prompts: customPrompts, loras: lorasPayload, prefabs: prefabsPayload,
      label: prevIdx >= 0 ? `Region ${String(prevIdx + 1).padStart(2, '0')}` : 'Background',
    };

    if (prevIdx >= 0 && prevIdx < regionBoxesRef.current.length) {
      const nbs = [...regionBoxesRef.current];
      nbs[prevIdx] = { ...nbs[prevIdx], promptContext: currentCtx };
      setRegionBoxes(nbs);
      regionBoxesRef.current = nbs;
    } else if (prevIdx < 0) {
      backgroundContextRef.current = { ...currentCtx, isBackground: true };
    }

    let ctxToLoad: PromptContextBase | null = null;
    if (regionActiveIdx >= 0) {
      ctxToLoad = regionBoxesRef.current[regionActiveIdx]?.promptContext || null;
    } else {
      ctxToLoad = backgroundContextRef.current;
    }

    isRegionReloadingRef.current = true;
    fetch('/switch_context', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(ctxToLoad || { prompts: [], custom_prompts: '', loras: [], prefabs: [] }),
    }).then(async () => {
      loraRestoredRef.current = false;
      prefabRestoredRef.current = false;
      programRestoredRef.current = false;
      setSelectedLoras([]);
      setLoraSelections({});
      setSelectedPrefabs([]);
      setSelectedPrograms([]);
      setSelectedTags([]);
      setCustomPrompts('');
      setCustomAddedTagKeys(new Set());
      await Promise.all([loadData(), loadLoraData()]);
      isRegionReloadingRef.current = false;
    }).catch(() => { isRegionReloadingRef.current = false; });
  }, [regionActiveIdx, enableRegion]);

  // Restore selected loras from last_selected_loras after loraData loads
  useEffect(() => {
    if (loraRestoredRef.current) return;
    if (!loraData || Object.keys(loraData).length === 0) return;
    if (!lastSelectedLoras || lastSelectedLoras.length === 0) {
      loraRestoredRef.current = true;
      return;
    }
    const available = new Map<string, LoraItemData>();
    for (const items of Object.values(loraData)) {
      for (const item of items) {
        available.set(item.file_path, item);
      }
    }
    const restoredLoras: LoraItemData[] = [];
    const restoredSelections: Record<string, LoraSelectionState> = {};
    for (const saved of lastSelectedLoras) {
      const lookupKey = (saved as any).file_path || (saved as any).file_name;
      const item = available.get(lookupKey);
      const loraSource = sources[`lora:${lookupKey}`] || 'normal';
      if (item) {
        restoredLoras.push({ ...item, source: loraSource as any });
        restoredSelections[item.file_path] = {
          activeTags: saved.active_tags || [],
          strength: saved.strength ?? 1.0,
          active: saved.active ?? true,
          split_mode: saved.split_mode,
        };
      } else {
        // Lora was saved but is not in current scan results (filtered by regex or removed)
        const derivedName = lookupKey.includes('/') ? lookupKey.split('/').pop()! : lookupKey;
        restoredLoras.push({
          name: saved.name || derivedName,
          file_name: derivedName,
          file_path: lookupKey,
          preview_url: '',
          tags: saved.active_tags || [],
          metadata: { missing: true },
          source: loraSource as any,
        });
        restoredSelections[lookupKey] = {
          activeTags: saved.active_tags || [],
          strength: saved.strength ?? 1.0,
          active: saved.active ?? true,
          split_mode: saved.split_mode,
        };
      }
    }
    setSelectedLoras(restoredLoras);
    setLoraSelections(restoredSelections);
    loraRestoredRef.current = true;
  }, [loraData, lastSelectedLoras, sources]);

  // Restore selected prefabs from last_selected_prefabs (recursive tree)
  useEffect(() => {
    if (prefabRestoredRef.current) return;
    if (!allLibraries || Object.keys(allLibraries).length === 0) return;
    if (!lastSelectedPrefabs || lastSelectedPrefabs.length === 0) {
      prefabRestoredRef.current = true;
      return;
    }

    function restoreTree(
      node: { guid: string; active?: boolean; tag_groups?: SelectedPrefabTagState[]; tags?: SelectedPrefabTagState[]; loras?: SelectedPrefabLoraState[]; children?: any[] },
      visited: Set<string>,
    ): SelectedPrefabItem | null {
      if (visited.has(node.guid)) return null;
      const prefab = findPrefabByGuid(node.guid);
      if (!prefab) return null;
      visited.add(node.guid);

      // Restore tags: use saved state if available, else default all active
      const savedTags = (node.tag_groups || node.tags || []) as SelectedPrefabTagState[];
      const tag_groups: SelectedPrefabTagState[] = (prefab.tag_groups || []).map(g => {
        const key = tagsToDisplayName(g as any);
        const saved = savedTags.find(st => st.key === key);
        return { key, active: saved ? saved.active !== false : true };
      });

      // Restore loras: use saved state if available, else default all active
      const savedLoras = (node.loras || []) as SelectedPrefabLoraState[];
      const loras: SelectedPrefabLoraState[] = (prefab.loras || []).map(l => {
        const fp = l.file_path || (l as any).file_name || '';
        const saved = savedLoras.find(sl => sl.file_path === fp);
        return { file_path: fp, active: saved ? saved.active !== false : true };
      });

      // Restore children recursively
      const savedChildren = (node.children || []) as any[];
      const children: SelectedPrefabItem[] = (prefab.selected_prefabs || [])
        .map(nested => {
          const saved = savedChildren.find(sc => sc.guid === nested.guid);
          return restoreTree(saved || nested, new Set(visited));
        })
        .filter(Boolean) as SelectedPrefabItem[];

      return {
        guid: node.guid,
        active: node.active !== false,
        tag_groups,
        loras,
        children,
        source: (sources[`prefab:${node.guid}`] as any) || 'normal',
      };
    }

    const restored: SelectedPrefabItem[] = [];
    for (const sp of lastSelectedPrefabs) {
      const item = restoreTree(sp, new Set());
      if (item) restored.push(item);
    }
    setSelectedPrefabs(restored);
    prefabRestoredRef.current = true;
  }, [allLibraries, lastSelectedPrefabs, findPrefabByGuid, sources]);

  // Restore selected applications from last_selected_applications
  useEffect(() => {
    if (programRestoredRef.current) return;
    if (!allPrograms || Object.keys(allPrograms).length === 0) {
      // Data not loaded yet — wait
      return;
    }
    const allAppEntries = Object.values(allPrograms).flatMap(cd => cd.programs || []);
    if (!lastSelectedPrograms || lastSelectedPrograms.length === 0) {
      programRestoredRef.current = true;
      return;
    }
    const appIds = new Set(allAppEntries.map(a => a.id));
    const restored: SelectedProgramItem[] = lastSelectedPrograms
      .filter(sa => appIds.has(sa.id))
      .map(sa => ({
        id: sa.id,
        active: sa.active !== false,
        context_prefab_guids: sa.context_prefab_guids,
        context_lora_paths: sa.context_lora_paths,
        context_prompt_texts: sa.context_prompt_texts,
        context_prefab_inactive: sa.context_prefab_inactive,
        context_lora_inactive: sa.context_lora_inactive,
        context_prompt_inactive: sa.context_prompt_inactive,
      }));
    setSelectedPrograms(restored);
    programRestoredRef.current = true;
  }, [allPrograms, lastSelectedPrograms]);

  // Listen for context switch from parent (iframe embedding) + notify ready
  const isReloadingRef = useRef(false);
  useEffect(() => {
    const reloadHandler = (e: MessageEvent) => {
      if (e.data?.type === 'kolid-reload-data') {
        isReloadingRef.current = true;
        loraRestoredRef.current = false;
        prefabRestoredRef.current = false;
        programRestoredRef.current = false;
        setSelectedLoras([]);
        setLoraSelections({});
        setSelectedPrefabs([]);
        setSelectedPrograms([]);
        setSelectedTags([]);
        setCustomPrompts('');
        setCustomAddedTagKeys(new Set());
        Promise.all([loadData(), loadLoraData()]).then(() => {
          isReloadingRef.current = false;
        });
      }
    };
    window.addEventListener('message', reloadHandler);
    try { window.parent?.postMessage({ type: 'kolid-prompt-ready' }, '*'); } catch {}
    return () => window.removeEventListener('message', reloadHandler);
  }, [loadData, loadLoraData]);

  // Live context push: whenever selections change, notify parent immediately
  // Skip while reloading to avoid overwriting saved context with cleared state
  useEffect(() => {
    if (window.parent === window) return;
    if (isReloadingRef.current) return;
    if (isRegionReloadingRef.current) return;
    const promptsToSend = selectedTags.map(g => tagsToDisplayString(g));
    const lorasPayload: LoraSelectionData[] = selectedLoras.map(l => {
      const sel = loraSelections[l.file_path];
      return {
        file_path: l.file_path,
        name: l.name,
        strength: sel?.strength ?? 1.0,
        active_tags: sel?.activeTags ?? [],
        active: sel?.active ?? true,
        split_mode: sel?.split_mode,
      };
    });
    const prefabsPayload = selectedPrefabs.map(p => ({ guid: p.guid, active: p.active, tag_groups: p.tag_groups, loras: p.loras, children: p.children }));
    window.parent.postMessage({
      type: 'kolid-prompt-live',
      prompts: promptsToSend,
      custom_prompts: customPrompts,
      loras: lorasPayload,
      prefabs: prefabsPayload,
    }, '*');
  }, [selectedTags, customPrompts, selectedLoras, loraSelections, selectedPrefabs]);

  // When enable_region, store current prompt selection to the active region's promptContext
  useEffect(() => {
    if (!enableRegion) return;
    if (isRegionReloadingRef.current) return;
    const idx = regionActiveRef.current;
    // If a format slot is active, store to formatSlotContextsRef instead
    if (activeSlotIdRef.current) {
      const promptsToSend = selectedTags.map(g => tagsToDisplayString(g));
      const lorasPayload: LoraSelectionData[] = selectedLoras.map(l => {
        const sel = loraSelections[l.file_path];
        return { file_path: l.file_path, name: l.name, strength: sel?.strength ?? 1.0, active_tags: sel?.activeTags ?? [], active: sel?.active ?? true, split_mode: sel?.split_mode };
      });
      const prefabsPayload = selectedPrefabs.map(p => ({ guid: p.guid, active: p.active, tag_groups: p.tag_groups, loras: p.loras, children: p.children }));
      const ctx: PromptContextBase = {
        prompts: promptsToSend, custom_prompts: customPrompts, loras: lorasPayload, prefabs: prefabsPayload,
        label: activeSlotIdRef.current,
      };
      formatSlotContextsRef.current.set(activeSlotIdRef.current, ctx);
      return;
    }
    const promptsToSend = selectedTags.map(g => tagsToDisplayString(g));
    const lorasPayload: LoraSelectionData[] = selectedLoras.map(l => {
      const sel = loraSelections[l.file_path];
      return { file_path: l.file_path, name: l.name, strength: sel?.strength ?? 1.0, active_tags: sel?.activeTags ?? [], active: sel?.active ?? true, split_mode: sel?.split_mode };
    });
    const prefabsPayload = selectedPrefabs.map(p => ({ guid: p.guid, active: p.active, tag_groups: p.tag_groups, loras: p.loras, children: p.children }));
    const ctx: PromptContextBase = {
      prompts: promptsToSend, custom_prompts: customPrompts, loras: lorasPayload, prefabs: prefabsPayload,
      label: idx >= 0 ? `Region ${String(idx + 1).padStart(2, '0')}` : 'Background',
    };
    // Build desc to match the server's `prompt` output: raw prompt strings (with brackets)
    // joined by ", " — each tag group stays as one entry, NOT split into individual tags.
    const descParts: string[] = [];
    // 1. Direct prompts — strip [ and ] like server's cleaned_prompts
    for (const p of promptsToSend) {
      const cleaned = p.replace(/\[/g, '').replace(/\]/g, '');
      if (cleaned) descParts.push(cleaned);
    }
    // 2. Prefab prompts — expand tree using saved data + prefab lookup
    function expandPrefabPrompts(items: any[]): string[] {
      const result: string[] = [];
      for (const item of items) {
        if (item.active === false) continue;
        const prefab = findPrefabByGuid(item.guid);
        if (prefab && prefab.tag_groups) {
          const savedTags = item.tag_groups || [];
          for (const group of prefab.tag_groups) {
            if (!Array.isArray(group)) continue;
            const names = group.map((t: any) => t.name || t.prompt || '');
            let key = names.join(' ');
            const strength = group.strength ?? 1.0;
            if (strength !== 1.0) key = `${key}:${strength}`;
            const saved = savedTags.find((st: any) => st.key === key);
            if (saved && saved.active === false) continue;
            const parts: string[] = [];
            for (let i = 0; i < group.tags.length; i++) {
              const tag = group.tags[i];
              const promptText = tag.prompt || '';
              if (!promptText) continue;
              const deco = group.tags.length - 1 - i;
              const str = group.strength;
              let text: string;
              if (deco > 0) text = '['.repeat(deco) + promptText + ']'.repeat(deco);
              else text = promptText;
              if (str !== 1.0) text = `(${text}:${str})`;
              parts.push(text);
            }
            if (parts.length) {
              const promptStr = parts.join(' ');
              // Strip [ and ] exactly like server: prompt_str.replace('[', '').replace(']', '')
              const cleanedStr = promptStr.replace(/\[/g, '').replace(/\]/g, '');
              result.push(cleanedStr);
            }
          }
        }
        if (prefab && prefab.custom_prompts) {
          result.push(prefab.custom_prompts);
        }
        if (item.children) result.push(...expandPrefabPrompts(item.children));
      }
      return result;
    }
    descParts.push(...expandPrefabPrompts(prefabsPayload));
    // 3. Custom prompts
    if (customPrompts.trim()) descParts.push(customPrompts.trim());
    // 4. Lora trigger words (active_tags from all active loras, including prefab loras)
    for (const l of lorasPayload) {
      if (l.active === false) continue;
      descParts.push(...(l.active_tags || []));
    }
    function expandPrefabLoraTags(items: any[]): string[] {
      const result: string[] = [];
      for (const item of items) {
        if (item.active === false) continue;
        const prefab = findPrefabByGuid(item.guid);
        if (prefab && prefab.loras) {
          for (const pl of prefab.loras) {
            if (pl.active === false) continue;
            result.push(...(pl.active_tags || []));
          }
        }
        if (item.children) result.push(...expandPrefabLoraTags(item.children));
      }
      return result;
    }
    descParts.push(...expandPrefabLoraTags(prefabsPayload));
    const desc = descParts.filter(Boolean).join(', ');

    if (idx >= 0 && idx < regionBoxesRef.current.length) {
      // Save to active region
      const nbs = [...regionBoxesRef.current];
      if (nbs[idx].promptContext && JSON.stringify(nbs[idx].promptContext) === JSON.stringify(ctx) && nbs[idx].desc === desc) return;
      nbs[idx] = { ...nbs[idx], promptContext: ctx, desc };
      regionBoxesRef.current = nbs;
      setRegionBoxes(nbs);
    } else {
      // Save to background context (singleton)
      const bgCtx: BackgroundContext = { ...ctx, isBackground: true };
      if (backgroundContextRef.current && JSON.stringify(backgroundContextRef.current) === JSON.stringify(bgCtx)) return;
      backgroundContextRef.current = bgCtx;
    }
  }, [selectedTags, customPrompts, selectedLoras, loraSelections, selectedPrefabs, enableRegion, findPrefabByGuid, activeSlotId]);

  // ========== Modal state ==========
  const [modal, setModal] = useState<{type:string;data?:any}|null>(null);
  const [modalStack, setModalStack] = useState<string[]>([]);
  const closeModal = useCallback(() => {
    if (modal?.type === 'editSelectedPrefab' && modalStack.length > 0) {
      const parentGuid = modalStack[modalStack.length - 1];
      setModalStack(prev => prev.slice(0, -1));
      setModal({ type: 'editSelectedPrefab', data: { guid: parentGuid } });
    } else {
      setModal(null);
      setModalStack([]);
      setErrorModal(null);
    }
  }, [modal, modalStack]);
  // Form state for modals
  const [modalName, setModalName] = useState('');
  const [modalPrompt, setModalPrompt] = useState('');
  const [modalTags, setModalTags] = useState<string[]>([]);
  const [modalDecorations, setModalDecorations] = useState<string[]>([]);
  const [modalMuteDecorations, setModalMuteDecorations] = useState<string[]>([]);
  const [modalCategory, setModalCategory] = useState('');
  const [modalOldName, setModalOldName] = useState('');
  const [modalPromptIds, setModalPromptIds] = useState('');
  const [modalCustomPrompts, setModalCustomPrompts] = useState('');
  const [modalPrefabTags, setModalPrefabTags] = useState<TagGroup[]>([]);
  const [modalPrefabLoras, setModalPrefabLoras] = useState<LoraSelectionData[]>([]);
  const [modalPrefabSelectedPrefabs, setModalPrefabSelectedPrefabs] = useState<SelectedPrefabRef[]>([]);
  const [modalProgramSelectedPrograms, setModalProgramSelectedPrograms] = useState<SelectedProgramRef[]>([]);
  const [modalEnablePrefabCtx, setModalEnablePrefabCtx] = useState(false);
  const [modalEnableLoraCtx, setModalEnableLoraCtx] = useState(false);
  const [modalEnablePromptCtx, setModalEnablePromptCtx] = useState(false);
  const [modalCtxPrefabGuids, setModalCtxPrefabGuids] = useState<string[]>([]);
  const [modalCtxLoraPaths, setModalCtxLoraPaths] = useState<string[]>([]);
  const [modalCtxPromptTexts, setModalCtxPromptTexts] = useState<string[]>([]);
  const [modalCtxTab, setModalCtxTab] = useState<'prefab' | 'lora' | 'prompt'>('prefab');
  const [modalMultiProgram, setModalMultiProgram] = useState(false);
  const [debugOutput, setDebugOutput] = useState<string | null>(null);
  const [debugErrorLine, setDebugErrorLine] = useState<number | null>(null);

  const [modalMode, setModalMode] = useState('horizontal');
  const [modalSize, setModalSize] = useState('normal');
  const [modalIsCat, setModalIsCat] = useState(true);
  const [modalPreviewUrl, setModalPreviewUrl] = useState('');
  const [modalPreviewVisible, setModalPreviewVisible] = useState(false);
  const [modalFocusX, setModalFocusX] = useState(0);
  const [modalFocusY, setModalFocusY] = useState(0);
  const [modalFocusVisible, setModalFocusVisible] = useState(false);
  const [modalImageFile, setModalImageFile] = useState<File|null>(null);
  const [modalVideoFile, setModalVideoFile] = useState<File|null>(null);
  const [modalVideoUrl, setModalVideoUrl] = useState('');
  const [modalVideoFilename, setModalVideoFilename] = useState('');
  const [modalFileName, setModalFileName] = useState('');
  const [modalVideoVolume, setModalVideoVolume] = useState(0);
  const [modalClarityPoints, setModalClarityPoints] = useState<Array<{x:number;y:number}>>([]);
  const videoUploadRef = useRef<Promise<string | null>>(Promise.resolve(null));
  const [errorModal, setErrorModal] = useState<{ title: string; message: string }|null>(null);

  // Tag autocomplete for editPrefab modal
  const [tagInputQuery, setTagInputQuery] = useState('');
  const [tagInputShowDropdown, setTagInputShowDropdown] = useState(false);
  const [tagInputSelIdx, setTagInputSelIdx] = useState(-1);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const tagDropdownRef = useRef<HTMLDivElement>(null);
  const selItemRef = useRef<HTMLDivElement>(null);

  const tagAutocompleteSuggestions = useMemo(() => {
    const map = new Map<string, string>();
    for (const cd of Object.values(allPrompts)) {
      const prompts = ((cd as any).prompts || []) as { name: string; prompt: string }[];
      for (const p of prompts) {
        if (p.prompt && !map.has(p.prompt)) map.set(p.prompt, p.name || p.prompt);
      }
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
  }, [allPrompts]);

  const filteredTagSuggestions = useMemo(() => {
    if (!tagInputQuery) return tagAutocompleteSuggestions.slice(0, 50);
    const q = tagInputQuery.toLowerCase();
    return tagAutocompleteSuggestions.filter(([text, name]) =>
      text.toLowerCase().includes(q) || name.toLowerCase().includes(q)
    ).slice(0, 50);
  }, [tagAutocompleteSuggestions, tagInputQuery]);

  const selectTagSuggestion = useCallback((text: string) => {
    const input = tagInputRef.current;
    if (!input) return;
    const pos = input.selectionStart ?? input.value.length;
    const val = input.value;
    let s = pos - 1;
    while (s >= 0 && val[s] !== ',' && val[s] !== ' ') s--;
    const newVal = val.slice(0, s + 1) + text + (pos >= val.length || val[pos] === ' ' ? '' : ' ') + val.slice(pos);
    input.value = newVal;
    const nc = s + 1 + text.length;
    setTimeout(() => { input.selectionStart = input.selectionEnd = nc; input.focus(); }, 0);
    setTagInputShowDropdown(false);
    setTagInputQuery('');
    setTagInputSelIdx(-1);
  }, []);

  const handleTagInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const pos = input.selectionStart ?? input.value.length;
    const val = input.value;
    if (pos === 0) { setTagInputShowDropdown(false); return; }
    let s = pos - 1;
    while (s >= 0 && val[s] !== ',' && val[s] !== ' ') s--;
    const word = val.slice(s + 1, pos);
    if (word.length >= 1) {
      setTagInputQuery(word);
      setTagInputShowDropdown(true);
      setTagInputSelIdx(-1);
    } else {
      setTagInputShowDropdown(false);
    }
  }, []);

  const handleTagInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (tagInputShowDropdown && filteredTagSuggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setTagInputSelIdx(i => Math.min(i + 1, filteredTagSuggestions.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setTagInputSelIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        const idx = tagInputSelIdx >= 0 ? tagInputSelIdx : 0;
        if (idx < filteredTagSuggestions.length) selectTagSuggestion(filteredTagSuggestions[idx][0]);
        return;
      }
      if (e.key === 'Enter' && tagInputSelIdx >= 0) {
        e.preventDefault();
        if (tagInputSelIdx < filteredTagSuggestions.length) selectTagSuggestion(filteredTagSuggestions[tagInputSelIdx][0]);
        return;
      }
      if (e.key === 'Escape') { setTagInputShowDropdown(false); return; }
    }
    if (e.key === 'Enter') {
      const input = tagInputRef.current;
      if (!input) return;
      const val = input.value.trim();
      if (val) {
        const segments = val.split(',').map(s => s.trim()).filter(Boolean);
        for (const seg of segments) {
          const result = tryParseLine(seg, allPrompts);
          if (result) {
            setModalPrefabTags(prev => [...prev, result.tagGroup]);
          } else {
            // No match: create a plain tag
            setModalPrefabTags(prev => [...prev, { tags: [{ name: seg, prompt: seg, category: "" }], strength: 1.0, source: 'normal' }]);
          }
        }
        input.value = '';
        setTagInputShowDropdown(false);
        setTagInputQuery('');
        setTagInputSelIdx(-1);
      }
    }
  }, [tagInputShowDropdown, filteredTagSuggestions, tagInputSelIdx, selectTagSuggestion, setModalPrefabTags, allPrompts]);

  // Scroll selected autocomplete item into view
  useEffect(() => {
    if (tagInputShowDropdown && tagInputSelIdx >= 0 && selItemRef.current) {
      selItemRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [tagInputSelIdx, tagInputShowDropdown]);

  // ========== Image helpers ==========
  const handleImageSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) { setModalPreviewUrl(''); setModalPreviewVisible(false); setModalImageFile(null); setModalVideoFile(null); setModalVideoUrl(''); setModalVideoFilename(''); setModalFileName(''); return; }
    setModalFileName(file.name);
    if (file.type.startsWith('video/')) {
      // Video file: upload immediately and get filename
      setModalVideoFile(file);
      setModalImageFile(null);
      setModalPreviewUrl('');
      setModalPreviewVisible(false);
      setModalVideoUrl(URL.createObjectURL(file));
      setModalFocusX(0); setModalFocusY(0); setModalFocusVisible(false);
      setModalVideoFilename('');
      // Upload video
      videoUploadRef.current = (async () => {
        try {
          const buf = await file.arrayBuffer();
          const res = await fetch('/upload_video', { method: 'POST', body: buf });
          const data = await res.json();
          if (data.success) { setModalVideoFilename(data.filename); return data.filename; }
        } catch(e) { console.error('Video upload failed:', e); }
        return null;
      })();
    } else {
      // Image file
      setModalImageFile(file);
      setModalVideoFile(null);
      setModalVideoUrl('');
      setModalVideoFilename('');
      const reader = new FileReader();
      reader.onload = ev => { setModalPreviewUrl(ev.target?.result as string); setModalPreviewVisible(true); };
      reader.readAsDataURL(file);
      setModalFocusX(0); setModalFocusY(0); setModalFocusVisible(false);
    }
  }, []);

  const handlePasteImage = useCallback((file: File) => {
    setModalImageFile(file);
    const reader = new FileReader();
    reader.onload = ev => { setModalPreviewUrl(ev.target?.result as string); setModalPreviewVisible(true); };
    reader.readAsDataURL(file);
    setModalFocusX(0); setModalFocusY(0); setModalFocusVisible(false);
  }, []);

  const getUploadedVideoFilename = useCallback(async () => {
    const fn = await videoUploadRef.current;
    return fn;
  }, []);

  const handlePreviewClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
    setModalFocusX(x); setModalFocusY(y); setModalFocusVisible(true);
  }, []);

  const handleRemoveFocus = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setModalFocusX(0); setModalFocusY(0); setModalFocusVisible(false);
  }, []);

  const handlePreviewCtrlClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
    setModalClarityPoints(prev => [...prev, { x, y }]);
  }, []);

  const handlePreviewCtrlRightClick = useCallback((e: React.MouseEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
    setModalClarityPoints(prev => {
      if (prev.length === 0) return prev;
      let bestIdx = -1, bestDist = Infinity;
      prev.forEach((p, i) => { const d = (p.x - x) ** 2 + (p.y - y) ** 2; if (d < bestDist) { bestDist = d; bestIdx = i; } });
      return prev.filter((_, i) => i !== bestIdx);
    });
  }, []);

  const clearImageFields = useCallback(() => {
    setModalPreviewUrl(''); setModalPreviewVisible(false);
    setModalFocusX(0); setModalFocusY(0); setModalFocusVisible(false);
    setModalImageFile(null);
    setModalVideoFile(null); setModalVideoUrl(''); setModalVideoFilename('');
    setModalFileName('');
    setModalVideoVolume(0);
    setModalClarityPoints([]);
    videoUploadRef.current = Promise.resolve(null);
  }, []);

  // ========== Clear zoom before opening modals ==========
  const clearZoomView = useCallback(() => {
    if (zoomTimer) { clearTimeout(zoomTimer); zoomTimer = null; }
    if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
    if (currentZoomItem) {
      currentZoomItem.classList.remove('zoom-view');
      currentZoomItem.classList.add('zoom-exit');
      const old = currentZoomItem;
      currentZoomItem = null;
      setTimeout(() => { old.classList.remove('zoom-exit'); }, 300);
    }
  }, []);

  // ========== Reset all modal form state ==========
  const resetModalForm = useCallback(() => {
    clearZoomView();
    setModalName(''); setModalPrompt(''); setModalTags([]); setModalDecorations([]); setModalMuteDecorations([]);
    setModalCategory(''); setModalOldName(''); setModalPromptIds('');
    setModalCustomPrompts(''); setModalPrefabTags([]); setModalPrefabLoras([]); setModalPrefabSelectedPrefabs([]); setModalProgramSelectedPrograms([]); setModalEnablePrefabCtx(false); setModalEnableLoraCtx(false); setModalEnablePromptCtx(false); setModalMultiProgram(false); setModalCtxPrefabGuids([]); setModalCtxLoraPaths([]); setModalCtxPromptTexts([]); setModalCtxTab('prefab'); setModalMode('horizontal'); setModalSize('normal');
    setModalIsCat(true); clearImageFields();
    setDebugOutput(null); setDebugErrorLine(null);
    tempCtx.clear();
  }, [clearImageFields]);

  // Debug: execute program code with current state, capture output + error line
  const handleDebug = useCallback(() => {
    setDebugErrorLine(null);
    const debugConsole: string[] = [];
    const fakeConsole = {
      log: (...args: any[]) => { debugConsole.push(args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')); },
      error: (...args: any[]) => { debugConsole.push('[ERROR] ' + args.map(a => String(a)).join(' ')); },
      warn: (...args: any[]) => { debugConsole.push('[WARN] ' + args.map(a => String(a)).join(' ')); },
    };

    // Determine line-number offset caused by the Function() wrapper so we can
    // map stack-trace line numbers back to the user's code.
    const fnParams = ['console', 'tag_groups', 'loras', 'prefabs', 'custom_prompts', 'prompts_data', 'all_tags', 'prefab_context', 'lora_context', 'prompt_context'];
    let lineOffset = 0;
    try {
      const probe = new Function(...fnParams, 'throw new Error("__probe__")');
      probe(fakeConsole, [], [], [], [], [], {}, [], [], []);
    } catch (pe: any) {
      const pm = (pe?.stack || '').match(/<anonymous>:(\d+):/);
      if (pm) lineOffset = parseInt(pm[1], 10) - 1;
    }

    try {
      const fn = new Function(...fnParams, modalCustomPrompts);
      // Build context (matching useProgram.ts enrichment logic via shared helpers)
      const allTagsLookup = buildAllTagsLookup(allPrompts);
      const fakeTags = enrichTagGroups(selectedTags, allTagsLookup);
      const fakeLoras = buildLoraSelectionData(selectedLoras, loraSelections);

      // Randomly select 2-5 prefabs/loras/prompts as context (respecting modal toggles)
      const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
      const shuffle = <T,>(arr: T[]): T[] => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

      // Build prefab lookup (matching useProgram.ts)
      const prefabDataMap = new Map<string, any>();
      for (const libData of Object.values(allLibraries)) {
        for (const pf of (libData.prefabs || [])) {
          if (pf.guid) prefabDataMap.set(pf.guid, pf);
        }
      }
      // Build lora lookup
      const loraLookup = new Map<string, LoraItemData>();
      for (const items of Object.values(loraData)) { for (const item of items) loraLookup.set(item.file_path, item); }
      // Collect all prompt texts
      const allPromptTexts: { text: string; name: string }[] = [];
      for (const catData of Object.values(allPrompts)) {
        for (const p of ((catData as any).prompts || [])) {
          if (p.prompt) allPromptTexts.push({ text: p.prompt, name: p.name || p.prompt });
        }
      }

      const prefabContext = modalEnablePrefabCtx ? shuffle([...prefabDataMap.entries()]).slice(0, randInt(2, 5)).map(([guid, pfData]) => ({
        guid, name: pfData.name || '', tag_groups: pfData.tag_groups || [], loras: pfData.loras || [], custom_prompts: pfData.custom_prompts || '', preview: pfData.preview || '', active: true,
      })) : [];
      const loraContext = modalEnableLoraCtx ? shuffle([...loraLookup.entries()]).slice(0, randInt(2, 5)).map(([fp, item]) => {
        const sel = loraSelections[fp];
        return { file_path: fp, name: item.name, strength: sel?.strength ?? 1.0, active_tags: sel?.activeTags ?? item.tags ?? [], active: true, split_mode: sel?.split_mode };
      }) : [];
      const promptContext = modalEnablePromptCtx ? shuffle(allPromptTexts).slice(0, randInt(2, 5)).map(({ text }) => {
        const tg = parseStringToTags(text, allPrompts);
        return { ...tg, active: true };
      }) : [];

      const result = fn(fakeConsole, fakeTags, fakeLoras, selectedPrefabs, customPrompts, allPrompts, allTagsLookup, prefabContext, loraContext, promptContext);

      let output = '=== CONTEXT (random sample) ===\n';
      output += 'prefab_context: ' + (prefabContext.length > 0 ? prefabContext.map(p => p.name).join(', ') : '(empty)') + '\n';
      output += 'lora_context: ' + (loraContext.length > 0 ? loraContext.map(l => l.name).join(', ') : '(empty)') + '\n';
      output += 'prompt_context: ' + (promptContext.length > 0 ? promptContext.map(tg => tg.tags.map((t: any) => t.name).join('|')).join(', ') : '(empty)') + '\n\n';
      output += '=== CONSOLE ===\n' + (debugConsole.length > 0 ? debugConsole.join('\n') : '(no output)') + '\n\n';
      output += '=== RETURN VALUE ===\n' + JSON.stringify(result, null, 2);
      if (result && typeof result === 'object') {
        output += '\n\n=== FILTER ===\n';
        output += 'filter_tag_groups: ' + JSON.stringify(result.filter_tag_groups || [], null, 2) + '\n';
        output += 'filter_loras: ' + JSON.stringify(result.filter_loras || [], null, 2) + '\n';
        output += 'filter_prefabs: ' + JSON.stringify(result.filter_prefabs || [], null, 2);
        output += '\n\n=== GEN ===\n';
        output += 'gen_tag_groups: ' + JSON.stringify(result.gen_tag_groups || [], null, 2) + '\n';
        output += 'gen_loras: ' + JSON.stringify(result.gen_loras || [], null, 2) + '\n';
        output += 'gen_prefabs: ' + JSON.stringify(result.gen_prefabs || [], null, 2);
      }
      setDebugOutput(output);
    } catch (e: any) {
      const stack = e?.stack || '';
      const m = stack.match(/<anonymous>:(\d+):/);
      if (m && lineOffset > 0) {
        const lineNum = parseInt(m[1], 10) - lineOffset;
        const codeLines = modalCustomPrompts.split('\n').length;
        if (lineNum >= 1 && lineNum <= codeLines) {
          setDebugErrorLine(lineNum);
        }
      }
      setDebugOutput('ERROR: ' + (e.message || String(e)) + '\n' + (e.stack || ''));
    }
  }, [modalCustomPrompts, selectedTags, selectedLoras, loraSelections, selectedPrefabs, customPrompts, allPrompts, allLibraries, loraData, modalEnablePrefabCtx, modalEnableLoraCtx, modalEnablePromptCtx]);

  const saveModalFocus = useCallback((key: string, isCategory: boolean) => {
    if (modalFocusVisible) {
      const pt = { x: modalFocusX, y: modalFocusY };
      if (isCategory) {
        setCategoryFocusPoints(prev => { const n = {...prev, [key]: pt}; localStorage.setItem('kolid_category_focus_points', JSON.stringify(n)); return n; });
      } else {
        setFocusPoints(prev => { const n = {...prev, [key]: pt}; localStorage.setItem('kolid_focus_points', JSON.stringify(n)); return n; });
      }
    }
  }, [modalFocusVisible, modalFocusX, modalFocusY]);

  const saveModalVideoVolume = useCallback((key: string) => {
    setVideoVolumes(prev => { const n = {...prev, [key]: modalVideoVolume}; localStorage.setItem('kolid_video_volumes', JSON.stringify(n)); return n; });
  }, [modalVideoVolume]);

  const removeModalVideoVolume = useCallback((key: string) => {
    setVideoVolumes(prev => { if(!(key in prev)) return prev; const n = {...prev}; delete n[key]; localStorage.setItem('kolid_video_volumes', JSON.stringify(n)); return n; });
  }, []);

  const saveModalClarityPoints = useCallback((key: string) => {
    setClarityPoints(prev => { const n = {...prev, [key]: modalClarityPoints}; localStorage.setItem('kolid_clarity_points', JSON.stringify(n)); return n; });
  }, [modalClarityPoints]);

  const removeModalClarityPoints = useCallback((key: string) => {
    setClarityPoints(prev => { if(!(key in prev)) return prev; const n = {...prev}; delete n[key]; localStorage.setItem('kolid_clarity_points', JSON.stringify(n)); return n; });
  }, []);

  const removeModalFocus = useCallback((key: string, isCategory: boolean) => {
    if (isCategory) {
      setCategoryFocusPoints(prev => { if(!prev[key]) return prev; const n = {...prev}; delete n[key]; localStorage.setItem('kolid_category_focus_points', JSON.stringify(n)); return n; });
    } else {
      setFocusPoints(prev => { if(!prev[key]) return prev; const n = {...prev}; delete n[key]; localStorage.setItem('kolid_focus_points', JSON.stringify(n)); return n; });
    }
    setModalFocusX(0); setModalFocusY(0); setModalFocusVisible(false);
  }, []);

  // ========== Toggle Category/Library ==========
  const toggleCategory = useCallback((cat: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else { next.add(cat); setAnimating(old => new Set([...old, cat])); }
      return next;
    });
  }, []);

  const toggleLibrary = useCallback((lib: string) => {
    setExpandedLibraries(prev => {
      const next = new Set(prev);
      if (next.has(lib)) next.delete(lib);
      else { next.add(lib); setAnimating(old => new Set([...old, lib])); }
      return next;
    });
  }, []);

  // ========== Search & Filter ==========
  const handleSearch = useCallback((q: string) => {
    setSearchQuery(q.toLowerCase());
  }, []);
  const handleFilterChange = useCallback((f: string) => setSelectedFilter(f), []);

  const handleCustomPromptsParsed = useCallback((tagGroup: TagGroup, displayString: string) => {
    setSelectedTags(prev => [...prev, { ...tagGroup, tags: tagGroup.tags.map(t => ({ ...t })), source: 'normal' }]);
    setCustomAddedTagKeys(prev => new Set(prev).add(displayString));
  }, [setSelectedTags]);

  // ========== Select Prompt (full toggle logic) ==========
  const selectPrompt = useCallback((prompt: string) => {
    clearZoomState();
    snapshotZoom();
    const ctxStack = tempCtx.stack;
    if (ctxStack.length > 0) {
      const ctx = ctxStack[ctxStack.length - 1] as { matchFn?: (p: PromptData, cat: string) => boolean; basePrompt?: string; tagGroups?: TagGroup[]; level?: number };
      const promptData = findPromptData(prompt, allPrompts);
      if (!promptData) return;
      const allDecorations = getPromptDecorations(promptData, allPrompts);
      const tag = { name: promptData.name, prompt, category: promptData.category || "" };

      if (allDecorations.length > 0) {
        // Push a sub-layer for this prompt's decorations (tag will be combined on completion)
        tempCtx.setStack(prev => {
          const stack = [...prev];
          const last = stack[stack.length - 1];
          stack.push({
            type: 'tag' as const,
            matchFn: (p: PromptData, cat: string) => {
              if (p.prompt === prompt) return false;
              const pTags = (Array.isArray(p.tags) ? p.tags : []) as string[];
              const cd = allPrompts[cat] || {};
              const ct = (cd.tags as string[]) || [];
              return pTags.some((t: string) => allDecorations.includes(t)) || ct.some((t: string) => allDecorations.includes(t));
            },
            basePrompt: prompt, title: `选择 "${promptData.name}" 的修饰词`,
            tagGroups: [], level: (last.level || 1) + 1,
          });
          return stack;
        });
        return;
      }

      // No decorations: just toggle the decoration tag
      tempCtx.setStack(prev => {
        const stack = [...prev];
        const lastIdx = stack.length - 1;
        const last = stack[lastIdx];
        const existing = (last.tagGroups || []).findIndex((g: TagGroup) => g.tags.slice(0, -1).some(t => t.prompt === prompt));
        const newLast = { ...last, tagGroups: existing === -1
          ? [...(last.tagGroups || []), { tags: [{ name: promptData.name, prompt, category: promptData.category || "" }], strength: 1.0, source: 'normal' as const }]
          : (last.tagGroups || []).filter((_g: TagGroup, i: number) => i !== existing)
        };
        stack[lastIdx] = newLast;
        return stack;
      });
      return;
    }

    const promptData = findPromptData(prompt, allPrompts);
    if (!promptData) return;
    const allDecorations = getPromptDecorations(promptData, allPrompts);
    if (allDecorations.length > 0) {
      tempCtx.setStack(prev => [...prev, {
        type: 'tag' as const,
        matchFn: (p: PromptData, cat: string) => {
          if (p.prompt === prompt) return false;
          const pTags = (Array.isArray(p.tags) ? p.tags : []) as string[];
          const cd = allPrompts[cat] || {};
          const ct = (cd.tags as string[]) || [];
          return pTags.some((t: string) => allDecorations.includes(t)) || ct.some((t: string) => allDecorations.includes(t));
        },
        basePrompt: prompt, title: `选择 "${promptData.name}" 的修饰词`,
        tagGroups: [], level: 1,
      }]);
      return;
    }

    setSelectedTags(prev => {
      const idx = prev.findIndex(g => g.tags[g.tags.length - 1]?.prompt === prompt);
      if (idx === -1) return [...prev, { tags: [{ name: promptData.name, prompt, category: promptData.category || "" }], strength: 1.0, source: 'normal' }];
      return prev.filter((_, i) => i !== idx);
    });
  }, [tempCtx, allPrompts, setSelectedTags]);

  // ========== Complete/Cancel temporary context ==========
  const completeLayer = useCallback(() => {
    tempCtx.setStack(prev => {
      if (prev.length === 0) return prev;
      const stack = [...prev];
      const ctx = stack.pop()!;
      if (ctx.type !== 'tag') return prev;
      const tagGroups = [...(ctx.tagGroups || [])];
      const bp = findPromptData(ctx.basePrompt || '', allPrompts);
      const bpName = bp ? bp.name : '';
      const bdn = Math.max(0, (ctx.level || 1) - 1);
      const combined = combineTagGroups(tagGroups, ctx.basePrompt || '', bpName, bdn, allPrompts);
      if (stack.length > 0) {
        const prevCtx = { ...stack[stack.length - 1] };
        prevCtx.tagGroups = [...(prevCtx.tagGroups || []), combined];
        stack[stack.length - 1] = prevCtx;
        return stack;
      }
      setSelectedTags(prevTags => [...prevTags, combined]);
      return stack;
    });
  }, [allPrompts, setSelectedTags, tempCtx]);

  const backLayer = useCallback(() => {
    tempCtx.pop();
  }, [tempCtx]);

  const cancelTemporary = useCallback(() => {
    tempCtx.clear();
  }, [tempCtx]);

  const isTemporary = tempCtx.isActive;
  const currentCtx = tempCtx.current;

  // ========== Program execution (JS, live preview) ==========
  const programResult = useProgram(
    selectedPrograms, allPrograms,
    selectedTags, selectedLoras, loraSelections,
    selectedPrefabs, customPrompts, allPrompts, allLibraries, loraData,
  );

  // ========== Tag Selection Helper ==========
  const isTagSelected = useCallback((prompt: string) => {
    return isBasePromptSelectedInTags(prompt, selectedTags);
  }, [selectedTags]);

  const getTagGroupForPrompt = useCallback((prompt: string): TagGroup | undefined => {
    return findTagGroupByBasePrompt(prompt, selectedTags);
  }, [selectedTags]);

  const isPromptSelectedInTempCtx = useCallback((prompt: string): boolean => {
    return tempCtx.isIdSelected(prompt);
  }, [tempCtx]);

  const removeTag = useCallback((idx: number) => {
    setSelectedTags(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const reorderTags = useCallback((fromIndex: number, toIndex: number) => {
    setSelectedTags(prev => {
      const next = [...prev];
      const [item] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, item);
      return next;
    });
  }, []);

  const removeTemporaryTag = useCallback((tgIdx: number) => {
    tempCtx.removeTagGroup(tgIdx);
  }, [tempCtx]);

  const clearCategoryTags = useCallback((cat: string) => {
    if (isTemporary && currentCtx) {
      const cp = ((allPrompts[cat] as any)?.prompts || []) as PromptData[];
      const promptSet = new Set(cp.map(p => p.prompt));
      const tagGroups = currentCtx.tagGroups || [];
      const indicesToRemove: number[] = [];
      tagGroups.forEach((g, i) => {
        if (g.tags.slice(0, -1).some(t => promptSet.has(t.prompt))) {
          indicesToRemove.push(i);
        }
      });
      indicesToRemove.sort((a, b) => b - a).forEach(idx => tempCtx.removeTagGroup(idx));
    } else {
      const cp = ((allPrompts[cat] as any)?.prompts || []) as PromptData[];
      const promptSet = new Set(cp.map(p => p.prompt));
      setSelectedTags(prev => prev.filter(group =>
        !promptSet.has(group.tags[group.tags.length - 1]?.prompt)
      ));
    }
  }, [isTemporary, currentCtx, allPrompts, tempCtx, setSelectedTags]);

  const clearParsedCategoryTags = useCallback((cat: string) => {
    const cp = ((allPrompts[cat] as any)?.prompts || []) as PromptData[];
    const promptSet = new Set(cp.map(p => p.prompt));
    setSelectedTags(prev => prev.filter(group => {
      const isFromCategory = promptSet.has(group.tags[group.tags.length - 1]?.prompt);
      if (!isFromCategory) return true;
      return group.source !== 'parsing';
    }));
  }, [allPrompts, setSelectedTags]);

  // ========== Lora Selection ==========
  const isLoraSelected = useCallback((item: LoraItemData) => {
    if (tempCtx.mode === 'lora' || tempCtx.mode === 'loraCtx') {
      return tempCtx.isIdSelected(item.file_path);
    }
    return selectedLoras.some(l => l.file_path === item.file_path);
  }, [selectedLoras, tempCtx]);

  const toggleLora = useCallback((item: LoraItemData) => {
    if (tempCtx.mode === 'lora' || tempCtx.mode === 'loraCtx') {
      tempCtx.toggleId(item.file_path);
      return;
    }
    setSelectedLoras(prev => {
      const exists = prev.some(l => l.file_path === item.file_path);
      if (exists) {
        return prev.filter(l => l.file_path !== item.file_path);
      }
      return [...prev, item];
    });
  }, [tempCtx]);

  const removeLora = useCallback((filePath: string) => {
    setSelectedLoras(prev => prev.filter(l => l.file_path !== filePath));
  }, []);

  // ========== Prefab Selection ==========
  const togglePrefab = useCallback((guid: string) => {
    if (tempCtx.mode === 'prefab') {
      tempCtx.toggleId(guid);
      return;
    }
    setSelectedPrefabs(prev => {
      const exists = prev.some(p => p.guid === guid);
      if (exists) {
        return prev.filter(p => p.guid !== guid);
      }
      const item = buildPrefabItemTree(guid);
      return item ? [...prev, item] : prev;
    });
  }, [buildPrefabItemTree, tempCtx]);

  const removeSelectedPrefab = useCallback((guid: string) => {
    setSelectedPrefabs(prev => {
      function removeFromTree(items: SelectedPrefabItem[]): SelectedPrefabItem[] {
        return items
          .filter(item => item.guid !== guid)
          .map(item => ({ ...item, children: removeFromTree(item.children) }));
      }
      return removeFromTree(prev);
    });
  }, []);

  const togglePrefabActive = useCallback((guid: string) => {
    setSelectedPrefabs(prev => toggleTreeActive(prev, guid));
  }, [toggleTreeActive]);

  // Helper: toggle tag active on a tree node by guid (recursive search)
  const toggleTreeTag = useCallback((items: SelectedPrefabItem[], guid: string, key: string): SelectedPrefabItem[] =>
    items.map(item => {
      if (item.guid === guid) {
        return { ...item, tag_groups: item.tag_groups.map(t => t.key === key ? { ...t, active: !t.active } : t) };
      }
      return { ...item, children: toggleTreeTag(item.children, guid, key) };
    }),
  []);

  const togglePrefabLora = useCallback((guid: string, filePath: string) => {
    setSelectedPrefabs(prev => toggleTreeLora(prev, guid, filePath));
  }, [toggleTreeLora]);

  const togglePrefabTag = useCallback((guid: string, key: string) => {
    setSelectedPrefabs(prev => toggleTreeTag(prev, guid, key));
  }, [toggleTreeTag]);

  // ========== Application Selection ==========
  const toggleProgram = useCallback((id: string) => {
    // Check if this program has multi_program enabled
    let isMulti = false;
    for (const catData of Object.values(allPrograms)) {
      const app = (catData.programs || []).find(a => a.id === id);
      if (app?.multi_program) { isMulti = true; break; }
    }
    setSelectedPrograms(prev => {
      if (isMulti) {
        // Multi program: always add (never remove), dedup by checking if already selected
        // But allow multiple instances — so just add
        return [...prev, { id, active: true }];
      }
      const exists = prev.some(a => a.id === id);
      if (exists) return prev.filter(a => a.id !== id);
      return [...prev, { id, active: true }];
    });
  }, [allPrograms]);

  const toggleProgramActive = useCallback((id: string, index?: number) => {
    setSelectedPrograms(prev => {
      if (index !== undefined) {
        return prev.map((a, j) => j === index ? { ...a, active: !a.active } : a);
      }
      return prev.map(a => a.id === id ? { ...a, active: !a.active } : a);
    });
  }, []);

  const removeProgram = useCallback((id: string, index?: number) => {
    setSelectedPrograms(prev => {
      if (index !== undefined) {
        return prev.filter((_, j) => j !== index);
      }
      return prev.filter(a => a.id !== id);
    });
  }, []);

  const reorderPrograms = useCallback((fromIdx: number, toIdx: number) => {
    setSelectedPrograms(prev => {
      const next = [...prev];
      const [item] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, item);
      return next;
    });
  }, []);

  const deleteProgram = useCallback(async (id: string) => {
    try {
      await programGroup.delete(id);
      setAllPrograms(prev => {
        const next: AllPrograms = {};
        for (const [cat, catData] of Object.entries(prev)) {
          const apps = (catData.programs || []).filter(a => a.id !== id);
          next[cat] = { ...catData, programs: apps };
        }
        return next;
      });
      setSelectedPrograms(prev => prev.filter(a => a.id !== id));
      setFocusPoints(prev => { if(!prev[id]) return prev; const n = {...prev}; delete n[id]; localStorage.setItem('kolid_focus_points', JSON.stringify(n)); return n; });
    } catch(e) { console.error(e); }
  }, [setAllPrograms]);

  const saveProgram = useCallback(async (id: string | null, name: string, code: string, category: string, image: string | null = null, video: string | null = null, focusData: { x: number; y: number } | null = null, selectedPrograms: SelectedProgramRef[] = [], ctxFields: Record<string, unknown> = {}) => {
    if (id) {
      try {
        const result = await programGroup.update(id, name, code, image, video, selectedPrograms, ctxFields);
        setAllPrograms(prev => {
          const next: AllPrograms = {};
          for (const [cat, catData] of Object.entries(prev)) {
            next[cat] = {
              ...catData,
              programs: (catData.programs || []).map(a => {
                if (a.id !== id) return a;
                const updated: ProgramData = { ...a, ...ctxFields, name, code };
                if (result.preview !== undefined && result.preview !== null) updated.preview = result.preview;
                else if (image !== null) updated.preview = image;
                return updated;
              }),
            };
          }
          return next;
        });
        if (image) setImgVersion(v => v + 1);
        if (focusData && id) {
          setFocusPoints(prev => { const n = {...prev, [id]: focusData}; localStorage.setItem('kolid_focus_points', JSON.stringify(n)); return n; });
        }
      } catch(e) { console.error(e); }
    } else {
      try {
        const result = await programGroup.add(name, code, category, image, ctxFields);
        const newApp: ProgramData = { id: result.id || `${Date.now()}`, name, code, preview: result.preview || image || undefined, selected_programs: selectedPrograms, ...ctxFields } as ProgramData;
        setAllPrograms(prev => {
          const next = { ...prev };
          if (!next[category]) next[category] = { programs: [] };
          next[category] = { ...next[category], programs: [...(next[category].programs || []), newApp] };
          return next;
        });
        if (image) setImgVersion(v => v + 1);
        if (focusData && result.id) {
          setFocusPoints(prev => { const n = {...prev, [result.id]: focusData}; localStorage.setItem('kolid_focus_points', JSON.stringify(n)); return n; });
        }
      } catch(e) { console.error(e); }
    }
  }, [setAllPrograms]);

  const updateProgramCategory = useCallback(async () => {
    const oldName = modalOldName;
    const newName = modalName.trim();
    if (!newName) { alert('Please enter a name'); return; }
    let imageData: string|null = null;
    if (modalImageFile) { const r = new FileReader(); imageData = await new Promise(resolve => { r.onload = e => resolve(e.target?.result as string); r.readAsDataURL(modalImageFile); }); }
    let videoData: string|null = null;
    if (modalVideoFile) { const fn = await getUploadedVideoFilename(); videoData = fn || ''; } else if (!modalVideoUrl) { videoData = null; }
    try {
      const result = await programGroup.updateCategory(oldName, newName, { image: imageData, video: videoData });
      if (result.success || result.status === 'ok') {
        if (imageData || videoData) setImgVersion(v => v + 1);
        saveModalFocus(newName, true);
        saveModalVideoVolume(newName);
        saveModalClarityPoints(newName);
        setAllPrograms(prev => {
          const catData = prev[oldName];
          if (!catData) return prev;
          const updated: ProgramCategoryData = { ...catData, bg_image: result.bg_image !== undefined ? result.bg_image : catData.bg_image, bg_video: videoData !== null ? videoData : catData.bg_video };
          if (newName !== oldName) {
            const next: AllPrograms = {};
            for (const k of Object.keys(prev)) next[k === oldName ? newName : k] = k === oldName ? updated : prev[k];
            return next;
          }
          return { ...prev, [oldName]: updated };
        });
        closeModal();
      }
    } catch(e) { console.error(e); alert('Failed to update program category'); }
  }, [closeModal, modalOldName, modalName, modalImageFile, modalVideoFile, modalVideoFilename, modalVideoUrl, getUploadedVideoFilename, saveModalFocus, saveModalVideoVolume, saveModalClarityPoints, setAllPrograms]);

  const removeProgramCategoryBg = useCallback(async () => {
    const oldName = modalOldName;
    const newName = modalName.trim() || oldName;
    try {
      const result = await programGroup.updateCategory(oldName, newName, { image: '', video: '' });
      if (result.success || result.status === 'ok') {
        setImgVersion(v => v + 1);
        removeModalFocus(newName, true);
        removeModalVideoVolume(newName);
        removeModalClarityPoints(newName);
        setAllPrograms(prev => {
          const catData = prev[oldName];
          if (!catData) return prev;
          const updated: ProgramCategoryData = { ...catData, bg_image: '', bg_video: '' };
          if (newName !== oldName) {
            const next: AllPrograms = {};
            for (const k of Object.keys(prev)) next[k === oldName ? newName : k] = k === oldName ? updated : prev[k];
            return next;
          }
          return { ...prev, [oldName]: updated };
        });
        closeModal();
      }
    } catch(e) { console.error(e); }
  }, [closeModal, modalOldName, modalName, removeModalFocus, removeModalVideoVolume, removeModalClarityPoints, setAllPrograms]);

  const updateProgramDisplayMode = useCallback(async () => {
    const catName = modalOldName;
    try {
      await programGroup.updateDisplayMode(catName, modalMode, modalSize);
      setAllPrograms(prev => {
        if (!prev[catName]) return prev;
        return { ...prev, [catName]: { ...prev[catName], display_mode: modalMode, size_mode: modalSize } };
      });
      closeModal();
    } catch(e) { console.error(e); }
  }, [closeModal, modalOldName, modalMode, modalSize, setAllPrograms]);

  // ========== Prefab Merge/Replace ==========
  const mergePrefab = useCallback((pf: PrefabData) => {
    clearZoomState();
    snapshotZoom();
    const prefabTags = pf.tag_groups || [];
    const prefabCp = pf.custom_prompts || '';
    const prefabLoras = pf.loras || [];
    const prefabSelectedPrefabs = pf.selected_prefabs || [];

    // Collect all nested prefab guids recursively
    function collectNestedGuids(pfDef: PrefabData, visited = new Set<string>()): string[] {
      const guids: string[] = [];
      for (const sp of pfDef.selected_prefabs || []) {
        if (!visited.has(sp.guid)) {
          visited.add(sp.guid);
          guids.push(sp.guid);
          const nestedPf = findPrefabByGuid(sp.guid);
          if (nestedPf) {
            guids.push(...collectNestedGuids(nestedPf, visited));
          }
        }
      }
      return guids;
    }

    // Overall content matching: all prompts AND all loras must be present to count as "fully matched"
    const hasPrompts = prefabTags.length > 0;
    const hasLoras = prefabLoras.length > 0;
    const hasNestedPrefabs = prefabSelectedPrefabs.length > 0;

    let allPromptsMatched = true, anyPromptsMatched = false;
    for (const group of prefabTags) {
      const groupDisplay = tagsToDisplayName(group);
      if (selectedTags.some(g => tagsToDisplayName(g) === groupDisplay)) { anyPromptsMatched = true; }
      else { allPromptsMatched = false; }
    }

    const prefabLoraPaths = prefabLoras.map(pl => pl.file_path || (pl as any).file_name);
    let allLorasMatched = true, anyLorasMatched = false;
    for (const path of prefabLoraPaths) {
      if (selectedLoras.some(l => l.file_path === path)) { anyLorasMatched = true; }
      else { allLorasMatched = false; }
    }

    // Check if all nested prefabs are already selected
    const nestedGuids = collectNestedGuids(pf);
    let allNestedPrefabsMatched = true, anyNestedPrefabMatched = false;
    {
      const existingGuids = new Set<string>();
      function walkExisting(items: SelectedPrefabItem[]) {
        for (const item of items) {
          existingGuids.add(item.guid);
          walkExisting(item.children);
        }
      }
      walkExisting(selectedPrefabs);
      for (const guid of nestedGuids) {
        if (existingGuids.has(guid)) { anyNestedPrefabMatched = true; }
        else { allNestedPrefabsMatched = false; }
      }
    }

    const allContentMatched = (!hasPrompts || allPromptsMatched) && (!hasLoras || allLorasMatched) && (!hasNestedPrefabs || allNestedPrefabsMatched) && (hasPrompts || hasLoras || hasNestedPrefabs);
    const anyContentMatched = anyPromptsMatched || anyLorasMatched || anyNestedPrefabMatched;

    setSelectedTags(prev => {
      const next = prev.map(g => ({ ...g, tags: g.tags.map(t => ({ ...t })) }));
      if (allContentMatched && anyContentMatched) {
        // Fully matched: delete all prefab prompts
        for (const group of prefabTags) {
          const groupDisplay = tagsToDisplayName(group);
          const idx = next.findIndex(g => tagsToDisplayName(g) === groupDisplay);
          if (idx !== -1) next.splice(idx, 1);
        }
      } else {
        // Not fully matched: add missing prompts only
        for (const group of prefabTags) {
          const groupDisplay = tagsToDisplayName(group);
          if (!next.some(g => tagsToDisplayName(g) === groupDisplay)) {
            next.push({ ...group, tags: group.tags.map((t: any) => ({...t})) });
          }
        }
      }
      return next;
    });

    if (prefabCp) {
      setCustomPrompts(prev => {
        const pSeg = prefabCp.split('\n').map((s: string) => s.trim()).filter((s: string) => s);
        const cSeg = prev.split('\n').map((s: string) => s.trim()).filter((s: string) => s);
        if (allContentMatched && anyContentMatched) return cSeg.filter((s: string) => !pSeg.includes(s)).join('\n');
        for (const seg of pSeg) { if (!cSeg.includes(seg)) cSeg.push(seg); }
        return cSeg.join('\n');
      });
    }

    setSelectedLoras(prev => {
      let next = [...prev];
      if (allContentMatched && anyContentMatched) {
        // Fully matched: delete all prefab loras
        next = next.filter(l => !prefabLoraPaths.includes(l.file_path));
      } else {
        // Not fully matched: add missing loras only
        for (const pl of prefabLoras) {
          const path = pl.file_path || (pl as any).file_name;
          if (!next.some(l => l.file_path === path)) {
            let item: LoraItemData | null = null;
            for (const items of Object.values(loraData)) {
              const found = items.find(it => it.file_path === path);
              if (found) { item = found; break; }
            }
            if (!item) {
              const derivedName = path.includes('/') ? path.split('/').pop()! : path;
              item = { name: pl.name, file_name: derivedName, file_path: path, preview_url: '', tags: pl.active_tags || [], metadata: { missing: true } };
            }
            next.push(item);
          }
        }
      }
      return next;
    });

    setLoraSelections(prev => {
      const next = { ...prev };
      if (allContentMatched && anyContentMatched) {
        for (const pl of prefabLoras) {
          delete next[pl.file_path || (pl as any).file_name];
        }
      } else {
        for (const pl of prefabLoras) {
          next[pl.file_path || (pl as any).file_name] = {
            activeTags: pl.active_tags || [],
            strength: pl.strength ?? 1.0,
            active: pl.active ?? true,
            split_mode: pl.split_mode,
          };
        }
      }
      return next;
    });

    // Merge nested prefabs into selectedPrefabs (partial = add, full = remove)
    setSelectedPrefabs(prev => {
      if (allContentMatched && anyContentMatched) {
        // Full merge: remove all nested prefabs (and their descendants) from selectedPrefabs
        const toRemove = new Set(nestedGuids);
        function filterOut(items: SelectedPrefabItem[]): SelectedPrefabItem[] {
          return items
            .filter(item => !toRemove.has(item.guid))
            .map(item => ({ ...item, children: filterOut(item.children) }));
        }
        return filterOut(prev);
      } else {
        // Partial merge: add missing nested prefabs to selectedPrefabs
        const existing = new Set<string>();
        function walk(items: SelectedPrefabItem[]) {
          for (const item of items) {
            existing.add(item.guid);
            walk(item.children);
          }
        }
        walk(prev);

        const next = [...prev];
        for (const guid of nestedGuids) {
          if (!existing.has(guid)) {
            const item = buildPrefabItemTree(guid);
            if (item) next.push(item);
          }
        }
        return next;
      }
    });
  }, [selectedTags, setSelectedTags, setCustomPrompts, selectedLoras, setSelectedLoras, loraData, setLoraSelections, setSelectedPrefabs, findPrefabByGuid, buildPrefabItemTree]);

  const replacePrefab = useCallback((pf: PrefabData) => {
    clearZoomState();
    snapshotZoom();
    const tagGroups: TagGroup[] = (pf.tag_groups || []) as TagGroup[];
    setSelectedTags(tagGroups);
    setCustomPrompts(pf.custom_prompts || '');

    // Restore nested selected_prefabs as recursive tree
    const restoredPrefabs: SelectedPrefabItem[] = [];
    for (const sp of pf.selected_prefabs || []) {
      const item = buildPrefabItemTree(sp.guid);
      if (item) restoredPrefabs.push(item);
    }
    setSelectedPrefabs(restoredPrefabs);

    // Replace loras
    const prefabLoras = pf.loras || [];
    const newSelectedLoras: LoraItemData[] = [];
    const newLoraSelections: Record<string, { activeTags: string[]; strength: number; active: boolean; split_mode?: boolean }> = {};
    for (const pl of prefabLoras) {
      const path = pl.file_path || (pl as any).file_name;
      let item: LoraItemData | null = null;
      for (const items of Object.values(loraData)) {
        const found = items.find(it => it.file_path === path);
        if (found) { item = found; break; }
      }
      if (!item) {
        const derivedName = path.includes('/') ? path.split('/').pop()! : path;
        item = { name: pl.name, file_name: derivedName, file_path: path, preview_url: '', tags: pl.active_tags || [], metadata: { missing: true } };
      }
      newSelectedLoras.push(item);
      newLoraSelections[path] = {
        activeTags: pl.active_tags || [],
        strength: pl.strength ?? 1.0,
        active: pl.active ?? true,
        split_mode: pl.split_mode,
      };
    }
    setSelectedLoras(newSelectedLoras);
    setLoraSelections(newLoraSelections);
  }, [setSelectedTags, setCustomPrompts, setSelectedPrefabs, buildPrefabItemTree, loraData, setSelectedLoras, setLoraSelections]);

  // ========== Load From Image ==========
  const handleLoadFromImageClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImageSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const res = await fetch('/load_from_image', { method: 'POST', body: buffer });
      const result = await res.json();
      if (result.success && result.data) {
        setLoadFromImageData(result.data);
      } else {
        alert(result.error || 'Failed to load data from image');
      }
    } catch (err) {
      alert('Failed to load image: ' + String(err));
    }
    // Reset input so the same file can be selected again
    e.target.value = '';
  }, []);

  const applyLoadedData = useCallback((mode: 'merge' | 'replace') => {
    const loaded = loadFromImageData;
    if (!loaded) return;
    setLoadFromImageData(null);

    // --- Parse prompt string ---
    const promptStr: string = loaded.prompt || '';
    const segments: string[] = [];
    {
      let current = '';
      let angleDepth = 0;
      for (const ch of promptStr) {
        if (ch === '<') { angleDepth++; current += ch; }
        else if (ch === '>') { angleDepth--; current += ch; }
        else if (ch === ',' && angleDepth === 0) {
          const t = current.trim();
          if (t) segments.push(t);
          current = '';
        } else { current += ch; }
      }
      const t = current.trim();
      if (t) segments.push(t);
    }

    const regularSegments = segments.filter(s => !(s.startsWith('<') && s.endsWith('>')));
    const customSegments = segments.filter(s => s.startsWith('<') && s.endsWith('>')).map(s => s.slice(1, -1));

    // Build parsed keys from loaded prompt_parsing to mark is_from_parsing
    const loadedParsedStr: string = loaded.prompt_parsing || '';
    const loadedParsedKeys = new Set<string>();
    if (loadedParsedStr) {
      const parsedSegs = loadedParsedStr.split(',').map(s => s.trim()).filter(Boolean);
      for (const seg of parsedSegs) {
        const tags = parseStringToTags(seg, allPrompts);
        loadedParsedKeys.add(tagsToDisplayString(tags));
      }
    }
    // Parse sources map from loaded data (for restoring parsing/program source)
    let loadedSources: Record<string, string> = {};
    try { loadedSources = typeof loaded.sources === 'string' ? JSON.parse(loaded.sources || '{}') : (loaded.sources || {}); } catch {}
    const newTags = regularSegments.map(s => {
      const tg = parseStringToTags(s, allPrompts);
      const key = tagsToDisplayString(tg);
      const isFromParsing = loadedParsedKeys.has(key);
      const source = (loadedSources[key] as 'parsing' | 'program') || (isFromParsing ? 'parsing' as const : 'normal' as const);
      return { ...tg, tags: tg.tags.map(t => ({ ...t })), source };
    });

    // --- Parse lora data ---
    let newLoras: LoraItemData[] = [];
    let newLoraSelections: Record<string, { activeTags: string[]; strength: number; active: boolean; split_mode?: boolean }> = {};
    try {
      const loraArr = JSON.parse(loaded.lora || '[]');
      const available = new Map<string, LoraItemData>();
      for (const items of Object.values(loraData)) {
        for (const item of items) { available.set(item.file_path, item); }
      }
      for (const saved of loraArr) {
        const lookupKey = saved.file_path || saved.file_name;
        const item = available.get(lookupKey);
        const loraSource = loadedSources[`lora:${lookupKey}`] || 'normal';
        if (item) {
          newLoras.push({ ...item, source: loraSource as any });
          newLoraSelections[item.file_path] = {
            activeTags: saved.active_tags || [],
            strength: saved.strength ?? 1.0,
            active: saved.active ?? true,
            split_mode: saved.split_mode,
          };
        } else {
          const derivedName = lookupKey.includes('/') ? lookupKey.split('/').pop()! : lookupKey;
          newLoras.push({
            name: saved.name || derivedName,
            file_name: derivedName,
            file_path: lookupKey,
            preview_url: '',
            tags: saved.active_tags || [],
            metadata: { missing: true },
            source: loraSource as any,
          });
          newLoraSelections[lookupKey] = {
            activeTags: saved.active_tags || [],
            strength: saved.strength ?? 1.0,
            active: saved.active ?? true,
            split_mode: saved.split_mode,
          };
        }
      }
    } catch {}

    // --- Parse prefab data ---
    let newPrefabs: SelectedPrefabItem[] = [];
    try {
      const prefabArr = JSON.parse(loaded.prefab || '[]');
      function restoreTree(
        node: { guid: string; active?: boolean; tag_groups?: SelectedPrefabTagState[]; tags?: SelectedPrefabTagState[]; loras?: SelectedPrefabLoraState[]; children?: any[] },
        visited: Set<string>,
      ): SelectedPrefabItem | null {
        if (visited.has(node.guid)) return null;
        const prefab = findPrefabByGuid(node.guid);
        if (!prefab) return null;
        visited.add(node.guid);
        const savedTags = (node.tag_groups || node.tags || []) as SelectedPrefabTagState[];
        const tag_groups: SelectedPrefabTagState[] = (prefab.tag_groups || []).map(g => {
          const key = tagsToDisplayName(g as any);
          const saved = savedTags.find(st => st.key === key);
          return { key, active: saved ? saved.active !== false : true };
        });
        const savedLoras = (node.loras || []) as SelectedPrefabLoraState[];
        const loras: SelectedPrefabLoraState[] = (prefab.loras || []).map(l => {
          const fp = l.file_path || (l as any).file_name || '';
          const saved = savedLoras.find(sl => sl.file_path === fp);
          return { file_path: fp, active: saved ? saved.active !== false : true };
        });
        const savedChildren = (node.children || []) as any[];
        const children: SelectedPrefabItem[] = (prefab.selected_prefabs || [])
          .map(nested => {
            const saved = savedChildren.find(sc => sc.guid === nested.guid);
            return restoreTree(saved || nested, new Set(visited));
          })
          .filter(Boolean) as SelectedPrefabItem[];
        return { guid: node.guid, active: node.active !== false, tag_groups, loras, children, source: (loadedSources[`prefab:${node.guid}`] as any) || 'normal' };
      }
      for (const sp of prefabArr) {
        const item = restoreTree(sp, new Set());
        if (item) newPrefabs.push(item);
      }
    } catch {}

    // --- Parse program data ---
    let newPrograms: SelectedProgramItem[] = [];
    try {
      const programArr = JSON.parse(loaded.program || '[]');
      newPrograms = programArr.map((p: any) => ({ id: p.id, active: p.active !== false, context_prefab_guids: p.context_prefab_guids, context_lora_paths: p.context_lora_paths, context_prompt_texts: p.context_prompt_texts, context_prefab_inactive: p.context_prefab_inactive, context_lora_inactive: p.context_lora_inactive, context_prompt_inactive: p.context_prompt_inactive }));
    } catch {}

    if (mode === 'replace') {
      setSelectedTags(newTags);
      setCustomPrompts(customSegments.join('\n'));
      setSelectedLoras(newLoras);
      setLoraSelections(newLoraSelections);
      setSelectedPrefabs(newPrefabs);
      setSelectedPrograms(newPrograms);
    } else {
      // Merge prompts
      setSelectedTags(prev => {
        const existing = new Set(prev.map(g => tagsToDisplayString(g)));
        const toAdd = newTags.filter(g => !existing.has(tagsToDisplayString(g)));
        return [...prev, ...toAdd];
      });
      // Merge custom prompts
      setCustomPrompts(prev => {
        const existing = prev.split('\n').map(s => s.trim()).filter(Boolean);
        const toAdd = customSegments.filter(s => !existing.includes(s));
        return [...existing, ...toAdd].join('\n');
      });
      // Merge loras
      setSelectedLoras(prev => {
        const existing = new Set(prev.map(l => l.file_path));
        const toAdd = newLoras.filter(l => !existing.has(l.file_path));
        return [...prev, ...toAdd];
      });
      setLoraSelections(prev => ({ ...prev, ...newLoraSelections }));
      // Merge prefabs
      setSelectedPrefabs(prev => {
        const existing = new Set<string>();
        const walk = (items: SelectedPrefabItem[]) => {
          for (const item of items) { existing.add(item.guid); walk(item.children); }
        };
        walk(prev);
        const toAdd = newPrefabs.filter(p => !existing.has(p.guid));
        return [...prev, ...toAdd];
      });
      // Merge programs
      setSelectedPrograms(prev => {
        const existing = new Set(prev.map(p => p.id));
        const toAdd = newPrograms.filter(p => !existing.has(p.id));
        return [...prev, ...toAdd];
      });
    }
  }, [loadFromImageData, allPrompts, loraData, findPrefabByGuid, setSelectedTags, setCustomPrompts, setSelectedLoras, setLoraSelections, setSelectedPrefabs, setSelectedPrograms]);

  // ========== Confirm ==========
  const handleConfirm = useCallback(() => {
    // Flush pending region confirm (don't wait for debounce timer)
    if (enableRegion) {
      if (regionConfirmTimer.current) clearTimeout(regionConfirmTimer.current);
      // Save current prompt selection to active region's promptContext + desc before flushing
      const idx = regionActiveRef.current;
      if (idx >= 0 && idx < regionBoxesRef.current.length) {
        const promptsToSend = selectedTags.map(g => tagsToDisplayString(g));
        const lorasPayload: LoraSelectionData[] = selectedLoras.map(l => {
          const sel = loraSelections[l.file_path];
          return { file_path: l.file_path, name: l.name, strength: sel?.strength ?? 1.0, active_tags: sel?.activeTags ?? [], active: sel?.active ?? true, split_mode: sel?.split_mode };
        });
        const prefabsPayload = selectedPrefabs.map(p => ({ guid: p.guid, active: p.active, tag_groups: p.tag_groups, loras: p.loras, children: p.children }));
        const ctx: PromptContextBase = {
          prompts: promptsToSend, custom_prompts: customPrompts, loras: lorasPayload, prefabs: prefabsPayload,
          label: idx >= 0 ? `Region ${String(idx + 1).padStart(2, '0')}` : 'Background',
        };
        const nbs = [...regionBoxesRef.current];
        nbs[idx] = { ...nbs[idx], promptContext: ctx };
        regionBoxesRef.current = nbs;
        void prefabsPayload;
      }
      // Assemble region_prompt using RegionFormatManager
      let assembledPrompt = '';
      const mgr = formatManagerRef.current;
      if (mgr && mgr.hasTemplate()) {
        // Save current active slot context before assembling
        if (activeSlotId) {
          const currentCtx: PromptContextBase = {
            prompts: selectedTags.map(g => tagsToDisplayString(g)),
            custom_prompts: customPrompts,
            loras: selectedLoras.map(l => {
              const sel = loraSelections[l.file_path];
              return { file_path: l.file_path, name: l.name, strength: sel?.strength ?? 1.0, active_tags: sel?.activeTags ?? [], active: sel?.active ?? true, split_mode: sel?.split_mode };
            }),
            prefabs: selectedPrefabs.map(p => ({ guid: p.guid, active: p.active, tag_groups: p.tag_groups, loras: p.loras, children: p.children })),
            label: activeSlotId,
          };
          formatSlotContextsRef.current.set(activeSlotId, currentCtx);
        }
        // Build context values from saved slots — each slot's prompt is built the same way as region desc
        const contextValues = new Map<string, string>();
        for (const slot of mgr.getContextSlots()) {
          const ctx = formatSlotContextsRef.current.get(slot.id);
          if (ctx) {
            contextValues.set(slot.id, buildPromptText(ctx, findPrefabByGuid));
          }
        }
        // Build background prompt
        const bgCtx = backgroundContextRef.current;
        let bgPrompt = '';
        if (bgCtx) {
          bgPrompt = buildPromptText(bgCtx, findPrefabByGuid);
        }
        // Build regions array
        const regions = regionBoxesRef.current
          .filter(b => !b.nobbox)
          .map(box => ({
            bbox: [
              Math.round(box.y * 1000),
              Math.round(box.x * 1000),
              Math.round((box.y + box.h) * 1000),
              Math.round((box.x + box.w) * 1000),
            ],
            prompt: box.desc || '',
          }));
        assembledPrompt = mgr.assemble(contextValues, bgPrompt, regions);
      }
      fetch('/region_confirm', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          boxes: regionBoxesRef.current,
          region_prompt: assembledPrompt,
          format_slots: Object.fromEntries(formatSlotContextsRef.current),
          background_context: backgroundContextRef.current,
        }),
      }).catch(()=>{});
    }

    // The prompt/active_loras/lora_trigger_words/merged_prompt outputs must reflect
    // the BACKGROUND context, not the currently selected context.
    let submitPrompts: string[];
    let submitCustom: string;
    let submitLoras: LoraSelectionData[];
    let submitPrefabs: { guid: string; active: boolean; tag_groups: any[]; loras: any[]; children: any[] }[];

    if (enableRegion && backgroundContextRef.current) {
      // Use background context
      const bg = backgroundContextRef.current;
      submitPrompts = bg.prompts;
      submitCustom = bg.custom_prompts;
      submitLoras = bg.loras;
      submitPrefabs = bg.prefabs;
    } else {
      // No region mode — use program-filtered selections
      submitPrompts = programResult.resultTags.map(g => tagsToDisplayString(g));
      submitCustom = programResult.resultCustomPrompts;
      submitLoras = programResult.resultLoras;
      submitPrefabs = programResult.resultPrefabs.map(p => ({ guid: p.guid, active: p.active, tag_groups: p.tag_groups, loras: p.loras, children: p.children }));
    }

    // Build sources map for non-normal items (so load_from_image can restore source)
    const sources: Record<string, string> = {};
    for (const g of selectedTags) {
      if (g.source && g.source !== 'normal') sources[tagsToDisplayString(g)] = g.source;
    }
    for (const l of selectedLoras) {
      if ((l as any).source && (l as any).source !== 'normal') sources[`lora:${l.file_path}`] = (l as any).source;
    }
    for (const p of selectedPrefabs) {
      if ((p as any).source && (p as any).source !== 'normal') sources[`prefab:${p.guid}`] = (p as any).source;
    }

    submitSelection(
      submitPrompts,
      submitCustom,
      submitLoras,
      submitPrefabs,
      selectedPrograms.map(a => ({ id: a.id, active: a.active, context_prefab_guids: a.context_prefab_guids, context_lora_paths: a.context_lora_paths, context_prompt_texts: a.context_prompt_texts, context_prefab_inactive: a.context_prefab_inactive, context_lora_inactive: a.context_lora_inactive, context_prompt_inactive: a.context_prompt_inactive })),
      sources,
      () => {
        if (window.parent !== window) {
          window.parent.postMessage({ type: 'prompt-confirmed' }, '*');
        }
      }
    );
  }, [selectedTags, customPrompts, selectedLoras, loraSelections, selectedPrefabs, selectedPrograms, programResult, submitSelection, enableRegion]);

  // ========== Delete Prompt ==========
  const deletePrompt = useCallback(async (id: string) => {
    if (!confirm('Delete this prompt?')) return;
    try {
      const r = await fetch('/delete_prompt', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id}) });
      if (!r.ok) return;
      setAllPrompts((prev: AllPrompts) => {
        const next: AllPrompts = {};
        for (const [cat, catData] of Object.entries(prev)) {
          const prompts = ((catData as CategoryData).prompts || []).filter((p: PromptData) => p.id !== id);
          next[cat] = { ...(catData as CategoryData), prompts };
        }
        return next;
      });
    } catch(e) { console.error(e); }
  }, [setAllPrompts]);

  // ========== Add Prompt ==========
  const addPrompt = useCallback(async (cat: string) => {
    const name = prompt('Prompt name:')?.trim();
    if (!name) return;
    const text = prompt('Prompt text:')?.trim();
    if (!text) return;
    try {
      const res = await fetch('/add_prompt', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({category:cat, name, prompt:text}) });
      if (!res.ok) return;
      const result = await res.json();
      const newPrompt: PromptData = { id: result.id || `${Date.now()}`, name, prompt: text, preview: result.preview || '' };
      setAllPrompts((prev: AllPrompts) => {
        const catData = prev[cat];
        return { ...prev, [cat]: { ...(catData as CategoryData || {}), prompts: [...((catData as CategoryData)?.prompts || []), newPrompt] } };
      });
    } catch(e) { console.error(e); }
  }, [setAllPrompts]);

  // ========== Add Category ==========
  const addCategory = useCallback(async () => {
    const name = modalName.trim();
    if (!name) return;
    try {
      await categoryGroup.add(name);
      closeModal();
      setAllPrompts((prev: AllPrompts) => ({ ...prev, [name]: { prompts: [], display_mode: 'horizontal', size_mode: 'normal' as any } }));
    } catch(e) { console.error(e); }
  }, [closeModal, modalName, setAllPrompts]);

  // ========== Add Library ==========
  const addLibrary = useCallback(async () => {
    const name = modalName.trim();
    if (!name) return;
    try {
      await libraryGroup.add(name);
      closeModal();
      setAllLibraries((prev: AllLibraries) => ({ ...prev, [name]: { prefabs: [] } }));
    } catch(e) { console.error(e); }
  }, [closeModal, modalName, setAllLibraries]);

  // ========== Update Category ==========
  const updateCategory = useCallback(async () => {
    const oldName = modalOldName;
    const newName = modalName.trim();
    if (!newName) { alert('Please enter category name'); return; }
    let imageData: string|null = null;
    if (modalImageFile) { const r = new FileReader(); imageData = await new Promise(resolve => { r.onload = e => resolve(e.target?.result as string); r.readAsDataURL(modalImageFile); }); }
    let videoData: string|null = null;
    if (modalVideoFile) { const fn = await getUploadedVideoFilename(); videoData = fn || ''; } else if (!modalVideoUrl) { videoData = null; }
    try {
      const result = await categoryGroup.update(oldName, newName, {
        tags: modalTags, decorations: modalDecorations, image: imageData, video: videoData
      });
      if (result.success) {
        if (imageData || videoData) setImgVersion(v => v + 1);
        saveModalFocus(newName, true);
        saveModalVideoVolume(newName);
        saveModalClarityPoints(newName);
        setAllPrompts((prev: AllPrompts) => {
          const catData = prev[oldName];
          if (!catData) return prev;
          const updated: CategoryData = { ...(catData as CategoryData), tags: modalTags, decorations: modalDecorations, bg_image: result.bg_image !== undefined ? result.bg_image : (catData as CategoryData).bg_image, bg_video: videoData !== null ? videoData : (catData as CategoryData).bg_video };
          if (newName !== oldName) {
            const next: AllPrompts = {};
            for (const k of Object.keys(prev)) {
              next[k === oldName ? newName : k] = k === oldName ? updated : prev[k];
            }
            return next;
          } else {
            return { ...prev, [oldName]: updated };
          }
        });
        if (newName !== oldName) {
          setCategoryDisplayModes((prev: any) => {
            const n = { ...prev };
            if (oldName in n) { n[newName] = n[oldName]; delete n[oldName]; }
            return n;
          });
          setCategorySizeModes((prev: any) => {
            const n = { ...prev };
            if (oldName in n) { n[newName] = n[oldName]; delete n[oldName]; }
            return n;
          });
        }
        closeModal();
      }
    } catch(e) { console.error(e); alert('Failed to update category'); }
  }, [closeModal, modalOldName, modalName, modalTags, modalDecorations, modalImageFile, modalVideoFile, modalVideoFilename, modalVideoUrl, getUploadedVideoFilename, saveModalFocus, saveModalVideoVolume, saveModalClarityPoints, setAllPrompts, setCategoryDisplayModes, setCategorySizeModes]);

  const removeCategoryBg = useCallback(async () => {
    const oldName = modalOldName;
    const newName = modalName.trim() || oldName;
    try {
      const result = await categoryGroup.update(oldName, newName, { tags: modalTags, decorations: modalDecorations, image: '', video: '' });
      if (result.success) {
        setImgVersion(v => v + 1);
        removeModalFocus(newName, true);
        removeModalVideoVolume(newName);
        removeModalClarityPoints(newName);
        setAllPrompts((prev: AllPrompts) => {
          const catData = prev[oldName];
          if (!catData) return prev;
          const updated: CategoryData = { ...(catData as CategoryData), tags: modalTags, decorations: modalDecorations, bg_image: '', bg_video: '' };
          if (newName !== oldName) {
            const next: AllPrompts = {};
            for (const k of Object.keys(prev)) {
              next[k === oldName ? newName : k] = k === oldName ? updated : prev[k];
            }
            return next;
          } else {
            return { ...prev, [oldName]: updated };
          }
        });
        closeModal();
      }
    } catch(e) { console.error(e); }
  }, [closeModal, modalOldName, modalName, modalTags, modalDecorations, removeModalFocus, removeModalVideoVolume, removeModalClarityPoints, setAllPrompts]);

  // ========== Update Library ==========
  const updateLibrary = useCallback(async () => {
    const oldName = modalOldName;
    const newName = modalName.trim();
    if (!newName) { alert('Please enter library name'); return; }
    const pids = modalPromptIds ? modalPromptIds.split(',').map((s: string) => s.trim()).filter((s: string) => s) : [];
    let imageData: string|null = null;
    if (modalImageFile) { const r = new FileReader(); imageData = await new Promise(resolve => { r.onload = e => resolve(e.target?.result as string); r.readAsDataURL(modalImageFile); }); }
    let videoData: string|null = null;
    if (modalVideoFile) { const fn = await getUploadedVideoFilename(); videoData = fn || ''; } else if (!modalVideoUrl) { videoData = null; }
    try {
      const result = await libraryGroup.update(oldName, newName, { prompt_ids: pids, image: imageData, video: videoData });
      if (result.success) {
        if (imageData !== null || videoData !== null) setImgVersion(v => v + 1);
        saveModalFocus(newName, true);
        saveModalVideoVolume(newName);
        saveModalClarityPoints(newName);
        setAllLibraries((prev: AllLibraries) => {
          const libData = prev[oldName];
          if (!libData) return prev;
          const updated: LibraryData = { ...libData, prompt_ids: pids, bg_image: result.bg_image !== undefined ? result.bg_image : libData.bg_image, bg_video: videoData !== null ? videoData : libData.bg_video };
          if (newName !== oldName) {
            const next: AllLibraries = {};
            for (const k of Object.keys(prev)) {
              next[k === oldName ? newName : k] = k === oldName ? updated : prev[k];
            }
            return next;
          } else {
            return { ...prev, [oldName]: updated };
          }
        });
        closeModal();
      }
    } catch(e) { console.error(e); alert('Failed to update library'); }
  }, [closeModal, modalOldName, modalName, modalPromptIds, modalImageFile, modalVideoFile, modalVideoFilename, modalVideoUrl, getUploadedVideoFilename, saveModalFocus, saveModalVideoVolume, saveModalClarityPoints, setAllLibraries]);

  // ========== Update Lora Folder Meta ==========
  const updateLoraFolder = useCallback(async () => {
    const folderName = modalOldName;
    if (!folderName) return;
    let imageData: string|null = null;
    if (modalImageFile) { const r = new FileReader(); imageData = await new Promise(resolve => { r.onload = e => resolve(e.target?.result as string); r.readAsDataURL(modalImageFile); }); }
    let videoData: string|null = null;
    if (modalVideoFile) { const fn = await getUploadedVideoFilename(); videoData = fn || ''; } else if (!modalVideoUrl) { videoData = null; }
    try {
      const res = await fetch('/update_lora_folder_meta', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({folder_name:folderName, image:imageData, video:videoData}) });
      const result = await res.json();
      if (result.success) {
        if (imageData || videoData) setImgVersion(v => v + 1);
        setLoraFolderMeta((prev: Record<string, {bg_image?: string; bg_video?: string}>) => ({
          ...prev,
          [folderName]: { bg_image: result.bg_image !== undefined ? result.bg_image : prev[folderName]?.bg_image, bg_video: result.bg_video !== undefined ? result.bg_video : prev[folderName]?.bg_video },
        }));
        saveModalVideoVolume(folderName);
        saveModalClarityPoints(folderName);
        closeModal();
      }
    } catch(e) { console.error(e); }
  }, [closeModal, modalOldName, modalImageFile, modalVideoFile, modalVideoFilename, modalVideoUrl, getUploadedVideoFilename, setImgVersion, saveModalVideoVolume, saveModalClarityPoints]);

  const removeLoraFolderBg = useCallback(async () => {
    const folderName = modalOldName;
    if (!folderName) return;
    try {
      const res = await fetch('/update_lora_folder_meta', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({folder_name:folderName, image:'', video:''}) });
      const result = await res.json();
      if (result.success) {
        setImgVersion(v => v + 1);
        setLoraFolderMeta((prev: Record<string, {bg_image?: string; bg_video?: string}>) => ({ ...prev, [folderName]: { bg_image: '', bg_video: '' } }));
        removeModalVideoVolume(folderName);
        removeModalClarityPoints(folderName);
        closeModal();
      }
    } catch(e) { console.error(e); }
  }, [closeModal, modalOldName, setImgVersion, removeModalVideoVolume, removeModalClarityPoints]);

  // ========== Delete Library ==========
  const deleteLibrary = useCallback(async () => {
    const name = modalOldName;
    if (!confirm(`Delete library "${name}"?`)) return;
    try {
      const result = await libraryGroup.delete(name);
      if (result.success) { closeModal(); }
    } catch(e) { console.error(e); }
  }, [closeModal, modalOldName]);

  const deleteCategoryDirect = useCallback(async (name: string) => {
    if (!confirm(`Delete category "${name}"? All prompts inside will also be deleted.`)) return;
    try {
      await categoryGroup.delete(name);
      setAllPrompts((prev: AllPrompts) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      setCategoryDisplayModes((prev: any) => { const n = { ...prev }; delete n[name]; return n; });
      setCategorySizeModes((prev: any) => { const n = { ...prev }; delete n[name]; return n; });
      removeModalFocus(name, true);
    } catch(e) { console.error(e); }
  }, [setAllPrompts, setCategoryDisplayModes, setCategorySizeModes, removeModalFocus]);

  const deleteLibraryDirect = useCallback(async (name: string) => {
    if (!confirm(`Delete library "${name}"?`)) return;
    try {
      await libraryGroup.delete(name);
      setAllLibraries((prev: AllLibraries) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      removeModalFocus(name, true);
    } catch(e) { console.error(e); }
  }, [setAllLibraries, removeModalFocus]);

  // ========== Update Display Mode ==========
  const updateDisplayMode = useCallback(async () => {
    const name = modalOldName;
    const mod = modalIsCat ? categoryDisplay : libraryDisplay;
    try {
      const result = await mod.save(name, modalMode, modalSize);
      if (result.success) {
        if (modalIsCat) {
          setCategoryDisplayModes(prev => ({ ...prev, [name]: modalMode }));
          setCategorySizeModes(prev => ({ ...prev, [name]: modalSize }));
        } else {
          setAllLibraries(prev => {
            if (!prev[name]) return prev;
            return { ...prev, [name]: { ...prev[name], display_mode: modalMode, size_mode: modalSize } };
          });
        }
        closeModal();
        rerender();
      } else {
        console.error('updateDisplayMode: server returned non-success', result);
        closeModal();
      }
    } catch(e) {
      console.error('updateDisplayMode error:', e);
      closeModal();
    }
  }, [closeModal, modalOldName, modalMode, modalSize, modalIsCat, setCategoryDisplayModes, setCategorySizeModes, setAllLibraries, rerender]);

  // ========== Update Prompt ==========
  const updatePrompt = useCallback(async () => {
    const id = modalOldName;
    const name = modalName.trim();
    const pt = modalPrompt.trim();
    if (!name || !pt) { alert('Please enter name and prompt text'); return; }
    let imageData = '';
    if (modalImageFile) { const r = new FileReader(); imageData = await new Promise(resolve => { r.onload = e => resolve(e.target?.result as string); r.readAsDataURL(modalImageFile); }); }
    try {
      const res = await fetch('/update_prompt', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id, name, prompt:pt, tags:modalTags, decorations:modalDecorations, mute_decorations:modalMuteDecorations, category:modalCategory, image:imageData}) });
      const result = await res.json();
      if (imageData) setImgVersion(v => v + 1);
      saveModalFocus(id, false);
      setAllPrompts((prev: AllPrompts) => {
        const next: AllPrompts = {};
        for (const [cat, catData] of Object.entries(prev)) {
          const prompts = ((catData as CategoryData).prompts || []).map((p: PromptData) =>
            p.id === id ? { ...p, name, prompt: pt, tags: modalTags as any, decorations: modalDecorations as any, mute_decorations: modalMuteDecorations, preview: result.preview || p.preview } : p,
          );
          next[cat] = { ...(catData as CategoryData), prompts };
        }
        return next;
      });
      closeModal();
    } catch(e) { console.error(e); }
  }, [closeModal, modalOldName, modalName, modalPrompt, modalTags, modalDecorations, modalMuteDecorations, modalCategory, modalImageFile, saveModalFocus, setAllPrompts]);

  // Helper to build current lora payload for prefab storage
  const buildPrefabLoras = useCallback(() => {
    return selectedLoras.map(l => {
      const sel = loraSelections[l.file_path];
      return {
        file_path: l.file_path,
        name: l.name,
        strength: sel?.strength ?? 1.0,
        active_tags: sel?.activeTags ?? [],
        active: sel?.active ?? true,
        split_mode: sel?.split_mode,
      };
    });
  }, [selectedLoras, loraSelections]);

  const buildSelectedPrefabs = useCallback(() => {
    return selectedPrefabs.map(p => ({ guid: p.guid }));
  }, [selectedPrefabs]);

  // Check for circular dependencies in selected_prefabs
  const checkPrefabCycle = useCallback((targetGuid: string | null, selectedPrefabsToCheck: { guid: string }[]): string | null => {
    const guidMap = new Map<string, PrefabData>();
    for (const libData of Object.values(allLibraries)) {
      for (const pf of libData.prefabs || []) {
        if (pf.guid) guidMap.set(pf.guid, pf);
      }
    }
    for (const sp of selectedPrefabsToCheck) {
      const visited = new Set<string>();
      const stack: string[] = [sp.guid];
      while (stack.length > 0) {
        const currentGuid = stack.pop()!;
        if (targetGuid && currentGuid === targetGuid) {
          return `Cycle detected: ${sp.guid} -> ... -> ${targetGuid}`;
        }
        if (visited.has(currentGuid)) continue;
        visited.add(currentGuid);
        const pf = guidMap.get(currentGuid);
        const nested = pf?.selected_prefabs || [];
        for (const n of nested) {
          stack.push(n.guid);
        }
      }
    }
    return null;
  }, [allLibraries]);

  // ========== Add Prefab ==========
  const addPrefab = useCallback(async () => {
    const lib = modal?.data?.lib;
    const name = modalName.trim();
    if (!name || !lib) { alert('Please enter prefab name'); return; }
    const pfTags = selectedTags.map(g => ({ ...g, tags: g.tags.map(t => ({...t})) }));
    const pfLoras = buildPrefabLoras();
    const pfSelectedPrefabs = buildSelectedPrefabs();
    const cycle = checkPrefabCycle(null, pfSelectedPrefabs);
    if (cycle) { setErrorModal({ title: 'Circular Dependency', message: cycle }); return; }
    let imageData = '';
    if (modalImageFile) { const r = new FileReader(); imageData = await new Promise(resolve => { r.onload = e => resolve(e.target?.result as string); r.readAsDataURL(modalImageFile); }); }
    try {
      const res = await fetch('/add_library_prefab', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({library:lib, prefab_name:name, prefab_tags:pfTags, custom_prompts:customPrompts, loras:pfLoras, selected_prefabs:pfSelectedPrefabs, image:imageData}) });
      const result = await res.json();
      closeModal();
      if (imageData) setImgVersion(v => v + 1);
      setAllLibraries((prev: AllLibraries) => {
        const libData = prev[lib];
        if (!libData) return prev;
        const newPrefab: PrefabData = { name, tag_groups: pfTags, custom_prompts: customPrompts, loras: pfLoras, selected_prefabs: pfSelectedPrefabs };
        if (result && result.preview) newPrefab.preview = result.preview;
        if (result && result.guid) newPrefab.guid = result.guid;
        const prefabs = [...(libData.prefabs || []), newPrefab];
        return { ...prev, [lib]: { ...libData, prefabs } };
      });
    } catch(e) { console.error(e); }
  }, [closeModal, modalName, modal?.data?.lib, selectedTags, customPrompts, buildPrefabLoras, buildSelectedPrefabs, checkPrefabCycle, modalImageFile, setAllLibraries]);

  // ========== Update Prefab ==========
  const updatePrefab = useCallback(async () => {
    const lib = modal?.data?.lib;
    const idx = modal?.data?.idx;
    const name = modalName.trim();
    if (!name || lib==null || idx==null) { alert('Please enter prefab name'); return; }
    let imageData = null;
    if (modalImageFile) { const r = new FileReader(); imageData = await new Promise(resolve => { r.onload = e => resolve(e.target?.result as string); r.readAsDataURL(modalImageFile); }); }
    const body: any = {library:lib, prefab_index:idx, prefab_name:name, custom_prompts:modalCustomPrompts, prefab_tags:modalPrefabTags, loras:modalPrefabLoras, selected_prefabs:modalPrefabSelectedPrefabs};
    if (imageData !== null) body.image = imageData;
    try {
      const res = await fetch('/update_library_prefab', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
      const result = await res.json();
      if (imageData !== null) setImgVersion(v => v + 1);
      const key = `prefab_${lib}_${idx}`;
      saveModalFocus(key, false);
      setAllLibraries((prev: AllLibraries) => {
        const libData = prev[lib];
        if (!libData || !libData.prefabs) return prev;
        const prefabs = libData.prefabs.map((pf: PrefabData, i: number) =>
          i === idx ? { ...pf, name, custom_prompts: modalCustomPrompts, tags: modalPrefabTags, loras: modalPrefabLoras, selected_prefabs: modalPrefabSelectedPrefabs, preview: result.preview !== undefined ? result.preview : pf.preview } : pf,
        );
        return { ...prev, [lib]: { ...libData, prefabs } };
      });
      closeModal();
    } catch(e) { console.error(e); }
  }, [closeModal, modalName, modalCustomPrompts, modalPrefabTags, modalPrefabLoras, modalPrefabSelectedPrefabs, modal?.data?.lib, modal?.data?.idx, modalImageFile, saveModalFocus, setAllLibraries]);

  // ========== Restore Modal from Main Selection ==========
  const restoreModalWithSelections = useCallback(() => {
    if (!tempCtx.current || !tempCtx.current.restorePoint) return;
    const rp = tempCtx.current.restorePoint;
    setModalName(rp.name);
    setModalCustomPrompts(rp.customPrompts);
    setModalPrefabTags(rp.prefabTags);
    let newLoras = [...rp.prefabLoras];
    let newPrefabs = [...rp.prefabSelectedPrefabs];
    let newPrograms = [...(rp.programSelectedPrograms || [])];
    if (tempCtx.mode === 'lora') {
      const added = (tempCtx.current.selections || []).map(path => {
        const item = Object.values(loraData).flat().find(it => it.file_path === path);
        if (!item || newLoras.some(l => l.file_path === path)) return null;
        const state = tempCtx.current.loraStates?.[path];
        return {
          file_path: item.file_path,
          name: item.name,
          strength: state?.strength ?? 1.0,
          active_tags: state?.active_tags ?? (item.tags || []),
          active: state?.active ?? true,
          split_mode: state?.split_mode,
        };
      }).filter(Boolean) as LoraSelectionData[];
      newLoras = [...newLoras, ...added];
    } else if (tempCtx.mode === 'prefab') {
      const added = (tempCtx.current.selections || []).map(guid => {
        if (newPrefabs.some(p => p.guid === guid)) return null;
        return { guid };
      }).filter(Boolean) as SelectedPrefabRef[];
      newPrefabs = [...newPrefabs, ...added];
    } else if (tempCtx.mode === 'program') {
      const added = (tempCtx.current.selections || []).map(id => {
        if (newPrograms.some(p => p.id === id)) return null;
        return { id, active: true };
      }).filter(Boolean) as { id: string; active: boolean }[];
      newPrograms = [...newPrograms, ...added];
    } else if (tempCtx.mode === 'prefabCtx') {
      setModalCtxPrefabGuids([...(tempCtx.current.selections || [])]);
    } else if (tempCtx.mode === 'loraCtx') {
      setModalCtxLoraPaths([...(tempCtx.current.selections || [])]);
    } else if (tempCtx.mode === 'promptCtx') {
      setModalCtxPromptTexts([...(tempCtx.current.selections || [])]);
    }
    setModalPrefabLoras(newLoras);
    setModalPrefabSelectedPrefabs(newPrefabs);
    setModalProgramSelectedPrograms(newPrograms);
    setModalPreviewUrl(rp.previewUrl);
    setModalPreviewVisible(rp.previewVisible);
    setModalFocusX(rp.focusX);
    setModalFocusY(rp.focusY);
    setModalFocusVisible(rp.focusVisible);
    setModalEnablePrefabCtx(!!rp.enablePrefabCtx);
    setModalEnableLoraCtx(!!rp.enableLoraCtx);
    setModalEnablePromptCtx(!!rp.enablePromptCtx);
    if (tempCtx.mode !== 'prefabCtx') setModalCtxPrefabGuids([...(rp.ctxPrefabGuids || [])]);
    if (tempCtx.mode !== 'loraCtx') setModalCtxLoraPaths([...(rp.ctxLoraPaths || [])]);
    if (tempCtx.mode !== 'promptCtx') setModalCtxPromptTexts([...(rp.ctxPromptTexts || [])]);
    // For context modes: save directly to the selected program instance (not the shared ProgramData)
    if (tempCtx.mode === 'prefabCtx' || tempCtx.mode === 'loraCtx' || tempCtx.mode === 'promptCtx') {
      const instanceIdx = (rp.modalData as { programId: string; instanceIndex: number }).instanceIndex;
      const selections = [...(tempCtx.current.selections || [])];
      setSelectedPrograms(prev => prev.map((p, j) => {
        if (j !== instanceIdx) return p;
        if (tempCtx.mode === 'prefabCtx') return { ...p, context_prefab_guids: selections };
        if (tempCtx.mode === 'loraCtx') return { ...p, context_lora_paths: selections };
        if (tempCtx.mode === 'promptCtx') return { ...p, context_prompt_texts: selections };
        return p;
      }));
      tempCtx.clear();
      return;
    }
    if (rp.modalData && 'programId' in rp.modalData) {
      setModal({ type: 'editProgram', data: { id: rp.modalData.programId } });
    } else {
      setModal({ type: 'editPrefab', data: rp.modalData as { lib: string; idx: number } });
    }
    tempCtx.clear();
  }, [tempCtx, loraData]);

  const cancelMainSelection = useCallback(() => {
    if (!tempCtx.current || !tempCtx.current.restorePoint) return;
    const rp = tempCtx.current.restorePoint;
    setModalName(rp.name);
    setModalCustomPrompts(rp.customPrompts);
    setModalPrefabTags(rp.prefabTags);
    setModalPrefabLoras(rp.prefabLoras);
    setModalPrefabSelectedPrefabs(rp.prefabSelectedPrefabs);
    setModalProgramSelectedPrograms(rp.programSelectedPrograms || []);
    setModalEnablePrefabCtx(!!rp.enablePrefabCtx);
    setModalEnableLoraCtx(!!rp.enableLoraCtx);
    setModalEnablePromptCtx(!!rp.enablePromptCtx);
    setModalCtxPrefabGuids([...(rp.ctxPrefabGuids || [])]);
    setModalCtxLoraPaths([...(rp.ctxLoraPaths || [])]);
    setModalCtxPromptTexts([...(rp.ctxPromptTexts || [])]);
    setModalPreviewUrl(rp.previewUrl);
    setModalPreviewVisible(rp.previewVisible);
    setModalFocusX(rp.focusX);
    setModalFocusY(rp.focusY);
    setModalFocusVisible(rp.focusVisible);
    if (rp.modalData && 'programId' in rp.modalData) {
      setModal({ type: 'editProgram', data: { id: rp.modalData.programId } });
    } else {
      setModal({ type: 'editPrefab', data: rp.modalData as { lib: string; idx: number } });
    }
    tempCtx.clear();
  }, [tempCtx]);

  // ========== Sync Prefab ==========
  const syncPrefab = useCallback(async () => {
    const lib = modal?.data?.lib;
    const idx = modal?.data?.idx;
    const pfTags = selectedTags.map(g => ({ ...g, tags: g.tags.map(t => ({...t})) }));
    const pfLoras = buildPrefabLoras();
    const pfSelectedPrefabs = buildSelectedPrefabs();
    if (pfTags.length === 0 && !customPrompts && pfLoras.length === 0 && pfSelectedPrefabs.length === 0) { alert('No tags, custom_prompts, loras or selected_prefabs to sync'); return; }
    const targetGuid = allLibraries[lib]?.prefabs?.[idx ?? -1]?.guid || null;
    const cycle = checkPrefabCycle(targetGuid, pfSelectedPrefabs);
    if (cycle) { setErrorModal({ title: 'Circular Dependency', message: cycle }); return; }
    try {
      const res = await fetch('/update_library_prefab', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({library:lib, prefab_index:idx, prefab_name:modalName.trim(), prefab_tags:pfTags, custom_prompts:customPrompts, loras:pfLoras, selected_prefabs:pfSelectedPrefabs}) });
      const result = await res.json();
      closeModal();
      setAllLibraries((prev: AllLibraries) => {
        const libData = prev[lib];
        if (!libData || !libData.prefabs || idx === undefined || idx < 0 || idx >= libData.prefabs.length) return prev;
        const updatedPrefab: PrefabData = { ...libData.prefabs[idx], name: modalName.trim(), tag_groups: pfTags, custom_prompts: customPrompts, loras: pfLoras, selected_prefabs: pfSelectedPrefabs };
        if (result && result.preview) updatedPrefab.preview = result.preview;
        const prefabs = [...libData.prefabs];
        prefabs[idx] = updatedPrefab;
        return { ...prev, [lib]: { ...libData, prefabs } };
      });
    } catch(e) { console.error(e); }
  }, [closeModal, modalName, selectedTags, customPrompts, buildPrefabLoras, buildSelectedPrefabs, checkPrefabCycle, modal?.data?.lib, modal?.data?.idx, setAllLibraries]);

  // ========== Delete Prefab ==========
  const deletePrefab = useCallback(async (lib: string, idx: number) => {
    if (!confirm('Delete this prefab?')) return;
    const targetGuid = allLibraries[lib]?.prefabs?.[idx]?.guid;
    try {
      const r = await fetch('/delete_library_prefab', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({library:lib,prefab_index:idx}) });
      if (!r.ok) return;
      setAllLibraries((prev: AllLibraries) => {
        const libData = prev[lib];
        if (!libData || !libData.prefabs) return prev;
        const next = { ...prev, [lib]: { ...libData, prefabs: libData.prefabs.filter((_: any, i: number) => i !== idx) } };
        return next;
      });
      if (targetGuid) {
        setSelectedPrefabs(prev => prev.filter(p => p.guid !== targetGuid));
      }
    } catch(e) { console.error(e); }
  }, [setAllLibraries, allLibraries, setSelectedPrefabs]);

  // ========== DRAG & DROP (vanilla JS init on render) ==========
  const initDragAndDrop = useCallback(() => {
    if (dragDropController) dragDropController.abort();
    dragDropController = new AbortController();
    const signal = dragDropController.signal;

    const clearDragStyles = () => {
      document.querySelectorAll('.dragging, .drag-over').forEach(el => el.classList.remove('dragging', 'drag-over'));
    };
    const dropZoneClean = () => {
      document.querySelectorAll('.drop-zone-active').forEach(el => el.classList.remove('drop-zone-active'));
    };
    const resetState = () => {
      isDragging = false;
      clearDragStyles();
      dropZoneClean();
      dragState.type = null; dragState.item = null; dragState.category = null;
      dragState.element = null; dragState.library = null; dragState.index = null;
    };

    // ========== DRAG START (capture phase on drag-handles) ==========
    const dragHandles = document.querySelectorAll('.drag-handle');
    dragHandles.forEach(h => (h as HTMLElement).draggable = true);
    console.log('[D&D] initDragAndDrop, drag handles found:', dragHandles.length);
    document.addEventListener('dragstart', (e: Event) => {
      const h = (e.target as HTMLElement).closest('.drag-handle') as HTMLElement;
      console.log('[D&D] dragstart, target:', e.target, 'h:', h, 'h.draggable:', h?.draggable);
      if (!h || !h.draggable) return;
      const ev = e as DragEvent;
      isDragging = true;
      if (zoomTimer) { clearTimeout(zoomTimer); zoomTimer = null; }
      if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
      if (currentZoomItem) { currentZoomItem.classList.remove('zoom-view'); currentZoomItem = null; }
      ev.dataTransfer!.effectAllowed = 'move';

      const dtype = h.dataset.dragType!;
      dragState.type = dtype as any;
      if (dtype === 'category') {
        ev.dataTransfer!.setData('text/plain', h.dataset.category!);
        dragState.item = h.dataset.category!;
        const cd = document.getElementById(`category-${h.dataset.category}`);
        if (cd) { dragState.element = cd; cd.classList.add('dragging'); }
      } else if (dtype === 'library') {
        ev.dataTransfer!.setData('text/plain', h.dataset.library!);
        dragState.item = h.dataset.library!;
        const ld = document.getElementById(`library-${h.dataset.library}`);
        if (ld) { dragState.element = ld; ld.classList.add('dragging'); }
      } else if (dtype === 'prompt') {
        ev.dataTransfer!.setData('text/plain', h.dataset.id!);
        dragState.item = h.dataset.id!;
        dragState.category = h.dataset.category!;
        const pi = h.closest('.prompt-item');
        if (pi) { dragState.element = pi as HTMLElement; pi.classList.add('dragging'); }
      } else if (dtype === 'prefab') {
        ev.dataTransfer!.setData('text/plain', h.dataset.library! + '::' + h.dataset.index!);
        dragState.item = h.dataset.library! + '::' + h.dataset.index!;
        dragState.library = h.dataset.library!;
        dragState.index = parseInt(h.dataset.index!);
        const pi = h.closest('.prompt-item');
        if (pi) { dragState.element = pi as HTMLElement; pi.classList.add('dragging'); }
      } else if (dtype === 'program') {
        ev.dataTransfer!.setData('text/plain', h.dataset.category! + '::' + h.dataset.index!);
        dragState.item = h.dataset.id!;
        dragState.category = h.dataset.category!;
        dragState.index = parseInt(h.dataset.index!);
        const pi = h.closest('.prompt-item');
        if (pi) { dragState.element = pi as HTMLElement; pi.classList.add('dragging'); }
      }
    }, { capture: true, signal });

    // ========== DRAGEND ==========
    document.addEventListener('dragend', () => resetState(), { signal });

    // ========== DRAGOVER (on containers, determine target via data attributes) ==========
    document.addEventListener('dragover', (e: Event) => {
      const ev = e as DragEvent;
      if (!isDragging) return;
      const dt = dragState.type;
      if (!dt) return;
      if (dt === 'prefab') console.log('[D&D] dragover prefab, target:', ev.target);

      const target = ev.target as HTMLElement;

      // Category header drop zone
      if (dt === 'category') {
        const header = target.closest('.category-header');
        const cat = header?.closest('.category');
        if (cat && cat.id !== `category-${dragState.item}` && !cat.classList.contains('dragging')) {
          ev.preventDefault();
          document.querySelectorAll('.category.drag-over').forEach(el => el.classList.remove('drag-over'));
          cat.classList.add('drag-over');
          return;
        }
        const addCard = target.closest('.add-category-card');
        if (addCard) { ev.preventDefault(); addCard.classList.add('drag-over'); return; }
      }

      // Library header drop zone
      if (dt === 'library') {
        const header = target.closest('.category-header');
        const lib = header?.closest('.category[id^="library-"]');
        if (lib && lib.id !== `library-${dragState.item}` && !lib.classList.contains('dragging')) {
          ev.preventDefault();
          document.querySelectorAll('.category.drag-over').forEach(el => el.classList.remove('drag-over'));
          lib.classList.add('drag-over');
          return;
        }
        const addCard = target.closest('.add-library-card');
        if (addCard) { ev.preventDefault(); addCard.classList.add('drag-over'); return; }
      }

      // Prompt/Prefab/Program drop zones
      if (dt === 'prompt' || dt === 'prefab' || dt === 'program') {
        const pi = target.closest('.prompt-item:not(.add-prompt-btn):not(.dragging)') as HTMLElement;
        if (pi) { ev.preventDefault(); pi.classList.add('drag-over'); return; }
        const addBtn = target.closest('.add-prompt-btn');
        if (addBtn) { ev.preventDefault(); addBtn.classList.add('drag-over'); return; }
      }
    }, { signal });

    // ========== DRAGLEAVE (clean hover classes) ==========
    document.addEventListener('dragleave', (e: Event) => {
      if (!isDragging) return;
      const target = e.target as HTMLElement;
      target.classList.remove('drag-over');
    }, { signal });

    // ========== DROP ==========
    document.addEventListener('drop', async (e: Event) => {
      const ev = e as DragEvent;
      if (!isDragging) return;
      ev.preventDefault();

      // Snapshot drag state before reset
      const snapType = dragState.type;
      const snapItem = dragState.item;
      const snapCategory = dragState.category;
      const snapLibrary = dragState.library;
      const snapIndex = dragState.index;
      resetState();

      if (!snapType) return;

      const target = ev.target as HTMLElement;

      // === Category drop ===
      if (snapType === 'category') {
        const header = target.closest('.category-header');
        const cat = header?.closest('.category');
        if (cat) {
          const tc = cat.id.replace('category-', '');
          if (tc && snapItem !== tc) {
            setAllPrompts((prev: AllPrompts) => {
              const keys = Object.keys(prev);
              const fromIdx = keys.indexOf(snapItem!);
              const toIdx = keys.indexOf(tc);
              if (fromIdx === -1 || toIdx === -1) return prev;
              keys.splice(fromIdx, 1);
              keys.splice(toIdx, 0, snapItem!);
              const next: AllPrompts = {};
              for (const k of keys) next[k] = prev[k];
              return next;
            });
            categoryGroup.reorder(snapItem!, tc, 'at').catch(console.error);
          }
          return;
        }
        const addCard = target.closest('.add-category-card');
        if (addCard && snapItem) {
          setAllPrompts((prev: AllPrompts) => {
            const keys = Object.keys(prev);
            const fromIdx = keys.indexOf(snapItem!);
            if (fromIdx === -1 || fromIdx === keys.length - 1) return prev;
            keys.splice(fromIdx, 1);
            keys.push(snapItem!);
            const next: AllPrompts = {};
            for (const k of keys) next[k] = prev[k];
            return next;
          });
          categoryGroup.reorder(snapItem!, '' as never as string, 'end').catch(console.error);
        }
        return;
      }

      // === Library drop ===
      if (snapType === 'library') {
        const header = target.closest('.category-header');
        const lib = header?.closest('.category[id^="library-"]');
        if (lib) {
          const tl = lib.id.replace('library-', '');
          if (tl && snapItem !== tl) {
            setAllLibraries((prev: AllLibraries) => {
              const keys = Object.keys(prev);
              const fromIdx = keys.indexOf(snapItem!);
              const toIdx = keys.indexOf(tl);
              if (fromIdx === -1 || toIdx === -1) return prev;
              keys.splice(fromIdx, 1);
              keys.splice(toIdx, 0, snapItem!);
              const next: AllLibraries = {};
              for (const k of keys) next[k] = prev[k];
              return next;
            });
            libraryGroup.reorder(snapItem!, tl, 'at').catch(console.error);
          }
          return;
        }
        const addCard = target.closest('.add-library-card');
        if (addCard && snapItem) {
          setAllLibraries((prev: AllLibraries) => {
            const keys = Object.keys(prev);
            const fromIdx = keys.indexOf(snapItem!);
            if (fromIdx === -1 || fromIdx === keys.length - 1) return prev;
            keys.splice(fromIdx, 1);
            keys.push(snapItem!);
            const next: AllLibraries = {};
            for (const k of keys) next[k] = prev[k];
            return next;
          });
          libraryGroup.reorder(snapItem!, '' as never as string, 'end').catch(console.error);
        }
        return;
      }

      // === Prompt drop ===
      if (snapType === 'prompt') {
        const pi = target.closest('.prompt-item:not(.add-prompt-btn)') as HTMLElement;
        if (pi && snapItem) {
          const tid = pi.dataset.id;
          const tcat = pi.dataset.category;
          if (tid && snapItem !== tid && snapCategory) {
            const reorderInCategory = (catName: string, fromId: string, toId: string) => {
              setAllPrompts((prev: AllPrompts) => {
                const catData = prev[catName] as CategoryData | undefined;
                if (!catData) return prev;
                const prompts = [...(catData.prompts || [])];
                const fromIdx = prompts.findIndex(p => p.id === fromId);
                const toIdx = prompts.findIndex(p => p.id === toId);
                if (fromIdx === -1 || toIdx === -1) return prev;
                const [item] = prompts.splice(fromIdx, 1);
                prompts.splice(toIdx, 0, item);
                return { ...prev, [catName]: { ...catData, prompts } };
              });
            };

            if (snapCategory === tcat) {
              reorderInCategory(tcat, snapItem, tid);
              fetch('/reorder_prompts', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ category: snapCategory, from_id: snapItem, to_id: tid, position: 'at' }),
              }).catch(console.error);
            } else {
              const moveAcrossCategory = (fromCat: string, toCat: string, promptId: string) => {
                setAllPrompts((prev: AllPrompts) => {
                  const fromData = prev[fromCat] as CategoryData | undefined;
                  const toData = prev[toCat] as CategoryData | undefined;
                  if (!fromData || !toData) return prev;
                  const fromPrompts = [...(fromData.prompts || [])];
                  const pIdx = fromPrompts.findIndex(p => p.id === promptId);
                  if (pIdx === -1) return prev;
                  const [moved] = fromPrompts.splice(pIdx, 1);
                  if (!fromPrompts.length && fromCat !== toCat) {
                    const next = { ...prev };
                    delete next[fromCat];
                    return { ...next, [toCat]: { ...toData, prompts: [...(toData.prompts || []), moved] } };
                  }
                  return { ...prev, [fromCat]: { ...fromData, prompts: fromPrompts }, [toCat]: { ...toData, prompts: [...(toData.prompts || []), moved] } };
                });
              };
              moveAcrossCategory(snapCategory!, tcat!, snapItem);
              fetch('/move_prompt_to_category', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ from_category: snapCategory, to_category: tcat, prompt_id: snapItem, insert_position: tid }),
              }).catch(console.error);
            }
          }
          return;
        }
        const addBtn = target.closest('.add-prompt-btn') as HTMLElement;
        if (addBtn && snapItem) {
          const tcat = addBtn.dataset.category;
          if (tcat && snapCategory) {
            if (snapCategory === tcat) {
              setAllPrompts((prev: AllPrompts) => {
                const catData = prev[tcat] as CategoryData | undefined;
                if (!catData) return prev;
                const prompts = [...(catData.prompts || [])];
                const fromIdx = prompts.findIndex(p => p.id === snapItem);
                if (fromIdx === -1) return prev;
                const [item] = prompts.splice(fromIdx, 1);
                prompts.push(item);
                return { ...prev, [tcat]: { ...catData, prompts } };
              });
              fetch('/reorder_prompts', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ category: tcat, from_id: snapItem, to_id: '', position: 'end' }),
              }).catch(console.error);
            } else {
              setAllPrompts((prev: AllPrompts) => {
                const fromData = prev[snapCategory!] as CategoryData | undefined;
                const toData = prev[tcat] as CategoryData | undefined;
                if (!fromData || !toData) return prev;
                const fromPrompts = [...(fromData.prompts || [])];
                const pIdx = fromPrompts.findIndex(p => p.id === snapItem);
                if (pIdx === -1) return prev;
                const [moved] = fromPrompts.splice(pIdx, 1);
                if (!fromPrompts.length && snapCategory !== tcat) {
                  const next = { ...prev };
                  delete next[snapCategory!];
                  return { ...next, [tcat]: { ...toData, prompts: [...(toData.prompts || []), moved] } };
                }
                return { ...prev, [snapCategory!]: { ...fromData, prompts: fromPrompts }, [tcat]: { ...toData, prompts: [...(toData.prompts || []), moved] } };
              });
              fetch('/move_prompt_to_category', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ from_category: snapCategory, to_category: tcat, prompt_id: snapItem, insert_position: 'end' }),
              }).catch(console.error);
            }
          }
        }
        return;
      }

      // === Prefab drop ===
      if (snapType === 'prefab') {
        const pi = target.closest('.prompt-item[data-prefab]:not(.add-prompt-btn)') as HTMLElement;
        if (pi && snapLibrary != null && snapIndex != null) {
          const tl = pi.dataset.library;
          const ti = parseInt(pi.dataset.prefabIndex!);
          if (tl && !isNaN(ti) && snapLibrary === tl) {
            // Optimistic local reorder within same library
            setAllLibraries((prev: AllLibraries) => {
              const lib = prev[tl];
              if (!lib) return prev;
              const prefabs = [...(lib.prefabs || [])];
              if (snapIndex < 0 || snapIndex >= prefabs.length) return prev;
              const [moved] = prefabs.splice(snapIndex, 1);
              const insertAt = ti >= prefabs.length ? prefabs.length : ti;
              prefabs.splice(insertAt, 0, moved);
              return { ...prev, [tl]: { ...lib, prefabs } };
            });
            fetch('/reorder_library_prefabs', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ library: tl, from_index: snapIndex, to_index: ti }),
            }).catch(console.error);
          } else if (tl && snapLibrary !== tl) {
            // Optimistic local move across libraries
            setAllLibraries((prev: AllLibraries) => {
              const fromLib = prev[snapLibrary];
              const toLib = prev[tl];
              if (!fromLib || !toLib) return prev;
              const fromPrefabs = [...(fromLib.prefabs || [])];
              if (snapIndex < 0 || snapIndex >= fromPrefabs.length) return prev;
              const [moved] = fromPrefabs.splice(snapIndex, 1);
              const toPrefabs = [...(toLib.prefabs || [])];
              const insertAt = ti >= 0 && ti <= toPrefabs.length ? ti : toPrefabs.length;
              toPrefabs.splice(insertAt, 0, moved);
              return {
                ...prev,
                [snapLibrary]: { ...fromLib, prefabs: fromPrefabs },
                [tl]: { ...toLib, prefabs: toPrefabs },
              };
            });
            fetch('/move_prefab_to_library', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ from_library: snapLibrary, to_library: tl, from_index: snapIndex, to_index: ti }),
            }).catch(console.error);
          }
          return;
        }
        const addBtn = target.closest('.add-prompt-btn') as HTMLElement;
        if (addBtn && snapLibrary != null && snapIndex != null) {
          const tl = addBtn.dataset.library;
          if (tl && snapLibrary === tl) {
            // Optimistic local reorder to end
            setAllLibraries((prev: AllLibraries) => {
              const lib = prev[tl];
              if (!lib) return prev;
              const prefabs = [...(lib.prefabs || [])];
              if (snapIndex < 0 || snapIndex >= prefabs.length) return prev;
              const [moved] = prefabs.splice(snapIndex, 1);
              prefabs.push(moved);
              return { ...prev, [tl]: { ...lib, prefabs } };
            });
            fetch('/reorder_library_prefabs', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ library: tl, from_index: snapIndex, to_index: -1 }),
            }).catch(console.error);
          } else if (tl && snapLibrary !== tl) {
            // Optimistic local move to end of other library
            setAllLibraries((prev: AllLibraries) => {
              const fromLib = prev[snapLibrary];
              const toLib = prev[tl];
              if (!fromLib || !toLib) return prev;
              const fromPrefabs = [...(fromLib.prefabs || [])];
              if (snapIndex < 0 || snapIndex >= fromPrefabs.length) return prev;
              const [moved] = fromPrefabs.splice(snapIndex, 1);
              const toPrefabs = [...(toLib.prefabs || []), moved];
              return {
                ...prev,
                [snapLibrary]: { ...fromLib, prefabs: fromPrefabs },
                [tl]: { ...toLib, prefabs: toPrefabs },
              };
            });
            fetch('/move_prefab_to_library', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ from_library: snapLibrary, to_library: tl, from_index: snapIndex, to_index: -1 }),
            }).catch(console.error);
          }
        }
      }

      // === Program drop ===
      if (snapType === 'program') {
        const pi = target.closest('.prompt-item[data-program]:not(.add-prompt-btn)') as HTMLElement;
        if (pi && snapCategory != null && snapIndex != null) {
          const tc = pi.dataset.category;
          const ti = parseInt(pi.dataset.programIndex!);
          if (tc && !isNaN(ti) && snapCategory === tc) {
            // Reorder within same program category
            setAllPrograms((prev: AllPrograms) => {
              const catData = prev[tc];
              if (!catData) return prev;
              const programs = [...(catData.programs || [])];
              if (snapIndex < 0 || snapIndex >= programs.length) return prev;
              const [moved] = programs.splice(snapIndex, 1);
              const insertAt = ti >= programs.length ? programs.length : ti;
              programs.splice(insertAt, 0, moved);
              return { ...prev, [tc]: { ...catData, programs } };
            });
            fetch('/reorder_programs', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ category: tc, from: snapIndex, to: ti }),
            }).catch(console.error);
          } else if (tc && !isNaN(ti) && snapCategory !== tc) {
            // Move across categories
            setAllPrograms((prev: AllPrograms) => {
              const fromCatData = prev[snapCategory];
              const toCatData = prev[tc];
              if (!fromCatData || !toCatData) return prev;
              const fromPrograms = [...(fromCatData.programs || [])];
              if (snapIndex < 0 || snapIndex >= fromPrograms.length) return prev;
              const [moved] = fromPrograms.splice(snapIndex, 1);
              const toPrograms = [...(toCatData.programs || [])];
              const insertAt = ti >= 0 && ti <= toPrograms.length ? ti : toPrograms.length;
              toPrograms.splice(insertAt, 0, moved);
              return {
                ...prev,
                [snapCategory]: { ...fromCatData, programs: fromPrograms },
                [tc]: { ...toCatData, programs: toPrograms },
              };
            });
            fetch('/move_program_to_category', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ from_category: snapCategory, to_category: tc, from_index: snapIndex, to_index: ti }),
            }).catch(console.error);
          }
          return;
        }
        const addBtn = target.closest('.add-prompt-btn[data-category]') as HTMLElement;
        if (addBtn && snapCategory != null && snapIndex != null) {
          const tc = addBtn.dataset.category;
          if (tc && snapCategory === tc) {
            // Reorder to end of same category
            setAllPrograms((prev: AllPrograms) => {
              const catData = prev[tc];
              if (!catData) return prev;
              const programs = [...(catData.programs || [])];
              if (snapIndex < 0 || snapIndex >= programs.length) return prev;
              const [moved] = programs.splice(snapIndex, 1);
              programs.push(moved);
              return { ...prev, [tc]: { ...catData, programs } };
            });
            fetch('/reorder_programs', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ category: tc, from: snapIndex, to: -1 }),
            }).catch(console.error);
          } else if (tc && snapCategory !== tc) {
            // Move to end of other category
            setAllPrograms((prev: AllPrograms) => {
              const fromCatData = prev[snapCategory];
              const toCatData = prev[tc];
              if (!fromCatData || !toCatData) return prev;
              const fromPrograms = [...(fromCatData.programs || [])];
              if (snapIndex < 0 || snapIndex >= fromPrograms.length) return prev;
              const [moved] = fromPrograms.splice(snapIndex, 1);
              const toPrograms = [...(toCatData.programs || []), moved];
              return {
                ...prev,
                [snapCategory]: { ...fromCatData, programs: fromPrograms },
                [tc]: { ...toCatData, programs: toPrograms },
              };
            });
            fetch('/move_program_to_category', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ from_category: snapCategory, to_category: tc, from_index: snapIndex, to_index: -1 }),
            }).catch(console.error);
          }
        }
      }
    }, { signal });
  }, [setAllPrompts, setAllLibraries, setAllPrograms]);

  // ========== ZOOM VIEW (vanilla JS) ==========
  const initZoomView = useCallback(() => {
    const handleMouseOver = (e: MouseEvent) => {
      if (isDragging) return;
      if (document.querySelector('.modal.visible')) return;
      const target = e.target as HTMLElement;
      if (target.closest('.actions, .action-btn, .drag-handle, .selected-card-delete')) return;
      const pi = target.closest('.prompt-item:not(.add-prompt-btn)') as HTMLElement;

      // 先取消任何离场定时器（防子元素切换抖动）
      if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }

      if (!pi) {
        // 鼠标不在任何 prompt-item 上，但可能还在已放大项区域内
        if (currentZoomItem) {
          const zr = currentZoomItem.getBoundingClientRect();
          if (e.clientX >= zr.left && e.clientX <= zr.right && e.clientY >= zr.top && e.clientY <= zr.bottom) return;
          // 确实离开了，100ms 后收起
          leaveTimer = setTimeout(() => {
            if (zoomTimer) { clearTimeout(zoomTimer); zoomTimer = null; }
            if (currentZoomItem!.classList.contains('zoom-view')) {
              currentZoomItem!.classList.remove('zoom-view');
              currentZoomItem!.classList.add('zoom-exit');
              const old = currentZoomItem!;
              currentZoomItem = null;
              setTimeout(() => { old.classList.remove('zoom-exit'); }, 300);
            } else {
              currentZoomItem = null;
            }
          }, 100);
        }
        if (zoomTimer) { clearTimeout(zoomTimer); zoomTimer = null; }
        return;
      }

      if (pi === currentZoomItem) return;

      const img = pi.querySelector('.image-layer img') as HTMLImageElement;
      if (!img || !img.naturalWidth) return;

      // 收起旧的已放大项（仅当它真正放了 zoom-view）
      if (currentZoomItem && currentZoomItem.classList.contains('zoom-view')) {
        currentZoomItem.classList.remove('zoom-view');
        currentZoomItem.classList.add('zoom-exit');
        const old = currentZoomItem;
        setTimeout(() => { old.classList.remove('zoom-exit'); }, 300);
      }

      if (zoomTimer) { clearTimeout(zoomTimer); zoomTimer = null; }
      currentZoomItem = pi;

      zoomTimer = setTimeout(() => {
        if (isDragging || document.querySelector('.modal.visible')) return;
        const imgW = img.naturalWidth;
        const imgH = img.naturalHeight;
        const targetPx = 750 * 750;
        const scale = Math.sqrt(targetPx / (imgW * imgH));
        const zw = imgW * scale;
        const zh = imgH * scale;
        pi.style.setProperty('--zoom-width', zw + 'px');
        pi.style.setProperty('--zoom-height', zh + 'px');

        const rect = pi.getBoundingClientRect();
        const margin = 20;
        let ox = 0, oy = 0;
        if (rect.left + zw > window.innerWidth - margin) ox = window.innerWidth - margin - zw - rect.left;
        if (rect.left + ox < margin) ox = margin - rect.left;
        if (rect.top + zh > window.innerHeight - margin) oy = window.innerHeight - margin - zh - rect.top;
        if (rect.top + oy < margin) oy = margin - rect.top;
        if (ox !== 0 || oy !== 0) {
          pi.style.setProperty('--zoom-offset-x', ox + 'px');
          pi.style.setProperty('--zoom-offset-y', oy + 'px');
        }
        pi.classList.add('zoom-view');
      }, ZOOM_DELAY);
    };

    document.removeEventListener('mouseover', handleMouseOver);
    document.addEventListener('mouseover', handleMouseOver);

    // 全局监听 mousemove 来检测真正离开（而不是依赖 mouseout）
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging || !currentZoomItem) return;
      const zr = currentZoomItem.getBoundingClientRect();
      if (e.clientX >= zr.left && e.clientX <= zr.right && e.clientY >= zr.top && e.clientY <= zr.bottom) {
        if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
        return;
      }
      if (!leaveTimer) {
        leaveTimer = setTimeout(() => {
          if (zoomTimer) { clearTimeout(zoomTimer); zoomTimer = null; }
          if (currentZoomItem && currentZoomItem.classList.contains('zoom-view')) {
            currentZoomItem.classList.remove('zoom-view');
            currentZoomItem.classList.add('zoom-exit');
            const old = currentZoomItem;
            currentZoomItem = null;
            setTimeout(() => { old.classList.remove('zoom-exit'); }, 300);
          } else {
            currentZoomItem = null;
          }
        }, 150);
      }
    };
    document.removeEventListener('mousemove', handleMouseMove);
    document.addEventListener('mousemove', handleMouseMove);
  }, []);

  // ========== BACKGROUND ANIMATION ==========
  const initBgAnimation = useCallback(() => {
    if (bgAnimRunningRef.current) return;
    bgAnimRunningRef.current = true;
    mouseRef.current = { x: 0, y: 0 };
    shakeRef.current = { ox: 0, oy: 0, tx: 0, ty: 0, lt: Date.now() };

    const onMouseMove = (e: MouseEvent) => { mouseRef.current = { x: e.clientX, y: e.clientY }; };
    document.removeEventListener('mousemove', onMouseMove);
    document.addEventListener('mousemove', onMouseMove);

    function animateBg() {
      const now = Date.now();
      const dt = (now - shakeRef.current.lt) / 1000;
      shakeRef.current.lt = now;

      if (Math.random() < 0.02) {
        shakeRef.current.tx = (Math.random() - 0.5) * 4;
        shakeRef.current.ty = (Math.random() - 0.5) * 4;
      }
      const lf = 0.05;
      shakeRef.current.ox += (shakeRef.current.tx - shakeRef.current.ox) * lf;
      shakeRef.current.oy += (shakeRef.current.ty - shakeRef.current.oy) * lf;

      document.querySelectorAll('.category-background-mask').forEach(mask => {
        const cat = mask.closest('.category') as HTMLElement;
        if (!cat) return;
        const rect = cat.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = (mouseRef.current.x - cx) / rect.width;
        const dy = (mouseRef.current.y - cy) / rect.height;
        const bg = mask.querySelector('.category-background') as HTMLElement;
        if (!bg) return;

        const maskW = mask.clientWidth;
        const maskH = mask.clientHeight;
        const bgW = parseFloat(getComputedStyle(bg).width) || maskW * 1.2;
        const bgH = parseFloat(getComputedStyle(bg).height) || maskH * 1.2;
        const maxX = Math.max(0, (bgW - maskW) * 0.5);
        const maxY = Math.max(0, (bgH - maskH) * 0.5);
        const sens = 0.05;
        const tx = dx * maxX * sens + shakeRef.current.ox;
        const ty = dy * maxY * sens + shakeRef.current.oy;
        const decayX = Math.tanh(tx / (maxX || 1)) * maxX;
        const decayY = Math.tanh(ty / (maxY || 1)) * maxY;

        const catName = cat.id.replace('category-', '').replace('library-', '').replace('application-', '');
        const base = bgBaseRef.current[catName];
        const fx = base ? decayX + base.x : decayX;
        const fy = base ? decayY + base.y : decayY;
        bg.style.setProperty('--bg-x', `${fx}px`);
        bg.style.setProperty('--bg-y', `${fy}px`);
      });
      requestAnimationFrame(animateBg);
    }
    requestAnimationFrame(animateBg);
  }, []);

  // ========== BG Scale on render ==========
  const initBgScales = useCallback(() => {
    document.querySelectorAll('.category-background-mask .category-background').forEach(bg => {
      const el = bg as HTMLElement;
      const mask = el.parentElement;
      if (!mask) return;
      const img = el.style.backgroundImage;
      const url = img.match(/url\(["']?([^"')]+)["']?\)/);
      if (!url) return;
      const imgPath = url[1];

      const imgEl = new Image();
      imgEl.onload = () => {
        const mw = mask.clientWidth;
        const mh = mask.clientHeight;
        const iw = imgEl.naturalWidth;
        const ih = imgEl.naturalHeight;
        if (!iw || !ih || !mw || !mh) return;
        const key = imgPath.replace(/^.*\/images\//, '');
        bgSizesRef.current[key] = { w: iw, h: ih };
        const scale = Math.max((mw * 1.2) / iw, (mh * 1.2) / ih);
        el.style.setProperty('--bg-width', `${iw * scale}px`);
        el.style.setProperty('--bg-height', `${ih * scale}px`);

        const catEl = mask.closest('.category') as HTMLElement;
        const catName = catEl ? catEl.id.replace('category-', '').replace('library-', '').replace('application-', '') : '';
        if (catName) applyBgFocus(el, key, catName);
      };
      imgEl.src = imgPath;
    });

    // Handle video backgrounds
    document.querySelectorAll('.category-background-mask .category-background-video').forEach(videoEl => {
      const el = videoEl as HTMLVideoElement;
      const mask = el.parentElement;
      if (!mask) return;
      el.addEventListener('loadedmetadata', () => {
        const mw = mask.clientWidth;
        const mh = mask.clientHeight;
        const iw = el.videoWidth;
        const ih = el.videoHeight;
        if (!iw || !ih || !mw || !mh) return;
        const scale = Math.max((mw * 1.2) / iw, (mh * 1.2) / ih);
        el.style.setProperty('--bg-width', `${iw * scale}px`);
        el.style.setProperty('--bg-height', `${ih * scale}px`);
      }, { once: true });
      // Trigger load if already loaded
      if (el.readyState >= 2) {
        el.dispatchEvent(new Event('loadedmetadata'));
      }
    });
  }, []);

  const applyBgFocus = useCallback((bg: HTMLElement, key: string, name: string) => {
    const pt = categoryFocusRef.current[name];
    const sizes = bgSizesRef.current[key];
    if (!pt || !sizes) { delete bgBaseRef.current[name]; return; }

    const bw = parseFloat(bg.style.getPropertyValue('--bg-width')) || bg.clientWidth;
    const bh = parseFloat(bg.style.getPropertyValue('--bg-height')) || bg.clientHeight;
    if (!bw || !bh) return;

    const ox = bw * (0.5 - pt.x / 100);
    const oy = bh * (0.5 - pt.y / 100);
    const mask = bg.parentElement!;
    const mw = mask.clientWidth;
    const mh = mask.clientHeight;
    const mx = Math.max(0, (bw - mw) * 0.5);
    const my = Math.max(0, (bh - mh) * 0.5);
    const cx = Math.max(-mx, Math.min(mx, ox));
    const cy = Math.max(-my, Math.min(my, oy));
    bgBaseRef.current[name] = { x: cx, y: cy };
  }, []);

  // ========== ZOOM RESTORE after re-render ==========
  useEffect(() => {
    if (zoomRestoreSelector) {
      const sel = zoomRestoreSelector;
      const vars = { ...zoomRestoreVars };
      zoomRestoreSelector = null;
      zoomRestoreVars = {};
      requestAnimationFrame(() => {
        const el = document.querySelector(sel) as HTMLElement;
        if (el) {
          Object.entries(vars).forEach(([k, v]) => { if (v) el.style.setProperty(k, v); });
          el.classList.add('zoom-view');
          currentZoomItem = el;
        }
      });
    }
  }, [selectedTags, tempCtx.stack.length]);

  // ========== ALL INIT ==========
  useEffect(() => {
    initDragAndDrop();
    initBgAnimation();
    initBgScales();
    const t = setTimeout(() => {
      initZoomView();
    }, 100);
    return () => { clearTimeout(t); };
  }, [allPrompts, allLibraries, selectedTags, expandedCategories, expandedLibraries, categoryFocusPoints, tempCtx.stack.length, initDragAndDrop, initZoomView, initBgAnimation, initBgScales]);

  // ========== RENDER ==========
  const categories = Object.entries(allPrompts);
  const libraries = Object.entries(allLibraries);

  // Build duplicate prompt set
  const allPromptTexts: string[] = [];
  for (const [, catData] of categories) {
    const cp = (catData as CategoryData).prompts || [];
    for (const p of cp) { allPromptTexts.push(p.prompt); }
  }
  const duplicateSet = new Set<string>();
  const seen = new Set<string>();
  for (const pt of allPromptTexts) {
    if (seen.has(pt)) duplicateSet.add(pt);
    seen.add(pt);
  }

  return (
    <div className="app-container">
      {/* Region canvas panel — leftmost when enable_region is on */}
      {enableRegion ? (
        <div style={{ width: '50%', flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border-color)', background: '#000' }}>
          <RegionCanvas
            imageSrc={regionImage}
            canvasWidth={regionW}
            canvasHeight={regionH}
            boxes={regionBoxes}
            activeIdx={regionActiveIdx}
            bgBrightness={regionBg}
            boxOpacity={regionOpacity}
            onBoxesChange={setRegionBoxes}
            onActiveIdxChange={(idx) => { activeSlotIdRef.current = null; setActiveSlotId(null); setRegionActiveIdx(idx); }}
          />
          {/* Region control bar */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px 14px', borderTop: '0.5px solid #38383a', background: 'rgba(28,28,30,0.85)', backdropFilter: 'blur(20px)', flexShrink: 0, fontFamily: `-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif` }}>
            <style>{`
              .kolid-range { -webkit-appearance:none; appearance:none; height:4px; border-radius:2px; background:#48484a; outline:none; width:56px; }
              .kolid-range::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:14px; height:14px; border-radius:50%; background:#fff; box-shadow:0 1px 2px rgba(0,0,0,0.3); cursor:pointer; }
              .kolid-range::-moz-range-thumb { width:14px; height:14px; border-radius:50%; background:#fff; border:none; box-shadow:0 1px 2px rgba(0,0,0,0.3); cursor:pointer; }
              .kolid-range::-moz-range-track { height:4px; border-radius:2px; background:#48484a; }
            `}</style>
            {/* Row 1: BG + Fill sliders */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                <span style={{ fontSize: 11, color: '#8e8e93' }}>BG</span>
                <input type="range" className="kolid-range" min="0" max="100" step="1" value={regionBg}
                  onChange={(e) => setRegionBg(parseInt(e.target.value))} />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                <span style={{ fontSize: 11, color: '#8e8e93' }}>Fill</span>
                <input type="range" className="kolid-range" min="0" max="100" step="1" value={regionOpacity}
                  onChange={(e) => setRegionOpacity(parseInt(e.target.value))} />
              </label>
            </div>
            {/* Row 2: active region info */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 12, color: '#8e8e93' }}>
              {regionActiveIdx >= 0 ? (
                <>
                  <span style={{ color: '#0a84ff', fontWeight: 600 }}>Region {String(regionActiveIdx + 1).padStart(2, '0')}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {regionBoxes[regionActiveIdx]?.desc || '(no description)'}
                  </span>
                </>
              ) : (
                <span>No region selected — drag on canvas to draw</span>
              )}
            </div>
            {/* Context slot buttons from region_format */}
            {formatSlots.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '6px 14px', borderTop: '0.5px solid #38383a' }}>
                {formatSlots.map(slot => {
                  const isActive = slot.type === 'background'
                    ? (activeSlotId === null && regionActiveIdx < 0)
                    : (activeSlotId === slot.id);
                  return (
                  <button
                    key={slot.id}
                    onClick={() => {
                      // Save current context, then load this slot's context
                      const currentCtx: PromptContextBase = {
                        prompts: selectedTags.map(g => tagsToDisplayString(g)),
                        custom_prompts: customPrompts,
                        loras: selectedLoras.map(l => {
                          const sel = loraSelections[l.file_path];
                          return { file_path: l.file_path, name: l.name, strength: sel?.strength ?? 1.0, active_tags: sel?.activeTags ?? [], active: sel?.active ?? true, split_mode: sel?.split_mode };
                        }),
                        prefabs: selectedPrefabs.map(p => ({ guid: p.guid, active: p.active, tag_groups: p.tag_groups, loras: p.loras, children: p.children })),
                        label: slot.label,
                      };
                      // Save to current slot/region/background
                      if (activeSlotIdRef.current) {
                        formatSlotContextsRef.current.set(activeSlotIdRef.current, currentCtx);
                      } else if (regionActiveRef.current >= 0) {
                        const nbs = [...regionBoxesRef.current];
                        nbs[regionActiveRef.current] = { ...nbs[regionActiveRef.current], promptContext: currentCtx };
                        regionBoxesRef.current = nbs;
                        setRegionBoxes(nbs);
                      } else {
                        backgroundContextRef.current = { ...currentCtx, isBackground: true };
                      }
                      // Load target slot
                      const targetCtx = slot.type === 'background'
                        ? backgroundContextRef.current
                        : formatSlotContextsRef.current.get(slot.id);
                      // For background slot, clear activeSlotId; otherwise set it
                      // Update ref immediately to prevent live-store from writing to wrong slot
                      const newSlotId = slot.type === 'background' ? null : slot.id;
                      activeSlotIdRef.current = newSlotId;
                      setActiveSlotId(newSlotId);
                      setRegionActiveIdx(-1);
                      if (targetCtx) {
                        isRegionReloadingRef.current = true;
                        fetch('/switch_context', {
                          method: 'POST', headers: {'Content-Type':'application/json'},
                          body: JSON.stringify(targetCtx),
                        }).then(async () => {
                          loraRestoredRef.current = false;
                          prefabRestoredRef.current = false;
                          // Pre-restore loraSelections from targetCtx so Lora components
                          // get correct initialActiveTags on mount (prevents "all tags active" default)
                          const preSel: Record<string, any> = {};
                          for (const l of (targetCtx.loras || [])) {
                            const fp = (l as any).file_path || (l as any).file_name || '';
                            if (fp) preSel[fp] = {
                              activeTags: l.active_tags || [],
                              strength: l.strength ?? 1.0,
                              active: l.active ?? true,
                              split_mode: l.split_mode,
                            };
                          }
                          setSelectedLoras([]);
                          setLoraSelections(preSel);
                          setSelectedPrefabs([]);
                          setSelectedTags([]);
                          setCustomPrompts('');
                          await Promise.all([loadData(), loadLoraData()]);
                          isRegionReloadingRef.current = false;
                        }).catch(() => { isRegionReloadingRef.current = false; });
                      }
                    }}
                    style={{
                      padding: '4px 10px', borderRadius: '8px', border: 'none', cursor: 'pointer',
                      background: isActive ? '#0a84ff' : '#2c2c2e',
                      color: isActive ? '#fff' : '#8e8e93',
                      fontSize: 12, fontFamily: `-apple-system, BlinkMacSystemFont, sans-serif`,
                    }}
                  >
                    {slot.label}
                  </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}

      <div className="main-wrapper">
        <div className="scroll-container">
          <div className="container">
            <div className="header">
              <button
                className="btn btn-primary"
                onClick={handleLoadFromImageClick}
                style={{ display: 'flex', alignItems: 'center', fontSize: '16px', fontWeight: 'bold', padding: '8px 16px', border: 'none', borderRadius: '8px', cursor: 'pointer', background: 'var(--accent-color, #0a84ff)', color: '#fff' }}
              >
                {iconLoadFromImage} Load From Image
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg"
                style={{ display: 'none' }}
                onChange={handleImageSelected}
              />
              <SearchBar
                searchQuery={searchQuery}
                onSearchChange={handleSearch}
                filterOptions={allFilterOptions}
                selectedFilter={selectedFilter}
                onFilterChange={handleFilterChange}
              />
            </div>

            {tempCtx.mode === 'tag' && currentCtx ? (
              <div className="temporary-banner">
                <span>{currentCtx.title}</span>
                <div>
                  {tempCtx.stack.length > 1 && <button className="btn btn-warning" onClick={backLayer}>{iconArrowLeft} 返回上层</button>}
                  <button className="btn btn-success" onClick={completeLayer}>直接添加</button>
                  <button className="btn btn-secondary" onClick={cancelTemporary}>取消</button>
                </div>
              </div>
            ) : null}

            {tempCtx.mode === 'lora' || tempCtx.mode === 'prefab' || tempCtx.mode === 'program' || tempCtx.mode === 'prefabCtx' || tempCtx.mode === 'loraCtx' || tempCtx.mode === 'promptCtx' ? (
              <div className="temporary-banner" style={{ background: 'linear-gradient(135deg, #007aff, #5856d6)', boxShadow: '0 4px 12px rgba(0, 122, 255, 0.3)' }}>
                <span>{tempCtx.current?.title || tempCtx.mode} ({(tempCtx.current?.selections || []).length})</span>
                <div>
                  <button className="btn btn-success" onClick={restoreModalWithSelections}>Add Selected</button>
                  <button className="btn btn-secondary" onClick={cancelMainSelection}>Cancel</button>
                </div>
              </div>
            ) : null}

            {/* ========== Lora Section ========== */}
            {(!tempCtx.mode || tempCtx.mode === 'lora' || tempCtx.mode === 'loraCtx') && Object.keys(loraData).length > 0 ? (() => {
              const regex = loraRegex ? new RegExp(loraRegex) : null;
              const filteredEntries = Object.entries(loraData).map(([folder, items]) => {
                const filteredItems = regex ? items.filter(it => regex.test(it.file_path)) : items;
                return [folder, filteredItems] as [string, LoraItemData[]];
              }).filter(([, items]) => items.length > 0);
              return filteredEntries.length > 0 ? (
                <div className="categories-container lora-section">
                  {filteredEntries.map(([folder, items]) => {
                    const folderMeta = loraFolderMeta[folder] || {};
                    return (
                    <LoraFolderCard
                      key={folder}
                      folderName={folder}
                      items={items}
                      searchQuery={searchQuery}
                      selectedLoras={selectedLoras}
                      onToggleLora={toggleLora}
                      isItemSelected={isLoraSelected}
                      bgImage={folderMeta.bg_image}
                      bgVideo={folderMeta.bg_video}
                      videoVolume={videoVolumes[folder] || 0}
                      clarityPoints={clarityPoints[folder]}
                      imgUrl={imgUrl}
                      onEdit={() => {
                        resetModalForm();
                        const meta = loraFolderMeta[folder] || {};
                        setModalOldName(folder);
                        setModalName(folder);
                        const bg = meta.bg_image || '';
                        const bgVid = meta.bg_video || '';
                        if (bgVid) {
                          setModalVideoUrl(imgUrl(bgVid));
                          setModalPreviewVisible(true);
                          setModalFileName(bgVid);
                          setModalVideoVolume(videoVolumes[folder] ?? 0);
                          setModalClarityPoints(clarityPoints[folder] ? [...clarityPoints[folder]] : []);
                        } else if (bg) {
                          setModalPreviewUrl(imgUrl(bg));
                          setModalPreviewVisible(true);
                          setModalFileName(bg);
                          setModalClarityPoints(clarityPoints[folder] ? [...clarityPoints[folder]] : []);
                        }
                        setModal({ type: 'editLoraFolder', data: { folder } });
                      }}
                    />
                    );
                  })}
                </div>
              ) : null;
            })() : null}

            {(!tempCtx.mode || tempCtx.mode === 'promptCtx') ? (
            <div className="categories-container prompt-section" id="categories">
              {categories.map(([cat, catData]) => {
                const cp = catData.prompts as PromptData[] || [];
                const catDeco = (catData.decorations as string[]) || [];
                const catTags = (catData.tags as string[]) || [];
                const expanded = expandedCategories.has(cat);
                const anim = animating.has(cat);
                const displayMode = categoryDisplay.getMode(cat, categoryDisplayModes, allLibraries);
                const sizeMode = categoryDisplay.getSize(cat, categorySizeModes, allLibraries);
                const isMiniMode = sizeMode === 'mini';
                const modeClass = isMiniMode ? 'mini-mode' : 'normal-mode';
                const bgImage = catData.bg_image || '';
                const bgVideo = (catData as any).bg_video || '';

                let filtered = cp;
                const needsFilter = searchQuery || selectedFilter;
                if (isTemporary && currentCtx && currentCtx.matchFn) {
                  filtered = cp.filter(p => currentCtx.matchFn!(p, cat));
                  if (filtered.length === 0) return null;
                } else if (needsFilter) {
                  const catDataObj = allPrompts[cat] as any;
                  const catDecos: string[] = catDataObj ? (Array.isArray(catDataObj.decorations) ? catDataObj.decorations : typeof catDataObj.decorations === 'string' ? catDataObj.decorations.split(',').map((s: string) => s.trim()).filter(Boolean) : []) : [];
                  const catTgs: string[] = catDataObj ? (Array.isArray(catDataObj.tags) ? catDataObj.tags : typeof catDataObj.tags === 'string' ? catDataObj.tags.split(',').map((s: string) => s.trim()).filter(Boolean) : []) : [];
                  filtered = cp.filter(p => {
                    if (searchQuery) {
                      const tm = Array.isArray(p.tags) ? p.tags.some((t: string) => t.toLowerCase().includes(searchQuery)) : (p.tags || '').toLowerCase().includes(searchQuery);
                      if (!p.name.toLowerCase().includes(searchQuery) && !p.prompt.toLowerCase().includes(searchQuery) && !tm) return false;
                    }
                    if (selectedFilter) {
                      const pDecos: string[] = Array.isArray(p.decorations) ? p.decorations : typeof p.decorations === 'string' ? p.decorations.split(',').map((s: string) => s.trim()).filter(Boolean) : [];
                      const pTgs: string[] = Array.isArray(p.tags) ? p.tags : typeof p.tags === 'string' ? p.tags.split(',').map((s: string) => s.trim()).filter(Boolean) : [];
                      const allCandidates = pDecos.concat(catDecos, pTgs, catTgs);
                      if (!allCandidates.some(x => x.toLowerCase() === selectedFilter.toLowerCase())) return false;
                    }
                    return true;
                  });
                  if (filtered.length === 0) return null;
                }

                const parsedCount = isTemporary ? 0 : cp.filter(p => {
                  const group = getTagGroupForPrompt(p.prompt);
                  return group && (group.source === 'parsing' || group.source === 'program');
                }).length;
                const selCount = isTemporary ? cp.filter(p => isPromptSelectedInTempCtx(p.prompt)).length : cp.filter(p => {
                  if (!isTagSelected(p.prompt)) return false;
                  const group = getTagGroupForPrompt(p.prompt);
                  return !group || group.source === 'normal';
                }).length;
                const catHasDuplicate = cp.some(p => duplicateSet.has(p.prompt));

                return (
                  <div key={cat} className={`category ${expanded ? 'expanded' : 'collapsed'}${catHasDuplicate ? ' duplicate' : ''}`} id={`category-${cat}`} onMouseMove={e => { const r = e.currentTarget.getBoundingClientRect(); const mx = e.clientX - r.left; const my = e.clientY - r.top; const pts = clarityPoints[cat] || []; const circles = pts.map(p => `<circle cx="${p.x}%" cy="${p.y}%" r="60" fill="black"/>`).join(''); const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="100%" height="100%" fill="white"/>${circles}<circle cx="${mx}" cy="${my}" r="70" fill="black"/></svg>`; const blurEl = e.currentTarget.querySelector<HTMLDivElement>('.category-background-blur'); if (blurEl) { const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`; blurEl.style.maskImage = url; blurEl.style.webkitMaskImage = url; } }}>
                    {expanded && bgVideo ? (
                      <div className="category-background-mask">
                        <video className="category-background-video" src={imgUrl(bgVideo)} muted={!(videoVolumes[cat] > 0)} loop autoPlay playsInline ref={el => { if (el) el.volume = videoVolumes[cat] || 0; }} style={categoryFocusPoints[cat] ? { objectPosition: `${categoryFocusPoints[cat].x}% ${categoryFocusPoints[cat].y}%` } : {}} />
                      </div>
                    ) : expanded && bgImage ? (
                      <div className="category-background-mask">
                        <div className="category-background" style={{ backgroundImage: `url(${imgUrl(bgImage)})`, backgroundPosition: categoryFocusPoints[cat] ? `${categoryFocusPoints[cat].x}% ${categoryFocusPoints[cat].y}%` : 'center' }} />
                      </div>
                    ) : null}
                    {expanded && (bgVideo || bgImage) ? (
                      <div className="category-background-blur" style={(() => { const pts = clarityPoints[cat]; if (!pts || pts.length === 0) return undefined; const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="100%" height="100%" fill="white"/>${pts.map(p => `<circle cx="${p.x}%" cy="${p.y}%" r="60" fill="black"/>`).join('')}</svg>`; const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`; return { maskImage: url, WebkitMaskImage: url }; })()} />
                    ) : null}
                    <div className="category-header" onMouseDown={e => { if (!(e.target as HTMLElement).closest('.drag-handle,.display-mode-btn,.edit-category-btn,.delete-category-btn,.count-badge-clear')) toggleCategory(cat); }}>
                      {!expanded && bgVideo ? <video className="bg-video" src={imgUrl(bgVideo)} muted loop autoPlay playsInline style={categoryFocusPoints[cat] ? { objectPosition: `${categoryFocusPoints[cat].x}% ${categoryFocusPoints[cat].y}%` } : {}} /> : !expanded && bgImage ? <img src={imgUrl(bgImage)} className="bg-image" alt="" style={categoryFocusPoints[cat] ? { objectPosition: `${categoryFocusPoints[cat].x}% ${categoryFocusPoints[cat].y}%` } : {}} /> : null}
                      <div className="header-content">
                        <div style={{ display:'flex', alignItems:'center' }}>
                          <span className="drag-handle" draggable data-drag-type="category" data-category={cat}>{iconGrip}</span>
                          <span style={{ textShadow:'0px 0px 4px black' }}>{cat}</span>
                        </div>
                        <div style={{ display:'flex', alignItems:'center' }}>
                          {(catTags.length > 0 || catDeco.length > 0) && <div className="decoration-tags">{catTags.map(t => <span className="decoration-tag tag" key={t}>{t}</span>)}{catDeco.map(d => <span className="decoration-tag" key={d}>{d}</span>)}</div>}
                          {selCount > 0 && <span className="count-badge">{selCount}<button className="count-badge-clear" onClick={e => { e.stopPropagation(); clearCategoryTags(cat); }}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></span>}
                          {parsedCount > 0 && <span className="count-badge parsed-count-badge">{parsedCount}<button className="count-badge-clear" onClick={e => { e.stopPropagation(); clearParsedCategoryTags(cat); }}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></span>}
                          <button className="display-mode-btn" onClick={e => { e.stopPropagation(); resetModalForm(); setModalOldName(cat); setModalMode(categoryDisplay.getMode(cat, categoryDisplayModes, allLibraries)); setModalSize(categoryDisplay.getSize(cat, categorySizeModes, allLibraries)); setModalIsCat(true); setModal({type:'displayMode',data:{name:cat,isCat:true}}); }}>{iconGrid}</button>
                          <button className="edit-category-btn" onClick={e => { e.stopPropagation(); resetModalForm(); const cd = allPrompts[cat]||{} as any; setModalOldName(cat); setModalName(cat); setModalTags(Array.isArray(cd.tags)?[...cd.tags]:[]); setModalDecorations(Array.isArray(cd.decorations)?[...cd.decorations]:[]); const bg = cd.bg_image||''; const bgVid = cd.bg_video||''; if(bgVid) { setModalVideoUrl(imgUrl(bgVid)); setModalPreviewVisible(true); setModalFileName(bgVid); setModalVideoVolume(videoVolumes[cat] ?? 0); setModalClarityPoints(clarityPoints[cat] ? [...clarityPoints[cat]] : []); const pt = categoryFocusPoints[cat]; if(pt){ setModalFocusX(pt.x); setModalFocusY(pt.y); setModalFocusVisible(true); } } else if(bg) { setModalPreviewUrl(imgUrl(bg)); setModalPreviewVisible(true); setModalFileName(bg); setModalClarityPoints(clarityPoints[cat] ? [...clarityPoints[cat]] : []); const pt = categoryFocusPoints[cat]; if(pt){ setModalFocusX(pt.x); setModalFocusY(pt.y); setModalFocusVisible(true); } } setModal({type:'editCategory',data:{name:cat}}); }}>{iconGear}</button>
                          <button className="delete-category-btn" onClick={e => { e.stopPropagation(); deleteCategoryDirect(cat); }}>{iconTrash}</button>
                          <span className="toggle">{expanded ? iconChevronUp : iconChevronDown}</span>
                        </div>
                      </div>
                    </div>
                    {expanded ? (
                      <div className={`category-content${anim ? ' animating' : ''} ${displayMode==='box'?'box-mode':''} ${isMiniMode?'mini-mode':''}`}>
                        {filtered.map(p => {
                          const pDeco = Array.isArray(p.decorations) ? p.decorations : [];
                          const pTags = Array.isArray(p.tags) ? p.tags : (p.tags ? p.tags.split(',').map((s: string) => s.trim()).filter(Boolean) : []);
                          const uDeco = pDeco.filter((d: string) => !catDeco.includes(d));
                          const sel = isTemporary ? isPromptSelectedInTempCtx(p.prompt) : isTagSelected(p.prompt);
                          const group = !isTemporary ? getTagGroupForPrompt(p.prompt) : undefined;
                          const fp = focusPoints[p.id];
                          const showSelCard = isTemporary ? isPromptSelectedInTempCtx(p.prompt) : !!group;

                          return (
                            <div key={p.id} className="prompt-item-wrapper">
                              <div className={`prompt-item ${modeClass}${sel ? ' selected' : ''}${duplicateSet.has(p.prompt) ? ' duplicate' : ''}${(() => { const g = getTagGroupForPrompt(p.prompt); return g && programResult.filter_tag_groups.some(fg => tagsToDisplayString(fg) === tagsToDisplayString(g)) ? ' program-filtered' : ''; })()}`} data-prompt={p.prompt} data-id={p.id} data-category={cat}>
                                <span className="drag-handle" draggable data-drag-type="prompt" data-id={p.id} data-category={cat}>{iconGrip}</span>
                                {(pTags.length > 0 || uDeco.length > 0 || (Array.isArray(p.mute_decorations) && p.mute_decorations.length > 0)) && <div className="decoration-tags">{pTags.map((t: string) => <span className="decoration-tag tag" key={t}>{t}</span>)}{uDeco.map((d: string) => <span className="decoration-tag" key={d}>{d}</span>)}{Array.isArray(p.mute_decorations) && p.mute_decorations.map((d: string) => <span className="decoration-tag muted" key={d}>{d}</span>)}</div>}
                                <div className="select-area" onMouseDown={() => { if (tempCtx.mode === 'promptCtx') { tempCtx.toggleId(p.prompt); } else { selectPrompt(p.prompt); } }}>
                                  <div className="image-layer">
                                    {p.preview ? <img src={imgUrl(p.preview)} alt={p.name} loading="lazy" style={fp ? { objectPosition: `${fp.x}% ${fp.y}%` } : {}} /> : <div className="no-image">No Image</div>}
                                  </div>
                                  {!isMiniMode && <div className="glass-layer" />}
                                  <div className="text-layer">
                                    <div className="name">{p.name}</div>
                                    <div className="prompt-text">{p.prompt}</div>
                                  </div>
                                </div>
                                <div className="actions" onMouseDown={e => e.stopPropagation()}>
                                  <button className="action-btn edit" onClick={e => { e.stopPropagation(); resetModalForm(); setModalOldName(p.id); setModalName(p.name); setModalPrompt(p.prompt||''); setModalTags(Array.isArray(p.tags)?[...p.tags]:[]); setModalDecorations(Array.isArray(p.decorations)?[...p.decorations]:[]); setModalMuteDecorations(Array.isArray(p.mute_decorations)?[...p.mute_decorations]:[]); setModalCategory(cat); if(p.preview){ setModalPreviewUrl(imgUrl(p.preview)); setModalPreviewVisible(true); setModalFileName(p.preview); const pt = focusPoints[p.id]; if(pt){ setModalFocusX(pt.x); setModalFocusY(pt.y); setModalFocusVisible(true); } } setModal({type:'editPrompt',data:{id:p.id,category:cat}}); }}>{iconGear}</button>
                                  <button className="action-btn delete" onClick={e => { e.stopPropagation(); deletePrompt(p.id); }}>{iconTrash}</button>
                                </div>
                              </div>
                              {showSelCard ? (
                                isTemporary && currentCtx ? (
                                  <div className="selected-card">
                                    <div className="selected-card-content">{p.name}</div>
                                    <button className="selected-card-delete" onClick={e => {
                                      e.stopPropagation();
                                      const tgIdx = currentCtx!.tagGroups!.findIndex(g => g.tags.slice(0, -1).some(t => t.prompt === p.prompt));
                                      if (tgIdx !== -1) removeTemporaryTag(tgIdx);
                                    }}>{iconX}</button>
                                  </div>
                                ) : group ? (
                                  <div className="selected-card">
                                    <div className="selected-card-content">{tagsToDisplayName(group)}</div>
                                    <button className="selected-card-delete" onClick={e => { e.stopPropagation(); setSelectedTags(prev => prev.filter((_, gi) => gi !== selectedTags.findIndex(sg => sg === group))); }}>{iconX}</button>
                                  </div>
                                ) : null
                              ) : null}
                            </div>
                          );
                        })}
                        {!(searchQuery || selectedFilter) && !isTemporary ? (
                          <div className={`prompt-item add-prompt-btn ${modeClass}`} data-category={cat} style={{ cursor:'pointer' }} onMouseDown={() => { resetModalForm(); setModalCategory(cat); setModal({type:'addPrompt'}); }}><div>{iconPlus}</div></div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              <div className="add-category-card" onMouseDown={() => { resetModalForm(); setModal({type:'addCategory'}); }}>{iconPlus}</div>
            </div>
            ) : null}

            {(!tempCtx.mode || tempCtx.mode === 'prefab' || tempCtx.mode === 'prefabCtx') ? (<div className="categories-container prefab-section">
              {libraries.map(([lib, libData]) => {
                const expanded = expandedLibraries.has(lib);
                const anim = animating.has(lib);
                const displayMode = libraryDisplay.getMode(lib, categoryDisplayModes, allLibraries);
                const sizeMode = libraryDisplay.getSize(lib, categorySizeModes, allLibraries);
                const isMiniMode = sizeMode === 'mini';
                const modeClass = isMiniMode ? 'mini-mode' : 'normal-mode';
                const bgImage = libData.bg_image || '';
                const bgVideo = (libData as any).bg_video || '';
                const pids: string[] = libData.prompt_ids || [];
                const prefabs = libData.prefabs || [];

                const prompts: (PromptData & { category: string })[] = [];
                for (const [c, cd] of Object.entries(allPrompts)) {
                  (cd.prompts as PromptData[] || []).forEach(p => { if (pids.includes(p.id)) prompts.push({ ...p, category: c }); });
                }
                let filteredPrompts = prompts;
                let filteredPrefabs = prefabs;
                // Filter out prefabs that would cause circular dependency when in prefab selection mode
                if (tempCtx.mode === 'prefab' && tempCtx.current?.restorePoint) {
                  const md = tempCtx.current.restorePoint.modalData as { lib: string; idx: number };
                  const targetGuid = allLibraries[md.lib]?.prefabs?.[md.idx]?.guid || null;
                  filteredPrefabs = prefabs.filter(pf => {
                    if (!pf.guid) return false;
                    if (tempCtx.current!.restorePoint!.prefabSelectedPrefabs.some(sp => sp.guid === pf.guid)) return false;
                    const cycle = checkPrefabCycle(targetGuid, [{ guid: pf.guid }]);
                    return !cycle;
                  });
                }
                const libNeedsFilter = searchQuery || selectedFilter;
                if (libNeedsFilter) {
                  filteredPrompts = prompts.filter(p => {
                    if (searchQuery) {
                      const tm = Array.isArray(p.tags) ? p.tags.some((t: string) => t.toLowerCase().includes(searchQuery)) : (p.tags || '').toLowerCase().includes(searchQuery);
                      if (!p.name.toLowerCase().includes(searchQuery) && !p.prompt.toLowerCase().includes(searchQuery) && !tm) return false;
                    }
                    if (selectedFilter) {
                      const catDataObj = allPrompts[p.category] as any;
                      const catDecos: string[] = catDataObj ? (Array.isArray(catDataObj.decorations) ? catDataObj.decorations : typeof catDataObj.decorations === 'string' ? catDataObj.decorations.split(',').map((s: string) => s.trim()).filter(Boolean) : []) : [];
                      const catTgs: string[] = catDataObj ? (Array.isArray(catDataObj.tags) ? catDataObj.tags : typeof catDataObj.tags === 'string' ? catDataObj.tags.split(',').map((s: string) => s.trim()).filter(Boolean) : []) : [];
                      const pDecos: string[] = Array.isArray(p.decorations) ? p.decorations : typeof p.decorations === 'string' ? p.decorations.split(',').map((s: string) => s.trim()).filter(Boolean) : [];
                      const pTgs: string[] = Array.isArray(p.tags) ? p.tags : typeof p.tags === 'string' ? p.tags.split(',').map((s: string) => s.trim()).filter(Boolean) : [];
                      const allCandidates = pDecos.concat(catDecos, pTgs, catTgs);
                      if (!allCandidates.some(x => x.toLowerCase() === selectedFilter.toLowerCase())) return false;
                    }
                    return true;
                  });
                  filteredPrefabs = prefabs.filter(pf => {
                    if (searchQuery) {
                      if (pf.name.toLowerCase().includes(searchQuery)) return true;
                      for (const group of (pf.tag_groups || [])) {
                        for (const tag of group.tags) {
                          if (tag.name.toLowerCase().includes(searchQuery) || tag.prompt.toLowerCase().includes(searchQuery)) return true;
                        }
                      }
                      return false;
                    }
                    return true;
                  });
                }
                if (libNeedsFilter && filteredPrompts.length === 0 && filteredPrefabs.length === 0) return null;

                const libHasDuplicate = prompts.some(p => duplicateSet.has(p.prompt));

                return (
                  <div key={lib} className={`category ${expanded ? 'expanded' : 'collapsed'}${libHasDuplicate ? ' duplicate' : ''}`} id={`library-${lib}`} onMouseMove={e => { const r = e.currentTarget.getBoundingClientRect(); const mx = e.clientX - r.left; const my = e.clientY - r.top; const pts = clarityPoints[lib] || []; const circles = pts.map(p => `<circle cx="${p.x}%" cy="${p.y}%" r="60" fill="black"/>`).join(''); const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="100%" height="100%" fill="white"/>${circles}<circle cx="${mx}" cy="${my}" r="70" fill="black"/></svg>`; const blurEl = e.currentTarget.querySelector<HTMLDivElement>('.category-background-blur'); if (blurEl) { const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`; blurEl.style.maskImage = url; blurEl.style.webkitMaskImage = url; } }}>
                    {expanded && bgVideo ? (
                      <div className="category-background-mask">
                        <video className="category-background-video" src={imgUrl(bgVideo)} muted={!(videoVolumes[lib] > 0)} loop autoPlay playsInline ref={el => { if (el) el.volume = videoVolumes[lib] || 0; }} style={categoryFocusPoints[lib] ? { objectPosition: `${categoryFocusPoints[lib].x}% ${categoryFocusPoints[lib].y}%` } : {}} />
                      </div>
                    ) : expanded && bgImage ? (
                      <div className="category-background-mask">
                        <div className="category-background" style={{ backgroundImage: `url(${imgUrl(bgImage)})`, backgroundPosition: categoryFocusPoints[lib] ? `${categoryFocusPoints[lib].x}% ${categoryFocusPoints[lib].y}%` : 'center' }} />
                      </div>
                    ) : null}
                    {expanded && (bgVideo || bgImage) ? (
                      <div className="category-background-blur" style={(() => { const pts = clarityPoints[lib]; if (!pts || pts.length === 0) return undefined; const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="100%" height="100%" fill="white"/>${pts.map(p => `<circle cx="${p.x}%" cy="${p.y}%" r="60" fill="black"/>`).join('')}</svg>`; const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`; return { maskImage: url, WebkitMaskImage: url }; })()} />
                    ) : null}
                    <div className="category-header" onMouseDown={e => { if (!(e.target as HTMLElement).closest('.drag-handle,.display-mode-btn,.edit-category-btn,.delete-category-btn')) toggleLibrary(lib); }}>
                      {!expanded && bgVideo ? <video className="bg-video" src={imgUrl(bgVideo)} muted loop autoPlay playsInline style={categoryFocusPoints[lib] ? { objectPosition: `${categoryFocusPoints[lib].x}% ${categoryFocusPoints[lib].y}%` } : {}} /> : !expanded && bgImage ? <img src={imgUrl(bgImage)} className="bg-image" alt="" style={categoryFocusPoints[lib] ? { objectPosition: `${categoryFocusPoints[lib].x}% ${categoryFocusPoints[lib].y}%` } : {}} /> : null}
                      <div className="header-content">
                        <div style={{ display:'flex', alignItems:'center' }}>
                          <span className="drag-handle" draggable data-drag-type="library" data-library={lib}>{iconGrip}</span>
                          <span style={{ textShadow:'0px 0px 4px black' }}>{lib}</span>
                        </div>
                        <div style={{ display:'flex', alignItems:'center' }}>
                          <button className="display-mode-btn" onClick={e => { e.stopPropagation(); resetModalForm(); setModalOldName(lib); setModalMode(libraryDisplay.getMode(lib, categoryDisplayModes, allLibraries)); setModalSize(libraryDisplay.getSize(lib, categorySizeModes, allLibraries)); setModalIsCat(false); setModal({type:'displayMode',data:{name:lib,isCat:false}}); }}>{iconGrid}</button>
                          <button className="edit-category-btn" onClick={e => { e.stopPropagation(); resetModalForm(); const ld = allLibraries[lib]||{} as any; setModalOldName(lib); setModalName(lib); setModalPromptIds((ld.prompt_ids||[]).join(', ')); const bg = ld.bg_image||''; const bgVid = ld.bg_video||''; if(bgVid) { setModalVideoUrl(imgUrl(bgVid)); setModalPreviewVisible(true); setModalFileName(bgVid); setModalVideoVolume(videoVolumes[lib] ?? 0); setModalClarityPoints(clarityPoints[lib] ? [...clarityPoints[lib]] : []); const pt = categoryFocusPoints[lib]; if(pt){ setModalFocusX(pt.x); setModalFocusY(pt.y); setModalFocusVisible(true); } } else if(bg){ setModalPreviewUrl(imgUrl(bg)); setModalPreviewVisible(true); setModalFileName(bg); setModalClarityPoints(clarityPoints[lib] ? [...clarityPoints[lib]] : []); const pt = categoryFocusPoints[lib]; if(pt){ setModalFocusX(pt.x); setModalFocusY(pt.y); setModalFocusVisible(true); } } setModal({type:'editLibrary',data:{name:lib}}); }}>{iconGear}</button>
                          <button className="delete-category-btn" onClick={e => { e.stopPropagation(); deleteLibraryDirect(lib); }}>{iconTrash}</button>
                          <span className="toggle">{expanded ? iconChevronUp : iconChevronDown}</span>
                        </div>
                      </div>
                    </div>
                    {expanded ? (
                      <div className={`category-content${anim ? ' animating' : ''} ${displayMode==='box'?'box-mode':''} ${isMiniMode?'mini-mode':''}`}>
                        {filteredPrompts.map(p => {
                          const sel = tempCtx.mode === 'promptCtx' ? tempCtx.isIdSelected(p.prompt) : isTagSelected(p.prompt);
                          const group = getTagGroupForPrompt(p.prompt);
                          const fp = focusPoints[p.id];
                          const pTags = Array.isArray(p.tags) ? p.tags : (p.tags ? p.tags.split(',').map((s: string) => s.trim()).filter(Boolean) : []);
                          return (
                            <div key={p.id} className="prompt-item-wrapper">
                              <div className={`prompt-item ${modeClass}${sel ? ' selected' : ''}${duplicateSet.has(p.prompt) ? ' duplicate' : ''}${(() => { const g = getTagGroupForPrompt(p.prompt); return g && programResult.filter_tag_groups.some(fg => tagsToDisplayString(fg) === tagsToDisplayString(g)) ? ' program-filtered' : ''; })()}`} data-prompt={p.prompt} data-id={p.id} data-category={p.category}>
                                <span className="drag-handle" data-drag-type="prompt" data-id={p.id} data-category={p.category}>{iconGrip}</span>
                                {(pTags.length > 0 || (Array.isArray(p.mute_decorations) && p.mute_decorations.length > 0)) && <div className="decoration-tags">{pTags.map((t: string) => <span className="decoration-tag tag" key={t}>{t}</span>)}{Array.isArray(p.mute_decorations) && p.mute_decorations.map((d: string) => <span className="decoration-tag muted" key={d}>{d}</span>)}</div>}
                                <div className="select-area" onMouseDown={() => { if (tempCtx.mode === 'promptCtx') { tempCtx.toggleId(p.prompt); } else { selectPrompt(p.prompt); } }}>
                                  <div className="image-layer">
                                    {p.preview ? <img src={imgUrl(p.preview)} alt={p.name} loading="lazy" style={fp ? { objectPosition: `${fp.x}% ${fp.y}%` } : {}} /> : <div className="no-image">No Image</div>}
                                  </div>
                                  {!isMiniMode && <div className="glass-layer" />}
                                  <div className="text-layer">
                                    <div className="name">{p.name}</div>
                                    <div className="prompt-text">{p.prompt}</div>
                                  </div>
                                </div>
                                <div className="actions" onMouseDown={e => e.stopPropagation()}>
                                  <button className="action-btn edit" onClick={e => { e.stopPropagation(); resetModalForm(); setModalOldName(p.id); setModalName(p.name); setModalPrompt(p.prompt||''); setModalTags(Array.isArray(p.tags)?[...p.tags]:[]); setModalDecorations(Array.isArray(p.decorations)?[...p.decorations]:[]); setModalMuteDecorations(Array.isArray(p.mute_decorations)?[...p.mute_decorations]:[]); setModalCategory(p.category||''); if(p.preview){ setModalPreviewUrl(imgUrl(p.preview)); setModalPreviewVisible(true); setModalFileName(p.preview); const pt = focusPoints[p.id]; if(pt){ setModalFocusX(pt.x); setModalFocusY(pt.y); setModalFocusVisible(true); } } setModal({type:'editPrompt',data:{id:p.id,category:p.category}}); }}>{iconGear}</button>
                                  <button className="action-btn delete" onClick={e => { e.stopPropagation(); deletePrompt(p.id); }}>{iconTrash}</button>
                                </div>
                              </div>
                              {group ? (
                                <div className="selected-card">
                                  <div className="selected-card-content">{tagsToDisplayName(group)}</div>
                                  <button className="selected-card-delete" onClick={e => { e.stopPropagation(); setSelectedTags(prev => prev.filter((_, gi) => gi !== selectedTags.findIndex(sg => sg === group))); }}>{iconX}</button>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                        {filteredPrefabs.map((pf, i) => (
                          <PrefabItem key={`prefab_${lib}_${i}`}
                            prefab={pf} libName={lib} idx={i} modeClass={modeClass} isMiniMode={isMiniMode}
                            prefabClass={getPrefabClass((pf.tag_groups||[]) as TagGroup[], selectedTags, pf.loras || [], selectedLoras, loraSelections)}
                            focusPoints={focusPoints} imgUrl={imgUrl}
                            isSelected={tempCtx.mode === 'prefab' || tempCtx.mode === 'prefabCtx' ? tempCtx.isIdSelected(pf.guid || '') : selectedPrefabs.some(p => p.guid === pf.guid)}
                            onToggle={() => { if (tempCtx.mode === 'prefabCtx') { tempCtx.toggleId(pf.guid || ''); } else { togglePrefab(pf.guid || `${lib}_${i}`); } }}
                            allLibraries={allLibraries}

                            onEdit={() => { resetModalForm(); const pf = allLibraries[lib]?.prefabs?.[i]; setModalOldName(lib); setModalName(pf?.name||''); setModalCustomPrompts(pf?.custom_prompts||''); setModalPrefabTags((pf?.tag_groups||[]) as TagGroup[]); setModalPrefabLoras((pf?.loras||[]) as LoraSelectionData[]); setModalPrefabSelectedPrefabs((pf?.selected_prefabs||[]) as SelectedPrefabRef[]); if(pf?.preview){ setModalPreviewUrl(imgUrl(pf.preview)); setModalPreviewVisible(true); setModalFileName(pf.preview); const key = `prefab_${lib}_${i}`; const pt = focusPoints[key]; if(pt){ setModalFocusX(pt.x); setModalFocusY(pt.y); setModalFocusVisible(true); } } setModal({type:'editPrefab',data:{lib,idx:i}}); }}
                            onDelete={() => deletePrefab(lib, i)}
                          />
                        ))}
                        <div className={`prompt-item add-prompt-btn ${modeClass}`} data-library={lib} style={{ cursor:'pointer' }} onMouseDown={() => { resetModalForm(); setModal({type:'addPrefab',data:{lib}}); }}><div>{iconPlus}</div></div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
              <div className="add-library-card" onMouseDown={() => { resetModalForm(); setModal({type:'addLibrary'}); }}>{iconPlus}</div>
            </div>) : null}

            {(!tempCtx.mode || tempCtx.mode === 'program') ? (
            <div className="categories-container program-section" id="applications">
              {Object.entries(allPrograms).map(([appCat, catData]) => {
                const apps = (catData?.programs || []) as ProgramData[];
                const expanded = expandedCategories.has(appCat);
                const anim = animating.has(appCat);
                const displayMode = catData.display_mode || 'horizontal';
                const sizeMode = catData.size_mode || 'normal';
                const isMiniMode = sizeMode === 'mini';
                const modeClass = isMiniMode ? 'mini-mode' : 'normal-mode';
                const bgImage = catData.bg_image || '';
                const bgVideo = (catData as any).bg_video || '';
                return (
                  <div key={appCat} className={`category ${expanded ? 'expanded' : 'collapsed'}`} id={`application-${appCat}`} onMouseMove={e => { const r = e.currentTarget.getBoundingClientRect(); const mx = e.clientX - r.left; const my = e.clientY - r.top; const pts = clarityPoints[appCat] || []; const circles = pts.map(p => `<circle cx="${p.x}%" cy="${p.y}%" r="60" fill="black"/>`).join(''); const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="100%" height="100%" fill="white"/>${circles}<circle cx="${mx}" cy="${my}" r="70" fill="black"/></svg>`; const blurEl = e.currentTarget.querySelector<HTMLDivElement>('.category-background-blur'); if (blurEl) { const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`; blurEl.style.maskImage = url; blurEl.style.webkitMaskImage = url; } }}>
                    {expanded && bgVideo ? (
                      <div className="category-background-mask">
                        <video className="category-background-video" src={imgUrl(bgVideo)} muted={!(videoVolumes[appCat] > 0)} loop autoPlay playsInline ref={el => { if (el) el.volume = videoVolumes[appCat] || 0; }} style={categoryFocusPoints[appCat] ? { objectPosition: `${categoryFocusPoints[appCat].x}% ${categoryFocusPoints[appCat].y}%` } : {}} />
                      </div>
                    ) : expanded && bgImage ? (
                      <div className="category-background-mask">
                        <div className="category-background" style={{ backgroundImage: `url(${imgUrl(bgImage)})`, backgroundPosition: categoryFocusPoints[appCat] ? `${categoryFocusPoints[appCat].x}% ${categoryFocusPoints[appCat].y}%` : 'center' }} />
                      </div>
                    ) : null}
                    {expanded && (bgVideo || bgImage) ? (
                      <div className="category-background-blur" style={(() => { const pts = clarityPoints[appCat]; if (!pts || pts.length === 0) return undefined; const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="100%" height="100%" fill="white"/>${pts.map(p => `<circle cx="${p.x}%" cy="${p.y}%" r="60" fill="black"/>`).join('')}</svg>`; const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`; return { maskImage: url, WebkitMaskImage: url }; })()} />
                    ) : null}
                    <div className="category-header" onMouseDown={e => { if (!(e.target as HTMLElement).closest('.drag-handle,.display-mode-btn,.edit-category-btn,.delete-category-btn')) toggleCategory(appCat); }}>
                      {!expanded && bgVideo ? <video className="bg-video" src={imgUrl(bgVideo)} muted loop autoPlay playsInline style={categoryFocusPoints[appCat] ? { objectPosition: `${categoryFocusPoints[appCat].x}% ${categoryFocusPoints[appCat].y}%` } : {}} /> : !expanded && bgImage ? <img src={imgUrl(bgImage)} className="bg-image" alt="" style={categoryFocusPoints[appCat] ? { objectPosition: `${categoryFocusPoints[appCat].x}% ${categoryFocusPoints[appCat].y}%` } : {}} /> : null}
                      <div className="header-content">
                        <div style={{ display:'flex', alignItems:'center' }}>
                          <span className="drag-handle">{iconGrip}</span>
                          <span style={{ textShadow:'0px 0px 4px black' }}>{appCat}</span>
                        </div>
                        <div style={{ display:'flex', alignItems:'center' }}>
                          <button className="display-mode-btn" onClick={e => { e.stopPropagation(); resetModalForm(); setModalOldName(appCat); setModalMode(displayMode); setModalSize(sizeMode); setModalIsCat(true); setModal({type:'programDisplayMode',data:{name:appCat}}); }}>{iconGrid}</button>
                          <button className="edit-category-btn" onClick={e => { e.stopPropagation(); resetModalForm(); setModalOldName(appCat); setModalName(appCat); const cd = allPrograms[appCat]||{} as any; const bg = cd.bg_image||''; const bgVid = cd.bg_video||''; if(bgVid) { setModalVideoUrl(imgUrl(bgVid)); setModalPreviewVisible(true); setModalFileName(bgVid); setModalVideoVolume(videoVolumes[appCat] ?? 0); setModalClarityPoints(clarityPoints[appCat] ? [...clarityPoints[appCat]] : []); const pt = categoryFocusPoints[appCat]; if(pt){ setModalFocusX(pt.x); setModalFocusY(pt.y); setModalFocusVisible(true); } } else if(bg) { setModalPreviewUrl(imgUrl(bg)); setModalPreviewVisible(true); setModalFileName(bg); setModalClarityPoints(clarityPoints[appCat] ? [...clarityPoints[appCat]] : []); const pt = categoryFocusPoints[appCat]; if(pt){ setModalFocusX(pt.x); setModalFocusY(pt.y); setModalFocusVisible(true); } } setModal({type:'editProgramCategory',data:{name:appCat}}); }}>{iconGear}</button>
                          <button className="delete-category-btn" onClick={e => { e.stopPropagation(); if (confirm(`Delete category "${appCat}" and all its programs?`)) { setAllPrograms(prev => { const n = {...prev}; delete n[appCat]; return n; }); } }}>{iconTrash}</button>
                          <span className="toggle">{expanded ? iconChevronUp : iconChevronDown}</span>
                        </div>
                      </div>
                    </div>
                    {expanded ? (
                      <div className={`category-content${anim ? ' animating' : ''} ${displayMode==='box'?'box-mode':''} ${isMiniMode?'mini-mode':''}`}>
                        {apps.map((app, i) => {
                          const isSelected = tempCtx.mode === 'program'
                            ? tempCtx.isIdSelected(app.id)
                            : selectedPrograms.some(sa => sa.id === app.id);
                          // Filter out self and already-selected in program mode
                          if (tempCtx.mode === 'program') {
                            const targetId = (tempCtx.current?.restorePoint?.modalData as any)?.programId;
                            if (app.id === targetId) return null;
                          }
                          return (
                            <div key={app.id} className={`prompt-item ${modeClass} ${isSelected ? 'selected' : ''}`} data-program={app.id} data-category={appCat} data-program-index={i}>
                              <span className="drag-handle" draggable data-drag-type="program" data-id={app.id} data-category={appCat} data-index={i}>{iconGrip}</span>
                              <div className="select-area" onMouseDown={() => {
                                if (tempCtx.mode === 'program') {
                                  tempCtx.toggleId(app.id);
                                } else {
                                  toggleProgram(app.id);
                                }
                              }}>
                                <div className="image-layer">
                                  {app.preview ? <img src={imgUrl(app.preview)} alt={app.name} loading="lazy" style={focusPoints[app.id] ? { objectPosition: `${focusPoints[app.id].x}% ${focusPoints[app.id].y}%` } : {}} /> : <div className="no-image" style={{ display:'flex', alignItems:'center', justifyContent:'center' }}>{iconCode}</div>}
                                </div>
                                <div className="glass-layer" />
                                <div className="text-layer">
                                  <div className="name">{app.name}</div>
                                  <div className="prompt-text" style={{ fontFamily:'Consolas, Monaco, monospace', fontSize: 10, whiteSpace:'pre-wrap', overflow:'hidden', maxHeight:30 }}>{app.code.split('\n').slice(0,2).join('\n')}</div>
                                </div>
                              </div>
                              <div className="actions" onMouseDown={e => e.stopPropagation()}>
                                <button className="action-btn edit" onClick={e => { e.stopPropagation(); resetModalForm(); setModalOldName(app.id); setModalName(app.name); setModalCustomPrompts(app.code); setModalProgramSelectedPrograms([...(app.selected_programs || [])]); setModalEnablePrefabCtx(!!app.enable_prefab_context); setModalEnableLoraCtx(!!app.enable_lora_context); setModalEnablePromptCtx(!!app.enable_prompt_context); setModalMultiProgram(!!app.multi_program); setModalCtxPrefabGuids([]); setModalCtxLoraPaths([]); setModalCtxPromptTexts([]); if(app.preview){ setModalPreviewUrl(imgUrl(app.preview)); setModalPreviewVisible(true); setModalFileName(app.preview); const pt = focusPoints[app.id]; if(pt){ setModalFocusX(pt.x); setModalFocusY(pt.y); setModalFocusVisible(true); } } setModal({type:'editProgram',data:{id:app.id}}); }}>{iconGear}</button>
                                <button className="action-btn delete" onClick={e => { e.stopPropagation(); deleteProgram(app.id); }}>{iconTrash}</button>
                              </div>
                            </div>
                          );
                        })}
                        <div className={`prompt-item add-prompt-btn ${modeClass}`} data-category={appCat} style={{ cursor:'pointer' }} onMouseDown={() => { resetModalForm(); setModal({type:'editProgram',data:{id:null,category:appCat}}); }}><div>{iconPlus}</div></div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
              <div className="add-category-card" onMouseDown={() => { resetModalForm(); setModal({type:'addProgramCategory'}); }}>{iconPlus}</div>
            </div>
            ) : null}

          </div>
        </div>

        <div className="right-bar">
          <div className="selected-bar">
            {tempCtx.mode === 'prefab' ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <h3 style={{ marginBottom: 0 }}>Selected Prefabs ({(tempCtx.current?.selections || []).length})</h3>
                  <button className="clear-btn" onClick={() => tempCtx.updateTop(layer => ({ ...layer, selections: [] }))} title="Clear">{iconX}</button>
                </div>
                <div className="prefab-list">
                  {(tempCtx.current?.selections || []).map(guid => {
                    const pf = findPrefabByGuid(guid);
                    if (!pf) return null;
                    const fp = (() => {
                      for (const [libName, libData] of Object.entries(allLibraries)) {
                        const idx = (libData.prefabs || []).findIndex(p => p.guid === guid);
                        if (idx !== -1) return focusPoints[`prefab_${libName}_${idx}`];
                      }
                      return undefined;
                    })();
                    return (
                      <div key={guid} className="prefab-card">
                        {pf.preview && <img className="prefab-card-bg" src={imgUrl(pf.preview)} alt="" style={fp ? { objectPosition: `${fp.x}% ${fp.y}%` } : {}} />}
                        <div className="prefab-card-header">
                          <span className="prefab-card-name">{pf.name}</span>
                          <div className="prefab-card-actions">
                            <button className="prefab-card-btn remove" onMouseDown={(e) => { e.stopPropagation(); tempCtx.toggleId(guid); }}>{iconX}</button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : null}

            {tempCtx.mode === 'prefabCtx' ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <h3 style={{ marginBottom: 0 }}>Prefab Context ({(tempCtx.current?.selections || []).length})</h3>
                  <button className="clear-btn" onClick={() => tempCtx.updateTop(layer => ({ ...layer, selections: [] }))} title="Clear">{iconX}</button>
                </div>
                <div className="prefab-list">
                  {(tempCtx.current?.selections || []).map(guid => {
                    let pf: PrefabData | undefined;
                    for (const libData of Object.values(allLibraries)) {
                      pf = (libData.prefabs || []).find(p => p.guid === guid);
                      if (pf) break;
                    }
                    if (!pf) return null;
                    return (
                      <div key={guid} className="prefab-card">
                        {pf.preview && <img className="prefab-card-bg" src={imgUrl(pf.preview)} alt="" />}
                        <div className="prefab-card-header">
                          <span className="prefab-card-name">{pf.name}</span>
                          <div className="prefab-card-actions">
                            <button className="prefab-card-btn remove" onMouseDown={(e) => { e.stopPropagation(); tempCtx.toggleId(guid); }}>{iconX}</button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : null}

            {tempCtx.mode === 'loraCtx' ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <h3 style={{ marginBottom: 0 }}>Lora Context ({(tempCtx.current?.selections || []).length})</h3>
                  <button className="clear-btn" onClick={() => tempCtx.updateTop(layer => ({ ...layer, selections: [] }))} title="Clear">{iconX}</button>
                </div>
                <div className="lora-list">
                  {(tempCtx.current?.selections || []).map(fp => {
                    let item: LoraItemData | undefined;
                    for (const items of Object.values(loraData)) {
                      item = items.find(it => it.file_path === fp);
                      if (item) break;
                    }
                    if (!item) return null;
                    return (
                      <div key={fp} className="lora-card active">
                        <div className="lora-card-header">
                          <span className="lora-card-name">{item.name}</span>
                          <div className="lora-card-meta">
                            <button className="lora-card-remove" onClick={() => tempCtx.toggleId(fp)}>{iconX}</button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : null}

            {tempCtx.mode === 'promptCtx' ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <h3 style={{ marginBottom: 0 }}>Prompt Context ({(tempCtx.current?.selections || []).length})</h3>
                  <button className="clear-btn" onClick={() => tempCtx.updateTop(layer => ({ ...layer, selections: [] }))} title="Clear">{iconX}</button>
                </div>
                <div className="selected-tags">
                  {(tempCtx.current?.selections || []).map(text => {
                    let name = text;
                    for (const catData of Object.values(allPrompts)) {
                      const p = (catData.prompts || []).find(p => p.prompt === text);
                      if (p) { name = p.name; break; }
                    }
                    return (
                      <span className="tag" key={text}>
                        {name}
                        <span className="remove" onClick={() => tempCtx.toggleId(text)}>{iconX}</span>
                      </span>
                    );
                  })}
                </div>
              </>
            ) : null}

            {tempCtx.mode === 'program' ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <h3 style={{ marginBottom: 0 }}>Selected Sub-programs ({(tempCtx.current?.selections || []).length})</h3>
                  <button className="clear-btn" onClick={() => tempCtx.updateTop(layer => ({ ...layer, selections: [] }))} title="Clear">{iconX}</button>
                </div>
                <div className="prefab-list">
                  {(tempCtx.current?.selections || []).map(id => {
                    let app: ProgramData | undefined;
                    for (const catData of Object.values(allPrograms)) {
                      app = (catData.programs || []).find(a => a.id === id);
                      if (app) break;
                    }
                    if (!app) return null;
                    const fp = focusPoints[app.id];
                    return (
                      <div key={id} className="program-card">
                        {app.preview && <img className="prefab-card-bg" src={imgUrl(app.preview)} alt="" style={fp ? { objectPosition: `${fp.x}% ${fp.y}%` } : {}} />}
                        <div className="program-card-header">
                          <span className="program-toggle" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.name}</span>
                          <div className="program-card-actions">
                            <button className="prefab-card-btn remove" onMouseDown={(e) => { e.stopPropagation(); tempCtx.toggleId(id); }}>{iconX}</button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : null}

            {tempCtx.mode === 'lora' ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <h3 style={{ marginBottom: 0 }}>Selected Loras ({(tempCtx.current?.selections || []).length})</h3>
                  <button className="clear-btn" onClick={() => tempCtx.updateTop(layer => ({ ...layer, selections: [], loraStates: {} }))} title="Clear">{iconX}</button>
                </div>
                <div className="lora-list">
                  {(tempCtx.current?.selections || []).map(path => {
                    const item = Object.values(loraData).flat().find(it => it.file_path === path);
                    if (!item) return null;
                    const state = tempCtx.current?.loraStates?.[path];
                    return (
                      <Lora
                        key={path}
                        lora={item}
                        initialStrength={state?.strength ?? 1.0}
                        initialActive={state?.active ?? true}
                        initialActiveTags={state?.active_tags}
                        initialSplitMode={state?.split_mode}
                        isFiltered={isLoraFiltered(item)}
                        onChange={(data) => tempCtx.setLoraState(path, { strength: data.strength, active_tags: data.activeTags, active: data.active, split_mode: data.split_mode })}
                        onRemove={() => tempCtx.toggleId(path)}
                      />
                    );
                  })}
                </div>
              </>
            ) : null}

            {!tempCtx.mode ? (
              <>
                {!isTemporary ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                      <h3 style={{ marginBottom: 0 }}>Selected Prefabs ({selectedPrefabs.length + programResult.gen_prefabs.length})</h3>
                      <button className="clear-btn" onClick={() => setSelectedPrefabs([])} title="Clear">{iconX}</button>
                    </div>
                    <div className="prefab-list">
                      {selectedPrefabs.map(node => {
                        const pf = findPrefabByGuid(node.guid);
                        if (!pf) return null;
                        const fp = (() => {
                          for (const [libName, libData] of Object.entries(allLibraries)) {
                            const idx = (libData.prefabs || []).findIndex(p => p.guid === node.guid);
                            if (idx !== -1) return focusPoints[`prefab_${libName}_${idx}`];
                          }
                          return undefined;
                        })();
                        return (
                          <div key={node.guid} className={`prefab-card ${node.active ? '' : 'prefab-inactive'} ${programResult.filter_prefabs.some(fp => fp.guid === node.guid) ? 'program-filtered' : ''}`} onMouseDown={(e) => { e.stopPropagation(); if ((e.target as HTMLElement).closest('.prefab-card-actions, .action-btn')) return; togglePrefabActive(node.guid); }}>
                            {pf.preview && <img className="prefab-card-bg" src={imgUrl(pf.preview)} alt="" style={fp ? { objectPosition: `${fp.x}% ${fp.y}%` } : {}} />}
                            <div className="prefab-card-header">
                              <span className="prefab-card-name" style={{ opacity: node.active ? 1 : 0.5 }}>{pf.name}</span>
                              <div className="prefab-card-actions">
                                <button className="prefab-card-btn edit" onMouseDown={(e) => { e.stopPropagation(); setModal({ type: 'editSelectedPrefab', data: { guid: node.guid } }); }}>{iconGear}</button>
                                <button className="prefab-card-btn merge" onMouseDown={(e) => { e.stopPropagation(); mergePrefab(pf); }}>{iconLayers}</button>
                                <button className="prefab-card-btn remove" onMouseDown={(e) => { e.stopPropagation(); removeSelectedPrefab(node.guid); }}>{iconX}</button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      {/* Program-generated prefabs */}
                      {programResult.gen_prefabs.map((p, pi) => {
                        const pf = findPrefabByGuid(p.guid);
                        if (!pf) return null;
                        const fp = (() => {
                          for (const [libName, libData] of Object.entries(allLibraries)) {
                            const idx = (libData.prefabs || []).findIndex(pp => pp.guid === p.guid);
                            if (idx !== -1) return focusPoints[`prefab_${libName}_${idx}`];
                          }
                          return undefined;
                        })();
                        return (
                          <div key={`prog-pf-${pi}`} className={`prefab-card program-source ${p.active ? '' : 'prefab-inactive'}`}>
                            {pf.preview && <img className="prefab-card-bg" src={imgUrl(pf.preview)} alt="" style={fp ? { objectPosition: `${fp.x}% ${fp.y}%` } : {}} />}
                            <div className="prefab-card-header">
                              <span className="prefab-card-name" style={{ opacity: p.active ? 1 : 0.5 }}>{pf.name}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, ...((selectedPrefabs.length > 0 || programResult.gen_prefabs.length > 0) ? { marginTop: 12 } : {}) }}>
                      <h3 style={{ marginBottom: 0 }}>Selected Loras ({selectedLoras.length + programResult.gen_loras.length})</h3>
                      <button className="clear-btn" onClick={() => { setSelectedLoras([]); setLoraSelections({}); }} title="Clear">{iconX}</button>
                    </div>
                    <div className="lora-list">
                      {selectedLoras.map(lora => {
                        const sel = loraSelections[lora.file_path];
                        return (
                          <Lora
                            key={lora.file_path}
                            lora={lora}
                            initialActiveTags={sel?.activeTags}
                            initialStrength={sel?.strength}
                            initialActive={sel?.active}
                            initialSplitMode={sel?.split_mode}
                            isMissing={lora.metadata?.missing === true}
                            isFiltered={isLoraFiltered(lora)}
                            isProgramFiltered={programResult.filter_loras.some(fl => fl.file_path === lora.file_path)}
                            onChange={(data) => {
                              setLoraSelections(prev => {
                                const existing = prev[lora.file_path];
                                // During region context restore, loraSelections is pre-set from saved active_tags.
                                // Only update if the data actually changed (user interaction), not mount notify.
                                if (existing && JSON.stringify(existing) === JSON.stringify(data)) return prev;
                                return { ...prev, [lora.file_path]: data };
                              });
                            }}
                            onRemove={() => {
                              removeLora(lora.file_path);
                              setLoraSelections(prev => {
                                const next = { ...prev };
                                delete next[lora.file_path];
                                return next;
                              });
                            }}
                          />
                        );
                      })}
                      {/* Program-generated loras */}
                      {programResult.gen_loras.map((l, li) => {
                        let item: LoraItemData | undefined;
                        for (const items of Object.values(loraData)) {
                          item = items.find(it => it.file_path === l.file_path);
                          if (item) break;
                        }
                        if (!item) return null;
                        return (
                          <Lora
                            key={`prog-lora-${li}`}
                            lora={item}
                            initialActiveTags={l.active_tags || []}
                            initialStrength={l.strength}
                            initialActive={l.active}
                            initialSplitMode={l.split_mode}
                            isMissing={false}
                            isFiltered={false}
                            onChange={() => {}}
                            onRemove={() => {}}
                          />
                        );
                      })}
                    </div>
                  </>
                ) : null}

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, ...((selectedPrefabs.length > 0 || selectedLoras.length > 0 || programResult.gen_prefabs.length > 0 || programResult.gen_loras.length > 0) && !isTemporary ? { marginTop: 12 } : {}) }}>
                  <h3 style={{ marginBottom: 0 }}>Selected Prompts ({isTemporary && currentCtx ? currentCtx!.tagGroups!.length : selectedTags.length + programResult.gen_tag_groups.length})</h3>
                  <button className="clear-btn" onClick={() => setSelectedTags([])} title="Clear">{iconX}</button>
                </div>
                <div className="selected-tags">
                  {isTemporary && currentCtx
                    ? currentCtx!.tagGroups!.map((group, i) => (
                      <span className="tag" key={i}>
                        {tagsToDisplayName(group)}
                        <span className="remove" onClick={() => removeTemporaryTag(i)}>{iconX}</span>
                      </span>
                    ))
                    : selectedTags.map((group, i) => {
                      const baseStrength = group.strength ?? 1.0;
                      const showStrength = baseStrength !== 1.0;
                      const displayStr = tagsToDisplayString(group);
                      const fromParsing = group.source === 'parsing';
                      const sourceProgram = group.source === 'program';
                      const programFiltered = programResult.filter_tag_groups.some(fg => tagsToDisplayString(fg) === tagsToDisplayString(group));
                      return (
                        <TagStrengthEditor
                          key={i}
                          displayName={tagsToDisplayName(group)}
                          strength={baseStrength}
                          showStrength={showStrength}
                          fromParsing={fromParsing}
                          sourceProgram={sourceProgram}
                          programFiltered={programFiltered}
                          dragIndex={i}
                          onReorder={(toIdx) => reorderTags(i, toIdx)}
                          onStrengthChange={(v) => {
                            setSelectedTags(prev => prev.map((g, idx) => {
                              if (idx !== i) return g;
                              return { ...g, strength: v };
                            }));
                          }}
                          onRemove={() => removeTag(i)}
                        />
                      );
                    })}
                    {/* Program-generated tags */}
                    {programResult.gen_tag_groups.map((group, i) => (
                      <span className="tag source-program" key={`prog-tag-${i}`}>
                        {tagsToDisplayName(group)}
                      </span>
                    ))}
                </div>
              </>
            ) : null}

          {!tempCtx.mode && !isTemporary ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <h3 style={{ marginBottom: 0 }}>Selected Programs ({selectedPrograms.length})</h3>
                <button className="clear-btn" onClick={() => setSelectedPrograms([])} title="Clear">{iconX}</button>
              </div>
              <div className="prefab-list">
                {selectedPrograms.map((sa, i) => {
                  let app: ProgramData | undefined;
                  for (const catData of Object.values(allPrograms)) {
                    app = (catData.programs || []).find(a => a.id === sa.id);
                    if (app) break;
                  }
                  if (!app) return null;
                  const fp = focusPoints[app.id];
                  return (
                    <div
                      key={`prog-${i}`}
                      className={`program-card ${sa.active ? 'active' : 'inactive'}`}
                      onDragOver={e => { if (e.dataTransfer.types.includes('text/plain') && e.dataTransfer.types.length === 1) e.preventDefault(); }}
                      onDrop={e => {
                        e.preventDefault();
                        const data = e.dataTransfer.getData('text/plain');
                        if (data.startsWith('selapp:')) {
                          const fromIdx = parseInt(data.slice(7));
                          if (fromIdx !== i && !isNaN(fromIdx)) reorderPrograms(fromIdx, i);
                        }
                      }}
                      onMouseDown={e => { e.stopPropagation(); if ((e.target as HTMLElement).closest('.program-card-actions, .action-btn, .drag-handle')) return; toggleProgramActive(sa.id, i); }}
                    >
                      {app.preview && <img className="prefab-card-bg" src={imgUrl(app.preview)} alt="" style={fp ? { objectPosition: `${fp.x}% ${fp.y}%` } : {}} />}
                      <div className="program-card-header">
                        <span className="drag-handle program-drag-handle" draggable onDragStart={e => { e.dataTransfer.setData('text/plain', `selapp:${i}`); e.dataTransfer.effectAllowed = 'move'; }}>{iconGrip}</span>
                        <span className="program-toggle" style={{ opacity: sa.active ? 1 : 0.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.name}</span>
                        <div className="program-card-actions">
                          {app.enable_prefab_context && <button className="prefab-card-btn edit" title="Prefab Context" onMouseDown={e => { e.stopPropagation(); const ctxGuids = sa.context_prefab_guids ?? []; tempCtx.push({ type: 'prefabCtx', title: `Prefab Context for ${app.name}`, selections: [...ctxGuids], restorePoint: { name: app.name, customPrompts: app.code, prefabTags: [], prefabLoras: [], prefabSelectedPrefabs: [], programSelectedPrograms: [...(app.selected_programs || [])], ctxPrefabGuids: ctxGuids, ctxLoraPaths: sa.context_lora_paths ?? [], ctxPromptTexts: sa.context_prompt_texts ?? [], previewUrl: '', previewVisible: false, focusX: 0, focusY: 0, focusVisible: false, modalData: { programId: sa.id, instanceIndex: i } } }); }}>{iconLayers}</button>}
                          {app.enable_lora_context && <button className="prefab-card-btn edit" title="Lora Context" onMouseDown={e => { e.stopPropagation(); const ctxPaths = sa.context_lora_paths ?? []; tempCtx.push({ type: 'loraCtx', title: `Lora Context for ${app.name}`, selections: [...ctxPaths], restorePoint: { name: app.name, customPrompts: app.code, prefabTags: [], prefabLoras: [], prefabSelectedPrefabs: [], programSelectedPrograms: [...(app.selected_programs || [])], ctxPrefabGuids: sa.context_prefab_guids ?? [], ctxLoraPaths: ctxPaths, ctxPromptTexts: sa.context_prompt_texts ?? [], previewUrl: '', previewVisible: false, focusX: 0, focusY: 0, focusVisible: false, modalData: { programId: sa.id, instanceIndex: i } } }); }}>{iconGrid}</button>}
                          {app.enable_prompt_context && <button className="prefab-card-btn edit" title="Prompt Context" onMouseDown={e => { e.stopPropagation(); const ctxTexts = sa.context_prompt_texts ?? []; tempCtx.push({ type: 'promptCtx', title: `Prompt Context for ${app.name}`, selections: [...ctxTexts], restorePoint: { name: app.name, customPrompts: app.code, prefabTags: [], prefabLoras: [], prefabSelectedPrefabs: [], programSelectedPrograms: [...(app.selected_programs || [])], ctxPrefabGuids: sa.context_prefab_guids ?? [], ctxLoraPaths: sa.context_lora_paths ?? [], ctxPromptTexts: ctxTexts, previewUrl: '', previewVisible: false, focusX: 0, focusY: 0, focusVisible: false, modalData: { programId: sa.id, instanceIndex: i } } }); }}>{iconCode}</button>}
                          <button className="prefab-card-btn remove" onMouseDown={e => { e.stopPropagation(); removeProgram(sa.id, i); }}>{iconX}</button>
                        </div>
                      </div>
                      {/* Context previews — use instance-level context from sa, not shared app data */}
                      {(() => {
                        const ctxPrefabGuids = sa.context_prefab_guids ?? [];
                        const ctxLoraPaths = sa.context_lora_paths ?? [];
                        const ctxPromptTexts = sa.context_prompt_texts ?? [];
                        const ctxPrefabInactive = sa.context_prefab_inactive ?? [];
                        const ctxLoraInactive = sa.context_lora_inactive ?? [];
                        const ctxPromptInactive = sa.context_prompt_inactive ?? [];

                        const updateInstance = (updates: Partial<SelectedProgramItem>) => {
                          setSelectedPrograms(prev => prev.map((p, j) => j === i ? { ...p, ...updates } : p));
                        };

                        return (
                          <>
                      {app.enable_prefab_context && ctxPrefabGuids.length > 0 && (
                        <>
                          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>Prefab Context ({ctxPrefabGuids.length})</div>
                          <div className="prefab-list">
                            {ctxPrefabGuids.map(guid => {
                              const pf = findPrefabByGuid(guid);
                              if (!pf) return null;
                              const fp = (() => {
                                for (const [libName, libData] of Object.entries(allLibraries)) {
                                  const idx = (libData.prefabs || []).findIndex(p => p.guid === guid);
                                  if (idx !== -1) return focusPoints[`prefab_${libName}_${idx}`];
                                }
                                return undefined;
                              })();
                              const isActive = !ctxPrefabInactive.includes(guid);
                              return (
                                <div key={guid} className={`prefab-card ${isActive ? '' : 'prefab-inactive'}`} onMouseDown={e => { e.stopPropagation(); if (!(e.target as HTMLElement).closest('.prefab-card-actions')) updateInstance({ context_prefab_inactive: isActive ? [...ctxPrefabInactive, guid] : ctxPrefabInactive.filter(g => g !== guid) }); }}>
                                  {pf.preview && <img className="prefab-card-bg" src={imgUrl(pf.preview)} alt="" style={fp ? { objectPosition: `${fp.x}% ${fp.y}%` } : {}} />}
                                  <div className="prefab-card-header">
                                    <span className="prefab-card-name" style={{ opacity: isActive ? 1 : 0.5 }}>{pf.name}</span>
                                    <div className="prefab-card-actions">
                                      <button className="prefab-card-btn remove" onMouseDown={e => { e.stopPropagation(); updateInstance({ context_prefab_guids: ctxPrefabGuids.filter(g => g !== guid), context_prefab_inactive: ctxPrefabInactive.filter(g => g !== guid) }); }}>{iconX}</button>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}
                      {app.enable_lora_context && ctxLoraPaths.length > 0 && (
                        <>
                          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>Lora Context ({ctxLoraPaths.length})</div>
                          <div className="lora-list">
                            {ctxLoraPaths.map(fp => {
                              let item: LoraItemData | undefined;
                              for (const items of Object.values(loraData)) { item = items.find(it => it.file_path === fp); if (item) break; }
                              if (!item) return null;
                              const isActive = !ctxLoraInactive.includes(fp);
                              return (
                                <Lora key={fp} lora={item} initialActiveTags={item.tags || []} initialStrength={1.0} initialActive={isActive}
                                  isMissing={item.metadata?.missing === true} isFiltered={isLoraFiltered(item)}
                                  onChange={(data) => updateInstance({ context_lora_inactive: data.active ? ctxLoraInactive.filter(p => p !== fp) : [...ctxLoraInactive, fp] })}
                                  onRemove={() => updateInstance({ context_lora_paths: ctxLoraPaths.filter(p => p !== fp), context_lora_inactive: ctxLoraInactive.filter(p => p !== fp) })}
                                />
                              );
                            })}
                          </div>
                        </>
                      )}
                      {app.enable_prompt_context && ctxPromptTexts.length > 0 && (
                        <>
                          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>Prompt Context ({ctxPromptTexts.length})</div>
                          <div className="selected-tags">
                            {ctxPromptTexts.map(text => {
                              let name = text;
                              for (const catData of Object.values(allPrompts)) { const p = (catData.prompts || []).find(p => p.prompt === text); if (p) { name = p.name; break; } }
                              const isActive = !ctxPromptInactive.includes(text);
                              return (
                                <span className={`tag parsed-tag${isActive ? '' : ' program-filtered'}`} key={text} style={{ cursor: 'pointer' }}
                                  onMouseDown={() => updateInstance({ context_prompt_inactive: isActive ? [...ctxPromptInactive, text] : ctxPromptInactive.filter(t => t !== text) })}>
                                  {name}
                                  <span className="remove" onMouseDown={e => { e.stopPropagation(); updateInstance({ context_prompt_texts: ctxPromptTexts.filter(t => t !== text), context_prompt_inactive: ctxPromptInactive.filter(t => t !== text) }); }}>{iconX}</span>
                                </span>
                              );
                            })}
                          </div>
                        </>
                      )}
                          </>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
          </div>

          {!tempCtx.mode && !isTemporary ? (
            <>
              <div className="custom-input-section">
                <h3>Custom Prompts</h3>
                <CustomPromptsEditor
                  value={customPrompts}
                  onChange={setCustomPrompts}
                  allPrompts={allPrompts}
                  onParsed={handleCustomPromptsParsed}
                />
              </div>

              <div className="footer">
                <button className="btn btn-primary" onClick={handleConfirm}>Confirm</button>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {modal?.type === 'addCategory' ? (
        <div className="modal visible" onMouseDown={closeModal}>
          <div className="modal-content" onMouseDown={e => e.stopPropagation()}>
            <h2>Add New Category</h2>
            <input type="text" placeholder="Category name" value={modalName} onChange={e => setModalName(e.target.value)} onKeyDown={e => { if(e.key==='Enter') addCategory(); }} />
            <div className="modal-buttons">
              <button className="btn btn-secondary" onClick={closeModal}>Cancel</button>
              <button className="btn btn-primary" onClick={addCategory}>Add</button>
            </div>
          </div>
        </div>
      ) : modal?.type === 'addProgramCategory' ? (
        <div className="modal visible" onMouseDown={closeModal}>
          <div className="modal-content" onMouseDown={e => e.stopPropagation()}>
            <h2>Add New Program Category</h2>
            <input type="text" placeholder="Category name" value={modalName} onChange={e => setModalName(e.target.value)} onKeyDown={e => { if(e.key==='Enter') { if(!modalName.trim()) return; setAllPrograms(prev => ({...prev, [modalName.trim()]: {programs: []}})); closeModal(); } }} />
            <div className="modal-buttons">
              <button className="btn btn-secondary" onClick={closeModal}>Cancel</button>
              <button className="btn btn-primary" onClick={() => { if(!modalName.trim()) return; setAllPrograms(prev => ({...prev, [modalName.trim()]: {programs: []}})); closeModal(); }}>Add</button>
            </div>
          </div>
        </div>
      ) : modal?.type === 'addLibrary' ? (
        <div className="modal visible" onMouseDown={closeModal}>
          <div className="modal-content" onMouseDown={e => e.stopPropagation()}>
            <h2>Add New Library</h2>
            <input type="text" placeholder="Library name" value={modalName} onChange={e => setModalName(e.target.value)} onKeyDown={e => { if(e.key==='Enter') addLibrary(); }} />
            <div className="modal-buttons">
              <button className="btn btn-secondary" onClick={closeModal}>Cancel</button>
              <button className="btn btn-primary" onClick={addLibrary}>Add</button>
            </div>
          </div>
        </div>
      ) : modal?.type === 'addPrompt' ? (
        <div className="modal visible" onMouseDown={closeModal}>
          <div className="modal-content" onMouseDown={e => e.stopPropagation()}>
            <h2>Add New Prompt</h2>
            <input type="text" placeholder="Name" value={modalName} onChange={e => setModalName(e.target.value)} />
            <input type="text" placeholder="Prompt text" value={modalPrompt} onChange={e => setModalPrompt(e.target.value)} />
            <TagInput label="Tags" tags={modalTags} setTags={setModalTags} />
            <TagInput label="Decorations" tags={modalDecorations} setTags={setModalDecorations} />
            <TagInput label="Mute Decorations" tags={modalMuteDecorations} setTags={setModalMuteDecorations} />
            <input type="text" placeholder="Category (default: 杂项)" value={modalCategory} onChange={e => setModalCategory(e.target.value)} />
             <ImageSection previewUrl={modalPreviewUrl} previewVisible={modalPreviewVisible} focusX={modalFocusX} focusY={modalFocusY} focusVisible={modalFocusVisible} videoUrl={modalVideoUrl} isVideo={!!modalVideoFile || !!modalVideoUrl} fileName={modalFileName} videoVolume={modalVideoVolume} onVideoVolumeChange={setModalVideoVolume} clarityPoints={modalClarityPoints} onImageSelect={handleImageSelect} onPreviewClick={handlePreviewClick} onRemoveFocus={handleRemoveFocus} onPasteImage={handlePasteImage} onPreviewCtrlClick={handlePreviewCtrlClick} onPreviewCtrlRightClick={handlePreviewCtrlRightClick} />
             <div className="modal-buttons">
               <button className="btn btn-secondary" onClick={closeModal}>Cancel</button>
               <button className="btn btn-primary" onClick={async () => {
                 const name = modalName.trim(), pt = modalPrompt.trim();
                 if(!name||!pt){alert('Please enter name and prompt text');return;}
                 let imageData = '';
                 if(modalImageFile){const r=new FileReader();imageData=await new Promise(resolve=>{r.onload=e=>resolve(e.target?.result as string);r.readAsDataURL(modalImageFile!);});}
                 const res = await fetch('/add_prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({category:modalCategory||'杂项',name,prompt:pt,tags:modalTags,decorations:modalDecorations,mute_decorations:modalMuteDecorations,image:imageData})});
                 if (!res.ok) return;
                 const result = await res.json();
                 if (imageData) setImgVersion(v => v + 1);
                 const cat = modalCategory || '杂项';
                 const newPrompt: PromptData = { id: result.id || `${Date.now()}`, name, prompt: pt, preview: result.preview || '', tags: modalTags as any, decorations: modalDecorations as any, mute_decorations: modalMuteDecorations };
                 setAllPrompts((prev: AllPrompts) => {
                   const catData = prev[cat];
                   return { ...prev, [cat]: { ...(catData as CategoryData || {}), prompts: [...((catData as CategoryData)?.prompts || []), newPrompt] } };
                 });
                 closeModal();
               }}>Add</button>
            </div>
          </div>
        </div>
      ) : modal?.type === 'editPrompt' ? (
        <div className="modal visible" onMouseDown={closeModal}>
          <div className="modal-content" onMouseDown={e => e.stopPropagation()}>
            <h2>Edit Prompt</h2>
            <input type="text" placeholder="Name" value={modalName} onChange={e => setModalName(e.target.value)} />
            <input type="text" placeholder="Prompt text" value={modalPrompt} onChange={e => setModalPrompt(e.target.value)} />
            <TagInput label="Tags" tags={modalTags} setTags={setModalTags} />
            <TagInput label="Decorations" tags={modalDecorations} setTags={setModalDecorations} />
            <TagInput label="Mute Decorations" tags={modalMuteDecorations} setTags={setModalMuteDecorations} />
            <select value={modalCategory} onChange={e => setModalCategory(e.target.value)}>
              <option value="">Keep current category</option>
              {Object.keys(allPrompts).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <ImageSection previewUrl={modalPreviewUrl} previewVisible={modalPreviewVisible} focusX={modalFocusX} focusY={modalFocusY} focusVisible={modalFocusVisible} videoUrl={modalVideoUrl} isVideo={!!modalVideoFile || !!modalVideoUrl} fileName={modalFileName} videoVolume={modalVideoVolume} onVideoVolumeChange={setModalVideoVolume} clarityPoints={modalClarityPoints} onImageSelect={handleImageSelect} onPreviewClick={handlePreviewClick} onRemoveFocus={handleRemoveFocus} onPasteImage={handlePasteImage} onPreviewCtrlClick={handlePreviewCtrlClick} onPreviewCtrlRightClick={handlePreviewCtrlRightClick} />
            <div className="modal-buttons">
              <button className="btn btn-secondary" onClick={closeModal}>Cancel</button>
              <button className="btn btn-primary" onClick={updatePrompt}>Update</button>
            </div>
          </div>
        </div>
      ) : modal?.type === 'editProgram' ? (
        <div className="modal visible" onMouseDown={closeModal}>
          <div className="modal-content wide" onMouseDown={e => e.stopPropagation()}>
            <h2>{modal.data?.id ? 'Edit Program' : 'New Program'}</h2>
            {/* iOS-style toggles */}
            <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
              {[
                { label: 'Prefab Context', checked: modalEnablePrefabCtx, onChange: (v: boolean) => setModalEnablePrefabCtx(v) },
                { label: 'Lora Context', checked: modalEnableLoraCtx, onChange: (v: boolean) => setModalEnableLoraCtx(v) },
                { label: 'Prompt Context', checked: modalEnablePromptCtx, onChange: (v: boolean) => setModalEnablePromptCtx(v) },
                { label: 'Multi Program', checked: modalMultiProgram, onChange: (v: boolean) => setModalMultiProgram(v) },
              ].map((toggle, idx) => (
                <label key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
                  <span style={{ fontSize: 13, color: toggle.checked ? '#0a84ff' : 'var(--text-secondary)', transition: 'color 0.2s' }}>{toggle.label}</span>
                  <div onClick={() => toggle.onChange(!toggle.checked)} style={{
                    width: 44, height: 26, borderRadius: 13, position: 'relative', transition: 'background 0.3s',
                    background: toggle.checked ? '#0a84ff' : 'rgba(120,120,128,0.32)', flexShrink: 0,
                  }}>
                    <div style={{
                      position: 'absolute', top: 2, left: toggle.checked ? 20 : 2, width: 22, height: 22, borderRadius: '50%',
                      background: '#fff', transition: 'left 0.3s', boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                    }} />
                  </div>
                </label>
              ))}
            </div>
            <div className="edit-prefab-body row">
              {/* Left: name + preview image */}
              <div className="edit-prefab-left">
                <div className="edit-prefab-section">
                  <label>Program name</label>
                  <input type="text" placeholder="Program name" value={modalName} onChange={e => setModalName(e.target.value)} />
                </div>
                <div className="edit-prefab-section">
                  <label>Preview Image</label>
                  <ImageSection previewUrl={modalPreviewUrl} previewVisible={modalPreviewVisible} focusX={modalFocusX} focusY={modalFocusY} focusVisible={modalFocusVisible} videoUrl={modalVideoUrl} isVideo={!!modalVideoFile || !!modalVideoUrl} fileName={modalFileName} videoVolume={modalVideoVolume} onVideoVolumeChange={setModalVideoVolume} clarityPoints={modalClarityPoints} onImageSelect={handleImageSelect} onPreviewClick={handlePreviewClick} onRemoveFocus={handleRemoveFocus} onPasteImage={handlePasteImage} onPreviewCtrlClick={handlePreviewCtrlClick} onPreviewCtrlRightClick={handlePreviewCtrlRightClick} />
                </div>
              </div>
              {/* Middle: code editor */}
              <div className="edit-prefab-section" style={{ flex: 3, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <label>Code</label>
                <ProgramCodeEditor
                  value={modalCustomPrompts}
                  onChange={(v) => { setModalCustomPrompts(v); setDebugErrorLine(null); }}
                  errorLine={debugErrorLine}
                />
              </div>
              {/* Debug terminal */}
              <div className="edit-prefab-section" style={{ flex: '0 0 340px', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 0 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: debugOutput === null ? '#8e8e93' : debugOutput.startsWith('ERROR') ? '#ff453a' : '#30d158' }} />
                    Console
                  </label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-secondary" style={{ fontSize: 11, height: 24, padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4 }} onClick={handleDebug}>
                      <span style={{ fontSize: 10 }}>▶</span> Run
                    </button>
                    <button className="btn btn-secondary" style={{ fontSize: 11, height: 24, padding: '0 6px' }} onClick={() => { setDebugOutput(null); setDebugErrorLine(null); }}>✕</button>
                  </div>
                </div>
                <div className="debug-terminal-output" style={{
                  flex: 1, minHeight: 500, maxHeight: 500, overflow: 'auto',
                  background: '#0d0d0d', color: '#f5f5f5', padding: 10, borderRadius: 8,
                  fontFamily: 'Consolas, Monaco, monospace', fontSize: 11, lineHeight: 1.5,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  border: '1px solid #38383a',
                }}>
                  {debugOutput !== null ? debugOutput : (
                    <span style={{ color: '#8e8e93' }}>// Click "Run" to debug. Output will appear here.</span>
                  )}
                </div>
              </div>
              {/* Right: sub-programs */}
              <div className="edit-prefab-right" style={{ flex: 1 }}>
                <div className="edit-prefab-section">
                  <label>Programs ({modalProgramSelectedPrograms.length})</label>
                  <div className="prefab-list">
                    {modalProgramSelectedPrograms.map((sp, i) => {
                      let app: ProgramData | undefined;
                      for (const catData of Object.values(allPrograms)) {
                        app = (catData.programs || []).find(a => a.id === sp.id);
                        if (app) break;
                      }
                      if (!app) return null;
                      const fp = focusPoints[app.id];
                      return (
                        <div
                          key={sp.id}
                          className={`program-card ${sp.active !== false ? 'active' : 'inactive'}`}
                          draggable
                          onDragStart={e => { e.dataTransfer.setData('text/plain', `modalprogram:${i}`); }}
                          onDragOver={e => { if (e.dataTransfer.types.includes('text/plain')) e.preventDefault(); }}
                          onDrop={e => {
                            e.preventDefault();
                            const data = e.dataTransfer.getData('text/plain');
                            if (data.startsWith('modalprogram:')) {
                              const fromIdx = parseInt(data.slice(13));
                              if (fromIdx !== i) {
                                setModalProgramSelectedPrograms(prev => {
                                  const next = [...prev];
                                  const [item] = next.splice(fromIdx, 1);
                                  next.splice(i, 0, item);
                                  return next;
                                });
                              }
                            }
                          }}
                        >
                          {app.preview && <img className="prefab-card-bg" src={imgUrl(app.preview)} alt="" style={fp ? { objectPosition: `${fp.x}% ${fp.y}%` } : {}} />}
                          <div className="program-card-header">
                            <span className="drag-handle program-drag-handle">{iconGrip}</span>
                            <span className="program-toggle" style={{ opacity: sp.active !== false ? 1 : 0.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.name}</span>
                            <div className="program-card-actions">
                              <button className="prefab-card-btn remove" onMouseDown={e => { e.stopPropagation(); setModalProgramSelectedPrograms(prev => prev.filter((_, j) => j !== i)); }}>{iconX}</button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <button className="btn btn-secondary" style={{ width: '100%', fontSize: 13, height: 36, padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }} onClick={() => {
                    tempCtx.push({
                      type: 'program',
                      title: 'Select Programs',
                      selections: [],
                      restorePoint: {
                        name: modalName,
                        customPrompts: modalCustomPrompts,
                        prefabTags: modalPrefabTags,
                        prefabLoras: modalPrefabLoras,
                        prefabSelectedPrefabs: modalPrefabSelectedPrefabs,
                        programSelectedPrograms: [...modalProgramSelectedPrograms],
                        previewUrl: modalPreviewUrl,
                        previewVisible: modalPreviewVisible,
                        focusX: modalFocusX,
                        focusY: modalFocusY,
                        focusVisible: modalFocusVisible,
                        modalData: { programId: modal.data?.id || '' },
                      },
                    });
                    closeModal();
                  }}>
                    {iconPlus} Add Program
                  </button>
                </div>
              </div>
            </div>
            <div className="modal-buttons">
              <button className="btn btn-secondary" onClick={closeModal}>Cancel</button>
              <button className="btn btn-primary" onClick={async () => {
                if (!modalName.trim()) { alert('Please enter a name'); return; }
                let imageData: string|null = null;
                if (modalImageFile) { const r = new FileReader(); imageData = await new Promise(resolve => { r.onload = e => resolve(e.target?.result as string); r.readAsDataURL(modalImageFile!); }); }
                let videoData: string|null = null;
                if (modalVideoFile) { const fn = await getUploadedVideoFilename(); videoData = fn || ''; } else if (!modalVideoUrl) { videoData = null; }
                const focusData = modalFocusVisible ? { x: modalFocusX, y: modalFocusY } : null;
                await saveProgram(modal.data?.id || null, modalName.trim(), modalCustomPrompts, modal.data?.category || 'Applications', imageData, videoData, focusData, modalProgramSelectedPrograms, {
                  enable_prefab_context: modalEnablePrefabCtx,
                  enable_lora_context: modalEnableLoraCtx,
                  enable_prompt_context: modalEnablePromptCtx,
                  multi_program: modalMultiProgram,
                  context_prefab_guids: modalCtxPrefabGuids,
                  context_lora_paths: modalCtxLoraPaths,
                  context_prompt_texts: modalCtxPromptTexts,
                });
                closeModal();
              }}>Save</button>
            </div>
          </div>
        </div>
      ) : modal?.type === 'editProgramCategory' ? (
        <div className="modal visible" onMouseDown={closeModal}>
          <div className="modal-content" onMouseDown={e => e.stopPropagation()}>
            <h2>Edit Program Category</h2>
            <input type="text" placeholder="Category name" value={modalName} onChange={e => setModalName(e.target.value)} />
            <ImageSection previewUrl={modalPreviewUrl} previewVisible={modalPreviewVisible} focusX={modalFocusX} focusY={modalFocusY} focusVisible={modalFocusVisible} videoUrl={modalVideoUrl} isVideo={!!modalVideoFile || !!modalVideoUrl} fileName={modalFileName} videoVolume={modalVideoVolume} onVideoVolumeChange={setModalVideoVolume} clarityPoints={modalClarityPoints} onImageSelect={handleImageSelect} onPreviewClick={handlePreviewClick} onRemoveFocus={handleRemoveFocus} onPasteImage={handlePasteImage} onPreviewCtrlClick={handlePreviewCtrlClick} onPreviewCtrlRightClick={handlePreviewCtrlRightClick} />
            <div className="modal-buttons">
              <button className="btn btn-secondary" onClick={closeModal}>Cancel</button>
              <button className="btn btn-danger" onClick={removeProgramCategoryBg}>Remove BG</button>
              <button className="btn btn-primary" onClick={updateProgramCategory}>Update</button>
            </div>
          </div>
        </div>
      ) : modal?.type === 'programDisplayMode' ? (
        <div className="modal visible" onMouseDown={closeModal}>
          <div className="modal-content" onMouseDown={e => e.stopPropagation()}>
            <h2>Edit Program Display Mode</h2>
            <label>Layout Mode</label>
            <select value={modalMode} onChange={e => setModalMode(e.target.value)}>
              <option value="horizontal">Horizontal (Scroll)</option>
              <option value="box">Box (Adaptive Grid)</option>
            </select>
            <label>Size Mode</label>
            <select value={modalSize} onChange={e => setModalSize(e.target.value)}>
              <option value="normal">Normal</option>
              <option value="mini">Mini</option>
            </select>
            <div className="modal-buttons">
              <button className="btn btn-secondary" onClick={closeModal}>Cancel</button>
              <button className="btn btn-primary" onClick={updateProgramDisplayMode}>Update</button>
            </div>
          </div>
        </div>
      ) : modal?.type === 'editCategory' ? (
        <div className="modal visible" onMouseDown={closeModal}>
          <div className="modal-content" onMouseDown={e => e.stopPropagation()}>
            <h2>Edit Category</h2>
            <input type="text" placeholder="Category name" value={modalName} onChange={e => setModalName(e.target.value)} />
            <TagInput label="Tags" tags={modalTags} setTags={setModalTags} />
            <TagInput label="Decorations" tags={modalDecorations} setTags={setModalDecorations} />
            <ImageSection previewUrl={modalPreviewUrl} previewVisible={modalPreviewVisible} focusX={modalFocusX} focusY={modalFocusY} focusVisible={modalFocusVisible} videoUrl={modalVideoUrl} isVideo={!!modalVideoFile || !!modalVideoUrl} fileName={modalFileName} videoVolume={modalVideoVolume} onVideoVolumeChange={setModalVideoVolume} clarityPoints={modalClarityPoints} onImageSelect={handleImageSelect} onPreviewClick={handlePreviewClick} onRemoveFocus={handleRemoveFocus} onPasteImage={handlePasteImage} onPreviewCtrlClick={handlePreviewCtrlClick} onPreviewCtrlRightClick={handlePreviewCtrlRightClick} />
            <div className="modal-buttons">
              <button className="btn btn-secondary" onClick={closeModal}>Cancel</button>
              <button className="btn btn-danger" onClick={removeCategoryBg}>Remove BG</button>
              <button className="btn btn-primary" onClick={updateCategory}>Update</button>
            </div>
          </div>
        </div>
      ) : modal?.type === 'editLibrary' ? (
        <div className="modal visible" onMouseDown={closeModal}>
          <div className="modal-content" onMouseDown={e => e.stopPropagation()}>
            <h2>Edit Library</h2>
            <input type="text" placeholder="Library name" value={modalName} onChange={e => setModalName(e.target.value)} />
            <label>Select Prompt IDs (comma separated)</label>
            <input type="text" placeholder="e.g. prompt_id1, prompt_id2" value={modalPromptIds} onChange={e => setModalPromptIds(e.target.value)} />
            <ImageSection previewUrl={modalPreviewUrl} previewVisible={modalPreviewVisible} focusX={modalFocusX} focusY={modalFocusY} focusVisible={modalFocusVisible} videoUrl={modalVideoUrl} isVideo={!!modalVideoFile || !!modalVideoUrl} fileName={modalFileName} videoVolume={modalVideoVolume} onVideoVolumeChange={setModalVideoVolume} clarityPoints={modalClarityPoints} onImageSelect={handleImageSelect} onPreviewClick={handlePreviewClick} onRemoveFocus={handleRemoveFocus} onPasteImage={handlePasteImage} onPreviewCtrlClick={handlePreviewCtrlClick} onPreviewCtrlRightClick={handlePreviewCtrlRightClick} />
            <div className="modal-buttons">
              <button className="btn btn-secondary" onClick={closeModal}>Cancel</button>
              <button className="btn btn-danger" onClick={deleteLibrary}>Delete</button>
              <button className="btn btn-primary" onClick={updateLibrary}>Update</button>
            </div>
          </div>
        </div>
      ) : modal?.type === 'editLoraFolder' ? (
        <div className="modal visible" onMouseDown={closeModal}>
          <div className="modal-content" onMouseDown={e => e.stopPropagation()}>
            <h2>Edit Lora Folder Background</h2>
            <label>Folder: {modalOldName}</label>
            <ImageSection previewUrl={modalPreviewUrl} previewVisible={modalPreviewVisible} focusX={modalFocusX} focusY={modalFocusY} focusVisible={modalFocusVisible} videoUrl={modalVideoUrl} isVideo={!!modalVideoFile || !!modalVideoUrl} fileName={modalFileName} videoVolume={modalVideoVolume} onVideoVolumeChange={setModalVideoVolume} clarityPoints={modalClarityPoints} onImageSelect={handleImageSelect} onPreviewClick={handlePreviewClick} onRemoveFocus={handleRemoveFocus} onPasteImage={handlePasteImage} onPreviewCtrlClick={handlePreviewCtrlClick} onPreviewCtrlRightClick={handlePreviewCtrlRightClick} />
            <div className="modal-buttons">
              <button className="btn btn-secondary" onClick={closeModal}>Cancel</button>
              <button className="btn btn-danger" onClick={removeLoraFolderBg}>Remove BG</button>
              <button className="btn btn-primary" onClick={updateLoraFolder}>Update</button>
            </div>
          </div>
        </div>
      ) : modal?.type === 'displayMode' ? (
        <div className="modal visible" onMouseDown={closeModal}>
          <div className="modal-content" onMouseDown={e => e.stopPropagation()}>
            <h2>Edit {modalIsCat?'Category':'Library'} Display Mode</h2>
            <label>Layout Mode</label>
            <select value={modalMode} onChange={e => setModalMode(e.target.value)}>
              <option value="horizontal">Horizontal (Scroll)</option>
              <option value="box">Box (Adaptive Grid)</option>
            </select>
            <label>Size Mode</label>
            <select value={modalSize} onChange={e => setModalSize(e.target.value)}>
              <option value="normal">Normal</option>
              <option value="mini">Mini</option>
            </select>
            <div className="modal-buttons">
              <button className="btn btn-secondary" onClick={closeModal}>Cancel</button>
              <button className="btn btn-primary" onClick={updateDisplayMode}>Update</button>
            </div>
          </div>
        </div>
      ) : modal?.type === 'addPrefab' ? (
        <div className="modal visible" onMouseDown={closeModal}>
          <div className="modal-content" onMouseDown={e => e.stopPropagation()}>
            <h2>Add Prefab</h2>
            <input type="text" placeholder="Prefab name" value={modalName} onChange={e => setModalName(e.target.value)} />
            <ImageSection previewUrl={modalPreviewUrl} previewVisible={modalPreviewVisible} focusX={modalFocusX} focusY={modalFocusY} focusVisible={modalFocusVisible} videoUrl={modalVideoUrl} isVideo={!!modalVideoFile || !!modalVideoUrl} fileName={modalFileName} videoVolume={modalVideoVolume} onVideoVolumeChange={setModalVideoVolume} clarityPoints={modalClarityPoints} onImageSelect={handleImageSelect} onPreviewClick={handlePreviewClick} onRemoveFocus={handleRemoveFocus} onPasteImage={handlePasteImage} onPreviewCtrlClick={handlePreviewCtrlClick} onPreviewCtrlRightClick={handlePreviewCtrlRightClick} />
            <div className="modal-buttons">
              <button className="btn btn-secondary" onClick={closeModal}>Cancel</button>
              <button className="btn btn-primary" onClick={e => { e.stopPropagation(); e.preventDefault(); addPrefab(); }}>Save Prefab</button>
            </div>
          </div>
        </div>
      ) : modal?.type === 'editPrefab' ? (
        <div className="modal visible" onMouseDown={closeModal}>
          <div className="modal-content wide" onMouseDown={e => e.stopPropagation()}>
            <h2>Edit Prefab</h2>
            <div className="edit-prefab-body row">
              <div className="edit-prefab-left">
                <div className="edit-prefab-section">
                  <label>Prefab name</label>
                  <input type="text" placeholder="Prefab name" value={modalName} onChange={e => setModalName(e.target.value)} />
                </div>
                <div className="edit-prefab-section">
                  <label>Custom Prompts</label>
                  <textarea placeholder="Custom prompts text..." value={modalCustomPrompts} onChange={e => setModalCustomPrompts(e.target.value)}></textarea>
                </div>
                <div className="edit-prefab-section">
                  <label>Preview Image</label>
                  <ImageSection previewUrl={modalPreviewUrl} previewVisible={modalPreviewVisible} focusX={modalFocusX} focusY={modalFocusY} focusVisible={modalFocusVisible} videoUrl={modalVideoUrl} isVideo={!!modalVideoFile || !!modalVideoUrl} fileName={modalFileName} videoVolume={modalVideoVolume} onVideoVolumeChange={setModalVideoVolume} clarityPoints={modalClarityPoints} onImageSelect={handleImageSelect} onPreviewClick={handlePreviewClick} onRemoveFocus={handleRemoveFocus} onPasteImage={handlePasteImage} onPreviewCtrlClick={handlePreviewCtrlClick} onPreviewCtrlRightClick={handlePreviewCtrlRightClick} />
                </div>
              </div>
              <div className="edit-prefab-right">
                <div className="edit-prefab-columns">
                  <div className="edit-prefab-section">
                    <label>Tags ({modalPrefabTags.length})</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                      {modalPrefabTags.map((group, i) => (
                        <span className="tag" key={i}>
                          {tagsToDisplayName(group)}
                          <span className="remove" onClick={() => setModalPrefabTags(prev => prev.filter((_, j) => j !== i))}>{iconX}</span>
                        </span>
                      ))}
                    </div>
                    <div style={{ position: 'relative' }}>
                      <input
                        ref={tagInputRef}
                        type="text"
                        placeholder="Add tags, press Enter..."
                        style={{ fontSize: 12, width: '100%' }}
                        onChange={handleTagInputChange}
                        onKeyDown={handleTagInputKeyDown}
                        onBlur={() => setTimeout(() => setTagInputShowDropdown(false), 200)}
                      />
                      {tagInputShowDropdown && filteredTagSuggestions.length > 0 ? (
                        <div ref={tagDropdownRef} className="kolid-dropdown-scroll" style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, maxHeight: 180, overflowY: 'auto', background: '#2c2c2e', borderRadius: 10, marginBottom: 4, zIndex: 100, boxShadow: '0 -4px 16px rgba(0,0,0,0.4)' }}>
                          {filteredTagSuggestions.map(([text, name], i) => (
                            <div
                              key={text}
                              ref={i === tagInputSelIdx ? selItemRef : null}
                              onMouseDown={e => { e.preventDefault(); selectTagSuggestion(text); }}
                              style={{
                                padding: '8px 14px', fontSize: 14, cursor: 'pointer',
                                color: '#fff', background: i === tagInputSelIdx ? '#3a3a3c' : 'transparent',
                                fontFamily: '-apple-system, system-ui, Helvetica Neue, sans-serif',
                                display: 'flex', alignItems: 'center',
                              }}
                            >
                              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
                              {name !== text ? <span style={{ color: '#8e8e93', fontSize: 13, borderLeft: '1px solid #444', paddingLeft: 12, marginLeft: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1 }}>{name}</span> : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <div className="edit-prefab-section">
                    <label>Loras ({modalPrefabLoras.length})</label>
                    <div className="lora-list">
                      {modalPrefabLoras.map((l, i) => {
                        const item = Object.values(loraData).flat().find(it => it.file_path === l.file_path);
                        if (!item) return null;
                        return (
                          <Lora
                            key={l.file_path}
                            lora={item}
                            initialActiveTags={l.active_tags}
                            initialStrength={l.strength}
                            initialActive={l.active}
                            initialSplitMode={l.split_mode}
                            isFiltered={isLoraFiltered(item)}
                            onChange={(data) => setModalPrefabLoras(prev => prev.map((pl, j) => j === i ? { ...pl, strength: data.strength, active_tags: data.activeTags, active: data.active, split_mode: data.split_mode } : pl))}
                            onRemove={() => setModalPrefabLoras(prev => prev.filter((_, j) => j !== i))}
                          />
                        );
                      })}
                    </div>
                    <button className="btn btn-secondary" style={{ width: '100%', fontSize: 13, height: 36, padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }} onClick={() => {
                      tempCtx.push({
                        type: 'lora',
                        title: 'Select Loras',
                        selections: [],
                        restorePoint: {
                          name: modalName,
                          customPrompts: modalCustomPrompts,
                          prefabTags: modalPrefabTags,
                          prefabLoras: modalPrefabLoras,
                          prefabSelectedPrefabs: modalPrefabSelectedPrefabs,
                          previewUrl: modalPreviewUrl,
                          previewVisible: modalPreviewVisible,
                          focusX: modalFocusX,
                          focusY: modalFocusY,
                          focusVisible: modalFocusVisible,
                          modalData: modal.data as { lib: string; idx: number },
                        },
                      });
                      closeModal();
                    }}>
                      {iconPlus} Add Lora
                    </button>
                  </div>
                  <div className="edit-prefab-section">
                    <label>Prefabs ({modalPrefabSelectedPrefabs.length})</label>
                    <div className="prefab-list">
                      {modalPrefabSelectedPrefabs.map((sp, i) => {
                        const pf = findPrefabByGuid(sp.guid);
                        const fp = (() => {
                          for (const [libName, libData] of Object.entries(allLibraries)) {
                            const idx = (libData.prefabs || []).findIndex(p => p.guid === sp.guid);
                            if (idx !== -1) return focusPoints[`prefab_${libName}_${idx}`];
                          }
                          return undefined;
                        })();
                        return (
                          <div key={sp.guid} className="prefab-card" style={{ cursor: 'default' }}>
                            {pf?.preview && <img className="prefab-card-bg" src={imgUrl(pf.preview)} alt="" style={fp ? { objectPosition: `${fp.x}% ${fp.y}%` } : {}} />}
                            <div className="prefab-card-header">
                              <span className="prefab-card-name">{pf?.name || sp.guid}</span>
                              <div className="prefab-card-actions">
                                <button className="prefab-card-btn edit" onClick={() => {
                                  const loc = (() => {
                                    for (const [libName, libData] of Object.entries(allLibraries)) {
                                      const idx = (libData.prefabs || []).findIndex(p => p.guid === sp.guid);
                                      if (idx !== -1) return { lib: libName, idx };
                                    }
                                    return null;
                                  })();
                                  if (loc) {
                                    const target = allLibraries[loc.lib]?.prefabs?.[loc.idx];
                                    tempCtx.clear();
                                    setModalName(target?.name || '');
                                    setModalCustomPrompts(target?.custom_prompts || '');
                                    setModalPrefabTags((target?.tag_groups || []) as TagGroup[]);
                                    setModalPrefabLoras((target?.loras || []) as LoraSelectionData[]);
                                    setModalPrefabSelectedPrefabs((target?.selected_prefabs || []) as SelectedPrefabRef[]);
                                    setModalPreviewUrl(target?.preview ? imgUrl(target.preview) : '');
                                    setModalPreviewVisible(!!target?.preview);
                                    setModal({ type: 'editPrefab', data: { lib: loc.lib, idx: loc.idx } });
                                  }
                                }}>{iconGear}</button>
                                <button className="prefab-card-btn remove" onClick={() => setModalPrefabSelectedPrefabs(prev => prev.filter((_, j) => j !== i))}>{iconX}</button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <button className="btn btn-secondary" style={{ width: '100%', fontSize: 13, height: 36, padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }} onClick={() => {
                      tempCtx.push({
                        type: 'prefab',
                        title: 'Select Prefabs',
                        selections: [],
                        restorePoint: {
                          name: modalName,
                          customPrompts: modalCustomPrompts,
                          prefabTags: modalPrefabTags,
                          prefabLoras: modalPrefabLoras,
                          prefabSelectedPrefabs: modalPrefabSelectedPrefabs,
                          previewUrl: modalPreviewUrl,
                          previewVisible: modalPreviewVisible,
                          focusX: modalFocusX,
                          focusY: modalFocusY,
                          focusVisible: modalFocusVisible,
                          modalData: modal.data as { lib: string; idx: number },
                        },
                      });
                      closeModal();
                    }}>
                      {iconPlus} Add Prefab
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-buttons">
              <button className="btn btn-secondary" onClick={closeModal}>Cancel</button>
              <button className="btn btn-secondary" onClick={syncPrefab}>Sync</button>
              <button className="btn btn-primary" onClick={e => { e.stopPropagation(); e.preventDefault(); updatePrefab(); }}>Update</button>
            </div>
          </div>
        </div>
      ) : modal?.type === 'editSelectedPrefab' ? (
        <div className="modal visible" onMouseDown={closeModal}>
          <div className={`modal-content ${findPrefabByGuid(modal.data?.guid || '')?.preview ? 'has-bg-image' : ''}`} onMouseDown={e => e.stopPropagation()}>
            <h2>Edit Prefab</h2>
            {(() => {
              const guid = modal.data?.guid;
              function findNode(items: SelectedPrefabItem[]): SelectedPrefabItem | null {
                for (const item of items) {
                  if (item.guid === guid) return item;
                  const found = findNode(item.children);
                  if (found) return found;
                }
                return null;
              }
              const node = findNode(selectedPrefabs);
              const pf = guid ? findPrefabByGuid(guid) : null;
              const fp = guid ? (() => {
                for (const [libName, libData] of Object.entries(allLibraries)) {
                  const idx = (libData.prefabs || []).findIndex(p => p.guid === guid);
                  if (idx !== -1) return focusPoints[`prefab_${libName}_${idx}`];
                }
                return undefined;
              })() : undefined;
              if (!node || !pf) return <p style={{ color: 'var(--text-secondary)' }}>Prefab not found</p>;
              return (
                <>
                  {pf.preview && (
                    <div className="modal-glass-bg">
                      <div className="modal-glass-img" style={{ backgroundImage: `url(${imgUrl(pf.preview)})`, backgroundPosition: fp ? `${fp.x}% ${fp.y}%` : 'center center' }} />
                      <div className="modal-glass-blur" />
                    </div>
                  )}
                  <div className="edit-prefab-body">
                    <div className="edit-prefab-title">{pf.name}</div>

                    <div className="edit-prefab-section">
                      <div className="edit-prefab-row">
                        <span>Active</span>
                        <TextToggle text={node.active ? 'On' : 'Off'} active={node.active} onClick={() => togglePrefabActive(node.guid)} />
                      </div>
                    </div>

                    {node.tag_groups.length > 0 && (
                      <div className="edit-prefab-section">
                        <label>Tags</label>
                        <div className="text-toggle-list">
                          {node.tag_groups.map(t => (
                            <TextToggle key={t.key} text={t.key} active={t.active} onClick={() => togglePrefabTag(node.guid, t.key)} />
                          ))}
                        </div>
                      </div>
                    )}

                    {node.loras.length > 0 && (
                      <div className="edit-prefab-section">
                        <label>Loras</label>
                        <div className="text-toggle-list">
                          {node.loras.map(l => {
                            let loraName = l.file_path;
                            for (const items of Object.values(loraData)) {
                              const found = items.find(it => it.file_path === l.file_path);
                              if (found) { loraName = found.name; break; }
                            }
                            return <TextToggle key={l.file_path} text={loraName} active={l.active} onClick={() => togglePrefabLora(node.guid, l.file_path)} />;
                          })}
                        </div>
                      </div>
                    )}

                    {node.children.length > 0 && (
                      <div className="edit-prefab-section">
                        <label>Nested Prefabs</label>
                        <div className="modal-nested-list">
                          {node.children.map(c => {
                            const childPf = findPrefabByGuid(c.guid);
                            if (!childPf) return null;
                            return (
                              <div key={c.guid} className={`modal-nested-item ${c.active ? '' : 'inactive'}`}>
                                <span className="name">{childPf.name}</span>
                                <div className="actions">
                                  <button className="nested-edit" title="Edit" onClick={(e) => { e.stopPropagation(); setModalStack(prev => [...prev, modal!.data.guid]); setModal({ type: 'editSelectedPrefab', data: { guid: c.guid } }); }}>{iconGear}</button>
                                  <button className="nested-merge" title="Merge" onClick={(e) => { e.stopPropagation(); mergePrefab(childPf); }}>{iconLayers}</button>
                                  <button className="nested-delete" title="Delete" onClick={(e) => { e.stopPropagation(); removeSelectedPrefab(c.guid); }}>{iconX}</button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              );
            })()}
            <div className="modal-buttons">
              <button className="btn btn-secondary" onClick={closeModal}>{modalStack.length > 0 ? 'Back' : 'Close'}</button>
            </div>
          </div>
        </div>
      ) : modal ? (
        <div className="modal visible" onMouseDown={closeModal}>
          <div className="modal-content" onMouseDown={e => e.stopPropagation()}>
            <h2>{modal.type}</h2>
            <div className="modal-buttons"><button className="btn btn-secondary" onClick={closeModal}>Close</button></div>
          </div>
        </div>
      ) : null}

      {errorModal ? (
        <div className="modal visible" onMouseDown={closeModal}>
          <div className="modal-content" onMouseDown={e => e.stopPropagation()}>
            <h2 style={{ color: '#ff3b30' }}>{errorModal.title}</h2>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 8 }}>{errorModal.message}</p>
            <div className="modal-buttons">
              <button className="btn btn-secondary" onClick={closeModal}>Close</button>
            </div>
          </div>
        </div>
      ) : null}

      {loadFromImageData ? (
        <div className="modal visible" onMouseDown={() => setLoadFromImageData(null)}>
          <div className="modal-content" style={{ maxWidth: 400 }} onMouseDown={e => e.stopPropagation()}>
            <h2>Load From Image</h2>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 8 }}>
              Choose how to load the data from the image:
            </p>
            <div className="modal-buttons" style={{ justifyContent: 'center', gap: 12 }}>
              <button className="btn btn-success" onClick={() => applyLoadedData('merge')}>Merge</button>
              <button className="btn btn-primary" onClick={() => applyLoadedData('replace')}>Replace</button>
              <button className="btn btn-secondary" onClick={() => setLoadFromImageData(null)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function getPrefabClass(
  prefabTags: TagGroup[],
  selectedTags: TagGroup[],
  prefabLoras: LoraSelectionData[],
  selectedLoras: LoraItemData[],
  loraSelections: Record<string, { activeTags: string[]; active: boolean }>
): string {
  // Prompt matching
  let promptMatchCount = 0;
  for (const pfGroup of prefabTags) {
    const pfDisplay = tagsToDisplayName(pfGroup);
    for (const selGroup of selectedTags) {
      if (tagsToDisplayName(selGroup) === pfDisplay) { promptMatchCount++; break; }
    }
  }

  // Lora matching
  let loraMatchCount = 0;
  for (const pl of prefabLoras) {
    const path = pl.file_path || (pl as any).file_name;
    const selLora = selectedLoras.find(l => l.file_path === path);
    if (!selLora) continue;
    const selData = loraSelections[path];
    if (!selData) continue;
    if (pl.active && !selData.active) continue;
    const currentTags = new Set(selData.activeTags || []);
    const prefabTagList = pl.active_tags || [];
    let allTagsMatch = true;
    for (const tag of prefabTagList) {
      if (!currentTags.has(tag)) { allTagsMatch = false; break; }
    }
    if (allTagsMatch) loraMatchCount++;
  }

  const allPromptsMatch = prefabTags.length === 0 || promptMatchCount === prefabTags.length;
  const allLorasMatch = prefabLoras.length === 0 || loraMatchCount === prefabLoras.length;
  const somePromptsMatch = promptMatchCount > 0;
  const someLorasMatch = loraMatchCount > 0;

  if (allPromptsMatch && allLorasMatch) return 'prefab-full';
  if (somePromptsMatch || someLorasMatch) return 'prefab-partial';
  return '';
}

function ImageSection({
  previewUrl, previewVisible, focusX, focusY, focusVisible,
  videoUrl, isVideo, fileName, videoVolume, onVideoVolumeChange,
  clarityPoints,
  onImageSelect, onPreviewClick, onRemoveFocus, onPasteImage, onPreviewCtrlClick, onPreviewCtrlRightClick,
}: {
  previewUrl: string; previewVisible: boolean; focusX: number; focusY: number; focusVisible: boolean;
  videoUrl?: string; isVideo?: boolean; fileName?: string;
  videoVolume?: number; onVideoVolumeChange?: (v: number) => void;
  clarityPoints?: Array<{x:number;y:number}>;
  onImageSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onPreviewClick: (e: React.MouseEvent<HTMLElement>) => void;
  onRemoveFocus: (e: React.MouseEvent) => void;
  onPasteImage?: (file: File) => void;
  onPreviewCtrlClick?: (e: React.MouseEvent<HTMLElement>) => void;
  onPreviewCtrlRightClick?: (e: React.MouseEvent) => void;
}) {
  const markerLeft = focusX;
  const markerTop = focusY;
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!onPasteImage) return;
    const el = rowRef.current;
    if (!el) return;
    const handler = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          e.preventDefault();
          const blob = items[i].getAsFile();
          if (blob) onPasteImage(blob);
          break;
        }
      }
    };
    el.addEventListener('paste', handler);
    // Also listen on the document when this section is focused/visible
    document.addEventListener('paste', handler);
    return () => {
      el.removeEventListener('paste', handler);
      document.removeEventListener('paste', handler);
    };
  }, [onPasteImage]);

  const handlePasteClick = useCallback(async () => {
    if (!onPasteImage) return;
    try {
      const permission = await (navigator as any).permissions?.query({ name: 'clipboard-read' });
      if (permission && permission.state === 'denied') {
        alert('Clipboard permission denied. Please use Ctrl+V to paste image.');
        return;
      }
    } catch {}
    try {
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            const blob = await item.getType(type);
            const file = new File([blob], `pasted-image.${type.split('/')[1] || 'png'}`, { type });
            onPasteImage(file);
            return;
          }
        }
      }
      alert('No image found in clipboard. Please copy an image first or use Ctrl+V.');
    } catch {
      alert('Failed to read clipboard. Please use Ctrl+V to paste image.');
    }
  }, [onPasteImage]);

  return (<>
    <div className="image-input-row" ref={rowRef} tabIndex={-1}>
      <label className="file-choose-btn">
        <input type="file" accept="image/*,video/*" onChange={onImageSelect} />
        Choose File
      </label>
      <span className="file-name-display">{fileName || ''}</span>
      {onPasteImage ? (
        <button className="btn btn-secondary paste-image-btn" type="button" onClick={handlePasteClick} title="Paste image from clipboard (Ctrl+V)">
          {iconClipboard} Paste
        </button>
      ) : null}
    </div>
    <div className="image-preview-container">
      {isVideo && videoUrl ? <video
        className={`image-preview${previewVisible ? ' visible' : ''}`} src={videoUrl} muted loop autoPlay
        onClick={e => { if (e.ctrlKey || e.metaKey) { onPreviewCtrlClick?.(e); } else { onPreviewClick(e); } }}
        onContextMenu={e => { if (e.ctrlKey || e.metaKey) { onPreviewCtrlRightClick?.(e); } else { onRemoveFocus(e); } }}
      /> : previewUrl ? <img
        className={`image-preview${previewVisible ? ' visible' : ''}`} src={previewUrl} alt="Preview"
        onClick={e => { if (e.ctrlKey || e.metaKey) { onPreviewCtrlClick?.(e); } else { onPreviewClick(e); } }}
        onContextMenu={e => { if (e.ctrlKey || e.metaKey) { onPreviewCtrlRightClick?.(e); } else { onRemoveFocus(e); } }}
      /> : null}
      {(clarityPoints || []).map((p, i) => (
        <div key={i} className="clarity-marker" style={{ left: `${p.x}%`, top: `${p.y}%` }} />
      ))}
      <div className="focus-marker" style={{
        left: `${markerLeft}%`, top: `${markerTop}%`,
        display: focusVisible ? 'block' : 'none',
      }} />
    </div>
    {isVideo && videoUrl && onVideoVolumeChange ? (
      <div className="video-volume-row">
        <label className="video-volume-label">Volume</label>
        <input type="range" min="0" max="1" step="0.01" value={videoVolume ?? 0}
          onChange={e => onVideoVolumeChange(parseFloat(e.target.value))}
          style={{ accentColor: 'var(--accent-color, #6c8aff)' }}
        />
        <span className="video-volume-value">{Math.round((videoVolume ?? 0) * 100)}%</span>
      </div>
    ) : null}
  </>);
}
function TagStrengthEditor({
  displayName,
  strength,
  showStrength,
  fromParsing,
  programFiltered,
  sourceProgram,
  dragIndex,
  onReorder,
  onStrengthChange,
  onRemove,
}: {
  displayName: string;
  strength: number;
  showStrength: boolean;
  fromParsing: boolean;
  programFiltered: boolean;
  sourceProgram: boolean;
  dragIndex: number;
  onReorder: (toIdx: number) => void;
  onStrengthChange: (v: number) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [tempValue, setTempValue] = useState(String(strength));
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const spanRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEdit = () => {
    setTempValue(String(strength));
    setEditing(true);
  };

  const commit = () => {
    const v = parseFloat(tempValue);
    if (!isNaN(v)) {
      onStrengthChange(v);
    }
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commit();
    } else if (e.key === 'Escape') {
      setEditing(false);
    }
  };

  return (
    <span
      ref={spanRef}
      className={`tag tag-with-strength${showStrength ? ' has-strength' : ''}${fromParsing ? ' parsed-tag' : ''}${programFiltered ? ' program-filtered' : ''}${sourceProgram ? ' source-program' : ''}${dragOver ? ' drag-over' : ''}`}
      onClick={editing ? undefined : startEdit}
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(dragIndex));
        e.dataTransfer.effectAllowed = 'move';
        spanRef.current?.classList.add('dragging');
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
        if (!isNaN(fromIdx) && fromIdx !== dragIndex) {
          onReorder(fromIdx);
        }
      }}
      onDragEnd={() => {
        spanRef.current?.classList.remove('dragging');
      }}
    >
      <span className="tag-strength-overlay">
        {showStrength ? `:${strength}` : ''}
      </span>
      <span className="tag-content">
        {displayName}
      </span>
      <span className="remove" onClick={(e) => { e.stopPropagation(); onRemove(); }}>{iconX}</span>
      {editing ? (
        <span className="tag-strength-editor" onClick={(e) => e.stopPropagation()}>
          <input
            ref={inputRef}
            type="number"
            step="0.1"
            min="0"
            max="10"
            value={tempValue}
            onChange={(e) => setTempValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={commit}
          />
        </span>
      ) : null}
    </span>
  );
}

function TagInput({label, tags, setTags}: {label:string; tags:string[]; setTags:(t:string[])=>void}) {
  const [val, setVal] = useState('');
  const add = () => { const v = val.trim(); if(v && !tags.includes(v)) { setTags([...tags, v]); } setVal(''); };
  return (
    <div className="tag-input-container">
      <label>{label}</label>
      <div className="tag-input-row">
        <input type="text" placeholder={`Enter ${label.toLowerCase()}...`} value={val} onChange={e => setVal(e.target.value)} onKeyDown={e => { if(e.key==='Enter') add(); }} />
        <button className="btn btn-primary" onClick={add}>Add {label.slice(-1)==='s'?label.slice(0,-1):label}</button>
      </div>
      <div className="tag-list">
        {tags.map((t,i) => <span className="tag-chip" key={i}>{t}<span className="tag-remove" onClick={() => setTags(tags.filter((_,j)=>j!==i))}>{iconX}</span></span>)}
      </div>
    </div>
  );
}
