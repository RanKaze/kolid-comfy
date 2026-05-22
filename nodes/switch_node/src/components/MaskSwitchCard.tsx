import React from 'react';

interface Props {
  name: string;
  src: string;
  selected: boolean;
  onClick: () => void;
}

const MaskSwitchCard: React.FC<Props> = ({ name, src, selected, onClick }) => {
  return (
    <button
      style={{
        ...cardStyle,
        borderColor: selected ? '#34c759' : '#444',
        boxShadow: selected ? '0 0 0 2px #34c759' : 'none',
      }}
      onClick={onClick}
    >
      <div style={{ ...headerStyle, color: '#34c759' }}>{name} <span style={badgeStyle}>Mask</span></div>
      <div style={bodyStyle}>
        <img src={src} alt={name} style={imgStyle} />
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
  background: '#34c75922',
  color: '#34c759',
  border: '1px solid #34c75944',
};

const bodyStyle: React.CSSProperties = {
  padding: '12px',
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '120px',
};

const imgStyle: React.CSSProperties = {
  maxWidth: '100%',
  maxHeight: '220px',
  borderRadius: '8px',
  objectFit: 'contain',
};

export default MaskSwitchCard;
