// Effects attribute —— 一串特效,作用在它**左边**那段结果上,链序就是执行序。老字段名 `l.effects`
// 仍是"最左边那一枚容器"的视图 (存档迁移、剪贴板快照那一类调用先不必理解 strip);链 UI 与绑图走的
// 是**点名那一枚**记录 —— 同一种挂两枚容器时,"这条链"必须有一个答案。新建时挨在蒙版左边,因为这条
// 管线原本就是 decal → 链 → 蒙版。
defineAttrType({
    type: 'effects',
    label: 'Effects',
    kind: 'chain',
    legacy: 'effects',
    order: 1,
    at: { rel: 'before', of: 'mask' },
    // chip 是一枚魔棒图标:它标的是"顺序里有这么一步",不是内容预览 (链没有面可预览)。点它 = 往**这条**
    // 链的右端加一步 —— 行头上那颗魔棒已经搬到这里,一个动作一个入口;链本身摊在图层行的上方。
    chipClass: 'effects-thumb',
    title: (r, l) => {
        const n = (r.chain || []).length;
        return attrStepNote('Effects', r, l) + ` — ${n} effect${n === 1 ? '' : 's'} running on what the steps to its left leave`
            + (n ? ' · click to add another on the right end of this chain' : ' · click to put the first effect in');
    },
    addTitle: `Add an Effects container as this layer's last step — it starts empty (clicking the chip puts the first effect in), and it runs its own chain on whatever the steps to its left leave.`,
});
