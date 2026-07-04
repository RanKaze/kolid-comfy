import { app } from "../../scripts/app.js";

// ── CSS injection (once) ──────────────────────────────────────────
const STYLE_ID = "kolid-application-node-styles";
if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.kolid-app-container {
    width: 100%;
    max-height: 500px;
    overflow-y: auto;
    overflow-x: hidden;
    box-sizing: border-box;
    padding: 2px;
}
.kolid-app-container::-webkit-scrollbar { width: 4px; }
.kolid-app-container::-webkit-scrollbar-thumb { background: #555; border-radius: 2px; }

.kolid-app-section {
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 4px;
    margin-bottom: 4px;
    background: rgba(0,0,0,0.25);
    overflow: hidden;
}
.kolid-app-header {
    font-size: 11px;
    font-weight: bold;
    color: #d4d4d4;
    padding: 3px 6px;
    cursor: pointer;
    user-select: none;
    display: flex;
    align-items: center;
    gap: 3px;
    background: rgba(255,255,255,0.04);
}
.kolid-app-header:hover { background: rgba(255,255,255,0.08); }
.kolid-app-arrow {
    display: inline-block;
    width: 8px;
    text-align: center;
    transition: transform 0.15s;
}
.kolid-app-section.collapsed .kolid-app-arrow { transform: rotate(-90deg); }
.kolid-app-section.collapsed .kolid-app-body { display: none; }

.kolid-app-body { padding: 3px 4px; }

.kolid-app-row {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 2px;
}
.kolid-app-row:last-child { margin-bottom: 0; }

.kolid-app-label {
    font-size: 10px;
    color: #aaa;
    min-width: 55px;
    flex-shrink: 0;
    user-select: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.kolid-app-ctrl {
    flex: 1;
    background: #2a2a2a;
    border: 1px solid #444;
    color: #ddd;
    padding: 1px 3px;
    border-radius: 3px;
    font-size: 10px;
    outline: none;
    box-sizing: border-box;
    min-width: 0;
}
.kolid-app-ctrl:focus { border-color: #777; }
.kolid-app-ctrl[type="checkbox"] {
    width: 14px;
    height: 14px;
    flex: none;
    margin: 0;
    cursor: pointer;
}
.kolid-app-ctrl textarea {
    resize: vertical;
    min-height: 40px;
}
.kolid-app-btn {
    flex: 1;
    background: #333;
    border: 1px solid #555;
    color: #ccc;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 10px;
    cursor: pointer;
}
.kolid-app-btn:hover { background: #444; }

.kolid-app-empty {
    font-size: 10px;
    color: #888;
    padding: 6px;
    text-align: center;
}
`;
    document.head.appendChild(style);
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Parse "id:234,id:145,regex:test,name:TT,id:6743(select=>[测试],select_input)" into [{type,value,widgetFilter}, ...]
 * widgetFilter is null (all widgets) or a Map<widgetName, label>
 * where label is: null (use original name), "" (hide label), or a custom string.
 */
function parseCollectNodes(str) {
    const result = [];
    if (!str) return result;

    // Split top-level by commas at depth 0 (respect () and [])
    const segments = [];
    let depth = 0;
    let current = "";
    for (const ch of str) {
        if (ch === "(" || ch === "[") { depth++; current += ch; }
        else if (ch === ")" || ch === "]") { depth--; current += ch; }
        else if (ch === "," && depth === 0) {
            segments.push(current.trim());
            current = "";
        } else {
            current += ch;
        }
    }
    if (current.trim()) segments.push(current.trim());

    for (const seg of segments) {
        // Extract optional widget filter (...)
        let widgetFilter = null;
        let mainPart = seg;
        const parenIdx = seg.indexOf("(");
        if (parenIdx !== -1) {
            const closeIdx = seg.lastIndexOf(")");
            if (closeIdx !== -1 && closeIdx > parenIdx) {
                mainPart = seg.substring(0, parenIdx).trim();
                const filterStr = seg.substring(parenIdx + 1, closeIdx).trim();
                if (filterStr) {
                    widgetFilter = parseWidgetFilter(filterStr);
                }
            }
        }

        const colonIdx = mainPart.indexOf(":");
        if (colonIdx === -1) continue;
        const type = mainPart.substring(0, colonIdx).trim().toLowerCase();
        const value = mainPart.substring(colonIdx + 1).trim();
        result.push({ type, value, widgetFilter });
    }
    return result;
}

/**
 * Parse "select=>[测试],select_input" into Map<name, label|null>
 * - "widgetName" → label = null (use original name)
 * - "widgetName=>[custom]" → label = "custom"
 * - "widgetName=>[]" → label = "" (hide label)
 */
function parseWidgetFilter(filterStr) {
    const map = new Map();
    // Split by commas at depth 0 (respect [])
    const parts = [];
    let depth = 0;
    let current = "";
    for (const ch of filterStr) {
        if (ch === "[") { depth++; current += ch; }
        else if (ch === "]") { depth--; current += ch; }
        else if (ch === "," && depth === 0) {
            parts.push(current.trim());
            current = "";
        } else {
            current += ch;
        }
    }
    if (current.trim()) parts.push(current.trim());

    for (const part of parts) {
        const arrowIdx = part.indexOf("=>[");
        if (arrowIdx !== -1) {
            const closeIdx = part.lastIndexOf("]");
            if (closeIdx !== -1 && closeIdx > arrowIdx) {
                const name = part.substring(0, arrowIdx).trim();
                const label = part.substring(arrowIdx + 3, closeIdx);
                if (name) map.set(name, label);
            }
        } else {
            const name = part.trim();
            if (name) map.set(name, null);
        }
    }
    return map;
}

/**
 * Collect nodes from graph based on parsed criteria, deduplicate, sort by name.
 * Returns [{node, widgetFilter}, ...] where widgetFilter is null or string[].
 */
function collectNodes(graph, parseResult, selfNodeId) {
    const collected = new Map(); // id -> {node, widgetFilter}
    for (const { type, value, widgetFilter } of parseResult) {
        let matchedNodes = [];
        if (type === "id") {
            const id = parseInt(value);
            if (isNaN(id)) continue;
            const n = graph.getNodeById(id);
            if (n && n.id !== selfNodeId) matchedNodes = [n];
        } else if (type === "regex") {
            try {
                const re = new RegExp(value);
                matchedNodes = graph.nodes.filter(n => {
                    if (n.id === selfNodeId) return false;
                    return re.test(n.title || n.type || "");
                });
            } catch (e) {
                // invalid regex, skip
            }
        } else if (type === "name") {
            matchedNodes = graph.nodes.filter(n => {
                if (n.id === selfNodeId) return false;
                return (n.title || n.type || "") === value;
            });
        }

        for (const n of matchedNodes) {
            if (collected.has(n.id)) {
                // Merge widget filters: null wins (all widgets), otherwise merge Maps
                const existing = collected.get(n.id);
                if (existing.widgetFilter === null || widgetFilter === null) {
                    existing.widgetFilter = null;
                } else {
                    for (const [k, v] of widgetFilter) {
                        if (!existing.widgetFilter.has(k)) {
                            existing.widgetFilter.set(k, v);
                        }
                    }
                }
            } else {
                collected.set(n.id, { node: n, widgetFilter });
            }
        }
    }
    return Array.from(collected.values()).sort((a, b) => {
        const na = a.node.title || a.node.type || "";
        const nb = b.node.title || b.node.type || "";
        return na.localeCompare(nb);
    });
}

/**
 * Create an HTML control that mirrors a ComfyUI widget, syncing changes back.
 * @param {object} targetWidget - The original ComfyUI widget
 * @param {object} targetNode - The node that owns the widget
 * @param {string|null} displayLabel - null = use original name, "" = hide label, string = custom label
 */
function createWidgetControl(targetWidget, targetNode, displayLabel) {
    const row = document.createElement("div");
    row.className = "kolid-app-row";

    const type = targetWidget.type || "";
    const opts = targetWidget.options || {};

    // Resolve the label text to show
    const labelText = displayLabel === null
        ? (targetWidget.name || "?")
        : displayLabel; // "" means hide, string means custom

    // Create label element (unless hidden)
    let label = null;
    if (labelText !== "") {
        label = document.createElement("span");
        label.className = "kolid-app-label";
        label.textContent = labelText;
        label.title = targetWidget.name || "";
        row.appendChild(label);
    }

    if (type === "combo") {
        const select = document.createElement("select");
        select.className = "kolid-app-ctrl";
        const values = opts.values || [];
        for (const v of values) {
            const opt = document.createElement("option");
            opt.value = v;
            opt.textContent = v;
            select.appendChild(opt);
        }
        select.value = targetWidget.value;
        select.addEventListener("change", () => {
            targetWidget.value = select.value;
            if (targetWidget.callback) targetWidget.callback.call(targetNode, select.value);
            targetNode.setDirtyCanvas(true, true);
        });
        row.appendChild(select);

    } else if (type === "toggle" || type === "boolean") {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "kolid-app-ctrl";
        cb.checked = !!targetWidget.value;
        cb.addEventListener("change", () => {
            targetWidget.value = cb.checked;
            if (targetWidget.callback) targetWidget.callback.call(targetNode, cb.checked);
            targetNode.setDirtyCanvas(true, true);
        });
        row.appendChild(cb);

    } else if (type === "button") {
        const btn = document.createElement("button");
        btn.className = "kolid-app-btn";
        btn.textContent = labelText !== "" ? labelText : (targetWidget.name || "button");
        btn.addEventListener("click", () => {
            if (targetWidget.callback) targetWidget.callback.call(targetNode);
            targetNode.setDirtyCanvas(true, true);
        });
        // Button replaces the label
        if (label) row.removeChild(label);
        row.appendChild(btn);

    } else if (type === "number" || type === "slider" || type === "INT" || type === "FLOAT") {
        const input = document.createElement("input");
        input.type = "number";
        input.className = "kolid-app-ctrl";
        input.value = targetWidget.value;
        if (opts.min !== undefined) input.min = opts.min;
        if (opts.max !== undefined) input.max = opts.max;
        if (opts.step !== undefined) input.step = opts.step;
        input.addEventListener("change", () => {
            let v = parseFloat(input.value);
            if (isNaN(v)) v = 0;
            if (opts.round) v = Math.round(v / opts.round) * opts.round;
            targetWidget.value = v;
            if (targetWidget.callback) targetWidget.callback.call(targetNode, v);
            targetNode.setDirtyCanvas(true, true);
        });
        row.appendChild(input);

    } else if (opts.multiline) {
        const ta = document.createElement("textarea");
        ta.className = "kolid-app-ctrl";
        ta.value = targetWidget.value || "";
        ta.rows = Math.min(8, Math.max(2, (ta.value.match(/\n/g) || []).length + 1));
        ta.addEventListener("change", () => {
            targetWidget.value = ta.value;
            if (targetWidget.callback) targetWidget.callback.call(targetNode, ta.value);
            targetNode.setDirtyCanvas(true, true);
        });
        row.appendChild(ta);

    } else {
        // default: text input
        const input = document.createElement("input");
        input.type = "text";
        input.className = "kolid-app-ctrl";
        input.value = targetWidget.value !== undefined ? String(targetWidget.value) : "";
        input.addEventListener("change", () => {
            let v = input.value;
            // try to preserve original type
            if (typeof targetWidget.value === "number") v = parseFloat(v) || 0;
            targetWidget.value = v;
            if (targetWidget.callback) targetWidget.callback.call(targetNode, v);
            targetNode.setDirtyCanvas(true, true);
        });
        row.appendChild(input);
    }

    return row;
}

/**
 * Build the full DOM content inside the container.
 */
function rebuildApplicationWidget(node) {
    const container = node._kolidAppContainer;
    if (!container) return;

    container.innerHTML = "";

    const collectNodesWidget = node.widgets.find(w => w.name === "collect_nodes");
    if (!collectNodesWidget) {
        container.innerHTML = '<div class="kolid-app-empty">collect_nodes widget not found</div>';
        return;
    }

    const graph = node.graph;
    if (!graph) {
        container.innerHTML = '<div class="kolid-app-empty">No graph</div>';
        return;
    }

    const parseResult = parseCollectNodes(collectNodesWidget.value);
    const collectedEntries = collectNodes(graph, parseResult, node.id);

    if (collectedEntries.length === 0) {
        container.innerHTML = '<div class="kolid-app-empty">No nodes matched. Use format: id:234,regex:test,name:TT</div>';
        requestAnimationFrame(() => node.setSize(node.computeSize()));
        return;
    }

    for (const { node: targetNode, widgetFilter } of collectedEntries) {
        const section = document.createElement("div");
        section.className = "kolid-app-section";
        section._targetNodeId = targetNode.id;

        // Header (collapsible)
        const header = document.createElement("div");
        header.className = "kolid-app-header";

        const arrow = document.createElement("span");
        arrow.className = "kolid-app-arrow";
        arrow.textContent = "▼";
        header.appendChild(arrow);

        const title = document.createElement("span");
        title.textContent = targetNode.title || targetNode.type || `Node ${targetNode.id}`;
        header.appendChild(title);

        header.addEventListener("click", () => {
            section.classList.toggle("collapsed");
            requestAnimationFrame(() => node.setSize(node.computeSize()));
        });
        section.appendChild(header);

        // Body with widget controls
        const body = document.createElement("div");
        body.className = "kolid-app-body";

        if (!targetNode.widgets || targetNode.widgets.length === 0) {
            body.innerHTML = '<div class="kolid-app-empty" style="padding:2px;">No widgets</div>';
        } else {
            for (const targetWidget of targetNode.widgets) {
                // Skip hidden widgets
                if (targetWidget.hidden) continue;
                // Apply widget filter if specified
                if (widgetFilter) {
                    if (!widgetFilter.has(targetWidget.name)) continue;
                    // null = original name, "" = hide, string = custom
                    const displayLabel = widgetFilter.get(targetWidget.name);
                    body.appendChild(createWidgetControl(targetWidget, targetNode, displayLabel));
                } else {
                    body.appendChild(createWidgetControl(targetWidget, targetNode, null));
                }
            }
            if (body.children.length === 0) {
                body.innerHTML = '<div class="kolid-app-empty" style="padding:2px;">No visible widgets</div>';
            }
        }

        section.appendChild(body);

        // Apply initial visibility based on node mode
        const isMutedOrBypassed = targetNode.mode === 2 || targetNode.mode === 4;
        section.style.display = isMutedOrBypassed ? "none" : "";

        container.appendChild(section);
    }

    requestAnimationFrame(() => node.setSize(node.computeSize()));
}

/**
 * Update section visibility based on collected nodes' mode (mute/bypass).
 */
function updateSectionVisibility(node) {
    const container = node._kolidAppContainer;
    if (!container || !node.graph) return;

    const sections = container.querySelectorAll(".kolid-app-section");
    let changed = false;
    for (const section of sections) {
        const targetNode = node.graph.getNodeById(section._targetNodeId);
        if (!targetNode) {
            // Node was deleted, rebuild
            if (!changed) {
                changed = true;
            }
            continue;
        }
        const isMutedOrBypassed = targetNode.mode === 2 || targetNode.mode === 4;
        const shouldBeVisible = !isMutedOrBypassed;
        const isVisible = section.style.display !== "none";
        if (shouldBeVisible !== isVisible) {
            section.style.display = shouldBeVisible ? "" : "none";
            changed = true;
        }
    }
    if (changed) {
        requestAnimationFrame(() => node.setSize(node.computeSize()));
    }
}

/**
 * Full rebuild + visibility check, called periodically.
 */
function periodicCheck(node) {
    if (!node.graph) return;

    const container = node._kolidAppContainer;
    if (!container) return;

    // Check if any collected node was deleted
    const sections = container.querySelectorAll(".kolid-app-section");
    let needsRebuild = false;
    for (const section of sections) {
        if (!node.graph.getNodeById(section._targetNodeId)) {
            needsRebuild = true;
            break;
        }
    }
    if (needsRebuild) {
        rebuildApplicationWidget(node);
        return;
    }

    updateSectionVisibility(node);
}

// ── Extension registration ─────────────────────────────────────────

app.registerExtension({
    name: "KleinBlue.ApplicationNode",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ApplicationNode") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);
            const node = this;

            if (node._kolidAppSetup) return;
            node._kolidAppSetup = true;

            // Create container element
            const container = document.createElement("div");
            container.className = "kolid-app-container";
            node._kolidAppContainer = container;

            // Add a single DOM widget that wraps everything
            const appWidget = node.addDOMWidget(
                "collected_widgets",
                "kolid_application",
                container,
                {
                    getValue: () => "",
                    setValue: () => {},
                    hideOnZoom: false,
                }
            );
            appWidget.serialize = false;

            // Hook collect_nodes widget callback
            const collectNodesWidget = node.widgets.find(w => w.name === "collect_nodes");
            if (collectNodesWidget) {
                const origCallback = collectNodesWidget.callback;
                collectNodesWidget.callback = function (value) {
                    if (origCallback) origCallback.call(this, value);
                    rebuildApplicationWidget(node);
                };
            }

            // Hook onAdded — node is now in the graph (graph available)
            const origOnAdded = node.onAdded;
            node.onAdded = function () {
                origOnAdded?.apply(this, arguments);
                rebuildApplicationWidget(node);
            };

            // Hook onConfigure for graph loading
            const origOnConfigure = node.onConfigure;
            node.onConfigure = function () {
                origOnConfigure?.apply(this, arguments);
                rebuildApplicationWidget(node);
            };

            // Periodic visibility check (mute/bypass detection + deleted node detection)
            const intervalId = setInterval(() => {
                periodicCheck(node);
            }, 300);

            // Clean up on removal
            const origOnRemoved = node.onRemoved;
            node.onRemoved = function () {
                clearInterval(intervalId);
                if (origOnRemoved) origOnRemoved.apply(this, arguments);
            };

            // Initial build (graph may be null at this point; onAdded will handle it)
            rebuildApplicationWidget(node);
        };
    }
});
