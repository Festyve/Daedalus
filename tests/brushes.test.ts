// Unit tests for the brush math (SPEC §6.3, §10.1): radial falloff kernel,
// the displacement verb kernels, and the Taubin smoothing path. Pure math over
// flat Float32Array buffers — no three.js scene, no browser.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
    falloff,
    grab,
    inflate,
    draw,
    flatten,
    taubinSmooth,
    type BrushContext,
} from "../src/sculpt/brushes";

// A fresh brush context with all scratch allocated (the engine reuses one; tests
// can make a throwaway per case).
function makeCtx(): BrushContext {
    return {
        center: new THREE.Vector3(),
        drag: new THREE.Vector3(),
        strength: 1,
        brushNormal: new THREE.Vector3(),
        planePoint: new THREE.Vector3(),
        planeNormal: new THREE.Vector3(),
        tmpA: new THREE.Vector3(),
        tmpB: new THREE.Vector3(),
    };
}

// Mean distance of a flat xyz buffer from its centroid.
function meanRadius(positions: Float32Array): number {
    const count = positions.length / 3;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < count; i++) { cx += positions[i * 3]; cy += positions[i * 3 + 1]; cz += positions[i * 3 + 2]; }
    cx /= count; cy /= count; cz /= count;
    let sum = 0;
    for (let i = 0; i < count; i++) {
        sum += Math.hypot(positions[i * 3] - cx, positions[i * 3 + 1] - cy, positions[i * 3 + 2] - cz);
    }
    return sum / count;
}

// Population variance of a scalar sample.
function variance(values: number[]): number {
    const n = values.length;
    let mean = 0;
    for (const v of values) mean += v;
    mean /= n;
    let sum = 0;
    for (const v of values) { const d = v - mean; sum += d * d; }
    return sum / n;
}

// Regular N-gon ring in the XY plane: positions + ring adjacency (each vertex
// connected to its two circular neighbors).
function makeRing(n: number, radius: number): { positions: Float32Array; adjacency: number[][] } {
    const positions = new Float32Array(n * 3);
    const adjacency: number[][] = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        positions[i * 3] = Math.cos(a) * radius;
        positions[i * 3 + 1] = Math.sin(a) * radius;
        positions[i * 3 + 2] = 0;
        adjacency.push([(i + n - 1) % n, (i + 1) % n]);
    }
    return { positions, adjacency };
}

// A noisy open chain of vertices along +x: x is regular, y carries alternating
// high-frequency noise that a smoothing pass should attenuate. Endpoints are
// pinned (no neighbors) so they stay fixed; interior verts each have two
// neighbors. Returns positions, adjacency, and the interior vertex indices.
function makeNoisyLine(n: number, amplitude: number): {
    positions: Float32Array;
    adjacency: number[][];
    interior: number[];
} {
    const positions = new Float32Array(n * 3);
    const adjacency: number[][] = [];
    const interior: number[] = [];
    for (let i = 0; i < n; i++) {
        positions[i * 3] = i;                                   // x: evenly spaced
        positions[i * 3 + 1] = (i % 2 === 0 ? amplitude : -amplitude); // y: zig-zag noise
        positions[i * 3 + 2] = 0;
        if (i === 0 || i === n - 1) {
            adjacency.push([]);                                 // pinned endpoints
        } else {
            adjacency.push([i - 1, i + 1]);
            interior.push(i);
        }
    }
    return { positions, adjacency, interior };
}

describe("falloff", () => {
    it("is 1 at the brush center (normalized form)", () => {
        expect(falloff(0)).toBeCloseTo(1, 10);
    });

    it("is 0 at the brush edge (normalized form)", () => {
        expect(falloff(1)).toBeCloseTo(0, 10);
    });

    it("equals 1 at the center for the two-arg (d, r) form: falloff(0, r) = 1", () => {
        for (const r of [0.25, 1, 2.5, 10]) {
            expect(falloff(0, r)).toBeCloseTo(1, 10);
        }
    });

    it("equals 0 at the radius for the two-arg (d, r) form: falloff(r, r) = 0", () => {
        for (const r of [0.25, 1, 2.5, 10]) {
            expect(falloff(r, r)).toBeCloseTo(0, 10);
        }
    });

    it("is monotonically decreasing across [0, r]", () => {
        const r = 2.5;
        let prev = falloff(0, r);
        for (let i = 1; i <= 20; i++) {
            const d = (i / 20) * r;
            const cur = falloff(d, r);
            expect(cur).toBeLessThan(prev);
            prev = cur;
        }
    });

    it("matches the closed form w = (1 − (d/r)²)² at the half-radius", () => {
        // d/r = 0.5 → (1 − 0.25)² = 0.5625
        expect(falloff(0.5, 1)).toBeCloseTo(0.5625, 12);
        expect(falloff(1.25, 2.5)).toBeCloseTo(0.5625, 12); // same ratio, scaled radius
    });

    it("stays within [0, 1] across the brush footprint", () => {
        const r = 1.7;
        for (let i = 0; i <= 30; i++) {
            const w = falloff((i / 30) * r, r);
            expect(w).toBeGreaterThanOrEqual(0);
            expect(w).toBeLessThanOrEqual(1);
        }
    });
});

describe("grab brush", () => {
    it("translates the vertex by w · drag", () => {
        const positions = new Float32Array([0, 0, 0]);
        const normals = new Float32Array([0, 1, 0]);
        const ctx = makeCtx();
        ctx.drag.set(2, -4, 6);
        grab(positions, normals, 0, 0.5, ctx);
        expect(positions[0]).toBeCloseTo(1, 6);
        expect(positions[1]).toBeCloseTo(-2, 6);
        expect(positions[2]).toBeCloseTo(3, 6);
    });

    it("does nothing at zero weight", () => {
        const positions = new Float32Array([1, 2, 3]);
        const ctx = makeCtx();
        ctx.drag.set(5, 5, 5);
        grab(positions, new Float32Array([0, 1, 0]), 0, 0, ctx);
        expect(positions[0]).toBeCloseTo(1, 6);
        expect(positions[1]).toBeCloseTo(2, 6);
        expect(positions[2]).toBeCloseTo(3, 6);
    });
});

describe("inflate brush", () => {
    it("moves a vertex outward along its normal by w · strength", () => {
        // single vertex at (1,0,0) with outward normal +x
        const positions = new Float32Array([1, 0, 0]);
        const normals = new Float32Array([1, 0, 0]);
        const ctx = makeCtx();
        ctx.strength = 0.2;
        const w = 0.5;
        inflate(positions, normals, 0, w, ctx);
        // expected displacement = w * strength = 0.1 along +x
        expect(positions[0]).toBeCloseTo(1.1, 6);
        expect(positions[1]).toBeCloseTo(0, 6);
        expect(positions[2]).toBeCloseTo(0, 6);
    });

    it("scales the push linearly with the falloff weight", () => {
        const normals = new Float32Array([0, 0, 1]);
        const ctx = makeCtx();
        ctx.strength = 1;

        const near = new Float32Array([0, 0, 0]);
        inflate(near, normals, 0, falloff(0, 1), ctx); // w = 1

        const edge = new Float32Array([0, 0, 0]);
        inflate(edge, normals, 0, falloff(0.5, 1), ctx); // w = 0.5625

        expect(near[2]).toBeCloseTo(1, 6);
        expect(edge[2]).toBeCloseTo(0.5625, 6);
        expect(edge[2]).toBeLessThan(near[2]);
    });
});

describe("draw brush", () => {
    it("pushes along the shared brush normal, independent of the vertex normal", () => {
        const positions = new Float32Array([0, 0, 0]);
        const normals = new Float32Array([1, 0, 0]); // per-vertex normal (ignored by draw)
        const ctx = makeCtx();
        ctx.strength = 0.3;
        ctx.brushNormal.set(0, 0, 1); // averaged brush normal
        draw(positions, normals, 0, 0.5, ctx);
        // displacement = w * strength = 0.15 along +z only
        expect(positions[0]).toBeCloseTo(0, 6);
        expect(positions[1]).toBeCloseTo(0, 6);
        expect(positions[2]).toBeCloseTo(0.15, 6);
    });
});

describe("flatten brush", () => {
    it("projects a vertex toward the brush plane by weight w", () => {
        // plane through origin with +y normal; vertex sits at y = 1 above it.
        const positions = new Float32Array([0, 1, 0]);
        const ctx = makeCtx();
        ctx.planePoint.set(0, 0, 0);
        ctx.planeNormal.set(0, 1, 0);
        flatten(positions, new Float32Array([0, 1, 0]), 0, 0.5, ctx);
        // signed distance = 1; move by -signed * w = -0.5 → y = 0.5
        expect(positions[1]).toBeCloseTo(0.5, 6);

        // full weight lands exactly on the plane.
        const onPlane = new Float32Array([0, 1, 0]);
        flatten(onPlane, new Float32Array([0, 1, 0]), 0, 1, ctx);
        expect(onPlane[1]).toBeCloseTo(0, 6);
    });
});

describe("taubinSmooth — neighbor variance reduction", () => {
    it("a smooth pass reduces the variance of a noisy chain", () => {
        const { positions, adjacency, interior } = makeNoisyLine(11, 1.0);

        const before = interior.map((i) => positions[i * 3 + 1]);
        const varBefore = variance(before);

        taubinSmooth(positions, adjacency, interior, 0.5, -0.53, 1);

        const after = interior.map((i) => positions[i * 3 + 1]);
        const varAfter = variance(after);

        // The high-frequency zig-zag should be measurably attenuated.
        expect(varAfter).toBeLessThan(varBefore);
    });

    it("drives noise variance toward zero over many iterations", () => {
        // The single-pass guarantee is monotone; iterating the full Taubin
        // band-pass attenuates the high-frequency component overall (the net
        // trend, not every single μ rebound), so compare endpoints not steps.
        const { positions, adjacency, interior } = makeNoisyLine(13, 1.0);
        const varBefore = variance(interior.map((i) => positions[i * 3 + 1]));
        taubinSmooth(positions, adjacency, interior, 0.5, -0.53, 8);
        const varAfter = variance(interior.map((i) => positions[i * 3 + 1]));
        expect(varAfter).toBeLessThan(varBefore);
    });

    it("leaves pinned (neighborless) vertices untouched", () => {
        const { positions, adjacency } = makeNoisyLine(7, 1.0);
        // smooth the whole set, endpoints included
        const all = adjacency.map((_, i) => i);
        const firstY = positions[0 * 3 + 1];
        const lastY = positions[(7 - 1) * 3 + 1];
        taubinSmooth(positions, adjacency, all, 0.5, -0.53, 1);
        expect(positions[0 * 3 + 1]).toBeCloseTo(firstY, 12);
        expect(positions[(7 - 1) * 3 + 1]).toBeCloseTo(lastY, 12);
    });

    it("is a no-op on an empty dirty set", () => {
        const { positions, adjacency } = makeNoisyLine(5, 1.0);
        const snapshot = Float32Array.from(positions);
        taubinSmooth(positions, adjacency, [], 0.5, -0.53, 1);
        for (let i = 0; i < positions.length; i++) {
            expect(positions[i]).toBe(snapshot[i]);
        }
    });
});

describe("taubin vs laplacian (volume preservation)", () => {
    it("Taubin shrinks the ring radius LESS than one Laplacian step", () => {
        const N = 24;
        const R0 = 1.0;

        // One plain Laplacian step = a single lambda pass with mu = 0.
        const lap = makeRing(N, R0);
        const lapDirty = lap.adjacency.map((_, i) => i);
        taubinSmooth(lap.positions, lap.adjacency, lapDirty, 0.5, 0, 1);
        const lapR = meanRadius(lap.positions);

        // One Taubin iteration = lambda pass then mu (negative) un-shrink pass.
        const tau = makeRing(N, R0);
        const tauDirty = tau.adjacency.map((_, i) => i);
        taubinSmooth(tau.positions, tau.adjacency, tauDirty, 0.5, -0.53, 1);
        const tauR = meanRadius(tau.positions);

        // Both smoothing operations shrink a convex ring, but Taubin's negative
        // step restores volume → its radius stays closer to the original.
        expect(lapR).toBeLessThan(R0);                 // Laplacian shrinks
        expect(R0 - tauR).toBeLessThan(R0 - lapR);     // Taubin shrinks less
        expect(tauR).toBeGreaterThan(lapR);
    });

    it("preserves a smooth ring's radius within 5% over 10 iterations", () => {
        const N = 48;
        const R0 = 1.0;
        const ring = makeRing(N, R0);
        const dirty = ring.adjacency.map((_, i) => i);
        taubinSmooth(ring.positions, ring.adjacency, dirty, 0.5, -0.53, 10);
        const r = meanRadius(ring.positions);
        expect(Math.abs(R0 - r) / R0).toBeLessThan(0.05);
    });
});
