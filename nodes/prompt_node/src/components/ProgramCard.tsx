import type { ProgramData } from '../types';

const iconCode = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>;
const iconTrash = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle'}}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>;
const iconGrip = <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{verticalAlign:'middle'}}><circle cx="9" cy="6" r="1.8"/><circle cx="9" cy="12" r="1.8"/><circle cx="9" cy="18" r="1.8"/><circle cx="15" cy="6" r="1.8"/><circle cx="15" cy="12" r="1.8"/><circle cx="15" cy="18" r="1.8"/></svg>;

interface ProgramCardProps {
  app: ProgramData;
  active: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDragStart: (e: React.DragEvent) => void;
}

export function ProgramCard({ app, active, onToggle, onEdit, onDelete, onDragStart }: ProgramCardProps) {
  const codePreview = app.code.split('\n').slice(0, 3).join('\n');
  return (
    <div
      className={`program-card${active ? ' active' : ''}`}
      draggable
      onDragStart={onDragStart}
      onMouseDown={e => {
        const t = e.target as HTMLElement;
        if (!t.closest('.program-edit-btn, .program-delete-btn, .program-toggle')) {
          onToggle();
        }
      }}
    >
      <div className="program-card-header">
        <span className="drag-handle program-drag-handle">{iconGrip}</span>
        <span className="program-toggle" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.name}</span>
        <button className="program-edit-btn" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onEdit(); }}>{iconCode}</button>
        <button className="program-delete-btn" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onDelete(); }}>{iconTrash}</button>
      </div>
      {codePreview ? <pre className="program-code-preview">{codePreview}</pre> : null}
    </div>
  );
}
