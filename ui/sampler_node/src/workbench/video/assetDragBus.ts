/**
 * 资产卡拖到 Prompt 窗 = 自动打标。这条链跨了**两个 origin**，所以它比看上去要绕。
 *
 * Prompt 页是独立 HTTP 服务（`http://localhost:<prompt端口>`），sampler 页是
 * `http://127.0.0.1:<主端口>`。跨 origin 的拖拽里：`dataTransfer.getData` 读不到自定义 MIME，
 * `dragover` 的 `types` 常是空的，实测在 pywebview 的 iframe 里干脆连 `dragover` 都收不到 ——
 * 于是"拖进去什么也没发生"。
 *
 * 所以落点不交给 Prompt 页判，交给**拖拽发起的那一份文档**（sampler 页）：
 *   1. `beginAssetDrag()` 在拖拽开始时把 Prompt 窗的 iframe 层让开（pointer-events: none）；
 *   2. sampler 页在 document 上接 `dragover`/`drop`，用各窗 wrapper 的 rect 判"落在哪扇窗"；
 *   3. 资产字节也在 sampler 侧读（同源，无 CORS），再 postMessage 给那扇窗；
 *   4. Prompt 页只负责 POST 自己的 `/tag_from_image` 并把结果接进当前选择。
 *
 * `postToPromptWindows` 那条 early 广播保留：Prompt 页自己那份 drop 处理还在（窗口化到
 * owned 子窗时 iframe 不在本页文档里，落点只能由它自己接）。
 */
export type AssetDragPayload = { url: string; name?: string; kind?: string };

export const ASSET_DRAG_CHANNEL = 'kolid-asset-drag';

/** 拖拽载荷的窗口消息标签（sampler → prompt iframe）。 */
export const ASSET_DRAG_MSG = 'kolid-asset-drag';

/** 打标请求的窗口消息标签（sampler → prompt iframe，带资产字节）。 */
export const ASSET_TAG_MSG = 'kolid-asset-tag';

/** 正在拖的资产。拖拽开始置、结束清；只有它有值时 sampler 页才接外部落点。 */
let dragging: AssetDragPayload | null = null;

let ch: BroadcastChannel | null = null;

/** 两扇 Prompt iframe 的 window，按 pane（`manager` / `dock`）登记（React ref 回调里进出）。 */
const promptWindows = new Map<string, Window>();

export function registerPromptWindow(key: string, win: Window | null): void {
  if (win) promptWindows.set(key, win);
  else promptWindows.delete(key);
}

/** 把一条消息投给所有已挂载的 Prompt 窗（跨 origin 也能到）。 */
export function postToPromptWindows(msg: Record<string, unknown>): void {
  for (const win of promptWindows.values()) {
    try { win.postMessage(msg, '*'); } catch { /* 窗口已关 */ }
  }
}

/**
 * 资产字节的**代取服务**（sampler 侧）。
 *
 * 窗口化到 owned 子窗时，Prompt 页自己 `fetch('/api/asset_media/...')` 会撞 CORS：这边替它把
 * 资产读成字节，再用 postMessage 送回去。只认**本页 origin**的地址，别变成任意 URL 的读取器。
 */
let bytesProxyReady = false;
export function installAssetBytesProxy(): void {
  if (bytesProxyReady || typeof window === 'undefined') return;
  bytesProxyReady = true;
  window.addEventListener('message', (ev) => {
    const d = ev.data as { __kolid?: string; id?: string; url?: string };
    if (!d || d.__kolid !== 'kolid-asset-bytes-get' || typeof d.url !== 'string' || !ev.source) return;
    const reply = (msg: Record<string, unknown>) => {
      try { (ev.source as Window).postMessage(msg, '*'); } catch { /* 目标已关 */ }
    };
    let target: URL;
    try { target = new URL(d.url, location.origin); } catch {
      reply({ __kolid: 'kolid-asset-bytes', id: d.id, ok: false, error: 'bad url' });
      return;
    }
    // `localhost` 与 `127.0.0.1` 是同一个服务、同一份资产，但按 origin 算是两家 —— 端口一样
    // 就认，否则资产 URL 里写成 `localhost` 的那一批会被当成外站拒掉。
    if (!sameService(target, location)) {
      reply({ __kolid: 'kolid-asset-bytes', id: d.id, ok: false, error: 'cross-origin url refused' });
      return;
    }
    void (async () => {
      try {
        const res = await fetch(target.href, { cache: 'no-store' });
        if (!res.ok) throw new Error(`asset fetch failed (${res.status})`);
        const bytes = await res.arrayBuffer();
        reply({
          __kolid: 'kolid-asset-bytes', id: d.id, ok: true, bytes,
          contentType: res.headers.get('content-type') || '',
        });
      } catch (err) {
        reply({ __kolid: 'kolid-asset-bytes', id: d.id, ok: false, error: (err as Error).message });
      }
    })();
  });
}
installAssetBytesProxy();

const LOCALS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function sameService(a: URL, b: Location): boolean {
  if (a.port !== b.port) return false;
  if (a.protocol !== b.protocol) return false;
  return a.hostname === b.hostname || (LOCALS.has(a.hostname) && LOCALS.has(b.hostname));
}

/** 卡片开始拖拽时调用（载荷就是卡片那颗 `application/x-asset` 里那份 JSON）。 */
export function beginAssetDrag(payload: AssetDragPayload): void {
  dragging = payload;
  installAssetDropBridge();
  setPanePassthrough(true);
  publishAssetDrag(payload);
}

/** 结束拖拽（松手、取消、被别的窗口吃掉都算）。 */
export function endAssetDrag(): void {
  if (!dragging) return;
  dragging = null;
  setPanePassthrough(false);
  hideHint();
}

/** 同 origin 的情况（浏览器里直接开 sampler 页）BroadcastChannel 便宜且即时。 */
export function publishAssetDrag(payload: AssetDragPayload): void {
  try {
    if (!ch) ch = new BroadcastChannel(ASSET_DRAG_CHANNEL);
    ch.postMessage({ __kolid: 'asset-drag', at: Date.now(), payload });
  } catch { /* 没有 BroadcastChannel：只剩 postMessage / dataTransfer 那两条路 */ }
  postToPromptWindows({ __kolid: ASSET_DRAG_MSG, at: Date.now(), payload });
}

// ── 落点判定 ────────────────────────────────────────────────────────────────────────────────
// iframe 让开之后，指针下面就没有能"证明自己是谁"的元素了（elementFromPoint 会跳到背后那一层），
// 所以按各窗 wrapper 的 rect 判 —— 位置与 pointer-events 无关，拖拽期间也一直有效。

function setPanePassthrough(on: boolean): void {
  document.querySelectorAll<HTMLElement>('[data-prompt-pane]').forEach(el => {
    el.style.pointerEvents = on ? 'none' : '';
  });
}

function paneUnder(x: number, y: number): { key: string; el: HTMLElement } | null {
  let hit: { key: string; el: HTMLElement } | null = null;
  document.querySelectorAll<HTMLElement>('[data-prompt-pane]').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) return;
    hit = { key: el.dataset.promptPane || '', el };
  });
  return hit;
}

let hint: HTMLDivElement | null = null;
function hintEl(): HTMLDivElement {
  if (hint && hint.isConnected) return hint;
  hint = document.createElement('div');
  hint.setAttribute('data-kolid-asset-hint', '');
  hint.textContent = 'Drop image / video to auto-tag';
  Object.assign(hint.style, {
    position: 'fixed', left: '0px', top: '0px', width: '0px', height: '0px',
    zIndex: '2147483000', pointerEvents: 'none', display: 'none',
    alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
    border: '1.5px dashed rgba(10,132,255,0.85)', borderRadius: '10px',
    background: 'rgba(10,132,255,0.08)', color: 'rgba(255,255,255,0.85)',
    font: '600 12px system-ui, sans-serif', letterSpacing: '0.02em',
  });
  document.body.appendChild(hint);
  return hint;
}

function showHint(el: HTMLElement): void {
  const r = el.getBoundingClientRect();
  const h = hintEl();
  h.style.display = 'flex';
  h.style.left = r.left + 'px';
  h.style.top = r.top + 'px';
  h.style.width = r.width + 'px';
  h.style.height = r.height + 'px';
}

function hideHint(): void {
  if (hint) hint.style.display = 'none';
}

let bridgeReady = false;
function installAssetDropBridge(): void {
  if (bridgeReady) return;
  bridgeReady = true;

  document.addEventListener('dragover', ev => {
    if (!dragging) return;
    const hit = paneUnder(ev.clientX, ev.clientY);
    if (!hit || !hit.key) { hideHint(); return; }
    // 只有这里 preventDefault，松手才会派发 drop。
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    showHint(hit.el);
  });

  document.addEventListener('drop', ev => {
    const asset = dragging;
    if (!asset) return;
    const hit = paneUnder(ev.clientX, ev.clientY);
    // 不管落哪儿，拖拽都已结束 —— 先把 iframe 的点击恢复回去，再决定要不要打标。
    endAssetDrag();
    if (!hit || !hit.key) return;
    ev.preventDefault();
    ev.stopPropagation();
    void sendTagToPane(hit.key, asset);
  });

  document.addEventListener('dragend', () => endAssetDrag());
  // 兜底：某些环境下 dragend 会丢（落点进了别的顶层窗口），那 `pointer-events: none`
  // 就会一直留在 Prompt 窗上、点不动。下一次按下必然是新的交互，就地收尾。
  document.addEventListener('pointerdown', () => endAssetDrag(), true);
}

/** 视频挑帧请求：交给主页面里的挑帧弹窗（sampler 自己的 UI，不在 Prompt 窗里）。 */
export type VideoPickRequest = { pane: string; url: string; name?: string };

let onVideoPick: ((req: VideoPickRequest) => void) | null = null;

/** 主页面挂上挑帧弹窗（EditPhase 的 effect 里进出）。没挂上时视频按错误回报。 */
export function setVideoPickHandler(fn: ((req: VideoPickRequest) => void) | null): void {
  onVideoPick = fn;
}

/** 把已经抓好的那一帧交给 Prompt 窗去打标（结果会同步到另一扇窗）。 */
export function sendTagBytesToPane(pane: string, bytes: ArrayBuffer, name?: string): void {
  const win = promptWindows.get(pane);
  if (!win) {
    console.warn('[kolid] no prompt window registered for pane', pane);
    return;
  }
  try { win.postMessage({ __kolid: ASSET_TAG_MSG, pane, name, bytes }, '*'); } catch { /* 窗口已关 */ }
}

/** 把资产读成字节（同源，无 CORS）并交给指定的那扇 Prompt 窗；视频转去主页面挑帧。 */
async function sendTagToPane(pane: string, asset: AssetDragPayload): Promise<void> {
  const win = promptWindows.get(pane);
  const post = (msg: Record<string, unknown>) => {
    try { win?.postMessage(msg, '*'); } catch { /* 窗口已关 */ }
  };
  if (!win) {
    console.warn('[kolid] no prompt window registered for pane', pane);
    return;
  }
  try {
    const target = new URL(asset.url, location.origin);
    // 卡片自己带的 kind 比 content-type 可信（有些媒体服务器一律回 octet-stream）。
    if (asset.kind === 'audio') throw new Error(`「${asset.name || asset.url}」是音频，不是图片/视频`);
    if (asset.kind === 'video') {
      if (!onVideoPick) throw new Error('video picker is not mounted');
      onVideoPick({ pane, url: target.href, name: asset.name });
      return;
    }
    const res = await fetch(target.href, { cache: 'no-store' });
    if (!res.ok) throw new Error(`asset fetch failed (${res.status})`);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.startsWith('audio/')) throw new Error(`「${asset.name || asset.url}」是音频，不是图片/视频`);
    if (ct.startsWith('video/')) {
      // 没带 kind 的卡片：content-type 说视频就按视频走挑帧。
      if (!onVideoPick) throw new Error('video picker is not mounted');
      onVideoPick({ pane, url: target.href, name: asset.name });
      return;
    }
    const bytes = await res.arrayBuffer();
    post({ __kolid: ASSET_TAG_MSG, pane, name: asset.name, contentType: ct, bytes });
  } catch (err) {
    post({ __kolid: ASSET_TAG_MSG, pane, name: asset.name, error: (err as Error).message });
  }
}
