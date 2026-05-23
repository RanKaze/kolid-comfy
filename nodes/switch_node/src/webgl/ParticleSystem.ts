export class ParticleSystem {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private aPos: number;
  private aAlpha: number;
  private aColor: number;
  private bufPos: WebGLBuffer;
  private bufAlpha: WebGLBuffer;
  private bufColor: WebGLBuffer;

  particles: Array<{
    x: number; y: number;
    vx: number; vy: number;
    life: number; maxLife: number;
    trail: Array<{ x: number; y: number; born: number }>;
    color: [number, number, number];
    lineWidth: number;
    baseAlpha: number;
  }> = [];

  private now = 0;
  private readonly TRAIL_MS = 500;
  private readonly LINE_HALF_W = 1.0; // total line width = 2px

  private sampledColors: Array<[number, number, number]> = [];
  private colorsReady = false;

  private cardRects: Array<{ x: number; y: number; w: number; h: number }> = [];

  constructor(src?: string) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText =
      'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:178;';
    document.body.appendChild(this.canvas);

    this.gl = this.canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: true,
      preserveDrawingBuffer: false,
    })!;

    this.resize();
    window.addEventListener('resize', () => this.resize());

    const vs = `
      attribute vec2 a_pos;
      attribute float a_alpha;
      attribute vec3 a_color;
      varying float v_alpha;
      varying vec3 v_color;
      void main() {
        gl_Position = vec4(a_pos, 0.0, 1.0);
        v_alpha = a_alpha;
        v_color = a_color;
      }
    `;
    const fs = `
      precision mediump float;
      varying float v_alpha;
      varying vec3 v_color;
      void main() {
        gl_FragColor = vec4(v_color, v_alpha);
      }
    `;
    this.program = this.createProgram(vs, fs);

    const gl = this.gl;
    this.aPos = gl.getAttribLocation(this.program, 'a_pos');
    this.aAlpha = gl.getAttribLocation(this.program, 'a_alpha');
    this.aColor = gl.getAttribLocation(this.program, 'a_color');

    this.bufPos = gl.createBuffer()!;
    this.bufAlpha = gl.createBuffer()!;
    this.bufColor = gl.createBuffer()!;

    gl.disable(gl.DEPTH_TEST);

    if (src) {
      this.sampleImageColors(src);
    }
  }

  private async sampleImageColors(src: string) {
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = src;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject();
      });

      const canvas = document.createElement('canvas');
      const w = Math.min(img.naturalWidth, 256);
      const h = Math.min(img.naturalHeight, 256);
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);

      const data = ctx.getImageData(0, 0, w, h).data;
      const pixelCount = w * h;

      const colors: Array<[number, number, number]> = [];
      for (let i = 0; i < 32; i++) {
        const idx = Math.floor(Math.random() * pixelCount) * 4;
        colors.push([data[idx] / 255, data[idx + 1] / 255, data[idx + 2] / 255]);
      }

      this.sampledColors = colors;
      this.colorsReady = true;
    } catch {
      // keep defaults
    }
  }

  private createProgram(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, vsSrc);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(fs);
    const p = gl.createProgram()!;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    return p;
  }

  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  setCardRects(rects: Array<{ x: number; y: number; w: number; h: number }>) {
    this.cardRects = rects;
  }

  // Liang–Barsky segment vs axis-aligned box. Returns earliest hit on [0,1].
  private segmentAABB(
    x1: number, y1: number, x2: number, y2: number,
    minX: number, minY: number, maxX: number, maxY: number
  ): { t: number; nx: number; ny: number } | null {
    const dx = x2 - x1;
    const dy = y2 - y1;
    let tmin = 0;
    let tmax = 1;

    const check = (p: number, d: number, min: number, max: number): boolean => {
      if (Math.abs(d) < 1e-6) {
        return p >= min && p <= max;
      }
      const t1 = (min - p) / d;
      const t2 = (max - p) / d;
      const tnear = Math.min(t1, t2);
      const tfar = Math.max(t1, t2);
      tmin = Math.max(tmin, tnear);
      tmax = Math.min(tmax, tfar);
      return tmin <= tmax;
    };

    if (!check(x1, dx, minX, maxX)) return null;
    if (!check(y1, dy, minY, maxY)) return null;
    if (tmin > 1 || tmax < 0) return null;

    const hx = x1 + dx * tmin;
    const hy = y1 + dy * tmin;
    const eps = 1e-3;
    let nx = 0, ny = 0;
    if (Math.abs(hx - minX) < eps) nx = -1;
    else if (Math.abs(hx - maxX) < eps) nx = 1;
    else if (Math.abs(hy - minY) < eps) ny = -1;
    else if (Math.abs(hy - maxY) < eps) ny = 1;

    return { t: tmin, nx, ny };
  }

  // Resolve CCD for one particle against screen edges and card rect.
  private resolveCollision(prevX: number, prevY: number, p: typeof this.particles[0]) {
    const W = this.canvas.width;
    let bestT = 1;
    let bestNx = 0, bestNy = 0;
    let hit = false;

    // Left edge x = 0
    if (prevX > 0 && p.x <= 0) {
      const t = prevX / (prevX - p.x);
      if (t < bestT) {
        bestT = t; bestNx = 1; bestNy = 0; hit = true;
      }
    }

    // Right edge x = W
    if (prevX < W && p.x >= W) {
      const t = (W - prevX) / (p.x - prevX);
      if (t < bestT) {
        bestT = t; bestNx = -1; bestNy = 0; hit = true;
      }
    }

    // Option cards (axis-aligned rectangles below)
    for (const cr of this.cardRects) {
      const res = this.segmentAABB(prevX, prevY, p.x, p.y, cr.x, cr.y, cr.x + cr.w, cr.y + cr.h);
      if (res && res.t < bestT) {
        bestT = res.t; bestNx = res.nx; bestNy = res.ny; hit = true;
      }
    }

    if (hit) {
      // Reflect velocity with angle-dependent energy loss + randomness
      const dot = p.vx * bestNx + p.vy * bestNy;
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy) + 1e-6;
      const cosTheta = Math.abs(dot) / speed; // 0 = grazing, 1 = head-on
      const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));

      // Grazing bounces keep more energy; head-on bounces lose more
      let restitution = 0.15 + 0.75 * sinTheta;
      // Add randomness: ±30% variation per bounce
      restitution *= 0.7 + Math.random() * 0.6;
      restitution = Math.max(0.05, Math.min(0.95, restitution));

      const vnX = dot * bestNx;
      const vnY = dot * bestNy;
      const vtX = p.vx - vnX;
      const vtY = p.vy - vnY;
      p.vx = vtX - vnX * restitution;
      p.vy = vtY - vnY * restitution;

      // Rewind to collision point + small normal offset to avoid re-penetration
      p.x = prevX + (p.x - prevX) * bestT + bestNx * 0.5;
      p.y = prevY + (p.y - prevY) * bestT + bestNy * 0.5;
    }
  }

  emit(x: number, y: number, angleDeg: number, speed: number, _size: number) {
    const rad = angleDeg * (Math.PI / 180);
    const actualSpeed = speed * (0.2 + Math.random() * 1.8);

    let color: [number, number, number];
    if (this.colorsReady && this.sampledColors.length > 0) {
      color = this.sampledColors[Math.floor(Math.random() * this.sampledColors.length)];
    } else {
      color = [0.65, 0.88, 1.0];
    }

    this.particles.push({
      x, y,
      vx: Math.cos(rad) * actualSpeed,
      vy: Math.sin(rad) * actualSpeed,
      life: 1,
      maxLife: 2.0 + Math.random() * 3.0,
      trail: [{ x, y, born: performance.now() }],
      color,
      lineWidth: 2 + Math.random() * 3,
      baseAlpha: 0.1 + Math.random() * 0.4,
    });
  }

  update(dt: number) {
    const GRAVITY = 600; // px/s² downward
    this.now = performance.now();
    const cutoff = this.now - this.TRAIL_MS;

    for (const p of this.particles) {
      const prevX = p.x;
      const prevY = p.y;

      p.vy += GRAVITY * dt;
      // Air resistance
      const friction = 1.5;
      p.vx *= 1 - friction * dt;
      p.vy *= 1 - friction * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // Continuous collision detection using prev→curr line segment
      this.resolveCollision(prevX, prevY, p);

      p.life -= dt / p.maxLife;

      if (p.life > 0) {
        p.trail.push({ x: p.x, y: p.y, born: this.now });
      }

      let i = 0;
      while (i < p.trail.length && p.trail[i].born < cutoff) {
        i++;
      }
      if (i > 0) p.trail.splice(0, i);
    }

    this.particles = this.particles.filter(
      (p) => p.life > 0 || p.trail.length > 0
    );
  }

  render() {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    let segCount = 0;
    for (const p of this.particles) {
      if (p.trail.length >= 2) segCount += p.trail.length - 1;
    }
    if (segCount === 0) return;

    const totalVerts = segCount * 6;
    const posArr = new Float32Array(totalVerts * 2);
    const alphaArr = new Float32Array(totalVerts);
    const colorArr = new Float32Array(totalVerts * 3);

    let vi = 0;
    for (const p of this.particles) {
      if (p.trail.length < 2) continue;

      for (let i = 0; i < p.trail.length - 1; i++) {
        const a = p.trail[i];
        const b = p.trail[i + 1];

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.001) continue;

        const halfW = p.lineWidth / 2;
        const nx = (-dy / len) * halfW;
        const ny = (dx / len) * halfW;

        const x1 = a.x + nx, y1 = a.y + ny;
        const x2 = a.x - nx, y2 = a.y - ny;
        const x3 = b.x + nx, y3 = b.y + ny;
        const x4 = b.x - nx, y4 = b.y - ny;

        const toNDC = (px: number, py: number) => [
          (px / w) * 2 - 1,
          -((py / h) * 2 - 1),
        ];

        const ageA = (this.now - a.born) / this.TRAIL_MS;
        const ageB = (this.now - b.born) / this.TRAIL_MS;
        const fadeA = Math.max(0, (1.0 - ageA) * p.baseAlpha);
        const fadeB = Math.max(0, (1.0 - ageB) * p.baseAlpha);

        const pushVert = (px: number, py: number, alpha: number) => {
          const [ndx, ndy] = toNDC(px, py);
          posArr[vi * 2] = ndx;
          posArr[vi * 2 + 1] = ndy;
          alphaArr[vi] = alpha;
          colorArr[vi * 3] = p.color[0];
          colorArr[vi * 3 + 1] = p.color[1];
          colorArr[vi * 3 + 2] = p.color[2];
          vi++;
        };

        pushVert(x1, y1, fadeA);
        pushVert(x3, y3, fadeB);
        pushVert(x2, y2, fadeA);
        pushVert(x2, y2, fadeA);
        pushVert(x3, y3, fadeB);
        pushVert(x4, y4, fadeB);
      }
    }

    if (vi === 0) return;

    gl.useProgram(this.program);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.enable(gl.BLEND);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
    gl.bufferData(gl.ARRAY_BUFFER, posArr, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufAlpha);
    gl.bufferData(gl.ARRAY_BUFFER, alphaArr, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.aAlpha);
    gl.vertexAttribPointer(this.aAlpha, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufColor);
    gl.bufferData(gl.ARRAY_BUFFER, colorArr, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.aColor);
    gl.vertexAttribPointer(this.aColor, 3, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, vi);
  }

  destroy() {
    this.canvas.remove();
  }
}
