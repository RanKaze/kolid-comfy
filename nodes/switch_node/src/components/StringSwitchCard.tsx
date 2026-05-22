import React from 'react';

interface Props {
  name: string;
  value: string;
  selected: boolean;
  onClick: () => void;
}

const StringSwitchCard: React.FC<Props> = ({ name, value, selected, onClick }) => {
  const display = value.length > 200 ? value.slice(0, 200) + '…' : value;
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
        <pre style={preStyle}>{display}</pre>
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
  textAlign: 'left',
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
  padding: '12px',
  flex: 1,
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'flex-start',
  minHeight: '100px',
  overflow: 'auto',
};

const preStyle: React.CSSProperties = {
  fontSize: '13px',
  color: '#e5e5e5',
  wordBreak: 'break-word',
  whiteSpace: 'pre-wrap',
  margin: 0,
  fontFamily: 'inherit',
  width: '100%',
};

export default StringSwitchCard;
