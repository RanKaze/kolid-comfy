// Stash attribute —— 一枚**活**的图：它的像素不是文件、也不是自己画出来的，而是「**本层以下**所有
// 可见图层叠到一起」的那张图 —— 每合成一次重新抄一遍。挂在它右边的特效链，吃的就是下面整叠叠完的
// 结果；于是「在这一层上挂个特效、让它作用于下面那一整摞」就是往条带上加一枚 Stash 这么一句话。
//
// 它曾经是一个**图层种类**（`l.stash` + `raster:true` + 几何焊死画布）。图层盒那一轮把底位变成条带上
// 普通一步之后，那种层就成了条带上唯一的例外：它自己那枚 image 记录（底位）`src` 是空的、每一帧被
// 原地重写 —— 也就是那枚"特殊的 image attribute"。把它自己变成一种 attribute，例外就整片消失了：
//   · 它是条带上**普通的一步**（source-over），位置随便拖 —— 拖到一条链右边，那条链就不作用于它；
//   · 所在的层是**普通层**：能移动 / 缩放 / 旋转 / 编组 / Rasterize / Combine（旧 Stash 层全拒）；
//   · 没有底位、没有 `src`、不进存档（每次 render 现抄），也不需要"这一层有没有图"那一套特例。
//
// 抄写只发生在 render 的循环里（见 blend_node.html 的 stashCapture）：轮到这一层那一刻，累积账
// （`stashAcc`）里摆好的恰好就是它以下那一叠 ⇒ 抄下来就是"以下合成图"。它永远看不到自己，也永远看
// 不到自己上面的层。**不含底片帧**（契约 §2.1 的"以下所有**层**的合成"按字面执行）—— 抄 stage 会把
// 视频帧烘进快照，让它从上层的层里再冒一遍。
//
// 面是**派生**的（每次 render 重抄），所以它跟 generator 一样不入档：`src` 恒空，存档里这一枚只有
// 类型与位置；读档回来第一次 render 就补上。没有 `legacy` 字段 —— 它从来不是图层上的一个字段，
// 那三个按 `spec.legacy` 建视图/迁移的循环都按"没有"跳过（core.js）。
defineAttrType({
    type: 'stash',
    label: 'Stash',
    kind: 'surface',
    order: 6,
    at: { rel: 'tail' },
    chipClass: 'stash-thumb',
    // 一张纸，底下那条线是它以下那一叠，箭头把整叠并上来 —— 「下面的合成图就是它自己的图」。
    badge: { class: 'stash', svg: '<svg viewBox="0 0 10 10"><rect x="1.2" y="1.1" width="7.6" height="5.1" rx="1" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M2.2 9.1h5.6" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M5 8.5V4.5M3.5 6 5 4.4 6.5 6" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>' },
    // 没有底色：没抄过就是全透明，CSS 那块棋盘格透出来说"这里还没有颜色"。
    chipBg: null,
    // **不接画笔**（见 blend_node 的 addAttrToLayer）：它的面每一帧被重抄，落上去的墨下一帧就没了。
    // 想画就往这一层加一枚 Image —— 那道闸在 `open` 里也说同一声。
    noPaint: true,
    title: (r, l) => attrStepNote('Stash', r, l)
        + ' — a live copy of everything under this layer, re-read on every draw; an effect to its '
        + 'right runs on that whole stack. Nothing to paint here: the next draw overwrites it.',
    // 点 chip **不把笔交给它**：它每一帧都被重抄，落上去的墨下一帧就没了 —— 交给它等于骗人。
    // 想画就往这一层加一枚 Image（Tab 键装的是最右那枚 Image，不是这一枚）。
    open(l, r) {
        setStatus(`「${l.name}」's Stash re-reads the layers under it on every draw — paint on an Image step instead`);
    },
    addTitle: `Add a Stash as this layer's last step — a live copy of every layer under this one, re-read on each draw. Put an effect to its right and that effect runs on the whole stack below it.`,
});
