import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { InterfaceInfo } from '../../types';
import type { ProcFrameWindow, ProcSettingsPatch, VidClip, VidProcPending } from './model';

/**
 * PlaceholderSettingsModal —— 占位段的**批量设置**。
 *
 * 一颗齿轮打开：只想改一段就直接改它；先多选（Ctrl/⌘ 点选、Shift 连选）再点其中一段的
 * 齿轮 → 这一批一起改。**所有保存下来的信息都在这里**：
 *   · 片段本身：名字 / 起始 / 时长；
 *   · 执行快照：kind、接口、preset、输出口、追加 prompt、Mask 轨、段号/段数；
 *   · params（manual_values，按接口的 manual 口拿标签与候选项）；
 *   · inputs / maskInputs（每个输入口的**帧段**：file / f0 / n / fps —— f0 = 源内按工程 fps
 *     的整数起始帧号，不存秒）。
 *
 * 混合口径：一个字段在这批里值不一样就显示 `—`（输入框的 placeholder / 下拉的 `—` 项），
 * 并且**保持原样**；只有用户真正动过的字段才写回。窗口类的字段按 key 逐项写，只改
 * **拥有这个输入口**的占位段 —— 某段没有这个口就不会凭空长出一行。
 */

type FieldMix = { value: string; mixed: boolean };
type WinKey = keyof ProcFrameWindow;

const WIN_FIELDS: { key: WinKey; label: string; wide?: boolean }[] = [
  { key: 'file', label: 'file', wide: true },
  { key: 'f0', label: 'f0' },
  { key: 'n', label: 'n' },
  { key: 'fps', label: 'fps' },
];

const eqVal = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

const commonValue = <T,>(clips: VidClip[], get: (c: VidClip) => T): { value: T | undefined; mixed: boolean } => {
  let first: T | undefined;
  let has = false;
  let mixed = false;
  for (const c of clips) {
    const v = get(c);
    if (!has) { first = v; has = true; }
    else if (!eqVal(first, v)) mixed = true;
  }
  return { value: mixed ? undefined : first, mixed };
};

const numText = (v: number | undefined): string => (v == null ? '' : String(Math.round(v * 1000) / 1000));
const anyText = (v: unknown): string => (v == null ? '' : (typeof v === 'string' ? v : JSON.stringify(v)));

const parseParam = (raw: string): unknown => {
  const t = raw.trim();
  if (!t) return '';
  try { return JSON.parse(t); } catch { return raw; }
};

const sortKeys = (a: string, b: string): number => {
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
};

const PlaceholderSettingsModal: React.FC<{
  /** 这一批占位段（都带 pending；顺序 = 时间线上选中的顺序）。 */
  clips: VidClip[];
  interfaces: InterfaceInfo[];
  presets: { id: string; name: string }[];
  videoTracks: { id: string; name: string }[];
  onApply: (patch: ProcSettingsPatch) => void;
  onClose: () => void;
}> = ({ clips, interfaces, presets, videoTracks, onApply, onClose }) => {
  /** 用户动过的字段（id → 文本）。不在里面 = 保持原样（混合值也不写回）。 */
  const [edits, setEdits] = useState<Record<string, string>>({});
  const edit = useCallback((id: string, v: string) => {
    setEdits(prev => ({ ...prev, [id]: v }));
  }, []);

  const mixText = useCallback((get: (c: VidClip) => string): FieldMix => {
    const m = commonValue(clips, get);
    return { mixed: m.mixed, value: m.mixed ? '' : (m.value ?? '') };
  }, [clips]);

  const nameM = mixText(c => c.name);
  const startM = mixText(c => numText(c.start));
  const durationM = mixText(c => numText(c.duration));
  const kindM = mixText(c => c.pending?.kind ?? 'processor');
  const ifaceM = mixText(c => c.pending?.iface ?? '');
  const presetM = mixText(c => c.pending?.presetId ?? '');
  const portM = mixText(c => String(c.pending?.port ?? 0));
  const extraM = mixText(c => c.pending?.extraPrompt ?? '');
  const maskM = mixText(c => c.pending?.maskTrackId ?? '');
  const segIndexM = mixText(c => String(c.pending?.segIndex ?? 0));
  const segCountM = mixText(c => String(c.pending?.segCount ?? 1));

  // params 的 key 并集；缺这个 key 的占位段按"值是 undefined"参与比较（于是显示 —）。
  const paramKeys = useMemo(() => {
    const keys = new Set<string>();
    clips.forEach(c => Object.keys(c.pending?.params ?? {}).forEach(k => keys.add(k)));
    return [...keys].sort(sortKeys);
  }, [clips]);
  const paramMix = (key: string): FieldMix => {
    let first: unknown;
    let has = false;
    let mixed = false;
    for (const c of clips) {
      const params = c.pending?.params ?? {};
      const v = Object.prototype.hasOwnProperty.call(params, key) ? params[key] : undefined;
      if (!has) { first = v; has = true; }
      else if (!eqVal(first, v)) mixed = true;
    }
    return { mixed, value: mixed ? '' : anyText(first) };
  };

  // 抽帧窗口的 key 并集（inputs / maskInputs 各一套）。
  const winKeysOf = (pick: (c: VidClip) => Record<string, ProcFrameWindow> | undefined): string[] => {
    const keys = new Set<string>();
    clips.forEach(c => Object.keys(pick(c) ?? {}).forEach(k => keys.add(k)));
    return [...keys].sort(sortKeys);
  };
  const inputKeys = useMemo(() => winKeysOf(c => c.pending?.inputs), [clips]);
  const maskKeys = useMemo(() => winKeysOf(c => c.pending?.maskInputs), [clips]);

  const winMix = (
    pick: (c: VidClip) => Record<string, ProcFrameWindow> | undefined,
    key: string, field: WinKey,
  ): FieldMix => {
    const subs = clips.filter(c => (pick(c) ?? {})[key] != null);
    const m = commonValue(subs, c => {
      const w = (pick(c) ?? {})[key];
      return w ? String(w[field]) : '';
    });
    return { mixed: m.mixed, value: m.mixed ? '' : (m.value ?? '') };
  };

  // params 标签/候选项：按这批段共用的接口名找 manual 口（找不到就退化成 Port 号）。
  const ifaceName = edits['iface'] ?? (ifaceM.mixed ? '' : ifaceM.value);
  const ifaceInfo = interfaces.find(x => x.name === ifaceName);
  const paramDefOf = (key: string) =>
    ifaceInfo?.start_ports.find(p => p.category === 'manual' && String(p.num) === key)
    ?? ifaceInfo?.start_ports.find(p => String(p.num) === key);

  const editCount = Object.keys(edits).length;

  const buildPatch = (): ProcSettingsPatch => {
    const patch: ProcSettingsPatch = {};
    const pd: Partial<VidProcPending> = {};
    const params: Record<string, unknown> = {};
    const inputs: Record<string, Partial<ProcFrameWindow>> = {};
    const maskInputs: Record<string, Partial<ProcFrameWindow>> = {};
    let hasParams = false, hasInputs = false, hasMask = false;

    const num = (raw: string): number | null => {
      const t = raw.trim();
      if (!t) return null;                    // 清空 = 不写（别把空串当成 0）
      const v = Number(t);
      return Number.isFinite(v) ? v : null;
    };

    for (const [id, raw] of Object.entries(edits)) {
      if (id === 'name') patch.name = raw;
      else if (id === 'start') { const v = num(raw); if (v != null) patch.start = Math.max(0, v); }
      else if (id === 'duration') { const v = num(raw); if (v != null) patch.duration = Math.max(0.1, v); }
      else if (id === 'port') { const v = num(raw); if (v != null) pd.port = Math.max(0, Math.round(v)); }
      else if (id === 'segIndex') { const v = num(raw); if (v != null) pd.segIndex = Math.max(0, Math.round(v)); }
      else if (id === 'segCount') { const v = num(raw); if (v != null) pd.segCount = Math.max(1, Math.round(v)); }
      else if (id === 'kind') pd.kind = raw === 'preset' ? 'preset' : 'processor';
      else if (id === 'iface') {
        const idx = interfaces.findIndex(x => x.name === raw);
        if (idx >= 0) { pd.iface = raw; pd.ifaceNum = idx; pd.kind = 'processor'; }
      } else if (id === 'preset') {
        const set = presets.find(s => s.id === raw);
        if (set) { pd.presetId = set.id; pd.presetName = set.name; pd.kind = 'preset'; }
      } else if (id === 'extra') pd.extraPrompt = raw;
      else if (id === 'mask') {
        const tr = videoTracks.find(t => t.id === raw);
        pd.maskTrackId = tr?.id;
        pd.maskTrackName = tr?.name;
      } else if (id.startsWith('p:')) {
        params[id.slice(2)] = parseParam(raw);
        hasParams = true;
      } else if (id.startsWith('in:') || id.startsWith('mk:')) {
        const [prefix, key, field] = id.split(':');
        const bucket = prefix === 'in' ? inputs : maskInputs;
        const f = field as WinKey;
        const rec: Partial<ProcFrameWindow> = { ...(bucket[key] ?? {}) };
        if (f === 'file') rec.file = raw;
        else {
          const v = num(raw);
          if (v == null) continue;
          // 帧段字段都是整数帧号/帧数：f0 ≥ 0、n ≥ 1（fps 保留小数 —— 工程 fps 允许）。
          rec[f] = f === 'f0' ? Math.max(0, Math.round(v))
            : f === 'n' ? Math.max(1, Math.round(v))
            : v;
        }
        bucket[key] = rec;
        if (prefix === 'in') hasInputs = true; else hasMask = true;
      }
    }
    if (Object.keys(pd).length) patch.pending = pd;
    if (hasParams) patch.params = params;
    if (hasInputs) patch.inputs = inputs;
    if (hasMask) patch.maskInputs = maskInputs;
    return patch;
  };

  const apply = useCallback(() => {
    if (!editCount) return;
    onApply(buildPatch());
  }, [editCount, edits, onApply]);   // buildPatch 读的就是 edits

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.stopPropagation(); e.preventDefault(); apply(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [apply, onClose]);

  // ── 字段小件 ─────────────────────────────────────────────────────────────────────────────
  const textField = (label: string, id: string, mix: FieldMix, hint?: string, autoFocus?: boolean) => (
    <label style={S.field}>
      <span style={S.fieldLabel}>{label}{hint && <span style={S.hint}> {hint}</span>}</span>
      <input
        autoFocus={autoFocus}
        value={edits[id] ?? (mix.mixed ? '' : mix.value)}
        placeholder={mix.mixed ? '—' : ''}
        onChange={e => edit(id, e.target.value)}
        style={S.input}
      />
    </label>
  );

  const selectField = (
    label: string, id: string, mix: FieldMix,
    options: { value: string; label: string }[], hint?: string,
  ) => {
    const cur = edits[id] ?? (mix.mixed ? '__mixed' : mix.value);
    const missing = cur !== '__mixed' && !options.some(o => o.value === cur);
    const opts = missing ? [{ value: cur, label: cur === '' ? '—' : `${cur} (missing)` }, ...options] : options;
    return (
      <label style={S.field}>
        <span style={S.fieldLabel}>{label}{hint && <span style={S.hint}> {hint}</span>}</span>
        <select
          value={cur}
          onChange={e => {
            if (e.target.value === '__mixed') {
              setEdits(prev => { const n = { ...prev }; delete n[id]; return n; });
            } else edit(id, e.target.value);
          }}
          style={S.select}
        >
          {mix.mixed && <option value="__mixed">—</option>}
          {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
    );
  };

  const kindOptions = [{ value: 'processor', label: 'Processor' }, { value: 'preset', label: 'Pipeline Preset' }];
  const ifaceOptions = interfaces.map(x => ({ value: x.name, label: x.name }));
  const presetOptions = presets.map(s => ({ value: s.id, label: s.name }));
  const maskOptions = [{ value: '', label: 'None' }, ...videoTracks.map(t => ({ value: t.id, label: t.name }))];

  const params = paramKeys.map(key => {
    const def = paramDefOf(key);
    const mix = paramMix(key);
    const id = `p:${key}`;
    const label = def?.name ? `${def.name} · ${key}` : `Param ${key}`;
    const opts = (def?.options ?? []).map(o => ({ value: String(o), label: String(o) }));
    return (
      <div key={key} style={S.paramRow}>
        {opts.length
          ? selectField(label, id, mix, opts, def?.type)
          : textField(label, id, mix, def?.type)}
      </div>
    );
  });

  const winRows = (
    pick: (c: VidClip) => Record<string, ProcFrameWindow> | undefined,
    keys: string[], prefix: 'in' | 'mk', title: string,
  ) => (
    <div style={S.section}>
      <div style={S.sectionTitle}>{title}</div>
      {keys.length === 0 && <div style={S.empty}>No saved frame window in this selection.</div>}
      {keys.map(k => (
        <div key={k} style={S.winRow}>
          <span style={S.winKey}>Port {k}</span>
          {WIN_FIELDS.map(f => {
            const mix = winMix(pick, k, f.key);
            const id = `${prefix}:${k}:${f.key}`;
            return (
              <label key={f.key} style={S.winField}>
                <span style={S.winLabel}>{f.label}</span>
                <input
                  value={edits[id] ?? (mix.mixed ? '' : mix.value)}
                  placeholder={mix.mixed ? '—' : ''}
                  onChange={e => edit(id, e.target.value)}
                  style={{ ...S.input, ...(f.wide ? S.winWide : S.winNarrow) }}
                />
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.shell} onClick={e => e.stopPropagation()}>
        <div style={S.head}>
          <div style={{ minWidth: 0 }}>
            <div style={S.headTitle}>Placeholder settings</div>
            <div style={S.headSub}>
              {clips.length} placeholder{clips.length === 1 ? '' : 's'} · a field showing <b style={{ color: '#ffb340' }}>—</b> differs
              between them and stays as it is unless you edit it
            </div>
          </div>
        </div>

        <div style={S.body}>
          <div style={S.section}>
            <div style={S.sectionTitle}>Clip</div>
            <div style={S.grid}>
              {textField('Name', 'name', nameM, undefined, true)}
              {textField('Start', 'start', startM, 's')}
              {textField('Duration', 'duration', durationM, 's')}
            </div>
          </div>

          <div style={S.section}>
            <div style={S.sectionTitle}>Run snapshot</div>
            <div style={S.grid}>
              {selectField('Kind', 'kind', kindM, kindOptions)}
              {selectField('Interface', 'iface', ifaceM, ifaceOptions)}
              {selectField('Preset', 'preset', presetM, presetOptions)}
              {textField('Output port', 'port', portM)}
              {textField('Extra prompt', 'extra', extraM)}
              {selectField('Mask track', 'mask', maskM, maskOptions)}
              {textField('Segment index', 'segIndex', segIndexM)}
              {textField('Segment count', 'segCount', segCountM)}
            </div>
          </div>

          <div style={S.section}>
            <div style={S.sectionTitle}>Parameters</div>
            {paramKeys.length === 0 && <div style={S.empty}>No saved parameter values in this selection.</div>}
            {params}
          </div>

          {winRows(c => c.pending?.inputs, inputKeys, 'in', 'Input windows')}
          {winRows(c => c.pending?.maskInputs, maskKeys, 'mk', 'Mask window')}

          <div style={S.note}>
            Only the fields you edit are written. Frame windows are written per port, and only to the
            placeholders that actually have that port. Moving a placeholder does not move results
            already produced on the output track — run it again to land the new position.
          </div>
        </div>

        <div style={S.actions}>
          <button style={S.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            style={{ ...S.applyBtn, ...(editCount ? {} : S.applyBtnOff) }}
            disabled={!editCount}
            onClick={apply}
          >Apply{clips.length > 1 ? ` to ${clips.length}` : ''}</button>
        </div>
      </div>
    </div>
  );
};

const inputBase: React.CSSProperties = {
  padding: '5px 8px', fontSize: 12.5, boxSizing: 'border-box',
  background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.16)',
  borderRadius: 8, color: '#fff', outline: 'none', fontVariantNumeric: 'tabular-nums',
};

const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 9100,
    background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  shell: {
    width: 'min(720px, 94vw)', maxHeight: '88vh',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    background: '#141416', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 14,
    boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
    colorScheme: 'dark',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif",
  },
  head: { padding: '14px 18px 10px', flexShrink: 0 },
  headTitle: { fontSize: 14, fontWeight: 700, color: '#fff' },
  headSub: { fontSize: 11, color: 'rgba(255,255,255,0.42)', marginTop: 3, lineHeight: 1.5 },
  body: {
    padding: '2px 18px 14px', display: 'flex', flexDirection: 'column', gap: 10,
    overflowY: 'auto', minHeight: 0,
  },
  section: {
    borderTop: '0.5px solid rgba(255,255,255,0.08)', paddingTop: 10,
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  sectionTitle: {
    fontSize: 10.5, fontWeight: 700, color: 'rgba(255,255,255,0.5)',
    letterSpacing: 0.6, textTransform: 'uppercase',
  },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 },
  field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
  fieldLabel: { fontSize: 11, color: 'rgba(255,255,255,0.7)' },
  hint: { fontSize: 10, color: 'rgba(255,255,255,0.35)' },
  input: { ...inputBase, width: '100%' },
  select: {
    ...inputBase, width: '100%', color: 'rgba(255,255,255,0.85)',
    background: '#232327',
  },
  paramRow: { display: 'flex', alignItems: 'flex-end', gap: 10 },
  winRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  winKey: { fontSize: 11, fontWeight: 600, color: '#ffb340', minWidth: 52, flexShrink: 0 },
  winField: { display: 'flex', alignItems: 'center', gap: 4 },
  winLabel: { fontSize: 10, color: 'rgba(255,255,255,0.45)' },
  winNarrow: { width: 64, textAlign: 'right' },
  winWide: { width: 190, textAlign: 'left' },
  empty: { fontSize: 11, color: 'rgba(255,255,255,0.3)' },
  note: { fontSize: 10.5, color: 'rgba(255,255,255,0.42)', lineHeight: 1.55 },
  actions: {
    display: 'flex', justifyContent: 'flex-end', gap: 8,
    padding: '10px 18px 14px', borderTop: '0.5px solid rgba(255,255,255,0.08)', flexShrink: 0,
  },
  cancelBtn: {
    fontSize: 12, padding: '6px 14px', borderRadius: 8, cursor: 'pointer',
    background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.14)',
    color: 'rgba(255,255,255,0.7)',
  },
  applyBtn: {
    fontSize: 12, fontWeight: 600, padding: '6px 18px', borderRadius: 8, cursor: 'pointer',
    background: 'rgba(255,159,10,0.22)', border: '0.5px solid rgba(255,159,10,0.6)',
    color: '#fff',
  },
  applyBtnOff: { opacity: 0.35, cursor: 'default' },
};

export default PlaceholderSettingsModal;
