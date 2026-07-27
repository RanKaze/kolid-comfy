import { useState, useCallback } from 'react';
import type { Tag, TagGroup, PromptData, AllPrompts, TemporaryContext } from '../types';

function toList(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v.map(s => s.toLowerCase());
  if (typeof v === 'string') return v.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return [];
}

export function tagsToDisplayName(group: TagGroup): string {
  const names = group.tags.map(t => t.name || t.prompt);
  const nameStr = names.join(' ');
  if (group.strength !== 1.0) {
    return `${nameStr}:${group.strength}`;
  }
  return nameStr;
}

export function tagsToDisplayString(group: TagGroup): string {
  const parts = group.tags.map((tag, i) => {
    const decoLevel = group.tags.length - 1 - i; // last = 0 (base), earlier = higher
    if (decoLevel > 0) {
      const brackets = '['.repeat(decoLevel);
      const closing = ']'.repeat(decoLevel);
      return `${brackets}${tag.prompt}${closing}`;
    }
    return tag.prompt;
  });
  const text = parts.join(' ');
  if (group.strength !== 1.0) {
    return `(${text}:${group.strength})`;
  }
  return text;
}

function findPromptName(promptText: string, allPrompts: AllPrompts): string {
  for (const [, catData] of Object.entries(allPrompts)) {
    const prompts = (catData as { prompts?: PromptData[] }).prompts || [];
    for (const p of prompts) {
      if (p.prompt === promptText) return p.name || promptText;
    }
  }
  return promptText;
}

function findPromptCategory(promptText: string, allPrompts: AllPrompts): string {
  for (const [cat, catData] of Object.entries(allPrompts)) {
    const prompts = (catData as { prompts?: PromptData[] }).prompts || [];
    for (const p of prompts) {
      if (p.prompt === promptText) return cat;
    }
  }
  return '';
}

function findPromptByName(nameText: string, allPrompts: AllPrompts): { name: string; prompt: string; category: string } | null {
  for (const [cat, catData] of Object.entries(allPrompts)) {
    const prompts = (catData as { prompts?: PromptData[] }).prompts || [];
    for (const p of prompts) {
      if (p.name === nameText) return { name: p.name, prompt: p.prompt, category: cat };
    }
  }
  return null;
}

function createTag(promptText: string, allPrompts: AllPrompts): Tag {
  const name = findPromptName(promptText, allPrompts);
  const category = findPromptCategory(promptText, allPrompts);
  if (name === promptText) {
    const byName = findPromptByName(promptText, allPrompts);
    if (byName) {
      return { name: byName.name, prompt: byName.prompt, category: byName.category };
    }
  }
  return { name, prompt: promptText, category };
}

export function parseStringToTags(str: string, allPrompts: AllPrompts): TagGroup {
  let strength = 1.0;
  let body = str;
  const fullStrengthMatch = str.match(/^\((.*):(\d*\.?\d+)\)$/);
  if (fullStrengthMatch) {
    body = fullStrengthMatch[1].trim();
    strength = parseFloat(fullStrengthMatch[2]);
  }
  const tags: Tag[] = parseStringToTagsImpl(body, allPrompts);
  return { tags, strength, source: 'normal' as const };
}

function parseStringToTagsImpl(str: string, allPrompts: AllPrompts): Tag[] {
  const tags: Tag[] = [];
  let pos = 0;
  while (pos < str.length) {
    const bracketMatch = str.slice(pos).match(/^(\[+)([^\]]+)\]+/);
    if (bracketMatch) {
      const content = bracketMatch[2].trim();
      tags.push(createTag(content, allPrompts));
      pos += bracketMatch[0].length;
    } else {
      const remaining = str.slice(pos);
      const nextBracket = remaining.indexOf('[');
      if (nextBracket === -1) {
        const text = remaining.trim();
        if (text) tags.push(createTag(text, allPrompts));
        break;
      } else {
        const text = remaining.slice(0, nextBracket).trim();
        if (text) tags.push(createTag(text, allPrompts));
        pos += nextBracket;
      }
    }
  }
  return tags;
}

export function findPromptData(prompt: string, allPrompts: AllPrompts): (PromptData & { category: string }) | null {
  for (const [cat, catData] of Object.entries(allPrompts)) {
    const prompts = (catData as { prompts?: PromptData[] }).prompts || [];
    for (const p of prompts) {
      if (p.prompt === prompt) return { ...p, category: cat };
    }
  }
  return null;
}

export function isBasePromptSelectedInTags(prompt: string, selectedTags: TagGroup[]): boolean {
  return selectedTags.some(group => {
    const base = group.tags[group.tags.length - 1];
    return base && base.prompt === prompt;
  });
}

export function findTagGroupByBasePrompt(basePrompt: string, selectedTags: TagGroup[]): TagGroup | undefined {
  return selectedTags.find(group => {
    const base = group.tags[group.tags.length - 1];
    return base && base.prompt === basePrompt;
  });
}

export function findTagGroupIndex(basePrompt: string, selectedTags: TagGroup[]): number {
  return selectedTags.findIndex(group => {
    const base = group.tags[group.tags.length - 1];
    return base && base.prompt === basePrompt;
  });
}

export function combineTagGroups(
  tagGroups: TagGroup[],
  basePrompt: string,
  basePromptName: string,
  baseDecoNum: number,
  allPrompts: AllPrompts,
): TagGroup {
  const baseTag: Tag = { ...createTag(basePrompt, allPrompts), name: basePromptName };
  // Flatten all tags from child groups + base tag at the end
  const allTags: Tag[] = [...tagGroups.flatMap(g => g.tags), baseTag];
  const strength = tagGroups.length > 0 ? tagGroups[0].strength : 1.0;
  return { tags: allTags, strength, source: 'normal' as const };
}

type PromptRec = { original: string; name: string };

interface ParseCache {
  tagTextIdx: Map<string, Set<string>>;
  promptLowerMap: Map<string, PromptRec>;
  allPromptKeys: Set<string>;
  allPrompts: AllPrompts;
}

let parseCache: ParseCache | null = null;

function ensureCache(allPrompts: AllPrompts): ParseCache {
  if (parseCache && parseCache.allPrompts === allPrompts) return parseCache;

  const tagTextIdx = new Map<string, Set<string>>();
  const promptLowerMap = new Map<string, PromptRec>();
  const allPromptKeys = new Set<string>();

  for (const cd of Object.values(allPrompts)) {
    if (Array.isArray(cd)) {
      for (const p of cd) {
        if (!p || typeof p !== 'object') continue;
        const key = (p.prompt || '').toLowerCase();
        if (!key || promptLowerMap.has(key)) continue;
        promptLowerMap.set(key, { original: p.prompt, name: p.name || p.prompt });
        allPromptKeys.add(key);
      }
      continue;
    }

    const catTags = toList((cd as any).tags);
    const prompts: PromptData[] = (cd as any).prompts || [];

    for (const p of prompts) {
      if (!p || !p.prompt) continue;
      const key = p.prompt.toLowerCase();
      if (!promptLowerMap.has(key)) {
        promptLowerMap.set(key, { original: p.prompt, name: p.name || p.prompt });
      }
      allPromptKeys.add(key);

      const allTags = new Set<string>();
      for (const t of catTags) allTags.add(t);
      for (const t of toList(p.tags)) allTags.add(t);
      for (const t of allTags) {
        if (!tagTextIdx.has(t)) tagTextIdx.set(t, new Set());
        tagTextIdx.get(t)!.add(key);
      }
    }
  }

  parseCache = { tagTextIdx, promptLowerMap, allPromptKeys, allPrompts };
  return parseCache;
}

/**
 * Mirror of backend _try_decompose → decompose a list of space‑separated words
 * into decorations + base_prompt. All prompts are valid decoration candidates.
 */
function tryDecompose(words: string[], cache: ParseCache): string | null {
  // _find_all_base_prompts — suffix scan, longest first
  const candidates: { orig: string; before: string[] }[] = [];
  for (let start = 0; start < words.length; start++) {
    const key = words.slice(start).join(' ').toLowerCase();
    const rec = cache.promptLowerMap.get(key);
    if (rec) {
      candidates.push({ orig: rec.original, before: words.slice(0, start) });
    }
  }

  for (const { orig: basePrompt, before } of candidates) {
    let remaining = [...before];
    const decorationLevels: { level: number; text: string }[] = [];
    let ok = true;
    let level = 1;

    while (remaining.length > 0) {
      // All prompts are valid decorations — match suffix against all prompt keys
      let matched = false;
      for (let r = 0; r < remaining.length; r++) {
        const cand = remaining.slice(r).join(' ').toLowerCase();
        if (cache.allPromptKeys.has(cand)) {
          decorationLevels.push({ level, text: remaining.slice(r).join(' ') });
          remaining = remaining.slice(0, r);
          matched = true;
          break;
        }
      }
      if (!matched) { ok = false; break; }
      level++;
    }

    if (!ok) continue;

    // _build_bracket_output
    const parts: string[] = [];
    for (const { level: lvl, text } of decorationLevels) {
      parts.push('['.repeat(lvl) + text + ']'.repeat(lvl));
    }
    parts.reverse();
    return parts.join(' ') + ' ' + basePrompt;
  }
  return null;
}

/**
 * Mirror of backend _parse_raw_prompt — takes a comma‑separated raw text,
 * returns [last_selected_display_strings, custom_prompts_string].
 */
export function parseRawPrompts(raw: string, allPrompts: AllPrompts): [string[], string] {
  const cache = ensureCache(allPrompts);
  const text = raw.replace(/_/g, ' ');
  const segments = text.split(',').map(s => s.trim()).filter(Boolean);

  const matched: string[] = [];
  const custom: string[] = [];

  for (const seg of segments) {
    const key = seg.toLowerCase();

    // 1) exact whole-segment match
    const exact = cache.promptLowerMap.get(key);
    if (exact) {
      matched.push(exact.original);
      continue;
    }

    // 2) multi-word decompose via chain matching
    const words = seg.split(/\s+/);
    if (words.length > 1) {
      const result = tryDecompose(words, cache);
      if (result) {
        matched.push(result);
        continue;
      }
    }

    // 3) custom
    custom.push(seg);
  }

  return [matched, custom.join(', ')];
}

/** Convenience wrapper for CustomPromptsEditor — single segment decomposition */
export function tryParseLine(line: string, allPrompts: AllPrompts): { tagGroup: TagGroup; displayString: string } | null {
  const [groups, _custom] = parseRawPrompts(line, allPrompts);
  if (groups.length === 0) return null;

  const displayStr = groups[0];
  const tags = parseStringToTags(displayStr, allPrompts);
  return { tagGroup: tags, displayString: displayStr };
}

export function useSelection(allPrompts: AllPrompts) {
  const [selectedTags, setSelectedTags] = useState<TagGroup[]>([]);
  const [customPrompts, setCustomPrompts] = useState('');
  const [temporaryContextStack, setTemporaryContextStack] = useState<TemporaryContext[]>([]);

  const isTemporaryContext = temporaryContextStack.length > 0;
  const currentTemporaryContext = temporaryContextStack.length > 0
    ? temporaryContextStack[temporaryContextStack.length - 1]
    : null;

  const beginTemporaryContext = useCallback((
    matchFn: (p: PromptData, cat: string) => boolean,
    basePrompt: string,
    title: string,
  ) => {
    setTemporaryContextStack(prev => [...prev, {
      matchFn,
      basePrompt,
      title,
      tagGroups: [],
      originalExpandedCategories: new Set(),
      level: prev.length + 1,
    }]);
  }, []);

  const popTemporaryContext = useCallback(() => {
    setTemporaryContextStack(prev => prev.slice(0, -1));
  }, []);

  const completeCurrentLayer = useCallback(() => {
    if (temporaryContextStack.length === 0) return;
    const ctx = temporaryContextStack[temporaryContextStack.length - 1];
    const tagGroups = [...ctx.tagGroups];
    if (tagGroups.length === 0 && temporaryContextStack.length === 0) return;
    const basePromptData = findPromptData(ctx.basePrompt, allPrompts);
    const basePromptName = basePromptData ? basePromptData.name : '';
    const baseDecoNum = Math.max(0, ctx.level - 1);

    if (temporaryContextStack.length > 1) {
      const prevCtx = temporaryContextStack[temporaryContextStack.length - 2];
      const combined = combineTagGroups(tagGroups, ctx.basePrompt, basePromptName, baseDecoNum, allPrompts);
      prevCtx.tagGroups.push(combined);
    } else {
      const combined = combineTagGroups(tagGroups, ctx.basePrompt, basePromptName, baseDecoNum, allPrompts);
      setSelectedTags(prev => [...prev, combined]);
    }
    popTemporaryContext();
  }, [temporaryContextStack, allPrompts, popTemporaryContext]);

  return {
    selectedTags, setSelectedTags,
    customPrompts, setCustomPrompts,
    temporaryContextStack,
    isTemporaryContext,
    currentTemporaryContext,
    beginTemporaryContext,
    popTemporaryContext,
    completeCurrentLayer,
  };
}
