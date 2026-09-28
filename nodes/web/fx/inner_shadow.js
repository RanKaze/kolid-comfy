// fx/inner_shadow.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图。
// 契约依据见 fx/core.js 顶部;它能借用哪些缓冲见 fx/gl.js 顶部。

// 内阴影:把虚化后的 silhouette 沿 uOffset 移开,原地留下的空缺 (1 - shifted) 再被**未虚化**的
// 自身轮廓裁住 —— 这两步的顺序就是「只在边缘内侧、永不出蒙版」的实现。
const FX_FS_SHADOW = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uSilRaw;
uniform sampler2D uSilBlur;
uniform vec2 uOffset;
uniform vec3 uColor;
uniform float uOpacity;
void main() {
    vec4 c = texture(uTex, vUV);
    float raw = texture(uSilRaw, vUV).a;
    float shifted = texture(uSilBlur, vUV + uOffset).a;
    float cov = clamp(1.0 - shifted, 0.0, 1.0) * raw * uOpacity;
    Frag = vec4(mix(c.rgb, uColor, cov), c.a);
}`;

function fxglInnerShadow(col, p) {
    const gl = fxgl.gl;
    fxglRunPass(fxgl.off[2], fxgl.progs.sil, pr => {
        fxglBindTex(pr, 'uSrc', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uMask', fxgl.texMask, 1);
        gl.uniform1i(fxglU(pr, 'uHasMask'), fxgl.hasMask);
    });
    fxglSilGauss(p.radius);
    const d = fxglDirUV(p.angle, p.distance);
    const rgb = fxHexToRgb01(p.color);
    const dst = fxgl.off[1 - col.slot];
    fxglRunPass(dst, fxgl.progs.shadow, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uSilRaw', fxgl.off[2].tex, 1);
        fxglBindTex(pr, 'uSilBlur', fxgl.off[4].tex, 2);
        gl.uniform2f(fxglU(pr, 'uOffset'), d.x / fxgl.w, d.y / fxgl.h);
        gl.uniform3f(fxglU(pr, 'uColor'), rgb[0], rgb[1], rgb[2]);
        gl.uniform1f(fxglU(pr, 'uOpacity'), p.opacity / 100);
    });
    col.slot = 1 - col.slot;
}

defineEffect({
    type: 'inner_shadow',
    label: 'Inner Shadow',
    group: 'Shadow',
    icon: 'shadow',
    desc: 'Offsets the layer\u2019s silhouette (mask included) along the angle, blurs it and clips it back inside the silhouette \u2014 a shade that lands only on the inner edge. Never grows the picture, so it can never escape the mask.',
    params: [
        { key: 'angle', label: 'Angle', min: 0, max: 359, step: 1, def: 135, unit: '°' },
        { key: 'distance', label: 'Dist', min: 0, max: 128, step: 1, def: 8, unit: 'px' },
        { key: 'radius', label: 'Soft', min: 0, max: 96, step: 1, def: 12, unit: 'px' },
        { key: 'opacity', label: 'Opac', min: 0, max: 100, step: 1, def: 45, unit: '%' },
        { key: 'color', label: 'Color', kind: 'color', def: '#000000' },
    ],
    shaders: { shadow: FX_FS_SHADOW },
    run: fxglInnerShadow,
    readout(p, n) {
        return `${n(p.angle)}°  d${n(p.distance)}  r${n(p.radius)}  ${n(p.opacity)}%  ${p.color}`;
    },
    thumb(g, box) {
        g.fillStyle = '#6f8cff';
        g.fillRect(box.x, box.y, box.w, box.h);
        g.save();
        g.beginPath();
        g.rect(box.x, box.y, box.w, box.h);
        g.clip();
        // 135°(画布坐标:0° 向右、90° 向下)的偏移朝**左下**,而内阴影落在偏移所指的那一侧内缘,
        // 所以阴影压着左下、右上留白。
        const grad = g.createLinearGradient(box.x, box.y + box.h, box.x + box.w, box.y);
        grad.addColorStop(0, 'rgba(0,0,0,0.7)');
        grad.addColorStop(0.45, 'rgba(0,0,0,0.12)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        g.fillRect(box.x, box.y, box.w, box.h);
        g.restore();
    },
});
