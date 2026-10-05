import React, { useRef, useEffect, useCallback } from 'react';

// ---- hex <-> hsv helpers ----
function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return { h: 0, s: 0, v: 1 };
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

interface ColorWheelProps {
  color: string;
  onChange: (hex: string) => void;
  size?: number;
}

const ColorWheel: React.FC<ColorWheelProps> = ({ color, onChange, size = 156 }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef(false);

  // Paint the wheel once (pixel-wise HSV wheel: angle = hue, radius = saturation)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(size, size);
    const c = size / 2;
    const rMax = c - 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - c + 0.5;
        const dy = y - c + 0.5;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const i = (y * size + x) * 4;
        if (dist > rMax) {
          img.data[i + 3] = 0; // transparent outside
          continue;
        }
        let angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90; // 0deg = top
        if (angle < 0) angle += 360;
        const s = Math.min(1, dist / rMax);
        const [r, g, b] = (() => {
          const hex = hsvToHex(angle, s, 1);
          return [
            parseInt(hex.slice(1, 3), 16),
            parseInt(hex.slice(3, 5), 16),
            parseInt(hex.slice(5, 7), 16),
          ];
        })();
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [size]);

  // Pointer position -> hue/sat -> hex
  const pickAt = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const c = rect.width / 2;
    const dx = clientX - rect.left - c;
    const dy = clientY - rect.top - c;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const rMax = c - 2;
    if (dist > rMax) return;
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    if (angle < 0) angle += 360;
    const s = Math.min(1, dist / rMax);
    onChange(hsvToHex(angle, s, 1));
  }, [onChange]);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    draggingRef.current = true;
    pickAt(e.clientX, e.clientY);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    pickAt(e.clientX, e.clientY);
  };
  const onPointerUp = () => { draggingRef.current = false; };

  // Indicator position from current color
  const hsv = hexToHsv(color);
  const c = size / 2;
  const rMax = c - 2;
  const rad = ((hsv.h - 90) * Math.PI) / 180;
  const rr = hsv.s * rMax;
  const ix = c + rr * Math.cos(rad);
  const iy = c + rr * Math.sin(rad);

  return (
    <div className="color-wheel-row">
      <div className="color-wheel-wrap" style={{ width: size, height: size }}>
        <canvas
          ref={canvasRef}
          width={size}
          height={size}
          className="color-wheel"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
        />
        {/* indicator dot */}
        <div className="color-wheel-dot" style={{ left: ix, top: iy, background: color }} />
      </div>
      {/* current color swatch beside the wheel */}
      <div className="color-wheel-current" style={{ background: color }} />
    </div>
  );
};

export default ColorWheel;
