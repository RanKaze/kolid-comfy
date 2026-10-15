import type React from 'react';

// 工作台单元正文的皮。词汇照兄弟小节抄：标题条那一排圆药丸就是 dock 里 `fileBtn` 那颗，
// 选中态 #0a84ff，键徽章 #8e8e93 —— 和 Settings 页同一套 iOS token，不再另起一套。
export const wbStyles: Record<string, React.CSSProperties> = {
  row: { display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', minWidth: 0 },
  btn: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    fontSize: 10.5, fontWeight: 600, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
    background: 'rgba(255,255,255,0.07)', border: '0.5px solid rgba(255,255,255,0.16)',
    color: 'rgba(255,255,255,0.82)', lineHeight: 1.5,
  },
  btnOn: { background: 'rgba(10,132,255,0.18)', borderColor: 'rgba(10,132,255,0.6)', color: '#fff' },
  btnOff: { opacity: 0.35, cursor: 'default', background: 'rgba(255,255,255,0.05)' },
  key: {
    padding: '1px 5px', borderRadius: 6, background: 'rgba(255,255,255,0.10)',
    color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: 700,
    fontFamily: 'ui-monospace, Consolas, monospace',
  },
  readout: {
    fontSize: 10.5, color: 'rgba(255,255,255,0.38)', lineHeight: 1.45,
    fontVariantNumeric: 'tabular-nums', minWidth: 0, wordBreak: 'break-all' as const,
  },
  // 一行一个旋钮：名称居左、滑杆吃中间、读数靠右 —— 和页面那条 .control-row 同一个骨架。
  ctrl: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  ctrlLabel: { fontSize: 10.5, color: 'rgba(255,255,255,0.62)', width: 58, flexShrink: 0 },
  slider: { flex: '1 1 0', minWidth: 0, accentColor: '#0a84ff', height: 14 },
  value: {
    fontSize: 10.5, color: 'rgba(255,255,255,0.5)', width: 34, textAlign: 'right' as const,
    fontVariantNumeric: 'tabular-nums', flexShrink: 0,
  },
  check: { accentColor: '#0a84ff', flex: '0 0 auto' },
  // 笔落在哪一面这件事，原来写在被删掉的那行小节标题上；现在跟着这枚色环走 —— 装了颜色就说得清
  // 这一笔涂的是哪一面，环本身在 decal 上才被染色，跟页面光标环同一个取值。
  ring: {
    width: 13, height: 13, borderRadius: '50%', flexShrink: 0,
    border: '2px solid rgba(255,255,255,0.92)', boxShadow: '0 0 0 1px rgba(0,0,0,0.55)',
  },
  ringErase: {
    width: 13, height: 13, borderRadius: '50%', flexShrink: 0,
    border: '2px dashed rgba(255,96,96,0.95)', boxShadow: '0 0 0 1px rgba(0,0,0,0.55)',
  },
  // 页面那一列曾经给"此刻正在用的那一支笔"整格上底色（.tool-section.active-tool）。
  // 搬进 dock 以后正文还能上这一层蓝，标题条归宿主、不归一格面板自己 —— 所以亮的还是那一格，
  // 只是不再连标题条一起亮。取值照页面那两条 CSS，一字没改。
  armed: { background: 'rgba(0,122,255,0.12)', boxShadow: 'inset 0 0 0 1px rgba(0,122,255,0.5)' },
  // 格名旁边那枚键徽章，页面曾经给它两条 CSS：平时灰，本格是那支在用的笔时变蓝
  // （.tool-section.active-tool .tool-key）。名字由宿主画，徽章留在正文第一行，
  // 所以"点亮"这条可观察差别跟着它一起过来。
  keyOn: { background: 'rgba(0,122,255,0.9)', color: '#fff' },
  // 缩略图那枚 36×24 的格子：取值照页面 `.layer-thumb` + `.layer-thumb.masklayer-thumb` 两条，
  // 一格一层 —— 覆盖面是透明的，底下那两层 45° 渐变就是它的棋盘。
  thumbBox: {
    width: 36, height: 24, flexShrink: 0, borderRadius: 5, overflow: 'hidden', position: 'relative' as const,
    backgroundColor: '#141414', cursor: 'default',
    backgroundImage: 'linear-gradient(45deg, #262626 25%, transparent 25%, transparent 75%, #262626 75%), linear-gradient(45deg, #262626 25%, transparent 25%, transparent 75%, #262626 75%)',
    backgroundSize: '8px 8px, 8px 8px', backgroundPosition: '0 0, 4px 4px',
  },
  // 眼睛那类无字按钮：页面 `.icon-btn` 那一条搬过来，颜色给它自己的墨色，hover 那两层 CSS dock 皮没有。
  iconBtn: {
    background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.45)', cursor: 'pointer',
    padding: 2, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
};
