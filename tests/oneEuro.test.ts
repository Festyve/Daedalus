// Unit tests for the One Euro Filter (SPEC §3.3, §10.1). Pure math, no browser.
// Mirrors the real signatures in src/tracking/oneEuro.ts: filter(x, tMs) takes an
// ABSOLUTE timestamp in milliseconds (not a delta) and derives dt internally.
import { describe, it, expect } from "vitest";
import { OneEuroFilter, HandFilterBank } from "../src/tracking/oneEuro";
import type { Vec3 } from "../src/types";

const FPS = 60;
const FRAME_MS = 1000 / FPS;

/** Deterministic PRNG (mulberry32) so jitter tests never flake. */
function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Sample variance of a series. */
function variance(xs: number[]): number {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
}

describe("OneEuroFilter", () => {
    it("returns the first sample unchanged (lazy init)", () => {
        const f = new OneEuroFilter(1.0, 0.007);
        expect(f.filter(5, 0)).toBeCloseTo(5, 6);
    });

    it("converges to a held constant", () => {
        const f = new OneEuroFilter(1.0, 0.007);
        let y = 0;
        for (let i = 0; i < 200; i++) y = f.filter(10, i * FRAME_MS);
        expect(y).toBeCloseTo(10, 4);
    });

    it("reduces variance of a noisy constant-plus-jitter signal at rest", () => {
        // Acceptance: filtered output has lower variance than the raw noisy input.
        const rng = makeRng(0xc0ffee);
        const BASE = 0.5;
        const JITTER = 0.02;
        const f = new OneEuroFilter(1.0, 0.007);
        const raw: number[] = [];
        const filtered: number[] = [];
        for (let i = 0; i < 300; i++) {
            const noisy = BASE + (rng() - 0.5) * 2 * JITTER;
            const out = f.filter(noisy, i * FRAME_MS);
            // Skip warm-up so the first-sample passthrough does not bias variance.
            if (i >= 30) {
                raw.push(noisy);
                filtered.push(out);
            }
        }
        const raw_var = variance(raw);
        const filt_var = variance(filtered);
        expect(filt_var).toBeLessThan(raw_var);
        // Smoothing should be substantial, not marginal, at rest.
        expect(filt_var).toBeLessThan(raw_var * 0.5);
    });

    it("stays near the true mean despite jitter (no DC bias)", () => {
        const rng = makeRng(0x1234);
        const BASE = -3.0;
        const f = new OneEuroFilter(1.0, 0.007);
        let last = 0;
        for (let i = 0; i < 400; i++) {
            last = f.filter(BASE + (rng() - 0.5) * 0.04, i * FRAME_MS);
        }
        expect(last).toBeCloseTo(BASE, 1);
    });

    it("tracks a linear ramp with bounded steady-state lag", () => {
        // Acceptance: tracks a ramp; lag is bounded (does not grow without limit).
        const SLOPE = 1.0; // units per second
        const f = new OneEuroFilter(1.0, 0.007);
        let out = 0;
        let truth = 0;
        const lags: number[] = [];
        for (let i = 0; i < 240; i++) {
            const t_ms = i * FRAME_MS;
            truth = SLOPE * (t_ms / 1000);
            out = f.filter(truth, t_ms);
            if (i >= 60) lags.push(truth - out);
        }
        // Output trails the input (lag is non-negative) but the gap is bounded
        // and stable — never diverges as the ramp continues. For a first-order
        // low-pass the steady-state lag is ~slope / (2*pi*min_cutoff) ≈ 0.16 here,
        // so bound it generously below half a unit rather than assuming zero lag.
        const max_lag = Math.max(...lags);
        const min_lag = Math.min(...lags);
        expect(min_lag).toBeGreaterThanOrEqual(-1e-6);
        expect(max_lag).toBeLessThan(0.5 * SLOPE);
        // Steady-state lag must be near-constant, not accumulating without limit.
        const early = lags[0];
        const late = lags[lags.length - 1];
        expect(Math.abs(late - early)).toBeLessThan(0.05 * SLOPE);
    });

    it("responds faster to a fast move than to slow jitter (adaptive cutoff)", () => {
        // A large step should be followed quickly; the adaptive beta term raises
        // the cutoff with speed so fast motion has low lag.
        const f = new OneEuroFilter(1.0, 0.007);
        for (let i = 0; i < 60; i++) f.filter(0, i * FRAME_MS);
        const after_step = f.filter(10, 60 * FRAME_MS);
        // One step does not fully reach the target, but moves a meaningful fraction.
        expect(after_step).toBeGreaterThan(0);
        let y = after_step;
        for (let i = 61; i < 120; i++) y = f.filter(10, i * FRAME_MS);
        expect(y).toBeCloseTo(10, 1);
    });

    it("uses a neutral default dt for duplicate timestamps without NaN", () => {
        const f = new OneEuroFilter(1.0, 0.007);
        f.filter(1, 1000);
        const r = f.filter(2, 1000); // same timestamp -> dt fallback, not divide-by-zero
        expect(Number.isFinite(r)).toBe(true);
    });

    it("reset() restores initial first-sample-passthrough behavior", () => {
        // Acceptance: after reset(), the filter behaves as if freshly constructed.
        const f = new OneEuroFilter(1.0, 0.007);
        for (let i = 0; i < 100; i++) f.filter(7, i * FRAME_MS);
        f.reset();
        // First post-reset sample passes through unchanged, just like a new filter.
        expect(f.filter(42, 0)).toBeCloseTo(42, 6);
    });

    it("produces an identical trajectory after reset given the same inputs", () => {
        const inputs = [0, 1, 0.9, 1.1, 1.0, 5, 5, 5];
        const f = new OneEuroFilter(1.0, 0.007);
        const first = inputs.map((x, i) => f.filter(x, i * FRAME_MS));
        f.reset();
        const second = inputs.map((x, i) => f.filter(x, i * FRAME_MS));
        for (let i = 0; i < inputs.length; i++) {
            expect(second[i]).toBeCloseTo(first[i], 10);
        }
    });
});

describe("HandFilterBank", () => {
    /** 21 landmarks of a constant pose perturbed by per-axis jitter. */
    function makeNoisyPose(rng: () => number, amp: number): Vec3[] {
        const out: Vec3[] = new Array(21);
        for (let i = 0; i < 21; i++) {
            out[i] = {
                x: 0.5 + (rng() - 0.5) * 2 * amp,
                y: 0.3 + (rng() - 0.5) * 2 * amp,
                z: -0.1 + (rng() - 0.5) * 2 * amp,
            };
        }
        return out;
    }

    it("returns 21 landmarks for both image and world sets", () => {
        const bank = new HandFilterBank();
        const rng = makeRng(7);
        const img = makeNoisyPose(rng, 0.0);
        const world = makeNoisyPose(rng, 0.0);
        const { landmarks, world: w } = bank.filter(img, world, 0);
        expect(landmarks).toHaveLength(21);
        expect(w).toHaveLength(21);
    });

    it("smooths every axis of every landmark below the input jitter", () => {
        const bank = new HandFilterBank();
        const rng = makeRng(0xbeef);
        const AMP = 0.02;
        // Collect raw vs filtered series for landmark 9, x-axis, as a representative.
        const raw_x: number[] = [];
        const filt_x: number[] = [];
        for (let i = 0; i < 300; i++) {
            const img = makeNoisyPose(rng, AMP);
            const world = makeNoisyPose(rng, AMP);
            const res = bank.filter(img, world, i * FRAME_MS);
            if (i >= 30) {
                raw_x.push(img[9].x);
                filt_x.push(res.landmarks[9].x);
            }
        }
        expect(variance(filt_x)).toBeLessThan(variance(raw_x));
    });

    it("filters image and world channels independently", () => {
        // Feeding distinct constants must not let one channel leak into the other.
        const bank = new HandFilterBank();
        const img = Array.from({ length: 21 }, () => ({ x: 1, y: 1, z: 1 }) as Vec3);
        const world = Array.from({ length: 21 }, () => ({ x: -1, y: -1, z: -1 }) as Vec3);
        let res = bank.filter(img, world, 0);
        for (let i = 1; i < 200; i++) res = bank.filter(img, world, i * FRAME_MS);
        expect(res.landmarks[0].x).toBeCloseTo(1, 3);
        expect(res.world[0].x).toBeCloseTo(-1, 3);
    });

    it("reset() restores first-sample-passthrough across all 126 filters", () => {
        const bank = new HandFilterBank();
        const rng = makeRng(99);
        for (let i = 0; i < 120; i++) {
            bank.filter(makeNoisyPose(rng, 0.02), makeNoisyPose(rng, 0.02), i * FRAME_MS);
        }
        bank.reset();
        const img = makeNoisyPose(makeRng(1), 0.0);
        const world = makeNoisyPose(makeRng(2), 0.0);
        const res = bank.filter(img, world, 0);
        for (let i = 0; i < 21; i++) {
            expect(res.landmarks[i].x).toBeCloseTo(img[i].x, 6);
            expect(res.landmarks[i].y).toBeCloseTo(img[i].y, 6);
            expect(res.landmarks[i].z).toBeCloseTo(img[i].z, 6);
            expect(res.world[i].x).toBeCloseTo(world[i].x, 6);
        }
    });
});
