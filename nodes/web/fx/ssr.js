// fx/ssr.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图 (Reflect 组)。
// 屏幕空间反射,全在一把尺子上算:小窗那套世界单位 (X 横画面、Y 朝读者、Z 竖画面)。
// ① 相机 = 这张照片自己的相机:这一层的画面片就是它的像平面 (画布平面 Y=0),眼睛在 +Y 上距离
//   `1/uK` 处,uK = tan(水平视场半角)/画布半宽。Perspective=0 ⇒ uK=0 ⇒ 视线 = (0,-1,0) = 这层纸。
//   视线**逐像素变**,所以反射会收敛、水线会弯。
// ② 地形 = 绑来的深度图当一块浮雕,铺在画面片上,高度沿 Y 量:画布平面 = 离读者最近的一端 (Y=0),
//   往负沉进场景,满幅 = Relief ×H (一个画布高 = 整段深度范围)。Near 极性只在这里翻一次。
// ③ 镜子 = 一枚 Plane attribute,它的世界 position 就是镜面上的一点、法线 (规范朝向 +X 转过去)
//   就是镜子的朝向 —— 位置与法线都不乘任何像素数。视线与镜面求交得 P;P 比这一处的地形更靠近读者
//   ⇒ 镜子在这儿露着 (可反射),沉在地形底下 ⇒ 被埋,谈不上反射。`镜面 = 地形` 那一条线自己就是水线。
// ④ 反射 = 视线对镜面法线的反射 R = reflect(D, N);R 往 +Y 弹 (镜子离正面不到 45°) = 照的是相机
//   背后,画面里没有那份内容 = 天光。R 往场景里沉,就从 P 沿 R 步进 Steps 步、每步 Reach/Steps 层
//   像素折成的世界长度,每一步把 3D 点投回这一层的网格读地形高度,地形高过 ray 的第一处挡住 ray
//   (前面的东西把反射裁掉),命中点再二分 4 次磨掉台阶;走出画面或走满 = 什么都没照见 = 天光。
//   取样 = 命中点那个像素自己 (透明处没有东西可照,按它自己的 alpha 加权),出口只写 RGB ——
//   反射不重塑形状,alpha 是这个像素自己的 (契约 ②)。Jitter 用确定性整数 hash 抖起步相位,Seed 换花样。
// 跳过并在链上说话的情形:没绑 plane / 面侧棱对着视线 (法线的 Y 分量 ≤ 0.15, 每条光线与镜面的交点
// 跑到无穷远) / 面朝读者的镜子 (整帧只会刷成天光色) / 这一层在画面片上没有面积。镜子照见天光是
// 正当结果,不跳过 —— 写成 Sky 那颗颜色。
// Preview: 把「镜子在哪儿露着」以白色画在图层上,摆位与拧高度时对着它看水线。

const FX_FS_SSR = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uMap;
uniform vec2 uMapU;
uniform vec2 uMapV;
uniform vec2 uMapB;
uniform vec2 uO;         // 画面片基 (世界 XZ): 这一层的网格 (x 右, y 上) → 世界
uniform vec2 uBx;
uniform vec2 uBy;
uniform mat2 uInv;       // (uBx uBy) 那一组基的逆: 世界 XZ → 这一层的网格
uniform float uK;        // 1/眼距 (世界单位) = tan(视场半角)/画布半宽; 0 = 正交
uniform vec3 uA;         // 镜面上的一点 (世界, 直接取自 Plane attribute 的 position)
uniform vec3 uN;         // 镜面法线 (世界, 单位)
uniform float uRelief;   // 深度满幅 (世界单位)
uniform float uEps;      // 八位深度的量化容差 (世界单位) = Relief × 2/255
uniform float uStepW;    // 反射 ray 每步的世界长度
uniform int uSteps;
uniform float uJitter;   // 0..1: 起步相位抖多少步
uniform int uSeed;
uniform float uMix;
uniform float uFade;
uniform float uNearBright;
uniform float uPreview;  // 预览: 镜面露着的区域画白
uniform vec3 uSky;       // 反射 ray 照到天空时的天光色
// 同 fx/noise.js 的整数散列 —— fp32 的 fract 类散列在这里会塌成可见结构, 不再用。
float ssrH(ivec2 t, int c) {
    uint h = uint(t.x) * 73856093u ^ uint(t.y) * 19349663u ^ uint(c) * 83492791u ^ uint(uSeed) * 2654435761u;
    h = (h ^ (h >> 16u)) * 0x7feb352du;
    h = (h ^ (h >> 15u)) * 0x846ca68bu;
    return float(h >> 8u) * (1.0 / 16777216.0);
}
// 地形高度 (世界 Y): 0 = 画布平面 = 最近端, -Relief = 最远端。落点走 fxMapFrame 那一份仿射基。
float ssrTerrain(vec2 suv) {
    float d = texture(uMap, uMapU * suv.x + uMapV * suv.y + uMapB).r;
    return uNearBright > 0.5 ? -uRelief * (1.0 - d) : -uRelief * d;
}
vec2 ssrSheet(vec2 xz) { return uInv * (xz - uO); }
bool ssrOn(vec2 s) { return s.x >= 0.0 && s.x <= 1.0 && s.y >= 0.0 && s.y <= 1.0; }
// 地形只铺在画面片上;投出界的那一处没有东西可挡 (回最远那一档),反射 ray 出界则由调用方判成天。
float ssrTerrainAt(vec2 xz) {
    vec2 s = ssrSheet(xz);
    return ssrOn(s) ? ssrTerrain(s) : -uRelief;
}
void main() {
    ivec2 tc = ivec2(gl_FragCoord.xy);
    vec4 own = texelFetch(uTex, tc, 0);
    if (uMix <= 0.0) { Frag = own; return; }
    // ① 视线: 像平面上的落点 W (世界, Y=0) 与眼睛 (0, 1/uK, 0) 连线;uK=0 就是正着往下看。
    vec2 xz = uO + uBx * vUV.x + uBy * vUV.y;
    vec3 W = vec3(xz.x, 0.0, xz.y);
    vec3 D = normalize(vec3(uK * W.x, -1.0, uK * W.z));
    // ③ 镜面求交。uN.y ≥ 0.15 由引擎保证 ⇒ dot(uN,D) 恒负, 每条视线与镜面各交一次。
    float tm = dot(uN, uA - W) / dot(uN, D);
    vec3 P = W + D * tm;
    // 透视下镜面跑到相机**背后** (Y ≥ 眼距) = 这条光线够不着它 = 这里没有镜子。
    if (uK > 0.0 && P.y * uK >= 1.0) { Frag = own; return; }
    // 地形比镜面更靠近读者 ⇒ 镜子被埋。容差让「贴着水面摆」算露着:水面自己的深度值折出来与镜面
    // 等高,不容差的话整片水都成了冒出来的地形,反射会采到水面/水下内容。
    if (P.y < ssrTerrainAt(P.xz) - uEps) { Frag = own; return; }
    if (uPreview > 0.5) { Frag = vec4(1.0, 1.0, 1.0, own.a); return; }
    // ④ 镜面反射: 方向只由 Plane attribute 的法线决定 —— 一面平镜。往读者那一侧弹 = 照的是相机背后。
    vec3 R = reflect(D, uN);
    if (R.y >= 0.0) { Frag = vec4(mix(own.rgb, uSky, uMix), own.a); return; }
    float jit = (ssrH(tc, 0) - 0.5) * uJitter;
    float tLo = 0.0, tHi = -1.0;
    for (int k = 1; k <= 128; k++) {
        if (k > uSteps) break;
        float t = (float(k) + jit) * uStepW;
        vec3 Q = P + R * t;
        vec2 s = ssrSheet(Q.xz);
        if (!ssrOn(s)) break;                       // 走出画面 = 这条反射 ray 只剩天
        if (Q.y <= ssrTerrain(s) - uEps) { tHi = t; break; }
        tLo = t;
    }
    if (tHi < 0.0) {
        // 未命中 = 这条反射 ray 照到的是天空: 返回天光色 (不吃 Fade —— 天在无穷远), Mix 照常管浓度。
        Frag = vec4(mix(own.rgb, uSky, uMix), own.a);
        return;
    }
    // 二分精修: 命中点定在「最后一个未撞」与「第一个撞上」之间, 步进的台阶感从这里磨掉。
    for (int r = 0; r < 4; r++) {
        float th = (tLo + tHi) * 0.5;
        vec3 Q = P + R * th;
        vec2 s = ssrSheet(Q.xz);
        if (!ssrOn(s)) break;
        if (Q.y <= ssrTerrain(s) - uEps) tHi = th; else tLo = th;
    }
    vec2 hs = ssrSheet((P + R * tHi).xz);
    if (!ssrOn(hs)) { Frag = vec4(mix(own.rgb, uSky, uMix), own.a); return; }
    vec4 hit = texture(uTex, hs);
    float w = uMix * hit.a * (1.0 - uFade * clamp(tHi / (float(uSteps) * uStepW), 0.0, 1.0));
    Frag = vec4(mix(own.rgb, hit.rgb, w), own.a);
}`;

// 反射面 = 一枚 Plane attribute:世界 position 直接就是镜面上的一点,法线 = 规范朝向 +X 被那枚
// 四元数转过去的世界方向。**都不折进任何像素数、也不过 (u,v,h)** —— 镜子的位置就是它在场景里的
// 位置,想换分辨率不动它。悬空 / 不是 plane 回 null。stamp、readout 与 pass 都读这一句。
function fxSSRPlane(effect) {
    const r = attrRecord(effect.params && effect.params.planeRef);
    if (!r || r.type !== 'plane' || !r.desc || !r.desc.rotation) return null;
    const N = qApply(r.desc.rotation, { x: 1, y: 0, z: 0 });
    const nl = Math.hypot(N.x, N.y, N.z);
    if (!nl) return null;
    const A = r.desc.position || { x: 0, y: 0, z: 0 };
    return { nx: N.x / nl, ny: N.y / nl, nz: N.z / nl, ax: A.x, ay: A.y, az: A.z };
}

// 画面片 ↔ 世界的这张基:「这一层的每一个像素是画面片的哪一块」只有 fxMapFrame (Align=Canvas/Local)
// 那一份答案,这里只把它的三个 vec2 乘上画布在世界里的半幅 (2hw × 2hd),不再另立换算。画面片就躺在
// 画布平面上,所以 Y 分量恒 0 ⇒ 整张基只需 (X,Z) 两轴,反解是那个 2×2。
// inv 按 mat2 的列优先排: 第一列 (By1, -Bx1)/det, 第二列 (-By0, Bx0)/det。px = 一个层像素的世界长。
function fxSSRSheet(p, l) {
    const fr = fxMapFrame(p.align, l);
    const { hw, hd } = dirPlaneHalf();
    const O = [(fr.b[0] - 0.5) * 2 * hw, (0.5 - fr.b[1]) * 2 * hd];
    const Bx = [fr.u[0] * 2 * hw, -fr.u[1] * 2 * hd];
    const By = [fr.v[0] * 2 * hw, -fr.v[1] * 2 * hd];
    const det = Bx[0] * By[1] - By[0] * Bx[1];
    if (!isFinite(det) || Math.abs(det) < 1e-9) return null;
    return {
        fr, O, Bx, By, hw, hd,
        inv: [By[1] / det, -Bx[1] / det, -By[0] / det, Bx[0] / det],
        px: Math.hypot(Bx[0], Bx[1]) / Math.max(1, fxgl.w),
    };
}

function fxglSSR(col, p, effect, l) {
    if (p.mix <= 0 || p.reach <= 0) return;        // 没有可写的反射 = 画面原样, 不必占用一次 pass
    const pl = fxSSRPlane(effect);
    if (!pl) { fxgl.skip = 'Reflection: no plane attribute bound as the mirror'; return; }
    // 法线的 Y 分量 (朝读者) 是「视线与镜面各交一次」的依据: 侧棱对着视线时交点跑到无穷远,
    // 整帧没有一处镜面, 反射无从定义 —— 跳过并说一句。
    if (pl.ny <= 0.15) { fxgl.skip = 'Reflection: the plane is edge-on to the viewer'; return; }
    const sh = fxSSRSheet(p, l);
    if (!sh) { fxgl.skip = 'Reflection: the layer has no area on the picture plane'; return; }
    const gl = fxgl.gl;
    const dst = fxgl.off[1 - col.slot];
    const steps = Math.max(2, Math.min(128, p.steps | 0));
    const k = p.persp > 0 ? Math.tan(p.persp * Math.PI / 360) / sh.hw : 0;
    const relief = Math.max(0.001, p.relief) * 2 * sh.hd;   // ×H → 世界单位 (一个画布高 = 2hd)
    // 面朝读者的镜子 (离画布平面不到 45°) 把视线原样弹回读者这一侧, 整帧只会刷成一片天光色 ——
    // 那是正当结果, 但读起来像坏了。在画面中心判一次 (正交下到处一样, 透视下中心最代表视线),
    // 把「往哪儿拧」写在链上。
    const cX = sh.O[0] + 0.5 * (sh.Bx[0] + sh.By[0]), cZ = sh.O[1] + 0.5 * (sh.Bx[1] + sh.By[1]);
    const dl = Math.hypot(k * cX, -1, k * cZ);
    const Dx = k * cX / dl, Dy = -1 / dl, Dz = k * cZ / dl;
    const dn = Dx * pl.nx + Dy * pl.ny + Dz * pl.nz;
    if (Dy - 2 * dn * pl.ny >= 0) {
        fxgl.skip = 'Reflection: the mirror faces the viewer \u2014 tilt it past 45\u00b0 so it looks into the scene';
        return;
    }
    fxglRunPass(dst, fxgl.progs.ssr, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uMap', fxgl.texMap, 1);
        gl.uniform2f(fxglU(pr, 'uMapU'), sh.fr.u[0], sh.fr.u[1]);
        gl.uniform2f(fxglU(pr, 'uMapV'), sh.fr.v[0], sh.fr.v[1]);
        gl.uniform2f(fxglU(pr, 'uMapB'), sh.fr.b[0], sh.fr.b[1]);
        gl.uniform2f(fxglU(pr, 'uO'), sh.O[0], sh.O[1]);
        gl.uniform2f(fxglU(pr, 'uBx'), sh.Bx[0], sh.Bx[1]);
        gl.uniform2f(fxglU(pr, 'uBy'), sh.By[0], sh.By[1]);
        gl.uniformMatrix2fv(fxglU(pr, 'uInv'), false, sh.inv);
        gl.uniform1f(fxglU(pr, 'uK'), k);
        gl.uniform3f(fxglU(pr, 'uA'), pl.ax, pl.ay, pl.az);
        gl.uniform3f(fxglU(pr, 'uN'), pl.nx, pl.ny, pl.nz);
        gl.uniform1f(fxglU(pr, 'uRelief'), relief);
        gl.uniform1f(fxglU(pr, 'uEps'), relief * 2 / 255);
        gl.uniform1f(fxglU(pr, 'uStepW'), (p.reach / steps) * sh.px);
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
    // 反射面 = 一枚 Plane attribute (fxDirModal 全项目检索后选一枚 guid, 面板只列 plane):它的法线
    // 就是镜子的朝向, 它在世界里的位置就是镜子的位置, 在 3D 小窗里拧。悬空整条跳过并说一句 ——
    // 不许静默拿平镜顶替。
    { key: 'planeRef', label: 'Surface', kind: 'dir', def: null, types: ['plane'] },
    // 预览: 镜面露在地形之上的那一片画白 (被埋掉的原样) —— 摆位/拧高度时对着它看水线。
    { key: 'preview', label: 'Preview', kind: 'flag', def: false,
        onText: 'Plane preview: ON', offText: 'Plane preview: OFF', when: p => p.planeRef },
    { key: 'near', label: 'Near', kind: 'enum', options: ['dark', 'bright'], def: 'dark',
        tip: 'Which end of the depth map stands closest to the reader \u2014 the relief every ray is tested against.' },
    { key: 'align', label: 'Align', kind: 'enum', options: ['Canvas', 'Local'], def: 'Canvas' },
    // 相机的视场:0 = 正交 (这层纸的感觉),视线不收敛;拧大 = 视线逐像素收,水线会弯、远处会压过来。
    { key: 'persp', label: 'Perspective', min: 0, max: 120, step: 1, def: 45, unit: '\u00b0',
        tip: 'Horizontal field of view of this photo\u2019s own camera \u2014 view rays converge, so the water line curves and distance compresses. 0 is flat paper (orthographic).' },
    { key: 'reach', label: 'Reach', min: 8, max: 2048, step: 1, def: 512, unit: 'px',
        tip: 'How far the reflected ray searches before giving up \u2014 nothing hit means nothing reflected. Read in this layer\u2019s pixels; converted to world length per step.' },
    { key: 'steps', label: 'Steps', min: 2, max: 128, step: 1, def: 12,
        tip: 'Ray-march quality plus 4 bisection refinements on every hit. Taps per pixel: Steps depth samples.' },
    { key: 'relief', label: 'Relief', min: 0.01, max: 4, step: 0.01, def: 0.5, unit: '\u00d7H',
        tip: 'How far the depth range sinks behind the picture plane, in canvas heights \u2014 the one ruler the terrain and the mirror share.' },
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
    desc: 'Screen-space reflections, measured on one ruler: the bound depth map is rebuilt as a relief laid on this layer\u2019s picture plane, its height measured along the view axis \u2014 the canvas plane is the end closest to the reader, and Relief says how far (in canvas heights) the whole depth range sinks behind it. A bound Plane attribute is the mirror sheet: its world position is a point of the mirror and its normal is the mirror\u2019s facing, neither converted through any pixel count. Per pixel this photo\u2019s own camera casts a view ray (Perspective = its horizontal field of view; 0 is flat paper, orthographic), the ray meets the mirror sheet, and wherever the sheet stands closer to the reader than the relief it is bare mirror \u2014 where the relief stands in front of it the sheet is buried and there is no mirror at all, so the water line is exactly the line where sheet and relief cross, and it curves by itself under perspective. Preview paints the exposed sheet white while you place it. The direction a reflection leaves in is the view ray reflected about the plane normal \u2014 a pure mirror, nothing else steers it; a mirror within 45° of face-on bounces the ray back at the reader, which means it would show what is behind the camera, so it says so on the chain instead of filling the picture. Otherwise the ray marches into the scene, Steps steps of Reach/Steps layer pixels (converted to world length), testing the relief at each point projected back onto this layer: the first place the relief rises over the ray clips the reflection, refined by 4 bisections, and that pixel is what shows. Ran out of Reach or left the picture = the ray found the sky = the Sky colour (takes Mix, not Fade — the sky is infinitely far). Reflections can only come from the layer\u2019s own pixels, weighted by the hit\u2019s own alpha; colour only \u2014 alpha is this pixel\u2019s own. Jitter scatters ray starts to break banding into grain (Seed picks the pattern), Fade dims distant hits, Mix sets the strength.',
    params: SSR_PARAMS,
    shaders: { ssr: FX_FS_SSR },
    run: fxglSSR,
    // 旧档的 Relief 说的是「满幅深度折多少**层像素**」,并且这一个数同时当地形满幅、镜面沉入的刻度和
    // ray 爬升的分母。新结构里它只说一件事:深度范围在世界里有多深,单位 = 画布高。旧值按当前画布高
    // 折一次 (96px 在 1024 的档上 = 0.094 ×H) —— 观感会换,这是这次改动的代价。
    // 认出旧档的依据:还没有 Perspective 这颗旋钮,而 Relief 大过 4 (×H 的合法区用不到那个量级)。
    migrate(raw, out) {
        if (raw.persp !== undefined) return;
        const old = Number(raw.relief);
        if (!(old > 4)) return;
        out.relief = Math.max(0.01, Math.min(4, old / (canvasH || 1024)));
    },
    // 结果吃的三件外部状态都不在本层 params 里: 图层盒子在画布上的落点 (Canvas 对齐的取样基)、
    // 画布自身的比例 (世界半幅 hw/hd 与眼距都从它来)、以及那枚 Plane attribute (位置与法线,
    // 代次键看不见它动)。在 3D 小窗里拧一下, 这条链当场重算。
    stamp(effect, l) {
        const p = effectParams(effect);
        let s = `${canvasW}x${canvasH}|`;
        if (p.align === 'Canvas') s += fxMapBoxStamp(l) + '|';
        const pl = fxSSRPlane(effect);
        if (pl) s += `a${pl.ax.toFixed(3)},${pl.ay.toFixed(3)},${pl.az.toFixed(3)}`
            + `n${pl.nx.toFixed(3)},${pl.ny.toFixed(3)},${pl.nz.toFixed(3)}|`;
        return s;
    },
    readout(p, n, effect) {
        const pl = fxSSRPlane(effect);
        // 读数 = 镜面离「正面朝读者」拧开多少度 (0 = 一块罩在画面前的玻璃, 90 = 侧棱对着视线)。
        const tilt = pl ? Math.round(dirDeg(Math.asin(Math.max(-1, Math.min(1, pl.ny))))) : null;
        let s = `${fxMapShort(effect)}  ${p.align === 'Local' ? 'local' : 'canvas'}`
            + `  ${tilt === null ? 'no plane' : `mirror ${tilt}\u00b0\u2933`}`
            + `  r${n(p.reach)}px  s${p.steps | 0}  rel${n(p.relief)}H  fov${n(p.persp)}\u00b0`;
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
