// Pose 估计的前端那一半 —— 后端 (/api/pose_estimate) 把一张图喂给 DWPose, 原样带回一个 POSE_KEYPOINT
// 字典; 这里把那串 2D 关键点解析开, 再把每条"骨线"在图像里的角差写成人形的骨头角。
// 移植自 AHEKOT/ComfyUI_VNCCS_Utils (MIT) 的 web/vnccs_openpose_import.js 里的**解析路** (不是 IK 那条):
//   每段关键点连线求 2D 角 (像素 Y↓ 翻成 MH 的 Y↑) → 与该骨头在 rig 静止形里的 2D 角
//   (userData.headPos 的 X/Y 投影) 求差, 子段再减去父段; 差角按身体朝向角拆成两个分量 ——
//   Z (额状面, 正面看得见的那支) 乘 cos, X (矢状面, 转身以后才露出来的) 乘 sin。
// 没有 IK、没有手指、没有脸 —— 3.a 的拍板。脊柱那一段的差照参考均给 spine_01/02/03。
//
// 与参考的两处不同都是有意的:
//   · 取**关键点跨度最大**的那个人, 不是 people[0] —— 多人合照里第 0 个常常是背景里的小人。
//   · 产出的形状直接就是 desc.pose ({bones, bonePositions, modelRotation}), 调用方整只替换。
// 关键点里只有角度可用, 画布尺寸与 padding 一概不参与, 所以 1920×1080 与 512×512 摆出同一个姿态。
//
// 一处实测到的既有余量, 别当 bug 改: OpenPose 的 neck 点在第七颈椎, 而 rig 的 clavicle 头在胸骨
// 切迹 —— 同一条"颈→肩"线在两张框架里差 19.4°。所以静止形回喂时 clavicle_r=+19.4/upperarm_r=-19.4
// (实测), 层级累加到手臂的世界角正好抵消为 0; 小腿与腿根则读回 0。改任何一头的框架都得两头一起改。

const POSE_OP_COCO18 = [
    'nose', 'neck',
    'r_shoulder', 'r_elbow', 'r_wrist',
    'l_shoulder', 'l_elbow', 'l_wrist',
    'r_hip', 'r_knee', 'r_ankle',
    'l_hip', 'l_knee', 'l_ankle',
    'r_eye', 'l_eye', 'r_ear', 'l_ear',
];

const POSE_OP_BODY25 = [
    'nose', 'neck',
    'r_shoulder', 'r_elbow', 'r_wrist',
    'l_shoulder', 'l_elbow', 'l_wrist',
    'mid_hip',
    'r_hip', 'r_knee', 'r_ankle',
    'l_hip', 'l_knee', 'l_ankle',
    'r_eye', 'l_eye', 'r_ear', 'l_ear',
];

// OpenPose 段 → MakeHuman 骨头。mhBone 是被写角的那根, parentSegment 是求相对角时的参照段。
const POSE_OP_SEGMENTS = [
    { parent: 'mid_hip', child: 'neck', mhBones: ['spine_01', 'spine_02', 'spine_03'], isSpine: true },
    { parent: 'neck', child: 'nose', mhBone: 'neck_01', parentSegment: { parent: 'mid_hip', child: 'neck' } },

    { parent: 'neck', child: 'r_shoulder', mhBone: 'clavicle_r', parentSegment: { parent: 'mid_hip', child: 'neck' } },
    { parent: 'r_shoulder', child: 'r_elbow', mhBone: 'upperarm_r', parentSegment: { parent: 'neck', child: 'r_shoulder' } },
    { parent: 'r_elbow', child: 'r_wrist', mhBone: 'lowerarm_r', parentSegment: { parent: 'r_shoulder', child: 'r_elbow' } },

    { parent: 'neck', child: 'l_shoulder', mhBone: 'clavicle_l', parentSegment: { parent: 'mid_hip', child: 'neck' } },
    { parent: 'l_shoulder', child: 'l_elbow', mhBone: 'upperarm_l', parentSegment: { parent: 'neck', child: 'l_shoulder' } },
    { parent: 'l_elbow', child: 'l_wrist', mhBone: 'lowerarm_l', parentSegment: { parent: 'l_shoulder', child: 'l_elbow' } },

    { parent: 'r_hip', child: 'r_knee', mhBone: 'thigh_r', parentSegment: { parent: 'mid_hip', child: 'neck' } },
    { parent: 'r_knee', child: 'r_ankle', mhBone: 'calf_r', parentSegment: { parent: 'r_hip', child: 'r_knee' } },

    { parent: 'l_hip', child: 'l_knee', mhBone: 'thigh_l', parentSegment: { parent: 'mid_hip', child: 'neck' } },
    { parent: 'l_knee', child: 'l_ankle', mhBone: 'calf_l', parentSegment: { parent: 'l_hip', child: 'l_knee' } },
];

// 静止形的"指向"由子骨的头决定 —— 只列上面用到的那些。
const POSE_OP_BONE_CHILD = {
    spine_01: 'spine_02',
    spine_02: 'spine_03',
    spine_03: 'neck_01',
    neck_01: 'head',
    clavicle_l: 'upperarm_l',
    upperarm_l: 'lowerarm_l',
    lowerarm_l: 'hand_l',
    clavicle_r: 'upperarm_r',
    upperarm_r: 'lowerarm_r',
    lowerarm_r: 'hand_r',
    thigh_l: 'calf_l',
    calf_l: 'foot_l',
    thigh_r: 'calf_r',
    calf_r: 'foot_r',
};

const POSE_OP_CONF = 0.1;
const POSE_OP_RAD2DEG = 180 / Math.PI;

// DWPose 写出的置信度只有 1.0 / 0.0 (点在不在), 0.1 这道闸照参考留着 —— 别的 OpenPose
// 产物 (文件导入、BODY_25 原生) 带真分数, 同一个口要能扛。
function poseOpJoint(joints, name) {
    const j = joints[name];
    return j && j.c >= POSE_OP_CONF ? j : null;
}

// 多人里挑跨度最大的那个 (见文件头的偏差说明)。跨度 = 可信关键点包围盒的面积。
function poseOpLargestPerson(people) {
    let best = null;
    let bestArea = 0;
    for (const person of people) {
        const kp = person && person.pose_keypoints_2d;
        if (!kp || kp.length < 17 * 3) continue;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i * 3 < kp.length; i++) {
            const c = kp[i * 3 + 2];
            if (c < POSE_OP_CONF) continue;
            const x = kp[i * 3], y = kp[i * 3 + 1];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
        if (!Number.isFinite(minX)) continue;
        const area = (maxX - minX) * (maxY - minY);
        if (area > bestArea) { bestArea = area; best = person; }
    }
    return best;
}

// POSE_KEYPOINT 字典 → { joints, source }。认不出人就回 null。
function poseOpenPoseParse(data) {
    const people = data && Array.isArray(data.people) ? data.people : [];
    if (!people.length) return null;

    const person = poseOpLargestPerson(people);
    if (!person) return null;
    const kp = person.pose_keypoints_2d;
    const numKeypoints = Math.floor(kp.length / 3);
    // BODY_25 在 index 8 处带现成的 mid_hip; COCO-18 没有,  hips 从 8 开始。
    const nameMap = numKeypoints >= 19 ? POSE_OP_BODY25 : POSE_OP_COCO18;

    const joints = {};
    const usable = Math.min(numKeypoints, nameMap.length);
    for (let i = 0; i < usable; i++) {
        joints[nameMap[i]] = { x: kp[i * 3], y: kp[i * 3 + 1], c: kp[i * 3 + 2] };
    }

    if (!joints.mid_hip && joints.l_hip && joints.r_hip
            && joints.l_hip.c > POSE_OP_CONF && joints.r_hip.c > POSE_OP_CONF) {
        joints.mid_hip = {
            x: (joints.l_hip.x + joints.r_hip.x) / 2,
            y: (joints.l_hip.y + joints.r_hip.y) / 2,
            c: Math.min(joints.l_hip.c, joints.r_hip.c),
        };
    }
    if (!joints.neck) {
        const rs = poseOpJoint(joints, 'r_shoulder');
        const ls = poseOpJoint(joints, 'l_shoulder');
        if (rs && ls) {
            joints.neck = { x: (rs.x + ls.x) / 2, y: (rs.y + ls.y) / 2, c: Math.min(rs.c, ls.c) };
        }
    }
    return { joints, numKeypoints, format: nameMap === POSE_OP_BODY25 ? 'BODY_25' : 'COCO-18' };
}

// 图像里一段骨线的角 (像素 Y↓ → MH Y↑)。任一端不可信就回 null, 调用方跳过这一根骨头。
function poseOpAngle(joints, parentName, childName) {
    const p = poseOpJoint(joints, parentName);
    const c = poseOpJoint(joints, childName);
    if (!p || !c) return null;
    return Math.atan2(-(c.y - p.y), c.x - p.x);
}

// rig 静止形里同一根骨头的角 —— 头连到子骨的头, 只取 X/Y (正投影)。
function poseOpRestAngle(bones, boneName) {
    const bone = bones[boneName];
    if (!bone) return null;
    const childName = POSE_OP_BONE_CHILD[boneName];
    const child = childName && bones[childName];
    if (!child) return null;
    const head = bone.userData && bone.userData.headPos;
    const tail = child.userData && child.userData.headPos;
    if (!head || !tail) return null;
    return Math.atan2(tail[1] - head[1], tail[0] - head[0]);
}

function poseOpNormalize(a) {
    let v = a;
    while (v > Math.PI) v -= 2 * Math.PI;
    while (v < -Math.PI) v += 2 * Math.PI;
    return v;
}

// 参照段落在这条链的哪根骨头上 —— 查的是段表本身 (参考的 _findMhBoneForSegment 原样), 脊柱那段
// 用链顶 spine_03 (neck 就挂在它上面)。传进来的只是 {parent, child} 那对关节名, 别处问不出来。
function poseOpBoneForSegment(seg) {
    for (const s of POSE_OP_SEGMENTS) {
        if (s.parent === seg.parent && s.child === seg.child) {
            if (s.isSpine) return 'spine_03';
            return s.mhBone;
        }
    }
    return null;
}

// 躯干那一整条 (mid_hip→neck) 的差角, 照参考均给三节脊柱。
function poseOpSpine(joints, bones, out) {
    const op = poseOpAngle(joints, 'mid_hip', 'neck');
    if (op === null) return;
    const s1 = bones.spine_01;
    const neck = bones.neck_01;
    if (!s1 || !neck) return;
    const a = s1.userData.headPos;
    const b = neck.userData.headPos;
    const rest = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const per = poseOpNormalize(op - rest) * POSE_OP_RAD2DEG / 3;
    for (const name of ['spine_01', 'spine_02', 'spine_03']) out[name] = [0, 0, per];
}

// 背对镜头的粗判: 左右肩在图像里的先后 (OpenPose 的 r/l 是被摄者自己的左右), 再用鼻子相对
// 颈的横向偏移估转过去的量。整只人形因此绕 Y 转, 后面的每根骨头再把差角按这个转角拆分量。
function poseOpBodyYRotation(joints) {
    let facingAway = false;
    const rs = poseOpJoint(joints, 'r_shoulder');
    const ls = poseOpJoint(joints, 'l_shoulder');
    if (rs && ls) facingAway = rs.x > ls.x;

    let noseOffset = 0;
    const nose = poseOpJoint(joints, 'nose');
    const neck = poseOpJoint(joints, 'neck');
    if (nose && neck) {
        const scale = rs && ls ? Math.abs(ls.x - rs.x) : 100;
        if (scale > 10) noseOffset = (nose.x - neck.x) / scale;
    }
    return facingAway ? 180 - noseOffset * 50 : noseOffset * 90;
}

// 解析结果 + 一只就绪的 rig → desc.pose 那一份。rig 的骨头位置是静止形的权威, 所以必须在
// 装配完成 (形态解好) 之后调用; 姿态与形态无关的那条路 (拖滑块) 会重烤, 不影响这里。
function poseOpenPoseConvert(parsed, rig) {
    if (!parsed || !parsed.joints || !rig || !rig.bones) return null;
    const joints = parsed.joints;
    const bones = {};
    const modelRotation = [0, 0, 0];

    // 胯线的倾斜 → 整只 Z 转。左右胯谁高在背身时会翻 180°, 所以折进 [-90, 90] 只留倾斜。
    const lh = poseOpJoint(joints, 'l_hip');
    const rh = poseOpJoint(joints, 'r_hip');
    if (lh && rh) {
        let hip = Math.atan2(-(lh.y - rh.y), lh.x - rh.x) * POSE_OP_RAD2DEG;
        if (hip > 90) hip -= 180;
        if (hip < -90) hip += 180;
        if (Math.abs(hip) > 2) modelRotation[2] = hip;
    }

    const bodyYRot = poseOpBodyYRotation(joints);
    const facingAway = Math.abs(bodyYRot) > 90;
    const bodyYRad = bodyYRot * Math.PI / 180;
    if (Math.abs(bodyYRot) > 3) modelRotation[1] = bodyYRot;

    for (const seg of POSE_OP_SEGMENTS) {
        if (seg.isSpine) { poseOpSpine(joints, rig.bones, bones); continue; }

        const op = poseOpAngle(joints, seg.parent, seg.child);
        if (op === null) continue;
        const rest = poseOpRestAngle(rig.bones, seg.mhBone);
        if (rest === null) continue;

        let delta;
        if (seg.parentSegment) {
            const parentOp = poseOpAngle(joints, seg.parentSegment.parent, seg.parentSegment.child);
            if (parentOp === null) continue;
            const parentBone = poseOpBoneForSegment(seg.parentSegment);
            const parentRest = parentBone ? poseOpRestAngle(rig.bones, parentBone) : null;
            if (parentRest === null) continue;
            delta = poseOpNormalize(poseOpNormalize(op - parentOp) - poseOpNormalize(rest - parentRest));
        } else {
            delta = poseOpNormalize(op - rest);
        }

        const deltaDeg = delta * POSE_OP_RAD2DEG;
        bones[seg.mhBone] = [deltaDeg * Math.sin(bodyYRad), 0, deltaDeg * Math.cos(bodyYRad)];
    }

    // 眼线的倾斜 → 头的 Z 转 (整只已经胯线转过一次, 这里只管头自己)。
    const le = poseOpJoint(joints, 'l_eye');
    const re = poseOpJoint(joints, 'r_eye');
    if (le && re) {
        const eye = Math.atan2(-(le.y - re.y), le.x - re.x) * POSE_OP_RAD2DEG;
        if (Math.abs(eye) > 2) bones.head = [0, 0, eye];
    }
    // 背身时头得跟着转回来对上身体; 脸的 70 点不参与 (3.a), 所以正身时头的 Y 保持 0。
    if (facingAway) {
        const head = bones.head || [0, 0, 0];
        head[1] = -(180 - bodyYRot);
        bones.head = head;
    }

    return { bones, bonePositions: {}, modelRotation };
}
