// SculptEngine — BVH-localized real-time deformation (SPEC §7.1-7.2).
//
// Wraps a sculptable THREE.Mesh: builds a MeshBVH over its geometry, precomputes
// vertex adjacency (for Taubin) and vertex→face incidence (for fast normal
// recompute), and exposes `stroke(point, radius, verb, ctx)` which runs the §7.2
// per-stroke loop:
//   shapecast → candidate triangles within r → unique vertices within r →
//   apply brush with falloff → mark dirty → bvh.refit() → recompute normals on
//   the dirty region → upload only the changed attribute ranges.
// All hot-loop state is reused scratch; there is zero per-frame allocation.
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
import type { BrushContext } from "./brushes";
import { falloff, grab, inflate, draw, flatten, pinch, crease, taubinSmooth } from "./brushes";

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
    private readonly positions: Float32Array;
    private readonly normals: Float32Array;
    private readonly indexArr: Uint16Array | Uint32Array;

    // neighbor vertices per vertex (for Taubin smoothing)
    private readonly adjacency: number[][];
    // incident face indices per vertex (for dirty-region normal recompute)
    private readonly vertexFaces: number[][];

    // reused per-stroke scratch (no allocation in stroke())
    private readonly queryS = new THREE.Sphere();
    private readonly ctx: BrushContext = {
        center: new THREE.Vector3(),
        drag: new THREE.Vector3(),
        strength: 0,
        brushNormal: new THREE.Vector3(),
        planePoint: new THREE.Vector3(),
        planeNormal: new THREE.Vector3(),
        tmpA: new THREE.Vector3(),
        tmpB: new THREE.Vector3(),
    };
    private readonly vScratch = new THREE.Vector3();
    private readonly fNormal = new THREE.Vector3();
    private readonly edge1 = new THREE.Vector3();
    private readonly edge2 = new THREE.Vector3();
    private readonly pA = new THREE.Vector3();
    private readonly pB = new THREE.Vector3();
    private readonly pC = new THREE.Vector3();

    // dirty bookkeeping, reused across strokes (cleared, never reallocated)
    private readonly dirtyVerts = new Set<number>();
    private readonly dirtyFaces = new Set<number>();
    private readonly candidateVerts = new Set<number>();

    constructor(mesh: THREE.Mesh) {
        patchPrototypes();
        this.mesh = mesh;
        this.geometry = mesh.geometry;

        if (!this.geometry.index) {
            // sculpt needs an index buffer; refuse non-indexed geometry rather
            // than silently producing wrong adjacency.
            throw new Error("SculptEngine requires indexed geometry");
        }

        // Build (or reuse) the BVH and expose it on the geometry.
        const existing = (this.geometry as unknown as { boundsTree?: MeshBVH }).boundsTree;
        if (existing) {
            this.bvh = existing;
        } else {
            this.bvh = new MeshBVH(this.geometry);
            (this.geometry as unknown as { boundsTree: MeshBVH }).boundsTree = this.bvh;
        }

        this.positions = (this.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
        const normalAttr = this.geometry.attributes.normal as THREE.BufferAttribute | undefined;
        if (!normalAttr) {
            this.geometry.computeVertexNormals();
        }
        this.normals = (this.geometry.attributes.normal as THREE.BufferAttribute).array as Float32Array;
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

    // Run one sculpt stroke. `point` and `drag` are in the mesh's OBJECT space
    // (caller unprojects + inverse-transforms). `verb` selects the brush; `ctx`
    // carries per-stroke params (strength, drag) — center/normals are filled here.
    stroke(
        point: THREE.Vector3,
        radius: number,
        verb: BrushVerb,
        params: { strength?: number; drag?: THREE.Vector3 } = {},
    ): void {
        const r = radius;
        const r2 = r * r;
        this.dirtyVerts.clear();
        this.dirtyFaces.clear();
        this.candidateVerts.clear();

        // 1-2: gather candidate triangles whose verts may fall within the sphere.
        this.queryS.center.copy(point);
        this.queryS.radius = r;
        const sphere = this.queryS;
        const idx = this.indexArr;
        const candidates = this.candidateVerts;

        this.bvh.shapecast({
            intersectsBounds: (box: THREE.Box3): number => {
                const intersects = sphere.intersectsBox(box);
                if (!intersects) return NOT_INTERSECTED;
                const contained = sphere.containsPoint(box.min) && sphere.containsPoint(box.max);
                return contained ? CONTAINED : INTERSECTED;
            },
            intersectsTriangle: (_tri: unknown, triangleIndex: number): boolean => {
                // record the 3 vertex indices of this candidate face
                const base = triangleIndex * 3;
                candidates.add(idx[base]);
                candidates.add(idx[base + 1]);
                candidates.add(idx[base + 2]);
                return false; // visit every triangle, don't stop early
            },
        });

        // 3: keep only vertices truly within radius r of the brush point.
        const verts = this.dirtyVerts;
        for (const vi of candidates) {
            const i = vi * 3;
            const dx = this.positions[i] - point.x;
            const dy = this.positions[i + 1] - point.y;
            const dz = this.positions[i + 2] - point.z;
            if (dx * dx + dy * dy + dz * dz <= r2) verts.add(vi);
        }
        if (verts.size === 0) return;

        // Smooth is its own volume-preserving path (no per-vertex brush fn).
        if (verb === BrushVerb.Smooth) {
            taubinSmooth(this.positions, this.adjacency, verts);
            this.finishStroke(verts);
            return;
        }

        // Prepare shared brush context for the affected vertices.
        const ctx = this.ctx;
        ctx.center.copy(point);
        ctx.strength = params.strength ?? 0.05 * r;
        if (params.drag) ctx.drag.copy(params.drag); else ctx.drag.set(0, 0, 0);
        this.computeBrushFrame(verts, ctx);

        const fn = this.brushFn(verb);

        // 4: apply the brush with radial falloff, marking each vertex dirty.
        for (const vi of verts) {
            const i = vi * 3;
            const dx = this.positions[i] - point.x;
            const dy = this.positions[i + 1] - point.y;
            const dz = this.positions[i + 2] - point.z;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const w = falloff(Math.min(1, d / r));
            fn(this.positions, this.normals, vi, w, ctx);
        }

        this.finishStroke(verts);
    }

    // 5-7: refit the BVH, recompute normals over dirty faces, upload only the
    // touched attribute ranges.
    private finishStroke(verts: Set<number>): void {
        // collect dirty faces from the dirty verts
        const faces = this.dirtyFaces;
        for (const vi of verts) {
            const incident = this.vertexFaces[vi];
            for (let k = 0; k < incident.length; k++) faces.add(incident[k]);
        }

        const positionAttr = this.geometry.attributes.position as THREE.BufferAttribute;
        positionAttr.needsUpdate = true;

        // 5: refit BVH bounds for the moved positions (cheap vs. rebuild).
        this.bvh.refit();

        // 6: recompute normals on the dirty region only.
        this.recomputeNormals(verts, faces);

        const normalAttr = this.geometry.attributes.normal as THREE.BufferAttribute;
        normalAttr.needsUpdate = true;

        // 7: narrow the GPU upload to the changed vertex range.
        this.setUpdateRange(positionAttr, verts);
        this.setUpdateRange(normalAttr, verts);
    }

    // Zero the dirty vertices' normals, accumulate each dirty face's (angle-free,
    // area-weighted) face normal onto its verts, then renormalize. This matches
    // computeVertexNormals over just the touched region.
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

    // Add the current face normal onto vertex vi, but only if vi is part of the
    // dirty set (clean verts keep their existing normals untouched).
    private accumulateNormal(vi: number, verts: Set<number>): void {
        if (!verts.has(vi)) return;
        const i = vi * 3;
        this.normals[i] += this.fNormal.x;
        this.normals[i + 1] += this.fNormal.y;
        this.normals[i + 2] += this.fNormal.z;
    }

    // Build the per-stroke brush frame: averaged surface normal + area-average
    // plane (used by Draw/Flatten/Pinch/Crease). Cheap O(dirty) reduction.
    private computeBrushFrame(verts: Set<number>, ctx: BrushContext): void {
        let nx = 0, ny = 0, nz = 0;
        let px = 0, py = 0, pz = 0;
        let count = 0;
        const n = this.normals;
        const pos = this.positions;
        for (const vi of verts) {
            const i = vi * 3;
            nx += n[i]; ny += n[i + 1]; nz += n[i + 2];
            px += pos[i]; py += pos[i + 1]; pz += pos[i + 2];
            count++;
        }
        const inv = count > 0 ? 1 / count : 0;
        ctx.planePoint.set(px * inv, py * inv, pz * inv);
        this.vScratch.set(nx, ny, nz);
        if (this.vScratch.lengthSq() < 1e-12) this.vScratch.set(0, 1, 0);
        this.vScratch.normalize();
        ctx.brushNormal.copy(this.vScratch);
        ctx.planeNormal.copy(this.vScratch);
    }

    // Map a BrushVerb to its per-vertex brush function.
    private brushFn(verb: BrushVerb): (p: Float32Array, nrm: Float32Array, vi: number, w: number, c: BrushContext) => void {
        switch (verb) {
            case BrushVerb.Grab: return grab;
            case BrushVerb.Inflate: return inflate;
            case BrushVerb.Draw: return draw;
            case BrushVerb.Flatten: return flatten;
            case BrushVerb.Pinch: return pinch;
            case BrushVerb.Crease: return crease;
            default: return inflate;
        }
    }

    // Expand the attribute's GPU updateRange to cover the dirty vertex span. We
    // upload a contiguous [min,max] slice rather than the whole buffer.
    private setUpdateRange(attr: THREE.BufferAttribute, verts: Set<number>): void {
        let min = Infinity, max = -Infinity;
        for (const vi of verts) {
            if (vi < min) min = vi;
            if (vi > max) max = vi;
        }
        if (min === Infinity) return;
        const offset = min * 3;
        const count = (max - min + 1) * 3;
        // three r160: BufferAttribute.updateRanges (array) supersedes updateRange.
        const ranged = attr as unknown as {
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

    // Release the BVH (call when the sculptable mesh is replaced/destroyed).
    dispose(): void {
        const geo = this.geometry as unknown as { disposeBoundsTree?: () => void; boundsTree?: MeshBVH | null };
        if (typeof geo.disposeBoundsTree === "function") geo.disposeBoundsTree();
        geo.boundsTree = null;
    }
}
