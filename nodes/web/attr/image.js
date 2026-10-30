// Image attribute —— 图层上面那张"另外涂上去的图 / 生成出来的图"。它历史上永远是管线的第一步,所以在
// 注册表里排 0、新建时落在最左 (head)。存的就是自己的那张画布。
//
// 一层可以挂 **0~N 枚**，按条带顺序叠在该层的底位 (`l.box.base`) 之上：
//   · 落笔 (`paintRecord`) 新建的那枚落在尾部，笔尖就是它；
//   · Generate 回来的一张 (`appendGeneratedImage`) 落在**最后一枚 image 之后** —— 叠在前几张之上，
//     但仍在蒙版与链的左边，这一层自己的蒙版因此照样裁得到它。
// 这两种落点不一样是有意的：一个是"用户加了张白纸随手画"，一个是"生成完还要过这层的蒙版"。
//
// 名字:旧档与旧代码里叫 decal。P0 只把 **type 字符串**改成 image,两条老名字的路都留着 ——
//   · `legacy: 'decal'` 是老**字段**名 (`l.decal` / `l.decalCtx`),读写口仍是它,调用点逐步换;
//   · 老**类型**名 `'decal'` 由 core.js 的 ATTR_TYPE_ALIAS 在读端改名 (adoptAttrPayloads /
//     recAttrEntries),写出去一律 'image'。
defineAttrType({
    type: 'image',
    label: 'Image',
    kind: 'surface',
    legacy: 'decal',
    ctx: 'decalCtx',
    order: 0,
    at: { rel: 'head' },
    chipClass: 'image-thumb',
    badge: { class: 'image', svg: '<svg viewBox="0 0 10 10"><path d="M5 1.4C6.6 3.4 7.5 4.8 7.5 6A2.5 2.5 0 1 1 2.5 6C2.5 4.8 3.4 3.4 5 1.4Z" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>' },
    // 没有底色:没画过就是全透明,CSS 那块棋盘格透出来说"这里还没有颜色"。
    chipBg: null,
    // 底位 (`role:'base'`) 与叠上去的那几枚是同一个类型,措辞得分开 —— 它说的是"这一层自己的像素",
    // 不是"我在这层上又加了一张图"。`step N of M` 那一句对它也成立:它确实是条带的第一步。
    title: (r, l) => r.role === 'base'
        ? attrStepNote('Base image', r, l)
            + ' — this layer\'s own pixels (what l.img reads). It is an ordinary step now: drag it anywhere '
            + 'on the strip, and whatever runs to its left runs before the picture exists'
        : attrStepNote('Image', r, l)
            + ' — click to paint colour on this one; the Tab key arms the rightmost Image. '
            + 'Drag it left of the base image and it becomes the new base',
    // 点 chip = 把笔落到**这一枚**上。点底位那一枚 = 在"这一层自己的像素"上画。它读档时可能还是那张
    // 可共享的 <img>(没有 getContext),但**换面这件事不在这里做** —— 只是点开看一眼不该付出"换画布 +
    // 断开共享 + 丢掉 0 编码保存"的代价;真正的换面发生在第一笔落下之前 (ensurePaintSurface →
    // writableBaseFace),那时笔尖的 id 会跟着换到新记录上。
    open(l, r) {
        setPaintTarget(r.type, l, r.id);
    },
    addTitle: `Add an Image as this layer's last step — an empty sheet over everything to its left, and the brush lands on it right away.`,
});
