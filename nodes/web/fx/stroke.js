// fx/stroke.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图。
// 契约依据见 fx/core.js 顶部;它能借用哪些缓冲见 fx/gl.js 顶部。

// 描边 = 沿自己的轮廓量出来的等宽色带。要的是"离轮廓多远",所以算的是**距离**,不是模糊。
// (早期写法是"把 silhouette 虚化后读 0.5 水平集",那是错的:低通是**面积平均**而不是距离 ——
//  ① 细于半径的地方覆盖度根本爬不到阈值 ⇒ Size 一大描边整条消失;② 平均场的水平集会在本来相距
//  很远的两块之间长出光滑的颈 ⇒ 看着像液体。距离场两条都不犯,而且宽度就是参数写的像素数。)
// 距离场用 jump flooding 算:轮廓像素 (alpha 跨过 0.5 的那一圈;外加图层框边 —— alpha 顶到框边
// 的图层,它的"形状边缘"本来就是框边) 当种子,每像素存"我到最近种子的 texel 偏移",然后步长按
// 2 的幂从大到小各扫一趟 3×3 邻域、谁的候选更近就继承谁。偏移编成 (o + 128) / 256 ⇒ RGBA16F 里
// 整数偏移精确、RGBA8 退化时也有 1 texel 的刻度,两个格式同一条算式。够不到种子的像素留着哨兵,
// 它的判定结果本来就是 0 (真距离必然 > Size),所以起点步长只需推到 (Size+2)/2 的那个 2 幂,
// 不用把信息白漫到整张图上去:趟数 = log2(起点) + 1,最大 Size 也才 7 趟 × 9 抽样。
// 三条位置按 PS 的读法: Outside 的环长在形状之外 (和它争宠的像素本来全是透明 ⇒ 需要图层自己有
// 留白 —— 文字层就去调 Padding), Inside 吃形状内侧, Center 两侧各占一半 (所以半径取 Size/2)。
// 形状故意**只取图层 alpha** (uHasMask 恒 0): 蒙版在链外还要整体乘一次, 吃过一遍就成了平方,
// 而"描边只出现在蒙版内"本来就是那次乘法的结果 (契约 ③ 的推论, 与外阴影同一个理由)。

const FX_STROKE_DIST_SCALE = 256;          // 偏移编码的刻度, 见上
const FX_STROKE_DIST_BIAS = 128;           // 有符号偏移在 [0,1] 里的零点
const FX_STROKE_DIST_NONE = 120;           // "这一圈够不着任何轮廓" 的哨兵 (> 任何 Size)
const FX_STROKE_MAX_STEP = 64;             // 起点步长上限: 洪泛可达 2·64 − 1 = 127, 正好还在编码范围内

// 两份着色器共用同一对编解码:存的是 (o + BIAS) / SCALE,取出来才是 texel 偏移。
const FX_STROKE_CODEC = `
vec2 fxDec(vec2 v) { return v * ${FX_STROKE_DIST_SCALE}.0 - ${FX_STROKE_DIST_BIAS}.0; }
vec2 fxEnc(vec2 o) { return (o + ${FX_STROKE_DIST_BIAS}.0) / ${FX_STROKE_DIST_SCALE}.0; }`;

// 第一趟:轮廓像素 → 偏移 0,其余 → 哨兵。
const FX_FS_STROKE_SEED = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform vec2 uSize;
${FX_STROKE_CODEC}
void main() {
    float m = step(0.5, texture(uSrc, vUV).a);
    float n1 = step(0.5, texture(uSrc, vUV + vec2(uTexel.x, 0.0)).a);
    float n2 = step(0.5, texture(uSrc, vUV - vec2(uTexel.x, 0.0)).a);
    float n3 = step(0.5, texture(uSrc, vUV + vec2(0.0, uTexel.y)).a);
    float n4 = step(0.5, texture(uSrc, vUV - vec2(0.0, uTexel.y)).a);
    float edge = abs(m - n1) + abs(m - n2) + abs(m - n3) + abs(m - n4);
    vec2 g = vUV / uTexel;
    float rim = m * (float(g.x < 1.0) + float(g.y < 1.0)
        + float(g.x > uSize.x - 1.0) + float(g.y > uSize.y - 1.0));
    vec2 off = (edge > 0.0 || rim > 0.0) ? vec2(0.0) : vec2(${FX_STROKE_DIST_NONE}.0);
    Frag = vec4(fxEnc(off), 0.0, 0.0);
}`;

// 洪泛一趟:3×3 邻域各看 uStep 远,候选 = 邻居存的偏移 + 这段距离;谁的模长短就继承谁。
// 两条采样纪律都得守, 否则距离会被算**短** (短 = 长出假描边, 比算长了严重得多):
//   * 越界的抽样不许用 —— 采样器是 CLAMP_TO_EDGE, 框边像素往后看 uStep 会读回自己, 那段 hop 便
//     凭空少走 uStep 步, 于是"距离"缩水; 洪泛只在框内传。
//   * 哨兵不许当邻居 —— |分量| >= NONE 的值不是任何真种子的偏移, 加一段 hop 就编造出一个根本不
//     存在的近种子 (RGBA8 退化时被 127 夹过的那些也一并落进这条, 所以阈值取 120 而非 127)。
// 判定只关心 d <= Size (<= 96), 而真距离 <= 96 的 winning 链上每个中间值都被"剩余步长之和"钉在
// 63 以下, 这两条都砍不到它 —— 砍到的只有本来就描不着的远处。
const FX_FS_STROKE_FLOOD = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uStep;
${FX_STROKE_CODEC}
void main() {
    vec2 best = fxDec(texture(uTex, vUV).rg);
    float bd = dot(best, best);
    vec2 p = vUV / uTexel;
    ivec2 sz = textureSize(uTex, 0);
    for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
            if (i == 0 && j == 0) continue;
            vec2 off = vec2(float(i), float(j)) * uStep;
            vec2 q = p + off;
            if (q.x < 0.0 || q.y < 0.0 || q.x > float(sz.x - 1) || q.y > float(sz.y - 1)) continue;
            vec2 n = fxDec(texture(uTex, vUV + off * uTexel).rg);
            if (max(abs(n.x), abs(n.y)) >= ${FX_STROKE_DIST_NONE}.0) continue;
            vec2 cand = off + n;
            float cd = dot(cand, cand);
            if (cd < bd) { bd = cd; best = cand; }
        }
    }
    Frag = vec4(fxEnc(best), 0.0, 0.0);
}`;

const FX_FS_STROKE = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uDist;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uRadius;
uniform float uInOn;
uniform float uOutOn;
${FX_STROKE_CODEC}
void main() {
    vec4 c = texture(uTex, vUV);
    float own = c.a;
    float d = length(fxDec(texture(uDist, vUV).rg));
    // 判定就是 d <= Size,和形状的粗细无关 ⇒ 1px 的发丝也描得满,Size 再大也不会褪色消失。
    // 种子的 alpha 判定把轮廓两侧都算进去了 (跨过 0.5 的那一圈像素, 两边各自的 d 都是 0),所以像素
    // 中心到**亚像素边缘**的真距离是 d + 0.5;取 d <= Size 时 AA 落在 [Size-1, Size] 这一格 —— 硬边
    // 形状上正好是 Size 个整像素, 斜边/曲线则自带一条 1px 的斜坡, 不需要额外副抽样。
    // (那个 +0.5 只在边的法向上成立: 45° 拐角处最近的种子是斜对面的像素中心, 于是拐角比 PS 的理想
    //  圆角紧 1px 上下。直线边是准的, 要的是"宽度 = Size", 不为一个角再种亚像素偏移。)
    float cover = 1.0 - smoothstep(uRadius - 1.0, uRadius, d);
    // 外侧那条带**垫在本色之下** (和影子同一路),内侧那条**盖在本色之上** —— PS 的 stroke
    // 就是盖住自己的画面的, 只是它出不了轮廓, 所以实心内部照样看得见色带。
    float so = cover * uOutOn * uOpacity;
    float a1 = own + so * (1.0 - own);
    vec3 p1 = c.rgb * own + uColor * so * (1.0 - own);
    float si = cover * own * uInOn * uOpacity;
    float a = si + a1 * (1.0 - si);
    vec3 rgb = (uColor * si + p1 * (1.0 - si)) / max(a, 1e-4);
    Frag = vec4(clamp(rgb, 0.0, 1.0), clamp(a, 0.0, 1.0));
}`;

// Size → 该往两边各描多宽:Outside/Inside 是整条 Size,Center 一侧一半。
function fxStrokeRadius(p) {
    return p.position === 'center' ? p.radius / 2 : p.radius;
}

function fxStrokeSides(p) {
    if (p.position === 'inside') return [1, 0];
    if (p.position === 'center') return [1, 1];
    return [0, 1];                                  // outside —— PS 的默认位置, 认不出的值也走它
}

// 起点步长 = 最小的 2 幂 ≥ (ρ+2)/2 (相邻两趟之和 ≈ 2·step,那就覆盖了 ρ),上限 FX_STROKE_MAX_STEP。
// 更远的像素判定必然是 0,不值得为它多扫几趟。
function fxStrokeSteps(radius) {
    const reach = Math.min(FX_STROKE_MAX_STEP, Math.max(1, Math.ceil((radius + 2) / 2)));
    let s = 1;
    while (s < reach) s *= 2;
    const out = [];
    for (; s >= 1; s = s >> 1) out.push(s);
    return out;
}

function fxglStroke(col, p) {
    if (p.opacity <= 0) return;
    const gl = fxgl.gl;
    const radius = fxStrokeRadius(p);
    const sides = fxStrokeSides(p);
    fxglRunPass(fxgl.off[2], fxgl.progs.sil, pr => {
        fxglBindTex(pr, 'uSrc', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uMask', fxgl.texMask, 1);
        gl.uniform1i(fxglU(pr, 'uHasMask'), 0);
    });
    // 距离场在 3/4 号面之间乒乓 (2 号面刚灌好种子),终点落在哪一张由趟数决定 —— 记下来给合成用。
    fxglRunPass(fxgl.off[3], fxgl.progs.strokeSeed, pr => {
        fxglBindTex(pr, 'uSrc', fxgl.off[2].tex, 0);
        gl.uniform2f(fxglU(pr, 'uTexel'), 1 / fxgl.w, 1 / fxgl.h);
        gl.uniform2f(fxglU(pr, 'uSize'), fxgl.w, fxgl.h);
    });
    let src = 3;
    for (const step of fxStrokeSteps(radius)) {
        const next = 7 - src;                              // 3 ↔ 4
        fxglRunPass(fxgl.off[next], fxgl.progs.strokeFlood, pr => {
            fxglBindTex(pr, 'uTex', fxgl.off[src].tex, 0);
            gl.uniform2f(fxglU(pr, 'uTexel'), 1 / fxgl.w, 1 / fxgl.h);
            gl.uniform1f(fxglU(pr, 'uStep'), step);
        });
        src = next;
    }
    const dst = fxgl.off[1 - col.slot];
    fxglRunPass(dst, fxgl.progs.stroke, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uDist', fxgl.off[src].tex, 1);
        gl.uniform3f(fxglU(pr, 'uColor'), ...fxHexToRgb01(p.color));
        gl.uniform1f(fxglU(pr, 'uOpacity'), p.opacity / 100);
        gl.uniform1f(fxglU(pr, 'uRadius'), radius);
        gl.uniform1f(fxglU(pr, 'uInOn'), sides[0]);
        gl.uniform1f(fxglU(pr, 'uOutOn'), sides[1]);
    });
    col.slot = 1 - col.slot;
}

defineEffect({
    type: 'stroke',
    label: 'Stroke',
    group: 'Shadow',
    icon: 'stroke',
    desc: 'A band of exactly Size pixels along the shape\u2019s outline. The width is measured with a real distance field (jump flooding), so it neither thins out nor vanishes as Size grows, and it only bridges two parts once they really are that close. Outside grows the layer\u2019s alpha into pixels that were transparent, which means it needs clear room inside the layer box (a text layer gets that from Padding); Inside and Center stay on the picture.',
    params: [
        { key: 'position', label: 'Position', kind: 'enum', options: ['outside', 'inside', 'center'], def: 'outside' },
        { key: 'radius', label: 'Size', min: 1, max: 96, step: 1, def: 4, unit: 'px' },
        { key: 'opacity', label: 'Opac', min: 0, max: 100, step: 1, def: 100, unit: '%' },
        { key: 'color', label: 'Color', kind: 'color', def: '#ffffff' },
    ],
    shaders: { strokeSeed: FX_FS_STROKE_SEED, strokeFlood: FX_FS_STROKE_FLOOD, stroke: FX_FS_STROKE },
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
