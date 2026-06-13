// Taubin volume-preservation test (SPEC §6.2, §10.1).
//
// The HARD rule: smoothing is ALWAYS Taubin (λ=0.5, μ=−0.53), never plain
// Laplacian. The negative μ un-shrink pass is what keeps a closed surface from
// deflating. This test pins that guarantee: a closed unit sphere must change
// volume by < 5% after 10 Taubin iterations.
//
// Volume is measured exactly via the divergence theorem over the mesh triangles
// (signed tetrahedron sum), so the check is on the true enclosed volume — not a
// radius proxy. We exercise two cases:
//   1. A clean icosphere — already smooth, so Taubin should barely move it.
//   2. A noisy icosphere — radially perturbed so there is real high-frequency
//      content for the band-pass to attack; this is where plain Laplacian would
//      visibly shrink the volume and Taubin must not.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { taubinSmooth } from "../src/sculpt/brushes";
import { makeIcosphere } from "../src/render/geometry";

const LAMBDA = 0.5;
const MU = -0.53;
const ITERS = 10;

// Signed volume enclosed by a closed indexed triangle mesh, via the divergence
// theorem: V = (1/6) Σ_tri (a · (b × c)) over each triangle (a,b,c). For an
// outward-wound watertight mesh this is the positive enclosed volume.
function signedVolume(positions: Float32Array, index: ArrayLike<number>): number {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const cross = new THREE.Vector3();
    let vol = 0;
    for (let t = 0; t < index.length; t += 3) {
        const ia = index[t] * 3;
        const ib = index[t + 1] * 3;
        const ic = index[t + 2] * 3;
        a.set(positions[ia], positions[ia + 1], positions[ia + 2]);
        b.set(positions[ib], positions[ib + 1], positions[ib + 2]);
        c.set(positions[ic], positions[ic + 1], positions[ic + 2]);
        cross.copy(b).cross(c);
        vol += a.dot(cross);
    }
    return Math.abs(vol) / 6;
}

// Per-vertex 1-ring adjacency derived from the index buffer: every triangle edge
// contributes an undirected neighbor pair. Matches the `neighbors` argument
// taubinSmooth expects (ReadonlyArray<ReadonlyArray<number>>).
function buildAdjacency(vertexCount: number, index: ArrayLike<number>): number[][] {
    const sets: Set<number>[] = [];
    for (let i = 0; i < vertexCount; i++) sets.push(new Set<number>());
    const addEdge = (p: number, q: number): void => {
        sets[p].add(q);
        sets[q].add(p);
    };
    for (let t = 0; t < index.length; t += 3) {
        const i0 = index[t];
        const i1 = index[t + 1];
        const i2 = index[t + 2];
        addEdge(i0, i1);
        addEdge(i1, i2);
        addEdge(i2, i0);
    }
    return sets.map((s) => Array.from(s));
}

// A closed unit-radius icosphere at a small detail (fast in CI). makeIcosphere
// welds seams into an indexed watertight buffer, which is what the divergence
// volume and the adjacency both require.
function makeUnitSphere(detail = 6): {
    positions: Float32Array;
    index: Uint16Array | Uint32Array;
    neighbors: number[][];
} {
    const geo = makeIcosphere(1.0, detail);
    const pos_attr = geo.attributes.position as THREE.BufferAttribute;
    const positions = (pos_attr.array as Float32Array).slice(); // own copy; smoothing mutates in place
    const idx_attr = geo.index;
    if (!idx_attr) throw new Error("expected an indexed icosphere");
    const index = (idx_attr.array as Uint16Array | Uint32Array).slice() as Uint16Array | Uint32Array;
    const neighbors = buildAdjacency(pos_attr.count, index);
    geo.dispose();
    return { positions, index, neighbors };
}

// Radially perturb every vertex of a unit sphere by a deterministic pseudo-noise
// so the surface has high-frequency content for Taubin to smooth. Mutates in
// place. Deterministic → the test is reproducible.
function addRadialNoise(positions: Float32Array, amplitude: number): void {
    const count = positions.length / 3;
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
        const j = i * 3;
        v.set(positions[j], positions[j + 1], positions[j + 2]);
        const len = v.length() || 1;
        // bounded, vertex-dependent, sign-alternating displacement
        const noise = amplitude * Math.sin(i * 12.9898) * Math.cos(i * 78.233);
        const scale = (len + noise) / len;
        positions[j] = v.x * scale;
        positions[j + 1] = v.y * scale;
        positions[j + 2] = v.z * scale;
    }
}

describe("taubinSmooth", () => {
    it("volume changes < 5% after 10 iterations on a clean unit sphere", () => {
        const { positions, index, neighbors } = makeUnitSphere();
        const dirty = neighbors.map((_, i) => i); // whole mesh is the dirty set

        const v_before = signedVolume(positions, index);
        // A unit sphere has volume 4/3·π ≈ 4.18879 — sanity-check the measurement.
        expect(v_before).toBeCloseTo((4 / 3) * Math.PI, 1);

        taubinSmooth(positions, neighbors, dirty, LAMBDA, MU, ITERS);

        const v_after = signedVolume(positions, index);
        const drift = Math.abs(v_after - v_before) / v_before;
        expect(drift).toBeLessThan(0.05);
    });

    it("volume changes < 5% after 10 iterations on a noisy unit sphere", () => {
        const { positions, index, neighbors } = makeUnitSphere();
        const dirty = neighbors.map((_, i) => i);

        // Inject high-frequency surface noise — this is the case where plain
        // Laplacian would deflate the volume; Taubin must hold it.
        addRadialNoise(positions, 0.08);

        const v_before = signedVolume(positions, index);
        taubinSmooth(positions, neighbors, dirty, LAMBDA, MU, ITERS);
        const v_after = signedVolume(positions, index);

        const drift = Math.abs(v_after - v_before) / v_before;
        expect(drift).toBeLessThan(0.05);
    });

    it("preserves volume far better than plain Laplacian on the same noisy sphere", () => {
        const noisy = makeUnitSphere();
        const noisy_dirty = noisy.neighbors.map((_, i) => i);
        addRadialNoise(noisy.positions, 0.08);
        const v_start = signedVolume(noisy.positions, noisy.index);

        // Independent copy with identical noise for the Laplacian baseline.
        const lap = makeUnitSphere();
        addRadialNoise(lap.positions, 0.08);
        const lap_dirty = lap.neighbors.map((_, i) => i);

        // Plain Laplacian = lambda pass with mu = 0 (the un-shrink step disabled).
        taubinSmooth(lap.positions, lap.neighbors, lap_dirty, LAMBDA, 0, ITERS);
        const v_lap = signedVolume(lap.positions, lap.index);

        // Taubin on the noisy sphere.
        taubinSmooth(noisy.positions, noisy.neighbors, noisy_dirty, LAMBDA, MU, ITERS);
        const v_taubin = signedVolume(noisy.positions, noisy.index);

        const lap_drift = Math.abs(v_lap - v_start) / v_start;
        const taubin_drift = Math.abs(v_taubin - v_start) / v_start;

        // Laplacian visibly deflates; Taubin stays within the 5% budget and
        // loses far less volume.
        expect(lap_drift).toBeGreaterThan(taubin_drift);
        expect(taubin_drift).toBeLessThan(0.05);
    });
});
