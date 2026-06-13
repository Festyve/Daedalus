// Sprinkle placement / cap tests (SPEC §8.4, §10.1).
//
// Headless: no WebGL is needed. `MeshSurfaceSampler` reads the geometry's
// position/weight attributes on the CPU, and `InstancedMesh.setMatrixAt` /
// `setColorAt` only write into typed arrays + flip `needsUpdate` booleans — none
// of that touches the GPU. So `Sprinkles` runs fully in the node test env.
//
// Two acceptance properties from §8.4 are pinned here:
//   1. Total instanced sprinkles never exceed 1500 across many `dropBatch` calls.
//   2. Sprinkles are placed only where the icing mask weight is > 0.
//
// `Sprinkles.dropBatch`/`clear` schedule a scale-in animation via
// requestAnimationFrame, which does not exist in node. We install a no-op RAF
// shim so the controller can run; the tick never auto-fires, which keeps the
// instance matrices fixed at their sampled placement (seeded at scale 0) for
// deterministic inspection. We read the placement translation straight out of
// each instance matrix instead.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { Sprinkles } from "../src/decorate/sprinkles";
import { makeIcosphere } from "../src/render/geometry";
import type { SprinkleDesign } from "../src/types";

// The hard cap the controller enforces (SPEC §8.4: "Cap ~1500 total"). Mirrored
// here as a constant the test owns so a drift in either direction is caught.
const MAX_TOTAL = 1500;

// A small sprinkle so the Poisson-disk min spacing (length * 1.15) is tiny and
// the cap — not packing density — is the binding constraint when we want to fill
// the surface. radius < length/2 keeps the capsule geometry well-formed.
const TINY_DESIGN: SprinkleDesign = {
    geometry: "capsule",
    palette: ["#FF0000", "#00FF00", "#0000FF"],
    length: 0.02,
    radius: 0.008,
};

// ---- RAF shim (node has no requestAnimationFrame) -------------------------------
// A no-op scheduler: hand back a monotonically increasing handle and never invoke
// the callback. The animation tick is irrelevant to placement/cap assertions, and
// not firing it keeps the sampled matrices untouched for inspection.
let rafHandle = 0;
let priorRaf: typeof globalThis.requestAnimationFrame | undefined;
let priorCaf: typeof globalThis.cancelAnimationFrame | undefined;

beforeAll(() => {
    priorRaf = globalThis.requestAnimationFrame;
    priorCaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((_cb: FrameRequestCallback): number => {
        return ++rafHandle;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((_h: number): void => {}) as typeof globalThis.cancelAnimationFrame;
});

afterAll(() => {
    // Restore so we never leak the shim into other suites in the same worker.
    if (priorRaf) globalThis.requestAnimationFrame = priorRaf;
    else delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    if (priorCaf) globalThis.cancelAnimationFrame = priorCaf;
    else delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
});

// ---- Helpers --------------------------------------------------------------------

// A sculptable mesh wrapping a fresh icosphere. The sprinkle layer parents itself
// to this mesh, so instance matrices are in the mesh's object space (which equals
// world space here — the mesh sits at the origin with identity transform).
function makeMesh(): THREE.Mesh {
    const geo = makeIcosphere();
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
}

// Per-vertex iced-weight mask: `weightAt(localY)` returns the weight for a vertex
// at height y. Iterating the mesh's own position attribute keeps the mask in lock-
// step with the geometry the sampler reads.
function buildMask(mesh: THREE.Mesh, weightAt: (y: number) => number): Float32Array {
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const mask = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) mask[i] = weightAt(pos.getY(i));
    return mask;
}

// Read every live instance's translation (object-space placement point) across all
// layers into a flat list of Vector3. Each layer's `mesh.count` is the live slot
// count, so we walk exactly the placed sprinkles.
function placedPoints(mesh: THREE.Mesh): THREE.Vector3[] {
    const m = new THREE.Matrix4();
    const out: THREE.Vector3[] = [];
    mesh.traverse((obj) => {
        const inst = obj as THREE.InstancedMesh;
        if (!(inst as { isInstancedMesh?: boolean }).isInstancedMesh) return;
        for (let i = 0; i < inst.count; i++) {
            inst.getMatrixAt(i, m);
            const p = new THREE.Vector3();
            p.setFromMatrixPosition(m);
            out.push(p);
        }
    });
    return out;
}

// ---- Suite ----------------------------------------------------------------------

describe("Sprinkles", () => {
    let scene: THREE.Scene;
    let sprinkles: Sprinkles;

    beforeEach(() => {
        scene = new THREE.Scene();
        sprinkles = new Sprinkles(scene);
    });

    afterEach(() => {
        sprinkles.dispose();
    });

    it("starts with zero live instances", () => {
        expect(sprinkles.count).toBe(0);
    });

    describe("cap (never exceed 1500)", () => {
        it("drops nothing onto a fully-bare mask", () => {
            const mesh = makeMesh();
            const bareMask = buildMask(mesh, () => 0);
            sprinkles.dropBatch(mesh, bareMask, TINY_DESIGN, 60);
            expect(sprinkles.count).toBe(0);
            expect(placedPoints(mesh).length).toBe(0);
        });

        it("count never exceeds MAX_TOTAL across many dropBatch calls", () => {
            const mesh = makeMesh();
            const fullMask = buildMask(mesh, () => 1); // entire surface iced

            // 40 batches × 60 requested = 2400 > 1500: the cap must clamp.
            for (let batch = 0; batch < 40; batch++) {
                sprinkles.dropBatch(mesh, fullMask, TINY_DESIGN, 60);
                expect(sprinkles.count).toBeLessThanOrEqual(MAX_TOTAL);
                // The live instance count and the reported count must agree, and
                // neither may overrun the cap (no slot is written past capacity).
                expect(placedPoints(mesh).length).toBe(sprinkles.count);
                expect(placedPoints(mesh).length).toBeLessThanOrEqual(MAX_TOTAL);
            }

            // With a tiny min-spacing on a unit-sphere surface there is ample room,
            // so enough batches saturate the controller exactly at the cap.
            expect(sprinkles.count).toBe(MAX_TOTAL);
        });

        it("a single oversized request is clamped to the cap, not exceeded", () => {
            const mesh = makeMesh();
            const fullMask = buildMask(mesh, () => 1);
            // Ask for far more than the cap in one shot.
            sprinkles.dropBatch(mesh, fullMask, TINY_DESIGN, 5000);
            expect(sprinkles.count).toBeLessThanOrEqual(MAX_TOTAL);
        });

        it("once capped, further drops add nothing", () => {
            const mesh = makeMesh();
            const fullMask = buildMask(mesh, () => 1);
            for (let batch = 0; batch < 40; batch++) {
                sprinkles.dropBatch(mesh, fullMask, TINY_DESIGN, 60);
            }
            const saturated = sprinkles.count;
            expect(saturated).toBe(MAX_TOTAL);
            // Additional batches at the cap are no-ops (budget <= 0 short-circuits).
            sprinkles.dropBatch(mesh, fullMask, TINY_DESIGN, 60);
            sprinkles.dropBatch(mesh, fullMask, TINY_DESIGN, 60);
            expect(sprinkles.count).toBe(saturated);
        });

        it("clear() resets the count to zero", () => {
            const mesh = makeMesh();
            const fullMask = buildMask(mesh, () => 1);
            sprinkles.dropBatch(mesh, fullMask, TINY_DESIGN, 60);
            expect(sprinkles.count).toBeGreaterThan(0);
            sprinkles.clear();
            expect(sprinkles.count).toBe(0);
            expect(placedPoints(mesh).length).toBe(0);
        });
    });

    describe("placement (iced regions only)", () => {
        // Ice only the northern cap (y > BOUNDARY); everything at or below is bare.
        // A weighted sampler never selects a triangle whose three vertices are all
        // zero-weight, so every sample lands on a triangle touching the iced cap.
        // The only mixed-weight triangles straddle y = BOUNDARY, and their span is
        // bounded by the icosphere edge length (≈ 2/detail ≈ 0.05 on a unit
        // sphere). MARGIN comfortably covers that, so no placement may fall into
        // the deep bare zone below the boundary.
        const BOUNDARY = 0.3;
        const MARGIN = 0.12;

        it("places every sprinkle within (or hugging) the iced region", () => {
            const mesh = makeMesh();
            const capMask = buildMask(mesh, (y) => (y > BOUNDARY ? 1 : 0));

            // Several batches so we inspect a representative population, not one draw.
            for (let batch = 0; batch < 8; batch++) {
                sprinkles.dropBatch(mesh, capMask, TINY_DESIGN, 60);
            }

            const points = placedPoints(mesh);
            expect(points.length).toBeGreaterThan(0); // sampling actually happened

            for (const p of points) {
                // No sprinkle may sit in the bare lower region (allowing the small
                // boundary-triangle overhang). This is the "weight > 0" guarantee.
                expect(p.y).toBeGreaterThan(BOUNDARY - MARGIN);
            }
        });

        it("places nothing in the bare hemisphere when only the top is iced", () => {
            const mesh = makeMesh();
            // Strictly ice the upper hemisphere; lower hemisphere fully bare.
            const topMask = buildMask(mesh, (y) => (y > 0 ? 1 : 0));

            for (let batch = 0; batch < 8; batch++) {
                sprinkles.dropBatch(mesh, topMask, TINY_DESIGN, 60);
            }

            const points = placedPoints(mesh);
            expect(points.length).toBeGreaterThan(0);

            // Count how many landed clearly inside the bare hemisphere (well below
            // the equator, past any boundary-triangle overhang). Must be exactly 0.
            const deepInBare = points.filter((p) => p.y < -MARGIN).length;
            expect(deepInBare).toBe(0);
        });

        it("keeps all placements on the sampled surface (unit sphere)", () => {
            const mesh = makeMesh();
            const fullMask = buildMask(mesh, () => 1);
            sprinkles.dropBatch(mesh, fullMask, TINY_DESIGN, 60);

            // Every placement is a point sampled on the icosphere surface, so its
            // radius from the origin must be ~1 (the makeIcosphere default radius).
            for (const p of placedPoints(mesh)) {
                expect(p.length()).toBeCloseTo(1, 1);
            }
        });
    });
});
