import React from 'react';

interface Props {
  name: string;
  value: string;
  selected: boolean;
  onClick: () => void;
}

const IntSwitchCard: React.FC<Props> = ({ name, value, selected, onClick }) => {
  return (
    <button
      style={{
        ...cardStyle,
        borderColor: selected ? '#007aff' : '#444',
        boxShadow: selected ? '0 0 0 2px #007aff' : 'none',
      }}
      onClick={onClick}
    >
      <div style={headerStyle}>{name}</div>
      <div style={bodyStyle}>
        <span style={intStyle}>{value}</span>
      </div>
    </button>
  );
};

const cardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  background: '#252525',
  border: '1px solid #444',
  borderRadius: '12px',
  padding: 0,
  cursor: 'pointer',
  transition: 'all 0.15s ease',
  overflow: 'hidden',
  color: '#f5f5f5',
};

const headerStyle: React.CSSProperties = {
  padding: '10px 14px',
  fontSize: '13px',
  fontWeight: 600,
  color: '#aaa',
  borderBottom: '1px solid #333',
  background: '#1f1f1f',
};

const bodyStyle: React.CSSProperties = {
  padding: '20px 12px',
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '100px',
};

const intStyle: React.CSSProperties = {
  fontSize: '32px',
  fontWeight: 700,
  color: '#007aff',
  fontFamily: 'monospace',
};

export default IntSwitchCard;
