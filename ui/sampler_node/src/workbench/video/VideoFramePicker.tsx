import React, { useEffect, useRef, useState } from 'react';

/**
 * 视频资产拖到 Prompt 窗时，在主页面里弹出来挑一帧。
 *
 * 放在 sampler 页而不是 Prompt 窗里，是因为字节就在这一侧（同源、没有 CORS）：`<video src>`
 * 直接吃资产地址，canvas 也不被污染，`toBlob` 才拿得到帧。挑好的那一帧只作为字节交给
 * Prompt 窗去打标（见 assetDragBus 的 `sendTagBytesToPane`）。
 */

const STEP = 1 / 30; // 没有 fps 读数，按 30fps 走一帧 —— 够用来"精确一点点"

const VideoFramePicker: React.FC<{
  url: string;
  name?: string;
  /** 抓到一帧（JPEG）后交给调用方去投给 Prompt 窗。 */
  onCapture: (frame: Blob) => void | Promise<void>;
  onClose: () => void;
}> = ({ url, name, onCapture, onClose }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [dur, setDur] = useState(0);
  const [t, setT] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const seek = (next: number) => {
    const v = videoRef.current;
    if (!v) return;
    const clamped = Math.max(0, Math.min(dur > 0 ? dur - 0.001 : next, next));
    v.currentTime = clamped;
    setT(clamped);
  };

  const capture = async () => {
    const v = videoRef.current;
    if (!v) return;
    setBusy(true);
    setErr(null);
    try {
      const w = v.videoWidth || 1280;
      const h = v.videoHeight || 720;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas unavailable');
      ctx.drawImage(v, 0, 0, w, h);
      const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.94));
      if (!blob) throw new Error('frame encode failed');
      await onCapture(blob);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.shell} onClick={e => e.stopPropagation()}>
        <div style={S.head}>
          <div style={S.headTitle}>Capture a frame</div>
          <div style={S.headSub}>
            {name ? name : 'Video'} · pick the frame to tag, then capture it
          </div>
        </div>

        <div style={S.body}>
          <video
            ref={videoRef}
            src={url}
            controls
            playsInline
            preload="auto"
            onLoadedMetadata={e => {
              const d = e.currentTarget.duration;
              setDur(Number.isFinite(d) ? d : 0);
            }}
            onTimeUpdate={e => setT(e.currentTarget.currentTime)}
            style={S.video}
          />

          <div style={S.scrubRow}>
            <button style={S.stepBtn} onClick={() => seek(t - STEP)} title="Previous frame">◀</button>
            <input
              type="range"
              min={0}
              max={Math.max(0.001, dur)}
              step={0.001}
              value={Math.min(t, Math.max(0.001, dur))}
              disabled={!dur}
              onChange={e => seek(Number(e.target.value))}
              style={S.range}
            />
            <button style={S.stepBtn} onClick={() => seek(t + STEP)} title="Next frame">▶</button>
            <span style={S.time}>
              {t.toFixed(2)}s{dur ? ` / ${dur.toFixed(2)}s` : ''}
            </span>
          </div>

          {err
            ? <div style={S.error}>{err}</div>
            : <div style={S.note}>Pause on the frame you want, then capture it to tag it into the Prompt window.</div>}
        </div>

        <div style={S.actions}>
          <button style={S.cancelBtn} onClick={onClose}>Cancel</button>
          <button style={{ ...S.applyBtn, ...(busy ? S.applyBtnOff : {}) }} disabled={busy} onClick={() => void capture()}>
            {busy ? 'Capturing…' : 'Capture & Tag'}
          </button>
        </div>
      </div>
    </div>
  );
};

const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 9100,
    background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  shell: {
    width: 'min(860px, 94vw)', maxHeight: '90vh',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    background: '#141416', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 14,
    boxShadow: '0 24px 80px rgba(0,0,0,0.6)', colorScheme: 'dark',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif",
  },
  head: { padding: '14px 18px 10px', flexShrink: 0 },
  headTitle: { fontSize: 14, fontWeight: 700, color: '#fff' },
  headSub: { fontSize: 11, color: 'rgba(255,255,255,0.42)', marginTop: 3, lineHeight: 1.5 },
  body: { padding: '2px 18px 14px', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 },
  video: { width: '100%', maxHeight: '60vh', background: '#000', borderRadius: 10, display: 'block' },
  scrubRow: { display: 'flex', alignItems: 'center', gap: 8 },
  stepBtn: {
    fontSize: 11, padding: '4px 8px', borderRadius: 7, cursor: 'pointer',
    background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.14)',
    color: 'rgba(255,255,255,0.75)',
  },
  range: { flex: 1, minWidth: 0 },
  time: {
    fontSize: 11, color: 'rgba(255,255,255,0.55)', minWidth: 96, textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
  },
  note: { fontSize: 10.5, color: 'rgba(255,255,255,0.42)', lineHeight: 1.55 },
  error: { fontSize: 11, color: '#ff8a80' },
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
    background: 'rgba(10,132,255,0.28)', border: '0.5px solid rgba(10,132,255,0.7)',
    color: '#fff',
  },
  applyBtnOff: { opacity: 0.4, cursor: 'default' },
};

export default VideoFramePicker;
