// ==================== 图层特效链 UI ====================
// 一条链是摊在**图层行上方**的一块容器,一步一行、**从下往上**读 = 执行序:紧挨着图层行那一步最先跑,
// 往上一层一步。这样整摞只有一个读法 —— 同一种挂了两枚容器时,贴近 head 的那一段先跑,接着往上读它
// 后面那一段 (DOM 里始终写链序,翻向交给 CSS 那一句 column-reverse)。空链不占位,加特效的入口在条带
// 上那枚 Effects chip 的魔棒上 —— 行头上那颗已经收掉了,一个动作只留一个可见入口;同一种挂了两枚容器
// 时,魔棒开的是**被点那枚**的选择器,而这两块容器谁管哪一步由竖排次序说,不另写一行说明。
let fxOpenId = null;        // 哪条特效正展开参数(按特效 id 记,列表重建后仍能展开)
const fxModalEl = document.getElementById('fxModal');
const fxGroupsEl = document.getElementById('fxGroups');

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

function fxStructuralChange(l, label) {
    l.fxCache = null;
    refreshLayerPanels();
    render();
    pushHistory(null, label);
}

// 链里某一步的启用开关：写状态、让折叠缓存知道结果变了、记一步历史。DOM 那颗 checkbox 和宿主 dock
// 发回来的动作键走的都是这一句；chip 的类名与 tooltip 是画它的人自己的事，不住在这里。
function setFxStepEnabled(l, effect, on) {
    effect.enabled = !!on;
    fxLiveUpdate(l);
    pushHistory(null, (on ? 'Enabled ' : 'Disabled ') + ((EFFECT_TYPES[effect.type] || {}).label || 'Effect') + ' step');
}

// 从这条链里摘掉一步。开着的参数面板 (fxOpenId) 指的是这一步自己时得跟着收起来，否则下一次重画会把
// 一个已经不存在的 effect 摊在行里。
function removeFxStep(l, r, effect) {
    const i = r.chain.findIndex(e => e.id === effect.id);
    if (i >= 0) r.chain.splice(i, 1);
    if (fxOpenId === effect.id) fxOpenId = null;
    fxStructuralChange(l, ((EFFECT_TYPES[effect.type] || {}).label || 'Effect') + ' step removed');
}

// 折叠组 (kind:'fold' 的参数行) 的开合,按 effect id + 组 key 记在内存里 —— 纯 UI 状态,不进存档、
// 不进 fxSignature,重开页面回到 def.open 的默认。
const fxFoldState = new Map();
function fxFoldOpen(effect, d) {
    const k = effect.id + '|' + d.key;
    return fxFoldState.has(k) ? fxFoldState.get(k) : d.open !== false;
}

// 参数面是**数据**，不是这一页的 DOM（拍板 25「都改成组件」）。这一句就是行的去留与读数的唯一作者，
// 宿主 dock 照着这里编出来的那一批行画控件，判据一个字都不外渗：
//   * 去留由 spec.params 的声明序 + 每行自己的 when + kind:'fold' 的组说；
//   * 读数仍是 def.fmt 或 值+unit，贴图行首那个名字仍是注册表 fxMapSlots 答出来的 role；
//   * 每一行自带画它要的全部事实（值、读数、选项、绑定与否、绑的那张图此刻还在不在），宿主不回过来问
//     页面 —— 一回问，判据就在 React 里长出第二份。
// 「整块面板被某个特效接管」那个 spec.editor 口子连同九个专用编辑面一起废了：那六家「模式行 + 其余行
// 按 when 重铺」的写法，when 过滤本来就是同一句话；tone 的下拉换成枚举行（显示文本走 def.labels，
// FX_TONE_MODE_LABELS 还是唯一那份）；warp 的网格行与 curves 的图各自变成一个 kind。
// 于是这里没有「这一格被谁画了」那一岔 —— 只有 kind。
function fxParamsModel(l, effect) {
    const spec = EFFECT_TYPES[effect.type];
    const p = effectParams(effect);
    const rows = [];
    let open = true;
    for (const d of (spec.params || [])) {
        if (d.when && !d.when(p)) continue;
        if (d.kind === 'fold') { rows.push(fxParamRow(l, effect, d, p)); open = fxFoldOpen(effect, d); continue; }
        if (open) rows.push(fxParamRow(l, effect, d, p));
    }
    return rows;
}

const r3 = v => Number(Number(v).toFixed(3));   // 曲线那种归一化坐标：三位小数在 150px 的图上落不到别的像素上

function fxParamRow(l, effect, def, p) {
    const raw = effect.params && effect.params[def.key];
    const v = (raw === undefined || raw === null) ? def.def : raw;
    const row = { key: def.key, kind: def.kind || 'range', label: def.label || '', tip: def.tip || '', readout: '' };
    if (row.kind === 'check') { row.flag = !!v; return row; }
    if (row.kind === 'flag') {
        // 双态按钮：值是真参数（进存档、进 fxSignature），所以按钮上那句 ON/OFF 就是可见读数。
        row.flag = !!v;
        row.onText = def.onText || 'ON';
        row.offText = def.offText || 'OFF';
        row.readout = row.flag ? row.onText : row.offText;
        return row;
    }
    if (row.kind === 'fold') {
        row.open = fxFoldOpen(effect, def);
        return row;
    }
    if (row.kind === 'color') {
        row.value = String(v || '');
        row.readout = row.value.toUpperCase();
        return row;
    }
    if (row.kind === 'enum') {
        row.options = (def.options || []).map(String);
        // 显示文本仍由这一格说一次：def.labels 是注册表那份（Tone Map 的四个模式名），'trailing' →
        // 'trail' 是原来分段钮上的短写。两个都不是新事实，是 DOM 那两颗钮本来就写的字。
        row.labels = row.options.map(o => (def.labels && def.labels[o]) || (o === 'trailing' ? 'trail' : o));
        row.value = String(v);
        row.readout = row.value;
        return row;
    }
    if (row.kind === 'map') {
        // 这一行叫什么不由控件数据写死：那行 key 去问注册表，答出来的是 Depth / Normal / Noise /
        // Lookup —— 一颗写着 "Map" 的按钮等于没回答「我该喂哪张图」。解析不到像素时按钮转红，
        // 链上也会写出跳过原因，静默降级是最难发现的那种 bug。
        const slot = fxMapSlots(effect).find(s => s.key === def.key) || { key: def.key, role: 'Map' };
        const ref = fxMapRef(effect, slot.key);
        row.label = slot.role;
        row.role = slot.role;
        row.optional = !!slot.optional;
        row.bound = !!ref;
        row.missing = !!ref && !fxMapSource(ref);
        row.readout = ref ? fxMapShort(effect, slot.key) : 'not bound';
        row.title = ref ? `${ref.name || ref.key} — click to pick another`
            : `Pick a ${slot.role.toLowerCase()} map${slot.optional ? ' (optional)' : ''}`;
        return row;
    }
    if (row.kind === 'dir') {
        // 形状与贴图槽同一套（按钮写当前绑定 + 行尾 × 清除），绑的是一枚 attribute 的 guid。悬空时
        // 按钮转红，与缺图的读法同词。def.types 是那一口选择器要检索的类型名单。
        const ref = v ? String(v) : '';
        const where = ref ? fxDirSourceName(ref) : null;
        row.bound = !!ref;
        row.missing = !!ref && !where;
        row.types = (def.types || ['direction']).map(String);
        row.readout = ref ? (where || 'missing attribute') : 'not bound';
        row.title = ref ? (where ? `${where} — click to pick another`
                                : 'The bound attribute is gone — click to pick another')
                        : (def.tip || 'Pick an attribute from the project');
        return row;
    }
    if (row.kind === 'lattice') {
        // 两枚各指一个目的地的钮（摊开 / 收起）+ 一枚 Drop，与原来那一行三个按钮一字不差；网格本身
        // 摊在主画布上（beginWarpEdit 那一套手势），面板只说它现在摊没摊开。
        const lat = warpLatticeOf(p.lattice);
        row.hasGrid = !!lat;
        row.active = warpEditActive(l, effect);
        row.editLabel = lat ? 'Edit the grid' : 'Add a grid';
        row.readout = lat ? `${lat.cols}\u00d7${lat.rows} quads` : 'no grid';
        row.hint = 'drag a handle \u00b7 click an edge to split across';
        return row;
    }
    if (row.kind === 'curve') {
        // 曲线那格：折线由**这里**按 curveValueAt 现采样，React 只连点 —— 那条三次 Hermite 插值
        // 只有一个作者，两边各画一次形状迟早会漂开，而漂开的那一侧只是不再等于画面。
        // 采 64 段是画法的分辨率（150px 的图上落不到别的像素），不是插值算式的一部分。
        const set = curveSetOf(p);
        const focus = (curveFocus[effect.id] && CURVE_CHANNELS.includes(curveFocus[effect.id]))
            ? curveFocus[effect.id] : 'rgb';
        const pts = set[focus];
        const lut = [];
        for (let i = 0; i <= 64; i++) {
            const x = i / 64;
            lut.push([r3(x), r3(curveValueAt(pts, x))]);
        }
        row.channels = CURVE_CHANNELS.map(c => ({ value: c, label: CURVE_CHANNEL_LABELS[c] }));
        row.channel = focus;
        row.points = pts.map(q => [r3(q[0]), r3(q[1])]);
        row.lut = lut;
        row.minGap = CURVE_MIN_GAP;
        row.readout = '';
        return row;
    }
    // 剩下的一律是滑块：min/max/step 原样交出去，读数照原句。
    row.min = Number(def.min);
    row.max = Number(def.max);
    row.step = Number(def.step);
    row.value = Number(v);
    row.readout = def.fmt ? def.fmt(Number(v)) : `${v}${def.unit || ''}`;
    return row;
}

// 此刻展开参数的那一步。fxOpenId 记的是那一步自己的 id（列表重建后仍能展开），坐标三样（哪一层、
// 哪一枚容器、第几步）由这里现查 —— 宿主回发时也带这三样，两边因此不可能各认一套坐标。
function fxOpenStepRef() {
    if (fxOpenId === null) return null;
    for (const l of layers) {
        const r = chainOwnerRecord(l, fxOpenId);
        if (!r) continue;
        const e = (r.chain || []).find(x => x && x.id === fxOpenId);
        if (e) return { l, r, e };
    }
    return null;
}

function fxOpenStepModel() {
    const p = fxOpenStepRef();
    if (!p) return null;
    const spec = EFFECT_TYPES[p.e.type];
    return {
        layerId: p.l.id, attrId: p.r.id, stepId: p.e.id,
        type: p.e.type, label: spec ? spec.label : String(p.e.type),
        readout: describeEffect(p.e),
        rows: fxParamsModel(p.l, p.e),
    };
}

// 通用面板上那一句「这一批行换没换」：滑块落定（松手/点定）之后重问一遍 when。这里没有 DOM 可铺，
// 换行的代价就是快照里多出来的那几句描述符 —— 播报走 queueBlendUi 的等值去重，没换就一个字都不发。
// 落定那一趟走 refreshLayerPanels（链的结构可能跟着 when 换，页面那几块面板的读数也认这一句）；拖动途中
// 只重排行模型 + 播报（DOM 时代连图层列表都不重建，理由同 fxLiveUpdate：那一趟里正在拖的东西会被拆掉，
// 如今拆不掉，但也没必要为它重建六块面板）。
function fxPublishRows() { syncStackRows(); queueBlendUi(); }
function fxRefreshParams() { refreshLayerPanels(); }

// 参数面被宿主按下以后。每一句都是"那颗控件原来那一句"：拖途中只清缓存重画布（不记历史），松手才算
// 一步撤销；模式/枚举这类一落定就换整摞行的，仍旧当场记一步。
// 值按那一行的 kind 归，第三种形状一概不收 —— 载荷是从另一个文档递过来的，一个字都不能信。
function fxParamValue(def, raw) {
    const kind = def.kind || 'range';
    if (kind === 'check' || kind === 'flag') return !!raw;
    if (kind === 'range') return Number(raw);
    return String(raw);
}

function fxParamWrite(l, e, key, raw, undoable) {
    const def = (EFFECT_TYPES[e.type].params || []).find(d => d.key === key);
    if (!def || def.kind === 'fold' || def.kind === 'curve' || def.kind === 'lattice') return false;
    if (!e.params) e.params = {};
    e.params[key] = fxParamValue(def, raw);
    // 双态按钮那一行落定时换的是**整批可见行**（模式开关就是它的语义），所以走结构变更那一句，历史里
    // 那句也说「switched」—— 与 DOM 那颗钮原来那两句一字不差，不跟旋钮行的「changed」混写。
    if (def.kind === 'flag') { fxStructuralChange(l, '「' + (def.label || key) + '」 switched'); return true; }
    fxLiveUpdate(l);
    if (!undoable) { fxPublishRows(); return true; }
    pushHistory(null, '「' + (def.label || key) + '」 changed');
    fxRefreshParams();
    return true;
}

// 把正在拖着的那枚特效放进 (l, r) 这条链的第 k 槽。k 按**摘之前**的数组说 (与 listSlot 同一条
// 约定):链里由指针位置给,条带上那颗魔棒 chip 给的是"末尾" (k = 链长)。特效整只搬家 —— params
// 里的绑定全是文档级引用 (图池 id / attribute guid),换宿主不散。同链原地 = 什么都不动,不记历史。
function fxAdoptEffect(drag, l, r, k) {
    if (!drag || !r || !Array.isArray(r.chain) || !layerTakesEffects(l)) return false;
    const srcLayer = getLayer(drag.layerId);
    const srcRec = (drag.rec && attrRecord(drag.rec)) || chainOwnerRecord(srcLayer, drag.ref);
    if (!srcRec || !Array.isArray(srcRec.chain)) return false;
    const from = srcRec.chain.findIndex(e => e && e.id === drag.ref);
    if (from < 0) return false;
    let at = Math.max(0, Math.min(k, r.chain.length));
    if (srcRec === r) {
        if (from < at) at--;
        if (at === from) return false;                     // 落到自己那道缝上:原地不动
    }
    const [e] = srcRec.chain.splice(from, 1);
    r.chain.splice(at, 0, e);
    const label = (EFFECT_TYPES[e.type] && EFFECT_TYPES[e.type].label) || 'Effect';
    if (srcRec === r) {
        setStatus(`「${label}」is now step ${at + 1} of ${r.chain.length} in this chain — it runs there`);
    } else if (srcLayer === l) {
        setStatus(`「${label}」moved to another Effects container on「${l.name}」— it is now step ${at + 1} of ${r.chain.length} there`);
    } else {
        setStatus(`「${label}」moved from「${srcLayer.name}」to「${l.name}」— it is now step ${at + 1} of ${r.chain.length} in its Effects chain`);
    }
    if (srcLayer !== l) srcLayer.fxCache = null;
    fxStructuralChange(l, 'Effect step reordered');
    return true;
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
    fxStructuralChange(l, 'Added ' + EFFECT_TYPES[type].label + ' to the chain');
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

// ---- 选图 modal (map picker) ----
// 一个入口、一个 modal,里面两副面孔:不给 opts 就是特效绑图那格(工作区图池 + 文件),给了 opts
// 就是通用选图器 —— 标题、分组、以及"选回来干什么"全由调用方摆 (姿态识别走的那条)。
// 共用的是这一格 modal 与它的键盘/外点关闭,不是各写一份近似实现。
const fxMapModalEl = document.getElementById('fxMapModal');
const fxMapGroupsEl = document.getElementById('fxMapGroups');
const fxMapTitleEl = document.getElementById('fxMapTitle');
const fxMapSubEl = document.getElementById('fxMapSub');
const fxMapFileBtnEl = document.getElementById('fxMapFileBtn');
const fxMapFileInput = document.getElementById('fxMapFile');
const fxMapSubDefault = fxMapSubEl ? fxMapSubEl.textContent : '';   // 两副面孔各自的说明句, 绑图这副的原文要留着
let fxMapTarget = null;        // { onPick } —— 一次只收一张图

function fxMapModalOpen() { return fxMapModalEl.classList.contains('open'); }
function closeFxMapModal() { fxMapModalEl.classList.remove('open'); fxMapTarget = null; syncBrushCursor(); }

function bindFxMap(ref) {
    const t = fxMapTarget;
    if (!t) { setStatus('The picker was closed — that image is not used', 'error'); return; }
    closeFxMapModal();
    t.onPick(ref);
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
        card.addEventListener('click', () => bindFxMap(s.ref || { key: s.id, name: s.name }));
        cards.appendChild(card);
    }
    group.appendChild(head);
    group.appendChild(cards);
    return group;
}

function openFxMapModal(l, effect, slotKey, opts) {
    // 卡片的载荷默认还是 {key, name} —— 绑图要的就是这两下;别的用途(姿态识别)让条目自带
    // ref,把"这是工作区的第几号图"还是"这是那一层的这张 PNG"分清楚。
    let spec;
    if (opts) {
        spec = {
            title: opts.title || 'Pick an image',
            sub: opts.sub || '',
            groups: opts.groups || [],
            file: opts.file === true,
            hint: opts.hint || 'Nothing to pick from yet.',
            onPick: opts.onPick,
        };
    } else {
        if (!layerTakesEffects(l) || !EFFECT_TYPES[effect.type]) return;
        const slot = fxMapSlots(effect).find(s => s.key === (slotKey || 'map'));
        if (!slot) return;
        const layerId = l.id, effectId = effect.id;
        spec = {
            title: `Bind a ${slot.role.toLowerCase()} map`,
            sub: fxMapSubDefault,
            groups: [{ title: 'Workspace', items: stagingItems.filter(s => s && s.src && s.id !== GUIDANCE_CARD_ID) }],
            file: true,
            hint: 'The workspace holds no images yet — use From file below.',
            onPick(ref) {
                const layer = getLayer(layerId);
                // 按 id 找它所属的那枚记录:老名字 `l.effects` 只看最左边那一枚容器,右边那枚里的一步绑图会
                // 静默什么都不发生。
                const e = layer && effectById(layer, effectId);
                if (!e) return;
                // 整体替换,不原地改:cloneEffects 深拷贝只到 params 这一层,槽对象在 undo 快照之间是共享的。
                e.params[slot.key] = ref;
                fxStructuralChange(layer, ref ? 'Bound a map image' : 'Cleared a map image');
                setStatus(ref ? `Bound「${ref.name}」as the ${fxMapRole(e, slot.key)} map`
                    : `Unbound the ${fxMapRole(e, slot.key)} map`, 'success');
            },
        };
    }
    fxMapTarget = { onPick: spec.onPick };
    fxMapTitleEl.textContent = spec.title;
    if (fxMapSubEl) fxMapSubEl.textContent = spec.sub;
    fxMapGroupsEl.textContent = '';
    let shown = false;
    for (const g of spec.groups) {
        if (!g.items.length) continue;
        fxMapGroupsEl.appendChild(fxMapCardGroup(g.title, g.items));
        shown = true;
    }
    if (!shown) {
        const hint = document.createElement('div');
        hint.className = 'modal-hint';
        hint.textContent = spec.hint;
        fxMapGroupsEl.appendChild(hint);
    }
    if (fxMapFileBtnEl) fxMapFileBtnEl.style.display = spec.file ? '' : 'none';
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
    // 按 guid 找绑定来源,不筛类型 —— 这一行要认得所有能被绑的 attribute (direction/plane/…),
    // 筛类型是选择器 (fxDirInventory) 的事:筛错了这里就是一句 "missing attribute",
    // 而绑定本身活得好好的 (特效读的是记录表, 不是这张名单)。
    if (!ref) return null;
    for (const doc of documents) {
        if (isSceneDoc(doc)) continue;
        const docName = doc.name || 'Untitled';
        const ls = doc === activeDoc ? layers : ((doc.ctx && doc.ctx.layers) || []);
        for (const l of ls) {
            if (l.isMaskLayer) continue;
            for (const r of attrRecordsOf(l)) {
                if (r.id === ref && r.desc && r.desc.rotation) return `${docName} \u00b7 ${l.name}`;
            }
        }
    }
    return null;
}

function fxDirInventory(types) {
    const want = types || ['direction'];
    const out = [];
    for (const doc of documents) {
        if (isSceneDoc(doc)) continue;
        const docName = doc.name || 'Untitled';
        const ls = doc === activeDoc ? layers : ((doc.ctx && doc.ctx.layers) || []);
        for (const l of ls) {
            if (l.isMaskLayer) continue;
            for (const r of attrRecordsOf(l)) {
                if (want.indexOf(r.type) < 0 || !r.desc || !r.desc.rotation) continue;
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
    fxStructuralChange(l, ref ? 'Bound a direction reference' : 'Cleared a direction reference');
    const where = ref ? fxDirSourceName(ref) : null;
    setStatus(ref ? `「${where}」's Direction now drives this step`
        : 'Unbound — the step is back on its own knobs', 'success');
}

function openFxDirModal(l, effect, key, types) {
    if (!layerTakesEffects(l) || !EFFECT_TYPES[effect.type]) return;
    const want = types || ['direction'];
    fxDirTarget = { layerId: l.id, effectId: effect.id, key: key || 'dirRef' };
    fxDirTitleEl.textContent = 'Bind a ' + want[0][0].toUpperCase() + want[0].slice(1);
    fxDirGroupsEl.textContent = '';
    const hits = fxDirInventory(want);
    if (!hits.length) {
        const hint = document.createElement('div');
        hint.className = 'modal-hint';
        hint.textContent = `No ${want[0]} attribute in this project — add one from a layer\u2019s \u002B menu.`;
        fxDirGroupsEl.appendChild(hint);
    }
    // 分组小标题 = 文档 (作用域),卡上短名 = 图层;缩略图从描述符现烘 (inactive 文档的面不在档)。
    // plane 画它自己的正面图 (盘 + 法线记号),direction 家族画方向箭头。
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
        card.title = hit.r.type === 'plane'
            ? `${hit.docName} \u00b7 ${hit.l.name} — plane`
            : `${Math.round(dirWrap360(e.yaw))}\u00b0 / ${Math.round(e.pitch)}\u00b0 — ${hit.docName} \u00b7 ${hit.l.name}`;
        const cv = document.createElement('canvas');
        cv.className = 'tag-mode-thumb';
        cv.width = 168; cv.height = 112;
        cv.getContext('2d').drawImage(
            hit.r.type === 'plane'
                ? renderGeometryBuffer('plane', hit.r.desc, 168, 112)
                : renderDirectionBuffer(hit.r.desc, 168, 112), 0, 0);
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

// 「看加特效前原样」这颗总开关：翻状态（setEffectsBypass 自己会落盘并作废所有折叠缓存）、
// 报一句。唯一的入口是宿主 dock 头部那颗按钮（回发的 'fx-bypass'），页面这边只剩这一句落点。
function toggleEffectsBypass() {
    setEffectsBypass(!effectsBypass);
    setStatus(effectsBypass ? 'Effects suspended — the chains are still on their layers' : 'Effects resumed');
}

