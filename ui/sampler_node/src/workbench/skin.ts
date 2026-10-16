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
  // ---- Text / 3D / Detector / Processor 四格要的那几样 ----
  // 空态与提示句：页面那两条 .panel-hint 与 .s3d-note 同一套小字灰。
  note: { fontSize: 10.5, color: 'rgba(255,255,255,0.35)', lineHeight: 1.45 },
  // 一格的纵列：控件一组一组往下摆，组间距照页面 .tool-body 的 gap。
  stack: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  // 分段按钮带（来源 / 落位 / 参数枚举 ≤3 档）：页面 .mini-group 的读法。
  miniGroup: { display: 'flex', gap: 4, flexWrap: 'wrap', minWidth: 0 },
  // Processor 那三段的小标题（Inputs / Parameters / Outputs）：页面 .proc-group > .panel-label。
  groupHead: { fontSize: 10.5, color: 'rgba(255,255,255,0.42)', fontWeight: 600, marginTop: 2 },
  // Font 那一颗：占满一行、字左对齐、用它自己那张脸画；本机没有这个字体时转红（.text-font-btn.gone）。
  fontBtn: {
    flex: '1 1 0', minWidth: 0, textAlign: 'left' as const, background: 'rgba(255,255,255,0.08)',
    border: 'none', borderRadius: 6, color: 'rgba(255,255,255,0.9)', fontSize: 11, padding: '4px 8px',
    cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  },
  fontBtnGone: { color: '#ff453a' },
  // 下拉：取值照 EditPhase 的 paramSelect，只是这一列更窄，所以字号与内距各收一号。
  select: {
    flex: '1 1 0', minWidth: 0, background: 'rgba(255,255,255,0.06)',
    border: '0.5px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '3px 6px',
    color: 'rgba(255,255,255,0.9)', fontSize: 10.5, outline: 'none', colorScheme: 'dark',
  },
  // 多行输入（Detector 的 prompt）：页面 #detectPrompt 那一条的等价物。
  area: {
    flex: '1 1 auto', minWidth: 0, minHeight: 58, resize: 'vertical' as const,
    background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.1)', borderRadius: 6,
    padding: '4px 6px', color: 'rgba(255,255,255,0.9)', fontSize: 10.5, outline: 'none',
    fontFamily: 'ui-monospace, Consolas, monospace', colorScheme: 'dark',
  },
  // 单行数字 / 文字输入（Processor 的参数口）：和 select 同一套皮。
  input: {
    flex: '1 1 0', minWidth: 0, background: 'rgba(255,255,255,0.06)',
    border: '0.5px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '3px 6px',
    color: 'rgba(255,255,255,0.9)', fontSize: 10.5, outline: 'none', colorScheme: 'dark',
  },
  // 颜色输入：页面 <input type=color> 自己那颗，只把它收成一小枚方形。
  color: { width: 26, height: 18, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', flexShrink: 0 },
};
