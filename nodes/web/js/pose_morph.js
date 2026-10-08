// Pose morph —— 主线程这侧的 worker 把手。
//
// 移植自 AHEKOT/ComfyUI_VNCCS_Utils (MIT): web/vnccs_pose_studio.js 的
// getVNCCSSharedMorphWorker / requestStaticMorphModel / modelDataFromMorphMessage 三段的简化版。
// 全页共用一只 worker (morph 包 ~86MB, 每枚 attribute 各拉一份不可接受); 认领按 seq 不按 clientId ——
// 我们这边一个请求就是一个 promise, 没有"广播给全部客户"的那种语义。
// 资产或 worker 起不来 = failed 恒 true, 调用方 (attr/pose.js 的 sync) 必须 fail-soft:
// 保持旧面, 绝不把已经烘好的像素清掉。

const PoseMorph = (() => {
    let worker = null;
    let failed = false;
    let seq = 0;
    const pending = new Map();      // seq -> { resolve, reject, timer }

    function settleAll(type, message) {
        for (const [, task] of pending) {
            clearTimeout(task.timer);
            if (type === 'error') task.reject(new Error(message));
            else task.resolve(message);
        }
        pending.clear();
    }

    function ensureWorker() {
        if (failed) return null;
        if (worker) return worker;
        if (typeof Worker === 'undefined') { failed = true; return null; }
        try {
            worker = new Worker('js/pose_morph_worker.js');
            worker.onmessage = (event) => {
                const message = event.data || {};
                if (message.type === 'error' && message.seq === undefined) {
                    settleAll('error', message.message || 'Pose morph worker error');
                    return;
                }
                const task = pending.get(message.seq);
                if (!task) return;
                pending.delete(message.seq);
                clearTimeout(task.timer);
                if (message.type === 'error') task.reject(new Error(message.message || 'Pose morph solve failed'));
                else task.resolve(message);
            };
            worker.onerror = (event) => {
                failed = true;
                console.warn('[kolid pose] morph worker error:', event.message || event);
                settleAll('error', event.message || String(event));
                try { worker.terminate(); } catch (_) {}
                worker = null;
            };
        } catch (error) {
            failed = true;
            console.warn('[kolid pose] morph worker unavailable:', error);
        }
        return worker;
    }

    // 一趟请求。timeout 给足: 首次要下 37.8MB 资产 + 解压 + 解析, 之后每趟只是解算。
    function request(type, payload, timeoutMs) {
        const w = ensureWorker();
        if (!w) return Promise.reject(new Error('Pose morph worker unavailable'));
        const id = ++seq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error('Timed out while loading or solving the Pose MakeHuman asset'));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            try {
                w.postMessage(Object.assign({ type, seq: id }, payload));
            } catch (error) {
                pending.delete(id);
                clearTimeout(timer);
                reject(error);
            }
        });
    }

    return {
        get failed() { return failed; },
        // params = mesh 7 参 (age/gender/weight/muscle/height/breast_size/firmness + 可选 show_genitals)。
        solve(params, includeStatic) {
            return request('solve', { params: params || {}, includeStatic: !!includeStatic }, 120000);
        },
    };
})();

// worker 消息 → PoseRig.loadData 吃的那只模型数据。照抄参考的
// modelDataFromMorphMessage: staticData.bones (name/parent) 与 bonePositions (每骨 6 个数
// head+tail) 合成带长度的一组骨头; 顶点/uv/indices/skin 原样。
function poseModelDataFromMorphMessage(message) {
    const staticData = message?.staticData;
    const bonePositions = message?.bonePositions;
    if (!staticData || !bonePositions || !message?.vertices) {
        throw new Error('Pose MakeHuman worker returned incomplete model data.');
    }
    const bones = (staticData.bones || []).map((bone, index) => {
        const offset = index * 6;
        const headPos = Array.from(bonePositions.subarray(offset, offset + 3));
        const tailPos = Array.from(bonePositions.subarray(offset + 3, offset + 6));
        const dx = tailPos[0] - headPos[0];
        const dy = tailPos[1] - headPos[1];
        const dz = tailPos[2] - headPos[2];
        return {
            name: bone.name,
            parent: bone.parent || null,
            headPos,
            tailPos,
            length: Math.hypot(dx, dy, dz),
        };
    });
    return {
        vertices: message.vertices,
        uvs: staticData.uvs,
        indices: staticData.indices,
        bones,
        skinIndices: staticData.skinIndices,
        skinWeights: staticData.skinWeights,
        landmarks: message.landmarks || {},
        landmark_indices: message.landmarkIndices || {},
    };
}
