import { app } from "../../scripts/app.js";

console.log("[kolid-comfy] assets_node.js loaded");

// ── CSS injection for syntax-highlighted config editors ─────────────
// Same visual design as branch_node.js editors (transparent textarea over
// a highlighted <pre>), with per-token classes:
//   ok = green (valid), warn = orange (suspicious), error = red (invalid),
//   type = blue (keyword), sep = gray (separators)
const ASSETS_STYLE_ID = "kolid-assets-node-styles";
if (!document.getElementById(ASSETS_STYLE_ID)) {
    const style = document.createElement("style");
    style.id = ASSETS_STYLE_ID;
    style.textContent = `
.kolid-assets-editor {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 48px;
}
.kolid-assets-editor-label {
    font-size: 10px;
    color: #8e8e93;
    padding: 0 1px 2px 1px;
    user-select: none;
}
.kolid-assets-editor-wrap {
    position: relative;
    width: 100%;
    flex: 1 1 auto;
    min-height: 0;
}
.kolid-assets-editor-highlight {
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
    height: 100%;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: break-word;
    overflow: hidden;
}
.kolid-assets-editor-input {
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
    overflow: auto;
    box-sizing: border-box;
}
.kolid-assets-editor-input::placeholder { color: #666; }
.kolid-assets-editor-input:focus { border-color: #777; }

.kolid-assets-seg-ok { color: #44dd44; }
.kolid-assets-seg-warn { color: #ffaa00; }
.kolid-assets-seg-error { color: #ff4444; }
.kolid-assets-seg-type { color: #6c8aff; }
.kolid-assets-seg-sep { color: #666; }
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

/**
 * Split text into {seg, sep} items on top-level commas/newlines
 * (separators inside parentheses belong to (min,max,step)).
 * The concatenation of all seg+sep reproduces the original text,
 * so the highlight layer stays aligned with the textarea.
 */
function splitTopLevel(text) {
    const items = [];
    let current = '';
    let depth = 0;
    for (const ch of text) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if ((ch === ',' || ch === '\n' || ch === '\r') && depth <= 0) {
            items.push({ seg: current, sep: ch });
            current = '';
        } else {
            current += ch;
        }
    }
    items.push({ seg: current, sep: '' });
    return items;
}

// ── Param config analysis (image/video/audio/slot inner config) ─────
// Format: name:type:default(min,max,step),...  Types: Float/Int/Boolean/String
// Mirrors backend parse_image_config() rules.
function highlightParamEntry(seg) {
    const trimmed = seg.trim();
    if (!trimmed) return escapeHTML(seg);
    const leadWs = seg.slice(0, seg.length - seg.trimStart().length);
    const trailWs = seg.slice(seg.trimEnd().length);

    // Backend regex: ^(\w+):(Float|Int|Boolean|String):(.+?)(\(([^)]*)\))?$
    const m = trimmed.match(/^(\w+):(Float|Int|Boolean|String):(.+?)(\(([^)]*)\))?$/);
    if (!m) {
        return escapeHTML(leadWs) + `<span class="kolid-assets-seg-error">${escapeHTML(trimmed)}</span>` + escapeHTML(trailWs);
    }
    const name = m[1];
    const type = m[2];
    const value = m[3];
    const hasParams = m[4] !== undefined;
    const params = m[5] || '';

    let html = escapeHTML(leadWs);
    html += escapeHTML(name) + '<span class="kolid-assets-seg-sep">:</span>';
    html += `<span class="kolid-assets-seg-type">${escapeHTML(type)}</span>`;
    html += '<span class="kolid-assets-seg-sep">:</span>';

    // Validate default value per type (backend falls back to 0/'' on parse failure)
    let valueClass = 'kolid-assets-seg-ok';
    if (type === 'Float') {
        if (!/^-?\d+(\.\d+)?$/.test(value.trim())) valueClass = 'kolid-assets-seg-error';
    } else if (type === 'Int') {
        if (!/^-?\d+$/.test(value.trim())) valueClass = 'kolid-assets-seg-error';
    } else if (type === 'Boolean') {
        if (!/^(true|false|1|0|yes|no)$/i.test(value.trim())) valueClass = 'kolid-assets-seg-error';
    }
    html += `<span class="${valueClass}">${escapeHTML(value)}</span>`;

    if (hasParams) {
        html += '<span class="kolid-assets-seg-sep">(</span>';
        if (type === 'Float' || type === 'Int') {
            // Validate (min,max,step): up to 3 numeric entries
            const entries = params.split(',').map(s => s.trim());
            const numericOk = entries.every(e => e === '' || (type === 'Float' ? /^-?\d+(\.\d+)?$/ : /^-?\d+$/).test(e));
            let paramsClass = 'kolid-assets-seg-ok';
            if (!numericOk || entries.length > 3) {
                paramsClass = 'kolid-assets-seg-error';
            } else {
                const min = entries[0] !== '' ? parseFloat(entries[0]) : null;
                const max = entries[1] !== '' ? parseFloat(entries[1]) : null;
                // min >= max is suspicious (backend accepts it but slider breaks)
                if (min !== null && max !== null && min >= max) {
                    paramsClass = 'kolid-assets-seg-warn';
                } else if (valueClass === 'kolid-assets-seg-ok' && min !== null && max !== null) {
                    const def = parseFloat(value);
                    if (def < min || def > max) paramsClass = 'kolid-assets-seg-warn';
                }
            }
            html += `<span class="${paramsClass}">${escapeHTML(params)}</span>`;
        } else {
            // Boolean/String ignore params — mark as warn
            html += `<span class="kolid-assets-seg-warn">${escapeHTML(params)}</span>`;
        }
        html += '<span class="kolid-assets-seg-sep">)</span>';
    }
    html += escapeHTML(trailWs);
    return html;
}

function parseParamConfig(text) {
    if (!text) return { html: '' };
    let html = '';
    for (const { seg, sep } of splitTopLevel(text)) {
        html += highlightParamEntry(seg) + escapeHTML(sep);
    }
    return { html };
}

// ── Slot config analysis ─────────────────────────────────────────────
// Format: Type:name(config),Type:name
// Mirrors backend: ^(Image|Video|Audio):([^:()]+?)\((.+)\)$ with a
// fallback of Type:name (capitalize-checked).
function highlightSlotEntry(seg) {
    const trimmed = seg.trim();
    if (!trimmed) return escapeHTML(seg);
    const leadWs = seg.slice(0, seg.length - seg.trimStart().length);
    const trailWs = seg.slice(seg.trimEnd().length);

    // Unbalanced parentheses → whole entry invalid
    const openCount = (trimmed.match(/\(/g) || []).length;
    const closeCount = (trimmed.match(/\)/g) || []).length;
    if (openCount !== closeCount) {
        return escapeHTML(leadWs) + `<span class="kolid-assets-seg-error">${escapeHTML(trimmed)}</span>` + escapeHTML(trailWs);
    }

    const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
    const isSlotType = (t) => ['Image', 'Video', 'Audio'].includes(cap(t));

    let html = escapeHTML(leadWs);

    // With config: Type:name(inner) — name may contain spaces ("Frame Image")
    let m = trimmed.match(/^(Image|Video|Audio):([^:()]+?)\((.*)\)$/);
    if (m) {
        html += `<span class="kolid-assets-seg-type">${escapeHTML(m[1])}</span>`;
        html += '<span class="kolid-assets-seg-sep">:</span>';
        html += `<span class="kolid-assets-seg-ok">${escapeHTML(m[2])}</span>`;
        html += '<span class="kolid-assets-seg-sep">(</span>';
        html += parseParamConfig(m[3]).html;
        html += '<span class="kolid-assets-seg-sep">)</span>';
    } else {
        // Without config: Type:name (backend fallback, case-insensitive type)
        m = trimmed.match(/^([^:()]+):(.+)$/);
        if (m && isSlotType(m[1])) {
            html += `<span class="kolid-assets-seg-type">${escapeHTML(m[1])}</span>`;
            html += '<span class="kolid-assets-seg-sep">:</span>';
            html += `<span class="kolid-assets-seg-ok">${escapeHTML(m[2])}</span>`;
        } else {
            html += `<span class="kolid-assets-seg-error">${escapeHTML(trimmed)}</span>`;
        }
    }
    html += escapeHTML(trailWs);
    return html;
}

function parseSlotConfig(text) {
    if (!text) return { html: '' };
    let html = '';
    for (const { seg, sep } of splitTopLevel(text)) {
        html += highlightSlotEntry(seg) + escapeHTML(sep);
    }
    return { html };
}

// ── Editor widget (same design as branch_node.js) ───────────────────
function createAssetsEditor(widget, node, parserFn, placeholderText) {
    const container = document.createElement("div");
    container.className = "kolid-assets-editor";

    // Widget name label (like ComfyUI's original widget title)
    const label = document.createElement("div");
    label.className = "kolid-assets-editor-label";
    label.textContent = widget.name || "";
    container.appendChild(label);

    const editorWrap = document.createElement("div");
    editorWrap.className = "kolid-assets-editor-wrap";
    container.appendChild(editorWrap);

    const highlight = document.createElement("pre");
    highlight.className = "kolid-assets-editor-highlight";
    editorWrap.appendChild(highlight);

    const textarea = document.createElement("textarea");
    textarea.className = "kolid-assets-editor-input";
    textarea.value = widget.value || "";
    textarea.placeholder = placeholderText || "";
    // Disable native spellcheck: it draws red wavy underlines under slot
    // names like "Frame Image" (config syntax, not natural language).
    textarea.spellcheck = false;
    editorWrap.appendChild(textarea);

    function update() {
        const displayText = textarea.value || textarea.placeholder || '';
        let html = textarea.value ? parserFn(textarea.value).html : escapeHTML(displayText);
        // Trailing newline: <textarea> renders an extra empty line at the end,
        // but <pre> collapses it. Add a \n to match.
        if (textarea.value && textarea.value.endsWith('\n')) {
            html += '\n';
        }
        highlight.innerHTML = html;
        // Sync scroll position from textarea to highlight
        highlight.scrollTop = textarea.scrollTop;
        highlight.scrollLeft = textarea.scrollLeft;
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

    // Sync scroll: textarea → highlight
    textarea.addEventListener("scroll", () => {
        highlight.scrollTop = textarea.scrollTop;
        highlight.scrollLeft = textarea.scrollLeft;
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

// ── Extension registration ───────────────────────────────────────────
const PARAM_PLACEHOLDER = "name:Type:default(min,max,step),...\ne.g: strength:Float:1.0(0.0,1.0,0.1)";
const SLOT_PLACEHOLDER = "Type:name(config),...\ne.g: Image:slot0(strength:Float:1.0(0.0,1.0,0.1))\nVideo:slot1";

const ASSETS_CONFIG_WIDGETS = [
    { name: 'image_config', parser: parseParamConfig, placeholder: PARAM_PLACEHOLDER },
    { name: 'video_config', parser: parseParamConfig, placeholder: PARAM_PLACEHOLDER },
    { name: 'audio_config', parser: parseParamConfig, placeholder: PARAM_PLACEHOLDER },
    { name: 'slot_config', parser: parseSlotConfig, placeholder: SLOT_PLACEHOLDER },
];

app.registerExtension({
    name: "KleinBlue.SnapshotAssetsNode",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "SnapshotAssetsNode") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);
            const node = this;
            if (node._kolidAssetsSetup) return;
            node._kolidAssetsSetup = true;

            if (!node.widgets) return;
            for (const cfg of ASSETS_CONFIG_WIDGETS) {
                const widget = node.widgets.find(w => w.name === cfg.name);
                if (!widget) continue;

                const savedValue = widget.value || "";

                // Remove the original widget entirely (DOM widgets ignore hidden flag)
                const idx = node.widgets.indexOf(widget);
                if (idx !== -1) node.widgets.splice(idx, 1);
                if (widget.inputEl && widget.inputEl.parentElement) {
                    widget.inputEl.parentElement.removeChild(widget.inputEl);
                }
                if (widget.element && widget.element.parentElement) {
                    widget.element.parentElement.removeChild(widget.element);
                }

                const editor = createAssetsEditor(widget, node, cfg.parser, cfg.placeholder);
                widget.value = savedValue;
                editor.textarea.value = savedValue;
                editor.update();
                const domWidget = node.addDOMWidget(cfg.name, "kolid_assets_editor", editor.container, {
                    getValue: () => widget.value,
                    setValue: (v) => { widget.value = v || ''; editor.textarea.value = v || ''; editor.update(); },
                    hideOnZoom: false,
                });
                domWidget.value = savedValue;
                editor.textarea.addEventListener("input", () => { domWidget.value = editor.textarea.value; });

                // addDOMWidget appends to the end of node.widgets — move the
                // DOM widget back to the original widget's position so the
                // editor shows where the original config widget was.
                const domIdx = node.widgets.indexOf(domWidget);
                if (idx !== -1 && domIdx !== -1 && domIdx !== idx) {
                    node.widgets.splice(domIdx, 1);
                    node.widgets.splice(idx, 0, domWidget);
                }
            }
        };
    },
});
