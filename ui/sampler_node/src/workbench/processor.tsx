import React from 'react';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import type { BlendProcChoice, BlendProcInRow, BlendProcParamRow } from '../types';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';
import { useVidProcRun } from './video/procRun';
import { setVidProcAsset, setVidProcDst, setVidProcSrc, setVidProcTrack, useVidProcPicks, type VidProcDst, type VidProcSrc } from './video/procPicks';

// Processor 那一格：把 Interface tab 里开了 Processor 模式的 interface 当离线图像处理器跑 —— pipeline
// 的当前图不动，输入按行收集、输出按行落位。行不是写死的：页面按所选 interface 的端口现拼一份**描述
// 符**（哪几段、每行是什么控件、候选有哪几枚），这里照着摆。所以这一格不认识端口、也不认识图层 ——
// 它只把每一颗控件的落值发回动作键，值本身仍由页面按"拧过没有"那一套算（见 procParamValue）。
// 视频模式（Allow List 开着）例外：候选整表换成视频那一套（Tracks / Sel. Track / Asset、New Track /
// Asset），挑选值住在宿主自己的 store（video/procPicks）—— Blend 页那张源表不认识视频，页面快照里
// 的 cur 在这一模式下被无视。

/** 视频模式的输入源：Tracks = 游标底下最上面那条视频轨的片段；Sel. Track = 挑一条轨；
 *  Asset = 资产库里挑一件（从头起喂）。 */
const VID_SRC_TABLE: BlendProcChoice[] = [
  { value: 'tracks', label: 'Tracks', tip: 'The video clip under the playhead — topmost track wins when several stack up.' },
  { value: 'sel_track', label: 'Sel. Track', tip: 'A video track picked below — the clip under the playhead on it feeds this input.' },
  { value: 'asset', label: 'Asset', tip: 'A video from the asset library picked below — it feeds from its head for the chosen range.' },
];
/** 视频模式的输出去处：New Track = 新开一条轨落位；Asset = 只入资产库、时间线不动。 */
const VID_DST_TABLE: BlendProcChoice[] = [
  { value: 'new_track', label: 'New Track', tip: 'The result lands as a new video on a new track, aligned to the input range.' },
  { value: 'asset', label: 'Asset', tip: 'The result is added to the asset library — nothing is placed on the timeline.' },
];

/** 一枚分段按钮：来源 / 落位那些行就是这一串。选中的那颗点亮，说明进 title。 */
const ChoiceGroup: React.FC<{
  options: BlendProcChoice[]; cur: string;
  onPick: (value: string) => void; title?: string;
}> = ({ options, cur, onPick, title }) => (
  <div style={wbStyles.miniGroup} title={title}>
    {options.map(o => (
      <button key={o.value} type="button"
        style={{ ...wbStyles.btn, ...(o.value === cur ? wbStyles.btnOn : null) }}
        title={o.tip || undefined}
        onClick={() => onPick(o.value)}>{o.label}</button>
    ))}
  </div>
);

/** 参数那一行：控件跟着类型走，与页面 renderProcessorRows 的 paramRow 一字不差的分流。
 *  number / text 不给 value：文字每敲一下都要跨一次 iframe 边界，受控输入会被迟到的快照顶回旧值；
 *  页面那一侧存的是真值，取值变了（Reset、换 interface）由页面重拼描述符、键跟着换、这一段重挂。 */
const ParamControl: React.FC<{ row: BlendProcParamRow; onSet: (v: number | string | boolean) => void }> =
  ({ row, onSet }) => {
    if (row.kind === 'bool') {
      return (
        <input style={wbStyles.check} type="checkbox" checked={row.on}
          title={row.tip} onChange={e => onSet(e.target.checked)} />
      );
    }
    if (row.kind === 'number') {
      return (
        <input key={`${row.num}:${row.value}`} style={wbStyles.input} type="number"
          step={row.step || undefined} defaultValue={row.value} placeholder={row.placeholder}
          title={row.tip} onChange={e => onSet(e.target.value === '' ? '' : Number(e.target.value))} />
      );
    }
    if (row.kind === 'choices') {
      return (
        <div style={wbStyles.miniGroup} title={row.tip}>
          {row.options.map(o => (
            <button key={o.value} type="button"
              style={{ ...wbStyles.btn, ...(o.value === row.cur ? wbStyles.btnOn : null) }}
              title={o.tip || undefined}
              onClick={() => onSet(o.value)}>{o.label}</button>
          ))}
        </div>
      );
    }
    if (row.kind === 'select') {
      return (
        <select style={wbStyles.select} value={row.cur} title={`Which value ${row.name} takes this run`}
          onChange={e => onSet(e.target.value)}>
          {row.options.map(o => (
            <option key={o.value} value={o.value} style={{ background: '#1c1c1e', color: '#fff' }}>{o.label}</option>
          ))}
        </select>
      );
    }
    return (
      <input key={`${row.num}:${row.value}`} style={wbStyles.input} type="text"
        defaultValue={row.value} placeholder={row.placeholder} title={row.tip}
        onChange={e => onSet(e.target.value)} />
    );
  };

const ProcessorBody: React.FC<WorkbenchUnitProps> = ({ send, host }) => {
  const ui = useBlendUi();
  const p = ui.processor;
  const none = p.names.length === 0;
  // Allow List + 视频模式：输入/输出的候选**整表**换成视频那一套 —— 图像模式那张源表
  // （Layers / Sel. Layer / Asset）在视频模式下没有意义：画布被播放器盖着，图层也不是
  // 用户眼里的东西。挑选值住在宿主 store（video/procPicks），不经 Blend 页。
  const videoMode = host.video.mode === 'video';
  const vidTables = videoMode && p.allowList;
  const vidPicks = useVidProcPicks();
  const vidSrcOf = (row: BlendProcInRow): VidProcSrc =>
    (vidPicks.src[String(row.num)] || 'tracks') as VidProcSrc;
  const vidDstOf = (row: { num: number }): VidProcDst =>
    (vidPicks.dst[String(row.num)] || 'new_track') as VidProcDst;
  const vidRun = useVidProcRun();
  const vidBusy = vidRun.state === 'running';
  return (
    <div style={{ ...wbStyles.stack, padding: 4 }}>
      <div style={wbStyles.ctrl}>
        <label style={wbStyles.ctrlLabel}>Interface</label>
        <select style={wbStyles.select} value={none ? '' : String(p.choice)} disabled={none}
          title="Which processor-mode interface to run — the list is every interface with Processor mode on in the Interface tab"
          onChange={e => {
            const i = Number(e.target.value);
            if (!Number.isFinite(i) || i < 0 || i >= p.names.length) return;
            // 发身份而不是位置：位置随开关 Processor 模式的接口增删会漂，名字会撞，包下标不会。
            const index = p.indices[i];
            send('processor-interface',
              Number.isFinite(index) && index >= 0 ? { index, name: p.names[i] } : i);
          }}>
          {none
            ? <option value="">— none —</option>
            : p.names.map((name, i) => (
              <option key={i} value={String(i)} style={{ background: '#1c1c1e', color: '#fff' }}>{name}</option>
            ))}
        </select>
      </div>

      {none && (
        <div style={wbStyles.note}>
          No processor interface yet — turn Processor mode on for one in the Interface tab.
        </div>
      )}

      {/* 三段的行序就是页面 group() 的调用序：Inputs、Parameters、Outputs；空段不出现。 */}
      {p.inputs.length > 0 && (
        <div style={wbStyles.groupHead}>Inputs</div>
      )}
      {p.inputs.map(row => {
        const vidSrc = vidTables ? vidSrcOf(row) : undefined;
        return (
          <React.Fragment key={row.num}>
            <div style={wbStyles.ctrl}>
              <label style={wbStyles.ctrlLabel}>{row.name}</label>
              <ChoiceGroup
                options={vidTables ? VID_SRC_TABLE : row.options}
                cur={vidSrc ?? row.cur} title={row.hint}
                onPick={value => vidTables
                  ? setVidProcSrc(row.num, value as VidProcSrc)
                  : send('processor-pick', { side: 'in', port: row.num, value })} />
            </div>
            {/* Sel. Track / Asset 挑中后多一行下拉：轨道清单与资产清单都是宿主的工程事实。 */}
            {vidTables && vidSrc === 'sel_track' && (
              <div style={wbStyles.ctrl}>
                <span style={{ ...wbStyles.ctrlLabel, width: 'auto' }} />
                <select style={wbStyles.select}
                  value={vidPicks.track[String(row.num)] || (host.video.tracks[0] ? host.video.tracks[0].id : '')}
                  disabled={host.video.tracks.length === 0}
                  title="Which video track feeds this input — the clip under the playhead on it"
                  onChange={e => setVidProcTrack(row.num, e.target.value)}>
                  {host.video.tracks.length === 0
                    ? <option value="">— no video tracks —</option>
                    : host.video.tracks.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                </select>
              </div>
            )}
            {vidTables && vidSrc === 'asset' && (
              <div style={wbStyles.ctrl}>
                <span style={{ ...wbStyles.ctrlLabel, width: 'auto' }} />
                <select style={wbStyles.select}
                  value={vidPicks.asset[String(row.num)] || (host.video.assets[0] ? host.video.assets[0].id : '')}
                  disabled={host.video.assets.length === 0}
                  title="Which video asset feeds this input — it plays from its head for the chosen range"
                  onChange={e => setVidProcAsset(row.num, e.target.value)}>
                  {host.video.assets.length === 0
                    ? <option value="">— asset library is empty —</option>
                    : host.video.assets.map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                </select>
              </div>
            )}
            {/* 图像模式的 Assets 条目选择（页面拼的描述符，视频模式下不出现）。 */}
            {!vidTables && row.asset && (
              <div style={wbStyles.ctrl}>
                <span style={{ ...wbStyles.ctrlLabel, width: 'auto' }} />
                <select style={wbStyles.select} value={row.asset.cur} disabled={row.asset.options.length === 0}
                  title="Which asset feeds this input — its bytes are read straight from the store by hash"
                  onChange={e => send('processor-asset', { port: row.num, hash: e.target.value })}>
                  {row.asset.options.length === 0
                    ? <option value="">— asset store has no images —</option>
                    : row.asset.options.map(o => (
                      <option key={o.id} value={o.id} style={{ background: '#1c1c1e', color: '#fff' }}>{o.name}</option>
                    ))}
                </select>
              </div>
            )}
          </React.Fragment>
        );
      })}

      {p.params.length > 0 && (
        <div style={wbStyles.groupHead}>Parameters</div>
      )}
      {p.params.map(row => (
        <div key={row.num} style={wbStyles.ctrl}>
          <label style={wbStyles.ctrlLabel}>{row.name}</label>
          <ParamControl row={row} onSet={v => send('processor-param', { port: row.num, value: v })} />
        </div>
      ))}

      {p.outputs.length > 0 && (
        <div style={wbStyles.groupHead}>Outputs</div>
      )}
      {p.outputs.map(row => (
        <div key={row.num} style={wbStyles.ctrl}>
          <label style={wbStyles.ctrlLabel}>{row.name}</label>
          <ChoiceGroup
            options={vidTables ? VID_DST_TABLE : row.options}
            cur={vidTables ? vidDstOf(row) : row.cur} title={row.hint}
            onPick={value => vidTables
              ? setVidProcDst(row.num, value as VidProcDst)
              : send('processor-pick', { side: 'out', port: row.num, value })} />
        </div>
      ))}

      <div style={{ ...wbStyles.row, marginTop: 2 }}>
        <button type="button" style={wbStyles.btn}
          title="Forget every value typed in this window — each parameter goes back to the value the graph carries"
          onClick={() => send('processor-reset')}>Reset values</button>
        <button type="button" style={{ ...wbStyles.btn, ...(none || vidBusy ? wbStyles.btnOff : null) }} disabled={none || vidBusy}
          title="Run the chosen processor offline — inputs are gathered per the rows above, results land per each output row"
          onClick={() => send('processor-run')}>Run</button>
      </div>

      {/* 视频 list 跑的状态：这一趟是宿主自己发的（抽帧 → 逐段执行 → 编码回视频），
          Blend 页那条状态栏在视频模式下被播放器盖着，所以反馈落在这扇窗里；进度条与 Cancel
          走的是原本那一条（文档窗标题条的 RunStatusSeg，宿主写同一份快照），这里只补文字。 */}
      {vidRun.state !== 'idle' && (
        <div style={{
          fontSize: 11, marginTop: 4, padding: '4px 8px', borderRadius: 6,
          color: vidRun.state === 'error' ? '#ff6961'
            : vidRun.state === 'done' ? '#30d158'
            : vidRun.state === 'cancelled' ? '#ffd60a' : 'rgba(255,255,255,0.65)',
          background: vidRun.state === 'error' ? 'rgba(255,69,58,0.10)'
            : vidRun.state === 'done' ? 'rgba(48,209,88,0.10)'
            : vidRun.state === 'cancelled' ? 'rgba(255,214,10,0.10)' : 'rgba(255,255,255,0.05)',
        }}>{vidRun.msg}</div>
      )}

      {/* Allow List 开着时的口径说明：一行进是一列、输出也是列；视频模式下整表换视频候选。 */}
      {p.allowList && !none && (
        <div style={wbStyles.note}>
          Allow List is on — image/mask inputs go in as a whole column and outputs come back as a
          column. Internal nodes that are INPUT_IS_LIST take the column directly; the rest run once
          per frame and the results merge back into a column.
          {videoMode ? ' In video mode the source and destination rows switch to video: Tracks / Sel. Track / Asset in, New Track / Asset out. Before each run a dialog asks for the input range (in/out on the first input\u2019s source) and the frames per segment — long ranges run in segments that land back-to-back on the track starting at the in-point, and frame-to-frame state (temporal nodes) does not carry across segment boundaries.' : ''}
        </div>
      )}
    </div>
  );
};

export const processorUnit: WorkbenchUnit = {
  id: 'processor',
  title: 'Processor',
  hint: 'Processor — runs an interface that has Processor mode on as a fully offline pass: the pipeline’s current '
    + 'image is never touched. Each image input reads the Layers composite, the selected layer or an asset from the '
    + 'store; each mask input reads the main Mask, the selected layer’s mask, its alpha, or mask AND alpha. Outputs '
    + 'land as a new layer, back into the selected layer or its mask, or in the asset store. With Allow List on '
    + '(Interface tab), inputs go in as a column of images — in video mode from Tracks / Sel. Track / Asset, in '
    + 'segments — and outputs come back as New Track / Asset.',
  Body: ProcessorBody,
};
