// ── MIDI 工程模型 ─────────────────────────────────────────────────────────────────────────────
//
// 一份 .cud 里除了图层与视频，还可以带一套 MIDI。它跟视频那套是**并列**的：视频说"哪一秒画面
// 是哪张"，MIDI 说"哪一拍哪个乐器按哪个键、按多重"。两者共用同一个传输（同一个播放头、同一个
// 公共时钟），但那不意味着共用一个模型 —— 视频用秒，MIDI 用拍，混在一起两边都会难受。
//
// 三个决定，后面所有代码都靠它们成立：
//   1. **音符的时间单位是"拍"（四分音符 = 1），不是秒。** 改 BPM 时音符原地不动、听感变快 ——
//      这是 DAW 的定义方式。秒只在"发给外部音源"那一瞬才出现（beatToSeconds）。
//   2. **每根轨有一把"力度基线"（velScale）**，音符自带 1..127 的力度。两者相乘才是发出去的
//      力度。用户在轨道上拽的那根总推子，和某个音符自己的强弱，是两件事，不该互相顶掉。
//   3. **音高一律 0..127 的 MIDI 号**（60 = C4），不是"第几行"。界面画的是它，导出的也是它。
//
// 这个文件只做数据：没有 React、没有 DOM、没有网络。谁想改工程，都从这里的纯函数走。

export type MidiNote = {
  id: string;
  /** MIDI 音高 0..127（60 = C4 / 中央 C）。 */
  pitch: number;
  /** 起点，单位拍（四分音符 = 1）。 */
  start: number;
  /** 时长，单位拍。最小值由 MIN_DUR 兜住。 */
  dur: number;
  /** 力度 1..127 —— 这一条就是用户要的"乐器力度"。 */
  vel: number;
};

export type MidiTrack = {
  id: string;
  name: string;
  /** General MIDI program 0..127。鼓轨用 channel 9，program 无所谓。 */
  program: number;
  /** MIDI 通道 0..15（9 = 第十通道 = 鼓，MIDI 的惯例，改不了）。 */
  channel: number;
  /** 力度基线 0.1..2：整轨的乘数，不动音符自己的 vel。 */
  velScale: number;
  mute: boolean;
  solo: boolean;
  /** 轨道行上的那个色点。 */
  color: string;
  notes: MidiNote[];
};

export type MidiLoop = {
  on: boolean;
  /** 循环区间，单位拍。 */
  a: number;
  b: number;
};

export type MidiProject = {
  version: 1;
  /** 每分钟四分音符数。 */
  tempo: number;
  /** [分子, 分母]。分母只认 2/4/8/16。 */
  timeSig: [number, number];
  /** 导出 .mid 时的 tick 密度（每四分音符多少 tick）。内部一律用浮点拍。 */
  ppq: number;
  tracks: MidiTrack[];
  loop: MidiLoop;
  /** 界面上的选中项（跟着工程走，切文档能回到原来那一轨）。 */
  selTrack: string;
  selNote: string;
};

export const MIN_DUR = 1 / 32;          // 最短音：三十二分音符
export const MIN_VEL = 1;
export const MAX_VEL = 127;
export const MIN_TEMPO = 20;
export const MAX_TEMPO = 300;

let idSeq = 0;
export const newMidiId = (prefix: string): string => {
  idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${idSeq.toString(36)}`;
};

// ── 音名 ──────────────────────────────────────────────────────────────────────────────────────
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const pitchName = (pitch: number): string => {
  const p = Math.max(0, Math.min(127, Math.round(pitch)));
  return NAMES[p % 12] + (Math.floor(p / 12) - 1);
};
/** C4 = 60 那一套（Yamaha / 大多数 DAW 的默认）。 */
export const isBlackKey = (pitch: number): boolean => [1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12);

// ── General MIDI 音色（0..127）────────────────────────────────────────────────────────────────
// 只做"挑一个能认的名字"，不做资源管理：真正发出去的是 program change，音色由外部音源决定。
export const GM_PROGRAMS: string[] = [
  'Acoustic Grand', 'Bright Acoustic', 'Electric Grand', 'Honky-tonk', 'Electric Piano 1', 'Electric Piano 2',
  'Harpsichord', 'Clavinet', 'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone',
  'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica',
  'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
  'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass', 'Slap Bass 1', 'Slap Bass 2',
  'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2', 'Choir Aahs', 'Voice Oohs',
  'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)', 'Lead 5 (charang)',
  'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)', 'Pad 5 (bowed)', 'Pad 6 (metallic)',
  'Pad 7 (halo)', 'Pad 8 (sweep)',
  'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)', 'FX 5 (brightness)', 'FX 6 (goblins)',
  'FX 7 (echoes)', 'FX 8 (sci-fi)',
  'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bag pipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
];

export const programName = (program: number): string => GM_PROGRAMS[clampInt(program, 0, 127)] ?? 'Program';

/** 第十通道（index 9）在 MIDI 里恒为鼓，这是协议规定的，不是我们的偏好。 */
export const DRUM_CHANNEL = 9;

const TRACK_COLORS = ['#0a84ff', '#30d158', '#ff9f0a', '#bf5af2', '#ff453a', '#64d2ff', '#ffd60a', '#ff375f'];

// ── 小工具 ───────────────────────────────────────────────────────────────────────────────────
export const clampInt = (v: unknown, lo: number, hi: number): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
};
export const clampNum = (v: unknown, lo: number, hi: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
};

/** 拍 ↔ 秒。MIDI 只有这一个换算口 —— 谁要秒，谁从这里拿。 */
export const beatToSeconds = (beat: number, tempo: number): number => beat * (60 / Math.max(MIN_TEMPO, tempo));
export const secondsToBeat = (seconds: number, tempo: number): number => seconds * (Math.max(MIN_TEMPO, tempo) / 60);

/** 这个音符真正会发出去的力度（1..127）—— 音符自己的 × 轨道基线。 */
export const effectiveVelocity = (note: MidiNote, track: MidiTrack): number =>
  clampInt(note.vel * clampNum(track.velScale, 0.1, 2), MIN_VEL, MAX_VEL);

// ── 默认工程 ─────────────────────────────────────────────────────────────────────────────────
const track = (name: string, program: number, channel: number, colorIdx: number): MidiTrack => ({
  id: newMidiId('mtrk'),
  name,
  program,
  channel,
  velScale: 1,
  mute: false,
  solo: false,
  color: TRACK_COLORS[colorIdx % TRACK_COLORS.length],
  notes: [],
});

export const defaultMidiProject = (): MidiProject => {
  const tracks = [
    track('Piano', 0, 0, 0),
    track('Strings', 48, 1, 1),
    track('Bass', 33, 2, 2),
    track('Drums', 0, DRUM_CHANNEL, 3),
  ];
  return {
    version: 1,
    tempo: 120,
    timeSig: [4, 4],
    ppq: 480,
    tracks,
    loop: { on: false, a: 0, b: 16 },
    selTrack: tracks[0].id,
    selNote: '',
  };
};

// ── 读档 ─────────────────────────────────────────────────────────────────────────────────────
// 存档可能来自旧版本、手改过的 JSON、或者干脆不是 MIDI —— 一律读成一份**能用**的工程，
// 读不动的部分丢掉，不抛异常（抛了就等于整份 .cud 打不开，代价太大）。
export const normalizeMidiProject = (raw: unknown): MidiProject => {
  const base = defaultMidiProject();
  if (!raw || typeof raw !== 'object') return base;
  const o = raw as Record<string, unknown>;

  const tempo = clampNum(o.tempo, MIN_TEMPO, MAX_TEMPO);
  const tsRaw = Array.isArray(o.timeSig) ? o.timeSig : base.timeSig;
  const num = clampInt(tsRaw[0], 1, 16);
  const den = [2, 4, 8, 16].includes(Math.round(Number(tsRaw[1]))) ? Math.round(Number(tsRaw[1])) : 4;

  const tracksRaw = Array.isArray(o.tracks) ? o.tracks : [];
  const tracks: MidiTrack[] = [];
  for (const t of tracksRaw) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    const notesRaw = Array.isArray(r.notes) ? r.notes : [];
    const notes: MidiNote[] = [];
    for (const n of notesRaw) {
      if (!n || typeof n !== 'object') continue;
      const q = n as Record<string, unknown>;
      const pitch = clampInt(q.pitch, 0, 127);
      const start = Math.max(0, Number(q.start) || 0);
      const dur = Math.max(MIN_DUR, Number(q.dur) || MIN_DUR);
      const vel = clampInt(q.vel, MIN_VEL, MAX_VEL);
      notes.push({
        id: typeof q.id === 'string' && q.id ? q.id : newMidiId('mn'),
        pitch, start, dur, vel,
      });
    }
    notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    tracks.push({
      id: typeof r.id === 'string' && r.id ? r.id : newMidiId('mtrk'),
      name: typeof r.name === 'string' && r.name ? r.name : 'Track',
      program: clampInt(r.program, 0, 127),
      channel: clampInt(r.channel, 0, 15),
      velScale: clampNum(r.velScale, 0.1, 2),
      mute: !!r.mute,
      solo: !!r.solo,
      color: typeof r.color === 'string' && r.color ? r.color : TRACK_COLORS[0],
      notes,
    });
  }
  if (!tracks.length) tracks.push(...base.tracks);

  const loopRaw = (o.loop && typeof o.loop === 'object' ? o.loop : {}) as Record<string, unknown>;
  const a = Math.max(0, Number(loopRaw.a) || 0);
  const b = Math.max(a + 1, Number(loopRaw.b) || 16);

  const selTrack = typeof o.selTrack === 'string' && tracks.some(t => t.id === o.selTrack)
    ? o.selTrack : tracks[0].id;

  return {
    version: 1,
    tempo,
    timeSig: [num, den],
    ppq: clampInt(o.ppq, 24, 3840) || 480,
    tracks,
    loop: { on: !!loopRaw.on, a, b },
    selTrack,
    selNote: typeof o.selNote === 'string' ? o.selNote : '',
  };
};

// ── 派生量 ───────────────────────────────────────────────────────────────────────────────────
export const activeTrackOf = (p: MidiProject): MidiTrack | null =>
  p.tracks.find(t => t.id === p.selTrack) ?? p.tracks[0] ?? null;

/** 有独奏（solo）时，没独奏的轨都不出声 —— 这是 DAW 的规矩，不是我们的偏好。 */
export const audibleTracks = (p: MidiProject): MidiTrack[] => {
  const anySolo = p.tracks.some(t => t.solo);
  return p.tracks.filter(t => !t.mute && (!anySolo || t.solo));
};

/** 工程的长度（拍）：最后一个音符的尾巴，至少留一小节。 */
export const projectBeats = (p: MidiProject): number => {
  let end = p.timeSig[0];
  for (const t of p.tracks) for (const n of t.notes) end = Math.max(end, n.start + n.dur);
  return Math.ceil(end / p.timeSig[0]) * p.timeSig[0];
};

/** 这一轨在 [from, to) 拍区间里的音符 —— 播放调度与画都靠它。 */
export const notesInRange = (t: MidiTrack, from: number, to: number): MidiNote[] =>
  t.notes.filter(n => n.start < to && n.start + n.dur > from);

/** 一整张工程里，某个音高上有没有音符（钢琴卷帘画"灰键"用不到，留给将来的和声提示）。 */
export const pitchInUse = (p: MidiProject): Set<number> => {
  const s = new Set<number>();
  for (const t of p.tracks) for (const n of t.notes) s.add(n.pitch);
  return s;
};

// ── 编辑操作（纯函数：进一份工程，出一份新的）───────────────────────────────────────────────
const mapTrack = (p: MidiProject, id: string, fn: (t: MidiTrack) => MidiTrack): MidiProject =>
  ({ ...p, tracks: p.tracks.map(t => (t.id === id ? fn(t) : t)) });

/** id 是可选的：卷帘上"按下就落音、不松手拖着变长"那条手势必须**当场拿到这枚音的 id**
 *  才能在同一个手势里 updateNote 它 —— 让 addNote 自己生成 id 的话，调用方只能再去猜哪条是新的。
 *  不传就照旧自动生成。 */
export const addNote = (p: MidiProject, trackId: string, note: Omit<MidiNote, 'id'>, id?: string): MidiProject =>
  mapTrack(p, trackId, t => ({
    ...t,
    notes: [...t.notes, { ...note, id: id || newMidiId('mn') }].sort((a, b) => a.start - b.start || a.pitch - b.pitch),
  }));

export const updateNote = (p: MidiProject, trackId: string, noteId: string, patch: Partial<Omit<MidiNote, 'id'>>): MidiProject =>
  mapTrack(p, trackId, t => ({
    ...t,
    notes: t.notes
      .map(n => (n.id === noteId ? {
        ...n,
        ...patch,
        pitch: patch.pitch === undefined ? n.pitch : clampInt(patch.pitch, 0, 127),
        start: patch.start === undefined ? n.start : Math.max(0, patch.start),
        dur: patch.dur === undefined ? n.dur : Math.max(MIN_DUR, patch.dur),
        vel: patch.vel === undefined ? n.vel : clampInt(patch.vel, MIN_VEL, MAX_VEL),
      } : n))
      .sort((a, b) => a.start - b.start || a.pitch - b.pitch),
  }));

export const removeNotes = (p: MidiProject, trackId: string, noteIds: readonly string[]): MidiProject => {
  const drop = new Set(noteIds);
  return mapTrack(p, trackId, t => ({ ...t, notes: t.notes.filter(n => !drop.has(n.id)) }));
};

export const moveNotes = (p: MidiProject, trackId: string, noteIds: readonly string[],
                          dBeat: number, dPitch: number): MidiProject => {
  const set = new Set(noteIds);
  return mapTrack(p, trackId, t => ({
    ...t,
    notes: t.notes
      .map(n => (set.has(n.id)
        ? { ...n, start: Math.max(0, n.start + dBeat), pitch: clampInt(n.pitch + dPitch, 0, 127) }
        : n))
      .sort((a, b) => a.start - b.start || a.pitch - b.pitch),
  }));
};

export const setVelocities = (p: MidiProject, trackId: string, noteIds: readonly string[], vel: number): MidiProject => {
  const set = new Set(noteIds);
  const v = clampInt(vel, MIN_VEL, MAX_VEL);
  return mapTrack(p, trackId, t => ({ ...t, notes: t.notes.map(n => (set.has(n.id) ? { ...n, vel: v } : n)) }));
};

/** 量化：把起点（可选尾巴）吸附到 `grid` 拍的整数倍。 */
export const quantize = (p: MidiProject, trackId: string, grid: number, alsoLength = false): MidiProject => {
  const g = Math.max(1 / 32, grid);
  return mapTrack(p, trackId, t => ({
    ...t,
    notes: t.notes.map(n => {
      const start = Math.round(n.start / g) * g;
      const dur = alsoLength ? Math.max(MIN_DUR, Math.round(n.dur / g) * g) : n.dur;
      return { ...n, start, dur };
    }).sort((a, b) => a.start - b.start || a.pitch - b.pitch),
  }));
};

/** `name` 给"从乐器库添轨"用 —— 轨名就是乐器名，回来一眼认得出是哪件。 */
export const addTrack = (p: MidiProject, name?: string): MidiProject => {
  const idx = p.tracks.length;
  // 新轨自动绕开第十通道：那儿是鼓，抢来当旋律轨是新手最容易踩的坑。
  const used = new Set(p.tracks.map(t => t.channel));
  let ch = 0;
  while (used.has(ch) && ch < 16) ch += 1;
  if (ch >= 16) ch = 0;
  const t = track(name?.trim() || `Track ${idx + 1}`, 0, ch, idx);
  return { ...p, tracks: [...p.tracks, t], selTrack: t.id };
};

export const removeTrack = (p: MidiProject, trackId: string): MidiProject => {
  if (p.tracks.length <= 1) return p;
  const tracks = p.tracks.filter(t => t.id !== trackId);
  return { ...p, tracks, selTrack: tracks[0].id, selNote: '' };
};

export const updateTrack = (p: MidiProject, trackId: string, patch: Partial<Omit<MidiTrack, 'id' | 'notes'>>): MidiProject =>
  mapTrack(p, trackId, t => ({
    ...t,
    ...patch,
    program: patch.program === undefined ? t.program : clampInt(patch.program, 0, 127),
    channel: patch.channel === undefined ? t.channel : clampInt(patch.channel, 0, 15),
    velScale: patch.velScale === undefined ? t.velScale : clampNum(patch.velScale, 0.1, 2),
  }));
