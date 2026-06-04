import React, { useCallback, useRef } from 'react';
import { ImageInfo } from './Panel';

interface ThumbnailListProps {
  images: ImageInfo[];
  onRemove: (id: string) => void;
  enableStrength: boolean;
  onStrengthChange: (id: string, strength: number) => void;
}

const ThumbnailItem: React.FC<{
  img: ImageInfo;
  onRemove: (id: string) => void;
  enableStrength: boolean;
  onStrengthChange: (id: string, strength: number) => void;
}> = ({ img, onRemove, enableStrength, onStrengthChange }) => {
  const itemRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const strength = img.strength ?? 1.0;

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enableStrength) return;
      // Only handle pointer events on the container itself, not on the remove button
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      e.preventDefault();
      isDragging.current = true;
      (e.currentTarget as Element).setPointerCapture(e.pointerId);

      const rect = itemRef.current?.getBoundingClientRect();
      if (!rect) return;
      const newStrength = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
      onStrengthChange(img.id, Math.round(newStrength * 100) / 100);
    },
    [enableStrength, img.id, onStrengthChange]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!enableStrength || !isDragging.current) return;
      const rect = itemRef.current?.getBoundingClientRect();
      if (!rect) return;
      const newStrength = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
      onStrengthChange(img.id, Math.round(newStrength * 100) / 100);
    },
    [enableStrength, img.id, onStrengthChange]
  );

  const handlePointerUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!enableStrength) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.05 : 0.05;
      const newStrength = Math.max(0, Math.min(1, strength + delta));
      onStrengthChange(img.id, Math.round(newStrength * 100) / 100);
    },
    [enableStrength, strength, img.id, onStrengthChange]
  );

  // Overlay height percentage: strength=1 -> 0% overlay, strength=0 -> 100% overlay
  const overlayHeight = `${(1 - strength) * 100}%`;

  return (
    <div
      ref={itemRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onWheel={handleWheel}
      style={{
        position: 'relative',
        width: 80,
        height: 80,
        borderRadius: 8,
        overflow: 'hidden',
        border: '1px solid #eee',
        background: '#f9f9f9',
        flexShrink: 0,
        cursor: enableStrength ? 'ns-resize' : 'default',
        userSelect: 'none',
      }}
      title={enableStrength ? `strength: ${strength.toFixed(2)}` : img.name}
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
      {enableStrength && (
        <>
          {/* Black semi-transparent overlay from top */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: overlayHeight,
              background: 'rgba(0,0,0,0.5)',
              pointerEvents: 'none',
            }}
          />
          {/* Strength value label */}
          <div
            style={{
              position: 'absolute',
              bottom: 2,
              left: 0,
              right: 0,
              textAlign: 'center',
              fontSize: 10,
              color: '#fff',
              textShadow: '0 1px 2px rgba(0,0,0,0.6)',
              pointerEvents: 'none',
              fontWeight: 600,
            }}
          >
            {strength.toFixed(2)}
          </div>
        </>
      )}
      <button
        onPointerDown={(e) => {
          e.stopPropagation();
          console.log('[ThumbnailItem] X button pointer down');
        }}
        onClick={(e) => {
          e.stopPropagation();
          console.log('[ThumbnailItem] X button clicked, removing id:', img.id);
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
  );
};

const ThumbnailList: React.FC<ThumbnailListProps> = ({
  images,
  onRemove,
  enableStrength,
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
          onStrengthChange={onStrengthChange}
        />
      ))}
    </div>
  );
};

export default ThumbnailList;
