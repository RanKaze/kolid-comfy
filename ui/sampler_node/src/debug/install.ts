import {
  PROBE_BUILD, note, probeCopy, probeDownload, probeLast, probePullWatch, probeReport, probeSend,
  probeSnapshot, probeSummary, registerProbe, subscribeProbe, traceClear, traceList,
  type ProbeSendResult, type ProbeSnapshot,
} from './probe';
import { installLive, liveHelpers, liveNow, liveReport } from './live';
import { cudScopeReport } from '../workbench/cudScope';
import { onGlobalKey, keyIs } from '../hotkeys';
import { isRecording } from '../keybindings';

/**
 * 探针的装配层：把上面那些零件挂到全局，并给出两个入口 —— 热键与 `window.__uiProbe`。
 *
 * 热键选 **Alt+D**（D = Dock/Debug）。Alt+P 已经被 Block 编辑模式占了，而这两个键在一起用很顺手：
 * Alt+P 打开编辑模式、Alt+D 打开探针，一边看一边改。
 *
 * `window.__uiProbe` 是给"不需要人操作"的那条路准备的：无头 harness（临时目录下那几个 .cjs）
 * 和任何自动化脚本都可以直接 `__uiProbe.snapshot()` 取走一份，不必让人去点按钮。
 */

// ── 面板开关：一个极小的外部 store，面板自己订阅 ─────────────────────────────
let open = false;
const panelListeners = new Set<() => void>();
export const probePanelOpen = (): boolean => open;
export const setProbePanelOpen = (v: boolean): void => {
  if (open === v) return;
  open = v;
  panelListeners.forEach(f => f());
};
export const toggleProbePanel = (): void => setProbePanelOpen(!open);
export function subscribePanel(f: () => void): () => void {
  panelListeners.add(f);
  return () => { panelListeners.delete(f); };
}

let installed = false;

/** 装一次就够；重复调用是空操作（StrictMode 会调两次）。 */
export function installProbe(): void {
  if (installed) return;
  installed = true;

  const api = {
    version: 2,
    build: PROBE_BUILD,
    // 控制台式助手：`__uiProbe.blocks()` / `handles()` / `drag(x,y,dx)` / `q(sel)`
    ...liveHelpers,
    // 数据
    snapshot: (label?: string): ProbeSnapshot => probeSnapshot(label),
    last: (): ProbeSnapshot | null => probeLast(),
    now: liveNow,
    liveReport,
    summary: (s?: ProbeSnapshot): string => probeSummary(s ?? probeSnapshot()),
    report: (label?: string): string => probeReport(probeSnapshot(label)),
    trace: { list: traceList, clear: traceClear, note },
    mark: (kind: string, data?: Record<string, unknown>): void => note(kind, data || {}),
    // 出口
    send: (label?: string): Promise<ProbeSendResult> => probeSend(label),
    copy: (label?: string): Promise<boolean> => probeCopy(label),
    download: (label?: string): string => probeDownload(label),
    // 页面登记 / 面板
    register: registerProbe,
    subscribe: subscribeProbe,
    // 换 .cud 的登记簿：哪些窗对自己的切换负责、最近一次换文档是谁→谁。探针用它证明
    // "没有一扇窗是漏登记的"（见 workbench/cudScope.ts）。
    cud: cudScopeReport,
    openPanel: () => setProbePanelOpen(true),
    closePanel: () => setProbePanelOpen(false),
    togglePanel: toggleProbePanel,
  };
  (window as unknown as Record<string, unknown>).__uiProbe = api;

  // ── 热键 ───────────────────────────────────────────────────────────────────
  const onKey = (e: KeyboardEvent): void => {
    // 正在录快捷键：探针面板的 Alt+D 不是产品功能，别在录制时抢键。
    if (isRecording()) return;
    if (!e.altKey || e.metaKey || e.ctrlKey) return;
    // `keyIs` 同时认物理键位：macOS 上 Option 会把 `key` 变成符号（Alt+D → ∂），只认 key 会漏。
    if (!keyIs(e, 'd')) return;
    if (!e.shiftKey) {
      e.preventDefault(); e.stopPropagation();
      toggleProbePanel();
      note('probe.panel', { open: probePanelOpen() });
    } else {
      // Alt+Shift+D：抓一份直接送后端，面板不弹 —— "一键存档"。
      e.preventDefault(); e.stopPropagation();
      void probeSend('hotkey').then(r => note('probe.sent', { ok: r.ok, file: r.file ?? null, error: r.error ?? null }));
    }
  };
  // 走 hotkeys 的入口而不是裸 window 监听：鼠标停在画布上时焦点在工作台 iframe 里，
  // 宿主 window 收不到 keydown —— 那会让"看得见问题却打不开探针"成为常态。见 hotkeys.ts。
  onGlobalKey(onKey);

  // ── 让"报错"和"窗口变了"也进轨迹 ─────────────────────────────────────────
  // 这两类事件往往是布局问题的起点，而它们发生时用户不会记得去抓快照。
  window.addEventListener('error', ev => {
    note('error', { message: ev.message, source: ev.filename, line: ev.lineno, col: ev.colno });
  });
  window.addEventListener('unhandledrejection', ev => {
    const r = ev.reason as { message?: string } | undefined;
    note('error', { message: r && r.message ? r.message : String(ev.reason), kind: 'rejection' });
  });
  let rt = 0;
  window.addEventListener('resize', () => {
    if (rt) window.clearTimeout(rt);
    rt = window.setTimeout(() => note('resize', { w: window.innerWidth, h: window.innerHeight }), 120);
  });

  // 心跳：后端只要把 want 立起来，页面自己抓一份送上去 —— 于是"看一眼现场"由调用的那一端发起，
  // 不需要他按键、不需要他粘贴。只在装了探针的页面上跑，且只读布局，不改任何东西。
  probePullWatch();

  // 实时巡检回路：外部发一行表达式，这一页就地求值回传。于是"读现在的状态"不必先存一份快照 ——
  // 就像 F12，只是那一端在我这里。
  installLive();

  note('probe.install', { build: PROBE_BUILD, w: window.innerWidth, h: window.innerHeight });
}
