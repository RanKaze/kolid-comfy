// Decal attribute —— 图层上面那张"另外涂上去的颜色"。它历史上永远是管线的第一步,所以在注册表里
// 排 0、新建时落在最左 (head)。存的就是自己的那张画布,读写口 = 老名字 `l.decal` / `l.decalCtx`。
defineAttrType({
    type: 'decal',
    label: 'Decal',
    kind: 'surface',
    legacy: 'decal',
    ctx: 'decalCtx',
    order: 0,
    at: { rel: 'head' },
});
