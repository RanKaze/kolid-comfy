// Direction attribute —— 一个姿态 (yaw/pitch/roll/颜色) 渲染成的"画布空间观察":平面按画布比例
// contain 进盒子,箭头是世界方向落在画布里的投影,度数烘进像素。老"Direction 层"是它的特例:
// 空底 + ownsGrid 的一枚记录;挂在照片层上的那批面按图层网格现算。世界坐标、把手拖动、three.js
// 小窗那一整套仍在 js/direction.js —— 这里只装 strip 的数据;参数在工具栏的 Direction 小窗调。
defineAttrType({
    type: 'direction',
    label: 'Direction',
    kind: 'generator',
    legacy: 'dir',
    order: 4,
    at: { rel: 'head' },
    chipClass: 'direction-attr-thumb',
    // 角标就是一支干净的箭头 (↗) —— 图层行那枚"环 + 箭头"塞进 9px 里环糊成一团,单箭头才读得出。
    badge: { class: 'direction', svg: '<svg viewBox="0 0 10 10"><path d="M2 8.2 7.6 2.6 M3.6 2.2H8V6.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="square"/></svg>' },
    fromLegacy: raw => (raw ? { desc: raw, ownsGrid: true } : null),
    init: () => ({ desc: sanitizeDirectionDescriptor(Object.assign({}, DIR_DEFAULTS)), ownsGrid: false, box: null }),
    // 方向总有图可出 (空姿态也是一张图),它不需要"空内容"那一档。
    ink: r => !!r.desc,
    title: (r, l) => attrStepNote('Direction', r, l)
        + (r.desc ? ` — ${Math.round(r.desc.yaw)}° / ${Math.round(r.desc.pitch)}° / ${Math.round(r.desc.roll)}°` : ''),
    addTitle: `Add a Direction step — the canvas-space view of a pose, rendered onto this layer's grid. Point it in the Direction tool (D).`,
    // 点 chip = 把 Direction 工具小窗对准这一枚 (小窗吃的是"选中的层",所以先点名再开窗)。
    open(l, r) {
        selectLayer(l.id, 'transform');
        toggleToolWindow('directionSection');
    },

    // ---- 惰性同步 (与 attr/text.js 同一套规矩) ----
    sync(l, r) {
        if (!r.desc) return;
        if (r.ownsGrid && l.transform && canvasW && canvasH) {
            const w = Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.round(l.transform.w * canvasW)));
            const h = Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.round(l.transform.h * canvasH)));
            const cur = nativeSize(l.img);
            if (!l.img || cur.w !== w || cur.h !== h) {
                l.img = makeBlankCanvas(w, h);
                l.src = '';
                remapAttrFaces(l, s => stretchSurfaceTo(s, w, h));
            }
        }
        if (!l.img) return;
        const { w, h } = nativeSize(l.img);
        if (!w || !h) return;
        const d = r.desc;
        // 画布比例在键里:平面按它 contain,改画布尺寸必须重烘 (老 syncDirectionBuffer 同一条)。
        const key = JSON.stringify(['direction', d.yaw, d.pitch, d.roll, d.color, canvasW / canvasH, r.box || 0, w, h]);
        if (r.genCache && r.genCache.key === key && r.genCache.img === l.img && r.surface) return;
        const bx = r.box ? Math.round(r.box.x * w) : 0;
        const by = r.box ? Math.round(r.box.y * h) : 0;
        const bw = r.box ? Math.max(1, Math.round(r.box.w * w)) : w;
        const bh = r.box ? Math.max(1, Math.round(r.box.h * h)) : h;
        const buf = renderDirectionBuffer(d, bw, bh);
        const face = document.createElement('canvas');
        face.width = w; face.height = h;
        face.getContext('2d').drawImage(buf, bx, by);
        r.surface = face;
        r.genCache = { key, img: l.img };
    },
});

