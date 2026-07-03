import React, { useState, useEffect, useCallback, useRef } from 'react';
import Canvas from './components/Canvas';
import RegionPanel from './components/RegionPanel';
import { ToolbarTop, ToolbarBottom } from './components/Toolbar';
import type { Box, ServerConfig, ConfirmPayload } from './types';

const iosFont = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', Roboto, sans-serif`;

const App: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [imageSrc, setImageSrc] = useState('');
  const [canvasW, setCanvasW] = useState(1024);
  const [canvasH, setCanvasH] = useState(1024);

  const [boxes, setBoxes] = useState<Box[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [stylePalette, setStylePalette] = useState<string[]>([]);

  const [bgBrightness, setBgBrightness] = useState(25);
  const [showBoxText, setShowBoxText] = useState(true);
  const [textStroke, setTextStroke] = useState(true);
  const [boxOpacity, setBoxOpacity] = useState(14);

  const [background, setBackground] = useState('');
  const [highLevelDescription, setHighLevelDescription] = useState('');
  const [aesthetics, setAesthetics] = useState('');
  const [lighting, setLighting] = useState('');
  const [medium, setMedium] = useState('');

  const [confirming, setConfirming] = useState(false);
  const boxesRef = useRef(boxes);
  useEffect(() => { boxesRef.current = boxes; }, [boxes]);

  useEffect(() => {
    fetch('/config')
      .then((r) => r.json())
      .then((data: ServerConfig) => {
        setImageSrc(data.image || '');
        setCanvasW(data.width);
        setCanvasH(data.height);
        setBgBrightness(data.bg_brightness);
        setBackground(data.background || '');
        setHighLevelDescription(data.high_level_description || '');
        setAesthetics(data.aesthetics || '');
        setLighting(data.lighting || '');
        setMedium(data.medium || '');
        try {
          const sp = JSON.parse(data.style_palette || '[]');
          if (Array.isArray(sp)) setStylePalette(sp);
        } catch {}
        try {
          const ib = JSON.parse(data.initial_boxes || '[]');
          if (Array.isArray(ib)) setBoxes(ib);
        } catch {}
        setLoading(false);
      })
      .catch((e) => { setError('Failed to load: ' + e.message); setLoading(false); });
  }, []);

  useEffect(() => {
    const handler = () => {
      fetch('/window_closed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).catch(() => {});
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const handleConfirm = useCallback(async () => {
    const payload: ConfirmPayload = {
      boxes: boxesRef.current, style_palette: stylePalette,
      background, high_level_description: highLevelDescription,
      aesthetics, lighting, medium,
    };
    setConfirming(true);
    try {
      const res = await fetch('/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) { setTimeout(() => window.close(), 800); }
      else { setError('Server error'); setConfirming(false); }
    } catch (e: any) { setError('Confirm failed: ' + e.message); setConfirming(false); }
  }, [stylePalette, background, highLevelDescription, aesthetics, lighting, medium]);

  const handleCopy = useCallback(() => {
    navigator.clipboard?.writeText(JSON.stringify(boxesRef.current)).catch(() => {});
  }, []);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard?.readText();
      if (!text) return;
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const clones = parsed.map((b: Box) => ({ ...b, x: clamp01(b.x + 0.02), y: clamp01(b.y + 0.02) }));
        setBoxes((prev) => [...prev, ...clones]);
        setActiveIdx(boxesRef.current.length);
      }
    } catch {}
  }, []);

  const handleClear = useCallback(() => { setBoxes([]); setActiveIdx(-1); }, []);

  const activeBox = activeIdx >= 0 && activeIdx < boxes.length ? boxes[activeIdx] : null;

  const updateActiveBox = useCallback((box: Box) => {
    setBoxes((prev) => {
      const next = [...prev];
      if (activeIdx >= 0 && activeIdx < next.length) next[activeIdx] = box;
      return next;
    });
  }, [activeIdx]);

  const deleteActiveBox = useCallback(() => {
    setBoxes((prev) => prev.filter((_, i) => i !== activeIdx));
    setActiveIdx((prev) => Math.max(0, Math.min(prev, boxesRef.current.length - 2)));
  }, [activeIdx]);

  const duplicateActiveBox = useCallback(() => {
    if (!activeBox) return;
    const clone: Box = {
      ...activeBox, x: clamp01(activeBox.x + 0.03), y: clamp01(activeBox.y + 0.03),
      palette: [...(activeBox.palette || [])],
    };
    setBoxes((prev) => [...prev, clone]);
    setActiveIdx(boxesRef.current.length);
  }, [activeBox]);

  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh',
        background: '#000', fontFamily: iosFont,
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 28, height: 28, border: '3px solid #1c1c1e', borderTopColor: '#0a84ff', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' }} />
          <span style={{ color: '#8e8e93', fontSize: 15 }}>{error || 'Loading…'}</span>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex', height: '100vh', overflow: 'hidden',
      background: '#000', fontFamily: iosFont,
    }}>
      {/* Left: canvas */}
      <Canvas
        imageSrc={imageSrc} boxes={boxes} activeIdx={activeIdx}
        canvasWidth={canvasW} canvasHeight={canvasH}
        bgBrightness={bgBrightness} showBoxText={showBoxText}
        textStroke={textStroke} boxOpacity={boxOpacity}
        onBoxesChange={setBoxes} onActiveIdxChange={setActiveIdx}
      />

      {/* Vertical splitter */}
      <div style={{
        width: '5px', cursor: 'ew-resize', position: 'relative', flexShrink: 0,
        background: '#000',
      }}>
        <div style={{
          position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
          width: '4px', height: '36px', background: '#48484a', borderRadius: '2px',
        }} />
      </div>

      {/* Right: scrollable content + fixed bottom bar */}
      <div style={{
        width: '340px', flexShrink: 0,
        display: 'flex', flexDirection: 'column',
        background: 'rgba(28,28,30,0.72)',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        borderLeft: '0.5px solid #38383a',
      }}>
        {/* Scrollable: style palette + caption fields + region panel */}
        <div style={{ flex: '1 1 auto', overflowY: 'auto', minHeight: 0 }}>
          <ToolbarTop
            stylePalette={stylePalette}
            background={background} highLevelDescription={highLevelDescription}
            aesthetics={aesthetics} lighting={lighting} medium={medium}
            onBackgroundChange={setBackground} onHighLevelDescriptionChange={setHighLevelDescription}
            onAestheticsChange={setAesthetics} onLightingChange={setLighting}
            onMediumChange={setMedium} onStylePaletteChange={setStylePalette}
          />

          <div style={{ height: '1px', background: '#38383a', flexShrink: 0 }} />

          <RegionPanel
            box={activeBox} index={activeIdx}
            onChange={updateActiveBox} onDelete={deleteActiveBox} onDuplicate={duplicateActiveBox}
          />
        </div>

        {/* Fixed bottom control bar */}
        <ToolbarBottom
          boxes={boxes} bgBrightness={bgBrightness}
          showBoxText={showBoxText} textStroke={textStroke} boxOpacity={boxOpacity}
          background={background} highLevelDescription={highLevelDescription}
          onBgBrightnessChange={setBgBrightness} onShowBoxTextChange={setShowBoxText}
          onTextStrokeChange={setTextStroke} onBoxOpacityChange={setBoxOpacity}
          onCopy={handleCopy} onPaste={handlePaste} onClear={handleClear}
          onConfirm={handleConfirm} confirming={confirming}
        />
      </div>

      {error && (
        <div style={{
          position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(255,69,58,0.9)', color: '#fff', padding: '10px 24px',
          borderRadius: 14, fontSize: 14, fontWeight: 600, zIndex: 9999,
          backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
          fontFamily: iosFont, boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
        }}>
          {error}
        </div>
      )}
    </div>
  );
};

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export default App;
