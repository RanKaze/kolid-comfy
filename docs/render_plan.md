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
| I1 只有一个显示面 | **3**（全在 `blend_node.html` 的 `applyVidBaseMode` 里切 `display`/`visibility`） | 0 |
| I3 时间只有一个来源 | **29** | 收敛到 Clock + FrameSource，其余 0 |
| I4 跨线程不传像素 | **7**（5 处页面回图 + fx 读回 + Player 收图） | 0（导出模块除外） |
| I5 编辑与播放同一条 draw 序列 | **4**（`render` / `composeVidFrameCanvas` / `drawLayer` / debug viewer） | 1 |
| 合计 | **43** | ≤ 1 |

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
| **P2** | FrameSource 接视频纹理 + Clock；单画布；**2D 叠加换成 GL 混合（预乘）** | 与 P1 输出 **`--edge --maxdiff=2` 过**（§5.4）；换段/换套/进出段零 >25ms 长任务；台上无空帧 |
| **P3** | 画笔直接写图层纹理 | 播放中编辑下一帧可见；暂停编辑即时；不产生第二次 draw 路径 |
| **P4** | 删旧路径（双面、帧包、纠偏、hold/sync） | grep 不到旧符号；DOM 只有一块可见画布 |
| **P5** | 导出 = 同一渲染器 + 编码器 | 导出帧 vs 预览帧 **≤1 LSB**；后端不出现像素算法 |

---

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
