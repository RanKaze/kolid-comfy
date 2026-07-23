import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ImageInfo } from './Panel';

export interface ImageConfigDef {
  name: string;
  type: string; // Float | Int | Boolean | String
  default: any;
  min?: number;
  max?: number;
  step?: number;
}

interface ThumbnailListProps {
  images: ImageInfo[];
  onRemove: (id: string) => void;
  enableImageConfig: boolean;
  imageConfigDefs?: ImageConfigDef[];
  onImageInfoChange: (id: string, name: string, value: any) => void;
}

// Vertical slider bar for Float/Int values
export const SliderBar: React.FC<{
  name: string;
  value: number;
  min: number;
  max: number;
  step: number;
  isInt: boolean;
  onChange: (value: number) => void;
}> = ({ name, value, min, max, step, isInt, onChange }) => {
  const barRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const valueToPercent = (v: number) => {
    const range = max - min;
    if (range <= 0) return 0;
    return Math.max(0, Math.min(1, (v - min) / range));
  };
  const percentToValue = (p: number) => {
    const range = max - min;
    let val = min + p * range;
    if (isInt) {
      val = Math.round(val);
    } else {
      val = Math.round(val / step) * step;
    }
    return Math.max(min, Math.min(max, val));
  };

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    isDragging.current = true;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return;
    const p = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
    onChange(percentToValue(p));
  }, [onChange, min, max, step, isInt]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return;
    const p = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
    onChange(percentToValue(p));
  }, [onChange, min, max, step, isInt]);

  const handlePointerUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -step : step;
    onChange(Math.max(min, Math.min(max, value + delta)));
  }, [value, min, max, step, onChange]);

  const overlayHeight = `${(1 - valueToPercent(value)) * 100}%`;
  const displayValue = isInt ? value.toString() : value.toFixed(step < 0.1 ? 2 : 1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: 28 }}>
      <div
        ref={barRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onWheel={handleWheel}
        style={{
          position: 'relative', width: 24, height: 260, borderRadius: 4,
          overflow: 'hidden', background: '#e0e0e0', cursor: 'ns-resize',
          userSelect: 'none', flexShrink: 0, touchAction: 'none',
        }}
        title={`${name}: ${displayValue} (${min}-${max})`}
      >
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: overlayHeight, background: 'rgba(0,0,0,0.75)', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', left: 0, right: 0, top: overlayHeight, height: 2, background: '#fff', pointerEvents: 'none', boxShadow: '0 0 2px rgba(0,0,0,0.5)' }} />
        <div style={{ position: 'absolute', bottom: 4, left: 0, right: 0, textAlign: 'center', fontSize: 12, color: '#333', pointerEvents: 'none', fontWeight: 600 }}>{displayValue}</div>
      </div>
      <div style={{ fontSize: 10, color: '#666', textAlign: 'center', maxWidth: 28, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={name}>{name}</div>
    </div>
  );
};

// Checkbox for Boolean values
export const BooleanControl: React.FC<{ name: string; value: boolean; onChange: (value: boolean) => void }> = ({ name, value, onChange }) => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, width: 36 }}>
    <input
      type="checkbox"
      checked={!!value}
      onChange={(e) => onChange(e.target.checked)}
      style={{ width: 20, height: 20, cursor: 'pointer', marginTop: 120 }}
      title={`${name}: ${value}`}
    />
    <div style={{ fontSize: 10, color: '#666', textAlign: 'center', maxWidth: 36, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={name}>{name}</div>
  </div>
);

// Text input for String values
export const StringControl: React.FC<{ name: string; value: string; onChange: (value: string) => void }> = ({ name, value, onChange }) => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, width: 60 }}>
    <input
      type="text"
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: 56, marginTop: 120, fontSize: 12, textAlign: 'center',
        border: '1px solid #ccc', borderRadius: 4, padding: '2px 4px',
      }}
      title={name}
    />
    <div style={{ fontSize: 10, color: '#666', textAlign: 'center', maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={name}>{name}</div>
  </div>
);

const ThumbnailItem: React.FC<{
  img: ImageInfo;
  onRemove: (id: string) => void;
  enableImageConfig: boolean;
  imageConfigDefs?: ImageConfigDef[];
  onImageInfoChange: (id: string, name: string, value: any) => void;
}> = ({ img, onRemove, enableImageConfig, imageConfigDefs = [], onImageInfoChange }) => {
  const THUMB_HEIGHT = 280;
  const [aspectRatio, setAspectRatio] = useState<number>(1);

  useEffect(() => {
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth && image.naturalHeight) {
        setAspectRatio(image.naturalWidth / image.naturalHeight);
      }
    };
    image.src = img.dataUrl;
    return () => { image.src = ''; };
  }, [img.dataUrl]);

  const thumbWidth = Math.round(THUMB_HEIGHT * aspectRatio);

  return (
    <div
      style={{
        position: 'relative', display: 'flex', flexDirection: 'row', gap: 6,
        alignItems: 'stretch', padding: 6, borderRadius: 8, background: '#f9f9f9',
        border: '1px solid #eee', flexShrink: 0, height: THUMB_HEIGHT + 12,
      }}
    >
      <div style={{ position: 'relative', width: thumbWidth, height: THUMB_HEIGHT, borderRadius: 6, overflow: 'hidden', background: '#eee', flexShrink: 0 }}>
        <img src={img.dataUrl} alt={img.name} style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }} draggable={false} />
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onRemove(img.id); }}
          style={{
            position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: '50%',
            border: 'none', background: 'rgba(0,0,0,0.5)', color: '#fff', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, lineHeight: 1, padding: 0, zIndex: 10,
          }}
          title="Remove"
        >×</button>
      </div>

      {enableImageConfig && imageConfigDefs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'row', gap: 4, alignItems: 'flex-start', paddingTop: 2 }}>
          {imageConfigDefs.map((def) => {
            const val = img.image_infos?.[def.name] ?? def.default;
            if (def.type === 'Float' || def.type === 'Int') {
              return (
                <SliderBar
                  key={def.name} name={def.name} value={val}
                  min={def.min ?? 0} max={def.max ?? 1} step={def.step ?? 0.01}
                  isInt={def.type === 'Int'}
                  onChange={(value) => onImageInfoChange(img.id, def.name, value)}
                />
              );
            }
            if (def.type === 'Boolean') {
              return <BooleanControl key={def.name} name={def.name} value={val} onChange={(value) => onImageInfoChange(img.id, def.name, value)} />;
            }
            return <StringControl key={def.name} name={def.name} value={val} onChange={(value) => onImageInfoChange(img.id, def.name, value)} />;
          })}
        </div>
      )}
    </div>
  );
};

const ThumbnailList: React.FC<ThumbnailListProps> = ({ images, onRemove, enableImageConfig, imageConfigDefs = [], onImageInfoChange }) => {
  if (images.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
      {images.map((img) => (
        <ThumbnailItem key={img.id} img={img} onRemove={onRemove} enableImageConfig={enableImageConfig} imageConfigDefs={imageConfigDefs} onImageInfoChange={onImageInfoChange} />
      ))}
    </div>
  );
};

export default ThumbnailList;
