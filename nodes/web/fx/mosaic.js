// fx/mosaic.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图。

// 马赛克:先把 UV 折进所属格子,取格心做 3×3 直通色平均 —— 同一格里的每个像素算的是同一组
// 抽样点,所以结果是一块**平的**色斑;alpha 走同一组抽样的均值,一块格子里颜色与不透明度
// 一起平,形状的边缘也随格子化软化。
const FX_FS_PIXELATE = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform vec2 uCell;
void main() {
    vec2 center = (floor(vUV / uCell) + 0.5) * uCell;
    vec3 acc = vec3(0.0);
    float aAcc = 0.0;
    for (int i = 0; i < 9; i++) {
        vec2 o = (vec2(float(i - (i / 3) * 3), float(i / 3)) - 1.0) * (uCell / 3.0);
        vec4 c = texture(uTex, center + o);
        acc += c.rgb * c.a;
        aAcc += c.a;
    }
    Frag = vec4(clamp(acc / max(aAcc, 1e-5), 0.0, 1.0), clamp(aAcc / 9.0, 0.0, 1.0));
}`;

function fxglPixelate(col, p) {
    // size = 1 每格就是它自己那一个像素,等于没格子化。
    if (p.size <= 1) return;
    const gl = fxgl.gl;
    const dst = fxgl.off[1 - col.slot];
    fxglRunPass(dst, fxgl.progs.pixelate, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        // 边长以图层像素给,换算成 UV —— 横竖各自的 texel 数不同,但格子在像素空间是正方形。
        gl.uniform2f(fxglU(pr, 'uCell'), p.size / fxgl.w, p.size / fxgl.h);
    });
    col.slot = 1 - col.slot;
}

defineEffect({
    type: 'mosaic',
    label: 'Mosaic',
    group: 'Pixelate',
    icon: 'pixel',
    desc: 'Averages colour and opacity inside each cell, so the cell reads as one flat block in the layer\u2019s own pixels. The mask is still only read, so the cut edge sent to sampling keeps its own resolution.',
    params: [
        { key: 'size', label: 'Cell', min: 2, max: 128, step: 1, def: 12, unit: 'px' },
    ],
    shaders: { pixelate: FX_FS_PIXELATE },
    run: fxglPixelate,
    readout(p, n) {
        return `${n(p.size)} px`;
    },
    thumb(g, box) {
        // 一条对角渐变被折成方格:每格取格心的渐变值,填成一块平色 —— 马赛克的样子就是"渐变变方"。
        const cell = 9;
        const lerp = (a, b, k) => Math.round(a + (b - a) * k);
        for (let y = box.y; y < box.y + box.h; y += cell) {
            for (let x = box.x; x < box.x + box.w; x += cell) {
                const t = (((x + cell / 2) - box.x) / box.w + ((y + cell / 2) - box.y) / box.h) / 2;
                g.fillStyle = `rgb(${lerp(0x14, 0x6f, t)},${lerp(0x14, 0x8c, t)},${lerp(0x1c, 0xff, t)})`;
                g.fillRect(x, y, Math.min(cell, box.x + box.w - x), Math.min(cell, box.y + box.h - y));
            }
        }
    },
});
