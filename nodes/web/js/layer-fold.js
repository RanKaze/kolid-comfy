// ==================== 折图语义编译器（KLayerFold）====================
// 折图 = 把一个图层内部的条带（base + decal/mask/chain/generator）压成一张面。它有两个半：
//   **语义**（这条条带长什么样）与**执行**（把条带刷成像素）。
// 执行早就有一个模块了 —— `js/compositor.js` 的 `foldLayer`（吃 plan 的 strip，出 {src|tex}）。
// 缺的是语义这一半：在此之前**只有 Python 会造 plan**（`nodes/workbench/render_plan.py`），
// 浏览器侧一个都没有，于是线上走 `render()+layerItem()` 自己折一遍，两份语义靠像素比对保鲜。
//
// 这个文件补的就是缺失的那一半：`layers → plan`，纯数据、无副作用。
//   输入：页面的图层对象数组（只读，不写回）+ `env`（四个查询函数，见下）
//   产物：`{ v, layers, resources }` —— `layers` **自底向上**，与契约 §2.1/§2.2 逐字段一致
//   不做：像素、DOM、全局变量、tracks/frame/grid/t（这些由顶层调用方补，见 docs/render_plan.md §2.3.1/2.4）
//
// env 契约（页面上是 `foldEnvPage()`，测试里是现搭的；缺项一律退回"没有"）:
//   records(layer) → [record]       一条条带的属性记录（页面默认 attrRecordsOf）
//   res(ref, role) → {resource,…}   资产引用 → plan 资源 ID（默认 undefined ⇒ 一切 ref 变 null）
//   base(layer) → ref               这一层的底像素**用什么引用**。默认 `l.buffer ?? l.image`（存档口径：
//                                   资源是内容哈希）。页面运行时底像素是内存里的画布、没有 hash，于是
//                                   这一项换成一块"活资源"（见 blend_node.html 的 foldLiveRef）——
//                                   同一份 plan schema，两种解析环境。
//   timeMap(layer) → object|null    该层所属 Layer 段在时间线上的位置
//   transform(layer) → object       图层变换（默认读 l.transform）
//   stack(layer) → 'work'|'guidance'（默认按 l.stack 映射，与 .cud 的 layer/guidance 同义）
//   opacity(layer) → 0..1           图层不透明度（默认读 l.opacity，缺省 1）
//
// 与 Python 编译器的两处**有意**差异（都以契约为准，不以求齐旧行为为准）:
//   1. step 级 `enabled`：Python 写死 `True`，这里写 `rec.enabled !== false`。
//      契约 §2.2 三处都写着 `"enabled": true`，而合成器 `foldLayer` 按 `enabled === false` 跳过 ——
//      停用的 decal/mask/generator 若被写成 true，plan 一侧会照旧出墨。Python 那侧同步修了。
//   2. `opacity`：Python 写死 `1`（.cud 不存图层不透明度），这里取真值。
//      契约 §2.1 说它是"编辑器图层行的 Opacity 滑杆值"，缺省 1。
//      真值只影响"页面此刻的 plan 与文件里的 plan 是否一致"，不影响折图本身（条目上的 opacity 由合成器乘）。
const KLayerFold = (function () {
    const VERSION = 1;
    // .cud 的 stack 名 → plan 的 stack 名（与 render_plan.py 的 _STACK 同一张表）
    const STACK = { layer: 'work', guidance: 'guidance' };
    // stash 与 image/mask 同一档：它是条带上一枚普通的**面**（那一层以下所有图层的合成，每次 render
    // 现抄）。它曾经是一种图层、由 `capture:'below'` 单独交进 plan —— 那一岔连同图层种类一起删了。
    // 少了这一格，它会被下面的 else 当成 generator：贴片不叠、还没有报错。
    const SURFACE = { image: 1, mask: 1, stash: 1 };
    // P0 改名：这一枚以前叫 decal。**只用这一处归一**，plan 里永远不出现 decal —— 于是 JS 与
    // Python 两个编译器产出的 step.type 仍逐字段相等（render_plan.py 的 steps_of 里做同一件事）。
    // 放在折叠这一层而不是靠调用方先改名：喂进来的可能是老档记录、老快照，漏一次就是"贴片被当成
    // generator 走 baked 面"，症状是贴片不叠、还没有报错。
    function canonType(t) { return t === 'decal' ? 'image' : t; }

    function num(v, d) {
        const n = typeof v === 'number' ? v : parseFloat(v);
        return Number.isFinite(n) ? n : d;
    }

    /** 契约 §3.2：缺省中心 0.5/0.5、满幅 1×1、不旋转；数字一律归一成 float。 */
    function transformOf(tr) {
        tr = tr || {};
        return {
            cx: num(tr.cx, 0.5), cy: num(tr.cy, 0.5),
            w: num(tr.w, 1), h: num(tr.h, 1),
            rotation: num(tr.rotation, 0),
        };
    }

    function opacityOf(l, env) {
        if (env.opacity) {
            const a = num(env.opacity(l), 1);
            return Math.min(1, Math.max(0, a));
        }
        const raw = l.opacity;
        if (raw === undefined || raw === null) return 1;
        const a = num(raw, 1);
        return Math.min(1, Math.max(0, a));
    }

    /** 一条属性记录 → 一枚 step（三种 kind，与 attr/core.js 的 ATTR_KINDS 一一对应）。
     *  顺序与 Python steps_of 相同：effects → decal/mask → 其余一律 generator。 */
    function stepOf(rec, env, ctx) {
        const type = canonType(rec && rec.type);
        if (!type) return null;
        const enabled = rec.enabled !== false;

        if (type === 'effects') {
            return { kind: 'chain', type: 'effects', enabled, chain: chainOf(rec, env, ctx) };
        }
        if (SURFACE[type]) {
            return {
                kind: 'surface', type, enabled,
                surface: refOf(rec.surface, type, env, ctx),
                frameTrack: rec.frameTrack || '',
            };
        }
        // 生成器：描述符整只带走，plan 不解释它（契约 §2.2 "params/desc 不展开语义"）
        let desc = rec.desc;
        if (desc === undefined || desc === null) {
            desc = rec[type] || rec.text || rec.dir || rec.scene;
        }
        return {
            kind: 'generator', type, enabled,
            desc: desc === undefined ? null : desc,
            box: rec.box || null,
            ownsGrid: !!rec.ownsGrid,
            baked: refOf(rec.baked !== undefined && rec.baked !== null ? rec.baked : rec.image, type, env, ctx),
            sceneUid: rec.sceneUid || null,
        };
    }

    /** 一条特效链 → plan 的 chain。停用的特效写 `enabled:false`（不删，参数还在）。 */
    function chainOf(rec, env, ctx) {
        const src = (env.chain ? env.chain(rec) : null) || rec.chain || [];
        const out = [];
        for (const e of src) {
            if (!e || !e.type) continue;
            out.push({
                type: e.type,
                enabled: e.enabled !== false,
                params: e.params || {},
                maps: mapsOf(e, env, ctx),
            });
        }
        return out;
    }

    /** 特效的贴图槽：`{ map: 'res:<hash>' }` —— 已经是 plan ID 的原样留，资产引用交给 env.res。 */
    function mapsOf(e, env, ctx) {
        const src = e.maps || {};
        const out = {};
        for (const k in src) {
            const v = src[k];
            if (typeof v === 'string' && v.indexOf('res:') === 0) { out[k] = v; continue; }
            const ref = refOf(v, k, env, ctx);
            if (ref) out[k] = ref.resource;
        }
        return out;
    }

    /** 资产引用 → `{ resource: 'res:<hash>' }`，顺手把资源登记进这一趟的 resources 表。
     *  env.res 返回字符串（就是 res id）或资源记录（`{ id: 'res:…', kind, uri, … }`）都认；
     *  给不出就 null（契约允许 null）。
     *
     *  "已经是资源记录"的判据必须**同时**满足两条，缺一条就会把内存像素吞掉：
     *    · 不是 DOM 节点（`nodeType` 是数字）—— 底像素、贴片、蒙版在页面上就是 `<img>` / `<canvas>`；
     *    · `resource` / `id` 是**非空**字符串 —— 每个 HTML 元素都天生带 `id: ''`，一条空串被当成
     *      资源号，`base` 就成了 `{ resource: '' }`，合成器那边 `pl.base.resource` 为假 ⇒ 底像素
     *      整张丢掉（症状：带 mask/特效的层只剩条带画的，自己的图一片全黑）。
     *  落不下去的记录与内存像素都交给 `env.res` —— 活资源那一趟在那里登记 `live:<n>`。 */
    function refOf(v, role, env, ctx) {
        if (v === null || v === undefined || v === '') return null;
        if (typeof v === 'object' && typeof v.nodeType !== 'number') {
            const rid = (typeof v.resource === 'string' && v.resource)
                || (typeof v.id === 'string' && v.id) || '';
            if (rid) { note(ctx, v); return { resource: rid }; }
        }
        const hit = env.res ? env.res(v, role) : null;
        if (!hit) return null;
        if (typeof hit === 'string') return { resource: hit };
        const rid = hit.resource || hit.id;
        if (!rid) return null;
        note(ctx, hit);
        return { resource: rid };
    }

    /** 登记一条资源，字段集与契约 §2.3 / render_plan.py 的 res_ref 完全一致
     *  （`resource` 是引用侧的东西，不进资源表）。 */
    function note(ctx, rec) {
        const rid = rec && (rec.resource || rec.id);
        if (!ctx || !ctx.res || !rid || ctx.res.has(rid)) return;
        ctx.res.set(rid, {
            id: rid,
            kind: rec.kind || 'image',
            uri: rec.uri || null,
            w: (rec.w === undefined ? null : rec.w),
            h: (rec.h === undefined ? null : rec.h),
            role: (rec.role === undefined ? null : rec.role),
            assetId: (rec.assetId === undefined ? null : rec.assetId),
        });
    }

    /** 一层 → plan 的 layer（契约 §2.1）。这一层由 strip 自说自话地叠出来：从小一张干净的目标画起，
     *  条带上每一枚 image 都是一次 source-over —— 于是**第一张图**就是最下面那张，位置该怎么事关
     *  结果，正是 UI 上"拖一枚 attribute"要的那个语义。底位（`role:'base'`）不再有任何特殊优待。 */
    function layerOf(l, env, ctx) {
        if (!l) return null;
        const tr = env.transform ? env.transform(l) : l.transform;
        const stackName = env.stack ? env.stack(l) : (STACK[l.stack || 'layer'] || 'work');
        return {
            id: l.id,
            name: l.name || '',
            // 底位已经变成条带上普通的一步（`strip` 里就有它），所以这里**永远没有单独铺的底**。
            // 合成器照这个约定来：从一张干净的目标画起，strip 上第一张图自然就是最下面那张。
            // 留着这个键还给 Python 那条 `render_plan.py` 对着同一个 schema 写 plan（见那里的注）。
            base: null,
            stack: stackName === 'guidance' ? 'guidance' : 'work',
            visible: l.visible !== false,
            opacity: opacityOf(l, env),
            blend: 'source-over',
            // `capture` 只为旧 Stash **图层**存在（"底像素换成以下所有层的合成"）。Stash 现在是条带上
            // 一枚普通的面，那一岔连同图层种类一起删了，所以这里恒 null —— 键留着是为了 plan schema
            // 不变（Python 那一侧 render_plan.py 同样恒为 None）。
            capture: null,
            transform: transformOf(tr),
            strip: stripOf(l, env, ctx),
            timeMap: (env.timeMap ? env.timeMap(l) : null) || null,
        };
    }

    function stripOf(l, env, ctx) {
        const recs = env.records ? (env.records(l) || []) : recordsFromRegistry(l);
        const out = [];
        for (const rec of recs) {
            const st = stepOf(rec, env, ctx);
            if (st) out.push(st);
        }
        return out;
    }

    function recordsFromRegistry(l) {
        // 条带上**每一枚**记录都是一步 —— 底位也包括在内（`role` 只说它是这一层自己的图，不说位置）。
        return (typeof attrRecordsOf === 'function') ? attrRecordsOf(l) : [];
    }

    /** **主入口**：图层数组（.cud 顺序，[0] 是最上面那层）→ plan 的 layers（自底向上）+ 资源表。 */
    function compile(layers, env) {
        env = env || {};
        const ctx = { res: new Map() };
        const out = [];
        for (const l of (layers || [])) {
            const pl = layerOf(l, env, ctx);
            if (pl) out.push(pl);
        }
        out.reverse();                       // 契约 §3.1：plan 里自底向上
        const resources = Array.from(ctx.res.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return { v: VERSION, layers: out, resources };
    }

    /** 记账（与 render_plan.py 的 _stats 同口径），探针与测试用。 */
    function stats(plan) {
        const layers = (plan && plan.layers) || [];
        const kinds = {};
        let steps = 0;
        for (const l of layers) {
            for (const s of l.strip || []) {
                steps++;
                kinds[s.type] = (kinds[s.type] | 0) + 1;
            }
        }
        return { layers: layers.length, steps, kinds, resources: ((plan && plan.resources) || []).length };
    }

    /** 人读的一行摘要（诊断日志用，不参与渲染）。 */
    function describe(plan) {
        const st = stats(plan);
        const kk = Object.keys(st.kinds).sort().map(k => k + '×' + st.kinds[k]).join(' ');
        return st.layers + ' layer(s) / ' + st.steps + ' step(s) / ' + st.resources + ' res  ' + kk;
    }

    return { version: VERSION, compile, layer: layerOf, step: stepOf, stats, describe, transformOf };
})();
if (typeof window !== 'undefined') window.KLayerFold = KLayerFold;
