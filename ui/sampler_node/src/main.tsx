import { renderApp } from '@kolid/ui-utils/react-entry';
import App from './App';
import '@kolid/ui-utils/base.css';
import { installProbe } from './debug';

// 界面探针：热键（Alt+D 面板 / Alt+Shift+D 直接存档）与 window.__uiProbe 都在这里挂上。
// 它只读布局状态、不参与渲染，装不装都不影响页面本身。
installProbe();

renderApp(App);
