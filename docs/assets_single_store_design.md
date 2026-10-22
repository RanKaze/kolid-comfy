# 设计 v3：Assets 是唯一的家（已拍板）

> 取代 `assets_single_store_design.md`（v2）与 `staging_to_assets_redesign.md`（v1）。
> v1 §1 的现状 touchpoint 清单（后端 / 宿主 / 页面 / fx / 视频 / 桌面壳，带行号）仍然有效，本文不再重复。

---

## 0. 已拍板的三条

| 决策 | 结论 | 影响 |
|---|---|---|
| **A. 资产 id** | **内容哈希**：id = 文件名 stem，新货 `md5(bytes)`、老货沿用 `md5(base64)` 的文件名（不重算、不改名） | 免读档重映射、天然去重、天然 copy-on-write、跨文档稳定；查询可只给前 8 位（唯一才认） |
| **B. `.cud` 装不装字节** | **图像内嵌、音视频不内嵌** | 见 §1：图像"文档是权威"，音视频"库是权威" |
| **C. 图层像素** | **彻底物化**：图层只持有 hash，像素一律在仓库 | 图层与"图池里的图"共享同一份字节；删索引不影响图层 |

### B 到底在问什么（补一句解释）

原来的问题是：`.cud` 是**自包含**（把图塞进文件）还是**只写引用**（指向本机 `data/assets/`）。
- 只写引用 → 文件小、改一下不用重存几 MB，但把 .cud 拷到另一台机器 ⇒ 全部红叉；
- 自包含 → 到哪都能开，但文件大、和库里的同一张图存两遍。

你的答案把两者分开了：**图像自包含，音视频只引用**。这是对的，因为
① 图像是画面的本体，缺一张就整幅不对；② 音视频动辄几十上百 MB，塞进 .cud 不现实，而且它本来就在本机库里有文件。

---

## 1. 由此定下的两条权威线（v3 的核心）

```
   图像（image / mask / decal / map / pose / render / composite）
        .cud 内嵌字节  ──载入时导入──▶  data/assets/<hash>.<ext>（工作缓存）
        权威 = 文档                库里的那份随时可以删、可以重建

   音频 / 视频
        .cud 只记 hash + 元数据 ──▶  data/assets/<hash>.<ext>（唯一副本）
        权威 = 库                  文档里没有副本，删了就真没了
```

一句话：**图像是"文档自带、库里缓存"；音视频是"库里独有、文档只记地址"。**

这条规则同时决定了 GC 的边界（§6）：图像可以放心回收（文档能重建），音视频一旦被引用就绝不能自动删。

---

## 2. 数据模型

```ts
type AssetKind = 'image'|'mask'|'decal'|'map'|'pose'|'render'|'composite'|'video'|'audio';

type AssetRecord = {
  hash: string;               // 身份 = 内容；文件名 <hash>.<ext>
  name: string;               // 可改，不参与身份
  kind: AssetKind;
  w?: number; h?: number;
  duration?: number; hasAudio?: boolean;   // 音视频
  origin: 'upload'|'asset-node'|'run'|'detailer'|'processor'|'detect'
        | 'layer-export'|'layer-source'|'layer-buffer'|'guidance'|'map-file'|'vid-ingest'|'pose';
  created: number;
  // scope 不存 —— 见下
};

/** 作用域是**算出来的**，不是存下来的（存下来的布尔一定会漂）。 */
scope(asset) =
  'library'  if hash ∈ data/assets/index.json 的成员表        // 用户主动入库 / Assets 节点产出
  'project'  if hash ∈ 任一打开中的文档 manifest.assets       // 本工程在用（保存时会被内嵌/引用）
  'session'  otherwise                                        // 只在仓库里、没人引用 → GC 候选

type StagingRef = { asset: string; name?: string; place?: PlaceRect; added: number };  // 有序
type LayerBinding = { source?: string; buffer?: string };     // buffer = 物化快照
type FxMapRef = { asset: string; name?: string };
type PortRef = { [port: number]: string | string[] };
type ClipRef = { asset: string; /* 时间线其余字段不变 */ };
```

> **为什么 scope 要派生**：如果存成字段，就一定会出现"文档在用、却标着 session"的资产被 GC 删掉。
> 派生之后只有一个真相：**引用图**。窗里的三个 scope tab 就是同一张表的三条过滤线，
> `Session` = "仓库里有、但没有任何文档/库引用"——这恰好是用户想看的"临时产物"。

---

## 3. `.cud` v6：一张表、一次去重、两种字节

```jsonc
header = {
  format: 'cud', version: 6,
  assets: [
    // 图像：length > 0 ⇒ payload 里有这段字节
    { hash:'9f2c1a3b4d', role:'image',      w:1024, h:1024, length: 812345 },
    { hash:'1a2b3c4d5e', role:'masklayer',  w:1024, h:1024, length: 123456 },
    { hash:'77aa88bb99', role:'map',        w:2048, h:2048, length: 2000123 },
    // 音视频：不内嵌，只记身份与元数据
    { hash:'cc11dd22ee', role:'video', w:1920, h:1080, duration: 12.4, hasAudio: true, length: 0 },
    { hash:'ab12cd34ef', role:'audio', duration: 31.2, length: 0 }
  ],
  staging: [ { asset:'9f2c1a3b4d', name:'Detail #3', place:null, added:1729… } ],
  layers:  [ /* …原有字段…, { buffer:'1a2b3c4d5e', source:'9f2c1a3b4d' } */ ],
  attributes: [ /* 原有，值仍是 assets 里的 hash */ ]
}
payload = 依次拼接 length > 0 的那些资产的字节（PNG / WEBP 原样）
```

**规则**
1. **同一 hash 在 `assets` 里只出现一行** —— 这就是"图层像素、staging 图、decal、贴图其实是同一张图"时省下的那份体积（今天它们各存一份）。
2. `length > 0` ⇒ 内嵌；`length` 缺省或 0 ⇒ 只引用。**由 kind 决定，不由用户勾**（图像必内嵌，音视频必不内嵌）。
3. 保存时：所有被引用到的图像类资产 ⇒ 确保 payload 在（取仓库里的那份，或从内存 buffer 现编码）。
4. 读取时：有 payload 的 → `put_bytes` 进仓库（已存在则跳过）→ **hash 校验**；对不上 = 文件损坏，按 hash 报错而不是"随便用一张"。
   只引用没 payload 的 → 查仓库；不在 ⇒ 进 §4 的 missing 流程。
5. v5 兼容：`staging[].src`（base64）与 `assets[]`（序号）全部导入仓库 → 用 hash 重建 `assets`/`staging`/`layers`/fx refs，同时把 Extra Prompt 里的 `<image_id:staging_N>` 一次性改写成 `<image_id:<hash>>`。

**仍然是"能救就救"**：`assets` 行里的 `w/h/role` 缺了就从字节现推；hash 只有一个却引用多次 → 合一行。

---

## 4. Assets 窗（`vassets`）—— 唯一的脸

### 4.1 顶栏

```
[ Scope: All | Library | Project | Session ]  [ Kind: All ▾ ]  [ 🔍 搜索 ]  [＋ Import]
```
- `Library` = 库成员表；`Project` = 当前文档 manifest 里的资产；`Session` = 两者都不在的（临时产物）。
- 底部状态条（保留现有地球按钮的位置）：`N assets · M embedded in this doc · K missing`

### 4.2 卡片

```
┌──────────────────────────┐
│ 缩略图（视频沿用 <video> fastSeek 悬停扫片）│
│ IMG · 内嵌                │   ← 「字节来源」徽章（新增，见下）
├──────────────────────────┤
│ Detail #12                │   ← 双击改名
│ 1024×1024 · run           │   ← 尺寸 + origin
│ 用着：staging #3 · 层 Red  │   ← used-by，可点击定位
└──────────────────────────┘
```

**「字节来源」三态**（这是 B 决策带来的新信息，必须显示）：
| 徽章 | 含义 | 能做什么 |
|---|---|---|
| `内嵌` | 这份字节在某份打开的文档里 | 删库里的副本安全（文档能重建） |
| `本机` | 只在 `data/assets/`（库或临时） | 珍贵的话 `Pin to library` |
| `缺失` | 文档引用了，但仓库里没有（音视频常见） | 走 §4.4 relink |

### 4.3 操作

- **拖出去**：拖到 Staging 条（加索引）、图层列表（当智能图层）、时间线（落片段）、fx 槽（绑贴图）
- **改**：重命名、打标签、`Promote to library`（把临时产物升成库成员）、`Pin into document`（音视频用：把它内嵌进当前 .cud，见 §4.4）
- **删（两种，必须分开）**：
  - `Remove from workspace` —— 只删引用（staging 条目 / 图层绑定 / fx 槽），字节与记录都留着
  - `Delete asset` —— 删字节。有引用就**列出引用方并拦**；图像若无引用则直接删（文档里还有副本）
- **在磁盘上显示**
- 拖拽协议统一成 `application/x-asset = {hash}`，替掉现在的 `x-vid-asset` / `x-vid-global` / `x-blend-staging`

**已落地（2026-10-22）**：图卡（`kind: image`）的载荷是 `application/x-asset = {id,url,name,kind,asset}`，
三个落点都认（`temporary/_probe_asset_drag.cjs`，24/24 连跑两次）：

| 落点 | 谁收 | 落地动作 |
|---|---|---|
| Staging 条 | 宿主 `staging.tsx` | 读字节 → data URL → 与拖本地文件同一个上传口（`/api/staging` 新条目，图池权威仍在后端） |
| Layers / Guidances 两摞 | 宿主 `layerRow.tsx` | 宿主读载荷、发 `layer-from-asset`，页面 `addAssetAsLayer` 按 URL 建智能图层（`source` = `asset`） |
| 画布 | `blend_node.html` 自己的 window drop | 同上，跨 iframe 一口 drop 直接收，不经宿主 |

`url` 优先指仓库地址（`/api/asset_media/<hash>`，跨 iframe 也读得到），仓库里缺了才退回资产自己的 `src`
（A4 内嵌的那份字节还在）。图片不再发 `x-vid-global`（时间线上没有片段可落），音视频照旧两种载荷都带。

### 4.4 缺失与 relink（B 决策必须配的一步）—— **已落地（A5b）**

音视频不内嵌 ⇒ 把 .cud 挪到别的机器/仓库，它们一定缺。现在：

1. 打开工程（以及每次改动后）批量问 `/api/assets_exist`：**只拿"在/不在"，不改工程里任何一个字段**；
2. 缺的片段：红边 + 红斜纹 + `!`，tooltip 写 `MEDIA MISSING …`，**不删你的片段数据**（播不了但在）；
3. Assets 窗 Project 档的卡片挂 `MISSING` + 回形针；顶部横幅 `N missing`（其它档位一键切过去）；
4. `Relink…` = 选文件 → 重新入库 → **按哈希精确匹配**（原件或它新算出的代理）。对不上就明说
   `Different bytes — expected …, got …`，什么都不改。`force` 留给未来的"就用这个新文件"，UI 暂不给；
5. **没做** `Pin into document`（把字节塞回 .cud）：那是"我要把工程发给别人"的逃生口，A6 之后再说。

---

## 5. 图层：彻底物化（C）

### 5.1 形状

```
图层 = { buffer: <hash>, source: <hash> }  +  内存里的 raster buffer（编辑期）
```

- `buffer` = 这一层"此刻的样子"（含 transform 以外的像素编辑：笔刷、橡皮、生成、合成）；
- `source` = 它是从哪张资产来的（导入的图 / detailer 产出 / processor 产出 / 从 staging 拖来 / detect）；
- **两者都在 Assets 窗里可查**：搜一张原图 → 看到"被 层 Red 用着（source）"；看一层的 buffer → 看到它被哪一层引用。

### 5.2 什么时候写盘（物化点，只有五个）

1. `.cud` 保存 / Save As / 自动存
2. 导出 PNG
3. 生成结果落成新图层
4. 图层导出到工作区（`exportLayerToStaging`，`H:13350-13363`）
5. 智能图层的 source 被替换（重跑）

**其余任何时刻都不碰磁盘**——拖图层、按 Alt 移动、调滑块、undo/redo 全都只动内存 buffer。
这条不守住，`data/assets/` 一天会被写爆。

### 5.3 两个副作用（都是好事）

- **内容寻址 = 天然 copy-on-write**：两个图层引用同一 hash 是安全的，因为"改"永远是"写一个新 hash"，不会原地改别人那份。
- **旧版本自动成为孤儿**：保存十次留下十个 buffer hash，但只有最后一个被 manifest 引用 ⇒ 前九个落进 `Session`，由 GC 收掉（§6），不需要版本管理代码。

### 5.4 `.cud` 里的变化

`layers[i].image: <assets 表序号>` → `layers[i].buffer: <hash>`；新增 `layers[i].source: <hash>`（可空）。
v5 读取时 `image` 序号 → 对应 assets 行 → hash。

---

## 6. 引用图与 GC

**引用来源（漏一个就会删错）：**
文档 manifest（`assets[]` ∪ `layers[].buffer/source`）· staging 索引 · fx `params.*.asset` ·
interface `image_keys` / `context_image_key` / `context_mask_key` · `original_key` / `detailed_key` ·
finish 选中 · 时间线 `clip.asset` · 打开的提示词 chip · library 成员表。

**规则（按 §1 的权威归属分三类）：**

| 资产 | 被文档引用 | 只在本机无引用 |
|---|---|---|
| 图像 | 库副本**可删**（文档自带）；文档里的那一份是权威 | 进 `Session`，超过 `N` 天（默认 7）自动删 |
| 音视频 | **永不自动删**（唯一副本），只能用户显式删（先列引用） | 进 `Session`，过期自动删 |
| library 成员 | **永不自动删** | — |

- 保存后顺手扫一次差集：本 doc 上一版 manifest 引用过、这一版不再引用、且没有别的 doc 引用 → 立即进入 session 待收（不必等 7 天）。
- GC 写日志 `data/sampler/asset_gc.log`（删了哪个 hash、多大、为什么），便于排查"我的图怎么没了"。

---

## 7. 落地顺序（重排：C 彻底 ⇒ A4/A5 合并）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **A0 仓库** | `libs/asset_store.py`（put/get/path/thumb/index/lock/别名迁移）；`/api/assets`、`/api/asset/<hash>`、`/api/asset_media/<hash>`、`/api/asset_import`、`/api/asset_thumb`；`/api/global_assets` 改视图（字段不变） | 同图两次入库只落一份；老库（`md5(base64)` 命名）能被认领 |
| **A1 窗升级** | scope×kind 过滤、used-by、字节来源徽章、两种删除、统一 `x-asset` 拖拽 | 窗里能看到 A0 的图并拖进 staging/图层/时间线 |
| **A2 staging 变索引** | `add_staging` 拆成 put+index；`src` 改 URL；`get_asset_image` 按 hash 缓存；`staging_reorder`；guidance 改"槽" | 拖图、run 一次 detailer、Finish、chip 全正常 |
| **A3 特效绑 asset** | `fxMapSource` 用 hash；删 `map_N`/`fxMapPool`；选择器换资产清单；存档只写 `asset` | **删掉索引条目后特效照常**；存档往返不丢贴图 |
| **A4 图层物化 + v6**（合并做） | `{buffer, source}`；五个物化点；`.cud` v6（去重、图像内嵌、音视频引用）；v5 迁移 | 存→重开像素一致；同图在文件里只有一份；`.cud` 体积不涨（应下降） |
| **A5 音视频并入** | 入轨走 store；片段记 `asset`；`media/vid` 变兼容 resolver；relink 面板 | 拖片/抽帧/播放正常；缺文件时走 relink 而不是崩 |
| **A6 GC 与守护** | 引用图、三类规则、日志、三条 CDP 探针（存→开→像素一致 / 删索引不影响 fx / 换机器缺音视频走 relink） | 长跑一周磁盘不失控；无"图莫名消失" |

> A0→A1→A2 是"看得见"的三步；A3 独立一波、风险最低；A4 是动 `.cud` 的大手术，但**与前几步无耦合**，可以并行准备。

---

## 8. 风险（v3 更新）

| # | 风险 | 处理 |
|---|---|---|
| 1 | 物化点选错 ⇒ 拖动就写盘 | 只认 §5.2 五个点；undo 永不碰 store |
| 2 | 图像"文档权威 + 库缓存"两边都在 ⇒ 用户困惑"删哪个" | 卡片显示 `内嵌/本机/缺失`；删除分两种并说明后果 |
| 3 | 音视频被 GC 删掉 ⇒ 工程播不了 | 被引用即永不自动删；GC 只碰 `Session` |
| 4 | `.cud` 内嵌图像 ⇒ 文件大 | 同 hash 去重（今天图层与图池是各存一份，统一后应更小）；不内嵌音视频 |
| 5 | hash 校验失败 ⇒ 文件损坏 | 按 hash 报错、列受影响层/特效，绝不"随便用一张" |
| 6 | 特效读档贴图丢失 | 图像内嵌 ⇒ 几乎不会缺；缺则 "depth gone"（沿用现有降级） |
| 7 | 页面/宿主/桌面壳三份 staging 副本 | A2/A4 收口；桌面壳跟随或退役（`client/kolid_client.py:1573-1612`） |
| 8 | 老库文件名 `md5(base64)` | A0 别名迁移（两种哈希都算） |
| 9 | `context` 伪 id | 保持特例，不资产化（`S:211-213`） |
| 10 | `staging_guidance` 跨实例单例 | 保留为"槽"，文档写明最后写入者胜 |
| 11 | 提示词 token 变长 | chip 插入为主；v5→v6 一次性改写 |
| 12 | 窗里资产太多 | 缩略图 + 懒加载 + 分页（`/api/asset_thumb`） |

---

## 9. 不做

- 图层变"活绑定"（改资产直接改图层）——只做 source 记录 + 物化快照。
- 把 `context` 资产化。
- 音视频也内嵌（你已明确排除）；只保留手工 `Pin into document` 这一个逃生口。
- 多实例并发写同一份库（沿用"最后写入者胜"）。

---

## 附：A0 落地记录（代码已写）

| 位置 | 内容 |
|---|---|
| `libs/asset_store.py` | 仓库层：`records/get/resolve/path_of/put_bytes/dataurl_bytes/sniff_ext/set_library/thumb_path/stats`。id = 文件名 stem；表 = `data/assets/_index.json`（只装库成员 + 名字/标签/来源）；缩略图缓存在 `data/assets/.thumbs/` |
| `snapshot_sampler_node.py` | `GET /api/assets`（scope/kind/q/refresh）、`GET /api/asset/<ref>`、`GET /api/asset_media/<ref>`（Range）、`GET /api/asset_thumb/<ref>?w=`、`POST /api/asset_import`；`/api/global_assets` 改为从仓库取（旧字段一字未改，新增 `hash/inLibrary/thumb`）；删掉 node 里那份扩展名常量（扩展名→种类只剩 asset_store 一处判定） |
| `temporary/_test_asset_store.cjs` | 仓库层自测 **45 项**（内容寻址/去重/表持久化/前缀解析/缩略图/dataURL/魔数/stats/同 hash 只许一个文件），全部在临时目录跑，不碰真库 |
| `temporary/_probe_assets_api.cjs` | 活服务端到端验收（重启 ComfyUI 后跑），跑完自己删探针图 |

**首次认领（迁移）**：表第一次落盘时，把库里已有的货全部登记成库成员（`origin:'legacy'`，名字沿用文件名）——
它们本来就是"全局库"，不认领的话窗里会显示成 154 件临时产物、而 Library 一栏空着。只做一次：
表一旦存在就不再自动加，否则"把某件移出库"会被下一次读取原样加回来。实测 154 件 / 16 ms，表 22 KB。

**决定与实现的一处偏差（记录在案）**：不做"全库重算 md5"。`data/assets` 里现在有 1.4 GB 视频，扫一遍算哈希是几秒的阻塞；
而**文件名 stem 本身就是内容摘要**（老货是 md5(base64)，新货是 md5(bytes)），已满足 id 需要的三条性质（唯一 / 由内容决定 / 永不重编号）。
代价只剩"同字节两种摘要各存一份"，极少见且不伤正确性。

### A1 落地记录（已跑验收）

| 位置 | 内容 |
|---|---|
| `libs/asset_store.py` | 加 `delete()`：删字节 + 缩略图 + 表记录（**还没有引用检查** —— 引用图在 A4/A6，眼下由窗里的确认框兜底）；加 `update_meta()`（改名/标签**不改作用域**，session 图改名不会顺手升成库成员）；表行加 `member` 字段，`records()` 的 `inLibrary` 由它派生，非成员缺元数据时 `origin` 落成 `session` |
| `snapshot_sampler_node.py` | 加 `POST /api/asset_update`（改名/标签，只动表，走 `update_meta`）与 `POST /api/asset_delete`；`/api/global_assets` 增加 `displayName / origin / tags`（老字段一字未改），窗里因此能显示改名后的名字与真实来源 |
| `video/Assets.tsx` | 整窗重写：四档 scope（All/Library/Project/Session）、kind 过滤、搜索、`＋ Import`（图片走 `/api/asset_import`）、**统一卡片**（旧的 `AssetCard`/`GlobalCard` 两套合并成一套）、字节来源徽章、`used-by`（片段按 src 认）、改名/删除/收进工程 |
| `video/Timeline.tsx` | 接受 `application/x-asset`（{id,url,name,kind}）—— 仓库卡片拖上轨道仍走 `importSource`（先入库再落片段） |

**清单来源的一处取舍**：窗里读的是 `/api/global_assets` 而不是 `/api/assets`。原因是前者带
`hasAudio/duration`（ffprobe 探过，卡片上要显示时长、悬停扫片要按时刻取格），而后者刻意不探（A0 的
`/api/assets` 是给后续 staging/特效解析用的轻量清单）。四档 scope 与搜索都在本地过滤 —— 一百多件的
过滤比一次往返便宜。`/api/assets` 仍是 A2 起的主入口。

**作用域的一处修正**：`All` 只列仓库，`Project` 才列本工程资产表。否则一件"既被收进工程、又是库成员"
的视频会在 `All` 里画两遍，而 `Library + Session == All` 这条最便宜的验收判据也会失真。

**字节来源徽章**：A1 只会出现 `LOCAL`（都在仓库里）。`IN DOC` 要等 A4 把文档 manifest 读出来，
`MISSING` 要等 A5（音视频不内嵌）与 A6（引用图）才有真实来源；卡片已经按三态画好，接线即可。

**验收**（独立宿主 `temporary/_serve_node_probe.py`，跑的是新代码）：
- `temporary/_probe_assets_ui.cjs` 14/14：四档作用域都在、默认 All、卡片有内容与 LOCAL 徽章、
  Library+Session==All、Session 卡片来源正确、Project 空态、搜索收敛、拖拽载荷带 `application/x-asset`，
  末尾清理"基线之外新增的 session 资产"（开文档会发布 Guidance 卡，见 A4 的已知代价）；
- `temporary/_probe_assets_manage.cjs` 22/22：导入/去重/缩略图/改名/删字节+缩略图+表记录，
  以及"session 改名不会升成库成员"；
- 截图 `temporary/_probe_assets_ui.png`（1500 × 3400，154 件库 + 1 件 session）。

### A2 落地记录（后端已跑验收）

| 位置 | 内容 |
|---|---|
| `SnapshotDetailerSamplerServer.add_staging` | 每张图在存 tensor 的同时**写进仓库**：`tensor_to_base64` 出字节 → `asset_store.put_bytes(origin='staging', library=False)`；条目新增 `asset`（hash）与 `url`（`/api/asset_media/<hash>`） |
| `get_staging_list` | 投影里加 `asset` / `url`，老字段一个不动 |
| `types.ts` | `StagingItem` 加 `asset?` / `url?` |
| `asset_store.put_bytes` | `library=False` 时**不查表**、按已知事实拼返回 —— 图池每条都要调它，不能让一次 154 文件的目录扫描压在热路径上 |
| `asset_store._ensure_index_exists` | **测试逼出来的一个坑**：首次写入就落一张空表，否则"库里还没表时写进一张 session 图"会被下一次读取的首次认领误升成库成员 |

**A2 特意只做了一半（`src` 仍是 base64）**：页面保存 `.cud` 时写的是 `stagingItems[].src`，
现在把 `src` 换成 URL 就会把 `http://…` 写进文档（自包含当场破掉）。所以 `src → url` 这一步和
v6（manifest 存 hash）绑在一起做（A4）。这一版的语义是：**字节的权威已经搬到仓库，`src` 只是过渡期的
一份副本**；条目上的 `asset` 才是正身。

**验收**：`temporary/_probe_staging_assets.cjs` 16/16 —— 上传后条目带 `asset`/`url`、`src` 仍是
dataURL、尺寸在、仓库里是非库成员（`origin: session`）、按 url 取到同一份字节、从图池移除后字节仍在
（等 A6 GC）。

**已知代价**：run / detailer / processor 的每张产出都会落一份 session 资产，A6 的 GC 之前会一直长。

### A3 落地记录（已跑验收）

| 位置 | 内容 |
|---|---|
| `nodes/web/fx/maps.js` | 引用新增 `{asset, name}`（仓库哈希正身）；`fxMapSource` 按 `asset → /api/asset_media/<hash>` 解析；老 `{key: staging_N/map_N}` 保留为**只读**兼容（图池条目优先用 A2 的 `url`，不再搬 base64）；新增 `fxImportMap()`：文件选择的字节走 `/api/asset_import`（`library: true, origin: 'map'`） |
| `nodes/web/fx/ui.js` | 选图器新增 **Library 组**（`/api/global_assets` 里的图片，按 `{asset: hash}` 绑定）；Workspace 卡片优先用 `url`；`From file` 改为先入库再绑定（不再 mint `map_N` / data URL） |
| `nodes/web/blend_node.html` | `cudEffects` 写 `{asset: <文件资产表序号>, hash: <仓库哈希>, name}`；文件资产行同时记 `hash`。**双字段是有意的**：老读端按数字 `asset` 找内嵌 blob，新读端按 `hash` 走仓库，v5 文件双向可读。`restoreFxMaps` 优先认 `hash`，并把数字 `asset` 收成 `fileAsset` 兜底 |

**读档规则**：`hash` 在仓库里 ⇒ 直接按 URL 取字节（删掉图池索引/本地池都不影响）；
`hash` 不在（换机器）则仍有文件内嵌 PNG 的 `fileAsset`，v6/A4 再把它落回仓库。
老档的 `asset` 是数字、没有 `hash`，仍走"解码 → 本地池"那条兼容路。

**验收**：`temporary/_probe_fx_assets.cjs` 22/22 —— 哈希解析、图池老引用按 url、解码出 `<img>`、
读档保留哈希与 fileAsset、选图器 Workspace+Library 两组、点仓库卡真的换绑；并真建一层 + Warp 特效
跑 `buildCudBlob → decodeCud → restoreFxMaps`，确认存档里同时有数字 `asset` 与 `hash`、且没有 `map_N`。

### A4 落地记录（已跑验收）：图层物化 + `.cud` v6

| 位置 | 内容 |
|---|---|
| `nodes/web/blend_node.html` · `CUD_VERSION` | 5 → **6**。读端 `header.version > CUD_VERSION` 仍然拒绝（"newer than this workbench"） |
| `buildCudBlob()` | 图层行同时写老数字 `image`（v5 读端照旧按序号找内嵌 blob）与新 `buffer` / `source`（仓库哈希）。`buffer` = 这一行表面的哈希（别名合并之后再回填），`source` = 图层最初绑定的资产（`l.asset`，没有就是 `null`） |
| `buildCudBlob()` · staging | 图池写成**索引**：`{id, name, place, hidden, asset}`，不再写 `src`。Guidance 卡（`GUIDANCE_CARD_ID`）不入档——它是文档的派生画面，重开由画布重算 |
| `buildCudBlob()` · 去重 | 资产表编码完成后按真实哈希合并：同哈希只留一行，`alias` 表把 `records / layerSetList / attrTable / composite / maskSurface` 里的数字引用定向改写（不重排其它 id）。特效贴图的 `hash` 按**实际内嵌字节**回写（`storeHash` 直取、否则 `assetImportBytes` 现算） |
| `assetImportBytes()` / `assetFetchBlob()` | 哈希由宿主给：`POST /api/asset_import {library:false, origin:'cud-save'/'cud-load'}` 返回的 `id` 就是 `md5(bytes)`（内容寻址，天然去重），**客户端不算 md5**；`Blob` / `Uint8Array` 两种入参 |
| `storeCudImages()` | 读档物化：v6 行先在仓库里探（`/api/asset/<hash>`），缺了才把内嵌字节导回去，并**核对**返回 id 与文件里的 `hash`；对不上按"文件损坏"报错，绝不换一张。v5 行没有 `hash` 就当场补一个，下次保存即成 v6。没有宿主时整段跳过——payload 里的字节照样能画，打开不失败 |
| `openCudDocument()` | v6 staging 只带 `asset`：先从内嵌 `blobs` 取字节，取不到再 `assetFetchBlob(hash)`，补成宿主认识的 `src`；`asset` 原样保留，下次保存仍写 hash |

**物化点**：像素只在五处离开内存——保存（本步）、导出 PNG、生成落层、图层导出到工作区
（`exportLayerToStaging → /api/staging`）、source 被替换。**编辑期 raster 只在内存**：拖图层、
undo/redo 都不写盘（否则每次手势都是一次全分辨率 PNG 落盘）。

**v5 兼容与降级**：v6 文件给老读端留了完整的老字段（数字 `image`、内嵌 payload、特效双字段），
v5 文件在新读端打开后保存即升级。**离线/宿主没起时整份文件退回 v5 形状**（不写 `hash`/`buffer`/
`source`，staging 保留 `src`）——保存永远不因为"算不出哈希"而失败，代价只是这一次没享受到去重。

**验收**：`temporary/_probe_cud_v6.cjs` 24/24 —— v6 字段齐（`buffer`/`source`/`hash`）、同像素只留
一行资产、staging 行里没有 `src`、保存→重开像素逐点相等、`source` 与 `buffer` 往返存活、二次保存
仍是 v6、v5 文件照旧打开且像素一致。跑完把源图与本次新增的 session 字节一起收掉。

**复验时抓到的存储竞态（已修，`libs/asset_store.py`）**：`buildCudBlob` 是并发问哈希的，两个内容
相同的图层（探针里的两张 "Same"）会同时打 `/api/asset_import`。老 `put_bytes` 是"查存在 → 写临时
→ `os.replace`"，第二个线程的 replace 撞上正在被读/刚被换掉的目标文件，Windows 报 PermissionError，
接口回 500 → 整份文件降级成 v5（探针 14/24）。同一次复验还暴露了第二个洞：A4 导入的名字一律是
`role-id.png`，但字节可能是 GIF/JPEG 原件，老逻辑**名字优先**于魔数，于是同一个 hash 落成
`.gif` + `.png` 两份，`records()` 数出两件货、`get()` 只碰得到一份。修法：

- 魔数先于名字：`ext = ext or sniff_ext(bytes) or name 的后缀`。
- 落盘前先找同 stem 的**任何**扩展名文件（`_existing_stem`），有就沿用 —— 同一 hash 永远一个文件。
- `_atomic_write` 抛 OSError 时，只要目标文件已经存在就算成功（内容寻址下写同一份字节是幂等的）。

复验：A4 24/24 连跑两次、A3 23/23、A2 16/16、A1 管理 22/22、仓库自测 45/45（新增"同字节只许一个
文件"三条），库回到 **154 库成员 + 1 session**。顺手修了 `_test_asset_store.cjs` 一条过期断言：
"撤销库成员"从 A1 起不再删表行（只把 `member` 落下），旧断言还要求它消失。

**已知代价（留给 A6）**：
- 保存会物化像素进仓库（这是 A4 的本意），旧 session 资产要等 A6 GC 才回收。
- 页面一加载就会恢复/建文档 → Guidance 卡被发布进图池，A2 之后它同时是一份 session 资产。
  内容是内容寻址的，同一份画面只会有一份（不是每次开页新增一份）；它**不进 `.cud`**，
  重开由画布重算。A1 UI 探针原先会把它留在库里，现在按"基线之外新增"清理（14/14）。
- `asset_store.delete()` 仍无引用检查：`.cud` 的 manifest 已经是一张引用图，A6 要把
  "打开中的文档 + 时间线 + 特效槽"接进来再拦删除。

### A5 落地记录（音视频入仓：存储层 + 模型层）

一句话：**音视频的字节也搬进 `data/assets/` 了**；`media/vid/` 降级成"派生缓存 + 老 URL 的兼容落点"；
时间线片段与资产从此记 `{asset, play}` 两个哈希。入轨、抽帧、缩略条、合并、preset/接口抽帧全部走同一个
resolver —— **URL 面没变**（`/api/vid_media/<file>` 仍然有效、老 `.cud` 里那些 `sha1_名字.mp4` 照旧能播）。

| 位置 | 内容 |
|---|---|
| `_vid_ingest()` | 原件按内容进仓库（`put_bytes(origin='vid-ingest')`，`md5` 命名）；要转码时把代理也整份进仓库（`origin='vid-proxy'`，`meta.proxyOf` 指回原件）。回包多两个字段 `asset` / `proxy`，`src` 仍是 `/api/vid_media/<文件名>` |
| `_vid_media_path(ref)` | **唯一的媒体 resolver**：`/api/vid_media/<file>`、`/api/asset_media/<hash>`、裸文件名/裸哈希、老绝对路径，统一解析成盘上路径。先看 `media/vid`（老货 + 波形/抽帧/merge 缓存），再看仓库。找不到就是 `None` —— 调用方报 404 / 画缺失，绝不"随便找一个同名的" |
| `/api/vid_media` · `/api/vid_frame` · `/api/vid_strip` · `/api/vid_merge` | 全部改走 resolver；`/api/vid_media` 继续带 Range（`<video>` 的 seek 靠它）。`d=global` 仍被接受但不再需要 |
| preset / 接口抽帧 | `video_inputs[].file`、`mask_input.file` 也走 resolver —— 源在仓库里，ffmpeg 直接读，不绕浏览器 |
| `/api/global_assets` | 代理折叠：`meta.proxyOf` 让原件那一条带上 `playHash`，代理自己**不出卡片**（内部件）。新增 `meta` 字段透传 |
| `records()` / `update_meta()` | 记录带 `meta` 字典；`update_meta(ref, name, tags, meta)` 支持合并机械字段（`proxyOf` 住这儿）。`member` 语义不变 |
| `ingestFile()` | 回 `{src, asset, play}` |
| `VidAsset` / `VidClip` | 新增 `asset?` / `play?`；`placeImport` / `importToTrack` / `placeAsset` 全程携带（音画拆分的两段都带） |
| `normalizeVidProject()` | 读档时按哈希重建 `src`（`play` 优先）：**`src` 是 `blob:` 或空、但有哈希的段不再被剪掉**；既没 src 又没哈希的老 blob 段照旧丢 |
| 仓库卡片拖拽 | `application/x-asset` / `x-vid-global` 载荷带 `asset` / `play`；claim 用 `playHash` 作为可播地址 |

**三个口径**：`asset` = 原件哈希（身份，relink 按它精确匹配）；`play` = 可播字节哈希（转码过的源指向
代理片）；`src` = "怎么播"的 URL，丢了/换端口就由前两个重建。

**验收（全绿）**

| 探针 | 结果 | 覆盖 |
|---|---|---|
| `temporary/_probe_vid_assets.cjs` | **35/35**（连跑两遍） | 入仓/不入 media/vid、Range、frame/strip 两种引用面、同字节同哈希、音频、转码代理 + `playHash` 折叠、merge 吃仓库源、删除后 404、无残留、无重名 stem |
| `temporary/_probe_vid_playback.cjs` | PASS | 真 Chrome 里 `<video>` 播仓库里的文件（476×720，`readyState=4`） |
| `temporary/_test_vid_model_a5.cjs` | **12/12** | 放置/资产表/`placeAsset` 携带哈希；`blob:` 按 `play`→`asset` 重建；活 src 不动；无哈希 blob 段仍丢；Layer 段存活 |
| `temporary/_probe_vid_store_ui.cjs` | **13/13** | 真页面：切 Video → 仓库卡 → Claim（`asset` 落进工程资产）→ 拖上视频轨（片段带哈希）→ 重开无异常、仓库仍在 |
| `temporary/_test_asset_store.cjs` | 45/45 | 仓库层（`records` / `update_meta` 改动后复验） |
| `temporary/_probe_assets_ui.cjs` · `_probe_assets_manage.cjs` | 14/14 · 22/22 | A1 两扇窗（Assets.tsx 改动后复验） |

收尾：库 **155**（154 库成员 + 1 session）、`data/assets` 155 个货 + `_index.json`、无同 stem 重名、
`media/vid` 里的探针临时文件已清。

**这轮抓到的三个真 bug**

1. `_vid_strip()` 把缩略帧写在**源文件旁边**（`os.path.dirname(path)`）。源搬进仓库之后，抽 4 帧 =
   往 `data/assets/` 里铺 4 个 jpg，还会被清单数成 4 件新货（探针"no probe assets left"当场抓到）。
   改成派生缓存永远落 `media/vid/`。
2. `normalizeVidProject` 的 `recover()` 第一版是"没哈希就退回原 src"，于是早就该死掉的 `blob:` 段
   被原样复活。改成"blob 且没哈希 ⇒ 空串 ⇒ 丢弃"（模型测试第 6 条抓到）。
3. `put_bytes(library=False)` 不落元数据行：拖进来的片子清单里只剩 `<md5>.mp4`，用户认不出。
   入库时补一行名字 —— 只在"非库成员、且没被改过名"时写，绝不覆盖别人给库成员起的名字。

**剩下的（A5 未完成部分 → A6 前置）**

- **Run 产物仍留在 `media/vid` 当缓存**（`_vid_encode`、`_vid_merge` 的输出）：它们是时间线片段的
  `src`，A6 的引用图要先能看见它们，再谈回收或入仓。
- `asset_store.delete()` 仍无引用检查；A6 接"打开中的文档 + 时间线 + 特效槽"后改成"有引用就拒绝"。

### A5b 落地记录（relink：缺失标记 + 按哈希挑回原件）

一句话：**打开工程与每次改动后，工程引用的每个哈希都问一遍仓库**。缺的在三个地方同时露出来 ——
时间线段红斜纹 + `!`、Assets 窗的 `MISSING` 徽章、顶部横幅 —— 并且**只标记、不改数据**：片段的
`asset` / `play` / `src` 一个都不动。挑回原件走 `vid.relink(hash, file)`：字节重新入库，`md5` 对得上
（或对上新算出的代理哈希）才改绑；对不上就报 `Different bytes — expected …, got …`。

| 位置 | 内容 |
|---|---|
| `/api/assets_exist` | `{ids:[hash…]} → {ok, have[], missing[]}`（去重保序）。**只读**：不写盘、不建记录、不改表 |
| `vidAssetRefs(p)` | 工程引用的全部哈希（`p.assets` + 片段的 `asset`/`play`）—— 缺失检查与 relink 共用这一份 |
| `relinkAsset(p, from, to, playHash)` | 把引用 `from` 的行改指 `to`，`src` 同时换成 `/api/asset_media/<play>`。老工程里指 `/api/vid_media/<旧文件名>` 的段，relink 后自动换成仓库地址 |
| `VidController.missing` | `ReadonlySet<string>`，宿主问过仓库的结论 |
| `VidController.relink(hash, file, force?)` | 入库后比对哈希：命中原件、或命中它新算出的代理 → 改绑 + 重问；不命中 → `{ok:false, error}` |
| 触发时机 | 工程变化（250ms 去抖，按哈希清单签名去重）、删完仓库件（`recheckMissing()` 强制重问）、窗口重新获得焦点（别的窗口/宿主删了东西） |
| 时间线 | 片段红边 + 45° 红斜纹 + `!`，tooltip 追加 `MEDIA MISSING …`；Layer 段与占位段不参与（它们没有仓库来源） |
| Assets 窗 | Project 档卡片挂 `MISSING`（`byteFrom:'missing'`）+ 回形针；资产表里没有对应行的"孤儿缺失"补一张卡；顶部横幅 `N missing` + 一键切到 Project |
| 错误面 | `err`（动作失败）与 `listErr`（清单拉取失败）分开存 —— 否则重新拉清单会把"挑错文件"的提示当场抹掉（探针抓到的那个 bug） |

**为什么咬死"精确哈希"**：同一份字节 ⇒ 同一个 `md5` ⇒ 同一件货。放宽成"名字/时长差不多"就等于
悄悄换素材。`force` 参数留着给以后"就用这个新文件"的显式逃生口，UI 目前不给。

**验收（全绿，各连跑两遍）**

| 探针 | 结果 | 覆盖 |
|---|---|---|
| `temporary/_probe_vid_relink.cjs` | **30/30** | 端点语义（空表/重复/空白/未知哈希）、只读性（文件数与记录数不变）、删掉→404→挑回同一哈希→**老 URL 复活**、不同字节不同哈希、只丢了代理也能认出并重建 |
| `temporary/_probe_vid_relink_ui.cjs` | **26/26** | 真页面：claim → 拖轨 → 用 UI 的删除按钮删掉 → 片段红边/标题/`!`、横幅、`MISSING` 卡 → 挑错文件被拒且数据不变 → 挑对文件复原（`src` 换成 `asset_media`，清单里回来） |
| 回归 | 12/12 · 35/35 · 13/13 · 14/14 · 22/22 · 45/45 | vid 模型、A5 后端、仓库 UI、A1 两扇窗、仓库层 |

**A5 至此完成**（存储层 + 模型层 + relink）。A6 才是"引用图 + 有引用就拒绝删除"。
