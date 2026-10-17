/**
 * 实时巡检回路 —— 让"读现在的状态"不必经过快照。
 *
 * 快照回答的是"这份拷贝里是不是也有这个问题"；而用户要的是"读我现在眼前这个状态"。
 * 这两件事的差别不在数据多少，在**现场是不是活的**：快照是死的，重放是复制的。
 *
 * 于是这里常驻一个长轮询：外部（`temporary/ui_probe_cli.py`）发来一条表达式，页面就地求值、
 * 把结果回传。和在 F12 控制台里敲一行等价，只是那一行由我这边发、你那边不用做任何事。
 *
 * 三条设计约束：
 * 1. **只读优先**：默认什么都不改；`drag()` 之类会动手的助手要显式调用。
 * 2. **不被理解成状态**：指令是一次请求，取走就没了，没人取走也不留残渣。
 * 3. **连不上就当没有**：sink 没开、产物是旧的，回路安静退避，不影响页面本身。
 */
import { PROBE_BUILD, probeBases, probeReport, probeSnapshot } from './probe';

// ── 序列化 ─────────────────────────────────────────────────────────────────
// 结果要过一趟 JSON。DOM 节点、React fiber 都有环，直接 JSON.stringify 会抛；
// 所以先按"能序列化就序列化，不能就描述一下"降级，并且给尺寸设上限 —— 一条指令不该
// 因为返回了整棵 fiber 树而把通道撑爆。
const CAP = 200000;
const toJson = (v: unknown): unknown => {
  try {
    const s = JSON.stringify(v);
    if (s === undefined) return null;
    if (s.length > CAP) return { truncated: true, bytes: s.length, head: s.slice(0, 400) };
    return JSON.parse(s);
  } catch {
    try { return { unserializable: String(v) }; } catch { return { unserializable: '?' }; }
  }
};

const runExpr = async (expr: string): Promise<{ ok: boolean; value?: unknown; error?: string }> => {
  try {
    // 允许顶层 await：外面包一层 async IIFE，于是 `await fetch(...)` 也能直接写。
    const fn = new Function('return (async () => (\n' + expr + '\n))()') as () => Promise<unknown>;
    return { ok: true, value: toJson(await fn()) };
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: String((err && (err.stack || err.message)) || e) };
  }
};

// ── 控制台式助手 ───────────────────────────────────────────────────────────
// 目的只有一个：让"发过去的那一行"短到能一眼看懂。它的能力边界就是 document 本身 ——
// 这里不发明第二套查询语言，因为 DOM 已经是那套语言了。
const el = (sel: string | Element): Element | null =>
  typeof sel === 'string' ? document.querySelector(sel) : sel;

const describe = (e: Element | null): string => {
  if (!e) return 'none';
  const raw = typeof e.className === 'string' ? e.className : '';
  const cls = raw.trim() ? '.' + raw.trim().split(/\s+/).join('.') : '';
  const blk = e.getAttribute('data-dock-block');
  const unit = e.getAttribute('data-dock-unit');
  return e.tagName.toLowerCase() + cls + (blk ? `[${blk}]` : '') + (unit ? `(${unit})` : '');
};

const box = (e: Element | null) => {
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
};

/** 把手清单：每条边界是谁对谁，位置在哪，**指针落在它中心时实际交给谁**。 */
const handles = () => [...document.querySelectorAll('.dock-split')].map(s => {
  const r = s.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const got = document.elementFromPoint(cx, cy);
  const nm = (e: Element | null): string | null => {
    if (!e) return null;
    if (e.matches('[data-dock-block]')) return e.getAttribute('data-dock-block');
    const q = e.querySelector('[data-dock-block]');
    return q ? q.getAttribute('data-dock-block') : null;
  };
  return {
    at: { x: Math.round(cx), y: Math.round(cy) },
    size: { w: Math.round(r.width), h: Math.round(r.height) },
    prev: nm(s.previousElementSibling), next: nm(s.nextElementSibling),
    hit: describe(got), reachable: got === s,
    cursor: getComputedStyle(s).cursor,
  };
});

/** 块清单：声明/显示/位置/内容尺寸，一行一块。 */
const blocks = () => [...document.querySelectorAll('[data-dock-block]')]
  .filter(e => !e.querySelector('[data-dock-block]'))
  .map(e => {
    const cs = getComputedStyle(e);
    return {
      block: e.getAttribute('data-dock-block'), ...box(e),
      flex: cs.flex, minW: cs.minWidth, minH: cs.minHeight, overflow: cs.overflow,
      scroll: { w: e.scrollWidth, h: e.scrollHeight, cw: e.clientWidth, ch: e.clientHeight },
      hitAtCenter: describe(document.elementFromPoint(
        e.getBoundingClientRect().left + e.getBoundingClientRect().width / 2,
        e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2)),
    };
  });

/**
 * 在这一页里真的拖一次。用合成 PointerEvent，和在屏幕上拖走的是**同一条** React 处理路径：
 * 于是"拖了没反应"能在这里被判成两种完全不同的原因 ——
 *   a) 指针压根没落在把手上（往下看 `hit`）
 *   b) 落在了，但边界被夹死（往下看 `__uiProbe.trace` 里那条 drag）
 */
const drag = async (x: number, y: number, dx: number, dy = 0, steps = 8) => {
  const target = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!target) return { ok: false, error: `(${x},${y}) 处没有任何元素` };
  const ev = (cx: number, cy: number, kind: string) => new PointerEvent(kind, {
    bubbles: true, cancelable: true, composed: true,
    clientX: cx, clientY: cy, screenX: cx, screenY: cy,
    pointerId: 1, pointerType: 'mouse', isPrimary: true,
    button: 0, buttons: kind === 'pointerup' ? 0 : 1,
  });
  target.dispatchEvent(ev(x, y, 'pointerdown'));
  for (let i = 1; i <= steps; i++) {
    await new Promise(r => setTimeout(r, 30));
    target.dispatchEvent(ev(x + (dx * i) / steps, y + (dy * i) / steps, 'pointermove'));
  }
  target.dispatchEvent(ev(x + dx, y + dy, 'pointerup'));
  return { ok: true, on: describe(target), moved: { dx, dy } };
};

const api = { q: el, rect: box, desc: describe, handles, blocks, drag };

// ── 回路 ───────────────────────────────────────────────────────────────────
const SESSION = Math.random().toString(36).slice(2, 10);
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

let started = false;
/** 装一次就够。装完页面就一直在"等指令"，不需要谁再点什么。 */
export function installLive(): void {
  if (started) return;
  started = true;

  void (async () => {
    let base: string | null = null;
    let backoff = 400;
    for (;;) {
      // ── 找一个听得懂巡检话的地址 ──
      // 同源优先（真实后端里路由就长在页面上），其次是本地 sink。两者都会在"这次没有指令"
      // 时回 {ok:true, cmd:null}；回 ok:false 说明那条路上没有收件人（旧后端），换下一条。
      if (base === null) {
        for (const b of probeBases()) {
          try {
            const r = await fetch(b + '/api/ui_probe/cmd?wait=0', { cache: 'no-store' });
            if (!r.ok) continue;
            const j = await r.json() as { ok?: boolean };
            if (j && j.ok) { base = b; break; }
          } catch { /* 下一条 */ }
        }
      }
      if (base === null) {
        await sleep(backoff);
        backoff = Math.min(Math.round(backoff * 1.7), 8000);
        continue;
      }
      backoff = 400;

      // ── 长轮询等一条指令 ──
      try {
        const qs = new URLSearchParams({
          wait: '25', sid: SESSION, build: PROBE_BUILD,
          url: location.href, vp: `${window.innerWidth}x${window.innerHeight}`,
        });
        const r = await fetch(base + '/api/ui_probe/cmd?' + qs.toString(), { cache: 'no-store' });
        if (!r.ok) { base = null; continue; }
        const j = await r.json() as { ok?: boolean; cmd?: { id: string; expr: string } | null };
        if (!j || !j.ok) { base = null; continue; }
        if (!j.cmd) continue;

        const out = await runExpr(j.cmd.expr);
        await fetch(base + '/api/ui_probe/res', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: j.cmd.id, ...out }),
        });
      } catch {
        // 连接断了（sink 关了、页面切换了）。安静退避，不影响页面本身。
        base = null;
        await sleep(1200);
      }
    }
  })();
}

/** 挂在 `window.__uiProbe` 上的助手：让发过来的表达式短到像控制台里的一行。 */
export const liveHelpers = api;

/** 面板/命令行共用的"看一眼现在"：比快照窄、比数字全 —— 一句人能读的话。 */
export function liveNow(): string {
  const hs = handles();
  const bs = blocks();
  return [
    `视口 ${window.innerWidth}×${window.innerHeight} · 块 ${bs.length} 个 · 把手 ${hs.length} 条`,
    ...bs.map(b => `${b.block}: ${b.w}×${b.h} (flex ${b.flex})`),
    ...hs.map((h, i) => `#${i} ${h.prev}┃${h.next} @${h.at.x},${h.at.y} → ${h.reachable ? '可达' : '被盖:' + h.hit}`),
  ].join('\n');
}

export const liveSnapshot = (label = 'live'): unknown => probeSnapshot(label);
export const liveReport = (label = 'live'): string => probeReport(probeSnapshot(label));
