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
│  │  │  │              │  │              │  │ /api/blend       │  │      │  │
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
│  ├── Blend tab   → iframe(blend_node.html) + image selector modal           │
│  ├── Context tab → History gallery (hover preview + select)                 │
│  └── Interface tab → Port display + injection options + Execute button      │
│                                                                             │
│  前端→后端通信:                                                               │
│  ├── fetch (REST API to Main Server)                                       │
│  ├── postMessage (parent↔iframe: sync-mask, sync-prompt, reload-image,    │
│  │                 mask-confirmed, prompt-confirmed, mask-data, blend-data) │
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
│  VAEEncode(resized_image) → tmp_latent                                     │
│  │                                                                          │
│  ├── get_model_clip(model, clip, loras) → model_to_use, clip_to_use        │
│  │                                                                          │
│  ├── [enable_edit] apply_model_patch (Krea2/Flux2Klein)                   │
│  │                                                                          │
│  ├── [context_reference] VAEEncode(history_image) → reference.reference_  │
│  │                        latents.append()                                  │
│  │                                                                          │
│  ├── get_conditioning(positive/negative)                                   │
│  │   ├── Flux2Klein: reference_latent=tmp_latent, reference_image=None     │
│  │   └── Krea2: reference_latent=None, reference_image=resized_image       │
│  │                                                                          │
│  ├── _ksampler(model, positive, negative, tmp_latent, start/end_step)     │
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
- 画笔/橡皮 (Binary/Linear/Exponential 模式)
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

### 5. Blend 混合
- blend_node.html iframe
- BG/FG 选择器 (从 history 选)
- 画笔/橡皮 (默认 Exponential)
- Alpha blend (bg × (1-mask) + fg × mask)
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
