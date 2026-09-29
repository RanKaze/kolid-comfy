import { app } from "../../scripts/app.js";

const MAX_INTERFACE_NUM = 20;

function getLink(graph, linkId) {
    if (!graph || linkId == null) return null;
    if (graph._links) return graph._links.get(linkId);
    if (graph.links) return graph.links[linkId];
    return null;
}

function inferTypeFromInput(node, input) {
    if (!input || input.link == null) return "*";
    const link = getLink(node.graph, input.link);
    if (!link) return "*";
    const upstream = node.graph.getNodeById(link.origin_id);
    if (upstream && upstream.outputs && link.origin_slot < upstream.outputs.length) {
        return upstream.outputs[link.origin_slot].type;
    }
    return "*";
}

function inferTypeFromOutput(node, output) {
    if (!output || !output.links || output.links.length === 0) return "*";
    const link = getLink(node.graph, output.links[0]);
    if (!link) return "*";
    const downstream = node.graph.getNodeById(link.target_id);
    if (downstream && downstream.inputs && link.target_slot < downstream.inputs.length) {
        return downstream.inputs[link.target_slot].type;
    }
    return "*";
}

// Start 的 value 端口类型: 输入侧优先 (上游输出是什么就是什么); 只有输入侧是任意类型时,
// 才跟着这条输出连到的下游端口走。输入端口本身始终是它自己的类型, 不会被下游改写。
function resolveStartPortType(node, input, output) {
    const fromInput = inferTypeFromInput(node, input);
    if (fromInput && fromInput !== "*") return fromInput;
    const fromOutput = inferTypeFromOutput(node, output);
    return fromOutput && fromOutput !== "*" ? fromOutput : "*";
}

function isValuePort(name) {
    return name && /^value\d+$/.test(name);
}

function updatePortTypesWidget(node, fromOutput) {
    const ports = {};
    for (const inp of node.inputs || []) {
        const m = inp.name && inp.name.match(/^value(\d+)$/);
        if (m) (ports[m[1]] ||= {}).input = inp;
    }
    for (const out of node.outputs || []) {
        const m = out.name && out.name.match(/^value(\d+)$/);
        if (m) (ports[m[1]] ||= {}).output = out;
    }
    const types = {};
    for (const [portNum, { input, output }] of Object.entries(ports)) {
        const t = fromOutput ? resolveStartPortType(node, input, output)
                             : inferTypeFromInput(node, input);
        if (t && t !== "*") types[portNum] = t;
    }
    const widget = node.widgets?.find(w => w.name === "port_types");
    if (widget) widget.value = JSON.stringify(types);
}


// ═══════════════════════════════════════════════════════════════════
// InterfaceStartNode
// Input-driven: same pattern as InterfaceEndNode.
// - Output[0] = interface (always present, never removed)
// - value1 input from INPUT_TYPES, never touched; JS adds value2, value3, ...
// - Value outputs rebuilt from connected inputs
// ═══════════════════════════════════════════════════════════════════

function setupInterfaceStart(node) {
    // Don't trim outputs on load — preserve existing output links
    // Only ensure interface output exists at index 0
    if (!node.outputs[0] || node.outputs[0].name !== "interface") {
        // Handle rare case where interface output is missing
        const interfaceOut = node.outputs.find(o => o.name === "interface");
        if (interfaceOut) {
            // Move it to index 0
            const idx = node.outputs.indexOf(interfaceOut);
            if (idx > 0) node.outputs.splice(idx, 1);
            node.outputs.unshift(interfaceOut);
        } else {
            node.addOutput("interface", "INTERFACE");
        }
    }

    // Don't pre-add any value inputs — they're created dynamically on connect

    function getValueInputs() {
        return node.inputs.filter(inp => inp.name && inp.name.match(/^value\d+$/));
    }

    function addDynamicInput() {
        const dynamicInputs = getValueInputs();
        const idx = dynamicInputs.length + 1;
        node.addInput("value" + idx, "*");
    }

    function ensureInputSlots() {
        const dynamicInputs = getValueInputs();
        const connectedCount = dynamicInputs.filter(inp => inp.link != null).length;
        const unconnectedCount = dynamicInputs.length - connectedCount;
        if (unconnectedCount === 0 && dynamicInputs.length < MAX_INTERFACE_NUM) {
            addDynamicInput();
        }
        while (true) {
            const dyn = getValueInputs();
            if (dyn.length <= 1) break;
            const last = dyn[dyn.length - 1];
            const secondLast = dyn[dyn.length - 2];
            if (last.link == null && secondLast.link == null) {
                const idx = node.inputs.indexOf(last);
                node.removeInput(idx);
            } else break;
        }
    }

    // Rebuild the value outputs' TYPES. NEVER adds/removes per-port presence beyond the
    // ADD-only rule below — removing an output would drop its links on reload.
    function syncValueOutputs() {
        // Only ADD missing outputs for connected inputs. Don't remove existing.
        const dynamicInputs = getValueInputs();
        const connectedInputs = dynamicInputs.filter(inp => inp.link != null);
        for (const inp of connectedInputs) {
            if (!node.outputs.some(o => o.name === inp.name)) node.addOutput(inp.name, "*");
        }
        // 输入侧优先; 输入侧是任意类型时这条输出端口跟着它连到的下游端口。
        // 这里遍历全部 value 输出, 因为断开输入不会删掉输出 (见上面的 ADD-only),
        // 那条留着的老输出也该跟着自己的下游走。
        for (const out of node.outputs) {
            if (!isValuePort(out.name)) continue;
            const inp = dynamicInputs.find(i => i.name === out.name);
            const t = resolveStartPortType(node, inp, out);
            if (out.type !== t) out.type = t;
        }
    }

    node.onConnectionsChange = function (type, slot, connected) {
        if (type !== LiteGraph.INPUT) {
            // 输出端的连线变了: 只重解析输出类型, 输入端口自己的类型不动
            if (type === LiteGraph.OUTPUT) syncValueOutputs();
            updatePortTypesWidget(node, true);
            node.setDirtyCanvas(true, true);
            return;
        }
        const inp = node.inputs[slot];
        if (!inp || !isValuePort(inp.name)) {
            node.setDirtyCanvas(true, true);
            return;
        }

        if (connected) {
            const t = inferTypeFromInput(node, inp);
            inp.type = t;
            ensureInputSlots();
            syncValueOutputs();
        } else {
            inp.type = "*";
            ensureInputSlots();
            syncValueOutputs();
        }
        updatePortTypesWidget(node, true);
        node.setDirtyCanvas(true, true);
    };

    // Process existing connections (graph load) — preserve existing outputs
    ensureInputSlots();
    syncValueOutputs(); // Now only ADDS missing outputs, never removes
    updatePortTypesWidget(node, true);
}


// ═══════════════════════════════════════════════════════════════════
// InterfaceEndNode
// Follows BranchSwitchesNode pattern exactly:
// - Never remove the disconnected input itself, only trim trailing empties
// - value1 from INPUT_TYPES is never touched; JS only adds value2, value3, ...
// - All outputs are dynamic value outputs (no package output)
// ═══════════════════════════════════════════════════════════════════

function setupInterfaceEnd(node) {
    // Remove all outputs (no package anymore)
    while (node.outputs.length > 0) node.removeOutput(node.outputs.length - 1);

    // Don't pre-add any value inputs — they're created dynamically on connect

    function getValueInputs() {
        return node.inputs.filter(inp => inp.name && inp.name.match(/^value\d+$/));
    }

    function addDynamicInput() {
        const dynamicInputs = getValueInputs();
        const idx = dynamicInputs.length + 1;
        node.addInput("value" + idx, "*");
    }

    function ensureInputSlots() {
        // BranchSwitchesNode pattern: ensure one empty trailing input
        const dynamicInputs = getValueInputs();
        const connectedCount = dynamicInputs.filter(inp => inp.link != null).length;
        const unconnectedCount = dynamicInputs.length - connectedCount;
        if (unconnectedCount === 0 && dynamicInputs.length < MAX_INTERFACE_NUM) {
            addDynamicInput();
        }
        // Trim trailing unconnected inputs (keep at most 1 empty)
        while (true) {
            const dyn = getValueInputs();
            if (dyn.length <= 1) break;
            const last = dyn[dyn.length - 1];
            const secondLast = dyn[dyn.length - 2];
            if (last.link == null && secondLast.link == null) {
                const idx = node.inputs.indexOf(last);
                node.removeInput(idx);
            } else break;
        }
    }

    function syncValueOutputs() {
        // Remove all outputs
        while (node.outputs.length > 0) node.removeOutput(node.outputs.length - 1);
        // Add one output per connected value input
        const dynamicInputs = getValueInputs();
        for (const inp of dynamicInputs) {
            if (inp.link == null) continue;
            const t = inferTypeFromInput(node, inp);
            node.addOutput(inp.name, t);
        }
    }

    node.onConnectionsChange = function (type, slot, connected) {
        if (type !== LiteGraph.INPUT) {
            node.setDirtyCanvas(true, true);
            return;
        }
        const inp = node.inputs[slot];
        if (!inp || !inp.name || !inp.name.match(/^value\d+$/)) {
            node.setDirtyCanvas(true, true);
            return;
        }

        if (connected) {
            // Infer type and set on the input
            const t = inferTypeFromInput(node, inp);
            inp.type = t;
            ensureInputSlots();
            syncValueOutputs();
        } else {
            // Reset type to * but DON'T remove the input
            inp.type = "*";
            ensureInputSlots();
            syncValueOutputs();
        }
        updatePortTypesWidget(node);
        node.setDirtyCanvas(true, true);
    };

    // Process existing connections (graph load)
    ensureInputSlots();
    syncValueOutputs();
    updatePortTypesWidget(node);
}


app.registerExtension({
    name: "KleinBlue.InterfaceNode",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "InterfaceStartNode" && nodeData.name !== "InterfaceEndNode") return;

        const isStart = nodeData.name === "InterfaceStartNode";

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);
            const node = this;
            requestAnimationFrame(() => {
                if (isStart) setupInterfaceStart(node);
                else setupInterfaceEnd(node);
            });
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            origOnConfigure?.apply(this, arguments);
            const node = this;
            requestAnimationFrame(() => {
                if (isStart) setupInterfaceStart(node);
                else setupInterfaceEnd(node);
            });
        };
    }
});
