import { useState } from 'react';
import type { LoraItemData } from '../types';

interface LoraProps {
  lora: LoraItemData;
  onRemove: () => void;
}

const iconX = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M18 6L6 18M6 6l12 12"/></svg>;

const iconSplit = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>;

const iconActive = <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{verticalAlign:'middle'}}><circle cx="12" cy="12" r="6"/></svg>;

export function Lora({ lora, onRemove }: LoraProps) {
  const rawTags = lora.tags || [];
  const splitTags = rawTags.flatMap(t => t.split(',').map(s => s.trim()).filter(Boolean));

  const [splitMode, setSplitMode] = useState(false);
  const [defaultActive, setDefaultActive] = useState(true);

  // Track active state separately for each mode
  const [mergeActive, setMergeActive] = useState<Set<number>>(
    () => new Set(rawTags.map((_, i) => i))
  );
  const [splitActive, setSplitActive] = useState<Set<number>>(
    () => new Set(splitTags.map((_, i) => i))
  );

  const displayTags = splitMode ? splitTags : rawTags;
  const activeTagIdx = splitMode ? splitActive : mergeActive;

  const handleToggleSplit = () => {
    setSplitMode(prevMode => {
      const nextMode = !prevMode;

      if (nextMode) {
        // merge -> split: propagate merge state to split children
        const newSplit = new Set<number>();
        let idx = 0;
        for (let i = 0; i < rawTags.length; i++) {
          const parts = rawTags[i].split(',').map(s => s.trim()).filter(Boolean);
          if (mergeActive.has(i)) {
            for (let j = 0; j < parts.length; j++) {
              newSplit.add(idx + j);
            }
          }
          idx += parts.length;
        }
        setSplitActive(newSplit);
      } else {
        // split -> merge: OR logic
        const newMerge = new Set<number>();
        let idx = 0;
        for (let i = 0; i < rawTags.length; i++) {
          const parts = rawTags[i].split(',').map(s => s.trim()).filter(Boolean);
          const hasActive = parts.some((_, j) => splitActive.has(idx + j));
          if (hasActive) {
            newMerge.add(i);
          }
          idx += parts.length;
        }
        setMergeActive(newMerge);
      }

      return nextMode;
    });
  };

  const handleToggleDefaultActive = () => {
    setDefaultActive(prev => {
      const next = !prev;
      if (next) {
        setMergeActive(new Set(rawTags.map((_, i) => i)));
        setSplitActive(new Set(splitTags.map((_, i) => i)));
      } else {
        setMergeActive(new Set());
        setSplitActive(new Set());
      }
      return next;
    });
  };

  const toggleTag = (idx: number) => {
    if (splitMode) {
      setSplitActive(prev => {
        const next = new Set(prev);
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
        return next;
      });
    } else {
      setMergeActive(prev => {
        const next = new Set(prev);
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
        return next;
      });
    }
  };

  return (
    <div className="lora-card">
      <div className="lora-card-header">
        <span className="lora-card-name">{lora.name}</span>
        <div className="lora-card-actions">
          <button
            className={`lora-card-toggle ${splitMode ? 'active' : ''}`}
            onClick={handleToggleSplit}
            type="button"
            title={splitMode ? 'Merge tags' : 'Split tags'}
          >
            {iconSplit}
          </button>
          <button
            className={`lora-card-default-active ${defaultActive ? 'active' : ''}`}
            onClick={handleToggleDefaultActive}
            type="button"
            title={defaultActive ? 'Default: active' : 'Default: inactive'}
          >
            {iconActive}
          </button>
          <button className="lora-card-remove" onClick={onRemove} type="button">
            {iconX}
          </button>
        </div>
      </div>
      {displayTags.length > 0 && (
        <div className="lora-card-tags">
          {displayTags.map((t, i) => (
            <button
              className={`lora-card-tag ${activeTagIdx.has(i) ? 'active' : ''}`}
              key={`${t}-${i}`}
              onClick={() => toggleTag(i)}
              type="button"
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
