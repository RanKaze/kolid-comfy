// golden 生成器（P0）：把「当前实现的合成输出」按固定时刻拍成基准。
//
// 取的是合成器的图（composeVidFrameCanvas / 底片帧），**不是屏幕截图** —— 屏幕受视图缩放平移影响，
// 换个窗口尺寸就全错。稳定性自检：同一时刻连取 3 次，字节必须完全一致，否则判 UNSTABLE。
//
// 用法：
//   node tests/golden/make.cjs                      # 写回 tests/golden/vid
//   node tests/golden/make.cjs --out=/tmp/golden2   # 写到别处（P1 比对新实现时用这个）
//   KOLID_GOLDEN_CUD="D:\\x.cud" node tests/golden/make.cjs
// 前置：后端在 127.0.0.1:8700 上跑着（页面与 /api/open_cuds）。
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const CHROME = process.env.KOLID_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = process.env.KOLID_APP || 'http://127.0.0.1:8700';
const CUD = process.env.KOLID_GOLDEN_CUD || 'F:\\Pathes\\Pictures\\RanKaze\\AI修改\\视频测试.cud';
const argOf = (n, d) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const OUT = path.resolve(argOf('out', path.join(__dirname, 'vid')));
const PORT = 9500 + (process.pid % 400);
const PROFILE = path.join(require('os').tmpdir(), '_kolid_golden_' + Date.now());
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cdp = (m, p) => new Promise((res, rej) => {
  const q = http.request({ host: '127.0.0.1', port: PORT, path: p, method: m }, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch { res(b) } });
  }); q.on('error', rej); q.end();
});

// 用例：时刻 + 它要覆盖的路径。改这里要连 frame.png / plan.json 一起提交。
const CASES = [
  { name: 'base-normal', t: 2.0, note: '视频轨：无 Layer 段，底片路径' },
  { name: 'layer-decal-blur', t: 4.2, note: 'Layer 段：decal(surface+frameTrack) + vector_blur' },
  { name: 'layer-late', t: 4.55, note: '同段后部（源帧变化）' },
  { name: 'after-layer', t: 5.2, note: '出段之后：底片换到下一段源' },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await fetch(APP + '/api/open_cuds', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [CUD] }),
  }).then(r => r.text()).catch(() => { throw new Error('后端没起：' + APP); });
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE, '--no-first-run', '--autoplay-policy=no-user-gesture-required',
    '--window-size=1600,1000', '--use-gl=swiftshader', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) { try { await cdp('GET', '/json/version'); break } catch { await sleep(250) } }
  const tab = await cdp('PUT', '/json/new?' + encodeURIComponent('about:blank'));
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let seq = 0; const pend = new Map(); const ctxs = []; const errors = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error); pend.delete(m.id); return; }
    if (m.method === 'Runtime.executionContextCreated') {
      const c = m.params.context;
      ctxs.push({ id: c.id, name: c.name, frameId: (c.auxData && c.auxData.frameId) || '' });
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(String((m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description) || m.params.exceptionDetails.text).slice(0, 200));
  });
  const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })) });
  const evIn = async (ctxId, expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, contextId: ctxId, userGesture: true });
    if (!r || !r.result) return { __err: JSON.stringify(r).slice(0, 200) };
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return r.result.value;
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: APP + '/sampler_node.html' });
  await sleep(7000);
  const tree = await send('Page.getFrameTree');
  const frames = []; const walk = n => { frames.push({ id: n.frame.id, url: n.frame.url }); (n.childFrames || []).forEach(walk); };
  walk(tree.frameTree);
  const lastOf = fid => [...ctxs].reverse().find(c => c.frameId === fid && c.name === '');
  const topCtx = lastOf(frames[0].id);
  const blendFrame = frames.find(f => String(f.url || '').includes('blend_node'));
  if (!topCtx || !blendFrame) { console.log('FATAL 页面没加载出 blend iframe'); process.exit(1); }
  const blendCtx = lastOf(blendFrame.id);

  for (let i = 0; i < 40; i++) {
    const ok = await evIn(blendCtx.id, `(() => { const k = String(activeLayerSet||''); const s = layerSets.get(k);
      return !!(s && (s.layers||[]).every(l => l.img && (l.img.naturalWidth || l.img.width || 0) > 0)); })()`);
    if (ok === true) break;
    await sleep(500);
  }
  const ua = await evIn(topCtx.id, `navigator.userAgent`);
  const geo = await evIn(topCtx.id, `(() => { const r = [...document.querySelectorAll('[data-vid-ruler]')].find(x => x.getBoundingClientRect().width > 50);
    const c = document.querySelector('[data-vid-pps]'); const pps = c ? Number(c.getAttribute('data-vid-pps')) : 40;
    const b = r.getBoundingClientRect(); return { left: b.left, top: b.top + b.height / 2, pps }; })()`);
  if (!geo || geo.__err) { console.log('FATAL 找不到时间线标尺', JSON.stringify(geo)); process.exit(1); }

  const seekTo = async (sec) => {
    const x = geo.left + 140 + sec * geo.pps;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: geo.top, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(40);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: geo.top, button: 'left', clickCount: 1, buttons: 0 });
    await sleep(1200);
  };

  // 有合成包就取合成（Layer 段），否则取"这一刻该有的那一帧"。
  // **source 形态必须由 t 决定**：读 plan.v1.json 里的 tracks 时刻表，用 KFrameSource 精确 seek 到
  // sourceTime(clip,t) 再取 —— 不许用"视频现在停在哪一帧"（那就是 §5.5 里那个不可复现的基准）。
  const grab = async (planText, T) => evIn(blendCtx.id, `(async () => {
    const plan = ${planText};
    const dump = (cv) => (cv && cv.width) ? cv.toDataURL('image/png') : null;
    const p = vidFramePacket;
    if (p) {
      // Layer 段：合成用的是镜像视频的当前帧 —— 先按 plan 把它对到 t 该在的地方
      if (plan) await KFrameSource.prepare(plan, ${T});
      const cv = composeVidFrameCanvas(p);
      return { kind: 'compose', data: dump(cv), t: +p.t.toFixed(4), key: String(p.layerKey || ''),
               grid: [cv.width, cv.height], layersN: vidFrameWorkLayers(p.layerKey || '').length };
    }
    const fr = plan && plan.frame;
    if (plan && fr && fr.mode === 'source' && fr.source && fr.source.trackId) {
      await KFrameSource.prepare(plan, ${T});
      const v = KFrameSource.get(fr.source.trackId);
      const w = plan.grid.w, h = plan.grid.h;
      if (v) {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(v, 0, 0, w, h);
        return { kind: 'base', data: c.toDataURL('image/png'),
                 t: +KFrameSource.wantAt(plan, fr.source.trackId, ${T}).toFixed(4), key: '',
                 grid: [w, h], layersN: 0, viaPlan: true };
      }
    }
    const v = document.getElementById('vidBaseVideo');
    const w = vidBaseCanvas.width, h = vidBaseCanvas.height;
    if (!v || !v.videoWidth || !w || !h) return { kind: 'none', data: null };
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(v, 0, 0, w, h);
    return { kind: 'base', data: c.toDataURL('image/png'), t: +v.currentTime.toFixed(4), key: '',
             grid: [w, h], layersN: 0, viaPlan: false };
  })()`);

  let failed = 0;
  const summary = [];
  for (const c of CASES) {
    const pv1 = path.join(__dirname, 'vid', c.name, 'plan.v1.json');
    const planText = fs.existsSync(pv1) ? fs.readFileSync(pv1, 'utf8') : 'null';
    await seekTo(c.t);
    const picks = [];
    for (let i = 0; i < 3; i++) { picks.push(await grab(planText, c.t)); await sleep(260); }
    if (picks.some(p => !p || p.__err || !p.data)) {
      console.log('FAIL ' + c.name, JSON.stringify(picks.map(p => p && (p.__err || p.kind))));
      failed++; continue;
    }
    const stable = picks.every(p => p.data === picks[0].data);
    const dir = path.join(OUT, c.name);
    fs.mkdirSync(dir, { recursive: true });
    const bytes = Buffer.from(picks[0].data.split(',')[1], 'base64');
    fs.writeFileSync(path.join(dir, 'frame.png'), bytes);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const raw = await evIn(blendCtx.id, `(() => {
      const p = vidFramePacket; const key = String((p && p.layerKey) || activeLayerSet || '');
      const s = layerSets.get(key) || null;
      return { key, grid: [canvasW, canvasH],
        layers: s ? (s.layers || []).map(snapshotLayerRecord) : (layers || []).map(snapshotLayerRecord),
        activeSet: String(activeLayerSet || '') };
    })()`);
    const meta = {
      case: c.name, note: c.note, requestedT: c.t,
      t: picks[0].t, kind: picks[0].kind, layerKey: picks[0].key,
      grid: picks[0].grid, fps: 30, layersN: picks[0].layersN,
      sha256: sha, bytes: bytes.length, stable,
      format: 'png-rgba-straight',
      // 同一台机器 + 同一个 GL 后端（swiftshader）必须 0；换设备先按 ≤1 LSB 比，
      // 差异集中在软边/浮点链上的话再谈（见 docs/render_plan.md §5.2）。
      tolerance: { sameDevice: 0, crossDevice: 1 },
      env: { ua, gl: 'swiftshader', headless: true },
      capturedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ v: 0, note: 'raw capture — P1 编译器把它编译成 RenderPlan', ...raw }, null, 2));
    summary.push({ case: c.name, t: meta.t, kind: meta.kind, grid: meta.grid, layersN: meta.layersN, sha: sha.slice(0, 12), stable });
    console.log((stable ? 'OK   ' : 'UNSTABLE ') + c.name + ' ' + JSON.stringify(summary[summary.length - 1]));
    if (!stable) failed++;
  }
  if (errors.length) console.log('errors', JSON.stringify(errors.slice(0, 5)));
  console.log('done -> ' + OUT + (failed ? `  (${failed} failed)` : '  (all stable)'));
  proc.kill(); ws.close();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { }
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
