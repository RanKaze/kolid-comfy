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
| MCP `kolid-workbench`(`tools/wb_mcp.py`) | dsh profile 的 `cordis.patch.yml`(agent_dsh 启动时写) | 38 个工具原样暴露成 `mcp__kolid-workbench__<tool>`;schema 经 `GET /api/agent/tools` 从 `AGENT_TOOLS` 取,不手抄 |
| MCP `kolid-ui-probe`(`tools/ui_probe_mcp.py`) | 同上 | 只读现场:布局几何、命中、拖拽实测、轨迹、React 层级、快照 |
| CLI `wb`(`tools/wb_agent.py`) | 无需安装,shell 直接跑 | `ping` / `state` / `call <tool> '<json>'`;给没有 MCP 的 agent 与手工排障 |

全局 `~/.dsh/AGENTS.md` 里有一段由 `agent_dsh.py` 维护的桥接说明(成对注释包住,原地替换),
告诉 harness 这三条通道与工具清单。

## 工具面(39 个)

`get_app_state`(全家桶快照)· 传输 seek/play/pause · 时间线 select_clips/add_track/
remove_track/rename_track/place_asset/move_clip/trim_clip/split_clip/remove_clips/add_layer_clip ·
图层 select_layer/add_layer/remove_layer/duplicate_layer/rename_layer/set_layer_opacity/
toggle_layer_visibility/layer_generate/layer_from_asset/**create_comic_layout** · 生成 run_pipeline/
run_blend/run_tag/cancel_run/set_extra_prompt · 画布 set_canvas_size/view_fit/set_paint_color/
set_brush/undo/redo · 视频工程 set_fps/add_vgen_segment/add_continue_segment/document(new|save)。

`create_comic_layout` 是唯一一条**高层排版**工具:一次调用摆出整页漫画格 —— 纸(可选)+ 每格一张
与格等大的空层(命名 Panel N)+ 最上面一张线稿层,整页只落一步历史。几何(边距/沟槽/权重)在
`ui/sampler_node/src/agent/tools.ts` 里算,页面 (`panel-layout` 动作 → `applyPanelLayout`) 只照
矩形建层;`rows/cols` 出规则网格,`panels` 出不规则页。它下面没有任何新的图层原语 —— 用的还是
`addSurfaceLayer` 那条既有写口,只是多了 `quiet`/`noHistory` 两个可选开关好让一批层合一步撤销。

改动都走既有写口(vid.update + History label、uiSend 动作键),所以撤销栈、脏标记、.cud 存档
全部天然成立。关键帧/Text/Geometry/Pose/3D 的深编辑面暂未开放 —— 加新工具 = 后端 `_fn` 一条
schema + tools.ts 一个 case;两个 MCP 都会自动跟上(编辑 MCP 的工具表是运行时取的)。

## dock 接线

七处照 vkf 先例(PANEL_IDS / UNIT_TITLES / UNIT_COLORS / fullBleed / grows / blockSize / right)
+ bodies;图标在 `workbench/icons.tsx`(`Agent` 四角星)。旧布局由 fitLayout 自动补入。
