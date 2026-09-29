// Mask attribute —— 一枚覆盖图,乘在它的左边一切之上 (alpha 就是覆盖度,橡皮是 destination-out)。
// 历史上它固定在最后一步,所以排 2、新建时落在最右 (tail);多装几枚就按 strip 顺序连乘。
// 没装 = 整层都盖住,跟一张纯白蒙版等价,所以图层字段一直是 null 而不是空白画布。
defineAttrType({
    type: 'mask',
    label: 'Mask',
    kind: 'surface',
    legacy: 'mask',
    ctx: 'maskCtx',
    order: 2,
    at: { rel: 'tail' },
    chipClass: 'mask-thumb',
    // 底色说的就是"这枚蒙版现在盖住多少":没有面 = 整层都盖住 = 白;有了面,黑底才是"没画=隐藏",
    // 白墨是覆盖。所以这颗 chip 不能像贴片那样留空透出棋盘格 —— 空面与满面的读法正好相反。
    chipBg: r => (r.surface ? '#000' : '#fff'),
    // 新生成的面从"全覆盖"起笔:一张新蒙版 IS 满幅蒙版,于是第一笔是**加**覆盖,而不是把"隐含的
    // 整层"换成"只有这一笔"。擦除是往下削,再画是填回去。
    firstFace(c, w, h) { c.fillStyle = '#fff'; c.fillRect(0, 0, w, h); },
    title: (r, l) => attrStepNote('Mask', r, l)
        + ' — click to paint coverage on this one; the ` key arms the rightmost Mask',
    addTitle: `Add a Mask as this layer's last step — it starts fully covered, so nothing disappears until you erase. Several Masks on one layer multiply, in strip order.`,
});
