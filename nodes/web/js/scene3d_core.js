/* 3D 图层的场景数据层:一份纯数据记录(rec)是唯一真相,three.js 的场景只是它的镜像。
   记录必须能整体深拷贝 —— undo 栈、tab 切换和以后的 .cud 存档都靠搬这份数据。
   与 blend_node.html 同一个全局作用域,加载顺序在本文件之前是 3d-bundle.js,之后是页面本体,
   所以这里只定义,不在此刻读任何页面全局。 */

const Scene3D = {
    available: false,      // 3d-bundle.js 没到位就一路降级,并在状态行说清楚
    active: false,
    entry: null,           // 当前展示的 scene doc(documents[] 里那一枚)
    rec: null,             // live 记录(被就地改写;快照是它的深拷贝)
    tool: 'translate',     // Unity 的三个把手: W 移动 / E 旋转 / R 缩放
    space: 'local',        // 把手随物体自身轴向(local)还是世界轴(world)
    speed: 2,              // 飞行速度 unit/s,按住右键滚轮调
    keys: new Set(),
    looking: false,
    draggingGizmo: false,
    live: false,           // three.js 那一套建好了没有(view 的 ensureLive 写它),记录镜像要靠它
    root: null,            // live 场景里装物体的那一个 Group
    seq: 0,
    models: new Map(),     // assetKey -> {name, ext, bytes} —— 解析要的原始字节留在内存,存档写它
    nodes: new Map(),      // object id -> three Object3D
    objects: new Map(),    // object id -> three Light/Camera 等非网格对象
};

(function core() {
    Scene3D.available = typeof window.K3D === 'object' && !!window.K3D.THREE;

    const uid = () => ++Scene3D.seq;

    // 记录里所有欧拉角都按 Unity 的读法存「度」,顺序 YXZ(yaw 先),这样 Inspector 上填的数字
    // 和 Unity Inspector 里看到的是同一回事。
    function objDefaults(kind) {
        if (kind === 'light') return { lightType: 'directional', color: '#ffffff', intensity: 1, distance: 0 };
        if (kind === 'point') return { lightType: 'point', color: '#ffffff', intensity: 1, distance: 20 };
        if (kind === 'camera') return { fov: 60 };
        return { color: '#c8c8c8', opacity: 1, roughness: 0.75, metalness: 0 };
    }

    Scene3D.makeObject = function makeObject(patch) {
        const kind = patch.kind || 'model';
        const base = {
            id: uid(), kind, name: patch.name || 'GameObject', visible: true,
            trs: { p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] },
        };
        if (kind === 'model') base.model = patch.model || { assetKey: null, name: '' };
        if (kind === 'primitive') base.shape = patch.shape || 'cube';
        // objDefaults 认的是「哪一类东西」,而 patch.lightType 存的是 Unity 那个拼写(directional/point)。
        // 原来把 'directional' 直接当 kind 传进去,它走到底线分支返回了网格默认值 —— 于是新建的
        // Directional Light 记录里既没有 lightType 也没有 intensity,syncObject 把亮度写成了 0,
        // 这盏灯从头到尾一点光都没发过。
        Object.assign(base, objDefaults(kind === 'light' && patch.lightType === 'point' ? 'point' : kind), patch.extra || {});
        return Object.assign(base, patch.trs ? { trs: patch.trs } : {}, patch.id ? { id: patch.id } : {});
    };

    Scene3D.blankRecord = function blankRecord(name) {
        const r = {
            name: name || '3D Scene',
            // Unity 新场景的两件家当:一盏 Directional Light(50/-30/0 那个经典朝向)和一台
            // Main Camera。没有几何体 —— 用户自己拖模型进来。
            objects: [
                Scene3D.makeObject({ kind: 'light', name: 'Directional Light', lightType: 'directional',
                    trs: { p: [0, 3, 0], r: [50, -30, 0], s: [1, 1, 1] } }),
                Scene3D.makeObject({ kind: 'camera', name: 'Main Camera',
                    trs: { p: [0, 1, 4], r: [0, 0, 0], s: [1, 1, 1] } }),
            ],
            selectedId: null,
            // 相机的朝向按 three.js 的读法走:它的前方是 −Z。所以视点放在 +Z 一侧、yaw 0,
            // 视线才落在原点那堆内容上 —— 放在 −4 会背对场景,开 tab 就是一片空。
            view: { p: [0, 1.2, 4], yaw: 0, pitch: 0, fov: 60 },
            ambient: { color: '#ffffff', intensity: 0.35 },
            grid: true,
        };
        return r;
    };

    // 深拷贝:JSON 往返足够,记录里没有任何函数、也没有 DOM/canvas。
    Scene3D.cloneRec = rec => JSON.parse(JSON.stringify(rec));

    Scene3D.find = id => Scene3D.rec.objects.find(o => o.id === id) || null;

    Scene3D.select = function select(id) {
        Scene3D.rec.selectedId = id === undefined ? null : id;
        Scene3D.syncGizmo();
        Scene3D.renderPanel();
        Scene3D.invalidate();
    };

    Scene3D.add = function add(desc) {
        Scene3D.rec.objects.push(desc);
        Scene3D.sync();
        Scene3D.select(desc.id);
        // 新增物体是一次可撤销的结构变化,和 2D 那边 addLayer 的分寸一致。
        pushHistory();
        return desc;
    };

    Scene3D.remove = function remove(id) {
        const at = Scene3D.rec.objects.findIndex(o => o.id === id);
        if (at < 0) return false;
        // Unity 删 GameObject 也连带把子物体带走,但本版没有父子层级(记录里没有 parent 字段),
        // 所以这里就是删一行。
        Scene3D.rec.objects.splice(at, 1);
        if (Scene3D.rec.selectedId === id) Scene3D.rec.selectedId = null;
        Scene3D.sync();
        Scene3D.select(null);
        pushHistory();
        setStatus('Removed from the scene');
        return true;
    };

    Scene3D.rename = function rename(id, name) {
        const o = Scene3D.find(id);
        if (!o || !name || o.name === name) return false;
        o.name = name;
        Scene3D.renderPanel();
        pushHistory();
        return true;
    };

    Scene3D.setProp = function setProp(id, write) {
        const o = Scene3D.find(id);
        if (!o) return false;
        write(o);
        Scene3D.syncObject(o);
        Scene3D.renderPanel();
        Scene3D.invalidate();
        return true;
    };

    // ---- 模型字节 ----
    // 解析要的是原始字节,所以字节的拥有权放在这里(而不是 DOM File),存档才能照着 key 取回。
    Scene3D.storeModel = function storeModel(name, ext, bytes) {
        const key = 'm' + (++Scene3D.seq);
        Scene3D.models.set(key, { name, ext, bytes });
        return key;
    };

    Scene3D.MODEL_EXT = ['fbx', 'glb', 'gltf', 'obj'];

    Scene3D.isModelFile = name => Scene3D.MODEL_EXT.includes(String(name || '').split('.').pop().toLowerCase());

    // FBX 的常见单位是 cm,glTF 是 m —— 直接把导入的原始尺寸搬进 2D 画布会看到一个看不见或
    // 撑满全屏的东西。按包围盒归一(中心落到原点、最长边 2 unit),这一步只在解析时做一次,
    // 之后物体自己的 trs 完全交给用户。
    function normalizeTemplate(root) {
        const THREE = K3D.THREE;
        const box = new THREE.Box3().setFromObject(root);
        if (box.isEmpty()) return root;
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const s = 2 / maxDim;
        const wrap = new THREE.Group();
        root.position.sub(center);
        root.scale.setScalar(s);
        wrap.add(root);
        wrap.userData.normalized = s;
        return wrap;
    }

    // 每个实例自己的材质:Inspector 改颜色只能改到这份克隆上,不然同型号的两只物体一起变色。
    function instanceFrom(template) {
        const o = template.clone(true);
        o.traverse(node => {
            if (!node.isMesh) return;
            const src = node.material;
            node.material = Array.isArray(src) ? src.map(m => m.clone()) : src.clone();
            node.frustumCulled = false;
        });
        return o;
    }

    Scene3D.parseModel = function parseModel(name, bytes) {
        if (!Scene3D.available) return Promise.reject(new Error('3D engine not loaded'));
        const ext = String(name || '').split('.').pop().toLowerCase();
        const THREE = K3D.THREE;
        const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer;
        return new Promise((resolve, reject) => {
            try {
                if (ext === 'fbx') {
                    resolve(normalizeTemplate(new K3D.FBXLoader().parse(buf)));
                } else if (ext === 'obj') {
                    const text = new TextDecoder().decode(bytes);
                    const grp = new K3D.OBJLoader().parse(text);
                    grp.traverse(n => {
                        if (n.isMesh && !(n.material && n.material.isMeshStandardMaterial)) {
                            n.material = new THREE.MeshStandardMaterial({ color: 0xc8c8c8, roughness: 0.75, metalness: 0 });
                        }
                    });
                    resolve(normalizeTemplate(grp));
                } else if (ext === 'glb' || ext === 'gltf') {
                    new K3D.GLTFLoader().parse(buf, '', gltf => resolve(normalizeTemplate(gltf.scene)),
                        err => reject(err instanceof Error ? err : new Error('Could not read that glTF')));
                } else {
                    reject(new Error('Unsupported 3D format: ' + ext));
                }
            } catch (err) {
                // FBXLoader 对坏文件是直接 throw 的,不让它把 tab 拖成半死状态。
                reject(err instanceof Error ? err : new Error('Could not read that model'));
            }
        });
    };

    // 模板缓存:同一个 assetKey 只解析一次,场景里多只同型号物体共享几何与贴图。
    const templates = new Map();
    Scene3D.template = function template(assetKey) {
        return templates.get(assetKey) || null;
    };
    Scene3D.putTemplate = function putTemplate(assetKey, tmpl) { templates.set(assetKey, tmpl); };
    // 场景 tab 关了要连几何/贴图的模板一起放手 —— 一张模型只被一个 tab 拥有,删得干净。
    Scene3D.dropTemplate = function dropTemplate(assetKey) {
        const tmpl = templates.get(assetKey);
        if (tmpl && tmpl.traverse) tmpl.traverse(n => { n.geometry && n.geometry.dispose(); });
        templates.delete(assetKey);
    };

    // 记录 → three.js 的镜像。增删只按 id 对表,属性一律走 syncObject,这样一次改动只碰改到的那件。
    Scene3D.sync = function sync() {
        if (!Scene3D.live) return;
        const seen = new Set();
        for (const desc of Scene3D.rec.objects) {
            seen.add(desc.id);
            if (!Scene3D.nodes.get(desc.id) && !Scene3D.objects.get(desc.id)) Scene3D.build(desc);
            Scene3D.syncObject(desc);
        }
        for (const [id, o] of [...Scene3D.nodes, ...Scene3D.objects]) {
            if (seen.has(id)) continue;
            if (o.parent) o.parent.remove(o);
            Scene3D.nodes.delete(id);
            Scene3D.objects.delete(id);
        }
        Scene3D.syncGizmo();
    };

    Scene3D.build = function build(desc) {
        const THREE = K3D.THREE;
        let o;
        if (desc.kind === 'light') {
            o = desc.lightType === 'point' ? new THREE.PointLight(0xffffff, 1) : new THREE.DirectionalLight(0xffffff, 1);
            if (desc.lightType === 'point') {
                // 点光在 Unity 里带一个可视化球,没有它用户在场景里点选不到光。
                o.add(new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8),
                    new THREE.MeshBasicMaterial({ color: 0xffee68 })));
            } else {
                // three 的平行光把「position 指向 target 的那条直线」当作光向,而它自带的 target 是一枚
                // 从未进过场景图的 Object3D —— matrixWorld 一辈子不刷新,永远待在原点。于是光照只跟着
                // Position 变、Rotation 拧了毫无反应,读起来就是一盏 point light。Unity 的读法是灯沿自己
                // transform 的前方(+Z)照出去,所以把 target 挂成灯自己的孩子钉在本地 +Z:它随 position
                // 平移、随 rotation 转向,又因为在场景图里才会被刷新世界矩阵。
                const aim = new THREE.Object3D();
                aim.position.set(0, 0, 10);
                o.add(aim);
                o.target = aim;
                const cone = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.35, 10),
                    new THREE.MeshBasicMaterial({ color: 0xffee68 }));
                cone.rotation.x = Math.PI / 2;    // 锥尖默认朝 +Y,扳到 +Z 才和光真的照出去同向
                o.add(cone);
            }
        } else if (desc.kind === 'camera') {
            o = new THREE.Group();
            o.userData.previewCamera = true;
            o.add(new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.42, 12),
                new THREE.MeshBasicMaterial({ color: 0x9ecbff, wireframe: true })));
        } else if (desc.kind === 'primitive') {
            const geo = {
                cube: () => new THREE.BoxGeometry(1, 1, 1),
                sphere: () => new THREE.SphereGeometry(0.5, 24, 16),
                cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 24),
                plane: () => new THREE.PlaneGeometry(1, 1),
            }[(desc.shape || 'cube').toLowerCase()]();
            o = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc8c8c8, roughness: 0.75, metalness: 0 }));
        } else {
            const tmpl = Scene3D.template(desc.model && desc.model.assetKey);
            o = tmpl ? instanceFrom(tmpl) : new THREE.Group();   // 缺字节时留个空壳,hierarchy 仍看得见
            o.userData.assetKey = (desc.model && desc.model.assetKey) || null;
        }
        o.rotation.order = 'YXZ';
        o.userData.s3dId = desc.id;
        Scene3D.root.add(o);
        // 相机/灯不是网格,选它们靠 hiearchy 点击,但灯的那个小图标是可以点选的网格。
        (desc.kind === 'light' || desc.kind === 'camera' ? Scene3D.objects : Scene3D.nodes).set(desc.id, o);
        return o;
    };

    Scene3D.syncObject = function syncObject(desc) {
        const o = Scene3D.nodes.get(desc.id) || Scene3D.objects.get(desc.id);
        if (!o) return;
        const THREE = K3D.THREE;
        o.name = desc.name;
        o.visible = desc.visible !== false;
        o.position.fromArray(desc.trs.p);
        o.rotation.set(desc.trs.r[0] * THREE.MathUtils.DEG2RAD,
            desc.trs.r[1] * THREE.MathUtils.DEG2RAD,
            desc.trs.r[2] * THREE.MathUtils.DEG2RAD, 'YXZ');
        o.scale.fromArray(desc.trs.s);
        if (desc.kind === 'light') {
            o.color.set(desc.color || '#ffffff');
            o.intensity = Number(desc.intensity) || 0;
            if (o.isPointLight) o.distance = Math.max(0, Number(desc.distance) || 0);
        } else if (desc.kind === 'model' || desc.kind === 'primitive') {
            o.traverse(node => {
                if (!node.isMesh) return;
                const list = Array.isArray(node.material) ? node.material : [node.material];
                for (const m of list) {
                    if (!m || !m.isMeshStandardMaterial) continue;
                    m.color.set(desc.color || '#c8c8c8');
                    m.roughness = desc.roughness === undefined ? 0.75 : desc.roughness;
                    m.metalness = desc.metalness === undefined ? 0 : desc.metalness;
                    const op = desc.opacity === undefined ? 1 : desc.opacity;
                    m.transparent = op < 1;
                    m.opacity = op;
                }
            });
        }
    };
})();
