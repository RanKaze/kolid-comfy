# SnapshotDetailerSamplerNode 架构文档

## 功能概览

SnapshotDetailerSamplerNode 是一个事件驱动的交互式图像细节修复节点，集成 mask 绘制、tag 标注、prompt 选择、采样执行、图像混合、上下文管理和子图执行于一体。

## 架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ComfyUI 执行引擎                                       │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │              SnapshotDetailerSamplerNode.sample()                      │  │
│  │                                                                       │  │
│  │  ┌─────────────────────────────────────────────────────────────┐      │  │
│  │  │            SnapshotDetailerSamplerServer                     │      │  │
│  │  │            (事件驱动: action queue + threading.Event)        │      │  │
│  │  │                                                             │      │  │
│  │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │      │  │
│  │  │  │ Mask Server  │  │Prompt Server │  │  Main Server     │  │      │  │
│  │  │  │ (image_node) │  │ (prompt_node)│  │  (MainHandler)   │  │      │  │
│  │  │  │ port ~8080   │  │ port ~8500   │  │  port 8700-8800  │  │      │  │
│  │  │  │              │  │              │  │                  │  │      │  │
│  │  │  │ /mask        │  │ /select_     │  │ /api/config      │  │      │  │
│  │  │  │ /grow        │  │   prompt     │  │ /api/status      │  │      │  │
│  │  │  │ /detect      │  │ /prompts_data│  │ /api/history     │  │      │  │
│  │  │  │ /clear       │  │ /lora_data   │  │ /api/run_detailer│  │      │  │
│  │  │  │ /image_data  │  │ /window_closed│  │ /api/finish      │  │      │  │
│  │  │  │ /window_closed│ │              │  │ /api/select_image│  │      │  │
│  │  │  │              │  │              │  │ /api/submit_mask │  │      │  │
│  │  │  │ mask_node    │  │ prompt_node  │  │ /api/context_   │  │      │  │
│  │  │  │   .html      │  │   .html      │  │   preview        │  │      │  │
│  │  │  │ (iframe)     │  │ (iframe)     │  │ /api/tag_previews│  │      │  │
│  │  │  │              │  │              │  │ /api/run_tag     │  │      │  │
│  │  │  │              │  │              │  │ /api/blend_layers│  │      │  │
│  │  │  │              │  │              │  │ /api/execute_    │  │      │  │
│  │  │  │              │  │              │  │   interface      │  │      │  │
│  │  │  │              │  │              │  │ /api/debug_     │  │      │  │
│  │  │  │              │  │              │  │   recover_data   │  │      │  │
│  │  │  │              │  │              │  │ /api/has_mask   │  │      │  │
│  │  │  │              │  │              │  │ sampler_node    │  │      │  │
│  │  │  │              │  │              │  │   .html (SPA)    │  │      │  │
│  │  │  └──────┬───────┘  └──────┬───────┘  └────────┬────────┘  │      │  │
│  │  │         │                 │                    │           │      │  │
│  │  │         ▼                 ▼                    ▼           │      │  │
│  │  │  ┌──────────────────────────────────────────────────────┐  │      │  │
│  │  │  │              _on_mask_set callback                     │  │      │  │
│  │  │  │  mask_server → pipeline.mask                           │  │      │  │
│  │  │  │  prompt_server → selected_prompts/loras               │  │      │  │
│  │  │  │  main_server → put_action (action queue)              │  │      │  │
│  │  │  └──────────────────────────────────────────────────────┘  │      │  │
│  │  └─────────────────────────────────────────────────────────────┘      │  │
│  │                                                                       │  │
│  │  ┌─────────────────────────────────────────────────────────────┐      │  │
│  │  │                    主循环 (while not finished)                │      │  │
│  │  │                                                             │      │  │
│  │  │  wait_for_action() → dispatch:                              │      │  │
│  │  │  ├── run_detailer → _run_detailer()                          │      │  │
│  │  │  ├── select_image → _switch_image()                         │      │  │
│  │  │  ├── execute_interface → _execute_interface()                 │      │  │
│  │  │  ├── finish → break                                          │      │  │
│  │  │  └── window_closed → break                                   │      │  │
│  │  └─────────────────────────────────────────────────────────────┘      │  │
│  │                                                                       │  │
│  │  finally: server.stop() → 关闭 mask/prompt/main server               │  │
│  │  return (pipeline,)                                                   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                              前端 (sampler_node.html SPA)                      │
│                                                                             │
│  App.tsx (状态管理 + 轮询)                                                   │
│  ├── /api/config (初始化)                                                   │
│  ├── /api/status (轮询 detailStatus, 500ms)                                 │
│  ├── /api/history (轮询 history, 1500ms)                                    │
│  ├── handleTabChange (mask→tag/draw: sync-mask; prompt→draw: sync-prompt)  │
│  ├── handleRunDetailer (POST /api/run_detailer)                             │
│  ├── handleFinish (POST /api/finish → finished page)                       │
│  └── handleSetContext (POST /api/select_image → reload-image to mask iframe)│
│                                                                             │
│  EditPhase.tsx (Tab UI)                                                     │
│  ├── Mask tab    → iframe(mask_node.html)  [always mounted, display:none]  │
│  ├── Tag tab     → TagCard × 3 (mask/covered/full) + tag result bar        │
│  ├── Prompt tab  → iframe(prompt_node.html) [always mounted, display:none] │
│  ├── Draw tab    → Context Preview + Sampling Parameters + Results + Debug  │
│  │   ├── Context: Image preview + Mask preview (vertical)                  │
│  │   ├── Params: AddNoise, StartStep, EndStep, Pixels, Align, CropReserve  │
│  │   ├── Enable Edit (IOSToggle) → Context Reference (IOSToggle) + Picker  │
│  │   ├── Results: Original + Detailed cards (click → setContext)            │
│  │   └── Debug: Background + Image + Mask + Refs (inline) + crop info       │
│  ├── Blend tab   → iframe(blend_node.html 图层系统) + layer picker modal     │
│  ├── Context tab → History gallery (hover preview + select)                 │
│  └── Interface tab → Port display + injection options + Execute button      │
│                                                                             │
│  前端→后端通信:                                                               │
│  ├── fetch (REST API to Main Server)                                       │
│  ├── postMessage (parent↔iframe: sync-mask, sync-prompt, reload-image,    │
│  │                 mask-confirmed, prompt-confirmed, mask-data, blend-select,│
│  │                 blend-image-selected, blend-layers-data, blend-layers-   │
│  │                 result)                                                  │
│  └── Finish dialog → multi-select history images → POST /api/finish        │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                           _run_detailer 数据流                                │
│                                                                             │
│  pipeline.mask (user_mask)                                                  │
│  │                                                                          │
│  ▼                                                                          │
│  binarize (>0 → 1.0)                                                       │
│  │                                                                          │
│  ▼                                                                          │
│  expand_mask(grow=32, blur=32)                                             │
│  │                                                                          │
│  ▼                                                                          │
│  crop_mask(image, expanded_mask, reserve=crop_reserve)                      │
│  │  → cropped_image, cropped_mask, crop_info                               │
│  ▼                                                                          │
│  limit_pixels(cropped_image, cropped_mask, pixels, align)                  │
│  │  → resized_image, resized_mask, resize_info                             │
│  ▼                                                                          │
│  [block 循环前] [任一 block enable_edit] 按架构 patch:                     │
│  ├─ Krea2: apply_model_patch → next_pipeline.model +                      │
│  │  config["model_negative"] (共享 pixel_state; get_model_clip 的 clone    │
│  │  自动携带补丁闭包, get_conditioning 写入的 source_images 经             │
│  │  pixel_state 到达 forward, 激活像素路径/stride1)                        │
│  └─ Flux2Klein: apply_model_patch (no-op, 原生 ref 路径)                  │
│  │                                                                          │
│  VAEEncode(resized_image) → tmp_latent                                     │
│  │                                                                          │
│  ├── get_model_clip(patched model, clip, loras) → model_to_use(带补丁)     │
│  │                                                                          │
│  ├── [Krea2] pixel_state 动态参数（逐 block 覆写, forward 动态读取）:     │
│  │   fit_mode = edit_mode (fit|crop 编辑几何)                              │
│  │   ref_boost / ref_boost_a (注意力增强, 默认 4.0/1.0)                    │
│  │   ref_boost_mask = resized_mask (enable_ref_boost_mask 开启时,         │
│  │     即 context mask 限定增强区域)                                       │
│  │                                                                          │
│  ├── [context_reference] VAEEncode(history_image) → reference.reference_  │
│  │                        latents.append()                                  │
│  │                                                                          │
│  ├── get_conditioning(positive/negative) [edit 开启时注入, 否则纯文本]      │
│  │   ├── Flux2Klein: reference_latent=tmp_latent, reference_image=None     │
│  │   └── Krea2: 纯 grounded encode (对齐 Krea2EditGroundedEncode)          │
│  │       positive = prompt + 源图 (VLM 语义路径, conditioning 不带 latent)  │
│  │       negative = 空 prompt + 同图 (匹配训练 unconditional)              │
│  │       VLM 源图缩放上限 = block 级 grounding_px (默认 768, 正/负共用)    │
│  │                                                                          │
│  ├── [Krea2 edit] 节点级 pixel_state 注入 (对齐 source patch 数据流):     │
│  │   source_latents = [tmp_latent.samples] (latent fallback)               │
│  │   source_images 由 get_conditioning side-channel 写入 (像素路径)        │
│  │   pre_encode_sources(@tmp_latent 网格, 采样外 VAE 预编码)                │
│  │   [edit off] 清空残留 → 原生 forward                                    │
│  │                                                                          │
│  ├── _ksampler(model, positive, negative, tmp_latent, start/end_step)     │
│  │   forward 读 pixel_state: source_images+vae → 像素路径 (fit/crop)      │
│  │   否则 source_latents → latent 路径; 均无 → 原生 forward                │
│  │  → sampled_latent                                                       │
│  │                                                                          │
│  ├── VAEDecode(sampled_latent) → decoded_image                            │
│  │                                                                          │
│  ├── recover_size(decoded_image, resize_info, resized_mask)                │
│  │  → recovered_image, recovered_mask                                      │
│  │                                                                          │
│  ├── recover_crop(original_image, recovered_image, crop_info, recovered_   │
│  │                mask, method='mask_blend')                               │
│  │  → final_image, final_mask                                              │
│  │                                                                          │
│  ├── [debug] debug_mask = user_mask[crop_region] (NOT expanded)           │
│  │                                                                          │
│  └── next_pipeline.mask = user_mask (保留原始, 不用 expand+recover)        │
│                                                                             │
│  return next_pipeline, original_image, final_image, debug_data             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                        Mask 同步 & 持久化机制                                  │
│                                                                             │
│  用户绘制 mask (mask_node.html)                                              │
│  │  maskDataCanvas (offscreen, display尺寸)                                │
│  │                                                                          │
│  ├─ [切tab: mask→tag/draw] handleTabChange → postMessage(sync-mask)       │
│  │  └→ syncMask() → POST /mask → handleMask → set_mask → pipeline.mask   │
│  │     (resize canvas尺寸→image尺寸, 保留alpha, 更新 _initial_mask)        │
│  │                                                                          │
│  ├─ [Confirm Mask] sendMask() → POST /mask + postMessage(mask-confirmed)  │
│  │  └→ App.tsx 收到 mask-confirmed → setMaskConfirmed + 跳转 tab           │
│  │                                                                          │
│  ├─ [切回 mask tab] reload-image → loadImage() → /image_data              │
│  │  └→ initial_mask (尺寸匹配才返回) → 恢复 mask 到 maskDataCanvas         │
│  │                                                                          │
│  └─ [context image 切换] _switch_image()                                   │
│     ├─ 尺寸相同 → mask preserved (mask_server.set_image, 不 clear)        │
│     └─ 尺寸不同 → mask_server.clear() + pipeline.mask = None              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                        _execute_interface 数据流                              │
│                                                                             │
│  InterfacePackageNode → pkg (sub_prompt)                                    │
│  │                                                                          │
│  ├── 注入 prompt tab 的 lora/prompt 到 injected_pipeline.__prompt_tab__   │
│  │                                                                          │
│  ├── [exec_options.image_source_key] 从 history 加载图                     │
│  │   └─ 校验与当前 context 同尺寸                                          │
│  │                                                                          │
│  ├── [exec_options.operation='crop']                                       │
│  │   └─ expand_mask + crop_mask → injected_img/mask, pending_crop          │
│  │                                                                          │
│  ├── InterfaceExecutor.execute(pkg, manual_values)                         │
│  │   └─ lazy evaluation from End node backwards                             │
│  │                                                                          │
│  ├── [pending_crop] recover_crop (uncrop 回原图尺寸)                       │
│  │                                                                          │
│  └─ results → add_history → auto-set context                                │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                        生命周期 & 已知问题                                     │
│                                                                             │
│  sample() 入口:                                                             │
│  1. pipeline.copy()                                                         │
│  2. server.start() (3个子服务器: mask/prompt/main)                          │
│  3. webbrowser.open(sampler_node.html)                                      │
│  4. while not finished: wait_for_action() → dispatch                       │
│  5. finally: server.stop()                                                  │
│  6. finish_selected_keys → get_history_image → pipeline.image              │
│  7. return (pipeline,)                                                      │
│                                                                             │
│  IS_CHANGED: float("nan") — 交互式节点标准模式                               │
│                                                                             │
│  已知问题:                                                                   │
│  - finish 后自动重开: IS_CHANGED=nan 可能导致 ComfyUI 重新执行              │
│    (需确认是否为 ComfyUI auto-queue 或代码内部循环)                         │
│  - mask 同步: 仅在 mask→tag/draw 切换时同步 (非实时)                        │
│  - prompt 同步: 仅在 prompt→draw 切换时同步 (非实时)                        │
│  - _run_detailer 保留原始 user_mask (不用 expand+recover 后的)             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 功能点清单

### 1. Mask 绘制 (mask_node.html iframe)
- 画笔/橡皮 (Binary/Linear/Exponential 模式, Alt+右键拖拽调尺寸)
- Strength/Center/Edge/Gamma 参数
- PS-style stroke (strokeCanvas + snapshotCanvas)
- Grow (像素级 dilate, 保留 alpha)
- Detector (SAM3 Grounding, Threshold/Strength/Dilation/Crop/DropSize/Prompt/FillMask)
- Clear / Full
- Display Alpha (mask 可见度)
- Confirm Mask (同步 + 跳转)
- Mask 持久化 (尺寸相同则保留, reload-image 恢复)
- Mask 同步 (切 tab 时 POST /mask)

### 2. Tag 标注
- 3 种模式: Mask Tag (裁剪到 mask), Covered Tag (mask 内保留外白), Full Tag (全图)
- 有 tagger 时自动显示
- 结果通过 _parse_raw_prompt 解析后发送到 prompt iframe

### 3. Prompt 选择 (prompt_node.html iframe)
- Prompt/Lora/Prefab 选择
- Program 系统 (JS 代码片段, Monaco Editor)
- Lora trigger words 自动追加
- Lora slider config
- 切换到 Draw 时自动同步 (sync-prompt → /select_prompt)

### 4. Draw 采样
- Context 预览 (Image + Mask 竖向排列)
- Sampling Parameters: AddNoise, StartStep, EndStep, Pixels, Align, CropReserve
- Enable Edit (IOSToggle)
  - Context Reference (IOSToggle) + Reference Image 选择器
  - Krea2: apply_model_patch (fit_mode, ref_boost, pixel_state)
  - Flux2Klein: apply_model_patch
- Run Detailer (POST /api/run_detailer)
- 进度条 (ComfyUI ProgressBar hook → /api/status 轮询)
- 结果展示 (Original + Detailed cards)
- Debug 面板 (Background + Image + Mask + Reference Images + crop info)

### 5. Blend 图层混合
- blend_node.html iframe (图层系统: 可排序图层列表, 每行 4 个缩略图, 顺序固定 0. 全图 → 1. 原图 → 2. decal → 3. 蒙版)
- 行内缩略图: 0 全图 = 该图层在当前 transform 与画布尺寸下的样子 (图片 + decal 合成后经蒙版裁切, 再按 transform 摆到画布比例的小图里, 与最终合成一致), 蒙版/decal 绘制与 transform 拖拽时实时重绘, 点它即选中该图层的 transform; 1 原图 = 图层源图 (点它同样进入 transform); 2 decal / 3 蒙版 = 对应绘制面 (点它即切到该绘制目标)
- 图层选择器 (多选 history 图片, 新图层置于顶层)
- 画布尺寸: 初始取最底层图片的像素尺寸; 在 Canvas 面板用弹窗 (Canvas Size…) 手动设置后即与图层解耦, 之后增删/重排图层都不再改变画布; 清空所有图层后回到跟随模式; 新图层默认拉伸铺满
- Canvas Size 弹窗 (PS 式): 宽/高输入 + 比例锁 (默认锁定, 按当前值取基准; 解锁后可自由改比例), Match Bottom Layer 一键取底层尺寸, 上限 16384 px/边 与 40 MP; 开关 "Scale layers with the canvas" — 开 = 图层随新尺寸等比拉伸 (归一化 transform 不变), 关 = 图层的像素尺寸与位置保持不变、以画布中心为锚 (新区域透明, 画布变小则裁切)
- 每个图层两张绘制面 (都在图层自身像素空间, 都随 transform 一起缩放/旋转/平移): 蒙版 (覆盖率, 白色 = 可见) 与 decal (叠在图片之上的颜色面)
- 单层结算顺序: 原图 + decal (straight alpha source-over) → **[特效链]** → 乘蒙版 → 按 transform 采样进画布 → 层间 source-over 合并; 蒙版因此同时裁切图片与 decal
- 文本层 (smart text) 的盒子 = **字形盒 + padding 环**: `measureTextNatural` 报的就是这个显示盒 (descriptor 自身单位, 按书写字号), transform 存它、`syncTextBuffer` 把它 1:1 烘成画布像素缓冲。`padding` 是四边等宽的透明留白 (默认 0, 与字号同为 layer px), 语义 = **框往外扩、字形尺寸不动**: patchTextLayer 的 `k = 画布px / 旧盒` 反比逻辑天然成立 (盒与 transform 同比例长, 于是 `sy = 盒高/字号` 不变 ⇒ 字形一像素都没变, 环却涨了出去), 不需要为它写任何特例。为什么值得有: 特效链被钉在图层自己的网格里 (契约①), 外阴影/泛光在紧包围盒上必然被边切到, padding 就是给它们买余量; 顺带治了 宋体/楷体 这类 ascent+descent > 1.2 em 的下伸部被字形盒裁掉。对齐细节: 垂直方向加环是**对称**的 ⇒ 居中基线与不加环时逐像素相同, 只有左/右对齐的锚点要从框边改到文字边 (`p` 与 `nat.w - p`); 编辑浮层同理靠 `padding: p·sy·zoom` 内缩 (box-sizing: border-box ⇒ 内缩不动外框; 横竖同一个长度就够 —— 这个元素活在 sy 空间里, 它的 width 已经是"屏幕盒宽 ÷ kx", 于是 CSS 长度乘上自身的 `scale(kx,1)` 后横向正好等于环的屏幕宽 p·sx·zoom, 纵向本来就是它自己)。**盒子一改就换网格**, 于是 `syncTextBuffer` 顺手把蒙版/decal 重采样到新尺寸 (`stretchSurfaceTo`): 视觉上本来就该跟着图层空间走 (复合时按 native 拉伸采样), 但送往后端的 image 与 mask 必须仍是同一个网格尺寸 —— 这是把"蒙版同尺寸"的契约在 retype/改 padding 之后继续守住的那一手。存档零迁移: padding 是 descriptor 上的标量, 旧 `.cud` 缺这个字段经 `sanitizeTextDescriptor` 落回 0; `syncTextBuffer` 的缓存 key 必须含 padding (它只改盒子不改任何字形度量, 漏了就等于面板读数对了、像素没动)
- 图层特效链 (per-layer effect chain, `layer.effects[]`): 附属式挂载 (不是栈里的新条目类型), 逐层就地生效 (自下而上走到该层时跑它自己的链), 前端 WebGL2 算完把结果当作该层的源像素交出去。注册表驱动 (EFFECT_TYPES: Shadow / Blur / Pixelate / Color / Light 五组): Drop Shadow、Inner Shadow、Stroke、Gaussian Blur、Vector Blur、Mosaic、Curves (PS 式控制点曲线: rgb 主曲线 + r/g/b 各一条点列, 参数只有那四条点列, 编辑面内嵌在曲线卡里)、Tone Map (一个 mode 下拉四路: Neutral = Khronos PBR Neutral、ACES = 胶片响应有理近似、Custom = Toe/Shoulder 四点单调曲线 + Gamma、External = 一张外部查找表 + Contribution; 参数行按模式现搭, 编辑面内嵌在色调卡里)、Depth of Field、Lighting、Bloom, 参数全在**该层结算面的像素空间** (位图层 = 原生尺寸, 文字层 = syncTextBuffer 烘出的盒子/画布像素缓冲, 所以特效参数按画布像素计、随盒子一起重跑); **加一类特效 = 新建一个 `nodes/web/fx/<effect>.js`** (注册数据 + 自己的着色器 + pass + 读数 + 缩略图全在里面, 末尾一次 `defineEffect(spec)`), 后端与存档迁移都不必动
  - 文件切分: 整条链一类特效一个文件, 靠经典 `<script src>` 共享页面同一个全局作用域拼起来, 加载顺序即依赖方向 `core → maps → gl → 各特效 → ui → 页面本体`; 硬约束只有两条 —— 顺序不能乱 (特效文件要 `defineEffect`, 引擎要先于特效, `ui.js` 里那几个 `getElementById` 常量要求脚本块排在所有标记之后)、顶层名字不能撞车 (撞了就是整页 SyntaxError)。`gl.js` 的 `fxglInit` 遍历注册表把各家报上来的 `shaders` 逐个编译, 所以新增特效不必回引擎改着色器清单; `describeEffect` / `drawFxThumb` 同样只剩"取该特效注册的 `readout` / `thumb`"两句分发, 页面里再没有按 type 分支的长 if/else。代价: 工作台服务器为 `/fx/*.js` 多开了一条静态路由 (realpath 后验目录归属 + 只认 `.js` + `no-store` 禁缓存), **改这条要重启工作台**
  - 三条地基契约 (决定了能做与不能做): ① **footprint-neutral** — 输出像素尺寸 === 输入, 一个像素都不外扩, 否则单独送往后端的原生尺寸蒙版与 layerCompositeForGenerate 的反解 transform 对齐就废了; 钉的是**网格**而不是"像素不许长到形状之外" —— 外阴影与 Outside 描边就是把 alpha 长进同一张网格里本来透明的像素, 合法, 但到了图层框边就被切掉 (PS 的投影可以无限往外拖, 这里不能); 想要那份框外余量只有一条正路: 把**该层自己的网格**做大 (文字层 = Padding, 位图层目前没有旋钮), 而不是去放大画布或 pass; ② **alpha 跟着画面走** — 模糊类 (高斯/运动/马赛克/景深) 把 A 与 RGB 一起滤波 (输出同一组抽样的 alpha 均值), 曲线/色调映射/内阴影/光照/泛光只写 RGB, 外阴影与 Outside 描边**加** alpha (本色在上、影子/色带在下的 source-over); 出口 alpha 是该层**新的源不透明度**, 蒙版仍独立存档, 于是后端 `image * mask` 依旧只乘一次 (乘两次会把软边按 alpha² 压暗)。对文字这种"形状就是 alpha"的层,不软化不透明度就等于没特效; ③ **蒙版只当输入读、不当输出用** — silhouette = 图层 alpha × 蒙版 alpha 参与运算, 但结果不裁进输出, 所以"阴影只出现在蒙版内的边缘"是推论而非选项。**外阴影与描边的形状故意只取图层 alpha**: 蒙版在链外还要整体乘一次, 在 silhouette 里先吃过一遍就等于软边处平方地压一遍影子 (PS 图层样式里 drop shadow 本来也只吃图层形状); **但链的输出照旧要被蒙版裁**, 所以蒙版没盖到的地方永远没有影子、也没有 Outside 描边 —— 想往外投影就得先把蒙版画到那儿, 或者干脆不画蒙版
  - GL 实现: 五张离屏缓冲按当前图层尺寸跨图层复用 (0/1 色彩乒乓, 2 silhouette 原样, 3/4 = 各家自借的工作面 (silhouette 虚化、描边的距离场乒乓)), RGBA16F (无 float 扩展退回 RGBA8); 可变半径低通走 dual-filtering/Kawase (每次迭代固定 4 抽样 = 一对正交十字, 代价与半径无关, `uAlphaOnly` 复用同一份着色器算 silhouette); **抽样十字的朝向逐迭代转 45°、起点 22.5°, down/up 两趟用 `uPhase` 再错一格** —— 旧写法四角永远落在两条对角线上, 半径大而迭代少时高反差边缘长出肉眼可见的**十字纹** (CPU 镜像实测 4 阶各向异性 A = (E[X⁴]−6E[X²Y²]+E[Y⁴])/(E[X⁴]+E[Y⁴]) ≈ −100%), 旋转基把它压到 |A| ≤ 0.5% 且**抽样数、n = round(radius/5) 与半径刻度一个没动** (n=1 的小半径也只剩 −5%); 轴向互补那种写法会矫枉过正成 **+ 字** (A ≈ +70%), 不要用; 方向模糊固定 32 抽样; 外阴影 = 把 `uHasMask=0` 的 silhouette (只取图层 alpha) 沿角度偏移 + 虚化, 再按直通色 source-over 把影子垫在本色之下 (`a' = a + s(1-a)`, `rgb' = (rgb·a + color·s(1-a))/a'`) —— 与内阴影同一个 `vUV + uOffset` 取样式, 所以 130° 在两者里都是"影子落在左下"; 内阴影 = 轮廓偏移 + 虚化 + 裁回未虚化轮廓; 描边 = **jump flooding 距离场** —— 早先的写法是"把 `uHasMask=0` 的 silhouette 虚化后读 0.5 水平集当近似距离", 那是错的: 低通是**面积平均**而不是距离, ① 细于半径的地方覆盖度根本爬不到阈值 ⇒ Size 越大描边越淡、最后整条消失, ② 平均场的水平集会在本来相距很远的两块之间长出光滑的颈 ⇒ 看着像液体 (两条都在 CPU 镜像上复现过、也验过修好后不再犯)。现在三趟着色器: **种子** (alpha 跨过 0.5 的那一圈像素, 外加图层框边 —— alpha 顶到框边的图层, 它的外形边缘本来就是框边 —— 记偏移 0, 其余记哨兵) → **洪泛** (步长按 2 的幂从大到小, 每趟在 3×3 邻域里取"邻居存的偏移 + 这段 hop"中模长最短的一条继承, 于是每像素拿到"我到最近轮廓像素的 texel 偏移"; 起点只要 `2^ceil(log2((Size+2)/2))` ⇒ 最大 Size 也才 7 趟 × 9 抽样, 比一次 Kawase 低通还便宜) → **合成** (`cover = 1 − smoothstep(Size−1, Size, d)`: 种子落在像素中心, 直边法向上真距离 = d + 0.5, 所以硬边形状上正好描出 **Size 个整像素**, 斜边/曲线自带一条 1px 斜坡就是 AA; 外侧那条带垫在本色之下、内侧那条盖在本色之上 —— PS 的描边是盖住自己画面的, 只是它出不了轮廓, 所以实心内部照样看得见色带, 式子还是外阴影那个直通色 source-over)。偏移编成 `(o + 128) / 256` ⇒ RGBA16F 里整数偏移精确, RGBA8 退回时也还剩 1 texel 刻度, 一条算式两种格式都成立。洪泛有两条必须守的采样纪律, 破哪一条都会把距离算**短** (短 = 长出假描边, 比算长了严重): **越界的抽样直接跳过** —— 采样器是 CLAMP_TO_EDGE, 框边像素往后看 uStep 会读回自己、凭空少走 uStep 步; **哨兵不许当邻居** —— 它不是任何真种子的偏移, 加一段 hop 就编造出一个根本不存在的近种子 (RGBA8 被 127 夹过的那些也一并落进这条, 所以阈值取 120 而不是 127)。真距离 ≤ 96 的 winning 链上每个中间值都被"剩余步长之和"钉在 63 以下, 这两条砍不到它。Position 三档只是合成里的两个 0/1 旋钮 (`uInOn`/`uOutOn`) 加上 Center 取 `Size/2`, 不必分三条着色器; 形状照旧 `uHasMask=0` (契约③, 与外阴影同一个理由)。借用面仍是 2/3/4, **一张新缓冲都不加**; 马赛克 = 先把 UV 折进所属格、取格心 3×3 预乘色平均再除回 alpha (同格所有像素取同一组抽样点 ⇒ 平色方块, 边缘用 CLAMP_TO_EDGE), alpha 取同一组抽样的均值 (格子化时形状边缘也一起方块化); 曲线 = 单次 pass 在已编码显示值上做一张 256×1 查表 (四条点列在 JS 侧按三次 Hermite 插值合成, 主曲线先作用再叠通道曲线; GLSL ES 3.00 没有 sampler1D, 所以查表用 2D 纹理的一行, 栅格取纹素中心 (i+0.5)/256), 恒等点列 = 恒等表、JS 侧直接跳过这次 pass; 色调映射 = 单次 pass 按 uMode 分四路, 前三路在**线性光**上作用 (sRGB 解码 -> 响应曲线 -> 回编码), Neutral 是 Khronos PBR Neutral (0.76 起压 + 灰段偏移 + 0.15 去饱和), ACES 用分子为 x(2.51x+0.03)/(x(2.43x+0.59)+0.14) 的有理近似 —— **不用** three.js 那条带 -0.03/-0.02 常数的 RRT fit, 那条会把线性输入 <≈0.076 一律压成纯黑, 阴影当场死掉; Custom 的曲线在 JS 侧解: 4 锚点 (首末钉死 (0,0)/(1,1), 中间两锚由 Toe Strength/Length 与 Shoulder Strength/Length 抬离对角线) 的单调三次 Hermite, 切线取中心割线、端点单侧割线再按 Fritsch-Carlson 夹进 [0, 3Δ], 终点斜率 = 1 - 0.95·ShoulderStrength·(1 - tan Angle) —— 乘的是肩部的**实际抬升**, 所以"强度全 0"必然回到那条对角线, 角度旋钮不会在零强度时偷偷压高光; 系数打包成 uXs/uYs/uMs 三个 vec4 (GLSL ES 3.00 允许动态索引 uniform 数组), Gamma 在线性域 pow(1/γ) 后进样条; External 是唯一在**显示值**上读表的一路 —— .cube 那类表就是按显示值编的, 套进线性域会把一张正常表洗成灰雾; 表 = 一张 3D LUT 的展开图 (Unity 的读法: 窄条 N²×N 或大方块 N·√N 见方, mapping=auto 时从图像尺寸反解、也可强制), 着色器里手工三线性 (8 次 fetch, 纹素中心 (x+0.5)/W, y 取 1 - (y+0.5)/H 把引擎的 UNPACK_FLIP_Y_WEBGL 抵掉), Contribution 在"原图 <-> 表结果"之间混; 尺寸对不上任何布局就**不静默插值** (拿一张普通照片当表洗过比不调色更糟), 写明跳过、像素原样; Neutral/ACES 恒作用, Custom 三旋钮全 0、External 贡献 0 时 JS 侧跳过这次 pass; 景深 = 点半径低通, 3 档虚化金字塔 (iris÷3 / 2·iris÷3 / iris, 原样那档就是当前色彩面) 铺进 2/3/4 号 silhouette 缓冲、Kawase 降采样借用乒乓的另一半 `off[1-slot]` 当 scratch (**一条新缓冲都不加**, 显存预算不变; 内阴影 pass 每次都把 2 号面重算一遍, 所以互不污染), 合档 pass 里逐像素从深度图 R 通道 (`PS Lens Blur 也读 Red`) 现算 CoC = `|d − Focal|` 过半宽 `Thick/2` 才起坡, 在相邻两档间线性混 (alpha 与色同进同出, 属于模糊类), 半径对称 ⇒ 近处远处一样虚; 光照 = 切线空间法线 `(2r−1, ±(2g−1), max(2b−1, 0.05))` 上做 Lambert `1 + I·(diff − 0.45)` (I 带符号, 负值 = 反向打光) + Blinn 高光 (指数 `mix(6, 220, gloss)`), 只改 RGB、alpha 原样; 泛光 = 亮部提取 (Rec.709 亮度对 Threshold 起 smoothstep 软膝, **权重写进 alpha** ⇒ 后续 Kawase 的"预乘再除回"正好按亮度加权, 不必第三个面) → 串联两档低通 (紧档 = radius, 远档 = 2·radius 糊在紧档结果上, 就是廉价金字塔) → 合成按 Halo 混两档、乘 Gain 与色偏后 screen/add 加回本色; 两档借 off[3]/off[4] 与 scratch, 亮部面在第二档算完当场回收当合成目标, 于是**仍然一张新缓冲都不加**, 只写 RGB、alpha 原样 (出口 present 会预乘 ⇒ 图层之外的光本来就落不进画面, 发光边界天然 = 图层自己的边界). 角度按画布坐标读 (0° 向右、90° 向下), 故 GL UV 里 y 取负
  - 重算时机: `fxResolved(l)` 缓存合成面, key = `l.img`/`l.decal`/`l.mask` 的**对象身份** + `fxSignature` (链的 JSON) + `fxMapStamp` (每个绑图特效的 `引用key@src短号#解码批次`) + **`l.paintGen` 落笔代次**. 身份只覆盖"换了对象": `detachPaintSurface` 是在**起笔**时换一次私有副本, 之后整笔都往同一张 canvas 就地改写 (油漆桶同理), 所以光靠身份 = 一笔里只有第一个落点那帧是新的, 剩下的墨全命中旧缓存, 要等下一次按下换身份才显形 (画一半"只显示开头一点"就是这个). 写表面的两条路径 (`livePreviewStroke` / `bucketFillAt`) 因此调 `markPainted(l)` 把**该面所属图层**的代次 +1 (Mask 目标的墨落在 maskLayer 上, 不在被选中的图层上). 缩放/重采样/裁切仍旧整面替换; 因此 transform 拖拽、视图缩放都不会重跑 GL. 代次变而身份全同 = 只有墨变了 → **复用同一块缓存画布**重画重跑链, 不新建 canvas (一笔几百帧就是一次几百张画布的 GC)。图章后两位是必需的 —— 工作区条目会原地换像素 (Guidance 卡重发布) 而 params 里读不到, 异步解码到位的先后本身也不在 params 里
  - 绑定贴图 (景深/光照这类 `needsMap` 特效): **是否真要取图由该特效自己报** —— `needsMapWhen(p)` 让一张图只挂在某些模式下 (色调映射只在 External 读查找表), 引擎据此决定"没绑图算不算跳过"; 没有这句, 中性模式会因为"没图"被整条拦掉, 而那个模式根本不需要图。同一条理由让 pass 签名带上 effect (`run(col, p, effect)`): 绑定图像**自己的尺寸**也是该特效的判断依据 (LUT 布局反解)。params 里永远只存一句引用 `{key, name}`, 像素绝不入 params —— 它要进每次缓存判定的 `fxSignature`、进 undo 深拷贝、进 `.cud` 记录, 塞几 MB data URL 三处全垮。key 两个来源: 工作区图池的 id (`staging_N`, 宿主镜像过来) 与本地池 (`map_N`, 文件选择或 `.cud` 资产), 两条路都只在 GL 侧解析成一张已解码的 `<img>`。解码是异步的而链全程同步, 所以取不到就顺手起一次解码、这次先跳过该特效, 图到位后 `invalidateAllFx()` 重算整链; 引用一律**整体替换**不原地改字段 (`cloneEffects` 只深拷到 params 一层, 内部的 map 对象是共享引用, 原地写会把 undo 指着的旧步骤一起改掉)。绑定入口 = 一个 picker: History 工作区缩略图 + From file… 同一个弹窗; 贴图不进工作区 (那是一张深度图, 不是参考图), 它住在本地池里。未绑 = 按钮转琥珀、链上写明跳过, 资产读不出 = 转红, 都**可见降级**
  - UI: 特效子行块挂在图层行的**上方** (左侧竖线标归属), 显示序 = 执行序的倒序 (越贴近图层者越先执行, effects[0] 紧挨 head 行); 空链不占位。每行 = 逐条开关 (checkbox) + SVG 图标 + 名称 + 可见读数 (`135° d8 r12 45% #000000`, 外阴影把 Soft 写成 PS 的 Size 读数 `sz`: `130° d12 sz16 64% #000000`; 描边把 PS 的 Position 缩写在最前 (`out`/`in`/`ctr`, 注册默认 = Outside): `out s4 100% #ffffff`; 绑图特效以贴图名开头: `depth_01  f35  t10  i16` (深度图近景偏亮、勾了 Near=bright 时后缀 ` inv`) / `normal_01  135°  45°  50%  s25`, 不塞 tooltip) + ×; 点行在该行下方内联展开参数区 (滑块/取色器/分段枚举, 拖动途中只重画布, 松手才记一步 undo; `needsMap` 的特效多一行"贴图按钮 + ×": 按钮上写的就是解析到的贴图短名, 未绑为琥珀色、资产读不出为红色, 点按钮开贴图 picker, 点 × 解绑); 曲线/色调映射这类注册了 `spec.editor` 的特效用自己的编辑面**顶掉**默认参数行 (色调 = 一行 mode 下拉 + 只铺该模式真要用的参数行, 换模式当场重建); 进 picker (按 group 小标题 + 3 列网格, 缩略图在上短名在下) 的入口是图层 head 行的魔杖按钮 (Generate 按钮左侧; 链上原来的行内 `+` 已移除) 与图层右键菜单 Effects — 两处都只有固定 Mask 行不渲染, 贴片 (fragment) 照旧可挂; 子行可拖拽重排 (插入线指示); 参数区里起手按住再动不能变成图层重排序 —— 参数块自己 `draggable=true` 接管拖拽源 (否则浏览器只会继续往上找到 draggable 的图层行), 再在自己的 `dragstart` 上 preventDefault 掐掉; 图层名后缀 `· fx`
  - 整链旁路: Layers 面板头的魔杖按钮 (`blend.effectsBypass` 存 localStorage), 视图级 — 画布路径与采样路径同时读到, 不会出现"画布上关了、送进 detailer 还开着"的分裂; 旁路时子行块左线转琥珀色
  - 进采样的通路 (`layerSpecs` 一处收口): 链算过就把解析面 PNG 当 `image`, 并把 `decal` 置 null (已烘进解析面, 后端不再叠一次), `mask` 仍按原生尺寸单独发 — **后端 composite_layers / snapshot_sampler_node 因此零改动**; 未挂链的图层继续走 `TRUSTED_SRC(l.src)` 原图直传
  - 持久化: undo 快照与 `.cud` (`CUD_VERSION = 3`) 都存 `effects` 的**深拷贝** (参数是就地改写的, 共享引用会让 undo 步骤跟着变), 存档里的 `image` 资产仍是**原图** ⇒ 非破坏性往返; v2 加了 `effects`, v3 加了 `role:'map'` 资产 —— 绑定的贴图必须随文件写死像素, 因为工作区条目 id 在重开时由宿主**重新编号**, 原样留着那句 `staging_N` 就是死引用。读取时资产解成图、落进本地池、换新 mint 的 `map_N` key (`restoreFxMaps`), 资产缺失/解不开就退回旧引用本行 (按钮转红、链上写明跳过, 比悄悄换一张图当真); v3 只写 `{key,name,asset}` 三个字段, 像素不进 params。读取走 `normalizeEffects` 白名单迁移 (认不出的 type 丢弃, 缺参数补注册表默认值), `fxSeq` 与 `layerSeq` 同样只增不减; 版本守卫拒绝比当前新的文件
  - 谁能挂链 (`layerTakesEffects`): 只有固定 Mask 层不行 —— detailer 回填的贴片 (fragment) 与普通图层同规矩, 链算的就是**该层自己那张网格**, 贴片只是"那块矩形的所属图层", 不是第二种图层 (它特殊的只有两件事: 不撑画布尺寸、不被 raster 偏好烘成 buffer); 空白手搓面 (Default / Dynamic Layer) 允许 (`noiseImageForGenerate` 结算前同样跑链)
- 绘制目标 Mask / Decal (点侧栏分段按钮或行内 chip, 无快捷键): 蒙版恒画白色 (只看 alpha); decal 模式下 Invert 隐藏, Reset 变 Clear (清空该层 decal)
- 笔画颜色 = 侧栏一行 **PS 式双色** (前景色块压在背景色块之上 + 读数 `#3366FF α 0.55`), 底下**常驻**一张取色面板 (SV 大方块 + 色相条 + Alpha 条 + Hex/α 手输); 原先的 Color 取色器与 Alpha 滑块两行、以及"点开才出现的弹层"都没有了。面板调的、笔刷用的都是**前景** (`brushColor`/`brushAlpha`/`brushHue`, 消费方一律走 `paintRGBA()`), 背景 (`backColor`/`backAlpha`/`backHue`) 只是停在后面的另一色 —— **除了换到前台, 没有任何绘制路径读它**。X (window keydown, 与 B/E/G 同一条链, 不受当前 mode 影响) 或点背景色块 = `swapPaintColors()`, 两槽对调; 交换走 setter, 所以色块、读数、面板三格、光标环一起翻。hue 方向**各槽存各的**, 换过来时一起搬 —— 不然一个灰阶槽换到前台会继承上一个颜色的色相
- 双色这块不引入新的真值源: 面板只是 `brushColor`/`brushAlpha` 的一张脸 —— `setPaintColor`/`setPaintAlpha` 末尾回头 `syncRgbaUI()`, 于是 Alt+click 吸色、设置回读、手输 hex 全都会自动把面板同步过来, 不会出现两处读数各说各话; 灰阶 (s≈0) 不藏幽灵色相, 拖色相条时只挪条不动颜色。面板住在 `#panelScroll` 里跟着上半区滚 (实测视口 228 / 内容 536, 本来就滚): SV 方格 116 高 + Hex/α 一行 = 整块 156 高, 默认分隔条位置下 Hex/α 要滚 ~60px 才露出来 —— 他点名"保持尺寸、接受微滚", 不为此压扁方格。横向是伸缩的: SV 方格 `flex:1 1 auto` 吃掉栏宽剩下的, 两条定宽 16, 拇指按**百分比**落位 (拖分隔条不需要重算), JS 里的 `RGBA_SV_W` 等常量只当绘制缓冲的分辨率用。背景色**不进**设置持久化 (存的仍是前景 `b.color`/`b.alpha`), 重开页面回到默认白
- 蒙版画笔 (B) 与橡皮 (E) 是两个独立工具: 各自独立的尺寸与参数 (模式/strength/center/edge/gamma), 用 B/E 键或侧栏点击切换; 左键用当前工具, 右键用另一个工具 (所以画笔右键 = 擦除, 橡皮右键 = 补回); 两个工具共用当前的绘制目标 (蒙版或 decal)
- 无悬浮面板: Mask / Decal / Brush / Eraser 都在侧栏, 当前工具与所属 section 高亮 (.active-tool), 各自带色环标识 (实线白 = 画笔, 红色虚线 = 橡皮); 画布上的笔刷光标环同色同形, 并按正在生效的工具实时切换 (含右键与吸色中)
- Brush 与 Eraser 的设置区可折叠 (点标题行切换, ▸/▾ 折角指示, 内容包在 .tool-body 里), 默认折叠: 折叠时只剩标题行 (色环 + 快捷键徽章) 并保持 active-tool 高亮; 滚轮改尺寸、B/E 切换工具、尺寸 scrub 都不受影响, 也不会自动展开
- 绘制目标下按住 Alt = 吸色工具 (仅画笔生效; 橡皮下 Alt 不吸色): 取合成后的画布像素, 所见即所得: 左键抬起时才套用颜色 (走 `setPaintColor`/`setPaintAlpha`, 所以侧栏那一行 RGBA 的色块与读数、弹层开着时的三格拇指全都跟着动, 以及笔刷/色环着色), 按住期间只在光标旁 HUD 里预览 (色块 + #hex + R, G, B 实时跟随光标); Alt 按住时笔刷环隐藏、光标变吸管图标 (内联 SVG data URI 指针, 热点在管尖); 取到透明或画布外时不改颜色, 状态栏提示 Nothing to pick there
- Alt + 右键拖拽 = 调节当前工具的尺寸 (PS 式 scrubby size, 与吸色互不抢占; 画笔与橡皮各自只改自己的尺寸): 水平拖拽线性映射 (沿用最早版本的 ALT_RESIZE_SENSITIVITY = 0.5, 即 size = 起始值 + dx × 0.5, 不是指数曲线; 实时 2 px – 9999 px 夹取), 拖拽期间光标为 ew-resize, 笔刷/橡皮环**圆心钉在按下的那一点**原地放大缩小 (PS 行为 — 指针可以拖到别处, 环不跟着跑; 该尺寸实时同步到侧栏滑块), 只有光标旁 HUD 显示 "N px + 工具名" 跟着指针走, 松手时环才重新贴回指针; ≤2 px 的抖动视为未拖动 (不记状态栏); 抬起时状态栏汇报最终值; 按住期间不绘制、不吸色
- 滚轮只改当前工具的尺寸 (画笔与橡皮互不影响), 两个尺寸滑块实时同步
- 选框系统 (文档级, 所有图层共用一份选区; 侧栏 Selection 段排在 Text 之下): M = 矩形选框, L = 套索 (按住手绘, 松手闭合), Ctrl+A = 全选, Ctrl+D / 侧栏 None / 工具下左键单击 = 取消; 语义 = PS 的"限制绘制" —— 选区不裁像素, 只裁落笔, 布尔模式照 PS: 空按 = 替换, Shift = 加, Alt = 减, Shift+Alt = intersect。Shift 只做加选, 不再顺带把矩形锁成正方 —— PS 的选框工具没有比例锁 (那是形状工具的规矩), 而且旧写法里两者共用同一个键还分了两条路径: 按住 Shift 时预览按正方锁画、松手落选的却是没锁的原始矩形, "看到的范围"和"选中的范围"直接分家
  - 选框指针的解剖照油漆桶: **准星交点就是落点** (CSS hotspot 8 8, 与笔刷环同一档像素精度), 右下两枚徽章只报身份 —— 外圈说工具 (实线方框 = 矩形选框, 带绳的环 = 套索), 角上那枚说这次按下会提交的布尔模式 (+ 加 / − 减 / × 交; 空按 = 替换, 它本来就是"没按住什么", 所以角上留空)。模式是拿 mousedown 同一句 `selectionMode()` 读出来的 (`selPointerMode()`), 所以光标不可能承诺一个松手给不出的模式, 而拖拽途中改按按键也不会让徽章重新亮起来 (判定已在按下那刻定案)。光标有三个站点必须都认它 —— `refreshCursor` / `updateHoverCursor` / `beginSelDrag`, 少一处就会被每次 mousemove 打回默认箭头 (油漆桶当年就栽在第二条上)
  - "按下却没拖"就是取消 (照 PS: 选框/套索工具下在画面上单击 = 清空选区, 而且它天然吃掉旧行为 —— 空按原本只会 "Marquee too small" 报错): `endSelDrag` 里那两处 sub-`SEL_MIN_DRAG` 分支就是这次单击的落点, 矩形与套索同一判据 (外接框太小 = 这一笔根本没扫出面积), 但只在 `d.mode === 'replace'` 时撤销选区。Shift/Alt 的单击仍然报"太小": 那两个模式是为拖拽而按的, 松手时选区还在 —— 把用户的选区毁在一次误触点下是不可逆的数据损失 (选区不进 undo, 掉了就掉了)。清空后的读数只有一处措辞: `deselectAndReport()` 与 None 按钮、Ctrl+D 同源 (有选区 = "Selection cleared", 本来空 = "Nothing was selected"), 三条入口不再各写一份 `if (clearSelection())`。`restoreState` 里那句 `clearSelection()` 不走它 —— 那是重放时的静默丢弃, 不是用户命令, 不该出声
  - 裁切的做法 = **把墨迹按"选区在这一层上的覆盖图"乘一遍, 且只乘选区落进这层的那块外接框 (footprint)**: `selectionLayerMask(l)` 把选区 doc 外接框的四角映到 layer 空间、裁进层内, 用 `setBrushCtxTransform` + 最近邻把选区位图一次性光栅进一张 footprint 大小的缓存画布 (缓存键 = `selVersion` + 该层 transform/尺寸 —— 只有选区或这层真的动了才重建), 预览每帧只花两次 footprint blit (墨迹 footprint → `destination-in` 蒙版 → 落回绘制面)。三个逃生口: 无选区、`whole` (单个矩形把这层全包, 例如 Ctrl+A 对画布大小的层 —— 等于什么都没裁) 走原来的整幅 blit; 选区完全落在这层之外则一滴墨都不出。**刻意不用 `ctx.clip(path)`**: 抗锯齿多边形 clip 对 Chromium 是"此后每一次 draw 都要在 clip 包围盒上算一遍 coverage mask", pointer 速率下它比省下的 blit 贵得多 —— 实测就是"拖一长笔只显开头, 点一下才整笔显形"。早先那版 destination-in 之所以也卡, 是因为 scratch 按**整层**开、每帧多三次整层遍历 —— 现在这版把同一件事收到 footprint 大小并加缓存, 开销按选区实际面积计而不是按图层面积计
  - 实时预览**按帧合并, 不按事件合并**: pointer/touch 事件比一帧来得密 (高刷鼠标可达 8 ms 以内), 每事件合成整层只会把事件堆成队列再被浏览器丢掉。落笔仍逐事件累积进 strokeCanvas (便宜, 且一个点都不丢), 但 `queueLivePreview()` 一帧只合成一次; `commitStroke()` 先把排队标志清掉再亲自画终态 —— strokeCanvas 在它手里就清空了, 迟到的那一帧会把刚完成的笔画擦掉
  - 油漆桶是唯一按像素问的通路: 反解 doc→layer 变换逐点测选区位图 (矩形选区免位图, 框即是区域), 落在外面的计数写进状态栏
  - 真源是矢量 shapes (文档像素), 位图/边界/marching ants 全部派生且按需重建 (`ensureSelection`): 光栅化只进选区自身的外接框而非整张画布 (40 MP 文档不该为了记一个矩形再驻一张 160 MB RGBA), 扫完 alpha 再收紧到真正存活的像素; **单个 replace 矩形走解析快路** —— 四角 + 一次乘法即为答案, 绝不光栅化/扫描 (否则 Ctrl+A 在大画布上要走上千万像素去"重新发现"刚画的框)
    - 收紧后的 scratch 位图是**从二值 mask 反写出来的** (putImageData), 不是把带抗锯齿的原始光栅裁一块过来: 边缘那个过了 >128 阈值的像素要么全漏要么全不漏, 漏出的墨必须跟蚂蚁线说的一致 —— 蒙版和油漆桶、和蚂蚁线读的都是同一份 tight 位图 + 同一个 tight 外接框
  - 蚂蚁线从**布尔结果的位图**上描边 (不是从各个 shape 轮廓), 故减法/交集显示的是真边界; 边界用 crack-code 式有向单位边串成闭环 + 去掉共线顶点 (矩形出来是 4 个点), 再按 zoom 分档做 RDP 抽稀并缓存 `Path2D` (文档坐标); 描边 `lineWidth = 1/zoom` + `setLineDash(4/zoom)` 让虚线屏幕恒定, phase 直接取 `performance.now()` 而非定时器累加 —— 绘制中 pointermove 本来就在重绘 overlay, 于是 70 ms 定时器在 `isDrawing` 期间直接跳过, 不给一次落笔叠上第二遍全屏重绘; 套索采样 2 屏幕 px 一点, 拖拽中的显示路径再做亚像素 RDP (长圈不必每事件重描上千段)
  - 拖拽中的新轮廓与**已选区的蚂蚁线同时可见** (PS 语义: Shift 加/Alt 减的整个 sweep 期间旧选区一直显示, 手上这条画成实线工作路径), 松手才把布尔并进结果
  - 选区属于文档不属于图层: 不进 `.cud`、不进 undo 记录, `restoreState` (undo/redo/切页/Load) 一律清掉; 画布尺寸变了才在下次用时重derive (选区是文档像素几何, 尺寸一变原点就动了); 侧栏 Selection 读数只在有内容时占位 (面积 + 外接框 + 多 shape 计数, 或工具待拖拽提示)
- 快捷键: T/Ctrl+T = transform, Z = 缩放工具, H = 抓手 (平移视图), R = 旋转视图, M = 矩形选框, L = 套索, B = 画笔, E = 橡皮, G = 油漆桶, 回车/Esc 退出; 工具是"选中"而非开关 — 重复按同一个工具的键 (或再点同一个工具按钮) 保持该工具不变, 不会退回无工具状态, 退出只走回车/Esc; 侧栏控件在 mouseup 后自动 blur, 用过滑块/按钮后快捷键依然生效
- 指针事件挂在 #viewport/window, 画笔移出画布仍保持笔刷光标且继续绘制 (可画到画布边缘)
- Transform 调整框 (T/Ctrl+T): 移动 / 缩放 / 旋转 (Shift 吸附); 回车或 Esc 退出 (无框的 'none' 模式)
- 调整框/控制点画在独立的屏幕空间 overlay canvas 上, 超出画布范围也可见可拖
- 视图变换 (不影响导出): H 切换抓手工具 (PS 式, 左键拖拽平移视图, 光标 grab/grabbing), Z 切换缩放工具 (工具态而非按住键), 该模式下左键单击放大 / 右键单击缩小 (1.25×), 左键向右拖 = 无极放大、向左拖 = 无极缩小 (2^(dx/220)); 缩放枢轴固定为按下左键时的那个文档点 (整个拖拽过程中它停在原屏幕位置不动, 与 PS 的 scrubby zoom 一致); R 切换旋转工具 (同样工具态, 光标为环形箭头图标), 左键拖拽 = 像转旋钮一样拧视图: 旋转量取"指针绕视口中心扫过的角度"(1:1 跟手, 向哪边拧就往哪边转, 与拖拽方向/距离无关 — 不是左右拖拽的比例映射), 按下的那个文档点会一直贴在指针下, 角增量为逐事件累加并对 ±180° 接缝做 wrap (跨接缝不会跳), Shift 吸附 15°, 原地单击 = 顺时针 15°; 指针落在视口中心 12 px 死区内时角度无意义 → 拖出死区那一刻重新取基准 (不会跳变); 四条旋转路径 (拖拽 / 单击 / ⟲ / ⟳) 的枢轴都是视口中心 (= 视图中心, 不是画布中心): 拖拽期间停在视口中心下的那个文档点保持不动 (实测偏差 < 1e-13 px), 画布偏出视野时依然绕视口中心转; Ctrl+F 水平翻转, 滚轮缩放, Space/中键拖拽平移; View 面板有 Hand/Zoom/Rotate/Fit/Reset/±/±15°/Flip H 与读数
- 画布右下角悬浮 Blend 按钮 (原底部 toolbar 已移除); 侧栏第一栏就是 Layers (头部有 Clear All / Add), 当前工具只在 View 面板的按钮高亮上体现 (原顶部模式 chip 已移除)
- 工具按钮只显示快捷键字母 (Transform=T, Marquee=M, Lasso=L, Hand=H, Zoom=Z, Rotate=R), 工具名与用法都在 tooltip (title) 里; 侧栏不再有常显的说明段落 — Layers / Selection / Transform / Mask·Decal / Brush / Eraser / View 的标题 (带 title 时 cursor: help) 承载说明, Brush/Eraser/Mask·Decal 的 tooltip 随绘制目标在 mask 与 decal 之间实时切换 (且在有选区时追加一句"当前工具会被裁切"), 并随目标切换; 侧栏只保留动态读数 (canvasReadout / selectionReadout / transformReadout / maskTargetLabel / viewReadout), 且读数在没内容时整行隐藏 (setReadout: 空文本 → display:none) — 未选图层或画布未建立时 Transform 读数不占位, 非绘制模式下不显示 "Mask — 图层名", 画布还没建时不显示跟随提示; Canvas 读数只有两种紧凑状态 (Following the bottom layer / Fixed), 完整解释在 Canvas 标题与 Canvas Size 的 tooltip 里
- 图片可直接拖进画布成为图层: 拖拽到画面上方时画布区显示蓝色虚线投放提示 (Drop images to add them as layers), 松手后按文件顺序逐个 addLayer (新图层在最上并自动选中, 图层名取文件名去扩展名); 只接受图片 (image/* 或 png/jpg/webp/gif/bmp), 混入非图片文件时提示 Only image files can be dropped here; 多文件同时拖入逐张异步加载
- 新加入的图层 (拖入 / Add 历史图 / 父窗口推图) 一律保持原图比例并 fit 进当前画布 (PS "Place" 的 contain 语义: scale = min(canvasW/natW, canvasH/natH), 居中放置, 不做拉伸变形), 落在画布内的实际盒子为 nat × scale; 画布还没有尺寸时 (= 第一张图) 画布分辨率仍取该图原生尺寸, 此时缩放系数为 1, 图层正好铺满画布
- 拖入的图层没有 history key, 像素随 payload 以 `src` (data URL) 直接带给后端 (历史图层仍只传 key, `src` 为 null), 后端 blend_layers 在 key 缺失/无法解析时回退到 `src` 解码 (libs/image_utils.decode_image_dataurl → [H,W,4] 保留 alpha), 因此本地图片无需先进历史即可参与合成
- 合成 (POST /api/blend_layers, payload 每层带 key|src + transform/mask/decal → composite_layers: 图层空间 decal source-over + 乘蒙版 + 预乘 alpha 采样 + 层间 source-over); 全不透明输出 3 通道, 否则保留 alpha
- 结果加入 history

### 6. Context 图像管理
- History 画廊 (最多 20 张, base64 缩略图)
- Load From Image (文件上传)
- Load From Assets (SnapshotAssetsServer)
- Select Image (设为 context)
- Set Context (不切换 tab)
- 图片尺寸记录 (用于过滤同尺寸图片)

### 7. Interface 子图执行
- InterfacePackageNode → sub_prompt
- Port 显示 (Start/End, inject/manual/port 分类)
- 注入选项: Image source (默认/选择), Operation (默认/Crop mask 区域), Crop Reserve
- Execute (InterfaceExecutor lazy evaluation)
- 结果 uncrop 回原图尺寸
- 结果加入 history + auto-set context

### 8. Finish 流程
- 多选 history 图片
- POST /api/finish → server.finished = True → 主循环 break
- server.stop() (关闭 mask/prompt/main server)
- 选中图片设为 pipeline.image
- 前端显示 Finished 页面 (不调 window.close())

### 9. 参数同步
- 前端 → /api/update_config → _apply_params → server 状态
- server 状态 → _sync_widgets → ComfyUI widget 同步
- run_detailer 前: params 从 server 同步最新值
- Mask: handleTabChange → sync-mask → /mask → handleMask → pipeline.mask
- Prompt: handleTabChange → sync-prompt → /select_prompt → prompt_server

### 10. 服务器架构
```
SnapshotDetailerSamplerServer
├── mask_server (SnapshotMaskNodeServer, image_node.py)
│   ├── port ~8080
│   ├── ThreadingHTTPServer
│   ├── /mask, /grow, /detect, /clear, /image_data, /window_closed
│   ├── mask_node.html (画笔/detector/grow)
│   ├── set_mask → _on_mask_set → pipeline.mask
│   └── _initial_mask (用于 reload-image 恢复)
│
├── prompt_server (SnapshotPromptServer, prompt_node.py)
│   ├── port ~8500
│   ├── ThreadingHTTPServer
│   ├── /select_prompt, /prompts_data, /lora_data, /window_closed, ...
│   ├── prompt_node.html (React SPA: prompts/loras/prefabs/programs)
│   ├── selected_prompts, selected_loras, selected_prefabs
│   └── prompt_event (threading.Event)
│
└── main_server (MainHandler, snapshot_sampler_node.py)
    ├── port 8700-8800
    ├── ThreadingHTTPServer
    ├── sampler_node.html (React SPA: App.tsx + EditPhase.tsx)
    ├── /api/* endpoints (REST API)
    ├── action queue (queue.Queue + threading.Event)
    └── history gallery (selected_history, base64)
```
