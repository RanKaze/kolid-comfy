// ── 公共时间基准（前端半边）──────────────────────────────────────────────────────────────────
//
// 规矩：**这个文件是页面上唯一允许读"现在"的地方。** 传输条、钢琴卷帘、力度泳道、将来的采样器
// 预览，全都从这里取时间；任何一处再写 performance.now() 都是在造第二只钟。
//
// 为什么不能各算各的：MIDI 的听感与画面必须同源。页面自己按 rAF 累 dt，一次掉帧就永久落后
// 几十毫秒；切到后台 rAF 直接停摆，而外部音源还在按系统时间戳发声 —— 回来就是"声音在前面跑"。
// 所以：
//   * 权威在后端（`/api/clock`，源头是 client/kolid_clock 那个原生的 QPC 传输），它说第几帧；
//   * 这里做**对齐**（把系统轴的秒数接到 perf 轴上）与**插值**（两次采样之间用本地 perf 推）；
//   * 每 2 秒回头重校一次：小误差按比例吃掉（不跳），大误差（用户 seek 过）直接跳。
//
// 对外三件事：
//   clock.seconds()    —— 传输播放头，秒（平滑，可直接拿去画）
//   clock.perfAt(sec)  —— 把"传输第几秒"换成 performance.now 时间戳（Web MIDI 的 send 要它）
//   clock.subscribe()  —— 每帧一次（播着）或每 100ms 一次（停着），一个 rAF 喂所有窗
//
// 降级：后端没起/请求失败时用本地 performance 轴自己走，`status().source` 会变成 'local'，
// 界面上那句"Clock: local"就是给这种情况留的 —— 能编辑，但别指望它和外部音源对得上。

export type ClockSource = 'native' | 'local';

export type ClockStatus = {
  ready: boolean;
  source: ClockSource;
  /** 后端报的后端名字（'dll' / 'qpc-python'），仅诊断用。 */
  backend: string;
  /** 对齐余量：本地说法减后端说法的毫秒数（0 附近才是对齐好的）。 */
  offsetMs: number;
  /** 最近一次往返耗时。 */
  rttMs: number;
  /** 最近一次重校时预测与实际差了多少毫秒（纠偏前的原始误差）。 */
  driftMs: number;
  sampleRate: number;
  playing: boolean;
  /** 诊断：上一份快照落在哪（秒）、落在哪个 perf 时刻、以及"那一刻到现在"过了多久。 */
  anchorSeconds: number;
  anchorAgeMs: number;
};

type Snap = {
  frames: number;
  rate: number;
  playing: boolean;
  /** 后端 QPC 轴上的秒数（从后端 init 起算）。 */
  now: number;
  speed: number;
  source: string;
};

const POLL_MS = 2000;
/** 超过这个误差就认为是 seek（硬跳），否则按比例软纠。 */
const HARD_JUMP_S = 0.08;
/** 软纠的比例：每帧吃掉 25% 的余量，肉眼看不出来，几帧内就贴住。 */
const SOFT_GAIN = 0.25;

import { startBackgroundTicker } from './ticker';

const nowPerf = (): number => performance.now();


class MasterClock {
  private perfAtSnap = 0;      // 快照落地那一刻的 perf
  private posAtSnap = 0;       // 那一刻的传输位置（秒）
  private speed = 1;
  private playing = false;
  private rate = 48000;
  private armed = false;       // 有没有和后端对上过
  private source: ClockSource = 'local';
  private backend = '';
  private offsetMs = 0;
  private rttMs = 0;
  private driftMs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private raf = 0;
  private stopTicker: (() => void) | null = null;
  private lastBroadcast = 0;
  private subs = new Set<() => void>();
  private inflight = false;

  constructor() {
    // 插值的起点就是"现在"：没有这一句，第一次 play 之后 dt 会等于整个页面存活时长，
    // 播放头当场跳到几十秒外。
    this.perfAtSnap = nowPerf();
    if (typeof window !== 'undefined') {
      // 第一次对齐要快：不少窗第一次打开时播放头就得是对的。
      void this.sync();
      this.timer = setInterval(() => { void this.sync(); }, POLL_MS);
      // 页面重新可见时立刻补一次 —— 后台期间轮询会被浏览器压到最低频率。
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) void this.sync();
      });
      this.pump();
    }
  }

  // ── 位置 ──────────────────────────────────────────────────────────────────────────────────
  /** 播放头（秒）。插值出来的，停着时就是最后那次快照的位置。
   *
   *  **不要求 `armed`**：后端不在时（还没重启、或这一版根本没那个端点）位置也得走 —— 否则
   *  用户按播放，画面纹丝不动，看起来就是"这个功能没做"。降级时位置从 0 起算、按本地 perf
   *  推进，`status().source` 会老实写 'local'。 */
  seconds(): number {
    const base = this.posAtSnap;
    if (!this.playing) return Math.max(0, base);
    const dt = (nowPerf() - this.perfAtSnap) / 1000;
    return Math.max(0, base + dt * this.speed);
  }

  frames(): number {
    return Math.round(this.seconds() * this.rate);
  }

  isPlaying(): boolean { return this.playing; }
  getSampleRate(): number { return this.rate; }

  /** 把"传输第 s 秒"换成 performance.now 的时间戳（毫秒）—— Web MIDI 的 send 要的是它。
   *  返回过去时刻时就是"立刻发"（调用方自己 max(0, ...)）。 */
  perfAt(s: number): number {
    if (!this.armed) return nowPerf();
    const deltaSec = (s - this.posAtSnap) / (this.speed || 1);
    return this.perfAtSnap + deltaSec * 1000;
  }

  // ── 传输控制（都是"说给后端听"，本地不抢先改状态）──────────────────────────────────────────
  async play(): Promise<void> { await this.ctl('play'); }
  async pause(): Promise<void> { await this.ctl('pause'); }
  async toggle(): Promise<void> { await this.ctl('toggle'); }
  async seek(s: number): Promise<void> { await this.ctl('seek', Math.max(0, s)); }

  private async ctl(action: string, value?: number): Promise<void> {
    try {
      const r = await fetch('/api/clock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, value }),
      });
      const snap = (await r.json()) as Snap & { error?: string };
      // **必须先验形状**：后端对一个它不认识的路由会回 `{}`（200 + 空对象），那不是"快照"。
      // 信了它，`playing` 当场被当成 false —— 用户按播放，界面上一秒后又自己停了。
      if (snap && typeof snap.frames === 'number' && !snap.error) this.accept(snap, nowPerf(), 0);
      else this.localFallback(action, value);
    } catch {
      // 后端不在：本地自己动（降级也得好用，只是不权威）。
      this.localFallback(action, value);
    }
    this.broadcast();
  }

  /** 后端不在时的本地走时。**先把"此刻在哪"结账，再改状态** ——
   *  否则暂停的那一刻 `perfAtSnap` 被刷到现在而 `posAtSnap` 还是上一次的旧值，
   *  插值整段被抹掉，位置当场跳回快照点（表现就是"按一下暂停，播放头归零"）。 */
  private localFallback(action: string, value?: number): void {
    const held = this.seconds();        // 冻结前先取位置（此时 playing 还是旧值）
    this.source = 'local';
    this.armed = false;                 // 降级态不参与后端对齐，别让半截的 perfAt 换算用出去
    this.rttMs = 0;
    this.driftMs = 0;
    this.offsetMs = 0;
    if (action === 'play') {
      this.posAtSnap = held;
      this.playing = true;
    } else if (action === 'pause') {
      this.posAtSnap = held;
      this.playing = false;
    } else if (action === 'toggle') {
      this.posAtSnap = held;
      this.playing = !this.playing;
    } else if (action === 'seek') {
      this.posAtSnap = Math.max(0, Number(value) || 0);
    }
    this.perfAtSnap = nowPerf();
  }

  // ── 对齐 ──────────────────────────────────────────────────────────────────────────────────
  /** 立刻重校一次（用户点了"CLOCK"那颗小牌子，或者页面刚从后台回来）。 */
  resync(): void { void this.sync(); }

  private async sync(): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    const t0 = nowPerf();
    try {
      const r = await fetch('/api/clock', { cache: 'no-store' });
      const now = nowPerf();
      const snap = (await r.json()) as Snap;
      if (snap && typeof snap.frames === 'number') {
        // 单向延迟按往返的一半估：快照说的是"后端在 now 那一刻的位置"，最贴近的是往返中点。
        this.accept(snap, (t0 + now) / 2, now - t0);
      }
    } catch {
      if (this.armed) this.source = 'local';
    } finally {
      this.inflight = false;
    }
  }

  /** 收一份快照。`atPerf` = 这份快照对应的本地 perf 时刻。
   *  形状不对的一律不收（见 ctl 里那段注释）—— 位置宁可停在原地，也不要被一份空对象归零。 */
  private accept(snap: Snap, atPerf: number, rtt: number): void {
    if (typeof snap.frames !== 'number' || !(snap.rate > 0)) return;
    const pos = snap.frames / snap.rate;
    const prev = this.armed ? this.seconds() : pos;
    const err = pos - prev;

    this.rate = snap.rate > 0 ? snap.rate : this.rate;
    this.speed = snap.speed || 1;
    this.playing = !!snap.playing;
    this.rttMs = rtt;
    this.backend = snap.source || '';
    this.source = 'native';

    if (!this.armed) {
      this.posAtSnap = pos;
      this.perfAtSnap = atPerf;
      this.armed = true;
      this.driftMs = 0;
      this.offsetMs = 0;
      return;
    }

    this.driftMs = err * 1000;
    if (Math.abs(err) > HARD_JUMP_S) {
      this.posAtSnap = pos;               // seek：认了，别做动画
    } else {
      this.posAtSnap = prev + err * SOFT_GAIN;   // 漂移：吃掉四分之一，剩下的下一轮继续
    }
    this.perfAtSnap = atPerf;
    // 对齐余量只用来诊断：预测位置与后端说法之差，折成毫秒。
    this.offsetMs = err * 1000;
  }

  status(): ClockStatus {
    return {
      ready: this.armed,
      source: this.source,
      backend: this.backend,
      offsetMs: this.offsetMs,
      rttMs: this.rttMs,
      driftMs: this.driftMs,
      sampleRate: this.rate,
      playing: this.playing,
      anchorSeconds: this.posAtSnap,
      anchorAgeMs: nowPerf() - this.perfAtSnap,
    };
  }

  // ── 广播：一个 rAF 喂所有窗 ───────────────────────────────────────────────────────────────
  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }

  private pump(): void {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const t = nowPerf();
      // 播着＝每帧；停着＝每 100ms。停着还每帧刷一遍是在白烧电。
      const gate = this.playing ? 0 : 100;
      if (gate && t - this.lastBroadcast < gate) return;
      this.lastBroadcast = t;
      this.broadcast();
    };
    this.raf = requestAnimationFrame(loop);
    // 窗口不在前台时 rAF 会被浏览器**停掉**，而 MIDI 的调度与循环回绕不能停 —— 用 Worker
    // 补一条心跳（见 ticker.ts 的注释）。它只在 rAF 明显断档时才出手，前台时几乎不干活。
    this.stopTicker = startBackgroundTicker(() => {
      const idle = nowPerf() - this.lastBroadcast;
      if (idle < 60) return;              // 前台：rAF 正在跑，让开
      this.lastBroadcast = nowPerf();
      this.broadcast();
    });
  }

  private broadcast(): void {
    for (const fn of this.subs) {
      try { fn(); } catch { /* 一扇窗画坏了不该拖死别的窗 */ }
    }
  }

  /** 页面要走了就收干净（热更新时尤其重要，不然 rAF 会越叠越多）。 */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.stopTicker?.();
    this.stopTicker = null;
    this.timer = null;
    this.raf = 0;
    this.subs.clear();
  }
}

export const clock = new MasterClock();

/** 秒 → 小节.拍.ticks（按给定拍号），给传输条的读数用。 */
export const fmtBarBeat = (seconds: number, tempo: number, timeSig: [number, number]): string => {
  const beat = seconds * (tempo / 60);
  const perBar = timeSig[0];
  const bar = Math.floor(beat / perBar) + 1;
  const inBar = beat - (bar - 1) * perBar;
  const b = Math.floor(inBar) + 1;
  const tick = Math.floor((inBar - Math.floor(inBar)) * 480);
  return `${bar}.${b}.${String(tick).padStart(3, '0')}`;
};

/** 秒 → 0:00.000，给"绝对时间"那一位读数用。 */
export const fmtClock = (seconds: number): string => {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(3)}`;
};

// 诊断口：控制台里 `__kolidClock.seconds()` 直接问"现在第几秒"，`status()` 看对齐与来源。
// 页面上只有这一份时间，出了问题要找它，不该靠猜。
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__kolidClock = clock;
}
