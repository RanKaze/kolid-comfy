import React from 'react';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import type { BlendProcChoice, BlendProcParamRow } from '../types';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';

// Processor 那一格：把 Interface tab 里开了 Processor 模式的 interface 当离线图像处理器跑 —— pipeline
// 的当前图不动，输入按行收集、输出按行落位。行不是写死的：页面按所选 interface 的端口现拼一份**描述
// 符**（哪几段、每行是什么控件、候选有哪几枚），这里照着摆。所以这一格不认识端口、也不认识图层 ——
// 它只把每一颗控件的落值发回动作键，值本身仍由页面按"拧过没有"那一套算（见 procParamValue）。

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

const ProcessorBody: React.FC<WorkbenchUnitProps> = ({ send }) => {
  const ui = useBlendUi();
  const p = ui.processor;
  const none = p.names.length === 0;
  return (
    <div style={{ ...wbStyles.stack, padding: 4 }}>
      <div style={wbStyles.ctrl}>
        <label style={wbStyles.ctrlLabel}>Interface</label>
        <select style={wbStyles.select} value={none ? '' : String(p.choice)} disabled={none}
          title="Which processor-mode interface to run — the list is every interface with Processor mode on in the Interface tab"
          onChange={e => send('processor-interface', Number(e.target.value) || 0)}>
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
      {p.inputs.map(row => (
        <React.Fragment key={row.num}>
          <div style={wbStyles.ctrl}>
            <label style={wbStyles.ctrlLabel}>{row.name}</label>
            <ChoiceGroup options={row.options} cur={row.cur} title={row.hint}
              onPick={value => send('processor-pick', { side: 'in', port: row.num, value })} />
          </div>
          {row.staging && (
            <div style={wbStyles.ctrl}>
              <span style={{ ...wbStyles.ctrlLabel, width: 'auto' }} />
              <select style={wbStyles.select} value={row.staging.cur} disabled={row.staging.options.length === 0}
                title="Which workspace entry feeds this input"
                onChange={e => send('processor-staging', { port: row.num, id: e.target.value })}>
                {row.staging.options.length === 0
                  ? <option value="">— workspace is empty —</option>
                  : row.staging.options.map(o => (
                    <option key={o.id} value={o.id} style={{ background: '#1c1c1e', color: '#fff' }}>{o.name}</option>
                  ))}
              </select>
            </div>
          )}
        </React.Fragment>
      ))}

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
          <ChoiceGroup options={row.options} cur={row.cur} title={row.hint}
            onPick={value => send('processor-pick', { side: 'out', port: row.num, value })} />
        </div>
      ))}

      <div style={{ ...wbStyles.row, marginTop: 2 }}>
        <button type="button" style={wbStyles.btn}
          title="Forget every value typed in this window — each parameter goes back to the value the graph carries"
          onClick={() => send('processor-reset')}>Reset values</button>
        <button type="button" style={{ ...wbStyles.btn, ...(none ? wbStyles.btnOff : null) }} disabled={none}
          title="Run the chosen processor offline — inputs are gathered per the rows above, results land per each output row"
          onClick={() => send('processor-run')}>Run</button>
      </div>
    </div>
  );
};

export const processorUnit: WorkbenchUnit = {
  id: 'processor',
  title: 'Processor',
  hint: 'Processor — runs an interface that has Processor mode on as a fully offline pass: the pipeline’s current '
    + 'image is never touched. Each image input reads the Layers composite, the selected layer or a staging entry; '
    + 'each mask input reads the main Mask, the selected layer’s mask, its alpha, or mask AND alpha. Outputs land '
    + 'as a new layer, back into the selected layer or its mask, or in the workspace.',
  Body: ProcessorBody,
};
