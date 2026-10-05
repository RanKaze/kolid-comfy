import React, { useState, useCallback } from 'react';

interface Props {
  selected: boolean;
  onClick: () => void;
  onDropFile?: (file: File) => void;
}

const CustomImageCard: React.FC<Props> = ({ selected, onClick, onDropFile }) => {
  const [dragging, setDragging] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file && file.type.startsWith('image/')) {
        onDropFile?.(file);
      }
    },
    [onDropFile]
  );

  const isActive = dragging || selected;

  return (
    <button
      style={{
        ...cardStyle,
        borderColor: isActive ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.12)',
        boxShadow: isActive
          ? '0 0 0 3px rgba(255,255,255,0.2), 0 12px 40px rgba(0,0,0,0.5)'
          : '0 4px 16px rgba(0,0,0,0.25)',
        transform: isActive ? 'scale(1.02)' : 'scale(1)',
        background: dragging
          ? 'rgba(255, 255, 255, 0.15)'
          : 'rgba(255, 255, 255, 0.07)',
      }}
      onClick={onClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onMouseEnter={(e) => {
        if (!dragging) {
          (e.currentTarget as HTMLButtonElement).style.transform = selected ? 'scale(1.02)' : 'scale(1.04)';
          (e.currentTarget as HTMLButtonElement).style.boxShadow = selected
            ? '0 0 0 3px rgba(255,255,255,0.2), 0 16px 48px rgba(0,0,0,0.6)'
            : '0 8px 32px rgba(0,0,0,0.4)';
        }
      }}
      onMouseLeave={(e) => {
        if (!dragging) {
          (e.currentTarget as HTMLButtonElement).style.transform = selected ? 'scale(1.02)' : 'scale(1)';
          (e.currentTarget as HTMLButtonElement).style.boxShadow = selected
            ? '0 0 0 3px rgba(255,255,255,0.2), 0 12px 40px rgba(0,0,0,0.5)'
            : '0 4px 16px rgba(0,0,0,0.25)';
        }
      }}
    >
      <div style={headerStyle}>Custom</div>
      <div style={bodyStyle}>
        <div style={iconStyle}>{dragging ? '↓' : '+'}</div>
        <div style={hintStyle}>
          {dragging ? 'Drop image here' : 'Click or drop an image'}
        </div>
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
  width: '100%',
  height: '280px',
};

const headerStyle: React.CSSProperties = {
  padding: '14px 18px',
  fontSize: '15px',
  fontWeight: 600,
  color: '#e5e5e5',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  background: 'rgba(255,255,255,0.03)',
};

const bodyStyle: React.CSSProperties = {
  padding: '28px 18px',
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '160px',
  gap: '12px',
};

const iconStyle: React.CSSProperties = {
  fontSize: '42px',
  fontWeight: 300,
  opacity: 0.7,
  color: '#fff',
  transition: 'transform 0.2s ease',
};

const hintStyle: React.CSSProperties = {
  fontSize: '14px',
  fontWeight: 500,
  color: '#8e8e93',
  transition: 'color 0.2s ease',
};

export default CustomImageCard;
