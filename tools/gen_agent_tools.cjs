#!/usr/bin/env node
/**
 * 把工具面的唯一真源转成后端能直接吃的一份 JSON。
 *
 * 源：`ui/sampler_node/src/agent/toolSchemas.ts`（前端，schema + 名字）
 * 产物：`nodes/workbench/agent_tools.json`（OpenAI `tools` 格式，后端按 mtime 热读）
 *
 * 什么时候跑：`npm run build -w sampler_node` 的 `closeBundle` 里自动跑 —— 前端改动的唯一
 * 生效路径就是构建，所以这份 JSON 不可能落后于源码，也就不存在"改了 schema 忘了同步后端"。
 * 手改产物 = 下次构建被覆盖，所以别改它。
 *
 * 用法：
 *   node tools/gen_agent_tools.cjs            # 写产物
 *   node tools/gen_agent_tools.cjs --check    # 只校验产物是否落后（tests/agent_coverage.py 用）
 *   node tools/gen_agent_tools.cjs --list     # 打印工具名，给 shell 里对账用
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { createRequire } = require('module');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'ui/sampler_node/src/agent/toolSchemas.ts');
const OUT = path.join(ROOT, 'nodes/workbench/agent_tools.json');

/** esbuild 住在 ui 的 node_modules（workspace 根），从那里 resolve 才不会受 cwd 影响。 */
function loadEsbuild() {
  const fromUi = createRequire(path.join(ROOT, 'ui/package.json'));
  return fromUi('esbuild');
}

/** 把 TS 打成一段 ESM（bundle 模式，将来 schema 里 import 共享类型也不会坏），import 出 TOOLS。 */
async function readTools() {
  const esbuild = loadEsbuild();
  const built = await esbuild.build({
    entryPoints: [SRC],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    write: false,
    logLevel: 'silent',
  });
  const tmp = path.join(os.tmpdir(), `kolid-agent-tools-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(tmp, built.outputFiles[0].text, 'utf8');
  try {
    const mod = await import(pathToFileURL(tmp).href);
    if (!Array.isArray(mod.TOOLS)) throw new Error(`${SRC} 没有导出 TOOLS 数组`);
    return mod.TOOLS;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件删不掉不影响结果 */ }
  }
}

/** TS 的自定义形状 → OpenAI tools 里的 `{type:'function', function:{...}}`。 */
function toOpenAi(tools) {
  const seen = new Set();
  return tools.map((t) => {
    const name = String(t && t.name || '');
    if (!name) throw new Error(`toolSchemas.ts 里有一条没有 name 的工具：${JSON.stringify(t).slice(0, 120)}`);
    if (seen.has(name)) throw new Error(`toolSchemas.ts 里工具名重复：${name}（重名会让 MCP 少一个工具，却不报错）`);
    seen.add(name);
    const params = t.parameters || {};
    return {
      type: 'function',
      function: {
        name,
        description: String(t.description || ''),
        parameters: {
          type: 'object',
          properties: params.properties || {},
          required: Array.from(params.required || []),
        },
      },
    };
  });
}

/** 内容指纹：只覆盖真正会变的部分，不含时间戳（否则每次构建都不同，"落后"就无从判断）。 */
function fingerprint(tools) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 16);
}

function buildDoc(tools) {
  return {
    generated_by: 'tools/gen_agent_tools.cjs ← ui/sampler_node/src/agent/toolSchemas.ts',
    note: '构建产物，别手改；执行体在 ui/sampler_node/src/agent/tools.ts，后端只转发到页面。',
    tool_count: tools.length,
    sha: fingerprint(tools),
    tools,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const list = argv.includes('--list');

  const tools = toOpenAi(await readTools());

  if (list) {
    for (const t of tools) process.stdout.write(t.function.name + '\n');
    return 0;
  }

  const doc = buildDoc(tools);
  const next = JSON.stringify(doc, null, 2) + '\n';
  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';

  if (check) {
    if (prev === next) {
      process.stdout.write(`ok: ${tools.length} tools, sha ${doc.sha}\n`);
      return 0;
    }
    // 落后就点出差在哪一类，别只说"不一致"。
    let old = null;
    try { old = JSON.parse(prev); } catch { /* 文件坏了也照样报 */ }
    const oldNames = new Set((old && old.tools || []).map(t => t.function && t.function.name));
    const newNames = new Set(tools.map(t => t.function.name));
    const added = [...newNames].filter(n => !oldNames.has(n));
    const removed = [...oldNames].filter(n => !newNames.has(n));
    process.stderr.write(
      `STALE: ${OUT}\n`
      + `  源码 ${tools.length} 个工具（sha ${doc.sha}），产物 ${oldNames.size} 个`
      + `${old && old.sha ? `（sha ${old.sha}）` : '（没有 sha）'}\n`
      + (added.length ? `  新增未同步: ${added.join(', ')}\n` : '')
      + (removed.length ? `  产物里多余: ${removed.join(', ')}\n` : '')
      + (added.length || removed.length ? '' : '  名字相同但说明/参数表不同 —— 改过 description 或 properties。\n')
      + '  修法：cd ui && npm run build -w sampler_node（构建会自动重写这份 JSON）\n');
    return 1;
  }

  if (prev === next) {
    process.stdout.write(`agent tools: ${tools.length} unchanged (sha ${doc.sha})\n`);
    return 0;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const tmp = OUT + '.tmp';
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, OUT);
  process.stdout.write(`agent tools: ${tools.length} written (sha ${doc.sha})\n`);
  return 0;
}

main().then((code) => { process.exitCode = code; }, (err) => {
  process.stderr.write(`gen_agent_tools failed: ${err && err.stack || err}\n`);
  process.exitCode = 1;
});
