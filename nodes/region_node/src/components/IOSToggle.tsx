import React from 'react';

interface IOSToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}

const IOSToggle: React.FC<IOSToggleProps> = ({ checked, onChange, label }) => (
  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', userSelect: 'none' }}>
    {label && <span style={{ fontSize: 13, color: '#8e8e93' }}>{label}</span>}
    <div
      onClick={() => onChange(!checked)}
      style={{
        width: 36,
        height: 22,
        borderRadius: 22,
        background: checked ? '#30d158' : '#39393d',
        position: 'relative',
        transition: 'background 0.2s ease',
        flexShrink: 0,
      }}
    >
      <div style={{
        position: 'absolute',
        top: 2,
        left: checked ? 16 : 2,
        width: 18,
        height: 18,
        borderRadius: '50%',
        background: '#fff',
        transition: 'left 0.2s ease',
        boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
      }} />
    </div>
  </label>
);

export default IOSToggle;
