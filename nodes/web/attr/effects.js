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
    // chip 是一枚图标:它标的是"顺序里有这么一步",不是内容预览 (链没有面可预览)。点开它自己那条链
    // 是 S5 的事,今天添加特效仍然只走行上那根魔棒 —— 一个动作一个入口。
    chipClass: 'effects-thumb',
    title: (r, l) => {
        const n = (r.chain || []).length;
        return attrStepNote('Effects', r, l) + ` — ${n} effect${n === 1 ? '' : 's'} running on what the steps to its left leave`
            + (n ? ' · the wand on this row adds another on top of the chain' : ' · the wand on this row starts the chain');
    },
    addTitle: `Add an Effects container as this layer's last step — it starts empty (the wand on the row puts the first effect in), and it runs its own chain on whatever the steps to its left leave.`,
});
