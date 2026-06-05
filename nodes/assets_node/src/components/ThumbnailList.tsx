import React, { useCallback, useRef } from 'react';
import { ImageInfo } from './Panel';

interface ThumbnailListProps {
  images: ImageInfo[];
  onRemove: (id: string) => void;
  enableStrength: boolean;
  strengthDefs?: { name: string; default: number }[];
  onStrengthChange: (id: string, name: string, value: number) => void;
}

const StrengthBar: React.FC<{
  name: string;
  value: number;
  onChange: (value: number) => void;
}> = ({ name, value, onChange }) => {
  const barRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      isDragging.current = true;
      (e.currentTarget as Element).setPointerCapture(e.pointerId);

      const rect = barRef.current?.getBoundingClientRect();
      if (!rect) return;
      const newValue = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
      onChange(Math.round(newValue * 100) / 100);
    },
    [onChange]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging.current) return;
      const rect = barRef.current?.getBoundingClientRect();
      if (!rect) return;
      const newValue = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
      onChange(Math.round(newValue * 100) / 100);
    },
    [onChange]
  );

  const handlePointerUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.05 : 0.05;
      onChange(Math.max(0, Math.min(1, value + delta)));
    },
    [value, onChange]
  );

  const overlayHeight = `${(1 - value) * 100}%`;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        width: 28,
      }}
    >
      {/* Strength bar */}
      <div
        ref={barRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onWheel={handleWheel}
        style={{
          position: 'relative',
          width: 24,
          height: 60,
          borderRadius: 4,
          overflow: 'hidden',
          background: '#e0e0e0',
          cursor: 'ns-resize',
          userSelect: 'none',
          flexShrink: 0,
        }}
        title={`${name}: ${value.toFixed(2)}`}
      >
        {/* Dark overlay from top — covers the "used" portion */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: overlayHeight,
            background: 'rgba(0,0,0,0.75)',
            pointerEvents: 'none',
          }}
        />
        {/* White line at the strength boundary for clear visual separation */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: overlayHeight,
            height: 2,
            background: '#fff',
            pointerEvents: 'none',
            boxShadow: '0 0 2px rgba(0,0,0,0.5)',
          }}
        />
        {/* Value label */}
        <div
          style={{
            position: 'absolute',
            bottom: 2,
            left: 0,
            right: 0,
            textAlign: 'center',
            fontSize: 9,
            color: '#333',
            pointerEvents: 'none',
            fontWeight: 600,
          }}
        >
          {value.toFixed(2)}
        </div>
      </div>
      {/* Name label */}
      <div
        style={{
          fontSize: 8,
          color: '#666',
          textAlign: 'center',
          maxWidth: 28,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={name}
      >
        {name}
      </div>
    </div>
  );
};

const ThumbnailItem: React.FC<{
  img: ImageInfo;
  onRemove: (id: string) => void;
  enableStrength: boolean;
  strengthDefs?: { name: string; default: number }[];
  onStrengthChange: (id: string, name: string, value: number) => void;
}> = ({ img, onRemove, enableStrength, strengthDefs = [], onStrengthChange }) => {
  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'row',
        gap: 6,
        alignItems: 'flex-start',
        padding: 6,
        borderRadius: 8,
        background: '#f9f9f9',
        border: '1px solid #eee',
        flexShrink: 0,
      }}
    >
      {/* Image thumbnail */}
      <div
        style={{
          position: 'relative',
          width: 80,
          height: 80,
          borderRadius: 6,
          overflow: 'hidden',
          background: '#eee',
          flexShrink: 0,
        }}
      >
        <img
          src={img.dataUrl}
          alt={img.name}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            pointerEvents: 'none',
          }}
          draggable={false}
        />
        <button
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(img.id);
          }}
          style={{
            position: 'absolute',
            top: 2,
            right: 2,
            width: 18,
            height: 18,
            borderRadius: '50%',
            border: 'none',
            background: 'rgba(0,0,0,0.5)',
            color: '#fff',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            lineHeight: 1,
            padding: 0,
            zIndex: 10,
          }}
          title="Remove"
        >
          ×
        </button>
      </div>

      {/* Strength bars */}
      {enableStrength && strengthDefs.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            gap: 4,
            alignItems: 'flex-start',
            paddingTop: 2,
          }}
        >
          {strengthDefs.map((def) => (
            <StrengthBar
              key={def.name}
              name={def.name}
              value={img.strengths?.[def.name] ?? def.default}
              onChange={(value) => onStrengthChange(img.id, def.name, value)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const ThumbnailList: React.FC<ThumbnailListProps> = ({
  images,
  onRemove,
  enableStrength,
  strengthDefs = [],
  onStrengthChange,
}) => {
  console.log('[ThumbnailList] render with', images.length, 'images');
  if (images.length === 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        overflowX: 'auto',
        paddingBottom: 4,
      }}
    >
      {images.map((img) => (
        <ThumbnailItem
          key={img.id}
          img={img}
          onRemove={onRemove}
          enableStrength={enableStrength}
          strengthDefs={strengthDefs}
          onStrengthChange={onStrengthChange}
        />
      ))}
    </div>
  );
};

export default ThumbnailList;
