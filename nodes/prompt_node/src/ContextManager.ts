import type { PromptContextBase, BackgroundContext, RegionBox, LoraSelectionData, SelectedPrefabItem } from './types';

/**
 * ContextManager — a singleton-style state machine that manages all context types
 * (format slots, regions, background) with robust serialization and anti-corruption guarantees.
 *
 * Design principles:
 * 1. Single source of truth: all context data lives in one serialized state object
 * 2. Snapshot before switch: always capture current state before any transition
 * 3. Atomic transitions: save-old + load-new happens as one atomic operation
 * 4. Stable IDs: slot IDs are path-based, not index-based
 * 5. Defensive restore: missing data falls back to empty context, never corrupts siblings
 */

export type ContextType = 'background' | 'region' | 'slot';

export interface ContextState {
  /** All format slot contexts, keyed by stable slot ID */
  slots: Record<string, PromptContextBase>;
  /** Background context */
  background: BackgroundContext | null;
  /** Region boxes (each has its own promptContext) */
  boxes: RegionBox[];
  /** Active region index, or -1 for non-region */
  activeRegionIdx: number;
  /** Active slot ID, or null for non-slot */
  activeSlotId: string | null;
}

export interface Snapshot {
  prompts: string[];
  custom_prompts: string;
  loras: LoraSelectionData[];
  prefabs: SelectedPrefabItem[];
}

export class ContextManager {
  private state: ContextState;
  private listeners: Set<() => void> = new Set();

  constructor(savedState?: string) {
    this.state = this.deserialize(savedState);
  }

  // ═══ State accessors ═══

  getState(): ContextState {
    return this.state;
  }

  getActiveType(): ContextType {
    if (this.state.activeSlotId !== null) return 'slot';
    if (this.state.activeRegionIdx >= 0) return 'region';
    return 'background';
  }

  getActiveContext(): PromptContextBase | null {
    if (this.state.activeSlotId !== null) {
      return this.state.slots[this.state.activeSlotId] || null;
    }
    if (this.state.activeRegionIdx >= 0 && this.state.activeRegionIdx < this.state.boxes.length) {
      return this.state.boxes[this.state.activeRegionIdx].promptContext || null;
    }
    return this.state.background;
  }

  getBoxes(): RegionBox[] {
    return this.state.boxes;
  }

  getSlotIds(): string[] {
    return Object.keys(this.state.slots);
  }

  getSlotContext(slotId: string): PromptContextBase | null {
    return this.state.slots[slotId] || null;
  }

  // ═══ Mutations ═══

  setBoxes(boxes: RegionBox[]): void {
    this.state = { ...this.state, boxes: [...boxes] };
    this.notify();
  }

  setActiveRegion(idx: number): void {
    this.state = { ...this.state, activeRegionIdx: idx, activeSlotId: null };
    this.notify();
  }

  setActiveSlot(slotId: string | null): void {
    this.state = { ...this.state, activeSlotId: slotId, activeRegionIdx: slotId !== null ? -1 : this.state.activeRegionIdx };
    this.notify();
  }

  /**
   * Save a snapshot of the current prompt selection to the active context.
   * Called whenever the user changes their prompt/loras/prefabs.
   * Returns true if saved, false if no active context to save to.
   */
  saveSnapshot(snapshot: Snapshot): boolean {
    const ctx: PromptContextBase = {
      prompts: snapshot.prompts,
      custom_prompts: snapshot.custom_prompts,
      loras: snapshot.loras,
      prefabs: snapshot.prefabs,
      label: this.getActiveLabel(),
    };

    if (this.state.activeSlotId !== null) {
      this.state.slots[this.state.activeSlotId] = ctx;
      return true;
    }
    if (this.state.activeRegionIdx >= 0 && this.state.activeRegionIdx < this.state.boxes.length) {
      const boxes = [...this.state.boxes];
      boxes[this.state.activeRegionIdx] = {
        ...boxes[this.state.activeRegionIdx],
        promptContext: ctx,
      };
      this.state.boxes = boxes;
      return true;
    }
    // Background
    this.state.background = { ...ctx, isBackground: true };
    return true;
  }

  /**
   * Save snapshot to a specific slot (used by button onClick before switching).
   */
  saveSnapshotToSlot(slotId: string, snapshot: Snapshot): void {
    const ctx: PromptContextBase = {
      prompts: snapshot.prompts,
      custom_prompts: snapshot.custom_prompts,
      loras: snapshot.loras,
      prefabs: snapshot.prefabs,
      label: slotId,
    };
    this.state.slots[slotId] = ctx;
  }

  /**
   * Save snapshot to background context.
   */
  saveSnapshotToBackground(snapshot: Snapshot): void {
    const ctx: BackgroundContext = {
      prompts: snapshot.prompts,
      custom_prompts: snapshot.custom_prompts,
      loras: snapshot.loras,
      prefabs: snapshot.prefabs,
      label: 'Background',
      isBackground: true,
    };
    this.state.background = ctx;
  }

  /**
   * Save snapshot to a specific region box.
   */
  saveSnapshotToRegion(regionIdx: number, snapshot: Snapshot): void {
    if (regionIdx < 0 || regionIdx >= this.state.boxes.length) return;
    const ctx: PromptContextBase = {
      prompts: snapshot.prompts,
      custom_prompts: snapshot.custom_prompts,
      loras: snapshot.loras,
      prefabs: snapshot.prefabs,
      label: `Region ${String(regionIdx + 1).padStart(2, '0')}`,
    };
    const boxes = [...this.state.boxes];
    boxes[regionIdx] = { ...boxes[regionIdx], promptContext: ctx };
    this.state.boxes = boxes;
  }

  /**
   * Get the context to load for a given target (slot/region/background).
   */
  getLoadContext(target: { type: ContextType; slotId?: string; regionIdx?: number }): PromptContextBase | null {
    if (target.type === 'slot' && target.slotId) {
      return this.state.slots[target.slotId] || null;
    }
    if (target.type === 'region' && target.regionIdx !== undefined && target.regionIdx >= 0 && target.regionIdx < this.state.boxes.length) {
      return this.state.boxes[target.regionIdx].promptContext || null;
    }
    // background
    return this.state.background;
  }

  /**
   * Initialize slots from a format template (creates empty contexts for new slots).
   * Preserves existing slot data if the slot ID already exists.
   */
  initSlots(slotIds: string[], labels: Record<string, string>): void {
    const newSlots: Record<string, PromptContextBase> = {};
    for (const id of slotIds) {
      if (this.state.slots[id]) {
        // Preserve existing data
        newSlots[id] = this.state.slots[id];
      } else {
        // Create empty context
        newSlots[id] = {
          prompts: [],
          custom_prompts: '',
          loras: [],
          prefabs: [],
          label: labels[id] || id,
        };
      }
    }
    this.state.slots = newSlots;
  }

  // ═══ Delete region ═══

  deleteRegion(idx: number): void {
    if (idx < 0 || idx >= this.state.boxes.length) return;
    const boxes = this.state.boxes.filter((_, i) => i !== idx);
    let newActiveIdx = this.state.activeRegionIdx;
    if (this.state.activeRegionIdx === idx) {
      newActiveIdx = Math.min(idx, boxes.length - 1);
    } else if (this.state.activeRegionIdx > idx) {
      newActiveIdx = this.state.activeRegionIdx - 1;
    }
    this.state = { ...this.state, boxes, activeRegionIdx: newActiveIdx };
    this.notify();
  }

  // ═══ Serialization ═══

  serialize(): string {
    return JSON.stringify({
      version: 2,
      slots: this.state.slots,
      background: this.state.background,
      boxes: this.state.boxes,
    });
  }

  private deserialize(savedState?: string): ContextState {
    const empty: ContextState = {
      slots: {},
      background: null,
      boxes: [],
      activeRegionIdx: -1,
      activeSlotId: null,
    };
    if (!savedState) return empty;
    try {
      const parsed = JSON.parse(savedState);
      // v2 format: { version, slots, background, boxes }
      if (parsed.version === 2) {
        return {
          slots: parsed.slots || {},
          background: parsed.background || null,
          boxes: Array.isArray(parsed.boxes) ? parsed.boxes : [],
          activeRegionIdx: -1,
          activeSlotId: null,
        };
      }
      // v1 format: array of boxes (old)
      if (Array.isArray(parsed)) {
        return { ...empty, boxes: parsed };
      }
      // v1.5 format: { boxes, format_slots, background_context }
      if (parsed.boxes) {
        return {
          slots: parsed.format_slots || {},
          background: parsed.background_context || null,
          boxes: Array.isArray(parsed.boxes) ? parsed.boxes : [],
          activeRegionIdx: -1,
          activeSlotId: null,
        };
      }
      return empty;
    } catch {
      return empty;
    }
  }

  // ═══ Private helpers ═══

  private getActiveLabel(): string {
    if (this.state.activeSlotId !== null) return this.state.activeSlotId;
    if (this.state.activeRegionIdx >= 0) return `Region ${String(this.state.activeRegionIdx + 1).padStart(2, '0')}`;
    return 'Background';
  }

  private notify(): void {
    this.listeners.forEach(fn => fn());
  }
}
