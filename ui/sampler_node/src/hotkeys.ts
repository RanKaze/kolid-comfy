// ── 全局热键 ────────────────────────────────────────────────────────────────────────────────
// 这一页有一个坑，而且它长得像"快捷键没绑上"：
//
// 工作台（Blend 画布）是一个**同源 iframe**，鼠标一进去，宿主就主动把焦点交给它
// （见 EditPhase 的 frame layer：`contentWindow.focus()` —— 那是为了让画布里的 Ctrl/Z、Esc 能响）。
// 从那一刻起，键盘事件发生在 iframe 自己的 document 里，宿主 `window` 上的 keydown **一发都收不到**。
// 于是"鼠标停在画布上时 Alt+P 没反应、移到面板上就正常"—— 键一直绑着，只是没被送到绑它的那一边。
//
// 所以热键只走这一个入口：宿主 document + 每一个能读到 `contentDocument` 的 iframe，
// 一律**捕获阶段**监听（捕获先于任何 target handler 上的 stopPropagation，也先于画布自己的键处理）。
// 跨源 iframe 读不到 document 就不装，静默跳过 —— 那不是能修的东西，硬修只会变成 try/catch 噪音。
//
// 关于 `key` 与 `code` 的第三条路：macOS 上 Option 是排版键，Option+P 打出来的是 `π`，
// 此时 `e.key` 根本不是 'p'；键盘布局不同时 `e.code` 也可能不是 `KeyP`。两个都认，才不会
// 出现"只有我这台机器上能用"的热键。

export type GlobalKeyHandler = (e: KeyboardEvent) => void;

const handlers = new Set<GlobalKeyHandler>();
const handlersUp = new Set<GlobalKeyHandler>();
// 每一帧已经桥过的 document。换页会换掉 document（about:blank → 真页面），所以记的是 doc 而不是帧。
const bridged = new WeakMap<HTMLIFrameElement, Document>();
const loadBound = new WeakSet<HTMLIFrameElement>();
let observer: MutationObserver | null = null;
let scanTimer = 0;
let bound = false;

const dispatch = (e: KeyboardEvent): void => {
  // 拷贝一份再遍历：监听里注册/注销自己（比如切换模式时重建）不该让这一轮少听一个人。
  for (const h of [...handlers]) {
    try { h(e); } catch { /* 一个监听炸了，不该让其他热键跟着哑掉 */ }
  }
};
const dispatchUp = (e: KeyboardEvent): void => {
  for (const h of [...handlersUp]) {
    try { h(e); } catch { /* 同上 */ }
  }
};

const bridge = (f: HTMLIFrameElement): void => {
  if (!loadBound.has(f)) {
    loadBound.add(f);
    // 同源 iframe 每一次导航都换一扇 document，监听得跟着搬。重复调用是安全的：下面按 doc 去重。
    f.addEventListener('load', () => bridge(f));
  }
  let doc: Document | null = null;
  try { doc = f.contentDocument; } catch { doc = null; }
  if (!doc || bridged.get(f) === doc) return;
  bridged.set(f, doc);
  doc.addEventListener('keydown', dispatch, true);
  // keyup 也要桥 —— "按住某键"的手势（C = 剃刀）必须知道松手；焦点在画布里时它同样只到
  // iframe 的 document。
  doc.addEventListener('keyup', dispatchUp, true);
};

const scan = (): void => {
  document.querySelectorAll('iframe').forEach(f => bridge(f as HTMLIFrameElement));
};

// 合并一次：MutationObserver 在这页上会被画布的各种重绘刷屏，而"有没有新 iframe"一两百毫秒问一次就够。
const scheduleScan = (): void => {
  if (scanTimer) return;
  scanTimer = window.setTimeout(() => { scanTimer = 0; scan(); }, 120);
};

const bind = (): void => {
  if (bound) return;
  bound = true;
  document.addEventListener('keydown', dispatch, true);
  document.addEventListener('keyup', dispatchUp, true);
  scan();
  window.addEventListener('load', scan);
  // iframe 是随页面长出来的（prompt 编辑器、preset 编辑器各一扇），长出一层就补一次桥。
  observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
};

/**
 * 注册一个全局键盘监听，返回注销函数。宿主与页面里所有同源 iframe 的 keydown 都会到这里。
 *
 * 只由"模式级"的热键使用（Alt+P 这类），不要拿它做高频或需要知道焦点的键处理 ——
 * 这里刻意不区分事件来自哪个 window：对一个全局模式来说，用户在哪里按都一样。
 */
export function onGlobalKey(handler: GlobalKeyHandler): () => void {
  handlers.add(handler);
  bind();
  return () => { handlers.delete(handler); };
}

/** 松开键的回程（"按住某键"的手势要 `onGlobalKey` + 这个配对用）。窗口失焦时不会有 keyup ——
 *  调用方自己再挂一个 blur 兜底，别让状态卡在"按住"。 */
export function onGlobalKeyUp(handler: GlobalKeyHandler): () => void {
  handlersUp.add(handler);
  bind();
  return () => { handlersUp.delete(handler); };
}

/** `e.key` 或物理键位任一命中就算按下（macOS 的 Option 会把 key 变成符号，见文件头）。 */
export const keyIs = (e: KeyboardEvent, key: string): boolean => {
  const k = (e.key || '').toLowerCase();
  if (k === key) return true;
  return key.length === 1 && e.code === 'Key' + key.toUpperCase();
};
