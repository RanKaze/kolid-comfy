// 3D attribute —— 一枚场景 tab 的宿主端锚点。场景数据 (物体、相机、灯光) 仍住在 documents[] 里
// 那枚 kind:'scene' 的 tab (scene3d_*.js 那一整套不动),记录只握 sceneUid;面 = 烘焙出来的那张
// 画布 (Render to Layer / 离开视口时交回),它是唯一真相、**算不回来**,所以快照与克隆都要把面
// 带上 —— 这一点与文字/方向 (面是派生) 正好相反。老"3D 图层"是它的特例:空底 + ownsGrid。
defineAttrType({
    type: '3d',
    label: '3D',
    kind: 'generator',
    legacy: 'three',
    uidField: 'sceneUid',                  // 老名字 l.sceneUid 的读写口 (attachAttrView 认这一句)
    order: 5,
    at: { rel: 'tail' },
    chipClass: 'scene3d-attr-thumb',
    badge: { class: 'model', svg: '<svg viewBox="0 0 10 10"><path d="M5 1.2 8.8 3.1v3.8L5 8.8 1.2 6.9V3.1z" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M5 5.05v3.75M1.2 3.1 5 5.05l3.8-1.95" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>' },
    // 迁移:老图层是一对字段 (three + sceneUid),fromLegacy 把 uid 一起接进来。
    fromLegacy: (raw, l) => (raw ? { sceneUid: (l && l.sceneUid) || null, ownsGrid: true } : null),
    init: () => ({ desc: null, surface: null, genCache: null, sceneUid: null, ownsGrid: true }),
    // l.three 读作"记录在不在";写 true 建记录、写 null 摘掉 —— 由 attachAttrView 的默认实现管,
    // 这里只说读取的形状。
    legacyGet: () => true,
    // 面入档:bake 是唯一真相,snapshot/clone/load 都带上 (与 generator 默认"面不入档"相反)。
    snap: r => ({ desc: null, box: null, ownsGrid: true, sceneUid: r.sceneUid || null, surface: r.surface || null }),
    load: raw => ({ desc: null, ownsGrid: true, sceneUid: raw.sceneUid || null, surface: raw.surface || null }),
    clone: (r, dup) => ({ desc: null, ownsGrid: true, sceneUid: r.sceneUid || null, surface: r.surface ? dup(r.surface) : null }),
    // 有墨 = 烘过一次。没烘过的记录是"参数还在、像素没有"——Generate 通道把它当不存在。
    ink: r => !!(r.surface && r.surface.width && r.surface.height),
    title: (r, l) => attrStepNote('3D', r, l)
        + (r.sceneUid ? ' — click to open the 3D tool window; "Open Scene" there jumps in'
            : ' — this scene tab was closed; the baked pixels are all that is left'),
    addTitle: `Add a 3D step — a scene tab of its own is created for it (you stay here; enter it later via the 3D tool window). Fly the scene, then Render to Layer bakes the frame onto this layer.`,
    // 点 chip = 开 3D 工具小窗 (点名这一层)。跳转只走**明确的动作**:小窗里的 Open Scene,或行头
    // 那颗 jump 按钮 —— 建 step 与点 chip 都不把人拽进视口。开窗前强制刷一遍面板:selectLayer 对
    // "已选中"会早退,不重铺列表,面板可能还攥着上一刻的读数 (sceneUid 尚未落袋时按钮是灰的)。
    open(l, r) {
        selectLayer(l.id, 'transform');
        update3DPanel();
        toggleToolWindow('scene3dSection');
    },
    // `+` 菜单装上这一枚时:开一枚新的场景 tab 交给它,人留在原地 —— 什么时候进去由用户决定。
    onAdded(l, r) {
        if (!Scene3D.available) { setStatus('The 3D engine (js/3d-bundle.js) did not load', 'error'); return; }
        const name = `3D — ${l.name}`;
        const entry = createDocument(name, null, { scene: Scene3D.blankRecord(name) }, false,
            { kind: 'scene', hostUid: activeDoc ? activeDoc.uid : null });
        r.sceneUid = entry.uid;
        setStatus(`3D scene tab「${name}」created — open it from the 3D tool window (or the scene tab) when you are ready`);
    },
});

