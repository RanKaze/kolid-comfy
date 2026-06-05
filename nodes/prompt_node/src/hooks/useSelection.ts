import { useState, useCallback } from 'react';
import type { Tag, TagGroup, PromptData, AllPrompts, TemporaryContext } from '../types';

export function tagsToDisplayName(tags: Tag[]): string {
  const names = tags.map(t => t.name || t.prompt);
  const nameStr = names.join(' ');
  const strength = tags[0]?.strength ?? 1.0;
  if (strength !== 1.0) {
    return `${nameStr}:${strength}`;
  }
  return nameStr;
}

export function tagsToDisplayString(tags: Tag[]): string {
  const parts = tags.map(tag => {
    if (tag.decoration_num > 0) {
      const brackets = '['.repeat(tag.decoration_num);
      const closing = ']'.repeat(tag.decoration_num);
      return `${brackets}${tag.prompt}${closing}`;
    }
    return tag.prompt;
  });
  const text = parts.join(' ');
  const strength = tags[0]?.strength ?? 1.0;
  if (strength !== 1.0) {
    return `(${text}:${strength})`;
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

function createTag(decorationNum: number, promptText: string, allPrompts: AllPrompts, strength?: number): Tag {
  return {
    decoration_num: decorationNum,
    name: findPromptName(promptText, allPrompts),
    prompt: promptText,
    strength,
  };
}

export function parseStringToTags(str: string, allPrompts: AllPrompts): Tag[] {
  // First, check if the entire string is wrapped in (content:strength)
  const fullStrengthMatch = str.match(/^\((.*):(\d*\.?\d+)\)$/);
  if (fullStrengthMatch) {
    const innerContent = fullStrengthMatch[1].trim();
    const strength = parseFloat(fullStrengthMatch[2]);
    const innerTags = parseStringToTagsImpl(innerContent, allPrompts);
    return innerTags.map(t => ({ ...t, strength }));
  }
  return parseStringToTagsImpl(str, allPrompts);
}

function parseStringToTagsImpl(str: string, allPrompts: AllPrompts): Tag[] {
  const tags: Tag[] = [];
  let pos = 0;
  while (pos < str.length) {
    const bracketMatch = str.slice(pos).match(/^(\[+)([^\]]+)\]+/);
    if (bracketMatch) {
      const decoNum = bracketMatch[1].length;
      const content = bracketMatch[2].trim();
      tags.push(createTag(decoNum, content, allPrompts));
      pos += bracketMatch[0].length;
    } else {
      const remaining = str.slice(pos);
      const nextBracket = remaining.indexOf('[');
      if (nextBracket === -1) {
        const text = remaining.trim();
        if (text) tags.push(createTag(0, text, allPrompts));
        break;
      } else {
        const text = remaining.slice(0, nextBracket).trim();
        if (text) tags.push(createTag(0, text, allPrompts));
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

export function getPromptDecorations(promptData: PromptData & { category: string }, allPrompts: AllPrompts): string[] {
  const ownDecorations: string[] = (promptData.decorations as string[]) || [];
  const catData = allPrompts[promptData.category] || {};
  const catDecorations: string[] = (catData.decorations as string[]) || [];
  const muteDecorations: string[] = (promptData.mute_decorations as string[]) || [];
  const allDecorations = [...new Set([...ownDecorations, ...catDecorations])];
  return allDecorations.filter(d => !muteDecorations.includes(d));
}

export function isBasePromptSelectedInTags(prompt: string, selectedTags: TagGroup[]): boolean {
  return selectedTags.some(group =>
    group.some(tag => tag.decoration_num === 0 && tag.prompt === prompt),
  );
}

export function findTagGroupByBasePrompt(basePrompt: string, selectedTags: TagGroup[]): TagGroup | undefined {
  return selectedTags.find(group =>
    group.some(tag => tag.decoration_num === 0 && tag.prompt === basePrompt),
  );
}

export function findTagGroupIndex(basePrompt: string, selectedTags: TagGroup[]): number {
  return selectedTags.findIndex(group =>
    group.some(tag => tag.decoration_num === 0 && tag.prompt === basePrompt),
  );
}

export function combineTagGroups(
  tagGroups: TagGroup[],
  basePrompt: string,
  basePromptName: string,
  baseDecoNum: number,
  allPrompts: AllPrompts,
): TagGroup {
  const baseTag = createTag(baseDecoNum, basePrompt, allPrompts);
  baseTag.name = basePromptName;
  return [...tagGroups.flat(), baseTag];
}

function toDecoList(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

/** Build tag_name -> set of lowercase prompt texts that have that tag */
function resolveDecoTags(decoTags: Set<string>, tagTextIdx: Map<string, Set<string>>): Set<string> {
  const resolved = new Set<string>();
  for (const tag of decoTags) {
    const texts = tagTextIdx.get(tag);
    if (texts) texts.forEach(t => resolved.add(t));
  }
  return resolved;
}

type PromptRec = { original: string; name: string; decoTags: Set<string> };

interface ParseCache {
  tagTextIdx: Map<string, Set<string>>;
  promptLowerMap: Map<string, PromptRec>;
  allPrompts: AllPrompts;
}

let parseCache: ParseCache | null = null;

function ensureCache(allPrompts: AllPrompts): ParseCache {
  if (parseCache && parseCache.allPrompts === allPrompts) return parseCache;

  const tagTextIdx = new Map<string, Set<string>>();
  const promptLowerMap = new Map<string, PromptRec>();

  for (const cd of Object.values(allPrompts)) {
    if (Array.isArray(cd)) {
      // Legacy array category — each item is a prompt dict
      for (const p of cd) {
        if (!p || typeof p !== 'object') continue;
        const key = (p.prompt || '').toLowerCase();
        if (!key || promptLowerMap.has(key)) continue;
        promptLowerMap.set(key, { original: p.prompt, name: p.name || p.prompt, decoTags: new Set() });
      }
      continue;
    }

    const catDecoTags = toDecoList((cd as any).decorations).map(d => d.toLowerCase());
    const catTags = toDecoList((cd as any).tags).map(t => t.toLowerCase());
    const prompts: PromptData[] = (cd as any).prompts || [];

    for (const p of prompts) {
      if (!p || !p.prompt) continue;
      const key = p.prompt.toLowerCase();
      promptLowerMap.set(key, promptLowerMap.get(key) ?? {
        original: p.prompt,
        name: p.name || p.prompt,
        decoTags: new Set(),
      });
      const rec = promptLowerMap.get(key)!;
      // Merge decoration tags (category + prompt + mutes) — mirrors backend deco_tag_sets
      for (const d of catDecoTags) rec.decoTags.add(d);
      for (const d of toDecoList(p.decorations).map(x => x.toLowerCase())) rec.decoTags.add(d);
      for (const d of toDecoList(p.mute_decorations).map(x => x.toLowerCase())) rec.decoTags.add(d);

      // Register all tags → prompt (mirrors backend tag_to_prompt_texts)
      const allTags = new Set<string>();
      for (const t of catTags) allTags.add(t);
      for (const t of toDecoList(p.tags).map(x => x.toLowerCase())) allTags.add(t);
      for (const t of allTags) {
        if (!tagTextIdx.has(t)) tagTextIdx.set(t, new Set());
        tagTextIdx.get(t)!.add(key);
      }
    }
  }

  parseCache = { tagTextIdx, promptLowerMap, allPrompts };
  return parseCache;
}

/**
 * Mirror of backend _try_decompose → decompose a list of space‑separated words
 * into decorations + base_prompt following the chain matching rule.
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
    let currentDecoTags = cache.promptLowerMap.get(basePrompt.toLowerCase())?.decoTags ?? new Set<string>();
    const decorationLevels: { level: number; text: string }[] = [];
    let ok = true;
    let level = 1;

    while (remaining.length > 0) {
      const decoSet = resolveDecoTags(currentDecoTags, cache.tagTextIdx);
      // _match_decoration_level — greedy suffix
      let matched = false;
      for (let r = 0; r < remaining.length; r++) {
        const cand = remaining.slice(r).join(' ');
        if (decoSet.has(cand.toLowerCase())) {
          decorationLevels.push({ level, text: cand });
          remaining = remaining.slice(0, r);
          matched = true;
          // Next level: use the matched prompt's decoration tags
          const nxt = cache.promptLowerMap.get(cand.toLowerCase());
          currentDecoTags = nxt?.decoTags ?? new Set<string>();
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
