// ── 文档窗的跨窗口 workbench 引擎 ──────────────────────────────────────────────────────────
// 一扇文档窗弹进 owned 子窗口之后，子窗口里要有一台**自己的** workbench（iframe 从零开始
// 加载），而不是把主页面那台搬过去 —— 跨 document 搬 iframe 会重载，所有打开的工程都会没。
// 交接的是 .cud 字节：主引擎 buildCudBlob → 宿主 → 子引擎 openCudDocument，uid 双方一致，
// 所以宿主已有的按 uid 分桶的状态/消息不用改口径。
//
// 这个模块只管三件事：
//   * 子引擎 iframe 的登记、消息桥（子引擎的 parent 是弹窗，不是本页）；
//   * 导出/载入两条控制请求的请求-应答配对（reqId）；
//   * 按 uid 选目标引擎（宿主发命令时用）。
// 业务状态仍在 App/EditPhase 里；这里不认识文档，只认识 uid 和窗口。
type Control = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  expect: string;
  timer: ReturnType<typeof setTimeout>;
};

export type ChildEngine = {
  uid: number;
  win: Window;
  iframe: HTMLIFrameElement;
  listener: (e: MessageEvent) => void;
  ready: boolean;
  opened: boolean;
  transferring: boolean;
  childDocs: any[];
};

export type EngineMessageSink = (data: any, source: Window) => void;
export type ChildDocsSink = (uid: number, docs: any[], activeUid: number | null, busy: boolean) => void;
export type ChildReadySink = (uid: number) => void;

const children = new Map<number, ChildEngine>();
const detached = new Set<number>();
const handoffs = new Map<number, Promise<void>>();
const pending = new Map<number, Control>();
const sinks = new Set<EngineMessageSink>();
const docsSinks = new Set<ChildDocsSink>();
const readySinks = new Set<ChildReadySink>();
let local: HTMLIFrameElement | null = null;
let activeUid: number | null = null;
let seq = 0;

const post = (win: Window | null | undefined, msg: any, transfer?: Transferable[]) => {
  if (!win) return false;
  try { win.postMessage(msg, '*', transfer); return true; } catch { return false; }
};

export const setLocalIframe = (el: HTMLIFrameElement | null): void => { local = el; };
export const localIframe = (): HTMLIFrameElement | null => local;
export const setActiveUid = (uid: number | null): void => { activeUid = uid; };
export const activeEngineUid = (): number | null => activeUid;
export const isDetached = (uid: number | null | undefined): boolean =>
  typeof uid === 'number' && children.has(uid);
export const childIds = (): number[] => [...children.keys()];

export const onEngineMessage = (fn: EngineMessageSink): (() => void) => {
  sinks.add(fn);
  return () => { sinks.delete(fn); };
};
export const onChildDocs = (fn: ChildDocsSink): (() => void) => {
  docsSinks.add(fn);
  return () => { docsSinks.delete(fn); };
};
export const onChildReady = (fn: ChildReadySink): (() => void) => {
  readySinks.add(fn);
  return () => { readySinks.delete(fn); };
};

/** 宿主发命令：消息自带 uid 就按 uid 选引擎，否则走当前活跃引擎。 */
export const sendForUid = (msg: any, uid?: number | null, transfer?: Transferable[]): void => {
  const target = typeof uid === 'number' ? uid : activeUid;
  const child = typeof target === 'number' ? children.get(target) : undefined;
  if (child) post(child.iframe.contentWindow, msg, transfer);
  else post(local?.contentWindow, msg, transfer);
};

export const sendActive = (msg: any, transfer?: Transferable[]): void => sendForUid(msg, activeUid, transfer);
export const sendLocal = (msg: any, transfer?: Transferable[]): void => {
  post(local?.contentWindow, msg, transfer);
};

export const isEngineSource = (win: Window | null | undefined): boolean => {
  if (!win) return false;
  if (local?.contentWindow === win) return true;
  for (const c of children.values()) if (c.iframe.contentWindow === win) return true;
  return false;
};

export const engineWindow = (uid?: number | null): Window | null => {
  const target = typeof uid === 'number' ? uid : activeUid;
  const child = typeof target === 'number' ? children.get(target) : undefined;
  return child ? child.iframe.contentWindow : (local?.contentWindow ?? null);
};

/** 子窗口里那台 workbench 的 iframe 挂上时登记。弹窗就是它的 parent。 */
export const registerChild = (uid: number, win: Window, iframe: HTMLIFrameElement): void => {
  unregisterChild(uid);
  const listener = (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow) return;
    const data = e.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'blend-pong' || data.type === 'blend-cud-detached' || data.type === 'blend-cud-opened') {
      const p = pending.get(data.reqId);
      if (p && p.expect === data.type) {
        pending.delete(data.reqId);
        clearTimeout(p.timer);
        if (data.error) p.reject(new Error(String(data.error)));
        else p.resolve(data);
      }
      return;
    }
    if (data.type === 'blend-docs') {
      const c = children.get(uid);
      if (!c || c.transferring) return;      // 交接途中两边都还没定型，别拿半份表去改宿主记录
      const docs = Array.isArray(data.docs) ? data.docs : [];
      if (!c.opened) {
        // 子引擎 boot 时那份 Untitled 不是我们的文档：等它真把 uid 那份打开再开始报。
        if (!docs.some((d: any) => d.uid === uid)) return;
        c.opened = true;
      }
      const au = typeof data.activeUid === 'number' ? data.activeUid : null;
      for (const fn of docsSinks) { try { fn(uid, docs, au, data.busy === true); } catch { /* ignore */ } }
      return;
    }
    for (const fn of sinks) { try { fn(data, iframe.contentWindow!); } catch { /* one bad panel must not stop the rest */ } }
  };
  win.addEventListener('message', listener);
  children.set(uid, { uid, win, iframe, listener, ready: false, opened: false, transferring: false, childDocs: [] });
};

export const unregisterChild = (uid: number): void => {
  const c = children.get(uid);
  if (c) {
    try { c.win.removeEventListener('message', c.listener); } catch { /* window gone */ }
    children.delete(uid);
  }
  detached.delete(uid);
  handoffs.delete(uid);
};

/** 子窗口没了（用户直接关窗 / 泊回）：宿主侧把这条引擎忘掉，别再往空窗口发命令。 */
export const forgetChild = (uid: number): void => { unregisterChild(uid); };

const request = (target: 'local' | number, msg: any, expect: string, timeout = 30000): Promise<any> => {
  const reqId = ++seq;
  const child = typeof target === 'number' ? children.get(target) : null;
  const win = child ? child.iframe.contentWindow : local?.contentWindow;
  if (!win) return Promise.reject(new Error('workbench window is gone'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error(`workbench did not answer ${expect}`));
    }, timeout);
    pending.set(reqId, { resolve, reject, expect, timer });
    try { win.postMessage(Object.assign({}, msg, { reqId }), '*'); }
    catch (e) {
      pending.delete(reqId);
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
};

// 本地引擎的握手/控制回包也走同一条 window 消息通道；把控制应答从业务消息里摘出来。
if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    const data = e.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== 'blend-pong' && data.type !== 'blend-cud-detached' && data.type !== 'blend-cud-opened') return;
    const p = pending.get(data.reqId);
    if (!p || p.expect !== data.type) return;
    pending.delete(data.reqId);
    clearTimeout(p.timer);
    if (data.error) p.reject(new Error(String(data.error)));
    else p.resolve(data);
  });
}

const waitReady = async (uid: number): Promise<void> => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      await request(uid, { type: 'blend-ping' }, 'blend-pong', 700);
      const c = children.get(uid);
      if (c) c.ready = true;
      for (const fn of readySinks) { try { fn(uid); } catch { /* ignore */ } }
      return;
    } catch { /* the page may still be booting; ping again */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('the detached workbench did not come up');
};

/** 主引擎 → 子引擎。同一 uid 只做一次（StrictMode / 重渲都会重复调这里）。 */
export const detachToChild = (uid: number, win: Window, iframe: HTMLIFrameElement): Promise<void> => {
  if (detached.has(uid)) return Promise.resolve();
  const running = handoffs.get(uid);
  if (running) return running;
  const p = (async () => {
    registerChild(uid, win, iframe);
    await waitReady(uid);
    const out = await request('local', { type: 'blend-cud-detach', uid }, 'blend-cud-detached', 60000);
    try {
      const opened = await request(uid, {
        type: 'blend-cud-open', uid, name: out.name, bytes: out.bytes, doc: out.doc || null, dropBoot: true,
      }, 'blend-cud-opened', 60000);
      if (opened.uid !== uid) throw new Error('the detached workbench assigned a different uid');
      const c = children.get(uid);
      if (c) c.opened = true;
      detached.add(uid);
    } catch (e) {
      // 子引擎打不开：把字节在主引擎里原样重开（同 uid），不让用户丢文档。
      try {
        await request('local', { type: 'blend-cud-open', uid, name: out.name, bytes: out.bytes, doc: out.doc || null, dropBoot: false }, 'blend-cud-opened', 60000);
      } catch { /* the doc is gone from both engines; report below */ }
      unregisterChild(uid);
      throw e;
    }
  })();
  handoffs.set(uid, p);
  p.catch(() => { handoffs.delete(uid); });
  p.then(() => { handoffs.delete(uid); }).catch(() => { /* already handled */ });
  return p;
};

/** 子引擎 → 主引擎（泊回）。成功后宿主应删掉 detached 记录。 */
export const dockBackToLocal = async (uid: number): Promise<void> => {
  const child = children.get(uid);
  if (!child) { detached.delete(uid); return; }
  child.transferring = true;
  let out;
  try {
    out = await request(uid, { type: 'blend-cud-detach', uid }, 'blend-cud-detached', 60000);
  } catch (e) {
    child.transferring = false;
    throw e;
  }
  try {
    await request('local', {
      type: 'blend-cud-open', uid, name: out.name, bytes: out.bytes, doc: out.doc || null, dropBoot: false,
    }, 'blend-cud-opened', 60000);
  } catch (e) {
    child.transferring = false;
    // 主引擎没接住：把字节退回子引擎，别让窗口关掉时把工程一起带走。
    try {
      await request(uid, { type: 'blend-cud-open', uid, name: out.name, bytes: out.bytes, doc: out.doc || null, dropBoot: false }, 'blend-cud-opened', 60000);
    } catch { /* both sides refused — surface the original error */ }
    throw e;
  }
  unregisterChild(uid);
};
