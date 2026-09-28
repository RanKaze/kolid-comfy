// fx/curves.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图。

// 色彩曲线:输入黑/白点拉伸 → 中间调 gamma → S 形对比量 → 输出黑/白场,全在**已编码的显示值**上做,
// 和 PS 的 curves 同一坐标架。前三步都把 0 和 1 钉在原地,所以纯色(尤其落在极值的文字)只有靠
// 输出场才挪得动。uSel 决定哪些通道吃这条曲线,没选中的通道原样通过;alpha 永不参与。
const FX_FS_CURVES = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform vec3 uSel;
uniform float uBlack;
uniform float uWhite;
uniform float uInvGamma;
uniform float uContrast;
uniform float uOutBlack;
uniform float uOutWhite;
void main() {
    vec4 c = texture(uTex, vUV);
    vec3 v = clamp((c.rgb - uBlack) / max(uWhite - uBlack, 1e-4), 0.0, 1.0);
    v = pow(v, vec3(uInvGamma));
    v = uContrast >= 0.0 ? mix(v, v * v * (3.0 - 2.0 * v), uContrast) : mix(v, vec3(0.5), -uContrast);
    v = clamp(uOutBlack + v * (uOutWhite - uOutBlack), 0.0, 1.0);
    Frag = vec4(mix(c.rgb, v, uSel), c.a);
}`;

const FX_CHANNEL_SEL = { rgb: [1, 1, 1], r: [1, 0, 0], g: [0, 1, 0], b: [0, 0, 1] };

// 默认参数就是恒等映射,这种曲线不必占用一次 pass。
function curvesAreIdentity(p) {
    return p.black === 0 && p.white === 100 && Math.abs(p.gamma - 1) < 1e-3 && p.contrast === 0
        && p.outBlack === 0 && p.outWhite === 100;
}

function fxglCurves(col, p) {
    if (curvesAreIdentity(p)) return;
    const gl = fxgl.gl;
    const sel = FX_CHANNEL_SEL[p.channel] || FX_CHANNEL_SEL.rgb;
    const dst = fxgl.off[1 - col.slot];
    fxglRunPass(dst, fxgl.progs.curves, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        gl.uniform3f(fxglU(pr, 'uSel'), sel[0], sel[1], sel[2]);
        gl.uniform1f(fxglU(pr, 'uBlack'), p.black / 100);
        gl.uniform1f(fxglU(pr, 'uWhite'), p.white / 100);
        gl.uniform1f(fxglU(pr, 'uInvGamma'), 1 / Math.max(0.05, p.gamma));
        gl.uniform1f(fxglU(pr, 'uContrast'), p.contrast / 100);
        gl.uniform1f(fxglU(pr, 'uOutBlack'), p.outBlack / 100);
        gl.uniform1f(fxglU(pr, 'uOutWhite'), p.outWhite / 100);
    });
    col.slot = 1 - col.slot;
}

defineEffect({
    type: 'curves',
    label: 'Curves',
    group: 'Color',
    icon: 'curve',
    desc: 'A display-referred tone curve on the selected channel(s): input black/white points, a midtone gamma, an S-curve amount and output black/white levels. The input points and the curve below fix 0 and 1 in place, so a flat colour pinned at an extreme only starts to move once the output levels shift. Pure remap \u2014 nothing moves, nothing blurs, alpha untouched.',
    params: [
        { key: 'channel', label: 'Channel', kind: 'enum', options: ['rgb', 'r', 'g', 'b'], def: 'rgb' },
        { key: 'black', label: 'In Black', min: 0, max: 50, step: 1, def: 0, unit: '%' },
        { key: 'white', label: 'In White', min: 50, max: 100, step: 1, def: 100, unit: '%' },
        { key: 'gamma', label: 'Mid', min: 0.2, max: 3, step: 0.05, def: 1, unit: '×' },
        { key: 'contrast', label: 'S-Curve', min: -100, max: 100, step: 1, def: 0, unit: '%' },
        { key: 'outBlack', label: 'Out Black', min: 0, max: 100, step: 1, def: 0, unit: '%' },
        { key: 'outWhite', label: 'Out White', min: 0, max: 100, step: 1, def: 100, unit: '%' },
    ],
    shaders: { curves: FX_FS_CURVES },
    run: fxglCurves,
    readout(p, n) {
        const s = p.contrast < 0 ? `S${n(p.contrast)}` : `S+${n(p.contrast)}`;
        const o = (p.outBlack === 0 && p.outWhite === 100) ? '' : `  \u2192 ob${n(p.outBlack)}-ow${n(p.outWhite)}`;
        return `${String(p.channel).toUpperCase()}  b${n(p.black)}-w${n(p.white)}  ${n(p.gamma)}×  ${s}${o}`;
    },
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
