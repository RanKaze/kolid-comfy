// ==================== RenderPlan 合成器（P2 第一步：2D 采样）====================
// 吃 RenderPlan（docs/render_plan.md），输出一张画布。它不知道编辑器、不知道播放器、
// 不知道"台上是谁" —— 只做 Frame(plan, t)。
//
// 这一步**故意**还是 canvas 2D：与旧路径同一条采样路径 ⇒ 与 golden 必须 maxdiff 0（§5.3 第一行）。
// 第二步把这里的 drawImage 换成 GL 预乘混合（tests/gl_equiv 的结论：边缘外 maxdiff 2，边缘 1px 覆盖差）。
//
// 三条规矩照抄契约：
//   · layers 自底向上（plan 里已经是这个顺序，这里不再反转）
//   · strip 折叠 = 底像素 + 从左到右每一步（decal 叠、mask 裁、chain 跑特效）
//   · （`capture:'below'` 那一格随旧 Stash **图层**一起删了 —— 它说的是"输入是此刻画布上已经有的
//     东西，不是自己的底像素"。Stash 现在是条带上一枚普通的面，那一句话不再是合成的分支。）
const KCompositor = (function () {
    const api = {
        /** uri → canvas/Image/Video（已加载的资源）。没加载返回 null。 */
        resource: null,
        /** (trackId, t) → 该轨这一刻的帧。null = 还没解出来。 */
        frame: null,
        /** 兜底：(planLayer, stepIndex, step) → 一张现成的面（页面内适配用；P2 第一步靠它）。 */
        bind: null,
        /** P3.1 笔刷纹理：`(planLayer, t, w, h) → {tex, mask?}` 或 null。命中就直接贴纹理，
         *  连 2D 折叠都不跑 —— 编辑一笔之后，下一帧合成看到的就是那张纹理。 */
        layerTexture: null,
        /** 这一趟被跳过了什么（诊断；不参与画）。 */
        notes: [],
        /** 这一趟的记账（P3.1 验收用）：items = 贴了几张面，texItems = 其中几张贴的是纹理，
         *  upload = 画布进纹理的次数。链结果走纹理时，同一次合成里的 upload 应该少一层。 */
        stats: { items: 0, texItems: 0, upload: 0 },
    };

    function blank(w, h) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        return c;
    }

    /** 把任意源铺成图层网格尺寸的一张面（与 fxDropStrip 的 drawImage(s,0,0,w,h) 同口径）。 */
    function flatten(src, w, h) {
        if (!src) return null;
        const sw = src.naturalWidth || src.videoWidth || src.width || 0;
        const sh = src.naturalHeight || src.videoHeight || src.height || 0;
        if (!sw || !sh) return null;
        if (sw === w && sh === h && src.tagName !== 'VIDEO') return src;   // 已经是这张网格：直接用
        const c = blank(w, h);
        try { c.getContext('2d').drawImage(src, 0, 0, w, h); } catch (e) { return null; }
        return c;
    }

    /** contain：短边贴满、多出来的两边透明 —— 视频帧进面 attribute 就这条规格
     *  （见 blend_node.html 的 drawVidFrameContain；与"资源面直接拉伸"是两件事，别混）。 */
    function contain(src, w, h) {
        if (!src) return null;
        const sw = src.naturalWidth || src.videoWidth || src.width || 0;
        const sh = src.naturalHeight || src.videoHeight || src.height || 0;
        if (!sw || !sh) return null;
        const c = blank(w, h);
        const g = c.getContext('2d');
        const k = Math.min(w / sw, h / sh);
        const dw = Math.max(1, sw * k), dh = Math.max(1, sh * k);
        try { g.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh); } catch (e) { return null; }
        return c;
    }

    /** 某一步的"面"：frameTrack（视频帧，contain）优先，其次资源（拉伸），最后交给 bind 兜底。 */
    function faceOf(pl, i, st, t, w, h) {
        if (st.frameTrack && api.frame) {
            const fr = api.frame(st.frameTrack, t);
            if (fr) return contain(fr, w, h);
        }
        let src = null;
        if (st.surface && st.surface.resource && api.resource) src = api.resource(st.surface.resource);
        if (!src && api.bind) src = api.bind(pl, i, st);
        return flatten(src, w, h);
    }

    /**
     * 折叠一层 → `{ src }`（一张面）或 `{ tex, mask }`（纹理，P3.1 的出口）。
     * 语义逐条对齐 fxDropStrip（fx/gl.js）：
     *   · 每一枚蒙版都是它**右边所有链**的 silhouette（一路攒着）；
     *   · 蒙版按 destination-in 裁，decal 按 source-over 叠；
     *   · 整趟没有墨 ⇒ 就是底像素本身（fxResolved 的早退）。
     *
     * `texOK` = 这一层允许把链的结果留在纹理上（见 render 里的判据）。只有"最后一个出墨的步骤就是
     * 那条链"时才能走 —— 链后面若还有 decal/生成器，就得回到 2D 画上去，那时纹理意味着又一次 readback。
     * 链后面的**蒙版**例外：它是 alpha 乘，合成着色器里一句话（与 2D 的 destination-in 同义）。
     */
    function foldLayer(pl, t, w, h, texOK, texKey) {
        // 一笔正在纹理里（P3.1）：这一层的结果已经折好，直接交纹理。
        // （Stash 曾经是这里的例外 —— 它的输入是「以下所有层」，不在这一笔的纹理里。那一岔随图层
        //  种类一起删了：现在它的输入就是它自己那枚面，跟一张贴片没有区别。）
        if (texOK && api.layerTexture) {
            try {
                const lt = api.layerTexture(pl, t, w, h);
                if (lt && lt.tex) return { tex: lt.tex, mask: lt.mask || null };
            } catch (e) {
                api.notes.push('layer texture failed: ' + (e && e.message || e));
            }
        }
        const strip = pl.strip || [];
        // 最后一个"会出墨的链"。跟 fxLastChainIndex 的判据同义，只是作用在 plan 的 strip 上。
        let chIdx = -1;
        if (texOK) {
            for (let i = strip.length - 1; i >= 0; i--) {
                const st = strip[i];
                if (!st || st.enabled === false || st.kind !== 'chain') continue;
                if ((st.chain || []).some(e => e && e.enabled !== false)) { chIdx = i; break; }
            }
            for (let i = chIdx + 1; chIdx >= 0 && i < strip.length; i++) {
                const st = strip[i];
                if (!st || st.enabled === false) continue;
                if (st.kind === 'surface' && st.type === 'mask') continue;
                chIdx = -1; break;                       // 链后还有别的墨 ⇒ 这一层走 canvas
            }
        }
        const base = (pl.base && pl.base.resource && api.resource) ? api.resource(pl.base.resource) : null;
        const surf = blank(w, h);
        const g = surf.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
        g.clearRect(0, 0, w, h);
        if (base) {
            try { g.drawImage(base, 0, 0, w, h); } catch (e) { /* 底像素没就绪：当空白 */ }
        }
        // 引擎那一侧要一个"像图层"的东西（特效读 l.transform 算画布落点）
        const fake = {
            id: pl.id, name: pl.name, img: base || surf,
            transform: pl.transform || { cx: 0.5, cy: 0.5, w: 1, h: 1, rotation: 0 },
            paintGen: 0, fxCache: null,
        };
        const left = [];
        const post = [];                                  // 链右边的蒙版：等结果成了纹理再乘
        let tex = null;
        let inked = false;
        for (let i = 0; i < strip.length; i++) {
            const st = strip[i];
            if (!st || st.enabled === false) continue;
            if (st.kind === 'chain') {
                const chain = (st.chain || []).filter(e => e && e.enabled !== false);
                if (!chain.length) continue;
                const mask = stripCoverage(left, w, h);
                if (i === chIdx) {
                    try {
                        // `texKey` = 这张结果纹理在发布区里占固定那一页（按图层）。调用方要跨帧缓存
                        // 纹理时**必须**给：pool 的"取一张"会被下一层覆盖，缓存下来的就成了别人的图。
                        tex = applyLayerEffectsTexture(fake, surf, { rec: { chain }, mask, slotKey: texKey });
                    } catch (e) {
                        api.notes.push('chain failed: ' + (e && e.message || e));
                        tex = null;
                    }
                    if (tex) { inked = true; continue; }
                    chIdx = -1;                           // 没跑（不支持/太大）⇒ 后面照 2D 来
                }
                try {
                    applyLayerEffects(fake, surf, { rec: { chain }, mask });
                } catch (e) {
                    api.notes.push('chain failed: ' + (e && e.message || e));
                }
                inked = true;
                continue;
            }
            if (st.kind === 'surface') {
                const cv = faceOf(pl, i, st, t, w, h);
                if (!cv) { api.notes.push('missing face: ' + st.type); continue; }
                if (tex && st.type === 'mask') { post.push(cv); inked = true; continue; }
                if (st.type === 'mask') {
                    left.push(cv);
                    g.globalCompositeOperation = 'destination-in';
                } else {
                    g.globalCompositeOperation = 'source-over';
                }
                try { g.drawImage(cv, 0, 0, w, h); } catch (e) { /* 跳过这一枚 */ }
                g.globalCompositeOperation = 'source-over';
                inked = true;
                continue;
            }
            // generator（文字/方向/3D/pose/几何）：先认烘焙好的面；页面能现算（syncGeneratorFaces）
            // 就给 bind 一张 —— 这类面在页面上根本没有"资源 id"，只有资源表会把它们漏掉。
            if (st.kind === 'generator') {
                let baked = st.baked && st.baked.resource && api.resource ? api.resource(st.baked.resource) : null;
                if (!baked && api.bind) baked = api.bind(pl, i, st);
                if (!baked) { api.notes.push('generator not baked: ' + st.type); continue; }
                const cv = flatten(baked, w, h);
                if (!cv) continue;
                g.globalCompositeOperation = 'source-over';
                g.drawImage(cv, 0, 0, w, h);
                inked = true;
            }
        }
        if (tex) {
            const cov = post.length ? stripCoverage(post, w, h) : null;
            return { tex: tex.tex, mask: cov };
        }
        return { src: inked ? surf : (base ? flatten(base, w, h) : surf) };
    }

    /** 与 drawLayer 逐字一致：translate(cx·W, cy·H) · rotate · drawImage(-tw/2,-th/2,tw,th)。
     *  opacity（0..1，缺省 1）是图层整体不透明度 —— 与 GL 那边的 uAlpha 同一个语义。 */
    function drawTransformed(ctx, src, tr, w, h, opacity) {
        const t = tr || {};
        const cx = t.cx === undefined ? 0.5 : t.cx;
        const cy = t.cy === undefined ? 0.5 : t.cy;
        const ww = t.w === undefined ? 1 : t.w;
        const hh = t.h === undefined ? 1 : t.h;
        const rot = t.rotation || 0;
        const a = (opacity === undefined || opacity === null) ? 1 : Math.min(1, Math.max(0, opacity));
        if (a <= 0) return;
        const tw = ww * w, th = hh * h;
        ctx.save();
        ctx.globalAlpha *= a;
        ctx.translate(cx * w, cy * h);
        ctx.rotate(rot);
        ctx.drawImage(src, -tw / 2, -th / 2, tw, th);
        ctx.restore();
    }

    // ── GL 混合（P2 第二步 / P3.1 纹理入口）──────────────────────────────────────────────────
    // 目的：层的叠加不再走 canvas 2D，而是在**一个** GL 上下文里按预乘直接混（ONE / ONE_MINUS_SRC_ALPHA）。
    // 取帧/折叠仍由上面的代码出 canvas（fx 链还是那条），这里负责"把面按矩阵贴上去、按序混"。
    // P3.1 起这一套**可以借 fx/gl.js 那台上下文**：链的结果只在它自己的上下文里是同一张纹理，
    // 所以"链跑完不回读"这件事只有搬进去做才成立（见 foldLayer 的 tex 出口与 render 的 stage）。
    // 与 2D 的差异只允许出现在几何边缘 1px（实测边缘外 maxdiff 2，见 tests/gl_equiv 与契约 §5.4）。
    const VS = `#version 300 es
in vec2 aPos; in vec2 aUV; out vec2 vUV;
uniform vec2 uRes; uniform vec2 uC; uniform vec2 uSize; uniform float uRot; uniform int uFill;
void main() {
  if (uFill == 1) {                      // 铺满（source 形态）：quad 直接覆盖整幅
    vUV = aPos + 0.5;
    gl_Position = vec4(aPos.x * 2.0, -aPos.y * 2.0, 0.0, 1.0);
    return;
  }
  vec2 p = aPos * uSize;                 // 以图层尺寸为单位，中心在原点
  float s = sin(uRot), c = cos(uRot);
  vec2 r = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  vec2 px = uC + r;                      // 画布像素坐标
  gl_Position = vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);
  vUV = aUV;
}`;
    // uMaskOn = 1 时把 alpha 乘上蒙版 —— 就是 2D 的 destination-in，只是发生在预乘域（两边的面色
    // 都已经预乘，所以乘 alpha 等价于 rgb 与 a 一起乘）。
    // uFlip = 1 用于**引擎那台上下文的纹理**：canvas 上传（FLIP_Y 关）是「v=0 在图上边」，而 FX 的
    // 离屏面是「v=1 在图上边」（fxglUploadCanvas 开了 FLIP_Y，整条链一直在这个朝向里算）。同一张面
    // 两种朝向，取样时按来源翻一次；蒙版永远来自画布，不翻。（同契约 §10.4 第 4 条。）
    const FS = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 Frag;
uniform sampler2D uSrc; uniform sampler2D uMask; uniform int uMaskOn; uniform int uFlip; uniform float uAlpha;
void main() {
  vec2 uv = uFlip == 1 ? vec2(vUV.x, 1.0 - vUV.y) : vUV;
  vec4 c = texture(uSrc, uv);
  if (uMaskOn == 1) c = c * texture(uMask, vUV).a;
  Frag = c * uAlpha;
}`;

    // 每个**上下文**一份 GL 状态（不是每块画布）：借来的上下文里画不变量跟自建的一模一样，
    // 只是那块画布归别人。自建上下文时 `canvas` 就是内部那块离屏，`preserveDrawingBuffer` 只为了
    // 导出/截图能取到像素。
    /** 一张空纹理（LINEAR + CLAMP，与画面贴图同一套采样参数）。 */
    function mkTexture(gl) {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
    }

    const glStates = new WeakMap();
    const glOffscreen = { c: null };
    function glStateFor(gl, canvas) {
        let st = glStates.get(gl);
        if (st !== undefined) return st;
        const sh = (t, src) => {
            const o = gl.createShader(t); gl.shaderSource(o, src); gl.compileShader(o);
            if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o));
            return o;
        };
        const prog = gl.createProgram();
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { glStates.set(gl, false); return false; }
        gl.useProgram(prog);
        // 自己的 VAO：借上下文时（fxgl）对方会 bind 它自己那只且不还原，靠默认 VAO 就会串味。
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        // 两种几何都用同一组 6 个顶点（uv 与 pos 同构，单位方块的四个角）
        const quad = new Float32Array([
            -0.5, -0.5, 0, 0, 0.5, -0.5, 1, 0, 0.5, 0.5, 1, 1,
            -0.5, -0.5, 0, 0, 0.5, 0.5, 1, 1, -0.5, 0.5, 0, 1,
        ]);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
        const aPos = gl.getAttribLocation(prog, 'aPos'), aUV = gl.getAttribLocation(prog, 'aUV');
        gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(aUV); gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8);
        gl.bindVertexArray(null);
        // 两张常备纹理：0 = 这一项的源（画布要上传/纹理直接绑），1 = 蒙版。
        const state = { c: canvas, gl, prog, vao, buf, tex: mkTexture(gl), mtex: mkTexture(gl),
            // 源纹理缓存：同一张画布 + 同一份内容身份（items 里的 `gen`）⇒ 不再上传。
            // 播放一层带关键帧的段时一帧要贴好几张面（源帧、每条链的结果、Stash 抄的那张），其中
            // **只有真变了的那一张**需要 texImage2D —— 剩下的整幅上传是纯烧（832×1216 一张 ~3ms，
            // 30 包/秒就是十几毫秒/帧）。`gen` 缺席 ⇒ 老规矩每次上传（不会贴旧图）。
            srcTex: new Map(), srcTexUse: 0, loc: {
            uRes: gl.getUniformLocation(prog, 'uRes'), uC: gl.getUniformLocation(prog, 'uC'),
            uSize: gl.getUniformLocation(prog, 'uSize'), uRot: gl.getUniformLocation(prog, 'uRot'),
            uFill: gl.getUniformLocation(prog, 'uFill'), uSrc: gl.getUniformLocation(prog, 'uSrc'),
            uMask: gl.getUniformLocation(prog, 'uMask'), uMaskOn: gl.getUniformLocation(prog, 'uMaskOn'),
            uFlip: gl.getUniformLocation(prog, 'uFlip'), uAlpha: gl.getUniformLocation(prog, 'uAlpha'),
        } };
        glStates.set(gl, state);
        return state;
    }

    // 源纹理缓存上限：足够装下"工作栈 + guidance 栈 + 几张链结果"，再多的按最久没用淘汰
    // （纹理是 GL 对象，不淘汰就是泄漏；上限也让这张表永远不随画过的画布数增长）。
    const TEX_CACHE_MAX = 12;
    /** 这台上下文里"这张源画布、这份内容"的纹理。`gen` 一致 = 像素没换过 ⇒ 复用。 */
    function texForSource(st, it) {
        const gl = st.gl, src = it.src;
        const gen = it.gen === undefined ? null : it.gen;
        if (gen === null) {
            // 调用方没给内容身份：老规矩，每次上传进那只共享纹理（绝不贴旧图）。
            gl.bindTexture(gl.TEXTURE_2D, st.tex);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !it.premul);
            try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); }
            catch (e) { return null; }
            api.stats.upload++;
            return st.tex;
        }
        // <video> 的 width/height 是 HTML 属性（未设置即 0），画面尺寸在 videoWidth/Height ——
        // 与 vidFrameSizeOf 同一条读法。gen 缓存的验证键必须用**真画面尺寸**：用属性尺寸会把
        // 视频源当空（!w）整条跳过 —— 台上那一帧直接没了。
        const w = (src.videoWidth || src.width) | 0, h = (src.videoHeight || src.height) | 0;
        if (!w || !h) return null;
        const pre = it.premul ? 1 : 0;
        let ent = st.srcTex.get(src);
        if (ent && ent.gen === gen && ent.pre === pre && ent.w === w && ent.h === h) {
            ent.use = ++st.srcTexUse;
            return ent.tex;
        }
        if (!ent) {
            if (st.srcTex.size >= TEX_CACHE_MAX) {
                let oldest = 0, at = Infinity;
                for (const [k, v] of st.srcTex) if (v.use < at) { at = v.use; oldest = k; }
                if (oldest) { gl.deleteTexture(st.srcTex.get(oldest).tex); st.srcTex.delete(oldest); }
            }
            ent = { tex: mkTexture(gl), gen: null, pre: -1, w: 0, h: 0, use: 0 };
            st.srcTex.set(src, ent);
        }
        ent.use = ++st.srcTexUse;
        gl.bindTexture(gl.TEXTURE_2D, ent.tex);
        // `premul` 在**上传那一刻**就烘进纹理（见下面 doc 注释）：同一张画布被要求换一种预乘读法时，
        // 身份里必须带上它，否则会拿上一次的读法去贴。
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !it.premul);
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); }
        catch (e) { gl.deleteTexture(ent.tex); st.srcTex.delete(src); return null; }
        api.stats.upload++;
        ent.gen = gen; ent.pre = pre; ent.w = w; ent.h = h;
        return ent.tex;
    }

    /**
     * items（自底向上）：
     *   · `{ src, transform }` —— 一张画布/图片/视频，这里上传成纹理再贴；
     *   · `{ tex, mask, transform }` —— **上下文里已有的纹理**（fx 链的结果，P3.1），不上传；
     *     `mask` 是再乘一次的覆盖率画布（链右边的蒙版）。
     * `transform = null` 表示铺满画布。返回承托结果的那块画布。
     * `target`：null = 内部离屏；一块 canvas = 自建上下文画到它上面；`{ gl, canvas, clear? }` = 借这台
     * 上下文（`clear === false` 表示在已有内容上继续叠，用于「工作栈 + guidance」两趟）。
     */
    function compositeGL(items, w, h, target) {
        const ext = !!(target && target.gl);
        let gl, c;
        if (ext) { gl = target.gl; c = target.canvas; }
        else {
            c = target || (glOffscreen.c || (glOffscreen.c = document.createElement('canvas')));
            gl = c.getContext('webgl2', { premultipliedAlpha: true, antialias: false, alpha: true,
                                           preserveDrawingBuffer: true });
            if (!gl) return null;
        }
        const st = glStateFor(gl, c);
        if (!st) return null;
        const { tex, mtex, loc } = st;
        if (c.width !== w) c.width = w;
        if (c.height !== h) c.height = h;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, w, h);
        if (!(target && target.clear === false)) {
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }
        gl.useProgram(st.prog);
        gl.bindVertexArray(st.vao);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);      // 预乘混合（与 canvas 2D 内部一致）
        gl.uniform2f(loc.uRes, w, h);
        gl.uniform1i(loc.uSrc, 0);
        gl.uniform1i(loc.uMask, 1);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, mtex);
        gl.uniform1i(loc.uMaskOn, 0);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);      // fxgl 会把它开开关关，借上下文要自己钉住
        for (const it of items) {
            if (!it) continue;
            gl.activeTexture(gl.TEXTURE0);
            if (it.tex) {
                gl.bindTexture(gl.TEXTURE_2D, it.tex);      // 已经是预乘、已经在这台上下文里
            } else if (it.src) {
                // 带上 `gen`（= 这张源的像素没换过的证明）时走缓存：没变过就不再 texImage2D。
                const t = texForSource(st, it);
                if (!t) continue;
                gl.bindTexture(gl.TEXTURE_2D, t);
            } else continue;
            if (it.mask) {
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, mtex);
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);   // 蒙版永远来自画布
                try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, it.mask); }
                catch (e) { /* 蒙版坏了就当没有 */ }
                gl.uniform1i(loc.uMaskOn, 1);
                gl.activeTexture(gl.TEXTURE0);
            } else {
                gl.uniform1i(loc.uMaskOn, 0);
            }
            api.stats.items++;
            if (it.tex) api.stats.texItems++;
            gl.uniform1i(loc.uFlip, it.tex ? 1 : 0);
            // 图层整体不透明度：预乘域里乘一次 alpha 就等于 canvas 2D 的 globalAlpha。
            gl.uniform1f(loc.uAlpha, (it.opacity === undefined || it.opacity === null) ? 1
                : Math.min(1, Math.max(0, it.opacity)));
            if (!it.transform) {
                gl.uniform1i(loc.uFill, 1);
            } else {
                const tr = it.transform;
                gl.uniform1i(loc.uFill, 0);
                gl.uniform2f(loc.uC, (tr.cx === undefined ? 0.5 : tr.cx) * w,
                                       (tr.cy === undefined ? 0.5 : tr.cy) * h);
                gl.uniform2f(loc.uSize, (tr.w === undefined ? 1 : tr.w) * w,
                                         (tr.h === undefined ? 1 : tr.h) * h);
                gl.uniform1f(loc.uRot, tr.rotation || 0);
            }
            gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
        gl.disable(gl.BLEND);           // 借上下文时把状态还原干净（fxgl 的每一趟都是覆盖写）
        // 借的是 fx/gl.js 那台上下文：把 pixelStore 还原成它的口径（上传直通 alpha 的面），
        // 否则下一次 fxglUploadCanvas 会把画布预乘一次，链/笔刷就吃到二次预乘。
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.finish();
        return c;
    }

    /**
     * Frame(plan, t) → target（一块 canvas）。纯函数：同样的 (plan, t, 资源) 必得同样的像素。
     * `stack` 可以只要 'work'（默认）或 'guidance'（GuidanceFrame 是 work + guidance 叠在一起，
     * 由调用方决定画到哪块）。
     */
    function render(plan, t, target, opts) {
        const o = opts || {};
        const w = (plan.grid && plan.grid.w) | 0;
        const h = (plan.grid && plan.grid.h) | 0;
        if (!w || !h) return null;
        const cv = target || blank(w, h);
        if (cv.width !== w) cv.width = w;
        if (cv.height !== h) cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, w, h);
        api.notes.length = 0;
        api.stats.items = api.stats.texItems = api.stats.upload = 0;
        // 形态（契约 §2.3.1）：source = 这一帧就是那条轨的视频帧（拉伸铺满，与底片态一致）；
        // layers = 图层合成，底片不参与。两者互斥 —— 别把视频叠到图层下面。
        const fr = plan.frame || {};
        const items = [];
        const useGL = o.backend === 'gl';
        if (fr.mode === 'source') {
            const src = (fr.source && fr.source.trackId && api.frame) ? api.frame(fr.source.trackId, t) : null;
            if (!src) {
                api.notes.push('source frame missing: ' + ((fr.source || {}).trackId || '-'));
                return cv;
            }
            items.push({ src, transform: null });          // 铺满（与底片态的拉伸一致）
        } else {
            const want = o.stack || 'work';
            const stack = (plan.layers || []).filter(pl => pl && pl.visible !== false && (pl.stack || 'work') === want);
            // 纹理入口（P3.1）的前提：GL 合成、且**不往外部画布直出** —— 链的结果纹理只在 fx/gl.js 那台
            // 上下文里是同一张，所以整趟合成也搬进去做（fxglStageSize 同时把发布区开新一页）。
            // 借不到那台上下文（没有 WebGL2）就一个 tex 都不出，与 P2 一模一样。
            const stage = (useGL && !o.glTarget && typeof fxglStageSize === 'function')
                ? fxglStageSize(w, h) : null;
            for (let i = 0; i < stack.length; i++) {
                const pl = stack[i];
                // `below` 那一格随旧 Stash 图层一起删了（"底像素换成以下所有层的合成"那一岔）：那一枚
                // 现在是条带上普通的面，像素由页面在 render 的循环里抄进它自己的记录，折的时候跟一张
                // 贴片一样被读。于是这里再也没有"要另开一块 2D 累积画布"的工程。
                const got = foldLayer(pl, t, w, h, !!stage);
                if (!got) continue;
                if (got.tex) { items.push({ tex: got.tex, mask: got.mask, transform: pl.transform, opacity: pl.opacity }); continue; }
                items.push({ src: got.src, transform: pl.transform, opacity: pl.opacity });
                // 2D 那条路是"边画边攒"（目标画布本身就是账本）；GL 那条路由 compositeGL 一次贴完，
                // 之前这里往 `actx` 多画的一笔只为 Stash 的累积账存在，那一本账已经随图层种类删了。
                if (!useGL) drawTransformed(ctx, got.src, pl.transform, w, h, pl.opacity);
            }
            if (useGL) {
                const g = compositeGL(items, w, h, stage || o.glTarget || null);
                if (g) {
                    if (o.glTarget) return g;                  // 直出：那块画布本身就是结果
                    ctx.drawImage(g, 0, 0); return cv;         // 借/自建上下文：拷一次（P3.2 去掉这一步）
                }
                api.notes.push('gl unavailable, fell back to 2d');
            }
            return cv;
        }
        if (useGL) {
            const g = compositeGL(items, w, h, o.glTarget || null);
            if (g) { if (o.glTarget) return g; ctx.drawImage(g, 0, 0); return cv; }
            api.notes.push('gl unavailable, fell back to 2d');
        }
        for (const it of items) {
            if (it.tex) { api.notes.push('texture item on the 2d backend'); continue; }
            const a = (it.opacity === undefined || it.opacity === null) ? 1 : Math.min(1, Math.max(0, it.opacity));
            if (a <= 0) continue;
            if (!it.transform) {
                ctx.save(); ctx.globalAlpha *= a;
                try { ctx.drawImage(it.src, 0, 0, w, h); } catch (e) { /* skip */ }
                ctx.restore();
            }
            else drawTransformed(ctx, it.src, it.transform, w, h, a);
        }
        return cv;
    }

    /**
     * 直接渲染到一块**外部**画布（必须是 webgl2，且只被这里用）。
     * 这是"唯一显示面"的技术入口：合成结果就是屏幕上那块画布，中间不再有一次全幅拷贝。
     * `scratch` 那块 2D 面曾经是给 Stash **层**攒"以下所有层"用的账本（只有含 stash 的工程才需要）。
     * Stash 现在是条带上一枚普通的面，那一本账不再由合成器攒，这里就只剩"glTarget 之外的落点"这一件事。
     */
    function renderTo(canvas, plan, t, opts) {
        const w = (plan.grid && plan.grid.w) | 0;
        const h = (plan.grid && plan.grid.h) | 0;
        if (!canvas || !w || !h) return null;
        const scratch = blank(w, h);
        return render(plan, t, scratch, Object.assign({}, opts, { backend: 'gl', glTarget: canvas }));
    }

    /**
     * 把一组已经折好的 items 直接合成到一块**外部** webgl2 画布上（P3.2 的唯一显示面）。
     * 与 `render(plan)` 的区别只有一处：这里没有 plan —— 调用方（编辑器）自己按图层次序攒 items，
     * 每一层要放什么、摆在哪由它说了算。GL 不可用就回 false，调用方退回 2D。
     *   items: `{ src, transform|null, premul? }`（src = 画布/图片/视频；premul = 源已是预乘）
     *   opts:  `{ clear = true }`（false = 在已有内容上继续叠）
     */
    function present(canvas, items, w, h, opts) {
        if (!canvas || !w || !h) return false;
        let gl = null;
        try { gl = canvas.getContext('webgl2'); } catch (e) { gl = null; }
        if (!gl) return false;
        return !!compositeGL(items || [], w, h,
                             { gl, canvas, clear: !(opts && opts.clear === false) });
    }

    return { api, render, renderTo, present, foldLayer, blank };
})();

// 离线入口（探针/导出用）：不与现有渲染路径抢任何东西
if (typeof window !== 'undefined') {
    window.KCompositor = KCompositor;
    window.__kolidRenderPlan = function (plan, t, target) {
        return KCompositor.render(plan, t, target || KCompositor.blank(plan.grid.w, plan.grid.h));
    };
}
