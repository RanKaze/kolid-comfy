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
//     (`l.mask` / `l.decal` / `l.effects`) 是**最左边那一个**的视图 —— 迁移、快照、剪贴板那一类调用
//     先不必理解 strip;会同时存在好几枚的那两样 (落笔、链 UI) 一律**点名**到哪一枚 (paintRecord /
//     chainOwnerRecord),否则"这一步的哪一条链"就没有唯一答案。真正的折叠在引擎里按整串走。
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
    for (const fn of ['init', 'fromLegacy', 'snap', 'load', 'clone', 'chip', 'open']) {
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
        // chip = 条带上那颗缩略图。它只负责**画**,节点本身由 blend_node 的那颗 chip 造好交进来 ——
        // 因为"有没有这颗 chip"归条带管,"这颗 chip 上摆什么"才归 attribute 管。
        // 蒙版与贴片画的是同一件事 (把自己那张面按图层网格的比例摆进这块小画布),规矩只有一处不同:
        // 贴片留空 (CSS 的棋盘格透出 = 没画),蒙版得自己填底色 —— 说在各自 spec 的 `chipBg` 里。
        // 点这颗 chip = 把笔落到**这一枚**上 (不是"最左那枚",也不是"这一种")。
        open(l, r) { setPaintTarget(r.type, l, r.id); },
        chip(el, r, l) {
            const w = el.width, h = el.height, c = el.getContext('2d');
            resetCtx(c);
            const bg = ATTR_TYPES[r.type].chipBg;
            const fill = typeof bg === 'function' ? bg(r) : bg;
            if (fill) { c.fillStyle = fill; c.fillRect(0, 0, w, h); }
            const s = r.surface;
            if (!s || !s.width || !s.height) return;
            const src = nativeSize(l.img);
            if (!src.w || !src.h) return;
            const k = Math.min(w / src.w, h / src.h);
            const dw = src.w * k, dh = src.h * k;
            c.drawImage(s, (w - dw) / 2, (h - dh) / 2, dw, dh);
        },
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
        // 链没有面可画,所以这条 chip 是一枚**魔棒** —— 它是"顺序里有这么一步"的记号,不是内容预览。
        chip(el) {
            if (el.dataset.icon !== 'chain') { el.innerHTML = fxWandSvg(); el.dataset.icon = 'chain'; }
        },
        // chip 上那根魔棒 = 这条链的**添加**入口 (行头上那颗已经搬走了 —— 一个动作一个入口)。
        // 它开的是**这一枚**记录的选择器:同一种挂了两枚容器时,选中的那个容器收下这一步。
        open(l, r) { openFxModal(l.id, r.id); },
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
// 同一种装了多枚时,**最右**那枚是"这个图层自己那一步的最后一次"。落笔的快捷键点的是它:画笔要落在
// 执行序末尾那一刀上,而不是落在最早那一枚上 (老语义里只有一枚,两种读法没有区别)。
function lastAttr(l, type) {
    let hit = null;
    for (const r of attrRecordsOf(l)) if (r.type === type) hit = r;
    return hit;
}
function attrRecord(ref) { return ref ? attrRecords.get(ref) || null : null; }
// 条带上**全部**链,按应用顺序。老名字 `l.effects` 只是最左边那一枚的视图,所以缓存签名、贴图戳这类
// 「整层重算不算」的判据一律读这一串 —— 只看最左那一条会漏掉右边那枚容器。
function stripChains(l) {
    return attrRecordsOf(l).filter(r => r.chain).map(r => r.chain);
}
// 从**特效 id** 出发的读法一律走这一句:一枚 id 住在某一条链里,而那条链属于哪一枚 Effects 记录不是
// 图层能凭老名字答的 (`l.effects` 只看最左那枚)。右边那枚容器里的一步 warp / 一次绑图,查不到就
// 什么都不会发生 —— 静默失败比报错更难查。
function chainOwnerRecord(l, effectId) {
    for (const r of attrRecordsOf(l)) {
        if (r.chain && r.chain.some(e => e && e.id === effectId)) return r;
    }
    return null;
}
function effectById(l, effectId) {
    const r = chainOwnerRecord(l, effectId);
    return r ? r.chain.find(e => e && e.id === effectId) : null;
}
// 整条条带上"还挂着、且开着"的特效。状态文案与"这层到底有没有链"那一类读数都该问这一句:问最左边
// 那一枚容器会漏掉右边那枚,而那句话说的正是这一层。
function liveEffects(l) {
    const out = [];
    for (const chain of stripChains(l)) for (const e of chain) if (e && e.enabled) out.push(e);
    return out;
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

// `where` 是调用方点名的落点,盖过注册表里的默认 (`'tail'` = `+` 菜单的那句"加在最后一步")。没有它才
// 走 `at` 的策略 —— 那套策略只为迁移与老入口存在,用户自己排的顺序不能被一次新增打乱,更不能被"种类"打断。
function insertAttr(l, type, where) {
    const r = newAttrRecord(type);
    if (!r) return null;
    if (!Array.isArray(l.attrs)) l.attrs = [];
    const i = where === 'tail' ? l.attrs.length : attrInsertIndex(l, type);
    l.attrs.splice(i, 0, r.id);
    return r;
}

// chip 右键的 Shallow Duplicate:另立一枚同类型的记录,排在原本那枚**右边** (在它之后生效)。
// 面**另起一张**,像素照抄当下 —— 共享一面在这条路上活不过第一笔: detachPaintSurface 在落笔之前就把
// 这一层的面换成私有副本,对面那枚仍指着旧画布,于是"两枚永远同步"只成立到第一次作画为止。与其让一
// 个看不见的引用在两笔之间悄悄变了名分,不如 duplicate 那一刻就各拿一张面。链同理:effect 对象是就地
// 改参数的,所以带过来的也是它自己的一份。
function dupAttrShallow(l, ref) {
    const src = attrRecord(ref);
    if (!src || attrRefList(l).indexOf(ref) < 0) return null;
    const spec = ATTR_TYPES[src.type];
    const copy = newAttrRecord(src.type, spec.kind === 'chain'
        ? { chain: cloneEffects(src.chain) } : { surface: cloneCanvasSurface(src.surface) });
    if (!copy) return null;
    l.attrs.splice(attrRefList(l).indexOf(ref) + 1, 0, copy.id);
    return copy;
}

// 图层自己的网格变了 (换画布尺寸、rasterize、Expand、Fit Mask 裁边),条带上**每一枚面**都得跟着走:只搬
// 最左那一枚,右边那枚就留在旧尺寸上,合成时它被拉伸到新的格子里 —— 画面看着对,后端拿到的 mask 与 src
// 却是两个尺寸。fn 拿到面连同它所属的记录 (蒙版要在新空间补满覆盖,贴片不补 —— 分流是种类的知识),
// 交回新画布才替换 (没人改就不动身份)。
// 换的是**本层那一条引用**,不是那张面:这一枚还有别的持有者 (另一层、或剪贴板) 时,本层改握一枚新记录,
// 旧记录连它那张面原样留给对方 —— 裁自己的边不能顺着共享引用漏进别人的图层。同一层把一枚挂两次,两条
// 引用一起搬到同一枚新记录上,否则"乘两次"会在一次裁边之后散成两张各画各的面。
function remapAttrFaces(l, fn) {
    const refs = attrRefList(l);
    const done = new Map();               // 旧 guid -> 本层现在该握的那枚 guid (不换身份时就是它自己)
    for (let i = 0; i < refs.length; i++) {
        const r = attrRecord(refs[i]);
        if (!r || !r.surface) continue;
        // 一枚挂两次 = 同一步走两遍,它只该被裁一遍:第二遍拿第一遍的结果再裁一次,边就缩了两回。
        if (done.has(r.id)) { refs[i] = done.get(r.id); continue; }
        const next = fn(r.surface, r);
        if (!next || next === r.surface) continue;
        const cb = clipboardRecord && clipboardRecord.layer !== l ? clipboardRecord.layer : null;
        const shared = layers.some(o => o !== l && attrRefList(o).indexOf(r.id) >= 0)
            || !!(cb && attrRefList(cb).indexOf(r.id) >= 0);
        if (shared) {
            const own = newAttrRecord(r.type, { surface: next });
            refs[i] = own.id;
            done.set(r.id, own.id);
            markAttrPainted(own);
        } else {
            r.surface = next;
            done.set(r.id, r.id);
            markAttrPainted(r);
        }
    }
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

// ---- 记录身上的三笔账 ----
// · chips:同一枚 attribute 可以被两层引用,于是它的面同时画在两颗 chip 上。"谁的缩略图"记在
//   记录身上而不是图层身上 —— 图层只该管它自己那串引用,而落笔要重画的正是这一枚。每颗 chip 连它
//   所属的图层一起存:比例是**那个图层**的网格,共享面在两层上摆的大小可以不同。
// · paintGen:面是**就地改写**的 (落笔在同一个 canvas 上画),身份不变,折叠缓存只看身份就看不见新墨。
//   图层那个 l.paintGen 只说图层自己的像素;共享面被 A 改一笔时 B 的缓存也必须脏,所以这一笔记在记录上。
// · 顺序归图层:拖完改的是图层的 `l.attrs`,不是记录 (见 moveAttr)。
function attrChips(r) { return r.chips || (r.chips = []); }
function bindAttrChip(el, r, l) {
    const chips = attrChips(r);
    for (let i = chips.length - 1; i >= 0; i--) if (!chips[i].el.isConnected) chips.splice(i, 1);
    chips.push({ el, l });
    ATTR_TYPES[r.type].chip(el, r, l);
}
// 把这一层身上某一 kinds 的 chip 全部重画 (type 省略 = 全部)。落一笔之后要喊的是这一句,不是"那一颗":
// 同一种装了两枚时,点名哪一枚是 paintRecord 的事,而共享的那张面在两颗 chip 上都得显出这滴墨。
function refreshAttrChips(l, type) {
    // Mask 层没有条带 (attachAttrView 不给它装 attribute),它那一颗覆盖率缩略图归 blend_node 画。
    // 认在这里而不是让每个调用点各判一次,是因为"这层有没有 chip"本来就是同一个问题。
    if (!l || l.isMaskLayer) return;
    for (const r of attrRecordsOf(l)) {
        if (type && r.type !== type) continue;
        for (const c of attrChips(r)) if (c.l === l && c.el.isConnected) ATTR_TYPES[r.type].chip(c.el, r, l);
    }
}
// 缓存的落笔判据:每枚记录自己的代次,按条带顺序串成一个键。图层那个 paintGen 只说自己那份像素,
// 它盖不住"共享面被别的层改了一笔"这件事 —— 那必须是这一串里的某一格变了。
function attrPaintGens(l) {
    let s = '';
    for (const r of attrRecordsOf(l)) s += ':' + (r.paintGen | 0);
    return s;
}
function markAttrPainted(r) { if (r) r.paintGen = (r.paintGen | 0) + 1; }

// chip 的 tooltip 要说清"这一枚是第几步",因为顺序现在归用户。只挂了一枚时不必报数 —— 那串括号
// 没有信息量,而条带上本来就只有一颗 chip 可读。
function attrStepNote(label, r, l) {
    const recs = attrRecordsOf(l);
    const i = recs.indexOf(r);
    return recs.length < 2 ? label : `${label} (step ${i + 1} of ${recs.length})`;
}

// 拖拽重排的那一份**缝位**算法:横向一条,落在第 k 颗的左半边 = 插到它的位置,右半边 = 它后面。
// 下标一律按**摘之前**那个数组说,所以调用方不必知道自己会不会被摘掉 (摘掉之后它左边那道缝还是同一条)。
// 条带和特效容器共用这一份 —— 两处都是"从左到右就是执行序",规矩不该有两套。列表里存的不是 id 本身
// (链存的是特效对象) 就交一个 `idOf` 读出它的 id。落不到同一列表里 (拖的是被拖的那颗自己、或者目标
// 根本不在这条里) 就回 -1,一行都不动。
function listSlot(refs, dragId, targetId, after, idOf) {
    const key = idOf || (v => v);
    const from = refs.findIndex(v => key(v) === dragId);
    const to = refs.findIndex(v => key(v) === targetId);
    if (from < 0 || to < 0 || from === to) return -1;
    const at = to + (after ? 1 : 0);
    const [item] = refs.splice(from, 1);
    refs.splice(at > from ? at - 1 : at, 0, item);
    return refs.findIndex(v => key(v) === dragId);
}

// 横向一条列表的落点:第 k 颗的左半边 = 'before'、右半边 = 'after'。不是这一条里的、或者就是自己拖
// 自己,回空串 —— 别的事件 (图层重排序) 因此照常接管。条带与特效容器共用这一句,和 `listSlot` 是一对。
function dropSide(ev, el, drag, layerId, ownId) {
    if (!drag || String(drag.layerId) !== String(layerId) || drag.ref === ownId) return '';
    const r = el.getBoundingClientRect();
    return (ev.clientX - r.left) < r.width / 2 ? 'before' : 'after';
}

// 拖拽重排:把 `dragRef` 插到同一条里 `targetRef` 那一颗的左边还是右边。缝位算法住在 `listSlot`，
// 特效容器排它自己那条链走的是同一句。
function moveAttr(l, dragRef, targetRef, after) {
    return listSlot(attrRefList(l), dragRef, targetRef, after) >= 0;
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
