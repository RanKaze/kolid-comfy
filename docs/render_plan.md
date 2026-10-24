# RenderPlan：一帧的唯一契约（P0，已拍板）

> 目标：把「一帧」从「散在 83 处 2D 上下文 + 三套时钟 + 两块显示面 + 两个运行时」收敛成
> **一份计划 + 一个渲染器 + 一块画布 + 一个时钟**。
> 本文只定契约与验收，不含实现。P0 不改任何现有渲染代码。

## 0. 已拍板的三条（2026-10-25）

| 问题 | 结论 | 后果 |
|---|---|---|
| 画笔直接写纹理 | **接受** | 编辑与播放走**同一条 draw 序列**，不再有"播放中/编辑中"两套语义 |
| 用纯 WebGL2 够不够 | **够，不上原生 DLL / sidecar** | 预览主路径只在前端；DLL 只在"4K60 + 多层重链仍不够"时才重新讨论，且契约不变 |
| 导出要与预览逐像素一致 | **要** | **只有一个实现**：导出 = 同一个渲染器 + 编码器。后端**不重写**任何像素逻辑 |

最后一条是硬约束：一旦允许后端用 numpy 再实现一遍特效，"逐像素一致"就永久失去保证。
所以后端的职责被限定为：**出资源、出计划、出派生索引、封装文件**。

---

## 1. 名词（只留这几个）

| 名词 | 含义 |
|---|---|
| **Resource** | 一段可被 GPU 采样的字节：图层像素、蒙版、贴片、外部贴图（LUT/深度/法线）、视频。**id = 内容哈希** |
| **Layer** | 一个可合成的单位：`transform` + 有序 `strip` |
| **Strip** | 图层内的有序步骤列表。**折叠 = 图层像素**。现有条带顺序：`decal → effects → mask` |
| **Step** | strip 里的一步：`surface`（一块面）/ `chain`（一串特效）/ `generator`（派生：文字、方向、3D、pose、几何） |
| **Plan** | 某一时刻**整套图层**的不可变描述（`RenderPlan`） |
| **Clock** | 唯一时间来源（音频主时钟；视频帧只校准） |
| **Frame** | `Frame(plan, t) → RGBA 像素`，**纯函数** |

---

## 2. RenderPlan 数据模型

```jsonc
{
  "v": 1,
  "doc": "<docUid>",
  "grid": { "w": 832, "h": 1216 },     // 输出栅格（= 文档尺寸，与显示缩放无关）
  "fps": 30,
  // 帧只由下面这些 + t + 资源决定；不含任何"上一帧留下来的状态"
  "layers": [ /* 自底向上，见 §3.1 */ ],
  "tracks": [ /* 视频轨的时刻表，见 §2.4 */ ],
  "mask": { "kind": "track-luma", "trackId": "..." } | null,   // 视频模式的输出蒙版
  "color": { "in": "srgb", "out": "srgb", "premultiplied": false }
}
```


### 2.1 Layer

```jsonc
{
  "id": 12,
  "name": "Stash 1",
  "stack": "work" | "guidance",        // guidance 不进 context image，另有一张输出
  "visible": true,
  "opacity": 1,                        // 现在恒 1；合成只有 source-over，字段先留
  "blend": "source-over",
  "capture": null | "below",           // Stash 层：输入是"此刻以下所有层的合成"，不是自己的 img
  "transform": { "cx": 0.5, "cy": 0.5, "w": 1, "h": 1, "rotation": 0 },  // 画布归一化，语义见 §3.2
  "strip": [ /* Step，有序 */ ],
  "timeMap": {                         // null = 与时间无关（静态图层）
    "clipId": "c_17", "start": 3.3, "duration": 1.6, "offset": 0.5, "srcDuration": 4.5
  }
}
```

### 2.2 Step（三种 kind，与 `nodes/web/attr/core.js` 的 ATTR_KINDS 一一对应）

```jsonc
// surface：一块面，可以"改用某条视频轨当前帧"
{ "kind": "surface", "type": "decal" | "mask", "enabled": true,
  "surface": { "resource": "res:<hash>" } | null,
  "frameTrack": "<trackId>" | "" }      // 非空 = 这一枚面在视频模式下从该轨当前帧取像素

// chain：一串特效，作用于它左边累积的结果
{ "kind": "chain", "type": "effects", "enabled": true,
  "chain": [ { "type": "vector_blur", "enabled": true,
               "params": { /* 不透明，解释权在 fx 注册表 */ },
               "maps": { "map": "res:<hash>", "map2": "res:<hash>" } } ] }

// generator：描述符在档，面是派生
{ "kind": "generator", "type": "text" | "direction" | "3d" | "pose"
        | "crop" | "meet" | "fit" | "scale" | "limit" | "recover",
  "enabled": true,
  "desc": { /* 不可变描述符，整只换不就地改 */ },
  "box": { ... } | null,
  "ownsGrid": true,                    // 这一枚自己管图层网格（老文字/方向/3D 迁来的）
  "baked": { "resource": "res:<hash>" } | null }   // 3D 烘焙那类"算不回来"的面
```

**关键：`params` / `desc` 不在 plan 里展开语义。** 注册表（`fx/*.js`、`attr/*.js`）是解释器，
plan 只是"点名 + 值"。加一类特效不需要改 plan 格式，但要加一条 golden。

### 2.3 Resource

```jsonc
{ "id": "res:<hash>", "kind": "image" | "video" | "lut" | "depth" | "normal",
  "w": 832, "h": 1216,
  "uri": "asset://<hash>" | "media://<uid>" | "inline:<hash>" }
```

`.cud` 内嵌图像 → `inline:`；仓库图像 → `asset://`；音视频 → `media://`（唯一副本在库里）。
**plan 里没有像素**，只有 id。这是"后端拆资源、前端合并"的落点。
### 2.3.1 frame：一帧的两种形态（P2 补）

`Frame(plan,t)` 只说"图层栈合成"是不够的 —— 游标不在 Layer 段上时，画面**根本不是图层**，
是那条视频轨的当前帧（现有实现的底片路径）。所以 plan 顶层要有这一刻的"形态"：

```jsonc
"frame": {
  "mode": "layers" | "source",
  // mode=source 时唯一的内容来源：这一轨在 t 处的帧，**拉伸铺满** grid（与 paintVidBase 一致）
  "source": { "trackId": "trkmvmi206h100", "fit": "stretch",
              "at": 1.3840 } | null        // 源内时刻 = sourceTime(clip, t)，取帧必须按它精确 seek
}
```

- `mode:"layers"` ⇒ 输出 = `layers` 的合成（透明处就是透明，底片不参与）；
- `mode:"source"` ⇒ 输出 = `source` 轨的帧（`layers` 为空）。

这两种是**互斥**的，不是叠加 —— 现有实现里底片与图层各占一块画布、从不同时出现。
硬把它们叠起来会在"图层有透明区"时露出底片，与看到的画面不符。

plan 因此是**某一时刻**的描述（`v` 之外带 `t`），不是整条时间线。

### 2.4 tracks（P1 补进契约的一节）

`frameTrack` 只说"哪条轨"，合成器还得知道**那一刻这条轨播的是哪一件素材、从源内哪里取**。
所以 plan 必须带时刻表，否则合成器无从算 `sourceTime`：

```jsonc
{ "id": "trkmvmi206h100", "kind": "video", "name": "Video 2",
  "resource": "res:<内容哈希>",            // 这一轨用的素材（多素材的轨 P2 再扩成 per-clip）
  "clips": [ { "start": 3.8158, "duration": 4.52, "offset": 0, "srcDuration": 4.52 } ] }
```

音频轨**不进 plan**（预览不出声；导出时由编码器按工程音频单独处理）。

---

## 3. 求值语义（合成器要照做的全部规则）

### 3.1 顺序

```
Frame(plan, t) = Composite(layers, 自底向上)
Layer(l, t)    = Fold(l.strip, 输入 = l 的底像素)
```

- **`layers` 在 plan 里自底向上**。现有 `layers[]` 是"首 = 最上"（`render()` 倒序画），
  所以 `.cud → plan` 那一步**必须反转**。写在这里，免得实现时对齐不上。
- `stash` 层（`capture: "below"`）的输入是**当前已合成的画布**，不是自己的像素 —— 它抄的是下面的一切。
- `guidance` 栈单独折一张（`GuidanceFrame(plan,t)` = work 合成 + 所有可见 guidance）。

### 3.2 transform（与 canvas 2D 逐位一致）

```
中心   P = (cx·W, cy·H)      // 输出像素
尺寸   S = (w·W, h·H)
旋转   θ = rotation          // 弧度；正角 = 屏幕上顺时针（canvas 2D 约定，y 轴向下）
quad   = 以 P 为中心、S 为宽高、绕 P 旋转 θ
```

采样：`linear`（与 canvas 2D 的 `drawImage` 缩放默认行为一致）；不引入 mipmap（会让像素漂移）。

### 3.3 Strip 折叠（三条现有契约，升级为不可违反）

1. **footprint-neutral**：一步的输出像素网格 = 输入网格。外阴影/描边只能长进**同一张网格里本来就透明的像素**，
   不许扩边。（现有 `fx/core.js` 的地基，逐字保留。）
2. **alpha 跟画面走**：低通/模糊类把 RGB 与 A 一起滤；不透明度是随时变化的量，不是常量。
3. **蒙版只读不二次乘**：蒙版在 strip 里的位置决定它乘几次；特效只读它算 silhouette，不往输出上再裁。

### 3.4 时间

```
sourceTime(clip, t) = clamp(offset + (t - start), 0, srcDuration - ε)
```

- `t` 只来自 Clock。**视频元素不许驱动 t**（它只提供当前帧纹理，偏差 > 1 帧才 seek）。
- 时间无关的 plan（无 `timeMap`、无 `frameTrack`）在同一 t 下与 t 无关 —— 可缓存，可跨帧命中。

---

## 4. 不变量（写进仓库，可机械守卫）

| # | 不变量 | 怎么守 |
|---|---|---|
| I1 | 任意时刻只有**一块**画布参与显示 | DOM 断言：`canvas[data-visible-stage]` 数量 ≤ 1 |
| I2 | `Frame(plan,t)` 是纯函数：除显式缓存外无跨帧隐式状态 | 同一 (plan,t) 连跑两次逐像素相同 |
| I3 | 时间只有一个来源 | 除 Clock 模块外禁止读 `video.currentTime` 决定 t（grep 守卫） |
| I4 | 跨线程/跨页面**不传像素**，只传 plan 与资源引用 | grep 守卫：`createImageBitmap` / `postMessage(..., [transfer])` 只允许出现在导出模块 |
| I5 | 编辑与播放共用**同一个** draw 序列 | 代码上不允许出现第二个 `draw*Frame` 入口 |
| I6 | 任何几何/特效/合成改动必须过 golden | 见 §5 |
| I7 | 上台的那一块内容永远"有画面"（不允许空帧上台） | 帧指纹：任一输出帧覆盖率 = 0 即失败 |
| I8 | 删除优先：新路径合入时必须删掉被替代的旧分支 | 每个 PR 记录"删了多少行" |

I1 / I4 / I5 这三条，正是这几个月反复出症状（闪、卡、图层失效）的根源；它们必须是**可检查的**，
不能只是"约定"。

### 4.1 基线（P0 跑出来的现状）

`python tests/guards.py` 的输出就是重构的记账本：

| 不变量 | 现状命中 | 目标 |
|---|---|---|
| I1 只有一个显示面 | ~~3~~ → **0**（P3.2 删掉了 `applyVidBaseMode` 的 `display`/`visibility` 切换） | 0 ✅ |
| I3 时间只有一个来源 | **29** | 收敛到 Clock + FrameSource，其余 0 |
| I4 跨线程不传像素 | **7**（5 处页面回图 + fx 读回 + Player 收图） | 0（导出模块除外） |
| I5 编辑与播放同一条 draw 序列 | **4**（`render` / `composeVidFrameCanvas` / `drawLayer` / debug viewer） | 1 |
| 合计 | ~~43~~ → **40** | ≤ 1 |

这个数字是"进度条"：P2 之后 I1/I3/I4 应归零，P4 之后 I5 只剩一个入口，然后 `--strict` 进 CI。

---

## 5. 基准（golden）

### 5.1 目录与内容

```
tests/golden/vid/<case>/
  meta.json          # { case, t, fps, grid, planHash, sha256, env, tolerance }
  frame.png          # 整幅输出（未预乘 sRGB RGBA）
  plan.json          # 这一帧的 plan 快照（便于定位是哪一步变了）
```

### 5.2 生成规则（可复现）

1. headless 打开固定工程，seek 到固定 t；
2. **等稳定**：连续取 3 帧，两两逐像素相同才收（否则失败，说明源帧还在动）；
3. 取的是**合成器输出**（`composeVidFrameCanvas` / 底片帧），**不是屏幕截图** —— 屏幕受视图缩放/平移影响；
4. `meta.json` 记 `sha256` + 运行环境（UA、GL 后端），跨设备容差写在这里；
5. 容差：同一设备/驱动 **maxdiff = 0**；跨设备 **≤ 1 LSB**（且必须在 meta 里显式声明）。

```bash
# 生成（写回基准；backend 需在 127.0.0.1:8700）
node tests/golden/make.cjs
# 新实现产出到临时目录，再逐像素比
node tests/golden/make.cjs --out=temporary/_golden_new
python tests/golden/compare.py tests/golden/vid temporary/_golden_new
```

**权威设备 = 本机 + swiftshader（headless）**。真机 GPU 首次比对若在软边/浮点链上超 1 LSB，
记为"已知差异"并写进 meta，**不许悄悄放宽容差**。

`plan.json` 现在记的是**原始捕获**（`v: 0`：图层集 + 栅格 + `snapshotLayerRecord`），
它就是 P1 那个编译器的输入；编译器落地后 `v` 升到 1 并换成真正的 `RenderPlan`。

已生成的四个用例（两次生成 sha 相同 ⇒ 可复现）：

| case | t（量化后） | kind | 层数 |
|---|---|---|---|
| `base-normal` | 2.0000 | base | 0 |
| `layer-decal-blur` | 4.1667 | compose | 2 |
| `layer-late` | 4.5333 | compose | 2 |
| `after-layer` | 1.3842 | base（换到下一段源） | 0 |

每个 case 目录里还有 `plan.v1.json`（编译器产出的 RenderPlan），**基准自包含** —— 取帧不再依赖
"视频当时停在哪"，而是按 plan 的 `tracks` 算 `sourceTime(clip,t)` 再精确 seek（§5.5）。

### 5.3 比较口径（三类，别混）

| 比什么 | 判据 | 为什么 |
|---|---|---|
| **P1 的 2D 驱动** vs 旧实现 | **maxdiff 0** | 同一条采样路径（canvas 2D），就该一位不差 |
| **P2 的 GL 混合** vs P1 的输出 | `--edge --maxdiff=2` | 换了采样路径，几何边缘那 1px 的覆盖**必然**不同（见 §5.4） |
| **新实现自身**：预览 vs 导出 | **maxdiff 0** | 同一份代码、同一份 plan，只是输出目标不同 —— "逐像素一致"真正该用在**这里** |

```bash
# 换 GL 之后比（边缘带内允许差异，边缘外必须 ≤2）
python tests/golden/compare.py tests/golden/vid temporary/_golden_gl --edge --maxdiff=2
```

### 5.4 采样等价性（P1 实测，`node tests/gl_equiv/run.cjs`）

同一张源图、同一个仿射变换（缩放 0.8 + 旋转 0.37 rad + 平移），三条路对比：

| 对比 | 差异像素 | 边缘带外 maxdiff | 边缘带外 >1 的像素 | 边缘带内 max |
|---|---|---|---|---|
| 2D vs GL（straight 纹理） | 2.66% | **2** | **1 个** | 255 |
| 2D vs GL（预乘上传） | 2.66% | **2** | **1 个** | 255 |

结论（这就是 §5.3 第二行的来历）：

- **非边缘区域几乎完全一致**：maxdiff 2，超过 1 的只有 1 个像素，mean 0.017 —— 那 2 来自
  "预乘 → 解预乘"的舍入往返，不是渲染错；
- **差异全部在轮廓 1px**：两边抗锯齿的覆盖规则不同（canvas 2D 的 coverage vs GL 的采样网格），
  这一层**无法用参数调平**，只能允许；
- 预乘上传在边缘带略好（>8 的像素 916 vs 1150），**P2 用预乘**。

所以"新旧实现逐像素 0"在换 GL 时不可达 —— 这不是妥协，是把验收标准放到它该在的位置：
**跨实现看结构等价（§5.3 第 2 行），同实现看逐像素（第 3 行）**。


### 5.5 base 帧由 t 唯一决定（已修，P2 第二步）

原来的 `after-layer` 对不上（整幅差一帧）：基准取的是 `<video>` **当时停住的那一帧**
（`currentTime = 1.3508`），而时间线 5.2 按 `sourceTime` 应是 1.3842 —— **基准本身不确定**。

已落地：

- `KFrameSource`（`nodes/web/js/frame-source.js`）：`sourceTime(clip,t)` → 精确 `seek` → 等落定，
  **渲染前 `await prepare(plan,t)`**，渲染时同步取帧。窗口只在这里开；
- `frame.source.at` 由编译器算好（契约 §2.3.1），页面不再自己猜；
- 四个基准重拍，`t` 现在是 **2.0 / 4.1667 / 4.5333 / 1.3842**，两次生成 sha 完全相同；
- 用 plan + `KFrameSource` 重跑合成器：**四例全部 maxdiff 0**（含 `after-layer`）。

同一条规矩对预览也成立：合成用哪一帧必须由 t 决定，不许拿"视频顺手停在的那帧"当答案 ——
这正是老架构"三套时钟"的病根。

### 5.6 P2 实测：GL 后端与 2D 后端（`KCompositor` 的两个 backend）

同一个合成器，`backend:'gl'`（GL 预乘混合）对 `backend:'2d'` 的基准：

| case | 边缘外 maxdiff | 边缘带内差异 |
|---|---|---|
| `base-normal`（source） | **0** | 0 |
| `after-layer`（source） | **0** | 0 |
| `layer-decal-blur`（layers） | **1** | **0** |
| `layer-late`（layers） | **1** | **0** |

比 §5.4 的预判还好：原本允许"边缘带 1px 覆盖差"，实际连边缘带内都没有 —— 差的那 1 LSB 只在
层的缩放采样上（预乘往返）。**P2 的验收因此收紧为 `--edge --maxdiff=1`。**

**任何改动先在这四个用例上按 §5.3 的口径比。**

---

## 6. 从现状到契约的映射

| 现状 | 去向 |
|---|---|
| `blend_node.html` 的 `render()` / `drawLayer()` / `layerSource()` | 收进 **Compositor**（单模块，跑在 Worker + OffscreenCanvas） |
| `fx/gl.js` 的 `fxResolved()`（返回 2D canvas） | 保留链本身；**出口改为留在纹理**，不再回读 |
| `fxDropStrip()` | 原样保留（它就是"折叠"） |
| `Player` 的帧包 / 镜像 `<video>` / `vidSrcSync` | 收进 **FrameSource**（只提供"某资源在某时刻的纹理"） |
| `blendCanvas` + `vidBaseCanvas` 双面 + 监视器第三块 | **一块**输出画布 |
| `vidStageIsLive` / `vidBaseHold` / `vidStageSync` / `vidFramePacket.playing` 分支 | **删除**（换段/换套=换输入，不再换面） |
| `layer-set {key, playing}` 这类"播放位"传参 | 删除（没有第二套语义要对齐） |

---

## 7. 迁移与验收

| 阶段 | 内容 | 验收（缺一不算过） |
|---|---|---|
| **P0** ✅ | 本文 + golden 四例 + 生成/比对工具（`tests/golden/`） | 四例两次生成 sha 相同；`compare.py` 全 0 |
| **P1** | plan 编译器（`.cud → plan`）+ 新 Compositor 接静态 plan | 编译器过 `tests/test_render_plan.py`（含与 golden raw 的交叉核对）；新 Compositor 与 golden **maxdiff 0**（仍是 2D 采样，§5.3 第一行） |
| **P2** | FrameSource（✅）+ 帧由 t 唯一决定（✅）+ **GL 预乘混合（✅）** + 单画布（待做） | 四例 `--edge --maxdiff=1` 过（§5.6）；换段/换套零 >25ms 长任务；台上无空帧 |
| **P3** | 画笔直接写图层纹理 | 播放中编辑下一帧可见；暂停编辑即时；不产生第二次 draw 路径 |
| **P4** | 删旧路径（双面、帧包、纠偏、hold/sync） | grep 不到旧符号；DOM 只有一块可见画布 |
| **P5** | 导出 = 同一渲染器 + 编码器 | 导出帧 vs 预览帧 **≤1 LSB**；后端不出现像素算法 |

---

## 7.1 P3 执行清单（下一轮照单做）

顺序不能颠倒：**先让编辑有地方落笔，才能删掉第二块画布**。

| 步 | 动作 | 判据 |
|---|---|---|
| **P3.1 编辑写纹理** | 笔刷/变换的目标从 `blendCtx`（2D）改成图层的 GL 纹理；`fxResolved` 的出口从"返回 canvas"改成"返回纹理句柄"（特效链已经在 GL 里，只是最后一步 readback 了）。容量上先只改**工作层像素**（`l.img`），decal/mask 暂留 canvas 走上传。**两步都已完成**：①链结果留纹理、合成器吃纹理；②笔刷落点写纹理（§10.3.1 / §10.3.2）。 | 编辑一笔 → 下一帧合成里就能看到（不再等 render 整画布） |
| **P3.2 唯一画布** | 新 `<canvas id="stageCanvas">`（webgl2，`data-visible-stage`），`KCompositor.present` 直接合成到它；`blendCanvas` / `guidanceCanvas` / `vidBaseCanvas` 全部退成离屏缓冲，`applyVidBaseMode` 那套 display/visibility 切换整段删掉，换成"同一块面换内容"的 `stageSync`。**已完成**（见 §10.3.3）。 | §4 的 I1 从 3 → 0；屏幕上只剩一块画布 |
| **P3.3 删旧显示机** | 删剩下的 `vidBasePaintNow` / `vidBasePaintTick` / `vidBaseHidden` / `vidBaseStamp`（`applyVidBaseMode` / `vidStageIsLive` / `vidStageSync` / `vidStageBlit` / `vidStageRepaint` 已随 P3.2 删掉）；`blendCanvas` 退成"离屏上下文图"，不再参与显示。 | grep 不到这些符号；`tests/guards.py` 的 I1 = 0 |
| **P3.4 删 playing 分支** | `vidFrameFlush` 的 `active` 判据、`switchLayerSet(key, opts.playing)`、`EditPhase.showPlayLayer` 的 playing 传参、`blend-vid-frame` 的 `playing` 位 —— 都没有存在的理由了（编辑与播放同一条路径）。 | I3/I5 收口；`layer-set {key, playing}` 只剩 `{key}` |
| **P3.5 验收** | 四例 `--edge --maxdiff=1`；播放中编辑下一帧可见；换段/换套零 >25ms；`python tests/guards.py` I1=0。 | 全绿才进 P4 |

**为什么 P3.1 必须先做**：现在 `blendCanvas` 既是"笔刷落点"又是"台上那块的最坏替补"。
如果先删显示机，编辑就没地方落笔，画面会立刻空；反过来先把笔刷接到纹理，第二块画布就自然多余。

## 8. 未决（P1 之前必须定，不定就按括号里的默认走）

1. **混合模式**：现在只有 `source-over`。要不要图层级 blend（正片叠底/叠加…）？（默认：不做，字段留着）
2. **色彩空间**：fx 内部在线性光，输出回 sRGB。合成要不要也进线性光？（默认：合成全程 sRGB，只有 fx 内部线性 —— 与现状逐像素一致为前提）
3. **生成器烘焙时机**：文字/方向/3D 的面，编辑时现算还是由资源层预烘？（默认：现算，输出当资源缓存，键 = 描述符 + 网格）
4. **视频解码**：`<video>` 还是 WebCodecs？（默认：P2 先用 `<video>`，纹理源接口不变，P5 后可换）

---

## 9. 为什么这次不会再退化

过去三轮修的是**时序**（什么时候换面、什么时候发帧），每修一处就长出一处新的 ——
因为"谁在台上"是由 5 个布尔推出来的，不可判定。

这次动的是**结构**：

- 显示面只有一块 ⇒ "换手"这个概念不存在，也就没有"换手时机"可错；
- 帧只有 (plan, t) 决定 ⇒ 没有"上一帧的残留"可以错；
- 编辑与播放同一条路径 ⇒ 没有"两套语义"要对齐；
- 导出与预览同一个实现 ⇒ 没有"第二份像素逻辑"可以漂移。

判断重构是否真的落地，看三件事：**能删掉多少判断分支、`grep` 还能不能找到第二块显示面、golden 是否还在零差异。

---

## 10. 交接（新会话从这里开始）

### 10.1 进度快照（2026-10-25，P3.1 两步都已并入）

| 阶段 | 状态 |
|---|---|
| P0 契约 + 四例基准 + 不变量记账 | **完成** |
| P1 编译器（`.cud → plan`）+ 与 golden raw 交叉核对 | **完成** |
| P2 合成器（2D / GL 双后端）+ FrameSource + 基准确定化 + GL 直出 | **完成**，四例 `--edge --maxdiff=1` 全绿 |
| P3.1 第一步：链结果留在纹理上、合成器直接吃纹理 | **完成**（见 §10.3.1），四例仍全绿、PNG 字节与基线相同 |
| P3.1 余下：笔刷落笔写纹理（decal 直写，base 预折，橡皮同路径） | **完成**（见 §10.3.2），`temporary/_probe_paint_tex.cjs` 全绿 |
| P3.2 唯一画布：webgl2 `#stageCanvas` 直出，三块旧面退成离屏 | **完成**（见 §10.3.3），`temporary/_probe_stage.cjs` 全绿 |
| P3.3 删旧显示机 / P3.4 删 playing 分支 | **未开始**（P3.3 只剩 `vidBase*` 四个符号） |
| `tests/guards.py` | **40**（I1 3 → 0；其余是 P4/P5 的目标） |

### 10.2 自检（改动后必跑）

```bash
PY=<venv>/python            # 例如 C:/Users/.../envs/kolid_build/Scripts/python.exe
node tests/golden/make.cjs  # 需要时重拍基准（后端 8700 要在跑）
node temporary/_probe_compositor.cjs            # 2D  → temporary/_cmp_plan
node temporary/_probe_compositor.cjs --gl       # GL  → temporary/_cmp_gl
node temporary/_probe_compositor.cjs --direct   # 直出 → temporary/_cmp_direct
node temporary/_probe_paint_tex.cjs             # 笔刷落点 → temporary/_cmp_paint
node temporary/_probe_stage.cjs                 # 唯一显示面 → temporary/_cmp_stage
$PY tests/test_render_plan.py                                  # 编译器
$PY tests/golden/compare.py tests/golden/vid temporary/_cmp_plan --maxdiff=0
$PY tests/golden/compare.py tests/golden/vid temporary/_cmp_direct --edge --maxdiff=1
$PY tests/guards.py                                            # 不变量记账
```

### 10.3 下一步的最小切片（P3.1 第一步）—— **已完成，见 §10.3.1**

1. `fx/gl.js`：给 `applyLayerEffects` 加一个"不 readback"的出口 —— 跑完链后返回**结果的纹理**
   （`fxgl.off[col.slot]`），而不是把像素抄回 `surface`。现有 `fxDropStrip` 保持原样（它还要给
   `layerSource`/Generation 用）。
2. `compositor.js`：`items` 允许带 `texture`（有纹理就不上传 canvas），`compositeGL` 直接用纹理。
3. 验收：四例 `--edge --maxdiff=1` 不变；同时用 `__perfSample` 看每层确实少了一次 upload。

做完再进 P3.2（唯一画布）。**别跳过这一步直接删显示机** —— 编辑会没有落笔处。

### 10.3.1 已落地（2026-10-25 03:xx）

| 位置 | 变成了什么 |
|---|---|
| `fx/gl.js` | 链的执行体收成 `fxglChainRun(l, surface, opts)` → `{slot}`。两个出口只决定"结果怎么交"，不碰像素：`applyLayerEffects` = 跑链 + present + 抄回 canvas（P2 全部调用点一字未改）；`applyLayerEffectsTexture` = 跑链 + present 进**发布区**，返回 `{gl, tex, w, h}`。 |
| 发布区 | `fxglPub`：按需生长、跨帧复用的 RGBA8（预乘）纹理池。**不能用 `off[slot]` 交出去** —— 那是公共借用区，下一条链就覆盖 0/1，而合成要按序贴好几层。每趟合成开头 `fxglStageSize(w,h)` 把 `used` 归零。 |
| `compositor.js` | `items` 有两种：`{src}`（画布，上传）与 `{tex, mask}`（引擎纹理，不上传）；`compositeGL` 的 target 可以是 `{gl, canvas}` = **借 fxgl 那台上下文**（链的纹理只在它自己的上下文里有效，所以整趟合成必须搬进去）；layers 形态先 `fxglStageSize(w,h)`。 |
| 朝向 | **一个坑，踩过一次（maxdiff 154）**：引擎的面是 `v=1` 在图**上**边（`fxglUploadCanvas` 开 FLIP_Y），合成器的画布上传是 `v=0` 在图**上**边。着色器 `uFlip` 按来源翻，蒙版永远来自画布不翻。 |
| 判据 | tex 只给**最后一个** `capture:'below'` 层及其之后的层（之前的层要落成画布，后面的 Stash 层读的是 2D 攒的那本账）；链后面还有 decal/生成器 ⇒ 退回 canvas；链后面的**蒙版**例外，在着色器里乘 alpha（= destination-in）。 |
| 记账 | `KCompositor.api.stats{items,texItems,upload}`（每趟清零）+ `fxgl.stats{upload,readback,pub}`（累计）。探针每例画两遍验字节相同（`again`），并在 `meta.json` 里留一份。 |

实测（`layer-decal-blur` / `layer-late`，两张面一层链）：`stats.upload` **1**（旧 2）、`fx.readback` **0**（旧 1）、
`fx.pub` 1；四例 PNG 字节与基线**完全相同**，`compare` 输出与 P2 逐行一致。省下的是"链结果读回画布、
再整张上传"那一趟 —— 换成了同上下文里的一次 present。

**下一步**：P3.1 余下 —— 笔刷落点改成写图层纹理（`l.img`），decal/mask 暂留 canvas 走上传；
验收是"编辑一笔 → 下一帧合成就能看到"。之后再按 §7.1 的顺序进 P3.2。

### 10.3.2 笔刷落点写纹理（P3.1 余下，已落地）

**为什么要拆成 decal / base 两张纹理**：层结果 = `decal over base`。source-over 可以结合，但橡皮是
`destination-out` —— 它只该擦 decal，落在整层结果上会连 base 一起擦掉。两张面各自成立，两种笔都精确。
`base` = "把这一枚 decal 临时停用后折出来的那层"（`fxPaintBegin` 里 `rec.enabled=false` → `fxResolved`
→ 还原），所以只在 **decal 是这一层最后一条启用步骤** 时成立，入口判据在 `blend_node.html` 的
`gpuPaintEligible(l)`。

| 位置 | 变成了什么 |
|---|---|
| `fx/gl.js` | `FX_FS_INK`（`uMode=0` src over dst，`uMode=1` dst dest-out src，两张面都是直通 alpha，着色器内先预乘再除回）。`fxPaintBegin / fxPaintInk / fxPaintTexture / fxPaintPresent / fxPaintEnd`；`fxPaintCache` 是每层的纹理组（`decal[2]` 乒乓、`base`、`composed`、`pub`、`ink`）。 |
| `compositor.js` | `api.layerTexture(planLayer, t, w, h)` 钩子；`foldLayer` 命中就**立刻**返回 `{tex}`，2D 折叠一步都不跑。 |
| `blend_node.html` | `gpuStroke` 状态 + `gpuPaintEligible / buildStrokeInk / applyStrokeToSurface`；`beginStroke` 开纹理、`livePreviewStroke` 只上传 ink 并重合成、`commitStroke` 才写一次 2D 面；`drawLayer` 显示走 `fxPaintPresent(l)`。 |

**预览期间 2D decal 面一个字都不动**（`previewUntouched`），提交那一刻把同一笔墨写回一次 —— 历史/存档/
导出/缩略图读的仍是那张 2D 面（`layerSource` 不变）。合成器吃的是**预乘**纹理（与 §10.3.1 的 present
出口同口径），所以 `fxPaintTexture` 懒做一次 present 进 `pub`；编辑器显示走 `composed`（直通）经
`fxPaintPresent`，不会二次预乘。

**快速路径判据**（任一不满足就退回老的 2D 落笔）：decal 目标、非 Stash 层、decal 是这一层**最后一条
启用的步骤**、无 `frameTrack`、面的尺寸就是图层原生网格（重采样/裁过的不算）、面是这一层私有、有 WebGL2。
一笔进行到一半纹理写不进去（网格变了/面被换）时 `livePreviewStroke` 会 `fxPaintEnd` 掉并退回 2D ——
不让显示继续读一张停住的纹理。

**验收**：`node temporary/_probe_paint_tex.cjs`（后端 8700 要在跑）—— `gpu`/`gpuErase` 都 true、
`previewUntouched` true、`commitChanged`/`eraseChanged` true、`duringStats.texItems===1 && upload===0`、
`fx.readback===0 && fx.upload===1`、`duringVsAfter.max===0`、`eraseDuringVsAfter.max<=1`。

### 10.3.3 唯一显示面（P3.2，已落地）

**一句话**：全页只剩一块画布参与显示。`#stageCanvas`（webgl2、`data-visible-stage`）是它；`#blendCanvas`
（context image）、`#guidanceCanvas`（guidance 图）、`#vidBaseCanvas`（底片暂存面）全部退成离屏缓冲，
CSS 里 `display:none`，JS 里再没有一处按模式切 `display` / `visibility`。

| 位置 | 变成了什么 |
|---|---|
| `compositor.js` | 新出口 `present(canvas, items, w, h, opts)` = 把一组已折好的 items 直接合成到一块**外部** webgl2 画布；`compositeGL` 的 target 多一个 `clear`（`false` = 在已有内容上继续叠，用于"工作栈 + guidance"两趟），item 多一个 `premul`（源本身已是预乘就不再预乘）。GL 不可用返回 `false`。 |
| `blend_node.html` 显示机 | 删掉 `applyVidBaseMode` / `vidStageIsLive` / `vidStageSync` / `vidStageBlit` / `vidStageRepaint`，换成 `stageWanted()`（`live` / `base` / `composite`）+ `stageSync(force)` + `stageShowLive/Base` + `stageBlit`。模式没变就一个字节都不动；"换面"这个词从此不存在，只有同一块面换内容。 |
| `render()` | 不再是"把每层 drawImage 进 blendCtx"，而是**攒 items**：`layerItem(l)` 返回 `{src, transform}`（栅格层 `transform:null` 铺满；栅格拖动那一种把仿射烘成一张临时面；Expand 期间用 `startTransform`）。碰到 Stash 层先 `flushWork()`（合成 + `stageReadbackToBlend()`）再 `stashResample`，然后继续往上叠。guidance 栈照旧 2D 画进 `guidanceCtx`，最后整张作为一个 item 叠到 stage 上。 |
| context image | `#blendCanvas` 现在是 stage 的一次 readback（`stageReadbackToBlend`），只含工作栈 —— guidance 永远不进它。所有读像素的入口（run 输入 / Tag 区域 / Layer Context / Export PNG / 宿主预览 / 吸管）一行没改。readback 目前是**每趟 render 一次**（这些入口都假定它随时是最新的）；真嫌贵再改成"脏标记 + 消费者入口现抄"，那是 P4 的事。 |
| 底片 / 副本 | 底片帧先画进 `#vidBaseCanvas`（换源/seek 期间保留上一帧），再整张上台；别段/播放中的合成图副本由 `stageBlit(cv)` 上台。两者都只是"同一块面换内容"。 |

**为什么 items 要抄一份笔刷预览面**：`fxPaintPresent(l)` 返回的是 `fxgl.canvas` —— **一块共享画布**，
每调一次就被下一层覆盖；而 items 是先攒后传的。所以 `layerItem` 当场把预览面抄进这一层自己的临时面
（`layerScratch`，WeakMap 按图层对象做键）。栅格拖动那一帧同理。抄出来是直通 alpha 的 2D 面，
上传照常预乘。

**与 §7.1 原文的一处偏差（有意）**：stage 的位图尺寸就是文档栅格（1 doc px = 1 CSS px），**没有乘 dpr**。
`view` 那套 transform / 命中测试 / `toDocCoords` 全部按这个 1:1 口径写死，乘 dpr 会把指针数学与
`applyView` 一起翻掉；屏幕清晰度与 P3.2 的目标（唯一显示面）无关。要上 dpr 时只改
`sizeCanvasElement` + `applyView` 两处，并同时把 `linMap` 的换算带上。

**验收**：`node temporary/_probe_stage.cjs`（后端 8700 要在跑）—— `[data-visible-stage]` 恰好一个且是
`stageCanvas`；`blendCanvas` / `guidanceCanvas` / `vidBaseCanvas` 的 computed `display === 'none'`；
`#stageCanvas` 的像素 == 旧 2D 路径（`drawLayer` 逐层叠）画出来的参考图（预乘差 ≤ 1，实测 0）；
`#blendCanvas` == 只含工作栈的参考图；guidance 层 / 笔刷预览 / 提交 / `stageBlit` 之后仍然一致。
`tests/guards.py` 的 I1 = 0（43 → 40）。

### 10.4 踩过的坑（照抄，别再踩）

1. **静态路由只服务 `fx` / `js` / `attr` 三个直属目录**（子目录一律 404）⇒ 页面模块放 `js/`；
   新增目录要改 `snapshot_sampler_node.py` 并**重启后端**。
2. `render_plan.py` 里 `clips` 曾被 tracks 循环的同名变量覆盖，`source` 轨恒为 None —— 用 `all_clips`。
3. **Stash 层的 `below` 必须"已画内容"**：2D 边收集边画；GL 另开 2D 累积画布（仅含 stash 时建）。
4. GL 铺满几何：quad 顶点 ±0.5 ⇒ 要 ×2；canvas 上传纹理 v 原点在底部 ⇒ **y 取反**。
   **两种朝向会同时存在**（P3.1 起）：引擎的离屏面是 `v=1` 在图上方（上传开了 FLIP_Y），画布直传是
   `v=0` 在图上方 —— 采样对方的纹理必须按来源翻（合成器的 `uFlip`）。翻错了就是整幅上下颠倒。
5. `media://` 的 uri 要带扩展名（`media://<hash>.mp4`）。
6. node 里往页面模板插值别嵌套 `${'${T}'}`（会变成字面量）；写 `${T}` 由 node 插值。
7. `.gitignore` 里**不要**加 `tests/` —— 基准图与比对器是资产。
8. 后端改了 `.py` 必须**重启进程**才生效（`/api/cud_asset` 就是这样还没上线的）。
9. **借来的 GL 上下文会漏 `UNPACK_PREMULTIPLY_ALPHA_WEBGL`**（P3.1，实测 maxdiff 22）：合成器借
   fxgl 的上下文上传画布时把它开成 `true` 且不还原，之后 `fxglUploadCanvas` 上传的 decal/base 就被
   预乘一次，再进出口的 present 是**二次预乘**（半透明区整体压暗）。两边都钉死：`fxglUploadCanvas`
   显式 `false`（链/笔刷的面一律直通 alpha），`compositeGL` 出口也还原成 `false`。
   只在不透明面上看不出（alpha=255 时预乘是恒等）—— golden 的四例正好都是不透明视频帧，所以没抓到。
10. **低 alpha 的像素差要按预乘口径比**：合成器出口是预乘的，`getImageData` 会 unpremultiply，
   alpha=2 时 1 LSB 会被放大成 128。笔刷探针的 `pdiff` 与 golden 的 `--maxdiff` 是同一条口径。
11. **`fxPaintPresent` 返回的是一块共享画布**（P3.2）：`fxgl.canvas` 每调一次就被下一层覆盖。旧的
   `drawLayer` 是"取到就立刻 drawImage"，所以从来没暴露；改成"先攒 items、后统一上传"以后，不抄一份
   就会让所有笔刷层都显示成**最后一层**的墨。`layerItem` 里的 `layerScratch` 就是这一步。
12. **一块 canvas 只能有一种上下文**：stage 先 `getContext('webgl2')` 成功，就再也拿不到 `2d`。
   2D 兜底之所以还能用，是因为兜底分支只在 webgl2 **返回 null** 时才走（那时 canvas 还没被绑）。
   另外 `preserveDrawingBuffer` 必须开 —— `stageReadbackToBlend` 靠 `drawImage(stageCanvas)` 抄
   context image，关掉就是一张黑图（或者上一帧）。
