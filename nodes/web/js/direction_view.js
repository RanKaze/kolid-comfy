/* Direction / Point / Ray / Plane 小窗的 three.js 视图 —— "世界里的观察" 那张图改成真的 3D 场景来画。
   引擎是仓库里 vendored 的那份 window.K3D (js/3d-bundle.js: three r160 + loaders + TransformControls),
   页面不吃 CDN, 与 3D tab 用的是同一个 bundle。

   家族四个类型 (direction/point/ray/plane) 共用这一个场景: 画布平面贴**此刻的 context image**
   (参考图唯独不含正在编辑的这一枚 —— 那趟合成在 direction.js 的 dirRefTarget 里), 于是"对象指着/
   悬在图里的哪儿"直接可读; 画布中心沿 +Y 有一根细线 (DIR_FRONT, 原正面箭头细线化), 与 grid 上
   的红 X / 蓝 Z 合成三根世界轴线 —— 图片铺在 XZ、正面朝着 +Y。对象与把手挂进场景:
     direction  仰角弧 / 滚转环 / 箭头, 三颗把手 (钉在原点, 没有位置);
     point      一颗球 + 落地线, 挪动 (pos) 与抬放 (h) 两颗把手;
     ray        球 + 全长箭头, 挪动 / 抬放 / 绕球心的 yaw / pitch 四颗把手;
     plane      圆盘 + 法线短箭, 同 ray 的四颗把手 (steering 的是法线)。
   把手在屏幕上恒定大小。指针: 中键拖动 = 相机绕原点轨道 (只转眼睛, 不动对象), 左键拖把手 = 把射线
   打回把手自己的约束面取绝对读数。

   K3D 没进来, 或者这块 canvas 建不起 WebGL 上下文 (jsdom、旧版节点进程没有 /js/ 路由) 时, begin() 一路回
   false, direction.js 就退回它自己那张 2D 世界图。两种画法吃的是同一份世界坐标, 所以退路不会读出另一个读数。 */
(function () {
    const DirView = {};
    window.DirView = DirView;

    const FOV = 40;                 // 视场角。小窗是取景框不是自由相机, 所以只给一个固定值
    const DIST = 4.6;               // 相机到原点的默认世界距离 (环半径 = 1 ⇒ 姿态球 1.3 正好留得住边)
    const DIST_MIN = 1.5;           // 滚轮拉近的下限: 姿态球 (1.3) 外一点点, 再近就穿进对象里了
    const DIST_MAX = 12;            // 拉远的上限: 再远环就糊成一枚点了
    const TUBE = 0.012;             // 轨道在世界里的粗细
    const HEAD_H = 0.2;             // 箭头那顶锥子的高度 (世界单位)
    const ORBIT_K = 0.55;           // 中键拖动: 每像素转多少度 (与 3D tab 那套"拖多少转多少"同一个分寸)
    const EL_MAX = 85;              // 相机俯仰夹在这里: 正好从边上或正下方看, 三根轨道会糊成一条线
    const HANDLE_K = 1.3;           // 悬停/按下时把手放大这一档
    const DIM = 0.32;               // 没人在编辑时整颗转暗 (与 2D 世界图同一个数)

    let renderer = null, scene = null, cam = null, host = null, ray = null;
    let W = 0, H = 0, broken = false, queued = false;
    let parts = null, arcCache = { deg: -1, geo: null };
    let refVersion = -1, refW = 0, refH = 0, stageState = null, stageOpts = { dim: true };
    // 相机 = "眼睛站在哪儿"。默认 (az 0, el 25) 复现旧 2D 世界图那条 25° 俯角的正交视线,
    // 于是第一次打开小窗看到的东西和以前一回事, 只是现在转得动。dist 归滚轮管 (拉远/拉近)。
    const view = { az: 0, el: 25, dist: DIST };

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
    // 深度只让画布平面写 (它才是那张"地面"), 轨道与对象都只读深度 —— 于是平面背后 naturally 挡住东西,
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

        // Y 轴 grid: 铺在 XZ 平面 (y = 0) 上的参考网格 —— 世界是标准 XYZ (Y 朝上), 图片躺在
        // XZ 里、正面朝着 +Y, 空间读数靠这张网格。±1.5 / 0.25 一格 (画布半对角 0.92, 大一圈);
        // y 压低 0.002 不与画布网片同面 (同面必闪)。
        if (T.GridHelper) {
            parts.grid = new T.GridHelper(3, 12, 0x4a4e59, 0x363a44);
            parts.grid.position.y = -0.002;
            if (parts.grid.material) {
                parts.grid.material.transparent = true;
                parts.grid.material.opacity = 0.5;
                parts.grid.material.userData.base = 0.5;
            }
            scene.add(parts.grid);
        }
        // 世界轴线: grid 上的 X (红) 与 Z (蓝) 两根, "图片铺在 XZ"靠它们读; +Y 那根就是
        // 下面那根画布中心的绿色细线 (DIR_FRONT)。y 抬 0.001 压在 grid 之上、画布之下。
        const axisLine = (a, b, color) => {
            const geo = new T.BufferGeometry().setFromPoints(
                [new T.Vector3(a[0], a[1], a[2]), new T.Vector3(b[0], b[1], b[2])]);
            const m = new T.LineBasicMaterial({ color, transparent: true, opacity: 0.55 });
            m.userData.base = 0.55;
            const line = new T.Line(geo, m);
            line.position.y = -0.001;
            scene.add(line);
        };
        axisLine([-1.5, 0, 0], [1.5, 0, 0], 0xff453a);
        axisLine([0, 0, -1.5], [0, 0, 1.5], 0x0a84ff);

        // 0° 参考边: 画布 +X (中心到右边缘中点)。环上的角度没有它就只能读成"绕一圈", 读不出相对谁。
        parts.refEdge = new T.Mesh(new T.PlaneGeometry(1, 1), material(T, DIR_RING, 0.5));
        parts.refEdge.rotation.x = -Math.PI / 2;
        parts.refEdge.position.y = 0.003;           // 抬一点点, 不与网片同面 (同面必闪)
        parts.refEdge.renderOrder = 1;
        scene.add(parts.refEdge);

        // Y 轴线: 画布中心沿 +Y 的一条细线 (原正面箭头细线化) —— 与 grid 上的红 X、蓝 Z 两根
        // 同规格, 合成三根世界轴线: 图片铺在 XZ、正面朝着 +Y。Line 在 WebGL 里天生 1px 细。
        parts.frontLine = (() => {
            const geo = new T.BufferGeometry().setFromPoints(
                [new T.Vector3(0, -1.5, 0), new T.Vector3(0, 1.5, 0)]);
            const m = new T.LineBasicMaterial({ color: hex(DIR_FRONT), transparent: true, opacity: 0.55 });
            m.userData.base = 0.55;
            return new T.Line(geo, m);
        })();
        scene.add(parts.frontLine);

        // 仰角弧: 一个组带着"当前方位那个竖直平面"的朝向, 里面两条弧只在自己的坐标系里转 z。
        // direction 的弧绕原点; ray/plane 的同一组挪到球心上 —— 一份几何两处用。
        parts.arcGroup = new T.Group();
        parts.arcGroup.renderOrder = 2;
        parts.arcTrack = new T.Mesh(new T.TorusGeometry(DIR_POSE_R, TUBE * 0.7, 6, 48, Math.PI),
            material(T, DIR_ARC, 0.28));
        parts.arcTrack.rotation.z = -Math.PI / 2;   // 从 -90° 起扫 ⇒ 整条轨道是 -90..90
        parts.arcLive = new T.Mesh(arcGeometry(T, 1), material(T, DIR_ARC, 0.95));
        parts.arcGroup.add(parts.arcTrack, parts.arcLive);
        scene.add(parts.arcGroup);

        // 箭头本体: 杆 + 头, 颜色跟着描述符走。direction/ray 是全长姿态箭, plane 借同一对 mesh
        // 画短的法线刻箭 (长短在 sync 里按类型定)。
        parts.shaft = new T.Mesh(new T.CylinderGeometry(TUBE * 1.6, TUBE * 1.6, 1, 10),
            material(T, DIR_DEFAULTS.color, 1));
        parts.head = new T.Mesh(new T.ConeGeometry(HEAD_H * 0.34, HEAD_H, 16), material(T, DIR_DEFAULTS.color, 1));
        parts.shaft.renderOrder = parts.head.renderOrder = 3;
        scene.add(parts.shaft, parts.head);

        // 家族三件套: 起点球 / 落地线 / 圆盘。哪几件亮由类型说了算 (sync 里 visible)。
        parts.ball = new T.Mesh(new T.SphereGeometry(1, 18, 12), material(T, DIR_DEFAULTS.color, 0.95));
        parts.ball.renderOrder = 3;
        scene.add(parts.ball);
        parts.drop = new T.Mesh(new T.CylinderGeometry(TUBE, TUBE, 1, 8), material(T, DIR_DEFAULTS.color, 0.45));
        parts.drop.renderOrder = 2;
        scene.add(parts.drop);
        parts.disc = new T.Mesh(new T.CircleGeometry(1, 48), material(T, DIR_DEFAULTS.color, 0.16));
        parts.disc.renderOrder = 2;
        scene.add(parts.disc);

        // 三向轴把手 (point/ray/plane): 根在对象位置上的 X/Y/Z 三支箭头 —— 空间中可挪的要素
        // 拿它挪位置 (红=X 画布左右, 绿=Y 离面高度, 蓝=Z 画布上下)。**Unity 风格: 末端不放
        // 球/圆片, 整支箭头就是把手** —— 悬停/按下时整支提亮 (sync 里按 opts 调 base), 抓取
        // 按"指针到箭杆的屏幕距离"判 (direction.js 的 dirHitHandle)。组的原点 = 球心;
        // local 空间下轴向随对象朝向, 所以朝向每帧在 sync 里重摆 (不建死)。
        parts.triad = new T.Group();
        parts.triadAxes = {};
        const mkAxis = (key, dir, color) => {
            const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0),
                new T.Vector3(dir.x, dir.y, dir.z));
            const shaft = new T.Mesh(
                new T.CylinderGeometry(TUBE * 1.6, TUBE * 1.6, GEO_AXIS_L - HEAD_H, 8),
                material(T, color, 0.8));
            shaft.quaternion.copy(q);
            shaft.position.set(dir.x, dir.y, dir.z).multiplyScalar((GEO_AXIS_L - HEAD_H) / 2);
            const head = new T.Mesh(new T.ConeGeometry(HEAD_H * 0.3, HEAD_H, 12), material(T, color, 0.8));
            head.quaternion.copy(q);
            head.position.set(dir.x, dir.y, dir.z).multiplyScalar(GEO_AXIS_L - HEAD_H / 2);
            parts.triad.add(shaft, head);
            parts.triadAxes[key] = { shaft, head };
        };
        mkAxis('mvX', { x: 1, y: 0, z: 0 }, FAM_HANDLE_COLORS.mvX);
        mkAxis('mvY', { x: 0, y: 1, z: 0 }, FAM_HANDLE_COLORS.mvY);
        mkAxis('mvZ', { x: 0, y: 0, z: 1 }, FAM_HANDLE_COLORS.mvZ);
        parts.triad.renderOrder = 3;
        scene.add(parts.triad);

        // 旋转环 (rotate 模式, Unity 风格): 三根彩色圆环, 每根 = 绕一根轴的旋转 —— global 绕
        // 世界 XYZ, local 绕对象自己的轴。torus 默认躺在 local XY (法线 local Z), 每帧 orient
        // 到当前轴上; 半径比移动臂长大一圈, 悬停/按下提亮。旧 yaw/pitch/roll 把手被它们取代。
        parts.rotRings = {};
        for (const key of ['rotX', 'rotY', 'rotZ']) {
            const m = new T.Mesh(new T.TorusGeometry(ROT_R, TUBE * 1.1, 6, 64),
                material(T, FAM_HANDLE_COLORS[key], 0.45));
            m.renderOrder = 2;
            m.visible = false;
            parts.rotRings[key] = m;
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
        return { live: !!renderer, broken, az: view.az, el: view.el, dist: view.dist, fov: FOV,
            W, H, refVersion, hasMap: !!(parts && parts.plane.material.map),
            // 那块网片此刻真的占多大 (世界单位) —— 平面该有多大只由 dirPlaneHalf 说了算, 探针要能问出来。
            planeScale: parts ? [parts.plane.scale.x, parts.plane.scale.y] : null };
    };

    // ---- 相机 ----
    function applyCam() {
        const a = dirRad(view.az), e = dirRad(view.el);
        cam.position.set(view.dist * Math.sin(a) * Math.cos(e), view.dist * Math.sin(e), view.dist * Math.cos(a) * Math.cos(e));
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
    // 于是一次拖动不会白重传一张画布大小的纹理。
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

    // ---- 把对象摆进场景 ----
    // state = {kind, desc}, 世界读法全部来自 direction.js 的那一份 (四元数与 position:
    // famHandleWorld), 这里只管摆 mesh, 不折第二遍坐标。
    function sync(T, state, opts) {
        const kind = state.kind, d = state.desc;
        syncTexture(T);

        const half = dirPlaneHalf();
        parts.plane.scale.set(2 * half.hw, 2 * half.hd, 1);
        // 几何是居中的 1×1, 缩到 hw 后仍是以原点为中心的 ±hw/2; 参考边画的是"中心 → 右边缘中点",
        // 所以再把整条往 +X 挪半条, 让它从原点起步 (与 2D 退路的 moveTo(0,0); lineTo(hw,0) 对齐)。
        parts.refEdge.scale.set(half.hw, TUBE * 0.8, 1);
        parts.refEdge.position.x = half.hw / 2;

        const col = hex(d.color || DIR_DEFAULTS.color);
        const pos = kind === 'direction' ? { x: 0, y: 0, z: 0 } : d.position;
        // 四元数唯一真相: f = 规范朝向 +X 转到世界 (ray 的箭头 / plane 的法线 / direction 的指向)。
        const fwd = qApply(d.rotation, { x: 1, y: 0, z: 0 });
        const upv = qApply(d.rotation, { x: 0, y: 1, z: 0 });
        const sid = qApply(d.rotation, { x: 0, y: 0, z: 1 });

        // 仰角弧 (direction/ray/plane): local x = 当前方位的水平方向, local y = 世界 up,
        // local z = 两者叉积; 组整体挪到对象那一点 (direction 在原点)。仰角弧只归移动模式
        // (旋转模式读数由环的拖动读数说话)。
        const hasArc = kind !== 'point' && gizmoMode === 'move';
        parts.arcGroup.visible = hasArc;
        if (hasArc) {
            const yawDeg = dirDeg(Math.atan2(fwd.z, fwd.x));
            const t = dirRad(yawDeg);
            orient(parts.arcGroup, dirWorldAz(yawDeg), parts.up, { x: -Math.sin(t), y: 0, z: Math.cos(t) });
            parts.arcGroup.position.set(pos.x, pos.y, pos.z);
            const pitDeg = dirDeg(Math.asin(Math.max(-1, Math.min(1, fwd.y))));
            parts.arcLive.geometry = arcGeometry(T, pitDeg);
            parts.arcLive.rotation.z = pitDeg >= 0 ? 0 : dirRad(pitDeg);
        }

        // 箭头 (direction/ray 全长; plane 借同一对 mesh 画法线短箭): 杆从对象点走到头前, 头补上
        // 最后那一截。方向向量来自 dirVecOf, 长度按类型定。
        const hasArrow = kind !== 'point';
        parts.shaft.visible = parts.head.visible = hasArrow;
        if (hasArrow) {
            const v = fwd;
            const L = kind === 'plane' ? DIR_POSE_R * 0.42 : DIR_POSE_R;
            const q = new T.Quaternion().setFromUnitVectors(parts.up, new T.Vector3(v.x, v.y, v.z));
            parts.shaft.quaternion.copy(q);
            parts.shaft.position.set(pos.x + v.x * (L - HEAD_H) / 2,
                pos.y + v.y * (L - HEAD_H) / 2, pos.z + v.z * (L - HEAD_H) / 2);
            parts.shaft.scale.set(1, L - HEAD_H, 1);
            parts.shaft.material.color.setHex(col);
            parts.head.quaternion.copy(q);
            parts.head.position.set(pos.x + v.x * (L - HEAD_H / 2),
                pos.y + v.y * (L - HEAD_H / 2), pos.z + v.z * (L - HEAD_H / 2));
            parts.head.material.color.setHex(col);
        }

        // 起点球 + 落地线 (point/ray/plane): 球钉在对象那点, 线从球心垂到画布平面 (贴地就不画)。
        const hasBall = kind !== 'direction';
        parts.ball.visible = hasBall;
        parts.drop.visible = hasBall && Math.abs(pos.y) > 1e-4;
        if (hasBall) {
            parts.ball.position.set(pos.x, pos.y, pos.z);
            parts.ball.scale.set(GEO_BALL_R, GEO_BALL_R, GEO_BALL_R);
            parts.ball.material.color.setHex(col);
            if (parts.drop.visible) {
                parts.drop.scale.set(1, Math.abs(pos.y), 1);
                parts.drop.position.set(pos.x, pos.y / 2, pos.z);
                parts.drop.material.color.setHex(col);
            }
        }

        // 三向轴把手 (move 模式): 组根在球心; local 空间下轴向随对象朝向, 每帧重摆朝向。
        // Unity 风格的高亮: 悬停/按下哪支, 哪支整体提亮 (base 由 dim traverse 统一乘)。
        parts.triad.visible = hasBall && gizmoMode === 'move';
        if (parts.triad.visible) {
            parts.triad.position.set(pos.x, pos.y, pos.z);
            const axes = moveAxes(state);
            for (const key of ['mvX', 'mvY', 'mvZ']) {
                const ax = parts.triadAxes[key];
                if (!ax) continue;
                const A = axes[key];
                const q = new T.Quaternion().setFromUnitVectors(parts.up,
                    new T.Vector3(A.x, A.y, A.z));
                ax.shaft.quaternion.copy(q);
                ax.shaft.position.set(A.x, A.y, A.z).multiplyScalar((GEO_AXIS_L - HEAD_H) / 2);
                ax.head.quaternion.copy(q);
                ax.head.position.set(A.x, A.y, A.z).multiplyScalar(GEO_AXIS_L - HEAD_H / 2);
                const hot = opts.state === key || opts.hover === key;
                ax.shaft.material.userData.base = hot ? 1 : 0.8;
                ax.head.material.userData.base = hot ? 1 : 0.8;
            }
        }

        // 旋转环 (rotate 模式): 三根彩色环绕对象, 每根 = 绕一根轴的旋转; global 轴是世界 XYZ,
        // local 轴随对象朝向 (rotRingAxes 一份真相)。悬停/按下提亮, 其余半透明。
        const rings = gizmoMode === 'rotate' && kind !== 'point' ? rotRingAxes(state) : [];
        for (const key of ['rotX', 'rotY', 'rotZ']) {
            const m = parts.rotRings[key];
            const a = rings.find(x => x.key === key);
            m.visible = !!a;
            if (!a) continue;
            const basis = rotPlaneBasis(a.A);
            orient(m, basis.e1, basis.e2, a.A);
            m.position.set(a.center.x, a.center.y, a.center.z);
            const hot = opts.state === key || opts.hover === key;
            m.material.userData.base = hot ? 0.95 : 0.45;
        }

        // 圆盘 (plane): 盘面基摆朝向, 法线就是盘的 local z —— "无限平面"的取景记号。
        parts.disc.visible = kind === 'plane';
        if (kind === 'plane') {
            orient(parts.disc, upv, sid, fwd);
            parts.disc.position.set(pos.x, pos.y, pos.z);
            parts.disc.scale.set(GEO_DISC_R, GEO_DISC_R, 1);
            parts.disc.material.color.setHex(col);
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
        sync(T, stageState || dirGizmoState(), stageOpts);
        renderer.render(scene, cam);
    }

    // 面板的悬停/按下状态由 direction.js 拿着 (它才吃指针), 这里只抄一份来画。
    DirView.frame = function frame(canvasEl, state, opts) {
        if (!DirView.begin(canvasEl)) return false;
        if (state) stageState = state;
        if (opts) stageOpts = opts;
        mark();
        return true;
    };

    // 屏幕坐标 (CSS 像素, 以小窗中心为原点) —— 与 famHandlePoints 同一个坐标系, 所以
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

    DirView.handlePoints = function handlePoints(state) {
        const T = TT();
        if (!ready()) return null;
        const s = state || dirGizmoState();
        const hw = famHandleWorld(s);
        const pts = {};
        for (const key of famHandleKeys(s)) pts[key] = toScreen(T, hw[key]);
        return pts;
    };

    // ---- 指针 ----
    // 中键: 只转眼睛。拖动多少度就转多少度 (与 3D tab 那套一个分寸), 俯仰夹在 ±EL_MAX。
    DirView.orbit = function orbit(dx, dy) {
        view.az -= dx * ORBIT_K;
        view.el = Math.max(-EL_MAX, Math.min(EL_MAX, view.el + dy * ORBIT_K));
        mark();
    };

    // 滚轮: 拉远/拉近。乘性步进 (每格 ±10%, 转多少格动多少档, 与 3D tab 的滚轮同一个分寸),
    // 距离夹在姿态球外与远得没意义之间。只动眼睛 —— 对象与描述符一个字节不动。
    DirView.zoom = function zoom(factor) {
        view.dist = Math.max(DIST_MIN, Math.min(DIST_MAX, view.dist * factor));
        mark();
    };

    DirView.setAzEl = function setAzEl(az, el) {
        view.az = az;
        view.el = Math.max(-EL_MAX, Math.min(EL_MAX, el));
        mark();
    };

    // 按下那一刻的抓取锚点 (三向轴): 指针射线与"过对象、面向相机"平面的交点, 沿轴量出它与对象
    // 根部的偏移。拖动全程用这一个锚 (平面也固定在按下那一刻的位置) —— 手指抓在箭头哪里,
    // 哪里就跟着指针走; 不补偿的话第一帧就把对象根吸附到指针上。
    DirView.grabAxis = function grabAxis(axis, state, pt) {
        const T = TT();
        if (!ready()) return null;
        if (axis !== 'mvX' && axis !== 'mvY' && axis !== 'mvZ') return null;
        // 轴向随空间 (global = 世界轴, local = 对象自己的轴), 按下那一刻钉进锚里 —— 拖动全程
        // 用这一根, 不然对象一边挪一边转轴, 手感就飘了。
        const aw = moveAxes(state)[axis];
        const A = new T.Vector3(aw.x, aw.y, aw.z);
        const p = state.desc.position;
        const pv = new T.Vector3(p.x, p.y, p.z);
        const eye = cam.getWorldDirection(new T.Vector3());
        ray.setFromCamera(new T.Vector2(pt.x / (W / 2), -pt.y / (H / 2)), cam);
        const hit = ray.ray.intersectPlane(new T.Plane(eye, -eye.dot(pv)), new T.Vector3());
        if (!hit) return null;
        return {
            A: [A.x, A.y, A.z],
            pv: [p.x, p.y, p.z],
            offset: hit.sub(pv).dot(A),
        };
    };

    // 旋转环的抓取锚: 按下那一刻, 指针射线与"环所在平面 (法线 = 环轴, 过环心)"的交点绕轴心的
    // 方位角 —— 拖动全程平面/轴/起始姿态都固定, 转角 = 方位角差, 姿态 = W(轴, 角)·起始姿态。
    DirView.grabRotate = function grabRotate(axis, state, pt) {
        const T = TT();
        if (!ready()) return null;
        const ring = rotRingAxes(state).find(x => x.key === axis);
        if (!ring) return null;
        const An = new T.Vector3(ring.A.x, ring.A.y, ring.A.z);
        const pv = new T.Vector3(ring.center.x, ring.center.y, ring.center.z);
        ray.setFromCamera(new T.Vector2(pt.x / (W / 2), -pt.y / (H / 2)), cam);
        const hit = ray.ray.intersectPlane(new T.Plane(An, -An.dot(pv)), new T.Vector3());
        if (!hit) return null;
        const basis = rotPlaneBasis(ring.A);
        const v = hit.sub(pv);
        return {
            A: [An.x, An.y, An.z],
            pv: [pv.x, pv.y, pv.z],
            e1: [basis.e1.x, basis.e1.y, basis.e1.z],
            e2: [basis.e2.x, basis.e2.y, basis.e2.z],
            phi0: Math.atan2(
                v.x * basis.e2.x + v.y * basis.e2.y + v.z * basis.e2.z,
                v.x * basis.e1.x + v.y * basis.e1.y + v.z * basis.e1.z),
            q0: Object.assign({}, state.desc.rotation),
            local: gizmoSpace === 'local'
                ? { x: axis === 'rotX' ? 1 : 0, y: axis === 'rotY' ? 1 : 0, z: axis === 'rotZ' ? 1 : 0 }
                : null,
        };
    };

    // 左键拖把手: 把指针那条射线打回把手自己的约束面, 交点在哪就是哪个读数 —— 绝对值, 没有奇点。
    // 交不出来 (视线与那个面平行) 就原样不动 (回 null), 而不是把读数甩到一个假值上。
    // direction 的三根轴是老算法; 家族的挪动/抬放/绕球心 yaw / pitch 打回各自的水平面或竖直面,

    DirView.axisDelta = function axisDelta(axis, state, pt, prev) {
        const T = TT();
        if (!ready()) return null;
        const kind = state.kind;
        const snap05 = v => (prev && prev.shiftKey ? Math.round(v / 0.05) * 0.05 : v);
        ray.setFromCamera(new T.Vector2(pt.x / (W / 2), -pt.y / (H / 2)), cam);
        const r = ray.ray;
        if (axis === 'mvX' || axis === 'mvY' || axis === 'mvZ') {
            // 三向轴把手: 打回**正对相机**的那张平面 (法线 = 视线方向), 交点沿轴分量就是位移。
            // 别用"包含轴又面向相机"的那张 —— 它的法线 ⊥ 视线, 自身含机位, 指针射线与它平行,
            // 永远交不上 (第一版拖不动的病根)。
            // 按下时存了抓取锚 (grabAxis) 就按它补偿: 平面/轴/对象位置都固定在按下那一刻,
            // 指针的轴向行程减去抓取偏移才是位移 —— 手指抓在箭头哪里, 哪里跟指针走,
            // 原点绝不吸附 (没锚的保险路才走绝对读法)。local 空间的轴也钉在锚里。
            const g = prev && prev.grab && prev.grab.axis === axis ? prev.grab : null;
            const aw = g ? { x: g.A[0], y: g.A[1], z: g.A[2] } : moveAxes(state)[axis];
            const A = new T.Vector3(aw.x, aw.y, aw.z);
            const p0 = g ? g.pv : state.desc.position;
            const eye = cam.getWorldDirection(new T.Vector3());
            const base = new T.Vector3(p0.x, p0.y, p0.z);
            const hit = r.intersectPlane(new T.Plane(eye, -eye.dot(base)), new T.Vector3());
            if (!hit) return null;
            let t = hit.sub(base).dot(A);
            if (g) t -= g.offset;
            const cl = v => Math.max(-4, Math.min(4, v));
            return { position: {
                x: cl(p0.x + A.x * t), y: cl(p0.y + A.y * t), z: cl(p0.z + A.z * t),
            } };
        }
        if (axis === 'rotX' || axis === 'rotY' || axis === 'rotZ') {
            // 旋转环 (Unity 风格): 指针打回环所在的平面 (法线 = 环轴, 过环心), 交点绕轴心的
            // 方位角与按下那刻的差就是转角 —— 起始姿态 (grab.desc0) 绕轴转这个角, 再分解回
            // yaw/pitch(/roll)。视线顺着环轴看时交不上, 这一帧不动 (环侧对眼睛, 本来也拖不着)。
            const g = prev && prev.grab && prev.grab.axis === axis ? prev.grab : null;
            if (!g) return null;
            const An = new T.Vector3(g.A[0], g.A[1], g.A[2]);
            const pv = new T.Vector3(g.pv[0], g.pv[1], g.pv[2]);
            const hit = r.intersectPlane(new T.Plane(An, -An.dot(pv)), new T.Vector3());
            if (!hit) return null;
            const v = hit.sub(pv);
            const phi = Math.atan2(
                v.x * g.e2[0] + v.y * g.e2[1] + v.z * g.e2[2],
                v.x * g.e1[0] + v.y * g.e1[1] + v.z * g.e1[2]);
            let th = phi - g.phi0;
            th = Math.atan2(Math.sin(th), Math.cos(th));
            const thDeg = dirDeg(th);
            const thSnap = prev && prev.shiftKey ? Math.round(thDeg / 15) * 15 : thDeg;
            prev.rotTheta = thSnap;
            // global 空间左乘世界轴旋转, local 空间右乘对象自己的规范轴 (四元数合成)。
            const R = qFromAxisAngle({ x: g.A[0], y: g.A[1], z: g.A[2] }, dirRad(thSnap));
            return { rotation: qNormalize(g.local ? qMul(g.q0, R) : qMul(R, g.q0)) };
        }
        return null;
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
