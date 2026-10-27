# Agent dock 窗

工作台右侧新的一扇 dock 窗(panel id `agent`,代理绿 #30d158)。两种形态,头部 DSH/Chat 分段切换
(记忆在 `sampler.agentMode`):**DSH 模式** = 内嵌 DeepSeek Harness(官方开源 coding agent,sidecar
+ iframe 它的 Web UI);**Chat 模式** = 内建轻量对话 agent。两者共享同一条工具面与设置。

## DSH 模式(默认)

- **启动**:窗内 Start(或 Settings ▸ Agent 的 Auto Start)→ Python 拉起 `npx -y @deepseek-ai/dsh
  web --no-open --port <dsh_port>`(Node.js;首跑 npx 要下载包),workspace =
  `data/sampler/dsh_workspace`,每次启动刷新那里的 **AGENTS.md**(告诉 harness 这是什么应用、怎么用
  `wb` 桥)。端口由 `start()` 显式追加 —— 状态机(`_port_alive`)与 cookie 的 authority 都按它走。
- **同站是嵌入的前置条件(踩过)**:dsh web 带 token 鉴权(`?token=…` → 303 +
  `Set-Cookie: dsh-auth-*; HttpOnly; SameSite=Strict`,JWT 里还绑死 `authority=127.0.0.1:<port>`)。
  Strict cookie 只在同站请求里发;祖先链上只要有一层跨站(页面在 `localhost`、iframe 在
  `127.0.0.1`),整条就按跨站算 —— 实测表现是 iframe 里一句 `dsh web authentication required`。
  所以页面一律走 `127.0.0.1`(`browser_url`;旧 `localhost` 页签在那三条页面路由上 302 过去),
  iframe 直连 `127.0.0.1:<port>`,**不要**换 `localhost`、也不要改 Host 试探 —— 两种都只会 401。
- **工具桥**:dsh 的 agent 在终端里跑 `tools/wb_agent.py`(stdlib-only CLI:ping/state/call)→
  `POST /api/agent/direct_tool` → 后端自呼 `/api/ui_probe/eval`(探针回路是 async IIFE)→ 页面上的
  `window.__wbAgentTool`(AgentPanel 挂载,包住 runAgentTool)执行并回 JSON。**工作台页面必须开着**
  工具调用才能落;Chat 模式那 38 个工具 + get_app_state 在 DSH 模式下原样可用。
- sidecar 管理:`nodes/workbench/agent_dsh.py`(start/stop/status;status 每次真探端口;进程自己
  死了就把输出尾巴当 `error` 交给面板,用户主动 stop 的则清空日志免得误报;stop 在 Windows 上
  `taskkill /T` 连根拔 shell=True 的进程树)。路由经 agent_backend 委派
  (`/api/agent_dsh/*` 与 `/api/agent/*` 同前缀族)。Settings ▸ Agent 有第二张卡:Port / Start
  Command / API Key(以 DEEPSEEK_API_KEY 注入)/ Auto Start。
- **小窗尺寸**:Harness 是 iframe,自己撑不出内容高度 —— dock 小窗按 `max-content` 会把它压成一条
  标题。页面在 `DockCtx.popSize` 里给 `agent` 报了 560×520 的盒子(DockView 拿它当固定尺寸),
  AgentPanel 的根节点也带 `flex:1 1 auto`。

## Chat 模式

**LLM 循环住在后端,工具住在浏览器。** 没有 websocket,与工作台同一条 HTTP 轮询口径:

```
AgentPanel ──POST /api/agent/send{text,history}──▶ AgentRun(守护线程,LLM 循环)
AgentPanel ◀─GET  /api/agent/poll?cursor&wait=1──  事件流:text / tool_call / tool_result / error
AgentPanel ──POST /api/agent/tool{results}──────▶  结果喂回 LLM,循环继续
```

- 后端编排:`nodes/workbench/agent_backend.py` —— run 状态机(running/wait_tool/done/error/
  cancelled)、38 个工具的 schema(唯一真源)、设置存储、OpenAI 兼容 `/chat/completions` 客户端
  (requests,无流式)。路由由 `snapshot_sampler_node.py` 的 do_GET/do_POST 以 `/api/agent` 前缀
  整族转发;`agent_backend` 导入失败只少这扇窗,不拖死节点。
- 前端执行:`ui/sampler_node/src/agent/tools.ts` —— `runAgentTool(name, args, ctx)` 按名字分发;
  `AgentCtx` 由 EditPhase 组装(uiSend、vidCtl、blockSets、vgen、Run/Doc 写口)。
  `AgentPanel.tsx` —— 聊天 UI、长轮询回路;ctx 走 latest-ref,历史存
  localStorage `sampler.agentChat.v1`(只回传 text 部分)。LLM 配置卡在 EditPhase 的
  `AgentConfigRows`(Settings 页 ▸ Agent 屏,与 AgentPanel 共享 /api/agent/config 唯一真源)。
- dock 接线:七处照 vkf 先例(PANEL_IDS / UNIT_TITLES / UNIT_COLORS / fullBleed / grows /
  blockSize / right)+ bodies;图标在 `workbench/icons.tsx`(`Agent` 四角星)。旧布局由
  fitLayout 自动补入。

## 工具面(38 个)

`get_app_state`(全家桶快照)· 传输 seek/play/pause · 时间线 select_clips/add_track/
remove_track/rename_track/place_asset/move_clip/trim_clip/split_clip/remove_clips/add_layer_clip ·
图层 select_layer/add_layer/remove_layer/duplicate_layer/rename_layer/set_layer_opacity/
toggle_layer_visibility/layer_generate/layer_from_asset · 生成 run_pipeline/run_blend/run_tag/
cancel_run/set_extra_prompt · 画布 set_canvas_size/view_fit/set_paint_color/set_brush/undo/redo ·
视频工程 set_fps/add_vgen_segment/add_continue_segment/document(new|save)。

改动都走既有写口(vid.update + History label、uiSend 动作键),所以撤销栈、脏标记、.cud 存档
全部天然成立。关键帧/Text/Geometry/Pose/3D 的深编辑面暂未开放 —— 加新工具 = 后端 `_fn` 一条
schema + tools.ts 一个 case。
