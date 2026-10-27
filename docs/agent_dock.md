# Agent dock 窗

工作台右侧新的一扇 dock 窗(panel id `agent`,代理绿 #30d158):一条对话栏,AI 通过工具调用直接
操作应用 —— 时间线、图层、生成、画布、资产全在射程内。

## 用法

1. 打开工作台 → 右栏(或 tab)找到 **Agent** 窗。
2. 先到 **Settings 页 ▸ Agent 屏**(分段控件第三格)填 LLM 端点(OpenAI 兼容):Base URL
   (默认 `https://api.z.ai/api/paas/v4`)、API key、Model(默认 `glm-4.6`)、Temperature /
   Max Steps / Extra Prompt。保存到 `data/sampler/agent_settings.json`。Agent 窗的状态行会提示
   "no API key (Settings ▸ Agent)"。
3. 直接说需求:它会先 `get_app_state` 看现场,再调工具动手,每一步在聊天里以工具行呈现
   (点开看参数与结果)。

## 架构

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
