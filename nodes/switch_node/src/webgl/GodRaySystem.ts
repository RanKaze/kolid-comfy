import gsap from 'gsap';

interface GodRay {
  x: number;
  y: number;
  angle: number; // radians
  length: number;
  rootWidth: number;
  color: [number, number, number];
  baseAlpha: number;
  blur: number;
  scaleX: number;
  opacity: number;
}

export class GodRaySystem {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private aPos: number;
  private aUv: number;
  private aColor: number;
  private aAlpha: number;
  private aBlur: number;
  private bufPos: WebGLBuffer;
  private bufUv: WebGLBuffer;
  private bufColor: WebGLBuffer;
  private bufAlpha: WebGLBuffer;
  private bufBlur: WebGLBuffer;
  private extBlendMinMax: EXT_blend_minmax | null;
  private rays: GodRay[] = [];

  private sampledColors: Array<[number, number, number]> = [];
  private colorsReady = false;

  constructor(src?: string) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText =
      'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:180;';
    document.body.appendChild(this.canvas);

    this.gl = this.canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: true,
      preserveDrawingBuffer: false,
    })!;
    this.extBlendMinMax = this.gl.getExtension('EXT_blend_minmax');

    this.resize();
    window.addEventListener('resize', () => this.resize());

    const vs = `
      attribute vec2 a_pos;
      attribute vec2 a_uv;
      attribute vec3 a_color;
      attribute float a_alpha;
      attribute float a_blur;

      varying vec2 v_uv;
      varying vec3 v_color;
      varying float v_alpha;
      varying float v_blur;

      void main() {
        gl_Position = vec4(a_pos, 0.0, 1.0);
        v_uv = a_uv;
        v_color = a_color;
        v_alpha = a_alpha;
        v_blur = a_blur;
      }
    `;

    const fs = `
      precision mediump float;

      varying vec2 v_uv;
      varying vec3 v_color;
      varying float v_alpha;
      varying float v_blur;

      void main() {
        // Trapezoid clip: root height = 1.0, tip height = 0.3
        float halfHeight = mix(0.5, 0.15, v_uv.x);
        if (abs(v_uv.y) > halfHeight) discard;

        // Soft edge (simulates blur)
        float edgeDist = 1.0 - abs(v_uv.y) / halfHeight;
        float softEdge = smoothstep(0.0, v_blur * 0.5 + 0.02, edgeDist);

        // Alpha decay along beam: approximates original gradient
        float beamAlpha = v_alpha;
        beamAlpha *= mix(0.75, 0.4, smoothstep(0.0, 0.18, v_uv.x));
        beamAlpha *= mix(1.0, 0.3, smoothstep(0.18, 0.48, v_uv.x));
        beamAlpha *= smoothstep(1.0, 0.48, v_uv.x);
        beamAlpha *= softEdge;

        if (beamAlpha < 0.001) discard;

        // Color: brighter at root, dimmer at tip
        vec3 color = v_color * mix(1.15, 0.4, v_uv.x);

        gl_FragColor = vec4(color, beamAlpha);
      }
    `;

    this.program = this.createProgram(vs, fs);
    const gl = this.gl;
    this.aPos = gl.getAttribLocation(this.program, 'a_pos');
    this.aUv = gl.getAttribLocation(this.program, 'a_uv');
    this.aColor = gl.getAttribLocation(this.program, 'a_color');
    this.aAlpha = gl.getAttribLocation(this.program, 'a_alpha');
    this.aBlur = gl.getAttribLocation(this.program, 'a_blur');

    this.bufPos = gl.createBuffer()!;
    this.bufUv = gl.createBuffer()!;
    this.bufColor = gl.createBuffer()!;
    this.bufAlpha = gl.createBuffer()!;
    this.bufBlur = gl.createBuffer()!;

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
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    return prog;
  }

  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  spawn(x: number, y: number, angleDeg: number) {
    const angle = angleDeg * (Math.PI / 180);
    const length = 200 + Math.random() * 600;
    const width = 5 + Math.random() * 6;
    const rootWidth = width * (3 + Math.random() * 2);
    const blur = 0.8 + Math.random();
    const baseAlpha = 0.5 + Math.random() * 0.3;

    let color: [number, number, number];
    if (this.colorsReady && this.sampledColors.length > 0) {
      color = this.sampledColors[Math.floor(Math.random() * this.sampledColors.length)];
    } else {
      color = [0.65, 0.88, 1.0];
    }

    const ray: GodRay = {
      x, y, angle, length, rootWidth, color,
      baseAlpha, blur,
      scaleX: 0,
      opacity: 1,
    };

    const burstDur = 0.05 + Math.random() * 0.08;
    const breatheDur = 0.04 + Math.random() * 0.08;
    const fadeDur = 0.15 + Math.random() * 0.25;

    const tl = gsap.timeline();
    tl.to(ray, { scaleX: 1, duration: burstDur, ease: 'power2.out' });
    tl.to(ray, { scaleX: 0.8, opacity: 0.65, duration: breatheDur, repeat: 3, yoyo: true, ease: 'sine.inOut' });
    tl.to(ray, { opacity: 0, scaleX: 0.2, duration: fadeDur, ease: 'power2.in' }, `+=${0.02 + Math.random() * 0.06}`);

    this.rays.push(ray);
  }

  update() {
    // GSAP drives ray.scaleX and ray.opacity automatically
    // Remove dead rays
    this.rays = this.rays.filter((r) => r.opacity > 0.001);
  }

  render() {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const count = this.rays.length;

    if (count === 0) return;

    // Build vertex data: 6 vertices per ray (2 triangles)
    const totalVerts = count * 6;
    const posArr = new Float32Array(totalVerts * 2);
    const uvArr = new Float32Array(totalVerts * 2);
    const colorArr = new Float32Array(totalVerts * 3);
    const alphaArr = new Float32Array(totalVerts);
    const blurArr = new Float32Array(totalVerts);

    let vi = 0;
    for (const r of this.rays) {
      const cos = Math.cos(r.angle);
      const sin = Math.sin(r.angle);
      const len = r.length * r.scaleX;

      // Local corners of trapezoid (origin at left-center, pointing right)
      const lc = [
        { x: 0, y: -r.rootWidth * 0.5, u: 0, v: -0.5 },
        { x: len, y: -r.rootWidth * 0.15, u: 1, v: -0.15 },
        { x: 0, y: r.rootWidth * 0.5, u: 0, v: 0.5 },
        { x: len, y: r.rootWidth * 0.15, u: 1, v: 0.15 },
      ];

      // Transform to world
      const wc = lc.map((p) => ({
        x: r.x + p.x * cos - p.y * sin,
        y: r.y + p.x * sin + p.y * cos,
        u: p.u,
        v: p.v,
      }));

      // Triangles: (0,1,2), (2,1,3)
      const tri = [0, 1, 2, 2, 1, 3];
      for (const ti of tri) {
        const p = wc[ti];
        posArr[vi * 2] = (p.x / w) * 2 - 1;
        posArr[vi * 2 + 1] = -((p.y / h) * 2 - 1);
        uvArr[vi * 2] = p.u;
        uvArr[vi * 2 + 1] = p.v;
        colorArr[vi * 3] = r.color[0];
        colorArr[vi * 3 + 1] = r.color[1];
        colorArr[vi * 3 + 2] = r.color[2];
        alphaArr[vi] = r.opacity * r.baseAlpha;
        blurArr[vi] = r.blur;
        vi++;
      }
    }

    gl.useProgram(this.program);

    // MAX blend so overlapping rays take max alpha instead of adding up
    if (this.extBlendMinMax) {
      gl.blendEquation(this.extBlendMinMax.MAX_EXT);
    }
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);

    // Upload
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
    gl.bufferData(gl.ARRAY_BUFFER, posArr, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufUv);
    gl.bufferData(gl.ARRAY_BUFFER, uvArr, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.aUv);
    gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufColor);
    gl.bufferData(gl.ARRAY_BUFFER, colorArr, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.aColor);
    gl.vertexAttribPointer(this.aColor, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufAlpha);
    gl.bufferData(gl.ARRAY_BUFFER, alphaArr, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.aAlpha);
    gl.vertexAttribPointer(this.aAlpha, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufBlur);
    gl.bufferData(gl.ARRAY_BUFFER, blurArr, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.aBlur);
    gl.vertexAttribPointer(this.aBlur, 1, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, totalVerts);

    // Restore default blend
    gl.blendEquation(gl.FUNC_ADD);
  }

  destroy() {
    this.canvas.remove();
  }
}
