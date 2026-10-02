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
//   天光与命中吃同一把 Fade 尺,但它恒在**射程尽头**那一档:什么都没照见 = 这一条 ray 走满了射程。
//   (按「ray 实际走到的最远处」折会让未命中区按各自放弃的原因分层,颜色不统一,2026-10-02 点名要撤;
//    当天在无穷远、恒不吃 Fade 是另一头:Fade 拧到底压不住那一片。)
//   取样 = 命中点那个像素自己 (透明处没有东西可照,按它自己的 alpha 加权),出口只写 RGB ——
//   反射不重塑形状,alpha 是这个像素自己的 (契约 ②)。挡住 ray 的那一处还得真的高过浮雕底端那一截
//   (Solid):底端只是深度范围走到头,顺着它采远处那一圈像素 = 一条顺反射方向的拖影,不算照见了东西。
//   磨完以后的那一道穿越还要过 Steep 这一刀:那一段里地形抬起得比这颗旋钮还陡 ⇒ 它踩的是**前面那个
//   东西的轮廓** (深度图上的断面),不是 ray 落上去的表面 —— 照见一条轮廓线就是把同一个源像素顺反射方向
//   复制成一条拖影 (用户 2026-10-02 点名的竖条纹)。轮廓不是表面 ⇒ 那一条 ray 判天光。
//   Jitter 用确定性整数 hash 抖起步相位,Seed 换花样。
// ⑤ 边 = 水线自己:每一格都算得出「这一格的镜面比该处地形高靠近读者多少」(露/埋的余量 margin),
//   Edge 那条线就压在余量过零的那一圈上,尺是**深度差** (Depth Diff 那颗旋钮),并且**只量水盖住地面
//   的那一侧** (margin > 0 = 那一处的水有多深, 折成灰阶不到这么多就算边);margin < 0 是原图冒出水面,
//   不算岸、一格不画。坡陡的地方线窄、坡缓的地方线宽,换分辨率时像素数跟着走、
//   **世界宽度**才是不变的那一个 (判据 16)。Noise 逐格抖的是那条阈值。整面镜埋着或整面镜罩着时
//   余量在画面里不过零 ⇒ 一条边都不画。**不是任何深度断面都算岸**:看本格与上下左右那一圈的**二阶差分**
//   (xp+xm-2m、yp+ym-2m) —— 地形连续爬过水面时它只是深度图自己的量化噪声,两片面皮叠在一起 (近的东西
//   挡着远的地面) 时它等于那一跳的高度。超过 5 个灰阶 (满浮雕的 2%) 就是断面,不画 —— 于是水面只在
//   地形真爬过它的那一圈上出线,不会顺着一张轮廓描一圈。二阶差分只量本格这一圈,所以它与粗细那颗旋钮
//   无关。另一道闸在**本格自己的交点**上:投到照片以外的那一格没有地形可绕 (ssrTerrainAt 在那里补的
//   是 -Relief = 一片没有东西),那一处的余量过零不算接触,一格不画 (掠成地平线的那一行由 valid 挡)。
//   Edge Smooth 那颗旋钮把交线和阈值都改量在
//   十字平均过的场上 (半径 = 层像素, 默认 1 = 不平滑、也不多采一次), 因为 8 位深度图自己就是台阶状的,
//   未平滑的场一格一抖 ⇒ 带这里宽那儿窄;二阶差分那两刀仍看原场, 免得半径一大把断面也抹平。Distance
//   Rate 那颗旋钮管远处:阈值按本格地形沉在浮雕范围里的位置从 1 插到给定系数 (100% = 远近同一把尺)。
//   整条边还按**尽头档**吃 Fade, 与天光那一支同一句读法 (这条线不是 ray 带回来的内容, 所以不吃逐格的
//   行进距离):Fade 拧到底时这一趟除了折射底什么都不写, 岸线跟着一起收。不接这一刀的毛病是实测的形状 ——
//   边此前是这一趟里唯一不淡的东西, Fade=100% 时未命中区 `ssrSky(base)=base` 整片交回原图, 远处却还
//   描着一条发光轮廓, 底下一滴水都没有。Preview 那一支读的是同一个 e, 所以摆位时拧 Fade 也会把水线带走
//   (要看线就把 Fade 回 0);不为它开特例, 一条规则管所有出口。另一颗 Fade Multiplier 也接在这条线上,
//   但它不是等比缩: 它按本格的水深逐格缩这条线 (见 ⑨ 末尾), 两颗一个管远近、一个管浅深。
// ⑥ 波动 = 那面镜子不再是平镜:镜面上叠两阶正弦 (频率比 1 : 2.3, 沿这张照片自己的两个切向铺开),
//   自变量是**本格与镜面的交点**, 所以波纹躺在镜面上、随镜子的朝向走。波长以画布高为单位 (一个画布高
//   = 2hd 世界) ⇒ 换分辨率时两道波是同一个物理尺寸, 只有像素数跟着变。Wave 那颗旋钮说的是法线**最多
//   歪出去几度**:两阶的振幅各取其频率的倒数, 于是各自贡献同样大的坡度 tan(Wave)/√2, 合成正好不超过
//   tan(Wave) —— 最大倾角与波长无关 (波长只管两道波多宽, 不管水多陡)。波场不只歪法线, 它把**镜面本身**
//   抬起/压下: 平的交点 P 顺着视线 D 推到起伏面上那一点 (一阶: 位移 = 该处波高 h ÷ (D·N), 沿 N 的量
//   正好是 h), 于是露/埋那份余量、水线、Edge、折射用的水深全都跟着波纹摇 —— 水线是镜面与地形的接触,
//   镜子自己抖了, 接触线不可能不动 (2026-10-02 点名要这一条, 前一版把 Edge 钉在平镜上已撤)。Steep 仍
//   量地形自己的坡度, 与波场无关。整条 fx 链没有任何时间源, 所以
//   Phase 是把波场沿自己滑一格的唯一入口; 要动就得手动拧它。
// ⑦ 折射 = 水面下的东西是**透过**水看到的:把本格周围的内容顺着歪掉的水面横向挪一点再采。挪多少 =
//   **只打一次折**:水深先过一把 saturating 的尺 (到 Relief 的四分之一就拧满) 再乘波动给出来的那一份倾斜,
//   最后乘 Refract; 露出多少 (混合权重) 另走一把更紧的尺 (一格水就全露), 不乘 Refract、也不乘那份
//   depth —— 两条都乘 depth 是上一版的病灶, 看得见的挪动 ∝ depth², 浅水实测 0.00 格 (用户 2026-10-02:
//   "目前折射的效果太弱了")。投回画面片只有落在
//   画布平面里的那一段看得见 (指向读者的分量在照片里没有面积)。干的 (margin ≤ 0) 一格不弯。这一格的水深读的是**抖过的镜面** (⑥ 把 P 推上起伏面), 所以浅水带自己会随波纹往前后挪。压在反射**底下** (先折后反), Mix/Fade 照旧只管盖在上面的那一份反射。它吃的是波动的倾斜, 所以
//   Wave=0 时无从折射 —— 一颗平镜不弯任何东西 (那颗旋钮也就跟着藏起来)。
//   代价: 波动 0 次额外取样 (全解析式), 但每算一次余量多两个 cos (波高), 每格再有两个 (斜率) —— Edge 开着
//   那一圈邻格各问一遍, 峰值 ≈ 每格 24 个 cos; 折射每湿格 +1 次 uTex 取样 (≈ 全帧 22 取的 +4.5%)。
// ⑧ Smooth (半径, 层像素) = 糊的是**采回来的内容**, 不是这一格自己: 凡是从这张照片里取样的地方
//   (反射落点、折射挪过去的那一处) 都改量在中心 + 四个斜角 (每枚离中心正好 sm 格) 的五次取样平均上,
//   RGBA 一起糊 (折射那一份的权重读的就是平均过的 alpha)。本格自己的像素走 texelFetch, 永远不糊 ——
//   糊原图就等于糊这张照片的形状。半径 0 = 缩成一次取样, 与从前逐位同 (判据 30 同一把闸)。
//   反射那一份的半径 = Smooth 打底、按 ray 行进距离加 Reflection Blur (⑧'');折射那一份的水底另按
//   这一格的水深加 Refract Blur (⑧') —— 水线处锐、带宽处糊满,**只糊水下, 不糊倒影** (用户 2026-10-03)。
//   与 Edge 那颗 Edge Smooth 分开: 那一颗平均的是**深度场** (管水线落在哪儿、带多宽), 这一颗平均的是
//   **颜色** (管照见的东西有多柔)。代价: 每一处取样 +4 次 (满反射 + 满折射那一格 2 → 10 次 uTex 取样)。
// ⑨ Fade Multiplier = 液面与物体的交接不再是一刀: 水线往水里那一圈 (与 Edge 的 Depth Diff 同一条带) 里,
//   整份反射 —— ray 采到的内容 *和* 什么都没照见时那一片天光 —— 按这一格的水深线性淡回本格自己的像素
//   (淡到底 = 原图 / 折射那一底)。尺就是那条带, 但不吃 Noise 的逐格抖动、也不吃 Distance Rate, 免得淡的
//   边界自己再抖一遍。0 = 现行为 (那句 mix 的 t=0 在 fp32 里精确回 1.0 ⇒ 出口逐位同, 判据 30 同一把闸)。
//   代价: 0 次额外取样, 每格一个除法。**那条边读的是同一个 shore** (ssrEdge 末尾乘的那一句与这里同一式子,
//   连 ms 都是同一格) ⇒ 水线那一处线与反射一起归零, 往水里一起长回来; 与 Fade 那一刀分工: 那一颗给整条线
//   乘同一个数 (等比淡), 这一颗按本格水深铺开 (内缘先没)。真图实测 (判据 38 + F:\Harness\kolid-comfy\gl-probe\ssr_edge_real.mjs):
//   缩比逐格铺在 0..1、带均值 0.928 → 0.692 (50%) → 0.455 (100%)、64 格整格没了、155 格一寸没动 (深水)。
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
uniform vec3 uT1;        // 镜面上两个正交切向 (世界, 单位): 波动沿它们铺, 折射顺它们挪
uniform vec3 uT2;
uniform float uWaveTan;  // tan(Wave) = 波场的坡度上限 (法线最多歪出去这么多); 0 = 平镜
uniform float uWaveLen;  // 一阶波长 (世界单位); 二阶 = 它 / 2.3
uniform float uWavePhase;// 波场相位 (弧度), 把整张波沿自己滑一格
uniform float uRefract;  // 折射强度 0..1 (只管挪多少; 露出多少另有一把尺)
uniform float uSmooth;   // ⑧ 取样点的模糊半径 (层像素); 0 = 原样一次取样
uniform float uCastBlur; // 反射命中的距离模糊半径上限 (层像素): 按 ray 行进距离占射程的比例爬到这里
uniform float uRefractBlur;// 只糊折射水底的模糊半径上限 (层像素): 沿 Depth Diff 那把尺随水深爬到这里; 倒影的距离模糊走 uCastBlur
uniform float uRelief;   // 深度满幅 (世界单位)
uniform float uEps;      // 八位深度的量化容差 (世界单位) = Relief × 2/255
uniform float uMinH;     // 一次穿越要算数,那儿的地形至少要高到这里 (世界 Y)
uniform float uSlopeMax; // 一次穿越要算数,地形沿 ray 最多抬起这么多 (无量纲坡度 = 世界Y/世界水平长)
uniform float uStepW;    // 反射 ray 每步的世界长度
uniform int uSteps;
uniform float uJitter;   // 0..1: 起步相位抖多少步
uniform int uSeed;
uniform float uMix;
uniform float uFade;
uniform float uFadeMul;  // ⑨ 浅水那一圈把整份反射淡回原图的比例 0..1 (尺 = uEdgeDiff 那一条带)
uniform float uNearBright;
uniform float uPreview;  // 预览: 镜面露着的区域画白
uniform vec3 uSky;       // 反射 ray 照到天空时的天光色
uniform float uEdge;       // 水线那条边:强度 0..1
uniform float uEdgeDiff;   // 边的尺 = 深度差: 地面离该处水面差这么多**灰阶**以内都算边 (不拿像素当尺)
uniform float uEdgeSm;     // 场平滑半径 (层像素): 交线与阈值都量在半径这么大的十字平均过的场上
uniform float uEdgeRate;   // 远端的 depth diff 系数 (1 = 与近端同; 按本格地形沉在浮雕范围里的位置插值)
uniform float uEdgeNoise;  // 那条阈值逐格抖多少比例 0..1
uniform float uEdgeJump; // 岸的判刀: 本格这一圈里余量场的二阶差分超过这么多 = 断面, 不是岸 (= 深度图 5 个灰阶)
uniform vec3 uEdgeColor;
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
// ⑥ 波场:沿镜面自己的两个正交切向铺的两阶正弦 (频率比 1 : 2.3)。自变量是**本格与平镜的交点**,所以
// 波纹躺在镜面上、随镜子的朝向走;波长以画布高为单位 ⇒ 换分辨率时两道波是同一个物理尺寸。
// 两阶各自的原函数与导函数共用这一对余弦。
vec2 ssrWaveCos(vec3 P) {
    float g1 = 6.28318531 / uWaveLen;
    vec2 ab = vec2(dot(P - uA, uT1), dot(P - uA, uT2));
    return vec2(cos(g1 * ab.x + uWavePhase), cos(g1 * 2.3 * ab.y + uWavePhase * 0.73));
}
// 坡度 (无量纲, 上限 = tan(Wave)):一阶振幅取 A = tan(Wave)/(√2·g1) (乘上 g1 以后代码里剩 tan/√2),
// 二阶振幅 A/2.3 配 2.3 倍频率 ⇒ 两阶各自的最大坡度同为 tan(Wave)/√2, 合成正好 ≤ tan(Wave)。于是 Wave
// 就是一颗**角度**:换波长只换两道波多宽, 不改它们多陡。解析式, 一格图不多采。
vec2 ssrWaveSlope(vec3 P) { return (uWaveTan / 1.41421356) * ssrWaveCos(P); }
// 镜面在该处沿法线抬起/压下多少 (世界单位):每阶振幅 = 那一阶的坡度 ÷ 它的频率, 所以波长拧长, 同一颗
// Wave 角度下的鼓包又宽又高 (位移跟着波长涨, 坡度不变)。
float ssrWaveHeight(vec3 P) {
    float g1 = 6.28318531 / uWaveLen;
    vec2 c = ssrWaveCos(P);
    return (uWaveTan / 1.41421356) * (c.x / g1 + c.y / (g1 * 2.3));
}
// 一格相对那面镜子的状态,一次算全 (步 0..3):视线方向 D、镜面交点 P、露/埋的余量 margin。margin 三处读:
// 水线 (ssrEdge)、本格的水深 (折射的尺, ⑦)、以及「埋没埋」这一关。
// 收成一个函数是因为边要把「交线另一侧」按任意 uv 再问一遍 (ssrEdge)。valid = 这条视线根本够不着
// 镜子 (交点跑到眼睛背后 = 透视下掠着镜面的那一片),那一格就是照片本身,谈不上反射。
float ssrMargin(vec2 uv, out vec3 P, out vec3 D, out bool valid) {
    vec2 xz = uO + uBx * uv.x + uBy * uv.y;
    // ① 相机 = 这张照片自己的相机:像平面落点 W (世界, Y=0) 与眼睛 (0, 1/uK, 0) 连线;uK=0 就是正着
    //   往下看 (这层纸),所以视线逐像素变 ⇒ 反射会收敛、水线会弯。
    vec3 W = vec3(xz.x, 0.0, xz.y);
    D = normalize(vec3(uK * W.x, -1.0, uK * W.z));
    // ③ 镜面求交。uN.y ≥ 0.15 由引擎保证 ⇒ dot(uN,D) 一般为负, 每条视线与镜面各交一次。
    P = W + D * (dot(uN, uA - W) / dot(uN, D));
    valid = !(uK > 0.0 && P.y * uK >= 1.0);
    // ⑥ 镜子不再是平的一张纸: 平的交点沿视线推到起伏面上那一点。位移沿 D, 它在 N 上的分量正好是
    //   该处的波高 h ⇒ 余量、水线、Edge、水深都跟着波纹摇。Wave=0 整句跳过, 0 档与平镜逐位同。
    if (uWaveTan > 0.0) P += D * (ssrWaveHeight(P) / dot(uN, D));
    // 地形比镜面更靠近读者 ⇒ 镜子被埋。容差让「贴着水面摆」算露着:水面自己的深度值折出来与镜面
    // 等高,不容差的话整片水都成了冒出来的地形,反射会采到水面/水下内容。
    return P.y - ssrTerrainAt(P.xz);
}
// 一次穿越挡不挡这条 ray。两刀, 步进与二分共用同一句 (否则二分收敛到的是另一种边界):
//   ① 沉到地形以下 = 被挡;  ② Solid: 那儿的地形至少要高过浮雕底端这么一截 (底端只是深度范围走到头)。
// 第三刀 Steep 不在这儿 —— 它量的不是「这一格挡不挡」,而是「磨完以后的那一道穿越算不算表面」,
// 所以它走在二分之后 (见 main)。放在步进里会被步长钝掉:一步 42 格,满浮雕的一跳摊到这一整步只剩
// 6 灰阶/格, 断面与缓坡在这个分辨率下根本分不开 (实测默认档整步进那一刀一次都不响, 条纹只消 17%)。
bool ssrBlock(vec3 Q, float terr) {
    return Q.y <= terr - uEps && terr >= uMinH - uEps;
}
// 天光那一支吃 Fade, 但**不吃逐格的行进距离**: 「什么都没照见」就是这一条 ray 走满了射程 ⇒ 恒按尽头
// 那一档打折, 未命中区是一整片同一个颜色。
// 曾经按「ray 实际走到的最远处」折 (2026-10-02 上一版), 实测不成立: 同一句"没有反射"在三处放弃 (走满射程 /
// 出画被截断 / 被 Steep 判成轮廓) 各自带着自己的距离进场, 于是未命中区自己分层 —— 他那张 618×692 上
// fade=40 时 224 036 个未命中格的浓度从 0.600 一路铺到 1.000 (跨度 = 整把 Fade 尺), 其中 21 624 格几乎
// 满浓度, 且这一簇随 Steep 单调长大 (steep 0/50/90 → 21 251/21 624/22 497): 断面那一圈被改判成未命中的
// 格子拿的是**墙根那一个小距离**, 所以它比别处浓 (= 比 Sky 还 Sky), 用户点名「steep 导致的未命中颜色和
// 别的未命中不一样」。再往回退到天在无穷远 (恒不吃 Fade) 是另一头: Fade 拧到底压不住那一片。
vec3 ssrSky(vec3 own) {
    return mix(own, uSky, uMix * (1.0 - uFade));
}
// 被波动歪过的镜面法线 (歪掉的只有**反射方向**那一条 ray;露/埋那份余量走的是 ssrMargin 里的位移)。
// Wave=0 时**原样回 uN, 连 normalize 都不走**:归一化在 fp32 里就能差出 1 ulp,
// 反射方向跟着抖, 步进/二分的边界就会翻格 —— 0 档必须与平镜逐格相同 (判据 30)。
vec3 ssrWaveNormal(vec3 P) {
    if (uWaveTan <= 0.0) return uN;
    vec2 sl = ssrWaveSlope(P);
    return normalize(uN + uT1 * sl.x + uT2 * sl.y);
}
// ⑧ Smooth (半径, 层像素): 凡是从这张照片里**采回来的内容**先糊一糊再用 —— 反射落点那一格、折射挪过去
//   的那一格都算。中心 + 四个斜角 (每枚离中心正好 r 格) 五次取样的平均, RGBA 四个通道一起糊 (边的
//   权重读的就是那一份 alpha)。半径 0 = 原样一次取样 ⇒ 与从前逐位同 (判据 30 钉的就是这一条)。
//   本格自己的像素走的是 texelFetch, 不在这儿:糊的是「照见的内容」, 不是这张照片本身。
//   反射那一份吃**均匀**的 Smooth;折射那一份另加水深坡 (ssrBlurPx) —— 见 ⑧'。
vec4 ssrFetch(vec2 s, float r) {
    if (r <= 0.0) return texture(uTex, s);
    vec2 o = r / vec2(textureSize(uTex, 0)) * 0.70710678;
    return (texture(uTex, s) + texture(uTex, s + vec2(o.x, o.y)) + texture(uTex, s + vec2(-o.x, o.y))
        + texture(uTex, s + vec2(o.x, -o.y)) + texture(uTex, s + vec2(-o.x, -o.y))) * 0.2;
}
// ⑧' Refract Blur = **只糊水下那一层** (⑦ 折射采回来的水底): 半径沿 Depth Diff 那把尺按这一格的水深爬
// —— 水线处 0 (贴岸的水底是锐的), 到带宽处爬满。反射的倒影**不**吃这一刀 (它吃 ⑧'' 的距离模糊),
// 用户 2026-10-03 点名: "只模糊水下的部分, 不模糊反射的部分"。两个旋钮都归零时半径精确为 0 ⇒
// 单次取样, 出口与从前逐位同 (判据 30)。
float ssrBlurPx(float margin) {
    return uSmooth + uRefractBlur * clamp(margin * 255.0 / (uEdgeDiff * uRelief), 0.0, 1.0);
}
// ⑦ 折射底:水下那一格透过起伏的水面看到的画面。**两把 saturating 的尺**,各量各的 (用户 2026-10-02:
// "目前折射的效果太弱了" —— 原来那份偏移和露出量都乘同一个 dep, 看得见的挪动 ∝ dep², 浅水实测 0.00 格):
//   bend = 水深 / (0.25 × Relief) —— 管**挪多少**, 水深到 Relief 的四分之一就拧满, 再深的地方不再多挪
//     (挪得多不代表看得清: 同一条倾斜在浅水里也该有可见的量, 线性 depth 会把浅水整个压成 0);
//   wet  = 水深 / (0.02 × Relief) —— 管**露出多少** (混合权重), 一格水就全露, 因此不再乘 uRefract,
//     强度只从上面那条偏移里进来 ⇒ 一处打折, 不会二次衰减也不会重影。
// 挪 = uRefract × bend × Relief × 那份倾斜, 化到画面片的 uv (只有 XZ 分量在照片里有面积);
// 源格透明就没有内容可折; 挪出这张照片的那一格原样交回 —— 屏幕空间只能折得到画面里有的东西。
// Wave=0 时倾斜恒为 0 ⇒ 一寸都不挪, 于是这一支整条早退 (那颗旋钮也跟着藏起来)。
vec3 ssrRefract(vec3 own, vec2 uv, vec3 P, float margin) {
    if (uRefract <= 0.0 || uWaveTan <= 0.0) return own;
    float bend = clamp(margin / (uRelief * 0.25), 0.0, 1.0);
    float wet = clamp(margin / (uRelief * 0.02), 0.0, 1.0);
    vec2 sl = ssrWaveSlope(P);
    vec2 su = uv + uInv * (uRefract * bend * uRelief * (sl.x * uT1.xz + sl.y * uT2.xz));
    if (!ssrOn(su)) return own;
    vec4 rb = ssrFetch(su, ssrBlurPx(margin));
    return mix(own, rb.rgb, wet * rb.a);
}
// 水线 = 这一格的镜面高度与该处地形高之差 (margin) 走到 0 的那一条线 —— 不是画的线,是求交的结果。
// 尺是**深度差** (Depth Diff 那颗旋钮, 单位 = 深度图灰阶 = 1/255 个浮雕范围), 而且**只往水那一侧量**:
// margin > 0 = 镜面在地形前面 = 水盖着地面, 那一带是「水有多深」; margin < 0 = 地面冒出水面 (干的),
// 一格不画 (用户 2026-10-02 点名: "我希望是水面覆盖的地方才算, 也就是水面的深度减去原图的深度")。
// 原来那把「几层像素」的尺被用户否掉了 ("目前 edge 是噪声, 我希望 edge 不那么噪声,
// 就靠 depth diff 来生成边缘") —— 固定几格的带绑在交线的**逐格位置**上, 而交线在 8 位深度上一格一抖,
// 于是带这里断一处那儿断一处 = 看着像噪声。换成深度阈值以后, 带连着铺在「地面确实接近水面」的那一片上,
// 抖一格不会断开; 代价是粗细随坡度走 (陡=窄、缓=宽), 而且换分辨率时像素数跟着变, 不变的是世界宽度。
// 第二代价 (这一侧才有的): 带只从水线往水里数, 内缘是硬的一刀, 逐格量化抖动会让那条内缘在 1 格里
// 前后进退, 而外缘 (lim 那一关) 有 smoothstep 兜着, 不抖。
// Noise 抖的就是那条阈值 (整数 hash,吃 Seed)。
// 梯度不拿 dFdx/dFdy 量:那是「同一个 2×2 quad 以内」的差分,深度断面正好压在 quad 边界上时整条水线
// 会隐身 (实测: 岛从 112..132 挪到 111..131, 画出的脚线就从下侧 [132,133] 换到上侧 [110,111], 另一侧
// 一格不画)。改成自己现量中心差分: 上下左右各问一次场 (本格那份主流程已算好 = 免费), 与栅格奇偶无关。
// 但「余量反号」不等于水线。反号只说明镜面板从两格之间**穿过去**,而穿过的可以是**空档**:照片里近的东西
// 挡着远的地面,深度图上就留下一道断面 —— 断面一侧地形高过镜面 (干), 一侧低过 (= 远处本来有水), 余号
// 照样反 ⇒ 于是把前景物体的整条轮廓描了一圈 (用户实测: 右侧人/物体轮廓长出边, 而他脚下是干的)。
// 水线要的是**水绕在物体上那一圈**: 物体站在这片水里, 水面在它身上爬到哪儿, 线就画到哪儿。量出来的分别
// (诊断 F:\Harness\kolid-comfy\gl-probe\ssr_step_diag.mjs, 用户那张 618×692 深度图, 镜面板降到穿过物体
// 脚下): 岸 = 地面**连续地**爬过镜面, 干那一侧高出水面只有满浮雕的 0.5~1.5% (495 格全在这一段, 尾巴到
// 2%); 断面 = 两片面皮叠在一起, 高出 2~15% (110 格, 全落在物体轮廓那几列)。
// 判刀用**余量场的二阶差分** (xp+xm-2m 与 yp+ym-2m): 连续爬升的岸它≈深度图自己的量化噪声 (一两阶),
// 一步跳变的断面它=那一跳的高度 (几十阶)。取 5 个灰阶 (= 量化容差 uEps 的 2.5 倍) 为刀口。为什么不用
// 「干那一侧高出多少」直接量: 那要拿邻格比, 而邻格离交线多远跟着 Width 那颗旋钮走, 粗边会把远处正常
// 的干地也当成断面 (实测 Width=8 时 9.6 行的带被削成 5 行)。二阶差分只看本格这一圈, 与粗细无关。
// Edge Smooth (半径, 层像素): 交线位置和阈值都改量在**十字平均过的场**上 (中心 + 半径 sm 的上下左右 5 格)。
// 8 位深度图本身就是台阶状的, 未平滑的场一格一抖 ⇒ 带这里宽那儿窄; 半径主要治的是那把**逐格梯度尺**
// ((Xp-Xm)/2sm 比相邻两格之差稳得多)。**半径 1 = 不平滑**: 直接取本格原值, 与 Depth Diff 那一版逐位同
// (默认档是用户点过头的, 不许被平均连带改掉), 平均从 2 起生效。**二阶差分那两刀永远看半径 1 的原场**:
// 半径一大, 断面那一跳也被均摊掉、掉到刀口以下, 真岸和假边会一起漏过来。断面本身也不会被平滑"洗白":
// 岛那种一跳 = 满浮雕的 40~100%, 摊到十字平均里剩下的 |ms| 远在阈值之外。
// Distance Rate (远端系数): 越远的地面该离水面多近才算边。本格地形在浮雕范围里的位置
// t = (margin - P.y)/uRelief = -地形高/uRelief ∈ [0,1] (0 = 画布平面那端 = 最近, 1 = 浮雕底 = 最远),
// 阈值乘 mix(1, rate, t) —— 与 Near 极性无关, 且不额外采一次图。rate=1 (100%) 时与现在完全一致。
// 最后一道闸: **本格的水面交点必须落在照片里**。P 投到画面片以外时 ssrTerrainAt 补的是 -Relief
// (= 那里根本没有地形), 于是余量在「镜面高度 = 那个补出来的假地面」那一行过零 —— 一行谁都没碰着的
// 空档。实测 (F:\Harness\kolid-comfy\gl-probe\ssr_flip_diag.mjs, 平坦 depth-half + 透视 90°):
// 第 120 列浮雕 1.4 时该处过零在第 74 行 (手算 coverRow=74.6), 真接触在 88.4 行; 第 20 列浮雕 1.0
// 时在 80 行 (该列的覆盖边界), 而这一行的 |ms|=0.027 < 1.5dd ⇒ 外推那道闸本来就被跳过。判据 18/20/22
// 量的就是这一处: 镜照出这张照片以外不是「水到了头」。
float ssrEdge(float margin, vec3 Pc, vec2 uv, ivec2 tc) {
    if (uEdge <= 0.0) return 0.0;
    if (!ssrOn(ssrSheet(Pc.xz))) return 0.0;         // 本格的水面得压在照片里那份真深度上
    vec2 px = 1.0 / vec2(textureSize(uTex, 0));          // 一个层像素的 uv 长 (= 粗细的尺)
    vec3 Q, D; bool v;
    float xp = ssrMargin(uv + vec2(px.x, 0.0), Q, D, v);
    float xm = ssrMargin(uv - vec2(px.x, 0.0), Q, D, v);
    float yp = ssrMargin(uv + vec2(0.0, px.y), Q, D, v);
    float ym = ssrMargin(uv - vec2(0.0, px.y), Q, D, v);
    if (abs(xp + xm - 2.0 * margin) > uEdgeJump) return 0.0;
    if (abs(yp + ym - 2.0 * margin) > uEdgeJump) return 0.0;
    float sm = max(1.0, uEdgeSm);
    vec2 g = 0.5 * vec2(xp - xm, yp - ym);               // 半径 1: 与 Depth Diff 那一版逐位同
    float ms = margin;                                   //   (值、梯度都不平均 = 不平滑)
    if (sm > 1.0) {
        // 半径 sm 的十字 taps, 越界的贴到边上当自身 (不然边框那一圈会把「画面外补的 -Relief」当邻居,
        // 水线在画面边上凭空断掉 sm 格)。
        vec2 o = sm * px;
        float Xp = ssrMargin(clamp(uv + vec2(o.x, 0.0), 0.0, 1.0), Q, D, v);
        float Xm = ssrMargin(clamp(uv - vec2(o.x, 0.0), 0.0, 1.0), Q, D, v);
        float Yp = ssrMargin(clamp(uv + vec2(0.0, o.y), 0.0, 1.0), Q, D, v);
        float Ym = ssrMargin(clamp(uv - vec2(0.0, o.y), 0.0, 1.0), Q, D, v);
        // **只信不含断面那一根轴**:半径一大, 一次硬跳变会被平均拽进整圈邻域 —— 实测半径 8 时岛的两侧
        // 各冒出一列紧贴轮廓的假岸 (0.5*(Xp+Xm) 把岛那 40% 浮雕的一跳摊成 8% 的偏移, 正好落进 8 灰阶
        // 的带)。连续坡面在这一对里只给出弯曲累积量 (= 实测 0.021), 断面给出的是那一跳本身 (= 0.163),
        // 差一个量级 ⇒ 判据仍用岸的那把刀, 只是按半径放大 (跨 sm 格的连续坡度本来就该比跨 1 格的大)。
        float dx = 0.5 * (Xp + Xm) - margin;
        float dy = 0.5 * (Yp + Ym) - margin;
        float jw = uEdgeJump * sm;
        bool tx = abs(dx) <= jw, ty = abs(dy) <= jw;      // 这一根轴脚下是连续的, 可以按半径 sm 来平均
        ms = margin + ((tx ? dx : 0.0) + (ty ? dy : 0.0))
            / (1.0 + (tx ? 1.0 : 0.0) + (ty ? 1.0 : 0.0));
        // 梯度同一件事: 被丢的那一根轴退回半径 1 的本地差分 (那一格的两张邻格与本格同侧, 量的是真坡度)。
        // 丢了就写零是不行的: 岸线本来是横的, 它的梯度全在 y 那一个分量上, y 一被丢整条线当场消失
        // (实测半径 8 时岛所在的列水线整段断了)。
        g = vec2(tx ? (Xp - Xm) / (2.0 * sm) : 0.5 * (xp - xm),
                 ty ? (Yp - Ym) / (2.0 * sm) : 0.5 * (yp - ym));
    }
    // **只量水面盖住地面的那一侧**:ms = 镜面比该处地形靠近读者多少 = 那一处的水有多深。ms < 0 是原图
    // 从水里冒出来 (干的), 用户 2026-10-02 否掉了它:"我希望是水面覆盖的地方才算, 也就是水面的深度减去
    // 原图的深度; 目前不知道为什么还有原图减去水面的深度 (这种情况不应该出现 edge)"。旧写法拿 |ms| 当
    // 距离 ⇒ 带对称地压在分界两侧, 岸那一侧的干地也被描上。现在内缘正好停在水线上, 带只往水里伸。
    if (ms < 0.0) return 0.0;
    float gg = dot(g, g);
    if (gg <= 1e-14) return 0.0;
    float dd = sqrt(gg);                                   // 每格余量变多少 (世界 / 层像素)
    vec2 dEdge = ms / gg * g;                              // 从那条线走到本格:几格 × 往哪边 (带号, 格为单位)
    if (ms > 1.5 * dd) {
        // 走过分界再问一遍: 走的路程 = 到那条线的距离**再往外 1.3 格** (dEdge 是带号的, 所以倍率乘在
        // 它自己身上 = 沿同一方向外推; 只按 1.3 倍外推在平滑档上会连自己这一侧都没跨过去 —— 实测半径 8
        // 的坡岸线在 121 行断掉一格: ms 被坡面自己的弯曲挪过了零, 原场的零点还在它下面 1.2 格, 而
        // 1.3×|dEdge| 只有 0.9 格 ⇒ 采回来同号 ⇒ 判成「没有接触」)。贴着线不足 1.5 格的本格不必再问:
        // 方向本来就定不出来, 而它对「地面离水面多近」的回答就是它自己的余量, 阈值那一关说了算。
        vec3 Q2, D2; bool v5;
        float sa = ssrMargin(uv - dEdge * (1.0 + 1.3 * dd / ms) * px, Q2, D2, v5);
        if (!v5 || sa >= 0.0 || !ssrOn(ssrSheet(Q2.xz))) return 0.0;
    }
    // 边的尺 = **深度差**:本格的水有多深 (ms), 折成灰阶 = ms×255/uRelief, 阈值以内都算边。于是坡陡处
    // 线窄、坡缓处线宽, 而且不会因为逐格梯度抖一下就断成虚线 —— 拿像素当半宽的毛病正在这里:交线本身
    // 在 8 位深度上一格一抖, 固定几格的带就这儿断一处那儿断一处。阈值换算成像素数随分辨率走, 同一颗
    // 旋钮折出的**世界宽度**才是不变的那一个 (判据 16)。
    float t = clamp((ms - Pc.y) / uRelief, 0.0, 1.0);    // 本格地形沉在浮雕范围里的几成
    float lim = uEdgeDiff * uRelief * mix(1.0, uEdgeRate, t)
        * (1.0 + (ssrH(tc, 7) - 0.5) * 2.0 * uEdgeNoise) / 255.0;
    // 边也吃 Fade, 而且与天光**同一句读法**:这条线不是 ray 带回来的内容,所以它恒按尽头那一档打折
    // (1−uFade),不随本格水深走。不接这一刀的毛病是实测的:Fade 拧到底时整片未命中区 ssrSky 原样交回 base,
    // 这一趟什么都不写了,唯独那条岸线还按 Edge 原样画着 ⇒ 远处一圈发光轮廓,底下一滴水都没有。
    // uFade=0 时这里乘的是精确的 1.0 ⇒ 出口与从前逐位同 (判据 30 同一把闸)。
    // Fade Multiplier 那条带**也管这条线** (用户 2026-10-03: "fade 滑块那一条接上了, 但它没接 Fade
    // Multiplier 那条带"): 浅水那一圈的反射已经淡回本格原图, 线在那一圈里就不该照旧画满。尺与上面第 ⑨
    // 支同一句 (水深 ms 折进 uEdgeDiff 那一条带, 不吃 Noise 也不吃 Distance Rate), 读的都是这一格的 ms,
    // 所以线与反射的淡入淡出落在同一圈里 —— 水线那一处两者一起归零, 往水里一起长回来。uFadeMul=0 时
    // 那句 mix 的 t=0 ⇒ 精确乘 1.0 ⇒ 出口与从前逐位同 (判据 30 同一把闸, 判据 38 钉这一条)。
    float fm = mix(1.0, clamp(ms * 255.0 / (uEdgeDiff * uRelief), 0.0, 1.0), uFadeMul);
    return uEdge * (1.0 - uFade) * fm * (1.0 - smoothstep(lim - 0.5 * dd, lim + 0.5 * dd, ms));
}
void main() {
    ivec2 tc = ivec2(gl_FragCoord.xy);
    vec4 own = texelFetch(uTex, tc, 0);
    if (uMix <= 0.0) { Frag = own; return; }
    // margin 同时喂 ssrEdge:露/埋的分界就是水线,一份算式两处读。边只长在水那一侧,所以埋着 (干) 的那
    // 一分支通常 e=0,画面原样;只有 Edge Smooth 把交线挪过本格的少数格会在这儿上色 (那条线本来就该压在水线上)。
    vec3 P, D; bool valid;
    float margin = ssrMargin(vUV, P, D, valid);
    float e = ssrEdge(margin, P, vUV, tc);
    if (!valid) { Frag = own; return; }
    if (margin < -uEps) { Frag = vec4(mix(own.rgb, uEdgeColor, e), own.a); return; }
    if (uPreview > 0.5) { Frag = vec4(mix(vec3(1.0), uEdgeColor, e), own.a); return; }
    // ⑦ 先折后反: 这一格水面下的那一层先垫上去, 反射再盖在它上面 (ssrSky 与命中那两处都读 base)。
    // 两颗旋钮都关着时 base 就是 own.rgb, 出口与从前逐位同。
    vec3 base = ssrRefract(own.rgb, vUV, P, margin);
    // ⑨ Fade Multiplier = 浅水那一圈把**整份反射**淡回原图 (液面与物体的交接不再是一刀)。尺与 Edge 的
    // Depth Diff 同一把 (同一条带的宽度, 但不吃 Noise 的逐格抖动、也不吃 Distance Rate): margin 就是这一格
    // 的水深, 到 0 (水线) 时反射 = 0, 到带宽时 = 满。0 档那句 mix 的 t = 0 ⇒ shore 精确等于 1.0,
    // 出口与从前逐位同 (判据 30 同一把闸)。
    float shore = 1.0;
    if (uFadeMul > 0.0) {
        shore = mix(1.0, clamp(margin * 255.0 / (uEdgeDiff * uRelief), 0.0, 1.0), uFadeMul);
    }
    // ④ 镜面反射: 方向由 Plane attribute 的法线决定, Wave>0 时再让波场把它歪出去一点 (见 ⑥:
    // 歪的只有方向, 水线与余量不动)。往读者那一侧弹 = 照的是相机背后。
    float tMax = float(uSteps) * uStepW;   // 射程尽头 = Fade 的满刻度
    vec3 R = reflect(D, ssrWaveNormal(P));
    if (R.y >= 0.0) { Frag = vec4(mix(mix(base, ssrSky(base), shore), uEdgeColor, e), own.a); return; }
    float jit = (ssrH(tc, 0) - 0.5) * uJitter;
    float tLo = 0.0, tHi = -1.0;
    float rh = length(R.xz);            // ray 每前进 1 世界长度, 水平方向走 rh 世界长度
    float terrLo = P.y - margin;        // 镜面交点处那一份地形高 —— margin 就是它算出来的, 不必再采一次图
    float terrHi = terrLo;
    for (int k = 1; k <= 128; k++) {
        if (k > uSteps) break;
        float t = (float(k) + jit) * uStepW;
        vec3 Q = P + R * t;
        vec2 s = ssrSheet(Q.xz);
        if (!ssrOn(s)) break;                       // 走出画面 = 这条反射 ray 只剩天
        // 只沉到浮雕底那一档的东西不算「立在 ray 前面」(Solid:那是深度范围的尽头,顺着它采远处那一圈
        // 像素就是拖影)。不算就继续往前走, 走完只剩天。
        float terr = ssrTerrain(s);
        if (ssrBlock(Q, terr)) { tHi = t; terrHi = terr; break; }
        terrLo = terr;
        tLo = t;
    }
    if (tHi < 0.0) {
        // 未命中 = 这条反射 ray 一路照到的是天空。它为什么停的 (走满射程 / 半路出了这张照片) 不改颜色:
        // 什么都没带回 = 按射程尽头打折, 与别的未命中同一档。
        Frag = vec4(mix(mix(base, ssrSky(base), shore), uEdgeColor, e), own.a);
        return;
    }
    // 二分精修: 命中点定在「最后一个不算数」与「第一个算数」之间, 步进的台阶感从这里磨掉。判据与上面
    // 那一条同一句 (Solid 与高度两刀都在), 否则二分收敛到的是另一种边界。两头的地形高各留一份
    // (terrLo = 还露着的那头, terrHi = 已挡住的那头), 下面 Steep 那一刀就拿这一对来量。
    for (int r = 0; r < 4; r++) {
        float th = (tLo + tHi) * 0.5;
        vec3 Q = P + R * th;
        vec2 s = ssrSheet(Q.xz);
        if (!ssrOn(s)) break;
        float terr = ssrTerrain(s);
        if (ssrBlock(Q, terr)) { tHi = th; terrHi = terr; }
        else { tLo = th; terrLo = terr; }
    }
    // ④' Steep 那一刀量在**磨完之后的这一小段**上 (tHi - tLo = 一步的 1/16), 两个地形高都是上面现采
    //   的, 一格图不多取。断面在一格里跳几十上百灰阶 ⇒ 磨得越细, 这一段量出来的坡度越接近真值;
    //   连续缓坡的抬起量跟着 dt 一起缩小 ⇒ 磨多细都还是那个坡度。所以这一刀与 Steps/Reach 无关
    //   (rh = R 的水平投影长, 把弧长换成水平前进量)。量法见 F:\Harness\kolid-comfy\gl-probe\ssr_streak_diag.mjs
    //   —— 内容画成「每格 RGB = 自己的坐标」再解回取样点: 条纹格竖走一格取样点动 0.0 格、横走一格跳 3~12 格,
    //   命中点坡度中位 18.4 灰阶/格, 其余格只有 0.5 (用户 2026-10-02 点名的竖条纹)。超过这一刀 ⇒ 这一条 ray 撞到的是**轮廓**,不是表面,在它上面取样就是把同一个源格
    //   复制成拖影 ⇒ 判天光 (轮廓不是东西,后面是什么这张照片不知道)。
    //   动作曾试过「往前挪一步再取」(2026-10-02 拍板 2a),实测不成立: 断面条纹 1 306 → 73 (−94 %), 可挪完
    //   落进「远处/掠射」那一类, 那一类自己也是塌缩 644 → 987 ⇒ 条纹总数 1 741 → 1 905 (默认档) **不降反升**,
    //   他刷新后报「还是有伪影」。判天光 = 总数 → 692 (−60 %), 代价是命中少 3.8 % (轮廓处反射缺一个小口)。
    if (terrHi - terrLo > uSlopeMax * rh * (tHi - tLo)) {
        Frag = vec4(mix(mix(base, ssrSky(base), shore), uEdgeColor, e), own.a); return;
    }
    vec2 hs = ssrSheet((P + R * tHi).xz);
    if (!ssrOn(hs)) { Frag = vec4(mix(mix(base, ssrSky(base), shore), uEdgeColor, e), own.a); return; }
    // ⑧'' 反射那一份的距离模糊: 半径按 ray 行进距离占射程的比例从 Smooth 爬到 Smooth+Cast Blur ——
    //  打得近的东西锐, 打得远的糊 (行程满射程 = 糊满)。水下那层不归它管 (那是 ssrBlurPx 的 Refract Blur)。
    vec4 hit = ssrFetch(hs, uSmooth + uCastBlur * clamp(tHi / tMax, 0.0, 1.0));
    float w = shore * uMix * hit.a * (1.0 - uFade * clamp(tHi / tMax, 0.0, 1.0));
    Frag = vec4(mix(mix(base, hit.rgb, w), uEdgeColor, e), own.a);
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

// 镜面上那对正交切向 (⑥/⑦ 的坐标架): 把画面片的横边 (世界 XZ, Y=0) 投进镜面当第一个, 第二个与它正交、
// 也还在这面镜里 (cross 天然满足, 且 n ⟂ t1、两者都单位 ⇒ 不用再归一化)。波躺在镜面上、随镜子的朝向走,
// 而不是躺在画布上:换一枚 plane, 波纹的方向跟着换。pl.ny ≥ 0.15 由上面那道闸保证 ⇒ 水平方向不可能平行
// 于法线, 投影长度有下界, 这里除得动。
function fxSSRTangents(pl, sh) {
    const n = [pl.nx, pl.ny, pl.nz];
    const e = [sh.Bx[0], 0, sh.Bx[1]];
    const d = e[0] * n[0] + e[1] * n[1] + e[2] * n[2];
    const v = [e[0] - d * n[0], e[1] - d * n[1], e[2] - d * n[2]];
    const L = Math.hypot(v[0], v[1], v[2]);
    const t1 = [v[0] / L, v[1] / L, v[2] / L];
    return {
        t1,
        t2: [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]],
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
    // ⑥ 波动: Wave 那颗旋钮是法线的**最大倾角** (°), 着色器按斜率加在切向上所以送 tan 过去; 波长那颗
    // 与 Relief 同一把尺 (×H ⇒ 世界 = 它 × 2hd), 所以换分辨率时波纹是同一个物理尺寸、只有像素数在动。
    const wave = p.wave > 0 ? Math.tan(p.wave * Math.PI / 180) : 0;
    const tg = fxSSRTangents(pl, sh);
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
        // ⑥/⑦ 那对切向 + 波场的三个数。Wave=0 时 uWaveTan=0, 着色器三处 (交点位移、法线、折射) 都据此早退,
        // 于是这一趟与平镜逐位同 —— 切向照旧上传 (反正没人读), 少一个分支。
        gl.uniform3f(fxglU(pr, 'uT1'), tg.t1[0], tg.t1[1], tg.t1[2]);
        gl.uniform3f(fxglU(pr, 'uT2'), tg.t2[0], tg.t2[1], tg.t2[2]);
        gl.uniform1f(fxglU(pr, 'uWaveTan'), wave);
        gl.uniform1f(fxglU(pr, 'uWaveLen'), Math.max(0.005, p.waveLen) * 2 * sh.hd);
        gl.uniform1f(fxglU(pr, 'uWavePhase'), p.wavePhase * Math.PI / 180);
        gl.uniform1f(fxglU(pr, 'uRefract'), p.refract / 100);
        // ⑧ 模糊半径 (层像素): 0 = 着色器里那五次取样缩成一次。Cast Blur 加在反射命中上 (按行程),
        // Refract Blur 只加在折射水底上 (按水深)。
        gl.uniform1f(fxglU(pr, 'uSmooth'), Math.max(0, p.smooth || 0));
        gl.uniform1f(fxglU(pr, 'uCastBlur'), Math.max(0, p.reflectBlur || 0));
        gl.uniform1f(fxglU(pr, 'uRefractBlur'), Math.max(0, p.refractBlur || 0));
        gl.uniform1f(fxglU(pr, 'uRelief'), relief);
        gl.uniform1f(fxglU(pr, 'uEps'), relief * 2 / 255);
        // Solid 那一刀:浮雕底端往上这么一段算「深度范围的尽头」,不是场景里立着的东西。
        gl.uniform1f(fxglU(pr, 'uMinH'), -relief * (1 - p.solid / 100));
        // Steep 那一刀: 0 = 每一道穿越都算 (老行为); 拧大 = 只接受越来越缓的抬起。折成
        // 「地形每格抬起多少灰阶」的上限 T (50% = 8 灰阶/层像素), 再化成无量纲坡度: T 灰阶/格 ×
        // (浮雕世界深 / 255 灰阶) / 一个层像素的世界长。
        // 实测 (用户那张 618×692 深度图, F:\Harness\kolid-comfy\gl-probe\ssr_streak_diag.mjs): 老路
        // (steep=0) 有条纹格 1 741, 其中 75% (= 1 306) 踩在断面 (命中点 |∇d| ≥ 8 灰阶/格) 上; 90% 那一档
        // 把这一类压到 73 格 (−94%), 命中总数只少 0.1%。但**取样点往前挪一步**这个处置同时把它们送进了
        // 另一类塌缩 (掠射/远处, t ≥ 128 格: 644 → 987), 所以条纹格总数几乎没降 (1 741 → 1 827)。
        // 轮廓处「挪一步」还是「判天光」(2026-10-02 定: 判天光)。挪一步实测把断面条纹压到 73 格, 却把它们
        // 送进另一类塌缩 (掠射/远处, t ≥ 128 格: 644 → 987), 条纹总数 1 741 → 1 905 不降反升 —— 他刷新后
        // 就报了「还是有伪影」。判天光 50% 那一档 = 1 741 → 692 (−60%), 命中少 3.8%。
        const slope = p.steep > 0 ? 8 * (100 - p.steep) / p.steep : Infinity;
        gl.uniform1f(fxglU(pr, 'uSlopeMax'), isFinite(slope) ? slope * relief / (255 * sh.px) : 1e30);
        gl.uniform1f(fxglU(pr, 'uStepW'), (p.reach / steps) * sh.px);
        gl.uniform1i(fxglU(pr, 'uSteps'), steps);
        gl.uniform1f(fxglU(pr, 'uJitter'), p.jitter / 100);
        gl.uniform1i(fxglU(pr, 'uSeed'), p.seed | 0);
        gl.uniform1f(fxglU(pr, 'uMix'), p.mix / 100);
        gl.uniform1f(fxglU(pr, 'uFade'), p.fade / 100);
        gl.uniform1f(fxglU(pr, 'uFadeMul'), (p.fadeMul || 0) / 100);
        gl.uniform1f(fxglU(pr, 'uNearBright'), p.near === 'bright' ? 1 : 0);
        gl.uniform1f(fxglU(pr, 'uPreview'), p.preview ? 1 : 0);
        gl.uniform3f(fxglU(pr, 'uSky'), ...fxHexToRgb01(p.sky));
        // 边:尺 = 深度差灰阶;Edge Smooth = 场平滑半径 (层像素);Rate = 远端系数 (100% = 与近端同);
        // Noise = 那条阈值逐格抖的比例。
        gl.uniform1f(fxglU(pr, 'uEdge'), p.edge / 100);
        gl.uniform1f(fxglU(pr, 'uEdgeDiff'), Math.max(0.5, p.edgeDiff));
        gl.uniform1f(fxglU(pr, 'uEdgeSm'), Math.max(1, p.edgeSmooth));
        gl.uniform1f(fxglU(pr, 'uEdgeRate'), Math.max(0, p.edgeRate) / 100);
        gl.uniform1f(fxglU(pr, 'uEdgeNoise'), p.edgeNoise / 100);
        gl.uniform1f(fxglU(pr, 'uEdgeJump'), relief * 5.0 / 255.0);   // 岸的那一刀: 深度图 5 个灰阶
        gl.uniform3f(fxglU(pr, 'uEdgeColor'), ...fxHexToRgb01(p.edgeColor));
    });
    col.slot = 1 - col.slot;
}

// 参数按折叠组分块 (kind:'fold' 的行是组头,fx/ui.js 里收放):Surface = 深度浮雕与镜面这张"尺子",
// Ray March = 反射 ray 怎么找落点,Blend = 反射怎么落在图层上,Wave & Refraction = 摇镜子 + 折水下,
// Water Line = 岸线。组头只是 UI 结构,不进 params、不进存档。
const SSR_PARAMS = [
    // ---- Surface:浮雕与镜面 ----
    { key: 'foldSurface', kind: 'fold', label: 'Surface', open: true,
        tip: 'The depth relief and the mirror sheet every ray is measured against: bind the depth map, place a Plane attribute as the mirror, say which end of the map stands near and how deep the relief sinks.' },
    { key: 'map', kind: 'map', def: null },
    // 反射面 = 一枚 Plane attribute (fxDirModal 全项目检索后选一枚 guid, 面板只列 plane):它的法线
    // 就是镜子的朝向, 它在世界里的位置就是镜子的位置, 在 3D 小窗里拧。悬空整条跳过并说一句 ——
    // 不许静默拿平镜顶替。
    { key: 'planeRef', label: 'Surface', kind: 'dir', def: null, types: ['plane'] },
    // 预览: 镜面露在地形之上的那一片画白 (被埋掉的原样) —— 摆位/拧高度时对着它看水线。
    { key: 'preview', label: 'Preview', kind: 'flag', def: false,
        onText: 'Plane preview: ON', offText: 'Plane preview: OFF', when: p => p.planeRef },
    { key: 'near', label: 'Near', kind: 'enum', options: ['dark', 'bright'], def: 'bright',
        tip: 'Which end of the depth map stands closest to the reader \u2014 the relief every ray is tested against.' },
    { key: 'align', label: 'Align', kind: 'enum', options: ['Canvas', 'Local'], def: 'Canvas' },
    // 相机的视场:0 = 正交 (这层纸的感觉),视线不收敛;拧大 = 视线逐像素收,水线会弯、远处会压过来。
    { key: 'persp', label: 'Perspective', min: 0, max: 120, step: 1, def: 45, unit: '\u00b0',
        tip: 'Horizontal field of view of this photo\u2019s own camera \u2014 view rays converge, so the water line curves and distance compresses. 0 is flat paper (orthographic).' },
    { key: 'relief', label: 'Relief', min: 0.01, max: 4, step: 0.01, def: 0.5, unit: '\u00d7H',
        tip: 'How far the depth range sinks behind the picture plane, in canvas heights \u2014 the one ruler the terrain and the mirror share.' },
    // ---- Ray March:反射 ray 怎么找落点 ----
    { key: 'foldRay', kind: 'fold', label: 'Ray March', open: false,
        tip: 'How the reflected ray searches the relief: range, resolution, and the guards that keep the relief floor and silhouettes from reading as surfaces.' },
    { key: 'reach', label: 'Reach', min: 8, max: 2048, step: 1, def: 512, unit: 'px',
        tip: 'How far the reflected ray searches before giving up \u2014 nothing hit means nothing reflected. Read in this layer\u2019s pixels; converted to world length per step.' },
    { key: 'steps', label: 'Steps', min: 2, max: 128, step: 1, def: 12,
        tip: 'Ray-march quality plus 4 bisection refinements on every hit. Taps per pixel: Steps depth samples.' },
    // 一次穿越要算数,那儿的地形得真的高过浮雕底端这一段:底端只是深度范围的尽头,顺着它采远处那一圈
    // 像素就是拖影。0 = 每一道穿越都算 (老行为)。
    { key: 'solid', label: 'Solid', min: 0, max: 100, step: 1, def: 10, unit: '%',
        tip: 'How far above the bottom of the relief a crossing has to stand before it counts as something in front of the ray. The bottom end is only where the depth range stops \u2014 reflecting content from out there smears a long streak along the ray. 0 accepts every crossing.' },
    // 断面上的命中 = 照见前面那个东西的轮廓, 而不是 ray 落上去的表面: 同一个源格沿 ray 复制成一条
    // 拖影 (竖条纹)。抬得比这颗旋钮还陡的穿越不算照见了东西 ⇒ 那一条 ray 判天光。0 = 老行为, 每一道穿越都收。
    { key: 'steep', label: 'Steep', min: 0, max: 100, step: 1, def: 50, unit: '%',
        tip: 'How steep a climb in the relief a crossing may land on and still count as a surface. A step that steep is the silhouette of something standing in front, not ground the ray reaches, and sampling it copies one pixel along the ray into a streak \u2014 that ray reads sky instead. 0 accepts every crossing; 50 is a climb of 8 depth levels per layer pixel; higher rejects gentler slopes too.' },
    { key: 'jitter', label: 'Jitter', min: 0, max: 100, step: 1, def: 75, unit: '%',
        tip: 'Scatters each ray\u2019s start phase by up to one step \u2014 trades banding for grain. Deterministic per pixel; Seed picks the pattern.' },
    { key: 'seed', label: 'Seed', min: 0, max: 999, step: 1, def: 0 },
    // ⑧ 采回来的内容先糊一糊: 反射落点那一格与折射那一格各做五次取样的平均。0 = 单次取样 (逐位同从前)。
    { key: 'smooth', label: 'Smooth', min: 0, max: 8, step: 1, def: 0, unit: 'px',
        tip: 'Softens what the rays bring back rather than where they went: every pixel sampled out of this picture \u2014 the reflection\u2019s hit and the refracted waterbed \u2014 is averaged over a five-tap cross this wide (layer pixels, diagonals at the given radius), so a hard-mapped reflection reads as a sheen instead of a second copy of the photo. 0 samples once, exactly as before; the layer\u2019s own pixels are never blurred. Costs four extra taps per sample. This one is even everywhere \u2014 Reflection Blur tilts the reflection\u2019s copy by distance, Refract Blur tilts the waterbed by depth.' },
    // 反射命中的距离模糊: 半径按 ray 行进距离占射程 (Reach) 的比例从 Smooth 爬到这颗 —— 打得近的东西
    // 锐, 打得远的糊, 像距离雾。0 = 关 (逐位同从前)。
    { key: 'reflectBlur', label: 'Reflection Blur', min: 0, max: 16, step: 1, def: 0, unit: 'px',
        tip: 'Softens the reflection itself with distance: each hit is blurred by how far its ray travelled before landing \u2014 as a fraction of Reach \u2014 so what bounces back from nearby stays sharp while far reflections ease toward this radius, the way distance haze does. It rides on top of Smooth, which stays the even baseline. The underwater layer takes Refract Blur instead (that one needs Wave and Refract). 0 keeps every hit equally crisp.' },
    // ---- Blend:反射怎么落在图层上 ----
    { key: 'foldBlend', kind: 'fold', label: 'Blend', open: true,
        tip: 'How the reflection sits on this layer: strength, the sky colour nothing-hit rays fall back on, and the two fades \u2014 one by distance, one by water depth.' },
    { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, def: 100, unit: '%' },
    // 反射 ray 什么都没照见时回这份天光色; 它吃 Fade 的**满刻度** (与走满射程那一档同一浓度),
    // 所以整片未命中是一个颜色, Fade 拧到底 = 这一片整个交回原图。
    { key: 'sky', label: 'Sky', kind: 'color', def: '#aebfd0' },
    { key: 'fade', label: 'Fade', min: 0, max: 100, step: 1, def: 40, unit: '%',
        tip: 'Everything this pass writes comes dimmer the farther the ray went \u2014 tames the grazing smear a near-horizontal ray leaves on flat ground. A ray that brings nothing back pays the full-scale discount, so the whole non-hit area is one colour and a full Fade hands it back to the picture. The water line pays that same full-scale discount too: it is not something a ray brought back, so turning Fade up takes the shoreline outline with it instead of leaving it glowing over ground that no longer shows any reflection.' },
    // ⑨ 浅水那一圈把**整份**反射 (采到的内容 + 什么都没照见时的天光) 淡回原图。尺与 Edge 的 Depth Diff
    // 同一把 = 同一条带: 边画到哪儿, 反射就淡到哪儿, **而那条边自己也按同一句的 shore 缩** (用户
    // 2026-10-03: "fade 滑块那一条接上了, 但它没接 Fade Multiplier 那条带")。0 = 现行为 (水线那一刀照旧硬)。
    { key: 'fadeMul', label: 'Fade Multiplier', min: 0, max: 100, step: 1, def: 0, unit: '%',
        tip: 'Shallow water hands the picture back: within one Depth Diff band of the water line the whole reflection \u2014 what the ray brought back *and* the sky colour it falls back on when it brought nothing \u2014 fades toward this layer\u2019s own pixels, so the shore stops being a hard cut between mirror and photo. 100% fades completely at the line itself, 0 leaves the cut exactly as it was. Same ruler as Edge\u2019s Depth Diff (that knob\u2019s Noise and Distance Rate do not enter here), so the band the line draws and the band this fades are one and the same band \u2014 and the water line itself pays this ramp too: each of its pixels is weighted by its own water depth, weakest right at the line and growing back as the water deepens, so the outline recedes together with the reflection under it instead of standing at full strength over water that has already been handed back. Unlike Fade, which multiplies every pixel of the line by the same number, this one tilts it by depth.' },
    // 水深加权的模糊 = **只糊水下那一层**: ⑦ 折射采回来的水底在水线处保持锐利, 沿 Depth Diff 那把尺
    // 随水深爬到这颗半径;反射的倒影不碰 (那是 Smooth / Reflection Blur 的事)。只在折射真的开着时
    // 出现 (Wave>0 且 Refract>0, 否则画面里没有"水下"可糊)。0 = 关 (逐位同从前)。
    // 旧键名 depthBlur (只活了一天的首稿) 由 migrate 读回。
    { key: 'refractBlur', label: 'Refract Blur', min: 0, max: 16, step: 1, def: 0, unit: 'px',
        when: p => p.wave > 0 && p.refract > 0,
        tip: 'Blurs only what is seen *under* the surface: the refracted waterbed stays sharp at the water line and blurs toward this radius as the water gets deeper, ramping on the same Depth Diff ruler the Fade Multiplier uses, so the band where the shore hands the picture back is exactly the band where this frost comes in. Depth Diff is that shared ruler, so it stays visible while this is on even with Edge off. The reflection above the water is never touched \u2014 Smooth and Reflection Blur are its knobs. The layer\u2019s own pixels are never blurred either, and dry ground takes no blur. 0 keeps the waterbed as crisp as Refract shows it.' },
    // ---- Wave & Refraction:摇镜子 + 折水下 ----
    { key: 'foldWave', kind: 'fold', label: 'Wave & Refraction', open: false,
        tip: 'Ripple the mirror sheet itself \u2014 the shoreline rides the swell \u2014 and bend what lies under the water.' },
    // 波动 = 那面镜子不再是平镜: 镜面上两阶正弦 (频率比 1 : 2.3) 把镜面本身抬起/压下, Wave 说的就是坡
    // **最多有多陡** (一颗角度, 与波长无关: 波长只管两道波多宽多高)。水线、余量、Edge、水深量的都是这张
    // 抖过的镜子 ⇒ 岸线自己随波纹起伏; 反射方向另吃歪过去的法线。0 = 平镜,
    // 出口与从前逐位同 (判据 30)。
    { key: 'wave', label: 'Wave', min: 0, max: 30, step: 1, def: 0, unit: '\u00b0',
        tip: 'How steep the swell may get, in degrees. The mirror itself is lifted and pressed, so the shoreline ripples along with the wave, and the reflection stops being a perfect mirror: each pixel\u2019s ray leaves in a slightly different direction, so what shows in the water breaks up. It is an angle, so the Wavelength cannot make it steeper, only wider and higher. 0 keeps the sheet flat.' },
    { key: 'waveLen', label: 'Wavelength', min: 0.005, max: 2.0, step: 0.005, def: 0.05, unit: '\u00d7H', when: p => p.wave > 0,
        tip: 'How wide one swell is, in canvas heights \u2014 the same ruler Relief uses, so a bump keeps its physical size when you change resolution and only the pixel count moves. One canvas height is a long, low ground swell running across the whole picture; below about one layer pixel a wave cannot be drawn at all and only reads as grain. A second octave at 2.3 times the frequency rides on top of it; there is no knob for it.' },
    { key: 'wavePhase', label: 'Phase', min: 0, max: 360, step: 1, def: 0, unit: '\u00b0', when: p => p.wave > 0,
        tip: 'Slide the whole wave field along itself. Nothing in this chain has a clock, so the swell never moves on its own \u2014 this is the knob that picks which part of it the picture sits on.' },
    // 折射压在反射**底下**: 水下的内容顺倾斜的水面横向挪一点再采。偏移只打一次折: 水深过 bend 那把尺
    // (到 Relief 的四分之一就拧满), 混合权重过 wet 那把 (一格水就全露) —— 两条都乘水深的话可见挪动
    // ∝ 水深², 浅水实测 0.00 格。
    // 没有波动就没有倾斜 ⇒ 这颗只在 Wave>0 时出现 (用户点名的「折射也要参考水面波动」)。
    { key: 'refract', label: 'Refract', min: 0, max: 100, step: 1, def: 0, unit: '%', when: p => p.wave > 0,
        tip: 'What lies under the surface is seen through it: the waterbed is sampled sideways, by how far the swell leans at that pixel. The sideways bend saturates a quarter of the way down the relief, so shallow water leans visibly too instead of barely at all; only ground standing above the surface stays straight. It lies under the reflection, so Mix and Fade still weight what sits on top of it.' },
    // ---- Water Line:岸线 ----
    { key: 'foldEdge', kind: 'fold', label: 'Water Line', open: false,
        tip: 'The shoreline drawn where the mirror sheet meets the ground: its depth ruler, how it thins with distance, and how steady it sits.' },
    // 边 = 水线自己 (露/埋那份余量过零的地方),不是描边:整面埋着或整面露着时画面里没有交线,一条都不画。
    { key: 'edge', label: 'Edge', min: 0, max: 100, step: 1, def: 60, unit: '%',
        tip: 'Draw the water line itself \u2014 where the mirror meets the photo \u2014 in its own colour. 0 leaves the crossing to the reflection. Two fade knobs reach this line, from two directions: Fade multiplies every pixel of it by the same (1\u2212Fade), the way the sky colour does, so a full Fade leaves no glowing outline standing over water that has already been handed back; Fade Multiplier weights each of its pixels by that pixel\u2019s own water depth, so the outline thins first right at the line and only reaches full strength a Depth Diff band into the water.' },
    { key: 'edgeDiff', label: 'Depth Diff', min: 1, max: 64, step: 1, def: 8, unit: 'lvl', when: p => p.edge > 0 || p.refractBlur > 0,
        tip: 'How deep the water may be \u2014 in depth-map levels (1/255 of the relief) \u2014 and still count as the edge. Measured on the water side only: ground standing above the surface there is dry, not shore, so nothing is drawn. Steep ground gives a thin line, shallow ground a wide one. Measured in depth instead of pixels, so the line sits where the data puts it rather than breaking into dashes where the crossing jitters by one level. This is also the band Depth Blur\u2019s frost ramps over.' },
    { key: 'edgeRate', label: 'Distance Rate', min: 0, max: 400, step: 1, def: 100, unit: '%', when: p => p.edge > 0,
        tip: 'The same threshold out at the far end of the relief, as a fraction of the near one (100% = one ruler everywhere). Ground sits further down the scene the darker/paler it is on the depth map, so this says how close far-away ground must come to the water to still count as shore.' },
    { key: 'edgeSmooth', label: 'Edge Smooth', min: 1, max: 8, step: 1, def: 1, unit: 'px', when: p => p.edge > 0,
        tip: 'The edge\u2019s own smooth, and it averages the *depth field*: the water line and its threshold are read off that average. Smooth above blurs what the rays bring back, this one steadies where the line sits. An 8-bit map is staircased, so 1 leaves the band jittering one cell here and there. The cliff test still reads the raw field, so a wide radius cannot dissolve a real step.' },
    { key: 'edgeNoise', label: 'Noise', min: 0, max: 100, step: 1, def: 35, unit: '%', when: p => p.edge > 0,
        tip: 'Rags that threshold by up to this fraction of itself, per pixel \u2014 deterministic; Seed picks the pattern.' },
    { key: 'edgeColor', label: 'Edge Color', kind: 'color', def: '#dff0ff', when: p => p.edge > 0 },
];

defineEffect({
    type: 'ssr',
    label: 'Reflection',
    group: 'Reflect',
    icon: 'reflect',
    needsMap: 'Depth',
    desc: 'Screen-space reflections, measured on one ruler: the bound depth map is rebuilt as a relief laid on this layer\u2019s picture plane, its height measured along the view axis \u2014 the canvas plane is the end closest to the reader, and Relief says how far (in canvas heights) the whole depth range sinks behind it. A bound Plane attribute is the mirror sheet: its world position is a point of the mirror and its normal is the mirror\u2019s facing, neither converted through any pixel count. Per pixel this photo\u2019s own camera casts a view ray (Perspective = its horizontal field of view; 0 is flat paper, orthographic), the ray meets the mirror sheet, and wherever the sheet stands closer to the reader than the relief it is bare mirror \u2014 where the relief stands in front of it the sheet is buried and there is no mirror at all, so the water line is exactly the line where sheet and relief cross, and it curves by itself under perspective. Preview paints the exposed sheet white while you place it. The direction a reflection leaves in is the view ray reflected about the plane normal \u2014 a pure mirror while Wave is 0; a mirror within 45° of face-on bounces the ray back at the reader, which means it would show what is behind the camera, so it says so on the chain instead of filling the picture. Otherwise the ray marches into the scene, Steps steps of Reach/Steps layer pixels (converted to world length), testing the relief at each point projected back onto this layer: the first place the relief rises over the ray clips the reflection, refined by 4 bisections, and that pixel is what shows — a crossing only counts when the relief there stands at least Solid above the bottom of the relief range, since that bottom end is just where the depth data stops and reflecting out there smears a long streak along the ray, and when the relief does not climb under the ray more steeply than Steep allows, because a step that steep is the silhouette of something standing in front rather than a surface the ray reaches, and sampling it copies one pixel along the reflection into a streak. Ran out of Reach or left the picture = the ray found the sky = the Sky colour, which takes Mix and pays Fade at full scale whatever distance the ray gave up at, so the whole non-hit area is one colour. Reflections can only come from the layer\u2019s own pixels, weighted by the hit\u2019s own alpha; colour only \u2014 alpha is this pixel\u2019s own. Jitter scatters ray starts to break banding into grain (Seed picks the pattern), Fade dims distant hits, Mix sets the strength. Wave makes the mirror sheet itself wavy: two sine swells laid along this layer\u2019s own two tangents at a 1 : 2.3 frequency ratio, measured on the mirror rather than on the picture, so they ride the sheet wherever the Plane attribute points it. Wavelength is in canvas heights — the same ruler Relief uses — so a swell keeps its physical size when the resolution changes; Wave is the *angle* the swell may climb, which is why it stays the same strength whatever the Wavelength is; the Wavelength sets how wide and how high the bumps are, so a long swell moves the shoreline a long way. The whole exposed/buried margin is measured on that wavy sheet, so the water line and Edge ride the swell: where the wave lifts the mirror it laps further up the bank, where it drops it bares more ground, and the line that separates the two is the same line. There is no clock anywhere in this chain, so Phase (sliding the field along itself) is the only way to move a swell. Refract then bends what lies under the surface: that pixel\u2019s neighbourhood is sampled sideways by that same lean, on a depth ruler that saturates a quarter of the way down the relief, so shallow water bends visibly instead of barely — the water depth sets *how much of the lean* is used, not how faint the result is: a pixel with any water in it shows the bent content at full strength, dry ground shows none — and the bend lies *under* the reflection, so Mix and Fade keep weighing what sits on top of it. Cost: Wave adds no texture taps (the swell is analytic, two cosines each time the margin is asked, so Edge open means about twenty per pixel), Refract one sample per wet pixel. Smooth blurs what the rays bring back rather than where they go: every pixel taken out of this picture \u2014 the reflection\u2019s hit and the refracted waterbed \u2014 is averaged over a five-tap cross of that radius in layer pixels (the colour and its alpha together), so a hard-mapped reflection reads as a sheen instead of a second copy of the photo; the layer\u2019s own pixels are never touched, and 0 samples once, exactly as before. Cost: four extra taps per sample, ten uTex taps on a pixel that both reflects at full strength and refracts. Fade Multiplier softens where the mirror meets the photo: within one Depth Diff band of the water line the *whole* reflection \u2014 the colour the ray brought back and the sky it falls back on when it brought nothing \u2014 fades toward this pixel\u2019s own colour (and whatever refraction laid under it), so the shore is a gradient instead of a cut; 100% fades completely at the line, 0 leaves the cut as it was, and that band uses the same ruler as the edge without its Noise or Distance Rate. The water line itself pays that same per-pixel ramp — each of its pixels weighted by its own depth, weakest right at the crossing and growing back as the water deepens — so the outline recedes together with the reflection instead of standing at full strength over water that has already been handed back; Fade by contrast multiplies every pixel of the line by one number, so the two knobs split it distance against depth. Cost: no extra taps. Edge draws the water line itself: the line where the mirror sheet and the rebuilt relief cross. Its ruler is a *depth difference* counted on the water side only — Depth Diff says how deep the water may be (grey levels of the 8-bit map, 1/255 of the relief range), and every pixel whose ground lies under that much water is on the line, so it starts at the waterline and reaches into the shallows, narrow on a steep bank and wide on a gentle one, and the map’s own per-pixel staircasing cannot break it into dashes; ground standing above the surface there is dry, not shore, and draws nothing. Distance Rate bends that ruler with depth: it is multiplied by a factor interpolated, along how far this pixel’s ground sinks into the relief range, from 1 at the canvas-plane end to the given value at the far end (100% = one ruler everywhere). Edge Smooth is the other one, and it averages the *depth field* rather than the colour: it reads the crossing and the threshold off a five-tap field averaged over that radius in layer pixels, which steadies the per-pixel gradient without moving the line (1 = off). Noise rags the threshold per pixel (Seed picks the pattern). Two things are not a water line: a depth discontinuity, where one surface simply stands in front of another — the field’s own second difference around the pixel cuts that, because a bank that walks over the water only bends it while a step breaks it — and a pixel whose mirror point falls outside this picture, where there is no ground at all to be lapped. The line as a whole pays Fade at the full-scale discount, the way the sky colour does — it is not something a ray brought back, so it is not measured per ray either; a full Fade leaves no glowing outline standing around ground the reflection has already been handed back from. Refract Blur blurs only what is seen under the surface: the refracted waterbed stays sharp at the water line and blurs toward its radius as the water deepens, ramping on the same Depth Diff band the Fade Multiplier uses \u2014 the reflection above the water is never blurred by it. Reflection Blur is the reflection\u2019s own softening knob, and it is one of distance: each hit is blurred by how far its ray travelled within Reach, so nearby bounce-backs stay sharp while far ones ease toward the radius, the way distance haze does.',
    params: SSR_PARAMS,
    shaders: { ssr: FX_FS_SSR },
    run: fxglSSR,
    // 旧档的 Relief 说的是「满幅深度折多少**层像素**」,并且这一个数同时当地形满幅、镜面沉入的刻度和
    // ray 爬升的分母。新结构里它只说一件事:深度范围在世界里有多深,单位 = 画布高。旧值按当前画布高
    // 折一次 (96px 在 1024 的档上 = 0.094 ×H) —— 观感会换,这是这次改动的代价。
    // 认出旧档的依据:还没有 Perspective 这颗旋钮,而 Relief 大过 4 (×H 的合法区用不到那个量级)。
    migrate(raw, out) {
        // 首稿的 depthBlur (只糊水下那一层, 语义与 refractBlur 相同) 改名读回。
        if (raw.depthBlur !== undefined && raw.refractBlur === undefined) out.refractBlur = raw.depthBlur;
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
            + `  r${n(p.reach)}px  s${p.steps | 0}  rel${n(p.relief)}H  sol${n(p.solid)}  stp${n(p.steep)}  fov${n(p.persp)}\u00b0`;
        // 波动/折射只在开着时占位; 波长小到位 (0.005 一档) 所以不走 n() 那位「整数才不写小数」的格式化器。
        if (p.wave) s += `  wv${n(p.wave)}\u00b0/${+p.waveLen.toFixed(3)}H${p.wavePhase ? `@${n(p.wavePhase)}` : ''}`;
        if (p.wave && p.refract) s += `  rf${n(p.refract)}`;
        if (p.near === 'dark') s += '  inv';
        if (p.mix < 100) s += `  m${n(p.mix)}`;
        if (p.fade < 100) s += `  f${n(p.fade)}`;
        if (p.smooth) s += `  sm${n(p.smooth)}px`;
        if (p.reflectBlur) s += `  rb${n(p.reflectBlur)}px`;
        if (p.refractBlur) s += `  rfb${n(p.refractBlur)}px`;
        if (p.fadeMul) s += `  fdm${n(p.fadeMul)}`;
        if (p.edge) s += `  e${n(p.edge)}/${n(p.edgeDiff)}lvl`
            + (p.edgeRate !== 100 ? `\u00d7${n(p.edgeRate / 100)}` : '')
            + (p.edgeSmooth > 1 ? ` esm${n(p.edgeSmooth)}` : '');
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
