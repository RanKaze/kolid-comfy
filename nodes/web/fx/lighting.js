// fx/lighting.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图。
// 它绑一张法线图 (needsMap) 打光,还可以再绑一张深度图 (needsMap2) 当高度场把阴影算出来;
// 两个槽的解析规则见 fx/maps.js。

// 光照:切线空间法线图(uv 基:y 向上,因为上传时已 UNPACK_FLIP_Y;平坦处 = (0.5,0.5,1))做
// Lambert 漫反射 + Blinn-Phong 高光。绿色通道的朝向按贴图族选(OpenGL 朝上 / DirectX 朝下)。
// 灯的颜色逐通道作用在漫反射与高光项上 —— 从前它只进高光项,所以 Spec=0 时整盏灯看着是白色的。
//
// 阴影 = 一张从深度图重建出来的 shadow mask,与光照**分家**跑几趟:
//   1) 烘高度场:深度图按 Near 极性 + Align 基写进一张 mip 纹理的 level 0(本层网格分辨率),
//      一个贴图像素之内取四角最大值 —— 金字塔最低那级也得当「这块里最高的那个」来问。
//   2) 逐级 2×2 取最大值往下烘。往下每一趟不能边读边写同一张纹理:mipmap 过滤器下这是硬
//      INVALID_OPERATION(1282,真机撞过),所以画进一张同规格的中转面 lightScr 的第 k 级,
//      再由 copyTexSubImage2D 搬进金字塔。级别点名也只有配了 mip 过滤器才真的生效 ——
//      非 mipmap 的 min 过滤器下 textureLod 的 level 参数被 ANGLE 整个忽略,每读都落回 level 0
//      (把 level k 的 readPixels 与 textureLod(...,k) 的画回读并排比过),于是 min 一律用
//      NEAREST_MIPMAP_NEAREST、mag 用 NEAREST:块内是精确最大值,块间不插值。
//   3) 逐像素沿**光源那侧**在高度场上推进:横向走 r 个图高,光线抬 uSlope·r 个满幅深度,
//      uSlope = tan(Elev)/(Scale/100)。途中任何一步的最大高度 ≥ h0 + uSlope·r,光就被挡住。
//      推进到「光线抬过这张图的上界」或「迈出画面」就停 —— 影长是 Δh·Scale/tan(Elev)
//      自己算出来的,不是一颗像素上限;Cast 现在只是截断它的那道闸,默认开到 1024px ≈ 不截。
//   4) 出来的是**二值** mask(挡住 = 1),Soft 拿它对画面做低通 = 半影(光源有半径,影子边缘才有
//      一段渐变),最后乘 Tint 落回光照那一趟。半影走一条本地的可分离高斯(横一趟竖一趟),
//      不用引擎那套 Kawase:它的抽样数夹在 1..8,半径 16 和 32 实测都只糊出 21px,拖不动滑块。
// 从前这两件事糊在一趟里:Soft 是「高度差阈值」而不是覆盖率(于是 occ 正比于对面有多陡 = 一条贴着
// 轮廓的 emboss 暗边),而推进距离被钉在 ≤64px 且与遮挡物高度无关(默认参数下光线全程只抬 1.6% 满幅,
// 任何真实遮挡物的影子都要比这长一到两个数量级)。
// 横向单位统一成「图高」,两轴都按它算,梯度也是(每像素 1/h):从前 x 除宽、y 除高、抬高只除宽,
// 非方形图层上影子的方向与长度会随宽高比漂。迈步是**等长步,步长 = 那一级的块宽**:相邻两步问的那两
// 块首尾相接,整条路径没有一段没被问过,于是影子的边缘误差 = 半块,而它随影长一起长。
// 块是纹理对齐的,所以光线高度要在**块中心**上问(由格子的 floor 反推),拿抽样点顶替会跟着抽样点
// 在块里偏哪头一起偏 —— 该 60px 的拖到 72px。定步长直读单纹素(块比步长窄)会把比步距薄的障碍整根
// 漏掉;步长几何加倍那一版也不行(2,6,14,30,62px 那种稀疏格):「像素在不在影子里」要求区间
// [到遮挡物的距离, 影长] 里恰好落着一格,影长落在两格之间时整段影子被截在上一格那里 —— 两条都在真机上量过。
// 只改 RGB:高光加在色上,阴影乘在色上,贴图本身永远不渗进画面。
const FX_LIGHT_MARCH_MAX = 32;         // 着色器里常数次循环的上界 = Steps 的上界
const FX_LIGHT_CACHE_MAX = 4;          // 按参数缓存的 shadow mask 留几份(拖滑块每帧重建时用回收池,不 new 纹理)

const FX_FS_LIGHT = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uMap;
uniform sampler2D uShadowMask;
uniform vec3 uL;
uniform vec3 uColor;
uniform vec3 uTint;
uniform float uIntensity;
uniform float uSpec;
uniform float uGloss;
uniform float uGreen;
uniform float uShadow;
void main() {
    vec4 c = texture(uTex, vUV);
    vec3 n = texture(uMap, vUV).xyz;
    n = vec3(n.x * 2.0 - 1.0, (n.y * 2.0 - 1.0) * uGreen, max(n.z * 2.0 - 1.0, 0.05));
    n = normalize(n);
    float diff = max(dot(n, uL), 0.0);
    vec3 halfv = normalize(uL + vec3(0.0, 0.0, 1.0));
    float s = pow(max(dot(n, halfv), 0.0), mix(6.0, 220.0, uGloss)) * uSpec;
    vec3 lit = c.rgb * clamp(1.0 + uColor * (uIntensity * (diff - 0.45)), 0.0, 3.0) + uColor * s;
    // mask 在 alpha 上(它要能被本类那对 separable 低通直接糊),没深度图时 uShadow 被 JS 侧
    // 归 0,这一支根本不进采样器 —— 那个采样器于是留在默认单元 0 上也无所谓(0 号永远是这张色彩面)。
    float occ = uShadow > 0.0 ? texture(uShadowMask, vUV).a : 0.0;
    // 影子是乘法:Tint 就是被挡住那部分乘上去的颜色(黑 = 传统压暗,青色 = 彩色影子),深浅由 Shadow 说。
    lit *= mix(vec3(1.0), uTint, uShadow * occ);
    Frag = vec4(clamp(lit, 0.0, 1.0), c.a);
}`;

// 高度场 level 0:深度图 → 本层网格。「高度 = 离相机多近」,所以 near=dark 那张图(raw 本身是距离)
// 要取反才是高度 —— 与景深/体积雾那颗同名旋钮同一条读法。
const FX_FS_LIGHT_BAKE = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uDepth;
uniform vec2 uMapU;
uniform vec2 uMapV;
uniform vec2 uMapB;
uniform float uNearBright;
uniform vec2 uTexel;
void main() {
    vec2 muv = uMapU * vUV.x + uMapV * vUV.y + uMapB;
    vec2 q = uTexel * 0.5;
    float d = max(max(texture(uDepth, muv + vec2(-q.x, -q.y)).r, texture(uDepth, muv + vec2(q.x, -q.y)).r),
                  max(texture(uDepth, muv + vec2(-q.x, q.y)).r, texture(uDepth, muv + vec2(q.x, q.y)).r));
    float h = clamp(uNearBright > 0.5 ? d : 1.0 - d, 0.0, 1.0);
    Frag = vec4(h, h, h, 1.0);
}`;

// 往下烘一级:2×2 子块取最大值。vUV 落在输出纹素的中心 = (i+0.5)/N,所以 floor(vUV·dstSize) 就是
// 那个整数索引 i,乘 2 回到源图里自己那块的原点 —— 一步不差,不会像「拿 uv 减半个纹素」那样整级错位。
const FX_FS_LIGHT_DOWN = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform vec2 uSrcSize;
uniform vec2 uDstSize;
uniform float uSrcLevel;
void main() {
    vec2 st = 1.0 / uSrcSize;
    vec2 c = floor(vUV * uDstSize) * 2.0;
    c = (c + 0.5) * st;
    // 必须点名读哪一级,而且这张金字塔的过滤器必须带 MIPMAP 那个点名才生效。真机对照量过两面:
    // 拿 readPixels 把第 k 级直接端出来 (不经过取样器) 与拿 textureLod(uH,uv,k) 画满整张面再端出来
    // —— 配非 mipmap 过滤器 (LINEAR) 时后者逐像素等于对 level 0 的双线性抽样,级号被驱动整个忽略,
    // 于是这一趟其实是「对 level 0 每隔 2^k 像素抽四个点」而不是块最大值,2px 薄的障碍在第三级整根
    // 消失 (影子变成一条 7px 周期的花斑)。改成 NEAREST_MIPMAP_NEAREST 后点名才真的落在那一级上。
    float m = max(max(textureLod(uTex, c, uSrcLevel).r, textureLod(uTex, c + vec2(st.x, 0.0), uSrcLevel).r),
                  max(textureLod(uTex, c + vec2(0.0, st.y), uSrcLevel).r,
                      textureLod(uTex, c + st, uSrcLevel).r));
    Frag = vec4(m, m, m, 1.0);
}`;

const FX_FS_LIGHT_SHADOW = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uH;
uniform vec2 uDir;
uniform float uAspect;
uniform float uSlope;
uniform float uPxH;
uniform float uMax;
uniform int uLevels;
uniform int uSteps;
void main() {
    float h0 = textureLod(uH, vUV, 0.0).r;
    // uDir 是「图高」单位下的单位向量(x 已经乘过宽高比),换到 uv 就是 x 再除回来。
    vec2 duv = vec2(uDir.x / uAspect, uDir.y);
    // 走到哪儿停:光线抬过整张图的上界(再问谁都不可能挡),迈出画面(框外没有世界,而
    // 采样器 CLAMP_TO_EDGE 会把边框那一列无限复制出去 = 边缘长出假影),以及 Cast 那道上限。
    float rx = duv.x > 0.0 ? (1.0 - vUV.x) / duv.x : (duv.x < 0.0 ? -vUV.x / duv.x : 1e9);
    float ry = duv.y > 0.0 ? (1.0 - vUV.y) / duv.y : (duv.y < 0.0 ? -vUV.y / duv.y : 1e9);
    float rTop = uSlope > 1e-6 ? (1.0 - h0) / uSlope : 1e9;
    float rMax = min(min(rTop, min(rx, ry)), uMax);
    // 等长迈步,而且**步长 = 块宽**:每走一步正好前进一个块,块号 1,2,3… 连续铺到 rMax,所以整条
    // 路径没有一段没被问过,也没有一个块分不到抽样点。
    // 先按「想要的步长」dt0 = rMax/Steps 选出罩得住它的那一级 (ceil ⇒ 块 ≥ 步长),然后把步长改成
    // 那块的真实宽度 —— 比 dt0 粗最多一倍,但换来覆盖完整。
    // 这两件事各算各的曾经是错的:7.5px 的步落在 8px 的块里,块号每步进 0 或 1 不定,有的块一个抽样
    // 点都分不到 = 整块没被问过,于是该 60px 的影子只拖到 53px (真机量过)。
    float dt0 = rMax / max(float(uSteps), 1.0);       // uSteps 万一没被设上 (uniform 名打错就是 null
                                                     // location, 无声取 0) 也拿不到 inf/NaN
    float lod = clamp(ceil(log2(max(dt0 * uPxH, 2.0))), 1.0, float(max(uLevels - 1, 0)));
    float B = pow(2.0, lod) / uPxH;                   // 那一级一个纹素跨多少图高 = 现在的步长
    // 本像素在「图高」单位下的位置 (x 乘宽高比),与 uDir 同一条基。
    vec2 P = vec2(vUV.x * uAspect, vUV.y);
    float occ = 0.0;
    for (int i = 1; i <= ${FX_LIGHT_MARCH_MAX}; i++) {
        float pos = B * float(i);
        if (pos > rMax) break;
        // 判据:光源那侧第 i 块「这一片里的最高面」够不够挡住那条光线。光线在这一块里是抬着的,所以
        // 拿**这一块的中心**去比:拿抽样点顶替会跟着「抽样点在块里偏哪头」漂,同一个块里偏半块 =
        // 影长跟着像素位置抖 (真机量过:该 60px 的拖到 72px)。块是对齐到纹理的,块号 = floor(位置/块宽),
        // 于是中心与抽样点并不重合,这一步得自己算。拿远端比则整体截短一块,拿近端比整体拉长一块,
        // 中心把误差摊成 ±半块。
        // 一个源纹素的容差:八位深度图的量化抖动不该被当成一座墙。
        vec2 C = (floor((P + uDir * pos) / B) + 0.5) * B;
        float hs = textureLod(uH, vUV + duv * pos, lod).r;
        if (hs - h0 - uSlope * dot(C - P, uDir) >= 1.0 / 255.0) { occ = 1.0; break; }
    }
    Frag = vec4(0.0, 0.0, 0.0, occ);
}`;

// 半影:对二值 mask 做 separable 低通,一横一竖各一趟。这里**不走**引擎那条 Kawase 低通 —— 它的
// 实际扩散随半径饱和 (真机量过:Soft=16px 与 32px 出来一样宽,都是 21px),那颗钮大半程没有可观察
// 差别。这一份把 σ 直接钉在 Soft/2 上,所以「px」就是 px:5 个抽样点/方向,每点用双线性替两个原始
// 纹素 (linear sampling) = 9 点高斯;那组经典偏移与权重是在 σ=2 上量的,故整体按 σ/2 缩放。
const FX_FS_LIGHT_BLUR = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform vec2 uDir;
uniform float uSigma;
void main() {
    float k = uSigma * 0.5;
    vec2 o1 = uDir * (1.3846154 * k);
    vec2 o2 = uDir * (3.2307692 * k);
    float a = texture(uTex, vUV).a * 0.2270270270
        + (texture(uTex, vUV + o1).a + texture(uTex, vUV - o1).a) * 0.3162162162
        + (texture(uTex, vUV + o2).a + texture(uTex, vUV - o2).a) * 0.0702702703;
    Frag = vec4(0.0, 0.0, 0.0, a);
}`;

// 一横一竖两趟,落在借用区的 2/3 号面上 (缓存里那张二值 mask 自己一个字都不改)。
function fxglLightPenumbra(radius, srcTex) {
    const gl = fxgl.gl;
    const sigma = Math.max(radius, 1) / 2;
    fxglRunPass(fxgl.off[2], fxgl.progs.lightBlur, pr => {
        fxglBindTex(pr, 'uTex', srcTex, 0);
        gl.uniform2f(fxglU(pr, 'uDir'), 1 / Math.max(fxgl.w, 1), 0);
        gl.uniform1f(fxglU(pr, 'uSigma'), sigma);
    });
    fxglRunPass(fxgl.off[3], fxgl.progs.lightBlur, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[2].tex, 0);
        gl.uniform2f(fxglU(pr, 'uDir'), 0, 1 / Math.max(fxgl.h, 1));
        gl.uniform1f(fxglU(pr, 'uSigma'), sigma);
    });
    return fxgl.off[3].tex;
}

// ---- 高度场金字塔(一张带完整 mip 层级的纹理)+ mask 缓存 ----
// 金字塔是每次重烘都要整条重写的脚手架,所以只留一份;mask 按参数留着。两者都跟着 GL 上下文活 ——
// 引擎编译失败会把 fxgl.gl 置空、下次重建一个新上下文,那时旧句柄是废的(与 fx/warp.js 的
// warpFieldInit 同一条规矩)。
const lightPyr = { gl: null, w: 0, h: 0, levels: 0, tex: null, fb: null };
const lightMasks = new Map();            // key -> { tex, fb, w, h },最久没用的先退役
const lightFree = [];                    // 退役下来的面按尺寸回收:拖滑块时每帧一次重建绝不该 new 纹理
let lightOwner = null;                   // 上面那两堆面属于哪个上下文

function lightMakeTarget(gl, w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, fxgl.fmt.internal, w, h, 0, gl.RGBA, fxgl.fmt.type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h, ok };
}

function lightPyrInit(gl, w, h) {
    // 级数按**长边**算,不是短边:过滤器一旦带 MIPMAP,WebGL2 就要求整条链到 1 像素为止才算「完整」,
    // 少一级时采样直接返回全黑 = 影子整条消失(与「深度图没绑」看着一样)。
    const levels = Math.max(1, Math.floor(Math.log2(Math.max(w, h))) + 1);
    if (lightPyr.gl === gl && lightPyr.w === w && lightPyr.h === h && lightPyr.levels === levels) return true;
    // 换上下文时旧句柄属于那张已经废掉的脸,delete 也删不掉什么 —— 只在本上下文是自己时才回收。
    if (lightPyr.tex && lightPyr.gl === gl) { gl.deleteTexture(lightPyr.tex); gl.deleteFramebuffer(lightPyr.fb); }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // texStorage2D 定死整条 mip 链,level k 的尺寸就是 (w>>k, h>>k) —— 与着色器里那个 floor 除法同解。
    gl.texStorage2D(gl.TEXTURE_2D, levels, fxgl.fmt.internal, w, h);
    // 两个过滤器都是 NEAREST 家族,而且 NEAREST_MIPMAP_NEAREST 这一条是**实测换来的**:
    //   · 明写级号 (textureLod) 只在「过滤器带 MIPMAP」时才成立。真机把第 k 级用 readPixels 直接
    //     端出来、又用 textureLod(uH,uv,k) 画满整张面端出来,两份对照过:配 LINEAR(非 mip) 时后者
    //     逐像素等于对 level 0 的双线性抽样,级号被驱动整个忽略 (D3D 侧「不用 mipmap 的过滤器 ⇒ LOD
    //     钉死在 0」),于是这套「金字塔」其实一直是稀疏抽样 —— 2px 薄片的影子就是在这条上失败的
    //     (第 3 级该是 128 的那个块读回 96 = 128 与 64 的双线性中点)。
    //   · MAG/MIN 取 NEAREST 是为了 footprint 说得出口:第 k 级一个纹素正好等于 2^k 像素那**一块**
    //     的最大值,块与块之间不插值,走线读到的就是「这一片里最高的那个面」,不会把邻块掺进来。
    // 带 MIPMAP 的代价是「写第 k 级时读第 k-1 级」会被 ANGLE 判成 feedback (1282),所以下烘那一趟
    // 先画进另一家的中转面,再由 copyTexSubImage2D 搬进来 —— 见 lightBakeField。
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    lightPyr.gl = gl; lightPyr.w = w; lightPyr.h = h; lightPyr.levels = levels;
    lightPyr.tex = ok ? tex : null; lightPyr.fb = ok ? fb : null;
    if (!ok) { gl.deleteTexture(tex); gl.deleteFramebuffer(fb); lightPyr.levels = 0; }
    return ok;
}

// 下烘那一趟的中转面:它自己也是一条 mip 链,第 k 级就是第 k 块砖的大小,画完直接 copyTexSubImage2D
// 进金字塔。全程只被画、不被采样,所以过滤器无所谓。
const lightScr = { gl: null, w: 0, h: 0, levels: 0, tex: null, fb: null };

function lightScrInit(gl, w, h, levels) {
    if (lightScr.gl === gl && lightScr.w === w && lightScr.h === h && lightScr.levels === levels) return true;
    if (lightScr.tex && lightScr.gl === gl) { gl.deleteTexture(lightScr.tex); gl.deleteFramebuffer(lightScr.fb); }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, levels, fxgl.fmt.internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    // 空 framebuffer 天生就是 INCOMPLETE —— 状态要在挂上第 0 级**之后**问,否则这里永远回 false,
    // 于是整趟下烘一步都不走,而画面上只是「影子没了」。
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    lightScr.gl = gl; lightScr.w = w; lightScr.h = h; lightScr.levels = levels;
    lightScr.tex = ok ? tex : null; lightScr.fb = ok ? fb : null;
    if (!ok) { gl.deleteTexture(tex); gl.deleteFramebuffer(fb); lightScr.levels = 0; }
    return ok;
}

// 把 level k 挂成当前渲染目标,viewport 收到那一级的大小。
function lightBindLevel(k) {
    const gl = fxgl.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, lightPyr.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, lightPyr.tex, k);
    gl.viewport(0, 0, Math.max(1, lightPyr.w >> k), Math.max(1, lightPyr.h >> k));
}

function lightTakeTarget(gl, w, h) {
    for (let i = 0; i < lightFree.length; i++) {
        if (lightFree[i].w === w && lightFree[i].h === h) return lightFree.splice(i, 1)[0];
    }
    return lightMakeTarget(gl, w, h);
}

function lightRetire(gl, ent) {
    if (lightFree.length >= FX_LIGHT_CACHE_MAX) {
        gl.deleteTexture(ent.tex);
        gl.deleteFramebuffer(ent.fb);
        return;
    }
    lightFree.push(ent);
}

// 这张 mask 由什么决定:那张深度图的像素身份、它铺在谁身上(Align + 盒子)、该层网格大小、
// 以及光源那几个数。图层自己的墨**不在里面** —— 所以笔下落几百帧它一次都不重算。
function lightMaskKey(effect, l, p) {
    const align = p.align === 'Canvas' ? 'C' : 'L';
    return `${fxMapIdentity(effect, 'depth')}|${align}|${align === 'C' ? fxMapBoxStamp(l) : '-'}`
        + `|${fxgl.w}x${fxgl.h}|${p.angle}|${p.elev}|${p.scale}|${p.near}|${p.cast}|${lightSteps(p)}`;
}

function lightSteps(p) { return Math.max(4, Math.min(FX_LIGHT_MARCH_MAX, p.steps | 0)); }

// 深度图 → 高度场 + max 金字塔。返回 false = 这一趟烘不出东西(贴图解析不出像素)。
function lightBakeField(gl, p, effect, l) {
    const img = fxMapImage(fxMapRef(effect, 'depth'));
    if (!img) return false;
    const n = nativeSize(img);
    const fr = fxMapFrame(p.align, l);
    lightBindLevel(0);
    fxglRunPass({ fb: lightPyr.fb }, fxgl.progs.lightBake, pr => {
        fxglBindTex(pr, 'uDepth', fxgl.texMap2, 0);
        gl.uniform2f(fxglU(pr, 'uMapU'), fr.u[0], fr.u[1]);
        gl.uniform2f(fxglU(pr, 'uMapV'), fr.v[0], fr.v[1]);
        gl.uniform2f(fxglU(pr, 'uMapB'), fr.b[0], fr.b[1]);
        gl.uniform1f(fxglU(pr, 'uNearBright'), p.near === 'bright' ? 1 : 0);
        gl.uniform2f(fxglU(pr, 'uTexel'), 1 / Math.max(n.w, 1), 1 / Math.max(n.h, 1));
    }, { w: lightPyr.w, h: lightPyr.h });
    for (let k = 1; k < lightPyr.levels; k++) {
        const sw = Math.max(1, lightPyr.w >> (k - 1)), sh = Math.max(1, lightPyr.h >> (k - 1));
        const dw = Math.max(1, lightPyr.w >> k), dh = Math.max(1, lightPyr.h >> k);
        // 金字塔自己写自己读是不行的:那张面的过滤器带 MIPMAP(级号必须生效),而 ANGLE 的 feedback
        // 检查在过滤器带 MIPMAP 时认为这次采样「可能碰任何一级」,于是写第 k 级还读同一张纹理直接
        // INVALID_OPERATION(1282,真机撞过)。所以这一趟画进另一家的第 k 级,再由 copyTexSubImage2D
        // 搬进金字塔 —— 搬是 GL 侧的位拷贝,不经过着色器取样,与 feedback 无关。
        if (!lightScrInit(gl, lightPyr.w, lightPyr.h, lightPyr.levels)) return false;
        gl.bindFramebuffer(gl.FRAMEBUFFER, lightScr.fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, lightScr.tex, k);
        fxglRunPass({ fb: lightScr.fb }, fxgl.progs.lightDown, pr => {
            fxglBindTex(pr, 'uTex', lightPyr.tex, 0);
            gl.uniform2f(fxglU(pr, 'uSrcSize'), sw, sh);
            gl.uniform2f(fxglU(pr, 'uDstSize'), dw, dh);
            gl.uniform1f(fxglU(pr, 'uSrcLevel'), k - 1);
        }, { w: dw, h: dh });
        // 此刻绑着的是中转面,金字塔只作为「要写入的目标」被绑定 —— 复制的两个方向不是同一个接口。
        gl.bindTexture(gl.TEXTURE_2D, lightPyr.tex);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, k, 0, 0, 0, 0, dw, dh);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
}

// 走线出一张二值 mask。命中缓存就直接回那张面,一个抽样都不花。
function lightShadowMask(gl, p, effect, l) {
    // 换上下文 = 缓存里那些句柄全废了(旧面上的纹理在新上下文不存在),整堆直接丢掉:不删(删不掉)、
    // 也不查(查了就是把废句柄绑进新上下文)。金字塔自己认得出换了脸,见 lightPyrInit。
    if (lightOwner !== gl) { lightOwner = gl; lightMasks.clear(); lightFree.length = 0; }
    if (!lightPyrInit(gl, fxgl.w, fxgl.h)) return null;
    const key = lightMaskKey(effect, l, p);
    const hit = lightMasks.get(key);
    if (hit) { lightMasks.delete(key); lightMasks.set(key, hit); return hit.tex; }
    if (!lightBakeField(gl, p, effect, l)) return null;
    const ent = lightTakeTarget(gl, fxgl.w, fxgl.h);
    if (!ent.ok) { lightRetire(gl, ent); return null; }
    const a = p.angle * Math.PI / 180;
    const e = p.elev * Math.PI / 180;
    // 光源向量与迈步用同一条基(画布角 0° = 右、90° = 下,uv 的 y 朝上故取负,与 fxglDirUV 同规矩)。
    const dx = Math.cos(a) * (fxgl.w / Math.max(fxgl.h, 1)), dy = -Math.sin(a);
    const dl = Math.hypot(dx, dy) || 1;
    const scale = Math.max(p.scale, 1) / 100;
    fxglRunPass(ent, fxgl.progs.lightShadow, pr => {
        fxglBindTex(pr, 'uH', lightPyr.tex, 0);
        gl.uniform2f(fxglU(pr, 'uDir'), dx / dl, dy / dl);
        gl.uniform1f(fxglU(pr, 'uAspect'), fxgl.w / Math.max(fxgl.h, 1));
        // 横向走一个图高抬 tan(Elev) 个「世界距离」,而一个满幅深度 = scale 个图高 ⇒ 除回来。
        gl.uniform1f(fxglU(pr, 'uSlope'), Math.tan(e) / scale);
        gl.uniform1f(fxglU(pr, 'uPxH'), fxgl.h);
        gl.uniform1f(fxglU(pr, 'uMax'), p.cast / Math.max(fxgl.h, 1));
        gl.uniform1i(fxglU(pr, 'uLevels'), lightPyr.levels);
        gl.uniform1i(fxglU(pr, 'uSteps'), lightSteps(p));
    });
    lightMasks.set(key, ent);
    for (const k of lightMasks.keys()) {
        if (lightMasks.size <= FX_LIGHT_CACHE_MAX) break;
        lightRetire(gl, lightMasks.get(k));
        lightMasks.delete(k);
    }
    return ent.tex;
}

function fxglLight(col, p, effect, l) {
    const gl = fxgl.gl;
    const a = p.angle * Math.PI / 180, e = p.elev * Math.PI / 180, ce = Math.cos(e);
    const rgb = fxHexToRgb01(p.color);
    const tint = fxHexToRgb01(p.tint);
    // 副槽就绪(引擎按 needsMap2When 决定它有没有像素)且强度 > 0 才走线,否则连步都不迈。
    const march = fxgl.hasMap2 === 1 && p.shadow > 0;
    // 影子开着一张图都没来 = 光照照旧、阴影没有。这一下必须写在链上,不许看着像「阴影怎么没生效」。
    if (p.shadow > 0 && !march) fxgl.skip = 'Lighting: no depth map for shadows';
    let mask = march ? lightShadowMask(gl, p, effect, l) : null;
    // 该走的线走了却烘不出面(金字塔建不起来 / 深度图读不出像素 / framebuffer 不完整)= 一样要说,
    // 不许让「有图但没影」看着像「影子的强度没对上」。
    if (march && !mask) fxgl.skip = 'Lighting: shadow mask could not be built';
    if (mask && p.soft > 0) {
        // 半影 = 对 mask 做空间低通(光源有半径 ⇒ 影子边缘有一段渐变)。二值那张面自己不动,糊出来
        // 的在借用区里,于是 Soft 只改这两趟、不改缓存里的重建。
        mask = fxglLightPenumbra(p.soft, mask);
    }
    const dst = fxgl.off[1 - col.slot];
    fxglRunPass(dst, fxgl.progs.light, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uMap', fxgl.texMap, 1);
        // 没有 mask 就不绑它:uShadow 已经归 0,那一支不会进采样器。绑一张没分配过层级的纹理会让整次
        // drawArrays 报 INVALID_OPERATION,那才是「整条链不出图」而不是「没影子」。
        if (mask) fxglBindTex(pr, 'uShadowMask', mask, 2);
        // 光朝向量的基与法线图一致:画布角(0° 右、90° 下)映到 uv 时 y 取负,和 fxglDirUV 同一条
        // 规矩;z = sin(elev) 朝屏幕外,elev=90° 即正对打光。
        gl.uniform3f(fxglU(pr, 'uL'), Math.cos(a) * ce, -Math.sin(a) * ce, Math.sin(e));
        gl.uniform3f(fxglU(pr, 'uColor'), rgb[0], rgb[1], rgb[2]);
        gl.uniform3f(fxglU(pr, 'uTint'), tint[0], tint[1], tint[2]);
        gl.uniform1f(fxglU(pr, 'uIntensity'), p.intensity / 100);
        gl.uniform1f(fxglU(pr, 'uSpec'), p.spec / 100);
        gl.uniform1f(fxglU(pr, 'uGloss'), p.gloss / 100);
        gl.uniform1f(fxglU(pr, 'uGreen'), p.green === 'down' ? -1 : 1);
        gl.uniform1f(fxglU(pr, 'uShadow'), mask ? p.shadow / 100 : 0);
    });
    col.slot = 1 - col.slot;
}

defineEffect({
    type: 'lighting',
    label: 'Lighting',
    group: 'Light',
    icon: 'light',
    needsMap: 'Normal',
    needsMap2: { key: 'depth', role: 'Depth' },
    needsMap2When: p => p.shadow > 0,
    desc: 'Relights the layer through a bound tangent-space normal map — a diffuse term around the light direction plus an optional specular highlight, both taking the light’s own colour. Bind a depth map and the same light is rebuilt into a shadow mask: the map becomes a height field, a ray runs from each pixel toward the light at tan(Elev), and whatever stands higher than that ray cuts the light off, so the shadow stretches Δh·Scale/tan(Elev) out of the occluder instead of stopping at a fixed pixel length. The mask is binary and then softened by Soft, which is a real penumbra radius. Scale says how much distance the map’s whole depth range is worth, in image heights — it is the one knob that makes the length mean anything. Align says whether the depth map is measured against the whole canvas or against this layer alone (the normal map always lies on this layer). Cast only caps how far the ray may travel. Shadow=0 means no ray is marched at all. Colour only: the maps never show through, nothing moves, alpha untouched.',
    params: [
        { key: 'map', kind: 'map', def: null },
        { key: 'angle', label: 'Angle', min: 0, max: 359, step: 1, def: 135, unit: '°' },
        { key: 'elev', label: 'Elev', min: 0, max: 90, step: 1, def: 45, unit: '°' },
        { key: 'intensity', label: 'Light', min: -100, max: 100, step: 1, def: 50, unit: '%' },
        { key: 'spec', label: 'Spec', min: 0, max: 100, step: 1, def: 25, unit: '%' },
        { key: 'gloss', label: 'Gloss', min: 0, max: 100, step: 1, def: 60, unit: '%' },
        { key: 'color', label: 'Color', kind: 'color', def: '#ffffff' },
        // Shadow=0 时整条走线根本不跑 (引擎连副槽都不取),所以它之后那一批旋钮只在影子开着时出现 ——
        // 与读数行同一口径 (readout 在 shadow<=0 就只报光照那半截)。它自己排在最前 = 这一组开关的门。
        { key: 'shadow', label: 'Shadow', min: 0, max: 100, step: 1, def: 0, unit: '%' },
        { key: 'depth', kind: 'map', def: null, when: p => p.shadow > 0 },
        { key: 'tint', label: 'Tint', kind: 'color', def: '#000000', when: p => p.shadow > 0 },
        // 深度铺在谁身上是那张深度图的事,法线图永远按本层网格读 —— 与几何 Warp 那颗同名旋钮同词。
        { key: 'align', label: 'Align', kind: 'enum', options: ['Canvas', 'Local'], def: 'Canvas', when: p => p.shadow > 0 },
        { key: 'near', label: 'Near', kind: 'enum', options: ['dark', 'bright'], def: 'dark', when: p => p.shadow > 0 },
        // Scale = 整张图的深度满幅值多少个图高。没有它,「影长」这件事在单位上就没有定义
        // (满幅深度与像素之间没有任何东西把它们连起来)。
        { key: 'scale', label: 'Scale', min: 10, max: 400, step: 1, def: 100, unit: '%', when: p => p.shadow > 0 },
        { key: 'soft', label: 'Soft', min: 0, max: 64, step: 1, def: 6, unit: 'px', when: p => p.shadow > 0 },
        { key: 'cast', label: 'Cast', min: 16, max: 1024, step: 8, def: 1024, unit: 'px', when: p => p.shadow > 0 },
        { key: 'steps', label: 'Steps', min: 4, max: 32, step: 1, def: 16, when: p => p.shadow > 0 },
        { key: 'green', label: 'Green', kind: 'enum', options: ['up', 'down'], def: 'up' },
    ],
    // 参数换形状:旧存档里 Cast 是「走线总长(1..64px)」,和它现在的意思(推进上限)没有忠实换算,
    // 所以旧值不继承,读回新默认 = 让几何自己决定影长。Soft 旧义是高度差阈值(0..50),新义是半影
    // 半径(px),两者同为「越大越软」,数值原样读回来就是合理的那一档。
    //
    // 闸口认「这条记录长没长成现在这个样子」,不认「cast 字段在不在」:effectParams 每读一次参数就
    // 跑一次 migrate (undo 快照、缓存判定、面板重绘全都算),所以无条件改写等于把这颗钮钉死在 1024 ——
    // 真机量过:Cast 拧 16/30/64/1024 四档,烘出来的 mask 缓存键全是 |1024|,影子一律 60px。
    // scale 是这次才有的字段,它在了就说明这条记录是在新语义下写下的,用户拧的那一档得留下。
    migrate(raw, out) {
        if (raw.scale !== undefined) return;
        out.cast = 1024;
    },
    // Canvas 对齐的深度吃的还是「该层盒子落在画布哪儿」,而拖图层既不改像素也不改 params。
    // 链的缓存身份必须知道这一件事,否则挪完层还在用挪之前烘好的那张 mask。
    stamp(effect, l) {
        const p = effectParams(effect);
        if (p.shadow <= 0 || p.align !== 'Canvas') return '';
        return 'box:' + fxMapBoxStamp(l);
    },
    shaders: {
        light: FX_FS_LIGHT,
        lightBake: FX_FS_LIGHT_BAKE,
        lightDown: FX_FS_LIGHT_DOWN,
        lightShadow: FX_FS_LIGHT_SHADOW,
        lightBlur: FX_FS_LIGHT_BLUR,
    },
    run: fxglLight,
    readout(p, n, effect) {
        const base = `${fxMapShort(effect)}  ${n(p.angle)}°  ${n(p.elev)}°  ${n(p.intensity)}%  s${n(p.spec)}`;
        // 阴影开着却读不出影子 = 深度图没绑,把那张图的名字写出来 = 可见文本,不许静默降级。
        // 两头缺的各说各的名字 (fxMapShort 按槽的角色报 no normal / no depth),不会混成一句。
        if (p.shadow <= 0) return base;
        const depth = fxMapShort(effect, 'depth');
        // 烘影子的几何三件都要报:满幅标定、半影半径、深度铺在谁身上;极性拧反整张 mask 就落在错
        // 的一侧, 而画面看起来「有影子」,所以那一个词也得写在行上 (与景深同词 inv)。
        return `${base}  sh${n(p.shadow)}  ${depth}`
            + `  ${n(p.scale)}%  ${n(p.soft)}px  ${p.align === 'Local' ? 'local' : 'canvas'}`
            + `${p.near === 'bright' ? '  inv' : ''}`;
    },
    thumb(g, box) {
        const cx = box.x + box.w / 2, cy = box.y + box.h / 2, r = Math.min(box.w, box.h) / 2;
        // 光从左上打过来,影子就落在右下 —— 一颗带投影的球同时说了两件事:彩色的高光与重建的阴影。
        g.save();
        g.filter = 'blur(2.4px)';
        g.fillStyle = 'rgba(0,0,0,0.72)';
        g.beginPath();
        g.ellipse(cx + r * 0.5, cy + r * 0.5, r * 0.72, r * 0.4, 0.6, 0, Math.PI * 2);
        g.fill();
        g.restore();
        const gr = g.createRadialGradient(cx - r * 0.45, cy - r * 0.45, r * 0.08, cx, cy, r * 1.15);
        gr.addColorStop(0, '#e8eeff');
        gr.addColorStop(0.4, '#6f8cff');
        gr.addColorStop(1, '#12121b');
        g.fillStyle = gr;
        g.beginPath();
        g.arc(cx, cy, r, 0, Math.PI * 2);
        g.fill();
    },
});
