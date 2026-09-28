// ==================== 图层特效链 (layer effect chain) ====================
// 一条挂在图层上的特效链,在 decal 之后、蒙版乘法之前执行。三条契约是整个模块的地基:
//   * footprint-neutral —— 输出的像素尺寸 === 输入,一个像素都不外扩。图层的蒙版是按**自身像素
//     网格**单独送到后端,并靠 layerCompositeForGenerate 的反解 transform 与图层对齐;外扩一次,
//     那条对齐就废了。注意这条钉的是**网格**,不是"像素不许长到形状之外":外阴影就是把 alpha 长进
//     同一张网格里本来透明的像素,合法,但影子到图层框边就被切掉(PS 能无限往外拖,这里不能)。
//   * alpha 跟着画面走 —— 低通/运动模糊/马赛克把 A 和 RGB 一起滤波(抽样预乘累加、直通色归一,
//     alpha 输出同一组抽样的均值):对文字这类「形状就是 alpha」的层,不软化不透明度就等于没特效。
//     出口 alpha 是该层**新的源不透明度**;蒙版仍独立存档,后端 `image * mask` 依旧只乘一次,
//     不会把软边乘成平方。曲线/内阴影/光照/泛光不碰 alpha;外阴影会加 alpha(见上一条)。
//   * 蒙版只当输入读、不当输出用 —— silhouette = 图层 alpha × 蒙版 alpha,特效据此计算,但结果
//     不裁进输出。所以「阴影只出现在蒙版内的边缘」是这三条的推论,不是一个可以关掉的选项。
//     外阴影的形状故意**只取图层 alpha**:蒙版链外还要整体乘一次,吃过一遍就成了平方。
// 计算走 WebGL2:dual-filtering(Kawase)近似低通、沿方向的定长抽样运动模糊、内阴影 = 轮廓偏移
// + 虚化 + 裁回自身轮廓、马赛克 = 折进格心的 3×3 平色块、曲线 = 显示值空间的黑白点/gamma/S 形
// 对比、景深 = 深度图驱动的三档低通按像素混档、光照 = 切线空间法线图上的漫反射 + Blinn-Phong 高光。
// 模糊类 (含景深) 同时吃 RGB 与 A,曲线/内阴影/光照只写 RGB;三条契约对全部特效成立。整链只在图层
// 的 img/decal/mask/参数任一换过之后重算一次(见 fxResolved)。
// 吃外部图的特效(dof / lighting)在 params 里只存一句 {key, name} 引用:图池 id 或本地池 id,
// 像素永远不进 params —— 那玩意儿要进签名、进 undo 深拷贝、进存档。
//
// 文件切分:本文件只装「链的模型」(注册表容器 + 参数/克隆/签名/旁路)。每类特效自己一个
// fx/<effect>.js,里面齐活:注册数据 + 着色器 + pass + 子行读数 + picker 缩略图;引擎在 fx/gl.js,
// 绑定贴图在 fx/maps.js,行/弹窗在 fx/ui.js。加一类特效 = 写一个文件 + 在页面里加一行 <script src>。

// 注册表由 fx/<effect>.js 的 defineEffect() 填。picker 里的顺序 = 注册顺序,所以页面的 <script>
// 列表按组排 (Shadow → Blur → Pixelate → Color → Light)。字段约定:
//   type/label/group/icon/desc/params —— 注册数据 (参数行、默认值、白名单迁移都读它)
//   needsMap: 'Depth' | 'Normal' —— GL 侧据此上传贴图, UI 据此渲染绑定行
//   shaders: { progName: fragmentSource } —— fxglInit 统一编译进 fxgl.progs
//   run(col, p) —— 就地改写色彩乒乓, 自己翻转 col.slot; 跑不了就写 fxgl.skip 说原因
//   readout(p, n, effect) / thumb(g, box) —— 子行读数与 picker 缩略图 (取景框由 UI 备好)
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
    const out = {};
    for (const p of effectParamDefs(effect.type)) {
        const v = effect.params && effect.params[p.key];
        out[p.key] = (v === undefined || v === null) ? p.def : v;
    }
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

// 一个图层能不能挂特效:detailer 回填的贴片(fragment)带着 crop rect 和工作分辨率,语义不清,
// 一律不给挂;空白手搓面允许(它有分辨率,只是还没有像素)。
function layerTakesEffects(l) {
    return !!l && !l.isMaskLayer && !l.fragment;
}

// 整链旁路:视图级开关,用来看「加特效前」的原样对比。它不写 undo、不进图层存档,但必须同时被
// 画布路径和采样路径读到 —— 否则会出现画布上关了、送进 detailer 还开着的分裂。
let effectsBypass = false;
const EFFECTS_BYPASS_KEY = 'blend.effectsBypass';
try { effectsBypass = localStorage.getItem(EFFECTS_BYPASS_KEY) === '1'; } catch (e) { /* private mode: default off */ }

function activeEffects(l) {
    if (effectsBypass || !layerTakesEffects(l) || !l.effects || !l.effects.length) return [];
    return l.effects.filter(e => e && e.enabled && EFFECT_TYPES[e.type]);
}

function fxSignature(l) {
    if (!l.effects || !l.effects.length) return '';
    return JSON.stringify([effectsBypass ? 0 : 1, l.effects.map(e => [e.type, e.enabled ? 1 : 0, e.params])]);
}

function setEffectsBypass(on) {
    effectsBypass = !!on;
    try { localStorage.setItem(EFFECTS_BYPASS_KEY, effectsBypass ? '1' : '0'); } catch (e) { /* session only */ }
    invalidateAllFx();
}

