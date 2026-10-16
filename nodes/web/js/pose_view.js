/* Pose 那一格搬进了宿主的 dock（workbench/pose.tsx），这一页只留三件事:
   ① 目标: pin 一枚 Pose 记录 (chip 点击 / P 键), 并回答"此刻在编辑谁" (poseGizmoTarget);
   ② From image: 选图 (openFxMapModal) → 后端 DWPose → 关键点换算 (js/pose_openpose.js) → 写 desc;
   ③ 快照: updatePosePanel() 把 desc + 层面尺寸播出去, 宿主的舞台与控制读它。

   编辑器 (舞台 rig、轨道相机、关节拾取、把手、七颗形态滑块、取景五格) 不住在这里了 —— 它的舞台
   引擎 (js/pose_core.js 的 PoseCore.PoseRig) 与装配 (js/pose_morph.js) 是容器里那份同源脚本, 宿主
   自己再起一只 rig 来看、来摆。**页面烘面的那一只 rig 仍是权威**: rig 生命周期 (poseRigs /
   poseKickBuild / poseSync, 见 attr/pose.js) 没动, 宿主改 desc 只走 patchPoseTarget, 页面照常重烤。
   desc 是权威 (attr/pose.js 的 sanitize 是唯一裁定口), 与 direction 小窗同一套。 */

// ---- 目标 (与 dirPinTarget/dirGizmoTarget 同一套) ----
// 小窗编辑的是一枚记录, 不是"选中的层的那个老字段"。pin 只在它的层正是选中层时才算数; 没钉过就
// 退到选中层的第一枚 Pose 记录 —— adoption 不回写, 记录被删时校验失败同样退到选中层。
let posePinnedTarget = null;
function posePinTarget(l, r) {
    if (!l || !r) return;
    posePinnedTarget = { layerId: l.id, ref: r.id };
    selectLayer(l.id, 'transform');
    // 那一格搬进宿主 dock 之后没有"开窗"这回事了: 那一格常驻, 钉下目标就让它亮起来 + 播一次快照。
    refreshLayerPanels();
}
function poseGizmoTarget() {
    const l = typeof getLayer === 'function' ? getLayer(selectedId) : null;
    if (!l) return null;
    if (posePinnedTarget && String(posePinnedTarget.layerId) === String(l.id)) {
        const r = attrRecord(posePinnedTarget.ref);
        if (r && r.type === 'pose' && attrRefList(l).indexOf(r.id) >= 0) return { l, r };
    }
    const r = findAttr(l, 'pose');
    return r ? { l, r } : null;
}
function poseRigFor(t) {
    return t && typeof poseRigs !== 'undefined' ? poseRigs.get(t.r.id) || null : null;
}

// ---- desc 的写口 (patchGizmoTarget 同一套: 整只换, sanitize 是 spec 自己那道裁定) ----
function patchPoseTarget(t, patch, opts) {
    const spec = ATTR_TYPES[t.r.type] || ATTR_TYPES.pose;
    t.r.desc = spec.sanitize(Object.assign({}, t.r.desc, patch));
    markAttrPainted(t.r);
    if (!(opts && opts.silent)) {
        render();
        if (!(opts && opts.live)) refreshLayerPanels();
    }
}
function poseSummary(pose) {
    const n = Object.keys((pose && pose.bones) || {}).length;
    return n ? `${n} joint${n === 1 ? '' : 's'} posed` : 'back to the rest pose';
}

// ---- 面板总更新 (refreshLayerPanels 那一趟喊的): 只播快照 ----
// 舞台/控件全在宿主, 页面交的只有一条真值: 这枚记录的 desc (形态 + 姿态 + 取景 + 皮肤/颜色/背景)
// 与目标那一层的原生尺寸 (宿主画取景框要按**输出**比例, 不是舞台比例)。
function updatePosePanel() {
    const t = poseGizmoTarget();
    if (!t) {
        blendUiState.pose = { on: false, desc: null, layerW: 0, layerH: 0 };
        queueBlendUi();
        return;
    }
    const d = t.r.desc;
    const n = nativeSize(t.l.img);
    blendUiState.pose = {
        on: true,
        desc: {
            mesh: Object.assign({}, d.mesh),
            pose: d.pose,
            cam: Object.assign({}, d.cam),
            skin: d.skin,
            color: d.color,
            bg: d.bg,
        },
        layerW: n.w, layerH: n.h,
    };
    queueBlendUi();
}

// ---- 从一张图取姿态 (From image) ----
// 图从**图层**或**工作区图池**里挑 (选图 modal 与特效绑图共用那一格, 见 fx/ui.js 的 openFxMapModal)。
// 关键点 → 骨头角在 js/pose_openpose.js (照参考的解析路, 躯干四肢), DWPose 在后端 /api/pose_estimate。
// 两条来源的载荷不同是有道理的: 图池的字节本来就在服务器上, 只报 id 就够; 图层的像素只活在浏览器里,
// 那张 PNG 必须递过去。
async function poseImageGroups() {
    const groups = [];
    const layerItems = [];
    for (const l of (typeof layers === 'undefined' ? [] : layers)) {
        if (!l || l.isMaskLayer || !l.img) continue;
        let png = null;
        try {
            const src = layerSource(l);        // 这条图层此刻的样子 (decal / 特效 / mask 全折进来)
            const c = document.createElement('canvas');
            c.width = src.width; c.height = src.height;
            c.getContext('2d').drawImage(src, 0, 0);
            png = c.toDataURL('image/png');
        } catch (e) { continue; }
        layerItems.push({ id: 'layer:' + l.id, name: l.name, src: png, ref: { source: 'layer', name: l.name, png } });
    }
    if (layerItems.length) groups.push({ title: 'Layers', items: layerItems });

    // 全量图池: 生成产出与 Original 那些 hidden 条目也是图源 (条带的显示规则不动, 那是另一回事)。
    let pool = typeof stagingItems === 'undefined' ? [] : stagingItems;
    try {
        const js = await (await fetch('/api/staging')).json();
        if (Array.isArray(js.staging)) pool = js.staging;
    } catch (e) { /* 拉不到就用条带那份镜像 */ }
    const stageItems = [];
    for (const s of pool) {
        if (!s || !s.src || s.id === GUIDANCE_CARD_ID) continue;
        stageItems.push({ id: s.id, name: s.name, src: s.src, width: s.width, height: s.height, ref: { source: 'staging', key: s.id, name: s.name } });
    }
    if (stageItems.length) groups.push({ title: 'Workspace', items: stageItems });
    return groups;
}

// 姿态要写在**真 rig** 上: 骨头角是跟静止形的头位置比出来的, 所以装配没回来之前一处都不许改。
// 面板的 pin 已经让 sync 敲过一趟解形, 这里只是等它 —— 顺带把那条失败支路认出来 (warned 且不在
// building = 这一份形态已经放弃过, 不会再自己好了)。
function poseRigReady(t) {
    return new Promise((resolve, reject) => {
        const started = performance.now();
        let kicked = false;
        const tick = () => {
            const e = poseRigFor(t);
            if (e && e.ready && e.rig) return resolve(e);
            if (e && !e.building && e.warned) {
                return reject(new Error('the mannequin could not be assembled — its assets are missing'));
            }
            if (!e && !kicked) { kicked = true; if (typeof render === 'function') render(); }
            if (performance.now() - started > 120000) return reject(new Error('still assembling the mannequin'));
            setTimeout(tick, 100);
        };
        tick();
    });
}

let poseFromImageBusy = false;
async function poseFromImage(ref) {
    const t = poseGizmoTarget();
    if (!t) { setStatus('Open a Pose step first', 'error'); return; }
    if (poseFromImageBusy) return;
    poseFromImageBusy = true;
    setStatus(`Estimating a pose from「${ref.name || 'that image'}」…`);
    try {
        const body = ref.source === 'staging' ? { source: 'staging', id: ref.key } : { source: 'layer', png: ref.png };
        const res = await fetch('/api/pose_estimate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const js = await res.json().catch(() => ({}));
        if (!res.ok || !js.success) throw new Error(js.error || `HTTP ${res.status}`);
        const parsed = poseOpenPoseParse(js.pose);
        if (!parsed) throw new Error('no person found in that image');
        const entry = await poseRigReady(t);
        const pose = poseOpenPoseConvert(parsed, entry.rig);
        if (!pose || !Object.keys(pose.bones).length) throw new Error('those keypoints mapped to no bone');
        // 整只替换 (8.a): 老姿态不留一根骨头, bonePositions 一并清空 —— 一次 undo。
        patchPoseTarget(t, { pose });
        pushHistory('pose-from-image', 'Pose taken from image');
        setStatus(`Pose from「${ref.name}」— ${poseSummary(pose)}, ${parsed.numKeypoints} keypoints (${js.ms || 0}ms)`, 'success');
    } catch (err) {
        setStatus('Pose estimate: ' + (err && err.message ? err.message : err), 'error');
    } finally {
        poseFromImageBusy = false;
    }
}

// 宿主那一格那颗 From image 发 action 进来, 页面开自己的选图 modal (图源与特效绑图共用同一格)。
async function openPoseFromImage() {
    if (!poseGizmoTarget()) { setStatus('Open a Pose step first', 'error'); return; }
    if (poseFromImageBusy) return;
    openFxMapModal(null, null, null, {
        title: 'Pose from an image',
        sub: 'Pick a photo of a person — the mannequin takes that pose and re-bakes onto this layer. Torso, limbs and head: fingers stay straight.',
        groups: await poseImageGroups(),
        hint: 'Nothing to read yet — drop an image into the workspace, or paint a layer first.',
        file: false,
        onPick: poseFromImage,
    });
}
