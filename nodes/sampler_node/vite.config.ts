import { createViteConfig } from '@kolid/ui-utils/vite';
import { resolve } from 'path';

export default createViteConfig({
  appName: 'sampler_node',
  outDir: resolve(__dirname, '../web'),
  base: '',
});
