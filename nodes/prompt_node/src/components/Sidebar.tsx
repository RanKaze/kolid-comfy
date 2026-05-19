import type { TagGroup } from '../types';
import { tagsToDisplayName } from '../hooks/useSelection';

const iconX = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M18 6L6 18M6 6l12 12"/></svg>;

interface SidebarProps {
  selectedTags: TagGroup[];
  customPrompts: string;
  onCustomPromptsChange: (v: string) => void;
  onRemoveTag: (index: number) => void;
}

export function Sidebar({ selectedTags, customPrompts, onCustomPromptsChange, onRemoveTag }: SidebarProps) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h3>Selected Prompts</h3>
        <span className="selected-count">{selectedTags.length}</span>
      </div>
      <div className="selected-tags">
        {selectedTags.map((group, index) => (
          <span className="tag" key={index}>
            {tagsToDisplayName(group)}
            <span className="remove" onClick={() => onRemoveTag(index)}>{iconX}</span>
          </span>
        ))}
      </div>
      <div className="custom-input-section">
        <h3>Custom Prompts</h3>
        <textarea
          placeholder="Enter custom prompts here..."
          value={customPrompts}
          onChange={e => onCustomPromptsChange(e.target.value)}
        />
      </div>
    </div>
  );
}
