// fx/gaussian_blur.js —— 特效链的一类特效:注册数据 + pass + 读数 + 缩略图。
// 低通本身是引擎原语 (FX_FS_BOX 的旋转十字 Kawase),所以这类特效没有自己的着色器。

function fxglGaussianBlur(col, p) {
    // radius = 0 是恒等,不值得占用一趟 pass。
    if (p.radius <= 0) return;
    fxglGauss(fxgl.off[col.slot], fxgl.off[col.slot].tex, fxgl.off[1 - col.slot], p.radius);
}

defineEffect({
    type: 'gaussian_blur',
    label: 'Gaussian Blur',
    group: 'Blur',
    icon: 'blur',
    desc: 'A low-pass whose radius is measured in the layer\u2019s own pixels. Colour and opacity soften together, so a text layer\u2019s edges blur too \u2014 but the mask is only read, never consumed, so the cut edge sent to sampling stays exactly where it was.',
    params: [
        { key: 'radius', label: 'Radius', min: 0, max: 128, step: 1, def: 8, unit: 'px' },
    ],
    run: fxglGaussianBlur,
    readout(p, n) {
        return `r${n(p.radius)}`;
    },
    thumb(g, box) {
        g.save();
        g.filter = 'blur(5px)';
        g.fillStyle = '#6f8cff';
        g.fillRect(box.x, box.y, box.w, box.h);
        g.restore();
    },
});
