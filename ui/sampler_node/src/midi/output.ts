// ── MIDI 输出：把音符交给外部音源 ─────────────────────────────────────────────────────────────
//
// 本机不出声。这里只做一件事：把工程里的音符，按**公共时钟**排好队，交给浏览器的 Web MIDI
// 送出去 —— 收头的是外部硬件、VST 宿主、或任何认 MIDI 的东西。
//
// 三条要害：
//   1. **时间戳必须来自 clock.perfAt()**。Web MIDI 的 `send(data, timestamp)` 里那个 timestamp
//      是 performance.now() 域的时刻；我们把它从"传输第几秒"换算过来，等于让设备端按**播放头**
//      对齐，而不是按"JS 什么时候轮到这一行"对齐。少了这一步，主线程一抖音符就散。
//   2. **提前量（lookahead）**：每帧只把未来 200ms 内的事件发出去。发太早，用户按下暂停时设备
//      里已经排了几秒的活停不下来；发太晚，一帧掉到 20ms 就晚了。
//   3. **一切中断都要 allNotesOff**。暂停、seek、切轨、断开端口 —— 只要不补这一手，就会留下
//      一个永远按住的音（合成器上的"卡音"），这比不发声更让人抓狂。

import { clock } from './clock';
import { NATIVE_PORT_ID, nativeEngine } from './engine';
import { type MidiProject, type MidiTrack, audibleTracks, beatToSeconds, MIN_TEMPO } from './model';

/** 未来多少秒内的事件现在就发。200ms ≈ 12 帧，掉几帧也追得上，暂停时又不会排太远。 */
const LOOKAHEAD = 0.2;

/** 试听音按住多久。与引擎那头 AUDITION_SECONDS（audio_bridge.py）是同一个数 ——
 *  同一次 ♪ 不管落到本机引擎还是外部端口，听起来的长度必须一样。 */
const AUDITION_MS = 700;

export type MidiPort = { id: string; name: string; manufacturer: string };

type Ev = {
  /** 在传输里的时刻（秒）。 */
  sec: number;
  on: boolean;
  pitch: number;
  vel: number;
  ch: number;
  /** 归属的轨 —— 静音要能单独掐掉，切轨也要能只停它。 */
  trackId: string;
};

type Listener = () => void;

class MidiOut {
  private access: MIDIAccess | null = null;
  private out: MIDIOutput | null = null;
  private ports: MidiPort[] = [];
  private selectedId = '';
  private error = '';
  private subs = new Set<Listener>();

  private evs: Ev[] = [];
  private idx = 0;
  private lastProj: MidiProject | null = null;
  /** 上一次 tick 时播放头在哪 —— 用来发现 seek / 回绕。 */
  private lastPos = -1;
  /** 上一帧是不是在播 —— 停下来的那一瞬要补一次 allNotesOff，之后就不必每帧都补。 */
  private wasPlaying = false;

  // ── 设备 ──────────────────────────────────────────────────────────────────────────────────
  getPorts(): MidiPort[] { return this.ports; }
  getSelected(): string { return this.selectedId; }
  getError(): string { return this.error; }
  isOpen(): boolean {
    if (this.selectedId === NATIVE_PORT_ID) return nativeEngine.opened;
    return !!this.out;
  }
  /** 是不是选了自己的引擎（不是外部端口）。 */
  isNative(): boolean { return this.selectedId === NATIVE_PORT_ID; }

  /**
   * 探一下本机有没有原生引擎（后端起没起、DLL 在不在）。不开设备、不申请权限，
   * 所以可以在页面加载时调一次 —— 探到就把 `Kolid Native Engine` 摆进端口表并选中它。
   */
  async probeNative(): Promise<boolean> {
    const ok = await nativeEngine.probe();
    this.refreshPorts();
    if (ok && !this.selectedId) this.select(NATIVE_PORT_ID);
    return ok;
  }

  subscribe(fn: Listener): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }
  private emit(): void { for (const fn of this.subs) { try { fn(); } catch { /* 一扇窗坏了不拖累别的 */ } } }

  /** 要用户手势触发（浏览器规定）。返回是否拿到访问权。 */
  async connect(): Promise<boolean> {
    this.error = '';
    try {
      if (!this.access) {
        if (typeof navigator === 'undefined' || !('requestMIDIAccess' in navigator)) {
          this.error = 'This browser has no Web MIDI.';
          this.emit();
          return false;
        }
        this.access = await navigator.requestMIDIAccess({ sysex: false });
        this.access.onstatechange = () => this.refreshPorts();
      }
      this.refreshPorts();
      return this.ports.length > 0;
    } catch (e) {
      this.error = (e as Error)?.message || 'MIDI access denied';
      this.emit();
      return false;
    }
  }

  /** 用户点了"重扫端口"：先重探本机引擎（后端可能刚重启过），再列一遍外部端口。 */
  rescan(): void {
    void this.probeNative();
  }

  private refreshPorts(): void {
    // 本机引擎永远排第一 —— 它不需要权限、不需要装东西，是"想听一下"的默认答案。
    const list: MidiPort[] = [];
    if (nativeEngine.available) {
      list.push({ id: NATIVE_PORT_ID, name: 'Kolid Native Engine', manufacturer: 'this machine' });
    }
    if (this.access) {
      this.access.outputs.forEach(o => {
        list.push({ id: o.id, name: o.name || 'MIDI Out', manufacturer: o.manufacturer || '' });
      });
    }
    this.ports = list;
    if (this.selectedId && !list.some(p => p.id === this.selectedId)) this.selectedId = '';
    if (!this.selectedId && list.length) this.select(list[0].id);
    this.emit();
  }

  select(id: string): void {
    this.allNotesOff();
    this.selectedId = id;
    this.resetSchedule();
    if (id === NATIVE_PORT_ID) {
      this.out = null;
      // 开设备要用户手势之外还有点异步：开好后把手上这份工程补发一次（否则第一次播放是空的）。
      void nativeEngine.open().then(ok => {
        if (ok && this.lastProj) this.rebuild(this.lastProj, true);
        this.emit();
      });
      this.emit();
      return;
    }
    this.out = this.access?.outputs.get(id) ?? null;
    if (this.out) this.out.open?.().catch(() => { /* 有些实现没有 open() */ });
    this.emit();
  }

  // ── 发送 ──────────────────────────────────────────────────────────────────────────────────
  private raw(bytes: number[], at?: number): void {
    if (!this.out) return;
    try {
      if (at === undefined) this.out.send(bytes);
      else this.out.send(bytes, at);
    } catch { /* 端口刚被拔掉 */ }
  }

  noteOn(ch: number, pitch: number, vel: number, at?: number): void {
    this.raw([0x90 | (ch & 0x0f), pitch & 0x7f, Math.max(1, Math.min(127, Math.round(vel))) & 0x7f], at);
  }
  noteOff(ch: number, pitch: number, at?: number): void {
    this.raw([0x80 | (ch & 0x0f), pitch & 0x7f, 0], at);
  }
  controlChange(ch: number, cc: number, value: number, at?: number): void {
    this.raw([0xb0 | (ch & 0x0f), cc & 0x7f, value & 0x7f], at);
  }

  /** 所有通道所有的音都放开。任何中断都该先走这一句。 */
  allNotesOff(): void {
    if (this.selectedId === NATIVE_PORT_ID) { void nativeEngine.panic(); return; }
    for (let ch = 0; ch < 16; ch++) this.controlChange(ch, 123, 0);   // All Notes Off
  }

  /**
   * 试听一个音（点乐器上的 ♪、拖力度时听一下）。**不看传输在不在播** —— 试听是"我想听一下
   * 这个音色"，跟播放头停在哪没关系（引擎那头也是这么实现的：暂停时照样渲染试听音）。
   *
   * 选了本机引擎就走它；**一个端口都没连上时也走它** —— 否则在 Assets 里点 ♪ 会一声不出，
   * 看起来像坏了。只有"明确选了外部端口且它开着"才发 MIDI 出去。
   *
   * 知道是哪一轨就传 `trackId`：2b 之后每条轨各有一支实例，同通道的两条轨是两件乐器，
   * 按通道反查会把试听打到别人的乐器上。
   */
  audition(ch: number, pitch: number, vel: number, trackId?: string): void {
    const native = this.selectedId === NATIVE_PORT_ID;
    if (native || !this.out) {
      if (nativeEngine.available) {
        // 引擎按「第几条轨道」认乐器，按轨 id 反查；没有 id 的老调用方按通道反查（取第一条）。
        const idx = this.lastProj
          ? (trackId ? this.lastProj.tracks.findIndex(t => t.id === trackId)
            : this.lastProj.tracks.findIndex(t => t.channel === ch))
          : -1;
        void nativeEngine.audition(pitch, vel, idx >= 0 ? idx : 0);
      }
      if (native || !this.out) return;
    }
    this.noteOn(ch, pitch, vel);
    window.setTimeout(() => this.noteOff(ch, pitch), AUDITION_MS);
  }

  /** 有没有能出声的路子（本机引擎或已连上的外部端口）。界面靠它决定 ♪ 要不要给提示。 */
  canAudition(): boolean {
    return nativeEngine.available || !!this.out;
  }

  // ── 调度 ──────────────────────────────────────────────────────────────────────────────────
  /** 换工程/改音符后重建事件表。调用方不必精确 —— 下一帧的 tick 会自己发现失配。 */
  rebuild(proj: MidiProject, force = false): void {
    this.lastProj = proj;

    // 走本机引擎：整张表推过去，静音/独奏由引擎自己算（按 M/S 立刻生效，不必重推）。
    // 注意这里**不**过滤 audibleTracks —— 过滤掉的话后端就再也看不到那条轨了。
    if (this.selectedId === NATIVE_PORT_ID) {
      nativeEngine.push(proj, force);
      this.resetSchedule();
      return;
    }

    const evs: Ev[] = [];
    const aud = new Set(audibleTracks(proj).map(t => t.id));
    for (const t of proj.tracks) {
      const ch = t.channel;
      const scale = t.velScale;
      for (const n of t.notes) {
        if (!aud.has(t.id)) continue;
        const onSec = beatToSeconds(n.start, proj.tempo);
        const offSec = beatToSeconds(n.start + n.dur, proj.tempo);
        const vel = Math.max(1, Math.min(127, Math.round(n.vel * scale)));
        evs.push({ sec: onSec, on: true, pitch: n.pitch, vel, ch, trackId: t.id });
        evs.push({ sec: offSec, on: false, pitch: n.pitch, vel: 0, ch, trackId: t.id });
      }
    }
    evs.sort((a, b) => a.sec - b.sec || (a.on ? 0 : 1) - (b.on ? 0 : 1));
    this.evs = evs;
    this.resetSchedule();
  }

  private resetSchedule(): void {
    this.idx = 0;
    this.lastPos = -1;
  }
  /** 每个动画帧调一次（由 MIDI 模式的宿主统一驱动，别让每扇窗各调一遍）。 */
  tick(proj: MidiProject): void {
    if (this.lastProj !== proj) { this.rebuild(proj); return; }

    // 引擎自己每块问一次时钟，这里**不发**任何事件 —— 多发一次就是两只钟。
    // 只在「停下来」那一瞬补一次静音，防止暂停时留下按住的音。
    if (this.selectedId === NATIVE_PORT_ID) {
      const playingNative = clock.isPlaying();
      if (!playingNative && this.wasPlaying) void nativeEngine.panic();
      this.wasPlaying = playingNative;
      return;
    }
    if (!this.out) return;

    const playing = clock.isPlaying();
    const pos = clock.seconds();

    // 停下来的那**一瞬**补一次 allNotesOff，而不是每帧都补 —— 每帧发 16 条 CC 是白烧，
    // 还会在有些设备上把正在延音的音切碎。
    if (!playing) {
      if (this.wasPlaying) {
        this.allNotesOff();
        this.resetSchedule();
        this.wasPlaying = false;
      }
      return;
    }
    if (!this.wasPlaying) {
      this.resetSchedule();
      this.wasPlaying = true;
    }
    if (this.lastPos < 0 || pos < this.lastPos - 0.05 || pos > this.lastPos + 0.5) {
      // seek / 回绕：把已发出去的音收掉，游标挪到新位置
      this.allNotesOff();
      this.idx = this.lowerBound(pos);
    }
    this.lastPos = pos;

    const horizon = pos + LOOKAHEAD;
    const nowPerf = performance.now();
    let guard = 0;
    while (this.idx < this.evs.length && this.evs[this.idx].sec < horizon && guard++ < 4096) {
      const e = this.evs[this.idx++];
      if (e.sec < pos - 0.001) continue;             // 已经过去了：不发（否则一打开就炸一片音）
      const at = Math.max(nowPerf + 1, clock.perfAt(e.sec));
      if (e.on) this.noteOn(e.ch, e.pitch, e.vel, at);
      else this.noteOff(e.ch, e.pitch, at);
    }
  }

  private lowerBound(sec: number): number {
    let lo = 0, hi = this.evs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.evs[mid].sec < sec) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** 切轨时只想停某一轨的音（别的轨还在响）。 */
  silenceTrack(track: MidiTrack): void {
    for (const n of track.notes) this.noteOff(track.channel, n.pitch);
  }
}

export const midiOut = new MidiOut();

/** 便于诊断：这一份工程"现在应该按着哪几个音"。界面上的键位高亮用它，不必自己再算一遍。 */
export const heldNotes = (proj: MidiProject, atSeconds: number): Set<number> => {
  const held = new Set<number>();
  const beat = atSeconds * (Math.max(MIN_TEMPO, proj.tempo) / 60);
  for (const t of audibleTracks(proj)) {
    for (const n of t.notes) {
      if (beat >= n.start && beat < n.start + n.dur) held.add(n.pitch);
    }
  }
  return held;
};
