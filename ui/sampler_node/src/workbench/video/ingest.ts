// 本地文件的 ffmpeg 入库：字节 POST 给后端（/api/vid_ingest），后端按内容哈希落盘 +
// ffprobe + 必要时转 H.264 faststart 代理，回一条**持久 URL**（/api/vid_media/...）——
// blob: 活不过刷新的时代到此为止，Assets 里收的就是这条持久 URL。
// 后端没有 ffmpeg（旧服务在跑 / 环境里没有）时返回 null，调用方回退旧的 <video> 探测 + blob 路径。

export type Ingested = {
  src: string;          // 持久 URL（同源 /api/vid_media/<file>；字节在资产仓库里）
  /** 原件的内容哈希（A5）：重开/换机器靠它认货，relink 按它精确匹配。 */
  asset?: string;
  /** 可播字节的哈希（转码过的源：原件浏览器咬不动，src 指向代理片）。 */
  play?: string;
  name: string;
  duration: number;
  hasAudio: boolean;
  audioOnly: boolean;
  waveform?: string;    // 整段源的波形 PNG（有音轨时后端一并生成）
};

export const ingestFile = async (file: File): Promise<Ingested | null> => {
  try {
    const res = await fetch('/api/vid_ingest?name=' + encodeURIComponent(file.name), {
      method: 'POST', body: file,
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || !j.ok || !j.src) return null;
    return {
      src: String(j.src), name: String(j.name || file.name),
      asset: j.asset ? String(j.asset) : undefined,
      play: j.proxy ? String(j.proxy) : undefined,
      duration: +j.duration || 0, hasAudio: !!j.hasAudio, audioOnly: !!j.audioOnly,
      waveform: j.waveform ? String(j.waveform) : undefined,
    };
  } catch { return null; }
};
