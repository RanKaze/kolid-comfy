// fx/maps.js —— 特效绑定贴图的解析层:params 里那句 {key, name} 引用在这里变成一张解码好的
// <img>,GL 侧只看到像素。契约见 fx/core.js 顶部。

// ---- 特效绑定的外部贴图 (bound maps) ----
// 深度图/法线图进 params 的永远只是一句 {key, name}:params 要进 fxSignature(每次缓存判定都要
// JSON.stringify)、进 undo 深拷贝、进 .cud 记录 —— 往里塞几 MB 的 data URL,这三处全都垮掉。
// key 有两个来源:工作区图池的 id(staging_N,宿主镜像过来的),和本地池的 id(map_N,来自文件
// 选择或 .cud 资产)。两条路都只在这里解析成像素,GL 侧只看到一张已解码的 <img>。
// 引用对象一律整体替换、绝不原地改字段:cloneEffects 深拷贝只到 params 这一层,里面的 map 对象
// 是共享引用,原地写会把 undo 指着的旧步骤一起改掉。
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

function fxMapRef(effect) {
    const m = effect.params && effect.params.map;
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
function fxMapStamp(l) {
    let s = '';
    for (const e of (l.effects || [])) {
        const ref = fxMapRef(e);
        if (!ref) continue;
        const found = fxMapSource(ref);
        const hit = found ? fxMapDecoded.get(found.src) : null;
        s += `${ref.key}@${found ? fxSrcId(found.src) : 0}#${hit && hit.tag ? hit.tag : 0}|`;
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

function fxMapShort(effect) {
    const ref = fxMapRef(effect);
    if (!ref) return 'no map';
    const found = fxMapSource(ref);
    if (!found) return 'missing';
    const nm = String(found.name || ref.key);
    return nm.length > 12 ? `${nm.slice(0, 11)}…` : nm;
}

// .cud v3 把绑定的贴图写成随文件的资产;重开时资产像素落进本地池,引用换成新 mint 的 key(图池
// 那句 id 是宿主重新编号的,原样留着就是死引用)。资产读不出就退回旧引用本行 —— 按钮转红、链上
// 写明跳过,总比悄悄换一张图当真。
async function restoreFxMaps(list, blobs) {
    for (const e of list) {
        const m = e.params && e.params.map;
        if (!m || m.asset === null || m.asset === undefined) continue;
        const blob = blobs.get(m.asset);
        if (!blob) { e.params.map = { key: m.key, name: m.name }; continue; }
        try {
            const decoded = await blobToImage(blob);
            e.params.map = fxAddLocalMap(m.name, decoded.url);
        } catch (err) {
            e.params.map = { key: m.key, name: m.name };
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
