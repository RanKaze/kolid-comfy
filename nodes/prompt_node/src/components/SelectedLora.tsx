import type { LoraItemData } from '../types';

interface SelectedLoraProps {
  lora: LoraItemData;
  onRemove: () => void;
}

const iconX = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M18 6L6 18M6 6l12 12"/></svg>;

export function SelectedLora({ lora, onRemove }: SelectedLoraProps) {
  const tags = lora.tags || [];
  return (
    <div className="selected-lora">
      <div className="selected-lora-header">
        <span className="selected-lora-name">{lora.name}</span>
        <button className="selected-lora-remove" onClick={onRemove} type="button">
          {iconX}
        </button>
      </div>
      {tags.length > 0 && (
        <div className="selected-lora-tags">
          {tags.map(t => <span className="selected-lora-tag" key={t}>{t}</span>)}
        </div>
      )}
    </div>
  );
}
