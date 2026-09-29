// fx/ao.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图。
// 主槽绑一张深度图 (needsMap:'Depth'),副槽**可缺**地绑一张法线图 (needsMap2);两个槽的解析规则见 fx/maps.js。

// 环境光遮蔽:把绑来的深度图当高度场,在本像素身边朝 uDirs 个方向各走 uRings 步,每一步只问一句
// 「这一点比本像素的切平面还靠近相机吗」。高出来的那部分按 Soft 的半影平滑计入遮蔽,近的抽样权重高
// (接触才叫 AO),加权平均就是这块像素被身边的几何挡掉了多少天空,乘上 Tint 压掉对应比例的颜色。
// 切平面的来源是这一族唯一的歧义,所以两路都给、走线只有一份代码:
//   * 绑了法线图 ⇒ 斜面由贴图自己说。读法与 fx/lighting.js 逐字同一个基 (uv 基 y 向上,因为上传已
//     UNPACK_FLIP_Y;画布角 90° 指向下 ⇒ 下坡那一项取负;Green=down 那一族把 y 再翻一次)。
//   * 没绑 ⇒ 从深度自己的窗口导数现推:dFdx/dFdy 就是「每画布 px 的深度变化」,量纲与上面那条斜率
//     同构,所以两支都化成同一个 vec2「每 px 抬升多少深度单位」,下面的走线一个字都不分叉。
// Rise 是给法线图那一路的量纲尺:深度图满幅 = 多少个 px 高,默认 100% 即「满幅深度 ≈ 画面宽」,
// 那正是归一化深度图(MiDaS/Zoe 那一族)天生的比例。导数那一路里这把尺自己约掉了。
// 只写 RGB、alpha 原样、不位移、不读蒙版 —— 光照/泛光/体积霾那一族。
const FX_AO_MAX_DIRS = 16;      // 方向数上界:常数循环上界是 ESSL 的规矩,实际次数由 uDirs 说
const FX_AO_MAX_RINGS = 4;      // 每个方向走几步的上界 ⇒ 最多 64 次抽样/像素,单趟

const FX_FS_AO = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uMap;
uniform sampler2D uNrm;
uniform float uHasNormal;
uniform float uInv;
uniform float uGreen;
uniform float uKpx;
uniform float uRadius;
uniform float uPenumbra;
uniform float uStrength;
uniform vec3 uTint;
uniform vec2 uInvWH;
uniform vec2 uMapU;
uniform vec2 uMapV;
uniform vec2 uMapB;
uniform int uDirs;
uniform int uRings;
// 高度 = 离相机多近。极性读法与光照的 lightHeight 逐字相同 (near=dark 时 raw 本身就是距离,取反才是高度)。
float aoHeight(vec2 muv) {
    float d = texture(uMap, muv).r;
    return uInv > 0.5 ? d : 1.0 - d;
}
// 每朝画布 +x / +y(右下)走 1 px,表面在深度单位里抬起多少。
vec2 aoSlope(vec2 muv, float h0) {
    if (uHasNormal > 0.5) {
        vec3 n = texture(uNrm, muv).xyz;
        n = vec3(n.x * 2.0 - 1.0, (n.y * 2.0 - 1.0) * uGreen, max(n.z * 2.0 - 1.0, 0.05));
        // n.x/n.z 是"世界 px 抬升 / 世界 px 前进",除以 uKpx 换成深度单位;y 分量因为画布角与 uv 基反号取负。
        return vec2(n.x, -n.y) / (n.z * uKpx);
    }
    // 导数路径:dFdy 量的是 window y(= 画面朝上)那一步,画布 90° 指向下 ⇒ 取负。uKpx 在这支里约掉。
    return vec2(dFdx(h0), -dFdy(h0));
}
void main() {
    vec4 c = texture(uTex, vUV);
    vec2 base = uMapU * vUV.x + uMapV * vUV.y + uMapB;
    float h0 = aoHeight(base);
    vec2 s = aoSlope(base, h0);
    float acc = 0.0;
    float wsum = 0.0;
    for (int i = 0; i < ${FX_AO_MAX_DIRS}; i++) {
        if (i >= uDirs) break;
        // 半个步长偏移:方向数若是偶数,不偏移的射线会排成直线,在平面上攒出能看见的星芒。
        float phi = (float(i) + 0.5) * 6.2831853 / max(float(uDirs), 1.0);
        float cs = cos(phi), sn = sin(phi);
        for (int j = 0; j < ${FX_AO_MAX_RINGS}; j++) {
            if (j >= uRings) break;
            float d = uRadius * float(j + 1) / max(float(uRings), 1.0);
            float wgt = 1.0 - float(j) / max(float(uRings), 1.0);   // 近的抽样权重高:AO 的形状是接触
            // 图层自己的 px → 该层 uv(逐轴除以自己的宽高,与光照的 uStep 同一条换算),再交给
            // fxMapFrame 那两组基映进贴图 uv —— Canvas 对齐时这一步才跟着图层盒子走。
            vec2 off = vec2(cs * d * uInvWH.x, -sn * d * uInvWH.y);
            float ht = aoHeight(base + uMapU * off.x + uMapV * off.y);
            float plane = d * (cs * s.x + sn * s.y);
            float occ = clamp((ht - h0 - plane) / max(uPenumbra, 1e-4), 0.0, 1.0);
            acc += occ * wgt;
            wsum += wgt;
        }
    }
    float ao = clamp(acc / max(wsum, 1e-4), 0.0, 1.0);
    // 影子是乘法:Tint 就是被挡住那部分乘上去的颜色,深浅由 AO 说 (与光照的 Shadow×Tint 同一个读法)。
    Frag = vec4(clamp(c.rgb * mix(vec3(1.0), uTint, uStrength * ao), 0.0, 1.0), c.a);
}`;

function fxglAo(col, p, effect, l) {
    const gl = fxgl.gl;
    if (p.strength <= 0) return;
    const fr = fxMapFrame(p.align, l);
    // 满幅深度相当于多少个 px (按该层网格的宽) —— 导数那一路用不上它,但两支共用一个 aoSlope。
    const kpx = Math.max(p.rise / 100 * fxgl.w, 1e-3);
    const dst = fxgl.off[1 - col.slot];
    fxglRunPass(dst, fxgl.progs.ao, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uMap', fxgl.texMap, 1);
        // 没绑法线图时 uNrm 也得指向一张「完整」纹理:采样未分配贴图的 draw 会被 WebGL 整笔拒掉,
        // 那连一个像素都出不来。借主槽占位(主槽是必需的,必然有它),uHasNormal=0 时不读它。
        fxglBindTex(pr, 'uNrm', fxgl.hasMap2 === 1 ? fxgl.texMap2 : fxgl.texMap, 2);
        gl.uniform1f(fxglU(pr, 'uHasNormal'), fxgl.hasMap2 === 1 ? 1 : 0);
        gl.uniform1f(fxglU(pr, 'uInv'), p.near === 'bright' ? 1 : 0);
        gl.uniform1f(fxglU(pr, 'uGreen'), p.green === 'down' ? -1 : 1);
        gl.uniform1f(fxglU(pr, 'uKpx'), kpx);
        gl.uniform1f(fxglU(pr, 'uRadius'), p.radius);
        // 半影按该特效自己的尺度给:Soft% × (半径那段 px 折算成深度单位)。
        gl.uniform1f(fxglU(pr, 'uPenumbra'), Math.max(p.soft / 100 * p.radius / kpx, 1e-4));
        gl.uniform1f(fxglU(pr, 'uStrength'), p.strength / 100);
        gl.uniform3f(fxglU(pr, 'uTint'), ...fxHexToRgb01(p.tint));
        gl.uniform2f(fxglU(pr, 'uInvWH'), 1 / Math.max(fxgl.w, 1), 1 / Math.max(fxgl.h, 1));
        gl.uniform2f(fxglU(pr, 'uMapU'), fr.u[0], fr.u[1]);
        gl.uniform2f(fxglU(pr, 'uMapV'), fr.v[0], fr.v[1]);
        gl.uniform2f(fxglU(pr, 'uMapB'), fr.b[0], fr.b[1]);
        gl.uniform1i(fxglU(pr, 'uDirs'), Math.max(1, Math.min(FX_AO_MAX_DIRS, p.dirs | 0)));
        gl.uniform1i(fxglU(pr, 'uRings'), Math.max(1, Math.min(FX_AO_MAX_RINGS, p.rings | 0)));
    });
    col.slot = 1 - col.slot;
}

const FX_AO_PARAMS = [
    // 行首那个名字由注册表的角色查出来 (needsMap / needsMap2.role),不在这里手打第二遍。
    { key: 'map', kind: 'map', def: null },
    { key: 'normal', kind: 'map', def: null },
    { key: 'near', label: 'Near', kind: 'enum', options: ['dark', 'bright'], def: 'dark' },
    { key: 'align', label: 'Align', kind: 'enum', options: ['Canvas', 'Local'], def: 'Canvas' },
    { key: 'radius', label: 'Radius', min: 1, max: 64, step: 1, def: 16, unit: 'px' },
    { key: 'dirs', label: 'Dirs', min: 4, max: 16, step: 1, def: 8 },
    { key: 'rings', label: 'Rings', min: 1, max: 4, step: 1, def: 3 },
    { key: 'rise', label: 'Rise', min: 5, max: 200, step: 5, def: 100, unit: '%' },
    { key: 'soft', label: 'Soft', min: 0, max: 50, step: 1, def: 15, unit: '%' },
    { key: 'strength', label: 'AO', min: 0, max: 100, step: 1, def: 60, unit: '%' },
    { key: 'tint', label: 'Tint', kind: 'color', def: '#000000' },
    // 没有法线图时 Green 一个字都不参与计算(斜面是深度导数给的),所以这一行不许挂着当摆设
    // —— 和 fx/tone_map.js、fx/warp.js 同一个规矩:该模式要用的行才铺。
    { key: 'green', label: 'Green', kind: 'enum', options: ['up', 'down'], def: 'up',
        when: p => !!(p.normal && p.normal.key) },
];

defineEffect({
    type: 'ao',
    label: 'Ambient Occlusion',
    group: 'Light',
    icon: 'ao',
    needsMap: 'Depth',
    needsMap2: { key: 'normal', role: 'Normal' },
    desc: 'Reads a bound depth map as a height field and walks a fan of rays out from every pixel in Dirs directions \u2014 whatever stands closer to the camera than this pixel\u2019s tangent plane covers part of its sky, and that much of the colour is multiplied away by the AO tint. Bind a normal map to take the plane from the surface itself; leave it unbound and the plane is derived from the depth\u2019s own derivatives. Radius is how far the fan reaches in the layer\u2019s pixels, Rise is what the map\u2019s full depth range is worth in them. Colour only: alpha untouched, nothing moves.',
    params: FX_AO_PARAMS,
    shaders: { ao: FX_FS_AO },
    run: fxglAo,
    // Canvas 对齐的 AO 吃的还是「该层盒子落在画布哪儿」,而拖图层既不改像素也不改 params —— 与体积雾
    // 同一件事,缓存身份必须知道,否则挪完还在用挪之前那份取样。
    stamp(effect, l) {
        const p = effectParams(effect);
        if (p.align !== 'Canvas') return '';
        const tr = effectiveTransform(l);
        return `${tr.cx.toFixed(4)},${tr.cy.toFixed(4)},${tr.w.toFixed(4)},${tr.h.toFixed(4)},${tr.rotation.toFixed(3)}`;
    },
    readout(p, n, effect) {
        // 五项:深度图名 对齐 半径 强度 斜面来源(绑了法线图就报它的名字,没绑写 n:depth = 从深度现推)。
        // Dirs/Rings 不报:它们只改走线的颗粒度与代价,不改形状 (同体积雾的 Steps)。
        // Near=bright 必须报,它把「谁挡谁」整个倒过来。
        const nrm = fxMapRef(effect, 'normal') ? fxMapShort(effect, 'normal') : 'depth';
        return `${fxMapShort(effect)}  ${p.align === 'Local' ? 'local' : 'canvas'}  r${n(p.radius)}  `
            + `${n(p.strength)}%  n:${nrm}${p.near === 'bright' ? '  inv' : ''}`;
    },
    // 一格一个控件、按 when 收无关行:通用面板会铺满 params,所以这块自己出编辑面 (同 tone/warp)。
    editor(l, effect, syncRead, updaters) {
        const box = document.createElement('div');
        const build = () => {
            const p = effectParams(effect);
            box.replaceChildren(...FX_AO_PARAMS
                .filter(d => !d.when || d.when(p))
                .map(d => fxControlRow(l, effect, d, syncRead, updaters)));
        };
        build();
        return box;
    },
    thumb(g, box) {
        // 两块砖相接:接缝那条暗带就是 AO —— 挡光的是身边的几何,不是某一盏灯,所以哪儿都没有光源。
        const w = box.w, h = box.h, x = box.x, y = box.y;
        const seam = x + w * 0.52;
        g.fillStyle = '#3a3f52';
        g.fillRect(x + 3, y + 4, seam - 8 - x, h - 8);
        g.fillRect(seam + 6, y + h * 0.34, x + w - 8 - seam - 6, h * 0.66 - 4);
        const gr = g.createLinearGradient(seam - 7, 0, seam + 6, 0);
        gr.addColorStop(0, 'rgba(0,0,0,0)');
        gr.addColorStop(0.55, 'rgba(0,0,0,0.72)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr;
        g.fillRect(seam - 7, y + 4, 13, h - 8);
    },
});
