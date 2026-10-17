# 界面探针（UI Probe）

> 一套**在界面里就地采集自己**的调试设施：打开着的编辑器自己把"组件层级 / 属性 / 样式 / 布局几何 /
> 操作轨迹"攒成一份快照，一键送到后端落成文件；另一端（人，或读同一台机器的 agent）不必再向用户
> 索要截图、描述和复现步骤，直接把那一屏**重放**出来看。

它解决的是一类具体的浪费：布局问题的现场在**用户那台机器的那个窗口里**，而排查的人在别处。
于是一轮往返被拆成三轮——"你说说是什么样" → "你截个图" → "你把布局数据导出来"——
每一轮都要用户重新回到现场，而现场在第一次拖拽之后就变了。

---

## 1. 设计目标

| 目标 | 具体含义 | 落到哪个设计决定 |
| --- | --- | --- |
| **零转述** | 用户不需要描述、截图、复制粘贴任何数据 | 采集发生在页面内部，出口是一个按钮 |
| **现场可搬运** | 那一屏能被搬到别处原样重现 | 快照同时记下**视口**与**布局模型**，足以重放 |
| **结论而非数字** | 交付的是"哪里不对、为什么"，不是一坨 JSON | 探针自己跑不变量检查，产出带证据的问题清单 |
| **可自证新旧** | 先排除"你看到的是旧产物"这类假问题 | 快照带构建戳；后端比产物与源码的 mtime |
| **不改变应用** | 采集不依赖应用配合、拖慢或改行为 | 只读 DOM、只读 fiber，不挂钩子、不改渲染 |

一条贯穿的原则：**探针只观测，不参与**。它不拦截事件、不记录状态、不在渲染路径上做任何事，
所有数字都是"此刻读出来的"。所以"打开探针时现象就变了"这件事不会发生。

---

## 1.5 实时通道 —— 主路径（等同 F12，但没有调试端口）

快照回答的是"这份**拷贝**里是不是也有这个问题"。而排查真正要回答的是"读我**现在眼前**这个状态"。
两者的差别不在数据多少，在**现场是不是活的**：快照是死的，重放是复制的。所以主路径不是快照，
是一条双向通道：

```
页面 ──GET /api/ui_probe/cmd?wait=25──▶ 通道      ← 长轮询等一条表达式（25s 空手回去，再来）
页面 ◀── {cmd:{id, expr}} ──────────────┘
页面 ──就地求值（new Function + async IIFE）──▶ 结果
页面 ──POST /api/ui_probe/res──────────▶ 通道      → 唤醒正在等的人
                        ▲
                        └── POST /api/ui_probe/eval {expr}  ← 这一端"敲一行"，同步拿回活值
```

要点：

- **不需要给浏览器开调试端口**。CDP 要重启浏览器并带 `--remote-debugging-port`，而这条通道
  只是页面自己在轮询 —— 页面上线一次，之后永久可用。
- **指令是一次请求，不是状态**。队列里被取走就没了；没人取走也不留残渣，下一次心跳不会莫名干活。
- **连不上就当没有**。找不到收件人（产物旧了 / 通道没开）就安静退避（0.4s → 8s），不影响页面。
- 表达式允许 `await`：外层包了 `async IIFE`，于是 `await fetch(...)`、`await sleep(...)` 都能直接写。
- 结果强制过一道 JSON，带 200KB 上限；序列化不了（DOM 节点、fiber 环）就降级成描述，**不会把通道撑爆**。

页面侧随表达式可用的助手（`window.__uiProbe`，见 `ui/sampler_node/src/debug/live.ts`）：

| 助手 | 作用 |
| --- | --- |
| `q(sel)` / `rect(sel)` / `desc(el)` | 取节点、取几何、取"这是谁"的可读描述 |
| `handles()` | 每条边界：谁对谁、中心坐标、`elementFromPoint` **实际落到谁**、是否可达、cursor |
| `blocks()` | 每块：声明/显示/位置/`flex`/`min`/`scroll`，以及**中心点指针落在谁身上** |
| `drag(x, y, dx, dy)` | 在该点**真的拖一次**（合成 PointerEvent，走的是同一条 React 处理路径） |
| `trace.list()` | 最近事件：`drag` 记录里的 `a/b/floor/lo/hi/pointer/moved/commits/noops` |
| `snapshot()` / `report()` | 仍然可用；快照降级为"想留档时"的副产品 |

这一端的用法（`temporary/ui_probe_cli.py`，配合 `temporary/ui_probe_live.sh` 起本地三件套）：

```bash
python temporary/ui_probe_cli.py sessions          # 谁接上来了（sid / 心跳 / build / 视口 / URL）
python temporary/ui_probe_cli.py layout            # 全景：块、把手可达性、声明↔显示、问题
python temporary/ui_probe_cli.py eval "__uiProbe.blocks()[0]"     # 任意一行
python temporary/ui_probe_cli.py drag staging -120 # 真的拖一次，前后对照 + 那条 drag 记录
```

`drag` 的判读分叉正是它存在的理由：**"没有 drag 记录" = 指针压根没进到把手**（遮挡、
`pointer-events`、位置算错）；**"有 drag 记录但 `moved=0`、`noops>0`" = 指针进了，边界被夹死**。
这两种在截图里长得一模一样，只有这一对证据能把它们分开。

安全边界：通道只绑 `127.0.0.1`，绝不绑 `0.0.0.0`；只有**已经连上来的那个页面**会被求值，
通道本身不主动去找页面。它是本机开发工具，不是对外服务。

## 1.6 MCP 封装 —— 主入口（`tools/ui_probe_mcp.py`）

命令行那一版还是要"先生成一条命令、再读输出"，每一步都在提醒"这是个外部进程"。封成 MCP 之后，
读现场就是一个工具调用，对话里直接开着：

| 工具 | 回答的问题 |
| --- | --- |
| `ui_status` | 通道和页面在不在、页面 build、产物是否旧、编辑态与单元数（"读不到"时先跑这个） |
| `ui_layout` | 一屏全景：每块沿父轴的声明/实际尺寸、`flex`、每条把手的坐标与**指针实际落在谁身上**、不变量清单 |
| `ui_element` | 某个选择器的事实：盒子、计算样式、`data-*`、内容溢出、中心点命中谁、子元素、祖先链 |
| `ui_drag` | 在活页面里**真的拖一次**，给前后宽度 + `a/b/floor/lo/hi/pointer/moved/commits/noops` |
| `ui_trace` | 最近发生了什么（drag / drop / block.mode / error / resize） |
| `ui_tree` | 组件层级（React fiber，名字经 `keepNames` 保留） |
| `ui_eval` | 逃生口：在那一页里跑任意一行（等价 F12 控制台） |
| `ui_snapshot` | 抓一份落盘留证 |

三个设计决定：

1. **MCP 自己承载通道**。它启动时在 `8791` 上把通道起在后台线程里（daemon）。端口已被占
   （你手动起过 `temporary/ui_probe_sink.py`）就不抢，直接连上去 —— 于是"装 MCP"和"起 sink"
   是同一件事，不会互相打架。
2. **stdout 只准出现 JSON-RPC**。启动第一件事是 `os.dup(1)` 把真 stdout 私藏、再让 fd 1 指向
   stderr，所以任何 `print()`（包括库里的）都不会把协议打断。手写 MCP 最常翻的就是这辆车。
3. **读不到就说读不到**。没有页面接上来时立刻失败并说清缺哪一环，绝不编一份数据；
   `ui_element` 用坏选择器会**报错**而不是返回空结果——两者在排查时是完全不同的结论。

通道选择（`libs/ui_probe_live.candidates()`）：默认按 `8791 → 8700 → 8000 → 8188` 依次问"有没有活页面"，
取心跳最新的那条 —— 页面可能同时挂在同源后端和本地 sink 上，挑错那条只会得到空会话。
`UI_PROBE_BASE` 是**排他**的：设了它就只连它（测试与多实例需要这种确定性）。

配置（`~/.workbuddy/mcp.json`）：

```json
{
  "mcpServers": {
    "kolid-ui-probe": {
      "command": "C:/Users/Klein_Blue/.workbuddy/binaries/python/versions/3.14.3/python.exe",
      "args": ["F:/ComfyDB/custom_nodes/kolid-comfy/tools/ui_probe_mcp.py"],
      "type": "stdio"
    }
  }
}
```

改完配置不会自动生效：要在左下角插件菜单里的自定义连接器条目上点一次「信任」。
自测：`temporary/ui_probe_mcp_test.cjs`（M1 握手 → M12 协议没被污染，**37 项**）。

---

## 2. 采集的数据范围

一份快照（`kind: 'kolid-ui-probe'`, `version: 1`）分六块：

| 块 | 内容 | 为什么要在里面 |
| --- | --- | --- |
| `page` | URL、标题、视口/屏幕尺寸、DPR、UA、可见性、文档宽 vs 视口宽 | 视口是现场的一部分：同一份布局在 690px 和 1500px 下是两道不同的题 |
| `host` | 是否处于 block 编辑模式、单位总数、localStorage key | "现在是什么模式"决定了用户能做哪些手势 |
| `store` | 保存的布局**原文** | 重放靠它；也是"模型到底是什么"的第一手材料 |
| `outline` | 一行可读的布局摘要，如 `v[toolbar:60 \| h[v[340 context:free(v×3) \| pipeline:320] \| staging:898(v×20) \| doc:1:free]]` | 人一眼看懂整棵树，不必展开表格 |
| `dock.rows` | **逐节点一条平表**：声明尺寸、实际渲染尺寸、`flex`、`min/max`、`display/position/overflow`、`gap/padding/margin`、`zIndex`、`getBoundingClientRect`、`scrollWidth/Height` vs `clientWidth/Height`、可拖区间 `lo–hi`、深度、路径、是否折叠 | 声明 ↔ 显示是分辨"缩不动"的唯一一对数字 |
| `dock.floats` | 浮出窗口的列表 | 浮窗不在网格里，但也在同一个屏幕上 |
| `problems` | 探针自己的不变量检查结果（见 §4） | 交付结论本身 |
| `components` | React fiber 走一遍：深度、组件名、key、宿主元素标记、**props 形状** | 定位到"是哪一层组件"；props 只留形状（键、类型、长度），不塞整棵子树 |
| `trace` | 最近 240 条事件：安装、拖拽的 down/move/up、投放、模式切换、面板开合、错误、resize | "我刚做了什么"——没有它，几何只能猜 |
| `build` | 该页面的构建戳 | 见 §5 |

**刻意不采集**：图片/视频字节、prompt 文本、任何用户内容原文；props 只留形状。快照的上限 24MB
（`libs/ui_probe_store.MAX_BYTES`），超了说明抓错了东西。

---

## 3. 与编辑器的集成方式

三处接入，全部是**插入式**的，删掉就退回原样：

| 位置 | 做什么 |
| --- | --- |
| `src/debug/probe.ts` | 采集核心：DOM 读取、fiber 遍历、模型对齐、不变量检查、报告生成、快照组装。**不依赖任何应用组件**，只依赖 `registerProbe()` 送进来的那份 dock 模型 |
| `src/debug/install.ts` | 开机安装：热键、`window.__uiProbe` 接口、全局错误/resize 捕获、面板开关的订阅。`main.tsx` 里一行 `installProbe()` |
| `src/components/EditPhase.tsx` | 一行 `registerProbe({ dock, rules, edit })`：把**活的** dock 模型交给探针。这是唯一的耦合点，因为它就是"当前布局"的持有者 |
| `src/dock/DockView.tsx` | 两处纯标注：根 split 上的 `data-dock-root`（模型与 DOM 对齐的锚点）、拖拽/投放处的几行 `note(...)`。**没有分支逻辑**，`note` 不返回值、不改变控制流 |

DOM 对齐的规则与渲染逐字一致：**空巢不画、把手不算孩子**。于是"声明树"和"画出来的树"两边
都是"有东西的分支"按序配对；配不上本身就是一条结论（`dom.model-mismatch`）。

`data-dock-root` 挂在**根 split 自己**那一层而不是外面那层框——因为模型里没有"框"这一层，
锚点多一层，整棵树的第一行就会错位。

---

## 4. 数据获取与展示的流程

```
            ┌─ 页面（用户那台机器）─────────────────────────────┐
            │  Alt+D 面板 / 角标                               │
            │   ↓ probeSnapshot()                             │
            │  walkDock(模型↔DOM 对齐) → checkProblems(不变量)  │
            │   ↓ 快照                                          │
            │  probeSend()  ──POST /api/ui_probe──┐            │
            └────────────────────────────────────┼────────────┘
                                                 ↓
                        libs/ui_probe_store.save()
                          temporary/ui_probe/<id>.json   ← 机器可读
                          temporary/ui_probe/<id>.md     ← 人可读（结论 + 表格）
                                                 ↓
       ┌─────────────────────────────────────────┴──────────────┐
       │ 读取端                                                  │
       │  1. 直接读文件（无需任何接口，`cat` 就行）                │
       │  2. GET /api/ui_probe/{list,latest,get?name=,build}      │
       │  3. GET /api/ui_probe/view → 单文件快照查看器             │
       │  4. temporary/ui_probe.sh <名字> → **重放**并抓新快照      │
       └─────────────────────────────────────────────────────────┘
```

**为什么落成文件而不是数据库**：快照的消费者都处在"读一个 JSON 文件"的位置上；
文件放在 `temporary/ui_probe/` 明处，意味着**没有任何接口也能看**，接口只是方便。
索引单独一份 `index.json`，是因为列历史不该把每份几百 KB 的快照都读一遍。
保留 60 份：快照是"出问题的那一刻"，不是归档。

**重放（`temporary/ui_probe_replay.cjs` + `ui_probe.sh`）** 是这条回路的关键一步，
它把"用户描述问题"从**叙述**变成**提交**：

1. 读快照里的视口，把头无 Chrome 摆成同样大小（视口不对，问题就换了一道题）；
2. 把 `store.raw` 写回 `localStorage` 并重载（布局是从 localStorage 初始化的，写进去那刻不会自己回放）；
3. 抓一份新快照 + 一张截图，与源快照逐项对比：问题集合、布局、每一块的声明/显示。

一致就说明现场被完整搬过来了，此后所有的排查都在本机进行；不一致本身就是第一条线索。

---

## 5. 不变量检查（探针交付的"结论"）

| 代码 | 级别 | 判据 |
| --- | --- | --- |
| `dom.model-mismatch` | error | 模型里 N 个可见孩子，DOM 里画了 M 个 —— 渲染已与模型不同步，此时屏幕上的尺寸不能当模型的证据 |
| `block.declared-not-shown` | warn | 声明 Npx 实际显示 Mpx。**唯一能同时解释"缩不下去"和"拖了没动"的一对数字** |
| `split.oversubscribed` | warn | 一个分叉里"有尺寸"的孩子声明合计 > 盒子。最上游的矛盾，下面那些多半由它派生 |
| `block.zero-area` | error | 画了，但没有任何可供指针落下的面积 |
| `split.frozen-boundary` | warn | 把手的可拖区间 `hi − lo < 1` |
| `content.overflow` | info | 内容大于可见区，多出的部分不可见 |
| `page.spill` / `float.out-of-view` | warn | 页面横向溢出 / 浮窗跑到视口外 |

每条都带 `numbers`（产生它的那几个数字）——面板上就摆在结论旁边。

---

## 6. 预期的调试交互体验

| 动作 | 结果 |
| --- | --- |
| **Alt+D** | 拉开面板：问题（带证据数字）→ 布局事实表（声明/显示/flex/可拖区间逐节点并排）→ 轨迹 → 组件树 |
| **Alt+Shift+D** | 直接抓一份存档送到后端，不开面板 |
| 左下角**角标** | 常驻，`探针 正常` / `2 警告` / `1 错误`，每 2.5s 自检；点开即面板 |
| 面板上**发送到后端** | 落盘 + 回执；若后端发现"这一页比源码旧"，会把结论回传并在标题条上**常驻**提示 |
| 面板**打开期间拖拽** | 数字是活的：一边拖一边看着"声明"和"显示"怎么分叉，比事后任何一次快照都好用 |
| `window.__uiProbe` | `snapshot / report / trace / mark / send / copy / download / register / subscribe` —— 无头 harness 也走这里 |

面板刻意**只有观测，没有操作**：它不会去"修"布局。诊断工具一旦能改状态，下一个问题就变成
"到底是谁改的"。

**这条回路省掉了什么**（真实案例）：一次"右边的块宽度缩不小"的报告——
过去需要"你截图 → 我猜 → 你试着拖一下 → 我再猜"三轮；现在是一次 `Alt+Shift+D`，
我本机 `ui_probe.sh latest`，然后在轨迹里直接读到
`pointer=120, moved=0, commits=0, noops=8` —— 指针走了 120px、边界一步没动、
八帧全被丢弃。答案当场就在那条记录里，不需要再问任何人任何事。

---

## 7. 文件清单

| 文件 | 作用 |
| --- | --- |
| `ui/sampler_node/src/debug/probe.ts` | 采集核心 + 不变量 + 报告 |
| `ui/sampler_node/src/debug/install.ts` | 开机安装、热键、`window.__uiProbe` |
| `ui/sampler_node/src/debug/live.ts` | **实时巡检回路**：长轮询取指令、就地求值、回传；控制台式助手 `handles/blocks/drag` |
| `ui/sampler_node/src/debug/ProbePanel.tsx` | 面板与角标 |
| `ui/sampler_node/src/debug/viewer.html` | 独立单文件快照查看器（产物 `nodes/web/probe_viewer.html`） |
| `libs/ui_probe_store.py` | 后端存储：落盘 / 索引 / 读回 / 新旧判定 / `.md` 摘要 |
| `libs/ui_probe_live.py` | **通道协议**（唯一一份实现）：长轮询、结果回传、会话表、`Client`、通道选择 |
| `nodes/workbench/snapshot_sampler_node.py` | 路由 `/api/ui_probe`（含实时通道 `/cmd` `/res` `/eval` `/sessions`） |
| `tools/ui_probe_mcp.py` | **MCP 服务**：stdio JSON-RPC，自带通道，8 个工具 |
| `temporary/ui_probe_sink.py` | 独立通道进程（瘦壳，协议在 `libs/`；不重启 ComfyUI 也能用） |
| `temporary/ui_probe_cli.py` | 这一端的命令行：`sessions` / `layout` / `eval` / `drag` / `watch` |
| `temporary/ui_probe_live.sh` | 起 mock + 通道 + 无头 Chrome，然后对活页面问一句 |
| `temporary/ui_probe_test.cjs` | 自检 P1–P8（快照形状 / 不变量 / 轨迹 / fit / 面板 / 报告 / 回路 / 查看器） |
| `temporary/ui_probe_mcp_test.cjs` | MCP 自测 M1–M12（握手 / 工具表 / 每个工具 / 失败路径 / 协议洁净） |
| `temporary/ui_probe_replay.cjs` | 重放：快照 → 活页面 → 新快照 + 截图 + 逐项对比 |
| `temporary/ui_probe.sh` | 起停 mock + 无头 Chrome 并跑一轮重放 |

跑一遍：

```bash
cd ui/sampler_node && npm run build          # 构建戳会进产物
bash temporary/dock_suites.sh temporary/ui_probe_test.cjs       # 自检
bash temporary/dock_suites.sh temporary/ui_probe_mcp_test.cjs   # MCP 自检
bash temporary/ui_probe.sh latest            # 重放最新的一份快照

python temporary/ui_probe_sink.py &          # 实时通道（本机，127.0.0.1:8791）
python temporary/ui_probe_cli.py sessions    # 页面刷新后会自己接上来
python temporary/ui_probe_cli.py layout      # 读它现在的布局
python temporary/ui_probe_cli.py drag staging -120
```

> 生产构建开启了 `esbuild.keepNames`：组件名是探针最值钱的那一栏，而压缩会把 `App`/`EditPhase`
> 变成 `pb`/`Uv`。代价约 +18KB（gzip +6.5KB），换回的是一张读得懂的层级表。
