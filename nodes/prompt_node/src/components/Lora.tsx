import { useState, useEffect, useMemo } from 'react';
import type { LoraItemData, LoraSliderConfig } from '../types';

interface LoraChangeData {
  activeTags: string[];
  strength: number;
  active: boolean;
  split_mode: boolean;
  slider_config?: LoraSliderConfig;
}

interface LoraProps {
  lora: LoraItemData;
  initialActiveTags?: string[];
  initialStrength?: number;
  initialActive?: boolean;
  initialSplitMode?: boolean;
  sliderConfig?: LoraSliderConfig;
  isMissing?: boolean;
  isFiltered?: boolean;
  isProgramFiltered?: boolean;
  onChange: (data: LoraChangeData) => void;
  onRemove: () => void;
  hideRemove?: boolean;
}

const iconX = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M18 6L6 18M6 6l12 12"/></svg>;

const iconSplit = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>;

const iconMinus = <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M5 12h14"/></svg>;

const iconPlusSmall = <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M12 5v14M5 12h14"/></svg>;

function buildActiveSetFromInitial(
  rawTags: string[],
  splitTags: string[],
  initialActiveTags?: string[],
  initialSplitMode?: boolean
): { mergeActive: Set<number>; splitActive: Set<number> } {
  const initSet = new Set(initialActiveTags || []);
  const mergeActive = new Set<number>();
  const splitActive = new Set<number>();

  if (initialActiveTags === undefined) {
    for (let i = 0; i < rawTags.length; i++) mergeActive.add(i);
    for (let i = 0; i < splitTags.length; i++) splitActive.add(i);
    return { mergeActive, splitActive };
  }

  for (let i = 0; i < splitTags.length; i++) {
    if (initSet.has(splitTags[i])) {
      splitActive.add(i);
    }
  }

  // For merge mode: match rawTags directly (exact match) to avoid ambiguity
  // when multiple rawTags share common split parts
  let hasRawTagMatch = false;
  for (let i = 0; i < rawTags.length; i++) {
    if (initSet.has(rawTags[i])) {
      mergeActive.add(i);
      hasRawTagMatch = true;
    }
  }

  // Fallback: if no rawTags matched but we have initialActiveTags,
  // the data may be in old splitTags format (backward compatibility)
  if (!hasRawTagMatch && initialActiveTags.length > 0) {
    for (let i = 0; i < rawTags.length; i++) {
      const parts = rawTags[i].split(',').map(s => s.trim()).filter(Boolean);
      const hasActive = parts.some(p => initSet.has(p));
      if (hasActive) {
        mergeActive.add(i);
      }
    }
  }

  return { mergeActive, splitActive };
}

export function Lora({ lora, initialActiveTags, initialStrength, initialActive, initialSplitMode, sliderConfig, isMissing, isFiltered, isProgramFiltered, onChange, onRemove, hideRemove }: LoraProps) {
  const rawTags = lora.tags || [];
  const splitTags = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const t of rawTags.flatMap(t => t.split(',').map(s => s.trim()).filter(Boolean))) {
      if (!seen.has(t)) {
        seen.add(t);
        result.push(t);
      }
    }
    return result;
  }, [rawTags]);

  const [cardActive, setCardActive] = useState(initialActive !== false);
  const [strength, setStrength] = useState(initialStrength ?? 1.0);
  const [inputDisplay, setInputDisplay] = useState((initialStrength ?? 1.0).toFixed(2));
  const [splitMode, setSplitMode] = useState(initialSplitMode ?? false);

  const init = buildActiveSetFromInitial(rawTags, splitTags, initialActiveTags, initialSplitMode);
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
          activeList.push(rawTags[i]);
        }
      }
    }
    return { activeTags: activeList, strength: str, active: cActive, split_mode: sMode, slider_config: sliderConfig };
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

  const sliderEnabled = sliderConfig?.enabled === true;
  const strMin = sliderEnabled ? sliderConfig!.min : 0;
  const strMax = sliderEnabled ? sliderConfig!.max : 2;
  const strStep = sliderEnabled ? sliderConfig!.step : 0.1;
  const sliderReverse = sliderEnabled ? sliderConfig!.reverse === true : false;

  const handleStrengthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputDisplay(e.target.value);
  };

  const handleStrengthBlur = () => {
    const val = parseFloat(inputDisplay);
    const clamped = isNaN(val) ? strMin : Math.max(strMin, Math.min(strMax, val));
    const fixed = Math.round(clamped * 100) / 100;
    setStrength(fixed);
    setInputDisplay(fixed.toFixed(2));
    notifyParent(splitMode, splitActive, mergeActive, fixed, cardActive);
  };

  const adjustStrength = (delta: number) => {
    const next = Math.max(strMin, Math.min(strMax, Math.round((strength + delta) * 100) / 100));
    setStrength(next);
    setInputDisplay(next.toFixed(2));
    notifyParent(splitMode, splitActive, mergeActive, next, cardActive);
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    const fixed = Math.round(val * 100) / 100;
    setStrength(fixed);
    setInputDisplay(fixed.toFixed(2));
    notifyParent(splitMode, splitActive, mergeActive, fixed, cardActive);
  };

  const handleToggleSplit = () => {
    setSplitMode(prevMode => {
      const nextMode = !prevMode;

      if (nextMode) {
        const newSplit = new Set<number>();
        for (let i = 0; i < rawTags.length; i++) {
          const parts = rawTags[i].split(',').map(s => s.trim()).filter(Boolean);
          if (mergeActive.has(i)) {
            for (const part of parts) {
              const si = splitTags.indexOf(part);
              if (si !== -1) newSplit.add(si);
            }
          }
        }
        setSplitActive(newSplit);
        notifyParent(nextMode, newSplit, mergeActive, strength, cardActive);
      } else {
        const newMerge = new Set<number>();
        for (let i = 0; i < rawTags.length; i++) {
          const parts = rawTags[i].split(',').map(s => s.trim()).filter(Boolean);
          const hasActive = parts.some(p => {
            const si = splitTags.indexOf(p);
            return si !== -1 && splitActive.has(si);
          });
          if (hasActive) {
            newMerge.add(i);
          }
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

  const previewSrc = lora.preview_url
    ? `/lora_images/${encodeURIComponent(lora.preview_url)}`
    : '';

  return (
    <div className={`lora-card ${cardActive ? 'active' : ''} ${isMissing ? 'missing' : ''} ${isFiltered ? 'filtered' : ''} ${isProgramFiltered ? 'program-filtered' : ''}`} onMouseDown={toggleCard}>
      {previewSrc && <img className="lora-card-bg" src={previewSrc} alt="" />}
      <div className="lora-card-header">
        <span className="lora-card-name">{lora.name}</span>
        <div className="lora-card-meta" onMouseDown={e => e.stopPropagation()}>
          {!sliderEnabled && (
            <>
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
            </>
          )}
          <button
            className={`lora-card-toggle ${splitMode ? 'active' : ''}`}
            onClick={handleToggleSplit}
            type="button"
            title={splitMode ? 'Merge tags' : 'Split tags'}
          >
            {iconSplit}
          </button>
          {hideRemove ? null : <button className="lora-card-remove" onClick={onRemove} type="button">
            {iconX}
          </button>}
        </div>
      </div>
      {sliderEnabled ? (
        <div className="lora-card-slider-row" onMouseDown={e => e.stopPropagation()}>
          {sliderConfig!.min_name && <span className="lora-slider-label">{sliderConfig!.reverse ? sliderConfig!.max_name : sliderConfig!.min_name}</span>}
          <div className="lora-card-slider-wrap">
            <input
              className="lora-card-slider"
              type="range"
              min={sliderConfig!.min}
              max={sliderConfig!.max}
              step={sliderConfig!.step}
              value={strength}
              onChange={handleSliderChange}
              style={{
                ...(sliderConfig!.reverse ? { direction: 'rtl' } : {}),
                background: (() => {
                  const pct = ((strength - sliderConfig!.min) / (sliderConfig!.max - sliderConfig!.min)) * 100;
                  const fillPct = sliderConfig!.reverse ? 100 - pct : pct;
                  return `linear-gradient(to right, #0a84ff ${fillPct}%, rgba(255,255,255,0.2) ${fillPct}%)`;
                })(),
                borderRadius: '2px',
                height: '4px',
              }}
              title={`Strength: ${strength.toFixed(2)}`}
            />
            {(sliderConfig!.marks || []).filter(m => m.value >= sliderConfig!.min && m.value <= sliderConfig!.max).map((m, i) => {
              const pct = ((m.value - sliderConfig!.min) / (sliderConfig!.max - sliderConfig!.min)) * 100;
              const pos = sliderConfig!.reverse ? 100 - pct : pct;
              return <div key={i} className="lora-slider-mark" style={{ left: `${pos}%` }} title={m.label} />;
            })}
          </div>
          {sliderConfig!.max_name && <span className="lora-slider-label">{sliderConfig!.reverse ? sliderConfig!.min_name : sliderConfig!.max_name}</span>}
          <span className="lora-slider-value">{strength.toFixed(2)}</span>
        </div>
      ) : null}
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
