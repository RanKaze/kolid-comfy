import React, { useCallback } from 'react';
import type { Box } from '../types';
import IOSToggle from './IOSToggle';

const iosFont = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', Roboto, sans-serif`;
const PALETTE_COLORS = ['#ff453a', '#0a84ff', '#ffd60a', '#bf5af2', '#ff9f0a', '#30d158', '#64d2ff', '#ff375f'];

function estimateTokens(boxes: Box[], background: string, highLevelDescription: string): number {
  let chars = (background || '').length + (highLevelDescription || '').length;
  for (const b of boxes) {
    chars += (b.desc || '').length + (b.text || '').length + (b.palette || []).join('').length;
  }
  return Math.ceil(chars / 4);
}

const iosInput: React.CSSProperties = {
  background: '#1c1c1e',
  border: '1px solid #38383a',
  borderRadius: 10,
  color: '#fff',
  fontSize: 14,
  padding: '7px 12px',
  outline: 'none',
  fontFamily: iosFont,
};

const iosTextBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  borderRadius: 8,
  color: '#0a84ff',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
  padding: '4px 8px',
  whiteSpace: 'nowrap',
  fontFamily: iosFont,
};

const iosPillBtn: React.CSSProperties = {
  background: '#2c2c2e',
  border: 'none',
  borderRadius: 999,
  color: '#fff',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
  padding: '6px 16px',
  whiteSpace: 'nowrap',
  fontFamily: iosFont,
};

// ── Top: style palette + caption fields (scrolls with parent) ──

interface ToolbarTopProps {
  stylePalette: string[];
  background: string;
  highLevelDescription: string;
  aesthetics: string;
  lighting: string;
  medium: string;
  onBackgroundChange: (v: string) => void;
  onHighLevelDescriptionChange: (v: string) => void;
  onAestheticsChange: (v: string) => void;
  onLightingChange: (v: string) => void;
  onMediumChange: (v: string) => void;
  onStylePaletteChange: (palette: string[]) => void;
}

export const ToolbarTop: React.FC<ToolbarTopProps> = ({
  stylePalette, background, highLevelDescription, aesthetics, lighting, medium,
  onBackgroundChange, onHighLevelDescriptionChange, onAestheticsChange, onLightingChange, onMediumChange,
  onStylePaletteChange,
}) => {
  const addStyleColor = useCallback(() => {
    onStylePaletteChange([...stylePalette, PALETTE_COLORS[stylePalette.length % PALETTE_COLORS.length]]);
  }, [stylePalette, onStylePaletteChange]);

  const setStyleColorAt = useCallback((i: number, color: string) => {
    const next = [...stylePalette]; next[i] = color; onStylePaletteChange(next);
  }, [stylePalette, onStylePaletteChange]);

  const removeStyleColorAt = useCallback((i: number) => {
    onStylePaletteChange(stylePalette.filter((_, idx) => idx !== i));
  }, [stylePalette, onStylePaletteChange]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 16px',
      fontFamily: iosFont,
    }}>
      {/* Style palette row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        background: '#1c1c1e', borderRadius: 10, padding: '6px 10px',
      }}>
        <span style={{ fontSize: 12, color: '#8e8e93', flexShrink: 0 }}>Style palette</span>
        {stylePalette.map((color, i) => (
          <div key={i} style={{ position: 'relative' }}>
            <input type="color" value={color}
              onChange={(e) => setStyleColorAt(i, e.target.value)}
              style={{
                width: 24, height: 24, border: '2px solid rgba(255,255,255,0.15)',
                borderRadius: '50%', cursor: 'pointer', padding: 0, background: 'none',
                WebkitAppearance: 'none',
              }} />
            <button onClick={() => removeStyleColorAt(i)} style={{
              position: 'absolute', top: -3, right: -3,
              background: '#ff453a', border: '2px solid #1c1c1e', borderRadius: '50%',
              width: 14, height: 14, fontSize: 8, lineHeight: '10px',
              color: '#fff', cursor: 'pointer', padding: 0, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
            }}>×</button>
          </div>
        ))}
        <button onClick={addStyleColor} style={{
          ...iosPillBtn, fontSize: 15, padding: '3px 10px',
          background: 'transparent', color: '#0a84ff',
          border: '1px solid rgba(10,132,255,0.3)',
        }}>+</button>
      </div>

      {/* Caption fields */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <input type="text" placeholder="Background…" value={background}
          onChange={(e) => onBackgroundChange(e.target.value)}
          style={{ ...iosInput, width: '100%' }} />
      </div>
      <input type="text" placeholder="High-level description…" value={highLevelDescription}
        onChange={(e) => onHighLevelDescriptionChange(e.target.value)}
        style={{ ...iosInput, width: '100%' }} />
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <input type="text" placeholder="Aesthetics…" value={aesthetics}
          onChange={(e) => onAestheticsChange(e.target.value)}
          style={{ ...iosInput, flex: '1 1 80px' }} />
        <input type="text" placeholder="Lighting…" value={lighting}
          onChange={(e) => onLightingChange(e.target.value)}
          style={{ ...iosInput, flex: '1 1 80px' }} />
        <input type="text" placeholder="Medium…" value={medium}
          onChange={(e) => onMediumChange(e.target.value)}
          style={{ ...iosInput, flex: '1 1 80px' }} />
      </div>
    </div>
  );
};

// ── Bottom: fixed control bar (tokens, sliders, toggles, actions, confirm) ──

interface ToolbarBottomProps {
  boxes: Box[];
  bgBrightness: number;
  showBoxText: boolean;
  textStroke: boolean;
  boxOpacity: number;
  background: string;
  highLevelDescription: string;
  onBgBrightnessChange: (v: number) => void;
  onShowBoxTextChange: (v: boolean) => void;
  onTextStrokeChange: (v: boolean) => void;
  onBoxOpacityChange: (v: number) => void;
  onCopy: () => void;
  onPaste: () => void;
  onClear: () => void;
  onConfirm: () => void;
  confirming: boolean;
}

export const ToolbarBottom: React.FC<ToolbarBottomProps> = ({
  boxes, bgBrightness, showBoxText, textStroke, boxOpacity,
  background, highLevelDescription,
  onBgBrightnessChange, onShowBoxTextChange, onTextStrokeChange, onBoxOpacityChange,
  onCopy, onPaste, onClear, onConfirm, confirming,
}) => {
  const tokenCount = estimateTokens(boxes, background, highLevelDescription);
  const tokenColor = tokenCount < 256 ? '#8e8e93' : tokenCount < 2048 ? '#30d158' : '#ff453a';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      padding: '10px 14px',
      borderTop: '0.5px solid #38383a',
      background: 'rgba(44,44,46,0.85)',
      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      flexShrink: 0,
      fontFamily: iosFont,
      gap: '8px',
    }}>
      <style>{`
        .kolid-range {
          -webkit-appearance: none;
          appearance: none;
          height: 4px;
          border-radius: 2px;
          background: #48484a;
          outline: none;
          width: 56px;
        }
        .kolid-range::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: #fff;
          box-shadow: 0 1px 2px rgba(0,0,0,0.3);
          cursor: pointer;
        }
        .kolid-range::-moz-range-thumb {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: #fff;
          border: none;
          box-shadow: 0 1px 2px rgba(0,0,0,0.3);
          cursor: pointer;
        }
        .kolid-range::-moz-range-track {
          height: 4px;
          border-radius: 2px;
          background: #48484a;
        }
      `}</style>

      {/* Row 1: tokens + BG/Fill sliders */}
      <div style={{ display: 'flex', flex: '0 0 auto', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontSize: 12, color: tokenColor, fontWeight: 500, whiteSpace: 'nowrap' }} title="Token estimate (~chars/4)">
          ~{tokenCount} tokens
        </span>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '12px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <span style={{ fontSize: 11, color: '#8e8e93' }}>BG</span>
            <input type="range" className="kolid-range" min="0" max="100" step="1" value={bgBrightness}
              onChange={(e) => onBgBrightnessChange(parseInt(e.target.value))} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <span style={{ fontSize: 11, color: '#8e8e93' }}>Fill</span>
            <input type="range" className="kolid-range" min="0" max="100" step="1" value={boxOpacity}
              onChange={(e) => onBoxOpacityChange(parseInt(e.target.value))} />
          </label>
        </div>
      </div>

      {/* Row 2: toggles */}
      <div style={{ display: 'flex', flex: '0 0 auto', alignItems: 'center', gap: '12px' }}>
        <IOSToggle checked={showBoxText} onChange={onShowBoxTextChange} label="Text" />
        <IOSToggle checked={textStroke} onChange={onTextStrokeChange} label="Outline" />
      </div>

      {/* Row 3: Copy / Paste / Clear */}
      <div style={{ display: 'flex', flex: '0 0 auto', alignItems: 'center', gap: '6px' }}>
        <button onClick={onCopy} style={iosTextBtn}>Copy</button>
        <button onClick={onPaste} style={iosTextBtn}>Paste</button>
        <button onClick={onClear} style={{ ...iosTextBtn, color: '#ff453a' }}>Clear</button>
      </div>

      {/* Row 4: Confirm full width */}
      <button
        onClick={onConfirm}
        disabled={confirming}
        style={{
          ...iosPillBtn,
          background: confirming ? '#1c1c1e' : '#0a84ff',
          color: confirming ? '#30d158' : '#fff',
          fontWeight: 600,
          width: '100%',
          padding: '10px 0',
          fontSize: 15,
          opacity: confirming ? 0.6 : 1,
        }}
      >
        {confirming ? '✓ Sent' : 'Confirm'}
      </button>
    </div>
  );
};

export default ToolbarTop;
