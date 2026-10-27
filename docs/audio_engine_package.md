# 外置音频引擎：单一 Rust 内核 + 三个宿主绑定

> 用户修订：**"Unity 相关的部分要重新思考。我要的是一个外置的声音引擎，像外置一个 dll 一样 —— 它要独立成一个包体（这样我可以共享给 Unity），我希望是 Rust 代码。"**
>
> 这一句推翻的是 `audio_midi_workbench_design.md` 的 §13.3 / §13.9 / §14.2 / §14.4 / §14.6：
> 原来那个"一个决策层、两个适配器（TypeScript 一份 + C# 一份，用黄金轨迹证明两边一致）"的模型作废。
> **本文是取代它的定稿**；凡与前文件冲突，以本文为准。

---

## 0. 一句话

**不再有两个运行时实现。只有一份 Rust 源码，编出三种产物；三个宿主各自写一层薄绑定（几百行），不写第二个实现。**

```
                 ┌──────────────────────────────────────────┐
                 │  kolid-audio（Rust）                      │
                 │  core：决策   dsp：逐样本渲染   capi：ABI  │
                 └──────────────────────────────────────────┘
        wasm32-unknown        x86_64-pc-windows-msvc     aarch64-linux-android     x86_64-unknown-linux-gnu
              │                        │                          │                          │
              ▼                        ▼                          ▼                          ▼
   浏览器预览（AudioWorklet）   Unity Editor / Windows 包     Unity Android 包        离线渲染 CLI（导出 / CI）
              │                        │                          │                          │
       JS 绑定（十余行）         C# 绑定（P/Invoke + 命令队列） 同上                    同一份 C ABI
```

授权工具（本仓库）与 Unity（别人的软件）**只是这台引擎的两个宿主**。`.cud` 仍然是作品档，bank 仍然是分发物 —— 这两条不变（沿用前文件的 §13.2、§13.4）。

---

## 1. 这次修订真正改变了什么

| # | 原来（前文件） | 现在 | 影响 |
| --- | --- | --- | --- |
| 1 | core 写 TypeScript，适配器写 TS + C# 两份 | **core + dsp 只有 Rust 一份** | 一致性不再靠"两份实现各自收敛"，而是**从构造上成立**；黄金轨迹测试降级为"验证绑定层没有扭曲参数与时间"（仍要做，但不是主力证据） |
| 2 | Unity 运行时是 C#，逐样本 DSP 写在 `OnAudioFilterRead` | **DSP 全在 dll 里**；C# 只剩约三百行绑定 + MonoBehaviour 生命周期 | Unity 升级不再牵动我们的 DSP；"换引擎 = 换 dll"成立 |
| 3 | 总线 / 效果交给 Unity `AudioMixer`（那是"与 Unity 取交集"的理由） | **可以不再交给它**：引擎自带一整套 bus / 插入效果 / 发送 / ducking / 母带 | 前文件 §14.2 那条"per-emitter 逐样本混音 + Unity 管总线"的分层作废；取舍见 §5.2 |
| 4 | P8 兜底选项："内核长大时再上共享 C++/Rust 内核" | **P8 消失** —— 共享内核从第一天就是地基，不是兜底 | 阶段表重画（§8） |
| 5 | 浏览器侧要在 TS 里写一份 core / plan | **不在 TS 里写第二份决策** | 见 §8 开头：这是这次最重要的一条施工顺序修订 |
| 6 | bank 里的 media 是 WAV / Vorbis，靠平台解码器 | 推荐引入**自有 PCM 容器**（`.kpc`） | 因为要预载进引擎自己的内存、要在音频线程零等待读取，见 §6 |

另外两件事**没有变**，别因为换了语言就动摇：

- **MIDI 不进运行时**（前文件 §13.2 铁律一）。Unity 那边拿到的仍然是烘好的 PCM。
- **时间是整数样本 @48 kHz**（前文件 §14.3）。这条从"我们自己小心保持一致"升级为"由 Rust core 的类型保证"。

**窗口预算不变**：仍是 39–40 个面板单元。运行时没有窗口，授权侧那六扇（`vmidi` `vmixer` `vmusic` `vparams` `vsources` `vbank`）一个不多一个不少。

---

## 2. 包体结构：一个独立仓库 `kolid-audio`

用户要的是"能共享给 Unity 的包体"，所以它是**独立仓库、独立版本、独立许可**，不塞进 `nodes/` 或 `ui/`。本仓库反过来消费它的产物。

```
kolid-audio/
├─ Cargo.toml                      workspace
├─ crates/
│  ├─ kolid-audio-core/            决策层。#![no_std] + alloc
│  │     bank 模型 / schema / 稳定 id / 拍↔样本折算（取整规则只有一处）
│  │     plan(block_start, block_len, state, params, events) -> EventBatch
│  │     声部预算与抢占、容器（Random / Sequence / Blend）选择（带种子）
│  │     ← 纯逻辑：不许 import 任何平台 API，不许读时钟
│  ├─ kolid-audio-dsp/             渲染层。#![no_std] + alloc
│  │     声部包络（逐样本 linear / equal-power）、交叉淡化、循环回绕
│  │     声像定律、滤波、发送、bus 链、ducking、母带软限幅
│  │     ← 只允许 §4 那几个浮点运算
│  ├─ kolid-audio-capi/            C ABI。cdylib / staticlib
│  │     所有 #[no_mangle] extern "C" 面 + 静态断言守护
│  │     feature: unity-plugin（导出 Unity 原生音频插件的定义表）
│  └─ kolid-audio-cli/             kolid-render：离线 bounce 与 CI 用
├─ bindings/
│  ├─ unity/                       UPM 包：Runtime / Editor / Plugins / package.json
│  └─ js/                          wasm 胶水 + AudioWorklet Processor
├─ tests/{fixtures,golden}/        事件轨迹 + DSP 数值两组黄金
└─ include/kolid_audio.h           唯一对外头文件（由 Rust 侧的静态断言守护）
```

为什么分成 `core` 与 `dsp` 两个 crate：`core` 能在 Node、浏览器主线程、离线 CLI 里跑并被单测包围（`plan()` 是纯函数）；`dsp` 是"只能在音频线程跑"的那一半。两者都 `no_std` —— 这是**同一份源码能同时成为桌面 dll 与 worklet wasm 的前提**。

与本仓库现有的 Python / TypeScript 关系：**无关**。引擎仓库不知道 ComfyUI 的存在。

---

## 3. C ABI：三个宿主唯一的握手处

三条铁律（它们决定这套东西能不能长期活下去）：

1. **跨边界只传原生标量与 POD 指针。** 不传 Rust 的 `Vec` / `String` / `Result`，不按值返回结构体（不同编译器的结构体传参 ABI 不一致）。所有复合对象一律 `Handle`（`u64`） + accessor 函数。
2. **音频线程零分配、零 syscall、零锁。** 渲染函数只有一个签名：`render(out: *mut f32, frames: u32)`。它在**宿主提供的音频线程**上被调用，由宿主保证不被抢占。主线程 push 命令 → 无锁 SPSC 环形队列 → 音频线程 pop。
3. **时钟由宿主给，引擎不读。** 引擎没有"现在几点"，只有 `audio_cursor: i64`（样本）。宿主每次回调告诉它这一块的起点样本号。这直接消灭了前文件 §14.2 那个坑（Unity 不告诉你这块 buffer 的准确 `dspTime`，要自己维护样本计数器并重锚）—— 不用猜，也不用重锚。

```c
/* include/kolid_audio.h —— 形状先定死，名字还可能改 */
typedef struct Kernel Kernel;

/* 生命周期（主线程） */
Kernel*    kolid_new(const KolidConfig* cfg);   /* sample_rate / max_frames / max_voices / channel_layout */
void       kolid_free(Kernel*);
uint32_t   kolid_abi_version(void);             /* 加载时必须与 binding 的编译期常量相等 */
int        kolid_load_bank(Kernel*, const uint8_t* bytes, size_t len, char* err, size_t err_cap);
BankHandle kolid_media_reserve(Kernel*, const char* id, uint64_t frames, uint32_t channels);
int        kolid_media_write(Kernel*, BankHandle, uint64_t at_frame, const float* src, uint32_t frames);

/* 命令（主线程，写进环形队列） */
int  kolid_post_event(Kernel*, const char* name, uint32_t emitter_id);
int  kolid_set_state (Kernel*, const char* group, const char* value);
int  kolid_set_switch(Kernel*, const char* group, const char* value, uint32_t emitter_id);
int  kolid_set_rtpc  (Kernel*, const char* name, float value);
int  kolid_seek      (Kernel*, int64_t to_sample, uint32_t epoch);
void kolid_flush     (Kernel*, uint32_t epoch);   /* epoch 作废所有已排程动作 */

/* 渲染（音频线程，唯一被实时调用的函数） */
void kolid_render(Kernel*, int64_t audio_cursor_sample, float* interleaved_out, uint32_t frames);

/* 只读快照（任何线程，拷出来） */
uint32_t kolid_read_voices(Kernel*, KolidVoiceSnapshot* out, uint32_t cap);  /* 给 Voices / Profiler tab */
int      kolid_last_error (Kernel*, char* out, size_t cap);
```

关于 `epoch`：WebAudio 与 Unity 都**没有"撤销已排程"**这回事（前文件 §11.2 的 W2），所有未来动作必须带 generation，seek / 切档时整批作废。把这个变量抬到 ABI 层，三个宿主就共用同一套语义，不可能分叉。

 Unity 原生插件那条路还多一条：把 Unity 的 `AudioPluginInterface.h` 用 `#[repr(C)]` 抄进 `capi`，然后在 CI 里对**每个我们宣称支持的 Unity LTS** 跑一次 `static_assert` 校验字段偏移与结构体大小，让版本漂移在构建时被抓住，而不是在别人耳朵里被抓住。

---

## 4. 确定性规则（比"能在客户端跑起来"重要得多）

目标是让**同一份源码在 x86_64-windows-msvc、aarch64-linux-android、wasm32-unknown-unknown 上产出逐样本一致的输出**。

| # | 规矩 | 为什么 |
| --- | --- | --- |
| D1 | DSP 路径只用 `+ - * / sqrt abs min max` | 这八个在现代实现里 IEEE 精确、跨平台逐位一致 |
| D2 | **禁用 `sin/cos/exp/pow/tanh` 等 libm 函数** | 不同 libm 的末位不一致。振荡器 / EQ 系数需要三角函数时，自己写多项式近似并写进 fixture |
| D3 | **禁用 `f32::mul_add`** | 它可能被折叠成 FMA 也可能不会，取决于目标；FMA 少一次舍入 = 数值漂移 |
| D4 | SIMD / `target_feature` **默认关闭**；要开就作为显式 feature，且放行容差跟着改 | 我们要的不是更快，是三端一样 |
| D5 | 时间一律 `i64` 样本；拍↔样本的取整（round-half-up）在 `core` 里只有一处 | 浮点累加是这类产品最常见的"两端差一帧"病根 |
| D6 | 任何随机都走 core 里那一个 PRNG，种子随 bank 走 | 否则同一份工程两次播放不一样、导出不可复现 |
| D7 | 参数平滑（每个样本走多少斜率）在 `dsp` 里只有一处实现 | RTPC 曲线在两端不同，是"听起来不太一样"最常见的来源 |

判据两级：**目标是逐样本位同**（有了 D1–D5 应当做得到），CI 跑"同一 fixture → 原生 harness 与 wasm harness 两份输出 → 逐字节 diff = 0"；某个目标确实做不到时（开了 SIMD、用了第三方 DSP），降级为峰值差 `< 1e-6`，并在 fixture 里写明允许降级的目标三元组。

---

## 5. 三个宿主怎么接

### 5.1 浏览器（预览）：AudioWorklet 里装 wasm

- `AudioContext({ sampleRate: 48000 })`（前文件 §14.3 不变），一个 `AudioWorkletProcessor`，它的 `process()` 就是上面那个 `kolid_render`。
- wasm 模块**在主线程编译好**，`addModule` 时通过 `processorOptions` 把 `WebAssembly.Module` 传进去（它可结构化克隆），worklet 侧 instantiate —— 少一次网络等待，也让"加载失败"成为启动时的一次性失败，而不是播放时的黑屏。
- **假设没有 SharedArrayBuffer**：ComfyUI 的 HTTP 服务没设 COOP/COEP，所以 wasm 里**不开线程**。这不影响正确性（命令本来就是 postMessage 进 worklet 的单写单读队列），受影响的是后台解码线程 —— 所以浏览器端的**流式不做**，长音乐仍然预载（预算见 §6）。
- 不用 `wasm-bindgen`：它拉进来的是 std 加一套 JS glue，我们要的只是那几个 `extern "C"` 导出和一个 `memory`。手写十余行 JS 就够，产物也可控。
- 落盘位置有个仓库里的硬规矩：`nodes/web/` 的静态路由**只服务 `fx` `js` `attr` 三个直属目录**（`snapshot_sampler_node.py` 里 `for sub in ('fx','js','attr')`）。所以 wasm 产物要放在 **`nodes/web/js/kolid_audio/`** 下；想新开目录就得改那一处并重启后端。

### 5.2 Unity 接法 A：原生音频插件占一条总线（**"外置 dll"的本义**，但放到 V1 之后）

把 Unity `AudioPluginInterface.h` 里的 `UnityAudioEffectDefinition` 抄进 `kolid-audio-capi`（feature `unity-plugin`），导出 `UnityGetAudioEffectDefinitions`。Unity 会在**音频线程**回调 `ProcessCallback(state, inbuffer, outbuffer, length, inchannels, outchannels)`，那里直接调 `kolid_render`：

- **引擎负责整条混音**：声部、bus、发送、ducking、空间化（V1 自己算距离衰减 + 声像定律）、母带软限幅；Unity 只管输出设备。
- **经典坑（必须写进实现）**：总线没有源流入时 Unity 可能不回调那个插件 —— 要常驻一枚**静音 source** 喂着它（`spatialBlend = 0`），否则引擎会"没声音时停机、有了声音起不来"。
- 版本漂移按 §3 末尾那条 `static_assert` 守。
- **代价：自己混音就意味着空间化也归我们**（Unity 的 spatializer 拿不到我们内部的声部）。V1 只做 emitter / listener + 距离衰减曲线 + spread + 声像；HRTF 仍标为"需要插件"（沿用前文件 §13.10 的非目标）。

### 5.3 Unity 接法 B：程序化 AudioClip 拉取（**V1 先用它**）

`AudioClip.Create(name, lengthSamples, channels, frequency, stream: true, PCMReaderCallback, PCMSetPositionCallback)` —— Unity 在音频线程向 C# 拉取，我们调 `kolid_render` 把它填满。

- 优点：**不依赖 Unity 原生插件当时的 ABI**，空间化还能继续用 Unity 的（`AudioSource.spatialBlend`），每 emitter 一枚 source（形状上就是前文件 §14.2，只是 DSP 换成了 Rust）。
- 代价：每 emitter 每块一次托管↔原生切换，所以 emitter 数量要有上限（先给 64，并写进 bank 约束）。

建议顺序：**V1 用 B 上线（风险最小、能马上听得见、空间化归属不变），A 在内核稳定后换上去**。换的只是那一层绑定，`core` / `dsp` 一行不动 —— 这正是这次修订的全部收益。

### 5.4 第三种宿主：离线渲染 CLI（免费副产品）

`kolid-render bank.json -o out.wav`（`kolid-audio-cli`）。它不是交付物，是为了前文件 §11.5 那条"离线导出"：

- 同一份内核、同一份 fixture，既能给视频配乐导出，也能跑 CI 一致性比对；
- 顺便把"浏览器里 OfflineAudioContext 能不能跑"这个未决问题关掉 —— 答案是：不用它，直接用 CLI。

---

## 6. 内存与 I/O 的口径

因为音频线程不能等待 I/O，**所有要参与 crossfade / 循环 / 采样的媒体必须常驻引擎自己的内存**：

- 引入自有容器 `.kpc`：`header(schema, sample_rate, channels, frames, loop_frames, hash) + 交错 f32`。不依赖平台解码器、不用等 `AudioClip.LoadAudioData`，也让将来别的宿主（Unreal 等）能直接吃同一份文件。
- 预算照前文件 §14.2 坑四那笔账：3 分钟立体声 48k f32 ≈ 69MB。bank 的 manifest 要报**总预载字节**，Unity 那边的内存预算由它决定。
- **V1 只做 preload。** 流式放在接法 A 之后：它需要 Rust 自己起后台读盘线程（SPSC ring 喂给引擎），四个平台各要调试一轮，明确不是 V1。

---

## 7. CI 与交叉编译的现实账单（先认账）

一个 crate、四类目标：`x86_64-pc-windows-msvc`（Editor / Windows）、`aarch64-linux-android`（NDK + `cargo-ndk`）、`aarch64-apple-ios` 与 `x86_64-apple-darwin`（**必须 macOS runner**，且签名流程要单独走一遍）。

- Windows dll 与 Android so 能在常规 CI 上跑；**苹果平台必须 macOS runner**（贵约十倍，签名还要在真机上再讲一遍）。这类"平台矩阵"的账单躲不掉，也别指望第一次就跑通。
- 每次 ABI 或 bank schema 动版，所有平台要重编、UPM 包要重打，所以 **`kolid_abi_version()` 谨慎 +1**：加函数不算破坏，改已有签名与布局才算。
- 版本口径：`kolid_abi_version` / `bank.schemaVersion` / UPM `package.json` version 三张牌一起动才叫发版；Unity 侧加载时校验三者，不匹配就明确报错，而不是"有点怪响"。

---

## 8. 施工顺序（前文件 §14.6 作废）

最要紧的一条先说：

**不要在 TypeScript 里先把 core / plan 写一遍，再搬到 Rust。** 那是双倍成本，而且搬运过程中必然长出两边不一致的地方 —— 正是这套设计要消灭的病。改成：

- **与语言无关的那些照原计划做**：bank schema、MIDI 数据模型（拍 + 段 tempo）、参数表与稳定 id、`.cud` 的 `ctx.audio`、`vbank` 与六扇窗。这些都是数据形状，**不因为 Rust 而推迟**。
- **决策层直接写 Rust。** 在它到位之前，浏览器预览继续用今天的简单路径（`<video>` / WebAudio 直接播烘好的媒体），但要在 `audio.ts` 顶部写一行注释：**临时路径，禁止获得新能力**，并且过渡窗口越短越好。
- Rust 引擎上线那一刻，预览与 Unity **同时切换**（同一个 wasm/dll，同一份 bank）。这样"两套实现各自演化"的时间窗是零。

| 阶段 | 授权侧（本仓库） | 引擎侧（kolid-audio） | 出口 |
| --- | --- | --- | --- |
| P0–P5 | 同前文件 §14.6（时钟、Audio 模式、MIDI 卷帘、烘焙、`vbank`、bank schema 定稿） | `core` + `dsp` 骨架、`.kpc`、最小可跑的 `plan()`、CLI | `kolid-render` 能 bounce 一条 fixture 且字节稳定 |
| **P6a** | 浏览器换成 AudioWorklet + wasm 预览（**同时删掉临时路径**） | wasm 目标 + JS 绑定 + Unity 绑定 B | 预览跑 wasm，行为与 CLI 输出一致 |
| **P6b** | `vbank` 加一个"目标平台"下拉与打包 | UPM 包 + 绑定 A/B 可切 + 平台库 CI | 一份 bank 在 Unity 里跑出与预览一致的行为 |
| P7 | 黄金轨迹 fixture | 同 fixture 跑原生 / wasm / Unity harness | 三者逐样本位同（或写明的降级容差） |
| ~~P8~~ | — | **删除**：共享内核已是地基，不再是兜底选项 | — |

---

## 9. 仍然要你拍板的三件事

1. **`kolid-audio` 确定是独立仓库 + 独立许可吗？** 若确定（推荐），许可要在第一次 commit 前敲定 —— MIT 与 Apache-2.0 二选一；GPL 系会让 Unity 用户很难受。
2. **V1 的空间化归属**：继续用 Unity spatializer（接法 B，便宜）还是直接自己算（接法 A，多平台行为完全可控）？我建议**先 B 后 A**，但这决定了 P6b 里要不要包含空间化。
3. **流式第一优先是哪个平台？** 四个平台衣裳各不相同，先做 Windows（Editor → Standalone）代价最小；如果第一款游戏的目标就是手机，那 Android / iOS 必须一起做 —— 这条直接左右 §7 的 CI 账单。

---

## 10. 一句话总结

> 原来的计划是"写两个运行时，再花钱证明它们一致"；现在是"只写一个运行时，花更少的钱让它到处能跑"。
> 代价是把交叉编译、Unity 原生插件 ABI、wasm 确定性这三件事提前到 P6；收益是"预览 = 游戏"从一句承诺变成一条结构性不变量。
