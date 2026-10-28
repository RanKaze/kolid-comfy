# Agent dock 窗

工作台右侧的一扇 dock 窗(panel id `agent`,代理绿 #30d158)。窗里只有一种形态:**DeepSeek
Harness**(官方开源 coding agent,sidecar + iframe 它的 Web UI)。曾有的内建 Chat 模式已撤掉
——它的 LLM 循环还在 `agent_backend.py` 里,但界面上没有入口,也不再是使用路径。

## 启动与嵌入

- **启动**:窗内 Start(或 `data/sampler/agent_settings.json` 里 `dsh_autostart=true`)→ Python
  拉起 `npx -y @deepseek-ai/dsh web --no-open --port <dsh_port>`(Node.js;首跑 npx 要下载包)。
  Settings 页不再提供 Agent 屏;端口/命令/API key 直接读那份 JSON(缺省 3080 / npx 命令 /
  autostart=false)。
- **工作区**:子进程 cwd = 当前 cud 的目录(没有 cud 就是仓库根)。Agent 窗通过
  `POST /api/agent_dsh/bind` 把目录报给后端,再用 postMessage 通知页面里的
  `kolid-dsh-bind` 插件;插件把那个目录钉成工作区、藏掉其余工作区/添加/切换/搜索入口。
- **同站是嵌入的前置条件(踩过)**:dsh web 带 token 鉴权(`?token=…` → 303 +
  `Set-Cookie: dsh-auth-*; HttpOnly; SameSite=Strict`,JWT 里还绑死 `authority=127.0.0.1:<port>`)。
  Strict cookie 只在同站请求里发;祖先链上只要有一层跨站(页面在 `localhost`、iframe 在
  `127.0.0.1`),整条就按跨站算 —— 实测表现是 iframe 里一句 `dsh web authentication required`。
  所以页面一律走 `127.0.0.1`(`browser_url`;旧 `localhost` 页签在那三条页面路由上 302 过去),
  iframe 直连 `127.0.0.1:<port>`,**不要**换 `localhost`、也不要改 Host 试探 —— 两种都只会 401。
- **小窗尺寸**:Harness 是 iframe,自己撑不出内容高度 —— dock 小窗按 `max-content` 会把它压成一条
  标题。页面在 `DockCtx.popSize` 里给 `agent` 报了 560×520 的盒子(DockView 拿它当固定尺寸),
  AgentPanel 的根节点也带 `flex:1 1 auto`。
- sidecar 管理:`nodes/workbench/agent_dsh.py`(start/stop/status;status 每次真探端口;进程自己
  死了就把输出尾巴当 `error` 交给面板,用户主动 stop 的则清空日志免得误报;stop 在 Windows 上
  `taskkill /T` 连根拔 shell=True 的进程树)。

## Agent 操作工作台的三条通道

工具真身住在浏览器里(`ui/sampler_node/src/agent/tools.ts::runAgentTool`),三条入口最终都落到
同一处:后端 `POST /api/agent/direct_tool` → 自呼 `/api/ui_probe/eval` → 页面上的
`window.__wbAgentTool`(AgentPanel 挂载时安装)。**工作台页面必须开着**,关着会明确报
`workbench page not loaded`。

| 通道 | 装在哪 | 用途 |
|---|---|---|
| MCP `kolid-workbench`(`tools/wb_mcp.py`) | dsh profile 的 `cordis.patch.yml`(agent_dsh 启动时写) | 全部工具原样暴露成 `mcp__kolid-workbench__<tool>`;schema 经 `GET /api/agent/tools` 取(后端热读构建产物),不手抄 |
| MCP `kolid-ui-probe`(`tools/ui_probe_mcp.py`) | 同上 | 只读现场:布局几何、命中、拖拽实测、轨迹、React 层级、快照 |
| CLI `wb`(`tools/wb_agent.py`) | 无需安装,shell 直接跑 | `ping` / `state` / `call <tool> '<json>'`;给没有 MCP 的 agent 与手工排障 |

全局 `~/.dsh/AGENTS.md` 里有一段由 `agent_dsh.py` 维护的桥接说明(成对注释包住,原地替换),
告诉 harness 这三条通道与工具清单。

## 工具面(64 个)

`get_app_state`(全家桶快照) · **`get_ui_actions` / `ui_action`(见下节:整张界面动作表)** ·
传输 seek/play/pause/set_timeline_zoom · 时间线 select_clips/add_track/remove_track/rename_track/
move_track/toggle_track_mute/toggle_track_solo/set_mask_track/place_asset/move_clip/trim_clip/
split_clip/remove_clips/add_layer_clip/toggle_vgen_chain · 图层 select_layer/add_layer/remove_layer/
duplicate_layer/rename_layer/set_layer_opacity/toggle_layer_visibility/layer_generate/layer_from_asset/
**create_comic_layout** · 生成 run_pipeline/run_blend/run_tag/cancel_run/set_extra_prompt · 画布
set_canvas_size/view_fit/set_paint_color/set_brush/undo/redo · 视频工程 set_fps/add_vgen_segment/
add_continue_segment/document(new|load|save|save-as|export-png|import|close) · Prompt 库读写 18 条。

`create_comic_layout` 是唯一一条**高层排版**工具:一次调用摆出整页漫画格 —— 纸(可选)+ 每格一张
与格等大的空层(命名 Panel N)+ 最上面一张线稿层,整页只落一步历史。几何(边距/沟槽/权重)在
`ui/sampler_node/src/agent/tools.ts` 里算,页面 (`panel-layout` 动作 → `applyPanelLayout`) 只照
矩形建层;`rows/cols` 出规则网格,`panels` 出不规则页。它下面没有任何新的图层原语 —— 用的还是
`addSurfaceLayer` 那条既有写口,只是多了 `quiet`/`noHistory` 两个可选开关好让一批层合一步撤销。

改动都走既有写口(vid.update + History label、uiSend 动作键),所以撤销栈、脏标记、.cud 存档
全部天然成立。关键帧/Text/Geometry/Pose/3D 的深编辑面暂未开放 —— 加新工具 = `toolSchemas.ts`
一条 schema + `tools.ts` 一个 case(编译期互相咬合,见下),两个 MCP 都会自动跟上。

## 工具面的真源在前端(以及为什么)

schema 曾经在 `agent_backend.py` 的 `AGENT_TOOLS` 里、执行体在 `tools.ts` 的 switch 里,靠
`tests/agent_coverage.py` 事后对账。三个毛病:**改一句话要重启后端**;**漏写只有跑测试才发现**;
两边是两种语言,类型系统帮不上忙。

现在只有一份真源,而且它和执行体住在同一个目录:

```
ui/sampler_node/src/agent/toolSchemas.ts     ← 名字 / description / 参数表(唯一真源)
        │                                    ← tools.ts 的 switch 用 AgentToolName 咬住
        ├── 打包进 bundle(执行体在浏览器)
        └── tools/gen_agent_tools.cjs ──► nodes/workbench/agent_tools.json
                                              │  构建 closeBundle 里自动跑
                                    agent_backend.load_agent_tools() 按 mtime 热读
                                              │
                                    GET /api/agent/tools   (现取,不缓存成模块常量)
                                              │
                                    tools/wb_mcp.py 按 sha 判断 + tools/list_changed
```

**防漏是编译期的,不是测试期的。** `tools.ts` 里 `switch` 的是 `AgentToolName`(字面量联合):

| 你干了什么 | `tsc` 说什么 |
|---|---|
| 在 `toolSchemas.ts` 加一条,没写执行 | `default` 里 `const missing: never = tool` → **TS2322**,加不了 |
| 写了 `case 'x'` 但 schema 没登记 | `case` 与联合无重叠 → **TS2678**,加不了 |

两条都验过(临时插入后 `tsc --noEmit` 报错,恢复后干净)。所以"某次之后漏写"这件事在构建那一步
就被拦下 —— 不依赖谁记得跑测试。

**改工具不再需要重启后端。** `AGENT_TOOLS` 那个模块级常量已删除,`load_agent_tools()` 每次按
`(mtime_ns, size)` 判断是否重读;构建用 `rename` 原子落盘,读坏时保留上一份(不让 agent 忽然
没有工具)。产物由 vite 的 `closeBundle` 自动重写,所以"改了 TS 忘了同步"也不存在 —— 除非有人
手改了 `agent_tools.json`,那 G2b 会红。

## 覆盖面:让"用户能做的"等于"agent 能做的"

问题不是"再加几个工具",而是**怎么保证不漏** —— 手抄清单一定漏,漏了还没人发现。所以这里不靠
清单,靠几条**从源码算出来**的尺(`tests/agent_coverage.py`):

| 尺 | 盯什么 | 红了说明 |
|---|---|---|
| G1 | `nodes/workbench/ui_actions.json` 与 `ui/sampler_node/src/agent/uiActions.generated.ts` 必须等于 `types.ts` 当前的样子 | 界面加了按钮/改了动作键,没重跑 `node tools/gen_ui_actions.cjs` |
| G2 | `toolSchemas.ts` 的名字集合 == `tools.ts` 里 `case '<name>':` 的集合 | 只改了一半(其实是 G2b 的软备份:真正的闸是 `tsc`) |
| G2b | `nodes/workbench/agent_tools.json` == `toolSchemas.ts` 的当前样子 | 产物落后:只改了 TS 没构建,或有人手改了 JSON |
| G3 | `nodes/workbench/agent_coverage.json` 里每个 `tool` 真的存在;每条 `missing` 都写了 `why` | 账本烂了 / 欠账没写清楚补什么 |
| R1(报告) | `model.ts` 导出、但 `tools.ts` 一次没用到的纯函数 | "用户能做、agent 做不到"的雷达 |
| R2(报告) | 账本按组列 covered/missing | 下一批补什么的顺序 |

**第一层 · 页面动作键(125 条,100%)。** 工作台每一个按钮 / 滑杆 / 菜单项都落到 `BlendUiAction`
的一个键上,载荷表 `BlendUiPayloads` 在编译期已由 `BlendUiPayloadGap` 钉成 1:1。`tools/gen_ui_actions.cjs`
把这两份类型生成为动作目录(TS 模块 + JSON),`ui_action` 按目录执行、`get_ui_actions` 按目录交清单。
⇒ **界面加一个按钮,agent 当天就会按**,中间没有手抄的一步;拼错的键被 `UI_ACTION_IDS` 挡在宿主,
不会出现"页面静默不动、模型以为按了"。

**第二层 · 不是按钮的操作(55 条,`agent_coverage.json`)。** 文档、时间线上的拖轨/静音/solo/
缩放/掩码轨、资产窗、停靠面板 —— 它们直接写工程或改界面状态,没有动作键。这一层用账本逐个表态:
`tool` = 已覆盖,没有就 `state:"missing"` + `why`(为什么还没有、下一批怎么补)。当前 44/55。

**第三层 · 还没做的。** `--strict` 会让 R1/R2 也变硬 —— 等欠账清得差不多,把它挂进 CI 就是
"以后谁加一边不加另一边,谁红"。

```bash
python tests/agent_coverage.py            # 报告(闸 + 覆盖率 + 欠账 + 雷达)
python tests/agent_coverage.py --strict   # 有欠账/雷达项就退 1
python tests/test_agent_tool_catalog.py   # 热读契约:不用重启 / 读坏留上一份 / 产物不落后
node tools/gen_ui_actions.cjs             # 改过 types.ts 的动作键后重跑
cd ui && npm run build -w sampler_node    # 改过工具 ⇒ 构建(顺带重写 agent_tools.json)
```

**加一个新工具的规矩**(只有两步,都在前端):

1. `ui/sampler_node/src/agent/toolSchemas.ts` 里加一条 `{name, description, parameters}`;
2. `ui/sampler_node/src/agent/tools.ts` 里加对应 `case`(不写 `tsc` 就报 TS2322);
3. `npm run build -w sampler_node` —— 构建重写 `agent_tools.json`,后端下一次请求就能看见,
   MCP 两秒内发 `tools/list_changed`;
4. 若它对应"用户能在面板上做的某件事",在 `agent_coverage.json` 里把那条的 `missing` 改成 `tool`。

**界面新按钮不需要动这里** —— 它落在动作键上,`ui_action` 自动覆盖。


## dock 接线

七处照 vkf 先例(PANEL_IDS / UNIT_TITLES / UNIT_COLORS / fullBleed / grows / blockSize / right)
+ bodies;图标在 `workbench/icons.tsx`(`Agent` 四角星)。旧布局由 fitLayout 自动补入。
