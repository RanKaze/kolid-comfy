import { useState } from 'react';
import type { LoraItemData } from '../types';
import { LoraItem } from './LoraItem';

const iconChevronUp = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M18 15l-6-6-6 6"/></svg>;
const iconChevronDown = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M6 9l6 6 6-6"/></svg>;

interface LoraFolderCardProps {
  folderName: string;
  items: LoraItemData[];
  searchQuery?: string;
  selectedLoras: LoraItemData[];
  onToggleLora: (item: LoraItemData) => void;
  isItemSelected?: (item: LoraItemData) => boolean;
  onEditLora?: (item: LoraItemData) => void;
  bgImage?: string;
  bgVideo?: string;
  videoVolume?: number;
  clarityPoints?: Array<{x:number;y:number}>;
  imgUrl: (path: string) => string;
  onEdit?: () => void;
}

export function LoraFolderCard({ folderName, items, searchQuery, selectedLoras, onToggleLora, isItemSelected, onEditLora, bgImage, bgVideo, videoVolume, clarityPoints, imgUrl, onEdit }: LoraFolderCardProps) {
  const [expanded, setExpanded] = useState(false);

  const filtered = searchQuery
    ? items.filter(it => it.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : items;

  if (searchQuery && filtered.length === 0) return null;

  const isSelected = isItemSelected || ((item: LoraItemData) => selectedLoras.some(l => l.file_path === item.file_path));

  const getBgUrl = (name: string) => name ? imgUrl(name) : '';

  return (
    <div className={`category lora-folder ${expanded ? 'expanded' : 'collapsed'}`} onMouseMove={e => { const r = e.currentTarget.getBoundingClientRect(); const mx = e.clientX - r.left; const my = e.clientY - r.top; const pts = clarityPoints || []; const circles = pts.map(p => `<circle cx="${p.x}%" cy="${p.y}%" r="60" fill="black"/>`).join(''); const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="100%" height="100%" fill="white"/>${circles}<circle cx="${mx}" cy="${my}" r="70" fill="black"/></svg>`; const blurEl = e.currentTarget.querySelector<HTMLDivElement>('.category-background-blur'); if (blurEl) { const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`; blurEl.style.maskImage = url; blurEl.style.webkitMaskImage = url; } }}>
      {expanded && bgVideo ? (
        <div className="category-background-mask">
          <video className="category-background-video" src={getBgUrl(bgVideo)} muted={!((videoVolume ?? 0) > 0)} loop autoPlay playsInline ref={el => { if (el) el.volume = videoVolume ?? 0; }} />
        </div>
      ) : expanded && bgImage ? (
        <div className="category-background-mask">
          <div className="category-background" style={{ backgroundImage: `url(${getBgUrl(bgImage)})` }} />
        </div>
      ) : null}
      {expanded && (bgVideo || bgImage) ? (
        <div className="category-background-blur" style={(() => { if (!clarityPoints || clarityPoints.length === 0) return undefined; const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="100%" height="100%" fill="white"/>${clarityPoints.map(p => `<circle cx="${p.x}%" cy="${p.y}%" r="60" fill="black"/>`).join('')}</svg>`; const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`; return { maskImage: url, WebkitMaskImage: url }; })()} />
      ) : null}
      <div
        className="category-header"
        onClick={() => setExpanded(prev => !prev)}
      >
        {!expanded && bgVideo ? <video className="bg-video" src={getBgUrl(bgVideo)} muted loop autoPlay playsInline /> : !expanded && bgImage ? <img src={getBgUrl(bgImage)} className="bg-image" alt="" /> : null}
        <div className="header-content">
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span style={{ textShadow: '0px 0px 4px black' }}>{folderName}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {(() => {
              const selectedCount = items.filter(isSelected).length;
              return selectedCount > 0 ? <span className="count-badge">{selectedCount}</span> : null;
            })()}
            {onEdit ? <button className="edit-category-btn" onClick={e => { e.stopPropagation(); onEdit(); }} style={{ zIndex: 2 }} title="Edit folder">⚙</button> : null}
            <span className="toggle">{expanded ? iconChevronUp : iconChevronDown}</span>
          </div>
        </div>
      </div>
      {expanded ? (
        <div className="category-content lora-content">
          {filtered.map(item => (
            <LoraItem
              key={item.file_path}
              item={item}
              isSelected={isSelected(item)}
              onToggle={() => onToggleLora(item)}
              onEdit={onEditLora ? () => onEditLora(item) : undefined}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
