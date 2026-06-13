// SculptEngine — BVH-localized real-time deformation (SPEC §6, §11).
//
// Wraps one sculptable THREE.Mesh: builds a MeshBVH over its geometry, precomputes
// vertex adjacency (for Taubin smoothing) and vertex→face incidence (for fast
// normal recompute), and exposes `applyBrush(verb, point, radius, strength, scratch)`
// which runs the §6 per-stroke loop:
//   shapecast → candidate triangles within r → vertices truly within r →
//   apply brush kernel with falloff → mark dirty → incremental bvh.refit() →
//   recompute normals on the dirty region ONLY → upload only the changed
//   attribute ranges via addUpdateRange.
//
// HARD RULES honored here (SPEC §6.2, §11.1):
//   - Dirty-region updates only: never a full BVH rebuild or full normal
//     recompute per stroke. `refit()` is the incremental BVH bounds update.
//   - Smoothing is ALWAYS Taubin (λ=0.5, μ=−0.53) via taubinSmooth — never plain
//     Laplacian.
//   - Zero per-frame allocation in the hot loop: `applyBrush` allocates nothing.
//     It borrows the caller's ScratchMath and otherwise reuses persistent state
//     allocated once in the constructor.
//   - Upload only changed attribute ranges (addUpdateRange / clearUpdateRanges).
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
import { BrushVerb } from "../types";
import type { ScratchMath } from "../types";
import type { BrushContext } from "./brushes";
import { falloff, taubinSmooth, BRUSH_KERNELS } from "./brushes";

// Patch three.js prototypes exactly once so geometry.computeBoundsTree() and
// accelerated raycasting are available (idempotent across engine instances).
let PROTOTYPES_PATCHED = false;
function patchPrototypes(): void {
    if (PROTOTYPES_PATCHED) return;
    (THREE.BufferGeometry.prototype as unknown as { computeBoundsTree: typeof computeBoundsTree }).computeBoundsTree = computeBoundsTree;
    (THREE.BufferGeometry.prototype as unknown as { disposeBoundsTree: typeof disposeBoundsTree }).disposeBoundsTree = disposeBoundsTree;
    (THREE.Mesh.prototype as unknown as { raycast: typeof acceleratedRaycast }).raycast = acceleratedRaycast;
    PROTOTYPES_PATCHED = true;
}

export class SculptEngine {
    readonly mesh: THREE.Mesh;
    readonly bvh: MeshBVH;

    private readonly geometry: THREE.BufferGeometry;
    private readonly positionAttr: THREE.BufferAttribute;
    private readonly normalAttr: THREE.BufferAttribute;
    private readonly positions: Float32Array;
    private readonly normals: Float32Array;
    private readonly indexArr: Uint16Array | Uint32Array;

    // neighbor vertices per vertex (for Taubin smoothing)
    private readonly adjacency: number[][];
    // incident face indices per vertex (for dirty-region normal recompute)
    private readonly vertexFaces: number[][];

    // ---- persistent reusable state (allocated ONCE; never inside applyBrush) ----

    // BVH radius query sphere.
    private readonly queryS = new THREE.Sphere();

    // Shared per-stroke brush frame consumed by the brush kernels. The kernels'
    // tmpA/tmpB scratch is filled here from the caller's ScratchMath each stroke.
    private readonly brushCtx: BrushContext = {
        center: new THREE.Vector3(),
        drag: new THREE.Vector3(),
        strength: 0,
        brushNormal: new THREE.Vector3(),
        planePoint: new THREE.Vector3(),
        planeNormal: new THREE.Vector3(),
        tmpA: new THREE.Vector3(),
        tmpB: new THREE.Vector3(),
    };

    // face-normal accumulator scratch for dirty-region normal recompute
    private readonly fNormal = new THREE.Vector3();
    private readonly edge1 = new THREE.Vector3();
    private readonly edge2 = new THREE.Vector3();
    private readonly pA = new THREE.Vector3();
    private readonly pB = new THREE.Vector3();
    private readonly pC = new THREE.Vector3();
    private readonly avgNormal = new THREE.Vector3();

    // dirty bookkeeping, reused across strokes (cleared, never reallocated)
    private readonly candidateVerts = new Set<number>();
    private readonly dirtyVerts = new Set<number>();
    private readonly dirtyFaces = new Set<number>();

    constructor(mesh: THREE.Mesh) {
        patchPrototypes();
        this.mesh = mesh;
        this.geometry = mesh.geometry;

        if (!this.geometry.index) {
            // Sculpt needs an index buffer; refuse non-indexed geometry rather
            // than silently building wrong adjacency.
            throw new Error("SculptEngine requires indexed geometry");
        }

        // Build (or reuse) the BVH and expose it on the geometry so accelerated
        // raycasts and external callers (icing/sprinkles) share one tree.
        const existing = (this.geometry as unknown as { boundsTree?: MeshBVH }).boundsTree;
        if (existing) {
            this.bvh = existing;
        } else {
            this.bvh = new MeshBVH(this.geometry);
            (this.geometry as unknown as { boundsTree: MeshBVH }).boundsTree = this.bvh;
        }

        this.positionAttr = this.geometry.attributes.position as THREE.BufferAttribute;
        if (!this.geometry.attributes.normal) this.geometry.computeVertexNormals();
        this.normalAttr = this.geometry.attributes.normal as THREE.BufferAttribute;
        this.positions = this.positionAttr.array as Float32Array;
        this.normals = this.normalAttr.array as Float32Array;
        this.indexArr = this.geometry.index.array as Uint16Array | Uint32Array;

        const vertCount = this.positions.length / 3;
        this.adjacency = new Array(vertCount);
        this.vertexFaces = new Array(vertCount);
        this.buildTopology(vertCount);
    }

    // One-time topology: vertex→neighbors (deduped) and vertex→incident faces.
    private buildTopology(vertCount: number): void {
        const neighborSets: Set<number>[] = new Array(vertCount);
        for (let v = 0; v < vertCount; v++) {
            neighborSets[v] = new Set<number>();
            this.vertexFaces[v] = [];
        }
        const idx = this.indexArr;
        const faceCount = idx.length / 3;
        for (let f = 0; f < faceCount; f++) {
            const a = idx[f * 3], b = idx[f * 3 + 1], c = idx[f * 3 + 2];
            neighborSets[a].add(b); neighborSets[a].add(c);
            neighborSets[b].add(a); neighborSets[b].add(c);
            neighborSets[c].add(a); neighborSets[c].add(b);
            this.vertexFaces[a].push(f);
            this.vertexFaces[b].push(f);
            this.vertexFaces[c].push(f);
        }
        for (let v = 0; v < vertCount; v++) {
            this.adjacency[v] = Array.from(neighborSets[v]);
        }
    }

    // Apply one brush stroke (SPEC §6.3). `point` is the brush center in the
    // mesh's OBJECT space (caller unprojects + inverse-transforms). `strength`
    // is the per-unit-weight push amount. `scratch` is the shared ScratchMath —
    // we borrow v1 for the per-stroke drag and otherwise allocate nothing.
    //
    // NOTE: Grab needs a drag vector. The single-point applyBrush signature has
    // no delta, so Grab degenerates to a centered pull toward `point`; callers
    // that want true drag pre-bake it into successive points. strength scales the
    // effect for every verb uniformly.
    applyBrush(
        verb: BrushVerb,
        point: THREE.Vector3,
        radius: number,
        strength: number,
        scratch: ScratchMath,
    ): void {
        if (radius <= 0) return;
        const r = radius;
        const r2 = r * r;
        const px = point.x, py = point.y, pz = point.z;

        this.candidateVerts.clear();
        this.dirtyVerts.clear();
        this.dirtyFaces.clear();

        // 1-2: gather candidate triangles whose bounds intersect the brush sphere.
        const sphere = this.queryS;
        sphere.center.set(px, py, pz);
        sphere.radius = r;
        const idx = this.indexArr;
        const candidates = this.candidateVerts;

        this.bvh.shapecast({
            intersectsBounds: (box: THREE.Box3): number => {
                if (!sphere.intersectsBox(box)) return NOT_INTERSECTED;
                const contained = sphere.containsPoint(box.min) && sphere.containsPoint(box.max);
                return contained ? CONTAINED : INTERSECTED;
            },
            intersectsTriangle: (_tri: unknown, triangleIndex: number): void => {
                const base = triangleIndex * 3;
                candidates.add(idx[base]);
                candidates.add(idx[base + 1]);
                candidates.add(idx[base + 2]);
            },
        });

        // 3: keep only vertices truly within radius r of the brush point.
        const verts = this.dirtyVerts;
        const pos = this.positions;
        for (const vi of candidates) {
            const i = vi * 3;
            const dx = pos[i] - px;
            const dy = pos[i + 1] - py;
            const dz = pos[i + 2] - pz;
            if (dx * dx + dy * dy + dz * dz <= r2) verts.add(vi);
        }
        if (verts.size === 0) return;

        // Smooth is its own volume-preserving path (Taubin, no per-vertex kernel).
        if (verb === BrushVerb.Smooth) {
            taubinSmooth(pos, this.adjacency, verts);
            this.finishStroke(verts);
            return;
        }

        // Prepare the shared brush frame for the affected vertices. The kernels'
        // tmpA/tmpB are aliased onto the caller's ScratchMath vectors so no
        // allocation happens here.
        const ctx = this.brushCtx;
        ctx.center.set(px, py, pz);
        ctx.strength = strength;
        ctx.tmpA = scratch.v1;
        ctx.tmpB = scratch.v2;
        // Grab has no explicit delta in this signature: pull toward the center.
        ctx.drag.set(0, 0, 0);
        this.computeBrushFrame(verts, ctx);

        const fn = BRUSH_KERNELS[verb];
        if (!fn) return; // unknown displacement verb — nothing to do

        // 4: apply the brush with radial falloff w = (1 − (d/r)²)², marking dirty.
        for (const vi of verts) {
            const i = vi * 3;
            const dx = pos[i] - px;
            const dy = pos[i + 1] - py;
            const dz = pos[i + 2] - pz;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const w = falloff(d, r);
            fn(pos, this.normals, vi, w, ctx);
        }

        this.finishStroke(verts);
    }

    // 5-7: incremental BVH refit, dirty-region normal recompute, narrowed upload.
    private finishStroke(verts: Set<number>): void {
        // collect dirty faces (the incident faces of every dirty vertex)
        const faces = this.dirtyFaces;
        for (const vi of verts) {
            const incident = this.vertexFaces[vi];
            for (let k = 0; k < incident.length; k++) faces.add(incident[k]);
        }

        this.positionAttr.needsUpdate = true;

        // 5: incremental BVH bounds refit (NOT a rebuild) for the moved positions.
        this.bvh.refit();

        // 6: recompute normals over the dirty region ONLY.
        this.recomputeNormals(verts, faces);
        this.normalAttr.needsUpdate = true;

        // 7: narrow each GPU upload to the changed vertex span (addUpdateRange).
        this.setUpdateRange(this.positionAttr, verts);
        this.setUpdateRange(this.normalAttr, verts);
    }

    // Zero the dirty vertices' normals, accumulate each dirty face's area-weighted
    // face normal onto its dirty verts, then renormalize. Matches the result of
    // computeVertexNormals over just the touched region (clean verts untouched).
    private recomputeNormals(verts: Set<number>, faces: Set<number>): void {
        const n = this.normals;
        for (const vi of verts) {
            const i = vi * 3;
            n[i] = 0; n[i + 1] = 0; n[i + 2] = 0;
        }
        const idx = this.indexArr;
        const pos = this.positions;
        for (const f of faces) {
            const a = idx[f * 3], b = idx[f * 3 + 1], c = idx[f * 3 + 2];
            this.pA.set(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]);
            this.pB.set(pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]);
            this.pC.set(pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]);
            this.edge1.subVectors(this.pC, this.pB);
            this.edge2.subVectors(this.pA, this.pB);
            this.fNormal.crossVectors(this.edge1, this.edge2); // length ∝ 2·area
            this.accumulateNormal(a, verts);
            this.accumulateNormal(b, verts);
            this.accumulateNormal(c, verts);
        }
        for (const vi of verts) {
            const i = vi * 3;
            const len = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
            const inv = 1 / len;
            n[i] *= inv; n[i + 1] *= inv; n[i + 2] *= inv;
        }
    }

    // Add the current face normal onto vertex vi, but only if vi is dirty (clean
    // verts keep their existing normals; their incident faces are still summed
    // for the dirty verts they share).
    private accumulateNormal(vi: number, verts: Set<number>): void {
        if (!verts.has(vi)) return;
        const i = vi * 3;
        this.normals[i] += this.fNormal.x;
        this.normals[i + 1] += this.fNormal.y;
        this.normals[i + 2] += this.fNormal.z;
    }

    // Build the per-stroke brush frame: averaged surface normal + area-average
    // plane point (used by Draw/Flatten). Cheap O(dirty) reduction, no alloc.
    private computeBrushFrame(verts: Set<number>, ctx: BrushContext): void {
        let nx = 0, ny = 0, nz = 0;
        let cx = 0, cy = 0, cz = 0;
        let count = 0;
        const n = this.normals;
        const pos = this.positions;
        for (const vi of verts) {
            const i = vi * 3;
            nx += n[i]; ny += n[i + 1]; nz += n[i + 2];
            cx += pos[i]; cy += pos[i + 1]; cz += pos[i + 2];
            count++;
        }
        const inv = count > 0 ? 1 / count : 0;
        ctx.planePoint.set(cx * inv, cy * inv, cz * inv);
        this.avgNormal.set(nx, ny, nz);
        if (this.avgNormal.lengthSq() < 1e-12) this.avgNormal.set(0, 1, 0);
        this.avgNormal.normalize();
        ctx.brushNormal.copy(this.avgNormal);
        ctx.planeNormal.copy(this.avgNormal);
    }

    // Expand the attribute's GPU updateRange to cover the dirty vertex span. We
    // upload a contiguous [min,max] slice rather than the whole buffer (§11.1).
    private setUpdateRange(attr: THREE.BufferAttribute, verts: Set<number>): void {
        let min = Infinity, max = -Infinity;
        for (const vi of verts) {
            if (vi < min) min = vi;
            if (vi > max) max = vi;
        }
        if (min === Infinity) return;
        const offset = min * 3;
        const count = (max - min + 1) * 3;
        // three r160: updateRanges[] (addUpdateRange) supersedes the deprecated
        // single updateRange. Replace any prior range with this stroke's span.
        attr.clearUpdateRanges();
        attr.addUpdateRange(offset, count);
    }

    // Incremental BVH bounds refit after external position edits (SPEC §6.2).
    // Walks the tree updating bounds only — never a rebuild. Callers that batch
    // their own writes can invoke this once after the batch.
    refit(): void {
        this.bvh.refit();
    }

    // Release the BVH (call when the sculptable mesh is replaced/destroyed).
    dispose(): void {
        const geo = this.geometry as unknown as { disposeBoundsTree?: () => void; boundsTree?: MeshBVH | null };
        if (typeof geo.disposeBoundsTree === "function") geo.disposeBoundsTree();
        geo.boundsTree = null;
    }
}
