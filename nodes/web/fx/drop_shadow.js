// fx/drop_shadow.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图。
// 契约依据见 fx/core.js 顶部;它能借用哪些缓冲见 fx/gl.js 顶部。

// 外阴影:把**图层自己的** alpha 沿角度移开并虚化,再作为一层暗底 source-over 垫在本色之下。
// 这里 alpha 会长到形状之外 —— 被允许的是"同一张网格里本来透明的像素变不透明",输出尺寸一个字
// 没变 (契约 ①),所以影子一旦越过图层框边就被切掉,不像 PS 那样能无限往外拖。
// 轮廓故意**不乘蒙版**:蒙版在链外还要整体乘一次,这里吃过一遍就成了平方 (软蒙版边上的影子会
// 提前发黑),而"影子只出现在蒙版内"本来就是那次乘法的结果 (契约 ③)。
const FX_FS_DROPSHADOW = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uSil;
uniform vec2 uOffset;
uniform vec3 uColor;
uniform float uOpacity;
void main() {
    vec4 c = texture(uTex, vUV);
    // 与内阴影同一个取样式 (vUV + uOffset) ⇒ 同一个角度读法:130° = 影子落在左下。
    float s = clamp(texture(uSil, vUV + uOffset).a * uOpacity, 0.0, 1.0);
    float a = c.a + s * (1.0 - c.a);
    // 直通色下的 source-over:本色在上,影子在下,最后再除回新的 alpha。
    vec3 rgb = (c.rgb * c.a + uColor * s * (1.0 - c.a)) / max(a, 1e-4);
    Frag = vec4(clamp(rgb, 0.0, 1.0), clamp(a, 0.0, 1.0));
}`;

function fxglDropShadow(col, p) {
    if (p.opacity <= 0) return;
    const gl = fxgl.gl;
    // 2 号面重算一遍形状 (uHasMask 恒 0),3/4 号接 fxglSilGauss 的两趟低通 —— 三个借用面每趟
    // 都重写,所以和同链里的内阴影/景深/泛光互不污染。
    fxglRunPass(fxgl.off[2], fxgl.progs.sil, pr => {
        fxglBindTex(pr, 'uSrc', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uMask', fxgl.texMask, 1);
        gl.uniform1i(fxglU(pr, 'uHasMask'), 0);
    });
    fxglSilGauss(p.radius);
    const d = fxglDirUV(p.angle, p.distance);
    const dst = fxgl.off[1 - col.slot];
    fxglRunPass(dst, fxgl.progs.dropShadow, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uSil', fxgl.off[4].tex, 1);
        gl.uniform2f(fxglU(pr, 'uOffset'), d.x / fxgl.w, d.y / fxgl.h);
        gl.uniform3f(fxglU(pr, 'uColor'), ...fxHexToRgb01(p.color));
        gl.uniform1f(fxglU(pr, 'uOpacity'), p.opacity / 100);
    });
    col.slot = 1 - col.slot;
}

defineEffect({
    type: 'drop_shadow',
    label: 'Drop Shadow',
    group: 'Shadow',
    icon: 'drop',
    desc: 'The layer\u2019s own opacity, offset along the angle and blurred, laid under the picture as a shade \u2014 the shadow grows the layer\u2019s alpha into pixels that were transparent, so it stays inside the layer box and inside the mask (which is still multiplied once, at the end).',
    params: [
        { key: 'angle', label: 'Angle', min: 0, max: 359, step: 1, def: 130, unit: '°' },
        { key: 'distance', label: 'Dist', min: 0, max: 256, step: 1, def: 12, unit: 'px' },
        { key: 'radius', label: 'Size', min: 0, max: 128, step: 1, def: 16, unit: 'px' },
        { key: 'opacity', label: 'Opac', min: 0, max: 100, step: 1, def: 64, unit: '%' },
        { key: 'color', label: 'Color', kind: 'color', def: '#000000' },
    ],
    shaders: { dropShadow: FX_FS_DROPSHADOW },
    run: fxglDropShadow,
    readout(p, n) {
        return `${n(p.angle)}°  d${n(p.distance)}  sz${n(p.radius)}  ${n(p.opacity)}%  ${p.color}`;
    },
    thumb(g, box) {
        // 同一块方砖,影子落在左下 (130° 的角度读法与内阴影一致)。
        const sx = box.x + 10, sy = box.y, sw = box.w - 14, sh = box.h - 10;
        g.save();
        g.filter = 'blur(4px)';
        g.fillStyle = 'rgba(0,0,0,0.8)';
        g.fillRect(sx - 10, sy + 10, sw, sh);
        g.restore();
        g.fillStyle = '#6f8cff';
        g.fillRect(sx, sy, sw, sh);
    },
});
