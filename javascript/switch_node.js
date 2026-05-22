import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "KleinBlue.SnapshotSwitchNode",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "SnapshotSwitchNode") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);
            const node = this;

            let currentType = "*";
            let currentConnected = false;

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

            function updateConnectionInfo() {
                const connWidget = node.widgets.find(w => w.name === "connection_info");
                if (!connWidget) return;
                const info = {};
                node.inputs.forEach((inp, idx) => {
                    if (inp.name.startsWith("input") && inp.link != null) {
                        const link = node.graph.links[inp.link];
                        const upstream = link ? node.graph.getNodeById(link.origin_id) : null;
                        const name = upstream ? (upstream.title || upstream.type || "Unknown") : "Unknown";
                        info[inp.name] = name;
                    }
                });
                info["__node_title__"] = node.title || node.type || "SnapshotSwitchNode";
                connWidget.value = JSON.stringify(info);
            }

            // 连接/断开处理
            node.onConnectionsChange = function (type, slot, connected) {
                if (type === LiteGraph.INPUT) {
                    if (node.inputs[slot] && node.inputs[slot].name.startsWith("input")) {
                        if (connected) {
                            let dynamicInputs = node.inputs.filter(inp => inp.name.startsWith("input"));
                            let connectedCount = dynamicInputs.filter(inp => inp.link != null).length;
                            let unconnectedCount = dynamicInputs.length - connectedCount;
                            // 推断类型
                            if (connectedCount === 1 && !currentConnected) {
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
                            // 如果无空闲端口，添加一个
                            if (unconnectedCount === 0) {
                                addDynamicInput();
                            }
                            updateConnectionInfo();
                        } else {
                            let dynamicInputs = node.inputs.filter(inp => inp.name.startsWith("input"));
                            let connectedCount = dynamicInputs.filter(inp => inp.link != null).length;
                            let unconnectedCount = dynamicInputs.length - connectedCount;
                            // 如果未连接端口超过1个，删除多余的
                            if (unconnectedCount > 1) {
                                node.removeInput(slot);
                                let index = 1;
                                for (let i = 0; i < node.inputs.length; i++) {
                                    if (node.inputs[i].name.startsWith("input")) {
                                        node.inputs[i].name = `input${index++}`;
                                    }
                                }
                            }
                            // 如果全部断开且输出也未连接，重置类型
                            if (connectedCount === 0) {
                                if (!node.outputs[0].links || node.outputs[0].links.length === 0) {
                                    currentType = "*";
                                    currentConnected = false;
                                    updateInputsType();
                                    updateOutputsType();
                                }
                            }
                            updateConnectionInfo();
                        }
                    }
                } else if (type === LiteGraph.OUTPUT) {
                    if (connected) {
                        if (slot === 0 && !currentConnected) {
                            currentConnected = true;
                            const output = node.outputs[slot];
                            const link = node.graph.links[output.links[0]];
                            const downstreamNode = node.graph.getNodeById(link.target_id);
                            if (downstreamNode && downstreamNode.inputs && link.target_slot < downstreamNode.inputs.length) {
                                const inputInfo = downstreamNode.inputs[link.target_slot];
                                currentType = inputInfo.type;
                                updateInputsType();
                                updateOutputsType();
                            }
                        }
                    } else {
                        let dynamicInputs = node.inputs.filter(inp => inp.name.startsWith("input"));
                        let anyConnected = dynamicInputs.some(inp => inp.link != null);
                        if (!anyConnected) {
                            currentType = "*";
                            currentConnected = false;
                            updateInputsType();
                            updateOutputsType();
                        }
                    }
                }
                node.setDirtyCanvas(true, true);
            };

            // 确保至少有一个动态输入端口（如果ComfyUI没有从INPUT_TYPES创建的话）
            const existingDynamic = node.inputs.filter(inp => inp.name.startsWith("input"));
            if (existingDynamic.length === 0) {
                addDynamicInput();
            }
            updateConnectionInfo();
        };
    }
});
