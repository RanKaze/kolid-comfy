# Audio 模式与 MIDI 窗：全页只有一根播放头

> 目标（用户原话）：参考 `F:\Pathes\Desktop\music-learning`，workbench 除了 Image / Video 还要提供 **Audio 模式**；再新加一个 **MIDI Dock Window**，**它的播放头和 Tracks 的播放头必须一致，不要出现多种不同的播放头来源标准**。
>
> 后续确认的两个目标：**① 行为要能做"像 Wwise"**（§11）；**② 要能集成到 Unity**（§13）。这两条不是"以后再说"，它们修改了前面几处技术选择 —— 凡有冲突，以 §11 / §13 的修订为准。
>
> **⚠️ 最新一次修订（覆盖 §13 / §14 的运行时部分）**：用户拍板运行时**不是** C# —— 而是一个**外置的 Rust 引擎包体**（像外置 dll 一样共享给 Unity）。于是"一个决策层、两个适配器"作废，改为"**一份 Rust 源码 + 三个宿主绑定**"。
> 取代范围：**§13.3 / §13.9 / §14.2 / §14.4 / §14.6**；未受影响、继续有效的是：**§13.1 / §13.2 / §13.4 / §13.5 / §14.1 / §14.3 / §14.5**（目标选型、MIDI 不进运行时、bank 交付物、Unity API 面、整数样本这些规矩都没变）。
> 定稿文在 **`docs/audio_engine_package.md`**。
>
> 本文只做设计，不动代码。行号不写死（工作区正在改），一律按**符号名**定位。

---

## 0. 一句话结论

播放头今天**已经是一颗外置的数**（`VidTransport`），但**时钟住在 `VidPlayer` 里** —— 而 `VidPlayer` 只在 Video 模式下挂载。所以 Audio 模式的走带、MIDI 窗的走带，今天都能很自然地"再造一个"——那正是用户明令禁止的局面。

因此顺序只能是：

1. **先把时钟从 `VidPlayer` 搬进宿主级 `VidEngine`**（`VidTransport` 从"Player 的私有数"升格为"全页唯一的播放头"），并用**类型**把"谁能写播放头"卡死；
2. **Audio 模式**只是同一棵 dock 树里"文档窗正文"的第三种活法（画布 ↔ 播放器 ↔ 调音台），模式本身仍然随 `.cud` 走；
3. **MIDI 窗**是又一扇只**读**同一根 `clock` 的窗 —— 时间轴、缩放、播放头三样各只有一个来源，与 Tracks 完全同源。

一句话：**Audio 模式是"听"，MIDI 窗是"编"，两者都不产生新的时钟。**

---

## 1. 现状：播放头今天归谁（审计）

| 角色 | 位置 | 能做什么 |
| --- | --- | --- |
| 时钟（唯一推进者） | `Player.tsx` 的播放循环 effect（`transport.set(np)`，墙上时钟 `performance.now` 推进） | 播放时逐帧推进时间线 |
| 用户 seek | `EditPhase` 的 `vidSeek = createSeekCoalescer(vidTransport)` → `transport.set(t, true)` | 标尺拖动 / 各窗跳转 |
| 读者 | `VidTimeline`（线/三角/读数/底注/跟随滚动）、`VidKeyframes`（线/三角/每行值框）、`VidPlayer`（读数/scrub 条/画面同步） | 全部 `transport.subscribe` 后**直改 DOM** |
| 时钟状态 | `EditPhase` 的 `vidPlaying`（React state）+ `vidPlayingRef` | 播放开关 |
| 缩放 | `EditPhase` 的 `vidPps`；Tracks 的滚动条把手写它（`vid.setPps`） | 每秒多少像素 |
| 试听例外 | `Inspector.tsx` 窗底那条"独立播放头" | 只试听那一件资产，**不进时间线**（已写明，保持） |

关键事实（决定了方案）：

- `VidController.transport` 今天**同时**给了 `get`/`set`/`subscribe`，但全仓只有两处真的 `set`：Player 的循环、seek 合流器。**读者从未写过它。**
- `VidPlayer` 只在 Video 模式挂进"文档窗正文"（`EditPhase.docBodies`：`active && vidMode === 'video'`）。
- 切模式会停播（`useEffect(() => { if (vidMode !== 'video') setVidPlaying(false) }`），因为那时时钟随 Player 一起没了。
- `VidKeyframes` 已经示范了"第二扇窗 + 同一根播放头"该怎么办：**自己的缩放、段的局部时间域、`transport` 订阅直改 DOM、越出段就不画**。它不是第二个时钟，它是同一根时钟的第二块幕布。
- 音频设施已经齐了：`VidAudio`（全局单例，WebAudio 播放引擎）、`audioFocus`（全页独占一个出声槽）、`VidAudioMonitor`（表）。
- 工程持久化：`VidProject` 走 `localStorage['sampler.videoProject']`（起手页存档）+ `.cud` 的 `ctx.video`（`blend-vid-restore` / `blend-request-vid`），读档一律过 `normalizeVidProject`。

---

## 2. 目标不变量（先立规矩，再写功能）

| # | 不变量 | 怎么保证 |
| --- | --- | --- |
| **I1** | 全页**只有一个**时间线时间：`VidEngine.clock.get()` | 只有 engine 持有可写 transport；`VidController` 给出去的 `clock` 类型**没有 set** |
| **I2** | 只有 engine 推进时间（rAF + 音频时钟锚）；窗口只能 `seek` | `VidController.seek` 仍是唯一入口（内部走 seek 合流器） |
| **I3** | 每扇窗的播放头都是**订阅后直改 DOM**，不新建 React state、不缓存第二份时间 | 照 `VidTimeline` / `VidKeyframes` 现成手法 |
| **I4** | 时间轴单位一律**时间线秒**；MIDI 音符在段内也换算到时间线秒才画、才排 | 单一换算函数 `midiNoteAtTimeline()`，只此一处 |
| **I5** | 缩放只有**一颗**（`vid.pps`）；任何窗要改缩放就调 `vid.setPps` | MIDI 窗不另存"每秒多少像素" |
| **I6** | 播放开关只有**一处状态**（engine），UI 是它的投影 | `engine.onPlaying` → 宿主 `vidPlaying` |
| **I7** | 试听例外唯一：Inspector 的独立播放头，且只播那一件资产 | 注释 + 探针检查；MIDI 窗绝不采用 |

I1 + I2 就是用户要的那句话：**没有第二种播放头来源**。

---

## 3. P0：把时钟从 Player 搬进宿主引擎（**先做这一步**）

### 3.1 新模块 `workbench/video/engine.ts`

```ts
// 唯一持有"可写播放头"的地方
export class VidEngine {
  clock: VidClock;                       // 给窗口：get / subscribe（无 set）
  setProject(p: VidProject): void;       // 换文档 / 读档回来 / 撤销重做后的工程（会先停）
  play(): void;  pause(): void;  stop(): void;
  seek(t: number): void;                 // rAF 合流，interactive = true
  isPlaying(): boolean;
  onPlaying(fn: (v: boolean) => void): () => void;
  addSink(s: VidSink): () => void;       // 播放时每帧回调（Player 的视频同步挂这里）
  dispose(): void;
}
type VidSink = { tick?: (t: number, dt: number, playing: boolean) => void };
```

内部三件事，全部从 `Player.tsx` 原样搬来：

1. **时钟**：播放中用 **AudioContext 锚**（`t = anchor.timelineT + (ctx.currentTime - anchor.ctxT)`）而不是 `performance.now` —— 长播不漂、与 MIDI/音频同一个时钟源（与参考项目 `Transport.position` 同款口径：一个音频时钟排所有声部）。`ctx` 没在跑（还没用户手势 / 被挂起）时退回 `performance.now` 锚。rAF 只负责"把当前时间写进 transport + 通知订阅者"。
2. **音频对表**：现在 Player 循环里那段"覆盖游标的音频段起播 / 偏差 > 80ms 重起 / 扫出去就停"整段搬进来（`startVoice` + `vidAudio`）。
3. **走带语义**：I/O 范围内回绕、片尾停、`inPoint` 起播 —— 逐条保持现在的行为。

再挂两样（后两个阶段用）：`MidiSynth` 的前瞻调度（§5.6）与 `audioFocus` 的独占槽（**申请/释放搬到 engine**，不再由 Player 管 —— Player 一卸载就不会把槽扔掉，Audio Monitor 才不会在 Audio 模式下忽然"没人出声"）。

### 3.2 类型即门禁

`model.ts` 里把 `VidTransport` 拆成两个类型：

```ts
export type VidClock = { get(): number; subscribe(fn: (interactive?: boolean) => void): () => void };
// VidController.transport: VidTransport  →  clock: VidClock
```

窗口拿到的**没有 set**。今天唯一的两处 `set` 自然只剩 engine 内部 —— 以后谁想加第二个时钟，先要过编译。

### 3.3 行为等价清单（P0 的验收就是"什么都没变"）

- Video 模式：▶/⏸/⏹、I/O 回绕、片尾停、scrub（拖动跟手缩略条）、换段、声音对表、视频漂移纠偏、Audio Monitor 电平、独占槽抢占（Inspector 抢播放器）。逐条手测。
- 切 tab（Draw → 其它）停播；切文档停播；切回 Video 继续可用。
- 关键帧录制（transport 订阅那条回路）不受影响。

### 3.4 顺带收掉的三个隐患

| 隐患 | 今天 | P0 之后 |
| --- | --- | --- |
| 离开 Video 就没声音 | Audio 模式/MIDI 无法播 | 引擎在宿主，Audio 模式照播（`mode → image` 才停） |
| Player 卸载顺手还槽 | Audio Monitor 显示"没人出声"但声音可能还在 | 槽归 engine，与窗口生死无关 |
| 两处时钟写法 | 每个新面板都想自己 rAF | 只有一个循环 |

---

## 4. Audio 模式

### 4.1 模式模型（三态，仍随 `.cud` 走）

```ts
export type VidMode = 'image' | 'video' | 'audio';   // 今天只有前两个
```

改动点（每一处都要过）：

| 位置 | 现状 | 改成 |
| --- | --- | --- |
| `VidProject.mode` | `'image' \| 'video'` | 三态；旧档无字段 → `'image'` |
| `normalizeVidProject` 末尾 | `mode: p.mode === 'video' ? 'video' : 'image'` | 三值白名单，未知值 → `'image'` |
| `EditPhase` 的 `vidMode0` / `setVidMode` / `syncVidMode` | `localStorage['sampler.vidMode'] === 'video'` | 三值读；坏值 → `'image'` |
| 文档窗 `heads` 里的分段控件 | 两颗 Image/Video | 三颗 Image/Video/Audio（同一个位置、同一颗 `RunStatusSeg` 左边） |
| `docBodies` 正文 | 画布 / `VidPlayer` | 画布 / `VidPlayer` / `VidAudioConsole` |

### 4.2 文档窗正文 = Audio Console（"听"的那一面）

新增 `workbench/audio/Console.tsx`（`fullBleed` + `grows`，与 Player 同待遇），自下而上：

```
┌─────────────────────────────────────────────────────────────┐
│ 走带条：⏮ ▶ ⏸ ⏹  0:12.4 / 1:30.0  [I 0:10.0 · O 1:20.0]  🔁 │  ← 与 Player 共用同一个组件
├─────────────────────────────────────────────────────────────┤
│ 通道条（只列 audio / midi 轨，按轨道序）                       │
│ ┌────────┐┌────────┐┌────────┐                              │
│ │▮ Audio1││▮ Midi 1││▮ Audio2│   每格：类型章 · 名字 · 立体声表 │
│ │  ████  ││  ████  ││  ████  │        · 推子(dB) · 声像         │
│ │  ════  ││  ════  ││  ════  │        · M / S                  │
│ │ fader  ││ fader  ││ fader  │                                │
│ │  M  S  ││  M  S  ││  M  S  │                                │
│ └────────┘└────────┘└────────┘                              │
├─────────────────────────────────────────────────────────────┤
│ 主输出：Master 推子 + 主表（VidAudio.master 的那一只 analyser） │
└─────────────────────────────────────────────────────────────┘
```

- **走带条抽成一个组件**（`workbench/audio/TransportBar.tsx`），Player 与 Console 都用它 —— 否则两颗 ▶ 迟早长成两种行为（这正是用户担心的"多种标准"，只不过发生在按钮上）。
- **不列视频 / Layer / process 轨**（它们不出声），底注一行说明"视频轨在 Video 模式看画面"。
- **不显示画布**：Audio 模式下活的工作台 iframe 照旧常驻，但 `measureFrame` 返回 null → 它停在屏幕外（`left/top: -12000`，`opacity: 0`）—— 这是现成的机制，不新增分支。
- 空工程 / 没有文档：与其它窗同一句空态。
- MIDI 窗不放走带按钮（一处一个可见入口）：Console 与 Player 是"放"，MIDI 窗只是"编 + 定位"。

### 4.3 混音链路：一条，所有声源都汇到这里

```
audio 片段 ─┐
            ├─▶ trackBus(trackId): gain ─▶ StereoPanner ─▶ analyser(表) ─▶ master ─▶ destination
MIDI 声部 ──┘
```

`VidAudio` 升级（`workbench/video/audio.ts`）：

- `bus(trackId)`：懒建每轨的 gain + panner + analyser，挂在原 `master` 之下；
- `start(id, buffer, into, gain, pan)`：声源接**轨 bus**，不再直接接 master；
- `masterAnalyser`：Console 的主表 / Audio Monitor 共用；
- mute/solo **仍只有一条规则**：`audioAudible(trackId, soloAudio, mute)`（MIDI 轨归**音频域**，所以 S 键语义不变："只响 solo 的音轨"）。轨 bus 上再加一道闸（gain=0），与"不启动"共用同一份集合，不会漂。

### 4.4 新增字段（全部随 `.cud` 走，缺省即不写）

| 字段 | 位置 | 缺省 | 说明 |
| --- | --- | --- | --- |
| `gain?: number` | `VidTrack` | `0` dB | 推子（-60…+6；-60 当 -∞） |
| `pan?: number` | `VidTrack` | `0` | 声像（-1…+1） |
| `masterGain?: number` | `VidProject` | `0` dB | 主推子 |

三者都只被"听"用；不影响画面、不影响已有存档（字段缺省 = 老行为）。

---

## 5. MIDI Dock Window

### 5.1 窗口注册（一次全套，照 `vkf` 的先例）

| 位置 | 加什么 |
| --- | --- |
| `EditPhase.PANEL_IDS` | `'vmidi'` |
| `UNIT_TITLES` | `vmidi: 'MIDI'` |
| `dockRulesFor` | `fullBleed` ✔、`grows` ✔、`right` 列插在 `vkf` 之后、`blockSize`（竖 360 / 横 760） |
| `bodies` | `<VidMidi vid={vidCtl} />`；无打开文档 = 一句空态（与 `vkf` 同款） |
| `workbench/icons.tsx` | 一枚"钢琴键 + 音符"的 16px 记号（`UNIT_ICONS.vmidi`） |
| `dock/model.ts` `fitLayout` | **补一条特例**：老布局里有 `vkf` 但没有 `vmidi` 时，在 `vkf` 下面**劈一格**（照 `pipeline/presets` 那条先例）。否则它会被通用规则塞进"最长的块"变成一张藏在别人背后的 tab —— 用户升级后以为没加 |

已有布局的升级因此是"多一扇看得见的窗"，不是"多一张看不见的 tab"。

> 为什么不做进工作台 iframe（`blend_node.html`）：那个页面是**图像合成器**，工程与走带都在宿主 React 树里（`vidProject` / `vidClock`）。塞进去就要跨窗同步第二份工程与第二份时间 —— 正是本方案要消灭的东西。MIDI 窗和 Tracks / Keyframes 一样，是宿主里的普通窗。

### 5.2 数据模型：MIDI 段 = 装着音符的容器，时间口径与音频段同构

```ts
type VidTrackKind = 'video' | 'audio' | 'layer' | 'process' | 'midi';   // + midi

type VidTrack = { …; instrument?: string; gain?: number; pan?: number };
// instrument = 内置合成器预设 id（见 §5.6），缺省 'piano'

type MidiNote = {
  id: string;   // newVidId('nt')
  s: number;    // **源内秒**：与段的 offset 同一个坐标系；落在 [offset, offset+duration) 里的才看得见
  d: number;    // 时长秒
  p: number;    // 0…127
  v: number;    // 0…1 力度
};

type VidClip = { …; notes?: MidiNote[] };   // kind === 'midi' 时才有
type VidProject = { …; tempo?: number; beatsPerBar?: number; grid?: number };
// tempo 缺省 120，beatsPerBar 缺省 4，grid = 吸附步长（以拍为单位，缺省 0.25 = 十六分）
```

**为什么是"源内秒"而不是"段时间线坐标"或"拍"：**

> ⚠️ 本节是"与视频时间线同构"的基线版本。**Wwise 已确认为目标**，所以时间单位按 §11.2 的 W1 定稿：音符存**相对段的拍**、段自带 `tempo`/`beatsPerBar`、`duration` 由拍数算出。下面关于"容器/裁剪/剪开/粘贴零改动"的结论**同样成立**（只是换算多一步，且换算只住在 `musicalTime.ts` 一处）。

- 与既有段的 `start / duration / offset` 语义**同构**：`源内秒` + `offset` 就是"这一段从源里哪一块开始放"。
- 于是 `moveClip` / `trimClip` / `splitClip` / `copyVidClips` / `pasteVidClips` / 联动组 / 吸附 **全部零改动生效**：拖动只动 `start`，裁剪只动 `offset/duration`，剪开右半 `offset += cut` —— 音符一动不动地跟着段走，裁掉的部分不是被销毁，是"窗口外"，拉回来还在（与音频段同一读法）。
- 唯一需要给 `trimClip` 加的是一个分支：`midi` 段**无边**（像 `layer/process` 那样不受 `srcDuration` 限制），但 `offset` 要跟着左边走（现成 `timeless` 分支把 offset 钉成 0，那是给"无源"段的；MIDI 要 `offset += d`，允许为负 —— 负源内秒没有副作用，它只是一个坐标）。

**tempo 的口径（V1，写死并写进 tooltip）：**

- 音符存秒 ⇒ 改 tempo **不移动音符**；tempo 只决定网格线与吸附步长的位置。
- 因为这是"对画面配乐"的工作台，音符跟**画面秒**走比跟拍号走更符合用途；真正的音乐时间映射（拍 ↔ 秒、速度变化）留给后续。
- 备选（本文不拍板）：音符存"拍"，`t_sec = beat × 60 / tempo`，改 tempo 音符跟着音乐走（DAW 习惯，但会让"段 offset/duration 是秒"和"音符是拍"两套单位并存）。见 §10 决策 3。

### 5.3 时间轴 / 缩放 / 播放头：三样各只有一个来源

| 东西 | 来源 | 落地 |
| --- | --- | --- |
| 时间轴 | 时间线**绝对秒** | 网格 x = `(t − scrollLeft) × pps`；音符的 t 由 `段.start + (note.s − 段.offset)` 算出（单函数 `noteTimelineT()`） |
| 缩放 | `vid.pps`（全页唯一那颗） | 不存第二份；`Fit` 按钮 = `vid.setPps(铺满这一段)`，与 Tracks 滚动条把手**同一个写口** |
| 播放头 | `vid.clock`（engine） | 订阅直改 DOM：红线 + 三角 + 读数。**线永远画**（不像 Keyframes 那样出了段就消失 —— 那是"段局部时间域"的设计，MIDI 窗的时间域是整条时间线） |
| 定位 | `vid.seek` | 点/拖标尺、点音符 = 同一颗合流 seek |
| 水平滚动 | 窗自己的 `scrollLeft` | 视口，不是时间源；播放时自动跟随（与 Tracks 同一条规则） |

> 与 Tracks 的关系：**同一个数、同一颗缩放、不同的滚动视口**。Tracks 与 MIDI 窗并排时，只要两边滚到同一段，两条红线就在同一个 x 上；滚开了也不过是同一时刻的两个视口。
>
> 备选（记下来，见 §10 决策 2）：像 `VidKeyframes` 那样本窗自带 zoom（`localStorage` 一个键）。更像 DAW，但会引入"每秒多少像素"的第二份标准 —— 与 I5 冲突，故不作为推荐。

### 5.4 编辑对象与空态

| 顺序 | 规则 |
| --- | --- |
| 1 | Tracks 里**恰好选中一枚 MIDI 段** → 编它（多选 = 只认第一枚，并在标题行写明） |
| 2 | 没有选中 → 播放头底下、**最上面那条** MIDI 轨上的段 |
| 3 | 都没有 → 空网格 + 一句"Select a MIDI clip in Tracks, or click a MIDI track's ＋" |

选中态用现成的跨窗 store（`workbench/video/selection.ts`），与 Keyframes / Video Generator 读的是同一份 —— 不新增"当前 MIDI 段"这种第二套状态。

### 5.5 编辑手势（V1 定稿）

| 手势 | 结果 |
| --- | --- |
| 空白处按下并拖 | 画一枚音符：起点吸附到 `grid`，长度 = 拖多远（最短 1 格） |
| 点音符 | 选中（Shift 加选；空白拖 = 框选） |
| 拖音符身体 | 改 `s` 与 `p`（跨音高；Alt = 暂时关吸附，与 Tracks 同一口径） |
| 拖音符右缘 | 改 `d` |
| 音符内上下拖（或底部力度 lane） | 改 `v`（力度） |
| Delete / Backspace | 删选中音符（有焦点才接，别抢 Tracks 的热键） |
| Ctrl+C / Ctrl+V | 窗内剪贴板；粘到**播放头**（与 Tracks 的 paste 同一口径） |
| 右键 | Quantize · Delete · Set velocity · Copy/Paste（沿用 Tracks 右键菜单的皮肤） |
| 点/拖标尺 | seek（与 Tracks 标尺同一个写口）。**网格里的空白 = 画音符，不是 seek** —— 定位一律在标尺上做，两者不抢手势 |

**写工程的时机（重要）**：拖动期间**只改窗内草稿 state**，松手时**一次** `vid.update(p => …, 'Move notes')`。

- 宿主是**全页一棵 React 树**（`EditPhase` 一个文件 5000+ 行，所有面板正文都在里面），每 move 一次 update = 整页重渲 + 一笔记历史；
- `pushVidHist` 已有"同 label + 650ms 合并"的机制，但合并救不了重渲；
- 所以：拖动 = 本地草稿（快），松手 = 一步（撤销干净）。轨道头/窗口上照旧显示"改了没存"的脏点。

### 5.6 发声：内置合成器 + 前瞻调度

`workbench/midi/synth.ts`：

- `MidiSynth` 单例，输出接 `VidAudio.bus(trackId)`（**与音频段共用同一条混音链**，见 §4.3）—— 电平表、独占槽、mute/solo 全部自动一致。
- 预设（V1 五个，纯 WebAudio，不引采样库）：`piano`（多正弦叠加 + 快攻慢衰）、`epiano`、`pluck`、`bass`、`pad`。预设 = 振荡器组合 + ADSR + 力度 → 音量/亮度映射。
- 调度：`cursor`（时间线秒）+ 100ms 前瞻，每 rAF 把 `[cursor, t + 0.1]` 里的音符排进 `AudioContext` 时间轴（`osc.start(ctxT)` / `stop(ctxT+hold)`）；`seek` / 回绕 / 暂停 / 换工程 = `allNotesOff()` + cursor 重置。
- **时间换算只走 engine 的锚**（时间线秒 ↔ ctx 秒），synth 不持有第二份时间 —— 这是 I1 在声音侧的落地。
- 同音高重触发要 steal（否则尾音叠成一片）；每轨同时发声数封顶（如 24）防雪崩。
- mute/solo：`audioAudible()` 同一份集合。
- 预听：点键盘 / 画音符时发 120ms 短音，**受 mute 约束、不受 solo 约束**（试听不该被别人 solo 掉）。
- 速度上限：MPE/CC/自动化 **不做**（V1）。

### 5.7 与既有轨段面的互操作

| 面 | 要做的事 |
| --- | --- |
| 轨头右键菜单 | 加一项 `Add MIDI Track`（现有三项的同一张菜单） |
| `addTrack` | MIDI 轨排到最下（与音频轨同侧；数组序 = 混音序，没有画面含义） |
| `KIND_UI` | 加 `midi`：紫色系（与视频蓝 / 音频绿 / Layer 琥珀 / process 中性分开） |
| `TRACK_H` | 加 `midi: 46` |
| 轨头 M / S | MIDI 归音频域：S 进 `soloAudioIds`；M 同 `muteIds` |
| `clipAt` / `clipAtSolo` / `compositePlanAt` | MIDI 段不参与画面 —— 它们本来就按 `kind` 过滤，只要确认"未指定 kind 的 `clipAt`"不会把 MIDI 段当成视频段（加一条 `kind === 'midi'` 跳过） |
| Tracks 里的 MIDI 段 | 紫色块 + 缩小版音符（上限 ~240 枚，超出按密度降采样）；长度/位置/裁剪照旧 |
| 拖放 | MIDI 轨不收素材（`.mid` 导入见 §9）；MIDI 段可在 MIDI 轨间拖 |
| 联动组 `groupId` | MIDI 段独立成组（不与音视频联动）；剪开仍各自成组（现成逻辑） |
| 波形/帧预览 | MIDI 段没有，走纯色块分支 |

### 5.8 持久化与 `normalizeVidProject`

- 音符内联 JSON：一枚 ≈ 60 字节；1 万枚 ≈ 600KB —— 可接受（`.cud` 里与图层像素同处一个文件，后者才是大头）。
- `normalizeVidProject` 增加：
  - `tracks` 里 `kind` 白名单加 `midi`（未知 kind → 丢掉这条轨及其段，或退回 `audio`？**丢掉**更诚实，避免"音符变成会响的音频段"）；
  - `clips` 里 `kind === 'midi'`：`notes` 逐枚校验（`p` 0…127 整数、`d > 0`、`s` 有限、`v` 0…1），坏行剪掉；`offset` 允许负；`srcDuration` 可缺；
  - `tempo` / `beatsPerBar` / `grid` 夹到合理区间（20…300 / 1…12 / 0.0625…4）；
  - `gain` / `pan` / `masterGain` 夹区间。
- 写口全部**纯函数 + 不可变**（新数组），并且 `copyVidClips` 里对 `notes` 做一次深拷贝 —— 否则"粘贴出来的两段共用一个数组"，将来谁一时手滑原地改，两段一起变。
- `.cud` 侧**不需要后端改动**：`ctx.video` 整份原样存取。

---

## 6. 模式门禁审计表（Audio 模式加进来以后，逐条改）

| # | 位置 | 今天 | Audio 模式应该是 | 改法 |
| --- | --- | --- | --- | --- |
| 1 | `EditPhase.measureFrame` | 非 video 一律量画布（条件是"模式不是 video **或** 画布该压上去"，而后者恰好就是"模式是 video"—— 两项互补，等于恒真） | **不量**（画布停在屏幕外，但保持挂载） | 加 `vidMode === 'audio' → null`，顺手把恒真表达式理顺 |
| 2 | `vidCanvasRef` | `vidMode === 'video'` | `false` | 语义改成"画布是否压在文档窗上" |
| 3 | `setLayerEditBlocked(...)` | `video && !vidLayerKey` | audio 下**恒挡住**（没有画布可编；`vidLayerKey` 还可能停在上一次 Video 的值上，不能拿它当条件） | `image: false`；`video: !vidLayerKey`；`audio: true` |
| 4 | `useEffect` 停播 | `vidMode !== 'video' → stop` | **只在 image 停**（video ↔ audio 互相切不停，引擎在宿主） | 改条件 |
| 5 | `runPreset` / `processor-run` 门 | `!== 'video'` 就走页面 | audio 同 image（走页面执行） | 保持，只补注释 |
| 6 | `stageCovers` | `!!frameRect && vidMode === 'video'` | `false` | 保持（frameRect 在 audio 下为 null） |
| 7 | 文档窗 `heads` 的 `RunStatusSeg` | 与模式无关 | 不变 | — |
| 8 | `docBodies` | 画布 / Player | 加 Console 一支 | 三分支 |
| 9 | `.cud` 的 `mode` | 两值 | 三值 | §4.1 |
| 10 | `vidDirty` / 自动落盘 / 撤销摞 | 与模式无关 | 不变 | — |
| 11 | Player 的"卸载还槽" | 卸载即 `releaseAudioSlot('player')` | 槽归 engine | §3.1 |
| 12 | Inspector 独立播放头 | 试听例外 | **不变** | 只在 tooltip/文档里保持说明 |

---

## 7. 分阶段实施（每阶段独立可验收、可回滚）

| 阶段 | 内容 | 规模 | 退出条件 |
| --- | --- | --- | --- |
| **P0** 引擎抽离 | `engine.ts`（按 §11.1 切成 `Transport` / `Sources` / `Mixer` 三件套 + 编排者）；`VidController` 换成只读 `clock`；Player 删循环只留画面同步；槽迁到 engine；调度不依赖 rAF（Worklet/定时器）+ 输出延迟补偿 | 新 2 + 改 3 | §3.3 行为等价清单逐条过；`tsc` 过 |
| **P1** Audio 模式 | 三态模式；**按模式分树**（§12.4）；`TransportBar` 抽出；`Console.tsx`；`VidAudio` 轨 bus / gain / pan / 表 | 新 2 + 改 5 | 切到 Audio 能播、能推子、能 M/S、能看表；切到 image 停播；三套工作区各自记位 |
| **P2** MIDI 轨与段 | `kind: 'midi'`；`notes`（**存拍**）+ `clip.tempo`/拍号 + `musicalTime.ts`；`addTrack` / `KIND_UI` / `TRACK_H` / 片段渲染 / `normalize`；"Add MIDI Track" 与 "Add MIDI clip" | 改 3 + 新 1 | Tracks 里能建 MIDI 轨/段、能拖能裁能剪、存档来回一致 |
| **P3** MIDI 窗编辑器 | `workbench/midi/MidiRoll.tsx` + 窗口注册全套；共享 `pps`；选中规则；草稿编辑；撤销合并 | 新 2 + 改 2 | 五条手势全通；一次拖动 = 一步撤销；播放头与 Tracks 同源（探针可证） |
| **P4** MIDI 发声 | `synth.ts`；engine 前瞻调度；mute/solo；预听；预设切换 | 新 1 + 改 2 | 播放听到音符、seek/回绕不乱、M/S 生效、电平表动 |
| **P5** 打磨 | 空态文案、快捷键、fitLayout 特例、性能（note 数量）、探针自检、文档 | 改 3 | 验收清单 + 探针结论 |

> 顺序理由：**先听得到，再编得动**。MIDI 若不先有 Audio 模式的音量/声像/表，合成器一上来就是 0dB 硬怼，用户第一件事就是找音量 —— 那会逼着在错误的阶段补混音。

---

## 8. 验收方案

**构建**：`cd ui && npm run build -w sampler_node`（含 `tsc`）。
新增 `VidTrackKind` 成员会把所有 `Record<VidTrackKind, …>` 和 `tr.kind === …` 分支的欠账**当场列出来** —— 这份编译器清单就是 P2 的施工图（`KIND_UI` / `TRACK_H` / `addTrack` / `clipAt` / solo 分支 / `Clip` 渲染 / 拖放闸）。

**手测清单（逐条打勾，不合并"大概能用"）**：

1. Video 模式 P0 回归：播放/暂停/停止、I/O 回绕、片尾停、scrub、换段、声音、Audio Monitor、Inspector 抢占。
2. 模式三分段：Image ↔ Video ↔ Audio 来回切，不停播/该停停；`.cud` 存哪份模式、重开落回哪份。
3. Audio 模式：推子/声像/M/S 即时生效；主表与 Audio Monitor 一致；切走再切回表恢复。
4. MIDI 窗：选中跟随、空态、点标尺 seek、播放时红线跟随、拖音符一步撤销、裁剪/剪开不丢音符、存盘重开一致。
5. 一致性（用户的核心诉求）：Tracks 与 MIDI 窗并排、两边滚到同一段，暂停时两条红线在**同一 x**；在任一处 seek 后另一处立刻跟上；探针断言两处读到的 `t` 相等。
6. 存档兼容：老 `.cud`（无 midi/tempo/gain 字段）打开正常；老 dock 布局升级后 MIDI 窗可见。

**探针**（`docs/ui-probe.md` 那条通道）：`__uiProbe.eval` 读 `document.querySelector('[data-vid-ph]')` 的 transform 与 MIDI 窗的 `[data-midi-ph]` 的 transform，换算成秒，断言两处相等 —— 这是"单一播放头"唯一可自动化的证据。

**不吹的部分**：不做人耳音质验收、不做"导出可用"的结论（导出根本不在本方案里）。

---

## 9. 非目标 / 后续

- `.mid` 导入 / 导出（V1 只做窗内编辑；导入需要 SMF 解析 + 速度/拍号映射）。
- 歌曲速度变化、时间伸缩、弹性音频（音频段不会被 tempo 拖动）。
- 采样音源 / SoundFont / VST3（参考项目走原生引擎 + 插件；这里是浏览器 WebAudio）。
- 音频波形编辑（增益/淡入淡出/去噪/切片）、节拍器、自动化（CC / 音量曲线）。
- **Audio 生成段**（把 ACE-Step 这类音频管线接成"像 Video Generator 那样在时间线上占一段、跑完吐一段音频"）—— 这才是 Audio 模式真正的下一层，但属于另一份方案。
- 多文档同时播放（一份文档一个引擎实例，切文档即停）。

---

## 10. 需要你拍板的三件事（第 3 项已按"Wwise 是目标"定稿）

> 已定：**Wwise 是目标** → 决策 3 选"存拍 + 段自带 tempo"（§11.2 W1），另按 §11 的三条缝（W2 事件队列 / W3 Worklet 时钟 + 输出延迟 / W4 参数表 + `project.audio`）在 P0–P2 一并落下；布局按模式分树（§12.4）。

| # | 问题 | 推荐 | 备选 |
| --- | --- | --- | --- |
| 1 | Audio 模式的文档窗正文放什么？ | **调音台（Console）**：走带 + 每轨推子/声像/表 + 主表 | 波形编辑器（裁音频/增益/淡化）／整页钢琴卷帘 |
| 2 | MIDI 窗的水平缩放？ | **共用 `vid.pps`**（一套刻度、一颗缩放） | 像 Keyframes 那样本窗自带 zoom（更 DAW，但多一套标准） |
| 3 | MIDI 音符的时间单位？ | **存"拍" + 段自带 tempo/拍号**（Wwise 是目标，按 §11.2 W1 定稿） | 源内秒（更省事，但与"按拍过渡"的交互音乐不兼容） |
| 4 | MIDI 的声音来源？ | **内置合成器 5 个预设**（纯 WebAudio，零资产） | 采样音源（要资产与后端）／Web MIDI 输出外部音源 |

拍板后按 §7 的 P0 → P1 → P2 → P3 → P4 顺序落地，每阶段一次构建 + 一次手测。

---

## 11. 前向兼容：如果以后要"像 Wwise"

> 用户提问：**"如果我之后需要它还能表现得和 Wwise 一般，需要额外考虑什么情况吗？"**
>
> 先拆词。"像 Wwise"不是"更强的播放器"，是六件东西：
>
> | # | 能力簇 | Wwise 里的名字 |
> | --- | --- | --- |
> | ① | 交互音乐：段 / 过渡 / 同步点 / Stinger | Interactive Music Hierarchy、Transition Matrix、Entry/Exit/Custom Cue |
> | ② | 参数驱动混音：状态快照、开关、实时参数曲线 | State、Switch、RTPC（含曲线 / LFO） |
> | ③ | 总线层级 + 插入效果 + 侧链 + 动态范围管理 | Master/Aux Bus、Effects、Ducking、HDR & Loudness |
> | ④ | 声部管理：上限、优先级、抢占、虚拟声部 | Playback Limit、Max Instances、Priority、Virtual Voices |
> | ⑤ | 空间化：发射器 / 听者 / 衰减 / 遮挡 / 房间 | 3D Spatialization、Attenuation、Occlusion、Rooms & Portals |
> | ⑥ | 打包与产能：bank、流式、profiler | SoundBank、Streaming/Prefetch、Profiler（Voice Inspector） |
>
> 本文的结论：**留形状，不追规模。** 下面每条都标了"现在做（便宜）/ 不做（很贵）"。

### 11.1 最大的分叉：固定时间线 vs 交互式状态机

Wwise 的音乐**不是**一条时间线，是"段 + 过渡矩阵 + 状态"。而这个工作台的骨架**就是**一条时间线（视频要它）。所以在本项目里"像 Wwise"不等于"换掉时间线"，而是：

- **一个时钟**（唯一播放头，§2 的不变量不动摇）；
- **多个"播放决策者"**：今天的编排、未来的交互音乐播放器、未来的 Audio 生成段 —— 各自决定"谁在何时出声"，但都写进**同一张混音图**、读**同一个时钟**。

这条直接决定了 P0 的 `VidEngine` 该怎么切 —— 不是一个大类，而是三件套 + 一个编排者：

| 段 | 职责 | 不该知道 |
| --- | --- | --- |
| `Transport` | 时间的唯一真相（播放中锚在**输出**时钟） | 谁在出声 |
| `Sources` | 谁在播：编排 / MIDI 调度 / 未来的状态机 / 生成段产物 | 总线怎么接 |
| `Mixer` | 总线图（轨 bus → 父 bus → master）、参数应用、声部预算 | 时间从哪来 |

多花不到一天，省掉以后拆类。**这是本文件里对 §3 唯一的修订。**

### 11.2 现在就该改的 4 条缝（晚改很贵）

| # | 缝 | 今天方案 | 为什么晚改贵 / 怎么改 |
| --- | --- | --- | --- |
| **W1** | **音乐时间：段自带 tempo/meter，音符存"拍"** | `project.tempo` 单值 + 音符存源内秒 | 交互音乐全部按"拍/小节"过渡（下一小节切、按拍 crossfade、entry/exit cue）。而 Wwise 自己的口径就是**段自带 tempo 与拍号、音符存拍**（不是拿一条全局 tempo map 把整曲变速）。现在存秒，将来要加拍对齐过渡，就得把每一枚音符连同裁剪/剪开/吸附的语义一起迁移。改成：音符 `s/d` 存**相对段的拍**，`project.tempo` 当默认、`clip.tempo?` 可覆盖，`duration` 仍存秒 = `拍数 × 60 / tempo`（改 tempo 只重算这一条，音乐长度不变）。全局变速（一条随时刻变化的 tempo map）**不是** Wwise 的形状，真要时另议 |
| **W2** | **调度器 = 事件队列 + epoch** | MIDI 专用前瞻循环 | 过渡、Stinger、`postEvent`、参数斜坡都是"未来某一刻的动作"，必须统一成 `{at, action}` 队列；lookahead 按用途给（音符 100ms、过渡一小节）。**flush 只能靠 epoch 作废** —— WebAudio 没有"撤销已排程事件"的 API，已经 `start(when)` 的源只能 `stop()` 或短淡出掐掉，所以事件必须带 generation，seek/回绕时整批作废 |
| **W3** | **时间权威 = 输出时钟；调度不依赖 rAF** | rAF 推进 + 100ms 前瞻 | 后台标签里 rAF 会被暂停/节流 → 前瞻窗口耗尽 → 断音。调度要走 **AudioWorklet 时钟**（参考项目就有 `transport-clock` worklet）或"定时器 + ctx 时钟"，rAF 只负责画面。播放头位置要用 `getOutputTimestamp()` 减掉输出延迟，否则画面领先声音 20–50ms；蓝牙可到 150ms+，还要留一个用户可调的 A/V 偏移 |
| **W4** | **参数表 + 工程级音频定义** | 推子/声像直接写在轨上；乐器是轨上的字符串 | States = 一组参数快照，RTPC = 参数曲线；两者都要求"**参数**"和"**UI 控件**"分开：UI 只写 `params.set('track:<id>:gain', v)`，图订阅参数、单一写者。另需 `project.audio = { version, instruments, buses }`，让乐器/总线/过渡能被跨段、跨文档**稳定引用**（今天的 `newVidId` 是随机 id，跨文档不可引用） |

### 11.3 结构上留接口（不实现，只把形状留出来）

| 接口 | 形状 | 将来接什么 |
| --- | --- | --- |
| `SoundSource` | `start(ctxT, offset, params)` / `stop(fadeMs)` / `tailMs` / `priority` | Random / Sequence / Blend 容器、流式声源、生成段产物 |
| `VoiceParams` | `{ gain, pan, pitch?, velocity, spatial?: {x,y,z} }` | RTPC 曲线、空间化（HRTF 是**每声部**的 panner，与"每轨一个 pan"不兼容 —— 所以 pan 必须能在 voice 层盖掉 bus 层） |
| `Bus` | `{ parent, input(稳定节点), inserts[], sends[], ducking[] }` | 层级总线、ducking（音乐被对白压）、效果插入、HDR/响度归一（`master` 只是 `parent: null` 的一条） |
| `VoiceBudget` | 每轨 / 全局上限 + steal 策略（最旧 / 最轻 / 同音高）+ 淡出 | 大工程不炸 CPU。Wwise 的**虚拟声部**（不可闻也推算包络）最难，建议**不做**，只做上限 + 抢占 + 淡出 |
| `engine.postEvent(type, payload)` | `stinger` / `state` / `switch` | 这个应用里"游戏"的替身：ComfyUI 跑完、切文档、图层参数越阈值 |

### 11.4 这个应用独有的 4 种情况（Wwise 文档里没有答案）

1. **两套时间栅格**：视频按帧（1/24、1/30），音频按 128 samples 块（48k 下 2.67ms）。"节拍对齐的剪辑点"只能就近取帧（30fps 下 ±16ms）—— 这是量化，要写清楚，不能当 bug 修。
2. **一份文档一个引擎、多文档并存**：Wwise 只有一条全局总线；我们有两三份 `.cud` 各带自己的混音。**同一时刻只允许一份出声**（`audioFocus` 已是这条规矩的雏形），切文档 = flush 旧图 + 换新图，两条 master 绝不能同时接 `destination`。
3. **浏览器生命周期**：后台标签、`AudioContext` 被挂起、`pagehide`、音频设备切换（蓝牙 ↔ 有线）。每一个都要有明确策略：继续播 / 暂停 / 重锚时钟。
4. **试听元素 vs 统一图**：Inspector 的试听是 `MediaElementSource`（`<video>` 元素），时间线是 WebAudio 图。Wwise 里一切都在图里 —— 想要 ducking / 统一响度 / 离线导出，试听迟早也要进图（但元素能流长文件，图不能，见 §11.5）。

### 11.5 现在不做，但要知道代价

| 能力 | 代价 / 约束 |
| --- | --- |
| **离线渲染 / 导出**（给视频配乐） | 要求 synth/mixer **不依赖 DOM 与 rAF**（OfflineAudioContext 里没有元素、没有 rAF），事件要能一次性全排或用 `suspend` 插队；tempo、随机种子、状态快照必须确定。P0 把 engine 做成 headless 就是在铺这条路 —— 但**绝不能用 `<audio>`/`<video>` 出声**，否则导出永远做不成 |
| **长音频流式** | 30 分钟立体声 48k float32 ≈ **690MB**，整段 decode 必爆内存。要流式就得后端支持 Range + AudioWorklet 分块喂（参考项目正是这么做的：native chunk PCM + worklet） |
| **真正的限幅器 / 响度归一（HDR、LUFS）** | 浏览器的 `DynamicsCompressor` **不是**限幅器（无前瞻、软拐点）。要 AudioWorklet 写 lookahead limiter + BS.1770 响度计量。参考项目已经踩到这一步（自带 `peakLimiter` 与"试听电平校准"），说明这不是洁癖 |
| **随机容器 / humanize 的确定性** | 任何随机都必须把**种子存进工程**，否则同一份 `.cud` 两次播放不一样、回归不稳、导出不可复现 |
| **Profiler 级诊断** | 至少要有"声部检查器"（谁在响 / 起于何时 / 增益 / 被谁抢 / 哪条 bus）+ 音频事件进 Log 窗。探针读得到 DOM，**读不到音频图** —— engine 必须主动暴露只读状态 |
| **SoundBank / 跨工程复用** | 想把"整套音乐行为"打包给别的 `.cud`，就得把音频定义从工程里拆出来单独成库 —— 那是另一个产品形态，先不做，但 W4 的 `project.audio` 是它的种子 |

### 11.6 因此 §7 / §10 要动的两处

- **§7 P0**：engine 按 §11.1 切成 `Transport` / `Sources` / `Mixer` 三件套（不是一个大类）。
- **§7 P2 + §10 决策 3**：若"Wwise 形状"是明确目标 → 音符**存拍 + 段自带 tempo**（W1），而不是源内秒。其余三条决策不变。
- 另外三项（W2 事件队列、W3 Worklet 时钟 + 输出延迟、W4 参数表 + `project.audio`）**成本几乎不变**，建议无论是否 Wwise 都照做 —— 它们是"以后能扩"与"以后只能重写"的分界。

---

## 12. 窗口预算：Wwise 形状下会有多少扇 dock window

> 用户提问：**"Wwise 是要做的目标，所以到时候需要有多少 dock window？"**
>
> 直答：**面板单元封顶 38–39 个（今天 33，净增 5–6 扇）；同时可见 5–8 扇；每开一份工程再加 1 扇文档窗。** 下面是把这笔账算清的过程。

### 12.1 今天有多少（先把数数准）

| 类别 | 数量 | 明细 |
| --- | --- | --- |
| 宿主 | 5 | `toolbar` `context` `pipeline` `presets` `blocks` |
| 工作台搬到宿主的面板 | 20 | `staging` `canvas` `transform` `color` `brush` `bucket` `eraser` `selection` `view` `text` `geometry` `scene3d` `pose` `detector` `processor` `videoGen` `guidances` `layers` `history` `layout` |
| 视频/音频文档窗 | 5 | `vtracks` `vassets` `vinspector` `vkf` `vaudio` |
| 工具窗 | 3 | `log` `debug` `probe` |
| **合计面板单元** | **33** | `PANEL_IDS` |
| 文档窗 | N | 每份打开着的 `.cud` 一扇（`doc:<uid>`），独立于面板集合 |

### 12.2 三条计数原则（决定"要不要再多一扇"）

1. **一扇窗 = 一个"你会伸手去动"的表面**。只读的、配置的、一次性动作的（打包、导出、SoundBank 生成）→ 做成 tab / 弹窗 / 工具条入口，不占窗。
2. **模式带窗，不代表带新窗**。新模式优先用"现有窗的一个 tab"或"文档窗正文的第三种活法"（Audio Console 就是这样，**它不是一扇窗**）。
3. **每加一扇都有固定维护税**：`PANEL_IDS`、`UNIT_TITLES`、`dockRulesFor` 里的 `fullBleed`/`grows`/`right`/`blockSize`、`workbench/icons.tsx`、`bodies` —— **8 处登记、2 个文件 + 1 枚图标**，还要给老布局一条 `fitLayout` 迁移。这是本仓库"少一扇窗省一圈空白"那条老账的另一面。

### 12.3 目标清单（Wwise 形状下，按模式）

| 窗 | Image | Video | Audio | 为什么必须是窗，而不是别人的 tab |
| --- | --- | --- | --- | --- |
| `canvas` 及工作台那 20 格 | ● | ○ | ○ | 图像合成的本体（现状不动） |
| `context` `pipeline` `presets` `blocks` `toolbar` | ● | ● | ● | 宿主五格，三模式常驻（现状不动） |
| `vtracks` / `vassets` / `vinspector` | ● | ● | ● | 文档属性，与模式无关（现状的一条好规矩） |
| `vkf` 关键帧 | ○ | ● | — | 图层动画，Audio 模式下没有对象 |
| **`vmidi`**（本方案） | — | ○ | ● | 钢琴卷帘要**高**，且要能跟 Tracks 并排看同一根播放头 |
| **`vmixer`**（可选提升） | — | ○ | ● | 与 Audio Console **同一个组件、两个宿主**：Console 是文档窗正文，`vmixer` 是能浮出来的那扇（边看画面边混音）。不做也行，做了就多一扇 |
| **`vmusic`** 交互音乐 | — | — | ● | 状态/过渡矩阵/Stinger 是一张**表**，塞不进别的窗 |
| **`vparams`** 参数与事件 | — | — | ● | States / Switches / RTPC 曲线 / event 表 —— 三个 tab 合在一扇 |
| **`vsources`** 声源与乐器 | — | — | ● | 容器树（随机/序列/混合）+ 乐器编辑 |
| **`vspace`** 空间化（可缓做） | — | — | ○ | 衰减曲线/听者/遮挡；也可以先做 `vparams` 的第 4 个 tab |
| `vaudio` 电平表 | — | ● | ● | 建议**并入 `vmixer` 的 Voices tab**（统一图之后，"谁在响"就是混音器的一部分） |
| `log` `debug` `probe` | ● | ● | ● | 现状不动；音频事件进 `log`，声部检查器进 `vmixer` 的 Voices tab |

**结论：**

| 时点 | 面板单元 | 净增 | 同时可见（典型） | 文档窗 |
| --- | --- | --- | --- | --- |
| 今天 | **33** | — | 6–8 | N |
| 本方案 P3 完成 | **34** | +1（`vmidi`） | 6–8 | N |
| Wwise 形状目标 | **38–39** | +5～6（`vmidi` `vmusic` `vparams` `vsources` `vspace`，可选 `vmixer`；`vaudio` 并入 `vmixer`） | 5–8（按模式） | N |

**硬上限**：面板单元 **≤ 40**。到这个数就停手 —— 再加就不是"多一扇窗"，而是"这套 dock 该改成分页工作区"了。参考 Wwise 自己：它的编辑面也就十来块（Actor-Mixer/Interactive Music 层级、Property Editor、Event Editor、Soundcaster、Mixer、Effects、Attenuation、Music Segment、Profiler）。**十来块是上限，不是起点。**

### 12.4 但 38 个面板装不进一棵树：布局要按模式分

今天有一条刻意的规矩：**切模式不动树**（"切换只换 canvas 格正文，别的窗原地不动"）。两个模式、只差一格正文时这是对的；到了 38 个面板就不成立了 —— Image 要画布 + 图层列，Video 要播放器 + 轨道 + 关键帧，Audio 要混音器 + 钢琴卷帘 + 音乐表，一棵树同时满足三者只能是三套都挤在一起。

所以 Wwise 形状下要改这条：

- **每个模式一棵树**（store 键从 `sampler.drawDock` 变成 `sampler.drawDock.<mode>`），切换模式 = 切换**整页工作区**（DaVinci 的 Edit/Fusion/Color 页就是这套）；
- 文档窗 `doc:<uid>` 是三个模式共有的，**首次进入某模式时以当前树为底克隆**：把"不属于这个模式"的窗换成该模式的窗，尽量按同类位置对齐（`vtracks` 在三个模式里都留在下面，`vmidi` 落在 `vkf` 的位置），此后各记各的；
- 这样 §5.1 那条 `fitLayout` 特例的迁移压力也小得多：老用户升级时先落进 Image 树（原树不动），Video / Audio 树按默认生成 —— **不用硬把 6 扇新窗塞进一棵老树**。

这条要作为 §7 P1 的一部分拍板（它是本文件里对"切模式不动树"的唯一修订，理由与代价都写在这里）。

### 12.5 于是"到时候"的画面长这样

- **Image**：顶栏 + 左列（宿主五格） + 画布 + 右列（工作台面板）+ 底部一条（Staging）。
- **Video**：顶栏 + 播放器（文档窗） + 下 Tracks + 右 Assets/Inspector/Keyframes（tab 组） + 走带在播放器里。
- **Audio**：顶栏 + **混音器（文档窗）** + 下 Tracks + 右 **MIDI 钢琴卷帘** + `vmusic`/`vparams` 作 tab 并进右侧（或各自一块）+ 电平表并入混音器。
- 想要边看画面边调推子：把 `vmixer` 浮出来（浮窗本来就压在整页之上）。

一屏 5–8 扇，三套工作区各司其职 —— 这就是"Wwise 形状"在本项目里合理的窗口规模。

---

## 13. Unity 集成：这套东西的第二个运行时

> 用户：**"我到时候是要做 Unity 集成的，你还需要仔细考虑清楚。"**
>
> 这一句把项目从"一个工作台"变成"**一个授权工具 + 一个运行时 SDK**"，也就是 Wwise/FMOD 的产品形状。下面是把坑逐个想清楚的结果；凡与本文件前面冲突的地方，以本节为准。

### 13.1 先把"Unity 集成"拆开（三种，先选一种）

| 种 | 含义 | 与 Wwise 目标的关系 |
| --- | --- | --- |
| **A. 授权 → 运行** | 这里做内容和行为，**导出 bank**，Unity 侧用我们自己的运行时 SDK 播放、由游戏事件驱动 | ✅ 我们要的就是这个 |
| B. 线性时间线播发 | 把整条时间线导成一条长音轨，Unity 里到点播 | 简单，但没有交互性，等于放弃了 Wwise 目标 |
| C. 工作台嵌进 Unity | 用 WebView 把这一页塞进游戏/编辑器 | 只解决"在哪编辑"，不解决运行时 |

**本文按 A 走。** 若你其实只想要 B，那 §13 的绝大部分代价都可以省掉 —— 这是第一个需要你确认的点（§13.10）。

> **（2026-10-28 修订）** A 的**路线**没变，变的是"运行时用什么写"：**不再是 Unity 里的 C#，而是一个外置的 Rust 引擎包体**（dll / wasm / staticlib 三种产物，Unity 只是宿主之一）。
> 因此本节的 **§13.3（两个适配器）** 与 **§13.9（阶段表）** 已被 `audio_engine_package.md` 取代 —— 那里 §5.2 给出"原生音频插件占一条总线"接法、§5.3 给出"程序化 AudioClip 拉取"接法。
> 本节的 **§13.1 / §13.2 / §13.4 / §13.5** 继续有效，尤其是"MIDI 只烘不跑"与"bank 是分发物"这两条。

### 13.2 铁律一：**MIDI 不进 Unity**，进 Unity 的是"烘好的音频 + 一份行为数据"

Unity 侧不能跑我们的 WebAudio 合成器（那等于要维护两套合成器 = 两份音色 + 两份 bug）。所以：

```
MIDI 段（音符/拍/tempo） ──离线渲染（确定性）──▶ 音频资产（hash 入库）──▶ 段/媒体
                                                    │
Unity ◀── bank（audio.json + media + 清单）◀─────────┘
```

- **合成器只是授权工具**：编辑器里点键盘、拖音符时用 live synth 试听；**正式预览与导出都用烘好的媒体**。
- 这条和仓库里 **Video Generator 的"占位段 → 产物段"** 是同一个形状（`pending` → 输出轨产物），可以直接复用那套状态与 UI 语言：MIDI 段烘一次 → 旁边落一段音频产物 → 标"已烘/已过期"。
- 好处是**预览 = 游戏**：Unity 播的是同一份字节，音色差异从根上消失。
- 代价：一遍编辑后要重烘（导出时自动烘 + 过期标记即可）。

### 13.3 ~~铁律二~~（已取代）：**一个决策层，两个适配器**

> **（2026-10-28 取代）** 这条铁律的前提是"运行时要写两份（TS + C#）"。既然运行时改成了**单一 Rust 内核**，就不需要用黄金轨迹去证明两份实现相同 —— 它们从构造上就是同一份源码。
> 定稿：**`audio_engine_package.md` §0 / §3**。唯一保留下来的精神是"`core` 不许碰平台 API"，它在那份文档里变成了 `core` / `dsp` 两个 crate 都 `#![no_std]`。

"预览和游戏听起来不一样"是这类产品的头号投诉，根因永远是**两套实现各自演化**。所以把运行时拆成：

```
core（纯函数，可移植）:  plan(blockStart, blockLen, state, params, events) → [{ at, action, args }]
   ├─ 浏览器适配器：action → WebAudio（osc/buffer start、gain ramp、panner）
   └─ Unity 适配器：action → AudioSource.PlayScheduled / AudioMixer.SetFloat / 自写 DSP
```

- `core` **不许碰 DOM / WebAudio / Unity**；只吃数字，吐事件表。这样它能在 Node 里跑、能被两边的测试用同一份 fixture 驱动。
- **一致性测试的形式**：同一份 bank + 同一段事件脚本（`PostEvent` / `SetState` / `SetRTPC` / `Seek`）→ 两边各吐一份**黄金事件轨迹**（谁、何时、多响、走哪条 bus）→ 逐行 diff。这是"预览 = 游戏"唯一可自动化的证据。
- 顺带一个好处：**播放头是授权工具的概念，不是运行时的概念**。运行时只有 `dspTime` 与"当前段内位置 + 已排的过渡"，没有"时间线游标"。所以用户在意的"只有一根播放头"在本项目里天然成立：越界到 Unity 那边的只有时间轴数值，没有第二个 UI 时钟。

### 13.4 交付物：**bank**（一份能独立进 Unity 的东西）

| 组成 | 内容 |
| --- | --- |
| `audio.json`（**带 `schemaVersion`**） | buses（父子 + 效果调色板参数）、segments（段：tempo/拍号/entry/exit cue/循环长）、clips（引 media + 偏移）、events、states、switches、RTPC 曲线、transitions（矩阵）、spatial（衰减曲线）、routing（send/ducking） |
| `media/` | **48 kHz** 定档；**循环/段落必须 PCM WAV**（压缩格式的编码 padding 与解码器 priming 会让循环点露缝）；长一次性音效可 Vorbis |
| `manifest` | 每件 media 的 hash（复用现有 hash 资产仓库）、时长、采样率、声道数、**preload / stream 标志**、每个 bank 单元的引用计数范围 |
| `ids` | **稳定字符串 id + 可寻址名字**（`Music_Intensity`、`Intensity`/`High`）；随机 id 只用在纯 UI 实体上 |
| 代码生成 | 由 schema 生成 C# 常量（`Kolid.Audio.Events.Music_Intensity = "Music_Intensity"`）—— 手写字符串迟早拼错 |

与 `.cud` 的关系：音频数据放进 `.cud` 的 **`ctx.audio`**（不是 `ctx.video`），导出是**单向**的 —— `.cud` 是作品档，bank 是运行时分发物。

### 13.5 Unity 侧契约（API 面，形状先定死）

```csharp
using Kolid.Audio;

AudioEngine.LoadBank("music");                      // Addressables / StreamingAssets
AudioEngine.PostEvent("Music_Intensity", emitter);  // emitter 可空 = 全局
AudioEngine.SetState("Intensity", "High");
AudioEngine.SetSwitch("Surface", "Wood", emitter);
AudioEngine.SetRTPC("Speed", 12.5f);
AudioEngine.StopAll(fadeMs: 250);
AudioEngine.SeekOnEvent("Music_Intensity", 12.0);   // 回到某段某点
AudioEngine.OnEndOfEvent += e => { ... };           // 回调
```

V1 只支持**全局** states/switches/RTPC，但**签名先带 `emitter`** —— 后面加 per-emitter 覆盖时不用改 API，只改实现（Wwise 也是这么长出来的）。

### 13.6 Unity 的现实约束（每一条都会反咬设计）

| 约束 | 后果 | 对策 |
| --- | --- | --- |
| `AudioSource` 只有 `PlayScheduled` / `SetScheduledEndTime`，**没有采样级的音量自动化** | **采样级 crossfade 做不到**，`AudioSource.volume` 与 `AudioMixer.SetFloat` 都是帧级（60fps ≈ ±16ms） | 要么接受帧级过渡，要么自写 DSP（`OnAudioFilterRead` 小混音器 / native 插件）。这是全篇最贵的一条，见 §13.10 问题 2 |
| `AudioSource.loop` 只能整段循环，**没有 loop 区间** | 小节循环/段内循环做不了"一段播完接下一段"的精确缝 | **双缓冲预排**：两枚 source 交替，下一段按 `dspTime + n 小节` 提前 `PlayScheduled` —— 与浏览器侧"前瞻调度 + epoch"同一套思路 |
| Unity **没有运行时时间伸缩**（`pitch` 改速度不保音高） | 任何变速必须离线做 | 变速只发生在授权期（烘），运行时永不 time-stretch |
| `AudioMixer` = 总线、snapshot = State、exposed parameter = RTPC、ducking 有 | 好消息：混音/状态大半能落到 Unity 原生 | 但**效果只有它给的那一套**（EQ/压缩/混响/延迟/限幅/duck）→ 我们的效果调色板必须与它取交集，**不允许"浏览器里能挂任意节点图"** |
| `OnAudioFilterRead` 在音频线程、不能碰 Unity API、不能分配 | 自写 DSP 必须零分配 + 命令队列 | core 的 `plan()` 在主线程算好、投进无锁环形队列，音频线程只消费数字 |
| 采样率固定 48k；设备若是 44.1 会被重采样 | 两端重采样曲线不同 → 相位/时长有微差 | 包内定档 48k；一致性测试按**事件轨迹**比，不按采样比 |
| 平台差异：Android 延迟、iOS 音频会话、WebGL（IL2CPP→WASM，音频经 WebAudio 桥、单线程） | 调度前瞻要按平台调；WebGL 没有线程 | 前瞻时长与 buffer 作为**平台配置**进 bank/运行时，不写死 |
| Unity 有 pan/attenuation，**没有 rooms/portals**；HRTF 靠插件 | 空间模型不能按 Wwise 全量设计 | V1 只做 **emitter + listener + 衰减曲线 + spread**；房间/遮挡标记成"需要插件" |
| Addressables / AssetBundle 需要分单元加载卸载 | bank 要能拆 | manifest 里带 bank 单元与 preload/stream 标志（W4 的 `project.audio` 正好是它的种子） |

### 13.7 因此前面哪些设计要改（对照表）

| # | 原计划 | Unity 目标下改成 | 阶段 |
| --- | --- | --- | --- |
| 1 | MIDI 段直接由 synth 播 | **MIDI 段必须可烘成音频资产**，预览/导出吃烘好的媒体；synth 只做编辑试听 | P2 建模 / P4 烘焙 |
| 2 | 混音器 = 任意 WebAudio 图（本方案 §4.3） | **总线层级 + 固定效果调色板**（与 Unity 取交集），节点图不可延伸 | P1 定契约 |
| 3 | engine 三件套 | 再加一条边界：**`core/` 纯函数 + 两个适配器**，core 不许 import WebAudio | P0 |
| 4 | 参数直接写 GainNode | **参数表 + 稳定 id + 单一写者**（§11.2 W4）—— Unity 侧同一份参数表 | P1/P2 |
| 5 | `.cud` 即全部 | `.cud` 里 `ctx.audio`；**可导出 bank**（schema + media + manifest + codegen） | P5 |
| 6 | 无事件词汇 | `PostEvent/SetState/SetSwitch/SetRTPC` 成为**公开契约**，两边同名同义 | P4 |
| 7 | 空间化可选 | 空间模型按 Unity 的能力定（emitter/listener/曲线），HRTF 与遮挡标插件 | P6 |
| 8 | 无运行时保真度概念 | 预览加 **"Unity 保真度"开关**：参数更新量化到 DSP 块、淡变按帧粒度 → 耳朵先听到游戏的极限 | P5 |
| 9 | 窗口 38–39 | **+1 `vbank`**（bank 单元/平台压缩/流式标志/生成 C# 常量）；Soundcaster 折进 `vmusic` 的 Sandbox tab | P5 |

### 13.8 窗口预算修正

加 `vbank` 之后：**39–40 个面板单元，正好撞上 §12.3 的上限 40**。Unity 侧再没有第二扇窗 —— bank 生成、平台设置、codegen 全在 `vbank` 里；运行时（Unity）根本没有窗口这个概念。**这就是"Wwise 形状"在这套 dock 上能装下的全部。**

> **（2026-10-28 复核）** 运行时改成外置 Rust 引擎后，这个数**一个都不用加**：引擎仓库不带 UI，`vbank` 里加一个"目标平台"下拉就够了（`audio_engine_package.md` §8 的 P6b）。

### 13.9 分阶段（Unity 是 P6+，但缝要在 P0–P4 就留）

| 阶段 | 授权侧 | Unity 侧 |
| --- | --- | --- |
| P0 | core/ 纯化 + 适配器边界 + Worklet 时钟 | — |
| P1 | 参数表、bus 调色板、按模式分树 | — |
| P2 | MIDI 数据模型（拍 + 段 tempo）、稳定 id、可序列化 | — |
| P3 | 钢琴卷帘 | — |
| P4 | synth + **烘焙** + 事件词汇 | — |
| P5 | `vbank` + `audio.json` schema + manifest + codegen + Unity 保真度预览 | 只读 schema |
| **P6** | — | **C# 运行时**：bank 加载、事件、states/switches/RTPC、段与过渡（双缓冲预排）、bus 映射到 AudioMixer |
| **P7** | 黄金轨迹 fixture 生成器 | 一致性测试（dotnet 控制台 harness 跑同一份 fixture） |
| **P8** | — | 只在"必须采样级过渡"时才做：`OnAudioFilterRead` 小混音器或 native 插件 |

### 13.10 诚实的代价 + 三个必须你拍板的问题

**代价**：这是在同一个产品里维护**两个工具链（TypeScript / C#）+ 两个运行时 + 一份 schema + 一套一致性测试**。逐条算，接近"再造一个小 Wwise"。所以范围必须自己砍：

> 建议的 V1 子集：**事件 / States+Switches+RTPC / 段与小节对齐过渡 / 总线 + 固定效果调色板 / preload+stream / emitter 空间化**。
> 明确不做：rooms & portals、HDR 与响度归一、虚拟声部、自研 native DSP（除非问题 2 的答案是"必须"）、Soundcaster 之外的自动化曲线编辑。

1. **是 A（授权 → bank → Unity 运行时）吗？** 还是只想要 B（导一条长音轨给 Unity 播）？—— 这决定 §13 的 80% 代价要不要付。
2. **采样级过渡是硬要求吗？** 是 → 迟早要自写 DSP（`OnAudioFilterRead` 或 native 插件）；否 → 先用 Unity 原生 `AudioSource`/`AudioMixer`，接受 ±1 帧的过渡精度，把自研 DSP 推到 P8。
3. **目标平台里有 WebGL 吗？** 有 → 单线程、音频走 WebAudio 桥、延迟预算要另算，调度策略得按平台分叉；没有 → 可以按原生平台（Windows/Android/iOS）优化前瞻与线程模型。

---

## 14. 三个答案定稿：A / 采样级是硬要求 / 无 WebGL

> 用户答复：**1. A（授权 → bank → Unity 运行时）　2. 采样级过渡是硬要求　3. 目标平台无 WebGL**
>
> 这三句把 §13 里所有"看情况"的岔口都关掉了。本节是**定稿版**，与 §13 冲突处以本节为准。
>
> **（2026-10-28 修订）** 用户追加了一条规格：**运行时 SDK 是外置的 Rust 引擎包体**（独立仓库、dll/wasm/staticlib），Unity 只写绑定。
> 因此本节的 **§14.2 / §14.4 / §14.6** 已被 `audio_engine_package.md` 取代（§14.2 的"per-emitter 混音节点"变成 Rust 里的 per-voice 声部；§14.4 的"先双实现、必要时再上共享内核"直接作废，因为共享内核从第一天就是地基；§14.6 的阶段表见那份文档 §8）。
> **继续有效**：§14.1（A 的路 / 采样级硬要求 / 无 WebGL 三条都没变）、**§14.3（整数样本 @48k、浏览器强制 48k）**、§14.5、§14.7。

### 14.1 三句话各自锁死了什么

| 答复 | 锁死的东西 | 后果 |
| --- | --- | --- |
| **A** 授权 → bank → 运行时 | 交付物是**两件**：授权工具（本仓库）+ 运行时 SDK（Unity C#）；`.cud` 只是作品档 | 现在的 dock/窗口/编辑器全部只服务授权侧；运行时不带窗口、不带编辑器 |
| **采样级过渡是硬要求** | 运行时**必须自持采样级增益**，不能靠 `AudioSource.volume` / `AudioMixer.SetFloat`（帧级） | Unity 侧要一个**逐样本的混音节点**（§14.2）；浏览器侧本来就能做到（WebAudio 自动化是采样级）；时间在 core 里用**整数样本**表达（§14.3） |
| **无 WebGL** | 可以用线程、Job System、Burst、原生插件；不必考虑单线程 WASM | 插件/原生路线保留在桌面上可行；同时**不需要**为"浏览器里的 Unity"做任何妥协 |

### 14.2 ~~Unity 运行时的形状~~（已取代）：**每 emitter 一个逐样本混音节点**

> **（2026-10-28 取代）** DSP 现在写在 Rust 里，Unity 不再自己写 `OnAudioFilterRead`。下面这张"谁负责什么"的分层表作废替换为：`audio_engine_package.md` §5.2（接法 A：原生插件占总线，整条混音归我们）与 §5.3（接法 B：程序化 AudioClip 拉取，Unity 保留空间化）。**V1 建议用 B，之后再切 A —— 只换绑定，`core`/`dsp` 一行不动。**
> 下面表里的三条仍然值得读：**每 emitter 上限要写进约束**、**burden 参与 crossfade 的媒体必须预载在内存**（这条变成了 `.kpc` 容器与那个 69MB/3min 的预算）、以及"用例 abort ⟶ 流式算法不能出现在被 crossfade 的那份里"。

不追求"整台引擎替换 Unity 音频"（那是 Wwise 的规模），而是把**发声与包络**收进我们自己的 DSP，其余交给 Unity 原生：

| 层 | 谁负责 | 精度 |
| --- | --- | --- |
| 声部起停、音量包络、crossfade、循环点回绕 | **我们**：每个 emitter 一个 GameObject，`AudioSource` 播静音，`OnAudioFilterRead` 填 buffer | **逐样本** |
| 段/过渡的决策（下一小节、entry/exit cue、Stinger） | **我们**：主线程 `plan()` → 无锁命令队列 → 音频线程消费 | 采样点由"拍 → 样本"整数化 |
| 总线、发送、效果、ducking、snapshot | **Unity `AudioMixer`**（我们只 `SetFloat` / `TransitionToSnapshots`） | 帧级（可接受：混音参数不是过渡） |
| 空间化 | **Unity**：每个 emitter 一个 `AudioSource.spatialBlend` / spatializer 插件 | 每 emitter |
| 流式 / preload / 卸载 | **Unity**：`AudioClip.LoadAudioData` + Addressables | — |
| 母带 / 限幅 | Unity mixer 效果（或换插件） | — |

要点：

- **为什么是 per-emitter 而不是全自研引擎**：`OnAudioFilterRead` 是**拉模式、音频线程、不能碰 Unity API**，正好放"逐样本合成 + 包络"；而总线/效果/空间化用 Unity 原生就够，且能与调色板取交集。真做全引擎＝Wwise 的规模，不是这个项目的合理范围。
- **经典坑（必须写进实现）**：Unity **不告诉你"这一块 buffer 的准确 `dspTime`"**。要自己维护**样本计数器**：首次回调锚一次 `AudioSettings.dspTime`，之后按样本累加；**空闲时重锚**（没有声部在响的那一帧），避免长期漂移。
- **坑二**：空间化与 `OnAudioFilterRead` 的声道数相关。用**单声道静音 clip**、filter 写单声道，交给 Unity 的 spatializer；音乐 emitter 用 `spatialBlend = 0`。
- **坑三**：`OnAudioFilterRead` 数量 = emitter 数量，几十个没问题，几百个就该合并成单一 mixer root —— bank 里 emitter 的上限（如 64）要作为约束。
- **坑四**：自己拉样本 ⇒ **被混音的 PCM 必须在内存里**，不能用 `AudioClip.LoadAudioData` 的流式解码（那是一问一要的，音频线程不能等 I/O）。所以 bank 的 `stream` 标志只对"交给 Unity `AudioSource` 播的一次性音效"有效；**音乐段（要被 crossfade 的那批）必须 preload**。3 分钟立体声 48k float ≈ 69MB、16bit ≈ 34MB —— 内存预算要按这个算，必要时按段懒加载 + 预取。**这是自研混音节点最容易被忽略的一条。**

### 14.3 "采样级过渡"落到实现上的四件事

1. **时间单位改成整数样本**：core 内部时间 = `samples @ 48000`（int64）。拍 → 样本的换算在**加载 bank 时做一次**（`samplesPerBeat = 48000 × 60 / bpm`，取整规则写死：round-half-up）。这样两端不可能因为浮点累加差出样本。
2. **过渡描述进 bank**：`{ sync: 'immediate'|'entry'|'exit'|'bar'|'beat'|'cue', quantize: 1/4, fade: { lenSamples, curve: 'linear'|'equalPower' } }`。授权侧编辑的就是这套；两端跑同一份。
3. **Unity 侧逐样本包络**：在 `OnAudioFilterRead` 里按样本累加增益（不是每帧 set 一次），crossfade 用 equal-power；`PlayScheduled` 只用于"静音 source 的持续"。
4. **浏览器侧强制 48 kHz**：`new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })`，所有 `decodeAudioData` 由浏览器重采样到 48k —— 与 Unity 同档。现有 `VidAudio` 用的是 `new AudioContext()`（跟随设备），**这一行要改**。

### 14.4 ~~保真策略~~（已取代）：先"双实现 + 数值一致性"，必要时再上共享内核

> **（2026-10-28 取代）** 两份实现的时代结束了。现在的保真策略只有一条：**同一份 Rust 源码、同一套 `no_std` 约束、同一份 fixture，四个目标各自编出来跑，逐字节 diff = 0。** 具体的七条确定性规矩（D1–D7）在 `audio_engine_package.md` §4。

采样级是硬要求，但**不等于**现在就要 C++/Rust 内核。分两步：

| 阶段 | 做法 | 判定标准 |
| --- | --- | --- |
| 现在 | **DSP 内核规格化**：只有"增益（逐样本包络，linear / equal-power）· 声像定律（-3dB / -6dB 中心）· 线性淡变 · 简单二阶低通/高通"这几样由我们自己实现（浏览器 AudioWorklet / Unity C# 各一份） | 冲激响应、斜坡形状、panner 定律三组 fixture，两端在容差内一致 |
| 内核长大时 | 同一份规格 → **C++/Rust 双构建**（AudioWorklet 的 wasm + Unity 原生插件），内核代码只有一份 | 数值直接逐位相等；插件按平台打包 |

判据写清楚：**只要内核还只是"增益 + 声像 + 线性滤波"，双实现比引一套 C++ 工具链便宜**；一旦要卷积混响（IR）、压缩/限幅器、HRTF，就必须上共享内核 —— 那时也正好是用户听得出差异的地方。

### 14.5 对授权侧（P0–P5）的追加要求

| # | 追加要求 | 落在哪 |
| --- | --- | --- |
| 1 | **core 的 `plan()` 输出必须能表达"样本偏移"**（`{ atSample, action, voiceId, gains: Float32Array }` 这一级），不许只给"秒" | P0 |
| 2 | `VidAudio` 改 48 kHz 定档；所有时间常量按样本换算（`samplesToSec` 一处） | P1 |
| 3 | **参数表**（§11.2 W4）统一走"参数名 → 值 + 平滑时间常数"，两端同一套平滑语义（否则 RTPC 曲线在两端不同） | P1 |
| 4 | **小节/拍网格从段 tempo 出**（§11.2 W1），过渡描述用 §14.3 的 schema | P2 |
| 5 | **MIDI 可烘**（§13.2）：烘焙产物按**采样长度精确**（循环长度 = 整数样本，避免缝） | P4 |
| 6 | 预览加 **"Unity 保真度"开关**：把混音参数更新量化到 DSP 块、淡变按逐样本、关闭浏览器独有的节点 | P5 |
| 7 | `vbank` 里能看/改：emitter 上限、每件的 preload/stream、平台压缩、**"这段过渡需要多少样本"** | P5 |

### 14.6 ~~修订后的阶段表~~（已取代）

> **（2026-10-28 取代）** 阶段表以 `audio_engine_package.md` §8 为准：P6 拆成 P6a（预览换 wasm）+ P6b（Unity UPM 包），**P8 删除**。下面这张表留作历史记录 —— 尤其注意它里面那条"core 写 TypeScript"已经**明确禁止**（那条会造成双倍成本，见那份文档 §8 开头）。

| 阶段 | 授权侧 | Unity 侧 | 出口 |
| --- | --- | --- | --- |
| **P0** | `core/` 纯化（整数样本 + `plan()`）+ `Transport/Sources/Mixer` + Worklet 时钟 + 输出延迟补偿 | — | 视频/音频原有行为等价；core 有单测 |
| **P1** | Audio 模式（Console）、参数表、bus 调色板契约、按模式分树、48 kHz 定档 | — | 能播能混能看表；切模式行为正确 |
| **P2** | MIDI 轨/段（拍 + 段 tempo）、稳定 id、`ctx.audio`、normalize | — | Tracks 里能建/拖/裁/剪，存档一致 |
| **P3** | 钢琴卷帘（`vmidi`） | — | 手势全通；播放头同源（探针断言） |
| **P4** | synth（仅试听）+ **烘焙** + 事件词汇 | — | 烘一段 → 落一段音频产物 → 与 MIDI 段对齐 |
| **P5** | `vbank` + `audio.json` schema + manifest + C# codegen + Unity 保真度预览 | 只读 schema | bank 能被 schema 校验；codegen 出常量 |
| **P6** | — | **C# 运行时**：bank 加载、事件、states/switches/RTPC、per-emitter 逐样本混音、段与过渡、bus 映射 | 一份 bank 在 Unity 里跑出与预览一致的行为 |
| **P7** | 黄金轨迹 fixture | dotnet harness 跑同一份 fixture | 轨迹 diff 为零；DSP 三组数值 fixture 在容差内 |
| **P8** | — | 仅当内核长大：共享 C++/Rust 内核（wasm + 原生插件） | 数值逐位相等 |

### 14.7 由此不再讨论的三件事

- **不再考虑"帧级过渡"**：`AudioSource.volume` 那条退路作废，`OnAudioFilterRead` 是必选。
- **不再考虑 WebGL 目标**：调度可放心用线程/原生插件，前瞻可以按桌面/移动调。
- **不再考虑"Unity 里跑我们自己的合成器"**：MIDI 只烘不跑（§13.2 不变）。




