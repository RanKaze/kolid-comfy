// fx/lighting.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图。
// 它绑一张法线图 (needsMap) 打光,还可以再绑一张深度图 (needsMap2) 当高度场把阴影算出来;
// 两个槽的解析规则见 fx/maps.js。

// 光照:切线空间法线图(uv 基:y 向上,因为上传时已 UNPACK_FLIP_Y;平坦处 = (0.5,0.5,1))做
// Lambert 漫反射 + Blinn-Phong 高光。绿色通道的朝向按贴图族选(OpenGL 朝上 / DirectX 朝下)。
// 灯的颜色逐通道作用在漫反射与高光项上 —— 从前它只进高光项,所以 Spec=0 时整盏灯看着是白色的。
// 那束光只有一个来源:姿态四元数把 +X 送到哪儿 (fxLightVec)。绑了 Direction attribute 就是它自己的
// 四元数,没绑是把 Angle/Elev 两颗旋钮折成同一枚 —— 于是漫反射、朝向门、迈步、抽头吃同一份,
// 「画面亮在哪一面」和「影子拖向哪一边」不可能两说。
//
// 阴影 = 一张从深度图 + 法线图重建出来的 shadow mask,与光照**分家**跑几趟:
//   1) 烘高度场:深度图按 Near 极性 + Align 基写进一张 mip 纹理,一个贴图像素之内取四角最大值 ——
//      金字塔最低那级也得当「这块里最高的那个」来问。这里同时开一道**朝向门**:法线图说这一面
//      背对中心光线(dot(N,L)≤0)时,它**没有资格当遮挡物**。r 通道留真高度(本像素自己得知道
//      自己站多高),g 通道放门筛过的高度(走线拿它比),两级各自逐通道取最大。
//   2) 逐级 2×2 取最大值往下烘。往下每一趟不能边读边写同一张纹理:mipmap 过滤器下这是硬
//      INVALID_OPERATION(1282,真机撞过),所以画进一张同规格的中转面 lightScr 的第 k 级,
//      再由 copyTexSubImage2D 搬进金字塔。级别点名也只有配了 mip 过滤器才真的生效 ——
//      非 mipmap 的 min 过滤器下 textureLod 的 level 参数被 ANGLE 整个忽略,每读都落回 level 0
//      (把 level k 的 readPixels 与 textureLod(...,k) 的画回读并排比过),于是 min 一律用
//      NEAREST_MIPMAP_NEAREST、mag 用 NEAREST:块内是精确最大值,块间不插值。
//   3) 逐像素沿**光源那侧**在高度场上推进:横向走 r 个图高,光线抬 sk·r 个满幅深度。挡没挡是几何
//      自己算的 —— 影长 = Δh·Scale/tan(Elev),Cast 只是截断它的那道闸(默认 1024px ≈ 不截)。
//      sk 里减掉了**本像素自己的斜面**:法线图给的 ∂z/∂像素 换成同单位后,光线相对地面抬升的速率
//      就变了 —— 一面迎着光的坡把半影摊宽,一面顺着光下行的坡直接看不见那盏灯。
//   4) 半影 = 光源有角半径,所以它不是一个仰角而是一**扇**仰角:Elev ± Size 之间取 5 条光线(高斯
//      权重,σ=Size/2、截在 ±Size),每条各走各的线、各算各的挡没挡,occ = Σ wᵢ·occᵢ。这一条是
//      整个改动的核心 —— 同一条二值判据在不同仰角下的落点相差「缝隙 × tanα」,于是
//      贴墙那一头(缝隙=0)天生是硬边,越离开的头越宽,而**投光体自己受光那一面**在任何一条仰角下
//      都不被挡,加权和仍是 0 ⇒ 影子绝不会被糊到挡光的东西脸上。Size=0 时 5 条并成 1 条 = 硬边。
//      仰角是**共用同一条迈步**的:方位相同、抽样点相同,每一步一次 textureLod、五条 ALU 比较,
//      所以抽头数几乎不加抽样预算(代价实测见仓库外探针)。
//   5) 金字塔是 max 块,块与块之间不插值,影缘天生带着「块宽」周期的方格感;走完线再补一道
//      **引导保边平滑**(可分离的联合双边滤波,横竖各一趟):权重 = 空间高斯 × 深度相似 × 法线相似
//      —— 只有同一面(深度顺着坡攒、法线不折)上的邻像素才许互相平均,跨过深度跳变或法线翻折的
//      抽头被压到 0,所以贴墙的接触边与投光体自己的受光面不会被糊进来。半径是**直接以像素计的
//      旋钮**(Smooth,0 = 整道不跑):块量化与走线噪声的尺度随 Steps 变,交给用户对着画面拧,
//      比隐藏的「块宽 × 百分比」换算可预期。这是启发式不是几何:它修的是「块量化」这道采样噪声,
//      不碰半影本身。
//   从前这两件事都是错的:更早一版把 Soft 当「高度差阈值」(occ 正比于对面多陡 = 一条贴着轮廓的
//   emboss 暗边),推进距离又被钉死 ≤64px;上一版改成一趟二值 mask 之后拿**屏幕空间固定半径高斯**
//   去糊它,于是接触边和尖端边一样宽(几何说前者该是 0)、影子从墙根脱开 5–13px、糊到投光体自己的
//   受光面上(实测 Soft=16 时那两片掉到 61% 亮度),而 Soft=64 时整条影子最深只剩 14% 黑。
//   半影是几何属性,不许拿一次画面低通顶替。
// 横向单位统一成「图高」,两轴都按它算,梯度也是(每像素 1/h):从前 x 除宽、y 除高、抬高只除宽,
// 非方形图层上影子的方向与长度会随宽高比漂。迈步是**等长步,步长 = 那一级的块宽**:相邻两步问的那两
// 块首尾相接,整条路径没有一段没被问过,于是影子的边缘误差 = 半块,而它随影长一起长。
// 块是纹理对齐的,所以光线高度要在**块中心**上问(由格子的 floor 反推),拿抽样点顶替会跟着抽样点
// 在块里偏哪头一起偏 —— 该 60px 的拖到 72px。定步长直读单纹素(块比步长窄)会把比步距薄的障碍整根
// 漏掉;步长几何加倍那一版也不行(2,6,14,30,62px 那种稀疏格):「像素在不在影子里」要求区间
// [到遮挡物的距离, 影长] 里恰好落着一格,影长落在两格之间时整段影子被截在上一格那里 —— 两条都在真机上量过。
// 只改 RGB:高光加在色上,阴影乘在色上,贴图本身永远不渗进画面。
const FX_LIGHT_MARCH_MAX = 512;        // 走线循环的迭代上界。迭代数 = ceil(R/块宽),块宽地板在 2px(lod ≥ 1)
                                       // 而 R ≤ Cast ≤ 1024px,所以 512 就是几何上限;顶档 2⁹ 的 dt0 正好落进
                                       // 块宽地板,迭代数走满这一条。
const FX_LIGHT_SMOOTH_MAX = 32;        // 引导平滑的半径上界(像素)= Smooth 旋钮的满档,也是着色器循环的展开上界
const FX_LIGHT_CACHE_MAX = 4;          // 按参数缓存的 shadow mask 留几份(拖滑块每帧重建时用回收池,不 new 纹理)
// 仰角抽头:σ=1 的高斯落在 [-2σ,-σ,0,σ,2σ],把它钉在「截到 ±Size」上 ⇒ σ = Size/2。
// 权重和 = 1,所以 Size=0(五条并成同一条)出来的 mask 与二值那张逐字节相同。
const FX_LIGHT_TAPS = [[-2, 0.0545], [-1, 0.2442], [0, 0.4026], [1, 0.2442], [2, 0.0545]];
// 送进着色器的那两条数组:权重是常量,所以填一次;斜率每重建一次 mask 改写一遍。留着复用是因为
// 拖滑块时每帧都要重走线,而「每帧 new 两条 Float32Array」在实时预览那条路上是要计成本的。
const lightWK = Float32Array.from(FX_LIGHT_TAPS, t => t[1]);
const lightSlopeK = new Float32Array(FX_LIGHT_TAPS.length);


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
    // mask 在 alpha 上,值已经是「灯盘那 5 条光线的加权遮挡」= 半影本身,走出线后又过了一道
    // depth+normal 引导的保边平滑把块锯齿抹掉,这一趟只管乘色,不再碰它。
    // 没深度图时 uShadow 被 JS 侧归 0,这一支根本不进采样器 —— 那个采样器于是留在默认单元 0 上也无所谓(0 号永远是这张色彩面)。
    float occ = uShadow > 0.0 ? texture(uShadowMask, vUV).a : 0.0;
    // 影子是乘法:Tint 就是被挡住那部分乘上去的颜色(黑 = 传统压暗,青色 = 彩色影子),深浅由 Shadow 说。
    lit *= mix(vec3(1.0), uTint, uShadow * occ);
    Frag = vec4(clamp(lit, 0.0, 1.0), c.a);
}`;

// 高度场 level 0:深度图 → 本层网格。「高度 = 离相机多近」,所以 near=dark 那张图(raw 本身是距离)
// 要取反才是高度 —— 与景深/体积雾那颗同名旋钮同一条读法。
// 两个通道两种用途:r = 真高度(本像素自己站多高,走线算光线的起点要用),
// g = 朝向门筛过的高度(只有**面朝这条中心光线**的那一面有资格挡别人的光)。max 金字塔只会说
// 「这一片里最高的面」,它分不清那一面是朝过来还是朝过去 —— 墙的另一侧照样能把墙身后的东西挡住,
// 而物理上那儿根本被墙自己接着,没有光可挡。门开在烘这一趟,金字塔往下每一级的最大值于是
// 天生是「这一片里最高的**受光**面」。法线图永远按本层网格读(与漫反射/高光那张同一个 vUV)。
const FX_FS_LIGHT_BAKE = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uDepth;
uniform sampler2D uNormal;
uniform vec2 uMapU;
uniform vec2 uMapV;
uniform vec2 uMapB;
uniform vec3 uL;
uniform float uGreen;
uniform float uNearBright;
uniform vec2 uTexel;
void main() {
    vec2 muv = uMapU * vUV.x + uMapV * vUV.y + uMapB;
    vec2 q = uTexel * 0.5;
    float d = max(max(texture(uDepth, muv + vec2(-q.x, -q.y)).r, texture(uDepth, muv + vec2(q.x, -q.y)).r),
                  max(texture(uDepth, muv + vec2(-q.x, q.y)).r, texture(uDepth, muv + vec2(q.x, q.y)).r));
    float h = clamp(uNearBright > 0.5 ? d : 1.0 - d, 0.0, 1.0);
    vec3 n = texture(uNormal, vUV).xyz;
    n = vec3(n.x * 2.0 - 1.0, (n.y * 2.0 - 1.0) * uGreen, max(n.z * 2.0 - 1.0, 0.05));
    Frag = vec4(h, dot(n, uL) > 0.0 ? h : 0.0, 0.0, 1.0);
}`;

// 往下烘一级:2×2 子块取最大值。**逐通道各取各的最大** —— r 与 g 是两种东西(真高度 / 受光高度),
// 拿一个标量 max 再把两个通道写成一个值会把朝向门抹平。vUV 落在输出纹素的中心 = (i+0.5)/N,所以 floor(vUV·dstSize) 就是
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
    vec4 a = textureLod(uTex, c, uSrcLevel);
    vec4 b = textureLod(uTex, c + vec2(st.x, 0.0), uSrcLevel);
    vec4 d = textureLod(uTex, c + vec2(0.0, st.y), uSrcLevel);
    vec4 e = textureLod(uTex, c + st, uSrcLevel);
    Frag = vec4(max(max(a.r, b.r), max(d.r, e.r)),
                max(max(a.g, b.g), max(d.g, e.g)), 0.0, 1.0);
}`;

const FX_FS_LIGHT_SHADOW = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uH;
uniform sampler2D uNormal;
uniform vec2 uDir;
uniform float uAspect;
uniform float uGreen;
uniform float uInvScale;
uniform float uPxH;
uniform float uMax;
uniform int uLevels;
uniform int uSteps;
uniform float uSlopeK[${FX_LIGHT_TAPS.length}];
uniform float uWK[${FX_LIGHT_TAPS.length}];
void main() {
    // r = 本像素自己的真高度 (起点要用它,朝向门不许把它压成 0);遮挡物一律问 .g。
    float h0 = textureLod(uH, vUV, 0.0).r;
    // uDir 是「图高」单位下的单位向量(x 已经乘过宽高比),换到 uv 就是 x 再除回来。
    vec2 duv = vec2(uDir.x / uAspect, uDir.y);
    // 迈出画面的两道闸,加上 Cast 那道上限:这三条对扇里 5 个仰角是同一条(方位相同、抽样点相同)。
    float rx = duv.x > 0.0 ? (1.0 - vUV.x) / duv.x : (duv.x < 0.0 ? -vUV.x / duv.x : 1e9);
    float ry = duv.y > 0.0 ? (1.0 - vUV.y) / duv.y : (duv.y < 0.0 ? -vUV.y / duv.y : 1e9);
    float R = min(min(rx, ry), uMax);
    // 脚下那面**局部**的坡:高度场只给「这一片里最高的面」那把粗尺子,量不出本像素自己站的斜面,
    // 而法线图正是干这个的。切空间法线除以 n.z = 沿这条光线每走一个图高地面抬多少 (乘 n 那侧的
    // 单位换算,再按 Scale 换成与 uSlopeK 同单位)。光线相对地面抬升的速率于是是 sk = tan(elev)/Scale - tilt:
    // 迎光的坡让 sk 变小 ⇒ 同一个遮挡物从更远处就挡得住、半影跟着摊宽;顺光下行的坡让 sk 变大 ⇒ 收窄。
    // 卡在中心仰角斜率的 ±一半:n.z→0 (近垂直的面) 在这个模型里没有「脚下的地面」可谈,不许它把 5 条
    // 光线全判成「被自己脚下埋掉」,那会把一整面受光的墙涂黑。
    vec3 n = texture(uNormal, vUV).xyz;
    n = vec3(n.x * 2.0 - 1.0, (n.y * 2.0 - 1.0) * uGreen, max(n.z * 2.0 - 1.0, 0.05));
    float tilt = clamp(-(dot(n.xy, uDir) / n.z) * uInvScale,
                       -0.5 * uSlopeK[${FX_LIGHT_TAPS.length >> 1}], 0.5 * uSlopeK[${FX_LIGHT_TAPS.length >> 1}]);
    // 半影:光源是一个有角半径的圆盘 ⇒ 不是一个仰角而是一**扇**仰角 (Elev ± Size, 高斯权重)。
    // 5 条光线**共用同一条迈步**:每步一次 textureLod、五条 ALU 比较,所以抽头几乎不加抽样预算。
    // 贴墙那一头缝隙 = 0 ⇒ 五条同时被挡 = 天生硬边;越离开遮挡物它们越分歧,带就越宽。
    float w[${FX_LIGHT_TAPS.length}];
    float occ = 0.0;
    float live = 0.0;
    for (int i = 0; i < ${FX_LIGHT_TAPS.length}; i++) {
        float sk = uSlopeK[i] - tilt;
        // sk <= 0 只在脚下那片地**朝着灯那侧抬升**时才等于「被地面自己埋掉」;平地配一条平行于地面的
        // 光线 (Elev=0 那一档) 不算埋 —— 它谁都挡不住, 只是掠射。不分开写就会在整个画面上留一层
        // w=0.0545 的灰纱, 那颗钮拧到底时看着像「影子怎么到处都是」。
        if (sk <= 1e-6 && tilt > 1e-6) { occ += uWK[i]; w[i] = 0.0; }
        else { w[i] = uWK[i]; live += w[i]; }
    }
    // 等长迈步,而且**步长 = 块宽**:每走一步正好前进一个块,块号 1,2,3… 连续铺到 R,所以整条
    // 路径没有一段没被问过,也没有一个块分不到抽样点。
    // 先按「想要的步长」dt0 = R/Steps 选出罩得住它的那一级 (ceil ⇒ 块 ≥ 步长),然后把步长改成
    // 那块的真实宽度 —— 比 dt0 粗最多一倍,但换来覆盖完整。
    // 这两件事各算各的曾经是错的:7.5px 的步落在 8px 的块里,块号每步进 0 或 1 不定,有的块一个抽样
    // 点都分不到 = 整块没被问过,于是该 60px 的影子只拖到 53px (真机量过)。
    float dt0 = R / max(float(uSteps), 1.0);           // uSteps 万一没被设上 (uniform 名打错就是 null
                                                     // location, 无声取 0) 也拿不到 inf/NaN
    float lod = clamp(ceil(log2(max(dt0 * uPxH, 2.0))), 1.0, float(max(uLevels - 1, 0)));
    float B = pow(2.0, lod) / uPxH;                   // 那一级一个纹素跨多少图高 = 现在的步长
    // 本像素在「图高」单位下的位置 (x 乘宽高比),与 uDir 同一条基。
    vec2 P = vec2(vUV.x * uAspect, vUV.y);
    for (int i = 1; i <= ${FX_LIGHT_MARCH_MAX}; i++) {
        float pos = B * float(i);
        if (pos > R || live <= 0.0) break;
        // 判据:光源那侧第 i 块「这一片里最高的**受光**面」够不够挡住那条光线。光线在这一块里是抬着的,所以
        // 拿**这一块的中心**去比:拿抽样点顶替会跟着「抽样点在块里偏哪头」漂,同一个块里偏半块 =
        // 影长跟着像素位置抖 (真机量过:该 60px 的拖到 72px)。块是对齐到纹理的,块号 = floor(位置/块宽),
        // 于是中心与抽样点并不重合,这一步得自己算。拿远端比则整体截短一块,拿近端比整体拉长一块,
        // 中心把误差摊成 ±半块。
        vec2 C = (floor((P + uDir * pos) / B) + 0.5) * B;
        float gap = textureLod(uH, vUV + duv * pos, lod).g - h0;
        float along = dot(C - P, uDir);
        float run = 0.0;
        for (int k = 0; k < ${FX_LIGHT_TAPS.length}; k++) {
            if (w[k] <= 0.0) continue;
            // 一个源纹素的容差:八位深度图的量化抖动不该被当成一座墙。
            if (gap - (uSlopeK[k] - tilt) * along >= 1.0 / 255.0) { occ += w[k]; w[k] = 0.0; }
            else if (pos < (1.0 - h0) / (uSlopeK[k] - tilt)) run += w[k];   // 还在路上
            else w[k] = 0.0;                                                 // 这条光线抬到顶:再往前没人挡得住
        }
        live = run;
    }
    Frag = vec4(0.0, 0.0, 0.0, occ);
}`;

// mask 的引导保边平滑:可分离的联合双边滤波,横竖各跑一趟(两次一维比一次二维便宜一个数量级)。
// 方格感的根源是高度场那张 max 金字塔:NEAREST 取块最大、块间不插值,块量化直接印在影缘上。
// 这是**采样噪声**不是几何 —— 不能拿无引导的低通顶替(前两代在画面上糊高斯的失败见文件头),所以
// 每个抽头过两道门:
//   · 法线门:中心像素与抽头的法线夹角大就压到 0(pow 24 很陡)。贴墙的接触边两侧深度近乎连续
//     (地挨着墙根),深度门拦不住那种翻折,全靠这道。
//   · 深度门:高斯加权,容差 σ 随半径长(JS 侧算好送进来)—— 核越大,同一斜面上攒出的深度差越多,
//     那是坡不是断崖;真正的悬空跳变仍旧拦死。浮空物体的影子边不往背景上漏。
// 两道门都过了,剩下的是同一面,平均就是把块量化抹平;权重归一(wsum),半影梯度原样保留。
// 深度按 Align 的映射读(uMapU/V/B 与烘场那趟同式),法线按本层网格读 —— 与另外几趟同一条规矩。
const FX_FS_LIGHT_SMOOTH = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uMask;
uniform sampler2D uDepth;
uniform sampler2D uNormal;
uniform vec2 uMapU;
uniform vec2 uMapV;
uniform vec2 uMapB;
uniform vec2 uStep;
uniform float uRadius;
uniform float uSigmaD;
uniform float uGreen;
void main() {
    float sum = texture(uMask, vUV).a;
    if (uRadius < 0.5) { Frag = vec4(0.0, 0.0, 0.0, sum); return; }
    vec3 nc = texture(uNormal, vUV).xyz;
    nc = normalize(vec3(nc.x * 2.0 - 1.0, (nc.y * 2.0 - 1.0) * uGreen, max(nc.z * 2.0 - 1.0, 0.05)));
    float dc = texture(uDepth, uMapU * vUV.x + uMapV * vUV.y + uMapB).r;
    float wsum = 1.0;
    float sig2 = uRadius * uRadius * 0.25;   // 空间权重 σ = 半径的一半
    for (int i = 1; i <= ${FX_LIGHT_SMOOTH_MAX}; i++) {
        float fi = float(i);
        if (fi > uRadius) break;
        float ws = exp(-0.5 * fi * fi / sig2);
        for (int s = 0; s < 2; s++) {
            vec2 uv = vUV + uStep * fi * (s == 0 ? -1.0 : 1.0);
            vec3 nt = texture(uNormal, uv).xyz;
            nt = normalize(vec3(nt.x * 2.0 - 1.0, (nt.y * 2.0 - 1.0) * uGreen, max(nt.z * 2.0 - 1.0, 0.05)));
            float wn = pow(max(dot(nc, nt), 0.0), 24.0);
            float dd = texture(uDepth, uMapU * uv.x + uMapV * uv.y + uMapB).r - dc;
            float wd = exp(-dd * dd / (uSigmaD * uSigmaD));
            float w = ws * wn * wd;
            sum += texture(uMask, uv).a * w;
            wsum += w;
        }
    }
    Frag = vec4(0.0, 0.0, 0.0, sum / max(wsum, 1e-4));
}`;

// ---- 高度场金字塔(一张带完整 mip 层级的纹理)+ mask 缓存 ----
// 金字塔是每次重烘都要整条重写的脚手架,所以只留一份;mask 按参数留着。两者都跟着 GL 上下文活 ——
// 引擎编译失败会把 fxgl.gl 置空、下次重建一个新上下文,那时旧句柄是废的(与 fx/warp.js 的
// warpFieldInit 同一条规矩)。
const lightPyr = { gl: null, w: 0, h: 0, levels: 0, tex: null, fb: null };
const lightMasks = new Map();            // key -> { tex, fb, w, h },最久没用的先退役
const lightFree = [];                    // 退役下来的面按尺寸回收:拖滑块时每帧一次重建绝不该 new 纹理
let lightOwner = null;                   // 上面那两堆面属于哪个上下文
// 金字塔整条只留一份(它是脚手架,换一次键就整条重写),所以「里面现在装的是哪张图的哪个朝向」
// 只需要一个槽:烘这一趟吃的东西 == lightFieldKey 说的东西。
const lightField = { gl: null, key: '' };

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

// ---- 光向:一枚四元数出全部 ----
// 光的向量只有一个来源 —— 姿态四元数把 +X 送到哪儿 (js/direction.js 的基:x、z 铺在画布平面上,
// y 抬离画布朝镜头,+Y 就是画布正面)。绑了 Direction 就用它自己的四元数在 local 系里自转半圈
// (箭头读作**光行进方向**,光源在箭头反侧 ⇒ 光向量 = 箭头取负:方位 +180°、仰角变号),没绑就把
// Angle/Elev 两颗旋钮折成同一枚 (qFromEuler),于是两条路共用一次 qApply,不再各写一遍三角式。
// 落进 shader 的基与 fxglDirUV 同规矩 (uv 的 y 朝上):v = (f.x, -f.z, f.y)。
// 实测它与老写法在同一条地面上等价 (gl-probe/light_vec_gl.mjs:八个方位量到的来向与旋钮面值差 ≤1.2°,
// roll 不动这束光),差别全在仰角的定义域:老写法先钳进 [0,90] 再取 sin/cos,方向被压到画布平面之下时
// 拍平成贴着地面那一根;四元数照原样把灯放到平面下,漫反射随之压暗,而影子那一侧由 fxglLight 那道闸
// 明说「埋在地里,谁也没被挡」(高度场里「高」= 朝镜头,一条往下走的光线一步都迈不出去)。
// 记录悬空 = 退回旋钮值,不让一个删掉的 attribute 把灯灭掉。
// 绑定生效时 Angle/Elev 两行整个不出现 (params 的 when),要改方向去 Direction 工具。
function fxLightPose(effect, p) {
    const ref = effect && effect.params && effect.params.dirRef;
    const r = attrRecord(ref);
    if (r && r.type === 'direction' && r.desc && r.desc.rotation) {
        // 箭头读作**光行进方向**, 光源在箭头反侧 —— 真反演: 光向量 = 箭头向量取负, 即方位 +180°
        // **且仰角变号**。只翻方位、不翻仰角的旧读法在"箭头扎向画布"这一档是错的: 箭头指向 -Y
        // (扎进画布正面) 时灯明明在正面 +Y 迎面照, 仰角不翻就把灯算到了画布背后, 漫反射全黑
        // (用户实测)。四元数在 local 系里自转半圈 (+X → -X), 光向量与读数同源同翻。
        const eu = geoEuler(r.desc.rotation);
        const q = qMul(r.desc.rotation, qFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI));
        const out = { q, angle: dirWrap360(eu.yaw + 180),
            elev: Math.max(-90, Math.min(90, -eu.pitch)), bound: true };
        console.log('[dirLight] follow ref:', ref, 'yaw->angle:', out.angle.toFixed(2),
            'pitch->elev:', (-eu.pitch).toFixed(2), '->', out.elev.toFixed(2));
        return out;
    }
    console.log('[dirLight] no follow — ref:', ref, 'record:', r ? r.type + '/desc?' : 'null (fallback to manual knobs)');
    const src = p || (effect && effect.params) || {};
    const angle = +src.angle || 0, elev = +src.elev || 0;
    return { q: qFromEuler(angle, elev, 0), angle, elev, bound: false };
}
// 光向量:四元数唯一的产物。uL (两处)、迈步方向、仰角抽头全部由它出,所以「画面亮在哪一面」和
// 「影子拖向哪一边」不可能两说。
function fxLightVec(effect, p) {
    const f = qApply(fxLightPose(effect, p).q, { x: 1, y: 0, z: 0 });
    return { x: f.x, y: -f.z, z: f.y };
}
// 绑定那枚还在就由它出读数 (Elev 现在可以是负的:灯在画布平面之下),否则交回手动旋钮。
// 面板读数与缓存戳只认这一份,`bound` 为假时说「这两颗旋钮就是画面用的那一份」。
function fxLightDir(effect) {
    const s = fxLightPose(effect, null);
    return s.bound ? { angle: s.angle, elev: s.elev } : null;
}

// 高度场由什么决定:两张图的像素身份(深度图供高度、法线图供那道朝向门)、深度铺在谁身上
// (Align + 盒子)、该层网格大小、以及**中心光线**的方向 —— 门是按 dot(N,L) 开的,Angle/Elev/Near/
// Green 任一个动了,筛出来的「这一片里最高的受光面」就换一批。图层自己的墨**不在里面**。
// 方向键读的是**解析后**的角:转一下绑定的 Direction,姿态值换、键跟着换,金字塔当场重烘。
function lightFieldKey(effect, l, p) {
    const align = p.align === 'Canvas' ? 'C' : 'L';
    const d = fxLightPose(effect, p);
    return `${fxMapIdentity(effect, 'depth')}+${fxMapIdentity(effect, 'map')}`
        + `|${align}|${align === 'C' ? fxMapBoxStamp(l) : '-'}`
        + `|${fxgl.w}x${fxgl.h}|${d.angle}|${d.elev}|${p.near}|${p.green}`;
}

// mask 由高度场 + 迈步那几颗决定:Scale 是把深度满幅换成世界距离的那把尺,Cast 是推进上限,
// Steps 是抽样预算,Size 是灯盘的角半径(扇里那 5 条光线的仰角跨度),Smooth 是块锯齿那道保边
// 平滑的半径闸。后四颗都不动金字塔,所以拖它们只重走线、不重烘场;而前两代实现里 Size 根本不在
// 键上 (它糊的是画面,每帧另跑两趟)。
function lightMaskKey(effect, l, p) {
    return lightFieldKey(effect, l, p)
        + `|${p.scale}|${p.cast}|${lightSteps(p)}|${Math.max(0, p.size)}|${Math.max(0, p.smooth) | 0}`;
}


// Steps 旋钮是**指数 n**,步数 = 2^n:迈步选级那道 ceil(log2(dt0·图高)) 本来就只认 2 的幂,
// 块宽只在 2 的幂上换挡,中间的档位只多花抽样、画面一模一样 —— 所以旋钮直接做成 n,滑一档 = 块宽减半。
// 顶档 2⁹ 把 dt0 正好压到金字塔的地板(lod ≥ 1 ⇒ 块 ≥ 2px),再高也不会有更细的块,所以收到 9 为止。
function lightSteps(p) {
    const n = Math.max(2, Math.min(9, p.steps | 0));
    return 1 << n;
}
// 旋钮读数显示 2ⁿ 而不是面值 —— 面值 65536 在一行里既宽又难对档,上标又不会读成「n 的 2 次方」。
const FX_LIGHT_SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const lightSup = n => String(n).split('').map(c => FX_LIGHT_SUP[+c]).join('');

// 深度图 + 法线图 → 高度场 (两个通道) + max 金字塔。返回 false = 这一趟烘不出东西(贴图解析不出像素)。
// 同一个键连着跑就是空转:金字塔整条只留一份,所以「装的是哪一场」用一个槽说得完 —— 拖 Scale/Cast/
// Steps/Size 那几颗时键不动,烘这一趟一步都不走,只有走线那趟在跑。
function lightBakeField(gl, p, effect, l, fk) {
    if (lightField.gl === gl && lightField.key === fk) return true;
    const img = fxMapImage(fxMapRef(effect, 'depth'));
    if (!img) return false;
    const n = nativeSize(img);
    const fr = fxMapFrame(p.align, l);
    const v = fxLightVec(effect, p);
    lightBindLevel(0);
    fxglRunPass({ fb: lightPyr.fb }, fxgl.progs.lightBake, pr => {
        fxglBindTex(pr, 'uDepth', fxgl.texMap2, 0);
        // 朝向门读的是**本层网格**上的法线图 (与漫反射那一趟同一个 vUV,不吃 Align);那束光就是
        // fxglLight 用的同一条 fxLightVec,所以「门开在哪个朝向上」和「画面亮在哪一面」不可能两说。
        fxglBindTex(pr, 'uNormal', fxgl.texMap, 1);
        gl.uniform3f(fxglU(pr, 'uL'), v.x, v.y, v.z);
        gl.uniform1f(fxglU(pr, 'uGreen'), p.green === 'down' ? -1 : 1);
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
    lightField.gl = gl; lightField.key = fk;
    return true;
}

// 走线出一张带半影的 mask。命中缓存就直接回那张面,一个抽样都不花。
function lightShadowMask(gl, p, effect, l) {
    // 换上下文 = 缓存里那些句柄全废了(旧面上的纹理在新上下文不存在),整堆直接丢掉:不删(删不掉)、
    // 也不查(查了就是把废句柄绑进新上下文)。金字塔自己认得出换了脸,见 lightPyrInit。
    if (lightOwner !== gl) {
        lightOwner = gl; lightMasks.clear(); lightFree.length = 0;
        lightField.gl = null; lightField.key = '';
    }
    if (!lightPyrInit(gl, fxgl.w, fxgl.h)) return null;
    const key = lightMaskKey(effect, l, p);
    const hit = lightMasks.get(key);
    if (hit) { lightMasks.delete(key); lightMasks.set(key, hit); return hit.tex; }
    if (!lightBakeField(gl, p, effect, l, lightFieldKey(effect, l, p))) return null;
    const ent = lightTakeTarget(gl, fxgl.w, fxgl.h);
    if (!ent.ok) { lightRetire(gl, ent); return null; }
    const V = fxLightVec(effect, p);
    // 迈步方向 = 光向在画布平面上的投影 (x 乘宽高比换成「图高」单位,与 fxglDirUV 同一条 y 朝上的基)。
    // 它与老写法 cos/sin 那条差一个正因子 cos(elev),归一化后同一条 —— 换掉三角式不是为了这里,
    // 是为了仰角不再被钳在 [0,90]:见 fxLightPose。
    const dx = V.x * (fxgl.w / Math.max(fxgl.h, 1)), dy = V.y;
    const dl = Math.hypot(dx, dy) || 1;
    const scale = Math.max(p.scale, 1) / 100;
    // 仰角从同一条向量读回来:水平投影的长就是 cos(elev),所以 atan2(z, 水平) 与旋钮那颗面值同源。
    const elev0 = Math.atan2(V.z, Math.hypot(V.x, V.y)) * 180 / Math.PI;
    // 灯盘的角半径 = Size(°),σ 取它的半 ⇒ 抽头正好铺在 Elev ± Size 上。仰角钳在 [0,90]:那两条
    // 越过界的(夜侧 / 正上方)并到同一根光线上,权重相加、总和仍是 1,所以钳位不用重新归一。
    // 中心仰角为负的那一路走不到这儿 —— 灯在平面之下无从迈步,fxglLight 那道闸把它整条影子收掉了。
    const sigma = Math.max(0, p.size) / 2;
    for (let i = 0; i < FX_LIGHT_TAPS.length; i++) {
        const e = Math.min(90, Math.max(0, elev0 + FX_LIGHT_TAPS[i][0] * sigma)) * Math.PI / 180;
        // 横向走一个图高抬 tan(Elev) 个「世界距离」,而一个满幅深度 = scale 个图高 ⇒ 除回来。
        lightSlopeK[i] = Math.tan(e) / scale;
    }
    fxglRunPass(ent, fxgl.progs.lightShadow, pr => {
        fxglBindTex(pr, 'uH', lightPyr.tex, 0);
        // 脚下的局部坡也从法线图来 (半影的宽窄由它说),所以这张键里必须有它的身份 —— 见 lightFieldKey。
        fxglBindTex(pr, 'uNormal', fxgl.texMap, 1);
        gl.uniform2f(fxglU(pr, 'uDir'), dx / dl, dy / dl);
        gl.uniform1f(fxglU(pr, 'uAspect'), fxgl.w / Math.max(fxgl.h, 1));
        gl.uniform1f(fxglU(pr, 'uGreen'), p.green === 'down' ? -1 : 1);
        gl.uniform1f(fxglU(pr, 'uInvScale'), 1 / scale);
        gl.uniform1f(fxglU(pr, 'uPxH'), fxgl.h);
        gl.uniform1f(fxglU(pr, 'uMax'), p.cast / Math.max(fxgl.h, 1));
        gl.uniform1i(fxglU(pr, 'uLevels'), lightPyr.levels);
        gl.uniform1i(fxglU(pr, 'uSteps'), lightSteps(p));
        gl.uniform1fv(fxglU(pr, 'uSlopeK'), lightSlopeK);
        gl.uniform1fv(fxglU(pr, 'uWK'), lightWK);
    });

    // 缓存里存的是平滑后的那张:走线的原始产出是中间脚手架,用完已退还回收池(见 lightSmoothMask)。
    const fin = lightSmoothMask(gl, p, effect, l, ent);
    lightMasks.set(key, fin);
    for (const k of lightMasks.keys()) {
        if (lightMasks.size <= FX_LIGHT_CACHE_MAX) break;
        lightRetire(gl, lightMasks.get(k));
        lightMasks.delete(k);
    }
    return fin.tex;
}

// 平滑半径 = Smooth 旋钮的面值(像素),0..FX_LIGHT_SMOOTH_MAX,0 = 整道不跑。半径不再与走线的
// 块宽耦合 —— 块量化与走线噪声的尺度用户看不见,「块宽 × 百分比」的自动换算反而不可预期
// (Steps 2⁷+ 时块宽塌到 4..2px,同样 100% 的手感完全不同);直接给像素,对着画面拧。
function lightSmoothRadius(p) {
    return Math.min(FX_LIGHT_SMOOTH_MAX, Math.max(0, Math.round(p.smooth)));
}

// 走线出来的 mask 过一遍引导保边平滑:横一趟 src→mid、竖一趟 mid→out,src 与 mid 用完即退还回收池
// (拖滑块每帧重建,一个纹理都不该 new)。半径不足 1 像素 = Smooth 关到底,mask 原样出门,一道都不跑。
function lightSmoothMask(gl, p, effect, l, src) {
    const r = lightSmoothRadius(p);
    if (r < 1) return src;
    const mid = lightTakeTarget(gl, fxgl.w, fxgl.h);
    const out = lightTakeTarget(gl, fxgl.w, fxgl.h);
    if (!mid.ok || !out.ok) { lightRetire(gl, mid); lightRetire(gl, out); return src; }
    // 深度门的容差:底线 6 个量化级 + 随半径的斜率项。底线必须盖住**深度纹理自己的噪声**——真实
    // 深度图带纹理,相邻像素差好几个量化级,旧底线 (2 级) 在小半径 (Steps 2⁶ 起,半径 = 块宽 16→2px、
    // σD 压到 2..6 级) 时比噪声还窄:抽头几乎全被拒,平滑退化成身份,甚至以随深度噪声起伏的变权核
    // 把噪声结构注回 mask —— 实测有噪深度下 2⁸ 平滑后影边粗糙度是不平滑的 3.5 倍。斜率项照旧:核越
    // 大,同一斜面上攒出的深度差越多。真几何边 (几十级的跳变) 依旧远超容差,该拒的照拒。
    const sigmaD = (6 + 0.3 * r) / 255;
    const fr = fxMapFrame(p.align, l);
    const passes = [
        [mid, src, 1 / Math.max(fxgl.w, 1), 0],
        [out, mid, 0, 1 / Math.max(fxgl.h, 1)],
    ];
    for (const [dst, srct, sx, sy] of passes) {
        fxglRunPass(dst, fxgl.progs.lightSmooth, pr => {
            fxglBindTex(pr, 'uMask', srct.tex, 0);
            fxglBindTex(pr, 'uDepth', fxgl.texMap2, 1);
            fxglBindTex(pr, 'uNormal', fxgl.texMap, 2);
            gl.uniform2f(fxglU(pr, 'uMapU'), fr.u[0], fr.u[1]);
            gl.uniform2f(fxglU(pr, 'uMapV'), fr.v[0], fr.v[1]);
            gl.uniform2f(fxglU(pr, 'uMapB'), fr.b[0], fr.b[1]);
            gl.uniform2f(fxglU(pr, 'uStep'), sx, sy);
            gl.uniform1f(fxglU(pr, 'uRadius'), r);
            gl.uniform1f(fxglU(pr, 'uSigmaD'), sigmaD);
            gl.uniform1f(fxglU(pr, 'uGreen'), p.green === 'down' ? -1 : 1);
        });
    }
    lightRetire(gl, src);
    lightRetire(gl, mid);
    return out;
}

function fxglLight(col, p, effect, l) {
    const gl = fxgl.gl;
    const V = fxLightVec(effect, p);
    const rgb = fxHexToRgb01(p.color);
    const tint = fxHexToRgb01(p.tint);
    // 副槽就绪(引擎按 needsMap2When 决定它有没有像素)且强度 > 0 才走线,否则连步都不迈。
    const march = fxgl.hasMap2 === 1 && p.shadow > 0;
    // 影子开着一张图都没来 = 光照照旧、阴影没有。这一下必须写在链上,不许看着像「阴影怎么没生效」。
    if (p.shadow > 0 && !march) fxgl.skip = 'Lighting: no depth map for shadows';
    // 两种姿态下这条线根本不该迈,各自说一句写在链上:
    //   · 灯压在画布平面之下 (只有绑定的 Direction 出得来,旋钮的 Elev 定义域是 [0,90])。这张高度场里
    //     「高」= 朝镜头那侧,所以往平面下走的光线一步就埋在地里:谁也没被它照亮,也就没有东西挡得住它。
    //     画面该暗 = 漫反射跟着 uL.z<0 自己暗下去 (实测环均值 145→132),而不是再拿 Tint 乘一遍黑 (那会
    //     掉到 20 上下)。老写法先把仰角钳进 [0,90] 再取 sin/cos,这一档被拍平成贴地的掠射,于是在整个
    //     覆盖区里量出一条 59px 偏移、重心 8621 的影 (gl-probe/light_vec_gl.mjs 的 before 那一列;那一趟
    //     还叠着「绑定方位反 180°」那条旧错,所以它落在 270.7° 上)。
    //   · 灯正对画面 (Elev=90,旋钮顶格)。方位在这条姿态下不存在,水平投影 (V.x, V.y) 是零向量,归一化
    //     它 = 说一个不存在的方向,迈下去也只是原地问自己脚下那一块。实测这一档两种写法**画面无差别**
    //     (圆丘 Cast 60/1024、棋盘高度场三趟环均值都 217,与 89° 同亮),所以这道闸买的不是像素,是省下
    //     一条根本不存在的迈步,加上把「为什么没有影子」说一句,别看着像 Shadow 那颗钮没对上。
    const noCast = V.z < -1e-6 ? 'below' : (Math.hypot(V.x, V.y) < 1e-4 ? 'head-on' : '');
    let mask = march && !noCast ? lightShadowMask(gl, p, effect, l) : null;
    if (march && noCast) {
        fxgl.skip = noCast === 'below'
            ? 'Lighting: light below the plane, nothing casts a shadow'
            : 'Lighting: light along the canvas normal, no direction to march';
    }
    // 该走的线走了却烘不出面(金字塔建不起来 / 深度图读不出像素 / framebuffer 不完整)= 一样要说,
    // 不许让「有图但没影」看着像「影子的强度没对上」。
    else if (march && !mask) fxgl.skip = 'Lighting: shadow mask could not be built';
    const dst = fxgl.off[1 - col.slot];
    fxglRunPass(dst, fxgl.progs.light, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uMap', fxgl.texMap, 1);
        // 没有 mask 就不绑它:uShadow 已经归 0,那一支不会进采样器。绑一张没分配过层级的纹理会让整次
        // drawArrays 报 INVALID_OPERATION,那才是「整条链不出图」而不是「没影子」。
        if (mask) fxglBindTex(pr, 'uShadowMask', mask, 2);
        // 光向 = 姿态四元数把 +X 送到的地方,基与法线图一致 (fxLightVec:画布角 0° 右、90° 下,uv 的 y
        // 取负;z 朝屏幕外,z<0 即灯在平面之下)。烘场那趟的朝向门吃的是同一条向量。
        gl.uniform3f(fxglU(pr, 'uL'), V.x, V.y, V.z);
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
    desc: 'Relights the layer through a bound tangent-space normal map — a diffuse term around the light direction plus an optional specular highlight, both taking the light’s own colour. Bind a depth map and the same light is rebuilt into a shadow mask: the map becomes a height field, a ray runs from each pixel toward the light at tan(Elev), and whatever stands higher than that ray cuts the light off, so the shadow stretches Δh·Scale/tan(Elev) out of the occluder instead of stopping at a fixed pixel length. Only a face that looks toward the light is allowed to occlude, and the height field is a per-channel maximum so that gate survives every mip level. The penumbra is geometry, not a blur: Size is the light’s angular radius in degrees, so the march is a fan of five rays spanning Elev ± Size with Gaussian weights — the shadow is hard where it leaves the occluder and the band widens the further it runs, roughly 4·Length·tan(Size) at Elev=45°; the tilt read from the normal map stretches or shrinks that band on slopes. Size=0 collapses the fan to one ray = a hard-edged shadow, and it never smears the shadow back onto the occluder’s own lit face. The height field is a nearest-sampled max pyramid, so the raw mask carries square stair-steps at the block period; after the march a depth-and-normal-guided bilateral smoothing (separable, horizontal then vertical) averages it only across taps that share the surface — a tap is rejected when its normal folds away from the centre pixel’s, or when its depth jumps past a tolerance that grows with the radius — so contact edges and the occluder’s lit face survive untouched. Smooth is that guiding blur’s radius in pixels (0 skips the pass); the gates keep real edges crisp at any radius. Scale says how much distance the map’s whole depth range is worth, in image heights — it is the one knob that makes the length mean anything. Align says whether the depth map is measured against the whole canvas or against this layer alone (the normal map always lies on this layer). Cast only caps how far the ray may travel. Steps is an exponent — the march takes 2^Steps equal hops — because the height field’s block size only changes at powers of two, intermediate counts buy nothing but redundant samples; 2^9 tops out at the pyramid’s 2px block floor. Shadow=0 means no ray is marched at all. Colour only: the maps never show through, nothing moves, alpha untouched.',
    params: [
        { key: 'map', kind: 'map', def: null },
        // Direction attribute 的引用 (fxDirModal 全项目检索后选一枚 guid)。只存一句引用,不存角度
        // —— 与贴图槽同一条规矩;悬空 (那枚被删了) 就回退手动旋钮值。
        { key: 'dirRef', label: 'Direction', kind: 'dir', def: null },
        // 绑定生效时这两颗旋钮整个不出现 —— 方向归 Direction attribute 管,面板里留着只会两说。
        { key: 'angle', label: 'Angle', min: 0, max: 359, step: 1, def: 135, unit: '°', when: p => !p.dirRef },
        { key: 'elev', label: 'Elev', min: 0, max: 90, step: 1, def: 45, unit: '°', when: p => !p.dirRef },
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
        { key: 'near', label: 'Near', kind: 'enum', options: ['bright', 'dark'], def: 'bright', when: p => p.shadow > 0 },
        // Scale = 整张图的深度满幅值多少个图高。没有它,「影长」这件事在单位上就没有定义
        // (满幅深度与像素之间没有任何东西把它们连起来)。
        { key: 'scale', label: 'Scale', min: 10, max: 400, step: 1, def: 100, unit: '%', when: p => p.shadow > 0 },
        // 半影 = 灯盘的大小,不是画面糊半径:它是光源的**角半径**(度),走线因此在 Elev ± Size 之间
        // 铺开一扇光线。单位是角度所以与影长无关 —— 影子越长带越宽,这是几何本来的样子。
        { key: 'size', label: 'Size', min: 0, max: 30, step: 0.5, def: 3, unit: '°', when: p => p.shadow > 0 },
        // 块锯齿的保边平滑:半径直接以像素计 (0 = 整道不跑)。旧记录存的是「块宽 × 百分比」,那套
        // 换算用户看不见也不可预期,换成面对面的像素钮 —— 见 lightSmoothRadius。
        { key: 'smooth', label: 'Smooth', min: 0, max: 32, step: 1, def: 16, unit: 'px', when: p => p.shadow > 0 },
        { key: 'cast', label: 'Cast', min: 16, max: 1024, step: 8, def: 1024, unit: 'px', when: p => p.shadow > 0 },
        // 指数 n,步数 = 2^n(块宽只在 2 的幂上换挡,见 lightSteps):滑一档 = 步数与块宽同时减半;
        // 顶档 2⁹ = 块宽地板。读数走 fmt 显示成 2ⁿ —— 面板默认的「值+unit」只能出 7² 这种反着读的样子。
        { key: 'steps', label: 'Steps', min: 2, max: 9, step: 1, def: 4, fmt: n => `2${lightSup(n)}`, when: p => p.shadow > 0 },
        { key: 'green', label: 'Green', kind: 'enum', options: ['up', 'down'], def: 'up' },
    ],
    // 参数换形状:旧存档里 Cast 是「走线总长(1..64px)」,和它现在的意思(推进上限)没有忠实换算,
    // 所以旧值不继承,读回新默认 = 让几何自己决定影长。
    //
    // 闸口认「这条记录长没长成现在这个样子」,不认「cast 字段在不在」:effectParams 每读一次参数就
    // 跑一次 migrate (undo 快照、缓存判定、面板重绘全都算),所以无条件改写等于把这颗钮钉死在 1024 ——
    // 真机量过:Cast 拧 16/30/64/1024 四档,烘出来的 mask 缓存键全是 |1024|,影子一律 60px。
    // scale 是这次才有的字段,它在了就说明这条记录是在新语义下写下的,用户拧的那一档得留下。
    //
    // 半影那颗不改写:旧字段 Soft 是**像素**半径,新字段 Size 是光源的**角半径**(度),同一个数在
    // 两条影子上带宽都不一样,没有忠实换算可言。effectParams 只按注册表的那批 key 抄参数,所以旧
    // 记录里的 soft 在读回来的那一刻就没了 —— 不写一行迁移代码,也不留一个死字段。
    migrate(raw, out) {
        if (raw.scale === undefined) out.cast = 1024;
        // Steps 换成指数 n 那一代的换算:smooth 是同一代才有的字段,它不在 = 旧线性记录(4..128),
        // 按「最近的 2 的幂」折成 n。指数时代的记录(必然带 smooth,n 本来就是面值)原样留下 ——
        // effectParams 每次读参数都跑 migrate,无条件改写等于把旋钮钉死。
        if (raw.steps !== undefined && raw.smooth === undefined) {
            out.steps = Math.round(Math.log2(Math.max(4, Math.min(128, raw.steps | 0))));
        }
        // Smooth 换成像素半径那一代:旧值是「块宽 × 百分比」的百分数 (0..100)。>32 的必是旧值,
        // 按「占满档 32px 的比例」折算;≤32 的两代同形,原样当像素用 (旧档的低百分比会比以前强一点,
        // 对着画面拧回来)。
        if (raw.smooth > 32) out.smooth = Math.min(32, Math.round(raw.smooth * 32 / 100));
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
        lightSmooth: FX_FS_LIGHT_SMOOTH,
    },
    run: fxglLight,
    // 链外状态 (fx/core.js 的 fxExternalStamp):光向跟着绑定的 Direction attribute 走,转姿态不改
    // params —— 把解析出的两个角报进缓存身份,转一下 3D 小窗里的姿态,这条链当场重算。
    stamp(effect, l) {
        const d = fxLightDir(effect);
        return d ? `dir:${d.angle.toFixed(2)},${d.elev.toFixed(2)}` : '';
    },
    readout(p, n, effect) {
        const d = fxLightDir(effect);
        // 跟随时报解析出的角并标出来源 (⤳),手动时是旋钮自己的值 —— 读数永远说画面真用的那一份。
        const ae = d || p;
        const mark = d ? '\u2933' : '';
        const base = `${fxMapShort(effect)}  ${n(ae.angle)}°${mark}  ${n(ae.elev)}°${mark}  ${n(p.intensity)}%  s${n(p.spec)}`;
        // 阴影开着却读不出影子 = 深度图没绑,把那张图的名字写出来 = 可见文本,不许静默降级。
        // 两头缺的各说各的名字 (fxMapShort 按槽的角色报 no normal / no depth),不会混成一句。
        if (p.shadow <= 0) return base;
        const depth = fxMapShort(effect, 'depth');
        // 烘影子的几何三件都要报:满幅标定、灯盘的角半径、深度铺在谁身上;极性拧反整张 mask 就落在错
        // 的一侧, 而画面看起来「有影子」,所以那一个词也得写在行上 (与景深同词 inv)。
        return `${base}  sh${n(p.shadow)}  ${depth}`
            + `  ${n(p.scale)}%  ${n(p.size)}°  sm${n(p.smooth)}  ${p.align === 'Local' ? 'local' : 'canvas'}`
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
