// ── 原生引擎（页面这一头）────────────────────────────────────────────────────────────────────
//
// 声音由 `client/kolid_audio/KolidAudio.dll` 直接开声卡合成，**不经过浏览器**。这里只做三件事：
// 把音符表递过去、把试听敲一下、把状态读回来。别在这里算时间 —— 位置由 clock 和引擎自己对齐。
//
// 为什么用整张表而不是增量：一次几 KB 的 JSON，比维护"增/删/改"三套协议稳得多，也不会有
// "界面上删了、声音里还在响"这种幽灵。改一个音符就重推一次，120ms 合一次（拖拽时不会每帧发）。
//
// 帧换算在这里做：引擎的时间轴是**采样帧**，界面的是**拍**。bpm 一改全表都要重推 ——
// 这也是 `push` 要在 tempo 变化时被调到的原因（useMidiHost 里 project 一变就 rebuild）。

import { clock } from './clock';
import { type MidiProject, beatToSeconds } from './model';

/** 这个"端口"不是真的 MIDI 端口，是我们自己的引擎；dropdown 里靠这个 id 认它。 */
export const NATIVE_PORT_ID = '__kolid_native__';

/** 当前装载的采样乐器。`path` 为空 = 走内置合成器（那 24 个声部）。 */
export type NativeInstrument = {
  path: string;
  zones: number;
  failed: number;
  kb: number;
  error: string;
};

export type NativeStatus = {
  available: boolean;
  open: boolean;
  rate: number;
  clockBound: boolean;
  notes: number;
  tracks: number;
  position: number;
  peak: number;
  voices?: number;
  error?: string;
  instrument?: NativeInstrument;
};

const EMPTY: NativeStatus = {
  available: false, open: false, rate: 48000, clockBound: false,
  notes: 0, tracks: 0, position: -1, peak: 0,
};

class NativeEngine {
  available = false;
  opened = false;
  private rate = 48000;
  private timer: number | null = null;
  private pending: MidiProject | null = null;
  private status: NativeStatus = { ...EMPTY };

  /** 探一次存在性。**不**开设备、**不**申请任何权限，所以可以在页面加载时随便调。 */
  async probe(): Promise<boolean> {
    try {
      const r = await fetch('/api/audio', { cache: 'no-store' });
      const j = await r.json() as NativeStatus;
      this.status = { ...EMPTY, ...j };
      this.available = !!j?.available;
      this.opened = !!j?.open;
      if (j?.rate) this.rate = j.rate;
    } catch {
      this.available = false;
      this.opened = false;
    }
    return this.available;
  }

  getStatus(): NativeStatus { return this.status; }

  private async post(op: string, extra: Record<string, unknown> = {}): Promise<NativeStatus | null> {
    try {
      const r = await fetch('/api/audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, ...extra }),
      });
      const j = await r.json() as NativeStatus;
      if (j && typeof j === 'object') {
        this.status = { ...this.status, ...j };
        if (j.rate) this.rate = j.rate;
        this.opened = !!j.open;
      }
      return this.status;
    } catch {
      return null;
    }
  }

  /** 打开声卡。重复调用是幂等的（后端那边有闸）。 */
  async open(): Promise<boolean> {
    if (!this.available) await this.probe();
    if (!this.available) return false;
    const st = await this.post('open', { rate: clock.getSampleRate() || 48000 });
    return !!st?.open;
  }

  async close(): Promise<void> {
    await this.post('close');
  }

  /**
   * 把整份工程推下去。`force=false` 时 120ms 内只发最后一次 —— 拖音符会连着改很多次。
   * 返回的 Promise 在真正发出去那一拍之后 resolve（不承诺后端已经应用）。
   */
  push(proj: MidiProject, force = false): void {
    this.pending = proj;
    if (force) { this.flush(); return; }
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => { this.timer = null; this.flush(); }, 120);
  }

  private flush(): void {
    const proj = this.pending;
    if (!proj) return;
    this.pending = null;
    void this.send(proj);
  }

  private async send(proj: MidiProject): Promise<void> {
    if (!this.available) return;
    if (!this.opened) {
      const ok = await this.open();
      if (!ok) return;
    }
    const rate = this.rate || 48000;
    const tracks = proj.tracks.map(t => ({
      program: t.program,
      channel: t.channel,
      velScale: t.velScale,
      gain: 1,
      pan: 0.5,
      // 静音/独奏交给引擎算（它每块重算一遍），这样按 M/S 立刻生效、不必重推音符。
      mute: t.mute ? 1 : 0,
      solo: t.solo ? 1 : 0,
    }));

    // 紧凑数组而不是对象：同样的信息 JSON 体积小一半，8192 条也不至于把拖拽卡住。
    const notes: number[][] = [];
    for (let ti = 0; ti < proj.tracks.length; ti++) {
      const t = proj.tracks[ti];
      for (const n of t.notes) {
        const start = Math.max(0, Math.round(beatToSeconds(n.start, proj.tempo) * rate));
        const len = Math.max(1, Math.round(beatToSeconds(n.dur, proj.tempo) * rate));
        notes.push([ti, n.pitch, Math.max(1, Math.min(127, Math.round(n.vel))), start, len]);
      }
    }
    notes.sort((a, b) => a[3] - b[3]);

    await this.post('tracks', { tracks });
    await this.post('notes', { notes });
  }

  async audition(note: number, vel = 100, track = 0): Promise<void> {
    if (!this.available) return;
    if (!this.opened) { await this.open(); }
    await this.post('audition', { note, vel, track });
  }

  async panic(): Promise<void> {
    if (!this.opened) return;
    await this.post('panic');
  }

  /**
   * 装载一个 .sfz（绝对路径）。返回后端算出来的结果 —— zone 数与失败数都是它数出来的，
   * 不是我们猜的。`error` 非空就是没装上，界面要如实显示。
   */
  async loadInstrument(path: string): Promise<NativeInstrument> {
    const fail = (msg: string): NativeInstrument => ({ path, zones: 0, failed: 0, kb: 0, error: msg });
    if (!this.available) await this.probe();
    if (!this.available) return fail('native engine unavailable');
    try {
      const r = await fetch('/api/audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'load_sfz', path }),
      });
      const j = await r.json() as Record<string, unknown>;
      const inst: NativeInstrument = {
        path: String(j?.path || path),
        zones: Number(j?.zones) || 0,
        failed: Number(j?.failed) || 0,
        kb: Number(j?.kb) || 0,
        error: String(j?.error || ''),
      };
      this.status = { ...this.status, instrument: inst };
      if (!inst.error && inst.zones <= 0) inst.error = 'no zone loaded';
      return inst;
    } catch (e) {
      return fail(String(e));
    }
  }

  /** 卸掉采样乐器，回到内置合成器。 */
  async unloadInstrument(): Promise<void> {
    if (!this.available) return;
    const st = await this.post('unload_sfz');
    if (st) this.status = st;
  }

  currentInstrument(): NativeInstrument | null {
    return this.status.instrument && this.status.instrument.path ? this.status.instrument : null;
  }
}

export const nativeEngine = new NativeEngine();
