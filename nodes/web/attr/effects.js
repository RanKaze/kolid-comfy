// Effects attribute —— 一串特效,作用在它**左边**那段结果上,链序就是执行序。老字段名 `l.effects`
// 仍是"最左边那一枚容器"的视图:全篇那几十处链读写 (fx/ui.js 的整行、maps.js 的绑定) 因此不必先
// 理解 strip。新建时挨在蒙版左边,因为这条管线原本就是 decal → 链 → 蒙版。
defineAttrType({
    type: 'effects',
    label: 'Effects',
    kind: 'chain',
    legacy: 'effects',
    order: 1,
    at: { rel: 'before', of: 'mask' },
});
