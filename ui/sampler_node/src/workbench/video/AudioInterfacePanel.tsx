import React, { useState } from 'react';
import {
  closureEvents, eventInClosure, newAudioId, wouldCycleIface,
  type AudioEventDef, type AudioInterfaceDef, type AudioParamDef,
} from './audioDefs';
import type { VidController } from './model';
import { S, AudioContextMenu, Field, MountRows, RenameLabel, SidePane, SmallBtn, Toggle, useRename } from './audioPanelKit';
import { CurveEditor } from './CurveEditor';
import { AudioPresetBar } from './audioPresets';

// ── Audio Interface 窗 ─────────────────────────────────────────────────────────────────────
// 接口 = 一组「事件」的声明；事件 = 名字 + 常开总线 + 参数（float / boolean）。参数的值就是触发
// 该事件时必须给的那几个数：float 经曲线映射成总线增益，boolean 直接开关（可 invert）。
// 这里只编辑定义；Object 窗按事件的 id 提供音频槽位，Keyframes 的事件点填参数值。
//
// 名字只是代号：没有常驻输入框。接口在左列双击改名；事件与参数在自己的卡片上双击名字改名，
// 或右键菜单 Rename。删除一律走 Delete 键（先点一下那张卡 / 那一行）与右键菜单 Delete。

const LINEAR = [{ u: 0, g: 0 }, { u: 1, g: 1 }];

/** 事件 / 参数共用的右键菜单目标（id 全局唯一，但删除动作要分开）。 */
type NestedMenu =
  | { kind: 'event'; x: number; y: number; eventId: string }
  | { kind: 'param'; x: number; y: number; eventId: string; paramId: string }
  | { kind: 'ifaceParam'; x: number; y: number; paramId: string };

export const VidAudioInterface: React.FC<{ vid: VidController }> = ({ vid }) => {
  const p = vid.project;
  const ifaces = p.audioInterfaces ?? [];
  const buses = p.audioBuses ?? [];
  const [pick, setPick] = useState<string | null>(null);
  const [openCurve, setOpenCurve] = useState<string | null>(null);
  const [menu, setMenu] = useState<NestedMenu | null>(null);
  const ren = useRename();
  const sel: AudioInterfaceDef | null = ifaces.find(i => i.id === pick) ?? ifaces[0] ?? null;

  const put = (list: AudioInterfaceDef[], label: string) =>
    vid.update(prev => ({ ...prev, audioInterfaces: list }), label);
  const patchIface = (id: string, fn: (it: AudioInterfaceDef) => AudioInterfaceDef, label: string) =>
    put(ifaces.map(it => (it.id === id ? fn(it) : it)), label);
  const patchEvent = (ifaceId: string, eventId: string, fn: (ev: AudioEventDef) => AudioEventDef, label: string) =>
    patchIface(ifaceId, it => ({ ...it, events: it.events.map(ev => (ev.id === eventId ? fn(ev) : ev)) }), label);
  const patchParam = (ifaceId: string, eventId: string | null, paramId: string,
    fn: (pr: AudioParamDef) => AudioParamDef, label: string) =>
    eventId === null
      ? patchIface(ifaceId, it => ({
        ...it, params: (it.params ?? []).map(pr => (pr.id === paramId ? fn(pr) : pr)),
      }), label)
      : patchEvent(ifaceId, eventId, ev => ({
        ...ev, params: ev.params.map(pr => (pr.id === paramId ? fn(pr) : pr)),
      }), label);

  const addIface = () => {
    const one: AudioInterfaceDef = {
      id: newAudioId('ifc'), name: 'Interface ' + (ifaces.length + 1),
      params: [], ifaceIds: [], events: [],
    };
    setPick(one.id);
    vid.update(prev => ({ ...prev, audioInterfaces: [...(prev.audioInterfaces ?? []), one] }), 'Add audio interface');
  };
  const delIface = (id: string) => {
    vid.update(prev => {
      // 先把接口删掉、并把所有父接口里指向它的嵌套边摘掉；之后按新的组合关系重新校验。
      const nextIfaces = (prev.audioInterfaces ?? [])
        .filter(x => x.id !== id)
        .map(x => ({ ...x, ifaceIds: (x.ifaceIds ?? []).filter(c => c !== id) }));
      const nextObjects = (prev.audioObjects ?? []).map(o => {
        const ifaceIds = o.ifaceIds.filter(x => x !== id);
        // 槽位只留下「仍然从已挂接口（含嵌套）可达」的事件。
        const allowed = new Set(ifaceIds.flatMap(iid => closureEvents(nextIfaces, iid).map(x => x.event.id)));
        return { ...o, ifaceIds, slots: Object.fromEntries(Object.entries(o.slots).filter(([k]) => allowed.has(k))) };
      });
      const byObj = new Map(nextObjects.map(o => [o.id, o] as const));
      return {
        ...prev,
        audioInterfaces: nextIfaces,
        audioObjects: nextObjects,
        audioEventPoints: (prev.audioEventPoints ?? []).filter(pt => {
          const ob = byObj.get(pt.objectId);
          if (!ob || !ob.ifaceIds.includes(pt.ifaceId)) return false;
          return !!eventInClosure(nextIfaces, pt.ifaceId, pt.eventId);
        }),
      };
    }, 'Delete audio interface');
    if (pick === id) setPick(null);
  };

  const addEvent = (ifaceId: string) => {
    patchIface(ifaceId, it => ({
      ...it,
      events: [...it.events, { id: newAudioId('evt'), name: 'Event ' + (it.events.length + 1), busIds: [], params: [] }],
    }), 'Add audio event');
  };
  const delEvent = (ifaceId: string, eventId: string) => {
    vid.update(prev => ({
      ...prev,
      audioInterfaces: (prev.audioInterfaces ?? []).map(it => it.id !== ifaceId
        ? it : { ...it, events: it.events.filter(ev => ev.id !== eventId) }),
      audioObjects: (prev.audioObjects ?? []).map(o => ({
        ...o, slots: Object.fromEntries(Object.entries(o.slots).filter(([k]) => k !== eventId)),
      })),
      audioEventPoints: (prev.audioEventPoints ?? []).filter(pt => pt.eventId !== eventId),
    }), 'Delete audio event');
  };
  /** 加一条参数：`eventId === null` = 接口级（全局），否则是某个事件自己的。 */
  const addParam = (ifaceId: string, eventId: string | null) => {
    const it = ifaces.find(x => x.id === ifaceId);
    const n = eventId === null
      ? (it?.params.length ?? 0)
      : (it?.events.find(e => e.id === eventId)?.params.length ?? 0);
    const one: AudioParamDef = {
      id: newAudioId('prm'), name: 'Value ' + (n + 1),
      kind: 'float', value: 1, curve: LINEAR, busIds: [],
    };
    if (eventId === null) {
      patchIface(ifaceId, x => ({ ...x, params: [...(x.params ?? []), one] }), 'Add audio param');
    } else {
      patchEvent(ifaceId, eventId, e => ({ ...e, params: [...e.params, one] }), 'Add audio param');
    }
  };
  const delParam = (ifaceId: string, eventId: string | null, paramId: string) => {
    if (eventId === null) {
      patchIface(ifaceId, it => ({ ...it, params: (it.params ?? []).filter(x => x.id !== paramId) }), 'Delete audio param');
    } else {
      patchEvent(ifaceId, eventId, e => ({ ...e, params: e.params.filter(x => x.id !== paramId) }), 'Delete audio param');
    }
    if (openCurve === (eventId ?? 'iface') + ':' + paramId) setOpenCurve(null);
  };

  /** 改名提交：`ren.id` 可能是事件 id，也可能是参数 id（两者各自全局唯一）。 */
  const commitRename = () => {
    const id = ren.id;
    const v = ren.draft.trim();
    ren.cancel();
    if (!id || !v || !sel) return;
    const ev = sel.events.find(e => e.id === id);
    if (ev) {
      if (v !== ev.name) patchEvent(sel.id, ev.id, e => ({ ...e, name: v }), 'Rename audio event');
      return;
    }
    const ipr = (sel.params ?? []).find(x => x.id === id);
    if (ipr) {
      if (v !== ipr.name) patchParam(sel.id, null, id, x => ({ ...x, name: v }), 'Rename audio param');
      return;
    }
    for (const e of sel.events) {
      const pr = e.params.find(x => x.id === id);
      if (pr) {
        if (v !== pr.name) patchParam(sel.id, e.id, id, x => ({ ...x, name: v }), 'Rename audio param');
        return;
      }
    }
  };
  const startRename = (id: string, name: string) => ren.start(id, name);

  /** 一张参数卡。`eventId === null` = 接口级（这个 interface 的全局参数），否则属于某个事件。 */
  const renderParam = (eventId: string | null, pr: AudioParamDef) => {
    if (!sel) return null;
    const ifaceId = sel.id;
    const curveKey = (eventId ?? 'iface') + ':' + pr.id;
    const isCurve = openCurve === curveKey;
    return (
      <div
        key={pr.id}
        tabIndex={0}
        onContextMenu={e => {
          e.preventDefault();
          e.stopPropagation();
          setMenu(eventId === null
            ? { kind: 'ifaceParam', x: e.clientX, y: e.clientY, paramId: pr.id }
            : { kind: 'param', x: e.clientX, y: e.clientY, eventId, paramId: pr.id });
        }}
        onKeyDown={e => {
          if ((e.target as HTMLElement).closest('input,select,textarea,button')) return;
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            e.stopPropagation();
            delParam(ifaceId, eventId, pr.id);
          }
        }}
        style={{ ...S.card, marginBottom: 4, padding: '5px 7px', outline: 'none' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
          <RenameLabel
            name={pr.name}
            placeholder="Value"
            editing={ren.id === pr.id}
            draft={ren.draft}
            onStart={() => startRename(pr.id, pr.name)}
            onDraft={ren.setDraft}
            onCommit={commitRename}
            onCancel={ren.cancel}
            style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.8)' }}
          />
          <select value={pr.kind} onChange={e => {
            const kind = e.target.value === 'boolean' ? 'boolean' as const : 'float' as const;
            patchParam(ifaceId, eventId, pr.id, x => ({
              id: x.id, name: x.name, busIds: x.busIds,
              kind, value: kind === 'boolean' ? 1 : 1,
              ...(kind === 'boolean' ? { invert: false } : { curve: LINEAR }),
            }), 'Audio param type');
          }} style={S.select}>
            <option value="float">float</option>
            <option value="boolean">boolean</option>
          </select>
        </div>

        <Field label="Default" width={52}>
          {pr.kind === 'boolean' ? (
            <Toggle on={pr.value > 0} label={pr.value > 0 ? 'on' : 'off'}
              onChange={on => patchParam(ifaceId, eventId, pr.id, x => ({ ...x, value: on ? 1 : 0 }), 'Audio param value · ' + pr.id)} />
          ) : (
            <>
              <input type="range" min={0} max={1} step={0.01} value={pr.value}
                onChange={e => patchParam(ifaceId, eventId, pr.id, x => ({ ...x, value: Number(e.target.value) }), 'Audio param value · ' + pr.id)}
                style={{ flex: 1, minWidth: 50, accentColor: '#5b9cf5', height: 13, margin: 0 }} />
              <span style={{ ...S.tag, width: 34, textAlign: 'right' }}>{Math.round(pr.value * 100)}%</span>
            </>
          )}
        </Field>

        <Field label="Buses" width={52}>
          <MountRows ids={pr.busIds} options={buses} addLabel="bus"
            emptyText="No buses yet — create one in the Audio Bus window."
            onChange={ids => patchParam(ifaceId, eventId, pr.id, x => ({ ...x, busIds: ids }), 'Mount param bus')} />
        </Field>

        {pr.kind === 'boolean' ? (
          <Field label="Switch" width={52}>
            <Toggle on={pr.invert === true} label="invert (false = on)"
              onChange={v => patchParam(ifaceId, eventId, pr.id, x => ({ ...x, invert: v }), 'Audio param invert')} />
          </Field>
        ) : (
          <>
            <Field label="Curve" width={52}>
              <SmallBtn onClick={() => setOpenCurve(isCurve ? null : curveKey)}>
                {isCurve ? 'Hide curve' : 'Edit curve…'}
              </SmallBtn>
              <span style={S.tag}>value → gain</span>
            </Field>
            {isCurve && (
              <div style={{ margin: '4px 0 2px' }}>
                <CurveEditor value={pr.curve}
                  onChange={pts => patchParam(ifaceId, eventId, pr.id, x => ({ ...x, curve: pts }), 'Audio curve · ' + pr.id)} />
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div style={S.root}>
      <SidePane title="Interfaces" items={ifaces} selId={sel?.id ?? null} onSelect={setPick}
        onAdd={addIface} addTitle="Add interface"
        onRename={(id, name) => patchIface(id, it => ({ ...it, name }), 'Rename audio interface')}
        onDelete={delIface} />
      <div style={S.main}>
        <div style={{ marginBottom: 8 }}><AudioPresetBar vid={vid} /></div>
        {!sel ? (
          <div style={S.empty}>
            An interface declares interface-wide params plus events: each event has a name, always-on
            buses, and its own params (float with a curve, or boolean with invert). Audio Objects fill
            one audio slot per event.
          </div>
        ) : (
          <>
            {/* 接口级参数：这个 interface 下每个事件都会带上的那一组。 */}
            <div style={S.subhead}>
              Params
              <span style={{ ...S.tag, textTransform: 'none', letterSpacing: 0 }}>
                interface-wide · applied to every event
              </span>
              <span style={{ flex: 1 }} />
              <SmallBtn onClick={() => addParam(sel.id, null)} title="Add interface param">+ param</SmallBtn>
            </div>
            {sel.params.length === 0 && (
              <div style={{ ...S.empty, padding: '2px 0 8px' }}>
                No interface params — each event can still declare its own below.
              </div>
            )}
            {sel.params.map(pr => renderParam(null, pr))}

            <div style={S.subhead}>
              Events
              <span style={{ flex: 1 }} />
              <SmallBtn onClick={() => addEvent(sel.id)} title="Add event">+ event</SmallBtn>
            </div>

            {sel.events.length === 0 && (
              <div style={S.empty}>No events yet — add one, then give it buses and params.</div>
            )}
            {sel.events.map(ev => (
              <div
                key={ev.id}
                tabIndex={0}
                onContextMenu={e => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenu({ kind: 'event', x: e.clientX, y: e.clientY, eventId: ev.id });
                }}
                onKeyDown={e => {
                  if ((e.target as HTMLElement).closest('input,select,textarea,button')) return;
                  if (e.key === 'Delete' || e.key === 'Backspace') {
                    e.preventDefault();
                    e.stopPropagation();
                    delEvent(sel.id, ev.id);
                  }
                }}
                style={{ ...S.card, outline: 'none' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
                  <RenameLabel
                    name={ev.name}
                    placeholder="Event"
                    editing={ren.id === ev.id}
                    draft={ren.draft}
                    onStart={() => startRename(ev.id, ev.name)}
                    onDraft={ren.setDraft}
                    onCommit={commitRename}
                    onCancel={ren.cancel}
                    style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.8)' }}
                  />
                </div>
                <Field label="Buses" width={52}>
                  <MountRows ids={ev.busIds} options={buses} addLabel="bus"
                    emptyText="No buses yet — create one in the Audio Bus window."
                    onChange={ids => patchEvent(sel.id, ev.id, e => ({ ...e, busIds: ids }), 'Mount event bus')} />
                </Field>

                <div style={S.subhead}>
                  Params
                  <span style={{ flex: 1 }} />
                  <SmallBtn onClick={() => addParam(sel.id, ev.id)} title="Add param">+ param</SmallBtn>
                </div>

                {ev.params.map(pr => renderParam(ev.id, pr))}
              </div>
            ))}

            {/* 组合：父接口自动继承子接口的参数与事件（对象挂父接口就能用全部槽位）。 */}
            <div style={S.subhead}>
              Nested interfaces
              <span style={{ ...S.tag, textTransform: 'none', letterSpacing: 0 }}>
                their params and events are inherited
              </span>
            </div>
            {ifaces.length <= 1 ? (
              <div style={{ ...S.empty, padding: '2px 0 8px' }}>No other interfaces to nest.</div>
            ) : (
              <div style={{ maxWidth: 260 }}>
                <MountRows
                  ids={sel.ifaceIds}
                  options={ifaces.filter(x => x.id !== sel.id)}
                  addLabel="interface"
                  onChange={ids => patchIface(sel.id, it => ({ ...it, ifaceIds: ids }), 'Mount nested interface')}
                  disabledOption={id => (wouldCycleIface(ifaces, sel.id, id) ? 'That mount would create a loop.' : null)}
                />
              </div>
            )}
          </>
        )}
      </div>
      <AudioContextMenu
        at={menu}
        onClose={() => setMenu(null)}
        items={menu && sel ? [
          {
            label: 'Rename',
            onClick: () => {
              if (menu.kind === 'event') {
                const ev = sel.events.find(e => e.id === menu.eventId);
                if (ev) startRename(ev.id, ev.name);
              } else if (menu.kind === 'ifaceParam') {
                const pr = sel.params.find(x => x.id === menu.paramId);
                if (pr) startRename(pr.id, pr.name);
              } else {
                const pr = sel.events.find(e => e.id === menu.eventId)?.params.find(x => x.id === menu.paramId);
                if (pr) startRename(pr.id, pr.name);
              }
            },
          },
          {
            label: 'Delete', danger: true,
            onClick: () => {
              if (menu.kind === 'event') delEvent(sel.id, menu.eventId);
              else if (menu.kind === 'ifaceParam') delParam(sel.id, null, menu.paramId);
              else delParam(sel.id, menu.eventId, menu.paramId);
            },
          },
        ] : []}
      />
    </div>
  );
};
