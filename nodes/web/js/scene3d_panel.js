/* 3D tab 的右栏:整个 #sidePanel 在这期间换成 Scene 把手 + Hierarchy + Inspector。
   词汇照兄弟小节对齐 —— panel-head/panel-label 挑大梁、长说明进 tooltip、枚举用分段 mini-btn、
   数值行用 control-row,不新增说明性读数行。 */

(function panel() {
    const el = id => document.getElementById(id);
    let menuOpen = false;

    const KIND_ICON = {
        model: '<svg viewBox="0 0 10 10" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M5 1 9 3v4L5 9 1 7V3z"/><path d="M5 1v8M1 3l4 2 4-2"/></svg>',
        primitive: '<svg viewBox="0 0 10 10" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="1.6" y="1.6" width="6.8" height="6.8"/></svg>',
        light: '<svg viewBox="0 0 10 10" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.1"><circle cx="5" cy="5" r="2.2"/><path d="M5 .8v1.2M5 8v1.2M.8 5H2M8 5h1.2"/></svg>',
        camera: '<svg viewBox="0 0 10 10" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M1.4 3h4.2v4H1.4z"/><path d="M5.6 5 8.6 3v4z"/></svg>',
    };

    // ---- Hierarchy ----
    function renderHierarchy() {
        const list = el('sceneHierarchy');
        if (!list || !Scene3D.rec) return;
        list.innerHTML = '';
        for (const o of Scene3D.rec.objects) {
            const row = document.createElement('div');
            row.className = 's3d-row' + (o.id === Scene3D.rec.selectedId ? ' selected' : '');
            row.title = `${o.name} — click to select · right side hides it`;
            const icon = document.createElement('span');
            icon.className = 's3d-kind';
            icon.innerHTML = KIND_ICON[o.kind] || KIND_ICON.primitive;
            const name = document.createElement('span');
            name.className = 's3d-name';
            name.textContent = o.name;
            name.addEventListener('dblclick', ev => {
                ev.stopPropagation();
                startRenameRow(o, name);
            });
            const eye = document.createElement('button');
            eye.className = 'icon-btn';
            eye.innerHTML = eyeSvg(o.visible);
            eye.title = o.visible ? 'Hide in scene' : 'Show in scene';
            eye.addEventListener('click', ev => {
                ev.stopPropagation();
                o.visible = !o.visible;
                Scene3D.syncObject(o);
                Scene3D.renderPanel();
                Scene3D.invalidate();
                pushHistory();
            });
            row.appendChild(icon); row.appendChild(name); row.appendChild(eye);
            row.addEventListener('click', () => Scene3D.select(o.id));
            list.appendChild(row);
        }
        if (!Scene3D.rec.objects.length) {
            const empty = document.createElement('div');
            empty.className = 's3d-empty';
            empty.textContent = 'No objects — drop a model here or use Add';
            list.appendChild(empty);
        }
    }

    function startRenameRow(o, nameEl) {
        if (nameEl.querySelector('input')) return;
        const input = document.createElement('input');
        input.className = 'layer-rename';
        input.value = o.name;
        nameEl.textContent = '';
        nameEl.appendChild(input);
        input.focus(); input.select();
        let done = false;
        const finish = commit => {
            if (done) return;
            done = true;
            if (commit && input.value.trim()) Scene3D.rename(o.id, input.value.trim());
            else Scene3D.renderPanel();
        };
        input.addEventListener('keydown', e => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(true);
            else if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
    }

    // ---- Inspector ----
    function num(label, value, onInput, opts) {
        const row = document.createElement('div');
        row.className = 'control-row';
        const l = document.createElement('label');
        l.textContent = label;
        const input = document.createElement('input');
        const o = opts || {};
        input.type = o.color ? 'color' : (o.range ? 'range' : 'number');
        if (input.type === 'number') { input.step = o.step || 0.1; }
        if (o.range) { input.min = o.min; input.max = o.max; input.step = o.step || 0.01; }
        input.value = o.color ? value : (value === undefined ? '' : value);
        if (o.title) input.title = o.title;
        input.addEventListener('input', () => onInput(input.value, false));
        input.addEventListener('change', () => onInput(input.value, true));
        row.appendChild(l); row.appendChild(input);
        if (o.readout) {
            const r = document.createElement('span');
            r.className = 'control-value';
            r.textContent = o.readout(value);
            input.addEventListener('input', () => { r.textContent = o.readout(input.value); });
            row.appendChild(r);
        }
        return row;
    }

    function segment(label, options, current, onPick) {
        const row = document.createElement('div');
        row.className = 'control-row';
        const l = document.createElement('label');
        l.textContent = label;
        const g = document.createElement('div');
        g.className = 'mini-group';
        for (const [value, text, title] of options) {
            const b = document.createElement('button');
            b.className = 'mini-btn' + (value === current ? ' active' : '');
            b.textContent = text;
            if (title) b.title = title;
            b.addEventListener('click', () => onPick(value));
            g.appendChild(b);
        }
        row.appendChild(l); row.appendChild(g);
        return row;
    }

    function trsBlock(o, part, label, step) {
        const box = document.createElement('div');
        box.className = 's3d-vec';
        const cap = document.createElement('div');
        cap.className = 's3d-vec-cap';
        cap.textContent = label;
        box.appendChild(cap);
        const row = document.createElement('div');
        row.className = 'control-row s3d-vec-row';
        'XYZ'.split('').forEach((axis, i) => {
            const l = document.createElement('label');
            l.textContent = axis;
            const input = document.createElement('input');
            input.type = 'number';
            input.step = step;
            input.value = round(o.trs[part][i]);
            input.title = `${label} — ${axis}`;
            const write = (commit) => {
                const v = Number(input.value);
                if (!Number.isFinite(v)) return;
                o.trs[part][i] = v;
                Scene3D.syncObject(o);
                Scene3D.invalidate();
                if (commit) pushHistory();
            };
            input.addEventListener('input', () => write(false));
            input.addEventListener('change', () => write(true));
            input.addEventListener('keydown', e => e.stopPropagation());
            row.appendChild(l); row.appendChild(input);
        });
        box.appendChild(row);
        return box;
    }

    const round = n => Math.round(n * 1000) / 1000;

    function renderInspector() {
        const host = el('sceneInspectorBody');
        if (!host || !Scene3D.rec) return;
        host.innerHTML = '';
        const o = Scene3D.find(Scene3D.rec.selectedId);
        if (!o) { environmentBlock(host); return; }

        const nameRow = document.createElement('div');
        nameRow.className = 'control-row';
        const nl = document.createElement('label');
        nl.textContent = 'Name';
        const ni = document.createElement('input');
        ni.type = 'text';
        ni.value = o.name;
        ni.addEventListener('keydown', e => e.stopPropagation());
        ni.addEventListener('change', () => Scene3D.rename(o.id, ni.value.trim() || o.name));
        nameRow.appendChild(nl); nameRow.appendChild(ni);
        host.appendChild(nameRow);

        if (o.kind === 'light') {
            host.appendChild(segment('Type', [
                ['directional', 'Dir', 'Directional light — parallel rays, like the sun.'],
                ['point', 'Point', 'Point light — radiates from its position out to a range.'],
            ], o.lightType, v => {
                o.lightType = v;
                // 灯的型号换了就得重建 three.js 对象(两种光是不同的 light)。
                const live = Scene3D.nodes.get(o.id) || Scene3D.objects.get(o.id);
                if (live && live.parent) live.parent.remove(live);
                Scene3D.nodes.delete(o.id); Scene3D.objects.delete(o.id);
                Scene3D.build(o); Scene3D.syncGizmo();
                Scene3D.renderPanel(); Scene3D.invalidate(); pushHistory();
            }));
            host.appendChild(colorField(o, 'Color'));
            host.appendChild(num('Intensity', o.intensity, (v, commit) => {
                o.intensity = Number(v) || 0;
                Scene3D.syncObject(o); Scene3D.invalidate();
                if (commit) pushHistory();
            }, { range: true, min: 0, max: 8, step: 0.05, readout: v => Number(v).toFixed(2) }));
            if (o.lightType === 'point') {
                host.appendChild(num('Range', o.distance, (v, commit) => {
                    o.distance = Math.max(0, Number(v) || 0);
                    Scene3D.syncObject(o); Scene3D.invalidate();
                    if (commit) pushHistory();
                }, { range: true, min: 0, max: 100, step: 0.5, readout: v => `${Number(v).toFixed(1)} u` }));
            }
            host.appendChild(trsBlock(o, 'p', 'Position', 0.05));
            host.appendChild(trsBlock(o, 'r', 'Rotation', 1));
            return;
        }

        if (o.kind === 'camera') {
            host.appendChild(num('FOV', o.fov, (v, commit) => {
                o.fov = Math.min(170, Math.max(1, Number(v) || 60));
                Scene3D.invalidate();
                if (commit) pushHistory();
            }, { range: true, min: 1, max: 170, step: 1, readout: v => `${Math.round(v)}°` }));
            host.appendChild(trsBlock(o, 'p', 'Position', 0.05));
            host.appendChild(trsBlock(o, 'r', 'Rotation', 1));
            return;
        }

        host.appendChild(trsBlock(o, 'p', 'Position', 0.05));
        host.appendChild(trsBlock(o, 'r', 'Rotation', 1));
        host.appendChild(trsBlock(o, 's', 'Scale', 0.05));
        host.appendChild(colorField(o, 'Color'));
        host.appendChild(num('Opacity', o.opacity === undefined ? 1 : o.opacity, (v, commit) => {
            o.opacity = Math.min(1, Math.max(0, Number(v)));
            Scene3D.syncObject(o); Scene3D.invalidate();
            if (commit) pushHistory();
        }, { range: true, min: 0, max: 1, step: 0.01, readout: v => `${Math.round(v * 100)}%` }));
        if (o.kind === 'primitive') {
            host.appendChild(segment('Shape', [
                ['cube', 'Cube', ''], ['sphere', 'Sphere', ''], ['cylinder', 'Cylinder', ''], ['plane', 'Plane', ''],
            ], o.shape, v => {
                o.shape = v;
                const live = Scene3D.nodes.get(o.id);
                if (live) { live.geometry && live.geometry.dispose(); live.geometry = shapeGeometry(v); }
                Scene3D.invalidate(); Scene3D.renderPanel(); pushHistory();
            }));
        }
        host.appendChild(num('Roughness', o.roughness === undefined ? 0.75 : o.roughness, (v, commit) => {
            o.roughness = Number(v);
            Scene3D.syncObject(o); Scene3D.invalidate();
            if (commit) pushHistory();
        }, { range: true, min: 0, max: 1, step: 0.01 }));
        host.appendChild(num('Metalness', o.metalness === undefined ? 0 : o.metalness, (v, commit) => {
            o.metalness = Number(v);
            Scene3D.syncObject(o); Scene3D.invalidate();
            if (commit) pushHistory();
        }, { range: true, min: 0, max: 1, step: 0.01 }));
        if (o.kind === 'model') {
            const src = document.createElement('div');
            src.className = 's3d-note' + (Scene3D.models.has(o.model && o.model.assetKey) ? '' : ' warn');
            src.textContent = Scene3D.models.has(o.model && o.model.assetKey)
                ? ((o.model && o.model.name) || 'Model')
                : 'Model bytes are not in this session — import the file again';
            host.appendChild(src);
        }
    }

    function shapeGeometry(shape) {
        const THREE = K3D.THREE;
        return {
            cube: () => new THREE.BoxGeometry(1, 1, 1),
            sphere: () => new THREE.SphereGeometry(0.5, 24, 16),
            cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 24),
            plane: () => new THREE.PlaneGeometry(1, 1),
        }[shape]();
    }

    function colorField(o, label) {
        return num(label, (o.color || '#ffffff').slice(0, 7), (v, commit) => {
            o.color = v;
            Scene3D.syncObject(o); Scene3D.invalidate();
            if (commit) pushHistory();
        }, { color: true });
    }

    // 什么都没选中 → Environment,和 Unity 选中空处显示 Lighting 那一屏一个意思。
    // Grid 不在这里:它现在是视口左上角那一枚开关(见 scene3d_view.js 的 setGrid),一个动作一个入口。
    function environmentBlock(host) {
        host.appendChild(num('Ambient', Scene3D.rec.ambient.color, (v, commit) => {
            Scene3D.rec.ambient.color = v;
            Scene3D.applyAmbient();
            if (commit) pushHistory();
        }, { color: true }));
        host.appendChild(num('Intensity', Scene3D.rec.ambient.intensity, (v, commit) => {
            Scene3D.rec.ambient.intensity = Number(v) || 0;
            Scene3D.applyAmbient();
            if (commit) pushHistory();
        }, { range: true, min: 0, max: 2, step: 0.05, readout: v => Number(v).toFixed(2) }));
    }

    // ---- 顶部把手区 ----
    function syncToolButtons() {
        for (const [mode, id] of [['translate', 'sceneMoveBtn'], ['rotate', 'sceneRotateBtn'], ['scale', 'sceneScaleBtn']]) {
            const b = el(id);
            if (b) b.classList.toggle('active', Scene3D.tool === mode);
        }
        // Pivot 两枚各写死一个目的地,点亮的是当前那一个 —— 和别处的两态开关同一个规矩。
        el('sceneLocalBtn').classList.toggle('active', Scene3D.space === 'local');
        el('sceneGlobalBtn').classList.toggle('active', Scene3D.space === 'world');
    }

    Scene3D.renderPanel = function renderPanel() {
        if (!Scene3D.active) return;
        renderHierarchy();
        renderInspector();
        syncToolButtons();
        // 没有宿主行(场景 tab 是从别处建出来的、或者那一行已经被删了)就没地方可烘。
        const bake = el('sceneBakeBtn');
        if (bake) bake.disabled = !Scene3D.entry || !sceneHostRow(Scene3D.entry);
    };

    function closeSceneMenu() {
        menuOpen = false;
        const m = el('sceneAddMenu');
        if (m) m.hidden = true;
        const b = el('sceneAddBtn');
        if (b) b.setAttribute('aria-expanded', 'false');
    }

    let wired = false;
    Scene3D.wirePanel = function wirePanel() {
        if (wired) return;
        wired = true;
        el('sceneMoveBtn').addEventListener('click', () => Scene3D.setTool('translate'));
        el('sceneRotateBtn').addEventListener('click', () => Scene3D.setTool('rotate'));
        el('sceneScaleBtn').addEventListener('click', () => Scene3D.setTool('scale'));
        el('sceneFocusBtn').addEventListener('click', () => Scene3D.focus());
        el('sceneLocalBtn').addEventListener('click', () => Scene3D.setSpace('local'));
        el('sceneGlobalBtn').addEventListener('click', () => Scene3D.setSpace('world'));
        // 视口左上角那枚浮层开关。点亮状态由 setGrid 自己刷新(它是记录的唯一出口),
        // 这里只管按下 —— G 键走同一条路。
        el('sceneGridBtn').addEventListener('click', () => Scene3D.setGrid(!(Scene3D.rec && Scene3D.rec.grid)));
        el('sceneAddBtn').addEventListener('click', e => {
            e.stopPropagation();
            if (menuOpen) closeSceneMenu();
            else {
                closeSceneMenu();
                menuOpen = true;
                el('sceneAddMenu').hidden = false;
                el('sceneAddBtn').setAttribute('aria-expanded', 'true');
            }
        });
        document.addEventListener('mousedown', e => {
            if (menuOpen && !el('scenePanel').contains(e.target)) closeSceneMenu();
        });
        el('s3dAddModel').addEventListener('click', () => { closeSceneMenu(); import3DModels(); });
        for (const [id, shape] of [['s3dAddCube', 'cube'], ['s3dAddSphere', 'sphere'],
            ['s3dAddCylinder', 'cylinder'], ['s3dAddPlane', 'plane']]) {
            el(id).addEventListener('click', () => {
                closeSceneMenu();
                Scene3D.add(Scene3D.makeObject({ kind: 'primitive', name: shape[0].toUpperCase() + shape.slice(1), shape }));
            });
        }
        el('s3dAddDir').addEventListener('click', () => {
            closeSceneMenu();
            Scene3D.add(Scene3D.makeObject({ kind: 'light', lightType: 'directional', name: 'Directional Light',
                trs: { p: [0, 3, 0], r: [50, -30, 0], s: [1, 1, 1] } }));
        });
        el('s3dAddPoint').addEventListener('click', () => {
            closeSceneMenu();
            Scene3D.add(Scene3D.makeObject({ kind: 'light', lightType: 'point', name: 'Point Light' }));
        });
        el('s3dAddCam').addEventListener('click', () => {
            closeSceneMenu();
            Scene3D.add(Scene3D.makeObject({ kind: 'camera', name: 'Camera', trs: { p: [0, 1, -4], r: [0, 0, 0], s: [1, 1, 1] } }));
        });
        el('sceneImportBtn').addEventListener('click', () => import3DModels());
        el('sceneBakeBtn').addEventListener('click', () => bake3DLayer());
        el('sceneDeleteBtn').addEventListener('click', () => {
            if (Scene3D.rec && Scene3D.rec.selectedId !== null) Scene3D.remove(Scene3D.rec.selectedId);
        });
        const file = el('modelFile');
        file.addEventListener('change', () => {
            Scene3D.importFiles(file.files);
            file.value = '';
        });
        // 拖模型进场景不需要第二条路:页面的 window 级 drop 早就在跑 routeImportFiles,
        // 那条路由在 3D tab 开着时把模型交回这里(见 blend_node.html)。
    };

    function import3DModels() {
        // 浏览器自己的选择框就够用(模型只要读字节,不需要写回),和 fxMapFile 那两枚同一条路。
        el('modelFile').click();
    }
})();
