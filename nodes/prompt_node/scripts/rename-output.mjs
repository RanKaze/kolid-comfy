import { renameSync, existsSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../../web');
const src = resolve(outDir, 'index.html');
const dst = resolve(outDir, 'prompt_node.html');

if (existsSync(src)) {
  if (existsSync(dst)) unlinkSync(dst);
  renameSync(src, dst);
  console.log('[rename-output] Renamed index.html → prompt_node.html');
} else {
  console.error('[rename-output] index.html not found in', outDir);
  process.exit(1);
}
