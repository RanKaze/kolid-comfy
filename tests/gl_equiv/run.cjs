// 跑 tests/gl_equiv/index.html：WebGL 合成与 canvas 2D 的像素差（决定 P2 的验收标准）。
// 用法：node tests/gl_equiv/run.cjs
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9581;
const FILE = 'file:///' + path.resolve(__dirname, 'index.html').replace(/\\/g, '/');
const PROFILE = path.join(require('os').tmpdir(), '_chrome_gleq_' + Date.now());
const OUT_DIR = process.env.KOLID_GL_OUT || path.resolve(__dirname, '../../temporary');
fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cdp = (m, p) => new Promise((res, rej) => {
  const q = http.request({ host: '127.0.0.1', port: PORT, path: p, method: m }, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch { res(b) } });
  }); q.on('error', rej); q.end();
});

(async () => {
  const args = ['--headless=new', '--no-sandbox', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE, '--no-first-run', '--window-size=1400,600'];
  // headless 里 WebGL2 走软件 GL；两种开关不同版本叫法不同，都带上
  if (!process.argv.includes('--gpu')) args.push('--use-gl=swiftshader', '--enable-unsafe-swiftshader');
  else args.push('--use-angle=d3d11', '--enable-gpu');
  const proc = spawn(CHROME, args.concat(['about:blank']), { stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) { try { await cdp('GET', '/json/version'); break } catch { await sleep(250) } }
  const tab = await cdp('PUT', '/json/new?' + encodeURIComponent('about:blank'));
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let seq = 0; const pend = new Map(); const errs = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error); pend.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errs.push(String(m.params.exceptionDetails.text).slice(0, 200));
  });
  const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })) });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (!r || !r.result) return { __err: JSON.stringify(r).slice(0, 200) };
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return r.result.value;
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: FILE });
  await sleep(1500);
  let r = null;
  for (let i = 0; i < 30; i++) { r = await ev('window.__r || null'); if (r) break; await sleep(200); }
  console.log('result', JSON.stringify(r));
  const raw = await ev('window.__raw || null');
  if (raw) {
    for (const k of ['a', 'b', 'c']) {
      const v = raw[k];
      if (typeof v === 'string' && v.startsWith('data:image')) {
        fs.writeFileSync(path.resolve(OUT_DIR, `_gl_${k}.png`), Buffer.from(v.split(',')[1], 'base64'));
      }
    }
    console.log('raw -> temporary/_gl_{a,b,c}.png');
  }
  const png = await ev('window.__png || null');
  if (typeof png === 'string' && png.startsWith('data:image')) {
    fs.writeFileSync(path.resolve(OUT_DIR, '_gl_equiv.png'), Buffer.from(png.split(',')[1], 'base64'));
    console.log('strip -> temporary/_gl_equiv.png (A=2D, B=GL straight, C=GL premultiplied)');
  }
  console.log('gl', JSON.stringify(await ev(`(() => { const c = document.createElement('canvas');
    const gl = c.getContext('webgl2'); if (!gl) return 'none';
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown'; })()`)));
  if (errs.length) console.log('errors', JSON.stringify(errs.slice(0, 3)));
  proc.kill(); ws.close();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { }
  setTimeout(() => process.exit(0), 200);
})().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
