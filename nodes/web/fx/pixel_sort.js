// fx/pixel_sort.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图 (Glitch 组)。
// Pixel Sorting:把「沿某个方向连续亮过门槛的那一串像素」整段按 key 重排。这是 KS/Asendorf 那一族
// glitch 的看家算法,但它天生是**串行**的 (扫出 run → 排 run → 写回),而链跑在片元着色器里:
// 一个线程只看得到自己那个像素,WebGL2 也没有 scatter/atomic 可以往邻居身上写。所以精确的「任意长
// run 一次排完」在这里根本不是一个片元问题。
// 这份实现走的是**定长窗口分块**:格网按 Length 切成块 (每行/每条射线各自的相位,由 Jitter 打散),
// 每块内部排的是**真排序** —— run 短于 Length 时逐像素等于串行版;更长的 run 会被切成几块各自排好,
// 于是读出来是一段段接起来的阶梯,而不是一根几千像素的长拖尾。Passes 把同一件事在它自己的输出上再来
// 一遍 (每趟换一格相位),值因此能跨过块界往外走,逼近长排序,代价按趟线性涨。
// 三趟走线拆成两片着色器:先烘一张 probe 面 (R=key、G=参与闸门),排序那一趟每个判断就只读它一个纹素。
// 不烘这张面的话,每次 membership 判定都要重算一遍 key (亮边模式下还要再抓四个邻居),3×Length 次抽样
// 会翻成十倍。probe 借的是引擎的公共借用区 off[2] (见 fx/gl.js 顶部),一条链里每趟都重算,互不污染。
// 三条契约的落点:① 搬运只在**同一张网格内**换源点,run 撞到网格边就停 ⇒ 输出尺寸 === 输入;
// ② 搬的是整颗像素 (texelFetch 取 RGBA 四个通道一起),所以 alpha 跟着画面走 —— 文字层被排序时
//    不透明度一起拖开,这正是这一族要的样子 (与模糊类同侧,不是与色散同侧);③ 不读蒙版。

// 64 = 单次 pass 愿意付的最长一段:三段走线各_bound_住在这里 (循环一离开 run 就 break,所以这个数只
// 在 run 真有那么长时才付满)。工程里其余着色器的常数次循环上界是 32 (fx/vector_blur.js、fx/warp.js 的
// Steps),再往上一档是这套分块算法自己需要的,再多就是拿编译期与寄存器去换一根更长的拖尾 —— 想要那根
// 拖尾请拧 Passes,它按趟付,而不是把一趟的上界抬到几百。
const PS_MAX_LEN = 64;
const PS_MAX_PASSES = 3;

const PS_KEYS = ['Luma', 'Hue', 'Sat', 'R', 'G', 'B', 'A'];
const PS_AXES = ['Along', 'Across', 'Radial'];
const PS_WHERE = ['Anywhere', 'On edges', 'By map'];

// hash 与 fx/warp.js 的 warpHash 同一个写法:Jitter 要的相位逐行取一个 [0,1) 的确定值,同一个 seed
// 永远掷出同一副牌 —— 不然每次重算画布都在换一套分块,拖别的滑块时排序的相位会自己跳。
const PS_GLSL_HASH = `
float psHash(vec2 p) {
    p = fract(p * vec2(0.1031, 0.1030));
    p += dot(p, p + 23.13);
    return fract(p.x * p.y * 45.73);
}`;

// key 的算法只有一份:probe 烘它,排序那一趟读它。7 个候选全是 0..1 的标量,门槛因此是同一个刻度。
// 色彩缓冲是直通 alpha,所以 key 读的是图层自己的颜色与自己的不透明度,不预乘 —— 「这一格亮不亮」按
// 素材本身算,而不是按它在画布上压到什么之上算。
const PS_GLSL_KEY = `
float psHue(vec3 c) {
    float mx = max(max(c.r, c.g), c.b);
    float mn = min(min(c.r, c.g), c.b);
    float d = mx - mn;
    if (d <= 1e-5) return 0.0;
    float h = c.r >= mx ? (c.g - c.b) / d : (c.b >= mx ? 2.0 + (c.b - c.r) / d : 4.0 + (c.r - c.g) / d);
    h /= 6.0;
    return h < 0.0 ? h + 1.0 : h;
}
float psSat(vec3 c) {
    float mx = max(max(c.r, c.g), c.b);
    float mn = min(min(c.r, c.g), c.b);
    return mx > 1e-5 ? (mx - mn) / mx : 0.0;
}
float psKey(vec4 c) {
    if (uKey == 0) return dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    if (uKey == 1) return psHue(c.rgb);
    if (uKey == 2) return psSat(c.rgb);
    if (uKey == 3) return c.r;
    if (uKey == 4) return c.g;
    if (uKey == 5) return c.b;
    return c.a;
}`;

// ==================== probe:逐纹素烘 (key, 闸门) ====================
// 闸门是二值的 (≥0.5 才算参与),因为 run 的边界本身就得是个判决 —— 连续的闸门值在这里只会让
// 「哪一段连着」随门槛抖动。On edges 读 key 的四邻最差差值 (高反差才排序 = KS 那族「只切边缘」的
// 常用读法),By map 读绑来那张图自己是否过 Cut。
const FX_FS_PS_PROBE = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uMap;
uniform vec2 uSize;
uniform int uKey;
uniform int uWhere;
uniform float uEdge;
uniform float uCut;
${PS_GLSL_KEY}
ivec2 Gtc;
ivec2 psClamp(ivec2 p) { return clamp(p, ivec2(0), ivec2(int(uSize.x) - 1, int(uSize.y) - 1)); }
float psKeyAt(ivec2 p) { return psKey(texelFetch(uTex, psClamp(p), 0)); }
void main() {
    Gtc = ivec2(gl_FragCoord.xy);
    vec4 c = texelFetch(uTex, Gtc, 0);
    float k = psKey(c);
    float gate = 1.0;
    if (uWhere == 1) {
        // 四邻各一次 (拿的是本纹素自己的邻居,不是插值后的),所以「这条 run 走在边缘上」与门槛同尺度。
        float e = max(
            max(abs(psKeyAt(Gtc + ivec2(1, 0)) - k), abs(psKeyAt(Gtc - ivec2(1, 0)) - k)),
            max(abs(psKeyAt(Gtc + ivec2(0, 1)) - k), abs(psKeyAt(Gtc - ivec2(0, 1)) - k)));
        // 差值天生是 0..1 里的一小截,所以门槛按 0.4 满幅给;闸门从门槛处软起到两倍门槛。
        float thr = max(uEdge * 0.004, 1e-4);
        gate = smoothstep(thr, 2.0 * thr, e);
    } else if (uWhere == 2) {
        gate = texture(uMap, vUV).r >= uCut ? 1.0 : 0.0;
    }
    Frag = vec4(clamp(k, 0.0, 1.0), gate, 0.0, 1.0);
}`;

// ==================== sort:定长窗口内的真排序 ====================
// 本像素沿轴的位置 t 落在某个块 [cell0, cell0+Length) 里;先在块内把连着通过判定的那一段的两端找出来
// (a、b),再数「这一段里有多少个 key 比我的小」(同值按原次序破平,所以排完是稳定的) —— 那个数就是
// 我在排好的序列里的名次 r,于是我该显示 a+r (降序则 b−r) 那一格的像素。三段走线各不超过 Length 步。
// 轴向量:Along = 沿 x (图像的行),Across = 沿 y,Radial = 离该层网格中心的那条射线。纹素 y 朝上而
// 画布 y 朝下 (上传时翻过),所以 Across 的「向上」在界面上读起来是往上,与 Along 的「往右」各归各的,
// 排序的次序本身由 Order 那颗旋钮说,不藏在这一步里。
const FX_FS_PS_SORT = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uProbe;
uniform vec2 uSize;
uniform vec2 uOrigin;
uniform int uAxis;
uniform float uThr;
uniform float uPol;
uniform int uLen;
uniform int uMin;
uniform float uOrder;
uniform float uJit;
uniform float uSeed;
uniform float uPass;
ivec2 Gtc;
${PS_GLSL_HASH}
float psCoord(ivec2 p) {
    if (uAxis == 0) return float(p.x);
    if (uAxis == 1) return float(p.y);
    return length(vec2(p) - uOrigin);
}
// dir 只在 Radial 用:它是本像素这条射线的单位方向,整条走线共用一支,所以射线不会自己拧弯。
ivec2 psAt(float s, vec2 dir) {
    if (uAxis == 0) return ivec2(int(round(s)), Gtc.y);
    if (uAxis == 1) return ivec2(Gtc.x, int(round(s)));
    return ivec2(round(uOrigin.x + dir.x * s), round(uOrigin.y + dir.y * s));
}
bool psIn(ivec2 p) { return p.x >= 0 && p.y >= 0 && p.x < int(uSize.x) && p.y < int(uSize.y); }
bool psMember(float s, vec2 dir) {
    ivec2 p = psAt(s, dir);
    if (!psIn(p)) return false;                 // 撞到网格边 = run 到此为止 (契约①)
    vec4 q = texelFetch(uProbe, p, 0);
    return q.g > 0.5 && uPol * (q.r - uThr) >= 0.0;
}
void main() {
    Gtc = ivec2(gl_FragCoord.xy);
    vec2 dir = vec2(0.0);
    if (uAxis == 2) {
        vec2 r = vec2(Gtc) - uOrigin;
        float L = length(r);
        if (L < 0.5) { Frag = texelFetch(uTex, Gtc, 0); return; }   // 射线中心那一个像素没有方向
        dir = r / L;
    }
    float t = psCoord(Gtc);
    if (!psMember(t, dir)) { Frag = texelFetch(uTex, Gtc, 0); return; }
    // 块相位:逐行/逐射线各取一个 [0, Length) 里的起点。Jitter=0 时所有行对齐,画面就是整齐的横条。
    float band = (uAxis == 0) ? float(Gtc.y) : (uAxis == 1) ? float(Gtc.x)
        : atan(dir.y, dir.x) * (0.25 * uSize.x);
    float ph = floor(uJit * float(uLen) * psHash(vec2(band, uSeed + uPass * 13.7)));
    float cell0 = ph + floor((t - ph) / float(uLen)) * float(uLen);
    float cell1 = cell0 + float(uLen) - 1.0;
    float a = t;
    for (int i = 0; i < ${PS_MAX_LEN}; i++) {
        if (a <= cell0 || !psMember(a - 1.0, dir)) break;
        a -= 1.0;
    }
    float b = t;
    for (int i = 0; i < ${PS_MAX_LEN}; i++) {
        if (b >= cell1 || !psMember(b + 1.0, dir)) break;
        b += 1.0;
    }
    if (b - a + 1.0 < float(uMin)) { Frag = texelFetch(uTex, Gtc, 0); return; }
    float kt = texelFetch(uProbe, Gtc, 0).r;
    float rank = 0.0;
    for (int i = 0; i < ${PS_MAX_LEN}; i++) {
        float s = a + float(i);
        if (s > b) break;
        float k = texelFetch(uProbe, psAt(s, dir), 0).r;
        if (k < kt - 1e-4 || (abs(k - kt) <= 1e-4 && s < t)) rank += 1.0;
    }
    ivec2 src = psAt(uOrder > 0.0 ? a + rank : b - rank, dir);
    Frag = texelFetch(uTex, src, 0);
}`;

// ==================== pass ====================
function fxglPixelSort(col, p) {
    const gl = fxgl.gl;
    if (!p.length) return;
    const passes = Math.max(1, Math.min(PS_MAX_PASSES, p.passes | 0));
    const probe = fxgl.off[2];
    // 该层网格的中心,纹素坐标 (0.5 起算,与 gl_FragCoord 同一套)。
    const ox = (fxgl.w - 1) * 0.5, oy = (fxgl.h - 1) * 0.5;
    for (let pass = 0; pass < passes; pass++) {
        fxglRunPass(probe, fxgl.progs.psProbe, pr => {
            fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
            // 采样器不许指着没分配过层级的纹理 (同 fx/lighting.js、fx/chromatic_aberration.js)。
            fxglBindTex(pr, 'uMap', p.where === 'By map' ? fxgl.texMap : fxgl.off[col.slot].tex, 1);
            gl.uniform2f(fxglU(pr, 'uSize'), fxgl.w, fxgl.h);
            gl.uniform1i(fxglU(pr, 'uKey'), PS_KEYS.indexOf(p.key));
            gl.uniform1i(fxglU(pr, 'uWhere'), PS_WHERE.indexOf(p.where));
            gl.uniform1f(fxglU(pr, 'uEdge'), p.edge);
            gl.uniform1f(fxglU(pr, 'uCut'), p.cut / 100);
        });
        const dst = fxgl.off[1 - col.slot];
        fxglRunPass(dst, fxgl.progs.psSort, pr => {
            fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
            fxglBindTex(pr, 'uProbe', probe.tex, 1);
            gl.uniform2f(fxglU(pr, 'uSize'), fxgl.w, fxgl.h);
            gl.uniform2f(fxglU(pr, 'uOrigin'), ox, oy);
            gl.uniform1i(fxglU(pr, 'uAxis'), PS_AXES.indexOf(p.axis));
            gl.uniform1f(fxglU(pr, 'uThr'), p.thresh / 100);
            gl.uniform1f(fxglU(pr, 'uPol'), p.pol === 'below' ? -1 : 1);
            gl.uniform1i(fxglU(pr, 'uLen'), Math.max(1, Math.min(PS_MAX_LEN, p.length | 0)));
            gl.uniform1i(fxglU(pr, 'uMin'), Math.max(1, p.skip | 0));
            gl.uniform1f(fxglU(pr, 'uOrder'), p.order === 'desc' ? -1 : 1);
            gl.uniform1f(fxglU(pr, 'uJit'), p.jitter / 100);
            gl.uniform1f(fxglU(pr, 'uSeed'), p.seed);
            gl.uniform1f(fxglU(pr, 'uPass'), pass + 1);
        });
        col.slot = 1 - col.slot;
    }
}

// ==================== 参数区 ====================
// 一格一个 Pixel Sort:Axis 用分段钮 (与 Warp / 色散同一套词汇),下面只铺该模式要用的行。
// Length 与 Passes 直接决定抽样数,代价那句写在它们的 tooltip 里 (读数是给人看效果的, 不是看账单的)。
const PS_PARAMS = [
    { key: 'axis', label: 'Axis', kind: 'enum', options: PS_AXES, def: 'Along' },
    { key: 'key', label: 'Key', kind: 'enum', options: PS_KEYS, def: 'Luma' },
    { key: 'pol', label: 'Polarity', kind: 'enum', options: ['above', 'below'], def: 'above' },
    { key: 'thresh', label: 'Thresh', min: 0, max: 100, step: 1, def: 55, unit: '%' },
    { key: 'length', label: 'Length', min: 4, max: 64, step: 1, def: 32, unit: 'px',
        tip: 'Longest run one pass sorts. Cost \u2248 3 reads per pixel per Length, every pass.' },
    { key: 'skip', label: 'Skip', min: 1, max: 64, step: 1, def: 4, unit: 'px' },
    { key: 'order', label: 'Order', kind: 'enum', options: ['asc', 'desc'], def: 'asc' },
    { key: 'jitter', label: 'Jitter', min: 0, max: 100, step: 1, def: 25, unit: '%' },
    { key: 'seed', label: 'Seed', min: 0, max: 999, step: 1, def: 0 },
    { key: 'passes', label: 'Passes', min: 1, max: 3, step: 1, def: 1,
        tip: 'Re-sort its own output with a fresh block phase, so values cross the block border. Cost scales with this.' },
    { key: 'where', label: 'Where', kind: 'enum', options: PS_WHERE, def: 'Anywhere' },
    { key: 'edge', label: 'Edge', min: 0, max: 100, step: 1, def: 30, unit: '%',
        when: p => p.where === 'On edges' },
    { key: 'map', kind: 'map', def: null, when: p => p.where === 'By map' },
    { key: 'cut', label: 'Cut', min: 0, max: 100, step: 1, def: 50, unit: '%', when: p => p.where === 'By map' },
];

function psEditorEl(l, effect, syncRead, updaters) {
    const box = document.createElement('div');
    box.className = 'fx-sort';
    const tail = document.createElement('div');
    tail.className = 'fx-sort-tail';
    const build = () => {
        const p = effectParams(effect);
        tail.replaceChildren(...PS_PARAMS
            .filter(d => d.key !== 'axis' && (!d.when || d.when(p)))
            .map(d => fxControlRow(l, effect, d, syncRead, updaters)));
        syncRead();
    };
    // 模式行只多接一句「换完轴重铺剩下的行」—— 与 fx/warp.js、fx/chromatic_aberration.js 同一包法。
    box.appendChild(fxControlRow(l, effect, PS_PARAMS[0], () => { build(); }, updaters));
    box.appendChild(tail);
    build();
    return box;
}

defineEffect({
    type: 'pixel_sort',
    label: 'Pixel Sort',
    group: 'Glitch',
    icon: 'sort',
    needsMap: 'Noise',
    needsMapWhen: p => p.where === 'By map',
    desc: 'Takes the pixels that run brighter than Thresh along one direction \u2014 Along (each row), Across (each column) or Radial (each ray out of the middle of this layer) \u2014 and rewrites that stretch ordered by Key, so a bright streak drags its pixels into a ramp. Length is the longest run one pass orders; a longer stretch is cut into blocks of that length, each sorted on its own \u2014 which is what the staircase in the middle of a long streak is. Skip leaves runs shorter than itself alone, Jitter slides the block borders row by row so the cut stops lining up, and Passes re-order the result with a fresh phase, which walks values across the block border at three times the taps. On edges sorts only where the Key changes fast (the usual reading of the family), By map lets a bound map say which pixels may join a run at all. Whole pixels move, so opacity is dragged along with colour \u2014 a text layer sorts its own shape away.',
    params: PS_PARAMS,
    editor: psEditorEl,
    shaders: { psProbe: FX_FS_PS_PROBE, psSort: FX_FS_PS_SORT },
    run: fxglPixelSort,
    readout(p, n, effect) {
        const ax = p.axis === 'Along' ? 'h' : p.axis === 'Across' ? 'v' : 'rad';
        let s = `${ax} ${p.key} t${n(p.thresh)} L${n(p.length)}`;
        if (p.skip > 1) s += ` k${n(p.skip)}`;
        if (p.order === 'desc') s += ' \u2193';
        if (p.jitter) s += ` j${n(p.jitter)}`;
        if (p.passes > 1) s += ` \u00d7${p.passes}`;
        if (p.where === 'On edges') s += ` e${n(p.edge)}`;
        else if (p.where === 'By map') s += ` ${fxMapShort(effect)} c${n(p.cut)}`;
        return s;
    },
    thumb(g, box) {
        // 一条竖着的渐变带上,只有亮的那半被按块重排:每块内部由暗到亮接成斜坡,块与块之间留着台阶 ——
        // 「长 run 被切成一段段排好」就是这一族的样子,而门槛以下原样不动。
        const cols = 26;
        const cw = box.w / cols;
        for (let i = 0; i < cols; i++) {
            const x = box.x + i * cw;
            const t = i / (cols - 1);
            const bright = t > 0.55;
            for (let j = 0; j < 6; j++) {
                const y = box.y + box.h * (0.08 + 0.84 * j / 6);
                const hh = box.h * 0.84 / 6;
                const v = bright ? (((i % 7) * 6 + j) / 41) : t;
                const k = Math.round(0x18 + v * 0xd8);
                g.fillStyle = `rgb(${k},${Math.round(k * 0.85)},${Math.round(0x2a + k * 0.6)})`;
                g.fillRect(x, y + (bright ? -j * 1.2 : 0), Math.ceil(cw), hh);
            }
        }
    },
});
