import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

console.log("[kolid-comfy] branch_node.js loaded");

// ── CSS injection for syntax-highlighted editors ─────────────────
const BRANCH_STYLE_ID = "kolid-branch-node-styles";
if (!document.getElementById(BRANCH_STYLE_ID)) {
    const style = document.createElement("style");
    style.id = BRANCH_STYLE_ID;
    style.textContent = `
.kolid-branch-editor {
    position: relative;
    width: 100%;
}
.kolid-branch-editor-wrap {
    position: relative;
    width: 100%;
}
.kolid-branch-editor-highlight {
    margin: 0;
    padding: 4px;
    border: 1px solid #444;
    border-radius: 3px;
    box-sizing: border-box;
    background: #1a1a1a;
    color: #ccc;
    font-family: monospace;
    font-size: 11px;
    line-height: 1.4;
    pointer-events: none;
    width: 100%;
    min-height: 30px;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: break-word;
}
.kolid-branch-editor-input {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    padding: 4px;
    border: 1px solid transparent;
    border-radius: 3px;
    background: transparent;
    color: transparent;
    caret-color: #fff;
    font-family: monospace;
    font-size: 11px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: break-word;
    resize: none;
    outline: none;
    overflow: hidden;
    box-sizing: border-box;
}
.kolid-branch-editor-input::placeholder { color: #666; }
.kolid-branch-editor-input:focus { border-color: #777; }

.kolid-branch-seg-ok { color: #44dd44; }
.kolid-branch-seg-warn { color: #ffaa00; }
.kolid-branch-seg-error { color: #ff4444; }
.kolid-branch-seg-op { color: #6c8aff; }
.kolid-branch-seg-sep { color: #666; }

.kolid-jump-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
    margin-top: 2px;
    padding: 2px 0;
    font-family: monospace;
    font-size: 10px;
}
.kolid-jump-sep { color: #666; }
.kolid-jump-btn {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    background: #2a2a2a;
    border: 1px solid #444;
    color: #ccc;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
    user-select: none;
    line-height: 1.4;
}
.kolid-jump-btn:hover { background: #3a3a3a; border-color: #0a84ff; color: #fff; }
.kolid-jump-btn-arrow { color: #0a84ff; font-size: 9px; }
.kolid-jump-btn-ref {
    background: #2a220a;
    border-color: #554400;
}
.kolid-jump-btn-ref:hover { background: #3a3410; border-color: #ffaa00; color: #fff; }
.kolid-jump-btn-ref .kolid-jump-btn-arrow { color: #ffaa00; }
`;
    document.head.appendChild(style);
}

function escapeHTML(str) {
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;');
}

function jumpToNode(targetId) {
    if (!app.graph) return;
    const target = app.graph.getNodeById(targetId);
    if (!target) return;
    if (app.canvas) {
        app.canvas.centerOnNode(target);
        app.canvas.selectNode(target);
        app.canvas.setDirty(true, true);
    }
}

/**
 * Parse relay_expression and resolve variable names to nodes.
 * Returns [{segments: [...html...], jumps: [{id, title}]}]
 */
function parseRelayExpression(text, graph, selfNodeId) {
    if (!text || !text.trim()) return { html: '', jumps: [], refs: [] };
    const jumps = [];
    const seenIds = new Set();

    // Extract variables from the expression
    const vars = extractVariables(text);
    let html = escapeHTML(text);

    for (const v of vars) {
        const trimmed = v.trim();
        if (!trimmed) continue;

        // Check for {id} syntax
        const idMatch = trimmed.match(/^\{(\d+)\}$/);
        let targetNode = null;
        if (idMatch) {
            const id = parseInt(idMatch[1]);
            if (graph) targetNode = graph.getNodeById(id);
        } else if (graph) {
            targetNode = graph.nodes.find(n => n.id !== selfNodeId && (n.title === trimmed || n.type === trimmed));
        }

        // Highlight in HTML
        const escapedVar = escapeHTML(trimmed);
        if (targetNode) {
            html = html.replace(new RegExp(escapeRegExp(escapedVar), 'g'),
                `<span class="kolid-branch-seg-ok">${escapedVar}</span>`);
            if (!seenIds.has(targetNode.id)) {
                seenIds.add(targetNode.id);
                jumps.push({ id: targetNode.id, title: targetNode.title || targetNode.type || `Node ${targetNode.id}` });
            }
        } else {
            html = html.replace(new RegExp(escapeRegExp(escapedVar), 'g'),
                `<span class="kolid-branch-seg-warn">${escapedVar}</span>`);
        }
    }

    return { html, jumps, refs: [] };
}

/**
 * Parse active_config / select_config and resolve targets to nodes.
 * Format: <op>:<target_type>:<target_value>[,] or <select_index>:<op>:<target_type>:<target_value>[,]
 */
function parseConfigExpression(text, graph, selfNodeId) {
    if (!text || !text.trim()) return { html: '', jumps: [], refs: [] };
    const segments = text.split(',').map(s => s.trim()).filter(Boolean);
    const jumps = [];
    const seenIds = new Set();
    let htmlParts = [];

    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        // Parse: optional select_index:op:target_type:target_value OR op:target_type:target_value
        const parts = seg.split(':');
        let op, targetType, targetValue;

        if (parts.length >= 4 && /^\d+$/.test(parts[0].trim())) {
            // select_index:op:target_type:target_value
            op = parts[1].trim();
            targetType = parts[2].trim();
            targetValue = parts.slice(3).join(':').trim();
        } else if (parts.length >= 3) {
            op = parts[0].trim();
            targetType = parts[1].trim();
            targetValue = parts.slice(2).join(':').trim();
        } else {
            htmlParts.push(`<span class="kolid-branch-seg-error">${escapeHTML(seg)}</span>`);
            if (i < segments.length) htmlParts.push('<span class="kolid-branch-seg-sep">,</span> ');
            continue;
        }

        // Resolve target nodes
        let targetNodes = [];
        if (graph) {
            if (targetType === 'name') {
                targetNodes = graph.nodes.filter(n => n.id !== selfNodeId && (n.title === targetValue || n.type === targetValue));
            } else if (targetType === 'id') {
                const n = graph.getNodeById(parseInt(targetValue));
                if (n && n.id !== selfNodeId) targetNodes = [n];
            } else if (targetType === 'group') {
                const groups = graph._groups || graph.groups || [];
                const matchedGroup = groups.find(g => g.title === targetValue);
                if (matchedGroup) {
                    const groupNodeIds = matchedGroup._nodes || matchedGroup.nodes || [];
                    targetNodes = graph.nodes.filter(n => groupNodeIds.includes(n.id));
                }
            }
        }

        const opClass = /^(mute|!mute|bypass|!bypass|foldout|!foldout|expand|!expand|set|!set)$/.test(op) ? 'kolid-branch-seg-op' : 'kolid-branch-seg-error';
        const targetClass = targetNodes.length > 0 ? 'kolid-branch-seg-ok' : 'kolid-branch-seg-warn';

        htmlParts.push(`<span class="${opClass}">${escapeHTML(op)}</span>:<span class="kolid-branch-seg-sep">${escapeHTML(targetType)}</span>:<span class="${targetClass}">${escapeHTML(targetValue)}</span>`);

        for (const n of targetNodes) {
            if (!seenIds.has(n.id)) {
                seenIds.add(n.id);
                jumps.push({ id: n.id, title: n.title || n.type || `Node ${n.id}` });
            }
        }

        if (i < segments.length - 1) htmlParts.push('<span class="kolid-branch-seg-sep">,</span> ');
    }

    return { html: htmlParts.join(''), jumps, refs: [] };
}

/**
 * Find all branch nodes that reference this node in their relay_expression / active_config / select_config.
 * Returns [{id, title}] of referencing nodes.
 */
function findReferrers(nodeId, graph) {
    if (!graph) return [];
    const referrers = [];
    const seenIds = new Set();

    for (const n of graph.nodes) {
        if (n.id === nodeId) continue;
        const comfClass = n.comfyClass;
        if (comfClass !== 'BranchSwitchNode' && comfClass !== 'BranchBooleanNode' && comfClass !== 'BranchSwitchesNode') continue;

        let referencesThis = false;

        // Check relay_expression
        const relayWidget = n.widgets?.find(w => w.name === 'relay_expression');
        if (relayWidget && relayWidget.value) {
            // Check if this node's title/type/id appears in the expression
            const node = graph.getNodeById(nodeId);
            if (node) {
                const title = node.title || '';
                const type = node.type || '';
                const expr = relayWidget.value;
                if (title && expr.includes(title)) referencesThis = true;
                if (!referencesThis && type && expr.includes(type)) referencesThis = true;
                if (!referencesThis && expr.includes(`{${nodeId}}`)) referencesThis = true;
            }
        }

        // Check active_config and select_config
        if (!referencesThis) {
            for (const cfgName of ['active_config', 'select_config']) {
                const cfgWidget = n.widgets?.find(w => w.name === cfgName);
                if (!cfgWidget || !cfgWidget.value) continue;
                const node = graph.getNodeById(nodeId);
                if (!node) continue;
                const title = node.title || '';
                const type = node.type || '';
                const expr = cfgWidget.value;
                if (title && expr.includes(`name:${title}`)) referencesThis = true;
                if (!referencesThis && expr.includes(`id:${nodeId}`)) referencesThis = true;
            }
        }

        if (referencesThis && !seenIds.has(n.id)) {
            seenIds.add(n.id);
            referrers.push({ id: n.id, title: n.title || n.type || `Node ${n.id}` });
        }
    }

    return referrers;
}

/**
 * Create a syntax-highlighted editor for a branch node widget.
 */
function createBranchEditor(widget, node, parserFn) {
    const container = document.createElement("div");
    container.className = "kolid-branch-editor";

    const editorWrap = document.createElement("div");
    editorWrap.className = "kolid-branch-editor-wrap";
    container.appendChild(editorWrap);

    const highlight = document.createElement("pre");
    highlight.className = "kolid-branch-editor-highlight";
    editorWrap.appendChild(highlight);

    const textarea = document.createElement("textarea");
    textarea.className = "kolid-branch-editor-input";
    textarea.value = widget.value || "";
    editorWrap.appendChild(textarea);

    const jumpBar = document.createElement("div");
    jumpBar.className = "kolid-jump-bar";
    container.appendChild(jumpBar);

    function update() {
        const text = textarea.value;
        const result = parserFn(text, node.graph, node.id);
        highlight.innerHTML = result.html;

        // Build jump buttons
        jumpBar.innerHTML = "";
        for (const j of result.jumps) {
            const btn = document.createElement("span");
            btn.className = "kolid-jump-btn";
            btn.title = `Jump to ${j.title} (id:${j.id})`;
            btn.innerHTML = `<span class="kolid-jump-btn-arrow">→</span>${escapeHTML(j.title)}`;
            btn.addEventListener("click", () => jumpToNode(j.id));
            jumpBar.appendChild(btn);
        }
    }

    // Sync textarea -> widget
    let syncTimer = null;
    textarea.addEventListener("input", () => {
        widget.value = textarea.value;
        update();
        clearTimeout(syncTimer);
        syncTimer = setTimeout(() => {
            if (widget.callback) widget.callback(widget.value);
        }, 300);
    });

    // Sync widget -> textarea (when widget changes externally)
    const origWidgetCallback = widget.callback;
    widget.callback = function(v) {
        if (textarea.value !== v) {
            textarea.value = v || "";
            update();
        }
        if (origWidgetCallback) origWidgetCallback.call(this, v);
    };

    update();

    return { container, textarea, update };
}

/**
 * Create a "Referenced by" jump bar for a node.
 */
function createReferrerBar(node) {
    const container = document.createElement("div");
    container.className = "kolid-jump-bar";
    container.style.marginTop = "2px";

    function update() {
        const refs = findReferrers(node.id, node.graph);
        container.innerHTML = "";
        if (refs.length === 0) return;
        const label = document.createElement("span");
        label.style.color = "#8e8e93";
        label.style.fontSize = "9px";
        label.textContent = "←";
        container.appendChild(label);
        for (const r of refs) {
            const btn = document.createElement("span");
            btn.className = "kolid-jump-btn kolid-jump-btn-ref";
            btn.title = `Referenced by ${r.title} (id:${r.id})`;
            btn.innerHTML = `<span class="kolid-jump-btn-arrow">←</span>${escapeHTML(r.title)}`;
            btn.addEventListener("click", () => jumpToNode(r.id));
            container.appendChild(btn);
        }
    }

    update();
    return { container, update };
}

/**
 * 从节点 widget 中读取值，找不到时返回默认值。
 * 替代原先通过 node.properties 读取的方式。
 */
function getWidgetValue(node, name, defaultValue) {
    const widget = node.widgets?.find(w => w.name === name);
    return widget ? widget.value : defaultValue;
}

/**
 * 从 graph 中获取 link 对象，兼容新旧 litegraph（Map vs array）
 */
function getLink(graph, linkId) {
    if (!graph || linkId == null) return null;
    if (graph._links) return graph._links.get(linkId);
    if (graph.links) return graph.links[linkId];
    return null;
}

/**
 * 
 * @param {*} node 
 * @param {*} key 
 * @param {*} settings 
 */
function initNodeProperty(node, key, settings) {
    if (!node.properties[key]) {
        node.setProperty(key, settings.default);
    }
    if (settings.type) {
        node.constructor['@' + key] = {
            type: settings.type,
            values: settings.values || []
        };
    }
}

/**
 * 从布尔表达式中提取所有变量名（支持中英文、_ $ 数字）
 * 示例：
 *   "(!已登录&&有权限)||是管理员&&!已封禁" 
 *   → ['已登录', '有权限', '是管理员', '已封禁']
 */
function extractVariables(expr) {
  // 匹配：字母、中文、数字、下划线、$，且必须以字母/中文/_/$ 开头
  const regex = /[^\(|\)&!]+/gu;
  const matches = expr.match(regex) || [];
  // 去重
  const variables = [...new Set(matches)];
  return variables;
}

function getNodeFromExpression(expr, node){
    const regex = /(([^:\.]+)|(\.\.))/gu;
    const idRegex = /(?<=\{)\d+(?=\})/g;
    const matches = expr.match(regex) || [];
    let targetGraph = node.graph;
    let n = null;
    for(let match of matches){
        if(match == ".."){
            targetGraph = targetGraph.rootGraph;
        }else{
            const idMatch = match.match(idRegex);
            if(idMatch){
                let id = Number.parseInt(idMatch[0]);
                n = targetGraph.getNodeById(id);
            }else{
                n = targetGraph.nodes.find(n => n.title == match || n.type == match);
            }
            if(n && n.subgraph){
                targetGraph = n.subgraph;
            }
        }
    }
    return n;
}

/**
 * 安全计算布尔表达式（支持中英文变量名！）
 * 示例：
 *   solveExpression("已登录 && !已封禁 || 是管理员", {
 *     已登录: true,
 *     已封禁: false,
 *     是管理员: true
 *   }) → true
 */
function solveExpression(expr, variables) {
    // 支持 Map 和普通对象
    const vars = variables instanceof Map ? Object.fromEntries(variables) : variables;

    let result = expr;

    // 精准替换变量：关键是构造支持中文的“单词边界”
    for (const [key, value] of Object.entries(vars)) {
        if (typeof key !== 'string' || !key) continue;

        // 方法一：最推荐 —— 使用 Unicode 词边界 \b (JS 正则已支持，需 u 标志)
        // \b 在 u 模式下能正确识别中文边界！
        const regex = new RegExp(`(^|(?<=[^\u4E00-\u9FA5A-Za-z0-9_]))${escapeRegExp(key)}($|(?=[^\u4E00-\u9FA5A-Za-z0-9_]))`, 'gu');

        result = result.replace(regex, value === true ? 'true' : 'false');
    }

    // 此时 result 已经是纯布尔表达式
    try {
        // 严格模式执行，安全无污染
        return new Function(`"use strict"; return ${result}`)();
    } catch (e) {
        throw new Error(`表达式语法错误: ${expr}\n详细信息: ${e.message}`);
    }
}

// 辅助函数：转义正则特殊字符
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 解析 relay_expression 中的 {id}==[N] 或 {id}!=[N] 语法
 * 判断指定 id 的 BranchSwitchesNode 的 select_input 是否等于 N
 * 将匹配的部分替换为 true/false 后返回新表达式
 */
function resolveSwitchesInExpression(expr, node) {
    const regex = /\{(\d+)\}\s*(==|!=)\s*\[(\d+)\]/g;
    return expr.replace(regex, (match, nodeId, op, expectedIdx) => {
        const targetNode = node.graph.getNodeById(parseInt(nodeId));
        if (!targetNode) return 'false';
        const siWidget = targetNode.widgets?.find(w => w.name === "select_input");
        const actualIdx = siWidget ? (siWidget.value || 0) : 0;
        const expected = parseInt(expectedIdx);
        const isEqual = (actualIdx === expected);
        const result = (op === '==') ? isEqual : !isEqual;
        return result ? 'true' : 'false';
    });
}

/**
 * 根据 targetType 和 targetValue 解析目标节点列表
 */
function resolveTargetNodes(graph, targetType, targetValue) {
    let targetNodes = [];
    if (targetType === "name") {
        targetNodes = graph.nodes.filter(n => n.title === targetValue || n.type === targetValue);
    } else if (targetType === "id") {
        const n = graph.getNodeById(parseInt(targetValue));
        if (n) targetNodes = [n];
    } else if (targetType === "group") {
        const groups = graph._groups || graph.groups || [];
        const matchedGroup = groups.find(g => g.title === targetValue);
        if (!matchedGroup) {
            console.warn("[active_config] group not found:", targetValue);
        } else {
            // 策略1: group 自己的 _nodes / nodes 数组
            const groupNodeIds = matchedGroup._nodes || matchedGroup.nodes;
            if (groupNodeIds && groupNodeIds.length > 0) {
                const idSet = new Set(groupNodeIds);
                targetNodes = graph.nodes.filter(n => idSet.has(n.id));
            }
            // 策略2: 通过 node.group 属性匹配
            if (targetNodes.length === 0) {
                const groupId = matchedGroup._id != null ? matchedGroup._id : matchedGroup.id;
                targetNodes = graph.nodes.filter(n => {
                    if (n.group == null) return false;
                    if (typeof n.group === "number") return n.group === groupId;
                    return n.group === matchedGroup || (n.group._id != null && n.group._id === groupId) || (n.group.id != null && n.group.id === groupId);
                });
            }
            // 策略3: 空间包含
            if (targetNodes.length === 0) {
                const bound = matchedGroup._bounding || matchedGroup.bounding;
                if (bound && bound.length >= 4) {
                    const [gx, gy, gw, gh] = bound;
                    targetNodes = graph.nodes.filter(n => {
                        if (!n.pos || !n.size) return false;
                        const [nx, ny] = n.pos;
                        const [nw, nh] = n.size;
                        return nx >= gx && ny >= gy && nx + nw <= gx + gw && ny + nh <= gy + gh;
                    });
                }
            }
        }
    }
    return targetNodes;
}

const BRANCH_OPPOSITE_OPS = {
    "mute": "!mute",
    "!mute": "mute",
    "bypass": "!bypass",
    "!bypass": "bypass",
    "foldout": "!foldout",
    "!foldout": "foldout",
    "expand": "!expand",
    "!expand": "expand",
    "set": "!set",
    "!set": "set",
};

/**
 * 对目标节点应用单个操作
 */
function applyBranchOp(graph, targetType, targetValue, op) {
    let targetNodes = resolveTargetNodes(graph, targetType, targetValue);
    for (const n of targetNodes) {
        switch (op) {
            case "mute":
                n.mode = LiteGraph.NEVER;
                break;
            case "!mute":
                n.mode = LiteGraph.ALWAYS;
                break;
            case "bypass":
                n.mode = 2;
                break;
            case "!bypass":
                n.mode = LiteGraph.ALWAYS;
                break;
            case "foldout":
                if (!n.collapsed) n.collapse();
                break;
            case "!foldout":
                if (n.collapsed) n.collapse();
                break;
            case "set":
            case "!set":
                if (n.comfyClass === "BranchSwitchNode" || n.comfyClass === "BranchBooleanNode") {
                    const newVal = (op === "set");
                    if (n.widgets[0].value !== newVal) {
                        n.widgets[0].value = newVal;
                        if (n.widgets[0].callback) {
                            n.widgets[0].callback(newVal);
                        }
                    }
                }
                break;
            // expand/!expand 不在这里处理，由 ExpandNode 布局逻辑读取
        }
    }
    if (targetNodes.length > 0) {
        graph.setDirtyCanvas(true, true);
        if (graph.change) graph.change();
    }
}

/**
 * 解析 active_config 并根据 toggle 值应用操作
 */
function processActiveConfig(node, toggleValue) {
    const configStr = getWidgetValue(node, 'active_config', '').trim();
    if (!configStr) return;

    const graph = node.graph;
    if (!graph) return;

    const segments = configStr.split(",").map(s => s.trim()).filter(s => s);
    for (const seg of segments) {
        const parts = seg.split(":");
        if (parts.length < 3) continue;

        const op = parts[0];
        if (!BRANCH_OPPOSITE_OPS.hasOwnProperty(op)) continue;

        const targetType = parts[1];
        const targetValue = parts.slice(2).join(":");

        const effectiveOp = toggleValue ? op : BRANCH_OPPOSITE_OPS[op];
        applyBranchOp(graph, targetType, targetValue, effectiveOp);
    }
}

/**
 * 从 active_config 中提取 expand 操作的目标节点列表
 * 仅返回 expand（非 !expand）的目标节点，且仅当 toggle 为 true 时
 */
function getExpandTargets(node) {
    const configStr = getWidgetValue(node, 'active_config', '').trim();
    if (!configStr) return [];

    const graph = node.graph;
    if (!graph) return [];

    const toggleValue = node.widgets[0].value;
    if (!toggleValue) return [];

    let targets = [];
    const segments = configStr.split(",").map(s => s.trim()).filter(s => s);
    for (const seg of segments) {
        const parts = seg.split(":");
        if (parts.length < 3) continue;

        const op = parts[0];
        if (op !== "expand") continue;

        const targetType = parts[1];
        const targetValue = parts.slice(2).join(":");

        const nodes = resolveTargetNodes(graph, targetType, targetValue);
        targets.push(...nodes);
    }
    return targets;
}

function initUpdateSet(node, updateSet) {
    // 如果已经放入了updateSet那么就返回.
    //如果node是列表，那么就遍历列表，递归调用initUpdateSet
    if(updateSet.has(node)) 
        return;

    updateSet.add(node);
    // 下游节点列表.
    let beRelayeds = window.kolid_data.branchBeRelayedMap.get(node);

    if(!beRelayeds) return;

    for (let index = 0; index < beRelayeds.length; index++) {
        const beRelayed = beRelayeds[index];
        initUpdateSet(beRelayed, updateSet);
    }
}

function updateRelays(node, updateSet) {
    // 下游节点列表.
    let beRelayeds = window.kolid_data.branchBeRelayedMap.get(node);

    if(!beRelayeds) return;
    
    // 那些没被更新的会在那些节点的更新中顺带着更新.
    for (let index = 0; index < beRelayeds.length; index++) {
        const beRelayed = beRelayeds[index];
        // 找到所有上游节点不存在updateSet中的节点.
        const relayNodes = window.kolid_data.branchRelayMap.get(beRelayed);
        let flag = true;

        for (let j = 0; j < relayNodes.length; j++) {
            const relayNode = relayNodes[j];
            if(updateSet.has(relayNode)){
                flag = false;
                break;
            }
        }
        
        // 这个节点可以更新了.
        if(flag){

            // 如果这个节点已经被更新过了,这就意味着遇到了循环依赖,得跳过..
            if(!updateSet.has(beRelayed)) continue;
            // 正常更新
            updateSet.delete(beRelayed);
            let expr = getWidgetValue(beRelayed, 'relay_expression', '');
            expr = resolveSwitchesInExpression(expr, beRelayed);
            let relayMarks = extractVariables(expr);

            let parameters = new Map();
            for (let j = 0; j < relayMarks.length; j++) {
                const relayMark = relayMarks[j];
                if (relayMark === 'true' || relayMark === 'false') continue;
                const relayNode = getNodeFromExpression(relayMark, node);
                if(relayNode){
                    parameters.set(relayMark, relayNode.widgets[0].value);
                }
            }

            beRelayed.widgets[0].value = solveExpression(expr, parameters);

            updateRelays(beRelayed, updateSet);
        }
    }
}

function updateBranchNode(node){
    // 更新依赖的节点
    let updateSet = new Set();
    initUpdateSet(node, updateSet);
    updateSet.delete(node);
    updateRelays(node, updateSet);
}

function updateActiveAndFoldout(){
    for (let index = 0; index < window.kolid_data.branchNodes.length; index++) {
        const branchNode = window.kolid_data.branchNodes[index];
        processActiveConfig(branchNode, branchNode.widgets[0].value);
    }
}

function getNodeTitles(nodeTitles) {
    return nodeTitles.split('/');
}

function* getNodes(node, nodeString){
    let nodeMarks = getNodeTitles(nodeString);
    for(let nodeMark of nodeMarks){
        let n = getNodeFromExpression(nodeMark, node);
        if(n){
            yield n;
        }
    }
}

function* ExpandNode(currentNode, expandNode, processedNodes, indent) {
    // 检测循环调用：如果已经处理过这个节点，或者这个节点正在处理中，就跳过
    if(processedNodes.has(expandNode.id)) {
        return;
    }
    processedNodes.add(expandNode.id);
    
    let added = false;

    let block = {
        indent : indent,
        id: expandNode.id,
    };
    
    // 如果展开的节点是BranchToggleNode或BranchBooleanNode，递归展开它的expand目标
    let value = layoutValue(expandNode);
    if(value !== undefined){
        if (value) {
            let expandTargets = getExpandTargets(expandNode);
            if(expandTargets.length > 0){
                added = true;
                block.indent = indent + 1;
                block.split = true;
                yield block;
                for(let subExpandNode of expandTargets){
                    yield* ExpandNode(expandNode, subExpandNode, processedNodes, indent + 1);
                }
            }
        }
    }

    if(!added){
        yield block;
    }
}

function layoutValue(node){
    if (node.type === "Branch Switch" || node.type === "Branch Boolean"){
        return node.widgets[0].value;
    }
    return undefined;
}


function* allNodes(graph){
    for (let index = 0; index < graph.nodes.length; index++) {
        const node = graph.nodes[index];
        yield node;
        if(node.subgraph){
            yield* allNodes(node.subgraph);
        }
    }
}


function updateRelayGraph(){
    window.kolid_data.branchNodes = [];
    window.kolid_data.branchRelayMap.clear();
    window.kolid_data.branchBeRelayedMap.clear();

    for(let node of allNodes(app.graph)){
        if(node.comfyClass === "BranchSwitchNode" || node.comfyClass === "BranchBooleanNode"){
            const expr = getWidgetValue(node, 'relay_expression', '');
            const relayExpreesions = extractVariables(expr);
            let relayNodes = [];
            // 这个节点依赖的其他节点
            for(let relayExpreesion of relayExpreesions){
                let relayNode = getNodeFromExpression(relayExpreesion, node);
                if(relayNode){
                    relayNodes.push(relayNode);
                }
            }
            window.kolid_data.branchRelayMap.set(node, relayNodes);
            window.kolid_data.branchNodes.push(node);
        }
    }

    for(let relayAndTable of window.kolid_data.branchRelayMap){
        let node = relayAndTable[0];
        let relayNodes = relayAndTable[1];
        for(let relay of relayNodes){
            let table = window.kolid_data.branchBeRelayedMap.get(relay);
            if(!table){
                table = [];
                window.kolid_data.branchBeRelayedMap.set(relay, table);
            }
            table.push(node);
        }
    }

    // 对BranchToggleNode进行排序
    window.kolid_data.branchNodes.sort((n0,n1)=>n0.title.localeCompare(n1.title));

    // Update referrer bars on all branch nodes
    for (const node of allNodes(app.graph)) {
        if ((node.comfyClass === "BranchSwitchNode" || node.comfyClass === "BranchBooleanNode" || node.comfyClass === "BranchSwitchesNode") && node._kolidRefBar) {
            node._kolidRefBar.update();
        }
    }
}

function updateBranchGroupNode(node){
    let matchStr = node.properties.match_regex;
    let matchColor = node.color;
    let graph = node.graph;

    let collect_BranchSwitchNode = node.properties.collect_BranchSwitchNode;
    let collect_BranchBooleanNode = node.properties.collect_BranchBooleanNode;

    // 过滤出符合条件的BranchNode
    let filteredBranchNodes = window.kolid_data.branchNodes
    .filter(n=>{
        if(graph != n.graph) return false;
        if(n.comfyClass == 'BranchSwitchNode'){
            return collect_BranchSwitchNode;
        }
        else if(n.comfyClass == 'BranchBooleanNode'){
            return collect_BranchBooleanNode;
        }
        return false;
    })
    .filter(n => {
        let toMatch = n.title;
        if(!toMatch.match(matchStr)) return false;
        if(n.color != matchColor) return false;
        return true;
    });

    // 获取Branch Group节点自身的branch_mode
    const layoutBranchMode = node.properties.branch_mode || 'Default';
    
    let tmpWidgets = node.widgets;
    if(tmpWidgets){
        for(let widget of tmpWidgets){
            node.removeWidget(widget);
        }
    }
    // Default模式：保持原有逻辑，每个节点作为独立的toggle控件显示
    if (layoutBranchMode === 'Default' || filteredBranchNodes.length === 0) {
        for (const targetNode of filteredBranchNodes) {
            node.addWidget("toggle",targetNode.title,targetNode.widgets[0].value,(value)=>{
                targetNode.widgets[0].value = value; 
                if(targetNode.widgets[0].callback){
                    targetNode.widgets[0].callback(targetNode.widgets[0].value);
                }
            });
        }
    }
    // AlwaysOne模式：将所有BranchNode打包成一个combo控件
    else if (layoutBranchMode === 'AlwaysOne') {
        if (filteredBranchNodes.length > 0) {
            let allNodes = filteredBranchNodes;
            
            let visibleNodeTitles = allNodes.map(n => n.title);
            
            // 找出当前选中的节点
            let selectedNode = allNodes.find(n => n.widgets[0].value);
            let currentValue = selectedNode ? selectedNode.title : (visibleNodeTitles[0] || '');
            
            // 确保currentValue在visibleNodeTitles中
            if(!visibleNodeTitles.includes(currentValue) && visibleNodeTitles.length > 0){
                currentValue = visibleNodeTitles[0];
            }
            
            for(let n of allNodes){
                n.widgets[0].value = (n.title === currentValue);
                if(n.widgets[0].callback){
                    n.widgets[0].callback(n.widgets[0].value);
                }
            }

            // 自动展开选中节点的子节点
            let expandNode = allNodes.find(n => n.title === currentValue);
            if(!expandNode && allNodes.length > 0){
                expandNode = allNodes[0];
                expandNode.widgets[0].value = true;
                updateBranchNode(expandNode);
                updateActiveAndFoldout();
            }
            if(expandNode){
                processActiveConfig(expandNode, expandNode.widgets[0].value);
            }

            node.addWidget("combo",`${node.title}`,currentValue,(value)=>{
                for(let n of allNodes){
                    n.widgets[0].value = (n.title === value);
                    if(n.widgets[0].callback){
                        n.widgets[0].callback(n.widgets[0].value);
                    }
                }
                updateActiveAndFoldout();
            }, {values: visibleNodeTitles});
        }
    }
    // MaxOne模式：确保最多只有一个节点被选中
    else if (layoutBranchMode === 'MaxOne') {
        if (filteredBranchNodes.length > 0) {
            let allNodes = filteredBranchNodes;
            
            let visibleNodeTitles = [];

            visibleNodeTitles.push('[None]');
            let tempTitles = allNodes.map(n => n.title);
            visibleNodeTitles.push(...tempTitles);
            
            // 找出当前选中的节点
            let selectedNode = allNodes.find(n => n.widgets[0].value);
            let currentValue = selectedNode ? selectedNode.title : (visibleNodeTitles[0] || '');
            
            // 确保currentValue在visibleNodeTitles中
            if(!visibleNodeTitles.includes(currentValue) && visibleNodeTitles.length > 0){
                currentValue = visibleNodeTitles[0];
            }

            for(let n of allNodes){
                n.widgets[0].value = (n.title === currentValue);
                if(n.widgets[0].callback){
                    n.widgets[0].callback(n.widgets[0].value);
                }
            }

            // 自动展开选中节点的子节点
            let expandNode = allNodes.find(n => n.title === currentValue);
            if(expandNode){
                processActiveConfig(expandNode, expandNode.widgets[0].value);
            }
            
            node.addWidget("combo",`${node.title}`,currentValue,(value)=>{
                for(let n of allNodes){
                    n.widgets[0].value = (n.title === value);
                    if(n.widgets[0].callback){
                        n.widgets[0].callback(n.widgets[0].value);
                    }
                }
                updateActiveAndFoldout();
            }, {values: visibleNodeTitles});
        }
    }
}

function wrapOnPropertyChanged(node, updateFn) {
    const original = node.onPropertyChanged;
    node.onPropertyChanged = (name, value, old_value) => {
        if (original) {
            const result = original(name, value, old_value);
            if (result) {
                updateFn();
                return true;
            }
            return false;
        } else {
            updateFn();
            return true;
        }
    };
}

function nodeInit(node, is_create){
    if (node.comfyClass === "BranchSwitchNode" || node.comfyClass === "BranchBooleanNode") {
        // Wrap widget callbacks so that changing relay/active_config rebuilds the relay graph
        for (const name of ['relay_expression', 'active_config']) {
            const widget = node.widgets?.find(w => w.name === name);
            if (widget) {
                const original = widget.callback;
                widget.callback = function(value) {
                    if (original) original.call(this, value);
                    updateRelayGraph();
                    updateActiveAndFoldout();
                };
            }
        }

        // Replace relay_expression and active_config widgets with syntax-highlighted editors
        if (node.widgets) {
            const relayWidget = node.widgets.find(w => w.name === 'relay_expression');
            if (relayWidget) {
                const editor = createBranchEditor(relayWidget, node, parseRelayExpression);
                relayWidget.type = "hidden";
                relayWidget.serialize = false;
                // Add editor as DOM widget
                node.addDOMWidget("relay_expression_editor", "kolid_branch_editor", editor.container, {
                    getValue: () => relayWidget.value,
                    setValue: (v) => { relayWidget.value = v; editor.textarea.value = v || ''; editor.update(); },
                });
                if (!node._kolidBranchEditors) node._kolidBranchEditors = [];
                node._kolidBranchEditors.push(editor);
            }
            const configWidget = node.widgets.find(w => w.name === 'active_config');
            if (configWidget) {
                const editor = createBranchEditor(configWidget, node, parseConfigExpression);
                configWidget.type = "hidden";
                configWidget.serialize = false;
                node.addDOMWidget("active_config_editor", "kolid_branch_editor", editor.container, {
                    getValue: () => configWidget.value,
                    setValue: (v) => { configWidget.value = v; editor.textarea.value = v || ''; editor.update(); },
                });
                if (!node._kolidBranchEditors) node._kolidBranchEditors = [];
                node._kolidBranchEditors.push(editor);
            }
        }

        // Add "referenced by" bar
        const refBar = createReferrerBar(node);
        node.addDOMWidget("ref_bar", "kolid_ref_bar", refBar.container, { getValue: () => "", setValue: () => {} });
        node._kolidRefBar = refBar;

        if(is_create){
            updateRelayGraph();
        }
        
        const originalCallback = node.widgets[0].callback;
        if (originalCallback) {
            node.widgets[0].callback = (value) => {
                originalCallback(value);
                updateBranchNode(node);
                updateActiveAndFoldout();
            }
        }else{
            node.widgets[0].callback = (value) => {
                updateBranchNode(node);
                updateActiveAndFoldout();
            }
        }
    } else if (node.comfyClass === "BranchSwitchesNode") {
        // Replace select_config widget with syntax-highlighted editor
        if (node.widgets) {
            const configWidget = node.widgets.find(w => w.name === 'select_config');
            if (configWidget) {
                const editor = createBranchEditor(configWidget, node, parseConfigExpression);
                configWidget.type = "hidden";
                configWidget.serialize = false;
                node.addDOMWidget("select_config_editor", "kolid_branch_editor", editor.container, {
                    getValue: () => configWidget.value,
                    setValue: (v) => { configWidget.value = v; editor.textarea.value = v || ''; editor.update(); },
                });
                if (!node._kolidBranchEditors) node._kolidBranchEditors = [];
                node._kolidBranchEditors.push(editor);
            }
        }

        // Add "referenced by" bar
        const refBar = createReferrerBar(node);
        node.addDOMWidget("ref_bar", "kolid_ref_bar", refBar.container, { getValue: () => "", setValue: () => {} });
        node._kolidRefBar = refBar;
    } else if (node.comfyClass === "BranchGroupNode") {
        initNodeProperty(node, "branch_mode", {
            default: "Default",
            type: "combo",
            values: ["Default", "MaxOne", "AlwaysOne"]
        });

        if (!('collect_BranchSwitchNode' in node.properties)) {
            node.setProperty('collect_BranchSwitchNode', true);
        }
        if (!('collect_BranchBooleanNode' in node.properties)) {
            node.setProperty('collect_BranchBooleanNode', true);
        }
        if (!('match_regex' in node.properties)) {
            node.setProperty('match_regex', '');
        }
        if (!('expand_nodes' in node.properties)) {
            node.setProperty('expand_nodes', '');
        }

        updateBranchGroupNode(node)
        if(is_create){
            node.onConfigure = () => {
                // Property改变也需要重建
                wrapOnPropertyChanged(node, () => updateBranchGroupNode(node));
            }
        }else{
            wrapOnPropertyChanged(node, () => updateBranchGroupNode(node));
        }
        //颜色好像没有回调啊...
        //node.
    }
}

app.registerExtension({
    name: "MyExtension",
    async init() {
        if (window.kolid_data === undefined){
            window.kolid_data = {};
            window.kolid_data.UninitNodes = new Set();
            window.kolid_data.LayoutDict = new Map();
            window.kolid_data.branchRelayMap = new Map();
            window.kolid_data.branchBeRelayedMap = new Map();
        }
    },
    async beforeConfigureGraph(){
        window.kolid_data.OpeningGraph = true;
    },
    async afterConfigureGraph(){
        updateRelayGraph();
        if(window.kolid_data.OpeningGraph){
            for(let node of window.kolid_data.UninitNodes){
                nodeInit(node, false);
            }
            window.kolid_data.UninitNodes.clear();
            window.kolid_data.OpeningGraph = false;
        }
    },
    async nodeCreated(node) {
        if(window.kolid_data.OpeningGraph){
            window.kolid_data.UninitNodes.add(node);
            return;
        }
        nodeInit(node, true);
    }
})

console.log("[kolid-comfy] about to register BranchSwitchesNode extension");

app.registerExtension({
    name: "KleinBlue.BranchSwitchesNode",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        console.log("[kolid-comfy] beforeRegisterNodeDef", nodeData?.name);
        if (nodeData.name !== "BranchSwitchesNode") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);
            const node = this;

            console.log("[BranchSwitchesNode] onNodeCreated fired", { widgets: node.widgets?.map(w => w.name), inputs: node.inputs?.map(i => i.name) });

            let currentType = "*";
            let currentConnected = false;

            // ==================== 显示用的 Combo ====================
            const selectWidget = node.widgets.find(w => w.name === "select") || node.widgets[0];
            console.log("[BranchSwitchesNode] selectWidget", selectWidget?.name, "options:", selectWidget?.options);

            // ==================== 隐藏的真实 select_input ====================
            // 先尝试查找是否已存在（防止重复添加）
            let selectInputWidget = node.widgets.find(w => w.name === "select_input");
            if (!selectInputWidget) {
                selectInputWidget = node.addWidget("number", "select_input", 0);
            }

            // select_config widget
            const selectConfigWidget = node.widgets.find(w => w.name === "select_config");

            function addDynamicInput() {
                let dynamicInputs = node.inputs.filter(inp => inp.name.startsWith("input"));
                const idx = dynamicInputs.length + 1;
                node.addInput(`input${idx}`, currentType);
            }

            function updateInputsType() {
                node.inputs.forEach(inp => {
                    if (inp.name.startsWith("input")) inp.type = currentType;
                });
            }

            function updateOutputsType() {
                if (node.outputs && node.outputs.length > 0) {
                    node.outputs[0].type = currentType;
                    node.setDirtyCanvas(true, true);
                }
            }

            // 更新 Combo（只显示已连接的输入）
            function updateComboOptions() {
                const options = [];
                let connectedCount = 0;
                let dynamicInputs = node.inputs.filter(inp => inp.name.startsWith("input"));
                console.log("[BranchSwitchesNode] updateComboOptions", { dynamicInputs: dynamicInputs.map(i => ({name: i.name, link: i.link})), allInputs: node.inputs.map(i => i.name) });
                dynamicInputs.forEach((input, idx) => {
                    if (input.link != null) {
                        connectedCount++;
                        const link = getLink(node.graph, input.link);
                        const upstream = link ? node.graph.getNodeById(link.origin_id) : null;
                        const name = upstream ? (upstream.title || upstream.type || "未知节点") : "未知节点";
                        options.push(`[${idx + 1}] ${name}`);
                    }
                });

                selectWidget.options.values = connectedCount > 0 ? options : ["[None]"];
                console.log("[BranchSwitchesNode] updateComboOptions result", { connectedCount, options, selectWidgetValues: selectWidget.options.values, selectWidgetValue: selectWidget.value });
                
                const targetNum = selectInputWidget.value || 0;
                if (connectedCount > 0) {
                    let found = false;
                    for (let opt of options) {
                        const match = opt.match(/\[(\d+)\]/);
                        if (match && parseInt(match[1]) === targetNum) {
                            selectWidget.value = opt;
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        selectWidget.value = options[0];
                        const match = options[0].match(/\[(\d+)\]/);
                        selectInputWidget.value = match ? parseInt(match[1]) : 0;
                    }
                } else {
                    selectWidget.value = "[None]";
                    selectInputWidget.value = 0;
                }
            }

            // ==================== select_config 解析与操作 ====================
            // 防重入：避免多个 BranchSwitchesNode 相互触发
            const _selectConfigGuard = new Set();

            function applyNodeOp(graph, targetType, targetValue, op) {
                let targetNodes = [];
                if (targetType === "name") {
                    targetNodes = graph.nodes.filter(n => n.title === targetValue || n.type === targetValue);
                } else if (targetType === "id") {
                    const n = graph.getNodeById(parseInt(targetValue));
                    if (n) targetNodes = [n];
                } else if (targetType === "group") {
                    const groups = graph._groups || graph.groups || [];
                    const matchedGroup = groups.find(g => g.title === targetValue);
                    if (!matchedGroup) {
                        console.warn("[select_config] group not found:", targetValue, "available:", groups.map(g => g.title));
                    } else {
                        // 调试：打印 group 和第一个节点的结构
                        console.log("[select_config] group keys:", Object.keys(matchedGroup), "has _nodes:", !!matchedGroup._nodes, "has nodes:", !!matchedGroup.nodes);
                        if (graph.nodes.length > 0) {
                            console.log("[select_config] first node keys:", Object.keys(graph.nodes[0]), "node.group:", graph.nodes[0].group);
                        }

                        // 策略1: group 自己的 _nodes / nodes 数组（最可靠）
                        const groupNodeIds = matchedGroup._nodes || matchedGroup.nodes;
                        if (groupNodeIds && groupNodeIds.length > 0) {
                            const idSet = new Set(groupNodeIds);
                            targetNodes = graph.nodes.filter(n => idSet.has(n.id));
                        }

                        // 策略2: 通过 node.group 属性匹配（如果策略1没找到）
                        if (targetNodes.length === 0) {
                            const groupId = matchedGroup._id != null ? matchedGroup._id : matchedGroup.id;
                            targetNodes = graph.nodes.filter(n => {
                                if (n.group == null) return false;
                                if (typeof n.group === "number") return n.group === groupId;
                                return n.group === matchedGroup || (n.group._id != null && n.group._id === groupId) || (n.group.id != null && n.group.id === groupId);
                            });
                        }

                        // 策略3: 空间包含（如果前两种都没找到）
                        if (targetNodes.length === 0) {
                            const bound = matchedGroup._bounding || matchedGroup.bounding;
                            if (bound && bound.length >= 4) {
                                const [gx, gy, gw, gh] = bound;
                                targetNodes = graph.nodes.filter(n => {
                                    if (!n.pos || !n.size) return false;
                                    const [nx, ny] = n.pos;
                                    const [nw, nh] = n.size;
                                    return nx >= gx && ny >= gy && nx + nw <= gx + gw && ny + nh <= gy + gh;
                                });
                            }
                        }

                        console.log("[select_config] group:", targetValue, "nodes:", targetNodes.length, targetNodes.map(n => n.title || n.type));
                    }
                }
                for (const n of targetNodes) {
                    switch (op) {
                        case "mute":
                            n.mode = LiteGraph.NEVER;
                            break;
                        case "!mute":
                            n.mode = LiteGraph.ALWAYS;
                            break;
                        case "bypass":
                            n.mode = 2;
                            break;
                        case "!bypass":
                            n.mode = LiteGraph.ALWAYS;
                            break;
                        case "set":
                        case "!set":
                            // 只对 BranchSwitchNode / BranchBooleanNode 生效
                            if (n.comfyClass === "BranchSwitchNode" || n.comfyClass === "BranchBooleanNode") {
                                const newVal = (op === "set");
                                if (n.widgets[0].value !== newVal) {
                                    n.widgets[0].value = newVal;
                                    if (n.widgets[0].callback) {
                                        n.widgets[0].callback(newVal);
                                    }
                                }
                            }
                            break;
                    }
                    // 如果目标是 BranchSwitchesNode，触发其 select_config 联动
                    const isSwitch = n.comfyClass === "BranchSwitchesNode" || n.type === "BranchSwitchesNode";
                    if (isSwitch && n._processSelectConfig && !_selectConfigGuard.has(n.id)) {
                        if (op === "mute" || op === "bypass") {
                            // mute → 模拟 select=0，所有规则取反
                            n._processSelectConfig(0);
                        } else {
                            // !mute / !bypass → 恢复当前 select 对应的状态
                            const siWidget = n.widgets.find(w => w.name === "select_input");
                            const curSelect = siWidget ? (siWidget.value || 0) : 0;
                            n._processSelectConfig(curSelect);
                        }
                    }
                }
                if (targetNodes.length > 0) {
                    graph.setDirtyCanvas(true, true);
                    if (graph.change) graph.change();
                }
            }

            function processSelectConfig(selectIndex) {
                // 防重入
                if (_selectConfigGuard.has(node.id)) return;
                _selectConfigGuard.add(node.id);
                try {
                    const configWidget = node.widgets.find(w => w.name === "select_config");
                    if (!configWidget) return;
                    const configStr = (configWidget.value || "").trim();
                    if (!configStr) return;

                    const graph = node.graph;
                    if (!graph) return;

                    const OPPOSITE_OPS = {
                        "mute": "!mute",
                        "!mute": "mute",
                        "bypass": "!bypass",
                        "!bypass": "bypass",
                        "set": "!set",
                        "!set": "set"
                    };

                    const segments = configStr.split(",").map(s => s.trim()).filter(s => s);
                    for (const seg of segments) {
                        const parts = seg.split(":");
                        if (parts.length < 4) continue;

                        const segSelectIndex = parseInt(parts[0]);
                        if (isNaN(segSelectIndex)) continue;

                        const op = parts[1];
                        if (!OPPOSITE_OPS.hasOwnProperty(op)) continue;

                        const targetType = parts[2];
                        const targetValue = parts.slice(3).join(":");

                        const matches = (selectIndex === segSelectIndex);
                        const effectiveOp = matches ? op : OPPOSITE_OPS[op];

                        applyNodeOp(graph, targetType, targetValue, effectiveOp);
                    }
                } finally {
                    _selectConfigGuard.delete(node.id);
                }
            }

            // 暴露到 node 上，供其他 node 在联动时调用
            node._processSelectConfig = processSelectConfig;

            // 连接/断开处理
            const origOnConnectionsChange = node.onConnectionsChange;
            node.onConnectionsChange = function (type, slot, connected, link_info) {
                console.log("[BranchSwitchesNode] onConnectionsChange", { type, slot, connected, link_info, LiteGraphINPUT: LiteGraph.INPUT, inputs: node.inputs?.map(i => ({name: i.name, link: i.link})) });
                if (origOnConnectionsChange) {
                    origOnConnectionsChange.apply(this, arguments);
                }
                if (type === LiteGraph.INPUT) {
                    // 防御性检查
                    if (!node.inputs[slot] || !node.inputs[slot].name.startsWith("input")) {
                        node.setDirtyCanvas(true, true);
                        return;
                    }
                    if (connected){
                        let dynamicInputs = node.inputs.filter(inp => inp.name.startsWith("input"));
                        let connectedCount = dynamicInputs.filter(inp => inp.link != null).length;
                        let unconnectedCount = dynamicInputs.length - connectedCount;
                        // 如果正在连接第一个动态端口,并且没有连接类.
                        if(connectedCount === 1 && !currentConnected){
                            currentConnected = true;
                            const link = link_info || getLink(node.graph, node.inputs[slot].link);
                            if (link) {
                                const upstreamNode = node.graph.getNodeById(link.origin_id);
                                if (upstreamNode && upstreamNode.outputs && link.origin_slot < upstreamNode.outputs.length) {
                                    const outputInfo = upstreamNode.outputs[link.origin_slot];
                                    currentType = outputInfo.type;
                                    updateInputsType();
                                    updateOutputsType();
                                }
                            }
                        }
                        if (unconnectedCount === 0){
                            // 添加一个空闲端口.
                            addDynamicInput();
                        }
                        updateComboOptions();
                    }else{
                        let dynamicInputs = node.inputs.filter(inp => inp.name.startsWith("input"));
                        let connectedCount = dynamicInputs.filter(inp => inp.link != null).length;
                        let unconnectedCount = dynamicInputs.length - connectedCount;
                        if(unconnectedCount > 1){
                            // 移除末尾多余的未连接端口，避免已连接端口的索引/名称变化导致连接错位
                            let lastUnconnectedIdx = -1;
                            for (let i = node.inputs.length - 1; i >= 0; i--) {
                                if (node.inputs[i].name.startsWith("input") && node.inputs[i].link == null) {
                                    lastUnconnectedIdx = i;
                                    break;
                                }
                            }
                            if (lastUnconnectedIdx >= 0) {
                                const removedNum = parseInt(node.inputs[lastUnconnectedIdx].name.replace("input", "")) || (lastUnconnectedIdx + 1);
                                node.removeInput(lastUnconnectedIdx);
                                if (selectInputWidget.value === removedNum) {
                                    selectInputWidget.value = 0;
                                }
                            }
                            updateComboOptions();
                        }
                        // 重新计算,因为上面可能移除了端口
                        dynamicInputs = node.inputs.filter(inp => inp.name.startsWith("input"));
                        connectedCount = dynamicInputs.filter(inp => inp.link != null).length;
                        // 如果只有一个动态端口,那么需要看输出有没有连接,来决定是否断开类型.
                        if(connectedCount === 0){
                            // 如果输出端口没有连接,那么断开类型.
                            if(!node.outputs[0] || !node.outputs[0].links || node.outputs[0].links.length === 0){
                                currentType = "*";
                                currentConnected = false;
                                updateInputsType();
                                updateOutputsType();
                            }
                        }
                    }
                }else if(type === LiteGraph.OUTPUT){
                    if (connected){
                        // 如果正在连接输出端口,并且没有连接类.
                        if(slot === 0 && !currentConnected){
                            currentConnected = true;
                            const link = link_info || (node.outputs[0] && node.outputs[0].links ? getLink(node.graph, node.outputs[0].links[0]) : null);
                            if (link) {
                                const downstreamNode = node.graph.getNodeById(link.target_id);
                                if (downstreamNode && downstreamNode.inputs && link.target_slot < downstreamNode.inputs.length) {
                                    const inputInfo = downstreamNode.inputs[link.target_slot];
                                    currentType = inputInfo.type;
                                    updateInputsType();
                                    updateOutputsType();
                                }
                            }
                        }
                    }else{
                        let dynamicInputs = node.inputs.filter(inp => inp.name.startsWith("input"));
                        let anyConnected = dynamicInputs.some(inp => inp.link != null);
                        if(!anyConnected){
                            currentType = "*";
                            currentConnected = false;
                            updateInputsType();
                            updateOutputsType();
                        }
                    }
                }
                node.setDirtyCanvas(true, true);
            };

            // Combo 回调 - 选择后同步到 selectInputWidget + 处理 select_config
            const origSelectCallback = selectWidget.callback;
            selectWidget.callback = function (value) {
                if (origSelectCallback) {
                    origSelectCallback.call(this, value);
                }
                const match = value.match(/\[(\d+)\]/);
                if (match) {
                    const idx = parseInt(match[1]);
                    selectInputWidget.value = idx;
                    processSelectConfig(idx);
                } else {
                    processSelectConfig(0);
                }
                updateBranchNode(node);
                updateActiveAndFoldout();
            };

            // select_input 被手动修改后同步回 combo
            const origInputCallback = selectInputWidget.callback;
            selectInputWidget.callback = function (value) {
                if (origInputCallback) {
                    origInputCallback.call(this, value);
                }
                updateComboOptions();
            };

            function initFromConnections() {
                let dynamicInputs = node.inputs.filter(inp => inp.name.startsWith("input"));
                let connectedInputs = dynamicInputs.filter(inp => inp.link != null);
                if (connectedInputs.length > 0) {
                    currentConnected = true;
                    const first = connectedInputs[0];
                    const link = getLink(node.graph, first.link);
                    if (link) {
                        const upstreamNode = link ? node.graph.getNodeById(link.origin_id) : null;
                        if (upstreamNode && upstreamNode.outputs && link.origin_slot < upstreamNode.outputs.length) {
                            currentType = upstreamNode.outputs[link.origin_slot].type;
                        }
                    }
                }
                let outputConnected = node.outputs[0] && node.outputs[0].links && node.outputs[0].links.length > 0;
                if (!currentConnected && outputConnected) {
                    currentConnected = true;
                    const link = getLink(node.graph, node.outputs[0].links[0]);
                    if (link) {
                        const downstreamNode = node.graph.getNodeById(link.target_id);
                        if (downstreamNode && downstreamNode.inputs && link.target_slot < downstreamNode.inputs.length) {
                            currentType = downstreamNode.inputs[link.target_slot].type;
                        }
                    }
                }
                updateInputsType();
                updateOutputsType();
            }

            function ensureInputCount() {
                let dynamicInputs = node.inputs.filter(inp => inp.name.startsWith("input"));
                let connectedCount = dynamicInputs.filter(inp => inp.link != null).length;
                while (dynamicInputs.length < connectedCount + 1) {
                    addDynamicInput();
                    dynamicInputs = node.inputs.filter(inp => inp.name.startsWith("input"));
                }
                while (dynamicInputs.length > connectedCount + 1) {
                    for (let i = node.inputs.length - 1; i >= 0; i--) {
                        if (node.inputs[i].name.startsWith("input") && node.inputs[i].link == null) {
                            node.removeInput(i);
                            break;
                        }
                    }
                    dynamicInputs = node.inputs.filter(inp => inp.name.startsWith("input"));
                }
                let index = 1;
                for (let i = 0; i < node.inputs.length; i++) {
                    if (node.inputs[i].name.startsWith("input")) {
                        node.inputs[i].name = `input${index++}`;
                    }
                }
            }

            // 节点加载时恢复
            const origOnConfigure = node.onConfigure;
            node.onConfigure = function (info) {
                origOnConfigure?.apply(this, arguments);
                initFromConnections();
                ensureInputCount();
                updateComboOptions();
                // 同步 select_input 与 selectWidget
                const match = (selectWidget.value || "").match(/\[(\d+)\]/);
                if (match) {
                    selectInputWidget.value = parseInt(match[1]);
                } else {
                    selectInputWidget.value = 0;
                }
                // 恢复时也处理 select_config
                processSelectConfig(selectInputWidget.value || 0);
            };

            // 初始化：恢复已有连接状态，确保端口数量 = 已连接数 + 1
            initFromConnections();
            ensureInputCount();
            updateComboOptions();
        };
    }
});