// 宿主侧按需装载页面共用的经典脚本（three.js 内置包 + 世界数学 + 视图引擎）。工作台服务器把
// /js /fx /attr 三个目录直属的 .js 按原样送出来（禁缓存），所以这里的 src 一律是**同源绝对路径**。
//
// 这些脚本是**普通全局脚本**（不是 ES 模块）：top-level 的 function / const / let 落在全局词法里，
// 页面与宿主各持一份独立的副本（两个文档、两个 realm），彼此不串。宿主第一次用到哪一格才拉哪一串，
// 而且**每份只拉一次** —— 同一个 URL 注第二遍会撞 const 重声明（SyntaxError），所以这里记 Promise。

const loaded = new Map<string, Promise<void>>();

export function loadScriptOnce(src: string): Promise<void> {
  const prev = loaded.get(src);
  if (prev) return prev;
  const p = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    // 动态插入的脚本默认 async=true（谁先下载完谁先跑）；这里要的是**按注入顺序**执行，
    // 否则 geo_math.js 可能晚于 direction_view.js 落地，裸名字引用就断在半路上。
    el.async = false;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(el);
  });
  loaded.set(src, p);
  return p;
}
