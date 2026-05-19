import { useState, useRef, useEffect, useMemo, useCallback } from 'react';

const iconX = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M18 6L6 18M6 6l12 12"/></svg>;

interface SearchBarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  filterOptions: string[];
  selectedFilter: string;
  onFilterChange: (filter: string) => void;
}

const iosDarkInput = {
  width: '100%',
  padding: '10px 14px',
  borderRadius: 10,
  border: 'none',
  fontSize: 15,
  outline: 'none',
  boxSizing: 'border-box' as const,
  background: '#1c1c1e',
  color: '#fff',
  fontFamily: '-apple-system, system-ui, Helvetica Neue, sans-serif',
};

const iosDarkSelectBox = {
  width: '100%',
  padding: '10px 14px',
  borderRadius: 10,
  border: 'none',
  fontSize: 15,
  outline: 'none',
  background: '#1c1c1e',
  color: '#fff',
  cursor: 'text' as const,
  fontFamily: '-apple-system, system-ui, Helvetica Neue, sans-serif',
  boxSizing: 'border-box' as const,
};

const dropdownStyle = {
  position: 'absolute' as const,
  top: '100%',
  left: 0,
  right: 0,
  maxHeight: 220,
  overflowY: 'auto' as const,
  background: '#2c2c2e',
  borderRadius: 10,
  marginTop: 4,
  zIndex: 100,
  boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
};

const optionStyle = (selected: boolean) => ({
  padding: '8px 14px',
  fontSize: 14,
  cursor: 'pointer' as const,
  color: '#fff',
  background: selected ? '#3a3a3c' : 'transparent',
  fontFamily: '-apple-system, system-ui, Helvetica Neue, sans-serif',
});

function SearchableSelect({
  options, value, onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // Sync input when value changes externally
  useEffect(() => {
    if (!open) setInputValue(value ? value : '');
  }, [value, open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const filtered = useMemo(() => {
    if (!inputValue) return options;
    const q = inputValue.toLowerCase();
    return options.filter(o => o.toLowerCase().includes(q));
  }, [options, inputValue]);

  const handleSelect = useCallback((opt: string) => {
    onChange(opt);
    setInputValue(opt);
    setOpen(false);
  }, [onChange]);

  const handleClear = useCallback(() => {
    onChange('');
    setInputValue('');
    setOpen(false);
  }, [onChange]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div style={{ position: 'relative' }}>
        <input
          type="text"
          placeholder="Filter: 无"
          value={open ? inputValue : (value || '')}
          onFocus={() => { setOpen(true); setInputValue(''); }}
          onChange={e => { setInputValue(e.target.value); setOpen(true); }}
          style={iosDarkSelectBox}
        />
        {value && !open ? (
          <button
            onClick={handleClear}
            style={{
              position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', color: '#8e8e93', cursor: 'pointer',
              fontSize: 16, padding: '2px 6px', borderRadius: 4,
            }}
          >{iconX}</button>
        ) : null}
      </div>
      {open ? (
        <div style={dropdownStyle}>
          <div
            onClick={handleClear}
            style={optionStyle(value === '')}
          >无</div>
          {filtered.length === 0 ? (
            <div style={{ padding: '8px 14px', fontSize: 13, color: '#8e8e93' }}>No matches</div>
          ) : filtered.map(opt => (
            <div
              key={opt}
              onClick={() => handleSelect(opt)}
              style={optionStyle(opt === value)}
              onMouseEnter={e => (e.currentTarget.style.background = '#3a3a3c')}
              onMouseLeave={e => (e.currentTarget.style.background = opt === value ? '#3a3a3c' : 'transparent')}
            >{opt}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SearchBar({
  searchQuery, onSearchChange,
  filterOptions, selectedFilter, onFilterChange,
}: SearchBarProps) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ position: 'relative', flex: 1, minWidth: 160 }}>
        <input
          type="text"
          placeholder="Search prompts..."
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
          style={iosDarkInput}
        />
      </div>
      <div style={{ position: 'relative', minWidth: 150 }}>
        <SearchableSelect
          options={filterOptions}
          value={selectedFilter}
          onChange={onFilterChange}
        />
      </div>
    </div>
  );
}
