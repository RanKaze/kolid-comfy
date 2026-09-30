// ==================== 图层特效链 (layer effect chain) ====================
// 特效链是图层 attribute 条带上的一类节点:它在**自己那个位置**执行,吃的是它左边那些 attribute 累加
// 出来的那张面。整条管线因此不再有一条固定顺序 —— 顺序归图层排 (见 attr/core.js),链只在条带上说话。
// 三条契约是整个模块的地基:
//   * footprint-neutral —— 输出的像素尺寸 === 输入,一个像素都不外扩。图层的蒙版是按**自身像素
//     网格**单独送到后端,并靠 layerCompositeForGenerate 的反解 transform 与图层对齐;外扩一次,
//     那条对齐就废了。注意这条钉的是**网格**,不是"像素不许长到形状之外":外阴影、Outside 描边与锈蚀
//     的漏色都是把 alpha 长进同一张网格里本来透明的像素,合法,但一到图层框边就被切掉(PS 能无限往外
//     拖,这里不能) —— 想要那份余量就把该层自己的网格做大:文字层有 Padding,位图层目前没有旋钮。
//   * alpha 跟着画面走 —— 低通/运动模糊/马赛克把 A 和 RGB 一起滤波(抽样预乘累加、直通色归一,
//     alpha 输出同一组抽样的均值):对文字这类「形状就是 alpha」的层,不软化不透明度就等于没特效。
//     出口 alpha 是该层**新的源不透明度**;蒙版按它在条带上的位置各乘一次,后端不会再来第二次,
//     所以软边不会被乘成平方。曲线/色调/内阴影/光照/泛光/色散不碰 alpha;外阴影与 Outside 描边会加 alpha(见上一条);
//     锈蚀则两头都动 —— 把 alpha 咬穿成洞,又在洞的四周长出锈色 (它同时是「重塑不透明度」那一族的一员)。
//   * 蒙版只当输入读、不当输出用 —— silhouette = 图层 alpha × **该链左边那些蒙版与起来的**覆盖率,
//     特效据此计算,但结果不额外往输出上裁。左边没有蒙版就当纯白 (= 图层自己的 alpha)。所以
//     「阴影只出现在蒙版内的边缘」是这三条的推论,不是一个可以关掉的选项。
//     外阴影、描边与锈蚀的形状故意**只取图层 alpha**:它们要的是形状自己的轮廓,乘过蒙版就成了平方。
// 计算走 WebGL2:dual-filtering(Kawase)近似低通、沿方向的定长抽样运动模糊、内阴影 = 轮廓偏移
// + 虚化 + 裁回自身轮廓、描边 = jump flooding 出到自身轮廓的距离场再判 d ≤ Size、
// 锈蚀 = 形状低通当边缘闸门 × 噪声场定破洞、再把破洞掩码低通成渗色圈、
// 马赛克 = 折进格心的 3×3 平色块、曲线 = 显示值空间的一张 PS 式点曲线查表、
// 色调映射 = 线性光上的一张单调响应曲线(Neutral/ACES/Custom)或一张外部查找表、
// 景深 = 深度图驱动的三档低通按像素混档、光照 = 切线空间法线图上的漫反射 + Blinn-Phong 高光,再叠一张
// 从深度图烘出的高度场沿光源方向走线得到的 shadow mask(影长 = Δh·Scale/tan(Elev),Soft 是它的半影半径)、
// 体积霾 = 沿视线步进到深度图报出的那个面,逐步按取样点的高度取浓度、前向累进吸收与散射 (朝向 Sun
// 的 Henyey-Greenstein 相位、色散 = 红与蓝各从偏开半幅的位置取样而绿留在原地 (径向 / 方向 / 离焦
// 三路共用同一个偏移式子)、
// 像素排序 = 沿轴 (或沿射线) 在定长窗口内给 run 里的每个像素数一次名次再搬过去 (probe 面先烘 key 与
// 闸门, 排序那一趟每格只读一个纹素)、
// 数据弯曲 = 四种字节腐蚀模型在 GPU 上重建"解码器被喂了错字节"的结果 (行错位 / 块搬移 + 色度错位 /
// 参考行相加 / 按平面翻色)、
// 分色 = 分色点阵或 8×8 有序抖动驱动的通道位移 (与色散的分工: 那一家是连续的彩边, 这一家是碎开的网点)。
// 模糊类 (含景深) 同时吃 RGB 与 A,曲线/色调/内阴影/光照/泛光/体积霾/色散/分色只写 RGB,外阴影与描边加 alpha,锈蚀
// 既咬穿 alpha 又在破洞四周加 alpha;像素排序搬整颗像素所以不透明度跟着拖走,数据弯曲按模型分两头
// (Raw 与 Xor 动的就是含 A 的那个字节流 ⇒ 一起搬/一起翻,JPEG 与 PNG 保住本像素自己的不透明度);
// 三条契约对全部特效成立。一条链只在它所属的 attribute (面、链、
// 参数任一) 或整条 strip 的形状换过之后重算一次(见 fxResolved)。
// 吃外部图的特效(dof / fog / lighting / warp 的 Geometry / tone 的 External / corrosion 的 Texture /
// chromatic_aberration 的 Depth / pixel_sort、data_bend、rgb_split 的 By map)在 params 里只存一句
// {key, name} 引用:图池 id 或本地池 id,像素永远不进 params —— 那玩意儿要进签名、进 undo 深拷贝、进存档。
//
// 文件切分:本文件只装「链的模型」(注册表容器 + 参数/克隆/签名/旁路)。每类特效自己一个
// fx/<effect>.js,里面齐活:注册数据 + 着色器 + pass + 子行读数 + picker 缩略图;引擎在 fx/gl.js,
// 绑定贴图在 fx/maps.js,行/弹窗在 fx/ui.js。加一类特效 = 写一个文件 + 在页面里加一行 <script src>。

// 注册表由 fx/<effect>.js 的 defineEffect() 填。picker 里的顺序 = 注册顺序,所以页面的 <script>
// 列表按组排 (实际注册序:Shadow → Blur → Pixelate → Color → Distort → Grunge → Light → Glitch)。字段约定:
//   type/label/group/icon/desc/params —— 注册数据 (参数行、默认值、白名单迁移都读它)
//   needsMap: 'Depth' | 'Normal' | 'Lookup' | 'Noise' —— 主绑定槽 params.map,引擎上传到 fxgl.texMap
//   needsMapWhen(p) —— 可选:该模式是否真的需要主槽贴图。注册了 needsMap 却没写这句,就等于「随时都得有图」。
//   needsMap2: { key, role, optional } —— 第二张外部图 (params[key] → fxgl.texMap2,fxgl.hasMap2 说它
//     到没到位)。optional 缺省当可缺:主槽缺图整条跳过,副槽缺图照样 run,由特效自己退化。
//   needsMap2When(p) —— 同上,逐模式。UI 一格一个绑定行,槽位表由这两条推出来 (见 fx/maps.js 的 fxMapSlots)。
//   shaders: { progName: fragmentSource } —— fxglInit 统一编译进 fxgl.progs
//   run(col, p, effect, l) —— 就地改写色彩乒乓, 自己翻转 col.slot; 跑不了就写 fxgl.skip 说原因。
//     l 是该层自己 (几何也是输入之一: Canvas 对齐的深度读的是图层盒子在画布上的落点), 老特效不接就用
//   stamp(effect, l) —— 可选:该层缓存身份里除「像素 + params + 绑定贴图」之外还要认的那一句外部状态
//     (只有真要它的那种模式才回字符串, 其余一律空串, 不给别的图层添开销)
//   readout(p, n, effect) / thumb(g, box) —— 子行读数与 picker 缩略图 (取景框由 UI 备好)
//   migrate(raw, out) —— 参数换形状时把旧 raw 读成等价的 out, 只写 out 不动 raw (undo 共享它)
//   editor(l, effect, syncRead, updaters) —— 有它就整块接管参数区 (点曲线这类非滑块编辑面)
const EFFECT_TYPES = {};

function defineEffect(spec) {
    if (!spec || !spec.type || typeof spec.run !== 'function' || EFFECT_TYPES[spec.type]) {
        throw new Error('bad effect definition: ' + String(spec && spec.type));
    }
    EFFECT_TYPES[spec.type] = spec;
}

// 角度一律按画布坐标读:0° 指向右、90° 指向下(顺时针),单位是图层自身的像素。
let fxSeq = 0;

function effectParamDefs(type) {
    const spec = EFFECT_TYPES[type];
    return spec ? spec.params : [];
}

function effectParams(effect) {
    const spec = EFFECT_TYPES[effect.type];
    const out = {};
    for (const p of effectParamDefs(effect.type)) {
        const v = effect.params && effect.params[p.key];
        out[p.key] = (v === undefined || v === null) ? p.def : v;
    }
    // 参数换形状时,旧存档和 undo 快照里的特效靠 spec.migrate 读回等价值。它只往 out 里写、绝不
    // 碰 raw,所以历史快照永远不会被这次读取改写。
    if (spec && spec.migrate && effect.params) spec.migrate(effect.params, out);
    return out;
}

function makeEffect(type) {
    const params = {};
    for (const p of effectParamDefs(type)) params[p.key] = p.def;
    return { id: ++fxSeq, type, enabled: true, params };
}

// 链是纯数据(params 全是标量/短字符串),所以 undo 快照与 .cud 记录都拿得下这份深拷贝。它必须
// 是深拷贝:改一条参数的语义就是改这个数组里的对象,共享引用会让 undo 步骤跟着变。
function cloneEffects(list) {
    if (!list || !list.length) return [];
    return list.map(e => ({ id: e.id, type: e.type, enabled: !!e.enabled, params: { ...(e.params || {}) } }));
}

// 读入白名单:认不出的 type 丢掉(旧文件里被删掉的特效不该让整条链失效),参数按注册表补默认值,
// 于是加/改一个参数的默认值从不需要写一次迁移。链序原样保留 —— 它就是执行序。
function normalizeEffects(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const e of list) {
        if (!e || !EFFECT_TYPES[e.type]) continue;
        const id = Number.isInteger(e.id) && e.id > 0 ? e.id : ++fxSeq;
        out.push({ id, type: e.type, enabled: e.enabled !== false, params: effectParams({ type: e.type, params: e.params }) });
    }
    return out;
}
// 短成一行的读数,直接摆在子行上 —— 卡片信息用可见文本,不塞 tooltip。具体格式归各类特效自己
// (readout),这里只负责取参数、备好那个「整数就不写小数」的格式化器。
function describeEffect(effect) {
    const spec = EFFECT_TYPES[effect.type];
    if (!spec || !spec.readout) return '';
    const p = effectParams(effect);
    const n = v => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));
    return spec.readout(p, n, effect);
}

// 一个图层能不能挂特效:只有固定的 Mask 层不行 (它不是内容图层)。detailer 回填的贴片 (fragment)
// 一样能挂 —— 链算的就是该层自己那张网格,贴片网格和普通图层网格没有第二种规矩,它只是那块矩形
// 的**所属图层**,不是另一种图层;空白手搓面允许 (它有分辨率,只是还没有像素)。
function layerTakesEffects(l) {
    return !!l && !l.isMaskLayer;
}

// 整链旁路:视图级开关,用来看「加特效前」的原样对比。它不写 undo、不进图层存档,但必须同时被
// 画布路径和采样路径读到 —— 否则会出现画布上关了、送进 detailer 还开着的分裂。
let effectsBypass = false;
const EFFECTS_BYPASS_KEY = 'blend.effectsBypass';
try { effectsBypass = localStorage.getItem(EFFECTS_BYPASS_KEY) === '1'; } catch (e) { /* private mode: default off */ }

// `rec` 是那条链所属的 Effects attribute 记录。传了它就读它自己那条链 (条带上可以挂着好几枚容器);
// 不传读的是**最左边那一枚** —— 图层行的 UI 与所有老调用点都走这条,它们还不必理解 strip (S5 搬家)。
// 记录整枚停用 (ctrl+click,见 attr/core.js 的 toggleAttrEnabled) 时这条链一步都不跑,两条读法同认。
function activeEffects(l, rec) {
    if (effectsBypass || !layerTakesEffects(l)) return [];
    if (!rec) rec = findAttr(l, 'effects') || undefined;
    if (!rec || !attrEnabled(rec)) return [];
    const chain = rec.chain;
    if (!chain || !chain.length) return [];
    return chain.filter(e => e && e.enabled && EFFECT_TYPES[e.type]);
}

// 缓存身份的「链 + 顺序」那一维:整条 strip 的形状 (哪几种、什么顺序、每枚启用与否、参数)。
// 面不在这儿 —— 面按对象身份比 (见 fxResolved 的 attrs),所以拖顺序、换面、改参数都能各归各地脏。
function fxSignature(l) {
    const recs = attrRecordsOf(l);
    if (!recs.length) return '';
    return JSON.stringify([effectsBypass ? 0 : 1, recs.map(r => [
        r.type,
        r.enabled === false ? 0 : 1,
        r.chain ? r.chain.map(e => [e.type, e.enabled ? 1 : 0, e.params]) : 0,
    ])]);
}

// 有些特效的结果还取决于**链外**的状态:Canvas 对齐的深度 warp 读的是图层盒子在画布上的落点,而拖
// 图层既不改像素、也不改 params —— 于是 fxMapStamp 与签名全都察觉不到它变了。各家自己报一句 (只有
// 真要它的那种模式才回字符串),缓存身份才不会被一份过期的位移钉住。
function fxExternalStamp(l) {
    let s = '';
    for (const r of attrRecordsOf(l)) {
        if (!r.chain) continue;
        for (const e of activeEffects(l, r)) {
            const spec = EFFECT_TYPES[e.type];
            if (spec && spec.stamp) s += spec.stamp(e, l) + '|';
        }
    }
    return s;
}

function setEffectsBypass(on) {
    effectsBypass = !!on;
    try { localStorage.setItem(EFFECTS_BYPASS_KEY, effectsBypass ? '1' : '0'); } catch (e) { /* session only */ }
    invalidateAllFx();
}

