// fx/ssr.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图 (Reflect 组)。
// 屏幕空间反射:**反射面是一枚 Plane attribute** —— 面的法线 (姿态把 +X 送到哪儿) 就是镜子的朝向,
// 在 Direction 小窗里对着画面拧;绑来的**深度图当一块浮雕** (高度 = Near 极性翻一次, 满幅 = Relief px),
// 视线垂直往下看。**镜面反射**:镜面方向 = 视线 (0,0,-1) 对**面法线**的反射 —— 一面平镜, 方向只此一份;
// 法线图 (可选) **不参与方向**, 只**提示几何**: 在命中取样处按镜面细部的坡度平移取样位置 (Detail 控
// 强度, 偏移随命中距离长 —— 与透视一致), Detail=0 = 完美平镜。
// 拧完反射往哪边找由镜面反射自己说:面法线倒向画面上方 (地板背离去) 时, 反射沿画面往上找。
// 找的过程就是 depth test:反射 ray 从自身地表高度 d0 出发, 沿反射方向在网格上步进 Steps 步、最远
// Reach px, 每步拿深度场和 ray 高度比 —— 地形高过 ray 的第一处把 ray 挡住 (前面的东西把反射裁掉),
// 命中点再二分 4 次磨掉台阶;走满了也没撞到 = 什么都没照见, 原样。Jitter 用确定性整数 hash 把起步
// 相位抖开 (条带从这里来), Seed 换抖动的花样;反射色按命中点自己的 alpha 加权 (透明处没有东西可照),
// 出口只写 RGB —— 反射不重塑形状, alpha 是这个像素自己的 (契约 ②)。
// 反射面没绑 = 整条跳过并在链上说一句 (镜子没有朝向可言, 不许静默地拿平镜顶替);面法线背对/侧对
// 视线 = 照不见任何东西, 同样说一句。

const FX_FS_SSR = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uMap;
uniform sampler2D uNormal;
uniform vec2 uMapU;
uniform vec2 uMapV;
uniform vec2 uMapB;
uniform vec2 uStep;      // 每步在两轴各自的 uv 步长 (方向已折进符号)
uniform float uStepPx;   // 每步走多少层像素
uniform float uRelief;   // 满幅深度折多少层像素高
uniform vec3 uMirror;    // 反射面法线 (画面像素空间: x 右 y 下 z 朝读者, 单位) —— 来自 Plane attribute
uniform vec3 uAnchor;    // 面锚点: (u·w, v_geo·h) 像素 + 锚点处的归一高度 (画布平面 = 1.0)
uniform vec2 uSize;      // 层面尺寸 (px)
uniform float uDetail;   // 法线图微扰动的强度 (0 = 纯平镜; 没绑法线图时引擎传 0)
uniform int uSteps;
uniform float uJitter;   // 0..1: 起步相位抖多少步
uniform int uSeed;
uniform float uMix;
uniform float uFade;
uniform float uNearBright;
uniform float uPreview;  // 预览模式: 镜面可见区域以白色绘制在图层上 (被地形埋掉的原样)
uniform vec3 uSky;       // 未命中的反射 ray 照到的是天空: 返回这份天光色
// 同 fx/noise.js 的整数散列 —— fp32 的 fract 类散列在这里会塌成可见结构, 不再用。
float ssrH(ivec2 t, int c) {
    uint h = uint(t.x) * 73856093u ^ uint(t.y) * 19349663u ^ uint(c) * 83492791u ^ uint(uSeed) * 2654435761u;
    h = (h ^ (h >> 16u)) * 0x7feb352du;
    h = (h ^ (h >> 15u)) * 0x846ca68bu;
    return float(h >> 8u) * (1.0 / 16777216.0);
}
// 高度场: 近 = 高 (与 fx/warp.js 的 warpHeight 同一条读法), 落点走 fxMapFrame 那条仿射基。
float ssrDepth(vec2 uv) {
    float d = texture(uMap, uMapU * uv.x + uMapV * uv.y + uMapB).r;
    return uNearBright > 0.5 ? d : 1.0 - d;
}
void main() {
    ivec2 tc = ivec2(gl_FragCoord.xy);
    vec4 own = texelFetch(uTex, tc, 0);
    if (uMix <= 0.0) { Frag = own; return; }
    vec2 fr0 = uMapU * vUV.x + uMapV * vUV.y + uMapB;
    // 镜面在**本像素**的高度: 视线沿深度入画, 与面的交点就是反射发生的地方 —— 面的位置 (u,v,h) 与
    // 倾角在这里进场: 倾斜的面让高度沿画面呈梯度, 挪锚点让梯度整体滑动。像素的屏幕 y 向下 =
    // (1-vUV.y)·uH (采样空间的 v=0 是画面底, 实测); 高度表 = ssrDepth 的 0..1 (= 0..Relief px)。
    float pxX = vUV.x * uSize.x;
    float pxY = (1.0 - vUV.y) * uSize.y;
    float mh = uAnchor.z - (uMirror.x * (pxX - uAnchor.x) + uMirror.y * (pxY - uAnchor.y))
             / (uMirror.z * uRelief);
    // 面被地形埋掉 (这里的地形比镜面更靠近读者) = 看不见这面镜子, 谈不上反射。
    if (ssrDepth(vUV) >= mh) { Frag = own; return; }
    // 预览: 镜面可见的像素都有输出 (命中 = 场景色, 未命中 = 天光), 白 = 这里有反射输出。
    if (uPreview > 0.5) { Frag = vec4(1.0, 1.0, 1.0, own.a); return; }
    // 镜面反射:方向**只**由 Plane attribute 的法线决定 —— 一面平镜, 法线图不弯折它。
    vec3 refl = reflect(vec3(0.0, 0.0, -1.0), uMirror);
    float rl = length(refl.xy);
    // 垂直入画的视线经镜面反射: 面离正面不足 45° (refl.z ≥ 0) 时 ray 折回读者这一侧 —— 镜子里
    // 是画面**背后**的东西, 画面里没有, 返天光;倾过 45° (refl.z < 0) ray 才向画面深处走, 下面的
    // march 让它一边上行一边**沉入场景** (rise < 0), 撞上前方隆起的地形 = 远山的倒影。
    if (rl < 1e-4 || refl.z >= 0.0) { Frag = vec4(mix(own.rgb, uSky, uMix), own.a); return; }
    // 方向在画面像素空间里各向同性, 落到 uv 按两轴各自的像素数除 (同 fx/rgb_split.js 的 rsOffset)。
    // gain = refl.z/rl 在倾过 45° 的姿态下为**负**: ray 一边上行一边向场景深处沉 (高度递减),
    // 地形从 ray 头顶冒出来把它拦住 —— 那才是远山的倒影。
    vec2 duv = (refl.xy / rl) * uStep;
    float gain = refl.z / rl;                          // 每水平 px 的高度增益 (负 = 向场景深处沉)
    float rise = gain * uStepPx / max(uRelief, 1.0);   // 每步 ray 在归一高度上沉多少
    float jit = (ssrH(tc, 0) - 0.5) * uJitter;
    float tLo = 0.0, tHi = -1.0;
    for (int k = 1; k <= 32; k++) {
        if (k > uSteps) break;
        float t = float(k) + jit;
        vec2 p = vUV + duv * t;
        if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) break;
        if (ssrDepth(p) >= mh + rise * t) { tHi = t; break; }
        tLo = t;
    }
    if (tHi < 0.0) {
        // 未命中 = 这条反射 ray 照到的是天空: 返回天光色 (不吃 Fade —— 天在无穷远), Mix 照常管浓度。
        Frag = vec4(mix(own.rgb, uSky, uMix), own.a);
        return;
    }
    // 二分精修: 命中点定在「最后一个未撞」与「第一个撞上」之间, 步进的台阶感从这里磨掉。
    for (int r = 0; r < 4; r++) {
        float tm = (tLo + tHi) * 0.5;
        vec2 p = vUV + duv * tm;
        if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) break;
        if (ssrDepth(p) >= mh + rise * tm) tHi = tm; else tLo = tm;
    }
    // 采样 = 命中点自己的像素。法线图在这里**提示几何**: 镜面上的细部坡度让反射的取样位置平移
    // (坡度 × 命中距离 × 2 = 镜面双角的偏折), 方向本身不动 —— 远处的偏移更大, 与透视一致;
    // Detail=0 或没绑法线图 = 完美平镜。
    vec2 hitUv = vUV + duv * tHi;
    if (uDetail > 0.0) {
        vec3 raw = texture(uNormal, fr0).xyz * 2.0 - 1.0;
        hitUv += uDetail * vec2(raw.x, -raw.y) * uStep * (2.0 * tHi);
    }
    vec4 hit = texture(uTex, hitUv);
    float w = uMix * hit.a * (1.0 - uFade * clamp(tHi / float(uSteps), 0.0, 1.0));
    Frag = vec4(mix(own.rgb, hit.rgb, w), own.a);
}`;

// 反射面:绑定的 Plane attribute —— 法线 (姿态把 +X 送到哪儿) 与**位置** (u, v, h) 都算数:
// 法线定镜子的朝向, 位置定镜子在画面里的高低与水线 (h=0 = 画布平面 = 深度浮雕的最近端;
// h 往负拧 = 面沉进场景, 反射区域随之变化)。法线换进画面像素空间 (x 右、y 下、z 朝读者) =
// (f.x, f.z, f.y)。悬空 / 不是 plane 回 null。stamp 与 readout 也读这一句, 解析只有这一份。
function fxSSRPlane(effect) {
    const r = attrRecord(effect.params && effect.params.planeRef);
    if (!r || r.type !== 'plane' || !r.desc || !r.desc.rotation) return null;
    const f = qApply(r.desc.rotation, { x: 1, y: 0, z: 0 });
    const d = r.desc.position || { x: 0, y: 0, z: 0 };
    return { nx: f.x, ny: f.z, nz: f.y, u: d.x, v: d.z, h: d.y };
}

function fxglSSR(col, p, effect, l) {
    if (p.mix <= 0 || p.reach <= 0) return;        // 没有可写的反射 = 画面原样, 不必占用一次 pass
    const pl = fxSSRPlane(effect);
    if (!pl) { fxgl.skip = 'Reflection: no plane attribute bound as the mirror'; return; }
    if (pl.nz <= 0.02) { fxgl.skip = 'Reflection: the plane faces away from the viewer'; return; }
    const gl = fxgl.gl;
    const dst = fxgl.off[1 - col.slot];
    const fr = fxMapFrame(p.align, l);
    const steps = Math.max(2, Math.min(32, p.steps | 0));
    const stepPx = p.reach / steps;
    const hasN = fxgl.hasMap2 === 1;
    fxglRunPass(dst, fxgl.progs.ssr, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uMap', fxgl.texMap, 1);
        // 法线图现在是**可选**的微扰动槽:没绑就整个不绑 (绑一张没分配过的纹理会让整次 drawArrays
        // 报 INVALID_OPERATION),uDetail 归 0,着色器那支采样不进 —— 纯平镜。
        let detail = 0;
        if (hasN) {
            fxglBindTex(pr, 'uNormal', fxgl.texMap2, 2);
            detail = p.detail / 100;
        }
        gl.uniform2f(fxglU(pr, 'uMapU'), fr.u[0], fr.u[1]);
        gl.uniform2f(fxglU(pr, 'uMapV'), fr.v[0], fr.v[1]);
        gl.uniform2f(fxglU(pr, 'uMapB'), fr.b[0], fr.b[1]);
        // 每步的 uv 步长按两轴各自的像素数除;v 朝上, 画面 y 分量的符号折在这里 —— 折完着色器里
        // 全程按画面像素空间想事 (同 fx/rgb_split.js 的 rsOffset)。
        gl.uniform2f(fxglU(pr, 'uStep'), stepPx / fxgl.w, -stepPx / fxgl.h);
        gl.uniform1f(fxglU(pr, 'uStepPx'), stepPx);
        gl.uniform1f(fxglU(pr, 'uRelief'), Math.max(1, p.relief));
        const ml = Math.hypot(pl.nx, pl.ny, pl.nz) || 1;
        gl.uniform3f(fxglU(pr, 'uMirror'), pl.nx / ml, pl.ny / ml, pl.nz / ml);
        // 锚点: (u·w, v·h) 像素 (v_geo=0 = 画面顶, 与像素空间 y 向下同一条); 锚点高度 = 画布平面
        // (浮雕最近端 = 1.0) 加上面自己的 h (画布高) 折成浮雕单位。
        gl.uniform3f(fxglU(pr, 'uAnchor'), pl.u * fxgl.w, pl.v * fxgl.h,
            1 + pl.h * fxgl.h / Math.max(1, p.relief));
        gl.uniform2f(fxglU(pr, 'uSize'), fxgl.w, fxgl.h);
        gl.uniform1f(fxglU(pr, 'uDetail'), detail);
        gl.uniform1i(fxglU(pr, 'uSteps'), steps);
        gl.uniform1f(fxglU(pr, 'uJitter'), p.jitter / 100);
        gl.uniform1i(fxglU(pr, 'uSeed'), p.seed | 0);
        gl.uniform1f(fxglU(pr, 'uMix'), p.mix / 100);
        gl.uniform1f(fxglU(pr, 'uFade'), p.fade / 100);
        gl.uniform1f(fxglU(pr, 'uNearBright'), p.near === 'bright' ? 1 : 0);
        gl.uniform1f(fxglU(pr, 'uPreview'), p.preview ? 1 : 0);
        gl.uniform3f(fxglU(pr, 'uSky'), ...fxHexToRgb01(p.sky));
    });
    col.slot = 1 - col.slot;
}

const SSR_PARAMS = [
    { key: 'map', kind: 'map', def: null },
    // 反射面 = 一枚 Plane attribute (fxDirModal 全项目检索后选一枚 guid, 面板只列 plane):面的法线
    // 就是镜子的朝向, 在 3D 小窗里拧。悬空整条跳过并说一句 —— 不许静默拿平镜顶替。
    { key: 'planeRef', label: 'Surface', kind: 'dir', def: null, types: ['plane'] },
    // 预览: 镜面可见区域以白色绘制在图层上 (被地形埋掉的原样) —— 摆面/拖高度时对着它定位水线。
    { key: 'preview', label: 'Preview', kind: 'flag', def: false,
        onText: 'Plane preview: ON', offText: 'Plane preview: OFF', when: p => p.planeRef },
    { key: 'near', label: 'Near', kind: 'enum', options: ['dark', 'bright'], def: 'dark',
        tip: 'Which end of the depth map stands tall \u2014 the heightfield the depth test marches over.' },
    { key: 'align', label: 'Align', kind: 'enum', options: ['Canvas', 'Local'], def: 'Canvas' },
    // 法线图 = 镜面的微扰动 (涟漪/粗糙), 不是反射面的法线 —— 面的朝向归 Plane attribute。可选。
    { key: 'normal', kind: 'map', def: null },
    { key: 'detail', label: 'Detail', min: 0, max: 100, step: 1, def: 30, unit: '%', when: p => p.normal,
        tip: 'How far the bound normal map displaces the reflected sampling \u2014 a geometry hint on the mirror\u2019s fine relief. The ray itself stays a pure mirror; 0 is a perfect mirror.' },
    { key: 'reach', label: 'Reach', min: 8, max: 512, step: 1, def: 160, unit: 'px',
        tip: 'How far the reflected ray searches before giving up \u2014 nothing hit means nothing reflected.' },
    { key: 'steps', label: 'Steps', min: 2, max: 32, step: 1, def: 12,
        tip: 'Ray-march quality plus 4 bisection refinements on every hit. Taps per pixel: Steps depth samples.' },
    { key: 'relief', label: 'Relief', min: 1, max: 256, step: 1, def: 96, unit: 'px',
        tip: 'How tall the full depth range stands in layer pixels \u2014 the depth-test strength.' },
    { key: 'jitter', label: 'Jitter', min: 0, max: 100, step: 1, def: 75, unit: '%',
        tip: 'Scatters each ray\u2019s start phase by up to one step \u2014 trades banding for grain. Deterministic per pixel; Seed picks the pattern.' },
    { key: 'seed', label: 'Seed', min: 0, max: 999, step: 1, def: 0 },
    { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, def: 100, unit: '%' },
    // 未命中的反射 ray 照到的是天空: 返回这份天光色 (不吃 Fade —— 天在无穷远)。
    { key: 'sky', label: 'Sky', kind: 'color', def: '#aebfd0' },
    { key: 'fade', label: 'Fade', min: 0, max: 100, step: 1, def: 40, unit: '%',
        tip: 'Distant hits come back dimmer \u2014 tames the grazing smear a near-horizontal ray leaves on flat ground.' },
];

defineEffect({
    type: 'ssr',
    label: 'Reflection',
    group: 'Reflect',
    icon: 'reflect',
    needsMap: 'Depth',
    needsMap2: { key: 'normal', role: 'Normal', optional: true },
    desc: 'Screen-space reflections: a bound Plane attribute is the mirror \u2014 its normal (steer it in the 3D window) decides which way every reflected ray leaves, and its position places the mirror in the scene: the view ray meets the plane per pixel, so a tilted plane makes the mirror\u2019s height slide across the picture, and lowering its height (negative, behind the picture plane) dips it into the depth relief \u2014 pixels whose terrain stands in front of the plane bury it (no reflection there), the rest reflect. The bound depth map is the relief those rays march over: walk the grid in the reflected direction, the ray sinking deeper into the scene as it goes, until the relief rises above the ray (that is the depth test: whatever stands in front clips the reflection) or Reach runs out \u2014 a miss reflects the Sky colour (the ray found the sky; it takes Mix but not Fade, the sky is infinitely far). The mirror must tilt PAST 45\u00b0 from face-on (plane pitch under 45\u00b0) for the reflected ray to reach into the picture; a shallower mirror reflects the space behind the viewer and comes back as the Sky colour. The reflection is a pure mirror: the normal map does NOT steer the ray \u2014 it only hints the mirror\u2019s fine geometry by displacing the reflected sampling (Detail sets how far; unbound or Detail=0 is a perfect mirror). Steps set the march quality (every hit is refined by 4 bisections), Relief is the depth-test strength (full depth range as layer pixels), Jitter scatters ray starts to break the banding into grain (Seed picks the pattern), Fade dims distant hits. Reflections can only come from the layer\u2019s own pixels, weighted by the hit\u2019s own alpha; colour only \u2014 alpha is this pixel\u2019s own.',
    params: SSR_PARAMS,
    shaders: { ssr: FX_FS_SSR },
    run: fxglSSR,
    // Canvas 对齐的两张图都读「该层盒子落在画布哪儿」, 拖图层不改像素也不改 params —— 同
    // fx/chromatic_aberration.js 与 fx/volumetric_fog.js, 靠 stamp 把这份外部状态报进缓存身份。
    // 绑定的 Plane attribute 同理: 法线与**位置**都不在本层 params 里, 代次键看不见它动了 ——
    // 解析出的镜面法线与锚点报进身份, 在 3D 小窗里拧一下, 这条链当场重算。
    stamp(effect, l) {
        const p = effectParams(effect);
        let s = '';
        if (p.align === 'Canvas') s += fxMapBoxStamp(l) + '|';
        const pl = fxSSRPlane(effect);
        if (pl) s += `m${pl.nx.toFixed(3)},${pl.ny.toFixed(3)},${pl.nz.toFixed(3)}`
            + `p${pl.u.toFixed(3)},${pl.v.toFixed(3)},${pl.h.toFixed(3)}|`;
        return s;
    },
    readout(p, n, effect) {
        const pl = fxSSRPlane(effect);
        // 镜面读数 = 面法线的仰角 (正 = 朝读者立着, 0 = 贴着画面), 绑定以 ⤳ 标出来源; 悬空说一句。
        const elev = pl ? Math.round(dirDeg(Math.asin(Math.max(-1, Math.min(1, pl.nz))))) : null;
        let s = `${fxMapShort(effect)} + ${fxMapShort(effect, 'normal')}  ${p.align === 'Local' ? 'local' : 'canvas'}`
            + `  ${elev === null ? 'no plane' : `mirror ${elev}\u00b0\u2933`}`
            + `  r${n(p.reach)}px  s${p.steps | 0}  rel${n(p.relief)}`;
        if (p.near === 'bright') s += '  inv';
        if (p.mix < 100) s += `  m${n(p.mix)}`;
        if (p.fade < 100) s += `  f${n(p.fade)}`;
        if (!p.jitter) s += '  nojit';
        return s;
    },
    thumb(g, box) {
        // 一面斜的地板把立在它后面的一根柱子照出来:柱子是直的, 影在地板里却顺着反射方向倒过去 ——
        // 屏幕空间反射读出来的就是「内容顺着反射方向在深度浮雕上找落点」。
        const x = box.x, y = box.y, w = box.w, h = box.h;
        g.fillStyle = '#2c64b8';
        g.beginPath();
        g.moveTo(x, y + h * 0.55);
        g.lineTo(x + w, y + h * 0.30);
        g.lineTo(x + w, y + h);
        g.lineTo(x, y + h);
        g.closePath();
        g.fill();
        g.fillStyle = '#e8e4da';
        g.fillRect(x + w * 0.30, y + h * 0.08, w * 0.14, h * 0.34);   // 柱子本体
        g.save();
        g.beginPath();
        g.moveTo(x, y + h * 0.55);
        g.lineTo(x + w, y + h * 0.30);
        g.lineTo(x + w, y + h);
        g.lineTo(x, y + h);
        g.closePath();
        g.clip();
        g.fillStyle = 'rgba(150,190,240,0.75)';
        g.fillRect(x + w * 0.44, y + h * 0.34, w * 0.14, h * 0.60);   // 顺着反射方向倒过去的影
        g.restore();
    },
});
