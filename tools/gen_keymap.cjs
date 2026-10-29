#!/usr/bin/env node
/**
 * 把键位表的唯一真源转成宿主能 import 的 TS 常量。
 *
 * 源：`nodes/web/js/keymap.js`（页面 `<script src>` 直接加载的那一份，也就是画布真正在用的那份）
 * 产物：`ui/sampler_node/src/keymap.generated.ts`
 *
 * 为什么这么走：命令的执行体大多在画布页面里（单文件 HTML 的经典脚本），宿主只跑其中几条。
 * 表放页面是"离消费者最近"，但宿主 Settings 的 Key Bindings 屏也要照它渲染 —— 于是构建时机械
 * 转换，谁都不手抄。转完顺手校验表本身（id 唯一、chord 可解析、scope 合法），表写坏了在这一步
 * 就报，而不是等用户点了那颗键发现没反应。
 *
 * 什么时候跑：`npm run build -w sampler_node` 的**第一步**（在 tsc 之前）—— 生成物必须比类型
 * 检查更早存在，否则"tsc 检查的那份"和"打包进去的那份"会不是同一版。
 *
 * 用法：
 *   node tools/gen_keymap.cjs            # 写产物
 *   node tools/gen_keymap.cjs --check    # 只校验产物是否落后（tests/keymap.py 用）
 *   node tools/gen_keymap.cjs --list     # 打印 id 与当前默认键，给 shell 里对账用
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'nodes/web/js/keymap.js');
const OUT = path.join(ROOT, 'ui/sampler_node/src/keymap.generated.ts');

const SCOPES = ['app', 'canvas', 'timeline', 'keyframes', 'assets'];

/** 求值那个经典脚本，拿回 KOLID_KEYMAP。它自己会挂 window.KB —— 这里只要表。 */
function readTable() {
  const src = fs.readFileSync(SRC, 'utf8');
  // 页面脚本是 IIFE + 一个 var，Node 里跑一遍是安全的：没有 DOM 依赖，localStorage 不存在时
  // 内部已降级（见文件里的 store()）。new Function 的 var 作用域正好把表交出来。
  let table;
  try {
    table = new Function(`${src}\n;return KOLID_KEYMAP;`)();
  } catch (e) {
    throw new Error(`${SRC} 求值失败：${e.message}`);
  }
  if (!Array.isArray(table)) throw new Error(`${SRC} 没有 KOLID_KEYMAP 数组`);
  return table;
}

/** 表自身的一致性：id 唯一、scope 认得、chord 解析得开。写坏了在这里报，别等到用户按键。 */
function validate(table) {
  const errs = [];
  const seen = new Set();
  const parse = new Function(`${fs.readFileSync(SRC, 'utf8')}\n;return KB.parse;`)();
  for (const d of table) {
    if (!d || typeof d.id !== 'string' || !/^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/.test(d.id))
      errs.push(`id 不合法：${JSON.stringify(d && d.id)}（要 group.command 形状）`);
    else if (seen.has(d.id)) errs.push(`id 重复：${d.id}`);
    else seen.add(d.id);
    if (!d || typeof d.group !== 'string' || !d.group) errs.push(`${d && d.id}: group 空`);
    if (!d || typeof d.label !== 'string' || !d.label) errs.push(`${d && d.id}: label 空`);
    if (!d || !SCOPES.includes(d.scope)) errs.push(`${d && d.id}: scope 非法 ${JSON.stringify(d && d.scope)}`);
    if (!d || !Array.isArray(d.keys)) { errs.push(`${d && d.id}: keys 必须是数组（不绑就写 []）`); continue; }
    d.keys.forEach(k => { if (!parse(k)) errs.push(`${d.id}: chord 解析不了 ${JSON.stringify(k)}`); });
  }
  return errs;
}

function q(s) { return JSON.stringify(s); }
function opt(k, v) { return v === undefined ? '' : `, ${k}: ${JSON.stringify(v)}`; }

function render(table) {
  const body = table.map(d =>
    `  { id: ${q(d.id)}, group: ${q(d.group)}, label: ${q(d.label)}, scope: ${q(d.scope)}, `
    + `keys: [${(d.keys || []).map(q).join(', ')}]`
    + (d.shiftAsParam ? ', shiftAsParam: true' : '')
    + opt('note', d.note) + ' },').join('\n');

  return `// 由 tools/gen_keymap.cjs 从 nodes/web/js/keymap.js 生成 —— **不要手改**。
//
// 那颗文件是键位表的唯一真源：画布页面 \`<script src="js/keymap.js">\` 直接加载它，宿主在这里
// 拿一份打好类型的副本。改了键位表就重新构建（\`npm run build -w sampler_node\` 第一步就是重跑
// 生成器），\`tests/keymap.py\` 会检查这份是否落后。

/** 命令在哪儿有效。冲突检测按它分组：同一 scope 里两条命令占同一个键才叫真冲突。 */
export type KeyScope = 'app' | 'canvas' | 'timeline' | 'keyframes' | 'assets';

export type KeyDef = {
  /** \`group.command\`，页面与宿主都用它认命令（\`KB.hit(e, id)\` / \`hit(e, id)\`）。 */
  id: string;
  /** Key Bindings 屏里的分组标题。 */
  group: string;
  /** 那一行显示的名字。 */
  label: string;
  scope: KeyScope;
  /** 默认键。空数组 = 默认不绑，等用户自己绑。 */
  keys: readonly string[];
  /** Shift 是这条命令的**参数**而非绑定的一部分（方向键微调：Shift 走大步）。 */
  shiftAsParam?: boolean;
  /** 给屏幕下方那行小字用的说明（可无）。 */
  note?: string;
};

export const KEYMAP = [
${body}
] as const satisfies readonly KeyDef[];

/** 全部合法命令 id（拼错的 id 在 \`KB.hit\` / \`hit\` 里一律 false，这里给出集合好让 UI 与测试对账）。 */
export type KeyCommandId = (typeof KEYMAP)[number]['id'];

export const KEY_COMMAND_IDS: readonly string[] = KEYMAP.map(d => d.id);
export const KEY_SCOPES: readonly KeyScope[] = ${JSON.stringify(SCOPES)};
`;
}

function main() {
  const argv = process.argv.slice(2);
  const table = readTable();
  const errs = validate(table);
  if (errs.length) {
    console.error('键位表有问题：');
    errs.forEach(e => console.error('  - ' + e));
    process.exit(1);
  }
  const out = render(table);

  if (argv.includes('--list')) {
    // 给 tests/keymap.py：整张表原样吐出来（它要按 group 分组、按 scope 查冲突）。
    console.log(JSON.stringify(table.map(d => ({
      id: d.id, group: d.group, label: d.label, scope: d.scope,
      keys: d.keys, shiftAsParam: !!d.shiftAsParam,
    }))));
    return;
  }

  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (argv.includes('--check')) {
    if (prev === out) { console.log(`keymap: ${table.length} commands, generated file is current`); return; }
    console.error(`keymap: ${path.relative(ROOT, OUT)} 落后于 ${path.relative(ROOT, SRC)}`
      + ` — 跑 node tools/gen_keymap.cjs（或 npm run build -w sampler_node）`);
    process.exit(1);
  }

  if (prev === out) { console.log(`keymap: ${table.length} commands, unchanged`); return; }
  // 先写临时文件再 rename：宿主 / 页面永远读不到半份表（构建正跑到一半时也一样）。
  const tmp = OUT + '.tmp';
  fs.writeFileSync(tmp, out, 'utf8');
  fs.renameSync(tmp, OUT);
  console.log(`keymap: ${table.length} commands written → ${path.relative(ROOT, OUT)}`);
}

main();
