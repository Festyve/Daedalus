// Brush verbs + Taubin smoothing for the sculpt engine (SPEC §7.3-7.4).
//
// These are PURE functions over flat Float32Array buffers (no three.js scene
// state), so they are unit-testable and allocation-free in the hot loop. Each
// verb mutates `positions` in place for a single vertex index `vi`, given the
// falloff weight `w` (0..1) and a shared `BrushContext` of reused scratch +
// per-stroke parameters. `taubinSmooth` runs a volume-preserving smoothing pass
// over a dirty vertex set using precomputed adjacency.
import type * as THREE from "three";

// Per-stroke parameters + reused scratch. The engine fills this once per stroke
// and reuses it across every affected vertex (zero per-vertex allocation).
export interface BrushContext {
    // brush center in object space (the unprojected fingertip point)
    center: THREE.Vector3;
    // fingertip displacement since last frame, object space (Grab)
    drag: THREE.Vector3;
    // scalar push amount per unit weight (Inflate/Draw/Crease)
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

// Smooth, volume-friendly radial falloff. t = d / r in [0, 1].
//   falloff(0) = 1 (full strength at brush center)
//   falloff(1) = 0 (zero at the brush edge)
export function falloff(t: number): number {
    const u = 1 - t * t;
    return u * u;
}

// Read vertex vi out of a flat xyz buffer into `out`.
function readVertex(positions: Float32Array, vi: number, out: THREE.Vector3): THREE.Vector3 {
    const i = vi * 3;
    return out.set(positions[i], positions[i + 1], positions[i + 2]);
}

// Write `v` back into vertex vi of a flat xyz buffer.
function writeVertex(positions: Float32Array, vi: number, v: THREE.Vector3): void {
    const i = vi * 3;
    positions[i] = v.x;
    positions[i + 1] = v.y;
    positions[i + 2] = v.z;
}

// Grab/Move — drag the vertex along the fingertip delta. v += w * drag.
export function grab(positions: Float32Array, _normals: Float32Array, vi: number, w: number, ctx: BrushContext): void {
    const v = readVertex(positions, vi, ctx.tmpA);
    v.addScaledVector(ctx.drag, w);
    writeVertex(positions, vi, v);
}

// Inflate — push the vertex outward along its own normal. v += w * strength * n_v.
export function inflate(positions: Float32Array, normals: Float32Array, vi: number, w: number, ctx: BrushContext): void {
    const v = readVertex(positions, vi, ctx.tmpA);
    const i = vi * 3;
    const n = ctx.tmpB.set(normals[i], normals[i + 1], normals[i + 2]);
    v.addScaledVector(n, w * ctx.strength);
    writeVertex(positions, vi, v);
}

// Draw — push along the averaged brush normal. v += w * strength * n_brushAvg.
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
// plane, i.e. move along the in-plane component of (center - v) by weight w.
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

// Taubin smoothing (SPEC §7.4): a positive Laplacian step (lambda) followed by a
// negative un-shrink step (mu) per iteration. The two opposing steps form a
// band-pass filter that removes high-frequency noise WITHOUT the volume loss of
// plain Laplacian smoothing — mandatory so the donut tube does not deflate.
//
//   positions : flat xyz buffer, mutated in place
//   adjacency : per-vertex neighbor index lists (built once by the engine)
//   dirtySet  : the vertices to smooth (dirty region only)
//   lambda    : positive smoothing factor (~0.5)
//   mu        : negative inflating factor (~-0.53, |mu| > lambda)
//   iters     : number of (lambda, mu) iterations (1-2 in practice)
export function taubinSmooth(
    positions: Float32Array,
    adjacency: number[][],
    dirtySet: Iterable<number>,
    lambda = 0.5,
    mu = -0.53,
    iters = 1,
): void {
    const verts: number[] = [];
    for (const vi of dirtySet) verts.push(vi);
    if (verts.length === 0) return;

    // Snapshot of just the dirty vertices, so each pass reads pre-pass positions
    // (in-place neighbor reads would bias the centroid and break the math).
    const snapshot = new Float32Array(verts.length * 3);

    const applyStep = (factor: number): void => {
        // copy current positions of dirty verts into the snapshot
        for (let k = 0; k < verts.length; k++) {
            const i = verts[k] * 3;
            snapshot[k * 3] = positions[i];
            snapshot[k * 3 + 1] = positions[i + 1];
            snapshot[k * 3 + 2] = positions[i + 2];
        }
        // map vertex index → snapshot slot for O(1) neighbor lookup
        const slot = new Map<number, number>();
        for (let k = 0; k < verts.length; k++) slot.set(verts[k], k);

        for (let k = 0; k < verts.length; k++) {
            const vi = verts[k];
            const neighbors = adjacency[vi];
            if (!neighbors || neighbors.length === 0) continue;
            // umbrella centroid of neighbors (read from snapshot when the
            // neighbor is itself dirty, else from the live buffer — clean
            // neighbors are unchanged this pass anyway)
            let cx = 0, cy = 0, cz = 0;
            for (let n = 0; n < neighbors.length; n++) {
                const nv = neighbors[n];
                const ns = slot.get(nv);
                if (ns !== undefined) {
                    cx += snapshot[ns * 3];
                    cy += snapshot[ns * 3 + 1];
                    cz += snapshot[ns * 3 + 2];
                } else {
                    const ni = nv * 3;
                    cx += positions[ni];
                    cy += positions[ni + 1];
                    cz += positions[ni + 2];
                }
            }
            const inv = 1 / neighbors.length;
            cx *= inv; cy *= inv; cz *= inv;
            // v += factor * (centroid - v_snapshot)
            const px = snapshot[k * 3], py = snapshot[k * 3 + 1], pz = snapshot[k * 3 + 2];
            const i = vi * 3;
            positions[i] = px + factor * (cx - px);
            positions[i + 1] = py + factor * (cy - py);
            positions[i + 2] = pz + factor * (cz - pz);
        }
    };

    for (let it = 0; it < iters; it++) {
        applyStep(lambda); // shrink
        applyStep(mu);     // un-shrink (volume preservation)
    }
}
