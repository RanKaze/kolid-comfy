/**
 * Prompt-preset scope: when the prompt UI is embedded as the editor of a Pipeline "prompt"
 * block's PRESET (iframe in the sampler workbench), the URL carries scope/preset_id/
 * sampler_base and the selection is saved to the SHARED preset (persisted server-side in
 * prompt_presets.json), not to the prompt node's global state. Every block referencing the
 * preset picks up edits; at run time the backend injects it only for the detailers after
 * that block.
 */
const params = typeof window !== 'undefined'
  ? new URLSearchParams(window.location.search)
  : new URLSearchParams();

export const PRESET_SCOPE = params.get('scope') === 'prompt_preset';
/** `?scope=query`: the prompt UI answering a Pipeline Query block mid-run. */
export const QUERY_SCOPE = params.get('scope') === 'query';
export const PRESET_ID = params.get('preset_id') || '';
export const SAMPLER_BASE = params.get('sampler_base') || '';

export interface PromptPresetSelectionPayload {
  tags: any[];
  custom_prompts: string;
  loras: any[];
  prefabs: any[];
  programs: any[];
}

/** True when this window is embedded for one specific consumer (preset editor / Query
 *  answer), so the prompt node's own global selection must NOT be restored into it. */
export const SCOPED_SELECTION = PRESET_SCOPE || QUERY_SCOPE;

/** Fetch the referenced preset's saved selection from the sampler server (null = not configured).
 *  Both scoped consumers seed from it: the preset editor obviously, and a Query block that
 *  binds a preset — its dialog opens pre-ticked with that selection. An unbound Query has no
 *  PRESET_ID, so this returns null and the dialog starts empty, exactly as before. */
export async function fetchPromptPresetSelection(): Promise<any | null> {
  if (!SCOPED_SELECTION || !PRESET_ID || !SAMPLER_BASE) return null;
  try {
    const res = await fetch(`${SAMPLER_BASE}/api/prompt_presets`);
    if (!res.ok) return null;
    const data = await res.json();
    const preset = (data.presets || []).find((p: any) => p && p.id === PRESET_ID);
    return (preset && preset.selection) || null;
  } catch {
    return null;
  }
}

/** Hand a Query answer back to the host (the sampler): it forwards the RAW selection to
 *  the parked run, which merges it and runs its programs. This window never writes to the
 *  preset — a Persistent Query's write-back is the backend's call at submit time. */
export function answerQuerySelection(selection: PromptPresetSelectionPayload): boolean {
  if (!QUERY_SCOPE || window.parent === window) return false;
  window.parent.postMessage({ type: 'prompt-query-answered', selection }, '*');
  return true;
}

/** Save the selection into the shared preset and notify the host (EditPhase) so it can close the modal. */
export async function savePromptPresetSelection(selection: PromptPresetSelectionPayload): Promise<boolean> {
  if (!PRESET_SCOPE || !PRESET_ID || !SAMPLER_BASE) return false;
  try {
    const res = await fetch(`${SAMPLER_BASE}/api/prompt_presets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save', id: PRESET_ID, selection }),
    });
    if (!res.ok) return false;
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'prompt-preset-saved', preset_id: PRESET_ID, selection }, '*');
    }
    return true;
  } catch {
    return false;
  }
}
