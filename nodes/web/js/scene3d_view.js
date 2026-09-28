/* 3D 图层的视口:three.js 渲染器、Unity 那种按住右键 + WASDQE 的飞行相机、gizmo 把手、
   点选、拖进来模型、以及「把当前视角烘成图层像素」的 bake。
   状态全部挂在 Scene3D 上(见 scene3d_core.js),这里只补 live 渲染那一半。 */

(function view() {
    let raf = 0, last = 0, dirty = true;
    let renderer, scene, root, cam, grid, axes, ambient, controls, raycaster, host, canvasEl;
    let rt = null, rtSize = [0, 0];

    const V = () => Scene3D.rec.view;

    function ensureLive() {
        if (Scene3D.live) return true;
        if (!Scene3D.available) return false;
        const THREE = K3D.THREE;
        host = document.getElementById('sceneViewport');
        canvasEl = document.getElementById('sceneCanvas');
        renderer = new K3D.THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x1b1b1d);
        root = new THREE.Group();
        root.name = 'scene-root';
        scene.add(root);
        ambient = new THREE.AmbientLight(0xffffff, 0.35);
        scene.add(ambient);
        grid = new THREE.GridHelper(20, 20, 0x505052, 0x2c2c2e);
        axes = new THREE.AxesHelper(1.2);
        grid.material.transparent = true;
        grid.material.opacity = 0.55;
        scene.add(grid);
        scene.add(axes);
        cam = new THREE.PerspectiveCamera(60, 1, 0.01, 4000);
        cam.rotation.order = 'YXZ';
        raycaster = new THREE.Raycaster();
        controls = new K3D.TransformControls(cam, canvasEl);
        controls.setSize(0.9);
        scene.add(controls);
        controls.addEventListener('dragging-changed', e => {
            Scene3D.draggingGizmo = !!e.value;
            cam.userData.blockPick = !!e.value;
            if (e.value) return;
            commitGizmo();
        });
        controls.addEventListener('objectChange', () => { dirty = true; Scene3D.renderPanel(); });
        Scene3D.live = true;
        Scene3D.root = root;
        wirePointer();
        new ResizeObserver(() => resize()).observe(host);
        return true;
    }

    function resize() {
        if (!renderer || !host) return;
        const w = host.clientWidth || 1, h = host.clientHeight || 1;
        renderer.setSize(w, h, false);
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
        dirty = true;
    }

    // ---- 相机 ----
    function applyView() {
        const v = V();
        cam.position.fromArray(v.p);
        cam.rotation.set(v.pitch * Math.PI / 180, v.yaw * Math.PI / 180, 0, 'YXZ');
        cam.fov = v.fov || 60;
        cam.updateProjectionMatrix();
        if (controls) controls.update();
    }

    // 一条 rAF 积分按键,而不是在 pointermove/keydown 里直接挪相机:按住 W 时帧率就是移动
    // 的分辨率,按键事件那种 30ms 一次的跳变会看出台阶。
    function step(dt) {
        const v = V();
        let moved = false;
        const fwd = new K3D.THREE.Vector3();
        cam.getWorldDirection(fwd);
        const right = new K3D.THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
        const k = Scene3D.keys;
        const d = new K3D.THREE.Vector3();
        if (k.has('w')) d.add(fwd);
        if (k.has('s')) d.sub(fwd);
        if (k.has('d')) d.add(right);
        if (k.has('a')) d.sub(right);
        if (k.has('q')) d.y -= 1;
        if (k.has('e')) d.y += 1;
        if (d.lengthSq() > 0) {
            d.normalize().multiplyScalar(Scene3D.speed * dt * (Scene3D.keys.has('shift') ? 3 : 1));
            v.p = [v.p[0] + d.x, v.p[1] + d.y, v.p[2] + d.z];
            moved = true;
        }
        dirty = dirty || moved;
    }

    function loop(ts) {
        raf = requestAnimationFrame(loop);
        const dt = Math.min(0.1, (ts - last) / 1000 || 0);
        last = ts;
        if (Scene3D.looking && Scene3D.keys.size) step(dt);
        if (!dirty) return;
        dirty = false;
        applyView();
        renderer.render(scene, cam);
    }

    Scene3D.invalidate = () => { dirty = true; };

    // ---- 点选 ----
    function pickables() {
        const out = [];
        for (const [, o] of Scene3D.nodes) if (o.visible) out.push(o);
        for (const [, o] of Scene3D.objects) if (o.visible) out.push(o);
        return out;
    }

    // gizmo 的 picker 也在同一个 canvas 上,但它不是场景物体:命中链上遇到 controls 就跳过。
    function isGizmoHit(obj) {
        let p = obj;
        while (p) {
            if (p === controls) return true;
            p = p.parent;
        }
        return false;
    }

    function pickAt(ev) {
        const rect = canvasEl.getBoundingClientRect();
        const ndc = new K3D.THREE.Vector2(
            ((ev.clientX - rect.left) / rect.width) * 2 - 1,
            -((ev.clientY - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(ndc, cam);
        const hits = raycaster.intersectObjects(pickables(), true);
        for (const h of hits) {
            if (isGizmoHit(h.object)) continue;
            let p = h.object;
            while (p && p.userData.s3dId === undefined) p = p.parent;
            if (p) return p.userData.s3dId;
        }
        return null;
    }

    // ---- 指针:右键飞视角,左键选物体/拖把手 ----
    function wirePointer() {
        canvasEl.addEventListener('contextmenu', e => e.preventDefault());
        canvasEl.addEventListener('pointerdown', e => {
            if (e.button === 2) {
                canvasEl.setPointerCapture(e.pointerId);
                Scene3D.looking = true;
                Scene3D.lookStart = { x: e.clientX, y: e.clientY };
                controls.enabled = false;            // 飞的时候把手不吃鼠标
                return;
            }
            if (e.button !== 0 || controls.axis) return;   // 按在把手上就让把手自己处理
            Scene3D.select(pickAt(e));
        });
        canvasEl.addEventListener('pointermove', e => {
            if (!Scene3D.looking) return;
            const s = Scene3D.lookStart;
            const v = V();
            // Unity 的 Scene 视图就是鼠标灵敏度那一套:拖动多少度就转多少度,俯仰夹在 ±89。
            v.yaw -= (e.clientX - s.x) * 0.18;
            v.pitch = Math.max(-89, Math.min(89, v.pitch - (e.clientY - s.y) * 0.18));
            Scene3D.lookStart = { x: e.clientX, y: e.clientY };
            dirty = true;
        });
        const stopLook = e => {
            if (!Scene3D.looking) return;
            Scene3D.looking = false;
            controls.enabled = true;
            if (e && canvasEl.hasPointerCapture && canvasEl.hasPointerCapture(e.pointerId)) {
                canvasEl.releasePointerCapture(e.pointerId);
            }
        };
        canvasEl.addEventListener('pointerup', e => { if (e.button === 2) stopLook(e); });
        canvasEl.addEventListener('pointercancel', stopLook);
        window.addEventListener('blur', () => { stopLook(); Scene3D.keys.clear(); });
        canvasEl.addEventListener('wheel', e => {
            e.preventDefault();
            if (Scene3D.looking) {
                // 按住右键滚轮调飞行速度 —— Unity 自己就是这么做的。
                Scene3D.speed = Math.max(0.05, Math.min(50, Scene3D.speed * (e.deltaY < 0 ? 1.25 : 0.8)));
                setStatus(`Fly speed ${Scene3D.speed.toFixed(2)} u/s`);
                return;
            }
            const v = V();
            const fwd = new K3D.THREE.Vector3();
            cam.getWorldDirection(fwd);
            const k = e.deltaY < 0 ? 1 : -1;
            v.p = v.p.map((n, i) => n + fwd.toArray()[i] * k * Scene3D.speed * 0.35);
            dirty = true;
        }, { passive: false });
    }

    // 把手拖完才回写记录:拖的过程中 three.js 拥有物体,记录只是它松手那一刻的抄本。
    function commitGizmo() {
        const id = Scene3D.rec.selectedId;
        const o = controls.object;
        if (!id || !o) return;
        const desc = Scene3D.find(id);
        if (!desc) return;
        const R = K3D.THREE.MathUtils.RAD2DEG;
        desc.trs = {
            p: [o.position.x, o.position.y, o.position.z],
            r: [o.rotation.x * R, o.rotation.y * R, o.rotation.z * R],
            s: [o.scale.x, o.scale.y, o.scale.z],
        };
        Scene3D.renderPanel();
        pushHistory();
    }

    Scene3D.syncGizmo = function syncGizmo() {
        if (!Scene3D.live) return;
        const id = Scene3D.rec.selectedId;
        const o = id === null || id === undefined ? null : (Scene3D.nodes.get(id) || Scene3D.objects.get(id));
        controls.space = Scene3D.space;
        if (o && (o.isLight || o.userData.previewCamera)) {
            // 灯和相机在 Unity 里也只有移动把手能用(它们没有缩放把手),物体本身靠图标点选。
            controls.setMode(Scene3D.tool === 'scale' ? 'translate' : Scene3D.tool);
            controls.attach(o);
        } else if (o) {
            controls.setMode(Scene3D.tool);
            controls.attach(o);
        } else {
            controls.detach();
        }
        dirty = true;
    };

    // ---- 进出 3D tab ----
    // rec 由调用方给(restoreState 手里那份就是),不给才回落到 entry.ctx.scene —— 换 tab 和撤销
    // 走的都是「先有记录,再让 live 追上它」这一条路。
    Scene3D.enter = function enter(entry, rec) {
        if (!ensureLive()) { setStatus('The 3D engine (js/3d-bundle.js) did not load', 'error'); return false; }
        Scene3D.active = true;
        Scene3D.entry = entry;
        document.getElementById('viewport').style.display = 'none';
        // CSS 给这两块写的都是 display:none,所以清空内联值等于「退回样式」= 还是不显示。
        host.style.display = 'block';
        document.getElementById('panelScroll').style.display = 'none';
        document.getElementById('maskDock').style.display = 'none';
        document.getElementById('layersDock').style.display = 'none';
        document.getElementById('scenePanel').style.display = 'flex';
        Scene3D.loadRec(rec || (entry.ctx && entry.ctx.scene) || Scene3D.blankRecord(''));
        resize();
        Scene3D.renderPanel();
        if (!raf) { last = performance.now(); raf = requestAnimationFrame(loop); }
        return true;
    };

    Scene3D.exit = function exit() {
        if (!Scene3D.active) return;
        Scene3D.active = false;
        Scene3D.entry = null;
        Scene3D.keys.clear();
        Scene3D.looking = false;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        document.getElementById('viewport').style.display = '';
        host.style.display = 'none';
        document.getElementById('panelScroll').style.display = '';
        document.getElementById('maskDock').style.display = '';
        document.getElementById('layersDock').style.display = '';
        document.getElementById('scenePanel').style.display = 'none';
    };

    // 换一份记录活下来:镜像全清,重新按记录建。
    Scene3D.loadRec = function loadRec(rec) {
        Scene3D.rec = rec;
        for (const [, o] of [...Scene3D.nodes, ...Scene3D.objects]) {
            if (o.parent) o.parent.remove(o);
        }
        Scene3D.nodes.clear();
        Scene3D.objects.clear();
        controls.detach();
        Scene3D.sync();
        applyView();
        dirty = true;
    };

    Scene3D.snapshot = function snapshot() { return { scene: Scene3D.cloneRec(Scene3D.rec) }; };
    Scene3D.busy = () => Scene3D.looking || Scene3D.draggingGizmo;

    // ---- 键盘 ----
    // 3D tab 里字母键一律不落到 2D 的工具带上(B 是画笔、E 是缩放把手,同名不同事),
    // 所以除了 Ctrl/Meta 的和弦(撤销、存档仍归页面),这里把按键全吃掉。
    // Unity 自己那一套: 按住右键时 WASDQE 是飞行,不按住时 W/E/R 是三个把手。同一个键两种
    // 身份,按「右键是否按住」分流 —— 移动键始终先进集合,所以中途按下右键就能接着飞。
    const MOVE = new Set(['w', 'a', 's', 'd', 'q', 'e']);
    const TOOLS = { w: 'translate', e: 'rotate', r: 'scale' };
    Scene3D.onKeyDown = function onKeyDown(e) {
        if (e.ctrlKey || e.metaKey) return false;
        // 文本框、下拉、富文本归它自己 —— 分寸照抄页面那道闸门(range / checkbox 仍交给页面按方向键)。
        const tag = (e.target && e.target.tagName || '').toLowerCase();
        const type = (e.target && e.target.type) || '';
        if (tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable)
            || (tag === 'input' && type !== 'range' && type !== 'checkbox')) return false;
        if (e.key === 'Shift') { Scene3D.keys.add('shift'); return true; }
        const key = String(e.key || '').toLowerCase();
        if (key.startsWith('arrow')) { nudgeView(e, key); return true; }
        if (MOVE.has(key) || key === 'r') Scene3D.keys.add(key);
        if (key === 'escape') { Scene3D.select(null); return true; }
        if (key === 'f') { Scene3D.focus(); return true; }
        if (key === 'g') { Scene3D.setGrid(!Scene3D.rec.grid); Scene3D.renderPanel(); return true; }
        if (!Scene3D.looking && TOOLS[key]) Scene3D.setTool(TOOLS[key]);
        if (key === ' ') return true;        // 空格留给页面会改动 2D 视图状态,这里按掉
        // 这三个在 2D 那边是「提交/删除图层/换绘制面」的手势。3D tab 开着的时候它们会打到
        // 藏起来的宿主文档上去(删掉一行、弹出一个看不见的文本框),所以一律按掉。
        if (key === 'enter' || key === 'delete' || key === 'backspace' || key === 'tab') return true;
        return /^[a-z]$/.test(key);
    };
    Scene3D.onKeyUp = function onKeyUp(e) {
        if (e.key === 'Shift') Scene3D.keys.delete('shift');
        Scene3D.keys.delete(String(e.key || '').toLowerCase());
    };

    // 方向键 = 转身(Unity Scene 视图的箭头键也调视线),Shift 加大步长。
    function nudgeView(e, key) {
        const v = V();
        const d = (e.shiftKey ? 5 : 1);
        if (key === 'arrowleft') v.yaw -= d;
        if (key === 'arrowright') v.yaw += d;
        if (key === 'arrowup') v.pitch = Math.min(89, v.pitch + d);
        if (key === 'arrowdown') v.pitch = Math.max(-89, v.pitch - d);
        dirty = true;
    }

    Scene3D.setTool = function setTool(mode) {
        if (Scene3D.tool === mode) return;
        Scene3D.tool = mode;
        Scene3D.syncGizmo();
        Scene3D.renderPanel();
        setStatus(mode === 'translate' ? 'Move tool (W)' : mode === 'rotate' ? 'Rotate tool (E)' : 'Scale tool (R)');
    };

    // Pivot 是两枚固定目的地的键(和别处两态开关一个规矩),所以这里按目标态设,不是 toggle。
    Scene3D.setSpace = function setSpace(mode) {
        if (Scene3D.space === mode) return;
        Scene3D.space = mode;
        controls.space = mode;
        Scene3D.renderPanel();
        setStatus(mode === 'local' ? 'Gizmo pivot — Local' : 'Gizmo pivot — Global');
    };

    // F = Frame Selected:Unity 里按 F 把视线送到选中物上,再按一次拉回原位(这里只做前者)。
    Scene3D.focus = function focus() {
        const THREE = K3D.THREE;
        const id = Scene3D.rec.selectedId;
        const o = id === null || id === undefined ? null : (Scene3D.nodes.get(id) || Scene3D.objects.get(id));
        const box = new THREE.Box3();
        if (o) box.setFromObject(o);
        else box.setFromObject(root);
        if (box.isEmpty()) return;
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3()).length() || 1;
        const dir = new THREE.Vector3();
        cam.getWorldDirection(dir);
        const dist = Math.max(1.2, size * 1.6);
        const p = center.clone().sub(dir.multiplyScalar(dist));
        V().p = [p.x, p.y, p.z];
        dirty = true;
    };

    // ---- 模型进场景 ----
    Scene3D.importFiles = async function importFiles(files) {
        if (!Scene3D.active) { setStatus('Open the 3D tab first — drop the model there', 'error'); return false; }
        const list = [...(files || [])].filter(f => Scene3D.isModelFile(f.name));
        if (!list.length) return false;
        let done = 0;
        for (const f of list) {
            try {
                const bytes = await f.arrayBuffer();
                const ext = f.name.split('.').pop().toLowerCase();
                const tmpl = await Scene3D.parseModel(f.name, bytes);
                const key = Scene3D.storeModel(f.name, ext, bytes);
                Scene3D.putTemplate(key, tmpl);
                Scene3D.add(Scene3D.makeObject({
                    kind: 'model', name: f.name.replace(/\.[^.]+$/, ''),
                    model: { assetKey: key, name: f.name, ext },
                    trs: { p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] },
                }));
                done++;
            } catch (err) {
                setStatus(`Could not read ${f.name}: ${err.message}`, 'error');
            }
        }
        if (done) setStatus(`${done} model${done > 1 ? 's' : ''} imported — scaled to 2 units at the origin`);
        return done > 0;
    };

    // ---- 烘成图层像素 ----
    // 记录里的相机有两种:视口飞行相机(用户正在看的)和场景里的 Camera 物体。选中了 Camera
    // 物体就从它拍,否则就从当前视角拍 —— 和 PS「Render Current View」的分寸一致。
    function captureCanvas(W, H) {
        const THREE = K3D.THREE;
        const sel = Scene3D.rec.selectedId;
        const camObj = sel === null || sel === undefined ? null : Scene3D.objects.get(sel);
        let shot;
        if (camObj && camObj.userData.previewCamera) {
            // 选中了场景里的 Camera 物体就从它拍 —— Unity 的 Game 视图那个分寸。
            const desc = Scene3D.find(sel);
            shot = new THREE.PerspectiveCamera((desc && desc.fov) || 60, W / H, 0.01, 4000);
            shot.position.fromArray(desc.trs.p);
            shot.rotation.set(desc.trs.r[0] * Math.PI / 180, desc.trs.r[1] * Math.PI / 180, 0, 'YXZ');
        } else {
            const v = V();
            shot = new THREE.PerspectiveCamera(v.fov || 60, W / H, 0.01, 4000);
            shot.position.fromArray(v.p);
            shot.rotation.set(v.pitch * Math.PI / 180, v.yaw * Math.PI / 180, 0, 'YXZ');
        }
        shot.updateMatrixWorld(true);
        if (!rt || rtSize[0] !== W || rtSize[1] !== H) {
            if (rt) rt.dispose();
            rt = new THREE.WebGLRenderTarget(W, H, {
                minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
                format: THREE.RGBAFormat, type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace,
            });
            rtSize = [W, H];
        }
        // 辅助线、坐标轴、把手都不进图;背景设成透明,图层才留得住 alpha。
        const keep = [grid.visible, axes.visible, controls.visible, scene.background];
        grid.visible = axes.visible = controls.visible = false;
        scene.background = null;
        renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(rt);
        renderer.render(scene, shot);
        const buf = new Uint8Array(W * H * 4);
        renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
        renderer.setRenderTarget(null);
        scene.background = keep[3];
        renderer.setClearColor(0x1b1b1d, 1);
        grid.visible = keep[0];
        axes.visible = keep[1];
        controls.visible = keep[2];
        dirty = true;

        // readPixels 的行序是从下往上,2D 画布要从上往下,所以逐行倒置。
        const out = document.createElement('canvas');
        out.width = W; out.height = H;
        const ctx = out.getContext('2d');
        const img = ctx.createImageData(W, H);
        const rows = H;
        for (let y = 0; y < rows; y++) {
            const src = (rows - 1 - y) * W * 4;
            img.data.set(buf.subarray(src, src + W * 4), y * W * 4);
        }
        ctx.putImageData(img, 0, 0);
        return out;
    }

    // 烘像素只交出画布,不动图层 —— 图层的像素归 2D 那边管(canvasToLayerRow),两个世界各改各的。
    Scene3D.captureCanvas = function capture(W, H) {
        if (!Scene3D.active) throw new Error('the 3D tab is not open');
        return captureCanvas(W, H);
    };

    // ambient 只影响 live 场景,bake 复用同一个 scene,所以它自然跟着走。
    Scene3D.applyAmbient = function applyAmbient() {
        if (!ambient) return;
        ambient.color.set(Scene3D.rec.ambient.color || '#ffffff');
        ambient.intensity = Number(Scene3D.rec.ambient.intensity) || 0;
        dirty = true;
    };

    Scene3D.setGrid = function setGrid(on) {
        Scene3D.rec.grid = !!on;
        grid.visible = !!on;
        axes.visible = !!on;
        dirty = true;
    };
})();
