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
        borderColor: selected ? 'rgba(255, 159, 10, 0.6)' : 'rgba(255,255,255,0.12)',
        boxShadow: selected
          ? '0 0 0 3px rgba(255, 159, 10, 0.3), 0 8px 32px rgba(0,0,0,0.4)'
          : '0 4px 16px rgba(0,0,0,0.25)',
        transform: selected ? 'scale(1.02)' : 'scale(1)',
      }}
      onClick={onClick}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = selected ? 'scale(1.02)' : 'scale(1.04)';
        (e.currentTarget as HTMLButtonElement).style.boxShadow = selected
          ? '0 0 0 3px rgba(255, 159, 10, 0.3), 0 12px 40px rgba(0,0,0,0.5)'
          : '0 8px 32px rgba(0,0,0,0.4)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = selected ? 'scale(1.02)' : 'scale(1)';
        (e.currentTarget as HTMLButtonElement).style.boxShadow = selected
          ? '0 0 0 3px rgba(255, 159, 10, 0.3), 0 8px 32px rgba(0,0,0,0.4)'
          : '0 4px 16px rgba(0,0,0,0.25)';
      }}
    >
      <div style={headerStyle}>{name}</div>
      <div style={bodyStyle}>
        <div style={valueStyle}>{value}</div>
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
  padding: '24px 16px',
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '140px',
};

const valueStyle: React.CSSProperties = {
  fontSize: '38px',
  fontWeight: 700,
  color: '#ff9f0a',
  textShadow: '0 2px 10px rgba(255, 159, 10, 0.2)',
};

export default IntSwitchCard;
