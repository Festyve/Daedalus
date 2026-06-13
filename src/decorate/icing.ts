// Icing — vertex-color painting via BVH radius query (SPEC §9.4, Path B).
//
// Mirrors the SculptEngine §7.2 stroke loop (shapecast candidate triangles →
// unique vertices within r → falloff weight) but WRITES the geometry's `color`
// attribute toward the active IcingDesign color instead of moving positions.
// A per-vertex coverage mask (0..1) records where icing has been laid down; an
// edge-smoothing pass diffuses that mask across the painted boundary so the
// icing border reads like icing, not a freehand blob.
//
// Two entry points:
//   smearAt(ctx, worldPoint, radius, design)        — direct right-hand path
//   applyIcingRegion(ctx, design, region)           — chat-driven path
// Both converge on the same paint+smooth machinery via a shared controller that
// is lazily attached to the mesh (so repeated calls reuse the topology + mask).
import * as THREE from "three";
import {
    MeshBVH,
    computeBoundsTree,
    disposeBoundsTree,
    acceleratedRaycast,
    CONTAINED,
    INTERSECTED,
    NOT_INTERSECTED,
} from "three-mesh-bvh";
import type { SceneContext, IcingDesign } from "../types";

// Patch three.js prototypes exactly once so geometry.computeBoundsTree() and
// accelerated raycasting are available even if the SculptEngine never ran
// (idempotent — matches sculpt/engine.ts).
let PROTOTYPES_PATCHED = false;
function patchPrototypes(): void {
    if (PROTOTYPES_PATCHED) return;
    (THREE.BufferGeometry.prototype as unknown as { computeBoundsTree: typeof computeBoundsTree }).computeBoundsTree = computeBoundsTree;
    (THREE.BufferGeometry.prototype as unknown as { disposeBoundsTree: typeof disposeBoundsTree }).disposeBoundsTree = disposeBoundsTree;
    (THREE.Mesh.prototype as unknown as { raycast: typeof acceleratedRaycast }).raycast = acceleratedRaycast;
    PROTOTYPES_PATCHED = true;
}

// (1 - t^2)^2 radial falloff — identical curve to sculpt/brushes.falloff so the
// painted coverage profile matches the sculpt brush feel.
function falloff(t: number): number {
    const s = 1 - t * t;
    return s * s;
}

// Region selection threshold on the donut's own up-axis. The torus hole axis is
// local +Y (see render/geometry.ts), so "top" is the upper crown in object space.
const TOP_Y = 0.0;          // crown = local y above the tube equator
const DRIP_REACH = 0.55;    // how far below the crown a drip streak can extend
const EDGE_SMOOTH_ITERS = 3;

export class Icing {
    private readonly mesh: THREE.Mesh;
    private readonly geometry: THREE.BufferGeometry;
    private readonly bvh: MeshBVH;
    private readonly ownsBVH: boolean;

    private readonly positions: Float32Array;
    private readonly colorAttr: THREE.BufferAttribute;
    private readonly colors: Float32Array;
    private readonly indexArr: Uint16Array | Uint32Array;

    // neighbor vertices per vertex (for the mask edge-smoothing diffusion).
    private readonly adjacency: number[][];

    // per-vertex icing coverage, 0 (bare steel) .. 1 (full icing). Drives the
    // final color = lerp(baseColor, designColor, mask) so smoothing the mask
    // smooths the visible border.
    private readonly mask: Float32Array;
    private readonly designColor = new THREE.Color();

    // reused per-call scratch (no allocation in smear/region paths).
    private readonly queryS = new THREE.Sphere();
    private readonly localPoint = new THREE.Vector3();
    private readonly candidateVerts = new Set<number>();
    private readonly touched = new Set<number>();      // verts whose mask changed this call
    private readonly boundary = new Set<number>();     // mask-boundary verts for smoothing
    private readonly maskScratch: Float32Array;

    constructor(ctx: SceneContext) {
        patchPrototypes();
        this.mesh = ctx.mesh;
        this.geometry = ctx.mesh.geometry;

        if (!this.geometry.index) {
            throw new Error("Icing requires indexed geometry");
        }

        // Reuse an existing BVH (ctx.bvh, or one the SculptEngine left on the
        // geometry) so we never build a second tree; only build + own one if
        // none exists yet. We must not dispose a tree we did not create.
        const existing = ctx.bvh ?? (this.geometry as unknown as { boundsTree?: MeshBVH }).boundsTree;
        if (existing) {
            this.bvh = existing;
            this.ownsBVH = false;
        } else {
            this.bvh = new MeshBVH(this.geometry);
            (this.geometry as unknown as { boundsTree: MeshBVH }).boundsTree = this.bvh;
            this.ownsBVH = true;
        }

        this.positions = (this.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
        this.indexArr = this.geometry.index.array as Uint16Array | Uint32Array;

        // The morph geometry ships a white color attribute (render/geometry.ts).
        // If a future mesh lacks one, create it so paints have somewhere to land.
        let colorAttr = this.geometry.attributes.color as THREE.BufferAttribute | undefined;
        if (!colorAttr) {
            const vertCount = this.positions.length / 3;
            colorAttr = new THREE.BufferAttribute(new Float32Array(vertCount * 3).fill(1), 3);
            this.geometry.setAttribute("color", colorAttr);
        }
        this.colorAttr = colorAttr;
        this.colors = colorAttr.array as Float32Array;

        const vertCount = this.positions.length / 3;
        this.mask = new Float32Array(vertCount);
        this.maskScratch = new Float32Array(vertCount);
        this.adjacency = new Array(vertCount);
        this.buildAdjacency(vertCount);
    }

    // One-time vertex→neighbors topology (deduped), used by the edge smoother.
    private buildAdjacency(vertCount: number): void {
        const neighborSets: Set<number>[] = new Array(vertCount);
        for (let v = 0; v < vertCount; v++) neighborSets[v] = new Set<number>();
        const idx = this.indexArr;
        const faceCount = idx.length / 3;
        for (let f = 0; f < faceCount; f++) {
            const a = idx[f * 3], b = idx[f * 3 + 1], c = idx[f * 3 + 2];
            neighborSets[a].add(b); neighborSets[a].add(c);
            neighborSets[b].add(a); neighborSets[b].add(c);
            neighborSets[c].add(a); neighborSets[c].add(b);
        }
        for (let v = 0; v < vertCount; v++) this.adjacency[v] = Array.from(neighborSets[v]);
    }

    // Direct-hand path: smear icing at a world-space point. Converts to mesh
    // object space, runs the BVH sphere query, raises coverage with falloff,
    // then re-resolves color on the touched region (+ a boundary smoothing pass).
    smearAt(worldPoint: THREE.Vector3, radius: number, design: IcingDesign): void {
        this.mesh.updateWorldMatrix(true, false);
        this.localPoint.copy(worldPoint);
        this.mesh.worldToLocal(this.localPoint);
        this.designColor.set(design.color);
        this.paintSphere(this.localPoint, radius, design);
    }

    // Chat-driven path: flood a whole region with icing in one shot.
    //   "all"  → every vertex
    //   "top"  → the crown (local y above the tube equator)
    //   "drip" → the crown plus noise-modulated downward streaks on the flanks
    applyIcingRegion(design: IcingDesign, region: "top" | "all" | "drip"): void {
        this.designColor.set(design.color);
        this.touched.clear();
        const pos = this.positions;
        const vertCount = this.mask.length;
        const noiseScale = 8.0;
        const dripBias = design.dripStyle === "thick" ? 0.65 : 0.4;
        const edgeNoise = design.edgeNoise;
        for (let vi = 0; vi < vertCount; vi++) {
            const i = vi * 3;
            const x = pos[i], y = pos[i + 1], z = pos[i + 2];
            let target = 0;
            if (region === "all") {
                target = 1;
            } else if (region === "top") {
                if (y >= TOP_Y) target = 1;
            } else {
                // drip: full crown, then streaks that hang below it. A cheap
                // angular hash around the ring gives alternating drip columns;
                // each column reaches a noise-jittered depth below the equator.
                if (y >= TOP_Y) {
                    target = 1;
                } else {
                    const ang = Math.atan2(z, x);
                    const streak = 0.5 + 0.5 * Math.sin(ang * noiseScale);
                    const jitter = 1 - edgeNoise * (0.5 + 0.5 * Math.sin(ang * noiseScale * 2.7 + 1.3));
                    const reach = DRIP_REACH * (dripBias + (1 - dripBias) * streak) * jitter;
                    if (-y <= reach) target = 1;
                }
            }
            if (target > this.mask[vi]) {
                this.mask[vi] = target;
                this.touched.add(vi);
            }
        }
        if (this.touched.size === 0) return;
        this.smoothBoundary();
        this.resolveColors(this.touched);
        this.upload(this.touched);
    }

    // Shared paint core for the smear path: BVH sphere query → coverage raise.
    private paintSphere(localPoint: THREE.Vector3, radius: number, design: IcingDesign): void {
        const r = radius;
        const r2 = r * r;
        this.candidateVerts.clear();
        this.touched.clear();

        this.queryS.center.copy(localPoint);
        this.queryS.radius = r;
        const sphere = this.queryS;
        const idx = this.indexArr;
        const candidates = this.candidateVerts;

        // 1-2: gather candidate triangles whose verts may fall within the sphere.
        this.bvh.shapecast({
            intersectsBounds: (box: THREE.Box3): number => {
                const intersects = sphere.intersectsBox(box);
                if (!intersects) return NOT_INTERSECTED;
                const contained = sphere.containsPoint(box.min) && sphere.containsPoint(box.max);
                return contained ? CONTAINED : INTERSECTED;
            },
            intersectsTriangle: (_tri: unknown, triangleIndex: number): boolean => {
                const base = triangleIndex * 3;
                candidates.add(idx[base]);
                candidates.add(idx[base + 1]);
                candidates.add(idx[base + 2]);
                return false; // visit every triangle, don't stop early
            },
        });

        // 3-4: keep verts truly within r, raise coverage by the falloff weight.
        const pos = this.positions;
        const strength = 0.6 + 0.4 * design.gloss; // glossier icing lays thicker
        for (const vi of candidates) {
            const i = vi * 3;
            const dx = pos[i] - localPoint.x;
            const dy = pos[i + 1] - localPoint.y;
            const dz = pos[i + 2] - localPoint.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > r2) continue;
            const w = falloff(Math.sqrt(d2) / r) * strength;
            const next = Math.min(1, this.mask[vi] + w);
            if (next > this.mask[vi]) {
                this.mask[vi] = next;
                this.touched.add(vi);
            }
        }
        if (this.touched.size === 0) return;

        this.smoothBoundary();
        this.resolveColors(this.touched);
        this.upload(this.touched);
    }

    // Edge-smoothing pass (SPEC §9.4): diffuse the coverage mask across the
    // painted boundary so the visible icing edge is soft, not a hard freehand
    // cut. We collect verts that straddle the mask boundary (a painted vert with
    // an unpainted neighbor, or vice-versa) plus their 1-ring, then run a few
    // Laplacian iterations of the mask over just that band. Boundary verts whose
    // mask rises above ~0 are folded into `touched` so their color re-resolves.
    private smoothBoundary(): void {
        const band = this.boundary;
        band.clear();
        const mask = this.mask;
        const adj = this.adjacency;

        for (const vi of this.touched) {
            band.add(vi);
            const neighbors = adj[vi];
            for (let k = 0; k < neighbors.length; k++) {
                const nj = neighbors[k];
                // a transition between painted/near-bare across this edge → border
                if (Math.abs(mask[nj] - mask[vi]) > 0.05) band.add(nj);
            }
        }
        if (band.size === 0) return;

        const scratch = this.maskScratch;
        for (let iter = 0; iter < EDGE_SMOOTH_ITERS; iter++) {
            for (const vi of band) {
                const neighbors = adj[vi];
                let sum = mask[vi];
                let count = 1;
                for (let k = 0; k < neighbors.length; k++) {
                    sum += mask[neighbors[k]];
                    count++;
                }
                scratch[vi] = sum / count;
            }
            for (const vi of band) mask[vi] = scratch[vi];
        }

        // any band vert that picked up coverage must have its color re-resolved.
        for (const vi of band) {
            if (mask[vi] > 0.001) this.touched.add(vi);
        }
    }

    // Resolve final vertex color from coverage: lerp from the existing base color
    // toward the design color by the mask. Re-deriving from the captured base on
    // every call would need a base copy; instead we lerp the *current* color
    // toward the design by the per-vertex mask, which converges to the design
    // color where mask→1 and leaves bare steel (white) where mask→0.
    private resolveColors(verts: Set<number>): void {
        const c = this.colors;
        const dc = this.designColor;
        for (const vi of verts) {
            const i = vi * 3;
            const m = this.mask[vi];
            // bare base is the white the geometry shipped with (1,1,1).
            c[i] = 1 + (dc.r - 1) * m;
            c[i + 1] = 1 + (dc.g - 1) * m;
            c[i + 2] = 1 + (dc.b - 1) * m;
        }
    }

    // Narrow the GPU upload to the changed vertex span (contiguous [min,max]
    // slice), matching the sculpt engine's updateRange handling.
    private upload(verts: Set<number>): void {
        this.colorAttr.needsUpdate = true;
        let min = Infinity, max = -Infinity;
        for (const vi of verts) {
            if (vi < min) min = vi;
            if (vi > max) max = vi;
        }
        if (min === Infinity) return;
        const offset = min * 3;
        const count = (max - min + 1) * 3;
        const ranged = this.colorAttr as unknown as {
            updateRanges?: { start: number; count: number }[];
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

    // Release the BVH only if we created it (never dispose a borrowed tree).
    dispose(): void {
        if (!this.ownsBVH) return;
        const geo = this.geometry as unknown as { disposeBoundsTree?: () => void; boundsTree?: MeshBVH | null };
        if (typeof geo.disposeBoundsTree === "function") geo.disposeBoundsTree();
        geo.boundsTree = null;
    }
}

// ---- Module-level convenience: one controller per mesh, lazily attached. ----
// The menu module and the chat path both call the free functions below without
// having to thread a controller instance through SceneContext. We cache the
// controller on the mesh's geometry; if the active mesh changes (morph swap,
// new sculpt target) we rebuild against the new geometry.
interface IcingHost { __icing?: Icing; __icingGeo?: THREE.BufferGeometry; }

function controllerFor(ctx: SceneContext): Icing {
    const host = ctx.mesh as unknown as IcingHost;
    if (!host.__icing || host.__icingGeo !== ctx.mesh.geometry) {
        host.__icing = new Icing(ctx);
        host.__icingGeo = ctx.mesh.geometry;
    }
    return host.__icing;
}

// Chat-driven path (DecorationAction apply_icing with a region).
export function applyIcingRegion(
    ctx: SceneContext,
    design: IcingDesign,
    region: "top" | "all" | "drip",
): void {
    controllerFor(ctx).applyIcingRegion(design, region);
}

// Direct right-hand path: smear icing onto the surface at a world-space point.
export function smearAt(
    ctx: SceneContext,
    worldPoint: THREE.Vector3,
    radius: number,
    design: IcingDesign,
): void {
    controllerFor(ctx).smearAt(worldPoint, radius, design);
}
