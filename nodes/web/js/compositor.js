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
//   · capture:'below' 的层（Stash）输入是"此刻画布上已经有的东西"，不是自己的底像素
const KCompositor = (function () {
    const api = {
        /** uri → canvas/Image/Video（已加载的资源）。没加载返回 null。 */
        resource: null,
        /** (trackId, t) → 该轨这一刻的帧。null = 还没解出来。 */
        frame: null,
        /** 兜底：(planLayer, stepIndex, step) → 一张现成的面（页面内适配用；P2 第一步靠它）。 */
        bind: null,
        /** 这一趟被跳过了什么（诊断；不参与画）。 */
        notes: [],
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
     * 折叠一层：底像素 + strip。返回一张 w×h 的面。
     * 语义逐条对齐 fxDropStrip（fx/gl.js）：
     *   · 每一枚蒙版都是它**右边所有链**的 silhouette（一路攒着）；
     *   · 蒙版按 destination-in 裁，decal 按 source-over 叠；
     *   · 整趟没有墨 ⇒ 就是底像素本身（fxResolved 的早退）。
     */
    function foldLayer(pl, t, w, h, below) {
        const base = pl.capture === 'below'
            ? (below || null)
            : (pl.base && pl.base.resource && api.resource ? api.resource(pl.base.resource) : null);
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
        let inked = false;
        const strip = pl.strip || [];
        for (let i = 0; i < strip.length; i++) {
            const st = strip[i];
            if (!st || st.enabled === false) continue;
            if (st.kind === 'chain') {
                const chain = (st.chain || []).filter(e => e && e.enabled !== false);
                if (!chain.length) continue;
                try {
                    applyLayerEffects(fake, surf, { rec: { chain }, mask: stripCoverage(left, w, h) });
                } catch (e) {
                    api.notes.push('chain failed: ' + (e && e.message || e));
                }
                inked = true;
                continue;
            }
            if (st.kind === 'surface') {
                const cv = faceOf(pl, i, st, t, w, h);
                if (!cv) { api.notes.push('missing face: ' + st.type); continue; }
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
            // generator（文字/方向/3D/pose/几何）：P2 只认烘焙好的面，其余留到 P3
            if (st.kind === 'generator') {
                const baked = st.baked && st.baked.resource && api.resource ? api.resource(st.baked.resource) : null;
                if (!baked) { api.notes.push('generator not baked: ' + st.type); continue; }
                const cv = flatten(baked, w, h);
                if (!cv) continue;
                g.globalCompositeOperation = 'source-over';
                g.drawImage(cv, 0, 0, w, h);
                inked = true;
            }
        }
        return inked ? surf : (base ? flatten(base, w, h) : surf);
    }

    /** 与 drawLayer 逐字一致：translate(cx·W, cy·H) · rotate · drawImage(-tw/2,-th/2,tw,th)。 */
    function drawTransformed(ctx, src, tr, w, h) {
        const t = tr || {};
        const cx = t.cx === undefined ? 0.5 : t.cx;
        const cy = t.cy === undefined ? 0.5 : t.cy;
        const ww = t.w === undefined ? 1 : t.w;
        const hh = t.h === undefined ? 1 : t.h;
        const rot = t.rotation || 0;
        const tw = ww * w, th = hh * h;
        ctx.save();
        ctx.translate(cx * w, cy * h);
        ctx.rotate(rot);
        ctx.drawImage(src, -tw / 2, -th / 2, tw, th);
        ctx.restore();
    }

    // ── GL 混合（P2 第二步）────────────────────────────────────────────────────────────────
    // 目的：层的叠加不再走 canvas 2D，而是在**一个** GL 上下文里按预乘直接混（ONE / ONE_MINUS_SRC_ALPHA）。
    // 取帧/折叠仍由上面的代码出 canvas（fx 链还是那条），这里只负责"把面按矩阵贴上去、按序混"。
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
    const FS = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 Frag; uniform sampler2D uSrc;
void main() { Frag = texture(uSrc, vUV); }`;

    // 每个画布一份 GL 状态。传 target 时**直接渲染到那块画布**（P3.2 的唯一画布就靠这条），
    // 不传就是内部那块离屏。preserveDrawingBuffer 只为了导出/截图能取到像素。
    const glStates = new WeakMap();
    const glOffscreen = { c: null };
    function glInit(target) {
        const c = target || (glOffscreen.c || (glOffscreen.c = document.createElement('canvas')));
        if (glStates.has(c)) return glStates.get(c);
        const gl = c.getContext('webgl2', { premultipliedAlpha: true, antialias: false, alpha: true,
                                            preserveDrawingBuffer: true });
        if (!gl) { glStates.set(c, false); return false; }
        const sh = (t, src) => {
            const o = gl.createShader(t); gl.shaderSource(o, src); gl.compileShader(o);
            if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o));
            return o;
        };
        const prog = gl.createProgram();
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { glStates.set(c, false); return false; }
        gl.useProgram(prog);
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
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const state = { c, gl, prog, buf, tex, loc: {
            uRes: gl.getUniformLocation(prog, 'uRes'), uC: gl.getUniformLocation(prog, 'uC'),
            uSize: gl.getUniformLocation(prog, 'uSize'), uRot: gl.getUniformLocation(prog, 'uRot'),
            uFill: gl.getUniformLocation(prog, 'uFill'), uSrc: gl.getUniformLocation(prog, 'uSrc'),
        } };
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);      // 预乘混合（与 canvas 2D 内部一致）
        glStates.set(c, state);
        return state;
    }

    /** items: [{ src, transform|null }]（自底向上；transform=null 表示铺满）。返回 GL 的 canvas。 */
    function compositeGL(items, w, h, target) {
        const st = glInit(target || null);
        if (!st) return null;
        const { c, gl, tex, loc } = st;
        if (c.width !== w) c.width = w;
        if (c.height !== h) c.height = h;
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform2f(loc.uRes, w, h);
        gl.uniform1i(loc.uSrc, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        for (const it of items) {
            if (!it || !it.src) continue;
            try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, it.src); } catch (e) { continue; }
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
        // 形态（契约 §2.3.1）：source = 这一帧就是那条轨的视频帧（拉伸铺满，与 paintVidBase 一致）；
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
            items.push({ src, transform: null });          // 铺满（与 paintVidBase 的拉伸一致）
        } else {
            const want = o.stack || 'work';
            const stack = (plan.layers || []).filter(pl => pl && pl.visible !== false && (pl.stack || 'work') === want);
            // Stash 层的输入是"以下所有层的合成"。2D 路径上那就是目标画布（边画边攒）；
            // GL 路径上目标要等全都贴完才画，所以另开一块 2D 累积画布——**只在这种工程里**才建。
            const needAcc = useGL && stack.some(pl => pl.capture === 'below');
            const acc = needAcc ? blank(w, h) : null;
            const actx = acc ? acc.getContext('2d') : null;
            for (const pl of stack) {
                const below = pl.capture === 'below' ? (acc || cv) : null;
                const src = foldLayer(pl, t, w, h, below);
                if (!src) continue;
                items.push({ src, transform: pl.transform });
                if (useGL) { if (actx) drawTransformed(actx, src, pl.transform, w, h); }
                else drawTransformed(ctx, src, pl.transform, w, h);
            }
            if (useGL) {
                const g = compositeGL(items, w, h, o.glTarget || null);
                if (g) {
                    if (o.glTarget) return g;                  // 直出：那块画布本身就是结果
                    ctx.drawImage(g, 0, 0); return cv;         // 内部离屏：拷一次
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
            if (!it.transform) { try { ctx.drawImage(it.src, 0, 0, w, h); } catch (e) { /* skip */ } }
            else drawTransformed(ctx, it.src, it.transform, w, h);
        }
        return cv;
    }

    /**
     * 直接渲染到一块**外部**画布（必须是 webgl2，且只被这里用）。
     * 这是"唯一显示面"的技术入口：合成结果就是屏幕上那块画布，中间不再有一次全幅拷贝。
     * `scratch` 是给 Stash 层用的 2D 累积面（只有含 stash 的工程才需要）。
     */
    function renderTo(canvas, plan, t, opts) {
        const w = (plan.grid && plan.grid.w) | 0;
        const h = (plan.grid && plan.grid.h) | 0;
        if (!canvas || !w || !h) return null;
        const scratch = blank(w, h);
        return render(plan, t, scratch, Object.assign({}, opts, { backend: 'gl', glTarget: canvas }));
    }

    return { api, render, renderTo, foldLayer, blank };
})();

// 离线入口（探针/导出用）：不与现有渲染路径抢任何东西
if (typeof window !== 'undefined') {
    window.KCompositor = KCompositor;
    window.__kolidRenderPlan = function (plan, t, target) {
        return KCompositor.render(plan, t, target || KCompositor.blank(plan.grid.w, plan.grid.h));
    };
}
