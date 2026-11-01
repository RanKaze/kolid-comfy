// ── 传输归属：哪一扇窗说了算 ────────────────────────────────────────────────────────────────
//
// 同一份工作台可能开着好几扇窗（每个 dock 窗口一个 sampler_node.html）。共享的只有后端那只钟
// 与原生引擎，页面里的时间线声音、循环回绕、片尾停止却是每扇窗各跑一份 —— 后开的窗会在
// 别人播放时按**自己**那份工程的片尾把钟按停，几扇窗还会同时播放同一段音频。
//
// 规矩：**用户在哪扇窗动传输，那扇窗就成为归属者**。归属者的自动动作（回绕、片尾停止、
// 被抢音频槽时的暂停）才允许改共享时钟；别的窗只读。
//
// 跨窗口用 BroadcastChannel 广播（同源、不经过后端）；新开的窗先喊一声 `who`，现有归属者
// 回一声 `claim`，所以后开的窗不会误以为自己说了算、也不会把正在播的音掐掉。

type Msg =
  | { type: 'claim'; id: string; at: number }
  | { type: 'release'; id: string }
  | { type: 'who'; id: string };

const CHANNEL = 'kolid.transport.owner';
const selfId = (() => {
  try { return crypto.randomUUID(); } catch { return 'p' + Math.random().toString(36).slice(2); }
})();

/** null = 还没人认领（单窗/没播过）—— 这时按老规矩谁都算。 */
let owner: string | null = null;
let lastClaimAt = 0;
let lastMsg = '';
let ch: BroadcastChannel | null = null;

const post = (m: Msg): void => {
  try { ch?.postMessage(m); } catch { /* 通道关了：退回单窗语义 */ }
};

if (typeof BroadcastChannel !== 'undefined') {
  try {
    ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = (ev: MessageEvent<Msg>) => {
      const m = ev.data;
      if (!m || typeof m !== 'object') return;
      lastMsg = (m.type + ':' + m.id.slice(0, 6) + ':' + String((m as { at?: number }).at || ''));
      if (m.type === 'claim' && m.id !== selfId) {
        if (m.at >= lastClaimAt) { lastClaimAt = m.at; owner = m.id; }
      } else if (m.type === 'release' && m.id === owner) {
        owner = null;
      } else if (m.type === 'who' && m.id !== selfId && owner === selfId) {
        post({ type: 'claim', id: selfId, at: lastClaimAt || Date.now() });
      }
    };
    post({ type: 'who', id: selfId });
    // 通道刚建好时对面可能还在起页：再问一声，别让后开的窗误以为自己说了算。
    setTimeout(() => post({ type: 'who', id: selfId }), 600);
  } catch {
    ch = null;
  }
}

export const transportOwner = {
  /** 用户动传输：这扇窗从现在起说了算。 */
  claim(): void {
    const at = Date.now();
    if (owner === selfId && at - lastClaimAt < 250) return;   // 拖动时别每帧广播
    owner = selfId;
    lastClaimAt = at;
    post({ type: 'claim', id: selfId, at });
  },
  /** 自动动作（回绕 / 片尾停止 / 抢槽）该不该由这扇窗执行。 */
  isOwner(): boolean {
    return owner === null || owner === selfId;
  },
  /** 页面要走：把归属交出去，别让共享时钟停在一个没人管的归属者名下。 */
  release(): void {
    if (owner !== selfId) return;
    owner = null;
    post({ type: 'release', id: selfId });
  },
  /** 诊断：现在归属是谁（'self' / 'other' / 'none'）。 */
  debug(): { owner: 'self' | 'other' | 'none'; self: string; lastMsg: string } {
    return {
      owner: owner === null ? 'none' : (owner === selfId ? 'self' : 'other'),
      self: selfId.slice(0, 6),
      lastMsg,
    };
  },
};

if (typeof window !== 'undefined') {
  // 归属 = **用户在这扇窗里动过**（点、拖、滚、按键），不是"这扇窗发过传输命令"。
  // 宿主/后端在挂载时会程序化 seek 或按停；那种调用不该把归属从正在播的那扇窗抢走。
  const touch = (): void => transportOwner.claim();
  window.addEventListener('pointerdown', touch, { capture: true, passive: true });
  window.addEventListener('keydown', touch, { capture: true, passive: true });
  window.addEventListener('wheel', touch, { capture: true, passive: true });
  window.addEventListener('pagehide', () => transportOwner.release());
  // 诊断口：多窗问题时先问"现在谁说了算"，别靠猜。
  (window as unknown as Record<string, unknown>).__kolidTransportOwner = transportOwner;
}
