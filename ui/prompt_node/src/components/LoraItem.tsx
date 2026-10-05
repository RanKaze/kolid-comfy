import type { LoraItemData } from '../types';

const iconEdit = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;

interface LoraItemProps {
  item: LoraItemData;
  isSelected?: boolean;
  isFiltered?: boolean;
  onToggle?: () => void;
  onEdit?: () => void;
}

export function LoraItem({ item, isSelected, isFiltered, onToggle, onEdit }: LoraItemProps) {
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
      {onEdit && (
        <button className="lora-item-edit" onMouseDown={e => { e.stopPropagation(); }} onClick={e => { e.stopPropagation(); onEdit(); }} title="Edit Lora">
          {iconEdit}
        </button>
      )}
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
