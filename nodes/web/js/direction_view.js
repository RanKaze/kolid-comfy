/* Direction 小窗的 three.js 视图 —— "世界里的观察" 那张图改成真的 3D 场景来画。
   引擎是仓库里 vendored 的那份 window.K3D (js/3d-bundle.js: three r160 + loaders + TransformControls),
   页面不吃 CDN, 与 3D tab 用的是同一个 bundle。

   姿态的全部落点只来自 direction.js 的 dirWorldPose (单位: 地平环半径 = 1 个世界单位)。这个文件只做三件事:
     1. 把画布平面贴成**此刻的 context image** (参考图唯独不含正在编辑的这张方向层自己 —— 那趟合成在
        direction.js 的 dirRefTarget 里), 于是"这个方向指着图里的哪儿"直接可读;
     2. 三根轨道 (方位环 / 仰角弧 / 滚转环)、箭头与三颗把手挂进场景, 把手在屏幕上恒定大小;
     3. 指针: 中键拖动 = 相机绕原点轨道 (只转眼睛, 不动姿态), 左键拖把手 = 把射线打回各自那条轨道取绝对角。

   K3D 没进来, 或者这块 canvas 建不起 WebGL 上下文 (jsdom、旧版节点进程没有 /js/ 路由) 时, begin() 一路回
   false, direction.js 就退回它自己那张 2D 世界图。两种画法吃的是同一份世界坐标, 所以退路不会读出另一个姿态。 */
(function () {
    const DirView = {};
    window.DirView = DirView;

    const FOV = 40;                 // 视场角。小窗是取景框不是自由相机, 所以只给一个固定值
    const DIST = 4.6;               // 相机到原点的世界距离 (环半径 = 1 ⇒ 姿态球 1.3 正好留得住边)
    const TUBE = 0.012;             // 轨道在世界里的粗细
    const HEAD_H = 0.2;             // 箭头那顶锥子的高度 (世界单位)
    const ORBIT_K = 0.55;           // 中键拖动: 每像素转多少度 (与 3D tab 那套"拖多少转多少"同一个分寸)
    const EL_MAX = 85;              // 相机俯仰夹在这里: 正好从边上或正下方看, 三根轨道会糊成一条线
    const HANDLE_K = 1.3;           // 悬停/按下时把手放大这一档
    const DIM = 0.32;               // 没人在编辑这张方向层时整颗转暗 (与 2D 世界图同一个数)

    let renderer = null, scene = null, cam = null, host = null, ray = null;
    let W = 0, H = 0, broken = false, queued = false;
    let parts = null, arcCache = { deg: -1, geo: null };
    let refVersion = -1, refW = 0, refH = 0, stagePose = null, stageOpts = { dim: true };
    // 相机 = "眼睛站在哪儿"。默认 (az 0, el 25) 复现旧 2D 世界图那条 25° 俯角的正交视线,
    // 于是第一次打开小窗看到的东西和以前一回事, 只是现在转得动。
    const view = { az: 0, el: 25 };

    const TT = () => window.K3D && window.K3D.THREE;
    const hex = c => parseInt(String(c).replace('#', ''), 16);

    function mark() {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; draw(); });
    }
    DirView.invalidate = mark;

    // ---- 建场景 ----
    // 全部用 MeshBasicMaterial: 把手图不该吃光照 (Unity 的 gizmo 也一样), 而且没有灯就少一套状态要维护。
    // 深度只让画布平面写 (它才是那张"地面"), 轨道与箭头都只读深度 —— 于是平面背后 naturally 挡住东西,
    // 而把手关掉深度测试, 免得转到平面背后就点不着。
    function material(T, color, opacity, extra) {
        const m = new T.MeshBasicMaterial(Object.assign({
            color: hex(color), transparent: true, opacity, side: T.DoubleSide, depthWrite: false,
        }, extra || {}));
        m.userData.base = opacity;
        return m;
    }

    function build(T) {
        parts = { up: new T.Vector3(0, 1, 0), refTex: null };
        scene = new T.Scene();
        cam = new T.PerspectiveCamera(FOV, 1, 0.05, 100);
        ray = new T.Raycaster();

        // 画布平面: 贴着参考图的网片。alphaTest 让透明的地方不写深度, 否则整块矩形会把它背后的轨道全遮住。
        // 尺寸每帧按 canvasW:canvasH 重设 (scale), 所以参考图换比例也不用重建几何。
        parts.plane = new T.Mesh(new T.PlaneGeometry(1, 1),
            material(T, DIR_PLANE, 0.22, { depthWrite: true, alphaTest: 0.02 }));
        parts.plane.rotation.x = -Math.PI / 2;      // local +y → 世界 -z ⇒ 图的上边落在画布的上边
        scene.add(parts.plane);

        // 0° 参考边: 画布 +X (中心到右边缘中点)。环上的角度没有它就只能读成"绕一圈", 读不出相对谁。
        parts.refEdge = new T.Mesh(new T.PlaneGeometry(1, 1), material(T, DIR_RING, 0.5));
        parts.refEdge.rotation.x = -Math.PI / 2;
        parts.refEdge.position.y = 0.003;           // 抬一点点, 不与网片同面 (同面必闪)
        parts.refEdge.renderOrder = 1;
        scene.add(parts.refEdge);

        // 方位环: 绕这张平面一圈的 360° yaw 轨道。
        parts.ring = new T.Mesh(new T.TorusGeometry(1, TUBE, 6, 96), material(T, DIR_RING, 0.9));
        parts.ring.rotation.x = -Math.PI / 2;
        parts.ring.renderOrder = 1;
        scene.add(parts.ring);

        // 仰角弧: 一个组带着"当前方位那个竖直平面"的朝向, 里面两条弧只在自己的坐标系里转 z。
        parts.arcGroup = new T.Group();
        parts.arcGroup.renderOrder = 2;
        parts.arcTrack = new T.Mesh(new T.TorusGeometry(DIR_POSE_R, TUBE * 0.7, 6, 48, Math.PI),
            material(T, DIR_ARC, 0.28));
        parts.arcTrack.rotation.z = -Math.PI / 2;   // 从 -90° 起扫 ⇒ 整条轨道是 -90..90
        parts.arcLive = new T.Mesh(arcGeometry(T, 1), material(T, DIR_ARC, 0.95));
        parts.arcGroup.add(parts.arcTrack, parts.arcLive);
        scene.add(parts.arcGroup);

        // 箭头本体: 杆 + 头, 颜色跟着图层走。
        parts.shaft = new T.Mesh(new T.CylinderGeometry(TUBE * 1.6, TUBE * 1.6, 1, 10),
            material(T, DIR_DEFAULTS.color, 1));
        parts.head = new T.Mesh(new T.ConeGeometry(HEAD_H * 0.34, HEAD_H, 16), material(T, DIR_DEFAULTS.color, 1));
        parts.shaft.renderOrder = parts.head.renderOrder = 3;
        scene.add(parts.shaft, parts.head);

        // 滚转环: 组的原点在箭头的 DIR_FIN_C 处、组的 local z 就是箭头方向, 于是环天然垂直于箭头。
        parts.rollGroup = new T.Group();
        parts.rollRing = new T.Mesh(new T.TorusGeometry(DIR_FIN_R, TUBE * 0.65, 6, 36), material(T, DIR_FIN, 0.9));
        parts.rollTick = new T.Mesh(new T.PlaneGeometry(1, 1), material(T, DIR_FIN, 0.9));
        parts.rollGroup.add(parts.rollRing, parts.rollTick);
        parts.rollGroup.renderOrder = 3;
        scene.add(parts.rollGroup);

        // 三颗 billboard 把手。
        parts.handles = {};
        const disc = new T.CircleGeometry(1, 22);
        const cols = { yaw: DIR_RING, pitch: DIR_ARC, roll: DIR_FIN };
        for (const key of ['yaw', 'pitch', 'roll']) {
            const m = new T.Mesh(disc, material(T, cols[key], 0.78, { depthTest: false }));
            m.renderOrder = 20;
            parts.handles[key] = m;
            scene.add(m);
        }
    }

    // 亮色那段仰角弧的长度跟着 pitch 走; TorusGeometry 的 arc 建好就改不了, 所以按整度缓存着重建。
    function arcGeometry(T, pitchDeg) {
        const deg = Math.max(1, Math.min(90, Math.round(Math.abs(pitchDeg))));
        if (arcCache.deg === deg && arcCache.geo) return arcCache.geo;
        if (arcCache.geo) arcCache.geo.dispose();
        arcCache = { deg, geo: new T.TorusGeometry(DIR_POSE_R, TUBE * 0.7, 6,
            Math.max(4, Math.round(deg / 4)) + 2, deg * Math.PI / 180) };
        return arcCache.geo;
    }

    // 把三个世界向量当坐标轴的朝向写进一个对象 (makeBasis 的列 = x/y/z 轴)。
    function orient(obj, xAx, yAx, zAx) {
        const T = TT();
        const m = new T.Matrix4().makeBasis(
            new T.Vector3(xAx.x, xAx.y, xAx.z),
            new T.Vector3(yAx.x, yAx.y, yAx.z),
            new T.Vector3(zAx.x, zAx.y, zAx.z));
        obj.quaternion.setFromRotationMatrix(m);
    }

    DirView.available = () => !broken && !!TT();

    DirView.begin = function begin(canvasEl) {
        const T = TT();
        if (broken || !T || !canvasEl) return false;
        if (renderer) return true;
        try {
            // preserveDrawingBuffer: 探针要从这块 canvas 上回读像素, 验"平面真的贴上了参考图"。
            renderer = new T.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: true,
                preserveDrawingBuffer: true });
        } catch (e) {
            broken = true; renderer = null;
            return false;
        }
        host = canvasEl;
        try {
            build(T);
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            renderer.setClearColor(0x000000, 0);
        } catch (e) {
            broken = true; renderer = null; scene = null; host = null; parts = null;
            return false;
        }
        return true;
    };

    DirView.live = () => !!renderer;

    DirView.state = function state() {
        return { live: !!renderer, broken, az: view.az, el: view.el, fov: FOV, dist: DIST,
            W, H, refVersion, hasMap: !!(parts && parts.plane.material.map),
            // 那块网片此刻真的占多大 (世界单位) —— 平面该有多大只由 dirPlaneHalf 说了算, 探针要能问出来。
            planeScale: parts ? [parts.plane.scale.x, parts.plane.scale.y] : null };
    };

    // ---- 相机 ----
    function applyCam() {
        const a = dirRad(view.az), e = dirRad(view.el);
        cam.position.set(DIST * Math.sin(a) * Math.cos(e), DIST * Math.sin(e), DIST * Math.cos(a) * Math.cos(e));
        cam.lookAt(0, 0, 0);
        cam.aspect = H ? W / H : 1;
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld(true);
        parts.camQuat = cam.quaternion.clone();
    }

    // 一个世界点处的"每像素多少世界单位" —— 把手大小从这里折算, 所以相机远近不改手感。
    function pxToWorld(p) {
        const d = cam.position.distanceTo(p) || 1;
        return 2 * d * Math.tan(dirRad(FOV) / 2) / (H || 1);
    }

    function resize() {
        const w = host.clientWidth || DIR_STAGE_W, h = host.clientHeight || DIR_STAGE_H;
        if (w === W && h === H) return;
        W = w; H = h;
        renderer.setSize(W, H, false);
    }

    // direction.js 的 dirRefCanvas 每被 render() 重抄一次就换 dirRefVersion; 版本没动就不碰纹理,
    // 于是一次 yaw 拖动不会白重传一张画布大小的纹理。
    function syncTexture(T) {
        if (!dirRefCanvas || dirRefVersion === refVersion) return;
        refVersion = dirRefVersion;
        const m = parts.plane.material;
        // 画布换了尺寸时必须重造一张纹理, 不能只 needsUpdate: GPU 上那块存储认的是 source, 而 source 一直
        // 是同一个 canvas 对象 —— 于是新尺寸的内容只贴在旧尺寸的纹理角上, 平面就只显示半张贴图 (画布从
        // 1000×800 改成 600×300 之后, 平面的右下角就是空的)。
        if (parts.refTex && (dirRefCanvas.width !== refW || dirRefCanvas.height !== refH)) {
            parts.refTex.dispose();
            parts.refTex = null;
            m.map = null;
        }
        if (!parts.refTex) {
            parts.refTex = new T.CanvasTexture(dirRefCanvas);
            if (T.SRGBColorSpace) parts.refTex.colorSpace = T.SRGBColorSpace;
            refW = dirRefCanvas.width;
            refH = dirRefCanvas.height;
            m.map = parts.refTex;
            m.color.setHex(0xffffff);           // 有图了就不再乘灰
            m.userData.base = 0.95;
        } else {
            parts.refTex.image = dirRefCanvas;
            parts.refTex.needsUpdate = true;
        }
        m.needsUpdate = true;
    }

    // ---- 把姿态摆进场景 ----
    function sync(T, pose, opts) {
        const w = dirWorldPose(pose);
        syncTexture(T);

        parts.plane.scale.set(2 * w.plane.hw, 2 * w.plane.hd, 1);
        // 几何是居中的 1×1, 缩到 hw 后仍是以原点为中心的 ±hw/2; 参考边画的是"中心 → 右边缘中点",
        // 所以再把整条往 +X 挪半条, 让它从原点起步 (与 2D 退路的 moveTo(0,0); lineTo(hw,0) 对齐)。
        parts.refEdge.scale.set(w.plane.hw, TUBE * 0.8, 1);
        parts.refEdge.position.x = w.plane.hw / 2;

        // 仰角弧所在的那个竖直平面: local x = 当前方位的水平方向, local y = 世界 up, local z = 两者叉积。
        const t = dirRad(pose.yaw);
        orient(parts.arcGroup, w.yaw, { x: 0, y: 1, z: 0 }, { x: -Math.sin(t), y: 0, z: Math.cos(t) });
        parts.arcLive.geometry = arcGeometry(T, pose.pitch);
        parts.arcLive.rotation.z = pose.pitch >= 0 ? 0 : dirRad(pose.pitch);

        // 箭头: 杆从原点走到头前, 头补上最后那一截。长度全部取自 w.tip (= 单位方向 × DIR_POSE_R)。
        // dirWorldPose 交出来的是纯 {x,y,z} (2D 退路也吃它), 所以这里按自己的模长算, 不借 THREE 的 .length()。
        const dir = new T.Vector3(w.dir.x, w.dir.y, w.dir.z);
        const L = Math.hypot(w.tip.x, w.tip.y, w.tip.z);
        const q = new T.Quaternion().setFromUnitVectors(parts.up, dir);
        const col = hex(pose.color || DIR_DEFAULTS.color);
        parts.shaft.quaternion.copy(q);
        parts.shaft.position.copy(dir).multiplyScalar((L - HEAD_H) / 2);
        parts.shaft.scale.set(1, L - HEAD_H, 1);
        parts.shaft.material.color.setHex(col);
        parts.head.quaternion.copy(q);
        parts.head.position.copy(dir).multiplyScalar(L - HEAD_H / 2);
        parts.head.material.color.setHex(col);

        // 滚转环与刻度: {b1,b2} 在世界里就是环的两条轴。
        const rb = dirRollBasis(pose);
        orient(parts.rollGroup, rb.b1, rb.b2, w.dir);
        parts.rollGroup.position.set(w.finCentre.x, w.finCentre.y, w.finCentre.z);
        const r = dirRad(pose.roll);
        parts.rollTick.rotation.z = r;
        parts.rollTick.scale.set(DIR_FIN_R, TUBE * 0.7, 1);
        parts.rollTick.position.set(Math.cos(r) * DIR_FIN_R / 2, Math.sin(r) * DIR_FIN_R / 2, 0.002);

        // 三颗 billboard 把手: 位置来自同一份世界坐标, 大小按各自那点的相机距离折算。
        // pitch 那颗站在箭尖上 (dirWorldPose 的 tip), 名字与姿态那三个角不是一回事。
        const at = { yaw: w.yaw, pitch: w.tip, roll: w.roll };
        for (const key of ['yaw', 'pitch', 'roll']) {
            const p = at[key];
            const m = parts.handles[key];
            m.position.set(p.x, p.y, p.z);
            const on = opts.state === key, hot = opts.hover === key;
            const s = DIR_HANDLE_R * pxToWorld(m.position) * (on || hot ? HANDLE_K : 1);
            m.scale.set(s, s, 1);
            m.quaternion.copy(parts.camQuat);
            m.material.userData.base = on ? 1 : hot ? 0.9 : 0.78;
        }
        const dim = opts.dim ? DIM : 1;
        scene.traverse(o => {
            if (o.material && o.material.userData.base !== undefined) {
                o.material.opacity = o.material.userData.base * dim;
            }
        });
    }

    function draw() {
        const T = TT();
        if (!renderer || !T || !host) return;
        resize();
        applyCam();
        sync(T, stagePose || dirGizmoPose(), stageOpts);
        renderer.render(scene, cam);
    }

    // 面板的悬停/按下状态由 direction.js 拿着 (它才吃指针), 这里只抄一份来画。
    DirView.frame = function frame(canvasEl, pose, opts) {
        if (!DirView.begin(canvasEl)) return false;
        if (pose) stagePose = pose;
        if (opts) stageOpts = opts;
        mark();
        return true;
    };

    // 屏幕坐标 (CSS 像素, 以小窗中心为原点) —— 与 dirHandlePoints 同一个坐标系, 所以
    // direction.js 里那一颗 dirHitHandle 不用知道自己在命中 2D 还是 3D。
    function toScreen(T, p) {
        const v = new T.Vector3(p.x, p.y, p.z).project(cam);
        return { x: (v.x * 0.5 + 0.5) * W - W / 2, y: (0.5 - v.y * 0.5) * H - H / 2 };
    }

    // 保证投影用的是当前尺寸与当前相机 (mousedown 可能赶在第一次 rAF 之前)。
    function ready() {
        if (!renderer || !TT()) return false;
        if (!W || !H) resize();
        applyCam();
        return true;
    }

    DirView.handlePoints = function handlePoints(pose) {
        const T = TT();
        if (!ready()) return null;
        const w = dirWorldPose(pose || dirGizmoPose());
        return {
            yaw: toScreen(T, w.yaw),
            pitch: toScreen(T, w.tip),
            roll: toScreen(T, w.roll),
            finCentre: toScreen(T, w.finCentre),
            finR: Math.abs(toScreen(T, { x: 1, y: 0, z: 0 }).x) * DIR_FIN_R,
            R: Math.abs(toScreen(T, { x: 1, y: 0, z: 0 }).x),
        };
    };

    // ---- 指针 ----
    // 中键: 只转眼睛。拖动多少度就转多少度 (与 3D tab 那套一个分寸), 俯仰夹在 ±EL_MAX。
    DirView.orbit = function orbit(dx, dy) {
        view.az -= dx * ORBIT_K;
        view.el = Math.max(-EL_MAX, Math.min(EL_MAX, view.el + dy * ORBIT_K));
        mark();
    };

    DirView.setAzEl = function setAzEl(az, el) {
        view.az = az;
        view.el = Math.max(-EL_MAX, Math.min(EL_MAX, el));
        mark();
    };

    // 左键拖把手: 把指针那条射线打回把手自己那根轨道, 交点在哪就是哪个角 —— 绝对读数, 没有奇点。
    // 交不出来 (视线与那个面平行) 就原样不动 (回 null), 而不是把角甩到一个假值上。
    DirView.axisDelta = function axisDelta(axis, pose, pt, prev) {
        const T = TT();
        if (!ready()) return null;
        const w = dirWorldPose(pose);
        const snap = v => (prev && prev.shiftKey ? Math.round(v / 15) * 15 : v);
        ray.setFromCamera(new T.Vector2(pt.x / (W / 2), -pt.y / (H / 2)), cam);
        const r = ray.ray;
        if (axis === 'yaw') {
            const hit = r.intersectPlane(new T.Plane(new T.Vector3(0, 1, 0), 0), new T.Vector3());
            if (!hit) return null;
            return { yaw: dirWrap360(snap(dirDeg(Math.atan2(hit.z, hit.x)))) };
        }
        if (axis === 'pitch') {
            const t = dirRad(pose.yaw);
            const hit = r.intersectPlane(new T.Plane(new T.Vector3(-Math.sin(t), 0, Math.cos(t)), 0),
                new T.Vector3());
            if (!hit) return null;
            const along = hit.x * Math.cos(t) + hit.z * Math.sin(t);
            const deg = dirDeg(Math.atan2(hit.y, Math.abs(along) < 1e-6 ? 1e-6 : along));
            return { pitch: Math.max(-90, Math.min(90, snap(deg))) };
        }
        const c = new T.Vector3(w.finCentre.x, w.finCentre.y, w.finCentre.z);
        const n = new T.Vector3(w.dir.x, w.dir.y, w.dir.z);
        const hit = r.intersectPlane(new T.Plane(n, -n.dot(c)), new T.Vector3());
        if (!hit) return null;
        const q = hit.sub(c);
        const rb = dirRollBasis(pose);
        const d1 = q.dot(new T.Vector3(rb.b1.x, rb.b1.y, rb.b1.z));
        const d2 = q.dot(new T.Vector3(rb.b2.x, rb.b2.y, rb.b2.z));
        return { roll: dirWrap180(snap(dirDeg(Math.atan2(d2, d1)))) };
    };

    // 探针/调试要看的: 某个世界点此刻落在屏幕哪儿 (CSS 像素, 小窗中心为原点)。
    DirView.project = function project(p) {
        const T = TT();
        if (!ready()) return null;
        return toScreen(T, p);
    };

    // 立刻画一帧, 不等下一次 rAF。合帧是活路径的规矩 (拖把手每帧只画一次), 但回读像素的人要的是
    // "此刻的画面" —— 一个看不见的页面上 rAF 根本不来, 不给人这一钩子就只能测到空画布。
    DirView.drawNow = function drawNow() {
        if (!renderer) return false;
        draw();
        return true;
    };
})();
