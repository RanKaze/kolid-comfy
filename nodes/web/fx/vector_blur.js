// fx/vector_blur.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图。

// 抽样数上限 = 着色器里那个常数次循环的界,只有本特效吃它,所以跟着特效走而不是待在引擎里。
const FX_MOTION_MAX_TAPS = 32;

// 方向模糊:沿 uStep 做 uTaps 次等权抽样。uTrail=0 抽样 centered 在像素两侧,-1 只往反方向拖。
// alpha 与其他通道一起被平均 —— 不透明度沿拖拽方向同样被拖开。
const FX_FS_MOTION = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform vec2 uStep;
uniform int uTaps;
uniform float uTrail;
void main() {
    vec3 acc = vec3(0.0);
    float aAcc = 0.0;
    for (int i = 0; i < ${FX_MOTION_MAX_TAPS}; i++) {
        if (i >= uTaps) break;
        float t = (float(i) + 0.5) / float(uTaps);
        vec2 off = uStep * mix(t - 0.5, t * 0.5, uTrail);
        vec4 c = texture(uTex, vUV + off);
        acc += c.rgb * c.a;
        aAcc += c.a;
    }
    Frag = vec4(clamp(acc / max(aAcc, 1e-5), 0.0, 1.0), clamp(aAcc / max(float(uTaps), 1.0), 0.0, 1.0));
}`;

function fxglMotion(col, p) {
    if (p.distance <= 0) return;
    const gl = fxgl.gl;
    const d = fxglDirUV(p.angle, p.distance);
    const dst = fxgl.off[1 - col.slot];
    const taps = Math.max(2, Math.min(FX_MOTION_MAX_TAPS, Math.round(p.distance / 2)));
    fxglRunPass(dst, fxgl.progs.motion, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        gl.uniform2f(fxglU(pr, 'uStep'), d.x / fxgl.w, d.y / fxgl.h);
        gl.uniform1i(fxglU(pr, 'uTaps'), taps);
        gl.uniform1f(fxglU(pr, 'uTrail'), p.anchor === 'trailing' ? 1 : 0);
    });
    col.slot = 1 - col.slot;
}

defineEffect({
    type: 'vector_blur',
    label: 'Vector Blur',
    group: 'Blur',
    icon: 'motion',
    desc: 'Directional smear along the angle (fixed-length tap streak). Anchor center splits the streak on both sides of each pixel; trailing drags it backwards only.',
    params: [
        { key: 'angle', label: 'Angle', min: 0, max: 359, step: 1, def: 0, unit: '°' },
        { key: 'distance', label: 'Dist', min: 1, max: 256, step: 1, def: 24, unit: 'px' },
        { key: 'anchor', label: 'Anchor', kind: 'enum', options: ['center', 'trailing'], def: 'center' },
    ],
    shaders: { motion: FX_FS_MOTION },
    run: fxglMotion,
    readout(p, n) {
        return `${n(p.angle)}°  d${n(p.distance)}  ${p.anchor === 'trailing' ? 'trail' : 'center'}`;
    },
    thumb(g, box) {
        for (let i = 0; i < 7; i++) {
            g.globalAlpha = 0.1 + i * 0.13;
            g.fillStyle = '#6f8cff';
            g.fillRect(box.x - 7 + i * 2.4, box.y - 3 + i * 1.1, box.w, box.h);
        }
        g.globalAlpha = 1;
    },
});
