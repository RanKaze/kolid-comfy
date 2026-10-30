# image attribute：把 decal 换成 image，让 Generate 往条带里落一步

> 设计稿 · 2026-10-29 · 未实现
> 修订 2026-10-29：**「底图」改名「图层盒」（`l.box`）**，image 记录的占位字段由 `box` 改为 `rect`（避免 `box.images[].box` 套娃）。改名只动术语，结构落地仍在 P3。
> 状态：**P0 已落地（2026-10-29）** —— `decal` 类型名已改成 `image`，读端几种入口都做了归一（见 §5）。
> 　　**图片已经是条带上的一枚 attribute（2026-10-30）** —— 层不自带图片：`l.box = { id, grid }` 只剩
> 　　网格，条带最左那一枚 `image`（`role:'base'`）就是这一层自己的像素，`l.img` / `l.src` 退化成
> 　　那一枚的**别名**。往上加的图与它是同一种记录（0~N 枚），Generate 就是往尾部追加一枚。
> 　　老工程打开时现场补上那一枚（见 §9.1 末尾）。
> 关联：`docs/render_plan.md`（渲染契约）、`nodes/web/attr/core.js`（注册表）、`nodes/web/js/layer-fold.js`（语义编译）

## 0. 结论

1. **`decal` 改名成 `image` 是对的**，而且不只是改名 —— 它把"图层上的贴片"和"生成出来的图"收敛成同一个东西：图层条带上一枚**图**（surface，source-over 叠）。
2. **Generate 不再换掉盒里的图、也不再开新层**：结果变成条带上新的一枚 `image` 记录，像素按 `place` 矩形画进这张图自己的面里。收益是"生成"从破坏性动作变成可停用/可删除/可叠加的一步。
3. **「底图」这个概念改名为「图层盒」，但这一版不落地**。新名字是对的：它把"网格 + 锚点 + 一张图"拆成"盒（容器）+ 盒里的图（记录）"，于是 `base` 可以写 null 那条特殊分支随之消失、空盒天然就是那个「…」缩略图。可是今天 `l.img` 同时是坐标系本体（原生网格、transform 锚点、存档 base 哈希、后端取图、GPU 落笔快路的 base 纹理），真拆要动 160+ 处 `.img`、九处后端。所以这一版**只换术语**（设计文档、P2 的 chip 文案、以后新增的注释一律写"图层盒"）；代码里 `base` 字段与既有注释等 P3 一起改 —— 此刻它们描述的仍然是实现事实，先改会变成错的。结构本身用现成的 `ownsGrid` 机制，留到 P3 单独一轮。

一句话的模型变化：

```
现在：图层 = 底图(img) + 条带[decal, effects, mask]      Generate → 覆盖 img 或新开一层
P1 ：图层 = 底图(img) + 条带[image, effects, mask…]      Generate → 往条带里加一枚 image
落地：图层 = 图层盒{ grid, base } + 条带[image×0..N, effects, mask…]   Generate → 尾部追加一枚 image
```

**术语（从本文起统一）**

| 词 | 指什么 | 内部名 |
|---|---|---|
| 图层盒 | 一层自有的坐标系与范围：原生网格 + transform 锚点 + 时间锚 + 盒里的图。**今天还不存在**，网格与锚点寄生在 `l.img` 上，P3 才摘出来 | `l.box` |
| 盒里的图 | 一枚 `image` 记录。满幅的那枚就是"以前的底图"，局部的那枚是生成/贴进来的 | `l.box.images[]` |
| 图在盒里的占位 | 归一化矩形，说明这张图铺在盒的哪一块；null = 满幅 | `images[].rect` |

> 为什么不叫 `images[].box`：容器已经叫 `box` 了，`box.images[].box` 在代码里是套娃，两层分不清谁是谁。

## 1. 现状（改之前必须先认下来的五件事）

### 1.1 图层与条带
- 图层字段：`img`（今天的"底图像素"，同时兼任图层盒的网格与锚点 —— P3 会把这两件事摘出来变成 `l.box`）、`transform`（把原生网格摆到画布）、`opacity`、`visible`、`stack`、`attrs[]`（有序 guid 列表）。
- 条带记录住在文档级 `attrRecords`，按 `l.attrs` 的顺序生效，**从左到右**（`attr/core.js` 头注释四条规矩）。注册表里 `order` / `at` 只管"新加一枚时落在哪"。
- 现有类型：`decal`(surface, order 0, head)、`effects`(chain, 1, before mask)、`mask`(surface, 2, tail)、`text`/`direction`/`3d`/`pose`/`geometry`(generator)。
- `l.decal` / `l.decalCtx` / `l.mask` 是"**最左那枚**同类记录"的视图名（迁移/快照/剪贴板那一类调用不必理解条带）。

### 1.2 折叠
- 语义编译器 `js/layer-fold.js`：`layers → plan`，`SURFACE = { decal: 1, mask: 1 }` 是**写死的表**（`layer-fold.js:41`）。
- Python 侧同一张表：`nodes/workbench/render_plan.py:169`，`elif t in ('decal', 'mask')`。
- 执行体 `js/compositor.js` 的 `foldLayer`：底像素先铺，然后按条带逐枚 `surface` 叠（`mask` → `destination-in`，其余 → `source-over`），`chain` 跑特效，`generator` 认 `baked` 面。
  - 注：**这两处表必须同义**。plan 里把 decal 写成 `generator` 会让合成器走 `baked` 分支，症状是"贴片不叠"。

### 1.3 生成链路（今天）
```
行 ▶ / sendLayerGenerate(l)
  → layerSourceForGenerate(l)  // 条带做事就送折好的面，否则送 img/src，空白层送噪声
  → generateMaskDataUrl(l)     // 图层自己的 mask（layer 尺寸）
  → 宿主 /api/blend_action {layer_image, layer_mask, preset_id}
  → 轮询 done → 宿主 postMessage {type:'blend-replace-layer', layer_id, items:[item]}
  → 页面：hasPixels ? spawnGeneratedLayer() : replaceLayerImage()
        ├─ 有像素：新开一层「xxx · gen」，transform = placeTransform(item.place, 源层 transform)，fragment=true
        └─ 无像素：就地换 img（并把 mask/decal 按新尺寸重采样）
```
- `item.place` 是"Enable Mask 开 + Recover Crop 关"时回来的 patch 矩形（在源图层自己的像素网格里量），patch 的**原始分辨率是模型工作分辨率，通常比图层大**。
- 所以"新开一层"不只是为了好看，它还承担了**保住 patch 分辨率**的职责 —— 搬到条带上时这条必须一起搬，否则每次带 mask 的生成都会降采样。

### 1.4 两条边界
- **后端合成** `snapshot_sampler_node.py:compose_blend`：只认 `('decal','mask')` 两种 attrs，`mask` 走 `decode_mask_alpha`，`decal` 走 `decode_decal_rgba`，都按**图层尺寸**解码（`:2826`, `:2850`）。
- **GPU 落笔快路**（`docs/render_plan.md` §10.3.2）：`decal` 一张纹理 + `base` 一张纹理，橡皮 `destination-out` 只擦 decal。判据之一是"decal 是这一层**最后一条启用步骤**、面尺寸就是图层原生网格"。判据写在 `blend_node.html` 的 `fxPaintBegin` / `paintSurface` 一带，按 `paintTarget === 'decal'` 分流（`:6822`, `:9549`, `:15017`）。

### 1.5 命名与生成物
- 动作键 `attr-add {type}`、`paintTarget: 'decal'|'mask'`、键位 id `paint.decal`（`js/keymap.js:61`，由 `tests/keymap.py` 生成）。
- 三份产物由生成器出：`toolSchemas.ts`、`js/keymap.js`、`uiActions.generated.ts`。**加一条两边都得改**，漏一边编译期或门禁必红。

## 2. 目标模型

### 2.1 一枚 image 记录

```js
{
  id: 'attr_…', type: 'image', enabled: true,
  surface: HTMLCanvasElement | null,   // 这张图本身；null = 还没落像素（空的 image 步骤）
  rect: { x, y, w, h } | null,         // 它在图层盒里占哪块（归一化 0..1）；null = 满幅
  frameTrack: '',                      // 视频模式：改从哪条轨的当前帧取（decal 的原字段，照旧）
  gen: { prompt, presetId, presetName, w, h, place, at } | null,  // 生成来源；手贴/画出来的没有
}
```

- `type` 用字符串 `'image'`，**不再有 `decal`**。读旧档时在 `adoptAttrPayloads` 一带把 `decal` 映射成 `image`（一行），写出去一律 `image`。
- `rect` 是这次新增的那一个字段（旧稿里叫 `box`，与容器 `l.box` 撞名，故改）。满幅时不写（null = 恒等），所以纯手画/贴图的记录和今天的 decal 完全同形。
- `gen` 只是记录上的元数据，**不参与折叠**，plan 不认识它；它给 UI 的"Regenerate / 看 prompt"用。

### 2.2 为什么是 surface，不是 generator

| | 做 surface（建议） | 做 generator |
|---|---|---|
| 引擎 | 两处类型表加一个词；合成器 source-over 现成 | 走 `baked` 面，plan 零改动，但 generator 没有 `frameTrack` |
| 落笔 | 现成的 (decal 那条快路) | 要另开一条"generator 也能落笔"的口子 |
| 描述符 | `gen` 只当元数据，不派生 | 语义上要求"面可由描述符重算"，可生成的面算不回来（3D 是同一个例外，靠 spec 覆写 `snap` 把面带上） |
| 每帧成本 | 无（面就是面） | `syncGeneratorFaces` 每帧过一遍键比对，虽然便宜但白付 |
| 后端 | `decode_decal_rgba` 直接用 | 要区分 baked / 派生的重放 |

结论：surface + `gen` 元数据。等真要做"描述符重算"（本地跑模型、参数改了自动重生成）再升级 —— 那时是**新类型**（比如 `gen-image`），不必把 `image` 拖下水。

### 2.3 为什么这一版只换名字、不落盒

搬 `l.img` 进盒 = 让"图层 = 一个盒 + 一条条带"，需要先把坐标系本体从图里摘出来：

| 今天 `l.img` 兼任 | 盒化以后得有 |
|---|---|
| 原生网格（`nativeSize(l.img)`）→ mask/image/decal 的面都按它解码 | `l.box.grid = {w,h}`，与像素无关 |
| transform 的锚点（identity 之于画布） | 挪到 `l.box` 上，但"盒里没有图"要成为合法态（不是错误态） |
| 存档 base：`l.buffer` 哈希或 `l.image` | 盒里 `images[0]` 的哈希；plan 的 `base` 字段退化成"盒里第一枚满幅图"，不再允许单独写 null |
| 后端取图（`layerSourceForGenerate` 的空白层分支） | 噪声按 `l.box.grid` 造 |
| GPU 落笔快路的 base 纹理（"把这一枚 image 停用后折出来的那层"） | 换判据：折"目标左侧的所有步骤" |
| `hasLayerImage` 一类谓词（菜单灰不灰、能不能生成） | 改成问"盒里有没有启用的图" |

160+ 处 `.img`、`replaceLayerImage` 的重采样分支、raster 层的画布尺寸约束、PSD/导出、`.cud` 的 base。**做完 P1 之后这些再动，风险小一半**（因为那时"生成结果"已经不在 `img` 上了）。

> 想先要"看起来统一"的话，P2 有个便宜的中间态：条带最左边给盒一枚**不可删的 chip**（不是记录，只是视图），点和右键走的是今天 img 的动作。等 P3 真搬的时候，这枚 chip 原地变成 `images[0]`。
> chip 上**不写"盒"字** —— 图层行左边已经有一个 36×24 的缩略图方块，再出现一个叫"盒"的东西会分不清谁是谁。chip 上写盒自己的尺寸（`737×491`）或图数（`0 图`），名字留在 tooltip 与右键菜单里；Dock 那边另有 Block（块），"盒/块"也别在同一屏里混用。

## 3. 七条语义（要钉死，否则实现时会各写一套）

1. **合成算子**：`image` 一律 `source-over`，橡皮 `destination-out` 只擦**它自己那张面**（与 decal 今日一致，也与 GPU 快路的两张纹理模型一致）。
2. **落点**：手工 `+` 加一枚 → 落在"最后一个 mask 之前"（= decal 今天的位置，等价的遮蔽语义）；Generate 产出的那枚 → 落在**发起它的那一步右边**；从行头 ▶ 发起（源 = 整层）时按第 2 条的默认位置。
3. **区域**：`image` 的面尺寸 = 自己的像素尺寸，`rect` 说明它铺在盒的哪一块，默认满幅。
   - 生成回来的 patch：`surface` 用 patch 原分辨率、`rect` = `place` 归一化到盒的网格。**不降采样**。
   - 于是"区域内产生一枚 image"是像素级承诺：框外透明，底下那几步照旧透出来。
4. **Generate 的输入**：
   - 从行 ▶ 发起：折到整层（今天的 `fxSurfaceForGenerate`，不变）。
   - 从某一枚 chip 发起：折到**那一枚为止**（给 `fxSurfaceForGenerate` 加一个 `stopGuid`）。这样"在生成结果上继续改"不会把右边的步骤也喂给模型。
5. **覆盖 vs 追加**（默认策略）：
   - 行 ▶ 再按一次 = **覆盖最后一枚**带 `gen` 的 image 的面（就地换面，仍然非破坏 —— 盒里更早的步骤都在，undo 一步可回）。
   - 右键 chip → "Generate as new step" = 追加一枚。
   - 理由：不设默认覆盖的话，连点三次生成会留下三张互相完全遮住的全幅图，用户看不出发生了什么。
6. **停用/删除/撤销**：`enabled=false` 只是跳过（数据留着），删除要连带释放那张面（`attr-prune` 那条链），撤销走 `attr-add`/面写回的现有快照口径（面是 copy-on-write，不必深拷）。
7. **内存**：一枚 image 面 = 一张原生尺寸画布。生成 N 次不覆盖的话就是 N 张。要有两条闸：① chip 预览用一张 36×24 的降采样缓存，别每帧 `drawImage` 全尺寸；② 文档级预算（已有 `faces` 通道那套"可见区 + 每帧封顶"可以复用）。

## 4. 改动清单

| 文件 | 改什么 | 判据 |
|---|---|---|
| `nodes/web/attr/image.js`（新，删 `decal.js`） | `type:'image'`、`kind:'surface'`、`legacy:'decal'`、`ctx:'decalCtx'`（保留老 ctx 名，别动几处取 ctx 的调用）、`at:{rel:'before',of:'mask'}`、`chipClass:'image-thumb'`、`firstFace` 透明 | 加一类 = 一个文件 + 一行 `<script>`（注册表自己的规矩） |
| `nodes/web/attr/core.js` | `ATTR_TYPES` 里自然收下；`adoptAttrPayloads`/load 处把旧 `type:'decal'` 映射成 `image` | 旧档打开像素不变 |
| `nodes/web/js/layer-fold.js` | `SURFACE = { image: 1, mask: 1 }`；surface step 多带 `rect` | plan 里 `image` 是 `surface` 不是 `generator` |
| `nodes/workbench/render_plan.py` | `t in ('image','mask')`；surface step 多带 `rect` | 与 JS 编译器的 plan 逐字段一致（`tests/test_render_plan.py`） |
| `nodes/web/js/compositor.js` | surface 画的时候认 `rect`（`drawImage(cv, rx,ry,rw,rh)`），无 rect = 满幅 | 有 rect 的层不退化成全幅拉伸 |
| `nodes/workbench/snapshot_sampler_node.py` | `compose_blend` 认 `('image','mask')`；image 按 `rect` 画进盒尺寸的缓冲再叠；旧负载的 `decal` 分支留着兼容 | 后端合成 = 页面折图（`_probe_fold_cmp`） |
| `libs/image_utils.py` | `composite_layers` 里 `type != 'decal'` 会让**所有新名字的面被静默跳过**；改成 `not in ('image','decal')`，老 fallback 也写 `image` | 老负载的贴片照样叠上去 |
| `blend_node.html` 的 `recAttrEntries` | 查 `ATTR_TYPES` **之前**先 `canonAttrType`，否则旧 `.cud` 的 `attrs` 条目被 `filter` 掉 | 旧档打开贴片/笔画还在 |
| `nodes/web/blend_node.html` | `paintTarget`/`isDecalTarget` 改叫 image；`blend-replace-layer` 的落点从"换图/开新层"改成"写一枚 image 记录"；`spawnGeneratedLayer` 退役（先留开关）；`sendLayerGenerate` 带 `source_step`；`generateMaskDataUrl` 不变 | 同 prompt 同 seed 下"新 attr 路"与"旧换图路"像素差 = 0（全幅覆盖时） |
| `ui/sampler_node/src/types.ts` + `workbench/layerRow.tsx` | `chipClass`、`title` 文案、`noImage` 判据（`!row.orig && !hasImageAttr`）、`+` 菜单那一条 | 类型角标/缩略图/new 占位都对 |
| `tests/keymap.py` → `js/keymap.js` | `paint.decal` 的 label 改，**id 保留**（用户的键位表按 id 存） | `_test_keymap_parity.mjs` 绿 |
| `ui/…/toolSchemas.ts`、`uiActions.generated.ts` | 走生成器重跑 | agent 工具数变化要与 `tests/test_agent_tool_catalog.py` 对齐 |
| `docs/render_plan.md` | §2.2 surface 的类型表加 `image` + `rect` 字段；§10.3.2 快路判据改词 | 文档与代码同义 |

规模估计：**10 个文件、约 600–900 行**，一半是机械改名；真正的逻辑改动集中在"落点/rect/覆盖策略"三处。

## 5. 迁移与兼容

- **旧 .cud（v5/v6）**：`header.attributes` 里的记录 `type:'decal'` → 读端映射成 `image`，`rect` 补 null。`CUD_VERSION` **不升**（读端兼容即可）；要升就升到 7 并写清双向（老读端会把 image 当未知类型丢掉 —— 这是升版本唯一的理由）。
- **归一只在四处发生**（P0 实现）：① `attr/core.js` 的 `ATTR_TYPE_ALIAS` + `canonAttrType`，`adoptAttrPayloads` 用它查表；② `blend_node.html` 的 `recAttrEntries` 在 `filter` 前用它；③ `js/layer-fold.js` 的 `canonType`（折叠自带一份，因为喂进来的可能是老记录，不能指望调用方先改名）；④ `render_plan.py` 的 `steps_of` 与 `snapshot_sampler_node.compose_blend`。**写出去一律 `image`**：`snapshotAttrs` 只认记录上的 `type`，记录已经归一。
- **golden 的判据放宽了一处**：`tests/layer_fold/compare.cjs` 的 `diff` 先把 `type`/`role` 上的 `decal` 翻成 `image` 再比 —— `plan.v1.json` 是历史快照，不该为了改名重拍。
- **旧字段**：`l.decal` / `l.decalCtx` 保留为别名（指向最左那枚 image），代码里逐步换成 `l.image`；`legacy:'decal'` 继续管老档迁移。
- **动作键与键位**：`attr-add` 的 `type` 值改成 `'image'`；`paintTarget` 的字面量改 `'image'`；键位 id `paint.decal` **不改**（本地键位按 id 存）。UI 文案统一叫 Image。
- **探针**：`temporary/_test_layer_fold_refs.mjs` 的 fixture 里 `type:'decal'` 要留一份当"旧档"用例，再补一份 `type:'image' + rect`。
- **门禁**：`tests/guards.py` 基线 43 条不该变（它是渲染不变式扫描）；新增一条"条带里出现 image 时 plan 的 step.kind 必须是 surface"。

## 6. 分四步

| 步 | 内容 | 验收 |
|---|---|---|
| **P0 改名** | `decal` → `image`，语义零变化；读端迁移；文档两处 | 旧档像素 diff = 0；`_probe_render_diff`、`_probe_fold_cmp` 全绿；guards 43 |
| **P1 生成落 attr** | `blend-replace-layer` 分支改成写 `image` 记录（带 `rect`、`gen`）；`spawnGeneratedLayer` 收进开关 | 带 mask 的生成：patch 分辨率不降（与旧路的变换结果 `--maxdiff=2` 对齐）；连点两次 = 覆盖策略生效 |
| **P2 UI 收口** | 条带最左一枚盒 chip（视图，写尺寸不写"盒"字）；`noImage` 占位判据改成"盒里没有启用的图"；chip 右键加 Regenerate / Generate as new step | 图层面板不再出现"红叉/点点"以外的歧义态 |
| **P3（可选）盒化** | `l.img` → `l.box{grid,transform,images[]}`，底图变成 `images[0]`（`ownsGrid`） | 单独立项；前置：P1/P2 稳定一个版本、`.cud` 升 v7、旧档 diff = 0 |

## 7. 要拍的四件事

1. **图层盒这一版落不落地？** 建议只换术语（文档/注释/UI 文案），结构与 `l.box` 留到 P3。真落地要先有一个与像素无关的盒记录，属于另一个量级。
2. **生成结果的落点**：紧跟源步骤右边 / 尾部（最后一个 mask 之前）—— 建议前者，可解释。
3. **默认覆盖还是默认追加？** 建议"行 ▶ 覆盖最后一枚 gen-image，右键追加"。
4. **Regenerate 这一版要不要带？** 带上成本很低（记录里有 `gen`，重开弹窗预填 prompt/preset），建议带。

## 8. 风险

| 风险 | 症状 | 处理 |
|---|---|---|
| plan 双编译器漂移 | 页面折出来的和后端合成的不是一张 | P0 就把两处类型表一起改，`test_render_plan.py` 加 image 用例 |
| GPU 落笔快路判据 | 带 rect 的 image 走了快路 ⇒ 笔迹位置错 | 判据里加"面尺寸 = 盒的网格且 rect = 满幅"，不满足就退回 2D（已有这条退路） |
| patch 分辨率 | 带 mask 的生成变糊 | `rect` + 面用原分辨率（本文 §3.3），不接受"压进盒的网格" |
| 盒化的量级被判轻 | 以为"改个名"，实际要动 160+ 处 `.img` | 术语与结构分开排期：P0 只换词，结构等 P3，验收各自独立 |
| 生成结果堆积 | 一个图层上十枚全幅图，内存翻倍 | 覆盖策略 + 面预算 + 删除即释放 |
| 视频 `frameTrack` | image 绑轨后和 mask 绑轨冲突 | 一个图层同一时刻只允许一枚 `frameTrack` 非空（沿用 decal 的判据） |
| `l.decal` 别名长期残留 | 两套叫法 | 别名只留一版，P2 结束前把调用点换干净 |

## 9. 落地记录（2026-10-30）

> 这一节记的是**已经写进代码的事实**，不是计划。§0–§8 里的 P1/P2/P3 编号保持原样，方便对照当初的设计。

### 9.1 现在的形状

```js
l.box = { id: 'box_3', grid: { w: 737, h: 491 } };   // 盒里只剩网格

l.attrs = [                                          // 条带 = 这一层的全部步骤
  { id: 'img_12', type: 'image', role: 'base',       // ← 底位就是一枚 image attribute
    surface: <canvas|HTMLImageElement>, src: 'data:…' },
  { id: 'img_19', type: 'image', surface: … },       // 叠在底位上的图（落笔 / Generate）
  { id: 'attr_7', type: 'mask',    surface: … },
];
```

**图层不再自带图片**。它带一个只有网格的盒，和一条条带；条带最左那一枚 `image`（`role:'base'`）就是
这一层自己的像素，后面每一枚是叠在它上面的图。同一种记录、同一张表（`attrRecords`）、同一套身份。

- `l.img` / `l.src` 是**底位那一枚的 getter/setter**（`attachSourceView`）。它们已经不再拥有任何东西 ——
  162 处调用点一行没改，这是这次能只动一块地方的原因。
- `l.box.grid` 只由底位的像素尺寸说话：换面（`writeSource`）、重采样、栅格化、`commitRasterTransform`
  全都走 `l.img = …` 这一个漏斗，网格在那里跟着走，别处不许各记一份。
- **底位就是普通一步**：条带上每一枚 image（含 `role:'base'` 那一枚）都是一次 source-over，位置就是生效
  位置。从前它被折叠单独当"起始面"铺一遍、又被排除在步骤之外，于是"拖一枚 image 到别处"永远不改变画面
  —— 这正是用户报的那句"image attribute 拖不动"。现在把底位拖到一条 FX 链右边，那条链就跑在"图还没画出来"
  的画布上，于是这条链不作用于它：拖完成的是一个真结果，不是换个说法。
- 老读法（`findAttr` / `lastAttr`）**跳过**底位：`l.decal` 说的是"我在这层上又涂的那一张"，
  不是"这一层自己的像素"。
- `hasLayerImage(l)` 问两处：底位（`surface && src`），以及条带上有没有一枚画得出来的 `image` 步骤。
- `boxImageCount(l)` = 底位有像素算一张 + 每枚 `image` 步骤各一张（行上 tooltip 报的就是它）。
- 共享仍走 `srcRef`（= 底位那一枚的 guid）与 `attrRefs` 计数：**复制图层 = 两层条带里装同一枚底位**
  （smart object 语义），谁换自己的图，`writeSource` 就当场给自己换一条私有记录，另一层不动。
  实测：`<img>` 底位复制后 `attrRefs` = 2、`boxBase` 同一个对象；写一次 = 各自 1、另一层像素不动。

**Generate 的结果 = 条带尾部的一枚 image 步骤**（`appendGeneratedImage`）：底位一个像素都不动，
图层也不再多出一层。落点算在"最后一枚 image 步骤之后"，所以它叠在前几张图之上，却仍在蒙版与链的
左边 —— 这一层自己的蒙版照样裁得到它。带回 `place` 时（Enable Mask 开 + Recover Crop 关）只把
mask 外接框那块 patch 画进矩形，不摊满整层。

**老工程打开时现场迁移**：文件里没有 `role:'base'` 那一枚时，`restoreSource` 会给这一层立一枚
（像素就是原来那张 `image`），`ensureBaseInStrip` 把它摆到最左。于是"图片固有在 layer 里"的旧档，
读进来就变成"图片是条带上的第一枚 image attribute"，存档再存出去也是新形状。

### 9.2 文件与两端

- `.cud` 每条图层记录：`box: { id, grid }`（只剩网格）+ `attrs`（最左那一枚带 `role:'base'`）。
  `image` 继续写 —— 老读端读 `image`，新读端优先条带里那一枚。**`CUD_VERSION` 不升**：同一版本内的
  加字段，丢了也能退回 `image` / `pw` / `ph` 重建，不构成新的文档能力。
- 读端 `boxBaseRefOf()` 仍认**老**三种形状（`box.base` → `box.images[0]` → 图层 `image`），它只服务旧档；
  新档的底位随 `attrs` 回来。
- 空白底位（手画的空层、文字/方向层的格子）**不**入档：写着 `image: null` + grid，重开时按格子重建
  那张空画布 —— 与"塞一枚全透明 PNG"划清界限。
- 底位那一枚的像素**不走 attr 表**：`resolveRecAttrs` 见到 `role:'base'` 只收身份（guid + role），面由
  `image` 那一趟解出来的 `<img>` 补上（那张图可共享、可直取原字节，0 编码保存靠的就是它）。
- 后端 `render_plan.py`：`base` **恒为 null** —— 底位现在在 `strip` 自己的位置上，`steps_of` 不再跳过
  它。只有**条带上根本没有 image 记录**的老档才补一枚（收底像素的三种老形状：`box.base.image` →
  `box.images[0].image` → 图层 `image`），否则那一层会整层不出现。`tests/test_render_plan.py`
  现在有 8 条断言（底位属性 / 底位+叠图 / 底位拖到右边 / 蒙版在底位之前 / 上一版形状 / 老形状 / 空盒）。
- 行载荷（页面 → 宿主）的 `attrs[]` **包含**底位那一枚（带 `role:'base'`）：图层行上因此看得见
  "这一层自己的图"就是第一枚 chip，tooltip 说 "Base image"。`box: { id, w, h, images, base }` 照旧。
  底位那枚 chip 左上角有一个 4px 方点（`.attr-base-mark`）—— 位置挑过：类型角标占右下、拖放插入线占
  左右两侧 0 位。**它跟别的 chip 一样能拖**（位置决定生效位置，见上一条）；只有删/停用/复制仍然被
  页面那三道闸挡着 —— 那一枚没了，这一层就没了自己的像素。
- 遮罩层（纯 Mask）也过这一趟：它的底位同样是一枚 image 记录，所以 `attrRefs` 特意把 `maskLayer`
  算成一个持有者 —— 否则"删掉最后一层"那趟 `pruneAttrs` 会把它的画布当场放掉。
- 底位"就地上画"要先换面：读档那张是可共享的 `<img>`（没有 `getContext`），`writableBaseFace(l)`
  经 `writeSource` 把它换成画布 —— 独占时是原地换（`srcRef` 不变），共享时当场断开（新立一枚，另一层
  的 `<img>` 与像素都不动）。**换面发生在第一笔之前**（`ensurePaintSurface`），不是点开 chip 的那一刻：
  只看一眼不该付出"换画布 + 断共享 + 丢掉 0 编码保存"的代价。换过记录后 `paintRef` 跟着走到新的那条。
  实测真档 25 层：`<img>` 底位 20 张 / 画布 5 张，两条分支换完逐像素 `diff = 0`。

### 9.3 还没做的

| 事 | 状态 | 为什么现在不做 |
|---|---|---|
| 生成结果的**覆盖/预算**策略（§3 那七条） | 未做 | 现在是无条件追加；一个层上十张全幅图会内存翻倍，要配面预算与"替换最后一枚"的开关 |
| 底位的"删/停用/复制" 三道闸要不要开 | 未做 | 先让"拖得动"跑稳。开了之后"这一层自己的图"可以整块消失，得先想清楚空盒的可见长相 |
| `decal` 老别名清理（`l.decal` / `paint.decal`） | 未做 | 键位按 id 存、旧档按字段名写；清理要单独一版，先让新名字跑稳 |

## 10. Stash 也是条带上的一枚步骤（2026-10-30）

这一节补的是 §9 之后的一笔：**Stash 不再是"图层种类"**。

它过去是 `l.stash` + `raster:true` + 几何焊死画布的一整种图层，于是它必须在自己身上带一枚
`src` 为空、每帧被 `stashResample` 原地重写的 image（底位）—— 那正是「特殊的 image attribute」。
为了那一枚，代码里有十几处例外（不能移动/缩放/旋转、不能 bake、不能 Combine、不随编组拖动、不进导出、
存档时"没有像素可存"、plan 里独一份 `capture:'below'`）。

现在它是一枚 attribute：`nodes/web/attr/stash.js`，`type:'stash'` / `kind:'surface'`，`at:{rel:'tail'}`。

- **面是派生的**：每次 render 轮到这一层时，页面把"这一层以下那一叠"（`stashAcc`，只含图层、不含底片帧）
  抄进**它自己那枚记录**的 `surface`。一层挂几枚就抄几枚，它们的"以下"是同一张图。
- **它是普通一步**（source-over）：位置随便拖 —— 拖到一条链右边，那条链就不作用于它。
- **所在的层是普通层**：能移动/缩放/旋转/编组/Rasterize/Combine。这条是用户拍的板（"全部放开"）。
- **没有底位、`src` 恒空、面不入档**：存档里这一枚只有类型与位置（`cudAttrs` 里排在"有面才入档"之前
  的那一岔），读回来第一次 render 就补上。
- **不接画笔**（`spec.noPaint`）：它的面每帧被重抄，落上去的墨下一帧就没了。想画就往这一层加一枚 Image。
- **一层可以挂 0~N 枚**，与其他种类同一套规矩。

**"零张图的层"从此是常态**（老 Stash 层迁过来就是"一枚 Stash、零张 image"）。为此新增两条判据，
它们和 §9 里那条"底位就是普通一步"是一套的：

1. `layerGridOf(l)` —— "这一层多大"。底位有像素听它 → 否则听条带上第一枚自带像素的步骤 → 否则画布。
   `fxResolved` / `layerSourceViaPlan` / `stashCapture` / 存盘的 `pw/ph` 都问这一句。
2. `layerCanDraw(l)` —— "这一层这一帧画不画得出东西"。`drawLayer` / `layerItem` 的早退从 `!!l.img`
   换成了它；否则"零张图 + 一枚 Stash"的层会整层消失。

**读档/重放不补空底位**：`attachSourceView` 与 `restoreSource` 各加一条 ——"没有像素 + 条带上已有步骤"
时不立那一枚。补出来的正是最初要消灭的那个例外。**空盒**是有长相的（行上中性底 + 白细边 + 省略符，
见 `.layer-thumb.no-image`），不必拿一枚空 image 撑场面。

**老档迁移**：`rec.stash` 的图层 → 丢掉底位、条带头上插一枚 Stash、`img` 归 `null`、`raster` 归 `false`
（那层现在是普通层）。用户自己涂过的 Image 步骤原样留着 —— 旧版抄写只重写 `img`，墨进的是另一张面。
