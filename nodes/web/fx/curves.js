// fx/curves.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图 + 编辑面。

// ---- 数据模型:PS 式控制点曲线 ----
// 参数只剩一条 curves:四个通道各存一串控制点。主曲线 rgb 先作用于三个通道,再叠上各自的通道
// 曲线 —— 和 PS 的 Curves 面板同一个叠加次序,所以「编辑哪一条」只是面板焦点,不再是作用域参数,
// 它存在 curveFocus 里(和 fxOpenId 一样是 UI 状态,不进参数、不进缓存键)。
// 点列归一化到 0..1、按 x 升序、至少两点:首末点的 x 就是输入黑/白点(底边那两个三角),y 就是
// 输出黑/白。端点可拖之后,「1 是不动点」再也拦不住纯白文字 —— 把右上角往下拖就是压暗。
// 写参数一律整体替换、绝不原地改点列:那串数组在 undo 快照之间是共享引用。
const CURVE_CHANNELS = ['rgb', 'r', 'g', 'b'];
const CURVE_CHANNEL_LABELS = { rgb: 'RGB', r: 'Red', g: 'Green', b: 'Blue' };
const CURVE_RGB_ORDER = ['r', 'g', 'b'];
const CURVE_LUT_STEPS = 256;
const CURVE_MIN_GAP = 0.004;

// 面板焦点通道按特效 id 记着:重建列表不该把用户正在编辑的那条曲线换掉。
const curveFocus = {};

function curveClamp01(v) {
    return Math.max(0, Math.min(1, v));
}

function identityCurvePoints() {
    return [[0, 0], [1, 1]];
}

function curveIsIdentity(pts) {
    return !!pts && pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1;
}

function curveChannelPoints(curves, ch) {
    const pts = curves && Array.isArray(curves[ch]) ? curves[ch] : null;
    if (!pts || pts.length < 2) return identityCurvePoints();
    const clean = pts.map(q => [curveClamp01(Number(q[0]) || 0), curveClamp01(Number(q[1]) || 0)]);
    clean.sort((a, b) => a[0] - b[0]);
    return clean;
}

// 每次都发新的数组:读的人可能接着改它,共享默认对象会让四条曲线互相污染。
function curveSetOf(p) {
    const out = {};
    for (const ch of CURVE_CHANNELS) out[ch] = curveChannelPoints(p.curves, ch);
    return out;
}

// 三次 Hermite 插值:串过每一个控制点,中段平滑,陡段允许像 PS 那样轻微过冲,最后夹回 0..1。
// 端点切线取单侧割线 —— 只有两点时切线等于割线,恒等对角线才会被精确还原成直线(两端都取邻点
// 均差的话,两点曲线会自己拧成一个 S 形)。首点之前 / 末点之后平着夹出去,就是输入黑/白点的截断。
function curveValueAt(pts, x) {
    const n = pts.length;
    if (x <= pts[0][0]) return curveClamp01(pts[0][1]);
    if (x >= pts[n - 1][0]) return curveClamp01(pts[n - 1][1]);
    let i = 0;
    while (i < n - 2 && x > pts[i + 1][0]) i++;
    const slope = (a, b) => (b[1] - a[1]) / Math.max(b[0] - a[0], 1e-6);
    const m0 = i === 0 ? slope(pts[0], pts[1]) : slope(pts[i - 1], pts[i + 1]);
    const m1 = i + 2 >= n ? slope(pts[n - 2], pts[n - 1]) : slope(pts[i], pts[i + 2]);
    const h = Math.max(pts[i + 1][0] - pts[i][0], 1e-6);
    const t = (x - pts[i][0]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const y0 = pts[i][1];
    const y1 = pts[i + 1][1];
    return curveClamp01((2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m0
        + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m1);
}

// 查表栅格取纹素中心 (i+0.5)/256:着色器用线性过滤按电平查这张表,中心格栅才不会有半格偏移,
// 恒等表也因此能被精确还原。
function curveLut(pts) {
    const lut = new Float32Array(CURVE_LUT_STEPS);
    for (let i = 0; i < CURVE_LUT_STEPS; i++) lut[i] = curveValueAt(pts, (i + 0.5) / CURVE_LUT_STEPS);
    return lut;
}

// 四条点列压成一张 256×1 的 RGBA 表:GLSL ES 3.00 没有 sampler1D,1D 查表就用 2D 纹理的一行。
// 恒定 256 个纹素,与曲线复杂程度无关;没编辑过的通道走恒等,不占额外计算。
function fxCurveBytes(set) {
    const bytes = new Uint8Array(CURVE_LUT_STEPS * 4);
    const chans = [];
    for (let k = 0; k < 3; k++) chans.push(curveIsIdentity(set[CURVE_RGB_ORDER[k]]) ? null : curveLut(set[CURVE_RGB_ORDER[k]]));
    const master = curveIsIdentity(set.rgb) ? null : curveLut(set.rgb);
    for (let i = 0; i < CURVE_LUT_STEPS; i++) {
        // 通道曲线吃的是主曲线的**输出电平**,量化回 0..255 再去查它那张同栅格的表。
        const m = master ? Math.round(master[i] * 255) : i;
        for (let k = 0; k < 3; k++) bytes[i * 4 + k] = chans[k] ? Math.round(chans[k][m] * 255) : m;
        bytes[i * 4 + 3] = 255;
    }
    return bytes;
}

function curvesAreIdentity(p) {
    const c = p.curves;
    return CURVE_CHANNELS.every(ch => curveIsIdentity(curveChannelPoints(c, ch)));
}

// ---- 旧参数迁移 ----
// 旧的曲线是四个解析旋钮(输入黑白点 → gamma → S 形 → 输出黑白场),这套点列本来就能表达它们,
// 所以读入时按 9 个等距输入电平采样一次:老存档和 undo 快照里的曲线样子基本不变。旋钮不再是
// 参数,输出黑白场也交还给端点 —— PS 的 Curves 面板就没有输出场滑块。
const CURVE_LEGACY_KEYS = ['black', 'white', 'gamma', 'contrast', 'outBlack', 'outWhite'];
// 旧 channel 也一并退休:它现在只是面板焦点,留在 params 里只会被 fxSignature 当成一次改动。
const CURVE_RETIRED_KEYS = ['channel'].concat(CURVE_LEGACY_KEYS);

function legacyCurveValue(raw, v) {
    const black = (Number(raw.black) || 0) / 100;
    const white = raw.white === undefined ? 1 : (Number(raw.white) || 100) / 100;
    const gamma = Math.max(0.05, Number(raw.gamma) || 1);
    const c = (Number(raw.contrast) || 0) / 100;
    const ob = (Number(raw.outBlack) || 0) / 100;
    const ow = raw.outWhite === undefined ? 1 : (Number(raw.outWhite) || 100) / 100;
    let x = curveClamp01((v - black) / Math.max(white - black, 1e-4));
    x = Math.pow(x, 1 / gamma);
    x = c >= 0 ? x + (x * x * (3 - 2 * x) - x) * c : x + (0.5 - x) * (-c);
    return curveClamp01(ob + x * (ow - ob));
}

function migrateLegacyCurves(raw, out) {
    if (raw.curves || !CURVE_LEGACY_KEYS.some(k => raw[k] !== undefined)) return;
    const leg = { black: 0, white: 100, gamma: 1, contrast: 0, outBlack: 0, outWhite: 100, ...raw };
    // 旧默认值就是恒等,别给它造一串假点(那会让一次空 pass 跑起来)。
    if (leg.black === 0 && leg.white === 100 && Math.abs(Number(leg.gamma) - 1) < 1e-3
        && leg.contrast === 0 && leg.outBlack === 0 && leg.outWhite === 100) return;
    const pts = [];
    for (let i = 0; i < 9; i++) pts.push([i / 8, Number(legacyCurveValue(leg, i / 8).toFixed(4))]);
    const set = {};
    for (const c of CURVE_CHANNELS) set[c] = identityCurvePoints();
    // 旧参数的 channel 是「这条曲线作用在哪」,迁移就把它放到哪一条上。
    const target = String(raw.channel || 'rgb').toLowerCase();
    set[CURVE_CHANNELS.includes(target) ? target : 'rgb'] = pts;
    out.curves = set;
}

// 子行读数:哪条曲线被动过、有几个控制点。没动过就整行留空。
function curveChainReadout(p) {
    const parts = [];
    for (const ch of CURVE_CHANNELS) {
        const pts = curveChannelPoints(p.curves, ch);
        if (curveIsIdentity(pts)) continue;
        parts.push(`${ch === 'rgb' ? 'M' : ch.toUpperCase()}·${pts.length}`);
    }
    return parts.join('  ');
}

// ---- 着色器 + pass ----
// 点列在 JS 侧已经合成好那张 256×1 查表,着色器只做一次按电平查表:横向是输入电平、纵向取中线。
// 输入夹进 0..1(半浮点缓冲里偶尔会有出界的值),alpha 永不参与。
const FX_FS_CURVES = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uLut;
void main() {
    vec4 c = texture(uTex, vUV);
    vec3 v = vec3(texture(uLut, vec2(clamp(c.r, 0.0, 1.0), 0.5)).r,
                  texture(uLut, vec2(clamp(c.g, 0.0, 1.0), 0.5)).g,
                  texture(uLut, vec2(clamp(c.b, 0.0, 1.0), 0.5)).b);
    Frag = vec4(v, c.a);
}`;

function fxglCurves(col, p) {
    if (curvesAreIdentity(p)) return;
    const gl = fxgl.gl;
    const bytes = fxCurveBytes(curveSetOf(p));
    gl.bindTexture(gl.TEXTURE_2D, fxgl.texLut);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, CURVE_LUT_STEPS, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    const dst = fxgl.off[1 - col.slot];
    fxglRunPass(dst, fxgl.progs.curves, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uLut', fxgl.texLut, 1);
    });
    col.slot = 1 - col.slot;
}

// ---- 编辑面 ----
// 内嵌在曲线卡里,替掉那一排滑块:通道下拉 + 曲线图 + Input/Output 读数 + 底边输入黑白点三角
// + 复位。点击加控制点、拖动塑形、Alt-点击删除,和 PS 的 Curves 面板一一对应。
function curvesEditorEl(l, effect, syncRead, updaters) {
    const box = document.createElement('div');
    box.className = 'fx-curves';
    const PAD = 7;
    const SIZE = 150;
    const inner = SIZE - 2 * PAD;
    let picked = -1;

    const ch = () => (curveFocus[effect.id] && CURVE_CHANNELS.includes(curveFocus[effect.id]) ? curveFocus[effect.id] : 'rgb');
    const pointsOf = c => curveChannelPoints(effectParams(effect).curves, c || ch());

    const rowSel = document.createElement('div');
    rowSel.className = 'control-row';
    const lab = document.createElement('label');
    lab.textContent = 'Channel';
    const sel = document.createElement('select');
    for (const c of CURVE_CHANNELS) {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = CURVE_CHANNEL_LABELS[c];
        sel.appendChild(opt);
    }
    sel.value = ch();
    // 下拉只换编辑焦点,不改像素,所以不走 fxLiveUpdate(那会清缓存重画布)。
    sel.addEventListener('change', () => {
        curveFocus[effect.id] = sel.value;
        picked = -1;
        paint();
    });
    rowSel.appendChild(lab);
    rowSel.appendChild(sel);
    box.appendChild(rowSel);

    const graph = document.createElement('div');
    graph.className = 'fx-curve-box';
    const cv = document.createElement('canvas');
    cv.className = 'fx-curve-canvas';
    cv.width = Math.round(SIZE * (window.devicePixelRatio || 1));
    cv.height = cv.width;
    graph.appendChild(cv);

    const mkTri = key => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'fx-curve-tri ' + key;
        b.title = key === 'black' ? 'Drag for the input black point' : 'Drag for the input white point';
        graph.appendChild(b);
        return b;
    };
    const triBlack = mkTri('black');
    const triWhite = mkTri('white');

    const readCol = document.createElement('div');
    readCol.className = 'fx-curve-read';
    const mkNum = name => {
        const line = document.createElement('div');
        const t = document.createElement('span');
        t.textContent = name;
        const v = document.createElement('b');
        line.appendChild(t);
        line.appendChild(v);
        readCol.appendChild(line);
        return v;
    };
    const numIn = mkNum('Input');
    const numOut = mkNum('Output');
    // 图 + 读数并排:PS 的 Curves 面板就是曲线在左、Input/Output 数值在右。
    const cols = document.createElement('div');
    cols.className = 'fx-curve-row';
    cols.appendChild(graph);
    cols.appendChild(readCol);
    box.appendChild(cols);

    const toPx = (x, y) => [PAD + x * inner, PAD + (1 - y) * inner];
    const toXY = (px, py) => [curveClamp01((px - PAD) / inner), curveClamp01(1 - (py - PAD) / inner)];

    function paint() {
        const dpr = window.devicePixelRatio || 1;
        const css = cv.clientWidth || SIZE;
        const side = Math.round(css * dpr);
        if (cv.width !== side) { cv.width = side; cv.height = side; }
        const g = cv.getContext('2d');
        resetCtx(g);
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        const k = css / SIZE;
        const ox = PAD * k, iy = inner * k;
        g.clearRect(0, 0, css, css);
        g.fillStyle = '#0e0e11';
        g.fillRect(ox, ox, iy, iy);
        g.strokeStyle = 'rgba(255,255,255,0.09)';
        g.lineWidth = 1;
        g.beginPath();
        for (let i = 1; i < 4; i++) {
            const p = (iy * i) / 4;
            g.moveTo(ox, ox + p); g.lineTo(ox + iy, ox + p);
            g.moveTo(ox + p, ox); g.lineTo(ox + p, ox + iy);
        }
        g.stroke();
        // 恒等参考线画在曲线下层:PS 的图里它就是那条对角虚线。
        g.setLineDash([3, 3]);
        g.strokeStyle = 'rgba(255,255,255,0.22)';
        g.beginPath();
        g.moveTo(ox, ox + iy);
        g.lineTo(ox + iy, ox);
        g.stroke();
        g.setLineDash([]);
        const pts = pointsOf();
        g.strokeStyle = '#6f8cff';
        g.lineWidth = 1.8;
        g.beginPath();
        for (let i = 0; i < CURVE_LUT_STEPS; i++) {
            // toPx 给的是 SIZE 空间(含 PAD),乘 k 才是 css 像素。
            const x = i / (CURVE_LUT_STEPS - 1);
            const q = toPx(x, curveValueAt(pts, x));
            if (i) g.lineTo(q[0] * k, q[1] * k); else g.moveTo(q[0] * k, q[1] * k);
        }
        g.stroke();
        for (let i = 0; i < pts.length; i++) {
            const q = toPx(pts[i][0], pts[i][1]);
            const X = q[0] * k, Y = q[1] * k;
            const r = i === picked ? 3.6 : 2.8;
            g.fillStyle = i === picked ? '#fff' : '#0e0e11';
            g.strokeStyle = '#6f8cff';
            g.lineWidth = 1.4;
            g.beginPath();
            g.rect(X - r, Y - r, r * 2, r * 2);
            g.fill();
            g.stroke();
        }
        // 三角贴在底边上,位置 = 首末点的 x —— 它就是输入黑/白点,PS 里也是这么摆的。
        triBlack.style.left = `${ox + pts[0][0] * iy - 6}px`;
        triWhite.style.left = `${ox + pts[pts.length - 1][0] * iy - 6}px`;
        const p = picked >= 0 && pts[picked] ? pts[picked] : null;
        numIn.textContent = p ? String(Math.round(p[0] * 255)) : '\u2014';
        numOut.textContent = p ? String(Math.round(p[1] * 255)) : '\u2014';
    }
    updaters.push(paint);

    // 整体换掉 curves 对象(连同一串新点列),并把旧的解析旋钮清掉:它们已被点列取代,留在参数里
    // 只会被 fxSignature 当成改动记进缓存键。
    function writePoints(channel, pts, undoable) {
        const set = curveSetOf(effectParams(effect));
        set[channel] = pts;
        if (!effect.params) effect.params = {};
        effect.params.curves = set;
        for (const k of CURVE_RETIRED_KEYS) delete effect.params[k];
        syncRead();
        fxLiveUpdate(l);
        if (undoable) pushHistory();
    }

    function movePoint(index, x, y) {
        const pts = pointsOf();
        const lo = index === 0 ? 0 : pts[index - 1][0] + CURVE_MIN_GAP;
        const hi = index === pts.length - 1 ? 1 : pts[index + 1][0] - CURVE_MIN_GAP;
        pts[index] = [Math.max(lo, Math.min(hi, x)), y];
        writePoints(ch(), pts, false);
    }

    function beginDrag(index) {
        const move = mv => {
            const r = cv.getBoundingClientRect();
            const q = toXY(mv.clientX - r.left, mv.clientY - r.top);
            movePoint(index, q[0], q[1]);
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            pushHistory();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }

    // 命中判定用归一化距离:点和空白都在同一把尺子上。
    function nearest(pts, x, y) {
        let best = -1, bd = 0.07 * 0.07;
        for (let i = 0; i < pts.length; i++) {
            const dx = pts[i][0] - x, dy = pts[i][1] - y;
            const d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = i; }
        }
        return best;
    }

    cv.addEventListener('pointerdown', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        const r = cv.getBoundingClientRect();
        const q = toXY(ev.clientX - r.left, ev.clientY - r.top);
        const pts = pointsOf();
        let i = nearest(pts, q[0], q[1]);
        if (i >= 0 && ev.altKey) {
            if (i > 0 && i < pts.length - 1) {
                pts.splice(i, 1);
                picked = -1;
                writePoints(ch(), pts, true);
            }
            return;
        }
        if (i < 0) {
            // 和 PS 一样:点空白处就在那儿加一个控制点,落点 y 就是它的输出电平。范围外不加 ——
            // 输入黑白点外侧是被截平的死区,在那里落点只会造出一对重合的 x。
            const lo = pts[0][0] + CURVE_MIN_GAP;
            const hi = pts[pts.length - 1][0] - CURVE_MIN_GAP;
            if (q[0] <= lo || q[0] >= hi) return;
            const at = pts.findIndex(p => p[0] > q[0]);
            pts.splice(at, 0, [q[0], q[1]]);
            writePoints(ch(), pts, false);
            i = at;
        }
        picked = i;
        beginDrag(i);
        paint();
    });

    // 底边两个三角 = 首末点的 x。纵向不动,拖的就是输入黑/白点。
    function triDrag(key, ev) {
        const pts = pointsOf();
        const index = key === 'black' ? 0 : pts.length - 1;
        const keepY = pts[index][1];
        const move = mv => {
            const r = cv.getBoundingClientRect();
            movePoint(index, toXY(mv.clientX - r.left, 0)[0], keepY);
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            pushHistory();
        };
        ev.preventDefault();
        ev.stopPropagation();
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }
    triBlack.addEventListener('pointerdown', ev => triDrag('black', ev));
    triWhite.addEventListener('pointerdown', ev => triDrag('white', ev));

    const foot = document.createElement('div');
    foot.className = 'fx-curve-foot';
    const hint = document.createElement('span');
    hint.textContent = 'click add · drag shape · alt-click remove';
    const rst = document.createElement('button');
    rst.type = 'button';
    rst.className = 'icon-btn fx-curve-reset';
    rst.title = 'Reset all channel curves';
    rst.innerHTML = fxIconSvg('reset');
    rst.addEventListener('click', ev => {
        ev.stopPropagation();
        const set = {};
        for (const c of CURVE_CHANNELS) set[c] = identityCurvePoints();
        if (!effect.params) effect.params = {};
        effect.params.curves = set;
        for (const k of CURVE_RETIRED_KEYS) delete effect.params[k];
        picked = -1;
        syncRead();
        fxLiveUpdate(l);
        pushHistory();
    });
    foot.appendChild(hint);
    foot.appendChild(rst);
    box.appendChild(foot);
    paint();
    return box;
}

defineEffect({
    type: 'curves',
    label: 'Curves',
    group: 'Color',
    icon: 'curve',
    desc: 'A Photoshop-style point curve, one per channel: the RGB master curve acts on all three channels first, then each channel curve on top of it. Click the graph to add a control point, drag it to shape the curve, Alt-click to remove it, and drag the two triangles on the bottom edge for the input black/white points. The end points double as the output black/white levels \u2014 pulling the top-right one down is how a flat white glyph dims. Pure remap \u2014 nothing moves, nothing blurs, alpha untouched.',
    params: [
        // 只剩数据本身:四条点列。「编辑哪条曲线」是面板焦点,不是作用域参数,所以它不进 params
        // (否则每次换通道都会白白清一次 fx 缓存)。
        { key: 'curves', label: 'Curve', def: null },
    ],
    migrate: migrateLegacyCurves,
    editor: curvesEditorEl,
    shaders: { curves: FX_FS_CURVES },
    run: fxglCurves,
    readout: curveChainReadout,
    thumb(g, box) {
        g.strokeStyle = 'rgba(255,255,255,0.22)';
        g.lineWidth = 1;
        g.strokeRect(box.x, box.y, box.w, box.h);
        g.setLineDash([3, 3]);
        g.beginPath();
        g.moveTo(box.x, box.y + box.h);
        g.lineTo(box.x + box.w, box.y);
        g.stroke();
        g.setLineDash([]);
        g.strokeStyle = '#6f8cff';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(box.x, box.y + box.h);
        g.bezierCurveTo(box.x + box.w * 0.35, box.y + box.h * 0.95, box.x + box.w * 0.65, box.y + box.h * 0.05, box.x + box.w, box.y);
        g.stroke();
    },
});
