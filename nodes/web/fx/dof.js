// fx/dof.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图。
// 它绑一张深度图 (needsMap),引用的解析规则见 fx/maps.js。

// 景深:半径不是全图一个值,而是逐像素从深度图算 —— |d - Focal| 先扣掉半幅 Thick 的合焦带,
// 剩余量线性推到 Iris 上限。三档预糊(iris/3、2·iris/3、iris)已经躺在 off[2..4] 里,这一趟按
// 本像素的半径在「原图 + 三档」这四个 stop 上选相邻两档线性混合,所以档位之间不会跳出硬边。
// 深度只取 R 通道(PS 的 Lens Blur 读的就是 Red 通道,单通道深度图三通道相同)。模糊类契约:
// alpha 与 RGB 一起混档 —— 三档低通里躺的就是各自滤过的不透明度,糊开的边不透明度也跟着软。
const FX_FS_DOF = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uSharp;
uniform sampler2D uL0;
uniform sampler2D uL1;
uniform sampler2D uL2;
uniform sampler2D uMap;
uniform float uFocus;
uniform float uThick;
uniform float uInv;
void main() {
    float d = texture(uMap, vUV).r;
    d = uInv > 0.5 ? 1.0 - d : d;
    float band = uThick * 0.5;
    // t 就是「本像素该糊到第几档」:合焦带内为 0,带外线性推到 3(= 最糊那一档)。Iris 只体现在
    // 三档各自的半径上(JS 侧),所以这里不需要绝对半径。
    float t = clamp(abs(d - uFocus) / max(1.0 - band, 1e-3), 0.0, 1.0) * 3.0;
    vec4 lo;
    vec4 hi;
    if (t < 1.0) { lo = texture(uSharp, vUV); hi = texture(uL0, vUV); }
    else if (t < 2.0) { lo = texture(uL0, vUV); hi = texture(uL1, vUV); }
    else { lo = texture(uL1, vUV); hi = texture(uL2, vUV); }
    float f = t < 1.0 ? t : (t < 2.0 ? t - 1.0 : t - 2.0);
    // 模糊类:alpha 与颜色同进同出,各档里已经带着滤过的不透明度,混档时一起混。
    Frag = clamp(mix(lo, hi, f), 0.0, 1.0);
}`;

// 三档借用 off[2..4](那三张只在需要 silhouette 的特效里才占用,而一张图层不会同时把两者
// 算糊),scratch 用色彩乒乓空着的另一半 —— 于是整套景深**一张纹理都不多要**,FX_MAX_PIXELS 的
// 地板和五张缓冲的预算一个字没动。代价是 3 档 × down/up = 6 趟定 4 抽样的低通,与半径无关。
function fxglDof(col, p) {
    const gl = fxgl.gl;
    const src = fxgl.off[col.slot];
    const scratch = fxgl.off[1 - col.slot];
    const lv = [fxgl.off[2], fxgl.off[3], fxgl.off[4]];
    for (let i = 0; i < 3; i++) fxglGauss(lv[i], src.tex, scratch, (p.radius * (i + 1)) / 3);
    fxglRunPass(scratch, fxgl.progs.dof, pr => {
        fxglBindTex(pr, 'uSharp', src.tex, 0);
        fxglBindTex(pr, 'uL0', lv[0].tex, 1);
        fxglBindTex(pr, 'uL1', lv[1].tex, 2);
        fxglBindTex(pr, 'uL2', lv[2].tex, 3);
        fxglBindTex(pr, 'uMap', fxgl.texMap, 4);
        gl.uniform1f(fxglU(pr, 'uFocus'), p.focus / 100);
        gl.uniform1f(fxglU(pr, 'uThick'), p.thick / 100);
        gl.uniform1f(fxglU(pr, 'uInv'), p.near === 'bright' ? 1 : 0);
    });
    col.slot = 1 - col.slot;
}

defineEffect({
    type: 'dof',
    label: 'Depth of Field',
    group: 'Blur',
    icon: 'dof',
    needsMap: 'Depth',
    desc: 'A low-pass whose radius comes from a bound depth map: the plane at Focal stays sharp, and every pixel whose map distance exceeds Thick takes more Iris. The map is read, never drawn, and the radius is symmetric \u2014 nearer or farther both defocus.',
    params: [
        { key: 'map', label: 'Map', kind: 'map', def: null },
        { key: 'focus', label: 'Focal', min: 0, max: 100, step: 1, def: 35, unit: '%' },
        { key: 'thick', label: 'Thick', min: 0, max: 100, step: 1, def: 10, unit: '%' },
        { key: 'radius', label: 'Iris', min: 1, max: 64, step: 1, def: 16, unit: 'px' },
        { key: 'near', label: 'Near', kind: 'enum', options: ['dark', 'bright'], def: 'dark' },
    ],
    shaders: { dof: FX_FS_DOF },
    run: fxglDof,
    readout(p, n, effect) {
        return `${fxMapShort(effect)}  f${n(p.focus)}  t${n(p.thick)}  i${n(p.radius)}${p.near === 'bright' ? '  inv' : ''}`;
    },
    thumb(g, box) {
        // 同一组条纹,中间一段清晰、两侧按距离逐渐糊掉:景深的样子就是清晰度随景深变。
        const stripes = (x0, x1, blur) => {
            g.save();
            g.beginPath();
            g.rect(x0, box.y, x1 - x0, box.h);
            g.clip();
            if (blur) g.filter = `blur(${blur}px)`;
            g.fillStyle = '#6f8cff';
            for (let i = 0; i < 6; i++) g.fillRect(box.x + i * (box.w / 6) + 2, box.y + 5, box.w / 12, box.h - 10);
            g.restore();
        };
        const third = box.w / 3;
        stripes(box.x, box.x + third, 3.2);
        stripes(box.x + third, box.x + 2 * third, 0);
        stripes(box.x + 2 * third, box.x + box.w, 4.6);
    },
});
