// fx/lighting.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图。
// 它绑一张法线图 (needsMap),引用的解析规则见 fx/maps.js。

// 光照:切线空间法线图(uv 基:y 向上,因为上传时已 UNPACK_FLIP_Y;平坦处 = (0.5,0.5,1))做
// Lambert 漫反射 + Blinn-Phong 高光。绿色通道的朝向按贴图族选(OpenGL 朝上 / DirectX 朝下)。
// 只改 RGB:高光加在色上,阴影乘在色上,贴图本身永远不渗进画面。
const FX_FS_LIGHT = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uMap;
uniform vec3 uL;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uSpec;
uniform float uGloss;
uniform float uGreen;
void main() {
    vec4 c = texture(uTex, vUV);
    vec3 n = texture(uMap, vUV).xyz;
    n = vec3(n.x * 2.0 - 1.0, (n.y * 2.0 - 1.0) * uGreen, max(n.z * 2.0 - 1.0, 0.05));
    n = normalize(n);
    float diff = max(dot(n, uL), 0.0);
    vec3 h = normalize(uL + vec3(0.0, 0.0, 1.0));
    float s = pow(max(dot(n, h), 0.0), mix(6.0, 220.0, uGloss)) * uSpec;
    vec3 lit = c.rgb * clamp(1.0 + uIntensity * (diff - 0.45), 0.0, 3.0) + uColor * s;
    Frag = vec4(clamp(lit, 0.0, 1.0), c.a);
}`;

function fxglLight(col, p) {
    const gl = fxgl.gl;
    const a = p.angle * Math.PI / 180, e = p.elev * Math.PI / 180, ce = Math.cos(e);
    const rgb = fxHexToRgb01(p.color);
    const dst = fxgl.off[1 - col.slot];
    fxglRunPass(dst, fxgl.progs.light, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        fxglBindTex(pr, 'uMap', fxgl.texMap, 1);
        // 光朝向量的基与法线图一致:画布角(0° 右、90° 下)映到 uv 时 y 取负,和 fxglDirUV 同一条
        // 规矩;z = sin(elev) 朝屏幕外,elev=90° 即正对打光。
        gl.uniform3f(fxglU(pr, 'uL'), Math.cos(a) * ce, -Math.sin(a) * ce, Math.sin(e));
        gl.uniform3f(fxglU(pr, 'uColor'), rgb[0], rgb[1], rgb[2]);
        gl.uniform1f(fxglU(pr, 'uIntensity'), p.intensity / 100);
        gl.uniform1f(fxglU(pr, 'uSpec'), p.spec / 100);
        gl.uniform1f(fxglU(pr, 'uGloss'), p.gloss / 100);
        gl.uniform1f(fxglU(pr, 'uGreen'), p.green === 'down' ? -1 : 1);
    });
    col.slot = 1 - col.slot;
}

defineEffect({
    type: 'lighting',
    label: 'Lighting',
    group: 'Light',
    icon: 'light',
    needsMap: 'Normal',
    desc: 'Relights the layer through a bound tangent-space normal map \u2014 a diffuse term around the light direction plus an optional specular highlight. Colour only: the map never shows through, nothing moves, alpha untouched.',
    params: [
        { key: 'map', label: 'Map', kind: 'map', def: null },
        { key: 'angle', label: 'Angle', min: 0, max: 359, step: 1, def: 135, unit: '°' },
        { key: 'elev', label: 'Elev', min: 0, max: 90, step: 1, def: 45, unit: '°' },
        { key: 'intensity', label: 'Light', min: -100, max: 100, step: 1, def: 50, unit: '%' },
        { key: 'spec', label: 'Spec', min: 0, max: 100, step: 1, def: 25, unit: '%' },
        { key: 'gloss', label: 'Gloss', min: 0, max: 100, step: 1, def: 60, unit: '%' },
        { key: 'color', label: 'Color', kind: 'color', def: '#ffffff' },
        { key: 'green', label: 'Green', kind: 'enum', options: ['up', 'down'], def: 'up' },
    ],
    shaders: { light: FX_FS_LIGHT },
    run: fxglLight,
    readout(p, n, effect) {
        return `${fxMapShort(effect)}  ${n(p.angle)}°  ${n(p.elev)}°  ${n(p.intensity)}%  s${n(p.spec)}`;
    },
    thumb(g, box) {
        const cx = box.x + box.w / 2, cy = box.y + box.h / 2, r = Math.min(box.w, box.h) / 2;
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
