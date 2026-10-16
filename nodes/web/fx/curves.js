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

// ---- 参数面归宿主 dock 以后,曲线这一格的落点 ----
// 图上的手势由宿主量出归一化坐标发回来,这里只做页面原来那三件事：按 CURVE_MIN_GAP 夹住 x、整体换掉
// curves 对象（连同一串新点列,那串数组在 undo 快照之间是共享引用）、把旧的解析旋钮清掉（它们已被点列
// 取代,留在参数里只会被 fxSignature 当成改动记进缓存键）。
// 编辑哪条通道仍是页面这一侧的 curveFocus —— 换焦点不改像素,所以那一句不走 fxLiveUpdate。
// 「刚结束的是哪一种拖动」也留在这里:历史那句话说的是**这一次手势**,不能由下一次按的东西代它说话。
let fxCurveGesture = '';

function fxCurveChannel(effect) {
    return (curveFocus[effect.id] && CURVE_CHANNELS.includes(curveFocus[effect.id]))
        ? curveFocus[effect.id] : 'rgb';
}
function fxCurvePoints(effect) {
    return curveChannelPoints(effectParams(effect).curves, fxCurveChannel(effect));
}
// 首末点各自只有一侧的邻居;夹在两个邻居之间,所以点列永远是 x 升序、不会重合成一对。
function fxCurveClampX(pts, i, x) {
    const lo = i === 0 ? 0 : pts[i - 1][0] + CURVE_MIN_GAP;
    const hi = i === pts.length - 1 ? 1 : pts[i + 1][0] - CURVE_MIN_GAP;
    return Math.max(lo, Math.min(hi, x));
}
function fxCurveWrite(l, effect, channel, pts) {
    const set = curveSetOf(effectParams(effect));
    set[channel] = pts;
    if (!effect.params) effect.params = {};
    effect.params.curves = set;
    for (const k of CURVE_RETIRED_KEYS) delete effect.params[k];
    fxLiveUpdate(l);
    fxPublishRows();
}

function fxCurveOp(l, effect, o) {
    const op = String((o && o.op) || '');
    const ch = fxCurveChannel(effect);
    const pts = fxCurvePoints(effect);
    if (op === 'focus') {
        const c = String((o && o.channel) || '');
        if (!CURVE_CHANNELS.includes(c)) return false;
        curveFocus[effect.id] = c;
        fxPublishRows();
        return true;
    }
    if (op === 'add') {
        const x = Number(o.x), y = Number(o.y);
        // 和 PS 一样:点空白处就在那儿加一个控制点,落点 y 就是它的输出电平。范围外不加 ——
        // 输入黑白点外侧是被截平的死区,在那里落点只会造出一对重合的 x。
        const lo = pts[0][0] + CURVE_MIN_GAP, hi = pts[pts.length - 1][0] - CURVE_MIN_GAP;
        if (!(x > lo && x < hi)) return false;
        const at = pts.findIndex(p => p[0] > x);
        pts.splice(at, 0, [curveClamp01(x), curveClamp01(y)]);
        fxCurveGesture = 'point';
        fxCurveWrite(l, effect, ch, pts);
        return true;
    }
    if (op === 'move') {
        const i = Number(o.index);
        if (!(i >= 0 && i < pts.length)) return false;
        pts[i] = [fxCurveClampX(pts, i, Number(o.x)), curveClamp01(Number(o.y))];
        fxCurveGesture = 'point';
        fxCurveWrite(l, effect, ch, pts);
        return true;
    }
    if (op === 'input') {
        // 底边两个三角 = 首末点的 x。纵向不动,拖的就是输入黑/白点。
        const which = o.which === 'white' ? 'white' : 'black';
        const i = which === 'black' ? 0 : pts.length - 1;
        pts[i] = [fxCurveClampX(pts, i, Number(o.x)), pts[i][1]];
        fxCurveGesture = which;
        fxCurveWrite(l, effect, ch, pts);
        return true;
    }
    if (op === 'remove') {
        const i = Number(o.index);
        if (!(i > 0 && i < pts.length - 1)) return false;    // 首末点是输入黑/白,删了曲线就没边界了
        pts.splice(i, 1);
        fxCurveWrite(l, effect, ch, pts);
        fxCurveGesture = '';
        pushHistory(null, 'Curves — point removed');
        fxRefreshParams();
        return true;
    }
    if (op === 'settle') {
        if (!fxCurveGesture) return false;
        const label = fxCurveGesture === 'point' ? 'Curves — point moved'
            : 'Curves — input ' + fxCurveGesture + ' point moved';
        fxCurveGesture = '';
        pushHistory(null, label);
        fxRefreshParams();
        return true;
    }
    if (op === 'reset') {
        const set = {};
        for (const c of CURVE_CHANNELS) set[c] = identityCurvePoints();
        if (!effect.params) effect.params = {};
        effect.params.curves = set;
        for (const k of CURVE_RETIRED_KEYS) delete effect.params[k];
        fxCurveGesture = '';
        fxLiveUpdate(l);
        pushHistory(null, 'Curves — all channels reset');
        fxRefreshParams();
        return true;
    }
    return false;
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
        { key: 'curves', label: 'Curve', kind: 'curve', def: null },
    ],
    migrate: migrateLegacyCurves,
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
