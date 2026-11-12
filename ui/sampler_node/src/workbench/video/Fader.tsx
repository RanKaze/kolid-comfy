import React from 'react';
import {
  audioAudible, audioTrackGain, setAudioTrackGain, type VidController,
} from './model';

// ── Fader 窗 ────────────────────────────────────────────────────────────────────────────────
// 每条**音频轨**一根推子，用来把几条轨的声音压到同一个平衡上（人声 / 环境 / 配乐）。
//
// 增益写进工程的 `audioGain`（trackId → 线性 0..1，缺省 = 1）：它是混音的唯一来源，
// 随 .cud / 页面存档走，播放时由 pcmClips 落在引擎的 pcm_set 上（见 model 的 setAudioTrackGain）。
// 推子**只衰减不放大**，几条轨叠在一起也不会因为某一条被推过 0 dB 而削波；mute / solo 仍优先
// —— 被静音或被 solo 排除的轨，推子再高也不响（行会变暗，值照常保留）。
//
// 双击推子回到 100%（单位增益）；这里不改段子、不切片子，也不碰波形。

const dbText = (gain: number): string => {
  if (!(gain > 1e-4)) return '−∞ dB';
  const db = 20 * Math.log10(gain);
  return (db > -0.05 ? '0.0' : db.toFixed(1)) + ' dB';
};

export const VidFader: React.FC<{ vid: VidController }> = ({ vid }) => {
  const p = vid.project;
  const tracks = p.tracks.filter(t => t.kind === 'audio');
  const mute = new Set(p.muteIds ?? []);
  const solo = new Set(p.soloAudioIds ?? []);
  const anySolo = solo.size > 0;

  const setGain = (id: string, name: string, v: number) =>
    vid.update(prev => setAudioTrackGain(prev, id, v), 'Fader · ' + name);

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      background: '#0f0f11', overflow: 'auto', scrollbarWidth: 'thin',
    }}>
      {tracks.length === 0 && (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 16, fontSize: 10.5, lineHeight: 1.8, textAlign: 'center',
          color: 'rgba(255,255,255,0.3)',
        }}>
          No audio tracks yet — drop an audio file onto the timeline's audio lane.
        </div>
      )}
      {tracks.map(t => {
        const gain = audioTrackGain(p, t.id);
        const muted = mute.has(t.id);
        const soloed = solo.has(t.id);
        const audible = audioAudible(t.id, solo, mute);
        // solo 状态只作为附注显示（切换仍归轨头那颗 S）：这里不复制一份可能走岔的控制。
        const note = muted ? 'muted' : (anySolo && !soloed ? 'solo elsewhere' : soloed ? 'solo' : '');
        return (
          <div key={t.id} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 10px', borderBottom: '0.5px solid rgba(255,255,255,0.06)',
            opacity: audible ? 1 : 0.42,
          }}>
            <div style={{ width: 112, flexShrink: 0, minWidth: 0 }}>
              <div title={t.name} style={{
                fontSize: 10.5, color: 'rgba(255,255,255,0.78)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{t.name}</div>
              {note && (
                <div style={{ fontSize: 8.5, letterSpacing: 0.3, textTransform: 'uppercase', color: 'rgba(255,255,255,0.34)' }}>
                  {note}
                </div>
              )}
            </div>
            <div style={{ flex: 1, minWidth: 40, display: 'flex', alignItems: 'center' }}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={gain}
                onChange={e => setGain(t.id, t.name, Number(e.target.value))}
                onDoubleClick={() => setGain(t.id, t.name, 1)}
                title="Double-click to reset to 100%"
                style={{ width: '100%', height: 14, margin: 0, accentColor: '#5b9cf5', cursor: 'pointer' }}
              />
            </div>
            <div style={{
              width: 74, flexShrink: 0, textAlign: 'right', fontSize: 9.5,
              fontVariantNumeric: 'tabular-nums', color: 'rgba(255,255,255,0.55)',
            }}>
              {dbText(gain)}
              <span style={{ color: 'rgba(255,255,255,0.28)', marginLeft: 4 }}>
                {Math.round(gain * 100)}%
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
};
