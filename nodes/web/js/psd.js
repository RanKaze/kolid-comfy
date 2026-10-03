// js/psd.js —— PSD (Photoshop 文档) 的只读导入解析器,零依赖。
// 只为 blend_node 的 Import 服务:把一份 .psd 拆成「图层数组 + 合成图」,交给调用方建图层。
// 范围 (Adobe PSD 规范的子集,按"导入像素"需要多少读多少):
//   * 版本 1 (PSD);PSB (version 2, >30000px 的大文档) 拒绝并说明 —— 它的长度字段全是 8 字节,
//     不是"再读几个字节"的事。
//   * 颜色模式:RGB (3) 与灰度 (1);CMYK/索引等直接报"不支持的颜色模式",绝不静默出脏色。
//   * 位深:8/16 位 (16 位折成 8 位 = 值/257);32 位浮点拒绝。
//   * 通道压缩:0 原始字节、1 PackBits (RLE,Photoshop 默认)、2 zlib、3 zlib+预测 —— zlib 走浏览器
//     自带的 DecompressionStream,预测行 = 逐字节前缀和,8/16 位同一句。
//   * 图层名:'luni' (Unicode) 优先,退回 Pascal 短名;分组标记 ('lsct') 与无像素通道的图层
//     (调整层等) 跳过并计数 —— 导入的是像素,不是 Photoshop 的结构。组的成员按存储序平铺导入。
//   * 16/32 位文档的 LayerInfo 是空的,真图层在 LMI 的 'Lr16'/'Lr32' 附加块里 —— 两条路都认。
//   * 图层可见性:flags bit1 (0x02) = 隐藏。
//   * 合成图 (文件尾的合并图像) 也解出来,图层全空时调用方拿它当独一份。注意合并 RLE 的行数表
//     是**全通道一张表** (channels×height 个 u16),与分层通道"各自带表"不同。
// 输出坐标全部是 PSD 文档像素 (top-left 原系,y 向下),调用方自己折算成 transform 分数。
(function () {
    'use strict';

    class PsdError extends Error {}

    // --- 基础读取:全部大端。截断错误一律带位置与需求量 —— 导入排障全靠它 ---
    class Reader {
        constructor(view) { this.view = view; this.pos = 0; }
        get left() { return this.view.byteLength - this.pos; }
        u8() { if (this.left < 1) throw new PsdError('file is truncated (u8 at ' + this.pos + ')'); return this.view.getUint8(this.pos++); }
        u16() { if (this.left < 2) throw new PsdError('file is truncated (u16 at ' + this.pos + ')'); const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
        i16() { if (this.left < 2) throw new PsdError('file is truncated (i16 at ' + this.pos + ')'); const v = this.view.getInt16(this.pos); this.pos += 2; return v; }
        u32() { if (this.left < 4) throw new PsdError('file is truncated (u32 at ' + this.pos + ')'); const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
        i32() { if (this.left < 4) throw new PsdError('file is truncated (i32 at ' + this.pos + ')'); const v = this.view.getInt32(this.pos); this.pos += 4; return v; }
        skip(n) {
            if (n < 0 || n > this.left) throw new PsdError('file is truncated (skip ' + n + ' at ' + this.pos + ', ' + this.left + ' left)');
            this.pos += n;
        }
        bytes(n) {
            if (n < 0 || n > this.left) throw new PsdError('file is truncated (read ' + n + ' at ' + this.pos + ', ' + this.left + ' left)');
            const b = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, n);
            this.pos += n;
            return b;
        }
        ascii(n) {
            let s = '';
            for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
            return s;
        }
    }

    // PackBits (Apple RLE):n>=128 的 (n-256) = 后面 |n|-1 个字节重复,n 0..127 = 后面 n+1 个直拷。
    function unpackBits(src, off, end, outLen) {
        const out = new Uint8Array(outLen);
        let o = 0;
        while (o < outLen) {
            if (off >= end) throw new PsdError('file is truncated (RLE)');
            const n = src[off++];
            if (n < 128) {
                const run = n + 1;
                if (off + run > end || o + run > outLen) throw new PsdError('file is truncated (RLE)');
                out.set(src.subarray(off, off + run), o);
                off += run; o += run;
            } else if (n > 128) {
                const run = 257 - n;
                if (off >= end || o + run > outLen) throw new PsdError('file is truncated (RLE)');
                out.fill(src[off++], o, o + run);
                o += run;
            } // 128 = no-op
        }
        return { out, off };
    }

    async function inflate(bytes) {
        if (typeof DecompressionStream === 'undefined') {
            throw new PsdError('this browser cannot inflate zip-compressed layers (DecompressionStream missing)');
        }
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    // zip 的预测复原:每行独立、按**样本**增量 (8 位 = 逐字节;16 位 = 逐 BE u16)。zip 通道不写
    // filter 字节 —— 解出来直接就是差分面 (psd-tools decode_prediction 同款)。
    function unpredict(h, w, bps, data) {
        const rowBytes = w * bps;
        if (data.length < h * rowBytes) throw new PsdError('file is truncated (zip)');
        const out = new Uint8Array(h * rowBytes);
        for (let r = 0; r < h; r++) {
            const acc = r * rowBytes;
            if (bps === 1) {
                out[acc] = data[acc];
                for (let i = 1; i < rowBytes; i++) out[acc + i] = (out[acc + i - 1] + data[acc + i]) & 0xff;
            } else {
                let prev = 0;
                for (let i = 0; i < w; i++) {
                    prev = (prev + (data[acc + i * 2] * 256 + data[acc + i * 2 + 1])) & 0xffff;
                    out[acc + i * 2] = prev >> 8;
                    out[acc + i * 2 + 1] = prev & 0xff;
                }
            }
        }
        return out;
    }

    function be16To8(src, samples) {
        // 16 → 8 截断高位字节 (PIL 同款);四舍五入会跟所有参考实现差出 ±1
        const out = new Uint8Array(samples);
        for (let i = 0; i < samples; i++) out[i] = src[i * 2];
        return out;
    }

    function makeCanvas(w, h) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        return c;
    }

    // 通道平面字典 → 图层 tile 画布。缺 RGB 任何一份 = 不是像素图层 (调整层/分组标记),回 null。
    function planesToCanvas(planes, w, h, mode) {
        if (w < 1 || h < 1) return null;
        const c = makeCanvas(w, h);
        const g = c.getContext('2d');
        const img = g.createImageData(w, h);
        const px = img.data;
        const get = p => (p && p.length === w * h) ? p : null;
        if (mode === 1) {                                     // 灰度:ch0 = 明度
            const v = get(planes[0]);
            if (!v) return null;
            const a = get(planes[-1]);
            for (let i = 0; i < w * h; i++) {
                px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v[i];
                px[i * 4 + 3] = a ? a[i] : 255;
            }
        } else {                                              // RGB:ch0/1/2 = R/G/B
            const r = get(planes[0]), gg = get(planes[1]), b = get(planes[2]);
            if (!r || !gg || !b) return null;
            const a = get(planes[-1]);
            for (let i = 0; i < w * h; i++) {
                px[i * 4] = r[i]; px[i * 4 + 1] = gg[i]; px[i * 4 + 2] = b[i];
                px[i * 4 + 3] = a ? a[i] : 255;
            }
        }
        g.putImageData(img, 0, 0);
        return c;
    }

    // 'luni' 附加块:u32 字符数 + UTF-16BE 文本 (字符数据在计数 u32 之后)。
    function readUnicodeName(bytes) {
        if (bytes.length < 4) return null;
        const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
        let s = '';
        for (let i = 0; i < n && 4 + i * 2 + 1 < bytes.length; i++) {
            s += String.fromCharCode(bytes[4 + i * 2] * 256 + bytes[4 + i * 2 + 1]);
        }
        return s;
    }

    // 一份通道平面 (w×h,返回 0..255 的每样本 Uint8Array;zip 是异步的,返回 Promise)。
    // zip (2/3) 的压缩字节数 = 声明的通道长 - 压缩标记 —— 流里**没有**长度字段, 截断边界全靠它。
    function decodeChannel(r, w, h, bps, declaredLen) {
        const rawLen = w * h * bps;
        const comp = r.u16();
        if (comp === 0) {                                    // raw
            const src = r.bytes(rawLen);
            return bps === 1 ? src.slice() : be16To8(src, w * h);
        }
        if (comp === 1) {                                    // PackBits RLE:本通道自己的行数表
            const rowCounts = [];
            for (let y = 0; y < h; y++) rowCounts.push(r.u16());
            const total = rowCounts.reduce((a, b) => a + b, 0);
            const packed = r.bytes(total);
            if (bps === 1) return unpackBits(packed, 0, total, rawLen).out;
            const out = new Uint8Array(w * h);
            let off = 0;
            for (let y = 0; y < h; y++) {
                const line = unpackBits(packed, off, off + rowCounts[y], w * 2).out;
                out.set(be16To8(line, w), y * w);
                off += rowCounts[y];
            }
            return out;
        }
        if (comp === 2 || comp === 3) {                      // zlib (3 = 带预测)
            const z = r.bytes(declaredLen - 2);
            return inflate(z).then(raw => {
                const flat = comp === 3 ? unpredict(h, w, bps, raw) : raw;
                if (flat.length < rawLen) throw new PsdError('zip short: got ' + flat.length + ', need ' + rawLen);
                return bps === 1 ? flat.subarray(0, rawLen).slice() : be16To8(flat, w * h);
            });
        }
        throw new PsdError('unsupported layer compression ' + comp + ' (at ' + (r.pos - 2) + ')');
    }

    // 一个 LayerInfo 块 (u16 图层数 + 记录 + 通道数据) 的共用解析:8 位走 LMI 直辖那份,
    // 16/32 位文档走 'Lr16'/'Lr32' 附加块,同一句读法。
    async function parseLayerBlock(r, blockEnd, layers, notes, mode, bps) {
        let count = r.i16();
        if (count < 0) count = -count;                        // 首个 alpha 含合并透明标记,与分层无关
        const records = [];
        for (let i = 0; i < count; i++) {
            if (r.pos + 16 > blockEnd) break;
            const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
            const w = right - left, h = bottom - top;
            const chCount = r.u16();
            const channels = [];
            for (let c = 0; c < chCount; c++) {
                channels.push({ id: r.i16(), len: r.u32() });
            }
            const sig = r.ascii(4);
            if (sig !== '8BIM' && sig !== '8B64') throw new PsdError('bad layer signature ' + JSON.stringify(sig) + ' (at ' + (r.pos - 4) + ')');
            r.skip(4);                                        // blend mode key — 导入全按 source-over
            r.u8();                                           // opacity
            r.u8();                                           // clipping
            const flags = r.u8();                             // bit1 (0x02) = 隐藏
            r.u8();                                           // filler
            const visible = !(flags & 0x02);
            const extraLen = r.u32();
            const extraEnd = r.pos + extraLen;
            let name = null, isGroup = false, maskRect = null;
            if (extraLen > 0) {
                if (r.pos + 4 <= extraEnd) {
                    // 图层蒙版数据:u32 长度 (+ 20/36 字节记录)。**蒙版通道 (id ≤ -2) 的像素矩形是
                    // 这里的蒙版 bbox, 不是图层矩形** —— 尺寸不同时按图层矩形读蒙版通道必然错位。
                    const maskLen = r.u32();
                    const maskEnd = r.pos + maskLen;
                    if (maskLen >= 16 && maskEnd <= extraEnd) {
                        const mt = r.i32(), ml = r.i32(), mb = r.i32(), mr = r.i32();
                        if (mb > mt && mr > ml) maskRect = { w: mr - ml, h: mb - mt };
                    }
                    r.pos = maskEnd;
                }
                if (r.pos + 4 <= extraEnd) r.skip(r.u32());   // blending ranges
                if (r.pos < extraEnd) {
                    const nLen = r.u8();
                    const padded = nLen + (4 - (1 + nLen) % 4) % 4;
                    name = r.ascii(Math.min(nLen, extraEnd - r.pos));
                    r.skip(Math.min(padded - nLen, extraEnd - r.pos));
                }
                while (r.pos + 12 <= extraEnd) {
                    const bsig = r.ascii(4);
                    if (bsig !== '8BIM' && bsig !== '8B64') break;
                    const key = r.ascii(4);
                    const dLen = r.u32();
                    const dEnd = r.pos + dLen;
                    if (key === 'luni') {
                        try { name = readUnicodeName(r.bytes(dLen)) || name; } catch (e) { /* 名字坏了不致命 */ }
                    } else if (key === 'lsct' && dLen >= 4) {
                        const t = r.view.getInt32(r.pos);
                        if (t >= 1 && t <= 3) isGroup = true;    // 分组标记 (开/闭/分隔行)
                    }
                    r.skip(dEnd - r.pos);
                }
                r.pos = extraEnd;
            }
            records.push({ top, left, w, h, channels, visible, name, isGroup, maskRect });
        }
        // 数据段:每层每通道一段 (长度在记录里),分组的空通道也要按声明走完
        for (const rec of records) {
            const planes = {};
            const jobs = [];
            for (const ch of rec.channels) {
                if (rec.isGroup || rec.w < 1 || rec.h < 1) {
                    r.skip(ch.len);                           // 声明长度含压缩标记,任何压缩都照走
                    continue;
                }
                // 蒙版通道 (id ≤ -2) 按蒙版自己的矩形读;其余按图层矩形
                const mw = (ch.id <= -2 && rec.maskRect) ? rec.maskRect.w : rec.w;
                const mh = (ch.id <= -2 && rec.maskRect) ? rec.maskRect.h : rec.h;
                const p = decodeChannel(r, mw, mh, bps, ch.len);
                if (p && p.then) jobs.push(p.then(v => { planes[ch.id] = v; }));
                else planes[ch.id] = p;
            }
            if (jobs.length) await Promise.all(jobs);
            if (rec.isGroup) { notes.groups++; continue; }
            const canvas = planesToCanvas(planes, rec.w, rec.h, mode);
            if (!canvas) { notes.empty++; continue; }
            layers.push({
                name: rec.name || null,
                x: rec.left, y: rec.top,
                visible: rec.visible,
                canvas,
            });
        }
        r.pos = blockEnd;
    }

    // 合成图用的预测复原:整面无 filter 字节, 每行独立按样本增量 (psd-tools decode_prediction 同款)。
    function unpredictFlat(w, h, bps, data) {
        const rowBytes = w * bps;
        if (data.length < h * rowBytes) throw new PsdError('file is truncated (zip)');
        const out = new Uint8Array(h * rowBytes);
        for (let r = 0; r < h; r++) {
            const acc = r * rowBytes;
            if (bps === 1) {
                out[acc] = data[acc];
                for (let i = 1; i < rowBytes; i++) out[acc + i] = (out[acc + i - 1] + data[acc + i]) & 0xff;
            } else {
                let prev = 0;
                for (let i = 0; i < w; i++) {
                    prev = (prev + (data[acc + i * 2] * 256 + data[acc + i * 2 + 1])) & 0xffff;
                    out[acc + i * 2] = prev >> 8;
                    out[acc + i * 2 + 1] = prev & 0xff;
                }
            }
        }
        return out;
    }

    // 合成图 (文件尾):单 u16 压缩标记。RLE 的行数表是**全通道一张** (channels×height 个 u16),
    // 与分层通道"各自带表"不同 —— 这一处读错只会让合成图花掉,图层导入不受影响。
    async function decodeComposite(r, fileChannels, width, height, mode, bps) {
        if (r.left < 2) return null;
        const comp = r.u16();
        const nCh = Math.min(fileChannels, mode === 1 ? 2 : 4);
        const ids = mode === 1
            ? (nCh === 2 ? [0, -1] : [0])
            : (nCh === 4 ? [0, 1, 2, -1] : [0, 1, 2]);
        const rawLen = width * height * bps;
        const planes = {};
        if (comp === 0) {
            for (let c = 0; c < nCh; c++) {
                const src = r.bytes(rawLen);
                planes[ids[c]] = bps === 1 ? src.slice() : be16To8(src, width * height);
            }
        } else if (comp === 1) {
            const counts = [];
            for (let i = 0; i < nCh * height; i++) counts.push(r.u16());
            const total = counts.reduce((a, b) => a + b, 0);
            const packed = r.bytes(total);
            let off = 0;
            for (let c = 0; c < nCh; c++) {
                const rows = counts.slice(c * height, (c + 1) * height);
                const end = off + rows.reduce((a, b) => a + b, 0);
                if (bps === 1) {
                    planes[ids[c]] = unpackBits(packed, off, end, rawLen).out;
                } else {
                    const out = new Uint8Array(width * height);
                    let o = off;
                    for (let y = 0; y < height; y++) {
                        const line = unpackBits(packed, o, o + rows[y], width * 2).out;
                        out.set(be16To8(line, width), y * width);
                        o += rows[y];
                    }
                    planes[ids[c]] = out;
                }
                off = end;
            }
        } else if (comp === 2 || comp === 3) {
            // 合并段的 zip 是**一整股流**装着全部通道 (无逐通道长度):解开后按面切。
            const z = r.bytes(r.left);
            const raw = await inflate(z);
            for (let c = 0; c < nCh; c++) {
                let plane = raw.subarray(c * rawLen, (c + 1) * rawLen);
                if (comp === 3) plane = unpredict(width, height, bps, plane);
                planes[ids[c]] = bps === 1 ? plane.slice() : be16To8(plane, width * height);
            }
        } else {
            return null;                                      // 未知压缩:合成图放弃,图层不受影响
        }
        return planesToCanvas(planes, width, height, mode);
    }

    async function decode(buf) {
        const r = new Reader(new DataView(buf));
        if (r.ascii(4) !== '8BPS') throw new PsdError('not a PSD file (bad signature)');
        const version = r.u16();
        if (version !== 1) throw new PsdError('PSB (large document) is not supported — re-save as PSD');
        r.skip(6);
        const fileChannels = r.u16();
        const height = r.u32(), width = r.u32();
        if (width < 1 || height < 1) throw new PsdError('empty document');
        const depth = r.u16();
        const mode = r.u16();
        if (mode !== 3 && mode !== 1) throw new PsdError('unsupported colour mode (only RGB and greyscale)');
        if (depth !== 8 && depth !== 16) throw new PsdError('unsupported bit depth ' + depth + ' (only 8/16)');
        const bps = depth / 8;
        const notes = { groups: 0, empty: 0 };
        const layers = [];

        r.skip(r.u32());                                      // Color Mode Data
        r.skip(r.u32());                                      // Image Resources

        // ---- Layer & Mask Information ----
        const lmiLen = r.u32();
        const lmiEnd = r.pos + lmiLen;
        const dbg = { fileChannels, lmiLen, liLen: 0, blocks: [], layerBlocks: 0 };
        if (lmiLen > 0) {
            const liLen = r.u32();
            const liEnd = r.pos + liLen;
            if (liLen > 0) {
                dbg.liLen = liLen;
                dbg.layerBlocks++;
                await parseLayerBlock(r, liEnd, layers, notes, mode, bps);   // 8 位:LayerInfo 直辖
            }
            r.pos = liEnd;
            if (r.pos + 4 <= lmiEnd) {
                const gmLen = r.u32();                        // Global Layer Mask Info
                r.skip(gmLen);
            }
            // 附加块循环:16/32 位文档的 'Lr16'/'Lr32' (真图层) 住在这里
            while (r.pos + 12 <= lmiEnd) {
                const sig = r.ascii(4);
                if (sig !== '8BIM' && sig !== '8B64') break;
                const key = r.ascii(4);
                const dLen = r.u32();
                const dEnd = r.pos + dLen;
                dbg.blocks.push(key + ':' + dLen);
                if ((key === 'Lr16' || key === 'Lr32') && dLen >= 2) {
                    // 块数据就是 LayerInfo 本身 (u16 图层数直接开头),没有再内一层长度
                    dbg.layerBlocks++;
                    await parseLayerBlock(r, dEnd, layers, notes, mode, bps);
                }
                r.pos = dEnd;
            }
        }
        r.pos = lmiEnd;

        // ---- 合成图 (文件尾) ----
        let composite = null;
        try { composite = await decodeComposite(r, fileChannels, width, height, mode, bps); }
        catch (e) { dbg.compositeError = e.message; composite = null; }   // 合成图坏了不连坐:图层导入照常
        return { width, height, mode, depth, layers, composite, notes, debug: dbg };
    }

    window.psdDecode = decode;
})();
