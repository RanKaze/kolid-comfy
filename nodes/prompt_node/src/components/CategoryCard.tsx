import type { CategoryData, PromptData, TagGroup, FocusPoints } from '../types';
import { PromptItem } from './PromptItem';
import { isBasePromptSelectedInTags, findTagGroupByBasePrompt, tagsToDisplayName } from '../hooks/useSelection';

const iconGrip = <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{verticalAlign:'middle'}}><circle cx="9" cy="6" r="1.8"/><circle cx="9" cy="12" r="1.8"/><circle cx="9" cy="18" r="1.8"/><circle cx="15" cy="6" r="1.8"/><circle cx="15" cy="12" r="1.8"/><circle cx="15" cy="18" r="1.8"/></svg>;
const iconGrid = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>;
const iconPencil = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>;
const iconChevronUp = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M18 15l-6-6-6 6"/></svg>;
const iconChevronDown = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M6 9l6 6 6-6"/></svg>;
const iconPlus = <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M12 5v14M5 12h14"/></svg>;

interface CategoryCardProps {
  category: string;
  catData: CategoryData;
  displayMode: string;
  sizeMode: string;
  expanded: boolean;
  animating: boolean;
  selectedTags: TagGroup[];
  searchQuery: string;
  focusPoints: FocusPoints;
  isTemporary: boolean;
  matchFn?: (p: PromptData, cat: string) => boolean;
  onToggle: () => void;
  onSelectPrompt: (prompt: string) => void;
  onDragStartCategory: (e: React.DragEvent) => void;
  onDragStartPrompt: (e: React.DragEvent, category: string, id: string) => void;
  onDrop: (e: React.DragEvent) => void;
  onCategoryEndDrop: (e: React.DragEvent) => void;
}

export function CategoryCard({
  category, catData, displayMode, sizeMode, expanded, animating,
  selectedTags, searchQuery, focusPoints,
  isTemporary, matchFn,
  onToggle, onSelectPrompt,
  onDragStartCategory, onDragStartPrompt,
  onDrop, onCategoryEndDrop,
}: CategoryCardProps) {
  const isMiniMode = sizeMode === 'mini';
  const modeClass = isMiniMode ? 'mini-mode' : 'normal-mode';
  const bgImage = catData.bg_image || '';
  const prompts: PromptData[] = (catData.prompts as PromptData[]) || [];
  const catTags: string[] = (catData.tags as string[]) || [];

  let filteredPrompts = prompts;
  if (isTemporary && matchFn) {
    filteredPrompts = prompts.filter(p => matchFn(p, category));
  } else if (searchQuery) {
    filteredPrompts = prompts.filter(p => {
      const tagsMatch = Array.isArray(p.tags)
        ? p.tags.some((t: string) => t.toLowerCase().includes(searchQuery))
        : (p.tags || '').toLowerCase().includes(searchQuery);
      return p.name.toLowerCase().includes(searchQuery) ||
        p.prompt.toLowerCase().includes(searchQuery) || tagsMatch;
    });
  }

  if ((searchQuery || isTemporary) && filteredPrompts.length === 0) return null;

  const selectedCount = isTemporary
    ? filteredPrompts.length
    : prompts.filter(p => isBasePromptSelectedInTags(p.prompt, selectedTags)).length;

  return (
    <div
      className={`category ${expanded ? 'expanded' : 'collapsed'}`}
      onDragOver={e => {
        const type = (e.nativeEvent as DragEvent).dataTransfer?.types.includes('text/plain') ? '' : '';
        if (document.querySelector('.prompt-item.dragging')) e.preventDefault();
      }}
      onDrop={onDrop}
    >
      {expanded && bgImage ? (
        <div className="category-background-mask">
          <div className="category-background" style={{ backgroundImage: `url(/images/${bgImage})` }} />
        </div>
      ) : null}

      <div
        className="category-header"
        onClick={e => {
          const t = e.target as HTMLElement;
          if (!t.closest('.drag-handle, .display-mode-btn, .edit-category-btn')) onToggle();
        }}
      >
        {!expanded && bgImage ? <img src={`/images/${bgImage}`} className="bg-image" alt="" /> : null}
        <div className="header-content">
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span className="drag-handle" data-drag-type="category" data-category={category} draggable onDragStart={onDragStartCategory}>{iconGrip}</span>
            <span style={{ textShadow: '0px 0px 4px black' }}>{category}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {selectedCount > 0 && <span className="count-badge">{selectedCount}</span>}
            <button className="display-mode-btn" onClick={e => { e.stopPropagation(); }}>{iconGrid}</button>
            <button className="edit-category-btn" onClick={e => { e.stopPropagation(); }}>{iconPencil}</button>
            <span className="toggle">{expanded ? iconChevronUp : iconChevronDown}</span>
          </div>
        </div>
      </div>

      {expanded ? (
        <div className={`category-content ${animating ? 'animating' : ''} ${displayMode === 'box' ? 'box-mode' : ''} ${isMiniMode ? 'mini-mode' : ''}`}
          onDrop={onCategoryEndDrop}
          onDragOver={e => { if (document.querySelector('.prompt-item.dragging')) e.preventDefault(); }}
        >
          {filteredPrompts.map(p => {
            let isSelected = isTemporary ? false : isBasePromptSelectedInTags(p.prompt, selectedTags);
            let selectedCardsHtml = '';
            if (!isTemporary) {
              const group = findTagGroupByBasePrompt(p.prompt, selectedTags);
              if (group) {
                const display = tagsToDisplayName(group);
                selectedCardsHtml = `<div class="selected-card"><div class="selected-card-content">${display}</div></div>`;
              }
            }

            const fp = focusPoints[p.id];
            const focusStyle: React.CSSProperties = fp ? { objectPosition: `${fp.x}% ${fp.y}%` } : {};

            return (
              <PromptItem
                key={p.id}
                prompt={p}
                category={category}
                modeClass={modeClass}
                isMiniMode={isMiniMode}
                isSelected={isSelected}
                focusStyle={focusStyle}
                decoTagsHtml={''}
                selectedCardsHtml={selectedCardsHtml}
                onClick={() => onSelectPrompt(p.prompt)}
                onDragStart={(e) => onDragStartPrompt(e, category, p.id)}
                isDraggable
              />
            );
          })}
          {!searchQuery && !isTemporary ? (
            <div className={`prompt-item add-prompt-btn ${modeClass}`} data-category={category} style={{ cursor: 'pointer' }}>
              <div>{iconPlus}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
