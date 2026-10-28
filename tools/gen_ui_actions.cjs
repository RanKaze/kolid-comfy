#!/usr/bin/env node
// 从 `ui/sampler_node/src/types.ts` 的 **BlendUiAction / BlendUiPayloads** 生成动作目录。
//
// 为什么要生成：这两份类型就是"用户在工作台里能按到什么"的唯一清单（页面每一个按钮、每一根滑杆、
// 每一个菜单项都落到一个动作键上，而且载荷表在编译期已经被 `BlendUiPayloadGap` 钉成 1:1）。只要
// 目录是**从它长出来的**，agent 的工具面就永远与界面同步 —— 手抄一份 130 条的清单必然漏，而且漏了
// 没人发现。
//
// 产物（两份，同源）：
//   · `ui/sampler_node/src/agent/uiActions.generated.ts` —— 页面/宿主运行时用（`ui_action` 校验 +
//     `get_ui_actions` 交目录）；随 UI 一起打包。
//   · `nodes/workbench/ui_actions.json` —— Python 侧与覆盖率报告读的同一份。
//
// 用法：
//   node tools/gen_ui_actions.cjs            # 生成/更新
//   node tools/gen_ui_actions.cjs --check    # 只校验，落后就退 1（闸）
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TS = path.join(ROOT, 'ui/sampler_node/src/types.ts');
const OUT_TS = path.join(ROOT, 'ui/sampler_node/src/agent/uiActions.generated.ts');
const OUT_JSON = path.join(ROOT, 'nodes/workbench/ui_actions.json');

const src = fs.readFileSync(TS, 'utf8');

// ── 解析 ────────────────────────────────────────────────────────────────────
/** 取 `export type <name> =` 之后到顶层 `;` 的原文。 */
function blockOf(name) {
    const at = src.indexOf('export type ' + name + ' =');
    if (at < 0) throw new Error('找不到类型: ' + name);
    let i = src.indexOf('=', at) + 1;
    const start = i;
    let depth = 0, str = null;
    for (; i < src.length; i++) {
        const c = src[i];
        if (str) {
            if (c === '\\') { i++; continue; }
            if (c === str) str = null;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') { str = c; continue; }
        if (c === '{' || c === '[' || c === '(') depth++;
        else if (c === '}' || c === ']' || c === ')') depth--;
        else if (c === ';' && depth === 0) break;
    }
    return { text: src.slice(start, i), at: start };
}

/** 注释文本压成一行（块注释去掉星号与换行，行注释去掉斜杠）。 */
function flatComment(raw) {
    return raw
        .replace(/^\/\*\*?/, '').replace(/\*\/$/, '')
        .split('\n').map(l => l.replace(/^\s*\*?\s?/, '').trim())
        .filter(Boolean).join(' ')
        .replace(/\s+/g, ' ').trim();
}

const actionBlock = blockOf('BlendUiAction');
const ACTIONS = [...actionBlock.text.matchAll(/'([a-z0-9][a-z0-9-]*)'/g)].map(m => m[1]);
if (!ACTIONS.length) throw new Error('BlendUiAction 里没解析出动作键');
if (new Set(ACTIONS).size !== ACTIONS.length) {
    const seen = new Set(), dup = [];
    for (const a of ACTIONS) { if (seen.has(a)) dup.push(a); seen.add(a); }
    throw new Error('BlendUiAction 里有重复键: ' + dup.join(', '));
}

// 载荷表：逐条 `'key': <类型>;`，类型可以跨行、可以带 `{...}`/`[]`。顺带收下紧邻其上的注释。
const payBlock = blockOf('BlendUiPayloads');
const PAY = new Map();
{
    const text = payBlock.text;             // 以 `{` 开头
    let i = 1;                              // 跳开 `{`
    let pending = [];
    while (i < text.length) {
        const c = text[i];
        // 注释
        if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            pending.push(flatComment(text.slice(i, end + 2)));
            i = end + 2;
            continue;
        }
        if (c === '/' && text[i + 1] === '/') {
            const end = text.indexOf('\n', i + 2);
            const stop = end < 0 ? text.length : end;
            pending.push(flatComment(text.slice(i, stop)));
            i = stop;
            continue;
        }
        if (c === "'") {
            const close = text.indexOf("'", i + 1);
            const key = text.slice(i + 1, close);
            const colon = text.indexOf(':', close);
            // 类型：从 `:` 之后扫到深度 0 的 `;`
            let j = colon + 1, depth = 0, str = null;
            for (; j < text.length; j++) {
                const ch = text[j];
                if (str) { if (ch === '\\') { j++; continue; } if (ch === str) str = null; continue; }
                if (ch === "'" || ch === '"' || ch === '`') { str = ch; continue; }
                if (ch === '{' || ch === '[' || ch === '(') depth++;
                else if (ch === '}' || ch === ']' || ch === ')') { if (depth === 0) break; depth--; }
                else if (ch === ';' && depth === 0) break;
            }
            const type = text.slice(colon + 1, j).replace(/\s+/g, ' ').trim();
            PAY.set(key, { type, doc: pending.join(' ').trim() });
            pending = [];
            i = j + 1;
            continue;
        }
        if (c === ',') { i++; continue; }
        if (c === '}' && i > 1) break;       // 收尾
        i++;
    }
}

const missingPayload = ACTIONS.filter(a => !PAY.has(a));
const orphanPayload = [...PAY.keys()].filter(k => !ACTIONS.includes(k));
if (missingPayload.length) throw new Error('这些动作键在 BlendUiPayloads 里没有载荷: ' + missingPayload.join(', '));
if (orphanPayload.length) throw new Error('BlendUiPayloads 里有不在 BlendUiAction 的键: ' + orphanPayload.join(', '));

/** 载荷归成四类，好让 agent 一眼看出这一条要不要带值、带什么。 */
function payloadKind(t) {
    if (!t || t === 'undefined' || t === 'void') return 'none';
    if (t === 'string' || t === 'number' || t === 'boolean') return t;
    if (/\[\]$/.test(t)) return 'array';
    if (t.startsWith('{')) return 'object';
    return 'other';
}

const rows = ACTIONS.map(a => {
    const p = PAY.get(a);
    return { action: a, payload: p.type || 'undefined', kind: payloadKind(p.type), doc: p.doc || '' };
});

// ── 产物 ────────────────────────────────────────────────────────────────────
const q = s => JSON.stringify(s);
const tsBody = rows.map(r => `  { action: ${q(r.action)}, payload: ${q(r.payload)}, kind: ${q(r.kind)}, doc: ${q(r.doc)} },`).join('\n');
const tsFinal = `// 由 tools/gen_ui_actions.cjs 从 ui/sampler_node/src/types.ts 生成 —— **不要手改**。
// 改了界面上的动作键就重跑生成器；\`tests/agent_coverage.py\` 会检查这份是否落后。
//
// 这就是"用户在工作台里能做什么"的机器可读清单：每个按钮 / 滑杆 / 菜单项都落到一个动作键上，
// agent 的 \`ui_action\` 工具按这张表执行、\`get_ui_actions\` 按这张表交目录。
export type UiActionInfo = {
  /** 动作键（与页面 postMessage 的 \`action\` 一致）。 */
  action: string;
  /** 载荷的 TS 类型原文：\`undefined\` = 不带值。 */
  payload: string;
  /** none | string | number | boolean | array | object | other */
  kind: string;
  /** types.ts 里那一段说明（给人和模型看的语义）。 */
  doc: string;
};

export const UI_ACTIONS: UiActionInfo[] = [
${tsBody}
];

/** 动作键集合：\`ui_action\` 用它挡住拼错的键 —— 页面收到不认识的键是**静默不动**的，
 *  不挡就等于让 agent 以为按了、其实什么也没发生。 */
export const UI_ACTION_IDS: ReadonlySet<string> = new Set(UI_ACTIONS.map(a => a.action));
`;

const jsonOut = JSON.stringify({
    version: 1,
    source: 'ui/sampler_node/src/types.ts',
    generated_by: 'tools/gen_ui_actions.cjs',
    count: rows.length,
    actions: rows,
}, null, 2) + '\n';

const check = process.argv.includes('--check');
const stale = [];
for (const [file, body] of [[OUT_TS, tsFinal], [OUT_JSON, jsonOut]]) {
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (old !== body) stale.push(file);
}
if (check) {
    if (stale.length) {
        console.error('动作目录已落后（改了 types.ts 的动作键？重跑 node tools/gen_ui_actions.cjs）：');
        for (const f of stale) console.error('  ' + path.relative(ROOT, f));
        process.exit(1);
    }
    console.log('动作目录是最新的：' + rows.length + ' 个动作键');
    process.exit(0);
}
for (const [file, body] of [[OUT_TS, tsFinal], [OUT_JSON, jsonOut]]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
}
console.log('生成 ' + rows.length + ' 个动作键：');
console.log('  ' + path.relative(ROOT, OUT_TS));
console.log('  ' + path.relative(ROOT, OUT_JSON));
const kinds = rows.reduce((m, r) => (m[r.kind] = (m[r.kind] | 0) + 1, m), {});
console.log('载荷分布: ' + JSON.stringify(kinds));
