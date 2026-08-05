import { app } from "../../scripts/app.js";

const MAX_INTERFACE_NUM = 20;

function parseInterfaceConfig(configStr) {
    const result = {};
    if (!configStr) return result;
    for (const item of configStr.split(",")) {
        const trimmed = item.trim();
        if (!trimmed || !trimmed.includes(":")) continue;
        const idx = trimmed.indexOf(":");
        const num = parseInt(trimmed.substring(0, idx).trim());
        const name = trimmed.substring(idx + 1).trim();
        if (!isNaN(num) && num >= 1 && num <= MAX_INTERFACE_NUM) {
            result[num] = name;
        }
    }
    return result;
}

function getLink(graph, linkId) {
    if (!graph || linkId == null) return null;
    if (graph._links) return graph._links.get(linkId);
    if (graph.links) return graph.links[linkId];
    return null;
}

function getPortName(portNum, config) {
    return config[portNum] || ("value" + portNum);
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

function hookConfigWidget(node, onChange) {
    const widget = node.widgets?.find(w => w.name === "interface_config");
    if (!widget || widget._kolidHooked) return;
    widget._kolidHooked = true;

    const origCallback = widget.callback;
    widget.callback = function (value) {
        if (origCallback) origCallback.call(this, value);
        onChange();
    };

    // ComfyUI multiline STRING only fires callback on Enter/blur.
    // Poll for inputEl and attach 'input' listener for real-time keystroke updates.
    let hooked = false;
    function tryHookInput() {
        if (hooked) return;
        const el = widget.inputEl || widget.element;
        if (el && el.addEventListener) {
            hooked = true;
            el.addEventListener("input", () => {
                widget.value = el.value;
                onChange();
            });
        } else {
            requestAnimationFrame(tryHookInput);
        }
    }
    tryHookInput();
}


// ═══════════════════════════════════════════════════════════════════
// InterfaceStartNode
// Outputs drive inputs. Output index = port number (no renumbering).
// ═══════════════════════════════════════════════════════════════════

function setupInterfaceStart(node) {
    // Trim outputs to: interface(0) + value1(1) only
    while (node.outputs.length > 2) {
        node.removeOutput(node.outputs.length - 1);
    }
    // Remove any value inputs (clean slate)
    for (let i = node.inputs.length - 1; i >= 0; i--) {
        if (node.inputs[i].name && node.inputs[i].name.match(/^value\d+$/)) {
            node.removeInput(i);
        }
    }

    function renamePorts() {
        const config = parseInterfaceConfig(
            node.widgets?.find(w => w.name === "interface_config")?.value || ""
        );
        for (let i = 1; i < node.outputs.length; i++) {
            node.outputs[i].name = getPortName(i, config);
        }
        for (const inp of node.inputs) {
            const m = inp.name && inp.name.match(/^value(\d+)$/);
            if (m) {
                inp.name = getPortName(parseInt(m[1]), config);
            }
        }
        node.setDirtyCanvas(true, true);
    }

    function ensureOutputSlots() {
        let connectedCount = 0;
        for (let i = 1; i < node.outputs.length; i++) {
            if (node.outputs[i].links && node.outputs[i].links.length > 0) connectedCount++;
        }
        // Add output at end if no empty slot and under MAX
        if (node.outputs.length < 1 + MAX_INTERFACE_NUM && connectedCount >= node.outputs.length - 1) {
            node.addOutput("value" + node.outputs.length, "*");
        }
        // Trim trailing unconnected outputs (keep at most 1 empty after the last connected)
        while (node.outputs.length > 2) {
            const last = node.outputs[node.outputs.length - 1];
            const secondLast = node.outputs[node.outputs.length - 2];
            const lastConnected = last.links && last.links.length > 0;
            const secondLastConnected = secondLast.links && secondLast.links.length > 0;
            if (!lastConnected && !secondLastConnected) {
                node.removeOutput(node.outputs.length - 1);
            } else {
                break;
            }
        }
    }

    hookConfigWidget(node, renamePorts);

    node.onConnectionsChange = function (type, slot, connected) {
        if (type === LiteGraph.OUTPUT && slot > 0) {
            // Find input by port number (= output slot index)
            const inputIdx = node.inputs.findIndex(inp => {
                if (!inp.name) return false;
                const m = inp.name.match(/^value(\d+)$/);
                return m && parseInt(m[1]) === slot;
            });
            if (connected) {
                if (inputIdx < 0) {
                    const type = inferTypeFromOutput(node, node.outputs[slot]);
                    node.addInput("value" + slot, type);
                }
                ensureOutputSlots();
            } else {
                if (inputIdx >= 0) {
                    node.removeInput(inputIdx);
                }
                ensureOutputSlots();
            }
            renamePorts();
        }
        node.setDirtyCanvas(true, true);
    };

    // Process existing connections (graph load)
    for (let i = 1; i < node.outputs.length; i++) {
        if (node.outputs[i].links && node.outputs[i].links.length > 0) {
            const type = inferTypeFromOutput(node, node.outputs[i]);
            if (!node.inputs.find(inp => {
                const m = inp.name && inp.name.match(/^value(\d+)$/);
                return m && parseInt(m[1]) === i;
            })) {
                node.addInput("value" + i, type);
            }
        }
    }
    ensureOutputSlots();
    renamePorts();
}


// ═══════════════════════════════════════════════════════════════════
// InterfaceEndNode
// Inputs drive outputs. Sequential numbering.
// On disconnect: remove the input slot entirely → remaining inputs
// shift down (LiteGraph adjusts link.target_slot) → renumber.
// ═══════════════════════════════════════════════════════════════════

function setupInterfaceEnd(node) {
    // Remove all value outputs
    while (node.outputs.length > 0) {
        node.removeOutput(node.outputs.length - 1);
    }
    // Remove any existing value inputs
    for (let i = node.inputs.length - 1; i >= 0; i--) {
        if (node.inputs[i].name && node.inputs[i].name.match(/^value\d+$/)) {
            node.removeInput(i);
        }
    }
    // Add initial value1 input (empty)
    node.addInput("value1", "*");

    function getValueInputs() {
        return node.inputs.filter(inp => inp.name && inp.name.match(/^value\d+$/));
    }

    function getConnectedValueInputs() {
        return getValueInputs().filter(inp => inp.link != null);
    }

    function renumberInputs() {
        const valueInputs = getValueInputs();
        for (let i = 0; i < valueInputs.length; i++) {
            valueInputs[i].name = "value" + (i + 1);
        }
    }

    function ensureInputSlots() {
        renumberInputs();
        const valueInputs = getValueInputs();
        const connectedCount = valueInputs.filter(inp => inp.link != null).length;
        const unconnectedCount = valueInputs.length - connectedCount;

        // Add empty slot if none
        if (unconnectedCount === 0 && valueInputs.length < MAX_INTERFACE_NUM) {
            node.addInput("value" + (valueInputs.length + 1), "*");
        }
        // Trim excess unconnected inputs from the end (keep at most 1 empty)
        while (valueInputs.length > 1) {
            const last = valueInputs[valueInputs.length - 1];
            const secondLast = valueInputs[valueInputs.length - 2];
            if (last.link == null && secondLast.link == null) {
                const idx = node.inputs.indexOf(last);
                node.removeInput(idx);
                valueInputs.pop();
            } else {
                break;
            }
        }
        renumberInputs();
    }

    function renamePorts() {
        const config = parseInterfaceConfig(
            node.widgets?.find(w => w.name === "interface_config")?.value || ""
        );
        const valueInputs = getValueInputs();
        for (let i = 0; i < valueInputs.length; i++) {
            valueInputs[i].name = getPortName(i + 1, config);
        }
        const connectedInputs = getConnectedValueInputs();
        for (let i = 0; i < node.outputs.length && i < connectedInputs.length; i++) {
            node.outputs[i].name = connectedInputs[i].name;
        }
        node.setDirtyCanvas(true, true);
    }

    hookConfigWidget(node, renamePorts);

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
            // ── Connect: add a new output at the end ──
            const outType = inferTypeFromInput(node, inp);
            node.addOutput("value", outType);
            ensureInputSlots();
            renamePorts();
        } else {
            // ── Disconnect: remove input slot + corresponding output ──
            // 1. Compute output index = count of connected value inputs BEFORE this slot
            let outputIdx = 0;
            for (let i = 0; i < slot; i++) {
                const v = node.inputs[i];
                if (v && v.name && v.name.match(/^value\d+$/) && v.link != null) {
                    outputIdx++;
                }
            }
            // 2. Remove the output at that index (LiteGraph shifts remaining outputs)
            if (outputIdx < node.outputs.length) {
                node.removeOutput(outputIdx);
            }
            // 3. Remove the input slot entirely (LiteGraph shifts remaining inputs
            //    and decrements link.target_slot on shifted links)
            node.removeInput(slot);
            // 4. Renumber + ensure one empty slot + rename
            ensureInputSlots();
            renamePorts();
        }
        node.setDirtyCanvas(true, true);
    };

    // Process existing connections (graph load)
    ensureInputSlots();
    const connectedInputs = getConnectedValueInputs();
    for (const inp of connectedInputs) {
        const type = inferTypeFromInput(node, inp);
        node.addOutput("value", type);
    }
    renamePorts();
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
