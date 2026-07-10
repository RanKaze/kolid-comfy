import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import type { AllPrompts, TagGroup } from '../types';
import { tryParseLine } from '../hooks/useSelection';

interface CustomPromptsEditorProps {
  value: string;
  onChange: (v: string) => void;
  allPrompts: AllPrompts;
  onParsed: (tagGroup: TagGroup, displayString: string) => void;
  placeholder?: string;
}

const baseStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 14px',
  borderRadius: 10,
  border: 'none',
  fontSize: 15,
  outline: 'none',
  boxSizing: 'border-box',
  background: '#1c1c1e',
  color: '#fff',
  fontFamily: '-apple-system, system-ui, Helvetica Neue, sans-serif',
  resize: 'vertical',
  minHeight: 60,
};

const dropdownStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  left: 0,
  right: 0,
  maxHeight: 180,
  overflowY: 'auto',
  background: '#2c2c2e',
  borderRadius: 10,
  marginBottom: 4,
  zIndex: 100,
  boxShadow: '0 -4px 16px rgba(0,0,0,0.4)',
  scrollbarWidth: 'thin',
  scrollbarColor: '#48484a transparent',
} as React.CSSProperties;

export function CustomPromptsEditor({
  value, onChange, allPrompts, onParsed, placeholder,
}: CustomPromptsEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const selItemRef = useRef<HTMLDivElement>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selIdx, setSelIdx] = useState(-1);
  const [query, setQuery] = useState('');

  const suggestions = useMemo(() => {
    const map = new Map<string, string>();
    for (const cd of Object.values(allPrompts)) {
      const prompts = ((cd as any).prompts || []) as { name: string; prompt: string }[];
      for (const p of prompts) {
        if (p.prompt && !map.has(p.prompt)) map.set(p.prompt, p.name || p.prompt);
      }
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
  }, [allPrompts]);

  const filtered = useMemo(() => {
    if (!query) return suggestions.slice(0, 50);
    const q = query.toLowerCase();
    return suggestions.filter(([text, name]) =>
      text.toLowerCase().includes(q) || name.toLowerCase().includes(q)
    ).slice(0, 50);
  }, [suggestions, query]);

  // Scroll selected autocomplete item into view
  useEffect(() => {
    if (showDropdown && selIdx >= 0 && selItemRef.current) {
      selItemRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [selIdx, showDropdown]);

  const getWordBeforeCursor = useCallback((ta: HTMLTextAreaElement): string => {
    const pos = ta.selectionStart;
    const text = ta.value;
    if (pos === 0) return '';
    let s = pos - 1;
    while (s >= 0 && text[s] !== ' ' && text[s] !== '\n' && text[s] !== ',') s--;
    return text.slice(s + 1, pos);
  }, []);

  const replaceWord = useCallback((text: string) => {
    const ta = ref.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const words = ta.value;
    let s = pos - 1;
    while (s >= 0 && words[s] !== ' ' && words[s] !== '\n' && words[s] !== ',') s--;
    const newVal = words.slice(0, s + 1) + text + (pos >= words.length || words[pos] === ' ' || words[pos] === '\n' ? '' : ' ') + words.slice(pos);
    onChange(newVal);
    const nc = s + 1 + text.length;
    setTimeout(() => { ta.selectionStart = ta.selectionEnd = nc; ta.focus(); }, 0);
    setShowDropdown(false);
  }, [onChange]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    const ta = e.target;
    const w = getWordBeforeCursor(ta);
    if (w.length >= 1) {
      setQuery(w);
      setShowDropdown(true);
      setSelIdx(-1);
    } else {
      setShowDropdown(false);
    }
  }, [onChange, getWordBeforeCursor]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showDropdown && filtered.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelIdx(i => Math.min(i + 1, filtered.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        const idx = selIdx >= 0 ? selIdx : 0;
        if (idx < filtered.length) replaceWord(filtered[idx][0]);
        return;
      }
      if (e.key === 'Enter' && selIdx >= 0) {
        e.preventDefault();
        if (selIdx < filtered.length) replaceWord(filtered[selIdx][0]);
        return;
      }
      if (e.key === 'Escape') { setShowDropdown(false); return; }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const ta = ref.current;
      if (!ta) return;
      const pos = ta.selectionStart;
      const text = ta.value;
      const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
      const lineEnd = text.indexOf('\n', pos);
      const currentLine = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
      if (!currentLine) {
        const nv = text.slice(0, pos) + '\n' + text.slice(ta.selectionEnd);
        onChange(nv);
        setTimeout(() => { ta.selectionStart = ta.selectionEnd = pos + 1; ta.focus(); }, 0);
        return;
      }

      // Find which comma-segment the cursor is on (relative to line start)
      const relPos = pos - lineStart;
      // Clamp relPos to line bounds
      const clampedRel = Math.min(relPos, currentLine.length);

      // Find segment boundaries by scanning commas
      let segStartIdx = 0;
      let segEndIdx = currentLine.length;
      let found = false;
      for (let i = 0; i <= currentLine.length; i++) {
        if (i === currentLine.length || currentLine[i] === ',') {
          if (clampedRel >= segStartIdx && clampedRel <= i) {
            segEndIdx = i;
            found = true;
            break;
          }
          segStartIdx = i + 1;
        }
      }
      if (!found) {
        // Fallback: just insert newline
        const nv = text.slice(0, pos) + '\n' + text.slice(ta.selectionEnd);
        onChange(nv);
        setTimeout(() => { ta.selectionStart = ta.selectionEnd = pos + 1; ta.focus(); }, 0);
        setShowDropdown(false);
        return;
      }

      // Extract the segment at cursor
      const segmentToParse = currentLine.slice(segStartIdx, segEndIdx).trim();
      if (!segmentToParse) {
        const nv = text.slice(0, pos) + '\n' + text.slice(ta.selectionEnd);
        onChange(nv);
        setTimeout(() => { ta.selectionStart = ta.selectionEnd = pos + 1; ta.focus(); }, 0);
        setShowDropdown(false);
        return;
      }

      const result = tryParseLine(segmentToParse, allPrompts);
      if (result) {
        onParsed(result.tagGroup, result.displayString);
        // Build new line: remove the parsed segment and its trailing comma (or leading comma)
        let newLine: string;
        // Determine replacement boundaries on the full line (including spaces/commas)
        const beforeSeg = currentLine.slice(0, segStartIdx);
        const afterSeg = currentLine.slice(segEndIdx);
        // We want to remove the segment and one comma (and surrounding spaces)
        // Strategy: remove the segment text itself (trimmed), then clean up the resulting comma mess
        const beforeTrimmed = beforeSeg.replace(/\s*$/, '');
        const afterTrimmed = afterSeg.replace(/^\s*/, '');
        const beforeHasComma = beforeTrimmed.endsWith(',');
        const afterHasComma = afterTrimmed.startsWith(',');

        if (beforeHasComma && afterHasComma) {
          // "test, body, temp" → remove body → "test, temp"
          newLine = beforeTrimmed.slice(0, -1).trimEnd() + ', ' + afterTrimmed.slice(1).trimStart();
        } else if (beforeHasComma) {
          // "test, body" → "test,"
          newLine = beforeTrimmed;
        } else if (afterHasComma) {
          // "body, test" → afterTrimmed starts with comma → ", test"
          newLine = afterTrimmed;
        } else {
          // "body" alone
          newLine = '';
        }
        newLine = newLine.trim();

        const before = text.slice(0, lineStart);
        const after = text.slice(lineEnd === -1 ? text.length : lineEnd + 1);
        if (newLine) {
          onChange(before + newLine + (lineEnd === -1 ? '' : '\n') + after);
        } else {
          onChange(before + after);
        }
        setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = before.length + newLine.length; }, 0);
      } else {
        // Nothing parsed: just insert newline at cursor
        const nv = text.slice(0, pos) + '\n' + text.slice(ta.selectionEnd);
        onChange(nv);
        setTimeout(() => { ta.selectionStart = ta.selectionEnd = pos + 1; ta.focus(); }, 0);
      }
      setShowDropdown(false);
    }
  }, [showDropdown, filtered, selIdx, replaceWord, onChange, allPrompts, onParsed]);

  return (
    <div style={{ position: 'relative' }}>
      <textarea
        ref={ref}
        placeholder={placeholder || 'Enter custom prompts here...\nPress Enter to parse'}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
        style={baseStyle}
      />
      {showDropdown && filtered.length > 0 ? (
        <div ref={dropdownRef} className="kolid-dropdown-scroll" style={dropdownStyle}>
          {filtered.map(([text, name], i) => (
            <div
              key={text}
              ref={i === selIdx ? selItemRef : null}
              onMouseDown={e => { e.preventDefault(); replaceWord(text); }}
              style={{
                padding: '8px 14px', fontSize: 14, cursor: 'pointer',
                color: '#fff', background: i === selIdx ? '#3a3a3c' : 'transparent',
                fontFamily: '-apple-system, system-ui, Helvetica Neue, sans-serif',
                display: 'flex', alignItems: 'center',
              }}
            >
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
              {name !== text ? <span style={{ color: '#8e8e93', fontSize: 13, borderLeft: '1px solid #444', paddingLeft: 12, marginLeft: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1 }}>{name}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
