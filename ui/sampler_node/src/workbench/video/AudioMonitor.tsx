import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { currentAudioHolder, subscribeAudioFocus, type AudioHolder } from './audioFocus';

// ── Audio Monitor 窗 ────────────────────────────────────────────────────────────────────────
// 一只立体的峰值表:画的是**此刻持着音频槽的那个声源**(audioFocus 的仲裁见 audioFocus.ts ——
// 全页同一时刻只有一个窗在出声,Monitor 照着它画;没人出声就是一句空态)。
//
// 电平链路:声明方把 analyserL/R 挂在自己图里,Monitor 每帧 getFloatTimeDomainData 取峰值,
// 20·log10 折成 dB,落在线性 dB 刻度(-60..0,每 3dB 一格,与图中标尺同款)上。表体是 canvas
// 直改(与时间线播放头同一手法),rAF 只在有人持槽时转。两只 S 键拨持有者探头里的 gainL/gainR
// —— 哑掉的那个声道,表和耳朵一起哑(探头在闸之后)。

const MIN_DB = -60;
const PEAK_FALL = 0.42;        // 峰值保持线每帧回落(dB/帧 @60fps ≈ 25dB/s)
const HOLD_FRAMES = 50;        // 峰值线到顶先站这么多帧再落(≈0.8s)

// 刻度色带(按 dB 位置):绿到 -18,黄到 -9,橙到 -6,顶上一截红 —— 与常见 DAW 表同款。
const bandStops: [number, string][] = [
  [0, '#2f9e44'], [0.55, '#2f9e44'], [0.74, '#c9d931'], [0.88, '#f0a020'], [0.93, '#e03131'], [1, '#e03131'],
];
const dbToFrac = (db: number) => Math.max(0, Math.min(1, (db - MIN_DB) / -MIN_DB));

export const VidAudioMonitor: React.FC = () => {
  const holder = useSyncExternalStore(subscribeAudioFocus, currentAudioHolder);
  const holderRef = useRef<AudioHolder | null>(holder);
  holderRef.current = holder;

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const raf = useRef(0);
  // 两声道的运行时状态:**各管各的** —— 表针电平(快攻慢放)+ 峰值保持线(各自的保持计时、
  // 各自回落)。曾经两只声道共用一个保持计时、且任一出新高把两条线一起抬,结果一条被另一条
  // 的活动反复托住、落不落底全看运气;拆开后没声音的声道,线自己落到底并消失。
  const meter = useRef({ lvlL: MIN_DB, lvlR: MIN_DB, holdL: MIN_DB, holdR: MIN_DB, holdTL: 0, holdTR: 0 });
  // S 键:哑掉的声道。换持有者就复位(闸是持有者图里的节点,不能把上一家的哑带过来)。
  const [silenced, setSilenced] = useState<{ l: boolean; r: boolean }>({ l: false, r: false });
  useEffect(() => {
    setSilenced({ l: false, r: false });
    const h = holderRef.current;
    if (h) {
      try { h.probe.gainL.gain.value = 1; h.probe.gainR.gain.value = 1; } catch { /* 节点已散 */ }
    }
  }, [holder]);

  const toggle = (which: 'l' | 'r') => {
    const h = holderRef.current;
    if (!h) return;
    setSilenced(s => {
      const next = { ...s, [which]: !s[which] };
      try {
        h.probe.gainL.gain.value = next.l ? 0 : 1;
        h.probe.gainR.gain.value = next.r ? 0 : 1;
      } catch { /* 节点已散 */ }
      return next;
    });
  };
  // 卸载时把手上的哑放掉 —— 闸是声明方的节点,别把哑留给下一家。
  useEffect(() => () => {
    const h = holderRef.current;
    if (h) { try { h.probe.gainL.gain.value = 1; h.probe.gainR.gain.value = 1; } catch { /* 已散 */ } }
  }, []);

  // ── 表的绘制循环 ── 持槽才转;AnalyserNode 的 getFloatTimeDomainData 是只读快照,不碰图。
  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const buf = new Float32Array(1024);
    let w = 0, h = 0;
    const measure = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      w = Math.max(10, Math.round(r.width));
      h = Math.max(10, Math.round(r.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    measure();

    const grad = () => {
      const g = ctx2d.createLinearGradient(0, h, 0, 0);
      for (const [at, color] of bandStops) g.addColorStop(at, color);
      return g;
    };

    const readDb = (a: AnalyserNode | undefined): number => {
      if (!a) return MIN_DB;
      a.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) { const x = Math.abs(buf[i]); if (x > peak) peak = x; }
      if (peak < 1e-6) return MIN_DB;
      return Math.max(MIN_DB, Math.min(0, 20 * Math.log10(peak)));
    };

    const draw = () => {
      const cur = holderRef.current;
      ctx2d.clearRect(0, 0, w, h);
      ctx2d.fillStyle = '#0b0b0d';
      ctx2d.fillRect(0, 0, w, h);
      const m = meter.current;
      const level = cur
        ? { l: readDb(cur.probe.analyserL), r: readDb(cur.probe.analyserR) }
        : { l: MIN_DB, r: MIN_DB };
      // 表针:快攻(直接跟)慢放(每帧 1.2dB);峰值保持线:到顶站 HOLD_FRAMES 帧,然后按
      // PEAK_FALL 落 —— 每声道独立一套,落到底(MIN_DB)就不再画线 = 消失。
      m.lvlL = Math.max(level.l, m.lvlL - 1.2);
      if (m.lvlL >= m.holdL) { m.holdL = m.lvlL; m.holdTL = HOLD_FRAMES; }
      else if (m.holdTL > 0) m.holdTL -= 1;
      else m.holdL = Math.max(MIN_DB, m.holdL - PEAK_FALL);
      m.lvlR = Math.max(level.r, m.lvlR - 1.2);
      if (m.lvlR >= m.holdR) { m.holdR = m.lvlR; m.holdTR = HOLD_FRAMES; }
      else if (m.holdTR > 0) m.holdTR -= 1;
      else m.holdR = Math.max(MIN_DB, m.holdR - PEAK_FALL);

      const g = grad();
      const chW = Math.floor((w - 26) / 2);      // 右侧留 24px 给 dB 标尺
      const drawCh = (x: number, width: number, lvl: number, hold: number, sil: boolean) => {
        ctx2d.fillStyle = '#101013';
        ctx2d.fillRect(x, 0, width, h);
        if (!sil) {
          const top = h - dbToFrac(lvl) * h;
          ctx2d.save();
          ctx2d.beginPath();
          ctx2d.rect(x, top, width, h - top);
          ctx2d.clip();
          ctx2d.fillStyle = g;
          ctx2d.fillRect(x, 0, width, h);
          ctx2d.restore();
          // 峰值保持线(亮白,压在表体上):落到底**趴在底边**,不消失 —— PR 的口径:
          // 没声音时指示线停在刻度最底下,来了声音再跳上去。
          const hy = Math.round(h - dbToFrac(hold) * h);
          ctx2d.fillStyle = 'rgba(255,255,255,0.85)';
          ctx2d.fillRect(x, Math.min(hy, h - 2), width, 1.5);
        }
        // 中缝。
        ctx2d.fillStyle = 'rgba(255,255,255,0.28)';
        ctx2d.fillRect(x + width - 1, 0, 1, h);
      };
      drawCh(2, chW - 3, m.lvlL, m.holdL, silenced.l);
      drawCh(chW + 3, chW - 3, m.lvlR, m.holdR, silenced.r);
      // dB 标尺(每 3dB 一格,数字写在格线上,风格照用户给的样图)。
      ctx2d.fillStyle = 'rgba(255,255,255,0.42)';
      ctx2d.font = '7.5px ui-sans-serif, system-ui';
      ctx2d.textBaseline = 'middle';
      for (let db = 0; db > MIN_DB; db -= 3) {   // 0..-57,最底下一格留给 'db' 字样(照样图)
        const y = Math.round(h - dbToFrac(db) * h);
        ctx2d.fillRect(w - 22, y - 0.5, 4, 1);
        ctx2d.fillText(String(db), w - 15, y);
      }
      ctx2d.fillText('db', w - 15, h - 5);
      raf.current = requestAnimationFrame(draw);
    };
    raf.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf.current); ro.disconnect(); };
  }, [silenced]);

  const sBtn = (on: boolean): React.CSSProperties => ({
    flexShrink: 0, width: 26, height: 15, borderRadius: 3,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 8.5, fontWeight: 800, letterSpacing: 0.5,
    background: on ? 'rgba(224,49,49,0.28)' : 'rgba(255,255,255,0.05)',
    border: `0.5px solid ${on ? 'rgba(224,49,49,0.75)' : 'rgba(255,255,255,0.14)'}`,
    color: on ? '#ff8787' : 'rgba(255,255,255,0.5)',
    cursor: holder ? 'pointer' : 'default', padding: 0,
  });

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0f0f11', overflow: 'hidden' }}>
      {/* 谁在出声:一行名号;没人出声就是一句空态。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', flexShrink: 0, borderBottom: '0.5px solid rgba(255,255,255,0.08)', minHeight: 20 }}>
        {holder
          ? <span title={holder.label} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, color: 'rgba(255,255,255,0.62)' }}>{holder.label}</span>
          : <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>Nothing playing</span>}
      </div>
      {/* 表体:canvas 直改,跟随窗体大小。minHeight 是内容下限 —— 这窗不进 grows(按内容定高),
          没有下限包裹层会塌成 0,窗只剩头尾两条。 */}
      <div ref={wrapRef} style={{ flex: 1, minHeight: 110, position: 'relative', margin: '6px 8px 4px' }}>
        <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0 }} />
      </div>
      {/* 底排:两枚 M 各自居中在**自己那条声道**的下方 —— 布局镜像 canvas 的分格
          (左右各 flex:1 + 右侧 26px 让给 dB 标尺),不再挤在正中间。 */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '0 8px 6px', flexShrink: 0 }}>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          <button title="Mute the left channel" onClick={() => toggle('l')} style={sBtn(silenced.l)}>M</button>
        </div>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          <button title="Mute the right channel" onClick={() => toggle('r')} style={sBtn(silenced.r)}>M</button>
        </div>
        <div style={{ width: 26, flexShrink: 0 }} />
      </div>
    </div>
  );
};
