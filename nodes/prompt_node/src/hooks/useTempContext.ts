import { useState, useCallback } from 'react';
import type { TempContextLayer, TempContextMode, LoraTempState } from '../types';

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

  /** Toggle an id in the current layer's selections (for lora/prefab modes) */
  const toggleId = useCallback((id: string) => {
    setStack(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.type !== 'lora' && last.type !== 'prefab' && last.type !== 'program' && last.type !== 'prefabCtx' && last.type !== 'loraCtx' && last.type !== 'tagCtx' && last.type !== 'prefabBuiltin' && last.type !== 'loraBuiltin' && last.type !== 'tagGroupBuiltin') return prev;
      const selections = new Set(last.selections || []);
      if (selections.has(id)) selections.delete(id);
      else selections.add(id);
      return [...prev.slice(0, -1), { ...last, selections: Array.from(selections) }];
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
    isIdSelected,
    removeTagGroup,
    setLoraState,
    updateTop,
    setStack,
  };
}
