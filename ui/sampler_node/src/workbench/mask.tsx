import React from 'react';
import { wbStyles } from './skin';
import { useBlendUi } from './store';
import type { BlendUiSend } from '../types';

// Mask 这一格就是页面原来的 #maskDock 合成的那一格（拍板 6.a）：那张覆盖面自己。
// 曾经上面还有一行"笔落在哪一面"（键帽徽章 + 目标名 + 笔尖那枚 Invert）。用户拍板全撤：键帽是
// 快捷键提示；目标名那串字不留；笔尖 Invert 是重复入口 —— 整层的 Invert / Full / Clear 就在
// 下面这一行里。撤完以后这一格只剩覆盖面本体：缩略图 + 三颗整层动作 + 眼睛。
//
// 然后（用户拍板）它**不再是自己的 dock window**：一整扇窗只装一行，剩下的全是空白，空间利用
// 太差。它现在是 Guidances 那一格里的**第一行** —— 见 guidances.tsx，MaskRow 钉在列表顶上。
// 所以这里只导出一行，不再导出 unit；dock 的注册表里也没有 `mask` 这个名字了。
//
// 缩略图这一格是这一列里第一个真要传像素的面：那张覆盖面住在本页绘制引擎里（maskLayer.decal 是一块活
// canvas），宿主页画不出它。页面把它按原来那颗 thumb 的 84×56 编成一帧 PNG 交过来，所以这里的 <img>
// 看到的就是原来 canvas 上的那一份像素；它只在面真的换过之后才重编（见 blend_node.html 的 syncMaskStill）。

/** 眼睛那枚描边 SVG：与页面眼下的图层行（eyeSvg）同一道勾、同一个叉，门禁比的就是这两串 path。 */
const Eye = ({ visible }: { visible: boolean }) => (
  <svg viewBox="0 0 16 16" width="14" height="14" style={{ display: 'block' }}>
    <path d="M8 3.6C4.7 3.6 2 5.9 1.1 8c.9 2.1 3.6 4.4 6.9 4.4S14.9 10.1 15 8c-.9-2.1-3.6-4.4-6.9-4.4z"
      fill="none" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="8" cy="8" r="1.9" fill="currentColor" />
    {!visible && <path d="M2.4 2.4 13.6 13.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
  </svg>
);

// 整层那三颗动作：与页面 runMaskRowAction 那三句一字不差，包括"没有画布就说是没有画布"那一条。
const LAYER_ACTIONS: { action: 'mask-layer-invert' | 'mask-layer-full' | 'mask-layer-clear'; label: string; title: string }[] = [
  { action: 'mask-layer-invert', label: 'Invert', title: 'Invert the Mask layer — covered pixels become uncovered and the other way round' },
  { action: 'mask-layer-full', label: 'Full', title: 'Fill the Mask layer — every pixel of the canvas covered' },
  { action: 'mask-layer-clear', label: 'Clear', title: 'Clear the Mask layer — nothing covered, so the actions run on the whole image' },
];

// 这一行住在 Guidances 的列表顶上（见 guidances.tsx），不是一扇窗，所以它的外框得自己钉住：
// `position: sticky` 让它在列表滚动时留在原地（一摞行往下滚，这条覆盖面不该跟着跑掉），底下一道
// 发丝线把它和 guidance 那些行分开。背景必须写实：不写的话滚动的内容会从它下面透出来。
export const MaskRow: React.FC<{ send: BlendUiSend }> = ({ send }) => {
  const ui = useBlendUi();
  const armed = ui.mode === 'mask';
  return (
    <div data-mask-row="" style={{ display: 'flex', flexDirection: 'column', gap: 4,
      padding: '4px 4px 6px', position: 'sticky', top: 0, zIndex: 2,
      background: armed ? 'rgba(0,122,255,0.12)' : '#1c1c1e',
      borderBottom: '0.5px solid rgba(255,255,255,0.10)',
      ...(armed ? { boxShadow: wbStyles.armed.boxShadow } : null) }}>
      {/* 覆盖面自己：整行点一下就是把笔交给它（页面那行 row.addEventListener('click', selectMaskLayer)）。 */}
      <div style={{ ...wbStyles.row, padding: 5, borderRadius: 8, cursor: 'pointer',
        background: ui.paint.maskLayer ? 'rgba(255,59,48,0.2)' : 'rgba(255,59,48,0.10)',
        border: `1px solid ${ui.paint.maskLayer ? 'rgba(255,59,48,0.9)' : 'transparent'}` }}
        title={'Mask layer — a canvas-sized coverage channel handed to the backend. It is never composited into the Context Image. '
          + 'It is not a layer either: it travels to the backend as its own alpha, and it belongs to neither the Layers nor the Guidances stack.'}
        onClick={() => send('mask-layer-select')}>
        <span style={{ ...wbStyles.thumbBox, opacity: ui.mask.visible ? 1 : 0.35 }}
          title="Alpha = coverage. Brush and Bucket cover, eraser uncovers.">
          {ui.mask.still !== '' && <img src={ui.mask.still} alt="" draggable={false}
            style={{ width: '100%', height: '100%', display: 'block' }} />}
        </span>
        {LAYER_ACTIONS.map(a => (
          <button key={a.action} style={{ ...wbStyles.btn, flex: '0 1 auto' }} title={a.title}
            onClick={e => { e.stopPropagation(); send(a.action); }}>{a.label}</button>
        ))}
        <button style={{ ...wbStyles.iconBtn, marginLeft: 'auto',
          opacity: ui.mask.visible ? 1 : 0.45 }}
          title={ui.mask.visible ? 'Hide the Mask layer (actions then run without a mask)' : 'Show the Mask layer'}
          onClick={e => { e.stopPropagation(); send('mask-layer-eye'); }}>
          <Eye visible={ui.mask.visible} />
        </button>
      </div>
    </div>
  );
};
