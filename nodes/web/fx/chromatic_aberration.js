// fx/chromatic_aberration.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图。
// 它绑一张深度图 (needsMap),而且只在 Depth 模式真要它 —— needsMapWhen 报这一句,解析规则见 fx/maps.js。
// 三条契约的落点:① 某个通道的源点跑到该层网格之外 = 那一格没有源 ⇒ 该通道取 0,不拿 CLAMP_TO_EDGE
// 的最外圈抹出一条假边;② 只重组 RGB、alpha 原样 (它是色散,不是模糊);③ 不读蒙版。

const FX_CHROMA_MODES = ['Radial', 'Directional', 'Depth'];

// 分色散:红与蓝各从偏开一点的位置取样,绿留在原地 —— 高反差边缘因此长出一条彩边。
// 偏移量 uK/uDir 都已经是 **uv** (在 JS 侧按该层网格的像素数除过),所以着色器里不必知道宽高。
//   Radial     = 透镜那种横向色散:偏移沿「离视轴 (该层网格的中心)」的方向往外长,并且**与半径成正比**,
//                uK 让角落那一圈正好走到 Amount/2 (两通道各半 ⇒ 读数里的 Amount 就是红蓝之间的间距)。
//   Directional= 全场共用一支偏移 (棱镜,不是透镜):Angle 就是**红那张画被推去的方向** (0° = 右、
//                90° = 下,同 fxglDirUV), 蓝取另一半, 绿钉在原地。
//   Depth      = 轴向色散:径向那套几何乘上逐像素的「离焦量」—— 合焦面 (Focal) 与它前后 Thick/2 那半幅
//                带子里一点不偏,带外线性推到满幅。焦点**两侧符号相反**:这正是真实镜头离焦高光的
//                样子 —— 前景一边是青边、背景一边是品红边,而不是全场同一套颜色顺序。
// 深度只读 R 通道、极性按 Near 翻一次,与景深/体积雾同一条读法;贴图的落点走 fxMapFrame 那条仿射基,
// 于是 Align: Canvas / Local 只是换一组基 (与体积雾同一个函数,不再写第二份算式)。
const FX_FS_CHROMA = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uMap;
uniform vec2 uMapU;
uniform vec2 uMapV;
uniform vec2 uMapB;
uniform float uInv;
uniform float uFocus;
uniform float uThick;
uniform int uMode;
uniform vec2 uDir;
uniform float uK;
vec4 chromaFetch(sampler2D tex, vec2 uv) {
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
    return texture(tex, uv);
}
void main() {
    vec2 sh = uDir;
    if (uMode != 1) {
        sh = (vUV - 0.5) * uK;
        if (uMode == 2) {
            float d = texture(uMap, uMapU * vUV.x + uMapV * vUV.y + uMapB).r;
            d = uInv > 0.5 ? 1.0 - d : d;
            float t = clamp(abs(d - uFocus) / max(1.0 - uThick * 0.5, 1e-3), 0.0, 1.0);
            sh *= t * (d >= uFocus ? 1.0 : -1.0);
        }
    }
    vec4 c = texture(uTex, vUV);
    // 取样点落在 p − sh = 这一通道的画面朝 +sh 挪。所以正 Amount 把红推向外侧 (真实镜头的横向色散
    // 就是红的成像圈更大), 蓝拉回内侧;Amount 取负整个反过来。
    vec4 r = chromaFetch(uTex, vUV - sh);
    vec4 b = chromaFetch(uTex, vUV + sh);
    // 色彩缓冲是直通 alpha:偏开取来的颜色先按**它自己那处**的不透明度预乘, 再除回**本像素**的 alpha。
    // 不这么做的话, 边缘那圈会把邻格里透明的黑拽进颜色 (与 FX_FS_BOX 里同一句话)。
    vec3 rgb = vec3(r.r * r.a, c.g * c.a, b.b * b.a) / max(c.a, 1e-3);
    Frag = vec4(clamp(rgb, 0.0, 1.0), c.a);
}`;

// Amount 的正负 = 哪个通道往外走:正 = 红在外 (真实镜头的横向色散就是这样), 负 = 蓝在外。
function fxglChromaticAberration(col, p, effect, l) {
    if (!p.amount) return;                    // 0 = 一个通道都没偏开, 画面原样留着
    const gl = fxgl.gl;
    const dst = fxgl.off[1 - col.slot];
    const src = fxgl.off[col.slot].tex;
    const half = p.amount * 0.5;              // 两通道各走一半, 合起来才是读数里那个 Amount
    const d = fxglDirUV(p.angle, half);
    const fr = fxMapFrame(p.align, l);
    fxglRunPass(dst, fxgl.progs.chroma, pr => {
        fxglBindTex(pr, 'uTex', src, 0);
        // 深度图只在 Depth 模式才读, 另外两种模式把**当前色彩面**借给这个采样器而不是空绑:
        // 采样器指着一张从没分配过层级的纹理会让整次 drawArrays 报 INVALID_OPERATION (同 fx/lighting.js)。
        fxglBindTex(pr, 'uMap', p.mode === 'Depth' ? fxgl.texMap : src, 1);
        gl.uniform2f(fxglU(pr, 'uMapU'), fr.u[0], fr.u[1]);
        gl.uniform2f(fxglU(pr, 'uMapV'), fr.v[0], fr.v[1]);
        gl.uniform2f(fxglU(pr, 'uMapB'), fr.b[0], fr.b[1]);
        gl.uniform1f(fxglU(pr, 'uInv'), p.near === 'bright' ? 1 : 0);
        gl.uniform1f(fxglU(pr, 'uFocus'), p.focus / 100);
        gl.uniform1f(fxglU(pr, 'uThick'), p.thick / 100);
        gl.uniform1i(fxglU(pr, 'uMode'), p.mode === 'Depth' ? 2 : (p.mode === 'Directional' ? 1 : 0));
        gl.uniform2f(fxglU(pr, 'uDir'), d.x / fxgl.w, d.y / fxgl.h);
        // 径向那条偏移与半径成正比, 归一化的基准是「该层网格的角」—— 角上正好走 half 个像素。
        gl.uniform1f(fxglU(pr, 'uK'), half / Math.max(0.5 * Math.hypot(fxgl.w, fxgl.h), 1));
    });
    col.slot = 1 - col.slot;
}

// ==================== 参数区 ====================
// 一格一个 Chromatic Aberration:Mode 用分段钮 (与 Warp / 色调映射同一套控件词汇), 下面只铺该模式
// 要用的行。Depth 模式那五行 (贴图 / Near / Align / Focal / Thick) 逐字照景深与体积雾的既有叫法,
// 不另起第二个名字。
const CHROMA_PARAMS = [
    { key: 'mode', label: 'Mode', kind: 'enum', options: FX_CHROMA_MODES, def: 'Radial' },
    { key: 'amount', label: 'Amount', min: -48, max: 48, step: 1, def: 8, unit: 'px' },
    { key: 'angle', label: 'Angle', min: 0, max: 359, step: 1, def: 0, unit: '\u00b0', when: p => p.mode === 'Directional' },
    { key: 'map', kind: 'map', def: null, when: p => p.mode === 'Depth' },
    { key: 'near', label: 'Near', kind: 'enum', options: ['dark', 'bright'], def: 'dark', when: p => p.mode === 'Depth' },
    { key: 'align', label: 'Align', kind: 'enum', options: ['Canvas', 'Local'], def: 'Canvas', when: p => p.mode === 'Depth' },
    { key: 'focus', label: 'Focal', min: 0, max: 100, step: 1, def: 35, unit: '%', when: p => p.mode === 'Depth' },
    { key: 'thick', label: 'Thick', min: 0, max: 100, step: 1, def: 10, unit: '%', when: p => p.mode === 'Depth' },
];

function chromaEditorEl(l, effect, syncRead, updaters) {
    const box = document.createElement('div');
    box.className = 'fx-chroma';
    const tail = document.createElement('div');
    tail.className = 'fx-chroma-tail';
    const build = () => {
        const p = effectParams(effect);
        tail.replaceChildren(...CHROMA_PARAMS
            .filter(d => d.key !== 'mode' && (!d.when || d.when(p)))
            .map(d => fxControlRow(l, effect, d, syncRead, updaters)));
        syncRead();
    };
    // 模式是这张面板的第一行, 只多接一句「换完模式重铺剩下的行」—— 与 fx/warp.js 同一包法。
    box.appendChild(fxControlRow(l, effect, CHROMA_PARAMS[0], () => { build(); }, updaters));
    box.appendChild(tail);
    build();
    return box;
}

defineEffect({
    type: 'chromatic_aberration',
    label: 'Chromatic Aberration',
    group: 'Distort',
    icon: 'chromatic',
    needsMap: 'Depth',
    needsMapWhen: p => p.mode === 'Depth',
    desc: 'Sample red and blue from slightly different places while green stays put, so every high-contrast edge grows a coloured fringe. Radial = the lens kind: the split points away from the optical centre of this layer and grows in proportion to the radius, reaching the full Amount at the corner. Directional = one offset shared by the whole layer, Angle being the way the red picture is pushed \u2014 a prism, not a lens. Depth reads a bound depth map and fringes only what sits off the focal plane: Focal stays clean, as does everything within Thick/2 of it, and the fringe reverses its colour order on the two sides of focus (near side cyan, far side magenta), which is what axial CA really does to a defocused highlight. Amount is the red\u2194blue separation in pixels and it is signed \u2014 negative puts blue on the outside instead of red. Colour only: alpha untouched, and where a channel\u2019s source leaves the grid that channel has nothing to pull in, so it comes back empty.',
    params: CHROMA_PARAMS,
    editor: chromaEditorEl,
    shaders: { chroma: FX_FS_CHROMA },
    run: fxglChromaticAberration,
    // Canvas 对齐的深度吃的是「该层盒子落在画布哪儿」, 而拖图层既不改像素也不改 params —— 挪完层
    // 还在用挪之前算好的那份离焦分布就是过期缓存。注册表为此留了 stamp 这个口子 (同体积雾)。
    stamp(effect, l) {
        const p = effectParams(effect);
        if (p.mode !== 'Depth' || p.align !== 'Canvas') return '';
        const tr = effectiveTransform(l);
        return `${tr.cx.toFixed(4)},${tr.cy.toFixed(4)},${tr.w.toFixed(4)},${tr.h.toFixed(4)},${tr.rotation.toFixed(3)}`;
    },
    readout(p, n, effect) {
        // Amount 带符号写:它是「哪个通道在外」这件事的唯一读数, 而符号翻了画面确实翻。
        if (p.mode === 'Depth') return `${fxMapShort(effect)}  ${p.align === 'Local' ? 'local' : 'canvas'}  f${n(p.focus)}  t${n(p.thick)}  ${n(p.amount)}px`;
        if (p.mode === 'Directional') return `directional  ${n(p.angle)}\u00b0  ${n(p.amount)}px`;
        return `radial  ${n(p.amount)}px`;
    },
    thumb(g, box) {
        // 一个亮块被三个通道各偏开一点: additive 叠回来中间还是白, 两侧长出红/黄与青/蓝两条 fringe ——
        // 色散的样子就是「同一个硬边, 三个位置」。
        const prev = g.globalCompositeOperation;
        const d = 3.2;
        const sq = (color, dx) => {
            g.globalCompositeOperation = 'lighter';
            g.fillStyle = color;
            g.fillRect(box.x + box.w * 0.26 + dx, box.y + box.h * 0.18, box.w * 0.48, box.h * 0.64);
        };
        sq('rgba(255,64,64,0.9)', -d);
        sq('rgba(64,255,96,0.9)', 0);
        sq('rgba(80,120,255,0.9)', d);
        g.globalCompositeOperation = prev;
    },
});
