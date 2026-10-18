import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type VidController, clipAt, fmtTime, vidDuration,
} from './model';
import { decodeAudio, vidAudio } from './audio';

// ── Player 窗（监视器）───────────────────────────────────────────────────────────────────────
// 播放头落在哪，画面就是最上层视频轨命中的那一段（合成口径"最上层优先"）。声音不走 <video>：
// 它永远静音 —— 音频只从 VidAudio 的 WebAudio 图里出来（音频轨上的片段，含视频拆出来的联动段），
// 这样画面与声音各走各的、互不抢设备。
//
// 播放头走外置 transport（vid.transport）：读数/scrub 条每帧直改 DOM，活片段只在**换段**那一刻
// 走 React（换 src）。播放循环是这里的一支 rAF：播放头按墙上时钟前进，出界（入/出点圈了范围
// 就在出点绕回入点，没圈就在片尾停）→ 每帧顺手对一遍音频（扫进来的片段起播、扫出去的停）与
// 画面漂移（>0.25s 才纠，<video> 自己的时钟在短片段上会抖）。scrub / 换段都把 <video> 拉回
// 正确的源内时刻。

export const VidPlayer: React.FC<{ vid: VidController; visible: boolean }> = ({ vid, visible }) => {
  const { project: p, transport, playing } = vid;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readRef = useRef<HTMLSpanElement | null>(null);
  const rangeRef = useRef<HTMLInputElement | null>(null);
  const projectRef = useRef(p);
  projectRef.current = p;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const dur = vidDuration(p);
  const durRef = useRef(dur);
  durRef.current = dur;

  // 活片段：transport 的订阅者比对 id，只有换段才 setState（React 重渲染是稀罕事）。
  const [activeId, setActiveId] = useState<string | null>(() => clipAt(p, transport.get(), 'video')?.id ?? null);
  const activeIdRef = useRef(activeId);
  const active = useMemo(() => (activeId ? p.clips.find(c => c.id === activeId) ?? null : null), [p, activeId]);

  // scrub 合帧：高频 seek 不直接捅 currentTime，攒到下一帧 rAF 一次 —— 消抖且省解码器。
  const pendingScrub = useRef<number | null>(null);
  const scrubRaf = useRef(0);

  const seek = useCallback((t: number) => {
    vidAudio.stopAll();
    transport.set(Math.max(0, t));
  }, [transport]);

  // ── transport 订阅 ── 读数/scrub 条直改；活片段只在换段时走 React；暂停态的画面跟手。
  useEffect(() => {
    const onTick = () => {
      const t = transport.get();
      if (readRef.current) readRef.current.textContent = fmtTime(t);
      if (rangeRef.current) rangeRef.current.value = String(Math.min(t, durRef.current));
      const c = clipAt(projectRef.current, t, 'video');
      const cid = c?.id ?? null;
      if (cid !== activeIdRef.current) {
        activeIdRef.current = cid;
        setActiveId(cid);
      }
      if (!playingRef.current) {
        pendingScrub.current = t;
        if (!scrubRaf.current) {
          scrubRaf.current = requestAnimationFrame(() => {
            scrubRaf.current = 0;
            const tt = pendingScrub.current;
            const v = videoRef.current;
            if (v == null || tt == null) return;
            const c2 = clipAt(projectRef.current, tt, 'video');
            // 同段：直接对准源内时刻；换段交给下面的换段 effect。
            if (v.dataset.clipId === c2?.id && c2 && v.readyState >= 2) {
              try { v.currentTime = Math.max(0, c2.offset + (tt - c2.start)); } catch { /* not seekable */ }
            }
          });
        }
      }
    };
    onTick();
    return transport.subscribe(onTick);
  }, [transport]);

  // ── 换段：换源 + 对准源内时刻。 ──
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!active || !activeId) {
      if (v.dataset.clipId) { delete v.dataset.clipId; v.removeAttribute('src'); v.load(); }
      return;
    }
    if (v.dataset.clipId === activeId) return;
    v.dataset.clipId = activeId;
    v.src = active.src;
    const target = Math.max(0, active.offset + (transport.get() - active.start));
    const onMeta = () => { try { v.currentTime = target; } catch { /* not seekable yet */ } };
    if (v.readyState >= 1) onMeta();
    else v.addEventListener('loadedmetadata', onMeta, { once: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // ── 播 / 停 ──
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) { void v.play().catch(() => { /* autoplay guards */ }); }
    else { v.pause(); vidAudio.stopAll(); }
  }, [playing, activeId]);

  // ── 播放循环 ── 墙上时钟推进播放头（transport.set，不碰 React）；每帧对音频与画面。
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const proj = projectRef.current;
      const total = vidDuration(proj);
      const inP = proj.inPoint;
      const outP = proj.outPoint > proj.inPoint ? proj.outPoint : total;
      let np = transport.get() + dt;
      if (outP > inP && np >= outP) np = inP;            // 范围内循环
      else if (np >= total) {                            // 片尾停
        vidAudio.stopAll();
        transport.set(total);
        vid.setPlaying(false);
        return;
      }
      transport.set(np);
      // 音频：扫进来的起播、扫出去的停。
      for (const c of proj.clips) {
        if (c.kind !== 'audio') continue;
        const covers = np >= c.start && np < c.start + c.duration;
        if (covers && !vidAudio.has(c.id)) {
          void decodeAudio(c.src).then(buf => {
            const cur = transport.get();
            if (!buf || !playingRef.current) return;
            if (!(cur >= c.start && cur < c.start + c.duration)) return;
            vidAudio.start(c.id, buf, cur - c.start + c.offset);
          });
        } else if (!covers && vidAudio.has(c.id)) vidAudio.stop(c.id);
      }
      // 画面漂移：>0.25s 才纠。
      const v = videoRef.current;
      const av = clipAt(proj, np, 'video');
      if (v && av && v.dataset.clipId === av.id && v.readyState >= 2) {
        const expected = av.offset + (np - av.start);
        if (Math.abs(v.currentTime - expected) > 0.25) {
          try { v.currentTime = expected; } catch { /* not seekable */ }
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // ── 收摊：这扇窗被藏起来（切模式 / 切 tab）就停干净。 ──
  useEffect(() => {
    if (visible) return;
    vid.setPlaying(false);
    vidAudio.stopAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const inSet = p.outPoint > p.inPoint;
  const tCtrl: React.CSSProperties = {
    width: 28, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(255,255,255,0.07)', border: '0.5px solid rgba(255,255,255,0.16)',
    borderRadius: 6, color: 'rgba(255,255,255,0.85)', cursor: 'pointer', fontSize: 11, flexShrink: 0,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#0d0d0d', minWidth: 0, overflow: 'hidden' }}>
      {/* 画面。 */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: '#0d0d0d', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <video ref={videoRef} muted playsInline
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: active ? 'block' : 'none' }} />
        {!active && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.28)', fontSize: 12, textAlign: 'center', padding: 20 }}>
            No clip under the playhead.<br />Drop videos onto the Tracks window below.
          </div>
        )}
        {active && (
          <div style={{ position: 'absolute', left: 8, top: 8, padding: '2px 8px', borderRadius: 6, background: 'rgba(0,0,0,0.55)', color: 'rgba(255,255,255,0.8)', fontSize: 10, maxWidth: '70%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {active.name}
          </div>
        )}
        {inSet && (
          <div style={{ position: 'absolute', right: 8, top: 8, padding: '2px 8px', borderRadius: 6, background: 'rgba(10,132,255,0.25)', color: '#9ecbff', fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
            I {fmtTime(p.inPoint)} · O {fmtTime(p.outPoint)}
          </div>
        )}
      </div>
      {/* 走带控制。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderTop: '0.5px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
        <button style={tCtrl} title="Go to In point (or start)" onClick={() => seek(inSet ? p.inPoint : 0)}>⏮</button>
        <button style={{ ...tCtrl, width: 34 }} title={playing ? 'Pause' : 'Play (loops within In/Out when set)'}
          onClick={() => vid.setPlaying(!playing)}>
          {playing ? '⏸' : '▶'}
        </button>
        <button style={tCtrl} title="Stop — pause and return to the In point" onClick={() => { seek(inSet ? p.inPoint : 0); vid.setPlaying(false); }}>⏹</button>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', fontVariantNumeric: 'tabular-nums', marginLeft: 4 }}>
          <span ref={readRef}>{fmtTime(transport.get())}</span>
          <span style={{ color: 'rgba(255,255,255,0.3)' }}> / {fmtTime(dur)}</span>
        </span>
        <div style={{ flex: 1 }} />
        {/* scrub 条：与播放头双向绑定（value 由 transport 订阅者直改，不走 React）。 */}
        <input ref={rangeRef} type="range" min={0} max={Math.max(dur, 0.1)} step={0.01}
          defaultValue={Math.min(transport.get(), Math.max(dur, 0.1))}
          onChange={e => seek(parseFloat(e.target.value))}
          style={{ flex: 1, minWidth: 60, accentColor: '#ff453a' }} title="Scrub" />
      </div>
    </div>
  );
};
