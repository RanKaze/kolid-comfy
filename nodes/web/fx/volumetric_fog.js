// fx/volumetric_fog.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图。
// 它绑一张深度图 (needsMap),引用的解析规则见 fx/maps.js;「Align: Canvas / Local」那条基也在 maps.js
// (fxMapFrame),几何 Warp 读的是同一句话。

// 体积雾:逐像素沿视线**步进**到深度图报出的那个面。取样点 = rd·λ (λ 是视轴深度,rd 是这条像素的
// 视线方向),每一步按自己**那一刻的高度**取浓度 σ(λ) = exp(−(h−Floor)/Fall),把 σ·弧长 累成光学厚度,
// 前向逐步吸收 (front-to-back): T·= e^−τ,同时把该步的散射按 T·(1−e^−τ) 累进画面。于是雾是**沿路径积分**
// 出来的,而不是把深度值映到一条 0..1 的渐变上 —— 近处像素的路径本来就短,它自动就清,不需要再拿
// Start/End 假造一条净空带 (旧的那版就是这么干的,所以远处的雾永远是一层平色)。
// 深度只读 R 通道 (与景深同一条读法) 且**每像素只读一次**: 视线是从眼出发经过这个像素的射线,所以射线
// 上任何一点重投影回画面都落在同一个纹素 (眼天生在这条线上),逐步重读拿到的是同一个数 —— 步进到面的
// 终止条件就是那个面自己的 λ,不必再比 N 次。真正"每步都要读图"的是往光源那侧的自阴影 (光柱),那不在
// 这颗特效要做的事里。
// 高度用画面单位, 但沿**重力轴**量: h(λ) = 0.5 − dot(rd.xy, uDown)·λ。uDown 默认 (0,-1) (画面往下),
// 此时与旧式 h = rd.y·λ + 0.5 逐位相同; 绑了 Direction attribute 当重力, 这条轴就换成箭头投在画布
// 平面上的影子 (箭头指向雾最浓的那一侧) —— 太阳 (散射亮边) 同理可绑。λ=1 (画面本身) 处 h 就是
// 沿该轴的屏幕位置,所以 Floor/Height 的读法不变;往下看的视线 λ 增大时 h 走低 ⇒ 越探越浓 —— 这条
// 不对称正是高度雾该有的样子,也只有步进才能得到它 (闭式那版里高度与深度是乘在一起的,分不开)。
// 每一步的落点用一个逐像素抖动推开 (否则步与步之间会排成可见的带),Steps 只影响这份颗粒度与代价。
// 出射 = 本色 × T + 累进的散射;散射色乘 Henyey-Greenstein 相位 (除以自己的侧向值,所以 g=0 时恒为 1,
// 颜色不会被相位自己拽亮或拽暗),朝向 Sun 的一侧亮起来。只改 RGB、alpha 原样、不读蒙版 —— 三条契约照守。
const FX_FS_FOG = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uMap;
uniform vec3 uColor;
uniform vec2 uSun;
uniform vec2 uDown;
uniform vec2 uMapU;
uniform vec2 uMapV;
uniform vec2 uMapB;
uniform float uInv;
uniform float uReach;
uniform float uDensity;
uniform float uFall;
uniform float uFloor;
uniform float uG;
uniform float uAspect;
uniform int uSteps;
float fogDither(vec2 p) {
    p = fract(p * vec2(0.1031, 0.1030));
    p += dot(p, p + 23.13);
    return fract(p.x * p.y * 45.73);
}
void main() {
    vec4 c = texture(uTex, vUV);
    // 视轴深度: 贴图说这个像素的表面在多远。默认极性下地图越亮越远 (与景深同一条读法),
    // Near=bright 就把整条翻过来。夹进 0..1 是为了让越界的那点噪声不会把面推到身后。
    float d = texture(uMap, uMapU * vUV.x + uMapV * vUV.y + uMapB).r;
    float far = clamp(uInv > 0.5 ? 1.0 - d : d, 0.0, 1.0);
    float surf = uReach * far;
    if (surf <= 0.0) { Frag = c; return; }
    vec3 rd = vec3((vUV - 0.5) * vec2(uAspect, 1.0), 1.0);
    float arc = length(rd);                       // 视轴走 1 个单位 = 弧长 arc
    // 相位只跟"这条视线朝哪儿"有关,沿路径不变,所以算一次就够。
    float mu = clamp(dot(rd.xy, uSun) / arc, -1.0, 1.0);
    float g2 = uG * uG;
    float hg = clamp(pow((1.0 + g2) / max(1.0 + g2 - 2.0 * uG * mu, 1e-3), 1.5), 0.0, 3.0);
    vec3 scat = uColor * hg;
    float dt = surf / max(float(uSteps), 1.0);    // uSteps 万一没被设上 (uniform 名打错就是 null
                                                  // location, 无声取 0) 也拿不到 inf/NaN
    float jit = fogDither(vUV * 719.0);
    float T = 1.0;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 32; i++) {                // 32 = Steps 的上界,常数次循环是 ESSL 的规矩
        if (i >= uSteps) break;
        float lam = (float(i) + jit) * dt;        // jit < 1 ⇒ 最后一步也还在面之前,不会穿过它
        // 高度沿重力轴量: h(λ) = 0.5 − dot(rd.xy, uDown)·λ。uDown = (0,-1) (画面往下) 时与旧式
        // rd.y·λ + 0.5 逐位相同 —— 绑了 Direction attribute 后这条轴跟着箭头的画布投影走。
        float sigma = exp(-max(0.5 - dot(rd.xy, uDown) * lam - uFloor, 0.0) / uFall);
        float tau = uDensity * sigma * dt * arc;
        float atten = exp(-tau);                  // 这一步透过去的比例
        acc += scat * (T * (1.0 - atten));        // 这一步新贡献的散射,按到达时的 T 计
        T *= atten;
    }
    Frag = vec4(clamp(c.rgb * T + acc, 0.0, 1.0), c.a);
}`;

// 绑定的 Direction attribute → 屏幕上的一个方向 (uv 基 y 朝上): 箭头投到画布平面再归一。
// 这两个读法 (重力/太阳) 与 run 各要一次、stamp/readout 也要,所以独立成句。悬空 (那枚被删了)
// 或垂直于画布 (扎进/冲外,投影长度趋零) 回 null —— 默认是什么是调用方自己的事。
function fxFogVec(effect, ref) {
    const r = attrRecord(ref);
    if (!r || r.type !== 'direction' || !r.desc || !r.desc.rotation) return null;
    const f = qApply(r.desc.rotation, { x: 1, y: 0, z: 0 });
    const len = Math.hypot(f.x, f.z);
    if (len < 1e-3) return null;
    return { x: f.x / len, y: -f.z / len };
}

function fxglFog(col, p, effect, l) {
    const gl = fxgl.gl;
    if (p.density <= 0) return;
    const a = p.sun * Math.PI / 180;
    // 两个屏幕方向都让绑定的 Direction attribute 接管 (uv 基 y 朝上):
    //   重力 uDown = 箭头的画布平面投影, 箭头指向雾最浓 (地面) 那一侧; 默认 (0,-1) = 画面往下;
    //   太阳 uSun = 箭头投影归一, 箭头指向太阳; 悬空退回 Sun 旋钮。
    // 方向读在**层自己的 uv 空间**里 (与 Sun 旋钮同一条基) —— 层旋转时雾跟层走, 与深度图的
    // Local 对齐同一句话。
    const down = fxFogVec(effect, p.gravRef) || { x: 0, y: -1 };
    const sun = fxFogVec(effect, p.sunRef) || { x: Math.cos(a), y: -Math.sin(a) };
    const fr = fxMapFrame(p.align, l);
    const dst = fxgl.off[1 - col.slot];
    fxglRunPass(dst, fxgl.progs.fog, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uMap', fxgl.texMap, 1);
        gl.uniform3f(fxglU(pr, 'uColor'), ...fxHexToRgb01(p.color));
        gl.uniform2f(fxglU(pr, 'uSun'), sun.x, sun.y);
        gl.uniform2f(fxglU(pr, 'uDown'), down.x, down.y);
        gl.uniform2f(fxglU(pr, 'uMapU'), fr.u[0], fr.u[1]);
        gl.uniform2f(fxglU(pr, 'uMapV'), fr.v[0], fr.v[1]);
        gl.uniform2f(fxglU(pr, 'uMapB'), fr.b[0], fr.b[1]);
        gl.uniform1f(fxglU(pr, 'uInv'), p.near === 'bright' ? 1 : 0);
        gl.uniform1f(fxglU(pr, 'uReach'), p.reach / 100);
        // 浓度的刻度按**路径**计 (τ = uDensity × σ × 弧长),而归一化场景里满幅路径才 1 个单位长,
        // 所以这颗数要抬到 8 才压得住:4 的时候即使 Density/Reach 全拧到底,最远那点也只糊掉一半。
        gl.uniform1f(fxglU(pr, 'uDensity'), p.density / 100 * 8);
        // 夹一个下限:Fall 收到 0 时 exp(−h/0) 在 h=0 处是 NaN,整条视线当场没了雾。
        gl.uniform1f(fxglU(pr, 'uFall'), Math.max(p.height / 100, 1e-3));
        gl.uniform1f(fxglU(pr, 'uFloor'), p.base / 100);
        gl.uniform1f(fxglU(pr, 'uG'), p.g / 100);
        gl.uniform1f(fxglU(pr, 'uAspect'), fxgl.w / Math.max(fxgl.h, 1));
        gl.uniform1i(fxglU(pr, 'uSteps'), Math.max(4, Math.min(32, p.steps | 0)));
    });
    col.slot = 1 - col.slot;
}

defineEffect({
    type: 'fog',
    label: 'Volumetric Fog',
    group: 'Light',
    icon: 'fog',
    needsMap: 'Depth',
    desc: 'Marches the view ray from the eye to the surface a bound depth map reports, integrating extinction that thins exponentially with height above Floor and adding in-scatter toward Sun through a Henyey-Greenstein phase. Near pixels march a shorter path, so they clear on their own \u2014 no start/stop band to fake. Steps is the march\u0027s sample count. Bind a Direction attribute as Gravity and the height axis follows it: the arrow\u0027s shadow on the canvas plane becomes "down", so the fog pools on that side \u2014 leave it unbound and down is the bottom of the frame. Bind one as Sun dir and the bright side of the in-scatter follows the arrow the same way (an arrow pointing straight into or out of the canvas has no shadow on the plane, so each binding falls back to its default then). Colour only: alpha untouched, nothing moves.',
    params: [
        { key: 'map', kind: 'map', def: null },
        // 两枚 Direction attribute 引用 (fxDirModal 全项目检索后选一枚 guid): 重力接管"哪边是地面",
        // 太阳接管散射亮边。只存一句引用; 悬空 / 箭头垂直于画布时各自退回默认 (画面往下 / Sun 旋钮)。
        { key: 'gravRef', label: 'Gravity', kind: 'dir', def: null },
        { key: 'sunRef', label: 'Sun dir', kind: 'dir', def: null },
        { key: 'near', label: 'Near', kind: 'enum', options: ['bright', 'dark'], def: 'bright' },
        { key: 'align', label: 'Align', kind: 'enum', options: ['Canvas', 'Local'], def: 'Canvas' },
        { key: 'reach', label: 'Reach', min: 1, max: 100, step: 1, def: 60, unit: '%' },
        { key: 'steps', label: 'Steps', min: 4, max: 32, step: 1, def: 16 },
        { key: 'density', label: 'Density', min: 0, max: 100, step: 1, def: 45, unit: '%' },
        { key: 'height', label: 'Height', min: 1, max: 100, step: 1, def: 22, unit: '%' },
        { key: 'base', label: 'Floor', min: 0, max: 100, step: 1, def: 8, unit: '%' },
        // 绑了 Sun dir 这颗旋钮整个不出现 —— 亮边归 Direction attribute 管,面板里留着只会两说。
        { key: 'sun', label: 'Sun', min: 0, max: 359, step: 1, def: 315, unit: '°', when: p => !p.sunRef },
        { key: 'g', label: 'Aniso', min: -90, max: 90, step: 1, def: 40, unit: '' },
        { key: 'color', label: 'Fog', kind: 'color', def: '#cfe0f2' },
    ],
    shaders: { fog: FX_FS_FOG },
    run: fxglFog,
    // 旧存档的雾是「视程区间 Start..End」那条闭式渐变。步进之后 Start 这件事没有了 (近处天然淡),
    // 而旧 End 与新的 Reach 是同一件事 —— 雾铺到多远,所以把它原样搬过来,Start 丢掉。
    migrate(raw, out) {
        if (raw.end === undefined) return;
        out.reach = Math.max(1, Math.min(100, Number(raw.end) || 0));
    },
    // Canvas 对齐的雾吃的还是「该层盒子落在画布哪儿」,而拖图层既不改像素也不改 params。缓存身份
    // 必须知道这一件事,否则挪完层还在用挪之前算好的那份深度取样 —— 注册表为此留了 stamp 这个口子。
    // 绑定的 Direction attribute 同理: 它要是不在本层条带上, 代次键 (attrPaintGens) 看不见它转了
    // —— 把解析出的两个屏幕方向报进身份, 转一下 3D 小窗, 这条链当场重算。
    stamp(effect, l) {
        const p = effectParams(effect);
        let s = '';
        if (p.align === 'Canvas') {
            const tr = effectiveTransform(l);
            s += `${tr.cx.toFixed(4)},${tr.cy.toFixed(4)},${tr.w.toFixed(4)},${tr.h.toFixed(4)},${tr.rotation.toFixed(3)}|`;
        }
        const down = fxFogVec(effect, p.gravRef), sun = fxFogVec(effect, p.sunRef);
        if (down) s += `g${down.x.toFixed(3)},${down.y.toFixed(3)}|`;
        if (sun) s += `s${sun.x.toFixed(3)},${sun.y.toFixed(3)}|`;
        return s;
    },
    readout(p, n, effect) {
        // 六项:贴图名 对齐 步进长度 浓度 衰减厚度 太阳角。Steps 不报 (它只改颗粒度,不改雾的形状),
        // Floor/Aniso 也不报 (行宽有限,且它们挪的是同一条已经看得见的渐变的位置与朝向);
        // Near=bright 必须报,因为它决定整张图是近处清还是远处清。绑定了的方向带 ⤳ (太阳报解析出的
        // 画布角,重力以 ↓⤳ 一枚记号报到行尾 —— 行宽有限,方向本身去 3D 小窗看)。
        const sun = fxFogVec(effect, p.sunRef);
        const sa = sun ? dirWrap360(dirDeg(Math.atan2(-sun.y, sun.x))) : p.sun;
        return `${fxMapShort(effect)}  ${p.align === 'Local' ? 'local' : 'canvas'}  r${n(p.reach)}  ${n(p.density)}%  h${n(p.height)}  ${n(sa)}°${sun ? '\u2933' : ''}${p.near === 'bright' ? '  inv' : ''}${fxFogVec(effect, p.gravRef) ? '  \u2193\u2933' : ''}`;
    },
    thumb(g, box) {
        // 一条贴底、往上按指数散开的雾带 + 光源那一侧的一点亮:Height 就是这条带的厚度。
        const gr = g.createLinearGradient(0, box.y + box.h, 0, box.y);
        gr.addColorStop(0, 'rgba(207,224,242,0.92)');
        gr.addColorStop(0.34, 'rgba(207,224,242,0.42)');
        gr.addColorStop(1, 'rgba(207,224,242,0)');
        g.fillStyle = gr;
        g.fillRect(box.x, box.y, box.w, box.h);
        const sx = box.x + box.w * 0.74, sy = box.y + box.h * 0.24, r = Math.min(box.w, box.h) * 0.85;
        const sun = g.createRadialGradient(sx, sy, 0, sx, sy, r);
        sun.addColorStop(0, 'rgba(255,246,224,0.55)');
        sun.addColorStop(1, 'rgba(255,246,224,0)');
        g.fillStyle = sun;
        g.fillRect(box.x, box.y, box.w, box.h);
    },
});
