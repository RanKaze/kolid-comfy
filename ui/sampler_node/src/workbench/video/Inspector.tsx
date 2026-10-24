import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fmtTime } from './model';
import { ensureWaveform } from './previews';
import { audioCtx } from './audio';
import { acquireAudioSlot, buildStereoProbe, releaseAudioSlot, type AudioProbe } from './audioFocus';

// 媒体元素源一个元素只能建一次(createMediaElementSource 二次调用会抛)—— 探头按元素记。
const elemProbes = new WeakMap<HTMLVideoElement, AudioProbe>();
const probeFor = (v: HTMLVideoElement): AudioProbe => {
  let p = elemProbes.get(v);
  if (!p) {
    p = buildStereoProbe(audioCtx().createMediaElementSource(v));
    elemProbes.set(v, p);
  }
  return p;
};

// ── Inspector ───────────────────────────────────────────────────────────────────────────────
// Assets 窗里"当前选中"的那一件,在这里放大看:视频/音频/图片三种都收。视频与音频的播放
// 用**自己的**播放头 —— 窗底一条独立的 lane,与主播放器(Player/时间线)的 transport 互不
// 相识:主时间线在播什么、Inspector 就只是自己播自己的,一扇"看素材"的窗,不是第二台放
// 映机。播放头直改 DOM(填充宽/线位/时间读数),rAF 只在播着的时候转 —— 与时间线那条红
// 线同一套手法,不进 React 渲染图。

/** Assets 窗点击卡片产生的"选中"载荷 —— Inspector 的全部输入。它是**选中那一刻的数据
 *  快照**,不是资产的活引用:之后资产改名/删除,Inspector 保持原样,直到选中被撤(卡片
 *  消失 / 文档关闭时 Assets 与宿主会把它清掉)。 */
export type InspectSel = {
  /** 与 Assets 卡片同一套键:'p:<id>'(工程资产)/ 's:<hash|name>'(仓库条目)。 */
  key: string;
  name: string;
  kind: 'image' | 'video' | 'audio';
  /** 可播/可显示 URL:工程资产优先仓库地址,仓库条目走 playHash 代理(Assets 同一口径)。 */
  src: string;
  /** 元数据里的时长(s),可能为 0 / 不准 —— 播放头全程以 <video> 自己读到的为准。 */
  duration: number;
  hasAudio: boolean | null;
  origin?: string;
  hash?: string;
  size?: number;
};

const KIND_CHIP: Record<InspectSel['kind'], { label: string; color: string; bg: string }> = {
  image: { label: 'IMG', color: '#0a84ff', bg: 'rgba(10,132,255,0.18)' },
  video: { label: 'VID', color: '#ff9f0a', bg: 'rgba(255,159,10,0.16)' },
  audio: { label: 'AUD', color: '#30d158', bg: 'rgba(48,209,88,0.16)' },
};

const bytesOf = (n?: number): string =>
  n == null ? '' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';

const ctlBtn: React.CSSProperties = {
  flexShrink: 0, width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'none', border: 'none', borderRadius: 5, color: 'rgba(255,255,255,0.72)',
  cursor: 'pointer', padding: 0,
};
const ctlBtnOff: React.CSSProperties = { ...ctlBtn, color: 'rgba(255,255,255,0.26)' };

export const VidInspector: React.FC<{ sel: InspectSel | null }> = ({ sel }) => {
  const vref = useRef<HTMLVideoElement | null>(null);
  const laneRef = useRef<HTMLDivElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const lineRef = useRef<HTMLDivElement | null>(null);
  const readRef = useRef<HTMLSpanElement | null>(null);
  const raf = useRef(0);
  const laneDrag = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(true);
  /** 音量(0..1)与滑块浮层:悬浮喇叭按钮才浮出,拖动直接写 <video>.volume。 */
  const [volume, setVolume] = useState(1);
  const [volOpen, setVolOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [imgDim, setImgDim] = useState<string | null>(null);
  const [wave, setWave] = useState<string | null>(null);

  const durOf = (v: HTMLVideoElement): number =>
    Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;

  // 音量/静音直写元素:React 类型不带 volume 属性,且换资产重挂 <video> 后也要重新落一遍。
  useEffect(() => {
    const v = vref.current;
    if (!v) return;
    v.volume = volume;
    v.muted = muted;
  }, [volume, muted, sel]);

  // 播放头三件套(填充/线/读数)一次写完 —— rAF 与 seek 共用同一口。
  const paint = useCallback((t: number, total: number) => {
    const f = total > 0 ? Math.max(0, Math.min(1, t / total)) : 0;
    if (fillRef.current) fillRef.current.style.width = (f * 100) + '%';
    if (lineRef.current) lineRef.current.style.left = (f * 100) + '%';
    if (readRef.current) readRef.current.textContent = `${fmtTime(t)} / ${fmtTime(total)}`;
  }, []);

  const tick = useCallback(() => {
    const v = vref.current;
    if (v) paint(v.currentTime, durOf(v));
    raf.current = requestAnimationFrame(tick);
  }, [paint]);
  const startRaf = () => { if (!raf.current) raf.current = requestAnimationFrame(tick); };
  const stopRaf = () => { if (raf.current) { cancelAnimationFrame(raf.current); raf.current = 0; } };
  useEffect(() => stopRaf, []);
  // 窗被切走(unmount)时槽也得让出来 —— 声音归零不等于槽空着。
  useEffect(() => () => releaseAudioSlot('inspector'), []);

  // 换资产:停表、归零、清面板,并把音频槽让出来(它属于"上一个资产的那次播放")。
  // 图片没有 <video>(vref 悬空,守卫都接得住)。
  useEffect(() => {
    releaseAudioSlot('inspector');
    setErr(null); setImgDim(null); setWave(null); setPlaying(false);
    stopRaf();
    const v = vref.current;
    if (v) { try { v.pause(); } catch { /* 还没起播 */ } try { v.currentTime = 0; } catch { /* 元数据未到 */ } }
    paint(0, 0);
    if (sel?.kind === 'audio' && sel.src) {
      let alive = true;
      void ensureWaveform(sel.src).then(u => { if (alive) setWave(u); });
      return () => { alive = false; };
    }
  }, [sel, paint]);

  const toggle = () => {
    const v = vref.current;
    if (!v || sel?.kind === 'image') return;
    if (v.paused) void v.play().catch(() => setErr('Playback failed — the browser cannot decode this stream (try relinking or transcoding it in Assets).'));
    else v.pause();
  };

  const seekAt = useCallback((clientX: number) => {
    const v = vref.current, el = laneRef.current;
    if (!v || !el) return;
    const r = el.getBoundingClientRect();
    const total = durOf(v);
    if (r.width <= 0 || total <= 0) return;
    const t = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * total;
    try { v.currentTime = Math.min(t, Math.max(0, total - 0.05)); } catch { /* 这一段还没缓存到:下一次 move 再来 */ }
    paint(v.currentTime, total);
  }, [paint]);
  const onLaneDown = (e: React.PointerEvent) => {
    if (sel?.kind === 'image') return;
    e.preventDefault();
    laneDrag.current = true;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 指针已失活/合成事件:不挡手势 */ }
    seekAt(e.clientX);
  };
  const onLaneMove = (e: React.PointerEvent) => { if (laneDrag.current) seekAt(e.clientX); };
  const onLaneUp = () => { laneDrag.current = false; };

  if (!sel) {
    return (
      // dock 对 fullBleed 单元的 body 包装是 display:block(定高)—— 填满它用 height:100%,
      // 不是 flex:1(block 父级里 flex 无效,会塌成内容高,画面区跟着归零)。
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', fontSize: 11, color: 'rgba(255,255,255,0.35)', lineHeight: 1.9, background: '#0f0f11' }}>
        No asset selected — click a card in the Assets window.<br />Video, audio and image all inspect here, each with its own playhead.
      </div>
    );
  }
  const chip = KIND_CHIP[sel.kind];
  const isImg = sel.kind === 'image';

  return (
    // 根:height:100% 填满 dock 的 body 包装(block 定高),骨架是"头部 / 画面区 / 底条"
    // 三段列 —— 画面区 flex:1 独吃余量与收缩,头尾两段 flexShrink:0 永远完整。
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0f0f11', overflow: 'hidden' }}>
      {/* 头部:类型章 + 名字 + 元信息一行。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', flexShrink: 0, borderBottom: '0.5px solid rgba(255,255,255,0.08)' }}>
        <span style={{ flexShrink: 0, fontSize: 8, fontWeight: 800, letterSpacing: 0.3, color: chip.color, background: chip.bg, border: `0.5px solid ${chip.color}80`, borderRadius: 3, padding: '1px 4px', lineHeight: 1.3 }}>{chip.label}</span>
        <span title={sel.name} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.82)' }}>{sel.name}</span>
        <span style={{ flexShrink: 0, fontSize: 9, color: 'rgba(255,255,255,0.30)', whiteSpace: 'nowrap' }}>
          {[sel.origin, sel.hash ? sel.hash.slice(0, 8) + '…' : '', bytesOf(sel.size)].filter(Boolean).join(' · ') || '—'}
        </span>
      </div>

      {/* 画面区:大小**只由 dock 分给这扇窗的空间决定**(flex:1 吃满 header 与底条之间),
          媒体一律绝对定位 + contain —— 宽、高两个方向都 fit 进窗:任何比例/分辨率的媒体都
          只会信箱式缩放在这块里,竖版左右出黑边、横版上下出黑边,窗不会被撑大、画面不会被裁。
          minHeight:0 让它在窗变矮时独吃收缩(header/底条 flexShrink:0,永远完整可见)。 */}
      <div key={sel.key} style={{ flex: 1, minHeight: 0, position: 'relative', background: '#000', overflow: 'hidden' }}>
        {isImg ? (
          <img
            src={sel.src} alt={sel.name}
            onError={() => setErr('This image cannot be loaded — the bytes are missing from the asset store (relink it in Assets).')}
            onLoad={e => setImgDim(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}px`)}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
          />
        ) : (
          <>
            <video
              ref={vref} src={sel.src} playsInline preload="metadata" muted={muted} loop={loop}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', display: sel.kind === 'audio' ? 'none' : 'block' }}
              onLoadedMetadata={() => { const v = vref.current; if (v) paint(v.currentTime, durOf(v)); }}
              // ── 独占音频槽 ── 起播即申请(被抢占的旧声源在自己的 onRevoked 里 pause);
              // 暂停/播完释放。探头按元素记(createMediaElementSource 每元素只许一次)。
              onPlay={() => {
                setPlaying(true);
                startRaf();
                const v = vref.current;
                if (v) acquireAudioSlot(
                  { id: 'inspector', label: 'Inspector — ' + sel.name, probe: probeFor(v) },
                  () => { try { v.pause(); } catch { /* 已经停了 */ } },
                );
              }}
              onPause={() => { setPlaying(false); stopRaf(); releaseAudioSlot('inspector'); }}
              onEnded={() => { setPlaying(false); stopRaf(); releaseAudioSlot('inspector'); }}
              // 暂停中的 seek 也得 repaint 一帧:timeupdate 就是那趟车(rAF 只在播时转)。
              onTimeUpdate={() => { if (!raf.current) { const v = vref.current; if (v) paint(v.currentTime, durOf(v)); } }}
              onError={() => setErr('The browser cannot play this stream (container/codec unsupported) — relink or transcode it in Assets.')}
            />
            {sel.kind === 'audio' && (
              wave
                ? <img src={wave} alt="waveform" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', opacity: 0.9, pointerEvents: 'none' }} />
                : <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>Generating waveform…</span>
            )}
          </>
        )}
        {err && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, textAlign: 'center', fontSize: 11, color: '#ff8a80', background: 'rgba(15,15,17,0.86)', lineHeight: 1.8 }}>{err}</div>
        )}
      </div>

      {/* ── 独立播放头:窗底一条 lane,与主播放器互不相干。图片没有"播"这回事,
          底条换成尺寸/字节那句实话。 */}
      {isImg ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px', height: 26, flexShrink: 0, borderTop: '0.5px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)', fontSize: 9.5, color: 'rgba(255,255,255,0.35)' }}>
          {imgDim ?? 'reading size…'}{sel.size != null ? ` · ${bytesOf(sel.size)}` : ''}
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 8px', height: 32, flexShrink: 0, borderTop: '0.5px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)' }}>
          <button title={playing ? 'Pause (Inspector playback is independent of the main player)' : 'Play (Inspector playback is independent of the main player)'} onClick={toggle} style={ctlBtn}>
            {playing ? (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="1" y="1" width="2.6" height="8" rx="0.6" /><rect x="6.4" y="1" width="2.6" height="8" rx="0.6" /></svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M1.6 0.8 8.8 5 1.6 9.2z" /></svg>
            )}
          </button>
          <span ref={readRef} style={{ flexShrink: 0, minWidth: 78, fontSize: 9.5, color: 'rgba(255,255,255,0.55)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>0:00.0 / 0:00.0</span>
          {/* lane:底轨 + 已播填充 + 红色播放头(与时间线那条红线同一张脸),按下/拖动 = seek。 */}
          <div
            ref={laneRef}
            onPointerDown={onLaneDown} onPointerMove={onLaneMove} onPointerUp={onLaneUp} onPointerCancel={onLaneUp}
            title="Independent playhead — click or drag to seek this asset"
            style={{ flex: 1, minWidth: 0, position: 'relative', height: 20, cursor: 'pointer', touchAction: 'none' }}
          >
            <div style={{ position: 'absolute', left: 0, right: 0, top: 9, height: 2, borderRadius: 1, background: 'rgba(255,255,255,0.14)' }} />
            <div ref={fillRef} style={{ position: 'absolute', left: 0, top: 9, height: 2, borderRadius: 1, width: 0, background: '#0a84ff' }} />
            <div ref={lineRef} style={{ position: 'absolute', left: 0, top: 4, width: 1.5, height: 12, background: '#ff453a', transform: 'translateX(-50%)', boxShadow: '0 0 3px rgba(0,0,0,0.55)' }} />
          </div>
          {/* 喇叭按钮 + 悬停音量滑块:浮层是悬停区(按钮外套)的子节点 —— 指针从按钮挪进
              浮层不会中途离开悬停区,浮层底部那 6px 视觉缝隙画在它自己的 padding 里,
              命中面连续,不会"挪过去就消失"。音量与静音互不覆盖:静音只压 <video>.muted。 */}
          {sel.hasAudio !== false && (
            <div
              onPointerEnter={() => setVolOpen(true)}
              onPointerLeave={() => setVolOpen(false)}
              style={{ position: 'relative', flexShrink: 0, display: 'flex' }}
            >
              <button title={muted ? 'Unmute (hover for the volume slider)' : 'Mute (hover for the volume slider)'} onClick={() => setMuted(m => !m)} style={muted ? ctlBtnOff : ctlBtn}>
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1.8 4.4h1.9L6.4 2.2v7.6L3.7 7.6H1.8z" fill="currentColor" stroke="none" />
                  {muted
                    ? <path d="M8.2 4.6l2.6 2.8M10.8 4.6 8.2 7.4" />
                    : <><path d="M8.3 4.1a2.6 2.6 0 0 1 0 3.8" /><path d="M9.7 2.8a4.5 4.5 0 0 1 0 6.4" /></>}
                </svg>
              </button>
              {volOpen && (
                <div style={{
                  position: 'absolute', bottom: '100%', right: -7, paddingBottom: 7,
                  display: 'flex', alignItems: 'center', gap: 6, zIndex: 12,
                }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '6px 9px',
                    background: 'rgba(40,40,44,0.97)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
                    border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: 8,
                    boxShadow: '0 6px 22px rgba(0,0,0,0.5)',
                  }}>
                    <input
                      type="range" min={0} max={1} step={0.01} value={volume}
                      onChange={e => setVolume(Math.max(0, Math.min(1, +e.target.value)))}
                      title={`Volume ${Math.round(volume * 100)}%`}
                      style={{ width: 92, accentColor: '#0a84ff', height: 14, cursor: 'pointer' }}
                    />
                    <span style={{ flexShrink: 0, fontSize: 9, color: 'rgba(255,255,255,0.55)', fontVariantNumeric: 'tabular-nums', minWidth: 24, textAlign: 'right' }}>{Math.round(volume * 100)}</span>
                  </div>
                </div>
              )}
            </div>
          )}
          <button title={loop ? 'Loop on — click to play once' : 'Loop off — click to repeat'} onClick={() => setLoop(l => !l)} style={loop ? ctlBtn : ctlBtnOff}>
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.4 6.4V5a2.3 2.3 0 0 1 2.3-2.3h4.7" />
              <path d="M8.2 1.5l1.4 1.2-1.4 1.2" />
              <path d="M9.6 5.6V7a2.3 2.3 0 0 1-2.3 2.3H2.6" />
              <path d="M3.8 8.1 2.4 9.3l1.4 1.2" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
};
