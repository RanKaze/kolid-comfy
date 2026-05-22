import React from 'react';

interface Props {
  selected: boolean;
  onClick: () => void;
}

const CustomImageCard: React.FC<Props> = ({ selected, onClick }) => {
  return (
    <button
      style={{
        ...cardStyle,
        borderColor: selected ? '#007aff' : '#444',
        boxShadow: selected ? '0 0 0 2px #007aff' : 'none',
      }}
      onClick={onClick}
    >
      <div style={headerStyle}>Custom</div>
      <div style={bodyStyle}>
        <div style={iconStyle}>+</div>
        <div style={hintStyle}>Click to select an image</div>
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
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '120px',
  gap: '8px',
};

const iconStyle: React.CSSProperties = {
  fontSize: '32px',
  opacity: 0.6,
};

const hintStyle: React.CSSProperties = {
  fontSize: '12px',
  color: '#888',
};

export default CustomImageCard;
