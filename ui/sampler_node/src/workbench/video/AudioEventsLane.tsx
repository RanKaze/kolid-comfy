import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  closureEvents, ifaceClosure, newAudioId,
  type AudioEventPoint, type AudioInterfaceDef, type AudioObjectDef, type AudioParamDef,
} from './audioDefs';
import { evalCurve, findEvent } from './audioRouting';
import { fmtTime, rulerStep, type VidController } from './model';
import { getVidSelection, subscribeVidSelection } from './selection';

// ── Keyframes 窗顶部的「Audio Events」泳道 ────────────────────────────────────────────────
// 事件点**挂在段上**（任何轨型都行）：这条泳道摊开的是**当前选中的那一段**的段内时间，
// 里面的每个菱形是这一段自己的一个音频事件点，随段移动/裁剪/删除。选中后在下方 Inspector
// 里选 object / interface event / 参数值。
// 触发规则由 audioEventPlayback 实现：播放头向前越过触发一次，暂停/回退/seek 不补发。

const LIST_W = 132;
const LANE_H = 46;
const RULER_H = 20;
const SNAP_PX = 6;

export const AudioEventsLane: React.FC<{ vid: VidController }> = ({ vid }) => {
  const p = vid.project;
  const selection = useSyncExternalStore(subscribeVidSelection, getVidSelection);
  // 恰好选中一段（任何轨型；占位段不播，也不给挂）就是这条泳道的宿主。
  const clip = selection.size === 1
    ? p.clips.find(c => c.id === [...selection][0] && !c.pending) ?? null
    : null;
  const points = (p.audioEventPoints ?? []).filter(pt => pt.clipId === clip?.id);
  const objects = p.audioObjects ?? [];
  const ifaces = p.audioInterfaces ?? [];
  const [open, setOpen] = useState(true);
  const [selId, setSelId] = useState<string | null>(null);
  const [width, setWidth] = useState(600);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const laneRef = useRef<HTMLDivElement | null>(null);
  const phRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<string | null>(null);

  const duration = Math.max(clip?.duration ?? 0, 1);
  const laneW = Math.max(80, width - LIST_W);
  const pps = laneW / duration;
  const step = rulerStep(pps);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // 播放头直接写 transform（不触发整条 lane 的重渲染）。这里画的是**段内**位置。
  useEffect(() => {
    const paint = () => {
      const el = phRef.current;
      if (!el) return;
      if (!clip) { el.style.opacity = '0'; return; }
      const t = vid.transport.get() - clip.start;
      el.style.transform = `translateX(${Math.max(0, Math.min(duration, t)) * pps}px)`;
      el.style.opacity = t >= 0 && t <= duration ? '1' : '0.25';
    };
    paint();
    return vid.transport.subscribe(paint);
  }, [vid, pps, duration, clip]);

  const sel = points.find(x => x.id === selId) ?? null;
  const selEvent = sel ? findEvent(ifaces, sel.ifaceId, sel.eventId) : null;

  const updatePoints = (fn: (list: AudioEventPoint[]) => AudioEventPoint[], label: string) =>
    vid.update(prev => ({ ...prev, audioEventPoints: fn(prev.audioEventPoints ?? []).sort((a, b) => a.t - b.t) }), label);

  const timeAt = (clientX: number): number => {
    const r = laneRef.current?.getBoundingClientRect();
    if (!r) return 0;
    return Math.max(0, Math.min(duration, (clientX - r.left) / pps));
  };

  const snapTargets = (skipId?: string): number[] => {
    const head = clip ? vid.transport.get() - clip.start : 0;
    const t: number[] = [0, duration];
    if (head >= 0 && head <= duration) t.push(head);
    for (const v of [p.inPoint, p.outPoint]) {
      if (v === undefined || !clip) continue;
      const local = v - clip.start;
      if (local >= 0 && local <= duration) t.push(local);
    }
    for (const pt of points) if (pt.id !== skipId) t.push(pt.t);
    return t;
  };
  const snap = (t: number, skipId?: string): number => {
    let best = t, bestD = SNAP_PX / pps;
    for (const target of snapTargets(skipId)) {
      const d = Math.abs(target - t);
      if (d < bestD) { bestD = d; best = target; }
    }
    return Math.max(0, Math.min(duration, best));
  };

  const defaultTriple = (): Pick<AudioEventPoint, 'objectId' | 'ifaceId' | 'eventId' | 'values'> | null => {
    for (const ob of objects) {
      for (const iid of ob.ifaceIds) {
        const it = ifaces.find(x => x.id === iid);
        const first = it ? closureEvents(ifaces, it.id)[0] : undefined;
        if (it && first) {
          const chainParams = ifaceClosure(ifaces, it.id).flatMap(x => x.params);
          return {
            objectId: ob.id, ifaceId: it.id, eventId: first.event.id,
            values: Object.fromEntries([...chainParams, ...first.event.params].map(pr => [pr.id, pr.value])),
          };
        }
      }
    }
    return null;
  };

  const addAt = (t: number) => {
    if (!clip) return;
    const triple = defaultTriple();
    if (!triple) return;
    const pt: AudioEventPoint = { id: newAudioId('aep'), clipId: clip.id, t: snap(t), ...triple };
    setSelId(pt.id);
    updatePoints(list => [...list, pt], 'Add audio event point');
  };

  const onLaneDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-aep]')) return;
    addAt(timeAt(e.clientX));
  };

  const startDrag = (e: React.PointerEvent, pt: AudioEventPoint) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = pt.id;
    setSelId(pt.id);
  };
  const onMove = (e: React.PointerEvent) => {
    const id = dragRef.current;
    if (!id) return;
    const t = snap(timeAt(e.clientX), id);
    updatePoints(list => list.map(x => (x.id === id ? { ...x, t } : x)), 'Move audio event');
  };
  const endDrag = () => { dragRef.current = null; };

  const deleteSel = () => {
    if (!sel) return;
    updatePoints(list => list.filter(x => x.id !== sel.id), 'Delete audio event point');
    setSelId(null);
  };

  const setTriple = (patch: Partial<Pick<AudioEventPoint, 'objectId' | 'ifaceId' | 'eventId'>>) => {
    if (!sel) return;
    const objectId = patch.objectId ?? sel.objectId;
    const ob: AudioObjectDef | undefined = objects.find(o => o.id === objectId);
    const ifaceId = patch.ifaceId ?? (ob?.ifaceIds.includes(sel.ifaceId) ? sel.ifaceId : ob?.ifaceIds[0]);
    const it: AudioInterfaceDef | undefined = ifaces.find(x => x.id === ifaceId);
    const events = it ? closureEvents(ifaces, it.id) : [];
    const eventId = patch.eventId ?? (events.some(x => x.event.id === sel.eventId) ? sel.eventId : events[0]?.event.id);
    const hit = events.find(x => x.event.id === eventId);
    if (!ob || !it || !hit) return;
    const ev = hit.event;
    const chainParams = ifaceClosure(ifaces, it.id).flatMap(x => x.params);
    updatePoints(list => list.map(x => (x.id === sel.id
      ? {
        ...x, objectId: ob.id, ifaceId: it.id, eventId: ev.id,
        values: Object.fromEntries([...chainParams, ...ev.params].map(pr => [pr.id, x.values[pr.id] ?? pr.value])),
      }
      : x)), 'Audio event target');
  };

  const setValue = (paramId: string, v: number) => {
    if (!sel) return;
    updatePoints(list => list.map(x => (x.id === sel.id ? { ...x, values: { ...x.values, [paramId]: v } } : x)),
      'Audio event values · ' + sel.id);
  };

  const obSel = sel ? objects.find(o => o.id === sel.objectId) : undefined;
  const attached = obSel ? ifaces.filter(it => obSel.ifaceIds.includes(it.id)) : [];
  // 选中接口的组合闭包：嵌套子接口的 params / events 都算它的。
  const chain = sel ? ifaceClosure(ifaces, sel.ifaceId) : [];
  const chainParams = chain.flatMap(it => it.params);
  const chainEvents = sel ? closureEvents(ifaces, sel.ifaceId) : [];

  /** 一个参数的一颗控件。接口级参数（这个 interface 的全局参数）与事件自己的参数长得一样。 */
  const paramControl = (pr: AudioParamDef, values: Record<string, number>) => {
    const v = values[pr.id] ?? pr.value;
    return pr.kind === 'boolean' ? (
      <label key={pr.id} style={{ display: 'flex', alignItems: 'center', gap: 4, paddingTop: 3, cursor: 'pointer' }}>
        <input type="checkbox" checked={Number(v) > 0}
          onChange={e => setValue(pr.id, e.target.checked ? 1 : 0)}
          style={{ width: 11, height: 11, margin: 0, accentColor: '#5b9cf5' }} />
        <span style={{ fontSize: 9.5 }}>{pr.name}{pr.invert ? ' (inverted)' : ''}</span>
      </label>
    ) : (
      <label key={pr.id} title={pr.name + ' → ' + Math.round(evalCurve(pr.curve, Number(v)) * 100) + '% gain'}
        style={{ display: 'flex', alignItems: 'center', gap: 4, paddingTop: 3 }}>
        <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.6)' }}>{pr.name}</span>
        <input type="range" min={0} max={1} step={0.01} value={Number(v)}
          onChange={e => setValue(pr.id, Number(e.target.value))}
          style={{ width: 70, accentColor: '#5b9cf5', height: 12, margin: 0 }} />
        <span style={{ fontSize: 8.5, color: 'rgba(255,255,255,0.35)', fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(evalCurve(pr.curve, Number(v)) * 100)}%
        </span>
      </label>
    );
  };

  return (
    <div ref={rootRef}
      tabIndex={0}
      onKeyDown={e => {
        if ((e.target as HTMLElement).closest('input,select,textarea')) return;
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSel(); }
      }}
      style={{
        flexShrink: 0, borderBottom: '0.5px solid rgba(255,255,255,0.1)',
        background: '#17171a', outline: 'none', userSelect: 'none',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 20, padding: '0 6px' }}>
        <button type="button" onClick={() => setOpen(o => !o)}
          title={open ? 'Collapse audio events' : 'Expand audio events'}
          style={{
            width: 16, height: 14, padding: 0, cursor: 'pointer', fontSize: 8, lineHeight: 1,
            background: 'transparent', border: '0.5px solid rgba(255,255,255,0.16)', borderRadius: 3,
            color: 'rgba(255,255,255,0.55)',
          }}>{open ? '▾' : '▸'}</button>
        <span style={{ fontSize: 9.5, letterSpacing: 0.4, textTransform: 'uppercase', color: 'rgba(255,255,255,0.42)' }}>
          Audio Events
        </span>
        <span style={{
          fontSize: 9.5, color: clip ? 'rgba(255,255,255,0.68)' : 'rgba(255,255,255,0.3)',
          maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {clip ? clip.name : 'no segment selected'}
        </span>
        <span style={{ fontSize: 8.5, color: 'rgba(255,255,255,0.28)' }}>
          {clip
            ? 'segment time · double-click to add · fires once when the playhead crosses forward'
            : 'select one segment (any kind) to put audio event points on it'}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 8.5, color: 'rgba(255,255,255,0.3)' }}>{points.length} point{points.length === 1 ? '' : 's'}</span>
      </div>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* 标尺：绝对秒 */}
          <div style={{ display: 'flex', height: RULER_H, borderBottom: '0.5px solid rgba(255,255,255,0.08)', position: 'relative' }}>
            <div style={{ width: LIST_W, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 6px', background: '#1b1b1e', borderRight: '0.5px solid rgba(255,255,255,0.08)' }}>
              <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)' }}>{fmtTime(duration)} segment</span>
            </div>
            <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
              {Array.from({ length: Math.floor(duration / step) + 1 }, (_, i) => i * step).map(t => (
                <div key={t} style={{ position: 'absolute', left: t * pps, top: 3, bottom: 0, pointerEvents: 'none' }}>
                  <div style={{ width: 1, height: 5, background: 'rgba(255,255,255,0.35)' }} />
                  <span style={{ position: 'absolute', left: 3, top: 5, fontSize: 8, color: 'rgba(255,255,255,0.4)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {fmtTime(t)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* 泳道 */}
          <div style={{ display: 'flex', height: LANE_H }}>
            <div style={{ width: LIST_W, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 6px', background: '#18181b', borderRight: '0.5px solid rgba(255,255,255,0.08)' }}>
              <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.55)' }}>Audio Events</span>
            </div>
            <div ref={laneRef}
              onDoubleClick={onLaneDoubleClick}
              onPointerMove={onMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              style={{ flex: 1, position: 'relative', overflow: 'hidden', cursor: clip ? 'crosshair' : 'default', background: 'rgba(255,255,255,0.012)' }}>
              {Array.from({ length: Math.floor(duration / step) + 1 }, (_, i) => i * step).map(t => (
                <div key={t} style={{ position: 'absolute', left: t * pps - 0.5, top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.045)', pointerEvents: 'none' }} />
              ))}
              {points.map(pt => {
                const ev = findEvent(ifaces, pt.ifaceId, pt.eventId);
                const on = pt.id === selId;
                return (
                  <button key={pt.id} data-aep={pt.id} type="button"
                    title={`${ev?.name ?? 'event'} @ ${fmtTime(pt.t)} — drag to move, Delete to remove`}
                    onPointerDown={e => startDrag(e, pt)}
                    onDoubleClick={e => e.stopPropagation()}
                    style={{
                      position: 'absolute', left: pt.t * pps - 7, top: (LANE_H - 14) / 2,
                      width: 14, height: 14, padding: 0, border: 'none', background: 'transparent',
                      cursor: 'ew-resize', zIndex: on ? 3 : 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                    <span style={{
                      width: 9, height: 9, transform: 'rotate(45deg)', borderRadius: 1,
                      background: on ? '#ffd166' : '#d9a63c',
                      boxShadow: on ? '0 0 0 1.5px rgba(255,209,102,0.6)' : 'none',
                    }} />
                  </button>
                );
              })}
              <div ref={phRef} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 1, background: '#ff453a', pointerEvents: 'none', zIndex: 4 }} />
              {points.length === 0 && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: 'rgba(255,255,255,0.26)', pointerEvents: 'none' }}>
                  {!clip
                    ? 'Select a single segment (any kind) to place audio event points on it.'
                    : objects.length && ifaces.length
                      ? 'Double-click to place an audio event point on this segment.'
                      : 'Create an Audio Object + Interface first.'}
                </div>
              )}
            </div>
          </div>

          {/* Inspector：绑哪个 object / event、参数值 */}
          {sel && (
            <div style={{ display: 'flex', gap: 8, padding: '6px 8px', borderTop: '0.5px solid rgba(255,255,255,0.08)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', paddingTop: 4 }}
                title={clip ? 'timeline ' + fmtTime(clip.start + sel.t) : undefined}>
                @ {fmtTime(sel.t)}
              </span>
              <select value={sel.objectId} onChange={e => setTriple({ objectId: e.target.value })}
                style={selStyle}>
                {objects.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              <select value={sel.ifaceId} onChange={e => setTriple({ ifaceId: e.target.value })}
                style={selStyle}>
                {attached.map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
              </select>
              <select value={sel.eventId} onChange={e => setTriple({ eventId: e.target.value })}
                style={selStyle}>
                {chainEvents.map(({ event, owner }) => (
                  <option key={event.id} value={event.id}>
                    {owner.id === sel.ifaceId ? event.name : event.name + ' · ' + owner.name}
                  </option>
                ))}
              </select>

              {/* 接口级参数（含嵌套继承的，全局）在前，事件自己的参数在后。 */}
              {chainParams.map(pr => paramControl(pr, sel.values))}
              {selEvent?.params.map(pr => paramControl(pr, sel.values))}
              <span style={{ flex: 1 }} />
              <button type="button" onClick={deleteSel}
                style={{
                  height: 18, padding: '0 6px', fontSize: 9, borderRadius: 3, cursor: 'pointer',
                  background: 'transparent', border: '0.5px solid rgba(255,255,255,0.14)', color: 'rgba(255,120,110,0.85)',
                }}>Delete</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const selStyle: React.CSSProperties = {
  height: 19, fontSize: 9.5, color: 'rgba(255,255,255,0.8)', background: '#1b1b1e',
  border: '0.5px solid rgba(255,255,255,0.13)', borderRadius: 4, padding: '0 3px', outline: 'none',
};
