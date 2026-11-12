import React, { useRef, useState } from 'react';
import {
  newAudioId, normalizeAudioDefs, type AudioBusDef, type AudioInterfaceDef, type AudioObjectDef,
} from './audioDefs';
import type { VidController, VidProject } from './model';
import { S } from './audioPanelKit';

// ── 音频定义预设：把三套定义（Bus / Interface / Object）存成可复用的模板 ────────────────────
// 预设住在 localStorage（跨工程共享），不随 .cud 走；需要迁移时用 Export / Import JSON。
// 载入预设 = **全部实体换新 id 并重写所有引用** 后合并进当前工程，绝不覆盖已有定义。

const STORE = 'sampler.audioPresets.v1';

export type AudioPreset = {
  id: string;
  name: string;
  at: number;
  buses: AudioBusDef[];
  interfaces: AudioInterfaceDef[];
  objects: AudioObjectDef[];
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const loadPresets = (): AudioPreset[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || 'null') as { presets?: AudioPreset[] } | null;
    return Array.isArray(raw?.presets) ? raw.presets.filter(x => x && Array.isArray(x.buses)) : [];
  } catch { return []; }
};

const writePresets = (list: AudioPreset[]): void => {
  try { localStorage.setItem(STORE, JSON.stringify({ version: 1, presets: list })); } catch { /* 配额满：本次不落盘 */ }
};

export const capturePreset = (vid: VidController, name: string): AudioPreset => ({
  id: newAudioId('pre'),
  name: name || 'Audio preset',
  at: Date.now(),
  buses: clone(vid.project.audioBuses ?? []),
  interfaces: clone(vid.project.audioInterfaces ?? []),
  objects: clone(vid.project.audioObjects ?? []),
});

/** 预设 → 一组换过 id 的定义（引用一并重写），供合并进工程。 */
export const remapPreset = (preset: AudioPreset): {
  buses: AudioBusDef[]; interfaces: AudioInterfaceDef[]; objects: AudioObjectDef[];
} => {
  const busMap = new Map(preset.buses.map(b => [b.id, newAudioId('bus')] as const));
  const ifaceMap = new Map(preset.interfaces.map(i => [i.id, newAudioId('ifc')] as const));
  const eventMap = new Map<string, string>();
  const paramMap = new Map<string, string>();
  for (const it of preset.interfaces) {
    for (const ev of it.events) {
      eventMap.set(ev.id, newAudioId('evt'));
      for (const pr of ev.params) paramMap.set(pr.id, newAudioId('prm'));
    }
  }
  const buses = preset.buses.map(b => ({
    ...b,
    id: busMap.get(b.id) as string,
    busIds: b.busIds.map(id => busMap.get(id)).filter((x): x is string => !!x),
  }));
  const interfaces = preset.interfaces.map(it => ({
    ...it,
    id: ifaceMap.get(it.id) as string,
    ifaceIds: (it.ifaceIds ?? []).map(id => ifaceMap.get(id)).filter((x): x is string => !!x),
    events: it.events.map(ev => ({
      ...ev,
      id: eventMap.get(ev.id) as string,
      busIds: ev.busIds.map(id => busMap.get(id)).filter((x): x is string => !!x),
      params: ev.params.map(pr => ({
        ...pr,
        id: paramMap.get(pr.id) as string,
        busIds: pr.busIds.map(id => busMap.get(id)).filter((x): x is string => !!x),
      })),
    })),
  }));
  const objects = preset.objects.map(ob => {
    const slots: AudioObjectDef['slots'] = {};
    for (const [eventId, list] of Object.entries(ob.slots)) {
      const ne = eventMap.get(eventId);
      if (ne && list.length) slots[ne] = list.map(a => ({ ...a, id: newAudioId('slo') }));
    }
    return {
      ...ob,
      id: newAudioId('obj'),
      ifaceIds: ob.ifaceIds.map(id => ifaceMap.get(id)).filter((x): x is string => !!x),
      slots,
    };
  });
  return { buses, interfaces, objects };
};

const applyToProject = (preset: AudioPreset): ((prev: VidProject) => VidProject) => {
  const add = remapPreset(preset);
  return prev => ({
    ...prev,
    audioBuses: [...(prev.audioBuses ?? []), ...add.buses],
    audioInterfaces: [...(prev.audioInterfaces ?? []), ...add.interfaces],
    audioObjects: [...(prev.audioObjects ?? []), ...add.objects],
  });
};

const download = (name: string, data: unknown): void => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

export const AudioPresetBar: React.FC<{ vid: VidController }> = ({ vid }) => {
  const [presets, setPresets] = useState<AudioPreset[]>(() => loadPresets());
  const [sel, setSel] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refresh = (list: AudioPreset[]) => { setPresets(list); writePresets(list); };

  const save = () => {
    const name = window.prompt('Preset name', 'Audio preset ' + (presets.length + 1));
    if (!name) return;
    refresh([...presets, capturePreset(vid, name)]);
  };
  const load = () => {
    const p = presets.find(x => x.id === sel);
    if (!p) return;
    vid.update(applyToProject(p), 'Load audio preset · ' + p.name);
  };
  const del = () => {
    const p = presets.find(x => x.id === sel);
    if (!p || !window.confirm(`Delete preset "${p.name}"?`)) return;
    refresh(presets.filter(x => x.id !== p.id));
    setSel('');
  };
  const exp = () => download('kolid-audio-presets.json', { version: 1, presets });
  const imp = async (f: File) => {
    try {
      const raw = JSON.parse(await f.text()) as { presets?: AudioPreset[] } | AudioPreset;
      const list = Array.isArray((raw as { presets?: AudioPreset[] }).presets)
        ? (raw as { presets?: AudioPreset[] }).presets as AudioPreset[]
        : [raw as AudioPreset];
      const ok = list.filter(x => x && Array.isArray(x.buses) && Array.isArray(x.interfaces));
      if (!ok.length) throw new Error('no audio presets in that file');
      refresh([...presets, ...ok.map(p => ({ ...p, id: newAudioId('pre'), at: Date.now() }))]);
    } catch (e) {
      window.alert('Import failed: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
      <button type="button" style={S.btn} onClick={save}>Save preset…</button>
      <select value={sel} onChange={e => setSel(e.target.value)} style={{ ...S.select, maxWidth: 150 }}>
        <option value="">{presets.length ? 'Load preset…' : 'No presets'}</option>
        {presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <button type="button" style={S.btn} disabled={!sel} onClick={load}>Load</button>
      <button type="button" style={S.btn} disabled={!sel} onClick={del}>Delete</button>
      <button type="button" style={S.btn} onClick={exp}>Export</button>
      <button type="button" style={S.btn} onClick={() => fileRef.current?.click()}>Import</button>
      <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) void imp(f); e.currentTarget.value = ''; }} />
    </div>
  );
};

/** 导入 JSON 也走同一套校验：把一段裸定义收敛成合法预设（供脚本/手写文件）。 */
export const presetFromRaw = (raw: unknown): AudioPreset | null => {
  const d = normalizeAudioDefs(raw);
  if (!d.audioBuses && !d.audioInterfaces && !d.audioObjects) return null;
  return {
    id: newAudioId('pre'),
    name: 'Imported',
    at: Date.now(),
    buses: d.audioBuses ?? [],
    interfaces: d.audioInterfaces ?? [],
    objects: d.audioObjects ?? [],
  };
};
