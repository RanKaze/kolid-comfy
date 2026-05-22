import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { resolve } from 'path';
import { renameSync } from 'fs';

export default defineConfig({
  base: '',
  plugins: [
    react(),
    viteSingleFile(),
    {
      name: 'rename-html',
      closeBundle() {
        const outDir = resolve(__dirname, '../web');
        try {
          renameSync(resolve(outDir, 'index.html'), resolve(outDir, 'switch_node.html'));
        } catch (e) {
          // ignore
        }
      },
    },
  ],
  build: {
    outDir: resolve(__dirname, '../web'),
    emptyOutDir: false,
  },
});
