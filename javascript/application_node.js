import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ── CSS injection (once) ──────────────────────────────────────────
const STYLE_ID = "kolid-application-node-styles";
if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.kolid-app-container {
    width: 100%;
    overflow-y: visible;
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
.kolid-app-img-preview {
    margin-top: 4px;
    padding: 2px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
.kolid-app-img-preview img,
.kolid-app-img-preview video {
    object-fit: contain;
    width: 100%;
    height: auto;
    display: block;
    border-radius: 3px;
}

/* ── Syntax-highlighted editor ── */
.kolid-app-editor {
    position: relative;
    width: 100%;
}
.kolid-app-editor-wrap {
    position: relative;
    width: 100%;
}
.kolid-app-editor-highlight {
    margin: 0;
    padding: 4px;
    border: 1px solid transparent;
    border-radius: 3px;
    box-sizing: border-box;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: break-word;
    font-family: monospace;
    font-size: 10px;
    line-height: 1.4;
    pointer-events: none;
    width: 100%;
    min-height: 40px;
}
.kolid-app-editor-input {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 4px;
    border: 1px solid #444;
    border-radius: 3px;
    background: transparent;
    color: transparent;
    caret-color: #fff;
    font-family: monospace;
    font-size: 10px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: break-word;
    resize: none;
    outline: none;
    overflow: hidden;
    box-sizing: border-box;
}
.kolid-app-editor-input::placeholder { color: #666; }
.kolid-app-editor-input:focus { border-color: #777; }
.kolid-seg-error { color: #ff4444; }
.kolid-seg-warning { color: #ffaa00; }
.kolid-seg-ok { color: #44dd44; }
.kolid-seg-separator { color: #666; }

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
.kolid-jump-placeholder { color: #333; }
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
`;
    document.head.appendChild(style);
}

// ── Syntax highlighting helpers ───────────────────────────────────

function escapeHTML(str) {
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;');
}

/**
 * Resolve a single segment to a list of matched node objects.
 */
function resolveSegmentNodes(seg, graph, selfNodeId) {
    if (!graph || !seg) return [];
    let mainPart = seg;
    const parenIdx = seg.indexOf("(");
    if (parenIdx !== -1) {
        const closeIdx = seg.lastIndexOf(")");
        if (closeIdx !== -1 && closeIdx > parenIdx) {
            mainPart = seg.substring(0, parenIdx).trim();
        }
    }
    const colonIdx = mainPart.indexOf(":");
    if (colonIdx === -1) return [];
    const type = mainPart.substring(0, colonIdx).trim().toLowerCase();
    const value = mainPart.substring(colonIdx + 1).trim();
    if (!type || !value) return [];
    if (type === "id") {
        const id = parseInt(value);
        if (isNaN(id)) return [];
        const n = graph.getNodeById(id);
        if (n && n.id !== selfNodeId) return [n];
        return [];
    } else if (type === "regex") {
        try {
            const re = new RegExp(value);
            return graph.nodes.filter(n => n.id !== selfNodeId && re.test(n.title || n.type || ""));
        } catch (e) { return []; }
    } else if (type === "name") {
        return graph.nodes.filter(n => n.id !== selfNodeId && (n.title || n.type || "") === value);
    }
    return [];
}

/**
 * Validate a single segment. Returns "error", "warning", or "ok".
 * - error: syntax problem (bad type, missing colon, bad id, invalid regex, unbalanced brackets)
 * - warning: valid syntax but no matching node found in graph
 * - ok: valid syntax and at least one matching node
 */
function validateSegment(seg, graph, selfNodeId) {
    // Extract and validate the () filter part
    let mainPart = seg;
    const parenIdx = seg.indexOf("(");
    if (parenIdx !== -1) {
        const closeIdx = seg.lastIndexOf(")");
        if (closeIdx === -1 || closeIdx < parenIdx) return "error";
        mainPart = seg.substring(0, parenIdx).trim();
        const filterStr = seg.substring(parenIdx + 1, closeIdx);
        if (filterStr.trim()) {
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
                    const bracketClose = part.lastIndexOf("]");
                    if (bracketClose === -1 || bracketClose < arrowIdx + 3) return "error";
                    const name = part.substring(0, arrowIdx).trim();
                    if (!name) return "error";
                } else {
                    if (part.includes("=>")) return "error";
                    if (!part.trim()) return "error";
                }
            }
        }
    }

    // Check type:value structure
    const colonIdx = mainPart.indexOf(":");
    if (colonIdx === -1) return "error";

    const type = mainPart.substring(0, colonIdx).trim().toLowerCase();
    const value = mainPart.substring(colonIdx + 1).trim();

    if (!type || !value) return "error";
    if (!["id", "regex", "name"].includes(type)) return "error";

    if (type === "id") {
        const id = parseInt(value);
        if (isNaN(id)) return "error";
        if (!graph) return "warning";
        const n = graph.getNodeById(id);
        if (!n || n.id === selfNodeId) return "warning";
        return "ok";
    } else if (type === "regex") {
        try {
            const re = new RegExp(value);
            if (!graph) return "warning";
            const matched = graph.nodes.some(n =>
                n.id !== selfNodeId && re.test(n.title || n.type || "")
            );
            return matched ? "ok" : "warning";
        } catch (e) {
            return "error";
        }
    } else if (type === "name") {
        if (!graph) return "warning";
        const matched = graph.nodes.some(n =>
            n.id !== selfNodeId && (n.title || n.type || "") === value
        );
        return matched ? "ok" : "warning";
    }

    return "error";
}

/**
 * Build colored HTML from the raw text.
 * Splits by top-level commas (respecting () and []), validates each segment,
 * wraps in colored spans.
 */
function buildHighlightedHTML(text, graph, selfNodeId) {
    if (!text) return "";

    const segments = [];
    let depth = 0;
    let current = "";
    for (const ch of text) {
        if (ch === "(" || ch === "[") { depth++; current += ch; }
        else if (ch === ")" || ch === "]") { depth--; current += ch; }
        else if (ch === "," && depth === 0) {
            segments.push(current);
            segments.push(",");
            current = "";
        } else {
            current += ch;
        }
    }
    if (current) segments.push(current);

    let html = "";
    for (const seg of segments) {
        if (seg === ",") {
            html += '<span class="kolid-seg-separator">,</span>';
        } else {
            const trimmed = seg.trim();
            if (!trimmed) {
                html += escapeHTML(seg);
            } else {
                const status = validateSegment(trimmed, graph, selfNodeId);
                html += `<span class="kolid-seg-${status}">${escapeHTML(seg)}</span>`;
            }
        }
    }
    // Trailing newline: add a space so the <pre> shows the last empty line
    if (text.endsWith("\n")) html += " ";
    return html;
}

/**
 * Build jump buttons list from parsed segments — one entry per matched node.
 */
function buildJumpButtons(text, graph, selfNodeId) {
    if (!text || !graph) return [];
    const segments = [];
    let depth = 0;
    let current = "";
    for (const ch of text) {
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

    const buttons = [];
    const seenIds = new Set();
    for (const seg of segments) {
        if (!seg) continue;
        const status = validateSegment(seg, graph, selfNodeId);
        if (status !== "ok") continue;
        const nodes = resolveSegmentNodes(seg, graph, selfNodeId);
        for (const n of nodes) {
            if (seenIds.has(n.id)) continue;
            seenIds.add(n.id);
            buttons.push({ id: n.id, title: n.title || n.type || `Node ${n.id}` });
        }
    }
    return buttons;
}

/**
 * Create a syntax-highlighted textarea editor overlay.
 * Returns { container, textarea, update }.
 * Does NOT reference the original widget — value is stored in the textarea itself.
 */
function createHighlightEditor(initialValue, node) {
    const container = document.createElement("div");
    container.className = "kolid-app-editor";

    const editorWrap = document.createElement("div");
    editorWrap.className = "kolid-app-editor-wrap";
    container.appendChild(editorWrap);

    const highlight = document.createElement("pre");
    highlight.className = "kolid-app-editor-highlight";
    editorWrap.appendChild(highlight);

    const textarea = document.createElement("textarea");
    textarea.className = "kolid-app-editor-input";
    textarea.value = initialValue || "";
    textarea.placeholder = "id:234,regex:test,name:TT,id:6743(select=>[测试],select_input)";
    editorWrap.appendChild(textarea);

    const jumpBar = document.createElement("div");
    jumpBar.className = "kolid-jump-bar";
    container.appendChild(jumpBar);

    function jumpToNode(targetId) {
        if (!node.graph) return;
        const target = node.graph.getNodeById(targetId);
        if (!target) return;
        // Center on target node then select it
        if (app.canvas) {
            app.canvas.centerOnNode(target);
            app.canvas.selectNode(target);
            app.canvas.setDirty(true, true);
        }
    }

    function updateHighlight() {
        highlight.innerHTML = buildHighlightedHTML(textarea.value, node.graph, node.id);

        // Rebuild inline jump buttons
        jumpBar.innerHTML = "";

        // Split segments the same way as buildHighlightedHTML
        const segments = [];
        let depth = 0;
        let current = "";
        const text = textarea.value;
        for (const ch of text) {
            if (ch === "(" || ch === "[") { depth++; current += ch; }
            else if (ch === ")" || ch === "]") { depth--; current += ch; }
            else if (ch === "," && depth === 0) {
                segments.push(current.trim());
                segments.push(",");
                current = "";
            } else {
                current += ch;
            }
        }
        if (current.trim()) segments.push(current.trim());

        const seenIds = new Set();
        for (const seg of segments) {
            if (seg === ",") {
                const sep = document.createElement("span");
                sep.className = "kolid-jump-sep";
                sep.textContent = ",";
                jumpBar.appendChild(sep);
                continue;
            }
            if (!seg) continue;
            const status = validateSegment(seg, node.graph, node.id);
            if (status === "ok") {
                const nodes = resolveSegmentNodes(seg, node.graph, node.id);
                for (const n of nodes) {
                    if (seenIds.has(n.id)) continue;
                    seenIds.add(n.id);
                    const btn = document.createElement("span");
                    btn.className = "kolid-jump-btn";
                    btn.title = `Jump to ${n.title || n.type} (id:${n.id})`;
                    btn.innerHTML = `<span class="kolid-jump-btn-arrow">→</span>${escapeHTML(n.title || n.type || `Node ${n.id}`)}`;
                    btn.addEventListener("click", () => jumpToNode(n.id));
                    jumpBar.appendChild(btn);
                }
            } else {
                // Placeholder to keep alignment
                const ph = document.createElement("span");
                ph.className = "kolid-jump-placeholder";
                ph.textContent = '·';
                jumpBar.appendChild(ph);
            }
        }
    }

    let rebuildTimer = null;
    textarea.addEventListener("input", () => {
        updateHighlight();
        clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(() => {
            rebuildApplicationWidget(node);
        }, 300);
    });

    updateHighlight();

    return { container, textarea, update: updateHighlight };
}

// ── Widget builder ─────────────────────────────────────────────────

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
 * Combine two widget filters. Outer filter takes precedence (overrides inner).
 * - outer null → use inner
 * - outer not null → use outer
 */
function combineFilters(outer, inner) {
    if (outer != null) return outer;
    return inner;
}

/**
 * Merge an entry into the collected map, combining widget filters and parent app node ids.
 * null wins (all widgets), otherwise union with existing labels taking priority.
 */
function mergeCollectedEntry(collected, entry) {
    if (collected.has(entry.node.id)) {
        const existing = collected.get(entry.node.id);
        if (existing.widgetFilter === null || entry.widgetFilter === null) {
            existing.widgetFilter = null;
        } else {
            for (const [k, v] of entry.widgetFilter) {
                if (!existing.widgetFilter.has(k)) {
                    existing.widgetFilter.set(k, v);
                }
            }
        }
        // Union parent app node ids
        if (entry.parentAppNodeIds) {
            for (const id of entry.parentAppNodeIds) {
                existing.parentAppNodeIds.add(id);
            }
        }
    } else {
        collected.set(entry.node.id, {
            node: entry.node,
            widgetFilter: entry.widgetFilter,
            parentAppNodeIds: new Set(entry.parentAppNodeIds || []),
        });
    }
}

/**
 * Check if a node is an ApplicationNode.
 */
function isApplicationNode(n) {
    return n && (n.comfyClass === "ApplicationNode" || n.type === "ApplicationNode");
}

/**
 * Collect nodes from graph based on parsed criteria, deduplicate, sort by name.
 * Recursively expands nested ApplicationNodes with cycle detection.
 * Returns { entries: [{node, widgetFilter}], expandedAppNodes: [node] }.
 */
function collectNodes(graph, parseResult, selfNodeId, expandingAppNodes, parentWidgetFilter) {
    if (!expandingAppNodes) expandingAppNodes = new Set();
    expandingAppNodes.add(selfNodeId);

    const collected = new Map();
    const expandedAppNodes = [];
    const expandedAppNodeIds = new Set();

    for (const { type, value, widgetFilter } of parseResult) {
        const combinedFilter = combineFilters(parentWidgetFilter, widgetFilter);

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
            if (isApplicationNode(n)) {
                // Cycle detection: skip if already on the expansion path
                if (expandingAppNodes.has(n.id)) continue;

                expandingAppNodes.add(n.id);
                if (!expandedAppNodeIds.has(n.id)) {
                    expandedAppNodeIds.add(n.id);
                    expandedAppNodes.push(n);
                }

                // Read nested ApplicationNode's collect_nodes value
                const nestedWidget = n.widgets?.find(w => w.name === "collect_nodes");
                const nestedValue = nestedWidget
                    ? (nestedWidget.getValue ? nestedWidget.getValue() : nestedWidget.value)
                    : "";
                const nestedParseResult = parseCollectNodes(nestedValue);
                const { entries: nestedEntries } = collectNodes(
                    graph, nestedParseResult, n.id, expandingAppNodes, combinedFilter
                );

                expandingAppNodes.delete(n.id);

                for (const entry of nestedEntries) {
                    // Add the nested ApplicationNode as a parent
                    entry.parentAppNodeIds.add(n.id);
                    mergeCollectedEntry(collected, entry);
                }
            } else {
                mergeCollectedEntry(collected, { node: n, widgetFilter: combinedFilter, parentAppNodeIds: [] });
            }
        }
    }

    expandingAppNodes.delete(selfNodeId);

    const entries = Array.from(collected.values()).sort((a, b) => {
        const na = a.node.title || a.node.type || "";
        const nb = b.node.title || b.node.type || "";
        return na.localeCompare(nb);
    });

    return { entries, expandedAppNodes };
}

/**
 * Create an HTML control that mirrors a ComfyUI widget, syncing changes back.
 * @param {object} targetWidget - The original ComfyUI widget
 * @param {object} targetNode - The node that owns the widget
 * @param {string|null} displayLabel - null = use original name, "" = hide label, string = custom label
 * @returns {{row: HTMLElement, sync: Function, cleanup?: Function}} The row element, a sync function, and optional cleanup.
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

    // The control element we create (for sync back)
    let ctrlEl = null;
    // Whether the widget is a combo-like (has options.values)
    const isCombo = type === "combo" || (Array.isArray(opts.values) && opts.values.length > 0);

    // ── DOM widget (e.g. image preview, upload button) ──
    // These widgets have an .element property that is an HTMLElement.
    // We clone the element and keep it in sync via MutationObserver.
    // Skip image preview DOM widgets — handled separately via node.imgs
    if (targetWidget.element instanceof HTMLElement &&
        !targetWidget.element.classList.contains("comfy-img-preview")) {
        const wrapper = document.createElement("div");
        wrapper.className = "kolid-app-ctrl";
        wrapper.style.padding = "0";
        wrapper.style.border = "none";
        wrapper.style.background = "transparent";

        const clone = targetWidget.element.cloneNode(true);
        clone.style.maxWidth = "100%";
        clone.style.display = "";
        wrapper.appendChild(clone);
        row.appendChild(wrapper);

        // Keep clone in sync with original element
        const observer = new MutationObserver(() => {
            // Re-clone attributes
            for (const attr of targetWidget.element.attributes) {
                clone.setAttribute(attr.name, attr.value);
            }
            // Re-clone children
            clone.innerHTML = targetWidget.element.innerHTML;
        });
        observer.observe(targetWidget.element, {
            attributes: true,
            childList: true,
            subtree: true,
            characterData: true,
        });

        // Also sync on widget callback (e.g. image selection change)
        function domSync() {
            if (document.activeElement === wrapper) return;
            for (const attr of targetWidget.element.attributes) {
                clone.setAttribute(attr.name, attr.value);
            }
            clone.innerHTML = targetWidget.element.innerHTML;
        }

        return { row, sync: domSync, cleanup: () => observer.disconnect() };

    } else if (isCombo) {
        ctrlEl = document.createElement("select");
        ctrlEl.className = "kolid-app-ctrl";
        const values = opts.values || [];
        for (const v of values) {
            const opt = document.createElement("option");
            opt.value = v;
            opt.textContent = v;
            ctrlEl.appendChild(opt);
        }
        // Ensure current value is always selectable (may not be in values list yet)
        const currentVal = String(targetWidget.value ?? "");
        if (currentVal && !values.includes(currentVal)) {
            const opt = document.createElement("option");
            opt.value = currentVal;
            opt.textContent = currentVal;
            ctrlEl.appendChild(opt);
        }
        ctrlEl.value = currentVal;
        ctrlEl.addEventListener("change", () => {
            targetWidget.value = ctrlEl.value;
            if (targetWidget.callback) targetWidget.callback.call(targetNode, ctrlEl.value);
            targetNode.setDirtyCanvas(true, true);
        });
        row.appendChild(ctrlEl);

    } else if (type === "toggle" || type === "boolean") {
        ctrlEl = document.createElement("input");
        ctrlEl.type = "checkbox";
        ctrlEl.className = "kolid-app-ctrl";
        ctrlEl.checked = !!targetWidget.value;
        ctrlEl.addEventListener("change", () => {
            targetWidget.value = ctrlEl.checked;
            if (targetWidget.callback) targetWidget.callback.call(targetNode, ctrlEl.checked);
            targetNode.setDirtyCanvas(true, true);
        });
        row.appendChild(ctrlEl);

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
        // No sync needed for buttons
        return { row, sync: () => {} };

    } else if (type === "number" || type === "slider" || type === "INT" || type === "FLOAT") {
        ctrlEl = document.createElement("input");
        ctrlEl.type = "number";
        ctrlEl.className = "kolid-app-ctrl";
        ctrlEl.value = targetWidget.value;
        if (opts.min !== undefined) ctrlEl.min = opts.min;
        if (opts.max !== undefined) ctrlEl.max = opts.max;
        if (opts.step !== undefined) ctrlEl.step = opts.step;
        ctrlEl.addEventListener("change", () => {
            let v = parseFloat(ctrlEl.value);
            if (isNaN(v)) v = 0;
            if (opts.round) v = Math.round(v / opts.round) * opts.round;
            targetWidget.value = v;
            if (targetWidget.callback) targetWidget.callback.call(targetNode, v);
            targetNode.setDirtyCanvas(true, true);
        });
        row.appendChild(ctrlEl);

    } else if (opts.multiline) {
        ctrlEl = document.createElement("textarea");
        ctrlEl.className = "kolid-app-ctrl";
        ctrlEl.value = targetWidget.value || "";
        ctrlEl.rows = Math.min(8, Math.max(2, (ctrlEl.value.match(/\n/g) || []).length + 1));
        ctrlEl.addEventListener("change", () => {
            targetWidget.value = ctrlEl.value;
            if (targetWidget.callback) targetWidget.callback.call(targetNode, ctrlEl.value);
            targetNode.setDirtyCanvas(true, true);
        });
        row.appendChild(ctrlEl);

    } else {
        // default: text input
        ctrlEl = document.createElement("input");
        ctrlEl.type = "text";
        ctrlEl.className = "kolid-app-ctrl";
        ctrlEl.value = targetWidget.value !== undefined ? String(targetWidget.value) : "";
        ctrlEl.addEventListener("change", () => {
            let v = ctrlEl.value;
            // try to preserve original type
            if (typeof targetWidget.value === "number") v = parseFloat(v) || 0;
            targetWidget.value = v;
            if (targetWidget.callback) targetWidget.callback.call(targetNode, v);
            targetNode.setDirtyCanvas(true, true);
        });
        row.appendChild(ctrlEl);
    }

    // Sync function: update control from original widget (skip if user is focused)
    function sync() {
        if (!ctrlEl) return;
        if (document.activeElement === ctrlEl) return;

        if (isCombo) {
            const currentVal = String(targetWidget.value ?? "");
            // Add value to options if missing
            const existingOpts = Array.from(ctrlEl.options).map(o => o.value);
            if (currentVal && !existingOpts.includes(currentVal)) {
                const opt = document.createElement("option");
                opt.value = currentVal;
                opt.textContent = currentVal;
                ctrlEl.appendChild(opt);
            }
            // Refresh options list from source (may have changed, e.g. new images uploaded)
            const srcValues = (targetWidget.options && targetWidget.options.values) || [];
            const ctrlValues = Array.from(ctrlEl.options).map(o => o.value);
            for (const sv of srcValues) {
                if (!ctrlValues.includes(sv)) {
                    const opt = document.createElement("option");
                    opt.value = sv;
                    opt.textContent = sv;
                    // Insert before the "extra" current-value option (last)
                    ctrlEl.insertBefore(opt, ctrlEl.lastOption || null);
                }
            }
            ctrlEl.value = currentVal;
        } else if (ctrlEl.type === "checkbox") {
            ctrlEl.checked = !!targetWidget.value;
        } else {
            ctrlEl.value = targetWidget.value !== undefined ? String(targetWidget.value) : "";
        }
    }

    return { row, sync };
}

/**
 * Wrap a target widget's callback so that when the original widget changes
 * (user interacts with the original node), the wrapper control syncs immediately.
 * Supports multiple watchers. Returns a cleanup function.
 */
function hookWidgetCallback(targetWidget, targetNode, syncFn) {
    if (!targetWidget._kolidHooked) {
        targetWidget._kolidHooked = true;
        targetWidget._kolidOrigCallback = targetWidget.callback;
        targetWidget._kolidSyncFns = [];
        targetWidget.callback = function (value) {
            if (targetWidget._kolidOrigCallback) {
                targetWidget._kolidOrigCallback.call(targetNode, value);
            }
            for (const fn of targetWidget._kolidSyncFns) {
                fn();
            }
        };
    }
    targetWidget._kolidSyncFns.push(syncFn);
    return () => {
        const idx = targetWidget._kolidSyncFns.indexOf(syncFn);
        if (idx !== -1) targetWidget._kolidSyncFns.splice(idx, 1);
        if (targetWidget._kolidSyncFns.length === 0) {
            targetWidget.callback = targetWidget._kolidOrigCallback;
            delete targetWidget._kolidHooked;
            delete targetWidget._kolidOrigCallback;
            delete targetWidget._kolidSyncFns;
        }
    };
}

/**
 * Watch a target node's `mode` for changes via lightweight polling.
 * Supports multiple watchers. Returns a cleanup function.
 */
function hookNodeMode(targetNode, onModeChange) {
    if (!targetNode._kolidModeWatchers) {
        targetNode._kolidModeWatchers = [];
        targetNode._kolidLastMode = targetNode.mode;
        targetNode._kolidModeInterval = setInterval(() => {
            if (targetNode._kolidLastMode !== targetNode.mode) {
                targetNode._kolidLastMode = targetNode.mode;
                for (const w of targetNode._kolidModeWatchers) {
                    w(targetNode.mode);
                }
            }
        }, 100);
    }
    targetNode._kolidModeWatchers.push(onModeChange);
    return () => {
        const idx = targetNode._kolidModeWatchers.indexOf(onModeChange);
        if (idx !== -1) targetNode._kolidModeWatchers.splice(idx, 1);
        if (targetNode._kolidModeWatchers.length === 0) {
            clearInterval(targetNode._kolidModeInterval);
            delete targetNode._kolidModeWatchers;
            delete targetNode._kolidLastMode;
            delete targetNode._kolidModeInterval;
        }
    };
}

/**
 * Hook graph-level events (node added/removed) to trigger rebuilds
 * and highlight updates for all ApplicationNodes in the graph.
 */
function hookGraphEvents(graph, node) {
    if (!graph._kolidAppNodes) {
        graph._kolidAppNodes = new Set();
    }
    graph._kolidAppNodes.add(node);

    if (graph._kolidAppGraphHooked) return;
    graph._kolidAppGraphHooked = true;

    const origOnNodeRemoved = graph.onNodeRemoved;
    graph.onNodeRemoved = function (removedNode) {
        if (origOnNodeRemoved) origOnNodeRemoved.call(this, removedNode);
        for (const appNode of graph._kolidAppNodes) {
            if (appNode._kolidAppContainer) {
                rebuildApplicationWidget(appNode);
            }
            if (appNode._kolidAppUpdateHighlight) {
                appNode._kolidAppUpdateHighlight();
            }
        }
    };

    const origOnNodeAdded = graph.onNodeAdded;
    graph.onNodeAdded = function (addedNode) {
        if (origOnNodeAdded) origOnNodeAdded.call(this, addedNode);
        for (const appNode of graph._kolidAppNodes) {
            if (appNode._kolidAppUpdateHighlight) {
                appNode._kolidAppUpdateHighlight();
            }
            clearTimeout(appNode._kolidRebuildTimer);
            appNode._kolidRebuildTimer = setTimeout(() => {
                rebuildApplicationWidget(appNode);
            }, 100);
        }
    };
}

/**
 * Build the full DOM content inside the container.
 */
function rebuildApplicationWidget(node) {
    const container = node._kolidAppContainer;
    if (!container) return;

    // Clean up previous hooks (widget callbacks + mode patches)
    if (node._kolidCleanups) {
        for (const cleanup of node._kolidCleanups) cleanup();
    }
    node._kolidCleanups = [];

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

    // Ensure graph-level hooks are set up
    hookGraphEvents(graph, node);

    const collectValue = collectNodesWidget.getValue
        ? collectNodesWidget.getValue()
        : collectNodesWidget.value;
    const parseResult = parseCollectNodes(collectValue);
    const { entries: collectedEntries, expandedAppNodes } = collectNodes(graph, parseResult, node.id);

    // Hook nested ApplicationNodes' editor textareas so outer rebuilds when inner changes
    for (const appNode of expandedAppNodes) {
        const innerTextarea = appNode._kolidAppEditorTextarea;
        if (innerTextarea) {
            const onInnerChange = () => {
                clearTimeout(node._kolidRebuildTimer);
                node._kolidRebuildTimer = setTimeout(() => {
                    rebuildApplicationWidget(node);
                }, 300);
            };
            innerTextarea.addEventListener("input", onInnerChange);
            node._kolidCleanups.push(() => {
                innerTextarea.removeEventListener("input", onInnerChange);
            });
        }
    }

    if (collectedEntries.length === 0) {
        container.innerHTML = '<div class="kolid-app-empty">No nodes matched. Use format: id:234,regex:test,name:TT</div>';
        requestAnimationFrame(() => node.setSize(node.computeSize()));
        return;
    }

    for (const entry of collectedEntries) {
        const targetNode = entry.node;
        const widgetFilter = entry.widgetFilter;
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

        // ── Media preview (images + videos) ──
        // Extracts media URLs from multiple sources and creates self-contained
        // <img> or <video> elements.
        const mediaPreviewDiv = document.createElement("div");
        mediaPreviewDiv.className = "kolid-app-img-preview";
        mediaPreviewDiv.style.display = "none";

        function getMediaUrls() {
            const results = [];

            // Source 1: node.imgs (Preview Image, Save Image, Load Image, etc.)
            if (targetNode.imgs) {
                for (const img of targetNode.imgs) {
                    if (img instanceof HTMLImageElement && img.src) {
                        results.push({ url: img.src, type: "image" });
                    }
                }
            }

            // Source 2: VHS videopreview widget (Load Video, Video Combine, etc.)
            if (targetNode.widgets) {
                for (const w of targetNode.widgets) {
                    if (w.name === "videopreview" && w.videoEl && !w.videoEl.hidden && w.videoEl.src) {
                        results.push({ url: w.videoEl.src, type: "video" });
                    }
                    if (w.name === "videopreview" && w.imgEl && !w.imgEl.hidden && w.imgEl.src) {
                        results.push({ url: w.imgEl.src, type: "image" });
                    }
                    if (w.name === "audiopreview" && w.element && w.element.src) {
                        results.push({ url: w.element.src, type: "audio" });
                    }
                }
            }

            // Source 3: comfy-img-preview DOM widget
            if (targetNode.widgets) {
                for (const w of targetNode.widgets) {
                    if (w.element instanceof HTMLElement) {
                        for (const img of w.element.querySelectorAll("img")) {
                            if (img.src) {
                                const url = img.src;
                                if (!results.some(r => r.url === url)) {
                                    results.push({ url, type: "image" });
                                }
                            }
                        }
                        for (const vid of w.element.querySelectorAll("video")) {
                            if (vid.src) {
                                const url = vid.src;
                                if (!results.some(r => r.url === url)) {
                                    results.push({ url, type: "video" });
                                }
                            }
                        }
                    }
                }
            }

            // Source 4: VHS videopreview widget value.params -> construct /view URL
            if (results.length === 0 && targetNode.widgets) {
                const vhsWidget = targetNode.widgets.find(w => w.name === "videopreview");
                if (vhsWidget && vhsWidget.value && vhsWidget.value.params) {
                    const params = { ...vhsWidget.value.params, timestamp: Date.now() };
                    if (params.filename) {
                        const format = params.format || "video/mp4";
                        const isImage = format.startsWith("image");
                        const url = api.apiURL("/view?" + new URLSearchParams(params));
                        results.push({ url, type: isImage ? "image" : "video" });
                    }
                }
            }

            // Source 5: image widget value -> construct /view URL (Load Image)
            if (results.length === 0 && targetNode.widgets) {
                const imageWidget = targetNode.widgets.find(w => w.name === "image");
                if (imageWidget && imageWidget.value) {
                    const val = String(imageWidget.value);
                    let filename = val;
                    let subfolder = "";
                    let imgType = "input";
                    const tagMatch = val.match(/\s\[(.+)\]$/);
                    if (tagMatch) {
                        filename = val.substring(0, val.length - tagMatch[0].length);
                        subfolder = tagMatch[1];
                    }
                    const slashIdx = filename.lastIndexOf("/");
                    if (slashIdx !== -1) {
                        subfolder = filename.substring(0, slashIdx);
                        filename = filename.substring(slashIdx + 1);
                    }
                    const url = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${imgType}`);
                    results.push({ url, type: "image" });
                }
            }

            // Source 6: VHS video/audio widget value -> construct /view URL
            if (results.length === 0 && targetNode.widgets) {
                const videoWidget = targetNode.widgets.find(w => w.name === "video");
                if (videoWidget && videoWidget.value) {
                    const val = String(videoWidget.value);
                    const ext = val.slice(val.lastIndexOf(".") + 1).toLowerCase();
                    const isImage = ["gif", "webp", "avif"].includes(ext);
                    const url = api.apiURL(`/view?filename=${encodeURIComponent(val)}&type=input`);
                    results.push({ url, type: isImage ? "image" : "video" });
                }
            }

            return results;
        }

        function syncMedia() {
            const media = getMediaUrls();
            if (media.length === 0) {
                mediaPreviewDiv.style.display = "none";
                mediaPreviewDiv.innerHTML = "";
                return;
            }
            mediaPreviewDiv.style.display = "";
            // Only rebuild if media changed
            const current = Array.from(mediaPreviewDiv.children).map(el =>
                el.tagName === "VIDEO" ? `video:${el.src}` : `image:${el.src}`
            );
            const newSig = media.map(m => `${m.type}:${m.url}`).join("|");
            const oldSig = current.join("|");
            if (newSig === oldSig) return;

            mediaPreviewDiv.innerHTML = "";
            for (const m of media) {
                if (m.type === "video") {
                    const video = document.createElement("video");
                    video.src = m.url;
                    video.controls = true;
                    video.loop = true;
                    video.muted = true;
                    video.style.width = "100%";
                    video.style.height = "auto";
                    video.style.display = "block";
                    video.style.borderRadius = "3px";
                    video.style.marginBottom = "2px";
                    mediaPreviewDiv.appendChild(video);
                } else if (m.type === "audio") {
                    const audio = document.createElement("audio");
                    audio.src = m.url;
                    audio.controls = true;
                    audio.style.width = "100%";
                    audio.style.marginBottom = "2px";
                    mediaPreviewDiv.appendChild(audio);
                } else {
                    const img = document.createElement("img");
                    img.src = m.url;
                    img.style.width = "100%";
                    img.style.height = "auto";
                    img.style.display = "block";
                    img.style.borderRadius = "3px";
                    img.style.marginBottom = "2px";
                    mediaPreviewDiv.appendChild(img);
                }
            }
        }

        if (!targetNode.widgets || targetNode.widgets.length === 0) {
            body.innerHTML = '<div class="kolid-app-empty" style="padding:2px;">No widgets</div>';
        } else {
            for (const targetWidget of targetNode.widgets) {
                // Skip hidden widgets
                if (targetWidget.hidden) continue;

                // Apply widget filter if specified
                if (widgetFilter) {
                    if (!widgetFilter.has(targetWidget.name)) continue;
                    const displayLabel = widgetFilter.get(targetWidget.name);
                    const { row, sync, cleanup } = createWidgetControl(targetWidget, targetNode, displayLabel);
                    body.appendChild(row);
                    if (cleanup) node._kolidCleanups.push(cleanup);
                    node._kolidCleanups.push(hookWidgetCallback(targetWidget, targetNode, sync));
                } else {
                    const { row, sync, cleanup } = createWidgetControl(targetWidget, targetNode, null);
                    body.appendChild(row);
                    if (cleanup) node._kolidCleanups.push(cleanup);
                    node._kolidCleanups.push(hookWidgetCallback(targetWidget, targetNode, sync));
                }
            }
            if (body.children.length === 0) {
                body.innerHTML = '<div class="kolid-app-empty" style="padding:2px;">No visible widgets</div>';
            }
        }

        // Always append media preview at the end of body
        syncMedia();
        body.appendChild(mediaPreviewDiv);

        // Poll for media changes
        let lastMediaSig = getMediaUrls().map(m => `${m.type}:${m.url}`).join("|");
        const mediaInterval = setInterval(() => {
            const sig = getMediaUrls().map(m => `${m.type}:${m.url}`).join("|");
            if (sig !== lastMediaSig) {
                lastMediaSig = sig;
                syncMedia();
                requestAnimationFrame(() => node.setSize(node.computeSize()));
            }
        }, 200);
        node._kolidCleanups.push(() => clearInterval(mediaInterval));

        section.appendChild(body);

        // Collect all nodes whose mode affects this section's visibility:
        // the target node itself + any parent ApplicationNodes it was expanded from
        const modeWatchNodes = [targetNode];
        if (entry.parentAppNodeIds && entry.parentAppNodeIds.size > 0) {
            for (const parentId of entry.parentAppNodeIds) {
                const parent = graph.getNodeById(parentId);
                if (parent) modeWatchNodes.push(parent);
            }
        }

        // Check visibility: hidden if target OR any parent ApplicationNode is muted/bypassed
        function updateSectionVisibilityByMode() {
            const hidden = modeWatchNodes.some(n => n.mode === 2 || n.mode === 4);
            section.style.display = hidden ? "none" : "";
            requestAnimationFrame(() => node.setSize(node.computeSize()));
        }

        // Apply initial visibility
        updateSectionVisibilityByMode();

        // Hook mode changes on all watched nodes
        for (const watchNode of modeWatchNodes) {
            node._kolidCleanups.push(hookNodeMode(watchNode, updateSectionVisibilityByMode));
        }

        container.appendChild(section);
    }

    requestAnimationFrame(() => node.setSize(node.computeSize()));
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

            // Replace original collect_nodes widget with syntax-highlighted editor
            const collectNodesWidget = node.widgets.find(w => w.name === "collect_nodes");
            let editorRef = null;
            if (collectNodesWidget) {
                // Save the value before removing the widget
                const savedValue = collectNodesWidget.value || "";

                // Remove the original widget entirely (DOM widgets ignore hidden flag)
                const idx = node.widgets.indexOf(collectNodesWidget);
                if (idx !== -1) node.widgets.splice(idx, 1);
                // Clean up its DOM element if it has one
                if (collectNodesWidget.inputEl && collectNodesWidget.inputEl.parentElement) {
                    collectNodesWidget.inputEl.parentElement.removeChild(collectNodesWidget.inputEl);
                }
                if (collectNodesWidget.element && collectNodesWidget.element.parentElement) {
                    collectNodesWidget.element.parentElement.removeChild(collectNodesWidget.element);
                }

                // Create the syntax-highlighted editor
                const { container: editorContainer, textarea: editorTextarea, update: updateHighlight } =
                    createHighlightEditor(savedValue, node);
                editorRef = { textarea: editorTextarea, update: updateHighlight };
                node._kolidAppUpdateHighlight = updateHighlight;
                node._kolidAppEditorTextarea = editorTextarea;

                // Add as DOM widget with the SAME name "collect_nodes" so it serializes correctly
                const editorWidget = node.addDOMWidget(
                    "collect_nodes",
                    "kolid_collect_editor",
                    editorContainer,
                    {
                        getValue: () => editorTextarea.value,
                        setValue: (v) => {
                            editorTextarea.value = v;
                            updateHighlight();
                        },
                        hideOnZoom: false,
                    }
                );
                // Restore the saved value
                editorTextarea.value = savedValue;
                updateHighlight();
            }

            // Create container element for collected widgets
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

            // Hook ApplicationNode's own mode for hiding collected_widgets when muted/bypassed
            const updateAppWidgetVisibility = () => {
                const hidden = node.mode === 2 || node.mode === 4;
                if (appWidget.element) {
                    appWidget.element.style.display = hidden ? "none" : "";
                }
                requestAnimationFrame(() => node.setSize(node.computeSize()));
            };

            // Apply initial state
            updateAppWidgetVisibility();

            // Store separately so rebuildApplicationWidget doesn't clear it
            node._kolidPersistentCleanups = node._kolidPersistentCleanups || [];
            node._kolidPersistentCleanups.push(hookNodeMode(node, updateAppWidgetVisibility));

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
                if (editorRef) {
                    // Find the current widget (may have been recreated during configure)
                    const w = node.widgets.find(w => w.name === "collect_nodes");
                    const v = w ? (w.getValue ? w.getValue() : w.value) : "";
                    editorRef.textarea.value = v || "";
                    editorRef.update();
                }
                rebuildApplicationWidget(node);
            };

            // Clean up on removal: restore all hooks
            const origOnRemoved = node.onRemoved;
            node.onRemoved = function () {
                if (node._kolidCleanups) {
                    for (const cleanup of node._kolidCleanups) cleanup();
                    node._kolidCleanups = [];
                }
                if (node._kolidPersistentCleanups) {
                    for (const cleanup of node._kolidPersistentCleanups) cleanup();
                    node._kolidPersistentCleanups = [];
                }
                if (node.graph && node.graph._kolidAppNodes) {
                    node.graph._kolidAppNodes.delete(node);
                }
                clearTimeout(node._kolidRebuildTimer);
                if (origOnRemoved) origOnRemoved.apply(this, arguments);
            };

            // Initial build (graph may be null at this point; onAdded will handle it)
            rebuildApplicationWidget(node);
        };
    }
});
