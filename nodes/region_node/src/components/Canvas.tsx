import React, { useRef, useEffect, useCallback, useState } from 'react';
import type { Box, DragMode } from '../types';

const HANDLE = 8;
const iosFont = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', Roboto, sans-serif`;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function hexRgb(hex: string): { r: number; g: number; b: number } | null {
  const h = (hex || '').replace('#', '');
  if (h.length < 6) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function luminance({ r, g, b }: { r: number; g: number; b: number }): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function readableText(hex: string): string {
  const c = hexRgb(hex);
  if (!c) return '#d4d4d4';
  let { r, g, b } = c;
  const lum = luminance(c);
  const MIN = 130;
  if (lum < MIN) {
    const t = (MIN - lum) / (255 - lum);
    r = Math.round(r + (255 - r) * t);
    g = Math.round(g + (255 - g) * t);
    b = Math.round(b + (255 - b) * t);
  }
  return `rgb(${r},${g},${b})`;
}

function textOn(hex: string): string {
  const c = hexRgb(hex);
  if (!c) return '#000';
  return luminance(c) > 140 ? '#000' : '#fff';
}

function normalizeBox(b: Box): Box {
  let { x, y, w, h } = b;
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  x = clamp01(x);
  y = clamp01(y);
  w = Math.min(w, 1 - x);
  h = Math.min(h, 1 - y);
  return { ...b, x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

interface CanvasProps {
  imageSrc: string;
  canvasWidth: number;
  canvasHeight: number;
  boxes: Box[];
  activeIdx: number;
  bgBrightness: number;
  showBoxText: boolean;
  textStroke: boolean;
  boxOpacity: number;
  onBoxesChange: (boxes: Box[]) => void;
  onActiveIdxChange: (idx: number) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  boxIdx: number;
}

const Canvas: React.FC<CanvasProps> = ({
  imageSrc, canvasWidth, canvasHeight, boxes, activeIdx, bgBrightness, showBoxText, textStroke, boxOpacity,
  onBoxesChange, onActiveIdxChange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const rafRef = useRef(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  const dragState = useRef<{
    drawing: boolean;
    mode: DragMode;
    startN: { x: number; y: number };
    boxAtStart: Box | null;
  }>({ drawing: false, mode: null, startN: { x: 0, y: 0 }, boxAtStart: null });

  const boxesRef = useRef(boxes);
  const activeIdxRef = useRef(activeIdx);
  useEffect(() => { boxesRef.current = boxes; }, [boxes]);
  useEffect(() => { activeIdxRef.current = activeIdx; }, [activeIdx]);

  useEffect(() => {
    if (!imageSrc) {
      // No image — use width/height aspect ratio directly
      imgRef.current = null;
      setImageLoaded(true);
      return;
    }
    const img = new Image();
    img.onload = () => { imgRef.current = img; setImageLoaded(true); };
    img.src = imageSrc;
  }, [imageSrc]);

  const logW = useCallback(() => canvasRef.current?.offsetWidth || 1, []);
  const logH = useCallback(() => canvasRef.current?.offsetHeight || 1, []);

  const mouseN = useCallback((e: PointerEvent | MouseEvent): { x: number; y: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }, []);

  const rectHitTestN = useCallback((
    mx: number, my: number, x1: number, y1: number, x2: number, y2: number, rx: number, ry: number,
  ): DragMode => {
    const h = (cx: number, cy: number) => Math.abs(mx - cx) < rx && Math.abs(my - cy) < ry;
    if (h(x1, y1)) return 'resize-tl';
    if (h(x2, y1)) return 'resize-tr';
    if (h(x1, y2)) return 'resize-bl';
    if (h(x2, y2)) return 'resize-br';
    if (mx >= x1 && mx <= x2 && Math.abs(my - y1) < ry) return 'resize-t';
    if (mx >= x1 && mx <= x2 && Math.abs(my - y2) < ry) return 'resize-b';
    if (my >= y1 && my <= y2 && Math.abs(mx - x1) < rx) return 'resize-l';
    if (my >= y1 && my <= y2 && Math.abs(mx - x2) < rx) return 'resize-r';
    if (mx >= x1 && mx <= x2 && my >= y1 && my <= y2) return 'move';
    return null;
  }, []);

  const boxesAt = useCallback((mN: { x: number; y: number }) => {
    const baseRx = HANDLE / logW();
    const baseRy = HANDLE / logH();
    const res: { index: number; mode: DragMode }[] = [];
    const currentBoxes = boxesRef.current;
    for (let i = 0; i < currentBoxes.length; i++) {
      const b = currentBoxes[i];
      if (b.locked) continue;
      const rx = Math.min(baseRx, b.w / 3);
      const ry = Math.min(baseRy, b.h / 3);
      const mode = rectHitTestN(mN.x, mN.y, b.x, b.y, b.x + b.w, b.y + b.h, rx, ry);
      if (mode) res.push({ index: i, mode });
    }
    const ai = res.findIndex((c) => c.index === activeIdxRef.current);
    if (ai > 0) res.unshift(res.splice(ai, 1)[0]);
    return res;
  }, [logW, logH, rectHitTestN]);

  const hitTest = useCallback((mN: { x: number; y: number }) => {
    const cands = boxesAt(mN);
    if (!cands.length) return null;
    return cands.find((c) => c.index === activeIdxRef.current && c.mode !== 'move') || cands[0];
  }, [boxesAt]);

  function applyDrag(mode: DragMode, start: Box, dN: { x: number; y: number }): Box {
    const { x, y, w, h } = start;
    const dx = dN.x, dy = dN.y;
    if (mode === 'move') {
      return { ...start, x: clamp01(Math.min(x + dx, 1 - w)), y: clamp01(Math.min(y + dy, 1 - h)) };
    }
    if (mode === 'draw') {
      const ax = clamp01(x), ay = clamp01(y);
      const cx = clamp01(x + dx), cy = clamp01(y + dy);
      return { ...start, x: Math.min(ax, cx), y: Math.min(ay, cy), w: Math.abs(cx - ax), h: Math.abs(cy - ay) };
    }
    const suf = mode!.slice(7);
    let l = x, t = y, r = x + w, b = y + h;
    if (suf.includes('l')) l = clamp01(l + dx);
    if (suf.includes('r')) r = clamp01(r + dx);
    if (suf.includes('t')) t = clamp01(t + dy);
    if (suf.includes('b')) b = clamp01(b + dy);
    if (r < l) { const tmp = l; l = r; r = tmp; }
    if (b < t) { const tmp = t; t = b; b = tmp; }
    return { ...start, x: l, y: t, w: r - l, h: b - t };
  }

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.offsetWidth, H = canvas.offsetHeight;
    if (W < 4 || H < 4) return;
    const d = window.devicePixelRatio || 1;
    const bw = Math.round(W * d), bh = Math.round(H * d);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const img = imgRef.current;
    if (img) {
      ctx.drawImage(img, 0, 0, W, H);
      const dim = 1 - bgBrightness / 100;
      if (dim > 0) { ctx.fillStyle = `rgba(0,0,0,${dim})`; ctx.fillRect(0, 0, W, H); }
    } else {
      const g = Math.round(bgBrightness / 100 * 128);
      ctx.fillStyle = `rgb(${g},${g},${g})`; ctx.fillRect(0, 0, W, H);
    }

    const currentBoxes = boxesRef.current;
    const aIdx = activeIdxRef.current;
    const order = currentBoxes.map((_, i) => i).reverse();
    if (aIdx >= 0 && aIdx < currentBoxes.length) {
      const ai = order.indexOf(aIdx);
      if (ai >= 0) { order.splice(ai, 1); order.push(aIdx); }
    }

    for (const i of order) {
      const b = currentBoxes[i];
      const active = i === aIdx;
      const pal = (b.palette || []).filter(Boolean);
      const col = pal.length ? pal[0] : '#8c8c8c';
      const x1 = b.x * W, y1 = b.y * H;
      const x2 = (b.x + b.w) * W, y2 = (b.y + b.h) * H;
      const w = x2 - x1, h = y2 - y1;

      const baseA = boxOpacity / 100;
      ctx.fillStyle = col + Math.round(baseA * 255).toString(16).padStart(2, '0');
      ctx.fillRect(x1, y1, w, h);

      if (b.locked) ctx.setLineDash([3, 3]);
      const lw = active ? 2.5 : 1.5;
      ctx.strokeStyle = col;
      ctx.lineWidth = lw;
      ctx.strokeRect(x1 + lw / 2, y1 + lw / 2, w - lw, h - lw);
      ctx.setLineDash([]);

      if (pal.length && w > 2) {
        const sh = 7;
        const seg = w / pal.length;
        for (let p = 0; p < pal.length; p++) {
          const sx = x1 + Math.round(p * seg);
          ctx.fillStyle = pal[p];
          ctx.fillRect(sx, y1, x1 + Math.round((p + 1) * seg) - sx, sh);
        }
      }

      const tag = String(i + 1).padStart(2, '0');
      ctx.font = `bold 11px ${iosFont}`;
      const tw = ctx.measureText(tag).width + 10;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.roundRect(x1, y1, tw, 16, 4);
      ctx.fill();
      ctx.fillStyle = textOn(col);
      ctx.fillText(tag, x1 + 5, y1 + 12);

      if (showBoxText) {
        let body = b.desc || '';
        if (b.type === 'text' && b.text) body = `"${b.text}"` + (body ? ' — ' + body : '');
        if (body && w > 8 && h > 14) {
          ctx.font = `13px ${iosFont}`;
          if (textStroke) {
            ctx.lineWidth = 3;
            ctx.lineJoin = 'round';
            ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          }
          ctx.fillStyle = readableText(col);
          ctx.save();
          ctx.beginPath();
          ctx.rect(x1, y1, w, h);
          ctx.clip();
          const words = body.split(/\s+/);
          const lines: string[] = [];
          let line = '';
          for (const word of words) {
            const test = line ? line + ' ' + word : word;
            if (line && ctx.measureText(test).width > w - 10) { lines.push(line); line = word; }
            else line = test;
          }
          lines.push(line);
          let ty = y1 + 18;
          for (const ln of lines) {
            if (ty > y2) break;
            if (textStroke) ctx.strokeText(ln, x1 + 5, ty);
            ctx.fillText(ln, x1 + 5, ty);
            ty += 16;
          }

          // Prompt context components (prefabs, loras, prompts, custom)
          const ctxData = b.promptContext;
          if (ctxData) {
            const chips: { label: string; color: string }[] = [];
            const prefabs = ctxData.prefabs || [];
            if (prefabs.length) chips.push({ label: `Prefabs: ${prefabs.length}`, color: '#bf5af2' });
            const loras = ctxData.loras || [];
            const activeLoras = loras.filter((l: any) => l.active !== false);
            if (activeLoras.length) chips.push({ label: `LoRAs: ${activeLoras.length}`, color: '#ff9f0a' });
            const prompts = ctxData.prompts || [];
            if (prompts.length) chips.push({ label: `Prompts: ${prompts.length}`, color: '#30d158' });
            const custom = ctxData.custom_prompts || '';
            if (custom.trim()) chips.push({ label: 'Custom', color: '#0a84ff' });

            if (chips.length && ty < y2) {
              ctx.font = `bold 10px ${iosFont}`;
              let cx = x1 + 5;
              for (const chip of chips) {
                if (ty > y2) break;
                const chipText = chip.label;
                const chipW = ctx.measureText(chipText).width + 10;
                if (cx + chipW > x2 - 4) { cx = x1 + 5; ty += 14; if (ty > y2) break; }
                ctx.fillStyle = chip.color + 'cc';
                ctx.beginPath();
                ctx.roundRect(cx, ty, chipW, 12, 6);
                ctx.fill();
                ctx.fillStyle = '#fff';
                ctx.fillText(chipText, cx + 5, ty + 9);
                cx += chipW + 4;
              }
            }
          }
          ctx.restore();
        }
      }

      if (active) {
        ctx.strokeStyle = '#0a84ff';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(x1 + 1, y1 + 1, w - 2, h - 2);
        ctx.setLineDash([]);
      }
    }
  }, [bgBrightness, showBoxText, textStroke, boxOpacity]);

  const fitCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const availW = wrap.clientWidth;
    const availH = wrap.clientHeight;
    if (availW < 4 || availH < 4) return;
    const img = imgRef.current;
    let aspect = 1;
    if (img) aspect = img.naturalWidth / img.naturalHeight;
    else if (canvasWidth && canvasHeight) aspect = canvasWidth / canvasHeight;
    let cw = availW, ch = cw / aspect;
    if (ch > availH) { ch = availH; cw = ch * aspect; }
    canvas.style.width = Math.round(cw) + 'px';
    canvas.style.height = Math.round(ch) + 'px';
    draw();
  }, [draw]);

  useEffect(() => { if (imageLoaded) fitCanvas(); }, [imageLoaded, fitCanvas]);

  useEffect(() => {
    const onResize = () => fitCanvas();
    window.addEventListener('resize', onResize);
    // Also observe the container itself for layout changes (e.g. iframe split)
    let ro: ResizeObserver | null = null;
    if (wrapRef.current && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => fitCanvas());
      ro.observe(wrapRef.current);
    }
    return () => {
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
    };
  }, [fitCanvas]);

  useEffect(() => {
    if (rafRef.current) return;
    rafRef.current = true;
    requestAnimationFrame(() => { rafRef.current = false; draw(); });
  }, [boxes, activeIdx, draw]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.focus();
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    const mN = mouseN(e.nativeEvent);
    const hit = e.ctrlKey || e.metaKey ? null : hitTest(mN);
    if (hit) {
      onActiveIdxChange(hit.index);
      dragState.current = { drawing: true, mode: hit.mode, startN: mN, boxAtStart: { ...boxesRef.current[hit.index] } };
    } else {
      const nb: Box = { x: mN.x, y: mN.y, w: 0, h: 0, type: 'obj', text: '', desc: '', palette: [] };
      const newBoxes = [...boxesRef.current, nb];
      onBoxesChange(newBoxes);
      onActiveIdxChange(newBoxes.length - 1);
      dragState.current = { drawing: true, mode: 'draw', startN: mN, boxAtStart: { ...nb } };
    }
    e.preventDefault();
    e.stopPropagation();
  }, [mouseN, hitTest, onBoxesChange, onActiveIdxChange]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current.drawing) return;
    const mN = mouseN(e.nativeEvent);
    const dN = { x: mN.x - dragState.current.startN.x, y: mN.y - dragState.current.startN.y };
    const start = dragState.current.boxAtStart;
    if (!start) return;
    const nb = normalizeBox(applyDrag(dragState.current.mode, start, dN));
    const idx = activeIdxRef.current;
    const newBoxes = [...boxesRef.current];
    if (idx >= 0 && idx < newBoxes.length) {
      const { nobbox, ...rest } = nb as Box;
      newBoxes[idx] = { ...rest, nobbox: false };
      onBoxesChange(newBoxes);
    }
  }, [mouseN, onBoxesChange]);

  const onPointerUp = useCallback(() => {
    if (!dragState.current.drawing) return;
    dragState.current.drawing = false;
    const idx = activeIdxRef.current;
    const currentBoxes = boxesRef.current;
    if (idx >= 0 && idx < currentBoxes.length) {
      const b = currentBoxes[idx];
      if (b.w < 0.005 || b.h < 0.005) {
        const newBoxes = currentBoxes.filter((_, i) => i !== idx);
        onBoxesChange(newBoxes);
        onActiveIdxChange(Math.max(0, Math.min(idx, newBoxes.length - 1)));
      }
    }
  }, [onBoxesChange, onActiveIdxChange]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const idx = activeIdxRef.current;
    if (idx < 0) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      const newBoxes = boxesRef.current.filter((_, i) => i !== idx);
      onBoxesChange(newBoxes);
      onActiveIdxChange(Math.max(0, Math.min(idx, newBoxes.length - 1)));
    }
  }, [onBoxesChange, onActiveIdxChange]);

  const [cursor, setCursor] = useState('crosshair');
  const onPointerHover = useCallback((e: React.PointerEvent) => {
    if (dragState.current.drawing) return;
    const mN = mouseN(e.nativeEvent);
    const hit = hitTest(mN);
    if (!hit) { setCursor('crosshair'); return; }
    const mode = hit.mode;
    if (mode === 'move') setCursor('move');
    else if (mode === 'resize-tl' || mode === 'resize-br') setCursor('nwse-resize');
    else if (mode === 'resize-tr' || mode === 'resize-bl') setCursor('nesw-resize');
    else if (mode === 'resize-t' || mode === 'resize-b') setCursor('ns-resize');
    else if (mode === 'resize-l' || mode === 'resize-r') setCursor('ew-resize');
    else setCursor('crosshair');
  }, [mouseN, hitTest]);

  // ── Right-click context menu ──
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const mN = mouseN(e.nativeEvent);
    const cands = boxesAt(mN);
    const target = cands.find((c) => c.index === activeIdxRef.current) || cands[0];
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      boxIdx: target ? target.index : -1,
    });
  }, [mouseN, boxesAt]);

  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const ctxSelect = useCallback((idx: number) => {
    onActiveIdxChange(idx);
    closeCtxMenu();
  }, [onActiveIdxChange, closeCtxMenu]);

  const ctxDelete = useCallback((idx: number) => {
    const newBoxes = boxesRef.current.filter((_, i) => i !== idx);
    onBoxesChange(newBoxes);
    onActiveIdxChange(Math.max(-1, Math.min(idx, newBoxes.length - 1)));
    closeCtxMenu();
  }, [onBoxesChange, onActiveIdxChange, closeCtxMenu]);

  const ctxDuplicate = useCallback((idx: number) => {
    const src = boxesRef.current[idx];
    if (!src) return;
    const clone: Box = {
      ...src,
      x: clamp01(src.x + 0.03),
      y: clamp01(src.y + 0.03),
      palette: [...(src.palette || [])],
    };
    const newBoxes = [...boxesRef.current, clone];
    onBoxesChange(newBoxes);
    onActiveIdxChange(newBoxes.length - 1);
    closeCtxMenu();
  }, [onBoxesChange, onActiveIdxChange, closeCtxMenu]);

  const ctxMoveUp = useCallback((idx: number) => {
    if (idx <= 0) return;
    const newBoxes = [...boxesRef.current];
    [newBoxes[idx - 1], newBoxes[idx]] = [newBoxes[idx], newBoxes[idx - 1]];
    onBoxesChange(newBoxes);
    onActiveIdxChange(idx - 1);
    closeCtxMenu();
  }, [onBoxesChange, onActiveIdxChange, closeCtxMenu]);

  const ctxMoveDown = useCallback((idx: number) => {
    const len = boxesRef.current.length;
    if (idx >= len - 1) return;
    const newBoxes = [...boxesRef.current];
    [newBoxes[idx + 1], newBoxes[idx]] = [newBoxes[idx], newBoxes[idx + 1]];
    onBoxesChange(newBoxes);
    onActiveIdxChange(idx + 1);
    closeCtxMenu();
  }, [onBoxesChange, onActiveIdxChange, closeCtxMenu]);

  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = () => closeCtxMenu();
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeCtxMenu(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [ctxMenu, closeCtxMenu]);

  return (
    <div ref={wrapRef} style={{
      flex: '1 1 auto', minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden', position: 'relative', padding: '4px',
    }}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={(e) => { onPointerMove(e); onPointerHover(e); }}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
        onDoubleClick={(e) => {
          const mN = mouseN(e.nativeEvent);
          const cands = boxesAt(mN);
          const target = cands.find((c) => c.index === activeIdxRef.current) || cands[0];
          if (target) onActiveIdxChange(target.index);
        }}
        style={{
          cursor, display: 'block',
          background: '#000',
          borderRadius: '12px',
          outline: 'none',
          touchAction: 'none',
          boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
        }}
      />

      {/* Right-click context menu */}
      {ctxMenu && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: Math.min(ctxMenu.x, window.innerWidth - 230),
            top: Math.min(ctxMenu.y, window.innerHeight - 320),
            zIndex: 10000,
            background: 'rgba(44,44,46,0.85)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            borderRadius: 14,
            padding: 6,
            minWidth: 200,
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            border: '0.5px solid rgba(255,255,255,0.1)',
            fontFamily: iosFont,
          }}
        >
          <div style={{
            fontSize: 11, fontWeight: 600, color: '#8e8e93',
            padding: '4px 10px 6px', textTransform: 'uppercase', letterSpacing: 0.5,
          }}>
            {ctxMenu.boxIdx >= 0 ? `Region ${String(ctxMenu.boxIdx + 1).padStart(2, '0')}` : 'Regions'}
          </div>

          {boxesRef.current.length > 0 && (
            <div style={{ maxHeight: 200, overflowY: 'auto' }}>
              {boxesRef.current.map((b, i) => {
                const pal = (b.palette || []).filter(Boolean);
                const col = pal.length ? pal[0] : '#8c8c8c';
                const label = b.desc || (b.type === 'text' ? `"${b.text || ''}"` : '') || '(empty)';
                return (
                  <div
                    key={i}
                    onClick={() => ctxSelect(i)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '8px',
                      padding: '6px 10px', borderRadius: 8, cursor: 'pointer',
                      background: i === ctxMenu.boxIdx ? 'rgba(10,132,255,0.2)' : 'transparent',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={(e) => { if (i !== ctxMenu.boxIdx) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)'; }}
                    onMouseLeave={(e) => { if (i !== ctxMenu.boxIdx) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  >
                    <div style={{ width: 14, height: 14, borderRadius: 4, background: col, flexShrink: 0, border: '1px solid rgba(255,255,255,0.15)' }} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#8e8e93', flexShrink: 0 }}>{String(i + 1).padStart(2, '0')}</span>
                    <span style={{ fontSize: 13, color: i === ctxMenu.boxIdx ? '#0a84ff' : '#ccc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {ctxMenu.boxIdx >= 0 && (
            <>
              <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '4px 0' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <CtxBtn label="Duplicate" icon="⧉" onClick={() => ctxDuplicate(ctxMenu.boxIdx)} />
                <CtxBtn label="Move Up" icon="↑" onClick={() => ctxMoveUp(ctxMenu.boxIdx)} />
                <CtxBtn label="Move Down" icon="↓" onClick={() => ctxMoveDown(ctxMenu.boxIdx)} />
                <CtxBtn label="Delete" icon="✕" color="#ff453a" onClick={() => ctxDelete(ctxMenu.boxIdx)} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

const CtxBtn: React.FC<{ label: string; icon: string; color?: string; onClick: () => void }> = ({ label, icon, color, onClick }) => (
  <button
    onClick={onClick}
    style={{
      display: 'flex', alignItems: 'center', gap: '8px',
      padding: '7px 10px', borderRadius: 8, cursor: 'pointer',
      background: 'transparent', border: 'none', fontFamily: iosFont,
      fontSize: 14, color: color || '#fff', width: '100%', textAlign: 'left',
    }}
    onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.08)'}
    onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.background = 'transparent'}
  >
    <span style={{ width: 16, textAlign: 'center', fontSize: 13 }}>{icon}</span>
    {label}
  </button>
);

export default Canvas;
