/**
 * 界面探针的入口。页面只需要两处接线：
 *   - `installProbe()`（main.tsx，一次）—— 挂热键与 `window.__uiProbe`；
 *   - `<ProbePanelBody />`（EditPhase 的 bodies.probe —— 探针是一扇 dock 窗的正文）；
 *   - `registerProbe({ dock, rules, edit })`（EditPhase.tsx）—— 把活的 dock 交进来。
 */
export * from './probe';
export * from './live';
export * from './install';
export { ProbePanelBody } from './ProbePanel';
