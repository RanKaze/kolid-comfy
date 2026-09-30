// Text attribute —— 一段由描述符渲染出来的文字,作为条带上的一步。老"文字层"是它的特例:
// 空底 + ownsGrid 的一枚记录 (格子跟着 transform 盒子走,面铺满整格),像素与迁移前逐位相同;
// 挂在照片层上的那批 (ownsGrid=false) 面**按图层网格**现算 —— 字填满这一层的格子,顺序归用户拖。
// 描述符不可变 (patch 整只换),面由 sync 惰性重算;存档只存描述符,渲染从不入档。
defineAttrType({
    type: 'text',
    label: 'Text',
    kind: 'generator',
    legacy: 'text',
    order: 3,
    at: { rel: 'head' },
    chipClass: 'text-attr-thumb',
    badge: { class: 'text', svg: '<svg viewBox="0 0 10 10"><path d="M1.6 2.2h6.8 M5 2.2v6.6 M3.4 8.8h3.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="square"/></svg>' },
    // 迁移:老字段的描述符整只进记录,且它当年**就是**这一层 —— 格子归它管。
    fromLegacy: raw => (raw ? { desc: raw, ownsGrid: true } : null),
    init: () => ({ desc: sanitizeTextDescriptor(Object.assign({}, TEXT_DEFAULTS, { content: 'Text' })), ownsGrid: false, box: null }),
    // 有墨 = 有内容。空文字的面是一张透明画布,但它仍是"这一步在做事"与"停用"之外的第.
    // 三种读法:Generate 通道把空文字层当噪声而不是当黑图 (老 textInk 的语义)。
    ink: r => !!(r.desc && String(r.desc.content)),
    title: (r, l) => attrStepNote('Text', r, l)
        + (r.desc ? ` — ${String(r.desc.content).slice(0, 40) || 'empty'}` : ''),
    addTitle: `Add a Text step — the text renders from its descriptor onto this layer's grid. On a fresh layer it owns the grid (the old text layer); on a photo it fills this layer's box.`,
    // 点 chip = 画布上的 inline 编辑器 (双击文字同一条路);编辑框按这枚步骤的盒子落位
    // (positionTextEditor 认 ownsGrid 与子盒两种)。
    open(l, r) {
        selectLayer(l.id, 'transform');
        openTextEditor(l.id);
    },

    // ---- 惰性同步 ----
    // ownsGrid:格子 = transform 盒子在画布上的像素,底换成透明画布 (老 syncTextBuffer 的职责,
    // 底与面分了家);不 ownsGrid:格子就是图层自己的,不动。两种都按键比对决定要不要重算面。
    sync(l, r) {
        if (!r.desc) return;
        if (r.ownsGrid && l.transform && canvasW && canvasH) {
            const w = Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.round(l.transform.w * canvasW)));
            const h = Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.round(l.transform.h * canvasH)));
            const cur = nativeSize(l.img);
            if (!l.img || cur.w !== w || cur.h !== h) {
                l.img = makeBlankCanvas(w, h);
                l.src = '';
                // 格子换了,条带上那几枚真实面跟着搬到新网格 (与老 syncTextBuffer 同一课)。
                remapAttrFaces(l, s => stretchSurfaceTo(s, w, h));
            }
        }
        if (!l.img) return;
        const { w, h } = nativeSize(l.img);
        if (!w || !h) return;
        const d = r.desc;
        // padding 必须在键里:它改盒子不碰字形度量,漏了它面板看得见、像素永远不动。
        const key = JSON.stringify(['text', d.content, d.fontFamily, d.fontSize, d.fontWeight, d.color, d.align, d.padding, r.box || 0, w, h]);
        if (r.genCache && r.genCache.key === key && r.genCache.img === l.img && r.surface) return;
        const bx = r.box ? Math.round(r.box.x * w) : 0;
        const by = r.box ? Math.round(r.box.y * h) : 0;
        const bw = r.box ? Math.max(1, Math.round(r.box.w * w)) : w;
        const bh = r.box ? Math.max(1, Math.round(r.box.h * h)) : h;
        const buf = renderTextBuffer(d, measureTextNatural(d), bw, bh);
        const face = document.createElement('canvas');
        face.width = w; face.height = h;
        face.getContext('2d').drawImage(buf, bx, by);
        r.surface = face;                       // 换新画布,从不就地重画 —— undo 指着旧的那张
        r.genCache = { key, img: l.img };
    },
});
