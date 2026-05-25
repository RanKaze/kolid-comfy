import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { resolve } from 'path';
import { renameSync, existsSync, unlinkSync } from 'fs';

export interface ViteConfigOptions {
  appName: string;
  outDir: string;
  base?: string;
  extraPlugins?: Plugin[];
}

export function createViteConfig(options: ViteConfigOptions) {
  const { appName, outDir, base, extraPlugins = [] } = options;

  const renamePlugin: Plugin = {
    name: 'rename-html',
    closeBundle() {
      try {
        const src = resolve(outDir, 'index.html');
        const dst = resolve(outDir, `${appName}.html`);
        if (existsSync(dst)) unlinkSync(dst);
        renameSync(src, dst);
      } catch {
        // ignore
      }
    },
  };

  return defineConfig({
    base,
    plugins: [react(), viteSingleFile(), renamePlugin, ...extraPlugins],
    build: {
      outDir,
      emptyOutDir: false,
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  });
}
