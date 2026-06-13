// Incremental BVH refit correctness (SPEC §6.2).
//
// engine.finishStroke() refits ONLY the BVH nodes the brush sphere touched
// (collected during the shapecast) instead of walking the whole tree. This pins
// that the region-local refit leaves the BVH behaviourally identical to the true
// deformed surface — i.e. no stale, too-small node bounds that would make a raycast
// cull a node and miss the sculpted bulge. three-mesh-bvh runs in pure JS, so this
// is exact and deterministic in node (no WebGL needed).
//
// Ground truth is a brute-force ray-vs-every-triangle scan over the deformed
// positions — order-independent and unambiguous. (We deliberately do NOT build a
// second MeshBVH for comparison: constructing one reorders the shared geometry
// index buffer in place, which would corrupt the engine's already-built BVH.)
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { SculptEngine } from "../src/sculpt/engine";
import { makeIcosphere } from "../src/render/geometry";
import { BrushVerb } from "../src/types";
import type { ScratchMath } from "../src/types";

// applyBrush only borrows scratch.v1 / scratch.v2 from the ScratchMath pool.
function makeScratch(): ScratchMath {
    return { v1: new THREE.Vector3(), v2: new THREE.Vector3() } as unknown as ScratchMath;
}

// Nearest ray–surface distance over ALL triangles (double-sided), or null on miss.
function bruteNearest(positions: Float32Array, index: ArrayLike<number>, ray: THREE.Ray): number | null {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const hit = new THREE.Vector3();
    let best = Infinity;
    for (let t = 0; t < index.length; t += 3) {
        const ia = index[t] * 3, ib = index[t + 1] * 3, ic = index[t + 2] * 3;
        a.set(positions[ia], positions[ia + 1], positions[ia + 2]);
        b.set(positions[ib], positions[ib + 1], positions[ib + 2]);
        c.set(positions[ic], positions[ic + 1], positions[ic + 2]);
        // backfaceCulling=false ⇒ double-sided, matching the BVH raycast below.
        if (ray.intersectTriangle(a, b, c, false, hit)) {
            const d = ray.origin.distanceTo(hit);
            if (d < best) best = d;
        }
    }
    return best === Infinity ? null : best;
}

describe("SculptEngine incremental refit", () => {
    it("region-local refit keeps the BVH consistent with the deformed surface", () => {
        const geo = makeIcosphere(1.0, 8); // indexed, watertight, non-trivial BVH
        const mesh = new THREE.Mesh(geo);
        const engine = new SculptEngine(mesh);

        const before = (geo.attributes.position.array as Float32Array).slice();

        // Push a large outward bulge near the +Y pole so displaced triangles leave
        // their old leaf boxes — exactly the case an incomplete refit gets wrong
        // (it would leave those leaf bounds too small and cull them on raycast).
        engine.applyBrush(BrushVerb.Inflate, new THREE.Vector3(0, 1, 0), 0.6, 0.35, makeScratch());

        const after = geo.attributes.position.array as Float32Array;
        const index = geo.index!.array as Uint16Array | Uint32Array;
        let moved = 0;
        for (let i = 0; i < after.length; i++) {
            if (Math.abs(after[i] - before[i]) > 1e-6) moved++;
        }
        expect(moved).toBeGreaterThan(0); // the stroke actually deformed the mesh

        // Cast a dense fan of rays from a surrounding sphere toward the origin,
        // crossing the surface (and the bulge) from every direction. The engine's
        // incrementally-refit BVH must find the SAME nearest surface as brute force.
        const origin = new THREE.Vector3();
        const dir = new THREE.Vector3();
        let comparedHits = 0;
        const STEPS = 40;
        for (let ai = 0; ai <= STEPS; ai++) {
            for (let bi = 0; bi < STEPS; bi++) {
                const theta = (ai / STEPS) * Math.PI;       // polar 0..π
                const phi = (bi / STEPS) * Math.PI * 2;     // azimuth 0..2π
                origin.set(
                    3 * Math.sin(theta) * Math.cos(phi),
                    3 * Math.cos(theta),
                    3 * Math.sin(theta) * Math.sin(phi),
                );
                dir.copy(origin).multiplyScalar(-1).normalize();
                const ray = new THREE.Ray(origin.clone(), dir.clone());

                const bvhHit = engine.bvh.raycastFirst(ray, THREE.DoubleSide);
                const bvhDist = bvhHit ? bvhHit.distance : null;
                const trueDist = bruteNearest(after, index, ray);

                expect(bvhDist === null).toBe(trueDist === null); // identical hit/miss → no stale bounds
                if (bvhDist !== null && trueDist !== null) {
                    expect(bvhDist).toBeCloseTo(trueDist, 4);
                    comparedHits++;
                }
            }
        }
        expect(comparedHits).toBeGreaterThan(100); // the comparison was not vacuous

        engine.dispose();
        geo.dispose();
    });
});
