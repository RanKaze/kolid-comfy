import React, { useEffect } from 'react';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';
import { hit, isRecording } from '../keybindings';
import { onGlobalKey } from '../hotkeys';
import { useChord } from './chord';
import { getCut, toggleCut, useCut, type CutCommand } from './cutStore';
import type { BlendUiSend } from '../types';

// Cut 那一格：三位一体的一条命令，按**文档此刻的模式**换面 —— 图片是裁布（框选 → Enter），
// 时间线是剪段，卷帘是剪音符。三条命令各有各的键（Key Bindings 里同属 Cut 一组），所以徽章
// 写的是**此刻生效**的那一个键，而不是一个写死的 C。
//
// 键的判定不在这里：时间线与卷帘各自在自己的根元素上报 hover、在自己那条 onGlobalKey 里武装
// （见 video/Timeline.tsx 与 midi/Workspace.tsx）。图片那一面是画布 iframe 里的模态框，页面
// 自己接自己焦点里的那一下；这里只补一条**焦点还在宿主**时的回路（下面的 CropBody）。

const pill = (on: boolean): React.CSSProperties => ({ ...wbStyles.btn, ...(on ? wbStyles.btnOn : null) });

const keyStyle = (on: boolean): React.CSSProperties => ({ ...wbStyles.key, ...(on ? wbStyles.keyOn : null) });

// ── Image：PS 裁切模式 ─────────────────────────────────────────────────────────────────────────
// 按钮是黏住的（按一下进框选模式，再按一下收起）；交出的那一条命令页面里也有同名的一条
// （UI_COMMANDS['canvas-crop']），两边共用同一个入口，不各写一份。
const CropBody: React.FC<{ send: BlendUiSend }> = ({ send }) => {
  const ui = useBlendUi();
  const chord = useChord('cut.canvas');
  const on = ui.mode === 'crop';
  // 键的回路：鼠标在画布上、焦点也在画布 iframe 里时页面自己接（它只看 cursorInside），宿主
  // 必须让路 —— 两边都接会把同一个键按两次，而裁切本身就是个开关，第二下等于立刻取消。
  // 剩下的那一种：指针在画布上、焦点还留在宿主这边（键发生在宿主 document 里，页面永远收不到）
  // —— 这里补一条。
  useEffect(() => onGlobalKey(e => {
    if (e.repeat || isRecording()) return;
    if (getCut().hover !== 'canvas') return;
    if (!hit(e, 'cut.canvas')) return;
    const t = e.target as Node | null;
    if (t && 'ownerDocument' in t && t.ownerDocument !== document) return;
    const el = t as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    e.preventDefault();
    send('canvas-crop');
  }), [send]);
  return (
    <div style={wbStyles.row}>
      <button style={pill(on)}
        title={`Crop (${chord}) — drag a box over the canvas; the eight handles move or resize it, `
          + 'Enter crops to it and Esc leaves everything as it was. Raster layers are cut, smart layers '
          + 'keep their pixels and only re-aim their placement. Space / middle-drag still pans and the '
          + 'wheel still zooms while the box is live.'}
        onClick={() => send('canvas-crop')}>
        <span style={keyStyle(on)}>{chord}</span>
      </button>
    </div>
  );
};

// ── Video / MIDI：武装剪刀 ────────────────────────────────────────────────────────────────────
// 按钮永远是黏住的（按一下开、再按一下关）；键走 cutStore 里的手势 —— 默认按住，用户可在
// Key Bindings 把这行改成 Toggle。真正挨着剪的地方（时间线的片段、卷帘的音符）各自读
// `armed`，这里只负责让它亮起来。
const ArmBody: React.FC<{ cmd: CutCommand; text: (chord: string) => string }> = ({ cmd, text }) => {
  const cut = useCut();
  const chord = useChord(cmd);
  const on = cut.armed[cmd];
  const gesture = cut.modes[cmd] === 'toggle' ? 'press once to toggle' : 'hold to arm';
  return (
    <div style={wbStyles.row}>
      <button style={pill(on)} title={`${text(chord)} The key is ${gesture}; this button keeps it on.`}
        onClick={() => toggleCut(cmd)}>
        <span style={keyStyle(on)}>{chord}</span>
      </button>
    </div>
  );
};

const CutBody: React.FC<WorkbenchUnitProps> = ({ send, host }) => {
  const mode = host.video.mode;
  if (mode === 'midi') {
    return <ArmBody cmd="cut.midi" text={chord => `Cut notes (${chord}) — click a note to split it at the `
      + 'snapped beat; each half keeps at least a 1/32 note, pitch and velocity unchanged.'} />;
  }
  if (mode === 'video') {
    return <ArmBody cmd="cut.timeline" text={chord => `Cut segments (${chord}) — click a segment to split it `
      + 'at the pointer; Alt-click splits only the one under the pointer, the linked group stays whole.'} />;
  }
  return <CropBody send={send} />;
};

export const cutUnit: WorkbenchUnit = {
  id: 'cut',
  title: 'Cut',
  hint: 'C cuts whatever the pointer is on: a crop box on the canvas in Image mode, a split at the '
    + 'pointer on a segment in Video, a split at the snapped beat on a note in MIDI. The three are '
    + 'separate shortcuts under Cut in Settings → Key Bindings, so each mode can keep its own key.',
  Body: CutBody,
};
