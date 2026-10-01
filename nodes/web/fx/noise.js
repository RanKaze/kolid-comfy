// fx/noise.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图 (Noise 组)。
// 杂色 = PS「添加杂色」那一个滤镜:往每个像素自己的颜色上叠一份随机偏移。三条参数照 PS 读法:
// Amount 是偏移的满幅,Distribution 选偏移值怎么分布 —— Uniform 每个值机会均等、Gaussian 往
// 0 挤 (Box-Muller,截到 ±2.5σ 再摆回 ±1),Monochromatic 是「一份噪声三通道同加」还是
// 「每通道各掷各的」(彩噪 = 三颗独立的数,黑白噪 = 一颗)。Seed 换的是掷骰子的起点:着色器里
// 的噪声按像素位置确定性生成 (缓存身份认得出、undo 拉得回),所以"再来一版"不靠重掷,靠转 Seed。
// 三条契约的落点:① 不外扩;② 只写 RGB、alpha 原样 —— 杂色不重塑形状 (隔壁 corrosion 才动 alpha);
// ③ 不读蒙版。透明像素的 rgb 同样被加偏移,但 alpha=0 的地方落不出可见结果,无须特判。

const NS_DISTS = ['Uniform', 'Gaussian'];
const NS_MONO = ['Colour', 'Mono'];

const FX_FS_NOISE = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform float uAmount;
uniform int uSeed;
uniform int uDist;
uniform int uMono;
// 整数 PCG 式散列:输入是像素格点 + 通道盐 + Seed,取高 24 位摆回 0..1。别用 fract 类浮点散列
// —— 它的乘积在大数上 fract 只剩十来位尾数 (fp32),偏移场会塌成肉眼可见的结构 (本文件初版
// 栽过:纹样整片偏斜、灰面被单向压暗),整数散列没有这份病。
float nsH(ivec2 t, int c) {
    uint h = uint(t.x) * 73856093u ^ uint(t.y) * 19349663u ^ uint(c) * 83492791u ^ uint(uSeed) * 2654435761u;
    h = (h ^ (h >> 16u)) * 0x7feb352du;
    h = (h ^ (h >> 15u)) * 0x846ca68bu;
    return float(h >> 8u) * (1.0 / 16777216.0);
}
float nsUni(ivec2 t, int c) { return nsH(t, c) * 2.0 - 1.0; }
// Box-Muller:一对均匀数换一颗正态 (log 侧要防 0),除 2.5σ 后截回 ±1 —— 尾巴剪掉一点,
// 换来 Amount=100% 时和其他档一样不出界。
float nsGauss(ivec2 t, int c) {
    float u = max(nsH(t, c * 2), 1.0 / 16777216.0);
    float v = nsH(t, c * 2 + 1);
    return clamp(sqrt(-2.0 * log(u)) * cos(6.2831853 * v) / 2.5, -1.0, 1.0);
}
void main() {
    ivec2 tc = ivec2(gl_FragCoord.xy);
    vec4 c = texelFetch(uTex, tc, 0);
    if (uAmount <= 0.0) { Frag = c; return; }
    float n0 = uDist == 1 ? nsGauss(tc, 0) : nsUni(tc, 0);
    vec3 n = uMono == 1 ? vec3(n0)
        : vec3(n0,
               uDist == 1 ? nsGauss(tc, 1) : nsUni(tc, 1),
               uDist == 1 ? nsGauss(tc, 2) : nsUni(tc, 2));
    Frag = vec4(clamp(c.rgb + n * uAmount, 0.0, 1.0), c.a);
}`;

function fxglNoise(col, p) {
    if (p.amount <= 0) return;                    // 没有偏移 = 画面原样, 不必占用一次 pass
    const gl = fxgl.gl;
    const dst = fxgl.off[1 - col.slot];
    fxglRunPass(dst, fxgl.progs.noise, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        gl.uniform1f(fxglU(pr, 'uAmount'), p.amount / 100);
        gl.uniform1i(fxglU(pr, 'uSeed'), p.seed | 0);
        gl.uniform1i(fxglU(pr, 'uDist'), p.dist === 'Gaussian' ? 1 : 0);
        gl.uniform1i(fxglU(pr, 'uMono'), p.mono === 'Mono' ? 1 : 0);
    });
    col.slot = 1 - col.slot;
}

const NS_PARAMS = [
    { key: 'amount', label: 'Amount', min: 0, max: 100, step: 1, def: 5, unit: '%' },
    { key: 'dist', label: 'Distribution', kind: 'enum', options: NS_DISTS, def: 'Uniform',
        tip: 'Uniform draws every offset with equal odds; Gaussian crowds them around 0 \u2014 a finer grain at the same Amount.' },
    { key: 'mono', label: 'Monochromatic', kind: 'enum', options: NS_MONO, def: 'Colour',
        tip: 'Colour throws the three channels separately (colour speckle); Mono adds one shared value (grey grain).' },
    { key: 'seed', label: 'Seed', min: 0, max: 999, step: 1, def: 0,
        tip: 'The grain is deterministic per pixel, so a new pattern means turning the seed \u2014 not re-rolling.' },
];

defineEffect({
    type: 'noise',
    label: 'Noise',
    group: 'Noise',
    icon: 'noise',
    desc: 'Photoshop\u2019s Add Noise: a random offset on each pixel\u2019s own colour, scaled by Amount. Distribution picks the odds \u2014 Uniform draws every offset with equal probability, Gaussian crowds them around zero so the same Amount reads as a finer grain. Monochromatic adds one shared value to all three channels (grey grain) instead of three independent ones (colour speckle). The grain is generated deterministically per pixel, so the pattern survives cache and undo; Seed starts the dice somewhere else. Colour only: alpha is this pixel\u2019s own, so noise never reshapes the layer\u2019s outline.',
    params: NS_PARAMS,
    shaders: { noise: FX_FS_NOISE },
    run: fxglNoise,
    readout(p, n) {
        return `${p.dist.toLowerCase()}  ${n(p.amount)}%  ${p.mono.toLowerCase()}  s${p.seed | 0}`;
    },
    thumb(g, box) {
        // 一块由暗到亮的底,上面撒大小不一的杂粒:杂色读出来的就是「底子上哪儿都有的随机偏移」。
        const lerp = (a, b, k) => Math.round(a + (b - a) * k);
        for (let y = box.y; y < box.y + box.h; y += 2) {
            const t = (y - box.y) / box.h;
            g.fillStyle = `rgb(${lerp(0x2a, 0x8a, t)},${lerp(0x2a, 0xa4, t)},${lerp(0x30, 0xd6, t)})`;
            g.fillRect(box.x, y, box.w, 2);
        }
        // 固定一颗种子撒粒 (缩略图自己也要确定):逐行扫出的伪随机即可,不必真 hash。
        let s = 7;
        const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        for (let i = 0; i < 90; i++) {
            const px = box.x + rnd() * box.w, py = box.y + rnd() * box.h;
            const r = 0.5 + rnd() * 0.9;
            g.fillStyle = rnd() < 0.5
                ? `rgba(255,255,255,${(0.35 + rnd() * 0.55).toFixed(2)})`
                : `rgba(0,0,0,${(0.3 + rnd() * 0.5).toFixed(2)})`;
            g.beginPath();
            g.arc(px, py, r, 0, Math.PI * 2);
            g.fill();
        }
    },
});
