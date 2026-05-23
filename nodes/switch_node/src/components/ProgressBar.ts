import gsap from 'gsap';

const colorCache = new Map<string, Array<[number, number, number]>>();

function isTooDark(r: number, g: number, b: number): boolean {
  const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
  return brightness < 50;
}

export class ProgressBar {
  private container: HTMLDivElement | null = null;
  private fills: HTMLDivElement[] = [];
  private callbacks: gsap.core.Tween[] = [];

  private getImageSize(src: string): { w: number; h: number } {
    const img = new Image();
    img.src = src;
    if (img.complete && img.naturalWidth > 0) {
      return { w: img.naturalWidth, h: img.naturalHeight };
    }
    return { w: 512, h: 512 };
  }

  private computePreviewSize(naturalW: number, naturalH: number): { w: number; h: number } {
    const maxW = window.innerWidth * 0.9;
    const maxH = window.innerHeight * 0.60;
    const ratio = naturalW / naturalH;
    let w = maxW;
    let h = w / ratio;
    if (h > maxH) {
      h = maxH;
      w = h * ratio;
    }
    return { w, h };
  }

  private computePreviewRect(src: string): { x: number; y: number; w: number; h: number } {
    const size = this.getImageSize(src);
    const preview = this.computePreviewSize(size.w, size.h);

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const containerPadTop = 60;
    const containerPadBottom = 60;
    const gap = 28;

    const scrollEl = document.querySelector('[data-scroll-container]');
    let scrollH = 240;
    if (scrollEl) {
      const rect = scrollEl.getBoundingClientRect();
      if (rect.height > 0) scrollH = rect.height;
    }

    const previewAreaH = Math.max(200, viewportH - containerPadTop - containerPadBottom - scrollH - gap);
    const previewAreaTop = containerPadTop;

    const x = (viewportW - preview.w) / 2;
    const y = previewAreaTop + (previewAreaH - preview.h) / 2;

    return { x, y, w: preview.w, h: preview.h };
  }

  private sampleColors(src: string, count = 7): Promise<Array<[number, number, number]>> {
    const cached = colorCache.get(src);
    if (cached) return Promise.resolve(cached);

    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = src;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const w = Math.min(img.naturalWidth, 128);
        const h = Math.min(img.naturalHeight, 128);
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        const pixelCount = w * h;
        const colors: Array<[number, number, number]> = [];
        for (let i = 0; i < count; i++) {
          let attempts = 0;
          let r = 0, g = 0, b = 0;
          do {
            const idx = Math.floor(Math.random() * pixelCount) * 4;
            r = data[idx];
            g = data[idx + 1];
            b = data[idx + 2];
            attempts++;
          } while (isTooDark(r, g, b) && attempts < 20);
          colors.push([r / 255, g / 255, b / 255]);
        }
        colorCache.set(src, colors);
        resolve(colors);
      };
      img.onerror = () => resolve([[0.65, 0.88, 1.0]]);
    });
  }

  private ensureContainer() {
    if (this.container) return;
    this.container = document.createElement('div');
    this.container.style.cssText = `
      position: fixed;
      left: 0;
      width: 100vw;
      display: flex;
      flex-direction: column;
      gap: 8px;
      opacity: 0;
      transition: opacity 0.3s;
      pointer-events: none;
      z-index: 50;
    `;
    document.body.appendChild(this.container);
  }

  async show(src: string) {
    this.ensureContainer();

    this.fills = [];
    this.container!.innerHTML = '';

    const colors = await this.sampleColors(src, 7);
    for (const color of colors) {
      const h = 100 + Math.random() * 20; // random height 100~120px
      const r = Math.round(color[0] * 255);
      const g = Math.round(color[1] * 255);
      const b = Math.round(color[2] * 255);

      const track = document.createElement('div');
      track.style.cssText = `
        position: relative;
        width: 100vw;
        height: ${h}px;
        overflow: hidden;
      `;

      // Track 磨砂玻璃背景：统一位置
      const blurBg = document.createElement('div');
      blurBg.style.cssText = `
        position: absolute;
        left: 0;
        top: 0;
        width: 100%;
        height: 100%;
        background-image: url('${src}');
        background-size: cover;
        background-position: center;
        background-attachment: fixed;
        filter: blur(10px) brightness(0.5) saturate(1.3);
      `;
      track.appendChild(blurBg);

      // 从左到右渐变遮罩：左侧清晰，右侧渐暗
      const fade = document.createElement('div');
      fade.style.cssText = `
        position: absolute;
        left: 0;
        top: 0;
        width: 100%;
        height: 100%;
        background: linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,0.35) 60%, rgba(0,0,0,0.85) 100%);
        pointer-events: none;
      `;
      track.appendChild(fade);

      // Fill：视口固定背景，所有条带共同组成完整大图
      const fill = document.createElement('div');
      fill.style.cssText = `
        position: absolute;
        right: 0;
        top: 0;
        width: 0%;
        height: 100%;
        border-radius: 16px 0 0 16px;
        overflow: hidden;
        background-image: url('${src}');
        background-size: cover;
        background-position: center top;
        background-attachment: fixed;
      `;

      const fillTint = document.createElement('div');
      fillTint.style.cssText = `
        position: absolute;
        left: 0;
        top: 0;
        width: 100%;
        height: 100%;
        background: rgba(${r},${g},${b},0.45);
      `;
      fill.appendChild(fillTint);
      track.appendChild(fill);
      this.container!.appendChild(track);
      this.fills.push(fill);
    }

    // Position vertically centered on the preview image (behind it via z-index)
    const pv = this.computePreviewRect(src);
    const centerY = pv.y + pv.h / 2;
    const barH = this.container!.offsetHeight || 49;
    this.container!.style.top = `${centerY - barH / 2}px`;

    this.container!.style.opacity = '1';
  }

  reset() {
    this.callbacks.forEach((t) => t.kill());
    this.callbacks = [];
    this.fills.forEach((bar) => {
      bar.style.transition = 'none';
      bar.style.width = '0%';
    });
  }

  start(onComplete: () => void) {
    this.fills.forEach((bar) => bar.offsetHeight);

    this.fills.forEach((bar, i) => {
      const delay = i * 0.12;
      bar.style.transition = `width 5s linear ${delay}s`;
      bar.style.width = '100%';
    });

    const tween = gsap.delayedCall(5.6, () => onComplete());
    this.callbacks.push(tween);
  }

  getBounds(): { top: number; bottom: number } | null {
    if (!this.container) return null;
    const rect = this.container.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  }

  hide() {
    if (this.container) {
      this.container.style.opacity = '0';
    }
  }

  destroy() {
    this.callbacks.forEach((t) => t.kill());
    this.callbacks = [];
    this.container?.remove();
    this.container = null;
    this.fills = [];
  }
}
