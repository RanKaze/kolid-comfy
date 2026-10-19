import React, { useCallback, useEffect, useState } from 'react';

/**
 * VidSegModal —— Allow List 视频路跑之前的**输入范围 + 分段帧数**配置。
 *
 * 视频模式下 Processor 的 Run 由宿主接手（Blend 页那边没有视频工程）：每个 image/mask
 * 输入按 Processor 窗里挑的源解析出一段源窗口（锚 = 第一行输入的源），按帧抽成一列，
 * 接口按 list_mode 跑，产物按挑的去处落位。大视频按段跑 —— 每段独立抽帧/执行/编码，
 * 峰值内存只由单段帧数决定。
 *
 * 这个 modal 是每次运行的那一次配置，两件事都由用户拍板：
 * 1. **输入范围**：源可能横跨 5–30s，但只想喂其中 6–8s —— 按**锚的时间线秒数**填入点/
 *    出点（锚的跨度就标在上面），内部取整到帧网格（fps 可能不是整数，秒数不对齐会抽出
 *    半帧）。产物落在新轨上、起点对齐入点。
 * 2. **每段帧数**：段的大小是内存与耗时的直接权衡（一列 float32 帧动辄几百 MB）。
 *
 * 范围夹在锚的跨度内，出点必须晚于入点（至少 1 帧）。帧数夹在 [1, 150]：150 是单段
 * 内存预算的上限，填更大没有意义（后端也会夹）；填 0 / 空 / 非法回到默认 30。
 * 范围总帧数上限 36000（≈20 分钟 @30fps），超了禁用 Run。
 */

const SEG_MAX_FRAMES = 150;
const SEG_DEFAULT = 30;
const SEG_TOTAL_CAP = 36000;

const fmt = (v: number): string => String(Math.round(v * 100) / 100);
const parseSec = (text: string, fallback: number): number => {
  const v = Number(text);
  return Number.isFinite(v) ? v : fallback;
};

const VidSegModal: React.FC<{
  anchorName: string;
  anchorKind: 'clip' | 'asset';
  spanStart: number;
  spanDuration: number;
  total: number;
  fps: number;
  /** 默认入点（时间线秒）。preset 路的"游标下的片段"要从游标处起跑；不传 = 段的开头。 */
  defaultIn?: number;
  /** 标题/说明：processor 与 preset 共用同一套"范围 + 分段"的形体，只有抬头不同。 */
  title?: string;
  subtitle?: string;
  note?: string;
  /** 源选择（preset 专用：preset 没有输入口，源必须每次由用户挑 —— Tracks / Sel. Track /
   *  Asset，与 Processor 窗那三颗同一个语义）。不传 = 不给这一块（processor 的源在窗里挑）。 */
  sources?: {
    kind: 'tracks' | 'sel_track' | 'asset';
    trackId: string;
    assetId: string;
    tracks: { id: string; name: string }[];
    assets: { id: string; name: string }[];
    onChange: (next: { kind: 'tracks' | 'sel_track' | 'asset'; trackId: string; assetId: string }) => void;
  };
  onRun: (segFrames: number, inFrame: number, outFrame: number) => void;
  onClose: () => void;
}> = ({ anchorName, anchorKind, spanStart, spanDuration, total, fps, defaultIn, title, subtitle, note, sources, onRun, onClose }) => {
  const spanEnd = spanStart + spanDuration;
  const [segText, setSegText] = useState(String(Math.min(SEG_DEFAULT, total)));
  const [inText, setInText] = useState(() => fmt(
    defaultIn != null && Number.isFinite(defaultIn)
      ? Math.min(spanEnd, Math.max(spanStart, defaultIn))
      : spanStart));
  const [outText, setOutText] = useState(() => fmt(spanEnd));

  // 入点/出点：解析失败回退整段；夹在锚的跨度内。
  const inSec = Math.min(spanEnd, Math.max(spanStart, parseSec(inText, spanStart)));
  const outSec = Math.min(spanEnd, Math.max(spanStart, parseSec(outText, spanEnd)));
  // 取整到帧网格（秒数不对齐会抽出半帧），范围 = [inFrame, outFrame) 帧。
  // 出点再夹到 total：秒数文本是两位小数（fmt），33.685s 显示成 33.69 再 round 回帧
  // 会比源多出一帧 —— 向上取整出的范围源覆盖不了，跑到一半才炸。
  const inFrame = Math.max(0, Math.min(total - 1, Math.round((inSec - spanStart) * fps)));
  const outFrame = Math.min(total, Math.round((outSec - spanStart) * fps));
  const rangeFrames = Math.max(0, outFrame - inFrame);
  const rangeOk = rangeFrames >= 1 && rangeFrames <= SEG_TOTAL_CAP;

  const parsed = Math.round(Number(segText));
  const segFrames = Number.isFinite(parsed) && parsed >= 1
    ? Math.min(SEG_MAX_FRAMES, parsed)
    : SEG_DEFAULT;
  const nSegs = Math.max(1, Math.ceil(rangeFrames / segFrames));
  const segSecs = segFrames / fps;

  const run = useCallback(() => {
    if (rangeOk) onRun(segFrames, inFrame, outFrame);
  }, [rangeOk, onRun, segFrames, inFrame, outFrame]);

  const resetRange = useCallback(() => {
    setInText(fmt(spanStart));
    setOutText(fmt(spanEnd));
  }, [spanStart, spanEnd]);

  // Esc 关闭；Enter（在输入框里）确认。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      else if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); run(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, run]);

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.shell} onClick={e => e.stopPropagation()}>
        {/* ── 头部 ── */}
        <div style={S.head}>
          <div style={{ minWidth: 0 }}>
            <div style={S.headTitle}>{title || 'Run processor on video'}</div>
            <div style={S.headSub}>{subtitle || "Allow List · a range of the first input's source, processed in segments"}</div>
          </div>
        </div>

        {/* ── 片段信息 ── */}
        <div style={S.body}>
          {/* 源：preset 没有输入口，喂哪段视频是每次运行的事（三颗与 Processor 窗同一语义）。 */}
          {sources && (
            <div style={S.srcRow} data-vid-seg-src="">
              <span style={S.fieldLabel}>Source</span>
              {([['tracks', 'Tracks'], ['sel_track', 'Sel. Track'], ['asset', 'Asset']] as const).map(([k, label]) => (
                <button
                  key={k}
                  data-vid-seg-src-kind={k}
                  onClick={() => sources.onChange({ ...sources, kind: k })}
                  style={{ ...S.srcBtn, ...(sources.kind === k ? S.srcBtnOn : {}) }}
                >{label}</button>
              ))}
              {sources.kind === 'sel_track' && (
                <select
                  data-vid-seg-src-track=""
                  value={sources.trackId}
                  onChange={e => sources.onChange({ ...sources, trackId: e.target.value })}
                  style={S.srcSel}
                >
                  <option value="">Topmost track</option>
                  {sources.tracks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
              {sources.kind === 'asset' && (
                <select
                  data-vid-seg-src-asset=""
                  value={sources.assetId}
                  onChange={e => sources.onChange({ ...sources, assetId: e.target.value })}
                  style={S.srcSel}
                >
                  <option value="">Newest video asset</option>
                  {sources.assets.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              )}
            </div>
          )}
          <div style={S.clipBlock}>
            <div style={S.clipName} title={anchorName}>{anchorName}</div>
            <div style={S.clipMeta}>
              {fmt(spanStart)}s–{fmt(spanEnd)}s{anchorKind === 'clip' ? ' on the timeline' : ' in the source'} · {total} frames @ {fps}fps
            </div>
          </div>

          {/* ── 输入范围（时间线秒数）── */}
          <div style={S.sectionHead}>
            <span style={S.fieldLabel}>Input range</span>
            <button style={S.resetBtn} onClick={resetRange}>Full clip</button>
          </div>
          <div style={S.fieldRow}>
            <label style={S.fieldLabel} htmlFor="vid-seg-in">In</label>
            <input
              id="vid-seg-in"
              type="number"
              step={0.1}
              value={inText}
              autoFocus
              onChange={e => setInText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); run(); } }}
              style={S.input}
            />
            <span style={S.fieldHint}>s</span>
            <label style={{ ...S.fieldLabel, marginLeft: 12 }} htmlFor="vid-seg-out">Out</label>
            <input
              id="vid-seg-out"
              type="number"
              step={0.1}
              value={outText}
              onChange={e => setOutText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); run(); } }}
              style={S.input}
            />
            <span style={S.fieldHint}>s</span>
          </div>

          {/* ── 范围预览 ── */}
          <div style={S.preview}>
            → <b style={{ color: rangeOk ? '#fff' : '#ff6961' }}>{rangeFrames}</b> frames
            {' '}· {(rangeFrames / fps).toFixed(1)}s
            <span style={{ opacity: 0.55 }}>
              {' '}({fmt(spanStart + inFrame / fps)}s–{fmt(spanStart + outFrame / fps)}s)
            </span>
            {!rangeOk && (
              <span style={{ color: '#ff6961' }}>
                {rangeFrames < 1 ? ' — out must be after in' : ` — over the ${SEG_TOTAL_CAP}-frame cap`}
              </span>
            )}
          </div>

          {/* ── 每段帧数 ── */}
          <div style={S.fieldRow}>
            <label style={S.fieldLabel} htmlFor="vid-seg-frames">Frames per segment</label>
            <input
              id="vid-seg-frames"
              type="number"
              min={1}
              max={SEG_MAX_FRAMES}
              value={segText}
              onChange={e => setSegText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); run(); } }}
              style={S.input}
            />
            <span style={S.fieldHint}>1–{SEG_MAX_FRAMES}</span>
          </div>

          {/* ── 分段结果预览 ── */}
          <div style={S.preview}>
            → <b style={{ color: nSegs === 1 ? '#30d158' : '#fff' }}>{nSegs}</b>
            {' '}segment{nSegs === 1 ? '' : 's'}
            <span style={{ opacity: 0.55 }}>
              {nSegs === 1 ? ' (single pass)' : ` · about ${segSecs.toFixed(1)}s each`}
            </span>
          </div>

          {/* ── 口径说明 ── */}
          <div style={S.note}>
            {note || `Each segment runs as its own pass — frames are extracted from the selected range, the
            processor runs on the column, and the results encode back to video. The segments land
            back-to-back on a new track, starting at the in-point. Frame-to-frame state (temporal
            nodes) does not carry across segment boundaries.`}
          </div>
        </div>

        {/* ── 动作 ── */}
        <div style={S.actions}>
          <button style={S.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            style={{ ...S.runBtn, ...(rangeOk ? {} : S.runBtnOff) }}
            disabled={!rangeOk}
            onClick={run}
          >Run</button>
        </div>
      </div>
    </div>
  );
};

const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 9000,
    background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28,
  },
  shell: {
    width: 'min(460px, 92vw)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    background: '#141416', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 14,
    boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
    colorScheme: 'dark',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif",
  },
  head: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    padding: '14px 18px 10px', flexShrink: 0,
  },
  headTitle: { fontSize: 14, fontWeight: 700, color: '#fff' },
  headSub: { fontSize: 11, color: 'rgba(255,255,255,0.42)', marginTop: 2 },
  body: { padding: '4px 18px 14px', display: 'flex', flexDirection: 'column', gap: 12 },
  clipBlock: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  clipName: {
    fontSize: 12, color: 'rgba(255,255,255,0.8)', fontWeight: 600,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  clipMeta: { fontSize: 11, color: 'rgba(255,255,255,0.5)', fontVariantNumeric: 'tabular-nums' },
  sectionHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  srcRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  srcBtn: {
    fontSize: 11, padding: '3px 9px', borderRadius: 6, cursor: 'pointer',
    background: 'rgba(255,255,255,0.05)', border: '0.5px solid rgba(255,255,255,0.14)',
    color: 'rgba(255,255,255,0.6)',
  },
  srcBtnOn: { background: 'rgba(10,132,255,0.22)', border: '0.5px solid rgba(10,132,255,0.6)', color: '#fff' },
  srcSel: {
    fontSize: 11, padding: '3px 6px', borderRadius: 6, maxWidth: 190,
    background: '#232327', color: 'rgba(255,255,255,0.8)',
    border: '0.5px solid rgba(255,255,255,0.14)',
  },
  fieldRow: { display: 'flex', alignItems: 'center', gap: 10 },
  fieldLabel: { fontSize: 12, color: 'rgba(255,255,255,0.75)', flexShrink: 0 },
  input: {
    width: 84, padding: '5px 8px', fontSize: 13, textAlign: 'right',
    background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.16)',
    borderRadius: 8, color: '#fff', outline: 'none', fontVariantNumeric: 'tabular-nums',
  },
  fieldHint: { fontSize: 10.5, color: 'rgba(255,255,255,0.35)' },
  resetBtn: {
    fontSize: 10.5, padding: '2px 9px', borderRadius: 6, cursor: 'pointer',
    background: 'transparent', border: '0.5px solid rgba(255,255,255,0.16)',
    color: 'rgba(255,255,255,0.55)',
  },
  preview: {
    fontSize: 12.5, color: 'rgba(255,255,255,0.85)',
    background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.09)',
    borderRadius: 8, padding: '7px 11px',
  },
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
  runBtn: {
    fontSize: 12, fontWeight: 600, padding: '6px 18px', borderRadius: 8, cursor: 'pointer',
    background: 'rgba(10,132,255,0.25)', border: '0.5px solid rgba(10,132,255,0.6)',
    color: '#fff',
  },
  runBtnOff: { opacity: 0.35, cursor: 'default' },
};

export default VidSegModal;
