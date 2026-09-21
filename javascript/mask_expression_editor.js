import { app } from "../../scripts/app.js";

/**
 * ImageDetectNode(prompt) / VideoSegmentationNode(text_prompt) 的掩码表达式
 * 语法高亮编辑器。设计参考 application_node.js 的 DOM widget 编辑器：
 *   <pre> 高亮层 + 透明 <textarea> 叠加，同名 addDOMWidget 保证序列化。
 *
 * 表达式语法（与后端 libs/mask_expression.py 一致）：
 *   术语: name / name:0.3 / name(0.3) / (name:0.3)
 *   运算符: & 交集  + | 并集  - 差集
 *   函数: max(...) / min(...) / grow(表达式, 像素数)，参数逗号分隔，可嵌套
 *         grow 像素数为负 = 向内腐蚀（缩小），如 grow(body:0.2, -8)
 */

// ── CSS 注入（一次） ─────────────────────────────────────────────
const STYLE_ID = "kolid-mask-expression-styles";
if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.kolid-expr-editor { position: relative; width: 100%; }
.kolid-expr-wrap { position: relative; width: 100%; }
.kolid-expr-highlight {
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
    line-height: 1.5;
    pointer-events: none;
    width: 100%;
    min-height: 24px;
}
.kolid-expr-input {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    margin: 0;
    padding: 4px;
    border: 1px solid #444;
    border-radius: 3px;
    background: transparent;
    color: transparent;
    caret-color: #fff;
    font-family: monospace;
    font-size: 10px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: break-word;
    resize: none;
    outline: none;
    overflow: hidden;
    box-sizing: border-box;
}
.kolid-expr-input::placeholder { color: #666; }
.kolid-expr-input:focus { border-color: #777; }

.kolid-expr-term { color: #4fc1ff; }        /* 术语名 */
.kolid-expr-op { color: #ff9427; }          /* 运算符 & + - | */
.kolid-expr-paren { color: #888; }          /* 括号 */
.kolid-expr-colon { color: #888; }          /* 冒号 */
.kolid-expr-sep { color: #666; }            /* 函数参数逗号 */
.kolid-expr-func { color: #c58fff; font-weight: bold; }  /* max / min / grow */
.kolid-expr-num { color: #44dd44; }         /* 阈值数字 */
.kolid-expr-error { color: #ff4444; text-decoration: wavy underline; }
.kolid-expr-warn { color: #ffaa00; text-decoration: wavy underline; }

.kolid-expr-status {
    font-family: monospace;
    font-size: 10px;
    padding: 1px 2px 0 2px;
    color: #666;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.kolid-expr-status.ok { color: #44aa44; }
.kolid-expr-status.error { color: #ff6666; }
.kolid-expr-status.warn { color: #ffaa00; }
`;
    document.head.appendChild(style);
}

// ── 词法/语法（与 libs/mask_expression.py 对齐） ─────────────────

const EXPR_SPECIAL = "()&+|-:,";

function escapeHTML(str) {
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;');
}

/** 切分为 [{kind:'special'|'atom', value}]，与后端 _tokenize 一致。 */
function tokenizeExpr(text) {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (EXPR_SPECIAL.includes(c)) {
            tokens.push({ kind: "special", value: c });
            i += 1;
        } else {
            let j = i;
            while (j < text.length && !EXPR_SPECIAL.includes(text[j])) j += 1;
            const raw = text.slice(i, j);
            if (raw.trim()) tokens.push({ kind: "atom", value: raw });
            i = j;
        }
    }
    return tokens;
}

function parseThresholdValue(s) {
    const t = s.trim();
    const v = Number(t);
    if (!isFinite(v) || v < 0 || v > 1) return null;
    return v;
}

/** 疑似漏写 ':' 的术语名，如 "head0.2"（数字结尾且落在 [0,1]） */
function suspectMissingColon(name) {
    const m = /^(.+?)(\d+(?:\.\d+)?)$/.exec(name.trim());
    if (!m || !m[1].trim()) return null;
    const v = Number(m[2]);
    return isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

/**
 * 校验整个表达式，返回 {ok, error, warning}。
 * 错误消息与后端中文报错对齐。
 */
function validateExpression(text) {
    if (!text || !text.trim()) return { ok: false, error: "表达式为空", warning: null };
    const tokens = tokenizeExpr(text);
    let pos = 0;
    const peek = (k) => tokens[pos + (k || 0)] || null;
    const next = () => tokens[pos++];
    let warning = null;

    function parsePrimary() {
        const t = peek();
        if (!t) return "表达式意外结束（运算符后缺少术语）";
        if (t.kind === "special") {
            if (t.value === "(") {
                next();
                const err = parseExpr();
                if (err) return err;
                const c = peek();
                if (!c || c.value !== ")") return "缺少 ')'";
                next();
                return null;
            }
            return `意外的 '${t.value}'，此处应为术语名或 '('`;
        }
        next();
        const name = t.value.trim();
        if (!name) return "术语名为空";

        const n2 = peek();
        // 函数 max(...) / min(...) / grow(...)
        if ((name === "max" || name === "min") && n2 && n2.kind === "special" && n2.value === "(") {
            return parseFuncArgs();
        }
        if (name === "grow" && n2 && n2.kind === "special" && n2.value === "(") {
            return parseGrowArgs();
        }
        // name:0.3
        if (n2 && n2.kind === "special" && n2.value === ":") {
            next();
            const num = peek();
            if (!num || num.kind !== "atom") return `术语 '${name}' 的 ':' 后缺少阈值数值`;
            next();
            if (parseThresholdValue(num.value) === null) {
                return `阈值 '${num.value.trim()}' 无效，应在 [0, 1] 内`;
            }
            return null;
        }
        // name(0.3)
        if (n2 && n2.kind === "special" && n2.value === "(") {
            const n3 = peek(1), n4 = peek(2);
            if (n3 && n3.kind === "atom" && n4 && n4.kind === "special" && n4.value === ")") {
                if (parseThresholdValue(n3.value) === null) {
                    return `阈值 '${n3.value.trim()}' 无效，应在 [0, 1] 内`;
                }
                next(); next(); next();
                return null;
            }
            return `术语 '${name}' 后的 '(' 用法无效（应为 name(0.3) 或函数）`;
        }
        // 裸术语：疑似漏写 ':'（head0.2 → head:0.2）
        if (suspectMissingColon(name) !== null) {
            warning = `术语 '${name}' 末尾像阈值，是否漏了 ':' ？`;
        }
        return null;
    }

    function parseFuncArgs() {
        next(); // '('
        const err = parseExpr();
        if (err) return err;
        while (true) {
            const t = peek();
            if (!t) return "函数缺少 ')'";
            if (t.kind === "special" && t.value === ",") {
                next();
                const e = parseExpr();
                if (e) return e;
                continue;
            }
            if (t.kind === "special" && t.value === ")") {
                next();
                return null;
            }
            return "函数参数列表格式错误（应为 ',' 或 ')'）";
        }
    }

    function parseGrowArgs() {
        next(); // '('
        const err = parseExpr();
        if (err) return err;
        const t = peek();
        if (!t || t.kind !== "special" || t.value !== ",") {
            return "函数 'grow' 需要两个参数: grow(表达式, 像素数)。";
        }
        next();
        // 负数会被 tokenizer 拆成 '-' + 数字，先吃掉可选负号
        let sign = "";
        const sgn = peek();
        if (sgn && sgn.kind === "special" && sgn.value === "-") {
            next();
            sign = "-";
        }
        const num = peek();
        if (!num || num.kind !== "atom" || !/^\d+(?:\.\d+)?$/.test(num.value.trim())) {
            return "函数 'grow' 的第二个参数应为像素数（数字）。";
        }
        next();
        const v = Number(sign + num.value.trim());
        if (!(v >= -500 && v <= 500)) {
            return `函数 'grow' 的像素数应在 [-500, 500] 内，当前为 ${sign}${num.value.trim()}。`;
        }
        const c = peek();
        if (!c || c.kind !== "special" || c.value !== ")") {
            return "函数 'grow' 的参数列表格式错误（应为 ',' 或 ')'）。";
        }
        next();
        return null;
    }

    function parseExpr() {
        let err = parsePrimary();
        if (err) return err;
        while (true) {
            const t = peek();
            if (t && t.kind === "special" && "&+|-".includes(t.value)) {
                next();
                err = parsePrimary();
                if (err) return err;
            } else {
                return null;
            }
        }
    }

    const err = parseExpr();
    if (err) return { ok: false, error: err, warning: null };
    if (pos < tokens.length) {
        return { ok: false, error: `在 '${tokens[pos].value}' 处存在多余内容`, warning: null };
    }
    return { ok: true, error: null, warning };
}

/** 逐 token 着色为 HTML。 */
function buildExprHighlightedHTML(text) {
    if (!text) return "";
    const tokens = tokenizeExpr(text);
    let html = "";
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const prev = tokens[i - 1] || null;
        const nxt = tokens[i + 1] || null;
        let cls = null;

        if (t.kind === "special") {
            const afterComma = prev && prev.kind === "special" && prev.value === ",";
            if ("&+|-".includes(t.value)) {
                // grow 的负数像素参数：'-' 与随后的数字一起按数字着色
                cls = (t.value === "-" && afterComma) ? "kolid-expr-num" : "kolid-expr-op";
            }
            else if (t.value === ",") cls = "kolid-expr-sep";
            else if (t.value === ":") cls = "kolid-expr-colon";
            else cls = "kolid-expr-paren";
        } else {
            const name = t.value.trim();
            const p2 = tokens[i - 2] || null;
            const afterComma = prev && prev.kind === "special" && prev.value === ",";
            const afterMinusInArgs = prev && prev.kind === "special" && prev.value === "-"
                && p2 && p2.kind === "special" && p2.value === ",";
            if ((name === "max" || name === "min" || name === "grow") && nxt && nxt.kind === "special" && nxt.value === "(") {
                cls = "kolid-expr-func";
            } else if (prev && prev.kind === "special" && prev.value === ":") {
                cls = parseThresholdValue(t.value) === null ? "kolid-expr-error" : "kolid-expr-num";
            } else if ((afterComma || afterMinusInArgs) && /^\d+(?:\.\d+)?$/.test(name)) {
                cls = "kolid-expr-num";  // grow 的像素参数（可带负号）
            } else {
                const n2 = tokens[i + 2] || null;
                const isSuffixNum = prev && prev.kind === "special" && prev.value === "("
                    && p2 && p2.kind === "atom"
                    && n2 && n2.kind === "special" && n2.value === ")";
                if (isSuffixNum) {
                    cls = parseThresholdValue(t.value) === null ? "kolid-expr-error" : "kolid-expr-num";
                } else {
                    cls = suspectMissingColon(name) !== null ? "kolid-expr-warn" : "kolid-expr-term";
                }
            }
        }
        html += `<span class="${cls}">${escapeHTML(t.value)}</span>`;
    }
    if (text.endsWith("\n")) html += " ";
    return html;
}

// ── 编辑器（pre 高亮层 + 透明 textarea 叠加 + 状态行） ──────────

function createExpressionEditor(initialValue, placeholder) {
    const container = document.createElement("div");
    container.className = "kolid-expr-editor";

    const editorWrap = document.createElement("div");
    editorWrap.className = "kolid-expr-wrap";
    container.appendChild(editorWrap);

    const highlight = document.createElement("pre");
    highlight.className = "kolid-expr-highlight";
    editorWrap.appendChild(highlight);

    const textarea = document.createElement("textarea");
    textarea.className = "kolid-expr-input";
    textarea.value = initialValue || "";
    textarea.placeholder = placeholder || "(body:0.2-face:0.2)&(human:0.1)";
    textarea.rows = 1;
    editorWrap.appendChild(textarea);

    const status = document.createElement("div");
    status.className = "kolid-expr-status";
    container.appendChild(status);

    function updateHighlight() {
        highlight.innerHTML = buildExprHighlightedHTML(textarea.value);
        const empty = !textarea.value.trim();
        if (empty) {
            status.className = "kolid-expr-status";
            status.textContent = "例: (body:0.2-face:0.2)&(human:0.1) | max(a:0.2,b:0.3) | grow(a:0.2,5) | grow(a:0.2,-5)";
        } else {
            const v = validateExpression(textarea.value);
            if (!v.ok) {
                status.className = "kolid-expr-status error";
                status.textContent = "✗ " + v.error;
            } else if (v.warning) {
                status.className = "kolid-expr-status warn";
                status.textContent = "⚠ " + v.warning;
            } else {
                status.className = "kolid-expr-status ok";
                status.textContent = "✓ 表达式有效";
            }
        }
    }

    textarea.addEventListener("input", updateHighlight);
    updateHighlight();

    return { container, textarea, update: updateHighlight };
}

// ── 注册到节点 ─────────────────────────────────────────────────

// 节点名 → 表达式 widget 名
const EXPR_WIDGETS = {
    ImageDetectNode: "prompt",
    VideoSegmentationNode: "text_prompt",
};

app.registerExtension({
    name: "KleinBlue.MaskExpressionEditor",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        const widgetName = EXPR_WIDGETS[nodeData.name];
        if (!widgetName) return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);
            const node = this;
            if (node._kolidExprSetup) return;
            node._kolidExprSetup = true;

            const origWidget = node.widgets.find(w => w.name === widgetName);
            if (!origWidget) return;
            const savedValue = origWidget.value || "";

            // 删除原 widget（DOM widget 会忽略 hidden 标志，必须彻底移除）
            const idx = node.widgets.indexOf(origWidget);
            if (idx !== -1) node.widgets.splice(idx, 1);
            if (origWidget.inputEl && origWidget.inputEl.parentElement) {
                origWidget.inputEl.parentElement.removeChild(origWidget.inputEl);
            }
            if (origWidget.element && origWidget.element.parentElement) {
                origWidget.element.parentElement.removeChild(origWidget.element);
            }

            const { container, textarea, update } =
                createExpressionEditor(savedValue, origWidget.placeholder);

            // 同名 addDOMWidget 保证工作流序列化/反序列化正确
            node.addDOMWidget(widgetName, "kolid_mask_expression", container, {
                getValue: () => textarea.value,
                setValue: (v) => {
                    textarea.value = v;
                    update();
                },
                hideOnZoom: false,
            });
            textarea.value = savedValue;
            update();

            // 工作流加载时恢复编辑器内容（widget 可能被重建）
            const origOnConfigure = node.onConfigure;
            node.onConfigure = function () {
                origOnConfigure?.apply(this, arguments);
                const w = node.widgets.find(w => w.name === widgetName);
                const v = w ? (w.getValue ? w.getValue() : w.value) : "";
                if (textarea.value !== (v || "")) {
                    textarea.value = v || "";
                    update();
                }
            };
        };
    },
});
