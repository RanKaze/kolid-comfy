# Staging → Assets：把图池改成资产的索引

> ⚠️ **已被 `docs/assets_single_store_design.md`（v2）取代**。本文是 staging-first 版本，保留作为现状盘点参考（§1 的 touchpoint 清单仍然有效）。

> 目标（用户原话）：**staging 不再单独存储，所有东西都存在 assets 里，staging 只是它的索引；特效不再索引 staging，而是索引 assets。**
> 本文只做设计，不动代码。行号以当前工作区为准（`snapshot_sampler_node.py` 8516 行 / `blend_node.html` 790KB / `ui/sampler_node/src`）。

---

## 0. 一句话结论

现在有 **三套互不相通的"资产"**，staging 是第四套；真正缺的不是"把图搬进 assets"，而是 **给资产一个 id 和一张表**。
`.cud` 里那张 `header.assets`（id=序号、带 role、payload 内联）**已经是资产表**了——缺的是：① 它是文件内部的、运行时不可见；② 全局库 `data/assets/` 反而没有 id、没有表（目录即索引）；③ staging 自己拿着 `staging_N` + 一份 base64，跟谁都对不上号。

所以正确的形状是：

```
   字节层（唯一仓库）        资产表（id + 元数据）          索引层             引用层
   data/assets/<md5>.<ext>   ├─ global: data/assets/_index.json      ┌ staging: [ref…]
   （全局 / 工程 共用一份）   └─ project: .cud header.assets         │ （有序、可有 hidden/place）
                                                                ├ prompt <image_id:…>
                                                                ├ 端口图 image_keys
                                                                ├ finish 选中
                                                                └ fx 绑定贴图（本来就有 asset 字段）
```

---

## 1. 现状地图

### 1.1 四套"存图的地方"

| # | 名字 | 物理落点 | id | 元数据 | 作用域 | 谁在用 |
|---|---|---|---|---|---|---|
| ① | **全局资产库** | `data/assets/<md5-of-base64>.<ext>` | **无**（文件名即身份） | 无表，`os.listdir + stat + ffprobe` 现算（`S:593-641`） | 跨文档、跨机器不随 .cud | Assets 节点、工作台 Assets 窗、`/api/global_assets` |
| ② | **.cud 文件级资产表** | .cud payload（PNG 字节） | `id = assetList.length`（序号） | `{id, role, w, h, length}`（`H:11539-11559`） | 单份文档，随文件走 | layer 像素 `image` / `masklayer` / `composite` / fx 贴图 `map` / `3d` / `pose` |
| ③ | **视频工程资产** | `data/sampler/media/vid/<hash>.<ext>` | `as_xxx` uid | 在 `video.assets`（.cud 里） | 单份文档 | 时间线 / Assets 窗 |
| ④ | **staging（图池）** | **不落盘**：进程内存 `list[dict]` + `id → tensor`（`S:1879-1884`） | `staging_N` 自增；`staging_guidance` 保留位 | `{id,name,src(dataURL),width,height,place,hidden}`（`S:2072-2080`） | 一次工作台会话；可见条目以 base64 内联进 `.cud` | 提示词 chip / 端口图 / finish / processor / fx / 视频拖入 |

**关键事实：**
- staging **没有落盘目录、没有元数据 json**，`data_dir()` 里没有 `staging` 这一档（`libs/data_paths.py:25-48`）。
- 后端解析 staging id 只有一个函数 `get_staging_image(sid)`（`S:2231-2261`），**返回 tensor 不返回路径**；tensor 被淘汰时从条目自带 `src`（base64）重新解码。
- **容量硬上限 40 条，先进先出，hidden 不豁免**（`S:2086-2089`）——长跑会把 `Original` / 细节图 / 接口中间图挤掉。
- 宿主镜像**在入口就把 hidden 滤掉**（`A:564-574`），所以工作区条带 / 所有 picker 只看得到用户主动拖入的图；`.cud` 存的也正是这份可见集合。

### 1.2 staging 的完整 touchpoint 清单

#### 后端 `nodes/workbench/snapshot_sampler_node.py`

| 位置 | 干什么 |
|---|---|
| `1879-1884` | `staging_items` / `_staging_tensors` / `_staging_counter` 初始化 |
| `2045-2089` | `add_staging(image, name, place, hidden, sid)`：铸 `staging_N`、存 tensor、base64、40 条 FEFO |
| `2092-2097` | `get_staging_list()` 投影给宿主 |
| `210-224` | `IMAGE_ID_TOKEN_RE`、`CONTEXT_IMAGE_ID='context'`、`GUIDANCE_STAGING_ID='staging_guidance'` |
| `355-385` | `parse_prompt_image_refs()`：`<image_id:x>` → `<image N>`，解不出的删掉并记 missing |
| `2231-2261` | `get_staging_image(sid)`：tensor → 兜底 base64 解码 |
| `3331-3333` | `GET /api/staging`（全池，含 hidden） |
| `3735-3797` | `POST /api/staging`；`replace:true` = **整池换水**（清可见、留 hidden、按 `ids[]` 原样落回） |
| `3799-3811` | `POST /api/staging_remove {id}`（无守卫，可删 guidance/hidden） |
| `3813-3839` | `POST /api/guidance_card`：固定 id 原地换像素 / 撤回 |
| `3841-3889` | `POST /api/resize_image`：读源 id → 产出新可见条目 |
| `3891-3906` | `POST /api/load_from_assets`：全局资产 → 可见 staging（`Asset #N`） |
| `3908-3954` | `POST /api/pose_estimate {source:'staging', id}` |
| `3316-3329` | `GET /api/result`：暴露 `original_key` / `detailed_key` |
| `3384-3398` | `GET /api/global_assets` / `/api/global_media/<name>`（资产库，第 ① 套） |
| `3674-3701` | `POST /api/select_image` / `POST /api/finish`：消费 id → 当前图 / 最终输出 |
| `3620-3628` → `7644, 7747-7758` | `image_keys{port: id}` → `port_overrides`（MASK 端走亮度转 mask） |
| `5876-5922` | interface block 的 `image_keys` / `context_image_key` / `context_mask_key` |
| `6894-6931` | detailer 的 `context_reference_keys` → `get_staging_image` → `memoized(('ctxref', key,…))` |
| `4966-4987` | Generate Text 的 Ref Image |
| `7917-7949` | 离线 processor 产出 IMAGE/MASK → `add_staging(hidden=True)` + `interface_result_meta` |
| `8061-8065` | run 起始图 → `Original`（hidden） |
| `8319-8330` | detailer 产出 → `Detail #N`（hidden，带 `place`） |
| `8502-8512` | finish：按 key 逐个 `get_staging_image` |

#### 宿主 `ui/sampler_node/src/App.tsx`

| 位置 | 干什么 |
|---|---|
| `327 / 418-419` | `staging` state + `stagingRef` 镜像 |
| `564-576` | `refreshStaging`：`GET /api/staging` → **滤掉 hidden** |
| `578-586` | `queueStaging`：所有写操作串行化（整池换水 vs 拖文件 vs 卡片不能乱序） |
| `588-597` | `stageUpload` → `POST /api/staging {images,names}` |
| `599-606` | `stageRemove` → `/api/staging_remove` |
| `608-614` | 每次变化把 **整份（含 base64）** postMessage 给页面 |
| `755-784` | detailer 跑完 → refresh → 按 `detailed_key` 取条目 → 注入图层 |
| `811-862` | 种子画布：读**完整**池（含 hidden），优先 `name==='Original'`，带 `place` |
| `1039-1089` | processor 输入图 → `POST /api/staging {hidden:true}` 拿 id → `image_keys` |
| `1118-1120` / `1204-1211` | `blend-staging-changed` / `blend-staging-remove`（**已是死分支**，仅老壳在用） |
| `1135-1148` | iframe 首帧补齐 `blend-config.staging` |
| `1168-1194` | `blend-staging-upload`：普通追加 / `replace:true` 整池换水 → 之后补发 `blend-guidance-republish` |
| `1195-1203` | guidance 卡 → `/api/guidance_card` |
| `1432-1458` | processor 结果回传：按 `interface_result_meta.key` 在**原始列表**里找条目 |
| `1746-1756` / `1852-1888` | finish 选中键 / ref 弹窗选中键 |

#### 页面 `nodes/web/blend_node.html`（790KB 手写单文件，仍是权威）

| 位置 | 干什么 |
|---|---|
| `13304` | `let stagingItems = []` —— 页面级图池镜像 |
| `10965 / 10973-10989` | 切文档换池（`entry.staging`）、`postStagingSync()` |
| `11716-11745` | `.cud` header：`staging`（滤掉 guidance 卡）+ `assets`（资产表）+ `attributes` |
| `11539-11590` | `buildCudBlob` 的 `addAsset(role, source, w, h)`：**id = 表序号**，role ∈ `image/masklayer/composite/map/3d/pose` |
| `11646-11665` | `cudEffects`：fx 贴图**存档时写成 `params[slot].asset = <表序号>`**（同时保留 `key`） |
| `13306-13317` | `postStagingSync()`：`replace:true` + `ids[]` 整池上传 |
| `13327-13337` | `appendImageIdChips`：`<image_id:…>` 追加到 Extra Prompt |
| `13350-13372` | `exportLayerToStaging` / `addStagingAsLayer`（`find(x => x.id === id)` → `addLayer({src, smart:true})`） |
| `13514-13534` | processor 输入行：`staging = {options, cur}`（按 `stagingItems` 拼） |
| `13599-13615` | `processorCollectInput`：`choice==='staging'` → 直接取 `it.src`（dataURL） |
| `13705-13746` | `finishProcessorRun`：`dst==='staging'` → `blend-staging-upload` 复制一条**可见**条目 |
| `13759-13777` | 收 `blend-config` / `blend-staging` |
| `13802-13808` | `blend-guidance-republish` |
| `9031-9058` | 画布 drop `application/x-blend-staging`（固定落 Layers） |
| `9298 / 9618` | `extra_prompt` 随 run payload 送后端（含 `<image_id:…>`） |

#### 特效 `nodes/web/fx/`

| 位置 | 干什么 |
|---|---|
| `maps.js:5-9` | 注释写明：**key 有两个来源** —— 图池 id（`staging_N`）与本地池 `map_N` |
| `maps.js:18` | `fxMapPool`（`map_N → {name, src}`） |
| `maps.js:46-52` | `fxMapSource(ref)`：先 `stagingItems.find(id===ref.key)`，再 `fxMapPool.get(ref.key)` |
| `maps.js:99-104` | `fxAddLocalMap`：文件选的贴图进本地池 |
| `maps.js:155-176` | `restoreFxMaps`：读档时 `asset` → 解码 → 进本地池 → ref 换成新 `map_N` |
| `ui.js:581` | 贴图选择器的 `groups: [{title:'Workspace', items: stagingItems.filter(...)}]` |

#### 工作台 `ui/sampler_node/src/workbench/`

| 位置 | 干什么 |
|---|---|
| `staging.tsx`（510 行） | Staging 那一格：Extra Prompt 编辑器 + chip + 图池条 + Blend/Tag/Cancel |
| `staging.tsx:482-485` | 条目起拖 `application/x-blend-staging` = **字符串 id** |
| `registry.tsx:29,79-81` | 格子能拿到的宿主事实：`staging` 镜像 + `stageUpload/stageRemove` |
| `layerRow.tsx:27-28, 789-814` | 图层列表接图池 drag → `layer-from-staging {id, stack}` |
| `processor.tsx:186-200` | 输入行多出的 Staging 下拉 → `processor-staging {port,id}` |
| `pipeline-graph-editor.tsx:120,237,281-297` | interface 节点：`image_keys[port]` / `context_image_key` / `context_mask_key`，`value=s.id` |
| `EditPhase.tsx:2261` | `graphStaging = staging.map(s=>({id,name}))` |
| `EditPhase.tsx:3026-3085` | Finish 弹窗：全镜像网格 + `selectedKeys` 就是 staging id |

#### 视频侧 `ui/sampler_node/src/workbench/video/`

| 位置 | 干什么 |
|---|---|
| `model.ts:44,63` | 资产 `origin: 'staging'`（**只是来源标签**，不指向池 id） |
| `model.ts:219-220` | `VidController.staging`（同一份宿主镜像） |
| `Timeline.tsx:939-943` | 拖进轨道 → `find(s=>s.id===stagingId)` → `importSource(item.src,…,'staging')` |
| `Assets.tsx:398-411` | 拖进资产窗 → `collectSource(item.src, …)` |
| `EditPhase.tsx:1743-1745` | 把 `staging` 塞进 `vidCtl` |

#### 桌面壳 / 文档

| 位置 | 干什么 |
|---|---|
| `client/kolid_client.py:1564-1612, 1646-1657` | 内嵌 JS 的**第二份** staging 镜像（`t.staging`），含 guidance 卡去重与清池 |
| `docs/ui-probe.md`、`tools/ui_probe_mcp.py` | 这里的 `staging` 是 **dock 单元 id**，与图池无关（别改错） |

---

## 2. 目标模型

### 2.1 三层职责

1. **字节层（唯一仓库）**：`data/assets/<md5-of-bytes>.<ext>`。
   全局与工程共用同一个目录 → 同一张图在两个文档里出现也只有一份字节（内容寻址天然去重）。
2. **资产表**：
   - `scope: 'global'` → `data/assets/_index.json`（hash → name/kind/w/h/origin/created），是 Assets 节点与 Assets 窗的清单来源；
   - `scope: 'project'` → `.cud` 的 `header.assets[]`（沿用现有表，行里补 `hash`），随文档走。
3. **索引层**：staging = **有序引用表**，只存 `{asset, name?, hidden?, place?, added}`，**不存字节**。

```
AssetRecord = {
  hash: '9f2c…',            // 身份 = 内容；也是文件名
  name: 'Detail #12',
  kind: 'image' | 'video' | 'audio' | 'map' | 'mask' | 'decal' | 'composite' | 'pose' | '3d',
  w, h, duration?, hasAudio?,
  scope: 'global' | 'project',
  origin: 'upload'|'asset'|'run'|'detailer'|'processor'|'detect'|'layer-export'|'guidance'|'map',
  created: ts,
}
StagingRef = { asset: '<hash>', name?: string, hidden?: boolean, place?: {...}, added: ts }
```

### 2.2 id 方案：**内容哈希**（推荐，见 §5 决策 A）

- `asset id = hash 的前 10~12 位`，文件全名 `<full-md5>.<ext>`。
- 好处：
  1. **跨文档/跨会话天然稳定**，`.cud` 读回来不需要重映射任何引用（提示词 token、fx 的 `asset`、端口 `image_keys` 全部原样有效）；
  2. 去重免费（同一张图拖两次 = 一条字节 + 两个索引条目）；
  3. `.cud` 的内嵌字节读回时，`import → hash` 得到的 id 与文件里写的一致，不需要改写整份文档。
- 代价：
  1. **原地换像素**（guidance 卡）不能再改 id → 保留 `staging_guidance` 这个**槽**：槽 id 不变，槽指向的 asset 变（`slot:guidance → hash`）；
  2. 老全局库文件名是 `md5(base64)` 而非 `md5(bytes)`（`assets_node.py:176-188`）→ 需要一次**别名迁移**（扫描时两种哈希都算，命中即认领）；
  3. token 变长（`<image_id:9f2c1a3b4d>`），用户多数是点 chip 插入，可接受。

### 2.3 保留的语义（不资产化）

- `context` 是**伪 id**，解码时直接展开成 `<image 1>`（`S:211-213, 372-375`）——它不在任何池里，保持特例。
- **图层自带像素**（`H:11679` `addAsset('image', l.img…)`）：图层的字节已经是文件级资产了，staging 不需要参与。
- `place`（Recover Crop 关闭时的贴回矩形）与 `hidden` 属于**索引条目**，不属于资产。

### 2.4 顺带解决掉的三件事

1. **整池换水**（`replace:true`）可以整个删掉：索引本来就是"每份文档一份"，切文档 = 换索引视图，不需要重传字节。
2. **宿主镜像不再搬 base64**（`A:608-614` 全量推送）→ 只推 refs + 缩略图 URL。
3. **40 条 FEFO** 换成"索引上限 + 资产 GC"：资产按引用计数活，不再误杀还在被引用的图。

---

## 3. 迁移方案（分 6 步，每步可独立验收）

> 原则：**每一步都让系统处于可运行状态**，旧行为由兼容层兜住；不做大爆炸式切换。

### P0 — 资产表落地（纯新增，不改任何现有路径）

- 新增 `libs/asset_store.py`：
  - `put_bytes(bytes, ext) -> hash`（写 `data/assets/<md5>.<ext>`，已存在则直返）；
  - `path_of(hash)`、`meta_of(hash)`、`list(scope, kind)`、`alias_legacy(hash_base64, hash_bytes)`；
  - `_index.json` 读写（带锁；并发写用原子替换）。
- 新增路由：`POST /api/asset_import`（base64 或原始 body）、`GET /api/asset/<id>`（元数据）、`GET /api/asset_media/<id>`（字节，Range 复用 `_send_media_file`，`S:644`）、`GET /api/assets?scope=&kind=`。
- `/api/global_assets` 改成该表的一个视图（**保持响应字段不变**，前端零改动）。
- **验收**：拖一张图进全局库两次 → 磁盘一个文件、表里一条；Assets 窗/工作台 Assets 窗显示如常；Range 播放正常。

### P1 — staging 变索引（后端语义 + 兼容双写）

- `add_staging(image, …)` 拆成两步：`put_bytes → hash`，再 `index_asset(hash, name, hidden, place)`；条目变成
  `{id: hash, name, src: '/api/asset_media/<hash>', width, height, hidden, place}`（**`src` 变成 URL**）。
- `get_staging_image(sid)` → `get_asset_image(asset_id)`：从磁盘读 + 按 hash 缓存 tensor（比现在按 id 缓存更省）。
- `staging_guidance` 改成"槽 → hash"的映射，`/api/guidance_card` 只换槽指向。
- `/api/staging` 的 `src` 由 dataURL 改 URL；**同时**保留 `srcData`（可选，`?dt=1` 时才给）给还没改完的调用方。
- 上限从 40 条换成：索引条数上限（配置）+ 未引用资产 GC（见 P5）。
- **验收**：run 一次 detailer → 产出可在 Finish 里选、可作 ref、可作为图层素材；提示词 chip 正常；`<image_id:…>` 解析一致。

### P2 — 特效改索引 assets（用户明确要求的那一条）

- `fxMapSource(ref)`：`ref.asset` 命中资产表 → `src = /api/asset_media/<asset>`；**删掉 `stagingItems.find` 与 `fxMapPool`（`map_N`）**。
- `ui.js` 贴图选择器：`groups` 从 `stagingItems` 换成资产清单（`kind` 过滤到 image），"From file" 走 `POST /api/asset_import`（`scope:'project', origin:'map'`）。
- `cudEffects`：只写 `{asset: hash, name}`，不再写 `key`；`restoreFxMaps` 简化成"asset 不在本地 → 读文件内嵌字节导入 → id 天生相同，无需改写"。
- 老档兼容：读到 `{key:'staging_N', asset:<序号>}` 时按文件资产表解析（现有 `restoreFxMaps` 那段逻辑保留一版）。
- **验收**：绑一张图做 displacement → 存档 → 重开 → 读数正常；把那张图从 staging 删掉 → 特效仍正常（因为它绑的是资产，不是索引条目）。**这条正是用户要的行为。**

### P3 — `.cud` v6

```diff
 header = {
   format:'cud', version:6,
-  staging: [{id:'staging_3', name, src:<base64>}],
+  assets:  [{hash, role, w, h, length}],          // 沿用 v5 的表，行里加 hash
+  staging: [{asset:'9f2c…', name, place, hidden}], // 纯索引，不再带字节
   attributes: [...]
 }
```
- 读取：v5 的每条 `staging[].src` → `import → hash` → 索引指向它；同时把 Extra Prompt 里 `<image_id:staging_N>` 按位置**改写**成新 id（一次性、在 decodeCud 里完成）。
- 写入：默认仍**内嵌**被引用资产的字节（保证换机器能开）；新增 `embed:'reference'` 选项给"只在本机用"的工程，文件体积可降一个量级。
- **验收**：v5 老档能开、提示词 chip 不丢图、fx 贴图不丢；新档在两个仓库/两台机器间拷来拷去都能开（默认模式）。

### P4 — 宿主 / 工作台 / 视频收尾

- `App.staging`：条目带 `src`（URL）+ `asset`；`refreshStaging` 不再滤 hidden（hidden 变成"没有索引条目"，本来就不在列表里）。
- 删除 `queueStaging` 的整池换水分支与 `postStagingSync`；`blend-staging-upload` 只保留"追加/删除"，`replace` 退役。
- `blend-staging` 推送改成 refs（无 base64）；页面 `.cud` 保存时按需 `fetch` 字节（或继续用 `<img>` + canvas 取，现有 `surfaceToPng` 已具备）。
- processor：UI 名字保持 "Staging"（它指"工作区里那一条"，是 UX 概念），但传下去的值是 asset hash。
- 视频：`origin:'staging'` → `'asset'`；`Timeline/Assets` 的拖拽载荷带 `{asset, url}`；`importSource` 已经能接 URL（全局资产那条路就是这么走的），不再走 dataURL。
- `client/kolid_client.py` 的镜像同步更新（或直接声明该壳退役）。
- **验收**：切文档不再重传字节；大工程切 tab 不再卡；拖图进时间线仍能入库。

### P5 — 清理与守护

- **GC**：`scope:'project'` 且 `origin ∈ {run, detailer, processor}` 的资产，若无任何引用（文档索引 ∪ fx refs ∪ 时间线 ∪ 端口）且超过 N 天 → 删除。启动时跑一次、关文档时跑一次。
- **引用计数**必须算上：文档索引、fx `params.*.asset`、interface `image_keys`、`original_key/detailed_key`、`finish_selected_keys`、视频段落的资产。
- **孤儿索引**：索引指向的资产不存在 → 显示 "image gone"（沿用 fx 现有的降级话术），不要静默换图。
- 探针（CDP）补三条：存档往返后 chip 图仍在 / fx 贴图仍在 / 删索引条目不影响 fx。

---

## 4. 风险与坑（全部来自代码证据）

| # | 风险 | 证据 | 处理 |
|---|---|---|---|
| 1 | 40 条 FEFO **会淘汰 hidden**，资产化后可能删掉仍被引用的图 | `S:2086-2089` | 换成引用计数 + GC（P5） |
| 2 | `.cud` 现在把图池 base64 **内联在 header**，改成 URL 后保存需要"取字节"这一步 | `H:11737` | P3 前保留 dataURL；P4 用 fetch/canvas 取 |
| 3 | 宿主每次池变动都**全量推 base64** 给页面 | `A:608-614` | P4 改 refs + 缩略图 URL |
| 4 | `staging_guidance` 是**全局单例、不随文档走**，多开实例最后写入者胜 | `S:218, 3813-3839`; `H:11734-11737` | 保留为"槽"，明确它是跨文档共享的 |
| 5 | `context` 是伪 id，不在池里 | `S:211-213` | 不资产化，保持特例 |
| 6 | 全局库文件名是 `md5(base64)`，与 `md5(bytes)` 不同 | `assets_node.py:176-188` | 别名迁移（P0） |
| 7 | 视频 `origin:'staging'` 只是标签，真实落盘是 `media/vid` 的副本 | `model.ts:44,63`; `Timeline.tsx:939-943` | 改标签即可；若将来改为直接引用资产，GC 必须把时间线算进引用 |
| 8 | 页面 `stagingItems` 与宿主镜像有两份，还有第三份在桌面壳 | `H:13304`; `A:327`; `client:1573-1612` | P4 收口；桌面壳要么跟随要么退役 |
| 9 | `layer-from-staging` 载荷是**裸字符串 id** | `staging.tsx:482-485`; `layerRow.tsx:812` | hash 也是字符串，保持协议不变，只改解析 |
| 10 | `blend-staging-changed` / `blend-staging-remove` 是**死分支** | `A:1118-1120, 1204-1211` | 顺手删掉 |
| 11 | staging id 被 **Extra Prompt 文本**引用（不是结构化字段） | `S:355-385` | id 换成 hash 后 token 变长；v5→v6 的改写必须在 decodeCud 里一次做全 |
| 12 | 本机任意页面可 `POST /api/staging` 换池（CORS `*`、无鉴权） | `S:2912-2920` | 不在本次范围，但资产接口同样暴露，建议加 token |

---

## 5. 需要你拍板的四个决策

**A. 资产 id 用什么？**
- **（推荐）内容哈希** `9f2c1a3b4d`：免重映射、天然去重、跨文档稳定；代价是 guidance 卡要改成"槽"、老库要别名迁移。
- 表序号（沿用 .cud 现在的 `id = 序号`）：id 短、原地换像素天然支持；代价是每次读档都要**全量改写**所有引用，漏一处就是死引用。

**B. "所有东西"的边界在哪？**
- **（推荐）run / processor 的中间产物也进资产库**，但标 `scope:'project'` + `origin`，不进全局库 UI，靠 P5 的 GC 收。
- 只把用户主动拖入的东西资产化：更干净，但 detailer/detail 结果仍然只能活在内存池里，等于没合并。

**C. staging 这一层要不要留？**
- **（推荐）留**：用户要"被 staging 索引"，说明它还有"有序工作区 + hidden/place"的价值。它变成一个纯引用表，不再是存储。
- 彻底取消 staging：所有 UI 直接读资产库 → 会和全局库的"跨文档共享"语义打架（工作区应该是本工程的）。

**D. `.cud` 还内嵌字节吗？**
- **（推荐）默认内嵌**（可移植），另给 `embed:'reference'` 给本地大工程；两者都靠 hash 保证引用不变。
- 一律引用（文件变小、但换机器就缺图）。

---

## 6. 明确**不**在本次范围

- 图层像素从"文档资产表"搬进全局库（图层是自己的字节，不该跨文档共享）。
- 视频工程资产（`media/vid`）并入全局库（它语义是"这工程自己入库的片子"）。
- `context` 伪 id、`staging_guidance` 的跨实例并发（已知残留）。
- 全局资产的**命名/打标**体系（现在只有 hash 文件名；引入表后可以顺手做，但不必这一轮做）。
