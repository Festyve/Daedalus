// Brush verb kernels + Taubin smoothing + falloff (SPEC §6.2, §6.3).
//
// These are PURE functions over flat Float32Array buffers (no three.js scene
// state), so they are unit-testable and allocation-free in the hot loop. The
// SculptEngine (src/sculpt/engine.ts) drives them: it gathers the dirty vertex
// set via a BVH radius query, then for each affected vertex calls a verb kernel
// with the radial falloff weight `w` (0..1) and a shared `BrushContext` of
// reused scratch + per-stroke parameters. Smooth is its own volume-preserving
// path through `taubinSmooth` (no per-vertex kernel).
//
// HARD RULES honored here (SPEC §6.2):
//   - Smoothing is ALWAYS Taubin (λ=0.5, μ=−0.53), never plain Laplacian — the
//     negative μ un-shrink pass preserves volume (sphere drift <5% / 10 iters).
//   - Zero per-call allocation beyond one-time setup — `taubinSmooth` reuses
//     module-level scratch buffers that grow lazily and are otherwise constant.
import type * as THREE from "three";
import { BrushVerb } from "../types";

// Per-stroke parameters + reused scratch. The engine fills this once per stroke
// and reuses it across every affected vertex (zero per-vertex allocation).
export interface BrushContext {
    // brush center in object space (the unprojected fingertip point)
    center: THREE.Vector3;
    // fingertip displacement since last frame, object space (Grab)
    drag: THREE.Vector3;
    // scalar push amount per unit weight (Inflate/Draw)
    strength: number;
    // averaged surface normal under the brush (Draw)
    brushNormal: THREE.Vector3;
    // area-average point + its plane normal (Flatten)
    planePoint: THREE.Vector3;
    planeNormal: THREE.Vector3;
    // reused scratch vectors (no allocation inside verbs)
    tmpA: THREE.Vector3;
    tmpB: THREE.Vector3;
}

// Per-vertex brush kernel signature. `positions`/`normals` are flat xyz buffers;
// `vi` is the vertex index; `w` is the radial falloff weight (0..1); `ctx`
// carries the shared per-stroke frame. Mutates `positions` in place.
export type BrushKernel = (
    positions: Float32Array,
    normals: Float32Array,
    vi: number,
    w: number,
    ctx: BrushContext,
) => void;

// ---------------------------------------------------------------------------
// Falloff (SPEC §6.3): w = (1 − (d/r)²)²
// ---------------------------------------------------------------------------
// Smooth, volume-friendly radial falloff. With one argument it takes the
// already-normalized ratio t = d/r in [0,1] (how the engine calls it). With two
// arguments it takes the raw distance `d` and radius `r` and normalizes itself.
//   falloff(0)    = 1   (full strength at the brush center)
//   falloff(1)    = 0   (zero at the brush edge)
//   falloff(d, r) = (1 − (d/r)²)²
export function falloff(d: number, r = 1): number {
    const t = d / r;
    const u = 1 - t * t;
    return u * u;
}

// ---------------------------------------------------------------------------
// Flat-buffer vertex read/write helpers (no allocation; reuse caller's `out`).
// ---------------------------------------------------------------------------
function readVertex(positions: Float32Array, vi: number, out: THREE.Vector3): THREE.Vector3 {
    const i = vi * 3;
    return out.set(positions[i], positions[i + 1], positions[i + 2]);
}

function writeVertex(positions: Float32Array, vi: number, v: THREE.Vector3): void {
    const i = vi * 3;
    positions[i] = v.x;
    positions[i + 1] = v.y;
    positions[i + 2] = v.z;
}

// ---------------------------------------------------------------------------
// Brush verb kernels (SPEC §6.3): Grab · Inflate · Draw · Flatten.
// Smooth is handled by `taubinSmooth`, not a per-vertex kernel.
// ---------------------------------------------------------------------------

// Grab — drag the vertex along the fingertip delta. v += w · drag.
export function grab(positions: Float32Array, _normals: Float32Array, vi: number, w: number, ctx: BrushContext): void {
    const v = readVertex(positions, vi, ctx.tmpA);
    v.addScaledVector(ctx.drag, w);
    writeVertex(positions, vi, v);
}

// Inflate — push the vertex outward along its own normal. v += w · strength · n_v.
export function inflate(positions: Float32Array, normals: Float32Array, vi: number, w: number, ctx: BrushContext): void {
    const v = readVertex(positions, vi, ctx.tmpA);
    const i = vi * 3;
    const n = ctx.tmpB.set(normals[i], normals[i + 1], normals[i + 2]);
    v.addScaledVector(n, w * ctx.strength);
    writeVertex(positions, vi, v);
}

// Draw — push along the averaged brush normal (one direction for the whole
// stroke → a clean raised stamp). v += w · strength · n_brushAvg.
export function draw(positions: Float32Array, _normals: Float32Array, vi: number, w: number, ctx: BrushContext): void {
    const v = readVertex(positions, vi, ctx.tmpA);
    v.addScaledVector(ctx.brushNormal, w * ctx.strength);
    writeVertex(positions, vi, v);
}

// Flatten — move the vertex toward the area-average plane by weight w. The
// signed distance to the plane is projected out along the plane normal.
export function flatten(positions: Float32Array, _normals: Float32Array, vi: number, w: number, ctx: BrushContext): void {
    const v = readVertex(positions, vi, ctx.tmpA);
    const delta = ctx.tmpB.copy(v).sub(ctx.planePoint);
    const signed = delta.dot(ctx.planeNormal);
    v.addScaledVector(ctx.planeNormal, -signed * w);
    writeVertex(positions, vi, v);
}

// Pinch — draw the vertex toward the brush axis (center) within the tangent
// plane, i.e. move along the in-plane component of (center − v) by weight w.
// Used by the sculpt engine's Pinch/Crease verbs.
export function pinch(positions: Float32Array, _normals: Float32Array, vi: number, w: number, ctx: BrushContext): void {
    const v = readVertex(positions, vi, ctx.tmpA);
    const toCenter = ctx.tmpB.copy(ctx.center).sub(v);
    // remove the component along the plane normal → stay in the tangent plane
    const along = toCenter.dot(ctx.planeNormal);
    toCenter.addScaledVector(ctx.planeNormal, -along);
    v.addScaledVector(toCenter, w);
    writeVertex(positions, vi, v);
}

// Crease — pinch toward the axis plus a negative draw (sink along the brush
// normal) → a sharp inward valley. Combines pinch + inward push.
export function crease(positions: Float32Array, normals: Float32Array, vi: number, w: number, ctx: BrushContext): void {
    pinch(positions, normals, vi, w, ctx);
    const v = readVertex(positions, vi, ctx.tmpA);
    v.addScaledVector(ctx.brushNormal, -w * ctx.strength);
    writeVertex(positions, vi, v);
}

// Verb → kernel lookup for the displacement brushes (Grab/Inflate/Draw/Flatten).
// Smooth has no per-vertex kernel — the engine routes it to `taubinSmooth`. The
// record is frozen so callers can index it directly without a switch.
export const BRUSH_KERNELS: Readonly<Partial<Record<BrushVerb, BrushKernel>>> = Object.freeze({
    [BrushVerb.Grab]: grab,
    [BrushVerb.Inflate]: inflate,
    [BrushVerb.Draw]: draw,
    [BrushVerb.Flatten]: flatten,
});

// ---------------------------------------------------------------------------
// Taubin smoothing (SPEC §6.2, §6.3) — the ONLY smoothing path.
// ---------------------------------------------------------------------------
// Each iteration runs a positive Laplacian step (λ) followed by a negative
// un-shrink step (μ, |μ| > λ). The two opposing umbrella passes form a band-pass
// filter that removes high-frequency noise WITHOUT the volume loss of plain
// Laplacian smoothing — mandatory so the torus tube does not deflate and so a
// unit sphere drifts <5% in volume over 10 iterations.
//
// Allocation policy: zero per-call allocation beyond one-time setup. Three
// module-level scratch buffers (`SNAPSHOT`, `VERT_LIST`, `SLOT_OF`) are reused
// across every call and only grow when a larger dirty set / mesh is seen; they
// are never reallocated for the common steady-state stroke.
let SNAPSHOT = new Float32Array(0);   // pre-pass positions of the dirty verts (3 floats each)
let VERT_LIST = new Int32Array(0);    // materialized dirty vertex indices
let SLOT_OF = new Int32Array(0);      // vertexIndex → slot in VERT_LIST, or -1 (sparse, O(dirty) reset)

// Ensure the dirty-set scratch (`SNAPSHOT`, `VERT_LIST`) holds at least `n` verts.
function ensureDirtyCapacity(n: number): void {
    if (VERT_LIST.length < n) {
        VERT_LIST = new Int32Array(n);
        SNAPSHOT = new Float32Array(n * 3);
    }
}

// Ensure the vertex→slot map covers vertex index `vi`. Grows with headroom so a
// growing mesh does not reallocate every stroke; entries are initialized to -1.
function ensureSlotCapacity(vi: number): void {
    if (SLOT_OF.length <= vi) {
        const next = new Int32Array(Math.max(vi + 1, SLOT_OF.length * 2));
        next.fill(-1);
        SLOT_OF = next;
    }
}

export function taubinSmooth(
    positions: Float32Array,
    neighbors: ReadonlyArray<ReadonlyArray<number>>,
    dirtySet: Iterable<number>,
    lambda = 0.5,
    mu = -0.53,
    iters = 1,
): void {
    // Materialize the dirty set into a dense index list and build the sparse
    // vertex→slot map (so neighbor lookups know which neighbors are themselves
    // dirty). Both reuse module scratch; SLOT_OF entries are reset to -1 below.
    let count = 0;
    for (const vi of dirtySet) {
        ensureDirtyCapacity(count + 1);
        VERT_LIST[count] = vi;
        count++;
    }
    if (count === 0) return;

    for (let k = 0; k < count; k++) {
        const vi = VERT_LIST[k];
        ensureSlotCapacity(vi);
        SLOT_OF[vi] = k;
    }

    // One umbrella step at the given factor. Reads pre-pass positions from
    // SNAPSHOT (so neighbor reads are unbiased by in-place writes this pass) and
    // writes the new positions back into the live buffer.
    const applyStep = (factor: number): void => {
        // snapshot the current positions of just the dirty verts
        for (let k = 0; k < count; k++) {
            const i = VERT_LIST[k] * 3;
            const s = k * 3;
            SNAPSHOT[s] = positions[i];
            SNAPSHOT[s + 1] = positions[i + 1];
            SNAPSHOT[s + 2] = positions[i + 2];
        }

        for (let k = 0; k < count; k++) {
            const vi = VERT_LIST[k];
            const nbrs = neighbors[vi];
            if (!nbrs || nbrs.length === 0) continue;

            // umbrella centroid of the neighbors. A dirty neighbor is read from
            // SNAPSHOT (its pre-pass value); a clean neighbor is unchanged this
            // pass so we read it straight from the live buffer.
            let cx = 0, cy = 0, cz = 0;
            for (let n = 0; n < nbrs.length; n++) {
                const nv = nbrs[n];
                const ns = nv < SLOT_OF.length ? SLOT_OF[nv] : -1;
                if (ns >= 0) {
                    const s = ns * 3;
                    cx += SNAPSHOT[s];
                    cy += SNAPSHOT[s + 1];
                    cz += SNAPSHOT[s + 2];
                } else {
                    const ni = nv * 3;
                    cx += positions[ni];
                    cy += positions[ni + 1];
                    cz += positions[ni + 2];
                }
            }
            const inv = 1 / nbrs.length;
            cx *= inv; cy *= inv; cz *= inv;

            // v += factor · (centroid − v_prePass)
            const s = k * 3;
            const px = SNAPSHOT[s], py = SNAPSHOT[s + 1], pz = SNAPSHOT[s + 2];
            const i = vi * 3;
            positions[i] = px + factor * (cx - px);
            positions[i + 1] = py + factor * (cy - py);
            positions[i + 2] = pz + factor * (cz - pz);
        }
    };

    for (let it = 0; it < iters; it++) {
        applyStep(lambda); // λ: Laplacian shrink (low-pass)
        applyStep(mu);     // μ: negative un-shrink (volume preservation)
    }

    // Reset only the touched SLOT_OF entries → O(dirty), no full-buffer clear.
    for (let k = 0; k < count; k++) SLOT_OF[VERT_LIST[k]] = -1;
}
