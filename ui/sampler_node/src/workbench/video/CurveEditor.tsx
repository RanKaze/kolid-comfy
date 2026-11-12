import React, { useRef, useState } from 'react';
import { clamp01, type AudioCurvePoint } from './audioDefs';

// ── 曲线编辑器：float 参数的值 → 增益映射（0..1 → 0..1）──────────────────────────────────
// 分段线性；双击空白加点、拖点、右键删点、"Linear" 复位。每次拖动都写回（同一个 label 会合并成
// 一步撤销，见调用方的 vid.update）。

const W = 240, H = 110, PAD = 10;
const toPx = (u: number) => PAD + clamp01(u) * (W - PAD * 2);
const toPy = (g: number) => H - PAD - clamp01(g) * (H - PAD * 2);
const clampPts = (pts: AudioCurvePoint[]): AudioCurvePoint[] =>
  [...pts].map(p => ({ u: clamp01(p.u), g: clamp01(p.g) })).sort((a, b) => a.u - b.u);

export const CurveEditor: React.FC<{
  value?: AudioCurvePoint[];
  onChange: (pts: AudioCurvePoint[]) => void;
  height?: number;
}> = ({ value, onChange, height }) => {
  const [drag, setDrag] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const pts = value && value.length ? value : [{ u: 0, g: 0 }, { u: 1, g: 1 }];
  const path = clampPts(pts).map((p, i) => `${i ? 'L' : 'M'}${toPx(p.u).toFixed(1)} ${toPy(p.g).toFixed(1)}`).join(' ');

  const at = (e: React.PointerEvent | React.MouseEvent): { u: number; g: number } => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return { u: 0, g: 0 };
    const x = (e.clientX - r.left) * (W / r.width);
    const y = (e.clientY - r.top) * (H / r.height);
    return {
      u: clamp01((x - PAD) / (W - PAD * 2)),
      g: clamp01((H - PAD - y) / (H - PAD * 2)),
    };
  };

  const move = (e: React.PointerEvent) => {
    if (drag === null) return;
    const { u, g } = at(e);
    const next = clampPts(pts.map((p, i) => (i === drag ? { u, g } : p)));
    onChange(next);
  };

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      <svg
        ref={svgRef}
        width={W} height={height ?? H}
        viewBox={`0 0 ${W} ${H}`}
        style={{ background: '#141416', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 4, touchAction: 'none', cursor: 'crosshair', display: 'block' }}
        onPointerMove={move}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
        onDoubleClick={e => {
          const { u, g } = at(e);
          if (pts.some(p => Math.abs(p.u - u) < 0.03)) return;
          onChange(clampPts([...pts, { u, g }]));
        }}
        onContextMenu={e => e.preventDefault()}
      >
        {[0, 0.25, 0.5, 0.75, 1].map(x => (
          <g key={'x' + x}>
            <line x1={toPx(x)} y1={PAD / 2} x2={toPx(x)} y2={H - PAD / 2} stroke="rgba(255,255,255,0.07)" strokeWidth={0.5} />
            <line x1={PAD / 2} y1={toPy(x)} x2={W - PAD / 2} y2={toPy(x)} stroke="rgba(255,255,255,0.07)" strokeWidth={0.5} />
          </g>
        ))}
        <path d={path} fill="none" stroke="#5b9cf5" strokeWidth={1.4} />
        {pts.map((p, i) => (
          <circle key={i} cx={toPx(p.u)} cy={toPy(p.g)} r={4}
            fill={drag === i ? '#8fc0ff' : '#5b9cf5'} stroke="#0f0f11" strokeWidth={1}
            style={{ cursor: 'grab' }}
            onPointerDown={e => { e.preventDefault(); (e.target as Element).setPointerCapture?.(e.pointerId); setDrag(i); }}
            onContextMenu={e => {
              e.preventDefault(); e.stopPropagation();
              if (pts.length <= 2) return;
              onChange(clampPts(pts.filter((_, k) => k !== i)));
            }}
          />
        ))}
        <text x={PAD} y={H - 1} fontSize={7} fill="rgba(255,255,255,0.3)">0</text>
        <text x={W - PAD - 5} y={H - 1} fontSize={7} fill="rgba(255,255,255,0.3)">1</text>
      </svg>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button type="button" onClick={() => onChange([{ u: 0, g: 0 }, { u: 1, g: 1 }])}
          style={{ height: 17, padding: '0 6px', fontSize: 9, borderRadius: 3, cursor: 'pointer', background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.14)', color: 'rgba(255,255,255,0.6)' }}>
          Linear
        </button>
        <span style={{ fontSize: 8.5, color: 'rgba(255,255,255,0.28)' }}>
          double-click adds · right-click removes · horizontal = value, vertical = gain
        </span>
      </div>
    </div>
  );
};
