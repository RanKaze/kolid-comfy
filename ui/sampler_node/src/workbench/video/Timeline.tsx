import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  type VidClip, type VidController,
  addTrack, clipAt, fmtTime, importToTrack, isAudioName, isVideoName, moveClip, placeAsset, removeClip, removeTrack,
  trackOf, trimClip, unlinkGroup, vidDuration,
} from './model';
import { probeMedia } from './audio';

// ── Tracks 窗（时间线）───────────────────────────────────────────────────────────────────────
// 一根标尺 + 若干轨道。视频轨在上、音频轨在下（tracks 数组序）；标尺上是播放头（红色，当前
// 播放位置）与一对入/出点（I/O，播放范围）。交互：
//  * 标尺按下/拖动 = scrub（改播放头）；
//  * I/O 两个小把手各自拖动，圈出播放范围（Player 在范围内循环）；
//  * 片段：拖身体 = 移动（联动组整组走；**按住 Alt 只动自己** —— 音视频错开的口子），
//    左右边 = 裁剪（Alt 同理只裁自己），点 ⧉ 徹底解绑，✕ = 删除，Delete 键删选中的；
//  * 拖入：Assets 窗的资产（application/x-vid-asset，只引用不复制）、图池条目
//    （application/x-blend-staging）或本地视频/音频文件 —— 后两者**先入资产库再落片段**
//    （Assets 是项目所有数据的来源，不存在"直接进轨道"的路），落在哪条轨就进哪条轨
//    （纯音频源会被改派到音频轨）；带音频的视频当场拆一条联动音频段。
// 状态全部来自 `vid` 控制器 —— 这一格自己不存任何权威状态，刷新/换模式都无所谓。
// 播放头走外置 transport（vid.transport）：一响就直改 DOM（线/三角/读数/底注/跟随滚动），
// 不惊动 React —— scrub 与播放都丝滑。

const STAGING_ITEM_TYPE = 'application/x-blend-staging';
const ASSET_ITEM_TYPE = 'application/x-vid-asset';
const RULER_H = 26;
const HEADER_W = 118;
const TRACK_H: Record<'video' | 'audio', number> = { video: 52, audio: 42 };
const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

type DragState =
  | { mode: 'move'; id: string; x0: number; start0: number }
  | { mode: 'l' | 'r'; id: string; x0: number }
  | { mode: 'scrub' }
  | { mode: 'in' }
  | { mode: 'out' };

const btn: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 600, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
  background: 'rgba(255,255,255,0.07)', border: '0.5px solid rgba(255,255,255,0.16)',
  color: 'rgba(255,255,255,0.82)', lineHeight: 1.5, flexShrink: 0,
};

export const VidTimeline: React.FC<{ vid: VidController }> = ({ vid }) => {
  const { project: p, transport, pps } = vid;
  const dur = vidDuration(p);
  const contentW = Math.max((dur + 10) * pps, 640);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [dropLane, setDropLane] = useState<string | null>(null);

  // ── 播放头直改 DOM ── 线、三角、时间读数、底注、跟随滚动都不走 React。
  const lineRef = useRef<HTMLDivElement | null>(null);
  const triRef = useRef<HTMLDivElement | null>(null);
  const readRef = useRef<HTMLSpanElement | null>(null);
  const noteRef = useRef<HTMLDivElement | null>(null);
  const ppsRef = useRef(pps); ppsRef.current = pps;
  const durRef = useRef(dur); durRef.current = dur;
  const projRef = useRef(p); projRef.current = p;
  useEffect(() => {
    const paint = () => {
      const t = transport.get();
      const px = t * ppsRef.current;
      if (lineRef.current) lineRef.current.style.transform = `translateX(${px}px)`;
      if (triRef.current) triRef.current.style.transform = `translateX(${px}px)`;
      if (readRef.current) readRef.current.textContent = `${fmtTime(t)} / ${fmtTime(durRef.current)}`;
      if (noteRef.current) {
        const c = clipAt(projRef.current, t, 'video');
        noteRef.current.textContent = c
          ? `Preview: 「${c.name}」 (${fmtTime(c.offset + (t - c.start))} in source)`
          : 'Preview: no video under the playhead — drag clips from Assets or drop files here';
      }
      // 跟随：播放头走出视野就滚过去（scrub 往回也跟 —— 与原口径一致）。
      const sc = scrollRef.current;
      if (sc && (px < sc.scrollLeft || px > sc.scrollLeft + sc.clientWidth - 48)) {
        sc.scrollLeft = Math.max(0, px - 80);
      }
    };
    paint();
    return transport.subscribe(paint);
  }, [transport]);

  const timeAt = useCallback((clientX: number): number => {
    const el = contentRef.current;
    if (!el) return 0;
    // 时间 0 在轨道头（HEADER_W）右侧 —— lane 的原点，不是内容区原点；标尺/片段/播放头同口径。
    return Math.max(0, (clientX - el.getBoundingClientRect().left - HEADER_W) / vid.pps);
  }, [vid.pps]);

  // ── 拖放落定（图池/本地文件）── Assets 是项目所有数据的来源：先入库（同 src 认领已有的），
  // 再落一段引用它的片段 —— 不存在"直接进轨道"的路。探测是异步的：落成前先量时长、解音频。
  const importSource = useCallback(async (
    src: string, name: string, origin: 'staging' | 'file', trackId: string | null, at: number,
  ) => {
    const info = await probeMedia(src, isAudioName(name) ? 'audio' : 'video');
    if (!info) return;
    vid.update(proj => importToTrack(proj, { src, name, origin }, info, trackId, at));
  }, [vid]);

  // ── 片段拖动 / 裁剪 ── pointer capture 挂在被按的那个元素上，move/up 都回到它身上。
  const startClipDrag = (e: React.PointerEvent, mode: 'move' | 'l' | 'r', clip: VidClip) => {
    e.stopPropagation();
    if (mode === 'move') setSel(clip.id);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { mode, id: clip.id, x0: e.clientX, start0: clip.start };
  };
  const onClipPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.mode === 'scrub' || d.mode === 'in' || d.mode === 'out') return;
    const dragId = d.id;
    // 按住 Alt = 暂时无视联动组，只动/只裁被拖的这一段（音视频错开的临时口子）。
    const linked = !e.altKey;
    if (d.mode === 'move') {
      // 指针脚下是哪条同类轨，就搬去哪条：elementFromPoint 穿过被拖的片段找 lane。
      let trackId: string | undefined;
      const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const lane = hit?.closest?.('[data-vid-track]');
      if (lane) {
        const tid = lane.getAttribute('data-vid-track') || '';
        const tr = trackOf(p, tid);
        const clip = p.clips.find(c => c.id === dragId);
        if (tr && clip && tr.kind === clip.kind) trackId = tid;
      }
      const ns = d.start0 + (e.clientX - d.x0) / vid.pps;
      vid.update(proj => moveClip(proj, dragId, ns, trackId, linked));
    } else {
      const edge: 'l' | 'r' = d.mode;
      vid.update(proj => trimClip(proj, dragId, edge, timeAt(e.clientX), linked));
    }
  };
  const endClipDrag = () => { dragRef.current = null; };

  // ── 标尺 scrub ──
  const scrubRef = useRef(false);
  const onRulerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    scrubRef.current = true;
    vid.seek(timeAt(e.clientX));
  };
  const onRulerMove = (e: React.PointerEvent) => { if (scrubRef.current) vid.seek(timeAt(e.clientX)); };
  const onRulerUp = () => { scrubRef.current = false; };

  // ── 入 / 出点 ──
  const startBound = (e: React.PointerEvent, which: 'in' | 'out') => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { mode: which };
  };
  const onBoundMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || (d.mode !== 'in' && d.mode !== 'out')) return;
    const t = timeAt(e.clientX);
    vid.update(proj => d.mode === 'in'
      ? { ...proj, inPoint: Math.max(0, Math.min(t, proj.outPoint > proj.inPoint ? proj.outPoint - 0.1 : dur - 0.1)) }
      : { ...proj, outPoint: Math.max(proj.inPoint + 0.1, t) });
  };

  // ── 键删 ── Delete/Backspace 删选中的片段（输入框里不抢）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!sel) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable) return;
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      vid.update(proj => removeClip(proj, sel));
      setSel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, vid]);

  // ── 视口度量 ── 自定义横向滚动条需要滚动区/条子的宽度与 scrollLeft。
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [viewW, setViewW] = useState(0);
  const [trackW, setTrackW] = useState(0);
  const [scrollX, setScrollX] = useState(0);
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const measure = () => { setViewW(sc.clientWidth); setTrackW(trackRef.current?.clientWidth ?? 0); };
    const onScroll = () => setScrollX(sc.scrollLeft);
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    if (trackRef.current) ro.observe(trackRef.current);
    sc.addEventListener('scroll', onScroll, { passive: true });
    measure();
    return () => { ro.disconnect(); sc.removeEventListener('scroll', onScroll); };
  }, []);

  // ── Fit ── 整段时间线正好铺满可视 lane（左右留一点余量）。
  const userZoomedRef = useRef(false);                       // 用户手动缩放过 → 停止自动 Fit
  const pendingAnchorRef = useRef<{ t: number; laneV: number } | null>(null);
  const fitZoom = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const d = vidDuration(vid.project);
    if (d <= 0) return;
    const w = Math.max(sc.clientWidth - HEADER_W - 24, 120);
    vid.setPps(Math.max(6, Math.min(480, w / d)));
    userZoomedRef.current = false;
    sc.scrollLeft = 0;
  }, [vid]);

  // ── 自动 Fit ── 没手动缩放过时：挂载/时长变化都重新铺满；拖拽/scrub 进行中不打扰。
  useEffect(() => {
    if (userZoomedRef.current || dragRef.current || scrubRef.current) return;
    fitZoom();
  }, [dur, fitZoom]);

  // ── 缩放 ── 以可视区中心的时间点为锚，缩放前后画面中心不动。
  const zoomBy = (f: number) => {
    const sc = scrollRef.current;
    if (!sc) return;
    const laneV = Math.max(sc.clientWidth - HEADER_W, 1);
    pendingAnchorRef.current = { t: (sc.scrollLeft + laneV / 2) / vid.pps, laneV };
    userZoomedRef.current = true;
    vid.setPps(Math.max(6, Math.min(480, vid.pps * f)));
  };
  useEffect(() => {
    const a = pendingAnchorRef.current;
    if (!a) return;
    pendingAnchorRef.current = null;
    const sc = scrollRef.current;
    if (sc) sc.scrollLeft = Math.max(0, a.t * vid.pps - a.laneV / 2);
  }, [pps, vid.pps]);

  // ── 自定义横向滚动条 ── 几何：thumb 宽 = 视口占比，位置 = scrollLeft 比例。
  const laneContentW = Math.max(contentW - HEADER_W, 1);
  const laneViewW = Math.max(viewW - HEADER_W, 1);
  const maxScroll = Math.max(laneContentW - laneViewW, 0);
  const sbThumbW = maxScroll > 0 ? Math.max(28, Math.min(trackW, laneViewW / laneContentW * trackW)) : trackW;
  const sbSpan = Math.max(trackW - sbThumbW, 1);
  const sbThumbX = maxScroll > 0 ? scrollX / maxScroll * (trackW - sbThumbW) : 0;
  const sbDrag = useRef<{ x0: number; s0: number } | null>(null);
  const onSbDown = (e: React.PointerEvent) => {
    const sc = scrollRef.current, tr = trackRef.current;
    if (!sc || !tr || maxScroll <= 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const onThumb = !!(e.target as HTMLElement)?.dataset?.sbThumb;
    if (!onThumb) { // 点空白处：视窗跳过去（点中即居中），接着顺势进入拖动。
      const rect = tr.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left - sbThumbW / 2) / sbSpan));
      sc.scrollLeft = frac * maxScroll;
    }
    sbDrag.current = { x0: e.clientX, s0: sc.scrollLeft };
  };
  const onSbMove = (e: React.PointerEvent) => {
    const d = sbDrag.current;
    const sc = scrollRef.current;
    if (!d || !sc) return;
    sc.scrollLeft = Math.max(0, Math.min(maxScroll, d.s0 + (e.clientX - d.x0) * (maxScroll / sbSpan)));
  };
  const onSbUp = () => { sbDrag.current = null; };

  // ── 标尺刻度 ── 选一个 ≥64px 的步长。
  const step = STEPS.find(s => s * pps >= 64) ?? STEPS[STEPS.length - 1];
  const ticks: React.ReactNode[] = [];
  for (let t = 0; t <= dur + step * 2; t += step) {
    ticks.push(
      <div key={t} style={{ position: 'absolute', left: HEADER_W + t * pps, top: 0, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', pointerEvents: 'none' }}>
        <div style={{ width: 1, height: 6, background: 'rgba(255,255,255,0.35)' }} />
        <span style={{ fontSize: 8.5, color: 'rgba(255,255,255,0.4)', padding: '0 0 0 2px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmtTime(t)}</span>
      </div>,
    );
  }

  const inSet = p.outPoint > p.inPoint;

  const laneDrop = (e: React.DragEvent, trackId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropLane(null);
    const at = timeAt(e.clientX);
    const sid = e.dataTransfer.getData(ASSET_ITEM_TYPE);
    if (sid) {
      const asset = p.assets.find(a => a.id === sid);
      if (asset) { vid.update(proj => placeAsset(proj, asset, trackId, at)); return; }
    }
    const stagingId = e.dataTransfer.getData(STAGING_ITEM_TYPE);
    if (stagingId) {
      const item = vid.staging.find(s => s.id === stagingId);
      if (item) { void importSource(item.src, item.name || stagingId, 'staging', trackId, at); return; }
    }
    for (const f of Array.from(e.dataTransfer.files || [])) {
      const ok = f.type.startsWith('video/') || f.type.startsWith('audio/') || isVideoName(f.name) || isAudioName(f.name);
      if (!ok) continue;
      void importSource(URL.createObjectURL(f), f.name, 'file', trackId, at);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#141416', minWidth: 0, overflow: 'hidden' }}>
      {/* 头一条：增删轨道、缩放、时间读数。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '0.5px solid rgba(255,255,255,0.08)', flexShrink: 0, flexWrap: 'wrap' }}>
        <button style={btn} title="Add a video track on top" onClick={() => vid.update(p2 => addTrack(p2, 'video'))}>+ Video Track</button>
        <button style={btn} title="Add an audio track at the bottom" onClick={() => vid.update(p2 => addTrack(p2, 'audio'))}>+ Audio Track</button>
        <div style={{ flex: 1 }} />
        <span ref={readRef} style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', fontVariantNumeric: 'tabular-nums' }}>
          {fmtTime(transport.get())} / {fmtTime(dur)}
        </span>
        <button style={{ ...btn, width: 26, padding: '3px 0', textAlign: 'center' }} title="Zoom out" onClick={() => zoomBy(1 / 1.3)}>−</button>
        <button style={{ ...btn, width: 26, padding: '3px 0', textAlign: 'center' }} title="Zoom in" onClick={() => zoomBy(1.3)}>+</button>
        <button style={btn} title="Zoom to fit the whole timeline in view" onClick={fitZoom}>Fit</button>
      </div>

      {/* 滚动区：标尺 sticky 在顶、轨道头 sticky 在左；原生滚动条整体隐藏（Chromium 155+ 已不认
          ::-webkit-scrollbar，用标准 scrollbar-width:none），横向导航交给下面的自定义条。 */}
      <div ref={scrollRef} data-vid-scroll="" style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative', scrollbarWidth: 'none' }}>
        <div ref={contentRef} style={{ width: contentW, position: 'relative', minHeight: '100%' }}>

          {/* 标尺：scrub + I/O 把手。 */}
          <div
            onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp} onPointerCancel={onRulerUp}
            style={{ position: 'sticky', top: 0, height: RULER_H, zIndex: 5, background: '#141416', borderBottom: '0.5px solid rgba(255,255,255,0.10)', cursor: 'ew-resize', userSelect: 'none' }}
          >
            {/* 角格：与轨道头同宽同色，横向滚动时钉在左上，刻度从它右边才开始。 */}
            <div style={{ position: 'sticky', left: 0, width: HEADER_W, height: '100%', flexShrink: 0, zIndex: 7, background: '#1b1b1e', borderRight: '0.5px solid rgba(255,255,255,0.10)' }} />
            {ticks}
            {inSet && (
              <div style={{ position: 'absolute', left: HEADER_W + p.inPoint * pps, width: (p.outPoint - p.inPoint) * pps, top: 0, bottom: 0, background: 'rgba(10,132,255,0.10)', pointerEvents: 'none' }} />
            )}
            {/* 入点把手 */}
            <div
              onPointerDown={e => startBound(e, 'in')} onPointerMove={onBoundMove} onPointerUp={endClipDrag} onPointerCancel={endClipDrag}
              title="In point — drag to set where playback loops from"
              style={{ position: 'absolute', left: HEADER_W + p.inPoint * pps - 1, top: 0, width: 9, height: RULER_H, cursor: 'ew-resize', background: 'rgba(10,132,255,0.55)', borderTopLeftRadius: 3, borderBottomLeftRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <span style={{ color: '#fff', fontSize: 8, fontWeight: 700, pointerEvents: 'none' }}>I</span>
            </div>
            {/* 出点把手 */}
            <div
              onPointerDown={e => startBound(e, 'out')} onPointerMove={onBoundMove} onPointerUp={endClipDrag} onPointerCancel={endClipDrag}
              title="Out point — drag to set where playback loops to"
              style={{ position: 'absolute', left: HEADER_W + (inSet ? p.outPoint : Math.max(dur, p.inPoint + 0.1)) * pps - 8, top: 0, width: 9, height: RULER_H, cursor: 'ew-resize', background: inSet ? 'rgba(10,132,255,0.55)' : 'rgba(255,255,255,0.18)', borderTopRightRadius: 3, borderBottomRightRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <span style={{ color: '#fff', fontSize: 8, fontWeight: 700, pointerEvents: 'none' }}>O</span>
            </div>
            {/* 播放头三角（left 只钉基准，逐帧位移交给 transport 订阅者直改 transform）。 */}
            <div ref={triRef} style={{ position: 'absolute', left: HEADER_W - 5, top: 0, width: 10, height: 8, background: '#ff453a', clipPath: 'polygon(0 0, 100% 0, 50% 100%)', pointerEvents: 'none' }} />
          </div>

          {/* 轨道。 */}
          {p.tracks.map(tr => (
            <div key={tr.id} style={{ display: 'flex', height: TRACK_H[tr.kind], borderBottom: '0.5px solid rgba(255,255,255,0.06)', background: tr.kind === 'video' ? 'transparent' : 'rgba(48,209,88,0.03)' }}>
              {/* 轨道头：名字、类型记号、删除。 */}
              <div style={{ position: 'sticky', left: 0, width: HEADER_W, flexShrink: 0, zIndex: 4, background: '#1b1b1e', borderRight: '0.5px solid rgba(255,255,255,0.10)', display: 'flex', alignItems: 'center', gap: 5, padding: '0 8px' }}>
                <span style={{ fontSize: 9, color: tr.kind === 'video' ? '#64d2ff' : '#30d158', flexShrink: 0 }}>
                  {tr.kind === 'video' ? '▣' : '♪'}
                </span>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.75)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tr.name}</span>
                <button
                  title={'Delete track 「' + tr.name + '」 (its clips go with it)'}
                  onClick={() => { vid.update(proj => removeTrack(proj, tr.id)); setSel(s => (s && p.clips.some(c => c.id === s && c.trackId === tr.id)) ? null : s); }}
                  style={{ flexShrink: 0, width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', borderRadius: 4, color: 'rgba(255,255,255,0.4)', cursor: 'pointer', padding: 0 }}
                >
                  <svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M3 3l6 6M9 3l-6 6" /></svg>
                </button>
              </div>
              {/* lane：片段落在这里。 */}
              <div
                data-vid-track={tr.id}
                onDragOver={e => { const ts = e.dataTransfer.types; if (ts.includes(ASSET_ITEM_TYPE) || ts.includes(STAGING_ITEM_TYPE) || Array.from(ts).includes('Files')) { e.preventDefault(); setDropLane(tr.id); } }}
                onDragLeave={() => setDropLane(l => (l === tr.id ? null : l))}
                onDrop={e => laneDrop(e, tr.id)}
                onClick={() => setSel(null)}
                style={{ position: 'relative', flex: 1, minWidth: 0, background: dropLane === tr.id ? 'rgba(10,132,255,0.08)' : 'transparent' }}
              >
                {p.clips.filter(c => c.trackId === tr.id).map(c => {
                  const gid = c.groupId;
                  return (
                    <Clip key={c.id} clip={c} pps={pps} selected={sel === c.id}
                      onStartDrag={startClipDrag} onPointerMove={onClipPointerMove} onPointerUp={endClipDrag}
                      onDelete={() => { vid.update(proj => removeClip(proj, c.id)); setSel(s => (s === c.id ? null : s)); }}
                      onUnlink={() => { if (gid) vid.update(proj => unlinkGroup(proj, gid)); }} />
                  );
                })}
              </div>
            </div>
          ))}

          {/* 播放头竖线：横穿标尺与所有轨道（时间 0 = 轨道头右缘；逐帧位移走 transport）。 */}
          <div ref={lineRef} style={{ position: 'absolute', left: HEADER_W - 1, top: 0, bottom: 0, width: 2, background: '#ff453a', zIndex: 6, pointerEvents: 'none', opacity: 0.9 }} />
        </div>
      </div>

      {/* 自定义横向滚动条：常驻、对齐 lane 区域（左侧空出轨道头宽度）。
          点空白 = 视窗跳过去并顺势拖动；拖 thumb = 精细滚动。 */}
      <div style={{ display: 'flex', height: 14, flexShrink: 0, background: '#141416', borderTop: '0.5px solid rgba(255,255,255,0.06)' }}>
        <div style={{ width: HEADER_W, flexShrink: 0, background: '#1b1b1e', borderRight: '0.5px solid rgba(255,255,255,0.10)' }} />
        <div
          ref={trackRef}
          onPointerDown={onSbDown} onPointerMove={onSbMove} onPointerUp={onSbUp} onPointerCancel={onSbUp}
          style={{ flex: 1, position: 'relative', touchAction: 'none', userSelect: 'none' }}
        >
          <div
            data-sb-thumb="1"
            style={{ position: 'absolute', top: 3, bottom: 3, left: sbThumbX, width: sbThumbW, borderRadius: 4, background: 'rgba(255,255,255,0.18)', cursor: maxScroll > 0 ? 'grab' : 'default' }}
          />
        </div>
      </div>

      {/* 底注：当前播放头下的画面来自哪段（transport 订阅者直改文本）。 */}
      <div ref={noteRef} style={{ padding: '4px 10px', fontSize: 10.5, color: 'rgba(255,255,255,0.4)', borderTop: '0.5px solid rgba(255,255,255,0.06)', flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} />
    </div>
  );
};

// ── 一段片段 ────────────────────────────────────────────────────────────────────────────────
const Clip: React.FC<{
  clip: VidClip;
  pps: number;
  selected: boolean;
  onStartDrag: (e: React.PointerEvent, mode: 'move' | 'l' | 'r', clip: VidClip) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onDelete: () => void;
  onUnlink: () => void;
}> = ({ clip: c, pps, selected, onStartDrag, onPointerMove, onPointerUp, onDelete, onUnlink }) => {
  const isAudio = c.kind === 'audio';
  return (
    <div
      onPointerDown={e => onStartDrag(e, 'move', c)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      title={`${c.name} — ${fmtTime(c.duration)}${c.hasAudio ? ' · audio' : ''}${c.groupId ? ' · linked A/V (Alt-drag moves this one alone; click ⧉ to unlink for good)' : ''}`}
      style={{
        position: 'absolute', left: c.start * pps, width: Math.max(8, c.duration * pps), top: 4, bottom: 4,
        borderRadius: 6, overflow: 'hidden', cursor: 'grab', userSelect: 'none',
        background: isAudio ? 'rgba(48,209,88,0.28)' : 'rgba(10,132,255,0.32)',
        border: selected ? '1px solid rgba(255,255,255,0.9)' : `0.5px solid ${isAudio ? 'rgba(48,209,88,0.65)' : 'rgba(10,132,255,0.7)'}`,
        display: 'flex', alignItems: 'center', padding: '0 8px', gap: 6,
      }}
    >
      <span style={{ fontSize: 10.5, fontWeight: 600, color: 'rgba(255,255,255,0.9)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none' }}>{c.name}</span>
      <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.55)', flexShrink: 0, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' }}>{fmtTime(c.duration)}</span>
      {c.groupId && (
        <button
          title="Linked A/V pair — click to unlink; each side then moves/trims on its own (hold Alt while dragging for a one-off)"
          onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onUnlink(); }}
          style={{ flexShrink: 0, fontSize: 9, color: 'rgba(255,255,255,0.55)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1 }}
        >⧉</button>
      )}
      {/* 裁剪把手：左右各一条窄带。 */}
      <div onPointerDown={e => onStartDrag(e, 'l', c)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 7, cursor: 'ew-resize', background: 'rgba(255,255,255,0.14)' }} />
      <div onPointerDown={e => onStartDrag(e, 'r', c)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 7, cursor: 'ew-resize', background: 'rgba(255,255,255,0.14)' }} />
      {/* 删除。 */}
      <button
        title="Delete clip" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onDelete(); }}
        style={{ position: 'absolute', top: 1, left: 9, width: 13, height: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)', border: 'none', borderRadius: 3, color: 'rgba(255,255,255,0.75)', cursor: 'pointer', padding: 0, opacity: selected ? 1 : 0.55 }}
      >
        <svg width="7" height="7" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 3l6 6M9 3l-6 6" /></svg>
      </button>
    </div>
  );
};
