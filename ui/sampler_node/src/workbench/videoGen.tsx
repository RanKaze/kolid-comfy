import React, { useState } from 'react';
import { wbStyles } from './skin';
import { VIDEO_GEN_SLOTS } from '../types';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';
import { useVidProcRun } from './video/procRun';

// Video Generator 这一格：**声明好的那几台生成器**在这里挑一台、往 process 轨上摆一段。
// 它原来住在 Processor 窗里，现在单独占一扇窗 —— 两件事不是一件事：Processor 是"拿图层跑
// 一次离线处理"，Video Generator 是"在时间线上占一段时间、跑完吐一段片子"。摆段之后的所有
// 配置都在**段上**做（提示词按钮、左右两枚首末帧槽、中间的 ▶ Run、齿轮里那套参数），
// 这一格只负责"挑哪一台"和"在哪儿落一段"（落点是播放头 —— 只有宿主知道播放头在哪）。
//
// 这一格不认识端口，也不认识任何具体接口：它读的是宿主按 Interface tab 里那份绑定算出来的
// 一台台生成器（名字 + 八个槽各绑了哪个端口 + 还缺哪几个必绑槽），所以接口换了端口、改了名字，
// 这一格不用改。

const VideoGenBody: React.FC<WorkbenchUnitProps> = ({ host }) => {
  const list = host.video.videoGen.list;
  const videoMode = host.video.mode === 'video';
  // 挑中的那台只在这一格里记（它是"这一格现在指着谁"，不是工程事实）。
  const [pick, setPick] = useState(0);
  // 摆段那一步的成败由宿主写进这条播报（播放头处被占、必绑槽没绑齐都从这里说出来）。
  const run = useVidProcRun();
  const cur = list[pick] || list[0];

  return (
    <div style={{ ...wbStyles.stack, padding: 4 }}>
      {list.length === 0 ? (
        <div style={wbStyles.note}>
          No video generator yet — turn Video Generator mode on for an interface in the Interface tab
          and bind its ports (width / height / duration are the ones it cannot run without).
        </div>
      ) : (
        <>
          <div style={wbStyles.ctrl}>
            <label style={wbStyles.ctrlLabel}>Generator</label>
            <select style={wbStyles.select} value={pick}
              title="Which Video Generator interface to place — every interface with Video Generator mode on in the Interface tab"
              onChange={e => setPick(Number(e.target.value))}>
              {list.map((g, i) => (
                <option key={g.name + i} value={i} style={{ background: '#1c1c1e', color: '#fff' }}>
                  {g.name}{g.ready ? '' : ' — bind its ports first'}
                </option>
              ))}
            </select>
          </div>

          <div style={{ ...wbStyles.row, marginTop: 2 }}>
            <button type="button"
              style={{ ...wbStyles.btn, ...(cur.ready && videoMode ? null : wbStyles.btnOff) }}
              disabled={!cur.ready || !videoMode}
              title={!videoMode
                ? 'Segments live on the video timeline — switch the Workbench window to Video mode first (Image / Video on its title bar).'
                : cur.ready
                  ? 'Place a video generator segment at the playhead — its length starts from the duration port’s value, and the finished clip lands on the output track at that position.'
                  : `This generator still has unbound ports (${cur.missing.join(', ')}) — bind them in the Interface tab first.`}
              onClick={() => host.video.videoGen.add(cur.index)}>Add segment</button>
          </div>

          {/* 这一台现在绑成什么样：八个槽一行一枚，没绑的写 — 。必绑而没绑的那几枚标橙。 */}
          <div style={wbStyles.readout}>
            {VIDEO_GEN_SLOTS.filter(s => !(s.key === 'fps' && cur.fixed_fps)).map(s => {
              const n = cur.ports[s.key] ?? 0;
              const bad = !!s.required && n <= 0;
              return (
                <span key={s.key} style={{
                  display: 'inline-block', marginRight: 8,
                  color: bad ? '#ff9f0a' : (n > 0 ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.25)'),
                }} title={s.tip}>
                  {s.label} {n > 0 ? `value${n}` : '—'}
                </span>
              );
            })}
            {cur.fixed_fps && (
              <span style={{ color: 'rgba(255,255,255,0.55)' }}
                title="Fixed FPS is on — this generator has one declared output frame rate, and the fps port is not used at all.">
                fps {Number(cur.fixed_fps_value) > 0 ? cur.fixed_fps_value : 16} (fixed)
              </span>
            )}
          </div>

          {/* 摆段那一步的回话（宿主写的那一条）：槽没绑齐、落点被占都从这里说出来。 */}
          {run.state !== 'idle' && (
            <div style={{
              fontSize: 11, marginTop: 2, padding: '4px 8px', borderRadius: 6,
              color: run.state === 'error' ? '#ff6961'
                : run.state === 'done' ? '#30d158'
                : run.state === 'cancelled' ? '#ffd60a' : 'rgba(255,255,255,0.65)',
              background: run.state === 'error' ? 'rgba(255,69,58,0.10)'
                : run.state === 'done' ? 'rgba(48,209,88,0.10)'
                : run.state === 'cancelled' ? 'rgba(255,214,10,0.10)' : 'rgba(255,255,255,0.05)',
            }}>{run.msg}</div>
          )}

          <div style={wbStyles.note}>
            A segment keeps its own length — the clip a generator hands back does not have to match the
            project frame rate, and the timeline does not resample it. Run it from the ▶ on the segment
            itself; the result lands on the output track above it, in place.
          </div>
        </>
      )}
    </div>
  );
};

export const videoGenUnit: WorkbenchUnit = {
  id: 'videoGen',
  title: 'Video Generator',
  hint: 'Video Generator — places a segment for an interface that has Video Generator mode on (Interface tab). '
    + 'Pick one and it lands at the playhead; its length comes from the duration port. The segment itself carries '
    + 'the first/last frame cards on its edges, the gear (every value, prompt included) and the ▶ that runs it — '
    + 'the finished clip lands on the output track at that position, whatever frame rate the generator used.',
  Body: VideoGenBody,
};
