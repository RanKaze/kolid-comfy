// ── 后台也走的节拍器 ────────────────────────────────────────────────────────────────────────
//
// 浏览器有一条和 DAW 作对的规矩：**窗口不在前台时 rAF 会被停掉**。而 MIDI 的调度、循环回绕、
// 播放头推进，全都挂在"每一帧动一下"上 —— 用户切到别的窗口编歌词，回来发现音乐停在半路，
// 或者干脆一直"按了播放没声音"，根子就在这里。
//
// 参考项目（music-learning）的解法是在音频线程里挂一个 AudioWorklet 当心跳，注释写得很直白：
// "Window timers may be throttled when a studio window is in the background; they must not be
// the playback clock." 本机不出声、没有音频线程可挂，所以用 Worker —— Worker 的定时器不受
// 页面可见性节流（只受极端 CPU 节流影响），是同一件事在另一个线程上的等价物。
//
// 用法：clock 把它的广播挂上来。前台时 rAF 跑得比它勤，它自己让开（见 clock 的 pump）；
// 后台时 rAF 停了，它接手，位置照走、音符照发。

const CODE = `let timer = 0;
self.onmessage = (e) => {
  if (e.data === 'start') {
    if (timer) clearInterval(timer);
    timer = setInterval(() => self.postMessage(1), 20);
  } else if (e.data === 'stop') {
    if (timer) clearInterval(timer);
    timer = 0;
  }
};`;

/** 启动一个 20ms 的 Worker 心跳。返回停止函数；没有 Worker 的环境返回 null（调用方只靠 rAF）。 */
export const startBackgroundTicker = (onTick: () => void): (() => void) | null => {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined') return null;
  let url = '';
  let worker: Worker | null = null;
  try {
    url = URL.createObjectURL(new Blob([CODE], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = () => onTick();
    worker.postMessage('start');
  } catch {
    return null;
  }
  return () => {
    try { worker?.postMessage('stop'); worker?.terminate(); } catch { /* 已经没了 */ }
    if (url) URL.revokeObjectURL(url);
  };
};
