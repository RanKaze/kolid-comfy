import React, { useEffect, useState } from 'react';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';

const numInput: React.CSSProperties = {
  width: 62, padding: '3px 6px', borderRadius: 6, textAlign: 'right',
  background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.16)',
  color: 'rgba(255,255,255,0.88)', fontSize: 11, fontVariantNumeric: 'tabular-nums',
  outline: 'none',
};
const cap: React.CSSProperties = {
  fontSize: 10.5, color: 'rgba(255,255,255,0.45)', letterSpacing: 0.3, flexShrink: 0,
};

const CanvasBody: React.FC<WorkbenchUnitProps> = ({ send, host }) => {
  const ui = useBlendUi();
  const sized = !!(ui.canvas.w && ui.canvas.h);
  const video = host.video;

  // 两个输入框是**受控草稿**：打字时不能每一键就改一次画布（每次都要重采样整份图层）。
  // 回车 / 失焦才提交；提交后页面播回来的 canvas.w/h 才是真值。
  const [w, setW] = useState('');
  const [h, setH] = useState('');
  const [fps, setFps] = useState('');
  useEffect(() => { setW(ui.canvas.w ? String(ui.canvas.w) : ''); }, [ui.canvas.w]);
  useEffect(() => { setH(ui.canvas.h ? String(ui.canvas.h) : ''); }, [ui.canvas.h]);
  useEffect(() => { setFps(String(video.fps)); }, [video.fps]);

  const commitSize = () => {
    const nw = Math.round(Number(w) || 0), nh = Math.round(Number(h) || 0);
    if (nw < 1 || nh < 1) {
      setW(ui.canvas.w ? String(ui.canvas.w) : '');
      setH(ui.canvas.h ? String(ui.canvas.h) : '');
      return;
    }
    if (nw === ui.canvas.w && nh === ui.canvas.h) return;
    send('canvas-resize', { w: nw, h: nh });
  };
  const commitFps = () => {
    const n = Math.round(Number(fps) || 0);
    if (n >= 1) video.setFps(n); else setFps(String(video.fps));
  };
  const onKey = (fn: () => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.currentTarget.blur(); fn(); }
    if (e.key === 'Escape') { e.currentTarget.blur(); }
  };

  // ── Video 模式 ── 画布分辨率在这里仍然可改（它同时就是视频的输出栅格：Layer Track 把帧
  // 送进图层系统合成时用的就是这块画布），并多一颗帧率 —— 帧率住在 Video 工程里，随 .cud 存。
  if (video.mode === 'video') {
    return (
      <div style={{ ...wbStyles.row, gap: 5 }}>
        <span style={{ ...cap, width: 62 }}>Frame</span>
        <input value={w} placeholder={sized ? '' : 'auto'} inputMode="numeric"
          onChange={e => setW(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={commitSize} onKeyDown={onKey(commitSize)}
          title="Output width in pixels — the same canvas the layer system composites on"
          style={numInput} />
        <span style={cap}>×</span>
        <input value={h} placeholder={sized ? '' : 'auto'} inputMode="numeric"
          onChange={e => setH(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={commitSize} onKeyDown={onKey(commitSize)}
          title="Output height in pixels — the same canvas the layer system composites on"
          style={numInput} />
        <span style={{ ...cap, marginLeft: 8 }}>FPS</span>
        <input value={fps} inputMode="numeric"
          onChange={e => setFps(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={commitFps} onKeyDown={onKey(commitFps)}
          title="Output frame rate — the time grid Layer Tracks sample on (frame n sits at n / fps)"
          style={{ ...numInput, width: 46 }} />
      </div>
    );
  }

  return (
    <div style={wbStyles.row}>
      <button style={wbStyles.btn}
        title={'Set a fixed canvas resolution. Until you set one the canvas follows the bottom layer; '
          + 'image files can also be dropped onto the canvas to become layers.'}
        onClick={() => send('canvas-size')}>
        {sized ? `${ui.canvas.w} × ${ui.canvas.h}` : 'Canvas Size…'}
      </button>
      <button style={{ ...wbStyles.btn, ...(ui.mode === 'canvasModify' ? wbStyles.btnOn : null), ...(sized ? null : wbStyles.btnOff) }}
        disabled={!sized}
        title={'Modify — drag the canvas border to resize it. Smart layers keep their pixels '
          + '(top-left anchored); raster layers resample to the new canvas. Enter applies, Esc cancels.'}
        onClick={() => send('canvas-modify')}>Modify</button>
    </div>
  );
};

export const canvasUnit: WorkbenchUnit = {
  // 两种模式下都是画布设置本体：Image 模式调的是"图层画布"，Video 模式调的同一块东西
  // （它就是输出栅格）+ 一颗帧率。
  id: 'canvas',
  title: 'Canvas',
  hint: 'The canvas keeps its resolution while layers come and go. Until you set one by hand it grows '
    + 'to fit the largest layer at its native resolution, so placed images are never resampled. '
    + 'In Video mode the same canvas is the output frame size, and the frame rate sits beside it.',
  Body: CanvasBody,
};
