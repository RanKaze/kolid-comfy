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
import { noteNativeSound } from './nativeMonitor';
import { type MidiProject, beatToSeconds } from './model';

/** 这个"端口"不是真的 MIDI 端口，是我们自己的引擎；dropdown 里靠这个 id 认它。 */
export const NATIVE_PORT_ID = '__kolid_native__';

/** 当前装载的采样乐器。`path` 为空 = 没有乐器（内置合成器已常闭，不出声）。
 *  `kind`：'' / 'sfz' / 'vst3'。VST3 那条没有 zone 概念（zones 恒 0），`kb` 是预设的字节数。
 *  `track` 只在 `status.instruments`（按轨）里有：这一件挂在哪条轨上（轨 id）。 */
export type NativeInstrument = {
  path: string;
  kind?: string;
  zones: number;
  failed: number;
  kb: number;
  error: string;
  /** 插件自报的类名（VST3）/ 空（SFZ）。界面上"装的是哪件"读它，读不到才回落到文件名。 */
  name?: string;
  slot?: number;
  track?: string | null;
  open?: boolean;
  /** 这扇插件窗口还开着吗（只有 VST3 有）。轨道窗换模式重挂时靠它把窗口认回来。 */
  editor?: boolean;
  editorSize?: number[];
  /** 最近一块渲染的峰值（千分比）。只有 `status` 里按轨/按试听槽的那些行才有。 */
  peak?: number;
  /** 后端说的"装上了没有"（有 error 时一律 false）。 */
  ok?: boolean;
};

/** 后端那几条装乐器的 op 回的是同一套字段；这里统一读成一件乐器。 */
const toInstrument = (j: unknown, path: string): NativeInstrument => {
  const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>;
  return {
    path: String(o.path || path),
    kind: String(o.kind || ''),
    zones: Number(o.zones) || 0,
    failed: Number(o.failed) || 0,
    kb: Number(o.kb) || 0,
    error: String(o.error || ''),
    name: typeof o.name === 'string' ? o.name : '',
    slot: typeof o.slot === 'number' ? o.slot : undefined,
    track: typeof o.track === 'string' ? o.track : null,
    open: o.open === true,
    editor: o.editor === true,
    editorSize: Array.isArray(o.editorSize) ? (o.editorSize as unknown[]).map(Number) : [],
    peak: typeof o.peak === 'number' ? o.peak : undefined,
    ok: typeof o.ok === 'boolean' ? o.ok : undefined,
  };
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
  /** 试听槽（老字段）。工程里每条轨的那件在 `instruments`。 */
  instrument?: NativeInstrument;
  /** 试听槽的完整一行（status 里有：peak / editor / slot）。 */
  plugin?: NativeInstrument;
  /** 每条装了乐器的轨：path/kind/name/open/error。没装乐器或还没对账上的轨不出现。 */
  instruments?: NativeInstrument[];
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
  /** 单飞：同一时刻只有一条推送在飞，飞着的时候来的新工程只留最后一份。
   *  两份并发地各发 tracks/notes 会交错落进后端 —— 后到的旧表把新表盖掉。 */
  private inflight = false;
  private queued: MidiProject | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** 上一次**确实发成功**的那份表（速率 + 轨道 + 音符）。重推同一份工程是常态，
   *  表没变就不发：后端每收一次都要让每个乐器重排一遍调度。 */
  private lastKey = '';
  private status: NativeStatus = { ...EMPTY };
  private subs = new Set<() => void>();
  /** 上一次通知出去的那份"每轨乐器"。音符拖动会连着推工程，但乐器很少变 ——
   *  只在这份东西真的变了才叫醒订阅者，免得轨道窗跟着拖拽每帧重画。 */
  private lastInstruments = '';

  /** 订阅"每轨乐器"的变化（轨道窗据此显示装上了没有、卡在哪）。返回退订函数。 */
  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }
  private notify(): void {
    // 界面订阅的是"装了哪几件"：每条轨的那件 + 试听槽那件。别的字段（peak/position）每帧都在变，
    // 拿来当键会让轨道窗跟着拖音符重画。
    const key = JSON.stringify([this.status.instruments || [], this.status.instrument || null]);
    if (key === this.lastInstruments) return;
    this.lastInstruments = key;
    for (const fn of this.subs) { try { fn(); } catch { /* 一扇窗坏了不拖累别的 */ } }
  }

  /** 探一次存在性。**不**开设备、**不**申请任何权限，所以可以在页面加载时随便调。 */
  async probe(): Promise<boolean> {
    const was = this.available;
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
    // 换了后端（ComfyUI 重启/引擎重新出现）就不认旧账：那份表它没有。
    if (!was && this.available) this.lastKey = '';
    this.notify();
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
      this.notify();
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

  /**
   * 立刻把整份工程推下去，并等后端认领。
   *
   * `push()` 是 120ms 去抖、不等待的：刚加的那条轨在 `track_instrument` 发出那一刻还没到后端，
   * 后端只认 `set_tracks` 见过的轨 id，于是回 "no such track" —— 双击乐器"装不上"就是这个。
   * 装乐器、开音色窗之前必须先走这一条，让后端先有这条轨。
   */
  async syncTracks(proj: MidiProject): Promise<void> {
    this.pending = proj;
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
    await this.send(proj);
  }

  /** 排队发；返回的 Promise 在**轮到的那一轮**跑完之后 resolve。 */
  private send(proj: MidiProject): Promise<void> {
    this.queued = proj;
    if (this.inflight) return this.chain;
    this.inflight = true;
    this.chain = this.drain();
    return this.chain;
  }

  private async drain(): Promise<void> {
    try {
      while (this.queued) {
        const p = this.queued;
        this.queued = null;
        try {
          await this.pushOne(p);
        } catch {
          this.lastKey = '';           // 没发出去：下次同一份表还得重发
        }
      }
    } finally {
      this.inflight = false;
    }
  }

  private async pushOne(proj: MidiProject): Promise<void> {
    if (!this.available) return;
    // 声卡开不出来也照推：后端 set_tracks 记轨 id（以及按路径对账）不看设备开没开，
    // 而紧随其后的 track_instrument 只认这张表。早先在这里 return，装乐器就会拿着一个
    // 后端从没见过的轨 id 去问，回 "no such track" —— 真正的毛病（设备没开）被盖住了。
    if (!this.opened) await this.open();
    const rate = this.rate || 48000;
    const tracks = proj.tracks.map(t => ({
      // id 是引擎槽认主的凭据：轨在列表里挪了位置，乐器不用重装，只重绑。
      id: t.id,
      // 这一轨挂的乐器（绝对路径）；后端据它让槽跟上工程。空 = 这一轨不出声。
      instrument: t.instrument || '',
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

    const key = `${rate}|${JSON.stringify(tracks)}|${JSON.stringify(notes)}`;
    if (key === this.lastKey) return;
    if (!await this.post('tracks', { tracks })) { this.lastKey = ''; return; }
    if (!await this.post('notes', { notes })) { this.lastKey = ''; return; }
    this.lastKey = key;
  }

  async audition(note: number, vel = 100, track = 0): Promise<void> {
    if (!this.available) return;
    if (!this.opened) { await this.open(); }
    const st = await this.post('audition', { note, vel, track });
    // 这一下是真的要从引擎出声：Audio Monitor 得把它托管起来（见 nativeMonitor.ts）。
    if (st) noteNativeSound();
  }

  async panic(): Promise<void> {
    if (!this.opened) return;
    await this.post('panic');
  }

  /**
   * 装载一件乐器（绝对路径）：`.sfz` 走样本引擎，`.vstpreset` 走真插件（后端按扩展名分派）。
   * 返回后端算出来的结果 —— zone 数与失败数都是它数出来的，不是我们猜的。
   * `error` 非空就是没装上，界面要如实显示。
   */
  async loadInstrument(path: string): Promise<NativeInstrument> {
    const fail = (msg: string): NativeInstrument => ({ path, kind: '', zones: 0, failed: 0, kb: 0, error: msg });
    if (!this.available) await this.probe();
    if (!this.available) return fail('native engine unavailable');
    try {
      const r = await fetch('/api/audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'load_instrument', path }),
      });
      const j = await r.json() as Record<string, unknown>;
      const inst: NativeInstrument = {
        path: String(j?.path || path),
        kind: String(j?.kind || ''),
        zones: Number(j?.zones) || 0,
        failed: Number(j?.failed) || 0,
        kb: Number(j?.kb) || 0,
        error: String(j?.error || ''),
      };
      this.status = { ...this.status, instrument: inst };
      // VST3 没有 zone（预设 byte 数在 kb 里）；只有采样乐器才用 zone 数判"是不是装空了"。
      if (!inst.error && inst.kind !== 'vst3' && inst.zones <= 0) inst.error = 'no zone loaded';
      return inst;
    } catch (e) {
      return fail(String(e));
    }
  }

  /** 卸掉采样乐器/插件：这一轨从此不出声。 */
  async unloadInstrument(): Promise<void> {
    if (!this.available) return;
    const st = await this.post('unload_instrument');
    if (st) this.status = st;
  }

  /**
   * 给**这一条轨**装一件乐器。别的轨一件都不动 —— 引擎那边每条轨各有一支插件实例。
   * 工程里的 `MidiTrack.instrument` 要跟着写上：引擎重启/换轨后靠它复原。
   */
  async trackInstrument(trackId: string, path: string): Promise<NativeInstrument> {
    const fail = (msg: string): NativeInstrument =>
      ({ path, kind: '', zones: 0, failed: 0, kb: 0, error: msg });
    if (!this.available) await this.probe();
    if (!this.available) return fail('native engine unavailable');
    try {
      const r = await fetch('/api/audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'track_instrument', track: trackId, path }),
      });
      const j = await r.json() as Record<string, unknown>;
      const inst = toInstrument(j, path);
      inst.track = trackId;
      // 状态里那一行立刻换成这次的结果：轨道窗不用等下一次整份 status 就显示"装上了/卡在哪"。
      this.status = {
        ...this.status,
        instruments: (this.status.instruments || []).filter(x => x.track !== trackId).concat(inst),
      };
      this.notify();
      // VST3 没有 zone（预设 byte 数在 kb 里）；只有采样乐器才用 zone 数判"是不是装空了"。
      if (!inst.error && inst.ok !== false && inst.kind !== 'vst3' && inst.zones <= 0) inst.error = 'no zone loaded';
      return inst;
    } catch (e) {
      return fail(String(e));
    }
  }

  /** 把这一轨上的乐器收掉（这一轨从此不出声）。工程字段由调用方同步清掉。 */
  async trackUnload(trackId: string): Promise<void> {
    if (!this.available) return;
    await this.post('track_unload', { track: trackId });
  }

  // ── 插件自己的界面（挑音色）────────────────────────────────────────────────────────────────
  //
  // HALion / Kontakt 没有"列音色"的接口，音色只能由它们自己的界面挑。窗口开在 worker 进程里
  // （是**真的**系统窗口，不在这个页面里），所以这里只有三个动词：开、问还开着吗、存。
  // 这三条**不走 `post()`**：`post()` 会把回执并进 status，而回执里的 `open` 是"窗口开着吗"，
  // 并进去会把"声卡开着吗"改掉。
  private async editorCall(op: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    try {
      const r = await fetch('/api/audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, ...extra }),
      });
      const j = await r.json();
      return (j && typeof j === 'object' ? j : {}) as Record<string, unknown>;
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  /** 开这一轨的插件窗口。返回时窗口已经在屏幕上（或说清为什么没开出来）。 */
  async openTrackEditor(trackId: string): Promise<{ ok: boolean; error: string }> {
    const j = await this.editorCall('editor_open', { track: trackId });
    return { ok: j.ok === true, error: String(j.error || '') };
  }

  /** 替用户按下窗口的 X（agent 工具用）。关窗后由调用方走"存音色"那一步。 */
  async closeTrackEditor(trackId: string): Promise<{ ok: boolean; error: string }> {
    const j = await this.editorCall('editor_close', { track: trackId });
    return { ok: j.ok === true, error: String(j.error || '') };
  }

  /** 窗口还开着吗。用户点 X 关掉 = `open:false`（界面据此去存音色）。 */
  async trackEditorState(trackId: string): Promise<{ ok: boolean; open: boolean; error: string }> {
    const j = await this.editorCall('editor_state', { track: trackId });
    return { ok: j.ok === true, open: j.open === true, error: String(j.error || '') };
  }

  /** 把这一轨**现在**的声音存成 `.vstpreset`（落哪个目录由后端定：预设库，或 data/sampler/presets）。 */
  async saveTrackEditor(trackId: string, name: string): Promise<{
    ok: boolean; path: string; name: string; folder: string; bytes: number; kb: number;
    warning: string; error: string;
  }> {
    const j = await this.editorCall('editor_save', { track: trackId, name });
    return {
      ok: j.ok === true,
      path: String(j.path || ''),
      name: String(j.name || ''),
      folder: String(j.folder || ''),
      bytes: Number(j.bytes) || 0,
      kb: Number(j.kb) || 0,
      warning: String(j.warning || ''),
      error: String(j.error || ''),
    };
  }

  /** 试听一件**还没进工程**的乐器：装在试听槽，不碰任何轨的音符。`note<0` = 只装不出声。 */
  async preview(path: string, note = -1, vel = 100): Promise<NativeInstrument & { heard?: string }> {
    const fail = (msg: string): NativeInstrument =>
      ({ path, kind: '', zones: 0, failed: 0, kb: 0, error: msg });
    if (!this.available) await this.probe();
    if (!this.available) return fail('native engine unavailable');
    try {
      const r = await fetch('/api/audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'preview', path, note, vel }),
      });
      const j = await r.json() as Record<string, unknown>;
      const inst: NativeInstrument & { heard?: string } = toInstrument(j, path);
      inst.heard = typeof j?.heard === 'string' ? j.heard : '';
      if (inst.heard) noteNativeSound();      // 试听槽真出了一声，Monitor 照看它到声音散掉
      if (!inst.error && inst.kind !== 'vst3' && inst.zones <= 0) inst.error = 'no zone loaded';
      // 试听槽就是 `status.instrument` 说的那件 —— 不合并的话界面不知道它装上了（"loaded" 徽章不亮）。
      if (!inst.error) {
        this.status = { ...this.status, instrument: inst };
        this.notify();
      }
      return inst;
    } catch (e) {
      return fail(String(e));
    }
  }

  currentInstrument(): NativeInstrument | null {
    return this.status.instrument && this.status.instrument.path ? this.status.instrument : null;
  }
}

export const nativeEngine = new NativeEngine();
