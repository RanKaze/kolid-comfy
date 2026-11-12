import React, { useRef, useState } from 'react';
import {
  closureEvents, newAudioId, type AudioObjectDef, type SlotAudio,
} from './audioDefs';
import { isAudioName, type VidController } from './model';
import { ingestFile } from './ingest';
import { S, AudioContextMenu, MountRows, SmallBtn, SidePane, fmtDb } from './audioPanelKit';
import { AudioPresetBar } from './audioPresets';

// ── Audio Object 窗 ────────────────────────────────────────────────────────────────────────
// Object = 名字 + 挂载的 Interface。每挂一个 Interface，就按它的「事件」得到一组槽位；槽位里放
// 音频（当前只放 1 条，数据是数组，以后可扩多条）。Keyframe 事件点选的是 object + event + 参数值，
// 触发时播的就是这个槽位里的音频。

const ASSET_TYPES = ['application/x-vid-asset', 'application/x-asset', 'application/x-vid-global'];
const STAGING_TYPE = 'application/x-blend-staging';

type DropPayload = { id?: string; asset?: string; url?: string; play?: string; name?: string; kind?: string };

const isAudioPayload = (p: DropPayload): boolean =>
  p.kind === 'audio' || (!!p.kind ? false : isAudioName(p.name || p.url || ''));

export const VidAudioObject: React.FC<{ vid: VidController }> = ({ vid }) => {
  const p = vid.project;
  const objects = p.audioObjects ?? [];
  const ifaces = p.audioInterfaces ?? [];
  const [pick, setPick] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [slotMenu, setSlotMenu] = useState<{ x: number; y: number; eventId: string; audioId: string } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const fileFor = useRef<string | null>(null);
  const sel: AudioObjectDef | null = objects.find(o => o.id === pick) ?? objects[0] ?? null;

  const put = (list: AudioObjectDef[], label: string) =>
    vid.update(prev => ({ ...prev, audioObjects: list }), label);
  const patch = (id: string, fn: (o: AudioObjectDef) => AudioObjectDef, label: string) =>
    put(objects.map(o => (o.id === id ? fn(o) : o)), label);

  const setSlot = (objId: string, eventId: string, list: SlotAudio[]) =>
    patch(objId, o => {
      const slots = { ...o.slots };
      if (list.length) slots[eventId] = list; else delete slots[eventId];
      return { ...o, slots };
    }, 'Audio slot · ' + eventId);

  /** 摘掉槽里的一条音频（Delete 键 / 右键菜单 Delete 都走这里）。 */
  const dropAudio = (eventId: string, audioId: string) => {
    if (!sel) return;
    setSlot(sel.id, eventId, (sel.slots[eventId] ?? []).filter(x => x.id !== audioId));
  };

  const add = () => {
    const one: AudioObjectDef = { id: newAudioId('obj'), name: 'Object ' + (objects.length + 1), ifaceIds: [], slots: {} };
    setPick(one.id);
    vid.update(prev => ({ ...prev, audioObjects: [...(prev.audioObjects ?? []), one] }), 'Add audio object');
  };
  const del = (id: string) => {
    vid.update(prev => ({
      ...prev,
      audioObjects: (prev.audioObjects ?? []).filter(o => o.id !== id),
      audioEventPoints: (prev.audioEventPoints ?? []).filter(pt => pt.objectId !== id),
    }), 'Delete audio object');
    if (pick === id) setPick(null);
  };

  /** 换一组挂载的接口。摘掉的接口（含它们嵌套的子接口）不再可达的事件：槽位与事件点一起收掉。 */
  const setIfaces = (objId: string, nextIds: string[]) => {
    vid.update(prev => {
      const nextIfaces = prev.audioInterfaces ?? [];
      const kept = new Set(nextIds.flatMap(iid => closureEvents(nextIfaces, iid).map(x => x.event.id)));
      return {
        ...prev,
        audioObjects: (prev.audioObjects ?? []).map(o => {
          if (o.id !== objId) return o;
          return {
            ...o,
            ifaceIds: nextIds,
            slots: Object.fromEntries(Object.entries(o.slots).filter(([k]) => kept.has(k))),
          };
        }),
        audioEventPoints: (prev.audioEventPoints ?? []).filter(pt => pt.objectId !== objId
          ? true
          : nextIds.includes(pt.ifaceId) && kept.has(pt.eventId)),
      };
    }, 'Attach audio interface');
  };

  /** 把落下来的音频收成一条 SlotAudio（带哈希零拷贝；只有 URL 的先入库拿哈希）。 */
  const acceptAudio = async (raw: DropPayload, fallbackSrc?: string): Promise<SlotAudio | null> => {
    if (!isAudioPayload(raw)) {
      setErr('That card is not an audio file.');
      return null;
    }
    const asset = String(raw.asset || (raw.kind === 'audio' ? raw.id : '') || '').trim();
    const name = raw.name || (raw.url || fallbackSrc || '').split('/').pop() || 'Audio';
    const dur = Number((raw as { duration?: number }).duration);
    if (asset) {
      return {
        id: newAudioId('slo'), name, asset,
        url: '/api/asset_media/' + encodeURIComponent(asset),
        ...(dur > 0 ? { duration: dur } : {}),
      };
    }
    // 只有 URL（Eagle / 图池 / 磁盘文件）：抓成字节，走一次 ffmpeg 入库，拿持久 URL 与哈希。
    try {
      const src = raw.url || raw.play || fallbackSrc || '';
      if (!src) { setErr('That card has no playable audio URL.'); return null; }
      const blob = await fetch(src).then(r => { if (!r.ok) throw new Error('audio fetch failed'); return r.blob(); });
      const ing = await ingestFile(new File([blob], name));
      if (!ing) throw new Error('ingest failed');
      return {
        id: newAudioId('slo'),
        name: ing.name || name,
        ...(ing.asset ? { asset: ing.asset } : {}),
        url: ing.asset ? '/api/asset_media/' + encodeURIComponent(ing.asset) : ing.src,
        ...(ing.duration > 0 ? { duration: ing.duration } : {}),
      };
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return null;
    }
  };

  const bindFromDrop = (e: React.DragEvent, eventId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(null);
    setErr('');
    const dt = e.dataTransfer;

    const stagingRaw = dt.getData(STAGING_TYPE);
    if (stagingRaw) {
      try {
        const st = JSON.parse(stagingRaw) as { id?: string };
        const item = vid.staging.find(x => x.id === st.id);
        if (!item) { setErr('That pool item is gone.'); return; }
        void acceptAudio({ name: item.name, asset: item.asset ?? undefined, kind: 'audio', url: item.src })
          .then(a => { if (a && sel) setSlot(sel.id, eventId, [a]); });
        return;
      } catch { /* 继续看后面的载荷 */ }
    }

    for (const type of ASSET_TYPES) {
      const raw = dt.getData(type);
      if (!raw) continue;
      let payload: DropPayload;
      try { payload = JSON.parse(raw) as DropPayload; } catch { payload = { id: raw }; }
      void acceptAudio(payload).then(a => { if (a && sel) setSlot(sel.id, eventId, [a]); });
      return;
    }

    const file = Array.from(dt.files).find(f => f.type.startsWith('audio/') || isAudioName(f.name));
    if (file) {
      setErr('');
      void ingestFile(file).then(ing => {
        if (!ing || !sel) { setErr('That audio file could not be ingested.'); return; }
        const a: SlotAudio = {
          id: newAudioId('slo'), name: ing.name || file.name,
          ...(ing.asset ? { asset: ing.asset } : {}),
          url: ing.asset ? '/api/asset_media/' + encodeURIComponent(ing.asset) : ing.src,
          ...(ing.duration > 0 ? { duration: ing.duration } : {}),
        };
        setSlot(sel.id, eventId, [a]);
      });
      return;
    }
    setErr('Drop an audio card (Assets / Eagle) or an audio file.');
  };

  const canDrop = (dt: DataTransfer | null): boolean => {
    if (!dt) return false;
    const ts = Array.from(dt.types);
    return ts.some(t => ASSET_TYPES.includes(t) || t === STAGING_TYPE) || ts.includes('Files');
  };

  return (
    <div style={S.root}>
      <SidePane title="Objects" items={objects} selId={sel?.id ?? null} onSelect={setPick}
        onAdd={add} addTitle="Add object"
        onRename={(id, name) => patch(id, o => ({ ...o, name }), 'Rename audio object')}
        onDelete={del} />
      <div style={S.main}>
        <div style={{ marginBottom: 8 }}><AudioPresetBar vid={vid} /></div>
        {!sel ? (
          <div style={S.empty}>
            An object is an instance: attach interfaces, then drop audio onto the slots they provide.
            Keyframe audio events point at an object and one of its events.
          </div>
        ) : (
          <>
            <div style={S.subhead}>Attached interfaces</div>
            <div style={{ maxWidth: 280, marginBottom: 6 }}>
              <MountRows ids={sel.ifaceIds} options={ifaces} addLabel="interface"
                emptyText="No interfaces yet — create one in the Audio Interface window."
                onChange={ids => setIfaces(sel.id, ids)} />
            </div>

            {err && <div style={{ fontSize: 9.5, color: '#ff9f0a', marginBottom: 6 }}>{err}</div>}

            {(() => {
              // 挂一个接口 = 它的组合闭包（自己 + 嵌套子接口）里的所有事件都提供槽位；
              // 同一条事件（id 相同）只出现一次，不因多条路径重复。
              const shown = new Set<string>();
              return sel.ifaceIds.map(iid => {
                const it = ifaces.find(x => x.id === iid);
                if (!it) return null;
                const rows = closureEvents(ifaces, iid).filter(({ event }) => {
                  if (shown.has(event.id)) return false;
                  shown.add(event.id);
                  return true;
                });
                return (
                  <div key={iid}>
                    <div style={S.subhead}>{it.name}</div>
                    {rows.map(({ event: ev, owner }) => {
                      const audios = sel.slots[ev.id] ?? [];
                      const isOver = over === ev.id;
                      return (
                        <div key={ev.id}
                          onDragOver={e => { if (!canDrop(e.dataTransfer)) return; e.preventDefault(); e.stopPropagation(); setOver(ev.id); }}
                          onDragLeave={() => setOver(o => (o === ev.id ? null : o))}
                          onDrop={e => { if (sel) bindFromDrop(e, ev.id); }}
                          style={{
                            ...S.card,
                            borderColor: isOver ? 'rgba(91,156,245,0.85)' : 'rgba(255,255,255,0.09)',
                            background: isOver ? 'rgba(91,156,245,0.10)' : 'rgba(255,255,255,0.02)',
                          }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.75)' }}>{ev.name}</span>
                            {owner.id !== it.id && <span style={S.tag}>{owner.name}</span>}
                            <span style={{ ...S.tag, flex: 1 }}>{audios.length ? '' : 'drop audio here'}</span>
                            <SmallBtn title="Pick an audio file" onClick={() => {
                              fileFor.current = ev.id;
                              fileRef.current?.click();
                            }}>+ audio</SmallBtn>
                          </div>
                        {audios.map(a => (
                          <div
                            key={a.id}
                            tabIndex={0}
                            onContextMenu={e => {
                              e.preventDefault();
                              e.stopPropagation();
                              setSlotMenu({ x: e.clientX, y: e.clientY, eventId: ev.id, audioId: a.id });
                            }}
                            onKeyDown={e => {
                              if ((e.target as HTMLElement).closest('input,select,textarea,button')) return;
                              if (e.key === 'Delete' || e.key === 'Backspace') {
                                e.preventDefault();
                                e.stopPropagation();
                                dropAudio(ev.id, a.id);
                              }
                            }}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 6, outline: 'none',
                              borderRadius: 3,
                            }}
                          >
                            <span title={a.name} style={{
                              flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap', fontSize: 10, color: 'rgba(255,255,255,0.72)',
                            }}>{a.name}</span>
                            <span style={S.tag}>{a.duration ? a.duration.toFixed(2) + 's' : 'audio'}</span>
                            <input type="range" min={0} max={2} step={0.01} value={a.gain ?? 1}
                              title={'Slot gain · ' + fmtDb(a.gain ?? 1)}
                              onChange={e => setSlot(sel.id, ev.id, audios.map(x => (x.id === a.id ? { ...x, gain: Number(e.target.value) } : x)))}
                              style={{ width: 64, accentColor: '#5b9cf5', height: 12, margin: 0 }} />
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              );
              });
            })()}

            <input ref={fileRef} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.opus"
              style={{ display: 'none' }}
              onChange={e => {
                const f = e.target.files?.[0];
                const eventId = fileFor.current;
                e.currentTarget.value = '';
                fileFor.current = null;
                if (!f || !eventId || !sel) return;
                void ingestFile(f).then(ing => {
                  if (!ing) { setErr('That audio file could not be ingested.'); return; }
                  setSlot(sel.id, eventId, [{
                    id: newAudioId('slo'), name: ing.name || f.name,
                    ...(ing.asset ? { asset: ing.asset } : {}),
                    url: ing.asset ? '/api/asset_media/' + encodeURIComponent(ing.asset) : ing.src,
                    ...(ing.duration > 0 ? { duration: ing.duration } : {}),
                  }]);
                });
              }} />
          </>
        )}
      </div>
      <AudioContextMenu
        at={slotMenu}
        onClose={() => setSlotMenu(null)}
        items={slotMenu ? [{
          label: 'Delete', danger: true,
          onClick: () => dropAudio(slotMenu.eventId, slotMenu.audioId),
        }] : []}
      />
    </div>
  );
};
