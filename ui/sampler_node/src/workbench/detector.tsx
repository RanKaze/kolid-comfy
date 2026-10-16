import React from 'react';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';

// Detector 那一格。页面原来整节 `display:none` 到 blend-config 说 detector 输入真的接上了为止 ——
// dock 里一格不能凭空出现或消失（panels 是固定集），所以没接上时这一格给一句空态，说清它为什么是空的。
// 小窗那三颗控件（prompt / threshold / invert）住的仍是页面：这里摆的是它们的镜像，每次落值都发动作键
// 回去 —— 与画布那几格同一套边界。Detect 那一颗只是开对话框，选源与落位的活还在页面那口 modal 里。

const PROMPT_TITLE = 'Mask expression, e.g. \'(face:0.4)&(hair:0.3)-mouth\'. Operators (left-to-right): & intersect, '
  + '+ union, - subtract, | union. Terms: name, name:0.3, name(0.3). Functions: max(a,b,…), min(a,b,…), '
  + 'grow(x,n) — n>0 dilates, n<0 erodes. Statements \';\' or newline separated; \'x = expr\' then reuse x.';

const DetectorBody: React.FC<WorkbenchUnitProps> = ({ send }) => {
  const ui = useBlendUi();
  const d = ui.detector;
  if (!d.available) {
    return (
      <div style={wbStyles.note}>
        No detector is connected to the node — the Detector tool has nothing to do until one is wired into its
        detector input.
      </div>
    );
  }
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
      <div style={{ display: 'flex', gap: 4 }}>
        <button type="button" style={{ ...wbStyles.btn, flex: 1, justifyContent: 'center' }}
          title="Open the Detect dialog — pick where the detector looks and where the mask lands"
          onClick={() => send('detector-run')}>Detect</button>
      </div>
    </div>
  );
};

export const detectorUnit: WorkbenchUnit = {
  id: 'detector',
  title: 'Detector',
  hint: 'Detector — runs the detector connected to the node’s detector input and turns what it finds into a mask.',
  Body: DetectorBody,
};
