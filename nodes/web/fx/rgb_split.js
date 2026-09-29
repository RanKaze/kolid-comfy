// fx/rgb_split.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图 (Glitch 组)。
// RGB Split 在这里**不是**色散:色散那一族 (fx/chromatic_aberration.js) 已经把「R 与 B 沿一条线各偏半幅、
// 绿钉在原地、偏移随半径/随深度平滑变化」全占了。这一格要的是故障艺术里那两种**非连续**的分色:
//   * Dot    —— 分色点阵 (halftone screen):画面按 Cell 切成点阵,每一颗点只归一个通道, 只有落在自己
//               那颗点里的像素才允许去偏开的位置取值。于是一条边缘不再长出连续的彩边, 而是碎成一格一格
//               的彩色网点 —— 那是印刷分色版叠歪了的样子, 和镜头色散不是一个东西。
//   * Dither —— 偏移量的有序抖动:每个像素该偏多远不是随亮度平滑长的, 而是被 8×8 Bayer 阈值量化成
//               Steps 档, 档与档的边界再由点阵打散。出来的是一圈一圈**阶梯状**的分色带, 带边是细密的
//               网点, 不是渐变。
// Split 那一项也和色散区分得开:色散只能让 R 与 B 对拉 (绿永远不动);这里选的是**哪一个通道单独对着
// 另外两个** (R / G / B 任选), 或者三个通道各走 120° (Triad) —— 后者在色散里根本无法表达。
// 三条契约的落点:① 偏移取样出界 = 该通道没有源 ⇒ 取 0, 不拿 CLAMP_TO_EDGE 抹出一条假边 (与色散同一句);
// ② 只重组 RGB、alpha 原样 —— 它是分色, 不是模糊 (与色散同侧; 隔壁 pixel_sort 搬整颗像素, 在另一侧);
// ③ 不读蒙版。

const RS_MODES = ['Dot', 'Dither'];
const RS_PATTERNS = ['Triad', 'R vs', 'G vs', 'B vs'];
const RS_BLENDS = ['Over', 'Plate'];
const RS_WHERE = ['Anywhere', 'On edges', 'By map'];

// 两片着色器共用的取样地基:方向换算、出界判透明、闸门 (谁可以被分开)。
// 方向沿用整条链的角度约定 (0° = 右、90° = 下), 而纹素的 v 朝上, 所以 sin 折一次符号 ——
// 与 JS 侧的 fxglDirUV 逐字同一条式子, 只是这里必须逐通道算, 于是放在着色器里。
const RS_GLSL_COMMON = `
uniform sampler2D uTex;
uniform sampler2D uMap;
uniform vec2 uSize;
uniform float uAngle;
uniform float uAmount;
uniform float uStrength;
uniform int uPattern;
uniform int uWhere;
uniform float uEdge;
uniform float uCut;
vec2 rsDir(float deg) {
    float a = radians(deg);
    return vec2(cos(a), -sin(a));
}
// 偏移落在该层网格的 px 上, 再过各轴自己的像素数进 uv —— 于是「偏 8px」在横竖两个方向上都是 8px。
vec2 rsOffset(float deg, float mag) {
    vec2 d = rsDir(deg);
    return vec2(d.x * mag / max(uSize.x, 1.0), d.y * mag / max(uSize.y, 1.0));
}
float rsDeg(int k) {
    // Triad = 三通道各走 0/120/240;其余三档 = 选中的那一个通道对着另外两个 (它们同向)。
    if (uPattern == 0) return uAngle + 120.0 * float(k);
    return k == uPattern - 1 ? uAngle : uAngle + 180.0;
}
vec4 rsFetch(vec2 uv) {
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
    return texture(uTex, uv);
}
float rsLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// 闸门: 哪些像素可以被分开。On edges 读亮度四邻的最差分 (与 fx/pixel_sort.js 同一刻度: 差值天生只有
// 0..1 里的一小截, 所以门槛按 0.4 满幅给, 闸门从门槛处软起到两倍门槛);By map 读绑来那张图过不过 Cut。
float rsGate(ivec2 tc) {
    if (uWhere == 1) {
        ivec2 lo = ivec2(0), hi = ivec2(int(uSize.x) - 1, int(uSize.y) - 1);
        float k = rsLuma(texelFetch(uTex, tc, 0).rgb);
        float e = max(
            max(abs(rsLuma(texelFetch(uTex, clamp(tc + ivec2(1, 0), lo, hi), 0).rgb) - k),
                abs(rsLuma(texelFetch(uTex, clamp(tc - ivec2(1, 0), lo, hi), 0).rgb) - k)),
            max(abs(rsLuma(texelFetch(uTex, clamp(tc + ivec2(0, 1), lo, hi), 0).rgb) - k),
                abs(rsLuma(texelFetch(uTex, clamp(tc - ivec2(0, 1), lo, hi), 0).rgb) - k)));
        float thr = max(uEdge * 0.004, 1e-4);
        return smoothstep(thr, 2.0 * thr, e);
    }
    if (uWhere == 2) return texture(uMap, vUV).r >= uCut ? 1.0 : 0.0;
    return 1.0;
}`;

// ==================== Dot:分色点阵 ====================
// 通道归属用 ci.x + 2·ci.y (mod 3):纯按列轮转会排成竖条、纯按行会排成横条,两个方向都轮转才是分色
// 版那种斜向交错的网点。Stagger 把奇数行错开半格 ⇒ 方点阵拧成三角点阵 (0% = 正方, 50% = 六角)。
const FX_FS_RS_DOT = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform float uCell;
uniform float uDot;
uniform float uStagger;
uniform float uPlate;
${RS_GLSL_COMMON}
void main() {
    ivec2 tc = ivec2(gl_FragCoord.xy);
    vec4 own = texelFetch(uTex, tc, 0);
    float gate = rsGate(tc);
    if (gate <= 0.004 || uAmount <= 0.0) { Frag = own; return; }
    vec2 gp = vec2(float(tc.x), float(tc.y)) / max(uCell, 1.0);
    gp.x -= uStagger * 0.5 * mod(floor(gp.y), 2.0);
    vec2 ci = floor(gp);
    vec2 f = gp - ci;
    int ch = int(mod(ci.x + 2.0 * ci.y, 3.0));
    // 格心到格边是 0..1 (对角方向更远一点),所以半径 >100% 时点会连成一片 —— 那时它退回成连续分色。
    float d = length(f - 0.5) * 2.0;
    float m = 1.0 - smoothstep(uDot - 0.16, uDot + 0.16, d);
    if (m <= 0.004) { Frag = own; return; }
    // 只取这一颗点所属那一通道的偏开取样:一次抽样。通道选择写成三条 mask 而不是 vec[ch] ——
    // ESSL 不许用变量下标取向量的分量。
    vec4 s = rsFetch(vUV + rsOffset(rsDeg(ch), uAmount * gate));
    float val = ch == 0 ? s.r : (ch == 1 ? s.g : s.b);
    vec3 sel = vec3(ch == 0 ? 1.0 : 0.0, ch == 1 ? 1.0 : 0.0, ch == 2 ? 1.0 : 0.0);
    // Over = 点上只把**它自己那个通道**换成偏开的取样, 其余两通道原地;Plate = 点上只留那一支墨
    // (另两通道清零), 于是叠出来的是印刷分色版那种一层一色的网点。
    vec3 dotRgb = uPlate > 0.5 ? sel * val : own.rgb * (1.0 - sel) + sel * val;
    Frag = vec4(mix(own.rgb, dotRgb, uStrength * m), own.a);
}`;

// ==================== Dither:偏移量的有序抖动 ====================
// 8×8 Bayer 阈值由 (x,y) 的三个低位交错成 6 位再除以 64 —— 那正是这一族矩阵的构造 (每把格距翻倍,
// 阈值就分成四组), 而片元着色器不必动态索引一张 64 个数的数组 (常量数组的下标在 ESSL 里最挑编译器)。
const FX_FS_RS_DITHER = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform float uSteps;
${RS_GLSL_COMMON}
float rsBayer(vec2 p) {
    ivec2 q = ivec2(floor(mod(p, 8.0)));
    int v = 0;
    for (int k = 0; k < 3; k++) {
        v |= (q.x & 1) << (2 * k + 1);
        v |= (q.y & 1) << (2 * k);
        q.x >>= 1;
        q.y >>= 1;
    }
    return float(v) / 64.0;
}
void main() {
    ivec2 tc = ivec2(gl_FragCoord.xy);
    vec4 own = texelFetch(uTex, tc, 0);
    float gate = rsGate(tc);
    if (gate <= 0.004 || uAmount <= 0.0) { Frag = own; return; }
    // 亮度决定该偏多远 (越亮偏得越远), Bayer 阈值只负责把档位边界打散成网点, 不负责改变明暗次序。
    float bay = rsBayer(vec2(float(tc.x), float(tc.y)));
    float lvl = clamp(floor(clamp(rsLuma(own.rgb) * uSteps, 0.0, uSteps) + bay), 0.0, uSteps - 1.0)
        / max(uSteps - 1.0, 1.0);
    float mag = uAmount * gate * lvl;
    if (mag <= 0.0) { Frag = own; return; }
    vec3 rgb = vec3(rsFetch(vUV + rsOffset(rsDeg(0), mag)).r,
                    rsFetch(vUV + rsOffset(rsDeg(1), mag)).g,
                    rsFetch(vUV + rsOffset(rsDeg(2), mag)).b);
    // Strength 在这里是「分出来的那三份掺回原图多少」:100% = 只看偏开的取样, 0% = 原样。
    Frag = vec4(mix(own.rgb, rgb, uStrength), own.a);
}`;

// ==================== pass ====================
function fxglRgbSplit(col, p) {
    if (p.amount <= 0) return;                    // 一个通道都没偏开 = 画面原样, 不必占用一次 pass
    const gl = fxgl.gl;
    const dot = p.mode !== 'Dither';
    const dst = fxgl.off[1 - col.slot];
    const src = fxgl.off[col.slot].tex;
    fxglRunPass(dst, dot ? fxgl.progs.rsDot : fxgl.progs.rsDither, pr => {
        fxglBindTex(pr, 'uTex', src, 0);
        // 采样器不许指着没分配过层级的纹理 (同 fx/lighting.js、fx/pixel_sort.js)。
        fxglBindTex(pr, 'uMap', p.where === 'By map' ? fxgl.texMap : src, 1);
        gl.uniform2f(fxglU(pr, 'uSize'), fxgl.w, fxgl.h);
        gl.uniform1f(fxglU(pr, 'uAngle'), p.angle);
        gl.uniform1f(fxglU(pr, 'uAmount'), p.amount);
        gl.uniform1f(fxglU(pr, 'uStrength'), p.strength / 100);
        gl.uniform1i(fxglU(pr, 'uPattern'), Math.max(0, RS_PATTERNS.indexOf(p.pattern)));
        gl.uniform1i(fxglU(pr, 'uWhere'), RS_WHERE.indexOf(p.where));
        gl.uniform1f(fxglU(pr, 'uEdge'), p.edge);
        gl.uniform1f(fxglU(pr, 'uCut'), p.cut / 100);
        if (dot) {
            gl.uniform1f(fxglU(pr, 'uCell'), Math.max(1, p.cell));
            gl.uniform1f(fxglU(pr, 'uDot'), p.dot / 100);
            gl.uniform1f(fxglU(pr, 'uStagger'), p.stagger / 100);
            gl.uniform1f(fxglU(pr, 'uPlate'), p.blend === 'Plate' ? 1 : 0);
        } else {
            gl.uniform1f(fxglU(pr, 'uSteps'), Math.max(2, p.steps | 0));
        }
    });
    col.slot = 1 - col.slot;
}

// ==================== 参数区 ====================
// 一格一个 RGB Split:Mode 用分段钮 (与 Warp / 色调映射 / 色散同一套控件词汇),下面只铺该模式要用的行
// —— Cell / Dot / Stagger / Blend 只有点阵读它, Steps 只有抖动读它。
// 每像素几次抽样写在 Mode 那行的 tooltip 里 (读数那格给人看效果, 不看账单)。
const RS_PARAMS = [
    { key: 'mode', label: 'Mode', kind: 'enum', options: RS_MODES, def: 'Dot',
        tip: 'Taps per pixel: Dot 2, Dither 4 \u2014 plus 4 more when Where reads edges.' },
    { key: 'pattern', label: 'Split', kind: 'enum', options: RS_PATTERNS, def: 'Triad',
        tip: 'Triad sends the three channels 120\u00b0 apart; R/G/B vs sends the one you pick against the other two.' },
    { key: 'angle', label: 'Angle', min: 0, max: 359, step: 1, def: 0, unit: '\u00b0' },
    { key: 'amount', label: 'Shift', min: 1, max: 64, step: 1, def: 8, unit: 'px' },
    { key: 'strength', label: 'Mix', min: 0, max: 100, step: 1, def: 100, unit: '%' },
    { key: 'cell', label: 'Cell', min: 2, max: 64, step: 1, def: 8, unit: 'px', when: p => p.mode === 'Dot' },
    { key: 'dot', label: 'Dot', min: 10, max: 100, step: 1, def: 70, unit: '%', when: p => p.mode === 'Dot' },
    { key: 'stagger', label: 'Stagger', min: 0, max: 100, step: 1, def: 50, unit: '%', when: p => p.mode === 'Dot' },
    { key: 'blend', label: 'Blend', kind: 'enum', options: RS_BLENDS, def: 'Over', when: p => p.mode === 'Dot' },
    { key: 'steps', label: 'Steps', min: 2, max: 16, step: 1, def: 6, when: p => p.mode === 'Dither' },
    { key: 'where', label: 'Where', kind: 'enum', options: RS_WHERE, def: 'Anywhere' },
    { key: 'edge', label: 'Edge', min: 0, max: 100, step: 1, def: 30, unit: '%', when: p => p.where === 'On edges' },
    { key: 'map', kind: 'map', def: null, when: p => p.where === 'By map' },
    { key: 'cut', label: 'Cut', min: 0, max: 100, step: 1, def: 50, unit: '%', when: p => p.where === 'By map' },
];

function rsEditorEl(l, effect, syncRead, updaters) {
    const box = document.createElement('div');
    box.className = 'fx-split';
    const tail = document.createElement('div');
    tail.className = 'fx-split-tail';
    const build = () => {
        const p = effectParams(effect);
        tail.replaceChildren(...RS_PARAMS
            .filter(d => d.key !== 'mode' && (!d.when || d.when(p)))
            .map(d => fxControlRow(l, effect, d, syncRead, updaters)));
        syncRead();
    };
    // 模式行只多接一句「换完模式重铺剩下的行」—— 与 fx/warp.js、fx/chromatic_aberration.js 同一包法。
    box.appendChild(fxControlRow(l, effect, RS_PARAMS[0], () => { build(); }, updaters));
    box.appendChild(tail);
    build();
    return box;
}

defineEffect({
    type: 'rgb_split',
    label: 'RGB Split',
    group: 'Glitch',
    icon: 'split',
    needsMap: 'Noise',
    needsMapWhen: p => p.where === 'By map',
    desc: 'Sends the three channels to three different places \u2014 but only where a screen says they may go, which is what keeps this apart from Chromatic Aberration\u2019s smooth fringe. Dot lays a halftone screen over the layer: each dot belongs to one channel and only that channel is read from the shifted position, so an edge breaks into coloured dots instead of a rainbow line (Cell is the pitch, Dot the size, Stagger offsets odd rows half a cell to turn the square screen triangular, and Plate keeps only that channel\u2019s ink inside the dot instead of mixing it in). Dither quantizes how far a pixel is pushed into Steps levels driven by brightness, with an 8\u00d78 Bayer threshold scattering the borders between them \u2014 separation bands with a dithered edge, not a gradient. Split chooses which channel goes its own way: Triad sends R, G and B 120\u00b0 apart (something a lens\u2019s two-channel fringe cannot do), R/G/B vs sets one channel against the other two. Colour only: alpha is this pixel\u2019s own, and a channel whose source leaves the grid comes back empty.',
    params: RS_PARAMS,
    editor: rsEditorEl,
    shaders: { rsDot: FX_FS_RS_DOT, rsDither: FX_FS_RS_DITHER },
    run: fxglRgbSplit,
    readout(p, n, effect) {
        let s = `${p.mode.toLowerCase()}  ${p.pattern === 'Triad' ? 'triad' : p.pattern[0]}`
            + `  ${n(p.angle)}\u00b0  ${n(p.amount)}px`;
        if (p.mode === 'Dot') {
            s += `  c${n(p.cell)} d${n(p.dot)}`;
            if (p.stagger) s += ` st${n(p.stagger)}`;
            if (p.blend === 'Plate') s += ' plate';
        } else {
            s += `  s${n(p.steps)}`;
        }
        if (p.strength < 100) s += `  m${n(p.strength)}`;
        if (p.where === 'On edges') s += `  e${n(p.edge)}`;
        else if (p.where === 'By map') s += `  ${fxMapShort(effect)} c${n(p.cut)}`;
        return s;
    },
    thumb(g, box) {
        // 一条斜硬边被三套网点各自偏开一点:每颗点只带一支颜色, 三支各朝不同方向 —— 边因此碎成彩色
        // 网点而不是长出连续彩边, 这正是 Dot 那一档的样子。
        const x = box.x, y = box.y, w = box.w, h = box.h;
        const cols = 7, rows = 6;
        const cw = w / cols, chh = h / rows;
        const ink = ['rgba(255,70,70,', 'rgba(80,255,120,', 'rgba(90,140,255,'];
        const dir = [[-1.4, -0.6], [0.4, 1.5], [1.6, -0.4]];
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const px = x + (c + 0.5) * cw + (r % 2 ? cw * 0.5 : 0);
                const py = y + (r + 0.5) * chh;
                if (px > x + w - 1) continue;
                const k = (c + 2 * r) % 3;
                // 越靠近那条对角边越亮 —— 边上才有颜色可分, 角上是暗的。
                const t = (c / cols + r / rows) * 0.5 + 0.28;
                const d = dir[k];
                g.fillStyle = ink[k] + (0.25 + t * 0.7).toFixed(2) + ')';
                g.beginPath();
                g.arc(px + d[0], py + d[1], Math.min(cw, chh) * 0.34 + t * 0.7, 0, Math.PI * 2);
                g.fill();
            }
        }
    },
});
