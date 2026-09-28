// ==================== 图层特效链 UI ====================
// 子行挂在图层行的**上方**,左侧竖线标归属;链里越贴近图层者越先执行,所以显示序是执行序的倒序
// (effects[0] 正好紧挨着 head 行)。空链不占位 —— 加特效走图层右键菜单,或链存在时子行块末尾的 +。
let fxOpenId = null;        // 哪条特效正展开参数(按特效 id 记,列表重建后仍能展开)
let dragFx = null;          // {layerId, id} —— 链内重排序的进行中拖拽
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
    if (icon === 'dof') {
        // 同一块方砖由清晰到糊依次排开 —— 景深的图标就是「清晰度随景深变」。
        return '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">'
            + '<rect x="1.6" y="4.6" width="3.4" height="4.8"/>'
            + '<rect x="5.6" y="4.6" width="3.4" height="4.8" opacity="0.6"/>'
            + '<rect x="9.6" y="4.6" width="3.4" height="4.8" opacity="0.3" stroke-dasharray="1.1 1.1"/></svg>';
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

// 一条特效 = 一行读数 + (展开时)一块参数区。两者一起返回,由 fxChainEl 顺序插入。
function fxRowEl(l, effect) {
    const spec = EFFECT_TYPES[effect.type];
    const box = document.createDocumentFragment();
    const updaters = [];

    const row = document.createElement('div');
    row.className = 'fx-row' + (effect.enabled ? '' : ' disabled') + (fxOpenId === effect.id ? ' open' : '');
    row.draggable = true;

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
        row.classList.toggle('disabled', !effect.enabled);
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
        const i = l.effects.findIndex(e => e.id === effect.id);
        if (i >= 0) l.effects.splice(i, 1);
        if (fxOpenId === effect.id) fxOpenId = null;
        fxStructuralChange(l);
    });

    row.appendChild(chk);
    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(read);
    row.appendChild(del);
    row.addEventListener('click', ev => {
        ev.stopPropagation();
        fxOpenId = fxOpenId === effect.id ? null : effect.id;
        renderLayerList();
    });

    // 链内重排序:整行可拖,落在别行上按插入线决定新执行序。拖的是特效而不是图层,所以
    // dragstart 必须 stopPropagation —— 否则图层行的重排序会跟着一起启动。
    row.addEventListener('dragstart', ev => {
        dragFx = { layerId: l.id, id: effect.id };
        row.classList.add('dragging');
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', 'fx:' + effect.id);
        ev.stopPropagation();
    });
    row.addEventListener('dragend', () => {
        row.classList.remove('dragging', 'drop-above', 'drop-below');
        dragFx = null;
    });
    row.addEventListener('dragover', ev => {
        if (!dragFx || dragFx.layerId !== l.id || dragFx.id === effect.id) return;
        ev.preventDefault();
        ev.stopPropagation();
        ev.dataTransfer.dropEffect = 'move';
        const r = row.getBoundingClientRect();
        const above = (ev.clientY - r.top) < r.height / 2;
        row.classList.toggle('drop-above', above);
        row.classList.toggle('drop-below', !above);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
    row.addEventListener('drop', ev => {
        if (!dragFx || dragFx.layerId !== l.id || dragFx.id === effect.id) return;
        ev.preventDefault();
        ev.stopPropagation();
        const above = row.classList.contains('drop-above');
        row.classList.remove('drop-above', 'drop-below');
        moveEffect(l, dragFx.id, effect.id, above);
        dragFx = null;
    });

    box.appendChild(row);
    if (fxOpenId === effect.id) box.appendChild(fxParamsEl(l, effect, spec, syncRead, updaters));
    syncRead();
    return box;
}

// 视觉上落在 target 之上 = 数组里排在 target **之后**(显示是倒序的)。
function moveEffect(l, dragId, targetId, above) {
    const chain = l.effects;
    const from = chain.findIndex(e => e.id === dragId);
    const to = chain.findIndex(e => e.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const at = above ? to + 1 : to;
    const [item] = chain.splice(from, 1);
    chain.splice(at > from ? at - 1 : at, 0, item);
    fxStructuralChange(l);
}

function fxParamsEl(l, effect, spec, syncRead, updaters) {
    const body = document.createElement('div');
    body.className = 'fx-params';
    for (const def of spec.params) body.appendChild(fxControlRow(l, effect, def, syncRead, updaters));
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
function fxControlRow(l, effect, def, syncRead, updaters) {
    const row = document.createElement('div');
    row.className = 'control-row';
    const label = document.createElement('label');
    label.textContent = def.label;
    row.appendChild(label);
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
        // 这一行绑的是一张外部图(深度/法线)。名字直接写在按钮上 = 可见文本,不塞 tooltip;
        // 解析不到像素时按钮转红,链上也会写出跳过原因 —— 静默降级是最难发现的那种 bug。
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fx-map-btn';
        const clr = document.createElement('button');
        clr.className = 'icon-btn';
        clr.textContent = '×';
        clr.style.fontSize = '14px';
        clr.style.lineHeight = '1';
        clr.title = 'Unbind this map';
        const show = () => {
            const ref = fxMapRef(effect);
            const role = EFFECT_TYPES[effect.type].needsMap;
            btn.textContent = ref ? fxMapShort(effect) : 'not bound';
            btn.classList.toggle('unset', !ref);
            btn.classList.toggle('gone', !!ref && !fxMapSource(ref));
            btn.title = ref ? `${role}: ${ref.name || ref.key} — click to pick another` : `Pick a ${role} map`;
            clr.style.display = ref ? '' : 'none';
        };
        updaters.push(show);
        btn.addEventListener('click', ev => { ev.stopPropagation(); openFxMapModal(l, effect); });
        clr.addEventListener('click', ev => {
            ev.stopPropagation();
            // 整体替换,不原地改 —— 那个对象在 undo 快照之间是共享引用。
            effect.params.map = null;
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
    const show = () => { span.textContent = `${inp.value}${def.unit || ''}`; };
    updaters.push(show);
    inp.addEventListener('input', () => { show(); set(Number(inp.value), false); });
    inp.addEventListener('change', () => set(Number(inp.value), true));
    row.appendChild(inp);
    row.appendChild(span);
    show();
    return row;
}

function fxChainEl(l) {
    if (!layerTakesEffects(l)) return null;
    const chain = l.effects || [];
    if (!chain.length) return null;
    const box = document.createElement('div');
    box.className = 'fx-chain' + (effectsBypass ? ' bypassed' : '');
    for (let i = chain.length - 1; i >= 0; i--) box.appendChild(fxRowEl(l, chain[i]));
    // 内核跳过整链时把原因写在行上 —— 读数用可见文本,不塞 tooltip,更不能静默。
    if (fxgl.skip) {
        const warn = document.createElement('div');
        warn.className = 'fx-warn';
        warn.textContent = `Chain skipped — ${fxgl.skip}`;
        box.appendChild(warn);
    }
    return box;
}

function addEffectToLayer(layerId, type) {
    const l = getLayer(layerId);
    if (!l || !layerTakesEffects(l) || !EFFECT_TYPES[type]) return;
    if (!l.effects) l.effects = [];
    const e = makeEffect(type);
    // 追加在链尾 = 最后执行 = 显示在最上面一层。
    l.effects.push(e);
    fxOpenId = e.id;
    fxStructuralChange(l);
    setStatus(`Added ${EFFECT_TYPES[type].label} to「${l.name}」`);
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

function openFxModal(layerId) {
    const l = getLayer(layerId);
    if (!l || !layerTakesEffects(l)) return;
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
                () => { closeFxModal(); addEffectToLayer(layerId, type); },
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
let fxMapTarget = null;        // { layerId, effectId } —— 一次只给一条特效绑

function fxMapModalOpen() { return fxMapModalEl.classList.contains('open'); }
function closeFxMapModal() { fxMapModalEl.classList.remove('open'); fxMapTarget = null; syncBrushCursor(); }

function bindFxMap(ref) {
    const t = fxMapTarget;
    if (!t) { setStatus('The picker was closed — that map is not bound', 'error'); return; }
    const l = getLayer(t.layerId);
    const e = l && (l.effects || []).find(x => x.id === t.effectId);
    if (!e) return;
    // 整体替换,不原地改:cloneEffects 深拷贝只到 params 这一层,map 对象在 undo 快照之间是共享的。
    e.params.map = ref;
    closeFxMapModal();
    fxStructuralChange(l);
    setStatus(ref ? `Bound「${ref.name}」as the ${EFFECT_TYPES[e.type].needsMap.toLowerCase()} map`
        : `Unbound the ${EFFECT_TYPES[e.type].needsMap.toLowerCase()} map`, 'success');
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

function openFxMapModal(l, effect) {
    if (!layerTakesEffects(l) || !EFFECT_TYPES[effect.type]) return;
    fxMapTarget = { layerId: l.id, effectId: effect.id };
    fxMapTitleEl.textContent = `Bind a ${EFFECT_TYPES[effect.type].needsMap.toLowerCase()} map`;
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
