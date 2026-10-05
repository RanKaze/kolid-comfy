import React from 'react';

interface Props {
  name: string;
  nodeName: string;
  selected: boolean;
  onClick: () => void;
}

const ConnectionSwitchCard: React.FC<Props> = ({ name, nodeName, selected, onClick }) => {
  return (
    <button
      style={{
        ...cardStyle,
        borderColor: selected ? 'rgba(0, 122, 255, 0.6)' : 'rgba(255,255,255,0.12)',
        boxShadow: selected
          ? '0 0 0 3px rgba(0, 122, 255, 0.3), 0 8px 32px rgba(0,0,0,0.4)'
          : '0 4px 16px rgba(0,0,0,0.25)',
        transform: selected ? 'scale(1.02)' : 'scale(1)',
      }}
      onClick={onClick}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = selected ? 'scale(1.02)' : 'scale(1.04)';
        (e.currentTarget as HTMLButtonElement).style.boxShadow = selected
          ? '0 0 0 3px rgba(0, 122, 255, 0.3), 0 12px 40px rgba(0,0,0,0.5)'
          : '0 8px 32px rgba(0,0,0,0.4)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = selected ? 'scale(1.02)' : 'scale(1)';
        (e.currentTarget as HTMLButtonElement).style.boxShadow = selected
          ? '0 0 0 3px rgba(0, 122, 255, 0.3), 0 8px 32px rgba(0,0,0,0.4)'
          : '0 4px 16px rgba(0,0,0,0.25)';
      }}
    >
      <div style={headerStyle}>{name}</div>
      <div style={bodyStyle}>
        <div style={iconStyle}>🔌</div>
        <div style={nodeNameStyle}>{nodeName || 'Unknown Node'}</div>
      </div>
    </button>
  );
};

const cardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  background: 'rgba(255, 255, 255, 0.07)',
  backdropFilter: 'blur(20px) saturate(150%)',
  WebkitBackdropFilter: 'blur(20px) saturate(150%)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: '20px',
  padding: 0,
  cursor: 'pointer',
  transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
  overflow: 'hidden',
  color: '#f5f5f5',
};

const headerStyle: React.CSSProperties = {
  padding: '14px 18px',
  fontSize: '15px',
  fontWeight: 600,
  color: '#e5e5e5',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  background: 'rgba(255,255,255,0.03)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const bodyStyle: React.CSSProperties = {
  padding: '28px 18px',
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '140px',
  gap: '12px',
};

const iconStyle: React.CSSProperties = {
  fontSize: '36px',
  opacity: 0.85,
  filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.3))',
};

const nodeNameStyle: React.CSSProperties = {
  fontSize: '17px',
  fontWeight: 600,
  color: '#f5f5f5',
  textAlign: 'center',
  wordBreak: 'break-word',
};

export default ConnectionSwitchCard;
