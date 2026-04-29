import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

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
            let relayMarks = extractVariables(beRelayed.properties.relay_expression);

            let parameters = new Map();
            for (let j = 0; j < relayMarks.length; j++) {
                const relayMark = relayMarks[j];
                const relayNode = getNodeFromExpression(relayMark, node);
                parameters.set(relayMark, relayNode.widgets[0].value)
            }

            beRelayed.widgets[0].value = solveExpression(beRelayed.properties.relay_expression, parameters);

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
        // 初始化activeNodes
        let activeNodes = branchNode.properties.active_nodes;
        if(activeNodes){
            for(let activeNode of getNodes(branchNode, activeNodes)){
                activeNode.mode = branchNode.widgets[0].value ? 0 : 2;
            }
        }
        // 初始化foldoutNodes
        let foldoutNodes = branchNode.properties.foldout_nodes;
        if(foldoutNodes){
            for(let foldoutNode of getNodes(branchNode, foldoutNodes)){
                if(foldoutNode.collapsed == branchNode.widgets[0].value) {
                    foldoutNode.collapse();
                }
            }
        }
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
    
    let addFlag = true;
    let hide = false;
    if('hide' in expandNode.properties && expandNode.properties.hide){
        addFlag = false;
        hide = true;
    }
    let added = false;

    let block = {
        indent : indent,
        id: expandNode.id,
    };
    
    // 如果展开的节点是BranchToggleNode或BranchBooleanNode，递归展开它的expand_nodes
    let value = layoutValue(expandNode);
    if(value !== undefined){
        if (value) {
            let expandNodes = expandNode.properties.expand_nodes;
            if(expandNodes){
                if(addFlag){
                    added = true;
                    block.indent = indent + 1;
                    block.split = true;
                    yield block;
                }
                let nextIndent = hide ? indent : indent + 1;
                for(let subExpandNode of getNodes(expandNode, expandNodes)){
                    yield* ExpandNode(expandNode, subExpandNode, processedNodes, nextIndent);
                }
            }
        }
    }

    if(addFlag && !added){
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
            const expr = node.properties.relay_expression;
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

            // 初始化activeNodes
            let activeNodes = node.properties.active_nodes;
            if(activeNodes){
                let nodeNames = activeNodes.split('/');
                for(let nodeName of nodeNames){
                    let activeNode = node.graph.nodes.find(n => n.title === nodeName || n.type === nodeName);
                    if(activeNode){
                        // 设置节点mode: true时为0，false时为2
                        activeNode.mode = node.widgets[0].value ? 0 : 2;
                    }
                }
            }

            // 初始化foldoutNodes
            let foldoutNodes = node.properties.foldout_nodes;
            if(foldoutNodes){
                let nodeNames = foldoutNodes.split('/');
                for(let nodeName of nodeNames){
                    let foldoutNode = node.graph.nodes.find(n => n.title === nodeName || n.type === nodeName);
                    if(foldoutNode){
                        // 控制节点折叠状态
                        if(foldoutNode.collapsed == node.widgets[0].value) {
                            foldoutNode.collapse();
                        }
                    }
                }
            }
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
            let addFlag = true;

            if('hide' in targetNode.properties && targetNode.properties.hide) {
                addFlag = false;
            }

            if(addFlag){
                node.addWidget("toggle",targetNode.title,targetNode.widgets[0].value,(value)=>{
                    targetNode.widgets[0].value = value; 
                    if(targetNode.widgets[0].callback){
                        targetNode.widgets[0].callback(targetNode.widgets[0].value);
                    }
                });
            }
        }
    }
    // AlwaysOne模式：将所有BranchNode打包成一个combo控件
    else if (layoutBranchMode === 'AlwaysOne') {
        if (filteredBranchNodes.length > 0) {
            let allNodes = filteredBranchNodes;
            
            // 收集仅hide为false的节点标题，用于combo控件
            let visibleNodeTitles = allNodes.filter(n => !n.properties.hide).map(n => n.title);
            
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
                // 初始化activeNodes
                let activeNodes = expandNode.properties.active_nodes;
                if(activeNodes){
                    for(let activeNode of getNodes(node, activeNodes)){
                        activeNode.mode = expandNode.widgets[0].value ? 0 : 2;
                    }
                }
                let foldoutNodes = expandNode.properties.foldout_nodes;
                if(foldoutNodes){
                    for(let foldoutNode of getNodes(node, foldoutNodes)){
                        if(foldoutNode.collapsed == expandNode.widgets[0].value) {
                            foldoutNode.collapse();
                        }
                    }
                }
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
            // 收集所有节点，包括hide为true的节点
            let allNodes = filteredBranchNodes;
            
            let visibleNodeTitles = [];

            // 收集仅hide为false的节点标题，用于combo控件
            visibleNodeTitles.push('[None]');
            let tempTitles = allNodes
                .filter(n => !n.properties.hide)
                .map(n => n.title);
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
                // 初始化activeNodes
                let activeNodes = expandNode.properties.active_nodes;
                if(activeNodes){
                    for(let activeNode of getNodes(node, activeNodes)){
                        activeNode.mode = expandNode.widgets[0].value ? 0 : 2;
                    }
                }
                let foldoutNodes = expandNode.properties.foldout_nodes;
                if(foldoutNodes){
                    for(let foldoutNode of getNodes(node, foldoutNodes)){
                        if(foldoutNode.collapsed == expandNode.widgets[0].value) {
                            foldoutNode.collapse();
                        }
                    }
                }
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
        if (!('relay_expression' in node.properties)) {
            node.setProperty('relay_expression', '');
        }
        if (!('expand_nodes' in node.properties)) {
            node.setProperty('expand_nodes', '');
        }
        if (!('active_nodes' in node.properties)) {
            node.setProperty('active_nodes', '');
        }
        if (!('foldout_nodes' in node.properties)) {
            node.setProperty('foldout_nodes', '');
        }
        if (!('hide' in node.properties)) {
            node.setProperty('hide', false);
        }

        // 创建需要重建
        if(is_create){
            updateRelayGraph();
            node.onConfigure = () => {
                // Property改变也需要重建
                wrapOnPropertyChanged(node, updateRelayGraph);
            }
        }else{
            wrapOnPropertyChanged(node, updateRelayGraph);
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
    }else if (node.comfyClass === "BranchGroupNode") {
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

app.registerExtension({
    name: "KleinBlue.BranchSwitchesNode",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "BranchSwitchesNode") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);
            const node = this;

            let currentType = "*";
            let currentConnected = false;

            // ==================== 修改：显示用的 Combo 改名为 "select" ====================
            const selectWidget = node.widgets[0];

            // ==================== 隐藏的真实 select_input ====================
            // 先尝试查找是否已存在（防止重复添加）
            let selectInputWidget = node.widgets.find(w => w.name === "select_input");
            if (!selectInputWidget) {
                selectInputWidget = node.addWidget("number", "select_input", 0);
            }

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
                dynamicInputs.forEach((input, idx) => {
                    if (input.link != null) {
                        connectedCount++;
                        const link = node.graph.links[input.link];
                        const upstream = link ? node.graph.getNodeById(link.origin_id) : null;
                        const name = upstream ? (upstream.title || upstream.type || "未知节点") : "未知节点";
                        options.push(`[${idx + 1}] ${name}`);
                    }
                });

                selectWidget.options.values = connectedCount > 0 ? options : ["[None]"];
                
                const currentIdx = selectInputWidget.value || 0;
                if (connectedCount > 0) {
                    selectWidget.value = options[Math.min(currentIdx, options.length - 1)] || options[0];
                } else {
                    selectWidget.value = "[None]";
                    selectInputWidget.value = 0;
                }
            }

            // 连接/断开处理
            node.onConnectionsChange = function (type, slot, connected) {
                if (type === LiteGraph.INPUT) {
                    // 如果正在操作一个动态端口.
                    if(node.inputs[slot].name.startsWith("input")){
                        if (connected){
                            let dynamicInputs = node.inputs.filter(inp => inp.name.startsWith("input"));
                            let connectedCount = dynamicInputs.filter(inp => inp.link != null).length;
                            let unconnectedCount = dynamicInputs.length - connectedCount;
                            // 如果正在连接第一个动态端口,并且没有连接类.
                            if(connectedCount === 1 && !currentConnected){
                                currentConnected = true;
                                const input = node.inputs[slot];
                                const link = node.graph.links[input.link];
                                const upstreamNode = node.graph.getNodeById(link.origin_id);
                                if (upstreamNode && upstreamNode.outputs && link.origin_slot < upstreamNode.outputs.length) {
                                    const outputInfo = upstreamNode.outputs[link.origin_slot];
                                    currentType = outputInfo.type;
                                    updateInputsType();
                                    updateOutputsType();
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
                                node.removeInput(slot);
                                let index = 1;
                                for (let i = slot; i < node.inputs.length; i++) {
                                    if(node.inputs[i].name.startsWith("input")){
                                        node.inputs[i].name = `input${index++}`;
                                    }
                                }
                                updateComboOptions();
                            }
                            // 如果只有一个动态端口,那么需要看输出有没有连接,来决定是否断开类型.
                            if(connectedCount === 0){
                                // 如果输出端口没有连接,那么断开类型.
                                if(!node.outputs[0].link){
                                    currentType = "*";
                                    currentConnected = false;
                                    updateInputsType();
                                    updateOutputsType();
                                }
                            }
                        }
                    }
                }else if(type === LiteGraph.OUTPUT){
                    if (connected){
                        // 如果正在连接输出端口,并且没有连接类.
                        if(slot === 0 && !currentConnected){
                            currentConnected = true;
                            const output = node.outputs[slot];
                            const link = node.graph.links[output.links[0]];
                            const upstreamNode = node.graph.getNodeById(link.origin_id);
                            if (upstreamNode && upstreamNode.inputs && link.origin_slot < upstreamNode.inputs.length) {
                                const inputInfo = upstreamNode.inputs[link.origin_slot];
                                currentType = inputInfo.type;   
                                updateInputsType();
                                updateOutputsType();
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

            // Combo 回调 - 选择后同步到 selectInputWidget
            selectWidget.callback = function (value) {
                const match = value.match(/\[(\d+)\]/);
                if (match) {
                    selectInputWidget.value = parseInt(match[1]);
                }
            };

            // 节点加载时恢复
            const origOnConfigure = node.onConfigure;
            node.onConfigure = function (info) {
                origOnConfigure?.apply(this, arguments);
            };

            // 初始化：创建一个空端口
            addDynamicInput();
        };
    }
});