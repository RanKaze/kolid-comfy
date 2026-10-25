// fx/maps.js —— 特效链绑定外部贴图的解析层:params 里那句 {key, name} 引用在这里变成一张解码好的
// <img>,GL 侧只看到像素。契约见 fx/core.js 顶部。

// ---- 特效绑定的外部贴图 (bound maps) ----
// 深度图/法线图进 params 的永远只是一句引用:params 要进 fxSignature(每次缓存判定都要
// JSON.stringify)、进 undo 深拷贝、进 .cud 记录 —— 往里塞几 MB 的 data URL,这三处全都垮掉。
// v6 起引用的**正身是仓库里的内容哈希** `{asset, name}`(A3):`asset` 就是 data/assets/<hash>
// 的文件名 stem,`/api/asset_media/<hash>` 就是它的字节。仓库是唯一副本,图池条目只是引用。
// 老档还留着 `{key: 'staging_N' | 'map_N', name}`:key 只是过渡期的别名,读的时候按图池/本地
// 池兜底(见 fxMapSource),新绑定不再产生它。`fileAsset` 只在 .cud 里出现,指文件内嵌的
// PNG 资产序号 —— 给"换机器、本机仓库里没有这份 hash"留的逃生口。
// 引用对象一律整体替换、绝不原地改字段:cloneEffects 深拷贝只到 params 这一层,里面的 map 对象
// 是共享引用,原地写会把 undo 指着的旧步骤一起改掉。
// 一条特效可以占两个槽:主槽永远是 params.map(引擎传到 texMap,注册数据用 needsMap 声明它),
// 副槽由 spec.needsMap2 = {key, role} 报上来(引擎传到 texMap2,注册数据用 needsMap2 声明它)——
// 几何 warp 就是「深度 + 法线」两张图一起读。槽位表由注册数据推出来,所以下面每一个函数都按
// key 取引用,调用方不点名就还是主槽。
let fxMapSeq = 0;
let fxMapTagSeq = 0;
let fxSrcSeq = 0;
const fxMapPool = new Map();        // map_N -> { name, src }  【legacy 读档用,新绑定不再写】
const fxMapDecoded = new Map();     // src -> {} 解码中 | { img, tag } | { img: null } 解不开
const fxSrcIds = new Map();         // src -> 短号;缓存身份要用它,不能拿长字符串比

function fxAssetUrl(asset) {
    return '/api/asset_media/' + encodeURIComponent(String(asset || ''));
}

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
    if (!m) return null;
    // 新绑定 `{asset}`(仓库哈希);老档 `{key}`(图池/本地池别名);再老一点只留 `{url}`。
    if (typeof m.asset === 'string' && m.asset) return m;
    if (typeof m.key === 'string' && m.key) return m;
    if (typeof m.url === 'string' && m.url) return m;
    return null;
}

// 引用 → 可加载的字节地址。三条路按新鲜度排:
//   1. `asset` = 仓库哈希 —— 唯一副本,跨文档/跨会话都稳定(A3 起的新绑定);
//   2. 图池条目 —— 老档的 `staging_N`;A2 之后条目自带 `asset`/`url`,优先走它们(不再搬 base64);
//   3. `map_N` 本地池 —— 只给老档读,新绑定不再写(文件选择已经直接进仓库)。
function fxMapSource(ref) {
    if (!ref) return null;
    const name = ref.name || '';
    if (typeof ref.asset === 'string' && ref.asset) {
        return { src: fxAssetUrl(ref.asset), name: name || ref.asset, asset: ref.asset };
    }
    if (typeof ref.url === 'string' && ref.url) {
        return { src: ref.url, name: name || ref.url };
    }
    if (typeof ref.key !== 'string' || !ref.key) return null;
    const s = stagingItems.find(it => it && it.id === ref.key && (it.src || it.url));
    if (s) {
        const asset = s.asset;
        return {
            src: s.url || (asset ? fxAssetUrl(asset) : s.src),
            name: name || s.name || ref.key,
            asset: asset || undefined,
        };
    }
    const p = fxMapPool.get(ref.key);
    if (p && p.src) return { src: p.src, name: name || p.name };
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

// 一个槽的「像素身份」= 引用 key + 解析到哪一份 src + 这份 src 解第几次成功。图池条目会在 id 不变
// 的情况下原地换像素(Guidance 卡重发布就是这样),而解码到位的先后也不在 params 里,所以这三样
// 缺一都会把缓存钉在旧图上。谁都可以单点取它(fx/lighting.js 的那张 shadow mask 就按它判重烘),
// 所以写在这里,别处不许再凑一份近似式。
function fxMapIdentity(effect, key) {
    const id = key || 'map';
    const ref = fxMapRef(effect, id);
    if (!ref) return `${id}:0#0`;
    const found = fxMapSource(ref);
    const hit = found ? fxMapDecoded.get(found.src) : null;
    const refId = ref.asset || ref.key || ref.url || '?';
    return `${id}:${refId}@${found ? fxSrcId(found.src) : 0}#${hit && hit.tag ? hit.tag : 0}`;
}

// 整条 strip 上所有槽的身份串成一句,进链的缓存身份。一枚容器的绑定换了图,另一枚没换,
// 只有全部遍历才不会漏掉那一次重算。
function fxMapStamp(l) {
    let s = '';
    for (const chain of stripChains(l)) {
        for (const e of chain) {
            for (const slot of fxMapSlots(e)) {
                if (!fxMapRef(e, slot.key)) continue;
                s += `${slot.key}:${fxMapIdentity(e, slot.key).slice(slot.key.length + 1)}|`;
            }
        }
    }
    return s;
}

// 【legacy】老档的读食道:把文件内嵌的 PNG 解成 data URL 暂存本地池,供还写着 `map_N` 的引用解析。
// 新绑定不再走这里 —— 文件选择直接把字节导进仓库,引用写 `{asset: hash}`(见 fxImportMap)。
function fxAddLocalMap(name, src) {
    const key = `map_${++fxMapSeq}`;
    const nm = name || 'Map';
    fxMapPool.set(key, { name: nm, src });
    return { key, name: nm };
}

// 文件选择的**新落点**:字节进仓库(data/assets,内容寻址),绑定写 `{asset: hash, name}`。
// 不进图池条带(那是一张深度图,不是参考图),也不在内存里留 data URL —— 关掉页面重开,
// 只要仓库还在,引用就还解得开。
async function fxImportMap(name, dataUrl) {
    const res = await fetch('/api/asset_import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: [dataUrl], names: [name || 'Map'], library: true, origin: 'map' }),
    });
    const data = await res.json().catch(() => null);
    const rec = data && data.added && data.added[0];
    if (!data || !data.ok || !rec || !rec.id) {
        throw new Error((data && data.error) || 'the asset store rejected that image');
    }
    return { asset: rec.id, name: name || rec.name || rec.id };
}

// 这个槽装的是哪一类贴图 (Depth / Normal / Noise / Lookup) —— 面板上那行的名字、读数里缺图时的那
// 三个字,全都从这里说一次。注册表里 needsMap / needsMap2.role 已经写过一遍,再在控件数据里手打
// 一个 label 就是第二个答案,迟早和第一个漂开。
function fxMapRole(effect, key) {
    const slot = fxMapSlots(effect).find(s => s.key === (key || 'map'));
    return ((slot && slot.role) || 'Map').toLowerCase();
}

function fxMapShort(effect, key) {
    const role = fxMapRole(effect, key);
    const ref = fxMapRef(effect, key);
    if (!ref) return `no ${role}`;
    const found = fxMapSource(ref);
    if (!found) return `${role} gone`;
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

// Canvas 对齐的贴图读的是「图层盒子落在画布哪儿」,而拖图层既不改像素也不改 params ⇒ 链的缓存身份
// 看不见它。凡是把 fxMapFrame 取成 Canvas 的特效都要自己报这一句 (见 fx/warp.js 与 fx/lighting.js
// 的 stamp),所以算式只写在这里一份 —— 两处各写一遍迟早会漂开,而漂开的那一侧只是不再重算。
function fxMapBoxStamp(l) {
    const tr = effectiveTransform(l);
    return `${tr.cx.toFixed(4)},${tr.cy.toFixed(4)},${tr.w.toFixed(4)},${tr.h.toFixed(4)},${tr.rotation.toFixed(3)}`;
}

// .cud v3 把绑定的贴图写成随文件的资产;重开时资产像素落进本地池,引用换成新 mint 的 key(图池
// 那句 id 是宿主重新编号的,原样留着就是死引用)。资产读不出就退回旧引用本行 —— 按钮转红、链上
// 写明跳过,总比悄悄换一张图当真。每个声明了的槽各存各的资产。
// A3 起 `m.asset` 是**仓库哈希**(字符串):本机仓库就是唯一副本,原样收下、直接按
// `/api/asset_media/<hash>` 取字节,不必再把像素搬进内存池。`m.fileAsset` 指文件里那份
// 内嵌 PNG,留给换机器时兜底(v6 再接)。老档的 `m.asset` 是数字(文件资产表序号),
// 仍走下面那段"解码 → 本地池"的兼容路。
// `mapKeys`(可省)是「资产 id → 池 key」的备忘:传了它,同一份资产跨多次读档只进池一次 ——
// cud 链接的按存刷新每次都重折整份文件,没有这张表它每存一次就多 mint 一份几 MB 的 data URL。
async function restoreFxMaps(list, blobs, mapKeys) {
    for (const e of list) {
        for (const slot of fxMapSlots(e)) {
            const m = e.params && e.params[slot.key];
            if (!m || (!m.hash && (m.asset === null || m.asset === undefined))) continue;
            // A3 存档形状：{asset:<文件资产序号>, hash:<仓库哈希>, name}。hash 优先 ——
            // 它就是仓库里的唯一副本；asset 只用来在老机器上找文件内嵌的那份 PNG。
            if (typeof m.hash === 'string' && m.hash) {
                const ref = { asset: m.hash, name: m.name };
                if (typeof m.asset === 'number') ref.fileAsset = m.asset;
                e.params[slot.key] = ref;
                continue;
            }
            // 兼容中间版本（直接写 asset=hash 的档）。
            if (typeof m.asset === 'string' && m.asset) {
                const ref = { asset: m.asset, name: m.name };
                if (m.fileAsset !== undefined && m.fileAsset !== null) ref.fileAsset = m.fileAsset;
                e.params[slot.key] = ref;
                continue;
            }
            const pooled = mapKeys && mapKeys.get(m.asset);
            if (pooled && fxMapPool.has(pooled)) { e.params[slot.key] = { key: pooled, name: m.name }; continue; }
            const blob = blobs.get(m.asset);
            if (!blob) { e.params[slot.key] = { key: m.key, name: m.name }; continue; }
            try {
                const decoded = await blobToImage(blob);
                const added = fxAddLocalMap(m.name, decoded.url);
                e.params[slot.key] = added;
                if (mapKeys) mapKeys.set(m.asset, added.key);
            } catch (err) {
                e.params[slot.key] = { key: m.key, name: m.name };
            }
        }
    }
    return list;
}

// 贴图迟到/失效、旁路切换,都是「整条链不再可信」—— 两处共用同一套失效动作。
// 两张缓存都要清：`fxCache` 是"折回 2D 画布"那份，`fxTexCache` 是"结果留在纹理上"那份（显示面那条路，
// 见 blend_node 的 fxResolvedTexture）。只清一张 = 另一条路还贴着上一份结果。
function invalidateAllFx() {
    for (const l of layers) { l.fxCache = null; l.fxTexCache = null; }
    refreshLayerPanels();
    render();
}
