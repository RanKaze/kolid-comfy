// ── 这扇窗这一次加载的身份 ──────────────────────────────────────────────────────────────────
//
// 时间线 PCM 的"作者"按会话认：[clock.ts] 把播放命令和这个 id 一起发给后端，后端据此把
// 引擎的 PCM 作者定成"按播放的那扇窗"（见 audio_bridge 的 _PcmBook）。别的窗看到"在播"
// 只是镜像，不参与作者。
//
// 刷新/关窗即作废：后端在 pagehide（pcm_release）或心跳超期时把它名下的 PCM 整批回收。

export const PAGE_SESSION: string = (() => {
  try { return crypto.randomUUID(); } catch { return 'page-' + Math.random().toString(36).slice(2); }
})();
