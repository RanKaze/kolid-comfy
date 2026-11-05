import React from 'react';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';
import { useVidProcRun } from './video/procRun';

// Detector 那一格。页面原来整节 `display:none` 到 blend-config 说 detector 输入真的接上了为止 ——
// dock 里一格不能凭空出现或消失（panels 是固定集），所以没接上时这一格给一句空态，说清它为什么是空的。
// 小窗那三颗控件（prompt / threshold / invert）住的仍是页面：这里摆的是它们的镜像，每次落值都发动作键
// 回去 —— 与画布那几格同一套边界。
// Detect 那一颗看模式分两条路：
//   Image : 只是开页面那口对话框（选源与落位的活还在页面自己那口 modal 里）；
//   Video : 选源由这一格自己摆（Video / Sel. Video Track / Sel. Video Segment），跑的事交给宿主
//           （`host.video.detect.run` —— 取帧、分段、落新轨、绑 Mask track 都只有宿主知道）。

const PROMPT_TITLE = 'Mask expression, e.g. \'(face:0.4)&(hair:0.3)-mouth\'. Operators (left-to-right): & intersect, '
  + '+ union, - subtract, | union. Terms: name, name:0.3, name(0.3). Functions: max(a,b,…), min(a,b,…), '
  + 'grow(x,n) — n>0 dilates, n<0 erodes. Statements \';\' or newline separated; \'x = expr\' then reuse x.';

const VSRC_TITLE = 'Whole timeline = every visible frame, Layer composites included. '
  + 'Sel. Video Track = every segment on one track. Sel. Video Segment = the one segment selected on the timeline.';

const DetectorBody: React.FC<WorkbenchUnitProps> = ({ send, host }) => {
  const ui = useBlendUi();
  const d = ui.detector;
  // Video 分支的选源：UI 自己的选择（不随 .cud 走，也不进快照 —— 它不是工程的一部分）。
  const [source, setSource] = React.useState<'video' | 'sel_track' | 'sel_segment'>('video');
  const [trackId, setTrackId] = React.useState('');
  const run = useVidProcRun();
  if (!d.available) {
    return (
      <div style={wbStyles.note}>
        No detector is connected to the node — the Detector tool has nothing to do until one is wired into its
        detector input.
      </div>
    );
  }
  const videoMode = host.video.mode === 'video';
  const det = host.video.detect;
  const tracks = det.tracks;
  // 下拉里的当前值：存的那条还在就用它，否则落到第一条（新工程 / 轨道被删之后不摆一条空下拉）。
  const effTrack = trackId && tracks.some(t => t.id === trackId) ? trackId : (tracks[0]?.id || '');
  const busy = run.state === 'running';
  const canRun = source === 'video' || (source === 'sel_track' ? !!effTrack : !!det.sel);
  return (
    <div style={{ ...wbStyles.stack, padding: 4 }}>
      <textarea style={wbStyles.area} rows={3} spellCheck={false}
        // 不设 value：文字每敲一下都要跨一次 iframe 边界，受控输入会被迟到的快照把光标顶回行尾、
        // 甚至吞掉一个字符。prompt 只有这一处作者，页面那一侧存的是它的真值，所以初值给一次就够。
        defaultValue={d.prompt} placeholder="e.g. (face:0.4)&(hair:0.3)-mouth" title={PROMPT_TITLE}
        onChange={e => send('detector-prompt', e.target.value)} />
      <div style={wbStyles.ctrl}>
        <label style={wbStyles.ctrlLabel}>Threshold</label>
        <input style={wbStyles.slider} type="range" min={0} max={1} step={0.01} value={d.threshold}
          title="Confidence threshold used by terms without an explicit one — write 'face:0.3' to override it per term"
          onChange={e => send('detector-threshold', parseFloat(e.target.value))} />
        <span style={wbStyles.value}>{d.threshold.toFixed(2)}</span>
      </div>
      <div style={wbStyles.ctrl}>
        <label style={wbStyles.ctrlLabel}>Invert</label>
        <span style={{ flex: '1 1 0' }} />
        <input style={wbStyles.check} type="checkbox" checked={d.invert}
          title="Flip the final mask (1 - mask): what the detector found becomes the hole, everything else the coverage"
          onChange={e => send('detector-invert', e.target.checked)} />
      </div>
      {videoMode && (
        <>
          <div style={wbStyles.ctrl}>
            <label style={wbStyles.ctrlLabel}>Source</label>
            <select style={wbStyles.select} value={source} title={VSRC_TITLE}
              onChange={e => setSource(e.target.value as 'video' | 'sel_track' | 'sel_segment')}>
              <option value="video">Video — whole timeline</option>
              <option value="sel_track">Sel. Video Track</option>
              <option value="sel_segment">Sel. Video Segment</option>
            </select>
          </div>
          {source === 'sel_track' && (
            <div style={wbStyles.ctrl}>
              <label style={wbStyles.ctrlLabel}>Track</label>
              <select style={wbStyles.select} value={effTrack} disabled={!tracks.length}
                onChange={e => setTrackId(e.target.value)}>
                {tracks.length
                  ? tracks.map(t => (
                    <option key={t.id} value={t.id}>{t.kind === 'layer' ? `${t.name} · Layer` : t.name}</option>
                  ))
                  : <option value="">No tracks</option>}
              </select>
            </div>
          )}
          {source === 'sel_segment' && (
            <div style={wbStyles.note}>
              {det.sel
                ? `Selected: 「${det.sel.name}」 (${det.sel.kind === 'layer' ? 'Layer' : 'video'})`
                : 'Select exactly one video or Layer segment on the timeline.'}
            </div>
          )}
        </>
      )}
      <div style={{ display: 'flex', gap: 4 }}>
        <button type="button" style={{ ...wbStyles.btn, flex: 1, justifyContent: 'center', opacity: (videoMode && (!canRun || busy)) ? 0.45 : 1 }}
          disabled={videoMode && (!canRun || busy)}
          title={videoMode
            ? 'Detect the chosen source frame by frame — the mask lands on a new Detect track and becomes the Mask track'
            : 'Open the Detect dialog — pick where the detector looks and where the mask lands'}
          onClick={() => {
            if (videoMode) {
              det.run({
                source, trackId: source === 'sel_track' ? effTrack : undefined,
                prompt: d.prompt, threshold: d.threshold, invert: d.invert,
              });
            } else {
              send('detector-run');
            }
          }}>{busy ? 'Detecting…' : 'Detect'}</button>
      </div>
      {videoMode && run.state !== 'idle' && (
        <div style={{ ...wbStyles.note, color: run.state === 'error' ? '#ff453a' : undefined }}>{run.msg}</div>
      )}
    </div>
  );
};

export const detectorUnit: WorkbenchUnit = {
  id: 'detector',
  title: 'Detector',
  hint: 'Detector — runs the detector connected to the node’s detector input and turns what it finds into a mask.',
  Body: DetectorBody,
};
