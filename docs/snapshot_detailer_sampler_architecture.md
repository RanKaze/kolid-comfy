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
- 单层结算顺序: 原图 + decal (straight alpha source-over) → 乘蒙版 → 按 transform 采样进画布 → 层间 source-over 合并; 蒙版因此同时裁切图片与 decal
- 绘制目标 Mask / Decal (M / D 键, 或点侧栏分段按钮/行内 chip): decal 模式下才显示颜色选择器 (默认 #ff3b30), 笔刷与光标色环、侧栏色环都按该颜色着色; 蒙版恒画白色 (只看 alpha); decal 模式下 Invert 隐藏, Reset 变 Clear (清空该层 decal)
- 蒙版画笔 (B) 与橡皮 (E) 是两个独立工具: 各自独立的尺寸与参数 (模式/strength/center/edge/gamma), 用 B/E 键或侧栏点击切换; 左键用当前工具, 右键用另一个工具 (所以画笔右键 = 擦除, 橡皮右键 = 补回); 两个工具共用当前的绘制目标 (蒙版或 decal)
- 无悬浮面板: Mask / Decal / Brush / Eraser 都在侧栏, 当前工具与所属 section 高亮 (.active-tool), 各自带色环标识 (实线白 = 画笔, 红色虚线 = 橡皮); 画布上的笔刷光标环同色同形, 并按正在生效的工具实时切换 (含右键与吸色中)
- Brush 与 Eraser 的设置区可折叠 (点标题行切换, ▸/▾ 折角指示, 内容包在 .tool-body 里), 默认折叠: 折叠时只剩标题行 (色环 + 快捷键徽章) 并保持 active-tool 高亮; 滚轮改尺寸、B/E 切换工具、尺寸 scrub 都不受影响, 也不会自动展开
- 绘制目标下按住 Alt = 吸色工具 (仅画笔生效; 橡皮下 Alt 不吸色): 取合成后的画布像素, 所见即所得: 左键抬起时才套用颜色 (同步写回 Brush 面板的取色器与其读数, 以及笔刷/色环着色), 按住期间只在光标旁 HUD 里预览 (色块 + #hex + R, G, B 实时跟随光标); Alt 按住时笔刷环隐藏、光标变吸管图标 (内联 SVG data URI 指针, 热点在管尖); 取到透明或画布外时不改颜色, 状态栏提示 Nothing to pick there
- Alt + 右键拖拽 = 调节当前工具的尺寸 (PS 式 scrubby size, 与吸色互不抢占; 画笔与橡皮各自只改自己的尺寸): 水平拖拽线性映射 (沿用最早版本的 ALT_RESIZE_SENSITIVITY = 0.5, 即 size = 起始值 + dx × 0.5, 不是指数曲线; 实时 2 px – 9999 px 夹取), 拖拽期间光标为 ew-resize, 笔刷/橡皮环**圆心钉在按下的那一点**原地放大缩小 (PS 行为 — 指针可以拖到别处, 环不跟着跑; 该尺寸实时同步到侧栏滑块), 只有光标旁 HUD 显示 "N px + 工具名" 跟着指针走, 松手时环才重新贴回指针; ≤2 px 的抖动视为未拖动 (不记状态栏); 抬起时状态栏汇报最终值; 按住期间不绘制、不吸色
- 滚轮只改当前工具的尺寸 (画笔与橡皮互不影响), 两个尺寸滑块实时同步
- 快捷键: T/Ctrl+T = transform, Z = 缩放工具, H = 抓手 (平移视图), R = 旋转视图, M = 蒙版绘制, D = decal 绘制, B = 画笔, E = 橡皮, 回车/Esc 退出; 工具是"选中"而非开关 — 重复按同一个工具的键 (或再点同一个工具按钮) 保持该工具不变, 不会退回无工具状态, 退出只走回车/Esc; 侧栏控件在 mouseup 后自动 blur, 用过滑块/按钮后快捷键依然生效
- 指针事件挂在 #viewport/window, 画笔移出画布仍保持笔刷光标且继续绘制 (可画到画布边缘)
- Transform 调整框 (T/Ctrl+T): 移动 / 缩放 / 旋转 (Shift 吸附); 回车或 Esc 退出 (无框的 'none' 模式)
- 调整框/控制点画在独立的屏幕空间 overlay canvas 上, 超出画布范围也可见可拖
- 视图变换 (不影响导出): H 切换抓手工具 (PS 式, 左键拖拽平移视图, 光标 grab/grabbing), Z 切换缩放工具 (工具态而非按住键), 该模式下左键单击放大 / 右键单击缩小 (1.25×), 左键向右拖 = 无极放大、向左拖 = 无极缩小 (2^(dx/220)); 缩放枢轴固定为按下左键时的那个文档点 (整个拖拽过程中它停在原屏幕位置不动, 与 PS 的 scrubby zoom 一致); R 切换旋转工具 (同样工具态, 光标为环形箭头图标), 左键拖拽 = 像转旋钮一样拧视图: 旋转量取"指针绕视口中心扫过的角度"(1:1 跟手, 向哪边拧就往哪边转, 与拖拽方向/距离无关 — 不是左右拖拽的比例映射), 按下的那个文档点会一直贴在指针下, 角增量为逐事件累加并对 ±180° 接缝做 wrap (跨接缝不会跳), Shift 吸附 15°, 原地单击 = 顺时针 15°; 指针落在视口中心 12 px 死区内时角度无意义 → 拖出死区那一刻重新取基准 (不会跳变); 四条旋转路径 (拖拽 / 单击 / ⟲ / ⟳) 的枢轴都是视口中心 (= 视图中心, 不是画布中心): 拖拽期间停在视口中心下的那个文档点保持不动 (实测偏差 < 1e-13 px), 画布偏出视野时依然绕视口中心转; Ctrl+F 水平翻转, 滚轮缩放, Space/中键拖拽平移; View 面板有 Hand/Zoom/Rotate/Fit/Reset/±/±15°/Flip H 与读数
- 画布右下角悬浮 Blend 按钮 (原底部 toolbar 已移除); 侧栏第一栏就是 Layers (头部有 Clear All / Add), 当前工具只在 View 面板的按钮高亮上体现 (原顶部模式 chip 已移除)
- 工具按钮只显示快捷键字母 (Transform=T, Mask=M, Decal=D, Hand=H, Zoom=Z, Rotate=R), 工具名与用法都在 tooltip (title) 里; 侧栏不再有常显的说明段落 — Layers / Transform / Mask·Decal / Brush / Eraser / View 的标题 (带 title 时 cursor: help) 承载说明, Brush/Eraser/Mask·Decal 的 tooltip 随绘制目标在 mask 与 decal 之间实时切换; 侧栏只保留动态读数 (canvasReadout / transformReadout / maskTargetLabel / viewReadout), 且读数在没内容时整行隐藏 (setReadout: 空文本 → display:none) — 未选图层或画布未建立时 Transform 读数不占位, 非绘制模式下不显示 "Mask — 图层名", 画布还没建时不显示跟随提示; Canvas 读数只有两种紧凑状态 (Following the bottom layer / Fixed), 完整解释在 Canvas 标题与 Canvas Size 的 tooltip 里
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
