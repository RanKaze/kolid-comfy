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
    // 链的末尾加一步 (链摊在图层行上方、从下往上读,所以末尾就是最上面那一行) —— 行头上那颗魔棒已经搬到
    // 这里,一个动作一个入口。
    chipClass: 'effects-thumb',
    // 角标是一撮粒子:大小不一的几粒散开 (透明度跟着缩) —— 链是一步叠一步往外炸的那件事,比
    // 魔棒更贴它的读法。
    badge: { class: 'effects', svg: '<svg viewBox="0 0 10 10"><circle cx="3.1" cy="6.9" r="1.7" fill="currentColor"/><circle cx="6.7" cy="3.5" r="1.15" fill="currentColor" opacity="0.85"/><circle cx="8.2" cy="6.7" r="0.75" fill="currentColor" opacity="0.6"/><circle cx="5.2" cy="1.5" r="0.75" fill="currentColor" opacity="0.6"/><circle cx="2" cy="2.6" r="0.55" fill="currentColor" opacity="0.45"/></svg>' },
    title: (r, l) => {
        const n = (r.chain || []).length;
        return attrStepNote('Effects', r, l) + ` — ${n} effect${n === 1 ? '' : 's'} running on what the steps to its left leave`
            + (n ? ' · click to add a step at the top of this chain, it runs last' : ' · click to put the first effect in');
    },
    addTitle: `Add an Effects container as this layer's last step — it starts empty (clicking the chip puts the first effect in), and it runs its own chain on whatever the steps to its left leave.`,
    // 链摊在图层行上方的那块容器 (fx/ui.js 的 fxChainEl)。条带的 lane 循环读的是注册表,Effects
    // 在这里报一句自己的 lane —— 生成器三兄弟 (文字/方向/3D) 也是同一套摆法。
    lane: (l, r) => fxChainEl(l, r),
});
