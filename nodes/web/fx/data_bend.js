// fx/data_bend.js —— 特效链的一类特效:注册数据 + 着色器 + pass + 读数 + 缩略图 (Glitch 组)。
// Data Bending:拿十六进制编辑器把图片文件的**字节**改掉一段,再让解码器把改过的文件读回来 —— 出来的
// 画面不是滤镜算出来的,是解码器被喂了错字节之后**照自己的规矩重建**的结果。这一族的四种样子各有成因:
//   * Raw  —— 未压缩流 (BMP / 裸 ARGB) 里改一段:一行就是一串连续字节,所以那一行整体错位,行尾绕回
//            行首;错位量不是 4 的整倍时 BGRA 四个平面彼此串一格 ⇒ "形状还在, 颜色与不透明度整段跑偏"。
//   * JPEG —— 熵编码段被改:MCU 拿到的是别的块的系数 ⇒ 块整块从别处搬来,而 Y 与 Cb/Cr 各搬到不同的块
//            (4:2:0 本来就把三个平面摊在同一段字节里),量化表再错位成阶梯色。
//   * PNG  —— 行滤波器 (Sub / Up / Average / Paeth) 的那个字节被改:这一行按**错的那一行**当参考重建
//            ⇒ 画面成为两行之和 (鬼影),而三个通道各读到不同行的字节 ⇒ 斜向拖色。
//   * Xor  —— 一段字节异或常量:落在哪个平面就把那个平面整段翻色,落在 alpha 就直接打穿成洞。
// 这四档在这里是**腐蚀模型**,不是真编解码器:真字节那条路要 toDataURL 编码 (同步) 再把结果解码回来
// (异步),而特效链的执行路径全程同步 (见 fx/maps.js 里那句"取不到就顺手起一次解码、这一次先返回 null")
// —— 于是拖动滑块的每一帧都要等一次解码,预览与提交还不是同一份算式。这一版按模型在 GPU 上算,一趟
// 1~3 次抽样,预览 = 提交。
// 三条契约的落点:① 搬来源位置只在**本层网格内**绕回或让开 (字节流行内错位就是绕回,不是外扩),出界
// 没有源 = 透明;② alpha 随模型走 —— Raw 与 Xor 动的就是包括 A 的那个字节流,所以它们把 alpha 一起搬、
// 一起翻;JPEG 根本没有 alpha 通道、PNG 的加法重建加的是颜色,所以这两档本像素的不透明度原样;
// ③ 不读蒙版。

const DB_MODELS = ['Raw', 'JPEG', 'PNG', 'Xor'];
const DB_AXES = ['rows', 'columns'];
const DB_WHERE = ['Anywhere', 'By map'];

// 沿流方向 (along) 与垂直方向 (across) 是本族唯一的一对坐标:字节流先走完一行再走下一行,所以
// "错开几个字节" 天生是 along 方向的事, 而"哪几条带被改" 是 across 方向的事。两个轴只是把这对名字
// 互换,于是四种模型的走线各只有一份代码。
const FX_FS_BEND = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 Frag;
uniform sampler2D uTex;
uniform sampler2D uMap;
uniform vec2 uSize;
uniform int uModel;
uniform int uAxis;
uniform float uBands;
uniform float uAmount;
uniform float uBlock;
uniform float uSkew;
uniform float uLevels;
uniform float uCover;
uniform float uSeed;
uniform float uByMap;
ivec2 dbAt(float along, float across) {
    return uAxis == 0 ? ivec2(int(round(along)), int(round(across)))
                      : ivec2(int(round(across)), int(round(along)));
}
// 出界 = 没有源 ⇒ 透明 (不让 CLAMP_TO_EDGE 把最外圈抹成一条假边)。
vec4 dbFetch(float along, float across) {
    ivec2 p = dbAt(along, across);
    if (p.x < 0 || p.y < 0 || p.x >= int(uSize.x) || p.y >= int(uSize.y)) return vec4(0.0);
    return texelFetch(uTex, p, 0);
}
float dbHash(vec2 p) {
    p = fract(p * vec2(0.1031, 0.1030));
    p += dot(p, p + 23.13);
    return fract(p.x * p.y * 45.73);
}
// 未压缩流的字节错位:错位量 mod 4 = 几个平面彼此串了一格。r=1 就是"A 的字节被喂给了 R"。
vec4 dbRot4(vec4 c, int r) {
    if (r == 1) return vec4(c.a, c.r, c.g, c.b);
    if (r == 2) return vec4(c.b, c.a, c.r, c.g);
    if (r == 3) return vec4(c.g, c.b, c.a, c.r);
    return c;
}
vec3 dbToYcbcr(vec3 c) {
    float y = dot(c, vec3(0.299, 0.587, 0.114));
    return vec3(y, (c.b - y) * 0.565, (c.r - y) * 0.713);
}
vec3 dbFromYcbcr(vec3 v) {
    return vec3(v.x + 1.403 * v.z, v.x - 0.344 * v.y - 0.714 * v.z, v.x + 1.770 * v.y);
}
// 量化表错位读成"级数不对":级数越少,阶梯越粗 (2 = 每通道就两档)。
float dbQuant(float x) { return floor(x * uLevels + 0.5) / uLevels; }
void main() {
    ivec2 tc = ivec2(gl_FragCoord.xy);
    vec4 own = texelFetch(uTex, tc, 0);
    float along  = uAxis == 0 ? float(tc.x) : float(tc.y);
    float across = uAxis == 0 ? float(tc.y) : float(tc.x);
    float span   = uAxis == 0 ? uSize.x : uSize.y;   // 一条流上有几个像素 (= 一行的字节数 / 4)
    float aspan  = uAxis == 0 ? uSize.y : uSize.x;
    // 哪几条带被改:带号由 across 位置算出,于是同一带里的字节错位量**完全相同** —— 那正是"改掉一段
    // 连续字节"的样子,而不是逐像素随机。
    float band = floor(across * uBands / max(aspan, 1.0));
    float gate = uCover * (uByMap > 0.5 ? texture(uMap, vUV).r : 1.0);
    if (dbHash(vec2(band, uSeed)) >= gate) { Frag = own; return; }
    // 这条带的错位量 (整数个像素):正负都有, 所以向左与向右搬的带在同一条画面里共存。
    float sh = round((dbHash(vec2(band, uSeed + 7.3)) * 2.0 - 1.0) * uAmount);

    if (uModel == 0) {
        // Raw:整行按 sh 个像素绕回, 再按 sh mod 4 把四个平面串一格。搬的是整颗像素, 所以不透明度
        // 跟着颜色一起跑 (契约②的这一侧)。
        vec4 c = dbFetch(mod(along - sh, span), across);
        Frag = dbRot4(c, int(mod(sh, 4.0)));
        return;
    }
    if (uModel == 1) {
        // JPEG:块整块从别处搬 (nb 个块), 而色度比亮度再多搬 Skew 折的那几块 ⇒ 颜色糊到邻居块上。
        // 亮度取自搬过的块、色度取自多偏那一块, 各自量化 —— 三次抽样 (own + 2)。
        float nb = round(sh / uBlock);
        float nc = nb + round(uSkew * 0.03);      // Skew 0..100 → 色度最多再多搬 3 个块
        vec3 y1 = dbToYcbcr(dbFetch(along - nb * uBlock, across).rgb);
        vec3 y2 = dbToYcbcr(dbFetch(along - nc * uBlock, across).rgb);
        Frag = vec4(clamp(dbFromYcbcr(vec3(dbQuant(y1.x), dbQuant(y2.y), dbQuant(y2.z))), 0.0, 1.0), own.a);
        return;
    }
    if (uModel == 2) {
        // PNG:这一行加到**错的那一行**上 (滤波器字节被改 ⇒ 参考行读错)。R 读偏上/偏左那一条、B 读
        // 偏下/偏右那一条、G 取两者之中 ⇒ 鬼影之上再叠一层斜向拖色。参考行至少错开 1 (sh 恰好为 0 的
        // 带也要长出鬼影, 否则这一档在画面上读成"没生效")。
        float d = (sh < 0.0 ? -1.0 : 1.0) * max(abs(sh) * 0.5, 1.0);
        vec3 a = dbFetch(along, across - d).rgb;
        vec3 b = dbFetch(along, across + d).rgb;
        Frag = vec4(clamp(vec3(own.r + a.r - 0.5,
                               own.g + (a.g + b.g) * 0.5 - 0.5,
                               own.b + b.b - 0.5), 0.0, 1.0), own.a);
        return;
    }
    // Xor:一段连续字节 (Block 个像素) 异或同一个常量 ⇒ 落在哪个平面, 那个平面整段翻色。
    // 平面 3 = alpha:翻 alpha 就是打穿成洞 / 把透明处填上, 这一档因此和 Raw 一样动不透明度。
    int plane = int(floor(dbHash(vec2(floor(along / uBlock) + band * 7.0, uSeed + 3.1)) * 4.0));
    vec4 c = own;
    if (plane == 0) c.r = 1.0 - c.r;
    else if (plane == 1) c.g = 1.0 - c.g;
    else if (plane == 2) c.b = 1.0 - c.b;
    else c.a = 1.0 - c.a;
    Frag = clamp(c, 0.0, 1.0);
}`;

// ==================== pass ====================
// 四种模型共用一次 pass、同一个 main():模型分支在着色器里,所以换模型不换缓冲、不加趟数。
// 搬来源位置全部在本层网格内 (Raw 绕回, 其余出界取透明) ⇒ 输出网格 === 输入网格 (契约①)。
function fxglDataBend(col, p) {
    if (p.coverage <= 0) return;                 // 一条带都不改 = 画面原样, 不必占用一次 pass
    const gl = fxgl.gl;
    const dst = fxgl.off[1 - col.slot];
    fxglRunPass(dst, fxgl.progs.dataBend, pr => {
        fxglBindTex(pr, 'uTex', fxgl.off[col.slot].tex, 0);
        // 采样器不许指着没分配过层级的纹理 (同 fx/lighting.js、fx/pixel_sort.js):不读图时把色彩面借给它。
        fxglBindTex(pr, 'uMap', p.where === 'By map' ? fxgl.texMap : fxgl.off[col.slot].tex, 1);
        gl.uniform2f(fxglU(pr, 'uSize'), fxgl.w, fxgl.h);
        gl.uniform1i(fxglU(pr, 'uModel'), Math.max(0, DB_MODELS.indexOf(p.model)));
        gl.uniform1i(fxglU(pr, 'uAxis'), DB_AXES.indexOf(p.axis));
        gl.uniform1f(fxglU(pr, 'uBands'), Math.max(1, p.bands | 0));
        gl.uniform1f(fxglU(pr, 'uAmount'), p.amount);
        gl.uniform1f(fxglU(pr, 'uBlock'), Math.max(1, p.block));
        gl.uniform1f(fxglU(pr, 'uSkew'), p.skew);
        gl.uniform1f(fxglU(pr, 'uLevels'), Math.max(2, p.levels | 0));
        gl.uniform1f(fxglU(pr, 'uCover'), p.coverage / 100);
        gl.uniform1f(fxglU(pr, 'uSeed'), p.seed);
        gl.uniform1f(fxglU(pr, 'uByMap'), p.where === 'By map' ? 1 : 0);
    });
    col.slot = 1 - col.slot;
}

// ==================== 参数区 ====================
// 一格一个 Data Bend:Model 用分段钮 (与 Warp / 色散同一套控件词汇),下面只铺该模型要用的行 ——
// Block 只有 JPEG 与 Xor 读它,Skew/Levels 只有 JPEG 读它,摆着不生效的行一律不铺。
// 代价 (每像素几次抽样) 写在 Model 那行的 tooltip 里:读数那格是给人看效果的, 不是看账单的。
const DB_PARAMS = [
    { key: 'model', label: 'Model', kind: 'enum', options: DB_MODELS, def: 'Raw',
        tip: 'Which decoder gets fed the wrong bytes. Taps per pixel: Raw 1, Xor 1, JPEG 3, PNG 3.' },
    { key: 'axis', label: 'Stream', kind: 'enum', options: DB_AXES, def: 'rows' },
    { key: 'bands', label: 'Bands', min: 1, max: 32, step: 1, def: 8,
        tip: 'How many slices the file is cut into across the stream. One shift value per band.' },
    { key: 'amount', label: 'Shift', min: 1, max: 96, step: 1, def: 16, unit: 'px' },
    { key: 'coverage', label: 'Chance', min: 0, max: 100, step: 1, def: 60, unit: '%' },
    { key: 'seed', label: 'Seed', min: 0, max: 999, step: 1, def: 0 },
    { key: 'block', label: 'Block', min: 2, max: 32, step: 1, def: 8, unit: 'px',
        when: p => p.model === 'JPEG' || p.model === 'Xor' },
    { key: 'skew', label: 'Skew', min: 0, max: 100, step: 1, def: 35, unit: '%',
        when: p => p.model === 'JPEG' },
    { key: 'levels', label: 'Levels', min: 2, max: 64, step: 1, def: 20,
        when: p => p.model === 'JPEG' },
    { key: 'where', label: 'Where', kind: 'enum', options: DB_WHERE, def: 'Anywhere' },
    { key: 'map', kind: 'map', def: null, when: p => p.where === 'By map' },
];

function dbEditorEl(l, effect, syncRead, updaters) {
    const box = document.createElement('div');
    box.className = 'fx-bend';
    const tail = document.createElement('div');
    tail.className = 'fx-bend-tail';
    const build = () => {
        const p = effectParams(effect);
        tail.replaceChildren(...DB_PARAMS
            .filter(d => d.key !== 'model' && (!d.when || d.when(p)))
            .map(d => fxControlRow(l, effect, d, syncRead, updaters)));
        syncRead();
    };
    // 模式行只多接一句「换完模型重铺剩下的行」—— 与 fx/warp.js、fx/chromatic_aberration.js 同一包法。
    box.appendChild(fxControlRow(l, effect, DB_PARAMS[0], () => { build(); }, updaters));
    box.appendChild(tail);
    build();
    return box;
}

defineEffect({
    type: 'data_bend',
    label: 'Data Bending',
    group: 'Glitch',
    icon: 'bend',
    needsMap: 'Noise',
    needsMapWhen: p => p.where === 'By map',
    desc: 'Corrupts the picture the way a decoder does when a file\u2019s bytes are edited before it reads them \u2014 four corruption models, one per format: Raw shifts a whole line of an uncompressed stream around and rotates the four planes by whatever is left over 4, so colour and opacity both slide out of place; JPEG copies 8\u00b7ish-pixel blocks in from elsewhere while chroma lands on a further block than luma (Skew) and the whole thing is re-quantised to Levels steps; PNG adds this row to the wrong reference row, which ghosts the image and drags each channel to a different row; Xor flips one plane (Red, Green, Blue or Alpha) inside each Block of bytes, so alpha can be punched straight through. Bands cuts the file that many ways across the stream, Shift is how far a corrupted run slides, Chance is how many of those bands get hit at all, and By map lets a bound map say which pixels may be bent. Raw and Xor move or flip opacity because that is what they do to the byte stream; JPEG and PNG leave this pixel\u2019s own opacity alone.',
    params: DB_PARAMS,
    editor: dbEditorEl,
    shaders: { dataBend: FX_FS_BEND },
    run: fxglDataBend,
    readout(p, n, effect) {
        let s = `${p.model.toLowerCase()}  ${p.axis === 'rows' ? 'h' : 'v'}  `
            + `b${n(p.bands)}  s${n(p.amount)}  ${n(p.coverage)}%`;
        // Block 只有 JPEG 与 Xor 读它,Skew/Levels 只有 JPEG 读它 —— 与面板上铺的那几行同一判据。
        if (p.model === 'JPEG') s += `  B${n(p.block)}  q${n(p.levels)}  sk${n(p.skew)}`;
        else if (p.model === 'Xor') s += `  B${n(p.block)}`;
        if (p.where === 'By map') s += `  ${fxMapShort(effect)}`;
        return s;
    },
    thumb(g, box) {
        // 横着几条带:有的原样, 有的整带平移 (带里能看见一个方块被搬走后又串了色), 有的翻色 ——
        // "改的是连续一段字节" 因此读成一条一条的带, 不是逐像素的雪花。
        const x = box.x, y = box.y, w = box.w, h = box.h;
        const bands = 5;
        for (let i = 0; i < bands; i++) {
            const by = y + h * i / bands;
            const bh = h / bands;
            g.fillStyle = '#2b3350';
            g.fillRect(x + 2, by + 1, w - 4, bh - 2);
            g.fillStyle = '#8fa2ff';
            const off = [0, -w * 0.22, w * 0.15, 0, -w * 0.1][i];
            g.fillRect(x + w * 0.3 + off, by + bh * 0.28, w * 0.24, bh * 0.44);
            if (i === 1 || i === 4) {
                g.fillStyle = 'rgba(255,120,60,0.75)';
                g.fillRect(x + w * 0.55 + off, by + bh * 0.2, w * 0.14, bh * 0.6);
            }
            if (i === 2) {
                g.fillStyle = 'rgba(255,255,255,0.5)';
                g.fillRect(x + 2, by + 1, w - 4, bh - 2);
            }
        }
    },
});
