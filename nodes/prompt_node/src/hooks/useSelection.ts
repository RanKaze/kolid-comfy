import { useState, useCallback } from 'react';
import type { Tag, TagGroup, PromptData, AllPrompts, AllPrograms, TemporaryContext, TagContextRef } from '../types';

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

export function findPromptId(promptText: string, allPrompts: AllPrompts): string {
  for (const [, catData] of Object.entries(allPrompts)) {
    const prompts = (catData as { prompts?: PromptData[] }).prompts || [];
    for (const p of prompts) {
      if (p.prompt === promptText) return p.id || '';
    }
  }
  return '';
}

function createTag(promptText: string, allPrompts: AllPrompts): Tag {
  const name = findPromptName(promptText, allPrompts);
  const category = findPromptCategory(promptText, allPrompts);
  if (name === promptText) {
    const byName = findPromptByName(promptText, allPrompts);
    if (byName) {
      return { name: byName.name, prompt: byName.prompt, category: byName.category, base_id: findPromptId(byName.prompt, allPrompts) || undefined };
    }
  }
  return { name, prompt: promptText, category, base_id: findPromptId(promptText, allPrompts) || undefined };
}

/** 点卡进来的那条基 tag：id 用按下的那张卡，文本相同的双卡不会认错。 */
export function createCardTag(card: { id: string; name: string; prompt: string; category?: string }): Tag {
  return { name: card.name, prompt: card.prompt, category: card.category || '', base_id: card.id };
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

export function findPromptDataById(id: string, allPrompts: AllPrompts): (PromptData & { category: string }) | null {
  if (!id) return null;
  for (const [cat, catData] of Object.entries(allPrompts)) {
    const prompts = (catData as { prompts?: PromptData[] }).prompts || [];
    for (const p of prompts) {
      if (p.id === id) return { ...p, category: cat };
    }
  }
  return null;
}

/**
 * 旧档迁移：context 里那些纯文本条目一次性换成 {id,text}（撞不到卡的 id 留空,当自由文本继续出词）。
 * 已经是对象的原样留下 —— 每个入口都过它，幂等。
 */
export function migrateTagRefs(items: (string | TagContextRef)[] | undefined, allPrompts: AllPrompts): TagContextRef[] {
  return (items || []).map(item => {
    if (typeof item !== 'string') return item.id ? item : { ...item, id: findPromptId(item.text, allPrompts) };
    return { id: findPromptId(item, allPrompts), text: item };
  });
}

/** tag 引用的身份键：有卡用卡 id，自由文本退回文本（同一份自由文本本就是同一件事）。 */
export function tagRefKey(ref: TagContextRef): string {
  return ref.id || ref.text;
}

/**
 * 一次性迁移：引用列表过 migrateTagRefs，同时把当初按文本记的停用/显示位改成新的身份键。
 * 已经是 id 的键撞不到文本表，原样留下 —— 幂等。
 */
export function migrateTagRefSet(
  refs: (string | TagContextRef)[] | undefined,
  keys: string[] | undefined,
  allPrompts: AllPrompts,
): { refs: TagContextRef[]; keys: string[] } {
  const migrated = migrateTagRefs(refs, allPrompts);
  const textToKey = new Map<string, string>();
  for (const r of migrated) textToKey.set(r.text, tagRefKey(r));
  const next = (keys || []).map(k => textToKey.get(k) ?? k);
  return { refs: migrated, keys: Array.from(new Set(next)) };
}

/** 卡片文本/名字变了：按 id 刷新选中组里的基 tag（文本只是出词，认人靠 id）。 */
export function retextCardTag(group: TagGroup, cardId: string, prompt: string, name: string): TagGroup {
  const bi = group.tags.length - 1;
  if (group.tags[bi]?.base_id !== cardId) return group;
  return { ...group, tags: group.tags.map((t, i) => i === bi ? { ...t, prompt, name } : t) };
}

/** 卡片文本变了：按 id 刷新所有 tag 引用里的出词文本。 */
export function retextTagRefs(refs: TagContextRef[] | undefined, cardId: string, text: string): TagContextRef[] {
  return (refs || []).map(r => r.id === cardId ? { ...r, text } : r);
}

/** 一次性迁移：程序定义里的 Tags Builtin 旧档是纯文本串 + 按文本记的停用/显示位，一起换成 id 口径。 */
export function migrateProgramTagRefs(programs: AllPrograms, allPrompts: AllPrompts): AllPrograms {
  const next: AllPrograms = {};
  for (const [cat, catData] of Object.entries(programs)) {
    next[cat] = { ...catData, programs: (catData.programs || []).map(a => {
      const builtin = migrateTagRefSet(a.tag_group_builtin_texts, a.tag_group_builtin_inactive, allPrompts);
      const display = migrateTagRefSet(a.tag_group_builtin_texts, a.tag_group_builtin_display, allPrompts);
      return { ...a, tag_group_builtin_texts: builtin.refs, tag_group_builtin_inactive: builtin.keys, tag_group_builtin_display: display.keys };
    }) };
  }
  return next;
}

function baseTagOf(group: TagGroup): Tag | undefined {
  return group.tags[group.tags.length - 1];
}

/** 认人只认基 tag 上的卡 id —— 文本是出词用的,不做兜底匹配（旧档在载入时先过 migrateTagGroups 打戳）。 */
export function isCardSelectedInTags(cardId: string, selectedTags: TagGroup[]): boolean {
  return selectedTags.some(group => baseTagOf(group)?.base_id === cardId);
}

export function findTagGroupByCardId(cardId: string, selectedTags: TagGroup[]): TagGroup | undefined {
  return selectedTags.find(group => baseTagOf(group)?.base_id === cardId);
}

export function findTagGroupIndexByCardId(cardId: string, selectedTags: TagGroup[]): number {
  return selectedTags.findIndex(group => baseTagOf(group)?.base_id === cardId);
}

/**
 * 一次性迁移：给只带文本的旧 tag 组（preset 落盘档、last_selected、prefab 快照、filter 组）打上卡 id。
 * 文本撞不到卡的就留作自由文本 tag（没有 base_id,从此不点亮任何卡,但照样出词）。
 * 同文本的双卡撞到的都是先出现的那张 —— 只有点卡进来的那条能保住真实 id。
 */
export function migrateTagGroups(groups: TagGroup[], allPrompts: AllPrompts): TagGroup[] {
  return groups.map(group => ({
    ...group,
    tags: group.tags.map(tag => {
      if (tag.base_id) return tag;
      const id = findPromptId(tag.prompt, allPrompts);
      return id ? { ...tag, base_id: id } : tag;
    }),
  }));
}

/** 把组的基 tag 钉到给定卡 id：context 引用带 id 时以引用为准，不靠文本撞。 */
export function pinGroupBaseId(group: TagGroup, cardId: string): TagGroup {
  if (!cardId || group.tags.length === 0) return group;
  const tags = [...group.tags];
  tags[tags.length - 1] = { ...tags[tags.length - 1], base_id: cardId };
  return { ...group, tags };
}

export function combineTagGroups(
  tagGroups: TagGroup[],
  basePrompt: string,
  basePromptName: string,
  baseDecoNum: number,
  allPrompts: AllPrompts,
  baseCardId?: string,
): TagGroup {
  const baseTag: Tag = baseCardId
    ? createCardTag({ id: baseCardId, name: basePromptName, prompt: basePrompt })
    : { ...createTag(basePrompt, allPrompts), name: basePromptName };
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
