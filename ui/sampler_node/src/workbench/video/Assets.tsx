import React, { useState } from 'react';
import {
  type VidController, fmtTime, isAudioName, isVideoName, addAsset, newVidId, removeAsset,
} from './model';
import { probeMedia } from './audio';

// ── Assets 窗（资产库）───────────────────────────────────────────────────────────────────────
// 时间线的素材都住这里：拖图池条目 / 本地文件进来 = 收一件资产（同 src 只留一份）；把资产行
// 拖到 Tracks 的某条轨上 = 落一段引用它的片段 —— 同一源泉多次复用也只是多几段引用，不复制数据。
// 资产跟着 VidProject 持久化（blob: 的本地图活不过刷新，读档时自会剪掉）。

const STAGING_ITEM_TYPE = 'application/x-blend-staging';

const rowBtn: React.CSSProperties = {
  flexShrink: 0, width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'none', border: 'none', borderRadius: 4, color: 'rgba(255,255,255,0.4)', cursor: 'pointer', padding: 0,
};

export const VidAssets: React.FC<{ vid: VidController }> = ({ vid }) => {
  const { project: p } = vid;
  const [over, setOver] = useState(false);

  // 收一件资产：探测是异步的 —— 量时长、辨音视频，同 src 的货只留一份。
  const collect = async (src: string, name: string, origin: 'staging' | 'file') => {
    const info = await probeMedia(src, isAudioName(name) ? 'audio' : 'video');
    if (!info) return;
    vid.update(proj => addAsset(proj, {
      id: newVidId('as'),
      name, src, origin,
      kind: info.audioOnly ? 'audio' : 'video',
      duration: info.duration, hasAudio: info.hasAudio,
    }));
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const sid = e.dataTransfer.getData(STAGING_ITEM_TYPE);
    if (sid) {
      const item = vid.staging.find(s => s.id === sid);
      if (item) { void collect(item.src, item.name || sid, 'staging'); return; }
    }
    for (const f of Array.from(e.dataTransfer.files || [])) {
      const ok = f.type.startsWith('video/') || f.type.startsWith('audio/') || isVideoName(f.name) || isAudioName(f.name);
      if (!ok) continue;
      void collect(URL.createObjectURL(f), f.name, 'file');
    }
  };

  return (
    <div
      onDragOver={e => { const ts = e.dataTransfer.types; if (ts.includes(STAGING_ITEM_TYPE) || Array.from(ts).includes('Files')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(o => (o ? false : o))}
      onDrop={onDrop}
      style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#141416', minWidth: 0, overflow: 'hidden' }}
    >
      {/* 头一条：入库提示。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '0.5px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
        <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.45)', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          Drag videos/audio here — then drag rows onto Tracks
        </span>
      </div>

      {/* 资产列表：行可拖（application/x-vid-asset），✕ 扔掉（时间线里已落地的片段不受影响）。 */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', scrollbarWidth: 'thin', background: over ? 'rgba(10,132,255,0.06)' : 'transparent' }}>
        {p.assets.length === 0 && (
          <div style={{ padding: 16, fontSize: 11, color: 'rgba(255,255,255,0.35)', textAlign: 'center', lineHeight: 1.8 }}>
            No assets yet.<br />Drop video/audio files here, or drag items in from Staging.
          </div>
        )}
        {p.assets.map(a => (
          <div
            key={a.id}
            draggable
            onDragStart={e => { e.dataTransfer.setData('application/x-vid-asset', a.id); e.dataTransfer.effectAllowed = 'copy'; }}
            title={`${a.name} — ${fmtTime(a.duration)} · drag onto a track to place a clip that references this asset`}
            style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 8px', borderBottom: '0.5px solid rgba(255,255,255,0.05)', cursor: 'grab', userSelect: 'none' }}
          >
            <span style={{ fontSize: 9, color: a.kind === 'video' ? '#64d2ff' : '#30d158', flexShrink: 0 }}>
              {a.kind === 'video' ? '▣' : '♪'}
            </span>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.8)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
            <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.45)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{fmtTime(a.duration)}</span>
            <button
              title={'Remove asset 「' + a.name + '」 from the library (clips already on the timeline keep playing)'}
              onClick={() => vid.update(proj => removeAsset(proj, a.id))}
              style={rowBtn}
            >
              <svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M3 3l6 6M9 3l-6 6" /></svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
