import React, { useEffect, useRef, useState, useCallback } from 'react';
import ColorWheel from './components/ColorWheel';
import './styles.css';

// Draw mode (from ?mode=draw): hide Confirm button and sync drawing live to backend
const URL_PARAMS = new URLSearchParams(window.location.search);
const IS_DRAW_MODE = URL_PARAMS.get('mode') === 'draw';

type Tool = 'brush' | 'eraser' | 'eyedropper';

const App: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const srcImgRef = useRef<HTMLImageElement | null>(null); // decoded source (offscreen, never in DOM)
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);   // base image rendered as canvas
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);

  // Offscreen canvases (same pattern as mask_node.html)
  const paintCanvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));   // committed paint layer
  const strokeCanvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));  // current stroke
  const snapshotCanvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas')); // pre-stroke paint snapshot

  // Mutable refs for stroke hot-path
  const brushSizeRef = useRef(20);
  const colorRef = useRef('#ff453a');
  const opacityRef = useRef(1.0);
  const toolRef = useRef<Tool>('brush');
  const isDrawingRef = useRef(false);
  const isErasingRef = useRef(false);
  const isAltResizingRef = useRef(false);
  const isAltPickingRef = useRef(false);
  const altAnchorRef = useRef({ x: 0, y: 0, size: 20, cx: 0, cy: 0 });
  const lastPosRef = useRef({ x: 0, y: 0 });
  const imgSizeRef = useRef<{ w: number; h: number } | null>(null);

  // Brush / eraser mode params (same as mask_node.html)
  type BrushMode = 'binary' | 'linear' | 'exponential';
  const brushModeRef = useRef<BrushMode>('binary');
  const brushStrengthRef = useRef(1.0);
  const brushCenterRef = useRef(1.0);
  const brushEdgeRef = useRef(0.0);
  const brushGammaRef = useRef(2.0);
  const eraserModeRef = useRef<BrushMode>('binary');
  const eraserStrengthRef = useRef(1.0);
  const eraserCenterRef = useRef(1.0);
  const eraserEdgeRef = useRef(0.0);
  const eraserGammaRef = useRef(2.0);

  // UI state
  const [brushSize, setBrushSize] = useState(20);
  const [color, setColor] = useState('#ff453a');
  const [tool, setTool] = useState<Tool>('brush');
  const [status, setStatus] = useState('Loading...');
  const [statusSuccess, setStatusSuccess] = useState(false);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [brushMode, setBrushMode] = useState<BrushMode>('binary');
  const [brushStrength, setBrushStrength] = useState(1.0);
  const [brushCenter, setBrushCenter] = useState(1.0);
  const [brushEdge, setBrushEdge] = useState(0.0);
  const [brushGamma, setBrushGamma] = useState(2.0);
  const [eraserMode, setEraserMode] = useState<BrushMode>('binary');
  const [eraserStrength, setEraserStrength] = useState(1.0);
  const [eraserCenter, setEraserCenter] = useState(1.0);
  const [eraserEdge, setEraserEdge] = useState(0.0);
  const [eraserGamma, setEraserGamma] = useState(2.0);

  const setStatusMsg = useCallback((msg: string, success = false) => {
    setStatus(msg);
    setStatusSuccess(success);
  }, []);

  // ------------------------------------------------------------------
  // Canvas fitting / display (mirrors mask_node.html fitCanvas)
  // ------------------------------------------------------------------
  const redrawDisplay = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Paint layer already contains live stroke preview (composited by livePreviewStroke)
    ctx.drawImage(paintCanvasRef.current, 0, 0);
  }, []);

  const fitCanvas = useCallback(() => {
    const base = baseCanvasRef.current;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!base || !canvas || !container) return;

    const rect = base.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      setTimeout(fitCanvas, 50);
      return;
    }

    // Save old paint data if any
    const paint = paintCanvasRef.current;
    const oldW = paint.width;
    const oldH = paint.height;
    let oldPaint: HTMLCanvasElement | null = null;
    if (oldW > 0 && oldH > 0) {
      oldPaint = document.createElement('canvas');
      oldPaint.width = oldW;
      oldPaint.height = oldH;
      oldPaint.getContext('2d')?.drawImage(paint, 0, 0);
    }

    // Set new display canvas size
    canvas.style.left = (rect.left - containerRect.left) + 'px';
    canvas.style.top = (rect.top - containerRect.top) + 'px';
    canvas.width = rect.width;
    canvas.height = rect.height;

    // Sync offscreen canvases
    paint.width = rect.width;
    paint.height = rect.height;
    const sc = strokeCanvasRef.current;
    sc.width = rect.width;
    sc.height = rect.height;

    // Restore old paint data scaled to new size
    if (oldPaint && oldPaint.width > 0) {
      paint.getContext('2d')?.drawImage(oldPaint, 0, 0, paint.width, paint.height);
    }
    redrawDisplay();
  }, [redrawDisplay]);

  // ------------------------------------------------------------------
  // Image loading
  // The base image is rendered on a <canvas> (not <img>) so that browser
  // extensions hooking images (e.g. Eagle's Alt+Right-click quick save)
  // never intercept mouse events on it.
  // ------------------------------------------------------------------
  const initialDrawRef = useRef<string | null>(null);

  // Restore paint layer (and optional initial draw) after base is rendered
  const restorePaint = useCallback((initialDraw: string | null) => {
    setTimeout(() => {
      fitCanvas();
      const paint = paintCanvasRef.current;
      const pctx = paint.getContext('2d');
      if (!pctx) return;
      pctx.globalCompositeOperation = 'source-over';
      pctx.globalAlpha = 1;
      pctx.clearRect(0, 0, paint.width, paint.height);
      if (initialDraw) {
        const dimg = new Image();
        dimg.onload = () => {
          pctx.drawImage(dimg, 0, 0, paint.width, paint.height);
          redrawDisplay();
        };
        dimg.src = initialDraw;
      } else {
        redrawDisplay();
      }
      setStatusMsg('Ready');
    }, 0);
  }, [fitCanvas, redrawDisplay, setStatusMsg]);

  const loadImage = useCallback(async () => {
    try {
      const resp = await fetch('/image_data', { cache: 'no-store' });
      const data = await resp.json();
      if (!data.image) {
        setStatusMsg('No image');
        return;
      }
      initialDrawRef.current = data.initial_draw ?? null;

      // Decode offscreen (never attached to DOM — nothing for extensions to hook)
      const img = new Image();
      img.onload = () => {
        srcImgRef.current = img;
        imgSizeRef.current = { w: img.naturalWidth, h: img.naturalHeight };
        setImageBase64(data.image);
        setLoaded(true);

        // Wait for React to render the base canvas, then paint pixels into it
        const apply = () => {
          const bc = baseCanvasRef.current;
          if (!bc) {
            setTimeout(apply, 30);
            return;
          }
          bc.width = img.naturalWidth;
          bc.height = img.naturalHeight;
          const bctx = bc.getContext('2d');
          if (bctx) {
            bctx.globalCompositeOperation = 'source-over';
            bctx.globalAlpha = 1;
            bctx.clearRect(0, 0, bc.width, bc.height);
            bctx.drawImage(img, 0, 0);
          }
          restorePaint(initialDrawRef.current);
        };
        apply();
      };
      img.onerror = () => setStatusMsg('Image decode failed');
      img.src = data.image;
    } catch (e) {
      console.error('Error loading image:', e);
      setStatusMsg('Error loading image');
    }
  }, [restorePaint, setStatusMsg]);

  useEffect(() => {
    loadImage();
  }, [loadImage]);

  // Listen for parent window messages (iframe integration)
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'reload-image') {
        loadImage();
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [loadImage]);

  // Window close handler (standalone mode only)
  useEffect(() => {
    if (IS_DRAW_MODE) return;
    const onClose = () => {
      try {
        fetch('/window_closed', { method: 'POST' }).catch(() => {});
      } catch {}
    };
    window.addEventListener('beforeunload', onClose);
    return () => window.removeEventListener('beforeunload', onClose);
  }, []);

  // Resize handler
  useEffect(() => {
    const onResize = () => fitCanvas();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [fitCanvas]);

  // Swallow all default mouse behaviors so nothing leaks to the browser / parent page
  // (context menu, middle-click autoscroll, text selection, drag, back/forward gestures)
  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    const onMouseDown = (e: MouseEvent) => {
      // middle-click autoscroll
      if (e.button === 1) e.preventDefault();
    };
    // Right-click mouseup / contextmenu: block in CAPTURE phase with stopPropagation.
    // Image-collector extensions (e.g. Eagle) listen for Alt+Right-click on document
    // (bubble phase) and collect any 2d canvas via toDataURL — stopping propagation
    // here means they never see the event. Our own logic uses pointer events, unaffected.
    const stopRightClick = (e: MouseEvent) => {
      if (e.button === 2) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const stopContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('contextmenu', stopContextMenu, true);
    document.addEventListener('selectstart', prevent);
    document.addEventListener('dragstart', prevent);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', stopRightClick, true);
    return () => {
      document.removeEventListener('contextmenu', stopContextMenu, true);
      document.removeEventListener('selectstart', prevent);
      document.removeEventListener('dragstart', prevent);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', stopRightClick, true);
    };
  }, []);

  // ------------------------------------------------------------------
  // Drawing (mirrors mask_node.html stroke pattern: gradient + snapshot preview)
  // ------------------------------------------------------------------
  const syncStrokeCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    for (const c of [strokeCanvasRef.current, snapshotCanvasRef.current]) {
      if (c.width !== canvas.width || c.height !== canvas.height) {
        c.width = canvas.width;
        c.height = canvas.height;
      }
    }
  };

  // Compute the brush/eraser radial gradient for the current mode (alpha shape)
  const makeBrushGradient = (sctx: CanvasRenderingContext2D, x: number, y: number, r: number) => {
    const grad = sctx.createRadialGradient(x, y, 0, x, y, r);
    // Use eraser params when erasing, brush params when drawing
    const mode = isErasingRef.current ? eraserModeRef.current : brushModeRef.current;
    const strength = (isErasingRef.current ? eraserStrengthRef.current : brushStrengthRef.current) * opacityRef.current;
    const center = isErasingRef.current ? eraserCenterRef.current : brushCenterRef.current;
    const edge = isErasingRef.current ? eraserEdgeRef.current : brushEdgeRef.current;
    const gamma = isErasingRef.current ? eraserGammaRef.current : brushGammaRef.current;
    // RGB from current color (irrelevant for eraser — only alpha is used)
    const m = colorRef.current.match(/^#?([0-9a-f]{6})$/i);
    const rgb = m
      ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)].join(',')
      : '255,0,0';
    if (mode === 'binary') {
      grad.addColorStop(0, `rgba(${rgb}, ${strength})`);
      grad.addColorStop(1, `rgba(${rgb}, ${strength})`);
    } else if (mode === 'linear') {
      grad.addColorStop(0, `rgba(${rgb}, ${center * strength})`);
      grad.addColorStop(1, `rgba(${rgb}, ${edge * strength})`);
    } else { // exponential
      const stops = 20;
      for (let i = 0; i <= stops; i++) {
        const t = i / stops;
        const a = strength * Math.pow(1 - t, gamma);
        grad.addColorStop(t, `rgba(${rgb}, ${a})`);
      }
    }
    return grad;
  };

  const drawDot = (x: number, y: number) => {
    syncStrokeCanvas();
    const sc = strokeCanvasRef.current;
    const sctx = sc.getContext('2d');
    if (!sctx) return;
    const r = brushSizeRef.current / 2;
    sctx.globalCompositeOperation = 'source-over';
    sctx.globalAlpha = 1;
    sctx.fillStyle = makeBrushGradient(sctx, x, y, r);
    sctx.beginPath();
    sctx.arc(x, y, r, 0, Math.PI * 2);
    sctx.fill();
  };

  const drawStrokeTo = (x: number, y: number) => {
    syncStrokeCanvas();
    const sc = strokeCanvasRef.current;
    const sctx = sc.getContext('2d');
    if (!sctx) return;
    const r = brushSizeRef.current / 2;
    sctx.globalCompositeOperation = 'source-over';
    sctx.globalAlpha = 1;
    sctx.strokeStyle = makeBrushGradient(sctx, x, y, r);
    sctx.lineWidth = brushSizeRef.current;
    sctx.lineCap = 'round';
    sctx.lineJoin = 'round';
    sctx.beginPath();
    sctx.moveTo(lastPosRef.current.x, lastPosRef.current.y);
    sctx.lineTo(x, y);
    sctx.stroke();
    drawDot(x, y);
    livePreviewStroke();
  };

  // Live preview: restore snapshot into paint, composite stroke, then display
  const livePreviewStroke = () => {
    const paint = paintCanvasRef.current;
    const pctx = paint.getContext('2d');
    if (!pctx) return;
    pctx.globalCompositeOperation = 'source-over';
    pctx.globalAlpha = 1;
    pctx.clearRect(0, 0, paint.width, paint.height);
    pctx.drawImage(snapshotCanvasRef.current, 0, 0);
    // Composite stroke into paint layer
    if (isErasingRef.current) {
      pctx.globalCompositeOperation = 'destination-out';
      pctx.globalAlpha = 1;
    } else {
      pctx.globalCompositeOperation = 'source-over';
      pctx.globalAlpha = 1;
    }
    pctx.drawImage(strokeCanvasRef.current, 0, 0);
    pctx.globalAlpha = 1;
    pctx.globalCompositeOperation = 'source-over';
    redrawDisplay();
  };

  // Commit the stroke (PS-style: one stroke = one alpha layer)
  const commitStroke = () => {
    livePreviewStroke();
    const sc = strokeCanvasRef.current;
    sc.getContext('2d')?.clearRect(0, 0, sc.width, sc.height);
  };

  // ------------------------------------------------------------------
  // Eyedropper: pick color from composited image (base + paint)
  // ------------------------------------------------------------------
  const pickColor = (x: number, y: number) => {
    const base = baseCanvasRef.current;
    const canvas = canvasRef.current;
    if (!base || !canvas) return;
    const pick = document.createElement('canvas');
    pick.width = canvas.width;
    pick.height = canvas.height;
    const pc = pick.getContext('2d');
    if (!pc) return;
    pc.drawImage(base, 0, 0, pick.width, pick.height);
    pc.drawImage(paintCanvasRef.current, 0, 0);
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= pick.width || py >= pick.height) return;
    const pixel = pc.getImageData(px, py, 1, 1).data;
    const hex = '#' + [pixel[0], pixel[1], pixel[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    setColor(hex);
    colorRef.current = hex;
    setTool('brush');
    toolRef.current = 'brush';
    setStatusMsg('Picked ' + hex);
  };

  // ------------------------------------------------------------------
  // Send composited drawing to server
  // ------------------------------------------------------------------
  const sendDraw = useCallback(async (confirm: boolean) => {
    const base = baseCanvasRef.current;
    const size = imgSizeRef.current;
    if (!base || !size || size.w <= 0) return;

    // Full-resolution composite: base + paint layer
    const full = document.createElement('canvas');
    full.width = size.w;
    full.height = size.h;
    const fctx = full.getContext('2d');
    if (!fctx) return;
    fctx.drawImage(base, 0, 0, full.width, full.height);
    fctx.drawImage(paintCanvasRef.current, 0, 0, full.width, full.height);

    const dataUrl = full.toDataURL('image/png');
    try {
      const resp = await fetch('/draw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, confirm }),
      });
      if (resp.ok) {
        if (confirm) {
          setStatusMsg('Draw confirmed', true);
        } else {
          setStatusMsg('Draw synced', true);
        }
        // Notify parent window (iframe integration)
        if (window.parent !== window) {
          window.parent.postMessage({ type: 'draw-confirmed' }, '*');
        }
      } else {
        setStatusMsg('Error sending draw');
      }
    } catch (e) {
      console.error('Error sending draw:', e);
      setStatusMsg('Error sending draw');
    }
  }, [setStatusMsg]);

  // Live-sync in draw mode (no confirm button there)
  const maybeLiveSync = useCallback(async () => {
    if (IS_DRAW_MODE) {
      await sendDraw(false);
    }
  }, [sendDraw]);

  const confirmDraw = useCallback(() => {
    sendDraw(true);
  }, [sendDraw]);

  // Clear all painting
  const clearAll = async () => {
    const paint = paintCanvasRef.current;
    paint.getContext('2d')?.clearRect(0, 0, paint.width, paint.height);
    strokeCanvasRef.current.getContext('2d')?.clearRect(0, 0, paintCanvasRef.current.width, paintCanvasRef.current.height);
    redrawDisplay();
    try {
      await fetch('/clear', { method: 'POST' });
      setStatusMsg('Cleared');
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'draw-confirmed' }, '*');
      }
    } catch {}
  };

  // ------------------------------------------------------------------
  // Pointer events (left = paint / pick, right = erase, Alt+Drag = resize)
  // ------------------------------------------------------------------
  const getCanvasPos = (e: React.PointerEvent | PointerEvent): { x: number; y: number } => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current!;
    canvas.setPointerCapture(e.pointerId);

    // PS-style Alt+Right-Drag: resize brush
    if (e.altKey && e.button === 2) {
      isAltResizingRef.current = true;
      altAnchorRef.current = {
        x: e.clientX,
        y: e.clientY,
        size: brushSizeRef.current,
        cx: e.clientX,
        cy: e.clientY,
      };
      return;
    }

    // Alt+Left-Drag: continuous eyedropper
    if (e.altKey && e.button === 0) {
      isAltPickingRef.current = true;
      const pos = getCanvasPos(e);
      pickColor(pos.x, pos.y);
      return;
    }

    if (e.button === 0) {
      const pos = getCanvasPos(e);
      if (toolRef.current === 'eyedropper') {
        pickColor(pos.x, pos.y);
        return;
      }
      beginStroke(pos, toolRef.current === 'eraser');
    } else if (e.button === 2) {
      const pos = getCanvasPos(e);
      beginStroke(pos, true);
    }
    updateCursorMode();
  };

  // Start a stroke: snapshot paint layer, then draw the first dot with live preview
  const beginStroke = (pos: { x: number; y: number }, erasing: boolean) => {
    syncStrokeCanvas();
    isErasingRef.current = erasing;
    isDrawingRef.current = true;
    lastPosRef.current = pos;
    // Snapshot pre-stroke paint state (for live preview restore)
    const snapCtx = snapshotCanvasRef.current.getContext('2d');
    if (snapCtx) {
      snapCtx.globalCompositeOperation = 'source-over';
      snapCtx.globalAlpha = 1;
      snapCtx.clearRect(0, 0, snapshotCanvasRef.current.width, snapshotCanvasRef.current.height);
      snapCtx.drawImage(paintCanvasRef.current, 0, 0);
    }
    strokeCanvasRef.current.getContext('2d')?.clearRect(0, 0, strokeCanvasRef.current.width, strokeCanvasRef.current.height);
    drawDot(pos.x, pos.y);
    livePreviewStroke();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    // Move brush cursor
    moveCursor(e.clientX, e.clientY);
    if (isAltResizingRef.current) {
      const dx = e.clientX - altAnchorRef.current.x;
      const newSize = Math.max(2, Math.round(altAnchorRef.current.size + dx * 0.5));
      brushSizeRef.current = newSize;
      setBrushSize(newSize);
      updateCursorSize();
      // Keep cursor at the anchored center
      if (cursorRef.current) {
        cursorRef.current.style.left = altAnchorRef.current.cx + 'px';
        cursorRef.current.style.top = altAnchorRef.current.cy + 'px';
      }
      return;
    }
    // Alt+Left-Drag: keep picking color under cursor
    if (isAltPickingRef.current) {
      if (!e.altKey || (e.buttons & 1) === 0) {
        isAltPickingRef.current = false;
        return;
      }
      const pos = getCanvasPos(e);
      pickColor(pos.x, pos.y);
      return;
    }
    if (!isDrawingRef.current) return;
    const pos = getCanvasPos(e);
    drawStrokeTo(pos.x, pos.y);
    lastPosRef.current = pos;
  };

  const onPointerUp = () => {
    if (isDrawingRef.current) {
      commitStroke();
      maybeLiveSync();
    }
    isDrawingRef.current = false;
    isAltResizingRef.current = false;
    isAltPickingRef.current = false;
  };

  const onPointerEnter = () => {
    if (cursorRef.current) cursorRef.current.style.display = 'block';
  };
  const onPointerLeave = () => {
    if (cursorRef.current) cursorRef.current.style.display = 'none';
    if (!isAltResizingRef.current) isDrawingRef.current = false;
  };

  // Wheel: resize brush
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 2 : -2;
      const newSize = Math.max(2, brushSizeRef.current + delta);
      brushSizeRef.current = newSize;
      setBrushSize(newSize);
      updateCursorSize();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [loaded]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'b' || e.key === 'B') { setTool('brush'); toolRef.current = 'brush'; }
      if (e.key === 'e' || e.key === 'E') { setTool('eraser'); toolRef.current = 'eraser'; }
      if (e.key === 'i' || e.key === 'I') { setTool('eyedropper'); toolRef.current = 'eyedropper'; }
      if (e.key === '[') {
        const newSize = Math.max(2, brushSizeRef.current - 2);
        brushSizeRef.current = newSize;
        setBrushSize(newSize);
        updateCursorSize();
      }
      if (e.key === ']') {
        const newSize = Math.min(999, brushSizeRef.current + 2);
        brushSizeRef.current = newSize;
        setBrushSize(newSize);
        updateCursorSize();
      }
      if (e.key === 'Enter' && !IS_DRAW_MODE) {
        confirmDraw();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmDraw]);

  // ------------------------------------------------------------------
  // Brush cursor helpers
  // ------------------------------------------------------------------
  const updateCursorSize = () => {
    if (cursorRef.current) {
      cursorRef.current.style.width = brushSizeRef.current + 'px';
      cursorRef.current.style.height = brushSizeRef.current + 'px';
    }
  };
  const updateCursorMode = () => {
    const el = cursorRef.current;
    if (!el) return;
    if (isErasingRef.current) {
      el.classList.remove('draw');
      el.classList.add('erase');
    } else {
      el.classList.remove('erase');
      el.classList.add('draw');
    }
  };
  const moveCursor = (x: number, y: number) => {
    if (cursorRef.current) {
      cursorRef.current.style.left = x + 'px';
      cursorRef.current.style.top = y + 'px';
    }
  };

  useEffect(() => {
    updateCursorSize();
    updateCursorMode();
  }, []);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  if (!imageBase64) {
    return <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.5)' }}>{status}</div>;
  }

  return (
    <>
      <div className="image-container" ref={containerRef}>
        {/* Base image rendered on canvas (not <img>) to avoid extension hooks like Eagle's Alt+Right-click */}
        <canvas ref={baseCanvasRef} className="base-image" />
        <canvas
          ref={canvasRef}
          className={`draw-canvas${tool === 'eyedropper' ? ' eyedropper' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          onContextMenu={(e) => e.preventDefault()}
        />
        <div ref={cursorRef} className="brush-cursor draw" />
        <div className={`status${statusSuccess ? ' success' : ''}`}>{status}</div>

        {/* Right-side panel stack */}
        <div className="right-panels">
          <div className={`brush-panel${panelCollapsed ? ' collapsed' : ''}`}>
            <div className="panel-title" onClick={() => setPanelCollapsed(c => !c)}>Brush</div>

            {/* Color wheel: angle = hue, radius = saturation, center = current color */}
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <ColorWheel
                color={color}
                onChange={(hex) => { setColor(hex); colorRef.current = hex; if (toolRef.current !== 'brush') { setTool('brush'); toolRef.current = 'brush'; } }}
              />
            </div>

            {/* Brush type buttons */}
            <div className="tool-row">
              {([
                { mode: 'binary' as BrushMode, label: 'Binary' },
                { mode: 'linear' as BrushMode, label: 'Linear' },
                { mode: 'exponential' as BrushMode, label: 'Expo' },
              ]).map(m => (
                <button
                  key={m.mode}
                  className={`tool-btn${brushMode === m.mode ? ' active' : ''}`}
                  onClick={() => { setBrushMode(m.mode); brushModeRef.current = m.mode; }}
                >{m.label}</button>
              ))}
            </div>
            {/* Brush params */}
            <div className="control-row">
              <label>Strength</label>
              <input type="range" min={0} max={1} step={0.01} value={brushStrength}
                onChange={(e) => { const v = parseFloat(e.target.value); setBrushStrength(v); brushStrengthRef.current = v; }} />
              <span>{brushStrength.toFixed(2)}</span>
            </div>
            {brushMode === 'linear' && (
              <>
                <div className="control-row">
                  <label>Center</label>
                  <input type="range" min={0} max={1} step={0.01} value={brushCenter}
                    onChange={(e) => { const v = parseFloat(e.target.value); setBrushCenter(v); brushCenterRef.current = v; }} />
                  <span>{brushCenter.toFixed(2)}</span>
                </div>
                <div className="control-row">
                  <label>Edge</label>
                  <input type="range" min={0} max={1} step={0.01} value={brushEdge}
                    onChange={(e) => { const v = parseFloat(e.target.value); setBrushEdge(v); brushEdgeRef.current = v; }} />
                  <span>{brushEdge.toFixed(2)}</span>
                </div>
              </>
            )}
            {brushMode === 'exponential' && (
              <div className="control-row">
                <label>Gamma</label>
                <input type="range" min={0.1} max={10} step={0.1} value={brushGamma}
                  onChange={(e) => { const v = parseFloat(e.target.value); setBrushGamma(v); brushGammaRef.current = v; }} />
                <span>{brushGamma.toFixed(1)}</span>
              </div>
            )}

            <div className="panel-divider" />

            {/* Eraser section */}
            <div className="section-title" style={{ color: '#ff6b6b' }}>Eraser</div>
            <div className="tool-row">
              {([
                { mode: 'binary' as BrushMode, label: 'Binary' },
                { mode: 'linear' as BrushMode, label: 'Linear' },
                { mode: 'exponential' as BrushMode, label: 'Expo' },
              ]).map(m => (
                <button
                  key={m.mode}
                  className={`tool-btn${eraserMode === m.mode ? ' active' : ''}`}
                  onClick={() => { setEraserMode(m.mode); eraserModeRef.current = m.mode; }}
                >{m.label}</button>
              ))}
            </div>
            {/* Eraser params */}
            <div className="control-row">
              <label>Strength</label>
              <input type="range" min={0} max={1} step={0.01} value={eraserStrength}
                onChange={(e) => { const v = parseFloat(e.target.value); setEraserStrength(v); eraserStrengthRef.current = v; }} />
              <span>{eraserStrength.toFixed(2)}</span>
            </div>
            {eraserMode === 'linear' && (
              <>
                <div className="control-row">
                  <label>Center</label>
                  <input type="range" min={0} max={1} step={0.01} value={eraserCenter}
                    onChange={(e) => { const v = parseFloat(e.target.value); setEraserCenter(v); eraserCenterRef.current = v; }} />
                  <span>{eraserCenter.toFixed(2)}</span>
                </div>
                <div className="control-row">
                  <label>Edge</label>
                  <input type="range" min={0} max={1} step={0.01} value={eraserEdge}
                    onChange={(e) => { const v = parseFloat(e.target.value); setEraserEdge(v); eraserEdgeRef.current = v; }} />
                  <span>{eraserEdge.toFixed(2)}</span>
                </div>
              </>
            )}
            {eraserMode === 'exponential' && (
              <div className="control-row">
                <label>Gamma</label>
                <input type="range" min={0.1} max={10} step={0.1} value={eraserGamma}
                  onChange={(e) => { const v = parseFloat(e.target.value); setEraserGamma(v); eraserGammaRef.current = v; }} />
                <span>{eraserGamma.toFixed(1)}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="bottom-bar">
        {/* Size slider */}
        <div className="control-group">
          <label>Size</label>
          <input
            type="range"
            min={2}
            max={999}
            value={brushSize}
            onChange={(e) => {
              const v = parseInt(e.target.value);
              brushSizeRef.current = v;
              setBrushSize(v);
              updateCursorSize();
            }}
          />
          <span className="range-value">{brushSize}</span>
        </div>
        {/* Clear button */}
        <button className="control-button" onClick={clearAll}>Clear</button>
        <div className="bottom-divider" />
        {/* Confirm */}
        {!IS_DRAW_MODE && (
          <button className="confirm-btn" onClick={confirmDraw}>Confirm Draw</button>
        )}
      </div>
    </>
  );
};

export default App;
