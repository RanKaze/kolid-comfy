// 合成一份最小 .cud 当折图语义的测试夹具：不依赖任何真实工程，专门覆盖 plan 的**每个字段**。
//
// 为什么要有它：真实工程里的 decal 大多绑在视频轨上（`surface: null`），于是 `res:` 资源引用、
// 停用步骤、generator 的 desc/box/baked 这几条分支根本没被走到。夹具把这些一条条摆出来，
// 由 render_plan.py 出 oracle、由 KLayerFold 出被测值，两边逐字段比。
//
// 用法: node tests/layer_fold/fixture.cjs <out.cud>
const fs = require('fs');
const crypto = require('crypto');

function build() {
    const pixel = (seed) => Buffer.from(Array.from({ length: 64 }, (_, i) => (seed * 31 + i * 7) & 0xff));
    const assets = [
        { id: 0, role: 'base', w: 8, h: 8, bytes: pixel(1) },
        { id: 1, role: 'decal', w: 8, h: 8, bytes: pixel(2) },
        { id: 2, role: 'mask', w: 8, h: 8, bytes: pixel(3) },
        { id: 3, role: '3d', w: 8, h: 8, bytes: pixel(4) },
    ];
    for (const a of assets) { a.length = a.bytes.length; a.hash = crypto.createHash('md5').update(a.bytes).digest('hex'); }

    const attributes = [
        // 有面的 decal（覆盖 res: 引用 + frameTrack 空串）
        { id: 'attr_decal', type: 'decal', surface: 1, frameTrack: '' },
        // 停用的 decal：**plan 里必须 enabled:false**（Python 曾经写死 true）
        { id: 'attr_decal_off', type: 'decal', enabled: false, surface: 1, frameTrack: 'trk_x' },
        // 蒙版（role 落到 mask）
        { id: 'attr_mask', type: 'mask', surface: 2 },
        // 特效链：一枚启用一枚停用，都带 params；启用那枚带一张 map 贴图
        {
            id: 'attr_fx', type: 'effects', chain: [
                { type: 'vector_blur', enabled: true, params: { angle: 12, distance: 8, anchor: 'center' }, maps: { map: 'res:' + assets[1].hash } },
                { type: 'tone_map', enabled: false, params: { exposure: 0.5 }, maps: {} },
            ],
        },
        // 生成器三型：带 desc、带 box、ownsGrid、baked 面
        { id: 'attr_text', type: 'text', text: { v: 1, s: 'hello' }, box: { x: 1, y: 2, w: 3, h: 4 }, ownsGrid: true, baked: 3 },
        { id: 'attr_crop', type: 'crop', crop: { x: 0, y: 0, w: 4, h: 4 }, sceneUid: 'sc_1' },
    ];

    const tr = { cx: 0.4, cy: 0.6, w: 0.5, h: 0.5, rotation: 0.25 };
    const layers = [
        // [0] 是最上面那层（.cud 顺序）——含全部四种 step
        {
            id: 1, name: 'all-kinds', visible: true, stack: 'layer', buffer: 0, image: null,
            transform: tr, attrs: ['attr_decal', 'attr_mask', 'attr_fx', 'attr_text', 'attr_crop'],
        },
        // 停用步骤 + 隐藏层 + 无 base（null）+ 老档数字 image
        {
            id: 2, name: 'disabled+hidden', visible: false, stack: 'layer', buffer: null, image: 1,
            transform: { cx: 0.5, cy: 0.5, w: 1, h: 1, rotation: 0 }, attrs: ['attr_decal_off'],
        },
        // Stash（capture:'below'）+ guidance 栈 + 极端 transform
        {
            id: 3, name: 'stash-guidance', visible: true, stack: 'guidance', stash: true, buffer: null, image: null,
            transform: { cx: 0, cy: 1, w: 2, h: 0.25, rotation: -1.5 }, attrs: ['attr_fx'],
        },
    ];

    return {
        format: 'cud', version: 6, generator: 'test', created: '2026-10-27T00:00:00Z',
        canvas: { w: 64, h: 32 },
        video: {
            fps: 24,
            clips: [{ id: 'cl_seg', kind: 'layer', layerKey: 'set_a', start: 2, duration: 3, offset: 0.5, srcDuration: 9 }],
            tracks: [],
        },
        layers,
        layerSets: [{ key: 'set_a', layers, selectedId: 1 }],
        activeLayerSet: 'set_a',
        attributes,
        assets: assets.map((a) => ({ id: a.id, role: a.role, w: a.w, h: a.h, length: a.length, hash: a.hash })),
        staging: [],
    };
}

function write(p) {
    const head = build();
    const blobs = [];
    // 顺序必须与 head.assets 一致（read_cud 按 length 顺序切）
    const pixel = (seed) => Buffer.from(Array.from({ length: 64 }, (_, i) => (seed * 31 + i * 7) & 0xff));
    [1, 2, 3, 4].forEach((s) => blobs.push(pixel(s)));
    const json = Buffer.from(JSON.stringify(head), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(json.length, 0);
    fs.writeFileSync(p, Buffer.concat([Buffer.from('CUD1', 'latin1'), len, json, ...blobs]));
    return p;
}

if (require.main === module) {
    const out = process.argv[2];
    if (!out) { console.error('用法: node tests/layer_fold/fixture.cjs <out.cud>'); process.exit(2); }
    write(out);
    console.log('fixture -> ' + out);
}
module.exports = { write };
