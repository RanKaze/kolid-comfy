// ── 播放性能面板 ─────────────────────────────────────────────────────────────────────────────
// 页面全局的一口指标:控制台 `await __perfSample()` 采样 5 秒,播着放调用它,报告里每一项
// 都是"卡在哪"的直接证据:
//   · rafFps —— 页面动画帧率。< 10 且长任务为零 ⇒ 不是代码卡,是**浏览器把页面节流了**
//     (内嵌浏览器窗格失焦/最小化时 Chromium 冻结 rAF,播放循环整个停摆 —— 换独立浏览器
//     标签页测试)。
//   · longTasks —— 超 50ms 的主任务列表(来源 + 时长)。数值大 ⇒ 主线程真有活干。
//   · renders —— 各大组件每秒重渲次数。播放中应当接近 0;不为 0 ⇒ 有东西在周期性 setState
//     打穿整棵树(轮询/订阅),按来源追。
//   · vid/comp —— 逐帧合成链路两端(见 blend_node 的 __vidPerf 与 Player 的 __compPerf)。

type PerfState = {
  renders: Record<string, number>;
  longTasks: { at: number; ms: number; name: string }[];
  rafFrames: number;
  heapMB: number;
  since: number;
};

export const perf: PerfState = {
  renders: {}, longTasks: [], rafFrames: 0, heapMB: 0, since: performance.now(),
};

const w = window as unknown as { __perf?: PerfState; __perfSample?: () => Promise<unknown> };
w.__perf = perf;

/** 组件体里点一下(直改,不进 React):window.__perf.renders.VidTimeline++ */
export const markRender = (name: string): void => {
  perf.renders[name] = (perf.renders[name] || 0) + 1;
};

// 常驻 rAF 计数:本身就是节流探测器(窗格失焦它先停)。
const rafTick = () => { perf.rafFrames++; requestAnimationFrame(rafTick); };
requestAnimationFrame(rafTick);

// 长任务观察:>50ms 的主任务一个不漏。
try {
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      perf.longTasks.push({
        at: Math.round(e.startTime),
        ms: Math.round(e.duration),
        name: String((e as { name?: string }).name || 'longtask'),
      });
      if (perf.longTasks.length > 200) perf.longTasks.shift();
    }
  }).observe({ entryTypes: ['longtask'] } as PerformanceObserverInit);
} catch { /* 老浏览器没有 longtask;面板其余部分照常 */ }

const fmtRenders = (perSec: (n: number) => number): Record<string, number> =>
  Object.fromEntries(Object.entries(perf.renders).map(([k, v]) => [k, +perSec(v).toFixed(1)]));

/** 控制台 `await __perfSample()`:清零 → 采样 5 秒 → 一份报告。播放中调用。 */
w.__perfSample = async (): Promise<unknown> => {
  perf.renders = {}; perf.longTasks = []; perf.rafFrames = 0; perf.since = performance.now();
  await new Promise(r => setTimeout(r, 5000));
  const secs = (performance.now() - perf.since) / 1000;
  const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory;
  if (mem) perf.heapMB = +(mem.usedJSHeapSize / 1048576).toFixed(1);
  const vid = (window as unknown as Record<string, unknown>).__vidPerf as Record<string, number> | undefined;
  const comp = (window as unknown as Record<string, unknown>).__compPerf as Record<string, number> | undefined;
  const rafFps = +(perf.rafFrames / secs).toFixed(1);
  const report = {
    secs: +secs.toFixed(1),
    rafFps,
    throttled: rafFps < 10 && perf.longTasks.length === 0,
    throttledHint: rafFps < 10 && perf.longTasks.length === 0
      ? '页面被浏览器节流(内嵌浏览器窗格失焦时 rAF 冻结)——请在独立浏览器标签页里复测,这不是代码开销。'
      : undefined,
    longTasks: perf.longTasks.slice(-20),
    rendersPerSec: fmtRenders(n => n / secs),
    heapMB: perf.heapMB || undefined,
    vid: vid ? {
      packs: vid.packs, hits: vid.hits, misses: vid.misses,
      renders: vid.renders, sigMs: +(vid.sigMs || 0).toFixed(1),
      repliesActive: vid.repliesActive, repliesTemp: vid.repliesTemp,
    } : '页面还没收到合成包',
    comp: comp ? {
      sends: comp.sends, grabs: comp.grabs, grabMs: +(comp.grabMs || 0).toFixed(1),
      cachedReplies: comp.cachedReplies, bitmapReplies: comp.bitmapReplies,
      baseSends: comp.baseSends || 0,
    } : '播放器还没挂',
  };
  console.log('[perf]', report);
  return report;
};
