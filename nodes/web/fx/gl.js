// ---- WebGL2 engine ----
// 特效链的执行内核:缓冲/纹理、三份共享着色器、Kawase 低通原语、链的调度与表面缓存。
// 各类特效的着色器与 pass 不在这里 —— 它们在自己的 fx/<effect>.js 里注册进来 (见 core.js)。
// 2/3/4 号缓冲是「公共借用区」:silhouette 特效 (内/外阴影、描边) 用它们存形状与虚化,景深与泛光用
// 它们存低通档位 —— 同一条链里这些面每趟都重算,所以互不污染,一套五张缓冲的显存预算也就不会随特效
// 种类增长。
// 五张离屏缓冲按当前图层尺寸复用:0/1 = 色彩乒乓,2 = silhouette 原样,3/4 = silhouette 虚化。
// 图层之间尺寸通常一致,所以一帧里多个图层走特效也不会反复分配。
const FX_MAX_PIXELS = 12e6;              // 5 × RGBA16F ≈ 480 MB 的地板,超过就整链跳过并说明原因
const FX_KAWASE_MAX_ITER = 8;            // 着色器里那个常数次循环的上界
const fxgl = {
    gl: null, dead: '', skip: '', w: 0, h: 0, fmt: null, vao: null, maxTex: 0,
    off: [], texSrc: null, texMask: null, texMap: null, texLut: null, progs: null, canvas: null, hasMask: 0,
};

const FX_VS = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() { vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// silhouette:特效眼里唯一的「形状」= 图层 alpha × 蒙版 alpha,存进四个通道。
const FX_FS_SIL = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uSrc;
uniform sampler2D uMask;
uniform int uHasMask;
void main() {
    float a = texture(uSrc, vUV).a;
    if (uHasMask == 1) a *= texture(uMask, vUV).a;
    Frag = vec4(a, a, a, a);
}`;

// dual-filtering:一个 pass 里做 uIter 次抽样,每次恒定 4 个抽样点(一对正交十字)、与半径无关。
// 十字的朝向逐迭代转 45°、起点 22.5°,down/up 两趟用 uPhase 再错一格:旧写法四角永远落在两条对角
// 线上,半径大而迭代少时高反差边缘就长出肉眼可见的**十字纹**;换成旋转基后各向同性,抽样数与半径
// 刻度都没变。
// uAlphaOnly=1 是 silhouette 的模式(数据只在 alpha 上,走纯加权平均);=0 是色彩模式 ——
// 每个抽样先预乘再累加,最后用「预乘均值 / alpha 均值」除回直通色,alpha 通道输出同一个 alpha
// 均值。链**会**重塑不透明度(模糊/运动模糊/马赛克都把软边吹开),色彩归一化保证透明边缘
// 不把颜色拽向黑(正是多趟累加最容易踩的坑)。uIter=0 恰好是恒等拷贝,色彩链用它起步。
const FX_FS_BOX = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform vec2 uStart;
uniform vec2 uDelta;
uniform int uIter;
uniform int uAlphaOnly;
uniform int uPhase;
void main() {
    vec4 c0 = texture(uTex, vUV);
    vec3 acc = c0.rgb * c0.a;
    float aAcc = c0.a;
    float wAcc = 1.0;
    for (int i = 0; i < ${FX_KAWASE_MAX_ITER}; i++) {
        if (i >= uIter) break;
        float k = float(i);
        // 四个抽样点是**一对正交的十字**,距离沿用旧四角的 |r|·√2 刻度;十字本身每迭代转 45°、
        // 起点 22.5°。4 阶矩上单十字已经各向同性(E[X^4]+E[Y^4] = 6·E[X²Y²] 在 θ=22.5° 时成立),
        // 相邻迭代再互补一次,所以既没有 × 也没有 +,而抽样数一个没多。
        float d = (uStart + uDelta * k).x * 1.4142135;
        float ang = (k + float(uPhase)) * 0.7853982 + 0.3926991;
        vec2 dir = vec2(cos(ang), sin(ang)) * d;
        vec2 u = vec2(dir.x * uTexel.x, dir.y * uTexel.y);
        vec2 v = vec2(-dir.y * uTexel.x, dir.x * uTexel.y);
        float w = 1.0 + k;
        vec4 s1 = texture(uTex, vUV + u);
        vec4 s2 = texture(uTex, vUV - u);
        vec4 s3 = texture(uTex, vUV + v);
        vec4 s4 = texture(uTex, vUV - v);
        acc += w * (s1.rgb * s1.a + s2.rgb * s2.a + s3.rgb * s3.a + s4.rgb * s4.a);
        aAcc += w * (s1.a + s2.a + s3.a + s4.a);
        wAcc += 4.0 * w;
    }
    float aAvg = aAcc / wAcc;
    if (uAlphaOnly == 1) { Frag = vec4(aAvg, aAvg, aAvg, aAvg); return; }
    Frag = vec4(clamp(acc / max(aAcc, 1e-5), 0.0, 1.0), clamp(aAvg, 0.0, 1.0));
}`;
// 出口:色彩缓冲是直通 alpha,而 WebGL canvas 被 drawImage 读走时按预乘解释,所以在这里乘一次。
const FX_FS_PRESENT = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
void main() {
    vec4 c = texture(uTex, vUV);
    Frag = vec4(c.rgb * c.a, c.a);
}`;

function fxglCompile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        fxgl.dead = 'shader: ' + (gl.getShaderInfoLog(s) || 'failed');
        return null;
    }
    return s;
}

function fxglProgram(gl, name, fragSrc) {
    const vs = fxglCompile(gl, gl.VERTEX_SHADER, FX_VS);
    const fs = fxglCompile(gl, gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    // 钉死 aPos = location 0:所有程序共用同一个 VAO,Attribute 必须落在同一处。
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        fxgl.dead = 'link ' + name + ': ' + (gl.getProgramInfoLog(p) || 'failed');
        return null;
    }
    return { p, u: {} };
}

function fxglU(prog, name) {
    if (!(name in prog.u)) prog.u[name] = fxgl.gl.getUniformLocation(prog.p, name);
    return prog.u[name];
}

function fxglInit() {
    if (fxgl.gl || fxgl.dead) return fxgl.gl;
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl) { fxgl.dead = 'no WebGL2'; return null; }
    fxgl.gl = gl;
    fxgl.canvas = canvas;
    fxgl.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) | 0;
    // 可滤色的半浮点是这套算法最合适的落点:32F 还额外要 OES_texture_float_linear 才能做
    // dual-filtering 依赖的线性抽样,而 16F 在 WebGL2 里既可渲又可滤。都没有就退回 8 位。
    if (gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float')) {
        fxgl.fmt = { internal: gl.RGBA16F, type: gl.HALF_FLOAT };
    } else {
        fxgl.fmt = { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
    }
    // 引擎只有三张着色器:形状、Kawase 低通、出口。其余全部由注册表报上来 —— 每类特效把
    // 自己的 fragment 挂在 shaders 上,新增特效不必回来改这张列表。
    const progs = {
        sil: fxglProgram(gl, 'sil', FX_FS_SIL),
        box: fxglProgram(gl, 'box', FX_FS_BOX),
        present: fxglProgram(gl, 'present', FX_FS_PRESENT),
    };
    let ready = progs.sil && progs.box && progs.present;
    for (const spec of Object.values(EFFECT_TYPES)) {
        for (const name of Object.keys(spec.shaders || {})) {
            progs[name] = fxglProgram(gl, name, spec.shaders[name]);
            // 失败也要把剩下的编完:fxgl.dead 里留下的是最后那个原因,而整链一次都不该跑半截。
            if (!progs[name]) ready = false;
        }
    }
    if (!ready) { fxgl.gl = null; return null; }
    fxgl.progs = progs;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    // 覆盖全域的 TRIANGLE_STRIP。上传时开 UNPACK_FLIP_Y,纹理与视口同为 y 向上,所以着色器的
    // vUV 与图像同向;画布里「向下」的偏移要在 JS 侧把 y 取负再传(见 fxglDirUV)。
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    fxgl.vao = vao;
    // texLut 是曲线那类特效的查表位:内容逐次上传,所以这里只备好 LINEAR + CLAMP 的采样状态。
    for (const key of ['texSrc', 'texMask', 'texMap', 'texLut']) {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        fxgl[key] = t;
    }
    return gl;
}

function fxglMakeBuffer(gl, w, h) {
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
    return { tex, fb, ok };
}

function fxglResize(gl, w, h) {
    if (fxgl.w === w && fxgl.h === h && fxgl.off.length === 5) return true;
    if (w * h > FX_MAX_PIXELS) { fxgl.skip = 'layer too large for the effect chain'; return false; }
    const maxSide = fxgl.maxTex;
    if (w > maxSide || h > maxSide) { fxgl.skip = 'layer exceeds the texture limit'; return false; }
    for (const b of fxgl.off) { gl.deleteFramebuffer(b.fb); gl.deleteTexture(b.tex); }
    fxgl.off = [];
    for (let i = 0; i < 5; i++) {
        const b = fxglMakeBuffer(gl, w, h);
        if (!b.ok) { fxgl.dead = 'framebuffer incomplete'; fxgl.gl = null; return false; }
        fxgl.off.push(b);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    fxgl.w = w;
    fxgl.h = h;
    fxgl.canvas.width = w;
    fxgl.canvas.height = h;
    return true;
}

function fxglUploadCanvas(tex, src) {
    const gl = fxgl.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
}

// dst = null 即画进默认缓冲(那张用于读回的 GL canvas)。
function fxglRunPass(dst, prog, setup) {
    const gl = fxgl.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
    gl.viewport(0, 0, fxgl.w, fxgl.h);
    gl.useProgram(prog.p);
    gl.bindVertexArray(fxgl.vao);
    setup(prog);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function fxglBindTex(prog, name, tex, unit) {
    const gl = fxgl.gl;
    const loc = fxglU(prog, name);
    if (!loc) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
}

// uStart/uDelta 以 texel 计,着色器再乘 uTexel。phase 只决定抽样朝向从哪一路起(对角/轴向),
// down 与 up 各取 0/1,两趟的朝向正好互换。同一份着色器也修好了 silhouette 的高斯。
function fxglBox(dst, srcTex, start, delta, iter, alphaOnly, phase) {
    const gl = fxgl.gl;
    fxglRunPass(dst, fxgl.progs.box, p => {
        fxglBindTex(p, 'uTex', srcTex, 0);
        gl.uniform2f(fxglU(p, 'uTexel'), 1 / fxgl.w, 1 / fxgl.h);
        gl.uniform2f(fxglU(p, 'uStart'), start, start);
        gl.uniform2f(fxglU(p, 'uDelta'), delta, delta);
        gl.uniform1i(fxglU(p, 'uIter'), iter);
        gl.uniform1i(fxglU(p, 'uAlphaOnly'), alphaOnly ? 1 : 0);
        gl.uniform1i(fxglU(p, 'uPhase'), phase ? 1 : 0);
    });
}

// 半径 R = n*start + delta*n(n-1)/2;取 start=delta 解出 step,一趟由小到大、一趟由小到大退回,
// 抽样数只随 n 线性增长(n = radius/5 夹在 1..8),与半径本身脱钩。朝向旋转把十字摊平是在**同一
// 个 n** 上完成的,所以这套抽样预算一个字都没动。
function fxglKawaseIters(radius) {
    return Math.max(1, Math.min(FX_KAWASE_MAX_ITER, Math.round(radius / 5)));
}

function fxglGauss(dst, srcTex, mid, radius) {
    const n = fxglKawaseIters(radius);
    const step = (2 * radius) / (n * (n + 1));
    fxglBox(mid, srcTex, step, step, n, false, 0);                     // down
    fxglBox(dst, mid.tex, step * (n - 1), -step, n, false, 1);         // up
}

function fxglSilGauss(radius) {
    const n = fxglKawaseIters(radius);
    const step = (2 * radius) / (n * (n + 1));
    fxglBox(fxgl.off[3], fxgl.off[2].tex, step, step, n, true, 0);        // down
    fxglBox(fxgl.off[4], fxgl.off[3].tex, step * (n - 1), -step, n, true, 1);   // up
}

// 画布坐标(0°=右、90°=下,y 向下增长)→ 纹理 UV(GL 的 y 向上,上传时已翻)。
function fxglDirUV(angleDeg, distance) {
    const a = angleDeg * Math.PI / 180;
    return { x: Math.cos(a) * distance, y: -Math.sin(a) * distance };
}

function fxHexToRgb01(hex) {
    let s = String(hex || '').replace('#', '').trim();
    if (s.length === 3) s = s.split('').map(c => c + c).join('');
    const v = parseInt(s, 16);
    if (!isFinite(v) || s.length !== 6) return [0, 0, 0];
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

// 就地跑完整条链,结果写回 surface。返回 false = 整链没跑(不支持 / 太大),surface 原样留着;
// fxgl.skip 带上原因,让状态栏能说清楚,而不是「特效静默地变成了没特效」。
function applyLayerEffects(l, surface) {
    const chain = activeEffects(l);
    fxgl.skip = '';
    if (!chain.length) return false;
    const gl = fxglInit();
    if (!gl) { fxgl.skip = fxgl.dead || 'WebGL2'; return false; }
    const w = surface.width, h = surface.height;
    if (!w || !h || !fxglResize(gl, w, h)) return false;

    fxglUploadCanvas(fxgl.texSrc, surface);
    fxgl.hasMask = 0;
    if (l.mask && l.mask.width === w && l.mask.height === h) {
        fxglUploadCanvas(fxgl.texMask, l.mask);
        fxgl.hasMask = 1;
    }
    // 色彩链恒定在 off[0]/off[1] 之间乒乓;起点是 texSrc 的一次恒等拷贝(uIter=0)。
    const col = { slot: 0 };
    fxglBox(fxgl.off[0], fxgl.texSrc, 0, 0, 0, false);
    for (const effect of chain) {
        const p = effectParams(effect);
        const spec = EFFECT_TYPES[effect.type];
        // 有些特效只在某个模式下才真吃贴图 (色调映射只在 External 读查找表),要不要像素由它自己
        // 报一句 —— 否则中性模式会因为「没绑图」被整条跳过,而那模式根本不需要图。
        if (spec.needsMap && (!spec.needsMapWhen || spec.needsMapWhen(p))) {
            const ref = fxMapRef(effect);
            const img = fxMapImage(ref);
            // 解析不出像素就跳过这一条 —— 拿一张黑图当深度图去打光,比不打光更糟。原因写在链上。
            if (!img) { fxgl.skip = `${spec.label}: ${ref ? 'map not ready' : 'no map bound'}`; continue; }
            const n = nativeSize(img);
            if (n.w > fxgl.maxTex || n.h > fxgl.maxTex) {
                fxgl.skip = `${spec.label}: map is ${n.w}×${n.h}, over the texture limit`;
                continue;
            }
            fxglUploadCanvas(fxgl.texMap, img);
        }
        // 跑不动的特效自己写 fxgl.skip (参数为 0 时直接原样返回),引擎只负责把贴图备好。
        // effect 一起传:绑定贴图的尺寸也是该特效的判断依据 (见 fx/tone_map.js 的布局识别)。
        spec.run(col, p, effect);
    }
    fxglRunPass(null, fxgl.progs.present, pr => fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0));
    const c2 = surface.getContext('2d');
    resetCtx(c2);
    c2.clearRect(0, 0, w, h);
    c2.drawImage(fxgl.canvas, 0, 0, w, h);
    return true;
}

// ---- 图层表面的缓存 ----
// 失效信号用 surface 的**对象身份**,不用版本号:笔刷下落笔前会 detachPaintSurface() 换上一份
// 私有副本,stretch/resample/crop/bake 也都是整体替换 l.mask / l.decal,所以身份就是脏标记。
// 拖 transform 时身份与参数签名都不变 → 命中缓存,特效链一帧都不会重跑。
// 文本层也吃这条恒等式,而且这不是偷懒:链跑在 syncTextBuffer 烘出的**盒子(=画布像素)分辨率**
// 缓冲上,特效结果和文字本身一样以显示分辨率光栅化,放大盒子绝不会糊。代价是 resize 帧缓冲换
// 身份、链会重跑 —— 只发生在挂着启用链的文字层上,而特效参数按画布像素计正是这里要的读法。
function fxResolved(l) {
    if (!l || !l.img) return l && l.img;
    if (!l.decal && !activeEffects(l).length) return l.img;
    const { w, h } = nativeSize(l.img);
    if (!w || !h) return l.img;
    const sig = fxSignature(l);
    const maps = fxMapStamp(l);
    const c = l.fxCache;
    if (c && c.w === w && c.h === h && c.img === l.img && c.decal === l.decal && c.mask === l.mask && c.sig === sig && c.maps === maps) return c.surface;
    const surface = document.createElement('canvas');
    surface.width = w;
    surface.height = h;
    const o = surface.getContext('2d');
    resetCtx(o);
    o.drawImage(l.img, 0, 0, w, h);
    if (l.decal) o.drawImage(l.decal, 0, 0, w, h);
    if (activeEffects(l).length) applyLayerEffects(l, surface);
    l.fxCache = { w, h, img: l.img, decal: l.decal, mask: l.mask, sig, maps, surface };
    return surface;
}
