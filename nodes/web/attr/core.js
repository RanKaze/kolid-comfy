// ==================== 图层 Attribute ====================
// 图层不再自带蒙版 / 贴片 / 特效链:它持有**一串有序 guid** (`l.attrs`),数据住在文档级的
// `attrRecords` 表里。这张表存在的理由只有一条 —— Attribute 要能被拖拽排序、能被复制成引用,而这两件
// 事都要求"一个 attribute 是一个数得出来的对象",不是图层上的三个字段。
//
// 四条规矩:
//   · **应用顺序 = 数组顺序,从左到右**。注册表里的 `order` 只管新建那一瞬间的默认落点
//     (decal → effects → mask,也就是这个功能出现之前那条固定管线的顺序);建好之后顺序归用户拖,
//     表里再没有第二个"顺序"。
//   · 同一种可以装多个 (多张 Mask 互相叠、多个 Effects 容器各管它右边那一段链)。图层上那三个老名字
//     (`l.mask` / `l.decal` / `l.effects`) 是**最左边那一个**的视图 —— 全篇几十处读写先不必理解
//     strip,语义仍然只有一处;真正的折叠在引擎里按整串走 (见 blend_node 的 layerSource)。
//   · **有 attribute 才有数据**:装上一个空的 Mask 就是"蒙版还没画",跟没装等价,所以迁移只在字段真
//     有内容时才立记录。反过来 `l.mask = null` 是把这一枚摘掉,而不是留着它装空。
//   · refs 一律**扫**出来,不落字段;快照存值 + id 只当分组标签 (跟源图资产表同一套做法),所以表永远
//     不必替历史保管任何东西,重放时也永远立不出第二条指向同一份历史的记录。
//
// 文件切分跟 fx 一样:本文件只装"strip 的模型"(注册表容器 + 引用计数 + 迁移 + 快照/克隆)。每一种
// attribute 自己一个 attr/<type>.js,里面齐活注册数据 (标签、默认落点、老字段名) 与 S4 要的缩略图;
// 加一类 = 写一个文件 + 在页面里加一行 <script src>。两三种 attribute 共用的那套算法 (面 / 链) 按
// `kind` 放在 ATTR_KINDS 里,谁想换掉就在自己的 spec 里写同名函数。

const ATTR_TYPES = {};

function defineAttrType(spec) {
    if (!spec || !spec.type || !ATTR_KINDS[spec.kind] || ATTR_TYPES[spec.type]) {
        throw new Error('bad attribute definition: ' + String(spec && spec.type));
    }
    const kind = ATTR_KINDS[spec.kind];
    // 没自带的算法从 kind 那里拿 —— spec 只写它跟兄弟不一样的那部分。
    for (const fn of ['init', 'fromLegacy', 'snap', 'load', 'clone']) {
        if (!spec[fn]) spec[fn] = kind[fn];
    }
    ATTR_TYPES[spec.type] = spec;
}

// 两种数据形状:一张画得出的**面** (蒙版、贴片),和一条**链** (特效)。同一个 kind 里的类型除了落点
// 与标签之外没有第二种规矩。
const ATTR_KINDS = {
    surface: {
        init: () => ({ surface: null }),
        // 老字段有面才立记录 (见上面"有 attribute 才有数据")。
        fromLegacy: raw => (raw ? { surface: raw } : null),
        snap: r => ({ surface: r.surface }),
        load: raw => ({ surface: raw.surface || null }),
        clone: (r, dup) => ({ surface: dup(r.surface) }),
    },
    chain: {
        init: () => ({ chain: [] }),
        fromLegacy: raw => (Array.isArray(raw) && raw.length ? { chain: raw } : null),
        // 链是可变结构 (改参数就改数组里那个对象),所以进快照的必须是深拷贝。
        snap: r => ({ chain: cloneEffects(r.chain) }),
        // 读快照同样拷一份:参数会就地改,直接把历史里那条数组交给活图层,下一次编辑就把它改掉,
        // undo 便回不到当初那一步。面 (canvas) 不必 —— 它是 copy-on-write 的。
        load: raw => ({ chain: cloneEffects(raw.chain) }),
        clone: r => ({ chain: cloneEffects(r.chain) }),
    },
};

let attrSeq = 0;
const attrRecords = new Map();          // 'attr_N' -> { id, type, ...payload }

function newAttrRecord(type, fields) {
    const spec = ATTR_TYPES[type];
    if (!spec) return null;
    const r = Object.assign({ id: 'attr_' + (++attrSeq), type }, spec.init(), fields || {});
    attrRecords.set(r.id, r);
    return r;
}

function attrRefList(l) { return l && Array.isArray(l.attrs) ? l.attrs : []; }
// 按 strip 顺序拿到记录;认不出的 guid (表里已经被 prune 掉) 直接跳过,绝不让一个悬空引用把整串挡住。
function attrRecordsOf(l) {
    const out = [];
    for (const ref of attrRefList(l)) {
        const r = attrRecords.get(ref);
        if (r && ATTR_TYPES[r.type]) out.push(r);
    }
    return out;
}
function findAttr(l, type) {
    for (const r of attrRecordsOf(l)) if (r.type === type) return r;
    return null;
}
// 条带上**全部**链,按应用顺序。老名字 `l.effects` 只是最左边那一枚的视图,所以缓存签名、贴图戳这类
// 「整层重算不算」的判据一律读这一串 —— 只看最左那一条会漏掉右边那枚容器。
function stripChains(l) {
    return attrRecordsOf(l).filter(r => r.chain).map(r => r.chain);
}

function attrRefs(ref) {
    if (!ref) return 0;
    let n = 0;
    for (const l of layers) if (attrRefList(l).indexOf(ref) >= 0) n++;
    // 剪贴板是表外的持有者 (复制之后把原本删掉,再粘贴必须还有那份数据可贴),所以它也算一次引用。
    const cb = clipboardRecord && clipboardRecord.layer;
    if (cb && attrRefList(cb).indexOf(ref) >= 0) n++;
    return n;
}

// 新建时的落点。`at` 说的是"跟谁相邻",不是绝对下标 —— 用户拖过的顺序不能被一次新增打乱。
function attrInsertIndex(l, type) {
    const at = ATTR_TYPES[type].at;
    const refs = attrRefList(l);
    if (at.rel === 'head') return 0;
    if (at.rel === 'tail') return refs.length;
    let anchor = -1;
    for (let i = 0; i < refs.length; i++) {
        const r = attrRecords.get(refs[i]);
        if (r && r.type === at.of) { anchor = i; break; }
    }
    if (anchor < 0) return refs.length;
    return at.rel === 'before' ? anchor : anchor + 1;
}

function insertAttr(l, type) {
    const r = newAttrRecord(type);
    if (!r) return null;
    if (!Array.isArray(l.attrs)) l.attrs = [];
    l.attrs.splice(attrInsertIndex(l, type), 0, r.id);
    return r;
}

function removeAttr(l, ref) {
    const refs = attrRefList(l);
    const i = refs.indexOf(ref);
    if (i >= 0) refs.splice(i, 1);
    if (attrRefs(ref) === 0) attrRecords.delete(ref);
}

// ---- 两类数据的读写口 ----
// 同一种装了多枚时,老名字读写的都是**最左边那一个**:它对应这个功能出现之前唯一的那一枚。
function attrSurface(l, type) {
    const r = findAttr(l, type);
    return r ? r.surface : null;
}
function setAttrSurface(l, type, surface) {
    const spec = ATTR_TYPES[type];
    const r = findAttr(l, type);
    if (!surface) {
        if (r) removeAttr(l, r.id);
        return null;
    }
    (r || insertAttr(l, type)).surface = surface;
    return surface;
}
function attrSurfaceCtx(l, type) {
    const s = attrSurface(l, type);
    return s ? s.getContext('2d') : null;
}
function attrChain(l) {
    const r = findAttr(l, 'effects');
    return r ? r.chain : null;
}
// 交一个数组过来就是要一个容器 (哪怕空的):`l.effects = []` 读作"这条链清空,但容器留着"。
// 要摘掉容器得说 `l.effects = null`。
function setAttrChain(l, list) {
    if (!Array.isArray(list)) {
        const r = findAttr(l, 'effects');
        if (r) removeAttr(l, r.id);
        return null;
    }
    const r = findAttr(l, 'effects') || insertAttr(l, 'effects');
    r.chain = list;
    return list;
}

// ---- 出厂、迁移与视图 ----
// 老形状 (mask/decal/effects 三个自带字段) 换成 strip:按注册表的 `order` 排,于是迁移动画出来的
// 顺序就是这条管线原本的执行顺序。
function migrateAttrs(l) {
    const found = [];
    for (const type of Object.keys(ATTR_TYPES)) {
        const spec = ATTR_TYPES[type];
        const payload = spec.fromLegacy(l[spec.legacy]);
        if (payload) found.push({ type, payload, order: spec.order });
    }
    found.sort((a, b) => a.order - b.order);
    l.attrs = [];
    for (const f of found) {
        const r = newAttrRecord(f.type, f.payload);
        if (r) l.attrs.push(r.id);
    }
    for (const type of Object.keys(ATTR_TYPES)) delete l[ATTR_TYPES[type].legacy];
    return l;
}

// 每个图层出厂都要过一次 (跟 attachSourceView 同一处,见 blend_node)。`maskCtx` / `decalCtx` 从此是
// 派生态:画布只有一个 2D 上下文,存一份在图层上就会在共享的那两枚 attribute 之间说谎。
function attachAttrView(l) {
    if (!l || l.isMaskLayer) return l;        // 那张层只有一个覆盖面,它不是 Decal attribute
    if (!Array.isArray(l.attrs)) migrateAttrs(l);
    for (const type of Object.keys(ATTR_TYPES)) {
        const spec = ATTR_TYPES[type];
        if (spec.kind === 'surface') {
            Object.defineProperty(l, spec.legacy, {
                configurable: true,
                get() { return attrSurface(this, type); },
                set(v) { setAttrSurface(this, type, v); },
            });
            if (spec.ctx) Object.defineProperty(l, spec.ctx, {
                configurable: true,
                get() { return attrSurfaceCtx(this, type); },
            });
        } else if (spec.kind === 'chain') {
            Object.defineProperty(l, spec.legacy, {
                configurable: true,
                get() { return attrChain(this); },
                set(v) { setAttrChain(this, v); },
            });
        }
    }
    return l;
}

// ---- 快照、克隆、读档 ----
// 存的是值 + 一个 id 标签:同一个标签在**一次重放**里只立一条记录,共享就此活过 undo 与 tab 往返。
function snapshotAttrs(l) {
    return attrRecordsOf(l).map(r => Object.assign({ id: r.id, type: r.type }, ATTR_TYPES[r.type].snap(r)));
}

// `list` 里的每一项是 `{ type, surface|chain }` (+ 可选的分组 id 标签)。读 .cud 与恢复快照共用这一条
// 口子 —— 区别只在于要不要按标签分组。
function adoptAttrPayloads(list, byId) {
    const refs = [];
    for (const raw of (list || [])) {
        const spec = raw && ATTR_TYPES[raw.type];
        if (!spec) continue;
        let r = byId && raw.id ? byId.get(raw.id) : null;
        if (!r) {
            r = newAttrRecord(spec.type, spec.load(raw));
            if (byId && raw.id) byId.set(raw.id, r);
        }
        if (r) refs.push(r.id);
    }
    return refs;
}

// 复制图层时 attribute 一律"浅拷贝":自己那份数据完整另立 (面是新画布、链是深拷贝),guid 也是新的。
function cloneCanvasSurface(surface) {
    if (!surface) return null;
    const c = document.createElement('canvas');
    c.width = surface.width; c.height = surface.height;
    c.getContext('2d').drawImage(surface, 0, 0);
    return c;
}
function cloneAttrList(l) {
    const refs = [];
    for (const r of attrRecordsOf(l)) {
        const copy = newAttrRecord(r.type, ATTR_TYPES[r.type].clone(r, cloneCanvasSurface));
        if (copy) refs.push(copy.id);
    }
    return refs;
}

// 这张表只给活图层当视图用,不是仓库:没人指的记录当场放手 (历史各自存着值,不需要表替它们保管)。
function pruneAttrs() {
    for (const ref of [...attrRecords.keys()]) if (attrRefs(ref) === 0) attrRecords.delete(ref);
}
