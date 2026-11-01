// ── 键盘映射：唯一真源 ──────────────────────────────────────────────────────────────────────────
//
// 为什么表在这边（页面）而不是宿主：绝大多数命令的执行体就在这个页面里（工具字母、Tab/`、
// 方向键、Ctrl 系列），宿主只跑其中那几条"全局"命令（Alt+P 停靠编辑、Ctrl+S、Ctrl+Z/Y）。
// 于是表放在消费最多的一侧，宿主那边**不手抄**：构建时 `tools/gen_keymap.cjs` 把本文件求值成
// `ui/sampler_node/src/keymap.generated.ts`（同一次 build 内，不可能落后），宿主 Settings 的
// Key Bindings 屏就是照它渲染的。
//
// 用户的自定义存 localStorage（键 `sampler.keymap`）。宿主与画布 iframe 同源 ⇒ 天然共享一份；
// 谁改了另一边都能靠 `storage` 事件立刻看见，不需要 postMessage 往返。
//
// chord 写法：`修饰+修饰+主键`。修饰只认 Ctrl / Shift / Alt，大小写随意；**Ctrl 在 macOS 上也
// 等于 Cmd**（这个仓向来这么认，见 hotkeys.ts 的文件头）。主键写字母、数字、Tab、Space、
// Enter、Escape、Delete、Backspace、ArrowLeft/Right/Up/Down，或单个标点（` X [ ] - =）。
//
// 两条语义，改的时候别丢：
//   1. **修饰必须完全一致**。`Ctrl+Z` 不会吃 `Ctrl+Shift+Z` —— 那两条是不同的命令（撤销/重做）。
//   2. 但有一类命令的 Shift 是**参数**不是绑定的一部分（方向键微调：Shift = 走 10 像素）。
//      那些条目写 `shiftAsParam: true`，判定时忽略 Shift。
//
// **一条命令可以在几个面上都算命中的**（`scopes`，不写就只有 `scope` 那一个面）：Brush / Eraser
// 在画布与卷帘上是同一件事，所以它们写 `scopes: ['canvas', 'midi']`。冲突判定因此不再是"同一个
// scope"，而是**两个 scope 集有交集**才算可能撞车（交集为空的两条命令各按各的键，互不相干）。
//
// `holdable: true` = 这条命令的键默认是**按住才有效**，用户可以在 Key Bindings 里把它改成
// 按一下切换；笔刷/橡皮不在此列（它们是黏住的工具，不是手势）。见宿主 `workbench/cutStore.ts`。
//
// 新增一条命令的规矩：先在这里加表项 → 页面/宿主里用 `KB.hit(e, 'id')` / `hit(e, 'id')` 引用 →
// `python tests/keymap.py` 双向核对（表里没人用、代码里没登记，两种都会红）。

var KOLID_KEYMAP = ([
    // ── File ──────────────────────────────────────────────────────────────────────────────────
    { id: 'file.save', group: 'File', label: 'Save document', scope: 'app',
      keys: ['Ctrl+S'],
      note: 'Saves the .cud in place. Above the text-field guard on purpose: typing a prompt and pressing it must save.' },

    // ── Edit ──────────────────────────────────────────────────────────────────────────────────
    // undo/redo 排在 scope app：宿主先跑（视频栈有步时它撤那一笔），没接住才算画布的。
    { id: 'edit.undo', group: 'Edit', label: 'Undo', scope: 'app', keys: ['Ctrl+Z'] },
    { id: 'edit.redo', group: 'Edit', label: 'Redo', scope: 'app', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'] },
    { id: 'edit.copy', group: 'Edit', label: 'Copy selection', scope: 'canvas', keys: ['Ctrl+C'] },
    { id: 'edit.paste', group: 'Edit', label: 'Paste', scope: 'canvas', keys: ['Ctrl+V'] },
    { id: 'edit.select-all', group: 'Edit', label: 'Select all layers', scope: 'canvas', keys: ['Ctrl+A'] },
    { id: 'edit.deselect', group: 'Edit', label: 'Deselect', scope: 'canvas', keys: ['Ctrl+D'] },

    // ── Layers ────────────────────────────────────────────────────────────────────────────────
    { id: 'layer.transform', group: 'Layers', label: 'Transform box', scope: 'canvas', keys: ['T', 'Ctrl+T'] },
    { id: 'layer.text-box', group: 'Layers', label: 'Draw a new text layer', scope: 'canvas', keys: ['Alt+T'] },
    { id: 'layer.confirm', group: 'Layers', label: 'Apply / edit text', scope: 'canvas', keys: ['Enter'] },
    { id: 'layer.delete', group: 'Layers', label: 'Delete layers', scope: 'canvas', keys: ['Delete', 'Backspace'] },
    { id: 'layer.nudge-left', group: 'Layers', label: 'Nudge left', scope: 'canvas', keys: ['ArrowLeft'], shiftAsParam: true },
    { id: 'layer.nudge-right', group: 'Layers', label: 'Nudge right', scope: 'canvas', keys: ['ArrowRight'], shiftAsParam: true },
    { id: 'layer.nudge-up', group: 'Layers', label: 'Nudge up', scope: 'canvas', keys: ['ArrowUp'], shiftAsParam: true },
    { id: 'layer.nudge-down', group: 'Layers', label: 'Nudge down', scope: 'canvas', keys: ['ArrowDown'], shiftAsParam: true },

    // ── Tools ─────────────────────────────────────────────────────────────────────────────────
    { id: 'tool.zoom', group: 'Tools', label: 'Zoom tool', scope: 'canvas', keys: ['Z'] },
    { id: 'tool.pan', group: 'Tools', label: 'Pan tool', scope: 'canvas', keys: ['H'] },
    { id: 'tool.rotate', group: 'Tools', label: 'Rotate tool', scope: 'canvas', keys: ['R'] },
    // Brush / Eraser 在卷帘上也是同一件事（画出/擦掉音符），所以它们同时算 midi 面的命令。
    { id: 'tool.brush', group: 'Tools', label: 'Brush', scope: 'canvas', scopes: ['canvas', 'midi'], keys: ['B'] },
    { id: 'tool.eraser', group: 'Tools', label: 'Eraser', scope: 'canvas', scopes: ['canvas', 'midi'], keys: ['E'] },
    // Cursor = 手上什么都不拿：画布回到无工具（点一下仍可选中图层），卷帘上不落音也不擦音，
    // 时间线上撤掉剪刀。三个面各放各的工具，与 Brush / Eraser 一样同时算 canvas 与 midi 面，
    // 另加 timeline —— 这一条是"把刀放下"。
    { id: 'tool.cursor', group: 'Tools', label: 'Cursor (no tool)', scope: 'canvas',
      scopes: ['canvas', 'midi', 'timeline'], keys: ['A'],
      note: 'Puts every tool down: the plain arrow, no painting, no note on an empty click, no blade on the timeline. '
        + 'The view is left alone (Esc is the one that also refits it).' },
    { id: 'tool.bucket', group: 'Tools', label: 'Fill', scope: 'canvas', keys: ['G'] },
    { id: 'tool.marquee', group: 'Tools', label: 'Rectangle marquee', scope: 'canvas', keys: ['M'] },
    { id: 'tool.lasso', group: 'Tools', label: 'Lasso', scope: 'canvas', keys: ['L'] },

    // ── Cut（三个面各一条，默认都是 C）────────────────────────────────────────────────────────
    // 同一个字母在三个面上是三种剪法：画布上是"把画布裁成框"（PS 裁切模式：Enter 落地、Esc 收起），
    // 时间线上是"在指针处剪开段"，卷帘上是"在指针处剪开音符"。按哪一条由**鼠标所在的面**决定
    // （宿主 cutStore 的路由），与键盘焦点无关 —— 所以点哪扇窗、按 C，剪的就是那扇窗里的东西。
    // 两条"剪"可按 `holdable` 走 Hold / Toggle；画布那条是模态框（Enter 落地），没有按住这回事。
    { id: 'cut.canvas', group: 'Cut', label: 'Crop the canvas to a box', scope: 'canvas', keys: ['C'],
      note: 'Frame mode: drag a box over the canvas, Enter crops to it, Esc leaves without changing anything.' },
    { id: 'cut.timeline', group: 'Cut', label: 'Cut segments', scope: 'timeline', keys: ['C'], holdable: true },
    { id: 'cut.midi', group: 'Cut', label: 'Cut notes', scope: 'midi', keys: ['C'], holdable: true },

    // ── Paint ─────────────────────────────────────────────────────────────────────────────────
    { id: 'paint.swap-colors', group: 'Paint', label: 'Swap foreground / background', scope: 'canvas', keys: ['X'] },
    { id: 'paint.decal', group: 'Paint', label: 'Paint target — last Image step', scope: 'canvas', keys: ['Tab'] },
    { id: 'paint.mask', group: 'Paint', label: 'Paint target — last Mask step', scope: 'canvas', keys: ['`'] },

    // ── View ──────────────────────────────────────────────────────────────────────────────────
    // Esc 一条管到底：先关菜单、收网格、取消拖拽，再退工具、回到默认视图。
    { id: 'view.cancel', group: 'View', label: 'Cancel / reset view', scope: 'canvas', keys: ['Escape'] },
    { id: 'view.flip', group: 'View', label: 'Flip view', scope: 'canvas', keys: ['Ctrl+F'] },
    { id: 'view.hold-pan', group: 'View', label: 'Hold to pan', scope: 'canvas', keys: ['Space'],
      note: 'Held, not tapped — press and drag pans the canvas, middle-drag does the same without a key.' },

    // ── Panels ────────────────────────────────────────────────────────────────────────────────
    { id: 'panel.geometry', group: 'Panels', label: 'Show Geometry panel', scope: 'canvas', keys: ['D'] },
    { id: 'panel.pose', group: 'Panels', label: 'Show Pose panel', scope: 'canvas', keys: ['P'] },

    // ── Timeline（视频时间线，宿主渲染）────────────────────────────────────────────────────────
    { id: 'timeline.copy', group: 'Timeline', label: 'Copy segments', scope: 'timeline', keys: ['Ctrl+C'] },
    { id: 'timeline.paste', group: 'Timeline', label: 'Paste segments', scope: 'timeline', keys: ['Ctrl+V'] },
    { id: 'timeline.delete', group: 'Timeline', label: 'Delete segments', scope: 'timeline', keys: ['Delete', 'Backspace'] },

    // ── Keyframes ─────────────────────────────────────────────────────────────────────────────
    { id: 'keyframes.add', group: 'Keyframes', label: 'Add keyframe at playhead', scope: 'keyframes', keys: ['K'] },
    { id: 'keyframes.fit', group: 'Keyframes', label: 'Fit keys in view', scope: 'keyframes', keys: ['F'] },
    { id: 'keyframes.delete', group: 'Keyframes', label: 'Delete selected keys', scope: 'keyframes', keys: ['Delete', 'Backspace'] },

    // ── Assets ────────────────────────────────────────────────────────────────────────────────
    { id: 'assets.select-all', group: 'Assets', label: 'Select all assets', scope: 'assets', keys: ['Ctrl+A'] },
    { id: 'assets.delete', group: 'Assets', label: 'Delete / remove asset', scope: 'assets', keys: ['Delete'] },

    // ── App（宿主界面本身）────────────────────────────────────────────────────────────────────
    { id: 'app.dock-edit', group: 'App', label: 'Toggle dock edit mode', scope: 'app', keys: ['Alt+P'] },
]);

// ── 解析与判定 ────────────────────────────────────────────────────────────────────────────────
// 这一段的语义要与宿主 `ui/sampler_node/src/keybindings.ts` 逐条一致 —— 两边各写一份是因为
// 一边跑在 `<script>` 里、一边跑在 bundle 里，但**判定必须是同一个答案**，所以
// `temporary/_test_keymap_parity.mjs` 会把两边喂同一批事件逐条对拍。
(function (root) {
    'use strict';

    var STORE = 'sampler.keymap';
    var CHANGE = 'kolid-keymap';       // 同窗口内的变更广播（storage 事件只到"别人"的 document）

    var defs = KOLID_KEYMAP;
    var byId = Object.create(null);
    for (var i = 0; i < defs.length; i++) byId[defs[i].id] = defs[i];

    // localStorage 在 Node（生成器）里不存在 —— 那里只需要这张表，覆盖表当空的。
    function store() {
        try { return root.localStorage || null; } catch (e) { return null; }
    }

    var overrides = null;
    function readOverrides() {
        var s = store();
        if (!s) return {};
        try {
            var raw = JSON.parse(s.getItem(STORE) || '{}');
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
            var out = {};
            for (var k in raw) if (byId[k] && (raw[k] === null || typeof raw[k] === 'string')) out[k] = raw[k];
            return out;
        } catch (e) { return {}; }
    }
    function overridesNow() {
        if (overrides === null) overrides = readOverrides();
        return overrides;
    }

    // ── chord 的解析 ──
    var MODS = { ctrl: 'ctrl', control: 'ctrl', cmd: 'ctrl', meta: 'ctrl', command: 'ctrl',
                 shift: 'shift', alt: 'alt', option: 'alt', opt: 'alt' };

    // "Ctrl+Shift+Z" → { ctrl:1, shift:1, alt:0, key:'z' }。解析不了的返回 null（表格式写错时
    // 宁可这条永远不命中，也不要在启动时抛一个把整页脚本带走的错）。
    function parse(chord) {
        if (typeof chord !== 'string' || !chord) return null;
        var parts = chord.split('+');
        // "Ctrl++" / "+" 这类以加号为主键的写法：末尾空串还原成 '+'
        if (parts.length > 1 && parts[parts.length - 1] === '') { parts.pop(); parts[parts.length - 1] = '+'; }
        var out = { ctrl: 0, shift: 0, alt: 0, key: '' };
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i].trim();
            if (!p) return null;
            var m = MODS[p.toLowerCase()];
            if (m) { out[m] = 1; continue; }
            if (out.key) return null;           // 两个主键 = 写错了
            out.key = p.toLowerCase();
        }
        return out.key ? out : null;
    }

    // 事件的主键与一段 chord 的主键是不是同一个键。
    // 三条路一起认（抄 hotkeys.ts 的 keyIs + 常见的 code 兜底）：
    //   ① e.key 归一后相等；② 单字母再看物理键位（macOS 上 Option+P 打出来是 π，e.key 根本不是 p）；
    //   ③ 数字看 DigitN，空格/制表/方向键看 code（Firefox 老写法给出 'Spacebar'）。
    function keyMatch(e, key) {
        var k = String(e.key || '').toLowerCase();
        if (k === key) return true;
        if (key === 'space' || key === ' ') return k === ' ' || k === 'spacebar';
        if (key === 'esc') return k === 'escape';
        if (key.length === 1) {
            var up = key.toUpperCase();
            if (e.code === 'Key' + up) return true;
            if (e.code === 'Digit' + key) return true;
            if (e.code === 'Numpad' + key) return true;
        }
        var code = { tab: 'Tab', enter: 'Enter', escape: 'Escape', delete: 'Delete', backspace: 'Backspace',
                     arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown' }[key];
        return !!code && e.code === code;
    }

    function modHeld(e) { return !!(e.ctrlKey || e.metaKey); }

    function matches(e, c, def) {
        if (c.ctrl !== (modHeld(e) ? 1 : 0)) return false;
        if (c.alt !== (e.altKey ? 1 : 0)) return false;
        if (!(def && def.shiftAsParam) && c.shift !== (e.shiftKey ? 1 : 0)) return false;
        return keyMatch(e, c.key);
    }

    function chordsOf(id) {
        var o = overridesNow();
        if (id in o) return o[id] === null ? [] : [o[id]];
        var def = byId[id];
        return def ? def.keys.slice() : [];
    }

    /** 这个事件是不是这条命令。未知 id 一律 false（拼错的 id 宁可静默也不炸）。 */
    function hit(e, id) {
        if (!e || !byId[id]) return false;
        var def = byId[id];
        var chords = chordsOf(id);
        for (var i = 0; i < chords.length; i++) {
            var c = parse(chords[i]);
            if (c && matches(e, c, def)) return true;
        }
        return false;
    }

    /** 事件 → "Ctrl+Shift+Z"（录制那一屏用）。没有主键（只按了修饰）返回 ''。 */
    function chordOf(e) {
        var key = primaryOf(e);
        if (!key) return '';
        var mods = [];
        if (modHeld(e)) mods.push('Ctrl');
        if (e.shiftKey) mods.push('Shift');
        if (e.altKey) mods.push('Alt');
        return mods.concat([key]).join('+');
    }

    // e.key 有时是修饰键本身或 'Process'（输入法），那些要返回 ''，否则录制会记下一个假键。
    var NAMED = { ' ': 'Space', spacebar: 'Space', escape: 'Escape', esc: 'Escape', enter: 'Enter',
                  tab: 'Tab', delete: 'Delete', backspace: 'Backspace', arrowleft: 'ArrowLeft',
                  arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown' };
    function primaryOf(e) {
        var k = String(e.key || '');
        if (!k) return '';
        if (/^(control|shift|alt|meta|os|hyper|super|capslock|fn|dead)$/i.test(k)) return '';
        if (k === 'Process' || k === 'Unidentified') return '';
        var named = NAMED[k.toLowerCase()];
        if (named) return named;
        // 物理键位优先：中文输入法激活时 e.key 常是 'Process'，而 code 永远在。
        var m = /^Key([A-Z])$/.exec(e.code || '');
        if (m) return m[1];
        m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code || '');
        if (m) return m[1];
        if (k.length === 1) return k.toUpperCase();
        return '';
    }

    function write(next) {
        overrides = next;
        var s = store();
        if (s) { try { s.setItem(STORE, JSON.stringify(next)); } catch (e) { /* 满了/隐私模式：本次仍生效 */ } }
        broadcast();
    }

    function broadcast() {
        // 同窗口内的订阅者（本页的 UI、宿主的 Key Bindings 屏）靠这个立刻知道；另一个 document
        // 靠浏览器自己的 storage 事件，那里不用我们操心。
        try {
            root.dispatchEvent(new root.Event(CHANGE));
        } catch (e) { /* 没有 Event（Node/老环境）：只影响"立刻刷新"，下一次读还是新的 */ }
    }

    /** 把一条命令绑到某个 chord，null = 解绑。返回归一化后的 chord（失败给 null）—— 与宿主
     *  `setBinding` 同一个契约：调用方拿它去显示，而不是自己再格式化一遍。 */
    function setBinding(id, chord) {
        if (!byId[id]) return null;
        if (chord !== null) {
            var c = parse(chord);
            if (!c) return null;
            // 归一化：修饰顺序固定成 Ctrl+Shift+Alt+主键，免得同一组键存出三种写法。
            var key = chord.split('+').pop().trim();
            if (!key) key = '+';
            // 单个字母统一大写（与 chordOf 记下来的写法一致），标点/数字原样。
            if (key.length === 1 && /[a-z]/i.test(key)) key = key.toUpperCase();
            chord = [c.ctrl ? 'Ctrl' : '', c.shift ? 'Shift' : '', c.alt ? 'Alt' : '', key]
                .filter(Boolean).join('+');
        }
        var next = {};
        for (var k in overridesNow()) next[k] = overridesNow()[k];
        next[id] = chord;
        write(next);
        return chord;
    }

    function resetBinding(id) {
        var next = {};
        var cur = overridesNow();
        for (var k in cur) if (k !== id) next[k] = cur[k];
        write(next);
    }

    function resetAll() { write({}); }

    /** 一条命令生效的面：`scopes` 写了就用它，否则只有 `scope` 那一个。 */
    function scopesOf(def) {
        return (def && def.scopes && def.scopes.length) ? def.scopes : [def.scope];
    }

    /** 两个面集有没有交集 —— 只有交集非空的两条命令才可能同时吃到同一个键。 */
    function shareScope(a, b) {
        var sa = scopesOf(a), sb = scopesOf(b);
        for (var i = 0; i < sa.length; i++) if (sb.indexOf(sa[i]) >= 0) return true;
        return false;
    }

    /** 面集有交集、且已经占了这个 chord 的别的命令（冲突提示用）。 */
    function conflicts(id, chord) {
        if (!chord || !byId[id]) return [];
        var out = [];
        for (var i = 0; i < defs.length; i++) {
            var d = defs[i];
            if (d.id === id || !shareScope(byId[id], d)) continue;
            var cs = chordsOf(d.id);
            for (var j = 0; j < cs.length; j++) {
                var a = parse(cs[j]), b = parse(chord);
                if (a && b && a.ctrl === b.ctrl && a.alt === b.alt && a.key === b.key
                    && (d.shiftAsParam || a.shift === b.shift)) { out.push(d.id); break; }
            }
        }
        return out;
    }

    /** 订阅变更：本窗口的改动 + 另一个 document 改 localStorage 时浏览器派来的 storage 事件。 */
    function onChange(fn) {
        if (typeof fn !== 'function') return function () {};
        var local = function () { overrides = null; fn(); };
        var cross = function (ev) { if (!ev || ev.key === STORE || ev.key === null) local(); };
        try { root.addEventListener(CHANGE, local); } catch (e) { /* 无 window */ }
        try { root.addEventListener('storage', cross); } catch (e) { /* 同上 */ }
        return function () {
            try { root.removeEventListener(CHANGE, local); } catch (e) {}
            try { root.removeEventListener('storage', cross); } catch (e) {}
        };
    }

    // 自动跟着别的 document 走：宿主 Settings 改一个键，浏览器会给这个 iframe 派 storage 事件，
    // 这里把覆盖表缓存作废就够（下一次判定现读）。没有这一步，页面只在第一次判定时读一次，
    // 之后用户在 Settings 里怎么改都不生效 —— 而且不会有任何报错。
    try {
        root.addEventListener('storage', function (ev) {
            if (!ev || ev.key === STORE || ev.key === null) overrides = null;
        });
    } catch (e) { /* 没有 window（生成器/测试里）：调用方自己决定何时重读 */ }

    root.KB = {
        defs: defs,
        STORE: STORE,
        get: function (id) { return byId[id] || null; },
        scopesOf: scopesOf,
        chordsOf: chordsOf,
        hit: hit,
        parse: parse,
        chordOf: chordOf,
        conflicts: conflicts,
        setBinding: setBinding,
        resetBinding: resetBinding,
        resetAll: resetAll,
        overrides: function () { return overridesNow(); },
        onChange: onChange,
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
