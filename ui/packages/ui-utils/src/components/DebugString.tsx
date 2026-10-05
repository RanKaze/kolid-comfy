import React from 'react';

export interface DebugStringProps {
  label: string;
  value: string | number;
}

export const DebugString: React.FC<DebugStringProps> = ({ label, value }) => {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.5)', minWidth: 80 }}>
        {label}
      </span>
      <span
        style={{
          fontSize: 11,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          color: 'rgba(255,255,255,0.85)',
          background: 'rgba(255,255,255,0.05)',
          padding: '2px 8px',
          borderRadius: 4,
        }}
      >
        {String(value)}
      </span>
    </div>
  );
};
