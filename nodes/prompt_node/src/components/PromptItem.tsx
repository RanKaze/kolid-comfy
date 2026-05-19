import type { PromptData } from '../types';

const iconGrip = <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{verticalAlign:'middle'}}><circle cx="9" cy="6" r="1.8"/><circle cx="9" cy="12" r="1.8"/><circle cx="9" cy="18" r="1.8"/><circle cx="15" cy="6" r="1.8"/><circle cx="15" cy="12" r="1.8"/><circle cx="15" cy="18" r="1.8"/></svg>;
const iconPencil = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>;
const iconTrash = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>;

interface PromptItemProps {
  prompt: PromptData;
  category: string;
  modeClass: string;
  isMiniMode: boolean;
  isSelected: boolean;
  focusStyle: React.CSSProperties;
  decoTagsHtml: string;
  selectedCardsHtml: string;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  isDraggable: boolean;
}

export function PromptItem({
  prompt, category, modeClass, isMiniMode, isSelected,
  focusStyle, decoTagsHtml, selectedCardsHtml,
  onClick, onDragStart, isDraggable,
}: PromptItemProps) {
  return (
    <div className="prompt-item-wrapper">
      <div
        className={`prompt-item ${modeClass}${isSelected ? ' selected' : ''}`}
        data-prompt={prompt.prompt}
        data-id={prompt.id}
        data-category={category}
      >
        {isDraggable && (
          <span
            className="drag-handle"
            data-drag-type="prompt"
            data-id={prompt.id}
            data-category={category}
            draggable
            onDragStart={onDragStart}
            onClick={e => e.stopPropagation()}
          >{iconGrip}</span>
        )}
        <div dangerouslySetInnerHTML={{ __html: decoTagsHtml }} />
        <div className="select-area" onClick={onClick}>
          <div className="image-layer">
            {prompt.preview
              ? <img src={`/images/${prompt.preview}`} alt={prompt.name} loading="lazy" style={focusStyle} />
              : <div className="no-image">No Image</div>}
          </div>
          {!isMiniMode && <div className="glass-layer" />}
          <div className="text-layer">
            <div className="name">{prompt.name}</div>
            <div className="prompt-text">{prompt.prompt}</div>
          </div>
        </div>
        <div className="actions">
          <button className="action-btn edit" onClick={e => e.stopPropagation()}>{iconPencil}</button>
          <button className="action-btn delete" onClick={e => e.stopPropagation()}>{iconTrash}</button>
        </div>
        <div dangerouslySetInnerHTML={{ __html: selectedCardsHtml }} />
      </div>
    </div>
  );
}
