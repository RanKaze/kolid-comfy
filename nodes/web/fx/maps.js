// fx/maps.js —— 特效链绑定外部贴图的解析层:params 里那句 {key, name} 引用在这里变成一张解码好的
// <img>,GL 侧只看到像素。契约见 fx/core.js 顶部。

// ---- 特效绑定的外部贴图 (bound maps) ----
// 深度图/法线图进 params 的永远只是一句 {key, name}:params 要进 fxSignature(每次缓存判定都要
// JSON.stringify)、进 undo 深拷贝、进 .cud 记录 —— 往里塞几 MB 的 data URL,这三处全都垮掉。
// key 有两个来源:工作区图池的 id(staging_N,宿主镜像过来的),和本地池的 id(map_N,来自文件
// 选择或 .cud 资产)。两条路都只在这里解析成像素,GL 侧只看到一张已解码的 <img>。
// 引用对象一律整体替换、绝不原地改字段:cloneEffects 深拷贝只到 params 这一层,里面的 map 对象
// 是共享引用,原地写会把 undo 指着的旧步骤一起改掉。
// 一条特效可以占两个槽:主槽永远是 params.map(引擎传到 texMap,注册数据用 needsMap 声明它),
// 副槽由 spec.needsMap2 = {key, role} 报上来(引擎传到 texMap2,注册数据用 needsMap2 声明它)——
// 几何 warp 就是「深度 + 法线」两张图一起读。槽位表由注册数据推出来,所以下面每一个函数都按
// key 取引用,调用方不点名就还是主槽。
let fxMapSeq = 0;
let fxMapTagSeq = 0;
let fxSrcSeq = 0;
const fxMapPool = new Map();        // map_N -> { name, src }
const fxMapDecoded = new Map();     // src -> {} 解码中 | { img, tag } | { img: null } 解不开
const fxSrcIds = new Map();         // src -> 短号;缓存身份要用它,不能拿长字符串比

function fxSrcId(src) {
    let v = fxSrcIds.get(src);
    if (v === undefined) { v = ++fxSrcSeq; fxSrcIds.set(src, v); }
    return v;
}

// 该特效声明了哪几个槽 (主槽永远排第一:引擎按这个顺序决定「缺图就整条跳过」还是「缺图照样跑」)。
function fxMapSlots(effect) {
    const spec = effect && EFFECT_TYPES[effect.type];
    if (!spec) return [];
    const out = [];
    if (spec.needsMap) out.push({ key: 'map', role: spec.needsMap, when: spec.needsMapWhen, optional: false });
    if (spec.needsMap2) {
        out.push({ key: spec.needsMap2.key, role: spec.needsMap2.role,
            when: spec.needsMap2When, optional: spec.needsMap2.optional !== false });
    }
    return out;
}

function fxMapRef(effect, key) {
    const m = effect.params && effect.params[key || 'map'];
    return (m && typeof m.key === 'string' && m.key) ? m : null;
}

function fxMapSource(ref) {
    if (!ref || !ref.key) return null;
    const s = stagingItems.find(it => it && it.id === ref.key && it.src);
    if (s) return { src: s.src, name: ref.name || s.name || ref.key };
    const p = fxMapPool.get(ref.key);
    if (p && p.src) return { src: p.src, name: ref.name || p.name };
    return null;
}

// 解码是异步的,而链的执行路径全程同步(它跑在 render 里)。所以这里「取不到就顺手起一次解码、
// 这一次先返回 null」:该特效这次跳过,图到位后 invalidateAllFx 会把链重算出来。
function fxMapImage(ref) {
    const found = fxMapSource(ref);
    if (!found) return null;
    const hit = fxMapDecoded.get(found.src);
    if (hit) return hit.img || null;
    fxMapDecoded.set(found.src, {});
    loadImage(found.src,
        img => { fxMapDecoded.set(found.src, { img, tag: ++fxMapTagSeq }); invalidateAllFx(); },
        () => { fxMapDecoded.set(found.src, { img: null }); invalidateAllFx(); });
    return null;
}

// 图池条目会在 id 不变的情况下原地换像素(Guidance 卡重发布就是这样),而解码到位的先后也不在
// params 里 —— 所以缓存身份除了引用 key 还要带上「解析到哪一份 src」和「这份 src 解第几次成功」。
// 每个槽都要报:副槽换了一张法线图,主槽的 src 一个字没动。
function fxMapStamp(l) {
    let s = '';
    for (const e of (l.effects || [])) {
        for (const slot of fxMapSlots(e)) {
            const ref = fxMapRef(e, slot.key);
            if (!ref) continue;
            const found = fxMapSource(ref);
            const hit = found ? fxMapDecoded.get(found.src) : null;
            s += `${slot.key}:${ref.key}@${found ? fxSrcId(found.src) : 0}#${hit && hit.tag ? hit.tag : 0}|`;
        }
    }
    return s;
}

// 文件选来的图不进工作区(那是一张深度图,不是参考图),它住在本地池里;.cud 存档会把它的像素
// 写成资产,所以重开还能被同一个 key 解析到。
function fxAddLocalMap(name, src) {
    const key = `map_${++fxMapSeq}`;
    const nm = name || 'Map';
    fxMapPool.set(key, { name: nm, src });
    return { key, name: nm };
}

function fxMapShort(effect, key) {
    const ref = fxMapRef(effect, key);
    if (!ref) return 'no map';
    const found = fxMapSource(ref);
    if (!found) return 'missing';
    const nm = String(found.name || ref.key);
    return nm.length > 12 ? `${nm.slice(0, 11)}…` : nm;
}

// 「Align: Canvas / Local」只有一种算法,住在贴图这一侧而不是某个特效里:几何 Warp 与体积雾都在参数里
// 摆这颗枚举,读的是同一句话 —— Canvas = 贴图铺满整张画布,于是该层网格的 uv 要按图层盒子 (落点、尺寸、
// 旋转) 映进贴图 uv;Local = 贴图就铺在该层自己的盒子上 ⇒ 恒等基。两份算式迟早会漂开,而漂开的那一侧
// 面板上写的还是同一个词。返回给着色器三个 vec2: 取样点 = u·x + v·y + b。
function fxMapFrame(align, l) {
    if (!l || align !== 'Canvas' || !canvasW || !canvasH) return { u: [1, 0], v: [0, 1], b: [0, 0] };
    const tr = effectiveTransform(l);
    const cos = Math.cos(tr.rotation), sin = Math.sin(tr.rotation);
    // 画布归一化 (逐轴除以 canvasW / canvasH,y 向下) 对盒子坐标 (u, v ∈ [-1,1],v 向下) 的偏导。
    // 两轴各自除的是画布的宽和高,所以那里要乘的是**另一个轴**的比值。
    const kw = canvasH / canvasW, kh = canvasW / canvasH;
    const nu = [tr.w / 2 * cos, tr.w / 2 * sin * kh];
    const nv = [-tr.h / 2 * sin * kw, tr.h / 2 * cos];
    // 盒子里 x ∈ [0,1] 从左数、vUV.y 从下数 ⇒ u = 2x-1、v = 1-2y;贴图上传翻过 v,所以再翻一次。
    return {
        u: [2 * nu[0], -2 * nu[1]],
        v: [-2 * nv[0], 2 * nv[1]],
        b: [tr.cx - nu[0] + nv[0], 1 - tr.cy + nu[1] - nv[1]],
    };
}

// .cud v3 把绑定的贴图写成随文件的资产;重开时资产像素落进本地池,引用换成新 mint 的 key(图池
// 那句 id 是宿主重新编号的,原样留着就是死引用)。资产读不出就退回旧引用本行 —— 按钮转红、链上
// 写明跳过,总比悄悄换一张图当真。每个声明了的槽各存各的资产。
async function restoreFxMaps(list, blobs) {
    for (const e of list) {
        for (const slot of fxMapSlots(e)) {
            const m = e.params && e.params[slot.key];
            if (!m || m.asset === null || m.asset === undefined) continue;
            const blob = blobs.get(m.asset);
            if (!blob) { e.params[slot.key] = { key: m.key, name: m.name }; continue; }
            try {
                const decoded = await blobToImage(blob);
                e.params[slot.key] = fxAddLocalMap(m.name, decoded.url);
            } catch (err) {
                e.params[slot.key] = { key: m.key, name: m.name };
            }
        }
    }
    return list;
}

// 贴图迟到/失效、旁路切换,都是「整条链不再可信」—— 两处共用同一套失效动作。
function invalidateAllFx() {
    for (const l of layers) l.fxCache = null;
    renderLayerList();
    render();
}
