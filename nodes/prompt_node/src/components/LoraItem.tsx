import type { LoraItemData } from '../types';

interface LoraItemProps {
  item: LoraItemData;
  isSelected?: boolean;
  onToggle?: () => void;
}

export function LoraItem({ item, isSelected, onToggle }: LoraItemProps) {
  const previewSrc = item.preview_url
    ? `/lora_images/${encodeURIComponent(item.preview_url)}`
    : '';

  const tags = item.tags || [];

  return (
    <div className={`lora-item${isSelected ? ' selected' : ''}`} onMouseDown={onToggle}>
      <div className="lora-image-layer">
        {previewSrc ? (
          <img src={previewSrc} alt={item.name} loading="lazy" />
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
