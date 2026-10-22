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

### 4.4 缺失与 relink（B 决策必须配的一步）

音视频不内嵌 ⇒ 把 .cud 挪到别的机器/仓库，它们一定缺。打开时：

1. 窗顶一条横幅：`3 media files are missing（2 video · 1 audio）` + 一个列表；
2. 每项可 `Relink…`（选文件 / 选文件夹，先按 hash 精确匹配，再按 `name + duration` 模糊提示）；
3. 或者 `Pin into document`：把这份字节真的写进 .cud（`length > 0`），从此不再缺——这是给"我要把工程发给别人"的逃生口；
4. 时间线上缺的片段画红条纹 + 播不了，但**不删你的片段数据**（只标记缺失）。

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
| `temporary/_test_asset_store.cjs` | 仓库层自测 29 项（内容寻址/去重/表持久化/前缀解析/缩略图/dataURL/魔数/stats），全部在临时目录跑，不碰真库 |
| `temporary/_probe_assets_api.cjs` | 活服务端到端验收（重启 ComfyUI 后跑），跑完自己删探针图 |

**首次认领（迁移）**：表第一次落盘时，把库里已有的货全部登记成库成员（`origin:'legacy'`，名字沿用文件名）——
它们本来就是"全局库"，不认领的话窗里会显示成 154 件临时产物、而 Library 一栏空着。只做一次：
表一旦存在就不再自动加，否则"把某件移出库"会被下一次读取原样加回来。实测 154 件 / 16 ms，表 22 KB。

**决定与实现的一处偏差（记录在案）**：不做"全库重算 md5"。`data/assets` 里现在有 1.4 GB 视频，扫一遍算哈希是几秒的阻塞；
而**文件名 stem 本身就是内容摘要**（老货是 md5(base64)，新货是 md5(bytes)），已满足 id 需要的三条性质（唯一 / 由内容决定 / 永不重编号）。
代价只剩"同字节两种摘要各存一份"，极少见且不伤正确性。

### A1 落地记录（代码已写）

| 位置 | 内容 |
|---|---|
| `libs/asset_store.py` | 加 `delete()`：删字节 + 缩略图 + 表记录（**还没有引用检查** —— 引用图在 A4/A6，眼下由窗里的确认框兜底） |
| `snapshot_sampler_node.py` | 加 `POST /api/asset_update`（改名/标签，只动表）与 `POST /api/asset_delete` |
| `video/Assets.tsx` | 整窗重写：四档 scope（All/Library/Project/Session）、kind 过滤、搜索、`＋ Import`（图片走 `/api/asset_import`）、**统一卡片**（旧的 `AssetCard`/`GlobalCard` 两套合并成一套）、字节来源徽章、`used-by`（片段按 src 认）、改名/删除/收进工程 |
| `video/Timeline.tsx` | 接受 `application/x-asset`（{id,url,name,kind}）—— 仓库卡片拖上轨道仍走 `importSource`（先入库再落片段） |

**清单来源的一处取舍**：窗里读的是 `/api/global_assets` 而不是 `/api/assets`。原因是前者带
`hasAudio/duration`（ffprobe 探过，卡片上要显示时长、悬停扫片要按时刻取格），而后者刻意不探（A0 的
`/api/assets` 是给后续 staging/特效解析用的轻量清单）。四档 scope 与搜索都在本地过滤 —— 一百多件的
过滤比一次往返便宜。`/api/assets` 仍是 A2 起的主入口。

**字节来源徽章**：A1 只会出现 `LOCAL`（都在仓库里）。`IN DOC` 要等 A4 把文档 manifest 读出来，
`MISSING` 要等 A5（音视频不内嵌）与 A6（引用图）才有真实来源；卡片已经按三态画好，接线即可。
