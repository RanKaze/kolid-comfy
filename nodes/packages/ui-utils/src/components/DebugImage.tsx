import React, { useState, useCallback } from 'react';

export interface DebugImageProps {
  src: string;
  label?: string;
}

export const DebugImage: React.FC<DebugImageProps> = ({ src, label }) => {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  const onLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setSize({ w: img.naturalWidth, h: img.naturalHeight });
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {label && (
        <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.6)' }}>
          {label}
          {size && ` (${size.w}×${size.h})`}
        </span>
      )}
      <img
        src={src}
        alt={label || 'debug'}
        onLoad={onLoad}
        style={{
          maxWidth: '100%',
          maxHeight: 200,
          objectFit: 'contain',
          borderRadius: 6,
          border: '1px solid rgba(255,255,255,0.1)',
          background: '#1a1a1a',
        }}
      />
    </div>
  );
};
