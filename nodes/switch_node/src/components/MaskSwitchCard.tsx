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
        borderColor: selected ? 'rgba(52, 199, 89, 0.7)' : 'rgba(255,255,255,0.12)',
        boxShadow: selected
          ? '0 0 0 3px rgba(52, 199, 89, 0.35), 0 12px 40px rgba(0,0,0,0.5)'
          : '0 4px 16px rgba(0,0,0,0.3)',
        transform: selected ? 'scale(1.02)' : 'scale(1)',
      }}
      onClick={onClick}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = selected ? 'scale(1.02)' : 'scale(1.04)';
        (e.currentTarget as HTMLButtonElement).style.boxShadow = selected
          ? '0 0 0 3px rgba(52, 199, 89, 0.35), 0 16px 48px rgba(0,0,0,0.6)'
          : '0 8px 32px rgba(0,0,0,0.5)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = selected ? 'scale(1.02)' : 'scale(1)';
        (e.currentTarget as HTMLButtonElement).style.boxShadow = selected
          ? '0 0 0 3px rgba(52, 199, 89, 0.35), 0 12px 40px rgba(0,0,0,0.5)'
          : '0 4px 16px rgba(0,0,0,0.3)';
      }}
    >
      <img src={src} alt={name} style={bgImgStyle} />
      <div style={glassOverlayStyle}>
        <span style={titleStyle}>{name}</span>
        <span style={badgeStyle}>Mask</span>
      </div>
    </button>
  );
};

const cardStyle: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  background: '#000',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: '20px',
  padding: 0,
  cursor: 'pointer',
  transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
  overflow: 'hidden',
  color: '#f5f5f5',
  width: '100%',
  height: '280px',
};

const bgImgStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  transition: 'transform 0.4s cubic-bezier(0.25, 0.8, 0.25, 1)',
};

const glassOverlayStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 0,
  left: 0,
  right: 0,
  padding: '18px 16px',
  background: 'linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.35) 60%, rgba(0,0,0,0) 100%)',
  backdropFilter: 'blur(10px) saturate(120%)',
  WebkitBackdropFilter: 'blur(10px) saturate(120%)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '10px',
  minHeight: '80px',
};

const titleStyle: React.CSSProperties = {
  fontSize: '15px',
  fontWeight: 600,
  color: '#fff',
  textShadow: '0 1px 4px rgba(0,0,0,0.6)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  flex: 1,
};

const badgeStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 700,
  textTransform: 'uppercase',
  padding: '3px 8px',
  borderRadius: '6px',
  background: 'rgba(52, 199, 89, 0.2)',
  color: '#34c759',
  border: '1px solid rgba(52, 199, 89, 0.3)',
  flexShrink: 0,
  textShadow: 'none',
};

export default MaskSwitchCard;
