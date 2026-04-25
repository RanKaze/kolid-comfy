import { defineConfig } from 'vite'
import { resolve } from 'path';
import react from '@vitejs/plugin-react';
import inject from '@rollup/plugin-inject';

export default defineConfig({
  base: '',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: (_, entryName) => `${entryName}.js`
    },
    sourcemap: true,
    target: 'es2022',
    minify: false,
    rollupOptions: {
      external: (id) => id.startsWith('../../../../scripts/'),
      plugins: [
        inject({
          app: ['../../../../scripts/app.js', 'app']
        })
      ],
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
})
