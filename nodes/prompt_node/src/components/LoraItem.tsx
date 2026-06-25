import type { LoraItemData } from '../types';

interface LoraItemProps {
  item: LoraItemData;
  isSelected?: boolean;
  isFiltered?: boolean;
  onToggle?: () => void;
}

export function LoraItem({ item, isSelected, isFiltered, onToggle }: LoraItemProps) {
  const previewSrc = item.preview_url
    ? `/lora_images/${encodeURIComponent(item.preview_url)}`
    : '';

  const isVideo = previewSrc ? /\.(mp4|webm|mov|avi|mkv)$/i.test(previewSrc) : false;

  const tags = item.tags || [];

  return (
    <div className={`lora-item${isSelected ? ' selected' : ''}${isFiltered ? ' filtered' : ''}`} onMouseDown={onToggle}>
      <div className="lora-image-layer">
        {previewSrc ? (
          isVideo ? (
            <video src={previewSrc} muted loop autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <img src={previewSrc} alt={item.name} loading="lazy" />
          )
        ) : (
          <div className="lora-no-image">No Image</div>
        )}
      </div>
      {tags.length > 0 && (
        <div className="lora-tag-list">
          {tags.map(t => <span className="lora-tag-chip" key={t}>{t}</span>)}
        </div>
      )}
      <div className="lora-text-layer">
        <div className="lora-name">{item.name}</div>
      </div>
    </div>
  );
}
