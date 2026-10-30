// The document model every Blend dock unit reads and writes — the shape a working document has when
// nothing about painting, the DOM or the host is involved. It is deliberately the same shape the undo
// records and the .cud file use, because those two already had to agree on what a document IS:
// pixels plus placement plus a strip of attributes, and nothing derived.

export const WORK_STACK = 'layer';
export const GUIDANCE_STACK = 'guidance';
export type StackId = typeof WORK_STACK | typeof GUIDANCE_STACK;

// The pure Mask layer is not a member of `layers`; id 0 is how it keeps the same shape as one.
export const MASK_LAYER_ID = 0;

// A pixel buffer, from the model's point of view: a canvas (writable) or a decoded image (immutable).
// Which one it is only ever matters to the sharing rule in assets.ts, so it stays opaque here.
export type BlendBuffer = unknown;

export interface Transform {
    cx: number; cy: number; w: number; h: number; rotation: number;
}

export const cloneTransform = (t: Transform): Transform =>
    ({ cx: t.cx, cy: t.cy, w: t.w, h: t.h, rotation: t.rotation });

// A link to a file on disk. Immutable and shared by reference: relinking swaps the whole object, so
// an undo step pointing at the old one cannot drift.
export interface CudLink {
    name: string;
    token?: string;
    [k: string]: unknown;
}

export interface Layer {
    id: number;
    name: string;
    note?: string;
    visible: boolean;
    transform: Transform;
    // The one identity that lives on the layer: which record of the source table holds its pixels.
    srcRef: string | null;
    stack: StackId;
    fragment: boolean;
    raster: boolean;
    // （`stash` 这一格随图层种类一起删了 —— 它是条带上一枚 attribute，见 attr/stash.js。）
    // The strip: ordered guids into the attribute table. Order IS the execution order, left to right.
    attrs: string[];
    cud: CudLink | null;
    isMaskLayer?: boolean;
    // Derived, never snapshotted: invalidated by the resolved-chain's own identity key.
    fxCache: unknown;
    // Views installed by attachSourceView / attachAttrView. Reading `l.img` is what keeps ~300 call
    // sites from having to know a table exists; writing it always lands in writeSource.
    img: BlendBuffer;
    src: string;
    mask: BlendBuffer;
    decal: BlendBuffer;
    effects: unknown[];
    text: unknown;
    dir: unknown;
    three: boolean;
    sceneUid: string | null;
}

export const stackOf = (l: Layer): StackId => (l.stack === GUIDANCE_STACK ? GUIDANCE_STACK : WORK_STACK);

// A record of the attribute table: one attribute is a countable object, so it can be reordered and
// duplicated by reference. `enabled` absent reads as true, so a snapshot only ever carries `false`.
export interface AttrRecord {
    id: string;
    type: string;
    enabled: boolean;
    [k: string]: unknown;
}

export interface DocSnapshot {
    canvasW: number;
    canvasH: number;
    canvasCustom: boolean;
    selectedId: number | null;
    group: number[];
    maskVisible: boolean;
    // Per-layer VALUES plus the srcRef label they came from: the table is derived state, so a history
    // record never needs the table to hold anything alive.
    layers: LayerSnapshot[];
    maskDecal: BlendBuffer;
}

export interface LayerSnapshot {
    id: number;
    name: string;
    src: string;
    img: BlendBuffer;
    srcRef: string | null;
    visible: boolean;
    fragment: boolean;
    raster: boolean;
    three: boolean;
    sceneUid: string | null;
    stack: StackId;
    cud: CudLink | null;
    text: unknown;
    dir: unknown;
    transform: Transform;
    attrs: AttrSnapshot[];
}

export interface AttrSnapshot {
    id: string;
    type: string;
    payload: Record<string, unknown>;
    enabled?: boolean;
}
