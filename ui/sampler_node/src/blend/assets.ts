// The source-asset table: layers hold one guid (`srcRef`), the pixels live here. The table exists for
// exactly one reason — sharing has to be a countable object, so that duplicating a smart layer makes
// the copy and the original point at the SAME record (Photoshop's smart-object semantics) while any
// change of pixels from either side breaks that share automatically.
//
// The three rules, unchanged from the engine this replaces:
//   · Only decoded images may be shared; a writable canvas is always private. That is enforced by the
//     DATA FORM (`shareableSourceBuffer`), not by a list of layer types: an overwritable buffer can
//     never be the record two layers read, so "mutate a shared source in place" is unwriteable.
//   · Reference counts are SCANNED, never stored — undo replays and tab switches rewrite whole
//     arrays, and a stored count would drift under exactly those.
//   · The table is derived state. History and .cud carry per-layer VALUES plus the srcRef label, so
//     a record is only ever alive for the layers on screen; anything nobody points at is released.
import type { BlendBuffer, Layer, LayerSnapshot } from './model';

export interface AssetRecord {
    id: string;
    img: BlendBuffer;
    src: string;
}

const isWritableBuffer = (buf: BlendBuffer): boolean =>
    !!buf && typeof (buf as { getContext?: unknown }).getContext === 'function';

// Shareable means immutable: a canvas that gets repainted cannot be the one record two layers read.
export const shareableSourceBuffer = (buf: BlendBuffer): boolean => !!buf && !isWritableBuffer(buf);

// `src` is a path string; the setter's value arrives typed as a buffer because one accessor serves
// both fields, so the string side gets coerced at the table's boundary rather than at 300 call sites.
const str = (v: BlendBuffer): string => (v == null ? '' : String(v));

// `live()` is what the panel currently shows (the layer array plus the Mask layer); `outside()` adds
// holders the table cannot see in that array but which still own pixels — the clipboard being the one
// that matters: copy a layer, delete it, paste, and the buffer must have survived the middle step.
export class SourceTable {
    private seq = 0;
    private readonly records = new Map<string, AssetRecord>();

    constructor(
        private readonly live: () => Layer[],
        private readonly outside: () => (Layer | null)[] = () => [],
    ) {}

    mint(img: BlendBuffer, src: string): AssetRecord {
        const a: AssetRecord = { id: 'img_' + (++this.seq), img: img || null, src: src || '' };
        this.records.set(a.id, a);
        return a;
    }

    find(ref: string | null | undefined): AssetRecord | null {
        return ref ? this.records.get(ref) || null : null;
    }

    refs(ref: string | null | undefined): number {
        if (!ref) return 0;
        let n = 0;
        for (const l of this.live()) if (l && l.srcRef === ref) n++;
        for (const l of this.outside()) if (l && l.srcRef === ref) n++;
        return n;
    }

    // Only a live layer's srcRef points into this table: a snapshot record carries the same label but
    // is a value, not a view, so sharing from one always falls back to "take your own copy".
    private isLive(l: Layer): boolean {
        return this.live().includes(l);
    }

    liveAsset(l: Layer): AssetRecord | null {
        const a = this.find(l && l.srcRef);
        return a && this.isLive(l) ? a : null;
    }

    // The single exit for writing a source. Shared → swap in a record of one's own first.
    write(l: Layer, field: 'img' | 'src', value: BlendBuffer): void {
        let a = this.find(l.srcRef);
        if (!a || this.refs(a.id) > 1) {
            a = this.mint(field === 'img' ? value : (a ? a.img : null),
                field === 'src' ? str(value) : (a ? a.src : ''));
            l.srcRef = a.id;
        } else if (field === 'img') {
            a.img = value;
        } else {
            a.src = str(value);
        }
    }

    own(l: Layer, img: BlendBuffer, src: string): Layer {
        l.srcRef = this.mint(img, src).id;
        return l;
    }

    // A copy points at the same record as its source — but only while that record is a live layer's
    // and is immutable. Otherwise the caller's already-cloned value stays, which is what keeps two
    // layers from ever ending up on one canvas that gets repainted.
    shareWith(l: Layer, from: Layer): Layer {
        const a = this.liveAsset(from);
        if (!a || !shareableSourceBuffer(a.img)) return this.own(l, l.img, l.src);
        l.srcRef = a.id;
        return l;
    }

    // Replaying one history record: one label becomes one record, so sharing survives undo, redo and a
    // tab round trip. The value itself still travels per layer.
    restore(l: Layer, ls: LayerSnapshot, byRef: Map<string, AssetRecord>): Layer {
        if (!ls.srcRef) return this.own(l, ls.img, ls.src);
        let a = byRef.get(ls.srcRef);
        if (!a) {
            a = this.mint(ls.img, ls.src);
            byRef.set(ls.srcRef, a);
        }
        l.srcRef = a.id;
        return l;
    }

    // Nothing unreferenced stays: a record whose pixels were swapped out would otherwise hold that
    // canvas for the rest of the session. History keeps its own values and needs no keeper.
    prune(): void {
        for (const ref of [...this.records.keys()]) if (this.refs(ref) === 0) this.records.delete(ref);
    }

    size(): number {
        return this.records.size;
    }
}

// Installs the `img` / `src` views. Left separate from attachAttrView so the two tables stay
// independent modules; the store calls both for every layer that comes out of a factory.
export function attachSourceView(l: Layer, table: SourceTable): Layer {
    for (const field of ['img', 'src'] as const) {
        Object.defineProperty(l, field, {
            configurable: true,
            get(this: Layer) {
                const a = table.find(this.srcRef);
                return a ? a[field] : (field === 'src' ? '' : null);
            },
            set(this: Layer, v: BlendBuffer) { table.write(this, field, v); },
        });
    }
    return l;
}
