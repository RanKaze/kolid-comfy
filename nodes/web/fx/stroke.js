// fx/stroke.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图。
// 契约依据见 fx/core.js 顶部;它能借用哪些缓冲见 fx/gl.js 顶部。

// 描边:沿形状的等距线刷一条等宽的色带。做法是把虚化后的 silhouette 当**带符号距离**用 ——
// 一条直边的低通覆盖度约等于 c ≈ 0.5 + 0.5·d/R (d = 到边缘的带符号距离, R = 低通半径),
// 所以"往里/往外缩 s"就是把水平集抬/压到 0.5 ± 0.5·s/R。取 R = 3·Size 后那个偏移恒为 1/6,
// 于是描边厚度随 Size 线性走, 而凸角自己圆、凹角自己填 (圆盘偏移的必然结果, 与 PS 一致)。
// 三条位置按 PS 的读法: Outside 的环长在形状之外 (和它争宠的像素本来全是透明 ⇒ 需要图层自己
// 有留白 —— 文字层就去调 Padding), Inside 吃形状内侧, Center 两侧各占一半。
// 形状只取**图层自己的** alpha (uHasMask 恒 0): 蒙版在链外还要整体乘一次, 吃过一遍就是平方,
// 而"描边只出现在蒙版内"本来就是那次乘法的结果 (契约 ③ 的推论, 与外阴影同一个理由)。
const FX_FS_STROKE = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uSilRaw;
uniform sampler2D uSil;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uInTh;
uniform float uOutTh;
void main() {
    vec4 c = texture(uTex, vUV);
    float own = texture(uSilRaw, vUV).a;
    float cov = texture(uSil, vUV).a;
    // 硬阈值会长出锯齿, 而斜坡宽度按该像素处覆盖度的真实梯度取 (fwidth): 边缘处它自然变宽到
    // 一两个像素, 平坦处 (梯度为 0) 退回一个极窄的台阶。
    float soft = max(fwidth(cov) * 1.5, 0.002);
    // 内侧带 = 形状里、缩进后的形状外; 外侧带 = 膨胀后的形状里、形状外。关掉一侧就把它的阈值
    // 甩到覆盖度取不到的那边 ([0,1] 之外), 于是那一项整片归零, 不需要分支。
    float band = own * (1.0 - smoothstep(uInTh - soft, uInTh + soft, cov));
    band += (1.0 - own) * smoothstep(uOutTh - soft, uOutTh + soft, cov);
    float s = clamp(band, 0.0, 1.0) * uOpacity;
    // 与外阴影同一个直通色 source-over: 描边在上, 本色在下, 最后除回新的 alpha。
    float a = own + s * (1.0 - own);
    vec3 rgb = (c.rgb * own + uColor * s * (1.0 - own)) / max(a, 1e-4);
    Frag = vec4(clamp(rgb, 0.0, 1.0), clamp(a, 0.0, 1.0));
}`;

// Size → 低通半径的倍数, 以及由此定死的水平集偏移 (0.5 / SPREAD)。见上面着色器注释的推导。
const FX_STROKE_SPREAD = 3;
const FX_STROKE_OFF = 0.5 / FX_STROKE_SPREAD;

// [内侧阈值, 外侧阈值]。1.5 / -0.5 是"这一侧关掉"的哨兵值, 覆盖度永远够不着。
function fxStrokeThresholds(p) {
    if (p.position === 'inside') return [0.5 + FX_STROKE_OFF, 1.5];
    if (p.position === 'center') return [0.5 + FX_STROKE_OFF / 2, 0.5 - FX_STROKE_OFF / 2];
    return [-0.5, 0.5 - FX_STROKE_OFF];                      // outside —— PS 的默认位置
}

function fxglStroke(col, p) {
    if (p.opacity <= 0) return;
    const gl = fxgl.gl;
    // 2 号面 = 未虚化形状 (合成时要拿它当"本色在不在"), 3/4 号接 fxglSilGauss 的两趟低通。
    // 三个借用面每趟都重写, 所以和同链里的内/外阴影、景深、泛光互不污染。
    fxglRunPass(fxgl.off[2], fxgl.progs.sil, pr => {
        fxglBindTex(pr, 'uSrc', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uMask', fxgl.texMask, 1);
        gl.uniform1i(fxglU(pr, 'uHasMask'), 0);
    });
    fxglSilGauss(p.radius * FX_STROKE_SPREAD);
    const th = fxStrokeThresholds(p);
    const dst = fxgl.off[1 - col.slot];
    fxglRunPass(dst, fxgl.progs.stroke, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uSilRaw', fxgl.off[2].tex, 1);
        fxglBindTex(pr, 'uSil', fxgl.off[4].tex, 2);
        gl.uniform3f(fxglU(pr, 'uColor'), ...fxHexToRgb01(p.color));
        gl.uniform1f(fxglU(pr, 'uOpacity'), p.opacity / 100);
        gl.uniform1f(fxglU(pr, 'uInTh'), th[0]);
        gl.uniform1f(fxglU(pr, 'uOutTh'), th[1]);
    });
    col.slot = 1 - col.slot;
}

defineEffect({
    type: 'stroke',
    label: 'Stroke',
    group: 'Shadow',
    icon: 'stroke',
    desc: 'An even-width band along the shape\u2019s own outline \u2014 the blurred silhouette is read as a signed distance, so the band rounds convex corners and fills concave ones by itself. Outside grows the layer\u2019s alpha into pixels that were transparent, which means it needs clear room inside the layer box (a text layer gets that from Padding); Inside and Center stay on the picture.',
    params: [
        { key: 'position', label: 'Position', kind: 'enum', options: ['outside', 'inside', 'center'], def: 'outside' },
        { key: 'radius', label: 'Size', min: 1, max: 96, step: 1, def: 4, unit: 'px' },
        { key: 'opacity', label: 'Opac', min: 0, max: 100, step: 1, def: 100, unit: '%' },
        { key: 'color', label: 'Color', kind: 'color', def: '#ffffff' },
    ],
    shaders: { stroke: FX_FS_STROKE },
    run: fxglStroke,
    readout(p, n) {
        const pos = p.position === 'inside' ? 'in' : (p.position === 'center' ? 'ctr' : 'out');
        return `${pos}  s${n(p.radius)}  ${n(p.opacity)}%  ${p.color}`;
    },
    thumb(g, box) {
        // 环套在砖外面 —— 注册默认的 Outside 位置, 也是这条链里唯一会长到形状之外的描边。
        const x = box.x + 6, y = box.y + 6, w = box.w - 12, h = box.h - 12;
        g.lineWidth = 5;
        g.strokeStyle = 'rgba(255,255,255,0.92)';
        g.strokeRect(x - 2.5, y - 2.5, w + 5, h + 5);
        g.fillStyle = '#6f8cff';
        g.fillRect(x, y, w, h);
    },
});
