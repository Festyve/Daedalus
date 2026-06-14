// Icing — vertex-color painting via BVH radius query (SPEC §8.3).
//
// A right-hand smear (or a chat-driven flood) lays "jam" onto the mesh by raising
// a per-vertex iced-weight mask (0 = bare steel, 1 = full icing) inside a BVH
// sphere query, then resolving the vertex `color` attribute as
//   color = lerp(white_base, design_color, mask)
// so smoothing the mask smooths the visible border. Two SPEC §8.3 rules shape the
// boundary:
//   • Height mask: icing only sticks at/above an icing line on the crown
//     (`v.y > yIcingLine`); below the line it only reaches through a NOISY drip
//     boundary so the lower edge reads like dripping jam, not a clean cut.
//   • Edge smoothing: a short Laplacian diffusion of the mask over just the
//     painted boundary band softens the freehand edge.
// The BVH refit / normal recompute is the SculptEngine's job — icing only writes
// colors, so we only dirty-range-upload the `color` attribute.
//
// Exports (SPEC §8.3 contract):
//   applyIcing(mesh, bvh, point, radius, design) → paint at a world-space point.
//   icingMask(mesh) → the per-vertex 0..1 iced-weight Float32Array (for the
//                     sprinkle sampler, which drops sprinkles on iced regions only).
import * as THREE from "three";
import { CONTAINED, INTERSECTED, NOT_INTERSECTED } from "three-mesh-bvh";
import type { MeshBVH } from "three-mesh-bvh";
import type { IcingDesign } from "../types";

// ---- Tunables (SPEC §8.3) -------------------------------------------------------

// Icing line on the mesh's own up-axis (local +Y; the torus hole axis is +Y, so
// "top" is the upper crown — see render/geometry.ts). At/above this line icing
// sticks fully; below it only the noisy drip boundary lets icing through.
const Y_ICING_LINE = 0.0;
// How far below the icing line a drip streak can still reach (object units).
const DRIP_REACH = 0.55;
// Spatial frequency of the drip columns around the ring, and the amplitude of the
// boundary noise that jitters each column's depth — this is the "noisy boundary".
const DRIP_FREQ = 8.0;
const DRIP_NOISE = 0.45;
// The crown icing line is NOT a flat circle — it undulates around the ring like
// hand-poured jam. Two non-harmonic octaves give an organic, curvy upper boundary.
const LINE_WAVE_AMP = 0.13;
const LINE_WAVE_FREQ_A = 3.0;
const LINE_WAVE_FREQ_B = 7.0;
// Laplacian smoothing iterations over the painted boundary band (§8.3).
const EDGE_SMOOTH_ITERS = 3;

// Decoration visibility (aspect #59). The material is MeshMatcapMaterial with
// vertexColors:true, which MULTIPLIES the (dark blue-steel) matcap by the vertex
// color — so jam #8B0000 reads near-black on the steel. We write a pre-compensated
// DISPLAY color that is a VIVID, SATURATED jam: computeDisplayColor() pushes the hue
// off grey (SATURATE), screen-lifts the darks toward the hue (SCREEN_LIFT), then adds
// a gloss-scaled specular sheen toward white (GLOSS_SPEC), so the multiply yields a
// luminous red — NOT a wash toward grey/white (which desaturates to pink). The
// wet/glassy sheen is added per-pixel in the matcap shader (render/scene.ts) too, so
// the hue stays rich and the highlight stays specular.
// Decorated meshes now render on a WHITE base (core/shapes), so the vertex colour renders true —
// the old matcap brightening (SCREEN_LIFT / GLOSS_SPEC, which lifted toward white to survive a dark
// blue-steel matcap MULTIPLY) is gone, since against white it just washes the icing pale. We keep
// only a saturation push so the pink stays vivid under the scene lights.
const SATURATE = 0.6;     // push channels away from their mean (richer, less grey)
const SCREEN_LIFT = 0.0;  // (disabled — white base needs no lift toward the hue)
const GLOSS_SPEC = 0.0;   // (disabled — white base needs no specular lift toward white)
// A vertex straddles the boundary when its mask differs from a neighbour's by more
// than this — those verts (plus their 1-ring) form the band we smooth.
const BOUNDARY_DELTA = 0.05;

// (1 - t²)² radial falloff — matches the sculpt brush profile so the painted
// coverage feels like the sculpt brush.
function falloff(t: number): number {
    const s = 1 - t * t;
    return s * s;
}

// Cheap deterministic value-noise in [0,1] from an angle, used to roughen the
// drip boundary without per-call allocation. Three non-harmonic octaves keep it
// organic (no obvious repeating period around the ring).
function dripNoise(angle: number): number {
    const a = 0.5 + 0.5 * Math.sin(angle * 1.0 + 0.7);
    const b = 0.5 + 0.5 * Math.sin(angle * 2.7 + 2.3);
    const c = 0.5 + 0.5 * Math.sin(angle * 5.3 + 4.1);
    return 0.5 * a + 0.32 * b + 0.18 * c;
}

// Wavy crown boundary: the y-height of the icing line at a given ring angle. The
// undulation makes the top edge of the jam read as organic, not a machined circle.
function icingLineAt(angle: number): number {
    return Y_ICING_LINE
        + LINE_WAVE_AMP * Math.sin(angle * LINE_WAVE_FREQ_A + 0.5)
        + LINE_WAVE_AMP * 0.5 * Math.sin(angle * LINE_WAVE_FREQ_B + 1.7);
}

// ---- Per-geometry icing state, cached on the geometry ---------------------------
// The mask and the smoothing adjacency are derived once from the topology and
// reused across every paint call. Keying the cache to the geometry instance means
// a morph/mesh swap (new geometry) rebuilds against the new topology automatically.
interface IcingState {
    mask: Float32Array;        // per-vertex iced weight, 0..1 (persisted)
    scratch: Float32Array;     // reused Laplacian double-buffer
    adjacency: Int32Array;     // flattened neighbour lists (CSR values)
    adjStart: Int32Array;      // CSR row offsets, length vertCount + 1
}
interface IcingHost {
    __icingState?: IcingState;
    __icingGeo?: THREE.BufferGeometry;
}

// Module-level scratch — zero allocation in the paint hot loop (SPEC §11).
const LOCAL_POINT = new THREE.Vector3();
const QUERY_SPHERE = new THREE.Sphere();
const DESIGN_COLOR = new THREE.Color();
// Pre-compensated DISPLAY color actually written to vertices (aspect #59) — the
// brightened/saturated jam that survives the matcap multiply. Module scratch so
// the paint hot loop allocates nothing (SPEC §11).
const DISPLAY_COLOR = new THREE.Color();
const CANDIDATE_VERTS = new Set<number>();
const TOUCHED = new Set<number>();
const BAND = new Set<number>();

// Build the flattened (CSR) vertex→neighbour adjacency once per geometry: dedup
// each vertex's incident neighbours, then pack into two typed arrays for fast,
// allocation-free traversal during edge smoothing.
function buildAdjacency(indexArr: Uint16Array | Uint32Array, vertCount: number): {
    adjacency: Int32Array;
    adjStart: Int32Array;
} {
    const neighbourSets: Set<number>[] = new Array(vertCount);
    for (let v = 0; v < vertCount; v++) neighbourSets[v] = new Set<number>();
    const faceCount = indexArr.length / 3;
    for (let f = 0; f < faceCount; f++) {
        const a = indexArr[f * 3], b = indexArr[f * 3 + 1], c = indexArr[f * 3 + 2];
        neighbourSets[a].add(b); neighbourSets[a].add(c);
        neighbourSets[b].add(a); neighbourSets[b].add(c);
        neighbourSets[c].add(a); neighbourSets[c].add(b);
    }
    const adjStart = new Int32Array(vertCount + 1);
    let total = 0;
    for (let v = 0; v < vertCount; v++) {
        adjStart[v] = total;
        total += neighbourSets[v].size;
    }
    adjStart[vertCount] = total;
    const adjacency = new Int32Array(total);
    let w = 0;
    for (let v = 0; v < vertCount; v++) {
        for (const nj of neighbourSets[v]) adjacency[w++] = nj;
    }
    return { adjacency, adjStart };
}

// Fetch (or lazily build) the icing state for this geometry. The mask is seeded
// from the current color attribute's deviation from the white base so a geometry
// that was already partly iced (e.g. via a prior session/import) keeps its border.
function stateFor(geometry: THREE.BufferGeometry): IcingState {
    const host = geometry as unknown as IcingHost;
    if (host.__icingState && host.__icingGeo === geometry) return host.__icingState;

    if (!geometry.index) throw new Error("icing requires indexed geometry");
    const positions = (geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
    const vertCount = positions.length / 3;
    const indexArr = geometry.index.array as Uint16Array | Uint32Array;

    const { adjacency, adjStart } = buildAdjacency(indexArr, vertCount);
    const mask = new Float32Array(vertCount);

    // Seed the mask from existing color deviation from white: a fully-design vertex
    // (color far from white) reads as mask≈1, untouched white reads as 0.
    const colorAttr = geometry.attributes.color as THREE.BufferAttribute | undefined;
    if (colorAttr) {
        const colors = colorAttr.array as Float32Array;
        for (let vi = 0; vi < vertCount; vi++) {
            const i = vi * 3;
            // mask = how far this vertex has drifted off white toward any darker hue.
            const dev = (3 - (colors[i] + colors[i + 1] + colors[i + 2])) / 3;
            mask[vi] = dev > 0 ? Math.min(1, dev) : 0;
        }
    }

    const state: IcingState = { mask, scratch: new Float32Array(vertCount), adjacency, adjStart };
    host.__icingState = state;
    host.__icingGeo = geometry;
    return state;
}

// Ensure the geometry has a writable white color attribute to paint into. The
// factory ships one (render/geometry.ts); this guards meshes that lack it.
function colorAttribute(geometry: THREE.BufferGeometry, vertCount: number): THREE.BufferAttribute {
    let colorAttr = geometry.attributes.color as THREE.BufferAttribute | undefined;
    if (!colorAttr) {
        colorAttr = new THREE.BufferAttribute(new Float32Array(vertCount * 3).fill(1), 3);
        geometry.setAttribute("color", colorAttr);
    }
    return colorAttr;
}

// Height-mask gate (SPEC §8.3): the fraction of the brush weight that can stick at
// a vertex given its height. Above the icing line → full (1). Below it, icing only
// reaches through a NOISY drip boundary whose depth varies per angular column, so
// the lower edge reads like irregular dripping jam. Returns 0 outside the drips.
function heightGate(x: number, y: number, z: number, dripBias: number): number {
    const angle = Math.atan2(z, x);
    const line = icingLineAt(angle);
    if (y >= line) return 1;
    // Frequency-modulated streak phase → drip columns wander and curve around the
    // ring instead of sitting on an even comb, so the drips look hand-made.
    const phase = angle * DRIP_FREQ + 1.3 * Math.sin(angle * 2.3 + 0.9);
    const streak = 0.5 + 0.5 * Math.sin(phase);
    const jitter = 1 - DRIP_NOISE * dripNoise(phase);
    const reach = DRIP_REACH * (dripBias + (1 - dripBias) * streak) * jitter;
    const depth = line - y;
    if (depth > reach) return 0;
    // Fade the gate out toward the drip tip so the noisy boundary is soft.
    return 1 - depth / reach;
}

// Compute the pre-compensated DISPLAY color (aspect #59) from the literal design
// color + gloss. Because the matcap MULTIPLIES this by the dark blue-steel matcap,
// a literal dark jam reads near-black; here we saturate (push off grey), screen-
// lift (brighten darks without clipping hue), then add a gloss-scaled specular
// sheen toward white so the icing pops and glossy jam reads wet. Writes into
// DISPLAY_COLOR (module scratch). Stays strictly below white so the mask seed
// round-trip (color→deviation→mask) in stateFor() is preserved.
function computeDisplayColor(design: IcingDesign): void {
    let r = DESIGN_COLOR.r, g = DESIGN_COLOR.g, b = DESIGN_COLOR.b;
    // Saturate around the channel mean.
    const mean = (r + g + b) / 3;
    r = mean + (r - mean) * (1 + SATURATE);
    g = mean + (g - mean) * (1 + SATURATE);
    b = mean + (b - mean) * (1 + SATURATE);
    // Screen-style lift: 1 - (1 - c)(1 - k) raises darks toward the hue, not toward grey.
    r = 1 - (1 - r) * (1 - SCREEN_LIFT);
    g = 1 - (1 - g) * (1 - SCREEN_LIFT);
    b = 1 - (1 - b) * (1 - SCREEN_LIFT);
    // Gloss-scaled specular sheen toward white (wet, glassy jam).
    const spec = GLOSS_SPEC * design.gloss;
    r += (1 - r) * spec;
    g += (1 - g) * spec;
    b += (1 - b) * spec;
    // Keep strictly below pure white so painted verts always read as deviation > 0.
    DISPLAY_COLOR.setRGB(Math.min(r, 0.97), Math.min(g, 0.97), Math.min(b, 0.97));
}

// Resolve vertex color from the mask: lerp white base → DISPLAY color by mask.
function resolveColors(colors: Float32Array, mask: Float32Array, verts: Set<number>): void {
    const dr = DISPLAY_COLOR.r, dg = DISPLAY_COLOR.g, db = DISPLAY_COLOR.b;
    for (const vi of verts) {
        const i = vi * 3;
        const m = mask[vi];
        colors[i] = 1 + (dr - 1) * m;
        colors[i + 1] = 1 + (dg - 1) * m;
        colors[i + 2] = 1 + (db - 1) * m;
    }
}

// Edge-smoothing pass (SPEC §8.3): diffuse the mask across the painted boundary so
// the icing border is soft, not a hard freehand cut. Collect verts that straddle
// the mask boundary (a painted vert with a markedly-different neighbour) plus that
// 1-ring, then run a few Laplacian iterations over just that band. Band verts that
// pick up coverage are folded into `touched` so their color re-resolves.
function smoothBoundary(
    mask: Float32Array,
    scratch: Float32Array,
    adjacency: Int32Array,
    adjStart: Int32Array,
    touched: Set<number>,
): void {
    BAND.clear();
    for (const vi of touched) {
        BAND.add(vi);
        const s = adjStart[vi], e = adjStart[vi + 1];
        for (let k = s; k < e; k++) {
            const nj = adjacency[k];
            if (Math.abs(mask[nj] - mask[vi]) > BOUNDARY_DELTA) BAND.add(nj);
        }
    }
    if (BAND.size === 0) return;

    for (let iter = 0; iter < EDGE_SMOOTH_ITERS; iter++) {
        for (const vi of BAND) {
            const s = adjStart[vi], e = adjStart[vi + 1];
            let sum = mask[vi];
            let count = 1;
            for (let k = s; k < e; k++) {
                sum += mask[adjacency[k]];
                count++;
            }
            scratch[vi] = sum / count;
        }
        for (const vi of BAND) mask[vi] = scratch[vi];
    }

    for (const vi of BAND) {
        if (mask[vi] > 0.001) touched.add(vi);
    }
}

// Narrow the GPU upload to the changed vertex span (contiguous [min,max] slice),
// matching the SculptEngine's r160 updateRange handling.
function uploadRange(colorAttr: THREE.BufferAttribute, verts: Set<number>): void {
    colorAttr.needsUpdate = true;
    let min = Infinity, max = -Infinity;
    for (const vi of verts) {
        if (vi < min) min = vi;
        if (vi > max) max = vi;
    }
    if (min === Infinity) return;
    const offset = min * 3;
    const count = (max - min + 1) * 3;
    // three r160: BufferAttribute.updateRanges (array) supersedes updateRange.
    const ranged = colorAttr as unknown as {
        updateRange?: { offset: number; count: number };
        addUpdateRange?: (start: number, count: number) => void;
        clearUpdateRanges?: () => void;
    };
    if (typeof ranged.addUpdateRange === "function" && typeof ranged.clearUpdateRanges === "function") {
        ranged.clearUpdateRanges();
        ranged.addUpdateRange(offset, count);
    } else if (ranged.updateRange) {
        ranged.updateRange.offset = offset;
        ranged.updateRange.count = count;
    }
}

/**
 * Paint icing at a world-space point (SPEC §8.3).
 *
 * BVH sphere query gathers candidate triangles → unique vertices within `radius`;
 * each vertex's iced weight rises by its radial falloff, gated by the height mask
 * (icing sticks above the icing line; below it only the noisy drip boundary lets
 * it through). The painted boundary is then edge-smoothed and only the touched
 * vertex color range is uploaded. Zero allocation in the hot loop (reused scratch).
 *
 * @param point world-space brush centre (converted to mesh-local internally).
 */
export function applyIcing(
    mesh: THREE.Mesh,
    bvh: MeshBVH,
    point: THREE.Vector3,
    radius: number,
    design: IcingDesign,
): void {
    const geometry = mesh.geometry;
    const positions = (geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
    const vertCount = positions.length / 3;
    const indexArr = geometry.index!.array as Uint16Array | Uint32Array;

    const state = stateFor(geometry);
    const colorAttr = colorAttribute(geometry, vertCount);
    const colors = colorAttr.array as Float32Array;

    DESIGN_COLOR.set(design.color);
    computeDisplayColor(design); // aspect #59: brighten/saturate so the icing pops.

    // World-space brush point → mesh object space (the BVH lives in object space).
    mesh.updateWorldMatrix(true, false);
    LOCAL_POINT.copy(point);
    mesh.worldToLocal(LOCAL_POINT);

    const r = radius;
    const r2 = r * r;
    CANDIDATE_VERTS.clear();
    TOUCHED.clear();

    QUERY_SPHERE.center.copy(LOCAL_POINT);
    QUERY_SPHERE.radius = r;
    const sphere = QUERY_SPHERE;

    // 1-2: gather candidate triangles whose verts may fall within the sphere.
    bvh.shapecast({
        intersectsBounds: (box: THREE.Box3): number => {
            if (!sphere.intersectsBox(box)) return NOT_INTERSECTED;
            const contained = sphere.containsPoint(box.min) && sphere.containsPoint(box.max);
            return contained ? CONTAINED : INTERSECTED;
        },
        intersectsTriangle: (_tri: unknown, triangleIndex: number): boolean => {
            const base = triangleIndex * 3;
            CANDIDATE_VERTS.add(indexArr[base]);
            CANDIDATE_VERTS.add(indexArr[base + 1]);
            CANDIDATE_VERTS.add(indexArr[base + 2]);
            return false; // visit every candidate triangle, never stop early
        },
    });

    // 3-4: keep verts truly within r; raise iced weight by falloff × height gate.
    const mask = state.mask;
    const strength = 0.6 + 0.4 * design.gloss;                 // glossier jam lays thicker
    const dripBias = design.dripStyle === "thick" ? 0.65 : 0.4; // thicker drips reach lower
    const lx = LOCAL_POINT.x, ly = LOCAL_POINT.y, lz = LOCAL_POINT.z;
    for (const vi of CANDIDATE_VERTS) {
        const i = vi * 3;
        const px = positions[i], py = positions[i + 1], pz = positions[i + 2];
        const dx = px - lx, dy = py - ly, dz = pz - lz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        const gate = heightGate(px, py, pz, dripBias);
        if (gate <= 0) continue;
        const w = falloff(Math.sqrt(d2) / r) * strength * gate;
        const next = mask[vi] + w;
        const clamped = next < 1 ? next : 1;
        if (clamped > mask[vi]) {
            mask[vi] = clamped;
            TOUCHED.add(vi);
        }
    }
    if (TOUCHED.size === 0) return;

    smoothBoundary(mask, state.scratch, state.adjacency, state.adjStart, TOUCHED);
    resolveColors(colors, mask, TOUCHED);
    uploadRange(colorAttr, TOUCHED);
}

/**
 * Per-vertex iced weight (0 = bare, 1 = fully iced) for this mesh's geometry
 * (SPEC §8.3 / §8.4). The sprinkle sampler weights surface sampling by this mask
 * so sprinkles land on iced regions only. Lazily derived from the geometry's
 * current color attribute on first call, then accumulated by `applyIcing`.
 */
export function icingMask(mesh: THREE.Mesh): Float32Array {
    return stateFor(mesh.geometry).mask;
}
