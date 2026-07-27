# Kolid-Comfy

一套基于 ComfyUI 的自定义节点扩展，提供图像/视频处理、AI 采样、交互式 Web UI 等功能，通过临时 HTTP 服务器（8080-8899 端口）提供交互式浏览器界面。

---

## 📦 安装教程

### 1. 克隆仓库

将本仓库克隆到 ComfyUI 的 `custom_nodes` 目录下：

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/RanKaze/kolid-comfy.git
cd kolid-comfy
git submodule update --init --recursive   # 拉取 SuperSplat 前端子模块
```

> 如果不需要 SnapshotGaussianNode 的 SuperSplat 渲染模式，可以跳过 submodule 步骤。

### 2. 安装 Python 依赖

请使用 ComfyUI 运行时的 Python 环境（虚拟环境或独立 Python）来安装依赖，确保依赖安装在 ComfyUI 实际使用的解释器中：

```bash
# 方式一：如果使用 ComfyUI 的嵌入式 Python（Windows 便携版）
# 路径示例: ComfyUI/python_embeded/python.exe
"<ComfyUI路径>/python_embeded/python.exe" -m pip install -r requirements.txt

# 方式二：如果使用虚拟环境
# 先激活虚拟环境，再安装
pip install -r requirements.txt
```

主要依赖包括：

| 依赖 | 用途 |
|------|------|
| `PySide6` | SnapshotCaptureNode 桌面截图浮动面板 |
| `pyautogui` | 屏幕截图捕获 |
| `opencv-python` | 视频/图片处理 |
| `decord` | 高效视频帧读取 |
| `yt-dlp` | URL 视频下载（YouTube/Bilibili 等） |
| `selenium` / `seleniumbase` | 网页爬取（EHentai 等） |
| `psutil` | Wallpaper Engine 进程检测 |
| `onnxruntime` | 部分检测器模型推理 |
| `requests` | 网络请求 |
| `pywebview` | Web UI 辅助 |

> 部分节点（如 SnapshotCaptureNode）仅支持 **Windows**（依赖 PySide6 + win32gui）。

### 3. 构建前端资源（可选）

交互式 Web UI 节点（PromptNode、AssetsNode）的 HTML 文件需要前端构建后才会生成。仓库已附带预构建的 `nodes/web/*.html`，如果需要修改前端代码则需手动构建：

```bash
# 构建 PromptNode 前端
cd nodes/prompt_node
npm install
npm run build
# 输出: nodes/web/prompt_node.html

# 构建 AssetsNode 前端
cd nodes/assets_node
npm install
npm run build
# 输出: nodes/web/assets_node.html
```

> 构建工具：Vite + TypeScript + React + vite-plugin-singlefile（将所有 JS/CSS 内联到单个 HTML 文件）。

### 4. 重启 ComfyUI

重启 ComfyUI 后，节点会自动加载。在 ComfyUI 的节点搜索中输入节点名称（如 `FitNode`、`PipelineNode`、`SnapshotPromptNode` 等）即可找到。

---

## ⭐ 核心特色节点

这些节点具有超出常规数据处理的特殊功能（前端交互、工作流控制、架构扩展等），是 Kolid-Comfy 的核心价值所在。

### 🔀 Branch 分支控制系统

一套完整的**工作流级流程控制**系统，无需 Python 代码即可实现条件分支、节点静音/旁路/折叠、布尔逻辑中继、多路选择、分组管理。

- **BranchSwitchNode** — 布尔开关。toggle=true 时透传数据，toggle=false 时输出 None（lazy 加载，不触发上游）。支持 **relay_expression**（布尔逻辑中继）和 **active_config**（节点状态控制）两个强大的配置字符串：
  - `relay_expression`：根据其他分支节点的 toggle 值自动计算当前值。支持 `&&` `||` `!` `()` 运算符、`{id}` 按 ID 引用、`..Parent:NodeName` 跨图引用、`{id}==[N]` SwitchesNode 选择检查
  - `active_config`：toggle 变化时自动控制其他节点。格式 `op:target_type:target_value`，操作包括 mute/!mute/bypass/!bypass/foldout/!foldout/expand/!expand/set/!set，目标支持 name/id/group
- **BranchSwitchesNode** — 多路选择器。动态扩展输入槽，仅加载选中输入（lazy）。支持 **select_config**：根据选择索引自动控制其他节点状态，格式 `select_index:op:target_type:target_value`，匹配的执行原操作，不匹配的执行反转操作。支持 SwitchesNode 间联动
- **BranchBooleanNode** — 纯布尔控制节点（无数据输入），配合 relay_expression / active_config 作为逻辑控制器
- **BranchGroupNode** — 分组管理。通过 properties 配置批量管理一组分支节点，支持 Default（独立 toggle）/ MaxOne（最多选一个）/ AlwaysOne（必须选一个）三种模式
- **BranchManagerNode** — 可视化分支依赖关系图（SVG 力导向布局），显示所有 relay / config / select 依赖边
- 以上所有配置字符串均有**前端语法高亮编辑器**（绿色=找到目标，橙色=未找到，蓝色=操作符）和**跳转按钮**快速定位引用节点

### 📋 交互式 Web UI 节点

启动本地 HTTP 服务器并打开浏览器，提供可视化交互界面：

- **SnapshotPromptNode** — 提示词选择器。分类浏览 prompt 词条、LoRA 选择、预制词包（prefab）、Program 脚本系统（JS 代码动态生成/过滤词条）、bbox 区域编辑、Tag From Image（tagger 自动打标）、Tag From Assets
- **SnapshotAssetsNode** — tldraw 画布。拖放式图片/视频/音频卡片管理，支持自定义配置（Float 参数）、Slot 插槽系统、prompt 输入
- **SnapshotDetailerSamplerNode** — 交互式细节修复循环。mask 绘制 → prompt 选择 → AI 重绘 → 对比切换，多次迭代精修
- **SnapshotSwitchNode** — 动态输入选择器。lazy 模式仅加载选中输入，历史快照缓存
- **SnapshotGaussianNode** — 3D 高斯泼溅预览。支持 GSplat / SuperSplat 两种渲染器，按 Enter 截图，支持相机外参输入输出
- **SnapshotMaskNode** — 浏览器 mask 绘制。画笔大小调节、detector 自动检测、mask 膨胀
- **SnapshotRegionNode** — 区域编辑器。绘制 bbox 区域 + 描述，输出 caption JSON（支持 normalized/absolute 坐标、yx/xy 轴序、compact/pretty 格式），可嵌入 SnapshotPromptNode
- **SnapshotCaptureNode** — 桌面截图。PySide6 浮动面板，Shot（框选截图）/ Previous（加载缓存）模式

### 🎨 采样管线 (Pipeline) 系统

模块化采样工作流，通过 PipelineData 在节点间传递模型、图片、条件等上下文：

- **PipelineNode** — 管线数据容器，整合 model/clip/vae/image/latent/mask/sampler/scheduler/steps/cfg/context/reference/config，支持链式传递和增量更新
- **PipelineDetailerAdvancedNode** — 完整 Detailer 管线：Crop → Limit Pixels → KSamplerAdvanced → Recover Size → Recover Crop，支持 detector 自动检测、tagger 打标、inpaint 模式、foreach_mask（多 mask 独立处理）
- **架构扩展系统** — ConfigArchitectureNode 设置架构名称（Krea2 / Flux2Klein / QwenEdit），PipelineEnableEditNode / PipelineEnableQwenEditNode 启用对应架构的编辑模式，自动应用模型 patch 和特殊 conditioning
- **双模型 CFG** — ConfigModelNegativeNode 设置负向模型，采样时正向用 model、负向用 model_negative（DualModelCFGGuider）
- **Context 系统** — ContextNode 按名称管理多组 prompt/LoRA，ContextQueryNode 通过相似度模型自动选择上下文，采样器通过 context_regex 正则匹配

### 🧮 ScriptNode

自定义 Python 脚本执行节点。在节点中编写 Python 代码，通过 `result` 变量返回结果，支持 `x`/`y`/`z` 三个任意类型输入和列表输出。

---

## 📖 完整节点文档索引

| 分类 | 说明 | 文档 |
|------|------|------|
| 📋 交互式 Web UI | 浏览器交互式选择器、绘制工具、截图等（13 个节点） | [docs/web-ui.md](docs/web-ui.md) |
| 🖼️ 图像处理 | 适配缩放、裁剪、合批、Base64 转换等（12 个节点） | [docs/image.md](docs/image.md) |
| 🎨 采样管线 (Pipeline) | 模块化采样工作流：上下文、参考、配置、采样器、Detailer（30 个节点） | [docs/pipeline.md](docs/pipeline.md) |
| 🎬 视频和音频 | 视频下载/提取/预览、音频提取/编码（15 个节点） | [docs/media.md](docs/media.md) |
| 💾 磁盘 IO 和网络 | 磁盘读写、网络图片加载、文件操作（13 个节点） | [docs/io.md](docs/io.md) |
| 🔀 分支和逻辑 | 流程控制、List 合并、Dictionary 操作（23 个节点） | [docs/logic.md](docs/logic.md) |
| 📝 文本/数学/工具 | 字符串处理、正则、数学表达式、脚本、LoRA、调试、3D、训练（20 个节点） | [docs/utility.md](docs/utility.md) |

---

## 🖥️ 服务端口说明

| 服务 | 端口范围 |
|------|----------|
| GSplat/SuperSplat 渲染 | 8080-9000 |
| Switch 选择器 | 8600-8700 |
| Detailer Sampler | 8700-8800 |
| Assets 画布 | 8800-8900 |
| SuperSplat 前端 | 3000（常驻进程） |
