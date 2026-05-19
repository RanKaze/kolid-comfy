import { useMemo } from 'react';
import type { PrefabData, FocusPoints, AllLibraries } from '../types';
import { tagsToDisplayName } from '../hooks/useSelection';

const iconGrip = <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{verticalAlign:'middle'}}><circle cx="9" cy="6" r="1.8"/><circle cx="9" cy="12" r="1.8"/><circle cx="9" cy="18" r="1.8"/><circle cx="15" cy="6" r="1.8"/><circle cx="15" cy="12" r="1.8"/><circle cx="15" cy="18" r="1.8"/></svg>;
const iconPencil = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>;
const iconTrash = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>;

interface PrefabItemProps {
  prefab: PrefabData;
  libName: string;
  idx: number;
  modeClass: string;
  isMiniMode: boolean;
  prefabClass: string;
  focusPoints: FocusPoints;
  imgUrl: (path: string) => string;
  isSelected: boolean;
  onToggle: () => void;
  allLibraries: AllLibraries;
  onEdit: () => void;
  onDelete: () => void;
}

export function PrefabItem({
  prefab, libName, idx, modeClass, isMiniMode, prefabClass, focusPoints, imgUrl,
  isSelected, onToggle, allLibraries, onEdit, onDelete,
}: PrefabItemProps) {
  const focusKey = `prefab_${libName}_${idx}`;
  const fp = focusPoints[focusKey];

  const handleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.actions, .action-btn, .drag-handle')) return;
    onToggle();
  };


  const displayStr = useMemo(
    () => (prefab.tags || []).map(g => tagsToDisplayName(g)).join(' + '),
    [prefab.tags],
  );

  const loraStr = useMemo(() => {
    const loras = prefab.loras || [];
    if (loras.length === 0) return '';
    return `Lora(${loras.length}): ${loras.map(l => l.name).join(', ')}`;
  }, [prefab.loras]);

  const nestedPrefabStr = useMemo(() => {
    const direct = prefab.selected_prefabs || [];
    if (direct.length === 0) return '';

    // Build guid -> prefab map from all libraries
    const guidMap = new Map<string, PrefabData>();
    for (const libData of Object.values(allLibraries)) {
      for (const p of libData.prefabs || []) {
        if (p.guid) guidMap.set(p.guid, p);
      }
    }

    // BFS expand nested prefabs, deduplicate and cycle-safe
    const visited = new Set<string>();
    const queue: string[] = [];
    for (const sp of direct) {
      const g = sp.guid;
      if (g && !visited.has(g)) {
        visited.add(g);
        queue.push(g);
      }
    }

    const names: string[] = [];
    while (queue.length > 0) {
      const currentGuid = queue.shift()!;
      const p = guidMap.get(currentGuid);
      if (!p) continue;
      names.push(p.name);
      for (const nested of p.selected_prefabs || []) {
        const ng = nested.guid;
        if (ng && !visited.has(ng)) {
          visited.add(ng);
          queue.push(ng);
        }
      }
    }

    if (names.length === 0) return '';
    return `Prefab(${names.length}): ${names.join(', ')}`;
  }, [prefab.selected_prefabs, allLibraries]);

  return (
    <div className="prompt-item-wrapper">
      <div
        className={`prompt-item ${modeClass} ${prefabClass} ${isSelected ? 'prefab-selected' : ''}`}
        data-prefab={`prefab_${libName}_${idx}`}
        data-library={libName}
        data-prefab-index={idx}
        onMouseDown={handleClick}

      >
        <span className="drag-handle" data-drag-type="prefab" data-library={libName} data-index={idx}>{iconGrip}</span>
        <div className="select-area" style={{ width: '100%', height: '100%', position: 'relative' }}>
          <div className="image-layer">
            {prefab.preview ? <img src={imgUrl(prefab.preview)} alt={prefab.name} loading="lazy" style={fp ? { objectPosition: `${fp.x}% ${fp.y}%` } : {}} /> : <div className="no-image">No Image</div>}
          </div>
          {!isMiniMode && <div className="glass-layer" />}
          <div className="text-layer">
            <div className="name" style={{ color: 'var(--accent-color)' }}>{prefab.name}</div>
            <div className="prompt-text">{displayStr}</div>
            {loraStr && <div className="prefab-loras">{loraStr}</div>}
            {nestedPrefabStr && <div className="prefab-loras">{nestedPrefabStr}</div>}
          </div>
        </div>
        <div className="actions" style={{ position: 'absolute', top: 4, right: 4 }} onMouseDown={e => e.stopPropagation()}>
          <button className="action-btn edit" onClick={e => { e.stopPropagation(); onEdit(); }}>{iconPencil}</button>
          <button className="action-btn delete" onClick={e => { e.stopPropagation(); onDelete(); }}>{iconTrash}</button>
        </div>
      </div>
    </div>
  );
}
