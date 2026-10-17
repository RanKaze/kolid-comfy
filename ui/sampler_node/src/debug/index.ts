/**
 * 界面探针的入口。页面只需要两处接线：
 *   - `installProbe()`（main.tsx，一次）—— 挂热键与 `window.__uiProbe`；
 *   - `<ProbePanel />`（App.tsx，一次）—— 面板本身（关着的时候不渲染任何东西）；
 *   - `registerProbe({ dock, rules, edit })`（EditPhase.tsx）—— 把活的 dock 交进来。
 */
export * from './probe';
export * from './live';
export * from './install';
export { default as ProbePanel } from './ProbePanel';
