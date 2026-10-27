// 折图语义等价性测试：`KLayerFold.compile()`（浏览器侧）vs `render_plan.py`（唯一权威）。
//
// 口径：拿同一份 .cud、同一个 layer set，两边各编译一次，逐字段比。plan 是纯数据，所以这里做的是
// **结构 diff**（不是像素 diff）—— 像素由 tests/golden 那三层比对负责。
//
// 用法:
//   node tests/layer_fold/compare.cjs                       # 跑 tests/golden/vid/*/plan.v1.json
//   node tests/layer_fold/compare.cjs <doc.cud> <oracle.json> [setKey]
//
// 覆盖不到的字段（有意）：
//   · `timeMap` —— 段的时间位置是宿主的状态，测试里按 render_plan.py 的同一套规则补上以对齐；
//   · `resources` —— 只比"被图层引用到的那些"，视频轨资源归 tracks 一栏，不属于折图。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');

function loadModule() {
    if (globalThis.KLayerFold) return globalThis.KLayerFold;
    const src = fs.readFileSync(path.join(ROOT, 'nodes/web/js/layer-fold.js'), 'utf8');
    const fn = new Function(src + '\nreturn KLayerFold;');
    return fn();
}

// ── .cud 读取（与 render_plan.py 的 read_cud 同口径）──────────────────────────────────────
function readCud(p) {
    const buf = fs.readFileSync(p);
    if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'CUD1') throw new Error('不是 .cud: ' + p);
    const hlen = buf.readUInt32LE(4);
    const head = JSON.parse(buf.toString('utf8', 8, 8 + hlen));
    let off = 8 + hlen;
    const assets = new Map();
    for (const a of head.assets || []) {
        const n = Number(a.length) || 0;
        const chunk = buf.subarray(off, off + n);
        assets.set(a.id, { id: a.id, role: a.role, length: n, md5: crypto.createHash('md5').update(chunk).digest('hex'), hash: a.hash });
        off += n;
    }
    return { path: p, head, assets };
}

// ── 把 .cud 变成"页面手上的图层对象"（页面读档后的形状与之相同：attrs 是 guid 字符串）──
function pageLayersOf(cud, setKey) {
    const h = cud.head;
    // layerSets 可能是 list（v6）也可能被人手改成 dict —— 两种都认（与 _layer_sets 同口径）
    const ls = h.layerSets || [];
    const sets = Array.isArray(ls)
        ? new Map(ls.filter((s) => s && typeof s === 'object').map((s) => [String(s.key), s]))
        : new Map(Object.keys(ls).map((k) => [String(k), ls[k] || {}]));
    const raw = (setKey && sets.has(String(setKey)) && Array.isArray(sets.get(String(setKey)).layers))
        ? sets.get(String(setKey)).layers : (h.layers || []);
    const table = new Map();
    for (const r of h.attributes || []) table.set(r.id, r);
    const records = (l) => (l.attrs || []).map((a) => (typeof a === 'string' ? table.get(a) : a)).filter(Boolean);
    // 资源引用：asset 序号 → res:<md5>（与 res_ref 一致；role 用传进来的，缺了才用资产自己的）
    const res = (v, role) => {
        if (v === null || v === undefined || v === '') return null;
        const a = typeof v === 'number' ? cud.assets.get(v) : (typeof v === 'string' ? { md5: v, role: null, id: null } : null);
        if (!a) return null;
        return {
            id: 'res:' + a.md5, kind: 'image', uri: 'inline:' + a.md5,
            w: null, h: null, role: role || a.role || null, assetId: a.id === null ? null : a.id,
        };
    };
    // 段的时间位置：set 自己就是时间线上的锚（clip.layerKey === setKey）
    let clip = null;
    for (const c of ((h.video || {}).clips) || []) {
        if (c.kind === 'layer' && c.layerKey === setKey) { clip = c; break; }
    }
    const timeMap = () => (clip ? {
        clipId: clip.id, start: clip.start, duration: clip.duration,
        offset: clip.offset || 0, srcDuration: clip.srcDuration,
    } : null);
    return { raw, env: { records, res, timeMap }, table };
}

// ── 结构 diff ────────────────────────────────────────────────────────────────────────────
function flat(v, prefix, out) {
    if (Array.isArray(v)) {
        v.forEach((x, i) => flat(x, prefix + '[' + i + ']', out));
        return out;
    }
    if (v && typeof v === 'object') {
        for (const k of Object.keys(v).sort()) flat(v[k], prefix + '.' + k, out);
        return out;
    }
    out[prefix] = v;
    return out;
}

function diff(want, got, label, out, skip) {
    const a = flat(want, label, {});
    const b = flat(got, label, {});
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
        if (skip && skip.some((s) => k.indexOf(s) >= 0)) continue;
        if (!(k in a)) { out.push(k + ': 多出 ' + JSON.stringify(b[k])); continue; }
        if (!(k in b)) { out.push(k + ': 少了（应为 ' + JSON.stringify(a[k]) + '）'); continue; }
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
            out.push(k + ': ' + JSON.stringify(a[k]) + ' → ' + JSON.stringify(b[k]));
        }
    }
    return out;
}

function compareOne(label, docPath, oraclePath, setKey) {
    const F = loadModule();
    const cud = readCud(docPath);
    const oracle = JSON.parse(fs.readFileSync(oraclePath, 'utf8'));
    const key = setKey || (oracle.source && oracle.source.layerSet) || null;
    const { raw, env } = pageLayersOf(cud, key);
    const got = F.compile(raw, env);
    const problems = [];
    diff(oracle.layers || [], got.layers, 'layers', problems);
    // 资源：只比"被图层引用到的那些"（视频轨资源归 tracks 一栏，不属于折图）
    const used = new Set();
    const walk = (v) => {
        if (!v) return;
        if (Array.isArray(v)) return v.forEach(walk);
        if (typeof v === 'object') {
            if (typeof v.resource === 'string') used.add(v.resource);
            return Object.values(v).forEach(walk);
        }
    };
    got.layers.forEach(walk);
    const byId = new Map((oracle.resources || []).map((r) => [r.id, r]));
    for (const r of got.resources) {
        if (!used.has(r.id)) continue;
        if (!byId.has(r.id)) { problems.push('resources: ' + r.id + ' 在 oracle 里没有'); continue; }
        diff(byId.get(r.id), r, 'res ' + r.id.slice(4, 12), problems);
    }
    console.log('· ' + label + '  ' + F.describe(got) + (problems.length ? '  ✗ ' + problems.length + ' 处差异' : '  ✓'));
    for (const p of problems.slice(0, 14)) console.log('    ' + p);
    if (problems.length > 14) console.log('    …还有 ' + (problems.length - 14) + ' 处');
    return problems;
}

// ── oracle：现算一份（同 doc / 同 set），避免拿着过期 golden 比对 ──────────────────────────
function pythonOracle(docPath, setKey) {
    const os = require('os');
    const out = path.join(os.tmpdir(), 'kf_oracle_' + process.pid + '.json');
    const py = process.env.PY || 'python';
    const args = [path.join(ROOT, 'nodes/workbench/render_plan.py'), docPath, '--out=' + out];
    if (setKey) args.push('--set=' + setKey);
    const r = require('child_process').spawnSync(py, args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('python 编译失败：' + (r.stderr || r.stdout || '').slice(0, 400));
    return out;
}

function setsOf(cud) {
    const ls = cud.head.layerSets || [];
    return Array.isArray(ls)
        ? new Set(ls.filter((s) => s && typeof s === 'object').map((s) => String(s.key)))
        : new Set(Object.keys(ls));
}

function main() {
    const [, , docArg, setArg] = process.argv;
    let total = 0;

    if (docArg) {
        const oracle = pythonOracle(docArg, setArg);
        try {
            total += compareOne(path.basename(docArg) + (setArg ? ' @' + setArg : ''), docArg, oracle, setArg).length;
        } finally { try { fs.unlinkSync(oracle); } catch (e) { /* 留不下就算了 */ } }
    } else {
        // 无参：先用夹具跑一遍（不依赖任何真实工程，覆盖 plan 的每个字段），再拿 golden 比。
        const os = require('os');
        const fx = path.join(os.tmpdir(), 'kf_fixture_' + process.pid + '.cud');
        require('./fixture.cjs').write(fx);
        const oracle = pythonOracle(fx, null);
        try {
            total += compareOne('fixture', fx, oracle, null).length;
        } finally {
            try { fs.unlinkSync(oracle); } catch (e) { /* ignore */ }
            try { fs.unlinkSync(fx); } catch (e) { /* ignore */ }
        }
        // golden：**先验它还没过期** —— golden 里的 layerSet 若已不在文件里，
        // 说明文件被改过，那份 plan 描述的是旧状态，比下去只会报假差异。
        const base = path.join(ROOT, 'tests/golden/vid');
        for (const d of fs.readdirSync(base).sort()) {
            const oracle = path.join(base, d, 'plan.v1.json');
            if (!fs.existsSync(oracle)) continue;
            const plan = JSON.parse(fs.readFileSync(oracle, 'utf8'));
            const doc = (plan.source || {}).path;
            if (!doc || !fs.existsSync(doc)) { console.log('· ' + d + '  skip（找不到 ' + doc + '）'); continue; }
            const key = (plan.source || {}).layerSet;
            const cud = readCud(doc);
            if (key && !setsOf(cud).has(String(key))) {
                console.log('· ' + d + '  skip（golden 已过期：' + key + ' 不在当前文件的 layerSets 里）');
                continue;
            }
            if (((plan.frame || {}).mode || 'layers') === 'source') {
                console.log('· ' + d + '  mode:source（整帧就是一条视频轨）⇒ 没有 layers 段，跳过');
                continue;
            }
            total += compareOne(d, doc, oracle, key).length;
        }
        console.log('\n提示：单跑一份真实工程 —— node tests/layer_fold/compare.cjs "<doc.cud>" [setKey]');
    }
    console.log(total ? '\nFAIL 共 ' + total + ' 处差异' : '\nOK 折图语义与 Python 编译器一致');
    process.exit(total ? 1 : 0);
}

main();
