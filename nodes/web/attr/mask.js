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
});
