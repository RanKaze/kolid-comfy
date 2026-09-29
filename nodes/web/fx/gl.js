// ---- WebGL2 engine ----
// 特效链的执行内核:缓冲/纹理、三份共享着色器、Kawase 低通原语、链的调度与表面缓存。
// 各类特效的着色器与 pass 不在这里 —— 它们在自己的 fx/<effect>.js 里注册进来 (见 core.js)。
// 2/3/4 号缓冲是「公共借用区」:silhouette 特效 (内/外阴影) 用它们存形状与虚化,描边用 3/4 做距离场
// 乒乓、景深与泛光用它们存低通档位、锈蚀在三张之间轮换闸门/噪声场/破洞掩码 —— 同一条链里这些面每趟
// 都重算,所以互不污染,一套五张缓冲的显存预算也就不会随特效种类增长。
// 五张离屏缓冲按当前图层尺寸复用:0/1 = 色彩乒乓,2 = silhouette 原样,3/4 = 借用乒乓。
// 图层之间尺寸通常一致,所以一帧里多个图层走特效也不会反复分配。
const FX_MAX_PIXELS = 12e6;              // 5 × RGBA16F ≈ 480 MB 的地板,超过就整链跳过并说明原因
const FX_KAWASE_MAX_ITER = 8;            // 着色器里那个常数次循环的上界
const fxgl = {
    gl: null, dead: '', skip: '', w: 0, h: 0, fmt: null, vao: null, maxTex: 0,
    off: [], texSrc: null, texMask: null, texMap: null, texMap2: null, texLut: null, progs: null, canvas: null, hasMask: 0, hasMap2: 0,
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
    for (const key of ['texSrc', 'texMask', 'texMap', 'texMap2', 'texLut']) {
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

// 借用面 (2/3/4) 之间的 alpha 低通,默认「形状 2 → 中转 3 → 结果 4」:内/外阴影的虚化、描边与锈蚀
// 的闸门都走这一条。一条链里想把别的中间量也糊一下 (锈蚀糊噪声场、糊破洞掩码) 就点名 src/mid/dst,
// 不必再写一份近似函数 —— 显存预算还是那五张面。
function fxglSilGauss(radius, src = 2, mid = 3, dst = 4) {
    const n = fxglKawaseIters(radius);
    const step = (2 * radius) / (n * (n + 1));
    fxglBox(fxgl.off[mid], fxgl.off[src].tex, step, step, n, true, 0);                     // down
    fxglBox(fxgl.off[dst], fxgl.off[mid].tex, step * (n - 1), -step, n, true, 1);          // up
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

// 这条链最近一次跑不动的原因,按**记录**存一份。fxgl.skip 是全工程唯一那份「最近一次跑链」的读数,
// 状态栏和 Apply 命令读它没问题,侧栏的容器不行:render 先把每个图层、每枚容器都折完,然后才建那批
// DOM,于是最晚跑过的那条链把话说到所有容器头上 —— 绑好了深度图的那块也会写上 "no depth map bound"。
// 键是记录对象本身 (条带上的记录跨 render 是同一个,见 fxResolved 拿面身份比缓存),层删了它就跟着没了。
const fxChainSkip = new WeakMap();
function fxChainSkipReason(r) { return (r && fxChainSkip.get(r)) || ''; }

// 就地跑一条链,结果写回 surface。返回 false = 整链没跑(不支持 / 太大),surface 原样留着;
// fxgl.skip 带上原因,让状态栏能说清楚,而不是「特效静默地变成了没特效」。
// `opts.rec` = 这一枚 Effects attribute 的记录 (读它自己那条链), `opts.mask` = 它左边那些蒙版与起来的
// 覆盖率。两个都不传 = 读图层上那三个老名字的最左边那一枚 (还没理解 strip 的调用点,见 attr/core.js)。
function applyLayerEffects(l, surface, opts) {
    const o = opts || {};
    const chain = o.rec ? activeEffects(l, o.rec) : activeEffects(l);
    const mask = ('mask' in o) ? o.mask : l.mask;
    fxgl.skip = '';
    if (o.rec) fxChainSkip.delete(o.rec);
    // 全局那句照旧写 (状态栏要的是「最近一次」),这一枚记录那句同时写进 fxChainSkip。
    const note = () => { if (o.rec && fxgl.skip) fxChainSkip.set(o.rec, fxgl.skip); };
    if (!chain.length) return false;
    const gl = fxglInit();
    if (!gl) { fxgl.skip = fxgl.dead || 'WebGL2'; note(); return false; }
    const w = surface.width, h = surface.height;
    if (!w || !h || !fxglResize(gl, w, h)) { note(); return false; }

    fxglUploadCanvas(fxgl.texSrc, surface);
    fxgl.hasMask = 0;
    if (mask && mask.width === w && mask.height === h) {
        fxglUploadCanvas(fxgl.texMask, mask);
        fxgl.hasMask = 1;
    }
    // 色彩链恒定在 off[0]/off[1] 之间乒乓;起点是 texSrc 的一次恒等拷贝(uIter=0)。
    const col = { slot: 0 };
    fxglBox(fxgl.off[0], fxgl.texSrc, 0, 0, 0, false);
    for (const effect of chain) {
        const p = effectParams(effect);
        const spec = EFFECT_TYPES[effect.type];
        // 槽位由注册数据声明 (见 fx/maps.js 的 fxMapSlots):主槽 params.map → texMap,副槽
        // spec.needsMap2 → texMap2。「这个模式要不要这张图」由该槽自己的 when 报一句 —— 否则中性
        // 模式会因为「没绑图」被整条跳过,而那模式根本不需要图。
        // 主槽解析不出像素就整条跳过:拿一张黑图当深度图去打光,比不打光更糟;副槽是可缺的,没绑
        // 就把 hasMap2 归零,由该特效自己退化成单图算法 (见 fx/warp.js 的几何)。
        // 原因一律写在链上 (fxgl.skip),不许静默。
        fxgl.hasMap2 = 0;
        let mapMiss = '';
        for (const slot of fxMapSlots(effect)) {
            if (slot.when && !slot.when(p)) continue;
            const ref = fxMapRef(effect, slot.key);
            const img = fxMapImage(ref);
            if (!img) {
                if (slot.optional) continue;
                // 说的是哪一张图 = 注册表里那个角色。泛写 "map" 在占两个槽的特效上说不清缺的是深度
                // 还是法线,而这条原因就写在链上,是用户唯一的线索。
                const nm = `${slot.role.toLowerCase()} map`;
                mapMiss = `${spec.label}: ${ref ? `${nm} not ready` : `no ${nm} bound`}`;
                break;
            }
            const n = nativeSize(img);
            if (n.w > fxgl.maxTex || n.h > fxgl.maxTex) {
                mapMiss = `${spec.label}: ${slot.role.toLowerCase()} map is ${n.w}×${n.h}, over the texture limit`;
                break;
            }
            fxglUploadCanvas(slot.key === 'map' ? fxgl.texMap : fxgl.texMap2, img);
            if (slot.key !== 'map') fxgl.hasMap2 = 1;
        }
        if (mapMiss) { fxgl.skip = mapMiss; note(); continue; }
        // 跑不动的特效自己写 fxgl.skip (参数为 0 时直接原样返回),引擎只负责把贴图备好。
        // effect 一起传:绑定贴图的尺寸也是该特效的判断依据 (见 fx/tone_map.js 的布局识别)。
        // l 也一起传:有的特效吃的几何是**图层盒子在画布上的位置**,不只是它自己的网格 (见 fx/warp.js 的深度)。
        spec.run(col, p, effect, l);
    }
    // 特效自己写在链上的那句也算这条记录的原因 (参数为 0 之类它自己决定不跑的情形)。
    note();
    fxglRunPass(null, fxgl.progs.present, pr => fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0));
    const c2 = surface.getContext('2d');
    resetCtx(c2);
    c2.clearRect(0, 0, w, h);
    c2.drawImage(fxgl.canvas, 0, 0, w, h);
    return true;
}

// ---- 图层表面的缓存 ----
// 失效信号用 surface 的**对象身份** + 一个**落笔代次**,不用版本号:笔刷下落笔前会 detachPaintSurface()
// 换上一份私有副本,stretch/resample/crop/bake 也都是整体替换那枚 attribute 的面,所以身份就是脏标记。
// 但身份只覆盖"换了对象":一笔之内的每一次 livePreviewStroke 都是**就地改写同一张 canvas**,起笔换过
// 一次身份之后,后面整笔都命中旧缓存 —— 画布上摆的是落笔第一点那刻的合成图,墨要等下一次按下才显形。
// 所以写表面的路径要 +1 那一枚 attribute 的 paintGen (画笔/橡皮走 livePreviewStroke,油漆桶自己 +1),
// 缓存键把条带上每一枚的代次都串进去 —— 见下面 fxResolved 的 gen。
// 代次不同而身份全同 = 只有墨变了 → 复用同一块缓存画布重画重跑,绝不新建 canvas:一笔几百帧就是一次
// 几百张画布的 GC。surface 只被这条缓存持有(快照存的是链的深拷贝,fxCache 从不进快照),接管它安全。
// 拖 transform 时身份、参数签名与代次都不变 → 命中缓存,特效链一帧都不会重跑 —— 这是绝大多数
// 特效想要的 (它们的输入只有像素与 params);真把画布几何当输入的特效 (Canvas 对齐的深度 warp) 靠
// spec.stamp 把那一句加进身份 (ext),否则它会钉在挪之前烘好的那份位移上。
// 文本层也吃这条恒等式,而且这不是偷懒:链跑在 syncTextBuffer 烘出的**盒子(=画布像素)分辨率**
// 缓冲上,特效结果和文字本身一样以显示分辨率光栅化,放大盒子绝不会糊。代价是 resize 帧缓冲换
// 身份、链会重跑 —— 只发生在挂着启用链的文字层上,而特效参数按画布像素计正是这里要的读法。

const FX_CUT_ALL = () => true;

// 这枚 attribute 会在折叠出来的那张面上留下像素吗:空面 = 没装 (attr/core.js 的规矩三),空链 / 全旁路
// = 不跑,而 cut 说了算的那些蒙版这一趟只当 silhouette 喂给右边的链,不当剪刀。
function attrInks(r, l, i, cut) {
    if (r.chain) return activeEffects(l, r).length > 0;
    if (!r.surface || !r.surface.width || !r.surface.height) return false;
    return cut(r, i);
}

// 分界线落在**最后一条会跑的链**上 (不是最后一枚做事的 attribute —— 贴片与蒙版本来就归后端重放)。
function lastChainIndex(l, recs) {
    for (let i = recs.length - 1; i >= 0; i--) if (recs[i].chain && activeEffects(l, recs[i]).length) return i;
    return -1;
}

function sameFaces(a, b) {
    return a.length === b.length && a.every((f, i) => f === b[i]);
}

// 把几张蒙版与成一张 (alpha 逐像素相乘),画进这块借用画布并归到 (w,h)。
let fxMaskCov = null;
function fxAndInto(masks, w, h) {
    if (!fxMaskCov) fxMaskCov = document.createElement('canvas');
    if (fxMaskCov.width !== w || fxMaskCov.height !== h) { fxMaskCov.width = w; fxMaskCov.height = h; }
    const o = fxMaskCov.getContext('2d');
    resetCtx(o);
    o.clearRect(0, 0, w, h);
    o.drawImage(masks[0], 0, 0, w, h);
    for (let i = 1; i < masks.length; i++) {
        o.globalCompositeOperation = 'destination-in';
        o.drawImage(masks[i], 0, 0, w, h);
        o.globalCompositeOperation = 'source-over';
    }
    return fxMaskCov;
}

// silhouette 用的那张覆盖率。尺寸与图层网格对不上的蒙版不参与 —— 沿用 applyLayerEffects 那条
// 「贴图必须与网格同尺寸」的老规矩;一张都不剩就当纯白 (hasMask=0);只有一张就把原面交出去,
// 不占那块借用画布。
function stripCoverage(masks, w, h) {
    const fit = masks.filter(s => s.width === w && s.height === h);
    if (!fit.length) return null;
    return fit.length === 1 ? fit[0] : fxAndInto(fit, w, h);
}

// ---- 条带折叠 (the fold) ----
// 图层表面 = 最左那枚隐式面 (base,通常是 l.img,空白层是噪声) + 条带上从左到右每一枚 attribute。
// 规矩全在这一个循环里:
//   · decal 用 source-over 叠上去,蒙版用 destination-in 裁,各按**自己那个位置**发生,不再有谁是固定的
//     前一步或后一步 (所以 `Mask·Decal` 与 `Decal·Mask` 是两张不同的图:后者贴片的墨会被裁掉)。
//   · 每一枚蒙版同时是**它右边所有链**的 silhouette:一路攒着,交给下一条真跑的链与成的那张覆盖率。
//     注意是"它左边的全部",不是"距上一条链以来的那几枚" —— `Mask·Effects·Effects` 里两条链读同一张图。
//   · cut(r, i) 说这枚蒙版在这一趟里裁不裁。后端那两条通道把「最后一条启用链右边」的蒙版留给后端乘
//     (见 fxSplitForBackend / fxSurfaceForGenerate),前端这一趟就不能替它乘掉。
// 返回 false = 整趟没跑 (这层没什么可折的),surface 归调用方自己画。
function fxDropStrip(l, surface, base, thru, cut) {
    const recs = attrRecordsOf(l);
    const n = thru < 0 ? recs.length : Math.min(thru + 1, recs.length);
    if (!recs.some((r, i) => i < n && attrInks(r, l, i, cut))) return false;
    const w = surface.width, h = surface.height;
    const o = surface.getContext('2d');
    resetCtx(o);
    o.clearRect(0, 0, w, h);
    if (base) o.drawImage(base, 0, 0, w, h);
    const left = [];              // 这条链左边那些蒙版 (与起来才是它的 silhouette)
    for (let i = 0; i < n; i++) {
        const r = recs[i];
        if (r.chain) {
            if (!activeEffects(l, r).length) continue;
            const prevSkip = fxgl.skip;         // 一条链跑不动不许盖掉前一条已经报过的原因
            applyLayerEffects(l, surface, { rec: r, mask: stripCoverage(left, w, h) });
            fxgl.skip = prevSkip || fxgl.skip;
            continue;
        }
        const s = r.surface;
        if (!s || !s.width || !s.height) continue;
        if (r.type === 'mask') {
            left.push(s);
            if (!cut(r, i)) continue;
        }
        o.globalCompositeOperation = r.type === 'mask' ? 'destination-in' : 'source-over';
        o.drawImage(s, 0, 0, w, h);
        o.globalCompositeOperation = 'source-over';
    }
    return true;
}

function fxScratch(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
}

// 画面那一趟:整条折完,蒙版一律裁。结果就是画布要盖的那张图,所以它带缓存 (注释见上)。
function fxResolved(l) {
    if (!l || !l.img) return l && l.img;
    const { w, h } = nativeSize(l.img);
    if (!w || !h) return l.img;
    const recs = attrRecordsOf(l);
    // 纯像素层 (条带空着,或只挂了空蒙版) 每帧都走到这里就收工:签名与贴图戳一次都不算。
    if (!recs.some((r, i) => attrInks(r, l, i, FX_CUT_ALL))) return l.img;
    const sig = fxSignature(l);
    const maps = fxMapStamp(l);
    const ext = fxExternalStamp(l);
    // 落笔代次 = 图层自己那份像素的 + 条带上**每一枚面**的。共享的一面被别的层落一笔时,这一层的
    // l.paintGen 一动不动,而它这一串里的那一格变了 —— 只看图层自己就会把这层钉在旧结果上。
    const gen = (l.paintGen | 0) + attrPaintGens(l);
    const faces = recs.map(r => r.surface || null);
    const c = l.fxCache;
    if (c && c.w === w && c.h === h && c.img === l.img && sameFaces(c.faces, faces)
        && c.sig === sig && c.maps === maps && c.ext === ext && c.gen === gen) return c.surface;
    const reuse = !!(c && c.w === w && c.h === h && c.surface);
    const surface = reuse ? c.surface : fxScratch(w, h);
    if (!fxDropStrip(l, surface, l.img, -1, FX_CUT_ALL)) return l.img;
    l.fxCache = { w, h, img: l.img, faces, sig, maps, ext, gen, surface };
    // 命中缓存时 surface 是**同一块画布原地重画**的,身份键察觉不到「这一层现在长这样了」。Stash 层
    // 要认这一点 (它抄的是以下所有层的合成图),所以每重算一次就换一个代次 —— 见 blend_node.html 的
    // stashLayerKey。只有走了缓存路径 (条带上真有事) 的层才需要它:纯像素层的输入就是那张 img。
    l.fxResolveGen = (l.fxResolveGen | 0) + 1;
    return surface;
}

// ---- 后端分界 (the split) ----
// 链只有 WebGL 跑得动,所以「前端烘到哪、后端重放从哪起」这条线只能落在**最后一条启用的链**上:
// 它左边 (含) 由前端折成一张结算面,它右边的 decal 与蒙版按序交给 Python 重放。默认那条
// `Decal·Effects·Mask` 于是与这个功能出现之前逐像素相同 —— 贴片和链烘进 src,蒙版仍原样送出。
// 折不出新面时 surface 就是 l.img 本身,调用方据此决定能不能走 l.src 那条免重编码的快路。
function fxSplitForBackend(l) {
    const recs = attrRecordsOf(l);
    const thru = lastChainIndex(l, recs);
    if (thru < 0) return { surface: l.img, rest: recs };
    const { w, h } = nativeSize(l.img);
    const surface = fxScratch(w, h);
    if (!fxDropStrip(l, surface, l.img, thru, FX_CUT_ALL)) return { surface: l.img, rest: recs };
    return { surface, rest: recs.slice(thru + 1) };
}

// Generate 那张图:整条折完,但**留给后端的那几枚蒙版不裁**。蒙版是覆盖率而不是剪刀时,后端还要乘
// 一次;递一张已经裁过的图过去等于乘两次,而且模型会看见一个自己没挖的洞。
// `base` 换掉最左那枚隐式面 —— 空白图层送出去的是噪声,链得跑在噪声上而不是跑在空的 img 上。
// 没有任何 attribute 做事时返回 null:调用方宁可发原始 l.src,也别白白重编码一张同图。
function fxSurfaceForGenerate(l, base) {
    if (!l || !l.img) return null;
    const recs = attrRecordsOf(l);
    const thru = lastChainIndex(l, recs);
    const cut = (r, i) => r.type !== 'mask' || i <= thru;
    const { w, h } = nativeSize(base || l.img);
    if (!w || !h) return null;
    const surface = fxScratch(w, h);
    if (!fxDropStrip(l, surface, base || l.img, -1, cut)) return null;
    return surface;
}

// 后端那一次乘法该乘的是哪些蒙版:最后一条启用链**右边**的那些,全与起来。一条都不剩 = 前端已经
// 裁进结算面了,后端乘全白 (调用方那侧的合成全白就是这个意思)。
// 这里不按网格尺寸筛:蒙版本来就是按各自尺寸发过去、由后端 resample 的,筛掉会把一张画歪的蒙版
// 变成「没有蒙版」。
function fxDistributedMask(l, w, h) {
    const recs = attrRecordsOf(l);
    const thru = lastChainIndex(l, recs);
    const list = [];
    for (let i = thru + 1; i < recs.length; i++) {
        const s = recs[i].type === 'mask' ? recs[i].surface : null;
        if (s && s.width && s.height) list.push(s);
    }
    if (!list.length) return null;
    return list.length === 1 ? list[0] : fxAndInto(list, w, h);
}
