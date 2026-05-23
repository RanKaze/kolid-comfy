import gsap from 'gsap';
import Matter from 'matter-js';
import { ParticleSystem } from './webgl/ParticleSystem';
import { ProgressBar } from './components/ProgressBar';

// ===== Internal state =====
let hoverTl: gsap.core.Timeline | null = null;
let hoverEl: HTMLDivElement | null = null;
let hoverPendingComplete: (() => void) | null = null;
let selectEl: HTMLDivElement | null = null;
let selectRaf: number | null = null;

// ===== Portal state =====
let portalEl: HTMLDivElement | null = null;
let portalGlowEl: HTMLDivElement | null = null;
let portalParticleInterval: ReturnType<typeof setInterval> | null = null;
let portalActive = false;

let particleSystem: ParticleSystem | null = null;
let progressBar: ProgressBar | null = null;
let isSelectionActive = false;
let progressEffectInterval: ReturnType<typeof setInterval> | null = null;

// ===== Read image natural size via a temporary Image =====
function getImageSize(src: string): { w: number; h: number } {
  const img = new Image();
  img.src = src;
  if (img.complete && img.naturalWidth > 0) {
    return { w: img.naturalWidth, h: img.naturalHeight };
  }
  return { w: 512, h: 512 };
}

// ===== Compute rendered preview size (matches CSS maxWidth/maxHeight + object-fit:contain) =====
function computePreviewSize(naturalW: number, naturalH: number): { w: number; h: number } {
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

// ===== Compute the final preview rect in viewport coordinates =====
function computePreviewRect(src: string): { x: number; y: number; w: number; h: number } {
  const size = getImageSize(src);
  const preview = computePreviewSize(size.w, size.h);

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

// ===== Read current DOM preview rect (preferred over computed) =====
function getPreviewRectFromDOM(): { w: number; h: number; x: number; y: number } | null {
  const img = document.querySelector('[data-preview-img]') as HTMLImageElement | null;
  if (img) {
    const rect = img.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return { w: rect.width, h: rect.height, x: rect.left, y: rect.top };
    }
  }
  return null;
}

// ===== Portal: glow strip + particles on the right edge =====
function createPortal() {
  if (portalEl) return;

  portalEl = document.createElement('div');
  portalEl.style.cssText = `
    position: fixed;
    top: 0;
    right: 0;
    width: 3px;
    height: 100vh;
    background: linear-gradient(180deg,
      rgba(120, 220, 255, 0) 0%,
      rgba(120, 220, 255, 0.7) 15%,
      rgba(180, 140, 255, 0.85) 40%,
      rgba(120, 220, 255, 0.85) 60%,
      rgba(120, 220, 255, 0.7) 85%,
      rgba(120, 220, 255, 0) 100%
    );
    box-shadow:
      -2px 0 20px rgba(120, 220, 255, 0.5),
      -6px 0 50px rgba(160, 140, 255, 0.35),
      -12px 0 100px rgba(120, 220, 255, 0.15);
    z-index: 150;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.25s ease;
  `;
  document.body.appendChild(portalEl);

  portalGlowEl = document.createElement('div');
  portalGlowEl.style.cssText = `
    position: fixed;
    top: 0;
    right: -20px;
    width: 60px;
    height: 100vh;
    background: radial-gradient(ellipse 100% 50% at 100% 50%,
      rgba(120, 220, 255, 0.12) 0%,
      rgba(160, 140, 255, 0.06) 40%,
      transparent 80%
    );
    z-index: 149;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.25s ease;
  `;
  document.body.appendChild(portalGlowEl);
}

function startPortalParticles() {
  if (portalParticleInterval) return;
  portalParticleInterval = setInterval(() => {
    if (!portalActive) return;
    createPortalParticle();
  }, 60);
}

function createPortalParticle() {
  const p = document.createElement('div');
  const size = Math.random() * 2.5 + 1;
  const startY = Math.random() * window.innerHeight;
  const driftX = 30 + Math.random() * 120;
  const driftY = (Math.random() - 0.5) * 40;
  const duration = 0.6 + Math.random() * 0.9;

  p.style.cssText = `
    position: fixed;
    right: ${-size}px;
    top: ${startY}px;
    width: ${size}px;
    height: ${size}px;
    border-radius: 50%;
    background: rgba(160, 220, 255, ${0.5 + Math.random() * 0.5});
    box-shadow: 0 0 ${size * 3}px rgba(120, 200, 255, 0.7);
    z-index: 149;
    pointer-events: none;
  `;

  document.body.appendChild(p);

  gsap.to(p, {
    x: -driftX,
    y: driftY,
    opacity: 0,
    scale: 0.3,
    duration,
    ease: 'power1.out',
    onComplete: () => p.remove(),
  });
}

function showPortal(intense = false) {
  createPortal();
  portalActive = true;
  if (portalEl) {
    portalEl.style.opacity = intense ? '1' : '0.75';
    portalEl.style.boxShadow = intense
      ? '-2px 0 30px rgba(120, 220, 255, 0.7), -6px 0 70px rgba(160, 140, 255, 0.5), -12px 0 140px rgba(120, 220, 255, 0.25)'
      : '-2px 0 20px rgba(120, 220, 255, 0.5), -6px 0 50px rgba(160, 140, 255, 0.35), -12px 0 100px rgba(120, 220, 255, 0.15)';
  }
  if (portalGlowEl) portalGlowEl.style.opacity = intense ? '0.6' : '0.4';
  startPortalParticles();
}

function hidePortal() {
  portalActive = false;
  if (portalEl) portalEl.style.opacity = '0';
  if (portalGlowEl) portalGlowEl.style.opacity = '0';
  if (portalParticleInterval) {
    clearInterval(portalParticleInterval);
    portalParticleInterval = null;
  }
  setTimeout(() => {
    portalEl?.remove();
    portalEl = null;
    portalGlowEl?.remove();
    portalGlowEl = null;
  }, 300);
}

// ===== Helper: create a fixed-position flying element =====
function createFlyingElement(
  src: string,
  x: number,
  y: number,
  w: number,
  h: number,
  zIndex: number
): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = `
    position: fixed;
    left: ${x}px;
    top: ${y}px;
    width: ${w}px;
    height: ${h}px;
    z-index: ${zIndex};
    border-radius: 20px;
    overflow: hidden;
    pointer-events: none;
    transform-origin: center center;
  `;
  el.innerHTML = `<img src="${src}" style="width:100%;height:100%;object-fit:cover;">`;
  document.body.appendChild(el);
  return el as HTMLDivElement;
}

// ===== Compute rotated rectangle corners =====
function getRotatedCorners(
  cx: number, cy: number, angle: number, w: number, h: number
): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const hw = w / 2;
  const hh = h / 2;

  return [
    { x: -hw * cos + hh * sin + cx, y: -hw * sin - hh * cos + cy },
    { x: hw * cos + hh * sin + cx, y: hw * sin - hh * cos + cy },
    { x: hw * cos - hh * sin + cx, y: hw * sin + hh * cos + cy },
    { x: -hw * cos - hh * sin + cx, y: -hw * sin + hh * cos + cy },
  ];
}

// ===== Intersect a rotated rectangle with a vertical line x = lineX =====
function intersectRectWithVerticalLine(
  corners: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }],
  lineX: number
): [{ x: number; y: number }, { x: number; y: number }] | null {
  const edges = [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ];

  const intersections: { x: number; y: number }[] = [];

  for (const [p1, p2] of edges) {
    const crosses = (p1.x - lineX) * (p2.x - lineX) <= 0;
    const notVertical = Math.abs(p2.x - p1.x) > 0.001;
    if (crosses && notVertical) {
      const t = (lineX - p1.x) / (p2.x - p1.x);
      const y = p1.y + t * (p2.y - p1.y);
      intersections.push({ x: lineX, y });
    }
  }

  if (intersections.length >= 2) {
    intersections.sort((a, b) => a.y - b.y);
    return [intersections[0], intersections[intersections.length - 1]];
  }

  return null;
}

// ===== Hover: suck preview image out FROM card TO center preview position =====
export function startHoverSuck(src: string, cardRect: DOMRect, onComplete?: () => void) {
  stopHoverSuck();
  hoverPendingComplete = onComplete ?? null;

  const pv = computePreviewRect(src);

  hoverEl = createFlyingElement(src, cardRect.left, cardRect.top, cardRect.width, cardRect.height, 95);

  showPortal(false);

  if (!isSelectionActive) {
    if (!progressBar) progressBar = new ProgressBar();
    progressBar.show(src);
  }

  const tl = gsap.timeline({
    onComplete: () => {
      const cb = hoverPendingComplete;
      hoverTl = null;
      hoverPendingComplete = null;
      cb?.();
      requestAnimationFrame(() => {
        hoverEl?.remove();
        hoverEl = null;
      });
    },
  });

  tl.to(hoverEl, {
    width: cardRect.width * 0.72,
    height: cardRect.height * 1.25,
    duration: 0.08,
    ease: 'power2.out',
  });

  tl.to(hoverEl, {
    x: pv.x - cardRect.left,
    y: pv.y - cardRect.top,
    width: pv.w,
    height: pv.h,
    duration: 0.35,
    ease: 'power3.out',
  });

  hoverTl = tl;
}

export function stopHoverSuck() {
  hoverTl?.kill();
  hoverEl?.remove();
  hoverTl = null;
  hoverEl = null;
  hoverPendingComplete = null;
  hidePortal();
  if (!isSelectionActive) {
    progressBar?.hide();
    progressBar?.reset();
  }
}

// ===== Click: suck preview image FROM center INTO right side (Matter.js physics) =====
// ===== Click: instant particle burst from top, then progress bar =====
export function startInstantBurst(src: string, onComplete: () => void) {
  stopSelectSuck();
  stopHoverSuck();
  isSelectionActive = true;

  if (!progressBar) progressBar = new ProgressBar();

  particleSystem = new ParticleSystem(src);

  // Instant burst: lots of particles from the top, scattering left/right
  const screenW = window.innerWidth;
  for (let i = 0; i < 120; i++) {
    const x = Math.random() * screenW;
    const angle = 90 + (Math.random() - 0.5) * 160; // 10° ~ 170°
    const speed = 500 + Math.random() * 1200;
    particleSystem?.emit(x, -20, angle, speed, 0);
  }

  // Show progress bar then start it after bars are ready
  progressBar.show(src).then(() => {
    startProgressEffects();
    progressBar?.start(() => {
      isSelectionActive = false;
      stopProgressEffects();
      setTimeout(() => onComplete(), 120);
    });
  });
}

export function startSelectSuck(src: string, onComplete: () => void) {
  stopSelectSuck();
  stopHoverSuck();
  isSelectionActive = true;

  let pv: { w: number; h: number; x: number; y: number };
  const domRect = getPreviewRectFromDOM();
  if (domRect) {
    pv = domRect;
  } else {
    pv = computePreviewRect(src);
  }

  const startW = pv.w;
  const startH = pv.h;
  const startX = pv.x + startW / 2;
  const startY = pv.y + startH / 2;

  selectEl = createFlyingElement(src, pv.x, pv.y, startW, startH, 200);
  showPortal(true);

  if (!progressBar) progressBar = new ProgressBar();
  progressBar.show(src);

  particleSystem = new ParticleSystem(src);

  const engine = Matter.Engine.create();
  engine.gravity.y = 0;
  engine.gravity.x = 0;

  const cardBody = Matter.Bodies.rectangle(startX, startY, startW, startH, {
    angle: 0,
    restitution: 0,
    friction: 0.001,
    frictionAir: 0.003,
  });

  const wallBody = Matter.Bodies.rectangle(
    window.innerWidth + 150,
    window.innerHeight / 2,
    300,
    window.innerHeight * 2,
    { isStatic: true, isSensor: true }
  );

  Matter.Composite.add(engine.world, [cardBody, wallBody]);

  Matter.Body.setVelocity(cardBody, { x: 16 + Math.random() * 6, y: 0 });
  Matter.Body.setAngularVelocity(cardBody, (Math.random() - 0.5) * 0.06);

  const portalX = window.innerWidth;
  let prevPenetration = 0;

  function tick() {
    Matter.Engine.update(engine, 1000 / 60);

    const cx = cardBody.position.x;
    const cy = cardBody.position.y;
    const angle = cardBody.angle;

    const corners = getRotatedCorners(cx, cy, angle, startW, startH);
    const rightMostX = Math.max(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
    const penetration = Math.max(0, rightMostX - portalX);
    const swallowed = Math.max(0, penetration - prevPenetration);
    prevPenetration = penetration;
    const exitRatio = Math.min(1, penetration / startW);

    // Slow down as the card interacts with / penetrates the portal edge
    if (exitRatio > 0) {
      const extraFriction = 0.03 * exitRatio * exitRatio;
      cardBody.frictionAir = 0.003 + extraFriction;
      const drag = 0.012 * exitRatio;
      const v = cardBody.velocity;
      let newVx = v.x * (1 - drag);
      let newVy = v.y * (1 - drag);
      // Minimum forward speed to guarantee eventual swallowing
      const minVx = 2.5;
      if (newVx < minVx) {
        newVx = minVx;
      }
      Matter.Body.setVelocity(cardBody, { x: newVx, y: newVy });
    } else {
      cardBody.frictionAir = 0.003;
    }

    if (selectEl) {
      selectEl.style.left = `${cx - startW / 2}px`;
      selectEl.style.top = `${cy - startH / 2}px`;
      selectEl.style.width = `${startW}px`;
      selectEl.style.height = `${startH}px`;
      selectEl.style.transform = `rotate(${angle}rad)`;

      if (exitRatio > 0.5) {
        selectEl.style.opacity = `${Math.max(0, 1 - (exitRatio - 0.5) / 0.5)}`;
      }
    }

    const intersection = intersectRectWithVerticalLine(corners, portalX);
    if (intersection && exitRatio < 1) {
      const segLength = Math.abs(intersection[1].y - intersection[0].y);

      // Particles: emitted along the entire intersection segment
      // More pixels swallowed this frame → higher particle speeds
      const speedFactor = 0.5 + 1.6 * Math.min(1, swallowed / 15);
      const particlesPerFrame = Math.max(3, Math.min(24, Math.floor(segLength / 40)));
      for (let i = 0; i < particlesPerFrame; i++) {
        const t = Math.random();
        const py = intersection[0].y + (intersection[1].y - intersection[0].y) * t;
        const baseAngle = 180 - (t - 0.5) * 70;
        const pAngle = baseAngle + (Math.random() - 0.5) * 14;
        const pSpeed = (300 + Math.random() * 500) * speedFactor;
        particleSystem?.emit(portalX, py, pAngle, pSpeed, 0);
      }
    }

    // Progress bar right-edge FX: starts as soon as collision begins
    if (exitRatio > 0) {
      const bounds = progressBar?.getBounds();
      if (bounds) {
        const py = bounds.top + Math.random() * (bounds.bottom - bounds.top);
        const t = (py - bounds.top) / Math.max(1, bounds.bottom - bounds.top);
        const baseAngle = 180 - (t - 0.5) * 70;
        const count = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < count; i++) {
          const pAngle = baseAngle + (Math.random() - 0.5) * 14;
          const pSpeed = 300 + Math.random() * 500;
          particleSystem?.emit(window.innerWidth, py, pAngle, pSpeed, 0);
        }
      }
    }

    const cardEls = document.querySelectorAll('[data-card-item]');
    const cardRects: Array<{ x: number; y: number; w: number; h: number }> = [];
    cardEls.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        cardRects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      }
    });
    particleSystem?.setCardRects(cardRects);
    particleSystem?.update(1 / 60);
    particleSystem?.render();

    if (cx < portalX + startW * 2.5) {
      selectRaf = requestAnimationFrame(tick);
    } else {
      stopSelectSuck(true);
      const bounds = progressBar?.getBounds();
      startProgressEffects();
      progressBar?.start(() => {
        isSelectionActive = false;
        stopProgressEffects();
        setTimeout(() => onComplete(), 120);
      });
    }
  }

  selectRaf = requestAnimationFrame(tick);
}

function startProgressEffects() {
  if (progressEffectInterval) return;
  progressEffectInterval = setInterval(() => {
    const screenW = window.innerWidth;

    // Rain: continuous particles falling from top
    const rainCount = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < rainCount; i++) {
      const x = Math.random() * screenW;
      const angle = 90 + (Math.random() - 0.5) * 40; // 70° ~ 110°
      const speed = 300 + Math.random() * 400;
      particleSystem?.emit(x, -10, angle, speed, 0);
    }

    const cardEls = document.querySelectorAll('[data-card-item]');
    const cardRects: Array<{ x: number; y: number; w: number; h: number }> = [];
    cardEls.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        cardRects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      }
    });
    particleSystem?.setCardRects(cardRects);
    particleSystem?.update(1 / 60);
    particleSystem?.render();
  }, 1000 / 60);
}

function stopProgressEffects() {
  if (progressEffectInterval) {
    clearInterval(progressEffectInterval);
    progressEffectInterval = null;
  }
  particleSystem?.destroy();
  particleSystem = null;
}

export function stopSelectSuck(keepEffects = false) {
  if (selectRaf) {
    cancelAnimationFrame(selectRaf);
    selectRaf = null;
  }
  selectEl?.remove();
  selectEl = null;
  if (!keepEffects) {
    particleSystem?.destroy();
    particleSystem = null;
  }
  hidePortal();
  progressBar?.reset();
}

// ===== Cleanup everything =====
export function cleanupAllAnimations() {
  isSelectionActive = false;
  stopHoverSuck();
  stopSelectSuck();
  stopProgressEffects();
  progressBar?.destroy();
  progressBar = null;
}
