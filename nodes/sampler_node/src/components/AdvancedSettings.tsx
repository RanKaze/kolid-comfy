import React, { useState } from 'react';
import type { DetailerParams } from '../types';

interface AdvancedSettingsProps {
  params: DetailerParams;
  onChange: (params: DetailerParams) => void;
}

const AdvancedSettings: React.FC<AdvancedSettingsProps> = ({ params, onChange }) => {
  const [expanded, setExpanded] = useState(false);

  const update = (key: keyof DetailerParams, value: string | number) => {
    onChange({ ...params, [key]: value });
  };

  return (
    <div style={styles.container}>
      <button style={styles.toggleBtn} onClick={() => setExpanded(!expanded)}>
        <span style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s', display: 'inline-block' }}>▼</span>
        Advanced Settings
      </button>
      {expanded && (
        <div style={styles.panel}>
          <div style={styles.row}>
            <label style={styles.label}>Add Noise</label>
            <select
              style={styles.select}
              value={params.add_noise}
              onChange={e => update('add_noise', e.target.value)}
            >
              <option value="enable">enable</option>
              <option value="disable">disable</option>
            </select>
          </div>
          <div style={styles.row}>
            <label style={styles.label}>Start Step Rate</label>
            <input
              style={styles.input}
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={params.start_step_rate}
              onChange={e => update('start_step_rate', parseFloat(e.target.value))}
            />
          </div>
          <div style={styles.row}>
            <label style={styles.label}>End Step Rate</label>
            <input
              style={styles.input}
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={params.end_step_rate}
              onChange={e => update('end_step_rate', parseFloat(e.target.value))}
            />
          </div>
          <div style={styles.row}>
            <label style={styles.label}>Pixels</label>
            <input
              style={styles.input}
              type="number"
              min={65536}
              max={16777216}
              step={65536}
              value={params.pixels}
              onChange={e => update('pixels', parseInt(e.target.value))}
            />
          </div>
          <div style={styles.row}>
            <label style={styles.label}>Crop Reserve</label>
            <input
              style={styles.input}
              type="number"
              min={0}
              max={256}
              step={1}
              value={params.crop_reserve}
              onChange={e => update('crop_reserve', parseInt(e.target.value))}
            />
          </div>
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
  },
  toggleBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: 'transparent',
    border: 'none',
    color: 'rgba(255,255,255,0.5)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    padding: '4px 0',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif",
    letterSpacing: '0.2px',
  },
  panel: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '10px 20px',
    padding: '10px 14px',
    background: 'rgba(28, 28, 30, 0.5)',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.06)',
    marginTop: 6,
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 200,
  },
  label: {
    fontSize: 12,
    fontWeight: 600,
    color: 'rgba(255,255,255,0.6)',
    minWidth: 90,
    letterSpacing: '0.2px',
  },
  select: {
    background: 'rgba(255,255,255,0.08)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 8,
    padding: '5px 10px',
    color: '#fff',
    fontSize: 13,
    fontWeight: 500,
    outline: 'none',
    minWidth: 100,
    cursor: 'pointer',
  },
  input: {
    background: 'rgba(255,255,255,0.08)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 8,
    padding: '5px 10px',
    color: '#fff',
    fontSize: 13,
    fontWeight: 500,
    outline: 'none',
    width: 80,
    fontVariantNumeric: 'tabular-nums',
  },
};

export default AdvancedSettings;
