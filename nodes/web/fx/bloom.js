// fx/bloom.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图。
// 两档低通借的是引擎的公共借用区 (见 fx/gl.js 顶部),一张新纹理都不加。

// 泛光分三步:①亮部提取 —— 只把亮度超过 Threshold 的部分留下,而且**亮度写进 alpha**、颜色原样
// 留在 rgb。这不是随手:FX_FS_BOX 的加权平均按 alpha 预乘再除回,所以 alpha 当权重用正好让亮暗
// 两半在扩散时自动归一,不需要第三个面。②两档低通 —— 对亮部糊一次得紧挨着的光晕,再对这个结果
// 糊一次(半径翻倍)得外围的大光晕:两档是串联的金字塔,所以 5 张缓冲里只要 off[2] 当场腾出来
// 就能过,而单档大半径 Kawase 只剩一团雾,叠两档才有「光自己散开」的层次。
// ③合成 —— 发光加回图层,screen 或 add。只加光不动 alpha:出口那趟 present 会预乘,所以加在
// 图层之外的光本来就落不进画面,发光的边界天然就是图层自己的边界,蒙版对齐不受影响。
const FX_FS_BLOOM_KEY = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform float uThresh;
void main() {
    vec4 c = texture(uTex, vUV);
    float luma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    // 门槛处用 smoothstep 起软膝:线性硬切会在亮部边缘留一圈可见的等值线。
    float t = clamp((luma - uThresh) / max(1.0 - uThresh, 1e-3), 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    Frag = vec4(c.rgb, t);
}`;

const FX_FS_BLOOM_MIX = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uGlow;
uniform sampler2D uHalo;
uniform vec3 uTint;
uniform float uIntensity;
uniform float uHaloMix;
uniform float uScreen;
void main() {
    vec4 c = texture(uTex, vUV);
    vec4 g = texture(uGlow, vUV);
    vec4 h = texture(uHalo, vUV);
    // 两档各自带着扩散后的权重(alpha),加权合起来再乘强度与色偏。
    vec3 glow = mix(g.rgb * g.a, h.rgb * h.a, uHaloMix) * uIntensity * uTint;
    vec3 lit = uScreen > 0.5 ? c.rgb + glow - c.rgb * glow : c.rgb + glow;
    Frag = vec4(clamp(lit, 0.0, 1.0), c.a);
}`;

function fxglBloom(col, p) {
    const gl = fxgl.gl;
    if (p.intensity <= 0) return;
    const free = 1 - col.slot;
    const key = fxgl.off[2];
    const glow = fxgl.off[3];
    // 亮部 → off[2];紧档 off[3](scratch 用 off[4]);远档再糊一遍、就地回收 off[2] 当目标,
    // 因为亮部到这一步已经读完。色彩乒乓的两半留到最后:图层本色 + 一个可写的 dst。
    fxglRunPass(key, fxgl.progs.bloomKey, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        gl.uniform1f(fxglU(pr, 'uThresh'), p.threshold / 100);
    });
    fxglGauss(glow, key.tex, fxgl.off[4], p.radius);
    fxglGauss(key, glow.tex, fxgl.off[4], 2 * p.radius);
    fxglRunPass(fxgl.off[free], fxgl.progs.bloomMix, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uGlow', glow.tex, 1);
        fxglBindTex(pr, 'uHalo', key.tex, 2);
        gl.uniform3f(fxglU(pr, 'uTint'), ...fxHexToRgb01(p.color));
        gl.uniform1f(fxglU(pr, 'uIntensity'), p.intensity / 100);
        gl.uniform1f(fxglU(pr, 'uHaloMix'), p.halo / 100);
        gl.uniform1f(fxglU(pr, 'uScreen'), p.mode === 'add' ? 0 : 1);
    });
    col.slot = free;
}

defineEffect({
    type: 'bloom',
    label: 'Bloom',
    group: 'Light',
    icon: 'bloom',
    desc: 'A bright-pass extraction lifted through two blur tiers \u2014 a tight glow around the hot pixels and a wider halo, mixed by Halo. Light is added back inside the layer\u2019s own opacity, so nothing spills past its edge or the mask.',
    params: [
        { key: 'threshold', label: 'Thresh', min: 0, max: 100, step: 1, def: 60, unit: '%' },
        { key: 'radius', label: 'Glow', min: 1, max: 96, step: 1, def: 16, unit: 'px' },
        { key: 'halo', label: 'Halo', min: 0, max: 100, step: 1, def: 40, unit: '%' },
        { key: 'intensity', label: 'Gain', min: 0, max: 200, step: 1, def: 70, unit: '%' },
        { key: 'color', label: 'Tint', kind: 'color', def: '#ffffff' },
        { key: 'mode', label: 'Mode', kind: 'enum', options: ['screen', 'add'], def: 'screen' },
    ],
    shaders: { bloomKey: FX_FS_BLOOM_KEY, bloomMix: FX_FS_BLOOM_MIX },
    run: fxglBloom,
    readout(p, n) {
        return `t${n(p.threshold)}  g${n(p.radius)}  h${n(p.halo)}  +${n(p.intensity)}  ${p.mode === 'add' ? 'add' : 'scr'}`;
    },
    thumb(g, box) {
        const cx = box.x + box.w / 2, cy = box.y + box.h / 2, r = Math.min(box.w, box.h) / 2;
        const halo = g.createRadialGradient(cx, cy, r * 0.1, cx, cy, r * 1.35);
        halo.addColorStop(0, 'rgba(160,190,255,0.85)');
        halo.addColorStop(0.35, 'rgba(111,140,255,0.35)');
        halo.addColorStop(1, 'rgba(111,140,255,0)');
        g.fillStyle = halo;
        g.fillRect(box.x - 8, box.y - 8, box.w + 16, box.h + 16);
        const core = g.createRadialGradient(cx, cy, 0, cx, cy, r * 0.42);
        core.addColorStop(0, '#ffffff');
        core.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = core;
        g.beginPath();
        g.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
        g.fill();
    },
});
