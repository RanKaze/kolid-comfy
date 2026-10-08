// Pose 渲染核心 —— 一只 rig = 一个场景里的一个 MH 人形 (SkinnedMesh + Skeleton + 皮肤材质),
// 加上一台与视图无关的**捕获相机** (FOV 30 / dist 45, 参考的取景约定就是这个)。它只干三件事:
// 装模型、摆姿态、把画面烤回一张 2D canvas —— 视口相机、轨道、把手全归编辑器 (js/pose_view.js),
// 属性注册那条路 (attr/pose.js 的 sync) 只用 headless 的 capture。
//
// 移植自 AHEKOT/ComfyUI_VNCCS_Utils (MIT) 的 web/vnccs_pose_studio_core.js, 已削掉的部分:
// IK (P2)、灯光面板 (P2, 现在钉死参考的默认档)、mesh 比例档 (P2)、多角色/被动角色 (答 6.a 砍)、
// Skydome (P3)、参考图平面。改动的部分: three 从全局 K3D 取 (本包 js/3d-bundle.js 的 r160,
// 不再vendored 一份); 渲染器可以只有游离 canvas (headless), 编辑器把它搬进小窗舞台即可。
//
// 皮肤贴图三档在 /pose-asset/ 路由下 (data/pose/, git 外资产), 全局共享缓存 —— 一张 5MB 的
// 贴图每枚 attribute 各拉一份不可接受。

const POSE_CAPTURE_FOV = 30;
const POSE_CAPTURE_DIST = 45;
const POSE_SKIN_FILES = { naked: 'skin.png', naked_marks: 'skin_marks.png', dummy_white: 'skin_dummy.png' };

const PoseCore = (() => {
    function THREE_() { return (typeof K3D !== 'undefined' && K3D.THREE) || null; }

    const skinTexCache = new Map();     // skin -> Promise<Texture|null>
    function skinTexture(skin) {
        const THREE = THREE_();
        if (!THREE) return Promise.resolve(null);
        const name = POSE_SKIN_FILES[skin] ? skin : 'dummy_white';
        if (!skinTexCache.has(name)) {
            skinTexCache.set(name, new Promise((resolve) => {
                new THREE.TextureLoader().load(
                    '/pose-asset/' + POSE_SKIN_FILES[name],
                    (tex) => resolve(tex),
                    undefined,
                    () => resolve(null),        // 缺资产 = 素色材质, 不是黑剪影 (参考同款 fail-soft)
                );
            }));
        }
        return skinTexCache.get(name);
    }

    // 关节球 (参考 _createJointMarkers 的原式): 挂在骨头上的小黄球, depthTest 关着 —— 隔着身体
    // 也要看得见、点得着。几何与材质全局共享 (几十颗球不各建一份), 编辑器只换 normal/selected 两档。
    let markerGeos = null;
    let markerMats = null;
    function markerGeo(kind) {
        const THREE = THREE_();
        if (!markerGeos) {
            markerGeos = {
                normal: new THREE.SphereGeometry(0.12, 8, 8),
                finger: new THREE.SphereGeometry(0.06, 6, 6),
            };
        }
        return markerGeos[kind] || markerGeos.normal;
    }
    function markerMaterial(kind) {
        const THREE = THREE_();
        if (!markerMats) {
            const mk = (color, opacity) => new THREE.MeshBasicMaterial({
                color, transparent: true, opacity, depthTest: false, depthWrite: false,
            });
            markerMats = { normal: mk(0xffaa00, 0.8), selected: mk(0x00ffff, 0.9) };
        }
        return markerMats[kind] || markerMats.normal;
    }
    const fingerRe = /^(thumb|index|middle|ring|pinky)(?:_|$)|\bfinger\b/;

    class PoseRig {
        constructor() {
            const THREE = THREE_();
            if (!THREE) throw new Error('Pose needs the 3D bundle (js/3d-bundle.js)');
            this.THREE = THREE;
            this.scene = new THREE.Scene();
            this.scene.background = new THREE.Color(0x1a1a2e);
            // 灯光钉死参考的默认档 (directional #ffffff 2.0 @(10,20,30) + ambient #505050 1.0);
            // 可调的灯光面板是 P2。
            this.ambientLight = new THREE.AmbientLight(0x505050, 1.0);
            this.dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
            this.dirLight.position.set(10, 20, 30);
            this.scene.add(this.ambientLight, this.dirLight);

            // 捕获相机与轨道视图相机是两台 —— 取景框 (黄线) 画的就是前者在场景里的位置。
            this.captureCamera = new THREE.PerspectiveCamera(POSE_CAPTURE_FOV, 1, 0.1, 500);
            this.scene.add(this.captureCamera);
            this.viewCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
            this.viewCamera.position.set(0, 10, 30);

            const frameGeo = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(-1, 1, 0), new THREE.Vector3(1, 1, 0),
                new THREE.Vector3(1, -1, 0), new THREE.Vector3(-1, -1, 0),
                new THREE.Vector3(-1, 1, 0),
            ]);
            this.captureFrame = new THREE.Line(frameGeo, new THREE.LineBasicMaterial({ color: 0xffa500 }));
            this.captureFrame.visible = false;
            this.scene.add(this.captureFrame);

            this.meshCenter = new THREE.Vector3(0, 7, 0);
            this.bones = {};
            this.boneList = [];
            this.jointMarkers = [];
            this.restPositions = new Map();
            this.skinnedMesh = null;
            this.skeleton = null;
            this.overlays = [this.captureFrame];   // 编辑器摆的家具 (关节球/把手): 捕获时一律藏
            this.renderer = null;
            this._captureBatch = null;
            this.skin = 'dummy_white';
            this.color = '#ffffff';
            this._skinToken = 0;
            this.ready = false;
            this.onViewportRestore = null;  // 编辑器注册: 捕获还完缓冲后重画视口
        }

        // ---- 渲染器 ----
        // 游离 canvas 起步 (headless 的 sync 路径就这么用); 编辑器 attachCanvas 把它搬进舞台。
        ensureRenderer() {
            if (this.renderer) return this.renderer;
            const THREE = this.THREE;
            this.renderer = new THREE.WebGLRenderer({
                antialias: true,
                alpha: true,
                preserveDrawingBuffer: true,
            });
            this.renderer.setClearColor(0x000000, 0);
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            this.renderer.setSize(300, 400, false);
            return this.renderer;
        }

        attachCanvas(host) {
            const renderer = this.ensureRenderer();
            if (renderer.domElement.parentNode !== host) host.appendChild(renderer.domElement);
            return renderer.domElement;
        }

        // 视口缓冲 (编辑器那一档): 只在尺寸真变时重分配。捕获是**另一趟** (batch), 还完由
        // onViewportRestore 重画。
        setViewportSize(w, h) {
            const renderer = this.ensureRenderer();
            const cw = Math.max(1, Math.round(w)), ch = Math.max(1, Math.round(h));
            const size = renderer.getSize(new this.THREE.Vector2());
            if (size.x === cw && size.y === ch) return;
            renderer.setSize(cw, ch, false);
            this.viewCamera.aspect = Math.max(0.01, cw / ch);
            this.viewCamera.updateProjectionMatrix();
        }

        // ---- 模型 ----
        disposeMesh() {
            this._disposeJointMarkers();
            if (this.skinnedMesh) {
                this.scene.remove(this.skinnedMesh);
                this.skinnedMesh.geometry.dispose();
                this.skinnedMesh.material.dispose();
                this.skinnedMesh = null;
                this.skeleton = null;
            }
        }

        // 关节球挂成骨头的子节点: 骨头动球就跟着 —— 不用每帧对位。overlays 是捕获时"一律藏"的
        // 清单, 球在这里面, 所以烤出来的像素永远没有它们 (编辑器另把把手也放进这张清单)。
        _createJointMarkers() {
            const THREE = this.THREE;
            this.jointMarkers = [];
            for (let i = 0; i < this.boneList.length; i++) {
                const bone = this.boneList[i];
                const sphere = new THREE.Mesh(
                    markerGeo(fingerRe.test(bone.name.toLowerCase()) ? 'finger' : 'normal'),
                    markerMaterial('normal'));
                sphere.userData.boneIndex = i;
                sphere.renderOrder = 999;
                bone.add(sphere);
                sphere.position.set(0, 0, 0);
                this.jointMarkers.push(sphere);
            }
            this.overlays = [this.captureFrame, ...this.jointMarkers];
        }

        _disposeJointMarkers() {
            for (const m of this.jointMarkers || []) m.parent?.remove(m);
            this.jointMarkers = [];
        }

        // data 来自 worker (poseModelDataFromMorphMessage): vertices/uvs/indices/bones(带 head/tail)/skin。
        loadModel(data) {
            if (!data || !data.vertices || !data.bones) return false;
            const THREE = this.THREE;
            this.disposeMesh();

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(data.vertices), 3));
            geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(data.indices), 1));
            if (data.uvs && data.uvs.length) {
                geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(data.uvs), 2));
            }
            geometry.computeVertexNormals();

            this.bones = {};
            this.boneList = [];
            const rootBones = [];
            for (const bData of data.bones) {
                const bone = new THREE.Bone();
                bone.name = bData.name;
                bone.userData = { headPos: bData.headPos, tailPos: bData.tailPos, parentName: bData.parent };
                bone.position.set(bData.headPos[0], bData.headPos[1], bData.headPos[2]);
                this.bones[bone.name] = bone;
                this.boneList.push(bone);
            }
            for (const bone of this.boneList) {
                const pName = bone.userData.parentName;
                if (pName && this.bones[pName]) {
                    const parent = this.bones[pName];
                    parent.add(bone);
                    const pHead = parent.userData.headPos;
                    const cHead = bone.userData.headPos;
                    bone.position.set(cHead[0] - pHead[0], cHead[1] - pHead[1], cHead[2] - pHead[2]);
                } else {
                    rootBones.push(bone);
                }
            }
            this.restPositions = new Map(this.boneList.map(b => [b.name, b.position.clone()]));
            this.skeleton = new THREE.Skeleton(this.boneList);

            const vCount = new Float32Array(data.vertices).length / 3;
            if (data.skinIndices && data.skinWeights
                    && data.skinIndices.length === vCount * 4 && data.skinWeights.length === vCount * 4) {
                geometry.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(data.skinIndices), 4));
                geometry.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array(data.skinWeights), 4));
            }

            const material = new THREE.MeshPhongMaterial({
                color: 0xffffff,
                specular: 0x111111,
                shininess: 5,
                side: THREE.DoubleSide,
            });
            // 参考的同一条边缘压暗: 双面材质下轮廓一圈略沉, 人形才不糊在一块。
            material.onBeforeCompile = (shader) => {
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <dithering_fragment>',
                    '#include <dithering_fragment>\n'
                    + 'float rim = 1.0 - abs(vNormal.z);\n'
                    + 'gl_FragColor.rgb *= (1.0 - pow(rim, 3.0) * 0.4);\n'
                );
            };

            this.skinnedMesh = new THREE.SkinnedMesh(geometry, material);
            rootBones.forEach(b => this.skinnedMesh.add(b));
            this.skinnedMesh.bind(this.skeleton);
            this.scene.add(this.skinnedMesh);
            this._createJointMarkers();

            geometry.computeBoundingBox();
            this.meshCenter = geometry.boundingBox.getCenter(new this.THREE.Vector3());

            this.ready = true;
            this.setColor(this.color);
            this.setSkin(this.skin);
            return true;
        }

        // 换形态参数 = 同一个骨架换一身皮: 顶点/骨位/拓扑都是**原地**更新 (参考 updateBodyVertices
        // 的瘦身版), 不重建 mesh —— 工具窗里拖个滑块不必重走装配。调用方在这之后自己重摆姿态。
        updateBody(vertices, bonePositions, indices) {
            if (!this.ready || !this.skinnedMesh) return false;
            const geometry = this.skinnedMesh.geometry;
            const position = geometry.getAttribute('position');
            if (!position || position.array.length !== vertices.length) return false;

            const savedRotations = new Map();
            let savedMeshRotation = null;
            for (const bone of this.boneList) {
                savedRotations.set(bone.name, bone.rotation.clone());
                bone.rotation.set(0, 0, 0);
            }
            savedMeshRotation = this.skinnedMesh.rotation.clone();
            this.skinnedMesh.rotation.set(0, 0, 0);
            this.skinnedMesh.position.set(0, 0, 0);
            this.skinnedMesh.scale.set(1, 1, 1);

            position.array.set(vertices);
            position.needsUpdate = true;
            if (indices && indices.length) {
                geometry.setIndex(new this.THREE.BufferAttribute(new Uint32Array(indices), 1));
            }
            geometry.computeVertexNormals();
            geometry.computeBoundingBox();
            geometry.boundingBox.getCenter(this.meshCenter);

            if (bonePositions && bonePositions.length >= this.boneList.length * 6) {
                for (let i = 0; i < this.boneList.length; i++) {
                    const bone = this.boneList[i];
                    const offset = i * 6;
                    const head = [bonePositions[offset], bonePositions[offset + 1], bonePositions[offset + 2]];
                    bone.userData.headPos = head;
                    bone.userData.tailPos = [bonePositions[offset + 3], bonePositions[offset + 4], bonePositions[offset + 5]];
                    const parentName = bone.userData.parentName;
                    const parent = parentName ? this.bones[parentName] : null;
                    if (parent?.userData?.headPos) {
                        const parentHead = parent.userData.headPos;
                        bone.position.set(head[0] - parentHead[0], head[1] - parentHead[1], head[2] - parentHead[2]);
                    } else {
                        bone.position.set(head[0], head[1], head[2]);
                    }
                }
                this.skinnedMesh.updateMatrixWorld(true);
                for (const bone of this.boneList) bone.updateMatrixWorld(true);
                if (this.skeleton?.calculateInverses) this.skeleton.calculateInverses();
            }

            for (const bone of this.boneList) {
                const rotation = savedRotations.get(bone.name);
                if (rotation) bone.rotation.copy(rotation);
            }
            this.skinnedMesh.rotation.copy(savedMeshRotation);
            this.skinnedMesh.updateMatrixWorld(true);
            if (this.skeleton) this.skeleton.update();
            this.restPositions = new Map(this.boneList.map(b => [b.name, b.position.clone()]));
            return true;
        }

        // ---- 姿态 ----
        // pose = {bones:{name:[rx,ry,rz] 度}, bonePositions:{name:[x,y,z] 局部}, modelRotation:[x,y,z] 度}。
        // 相机不在里面 —— 视图归编辑器, 捕获参数在 desc.cam 里, 由 capture 那一趟现解。
        applyPose(pose) {
            if (!this.ready) return;
            const p = pose || {};
            const bones = p.bones || {};
            const bonePositions = p.bonePositions || {};
            const modelRot = p.modelRotation || [0, 0, 0];
            const DEG = Math.PI / 180;
            for (const b of this.boneList) {
                b.rotation.set(0, 0, 0);
                const rest = this.restPositions.get(b.name);
                if (rest) b.position.copy(rest);
            }
            for (const [name, rot] of Object.entries(bones)) {
                const bone = this.bones[name];
                if (bone && Array.isArray(rot) && rot.length >= 3) {
                    bone.rotation.set(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG);
                }
            }
            for (const [name, position] of Object.entries(bonePositions)) {
                const bone = this.bones[name];
                if (!bone || !Array.isArray(position) || position.length < 3) continue;
                const values = position.slice(0, 3).map(Number);
                if (values.every(Number.isFinite)) bone.position.set(values[0], values[1], values[2]);
            }
            if (this.skinnedMesh) {
                this.skinnedMesh.rotation.set(
                    (modelRot[0] || 0) * DEG,
                    (modelRot[1] || 0) * DEG,
                    (modelRot[2] || 0) * DEG,
                );
            }
            this.skinnedMesh?.updateMatrixWorld?.(true);
            if (this.skeleton) this.skeleton.update();
        }

        getPose() {
            const DEG = 180 / Math.PI;
            const bones = {};
            const bonePositions = {};
            for (const b of this.boneList) {
                const rot = b.rotation;
                if (Math.abs(rot.x) > 1e-4 || Math.abs(rot.y) > 1e-4 || Math.abs(rot.z) > 1e-4) {
                    bones[b.name] = [rot.x * DEG, rot.y * DEG, rot.z * DEG];
                }
                const rest = this.restPositions.get(b.name);
                if (rest && (b.position.distanceToSquared(rest) > 1e-10
                        || !b.userData.parentName || !this.bones[b.userData.parentName])) {
                    bonePositions[b.name] = [b.position.x, b.position.y, b.position.z];
                }
            }
            const r = this.skinnedMesh ? this.skinnedMesh.rotation : { x: 0, y: 0, z: 0 };
            return { bones, bonePositions, modelRotation: [r.x * DEG, r.y * DEG, r.z * DEG] };
        }

        // ---- 材质 ----
        setSkin(skin) {
            this.skin = POSE_SKIN_FILES[skin] ? skin : 'dummy_white';
            const material = this.skinnedMesh?.material;
            if (!material) return Promise.resolve();
            const token = ++this._skinToken;
            return skinTexture(this.skin).then((tex) => {
                if (token !== this._skinToken || !this.skinnedMesh || this.skinnedMesh.material !== material) return;
                material.map = tex || null;
                material.color.set(tex ? this.color : 0xc8b5aa);
                material.needsUpdate = true;
            });
        }

        setColor(css) {
            this.color = css || '#ffffff';
            const material = this.skinnedMesh?.material;
            if (material && material.map) material.color.set(this.color);
            else if (material) material.color.set(0xc8b5aa);
        }

        // ---- 捕获相机 (参考 updateCaptureCamera 的原式) ----
        updateCaptureCamera(width, height, cam = {}) {
            const target = new this.THREE.Vector3(
                this.meshCenter.x - (Number(cam.offsetX) || 0),
                this.meshCenter.y - (Number(cam.offsetY) || 0),
                this.meshCenter.z,
            );
            const yawRad = (Number(cam.yaw) || 0) * Math.PI / 180;
            const pitchRad = (Number(cam.pitch) || 0) * Math.PI / 180;
            const cameraOffset = new this.THREE.Vector3(0, 0, POSE_CAPTURE_DIST);
            cameraOffset.applyEuler(new this.THREE.Euler(pitchRad, yawRad, 0, 'YXZ'));
            this.captureCamera.aspect = width / Math.max(1, height);
            this.captureCamera.fov = POSE_CAPTURE_FOV;
            this.captureCamera.zoom = Math.max(0.1, Number(cam.zoom) || 1);
            this.captureCamera.updateProjectionMatrix();
            this.captureCamera.position.copy(target).add(cameraOffset);
            this.captureCamera.lookAt(target);

            // 取景框 = 捕获相机在场景里看到的那个矩形 (在 target 那个深度上)。
            const vFOV = POSE_CAPTURE_FOV * Math.PI / 180;
            const fh = 2 * POSE_CAPTURE_DIST * Math.tan(vFOV / 2) / Math.max(0.1, this.captureCamera.zoom);
            const fw = fh * this.captureCamera.aspect;
            this.captureFrame.position.copy(target);
            this.captureFrame.scale.set(fw / 2, fh / 2, 1);
            this.captureFrame.lookAt(this.captureCamera.position);
            this.captureFrame.visible = true;
            return target;
        }

        // ---- 捕获 ----
        // 把当前姿态按 desc.cam 的取景烤成一张新的 2D canvas (调用方负责先 applyPose)。
        // opts: {width, height, cam, transparent, bg:[r,g,b] (0-255), overlays:false 保留家具}
        capture(opts = {}) {
            const width = Math.max(1, Math.round(opts.width || 1024));
            const height = Math.max(1, Math.round(opts.height || 1024));
            const renderer = this.ensureRenderer();
            if (!this.ready) return null;

            this.updateCaptureCamera(width, height, opts.cam || {});

            const hidden = [];
            if (opts.overlays !== false) {
                for (const item of this.overlays) {
                    if (item && item.visible !== undefined) { hidden.push([item, item.visible]); item.visible = false; }
                }
            }
            const oldBg = this.scene.background;
            if (opts.transparent) this.scene.background = null;
            else if (Array.isArray(opts.bg) && opts.bg.length === 3) {
                this.scene.background = new this.THREE.Color(
                    opts.bg[0] / 255, opts.bg[1] / 255, opts.bg[2] / 255);
            }

            const out = document.createElement('canvas');
            out.width = width;
            out.height = height;
            try {
                this.beginCaptureBatch(width, height);
                this.renderer.render(this.scene, this.captureCamera);
                const ctx = out.getContext('2d');
                ctx.clearRect(0, 0, width, height);
                ctx.drawImage(this.renderer.domElement, 0, 0, width, height);
            } finally {
                this.scene.background = oldBg;
                for (const [item, visible] of hidden) item.visible = visible;
                this.endCaptureBatch();
            }
            return out;
        }

        beginCaptureBatch(width, height) {
            const renderer = this.ensureRenderer();
            if (this._captureBatch) {
                if (this._captureBatch.width !== width || this._captureBatch.height !== height) {
                    renderer.setSize(width, height, false);
                    this._captureBatch.width = width;
                    this._captureBatch.height = height;
                }
                return false;
            }
            const size = renderer.getSize(new this.THREE.Vector2());
            this._captureBatch = {
                width, height,
                originalWidth: size.x, originalHeight: size.y,
                originalPixelRatio: renderer.getPixelRatio(),
            };
            renderer.setPixelRatio(1);
            renderer.setSize(width, height, false);
            return true;
        }

        endCaptureBatch() {
            const batch = this._captureBatch;
            if (!batch || !this.renderer) return;
            this._captureBatch = null;
            this.renderer.setPixelRatio(batch.originalPixelRatio);
            this.renderer.setSize(batch.originalWidth, batch.originalHeight, false);
            // 还原缓冲会把画面清掉 (与视口 resize 同理) —— 编辑器必须当场重画一帧。
            if (this.onViewportRestore) this.onViewportRestore();
        }

        // 视口那一帧 (编辑器调的): 捕获相机之外的普通相机。
        renderView() {
            const renderer = this.ensureRenderer();
            if (renderer.domElement.parentNode) renderer.render(this.scene, this.viewCamera);
        }

        dispose() {
            this.disposeMesh();
            if (this.renderer) {
                this.renderer.dispose();
                this.renderer.domElement.remove();
                this.renderer = null;
            }
            this.overlays.length = 0;
            this.ready = false;
        }
    }

    function available() {
        if (!THREE_()) return false;
        try {
            const c = document.createElement('canvas');
            return !!(c.getContext('webgl2') || c.getContext('webgl'));
        } catch (e) { return false; }
    }

    return { available, PoseRig, skinTexture, markerMaterial, POSE_CAPTURE_FOV, POSE_CAPTURE_DIST };
})();
