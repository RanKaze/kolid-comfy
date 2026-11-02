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
/** 传输命令失败后的重发间隔（毫秒）。play/pause 都是幂等的，重发没有副作用；
 *  一直退避重试到后端接住为止 —— 暂停丢了就是"按了停，声音还在响"。 */
const RETRY_MS = [400, 900, 1800, 3500, 5000];
/** 超过这个误差就认为是 seek（硬跳），否则按比例软纠。 */
const HARD_JUMP_S = 0.08;
/** 软纠的比例：每帧吃掉 25% 的余量，肉眼看不出来，几帧内就贴住。 */
const SOFT_GAIN = 0.25;

import { startBackgroundTicker } from './ticker';
import { PAGE_SESSION } from './session';

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
  /** 取数途中又收到一次"对面改了传输"：这一趟回来再补一趟（别让这一发 ping 丢掉）。 */
  private pinged = false;
  /** 去抖中的那一发 seek：`wantSeek` 永远是最后一次想去的秒数。 */
  private seekTimer: ReturnType<typeof setTimeout> | null = null;
  private wantSeek = 0;
  /** 没送到后端的传输意图（play/pause）。在它被后端确认之前，轮询拿回来的 `playing`
   *  不许把它盖掉 —— 否则暂停失败后界面会被自己的 2 秒轮询翻回"在播"，声音也一直不停。 */
  private pending: {
    action: 'play' | 'pause';
    tries: number;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  /** 循环区间：后端时钟自己回绕（不再由页面每帧 seek）。失败按同一套退避重发。
   *  页面这边也必须知道区间 —— 两次 2 秒同步之间是本地插值，不知道回绕的话
   *  播放头会一路冲出出点，等下一次快照才跳回来。 */
  private loopOn = false;
  private loopA = 0;
  private loopB = 0;
  private loopKey = '';
  private loopRetry: { value: { on: boolean; a: number; b: number }; tries: number;
    timer: ReturnType<typeof setTimeout> | null } | null = null;
  /** 同源别的窗：这一扇发完传输命令后喊一声，让它们立刻回来对表。
   *  只靠 2 秒轮询的话，"在这扇窗按了暂停、声音却在另一扇窗里"要过最多两秒才停 ——
   *  听感就是"按了暂停音频还在放"。 */
  private notify: BroadcastChannel | null = null;
  /** **本窗自己**按下过几次播放（轮询/别的窗带起来的播放不算）。
   *  时间线的 PCM 只能由"按播放的那扇窗"接管 —— 见 timelineAudio 的 claim。 */
  private localPlays = 0;

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
      if (typeof BroadcastChannel !== 'undefined') {
        try {
          this.notify = new BroadcastChannel('kolid.clock.transport');
          // 对面刚改了传输：不是"下一轮轮询再知道"，是现在就去取一份。
          this.notify.onmessage = () => { this.pinged = true; void this.sync(); };
        } catch { this.notify = null; }
      }
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
    const raw = this.rawSeconds();
    // 有循环区间：显示也要回绕（后端已经这么做了）。少了这一步，插值会把播放头带出出点。
    if (this.loopOn && this.loopB > this.loopA) {
      const span = this.loopB - this.loopA;
      if (raw >= this.loopB) return this.loopA + (raw - this.loopA) % span;
    }
    return raw;
  }

  /** 不做回绕的位置（内部算"现在真正走到哪"用）。 */
  private rawSeconds(): number {
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
    const speed = this.speed || 1;
    if (this.loopOn && this.loopB > this.loopA) {
      // 循环里同一个事件每秒都有一份：取**现在之后**的那一次（回绕后的时间戳不能落在过去）。
      const span = this.loopB - this.loopA;
      const phase = ((s - this.loopA) % span + span) % span;
      const raw = this.rawSeconds();
      const rawPhase = ((raw - this.loopA) % span + span) % span;
      let base = raw - rawPhase;                         // 这一圈的入点
      if (phase < rawPhase - 1e-9) base += span;         // 已经过点 → 下一圈
      return this.perfAtSnap + ((base + phase) - this.posAtSnap) / speed * 1000;
    }
    const deltaSec = (s - this.posAtSnap) / speed;
    return this.perfAtSnap + deltaSec * 1000;
  }

  // ── 传输控制（都是"说给后端听"，本地不抢先改状态）──────────────────────────────────────────
  async play(): Promise<void> {
    // 先把挂着的 seek 发出去，再按播放 —— 顺序反过来的话，后端会从旧位置起跑，
    // 80ms 后那一发 seek 才把它拽回来（听感上就是"一按播放先窜一下"）。
    await this.flushSeek();
    await this.ctl('play');
    // **命令落地之后**才算一次"本窗按了播放"：后端就是在那条命令里把 PCM 作者定成这扇窗，
    // 时间线再据此重落摆放（早一步会在作者还没换的时候就发出去，被 not_owner 拒掉）。
    this.localPlays++;
  }
  async pause(): Promise<void> {
    await this.flushSeek();
    await this.ctl('pause');
  }
  async toggle(): Promise<void> {
    const was = this.playing;
    await this.ctl('toggle');
    if (!was && this.playing) this.localPlays++;
  }

  /** 本窗自己按下播放的次数（单调）。时间线 PCM 的接管只认它 —— 别的窗看到"在播"
   *  只是镜像，不该也去 claim（两个窗互相抢作者，声音会劈叉/掉）。 */
  localPlayCount(): number { return this.localPlays; }
  /** 跳转：**本地先落位**（播放头与画面立刻跟手），网络那一趟去抖 80ms 只发最后一发。
   *  一次拖动会来几十上百发，后端不需要每一发都知道 —— 它只需要最终位置。
   *  返回的 Promise 在那一发回包后 resolve（调用方一般不用等它）。 */
  async seek(s: number): Promise<void> {
    const t = Math.max(0, s);
    this.wantSeek = t;
    this.posAtSnap = t;
    this.perfAtSnap = nowPerf();
    this.broadcast();
    await new Promise<void>(resolve => {
      if (this.seekTimer) clearTimeout(this.seekTimer);
      this.seekTimer = setTimeout(() => {
        this.seekTimer = null;
        void this.ctl('seek', this.wantSeek).then(() => resolve(), () => resolve());
      }, 80);
    });
  }

  /** 停在某一秒（片尾 / 收摊用）：先暂停、再落位。顺序反过来的话，pause 的回包里
   *  后端那一刻的位置会把刚落好的位置盖掉。 */
  async stopAt(s: number): Promise<void> {
    const t = Math.max(0, s);
    if (this.seekTimer) { clearTimeout(this.seekTimer); this.seekTimer = null; }
    this.posAtSnap = t;
    this.perfAtSnap = nowPerf();
    await this.ctl('pause');
    await this.ctl('seek', t);
    this.posAtSnap = t;
    this.perfAtSnap = nowPerf();
    this.broadcast();
  }

  /** 把还没发出去的那一发 seek 立刻发掉（按播放 / 暂停前用）。 */
  private async flushSeek(): Promise<void> {
    if (!this.seekTimer) return;
    clearTimeout(this.seekTimer);
    this.seekTimer = null;
    await this.ctl('seek', this.wantSeek);
  }

  /** 把循环区间交给后端（秒进、帧出）。同一个区间只发一次。 */
  setLoop(on: boolean, aSec: number, bSec: number): void {
    const rate = this.rate || 48000;
    const a = Math.max(0, aSec);
    const b = Math.max(0, bSec);
    const onEff = !!on && b > a;
    if (onEff !== this.loopOn || a !== this.loopA || b !== this.loopB) {
      this.loopOn = onEff;
      this.loopA = a;
      this.loopB = b;
      // 设区间时已经越过出点：当场折回（后端 set_loop 也是这么做的，两边显示一致）。
      const raw = this.rawSeconds();
      if (onEff && raw >= b) {
        const span = b - a;
        this.posAtSnap = a + (raw - a) % span;
        this.perfAtSnap = nowPerf();
      }
      this.broadcast();
    }
    const v = {
      on: onEff,
      a: Math.max(0, Math.round(a * rate)),
      b: Math.max(0, Math.round(b * rate)),
    };
    const key = (v.on ? '1' : '0') + ':' + v.a + ':' + v.b;
    if (key === this.loopKey) return;
    this.loopKey = key;
    void this.pushLoop(v);
  }

  private async pushLoop(v: { on: boolean; a: number; b: number }): Promise<void> {
    if (await this.send('loop', v)) { this.clearLoopRetry(); return; }
    let r = this.loopRetry;
    if (!r || r.value.on !== v.on || r.value.a !== v.a || r.value.b !== v.b) {
      this.clearLoopRetry();
      r = { value: v, tries: 0, timer: null };
      this.loopRetry = r;
    }
    if (r.timer) return;
    const rr = r;
    const delay = RETRY_MS[Math.min(rr.tries, RETRY_MS.length - 1)];
    rr.tries++;
    rr.timer = setTimeout(() => {
      rr.timer = null;
      if (this.loopRetry !== rr) return;
      void this.pushLoop(rr.value);
    }, delay);
  }

  private clearLoopRetry(): void {
    const r = this.loopRetry;
    this.loopRetry = null;
    if (r?.timer) clearTimeout(r.timer);
  }

  private async ctl(action: string, value?: number | { on: boolean; a: number; b: number }): Promise<void> {
    // 用户改了主意：旧的待发意图作废（seek 不算改主意 —— 它不改"播/停"，别把暂停重试挤掉）。
    if (this.pending && this.pending.action !== action &&
        (action === 'play' || action === 'pause' || action === 'toggle')) {
      this.clearPending();
    }
    if (await this.send(action, value)) return;

    if (action === 'play' || action === 'pause') {
      // 后端没收下：界面先按意图走（否则按了暂停画面不动），意图留着一直重发。
      if (!this.pending) this.localFallback(action, value);
      this.scheduleRetry(action);
      this.broadcast();
      return;
    }
    // toggle 不幂等、seek 只影响落点：失败了就本地降级，不重发（重发 toggle 会翻两次）。
    this.localFallback(action, value);
    this.broadcast();
  }

  /** 发一发控制命令。后端回了一份**像样的快照**才算数（见下面的形状校验）。 */
  private async send(action: string, value?: number | { on: boolean; a: number; b: number }): Promise<boolean> {
    let snap: (Snap & { error?: string }) | null = null;
    try {
      const r = await fetch('/api/clock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // session = 这扇窗这一次加载。后端在"播放"这条命令里据此定音频作者（见 /api/clock）。
      body: JSON.stringify({ action, value, session: PAGE_SESSION }),
      });
      snap = (await r.json()) as Snap & { error?: string };
    } catch {
      return false;
    }
    // **必须先验形状**：后端对一个它不认识的路由会回 `{}`（200 + 空对象），那不是"快照"。
    // 信了它，`playing` 当场被当成 false —— 用户按播放，界面上一秒后又自己停了。
    if (!(snap && typeof snap.frames === 'number' && !snap.error)) return false;
    // 后端接住了：先撤掉意图闸门，再让这份快照（含权威的 playing）生效。
    if (this.pending && this.pending.action === action) this.clearPending();
    this.accept(snap, nowPerf(), 0);
    this.broadcast();
    // 别的窗的声源/播放头都跟着这只钟走：让它们现在就去取，别等下一轮 2 秒轮询。
    try { this.notify?.postMessage(1); } catch { /* 通道关了：退回轮询 */ }
    return true;
  }

  private scheduleRetry(action: 'play' | 'pause'): void {
    let p = this.pending;
    if (!p || p.action !== action) {
      p = { action, tries: 0, timer: null };
      this.pending = p;
    }
    if (p.timer) return;                       // 已经排上了，别叠计时器
    const delay = RETRY_MS[Math.min(p.tries, RETRY_MS.length - 1)];
    p.tries++;
    p.timer = setTimeout(() => {
      p!.timer = null;
      if (this.pending !== p) return;
      void this.send(action).then(ok => {
        if (this.pending !== p) return;         // 期间用户又按了别的：这条作废
        if (!ok) this.scheduleRetry(action);
      });
    }, delay);
  }

  private clearPending(): void {
    const p = this.pending;
    this.pending = null;
    if (p?.timer) clearTimeout(p.timer);
  }

  /** 后端不在时的本地走时。**先把"此刻在哪"结账，再改状态** ——
   *  否则暂停的那一刻 `perfAtSnap` 被刷到现在而 `posAtSnap` 还是上一次的旧值，
   *  插值整段被抹掉，位置当场跳回快照点（表现就是"按一下暂停，播放头归零"）。 */
  private localFallback(action: string, value?: unknown): void {
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
    this.pinged = false;
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
      if (this.pinged) void this.sync();
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
    // 有待确认的传输意图时，"在不在播"由意图说了算：后端还没收到那发暂停，
    // 它当然还说自己在播 —— 照抄就会让界面自己翻回播放态，那声音也就一直停不下来。
    if (!this.pending) this.playing = !!snap.playing;
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
    if (this.seekTimer) clearTimeout(this.seekTimer);
    this.seekTimer = null;
    this.clearPending();
    this.clearLoopRetry();
    try { this.notify?.close(); } catch { /* 已经关了 */ }
    this.notify = null;
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
