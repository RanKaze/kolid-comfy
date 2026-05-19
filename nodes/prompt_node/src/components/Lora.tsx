import { useState, useEffect } from 'react';
import type { LoraItemData } from '../types';

interface LoraChangeData {
  activeTags: string[];
  strength: number;
  active: boolean;
  split_mode: boolean;
}

interface LoraProps {
  lora: LoraItemData;
  initialActiveTags?: string[];
  initialStrength?: number;
  initialActive?: boolean;
  initialSplitMode?: boolean;
  isMissing?: boolean;
  onChange: (data: LoraChangeData) => void;
  onRemove: () => void;
}

const iconX = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M18 6L6 18M6 6l12 12"/></svg>;

const iconSplit = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>;

const iconMinus = <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M5 12h14"/></svg>;

const iconPlusSmall = <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M12 5v14M5 12h14"/></svg>;

function buildActiveSetFromInitial(
  rawTags: string[],
  splitTags: string[],
  initialActiveTags?: string[]
): { mergeActive: Set<number>; splitActive: Set<number> } {
  const initSet = new Set(initialActiveTags || []);
  const mergeActive = new Set<number>();
  const splitActive = new Set<number>();

  for (let i = 0; i < splitTags.length; i++) {
    if (initSet.has(splitTags[i])) {
      splitActive.add(i);
    }
  }

  let idx = 0;
  for (let i = 0; i < rawTags.length; i++) {
    const parts = rawTags[i].split(',').map(s => s.trim()).filter(Boolean);
    const hasActive = parts.some((_, j) => initSet.has(parts[j]));
    if (hasActive) {
      mergeActive.add(i);
    }
    idx += parts.length;
  }

  if (!initialActiveTags || initialActiveTags.length === 0) {
    for (let i = 0; i < rawTags.length; i++) mergeActive.add(i);
    for (let i = 0; i < splitTags.length; i++) splitActive.add(i);
  }

  return { mergeActive, splitActive };
}

export function Lora({ lora, initialActiveTags, initialStrength, initialActive, initialSplitMode, isMissing, onChange, onRemove }: LoraProps) {
  const rawTags = lora.tags || [];
  const splitTags = rawTags.flatMap(t => t.split(',').map(s => s.trim()).filter(Boolean));

  const [cardActive, setCardActive] = useState(initialActive !== false);
  const [strength, setStrength] = useState(initialStrength ?? 1.0);
  const [inputDisplay, setInputDisplay] = useState((initialStrength ?? 1.0).toFixed(2));
  const [splitMode, setSplitMode] = useState(initialSplitMode ?? false);

  const init = buildActiveSetFromInitial(rawTags, splitTags, initialActiveTags);
  const [mergeActive, setMergeActive] = useState<Set<number>>(init.mergeActive);
  const [splitActive, setSplitActive] = useState<Set<number>>(init.splitActive);

  const displayTags = splitMode ? splitTags : rawTags;
  const activeTagIdx = splitMode ? splitActive : mergeActive;

  const buildPayload = (
    sMode: boolean,
    sActive: Set<number>,
    mActive: Set<number>,
    str: number,
    cActive: boolean
  ): LoraChangeData => {
    const activeList: string[] = [];
    if (sMode) {
      for (let i = 0; i < splitTags.length; i++) {
        if (sActive.has(i)) activeList.push(splitTags[i]);
      }
    } else {
      for (let i = 0; i < rawTags.length; i++) {
        if (mActive.has(i)) {
          const parts = rawTags[i].split(',').map(s => s.trim()).filter(Boolean);
          activeList.push(...parts);
        }
      }
    }
    return { activeTags: activeList, strength: str, active: cActive, split_mode: sMode };
  };

  // Notify parent of initial state on mount
  useEffect(() => {
    onChange(buildPayload(splitMode, splitActive, mergeActive, strength, cardActive));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const notifyParent = (
    sMode: boolean,
    sActive: Set<number>,
    mActive: Set<number>,
    str: number,
    cActive: boolean
  ) => {
    onChange(buildPayload(sMode, sActive, mActive, str, cActive));
  };

  const toggleCard = () => {
    setCardActive(prev => {
      const next = !prev;
      notifyParent(splitMode, splitActive, mergeActive, strength, next);
      return next;
    });
  };

  const handleStrengthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputDisplay(e.target.value);
  };

  const handleStrengthBlur = () => {
    const val = parseFloat(inputDisplay);
    const clamped = isNaN(val) ? 1.0 : Math.max(0, Math.min(2, val));
    const fixed = Math.round(clamped * 100) / 100;
    setStrength(fixed);
    setInputDisplay(fixed.toFixed(2));
    notifyParent(splitMode, splitActive, mergeActive, fixed, cardActive);
  };

  const adjustStrength = (delta: number) => {
    const next = Math.max(0, Math.min(2, Math.round((strength + delta) * 100) / 100));
    setStrength(next);
    setInputDisplay(next.toFixed(2));
    notifyParent(splitMode, splitActive, mergeActive, next, cardActive);
  };

  const handleToggleSplit = () => {
    setSplitMode(prevMode => {
      const nextMode = !prevMode;

      if (nextMode) {
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
        notifyParent(nextMode, newSplit, mergeActive, strength, cardActive);
      } else {
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
        notifyParent(nextMode, splitActive, newMerge, strength, cardActive);
      }

      return nextMode;
    });
  };

  const toggleTag = (idx: number) => {
    if (splitMode) {
      setSplitActive(prev => {
        const next = new Set(prev);
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
        notifyParent(splitMode, next, mergeActive, strength, cardActive);
        return next;
      });
    } else {
      setMergeActive(prev => {
        const next = new Set(prev);
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
        notifyParent(splitMode, splitActive, next, strength, cardActive);
        return next;
      });
    }
  };

  return (
    <div className={`lora-card ${cardActive ? 'active' : ''} ${isMissing ? 'missing' : ''}`} onMouseDown={toggleCard}>
      <div className="lora-card-header">
        <span className="lora-card-name">{lora.name}</span>
        <div className="lora-card-meta" onMouseDown={e => e.stopPropagation()}>
          <button className="lora-strength-btn" onClick={() => adjustStrength(-0.1)} type="button" title="Decrease strength">
            {iconMinus}
          </button>
          <input
            className="lora-strength"
            type="text"
            value={inputDisplay}
            onChange={handleStrengthChange}
            onBlur={handleStrengthBlur}
            title="Lora strength"
          />
          <button className="lora-strength-btn" onClick={() => adjustStrength(0.1)} type="button" title="Increase strength">
            {iconPlusSmall}
          </button>
          <button
            className={`lora-card-toggle ${splitMode ? 'active' : ''}`}
            onClick={handleToggleSplit}
            type="button"
            title={splitMode ? 'Merge tags' : 'Split tags'}
          >
            {iconSplit}
          </button>
          <button className="lora-card-remove" onClick={onRemove} type="button">
            {iconX}
          </button>
        </div>
      </div>
      {displayTags.length > 0 && (
        <div className="lora-card-tags" onMouseDown={e => e.stopPropagation()}>
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
