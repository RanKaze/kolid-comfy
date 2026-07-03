import React, { useCallback } from 'react';
import type { Box } from '../types';

interface RegionPanelProps {
  box: Box | null;
  index: number;
  onChange: (box: Box) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}

const PALETTE_COLORS = ['#ff453a', '#0a84ff', '#ffd60a', '#bf5af2', '#ff9f0a', '#30d158', '#64d2ff', '#ff375f'];

const RegionPanel: React.FC<RegionPanelProps> = ({ box, index, onChange, onDelete, onDuplicate }) => {
  const update = useCallback((patch: Partial<Box>) => {
    if (box) onChange({ ...box, ...patch });
  }, [box, onChange]);

  const addColor = useCallback(() => {
    if (!box) return;
    const next = [...(box.palette || []), PALETTE_COLORS[(box.palette || []).length % PALETTE_COLORS.length]];
    update({ palette: next });
  }, [box, update]);

  const setColorAt = useCallback((i: number, color: string) => {
    if (!box) return;
    const next = [...(box.palette || [])];
    next[i] = color;
    update({ palette: next });
  }, [box, update]);

  const removeColorAt = useCallback((i: number) => {
    if (!box) return;
    const next = (box.palette || []).filter((_, idx) => idx !== i);
    update({ palette: next });
  }, [box, update]);

  if (!box) {
    return (
      <div style={{ padding: '20px 16px', color: '#48484a', fontSize: 14, textAlign: 'center', fontFamily: iosFont }}>
        No region selected.<br />Drag on the canvas to draw a region.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 16px', overflowY: 'auto', minHeight: 0, fontFamily: iosFont }}>
      {/* Type segmented control + actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{
          display: 'flex',
          background: '#1c1c1e',
          borderRadius: 9,
          padding: 2,
          flexShrink: 0,
        }}>
          {(['obj', 'text'] as const).map((t) => (
            <button
              key={t}
              onClick={() => update({ type: t })}
              style={{
                border: 'none',
                padding: '5px 14px',
                borderRadius: 7,
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                fontFamily: iosFont,
                background: box.type === t ? '#0a84ff' : 'transparent',
                color: box.type === t ? '#fff' : '#8e8e93',
              }}
            >
              {t === 'obj' ? 'Object' : 'Text'}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 15, fontWeight: 600, color: '#fff', flex: 1 }}>
          Region {String(index + 1).padStart(2, '0')}
        </span>
        <button onClick={onDuplicate} title="Duplicate" style={iconBtnStyle}>⧉</button>
        <button onClick={onDelete} title="Delete" style={{ ...iconBtnStyle, color: '#ff453a' }}>✕</button>
      </div>

      {/* Text input */}
      {box.type === 'text' && (
        <input
          type="text"
          placeholder="Text content…"
          value={box.text}
          onChange={(e) => update({ text: e.target.value })}
          style={iosInput}
        />
      )}

      {/* Description */}
      <textarea
        placeholder="Description…"
        value={box.desc}
        onChange={(e) => update({ desc: e.target.value })}
        rows={3}
        style={{ ...iosInput, resize: 'vertical', minHeight: 44, fontFamily: iosFont, fontSize: 14, lineHeight: 1.4 }}
      />

      {/* Color palette */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        background: '#1c1c1e', borderRadius: 10, padding: '8px 10px',
      }}>
        <span style={{ fontSize: 13, color: '#8e8e93', flexShrink: 0 }}>Colors</span>
        {(box.palette || []).map((color, i) => (
          <div key={i} style={{ position: 'relative' }}>
            <input
              type="color"
              value={color}
              onChange={(e) => setColorAt(i, e.target.value)}
              style={{
                width: 28, height: 28, border: '2px solid rgba(255,255,255,0.15)',
                borderRadius: '50%', cursor: 'pointer', padding: 0, background: 'none',
                WebkitAppearance: 'none',
              }}
            />
            <button
              onClick={() => removeColorAt(i)}
              style={{
                position: 'absolute', top: -4, right: -4,
                background: '#ff453a', border: '2px solid #000', borderRadius: '50%',
                width: 16, height: 16, fontSize: 9, lineHeight: '12px',
                color: '#fff', cursor: 'pointer', padding: 0, display: 'flex',
                alignItems: 'center', justifyContent: 'center',
              }}
            >×</button>
          </div>
        ))}
        <button onClick={addColor} style={{
          ...iosPillBtn,
          fontSize: 16, padding: '4px 12px',
          background: 'transparent', color: '#0a84ff', border: '1px solid rgba(10,132,255,0.3)',
        }}>+</button>
      </div>
    </div>
  );
};

const iosFont = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', Roboto, sans-serif`;

const iconBtnStyle: React.CSSProperties = {
  background: '#2c2c2e',
  border: 'none',
  borderRadius: 8,
  color: '#8e8e93',
  cursor: 'pointer',
  fontSize: 14,
  padding: '6px 10px',
  whiteSpace: 'nowrap',
  fontFamily: iosFont,
};

const iosInput: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: '#1c1c1e',
  border: '1px solid #38383a',
  borderRadius: 10,
  color: '#fff',
  fontSize: 14,
  padding: '8px 12px',
  outline: 'none',
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
  padding: '5px 14px',
  whiteSpace: 'nowrap',
  fontFamily: iosFont,
};

export default RegionPanel;
