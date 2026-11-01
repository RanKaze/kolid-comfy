import React, { useEffect } from 'react';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import type { WorkbenchUnit, WorkbenchUnitProps } from './registry';
import { hit, isRecording } from '../keybindings';
import { onGlobalKey } from '../hotkeys';
import { useChord } from './chord';
import { disarmCut, getCut, useCut } from './cutStore';
import { setMidiTool, useMidiTool } from '../midi/tool';

// ── Cursor：把工具放下，指针回到普通箭头 ────────────────────────────────────────────────────
//
// 画笔 / 橡皮 / 剪刀都是**黏住**的精确工具：拿起橡皮之后，想单纯选一枚音、或者只是把指针挪开
// 看看，都得先想到按 Esc。这一格就是那条退路 —— A 一按，手上什么都不拿。
//
// 三个面各自放下自己的工具（与 Cut 一样按 `host.video.mode` 换面）：
//   · Image —— 页面回到 mode 'none'（enterCursorMode：裁切 / 改画布 / 扩展那三种边界拖动先走
//     它们自己的取消，再把工具位清空）。视图不动 —— 那是 Esc 的活。
//   · MIDI —— 卷帘的笔换成 'cursor'：不落音、不擦音，选中与拖动照旧。
//   · Video —— 撤掉时间线上的剪刀，片段回到普通的拖动 / 裁剪。
//
// 键在执行处判定（页面 / midi/Workspace / video/Timeline），这里只管按下去换手与把状态点亮。

const pill = (on: boolean): React.CSSProperties => ({ ...wbStyles.btn, ...(on ? wbStyles.btnOn : null) });
const keyStyle = (on: boolean): React.CSSProperties => ({ ...wbStyles.key, ...(on ? wbStyles.keyOn : null) });

const CursorBody: React.FC<WorkbenchUnitProps> = ({ send, host }) => {
  const chord = useChord('tool.cursor');
  const ui = useBlendUi();
  const cut = useCut();
  const tool = useMidiTool();
  const mode = host.video.mode;

  // 指针在画布上、焦点却在宿主这一侧时（比如刚点了 dock 里的标题条），页面收不到这一下 ——
  // 与 Cut 的 CropBody 同一条补位。焦点在画布 iframe 里时页面自己接，这里必须让路，
  // 否则同一下按两次（而且两边都是"设成 none"，不会翻面，只是白跑一趟）。
  useEffect(() => onGlobalKey(e => {
    if (e.repeat || isRecording()) return;
    if (mode !== 'image') return;
    if (getCut().hover !== 'canvas') return;
    if (!hit(e, 'tool.cursor')) return;
    const t = e.target as Node | null;
    if (t && 'ownerDocument' in t && t.ownerDocument !== document) return;
    const el = t as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
    e.preventDefault();
    send('canvas-cursor');
  }), [mode, send]);

  const on = mode === 'midi' ? tool === 'cursor'
    : mode === 'video' ? !cut.armed['cut.timeline']
      : ui.mode === 'none';
  const title = mode === 'midi'
    ? `Cursor (${chord}) — put the pen down: the pointer is a plain arrow again and clicking empty `
      + 'space draws nothing. Notes can still be selected, moved and resized. Stays on until you take '
      + 'Brush / Eraser / Cut or press Esc.'
    : mode === 'video'
      ? `Cursor (${chord}) — drop the blade: segments drag and trim as usual. Lit while the pointer `
        + 'is a normal one; Cut is only armed while its key is held (or its button is on).'
      : `Cursor (${chord}) — put every tool down and get the plain arrow back. Nothing paints, crops `
        + 'or moves the view; clicking still selects a layer. Esc also returns to no tool, but it '
        + 'refits the view as well — this one leaves the view alone.';
  return (
    <div style={wbStyles.row}>
      <button style={pill(on)} title={title}
        onClick={() => {
          if (mode === 'midi') { setMidiTool('cursor'); disarmCut('cut.midi'); }
          else if (mode === 'video') disarmCut('cut.timeline');
          else send('canvas-cursor');
        }}>
        <span style={keyStyle(on)}>{chord}</span>
      </button>
    </div>
  );
};

export const cursorUnit: WorkbenchUnit = {
  id: 'cursor',
  title: 'Cursor',
  hint: 'Cursor (A) — stops whatever tool is in hand: no painting on the canvas, no notes drawn on '
    + 'the roll, no blade on the timeline. On the roll, notes can still be selected, moved and resized.',
  Body: CursorBody,
};
