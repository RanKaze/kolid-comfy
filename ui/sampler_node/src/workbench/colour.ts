// 颜色的算术。rgbToHsv 与 parseHex 这两则在页面那一侧各有一个双胞胎（setPaintColor / paintColorRGB），
// 函数体逐字节同一份 —— 门禁把两边的函数体相比。盘上手势算出来的那一个 hex 必须和页面 setter 自己认的
// 完全一致，差一次取整就是两种颜色，而"拖到黑再拖回来色相还在"那条规矩全靠 brushHue 单独存方向。
// hsvToRgb 与下面那几则绘制函数原本也在页面里，这一格搬过来之后页面不再需要它们，所以只有这一份。
// 真值源仍然只有页面那五个变量（brushColor/brushAlpha/brushHue/back*/paintMode）；这里不做第二份状态，
// 只是把同一份算术在边界这一侧也算一遍，好让拇指与盘子跟着手指当帧就动。

export function rgbToHsv(rgb: number[]): number[] {
    const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
    }
    return [h, max === 0 ? 0 : d / max, max];
}

export function hsvToRgb(h: number, s: number, v: number): number[] {
    const i = Math.floor(((h % 1) + 1) % 1 * 6), f = ((h % 1) + 1) % 1 * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    const rgb = i % 6 === 0 ? [v, t, p] : i % 6 === 1 ? [q, v, p] : i % 6 === 2 ? [p, v, t]
        : i % 6 === 3 ? [p, q, v] : i % 6 === 4 ? [t, p, v] : [v, p, q];
    return rgb.map(x => Math.round(Math.max(0, Math.min(1, x)) * 255));
}

export const hexOf = (rgb: number[]) =>
    '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');

/** 页面上 paintColorRGB() 的解析那一段：认 #rrggbb，也认不带井号的；读不出来落白。 */
export function parseHex(hex: string): number[] {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim());
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255];
}

/** 盘式决定三格读什么数、上限多少 —— 和页面 PAINT_MODES 同一张表。 */
export const PAINT_MODES: Record<string, { labels: string[]; max: number[] }> = {
    rgba: { labels: ['R', 'G', 'B'], max: [255, 255, 255] },
    hsb: { labels: ['H', 'S', 'B'], max: [360, 100, 100] },
};

/** 三格的当下读数：HSBA 报的是存着的那个方向而不是反解的那一个（灰/黑/白反解不出色相）。 */
export function paintModeValues(mode: string, rgb: number[], hsv: number[], hue: number): number[] {
    return mode === 'hsb'
        ? [Math.round(hue * 360), Math.round(hsv[1] * 100), Math.round(hsv[2] * 100)]
        : rgb;
}

// ── 绘制 ────────────────────────────────────────────────────────────────────────
// 这几则是这一格搬过来时一起过来的，页面那一侧已经没有画图的人了。常量只是绘制缓冲的分辨率，
// 屏幕上多大归样式说（SV 方块吃栏宽剩下的，圆盘定边 116 才保得住正圆）。
export const RGBA_SV_W = 188, RGBA_SV_H = 116, RGBA_STRIP_W = 16, RGBA_STRIP_H = 116;
export const RGBA_WHEEL = 116;

function rgbaCanvas(cv: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const g = cv.getContext('2d') as CanvasRenderingContext2D;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return g;
}

// 透明底纹: Alpha 条和色块都要它, 否则"半透明"看起来就是"黑"。
function rgbaChecker(g: CanvasRenderingContext2D, w: number, h: number) {
    const cell = 6;
    for (let y = 0; y < h; y += cell) for (let x = 0; x < w; x += cell) {
        g.fillStyle = ((x / cell + y / cell) % 2) ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.05)';
        g.fillRect(x, y, cell, cell);
    }
}

// HSB 圆盘: 角度 = 色相, 半径 = 饱和度, 一律按 B=1 画 (跟 PS 的色相条一样, 盘/条本身只表示方向, 明暗
// 交给旁边那条明度条)。形状与状态无关, 所以位图算一次存着, 之后每次重画只是贴一张图 —— 但那张图必须按
// 画布的**设备像素**尺寸算, 否则 320 的源贴进 348 的目标会被重采样成一团糊。尺寸变了 (换屏/改 dpr) 才重算。
let rgbaWheelCv: HTMLCanvasElement | null = null, rgbaWheelPx = 0;
function rgbaWheelBitmap(px: number): HTMLCanvasElement {
    if (rgbaWheelCv && rgbaWheelPx === px) return rgbaWheelCv;
    const size = Math.max(32, Math.round(px)), R = size / 2;
    const cv = document.createElement('canvas'); cv.width = cv.height = size;
    const g = cv.getContext('2d') as CanvasRenderingContext2D;
    const img = g.createImageData(size, size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const dx = (x + 0.5 - R) / R, dy = (R - y - 0.5) / R;
        const len = Math.hypot(dx, dy), i = (y * size + x) * 4;
        const a = Math.max(0, Math.min(1, (1 - len) * R / 1.5)) * 255;
        if (a <= 0) continue;
        const c = hsvToRgb(len === 0 ? 0 : (Math.atan2(dy, dx) / (Math.PI * 2) + 1) % 1, Math.min(1, len), 1);
        img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = Math.round(a);
    }
    g.putImageData(img, 0, 0);
    rgbaWheelCv = cv; rgbaWheelPx = size;
    return cv;
}

/** 画那三格图（方块/圆盘 + 条 + Alpha 条）。拇指与读数不归这里 —— 它们是 DOM，由 React 摆。 */
export function drawRgbaFields(plate: HTMLCanvasElement, ramp: HTMLCanvasElement, alpha: HTMLCanvasElement,
    mode: string, fg: string, hue: number) {
    const rgb = parseHex(fg);
    const hsv = rgbToHsv(rgb);
    let g: CanvasRenderingContext2D, grad: CanvasGradient;
    const hueCss = `hsl(${(hue * 360).toFixed(1)}, 100%, 50%)`;
    if (mode === 'hsb') {
        g = rgbaCanvas(plate, RGBA_WHEEL, RGBA_WHEEL);
        g.clearRect(0, 0, RGBA_WHEEL, RGBA_WHEEL);
        g.drawImage(rgbaWheelBitmap(plate.width), 0, 0, RGBA_WHEEL, RGBA_WHEEL);
        // 明度条: 当前这份色相/饱和度下的纯色一路压到黑, 所以条上的位置就是盘里那点颜色的明暗。
        const full = hsvToRgb(hue, hsv[1], 1);
        g = rgbaCanvas(ramp, RGBA_STRIP_W, RGBA_STRIP_H);
        grad = g.createLinearGradient(0, 0, 0, RGBA_STRIP_H);
        grad.addColorStop(0, `rgb(${full[0]}, ${full[1]}, ${full[2]})`);
        grad.addColorStop(1, 'rgb(0, 0, 0)');
        g.fillStyle = grad; g.fillRect(0, 0, RGBA_STRIP_W, RGBA_STRIP_H);
    } else {
        g = rgbaCanvas(plate, RGBA_SV_W, RGBA_SV_H);
        g.fillStyle = hueCss; g.fillRect(0, 0, RGBA_SV_W, RGBA_SV_H);
        grad = g.createLinearGradient(0, 0, RGBA_SV_W, 0);
        grad.addColorStop(0, '#fff'); grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad; g.fillRect(0, 0, RGBA_SV_W, RGBA_SV_H);
        grad = g.createLinearGradient(0, 0, 0, RGBA_SV_H);
        grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, '#000');
        g.fillStyle = grad; g.fillRect(0, 0, RGBA_SV_W, RGBA_SV_H);

        g = rgbaCanvas(ramp, RGBA_STRIP_W, RGBA_STRIP_H);
        grad = g.createLinearGradient(0, 0, 0, RGBA_STRIP_H);
        for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${i * 60}, 100%, 50%)`);
        g.fillStyle = grad; g.fillRect(0, 0, RGBA_STRIP_W, RGBA_STRIP_H);
    }

    g = rgbaCanvas(alpha, RGBA_STRIP_W, RGBA_STRIP_H);
    rgbaChecker(g, RGBA_STRIP_W, RGBA_STRIP_H);
    grad = g.createLinearGradient(0, 0, 0, RGBA_STRIP_H);
    grad.addColorStop(0, `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`);
    grad.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0)`);
    g.fillStyle = grad; g.fillRect(0, 0, RGBA_STRIP_W, RGBA_STRIP_H);
}
