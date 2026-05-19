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
}

export function LoraFolderCard({ folderName, items, searchQuery, selectedLoras, onToggleLora }: LoraFolderCardProps) {
  const [expanded, setExpanded] = useState(false);

  const filtered = searchQuery
    ? items.filter(it => it.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : items;

  if (searchQuery && filtered.length === 0) return null;

  const isSelected = (item: LoraItemData) => selectedLoras.some(l => l.file_name === item.file_name);

  return (
    <div className={`category lora-folder ${expanded ? 'expanded' : 'collapsed'}`}>
      <div
        className="category-header"
        onClick={() => setExpanded(prev => !prev)}
      >
        <div className="header-content">
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span style={{ textShadow: '0px 0px 4px black' }}>{folderName}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span className="count-badge">{items.length}</span>
            <span className="toggle">{expanded ? iconChevronUp : iconChevronDown}</span>
          </div>
        </div>
      </div>
      {expanded ? (
        <div className="category-content lora-content">
          {filtered.map(item => (
            <LoraItem
              key={item.file_name}
              item={item}
              isSelected={isSelected(item)}
              onClick={() => onToggleLora(item)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
