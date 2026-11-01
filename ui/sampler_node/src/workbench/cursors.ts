// ── 精确工具的光标：准星 + 右下角的工具徽章 ──────────────────────────────────────────────────
//
// 卷帘上的画笔 / 橡皮 / 剪刀、以及 Tracks 上那把剪刀，落点都是"哪一个像素、哪一拍" ——
// 普通箭头给不了这种精度。所以照画布那一套画（blend_node.html 的 BUCKET_CURSOR / selCursor）：
// 32×32，准星的**交点就是热点**（`8 8`），工具徽章缩到右下角，黑晕 + 白芯两层 ——
// 压在任何缩略图 / 底色上都看得清。徽章里的记号与 icons.tsx 同一套 16 格栅格，
// 光标与 dock 按钮说的是同一个符号。
//
// `glyph` 只写记号本身（16 格里的描边路径 / 圆）；怎么装进光标、热点在哪、准星多大，
// 全在这一个地方定，不给每种工具再画一套近似的光标。

const BADGE = 'translate(12 11) scale(0.68)';

export const precisionCursor = (glyph: string): string => `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" fill="none" '
  + 'stroke-linecap="round" stroke-linejoin="round">'
  + `<g transform="${BADGE}" stroke="#000" stroke-width="4.8" fill="none">${glyph}</g>`
  + `<g transform="${BADGE}" stroke="#fff" stroke-width="2" fill="none">${glyph}</g>`
  + '<path d="M3 8H13M8 3V13" stroke="#fff" stroke-width="3.2"/>'
  + '<path d="M3 8H13M8 3V13" stroke="#000" stroke-width="1.4"/>'
  + '</svg>',
)}") 8 8, crosshair`;
