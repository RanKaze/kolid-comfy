// fx/corrosion.js —— 特效链的一类特效:锈蚀 (Grunge 组)。会改图像 alpha 的那一族,注册数据与
// 三条地基契约见 fx/core.js;它能借用哪些缓冲见 fx/gl.js 顶部;绑定贴图的解析见 fx/maps.js。

// 锈蚀 = 「沿 alpha 轮廓往里咬」+「咬过的地方渗出锈色」。两件事各自有一个来源:
//   * 哪里咬得动 —— 把**图层自己的** alpha 低通 bias 像素 (fxglSilGauss, uHasMask 恒 0 ⇒ 契约 ③)。
//     低通在形状内部早就饱和成 1,只有贴近轮廓的那一圈 (以及本来就细于 bias 的笔画) 才掉下来,
//     所以拿它当闸门,破洞天然长在边缘上。bias 给的是**这条边缘带的量尺**,不是啃进去的像素数:
//     真机回读实测 (240² 版面、一块 120² 的方、同一把噪声、Amount 40) —— bias 10 咬出的距离分布
//     是 [0-4px:28 颗, 4-12px:0],bias 120 是 [337, 149, 0] ⇒ 带随 bias 变宽也变深,但深度只到
//     标称值的十分之一上下,因为闸门掉到 0.9 以下那点距离就饱和了。想往里啃得动要靠 Amount (见下)。
//   * 什么时候咬穿 —— 噪声 n 与闸门 m 组合成 field = n − m + 0.5,阈值 thr = 1 − Amount 判 cut。
//     深内部 (m=1) 要 n > 1.5 − Amount 才 cut ⇒ Amount 40% 时里子一颗都
//     咬不动,拧到顶才有半数跟上 (CPU 镜像逐 guard 量过: m=1 在 a20/a40/a60/a100 = 0/0/4/44%,
//     同一把噪声下 m=0.5 的边缘是 14/34/54/94%; 真机同一结论: 整片不透明的版面上白噪图 a40 一处
//     不咬、a100 全片咬穿) —— 边缘永远先烂,里子是后烂的那批。
// 噪声场三种来源,由 Mode 分段钮选:
//   * Gaussian —— 每个格子一颗「三颗均匀数取平均」的伪正态数 (Scale=1 就是逐像素白噪),
//     再用 Smooth 把它糊成斑块。格状 + 可糊 = PS 的 Clouds/Add Noise 那一族读法。
//   * FBM      —— 沿两条轴的多倍频程值噪声,Scale 是最**粗**那一档的格子大小,Oct 往上加细节。
//   * Texture  —— 用户自己上传的一张噪声图,读 **R 通道**,按 Scale/Offset 平铺重复 (fract)。
// 三种来源共用同一套坐标:先把该层网格的 texel 坐标翻成图像读法 (y 向下),投影到 Angle 给出的
// 两条轴 (0°=右、90°=下,与整条链的角度读法一致),再减去 Offset、除以 Scale ⇒ 轴向、两向缩放、
// 两向偏移全在这一个式子里,贴图那条路也不例外。
//
// 漏色 (leak) 不额外要一张距离场:破洞掩码 H = own × cut 低通 spread 像素就是「锈渗出去多远」。
// 于是渗色圈自动贴着**每一个**洞 (不管它在轮廓上还是在金属中间),而没被咬着的边缘一点锈都没有
// —— 差一份掩码就是一份算法,这里连那份减法都省了。大洞中心仍留一半浓度:锈是渗出来的,不是把
// 洞填满。Leak Side 决定这圈颜色准不准在「原本不透明」/「原本透明」的像素上 —— out 那一档会把
// alpha 长进本层网格里本来透明的像素,和 Outside 描边同一种合法外扩 (契约 ①:网格不动,框边照切,
// 想要余量就给文字层加 Padding)。蒙版仍然只在链外乘一次,所以「锈只出现在蒙版内」是推论,不是旋钮。

const CORR_MODES = ['Gaussian', 'FBM', 'Texture'];
const CORR_MODE_INDEX = { Gaussian: 0, FBM: 1, Texture: 2 };

// 只有该模式要用的行由 when 挡住,模式一换由编辑面重铺剩下的行 (同 fx/tone_map.js、fx/warp.js)。
// 长度单位一律**该层自己的像素**:角度按画布读法,偏移带符号 (往轴的正向为正)。
const CORR_PARAMS = [
    { key: 'mode', label: 'Mode', kind: 'enum', options: CORR_MODES, def: 'Gaussian' },
    { key: 'seed', label: 'Seed', min: 0, max: 999, step: 1, def: 0, when: p => p.mode !== 'Texture' },
    { key: 'oct', label: 'Oct', min: 1, max: 4, step: 1, def: 3, when: p => p.mode === 'FBM' },
    { key: 'smooth', label: 'Smooth', min: 0, max: 64, step: 1, def: 8, unit: 'px', when: p => p.mode === 'Gaussian' },
    { key: 'map', label: 'Map', kind: 'map', def: null, when: p => p.mode === 'Texture' },
    { key: 'angle', label: 'Angle', min: 0, max: 359, step: 1, def: 0, unit: '°' },
    { key: 'scaleU', label: 'Scale Along', min: 1, max: 256, step: 1, def: 40, unit: 'px' },
    { key: 'scaleV', label: 'Scale Across', min: 1, max: 256, step: 1, def: 40, unit: 'px' },
    { key: 'offsetU', label: 'Shift Along', min: -256, max: 256, step: 1, def: 0, unit: 'px' },
    { key: 'offsetV', label: 'Shift Across', min: -256, max: 256, step: 1, def: 0, unit: 'px' },
    { key: 'amount', label: 'Amount', min: 0, max: 100, step: 1, def: 40, unit: '%' },
    { key: 'bias', label: 'Bias', min: 1, max: 256, step: 1, def: 20, unit: 'px' },
    { key: 'feather', label: 'Feather', min: 0, max: 100, step: 1, def: 25, unit: '%' },
    { key: 'leak', label: 'Leak', min: 0, max: 100, step: 1, def: 45, unit: '%' },
    { key: 'leakColor', label: 'Rust', kind: 'color', def: '#8a4a26' },
    { key: 'spread', label: 'Spread', min: 0, max: 128, step: 1, def: 24, unit: 'px' },
    { key: 'side', label: 'Leak Side', kind: 'enum', options: ['in', 'out', 'both'], def: 'both' },
];

// 三种模式共用的那份取坐标函数 (整条链里只有这一处给噪声建轴,故起名带 corr 前缀,不与 fx/warp.js
// 的 warpHash/warpNoise 抢名字 —— 全局词法作用域里撞名是整页 SyntaxError)。
const CORR_GLSL_AXES = `
vec2 corrAxes(vec2 size, float ca, float sa, vec2 cell, vec2 shift) {
    // vUV/uTexel 是纹理坐标 (GL 的 y 向上,上传时已翻),图像读法要翻回来一次 ⇒ 0° 右、90° 下。
    vec2 img = vec2(vUV.x * size.x, size.y - vUV.y * size.y);
    vec2 rot = vec2(dot(img, vec2(ca, sa)), dot(img, vec2(-sa, ca)));
    return (rot - shift) / max(cell, vec2(1.0));
}`;

// 三种来源都写进 alpha:借用面只认 alpha (fxglBox 的 uAlphaOnly=1 那一族低通才接得上)。
const FX_FS_CORR_FIELD = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uMap;
uniform vec2 uSize;
uniform float uAngle;
uniform vec2 uScale;
uniform vec2 uOff;
uniform float uSeed;
uniform int uOct;
uniform int uMode;
float corrHash(vec2 p) {
    p = fract(p * vec2(0.1031, 0.1030));
    p += dot(p, p + 23.13);
    return fract(p.x * p.y * 45.73);
}
${CORR_GLSL_AXES}
float corrCell(vec2 q) {
    // 三颗均匀数取平均:分布往中间挤,摆回 0..1 后是颗歪歪的正态。
    float a = corrHash(q + vec2(uSeed, uSeed * 1.7 + 3.1));
    float b = corrHash(q + vec2(uSeed * 2.3 + 17.7, uSeed + 7.3));
    float c = corrHash(q + vec2(uSeed - 5.1, uSeed * 3.1 + 23.9));
    return (a + b + c) / 3.0;
}
float corrVnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = corrHash(i + vec2(uSeed, uSeed * 0.7));
    float b = corrHash(i + vec2(uSeed + 1.0, uSeed * 0.7));
    float c = corrHash(i + vec2(uSeed, uSeed * 0.7 + 1.0));
    float d = corrHash(i + vec2(uSeed + 1.0, uSeed * 0.7 + 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main() {
    if (uMode == 2) {
        // 贴图档:平铺重复读 R 通道。fract 之后落回纹素中心再采,否则线性滤波会在接缝上把
        // 贴图另一头的纹素混进来 (那正是无缝噪声图最不该露馅的一条边)。
        // q 的 V 轴按图像读法向下 (0°=右、90°=下),而贴图是 FLIP_Y 上传的 v 向上 —— 行序要镜像
        // 一次,用户上传的那张图才以他看到的方向落在图层上 (与整条链直接在 vUV 上采图一致)。
        vec2 q = corrAxes(uSize, cos(uAngle), sin(uAngle), uScale, uOff);
        vec2 ms = vec2(textureSize(uMap, 0));
        vec2 c = floor(fract(q) * ms);
        c.y = ms.y - 1.0 - c.y;
        vec2 tc = (c + 0.5) / ms;
        Frag = vec4(0.0, 0.0, 0.0, texture(uMap, tc).r);
        return;
    }
    if (uMode == 1) {
        // FBM:Scale 是**最粗那一档**的格子大小,每加一个倍频程格子减半、幅度乘 0.5,最后除以
        // 总幅值 ⇒ 不管几档,结果都稳稳落在 0..1 (不除的话高档数会把对比度顶出界)。
        vec2 q = corrAxes(uSize, cos(uAngle), sin(uAngle), uScale, uOff);
        float sum = 0.0, amp = 1.0, tot = 0.0, k = 1.0;
        for (int o = 0; o < 4; o++) {
            if (o >= uOct) break;
            sum += amp * corrVnoise(q * k);
            tot += amp;
            amp *= 0.5;
            k *= 2.0;
        }
        Frag = vec4(0.0, 0.0, 0.0, sum / max(tot, 1e-4));
        return;
    }
    // Gaussian:一颗格子里一个值 (Scale=1 就是逐像素白噪),Smooth 那一步再把它糊开。
    vec2 q = corrAxes(uSize, cos(uAngle), sin(uAngle), uScale, uOff);
    Frag = vec4(0.0, 0.0, 0.0, corrCell(floor(q)));
}`;

// 破洞掩码:H = own × cut,只写 alpha。own 是**进来这一刻**的不透明度 (链前面几环可能已经重塑过
// 它,契约 ②),闸门读的是刚算好的那份饱和低通,两者都是同一张网格上的像素,不需要谁迁就谁。
const FX_FS_CORR_HOLES = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uField;
uniform sampler2D uGuard;
uniform float uThr;
uniform float uSpan;
void main() {
    float own = texture(uTex, vUV).a;
    if (own <= 0.0) { Frag = vec4(0.0); return; }
    float n = texture(uField, vUV).a;
    float m = clamp(texture(uGuard, vUV).a, 0.0, 1.0);
    float f = n - m + 0.5;
    Frag = vec4(0.0, 0.0, 0.0, own * smoothstep(uThr, uThr + uSpan, f));
}`;

// 合成:先按 H 把 alpha 咬掉 (keep = own − H),再把渗色那圈锈 source-over 垫上去。两条带都从
// 同一份 H 来,所以漏色永远贴着破洞;大洞中心乘 (1 − 0.5H) 留一半浓度,免得 Amount 一高整层被
// 锈糊平。锈是**盖在上头的一层漆** (和 fx/stroke.js 的 Inside 那一路同一条代数),不是「把咬掉的
// 不透明度补回来」—— 只补 alpha 的话,原本全不透明的金属一格都染不上色,而渗色圈恰恰要染的就是它。
// Leak Side 决定这层漆准不准落在「原本不透明」/「原本透明」的像素上 —— out 那一档会把
// alpha 长进本层网格里本来透明的像素,和 Outside 描边同一种合法外扩 (契约 ①:网格不动,框边照切,
// 想要余量就给文字层加 Padding)。蒙版仍然只在链外乘一次,所以「锈只出现在蒙版内」是推论,不是旋钮。
const FX_FS_CORR = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uHoles;
uniform sampler2D uBled;
uniform vec3 uRust;
uniform float uLeak;
uniform float uInOn;
uniform float uOutOn;
void main() {
    vec4 c = texture(uTex, vUV);
    float own = c.a;
    float h = clamp(texture(uHoles, vUV).a, 0.0, 1.0);
    float bled = clamp(texture(uBled, vUV).a, 0.0, 1.0);
    float keep = clamp(own - h, 0.0, 1.0);
    float on = step(0.5, own);
    float gate = uInOn * on + uOutOn * (1.0 - on);
    float s = clamp(bled * (1.0 - 0.5 * h) * uLeak * gate, 0.0, 1.0);
    float a = s + keep * (1.0 - s);
    vec3 rgb = (uRust * s + c.rgb * keep * (1.0 - s)) / max(a, 1e-4);
    Frag = vec4(clamp(rgb, 0.0, 1.0), clamp(a, 0.0, 1.0));
}`;

function corrModeIndex(mode) {
    return CORR_MODE_INDEX[mode] === undefined ? 0 : CORR_MODE_INDEX[mode];
}

function corrLeakSides(side) {
    if (side === 'in') return [1, 0];
    if (side === 'out') return [0, 1];
    return [1, 1];                 // both —— 认不出的值也走它,和 fx/stroke.js 同一纪律
}

function fxglCorrosion(col, p) {
    // Amount=0 ⇒ 一颗洞都没有,渗色是从洞来的,整条直接原样返回 (跑不动的特效自己说原因,引擎不管)。
    if (p.amount <= 0) return;
    const gl = fxgl.gl;
    const idx = corrModeIndex(p.mode);
    // 借用面全程 2/3/4 轮换,一张都不新配 (显存预算见 fx/gl.js 顶部)。每一趟都重写,所以和同链里
    // 的阴影/描边/景深/泛光互不污染。终点布局:2 = 破洞 H、4 = 渗色 Hb,合成读这两张 + 色彩。
    // ① 形状 = 图层 alpha (uHasMask 恒 0,契约 ③) → 2 号面。
    fxglRunPass(fxgl.off[2], fxgl.progs.sil, pr => {
        fxglBindTex(pr, 'uSrc', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uMask', fxgl.texMask, 1);
        gl.uniform1i(fxglU(pr, 'uHasMask'), 0);
    });
    // ② 边缘闸门:把形状低通 Bias 像素 → 4 号面 (3 号面只是那两趟的中转,下一趟就被噪声场盖掉)。
    fxglSilGauss(p.bias);
    // ③ 噪声场 → 3 号面 (uMode 那三个分支都只写 alpha;贴图档在 needsMapWhen 为真时才被引擎备好)。
    // 场那份坐标:角度换成弧度,Scale/Offset 按该层像素原样下给着色器。
    fxglRunPass(fxgl.off[3], fxgl.progs.corrField, pr => {
        fxglBindTex(pr, 'uMap', fxgl.texMap, 0);
        gl.uniform2f(fxglU(pr, 'uSize'), fxgl.w, fxgl.h);
        gl.uniform1f(fxglU(pr, 'uAngle'), p.angle * Math.PI / 180);
        gl.uniform2f(fxglU(pr, 'uScale'), p.scaleU, p.scaleV);
        gl.uniform2f(fxglU(pr, 'uOff'), p.offsetU, p.offsetV);
        gl.uniform1f(fxglU(pr, 'uSeed'), p.seed);
        gl.uniform1i(fxglU(pr, 'uOct'), Math.round(p.oct));
        gl.uniform1i(fxglU(pr, 'uMode'), idx);
    });
    // ④ 白噪那一档的 Smooth:格状噪声糊成斑块。借刚用完的 2 号面当中转,场还落回 3 号面。
    if (idx === 0 && p.smooth > 0) fxglSilGauss(p.smooth, 3, 2, 3);
    // ⑤ 破洞掩码 H → 2 号面 (形状已被闸门吃过,可以覆盖了)。
    const thr = 1 - p.amount / 100;
    fxglRunPass(fxgl.off[2], fxgl.progs.corrHoles, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uField', fxgl.off[3].tex, 1);
        fxglBindTex(pr, 'uGuard', fxgl.off[4].tex, 2);
        gl.uniform1f(fxglU(pr, 'uThr'), thr);
        // edge0 == edge1 的 smoothstep 在 GLSL 里是未定义的,所以留一个极小宽度当硬边。
        gl.uniform1f(fxglU(pr, 'uSpan'), Math.max(1e-3, p.feather / 200));
    });
    // ⑥ 渗色 = 把 H 低通 Spread 像素 → 4 号面 (3 号面的场刚被 H 用完,正好当中转)。
    // Spread=0 要的是「一点都不渗」,而最低档低通也有 1.4 px 的抽样步长 (n 夹在 1 起),所以那一档
    // 走 uIter=0 的恒等拷贝 —— 那时 Hb 就是 H,锈只落在洞里 (×0.5),边缘一圈不沾。
    if (p.spread > 0) fxglSilGauss(p.spread, 2, 3, 4);
    else fxglBox(fxgl.off[4], fxgl.off[2].tex, 0, 0, 0, true, 0);
    // ⑦ 合成。
    const sides = corrLeakSides(p.side);
    const dst = fxgl.off[1 - col.slot];
    fxglRunPass(dst, fxgl.progs.corrosion, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uHoles', fxgl.off[2].tex, 1);
        fxglBindTex(pr, 'uBled', fxgl.off[4].tex, 2);
        gl.uniform3f(fxglU(pr, 'uRust'), ...fxHexToRgb01(p.leakColor));
        gl.uniform1f(fxglU(pr, 'uLeak'), p.leak / 100);
        gl.uniform1f(fxglU(pr, 'uInOn'), sides[0]);
        gl.uniform1f(fxglU(pr, 'uOutOn'), sides[1]);
    });
    col.slot = 1 - col.slot;
}

// 模式一换要用的参数行就换一批,所以这块面板自己铺行;每行仍是通用的 fxControlRow,默认值/
// 读数/undo 语义和其它特效完全一致 (同 fx/warp.js、fx/tone_map.js 的写法)。
function corrosionEditorEl(l, effect, syncRead, updaters) {
    const box = document.createElement('div');
    box.className = 'fx-corrosion';
    const tail = document.createElement('div');
    tail.className = 'fx-corrosion-tail';

    function build() {
        const p = effectParams(effect);
        tail.replaceChildren(...CORR_PARAMS
            .filter(d => d.key !== 'mode' && (!d.when || d.when(p)))
            .map(d => fxControlRow(l, effect, d, syncRead, updaters)));
        syncRead();
    }
    // 第一行那颗分段钮照旧走通用控件,只多接一句「换完模式重铺剩下的行」。
    box.appendChild(fxControlRow(l, effect, CORR_PARAMS[0], () => { build(); }, updaters));
    box.appendChild(tail);
    build();
    return box;
}

defineEffect({
    type: 'corrosion',
    label: 'Corrosion',
    group: 'Grunge',
    icon: 'corrosion',
    needsMap: 'Noise',
    needsMapWhen: p => p.mode === 'Texture',
    desc: 'Eat the layer\u2019s alpha away along its own outline and bleed rust out of every hole. Where it bites is measured from the alpha contour, so a thick shape\u2019s edges go first while its interior holds, and the interior only starts to follow once Amount is pushed past the middle of its range \u2014 Amount says how much gets eaten, Bias is the radius of the edge zone that measurement runs over (a thin stroke is all edge, so it corrodes first; the zone itself reaches inward only about a tenth of that radius). The holes are placed by a noise field: Gaussian (a random value per cell, clouded by Smooth), FBM (multi-octave value noise), or a Noise map you bind and tile. Angle rotates the field\u2019s two axes, and Scale/Shift work along and across them separately, all in this layer\u2019s own pixels. Leak paints rust over the eaten boundary \u2014 over intact metal too, not just inside the holes \u2014 Spread is how far it bleeds, and Leak Side says whether it stains the metal, grows into the transparent margin around it (that needs clear room inside the layer box \u2014 a text layer gets it from Padding), or both.',
    params: CORR_PARAMS,
    editor: corrosionEditorEl,
    shaders: { corrField: FX_FS_CORR_FIELD, corrHoles: FX_FS_CORR_HOLES, corrosion: FX_FS_CORR },
    run: fxglCorrosion,
    readout(p, n, effect) {
        const src = p.mode === 'Texture' ? fxMapShort(effect) : `${p.mode.toLowerCase()}#${p.seed}`;
        const side = p.side === 'both' ? '' : `  ${p.side}`;
        return `${src}  a${n(p.amount)}  b${n(p.bias)}  ${n(p.scaleU)}\u00d7${n(p.scaleV)}@${n(p.angle)}\u00b0  l${n(p.leak)}${side}`;
    },
    thumb(g, box) {
        // 一块边被咬缺的砖:锈色圈贴着洞,砖自己少了两块 —— 破洞和渗色是同一件事的两半。
        const x = box.x + 6, y = box.y + 6, w = box.w - 12, h = box.h - 12;
        g.fillStyle = '#6f8cff';
        g.fillRect(x, y, w, h);
        const holes = [[0.52, 0.06, 0.2, 0.26], [0.1, 0.62, 0.26, 0.3]];
        for (const q of holes) {
            const hx = x + q[0] * w, hy = y + q[1] * h, hw = q[2] * w, hh = q[3] * h;
            g.strokeStyle = 'rgba(196,102,44,0.95)';
            g.lineWidth = 3;
            g.strokeRect(hx - 1.5, hy - 1.5, hw + 3, hh + 3);
            g.fillStyle = '#231a16';
            g.fillRect(hx, hy, hw, hh);
            g.fillStyle = '#6f8cff';
        }
        g.strokeStyle = 'rgba(196,102,44,0.85)';
        g.lineWidth = 3;
        g.setLineDash([7, 5]);
        g.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3);
        g.setLineDash([]);
    },
});
