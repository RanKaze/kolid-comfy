import React, { useState } from 'react';
import { newAudioId, stripBusEverywhere, wouldCycleBus, type AudioBusDef } from './audioDefs';
import type { VidController } from './model';
import { S, Field, MountRows, SidePane, fmtDb } from './audioPanelKit';
import { AudioPresetBar } from './audioPresets';

// ── Audio Bus 窗 ────────────────────────────────────────────────────────────────────────────
// 总线是可嵌套的增益链（DAG）：父 bus 的增益作用于所有子 bus，声音沿挂载链串联相乘。
// 这里只编辑定义；真正的"乘法"由 audioRouting.audioEventGain 求成每段 PCM 的 gain。

export const VidAudioBus: React.FC<{ vid: VidController }> = ({ vid }) => {
  const p = vid.project;
  const buses = p.audioBuses ?? [];
  const [pick, setPick] = useState<string | null>(null);
  const sel: AudioBusDef | null = buses.find(b => b.id === pick) ?? buses[0] ?? null;

  const put = (list: AudioBusDef[], label: string) =>
    vid.update(prev => ({ ...prev, audioBuses: list }), label);
  const patch = (id: string, fn: (b: AudioBusDef) => AudioBusDef, label: string) =>
    put(buses.map(b => (b.id === id ? fn(b) : b)), label);

  const add = () => {
    const b: AudioBusDef = { id: newAudioId('bus'), name: 'Bus ' + (buses.length + 1), gain: 1, busIds: [] };
    setPick(b.id);
    vid.update(prev => ({ ...prev, audioBuses: [...(prev.audioBuses ?? []), b] }), 'Add audio bus');
  };
  const del = (id: string) => {
    vid.update(prev => {
      const cut = stripBusEverywhere(prev, id);
      return {
        ...prev,
        audioBuses: cut.buses.length ? cut.buses : undefined,
        audioInterfaces: cut.ifaces.length ? cut.ifaces : undefined,
      };
    }, 'Delete audio bus');
    if (pick === id) setPick(null);
  };

  return (
    <div style={S.root}>
      <SidePane title="Buses" items={buses} selId={sel?.id ?? null} onSelect={setPick}
        onAdd={add} addTitle="Add bus"
        onRename={(id, name) => patch(id, b => ({ ...b, name }), 'Rename audio bus')}
        onDelete={del} />
      <div style={S.main}>
        <div style={{ marginBottom: 8 }}><AudioPresetBar vid={vid} /></div>
        {!sel ? (
          <div style={S.empty}>
            A bus is a gain stage. Create one here, then mount it on an Interface event (always on)
            or on a parameter (modulated by that value).
          </div>
        ) : (
          <>
            <Field label="Gain">
              <input type="range" min={0} max={2} step={0.01} value={sel.gain}
                onChange={e => patch(sel.id, b => ({ ...b, gain: Number(e.target.value) }), 'Audio bus gain · ' + sel.id)}
                onDoubleClick={() => patch(sel.id, b => ({ ...b, gain: 1 }), 'Audio bus gain · ' + sel.id)}
                title="Double-click to reset to 0 dB"
                style={{ flex: 1, minWidth: 60, accentColor: '#5b9cf5', height: 14, margin: 0 }} />
              <span style={{ ...S.tag, width: 58, textAlign: 'right' }}>{fmtDb(sel.gain)}</span>
            </Field>

            <div style={S.subhead}>
              Child buses
              <span style={{ ...S.tag, textTransform: 'none', letterSpacing: 0 }}>
                sound passes parent → child, gains multiply
              </span>
            </div>
            <div style={{ maxWidth: 280 }}>
              <MountRows ids={sel.busIds} options={buses.filter(b => b.id !== sel.id)} addLabel="bus"
                emptyText="No other buses to mount."
                onChange={ids => patch(sel.id, x => ({ ...x, busIds: ids }), 'Mount audio bus')}
                disabledOption={id => (wouldCycleBus(buses, sel.id, id) ? 'That mount would create a loop.' : null)} />
            </div>
          </>
        )}
      </div>
    </div>
  );
};
