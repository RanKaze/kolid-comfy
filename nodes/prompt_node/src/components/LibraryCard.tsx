import type { LibraryData, PromptData, TagGroup, FocusPoints, CategoryData } from '../types';
import { PromptItem } from './PromptItem';
import { isBasePromptSelectedInTags, findTagGroupByBasePrompt, tagsToDisplayName } from '../hooks/useSelection';

const iconGrip = <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{verticalAlign:'middle'}}><circle cx="9" cy="6" r="1.8"/><circle cx="9" cy="12" r="1.8"/><circle cx="9" cy="18" r="1.8"/><circle cx="15" cy="6" r="1.8"/><circle cx="15" cy="12" r="1.8"/><circle cx="15" cy="18" r="1.8"/></svg>;
const iconGrid = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>;
const iconPencil = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>;
const iconTrash = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>;
const iconChevronUp = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M18 15l-6-6-6 6"/></svg>;
const iconChevronDown = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M6 9l6 6 6-6"/></svg>;
const iconPlus = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M12 5v14M5 12h14"/></svg>;

interface LibraryCardProps {
  libName: string;
  libData: LibraryData;
  displayMode: string;
  sizeMode: string;
  expanded: boolean;
  animating: boolean;
  selectedTags: TagGroup[];
  searchQuery: string;
  focusPoints: FocusPoints;
  allPrompts: Record<string, CategoryData>;
  onToggle: () => void;
  onSelectPrompt: (prompt: string) => void;
  onDragStartLibrary: (e: React.DragEvent) => void;
  onDragStartPrompt: (e: React.DragEvent, category: string, id: string) => void;
  onDragStartPrefab: (e: React.DragEvent, libName: string, idx: number) => void;
  onDrop: (e: React.DragEvent) => void;
  onPromptDrop: (e: React.DragEvent, targetCategory: string, targetId: string) => void;
  onLibraryEndDrop: (e: React.DragEvent) => void;
}

export function LibraryCard({
  libName, libData, displayMode, sizeMode, expanded, animating,
  selectedTags, searchQuery, focusPoints, allPrompts,
  onToggle, onSelectPrompt,
  onDragStartLibrary, onDragStartPrompt, onDragStartPrefab,
  onDrop, onPromptDrop, onLibraryEndDrop,
}: LibraryCardProps) {
  const isMiniMode = sizeMode === 'mini';
  const modeClass = isMiniMode ? 'mini-mode' : 'normal-mode';
  const bgImage = libData.bg_image || '';
  const libPromptIds: string[] = libData.prompt_ids || [];
  const prefabs = libData.prefabs || [];

  const prompts: (PromptData & { category: string })[] = [];
  for (const [cat, catData] of Object.entries(allPrompts)) {
    const catPrompts: PromptData[] = (catData as { prompts?: PromptData[] }).prompts || [];
    for (const p of catPrompts) {
      if (libPromptIds.includes(p.id)) {
        prompts.push({ ...p, category: cat });
      }
    }
  }

  if (searchQuery && prompts.length === 0 && prefabs.length === 0) return null;

  return (
    <div
      className={`category ${expanded ? 'expanded' : 'collapsed'}`}
      onDragOver={e => {
        if (document.querySelector('.prompt-item.dragging, .category.dragging')) e.preventDefault();
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
            <span className="drag-handle" data-drag-type="library" data-library={libName} draggable onDragStart={onDragStartLibrary}>{iconGrip}</span>
            <span style={{ textShadow: '0px 0px 4px black' }}>{libName}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <button className="display-mode-btn" onClick={e => { e.stopPropagation(); }}>{iconGrid}</button>
            <button className="edit-category-btn" onClick={e => { e.stopPropagation(); }}>{iconPencil}</button>
            <span className="toggle">{expanded ? iconChevronUp : iconChevronDown}</span>
          </div>
        </div>
      </div>

      {expanded ? (
        <div className={`category-content ${animating ? 'animating' : ''} ${displayMode === 'box' ? 'box-mode' : ''} ${isMiniMode ? 'mini-mode' : ''}`}
          onDrop={onLibraryEndDrop}
          onDragOver={e => {
            if (document.querySelector('.prompt-item.dragging')) e.preventDefault();
            const prefabDragging = document.querySelector('.prompt-item.dragging[data-prefab]');
            if (prefabDragging) e.preventDefault();
          }}
        >
          {prompts.map(p => {
            const isSelected = isBasePromptSelectedInTags(p.prompt, selectedTags);
            let selectedCardsHtml = '';
            const group = findTagGroupByBasePrompt(p.prompt, selectedTags);
            if (group) {
              const display = tagsToDisplayName(group);
              selectedCardsHtml = `<div class="selected-card"><div class="selected-card-content">${display}</div></div>`;
            }
            const fp = focusPoints[p.id];
            const focusStyle: React.CSSProperties = fp ? { objectPosition: `${fp.x}% ${fp.y}%` } : {};
            return (
              <PromptItem
                key={p.id}
                prompt={p}
                category={p.category}
                modeClass={modeClass}
                isMiniMode={isMiniMode}
                isSelected={isSelected}
                focusStyle={focusStyle}
                decoTagsHtml=""
                selectedCardsHtml={selectedCardsHtml}
                onClick={() => onSelectPrompt(p.prompt)}
                onDragStart={(e) => onDragStartPrompt(e, p.category, p.id)}
                isDraggable
              />
            );
          })}
          {prefabs.map((pf, i) => (
            <div className="prompt-item-wrapper" key={`prefab_${libName}_${i}`}>
              <div
                className={`prompt-item ${modeClass} ${getPrefabMatchClass(pf.tags, selectedTags)}`}
                data-prefab={`prefab_${libName}_${i}`}
                data-library={libName}
                data-prefab-index={i}
              >
                <span
                  className="drag-handle"
                  data-drag-type="prefab"
                  data-library={libName}
                  data-index={i}
                  draggable
                  onDragStart={(e) => onDragStartPrefab(e, libName, i)}
                  onClick={e => e.stopPropagation()}
                >{iconGrip}</span>
                <div className="select-area" style={{ width: '100%', height: '100%', position: 'relative' }}>
                  <div className="image-layer">
                    {pf.preview ? <img src={`/images/${pf.preview}`} alt={pf.name} loading="lazy" /> : <div className="no-image">No Image</div>}
                  </div>
                  {!isMiniMode && <div className="glass-layer" />}
                  <div className="text-layer">
                    <div className="name" style={{ color: 'var(--accent-color)' }}>{pf.name}</div>
                    <div className="prompt-text">{pf.tags.map(g => tagsToDisplayName(g)).join(' + ')}</div>
                  </div>
                </div>
                <div className="actions" style={{ position: 'absolute', top: 4, right: 4 }}>
                  <button className="action-btn edit" onClick={e => e.stopPropagation()}>{iconPencil}</button>
                  <button className="action-btn delete" onClick={e => e.stopPropagation()}>{iconTrash}</button>
                </div>
              </div>
            </div>
          ))}
          {selectedTags.length > 0 ? (
            <div className={`prompt-item add-prompt-btn ${modeClass}`} data-library={libName} style={{ cursor: 'pointer' }}>
              <div style={{ fontSize: 12 }}>{iconPlus} Add Prefab</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function getPrefabMatchClass(prefabTags: TagGroup[], selectedTags: TagGroup[]): string {
  if (prefabTags.length === 0 || selectedTags.length === 0) return '';
  let matchCount = 0;
  for (const pfGroup of prefabTags) {
    const pfDisplay = tagsToDisplayName(pfGroup);
    for (const selGroup of selectedTags) {
      if (tagsToDisplayName(selGroup) === pfDisplay) { matchCount++; break; }
    }
  }
  if (matchCount === prefabTags.length) return 'prefab-full';
  if (matchCount > 0) return 'prefab-partial';
  return '';
}
