// ==================== 图层特效链 UI ====================
// 一条链是摊在**图层行上方**的一块容器,一步一行、**从下往上**读 = 执行序:紧挨着图层行那一步最先跑,
// 往上一层一步。这样整摞只有一个读法 —— 同一种挂了两枚容器时,贴近 head 的那一段先跑,接着往上读它
// 后面那一段 (DOM 里始终写链序,翻向交给 CSS 那一句 column-reverse)。空链不占位,加特效的入口在条带
// 上那枚 Effects chip 的魔棒上 —— 行头上那颗已经收掉了,一个动作只留一个可见入口;同一种挂了两枚容器
// 时,魔棒开的是**被点那枚**的选择器,而这两块容器谁管哪一步由竖排次序说,不另写一行说明。
let fxOpenId = null;        // 哪条特效正展开参数(按特效 id 记,列表重建后仍能展开)
let dragFx = null;          // {layerId, ref} —— 链内重排序的进行中拖拽 (ref = 特效 id)
const fxModalEl = document.getElementById('fxModal');
const fxGroupsEl = document.getElementById('fxGroups');
const fxBypassBtn = document.getElementById('fxBypassBtn');

function fxIconSvg(icon) {
    if (icon === 'shadow') {
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">'
            + '<rect x="1.9" y="1.9" width="10.2" height="10.2" rx="1.6"/>'
            + '<path d="M4.3 10.1a4.1 4.1 0 0 1 0-6.2" stroke-width="1.7" stroke-linecap="round"/></svg>';
    }
    if (icon === 'drop') {
        // 一块实心砖压在偏移的虚影之上:影子跑到形状外面去了,这才是外阴影。
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">'
            + '<rect x="3.9" y="3.9" width="8.2" height="8.2" rx="1.4" opacity="0.4" stroke-dasharray="1.3 1.3"/>'
            + '<rect x="1.9" y="1.9" width="8.2" height="8.2" rx="1.4" fill="currentColor" fill-opacity="0.18"/></svg>';
    }
    if (icon === 'stroke') {
        // 一圈等宽的轮廓环套着小方块:环本身就是这条特效。和 'drop'(偏移的虚影)与 'shadow'
        // (内缘弧)都区分得开 —— 描边不位移, 只是沿边缘长宽。
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor">'
            + '<rect x="2.6" y="2.6" width="8.8" height="8.8" rx="2" stroke-width="2.4" opacity="0.45"/>'
            + '<rect x="5" y="5" width="4" height="4" rx="0.8" fill="currentColor" stroke="none"/></svg>';
    }
    if (icon === 'blur') {
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">'
            + '<circle cx="7" cy="7" r="2.1" fill="currentColor" stroke="none"/>'
            + '<circle cx="7" cy="7" r="4.7" stroke-dasharray="1.7 1.9"/></svg>';
    }
    if (icon === 'pixel') {
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">'
            + '<rect x="1.9" y="1.9" width="10.2" height="10.2" rx="1.2"/>'
            + '<path d="M7 1.9v10.2M1.9 7h10.2" opacity="0.6"/>'
            + '<rect x="1.9" y="1.9" width="5.1" height="5.1" fill="currentColor" stroke="none" opacity="0.55"/></svg>';
    }
    if (icon === 'curve') {
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">'
            + '<path d="M2.2 11.8V2.2" opacity="0.55"/><path d="M2.2 11.8h9.6" opacity="0.55"/>'
            + '<path d="M2.6 11.4c3.1-.4 3.1-8.4 8.8-8.8" stroke-width="1.5"/></svg>';
    }
    if (icon === 'tone') {
        // 宽范围压成窄范围:上面那条长线是场景响应,下面那条短线是显示范围,中间一个往下压的箭头。
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">'
            + '<path d="M1.9 3.4h10.2"/>'
            + '<path d="M4.3 10.6h5.4" opacity="0.6"/>'
            + '<path d="M7 5v3.6M5.6 7.2 7 8.8l1.4-1.6"/></svg>';
    }
    if (icon === 'reset') {
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">'
            + '<path d="M2.6 4.2h8.8"/><path d="M5.6 4.2V2.4h2.8v1.8"/>'
            + '<path d="M3.7 4.2l.6 7.4h5.4l.6-7.4"/><path d="M6 6.3v3.2M8 6.3v3.2" opacity="0.6"/></svg>';
    }
    if (icon === 'dof') {
        // 同一块方砖由清晰到糊依次排开 —— 景深的图标就是「清晰度随景深变」。
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">'
            + '<rect x="1.6" y="4.6" width="3.4" height="4.8"/>'
            + '<rect x="5.6" y="4.6" width="3.4" height="4.8" opacity="0.6"/>'
            + '<rect x="9.6" y="4.6" width="3.4" height="4.8" opacity="0.3" stroke-dasharray="1.1 1.1"/></svg>';
    }
    if (icon === 'warp') {
        // 一张被拖弯的格子:四条边走得都不直,中间那个点就是把手。
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">'
            + '<path d="M2.6 3.2c3.1.8 6.1 1.2 8.8 1.1"/>'
            + '<path d="M11.4 4.3c-.5 3-1.1 5.9-2.2 8.1"/>'
            + '<path d="M9.2 12.4c-3-.6-5.9-.8-8.3-.1"/>'
            + '<path d="M2.6 3.2c.7 3 1 6.3.3 9.1"/>'
            + '<path d="M6.7 3.8c.3 2.9.1 6-.4 8.5" opacity="0.5"/>'
            + '<path d="M3.1 7.1c2.6-.5 5.3-.6 7.9.1" opacity="0.5"/>'
            + '<circle cx="6.9" cy="7.1" r="1.4" fill="currentColor" stroke="none"/></svg>';
    }
    if (icon === 'chromatic') {
        // 一幅画面里同一条硬边被画在三个位置上:中间那条是绿的 (原地), 两侧淡的是红与蓝各偏开的那份 ——
        // 色散读出来的就是「一个边, 三个位置」, 而不是 dof 那三块由清到糊的砖。
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">'
            + '<rect x="2.1" y="2.1" width="9.8" height="9.8" rx="1.5" opacity="0.45"/>'
            + '<path d="M7 4.3v5.4"/>'
            + '<path d="M4.9 4.3v5.4" stroke-width="1" opacity="0.45"/>'
            + '<path d="M9.1 4.3v5.4" stroke-width="1" opacity="0.45"/></svg>';
    }
    if (icon === 'corrosion') {
        // 一块边被咬出两个缺口的方块,缺口旁各点一颗蚀坑:锈吃的是轮廓,不是整张画面。
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">'
            + '<path d="M2.6 1.9h8.8c.4 0 .7.3.7.7v1.9l-2.3.4.5 1.9-2.1.9.8 1.7-1.9 1.5.6 1.5c.2.4 0 .6-.4.6H2.6c-.4 0-.7-.3-.7-.7V2.6c0-.4.3-.7.7-.7z"/>'
            + '<circle cx="9.1" cy="8.6" r="0.95" fill="currentColor" stroke="none"/>'
            + '<circle cx="4.9" cy="5.4" r="0.6" fill="currentColor" stroke="none" opacity="0.7"/></svg>';
    }
    if (icon === 'light') {
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">'
            + '<circle cx="7" cy="7" r="2.5"/>'
            + '<path d="M7 1.5v1.5M7 11v1.5M1.5 7H3M11 7h1.5M3.4 3.4l1.1 1.1M9.5 9.5l1.1 1.1M10.6 3.4 9.5 4.5M4.5 9.5l-1.1 1.1"/></svg>';
    }
    if (icon === 'bloom') {
        // 亮点 + 四向短芒 + 一圈散开的光晕:和 'light'(带八条射线的光源)区分开,泛光是自己发出去的。
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">'
            + '<circle cx="7" cy="7" r="1.6" fill="currentColor" stroke="none"/>'
            + '<circle cx="7" cy="7" r="4.5" opacity="0.35" stroke-dasharray="1.4 1.7"/>'
            + '<path d="M7 2.1v1.5M7 10.4v1.5M2.1 7h1.5M10.4 7h1.5" stroke-width="1.5" stroke-linecap="round" opacity="0.8"/></svg>';
    }
    if (icon === 'ao') {
        // 两块砖相接,接缝那条暗带就是它:挡光的是身边的几何,不是某一盏灯 —— 所以这颗图标里
        // 既没有 'light' 的八道射线,也没有 'bloom' 的芒。
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">'
            + '<rect x="1.8" y="3.1" width="4.4" height="7.8" rx="1"/>'
            + '<rect x="8" y="5.4" width="4.2" height="5.5" rx="1"/>'
            + '<path d="M6.7 4.1v6.3M7.4 6.4v4.2" stroke-width="2.1" stroke-linecap="round" opacity="0.45"/></svg>';
    }
    if (icon === 'fog') {
        // 长短不齐的三道雾带压在下半幅,上面一根短斜光:雾条既不是 'blur' 的同心圆也不是 'light'
        // 的八道射线 —— 浓度随高度变薄才是它的样子。
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">'
            + '<path d="M2.4 3.0 5.2 5.8" opacity="0.5"/><path d="M6.9 1.9v2.9" opacity="0.5"/>'
            + '<path d="M2.6 7.2h6.1" opacity="0.45"/>'
            + '<path d="M4.3 9.5h7.1" opacity="0.7"/>'
            + '<path d="M1.9 11.8h5.7"/></svg>';
    }
    if (icon === 'reflect') {
        // 一面横镜,入射箭头从左上打下来、反射箭头对称地折回左下:反射读的就是「同一根轴,
        // 两个对称方向」,和 'light'(光源辐射)与 'bloom'(自己发光)都不是一回事。
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">'
            + '<path d="M1.9 7h10.2" opacity="0.45"/>'
            + '<path d="M3.9 2.3 6.3 5.7M4.7 5.9 6.3 5.7 6.1 4.1"/>'
            + '<path d="M6.3 8.3 3.9 11.7M3.7 10.3 3.9 11.7 5.3 11.5" opacity="0.7"/></svg>';
    }
    if (icon === 'sort') {
        // 三条 run 各自往右错开一档、并且由暗到亮排开:分块重排读出来的就是「同一段内容, 阶梯状接起来」。
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">'
            + '<rect x="1.9" y="2.3" width="4.6" height="2.3" rx="0.6" fill="currentColor" fill-opacity="0.25"/>'
            + '<rect x="4.6" y="5.9" width="4.6" height="2.3" rx="0.6" fill="currentColor" fill-opacity="0.5"/>'
            + '<rect x="7.4" y="9.5" width="4.6" height="2.3" rx="0.6" fill="currentColor" fill-opacity="0.8"/></svg>';
    }
    if (icon === 'bend') {
        // 一张文件的中间一行被整行推出去、捅破了右边框:改的是连续一段字节, 所以错位是一条带, 不是雪花。
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">'
            + '<rect x="2.3" y="1.9" width="7.4" height="10.2" rx="1.2"/>'
            + '<path d="M3.7 4.5h4.4M3.7 9.5h4.4" opacity="0.5"/>'
            + '<rect x="5.9" y="6.1" width="6.3" height="1.9" rx="0.5" fill="currentColor" fill-opacity="0.35"/></svg>';
    }
    if (icon === 'noise') {
        // 一块底上撒满大小、深浅都不一样的杂粒:'split' 那三颗大点是"分色",这里是一把细碎的
        // 随机偏移 —— 点越小越密,读法越是"哪儿都有的杂色"。
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">'
            + '<rect x="1.9" y="1.9" width="10.2" height="10.2" rx="1.6"/>'
            + '<circle cx="4.6" cy="4.3" r="0.75" fill="currentColor" stroke="none" opacity="0.85"/>'
            + '<circle cx="8.3" cy="3.4" r="0.55" fill="currentColor" stroke="none" opacity="0.6"/>'
            + '<circle cx="10.2" cy="5.9" r="0.8" fill="currentColor" stroke="none" opacity="0.75"/>'
            + '<circle cx="6.5" cy="6.4" r="0.5" fill="currentColor" stroke="none" opacity="0.5"/>'
            + '<circle cx="3.6" cy="7.9" r="0.55" fill="currentColor" stroke="none" opacity="0.6"/>'
            + '<circle cx="8.9" cy="8.6" r="0.7" fill="currentColor" stroke="none" opacity="0.85"/>'
            + '<circle cx="5.7" cy="10.3" r="0.75" fill="currentColor" stroke="none" opacity="0.65"/>'
            + '<circle cx="10.4" cy="10.8" r="0.5" fill="currentColor" stroke="none" opacity="0.5"/></svg>';
    }
    if (icon === 'split') {
        // 点阵的底线上三颗点各自偏开、各自朝不同方向:分色点阵读出来是「一个边, 三颗点三个位置」,
        // 而不是 chromatic 那「一个边, 三条竖线」。
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">'
            + '<path d="M1.9 7h10.2M7 1.9v10.2" opacity="0.22"/>'
            + '<circle cx="4.1" cy="4.4" r="1.6" opacity="0.45"/>'
            + '<circle cx="9.6" cy="4.6" r="1.5" opacity="0.7"/>'
            + '<circle cx="6.4" cy="9.8" r="1.8"/></svg>';
    }
    return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">'
        + '<path d="M1.9 4.3h5.4M1.9 9.7h5.4" stroke-width="1" opacity="0.55"/>'
        + '<path d="M2.2 7h5.1"/><path d="M7.1 3.9 10.4 7l-3.3 3.1"/></svg>';
}

// 魔杖 + 火星:整条链的总闸,和图层的类型徽标区分开。
function fxWandSvg() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">'
        + '<path d="M2.8 13.2 9.6 6.4"/>'
        + '<path d="M11.3 2.1l.85 2.05 2.05.85-2.05.85L11.3 7.9l-.85-2.05L8.4 5l2.05-.85z" fill="currentColor" stroke="none"/>'
        + '<path d="M5.2 2.2l.55 1.35 1.35.55-1.35.55L5.2 6l-.55-1.35L3.3 4.1l1.35-.55z" fill="currentColor" stroke="none" opacity="0.65"/></svg>';
}

// 只清缓存 + 重画布,不重建列表 —— 拖滑块期间重建列表会把正在拖的那个控件拆掉。
function fxLiveUpdate(l) {
    l.fxCache = null;
    render();
}

function fxStructuralChange(l) {
    l.fxCache = null;
    renderLayerList();
    render();
    pushHistory();
}

// 一步特效 = 容器里的一行 chip (勾选 + 图标 + 名字 + 读数 + 移除),展开时另交一块参数区,由
// fxChainEl 摆在这颗 chip 的**下方**。读数照旧是可见文本,不折进 tooltip。
function fxStepEl(l, r, effect) {
    const spec = EFFECT_TYPES[effect.type];
    const updaters = [];

    const chip = document.createElement('div');
    chip.className = 'fx-chip' + (effect.enabled ? '' : ' disabled') + (fxOpenId === effect.id ? ' open' : '');
    chip.draggable = true;
    chip.dataset.fx = effect.id;

    const read = document.createElement('div');
    read.className = 'fx-read';
    const syncRead = () => {
        read.textContent = describeEffect(effect);
        for (const fn of updaters) fn();
    };

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = effect.enabled;
    chk.setAttribute('aria-label', 'Enable this effect');
    chk.title = effect.enabled ? 'Bypass this effect' : 'Enable this effect';
    chk.addEventListener('click', ev => ev.stopPropagation());
    chk.addEventListener('change', ev => {
        ev.stopPropagation();
        effect.enabled = chk.checked;
        chip.classList.toggle('disabled', !effect.enabled);
        chk.title = effect.enabled ? 'Bypass this effect' : 'Enable this effect';
        fxLiveUpdate(l);
        pushHistory();
    });

    const icon = document.createElement('span');
    icon.className = 'fx-icon';
    icon.innerHTML = fxIconSvg(spec.icon);

    const name = document.createElement('span');
    name.className = 'fx-name';
    name.textContent = spec.label;

    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '×';
    del.style.fontSize = '14px';
    del.style.lineHeight = '1';
    del.title = 'Remove this effect';
    del.addEventListener('click', ev => {
        ev.stopPropagation();
        const i = r.chain.findIndex(e => e.id === effect.id);
        if (i >= 0) r.chain.splice(i, 1);
        if (fxOpenId === effect.id) fxOpenId = null;
        fxStructuralChange(l);
    });

    chip.appendChild(chk);
    chip.appendChild(icon);
    chip.appendChild(name);
    chip.appendChild(read);
    chip.appendChild(del);
    chip.addEventListener('click', ev => {
        ev.stopPropagation();
        fxOpenId = fxOpenId === effect.id ? null : effect.id;
        renderLayerList();
    });

    // 链内重排序:竖着一条、从下往上就是执行序,所以上半 = 插到它后面、下半 = 前面。缝位算法与落点
    // 判定都是条带那一份 (`dropSide` / `listSlot`),只是交给它 'y' 这个轴 —— 两处不该各写一遍"插到
    // 第几道缝"。dragstart 必须停在这里,否则图层行的重排序会跟着一起启动。
    chip.addEventListener('dragstart', ev => {
        dragFx = { layerId: l.id, ref: effect.id };
        chip.classList.add('dragging');
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', 'fx:' + effect.id);
        ev.stopPropagation();
    });
    chip.addEventListener('dragend', () => {
        chip.classList.remove('dragging', 'drop-before', 'drop-after');
        dragFx = null;
    });
    chip.addEventListener('dragover', ev => {
        if (!dragFx || String(dragFx.layerId) !== String(l.id)) return;   // 链只在同层的本容器里重排
        const side = dropSide(ev, chip, dragFx, effect.id, 'y');
        if (!side) return;
        ev.preventDefault();
        ev.stopPropagation();
        ev.dataTransfer.dropEffect = 'move';
        chip.classList.toggle('drop-before', side === 'before');
        chip.classList.toggle('drop-after', side === 'after');
    });
    chip.addEventListener('dragleave', () => chip.classList.remove('drop-before', 'drop-after'));
    chip.addEventListener('drop', ev => {
        if (!dragFx || String(dragFx.layerId) !== String(l.id)) return;   // 同上:外来层的 fx 不落
        const side = dropSide(ev, chip, dragFx, effect.id, 'y');
        if (!side) return;
        ev.preventDefault();
        ev.stopPropagation();
        chip.classList.remove('drop-before', 'drop-after');
        const movedId = dragFx.ref;
        dragFx = null;
        const at = listSlot(r.chain, movedId, effect.id, side === 'after', e => e && e.id);
        if (at < 0) return;
        const moved = r.chain[at];
        setStatus(`「${EFFECT_TYPES[moved.type].label}」is now step ${at + 1} of ${r.chain.length} in this chain — it runs there`);
        fxStructuralChange(l);
    });

    syncRead();
    return { chip, params: fxOpenId === effect.id ? fxParamsEl(l, effect, spec, syncRead, updaters) : null };
}

function fxParamsEl(l, effect, spec, syncRead, updaters) {
    const body = document.createElement('div');
    body.className = 'fx-params';
    // 有专用编辑面的特效自己出整块面板(曲线就是这样);其余按注册表逐行铺控件。
    if (spec.editor) body.appendChild(spec.editor(l, effect, syncRead, updaters));
    else {
        // 开关/模式专属的旋钮只在条件成立时出现 —— 这条过滤各编辑面都在走 (见 fx/corrosion.js),
        // 通用面板以前漏了,所以光照那 8 行阴影旋钮在 Shadow=0 时照样铺满一排,而读数行早就不报它们了。
        const visible = () => {
            const p = effectParams(effect);
            return spec.params.filter(d => !d.when || d.when(p));
        };
        // 重铺只认「这一批行换没换」,而且只挂在**提交**上:拖动途中每个 input 都会同步读数,
        // 那时候换掉 DOM 等于把正在拖的滑块从指头底下拆走 (与 fxLiveUpdate 同一理由)。
        let shown = '';
        const pump = () => {
            const rows = visible();
            const key = rows.map(d => d.key).join(',');
            if (key === shown) return;
            shown = key;
            body.replaceChildren(...rows.map(d => fxControlRow(l, effect, d, syncRead, updaters, pump)));
        };
        pump();
    }
    // 参数区里的任何点击都不该顺带选中图层(那会重建列表)。
    body.addEventListener('click', ev => ev.stopPropagation());
    // 图层行是 draggable 的,滑块就压在它里面:从 handle 上起手按住再动,浏览器会往上找最近
    // 的可拖祖先 —— 也就是图层行 —— 把调参变成图层重排序。所以参数区自己得先成为那个最近
    // 祖先 (draggable=true),再取消它自己的 dragstart:两步缺一,拖拽都会漏到图层行上。
    body.draggable = true;
    body.addEventListener('dragstart', ev => { ev.preventDefault(); ev.stopPropagation(); });
    return body;
}

// 参数行的读数一律可见(值直接写在滑块右边),不是 tooltip。
// `onCommit` 只有通用面板会传:某个旋钮落定后问一句「可见的那批行换了吗」。它挂在 undoable 那一支
// (松手/点定)而不是每次 input,原因见 fxParamsEl。
function fxControlRow(l, effect, def, syncRead, updaters, onCommit) {
    const row = document.createElement('div');
    row.className = 'control-row';
    // 贴图那一行叫什么不写死在控件数据里:这行的 key 去问注册表 (needsMap / needsMap2.role),
    // 答出来的是「Depth」「Normal」「Noise」「Lookup」—— 一颗写着 "Map" 的按钮等于没回答
    // 「我该喂哪张图」。同一个 slot 下面还要用一次 (清除按钮的 title、按钮上的提示)。
    const mapSlot = def.kind === 'map'
        ? (fxMapSlots(effect).find(s => s.key === def.key) || { key: def.key, role: 'Map' })
        : null;
    const label = document.createElement('label');
    label.textContent = mapSlot ? mapSlot.role : def.label;
    row.appendChild(label);
    // 代价/模式这类说明性的一句话挂在行首那个名字上:读数那格永远只写效果,账单进 tooltip。
    // 分段钮自己那颗 title 已经在报「哪个选项被选中」,所以这里不跟它抢。
    if (def.tip) label.title = def.tip;
    const get = () => {
        const v = effect.params && effect.params[def.key];
        return v === undefined || v === null ? def.def : v;
    };
    // 拖动途中只重算画布(input),松手才算一步撤销(change)。
    const set = (v, undoable) => {
        if (!effect.params) effect.params = {};
        effect.params[def.key] = v;
        syncRead();
        fxLiveUpdate(l);
        if (undoable) pushHistory();
        if (undoable && onCommit) onCommit();
    };

    if (def.kind === 'color') {
        const inp = document.createElement('input');
        inp.type = 'color';
        inp.value = get();
        const span = document.createElement('span');
        const show = () => { span.textContent = inp.value.toUpperCase(); };
        updaters.push(show);
        inp.addEventListener('input', () => { show(); set(inp.value, false); });
        inp.addEventListener('change', () => set(inp.value, true));
        row.appendChild(inp);
        row.appendChild(span);
        show();
        return row;
    }
    if (def.kind === 'enum') {
        const seg = document.createElement('div');
        seg.className = 'fx-seg';
        const btns = [];
        const show = () => {
            const cur = get();
            for (let i = 0; i < btns.length; i++) btns[i].classList.toggle('on', def.options[i] === cur);
        };
        updaters.push(show);
        for (const opt of def.options) {
            const b = document.createElement('button');
            b.textContent = opt === 'trailing' ? 'trail' : opt;
            b.title = `${def.label}: ${opt}`;
            b.addEventListener('click', () => set(opt, true));
            btns.push(b);
            seg.appendChild(b);
        }
        row.appendChild(seg);
        show();
        return row;
    }
    if (def.kind === 'map') {
        // 这一行绑的是一张外部图,种类已经写进行首那个 label 上 (上面那次查表)。一条特效可以占两个
        // 槽 (几何 warp 读「深度 + 法线」),两行长得一模一样、各写各的 params[def.key]。
        // 名字直接写在按钮上 = 可见文本,不塞 tooltip;解析不到像素时按钮转红,链上也会写出跳过
        // 原因 —— 静默降级是最难发现的那种 bug。
        const slot = mapSlot;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fx-map-btn';
        const clr = document.createElement('button');
        clr.className = 'icon-btn';
        clr.textContent = '×';
        clr.style.fontSize = '14px';
        clr.style.lineHeight = '1';
        clr.title = `Unbind this ${slot.role.toLowerCase()} map`;
        const show = () => {
            const ref = fxMapRef(effect, slot.key);
            btn.textContent = ref ? fxMapShort(effect, slot.key) : 'not bound';
            btn.classList.toggle('unset', !ref);
            btn.classList.toggle('gone', !!ref && !fxMapSource(ref));
            // 按钮上那截名字被截断过,所以 title 补全名 —— 行首已经写着这张图的种类,不必再说一遍。
            btn.title = ref ? `${ref.name || ref.key} — click to pick another`
                : `Pick a ${slot.role.toLowerCase()} map${slot.optional ? ' (optional)' : ''}`;
            clr.style.display = ref ? '' : 'none';
        };
        updaters.push(show);
        btn.addEventListener('click', ev => { ev.stopPropagation(); openFxMapModal(l, effect, slot.key); });
        clr.addEventListener('click', ev => {
            ev.stopPropagation();
            // 整体替换,不原地改 —— 那个对象在 undo 快照之间是共享引用。
            effect.params[slot.key] = null;
            fxStructuralChange(l);
        });
        row.appendChild(btn);
        row.appendChild(clr);
        show();
        return row;
    }
    if (def.kind === 'dir') {
        // 这一行的形状与贴图槽同一套 (按钮写当前绑定 + 行尾 × 清除),绑的是一枚 Direction attribute
        // 的 guid —— openFxDirModal 全项目检索后点名。悬空时按钮转红,与缺图的读法同词。
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fx-map-btn';
        const clr = document.createElement('button');
        clr.className = 'icon-btn';
        clr.textContent = '×';
        clr.style.fontSize = '14px';
        clr.style.lineHeight = '1';
        clr.title = 'Unbind this direction — the manual Angle/Elev knobs come back';
        const show = () => {
            const ref = get();
            const where = ref ? fxDirSourceName(ref) : null;
            btn.textContent = ref ? (where || 'missing direction') : 'not bound';
            btn.classList.toggle('unset', !ref);
            btn.classList.toggle('gone', !!ref && !where);
            btn.title = ref ? (where ? `${where} — click to pick another` : 'The bound direction attribute is gone — click to pick another')
                : 'Point this light with a Direction attribute — pick one from the project';
            clr.style.display = ref ? '' : 'none';
        };
        updaters.push(show);
        btn.addEventListener('click', ev => { ev.stopPropagation(); openFxDirModal(l, effect, def.key); });
        clr.addEventListener('click', ev => {
            ev.stopPropagation();
            effect.params[def.key] = null;
            fxStructuralChange(l);
        });
        row.appendChild(btn);
        row.appendChild(clr);
        show();
        return row;
    }
    const inp = document.createElement('input');
    inp.type = 'range';
    inp.min = def.min;
    inp.max = def.max;
    inp.step = def.step;
    inp.value = get();
    const span = document.createElement('span');
    // def.fmt 可选:自己格式化读数(指数旋钮要显示 2ⁿ 这种「值不是面值」的数),给了就不走 值+unit。
    const show = () => {
        span.textContent = def.fmt ? def.fmt(Number(inp.value)) : `${inp.value}${def.unit || ''}`;
    };
    updaters.push(show);
    inp.addEventListener('input', () => { show(); set(Number(inp.value), false); });
    inp.addEventListener('change', () => set(Number(inp.value), true));
    row.appendChild(inp);
    row.appendChild(span);
    show();
    return row;
}

// 一枚 Effects 记录 = 它自己那块容器,摊在图层行的上方,一步一行、**从下往上**读就是执行序 (紧挨着
// 图层行那一步最先跑)。链里没有步就不占位 (空容器由条带上那枚 chip 自己说话)。展开参数的那一步,
// 参数区排在它自己那颗 chip 的**下方** (= 朝图层行那一侧)。
function fxChainEl(l, r) {
    if (!layerTakesEffects(l) || !r || !r.chain || !r.chain.length) return null;
    const box = document.createElement('div');
    box.className = 'fx-chain' + (effectsBypass ? ' bypassed' : '');
    box.dataset.fxLane = r.id;   // 这块容器是谁的链,按 guid 认 —— 数它是行里第几块答不了这个问题
    const steps = document.createElement('div');
    steps.className = 'fx-steps';
    box.appendChild(steps);
    for (const effect of r.chain) {
        const step = fxStepEl(l, r, effect);
        // 那一块是这一步的参数,不是整条链的,所以跟着它自己那一步走。column-reverse 把后写的往**上**画,
        // 于是想落在 chip 下方就得先写出去 —— 链序仍然只由 chip 的先后说。
        if (step.params) steps.appendChild(step.params);
        steps.appendChild(step.chip);
    }
    // 内核跳过整链时把原因写在容器上 —— 读数用可见文本,不塞 tooltip,更不能静默。读的是**这条记录
    // 自己**那份原因:全局 fxgl.skip 是所有图层、所有容器共用的"最近一次跑链"读数,直接拿它说话,
    // 绑好了图的那块容器也会挂上别处那句"no depth map bound"。
    const why = fxChainSkipReason(r);
    if (why) {
        const warn = document.createElement('div');
        warn.className = 'fx-warn';
        warn.textContent = `Chain skipped — ${why}`;
        box.appendChild(warn);
    }
    return box;
}

// `ref` 是那枚被点了魔棒的 Effects 记录:一步追加到**它**的链尾 (= 执行序末尾,画在这一摞的最上面)。
// 同一种挂了两枚容器时,选中的那枚收下它,另一枚不受影响。
function addEffectToLayer(layerId, ref, type) {
    const l = getLayer(layerId);
    const r = l && attrRecord(ref);
    if (!l || !layerTakesEffects(l) || !EFFECT_TYPES[type] || !r || r.type !== 'effects'
        || attrRefList(l).indexOf(ref) < 0) return;
    if (!Array.isArray(r.chain)) r.chain = [];
    const e = makeEffect(type);
    r.chain.push(e);
    fxOpenId = e.id;
    fxStructuralChange(l);
    setStatus(`Added ${EFFECT_TYPES[type].label} to「${l.name}」as step ${r.chain.length} of its chain`);
}

// picker 卡片:这里只铺底色并给出取景框,画面内容交给该特效自己的 thumb。
function drawFxThumb(c, type) {
    const g = c.getContext('2d');
    resetCtx(g);
    g.fillStyle = '#101012';
    g.fillRect(0, 0, c.width, c.height);
    const box = { x: 20, y: 13, w: c.width - 40, h: c.height - 26 };
    const spec = EFFECT_TYPES[type];
    if (spec && spec.thumb) spec.thumb(g, box);
}

function openFxModal(layerId, ref) {
    const l = getLayer(layerId);
    const r = attrRecord(ref);
    // 认的是**那一枚** Effects 记录:它必须还挂在这个图层的条带上,否则这一步就没人接。
    if (!l || !layerTakesEffects(l) || !r || r.type !== 'effects'
        || attrRefList(l).indexOf(ref) < 0) return;
    fxGroupsEl.innerHTML = '';
    const groups = new Map();
    for (const type of Object.keys(EFFECT_TYPES)) {
        const g = EFFECT_TYPES[type].group;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(type);
    }
    for (const [title, types] of groups) {
        const group = document.createElement('div');
        group.className = 'tag-group';
        const head = document.createElement('div');
        head.className = 'tag-group-title';
        head.textContent = title;
        head.title = title;
        const cards = document.createElement('div');
        cards.className = 'tag-cards';
        for (const type of types) {
            const spec = EFFECT_TYPES[type];
            cards.appendChild(makeTagCard(spec.label, spec.desc,
                () => { closeFxModal(); addEffectToLayer(layerId, ref, type); },
                c => drawFxThumb(c, type)));
        }
        group.appendChild(head);
        group.appendChild(cards);
        fxGroupsEl.appendChild(group);
    }
    fxModalEl.classList.add('open');
    syncBrushCursor();
}

function fxModalOpen() { return fxModalEl.classList.contains('open'); }
function closeFxModal() { fxModalEl.classList.remove('open'); }

fxModalEl.addEventListener('mousedown', e => { if (e.target === fxModalEl) closeFxModal(); });
document.getElementById('fxCancelBtn').addEventListener('click', closeFxModal);
fxModalEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFxModal(); }
});

// ---- 绑定贴图 (map picker) ----
// 一个入口、一个 modal:工作区图池 + 文件都在这一格里选。选回来的永远只是 {key, name} ——
// 图池条目用它的 staging id,文件走本地池 id(它不该挤进参考图池,但要能进 .cud 资产)。
const fxMapModalEl = document.getElementById('fxMapModal');
const fxMapGroupsEl = document.getElementById('fxMapGroups');
const fxMapTitleEl = document.getElementById('fxMapTitle');
const fxMapFileInput = document.getElementById('fxMapFile');
let fxMapTarget = null;        // { layerId, effectId, slot } —— 一次只给一条特效的一个槽绑

function fxMapModalOpen() { return fxMapModalEl.classList.contains('open'); }
function closeFxMapModal() { fxMapModalEl.classList.remove('open'); fxMapTarget = null; syncBrushCursor(); }

function bindFxMap(ref) {
    const t = fxMapTarget;
    if (!t) { setStatus('The picker was closed — that map is not bound', 'error'); return; }
    const l = getLayer(t.layerId);
    // 按 id 找它所属的那枚记录:老名字 `l.effects` 只看最左边那一枚容器,右边那枚里的一步绑图会
    // 静默什么都不发生。
    const e = l && effectById(l, t.effectId);
    if (!e) return;
    const slot = t.slot || 'map';
    // 整体替换,不原地改:cloneEffects 深拷贝只到 params 这一层,槽对象在 undo 快照之间是共享的。
    e.params[slot] = ref;
    closeFxMapModal();
    fxStructuralChange(l);
    setStatus(ref ? `Bound「${ref.name}」as the ${fxMapRole(e, slot)} map`
        : `Unbound the ${fxMapRole(e, slot)} map`, 'success');
}

function fxMapCardGroup(title, items) {
    const group = document.createElement('div');
    group.className = 'tag-group';
    const head = document.createElement('div');
    head.className = 'tag-group-title';
    head.textContent = title;
    head.title = title;
    const cards = document.createElement('div');
    cards.className = 'tag-cards';
    for (const s of items) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'tag-mode-item';
        // 缩略图在上、短名在下,长句与尺寸走 title(卡片那种「读数摆在可见文本」的规矩是给
        // 常驻信息用的,picker 是一次性动作,标题栏就是它的说明)。
        card.title = `${s.name}${s.width ? ` · ${s.width}×${s.height}` : ''}`;
        const img = document.createElement('img');
        img.className = 'tag-mode-thumb';
        img.src = s.src;
        img.alt = s.name;
        img.draggable = false;
        const nm = document.createElement('span');
        nm.className = 'tag-mode-name';
        nm.textContent = s.name;
        card.appendChild(img);
        card.appendChild(nm);
        card.addEventListener('click', () => bindFxMap({ key: s.id, name: s.name }));
        cards.appendChild(card);
    }
    group.appendChild(head);
    group.appendChild(cards);
    return group;
}

function openFxMapModal(l, effect, slotKey) {
    if (!layerTakesEffects(l) || !EFFECT_TYPES[effect.type]) return;
    const slot = fxMapSlots(effect).find(s => s.key === (slotKey || 'map'));
    if (!slot) return;
    fxMapTarget = { layerId: l.id, effectId: effect.id, slot: slot.key };
    fxMapTitleEl.textContent = `Bind a ${slot.role.toLowerCase()} map`;
    fxMapGroupsEl.textContent = '';
    // Guidance 卡是 Layers 的投影,当深度/法线图没有意义;图池为空时只剩文件这条路。
    const items = stagingItems.filter(s => s && s.src && s.id !== GUIDANCE_CARD_ID);
    if (items.length) fxMapGroupsEl.appendChild(fxMapCardGroup('Workspace', items));
    else {
        const hint = document.createElement('div');
        hint.className = 'modal-hint';
        hint.textContent = 'The workspace holds no images yet — use From file below.';
        fxMapGroupsEl.appendChild(hint);
    }
    fxMapModalEl.classList.add('open');
    syncBrushCursor();
}

// 文件的落点:本地池 + data URL。它不进工作区条带(那是一张深度图,不是参考图),但会随 .cud
// 一起存档,所以重开项目还认得这个 key。
function readFxMapFile(file) {
    const r = new FileReader();
    r.onload = () => bindFxMap(fxAddLocalMap(baseName(file && file.name), r.result));
    r.onerror = () => setStatus('Could not read that map file', 'error');
    r.readAsDataURL(file);
}

async function pickFxMapFile() {
    const pick = await pickDocuments('open', 'image', '', false);
    if (pick.busy || pick.cancelled) return;
    if (pick.error) { setStatus('Could not open the file picker: ' + pick.error, 'error'); return; }
    if (pick.unsupported) { fxMapFileInput.click(); return; }
    const doc = pick.docs[0];
    try { readFxMapFile(await docToFile(doc)); }
    catch (err) { setStatus(`Could not read ${doc.name}`, 'error'); }
}

fxMapModalEl.addEventListener('mousedown', e => { if (e.target === fxMapModalEl) closeFxMapModal(); });
document.getElementById('fxMapCancelBtn').addEventListener('click', closeFxMapModal);
document.getElementById('fxMapFileBtn').addEventListener('click', pickFxMapFile);
fxMapFileInput.addEventListener('change', () => {
    const f = (fxMapFileInput.files || [])[0];
    fxMapFileInput.value = '';      // so picking the very same file again still fires
    if (f) readFxMapFile(f);
});
fxMapModalEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFxMapModal(); }
});

// ---- 绑定方向 (Direction attribute picker) ----
// 与贴图 modal 同一套骨架,检索的是**全项目**:每个文档每一层的 Direction attribute 都是一张卡
// (平面方向的那批特效不参与 —— 只有 Lighting 这种 3D 光向引用它)。选回来的是记录 guid;那枚记录
// 被删掉时 fxLightDir 回 null,灯退回手动旋钮值,不让悬空引用静默灭灯。
const fxDirModalEl = document.getElementById('fxDirModal');
const fxDirGroupsEl = document.getElementById('fxDirGroups');
const fxDirTitleEl = document.getElementById('fxDirTitle');
let fxDirTarget = null;        // { layerId, effectId } —— 一次只给一条特效绑

function fxDirModalOpen() { return fxDirModalEl.classList.contains('open'); }
function closeFxDirModal() { fxDirModalEl.classList.remove('open'); fxDirTarget = null; syncBrushCursor(); }

function fxDirSourceName(ref) {
    for (const hit of fxDirInventory()) if (hit.r.id === ref) return `${hit.docName} \u00b7 ${hit.l.name}`;
    return null;
}

function fxDirInventory() {
    const out = [];
    for (const doc of documents) {
        if (isSceneDoc(doc)) continue;
        const docName = doc.name || 'Untitled';
        const ls = doc === activeDoc ? layers : ((doc.ctx && doc.ctx.layers) || []);
        for (const l of ls) {
            if (l.isMaskLayer) continue;
            for (const r of attrRecordsOf(l)) {
                if (r.type !== 'direction' || !r.desc || !r.desc.rotation) continue;
                out.push({ docName, l, r });
            }
        }
    }
    return out;
}

function bindFxDir(ref) {
    const t = fxDirTarget;
    if (!t) { setStatus('The picker was closed — no direction was bound', 'error'); return; }
    const l = getLayer(t.layerId);
    const e = l && effectById(l, t.effectId);
    if (!e) return;
    // 键由发起绑定的那行参数带来 (Lighting 的 dirRef、雾的 gravRef/sunRef 都是同一扇窗的客人)。
    e.params[t.key || 'dirRef'] = ref || null;
    closeFxDirModal();
    fxStructuralChange(l);
    const where = ref ? fxDirSourceName(ref) : null;
    setStatus(ref ? `「${where}」's Direction now drives this step`
        : 'Unbound — the step is back on its own knobs', 'success');
}

function openFxDirModal(l, effect, key) {
    if (!layerTakesEffects(l) || !EFFECT_TYPES[effect.type]) return;
    fxDirTarget = { layerId: l.id, effectId: effect.id, key: key || 'dirRef' };
    fxDirTitleEl.textContent = 'Bind a Direction';
    fxDirGroupsEl.textContent = '';
    const hits = fxDirInventory();
    if (!hits.length) {
        const hint = document.createElement('div');
        hint.className = 'modal-hint';
        hint.textContent = 'No Direction attribute in this project — add one from a layer\u2019s \u002B menu.';
        fxDirGroupsEl.appendChild(hint);
    }
    // 分组小标题 = 文档 (作用域),卡上短名 = 图层;缩略图从描述符现烘 (inactive 文档的面不在档)。
    let lastDoc = null, group = null, cards = null;
    const cur = fxDirTarget.key;
    for (const hit of hits) {
        if (hit.docName !== lastDoc) {
            lastDoc = hit.docName;
            group = document.createElement('div');
            group.className = 'tag-group';
            const head = document.createElement('div');
            head.className = 'tag-group-title';
            head.textContent = hit.docName;
            cards = document.createElement('div');
            cards.className = 'tag-cards';
            group.appendChild(head);
            group.appendChild(cards);
            fxDirGroupsEl.appendChild(group);
        }
        const e = geoEuler(hit.r.desc.rotation);
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'tag-mode-item' + (hit.r.id === effect.params[cur] ? ' active' : '');
        card.title = `${Math.round(dirWrap360(e.yaw))}\u00b0 / ${Math.round(e.pitch)}\u00b0 — ${hit.docName} \u00b7 ${hit.l.name}`;
        const cv = document.createElement('canvas');
        cv.className = 'tag-mode-thumb';
        cv.width = 168; cv.height = 112;
        cv.getContext('2d').drawImage(renderDirectionBuffer(hit.r.desc, 168, 112), 0, 0);
        cv.draggable = false;
        const nm = document.createElement('span');
        nm.className = 'tag-mode-name';
        nm.textContent = hit.l.name;
        card.appendChild(cv);
        card.appendChild(nm);
        card.addEventListener('click', () => bindFxDir(hit.r.id));
        cards.appendChild(card);
    }
    fxDirModalEl.classList.add('open');
    syncBrushCursor();
}

fxDirModalEl.addEventListener('mousedown', e => { if (e.target === fxDirModalEl) closeFxDirModal(); });
document.getElementById('fxDirCancelBtn').addEventListener('click', closeFxDirModal);
fxDirModalEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFxDirModal(); }
});

function syncFxBypassBtn() {
    fxBypassBtn.innerHTML = fxWandSvg();
    fxBypassBtn.classList.toggle('fx-bypassed', effectsBypass);
    fxBypassBtn.title = effectsBypass
        ? 'Resume every layer effect chain (currently suspended)'
        : 'Suspend every layer effect chain — the chains stay on their layers, nothing is deleted';
}

fxBypassBtn.addEventListener('click', () => {
    setEffectsBypass(!effectsBypass);
    syncFxBypassBtn();
    setStatus(effectsBypass ? 'Effects suspended — the chains are still on their layers' : 'Effects resumed');
});
