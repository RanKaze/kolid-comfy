// fx/warp.js —— 特效链的一类特效:位移 (Distort 组)。三种模式共用一个 Warp 条目,靠 Mode 分段钮切换:
//   * Noise   —— 程序化值噪声驱动的位移,像热浪/水波那样把画面揉皱。
//   * Lattice —— 一张铺满该层的四边形网格:拖把手 = 网格跟着走,点一条边 = 沿那条边贯通整张网插一排
//                把手,被这条线穿过的每个四边形都一分为二 (全图只有四边面,不会出三角面)。
//                目标是把图像扭曲印在一个物体上 (PS 的 Mesh Warp 那一类)。
//   * Depth   —— 绑一张深度图,按深度的**梯度**把画面推开,像贴在凹凸面上;Align 决定这张图以谁为准:
//                Canvas = 整张画布 (图层挪到哪就读哪块深度),Local = 该层自己的盒子。
// 注册数据与三条地基契约见 fx/core.js;绑定贴图的解析见 fx/maps.js;网格的把手编辑面在页面本体里
// (blend_node.html 的 warpEdit 那一段 —— 它要拖在真实的画布上,参数区那块小图放不下)。

const WARP_MODES = ['Noise', 'Lattice', 'Depth'];
const WARP_FIELD = 128;                 // 预烘位移面的边长 (格),与图层尺寸无关
const WARP_MAX_HANDLES = 128;           // 细分的天花板:再往上一次拖拽要重烘的格点就压不住了

// ==================== Lattice 的数据模型 ====================
// lattice = { cols, rows, pts: [[x, y, dx, dy], ...] }
//   cols/rows 是**四边形**的个数 (横 cols 个、纵 rows 个),pts 按行优先铺 (cols+1)×(rows+1) 个把手:
//   把手 i 在第 i % (cols+1) 列、第 floor(i / (cols+1)) 行。x/y 是该把手**基准**位置在该层网格里的
//   归一化坐标 (0..1,y 向下 = 图像读法),dx/dy 是它被拖走的归一化位移。
//   纯数组、四位小数:它要进 fxSignature (每次缓存判定都要 stringify)、进 undo 深拷贝、进 .cud。
// 基准位置为什么逐点存着,而不是拿 cols/rows 现算:细分走的是「贯通整张网插一行/一列」,新线落在被点
// 那个格带的中点上,而各带被插的先后次序不同 ⇒ 格距再也不均匀 (会出现 0, 0.25, 0.5, 1 这种排布)。
// 存着基准,插一次只是多一排把手,已有把手一个都不挪窝、画面也一动不动 —— 那才是「把控制网加密」,
// 而不是「把网重排一遍」。
// 全图只有四边面还有一条硬理由:位移场按四边形逐格反查 (见下面的烘法),三角形或 T 形接头都会在格里
// 漏出一条没源的缝。
function warpLatticeStart() {
    // 一个铺满该层的四边形:四个角 = 一层网格的四角,位移全零。
    return {
        cols: 1, rows: 1,
        pts: [[0, 0, 0, 0], [1, 0, 0, 0], [0, 1, 0, 0], [1, 1, 0, 0]],
    };
}

const warpR4 = v => Math.round(v * 1e4) / 1e4;

// 读入即清洗:形状不对 / 点数跟 cols×rows 对不上 / 非数字就整张回退到「还没有网格」,让 run() 干脆
// 跳过这次 pass,而不是拿半张网去烘 (那会在画面上留一条来历不明的错位带)。
function warpLatticeOf(raw) {
    if (!raw || !Array.isArray(raw.pts)) return null;
    const cols = raw.cols | 0, rows = raw.rows | 0;
    if (!(cols >= 1 && rows >= 1)) return null;
    const n = (cols + 1) * (rows + 1);
    if (raw.pts.length !== n || n > WARP_MAX_HANDLES) return null;
    const pts = [];
    for (const q of raw.pts) {
        if (!Array.isArray(q) || q.length < 4) return null;
        const v = [Number(q[0]), Number(q[1]), Number(q[2]), Number(q[3])];
        if (v.some(z => !isFinite(z))) return null;
        pts.push(v);
    }
    return { cols, rows, pts };
}

function warpLatticeIsIdentity(lat) {
    if (!lat) return true;
    return lat.pts.every(q => Math.abs(q[2]) < 1e-5 && Math.abs(q[3]) < 1e-5);
}

// 网格线:横边一排、竖边一排,每条只出现一次 (结构化格点连号就能列全,不需要再去重)。
// 命中判据与画线都读它。
function warpLatticeEdges(lat) {
    const W = lat.cols + 1, out = [];
    for (let r = 0; r <= lat.rows; r++) {
        for (let c = 0; c < lat.cols; c++) out.push([r * W + c, r * W + c + 1]);
    }
    for (let r = 0; r < lat.rows; r++) {
        for (let c = 0; c < W; c++) out.push([r * W + c, (r + 1) * W + c]);
    }
    return out;
}

// 劈开一条边,并且**贯通整张网**:横边 (同排两点的连线) 插一整列把手、竖边插一整行,于是该方向上每
// 一个四边形都被一分为二,全图仍是四边面。新把手的基准取被点那条边两端的**基准**中点、位移取两端位移
// 的中点 ⇒ 它的变形后位置正好落在那条已画出的网格线的中点上,画面一个像素都不动:细分只是加密控制网。
// 双线性片沿中线一劈为二与原来那片**严格等价** (固定 v 时它对 u 就是线性的),所以这条「不动画面」
// 不是近似。返回 { lat, index }:index 就是被点那条边上新长出来的那个把手,手指接着就得拖它。
function warpSplitEdge(lat, a, b) {
    if (!lat) return null;
    const W = lat.cols + 1;
    const ca = a % W, ra = (a - ca) / W, cb = b % W, rb = (b - cb) / W;
    const horiz = ra === rb;
    if (!horiz && ca !== cb) return null;       // 不是相邻格点之间就没有「贯通」可言
    const band = horiz ? Math.min(ca, cb) : Math.min(ra, rb);
    const add = horiz ? lat.rows + 1 : lat.cols + 1;
    if (lat.pts.length + add > WARP_MAX_HANDLES) return null;
    const P = lat.pts;
    const copy = q => [warpR4(q[0]), warpR4(q[1]), warpR4(q[2]), warpR4(q[3])];
    const mid = (A, B) => [warpR4((A[0] + B[0]) / 2), warpR4((A[1] + B[1]) / 2),
        warpR4((A[2] + B[2]) / 2), warpR4((A[3] + B[3]) / 2)];
    const pts = [];
    let index = -1;
    if (horiz) {
        for (let r = 0; r <= lat.rows; r++) {
            for (let c = 0; c <= lat.cols; c++) {
                if (c === band + 1) {
                    if (r === ra) index = pts.length;   // 被点那一排上新长出来的那个
                    pts.push(mid(P[r * W + band], P[r * W + band + 1]));
                }
                pts.push(copy(P[r * W + c]));
            }
        }
        return { lat: { cols: lat.cols + 1, rows: lat.rows, pts }, index };
    }
    for (let r = 0; r <= lat.rows; r++) {
        if (r === band + 1) {
            index = pts.length + ca;                      // 被点那一列上新长出来的那个
            for (let c = 0; c < W; c++) pts.push(mid(P[band * W + c], P[(band + 1) * W + c]));
        }
        for (let c = 0; c < W; c++) pts.push(copy(P[r * W + c]));
    }
    return { lat: { cols: lat.cols, rows: lat.rows + 1, pts }, index };
}

// 拖动一个把手:只改它的位移,基准点永远钉在格子的原始位置上 —— 那才是「网格跟着走」而不是
// 「网格重新分配」。返回新对象,绝不原地改:那串数组在 undo 快照之间是共享引用。
function warpMoveHandle(lat, index, dx, dy) {
    if (!lat) return lat;
    const pts = lat.pts.map(q => q.slice());
    pts[index] = [warpR4(pts[index][0]), warpR4(pts[index][1]), warpR4(dx), warpR4(dy)];
    return { cols: lat.cols, rows: lat.rows, pts };
}

// 写回 params 永远整体替换 (同上,共享引用那条规矩)。刷新纪律交给手势那一侧:拖途中走
// fxLiveUpdate,松手才 pushHistory;插一行/一列是一次离散动作,走 fxStructuralChange 连带重建子行。
function warpSetLattice(effect, lat) {
    if (!effect.params) effect.params = {};
    effect.params.lattice = lat;
}

// ==================== 位移场 ====================
// 烘在**输出**网格上:取输出点 q,找它落在哪个**变形后**的四边形里,解出该四边形里的双线性参数
// (u,v),拿同一组参数回取**基准**四边形的同位置点 s,位移 = s - q。方向必须是这个 (按输出查源),
// 反过来 (拿源点找落点) 是散点填空,格子之间会漏。
// 反解走 Newton:四边形先按线性部分 (丢掉 u·v 那一项) 给一个初始猜测,再迭代收敛。解不出来 (不收敛、
// 雅可比退化、跑出质心范围) 就当作不在这个格里:面积塌成零的格 (把手互相拖到身上) 因此自然让开,
// 那块没有源 = 透明,而不是拿一份错的位移硬填。把手交叉到格子翻面时,后画的那片盖住先画的那片 ——
// 与 PS 的网格同一个读法。
const warpField = { gl: null, tex: null, bytes: null, dx: null, dy: null, cov: null };

// 纹理跟着 GL 上下文活,不是跟着页面活:引擎在编译失败时会把 fxgl.gl 置空、下次重建一个新上下文,
// 那时旧句柄是废的。所以按上下文身份建一次,换了就重来 —— 与引擎自己那四张贴图同一条规矩。
function warpFieldInit(gl) {
    if (warpField.gl === gl) return;
    const n = WARP_FIELD * WARP_FIELD;
    warpField.gl = gl;
    warpField.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, warpField.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    warpField.bytes = new Uint8Array(n * 4);
    warpField.dx = new Float32Array(n);
    warpField.dy = new Float32Array(n);
    warpField.cov = new Uint8Array(n);
}

// R/G 存位移 (128 = 不动),A 存覆盖。两者都是字节上的线性编码,所以纹理的线性过滤与解码是仿射的、
// 可以先插值再换算。定标取本次烘出的最大位移 ⇒ 刻度永远是「满幅拖动的 1/127」(拖 100px ⇒ 约
// 0.8px 一级),与图层尺寸、与把手到底拖了多远都无关。
function warpBakeField(lat, w, h) {
    const F = WARP_FIELD;
    const cov = warpField.cov, dxs = warpField.dx, dys = warpField.dy, bytes = warpField.bytes;
    cov.fill(0);
    const P = lat.pts, W = lat.cols + 1;
    for (let rr = 0; rr < lat.rows; rr++) {
        for (let cc = 0; cc < lat.cols; cc++) {
            const i00 = rr * W + cc, i10 = i00 + 1, i11 = i00 + W + 1, i01 = i00 + W;
            const A = P[i00], B = P[i10], C = P[i11], D = P[i01];
            // 变形后那片:A + u·bu + v·bv + u·v·bc
            const p0x = A[0] + A[2], p0y = A[1] + A[3];
            const p1x = B[0] + B[2], p1y = B[1] + B[3];
            const p2x = C[0] + C[2], p2y = C[1] + C[3];
            const p3x = D[0] + D[2], p3y = D[1] + D[3];
            const bux = p1x - p0x, buy = p1y - p0y;
            const bvx = p3x - p0x, bvy = p3y - p0y;
            const bcx = p2x - p1x - p3x + p0x, bcy = p2y - p1y - p3y + p0y;
            // 基准那片:同一组 (u,v) 直接插出源点 (双线性片的边就是直线,端点中点那些推导都成立)。
            const s0x = A[0], s0y = A[1];
            const sux = B[0] - s0x, suy = B[1] - s0y;
            const svx = D[0] - s0x, svy = D[1] - s0y;
            const scx = C[0] - B[0] - D[0] + s0x, scy = C[1] - B[1] - D[1] + s0y;
            const det = bux * bvy - bvx * buy;
            if (!(Math.abs(det) > 1e-9)) continue;
            // 只扫这个四边形自己的包围盒:代价是 Σ(格子面积) 而不是 格子数 × 格数,
            // 128×128 一张面才拖得动实时预览。
            const x0 = Math.max(0, Math.floor(Math.min(p0x, p1x, p2x, p3x) * F));
            const x1 = Math.min(F - 1, Math.ceil(Math.max(p0x, p1x, p2x, p3x) * F) - 1);
            const y0 = Math.max(0, Math.floor(Math.min(p0y, p1y, p2y, p3y) * F));
            const y1 = Math.min(F - 1, Math.ceil(Math.max(p0y, p1y, p2y, p3y) * F) - 1);
            for (let fy = y0; fy <= y1; fy++) {
                const qy = (fy + 0.5) / F;
                for (let fx = x0; fx <= x1; fx++) {
                    const qx = (fx + 0.5) / F;
                    const ex = qx - p0x, ey = qy - p0y;
                    let u = (ex * bvy - ey * bvx) / det;
                    let v = (bux * ey - buy * ex) / det;
                    for (let it = 0; it < 6; it++) {
                        const rx = p0x + u * bux + v * bvx + u * v * bcx - qx;
                        const ry = p0y + u * buy + v * bvy + u * v * bcy - qy;
                        const jx = bux + v * bcx, jy = buy + v * bcy;
                        const kx = bvx + u * bcx, ky = bvy + u * bcy;
                        const jd = jx * ky - kx * jy;
                        if (!(Math.abs(jd) > 1e-12)) break;
                        const du = (kx * ry - ky * rx) / jd;
                        const dv = (jy * rx - jx * ry) / jd;
                        u += du; v += dv;
                        if (!isFinite(u) || !isFinite(v)) break;
                        if (Math.abs(du) < 1e-9 && Math.abs(dv) < 1e-9) break;
                    }
                    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
                    const rx = p0x + u * bux + v * bvx + u * v * bcx - qx;
                    const ry = p0y + u * buy + v * bvy + u * v * bcy - qy;
                    // 不收敛 (翻面、退化的格) 就当作不在这个格里:让另一格去接,谁都没接就是透明。
                    if (rx * rx + ry * ry > 1e-10) continue;
                    const i = fy * F + fx;
                    dxs[i] = s0x + u * sux + v * svx + u * v * scx - qx;
                    dys[i] = s0y + u * suy + v * svy + u * v * scy - qy;
                    cov[i] = 1;
                }
            }
        }
    }
    let maxAbs = 1e-4;
    for (let i = 0; i < F * F; i++) {
        if (!cov[i]) continue;
        const px = Math.abs(dxs[i]) * w, py = Math.abs(dys[i]) * h;
        if (px > maxAbs) maxAbs = px;
        if (py > maxAbs) maxAbs = py;
    }
    const kx = 127 * w / maxAbs, ky = 127 * h / maxAbs;
    for (let fy = 0; fy < F; fy++) {
        // 字节数组的第 0 行是纹理的 v=0 (GL 朝上),而这里的 fy 按图像 y 向下数 ⇒ 写的时候翻一行。
        const row = (F - 1 - fy) * F;
        for (let fx = 0; fx < F; fx++) {
            const i = fy * F + fx;
            const o = (row + fx) * 4;
            if (!cov[i]) { bytes[o] = 128; bytes[o + 1] = 128; bytes[o + 2] = 0; bytes[o + 3] = 0; continue; }
            bytes[o] = Math.max(0, Math.min(255, 128 + Math.round(dxs[i] * kx)));
            bytes[o + 1] = Math.max(0, Math.min(255, 128 + Math.round(dys[i] * ky)));
            bytes[o + 2] = 0;
            bytes[o + 3] = 255;
        }
    }
    return maxAbs;
}

// ==================== 着色器 ====================
// 三种模式共用同一条取样规矩:位移**出界** (源点跑到该层网格之外) 就是没有源 ⇒ 透明。
// 不这么做的话采样器 (CLAMP_TO_EDGE) 会把最外圈像素抹成一条拖影,那是契约①最讨厌的那种违例。
const WARP_GLSL_SAMPLE = `
vec4 warpFetch(sampler2D tex, vec2 uv) {
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
    return texture(tex, uv);
}`;

// 噪声:逐倍频程的值噪声 (格点哈希 + smoothstep 双线性插值),两路独立噪声给两个轴各自的位移。
// 格子按**该层网格的像素**计 (cellUv = 格子像素 / 该轴像素数),所以 Scale 就是「一颗褶子多大」,
// 与画布无关;每加一个倍频程格子减半、幅度乘 0.6。
const FX_FS_WARP_NOISE = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform vec2 uSize;
uniform float uCell;
uniform float uAmount;
uniform float uSeed;
uniform int uOct;
float warpHash(vec2 p) {
    p = fract(p * vec2(0.1031, 0.1030));
    p += dot(p, p + 23.13);
    return fract(p.x * p.y * 45.73);
}
float warpNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = warpHash(i);
    float b = warpHash(i + vec2(1.0, 0.0));
    float c = warpHash(i + vec2(0.0, 1.0));
    float d = warpHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
${WARP_GLSL_SAMPLE}
void main() {
    vec2 off = vec2(0.0);
    float cell = uCell;
    float amp = uAmount;
    for (int o = 0; o < 4; o++) {
        if (o >= uOct) break;
        vec2 cellUv = vec2(cell / uSize.x, cell / uSize.y);
        vec2 p = vUV / cellUv + vec2(uSeed + 7.31 * float(o), uSeed * 1.73 + 11.17 * float(o));
        vec2 n = vec2(warpNoise(p), warpNoise(p + vec2(37.13, 11.71))) - 0.5;
        off += n * amp * cellUv;
        cell *= 0.5;
        amp *= 0.6;
    }
    Frag = warpFetch(uTex, vUV + off);
}`;

// 网格:查那张预烘好的位移面。位移按各轴的满幅折算成 uv,覆盖度在 A 上 —— 网格没盖到的地方就是
// 没有像素,和「源点出界」同一读法。
const FX_FS_WARP_LATTICE = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uField;
uniform vec2 uFieldUv;
${WARP_GLSL_SAMPLE}
void main() {
    vec4 f = texture(uField, vUV);
    float cov = f.a;
    if (cov <= 0.004) { Frag = vec4(0.0); return; }
    vec2 d = (f.rg * 255.0 - 128.0) / 127.0;
    vec4 c = warpFetch(uTex, vUV + d * uFieldUv);
    Frag = vec4(c.rgb, c.a * cov);
}`;

// 深度:沿深度的**梯度**推开画面 (贴凹凸的读法)。梯度不取贴图自己的轴,而是沿该层网格的两条轴取
// 方向导数 —— 于是「图层往右」在 Canvas 对齐下对应画布的哪个方向,全交给 uMapU/uMapV 那对基
// (图层盒子 → 画布归一化 → 贴图 uv 的同一条仿射,JS 侧算好),着色器不必知道旋转存在。
// uPush 描述的是**取样点**往哪挪;画面走的正是反方向,所以 Slide 名字读的是画面的去向。
const FX_FS_WARP_DEPTH = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uMap;
uniform vec2 uMapU;
uniform vec2 uMapV;
uniform vec2 uMapB;
uniform vec2 uSize;
uniform vec2 uPush;
uniform float uWindow;
float warpDepth(vec2 uv) { return texture(uMap, uv).r; }
${WARP_GLSL_SAMPLE}
void main() {
    vec2 muv = uMapU * vUV.x + uMapV * vUV.y + uMapB;
    vec2 tx = uMapU * (uWindow / uSize.x);
    vec2 ty = uMapV * (uWindow / uSize.y);
    float dx = (warpDepth(muv + tx) - warpDepth(muv - tx)) * 0.5;
    float dy = (warpDepth(muv + ty) - warpDepth(muv - ty)) * 0.5;
    Frag = warpFetch(uTex, vUV + vec2(dx, dy) * uPush);
}`;

// ==================== pass ====================
// 三种模式都是「一次取样」的位移:像素不外扩 (输出网格 === 输入网格),alpha 跟着像素走 (取样点落到
// 本来透明的地方,出口就是透明的),蒙版只读不写 —— 三条契约全部守住。
function warpDepthFrame(p, l) {
    // Local: 深度图按该层自己的盒子铺满,贴图 uv 与该层网格 uv 完全重合 ⇒ 恒等基。
    if (!l || p.align !== 'Canvas' || !canvasW || !canvasH) return { u: [1, 0], v: [0, 1], b: [0, 0] };
    const tr = effectiveTransform(l);
    const cos = Math.cos(tr.rotation), sin = Math.sin(tr.rotation);
    // 画布归一化 (逐轴除以 canvasW / canvasH,y 向下) 对盒子坐标 (u, v ∈ [-1,1],v 向下) 的偏导。
    // 两轴各自除的是画布的宽和高,所以那里要乘的是**另一个轴**的比值。
    const kw = canvasH / canvasW, kh = canvasW / canvasH;
    const nu = [tr.w / 2 * cos, tr.w / 2 * sin * kh];
    const nv = [-tr.h / 2 * sin * kw, tr.h / 2 * cos];
    // 盒子里 x ∈ [0,1] 从左数、vUV.y 从下数 ⇒ u = 2x-1、v = 1-2y;贴图上传翻过 v,所以再翻一次。
    return {
        u: [2 * nu[0], -2 * nu[1]],
        v: [-2 * nv[0], 2 * nv[1]],
        b: [tr.cx - nu[0] + nv[0], 1 - tr.cy + nu[1] - nv[1]],
    };
}

function fxglWarp(col, p, effect, l) {
    const gl = fxgl.gl;
    const dst = fxgl.off[1 - col.slot];
    const src = fxgl.off[col.slot].tex;
    if (p.mode === 'Noise') {
        if (p.amount <= 0) return;
        fxglRunPass(dst, fxgl.progs.warpNoise, pr => {
            fxglBindTex(pr, 'uTex', src, 0);
            gl.uniform2f(fxglU(pr, 'uSize'), fxgl.w, fxgl.h);
            gl.uniform1f(fxglU(pr, 'uCell'), p.scale);
            gl.uniform1f(fxglU(pr, 'uAmount'), p.amount);
            gl.uniform1f(fxglU(pr, 'uSeed'), p.seed);
            gl.uniform1i(fxglU(pr, 'uOct'), p.octaves | 0);
        });
        col.slot = 1 - col.slot;
        return;
    }
    if (p.mode === 'Lattice') {
        const lat = warpLatticeOf(p.lattice);
        // 还没有网格 / 网格一点没拖 = 画面原样,不必占用一次 pass。
        if (!lat || warpLatticeIsIdentity(lat)) return;
        warpFieldInit(gl);
        const maxAbs = warpBakeField(lat, fxgl.w, fxgl.h);
        gl.bindTexture(gl.TEXTURE_2D, warpField.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, WARP_FIELD, WARP_FIELD, 0, gl.RGBA, gl.UNSIGNED_BYTE, warpField.bytes);
        fxglRunPass(dst, fxgl.progs.warpLattice, pr => {
            fxglBindTex(pr, 'uTex', src, 0);
            fxglBindTex(pr, 'uField', warpField.tex, 1);
            // y 取负:位移按图像 (y 向下) 烘,纹素的 v 朝上。
            gl.uniform2f(fxglU(pr, 'uFieldUv'), maxAbs / fxgl.w, -maxAbs / fxgl.h);
        });
        col.slot = 1 - col.slot;
        return;
    }
    // Depth:引擎按 needsMapWhen 已经把 texMap 备好并上传 (没绑图 / 图没解码根本走不到这里)。
    if (p.strength <= 0) return;
    const fr = warpDepthFrame(p, l);
    const push = p.strength * (p.slide === 'uphill' ? -1 : 1);
    fxglRunPass(dst, fxgl.progs.warpDepth, pr => {
        fxglBindTex(pr, 'uTex', src, 0);
        fxglBindTex(pr, 'uMap', fxgl.texMap, 1);
        gl.uniform2f(fxglU(pr, 'uMapU'), fr.u[0], fr.u[1]);
        gl.uniform2f(fxglU(pr, 'uMapV'), fr.v[0], fr.v[1]);
        gl.uniform2f(fxglU(pr, 'uMapB'), fr.b[0], fr.b[1]);
        gl.uniform2f(fxglU(pr, 'uSize'), fxgl.w, fxgl.h);
        gl.uniform2f(fxglU(pr, 'uPush'), push / fxgl.w, push / fxgl.h);
        gl.uniform1f(fxglU(pr, 'uWindow'), p.window);
    });
    col.slot = 1 - col.slot;
}

// ==================== 参数区 ====================
// 一格一个 Warp:Mode 用分段钮 (和 Anchor / Near 同一套控件词汇),下面只铺该模式要用的行 ——
// 和色调映射那张面板同一个规矩。Lattice 模式多一个按钮:进出画布上的把手编辑。
const WARP_PARAMS = [
    { key: 'mode', label: 'Mode', kind: 'enum', options: WARP_MODES, def: 'Noise' },
    { key: 'scale', label: 'Scale', min: 4, max: 256, step: 1, def: 48, unit: 'px', when: p => p.mode === 'Noise' },
    { key: 'amount', label: 'Amount', min: 0, max: 128, step: 1, def: 10, unit: 'px', when: p => p.mode === 'Noise' },
    { key: 'octaves', label: 'Oct', min: 1, max: 4, step: 1, def: 2, when: p => p.mode === 'Noise' },
    { key: 'seed', label: 'Seed', min: 0, max: 999, step: 1, def: 0, when: p => p.mode === 'Noise' },
    { key: 'lattice', label: 'Grid', def: null, when: p => p.mode === 'Lattice' },
    { key: 'map', label: 'Map', kind: 'map', def: null, when: p => p.mode === 'Depth' },
    { key: 'align', label: 'Align', kind: 'enum', options: ['Canvas', 'Local'], def: 'Canvas', when: p => p.mode === 'Depth' },
    { key: 'strength', label: 'Push', min: 0, max: 128, step: 1, def: 24, unit: 'px', when: p => p.mode === 'Depth' },
    { key: 'window', label: 'Grad', min: 1, max: 64, step: 1, def: 8, unit: 'px', when: p => p.mode === 'Depth' },
    { key: 'slide', label: 'Slide', kind: 'enum', options: ['downhill', 'uphill'], def: 'downhill', when: p => p.mode === 'Depth' },
];

// 两枚各指一个目的地的钮 (摊开 / 收起),不是一枚读当前状态的翻转钮 —— 见「一键一语义」。
// 摊开那颗还兼「没有网格就先铺一个四边形」:那是同一次落点 (网格出现在画布上),不是第二个语义。
function warpLatticeRowEl(l, effect) {
    const row = document.createElement('div');
    row.className = 'control-row';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'fx-map-btn';
    edit.textContent = 'Edit the grid';
    edit.title = 'Lay the grid on the canvas: drag a handle to warp, click an edge to split the grid all the way across';
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'fx-map-btn tight';
    hide.textContent = 'Hide';
    hide.title = 'Take the grid off the canvas (the warp itself stays)';
    const clr = document.createElement('button');
    clr.type = 'button';
    clr.className = 'fx-map-btn tight';
    clr.textContent = '\u00d7 Drop';
    clr.title = 'Drop the grid (every handle and its displacement)';
    const show = () => {
        const lat = warpLatticeOf(effectParams(effect).lattice);
        edit.textContent = lat ? 'Edit the grid' : 'Add a grid';
        edit.classList.toggle('active', warpEditActive(l, effect));
        hide.style.display = warpEditActive(l, effect) ? '' : 'none';
        clr.style.display = lat ? '' : 'none';
    };
    edit.addEventListener('click', ev => {
        ev.stopPropagation();
        // 先进编辑态再造网格:顺序反过来,重建的那一行还不认识 warpEdit,按钮的高亮会停在「没摊开」。
        beginWarpEdit(l, effect);
        if (!warpLatticeOf(effectParams(effect).lattice)) {
            warpSetLattice(effect, warpLatticeStart());
            fxStructuralChange(l);
        }
    });
    hide.addEventListener('click', ev => { ev.stopPropagation(); endWarpEdit(); });
    clr.addEventListener('click', ev => {
        ev.stopPropagation();
        if (warpEditActive(l, effect)) endWarpEdit();
        if (!effect.params) effect.params = {};
        effect.params.lattice = null;
        fxStructuralChange(l);
    });
    row.appendChild(edit);
    row.appendChild(hide);
    row.appendChild(clr);
    show();
    return row;
}

function warpEditorEl(l, effect, syncRead, updaters) {
    const box = document.createElement('div');
    box.className = 'fx-warp';
    const tail = document.createElement('div');
    tail.className = 'fx-warp-tail';
    const foot = document.createElement('div');
    foot.className = 'fx-warp-foot';
    const hint = document.createElement('span');
    foot.appendChild(hint);

    function build() {
        const p = effectParams(effect);
        const rows = WARP_PARAMS
            .filter(d => d.key !== 'mode' && d.key !== 'lattice' && (!d.when || d.when(p)))
            .map(d => fxControlRow(l, effect, d, syncRead, updaters));
        if (p.mode === 'Lattice') rows.push(warpLatticeRowEl(l, effect));
        tail.replaceChildren(...rows);
        hint.textContent = p.mode === 'Lattice' ? 'drag a handle \u00b7 click an edge to split across' : '';
        foot.style.display = hint.textContent ? '' : 'none';
        syncRead();
    }
    // 模式是这张面板的第一行。它照旧走通用的分段钮 (词汇不动),只多接一句「换完模式重铺剩下的
    // 行」—— 包在 syncRead 里递下去,而不是自己再搭一份钮,理由同 fx/tone_map.js。
    box.appendChild(fxControlRow(l, effect, WARP_PARAMS[0], () => { build(); }, updaters));
    box.appendChild(tail);
    box.appendChild(foot);
    build();
    return box;
}

defineEffect({
    type: 'warp',
    label: 'Warp',
    group: 'Distort',
    icon: 'warp',
    needsMap: 'Depth',
    needsMapWhen: p => p.mode === 'Depth',
    desc: 'Move pixels around inside the layer\u2019s own grid. Noise pushes them through a procedural value-noise field (Scale = how big a wrinkle, Amount = how far it pushes). Lattice lays a quadrilateral grid over the layer: drag a handle to bend the picture, click an edge to run a split straight through the grid \u2014 every quad it crosses becomes two quads, so the mesh stays all-quads. That is how artwork gets printed onto a shape. Depth reads a bound depth map and slides the picture along the map\u2019s gradient, as if it lay on the relief; Align says whether that map is measured against the whole canvas or against this layer alone. Displacement only: where the picture moves off the grid there is nothing left to pull in, so it goes transparent.',
    params: WARP_PARAMS,
    editor: warpEditorEl,
    shaders: { warpNoise: FX_FS_WARP_NOISE, warpLattice: FX_FS_WARP_LATTICE, warpDepth: FX_FS_WARP_DEPTH },
    run: fxglWarp,
    // Canvas 对齐的深度吃的还是「该层盒子落在画布哪儿」,而拖图层既不改像素也不改 params。缓存身份
    // 必须知道这一件事,否则挪完层还在用挪之前烘好的那份位移 —— 注册表为此留了 stamp 这个口子。
    stamp(effect, l) {
        const p = effectParams(effect);
        if (p.mode !== 'Depth' || p.align !== 'Canvas') return '';
        const tr = effectiveTransform(l);
        return `${tr.cx.toFixed(4)},${tr.cy.toFixed(4)},${tr.w.toFixed(4)},${tr.h.toFixed(4)},${tr.rotation.toFixed(3)}`;
    },
    readout(p, n, effect) {
        if (p.mode === 'Noise') return `noise  s${n(p.scale)}  a${n(p.amount)}  o${p.octaves}  #${p.seed}`;
        if (p.mode === 'Lattice') {
            const lat = warpLatticeOf(p.lattice);
            // 读数报的是四边形的个数 (横×纵),因为那才是「网被劈成几块」;把手数 = (横+1)×(纵+1)。
            return lat ? `lattice  ${lat.cols}\u00d7${lat.rows} quads` : 'lattice  no grid';
        }
        return `${fxMapShort(effect)}  ${p.align === 'Local' ? 'local' : 'canvas'}  p${n(p.strength)}  g${n(p.window)}${p.slide === 'uphill' ? '  up' : ''}`;
    },
    thumb(g, box) {
        // 一格被按下去一角的方格网:虚线是格子原来占的框,实线是网格拖成什么样。
        const bump = (x, y) => {
            const bx = 0.7, by = 0.32;
            const r2 = ((x - bx) * (x - bx)) / 0.12 + ((y - by) * (y - by)) / 0.16;
            const k = Math.exp(-r2) * 0.5;
            return { x: x + (x - bx) * k, y: y + (y - by) * k };
        };
        const px = t => box.x + t * box.w;
        const py = t => box.y + t * box.h;
        g.save();
        g.strokeStyle = 'rgba(255,255,255,0.25)';
        g.lineWidth = 1;
        g.setLineDash([3, 3]);
        g.strokeRect(box.x, box.y, box.w, box.h);
        g.setLineDash([]);
        g.strokeStyle = '#6f8cff';
        g.lineWidth = 1.3;
        for (let i = 0; i <= 4; i++) {
            const t = i / 4;
            g.beginPath();
            for (let s = 0; s <= 24; s++) {
                const q = bump(s / 24, t);
                if (s) g.lineTo(px(q.x), py(q.y)); else g.moveTo(px(q.x), py(q.y));
            }
            g.stroke();
            g.beginPath();
            for (let s = 0; s <= 24; s++) {
                const q = bump(t, s / 24);
                if (s) g.lineTo(px(q.x), py(q.y)); else g.moveTo(px(q.x), py(q.y));
            }
            g.stroke();
        }
        const c = bump(1, 0);
        g.fillStyle = '#fff';
        g.fillRect(px(c.x) - 2.5, py(c.y) - 2.5, 5, 5);
        g.restore();
    },
});
