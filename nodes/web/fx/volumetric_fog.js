// fx/volumetric_fog.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图。
// 它绑一张深度图 (needsMap),引用的解析规则见 fx/maps.js。

// 体积雾:浓度不是全图一个值,而是逐像素由深度图算 —— 视程 t = (d − Start)/(End − Start) 夹进
// 0..1,再乘一条**随画面高度指数变薄**的密度,得到该像素的光学厚度 τ,透射率 T = e^−τ。
// 单次解析 pass,不光线步进、不多要一张缓冲 (雾是"这个像素往下看多远",不是"沿射线积分多少层",
// 后者才需要 march;这里用闭式高度项换掉了那 32 次抽样)。
// 出射 = 本色 × T + 雾色 × 相位 × (1 − T):相位是 Henyey-Greenstein 除以自己的侧向值,所以各向同性
// (g=0) 时恒为 1 —— 颜色不会被相位自己拽亮或拽暗,而朝向 Sun 的那一侧会亮起来,雾里就长出光带。
// 深度只读 R 通道 (与景深同一条读法, 单通道深度图三通道相同)。只改 RGB、alpha 原样。
const FX_FS_FOG = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uMap;
uniform vec3 uColor;
uniform vec2 uSun;
uniform float uStart;
uniform float uSpan;
uniform float uInv;
uniform float uDensity;
uniform float uFall;
uniform float uFloor;
uniform float uG;
uniform float uAspect;
void main() {
    vec4 c = texture(uTex, vUV);
    float d = texture(uMap, vUV).r;
    d = uInv > 0.5 ? 1.0 - d : d;
    float t = clamp((d - uStart) * uSpan, 0.0, 1.0);
    if (t <= 0.0) { Frag = c; return; }
    // vUV.y = 0 是画面下缘 (上传时已 UNPACK_FLIP_Y),所以"离地多高"直接就是 y 减基线。基线以下
    // 一律按最浓处理 —— 贴底的像素没有"更低的雾"可下去了。
    float above = max(vUV.y - uFloor, 0.0);
    float tau = uDensity * t * exp(-above / uFall);
    float T = exp(-tau);
    // 视线走针孔近似:画面中心是正前方。Sun 只给屏幕方向,于是朝向它的像素拿到前向散射、背离的
    // 拿到后向散射,中心正好是侧向 (= 1)。
    vec3 v = normalize(vec3((vUV - 0.5) * vec2(uAspect, 1.0), 1.0));
    float mu = clamp(dot(v.xy, uSun), -1.0, 1.0);
    float g2 = uG * uG;
    float hg = clamp(pow((1.0 + g2) / max(1.0 + g2 - 2.0 * uG * mu, 1e-3), 1.5), 0.0, 3.0);
    Frag = vec4(clamp(c.rgb * T + uColor * hg * (1.0 - T), 0.0, 1.0), c.a);
}`;

function fxglFog(col, p) {
    const gl = fxgl.gl;
    const a = p.sun * Math.PI / 180;
    const dst = fxgl.off[1 - col.slot];
    fxglRunPass(dst, fxgl.progs.fog, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uMap', fxgl.texMap, 1);
        gl.uniform3f(fxglU(pr, 'uColor'), ...fxHexToRgb01(p.color));
        // 画布角 (0° 右、90° 下) 映到 uv 时 y 取负,和 fxglDirUV / 光照那束同一个基。
        gl.uniform2f(fxglU(pr, 'uSun'), Math.cos(a), -Math.sin(a));
        gl.uniform1f(fxglU(pr, 'uStart'), p.start / 100);
        // End 收到 Start 以下时区间塌成 0:夹一个下限,让雾在 Start 之后立刻拉满,而不是把 t 反着算。
        gl.uniform1f(fxglU(pr, 'uSpan'), 100 / Math.max(p.end - p.start, 0.1));
        gl.uniform1f(fxglU(pr, 'uDensity'), p.density / 100 * 4);
        gl.uniform1f(fxglU(pr, 'uFall'), Math.max(p.height / 100, 1e-3));
        gl.uniform1f(fxglU(pr, 'uFloor'), p.base / 100);
        gl.uniform1f(fxglU(pr, 'uG'), p.g / 100);
        gl.uniform1f(fxglU(pr, 'uInv'), p.near === 'bright' ? 1 : 0);
        gl.uniform1f(fxglU(pr, 'uAspect'), fxgl.w / Math.max(fxgl.h, 1));
    });
    col.slot = 1 - col.slot;
}

defineEffect({
    type: 'fog',
    label: 'Volumetric Fog',
    group: 'Light',
    icon: 'fog',
    needsMap: 'Depth',
    desc: 'Veils the layer through a bound depth map: everything nearer than Start stays clear, depth toward End builds an optical thickness that thins exponentially with picture height above Floor. Sun drives a Henyey-Greenstein phase, so the side the light comes from glows through the mist. Colour only: alpha untouched, nothing moves.',
    params: [
        { key: 'map', label: 'Map', kind: 'map', def: null },
        { key: 'near', label: 'Near', kind: 'enum', options: ['dark', 'bright'], def: 'dark' },
        { key: 'start', label: 'Start', min: 0, max: 100, step: 1, def: 15, unit: '%' },
        { key: 'end', label: 'End', min: 1, max: 100, step: 1, def: 100, unit: '%' },
        { key: 'density', label: 'Density', min: 0, max: 100, step: 1, def: 45, unit: '%' },
        { key: 'height', label: 'Height', min: 1, max: 100, step: 1, def: 22, unit: '%' },
        { key: 'base', label: 'Floor', min: 0, max: 100, step: 1, def: 8, unit: '%' },
        { key: 'sun', label: 'Sun', min: 0, max: 359, step: 1, def: 315, unit: '°' },
        { key: 'g', label: 'Aniso', min: -90, max: 90, step: 1, def: 40, unit: '' },
        { key: 'color', label: 'Fog', kind: 'color', def: '#cfe0f2' },
    ],
    shaders: { fog: FX_FS_FOG },
    run: fxglFog,
    readout(p, n, effect) {
        // 五项,和光照那行同宽 (贴图名 视程区间 浓度 高度 太阳角);Aniso 只在两侧对比时才看得出来,
        // 行尾留给 Near=bright 的 inv 标记 —— 它决定整张图是近处清还是远处清。
        return `${fxMapShort(effect)}  ${n(p.start)}-${n(p.end)}  ${n(p.density)}%  h${n(p.height)}  ${n(p.sun)}°${p.near === 'bright' ? '  inv' : ''}`;
    },
    thumb(g, box) {
        // 一条贴底、往上按指数散开的雾带 + 光源那一侧的一点亮:Height 就是这条带的厚度。
        const gr = g.createLinearGradient(0, box.y + box.h, 0, box.y);
        gr.addColorStop(0, 'rgba(207,224,242,0.92)');
        gr.addColorStop(0.34, 'rgba(207,224,242,0.42)');
        gr.addColorStop(1, 'rgba(207,224,242,0)');
        g.fillStyle = gr;
        g.fillRect(box.x, box.y, box.w, box.h);
        const sx = box.x + box.w * 0.74, sy = box.y + box.h * 0.24, r = Math.min(box.w, box.h) * 0.85;
        const sun = g.createRadialGradient(sx, sy, 0, sx, sy, r);
        sun.addColorStop(0, 'rgba(255,246,224,0.55)');
        sun.addColorStop(1, 'rgba(255,246,224,0)');
        g.fillStyle = sun;
        g.fillRect(box.x, box.y, box.w, box.h);
    },
});
