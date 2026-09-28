// fx/tone_map.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图。

// 色调映射:把一段宽动态范围的响应压进 0..1 的一张单调曲线。四种模式:
//   * Neutral —— Khronos PBR Neutral。灰段先抬 0.04,峰值超过 0.76 才进肩部,并按超出量轻度去饱和。
//   * ACES    —— ACES 拟合近似 (Narkowicz)。有理式、逐通道,高光一路滚到白,不碰黑场。
//   * Custom  —— 由 6 个旋钮算出的四锚点单调三次曲线:趾部 (强度/长度)、肩部 (强度/长度/角度)、中间调 gamma。
//   * External—— 绑一张 3D 查找表的展开图 (与 Unity 的外部 LUT 同一套读法:贴图 + Mapping + Contribution),
//                按三线性插值取色,再与原图按量混合。
// 值域:前三种在**线性光**里算 (显示值 → sRGB 解码 → 算子 → 编码回显示值) —— 肩部滚动与趾部下沉
// 本来就是定义在线性光上的,在编码值上做会把同一条曲线的对比放大。External 是个例外,并且是故意的:
// .cube 那类表按 8 位图像值校色,输入刻度就是显示值,拿到线性光里等于把表读歪一档。
// 通道契约不变:三种算子逐通道 (与各家 filmic 一致,所以高反差边缘会轻微掉饱和),alpha 永不参与,
// 一张表/一次算子都是单趟 pass,像素尺寸一个都不外扩。

const FX_TONE_MODES = ['neutral', 'aces', 'custom', 'external'];
const FX_TONE_MODE_LABELS = { neutral: 'Neutral', aces: 'ACES', custom: 'Custom', external: 'External' };
const FX_TONE_MODE_INDEX = { neutral: 0, aces: 1, custom: 2, external: 3 };

// 只有该模式要用的行由 when 挡住;模式切换时由编辑面重建剩下这些行 (Unity 的 inspector 也是这么收起
// 无关字段的)。key 'map' 是绑定贴图的固定名 —— 解析与 .cud 资产都认这个键,见 fx/maps.js。
const FX_TONE_PARAMS = [
    { key: 'mode', label: 'Mode', kind: 'enum', options: FX_TONE_MODES, def: 'neutral' },
    { key: 'toeStrength', label: 'Toe Str', min: 0, max: 100, step: 1, def: 50, unit: '%', when: p => p.mode === 'custom' },
    { key: 'toeLength', label: 'Toe Len', min: 0, max: 50, step: 1, def: 25, unit: '%', when: p => p.mode === 'custom' },
    { key: 'shoulderStrength', label: 'Shldr Str', min: 0, max: 100, step: 1, def: 50, unit: '%', when: p => p.mode === 'custom' },
    { key: 'shoulderLength', label: 'Shldr Len', min: 0, max: 50, step: 1, def: 30, unit: '%', when: p => p.mode === 'custom' },
    { key: 'shoulderAngle', label: 'Shldr Ang', min: 0, max: 45, step: 1, def: 20, unit: '°', when: p => p.mode === 'custom' },
    { key: 'gamma', label: 'Gamma', min: 0.2, max: 3, step: 0.05, def: 1, unit: '×', when: p => p.mode === 'custom' },
    { key: 'map', label: 'Lookup', kind: 'map', def: null, when: p => p.mode === 'external' },
    { key: 'mapping', label: 'Mapping', kind: 'enum', options: ['auto', 'strip', 'tile'], def: 'auto', when: p => p.mode === 'external' },
    { key: 'contribution', label: 'Contribution', min: 0, max: 100, step: 1, def: 100, unit: '%', when: p => p.mode === 'external' },
];

const FX_FS_TONE = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uMap;
uniform int uMode;
uniform float uContrib;
uniform float uSize;
uniform vec2 uDims;
uniform float uStrip;
uniform float uGamma;
uniform float uXs[4];
uniform float uYs[4];
uniform float uMs[4];

vec3 toLinear(vec3 v) {
    return mix(v / 12.92, pow((v + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), v));
}
vec3 toDisplay(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

// Khronos PBR Neutral:黑端按 3-4-5 的灰段减去一个 offset,超过 StartCompression 才动肩部。
vec3 neutralTone(vec3 c) {
    const float startCompression = 0.76;
    const float desaturation = 0.15;
    c = max(c, vec3(0.0));
    float x = min(c.r, min(c.g, c.b));
    float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    c -= offset;
    float peak = max(c.r, max(c.g, c.b));
    if (peak < startCompression) return c;
    float d = 1.0 - startCompression;
    float newPeak = 1.0 - d * d / (peak + d - startCompression);
    c *= newPeak / peak;
    float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
    return mix(c, vec3(newPeak), g);
}

// ACES 拟合近似:x = 0 处分子正好为 0,所以黑场不会被拽成负数再夹回来 (那是同族拟合里
// 带 -0.02 常数项那一版的坑:线性 0.076 以下的阴影会整片塌成死黑)。
vec3 acesTone(vec3 x) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// Custom:三段单调三次 Hermite。锚点与切线都在 JS 侧由旋钮算好,着色器只管求值。
float toneCurve(float x) {
    x = clamp(x, 0.0, 1.0);
    int i = x < uXs[1] ? 0 : (x < uXs[2] ? 1 : 2);
    float h = max(uXs[i + 1] - uXs[i], 1e-5);
    float t = clamp((x - uXs[i]) / h, 0.0, 1.0);
    float t2 = t * t;
    float t3 = t2 * t;
    return clamp((2.0 * t3 - 3.0 * t2 + 1.0) * uYs[i]
        + (t3 - 2.0 * t2 + t) * h * uMs[i]
        + (-2.0 * t3 + 3.0 * t2) * uYs[i + 1]
        + (t3 - t2) * h * uMs[i + 1], 0.0, 1.0);
}

vec3 customTone(vec3 lin) {
    vec3 v = pow(clamp(lin, 0.0, 1.0), vec3(1.0 / max(uGamma, 1e-3)));
    return vec3(toneCurve(v.r), toneCurve(v.g), toneCurve(v.b));
}

// 展开图的两个布局都由 (r, g, b) 的**整数格号**算出纹素中心 UV。上传时开了 UNPACK_FLIP_Y,
// 图像的行序与纹理相反,所以 v 要取 1 - 行号 (查找表的绿色轴永远按图像行序往下长)。
vec2 lutUV(vec3 i) {
    float x;
    float y;
    if (uStrip > 0.5) {
        x = i.z * uSize + i.x;
        y = i.y;
    } else {
        float tiles = sqrt(uSize);
        float row = floor(i.z / tiles);
        float col = i.z - row * tiles;
        x = col * uSize + i.x;
        y = row * uSize + i.y;
    }
    return vec2((x + 0.5) / uDims.x, 1.0 - (y + 0.5) / uDims.y);
}

vec3 lutSample(vec3 c) {
    vec3 s = clamp(c, 0.0, 1.0) * (uSize - 1.0);
    vec3 lo = floor(s);
    vec3 hi = min(lo + 1.0, vec3(uSize - 1.0));
    vec3 f = s - lo;
    vec3 c000 = texture(uMap, lutUV(lo)).rgb;
    vec3 c100 = texture(uMap, lutUV(vec3(hi.x, lo.y, lo.z))).rgb;
    vec3 c010 = texture(uMap, lutUV(vec3(lo.x, hi.y, lo.z))).rgb;
    vec3 c110 = texture(uMap, lutUV(vec3(hi.x, hi.y, lo.z))).rgb;
    vec3 c001 = texture(uMap, lutUV(vec3(lo.x, lo.y, hi.z))).rgb;
    vec3 c101 = texture(uMap, lutUV(vec3(hi.x, lo.y, hi.z))).rgb;
    vec3 c011 = texture(uMap, lutUV(vec3(lo.x, hi.y, hi.z))).rgb;
    vec3 c111 = texture(uMap, lutUV(hi)).rgb;
    vec3 loG = mix(c000, c100, f.x);
    vec3 hiG = mix(c010, c110, f.x);
    vec3 loB = mix(c001, c101, f.x);
    vec3 hiB = mix(c011, c111, f.x);
    return mix(mix(loG, hiG, f.y), mix(loB, hiB, f.y), f.z);
}

void main() {
    vec4 c = texture(uTex, vUV);
    vec3 rgb;
    if (uMode == 3) {
        rgb = mix(c.rgb, lutSample(c.rgb), uContrib);
    } else {
        vec3 lin = toLinear(clamp(c.rgb, 0.0, 1.0));
        if (uMode == 0) lin = neutralTone(lin);
        else if (uMode == 1) lin = acesTone(lin);
        else lin = customTone(lin);
        rgb = toDisplay(lin);
    }
    Frag = vec4(clamp(rgb, 0.0, 1.0), c.a);
}`;

// 查找表展开图的两种排布 (与 Unity 的 Mapping 同一套):
//   strip: N 张 N×N 切片横着接成一条 (W = N², H = N)
//   tile:  切片排成 √N × √N 的大方块 (W = H = N·√N,所以 N 得是完全平方数)
// 认不出来就报原因,绝不拿一张普通图当表插值 —— 那比不调色更糟。
function toneLutLayout(w, h, mapping) {
    // 上限 128 是查表尺寸的量级,不是图像的:一张 2048×64 的照片不会被当成 LUT 认下来。
    const strip = () => (h >= 2 && h <= 128 && w === h * h ? { size: h, strip: 1, w, h } : null);
    const tile = () => {
        if (w !== h || w < 4) return null;
        const size = Math.round(Math.pow(w, 2 / 3));
        if (size * size * size !== w * w) return null;
        const tiles = Math.round(Math.sqrt(size));
        return tiles * tiles === size ? { size, strip: 0, w, h } : null;
    };
    if (mapping === 'strip') return strip();
    if (mapping === 'tile') return tile();
    return strip() || tile();
}

const toneSlope = (a, b) => (b[1] - a[1]) / Math.max(b[0] - a[0], 1e-5);

// 六个旋钮 → 四锚点曲线的几何。两端钉死在 (0,0) 与 (1,1),所以任何组合都不会把纯黑或纯白挪走;
// 中间两个锚点分别由趾部/肩部算出,肩角只按「肩部真的抬了多少」去改白点斜率 —— 强度为 0 时角度
// 不该有任何作用,否则一条「零强度」的曲线其实还在压高光。
function toneCustomAnchors(p) {
    const ts = Math.max(0, Math.min(1, p.toeStrength / 100));
    const ss = Math.max(0, Math.min(1, p.shoulderStrength / 100));
    const xt = Math.max(0.001, Math.min(0.5, p.toeLength / 100));
    const xs = Math.max(0.5, Math.min(0.999, 1 - p.shoulderLength / 100));
    const pts = [[0, 0], [xt, xt * (1 - 0.9 * ts)], [xs, xs + (1 - xs) * 0.95 * ss], [1, 1]];
    const m = [
        toneSlope(pts[0], pts[1]),
        toneSlope(pts[0], pts[2]),
        toneSlope(pts[1], pts[3]),
        1 - ss * 0.95 * (1 - Math.tan(p.shoulderAngle * Math.PI / 180)),
    ];
    // Fritsch–Carlson 的一阶充分条件:每段两端切线都夹在 [0, 3·割线斜率],曲线就不会在段内翻折。
    for (let i = 0; i < 3; i++) {
        const cap = 3 * toneSlope(pts[i], pts[i + 1]);
        m[i] = Math.max(0, Math.min(m[i], cap));
        m[i + 1] = Math.max(0, Math.min(m[i + 1], cap));
    }
    return { xs: pts.map(q => q[0]), ys: pts.map(q => q[1]), ms: m };
}

// Neutral/ACES 恒有对比重整,不存在恒等;Custom 的三个旋钮归零就是那条对角线,External 的量为 0
// 就是原图 —— 两种情况都不必占用一次 pass。
function toneIsIdentity(p) {
    if (p.mode === 'external') return p.contribution === 0;
    return p.mode === 'custom' && p.toeStrength === 0 && p.shoulderStrength === 0 && Math.abs(p.gamma - 1) < 1e-3;
}

function fxglTone(col, p, effect) {
    if (toneIsIdentity(p)) return;
    const gl = fxgl.gl;
    const mode = FX_TONE_MODE_INDEX[p.mode] ?? 0;
    let layout = null;
    if (mode === 3) {
        // 尺寸是布局的一部分,而引擎只负责把像素传进 texMap —— 这里按同一份解码缓存拿回原尺寸。
        const img = fxMapImage(fxMapRef(effect));
        if (!img) { fxgl.skip = 'Tone Map: lookup not ready'; return; }
        const n = nativeSize(img);
        layout = toneLutLayout(n.w, n.h, p.mapping);
        if (!layout) {
            // 认不出布局也要把话说清楚:静默把一张普通照片当表插值,比不调色更糟。
            fxgl.skip = p.mapping === 'auto'
                ? `Tone Map: ${n.w}×${n.h} is not a LUT layout (strip N²×N / tile N·√N square)`
                : `Tone Map: ${n.w}×${n.h} does not fit the ${p.mapping} LUT layout`;
            return;
        }
    }
    const a = mode === 2 ? toneCustomAnchors(p) : null;
    const dst = fxgl.off[1 - col.slot];
    fxglRunPass(dst, fxgl.progs.tone, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        if (layout) {
            fxglBindTex(pr, 'uMap', fxgl.texMap, 1);
            gl.uniform1f(fxglU(pr, 'uSize'), layout.size);
            gl.uniform2f(fxglU(pr, 'uDims'), layout.w, layout.h);
            gl.uniform1f(fxglU(pr, 'uStrip'), layout.strip);
            gl.uniform1f(fxglU(pr, 'uContrib'), p.contribution / 100);
        }
        gl.uniform1i(fxglU(pr, 'uMode'), mode);
        if (a) {
            gl.uniform1fv(fxglU(pr, 'uXs'), new Float32Array(a.xs));
            gl.uniform1fv(fxglU(pr, 'uYs'), new Float32Array(a.ys));
            gl.uniform1fv(fxglU(pr, 'uMs'), new Float32Array(a.ms));
            gl.uniform1f(fxglU(pr, 'uGamma'), p.gamma);
        }
    });
    col.slot = 1 - col.slot;
}

// 模式一换,要用的参数行就换一批 —— 所以这行是本特效自己出的 select (四个长名字挤不进分段按钮),
// 其余行仍交给通用的 fxControlRow,默认值/读数/undo 语义跟其它特效完全一致。
function toneEditorEl(l, effect, syncRead, updaters) {
    const box = document.createElement('div');
    box.className = 'fx-tone';
    const head = document.createElement('div');
    head.className = 'control-row';
    const label = document.createElement('label');
    label.textContent = 'Mode';
    const sel = document.createElement('select');
    for (const m of FX_TONE_MODES) {
        const o = document.createElement('option');
        o.value = m;
        o.textContent = FX_TONE_MODE_LABELS[m];
        sel.appendChild(o);
    }
    head.appendChild(label);
    head.appendChild(sel);
    const tail = document.createElement('div');
    tail.className = 'fx-tone-tail';
    box.appendChild(head);
    box.appendChild(tail);

    const show = () => {
        const v = effect.params && effect.params.mode;
        sel.value = FX_TONE_MODES.includes(v) ? v : 'neutral';
    };
    updaters.push(show);
    show();

    const build = () => {
        const p = effectParams(effect);
        const rows = FX_TONE_PARAMS
            .filter(d => d.key !== 'mode' && (!d.when || d.when(p)))
            .map(d => fxControlRow(l, effect, d, syncRead, updaters));
        tail.replaceChildren(...rows);
    };

    sel.addEventListener('change', () => {
        // 整体替换参数对象里这一个字段,和通用行完全一致;重建行要先于 syncRead,读数才跟得上。
        if (!effect.params) effect.params = {};
        effect.params.mode = sel.value;
        build();
        syncRead();
        fxLiveUpdate(l);
        pushHistory();
    });
    build();
    return box;
}

defineEffect({
    type: 'tone',
    label: 'Tone Map',
    group: 'Color',
    icon: 'tone',
    needsMap: 'Lookup',
    needsMapWhen: p => p.mode === 'external',
    desc: 'Compress a wide tonal range into 0..1 with one monotone curve. Neutral is the Khronos PBR Neutral mapper, ACES is the fitted filmic approximation, Custom exposes the toe (strength/length), the shoulder (strength/length/angle) and a midtone gamma, and External applies a bound 3D lookup table (unrolled strip or tile) blended back over the original by Contribution. The three operators run in linear light; the lookup table is read on display values, the way a .cube is authored. Colour only \u2014 nothing moves, alpha untouched.',
    params: FX_TONE_PARAMS,
    editor: toneEditorEl,
    shaders: { tone: FX_FS_TONE },
    run: fxglTone,
    readout(p, n, effect) {
        if (p.mode === 'external') {
            const m = p.mapping === 'auto' ? '' : `  ${p.mapping}`;
            return `${fxMapShort(effect)}  ${n(p.contribution)}%${m}`;
        }
        if (p.mode !== 'custom') return FX_TONE_MODE_LABELS[p.mode] || 'Neutral';
        return `toe ${n(p.toeStrength)}·${n(p.toeLength)}  sh ${n(p.shoulderStrength)}·${n(p.shoulderLength)}·${n(p.shoulderAngle)}°  ${n(p.gamma)}×`;
    },
    thumb(g, box) {
        // 对角线是「没有映射」的参照,粗线是一片线性 ramp 被趾部拉下、被肩部滚到白的样子。
        g.strokeStyle = 'rgba(255,255,255,0.22)';
        g.lineWidth = 1;
        g.setLineDash([3, 3]);
        g.beginPath();
        g.moveTo(box.x, box.y + box.h);
        g.lineTo(box.x + box.w, box.y);
        g.stroke();
        g.setLineDash([]);
        g.strokeStyle = '#ffb340';
        g.lineWidth = 2;
        g.beginPath();
        const px = t => box.x + t * box.w;
        const py = t => box.y + box.h - (t < 0.25 ? t * 0.55 : t < 0.7 ? 0.1375 + (t - 0.25) * 1.35 : 0.755 + (t - 0.7) * 0.8) * box.h;
        for (let i = 0; i <= 48; i++) {
            const t = i / 48;
            if (i) g.lineTo(px(t), py(t));
            else g.moveTo(px(t), py(t));
        }
        g.stroke();
        g.fillStyle = 'rgba(255,179,64,0.85)';
        for (const t of [0, 0.25, 0.7, 1]) g.fillRect(px(t) - 2, py(t) - 2, 4, 4);
    },
});
