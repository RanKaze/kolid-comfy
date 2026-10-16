import React from 'react';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';

// Text 那一格：选中层最左那枚 Text 记录的四样读数（字体、Padding、Weight、Color），页面原来的
// #textSection 正文就是这四行。字本身仍然在画布上双击改 —— 这一格一个字都碰不到内容，它改的是样式。
// 那一格原来靠"选中带 Text 步骤的层"整节点亮（.active-tool），搬进 dock 以后正文自己上那一层底色
// （wbStyles.armed）；没选中就整格退回一句空态 —— 页面的 fold 在这里没有对应物，空的控件比一句
// 说明更难看。

const WEIGHTS = [['normal', 'Normal'], ['bold', 'Bold']] as const;

const TextBody: React.FC<WorkbenchUnitProps> = ({ send }) => {
  const ui = useBlendUi();
  const t = ui.text;
  if (!t.on) {
    return (
      <div style={wbStyles.note}>
        Select a layer that carries a Text step — its four style knobs appear here. The words themselves are
        edited on the canvas: double-click the text (or press Enter with the row selected).
      </div>
    );
  }
  return (
    <div style={{ ...wbStyles.stack, padding: 4, ...wbStyles.armed }}>
      {/* Alt+T 那枚键徽章原来挂在标题上；颜色色块原来在标题右端，如今是本格第一行。 */}
      <div style={{ ...wbStyles.row, marginBottom: 2 }}>
        <span style={{ ...wbStyles.key, ...wbStyles.keyOn }}
          title="Alt+T drags out a fresh text step of its own">Alt+T</span>
        <span style={{ ...wbStyles.ring, marginLeft: 'auto', background: t.color }}
          title="The text colour" />
      </div>
      <div style={wbStyles.ctrl}>
        <label style={wbStyles.ctrlLabel}>Font</label>
        <button type="button" style={{ ...wbStyles.fontBtn, fontFamily: t.fontFace || undefined,
          ...(t.fontMissing ? wbStyles.fontBtnGone : null) }}
          title={'Font — opens the picker: every name is drawn in its own face, grouped by family, with the fonts '
            + 'you loaded from disk at the bottom. Rendered by this browser, so the .cud shows whatever these fonts '
            + 'give on the machine that opens it'}
          onClick={() => send('text-font')}>{t.fontLabel}</button>
      </div>
      <div style={wbStyles.ctrl}>
        <label style={wbStyles.ctrlLabel}>Padding</label>
        <input style={wbStyles.slider} type="range" min={0} max={256} step={1} value={Math.min(256, t.padding)}
          title={'Clear space around the text, in layer pixels at the authored font size — the box grows outward and '
            + 'the glyphs keep their size. Outer effects (drop shadow, glow) need that room: they are cut at the '
            + "layer's own edge"}
          onChange={e => send('text-padding', Math.max(0, Number(e.target.value) || 0))} />
        <span style={wbStyles.value}>{t.padding}</span>
      </div>
      <div style={wbStyles.ctrl}>
        <label style={wbStyles.ctrlLabel}>Weight</label>
        <div style={wbStyles.miniGroup}>
          {WEIGHTS.map(([v, label]) => (
            <button key={v} type="button"
              style={{ ...wbStyles.btn, ...(t.weight === v ? wbStyles.btnOn : null) }}
              title={`${label} weight`}
              onClick={() => send('text-weight', v)}>{label}</button>
          ))}
        </div>
      </div>
      <div style={wbStyles.ctrl}>
        <label style={wbStyles.ctrlLabel}>Color</label>
        <input style={wbStyles.color} type="color" value={t.color}
          onChange={e => send('text-color', e.target.value)} />
        <span style={wbStyles.value}>{t.color.toUpperCase()}</span>
      </div>
    </div>
  );
};

export const textUnit: WorkbenchUnit = {
  id: 'text',
  title: 'Text',
  hint: 'Text — the settings of the selected layer’s Text step. Edit the words themselves on the canvas: '
    + 'double-click the text (or press Enter with the row selected). Alt+T drags out a fresh text step of its own.',
  Body: TextBody,
};
