# 🔀 分支/流程控制节点

[← 返回主 README](../README.md)

分支节点系统提供工作流级别的流程控制能力，包括：条件输出、节点静音/旁路/折叠、布尔逻辑中继、多路选择、分组管理等。所有配置在前端实时解析并可视化高亮，支持跳转到引用节点。

---

### BranchNoneNode

None 值分支。当 `check` 输入为 None 时输出 `on_none`，否则输出 `check`。支持 lazy 加载——当 `check` 不为 None 时，`on_none` 的上游节点不会被执行。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| check | * | ✅ | 检查值（任意类型） |
| on_none | * | ❌ | check 为 None 时的输出（lazy 加载，不触发上游执行） |

**输出:** `*` (任意类型)

**示例:** 上游可选连接可能返回 None 时，用此节点提供默认值。连接 `check` = 可选输入，`on_none` = 默认值。

---

### IsOptionalNoneNode

可选输入检测。检测可选输入是否为 None（未连接），输出布尔值。接受任意类型输入，不做类型检查。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| check | * | ❌ | 可选输入值（未连接时输出 True） |

**输出:** `is_none` (BOOLEAN)

---

### BranchOptionalRequiredNode

可选转必需。将可选输入作为必需输出传递。当输入未连接时输出 None，但不报错。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| required | * | ❌ | 可选输入值 |

**输出:** `required` (任意类型)

---

### BranchGroupNode

分支组节点。纯前端节点，用于批量管理一组 BranchSwitchNode / BranchBooleanNode。

节点本身不执行任何逻辑，但在前端通过 properties 配置后，会自动在节点上生成 combo/toggle 控件来控制匹配的分支节点。

**前端 Properties（右键节点 → Properties）：**

| Property | 类型 | 默认值 | 说明 |
|----------|------|--------|------|
| `branch_mode` | COMBO | `"Default"` | 控件模式：`Default`=每个分支节点显示为独立 toggle；`MaxOne`=所有分支节点打包为一个 combo（含 `[None]` 选项，最多选一个）；`AlwaysOne`=打包为 combo（不含 `[None]`，必须选一个） |
| `collect_BranchSwitchNode` | BOOLEAN | `true` | 是否收集 BranchSwitchNode |
| `collect_BranchBooleanNode` | BOOLEAN | `true` | 是否收集 BranchBooleanNode |
| `match_regex` | STRING | `""` | 正则过滤：只收集 title 匹配的分支节点 |
| `expand_nodes` | STRING | `""` | 展开节点路径（`/` 分隔），用于嵌套展开 |

**匹配规则：** 同一 graph 中，title 匹配 `match_regex` 且颜色与 BranchGroupNode 相同的分支节点会被收集。

**MaxOne / AlwaysOne 模式：** 切换 combo 时会自动设置对应分支节点的 toggle 值，并触发 `active_config` / `relay_expression` 联动。

**输出:** 无

---

### BranchSwitchNode

布尔开关。`toggle` 为 True 时输出 `value`，否则输出 None。支持 lazy 加载——toggle 为 False 时不触发 `value` 上游执行。

除了基本的开关功能外，还支持两个强大的可选配置字符串：**relay_expression**（布尔逻辑中继）和 **active_config**（节点状态控制）。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| value | * | ✅ | 输入值（lazy 加载：toggle=False 时不触发上游） |
| toggle | BOOLEAN | ✅ | 开关（默认 False） |
| relay_expression | STRING | ❌ | 布尔逻辑中继表达式（多行，前端语法高亮） |
| active_config | STRING | ❌ | 节点状态控制配置（多行，前端语法高亮） |

**输出:** `*` (任意类型，toggle=False 时输出 None)

#### relay_expression 详解

布尔逻辑表达式，用于根据**其他 BranchSwitchNode / BranchBooleanNode 的 toggle 值**自动计算当前节点的 toggle 值。

**语法：**

- **变量**：其他分支节点的 title 或 type（如 `NodeA`、`我的开关`）
- **运算符**：`&&`（与）、`||`（或）、`!`（非）、`()`（括号分组）
- **跨图引用**：`..` 表示上跳到父图（subgraph → root graph）
- **按 ID 引用**：`{1234}` 表示 ID 为 1234 的节点
- **Subgraph 内引用**：`..SubGraphNode:NodeA` 表示在父图的 SubGraphNode 子图中查找 NodeA
- **SwitchesNode 选择检查**：`{6982}==[1]` 表示 ID 6982 的 BranchSwitchesNode 的 select_input 等于 1 时为 true；`{6982}!=[1]` 为不等于

**示例：**

```
(!NodeA && NodeB) || NodeC
```
当 NodeA 为 false 且 NodeB 为 true，或 NodeC 为 true 时，本节点 toggle 自动设为 true。

```
{6982}==[1] && NodeA
```
当 ID 6982 的 SwitchesNode 选择了第 1 路输入，且 NodeA 为 true 时，本节点 toggle 为 true。

```
..SubGraphNode:NodeA
```
引用父图中 SubGraphNode 子图内的 NodeA 节点。

**前端特性：** 表达式编辑器提供实时语法高亮（绿色=找到变量，橙色=未找到），下方显示可点击的跳转按钮快速定位引用节点。

#### active_config 详解

当 toggle 值变化时，自动对**其他节点**执行状态操作。toggle=true 时执行配置中的操作，toggle=false 时执行**反转操作**。

**格式：** `op:target_type:target_value` （逗号分隔多条）

| op | 反转 op | 说明 |
|----|---------|------|
| `mute` | `!mute` | 静音节点（mode = NEVER） |
| `!mute` | `mute` | 取消静音（mode = ALWAYS） |
| `bypass` | `!bypass` | 旁路节点（mode = 2） |
| `!bypass` | `bypass` | 取消旁路 |
| `foldout` | `!foldout` | 折叠节点 |
| `!foldout` | `foldout` | 展开节点 |
| `expand` | `!expand` | 在 BranchGroupNode 的展开布局中展开此节点（仅 toggle=true 时生效） |
| `!expand` | `expand` | 不展开（仅布局用途） |
| `set` | `!set` | 将 BranchSwitchNode/BranchBooleanNode 的 toggle 设为 true |
| `!set` | `set` | 将 toggle 设为 false |

| target_type | 说明 |
|-------------|------|
| `name` | 按节点 title 或 type 匹配 |
| `id` | 按节点 ID 匹配 |
| `group` | 按分组名称匹配（组内所有节点） |

**示例：**

```
mute:name:NodeA, foldout:name:NodeB, expand:name:NodeC
```
toggle=true 时：静音 NodeA，折叠 NodeB，展开 NodeC。toggle=false 时反转：取消静音 NodeA，展开 NodeB，不展开 NodeC。

```
set:id:1234, mute:group:MyGroup
```
toggle=true 时：将 ID 1234 的分支节点 toggle 设为 true，静音 MyGroup 分组中所有节点。

**前端特性：** 配置编辑器提供语法高亮（蓝色=操作符，绿色=找到目标，橙色=未找到），下方显示跳转按钮。

---

### BranchSwitchesNode

多路选择器。通过 `select_input` 整数索引从多个动态输入中选择一个输出。支持 lazy 加载——仅加载被选中的输入。当连接第一个输入后自动添加更多输入槽。

除了基本的多路选择功能外，还支持 **select_config** 配置字符串，根据当前选择自动控制其他节点的状态。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| select | COMBO | ✅ | 显示用下拉框（自动生成：`[N] 上游节点名`，前端使用） |
| select_input | INT | ✅ | 选择输入索引（0=无选择，1=input1，2=input2...） |
| select_config | STRING | ✅ | 选择配置字符串（多行，前端语法高亮） |
| input1+ | * | ❌ | 动态扩展输入（lazy 加载，连接后自动添加更多槽位） |

**输出:** `output` (*), `select` (STRING), `select_index` (INT)

**动态类型：** 所有输入和输出的类型会自动同步为第一个连接的输入的类型。

**select COMBO 自动更新：** 连接/断开输入时，select 下拉框自动更新选项列表，显示 `[N] 上游节点标题`。

#### select_config 详解

当 `select_input` 变化时，自动对**其他节点**执行状态操作。匹配当前选择索引的规则执行原操作，不匹配的执行反转操作。

**格式：** `select_index:op:target_type:target_value` （逗号分隔多条）

| 字段 | 说明 |
|------|------|
| select_index | 匹配的输入索引（1=input1，2=input2...）。当 select_input 等于此值时执行 op，否则执行反转 |
| op | 操作类型（见下表） |
| target_type | `name` / `id` / `group`（同 active_config） |
| target_value | 节点名称 / 节点 ID / 分组名称 |

| op | 反转 op | 说明 |
|----|---------|------|
| `mute` | `!mute` | 静音节点 |
| `!mute` | `mute` | 取消静音 |
| `bypass` | `!bypass` | 旁路节点 |
| `!bypass` | `bypass` | 取消旁路 |
| `set` | `!set` | 将 BranchSwitchNode/BranchBooleanNode 的 toggle 设为 true |
| `!set` | `set` | 将 toggle 设为 false |

> 注意：select_config 不支持 `foldout` / `expand` 操作（仅 active_config 支持）。

**示例：**

```
1:mute:name:NodeA, 1:set:id:1234
2:mute:name:NodeB, 2:bypass:name:NodeC
```
当 select_input=1 时：静音 NodeA，将 ID 1234 的 toggle 设为 true。当 select_input=2 时：取消静音 NodeA（反转），将 ID 1234 的 toggle 设为 false（反转）；静音 NodeB，旁路 NodeC。

```
1:mute:group:RenderGroup, 2:!mute:group:RenderGroup
```
select=1 时静音 RenderGroup 中所有节点，select=2 时取消静音。

**SwitchesNode 联动：** 当 active_config 或 select_config 中的操作目标是另一个 BranchSwitchesNode 时（mute/bypass），会自动触发目标 SwitchesNode 的 select_config 重新计算（模拟 select=0 取反所有规则，恢复时用当前 select 值重算）。

**前端特性：** 配置编辑器提供语法高亮（索引灰色，操作符蓝色/红色，目标绿色/橙色），下方显示跳转按钮。

---

### BranchBooleanNode

布尔透传节点。直接透传 `toggle` 值，不做任何数据变换。主要用于配合 **relay_expression** 和 **active_config** 作为纯逻辑控制节点——它不接收 data 输入，只输出布尔值供其他节点引用。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| toggle | BOOLEAN | ✅ | 布尔值（默认 False） |
| relay_expression | STRING | ❌ | 布尔逻辑中继表达式（格式同 BranchSwitchNode） |
| active_config | STRING | ❌ | 节点状态控制配置（格式同 BranchSwitchNode） |

**输出:** `toggle` (BOOLEAN)

> relay_expression 和 active_config 的格式、语法、行为与 BranchSwitchNode 完全相同，请参考 BranchSwitchNode 的详细说明。

**与 BranchSwitchNode 的区别：** BranchSwitchNode 有 `value` 输入（数据透传 + 开关），BranchBooleanNode 没有数据输入（纯布尔控制）。两者都支持 relay_expression 和 active_config。

---

### BranchManagerNode

纯前端节点。在节点上显示一个交互式的**分支依赖关系图**（SVG 力导向布局），可视化所有分支节点之间的 relay / config / select 依赖关系。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| 无 | | | |

**输出:** 无

**可视化内容：**
- **节点**：BranchSwitchNode（蓝色）、BranchBooleanNode（绿色）、BranchSwitchesNode（橙色）、被 config 引用的非分支节点（红色）
- **边**：
  - `relay` 边：relay_expression 中引用的其他分支节点
  - `config` 边：active_config 中操作的目标节点
  - `select` 边：select_config 中操作的目标节点
- **交互**：悬停节点显示详细信息（title、type、表达式内容），点击节点跳转到对应节点

---

## 📋 List 操作节点

### ListMergeNode

通用列表合并。将最多 4 个任意类型列表合并为一个列表。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| list0 | * | ❌ | 列表 0 |
| list1 | * | ❌ | 列表 1 |
| list2 | * | ❌ | 列表 2 |
| list3 | * | ❌ | 列表 3 |

**输出:** `List` (LIST)

---

### ListDictMergeNode

DICT 列表合并。将最多 4 个字典列表合并。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| list0 | DICT | ❌ | 列表 0 |
| list1 | DICT | ❌ | 列表 1 |
| list2 | DICT | ❌ | 列表 2 |
| list3 | DICT | ❌ | 列表 3 |

**输出:** `DICT` (DICT[])

---

### ListMaskMergeNode

MASK 列表合并。将最多 4 个 mask 列表合并。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| list0 | MASK | ❌ | 列表 0 |
| list1 | MASK | ❌ | 列表 1 |
| list2 | MASK | ❌ | 列表 2 |
| list3 | MASK | ❌ | 列表 3 |

**输出:** `MASK` (MASK[])

---

### ListRegexPackMergeNode

REGEX_PACK 列表合并。将最多 4 个正则包列表合并。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| list0 | REGEX_PACK | ❌ | 列表 0 |
| list1 | REGEX_PACK | ❌ | 列表 1 |
| list2 | REGEX_PACK | ❌ | 列表 2 |
| list3 | REGEX_PACK | ❌ | 列表 3 |

**输出:** `REGEX_PACK` (REGEX_PACK[])

---

## 📖 Dictionary 操作节点

### DictionaryNewNode

字典创建。通过文本字符串（Python 字典字面量格式）创建字典。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dictionary_text | STRING | ✅ | Python 字典字面量字符串（多行） |

**输出:** `Dict` (DICT)

---

### DictionarySetNode

字典键值设置。向字典中设置指定 key 的 value，不存在则新增。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| key | STRING | ✅ | 键名 |
| value | * | ✅ | 值（任意类型） |
| dictionary | DICT | ❌ | 上游字典 |

**输出:** `Dict` (DICT)

---

### DictionaryGetNode

字典值获取。按 key 从字典中获取任意类型的值。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dictionary | DICT | ✅ | 字典 |
| key | STRING | ✅ | 键名 |

**输出:** `*` (任意类型)

---

### DictionaryValuesNode

字典值提取。提取字典中所有 value 并输出为列表。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dictionary | DICT | ✅ | 字典 |

**输出:** `values` (LIST)

---

### DictIndexSetNode

索引化字典设置。将 key 与 index 拼接后作为键存入字典（如 `key + str(index)`）。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| index | * | ✅ | 索引值（任意类型） |
| key | STRING | ✅ | 键名前缀 |
| value | * | ✅ | 值 |
| dictionary | DICT | ❌ | 上游字典 |

**输出:** `Dict` (DICT)

---

### DictIndexGetNode

索引化字典获取。按 key + index 拼接后的键从字典获取值。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dictionary | DICT | ✅ | 字典 |
| index | * | ✅ | 索引值 |
| key | STRING | ✅ | 键名前缀 |

**输出:** `value` (任意类型)

---

### DictionaryListSetNode

字典列表批量设置。支持列表输入的字典批量操作，每个元素独立创建字典。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| key | STRING | ✅ | 键名 |
| values | * | ✅ | 值列表 |
| dictionary | DICT | ❌ | 上游字典模板 |

**输出:** `Dict` (DICT[])

---

### DictionaryConditionSetNode

条件字典设置。当 dictionary 中 condition 键的值为 True 时，才设置 key-value。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| condition | STRING | ✅ | 条件键名 |
| key | STRING | ✅ | 要设置的键名 |
| value | * | ✅ | 要设置的值 |
| dictionary | DICT | ❌ | 上游字典 |

**输出:** `Dict` (DICT)

---

### DictConditionSetFlag

条件字典 + 成功标志。与 DictionaryConditionSetNode 类似，额外输出是否设置成功的布尔值。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| condition | STRING | ✅ | 条件键名 |
| key | STRING | ✅ | 要设置的键名 |
| value | BOOLEAN | ✅ | 要设置的布尔值（默认 True） |
| dictionary | DICT | ❌ | 上游字典 |

**输出:** `Dict` (DICT), `Success` (BOOLEAN)

---

### DictSwitch

字典条件分支。根据字典中 condition 键的值选择输出 on_success 或 on_failure。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dictionary | DICT | ✅ | 字典 |
| condition | STRING | ✅ | 条件键名 |
| key | STRING | ✅ | 结果存储键名 |
| on_failure | * | ✅ | 失败时的输出 |
| on_success | * | ❌ | 成功时的输出（lazy 加载） |

**输出:** `Dict` (DICT), `*` (任意类型)

---

### DictionaryGetIntNode

字典整数获取。按 key 获取值并转换为 INT。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dictionary | DICT | ✅ | 字典 |
| key | STRING | ✅ | 键名 |

**输出:** `value` (INT)

---

### DictionaryGetFloatNode

字典浮点数获取。按 key 获取值并转换为 FLOAT。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dictionary | DICT | ✅ | 字典 |
| key | STRING | ✅ | 键名 |

**输出:** `value` (FLOAT)

---

### DictionaryGetStringNode

字典字符串获取。按 key 获取值并转换为 STRING。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dictionary | DICT | ✅ | 字典 |
| key | STRING | ✅ | 键名 |

**输出:** `value` (STRING)

---

### DictionaryGetBooleanNode

字典布尔获取。按 key 获取布尔值，同时返回字典本身和 flag。

| 输入 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dictionary | DICT | ✅ | 字典 |
| key | STRING | ✅ | 键名 |

**输出:** `dict` (DICT), `flag` (BOOLEAN)
