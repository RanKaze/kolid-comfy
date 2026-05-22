import React, { useState } from 'react';

interface Props {
  name: string;
  value: string;
  selected: boolean;
  onClick: () => void;
}

const JsonSwitchCard: React.FC<Props> = ({ name, value, selected, onClick }) => {
  const [expanded, setExpanded] = useState(false);
  const display = expanded || value.length < 300 ? value : value.slice(0, 300) + '…';

  return (
    <button
      style={{
        ...cardStyle,
        borderColor: selected ? '#007aff' : '#444',
        boxShadow: selected ? '0 0 0 2px #007aff' : 'none',
      }}
      onClick={onClick}
    >
      <div style={headerStyle}>{name} <span style={badgeStyle}>JSON</span></div>
      <div style={bodyStyle} onClick={(e) => e.stopPropagation()}>
        <pre style={preStyle}>{display}</pre>
        {value.length >= 300 && (
          <span
            style={toggleStyle}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            {expanded ? 'Collapse' : 'Expand'}
          </span>
        )}
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
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
};

const badgeStyle: React.CSSProperties = {
  fontSize: '10px',
  fontWeight: 700,
  textTransform: 'uppercase',
  padding: '2px 6px',
  borderRadius: '4px',
  background: '#ff950022',
  color: '#ff9500',
  border: '1px solid #ff950044',
};

const bodyStyle: React.CSSProperties = {
  padding: '12px',
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  justifyContent: 'flex-start',
  minHeight: '100px',
  overflow: 'auto',
  gap: '8px',
};

const preStyle: React.CSSProperties = {
  fontSize: '12px',
  color: '#e5e5e5',
  wordBreak: 'break-word',
  whiteSpace: 'pre-wrap',
  margin: 0,
  fontFamily: 'monospace',
  width: '100%',
};

const toggleStyle: React.CSSProperties = {
  fontSize: '12px',
  color: '#007aff',
  cursor: 'pointer',
  alignSelf: 'flex-end',
};

export default JsonSwitchCard;
