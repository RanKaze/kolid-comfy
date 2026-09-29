// fx/lighting.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图。
// 它绑一张法线图 (needsMap) 打光,还可以再绑一张深度图 (needsMap2) 当高度场把阴影算出来;
// 两个槽的解析规则见 fx/maps.js。

// 光照:切线空间法线图(uv 基:y 向上,因为上传时已 UNPACK_FLIP_Y;平坦处 = (0.5,0.5,1))做
// Lambert 漫反射 + Blinn-Phong 高光。绿色通道的朝向按贴图族选(OpenGL 朝上 / DirectX 朝下)。
// 灯的颜色逐通道作用在漫反射与高光上 —— 从前它只进高光项,所以 Spec=0 时整盏灯看着是白色的。
// 绑了深度图再把阴影算上:同一盏灯沿自己的方位在高度场上走线,挡住光的那块把身后压暗(乘 Tint)。
// 只改 RGB:高光加在色上,阴影乘在色上,贴图本身永远不渗进画面。
const FX_LIGHT_SHADOW_STEPS = 12;      // 走线的抽样预算:常数循环上界,实际次数由 uSteps 说

const FX_FS_LIGHT = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uMap;
uniform sampler2D uDepth;
uniform vec3 uL;
uniform vec3 uColor;
uniform vec3 uTint;
uniform float uIntensity;
uniform float uSpec;
uniform float uGloss;
uniform float uGreen;
uniform float uShadow;
uniform float uNearBright;
uniform float uPenumbra;
uniform vec2 uStep;
uniform float uGain;
uniform int uSteps;
// 高度 = 离相机多近。深度图的极性由 Near 说(near=dark 时 raw 本身就是距离,得取反才是高度)。
float lightHeight(vec2 uv) {
    float d = texture(uDepth, uv).r;
    return uNearBright > 0.5 ? d : 1.0 - d;
}
void main() {
    vec4 c = texture(uTex, vUV);
    vec3 n = texture(uMap, vUV).xyz;
    n = vec3(n.x * 2.0 - 1.0, (n.y * 2.0 - 1.0) * uGreen, max(n.z * 2.0 - 1.0, 0.05));
    n = normalize(n);
    float diff = max(dot(n, uL), 0.0);
    vec3 h = normalize(uL + vec3(0.0, 0.0, 1.0));
    float s = pow(max(dot(n, h), 0.0), mix(6.0, 220.0, uGloss)) * uSpec;
    // 阴影:从本像素朝光源在 uv 上走 uSteps 步,每步按 tan(Elev) 抬高 uGain。途中任何一点比这条
    // 光线更靠近相机,它就把光挡住 —— 深度图当高度场用,影子是被算出来的,不需要另外一张图。
    // Elev=90° 时 tan 为正无穷 = 正对打光永远没有影子,与直觉一致。Soft 是半影:高度差够到它就全影。
    float occ = 0.0;
    if (uShadow > 0.0) {
        float h0 = lightHeight(vUV);
        vec2 p = vUV;
        float up = 0.0;
        for (int i = 0; i < ${FX_LIGHT_SHADOW_STEPS}; i++) {
            if (i >= uSteps) break;
            p += uStep;
            up += uGain;
            float w = clamp((lightHeight(p) - (h0 + up)) / max(uPenumbra, 1e-4), 0.0, 1.0);
            occ = max(occ, w * w * (3.0 - 2.0 * w));
        }
    }
    vec3 lit = c.rgb * clamp(1.0 + uColor * (uIntensity * (diff - 0.45)), 0.0, 3.0) + uColor * s;
    // 影子是乘法:Tint 就是被挡住那部分乘上去的颜色(黑 = 传统压暗,青色 = 彩色影子),
    // 深浅由 Shadow 说。半影从 0 起,所以微小的深度抖动最多攒出极浅的一层,不会长出自斑。
    lit *= mix(vec3(1.0), uTint, uShadow * occ);
    Frag = vec4(clamp(lit, 0.0, 1.0), c.a);
}`;

function fxglLight(col, p) {
    const gl = fxgl.gl;
    const a = p.angle * Math.PI / 180, e = p.elev * Math.PI / 180, ce = Math.cos(e);
    const rgb = fxHexToRgb01(p.color);
    const tint = fxHexToRgb01(p.tint);
    // 副槽就绪(引擎按 needsMap2When 决定它有没有像素)且强度 > 0 才走线,否则连步都不迈。
    // 步数把 Cast 摊成至多 12 段:每段 2px 是半影还能平滑的下界,再细就只是白抽样。
    const march = fxgl.hasMap2 === 1 && p.shadow > 0;
    // 影子开着一张图都没来 = 光照照旧、阴影没有。这一下必须写在链上,不许看着像「阴影怎么没生效」。
    if (p.shadow > 0 && !march) fxgl.skip = 'Lighting: no depth map for shadows';
    const steps = march ? Math.max(1, Math.min(FX_LIGHT_SHADOW_STEPS, Math.round(p.cast / 2))) : 0;
    const stepPx = steps ? p.cast / steps : 0;
    const dst = fxgl.off[1 - col.slot];
    fxglRunPass(dst, fxgl.progs.light, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uMap', fxgl.texMap, 1);
        // 没深度图时 uDepth 也得指向一张「完整」纹理:采样未分配贴图的 draw 会被 WebGL 整笔拒掉,
        // 那连光照都没了。借主槽占位(光照必然有它),步数=0 时一个像素都不会读它。
        fxglBindTex(pr, 'uDepth', march ? fxgl.texMap2 : fxgl.texMap, 2);
        // 光朝向量的基与法线图一致:画布角(0° 右、90° 下)映到 uv 时 y 取负,和 fxglDirUV 同一条
        // 规矩;z = sin(elev) 朝屏幕外,elev=90° 即正对打光。
        gl.uniform3f(fxglU(pr, 'uL'), Math.cos(a) * ce, -Math.sin(a) * ce, Math.sin(e));
        gl.uniform3f(fxglU(pr, 'uColor'), rgb[0], rgb[1], rgb[2]);
        gl.uniform3f(fxglU(pr, 'uTint'), tint[0], tint[1], tint[2]);
        gl.uniform1f(fxglU(pr, 'uIntensity'), p.intensity / 100);
        gl.uniform1f(fxglU(pr, 'uSpec'), p.spec / 100);
        gl.uniform1f(fxglU(pr, 'uGloss'), p.gloss / 100);
        gl.uniform1f(fxglU(pr, 'uGreen'), p.green === 'down' ? -1 : 1);
        gl.uniform1f(fxglU(pr, 'uShadow'), march ? p.shadow / 100 : 0);
        gl.uniform1f(fxglU(pr, 'uNearBright'), p.near === 'bright' ? 1 : 0);
        gl.uniform1f(fxglU(pr, 'uPenumbra'), p.soft / 100);
        // 走线的方向 = 朝光源那一边,与 uL.xy 同一条基;位移按本层像素计,所以除以自己的宽高。
        // 每步的抬高量 = tan(Elev) × 步长,单位与高度图同一个量纲(整张图的深度满幅 = 1)。
        gl.uniform2f(fxglU(pr, 'uStep'), Math.cos(a) * stepPx / fxgl.w, -Math.sin(a) * stepPx / fxgl.h);
        gl.uniform1f(fxglU(pr, 'uGain'), stepPx * Math.tan(e) / fxgl.w);
        gl.uniform1i(fxglU(pr, 'uSteps'), steps);
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
    desc: 'Relights the layer through a bound tangent-space normal map \u2014 a diffuse term around the light direction plus an optional specular highlight, both taking the light\u2019s own colour. Bind a depth map as well and the same light is marched across it as a height field: whatever stands between the light and a pixel cuts it down, multiplied by the shadow tint. Colour only: the maps never show through, nothing moves, alpha untouched.',
    params: [
        { key: 'map', kind: 'map', def: null },
        { key: 'angle', label: 'Angle', min: 0, max: 359, step: 1, def: 135, unit: '°' },
        { key: 'elev', label: 'Elev', min: 0, max: 90, step: 1, def: 45, unit: '°' },
        { key: 'intensity', label: 'Light', min: -100, max: 100, step: 1, def: 50, unit: '%' },
        { key: 'spec', label: 'Spec', min: 0, max: 100, step: 1, def: 25, unit: '%' },
        { key: 'gloss', label: 'Gloss', min: 0, max: 100, step: 1, def: 60, unit: '%' },
        { key: 'color', label: 'Color', kind: 'color', def: '#ffffff' },
        { key: 'depth', kind: 'map', def: null },
        { key: 'shadow', label: 'Shadow', min: 0, max: 100, step: 1, def: 0, unit: '%' },
        { key: 'cast', label: 'Cast', min: 1, max: 64, step: 1, def: 16, unit: 'px' },
        { key: 'soft', label: 'Soft', min: 0, max: 50, step: 1, def: 15, unit: '%' },
        { key: 'tint', label: 'Tint', kind: 'color', def: '#000000' },
        { key: 'near', label: 'Near', kind: 'enum', options: ['dark', 'bright'], def: 'dark' },
        { key: 'green', label: 'Green', kind: 'enum', options: ['up', 'down'], def: 'up' },
    ],
    shaders: { light: FX_FS_LIGHT },
    run: fxglLight,
    readout(p, n, effect) {
        const base = `${fxMapShort(effect)}  ${n(p.angle)}°  ${n(p.elev)}°  ${n(p.intensity)}%  s${n(p.spec)}`;
        // 阴影开着却读不出影子 = 深度图没绑,把那张图的名字写出来 = 可见文本,不许静默降级。
        // 两头缺的各说各的名字 (fxMapShort 按槽的角色报 no normal / no depth),不会混成一句。
        if (p.shadow <= 0) return base;
        return `${base}  sh${n(p.shadow)}  ${fxMapShort(effect, 'depth')}`;
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
