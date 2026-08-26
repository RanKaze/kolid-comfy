import { createViteConfig } from '../packages/ui-utils/src/vite-config';
import { defineConfig } from 'vite';
import { resolve } from 'path';

const uiUtilsSrc = resolve(__dirname, '../packages/ui-utils/src');

export default defineConfig({
  ...createViteConfig({
    appName: 'sampler_node',
    outDir: resolve(__dirname, '../web'),
    base: '',
  }),
  resolve: {
    alias: {
      '@kolid/ui-utils': uiUtilsSrc,
    },
  },
});
