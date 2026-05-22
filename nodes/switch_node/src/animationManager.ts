import gsap from 'gsap';

// ===== Internal state =====
let hoverTl: gsap.core.Timeline | null = null;
let hoverEl: HTMLDivElement | null = null;
let hoverPendingComplete: (() => void) | null = null;
let selectTl: gsap.core.Timeline | null = null;
let selectEl: HTMLDivElement | null = null;

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
  const maxW = window.innerWidth * 0.9;   // matches CSS maxWidth: 90vw
  const maxH = window.innerHeight * 0.60; // matches CSS maxHeight: 60vh
  const ratio = naturalW / naturalH;
  let w = maxW;
  let h = w / ratio;
  if (h > maxH) {
    h = maxH;
    w = h * ratio;
  }
  return { w, h };
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
  `;
  el.innerHTML = `<img src="${src}" style="width:100%;height:100%;object-fit:cover;">`;
  document.body.appendChild(el);
  return el as HTMLDivElement;
}

// ===== Hover: suck preview image out FROM card TO center preview position =====
export function startHoverSuck(src: string, cardRect: DOMRect, onComplete?: () => void) {
  stopHoverSuck();
  hoverPendingComplete = onComplete ?? null;

  const size = getImageSize(src);
  const preview = computePreviewSize(size.w, size.h);
  const pv = {
    w: preview.w,
    h: preview.h,
    x: (window.innerWidth - preview.w) / 2,
    y: 140,
  };

  hoverEl = createFlyingElement(src, cardRect.left, cardRect.top, cardRect.width, cardRect.height, 95);

  const tl = gsap.timeline({
    onComplete: () => {
      const cb = hoverPendingComplete;
      hoverTl = null;
      hoverPendingComplete = null;
      cb?.();
      // Defer DOM removal by one frame so React has time to render the central preview
      requestAnimationFrame(() => {
        hoverEl?.remove();
        hoverEl = null;
      });
    },
  });

  // Phase 1: pulled out — thinner + taller
  tl.to(hoverEl, {
    width: cardRect.width * 0.72,
    height: cardRect.height * 1.25,
    duration: 0.08,
    ease: 'power2.out',
  });

  // Phase 2: fly to center AND morph into the computed preview size (stay opaque)
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
}

// ===== Read current DOM preview rect (preferred over computed size) =====
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

// ===== Click: suck preview image FROM center INTO right side =====
export function startSelectSuck(src: string, onComplete: () => void) {
  stopSelectSuck();
  stopHoverSuck();

  let pv: { w: number; h: number; x: number; y: number };
  const domRect = getPreviewRectFromDOM();

  if (domRect) {
    // Use the exact rendered size/position of the central preview image
    pv = domRect;
  } else {
    // Fallback: compute from natural size (same logic as hover animation)
    const size = getImageSize(src);
    const preview = computePreviewSize(size.w, size.h);
    pv = {
      w: preview.w,
      h: preview.h,
      x: (window.innerWidth - preview.w) / 2,
      y: 140,
    };
  }

  selectEl = createFlyingElement(src, pv.x, pv.y, pv.w, pv.h, 200);

  const targetX = window.innerWidth + pv.w;
  const targetY = window.innerHeight * 0.25;

  const tl = gsap.timeline({
    onComplete: () => {
      stopSelectSuck();
      onComplete();
    },
  });

  // Single continuous morph: preview size → stretched → sucked out to right
  // power2.in = slow start, fast finish (no sudden squash)
  tl.to(selectEl, {
    x: targetX - pv.x,
    y: targetY - pv.y,
    width: pv.w * 2,
    height: pv.h * 0.2,
    opacity: 0,
    duration: 0.55,
    ease: 'power2.in',
  });

  selectTl = tl;
}

export function stopSelectSuck() {
  selectTl?.kill();
  selectEl?.remove();
  selectTl = null;
  selectEl = null;
}

// ===== Cleanup everything =====
export function cleanupAllAnimations() {
  stopHoverSuck();
  stopSelectSuck();
}
