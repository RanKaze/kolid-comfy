import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DockCtx } from './DockView';
import { dockBackDock, dockAllFloatsBack, setFloatDockAt } from './model';
import { DockDocumentContext } from './docScope';
import { transportOwner } from '../midi/transportOwner';
import { dockChildWindows } from './hostMode';

// ── Kolid Desktop 的 owned 子窗口 ──────────────────────────────────────────────────────────
// 窗口化只属于 Kolid Desktop（壳页回过 hostHello，见 hostMode.ts）；浏览器 / 普通 iframe 里
// 没有浮窗，也没有"嵌入式的子窗口"，一律泊回布局。Desktop 里：
//   * 本模块负责 window.open / 文档骨架 / 关闭检测 / 样式搬运；
//   * DockView 把那一扇窗的正文包在 ChildWindowHost 里，用 React portal 画进弹窗文档；
//   * 存档只记得 `child` 与 `win`，窗口本身是运行时的 —— 刷新/唤回时由 ChildWindowHost 补开。
//   * client/kolid_client.py 的 NewWindowRequested 把弹窗托进一个主窗口拥有的无边框 Form。
//
// 弹窗的初始文档在宿主接管（args.NewWindow）之后会被 about:blank 导航换掉 —— 实测
// 立即写入会被擦。所以初始化不是一个 if，而是一个“写入→观察两拍还在→才算数”的
// 小循环（ensure 的 stable 计数）；文档被换掉就重建，并把 portal 重新挂到新根上。

const ROOT_ID = 'kolid-dock-root';
const CHILD_STYLE_ID = 'kolid-dock-base';
const INSTANCE = Math.random().toString(36).slice(2, 8);

// 窗口的身份是 `key`（DockFloat.win，或者老形状的单元 id）—— 不跟某颗 tab 走：锚点被拖走时
// 这扇窗还是这一扇，不会因为"第一个单元换人了"而变成另一扇。
type ChildEntry = { id: string; win: Window; closing: boolean; seq: number };
const entries = new Map<string, ChildEntry>();
let seq = 0;

const childName = (id: string): string => `kolid-dock:${INSTANCE}:${id}`;

/** 这页是不是画在宿主（壳页）的 iframe 里。普通浏览器里直接打开节点页时 `parent === window`，
 *  永远不会收到 hostHello —— 也就永远没有窗口化，不必等满握手超时才泊回。 */
const hostPossible = (): boolean => {
  try { return window.parent !== window; } catch { return true; }
};

const spot = (w: number, h: number, host: Window, at?: { x?: number; y?: number }): { left: number; top: number } => {
  const sx = Number.isFinite(host.screenX) ? host.screenX : 120;
  const sy = Number.isFinite(host.screenY) ? host.screenY : 120;
  // `host.screen` 可能和主页面的不是同一块屏（子窗口被拖到别处了）；按宿主窗口自己的屏算。
  const availW = host.screen?.availWidth ?? screen.availWidth;
  const availH = host.screen?.availHeight ?? screen.availHeight;
  // 工作区不等于"从 0 开始的那块屏"：宿主在副屏时 screenX 可以大于 availW。按 availLeft/
  // availTop 起算，否则松开的位置会被夹回主屏右缘，窗口"自己跑掉"。（这两个字段 TS 的
  // Screen 类型里没有，Chromium 有。）
  const sc = host.screen as Screen & { availLeft?: number; availTop?: number };
  const availLeft = Number.isFinite(sc?.availLeft) ? (sc.availLeft as number) : 0;
  const availTop = Number.isFinite(sc?.availTop) ? (sc.availTop as number) : 0;
  // 存档里的 x/y 是**宿主窗口视口里**的坐标（页面内浮窗用的就是这一套），搬到屏幕上要加宿主的
  // screenX/screenY；重新打开一扇窗时才能回到原来那块地方，而不是每次都从级联位开始。
  const left = Number.isFinite(at?.x) ? sx + (at!.x as number) : sx + 72 + (seq % 7) * 24;
  const top = Number.isFinite(at?.y) ? sy + (at!.y as number) : sy + 96 + (seq % 7) * 24;
  // 存档位置是用户亲手摆的（由 _child_geom 记下来），不再夹 —— 夹一次就把"上次的位置"
  // 改成了别处。只做防呆；级联位才夹进宿主那块屏的工作区。
  if (Number.isFinite(at?.x) && Number.isFinite(at?.y)) {
    return {
      left: Math.round(Math.max(-32000, Math.min(left, 32000))),
      top: Math.round(Math.max(-32000, Math.min(top, 32000))),
    };
  }
  return {
    left: Math.round(Math.max(availLeft + 8, Math.min(left, availLeft + availW - w - 8))),
    top: Math.round(Math.max(availTop + 8, Math.min(top, availTop + availH - h - 8))),
  };
};

/** 打开一扇 owned 子窗口。失败（弹窗被拦 / 宿主不在）返回 null —— 调用方**不再**回退页面内浮窗：
 *  窗口化只属于 Kolid Desktop，开不出来就什么都不做（见 DockView.popOut）。
 *  `parent` 是发起它的那个窗口：子窗口里再弹出的一扇，归**那个** owned 窗口所有（嵌套），
 *  在 Kolid Desktop 里也由它作为 owner（关掉父窗，子窗跟着走）。
 *  `at` 是存档里那扇窗的位置（宿主视口坐标）；开机/唤回时用它，新弹出一扇时不传（级联位）。 */
export const openDockChild = (id: string, title: string, w: number, h: number, parent?: Window,
  at?: { x?: number; y?: number }): Window | null => {
  const have = entries.get(id);
  if (have) {
    try { have.win.focus(); } catch { /* focus is best-effort */ }
    return have.win;
  }
  const host = parent ?? window;
  const s = spot(w, h, host, at);
  let win: Window | null = null;
  try {
    win = host.open('', childName(id),
      `popup=yes,width=${Math.round(w)},height=${Math.round(h)},left=${s.left},top=${s.top}`);
  } catch { win = null; }
  if (!win) return null;
  seq += 1;
  const entry: ChildEntry = { id, win, closing: false, seq };
  entries.set(id, entry);
  try { win.document.title = title; } catch { /* the host may replace the document later */ }
  return win;
};

export const childWindowOpen = (id: string): Window | null => entries.get(id)?.win ?? null;

/** 关掉某一扇子窗口。`closing` 让它的关闭回调不要把单元再泊一次（调用方自己决定）。 */
export const closeDockChild = (id: string): void => {
  const e = entries.get(id);
  if (!e) return;
  e.closing = true;
  entries.delete(id);
  try { if (!e.win.closed) e.win.close(); } catch { /* already gone */ }
};

/** dock 里还留着 `keep` 里的子窗口；其余关掉（泊回 / 重置 / 单元消失都走这一条）。 */
export const closeChildrenNotIn = (keep: ReadonlySet<string>): void => {
  for (const id of [...entries.keys()]) if (!keep.has(id)) closeDockChild(id);
};

export const closeAllDockChildren = (): void => {
  for (const id of [...entries.keys()]) closeDockChild(id);
};

const copyStyles = (doc: Document): void => {
  if (doc.getElementById(CHILD_STYLE_ID)) return;
  for (const node of Array.from(document.querySelectorAll('style,link[rel="stylesheet"]'))) {
    if (node.tagName === 'STYLE') {
      const el = doc.createElement('style');
      el.textContent = (node as HTMLStyleElement).textContent ?? '';
      doc.head.appendChild(el);
    } else {
      const src = node as HTMLLinkElement;
      const el = doc.createElement('link');
      el.rel = 'stylesheet';
      el.href = src.href;
      doc.head.appendChild(el);
    }
  }
  const base = doc.createElement('style');
  base.id = CHILD_STYLE_ID;
  base.textContent = [
    'html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#141416;color:#eee;}',
    `#${ROOT_ID}{position:absolute;inset:0;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;}`,
    '::-webkit-scrollbar{width:8px;height:8px;}',
    '::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:4px;}',
    '::-webkit-scrollbar-track{background:transparent;}',
  ].join('\n');
  doc.head.appendChild(base);
};

/** 写入（或找回）子窗口文档的根。返回 portal 的挂载点。 */
const ensureChildRoot = (win: Window, title: string): HTMLElement | null => {
  let doc: Document;
  try { doc = win.document; } catch { return null; }
  if (!doc || doc.readyState === 'loading') return null;
  let root = doc.getElementById(ROOT_ID);
  if (!root) {
    try {
      doc.open();
      doc.write('<!doctype html><html><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>');
      doc.close();
    } catch { /* the popup may be mid-navigation; the caller retries */ return null; }
    const base = doc.createElement('base');
    base.href = document.baseURI;
    doc.head.appendChild(base);
    copyStyles(doc);
    root = doc.createElement('div');
    root.id = ROOT_ID;
    doc.body.appendChild(root);
  }
  try { if (title) doc.title = title; } catch { /* replaced document race */ }
  return root as HTMLElement;
};

// 页面消失（刷新 / 关页签 / 壳页摘 iframe）时把还开着的子窗口一起收掉。主窗口销毁时
// owned 窗口本来也会跟着走，但正常刷新时主窗体还在，不收就会留下一扇孤儿窗。
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', closeAllDockChildren);
  window.addEventListener('beforeunload', closeAllDockChildren);
}

// 子窗口里没有主页面那套全局快捷键（Ctrl+Z / Space / Alt+* 都挂在主页面的 window 上）。
// 子窗口有焦点时，把不落在输入控件里的按键原样补发到主窗口 —— 只做按键，不做指针：
// 指针手势归组件自己（配合 docScope 的宿主 document），补发指针会把坐标体系搞混。
const forwardKeys = (doc: Document): (() => void) => {
  const onKey = (e: KeyboardEvent) => {
    const ae = doc.activeElement as HTMLElement | null;
    const tag = (ae?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae?.isContentEditable) return;
    if ((e.key === ' ' || e.key === 'Enter') && (tag === 'BUTTON' || tag === 'A')) return;
    try {
      window.dispatchEvent(new KeyboardEvent(e.type, {
        key: e.key, code: e.code, location: e.location, repeat: e.repeat,
        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
        bubbles: true, cancelable: true,
      }));
    } catch { /* KeyboardEvent ctor is always available in WebView2 */ }
  };
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('keyup', onKey, true);
  return () => {
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('keyup', onKey, true);
  };
};

/** 一扇子窗口的宿主：把 children 画进弹窗文档，弹窗关掉 = 单元泊回布局 / 隐藏。 */
export const ChildWindowHost: React.FC<{
  /** DockFloat 的稳定窗口名（floatKey）。 */
  id: string;
  ctx: DockCtx;
  title: string;
  /** 这条浮窗记录里的尺寸 / 位置：开机或从 Layout 唤回时把窗口摆回原处。 */
  w: number;
  h: number;
  x?: number;
  y?: number;
  children: React.ReactNode;
}> = ({ id, ctx, title, w, h, x, y, children }) => {
  const entry = useRef<ChildEntry | undefined>(entries.get(id));
  const tried = useRef(false);
  // 宿主能力是异步握手来的（index.html 里的 hostPing / hostHello）：开机头一帧它可能还是假的。
  const waiting = useRef(false);
  const retry = useRef<number | null>(null);
  // 握手成功要**重跑**下面这段 effect 才会去接管窗口文档。只 bump 一下渲染是不够的 ——
  // effect 的依赖里必须有这个数，否则补开的那扇窗会一直空着（没人往里画）。
  const [gen, setGen] = useState(0);
  const [mount, setMount] = useState<{ doc: Document; root: HTMLElement; n: number } | null>(null);
  useEffect(() => () => { if (retry.current) window.clearTimeout(retry.current); }, []);

  useLayoutEffect(() => {
    let e = entry.current;
    // 刷新 / 隐藏后再从 Layout 叫回来：浮窗记录还在，但它的 OS 窗口不在（entries 只在内存里，
    // 存档记的是 `child` + `win`）。这里补开一扇。
    if ((!e || e.win.closed) && !tried.current) {
      tried.current = true;
      if (dockChildWindows()) {
        openDockChild(id, title, w, h, ctx.win, { x, y });
        e = entries.get(id);
        entry.current = e;
      } else if (!hostPossible()) {
        // 顶层页面（普通浏览器）：这里永远不会有宿主，窗口化不存在 —— 立刻泊回布局，
        // 不用等握手超时把浮窗在页面上晾几秒。**不落盘**：这份存档是 Desktop 摆的，
        // 浏览器里看一眼不该把它改掉（下次在 Desktop 打开，窗口还要回到原位）。
        ctx.setDock(prev => dockAllFloatsBack(prev), false);
        return;
      } else {
        // 还没等到 hostHello。等几拍：Desktop 会回话并把窗口开出来；一直不回（普通浏览器的
        // iframe / 嵌页）就把这整条浮窗记录泊回主布局 —— 窗口化只属于 Desktop，不存在嵌入式
        // 的子窗口。握手是 0/350/900/1800/3200ms 五次 ping，等 6s 足够跨过最后一拍。
        waiting.current = true;
        let left = 24;
        const step = () => {
          if (entries.has(id)) { waiting.current = false; entry.current = entries.get(id); setGen(n => n + 1); return; }
          if (dockChildWindows()) {
            waiting.current = false;
            openDockChild(id, title, w, h, ctx.win, { x, y });
            entry.current = entries.get(id);
            setGen(n => n + 1);
            return;
          }
          if (left-- <= 0) {
            waiting.current = false;
            ctx.setDock(prev => dockAllFloatsBack(prev), false);
            return;
          }
          retry.current = window.setTimeout(step, 250);
        };
        retry.current = window.setTimeout(step, 250);
      }
    }
    if (waiting.current) return;  // 等握手中：先不画，也别判死
    if (!e || e.win.closed) {
      // 开机 / 从 Layout 唤回时这扇窗开不出来（宿主没有窗口化能力，或开窗被拒）：泊回布局总比
      // 把面板藏起来好。用户自己关掉窗（onGone 已经删了 entry）走下面那条收尾。
      if (tried.current && !entry.current) {
        ctx.setDock(prev => dockAllFloatsBack(prev), false);
        return;
      }
      // 没有窗口可用：这条浮窗记录无法成立。页面（EditPhase）知道怎么收尾 —— 文档引擎、隐藏、
      // 泊回都由它一个人决定；没有那个回调时退回"把这一格泊回布局"。
      if (ctx.onChildClosed) ctx.onChildClosed(id);
      else ctx.setDock(prev => dockBackDock(prev, id));
      return;
    }
    const win = e.win;
    // ── 把宿主窗口的几何写回布局 ────────────────────────────────────────────────────────
    // 子窗口是 WinForms 的 Form：大小/位置归宿主，页面既收不到 move 事件，也读不到可靠的
    // `screenX`（Chromium 只在宿主主动 Notify 时才更新）。所以走「页面 → 壳页 → 客户端
    // /api/dock_child_geom」这一趟，按拍子取**真实**几何（GetWindowRect，纯 Win32），变了就
    // 写回这条浮窗记录。不这么做，用户改完大小/位置、关掉再从 Layout 唤回，看到的还是第一次
    // 弹出时的尺寸和位置 —— 那正是"持久化没生效"。
    // 手还在动时 `persist=false`（只更新内存里的那份布局）；停手 600ms 才落盘一次。
    const geomName = childName(id);
    let geo = { x, y, w, h } as { x?: number; y?: number; w: number; h: number };
    let saveTimer = 0;
    const onGeom = (ev: MessageEvent) => {
      const d = ev.data as { __kolid?: string; name?: string; x?: number; y?: number; w?: number; h?: number };
      if (!d || d.__kolid !== 'dockGeom' || d.name !== geomName) return;
      const next = { x: d.x, y: d.y, w: d.w as number, h: d.h as number };
      const nums = [next.x, next.y, next.w, next.h];
      if (!nums.every(v => typeof v === 'number' && Number.isFinite(v)) || next.w < 1 || next.h < 1) return;
      if (next.x === geo.x && next.y === geo.y && next.w === geo.w && next.h === geo.h) return;
      geo = next;
      ctx.setDock(prev => setFloatDockAt(prev, id, next), false);
      if (saveTimer) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        saveTimer = 0;
        ctx.setDock(prev => setFloatDockAt(prev, id, geo), true);
      }, 600);
    };
    window.addEventListener('message', onGeom);
    const ask = () => {
      try { window.parent.postMessage({ __kolid: 'dockGeomGet', name: geomName }, '*'); } catch { /* 顶层页面 */ }
    };
    ask();
    const askTimer = window.setInterval(ask, 500);
    let cancelled = false;
    let attempts = 0;
    let lastDoc: Document | null = null;
    let lastRoot: HTMLElement | null = null;
    let same = 0;

    const dockBack = () => {
      if (e.closing) return;
      e.closing = true;
      entries.delete(id);
      // 文档引擎那类子窗口被直接关掉时，页面需要先收掉它的 detached 记录；
      // 普通面板直接泊回即可。
      if (ctx.onChildClosed) ctx.onChildClosed(id);
      else ctx.setDock(prev => dockBackDock(prev, id));
    };

    const tick = () => {
      if (cancelled) return;
      let doc: Document | null = null;
      try { doc = win.document; } catch { doc = null; }
      if (doc && doc.readyState !== 'loading') {
        const root = ensureChildRoot(win, title);
        if (root) {
          if (lastDoc === doc && lastRoot === root) same += 1;
          else { lastDoc = doc; lastRoot = root; same = 0; }
          if (same >= 2) {
            setMount(prev => (prev && prev.doc === doc && prev.root === root ? prev : { doc, root, n: ++seq }));
            return;
          }
        }
      }
      attempts += 1;
      if (attempts < 42) setTimeout(tick, 120);
      else if (doc) {
        const root = ensureChildRoot(win, title);
        if (root) setMount({ doc, root, n: ++seq });
      }
    };
    tick();

    const winOn = win as Window & { addEventListener: Window['addEventListener'] };
    const onGone = () => dockBack();
    winOn.addEventListener('pagehide', onGone);
    winOn.addEventListener('beforeunload', onGone);
    // 子窗口失焦（用户点回主窗口）时补一发 blur 给主窗口：还留在主文档上的
    // close-on-blur（菜单、cut 状态、图层悬浮键）与原生行为保持一致。
    const onWinBlur = () => { try { window.dispatchEvent(new Event('blur')); } catch { /* gone */ } };
    winOn.addEventListener('blur', onWinBlur);
    // 子窗口里的点击/滚轮/按键也是"用户在这扇窗里动过"：MIDI 传输的归属（见
    // midi/transportOwner）靠这条在主窗口上的监听判定，弹窗的事件不会自己冒到那边。
    const onActivity = () => transportOwner.claim();
    for (const ev of ['pointerdown', 'wheel', 'keydown'] as const) {
      winOn.addEventListener(ev, onActivity, { capture: true, passive: true });
    }
    const poll = window.setInterval(() => {
      if (win.closed) { window.clearInterval(poll); dockBack(); }
    }, 250);

    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.clearInterval(askTimer);
      if (saveTimer) window.clearTimeout(saveTimer);
      window.removeEventListener('message', onGeom);
      try {
        winOn.removeEventListener('pagehide', onGone);
        winOn.removeEventListener('beforeunload', onGone);
        winOn.removeEventListener('blur', onWinBlur);
        for (const ev of ['pointerdown', 'wheel', 'keydown'] as const) {
          winOn.removeEventListener(ev, onActivity, { capture: true });
        }
      } catch { /* document gone */ }
    };
    // StrictMode dev 下 effect 会走两遍：cleanup 刻意不关窗 —— 关窗只由
    // closeChildrenNotIn（布局里已经没有这条浮窗）或页面卸载负责。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, gen]);

  useEffect(() => {
    if (mount) { try { mount.doc.title = title; } catch { /* replaced */ } }
  }, [mount, title]);

  // 子窗口里的按键补发绑定在“当前文档”上；文档被宿主换掉时重挂。
  useEffect(() => {
    if (!mount) return;
    const off = forwardKeys(mount.doc);
    return off;
  }, [mount]);

  if (!mount) return null;
  return createPortal(
    <DockDocumentContext.Provider key={mount.n} value={mount.doc}>
      {children}
    </DockDocumentContext.Provider>,
    mount.root,
  );
};
