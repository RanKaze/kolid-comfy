// Kolid Desktop 的能力探测：壳页（client/kolid_client.py 的 SHELL_HTML）在
// index.html 的握手脚本里把 __kolidDockHost 置真。窗口化只属于 Desktop —— 普通浏览器 /
// 普通 iframe 里它恒为假，那边没有浮窗，存档里的浮窗会泊回主布局（见 childWindow.tsx）。
export const dockChildWindows = (): boolean =>
  (window as unknown as { __kolidDockHost?: boolean }).__kolidDockHost === true;
