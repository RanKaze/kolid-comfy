// ==================== FrameSource（P2 第二步）====================
// 一帧要用到哪些视频帧，由 plan 决定：某个 trackId 在时刻 t 的**源内时刻**。
// 这里只做一件事：把 (trackId, at) 对好（精确 seek、等落定），然后同步把 <video> 交出去。
//
// 为什么不是"用视频现在停在哪一帧"：那就是老架构的病根 —— 三套时钟各自漂，
// 基准图会记成"取图那一刻视频刚好停在那"。帧必须由 t 唯一决定（契约 §3.4 / §5.5）。
//
// 渲染是同步的，取帧是异步的 ⇒ 调 render 之前先 `await KFrameSource.prepare(plan, t)`。
const KFrameSource = (function () {
    const els = new Map();          // trackId → { v, src, at }
    const cache = { hits: 0, seeks: 0, misses: 0 };

    /** 契约里的 sourceTime：一段 clip 在时间线 t 处该取源内哪一秒。 */
    function sourceTime(clip, t) {
        const off = clip.offset || 0;
        const end = Math.max(0, (clip.srcDuration || 0) - 0.001);
        return Math.max(0, Math.min(off + (t - clip.start), end));
    }

    /** 某条轨在 t 处命中的 clip（没有就 null）。plan.tracks 的时刻表是唯一来源。 */
    function clipAt(plan, trackId, t) {
        const tr = (plan.tracks || []).find(x => x.id === trackId);
        if (!tr) return null;
        for (const c of tr.clips || []) {
            if (t >= c.start && t < c.start + c.duration) return c;
        }
        return null;
    }

    /** 这一刻的帧该取的源内时刻；没有片返回 null。 */
    function wantAt(plan, trackId, t) {
        const c = clipAt(plan, trackId, t);
        return c ? sourceTime(c, t) : null;
    }

    function trackUri(plan, trackId) {
        const tr = (plan.tracks || []).find(x => x.id === trackId);
        if (!tr || !tr.resource) return null;
        const r = (plan.resources || []).find(x => x.id === tr.resource);
        return r ? r.uri : null;
    }

    function urlOf(uri) {
        if (!uri) return null;
        if (uri.startsWith('media://')) return '/api/global_media/' + uri.slice(8);
        if (uri.startsWith('inline:')) return null;      // 图像不是视频
        if (uri.startsWith('asset://')) return '/api/asset_media/' + uri.slice(8);
        return uri;
    }

    /** 一只 <video> per 轨（换源就重建）。 */
    function elementFor(trackId, uri) {
        const url = urlOf(uri);
        if (!url) return null;
        let e = els.get(trackId);
        if (e && e.src === url) return e;
        if (e) { try { e.v.pause(); e.v.removeAttribute('src'); e.v.load(); } catch (err) { /* gone */ } }
        const v = document.createElement('video');
        v.muted = true;
        v.playsInline = true;
        v.preload = 'auto';
        v.setAttribute('aria-hidden', 'true');
        v.style.cssText = 'position:fixed;left:-4px;top:-4px;width:1px;height:1px;opacity:0.01;pointer-events:none';
        document.body.appendChild(v);
        v.setAttribute('src', url);
        try { v.load(); } catch (err) { /* noop */ }
        e = { v, src: url, at: null };
        els.set(trackId, e);
        return e;
    }

    function ready(v) { return v && v.readyState >= 2 && v.videoWidth > 0; }

    /** 等它解出画面（元数据/首帧），最多 timeout。 */
    function whenReady(v, timeout) {
        if (ready(v) && !v.seeking) return Promise.resolve(true);
        return new Promise(res => {
            let done = false;
            const fin = ok => { if (done) return; done = true; v.removeEventListener('loadeddata', on); res(ok); };
            const on = () => fin(true);
            v.addEventListener('loadeddata', on, { once: true });
            setTimeout(() => fin(ready(v)), timeout || 4000);
        });
    }

    /** 精确 seek 到 at，等落定。已在那一格（差 < 1/4 帧）就直接算命中。 */
    function seekTo(v, at, timeout) {
        if (Math.abs((v.currentTime || 0) - at) < 1 / 240 && ready(v) && !v.seeking) {
            cache.hits++;
            return Promise.resolve(true);
        }
        cache.seeks++;
        return new Promise(res => {
            let done = false;
            const fin = ok => {
                if (done) return;
                done = true;
                v.removeEventListener('seeked', on);
                res(ok);
            };
            const on = () => fin(true);
            v.addEventListener('seeked', on, { once: true });
            try { v.currentTime = at; } catch (e) { fin(false); return; }
            setTimeout(() => fin(!v.seeking && ready(v)), timeout || 4000);
        });
    }

    /**
     * 把这一帧需要的所有轨对好。返回 { trackId: at }（诊断用）。
     * 需要的轨 = layers 模式下 strip 里所有 frameTrack + source 模式的那一条。
     */
    async function prepare(plan, t) {
        const need = new Map();
        const fr = plan.frame || {};
        if (fr.mode === 'source') {
            if (fr.source && fr.source.trackId) need.set(fr.source.trackId, null);
        } else {
            for (const pl of plan.layers || []) {
                for (const st of pl.strip || []) {
                    if (st && st.frameTrack) need.set(st.frameTrack, null);
                }
            }
        }
        const out = {};
        for (const trackId of need.keys()) {
            const uri = trackUri(plan, trackId);
            const e = elementFor(trackId, uri);
            if (!e) { cache.misses++; out[trackId] = null; continue; }
            const ok = await whenReady(e.v);
            const at = wantAt(plan, trackId, t);
            out[trackId] = at;
            if (!ok || at === null) { cache.misses++; continue; }
            await seekTo(e.v, at);
            e.at = at;
        }
        return out;
    }

    /** 同步取：这一刻这条轨的 <video>（已由 prepare 对好）。没有就 null。 */
    function get(trackId) {
        const e = els.get(trackId);
        if (!e) return null;
        return (ready(e.v) && !e.v.seeking) ? e.v : null;
    }

    function dispose() {
        for (const [, e] of els) { try { e.v.pause(); e.v.removeAttribute('src'); e.v.load(); e.v.remove(); } catch (err) { /* gone */ } }
        els.clear();
    }

    return { prepare, get, sourceTime, clipAt, wantAt, dispose, stats: cache };
})();

if (typeof window !== 'undefined') window.KFrameSource = KFrameSource;
