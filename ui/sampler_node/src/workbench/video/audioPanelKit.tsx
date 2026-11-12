import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDockDocument, useDockWindow } from '../../dock/docScope';

// ── 三扇音频定义窗共用的小件：分栏、左列列表、字段、总线勾选、迷你按钮 ──────────────────────
// 只做外观与交互的最小集合，不承载数据语义（数据在 audioDefs / audioRouting / 各面板里）。

export const S = {
  root: {
    height: '100%', display: 'flex', minHeight: 0, background: '#0f0f11',
    overflow: 'hidden', color: 'rgba(255,255,255,0.82)', fontSize: 10.5,
  } as React.CSSProperties,
  side: {
    width: 150, flexShrink: 0, display: 'flex', flexDirection: 'column',
    borderRight: '0.5px solid rgba(255,255,255,0.08)', minHeight: 0,
  } as React.CSSProperties,
  sideHead: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '5px 7px',
    borderBottom: '0.5px solid rgba(255,255,255,0.08)', flexShrink: 0,
  } as React.CSSProperties,
  sideList: { flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'thin' } as React.CSSProperties,
  sideRow: (on: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 4, padding: '5px 7px', cursor: 'pointer',
    background: on ? 'rgba(91,156,245,0.16)' : 'transparent',
    borderLeft: `2px solid ${on ? '#5b9cf5' : 'transparent'}`,
  }),
  main: { flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'thin', padding: '8px 10px 14px' } as React.CSSProperties,
  head: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 } as React.CSSProperties,
  field: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 } as React.CSSProperties,
  label: { width: 74, flexShrink: 0, color: 'rgba(255,255,255,0.42)', fontSize: 9.5 } as React.CSSProperties,
  input: {
    flex: 1, minWidth: 0, height: 20, fontSize: 10.5, color: 'rgba(255,255,255,0.82)',
    background: '#1b1b1e', border: '0.5px solid rgba(255,255,255,0.13)', borderRadius: 4,
    padding: '0 6px', outline: 'none',
  } as React.CSSProperties,
  select: {
    height: 20, fontSize: 10, color: 'rgba(255,255,255,0.8)', background: '#1b1b1e',
    border: '0.5px solid rgba(255,255,255,0.13)', borderRadius: 4, padding: '0 4px', outline: 'none',
  } as React.CSSProperties,
  btn: {
    height: 19, padding: '0 7px', borderRadius: 4, cursor: 'pointer', fontSize: 9.5,
    background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.14)',
    color: 'rgba(255,255,255,0.68)', flexShrink: 0,
  } as React.CSSProperties,
  subhead: {
    display: 'flex', alignItems: 'center', gap: 6, margin: '10px 0 6px',
    fontSize: 9.5, letterSpacing: 0.4, textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.38)',
  } as React.CSSProperties,
  card: {
    border: '0.5px solid rgba(255,255,255,0.09)', borderRadius: 5,
    padding: '6px 8px', marginBottom: 6, background: 'rgba(255,255,255,0.02)',
  } as React.CSSProperties,
  tag: {
    fontSize: 8.5, color: 'rgba(255,255,255,0.35)', fontVariantNumeric: 'tabular-nums',
  } as React.CSSProperties,
  empty: { padding: 14, fontSize: 10, lineHeight: 1.9, color: 'rgba(255,255,255,0.3)' } as React.CSSProperties,
};

export const SmallBtn: React.FC<{
  onClick: () => void; title?: string; children: React.ReactNode; disabled?: boolean;
}> = ({ onClick, title, children, disabled }) => (
  <button type="button" title={title} disabled={disabled} onClick={onClick}
    style={{ ...S.btn, ...(disabled ? { opacity: 0.35, cursor: 'not-allowed' } : null) }}>{children}</button>
);

export const Field: React.FC<{ label: string; children: React.ReactNode; width?: number }> = (
  { label, children, width },
) => (
  <div style={S.field}>
    <span style={{ ...S.label, ...(width ? { width } : null) }}>{label}</span>
    {children}
  </div>
);

// ── 改名 / 右键菜单（三扇窗统一）──────────────────────────────────────────────────────────
// 名字只是代号：没有常驻输入框，**双击改名**（右键菜单里也有一条 Rename），删除走 Delete 键与
// 右键菜单里的 Delete。与轨道头 / 资产卡片的做法一致，三扇窗共用这一份。

/** 一列行共用一份"正在改名的是谁 + 草稿"。id 用实体自己的 id（全局唯一）。 */
export const useRename = () => {
  const [id, setId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const start = (target: string, name: string): void => { setId(target); setDraft(name); };
  const cancel = (): void => setId(null);
  return { id, draft, setDraft, start, cancel };
};

/** 名字：平时是一行文字（双击开始改名），正在改名时是输入框（Enter 提交 / Esc 取消 / 失焦提交）。 */
export const RenameLabel: React.FC<{
  name: string;
  editing: boolean;
  draft: string;
  placeholder?: string;
  style?: React.CSSProperties;
  onStart: () => void;
  onDraft: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}> = ({ name, editing, draft, placeholder, style, onStart, onDraft, onCommit, onCancel }) => {
  if (!editing) {
    return (
      <span
        title={name || placeholder}
        onDoubleClick={e => { e.stopPropagation(); onStart(); }}
        style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...style }}
      >{name || placeholder || '(unnamed)'}</span>
    );
  }
  return (
    <input
      autoFocus
      value={draft}
      spellCheck={false}
      onChange={e => onDraft(e.target.value)}
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onKeyDown={e => {
        // 输入框里的 Delete 是删字，不是删这一行；也别让别的热键听见。
        e.stopPropagation();
        if (e.key === 'Enter') onCommit();
        else if (e.key === 'Escape') onCancel();
      }}
      onBlur={onCommit}
      title="Enter to apply, Escape to cancel"
      style={{ ...S.input, flex: 1, minWidth: 0, height: 18, ...style }}
    />
  );
};

export type AudioMenuItem = { label: string; onClick: () => void; danger?: boolean };

/** 右键菜单：挂到宿主 document.body（弹窗 / 副窗里也能用），点别处 / Esc / 滚动即关。 */
export const AudioContextMenu: React.FC<{
  at: { x: number; y: number } | null;
  items: AudioMenuItem[];
  onClose: () => void;
}> = ({ at, items, onClose }) => {
  const doc = useDockDocument();
  const win = useDockWindow();
  const open = at !== null;
  useEffect(() => {
    if (!open) return;
    const inMenu = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      return !!el && typeof el.closest === 'function' && !!el.closest('[data-audio-menu]');
    };
    const onDown = (e: PointerEvent) => { if (!inMenu(e.target)) onClose(); };
    const onCtx = (e: MouseEvent) => { if (!inMenu(e.target)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    win.addEventListener('pointerdown', onDown, true);
    win.addEventListener('contextmenu', onCtx, true);
    win.addEventListener('keydown', onKey);
    win.addEventListener('wheel', onClose, { passive: true });
    win.addEventListener('blur', onClose);
    return () => {
      win.removeEventListener('pointerdown', onDown, true);
      win.removeEventListener('contextmenu', onCtx, true);
      win.removeEventListener('keydown', onKey);
      win.removeEventListener('wheel', onClose);
      win.removeEventListener('blur', onClose);
    };
  }, [open, onClose]);
  if (!at) return null;
  return createPortal(
    <div
      data-audio-menu="1"
      onContextMenu={e => e.preventDefault()}
      style={{
        position: 'fixed', zIndex: 9999,
        left: Math.max(8, Math.min(at.x, win.innerWidth - 160)),
        top: Math.max(8, Math.min(at.y, win.innerHeight - items.length * 28 - 12)),
        minWidth: 132, padding: 4, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 1,
        background: 'rgba(34,34,38,0.985)', border: '0.5px solid rgba(255,255,255,0.16)',
        boxShadow: '0 12px 36px rgba(0,0,0,0.6)',
      }}
    >
      {items.map(it => (
        <button
          key={it.label}
          type="button"
          onClick={() => { onClose(); it.onClick(); }}
          style={{
            display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left',
            padding: '6px 9px', borderRadius: 5, border: 'none', background: 'transparent',
            color: it.danger ? 'rgba(255,120,110,0.92)' : 'rgba(255,255,255,0.92)',
            fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = it.danger ? 'rgba(255,69,58,0.16)' : 'rgba(255,255,255,0.08)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
        >{it.label}</button>
      ))}
    </div>,
    doc.body,
  );
};

/** 左列：标题 + 新建 + 一张表。行可选中；双击改名、右键出菜单、聚焦时 Delete 删除。 */
export const SidePane: React.FC<{
  title: string;
  items: { id: string; name: string }[];
  selId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  addTitle?: string;
  onDelete?: (id: string) => void;
  onRename?: (id: string, name: string) => void;
}> = ({ title, items, selId, onSelect, onAdd, addTitle, onDelete, onRename }) => {
  const ren = useRename();
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const menuItem = menu ? items.find(x => x.id === menu.id) : null;

  const commit = (it: { id: string; name: string }) => {
    const v = ren.draft.trim();
    ren.cancel();
    if (v && v !== it.name) onRename?.(it.id, v);
  };

  return (
    <div style={S.side}>
      <div style={S.sideHead}>
        <span style={{ ...S.tag, letterSpacing: 0.4, textTransform: 'uppercase' }}>{title}</span>
        <span style={{ flex: 1 }} />
        <SmallBtn onClick={onAdd} title={addTitle ?? 'Add'}>{'+'}</SmallBtn>
      </div>
      <div style={S.sideList}>
        {items.map(it => (
          <div
            key={it.id}
            tabIndex={0}
            onClick={() => onSelect(it.id)}
            onContextMenu={e => {
              e.preventDefault();
              e.stopPropagation();
              onSelect(it.id);
              setMenu({ x: e.clientX, y: e.clientY, id: it.id });
            }}
            onDoubleClick={e => {
              if ((e.target as HTMLElement).closest('input')) return;
              if (!onRename) return;
              onSelect(it.id);
              ren.start(it.id, it.name);
            }}
            onKeyDown={e => {
              if ((e.target as HTMLElement).closest('input,select,textarea')) return;
              if (!onDelete) return;
              if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                e.stopPropagation();
                if (ren.id === it.id) ren.cancel();
                onDelete(it.id);
              }
            }}
            style={{ ...S.sideRow(it.id === selId), outline: 'none' }}
          >
            <RenameLabel
              name={it.name}
              placeholder="(unnamed)"
              editing={ren.id === it.id}
              draft={ren.draft}
              onStart={() => ren.start(it.id, it.name)}
              onDraft={ren.setDraft}
              onCommit={() => commit(it)}
              onCancel={ren.cancel}
            />
          </div>
        ))}
        {items.length === 0 && <div style={{ ...S.empty, padding: '10px 8px' }}>Nothing yet.</div>}
      </div>
      <AudioContextMenu
        at={menu}
        onClose={() => setMenu(null)}
        items={menu ? [
          ...(onRename && menuItem ? [{
            label: 'Rename',
            onClick: () => { if (menuItem) ren.start(menuItem.id, menuItem.name); },
          }] : []),
          ...(onDelete ? [{ label: 'Delete', danger: true, onClick: () => onDelete(menu.id) }] : []),
        ] : []}
      />
    </div>
  );
};

/** 总线多选：一行一个（名字 + 复选框）。disabled 用来拒绝"会成环"的挂载。 */
/** 一组「挂载」：每行一个 enum 下拉（选目标），"+ xxx" 追加一行；右键或 Delete 移除这一行。
 *  已经挂在别的行上的目标在本行禁用；`disabledOption` 返回原因即禁用（比如嵌套会成环）。 */
export const MountRows: React.FC<{
  ids: string[];
  options: { id: string; name: string }[];
  onChange: (ids: string[]) => void;
  addLabel: string;
  emptyText?: string;
  disabledOption?: (id: string) => string | null;
}> = ({ ids, options, onChange, addLabel, emptyText, disabledOption }) => {
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const taken = new Set(ids);
  const firstFree = options.find(o => !taken.has(o.id) && !disabledOption?.(o.id));
  const removeAt = (index: number) => onChange(ids.filter((_, j) => j !== index));

  return (
    <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
      {ids.map((id, i) => {
        const others = new Set(ids.filter((_, j) => j !== i));
        const cur = options.find(o => o.id === id);
        return (
          <div
            key={i}
            tabIndex={0}
            onContextMenu={e => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ x: e.clientX, y: e.clientY, index: i });
            }}
            onKeyDown={e => {
              if ((e.target as HTMLElement).closest('input,select,textarea,button')) return;
              if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                e.stopPropagation();
                removeAt(i);
              }
            }}
            style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, outline: 'none' }}
          >
            <select
              value={id}
              title={cur?.name}
              onChange={e => onChange(ids.map((x, j) => (j === i ? e.target.value : x)))}
              style={{ ...S.select, flex: 1, minWidth: 0 }}
            >
              {options.map(o => {
                const why = disabledOption?.(o.id);
                const used = others.has(o.id);
                return (
                  <option key={o.id} value={o.id} disabled={used || !!why}
                    title={used ? 'Already mounted on another row.' : why ?? o.name}>{o.name}</option>
                );
              })}
            </select>
          </div>
        );
      })}
      {ids.length === 0 && emptyText && <span style={S.tag}>{emptyText}</span>}
      <div>
        <SmallBtn
          onClick={() => { if (firstFree) onChange([...ids, firstFree.id]); }}
          disabled={!firstFree}
          title={firstFree ? 'Mount' : 'Nothing left to mount'}
        >+ {addLabel}</SmallBtn>
      </div>
      <AudioContextMenu
        at={menu}
        onClose={() => setMenu(null)}
        items={menu ? [{ label: 'Delete', danger: true, onClick: () => removeAt(menu.index) }] : []}
      />
    </div>
  );
};

export const Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void; label: string }> = (
  { on, onChange, label },
) => (
  <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
    <input type="checkbox" checked={on} onChange={e => onChange(e.target.checked)}
      style={{ width: 11, height: 11, margin: 0, accentColor: '#5b9cf5' }} />
    <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.62)' }}>{label}</span>
  </label>
);

export const fmtDb = (g: number): string =>
  (!(g > 1e-4) ? '−∞' : (20 * Math.log10(g) > -0.05 ? '0.0' : (20 * Math.log10(g)).toFixed(1))) + ' dB';
