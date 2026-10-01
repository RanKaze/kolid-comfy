// fx/ssr.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图 (Reflect 组)。
// 屏幕空间反射:把绑来的**深度图当一块浮雕** (高度 = Near 极性翻一次, 满幅 = Relief px), 视线垂直
// 往下看这块面;每个像素的镜面方向由**法线图**给出 (绿朝上的 OpenGL 读法, z 朝读者), 而 Tilt/Axis
// 把整块反射面当一块可拧角度的玻璃 —— 绕屏幕内一根轴拧离正面 (这正是「反射面的角度」这颗旋钮),
// 拧完反射往哪边找由镜面反射自己说:Axis=0° 配正 Tilt, 法线倒向画面上方, 反射沿画面往上找。
// 找的过程就是 depth test:反射 ray 从自身地表高度 d0 出发, 沿反射方向在网格上步进 Steps 步、最远
// Reach px, 每步拿深度场和 ray 高度比 —— 地形高过 ray 的第一处把 ray 挡住 (前面的东西把反射裁掉),
// 命中点再二分 4 次磨掉台阶;走满了也没撞到 = 什么都没照见, 原样。Jitter 用确定性整数 hash 把起步
// 相位抖开 (条带从这里来), Seed 换抖动的花样;反射色按命中点自己的 alpha 加权 (透明处没有东西可照),
// 出口只写 RGB —— 反射不重塑形状, alpha 是这个像素自己的 (契约 ②)。
// 两张绑图都必带:主槽深度缺了引擎整条跳过, 副槽法线用 needsMap2.optional=false 声明成必带 ——
// 没有法线就没有反射方向, 静默退化成「拧角度的平镜」只会让用户以为法线绑没绑都一样。

const FX_FS_SSR = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uMap;
uniform sampler2D uNormal;
uniform vec2 uMapU;
uniform vec2 uMapV;
uniform vec2 uMapB;
uniform vec2 uStep;      // 每步在两轴各自的 uv 步长 (方向已折进符号)
uniform float uStepPx;   // 每步走多少层像素
uniform float uRelief;   // 满幅深度折多少层像素高
uniform vec3 uAxis;      // 倾转轴 (画面像素空间, z=0, 单位)
uniform float uTilt;     // 弧度
uniform int uSteps;
uniform float uJitter;   // 0..1: 起步相位抖多少步
uniform int uSeed;
uniform float uMix;
uniform float uFade;
uniform float uNearBright;
// 同 fx/noise.js 的整数散列 —— fp32 的 fract 类散列在这里会塌成可见结构, 不再用。
float ssrH(ivec2 t, int c) {
    uint h = uint(t.x) * 73856093u ^ uint(t.y) * 19349663u ^ uint(c) * 83492791u ^ uint(uSeed) * 2654435761u;
    h = (h ^ (h >> 16u)) * 0x7feb352du;
    h = (h ^ (h >> 15u)) * 0x846ca68bu;
    return float(h >> 8u) * (1.0 / 16777216.0);
}
// 高度场: 近 = 高 (与 fx/warp.js 的 warpHeight 同一条读法), 落点走 fxMapFrame 那条仿射基。
float ssrDepth(vec2 uv) {
    float d = texture(uMap, uMapU * uv.x + uMapV * uv.y + uMapB).r;
    return uNearBright > 0.5 ? d : 1.0 - d;
}
void main() {
    ivec2 tc = ivec2(gl_FragCoord.xy);
    vec4 own = texelFetch(uTex, tc, 0);
    if (uMix <= 0.0) { Frag = own; return; }
    vec2 fr0 = uMapU * vUV.x + uMapV * vUV.y + uMapB;
    float d0 = ssrDepth(vUV);
    // 法线图按画面像素空间解出来: x 右、y 下 (链角度约定), 绿朝上的图把 g 翻一次。
    vec3 raw = texture(uNormal, fr0).xyz * 2.0 - 1.0;
    vec3 n = vec3(raw.x, -raw.y, raw.z);
    // Tilt 绕屏幕内的轴把反射面拧离正面 (绕 −θ 的右手旋转): 平的那张法线也跟着倒,
    // 反射方向因此由「纯法线图」变成「面角度 + 法线扰动」两份的和。
    float ct = cos(uTilt), st = sin(uTilt);
    vec3 nt = normalize(n * ct + cross(uAxis, n) * st + uAxis * dot(uAxis, n) * (1.0 - ct));
    vec3 refl = reflect(vec3(0.0, 0.0, -1.0), nt);
    float rl = length(refl.xy);
    // 直上 (镜面正对视线) 没有可走的反射;背对视线的面什么都照不见。
    if (rl < 1e-4 || refl.z <= 0.0) { Frag = own; return; }
    // 方向在画面像素空间里各向同性, 落到 uv 按两轴各自的像素数除 (同 fx/rgb_split.js 的 rsOffset)。
    vec2 duv = (refl.xy / rl) * uStep;
    float gain = refl.z / rl;                          // 每水平 px 的高度增益
    float rise = gain * uStepPx / max(uRelief, 1.0);   // 每步 ray 在归一高度上爬多少
    float jit = (ssrH(tc, 0) - 0.5) * uJitter;
    float tLo = 0.0, tHi = -1.0;
    for (int k = 1; k <= 32; k++) {
        if (k > uSteps) break;
        float t = float(k) + jit;
        vec2 p = vUV + duv * t;
        if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) break;
        if (ssrDepth(p) >= d0 + rise * t) { tHi = t; break; }
        tLo = t;
    }
    if (tHi < 0.0) { Frag = own; return; }
    // 二分精修: 命中点定在「最后一个未撞」与「第一个撞上」之间, 步进的台阶感从这里磨掉。
    for (int r = 0; r < 4; r++) {
        float tm = (tLo + tHi) * 0.5;
        vec2 p = vUV + duv * tm;
        if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) break;
        if (ssrDepth(p) >= d0 + rise * tm) tHi = tm; else tLo = tm;
    }
    vec4 hit = texture(uTex, vUV + duv * tHi);
    float w = uMix * hit.a * (1.0 - uFade * clamp(tHi / float(uSteps), 0.0, 1.0));
    Frag = vec4(mix(own.rgb, hit.rgb, w), own.a);
}`;

function fxglSSR(col, p, effect, l) {
    if (p.mix <= 0 || p.reach <= 0) return;        // 没有可写的反射 = 画面原样, 不必占用一次 pass
    const gl = fxgl.gl;
    const dst = fxgl.off[1 - col.slot];
    const fr = fxMapFrame(p.align, l);
    const steps = Math.max(2, Math.min(32, p.steps | 0));
    const stepPx = p.reach / steps;
    const rad = p.axis * Math.PI / 180;
    fxglRunPass(dst, fxgl.progs.ssr, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uMap', fxgl.texMap, 1);
        fxglBindTex(pr, 'uNormal', fxgl.texMap2, 2);
        gl.uniform2f(fxglU(pr, 'uMapU'), fr.u[0], fr.u[1]);
        gl.uniform2f(fxglU(pr, 'uMapV'), fr.v[0], fr.v[1]);
        gl.uniform2f(fxglU(pr, 'uMapB'), fr.b[0], fr.b[1]);
        // 每步的 uv 步长按两轴各自的像素数除;v 朝上, 画面 y 分量的符号折在这里 —— 折完着色器里
        // 全程按画面像素空间想事 (同 fx/rgb_split.js 的 rsOffset)。
        gl.uniform2f(fxglU(pr, 'uStep'), stepPx / fxgl.w, -stepPx / fxgl.h);
        gl.uniform1f(fxglU(pr, 'uStepPx'), stepPx);
        gl.uniform1f(fxglU(pr, 'uRelief'), Math.max(1, p.relief));
        gl.uniform3f(fxglU(pr, 'uAxis'), Math.cos(rad), Math.sin(rad), 0.0);
        gl.uniform1f(fxglU(pr, 'uTilt'), p.tilt * Math.PI / 180);
        gl.uniform1i(fxglU(pr, 'uSteps'), steps);
        gl.uniform1f(fxglU(pr, 'uJitter'), p.jitter / 100);
        gl.uniform1i(fxglU(pr, 'uSeed'), p.seed | 0);
        gl.uniform1f(fxglU(pr, 'uMix'), p.mix / 100);
        gl.uniform1f(fxglU(pr, 'uFade'), p.fade / 100);
        gl.uniform1f(fxglU(pr, 'uNearBright'), p.near === 'bright' ? 1 : 0);
    });
    col.slot = 1 - col.slot;
}

const SSR_PARAMS = [
    { key: 'map', kind: 'map', def: null },
    { key: 'near', label: 'Near', kind: 'enum', options: ['dark', 'bright'], def: 'dark',
        tip: 'Which end of the depth map stands tall \u2014 the heightfield the depth test marches over.' },
    { key: 'align', label: 'Align', kind: 'enum', options: ['Canvas', 'Local'], def: 'Canvas' },
    { key: 'normal', kind: 'map', def: null },
    { key: 'tilt', label: 'Tilt', min: 0, max: 80, step: 1, def: 40, unit: '\u00b0',
        tip: 'Tilts the whole mirror off the viewer around the Axis hinge \u2014 past 45\u00b0 a flat normal map reflects nothing (the mirror faces away).' },
    { key: 'axis', label: 'Axis', min: 0, max: 359, step: 1, def: 0, unit: '\u00b0',
        tip: 'The hinge the tilt rotates around (0\u00b0 = right, 90\u00b0 = down). Axis 0\u00b0 with positive Tilt is a floor leaning away \u2014 reflections reach upward.' },
    { key: 'reach', label: 'Reach', min: 8, max: 512, step: 1, def: 160, unit: 'px',
        tip: 'How far the reflected ray searches before giving up \u2014 nothing hit means nothing reflected.' },
    { key: 'steps', label: 'Steps', min: 2, max: 32, step: 1, def: 12,
        tip: 'Ray-march quality plus 4 bisection refinements on every hit. Taps per pixel: Steps depth samples.' },
    { key: 'relief', label: 'Relief', min: 1, max: 256, step: 1, def: 96, unit: 'px',
        tip: 'How tall the full depth range stands in layer pixels \u2014 the depth-test strength.' },
    { key: 'jitter', label: 'Jitter', min: 0, max: 100, step: 1, def: 75, unit: '%',
        tip: 'Scatters each ray\u2019s start phase by up to one step \u2014 trades banding for grain. Deterministic per pixel; Seed picks the pattern.' },
    { key: 'seed', label: 'Seed', min: 0, max: 999, step: 1, def: 0 },
    { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, def: 100, unit: '%' },
    { key: 'fade', label: 'Fade', min: 0, max: 100, step: 1, def: 40, unit: '%',
        tip: 'Distant hits come back dimmer \u2014 tames the grazing smear a near-horizontal ray leaves on flat ground.' },
];

defineEffect({
    type: 'ssr',
    label: 'Reflection',
    group: 'Reflect',
    icon: 'reflect',
    needsMap: 'Depth',
    needsMap2: { key: 'normal', role: 'Normal', optional: false },
    desc: 'Screen-space reflections: the bound depth map becomes a relief the reflected ray marches over, and the bound normal map steers the ray \u2014 reflect the straight-down view off the surface normal (green-up convention), then walk the grid in that direction until the relief rises above the ray (that is the depth test: whatever stands in front clips the reflection) or Reach runs out (nothing hit, nothing reflected). Tilt/Axis tip the whole mirror off the viewer around a screen hinge \u2014 Axis 0\u00b0 with positive Tilt is a floor leaning away and reflections reach upward; a flat normal map stops reflecting past 45\u00b0 because the mirror then faces away. Steps set the march quality (every hit is refined by 4 bisections), Relief is the depth-test strength (full depth range as layer pixels), Jitter scatters ray starts to break the banding into grain (Seed picks the pattern), Fade dims distant hits. Reflections can only come from the layer\u2019s own pixels, weighted by the hit\u2019s own alpha; colour only \u2014 alpha is this pixel\u2019s own.',
    params: SSR_PARAMS,
    shaders: { ssr: FX_FS_SSR },
    run: fxglSSR,
    // Canvas 对齐的两张图都读「该层盒子落在画布哪儿」, 拖图层不改像素也不改 params —— 同
    // fx/chromatic_aberration.js 与 fx/volumetric_fog.js, 靠 stamp 把这份外部状态报进缓存身份。
    stamp(effect, l) {
        const p = effectParams(effect);
        if (p.align !== 'Canvas') return '';
        return fxMapBoxStamp(l);
    },
    readout(p, n, effect) {
        let s = `${fxMapShort(effect)} + ${fxMapShort(effect, 'normal')}  ${p.align === 'Local' ? 'local' : 'canvas'}`
            + `  ${n(p.tilt)}\u00b0@${n(p.axis)}\u00b0  r${n(p.reach)}px  s${p.steps | 0}  rel${n(p.relief)}`;
        if (p.near === 'bright') s += '  inv';
        if (p.mix < 100) s += `  m${n(p.mix)}`;
        if (p.fade < 100) s += `  f${n(p.fade)}`;
        if (!p.jitter) s += '  nojit';
        return s;
    },
    thumb(g, box) {
        // 一面斜的地板把立在它后面的一根柱子照出来:柱子是直的, 影在地板里却顺着反射方向倒过去 ——
        // 屏幕空间反射读出来的就是「内容顺着反射方向在深度浮雕上找落点」。
        const x = box.x, y = box.y, w = box.w, h = box.h;
        g.fillStyle = '#2c64b8';
        g.beginPath();
        g.moveTo(x, y + h * 0.55);
        g.lineTo(x + w, y + h * 0.30);
        g.lineTo(x + w, y + h);
        g.lineTo(x, y + h);
        g.closePath();
        g.fill();
        g.fillStyle = '#e8e4da';
        g.fillRect(x + w * 0.30, y + h * 0.08, w * 0.14, h * 0.34);   // 柱子本体
        g.save();
        g.beginPath();
        g.moveTo(x, y + h * 0.55);
        g.lineTo(x + w, y + h * 0.30);
        g.lineTo(x + w, y + h);
        g.lineTo(x, y + h);
        g.closePath();
        g.clip();
        g.fillStyle = 'rgba(150,190,240,0.75)';
        g.fillRect(x + w * 0.44, y + h * 0.34, w * 0.14, h * 0.60);   // 顺着反射方向倒过去的影
        g.restore();
    },
});
