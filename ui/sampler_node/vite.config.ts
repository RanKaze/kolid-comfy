import { createViteConfig } from '../packages/ui-utils/src/vite-config';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { resolve } from 'path';
import { copyFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';

const uiUtilsSrc = resolve(__dirname, '../packages/ui-utils/src');
const outDir = resolve(__dirname, '../../nodes/web');
const repoRoot = resolve(__dirname, '../..');

// 构建戳 —— 界面探针靠它回答"页面上的 build 与仓库里的源码是不是同一版"。
// 没有它，每次排查都要先花一轮问一个侧面问题（"你刷新了吗"）才能问正面问题，
// 而"改了但页面还是旧的"这类误判正是几轮返工的来源。
const buildStamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

const probeBuildStamp: Plugin = {
  name: 'ui-probe-build-stamp',
  config() {
    return { define: { __UI_PROBE_BUILD__: JSON.stringify(buildStamp) } };
  },
};

// 快照查看器是**独立的一页**（不属于应用）：它读的是历史快照文件，不该被内联进
// sampler_node.html，也不该让应用为了它多背一份代码。所以 build 时原位拷到 nodes/web，
// 由后端同源送出去。源在 src/debug/viewer.html，产物是 nodes/web/probe_viewer.html。
const probeViewer: Plugin = {
  name: 'ui-probe-viewer',
  closeBundle() {
    const src = resolve(__dirname, 'src/debug/viewer.html');
    if (existsSync(src)) copyFileSync(src, resolve(outDir, 'probe_viewer.html'));
  },
};

// Agent 工具目录（`nodes/workbench/agent_tools.json`）是**构建产物**：源在
// src/agent/toolSchemas.ts，后端按 mtime 热读它。挂在这里而不是单独的 npm script，
// 是因为"前端改动生效"的唯一路径就是 build —— 只要构建过，后端就不可能拿着过期的工具表，
// 也就不存在"改了 schema 忘了同步、下次启动才发现"这种事。
const agentToolCatalog: Plugin = {
  name: 'agent-tool-catalog',
  closeBundle() {
    const gen = resolve(repoRoot, 'tools/gen_agent_tools.cjs');
    if (!existsSync(gen)) return;
    const r = spawnSync(process.execPath, [gen], { stdio: 'inherit', cwd: repoRoot });
    if (r.status !== 0) throw new Error('agent tool catalog generation failed (see above)');
  },
};

export default defineConfig({
  ...createViteConfig({
    appName: 'sampler_node',
    outDir,
    base: '',
    extraPlugins: [probeBuildStamp, probeViewer, agentToolCatalog],
  }),
  resolve: {
    alias: {
      '@kolid/ui-utils': uiUtilsSrc,
    },
  },
  // 组件树靠 `fn.name`（探针走 React fiber 拿到的就是这个）—— 而生产构建会把函数名压成 `pb`/`Uv`。
  // 名字一丢，"定位到是哪一层组件"这件事就只能靠人肉认 DOM，探针最值钱的那一栏就等于没有。
  // keepNames 让 esbuild 保留 `.name`（代价是每个函数多一行 `__name` 调用），换回的是一张读得懂的层级表。
  esbuild: { keepNames: true },
});
