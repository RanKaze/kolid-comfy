# Audio Bus / Audio Interface / Audio Object + Keyframe 音频事件点

## Context

目前时间线只有「音频轨 + 每轨推子」这一层混音能力（`VidProject.audioGain` → `pcmClips` → 原生引擎 `pcm_set` 的 `gain`），没有可复用的声音定义/触发体系。本次新增三扇 dock 窗与一类关键帧事件点，让用户把「一组音频」（Audio Object）绑定到「带参数的事件」（Audio Interface Event），参数经曲线/布尔调制 Bus 链路增益，再由 Keyframes 窗里的项目级事件点在播放头越过时触发一次。三套定义**随工程（.cud / 页面存档）走**，另可存为可复用预设。

已与用户确认：
- 数据作用域：项目级 + 可存/取预设。
- 槽位：先支持 1 条音频，但模型存数组，后续可扩多条。
- Bus：串联相乘、父级作用于子级（DAG，禁止回环）。
- 事件点：Keyframes 窗顶部项目全局泳道，绝对秒；播放头向前越过触发一次；暂停/回退/seek 不补触发；循环回绕后重新武装。

---

## 1. 数据模型

新文件 `ui/sampler_node/src/workbench/video/audioDefs.ts`：纯类型 + 校验/收敛函数（不 import model.ts，model 反向 `import type`，避免环依赖）。所有实体 id 全局唯一，统一用 `newVidId()`（model.ts:1054）。

```ts
export type AudioCurvePoint = { u: number; g: number };          // 均 0..1
export type AudioParamDef = {
  id: string; name: string;
  kind: 'float' | 'boolean';
  value: number;                 // 默认值：float 0..1 / boolean 0|1
  invert?: boolean;              // 仅 boolean
  curve?: AudioCurvePoint[];     // 仅 float，缺省线性
  busIds: string[];
};
export type AudioEventDef = { id: string; name: string; busIds: string[]; params: AudioParamDef[] };
export type AudioInterfaceDef = { id: string; name: string; events: AudioEventDef[] };
export type AudioBusDef = { id: string; name: string; gain: number; busIds: string[] }; // busIds = 子总线

export type SlotAudio = { id: string; name: string; asset?: string; url: string; duration?: number; gain?: number };
export type AudioObjectDef = {
  id: string; name: string;
  ifaceIds: string[];
  slots: Record<string, SlotAudio[]>;   // key = eventId；值始终是数组（先限 1 条）
};
export type AudioEventPoint = {
  id: string; t: number;                 // 绝对时间线秒
  objectId: string; ifaceId: string; eventId: string;
  values: Record<string, number>;        // paramId → 0..1 / 0|1
};
```

`VidProject`（model.ts:871）追加可选字段：`audioBuses`、`audioInterfaces`、`audioObjects`、`audioEventPoints`。

**`normalizeVidProject`（model.ts:3219 return 处）必须显式展开**（该函数不 spread 未知字段），调用 `normalizeAudioDefs(raw)`：
- 数组按 id 去重（首条胜出）、空名回退；
- Bus：`gain` 夹 0..2；`busIds` 去重、删自引用/悬空；按数组序 DFS，会成环的边直接丢弃 → 确定性 DAG；
- Interface/Event/Param：逐层去重；event/param 的 `busIds` 只留活总线；curve 点夹 0..1、按 u 排序去重；
- Object：`ifaceIds` 只留活接口；`slots` 只保留「已挂接口下的 eventId」，每条 SlotAudio 补 id、`url` 由 `asset` 重建（`/api/asset_media/<hash>`，无哈希且 blob: 的丢弃）、`gain` 夹 0..2；
- EventPoint：`t >= 0`；object/iface/event 任一悬空则删；缺失 ifaceId 但 event 属于已挂接口时自动补；`values` 只留该 event 的 param 并夹值；按 t 升序；
- 空集合写 `undefined`（与 `audioGain` 同风格）。

`.cud` 走 `header.video` 整份 JSON，无需改存盘代码。

---

## 2. 总线求值

新文件 `audioRouting.ts`（纯函数）：

- `reach(roots, buses, seen)`：迭代 DFS 收集从 roots 可达的所有 bus，**跨本次求值共享 `seen`**（同一总线只乘一次 = 序列相乘、不因分叉重复计入），也天然防环。
- 一个事件点的总增益：
  1. `g = 1`，`seen = new Set()`；
  2. `reach(event.busIds)`，逐个乘 `bus.gain`；
  3. 每个 param 取 `values[param.id] ?? param.value`：
     - float：`pg = evalCurve(curve, clamp01(v))`（首尾外取端值、点间线性、无点=恒 1）；`g *= pg`；
     - boolean：`on = !!v; if (invert) on = !on; g *= on ? 1 : 0`；
     - 再 `reach(param.busIds, seen)` 并乘新增 bus 的 gain；
  4. 返回 `clamp(g, 0, 2)`（与引擎 `pcm_set` 的 0..2 一致）。任一引用悬空 → 0。

---

## 3. 三扇 dock 窗

均放 `ui/sampler_node/src/workbench/video/`，走宿主面板（`vidCtl.project` / `vidCtl.update(fn, label)`）：

- `AudioBusPanel.tsx`（`vbus`）：左列总线表（增/删/改名）；右侧详情：gain 滑杆 0..2、子总线复选。勾选前用 `wouldCycle(parent, child)` 禁用非法项；删总线时级联从其它 bus / event / param 的 busIds 摘除。
- `AudioInterfacePanel.tsx`（`viface`）：左接口表；右侧接口名 → 事件表（增删改名）→ 事件挂载总线 → 参数表（名字、float/boolean、默认值、挂载总线；float 内嵌曲线缩略按钮，boolean 带 invert）。
- `AudioObjectPanel.tsx`（`vobj`）：左对象表；右侧对象名、已挂接口复选；槽位按接口分组，槽名 = 事件名。每个槽是 drop target，接受 `application/x-asset` / `application/x-vid-asset` / `application/x-vid-global` / `application/x-blend-staging` / `Files`，只收 `kind==='audio' || isAudioName(name)`；带哈希的零拷贝记 `asset`，只有 URL 的先 `fetch` + `/api/asset_import` 收进仓库（参考 Timeline.tsx:83-98 `importFrameImage`）；落下即写入 `slots[eventId]` 数组。每条 SlotAudio 一行：名字、微调 gain、移除。
- `CurveEditor.tsx`：96–140px SVG；双击加点、拖点、右键/Alt 删点、"Linear" 复位；拖动 label 带 paramId，合并为一步撤销。
- `audioPresets.ts` + `AudioPresetBar`：`localStorage['sampler.audioPresets.v1']` 存 `{version, presets:[{id,name,at,buses,interfaces,objects}]}`；Save = 深拷贝命名保存；Load = **全部实体换新 id 并重写所有引用**（bus 子、param bus、event bus、object iface、slot eventId）后 merge 进工程；另提供 Export/Import JSON。

所有增删改走 `vid.update`，label 形如 `'Audio bus gain · '+id`、`'Audio slot · '+eventId`。

---

## 4. Keyframes 集成（项目全局事件泳道）

**不改 `VidKeyframes.channels`**（那是每段归一化的数字通道）；事件点单独存 `project.audioEventPoints`（绝对秒）。

新文件 `AudioEventsLane.tsx`，在 `Keyframes.tsx` 根节点内、现有 Layer 内容之前渲染：

- 早期 `if (!clip) return <empty>`（Keyframes.tsx:860）改为：始终渲染泳道；无 Layer 选中时，下方显示原空态句。
- 标尺：绝对秒，`pps = laneWidth / max(vidDuration(p), 1)`（ResizeObserver）；刻度复用 `rulerStep`/`fmtTime`；播放头读 `transport.get()` 直写 transform。
- 单行「Audio Events」+ 菱形点：双击空白加点（吸附 6px：其它事件点 / inPoint / outPoint / 播放头 / 当前 Layer 段 `clip.start`）；拖点改 `t`（`'Move audio event'`）；Delete/右键删。
- 选中点的 Inspector（泳道下方，约 96px）：Audio Object → Interface → Event 三级下拉（只列对象已挂接口与其事件），随后按事件 params 渲染 float range（旁边给出曲线映射后的增益读数）与 boolean toggle；写 `'Audio event values · '+pointId`。
- 不碰现有 `kfSelection` / `kfArmed` / 框选逻辑。

---

## 5. 播放

新文件 `audioEventPlayback.ts`，导出 `useAudioEventPlayback(project)`，在 `EditPhase.tsx:1350` 与 `useTimelineAudio` 并列调用。

- 订阅 `clock`；仅 `transportOwner.isOwner()` 的窗触发（避免多窗双响，与 timelineAudio 同口径）。
- 状态 `prevT / wasPlaying`：
  - 停播：`prevT = t`；从播放→停止时清空所有 one-shot（防止下次播放时上一遍的尾巴又响）；
  - 刚开播：`prevT = t`，不补发；
  - `t < prevT`（回绕/回退）或 `t - prevT > max(0.3, 3/fps)`（seek）→ 清空 one-shot、`prevT = t`、不补发；
  - 否则取 `(prevT, t]` 内的事件点升序触发。
- 触发：用 §2 算 gain；`slots[eventId]` 数组逐个播放，clip id = `evt:<pointId>:<slotAudioId>:<seq>`；`pcm_set({gen:0, start, offset, length, gain})`。若检测晚于事件点 >30ms，则 `start=now`、`offset=now-t`，保持对齐。
- 复用 `pcmClips.ts` 的 `decodeAudio` / 上传逻辑：把 `post`、`pcmOf`、`toBase64`、`RATE`、`CHUNK_FRAMES` 导出或抽成 `pcmIo.ts`，共享 `pcmCache`；播放结束后 `pcm_clear`。
- 并发上限 16 条 one-shot（后端 `PCM_MAX_SLOTS = 64`，与时间线共用），超出按最早结算；`not_owner` 直接放弃本次发声。
- 事件声音**不经过**轨道 mute/solo/`audioGain`：它没有轨道，路由与增益完全由 event/param/bus + 曲线决定。

---

## 6. dock 注册清单（EditPhase.tsx）

- `PANEL_IDS`：在 `'vfader'` 后插入 `'vbus','viface','vobj'`。
- `UNIT_TITLES`：`vbus:'Audio Bus', viface:'Audio Interface', vobj:'Audio Object'`。
- `fullBleed` / `grows` / `right` 三处都补三项（right 紧跟 `'vfader'`）。
- `blockSize`：`vbus 420/640`、`viface 520/760`、`vobj 460/680`（v/h）。
- `bodies`（约 4726 行）：无打开文档时 `<div style={styles.vidVoid}>No project open…</div>`，否则挂对应面板。
- `workbench/icons.tsx`：新增三个 16px 图标并登记 `UNIT_ICONS`。
- `dock/model.ts` `fitLayout`：仿 `pipeline/presets` 特例，在通用补缺循环前把三个新面板依次 `dropInDock(..., id, anchor, 'bottom')`，锚点优先 `vfader` → `vaudio` → `vkf`，保证老布局升级后三窗可见且成组。

---

## 7. 分阶段交付

1. `audioDefs.ts` + model 接线 + normalize（无 UI）→ 构建通过，.cud 读写不丢字段。
2. `audioRouting.ts` + 曲线求值（诊断口验证串联相乘与 DAG 去重）。
3. 三扇面板 + 曲线编辑器 + dock/图标注册 → 老布局打开后三窗出现在 Fader 下方。
4. Keyframes 全局事件泳道 + Inspector → 无 Layer 选中仍可见可用，原有 Layer 关键帧无回归。
5. `audioEventPlayback.ts` + pcm 导出 → 穿越响一次、暂停/回退/seek 不响、循环每圈重响、Monitor 有峰值。
6. Presets 存取/重映射 → 新工程载入预设后事件仍能触发。

## 8. 验证

- `ui/sampler_node` 下 `npm run build`（tsc + vite，产物写入 `nodes/web/sampler_node.html`），浏览器硬刷新。
- 手动回归：建 bus 嵌套（拒绝成环）→ interface 建事件/参数（float 曲线、bool invert）→ object 挂接口并拖入音频 → Keyframes 加点选事件调参 → 播放穿越试听；暂停/回退/seek 不补触发；循环每圈重响；保存 .cud 重开后定义与事件点完整；撤销一次拖动 = 一步。

## 9. 风险

- PCM 槽位 64 与时间线共用：必须严格 clear + 并发上限，否则会挤掉时间线片段（必要时再评估提高 `PCM_MAX_SLOTS` / DLL `KA_MAX_CLIPS`）。
- `ka_pcm_set` 对「start 在过去」的具体行为未知：已用 `start=now + offset=now-t` 兜底；实现后需实测一次。
- 预设存 localStorage 不随 .cud 迁移，故提供 Export/Import JSON。
