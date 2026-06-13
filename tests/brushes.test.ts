import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { falloff, inflate, taubinSmooth, type BrushContext } from "../src/sculpt/brushes";

// A fresh brush context with all scratch allocated (engine reuses one; tests
// can make a throwaway).
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

// Mean distance of a flat xyz ring buffer from its centroid.
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

describe("falloff", () => {
    it("is 1 at the brush center", () => {
        expect(falloff(0)).toBeCloseTo(1, 10);
    });
    it("is 0 at the brush edge", () => {
        expect(falloff(1)).toBeCloseTo(0, 10);
    });
    it("is monotonically decreasing on [0,1]", () => {
        expect(falloff(0.25)).toBeGreaterThan(falloff(0.5));
        expect(falloff(0.5)).toBeGreaterThan(falloff(0.75));
    });
});

describe("inflate brush", () => {
    it("moves a vertex outward along its normal by w * strength", () => {
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
});
