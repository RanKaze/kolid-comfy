import { useState, useCallback } from 'react';
import type { TempContextLayer, TempContextMode, LoraTempState, TagContextRef } from '../types';

export function useTempContext() {
  const [stack, setStack] = useState<TempContextLayer[]>([]);

  const isActive = stack.length > 0;
  const current = stack[stack.length - 1] ?? null;

  const push = useCallback((layer: TempContextLayer) => {
    setStack(prev => [...prev, layer]);
  }, []);

  const pop = useCallback(() => {
    setStack(prev => prev.slice(0, -1));
  }, []);

  const clear = useCallback(() => {
    setStack([]);
  }, []);

  /** Toggle an id in the current layer's selections (for lora/prefab/program modes) */
  const toggleId = useCallback((id: string) => {
    setStack(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.type !== 'lora' && last.type !== 'prefab' && last.type !== 'program' && last.type !== 'prefabCtx' && last.type !== 'loraCtx' && last.type !== 'prefabBuiltin' && last.type !== 'loraBuiltin') return prev;
      const selections = new Set(last.selections || []);
      if (selections.has(id)) selections.delete(id);
      else selections.add(id);
      return [...prev.slice(0, -1), { ...last, selections: Array.from(selections) }];
    });
  }, []);

  /** tag 类上下文按引用挑：id 认卡，text 出词（卡删了 text 还在，引用就当自由文本活下去） */
  const toggleTagRef = useCallback((ref: TagContextRef) => {
    setStack(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.type !== 'tagCtx' && last.type !== 'tagGroupBuiltin') return prev;
      const refs = last.tagSelections || [];
      const next = refs.some(r => r.id === ref.id)
        ? refs.filter(r => r.id !== ref.id)
        : [...refs, ref];
      return [...prev.slice(0, -1), { ...last, tagSelections: next }];
    });
  }, []);

  /** Check if an id is selected in the current layer */
  const isIdSelected = useCallback((id: string): boolean => {
    if (stack.length === 0) return false;
    const last = stack[stack.length - 1];
    if (last.type === 'tag') {
      return (last.tagGroups || []).some(g => g.tags.slice(0, -1).some(t => t.prompt === id));
    }
    return (last.selections || []).includes(id);
  }, [stack]);

  /** Check if a prompt card id is picked in the current tag-context layer */
  const isTagRefSelected = useCallback((id: string): boolean => {
    if (stack.length === 0) return false;
    const last = stack[stack.length - 1];
    if (last.type !== 'tagCtx' && last.type !== 'tagGroupBuiltin') return false;
    return (last.tagSelections || []).some(r => r.id === id);
  }, [stack]);

  /** Remove a tag group by index in the current tag layer */
  const removeTagGroup = useCallback((idx: number) => {
    setStack(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.type !== 'tag') return prev;
      return [...prev.slice(0, -1), { ...last, tagGroups: (last.tagGroups || []).filter((_, i) => i !== idx) }];
    });
  }, []);

  /** Update a lora state in the current lora layer */
  const setLoraState = useCallback((filePath: string, state: LoraTempState) => {
    setStack(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.type !== 'lora') return prev;
      return [...prev.slice(0, -1), { ...last, loraStates: { ...(last.loraStates || {}), [filePath]: state } }];
    });
  }, []);

  /** Update the top layer immutably via a callback */
  const updateTop = useCallback((updater: (layer: TempContextLayer) => TempContextLayer) => {
    setStack(prev => {
      if (prev.length === 0) return prev;
      return [...prev.slice(0, -1), updater(prev[prev.length - 1])];
    });
  }, []);

  /** Get the current mode, or null if inactive */
  const mode: TempContextMode | null = current?.type ?? null;

  return {
    stack,
    isActive,
    current,
    mode,
    push,
    pop,
    clear,
    toggleId,
    toggleTagRef,
    isIdSelected,
    isTagRefSelected,
    removeTagGroup,
    setLoraState,
    updateTop,
    setStack,
  };
}
