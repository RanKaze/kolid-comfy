import type { PromptContextBase } from './types';

// ═══ Placeholder types ═══

export type SlotType = 'context' | 'background' | 'region_prompt' | 'region_bbox';

export interface ContextSlot {
  id: string;           // unique id (e.g. "slot_0")
  path: string;         // dot-separated JSON path (e.g. "style_description.aesthetics")
  label: string;        // human-readable label for button
  type: SlotType;
}

// A marker node in the parsed template — represents a placeholder
const PLACEHOLDER_MARKER = '__PLACEHOLDER__';

interface PlaceholderNode {
  __placeholder__: true;
  slotId: string;
  type: SlotType;
}

type TemplateValue = string | number | boolean | null | PlaceholderNode | TemplateValue[] | { [key: string]: TemplateValue };

/**
 * RegionFormatManager — parses a JSON template with placeholders and assembles final output.
 *
 * Placeholders:
 *   <ContextPrompt>    — a named context slot (becomes a button). Prompt output fills this.
 *   <BackGroundPrompt> — background context prompt fills this.
 *   <RegionPrompt>     — each region's prompt (desc) fills this.
 *   <RegionBbox>       — each region's bbox [ymin,xmin,ymax,xmax] fills this.
 *
 * The <RegionPrompt> and <RegionBbox> must be inside an array element (the "elements" container).
 * Each region produces one copy of the array element's template.
 */
export class RegionFormatManager {
  private slots: ContextSlot[] = [];
  private template: TemplateValue | null = null;
  private regionElementPath: string[] = [];  // path to the array containing <RegionPrompt>/<RegionBbox>
  private regionElementTemplate: any = null;  // the template object inside that array

  constructor(formatString: string) {
    this.parse(formatString);
  }

  private parse(formatString: string): void {
    const str = formatString.trim();
    if (!str) {
      this.template = null;
      return;
    }

    // Replace placeholders with sentinel strings, then parse JSON
    const placeholders: { sentinel: string; type: SlotType }[] = [];
    let slotIdx = 0;

    const processed = str.replace(/<(ContextPrompt|BackGroundPrompt|RegionPrompt|RegionBbox)>/g, (_, tag) => {
      const type: SlotType = tag === 'ContextPrompt' ? 'context'
        : tag === 'BackGroundPrompt' ? 'background'
        : tag === 'RegionPrompt' ? 'region_prompt'
        : 'region_bbox';
      const sentinel = `"__PLACEHOLDER_${slotIdx}__"`;
      placeholders.push({ sentinel: `__PLACEHOLDER_${slotIdx}__`, type });
      slotIdx++;
      return sentinel;
    });

    // Try to parse, auto-fixing missing closing braces
    let jsonStr = processed;
    try {
      const parsed = JSON.parse(jsonStr);
      this.template = this.markPlaceholders(parsed, placeholders);
      this.extractSlots(this.template, '');
      console.log('[RegionFormatManager] Parsed OK. slots:', this.slots.length);
      this.findRegionElement(this.template, []);
    } catch {
      // Auto-fix: count opening vs closing braces and append missing ones
      const opens = (jsonStr.match(/{/g) || []).length;
      const closes = (jsonStr.match(/}/g) || []).length;
      const missing = opens - closes;
      if (missing > 0) {
        jsonStr = jsonStr + '}'.repeat(missing);
        try {
          const parsed = JSON.parse(jsonStr);
          this.template = this.markPlaceholders(parsed, placeholders);
          this.extractSlots(this.template, '');
          console.log('[RegionFormatManager] Parsed OK (auto-fixed ' + missing + ' missing braces). slots:', this.slots.length);
          this.findRegionElement(this.template, []);
        } catch (e: any) {
          console.log('[RegionFormatManager] CAUGHT ERROR even after fix:', e?.message || e);
          this.template = null;
        }
      } else {
        console.log('[RegionFormatManager] CAUGHT ERROR: JSON parse failed, no missing braces detected');
        this.template = null;
      }
    }
  }

  private markPlaceholders(obj: any, placeholders: { sentinel: string; type: SlotType }[]): TemplateValue {
    if (typeof obj === 'string') {
      const found = placeholders.find(p => obj === p.sentinel);
      if (found) {
        return { __placeholder__: true, slotId: found.sentinel, type: found.type } as PlaceholderNode;
      }
      // Check if string contains placeholder but doesn't match exactly
      const partial = placeholders.find(p => obj.includes(p.sentinel));
      if (partial) {
        console.warn('[RegionFormatManager] String contains placeholder but doesn\'t match exactly:', JSON.stringify(obj), 'vs', JSON.stringify(partial.sentinel));
      }
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.markPlaceholders(item, placeholders));
    }
    if (obj !== null && typeof obj === 'object') {
      const result: { [key: string]: TemplateValue } = {};
      for (const [k, v] of Object.entries(obj)) {
        result[k] = this.markPlaceholders(v, placeholders);
      }
      return result;
    }
    return obj;
  }

  private extractSlots(value: TemplateValue, path: string): void {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const node = value as PlaceholderNode;
      if (node.__placeholder__) {
        const slotId = node.slotId;
        const existing = this.slots.find(s => s.id === slotId);
        if (!existing) {
          const label = path.split('.').pop() || path || 'Context';
          this.slots.push({ id: slotId, path, label, type: node.type });
        }
        return;
      }
      for (const [k, v] of Object.entries(value)) {
        this.extractSlots(v, path ? `${path}.${k}` : k);
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => this.extractSlots(item, `${path}[${i}]`));
    }
  }

  private findRegionElement(value: TemplateValue, path: string[]): void {
    if (Array.isArray(value)) {
      // Check if this array contains region placeholders
      const hasRegionPrompt = JSON.stringify(value).includes('"__placeholder__"') &&
        value.some(item => this.containsType(item, 'region_prompt') || this.containsType(item, 'region_bbox'));
      if (hasRegionPrompt) {
        this.regionElementPath = path;
        this.regionElementTemplate = value[0]; // first element is the template
        return;
      }
      value.forEach((item, i) => this.findRegionElement(item, [...path, `[${i}]`]));
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const node = value as PlaceholderNode;
      if (!node.__placeholder__) {
        for (const [k, v] of Object.entries(value)) {
          this.findRegionElement(v, [...path, k]);
        }
      }
    }
  }

  private containsType(value: any, type: SlotType): boolean {
    if (value !== null && typeof value === 'object') {
      if (value.__placeholder__ && value.type === type) return true;
      for (const v of Object.values(value)) {
        if (this.containsType(v, type)) return true;
      }
    }
    return false;
  }

  /** Get all context slots that need UI buttons */
  getContextSlots(): ContextSlot[] {
    return this.slots.filter(s => s.type === 'context' || s.type === 'background');
  }

  /** Check if the format has a valid template */
  hasTemplate(): boolean {
    return this.template !== null;
  }

  /**
   * Assemble the final JSON string.
   * @param contextValues — Map of slotId → prompt text
   * @param backgroundPrompt — background context prompt text
   * @param regions — Array of { bbox: [ymin,xmin,ymax,xmax], prompt: string }
   */
  assemble(
    contextValues: Map<string, string>,
    backgroundPrompt: string,
    regions: Array<{ bbox: number[]; prompt: string }>
  ): string {
    if (!this.template) return '';

    const result = this.fillTemplate(this.template, contextValues, backgroundPrompt, regions);
    return JSON.stringify(result);
  }

  private fillTemplate(
    value: TemplateValue,
    contextValues: Map<string, string>,
    backgroundPrompt: string,
    regions: Array<{ bbox: number[]; prompt: string }>
  ): any {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const node = value as PlaceholderNode;
      if (node.__placeholder__) {
        if (node.type === 'context') {
          return contextValues.get(node.slotId) || '';
        }
        if (node.type === 'background') {
          return backgroundPrompt;
        }
        // region_prompt and region_bbox are handled in array context
        return null;
      }
      const result: { [key: string]: any } = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = this.fillTemplate(v, contextValues, backgroundPrompt, regions);
      }
      return result;
    }

    if (Array.isArray(value)) {
      // Check if this is the region elements array
      const hasRegion = value.some(item =>
        item !== null && typeof item === 'object' && !Array.isArray(item) &&
        this.containsType(item, 'region_prompt')
      );

      if (hasRegion && regions.length > 0) {
        // Expand: one copy of the template per region
        return regions.map(region => {
          return this.fillRegionElement(value[0], contextValues, backgroundPrompt, region);
        });
      }
      // Normal array
      return value.map(item => this.fillTemplate(item, contextValues, backgroundPrompt, regions));
    }

    return value;
  }

  private fillRegionElement(
    value: any,
    contextValues: Map<string, string>,
    backgroundPrompt: string,
    region: { bbox: number[]; prompt: string }
  ): any {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const node = value as PlaceholderNode;
      if (node.__placeholder__) {
        if (node.type === 'region_prompt') return region.prompt;
        if (node.type === 'region_bbox') return region.bbox;
        if (node.type === 'context') return contextValues.get(node.slotId) || '';
        if (node.type === 'background') return backgroundPrompt;
        return null;
      }
      const result: { [key: string]: any } = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = this.fillRegionElement(v, contextValues, backgroundPrompt, region);
      }
      return result;
    }
    if (Array.isArray(value)) {
      return value.map(item => this.fillRegionElement(item, contextValues, backgroundPrompt, region));
    }
    return value;
  }
}
